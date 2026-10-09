import { CONFIG } from '../config.js';
import { ContainerId } from '../types/state.js';
import { stateManager } from './state-manager.js';
import { dockerService } from './docker-service.js';

class HealthChecker {
  private intervalTimer: NodeJS.Timeout | null = null;
  private isRunning = false;

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // Run initial check immediately
    this.checkAll();

    this.intervalTimer = setInterval(() => {
      this.checkAll();
    }, CONFIG.HEALTH_CHECK_INTERVAL_MS);

    console.log(`[HealthChecker] Started background polling (every ${CONFIG.HEALTH_CHECK_INTERVAL_MS}ms)`);
  }

  public stop(): void {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    this.isRunning = false;
  }

  public async checkAll(): Promise<void> {
    await Promise.all([this.checkContainer('A'), this.checkContainer('B')]);
  }

  public async checkContainer(id: ContainerId): Promise<boolean> {
    const container = stateManager.getContainer(id);
    const host = container.host;
    const port = container.port;

    const url = `http://${host}:${port}/health`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), CONFIG.HEALTH_CHECK_TIMEOUT_MS);

      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      const isHealthy = response.status === 200;
      let error: string | undefined;

      if (!isHealthy) {
        try {
          const body = (await response.json()) as any;
          error = body.reason || `HTTP status ${response.status}`;
        } catch {
          error = `HTTP status ${response.status}`;
        }
      }

      stateManager.updateContainerHealth(id, isHealthy, true, error);
      return isHealthy;
    } catch (err: any) {
      const isDockerRunning = await dockerService.isContainerRunning(id);
      const error = err.name === 'AbortError' ? 'Health check timed out' : err.message || 'Connection refused';
      stateManager.updateContainerHealth(id, false, isDockerRunning, error);
      return false;
    }
  }

  /**
   * One-shot probe with custom timeout (used during rollout polling)
   */
  public async probeHealth(
    id: ContainerId,
    timeoutMs: number = 2000
  ): Promise<{ healthy: boolean; data?: any; error?: string }> {
    const container = stateManager.getContainer(id);
    const url = `http://${container.host}:${container.port}/health`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (res.status === 200) {
        const data = await res.json();
        return { healthy: true, data };
      } else {
        const body = (await res.json()) as any;
        return { healthy: false, error: body.reason || `HTTP ${res.status}` };
      }
    } catch (err: any) {
      return {
        healthy: false,
        error: err.name === 'AbortError' ? 'Probe timed out' : err.message || 'Connection failed',
      };
    }
  }
}

export const healthChecker = new HealthChecker();
