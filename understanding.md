# 📘 System Architecture & Technical Deep-Dive: Docker Load Balancer with MCP Controls

---

## 1. High-Level Overview

### 1.1 What Problem This Project Solves
In modern cloud-native architectures, deploying new versions of containerized microservices without service interruption is a fundamental operational challenge. Naive load balancing setups typically suffer from several critical failure modes:
1. **Cold-Start Latency & Premature Traffic Routing**: Routing traffic to freshly started containers before readiness checks pass causes connection drops and HTTP 502/504 errors.
2. **Abrupt Connection Severing (Lack of Draining)**: Terminating an old container while in-flight HTTP requests are still executing drops active client connections mid-flight.
3. **Cascading Outages (Single Point of Failure)**: Human or automated operators inadvertently shutting down the last remaining healthy container, resulting in a total service outage.
4. **Disjointed AI Agent Integration**: Traditional infrastructure lacks standardized, structured control planes for Large Language Model (LLM) agents to observe, diagnose, and execute safe orchestration tasks without risky shell access.

**Botpresso** solves these challenges by implementing an HTTP Reverse Proxy / Load Balancer and Orchestration Controller with production-inspired safety mechanisms, featuring:
- **Dual Control Planes**: A real-time reactive Web Dashboard (Server-Sent Events) and a Model Context Protocol (MCP) server for autonomous LLM agents (Claude Desktop, Cursor, Antigravity).
- **Dynamic Effective Split Fallback**: Automatic routing adaptation if a backend fails health checks (e.g., fallback from 50/50 to 100% on the surviving healthy instance; returning HTTP 503 only when 0 backends are healthy).
- **Zero-Downtime Safe Rollout Engine**: A 5-phase state machine that starts the new container, polls readiness, shifts traffic, drains in-flight requests on the old container with a configurable timeout, and stops the old container.
- **Fail-Safe Abort Guarantees**: If a rollout target fails readiness checks or times out, the rollout is immediately aborted, preserving 100% traffic on the active healthy container. In all tested rollout scenarios, traffic was preserved with zero failed requests.
- **Strict Safety Guards**: Rejection of traffic splits targeting stopped/unhealthy containers, mutex locking during active rollouts, and protection against terminating the last healthy container.

---

### 1.2 Why This Architecture Was Chosen
- **Node.js Native Streamed Reverse Proxying**: Built using Node.js's asynchronous HTTP streaming pipeline (`http.request` piped directly to `res`). This avoids buffering full request/response payloads in RAM, keeping memory usage stable during large payloads.
- **Centralized In-Memory State**: A single source of truth (`StateManager`) manages container health, in-flight connection counters, configured vs. effective splits, and rollout locks with fast, synchronous access for proxy routing decisions.
- **Model Context Protocol (MCP) Integration**: Using the official `@modelcontextprotocol/sdk`, the system exposes structured, type-safe JSON-RPC tools with Zod schema validation. This enforces system safety invariants directly at the tool execution boundary.
- **Decoupled Event-Driven Observability**: A circular memory buffer (`EventLogger`) with a listener publish-subscribe pattern powers real-time Server-Sent Events (SSE) push streams to the browser without polling overhead.

---

### 1.3 Overall System Design

```
+----------------------------------------------------------------------------------------------------+
|                                           CLIENTS & INGRESS                                        |
+------------------------------------+-----------------------------------+---------------------------+
| 1. HTTP Traffic Clients            | 2. Web Dashboard                  | 3. MCP AI Clients         |
|    (Browsers, cURL, Traffic Gen)   |    (Vanilla JS SPA + SSE Feed)    |    (Claude, Cursor, AGY)  |
+-----------------+------------------+-----------------+-----------------+-------------+-------------+
                  |                                    |                               |
     HTTP /service|                                    | HTTP /api + SSE /api/events   | MCP Stdio / HTTP JSON-RPC
                  v                                    v                               v
+----------------------------------------------------------------------------------------------------+
|                       BOTPRESSO CONTROLLER & LOAD BALANCER (Node.js / Express :8000)               |
|                                                                                                    |
|  +-----------------------------------------------------------------------------------------------+ |
|  |                                  Routing & Transport Layer                                    | |
|  |   - Express App Router (/api/*)                      - SSE Broadcaster (/api/events)          | |
|  |   - Streaming Reverse Proxy Ingress (/service)       - MCP Tool Adapter & Stdio Runner        | |
|  +-----------------------------------------------+-----------------------------------------------+ |
|                                                  |                                                 |
|  +-----------------------------------------------v-----------------------------------------------+ |
|  |                             Core Business Logic & Orchestration                               | |
|  |                                                                                               | |
|  |  +---------------------------------+  +-------------------------------+                       | |
|  |  | StateManager                    |  | RolloutManager                |                       | |
|  |  | - Configured vs Effective Split |  | - 5-Phase Zero-Downtime Engine|                       | |
|  |  | - In-Flight Request Counters    |  | - Readiness Poller & Timeout  |                       | |
|  |  | - Last Healthy Container Guard  |  | - In-Flight Connection Drainer|                       | |
|  |  | - Rollout Mutex Lock            |  | - Abort / Rollback Engine     |                       | |
|  |  +---------------------------------+  +-------------------------------+                       | |
|  |                                                                                               | |
|  |  +---------------------------------+  +-------------------------------+                       | |
|  |  | HealthChecker                   |  | DockerService                 |                       | |
|  |  | - 1000ms Polling Interval       |  | - Docker Engine API / Socket  |                       | |
|  |  | - 1500ms AbortController Timeout|  | - Container Start / Stop      |                       | |
|  |  | - Dynamic Fallback Trigger      |  | - Simulation Mode Fallback    |                       | |
|  |  +---------------------------------+  +-------------------------------+                       | |
|  |                                                                                               | |
|  |  +---------------------------------+  +-------------------------------+                       | |
|  |  | LoadBalancer                    |  | EventLogger                   |                       | |
|  |  | - Weighted Probability Router   |  | - Circular Buffer (200 logs)  |                       | |
|  |  | - Header Decoration & Tracing   |  | - Source Tagging (mcp, ui)    |                       | |
|  |  | - 502 / 503 / 504 Error Handler |  | - Pub-Sub SSE Listener        |                       | |
|  |  +---------------------------------+  +-------------------------------+                       | |
|  +-----------------------------------------------+-----------------------------------------------+ |
+--------------------------------------------------|-------------------------------------------------+
                                                   |
                      +----------------------------+----------------------------+
                      |                                                         |
                      | HTTP Proxy (Port 8001 / 8080)                           | HTTP Proxy (Port 8002 / 8080)
                      v                                                         v
    +------------------------------------+                    +------------------------------------+
    |         CONTAINER A                |                    |         CONTAINER B                |
    |  - botpresso-app-a (:8080)         |                    |  - botpresso-app-b (:8080)         |
    |  - Express Downstream Service      |                    |  - Express Downstream Service      |
    |  - In-Flight Request Tracker       |                    |  - In-Flight Request Tracker       |
    |  - Health & Chaos Injection (/chaos)|                   |  - Health & Chaos Injection (/chaos)|
    |  - Configurable Latency Delay      |                    |  - Configurable Latency Delay      |
    +------------------------------------+                    +------------------------------------+
```

---

## 2. Project Structure Walkthrough

The codebase separates interface handling, orchestration logic, and infrastructure adapters:

```
Botpresso/
├── apps/
│   └── app-backend/               # Target downstream microservice (Container A & B)
│       ├── src/
│       │   └── server.ts          # Mock HTTP backend with in-flight metrics & chaos triggers
│       ├── Dockerfile             # Multi-stage Node container build
│       ├── package.json
│       └── tsconfig.json
├── dist/                          # Compiled production JavaScript bundle
├── scripts/                       # Developer CLI tools & Automated Verification
│   ├── mcp-client-demo.ts         # Automated runner for demo scenarios
│   ├── test-all.ts                # Invariant, unit, and integration test suite
│   └── traffic-cli.ts             # CLI load generator with live terminal stats
├── src/                           # Controller and Load Balancer source code
│   ├── api/
│   │   └── router.ts              # REST API route handlers, SSE stream, and MCP execution
│   ├── core/                      # Domain logic & orchestrators
│   │   ├── docker-service.ts      # Dockerode API client (Unix socket / Windows pipe)
│   │   ├── event-logger.ts        # Circular audit log buffer with pub-sub dispatch
│   │   ├── health-checker.ts      # Background active polling engine with AbortController
│   │   ├── load-balancer.ts       # Native streaming HTTP reverse proxy
│   │   ├── rollout-manager.ts     # 5-phase safe rollout state machine & draining logic
│   │   ├── state-manager.ts       # Central in-memory state, invariants & split calculations
│   │   └── traffic-generator.ts   # Synthetic workload generation engine
│   ├── mcp/                       # Model Context Protocol layer
│   │   ├── server.ts              # McpServer instantiation & 8 tool definitions (Zod validated)
│   │   └── stdio-runner.ts        # Stdio JSON-RPC transport runner for LLM clients
│   ├── public/                    # Frontend Dashboard SPA
│   │   ├── app.js                 # Vanilla JS reactive client (SSE subscriber, DOM mutator)
│   │   ├── index.html             # Glassmorphism dashboard markup
│   │   └── style.css              # Custom CSS tokens, glassmorphism, responsive grid
│   ├── types/                     # TypeScript Domain Models
│   │   ├── events.ts              # Audit log schemas, event sources, results
│   │   └── state.ts               # Container state, split schemas, rollout status, metrics
│   ├── config.ts                  # Centralized configuration with environment variable defaults
│   └── index.ts                   # Application bootstrap, Express server setup, route binding
├── docker-compose.yml             # Container orchestration (controller, app-a, app-b)
├── Dockerfile                     # Controller container build definition
├── package.json                   # Dependencies, scripts, project metadata
└── tsconfig.json                  # Strict TypeScript compiler options
```

### Component Responsibilities:
1. **`StateManager` (`src/core/state-manager.ts`)**: The controller's centralized runtime state. It validates split percentages, computes effective split based on container health, tracks in-flight request counters, enforces the last-healthy-container guard, and manages rollout mutex locks.
2. **`LoadBalancer` (`src/core/load-balancer.ts`)**: Handles streaming HTTP request routing. Decorates ingress headers (`X-Forwarded-For`, `X-Routed-To`, `X-Proxy-Latency-Ms`) and tracks in-flight request completion.
3. **`HealthChecker` (`src/core/health-checker.ts`)**: Performs periodic health probes against active containers every 1,000ms with a 1,500ms timeout, triggering dynamic fallback when containers change health state.
4. **`RolloutManager` (`src/core/rollout-manager.ts`)**: Coordinates 5-step safe rollouts, poll readiness, in-flight connection draining, and safe abort recovery.
5. **`EventLogger` (`src/core/event-logger.ts`)**: Maintains an in-memory circular audit buffer (max 200 logs) tagging event source (`mcp`, `dashboard`, `controller`, `traffic-gen`) and broadcasting updates.
6. **`DockerService` (`src/core/docker-service.ts`)**: Integrates with the Docker Engine daemon via socket to start and stop container instances.

---

## 3. Frontend Architecture

### 3.1 Tech Stack & Rationale
- **Vanilla JavaScript (ES6+) & HTML5/CSS3**: Lightweight with zero build-step or hydration overhead.
- **Server-Sent Events (SSE)**: Provides unidirectional real-time data streaming from server to client over standard HTTP with automatic reconnection.
- **Custom CSS Design**: Utilizes CSS variables and responsive layout for clear visual feedback during testing.

### 3.2 State Management & SSE Communication Flow

```
[Server: StateManager / EventLogger]
       |
       | (HTTP GET /api/events - Server-Sent Events)
       v
[app.js: EventSource.onmessage]
       |
       +---> Type: 'SNAPSHOT'  --> Full UI sync on initial connection
       +---> Type: 'EVENT'     --> Incremental log prepend + state patch
       +---> Type: 'TICK'      --> 1000ms periodic heartbeat sync
       |
       v
[DOM Updates: updateMetrics(), updateContainerCards(), updateRolloutBanner(), renderLogs()]
```

---

## 4. Backend Architecture

### 4.1 Configured vs. Effective Traffic Split

The controller strictly separates operator configuration from runtime safety state:

- **Configured Split**: The operator's intended allocation (e.g., $A=50\%, B=50\%$).
- **Effective Split**: The allocation actually safe to use based on container health and draining status.

```text
Example:
Configured: A = 50%, B = 50%
Container A becomes UNHEALTHY
Effective:  A = 0%, B = 100%

When Container A recovers:
Effective:  A = 50%, B = 50% (Configured policy is restored automatically)
```

By preserving the configured policy during outages, the system automatically restores intended traffic distribution once backends recover without overwriting operator intent.

---

### 4.2 Verified Safety Rules & Invariants

1. **Split Sum Validation**: Split percentages must sum to 100.
2. **Healthy Routing Only**: New requests only go to healthy, non-draining containers.
3. **Single Backend Failure**: If one container is unhealthy, traffic goes to the healthy container.
4. **Total Outage Guard**: If neither container is healthy, requests receive HTTP 503 Service Unavailable.
5. **Invalid Split Rejection**: Traffic allocation to stopped/unhealthy/draining containers is rejected (`HTTP 400`).
6. **Last Healthy Container Guard**: The last healthy container cannot be stopped (`HTTP 400`).
7. **Graceful Draining**: The stop operation drains in-flight requests before stopping the container.
8. **Drain Timeout Handling**: If the drain timeout is reached, the container is left running/draining and removed from new routing.
9. **Readiness Check**: Safe rollout waits for target health before shifting traffic.
10. **Target Failure Protection**: Failed target health prevents traffic from being shifted and aborts rollout safely.
11. **Rollout Mutex**: Conflicting operations during rollout (split changes, stop commands) are rejected (`HTTP 409`).
12. **Unified Control Logic**: MCP tools and Web Dashboard execute the same underlying controller logic.
13. **Universal MCP Audit Logging**: Every MCP action, including rejected actions, is logged with `source: "mcp"`.

---

### 4.3 Configured Timeouts

The following timeouts are defined in `src/config.ts`:

| Parameter | Value | Purpose |
|---|---|---|
| `HEALTH_CHECK_INTERVAL_MS` | `1000ms` | Interval between background health checks |
| `HEALTH_CHECK_TIMEOUT_MS` | `1500ms` | Probe timeout for single health check request |
| `DRAIN_TIMEOUT_MS` | `5000ms` | Maximum time to wait for in-flight requests to complete |
| `ROLLOUT_HEALTH_TIMEOUT_MS` | `12000ms` | Maximum time to wait for target container readiness during rollout |
| `PROXY_TIMEOUT_MS` | `10000ms` | Reverse proxy gateway timeout before returning HTTP 504 |

---

## 5. API Flow (Request $\to$ Response Lifecycle)

### 5.1 Ingress Request Flow (`GET /service`)

```
1. Client sends HTTP GET /service
2. Express Router passes request to LoadBalancer.handleRequest()
3. LoadBalancer checks StateManager.getEffectiveSplit()
4. Selects target container (e.g., Container A)
5. StateManager.incrementInFlight('A') is called
6. Node.js http.request streams request to http://botpresso-app-a:8080/service
7. Downstream container handles request and returns response stream
8. LoadBalancer injects X-Routed-To, X-Proxy-Latency-Ms and streams back to client
9. On response finish / close, StateManager.decrementInFlight('A') updates metrics
```

### 5.2 MCP Tool Invocation Flow (`safe_rollout`)

```
1. AI Agent executes tool safe_rollout(from="A", to="B") over stdio JSON-RPC
2. McpServer validates arguments with Zod schema
3. RolloutManager.executeSafeRollout('A', 'B', 'mcp') is invoked
4. EventLogger records SAFE_ROLLOUT_STARTED with source: "mcp"
5. Connected Web Dashboard receives SSE event and renders progress banner
6. McpServer returns structured confirmation response to AI Agent
```

---

## 6. State Management & Data Architecture

### 6.1 Centralized In-Memory State
In this reverse proxy architecture, runtime state is maintained in a centralized in-memory singleton (`StateManager`). This ensures immediate, synchronous state lookups for proxy routing decisions without introducing disk or external network overhead.

Container runtime lifecycle is managed by the **Docker Engine Daemon** through `/var/run/docker.sock`.

### 6.2 Conceptual Distributed Extension (Interview Discussion)
In a multi-node deployment scenario:
- **Consensus**: A cluster could use **etcd** or **Consul** running Raft consensus to coordinate rollout locks.
- **State Sync**: **Redis** pub-sub or streams could broadcast audit events across proxy nodes.

---

## 7. Authentication & Authorization

### 7.1 Current System Boundary
- **MCP Plane**: Runs over standard input/output (stdio transport) within the host or container environment, inheriting host process permissions.
- **Web Dashboard & API**: Runs within an internal Docker network intended for operator access.

### 7.2 Conceptual Production Auth Architecture (Interview Discussion)
In a production deployment exposed to untrusted networks:
- **Token-Based Authentication**: OAuth2/OIDC issuing asymmetric **RS256 JWT** tokens containing user identity and role claims.
- **Password Hashing**: `bcrypt` or `Argon2id` with a high cost factor and cryptographic salt to protect stored credentials.
- **Role-Based Access Control (RBAC)**: Enforcing granular roles (`operator` for rollouts and split adjustments, `viewer` for read-only status and logs).

---

## 8. Security Considerations

| Threat | Mitigation in This Project |
|---|---|
| **Hanging Connections** | Explicit proxy timeout (`10,000ms`) and health check timeout (`1,500ms`) using `AbortController`. |
| **Invalid Payload Injection** | Zod runtime schema validation on all MCP tools and type checking in REST API handlers. |
| **Cross-Site Scripting (XSS)** | Safe text content assignments in UI DOM rendering. |
| **Accidental Total Outage** | `canStopContainer()` safety guard preventing termination of the last healthy container. |

---

## 9. Error Handling & Validation

- **Input Validation**: Parameter boundaries ($0 \le split \le 100$, container identifiers `'A' | 'B'`) are validated before invoking business logic.
- **Consistent Responses**: Standardized JSON error bodies containing descriptive error messages and timestamps.
- **Socket Disconnects**: `req.on('aborted')` destroys upstream proxy connections and cleans up in-flight counters if a client disconnects prematurely.

---

## 10. Scalability & Performance

- **Streaming I/O**: Direct streaming between client and backend prevents accumulating large request bodies in controller memory.
- **Resource Constraints**: High-concurrency production deployments would configure TCP connection pooling (`keep-alive` agents) and file descriptor limits (`ulimit -n`).

---

## 11. Interview-Ready Explanations

### "Explain this project in 2 minutes"
> "I built an HTTP reverse proxy and load balancer with dual control planes: a real-time Server-Sent Events web dashboard and a Model Context Protocol (MCP) server for autonomous AI agents.
>
> The system addresses deployment stability and zero-downtime rollouts. The controller acts as the single source of truth, managing a 5-step safe rollout engine that starts the target container, waits for readiness health checks, shifts traffic, gracefully drains in-flight connections with a timeout, and stops the old instance. If the target fails health checks, it automatically aborts the rollout, safely keeping 100% traffic on the active container.
>
> It enforces strict safety invariants—including dynamic split fallbacks if a backend degrades, rejection of splits to stopped containers, rollout concurrency mutexes, and last-healthy-container protection guards. Everything is fully observable via streamed metrics, in-flight connection tracking, and structured audit logs."

---

### "Explain the backend design decisions"
> "The backend was built around three key decisions:
> 1. **Native HTTP Streaming**: Using Node.js `http.request` piping directly between client and backend avoids buffering payloads in memory and maintains consistent throughput.
> 2. **Centralized In-Memory State**: Routing decisions require immediate, synchronous access to health and split state. `StateManager` serves as the centralized source of truth with $O(1)$ lookups.
> 3. **Model Context Protocol (MCP) Standard**: Implementing the official `@modelcontextprotocol/sdk` with Zod validation exposes structured, type-safe RPC tools (`safe_rollout`, `set_traffic_split`, `stop_container`), ensuring AI agents cannot perform invalid or destructive actions."

---

### "Explain authentication & security in this project"
> "In this project, the control plane is accessed via two channels:
> - The MCP server runs over stdio transport within the host environment, authenticated by host process and Docker socket permissions.
> - The dashboard operates within an internal container bridge network.
>
> In an enterprise production deployment, I would add an API Gateway layer using OAuth2/OIDC with asymmetric RS256 JWT tokens. Password hashing would use Argon2id with unique salts, and token verification middleware would extract role claims to enforce fine-grained Role-Based Access Control (RBAC)—allowing operators to initiate rollouts while restricting view-only users to status and audit log endpoints."

---

### "If you had more time, what would you improve?"
> "Given more time, I would focus on three areas:
> 1. **HTTP Keep-Alive Connection Pooling**: Add configurable `http.Agent` socket pooling to reuse TCP connections between the proxy and backend instances.
> 2. **Distributed State Coordination**: Integrate **etcd** / **Raft consensus** and **Redis Streams** to run multiple active controller instances with shared rollout locks and metrics.
> 3. **Data Plane / Control Plane Separation**: Use an Envoy or eBPF data plane for high-throughput packet routing while retaining the TypeScript engine as the dynamic control plane."
