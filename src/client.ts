import { EventEmitter } from 'node:events';
import type { AnyMessageContent, Chat, ChatUpdate, ConnectionState, Contact, WAMessage } from '@whiskeysockets/baileys';
import { clearSession, isRegistered, readMe, removeRuntime, writeRuntime } from './auth.js';
import { WaError, notPairedError } from './errors.js';
import { normalizeJid, jidToNumber, normalizePhoneDigits } from './jid.js';
import { assertMediaReadable, buildSendPayloads } from './media.js';
import type { SendInput } from './media.js';
import { DEFAULT_BACKOFF, backoffDelay, initialState, reduce, toStatusReport } from './state.js';
import type { BackoffOptions, ConnEvent, ConnState, StatusReport } from './state.js';
import { ChatStore } from './store.js';
import type { ChatSummary, StoredMessage } from './store.js';

/** The subset of Baileys' socket events this client consumes. */
export interface SocketEvents {
  'connection.update': Partial<ConnectionState>;
  'creds.update': unknown;
  'messages.upsert': { messages: WAMessage[]; type: string };
  'messaging-history.set': { chats: Chat[]; contacts: Contact[]; messages: WAMessage[] };
  'chats.upsert': Chat[];
  'chats.update': ChatUpdate[];
  'contacts.upsert': Contact[];
  'contacts.update': Partial<Contact>[];
}

/** The subset of Baileys' WASocket this client uses (lets tests inject a fake). */
export interface WaSocketLike {
  ev: { on<K extends keyof SocketEvents>(event: K, listener: (arg: SocketEvents[K]) => void): unknown };
  user?: { id: string; name?: string; lid?: string } | undefined;
  sendMessage(jid: string, content: AnyMessageContent): Promise<WAMessage | undefined>;
  requestPairingCode(phone: string): Promise<string>;
  logout(msg?: string): Promise<void>;
  end(error: Error | undefined): void;
}

export type SocketFactory = (ctx: { authDir: string }) => Promise<{ sock: WaSocketLike; saveCreds: () => Promise<void> }>;

export interface Timers {
  set(fn: () => void, ms: number): () => void;
}

export const realTimers: Timers = {
  set(fn, ms) {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};

export interface ClientOptions {
  authDir: string;
  factory: SocketFactory;
  store?: ChatStore;
  now?: () => number;
  timers?: Timers;
  backoff?: BackoffOptions;
  rand?: () => number;
  log?: (msg: string) => void;
  /** How long a send waits for the socket to (re)connect. */
  connectWaitMs?: number;
  /** Publish runtime.json so the CLI can see a live server. */
  publishRuntime?: boolean;
}

export interface StartOptions {
  /** Connect even when not registered (CLI `pair`). Servers leave this false. */
  allowPairing?: boolean;
  /** Use a phone pairing code instead of a QR. */
  pairingPhone?: string;
}

export interface Profile {
  number: string | null;
  jid: string;
  name: string | null;
  lid: string | null;
}

export interface SendResult {
  to: string;
  message_ids: string[];
  parts: number;
}

export interface FullStatus extends StatusReport {
  me: { number: string | null; name: string | null } | null;
  hint?: string;
}

const RESTART_REQUIRED = 515;
const LOGGED_OUT = 401;
const CONNECTION_REPLACED = 440;

/** Extract an HTTP-ish status code from a Boom/Error without depending on Boom types. */
export function statusCodeOf(err: unknown): number | undefined {
  if (err && typeof err === 'object') {
    const output = (err as { output?: { statusCode?: unknown } }).output;
    if (output && typeof output.statusCode === 'number') return output.statusCode;
    const status = (err as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number') return status;
  }
  return undefined;
}

export class WaClient {
  private readonly bus = new EventEmitter();
  private readonly store: ChatStore;
  private readonly now: () => number;
  private readonly timers: Timers;
  private readonly backoff: BackoffOptions;
  private readonly rand: () => number;
  private readonly log: (msg: string) => void;
  private readonly connectWaitMs: number;
  private st: ConnState;
  private sock: WaSocketLike | undefined;
  private gen = 0;
  private attempt = 0;
  private connecting = false;
  private stopped = false;
  private started = false;
  private allowPairing = false;
  private pairingPhone: string | undefined;
  private codeRequested = false;
  private cancelReconnect: (() => void) | undefined;
  private cancelFlush: (() => void) | undefined;
  private credsChain: Promise<void> = Promise.resolve();

  constructor(private readonly opts: ClientOptions) {
    this.now = opts.now ?? Date.now;
    this.timers = opts.timers ?? realTimers;
    this.backoff = opts.backoff ?? DEFAULT_BACKOFF;
    this.rand = opts.rand ?? Math.random;
    this.log = opts.log ?? (() => undefined);
    this.connectWaitMs = opts.connectWaitMs ?? 20_000;
    this.store = opts.store ?? new ChatStore();
    this.st = initialState(this.now());
    this.apply({ type: 'init', registered: isRegistered(opts.authDir) });
  }

  // ---- observation ---------------------------------------------------------

  get state(): ConnState {
    return this.st;
  }

  onState(fn: (s: ConnState) => void): () => void {
    this.bus.on('state', fn);
    return () => this.bus.off('state', fn);
  }

  onQr(fn: (qr: string) => void): () => void {
    this.bus.on('qr', fn);
    return () => this.bus.off('qr', fn);
  }

  onPairingCode(fn: (code: string) => void): () => void {
    this.bus.on('pairing-code', fn);
    return () => this.bus.off('pairing-code', fn);
  }

  private apply(event: ConnEvent): void {
    this.st = reduce(this.st, event, this.now());
    this.bus.emit('state', this.st);
    if (this.opts.publishRuntime) {
      writeRuntime(this.opts.authDir, {
        pid: process.pid,
        startedAt: new Date(this.st.startedAt).toISOString(),
        status: this.st.status,
        connected: this.st.connected,
        lastReconnect: this.st.lastReconnectAt === null ? null : new Date(this.st.lastReconnectAt).toISOString(),
        updatedAt: new Date(this.now()).toISOString(),
      });
    }
  }

  status(): FullStatus {
    const report = toStatusReport(this.st, this.now());
    const me = this.me();
    const out: FullStatus = {
      ...report,
      me: me ? { number: jidToNumber(me.id) ?? null, name: me.name ?? null } : null,
    };
    if (this.st.status === 'not_paired') out.hint = 'not paired, run: node dist/cli.js pair';
    return out;
  }

  private me(): { id: string; name?: string; lid?: string } | undefined {
    return this.sock?.user ?? readMe(this.opts.authDir);
  }

  // ---- lifecycle -----------------------------------------------------------

  /** Begin connecting. Resolves once the first socket is created (not once open). */
  async start(options: StartOptions = {}): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.allowPairing = options.allowPairing ?? false;
    this.pairingPhone = options.pairingPhone ? normalizePhoneDigits(options.pairingPhone) : undefined;
    const registered = isRegistered(this.opts.authDir);
    this.apply({ type: 'init', registered });
    if (!registered && !this.allowPairing) return;
    await this.connect();
  }

  /** Re-check disk and (re)connect if this client is idle but a session now exists. */
  async ensureStarted(): Promise<void> {
    if (this.stopped || this.sock || this.connecting || this.cancelReconnect) return;
    if (!isRegistered(this.opts.authDir)) return;
    this.apply({ type: 'init', registered: true });
    this.started = true;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.gen++;
    this.cancelReconnect?.();
    this.cancelReconnect = undefined;
    this.cancelFlush?.();
    this.cancelFlush = undefined;
    try {
      this.sock?.end(undefined);
    } catch {
      /* already closed */
    }
    this.sock = undefined;
    await this.credsChain;
    try {
      this.store.flush();
    } catch (err) {
      this.log(`store flush failed: ${String(err)}`);
    }
    if (this.opts.publishRuntime) removeRuntime(this.opts.authDir, process.pid);
    this.apply({ type: 'close' });
  }

  /** Resolve when the predicate holds for the connection state, or reject on timeout. */
  waitFor(pred: (s: ConnState) => boolean, ms: number, onTimeout: () => WaError): Promise<void> {
    if (pred(this.st)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let off: () => void = () => undefined;
      const cancel = this.timers.set(() => {
        off();
        reject(onTimeout());
      }, ms);
      off = this.onState((s) => {
        if (pred(s)) {
          cancel();
          off();
          resolve();
        }
      });
    });
  }

  /** CLI pairing: connect and wait until the session is paired and open. */
  async pair(options: { phone?: string; timeoutMs?: number } = {}): Promise<void> {
    const startOpts: StartOptions = { allowPairing: true };
    if (options.phone) startOpts.pairingPhone = options.phone;
    await this.start(startOpts);
    await this.waitFor(
      (s) => s.status === 'paired' && s.connected,
      options.timeoutMs ?? 180_000,
      () => new WaError('NOT_CONNECTED', 'Pairing timed out. Run the pair command again.'),
    );
  }

  // ---- connection ----------------------------------------------------------

  private async connect(): Promise<void> {
    if (this.stopped || this.connecting) return;
    this.connecting = true;
    const gen = ++this.gen;
    try {
      const { sock, saveCreds } = await this.opts.factory({ authDir: this.opts.authDir });
      if (this.stopped || gen !== this.gen) {
        try {
          sock.end(undefined);
        } catch {
          /* ignore */
        }
        return;
      }
      this.sock = sock;
      this.codeRequested = false;
      this.bind(sock, saveCreds, gen);
    } catch (err) {
      this.log(`socket creation failed: ${String(err)}`);
      this.sock = undefined;
      this.apply({ type: 'close', message: err instanceof Error ? err.message : String(err) });
      this.scheduleReconnect(false);
    } finally {
      this.connecting = false;
    }
  }

  private bind(sock: WaSocketLike, saveCreds: () => Promise<void>, gen: number): void {
    const guard =
      <T>(label: string, fn: (arg: T) => void) =>
      (arg: T): void => {
        if (gen !== this.gen) return;
        try {
          fn(arg);
        } catch (err) {
          this.log(`${label} handler failed: ${String(err)}`);
        }
      };

    sock.ev.on(
      'creds.update',
      guard('creds.update', () => {
        this.credsChain = this.credsChain.then(saveCreds).catch((err: unknown) => {
          this.log(`saveCreds failed: ${String(err)}`);
        });
      }),
    );
    sock.ev.on('connection.update', guard('connection.update', (u) => this.onConnectionUpdate(sock, u)));
    sock.ev.on(
      'messages.upsert',
      guard('messages.upsert', ({ messages }) => {
        for (const m of messages) this.safeIngest(m);
        this.scheduleFlush();
      }),
    );
    sock.ev.on(
      'messaging-history.set',
      guard('messaging-history.set', ({ chats, contacts, messages }) => {
        this.store.ingestContacts(contacts);
        this.store.ingestChats(chats);
        for (const m of messages) this.safeIngest(m);
        this.scheduleFlush();
      }),
    );
    sock.ev.on(
      'chats.upsert',
      guard('chats.upsert', (chats) => {
        this.store.ingestChats(chats);
        this.scheduleFlush();
      }),
    );
    sock.ev.on(
      'chats.update',
      guard('chats.update', (updates) => {
        this.store.ingestChats(updates.filter((u) => Boolean(u.id)).map((u) => ({ ...u }) as Chat));
        this.scheduleFlush();
      }),
    );
    sock.ev.on(
      'contacts.upsert',
      guard('contacts.upsert', (c) => {
        this.store.ingestContacts(c);
        this.scheduleFlush();
      }),
    );
    sock.ev.on(
      'contacts.update',
      guard('contacts.update', (c) => {
        this.store.ingestContacts(c);
        this.scheduleFlush();
      }),
    );
  }

  private safeIngest(m: WAMessage): void {
    try {
      this.store.ingestMessage(m);
    } catch (err) {
      this.log(`dropping malformed message: ${String(err)}`);
    }
  }

  private scheduleFlush(): void {
    if (this.cancelFlush) return;
    this.cancelFlush = this.timers.set(() => {
      this.cancelFlush = undefined;
      try {
        this.store.flush();
      } catch (err) {
        this.log(`store flush failed: ${String(err)}`);
      }
    }, 2000);
  }

  private onConnectionUpdate(sock: WaSocketLike, u: Partial<ConnectionState>): void {
    if (u.qr) {
      if (this.pairingPhone) {
        void this.requestCode(sock, this.pairingPhone);
      } else {
        this.apply({ type: 'qr' });
        this.bus.emit('qr', u.qr);
      }
    }
    if (u.connection === 'open') {
      this.attempt = 0;
      this.apply({ type: 'open' });
    }
    if (u.connection === 'close') {
      const err = u.lastDisconnect?.error;
      const code = statusCodeOf(err);
      this.sock = undefined;
      const closeEvent: ConnEvent = { type: 'close' };
      if (code !== undefined) closeEvent.code = code;
      if (err?.message) closeEvent.message = err.message;
      this.apply(closeEvent);
      this.handleClose(code);
    }
  }

  private async requestCode(sock: WaSocketLike, phone: string): Promise<void> {
    if (this.codeRequested) return;
    this.codeRequested = true;
    try {
      const code = await sock.requestPairingCode(phone);
      this.apply({ type: 'pairing_code' });
      this.bus.emit('pairing-code', code);
    } catch (err) {
      this.codeRequested = false;
      this.log(`requestPairingCode failed: ${String(err)}`);
    }
  }

  private handleClose(code: number | undefined): void {
    if (this.stopped) return;
    if (code === LOGGED_OUT) {
      try {
        clearSession(this.opts.authDir);
      } catch (err) {
        this.log(`clearSession failed: ${String(err)}`);
      }
      this.apply({ type: 'logged_out' });
      return;
    }
    if (code === CONNECTION_REPLACED) {
      // Another process took the session. Don't fight it; the next tool call reconnects.
      return;
    }
    if (code === RESTART_REQUIRED) {
      this.scheduleReconnect(true);
      return;
    }
    if (this.st.status === 'not_paired' && !this.allowPairing) return;
    this.scheduleReconnect(false);
  }

  private scheduleReconnect(immediate: boolean): void {
    if (this.stopped || this.cancelReconnect) return;
    const delay = immediate ? 0 : backoffDelay(this.attempt++, this.backoff, this.rand);
    this.log(`reconnecting in ${delay}ms`);
    this.cancelReconnect = this.timers.set(() => {
      this.cancelReconnect = undefined;
      this.apply({ type: 'reconnecting' });
      void this.connect();
    }, delay);
  }

  // ---- operations ----------------------------------------------------------

  private async requireReady(): Promise<WaSocketLike> {
    await this.ensureStarted();
    if (!isRegistered(this.opts.authDir)) throw notPairedError();
    await this.waitFor(
      (s) => s.connected,
      this.connectWaitMs,
      () => new WaError('NOT_CONNECTED', 'Not connected to WhatsApp yet (reconnecting). Retry in a few seconds.'),
    );
    if (!this.sock) throw new WaError('NOT_CONNECTED', 'Not connected to WhatsApp. Retry in a few seconds.');
    return this.sock;
  }

  private requirePaired(): void {
    if (this.st.status !== 'paired' && !isRegistered(this.opts.authDir)) throw notPairedError();
  }

  async send(to: string, input: SendInput): Promise<SendResult> {
    const jid = normalizeJid(to);
    const payloads = buildSendPayloads(input);
    if (input.mediaPath) await assertMediaReadable(input.mediaPath);
    const sock = await this.requireReady();
    const ids: string[] = [];
    for (const content of payloads) {
      let sent: WAMessage | undefined;
      try {
        sent = await sock.sendMessage(jid, content);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new WaError('SEND_FAILED', `WhatsApp rejected the send: ${msg}`);
      }
      if (sent?.key?.id) {
        ids.push(sent.key.id);
        this.safeIngest(sent);
      }
    }
    this.scheduleFlush();
    return { to: jid, message_ids: ids, parts: payloads.length };
  }

  getProfile(): Profile {
    this.requirePaired();
    const me = this.me();
    if (!me) throw new WaError('NOT_CONNECTED', 'Profile not available yet. Retry in a few seconds.');
    return {
      number: jidToNumber(me.id) ?? null,
      jid: me.id,
      name: me.name ?? null,
      lid: me.lid ?? null,
    };
  }

  async listChats(limit: number): Promise<ChatSummary[]> {
    await this.ensureStarted();
    this.requirePaired();
    return this.store.listChats(limit);
  }

  async getMessages(chat: string, limit: number): Promise<StoredMessage[]> {
    await this.ensureStarted();
    this.requirePaired();
    return this.store.getMessages(normalizeJid(chat), limit);
  }

  async logout(): Promise<void> {
    await this.sock?.logout();
  }
}
