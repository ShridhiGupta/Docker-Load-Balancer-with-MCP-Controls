import http from 'http';
import { Request, Response } from 'express';
import crypto from 'crypto';
import { ContainerId } from '../types/state.js';
import { stateManager } from './state-manager.js';
import { CONFIG } from '../config.js';

class LoadBalancer {
  private requestCounter = 0;

  /**
   * Selects a target container based on current effective split percentages.
   */
  public selectTarget(): ContainerId | null {
    const { effectiveA, effectiveB } = stateManager.getEffectiveSplit();

    if (effectiveA === 0 && effectiveB === 0) {
      return null;
    }

    if (effectiveA > 0 && effectiveB === 0) {
      return 'A';
    }

    if (effectiveA === 0 && effectiveB > 0) {
      return 'B';
    }

    // Weighted selection (e.g. 70/30)
    const random = Math.random() * 100;
    return random < effectiveA ? 'A' : 'B';
  }

  /**
   * Core reverse proxy handler forwarding client request to selected backend.
   */
  public async handleRequest(req: Request, res: Response): Promise<void> {
    const startMs = Date.now();
    const reqId = (req.headers['x-request-id'] as string) || `req_${crypto.randomBytes(4).toString('hex')}`;
    const target = this.selectTarget();

    if (!target) {
      const durationMs = Date.now() - startMs;
      stateManager.recordRequest(null, false, durationMs);

      res.status(503).json({
        error: 'Service Unavailable',
        message: 'No healthy backend containers are available to serve incoming traffic.',
        configuredSplit: stateManager.getConfiguredSplit(),
        effectiveSplit: stateManager.getEffectiveSplit(),
        containers: {
          A: { status: stateManager.getContainer('A').status, isHealthy: stateManager.getContainer('A').isHealthy },
          B: { status: stateManager.getContainer('B').status, isHealthy: stateManager.getContainer('B').isHealthy },
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const container = stateManager.getContainer(target);
    stateManager.incrementInFlight(target);

    const targetUrl = new URL(req.url, `http://${container.host}:${container.port}`);

    const proxyHeaders = {
      ...req.headers,
      host: `${container.host}:${container.port}`,
      'x-request-id': reqId,
      'x-forwarded-for': req.ip || req.socket.remoteAddress || '127.0.0.1',
      'x-forwarded-proto': req.protocol,
      'x-load-balancer': 'Botpresso-Controller-v1',
    };

    const proxyReq = http.request(
      {
        hostname: container.host,
        port: container.port,
        path: targetUrl.pathname + targetUrl.search,
        method: req.method,
        headers: proxyHeaders,
        timeout: CONFIG.PROXY_TIMEOUT_MS,
      },
      (proxyRes) => {
        const durationMs = Date.now() - startMs;
        const isSuccess = (proxyRes.statusCode || 500) < 400;

        // Copy proxy response headers
        res.status(proxyRes.statusCode || 200);
        for (const [key, value] of Object.entries(proxyRes.headers)) {
          if (value !== undefined) {
            res.setHeader(key, value);
          }
        }

        // Load balancer observability headers
        res.setHeader('X-Routed-To', `Container ${target}`);
        res.setHeader('X-Proxy-Latency-Ms', `${durationMs}ms`);

        proxyRes.pipe(res);

        res.on('finish', () => {
          stateManager.decrementInFlight(target);
          stateManager.recordRequest(target, isSuccess, durationMs);
        });
      }
    );

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      const durationMs = Date.now() - startMs;
      stateManager.decrementInFlight(target);
      stateManager.recordRequest(target, false, durationMs);

      if (!res.headersSent) {
        res.status(504).json({
          error: 'Gateway Timeout',
          message: `Backend Container ${target} did not respond within ${CONFIG.PROXY_TIMEOUT_MS}ms.`,
          container: target,
          timestamp: new Date().toISOString(),
        });
      }
    });

    proxyReq.on('error', (err: any) => {
      const durationMs = Date.now() - startMs;
      stateManager.decrementInFlight(target);
      stateManager.recordRequest(target, false, durationMs);

      if (!res.headersSent) {
        res.status(502).json({
          error: 'Bad Gateway',
          message: `Failed to connect to backend Container ${target}: ${err.message}`,
          container: target,
          timestamp: new Date().toISOString(),
        });
      }
    });

    // Handle client disconnect
    req.on('aborted', () => {
      proxyReq.destroy();
      stateManager.decrementInFlight(target);
    });

    // Handle request body and ensure proxyReq is properly ended
    if (req.method === 'GET' || req.method === 'HEAD') {
      proxyReq.end();
    } else if (req.body !== undefined && req.body !== null) {
      if (Buffer.isBuffer(req.body)) {
        proxyReq.end(req.body);
      } else if (typeof req.body === 'object' && Object.keys(req.body).length > 0) {
        proxyReq.end(JSON.stringify(req.body));
      } else if (typeof req.body === 'string' && req.body.length > 0) {
        proxyReq.end(req.body);
      } else {
        req.pipe(proxyReq);
      }
    } else {
      req.pipe(proxyReq);
    }
  }
}

export const loadBalancer = new LoadBalancer();
