import { describe, expect, it } from 'vitest';
import { backoffDelay, initialState, reduce, toStatusReport } from '../src/state.js';
import type { ConnEvent, ConnState } from '../src/state.js';

const run = (events: ConnEvent[], start: ConnState = initialState(0)): ConnState =>
  events.reduce((s, e, i) => reduce(s, e, (i + 1) * 1000), start);

describe('pairing state machine', () => {
  it('starts not_paired for an unregistered session', () => {
    expect(run([{ type: 'init', registered: false }]).status).toBe('not_paired');
  });
  it('starts paired for a registered session (offline)', () => {
    const s = run([{ type: 'init', registered: true }]);
    expect(s.status).toBe('paired');
    expect(s.connected).toBe(false);
  });
  it('not_paired -> pairing on qr -> paired on open', () => {
    const s1 = run([{ type: 'init', registered: false }, { type: 'qr' }]);
    expect(s1.status).toBe('pairing');
    const s2 = run([{ type: 'open' }], s1);
    expect(s2.status).toBe('paired');
    expect(s2.connected).toBe(true);
  });
  it('stays pairing across the post-scan restart close', () => {
    const s = run([{ type: 'init', registered: false }, { type: 'qr' }, { type: 'close', code: 515 }, { type: 'reconnecting' }]);
    expect(s.status).toBe('pairing');
    expect(s.lastDisconnectCode).toBe(515);
    expect(s.reconnectCount).toBe(1);
  });
  it('a qr never downgrades a paired session', () => {
    expect(run([{ type: 'init', registered: true }, { type: 'qr' }]).status).toBe('paired');
  });
  it('logout returns to not_paired', () => {
    const s = run([{ type: 'init', registered: true }, { type: 'open' }, { type: 'close', code: 401 }, { type: 'logged_out' }]);
    expect(s.status).toBe('not_paired');
    expect(s.connected).toBe(false);
  });
});

describe('get_status transitions', () => {
  it('tracks connection, reconnects and uptime', () => {
    let s = run([{ type: 'init', registered: true }, { type: 'open' }]);
    expect(toStatusReport(s, 10_000).connected).toBe(true);
    s = reduce(s, { type: 'close', code: 408, message: 'timeout' }, 11_000);
    s = reduce(s, { type: 'reconnecting' }, 12_000);
    s = reduce(s, { type: 'open' }, 13_000);
    const r = toStatusReport(s, 20_000);
    expect(r).toMatchObject({
      status: 'paired',
      connected: true,
      uptime_s: 20,
      connected_for_s: 7,
      reconnect_count: 1,
      last_reconnect: new Date(12_000).toISOString(),
      last_error: null,
    });
  });
  it('records last error while disconnected', () => {
    const s = run([{ type: 'init', registered: true }, { type: 'open' }, { type: 'close', code: 428, message: 'closed' }]);
    expect(toStatusReport(s, 9000)).toMatchObject({ connected: false, last_disconnect_code: 428, last_error: 'closed', connected_for_s: null });
  });
});

describe('backoffDelay', () => {
  const opts = { baseMs: 1000, maxMs: 60_000, jitter: 0.25 };
  it('grows exponentially and caps', () => {
    const delays = [0, 1, 2, 3, 4, 5, 6, 7, 20].map((n) => backoffDelay(n, opts, () => 0));
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  });
  it('applies downward jitter only', () => {
    expect(backoffDelay(2, opts, () => 0.999)).toBeGreaterThanOrEqual(3000);
    expect(backoffDelay(2, opts, () => 0.999)).toBeLessThanOrEqual(4000);
  });
});
