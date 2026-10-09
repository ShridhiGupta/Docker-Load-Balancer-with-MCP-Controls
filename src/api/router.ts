import { Router, Request, Response } from 'express';
import { stateManager } from '../core/state-manager.js';
import { rolloutManager } from '../core/rollout-manager.js';
import { eventLogger } from '../core/event-logger.js';
import { trafficGenerator } from '../core/traffic-generator.js';
import { loadBalancer } from '../core/load-balancer.js';
import { ContainerId } from '../types/state.js';
import { EventLog } from '../types/events.js';

export const apiRouter = Router();

// --- 1. System Status & Metrics ---

apiRouter.get('/status', (req: Request, res: Response) => {
  res.json(stateManager.getFullStatus());
});

apiRouter.get('/metrics', (req: Request, res: Response) => {
  res.json({
    metrics: stateManager.getMetrics(),
    effectiveSplit: stateManager.getEffectiveSplit(),
    trafficGen: trafficGenerator.getStats(),
  });
});

// Helper to extract event source from header, query, or body
const getSource = (req: Request): 'dashboard' | 'mcp' | 'controller' => {
  const src = (req.headers['x-source'] || req.query.source || req.body?.source || 'dashboard') as string;
  return src === 'mcp' ? 'mcp' : src === 'controller' ? 'controller' : 'dashboard';
};

// --- 2. Traffic Split Control ---

apiRouter.post('/split', (req: Request, res: Response) => {
  const { splitA, splitB } = req.body;
  const source = getSource(req);

  if (typeof splitA !== 'number' || typeof splitB !== 'number') {
    res.status(400).json({ error: 'splitA and splitB must be numbers between 0 and 100.' });
    return;
  }

  const result = stateManager.setTrafficSplit(splitA, splitB, source);
  if (!result.success) {
    const statusCode = result.error?.includes('in progress') ? 409 : 400;
    res.status(statusCode).json({ error: result.error });
    return;
  }

  res.json({
    message: 'Traffic split updated successfully',
    configuredSplit: result.configuredSplit,
    effectiveSplit: result.effectiveSplit,
  });
});

// --- 3. Container Lifecycle & Chaos Management ---

apiRouter.post('/containers/:id/start', async (req: Request, res: Response) => {
  const id = req.params.id.toUpperCase() as ContainerId;
  const source = getSource(req);
  if (id !== 'A' && id !== 'B') {
    res.status(400).json({ error: 'Container must be "A" or "B".' });
    return;
  }

  const timeoutMs = req.body?.timeoutMs ? parseInt(req.body.timeoutMs, 10) : undefined;
  const result = await rolloutManager.startContainerAndWait(id, source, timeoutMs);

  if (!result.success) {
    res.status(500).json({ error: result.error || result.message });
    return;
  }

  res.json({ message: result.message, status: stateManager.getFullStatus() });
});

apiRouter.post('/containers/:id/stop', async (req: Request, res: Response) => {
  const id = req.params.id.toUpperCase() as ContainerId;
  const source = getSource(req);
  if (id !== 'A' && id !== 'B') {
    res.status(400).json({ error: 'Container must be "A" or "B".' });
    return;
  }

  const result = await rolloutManager.gracefulStop(id, source);
  if (!result.success) {
    res.status(400).json({ error: result.error || result.message });
    return;
  }

  res.json({ message: result.message, status: stateManager.getFullStatus() });
});

apiRouter.post('/containers/:id/chaos', async (req: Request, res: Response) => {
  const id = req.params.id.toUpperCase() as ContainerId;
  const { action, delayMs } = req.body;
  const source = getSource(req);

  if (id !== 'A' && id !== 'B') {
    res.status(400).json({ error: 'Container must be "A" or "B".' });
    return;
  }

  const container = stateManager.getContainer(id);
  const targetUrl = `http://${container.host}:${container.port}/chaos/${action}`;

  try {
    const backendRes = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delayMs }),
    });

    const data = await backendRes.json();
    eventLogger.log('CHAOS_ACTION_TRIGGERED', source, 'success', {
      container: id,
      action,
      delayMs,
      backendResponse: data,
    });

    res.json({ message: `Chaos action ${action} executed on Container ${id}`, data });
  } catch (err: any) {
    eventLogger.log('CHAOS_ACTION_FAILED', source, 'failed', { container: id, action }, err.message);
    res.status(500).json({ error: `Failed to trigger chaos on Container ${id}: ${err.message}` });
  }
});

// --- 4. Safe Rollout Engine ---

apiRouter.post('/rollout', async (req: Request, res: Response) => {
  const { from, to } = req.body;
  const source = getSource(req);
  const fromId = from?.toUpperCase() as ContainerId;
  const toId = to?.toUpperCase() as ContainerId;

  if ((fromId !== 'A' && fromId !== 'B') || (toId !== 'A' && toId !== 'B')) {
    res.status(400).json({ error: 'Both "from" and "to" must be "A" or "B".' });
    return;
  }

  if (fromId === toId) {
    res.status(400).json({ error: 'Source and target container cannot be the same.' });
    return;
  }

  // Rollout runs asynchronously, return immediate acknowledgement and stream updates via SSE
  rolloutManager.executeSafeRollout(fromId, toId, source).catch((err) => {
    console.error('Unhandled error in background rollout:', err);
  });

  res.json({
    message: `Safe rollout from Container ${fromId} to Container ${toId} initiated.`,
    rollout: stateManager.getRolloutState(),
  });
});

// --- 4.1 Direct MCP Tool Execution Endpoint ---
apiRouter.post('/mcp/execute', async (req: Request, res: Response) => {
  const { tool, params = {} } = req.body;

  try {
    if (tool === 'get_status') {
      eventLogger.log('MCP_GET_STATUS', 'mcp', 'success', {});
      res.json({ result: stateManager.getFullStatus() });
    } else if (tool === 'set_traffic_split') {
      const { splitA, splitB } = params;
      const result = stateManager.setTrafficSplit(splitA, splitB, 'mcp');
      if (!result.success) {
        res.status(400).json({ isError: true, error: result.error });
      } else {
        res.json({ result: `Split set to A=${splitA}%, B=${splitB}%`, effective: result.effectiveSplit });
      }
    } else if (tool === 'start_container') {
      const { container, timeoutMs } = params;
      const result = await rolloutManager.startContainerAndWait(container, 'mcp', timeoutMs);
      if (!result.success) {
        res.status(400).json({ isError: true, error: result.error });
      } else {
        res.json({ result: result.message });
      }
    } else if (tool === 'stop_container') {
      const { container } = params;
      const result = await rolloutManager.gracefulStop(container, 'mcp');
      if (!result.success) {
        res.status(400).json({ isError: true, error: result.error });
      } else {
        res.json({ result: result.message });
      }
    } else if (tool === 'safe_rollout') {
      const { from, to } = params;
      const result = await rolloutManager.executeSafeRollout(from, to, 'mcp');
      if (!result.success) {
        res.status(400).json({ isError: true, error: result.error });
      } else {
        res.json({ result: result.message });
      }
    } else if (tool === 'get_recent_logs') {
      const { limit = 30, source } = params;
      const logs = eventLogger.getLogs(limit, source === 'all' ? undefined : source);
      res.json({ result: logs });
    } else {
      res.status(400).json({ error: `Unknown MCP tool: ${tool}` });
    }
  } catch (err: any) {
    res.status(500).json({ isError: true, error: err.message });
  }
});

// --- 5. Event Logs ---

apiRouter.get('/logs', (req: Request, res: Response) => {
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
  const source = req.query.source as any;
  res.json({ logs: eventLogger.getLogs(limit, source) });
});

// --- 6. Traffic Generator Controls ---

apiRouter.get('/traffic-generator', (req: Request, res: Response) => {
  res.json(trafficGenerator.getStats());
});

apiRouter.post('/traffic-generator/start', (req: Request, res: Response) => {
  const rpm = req.body?.rpm ? parseInt(req.body.rpm, 10) : undefined;
  const stats = trafficGenerator.start(rpm, 'dashboard');
  res.json({ message: 'Traffic generator started', stats });
});

apiRouter.post('/traffic-generator/stop', (req: Request, res: Response) => {
  const stats = trafficGenerator.stop('dashboard');
  res.json({ message: 'Traffic generator stopped', stats });
});

apiRouter.post('/traffic-generator/rpm', (req: Request, res: Response) => {
  const rpm = parseInt(req.body?.rpm, 10);
  if (isNaN(rpm) || rpm <= 0) {
    res.status(400).json({ error: 'rpm must be a positive number' });
    return;
  }
  const stats = trafficGenerator.setRpm(rpm, 'dashboard');
  res.json({ message: `Traffic rate set to ${rpm} RPM`, stats });
});

apiRouter.post('/traffic-generator/reset', (req: Request, res: Response) => {
  trafficGenerator.resetStats();
  res.json({ message: 'Traffic stats reset', stats: trafficGenerator.getStats() });
});

// --- 7. Server-Sent Events (SSE) Live Feed ---

apiRouter.get('/events', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // 1. Send initial state snapshot
  const initialData = {
    type: 'SNAPSHOT',
    status: stateManager.getFullStatus(),
    trafficGen: trafficGenerator.getStats(),
    logs: eventLogger.getLogs(30),
  };
  res.write(`data: ${JSON.stringify(initialData)}\n\n`);

  // 2. Subscribe to new event logs
  const unsubscribe = eventLogger.subscribe((event: EventLog) => {
    const message = {
      type: 'EVENT',
      event,
      status: stateManager.getFullStatus(),
      trafficGen: trafficGenerator.getStats(),
    };
    res.write(`data: ${JSON.stringify(message)}\n\n`);
  });

  // 3. Heartbeat & periodic status push every 1000ms
  const heartbeatInterval = setInterval(() => {
    const pulse = {
      type: 'TICK',
      status: stateManager.getFullStatus(),
      trafficGen: trafficGenerator.getStats(),
    };
    res.write(`data: ${JSON.stringify(pulse)}\n\n`);
  }, 1000);

  req.on('close', () => {
    clearInterval(heartbeatInterval);
    unsubscribe();
  });
});
