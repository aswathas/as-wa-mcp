import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getContentType, normalizeMessageContent } from '@whiskeysockets/baileys';
import type { Chat, Contact, WAMessage } from '@whiskeysockets/baileys';
import { jidToNumber } from './jid.js';

export interface StoredMessage {
  id: string;
  chat: string;
  from: string;
  fromMe: boolean;
  ts: number;
  type: string;
  text: string;
  pushName?: string;
  has_media?: boolean;
  /** Delivery status of this message, when we sent it and a receipt is known. */
  status?: DeliveryStatus;
}

export interface ChatSummary {
  id: string;
  name: string;
  last_ts: number | null;
  unread?: number;
}

export interface ChatInfo extends ChatSummary {
  is_group: boolean;
  message_count: number;
}

export interface ContactHit {
  id: string;
  name: string;
  number: string | null;
}

export interface MessageHit extends StoredMessage {
  chat_name: string;
}

/** Delivery lifecycle of a message we sent. */
export type DeliveryStatus = 'sent' | 'delivered' | 'read' | 'played' | 'error';

export interface ReceiptRecord {
  message_id: string;
  chat: string;
  status: DeliveryStatus;
  /** Unix seconds. */
  ts: number;
  /** Who read it (group participants). */
  participant?: string;
}

/** Progress order — a receipt only ever moves forward. */
const STATUS_RANK: Record<DeliveryStatus, number> = { error: 0, sent: 1, delivered: 2, read: 3, played: 4 };

export function receiptKey(chat: string, messageId: string): string {
  return `${chat}|${messageId}`;
}

/** Merge two receipts for one message: keep the furthest status reached. */
export function mergeReceipt(existing: ReceiptRecord | undefined, incoming: ReceiptRecord): ReceiptRecord {
  if (!existing) return incoming;
  if (incoming.status === 'error') return { ...incoming, ts: Math.max(incoming.ts, existing.ts) };
  const keep = STATUS_RANK[incoming.status] >= STATUS_RANK[existing.status] ? incoming : existing;
  const participant = keep.participant ?? incoming.participant;
  return { ...keep, ts: Math.max(keep.ts, incoming.ts), ...(participant ? { participant } : {}) };
}

interface ChatEntry {
  id: string;
  name?: string;
  lastTs: number | null;
  unread?: number;
}

interface Persisted {
  chats: ChatEntry[];
  messages: Record<string, StoredMessage[]>;
  names: Record<string, string>;
  raw?: Record<string, unknown>;
  receipts?: ReceiptRecord[];
}

/** How many raw messages to keep for quoting and media download. */
const MAX_RAW = Number(process.env['WA_MCP_MAX_RAW'] ?? 500);

/** Public surface both store backends implement (JSON cache, SQLite). */
export interface Store {
  ingestChats(chats: Chat[]): void;
  ingestContacts(contacts: Partial<Contact>[]): void;
  ingestMessage(msg: WAMessage): boolean;
  putRaw(id: string, msg: unknown): void;
  getRaw(id: string): unknown;
  flush(): boolean;
  listChats(limit: number): ChatSummary[];
  listContacts(limit: number): ContactHit[];
  getMessages(chatId: string, limit: number): StoredMessage[];
  messagesSince(sinceTs: number, limit: number, chatId?: string): StoredMessage[];
  hasChat(chatId: string): boolean;
  searchContacts(query: string, limit: number): ContactHit[];
  searchMessages(query: string, limit: number): MessageHit[];
  getChatInfo(chatId: string): ChatInfo | undefined;
  lastInteraction(chatId: string): StoredMessage | undefined;
  getMessage(chatId: string, messageId: string): StoredMessage | undefined;
  messageContext(
    chatId: string,
    messageId: string,
    before: number,
    after: number,
  ): { messages: StoredMessage[]; index: number } | undefined;
  /** Record (or upgrade) the delivery status of one message. */
  recordReceipt(rec: ReceiptRecord): void;
  /** Receipts, newest first; optionally restricted to one chat. */
  listReceipts(limit: number, chatId?: string): ReceiptRecord[];
}

const MAX_MESSAGES_PER_CHAT = Number(process.env['WA_MCP_MAX_PER_CHAT'] ?? 5000);
const MAX_CHATS = Number(process.env['WA_MCP_MAX_CHATS'] ?? 2000);

function toSeconds(ts: unknown): number | null {
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'string' && ts !== '') return Number(ts) || null;
  if (ts && typeof ts === 'object' && 'toNumber' in ts && typeof (ts as { toNumber: unknown }).toNumber === 'function') {
    return (ts as { toNumber: () => number }).toNumber();
  }
  return null;
}

/** Plain-text rendering of a WhatsApp message (media become `[image] caption`). */
export function describeMessage(msg: WAMessage): { type: string; text: string } | undefined {
  const content = normalizeMessageContent(msg.message);
  if (!content) return undefined;
  const type = getContentType(content);
  if (!type) return undefined;
  if (type === 'protocolMessage' || type === 'senderKeyDistributionMessage') return undefined;
  if (type === 'conversation') return { type: 'text', text: content.conversation ?? '' };
  if (type === 'extendedTextMessage') return { type: 'text', text: content.extendedTextMessage?.text ?? '' };
  const label = type.replace(/Message$/, '');
  const inner = content[type];
  let caption = '';
  if (inner && typeof inner === 'object') {
    if ('caption' in inner && typeof inner.caption === 'string') caption = inner.caption;
    else if ('text' in inner && typeof inner.text === 'string') caption = inner.text;
    else if ('fileName' in inner && typeof inner.fileName === 'string') caption = inner.fileName;
  }
  return { type: label, text: caption ? `[${label}] ${caption}` : `[${label}]` };
}

/** In-memory chat + message store, persisted to a JSON file (Baileys v7 ships no store). */
export class ChatStore implements Store {
  private chats = new Map<string, ChatEntry>();
  private messages = new Map<string, StoredMessage[]>();
  private names = new Map<string, string>();
  /** Raw WAMessages, newest last (capped) — needed to quote and to download media. */
  private rawCache = new Map<string, unknown>();
  /** Delivery/read receipts, keyed by chat|messageId. */
  private receipts = new Map<string, ReceiptRecord>();
  private dirty = false;

  constructor(private readonly file?: string) {
    if (file) this.load();
  }

  private load(): void {
    if (!this.file) return;
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Persisted>;
      for (const c of data.chats ?? []) this.chats.set(c.id, c);
      for (const [k, v] of Object.entries(data.messages ?? {})) this.messages.set(k, v);
      for (const [k, v] of Object.entries(data.names ?? {})) this.names.set(k, v);
      for (const [k, v] of Object.entries(data.raw ?? {})) this.rawCache.set(k, v);
      for (const r of data.receipts ?? []) this.receipts.set(receiptKey(r.chat, r.message_id), r);
    } catch {
      /* no store yet, or corrupt: start empty */
    }
  }

  /** Atomically write the store if it changed. Returns whether a write happened. */
  flush(): boolean {
    if (!this.file || !this.dirty) return false;
    const data: Persisted = {
      chats: [...this.chats.values()],
      messages: Object.fromEntries(this.messages),
      names: Object.fromEntries(this.names),
      raw: Object.fromEntries(this.rawCache),
      receipts: [...this.receipts.values()],
    };
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, this.file);
    this.dirty = false;
    return true;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  private touchChat(id: string): ChatEntry {
    let entry = this.chats.get(id);
    if (!entry) {
      entry = { id, lastTs: null };
      this.chats.set(id, entry);
      if (this.chats.size > MAX_CHATS) this.evictOldestChat();
    }
    return entry;
  }

  private evictOldestChat(): void {
    let oldest: ChatEntry | undefined;
    for (const c of this.chats.values()) if (!oldest || (c.lastTs ?? 0) < (oldest.lastTs ?? 0)) oldest = c;
    if (oldest) {
      this.chats.delete(oldest.id);
      this.messages.delete(oldest.id);
    }
  }

  ingestChats(chats: Chat[]): void {
    for (const c of chats) {
      if (!c.id) continue;
      const entry = this.touchChat(c.id);
      const name = c.name ?? c.displayName;
      if (name) entry.name = name;
      const ts = toSeconds(c.conversationTimestamp) ?? toSeconds(c.lastMessageRecvTimestamp);
      if (ts !== null && ts > (entry.lastTs ?? 0)) entry.lastTs = ts;
      if (typeof c.unreadCount === 'number') entry.unread = c.unreadCount;
    }
    this.dirty = true;
  }

  ingestContacts(contacts: Partial<Contact>[]): void {
    for (const c of contacts) {
      const name = c.name ?? c.notify ?? c.verifiedName;
      if (c.id && name) this.names.set(c.id, name);
    }
    this.dirty = true;
  }

  /** Remember the raw message (newest last, capped) so quotes and media downloads work. */
  putRaw(id: string, msg: unknown): void {
    this.rawCache.delete(id);
    this.rawCache.set(id, msg);
    while (this.rawCache.size > MAX_RAW) {
      const oldest = this.rawCache.keys().next().value;
      if (oldest === undefined) break;
      this.rawCache.delete(oldest);
    }
  }

  getRaw(id: string): unknown {
    return this.rawCache.get(id);
  }

  /** Returns true if the message was stored. Never throws on odd payloads. */
  ingestMessage(msg: WAMessage): boolean {
    const key = msg.key;
    if (!key?.remoteJid || !key.id) return false;
    if (key.remoteJid === 'status@broadcast') return false;
    const desc = describeMessage(msg);
    if (!desc) return false;
    const chatId = key.remoteJid.endsWith('@lid') && key.remoteJidAlt ? key.remoteJidAlt : key.remoteJid;
    const ts = toSeconds(msg.messageTimestamp) ?? Math.floor(Date.now() / 1000);
    const fromMe = Boolean(key.fromMe);
    const stored: StoredMessage = {
      id: key.id,
      chat: chatId,
      from: fromMe ? 'me' : (key.participantAlt ?? key.participant ?? chatId),
      fromMe,
      ts,
      type: desc.type,
      text: desc.text,
      has_media: desc.type !== 'text',
    };
    if (msg.pushName) {
      stored.pushName = msg.pushName;
      if (!fromMe && !chatId.endsWith('@g.us')) this.names.set(chatId, msg.pushName);
    }
    const list = this.messages.get(chatId) ?? [];
    if (list.some((m) => m.id === stored.id)) return false;
    list.push(stored);
    list.sort((a, b) => a.ts - b.ts);
    if (list.length > MAX_MESSAGES_PER_CHAT) list.splice(0, list.length - MAX_MESSAGES_PER_CHAT);
    this.messages.set(chatId, list);
    this.putRaw(stored.id, msg);
    const entry = this.touchChat(chatId);
    if (ts > (entry.lastTs ?? 0)) entry.lastTs = ts;
    this.dirty = true;
    return true;
  }

  private nameOf(id: string): string {
    return this.chats.get(id)?.name ?? this.names.get(id) ?? jidToNumber(id) ?? id;
  }

  listChats(limit: number): ChatSummary[] {
    return [...this.chats.values()]
      .sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0))
      .slice(0, limit)
      .map((c) => {
        const out: ChatSummary = { id: c.id, name: this.nameOf(c.id), last_ts: c.lastTs };
        if (c.unread !== undefined) out.unread = c.unread;
        return out;
      });
  }

  /** Most recent `limit` messages, oldest first. */
  getMessages(chatId: string, limit: number): StoredMessage[] {
    const list = this.messages.get(chatId) ?? [];
    return list.slice(Math.max(0, list.length - limit));
  }

  hasChat(chatId: string): boolean {
    return this.chats.has(chatId) || this.messages.has(chatId);
  }

  /** Search contacts and chat names by substring (name or number). */
  searchContacts(query: string, limit: number): ContactHit[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const ids = new Set<string>([...this.names.keys(), ...this.chats.keys()]);
    const hits: (ContactHit & { rank: number })[] = [];
    for (const id of ids) {
      const name = this.nameOf(id);
      const number = jidToNumber(id) ?? null;
      const nameHit = name.toLowerCase().includes(q);
      const digits = id.replace(/\D/g, '');
      const numberHit = digits.includes(q.replace(/\D/g, '')) && q.replace(/\D/g, '') !== '';
      if (!nameHit && !numberHit) continue;
      hits.push({ id, name, number, rank: name.toLowerCase().startsWith(q) ? 0 : 1 });
    }
    hits.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
    return hits.slice(0, limit).map(({ id, name, number }) => ({ id, name, number }));
  }

  /** Full-text search across cached messages, newest first. */
  searchMessages(query: string, limit: number): MessageHit[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const hits: MessageHit[] = [];
    for (const [chatId, list] of this.messages) {
      for (const m of list) {
        if (m.text.toLowerCase().includes(q)) hits.push({ ...m, chat_name: this.nameOf(chatId) });
      }
    }
    hits.sort((a, b) => b.ts - a.ts);
    return hits.slice(0, limit);
  }

  getChatInfo(chatId: string): ChatInfo | undefined {
    if (!this.hasChat(chatId)) return undefined;
    const entry = this.chats.get(chatId);
    const out: ChatInfo = {
      id: chatId,
      name: this.nameOf(chatId),
      last_ts: entry?.lastTs ?? null,
      is_group: chatId.endsWith('@g.us'),
      message_count: (this.messages.get(chatId) ?? []).length,
    };
    if (entry?.unread !== undefined) out.unread = entry.unread;
    return out;
  }

  lastInteraction(chatId: string): StoredMessage | undefined {
    const list = this.messages.get(chatId) ?? [];
    return list[list.length - 1];
  }

  getMessage(chatId: string, messageId: string): StoredMessage | undefined {
    return (this.messages.get(chatId) ?? []).find((m) => m.id === messageId);
  }

  /** Messages at or after `sinceTs` (seconds), oldest first; optionally one chat. */
  messagesSince(sinceTs: number, limit: number, chatId?: string): StoredMessage[] {
    const out: StoredMessage[] = [];
    for (const [chat, list] of this.messages) {
      if (chatId && chat !== chatId) continue;
      for (const m of list) if (m.ts >= sinceTs) out.push(m);
    }
    out.sort((a, b) => a.ts - b.ts);
    return out.slice(0, limit);
  }

  /** Every known contact/chat, alphabetical (for full contact listing). */
  listContacts(limit: number): ContactHit[] {
    const ids = new Set<string>([...this.names.keys(), ...this.chats.keys()]);
    return [...ids]
      .map((id) => ({ id, name: this.nameOf(id), number: jidToNumber(id) ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, limit);
  }

  /** Window of messages around `messageId` (inclusive), plus its index in the window. */
  messageContext(
    chatId: string,
    messageId: string,
    before: number,
    after: number,
  ): { messages: StoredMessage[]; index: number } | undefined {
    const list = this.messages.get(chatId) ?? [];
    const at = list.findIndex((m) => m.id === messageId);
    if (at < 0) return undefined;
    const start = Math.max(0, at - before);
    const end = Math.min(list.length, at + after + 1);
    return { messages: list.slice(start, end), index: at - start };
  }

  recordReceipt(rec: ReceiptRecord): void {
    const key = receiptKey(rec.chat, rec.message_id);
    this.receipts.set(key, mergeReceipt(this.receipts.get(key), rec));
    this.dirty = true;
  }

  listReceipts(limit: number, chatId?: string): ReceiptRecord[] {
    const out = [...this.receipts.values()].filter((r) => !chatId || r.chat === chatId);
    out.sort((a, b) => b.ts - a.ts);
    return out.slice(0, limit);
  }
}
