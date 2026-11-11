import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isRegistered, readMe } from '../src/auth.js';

function authDirWith(creds: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'wa-mcp-auth-'));
  writeFileSync(path.join(dir, 'creds.json'), JSON.stringify(creds));
  return dir;
}

describe('isRegistered', () => {
  it('accepts a QR-paired session whose registered flag was never set', () => {
    const dir = authDirWith({ registered: false, me: { id: '919876543210:12@s.whatsapp.net' } });
    expect(isRegistered(dir)).toBe(true);
  });

  it('accepts a companion-paired session', () => {
    const dir = authDirWith({ registered: true, me: { id: '919876543210:12@s.whatsapp.net' } });
    expect(isRegistered(dir)).toBe(true);
  });

  it('is false without a stored identity', () => {
    expect(isRegistered(authDirWith({ registered: false }))).toBe(false);
    expect(isRegistered(authDirWith({ registered: true }))).toBe(false);
  });

  it('is false for a missing creds file', () => {
    expect(isRegistered(mkdtempSync(path.join(tmpdir(), 'wa-mcp-auth-')))).toBe(false);
  });

  it('reads the identity details', () => {
    const dir = authDirWith({ registered: false, me: { id: '919876543210:12@s.whatsapp.net', name: 'Aswath', lid: '1234@lid' } });
    expect(readMe(dir)).toEqual({ id: '919876543210:12@s.whatsapp.net', name: 'Aswath', lid: '1234@lid' });
  });
});
