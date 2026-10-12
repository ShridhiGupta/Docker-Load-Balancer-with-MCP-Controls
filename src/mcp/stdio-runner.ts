// CRITICAL FOR STDIO MCP: stdout must strictly contain JSON-RPC messages only.
// Redirect console.log and console.info to stderr so logging doesn't corrupt the protocol stream.
console.log = (...args: any[]) => console.error(...args);
console.info = (...args: any[]) => console.error(...args);

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server.js';

async function runStdioServer() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);
  console.error('[MCP] Docker Load Balancer MCP Server running on stdio transport (Live Controller Bridge ACTIVE).');
}

runStdioServer().catch((err) => {
  console.error('[MCP Fatal] Server crashed:', err);
  process.exit(1);
});
