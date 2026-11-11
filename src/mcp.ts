#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { defaultAuthDir } from './auth.js';
import { baileysFactory } from './baileys.js';
import { WaClient } from './client.js';
import { createServer } from './server.js';
import { openStore } from './sqlstore.js';
import { WebhookSink } from './webhook.js';

// stdout belongs to the MCP protocol; everything diagnostic goes to stderr.
const log = (msg: string): void => {
  process.stderr.write(`[wa-mcp] ${msg}\n`);
};

// One bad message / rejected promise must never take the server down.
process.on('uncaughtException', (err) => log(`uncaughtException: ${err.stack ?? err.message}`));
process.on('unhandledRejection', (reason) => log(`unhandledRejection: ${String(reason)}`));

async function main(): Promise<void> {
  const authDir = defaultAuthDir();
  const client = new WaClient({
    authDir,
    factory: baileysFactory,
    store: openStore(authDir),
    log,
    publishRuntime: true,
    webhook: new WebhookSink({ log }),
  });

  const server = createServer(client);
  await server.connect(new StdioServerTransport());

  // Never block tool availability on WhatsApp: connect in the background.
  client.start().catch((err: unknown) => log(`start failed: ${String(err)}`));

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    void client.stop().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
}

main().catch((err: unknown) => {
  log(`fatal: ${String(err)}`);
  process.exit(1);
});
