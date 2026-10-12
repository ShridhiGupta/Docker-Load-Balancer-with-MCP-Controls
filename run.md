# Run & Test Guide — Docker Load Balancer with MCP Controls

This document contains step-by-step instructions to **install, run, test, and verify** the application using Docker, Node.js CLI, Model Context Protocol (MCP), cURL / PowerShell, Postman, and the Web Dashboard.

---

## Table of Contents
1. [Prerequisites](#prerequisites)
2. [Environment Configuration](#environment-configuration)
3. [Running the Application](#running-the-application)
   - [Method 1: Docker Compose (Recommended)](#method-1-docker-compose-recommended)
   - [Method 2: Local Development (Node.js)](#method-2-local-development-nodejs)
4. [Testing & Verification](#testing--verification)
   - [1. Automated Invariant Test Suite (`npm test`)](#1-automated-invariant-test-suite)
   - [2. Automated MCP Verification Demo (`npm run demo`)](#2-automated-mcp-verification-demo)
   - [3. Direct MCP REST Execution API (`/api/mcp/execute`)](#3-direct-mcp-rest-execution-api)
   - [4. Interactive MCP Inspector UI](#4-interactive-mcp-inspector-ui)
   - [5. Native MCP Server over stdio (JSON-RPC)](#5-native-mcp-server-over-stdio-json-rpc)
   - [6. AI Agent Integration (Claude Desktop & Cursor)](#6-ai-agent-integration-claude-desktop--cursor)
   - [7. CLI Traffic Generator (`npm run traffic:cli`)](#7-cli-traffic-generator)
   - [8. Manual Controller cURL / PowerShell Commands](#8-manual-controller-curl--powershell-commands)
   - [9. Testing via Postman](#9-testing-via-postman)
   - [10. Interactive Web Dashboard Testing](#10-interactive-web-dashboard-testing)
5. [Service Endpoints Reference](#service-endpoints-reference)
6. [Troubleshooting & FAQs](#troubleshooting--faqs)

---

## Prerequisites

Make sure you have the following installed:
- **Docker Desktop** (with Docker Engine running)
- **Node.js 20+** and **npm**

---

## Environment Configuration

Copy the example `.env` file to create your active configuration:

```bash
# Windows (PowerShell)
Copy-Item .env.example .env

# macOS / Linux
cp .env.example .env
```

Default configuration in `.env`:
```env
PORT=8000
APP_A_HOST=botpresso-app-a
APP_A_PORT=8080
APP_B_HOST=botpresso-app-b
APP_B_PORT=8080
HEALTH_CHECK_INTERVAL_MS=1000
HEALTH_CHECK_TIMEOUT_MS=1500
DRAIN_TIMEOUT_MS=5000
ROLLOUT_HEALTH_TIMEOUT_MS=12000
PROXY_TIMEOUT_MS=10000
```

---

## Running the Application

### Method 1: Docker Compose (Recommended)

Build and launch the load balancer controller, Container A, and Container B:

```bash
# 1. Build and start in detached mode
docker compose up --build -d

# 2. View live controller logs
docker compose logs -f controller

# 3. Stop all containers
docker compose down
```

Once running, access points:
- **Web Dashboard**: `http://localhost:8000`
- **Traffic Proxy**: `http://localhost:8000/service`
- **API Status**: `http://localhost:8000/api/status`
- **Live SSE Feed**: `http://localhost:8000/api/events`

---

### Method 2: Local Development (Node.js)

If running directly on the host without Docker containers:

```bash
# 1. Install dependencies
npm install

# 2. Run in development mode (hot-reload with tsx)
npm run dev

# 3. Or build and run production bundle
npm run build
npm start
```

---

## Testing & Verification

### 1. Automated Invariant Test Suite

Validates all 16 core state invariants, dynamic fallback rules, stop guards, and rollout mutex locks:

```bash
npm test
```

Expected output:
- Split sum validation ($S_A + S_B = 100$)
- Inactive container routing rejection
- Dynamic failover when container becomes unhealthy
- Service unavailable (HTTP 503) when neither container is healthy
- Last healthy container stop protection
- Rollout mutex lock rejection

---

### 2. Automated MCP Verification Demo

Runs the end-to-end automated verification script covering all 7 evaluation scenarios from the assignment specification:

```bash
npm run demo
```

Scenarios executed:
1. Generates background traffic to Container A.
2. MCP client inspects state via `get_status`.
3. MCP client executes zero-downtime safe rollout (`safe_rollout A -> B`).
4. Verifies 100% traffic migration to Container B with zero dropped requests.
5. Verifies graceful connection draining with a slow (3000ms) request.
6. Chaos test: forces target unhealthy and validates automated rollout abort recovery.
7. Validates rejection of invalid splits and stopping the last healthy backend.
8. Confirms all operations are tagged with `source: "mcp"` in the audit log.

---

### 3. Direct MCP REST Execution API

The controller provides a direct endpoint (`POST /api/mcp/execute`) to test all 8 MCP tools directly via HTTP:

#### A. Tool: `get_status`
```bash
# Bash / cURL
curl -X POST http://localhost:8000/api/mcp/execute \
  -H "Content-Type: application/json" \
  -d '{"tool": "get_status"}'

# PowerShell
Invoke-RestMethod -Uri "http://localhost:8000/api/mcp/execute" -Method Post -ContentType "application/json" -Body '{"tool": "get_status"}' | ConvertTo-Json -Depth 5
```

#### B. Tool: `safe_rollout` (A -> B)
```bash
# Bash / cURL
curl -X POST http://localhost:8000/api/mcp/execute \
  -H "Content-Type: application/json" \
  -d '{"tool": "safe_rollout", "params": {"from": "A", "to": "B"}}'

# PowerShell
Invoke-RestMethod -Uri "http://localhost:8000/api/mcp/execute" -Method Post -ContentType "application/json" -Body '{"tool": "safe_rollout", "params": {"from": "A", "to": "B"}}'
```

#### C. Tool: `set_traffic_split` (70% A / 30% B)
```bash
# Bash / cURL
curl -X POST http://localhost:8000/api/mcp/execute \
  -H "Content-Type: application/json" \
  -d '{"tool": "set_traffic_split", "params": {"splitA": 70, "splitB": 30}}'

# PowerShell
Invoke-RestMethod -Uri "http://localhost:8000/api/mcp/execute" -Method Post -ContentType "application/json" -Body '{"tool": "set_traffic_split", "params": {"splitA": 70, "splitB": 30}}'
```

#### D. Tool: `stop_container` (Container A)
```bash
# Bash / cURL
curl -X POST http://localhost:8000/api/mcp/execute \
  -H "Content-Type: application/json" \
  -d '{"tool": "stop_container", "params": {"container": "A"}}'

# PowerShell
Invoke-RestMethod -Uri "http://localhost:8000/api/mcp/execute" -Method Post -ContentType "application/json" -Body '{"tool": "stop_container", "params": {"container": "A"}}'
```

#### E. Tool: `start_container` (Container A)
```bash
# Bash / cURL
curl -X POST http://localhost:8000/api/mcp/execute \
  -H "Content-Type: application/json" \
  -d '{"tool": "start_container", "params": {"container": "A", "timeoutMs": 12000}}'

# PowerShell
Invoke-RestMethod -Uri "http://localhost:8000/api/mcp/execute" -Method Post -ContentType "application/json" -Body '{"tool": "start_container", "params": {"container": "A", "timeoutMs": 12000}}'
```

#### F. Tool: `get_recent_logs` (Filtered by MCP source)
```bash
# Bash / cURL
curl -X POST http://localhost:8000/api/mcp/execute \
  -H "Content-Type: application/json" \
  -d '{"tool": "get_recent_logs", "params": {"limit": 20, "source": "mcp"}}'

# PowerShell
Invoke-RestMethod -Uri "http://localhost:8000/api/mcp/execute" -Method Post -ContentType "application/json" -Body '{"tool": "get_recent_logs", "params": {"limit": 20, "source": "mcp"}}' | ConvertTo-Json -Depth 5
```

#### G. Tool: `force_container_unhealthy` (Chaos Mode)
```bash
# Force Container B unhealthy (returns 503)
curl -X POST http://localhost:8000/api/mcp/execute \
  -H "Content-Type: application/json" \
  -d '{"tool": "force_container_unhealthy", "params": {"container": "B", "unhealthy": true}}'

# Restore Container B healthy
curl -X POST http://localhost:8000/api/mcp/execute \
  -H "Content-Type: application/json" \
  -d '{"tool": "force_container_unhealthy", "params": {"container": "B", "unhealthy": false}}'
```

#### H. Tool: `control_traffic_generator`
```bash
# Start generator at 180 RPM (3 req/s)
curl -X POST http://localhost:8000/api/mcp/execute \
  -H "Content-Type: application/json" \
  -d '{"tool": "control_traffic_generator", "params": {"action": "start", "rpm": 180}}'

# Stop generator
curl -X POST http://localhost:8000/api/mcp/execute \
  -H "Content-Type: application/json" \
  -d '{"tool": "control_traffic_generator", "params": {"action": "stop"}}'
```

---

### 4. Interactive MCP Inspector UI

Use the official MCP Inspector to test and explore all tools in a web UI:

```bash
npx @modelcontextprotocol/inspector npx tsx src/mcp/stdio-runner.ts
```

This launches an interactive browser interface at `http://localhost:5173` where you can:
- Inspect all registered MCP tools and their Zod schemas.
- Execute tool calls interactively with form validation.
- Inspect JSON-RPC request and response payloads.

---

### 5. Native MCP Server over stdio (JSON-RPC)

Launch the stdio server process directly:

```bash
npm run mcp:stdio
```

You can pipe standard JSON-RPC 2.0 requests via stdin:

#### Initialize MCP Connection:
```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test-client","version":"1.0.0"}}}
```

#### List Available Tools:
```json
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
```

#### Call Tool (`get_status`):
```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_status","arguments":{}}}
```

#### Call Tool (`safe_rollout`):
```json
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"safe_rollout","arguments":{"from":"A","to":"B"}}}
```

---

### 6. AI Agent Integration (Claude Desktop & Cursor)

#### Claude Desktop Setup
Add this entry to your `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "docker-load-balancer": {
      "command": "npx",
      "args": ["-y", "tsx", "c:/Users/ITCae/Music/Botpresso/src/mcp/stdio-runner.ts"],
      "env": {
        "PORT": "8000",
        "DOCKER_SOCKET_PATH": "/var/run/docker.sock"
      }
    }
  }
}
```

#### Test Prompts to Send in Claude / Cursor:
- *"Check the current status and health of both load balancer containers."*
- *"Perform a safe zero-downtime rollout from Container A to Container B."*
- *"Adjust the traffic split to 60% Container A and 40% Container B."*
- *"Show me the last 10 MCP actions from the audit log."*

---

### 7. CLI Traffic Generator

Generate sustained HTTP traffic through the load balancer:

```bash
# Syntax: npm run traffic:cli [RPM] [Target URL]
# Example: Send 120 requests per minute (2 req/s)
npm run traffic:cli 120 http://localhost:8000/service
```

---

### 8. Manual Controller cURL / PowerShell Commands

#### A. Send Single Traffic Request
```bash
curl http://localhost:8000/service
```

#### B. Trigger Rollout via Standard REST API
```bash
curl -X POST http://localhost:8000/api/rollout \
  -H "Content-Type: application/json" \
  -H "x-source: mcp" \
  -d '{"from":"A","to":"B"}'
```

#### C. Change Traffic Split with Source Tagging
```bash
curl -X POST http://localhost:8000/api/split \
  -H "Content-Type: application/json" \
  -H "x-source: mcp" \
  -d '{"splitA":50,"splitB":50}'
```

#### D. Test Connection Draining
```bash
# 1. Send slow request (3-second delay) in background
curl "http://localhost:8000/service?delay=3000" &

# 2. Immediately stop Container A
curl -X POST http://localhost:8000/api/containers/A/stop
```

#### E. Chaos Testing (Simulate Backend Failure)
```bash
# Set Container A to unhealthy state (returns 503)
curl -X POST http://localhost:8000/api/containers/A/chaos \
  -H "Content-Type: application/json" \
  -d '{"action":"unhealthy"}'

# Restore Container A health
curl -X POST http://localhost:8000/api/containers/A/chaos \
  -H "Content-Type: application/json" \
  -d '{"action":"healthy"}'
```

---

### 9. Testing via Postman

Set the Base URL to `http://localhost:8000`.

| Method | Endpoint | Headers | Request Body | Description |
|---|---|---|---|---|
| `GET` | `/api/status` | — | — | Fetch full load balancer state |
| `GET` | `/service` | — | — | Route traffic through proxy |
| `POST` | `/api/mcp/execute` | `Content-Type: application/json` | `{"tool": "safe_rollout", "params": {"from": "A", "to": "B"}}` | Direct MCP tool execution |
| `POST` | `/api/rollout` | `Content-Type: application/json`<br>`x-source: mcp` | `{"from": "A", "to": "B"}` | Safe rollout endpoint |
| `POST` | `/api/split` | `Content-Type: application/json`<br>`x-source: mcp` | `{"splitA": 50, "splitB": 50}` | Update traffic split |
| `POST` | `/api/containers/A/start` | `x-source: mcp` | — | Start Container A |
| `POST` | `/api/containers/A/stop` | `x-source: mcp` | — | Gracefully drain & stop Container A |
| `POST` | `/api/containers/A/chaos` | `Content-Type: application/json` | `{"action": "unhealthy"}` | Simulate container failure |
| `GET` | `/api/logs?limit=30` | — | — | Get structured audit logs |

---

### 10. Interactive Web Dashboard Testing

1. Open `http://localhost:8000` in your browser.
2. Verify:
   - **Real-time Metrics**: Total Requests, Success Rate (100%), Active Connections, and Split Ratio.
   - **Live Visualizer**: Displays active routing lines to Container A and Container B.
   - **Traffic Generator Widget**: Adjust RPM (e.g., 120 RPM) and click **"Start Traffic"**.
   - **Rollout Controls**: Click **"Start Safe Rollout (A -> B)"** and observe the 5-phase progress banner.
   - **Chaos Testing**: Click **"Simulate Unhealthy"** on a container and observe dynamic failover without dropped requests.
   - **Audit Log Feed**: Real-time event stream delivered via Server-Sent Events (SSE).

---

## Service Endpoints Reference

```text
http://localhost:8000/
├── /                         -> Web Dashboard UI
├── /service                  -> Load Balancer Ingress Proxy
├── /api/status               -> System & Container State
├── /api/metrics              -> Latency & Throughput Metrics
├── /api/split                -> Traffic Split Configuration
├── /api/rollout              -> Safe Rollout Trigger
├── /api/mcp/execute          -> Direct MCP Tool Execution Endpoint
├── /api/containers/:id/start -> Start Container
├── /api/containers/:id/stop  -> Graceful Drain & Stop
├── /api/containers/:id/chaos -> Chaos Injection
├── /api/events               -> SSE Stream for Real-time Updates
└── /api/logs                 -> Structured Audit Event History
```

---

## Troubleshooting & FAQs

- **Docker Socket permission / connection error**:
  Ensure Docker Desktop is running. On Windows, verify named pipe accessibility (`//./pipe/docker_engine`). On Linux/macOS, verify permissions on `/var/run/docker.sock`.
- **Port 8000 / 8001 / 8002 already in use**:
  Ensure no lingering processes occupy ports:
  ```powershell
  Get-Process -Id (Get-NetTCPConnection -LocalPort 8000).OwningProcess | Stop-Process
  ```
- **Clean Docker rebuild**:
  ```bash
  docker compose down -v
  docker compose up --build -d
  ```
