import { WaError } from './errors.js';

export const USER_SERVER = 's.whatsapp.net';
const KNOWN_SERVERS = new Set([USER_SERVER, 'g.us', 'lid', 'newsletter', 'broadcast']);

/**
 * Normalize a phone number (`+911234567890`, `91 12345-67890`, `00911234567890`)
 * or a JID (`...@s.whatsapp.net`, `...@c.us`, `...@g.us`, `...@lid`) into a canonical JID.
 * Device suffixes (`123:5@s.whatsapp.net`) are stripped for user JIDs.
 */
export function normalizeJid(input: string): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new WaError('INVALID_RECIPIENT', 'Recipient is empty. Use +<countrycode><number> or a JID.');
  }
  const raw = input.trim();

  if (raw.includes('@')) {
    const at = raw.lastIndexOf('@');
    let user = raw.slice(0, at);
    let server = raw.slice(at + 1).toLowerCase();
    if (server === 'c.us') server = USER_SERVER;
    if (user === '' || !KNOWN_SERVERS.has(server)) {
      throw new WaError('INVALID_RECIPIENT', `Unrecognized JID: ${raw}`);
    }
    if (server === USER_SERVER || server === 'lid') {
      user = user.split(':')[0] ?? '';
      const agentless = user.split('_')[0] ?? '';
      if (!/^\d{5,20}$/.test(agentless)) {
        throw new WaError('INVALID_RECIPIENT', `Unrecognized JID: ${raw}`);
      }
      user = agentless;
    } else if (!/^[\w.\-]+$/.test(user)) {
      throw new WaError('INVALID_RECIPIENT', `Unrecognized JID: ${raw}`);
    }
    return `${user}@${server}`;
  }

  if (!/^[+\d\s().-]+$/.test(raw)) {
    throw new WaError('INVALID_RECIPIENT', `Not a phone number or JID: ${raw}`);
  }
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  else if (digits.startsWith('0')) {
    throw new WaError('INVALID_RECIPIENT', 'Number starts with 0; include the country code, e.g. +911234567890.');
  }
  if (digits.length < 7 || digits.length > 15) {
    throw new WaError('INVALID_RECIPIENT', `Phone number must have 7-15 digits (got ${digits.length}).`);
  }
  return `${digits}@${USER_SERVER}`;
}

/** `911234567890:12@s.whatsapp.net` -> `+911234567890`; non-user JIDs return undefined. */
export function jidToNumber(jid: string | undefined): string | undefined {
  if (!jid) return undefined;
  const at = jid.lastIndexOf('@');
  if (at < 0 || jid.slice(at + 1) !== USER_SERVER) return undefined;
  const user = (jid.slice(0, at).split(':')[0] ?? '').split('_')[0] ?? '';
  return /^\d+$/.test(user) ? `+${user}` : undefined;
}

/** Phone digits only (for pairing-code requests). */
export function normalizePhoneDigits(input: string): string {
  const jid = normalizeJid(input);
  if (!jid.endsWith(`@${USER_SERVER}`)) {
    throw new WaError('INVALID_ARGUMENT', 'Pairing needs a phone number, not a group/lid JID.');
  }
  return jid.slice(0, jid.indexOf('@'));
}
