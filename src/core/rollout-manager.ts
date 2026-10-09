import { ContainerId } from '../types/state.js';
import { EventSource } from '../types/events.js';
import { CONFIG } from '../config.js';
import { stateManager } from './state-manager.js';
import { dockerService } from './docker-service.js';
import { healthChecker } from './health-checker.js';
import { eventLogger } from './event-logger.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class RolloutManager {
  /**
   * Orchestrates a safe, zero-downtime rollout from one container to the other.
   *
   * Flow:
   * 1. Start target container
   * 2. Wait until target is healthy (with timeout -> abort on failure)
   * 3. Move traffic to target container
   * 4. Drain old container in-flight requests (with drain timeout)
   * 5. Stop old container
   */
  public async executeSafeRollout(
    from: ContainerId,
    to: ContainerId,
    source: EventSource
  ): Promise<{ success: boolean; message: string; error?: string }> {
    if (from === to) {
      const msg = `Source and target container cannot be the same (${from}).`;
      eventLogger.log('SAFE_ROLLOUT_REJECTED', source, 'rejected', { from, to }, msg);
      return { success: false, message: msg, error: msg };
    }

    if (stateManager.isRolloutActive()) {
      const msg = 'Cannot start rollout: Another safe rollout is currently in progress.';
      eventLogger.log('SAFE_ROLLOUT_REJECTED', source, 'rejected', { from, to }, msg);
      return { success: false, message: msg, error: msg };
    }

    const startTime = new Date().toISOString();
    stateManager.setRolloutState({
      status: 'IN_PROGRESS',
      from,
      to,
      step: `Step 1/5: Starting target Container ${to}`,
      stepIndex: 1,
      totalSteps: 5,
      startedAt: startTime,
      completedAt: null,
      error: null,
    });

    eventLogger.log('SAFE_ROLLOUT_STARTED', source, 'in_progress', {
      from,
      to,
      step: 1,
      action: `Starting target Container ${to}`,
    });

    try {
      // ----------------------------------------------------
      // STEP 1: Start target container
      // ----------------------------------------------------
      stateManager.setRolloutState({
        step: `Step 1/5: Starting target Container ${to}`,
        stepIndex: 1,
      });

      const startResult = await dockerService.startContainer(to);
      if (!startResult.success) {
        throw new Error(`Failed to start target Container ${to}: ${startResult.message}`);
      }

      stateManager.setContainerStatus(to, 'STARTING');
      eventLogger.log('SAFE_ROLLOUT_STEP', source, 'success', {
        step: 1,
        message: `Target Container ${to} started.`,
      });

      // ----------------------------------------------------
      // STEP 2: Wait until healthy (with timeout)
      // ----------------------------------------------------
      stateManager.setRolloutState({
        step: `Step 2/5: Polling health check for target Container ${to}`,
        stepIndex: 2,
      });

      const healthy = await this.waitForHealth(to, CONFIG.ROLLOUT_HEALTH_TIMEOUT_MS);
      if (!healthy) {
        // Rollout timeout -> Abort; traffic stays on old container
        const abortReason = `Target Container ${to} failed health check within ${CONFIG.ROLLOUT_HEALTH_TIMEOUT_MS}ms timeout.`;
        stateManager.setRolloutState({
          status: 'ABORTED',
          step: 'Rollout aborted: target failed health check',
          completedAt: new Date().toISOString(),
          error: abortReason,
        });

        eventLogger.log('SAFE_ROLLOUT_ABORTED', source, 'failed', {
          from,
          to,
          reason: abortReason,
          activeServingContainer: from,
        }, abortReason);

        // Ensure 100% traffic remains on source container
        stateManager.recomputeEffectiveSplit('Rollout aborted; keeping traffic on healthy source container');
        return {
          success: false,
          message: `Rollout aborted: ${abortReason}. Traffic safely maintained on Container ${from}.`,
          error: abortReason,
        };
      }

      stateManager.setContainerStatus(to, 'HEALTHY');
      eventLogger.log('SAFE_ROLLOUT_STEP', source, 'success', {
        step: 2,
        message: `Target Container ${to} is healthy and ready to receive traffic.`,
      });

      // ----------------------------------------------------
      // STEP 3: Move traffic to target container
      // ----------------------------------------------------
      stateManager.setRolloutState({
        step: `Step 3/5: Shifting 100% traffic to target Container ${to}`,
        stepIndex: 3,
      });

      const targetSplitA = to === 'A' ? 100 : 0;
      const targetSplitB = to === 'B' ? 100 : 0;

      // Update split internally bypassing conflict check since this is the rollout itself
      const prevSplit = stateManager.getConfiguredSplit();
      (stateManager as any).configuredSplit = { splitA: targetSplitA, splitB: targetSplitB };
      stateManager.recomputeEffectiveSplit(`Rollout traffic shift to Container ${to}`);

      eventLogger.log('SAFE_ROLLOUT_STEP', source, 'success', {
        step: 3,
        previousSplit: prevSplit,
        newSplit: { splitA: targetSplitA, splitB: targetSplitB },
        message: `Traffic completely shifted to Container ${to} (100%).`,
      });

      // ----------------------------------------------------
      // STEP 4: Drain old container
      // ----------------------------------------------------
      stateManager.setRolloutState({
        step: `Step 4/5: Draining in-flight requests from Container ${from}`,
        stepIndex: 4,
      });

      stateManager.setContainerStatus(from, 'DRAINING');
      eventLogger.log('CONTAINER_DRAINING_STARTED', source, 'in_progress', {
        container: from,
        inFlightRequests: stateManager.getContainer(from).inFlightRequests,
        drainTimeoutMs: CONFIG.DRAIN_TIMEOUT_MS,
      });

      const drainResult = await this.waitForDrain(from, CONFIG.DRAIN_TIMEOUT_MS);
      if (!drainResult.success) {
        // Drain timeout: report error, keep container running, but send it no new requests
        const drainError = `Drain timeout of ${CONFIG.DRAIN_TIMEOUT_MS}ms exceeded on Container ${from} (${drainResult.remainingInFlight} in-flight requests remaining). Container kept running but excluded from routing.`;
        eventLogger.log('CONTAINER_DRAIN_TIMEOUT', source, 'failed', {
          container: from,
          remainingInFlight: drainResult.remainingInFlight,
        }, drainError);

        stateManager.setRolloutState({
          status: 'SUCCESS',
          step: `Rollout complete with drain warning on Container ${from}`,
          completedAt: new Date().toISOString(),
          error: drainError,
        });

        return {
          success: true,
          message: `Safe rollout finished successfully to Container ${to}. Note: Container ${from} ${drainError}`,
        };
      }

      eventLogger.log('CONTAINER_DRAIN_COMPLETED', source, 'success', {
        container: from,
        message: `All in-flight requests on Container ${from} completed.`,
      });

      // ----------------------------------------------------
      // STEP 5: Stop old container
      // ----------------------------------------------------
      stateManager.setRolloutState({
        step: `Step 5/5: Stopping old Container ${from}`,
        stepIndex: 5,
      });

      await dockerService.stopContainer(from);
      stateManager.setContainerStatus(from, 'STOPPED');
      stateManager.updateContainerHealth(from, false, false, 'Stopped after successful rollout');

      eventLogger.log('SAFE_ROLLOUT_COMPLETED', source, 'success', {
        from,
        to,
        durationMs: Date.now() - new Date(startTime).getTime(),
        message: `Safe rollout complete. Container ${to} is active; Container ${from} is stopped.`,
      });

      stateManager.setRolloutState({
        status: 'SUCCESS',
        step: `Rollout completed successfully: 100% traffic on Container ${to}`,
        completedAt: new Date().toISOString(),
        error: null,
      });

      return {
        success: true,
        message: `Safe rollout from Container ${from} to Container ${to} completed successfully with zero dropped requests.`,
      };
    } catch (err: any) {
      const errorMsg = err.message || 'Rollout failed unexpectedly';
      stateManager.setRolloutState({
        status: 'FAILED',
        completedAt: new Date().toISOString(),
        error: errorMsg,
      });

      eventLogger.log('SAFE_ROLLOUT_FAILED', source, 'failed', { from, to }, errorMsg);
      return { success: false, message: `Rollout failed: ${errorMsg}`, error: errorMsg };
    }
  }

  /**
   * Gracefully stop a single container (with safety checks and in-flight draining).
   */
  public async gracefulStop(
    id: ContainerId,
    source: EventSource
  ): Promise<{ success: boolean; message: string; error?: string }> {
    if (stateManager.isRolloutActive()) {
      const msg = 'Cannot stop container: A safe rollout is currently in progress.';
      eventLogger.log('CONTAINER_STOP_REJECTED', source, 'rejected', { container: id }, msg);
      return { success: false, message: msg, error: msg };
    }

    const safetyCheck = stateManager.canStopContainer(id);
    if (!safetyCheck.allowed) {
      const errorMsg = safetyCheck.reason || 'Cannot stop container.';
      eventLogger.log('CONTAINER_STOP_REJECTED', source, 'rejected', { container: id }, errorMsg);
      return { success: false, message: errorMsg, error: errorMsg };
    }

    eventLogger.log('CONTAINER_STOP_INITIATED', source, 'in_progress', {
      container: id,
      inFlightRequests: stateManager.getContainer(id).inFlightRequests,
    });

    // 1. Remove from routing & mark draining
    stateManager.setContainerStatus(id, 'DRAINING');

    // 2. Wait for in-flight requests to complete
    const drainResult = await this.waitForDrain(id, CONFIG.DRAIN_TIMEOUT_MS);
    if (!drainResult.success) {
      const drainError = `Drain timeout exceeded on Container ${id} (${drainResult.remainingInFlight} in-flight requests). Container kept running but removed from routing.`;
      eventLogger.log('CONTAINER_DRAIN_TIMEOUT', source, 'failed', { container: id }, drainError);
      return { success: false, message: drainError, error: drainError };
    }

    // 3. Stop Docker container
    const stopResult = await dockerService.stopContainer(id);
    stateManager.setContainerStatus(id, 'STOPPED');
    stateManager.updateContainerHealth(id, false, false, 'Stopped manually');

    eventLogger.log('CONTAINER_STOP_COMPLETED', source, 'success', {
      container: id,
      dockerMessage: stopResult.message,
    });

    return {
      success: true,
      message: `Container ${id} drained and stopped successfully.`,
    };
  }

  /**
   * Starts a container and polls until it passes its readiness check or times out.
   */
  public async startContainerAndWait(
    id: ContainerId,
    source: EventSource,
    timeoutMs: number = CONFIG.ROLLOUT_HEALTH_TIMEOUT_MS
  ): Promise<{ success: boolean; message: string; error?: string }> {
    if (stateManager.isRolloutActive()) {
      const msg = 'Cannot start container: A safe rollout is currently in progress.';
      eventLogger.log('CONTAINER_START_REJECTED', source, 'rejected', { container: id }, msg);
      return { success: false, message: msg, error: msg };
    }

    eventLogger.log('CONTAINER_START_INITIATED', source, 'in_progress', { container: id });
    const startResult = await dockerService.startContainer(id);
    if (!startResult.success) {
      eventLogger.log('CONTAINER_START_FAILED', source, 'failed', { container: id }, startResult.message);
      return { success: false, message: startResult.message, error: startResult.message };
    }

    stateManager.setContainerStatus(id, 'STARTING');
    const healthy = await this.waitForHealth(id, timeoutMs);

    if (healthy) {
      stateManager.setContainerStatus(id, 'HEALTHY');
      eventLogger.log('CONTAINER_START_COMPLETED', source, 'success', {
        container: id,
        message: `Container ${id} started and passed health check.`,
      });
      return { success: true, message: `Container ${id} started and is now HEALTHY.` };
    } else {
      stateManager.setContainerStatus(id, 'UNHEALTHY');
      const err = `Container ${id} started but failed readiness health check within ${timeoutMs}ms.`;
      eventLogger.log('CONTAINER_START_TIMEOUT', source, 'failed', { container: id }, err);
      return { success: false, message: err, error: err };
    }
  }

  private async waitForHealth(id: ContainerId, timeoutMs: number): Promise<boolean> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const probe = await healthChecker.probeHealth(id, 1000);
      if (probe.healthy) {
        return true;
      }
      await sleep(400);
    }
    return false;
  }

  private async waitForDrain(
    id: ContainerId,
    timeoutMs: number
  ): Promise<{ success: boolean; remainingInFlight: number }> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const inFlight = stateManager.getContainer(id).inFlightRequests;
      if (inFlight === 0) {
        return { success: true, remainingInFlight: 0 };
      }
      await sleep(150);
    }

    const remaining = stateManager.getContainer(id).inFlightRequests;
    return {
      success: remaining === 0,
      remainingInFlight: remaining,
    };
  }
}

export const rolloutManager = new RolloutManager();
