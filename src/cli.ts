#!/usr/bin/env node
import path from 'node:path';
import qrcode from 'qrcode-terminal';
import { defaultAuthDir, isRegistered, liveRuntime, readMe } from './auth.js';
import { baileysFactory } from './baileys.js';
import { WaClient } from './client.js';
import { WaError, fail, notPairedError, ok } from './errors.js';
import type { Envelope } from './errors.js';
import { jidToNumber, normalizeJid } from './jid.js';
import { createWaApi, runCode } from './codemode.js';
import { createFileApi } from './files.js';
import { WaitCoordinator } from './waits.js';
import { openStore } from './sqlstore.js';
import type { Store } from './store.js';
import { WebhookSink } from './webhook.js';

const USAGE = `wa-mcp CLI
  pair [--phone <number>]              link WhatsApp (QR in terminal, or pairing code with --phone)
  status                               paired | pairing | not_paired (+ live server info)
  send <number> <text> [--media <path>] [--caption <text>] [--reply-to <id>] [--force]
  sync [seconds]                       connect briefly to refresh the local chat/message cache
  chats [limit]                        recent chats (from local cache)
  messages <chat> [n]                  recent messages in a chat (from local cache)
  statuses [chat] [limit]               delivery/read receipts for messages you sent (local store)
  webhook                               inbound webhook configuration and delivery counters
  contacts <query> [limit]             search contacts by name or number
  search <query> [limit]               full-text search across cached messages
  chat <id>                            metadata for one chat
  last <chat>                          most recent message with a contact/group
  context <chat> <message_id> [before] [after]   messages around one id
  react <chat> <message_id> [emoji]    react to a message (default 👍)
  read <chat> [message_id]             mark a chat or message as read
  download <chat> <message_id> [dir]   download media from a recent message
  loc <to> <lat> <lng> [name] [address]          send a location pin
  sticker <to> <path.webp>             send a sticker
  vcard <to> <name> <phone> [email]    send a contact card
  group <chat>                         group metadata (subject, participants)
  edit <chat> <message_id> <text>      edit one of your own messages
  del <chat> <message_id> [--confirm]  revoke (delete for everyone) your message
  typing <chat> [state]                composing|paused|recording|available|unavailable
  all-contacts [limit]                 list every known contact
  new [since_ts] [limit] [chat]        messages since a timestamp (0 = cached window)
  wait [chat] [seconds]                block until a new message arrives (max 60 s)
  leave <chat> [--confirm]             leave a group
  participants <act> <chat> <phone...> [--confirm] act = add|remove|promote|demote
  invite <chat> [--reset]              group invite code + link (--reset revokes)
  group-set <chat> [--subject <s>] [--description <d>]   rename/redescribe a group
  create-group <subject> <phone...>    create a new group
  code "<js>" [--timeout ms]            run a code-mode snippet (wa.* helpers, wa.files, resumable waits)
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

function makeClient(authDir: string, store: Store = openStore(authDir)): WaClient {
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
  const replyTo = flag(args, '--reply-to');
  const [to, ...rest] = args;
  const text = rest.join(' ');
  if (!to || (!text && !media)) throw new WaError('INVALID_ARGUMENT', 'usage: send <number> <text> [--media <path>] [--caption <text>] [--reply-to <id>]');
  if (!isRegistered(authDir)) throw notPairedError();
  refuseIfServerLive(authDir, force);
  const client = makeClient(authDir);
  try {
    await client.start();
    const input: { text?: string; mediaPath?: string; caption?: string; replyTo?: string } = {};
    if (text) input.text = text;
    if (media) input.mediaPath = path.resolve(media);
    if (caption) input.caption = caption;
    if (replyTo) input.replyTo = replyTo;
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
  const store = openStore(authDir);
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
  return ok(localStore(authDir).listChats(positiveInt(args[0], 20, 'limit')));
}

function cmdMessages(authDir: string, args: string[]): Envelope<unknown> {
  return ok(localStore(authDir).getMessages(requireArg(args[0], 'chat'), positiveInt(args[1], 20, 'n')));
}

function cmdStatuses(authDir: string, args: string[]): Envelope<unknown> {
  const chat = args[0] ? normalizeJid(args[0]) : undefined;
  const limit = positiveInt(args[1] ?? '50', 50, 'limit');
  return ok(localStore(authDir).listReceipts(limit, chat));
}

function cmdWebhook(): Envelope<unknown> {
  const status = new WebhookSink().status();
  return ok({
    ...status,
    ...(status.enabled ? {} : { hint: 'set WA_MCP_WEBHOOK_URL to enable inbound push' }),
  });
}

function localStore(authDir: string): Store {
  if (!isRegistered(authDir)) throw notPairedError();
  return openStore(authDir);
}

function requireArg(value: string | undefined, label: string): string {
  if (!value) throw new WaError('INVALID_ARGUMENT', `missing ${label}`);
  return value;
}

async function withClient(authDir: string, force: boolean, fn: (c: WaClient) => Promise<unknown>): Promise<Envelope<unknown>> {
  if (!isRegistered(authDir)) throw notPairedError();
  refuseIfServerLive(authDir, force);
  const client = makeClient(authDir);
  try {
    await client.start();
    return ok(await fn(client));
  } finally {
    await client.stop();
  }
}

function cmdContacts(authDir: string, args: string[]): Envelope<unknown> {
  return ok(localStore(authDir).searchContacts(requireArg(args[0], 'query'), positiveInt(args[1], 20, 'limit')));
}

function cmdSearch(authDir: string, args: string[]): Envelope<unknown> {
  return ok(localStore(authDir).searchMessages(requireArg(args[0], 'query'), positiveInt(args[1], 20, 'limit')));
}

function cmdChat(authDir: string, args: string[]): Envelope<unknown> {
  const id = normalizeJid(requireArg(args[0], 'chat'));
  const info = localStore(authDir).getChatInfo(id);
  if (!info) throw new WaError('INVALID_ARGUMENT', `no cached chat ${id}`);
  return ok(info);
}

function cmdLast(authDir: string, args: string[]): Envelope<unknown> {
  const id = normalizeJid(requireArg(args[0], 'chat'));
  return ok(localStore(authDir).lastInteraction(id) ?? null);
}

function cmdContext(authDir: string, args: string[]): Envelope<unknown> {
  const id = normalizeJid(requireArg(args[0], 'chat'));
  const ctx = localStore(authDir).messageContext(
    id,
    requireArg(args[1], 'message_id'),
    positiveInt(args[2], 3, 'before'),
    positiveInt(args[3], 3, 'after'),
  );
  if (!ctx) throw new WaError('INVALID_ARGUMENT', 'message not found in the cache');
  return ok(ctx);
}

function cmdReact(authDir: string, args: string[]): Promise<Envelope<unknown>> {
  const chat = requireArg(args[0], 'chat');
  const messageId = requireArg(args[1], 'message_id');
  const emoji = args[2] ?? '👍';
  return withClient(authDir, false, (c) => c.react(chat, messageId, emoji));
}

function cmdRead(authDir: string, args: string[]): Promise<Envelope<unknown>> {
  const chat = requireArg(args[0], 'chat');
  return withClient(authDir, false, (c) => c.markRead(chat, args[1]));
}

function cmdDownload(authDir: string, args: string[]): Promise<Envelope<unknown>> {
  const chat = requireArg(args[0], 'chat');
  const messageId = requireArg(args[1], 'message_id');
  return withClient(authDir, false, (c) => c.downloadMedia(chat, messageId, args[2]));
}

function cmdLocation(authDir: string, args: string[]): Promise<Envelope<unknown>> {
  const to = requireArg(args[0], 'to');
  const lat = Number(requireArg(args[1], 'latitude'));
  const lng = Number(requireArg(args[2], 'longitude'));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new WaError('INVALID_ARGUMENT', 'latitude/longitude must be numbers');
  return withClient(authDir, false, (c) => c.sendLocation(to, lat, lng, args[3], args[4]));
}

function cmdSticker(authDir: string, args: string[]): Promise<Envelope<unknown>> {
  const to = requireArg(args[0], 'to');
  const file = requireArg(args[1], 'path');
  return withClient(authDir, false, (c) => c.sendSticker(to, path.resolve(file)));
}

function cmdVcard(authDir: string, args: string[]): Promise<Envelope<unknown>> {
  const to = requireArg(args[0], 'to');
  const name = requireArg(args[1], 'name');
  const phone = requireArg(args[2], 'phone');
  return withClient(authDir, false, (c) => c.sendContact(to, [{ name, phone, email: args[3] }]));
}

function cmdGroup(authDir: string, args: string[]): Promise<Envelope<unknown>> {
  const chat = requireArg(args[0], 'chat');
  return withClient(authDir, false, (c) => c.getGroupInfo(chat));
}

function cmdEdit(authDir: string, args: string[]): Promise<Envelope<unknown>> {
  const chat = requireArg(args[0], 'chat');
  const messageId = requireArg(args[1], 'message_id');
  const text = args.slice(2).join(' ');
  if (!text) throw new WaError('INVALID_ARGUMENT', 'usage: edit <chat> <message_id> <text>');
  return withClient(authDir, false, (c) => c.edit(chat, messageId, text));
}

function cmdDelete(authDir: string, args: string[]): Promise<Envelope<unknown>> {
  // The flag is read first so it can sit anywhere in the argument list.
  const confirmed = boolFlag(args, '--confirm');
  const chat = requireArg(args[0], 'chat');
  const messageId = requireArg(args[1], 'message_id');
  return withClient(authDir, false, (c) => c.remove(chat, messageId, confirmed));
}

function cmdTyping(authDir: string, args: string[]): Promise<Envelope<unknown>> {
  const chat = requireArg(args[0], 'chat');
  const state = (args[1] ?? 'composing') as 'composing' | 'paused' | 'recording' | 'available' | 'unavailable';
  return withClient(authDir, false, (c) => c.presence(chat, state));
}

function cmdAllContacts(authDir: string, args: string[]): Envelope<unknown> {
  return ok(localStore(authDir).listContacts(positiveInt(args[0], 100, 'limit')));
}

function cmdNew(authDir: string, args: string[]): Envelope<unknown> {
  const since = args[0] === undefined ? 0 : Number(args[0]);
  if (!Number.isFinite(since)) throw new WaError('INVALID_ARGUMENT', 'since_ts must be a number');
  return ok(
    localStore(authDir).messagesSince(
      since,
      positiveInt(args[1], 50, 'limit'),
      args[2] ? normalizeJid(args[2]) : undefined,
    ),
  );
}

function cmdWait(authDir: string, args: string[]): Promise<Envelope<unknown>> {
  const chat = args[0];
  const seconds = positiveInt(args[1], 30, 'seconds');
  if (seconds > 60) throw new WaError('INVALID_ARGUMENT', 'wait is capped at 60 seconds');
  return withClient(authDir, false, (c) =>
    c.waitForMessages({ timeoutMs: seconds * 1000, ...(chat ? { chat } : {}) }),
  );
}

function cmdLeave(authDir: string, args: string[]): Promise<Envelope<unknown>> {
  const confirmed = boolFlag(args, '--confirm');
  const chat = requireArg(args[0], 'chat');
  return withClient(authDir, false, (c) => c.leaveGroup(chat, confirmed));
}

function cmdParticipants(authDir: string, args: string[]): Promise<Envelope<unknown>> {
  const confirmed = boolFlag(args, '--confirm');
  const action = requireArg(args[0], 'action');
  if (!['add', 'remove', 'promote', 'demote'].includes(action)) {
    throw new WaError('INVALID_ARGUMENT', 'action must be add|remove|promote|demote');
  }
  const chat = requireArg(args[1], 'chat');
  const phones = args.slice(2);
  if (phones.length === 0) throw new WaError('INVALID_ARGUMENT', 'usage: participants <action> <chat> <phone...>');
  return withClient(authDir, false, (c) =>
    c.groupParticipants(chat, action as 'add' | 'remove' | 'promote' | 'demote', phones, confirmed),
  );
}

function cmdInvite(authDir: string, args: string[]): Promise<Envelope<unknown>> {
  const reset = boolFlag(args, '--reset');
  const chat = requireArg(args[0], 'chat');
  return withClient(authDir, false, (c) => c.getGroupInvite(chat, reset));
}

function cmdGroupSet(authDir: string, args: string[]): Promise<Envelope<unknown>> {
  const subject = flag(args, '--subject');
  const description = flag(args, '--description');
  const chat = requireArg(args[0], 'chat');
  return withClient(authDir, false, (c) =>
    c.updateGroup(chat, { ...(subject ? { subject } : {}), ...(description ? { description } : {}) }),
  );
}

function cmdCreateGroup(authDir: string, args: string[]): Promise<Envelope<unknown>> {
  const subject = requireArg(args[0], 'subject');
  const phones = args.slice(1);
  if (phones.length === 0) throw new WaError('INVALID_ARGUMENT', 'usage: create-group <subject> <phone...>');
  return withClient(authDir, false, (c) => c.createGroup(subject, phones));
}

async function cmdCode(authDir: string, args: string[]): Promise<Envelope<unknown>> {
  const force = boolFlag(args, '--force');
  const timeoutRaw = flag(args, '--timeout');
  const code = args.join(' ').trim();
  if (!code) throw new WaError('INVALID_ARGUMENT', 'usage: code "<js>" [--timeout ms]');
  if (isRegistered(authDir)) refuseIfServerLive(authDir, force);
  const client = makeClient(authDir);
  try {
    const files = createFileApi(authDir);
    const waits = new WaitCoordinator(client);
    return await runCode(
      code,
      createWaApi(client),
      timeoutRaw ? positiveInt(timeoutRaw, 5000, '--timeout') : 5000,
      { files, waits },
    );
  } finally {
    await client.stop();
  }
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
      case 'statuses':
        env = cmdStatuses(authDir, args);
        break;
      case 'webhook':
        env = cmdWebhook();
        break;
      case 'contacts':
        env = cmdContacts(authDir, args);
        break;
      case 'search':
        env = cmdSearch(authDir, args);
        break;
      case 'chat':
        env = cmdChat(authDir, args);
        break;
      case 'last':
        env = cmdLast(authDir, args);
        break;
      case 'context':
        env = cmdContext(authDir, args);
        break;
      case 'react':
        env = await cmdReact(authDir, args);
        break;
      case 'read':
        env = await cmdRead(authDir, args);
        break;
      case 'download':
        env = await cmdDownload(authDir, args);
        break;
      case 'loc':
        env = await cmdLocation(authDir, args);
        break;
      case 'sticker':
        env = await cmdSticker(authDir, args);
        break;
      case 'vcard':
        env = await cmdVcard(authDir, args);
        break;
      case 'group':
        env = await cmdGroup(authDir, args);
        break;
      case 'edit':
        env = await cmdEdit(authDir, args);
        break;
      case 'del':
        env = await cmdDelete(authDir, args);
        break;
      case 'typing':
        env = await cmdTyping(authDir, args);
        break;
      case 'all-contacts':
        env = cmdAllContacts(authDir, args);
        break;
      case 'new':
        env = cmdNew(authDir, args);
        break;
      case 'wait':
        env = await cmdWait(authDir, args);
        break;
      case 'leave':
        env = await cmdLeave(authDir, args);
        break;
      case 'participants':
        env = await cmdParticipants(authDir, args);
        break;
      case 'invite':
        env = await cmdInvite(authDir, args);
        break;
      case 'group-set':
        env = await cmdGroupSet(authDir, args);
        break;
      case 'code':
        env = await cmdCode(authDir, args);
        break;
      case 'create-group':
        env = await cmdCreateGroup(authDir, args);
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
