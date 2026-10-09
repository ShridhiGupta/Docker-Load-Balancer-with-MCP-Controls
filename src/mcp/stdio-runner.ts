import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server.js';
import { healthChecker } from '../core/health-checker.js';

async function runStdioServer() {
  // Start background health checking
  healthChecker.start();

  const server = createMcpServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);
  console.error('[MCP] Docker Load Balancer MCP Server running on stdio transport.');
}

runStdioServer().catch((err) => {
  console.error('[MCP Fatal] Server crashed:', err);
  process.exit(1);
});
