// Botpresso Live Dashboard JavaScript Controller
let currentStatus = null;
let currentFilter = 'all';
let rawLogs = [];

// DOM Elements
const sseStatusDot = document.getElementById('sse-status-dot');
const sseStatusText = document.getElementById('sse-status-text');
const systemUptime = document.getElementById('system-uptime');
const btnRefresh = document.getElementById('btn-refresh');

// Metrics
const metricTotalRequests = document.getElementById('metric-total-requests');
const metricSuccessPct = document.getElementById('metric-success-pct');
const metricInflightTotal = document.getElementById('metric-inflight-total');
const metricInflightA = document.getElementById('metric-inflight-a');
const metricInflightB = document.getElementById('metric-inflight-b');
const metricSplitDisplay = document.getElementById('metric-split-display');
const metricEffectiveNote = document.getElementById('metric-effective-note');
const metricLatency = document.getElementById('metric-latency');
const metricP95 = document.getElementById('metric-p95');

// Banner
const statusBanner = document.getElementById('status-banner');
const bannerMessage = document.getElementById('banner-message');
const bannerStepper = document.getElementById('banner-stepper');

// Containers
const badgeStatusA = document.getElementById('badge-status-a');
const healthTextA = document.getElementById('health-text-a');
const inflightA = document.getElementById('inflight-a');
const servedA = document.getElementById('served-a');
const btnStartA = document.getElementById('btn-start-a');
const btnStopA = document.getElementById('btn-stop-a');
const btnChaosA = document.getElementById('btn-chaos-a');
const btnDelayA = document.getElementById('btn-delay-a');

const badgeStatusB = document.getElementById('badge-status-b');
const healthTextB = document.getElementById('health-text-b');
const inflightB = document.getElementById('inflight-b');
const servedB = document.getElementById('served-b');
const btnStartB = document.getElementById('btn-start-b');
const btnStopB = document.getElementById('btn-stop-b');
const btnChaosB = document.getElementById('btn-chaos-b');
const btnDelayB = document.getElementById('btn-delay-b');

// Traffic Split
const splitSlider = document.getElementById('split-slider');
const activeSplitLabel = document.getElementById('active-split-label');
const splitBarFillA = document.getElementById('split-bar-fill-a');
const splitBarFillB = document.getElementById('split-bar-fill-b');
const barPctA = document.getElementById('bar-pct-a');
const barPctB = document.getElementById('bar-pct-b');
const btnApplySplit = document.getElementById('btn-apply-split');

// Rollout
const btnRolloutAtoB = document.getElementById('btn-rollout-a-to-b');
const btnRolloutBtoA = document.getElementById('btn-rollout-b-to-a');

// Traffic Generator
const tgStatusBadge = document.getElementById('tg-status-badge');
const tgRpmSlider = document.getElementById('tg-rpm-slider');
const tgRpmLabel = document.getElementById('tg-rpm-label');
const tgRpsLabel = document.getElementById('tg-rps-label');
const btnTgStart = document.getElementById('btn-tg-start');
const btnTgStop = document.getElementById('btn-tg-stop');
const btnTgReset = document.getElementById('btn-tg-reset');
const tgMetricSent = document.getElementById('tg-metric-sent');
const tgMetricSuccess = document.getElementById('tg-metric-success');
const tgMetricFailed = document.getElementById('tg-metric-failed');
const tgMetricA = document.getElementById('tg-metric-a');
const tgMetricB = document.getElementById('tg-metric-b');

// Logs
const logStream = document.getElementById('log-stream');
const filterPills = document.querySelectorAll('.log-filter-btn');
const pillFilterMcp = document.getElementById('pill-filter-mcp');

// Initialize EventSource for real-time SSE stream
function connectSSE() {
  const eventSource = new EventSource('/api/events');

  eventSource.onopen = () => {
    sseStatusDot.className = 'dot-pulse';
    sseStatusDot.style.backgroundColor = 'var(--color-emerald)';
    sseStatusText.textContent = 'Live SSE Stream';
  };

  eventSource.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'SNAPSHOT') {
        currentStatus = data.status;
        rawLogs = data.logs || [];
        updateUI(currentStatus);
        updateTrafficGenUI(data.trafficGen);
        renderLogs();
      } else if (data.type === 'EVENT') {
        currentStatus = data.status;
        if (data.event) {
          rawLogs.unshift(data.event);
          if (rawLogs.length > 200) rawLogs.pop();
        }
        updateUI(currentStatus);
        updateTrafficGenUI(data.trafficGen);
        renderLogs();
      } else if (data.type === 'TICK') {
        currentStatus = data.status;
        updateUI(currentStatus);
        updateTrafficGenUI(data.trafficGen);
      }
    } catch (err) {
      console.error('Error parsing SSE event:', err);
    }
  };

  eventSource.onerror = () => {
    sseStatusDot.className = 'dot-pulse';
    sseStatusDot.style.backgroundColor = 'var(--color-rose)';
    sseStatusText.textContent = 'SSE Reconnecting...';
  };
}

// Update Dashboard UI from State Object
function updateUI(status) {
  if (!status) return;

  // Uptime
  const s = status.uptimeSeconds || 0;
  const hrs = String(Math.floor(s / 3600)).padStart(2, '0');
  const mins = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const secs = String(s % 60).padStart(2, '0');
  systemUptime.textContent = `${hrs}:${mins}:${secs}`;

  // Metrics
  const m = status.metrics || {};
  metricTotalRequests.textContent = (m.totalRequestsHandled || 0).toLocaleString();
  const totalReq = m.totalRequestsHandled || 0;
  const successRate = totalReq > 0 ? ((m.totalSuccessRequests / totalReq) * 100).toFixed(1) : '100';
  metricSuccessPct.textContent = `${successRate}%`;

  const inflightTotal = (status.containers.A.inFlightRequests || 0) + (status.containers.B.inFlightRequests || 0);
  metricInflightTotal.textContent = inflightTotal;
  metricInflightA.textContent = status.containers.A.inFlightRequests || 0;
  metricInflightB.textContent = status.containers.B.inFlightRequests || 0;

  metricSplitDisplay.textContent = `${status.configuredSplit.splitA} / ${status.configuredSplit.splitB}`;
  metricEffectiveNote.textContent = `Effective: ${status.effectiveSplit.effectiveA}% A | ${status.effectiveSplit.effectiveB}% B`;

  metricLatency.textContent = `${m.avgResponseTimeMs || 0}ms`;
  metricP95.textContent = `${m.p95ResponseTimeMs || 0}ms`;

  // Container A State
  updateContainerCard('A', status.containers.A, badgeStatusA, healthTextA, inflightA, servedA);

  // Container B State
  updateContainerCard('B', status.containers.B, badgeStatusB, healthTextB, inflightB, servedB);

  // Visual Split Display
  if (!isUserEditingSplit && !isDraggingSlider) {
    const effA = status.effectiveSplit.effectiveA;
    const effB = status.effectiveSplit.effectiveB;
    splitBarFillA.style.width = `${effA}%`;
    splitBarFillB.style.width = `${effB}%`;
    barPctA.textContent = `${effA}%`;
    barPctB.textContent = `${effB}%`;
    activeSplitLabel.textContent = `Configured: ${status.configuredSplit.splitA}% / ${status.configuredSplit.splitB}% (Effective: ${effA}% / ${effB}%)`;

    // Synchronize slider position with configured split
    if (status.configuredSplit) {
      splitSlider.value = status.configuredSplit.splitA;
    }
  }

  // Safe Rollout Banner
  updateRolloutBanner(status.rollout);
}

function updateContainerCard(id, cState, badgeEl, healthEl, inflightEl, servedEl) {
  inflightEl.textContent = `${cState.inFlightRequests || 0} reqs`;
  servedEl.textContent = (cState.totalRequestsServed || 0).toLocaleString();

  badgeEl.className = 'badge-status';
  if (cState.status === 'HEALTHY') {
    badgeEl.classList.add('badge-healthy');
    badgeEl.textContent = 'HEALTHY';
    healthEl.textContent = 'Passing (200 OK)';
  } else if (cState.status === 'UNHEALTHY') {
    badgeEl.classList.add('badge-unhealthy');
    badgeEl.textContent = 'UNHEALTHY';
    healthEl.textContent = cState.lastHealthError || 'Failing Health (503)';
  } else if (cState.status === 'DRAINING') {
    badgeEl.classList.add('badge-draining');
    badgeEl.textContent = 'DRAINING';
    healthEl.textContent = 'Draining active connections...';
  } else if (cState.status === 'STARTING') {
    badgeEl.classList.add('badge-draining');
    badgeEl.textContent = 'STARTING';
    healthEl.textContent = 'Container starting up...';
  } else {
    badgeEl.classList.add('badge-stopped');
    badgeEl.textContent = 'STOPPED';
    healthEl.textContent = 'Stopped / Offline';
  }
}

function updateRolloutBanner(rollout) {
  if (!rollout || rollout.status === 'IDLE') {
    statusBanner.style.display = 'none';
    btnRolloutAtoB.disabled = false;
    btnRolloutBtoA.disabled = false;
    return;
  }

  statusBanner.style.display = 'flex';

  if (rollout.status === 'IN_PROGRESS') {
    bannerMessage.innerHTML = `<strong>Safe Rollout in Progress:</strong> ${rollout.step || 'Processing...'}`;
    btnRolloutAtoB.disabled = true;
    btnRolloutBtoA.disabled = true;

    bannerStepper.innerHTML = [
      { step: 1, label: '1. Start' },
      { step: 2, label: '2. Health' },
      { step: 3, label: '3. Shift' },
      { step: 4, label: '4. Drain' },
      { step: 5, label: '5. Stop' },
    ].map((s) => `<span class="step-chip ${s.step <= (rollout.stepIndex || 1) ? 'active' : ''}">${s.label}</span>`).join('');
  } else if (rollout.status === 'SUCCESS') {
    bannerMessage.innerHTML = `<strong>Rollout Complete:</strong> ${rollout.step || 'Zero-downtime transition successful.'}`;
    bannerStepper.innerHTML = `<span class="step-chip active">✓ 100% Shifted</span>`;
    btnRolloutAtoB.disabled = false;
    btnRolloutBtoA.disabled = false;
  } else if (rollout.status === 'ABORTED' || rollout.status === 'FAILED') {
    bannerMessage.innerHTML = `<strong style="color: var(--color-rose);">Rollout Aborted:</strong> ${rollout.error || 'Health check failed, traffic kept on original container.'}`;
    bannerStepper.innerHTML = `<span class="step-chip active" style="background: var(--color-rose); border-color: var(--color-rose);">Safely Aborted</span>`;
    btnRolloutAtoB.disabled = false;
    btnRolloutBtoA.disabled = false;
  }
}

function updateTrafficGenUI(tg) {
  if (!tg) return;

  if (tg.isRunning) {
    tgStatusBadge.className = 'badge-status badge-healthy';
    tgStatusBadge.textContent = 'RUNNING';
    btnTgStart.disabled = true;
    btnTgStop.disabled = false;
  } else {
    tgStatusBadge.className = 'badge-status badge-stopped';
    tgStatusBadge.textContent = 'STOPPED';
    btnTgStart.disabled = false;
    btnTgStop.disabled = true;
  }

  tgMetricSent.textContent = (tg.totalSent || 0).toLocaleString();
  tgMetricSuccess.textContent = (tg.successCount || 0).toLocaleString();
  tgMetricFailed.textContent = (tg.failedCount || 0).toLocaleString();
  tgMetricA.textContent = (tg.servedByA || 0).toLocaleString();
  tgMetricB.textContent = (tg.servedByB || 0).toLocaleString();

  tgRpmLabel.textContent = `${tg.rpm} RPM`;
  tgRpsLabel.textContent = `${(tg.rpm / 60).toFixed(1)} req/s`;
}

function formatLocalTime(isoStr, fallbackStr) {
  if (!isoStr) return fallbackStr || '';
  try {
    const d = new Date(isoStr);
    if (!isNaN(d.getTime())) {
      return d.toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
      });
    }
  } catch (e) { }
  return fallbackStr || isoStr;
}

// Event Log Renderer for Dark Research / Telemetry Card
function renderLogs() {
  const filterKey = currentFilter || 'all';
  const filtered = filterKey === 'all' ? rawLogs : rawLogs.filter((l) => l.source === filterKey);

  if (filtered.length === 0) {
    logStream.innerHTML = `<div style="color: #7B7B93; font-family: var(--font-mono); font-size: 0.75rem; text-align: center; padding: 2rem;">No logs found for filter '${filterKey}'.</div>`;
    return;
  }

  logStream.innerHTML = filtered
    .map((log) => {
      const srcClass = `badge-src-${log.source}`;
      const detailsStr = log.details && Object.keys(log.details).length > 0 ? JSON.stringify(log.details) : '';
      const errorStr = log.error ? `<div style="color: var(--color-accent-pink); font-family: var(--font-mono); font-size: 0.72rem; margin-top: 0.2rem;">Error: ${log.error}</div>` : '';
      const displayTime = formatLocalTime(log.timestamp, log.timeFormatted);

      return `
        <div class="dark-log-item">
          <span class="dark-log-time" title="${log.timestamp}">${displayTime}</span>
          <span class="dark-log-src-badge ${srcClass}">${log.source}</span>
          <div class="dark-log-text">
            <div class="dark-log-action">${log.action} <span style="font-family: var(--font-mono); font-size: 0.7rem; opacity: 0.7;">(${log.result})</span></div>
            ${detailsStr ? `<div class="dark-log-detail">${detailsStr}</div>` : ''}
            ${errorStr}
          </div>
        </div>
      `;
    })
    .join('');
}

// Event Listeners

let isDraggingSlider = false;
let isUserEditingSplit = false;

function syncVisualSplit(valA) {
  const a = Math.max(0, Math.min(100, Math.round(Number(valA) || 0)));
  const b = 100 - a;
  barPctA.textContent = `${a}%`;
  barPctB.textContent = `${b}%`;
  splitBarFillA.style.width = `${a}%`;
  splitBarFillB.style.width = `${b}%`;
  splitSlider.value = a;
  isUserEditingSplit = true;
  if (btnApplySplit) btnApplySplit.classList.add('dirty');
}

// Split Slider
splitSlider.addEventListener('mousedown', () => { isDraggingSlider = true; isUserEditingSplit = true; });
splitSlider.addEventListener('touchstart', () => { isDraggingSlider = true; isUserEditingSplit = true; });
window.addEventListener('mouseup', () => { isDraggingSlider = false; });
window.addEventListener('touchend', () => { isDraggingSlider = false; });

splitSlider.addEventListener('input', (e) => {
  syncVisualSplit(e.target.value);
});

btnApplySplit.addEventListener('click', () => {
  const a = parseInt(splitSlider.value, 10) || 0;
  const b = 100 - a;
  applySplit(a, b);
});

async function applySplit(splitA, splitB) {
  try {
    const res = await fetch('/api/split', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ splitA, splitB }),
    });
    const data = await res.json();
    if (!res.ok) {
      // Check if error is due to a container being stopped
      if (data.error && data.error.includes('STOPPED')) {
        const targetContainer = splitA > 0 && data.error.includes('Container A') ? 'A' : 'B';
        const startConfirm = confirm(
          `Container ${targetContainer} is currently STOPPED.\n\nWould you like to start Container ${targetContainer} now and apply the ${splitA}% / ${splitB}% traffic split?`
        );
        if (startConfirm) {
          const startRes = await fetch(`/api/containers/${targetContainer}/start`, { method: 'POST' });
          if (startRes.ok) {
            return applySplit(splitA, splitB);
          } else {
            const startErr = await startRes.json();
            alert(`Failed to start Container ${targetContainer}: ${startErr.error}`);
          }
        }
      } else {
        alert(`Split Rejected: ${data.error}`);
      }
      return;
    }
    isUserEditingSplit = false;
    if (btnApplySplit) btnApplySplit.classList.remove('dirty');
  } catch (err) {
    alert(`Failed to apply split: ${err.message}`);
  }
}

// Container A Controls
btnStartA.addEventListener('click', () => containerAction('A', 'start'));
btnStopA.addEventListener('click', () => containerAction('A', 'stop'));
btnChaosA.addEventListener('click', () => containerChaos('A', 'toggle'));
btnDelayA.addEventListener('click', () => containerChaos('A', 'delay', 3000));

// Container B Controls
btnStartB.addEventListener('click', () => containerAction('B', 'start'));
btnStopB.addEventListener('click', () => containerAction('B', 'stop'));
btnChaosB.addEventListener('click', () => containerChaos('B', 'toggle'));
btnDelayB.addEventListener('click', () => containerChaos('B', 'delay', 3000));

async function containerAction(container, action) {
  try {
    const res = await fetch(`/api/containers/${container}/${action}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      alert(`Operation Rejected: ${data.error}`);
    }
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

async function containerChaos(container, action, delayMs) {
  try {
    const res = await fetch(`/api/containers/${container}/chaos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, delayMs }),
    });
    const data = await res.json();
    if (!res.ok) alert(`Chaos action failed: ${data.error}`);
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

// Rollout Controls
btnRolloutAtoB.addEventListener('click', () => triggerRollout('A', 'B'));
btnRolloutBtoA.addEventListener('click', () => triggerRollout('B', 'A'));

async function triggerRollout(from, to) {
  if (!confirm(`Are you sure you want to execute a Safe Rollout from Container ${from} to Container ${to}?`)) return;
  try {
    const res = await fetch('/api/rollout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to }),
    });
    const data = await res.json();
    if (!res.ok) alert(`Rollout rejected: ${data.error}`);
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

// Traffic Generator
tgRpmSlider.addEventListener('input', (e) => {
  const val = parseInt(e.target.value, 10);
  tgRpmLabel.textContent = `${val} RPM`;
  tgRpsLabel.textContent = `${(val / 60).toFixed(1)} req/s`;
});

tgRpmSlider.addEventListener('change', async (e) => {
  const rpm = parseInt(e.target.value, 10);
  await fetch('/api/traffic-generator/rpm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rpm }),
  });
});

btnTgStart.addEventListener('click', async () => {
  const rpm = parseInt(tgRpmSlider.value, 10);
  await fetch('/api/traffic-generator/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rpm }),
  });
});

btnTgStop.addEventListener('click', async () => {
  await fetch('/api/traffic-generator/stop', { method: 'POST' });
});

btnTgReset.addEventListener('click', async () => {
  await fetch('/api/traffic-generator/reset', { method: 'POST' });
});

// Log Filters
filterPills.forEach((pill) => {
  pill.addEventListener('click', () => {
    filterPills.forEach((p) => p.classList.remove('active'));
    pill.classList.add('active');
    currentFilter = pill.dataset.filter || 'all';
    renderLogs();
  });
});

function setFilter(filterName) {
  currentFilter = filterName;
  filterPills.forEach((p) => {
    if (p.dataset.filter === filterName) {
      p.classList.add('active');
    } else {
      p.classList.remove('active');
    }
  });
  renderLogs();
}

// Quick MCP Test Triggers
const btnMcpStatus = document.getElementById('btn-mcp-status');
const btnMcpSplit50 = document.getElementById('btn-mcp-split-50');
const btnMcpRolloutAB = document.getElementById('btn-mcp-rollout-ab');
const btnMcpInvalidTest = document.getElementById('btn-mcp-invalid-test');

if (btnMcpStatus) {
  btnMcpStatus.addEventListener('click', async () => {
    await fetch('/api/mcp/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'get_status' }),
    });
    setFilter('mcp');
  });
}

if (btnMcpSplit50) {
  btnMcpSplit50.addEventListener('click', async () => {
    await fetch('/api/mcp/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'set_traffic_split', params: { splitA: 50, splitB: 50 } }),
    });
    setFilter('mcp');
  });
}

if (btnMcpRolloutAB) {
  btnMcpRolloutAB.addEventListener('click', async () => {
    await fetch('/api/mcp/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'safe_rollout', params: { from: 'A', to: 'B' } }),
    });
    setFilter('mcp');
  });
}

if (btnMcpInvalidTest) {
  btnMcpInvalidTest.addEventListener('click', async () => {
    await fetch('/api/mcp/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'set_traffic_split', params: { splitA: 150, splitB: -50 } }),
    });
    setFilter('mcp');
  });
}

btnRefresh.addEventListener('click', async () => {
  const res = await fetch('/api/status');
  const status = await res.json();
  updateUI(status);
});

// Fullscreen Control
function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch((err) => {
      console.warn('Error attempting to enable fullscreen:', err.message);
    });
  } else {
    if (document.exitFullscreen) {
      document.exitFullscreen().catch((err) => {
        console.warn('Error attempting to exit fullscreen:', err.message);
      });
    }
  }
}

const btnFullscreen = document.getElementById('btn-fullscreen');
const btnCardFullscreen = document.getElementById('btn-card-fullscreen');
const fullscreenText = document.getElementById('fullscreen-text');
const fullscreenIcon = document.getElementById('fullscreen-icon');

if (btnFullscreen) {
  btnFullscreen.addEventListener('click', toggleFullscreen);
}

if (btnCardFullscreen) {
  btnCardFullscreen.addEventListener('click', toggleFullscreen);
}

document.addEventListener('fullscreenchange', () => {
  const isFull = !!document.fullscreenElement;
  if (fullscreenText) {
    fullscreenText.textContent = isFull ? 'Exit Full' : 'Fullscreen';
  }
  if (fullscreenIcon) {
    fullscreenIcon.innerHTML = isFull
      ? '<path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />'
      : '<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />';
  }
});

// Boot
connectSSE();
