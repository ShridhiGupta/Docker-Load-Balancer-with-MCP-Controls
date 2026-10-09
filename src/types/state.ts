export type ContainerId = 'A' | 'B';

export type ContainerStatus =
  | 'STOPPED'
  | 'STARTING'
  | 'RUNNING'
  | 'HEALTHY'
  | 'UNHEALTHY'
  | 'DRAINING';

export interface ContainerState {
  id: ContainerId;
  name: string;
  dockerContainerName: string;
  host: string;
  port: number;
  status: ContainerStatus;
  isHealthy: boolean;
  dockerRunning: boolean;
  inFlightRequests: number;
  totalRequestsServed: number;
  lastHealthCheck: string | null;
  lastHealthError: string | null;
  drainingStartedAt: number | null;
}

export interface TrafficSplit {
  splitA: number;
  splitB: number;
}

export interface EffectiveSplit {
  effectiveA: number;
  effectiveB: number;
  reason: string;
}

export type RolloutStatus =
  | 'IDLE'
  | 'IN_PROGRESS'
  | 'SUCCESS'
  | 'FAILED'
  | 'ABORTED';

export interface RolloutState {
  status: RolloutStatus;
  from: ContainerId | null;
  to: ContainerId | null;
  step: string | null;
  stepIndex: number;
  totalSteps: number;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

export interface SystemMetrics {
  totalRequestsHandled: number;
  totalSuccessRequests: number;
  totalFailedRequests: number;
  requestsServedA: number;
  requestsServedB: number;
  avgResponseTimeMs: number;
  p95ResponseTimeMs: number;
  activeConnections: number;
}

export interface SystemStatus {
  timestamp: string;
  uptimeSeconds: number;
  containers: {
    A: ContainerState;
    B: ContainerState;
  };
  configuredSplit: TrafficSplit;
  effectiveSplit: EffectiveSplit;
  rollout: RolloutState;
  metrics: SystemMetrics;
  errors: string[];
}
