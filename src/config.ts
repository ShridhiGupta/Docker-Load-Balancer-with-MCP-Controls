import dotenv from 'dotenv';
import fs from 'fs';
dotenv.config();

// Auto-detect whether running inside Docker container or on the host OS
const isInsideDocker = fs.existsSync('/.dockerenv');

export const CONFIG = {
  // Controller HTTP Port (Serves Ingress, Dashboard, API, SSE)
  PORT: parseInt(process.env.PORT || '8000', 10),

  // Backend Container A configuration
  APP_A: {
    id: 'A' as const,
    name: 'Container A',
    dockerContainerName: process.env.APP_A_DOCKER_NAME || 'botpresso-app-a',
    host: isInsideDocker ? (process.env.APP_A_HOST || 'botpresso-app-a') : 'localhost',
    port: isInsideDocker ? parseInt(process.env.APP_A_PORT || '8080', 10) : 8001,
  },

  // Backend Container B configuration
  APP_B: {
    id: 'B' as const,
    name: 'Container B',
    dockerContainerName: process.env.APP_B_DOCKER_NAME || 'botpresso-app-b',
    host: isInsideDocker ? (process.env.APP_B_HOST || 'botpresso-app-b') : 'localhost',
    port: isInsideDocker ? parseInt(process.env.APP_B_PORT || '8080', 10) : 8002,
  },

  // Operational Timeouts & Intervals
  HEALTH_CHECK_INTERVAL_MS: parseInt(process.env.HEALTH_CHECK_INTERVAL_MS || '1000', 10),
  HEALTH_CHECK_TIMEOUT_MS: parseInt(process.env.HEALTH_CHECK_TIMEOUT_MS || '1500', 10),
  DRAIN_TIMEOUT_MS: parseInt(process.env.DRAIN_TIMEOUT_MS || '5000', 10),
  ROLLOUT_HEALTH_TIMEOUT_MS: parseInt(process.env.ROLLOUT_HEALTH_TIMEOUT_MS || '12000', 10),
  PROXY_TIMEOUT_MS: parseInt(process.env.PROXY_TIMEOUT_MS || '10000', 10),

  // Docker Engine Socket (Auto-detects /var/run/docker.sock or Windows named pipe)
  DOCKER_SOCKET_PATH: process.env.DOCKER_SOCKET_PATH || (process.platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock'),

  // Max events stored in memory
  MAX_EVENT_LOGS: 200,
};
