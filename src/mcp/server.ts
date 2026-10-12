import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CONFIG } from '../config.js';

/**
 * Execute tool directly against the live running Load Balancer Controller HTTP API.
 * This guarantees:
 * 1. OpenCode queries the exact live state running in Docker/Dashboard (127.0.0.1:8000).
 * 2. Any modifications trigger real SSE events and immediately reflect on the Web Dashboard.
 * 3. All operations appear in the "Live Controller & MCP Audit Stream" tagged with [MCP].
 * 4. Tries IPv4 (127.0.0.1) first to avoid Windows IPv6 localhost resolution issues.
 */
async function executeViaController(
  tool: string,
  params: Record<string, any> = {}
): Promise<{ isError: boolean; text: string }> {
  const port = CONFIG.PORT || 8000;
  const urls = [
    `http://127.0.0.1:${port}/api/mcp/execute`,
    `http://localhost:${port}/api/mcp/execute`,
  ];

  let lastError: any = null;

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ tool, params }),
      });

      const data = (await res.json()) as any;
      if (!res.ok || data.isError) {
        return {
          isError: true,
          text: data.error || `Operation Rejected / Failed (HTTP ${res.status})`,
        };
      }

      const outputText =
        typeof data.result === 'string'
          ? data.result
          : JSON.stringify(data.result, null, 2);

      return {
        isError: false,
        text: outputText,
      };
    } catch (err: any) {
      lastError = err;
    }
  }

  console.error('[MCP Controller Bridge Error]:', lastError);
  return {
    isError: true,
    text: `Error connecting to Live Load Balancer Controller at http://127.0.0.1:${port}: ${lastError?.message || lastError}. Ensure Docker containers and controller are running.`,
  };
}

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'docker-load-balancer-controller',
    version: '1.0.0',
  });

  /**
   * 1. Tool: get_status
   * Returns state, health, split (configured & effective), counts, and metrics from live controller.
   */
  server.tool(
    'get_status',
    'Get full status of the load balancer, containers A and B, traffic split, in-flight counts, and metrics',
    {},
    async () => {
      const result = await executeViaController('get_status', {});
      return {
        isError: result.isError,
        content: [{ type: 'text', text: result.text }],
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
      const result = await executeViaController('set_traffic_split', { splitA, splitB });
      return {
        isError: result.isError,
        content: [{ type: 'text', text: result.text }],
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
      const result = await executeViaController('start_container', { container, timeoutMs });
      return {
        isError: result.isError,
        content: [{ type: 'text', text: result.text }],
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
      const result = await executeViaController('stop_container', { container });
      return {
        isError: result.isError,
        content: [{ type: 'text', text: result.text }],
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
      const result = await executeViaController('safe_rollout', { from, to });
      return {
        isError: result.isError,
        content: [{ type: 'text', text: result.text }],
      };
    }
  );

  /**
   * 6. Tool: get_recent_logs
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
      const result = await executeViaController('get_recent_logs', { limit, source });
      return {
        isError: result.isError,
        content: [{ type: 'text', text: result.text }],
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
      const result = await executeViaController('force_container_unhealthy', { container, unhealthy });
      return {
        isError: result.isError,
        content: [{ type: 'text', text: result.text }],
      };
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
      const result = await executeViaController('control_traffic_generator', { action, rpm });
      return {
        isError: result.isError,
        content: [{ type: 'text', text: result.text }],
      };
    }
  );

  return server;
}
