import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WAMessage } from '@whiskeysockets/baileys';
import { ChatStore, mergeReceipt } from '../src/store.js';
import { SqliteStore } from '../src/sqlstore.js';
import { WebhookSink } from '../src/webhook.js';
import { createTools } from '../src/tools.js';
import { makeHarness, tmpAuthDir } from './helpers.js';

const JID = '911234567890@s.whatsapp.net';

function textMsg(id: string, text: string, ts: number): WAMessage {
  return {
    key: { id, remoteJid: JID, fromMe: false },
    message: { conversation: text },
    messageTimestamp: ts,
    pushName: 'Ravi',
  } as unknown as WAMessage;
}

describe('receipt merging', () => {
  it('keeps the furthest status and never regresses', () => {
    const sent = { message_id: 'M1', chat: JID, status: 'sent' as const, ts: 10 };
    expect(mergeReceipt(undefined, sent)).toEqual(sent);
    expect(mergeReceipt(sent, { ...sent, status: 'read', ts: 20 }).status).toBe('read');
    expect(mergeReceipt({ ...sent, status: 'read' }, { ...sent, status: 'sent', ts: 30 }).status).toBe('read');
    expect(mergeReceipt({ ...sent, status: 'read' }, { ...sent, status: 'error', ts: 40 }).status).toBe('error');
    expect(mergeReceipt(sent, { ...sent, status: 'played', ts: 50, participant: JID }).participant).toBe(JID);
  });
});

describe('store backends keep receipts', () => {
  it('JSON store records and upgrades receipts', () => {
    const store = new ChatStore();
    store.recordReceipt({ message_id: 'M1', chat: JID, status: 'sent', ts: 1 });
    store.recordReceipt({ message_id: 'M1', chat: JID, status: 'read', ts: 2 });
    store.recordReceipt({ message_id: 'M2', chat: JID, status: 'sent', ts: 3 });
    const list = store.listReceipts(10);
    expect(list).toHaveLength(2);
    expect(list.find((r) => r.message_id === 'M1')?.status).toBe('read');
  });

  it('SQLite store records, upgrades and filters receipts', () => {
    const dir = tmpAuthDir(true);
    const store = new SqliteStore(path.join(dir, 'store.sqlite'));
    store.recordReceipt({ message_id: 'M1', chat: JID, status: 'delivered', ts: 5 });
    store.recordReceipt({ message_id: 'M1', chat: JID, status: 'sent', ts: 6 });
    store.recordReceipt({ message_id: 'M2', chat: JID, status: 'sent', ts: 7 });
    const list = store.listReceipts(10);
    expect(list.map((r) => r.message_id).sort()).toEqual(['M1', 'M2']);
    expect(list.find((r) => r.message_id === 'M1')?.status).toBe('delivered');
    expect(store.listReceipts(10, 'other@s.whatsapp.net')).toHaveLength(0);
  });
});

describe('client tracks delivery and read receipts', () => {
  it('records sent on send, then delivered and read from socket events', async () => {
    const h = makeHarness(true);
    await h.client.start();
    const sock = h.sockets[0];
    if (!sock) throw new Error('no socket');
    sock.emit('connection.update', { connection: 'open' });

    await h.client.send('+911234567890', { text: 'hi' });
    const afterSend = await h.client.listReceipts(10);
    expect(afterSend[0]?.status).toBe('sent');
    const id = afterSend[0]?.message_id ?? '';

    sock.emit('messages.update', [{ key: { id, remoteJid: JID }, update: { status: 3 } }]);
    expect((await h.client.listReceipts(10)).find((r) => r.message_id === id)?.status).toBe('delivered');

    sock.emit('message-receipt.update', [
      { key: { id, remoteJid: JID }, receipt: { userJid: JID, readTimestamp: 99 } },
    ]);
    expect((await h.client.listReceipts(10)).find((r) => r.message_id === id)?.status).toBe('read');

    // a late 'sent' must not roll the status back
    sock.emit('messages.update', [{ key: { id, remoteJid: JID }, update: { status: 2 } }]);
    expect((await h.client.listReceipts(10)).find((r) => r.message_id === id)?.status).toBe('read');
  });

  it('treats played as final and lets an error override a read', async () => {
    const h = makeHarness(true);
    await h.client.start();
    const sock = h.sockets[0];
    if (!sock) throw new Error('no socket');
    sock.emit('connection.update', { connection: 'open' });

    sock.emit('messages.update', [{ key: { id: 'P1', remoteJid: JID }, update: { status: 5 } }]);
    expect((await h.client.listReceipts(10)).find((r) => r.message_id === 'P1')?.status).toBe('played');

    sock.emit('message-receipt.update', [
      { key: { id: 'P1', remoteJid: JID }, receipt: { userJid: JID, playedTimestamp: 100 } },
    ]);
    expect((await h.client.listReceipts(10)).find((r) => r.message_id === 'P1')?.status).toBe('played');

    sock.emit('messages.update', [{ key: { id: 'P1', remoteJid: JID }, update: { status: 0 } }]);
    expect((await h.client.listReceipts(10)).find((r) => r.message_id === 'P1')?.status).toBe('error');
  });
});

describe('webhook sink', () => {
  it('pushes inbound messages and receipts to the configured URL', async () => {
    const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
    const sink = new WebhookSink({
      url: 'https://sink.test/hook',
      secret: 's3cret',
      fetchImpl: async (url, init) => {
        calls.push({
          url,
          body: String(init.body),
          headers: (init.headers ?? {}) as Record<string, string>,
        });
        return new Response('{}', { status: 200 });
      },
      sleep: async () => undefined,
    });
    const h = makeHarness(true, { webhook: sink });
    await h.client.start();
    const sock = h.sockets[0];
    if (!sock) throw new Error('no socket');
    sock.emit('connection.update', { connection: 'open' });

    sock.emit('messages.upsert', { messages: [textMsg('W1', 'ping', 100)], type: 'notify' });
    await new Promise((r) => setTimeout(r, 0));

    expect(calls).toHaveLength(1);
    const payload = JSON.parse(calls[0]?.body ?? '{}') as { type: string; data: { id: string; text: string } };
    expect(payload.type).toBe('message');
    expect(payload.data.id).toBe('W1');
    expect(payload.data.text).toBe('ping');
    expect(calls[0]?.headers['x-wa-mcp-signature']).toMatch(/^sha256=/);

    sock.emit('messages.update', [{ key: { id: 'W2', remoteJid: JID }, update: { status: 3 } }]);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.length).toBe(2);
    expect(JSON.parse(calls[1]?.body ?? '{}').type).toBe('receipt');
    expect(sink.status().delivered).toBe(2);
  });

  it('counts failures without throwing', async () => {
    const sink = new WebhookSink({
      url: 'https://sink.test/hook',
      maxRetries: 0,
      fetchImpl: async () => {
        throw new Error('boom');
      },
      sleep: async () => undefined,
    });
    await expect(sink.emit('message', { a: 1 })).resolves.toBe(false);
    expect(sink.status().failed).toBe(1);
    expect(sink.status().last_error).toContain('boom');
  });

  it('stays disabled without a URL', async () => {
    const sink = new WebhookSink({
      url: '',
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });
    expect(sink.enabled).toBe(false);
    await expect(sink.emit('message', {})).resolves.toBe(false);
    expect(sink.status().delivered).toBe(0);
  });
});

describe('new MCP tools', () => {
  it('exposes get_message_status and get_webhook_status', async () => {
    const sink = new WebhookSink({
      url: 'https://sink.test/hook',
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });
    const h = makeHarness(true, { webhook: sink });
    await h.client.start();
    const sock = h.sockets[0];
    if (!sock) throw new Error('no socket');
    sock.emit('connection.update', { connection: 'open' });
    sock.emit('messages.update', [{ key: { id: 'T1', remoteJid: JID }, update: { status: 4 } }]);

    const tools = createTools(h.client);
    const byName = new Map(tools.map((t) => [t.name, t]));

    const statuses = await byName.get('get_message_status')?.run({});
    expect(statuses?.ok).toBe(true);
    expect(JSON.stringify(statuses)).toContain('"read"');

    const filtered = await byName.get('get_message_status')?.run({ message_id: 'T1' });
    expect(JSON.stringify(filtered)).toContain('T1');

    const web = await byName.get('get_webhook_status')?.run({});
    expect(web).toMatchObject({ ok: true, data: { enabled: true, url: 'https://sink.test/hook' } });
  });

  it('returns a structured error for a bad argument', async () => {
    const h = makeHarness(true);
    await h.client.start();
    const tools = createTools(h.client);
    const byName = new Map(tools.map((t) => [t.name, t]));
    const res = await byName.get('get_message_status')?.run({ message_id: 5 });
    expect(res?.ok).toBe(false);
    expect(res?.error?.code).toBe('INVALID_ARGUMENT');
  });
});
