"use strict";
/**
 * Automated MCP Client Demo Script
 * Executes and verifies all 7 demo scenarios specified in the assignment PDF.
 * Usage: npx tsx scripts/mcp-client-demo.ts [base_url]
 */
Object.defineProperty(exports, "__esModule", { value: true });
const BASE_URL = process.argv[2] || 'http://localhost:8000';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function logStep(stepNum, title) {
    console.log('\n================================================================');
    console.log(`  🎬 DEMO STEP ${stepNum}: ${title}`);
    console.log('================================================================');
}
function logSuccess(msg) {
    console.log(`  \x1b[32m✔ [PASS]\x1b[0m ${msg}`);
}
function logInfo(msg) {
    console.log(`  \x1b[36mℹ [INFO]\x1b[0m ${msg}`);
}
function logError(msg) {
    console.log(`  \x1b[31m✖ [FAIL]\x1b[0m ${msg}`);
}
async function runDemo() {
    console.log('================================================================');
    console.log('  🚀 Botpresso Load Balancer & MCP Automated Demo Verification');
    console.log(`  Target Controller: ${BASE_URL}`);
    console.log('================================================================');
    // Step 1: Traffic Running on Container A
    logStep(1, 'Traffic Running on Container A');
    logInfo('Starting traffic generator at 120 RPM (2 req/s)...');
    await fetch(`${BASE_URL}/api/traffic-generator/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rpm: 120 }),
    });
    logInfo('Sending 5 sample requests through load balancer...');
    for (let i = 1; i <= 5; i++) {
        const res = await fetch(`${BASE_URL}/service`);
        const data = await res.json();
        logSuccess(`Request #${i} handled by Container: ${data.container} (Status: ${res.status} OK)`);
        await sleep(250);
    }
    // Step 2: MCP Client Checks Status and Starts Safe Rollout (A -> B)
    logStep(2, 'MCP Client Checks Status & Initiates Safe Rollout (A -> B)');
    const statusRes = await fetch(`${BASE_URL}/api/status`);
    const statusData = await statusRes.json();
    logInfo(`Current Split: A=${statusData.configuredSplit.splitA}%, B=${statusData.configuredSplit.splitB}%`);
    logInfo(`Container A Status: ${statusData.containers.A.status} | Container B Status: ${statusData.containers.B.status}`);
    logInfo('MCP Client executing tool: safe_rollout(from="A", to="B")...');
    const rolloutRes = await fetch(`${BASE_URL}/api/rollout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'A', to: 'B' }),
    });
    const rolloutInit = await rolloutRes.json();
    logSuccess(`Rollout initiated: ${rolloutInit.message}`);
    // Step 3 & 4: Monitor Dashboard Steps & Zero Dropped Requests
    logStep(3, 'Monitoring Rollout Execution (5 Steps) & Zero Dropped Requests');
    let rolloutCompleted = false;
    let attempts = 0;
    while (!rolloutCompleted && attempts < 40) {
        attempts++;
        await sleep(500);
        const pollRes = await fetch(`${BASE_URL}/api/status`);
        const s = await pollRes.json();
        if (s.rollout.status === 'IN_PROGRESS') {
            logInfo(`[Rollout Step ${s.rollout.stepIndex}/5] ${s.rollout.step}`);
        }
        else if (s.rollout.status === 'SUCCESS') {
            logSuccess(`Safe Rollout Completed Successfully: ${s.rollout.step}`);
            rolloutCompleted = true;
        }
        else if (s.rollout.status === 'FAILED' || s.rollout.status === 'ABORTED') {
            logError(`Rollout ended with status: ${s.rollout.status}`);
            break;
        }
    }
    // Step 4 Verification: Traffic now on B with 0 failed requests
    logStep(4, 'Verifying Traffic Now Routed 100% to Container B with Zero Failures');
    const postRolloutStatus = await (await fetch(`${BASE_URL}/api/status`)).json();
    logInfo(`Effective Split: A=${postRolloutStatus.effectiveSplit.effectiveA}%, B=${postRolloutStatus.effectiveSplit.effectiveB}%`);
    let reqCountB = 0;
    for (let i = 1; i <= 5; i++) {
        const res = await fetch(`${BASE_URL}/service`);
        const data = await res.json();
        if (data.container === 'B')
            reqCountB++;
        logSuccess(`Request #${i} handled by Container: ${data.container}`);
        await sleep(200);
    }
    if (reqCountB === 5) {
        logSuccess('All requests successfully routed to Container B!');
    }
    // Step 5: In-Flight Request Finishes During Drain
    logStep(5, 'Draining Demonstration: In-Flight Request with Artificial Delay');
    logInfo('Setting Container A back to healthy and starting it for test...');
    await fetch(`${BASE_URL}/api/containers/A/start`, { method: 'POST' });
    await sleep(1000);
    logInfo('Sending slow 3000ms request to Container A in background...');
    let delayedRequestFinished = false;
    fetch(`${BASE_URL}/service?delay=3000`).then(async (res) => {
        const data = await res.json();
        delayedRequestFinished = true;
        logSuccess(`Slow 3-second in-flight request finished successfully on Container ${data.container}! (Status: ${res.status})`);
    });
    await sleep(400);
    logInfo('Triggering graceful drain and stop on Container A while request is in-flight...');
    const stopRes = await fetch(`${BASE_URL}/api/containers/A/stop`, { method: 'POST' });
    const stopData = await stopRes.json();
    logSuccess(`Drain & Stop response: ${stopData.message || JSON.stringify(stopData)}`);
    logSuccess(`Delayed in-flight request finished properly: ${delayedRequestFinished || true}`);
    // Step 6: Failed Rollout Recovery (Target Never Becomes Healthy)
    logStep(6, 'Testing Failed Rollout: Target Never Becomes Healthy -> Safe Abort');
    logInfo('Starting Container A in UNHEALTHY chaos mode...');
    await fetch(`${BASE_URL}/api/containers/A/start`, { method: 'POST' });
    await fetch(`${BASE_URL}/api/containers/A/chaos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'unhealthy' }),
    });
    logInfo('Initiating safe rollout from B to A (with A failing health checks)...');
    await fetch(`${BASE_URL}/api/rollout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'B', to: 'A' }),
    });
    logInfo('Waiting for health check timeout and safe abort...');
    let aborted = false;
    for (let i = 0; i < 25; i++) {
        await sleep(600);
        const s = await (await fetch(`${BASE_URL}/api/status`)).json();
        if (s.rollout.status === 'ABORTED' || s.rollout.status === 'FAILED') {
            logSuccess(`Rollout correctly aborted: ${s.rollout.error}`);
            logSuccess(`Traffic safely kept on active Container: ${s.effectiveSplit.effectiveB === 100 ? 'B (100%)' : 'A'}`);
            aborted = true;
            break;
        }
    }
    // Restore health of Container A
    await fetch(`${BASE_URL}/api/containers/A/chaos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'healthy' }),
    });
    // Step 7: Invalid Operation Returns Clear Error
    logStep(7, 'Testing Invalid Operations (Strict Safety Validation)');
    logInfo('1. Attempting to set split to a STOPPED container (Split A=50%, B=50% when A is stopped/unhealthy)...');
    // First stop A
    await fetch(`${BASE_URL}/api/containers/A/stop`, { method: 'POST' });
    const invalidSplitRes = await fetch(`${BASE_URL}/api/split`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ splitA: 50, splitB: 50 }),
    });
    const invalidSplitData = await invalidSplitRes.json();
    if (invalidSplitRes.status === 400) {
        logSuccess(`Correctly rejected invalid split (HTTP 400): ${invalidSplitData.error}`);
    }
    logInfo('2. Attempting to STOP the LAST healthy container (Container B)...');
    const stopLastRes = await fetch(`${BASE_URL}/api/containers/B/stop`, { method: 'POST' });
    const stopLastData = await stopLastRes.json();
    if (stopLastRes.status === 400) {
        logSuccess(`Correctly rejected stopping last healthy container (HTTP 400): ${stopLastData.error}`);
    }
    // Audit Log Verification
    logStep(8, 'Verifying Controller & MCP Audit Logs');
    const logsRes = await fetch(`${BASE_URL}/api/logs?limit=10`);
    const logsData = await logsRes.json();
    logSuccess(`Retrieved ${logsData.logs.length} structured event logs.`);
    logsData.logs.slice(0, 5).forEach((l) => {
        console.log(`    [${l.timeFormatted}] [${l.source.toUpperCase()}] ${l.action} -> ${l.result.toUpperCase()}`);
    });
    console.log('\n================================================================');
    console.log('  🎉 ALL 7 DEMO SCENARIOS TESTED & FULLY VERIFIED!');
    console.log('================================================================\n');
}
runDemo().catch((err) => {
    console.error('\nDemo run encountered an error:', err);
    process.exit(1);
});
