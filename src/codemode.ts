#!/usr/bin/env node
/**
 * Code mode - the second MCP entry point for wa-mcp.
 *
 * The 30-tool server costs about 3.8k tokens of tool schema in every session
 * that loads it. This server exposes exactly ONE tool (wa_code) that takes
 * code, so the resident schema is about 200 tokens and the calling agent can
 * filter and aggregate server-side instead of pulling raw messages through
 * its context.
 *
 * The sandbox exposes ONE global: wa. It lives in a node:vm context with
 * string code generation disabled, so neither eval, the Function constructor,
 * nor any host global (require, process, fs, globalThis) is reachable. Host
 * values cross the boundary as JSON strings and are re-parsed inside the
 * context, so no host-realm object is ever visible to the snippet.
 */
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { defaultAuthDir, liveRuntime } from './auth.js';
import { baileysFactory } from './baileys.js';
import { WaClient } from './client.js';
import { ERROR_CODES, WaError, fail, ok } from './errors.js';
import type { Envelope, ErrorCode } from './errors.js';
import { createFileApi } from './files.js';
import type { FileApi } from './files.js';
import { WaitCoordinator } from './waits.js';
import { openStore } from './sqlstore.js';
import { WebhookSink } from './webhook.js';

export const DEFAULT_TIMEOUT_MS = 5000;
/**
 * The snippet wall-clock ceiling. It is 10 minutes because a long wait is
 * chunked and resumable, not because a snippet should run for ten minutes.
 */
export const MAX_TIMEOUT_MS = 600_000;

/** Globals a snippet may not even mention. */
export const FORBIDDEN_GLOBALS = ['require', 'process', 'fs', 'globalThis', 'module', 'exports', 'import'] as const;

/** The surface the sandbox exposes. Every function is async. */
export interface WaApi {
  getStatus(): Promise<unknown>;
  listChats(limit?: number): Promise<unknown>;
  getChat(chat: string): Promise<unknown>;
  getMessages(chat: string, limit?: number): Promise<unknown>;
  searchMessages(query: string, limit?: number): Promise<unknown>;
  listContacts(limit?: number): Promise<unknown>;
  send(to: string, text: string): Promise<unknown>;
  // Profile and discovery
  getProfile(): Promise<unknown>;
  searchContacts(query: string, limit?: number): Promise<unknown>;
  syncContacts(): Promise<unknown>;
  // Reading
  getLastInteraction(chat: string): Promise<unknown>;
  getMessageContext(chat: string, messageId: string, before?: number, after?: number): Promise<unknown>;
  getNewMessages(sinceTs: number, limit?: number, chat?: string): Promise<unknown>;
  waitForMessages(timeoutS?: number, chat?: string): Promise<unknown>;
  getMessageStatus(chat?: string, messageId?: string, limit?: number): Promise<unknown>;
  getWebhookStatus(): Promise<unknown>;
  // Writing
  sendMessage(to: string, text?: string, mediaPath?: string, caption?: string, replyTo?: string): Promise<unknown>;
  sendLocation(to: string, latitude: number, longitude: number, name?: string, address?: string): Promise<unknown>;
  sendContact(to: string, contacts: { name: string; phone: string; email?: string }[]): Promise<unknown>;
  sendSticker(to: string, mediaPath: string): Promise<unknown>;
  reactMessage(chat: string, messageId: string, emoji: string): Promise<unknown>;
  markRead(chat: string, messageId?: string): Promise<unknown>;
  editMessage(chat: string, messageId: string, text: string): Promise<unknown>;
  sendTyping(chat: string, state?: PresenceState): Promise<unknown>;
  // Media
  downloadMedia(chat: string, messageId: string, saveDir?: string): Promise<unknown>;
  // Groups
  getGroupInfo(chat: string): Promise<unknown>;
  createGroup(subject: string, phones: string[]): Promise<unknown>;
  updateGroup(chat: string, subject?: string, description?: string): Promise<unknown>;
  getGroupInvite(chat: string, reset?: boolean): Promise<unknown>;
  // Destructive group and message actions keep the tool server's confirm guard.
  deleteMessage(chat: string, messageId: string, confirm?: boolean): Promise<unknown>;
  leaveGroup(chat: string, confirm?: boolean): Promise<unknown>;
  groupParticipants(
    chat: string,
    action: GroupAction,
    phones: string[],
    confirm?: boolean,
  ): Promise<unknown>;
}

/** Typing indicator states, matching the tool server's send_typing. */
export type PresenceState = 'composing' | 'paused' | 'recording' | 'available' | 'unavailable';

/** Group participant actions, matching the tool server's group_participants. */
export type GroupAction = 'add' | 'remove' | 'promote' | 'demote';

/**
 * Blank out everything in the source that is NOT executable code, so the
 * forbidden-global scan only ever looks at real identifiers.
 *
 * Comments, string literals, regex literals and template-literal TEXT are
 * removed. Template-literal INTERPOLATIONS are code, so they are kept and
 * scanned. That distinction is what makes `${require('fs')}` a refusal
 * while `/process/` stays valid JavaScript.
 */
export function stripLiterals(code: string): string {
  const out: string[] = [];
  maskRegion(code, 0, out, false);
  return out.join('');
}

/** The previous significant token, used to tell a regex literal from a division. */
type PrevToken = { kind: 'none' | 'ident' | 'kw' | 'num' | 'str' | 'punct'; text: string };

/** Keywords after which a '/' starts a regex literal rather than a division. */
const REGEX_AFTER_KEYWORD = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

/** True when a '/' at this point opens a regex literal. */
function regexAllowed(prev: PrevToken): boolean {
  if (prev.kind === 'none' || prev.kind === 'kw') return true;
  if (prev.kind === 'ident' || prev.kind === 'num' || prev.kind === 'str') return false;
  // punctuation: after ')' or ']' a '/' is a division, otherwise a regex start
  return prev.text !== ')' && prev.text !== ']' && prev.text !== '++' && prev.text !== '--';
}

/**
 * Copy one region of source into `out`, blanking comments and literals.
 * When `stopAtCloseBrace` is set, the scan stops at the '}' that closes the
 * region (used for template-literal interpolations).
 */
function maskRegion(src: string, start: number, out: string[], stopAtCloseBrace: boolean): number {
  const n = src.length;
  let i = start;
  let depth = 0;
  let prev: PrevToken = { kind: 'none', text: '' };
  while (i < n) {
    const c = src[i] as string;
    if (stopAtCloseBrace && c === '}' && depth === 0) return i;

    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== String.fromCharCode(10)) {
        out.push(' ');
        i++;
      }
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      out.push(' ');
      out.push(' ');
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out.push(src[i] === String.fromCharCode(10) ? String.fromCharCode(10) : ' ');
        i++;
      }
      if (i < n) {
        out.push(' ');
        out.push(' ');
        i += 2;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      out.push(' ');
      i++;
      while (i < n) {
        if (src[i] === String.fromCharCode(92)) {
          out.push(' ');
          out.push(' ');
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          out.push(' ');
          i++;
          break;
        }
        out.push(src[i] === String.fromCharCode(10) ? String.fromCharCode(10) : ' ');
        i++;
      }
      prev = { kind: 'str', text: '' };
      continue;
    }
    if (c === String.fromCharCode(96)) {
      i = maskTemplate(src, i, out);
      prev = { kind: 'str', text: '' };
      continue;
    }
    if (c === '/' && regexAllowed(prev)) {
      out.push(' ');
      i++;
      let inClass = false;
      while (i < n) {
        const ch = src[i] as string;
        if (ch === String.fromCharCode(92)) {
          out.push(' ');
          out.push(' ');
          i += 2;
          continue;
        }
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) {
          out.push(' ');
          i++;
          break;
        }
        out.push(ch === String.fromCharCode(10) ? String.fromCharCode(10) : ' ');
        i++;
      }
      while (i < n && /[A-Za-z]/.test(src[i] as string)) {
        out.push(' ');
        i++;
      }
      prev = { kind: 'str', text: '' };
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(src[j] as string)) j++;
      const word = src.slice(i, j);
      out.push(word);
      i = j;
      prev = REGEX_AFTER_KEYWORD.has(word) ? { kind: 'kw', text: word } : { kind: 'ident', text: word };
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < n && /[0-9A-Za-z_.]/.test(src[j] as string)) j++;
      out.push(src.slice(i, j));
      i = j;
      prev = { kind: 'num', text: '' };
      continue;
    }
    // Whitespace is copied (so word boundaries survive) but does not change
    // the previous-token state: 'a / b' is a division, 'a / b' after a
    // keyword is a regex.
    if (/\s/.test(c)) {
      out.push(c);
      i++;
      continue;
    }
    // '++' and '--' are single tokens: a '/' after them is a division.
    if ((c === '+' || c === '-') && src[i + 1] === c) {
      out.push(c);
      out.push(c);
      i += 2;
      prev = { kind: 'punct', text: c + c };
      continue;
    }
    out.push(c);
    i++;
    if (c === '{') depth++;
    else if (c === '}') {
      if (depth > 0) depth--;
    }
    prev = { kind: 'punct', text: c };
  }
  return i;
}

/**
 * Blank a template literal. The literal text is removed; an interpolation
 * `${ ... }` is real code, so it is kept and scanned.
 */
function maskTemplate(src: string, start: number, out: string[]): number {
  const n = src.length;
  let i = start + 1;
  out.push(' ');
  while (i < n) {
    const c = src[i] as string;
    if (c === String.fromCharCode(92)) {
      out.push(' ');
      out.push(' ');
      i += 2;
      continue;
    }
    if (c === String.fromCharCode(96)) {
      out.push(' ');
      i++;
      return i;
    }
    if (c === '$' && src[i + 1] === '{') {
      out.push(' ');
      out.push(' ');
      i += 2;
      i = maskRegion(src, i, out, true);
      if (i < n && src[i] === '}') {
        out.push(' ');
        i++;
      }
      continue;
    }
    out.push(c === String.fromCharCode(10) ? String.fromCharCode(10) : ' ');
    i++;
  }
  return i;
}

/**
 * First forbidden global referenced by the snippet, if any.
 *
 * Only real identifier references count: `x.process` (a property) and
 * `{ process: 1 }` (an object key) are not references to the global.
 */
export function findForbiddenGlobal(code: string): string | undefined {
  const masked = stripLiterals(code);
  const re = new RegExp('\\b(' + FORBIDDEN_GLOBALS.join('|') + ')\\b', 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const name = m[1] as string;
    const before = masked.slice(0, m.index).replace(/\s+$/, '');
    const after = masked.slice(m.index + name.length).replace(/^\s+/, '');
    // a property access (x.process) is not a reference to the global
    if (before.endsWith('.')) continue;
    // an object literal key ({ process: 1 }) is not a reference either
    if (after.startsWith(':') && (before.endsWith('{') || before.endsWith(','))) continue;
    return name;
  }
  return undefined;
}

/** Bind the wa surface to a live client. */
export function createWaApi(client: WaClient): WaApi {
  return {
    getStatus: async () => client.status(),
    listChats: async (limit = 20) => client.listChats(limit),
    getChat: async (chat) => client.getChat(chat),
    getMessages: async (chat, limit = 20) => client.getMessages(chat, limit),
    searchMessages: async (query, limit = 20) => client.searchMessages(query, limit),
    listContacts: async (limit = 50) => client.listContacts(limit),
    send: async (to, text) => client.send(to, { text }),

    getProfile: async () => client.getProfile(),
    searchContacts: async (query, limit = 20) => client.searchContacts(query, limit),
    syncContacts: async () => client.syncContacts(),

    getLastInteraction: async (chat) => client.lastInteraction(chat),
    getMessageContext: async (chat, messageId, before = 3, after = 3) =>
      client.messageContext(chat, messageId, before, after),
    getNewMessages: async (sinceTs, limit = 50, chat) => client.newMessages(sinceTs, limit, chat),
    waitForMessages: async (timeoutS = 10, chat) =>
      client.waitForMessages({ chat, timeoutMs: timeoutS * 1000 }),
    getMessageStatus: async (chat, messageId, limit = 50) => {
      const all = await client.listReceipts(limit, chat);
      const receipts = messageId ? all.filter((r) => r.message_id === messageId) : all;
      return { receipts, count: receipts.length };
    },
    getWebhookStatus: async () => client.webhookStatus(),

    sendMessage: async (to, text, mediaPath, caption, replyTo) =>
      client.send(to, { text, mediaPath, caption, replyTo }),
    sendLocation: async (to, latitude, longitude, name, address) =>
      client.sendLocation(to, latitude, longitude, name, address),
    sendContact: async (to, contacts) => client.sendContact(to, contacts),
    sendSticker: async (to, mediaPath) => client.sendSticker(to, mediaPath),
    reactMessage: async (chat, messageId, emoji) => client.react(chat, messageId, emoji),
    markRead: async (chat, messageId) => client.markRead(chat, messageId),
    editMessage: async (chat, messageId, text) => client.edit(chat, messageId, text),
    sendTyping: async (chat, state = 'composing') => client.presence(chat, state),

    downloadMedia: async (chat, messageId, saveDir) => client.downloadMedia(chat, messageId, saveDir),

    getGroupInfo: async (chat) => client.getGroupInfo(chat),
    createGroup: async (subject, phones) => client.createGroup(subject, phones),
    updateGroup: async (chat, subject, description) => client.updateGroup(chat, { subject, description }),
    getGroupInvite: async (chat, reset = false) => client.getGroupInvite(chat, reset),

    deleteMessage: async (chat, messageId, confirm) => client.remove(chat, messageId, confirm === true),
    leaveGroup: async (chat, confirm) => client.leaveGroup(chat, confirm === true),
    groupParticipants: async (chat, action, phones, confirm) =>
      client.groupParticipants(chat, action, phones, confirm === true),
  };
}

async function callApi(api: WaApi, name: string, args: unknown[]): Promise<string> {
  const fn = (api as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name];
  if (typeof fn !== 'function') throw new Error('unknown wa function: ' + name);
  const value = await fn.apply(api, args);
  return JSON.stringify({ ok: true, value: value === undefined ? null : value });
}

/** Dispatch a wa.files.* call to the rooted file API. */
async function callFileApi(files: FileApi, name: string, args: unknown[]): Promise<string> {
  const fn = (files as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name];
  if (typeof fn !== 'function') {
    throw new WaError('INVALID_ARGUMENT', 'unknown file helper: ' + name);
  }
  const value = await fn.apply(files, args);
  return JSON.stringify({ ok: true, value: value === undefined ? null : value });
}

/**
 * Dispatch a wa.wait.* call. The deadline is the last argument the sandbox
 * passes in, so the coordinator knows how much of the snippet budget is left.
 */
async function callWaitApi(
  waits: WaitCoordinator | undefined,
  api: WaApi,
  name: string,
  args: unknown[],
): Promise<string> {
  if (!waits) {
    // No coordinator: fall back to the plain client wait, without a deadline.
    if (name === 'waitForMessages') {
      const value = await api.waitForMessages(
        args[0] as number | undefined,
        args[1] as string | undefined,
      );
      return JSON.stringify({ ok: true, value: value === undefined ? null : value });
    }
    throw new WaError('INVALID_ARGUMENT', 'unknown wait helper: ' + name);
  }
  const fn = (waits as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name];
  if (typeof fn !== 'function') {
    throw new WaError('INVALID_ARGUMENT', 'unknown wait helper: ' + name);
  }
  const value = await fn.apply(waits, args);
  return JSON.stringify({ ok: true, value: value === undefined ? null : value });
}

/**
 * A media path handed to the sandbox must live inside a root, otherwise the
 * sandbox could read any file on the machine by sending it.
 */
function enforceMediaPolicy(files: FileApi | undefined, name: string, args: unknown[]): void {
  if (!files) return;
  if (name === 'sendMessage') {
    const media = args[2];
    if (typeof media === 'string' && media !== '') files.assertInside(media);
  }
  if (name === 'sendSticker') {
    const media = args[1];
    if (typeof media === 'string' && media !== '') files.assertInside(media);
  }
}

/**
 * Run a snippet in the sandbox.
 *
 * The snippet is the body of an async function: return exits it and the
 * returned value lands in data. A thrown error becomes CODE_ERROR, a timeout
 * CODE_TIMEOUT, and a forbidden global CODE_FORBIDDEN (refused before
 * execution).
 */
/** Extra host services a sandbox may expose to a snippet. */
export interface CodeExtras {
  /** The rooted file API, exposed to the snippet as wa.files. */
  files?: FileApi;
  /** The resumable wait coordinator. */
  waits?: WaitCoordinator;
}

export async function runCode(
  code: string,
  api: WaApi,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  extras?: CodeExtras,
): Promise<Envelope<unknown>> {
  const forbidden = findForbiddenGlobal(code);
  if (forbidden) {
    return fail(
      new WaError(
        'CODE_FORBIDDEN',
        forbidden + ' is not available inside the code sandbox.',
        'the sandbox exposes only the wa.* helpers',
      ),
    );
  }

  const budget = Math.min(Math.max(100, Math.floor(timeoutMs) || DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS);
  const context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
  });

  // The host bridge is a closure parameter, never a context global.
  // On failure it THROWS a host-realm error carrying the code and hint, so the
  // caller sees the actionable message ("run node dist/cli.js pair") instead of
  // a generic CODE_ERROR with a misleading hint.
  // The snippet's own deadline. A wait is clamped to it instead of
  // overrunning it, so a long wait returns partial results instead of
  // dying with CODE_TIMEOUT.
  const deadline = Date.now() + budget;
  const files = extras?.files;
  const waits = extras?.waits;

  const host = async (name: string, argsJson: string): Promise<string> => {
    const args = JSON.parse(argsJson) as unknown[];
    try {
      if (name.startsWith('files.')) {
        if (!files) {
          throw new WaError('FILE_FORBIDDEN', 'this sandbox has no file access');
        }
        return await callFileApi(files, name.slice('files.'.length), args);
      }
      if (name.startsWith('wait.')) {
        return await callWaitApi(waits, api, name.slice('wait.'.length), args);
      }
      if (name === 'downloadMedia' && files) {
        // A save directory outside the roots is redirected into the sandbox.
        const saveDir = args[2];
        if (typeof saveDir === 'string' && saveDir !== '' && !files.inside(saveDir)) {
          args[2] = files.root();
        }
      }
      enforceMediaPolicy(files, name, args);
      return await callApi(api, name, args);
    } catch (err) {
      const waErr = err instanceof WaError ? err : undefined;
      const message = err instanceof Error ? err.message : String(err);
      const thrown = new Error(message);
      thrown.name = 'WaError';
      thrown.stack = 'Error: ' + message;
      (thrown as unknown as { code: string }).code = waErr ? waErr.code : 'INTERNAL';
      if (waErr && waErr.hint !== undefined) {
        (thrown as unknown as { hint: string }).hint = waErr.hint;
      }
      (thrown as unknown as { __waHostError: boolean }).__waHostError = true;
      throw thrown;
    }
  };

  const bootstrap = vm.compileFunction(
    'function args(list) {' +
      '  return JSON.stringify(list.filter(function (x) { return x !== undefined; }));' +
      '}' +
      'function unwrap(raw) {' +
      '  var parsed = JSON.parse(raw);' +
      '  if (!parsed.ok) {' +
      '    var err = new Error(parsed.error.message);' +
      '    err.code = parsed.error.code;' +
      '    err.hint = parsed.error.hint;' +
      '    throw err;' +
      '  }' +
      '  return parsed.value;' +
      '}' +
      'globalThis.wa = {' +
      '  getStatus: function () { return host("getStatus", "[]").then(unwrap); },' +
      '  listChats: function (limit) { return host("listChats", args([limit])).then(unwrap); },' +
      '  getChat: function (chat) { return host("getChat", args([chat])).then(unwrap); },' +
      '  getMessages: function (chat, limit) { return host("getMessages", args([chat, limit])).then(unwrap); },' +
      '  searchMessages: function (query, limit) { return host("searchMessages", args([query, limit])).then(unwrap); },' +
      '  listContacts: function (limit) { return host("listContacts", args([limit])).then(unwrap); },' +
      '  send: function (to, text) { return host("send", args([to, text])).then(unwrap); },' +
      '  getProfile: function () { return host("getProfile", "[]").then(unwrap); },' +
      '  searchContacts: function (query, limit) { return host("searchContacts", args([query, limit])).then(unwrap); },' +
      '  syncContacts: function () { return host("syncContacts", "[]").then(unwrap); },' +
      '  getLastInteraction: function (chat) { return host("getLastInteraction", args([chat])).then(unwrap); },' +
      '  getMessageContext: function (chat, messageId, before, after) { return host("getMessageContext", args([chat, messageId, before, after])).then(unwrap); },' +
      '  getNewMessages: function (sinceTs, limit, chat) { return host("getNewMessages", args([sinceTs, limit, chat])).then(unwrap); },' +
      '  waitForMessages: function (timeoutS, chat) { return host("wait.waitForMessages", args([timeoutS === undefined ? 10 : timeoutS, chat === undefined ? null : chat, DEADLINE])).then(unwrap); },' +
    '  waitForMessage: function (timeoutS, chat, contains) { return host("wait.waitForMessage", args([timeoutS === undefined ? 10 : timeoutS, chat === undefined ? null : chat, contains === undefined ? "" : contains, DEADLINE])).then(unwrap); },' +
      '  getMessageStatus: function (chat, messageId, limit) { return host("getMessageStatus", args([chat, messageId, limit])).then(unwrap); },' +
      '  getWebhookStatus: function () { return host("getWebhookStatus", "[]").then(unwrap); },' +
      '  sendMessage: function (to, text, mediaPath, caption, replyTo) { return host("sendMessage", args([to, text, mediaPath, caption, replyTo])).then(unwrap); },' +
      '  sendLocation: function (to, latitude, longitude, name, address) { return host("sendLocation", args([to, latitude, longitude, name, address])).then(unwrap); },' +
      '  sendContact: function (to, contacts) { return host("sendContact", args([to, contacts])).then(unwrap); },' +
      '  sendSticker: function (to, mediaPath) { return host("sendSticker", args([to, mediaPath])).then(unwrap); },' +
      '  reactMessage: function (chat, messageId, emoji) { return host("reactMessage", args([chat, messageId, emoji])).then(unwrap); },' +
      '  markRead: function (chat, messageId) { return host("markRead", args([chat, messageId])).then(unwrap); },' +
      '  editMessage: function (chat, messageId, text) { return host("editMessage", args([chat, messageId, text])).then(unwrap); },' +
      '  sendTyping: function (chat, state) { return host("sendTyping", args([chat, state])).then(unwrap); },' +
      '  downloadMedia: function (chat, messageId, saveDir) { return host("downloadMedia", args([chat, messageId, saveDir])).then(unwrap); },' +
      '  getGroupInfo: function (chat) { return host("getGroupInfo", args([chat])).then(unwrap); },' +
      '  createGroup: function (subject, phones) { return host("createGroup", args([subject, phones])).then(unwrap); },' +
      '  updateGroup: function (chat, subject, description) { return host("updateGroup", args([chat, subject, description])).then(unwrap); },' +
      '  getGroupInvite: function (chat, reset) { return host("getGroupInvite", args([chat, reset === true])).then(unwrap); },' +
      '  deleteMessage: function (chat, messageId, confirm) { return host("deleteMessage", args([chat, messageId, confirm === true])).then(unwrap); },' +
      '  leaveGroup: function (chat, confirm) { return host("leaveGroup", args([chat, confirm === true])).then(unwrap); },' +
      '  groupParticipants: function (chat, action, phones, confirm) { return host("groupParticipants", args([chat, action, phones, confirm === true])).then(unwrap); }' +
      '};' +
      // The file surface is rooted: every path must resolve inside a root.
      'globalThis.wa.files = {' +
      '  root: function () { return host("files.root", "[]").then(unwrap); },' +
      '  roots: function () { return host("files.roots", "[]").then(unwrap); },' +
      '  readText: function (p) { return host("files.readText", args([p])).then(unwrap); },' +
      '  readBase64: function (p) { return host("files.readBase64", args([p])).then(unwrap); },' +
      '  writeText: function (p, t) { return host("files.writeText", args([p, t])).then(unwrap); },' +
      '  writeBase64: function (p, d) { return host("files.writeBase64", args([p, d])).then(unwrap); },' +
      '  list: function (d) { return host("files.list", args([d])).then(unwrap); },' +
      '  stat: function (p) { return host("files.stat", args([p])).then(unwrap); },' +
      '  remove: function (p) { return host("files.remove", args([p])).then(unwrap); },' +
      '  exists: function (p) { return host("files.exists", args([p])).then(unwrap); }' +
      '};',
    ['host', 'DEADLINE'],
    { parsingContext: context },
  );
  bootstrap(host, deadline);

  let timer: NodeJS.Timeout | undefined;
  try {
    // A neutral filename keeps host paths out of the stack traces a snippet
    // can read off a thrown error.
    const script = new vm.Script(
      '(async function () {' + String.fromCharCode(10) + code + String.fromCharCode(10) + '})()',
      { filename: 'wa-code-snippet.js' },
    );
    // The vm timeout interrupts a synchronous infinite loop; the race below
    // interrupts a snippet that hangs on an unresolved await.
    const running = script.runInContext(context, { timeout: budget }) as Promise<unknown>;
    const expiry = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new WaError('CODE_TIMEOUT', 'The snippet did not finish within ' + budget + ' ms.')),
        budget,
      );
    });
    const value = await Promise.race([running, expiry]);
    // The envelope must always be JSON-serialisable: a snippet that returns a
    // circular structure would otherwise break the {ok,data,error} contract.
    try {
      JSON.stringify(value === undefined ? null : value);
    } catch {
      return fail(
        new WaError(
          'CODE_ERROR',
          'The snippet returned a value that cannot be serialised to JSON (circular reference?).',
          'return a plain JSON-serialisable value',
        ),
      );
    }
    return ok(value === undefined ? null : value);
  } catch (err) {
    if (err instanceof WaError && err.code === 'CODE_TIMEOUT') return fail(err);
    const thrown = err as { message?: unknown; hint?: unknown; code?: unknown; __waHostError?: boolean };
    const message =
      typeof thrown?.message === 'string' ? thrown.message : err instanceof Error ? err.message : String(err);
    if (/timed out/i.test(message)) {
      return fail(new WaError('CODE_TIMEOUT', 'The snippet did not finish within ' + budget + ' ms.'));
    }
    // A failed wa.* call keeps the host's actionable hint instead of the
    // generic sandbox hint.
    const hostHint = thrown?.__waHostError && typeof thrown.hint === 'string' ? thrown.hint : undefined;
    // A host error with a known code (FILE_FORBIDDEN, NOT_PAIRED, ...) keeps
    // that code instead of being flattened into CODE_ERROR.
    const code = thrown?.code;
    if (typeof code === 'string' && (ERROR_CODES as readonly string[]).includes(code)) {
      const hint = typeof thrown?.hint === 'string' ? thrown.hint : hostHint;
      return fail(new WaError(code as ErrorCode, message, hint));
    }
    return fail(
      new WaError(
        'CODE_ERROR',
        message,
        hostHint ?? 'the snippet body is an async function; use wa.* helpers only',
      ),
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Options for the code-mode server. */
export interface CodeModeOptions {
  /** Auth dir; the file sandbox roots default under it. */
  authDir?: string;
  /** Pre-built file API (tests inject a temp root). */
  files?: FileApi;
  /** Pre-built wait coordinator. */
  waits?: WaitCoordinator;
}

/** The MCP server for code mode: one tool, one global. */
export function createCodeModeServer(client: WaClient, options: CodeModeOptions = {}): McpServer {
  const server = new McpServer({ name: 'wa-mcp-code', version: '1.0.0' });
  const api = createWaApi(client);
  const files = options.files ?? (options.authDir ? createFileApi(options.authDir) : undefined);
  const waits = options.waits ?? new WaitCoordinator(client);
  server.registerTool(
    'wa_code',
    {
      description:
        'Run JavaScript against WhatsApp. The code is the body of an async function: return exits it and the returned value becomes data. Only the wa object is available. ' +
        'Reads: wa.getStatus(), wa.listChats(limit?), wa.getChat(chat), wa.getMessages(chat, limit?), wa.searchMessages(query, limit?), wa.listContacts(limit?), wa.getProfile(), wa.searchContacts(query, limit?), wa.syncContacts(), wa.getLastInteraction(chat), wa.getMessageContext(chat, messageId, before?, after?), wa.getNewMessages(sinceTs, limit?, chat?), wa.waitForMessages(timeoutS?, chat?), wa.getMessageStatus(chat?, messageId?, limit?), wa.getWebhookStatus(), wa.downloadMedia(chat, messageId, saveDir?). ' +
        'Writes: wa.send(to, text), wa.sendMessage(to, text?, mediaPath?, caption?, replyTo?), wa.sendLocation(to, latitude, longitude, name?, address?), wa.sendContact(to, [{name, phone, email?}]), wa.sendSticker(to, mediaPath), wa.reactMessage(chat, messageId, emoji), wa.markRead(chat, messageId?), wa.editMessage(chat, messageId, text), wa.sendTyping(chat, state?). ' +
        'Groups: wa.getGroupInfo(chat), wa.createGroup(subject, phones[]), wa.updateGroup(chat, subject?, description?), wa.getGroupInvite(chat, reset?). ' +
        'Destructive, need confirm:true: wa.deleteMessage(chat, messageId, confirm), wa.leaveGroup(chat, confirm), wa.groupParticipants(chat, action, phones[], confirm). ' +
        'Waits: wa.waitForMessages(timeoutS?, chat?) returns {messages, timed_out, cursor, clamped, budget_exhausted}; a wait longer than the snippet budget is CLAMPED and resumes on the next call from the cursor. wa.waitForMessage(timeoutS?, chat?, contains?) waits for a message whose text contains a substring. ' +
        'Files: wa.files is rooted to the media directory. wa.files.root(), wa.files.roots(), wa.files.readText(path), wa.files.readBase64(path), wa.files.writeText(path, text), wa.files.writeBase64(path, data), wa.files.list(dir?), wa.files.stat(path), wa.files.remove(path), wa.files.exists(path). Paths outside the roots raise FILE_FORBIDDEN. Media paths passed to sendMessage/sendSticker must be inside a root too. ' +
        'Chats are JIDs or phone numbers, never display names; resolve ids with wa.listChats().',
      inputSchema: {
        code: z.string().describe('JavaScript body of an async function. Use return to produce a value.'),
        timeout_ms: z
          .coerce
          .string()
          .optional()
          .describe('Wall-clock budget in milliseconds (default 5000, max 600000). Accepts a number or a string. A wait longer than the budget is clamped and resumable, so it returns partial results instead of timing out.'),
      },
    },
    async (args: Record<string, unknown>) => {
      const raw = args['timeout_ms'];
      const parsed = raw === undefined ? DEFAULT_TIMEOUT_MS : Number(raw);
      const budget = Number.isFinite(parsed) ? parsed : DEFAULT_TIMEOUT_MS;
      const envelope = await runCode(String(args['code'] ?? ''), api, budget, { files, waits });
      // The envelope is always JSON-serialisable (runCode guarantees it), but
      // stringify defensively so the server can never answer with a raw error.
      let text: string;
      try {
        text = JSON.stringify(envelope);
      } catch {
        text = JSON.stringify(fail(new WaError('CODE_ERROR', 'The snippet result could not be serialised to JSON.')));
      }
      return {
        content: [{ type: 'text' as const, text }],
        isError: !envelope.ok,
      };
    },
  );
  return server;
}

async function main(): Promise<void> {
  const log = (msg: string): void => {
    process.stderr.write('[wa-mcp-code] ' + msg + String.fromCharCode(10));
  };
  process.on('uncaughtException', (err) => log('uncaughtException: ' + (err.stack ?? err.message)));
  process.on('unhandledRejection', (reason) => log('unhandledRejection: ' + String(reason)));

  const authDir = defaultAuthDir();
  const other = liveRuntime(authDir);
  const ownsSession = !other || other.pid === process.pid;

  const client = new WaClient({
    authDir,
    factory: baileysFactory,
    store: openStore(authDir),
    log,
    publishRuntime: ownsSession,
    webhook: new WebhookSink({ log }),
  });

  const server = createCodeModeServer(client, { authDir });
  await server.connect(new StdioServerTransport());

  // No eager connect: the wa.* helpers connect lazily on first use, so the
  // server answers immediately even when nothing is paired.
  if (!ownsSession) {
    log('another server (pid ' + (other ? other.pid : '?') + ') holds this session; running read-only');
  }

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

const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write('[wa-mcp-code] fatal: ' + String(err) + String.fromCharCode(10));
    process.exit(1);
  });
}