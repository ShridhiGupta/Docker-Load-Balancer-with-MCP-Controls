import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { CONFIG } from './config.js';
import { apiRouter } from './api/router.js';
import { loadBalancer } from './core/load-balancer.js';
import { healthChecker } from './core/health-checker.js';
import { dockerService } from './core/docker-service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Serve Static Frontend Dashboard
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

// Mount REST API
app.use('/api', apiRouter);

// Service Ingress Proxy Endpoints (All application requests flow through Load Balancer)
app.all(['/service', '/service/*', '/api/data', '/ingress'], (req: Request, res: Response) => {
  loadBalancer.handleRequest(req, res);
});

// Root route: Serve dashboard HTML if browser request, otherwise proxy
app.get('/', (req: Request, res: Response) => {
  const accept = req.headers.accept || '';
  if (accept.includes('text/html')) {
    res.sendFile(path.join(publicDir, 'index.html'));
  } else {
    loadBalancer.handleRequest(req, res);
  }
});

// Fallback proxy for all other unspecified HTTP routes
app.all('*', (req: Request, res: Response) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/events')) {
    res.status(404).json({ error: `Not found: ${req.path}` });
  } else {
    loadBalancer.handleRequest(req, res);
  }
});

// Initialize and start services
async function bootstrap() {
  console.log('================================================================');
  console.log('  🚀 Botpresso Production Load Balancer with MCP Controls');
  console.log('================================================================');

  // Verify Docker Daemon connectivity
  const dockerAlive = await dockerService.ping();
  console.log(`[Docker] Engine Socket status: ${dockerAlive ? 'ONLINE (Connected)' : 'SIMULATION MODE'}`);

  // Start background health monitor
  healthChecker.start();

  // Start HTTP Server
  app.listen(CONFIG.PORT, '0.0.0.0', () => {
    console.log(`[Controller] HTTP Server running on: http://localhost:${CONFIG.PORT}`);
    console.log(`[Dashboard] Live Dashboard UI at:     http://localhost:${CONFIG.PORT}`);
    console.log(`[Service]   Ingress Traffic Proxy at: http://localhost:${CONFIG.PORT}/service`);
    console.log(`[SSE Feed]  Live Events Stream at:    http://localhost:${CONFIG.PORT}/api/events`);
    console.log('================================================================');
  });
}

bootstrap().catch((err) => {
  console.error('[Fatal Error] Application failed to start:', err);
  process.exit(1);
});
