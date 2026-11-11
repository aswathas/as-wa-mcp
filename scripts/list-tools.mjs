#!/usr/bin/env node
// Dev probe: spawn the built MCP server over stdio and list its tools.
// Usage: node scripts/list-tools.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(here, '..', 'dist', 'mcp.js')],
  env: { ...process.env },
});
const client = new Client({ name: 'list-tools-probe', version: '0' });
await client.connect(transport);
const { tools } = await client.listTools();
console.log(`tools: ${tools.length}`);
for (const t of tools) console.log(`- ${t.name}`);
await client.close();
