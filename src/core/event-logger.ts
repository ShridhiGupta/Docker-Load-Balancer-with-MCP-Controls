import crypto from 'crypto';
import { EventLog, EventListener, EventSource, EventResult } from '../types/events.js';
import { CONFIG } from '../config.js';

class EventLogger {
  private logs: EventLog[] = [];
  private listeners: Set<EventListener> = new Set();

  public log(
    action: string,
    source: EventSource,
    result: EventResult,
    details: Record<string, any> = {},
    error?: string
  ): EventLog {
    const now = new Date();
    const event: EventLog = {
      id: `evt_${crypto.randomBytes(4).toString('hex')}`,
      timestamp: now.toISOString(),
      timeFormatted: now.toLocaleTimeString(),
      action,
      source,
      result,
      details,
      error,
    };

    // Prepend to circular buffer
    this.logs.unshift(event);
    if (this.logs.length > CONFIG.MAX_EVENT_LOGS) {
      this.logs.pop();
    }

    // Console output for observability
    const color =
      result === 'success'
        ? '\x1b[32m'
        : result === 'rejected'
        ? '\x1b[33m'
        : result === 'failed'
        ? '\x1b[31m'
        : '\x1b[36m';
    console.log(
      `[EVENT] [${event.timeFormatted}] [${source.toUpperCase()}] ${color}${action} -> ${result.toUpperCase()}\x1b[0m`,
      details,
      error ? `Error: ${error}` : ''
    );

    // Notify all active stream subscribers
    this.notifyListeners(event);

    return event;
  }

  public getLogs(limit = 50, source?: EventSource): EventLog[] {
    let result = this.logs;
    if (source) {
      result = result.filter((l) => l.source === source);
    }
    return result.slice(0, limit);
  }

  public subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners(event: EventLog): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('Error dispatching event to listener:', err);
      }
    }
  }

  public clear(): void {
    this.logs = [];
  }
}

export const eventLogger = new EventLogger();
