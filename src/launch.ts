#!/usr/bin/env node
/**
 * Per-agent bridge: stdio on one side, the wa-mcp HTTP daemon on the other.
 *
 * Agents keep the stdio MCP shape they already have. This process makes sure
 * the daemon is running, then forwards every tool call over http. The agent
 * never learns that the WhatsApp session moved into a shared daemon, and the
 * daemon still exits when the last agent closes.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { DEFAULT_PORT } from './http.js';
import { defaultAuthDir, liveRuntime } from './auth.js';

const log = (msg: string): void => {
  process.stderr.write('[wa-mcp-launch] ' + msg + String.fromCharCode(10));
};

const port = Number(process.env['WA_MCP_HTTP_PORT'] ?? DEFAULT_PORT);
/** Keeps the daemon session alive and marks it as live traffic. */
const heartbeatMs = 30_000;
const base = 'http://127.0.0.1:' + (Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function healthy(): Promise<boolean> {
  try {
    const res = await fetch(base + '/health', { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureDaemon(): Promise<void> {
  if (await healthy()) return;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const args = [path.join(here, 'http.js'), '--port', String(new URL(base).port)];
  const authDir = process.env['WA_MCP_AUTH_DIR'];
  if (authDir) args.push('--auth-dir', authDir);
  log('daemon not running, starting it');
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    if (await healthy()) {
      log('daemon is up');
      return;
    }
  }
  const holder = sessionHolder(authDir ?? defaultAuthDir());
  if (holder !== undefined) {
    throw new Error(
      'another wa-mcp server (pid ' + holder + ') holds this WhatsApp session, ' +
        'so the shared daemon cannot start. Stop that server first (wa-mcp stop, ' +
        'or close the agent that runs it).',
    );
  }
  throw new Error('wa-mcp daemon did not become healthy on ' + base);
}

/**
 * A stdio server holding the session blocks the daemon from starting, because
 * WhatsApp allows one live connection per linked device. Say so plainly
 * instead of a bare health-check timeout.
 */
function sessionHolder(authDir: string): number | undefined {
  const holder = liveRuntime(authDir);
  return holder ? holder.pid : undefined;
}

async function main(): Promise<void> {
  await ensureDaemon();

  const transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'));
  const client = new Client({ name: 'wa-mcp-launch', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);

  const server = new Server(
    { name: 'wa-mcp-launch', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => client.listTools());
  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    client.callTool(req.params as Parameters<typeof client.callTool>[0]),
  );
  await server.connect(new StdioServerTransport());
  log('bridge ready on ' + base);

  // The daemon drops a session that stops sending traffic, so a bridge that
  // dies without a clean shutdown still gets cleaned up.
  const heartbeat = setInterval(() => {
    void client.ping().catch(() => undefined);
  }, heartbeatMs);
  heartbeat.unref?.();

  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    clearInterval(heartbeat);
    void transport
      .terminateSession()
      .catch(() => undefined)
      .then(() => client.close())
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
  process.on('exit', () => clearInterval(heartbeat));
  process.stdin.on('end', close);
  process.stdin.on('close', close);
}

main().catch((err: unknown) => {
  process.stderr.write('[wa-mcp-launch] fatal: ' + String(err) + String.fromCharCode(10));
  process.exit(1);
});
