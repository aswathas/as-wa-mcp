import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWaApi, findForbiddenGlobal, runCode } from '../src/codemode.js';
import { ChatStore } from '../src/store.js';
import type { StoredMessage } from '../src/store.js';
import type { WaApi } from '../src/codemode.js';
import type { WaClient } from '../src/client.js';
import { SandboxedFiles } from '../src/files.js';
import { WaitCoordinator } from '../src/waits.js';
import { makeHarness } from './helpers.js';

const JID = '911234567890@s.whatsapp.net';

/** Every helper the sandbox is expected to expose. */
const HELPER_NAMES = [
  'getStatus',
  'listChats',
  'getChat',
  'getMessages',
  'searchMessages',
  'listContacts',
  'send',
  'getProfile',
  'searchContacts',
  'syncContacts',
  'getLastInteraction',
  'getMessageContext',
  'getNewMessages',
  'waitForMessages',
  'getMessageStatus',
  'getWebhookStatus',
  'sendMessage',
  'sendLocation',
  'sendContact',
  'sendSticker',
  'reactMessage',
  'markRead',
  'editMessage',
  'sendTyping',
  'downloadMedia',
  'getGroupInfo',
  'createGroup',
  'updateGroup',
  'getGroupInvite',
  'deleteMessage',
  'leaveGroup',
  'groupParticipants',
] as const;

const defaults: WaApi = {
  getStatus: async () => ({ status: 'not_paired' }),
  listChats: async () => [],
  getChat: async () => undefined,
  getMessages: async () => [],
  searchMessages: async () => [],
  listContacts: async () => [],
  send: async () => ({ to: '+911234567890', message_ids: ['M1'], parts: 1 }),
  getProfile: async () => ({ number: '+911234567890', jid: JID, name: 'Aswath', lid: null }),
  searchContacts: async () => [],
  syncContacts: async () => ({ synced: 0, total: 0 }),
  getLastInteraction: async () => null,
  getMessageContext: async () => ({ messages: [], index: 0 }),
  getNewMessages: async () => [],
  waitForMessages: async () => ({ messages: [], timed_out: false }),
  getMessageStatus: async () => ({ receipts: [], count: 0 }),
  getWebhookStatus: async () => ({ enabled: false, url: null, delivered: 0, failed: 0 }),
  sendMessage: async () => ({ to: '+911234567890', message_ids: ['M1'], parts: 1 }),
  sendLocation: async () => ({ to: '+911234567890', latitude: 0, longitude: 0 }),
  sendContact: async () => ({ to: '+911234567890', sent: 1 }),
  sendSticker: async () => ({ to: '+911234567890', sticker: 'sticker.webp' }),
  reactMessage: async () => ({ chat: JID, message_id: 'M1', emoji: '👍' }),
  markRead: async () => ({ chat: JID, marked: 0 }),
  editMessage: async () => ({ chat: JID, message_id: 'M1', edited: true }),
  sendTyping: async () => ({ chat: JID, state: 'composing' }),
  downloadMedia: async () => ({ chat: JID, message_id: 'M1', path: 'media/M1.jpg', bytes: 1 }),
  getGroupInfo: async () => ({ subject: 'Group', participant_count: 2 }),
  createGroup: async () => ({ id: 'g@g.us', subject: 'Group', participant_count: 2 }),
  updateGroup: async () => ({ chat: 'g@g.us', subject: 'Group', description: null }),
  getGroupInvite: async () => ({ chat: 'g@g.us', invite_code: 'ABC', link: 'https://chat.whatsapp.com/ABC' }),
  deleteMessage: async () => ({ chat: JID, message_id: 'M1', revoked: false }),
  leaveGroup: async () => ({ chat: 'g@g.us', left: false }),
  groupParticipants: async () => ({ chat: 'g@g.us', action: 'remove', results: [] }),
};

function stubApi(over: Partial<WaApi> = {}): WaApi {
  return { ...defaults, ...over };
}

/** A stand-in client for the wait coordinator. */
class FakeWaitClient {
  pending: StoredMessage[] = [];
  async newMessages(): Promise<StoredMessage[]> {
    return this.pending.splice(0);
  }
  async waitForMessages(): Promise<{ messages: StoredMessage[]; timed_out: boolean }> {
    const messages = this.pending.splice(0);
    return { messages, timed_out: messages.length === 0 };
  }
}

function storedMessage(id: string, text: string, ts: number): StoredMessage {
  return { id, chat: JID, from: JID, fromMe: false, ts, type: 'text', text };
}

function tempRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'wa-code-files-'));
}

describe('code mode sandbox', () => {
  it('returns the standard envelope shape', async () => {
    const env = await runCode('return 41 + 1;', stubApi());
    expect(env).toEqual({ ok: true, data: 42, error: null });
  });

  it('data is null when the snippet returns nothing', async () => {
    const env = await runCode('const x = 1;', stubApi());
    expect(env).toMatchObject({ ok: true, data: null, error: null });
  });

  it('refuses require() before execution', async () => {
    const env = await runCode("return require('fs').readFileSync('C:/Windows/win.ini', 'utf8');", stubApi());
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('CODE_FORBIDDEN');
    expect(env.data).toBeNull();
  });

  it('detects forbidden globals by name', () => {
    expect(findForbiddenGlobal('require("fs")')).toBe('require');
    expect(findForbiddenGlobal('process.exit(1)')).toBe('process');
    expect(findForbiddenGlobal('globalThis.x = 1')).toBe('globalThis');
    expect(findForbiddenGlobal('const s = "process";')).toBeUndefined();
    expect(findForbiddenGlobal('return 1;')).toBeUndefined();
  });

  it('times out instead of hanging', async () => {
    const env = await runCode('while (true) {}', stubApi(), 400);
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('CODE_TIMEOUT');
  });

  it('reports a thrown error as CODE_ERROR', async () => {
    const env = await runCode('throw new Error("boom");', stubApi());
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('CODE_ERROR');
    expect(env.error?.message).toContain('boom');
  });

  it('wa.* helpers reach the client', async () => {
    const store = new ChatStore();
    store.ingestChats([{ id: JID, name: 'Aswath' } as never]);
    const h = makeHarness(true, { store });
    await h.client.start();
    const env = await runCode('const chats = await wa.listChats(); return chats.length;', createWaApi(h.client));
    expect(env).toMatchObject({ ok: true, data: 1 });
  });

  it('wa.getStatus works while not paired', async () => {
    const env = await runCode('return (await wa.getStatus()).status;', stubApi());
    expect(env).toMatchObject({ ok: true, data: 'not_paired' });
  });

  it('exposes every helper on the sandbox wa object', async () => {
    const env = await runCode('return Object.keys(wa).sort();', stubApi());
    expect(env.ok).toBe(true);
    // The sandbox adds the file surface and the substring wait on top of the
    // plain client helpers.
    expect(env.data).toEqual([...HELPER_NAMES, 'files', 'waitForMessage'].sort());
  });

  it('createWaApi binds every helper', () => {
    const h = makeHarness(true);
    const api = createWaApi(h.client);
    expect(Object.keys(api).sort()).toEqual([...HELPER_NAMES].sort());
  });

  it('a new helper reaches the client', async () => {
    const h = makeHarness(true);
    await h.client.start();
    const env = await runCode('const p = await wa.getProfile(); return p.jid;', createWaApi(h.client));
    expect(env.ok).toBe(true);
    expect(String(env.data)).toContain('911234567890');
  });

  it('carries the confirm flag through for destructive helpers', async () => {
    const seen: unknown[][] = [];
    const api = stubApi({
      deleteMessage: async (chat, id, confirm) => {
        seen.push(['delete', chat, id, confirm]);
        return { chat, message_id: id, revoked: confirm === true };
      },
      leaveGroup: async (chat, confirm) => {
        seen.push(['leave', chat, confirm]);
        return { chat, left: confirm === true };
      },
      groupParticipants: async (chat, action, phones, confirm) => {
        seen.push(['participants', chat, action, phones, confirm]);
        return { chat, action, results: [], confirmed: confirm === true };
      },
    });
    const env = await runCode(
      "await wa.deleteMessage('c', 'M1', true);" +
        "await wa.leaveGroup('g', true);" +
        "await wa.groupParticipants('g', 'remove', ['+911234567890'], true);" +
        "return 'done';",
      api,
    );
    expect(env).toMatchObject({ ok: true, data: 'done' });
    expect(seen).toEqual([
      ['delete', 'c', 'M1', true],
      ['leave', 'g', true],
      ['participants', 'g', 'remove', ['+911234567890'], true],
    ]);
  });

  it('an omitted confirm flag arrives as false, so the guard still refuses', async () => {
    const env = await runCode("return await wa.deleteMessage('c', 'M1');", stubApi());
    expect(env).toMatchObject({ ok: true, data: { revoked: false } });
  });

  it('passes media and caption through sendMessage', async () => {
    let captured: unknown;
    const api = stubApi({
      sendMessage: async (to, text, mediaPath, caption, replyTo) => {
        captured = { to, text, mediaPath, caption, replyTo };
        return { to, message_ids: ['M1'], parts: 2 };
      },
    });
    const env = await runCode(
      "return await wa.sendMessage('+911234567890', 'hi', 'C:/tmp/a.jpg', 'cap', 'M0');",
      api,
    );
    expect(env.ok).toBe(true);
    expect(captured).toEqual({ to: '+911234567890', text: 'hi', mediaPath: 'C:/tmp/a.jpg', caption: 'cap', replyTo: 'M0' });
  });

  it('exposes the file surface as wa.files', async () => {
    const env = await runCode('return Object.keys(wa.files).sort();', stubApi());
    expect(env.ok).toBe(true);
    expect(env.data).toEqual([
      'exists',
      'list',
      'readBase64',
      'readText',
      'remove',
      'root',
      'roots',
      'stat',
      'writeBase64',
      'writeText',
    ].sort());
  });

  it('wa.files writes and reads text inside the root', async () => {
    const files = new SandboxedFiles([tempRoot()]);
    const env = await runCode(
      "await wa.files.writeText('note.txt', 'hello'); return await wa.files.readText('note.txt');",
      stubApi(),
      5000,
      { files },
    );
    expect(env).toMatchObject({ ok: true, data: 'hello' });
  });

  it('wa.files refuses a path outside the root', async () => {
    const files = new SandboxedFiles([tempRoot()]);
    const env = await runCode(
      "return await wa.files.readText('C:/Windows/win.ini');",
      stubApi(),
      5000,
      { files },
    );
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('FILE_FORBIDDEN');
  });

  it('wa.files refuses a traversal out of the root', async () => {
    const files = new SandboxedFiles([tempRoot()]);
    const env = await runCode(
      "return await wa.files.readText('../../../etc/passwd');",
      stubApi(),
      5000,
      { files },
    );
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('FILE_FORBIDDEN');
  });

  it('a media path outside the roots is refused', async () => {
    const files = new SandboxedFiles([tempRoot()]);
    const env = await runCode(
      "return await wa.sendMessage('+911234567890', 'hi', 'C:/Windows/win.ini');",
      stubApi(),
      5000,
      { files },
    );
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('FILE_FORBIDDEN');
  });

  it('a wait longer than the snippet budget is clamped instead of timing out', async () => {
    const waits = new WaitCoordinator(new FakeWaitClient() as unknown as WaClient);
    const env = await runCode('return await wa.waitForMessages(600);', stubApi(), 1500, { waits });
    expect(env.ok).toBe(true);
    const data = env.data as { timed_out: boolean; clamped: boolean; budget_exhausted: boolean };
    expect(data.clamped).toBe(true);
    expect(data.budget_exhausted).toBe(true);
    expect(data.timed_out).toBe(true);
  });

  it('a wait resumes across calls from the cursor', async () => {
    const fake = new FakeWaitClient();
    const waits = new WaitCoordinator(fake as unknown as WaClient);
    const first = await runCode('return await wa.waitForMessages(1);', stubApi(), 3000, { waits });
    expect((first.data as { timed_out: boolean }).timed_out).toBe(true);
    fake.pending.push(storedMessage('M1', 'hello', Math.floor(Date.now() / 1000) + 5));
    const second = await runCode('return await wa.waitForMessages(1);', stubApi(), 3000, { waits });
    const data = second.data as { timed_out: boolean; messages: StoredMessage[] };
    expect(data.timed_out).toBe(false);
    expect(data.messages[0]?.id).toBe('M1');
  });

  it('wa.waitForMessage matches on a substring', async () => {
    const fake = new FakeWaitClient();
    const waits = new WaitCoordinator(fake as unknown as WaClient);
    const now = Math.floor(Date.now() / 1000);
    fake.pending.push(storedMessage('M1', 'hello world', now + 1));
    fake.pending.push(storedMessage('M2', 'not it', now + 2));
    const env = await runCode(
      "const r = await wa.waitForMessage(1, undefined, 'hello'); return r.message.text;",
      stubApi(),
      3000,
      { waits },
    );
    expect(env).toMatchObject({ ok: true, data: 'hello world' });
  });
});
