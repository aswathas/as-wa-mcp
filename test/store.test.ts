import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { WAMessage } from '@whiskeysockets/baileys';
import { describe, expect, it } from 'vitest';
import { ChatStore, describeMessage } from '../src/store.js';

const msg = (id: string, ts: number, message: WAMessage['message'], extra: Partial<WAMessage['key']> = {}): WAMessage => ({
  key: { id, remoteJid: '911111111111@s.whatsapp.net', fromMe: false, ...extra },
  message,
  messageTimestamp: ts,
});

describe('describeMessage', () => {
  it('renders text, captions and bare media', () => {
    expect(describeMessage(msg('1', 1, { conversation: 'hi' }))).toEqual({ type: 'text', text: 'hi' });
    expect(describeMessage(msg('1', 1, { extendedTextMessage: { text: 'link' } }))).toEqual({ type: 'text', text: 'link' });
    expect(describeMessage(msg('1', 1, { imageMessage: { caption: 'sunset' } }))).toEqual({ type: 'image', text: '[image] sunset' });
    expect(describeMessage(msg('1', 1, { audioMessage: {} }))).toEqual({ type: 'audio', text: '[audio]' });
    expect(describeMessage(msg('1', 1, { documentMessage: { fileName: 'a.pdf' } }))).toEqual({ type: 'document', text: '[document] a.pdf' });
  });
  it('skips protocol noise', () => {
    expect(describeMessage(msg('1', 1, { protocolMessage: {} }))).toBeUndefined();
    expect(describeMessage(msg('1', 1, undefined))).toBeUndefined();
  });
});

describe('ChatStore', () => {
  it('dedupes, orders, limits and persists', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'wa-store-')), 'store.json');
    const s = new ChatStore(file);
    expect(s.ingestMessage(msg('b', 20, { conversation: 'two' }))).toBe(true);
    expect(s.ingestMessage(msg('a', 10, { conversation: 'one' }))).toBe(true);
    expect(s.ingestMessage(msg('a', 10, { conversation: 'one' }))).toBe(false);
    expect(s.ingestMessage(msg('s', 30, { conversation: 'st' }, { remoteJid: 'status@broadcast' }))).toBe(false);
    expect(s.getMessages('911111111111@s.whatsapp.net', 10).map((m) => m.text)).toEqual(['one', 'two']);
    expect(s.getMessages('911111111111@s.whatsapp.net', 1).map((m) => m.text)).toEqual(['two']);
    expect(s.flush()).toBe(true);
    expect(s.flush()).toBe(false);
    const reloaded = new ChatStore(file);
    expect(reloaded.listChats(5)).toMatchObject([{ id: '911111111111@s.whatsapp.net', last_ts: 20 }]);
  });
  it('sorts chats newest first and uses LID alt JIDs', () => {
    const s = new ChatStore();
    s.ingestMessage(msg('1', 10, { conversation: 'a' }, { remoteJid: '9@s.whatsapp.net' }));
    s.ingestMessage(msg('2', 50, { conversation: 'b' }, { remoteJid: '777@lid', remoteJidAlt: '922222222222@s.whatsapp.net' }));
    expect(s.listChats(10).map((c) => c.id)).toEqual(['922222222222@s.whatsapp.net', '9@s.whatsapp.net']);
  });
});
