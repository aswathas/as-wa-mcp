import type { WaClient } from './client.js';
import type { StoredMessage } from './store.js';

/**
 * Resumable long waits for the code-mode sandbox.
 *
 * The client can block for at most 60 seconds per wait, and a code-mode
 * snippet had a 30 second wall-clock budget on top of that. A wait longer
 * than either ceiling used to die with CODE_TIMEOUT and the snippet lost
 * whatever it had already collected.
 *
 * This coordinator fixes both ends:
 *
 *   - a wait is CLAMPED to the snippet's remaining budget instead of
 *     overrunning it, and the result says so (clamped / budget_exhausted)
 *   - the client ceiling is chunked, so a 5 minute wait is five 60 second
 *     waits rather than one impossible one
 *   - a cursor per chat means a wait RESUMES across separate snippets: the
 *     messages that arrived in the gap are delivered to the next call
 *
 * So the pattern for a long wait is a loop across calls, and each call
 * returns cleanly instead of dying.
 */

/** The client's own per-wait ceiling. Longer waits are chunked. */
export const CLIENT_WAIT_CAP_MS = 60_000;

/** Head-room so a wait returns before the sandbox wall-clock timer fires. */
export const WAIT_SAFETY_MS = 1_200;

/** How many delivered message ids are remembered per chat, to avoid duplicates. */
const SEEN_LIMIT = 500;

export interface WaitResult {
  /** The messages delivered by this call. */
  messages: StoredMessage[];
  /** True when nothing arrived in time. */
  timed_out: boolean;
  /** The timestamp a later wait resumes from. */
  cursor: number;
  /** True when the requested wait was shortened by the snippet budget. */
  clamped: boolean;
  /** True when the snippet budget, not the requested timeout, ended the wait. */
  budget_exhausted: boolean;
}

export interface WaitMessageResult extends WaitResult {
  /** The matching message, or null when the wait timed out. */
  message: StoredMessage | null;
}

export class WaitCoordinator {
  private readonly cursors = new Map<string, number>();
  private readonly seen = new Map<string, Set<string>>();

  constructor(private readonly client: WaClient) {}

  private key(chat?: string): string {
    return chat ?? '*';
  }

  /** The timestamp a later wait resumes from. */
  cursorOf(chat?: string): number {
    const key = this.key(chat);
    let cursor = this.cursors.get(key);
    if (cursor === undefined) {
      cursor = Math.floor(Date.now() / 1000);
      this.cursors.set(key, cursor);
    }
    return cursor;
  }

  private seenSet(chat?: string): Set<string> {
    const key = this.key(chat);
    let set = this.seen.get(key);
    if (!set) {
      set = new Set<string>();
      this.seen.set(key, set);
    }
    return set;
  }

  /** Remember what was delivered, and move the cursor forward. */
  private remember(chat: string | undefined, messages: StoredMessage[]): void {
    if (!messages.length) return;
    const key = this.key(chat);
    const set = this.seenSet(chat);
    let maxTs = this.cursors.get(key) ?? 0;
    for (const message of messages) {
      set.add(message.id);
      if (message.ts > maxTs) maxTs = message.ts;
    }
    while (set.size > SEEN_LIMIT) {
      const oldest = set.values().next().value;
      if (oldest === undefined) break;
      set.delete(oldest);
    }
    this.cursors.set(key, maxTs);
  }

  /** Messages that arrived since the cursor and were not delivered before. */
  private async backlog(chat: string | undefined, limit = 200): Promise<StoredMessage[]> {
    const since = this.cursorOf(chat);
    const rows = await this.client.newMessages(since, limit, chat);
    const set = this.seenSet(chat);
    return rows.filter((m) => !set.has(m.id));
  }

  /** How long this call may wait, given the snippet's deadline. */
  private budget(
    timeoutS: number | undefined,
    deadline: number | undefined,
  ): { wait: number; clamped: boolean; exhausted: boolean } {
    const requested = timeoutS === undefined ? 10_000 : Math.max(0, Math.floor(timeoutS * 1000));
    if (deadline === undefined) {
      return { wait: requested, clamped: false, exhausted: false };
    }
    const remaining = Math.max(0, deadline - Date.now() - WAIT_SAFETY_MS);
    if (requested === 0) {
      // 'wait until the budget runs out'
      return { wait: remaining, clamped: remaining < 10_000, exhausted: true };
    }
    if (requested > remaining) {
      return { wait: remaining, clamped: true, exhausted: true };
    }
    return { wait: requested, clamped: false, exhausted: false };
  }

  /**
   * Wait for the next message.
   *
   * Anything that arrived since the last call is delivered first, so a gap
   * between calls does not lose messages. Then the client is polled in
   * chunks until a message arrives or the budget runs out.
   */
  async waitForMessages(
    timeoutS?: number,
    chat?: string,
    deadline?: number,
  ): Promise<WaitResult> {
    const { wait, clamped, exhausted } = this.budget(timeoutS, deadline);
    const stop = Date.now() + wait;

    const back = await this.backlog(chat);
    if (back.length) {
      this.remember(chat, back);
      return {
        messages: back,
        timed_out: false,
        cursor: this.cursorOf(chat),
        clamped,
        budget_exhausted: exhausted,
      };
    }

    const collected: StoredMessage[] = [];
    while (Date.now() < stop) {
      const chunk = Math.min(CLIENT_WAIT_CAP_MS, Math.max(1000, stop - Date.now()));
      const started = Date.now();
      const res = await this.client.waitForMessages({ chat, timeoutMs: chunk });
      const elapsed = Date.now() - started;
      if (res.messages.length) {
        const set = this.seenSet(chat);
        const fresh = res.messages.filter((m) => !set.has(m.id));
        if (fresh.length) {
          collected.push(...fresh);
          this.remember(chat, fresh);
        }
        break;
      }
      // The client did not actually block; stop instead of spinning.
      if (elapsed < Math.min(500, chunk / 2)) break;
    }

    return {
      messages: collected,
      timed_out: collected.length === 0,
      cursor: this.cursorOf(chat),
      clamped,
      budget_exhausted: exhausted,
    };
  }

  /**
   * Wait for a message whose text contains a substring (any message when the
   * substring is empty). Non-matching messages are still returned in
   * messages, so nothing is silently dropped.
   */
  async waitForMessage(
    timeoutS?: number,
    chat?: string,
    contains?: string,
    deadline?: number,
  ): Promise<WaitMessageResult> {
    const needle = (contains ?? '').trim().toLowerCase();
    const { wait, clamped, exhausted } = this.budget(timeoutS, deadline);
    const stop = Date.now() + wait;
    const collected: StoredMessage[] = [];

    const pick = (): StoredMessage | null => {
      if (!collected.length) return null;
      if (!needle) return collected[collected.length - 1] as StoredMessage;
      for (let i = collected.length - 1; i >= 0; i--) {
        const message = collected[i] as StoredMessage;
        if ((message.text ?? '').toLowerCase().includes(needle)) return message;
      }
      return null;
    };

    for (;;) {
      const back = await this.backlog(chat);
      if (back.length) {
        collected.push(...back);
        this.remember(chat, back);
      }
      const hit = pick();
      if (hit) {
        return {
          message: hit,
          messages: collected,
          timed_out: false,
          cursor: this.cursorOf(chat),
          clamped,
          budget_exhausted: exhausted,
        };
      }
      const left = stop - Date.now();
      if (left <= 0) break;
      const chunk = Math.min(CLIENT_WAIT_CAP_MS, Math.max(1000, left));
      const started = Date.now();
      const res = await this.client.waitForMessages({ chat, timeoutMs: chunk });
      const elapsed = Date.now() - started;
      if (res.messages.length) {
        const set = this.seenSet(chat);
        const fresh = res.messages.filter((m) => !set.has(m.id));
        if (fresh.length) {
          collected.push(...fresh);
          this.remember(chat, fresh);
        }
      } else if (elapsed < Math.min(500, chunk / 2)) {
        break;
      }
    }

    return {
      message: null,
      messages: collected,
      timed_out: true,
      cursor: this.cursorOf(chat),
      clamped,
      budget_exhausted: exhausted,
    };
  }
}
