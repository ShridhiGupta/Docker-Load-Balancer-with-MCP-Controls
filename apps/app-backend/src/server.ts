import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import os from 'os';
import crypto from 'crypto';

const app = express();
app.use(cors());
app.use(express.json());

// Configuration from environment variables
const PORT = parseInt(process.env.PORT || '8080', 10);
const CONTAINER_NAME = process.env.CONTAINER_NAME || 'A';
const INSTANCE_ID = process.env.INSTANCE_ID || crypto.randomBytes(4).toString('hex');
const HOSTNAME = os.hostname();
const START_TIME = Date.now();

// State
let isHealthy = true;
let defaultDelayMs = parseInt(process.env.DEFAULT_DELAY_MS || '0', 10);
let inFlightRequests = 0;
let totalRequestsServed = 0;

// Request tracking middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  // Exclude health/chaos endpoints from in-flight app metrics
  if (req.path.startsWith('/health') || req.path.startsWith('/ready') || req.path.startsWith('/chaos')) {
    return next();
  }

  inFlightRequests++;
  totalRequestsServed++;
  const reqStart = Date.now();

  res.on('finish', () => {
    inFlightRequests = Math.max(0, inFlightRequests - 1);
  });

  res.on('close', () => {
    // In case connection terminates abruptly
    inFlightRequests = Math.max(0, inFlightRequests - 1);
  });

  next();
});

// Helper for delay
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Main Application Service Endpoint
 * Each response clearly identifies which container handled it, timing, and in-flight count.
 */
app.all(['/', '/service', '/api/data'], async (req: Request, res: Response) => {
  const reqId = (req.headers['x-request-id'] as string) || `req_${crypto.randomBytes(4).toString('hex')}`;
  const startMs = Date.now();

  // Determine delay: query param ?delay=3000 or header X-Delay: 3000 or global default
  let delay = defaultDelayMs;
  if (req.query.delay) {
    const qDelay = parseInt(req.query.delay as string, 10);
    if (!isNaN(qDelay)) delay = qDelay;
  } else if (req.headers['x-delay']) {
    const hDelay = parseInt(req.headers['x-delay'] as string, 10);
    if (!isNaN(hDelay)) delay = hDelay;
  }

  if (delay > 0) {
    await sleep(delay);
  }

  const durationMs = Date.now() - startMs;

  res.setHeader('X-Handled-By', `Container ${CONTAINER_NAME}`);
  res.setHeader('X-Container-Id', INSTANCE_ID);
  res.setHeader('X-Hostname', HOSTNAME);
  res.setHeader('X-In-Flight', inFlightRequests.toString());
  res.setHeader('X-Response-Time', `${durationMs}ms`);

  res.status(200).json({
    status: 'success',
    container: CONTAINER_NAME,
    message: `Response from Container ${CONTAINER_NAME}`,
    instanceId: INSTANCE_ID,
    hostname: HOSTNAME,
    requestId: reqId,
    timestamp: new Date().toISOString(),
    inFlightAtStart: inFlightRequests,
    durationMs,
    totalServed: totalRequestsServed,
    query: req.query,
  });
});

/**
 * Readiness & Health Check Endpoints
 */
app.get(['/health', '/ready', '/healthz'], (req: Request, res: Response) => {
  const uptimeSeconds = Math.floor((Date.now() - START_TIME) / 1000);

  if (isHealthy) {
    res.status(200).json({
      status: 'healthy',
      container: CONTAINER_NAME,
      instanceId: INSTANCE_ID,
      hostname: HOSTNAME,
      uptimeSeconds,
      inFlightRequests,
      totalRequestsServed,
      timestamp: new Date().toISOString(),
    });
  } else {
    res.status(503).json({
      status: 'unhealthy',
      container: CONTAINER_NAME,
      instanceId: INSTANCE_ID,
      hostname: HOSTNAME,
      reason: 'Container has been explicitly marked UNHEALTHY for chaos / rollout testing',
      uptimeSeconds,
      inFlightRequests,
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * Chaos Engineering Endpoints (used to demo failed rollouts and draining)
 */
app.post('/chaos/unhealthy', (req: Request, res: Response) => {
  isHealthy = false;
  res.status(200).json({
    message: `Container ${CONTAINER_NAME} forced into UNHEALTHY state`,
    container: CONTAINER_NAME,
    isHealthy: false,
    timestamp: new Date().toISOString(),
  });
});

app.post('/chaos/healthy', (req: Request, res: Response) => {
  isHealthy = true;
  res.status(200).json({
    message: `Container ${CONTAINER_NAME} restored to HEALTHY state`,
    container: CONTAINER_NAME,
    isHealthy: true,
    timestamp: new Date().toISOString(),
  });
});

app.post('/chaos/toggle', (req: Request, res: Response) => {
  isHealthy = !isHealthy;
  res.status(200).json({
    message: `Container ${CONTAINER_NAME} health toggled to ${isHealthy ? 'HEALTHY' : 'UNHEALTHY'}`,
    container: CONTAINER_NAME,
    isHealthy,
    timestamp: new Date().toISOString(),
  });
});

app.post('/chaos/delay', (req: Request, res: Response) => {
  const { delayMs } = req.body || {};
  if (typeof delayMs === 'number' && delayMs >= 0) {
    defaultDelayMs = delayMs;
    res.status(200).json({
      message: `Container ${CONTAINER_NAME} default delay set to ${delayMs}ms`,
      container: CONTAINER_NAME,
      defaultDelayMs,
    });
  } else {
    res.status(400).json({
      error: 'Invalid delayMs parameter. Must be a non-negative number.',
    });
  }
});

app.get('/chaos/status', (req: Request, res: Response) => {
  res.status(200).json({
    container: CONTAINER_NAME,
    isHealthy,
    defaultDelayMs,
    inFlightRequests,
    totalRequestsServed,
    uptimeSeconds: Math.floor((Date.now() - START_TIME) / 1000),
  });
});

// Start Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Container ${CONTAINER_NAME}] Service started on port ${PORT} (Instance ID: ${INSTANCE_ID}, Hostname: ${HOSTNAME})`);
});
