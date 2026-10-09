import { CONFIG } from '../config.js';
import { eventLogger } from './event-logger.js';
import { EventSource } from '../types/events.js';

export interface TrafficStats {
  isRunning: boolean;
  rpm: number;
  totalSent: number;
  successCount: number;
  failedCount: number;
  servedByA: number;
  servedByB: number;
  avgLatencyMs: number;
  lastError: string | null;
  startedAt: string | null;
}

class TrafficGenerator {
  private isRunning = false;
  private rpm = 60; // default 60 requests/min (1 req/sec)
  private timer: NodeJS.Timeout | null = null;
  private targetUrl = `http://localhost:${CONFIG.PORT}/service`;

  private stats: TrafficStats = {
    isRunning: false,
    rpm: 60,
    totalSent: 0,
    successCount: 0,
    failedCount: 0,
    servedByA: 0,
    servedByB: 0,
    avgLatencyMs: 0,
    lastError: null,
    startedAt: null,
  };

  private latencies: number[] = [];

  public start(rpm?: number, source: EventSource = 'dashboard'): TrafficStats {
    if (rpm && rpm > 0) {
      this.rpm = Math.min(12000, Math.max(1, rpm));
      this.stats.rpm = this.rpm;
    }

    if (this.isRunning) {
      this.reschedule();
      return this.getStats();
    }

    this.isRunning = true;
    this.stats.isRunning = true;
    this.stats.startedAt = new Date().toISOString();

    eventLogger.log('TRAFFIC_GENERATOR_STARTED', source, 'success', {
      rpm: this.rpm,
      intervalMs: Math.round(60000 / this.rpm),
    });

    this.reschedule();
    return this.getStats();
  }

  public stop(source: EventSource = 'dashboard'): TrafficStats {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.isRunning = false;
    this.stats.isRunning = false;

    eventLogger.log('TRAFFIC_GENERATOR_STOPPED', source, 'success', {
      totalSent: this.stats.totalSent,
      successCount: this.stats.successCount,
      failedCount: this.stats.failedCount,
    });

    return this.getStats();
  }

  public setRpm(rpm: number, source: EventSource = 'dashboard'): TrafficStats {
    this.rpm = Math.min(12000, Math.max(1, rpm));
    this.stats.rpm = this.rpm;

    if (this.isRunning) {
      this.reschedule();
    }

    eventLogger.log('TRAFFIC_RATE_UPDATED', source, 'success', { rpm: this.rpm });
    return this.getStats();
  }

  public getStats(): TrafficStats {
    return { ...this.stats };
  }

  public resetStats(): void {
    this.stats = {
      ...this.stats,
      totalSent: 0,
      successCount: 0,
      failedCount: 0,
      servedByA: 0,
      servedByB: 0,
      avgLatencyMs: 0,
      lastError: null,
    };
    this.latencies = [];
  }

  private reschedule(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    const intervalMs = Math.max(5, Math.floor(60000 / this.rpm));
    this.timer = setInterval(() => {
      this.sendSingleRequest();
    }, intervalMs);
  }

  private async sendSingleRequest(): Promise<void> {
    if (!this.isRunning) return;

    this.stats.totalSent++;
    const startMs = Date.now();

    try {
      const res = await fetch(this.targetUrl, {
        method: 'GET',
        headers: {
          'X-Traffic-Generator': 'true',
          'X-Request-Id': `gen_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        },
      });

      const latencyMs = Date.now() - startMs;
      this.recordLatency(latencyMs);

      if (res.status >= 200 && res.status < 400) {
        this.stats.successCount++;
        const routedHeader = res.headers.get('X-Routed-To') || res.headers.get('X-Handled-By');
        if (routedHeader && routedHeader.includes('A')) {
          this.stats.servedByA++;
        } else if (routedHeader && routedHeader.includes('B')) {
          this.stats.servedByB++;
        }
      } else {
        this.stats.failedCount++;
        this.stats.lastError = `HTTP ${res.status}`;
      }
    } catch (err: any) {
      this.stats.failedCount++;
      this.stats.lastError = err.message || 'Network error';
    }
  }

  private recordLatency(ms: number): void {
    this.latencies.push(ms);
    if (this.latencies.length > 200) this.latencies.shift();
    const sum = this.latencies.reduce((a, b) => a + b, 0);
    this.stats.avgLatencyMs = Math.round(sum / this.latencies.length);
  }
}

export const trafficGenerator = new TrafficGenerator();
