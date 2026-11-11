import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SandboxedFiles, createFileApi, defaultFileRoots, insideRoot, realpathOfExisting } from '../src/files.js';

describe('sandboxed file API', () => {
  const makeRoot = (): string => mkdtempSync(path.join(tmpdir(), 'wa-files-'));

  it('reads and writes inside the root', async () => {
    const root = makeRoot();
    const files = new SandboxedFiles([root]);
    const written = await files.writeText('note.txt', 'hello');
    expect(written.bytes).toBe(5);
    expect(await files.readText('note.txt')).toBe('hello');
    expect(await files.exists('note.txt')).toBe(true);
  });

  it('round-trips binary through base64', async () => {
    const root = makeRoot();
    const files = new SandboxedFiles([root]);
    const data = Buffer.from([0, 1, 2, 250, 255]).toString('base64');
    await files.writeBase64('blob.bin', data);
    expect(await files.readBase64('blob.bin')).toBe(data);
  });

  it('refuses a path outside the root', async () => {
    const root = makeRoot();
    const files = new SandboxedFiles([root]);
    await expect(files.readText('C:/Windows/win.ini')).rejects.toMatchObject({ code: 'FILE_FORBIDDEN' });
    expect(files.inside('C:/Windows/win.ini')).toBe(false);
  });

  it('refuses a traversal out of the root', async () => {
    const root = makeRoot();
    const files = new SandboxedFiles([root]);
    await expect(files.readText('../../../etc/passwd')).rejects.toMatchObject({ code: 'FILE_FORBIDDEN' });
  });

  it('refuses a write that escapes the root', async () => {
    const root = makeRoot();
    const files = new SandboxedFiles([root]);
    await expect(files.writeText('../escape.txt', 'x')).rejects.toMatchObject({ code: 'FILE_FORBIDDEN' });
  });

  it.skipIf(process.platform === 'win32')('refuses a symlink that escapes the root', async () => {
    const root = makeRoot();
    const outside = makeRoot();
    writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    const { symlinkSync } = await import('node:fs');
    symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
    const files = new SandboxedFiles([root]);
    await expect(files.readText('link.txt')).rejects.toMatchObject({ code: 'FILE_FORBIDDEN' });
  });

  it('caps the read size', async () => {
    const root = makeRoot();
    writeFileSync(path.join(root, 'big.bin'), Buffer.alloc(64));
    const files = new SandboxedFiles([root], 16);
    await expect(files.readText('big.bin')).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });

  it('caps the write size', async () => {
    const root = makeRoot();
    const files = new SandboxedFiles([root], 4);
    await expect(files.writeText('big.txt', 'way too long')).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });

  it('lists a directory', async () => {
    const root = makeRoot();
    mkdirSync(path.join(root, 'sub'));
    writeFileSync(path.join(root, 'a.txt'), 'a');
    const files = new SandboxedFiles([root]);
    const listed = await files.list();
    expect(listed.dir).toBe(root);
    expect(listed.entries.map((e) => e.name).sort()).toEqual(['a.txt', 'sub']);
    expect(listed.entries.find((e) => e.name === 'sub')?.type).toBe('dir');
  });

  it('removes a file but not a directory', async () => {
    const root = makeRoot();
    writeFileSync(path.join(root, 'a.txt'), 'a');
    mkdirSync(path.join(root, 'sub'));
    const files = new SandboxedFiles([root]);
    expect((await files.remove('a.txt')).removed).toBe(true);
    await expect(files.remove('sub')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('reports a missing file without throwing on stat', async () => {
    const root = makeRoot();
    const files = new SandboxedFiles([root]);
    expect((await files.stat('nope.txt')).exists).toBe(false);
    await expect(files.readText('nope.txt')).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
  });

  it('defaults the roots to the media and files directories under the auth dir', () => {
    const roots = defaultFileRoots(path.join('C:', 'tmp', 'auth'));
    expect(roots).toHaveLength(2);
    expect(roots[0]).toContain('media');
    expect(roots[1]).toContain('files');
  });

  it('createFileApi builds a rooted API', () => {
    const root = makeRoot();
    const files = createFileApi(root);
    expect(files.roots()).toHaveLength(2);
    expect(files.root()).toContain('media');
  });

  it('insideRoot recognises containment', () => {
    expect(insideRoot(path.join('C:', 'a'), path.join('C:', 'a', 'b.txt'))).toBe(true);
    expect(insideRoot(path.join('C:', 'a'), path.join('C:', 'b', 'b.txt'))).toBe(false);
  });

  it('realpathOfExisting keeps the missing tail', () => {
    const root = makeRoot();
    const target = path.join(root, 'missing', 'file.txt');
    expect(realpathOfExisting(target)).toContain('file.txt');
  });
});
