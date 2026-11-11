import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WAMessage } from '@whiskeysockets/baileys';
import { SqliteStore } from '../src/sqlstore.js';

const JID = '911234567890@s.whatsapp.net';

function fresh(): SqliteStore {
  const dir = mkdtempSync(path.join(tmpdir(), 'wa-sqlite-'));
  return new SqliteStore(path.join(dir, 'store.sqlite'));
}

function textMsg(id: string, text: string, ts: number, pushName?: string): WAMessage {
  return {
    key: { id, remoteJid: JID, fromMe: false },
    message: { conversation: text },
    messageTimestamp: ts,
    ...(pushName ? { pushName } : {}),
  } as WAMessage;
}

function imageMsg(id: string, ts: number, mimetype = 'image/png'): WAMessage {
  return {
    key: { id, remoteJid: JID, fromMe: false },
    message: { imageMessage: { mimetype, caption: 'pic' } },
    messageTimestamp: ts,
  } as WAMessage;
}

describe('SqliteStore', () => {
  it('ingests messages, dedupes by id, and marks media', () => {
    const s = fresh();
    expect(s.ingestMessage(textMsg('M1', 'hello', 100, 'Aswath'))).toBe(true);
    expect(s.ingestMessage(textMsg('M1', 'hello again', 100))).toBe(false);
    expect(s.ingestMessage(imageMsg('I1', 200))).toBe(true);
    const msgs = s.getMessages(JID, 10);
    expect(msgs.map((m) => m.id)).toEqual(['M1', 'I1']);
    expect(msgs[1]).toMatchObject({ type: 'image', has_media: true });
  });

  it('search, context, last interaction, chat info', () => {
    const s = fresh();
    s.ingestMessage(textMsg('M1', 'first invoice please', 100, 'Aswath'));
    s.ingestMessage(textMsg('M2', 'hello there', 200));
    s.ingestMessage(textMsg('M3', 'INVOICE is late', 300));
    expect(s.searchMessages('invoice', 10).map((m) => m.id)).toEqual(['M3', 'M1']);
    expect(s.messageContext(JID, 'M2', 1, 1)?.messages.map((m) => m.id)).toEqual(['M1', 'M2', 'M3']);
    expect(s.lastInteraction(JID)?.id).toBe('M3');
    expect(s.getChatInfo(JID)).toMatchObject({ message_count: 3, is_group: false });
    expect(s.getChatInfo('120363012345678901@g.us')).toBeUndefined();
  });

  it('searchContacts and listContacts see the address book', () => {
    const s = fresh();
    s.ingestContacts([
      { id: JID, name: 'Aswath' },
      { id: '918888888888@s.whatsapp.net', name: 'Bob' },
    ]);
    expect(s.searchContacts('asw', 10)).toEqual([{ id: JID, name: 'Aswath', number: '+911234567890' }]);
    expect(s.listContacts(10).map((c) => c.name)).toEqual(['Aswath', 'Bob']);
  });

  it('messagesSince returns a cursor window, oldest first', () => {
    const s = fresh();
    s.ingestMessage(textMsg('M1', 'a', 100));
    s.ingestMessage(textMsg('M2', 'b', 200));
    s.ingestMessage(textMsg('M3', 'c', 300));
    expect(s.messagesSince(150, 10).map((m) => m.id)).toEqual(['M2', 'M3']);
    expect(s.messagesSince(0, 2).map((m) => m.id)).toEqual(['M1', 'M2']);
  });

  it('keeps raw messages for quoting and media download', () => {
    const s = fresh();
    s.ingestMessage(imageMsg('I1', 100));
    expect(s.getRaw('I1')).toBeDefined();
    expect(s.getRaw('nope')).toBeUndefined();
  });

  it('persists across reopen', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wa-sqlite-'));
    const file = path.join(dir, 'store.sqlite');
    const a = new SqliteStore(file);
    a.ingestMessage(textMsg('M1', 'persisted', 100));
    const b = new SqliteStore(file);
    expect(b.getMessages(JID, 10).map((m) => m.text)).toEqual(['persisted']);
  });

  it('flush is a no-op (writes are immediate)', () => {
    expect(fresh().flush()).toBe(false);
  });
});
