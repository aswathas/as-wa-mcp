import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STORE_FILE = 'store.json';
export const RUNTIME_FILE = 'runtime.json';

/** `auth/` next to `dist/`, overridable with WA_MCP_AUTH_DIR. */
export function defaultAuthDir(): string {
  const fromEnv = process.env['WA_MCP_AUTH_DIR'];
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'auth');
}

interface CredsFile {
  registered?: boolean;
  me?: { id?: string; name?: string; lid?: string };
}

function readCreds(authDir: string): CredsFile | undefined {
  try {
    return JSON.parse(readFileSync(path.join(authDir, 'creds.json'), 'utf8')) as CredsFile;
  } catch {
    return undefined;
  }
}

/**
 * True if a completed pairing is stored on disk.
 *
 * The stored identity (`me.id`) is the source of truth, not the `registered`
 * flag: Baileys only sets `registered = true` in the phone-number (companion)
 * pairing flow, so a device linked by QR stays `registered: false` forever even
 * though the session is valid. Baileys itself keys the protocol off `me`
 * (`socket.js`: `if (!creds.me) register else login`).
 */
export function isRegistered(authDir: string): boolean {
  const creds = readCreds(authDir);
  return Boolean(creds?.me?.id);
}

export function readMe(authDir: string): { id: string; name?: string; lid?: string } | undefined {
  const me = readCreds(authDir)?.me;
  if (!me?.id) return undefined;
  const out: { id: string; name?: string; lid?: string } = { id: me.id };
  if (me.name) out.name = me.name;
  if (me.lid) out.lid = me.lid;
  return out;
}

/** Remove session state (after logout) but keep the message store. */
export function clearSession(authDir: string): void {
  if (!existsSync(authDir)) return;
  for (const entry of readdirSync(authDir)) {
    if (entry === STORE_FILE) continue;
    rmSync(path.join(authDir, entry), { recursive: true, force: true });
  }
}

export interface RuntimeInfo {
  pid: number;
  startedAt: string;
  status: string;
  connected: boolean;
  lastReconnect: string | null;
  updatedAt: string;
}

export function writeRuntime(authDir: string, info: RuntimeInfo): void {
  try {
    mkdirSync(authDir, { recursive: true });
    writeFileSync(path.join(authDir, RUNTIME_FILE), JSON.stringify(info));
  } catch {
    /* best effort */
  }
}

export function removeRuntime(authDir: string, pid: number): void {
  const info = readRuntime(authDir);
  if (info && info.pid !== pid) return;
  rmSync(path.join(authDir, RUNTIME_FILE), { force: true });
}

/** Runtime info of a live MCP server process holding this session, if any. */
export function readRuntime(authDir: string): RuntimeInfo | undefined {
  try {
    return JSON.parse(readFileSync(path.join(authDir, RUNTIME_FILE), 'utf8')) as RuntimeInfo;
  } catch {
    return undefined;
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function liveRuntime(authDir: string): RuntimeInfo | undefined {
  const info = readRuntime(authDir);
  return info && info.pid !== process.pid && isPidAlive(info.pid) ? info : undefined;
}
