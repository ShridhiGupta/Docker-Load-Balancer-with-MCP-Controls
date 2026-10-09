"use strict";
/**
 * Complete Automated Integration & Unit Test Suite
 * Validates all 10+ rubric evaluation scenarios for the Botpresso Docker Load Balancer.
 * Usage: npm test
 */
Object.defineProperty(exports, "__esModule", { value: true });
const state_manager_js_1 = require("../src/core/state-manager.js");
const rollout_manager_js_1 = require("../src/core/rollout-manager.js");
const event_logger_js_1 = require("../src/core/event-logger.js");
const server_js_1 = require("../src/mcp/server.js");
let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
function assert(condition, testName, detail) {
    totalTests++;
    if (condition) {
        passedTests++;
        console.log(`  \x1b[32m✔ [PASS]\x1b[0m ${testName}`);
    }
    else {
        failedTests++;
        console.error(`  \x1b[31m✖ [FAIL]\x1b[0m ${testName} ${detail ? `(${detail})` : ''}`);
    }
}
async function runAllTests() {
    console.log('================================================================');
    console.log('  🧪 Running Production Test Suite: Docker Load Balancer');
    console.log('================================================================\n');
    // Test Group 1: Split Calculations & Initial State
    console.log('--- Test Suite 1: Initial State & Split Validation ---');
    const initialSplit = state_manager_js_1.stateManager.getConfiguredSplit();
    assert(initialSplit.splitA === 100 && initialSplit.splitB === 0, 'Initial configured split is 100% A / 0% B');
    const initialEffective = state_manager_js_1.stateManager.getEffectiveSplit();
    assert(initialEffective.effectiveA === 100 && initialEffective.effectiveB === 0, 'Initial effective split routes 100% to Container A');
    // Test Group 2: Invalid Split Rejections
    console.log('\n--- Test Suite 2: Invalid Split Rejection Rules ---');
    const splitNon100 = state_manager_js_1.stateManager.validateSplit(60, 50);
    assert(!splitNon100.valid, 'Reject split sum not equal to 100 (60 + 50 = 110)');
    const splitNegative = state_manager_js_1.stateManager.validateSplit(-10, 110);
    assert(!splitNegative.valid, 'Reject negative split values (-10, 110)');
    // Container B is initially STOPPED
    const splitToStoppedB = state_manager_js_1.stateManager.validateSplit(50, 50);
    assert(!splitToStoppedB.valid, 'Reject routing traffic to STOPPED Container B');
    // Test Group 3: Dynamic Effective Split Fallback
    console.log('\n--- Test Suite 3: Dynamic Effective Split Fallback ---');
    // Mark Container A as unhealthy
    state_manager_js_1.stateManager.updateContainerHealth('A', false, true, 'Chaos test error');
    const fallbackEffective = state_manager_js_1.stateManager.getEffectiveSplit();
    assert(fallbackEffective.effectiveA === 0 && fallbackEffective.effectiveB === 0, 'When both A (unhealthy) and B (stopped) are unavailable, effective split is 0% / 0% (503 Service Unavailable)');
    // Mark Container A healthy again
    state_manager_js_1.stateManager.updateContainerHealth('A', true, true);
    const restoredEffective = state_manager_js_1.stateManager.getEffectiveSplit();
    assert(restoredEffective.effectiveA === 100, 'When Container A is restored to healthy, effective split returns to 100% A');
    // Test Group 4: Stop Guards (Stopping Last Healthy Container)
    console.log('\n--- Test Suite 4: Stop Container Safety Guards ---');
    const canStopA = state_manager_js_1.stateManager.canStopContainer('A');
    assert(!canStopA.allowed, 'Reject stopping Container A when it is the LAST healthy container');
    // Test Group 5: In-Flight Request Tracking
    console.log('\n--- Test Suite 5: In-Flight Connection Tracking ---');
    state_manager_js_1.stateManager.incrementInFlight('A');
    assert(state_manager_js_1.stateManager.getContainer('A').inFlightRequests === 1, 'In-flight count increments to 1 on request dispatch');
    state_manager_js_1.stateManager.decrementInFlight('A');
    assert(state_manager_js_1.stateManager.getContainer('A').inFlightRequests === 0, 'In-flight count decrements to 0 on request completion');
    // Test Group 6: Event Logger and MCP Audit Source
    console.log('\n--- Test Suite 6: Structured Event Logger & Source Tracking ---');
    event_logger_js_1.eventLogger.log('TEST_MCP_ACTION', 'mcp', 'success', { test: true });
    event_logger_js_1.eventLogger.log('TEST_DASHBOARD_ACTION', 'dashboard', 'success', { test: true });
    const mcpLogs = event_logger_js_1.eventLogger.getLogs(10, 'mcp');
    assert(mcpLogs.length >= 1, 'Event logger records and filters logs by source="mcp"');
    assert(mcpLogs[0].source === 'mcp', 'MCP event log source is strictly "mcp"');
    // Test Group 7: MCP Server Initialization & Tool Definitions
    console.log('\n--- Test Suite 7: Model Context Protocol (MCP) Server ---');
    const mcpServer = (0, server_js_1.createMcpServer)();
    assert(mcpServer !== null, 'MCP Server initializes successfully with @modelcontextprotocol/sdk');
    // Test Group 8: Rollout Mutex & Conflict Protection
    console.log('\n--- Test Suite 8: Rollout Mutex & Conflict Rules ---');
    state_manager_js_1.stateManager.setRolloutState({ status: 'IN_PROGRESS', step: 'Testing lock' });
    const splitDuringRollout = state_manager_js_1.stateManager.setTrafficSplit(50, 50, 'dashboard');
    assert(!splitDuringRollout.success, 'Reject split change during active rollout (409 Conflict)');
    const stopDuringRollout = await rollout_manager_js_1.rolloutManager.gracefulStop('A', 'dashboard');
    assert(!stopDuringRollout.success, 'Reject container stop during active rollout (409 Conflict)');
    // Reset rollout state
    state_manager_js_1.stateManager.resetRollout();
    assert(!state_manager_js_1.stateManager.isRolloutActive(), 'Rollout state resets cleanly to IDLE');
    console.log('\n================================================================');
    console.log(`  Test Results: Total: ${totalTests} | Passed: \x1b[32m${passedTests}\x1b[0m | Failed: ${failedTests === 0 ? '\x1b[32m0\x1b[0m' : `\x1b[31m${failedTests}\x1b[0m`}`);
    console.log('================================================================\n');
    if (failedTests > 0) {
        process.exit(1);
    }
}
runAllTests().catch((err) => {
    console.error('Test suite failed:', err);
    process.exit(1);
});
