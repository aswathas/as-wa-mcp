import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WAMessage } from '@whiskeysockets/baileys';
import { buildStickerContent, buildVcard, extForMime, mediaMimetypeOf } from '../src/media.js';
import { ChatStore } from '../src/store.js';
import { createTools } from '../src/tools.js';
import { makeHarness } from './helpers.js';

const JID = '911234567890@s.whatsapp.net';
const GROUP = '120363012345678901@g.us';

function textMsg(id: string, text: string, ts: number, extra: Partial<WAMessage> = {}): WAMessage {
  return {
    key: { id, remoteJid: JID, fromMe: false },
    message: { conversation: text },
    messageTimestamp: ts,
    ...extra,
  } as WAMessage;
}

function imageMsg(id: string, ts: number, mimetype = 'image/png'): WAMessage {
  return {
    key: { id, remoteJid: JID, fromMe: false },
    message: { imageMessage: { mimetype, caption: 'pic' } },
    messageTimestamp: ts,
  } as WAMessage;
}

describe('ChatStore search / context / raw cache', () => {
  function seeded(): ChatStore {
    const store = new ChatStore();
    store.ingestChats([{ id: JID, name: 'Aswath' } as never]);
    store.ingestMessage(textMsg('M1', 'first invoice please', 100, { pushName: 'Aswath' }));
    store.ingestMessage(textMsg('M2', 'hello there', 200));
    store.ingestMessage(textMsg('M3', 'the INVOCE is late', 300));
    return store;
  }

  it('searchContacts matches names and numbers', () => {
    const store = seeded();
    const byName = store.searchContacts('asw', 10);
    expect(byName).toEqual([{ id: JID, name: 'Aswath', number: '+911234567890' }]);
    expect(store.searchContacts('9112345', 10)).toHaveLength(1);
    expect(store.searchContacts('zzz', 10)).toEqual([]);
  });

  it('searchMessages is full-text, case-insensitive, newest first', () => {
    const store = seeded();
    const hits = store.searchMessages('invoice', 10);
    expect(hits.map((h) => h.id)).toEqual(['M1']);
    expect(store.searchMessages('INVOCE', 10).map((h) => h.id)).toEqual(['M3']);
    expect(store.searchMessages('  ', 10)).toEqual([]);
  });

  it('getChatInfo / lastInteraction / messageContext', () => {
    const store = seeded();
    expect(store.getChatInfo(JID)).toMatchObject({ id: JID, is_group: false, message_count: 3 });
    expect(store.getChatInfo(GROUP)).toBeUndefined();
    expect(store.lastInteraction(JID)?.id).toBe('M3');
    const ctx = store.messageContext(JID, 'M2', 1, 1);
    expect(ctx?.messages.map((m) => m.id)).toEqual(['M1', 'M2', 'M3']);
    expect(ctx?.index).toBe(1);
    expect(store.messageContext(JID, 'nope', 1, 1)).toBeUndefined();
  });

  it('keeps raw messages for quoting/download, capped at 200', () => {
    const store = new ChatStore();
    store.ingestMessage(textMsg('M1', 'x', 1));
    expect(store.getRaw('M1')).toBeDefined();
    for (let i = 0; i < 205; i++) store.ingestMessage(textMsg(`B${i}`, 'y', 2 + i));
    expect(store.getRaw('M1')).toBeUndefined();
    expect(store.getRaw('B204')).toBeDefined();
  });

  it('marks media messages with has_media', () => {
    const store = new ChatStore();
    store.ingestMessage(imageMsg('I1', 10));
    expect(store.getMessage(JID, 'I1')).toMatchObject({ type: 'image', has_media: true });
  });
});

describe('media builders', () => {
  it('stickers must be webp', () => {
    expect(buildStickerContent('/a/s.webp')).toEqual({ sticker: { url: '/a/s.webp' } });
    expect(() => buildStickerContent('/a/s.png')).toThrowError(/webp/);
  });

  it('builds a vCard with waid', () => {
    const v = buildVcard('Bob', '+91 12345 67890', 'bob@example.com');
    expect(v).toContain('BEGIN:VCARD');
    expect(v).toContain('FN:Bob');
    expect(v).toContain('waid=911234567890');
    expect(v).toContain('EMAIL:bob@example.com');
  });

  it('extForMime and mediaMimetypeOf (incl. wrappers)', () => {
    expect(extForMime('image/jpeg')).toBe('jpg');
    expect(extForMime('application/octet-stream')).toBe('bin');
    expect(mediaMimetypeOf({ message: { imageMessage: { mimetype: 'image/png' } } })).toBe('image/png');
    expect(mediaMimetypeOf({ message: { ephemeralMessage: { message: { videoMessage: { mimetype: 'video/mp4' } } } } })).toBe('video/mp4');
    expect(mediaMimetypeOf({ message: { conversation: 'x' } })).toBeUndefined();
  });
});

describe('new tools against a connected client', () => {
  async function ready(extra = {}) {
    const h = makeHarness(true, extra);
    await h.client.start();
    const sock = h.sockets[0];
    if (!sock) throw new Error('no socket');
    sock.emit('connection.update', { connection: 'open' });
    sock.emit('messages.upsert', {
      messages: [
        textMsg('M1', 'first invoice please', 100, { pushName: 'Aswath' }),
        textMsg('M2', 'hello there', 200),
        imageMsg('I1', 300),
      ],
      type: 'notify',
    });
    const tools = Object.fromEntries(createTools(h.client).map((t) => [t.name, t]));
    return { h, sock, tools };
  }

  it('search_contacts, search_messages, get_chat, get_last_interaction, get_message_context', async () => {
    const { tools } = await ready();
    expect(await tools['search_contacts']?.run({ query: 'asw' })).toMatchObject({ ok: true, data: [{ name: 'Aswath' }] });
    expect(await tools['search_messages']?.run({ query: 'invoice' })).toMatchObject({ ok: true, data: [{ id: 'M1' }] });
    expect(await tools['get_chat']?.run({ chat: '+911234567890' })).toMatchObject({ ok: true, data: { message_count: 3 } });
    expect(await tools['get_last_interaction']?.run({ chat: '+911234567890' })).toMatchObject({ ok: true, data: { id: 'I1' } });
    expect(await tools['get_message_context']?.run({ chat: '+911234567890', message_id: 'M2' })).toMatchObject({
      ok: true,
      data: { index: 1 },
    });
  });

  it('react_message sends a reaction frame', async () => {
    const { sock, tools } = await ready();
    const env = await tools['react_message']?.run({ chat: '+911234567890', message_id: 'M1', emoji: '🔥' });
    expect(env).toMatchObject({ ok: true, data: { message_id: 'M1', emoji: '🔥' } });
    expect(sock.sent[0]?.content).toEqual({
      react: { text: '🔥', key: { remoteJid: JID, id: 'M1', fromMe: false } },
    });
  });

  it('mark_read sends read receipts for the unread window or one id', async () => {
    const { sock, tools } = await ready();
    expect(await tools['mark_read']?.run({ chat: '+911234567890' })).toMatchObject({ ok: true, data: { marked: 3 } });
    expect(sock.readCalls[0]?.map((k) => k.id)).toEqual(['M1', 'M2', 'I1']);
    expect(await tools['mark_read']?.run({ chat: '+911234567890', message_id: 'M2' })).toMatchObject({ ok: true, data: { marked: 1 } });
  });

  it('send_location and send_contact build the right frames', async () => {
    const { sock, tools } = await ready();
    expect(
      await tools['send_location']?.run({ to: '+911234567890', latitude: 12.9, longitude: 77.6, name: 'Office' }),
    ).toMatchObject({ ok: true, data: { latitude: 12.9, longitude: 77.6 } });
    expect(sock.sent[0]?.content).toMatchObject({ location: { degreesLatitude: 12.9, degreesLongitude: 77.6, name: 'Office' } });

    expect(await tools['send_contact']?.run({ to: '+911234567890', contacts: [{ name: 'Bob', phone: '+919999999999' }] })).toMatchObject({
      ok: true,
      data: { sent: 1 },
    });
    const frame = sock.sent[1]?.content as { contacts: { displayName: string; contacts: { vcard: string }[] } };
    expect(frame.contacts.displayName).toBe('Bob');
    expect(frame.contacts.contacts[0]?.vcard).toContain('FN:Bob');
  });

  it('send_sticker accepts webp and rejects other extensions before sending', async () => {
    const { sock, tools } = await ready();
    const dir = mkdtempSync(path.join(tmpdir(), 'wa-sticker-'));
    const webp = path.join(dir, 's.webp');
    writeFileSync(webp, 'RIFFxxxxWEBP');
    expect(await tools['send_sticker']?.run({ to: '+911234567890', media_path: webp })).toMatchObject({ ok: true });
    expect(sock.sent[0]?.content).toEqual({ sticker: { url: webp } });

    const png = path.join(dir, 's.png');
    writeFileSync(png, 'x');
    expect(await tools['send_sticker']?.run({ to: '+911234567890', media_path: png })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENT' },
    });
    expect(sock.sent).toHaveLength(1);
  });

  it('send_message quotes with reply_to, and rejects an unknown reply id', async () => {
    const { sock, tools } = await ready();
    expect(await tools['send_message']?.run({ to: '+911234567890', text: 're', reply_to: 'M1' })).toMatchObject({ ok: true });
    const frame = sock.sent[0]?.content as { text: string; quoted?: unknown };
    expect(frame.text).toBe('re');
    expect(frame.quoted).toBeDefined();

    expect(await tools['send_message']?.run({ to: '+911234567890', text: 're', reply_to: 'gone' })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENT' },
    });
  });

  it('download_media writes the file and reports bytes/mimetype', async () => {
    const buffer = Buffer.from('PNGDATA');
    const { tools } = await ready({ downloader: async () => ({ buffer, mimetype: 'image/png' }) });
    const dir = mkdtempSync(path.join(tmpdir(), 'wa-dl-'));
    const env = await tools['download_media']?.run({ chat: '+911234567890', message_id: 'I1', save_dir: dir });
    expect(env).toMatchObject({ ok: true, data: { bytes: buffer.length, mimetype: 'image/png' } });
    const file = (env as { data: { path: string } }).data.path;
    expect(file.endsWith('.png')).toBe(true);
    expect(existsSync(file)).toBe(true);
  });

  it('download_media on an unknown id is MEDIA_NOT_FOUND', async () => {
    const { tools } = await ready({ downloader: async () => ({ buffer: Buffer.from('x'), mimetype: 'image/png' }) });
    expect(await tools['download_media']?.run({ chat: '+911234567890', message_id: 'nope' })).toMatchObject({
      ok: false,
      error: { code: 'MEDIA_NOT_FOUND' },
    });
  });

  it('get_group_info returns metadata and rejects non-groups', async () => {
    const { sock, tools } = await ready();
    sock.groups[GROUP] = {
      id: GROUP,
      subject: 'Team',
      owner: '911234567890@s.whatsapp.net',
      participants: [
        { id: '911234567890@s.whatsapp.net', admin: 'admin' },
        { id: '918888888888@s.whatsapp.net', admin: null },
      ],
    };
    expect(await tools['get_group_info']?.run({ chat: GROUP })).toMatchObject({
      ok: true,
      data: { subject: 'Team', participant_count: 2 },
    });
    expect(await tools['get_group_info']?.run({ chat: '+911234567890' })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENT' },
    });
  });

  it('validates args on the new tools', async () => {
    const { tools } = await ready();
    expect(await tools['search_contacts']?.run({ query: '' })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(await tools['send_location']?.run({ to: '+911234567890', latitude: 200, longitude: 0 })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENT' },
    });
    expect(await tools['send_contact']?.run({ to: '+911234567890', contacts: [] })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENT' },
    });
  });
});
