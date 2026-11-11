import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { WaError } from './errors.js';

/**
 * Sandboxed file access for the code-mode sandbox.
 *
 * The sandbox deliberately exposes no fs, no require and no host paths - that
 * is what keeps a snippet from becoming arbitrary code execution. But a
 * sandbox that cannot touch a file cannot complete a media pipeline either:
 * downloadMedia writes bytes to disk and the snippet had no way to read them
 * back, so every file operation had to leave code mode and go through the
 * tool server.
 *
 * So the sandbox gets a narrow, explicitly-rooted file API instead of raw
 * filesystem access:
 *
 *   - every path must resolve inside one of the roots
 *   - symlinks are resolved BEFORE the check, so a link cannot escape
 *   - reads and writes are size-capped
 *
 * Roots default to <authDir>/media and <authDir>/files and can be extended
 * with WA_MCP_FILE_ROOT (a semicolon-separated list of absolute paths).
 */

/** Default ceiling for a single read or write (8 MB). */
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number;
  modified: string;
}

export interface FileStat {
  path: string;
  exists: boolean;
  size: number;
  modified: string | null;
  dir: boolean;
}

/** The file surface the sandbox exposes as wa.files. */
export interface FileApi {
  /** Every root the sandbox can reach. */
  roots(): string[];
  /** The primary root; relative paths resolve against it. */
  root(): string;
  /** True when the path resolves inside a root. */
  inside(target: string): boolean;
  /** Throw unless the path resolves inside a root. */
  assertInside(target: string): void;
  readText(target: string): Promise<string>;
  readBase64(target: string): Promise<string>;
  writeText(target: string, text: string): Promise<{ path: string; bytes: number }>;
  writeBase64(target: string, data: string): Promise<{ path: string; bytes: number }>;
  list(dir?: string): Promise<{ dir: string; entries: FileEntry[] }>;
  stat(target: string): Promise<FileStat>;
  remove(target: string): Promise<{ path: string; removed: boolean }>;
  exists(target: string): Promise<boolean>;
}

/** True when target is root itself or lives under it. */
export function insideRoot(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Real path of the deepest existing ancestor with the missing tail re-appended.
 * This is what makes a symlink out of the root visible to the containment check.
 */
export function realpathOfExisting(target: string): string {
  let current = path.resolve(target);
  const tail: string[] = [];
  for (;;) {
    if (existsSync(current)) {
      try {
        return path.join(realpathSync(current), ...tail);
      } catch {
        return path.resolve(target);
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(target);
    tail.unshift(path.basename(current));
    current = parent;
  }
}

/** The roots a code-mode sandbox may touch, given the auth dir. */
export function defaultFileRoots(authDir: string): string[] {
  const roots = [path.join(authDir, 'media'), path.join(authDir, 'files')];
  const extra = process.env['WA_MCP_FILE_ROOT'];
  if (extra) {
    for (const p of extra.split(';')) {
      const trimmed = p.trim();
      if (trimmed) roots.push(path.resolve(trimmed));
    }
  }
  return roots;
}

export class SandboxedFiles implements FileApi {
  private readonly rootDirs: string[];
  private readonly realRootDirs: string[];

  constructor(roots: string[], private readonly maxBytes: number = DEFAULT_MAX_BYTES) {
    if (!roots.length) {
      throw new WaError('INVALID_ARGUMENT', 'the file sandbox needs at least one root');
    }
    this.rootDirs = roots.map((r) => path.resolve(r));
    this.realRootDirs = this.rootDirs.map((r) => realpathOfExisting(r));
  }

  roots(): string[] {
    return [...this.rootDirs];
  }

  root(): string {
    return this.rootDirs[0] as string;
  }

  /** Resolve a path and refuse anything that leaves the roots. */
  private resolve(target: unknown): string {
    if (typeof target !== 'string' || target.trim() === '') {
      throw new WaError('INVALID_ARGUMENT', 'a file path is required');
    }
    const raw = target.trim();
    const candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(this.root(), raw);
    const real = realpathOfExisting(candidate);
    if (!this.realRootDirs.some((r) => insideRoot(r, real))) {
      throw new WaError(
        'FILE_FORBIDDEN',
        'path is outside the sandbox roots: ' + raw,
        'the sandbox can only reach files under ' + this.rootDirs.join(', '),
      );
    }
    return candidate;
  }

  inside(target: string): boolean {
    try {
      this.resolve(target);
      return true;
    } catch {
      return false;
    }
  }

  /** Throw unless the path is inside a root. Used for media paths too. */
  assertInside(target: string): void {
    this.resolve(target);
  }

  private statOrThrow(target: string): ReturnType<typeof statSync> {
    const file = this.resolve(target);
    if (!existsSync(file)) {
      throw new WaError('FILE_NOT_FOUND', 'no such file: ' + target);
    }
    const st = statSync(file);
    if (st.isDirectory()) {
      throw new WaError('INVALID_ARGUMENT', 'path is a directory: ' + target);
    }
    if (st.size > this.maxBytes) {
      throw new WaError(
        'FILE_TOO_LARGE',
        'file is ' + st.size + ' bytes, the sandbox limit is ' + this.maxBytes,
      );
    }
    return st;
  }

  async readText(target: string): Promise<string> {
    this.statOrThrow(target);
    return readFileSync(this.resolve(target), 'utf8');
  }

  async readBase64(target: string): Promise<string> {
    this.statOrThrow(target);
    return readFileSync(this.resolve(target)).toString('base64');
  }

  async writeText(target: string, text: string): Promise<{ path: string; bytes: number }> {
    if (typeof text !== 'string') {
      throw new WaError('INVALID_ARGUMENT', 'text must be a string');
    }
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > this.maxBytes) {
      throw new WaError(
        'FILE_TOO_LARGE',
        'write is ' + bytes + ' bytes, the sandbox limit is ' + this.maxBytes,
      );
    }
    const file = this.resolve(target);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text, 'utf8');
    return { path: file, bytes };
  }

  async writeBase64(target: string, data: string): Promise<{ path: string; bytes: number }> {
    if (typeof data !== 'string') {
      throw new WaError('INVALID_ARGUMENT', 'data must be a base64 string');
    }
    const buffer = Buffer.from(data, 'base64');
    if (buffer.length > this.maxBytes) {
      throw new WaError(
        'FILE_TOO_LARGE',
        'write is ' + buffer.length + ' bytes, the sandbox limit is ' + this.maxBytes,
      );
    }
    const file = this.resolve(target);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, buffer);
    return { path: file, bytes: buffer.length };
  }

  async list(dir?: string): Promise<{ dir: string; entries: FileEntry[] }> {
    const target = dir === undefined || dir === null ? this.root() : this.resolve(dir);
    if (!existsSync(target)) {
      throw new WaError('FILE_NOT_FOUND', 'no such directory: ' + dir);
    }
    if (!statSync(target).isDirectory()) {
      throw new WaError('INVALID_ARGUMENT', 'path is not a directory: ' + dir);
    }
    const entries = readdirSync(target, { withFileTypes: true }).map((d) => {
      const full = path.join(target, d.name);
      let size = 0;
      let modified = new Date(0).toISOString();
      try {
        const st = statSync(full);
        size = st.size;
        modified = st.mtime.toISOString();
      } catch {
        /* an entry we cannot stat is reported without a size */
      }
      return {
        name: d.name,
        path: full,
        type: d.isDirectory() ? ('dir' as const) : ('file' as const),
        size,
        modified,
      };
    });
    return { dir: target, entries };
  }

  async stat(target: string): Promise<FileStat> {
    const file = this.resolve(target);
    if (!existsSync(file)) {
      return { path: file, exists: false, size: 0, modified: null, dir: false };
    }
    const st = statSync(file);
    return {
      path: file,
      exists: true,
      size: st.size,
      modified: st.mtime.toISOString(),
      dir: st.isDirectory(),
    };
  }

  async remove(target: string): Promise<{ path: string; removed: boolean }> {
    const file = this.resolve(target);
    if (!existsSync(file)) {
      throw new WaError('FILE_NOT_FOUND', 'no such file: ' + target);
    }
    if (statSync(file).isDirectory()) {
      throw new WaError('INVALID_ARGUMENT', 'refusing to remove a directory: ' + target);
    }
    rmSync(file);
    return { path: file, removed: true };
  }

  async exists(target: string): Promise<boolean> {
    return existsSync(this.resolve(target));
  }
}

/** Create the file API a code-mode sandbox should use for an auth dir. */
export function createFileApi(authDir: string, maxBytes: number = DEFAULT_MAX_BYTES): SandboxedFiles {
  return new SandboxedFiles(defaultFileRoots(authDir), maxBytes);
}
