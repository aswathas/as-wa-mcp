import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeHarness } from './helpers.js';

const boom = (statusCode: number) => ({ error: Object.assign(new Error(`closed ${statusCode}`), { output: { statusCode } }), date: new Date() });

describe('WaClient lifecycle', () => {
  it('does not connect when not paired (server mode) and reports not_paired + hint', async () => {
    const h = makeHarness(false);
    await h.client.start();
    expect(h.sockets).toHaveLength(0);
    expect(h.client.status()).toMatchObject({ status: 'not_paired', connected: false, hint: 'not paired, run: node dist/cli.js pair' });
  });

  it('paired session connects and reports connected', async () => {
    const h = makeHarness(true);
    await h.client.start();
    expect(h.client.status()).toMatchObject({ status: 'paired', connected: false, me: { number: '+911234567890', name: 'Aswath' } });
    h.sockets[0]?.emit('connection.update', { connection: 'open' });
    expect(h.client.status()).toMatchObject({ status: 'paired', connected: true });
    expect(h.client.getProfile()).toMatchObject({ number: '+911234567890', name: 'Aswath', lid: '1234@lid' });
  });

  it('QR pairing: not_paired -> pairing (qr emitted) -> restart(515) -> paired', async () => {
    const h = makeHarness(false);
    const qrs: string[] = [];
    h.client.onQr((q) => qrs.push(q));
    await h.client.start({ allowPairing: true });
    const s0 = h.sockets[0];
    s0?.emit('connection.update', { qr: 'QR-1' });
    expect(qrs).toEqual(['QR-1']);
    expect(h.client.state.status).toBe('pairing');

    // WhatsApp closes the socket after a successful scan; creds now registered.
    writeFileSync(path.join(h.authDir, 'creds.json'), JSON.stringify({ registered: true, me: { id: '911234567890:1@s.whatsapp.net' } }));
    s0?.emit('connection.update', { connection: 'close', lastDisconnect: boom(515) });
    expect(h.timers.pending()).toEqual([0]); // immediate restart, no backoff
    h.timers.fireNext();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.sockets).toHaveLength(2);
    h.sockets[1]?.emit('connection.update', { connection: 'open' });
    expect(h.client.status()).toMatchObject({ status: 'paired', connected: true, reconnect_count: 1 });
  });

  it('phone pairing requests a code once, on first qr', async () => {
    const h = makeHarness(false);
    const codes: string[] = [];
    h.client.onPairingCode((c) => codes.push(c));
    await h.client.start({ allowPairing: true, pairingPhone: '+91 12345 67890' });
    const s = h.sockets[0];
    s?.emit('connection.update', { qr: 'a' });
    s?.emit('connection.update', { qr: 'b' });
    await new Promise((r) => setTimeout(r, 0));
    expect(s?.pairingRequests).toEqual(['911234567890']);
    expect(codes).toEqual(['ABCD-1234']);
    expect(h.client.state.status).toBe('pairing');
  });

  it('reconnects with exponential backoff after drops, and resets after open', async () => {
    const h = makeHarness(true);
    await h.client.start();
    const drop = async (n: number) => {
      h.sockets[n]?.emit('connection.update', { connection: 'close', lastDisconnect: boom(408) });
      const [delay] = h.timers.pending();
      h.timers.fireNext();
      await new Promise((r) => setTimeout(r, 0));
      return delay;
    };
    expect(await drop(0)).toBe(1000);
    expect(await drop(1)).toBe(2000);
    expect(await drop(2)).toBe(4000);
    expect(h.client.status()).toMatchObject({ status: 'paired', connected: false, reconnect_count: 3, last_disconnect_code: 408 });
    h.sockets[3]?.emit('connection.update', { connection: 'open' });
    expect(await drop(3)).toBe(1000); // attempt counter reset
  });

  it('retries with backoff when socket creation itself fails', async () => {
    let calls = 0;
    const h = makeHarness(true, {
      factory: async () => {
        calls++;
        throw new Error('network down');
      },
    });
    await h.client.start();
    expect(calls).toBe(1);
    expect(h.timers.pending()).toEqual([1000]);
    expect(h.client.status().last_error).toBe('network down');
    h.timers.fireNext();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(2);
    expect(h.timers.pending()).toEqual([2000]);
  });

  it('logged out (401): clears the session, goes not_paired, does not reconnect', async () => {
    const h = makeHarness(true);
    await h.client.start();
    h.sockets[0]?.emit('connection.update', { connection: 'open' });
    writeFileSync(path.join(h.authDir, 'store.json'), '{}');
    h.sockets[0]?.emit('connection.update', { connection: 'close', lastDisconnect: boom(401) });
    expect(h.client.status()).toMatchObject({ status: 'not_paired', connected: false });
    expect(h.timers.pending()).toEqual([]);
    expect(existsSync(path.join(h.authDir, 'creds.json'))).toBe(false);
    expect(readdirSync(h.authDir)).toEqual(['store.json']);
  });

  it('connection replaced (440): no reconnect loop; next tool call reconnects', async () => {
    const h = makeHarness(true);
    await h.client.start();
    h.sockets[0]?.emit('connection.update', { connection: 'open' });
    h.sockets[0]?.emit('connection.update', { connection: 'close', lastDisconnect: boom(440) });
    expect(h.timers.pending()).toEqual([]);
    await h.client.ensureStarted();
    expect(h.sockets).toHaveLength(2);
  });

  it('picks up a session paired after server start (ensureStarted)', async () => {
    const h = makeHarness(false);
    await h.client.start();
    expect(h.sockets).toHaveLength(0);
    writeFileSync(path.join(h.authDir, 'creds.json'), JSON.stringify({ registered: true, me: { id: '911234567890:1@s.whatsapp.net' } }));
    await h.client.ensureStarted();
    expect(h.sockets).toHaveLength(1);
    expect(h.client.state.status).toBe('paired');
  });

  it('a malformed message event does not crash the client; later messages still stored', async () => {
    const h = makeHarness(true);
    await h.client.start();
    const s = h.sockets[0];
    s?.emit('connection.update', { connection: 'open' });
    expect(() =>
      s?.emit('messages.upsert', {
        type: 'notify',
        // deliberately broken shapes
        messages: [null as never, { key: null, message: 5 } as never, { key: { id: 'x' } } as never],
      }),
    ).not.toThrow();
    s?.emit('messages.upsert', {
      type: 'notify',
      messages: [
        { key: { id: 'A1', remoteJid: '911111111111@s.whatsapp.net', fromMe: false }, message: { conversation: 'hey' }, messageTimestamp: 1700000100, pushName: 'Bob' },
      ],
    });
    expect(await h.client.getMessages('+911111111111', 10)).toMatchObject([{ id: 'A1', text: 'hey', fromMe: false }]);
    expect(await h.client.listChats(5)).toMatchObject([{ id: '911111111111@s.whatsapp.net', name: 'Bob', last_ts: 1700000100 }]);
  });

  it('stop() ends the socket and cancels timers', async () => {
    const h = makeHarness(true);
    await h.client.start();
    h.sockets[0]?.emit('connection.update', { connection: 'open' });
    await h.client.stop();
    expect(h.sockets[0]?.ended).toBe(true);

    const h2 = makeHarness(true);
    await h2.client.start();
    h2.sockets[0]?.emit('connection.update', { connection: 'close', lastDisconnect: boom(408) });
    expect(h2.timers.pending()).toHaveLength(1);
    await h2.client.stop();
    expect(h2.timers.pending()).toEqual([]);
  });
});
