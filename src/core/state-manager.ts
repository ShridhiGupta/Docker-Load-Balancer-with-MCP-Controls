import {
  ContainerId,
  ContainerState,
  EffectiveSplit,
  RolloutState,
  SystemMetrics,
  SystemStatus,
  TrafficSplit,
} from '../types/state.js';
import { EventSource } from '../types/events.js';
import { CONFIG } from '../config.js';
import { eventLogger } from './event-logger.js';

class StateManager {
  private configuredSplit: TrafficSplit = { splitA: 100, splitB: 0 };
  private effectiveSplit: EffectiveSplit = {
    effectiveA: 100,
    effectiveB: 0,
    reason: 'Initial state: Container A primary',
  };

  private containers: Record<ContainerId, ContainerState> = {
    A: {
      id: 'A',
      name: CONFIG.APP_A.name,
      dockerContainerName: CONFIG.APP_A.dockerContainerName,
      host: CONFIG.APP_A.host,
      port: CONFIG.APP_A.port,
      status: 'HEALTHY',
      isHealthy: true,
      dockerRunning: true,
      inFlightRequests: 0,
      totalRequestsServed: 0,
      lastHealthCheck: null,
      lastHealthError: null,
      drainingStartedAt: null,
    },
    B: {
      id: 'B',
      name: CONFIG.APP_B.name,
      dockerContainerName: CONFIG.APP_B.dockerContainerName,
      host: CONFIG.APP_B.host,
      port: CONFIG.APP_B.port,
      status: 'STOPPED',
      isHealthy: false,
      dockerRunning: false,
      inFlightRequests: 0,
      totalRequestsServed: 0,
      lastHealthCheck: null,
      lastHealthError: null,
      drainingStartedAt: null,
    },
  };

  private rollout: RolloutState = {
    status: 'IDLE',
    from: null,
    to: null,
    step: null,
    stepIndex: 0,
    totalSteps: 5,
    startedAt: null,
    completedAt: null,
    error: null,
  };

  private metrics: SystemMetrics = {
    totalRequestsHandled: 0,
    totalSuccessRequests: 0,
    totalFailedRequests: 0,
    requestsServedA: 0,
    requestsServedB: 0,
    avgResponseTimeMs: 0,
    p95ResponseTimeMs: 0,
    activeConnections: 0,
  };

  private latencies: number[] = [];
  private errors: string[] = [];
  private startTime = Date.now();

  constructor() {
    this.recomputeEffectiveSplit('INITIALIZATION');
  }

  // --- Getters ---

  public getContainer(id: ContainerId): ContainerState {
    return this.containers[id];
  }

  public getAllContainers(): Record<ContainerId, ContainerState> {
    return { ...this.containers };
  }

  public getConfiguredSplit(): TrafficSplit {
    return { ...this.configuredSplit };
  }

  public getEffectiveSplit(): EffectiveSplit {
    return { ...this.effectiveSplit };
  }

  public getRolloutState(): RolloutState {
    return { ...this.rollout };
  }

  public getMetrics(): SystemMetrics {
    return { ...this.metrics };
  }

  public isRolloutActive(): boolean {
    return this.rollout.status === 'IN_PROGRESS';
  }

  // --- Split Management & Validation ---

  /**
   * Validates if a proposed split is allowable given the current container states.
   * Rule: Cannot send traffic to a stopped, unhealthy, or draining container.
   */
  public validateSplit(
    splitA: number,
    splitB: number
  ): { valid: boolean; error?: string } {
    if (typeof splitA !== 'number' || typeof splitB !== 'number') {
      return { valid: false, error: 'Split percentages must be numbers.' };
    }

    if (splitA < 0 || splitB < 0 || splitA > 100 || splitB > 100) {
      return { valid: false, error: 'Split percentages must be between 0 and 100.' };
    }

    if (Math.round(splitA + splitB) !== 100) {
      return {
        valid: false,
        error: `Split percentages must add up to 100. Received: A=${splitA}%, B=${splitB}% (sum: ${splitA + splitB}%).`,
      };
    }

    const stateA = this.containers.A;
    const stateB = this.containers.B;

    if (splitA > 0) {
      if (stateA.status === 'STOPPED') {
        return {
          valid: false,
          error: `Cannot route ${splitA}% traffic to Container A: Container is STOPPED. Start Container A first.`,
        };
      }
      if (stateA.status === 'UNHEALTHY' || !stateA.isHealthy) {
        return {
          valid: false,
          error: `Cannot route ${splitA}% traffic to Container A: Container is UNHEALTHY.`,
        };
      }
      if (stateA.status === 'DRAINING') {
        return {
          valid: false,
          error: `Cannot route ${splitA}% traffic to Container A: Container is currently DRAINING.`,
        };
      }
    }

    if (splitB > 0) {
      if (stateB.status === 'STOPPED') {
        return {
          valid: false,
          error: `Cannot route ${splitB}% traffic to Container B: Container is STOPPED. Start Container B first.`,
        };
      }
      if (stateB.status === 'UNHEALTHY' || !stateB.isHealthy) {
        return {
          valid: false,
          error: `Cannot route ${splitB}% traffic to Container B: Container is UNHEALTHY.`,
        };
      }
      if (stateB.status === 'DRAINING') {
        return {
          valid: false,
          error: `Cannot route ${splitB}% traffic to Container B: Container is currently DRAINING.`,
        };
      }
    }

    return { valid: true };
  }

  /**
   * Sets the configured traffic split with safety guards and logging.
   */
  public setTrafficSplit(
    splitA: number,
    splitB: number,
    source: EventSource
  ): { success: boolean; configuredSplit: TrafficSplit; effectiveSplit: EffectiveSplit; error?: string } {
    // Conflict rule: During a rollout, reject conflicting changes
    if (this.isRolloutActive()) {
      const errorMsg = 'Cannot change traffic split: A safe rollout is currently in progress.';
      eventLogger.log('TRAFFIC_SPLIT_REJECTED', source, 'rejected', { splitA, splitB }, errorMsg);
      return {
        success: false,
        configuredSplit: this.configuredSplit,
        effectiveSplit: this.effectiveSplit,
        error: errorMsg,
      };
    }

    const validation = this.validateSplit(splitA, splitB);
    if (!validation.valid) {
      const errorMsg = validation.error || 'Invalid traffic split.';
      eventLogger.log('TRAFFIC_SPLIT_REJECTED', source, 'rejected', { splitA, splitB }, errorMsg);
      return {
        success: false,
        configuredSplit: this.configuredSplit,
        effectiveSplit: this.effectiveSplit,
        error: errorMsg,
      };
    }

    const previousSplit = { ...this.configuredSplit };
    this.configuredSplit = { splitA, splitB };
    const effective = this.recomputeEffectiveSplit(`Manual split updated by ${source}`);

    eventLogger.log(
      'TRAFFIC_SPLIT_CHANGED',
      source,
      'success',
      {
        previousSplit,
        configuredSplit: this.configuredSplit,
        effectiveSplit: effective,
      }
    );

    return {
      success: true,
      configuredSplit: this.configuredSplit,
      effectiveSplit: this.effectiveSplit,
    };
  }

  /**
   * Dynamically recomputes the effective split based on real-time health and draining status.
   * If one container goes down/draining, traffic is temporarily shifted to the remaining healthy container.
   */
  public recomputeEffectiveSplit(triggerReason: string): EffectiveSplit {
    const isAAvailable =
      this.containers.A.isHealthy &&
      this.containers.A.status === 'HEALTHY';

    const isBAvailable =
      this.containers.B.isHealthy &&
      this.containers.B.status === 'HEALTHY';

    let nextA = 0;
    let nextB = 0;
    let reason = '';

    if (isAAvailable && isBAvailable) {
      // Both backends healthy: honor configured split
      nextA = this.configuredSplit.splitA;
      nextB = this.configuredSplit.splitB;
      reason = 'Both containers healthy: operating at configured split.';
    } else if (isAAvailable && !isBAvailable) {
      // Container B is unavailable: shift 100% to A
      nextA = 100;
      nextB = 0;
      reason = `Container B is ${this.containers.B.status.toLowerCase()}: all traffic temporarily shifted to Container A (100%).`;
    } else if (!isAAvailable && isBAvailable) {
      // Container A is unavailable: shift 100% to B
      nextA = 0;
      nextB = 100;
      reason = `Container A is ${this.containers.A.status.toLowerCase()}: all traffic temporarily shifted to Container B (100%).`;
    } else {
      // Neither available: service unavailable
      nextA = 0;
      nextB = 0;
      reason = 'Neither container is healthy: service temporarily unavailable (HTTP 503).';
    }

    const previousEffective = { ...this.effectiveSplit };
    const changed =
      previousEffective.effectiveA !== nextA || previousEffective.effectiveB !== nextB;

    this.effectiveSplit = {
      effectiveA: nextA,
      effectiveB: nextB,
      reason,
    };

    if (changed && triggerReason !== 'INITIALIZATION') {
      eventLogger.log(
        'DYNAMIC_SPLIT_FALLBACK',
        'controller',
        'success',
        {
          trigger: triggerReason,
          previousEffective: { A: previousEffective.effectiveA, B: previousEffective.effectiveB },
          effectiveSplit: { A: nextA, B: nextB },
          reason,
        }
      );
    }

    return this.effectiveSplit;
  }

  // --- Container Health & State Updates ---

  public updateContainerHealth(
    id: ContainerId,
    isHealthy: boolean,
    dockerRunning: boolean,
    error?: string
  ): void {
    const container = this.containers[id];
    const previousStatus = container.status;
    const previousHealthy = container.isHealthy;

    container.isHealthy = isHealthy;
    container.dockerRunning = dockerRunning;
    container.lastHealthCheck = new Date().toISOString();
    container.lastHealthError = error || null;

    if (!dockerRunning) {
      container.status = 'STOPPED';
    } else if (container.status === 'DRAINING') {
      // Keep draining status until stopped
    } else if (container.status === 'STARTING' && isHealthy) {
      container.status = 'HEALTHY';
    } else if (isHealthy) {
      container.status = 'HEALTHY';
    } else {
      container.status = 'UNHEALTHY';
    }

    if (previousStatus !== container.status || previousHealthy !== isHealthy) {
      eventLogger.log(
        'CONTAINER_STATUS_CHANGED',
        'controller',
        'success',
        {
          container: id,
          from: previousStatus,
          to: container.status,
          isHealthy,
          dockerRunning,
          error,
        }
      );
      this.recomputeEffectiveSplit(`Container ${id} state changed from ${previousStatus} to ${container.status}`);
    }
  }

  public setContainerStatus(id: ContainerId, status: ContainerState['status']): void {
    const previous = this.containers[id].status;
    this.containers[id].status = status;
    if (status === 'DRAINING') {
      this.containers[id].drainingStartedAt = Date.now();
    } else {
      this.containers[id].drainingStartedAt = null;
    }
    this.recomputeEffectiveSplit(`Container ${id} status explicitly set to ${status}`);
  }

  // --- Stop Safety Validation ---

  /**
   * Safety rule: Reject stopping the last healthy container serving traffic.
   */
  public canStopContainer(id: ContainerId): { allowed: boolean; reason?: string } {
    const target = this.containers[id];
    const otherId: ContainerId = id === 'A' ? 'B' : 'A';
    const other = this.containers[otherId];

    // If target is already stopped or draining, allow
    if (target.status === 'STOPPED' || target.status === 'DRAINING') {
      return { allowed: true };
    }

    // Check if other container is healthy and running
    const otherIsHealthyAndServing =
      other.dockerRunning && other.isHealthy && other.status === 'HEALTHY';

    if (!otherIsHealthyAndServing) {
      return {
        allowed: false,
        reason: `Cannot stop Container ${id}: It is the LAST healthy container serving traffic. Starting or healing Container ${otherId} is required first.`,
      };
    }

    return { allowed: true };
  }

  // --- Rollout State Management ---

  public setRolloutState(updates: Partial<RolloutState>): void {
    this.rollout = { ...this.rollout, ...updates };
  }

  public resetRollout(): void {
    this.rollout = {
      status: 'IDLE',
      from: null,
      to: null,
      step: null,
      stepIndex: 0,
      totalSteps: 5,
      startedAt: null,
      completedAt: null,
      error: null,
    };
  }

  // --- Request & In-Flight Tracking ---

  public incrementInFlight(id: ContainerId): void {
    this.containers[id].inFlightRequests++;
    this.metrics.activeConnections++;
  }

  public decrementInFlight(id: ContainerId): void {
    this.containers[id].inFlightRequests = Math.max(0, this.containers[id].inFlightRequests - 1);
    this.metrics.activeConnections = Math.max(0, this.metrics.activeConnections - 1);
  }

  public recordRequest(
    target: ContainerId | null,
    success: boolean,
    durationMs: number
  ): void {
    this.metrics.totalRequestsHandled++;
    if (success) {
      this.metrics.totalSuccessRequests++;
    } else {
      this.metrics.totalFailedRequests++;
    }

    if (target === 'A') {
      this.metrics.requestsServedA++;
      this.containers.A.totalRequestsServed++;
    } else if (target === 'B') {
      this.metrics.requestsServedB++;
      this.containers.B.totalRequestsServed++;
    }

    this.latencies.push(durationMs);
    if (this.latencies.length > 500) this.latencies.shift();

    const sum = this.latencies.reduce((a, b) => a + b, 0);
    this.metrics.avgResponseTimeMs = Math.round(sum / this.latencies.length);

    const sorted = [...this.latencies].sort((a, b) => a - b);
    const p95Idx = Math.floor(sorted.length * 0.95);
    this.metrics.p95ResponseTimeMs = sorted[p95Idx] || this.metrics.avgResponseTimeMs;
  }

  // --- Full System Status Serializer ---

  public getFullStatus(): SystemStatus {
    return {
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      containers: {
        A: { ...this.containers.A },
        B: { ...this.containers.B },
      },
      configuredSplit: { ...this.configuredSplit },
      effectiveSplit: { ...this.effectiveSplit },
      rollout: { ...this.rollout },
      metrics: { ...this.metrics },
      errors: [...this.errors],
    };
  }
}

export const stateManager = new StateManager();
