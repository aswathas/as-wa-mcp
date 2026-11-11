export const ERROR_CODES = [
  'NOT_PAIRED',
  'NOT_CONNECTED',
  'INVALID_RECIPIENT',
  'INVALID_ARGUMENT',
  'MEDIA_NOT_FOUND',
  'MEDIA_TOO_LARGE',
  'SEND_FAILED',
  'CONFIRMATION_REQUIRED',
  'CODE_ERROR',
  'CODE_TIMEOUT',
  'CODE_FORBIDDEN',
  'FILE_FORBIDDEN',
  'FILE_NOT_FOUND',
  'FILE_TOO_LARGE',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const PAIR_HINT = 'not paired, run: node dist/cli.js pair';

/** Structured, user-presentable error. Anything else thrown is mapped to INTERNAL. */
export class WaError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;

  constructor(code: ErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'WaError';
    this.code = code;
    if (hint !== undefined) this.hint = hint;
  }
}

export function notPairedError(): WaError {
  return new WaError('NOT_PAIRED', 'WhatsApp is not paired. Run: node dist/cli.js pair', PAIR_HINT);
}

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  hint?: string;
}

export type Envelope<T> =
  | { ok: true; data: T; error: null }
  | { ok: false; data: null; error: ErrorBody };

export function ok<T>(data: T): Envelope<T> {
  return { ok: true, data, error: null };
}

export function fail(err: unknown): Envelope<never> {
  if (err instanceof WaError) {
    const error: ErrorBody = { code: err.code, message: err.message };
    if (err.hint !== undefined) error.hint = err.hint;
    return { ok: false, data: null, error };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, data: null, error: { code: 'INTERNAL', message } };
}

/** Run a handler and always return an envelope; never throws. */
export async function toEnvelope<T>(fn: () => Promise<T> | T): Promise<Envelope<T>> {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
}
