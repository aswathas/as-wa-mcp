import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WaClient } from './client.js';
import { createTools } from './tools.js';

/** Build the MCP server; every tool returns a JSON envelope as text content. */
export function createServer(client: WaClient): McpServer {
  const server = new McpServer({ name: 'wa-mcp', version: '1.0.0' });
  for (const tool of createTools(client)) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.shape }, async (args: Record<string, unknown>) => {
      const envelope = await tool.run(args ?? {});
      return { content: [{ type: 'text' as const, text: JSON.stringify(envelope) }], isError: !envelope.ok };
    });
  }
  return server;
}
