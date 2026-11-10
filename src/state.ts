export type PairStatus = 'paired' | 'pairing' | 'not_paired';

export interface ConnState {
  status: PairStatus;
  /** Socket currently open to WhatsApp. */
  connected: boolean;
  /** ms epoch when the client was created. */
  startedAt: number;
  /** ms epoch when the socket last opened. */
  connectedSince: number | null;
  /** ms epoch of the last reconnect attempt (not the first connect). */
  lastReconnectAt: number | null;
  reconnectCount: number;
  lastDisconnectCode: number | null;
  lastError: string | null;
}

export type ConnEvent =
  | { type: 'init'; registered: boolean }
  | { type: 'qr' }
  | { type: 'pairing_code' }
  | { type: 'open' }
  | { type: 'close'; code?: number; message?: string }
  | { type: 'reconnecting' }
  | { type: 'logged_out' };

export function initialState(now: number): ConnState {
  return {
    status: 'not_paired',
    connected: false,
    startedAt: now,
    connectedSince: null,
    lastReconnectAt: null,
    reconnectCount: 0,
    lastDisconnectCode: null,
    lastError: null,
  };
}

/** Pure reducer: pairing state machine + connection bookkeeping. */
export function reduce(state: ConnState, event: ConnEvent, now: number): ConnState {
  switch (event.type) {
    case 'init':
      return { ...state, status: event.registered ? 'paired' : 'not_paired' };
    case 'qr':
    case 'pairing_code':
      // A QR / pairing code only exists for unregistered sessions.
      return state.status === 'paired' ? state : { ...state, status: 'pairing' };
    case 'open':
      return { ...state, status: 'paired', connected: true, connectedSince: now, lastError: null };
    case 'close':
      return {
        ...state,
        connected: false,
        connectedSince: null,
        lastDisconnectCode: event.code ?? null,
        lastError: event.message ?? state.lastError,
      };
    case 'reconnecting':
      return { ...state, lastReconnectAt: now, reconnectCount: state.reconnectCount + 1 };
    case 'logged_out':
      return { ...state, status: 'not_paired', connected: false, connectedSince: null };
  }
}

export interface StatusReport {
  status: PairStatus;
  connected: boolean;
  uptime_s: number;
  connected_for_s: number | null;
  last_reconnect: string | null;
  reconnect_count: number;
  last_disconnect_code: number | null;
  last_error: string | null;
}

export function toStatusReport(s: ConnState, now: number): StatusReport {
  return {
    status: s.status,
    connected: s.connected,
    uptime_s: Math.max(0, Math.round((now - s.startedAt) / 1000)),
    connected_for_s: s.connectedSince === null ? null : Math.max(0, Math.round((now - s.connectedSince) / 1000)),
    last_reconnect: s.lastReconnectAt === null ? null : new Date(s.lastReconnectAt).toISOString(),
    reconnect_count: s.reconnectCount,
    last_disconnect_code: s.lastDisconnectCode,
    last_error: s.lastError,
  };
}

export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  /** 0..1 fraction of the delay randomised downward. */
  jitter: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 1000, maxMs: 60_000, jitter: 0.25 };

/** Exponential backoff with jitter. `attempt` starts at 0. `rand` returns [0,1). */
export function backoffDelay(attempt: number, opts: BackoffOptions = DEFAULT_BACKOFF, rand: () => number = Math.random): number {
  const exp = Math.min(opts.maxMs, opts.baseMs * 2 ** Math.max(0, attempt));
  return Math.round(exp * (1 - opts.jitter * rand()));
}
