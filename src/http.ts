#!/usr/bin/env node
/**
 * HTTP transport for wa-mcp: one daemon owns the WhatsApp session, many MCP
 * clients share it.
 *
 * Why this exists: a Baileys session is one WhatsApp device link, and WhatsApp
 * allows one live connection per linked device. Over stdio every agent spawns
 * its own server, so only the first one holds the session and the rest fall
 * back to read-only. Here a single process holds the session and serves every
 * agent over http://127.0.0.1:<port>/mcp.
 *
 * The daemon exits once the last client disconnects, unless a live listener
 * keeps it alive (webhook mode) or --always-on is passed.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { defaultAuthDir, liveRuntime } from './auth.js';
import { baileysFactory } from './baileys.js';
import { WaClient } from './client.js';
import { createCodeModeServer } from './codemode.js';
import { openStore } from './sqlstore.js';
import { WebhookSink } from './webhook.js';

export const DEFAULT_PORT = 8765;
export const DEFAULT_IDLE_MS = 60_000;
const SWEEP_MS = 5_000;
/**
 * A session with no traffic for this long is treated as dead and dropped.
 * Bridges send a ping every 30 s, so 90 s means three missed beats.
 */
const DEFAULT_STALE_MS = 90_000;
export const PID_FILE = 'httpd.pid';

export interface HttpOptions {
  port: number;
  idleMs: number;
  staleMs: number;
  authDir: string;
  alwaysOn: boolean;
}

export function parseArgs(argv: string[]): HttpOptions {
  const opts: HttpOptions = {
    port: DEFAULT_PORT,
    idleMs: DEFAULT_IDLE_MS,
    staleMs: DEFAULT_STALE_MS,
    authDir: defaultAuthDir(),
    alwaysOn: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--port' && next !== undefined) {
      opts.port = Number(next);
      i++;
    } else if (arg === '--idle-ms' && next !== undefined) {
      opts.idleMs = Number(next);
      i++;
    } else if (arg === '--stale-ms' && next !== undefined) {
      opts.staleMs = Number(next);
      i++;
    } else if (arg === '--auth-dir' && next !== undefined) {
      opts.authDir = path.resolve(next);
      i++;
    } else if (arg === '--always-on') {
      opts.alwaysOn = true;
    }
  }
  if (!Number.isFinite(opts.port) || opts.port <= 0) opts.port = DEFAULT_PORT;
  if (!Number.isFinite(opts.idleMs) || opts.idleMs < 0) opts.idleMs = DEFAULT_IDLE_MS;
  if (!Number.isFinite(opts.staleMs) || opts.staleMs < 0) opts.staleMs = DEFAULT_STALE_MS;
  return opts;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  id: string | undefined;
  lastSeen: number;
}

const log = (msg: string): void => {
  process.stderr.write('[wa-mcp-http] ' + msg + String.fromCharCode(10));
};

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

function isInitialize(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  return (body as { method?: unknown }).method === 'initialize';
}

export async function startHttpServer(opts: HttpOptions): Promise<void> {
  const { authDir } = opts;
  // A live session holder means another server already owns the device link.
  const other = liveRuntime(authDir);
  if (other) {
    log('another server (pid ' + other.pid + ') holds this session; refusing to start');
    process.exit(1);
  }

  const client = new WaClient({
    authDir,
    factory: baileysFactory,
    store: openStore(authDir),
    log,
    publishRuntime: true,
    webhook: new WebhookSink({ log }),
  });

  const sessions = new Map<string, Session>();
  let idleSince: number | undefined;
  let closing = false;

  const shutdown = async (reason: string): Promise<void> => {
    if (closing) return;
    closing = true;
    log('stopping: ' + reason);
    for (const session of sessions.values()) {
      try {
        await session.transport.close();
        await session.server.close();
      } catch {
        /* best effort */
      }
    }
    sessions.clear();
    try {
      rmSync(path.join(authDir, PID_FILE), { force: true });
    } catch {
      /* best effort */
    }
    await client.stop().catch(() => undefined);
    process.exit(0);
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/health') {
      const body = JSON.stringify({ ok: true, pid: process.pid, sessions: sessions.size, authDir });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    void handleMcp(req, res);
  });

  async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId === 'string') {
      const existing = sessions.get(sessionId);
      if (existing) {
        existing.lastSeen = Date.now();
        await existing.transport.handleRequest(req, res);
        return;
      }
    }

    const body = await readBody(req);
    if (!isInitialize(body)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unknown session; send initialize first' }));
      return;
    }

    const server = createCodeModeServer(client, { authDir });
    let entry: Session | undefined;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id: string) => {
        if (!entry) return;
        entry.id = id;
        sessions.set(id, entry);
        idleSince = undefined;
        log('client connected: ' + id + ' (sessions ' + sessions.size + ')');
      },
    });
    entry = { transport, server, id: undefined, lastSeen: Date.now() };

    transport.onclose = () => {
      if (entry && entry.id) sessions.delete(entry.id);
      log('client disconnected' + (entry && entry.id ? ': ' + entry.id : '') + ' (sessions ' + sessions.size + ')');
    };

    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  await new Promise<void>((resolve) => {
    server.listen(opts.port, '127.0.0.1', () => {
      resolve();
    });
  });

  const address = server.address() as AddressInfo | null;
  const port = address ? address.port : opts.port;
  try {
    writeFileSync(path.join(authDir, PID_FILE), String(process.pid));
  } catch {
    /* best effort */
  }
  log('listening on http://127.0.0.1:' + port + '/mcp (pid ' + process.pid + ')');
  log('auth dir: ' + authDir);
  if (opts.alwaysOn) log('always-on: the daemon will not exit on idle');

  // The WhatsApp socket connects lazily on the first wa.* call, so the daemon
  // is ready for clients before WhatsApp is.
  client.start().catch((err: unknown) => log('start failed: ' + String(err)));

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastSeen > opts.staleMs) {
        log('dropping stale session ' + id);
        sessions.delete(id);
        void session.transport.close().catch(() => undefined);
      }
    }
    if (opts.alwaysOn) return;
    if (sessions.size > 0) {
      idleSince = undefined;
      return;
    }
    if (idleSince === undefined) {
      idleSince = now;
      return;
    }
    if (now - idleSince >= opts.idleMs) {
      clearInterval(sweep);
      void shutdown('idle for ' + opts.idleMs + 'ms with no clients');
    }
  }, SWEEP_MS);

  const stop = (): void => {
    clearInterval(sweep);
    void shutdown('signal');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.stdin.on('end', stop);
  process.stdin.on('close', stop);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (process.env['WA_MCP_WEBHOOK_URL']) {
    // A live webhook target needs the daemon up even with no clients.
    opts.alwaysOn = true;
  }
  await startHttpServer(opts);
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entry === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err: unknown) => {
    process.stderr.write('[wa-mcp-http] fatal: ' + String(err) + String.fromCharCode(10));
    process.exit(1);
  });
}
