import { describe, expect, it } from 'vitest';
import { WaError } from '../src/errors.js';
import { jidToNumber, normalizeJid, normalizePhoneDigits } from '../src/jid.js';

describe('normalizeJid', () => {
  it.each([
    ['+911234567890', '911234567890@s.whatsapp.net'],
    ['911234567890', '911234567890@s.whatsapp.net'],
    ['+91 12345-67890', '911234567890@s.whatsapp.net'],
    ['(+91) 12345 67890', '911234567890@s.whatsapp.net'],
    ['00911234567890', '911234567890@s.whatsapp.net'],
    ['911234567890@s.whatsapp.net', '911234567890@s.whatsapp.net'],
    ['911234567890:12@s.whatsapp.net', '911234567890@s.whatsapp.net'],
    ['911234567890@c.us', '911234567890@s.whatsapp.net'],
    ['120363012345678901@g.us', '120363012345678901@g.us'],
    ['1234-5678@g.us', '1234-5678@g.us'],
    ['  +911234567890  ', '911234567890@s.whatsapp.net'],
    ['123456789012345@lid', '123456789012345@lid'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeJid(input)).toBe(expected);
  });

  it.each(['', '   ', 'abc', '12', '+1234567890123456789', '09876543210', 'x@unknown.server', '@s.whatsapp.net', 'a b@s.whatsapp.net'])(
    'rejects %j with INVALID_RECIPIENT',
    (input) => {
      try {
        normalizeJid(input);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(WaError);
        expect((err as WaError).code).toBe('INVALID_RECIPIENT');
      }
    },
  );
});

describe('jidToNumber / normalizePhoneDigits', () => {
  it('formats own JIDs as +number', () => {
    expect(jidToNumber('911234567890:12@s.whatsapp.net')).toBe('+911234567890');
    expect(jidToNumber('1234@g.us')).toBeUndefined();
    expect(jidToNumber(undefined)).toBeUndefined();
  });
  it('returns digits for pairing and rejects groups', () => {
    expect(normalizePhoneDigits('+91 12345 67890')).toBe('911234567890');
    expect(() => normalizePhoneDigits('1234-5678@g.us')).toThrow(WaError);
  });
});
