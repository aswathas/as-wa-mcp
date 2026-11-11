import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Chat, Contact, WAMessage } from '@whiskeysockets/baileys';
import { STORE_FILE } from './auth.js';
import { jidToNumber } from './jid.js';
import { ChatStore, describeMessage, mergeReceipt } from './store.js';
import type {
  ChatInfo,
  ChatSummary,
  ContactHit,
  DeliveryStatus,
  MessageHit,
  ReceiptRecord,
  Store,
  StoredMessage,
} from './store.js';

/** Contact CHAT row from SQLite. */
interface ChatRow {
  id: string;
  name: string | null;
  last_ts: number | null;
  unread: number | null;
}
interface MsgRow {
  id: string;
  chat: string;
  ts: number;
  sender: string;
  from_me: number;
  type: string;
  text: string;
  push_name: string | null;
  has_media: number;
}

interface ReceiptRow {
  message_id: string;
  chat: string;
  status: string;
  ts: number;
  participant: string | null;
}

function toStored(r: MsgRow): StoredMessage {
  const out: StoredMessage = {
    id: r.id,
    chat: r.chat,
    from: r.sender,
    fromMe: r.from_me === 1,
    ts: Number(r.ts),
    type: r.type,
    text: r.text,
    has_media: r.has_media === 1,
  };
  if (r.push_name) out.pushName = r.push_name;
  return out;
}

function toSeconds(ts: unknown): number | null {
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'string' && ts !== '') return Number(ts) || null;
  if (ts && typeof ts === 'object' && 'toNumber' in ts && typeof (ts as { toNumber: unknown }).toNumber === 'function') {
    return (ts as { toNumber: () => number }).toNumber();
  }
  return null;
}

const MAX_RAW = Number(process.env['WA_MCP_MAX_RAW'] ?? 500);

/**
 * SQLite-backed store (Node's built-in node:sqlite — no native build step).
 * Keeps full history instead of the JSON cache's per-chat window.
 */
export class SqliteStore implements Store {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, name TEXT, last_ts INTEGER, unread INTEGER);
      CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, chat TEXT NOT NULL, ts INTEGER NOT NULL, sender TEXT NOT NULL,
        from_me INTEGER NOT NULL, type TEXT NOT NULL, text TEXT NOT NULL,
        push_name TEXT, has_media INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat, ts);
      CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);
      CREATE TABLE IF NOT EXISTS raw (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts (
        message_id TEXT NOT NULL, chat TEXT NOT NULL, status TEXT NOT NULL, ts INTEGER NOT NULL, participant TEXT,
        PRIMARY KEY (message_id, chat)
      );
      CREATE INDEX IF NOT EXISTS idx_receipts_ts ON receipts(ts);
    `);
  }

  ingestChats(chats: Chat[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO chats (id, name, last_ts, unread) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = COALESCE(excluded.name, chats.name),
        last_ts = MAX(COALESCE(chats.last_ts, 0), COALESCE(excluded.last_ts, 0)),
        unread = COALESCE(excluded.unread, chats.unread)
    `);
    for (const c of chats) {
      if (!c.id) continue;
      const name = c.name ?? c.displayName ?? null;
      const ts = toSeconds(c.conversationTimestamp) ?? toSeconds(c.lastMessageRecvTimestamp);
      const unread = typeof c.unreadCount === 'number' ? c.unreadCount : null;
      stmt.run(c.id, name, ts, unread);
    }
  }

  ingestContacts(contacts: Partial<Contact>[]): void {
    const stmt = this.db.prepare('INSERT INTO contacts (id, name) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name');
    for (const c of contacts) {
      const name = c.name ?? c.notify ?? c.verifiedName;
      if (c.id) stmt.run(c.id, name ?? null);
    }
  }

  ingestMessage(msg: WAMessage): boolean {
    const key = msg.key;
    if (!key?.remoteJid || !key.id) return false;
    if (key.remoteJid === 'status@broadcast') return false;
    const desc = describeMessage(msg);
    if (!desc) return false;
    const chatId = key.remoteJid.endsWith('@lid') && key.remoteJidAlt ? key.remoteJidAlt : key.remoteJid;
    const ts = toSeconds(msg.messageTimestamp) ?? Math.floor(Date.now() / 1000);
    const fromMe = Boolean(key.fromMe);
    const sender = fromMe ? 'me' : (key.participantAlt ?? key.participant ?? chatId);
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO messages (id, chat, ts, sender, from_me, type, text, push_name, has_media)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(key.id, chatId, ts, sender, fromMe ? 1 : 0, desc.type, desc.text, msg.pushName ?? null, desc.type !== 'text' ? 1 : 0);
    if (res.changes === 0) return false;
    this.putRaw(key.id, msg);
    if (msg.pushName && !fromMe && !chatId.endsWith('@g.us')) {
      this.ingestContacts([{ id: chatId, name: msg.pushName }]);
    }
    this.ingestChats([{ id: chatId, lastMessageRecvTimestamp: ts } as Chat]);
    return true;
  }

  putRaw(id: string, msg: unknown): void {
    this.db.prepare('INSERT OR REPLACE INTO raw (id, json) VALUES (?, ?)').run(id, JSON.stringify(msg));
    this.db.prepare('DELETE FROM raw WHERE id NOT IN (SELECT id FROM raw ORDER BY rowid DESC LIMIT ?)').run(MAX_RAW);
  }

  getRaw(id: string): unknown {
    const row = this.db.prepare('SELECT json FROM raw WHERE id = ?').get(id) as { json?: string } | undefined;
    if (!row?.json) return undefined;
    try {
      return JSON.parse(row.json);
    } catch {
      return undefined;
    }
  }

  /** Writes are immediate in SQLite; kept for interface parity with ChatStore. */
  flush(): boolean {
    return false;
  }

  private nameExpr(alias = ''): string {
    const p = alias ? `${alias}.` : '';
    return `COALESCE(${p}name, (SELECT name FROM contacts WHERE contacts.id = ${p}id),
            (SELECT name FROM chats WHERE chats.id = ${p}id), ${p}id)`;
  }

  listChats(limit: number): ChatSummary[] {
    const rows = this.db
      .prepare(
        `SELECT c.id AS id, COALESCE(c.name, ct.name, c.id) AS name, c.last_ts AS last_ts, c.unread AS unread
         FROM chats c LEFT JOIN contacts ct ON ct.id = c.id
         ORDER BY COALESCE(c.last_ts, 0) DESC LIMIT ?`,
      )
      .all(limit) as unknown as ChatRow[];
    return rows.map((r) => {
      const out: ChatSummary = { id: r.id, name: r.name ?? r.id, last_ts: r.last_ts ?? null };
      if (r.unread !== null && r.unread !== undefined) out.unread = Number(r.unread);
      return out;
    });
  }

  listContacts(limit: number): ContactHit[] {
    const rows = this.db
      .prepare(
        `SELECT ids.id AS id, COALESCE(ct.name, ch.name, ids.id) AS name
         FROM (SELECT id FROM contacts UNION SELECT id FROM chats) ids
         LEFT JOIN contacts ct ON ct.id = ids.id
         LEFT JOIN chats ch ON ch.id = ids.id
         ORDER BY name LIMIT ?`,
      )
      .all(limit) as unknown as { id: string; name: string }[];
    return rows.map((r) => ({ id: r.id, name: r.name, number: jidToNumber(r.id) ?? null }));
  }

  getMessages(chatId: string, limit: number): StoredMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE chat = ? ORDER BY ts DESC LIMIT ?')
      .all(chatId, limit) as unknown as MsgRow[];
    return rows.reverse().map(toStored);
  }

  messagesSince(sinceTs: number, limit: number, chatId?: string): StoredMessage[] {
    const rows = chatId
      ? (this.db.prepare('SELECT * FROM messages WHERE ts >= ? AND chat = ? ORDER BY ts ASC LIMIT ?').all(sinceTs, chatId, limit) as unknown as MsgRow[])
      : (this.db.prepare('SELECT * FROM messages WHERE ts >= ? ORDER BY ts ASC LIMIT ?').all(sinceTs, limit) as unknown as MsgRow[]);
    return rows.map(toStored);
  }

  hasChat(chatId: string): boolean {
    const row = this.db
      .prepare('SELECT 1 AS x FROM chats WHERE id = ? UNION SELECT 1 AS x FROM messages WHERE chat = ? LIMIT 1')
      .get(chatId, chatId) as { x?: number } | undefined;
    return Boolean(row?.x);
  }

  searchContacts(query: string, limit: number): ContactHit[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const digits = q.replace(/\D/g, '');
    const all = this.listContacts(100_000);
    const hits = all.filter(
      (c) => c.name.toLowerCase().includes(q) || (digits !== '' && c.id.replace(/\D/g, '').includes(digits)),
    );
    hits.sort((a, b) => Number(a.name.toLowerCase().startsWith(q) ? 0 : 1) - Number(b.name.toLowerCase().startsWith(q) ? 0 : 1));
    return hits.slice(0, limit);
  }

  searchMessages(query: string, limit: number): MessageHit[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE lower(text) LIKE ? ORDER BY ts DESC LIMIT ?')
      .all(`%${q}%`, limit) as unknown as MsgRow[];
    return rows.map((r) => {
      const name = (this.db.prepare('SELECT COALESCE((SELECT name FROM contacts WHERE id = ?), (SELECT name FROM chats WHERE id = ?), ?) AS n').get(r.chat, r.chat, r.chat) as { n?: string } | undefined)?.n;
      return { ...toStored(r), chat_name: name ?? r.chat };
    });
  }

  getChatInfo(chatId: string): ChatInfo | undefined {
    if (!this.hasChat(chatId)) return undefined;
    const row = this.db
      .prepare(
        `SELECT c.id AS id, COALESCE(c.name, ct.name, c.id) AS name, c.last_ts AS last_ts, c.unread AS unread,
                (SELECT COUNT(*) FROM messages WHERE chat = c.id) AS message_count
         FROM chats c LEFT JOIN contacts ct ON ct.id = c.id WHERE c.id = ?`,
      )
      .get(chatId) as (ChatRow & { message_count?: number }) | undefined;
    const count = row?.message_count ?? Number((this.db.prepare('SELECT COUNT(*) AS c FROM messages WHERE chat = ?').get(chatId) as { c?: number } | undefined)?.c ?? 0);
    const name = row?.name ?? chatId;
    const last = row?.last_ts ?? null;
    const out: ChatInfo = { id: chatId, name, last_ts: last, is_group: chatId.endsWith('@g.us'), message_count: Number(count) };
    if (row?.unread !== null && row?.unread !== undefined) out.unread = Number(row.unread);
    return out;
  }

  lastInteraction(chatId: string): StoredMessage | undefined {
    const row = this.db.prepare('SELECT * FROM messages WHERE chat = ? ORDER BY ts DESC LIMIT 1').get(chatId) as MsgRow | undefined;
    return row ? toStored(row) : undefined;
  }

  getMessage(chatId: string, messageId: string): StoredMessage | undefined {
    const row = this.db.prepare('SELECT * FROM messages WHERE chat = ? AND id = ?').get(chatId, messageId) as MsgRow | undefined;
    return row ? toStored(row) : undefined;
  }

  messageContext(
    chatId: string,
    messageId: string,
    before: number,
    after: number,
  ): { messages: StoredMessage[]; index: number } | undefined {
    const rows = this.db.prepare('SELECT * FROM messages WHERE chat = ? ORDER BY ts ASC').all(chatId) as unknown as MsgRow[];
    const at = rows.findIndex((r) => r.id === messageId);
    if (at < 0) return undefined;
    const start = Math.max(0, at - before);
    const end = Math.min(rows.length, at + after + 1);
    return { messages: rows.slice(start, end).map(toStored), index: at - start };
  }

  recordReceipt(rec: ReceiptRecord): void {
    const row = this.db
      .prepare('SELECT status, ts, participant FROM receipts WHERE message_id = ? AND chat = ?')
      .get(rec.message_id, rec.chat) as { status?: string; ts?: number; participant?: string | null } | undefined;
    const existing: ReceiptRecord | undefined = row?.status
      ? {
          message_id: rec.message_id,
          chat: rec.chat,
          status: row.status as DeliveryStatus,
          ts: Number(row.ts ?? 0),
          ...(row.participant ? { participant: row.participant } : {}),
        }
      : undefined;
    const merged = mergeReceipt(existing, rec);
    this.db
      .prepare('INSERT OR REPLACE INTO receipts (message_id, chat, status, ts, participant) VALUES (?, ?, ?, ?, ?)')
      .run(merged.message_id, merged.chat, merged.status, merged.ts, merged.participant ?? null);
  }

  listReceipts(limit: number, chatId?: string): ReceiptRecord[] {
    const rows = (
      chatId
        ? this.db.prepare('SELECT * FROM receipts WHERE chat = ? ORDER BY ts DESC LIMIT ?').all(chatId, limit)
        : this.db.prepare('SELECT * FROM receipts ORDER BY ts DESC LIMIT ?').all(limit)
    ) as unknown as ReceiptRow[];
    return rows.map((r) => ({
      message_id: r.message_id,
      chat: r.chat,
      status: r.status as DeliveryStatus,
      ts: Number(r.ts),
      ...(r.participant ? { participant: r.participant } : {}),
    }));
  }
}

/** SQLite when node:sqlite works, JSON cache otherwise. */
export function openStore(authDir: string): Store {
  try {
    return new SqliteStore(path.join(authDir, 'store.sqlite'));
  } catch {
    return new ChatStore(path.join(authDir, STORE_FILE));
  }
}
