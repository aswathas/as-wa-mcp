import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Contact, WAMessage } from '@whiskeysockets/baileys';
import { WaClient } from '../src/client.js';
import type { ClientOptions, SocketEvents, SocketFactory, Timers, WaSocketLike } from '../src/client.js';

type Listener = (arg: never) => void;

export class FakeSocket implements WaSocketLike {
  handlers = new Map<string, Listener[]>();
  user: WaSocketLike['user'] = { id: '911234567890:12@s.whatsapp.net', name: 'Aswath', lid: '1234@lid' };
  sent: { jid: string; content: unknown }[] = [];
  ended = false;
  pairingRequests: string[] = [];
  sendImpl: (jid: string, content: unknown) => Promise<WAMessage | undefined> = async () => ({
    key: { id: `MSG${this.sent.length}`, remoteJid: 'x@s.whatsapp.net', fromMe: true },
    message: { conversation: 'sent' },
    messageTimestamp: 1_700_000_000,
  });

  ev = {
    on: <K extends keyof SocketEvents>(event: K, listener: (arg: SocketEvents[K]) => void): void => {
      const list = this.handlers.get(event) ?? [];
      list.push(listener as unknown as Listener);
      this.handlers.set(event, list);
    },
  };

  emit<K extends keyof SocketEvents>(event: K, arg: SocketEvents[K]): void {
    for (const l of this.handlers.get(event) ?? []) (l as unknown as (a: SocketEvents[K]) => void)(arg);
  }

  async sendMessage(jid: string, content: unknown): Promise<WAMessage | undefined> {
    this.sent.push({ jid, content });
    return this.sendImpl(jid, content);
  }
  async requestPairingCode(phone: string): Promise<string> {
    this.pairingRequests.push(phone);
    return 'ABCD-1234';
  }
  readCalls: { remoteJid: string; id: string; fromMe?: boolean }[][] = [];
  async readMessages(keys: { remoteJid: string; id: string; fromMe?: boolean }[]): Promise<void> {
    this.readCalls.push(keys);
  }
  presenceCalls: { state: string; jid?: string }[] = [];
  async sendPresenceUpdate(state: string, jid?: string): Promise<void> {
    this.presenceCalls.push({ state, ...(jid ? { jid } : {}) });
  }
  groups: Record<string, { id?: string; subject?: string; owner?: string; desc?: string; creation?: number; participants?: { id?: string; admin?: string | null }[] }> = {};
  async groupMetadata(jid: string) {
    const g = this.groups[jid];
    if (!g) throw new Error(`no group metadata for ${jid}`);
    return g;
  }
  groupCalls: { op: string; target: string; args?: unknown }[] = [];
  async groupLeave(jid: string): Promise<void> {
    this.groupCalls.push({ op: 'leave', target: jid });
  }
  async groupParticipantsUpdate(jid: string, users: string[], action: 'add' | 'remove' | 'promote' | 'demote') {
    this.groupCalls.push({ op: action, target: jid, args: users });
    return users.map((u) => ({ status: '200', jid: u }));
  }
  async groupInviteCode(jid: string): Promise<string> {
    this.groupCalls.push({ op: 'invite', target: jid });
    return 'INVITECODE';
  }
  async groupRevokeInvite(jid: string): Promise<string> {
    this.groupCalls.push({ op: 'revoke', target: jid });
    return 'NEWCODE';
  }
  async groupCreate(subject: string, participants: string[]) {
    this.groupCalls.push({ op: 'create', target: subject, args: participants });
    return { id: '120363012345678901@g.us', subject, participants: participants.map((id) => ({ id })) };
  }
  async groupUpdateSubject(jid: string, subject: string): Promise<void> {
    this.groupCalls.push({ op: 'subject', target: jid, args: subject });
  }
  async groupUpdateDescription(jid: string, description?: string): Promise<void> {
    this.groupCalls.push({ op: 'description', target: jid, args: description });
  }
  async logout(): Promise<void> {}
  end(): void {
    this.ended = true;
  }

  /** Baileys resyncs app state on request; the server answers with events. */
  resyncCalls: { names: readonly string[]; initial: boolean }[] = [];
  resyncContacts: Partial<Contact>[] = [{ id: '919999999999@s.whatsapp.net', name: 'Resync Contact' }];
  async resyncAppState(names: readonly string[], initial: boolean): Promise<void> {
    this.resyncCalls.push({ names: [...names], initial });
    this.emit('contacts.upsert', this.resyncContacts as never);
  }
}

export class ManualTimers implements Timers {
  queue: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  set(fn: () => void, ms: number): () => void {
    const entry = { fn, ms, cancelled: false };
    this.queue.push(entry);
    return () => {
      entry.cancelled = true;
    };
  }
  /** Delays of pending (non-cancelled) timers. */
  pending(): number[] {
    return this.queue.filter((t) => !t.cancelled).map((t) => t.ms);
  }
  /** Fire the oldest pending timer whose delay matches (default: any). */
  fireNext(): void {
    const i = this.queue.findIndex((t) => !t.cancelled);
    if (i < 0) throw new Error('no pending timer');
    const [t] = this.queue.splice(i, 1);
    t?.fn();
  }
}

export function tmpAuthDir(registered: boolean): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'wa-mcp-test-'));
  if (registered) {
    writeFileSync(
      path.join(dir, 'creds.json'),
      JSON.stringify({ registered: true, me: { id: '911234567890:12@s.whatsapp.net', name: 'Aswath', lid: '1234@lid' } }),
    );
  }
  return dir;
}

export interface Harness {
  client: WaClient;
  sockets: FakeSocket[];
  timers: ManualTimers;
  authDir: string;
  logs: string[];
}

export function makeHarness(registered: boolean, extra: Partial<ClientOptions> = {}): Harness {
  const authDir = tmpAuthDir(registered);
  const sockets: FakeSocket[] = [];
  const timers = new ManualTimers();
  const logs: string[] = [];
  const factory: SocketFactory = async () => {
    const sock = new FakeSocket();
    sockets.push(sock);
    return { sock, saveCreds: async () => undefined };
  };
  let t = 1_700_000_000_000;
  const client = new WaClient({
    authDir,
    factory,
    timers,
    now: () => (t += 1000),
    rand: () => 0,
    log: (m) => logs.push(m),
    connectWaitMs: 50,
    ...extra,
  });
  return { client, sockets, timers, authDir, logs };
}
