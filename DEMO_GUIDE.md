# 🎥 Step-by-Step Demo Video Guide (3–5 Minutes)

This walkthrough provides a concise, deterministic sequence, narrative points, and exact commands for recording the 3 to 5-minute demonstration video.

---

## 🚀 Pre-Flight Setup

1. **Split-Screen Layout**:
   - **Left Half**: Web Dashboard open at `http://localhost:8000`
   - **Right Half**: Terminal open in the project directory
2. **Launch the environment**:
   ```bash
   docker compose up --build -d
   ```
3. **Verify initial state**:
   - Web Dashboard shows **Container A (HEALTHY, 100%)** and **Container B (STOPPED, 0%)**.

---

## 🎬 10-Step Demonstration Sequence

### Step 1: Show Initial System & Container State
- **Screen**: Point to the dashboard header, metrics, and container cards.
- **Narrative**:
  - Container A is currently running and healthy (100% traffic allocation).
  - Container B is stopped (0% traffic allocation).
  - SSE connection dot shows active real-time updates.

---

### Step 2: Generate Traffic Through the Load Balancer
- **Action**: In the Traffic Generator widget, set rate to 120 RPM (2 req/s) and click **"Start Traffic"** (or run `npm run traffic:cli 120 http://localhost:8000/service`).
- **Screen**:
  - Live requests increment steadily on Container A with a 100% success rate.
  - Ingress responses carry headers: `X-Handled-By: Container A` and `X-Routed-To: Container A`.

---

### Step 3: Use MCP `get_status`
- **Action**: From an MCP client (or via script / curl):
  ```bash
  curl -s http://localhost:8000/api/status | jq .
  ```
- **Screen**:
  - Show the returned JSON object containing container states, health status, configured split (`100/0`), effective split (`100/0`), and in-flight request counts.
  - Highlight the audit log entry tagged with `source: "mcp"`.

---

### Step 4: Use MCP `safe_rollout` to Move Traffic A → B
- **Action**: Call the MCP tool `safe_rollout` with arguments `from="A", to="B"`:
  ```bash
  curl -s -X POST http://localhost:8000/api/rollout \
    -H "Content-Type: application/json" \
    -H "x-source: mcp" \
    -d '{"from":"A","to":"B"}' | jq .
  ```
- **Screen**:
  - Audit log immediately records `[MCP] SAFE_ROLLOUT_STARTED (in_progress)` with `source: mcp`.

---

### Step 5: Show the Dashboard Rollout Phases
- **Screen**:
  - Observe the top **Rollout Alert Banner** sequentially stepping through all 5 phases:
    1. `Step 1/5: Starting target Container B`
    2. `Step 2/5: Polling health check for target Container B`
    3. `Step 3/5: Shifting 100% traffic to target Container B`
    4. `Step 4/5: Draining in-flight requests from Container A`
    5. `Step 5/5: Stopping old Container A`

---

### Step 6: Verify Traffic Shift to Container B (Zero Failed Requests)
- **Screen**:
  - Point out that **Failed Requests counter remains 0** throughout the transition.
  - Container B is now **HEALTHY** and handling 100% of incoming traffic.
  - Container A is now **STOPPED**.

---

### Step 7: Demonstrate In-Flight Request Draining
- **Action**:
  1. Start Container A so both backends are running.
  2. Send a request with artificial latency in the background:
     ```bash
     curl "http://localhost:8000/service?delay=3000" &
     ```
  3. Immediately initiate a stop on Container A via the dashboard or API:
     ```bash
     curl -X POST http://localhost:8000/api/containers/A/stop
     ```
- **Screen**:
  - Container A transitions to **`DRAINING`** status.
  - In-flight request counter shows `1`.
  - The controller waits for the 3-second request to complete and return `200 OK` before stopping Container A.

---

### Step 8: Demonstrate a Failed Rollout (Target Never Becomes Healthy)
- **Action**:
  1. Start Container A in an unhealthy chaos state:
     ```bash
     curl -X POST http://localhost:8000/api/containers/A/start
     curl -X POST http://localhost:8000/api/containers/A/chaos -H "Content-Type: application/json" -d '{"action":"unhealthy"}'
     ```
  2. Initiate a safe rollout from B to A:
     ```bash
     curl -X POST http://localhost:8000/api/rollout -H "Content-Type: application/json" -d '{"from":"B","to":"A"}'
     ```
- **Screen**:
  - The controller polls Container A's `/health` endpoint and receives `HTTP 503`.
  - After reaching `ROLLOUT_HEALTH_TIMEOUT_MS` (12,000ms), the rollout is marked **`ABORTED`**.

---

### Step 9: Show Original Container Continues Serving Traffic
- **Screen**:
  - Point out that **100% of traffic remained safely on Container B** during and after the aborted rollout.
  - Traffic generator metrics show zero interrupted requests.
  - Restore Container A to healthy state:
    ```bash
    curl -X POST http://localhost:8000/api/containers/A/chaos -H "Content-Type: application/json" -d '{"action":"healthy"}'
    ```

---

### Step 10: Demonstrate Invalid MCP Operation Rejection & Audit Log
- **Action**:
  1. Stop Container A so only Container B is running.
  2. Attempt to stop Container B (the last healthy container):
     ```bash
     curl -i -X POST http://localhost:8000/api/containers/B/stop -H "x-source: mcp"
     ```
  3. Attempt an invalid traffic split sending 50% traffic to stopped Container A:
     ```bash
     curl -i -X POST http://localhost:8000/api/split -H "Content-Type: application/json" -H "x-source: mcp" -d '{"splitA":50,"splitB":50}'
     ```
- **Screen**:
  - Both commands return `HTTP 400 Bad Request` with descriptive error messages.
  - Show the live **Audit Log** displaying `[MCP] CONTAINER_STOP_REJECTED` and `[MCP] TRAFFIC_SPLIT_REJECTED` with the red/yellow `REJECTED` badge and `source: mcp`.

---

## ⚡ Automated 1-Click Verification Script
To run the automated verification suite mirroring this sequence:
```bash
npm run demo
```
