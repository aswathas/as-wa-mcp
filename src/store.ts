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
}

export interface ChatSummary {
  id: string;
  name: string;
  last_ts: number | null;
  unread?: number;
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
}

const MAX_MESSAGES_PER_CHAT = 300;
const MAX_CHATS = 1000;

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
export class ChatStore {
  private chats = new Map<string, ChatEntry>();
  private messages = new Map<string, StoredMessage[]>();
  private names = new Map<string, string>();
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
}
