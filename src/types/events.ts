export type EventSource = 'dashboard' | 'mcp' | 'controller' | 'traffic-gen';

export type EventResult = 'success' | 'rejected' | 'failed' | 'in_progress';

export interface EventLog {
  id: string;
  timestamp: string;
  timeFormatted: string;
  action: string;
  source: EventSource;
  result: EventResult;
  details: Record<string, any>;
  error?: string;
}

export type EventListener = (event: EventLog) => void;
