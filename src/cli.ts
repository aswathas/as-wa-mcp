#!/usr/bin/env node
import path from 'node:path';
import qrcode from 'qrcode-terminal';
import { defaultAuthDir, isRegistered, liveRuntime, readMe, STORE_FILE } from './auth.js';
import { baileysFactory } from './baileys.js';
import { WaClient } from './client.js';
import { WaError, fail, notPairedError, ok } from './errors.js';
import type { Envelope } from './errors.js';
import { jidToNumber, normalizeJid } from './jid.js';
import { ChatStore } from './store.js';

const USAGE = `wa-mcp CLI
  pair [--phone <number>]              link WhatsApp (QR in terminal, or pairing code with --phone)
  status                               paired | pairing | not_paired (+ live server info)
  send <number> <text> [--media <path>] [--caption <text>] [--force]
  sync [seconds]                       connect briefly to refresh the local chat/message cache
  chats [limit]                        recent chats (from local cache)
  messages <chat> [n]                  recent messages in a chat (from local cache)
`;

const log = (msg: string): void => {
  process.stderr.write(`${msg}\n`);
};

function print(env: Envelope<unknown>): void {
  process.stdout.write(`${JSON.stringify(env, null, 2)}\n`);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw new WaError('INVALID_ARGUMENT', `${name} needs a value`);
  args.splice(i, 2);
  return v;
}

function boolFlag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}

function positiveInt(v: string | undefined, def: number, label: string): number {
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new WaError('INVALID_ARGUMENT', `${label} must be a positive integer`);
  return n;
}

function makeClient(authDir: string, store = new ChatStore(path.join(authDir, STORE_FILE))): WaClient {
  return new WaClient({ authDir, factory: baileysFactory, store, log: (m) => log(`[wa-mcp] ${m}`) });
}

function refuseIfServerLive(authDir: string, force: boolean): void {
  const live = liveRuntime(authDir);
  if (live && !force) {
    throw new WaError(
      'NOT_CONNECTED',
      `The MCP server (pid ${live.pid}) already holds this WhatsApp session; a second connection would kick it off. Use the MCP tools, stop the server, or pass --force.`,
    );
  }
}

function cmdStatus(authDir: string): Envelope<unknown> {
  const registered = isRegistered(authDir);
  const live = liveRuntime(authDir);
  const me = registered ? readMe(authDir) : undefined;
  const data: Record<string, unknown> = {
    status: registered ? 'paired' : 'not_paired',
    connected: live?.connected ?? false,
    me: me ? { number: jidToNumber(me.id) ?? null, name: me.name ?? null } : null,
    server: live
      ? {
          pid: live.pid,
          uptime_s: Math.max(0, Math.round((Date.now() - Date.parse(live.startedAt)) / 1000)),
          last_reconnect: live.lastReconnect,
        }
      : null,
    auth_dir: authDir,
  };
  if (!registered) data['hint'] = 'not paired, run: node dist/cli.js pair';
  return ok(data);
}

async function cmdPair(authDir: string, args: string[]): Promise<Envelope<unknown>> {
  const phone = flag(args, '--phone');
  if (isRegistered(authDir)) {
    return ok({ status: 'paired', message: 'Already paired. Delete the auth/ folder to re-pair.' });
  }
  refuseIfServerLive(authDir, false);
  const client = makeClient(authDir);
  client.onQr((qr) => {
    log('\nScan this QR in WhatsApp > Settings > Linked devices > Link a device:\n');
    qrcode.generate(qr, { small: true }, (art) => log(art));
  });
  client.onPairingCode((code) => {
    log(`\nPairing code: ${code}`);
    log('On your phone: WhatsApp > Settings > Linked devices > Link a device > Link with phone number instead.\n');
  });
  try {
    await client.pair(phone ? { phone } : {});
    const me = readMe(authDir);
    return ok({ status: 'paired', me: me ? { number: jidToNumber(me.id) ?? null, name: me.name ?? null } : null });
  } finally {
    await client.stop();
  }
}

async function cmdSend(authDir: string, args: string[]): Promise<Envelope<unknown>> {
  const force = boolFlag(args, '--force');
  const media = flag(args, '--media');
  const caption = flag(args, '--caption');
  const [to, ...rest] = args;
  const text = rest.join(' ');
  if (!to || (!text && !media)) throw new WaError('INVALID_ARGUMENT', 'usage: send <number> <text> [--media <path>] [--caption <text>]');
  if (!isRegistered(authDir)) throw notPairedError();
  refuseIfServerLive(authDir, force);
  const client = makeClient(authDir);
  try {
    await client.start();
    const input: { text?: string; mediaPath?: string; caption?: string } = {};
    if (text) input.text = text;
    if (media) input.mediaPath = path.resolve(media);
    if (caption) input.caption = caption;
    return ok(await client.send(to, input));
  } finally {
    await client.stop();
  }
}

async function cmdSync(authDir: string, args: string[]): Promise<Envelope<unknown>> {
  const force = boolFlag(args, '--force');
  const seconds = positiveInt(args[0], 15, 'seconds');
  if (!isRegistered(authDir)) throw notPairedError();
  refuseIfServerLive(authDir, force);
  const store = new ChatStore(path.join(authDir, STORE_FILE));
  const client = makeClient(authDir, store);
  try {
    await client.start();
    await client.waitFor((s) => s.connected, 30_000, () => new WaError('NOT_CONNECTED', 'Could not connect to WhatsApp.'));
    await new Promise((r) => setTimeout(r, seconds * 1000));
    return ok({ synced: true, chats: store.listChats(1000).length });
  } finally {
    await client.stop();
  }
}

function cmdChats(authDir: string, args: string[]): Envelope<unknown> {
  if (!isRegistered(authDir)) throw notPairedError();
  return ok(new ChatStore(path.join(authDir, STORE_FILE)).listChats(positiveInt(args[0], 20, 'limit')));
}

function cmdMessages(authDir: string, args: string[]): Envelope<unknown> {
  if (!isRegistered(authDir)) throw notPairedError();
  const chat = args[0];
  if (!chat) throw new WaError('INVALID_ARGUMENT', 'usage: messages <chat> [n]');
  return ok(new ChatStore(path.join(authDir, STORE_FILE)).getMessages(normalizeJid(chat), positiveInt(args[1], 20, 'n')));
}

async function main(): Promise<number> {
  const [cmd, ...args] = process.argv.slice(2);
  const authDir = defaultAuthDir();
  try {
    let env: Envelope<unknown>;
    switch (cmd) {
      case 'status':
        env = cmdStatus(authDir);
        break;
      case 'pair':
        env = await cmdPair(authDir, args);
        break;
      case 'send':
        env = await cmdSend(authDir, args);
        break;
      case 'sync':
        env = await cmdSync(authDir, args);
        break;
      case 'chats':
        env = cmdChats(authDir, args);
        break;
      case 'messages':
        env = cmdMessages(authDir, args);
        break;
      default:
        process.stdout.write(USAGE);
        return cmd === undefined || cmd === 'help' || cmd === '--help' ? 0 : 1;
    }
    print(env);
    return 0;
  } catch (err) {
    print(fail(err));
    return 1;
  }
}

main().then((code) => process.exit(code));
