import { createHmac } from 'node:crypto';

/** Event kinds pushed to the external sink. */
export type WebhookEventType = 'message' | 'receipt';

export interface WebhookStatus {
  enabled: boolean;
  url: string | null;
  delivered: number;
  failed: number;
  last_error: string | null;
  last_delivery_at: string | null;
  last_event_at: string | null;
}

export interface WebhookOptions {
  url?: string | undefined;
  secret?: string | undefined;
  timeoutMs?: number;
  maxRetries?: number;
  log?: (msg: string) => void;
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Pushes inbound events to an external HTTP sink.
 *
 * Never throws and never rejects: a dead endpoint must not take the WhatsApp
 * connection down. Delivery is retried with backoff, then counted as failed.
 */
export class WebhookSink {
  private readonly url: string | undefined;
  private readonly secret: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly log: (msg: string) => void;
  private readonly fetchImpl: (input: string, init: RequestInit) => Promise<Response>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private delivered = 0;
  private failed = 0;
  private lastError: string | null = null;
  private lastDeliveryAt: string | null = null;
  private lastEventAt: string | null = null;

  constructor(opts: WebhookOptions = {}) {
    this.url = opts.url ?? process.env['WA_MCP_WEBHOOK_URL'] ?? undefined;
    this.secret = opts.secret ?? process.env['WA_MCP_WEBHOOK_SECRET'] ?? undefined;
    this.timeoutMs = opts.timeoutMs ?? Number(process.env['WA_MCP_WEBHOOK_TIMEOUT_MS'] ?? 5000);
    this.maxRetries = opts.maxRetries ?? 2;
    this.log = opts.log ?? (() => undefined);
    this.fetchImpl = opts.fetchImpl ?? ((input: string, init: RequestInit) => globalThis.fetch(input, init));
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  get enabled(): boolean {
    return Boolean(this.url);
  }

  status(): WebhookStatus {
    return {
      enabled: this.enabled,
      url: this.url ?? null,
      delivered: this.delivered,
      failed: this.failed,
      last_error: this.lastError,
      last_delivery_at: this.lastDeliveryAt,
      last_event_at: this.lastEventAt,
    };
  }

  /** POST one event. Resolves true when the sink accepted it. */
  async emit(type: WebhookEventType, data: Record<string, unknown>): Promise<boolean> {
    if (!this.url) return false;
    this.lastEventAt = new Date(this.now()).toISOString();
    const body = JSON.stringify({ type, ts: Math.floor(this.now() / 1000), data });
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.secret) {
      headers['x-wa-mcp-signature'] = `sha256=${createHmac('sha256', this.secret).update(body).digest('hex')}`;
    }
    let lastErr = 'unknown error';
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await this.post(body, headers);
        if (res.ok) {
          this.delivered++;
          this.lastDeliveryAt = new Date(this.now()).toISOString();
          this.lastError = null;
          return true;
        }
        lastErr = `HTTP ${res.status}`;
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
      }
      if (attempt < this.maxRetries) await this.sleep(250 * 2 ** attempt);
    }
    this.failed++;
    this.lastError = lastErr;
    this.log(`webhook delivery failed: ${lastErr}`);
    return false;
  }

  private async post(body: string, headers: Record<string, string>): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(this.url as string, { method: 'POST', headers, body, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}
