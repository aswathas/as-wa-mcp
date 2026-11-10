import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WaError } from '../src/errors.js';
import { buildSendPayloads, classifyMedia } from '../src/media.js';
import { makeHarness } from './helpers.js';

describe('send_message frame construction', () => {
  it('text', () => {
    expect(buildSendPayloads({ text: 'hi' })).toEqual([{ text: 'hi' }]);
  });
  it('requires text or media', () => {
    expect(() => buildSendPayloads({ text: '  ' })).toThrow(WaError);
  });
  it('image uses caption, falling back to text', () => {
    expect(buildSendPayloads({ mediaPath: '/a/b.PNG', caption: 'c' })).toEqual([{ image: { url: '/a/b.PNG' }, caption: 'c' }]);
    expect(buildSendPayloads({ mediaPath: '/a/b.jpg', text: 't' })).toEqual([{ image: { url: '/a/b.jpg' }, caption: 't' }]);
    expect(buildSendPayloads({ mediaPath: '/a/b.jpg' })).toEqual([{ image: { url: '/a/b.jpg' } }]);
  });
  it('video', () => {
    expect(buildSendPayloads({ mediaPath: '/a/v.mp4', caption: 'c' })).toEqual([{ video: { url: '/a/v.mp4' }, caption: 'c' }]);
  });
  it('document carries mimetype and fileName', () => {
    expect(buildSendPayloads({ mediaPath: '/a/Report.pdf', caption: 'Q3' })).toEqual([
      { document: { url: '/a/Report.pdf' }, mimetype: 'application/pdf', fileName: 'Report.pdf', caption: 'Q3' },
    ]);
  });
  it('unknown extension falls back to a generic document', () => {
    expect(classifyMedia('/a/file.xyz')).toEqual({ kind: 'document', mime: 'application/octet-stream', fileName: 'file.xyz' });
  });
  it('audio sends the clip, then caption as separate text; ogg is a voice note', () => {
    expect(buildSendPayloads({ mediaPath: '/a/v.mp3', caption: 'listen' })).toEqual([
      { audio: { url: '/a/v.mp3' }, mimetype: 'audio/mpeg', ptt: false },
      { text: 'listen' },
    ]);
    const [ogg] = buildSendPayloads({ mediaPath: '/a/v.ogg' });
    expect(ogg).toMatchObject({ ptt: true, mimetype: 'audio/ogg; codecs=opus' });
  });
});

describe('WaClient.send', () => {
  async function connected() {
    const h = makeHarness(true);
    await h.client.start();
    h.sockets[0]?.emit('connection.update', { connection: 'open' });
    return h;
  }

  it('normalizes the recipient and hands the frame to the socket', async () => {
    const h = await connected();
    const res = await h.client.send('+91 12345 67890', { text: 'hello' });
    expect(h.sockets[0]?.sent).toEqual([{ jid: '911234567890@s.whatsapp.net', content: { text: 'hello' } }]);
    expect(res).toMatchObject({ to: '911234567890@s.whatsapp.net', parts: 1, message_ids: ['MSG1'] });
  });

  it('sends media from a real file path', async () => {
    const h = await connected();
    const dir = mkdtempSync(path.join(tmpdir(), 'wa-media-'));
    const file = path.join(dir, 'pic.jpg');
    writeFileSync(file, 'x');
    await h.client.send('120363012345678901@g.us', { mediaPath: file, caption: 'look' });
    expect(h.sockets[0]?.sent[0]).toEqual({ jid: '120363012345678901@g.us', content: { image: { url: file }, caption: 'look' } });
  });

  it('rejects missing media with MEDIA_NOT_FOUND before touching the socket', async () => {
    const h = await connected();
    await expect(h.client.send('+911234567890', { mediaPath: path.join(tmpdir(), 'nope-404.png') })).rejects.toMatchObject({
      code: 'MEDIA_NOT_FOUND',
    });
    expect(h.sockets[0]?.sent).toHaveLength(0);
  });

  it('rejects a bad recipient with INVALID_RECIPIENT', async () => {
    const h = await connected();
    await expect(h.client.send('nope', { text: 'x' })).rejects.toMatchObject({ code: 'INVALID_RECIPIENT' });
  });

  it('maps a socket failure to SEND_FAILED', async () => {
    const h = await connected();
    const sock = h.sockets[0];
    if (!sock) throw new Error('no socket');
    sock.sendImpl = async () => {
      throw new Error('boom');
    };
    await expect(h.client.send('+911234567890', { text: 'x' })).rejects.toMatchObject({ code: 'SEND_FAILED' });
  });

  it('is NOT_PAIRED without a session', async () => {
    const h = makeHarness(false);
    await h.client.start();
    expect(h.sockets).toHaveLength(0);
    await expect(h.client.send('+911234567890', { text: 'x' })).rejects.toMatchObject({ code: 'NOT_PAIRED' });
  });

  it('is NOT_CONNECTED when paired but the socket never opens', async () => {
    const h = makeHarness(true, { connectWaitMs: 1 });
    await h.client.start();
    // ManualTimers never fire on their own, so wait for the 1ms send timer manually.
    const p = h.client.send('+911234567890', { text: 'x' });
    await new Promise((r) => setTimeout(r, 5));
    h.timers.queue.filter((t) => t.ms === 1).forEach((t) => t.fn());
    await expect(p).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    expect(existsSync(h.authDir)).toBe(true);
  });
});
