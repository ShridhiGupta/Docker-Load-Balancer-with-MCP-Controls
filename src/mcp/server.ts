import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { stateManager } from '../core/state-manager.js';
import { rolloutManager } from '../core/rollout-manager.js';
import { eventLogger } from '../core/event-logger.js';
import { trafficGenerator } from '../core/traffic-generator.js';
import { ContainerId } from '../types/state.js';

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'docker-load-balancer-controller',
    version: '1.0.0',
  });

  /**
   * 1. Tool: get_status (or status)
   * Returns state, health, split (configured & effective), counts, and errors.
   */
  server.tool(
    'get_status',
    'Get full status of the load balancer, containers A and B, traffic split, in-flight counts, and metrics',
    {},
    async () => {
      eventLogger.log('MCP_GET_STATUS', 'mcp', 'success', {});
      const status = stateManager.getFullStatus();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(status, null, 2),
          },
        ],
      };
    }
  );

  /**
   * 2. Tool: set_traffic_split
   * Changes traffic split percentages with strict validation.
   */
  server.tool(
    'set_traffic_split',
    'Update traffic split percentages between Container A and Container B (must sum to 100). Rejects split to stopped or unhealthy containers.',
    {
      splitA: z.number().min(0).max(100).describe('Traffic percentage for Container A (0-100)'),
      splitB: z.number().min(0).max(100).describe('Traffic percentage for Container B (0-100)'),
    },
    async ({ splitA, splitB }) => {
      const result = stateManager.setTrafficSplit(splitA, splitB, 'mcp');
      if (!result.success) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Operation Rejected: ${result.error}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: `Successfully updated traffic split to A=${splitA}%, B=${splitB}%. Effective split: A=${result.effectiveSplit.effectiveA}%, B=${result.effectiveSplit.effectiveB}%.`,
          },
        ],
      };
    }
  );

  /**
   * 3. Tool: start_container
   * Starts container, then waits until it is healthy or times out.
   */
  server.tool(
    'start_container',
    'Starts a container (A or B) and polls until it passes health check or times out',
    {
      container: z.enum(['A', 'B']).describe('Container identifier to start ("A" or "B")'),
      timeoutMs: z.number().optional().describe('Timeout in milliseconds to wait for health (default 12000)'),
    },
    async ({ container, timeoutMs }) => {
      const result = await rolloutManager.startContainerAndWait(container as ContainerId, 'mcp', timeoutMs);
      if (!result.success) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Start Failed: ${result.error}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: result.message,
          },
        ],
      };
    }
  );

  /**
   * 4. Tool: stop_container
   * Drains the container (waits for in-flight requests), then stops it.
   */
  server.tool(
    'stop_container',
    'Gracefully drains all in-flight requests from container (A or B) and then stops it. Rejects if it is the last healthy container.',
    {
      container: z.enum(['A', 'B']).describe('Container identifier to stop ("A" or "B")'),
    },
    async ({ container }) => {
      const result = await rolloutManager.gracefulStop(container as ContainerId, 'mcp');
      if (!result.success) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Stop Rejected / Failed: ${result.error}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: result.message,
          },
        ],
      };
    }
  );

  /**
   * 5. Tool: safe_rollout
   * Moves traffic from one container to the other zero-downtime (Start -> Health Poll -> Move Traffic -> Drain -> Stop).
   */
  server.tool(
    'safe_rollout',
    'Executes a safe zero-downtime rollout from one container to the other (Start target -> Wait healthy -> Move traffic -> Drain old -> Stop old)',
    {
      from: z.enum(['A', 'B']).describe('Source container currently serving traffic ("A" or "B")'),
      to: z.enum(['A', 'B']).describe('Target container to roll out to ("A" or "B")'),
    },
    async ({ from, to }) => {
      const result = await rolloutManager.executeSafeRollout(from as ContainerId, to as ContainerId, 'mcp');
      if (!result.success) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Safe Rollout Aborted / Failed: ${result.error || result.message}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: result.message,
          },
        ],
      };
    }
  );

  /**
   * 6. Tool: get_recent_logs (or recent_logs)
   * Returns recent controller events.
   */
  server.tool(
    'get_recent_logs',
    'Returns recent controller event logs including timestamp, action, source, result, and details',
    {
      limit: z.number().optional().describe('Maximum number of logs to return (default 30)'),
      source: z.enum(['all', 'mcp', 'dashboard', 'controller', 'traffic-gen']).optional().describe('Filter logs by source'),
    },
    async ({ limit = 30, source }) => {
      const filterSource = source && source !== 'all' ? source : undefined;
      const logs = eventLogger.getLogs(limit, filterSource as any);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(logs, null, 2),
          },
        ],
      };
    }
  );

  /**
   * 7. Bonus Tool: force_container_unhealthy (Chaos Testing)
   * Forces a container into unhealthy state (useful for demonstrating failed rollouts via MCP).
   */
  server.tool(
    'force_container_unhealthy',
    'Forces a container to return 503 unhealthy responses (used for testing failed rollout recovery)',
    {
      container: z.enum(['A', 'B']).describe('Container identifier ("A" or "B")'),
      unhealthy: z.boolean().describe('True to force unhealthy, False to restore health'),
    },
    async ({ container, unhealthy }) => {
      const c = stateManager.getContainer(container as ContainerId);
      const endpoint = unhealthy ? '/chaos/unhealthy' : '/chaos/healthy';
      try {
        await fetch(`http://${c.host}:${c.port}${endpoint}`, { method: 'POST' });
        eventLogger.log('CHAOS_HEALTH_OVERRIDE', 'mcp', 'success', { container, unhealthy });
        return {
          content: [
            {
              type: 'text',
              text: `Container ${container} forced health state: ${unhealthy ? 'UNHEALTHY' : 'HEALTHY'}.`,
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Failed to set chaos health on Container ${container}: ${err.message}`,
            },
          ],
        };
      }
    }
  );

  /**
   * 8. Bonus Tool: control_traffic_generator
   */
  server.tool(
    'control_traffic_generator',
    'Start, stop, or adjust rate on the built-in traffic generator',
    {
      action: z.enum(['start', 'stop', 'set_rpm']).describe('Traffic generator action'),
      rpm: z.number().optional().describe('Requests per minute (for start or set_rpm)'),
    },
    async ({ action, rpm }) => {
      let stats;
      if (action === 'start') {
        stats = trafficGenerator.start(rpm, 'mcp');
      } else if (action === 'stop') {
        stats = trafficGenerator.stop('mcp');
      } else {
        stats = trafficGenerator.setRpm(rpm || 60, 'mcp');
      }

      return {
        content: [
          {
            type: 'text',
            text: `Traffic Generator ${action.toUpperCase()} complete. Total Sent: ${stats.totalSent}, Success: ${stats.successCount}, Failed: ${stats.failedCount}, RPM: ${stats.rpm}.`,
          },
        ],
      };
    }
  );

  return server;
}
