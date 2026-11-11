import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { AnyMessageContent } from '@whiskeysockets/baileys';
import { WaError } from './errors.js';

export type MediaKind = 'image' | 'video' | 'audio' | 'document';

export const MAX_MEDIA_BYTES = 100 * 1024 * 1024;

const MIME: Record<string, { kind: MediaKind; mime: string }> = {
  '.jpg': { kind: 'image', mime: 'image/jpeg' },
  '.jpeg': { kind: 'image', mime: 'image/jpeg' },
  '.png': { kind: 'image', mime: 'image/png' },
  '.gif': { kind: 'image', mime: 'image/gif' },
  '.webp': { kind: 'image', mime: 'image/webp' },
  '.mp4': { kind: 'video', mime: 'video/mp4' },
  '.mov': { kind: 'video', mime: 'video/quicktime' },
  '.mkv': { kind: 'video', mime: 'video/x-matroska' },
  '.3gp': { kind: 'video', mime: 'video/3gpp' },
  '.webm': { kind: 'video', mime: 'video/webm' },
  '.mp3': { kind: 'audio', mime: 'audio/mpeg' },
  '.m4a': { kind: 'audio', mime: 'audio/mp4' },
  '.aac': { kind: 'audio', mime: 'audio/aac' },
  '.wav': { kind: 'audio', mime: 'audio/wav' },
  '.amr': { kind: 'audio', mime: 'audio/amr' },
  '.ogg': { kind: 'audio', mime: 'audio/ogg; codecs=opus' },
  '.opus': { kind: 'audio', mime: 'audio/ogg; codecs=opus' },
  '.pdf': { kind: 'document', mime: 'application/pdf' },
  '.txt': { kind: 'document', mime: 'text/plain' },
  '.csv': { kind: 'document', mime: 'text/csv' },
  '.json': { kind: 'document', mime: 'application/json' },
  '.zip': { kind: 'document', mime: 'application/zip' },
  '.doc': { kind: 'document', mime: 'application/msword' },
  '.docx': { kind: 'document', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  '.xls': { kind: 'document', mime: 'application/vnd.ms-excel' },
  '.xlsx': { kind: 'document', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  '.ppt': { kind: 'document', mime: 'application/vnd.ms-powerpoint' },
  '.pptx': { kind: 'document', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
};

export function classifyMedia(filePath: string): { kind: MediaKind; mime: string; fileName: string } {
  const ext = path.extname(filePath).toLowerCase();
  const hit = MIME[ext];
  return {
    kind: hit?.kind ?? 'document',
    mime: hit?.mime ?? 'application/octet-stream',
    fileName: path.basename(filePath),
  };
}

export interface SendInput {
  text?: string;
  mediaPath?: string;
  caption?: string;
  /** Message id to quote (must still be in the local raw cache). */
  replyTo?: string;
}

/**
 * Build the Baileys message contents for a send request (pure).
 * Audio cannot carry a caption, so a caption/text becomes a follow-up text message.
 */
export function buildSendPayloads(input: SendInput): AnyMessageContent[] {
  const text = input.text?.trim() ? input.text : undefined;
  const caption = input.caption?.trim() ? input.caption : undefined;

  if (!input.mediaPath) {
    if (!text) throw new WaError('INVALID_ARGUMENT', 'Provide text, or media_path.');
    return [{ text }];
  }

  const media = classifyMedia(input.mediaPath);
  const cap = caption ?? text;
  const url = input.mediaPath;
  switch (media.kind) {
    case 'image':
      return [cap ? { image: { url }, caption: cap } : { image: { url } }];
    case 'video':
      return [cap ? { video: { url }, caption: cap } : { video: { url } }];
    case 'audio': {
      const out: AnyMessageContent[] = [
        { audio: { url }, mimetype: media.mime, ptt: media.mime.startsWith('audio/ogg') },
      ];
      if (cap) out.push({ text: cap });
      return out;
    }
    case 'document':
      return [
        cap
          ? { document: { url }, mimetype: media.mime, fileName: media.fileName, caption: cap }
          : { document: { url }, mimetype: media.mime, fileName: media.fileName },
      ];
  }
}

/** Validate that a media path exists, is a file, and is within size limits. */
export async function assertMediaReadable(mediaPath: string): Promise<void> {
  let info;
  try {
    info = await stat(mediaPath);
  } catch {
    throw new WaError('MEDIA_NOT_FOUND', `media_path not found: ${mediaPath}`);
  }
  if (!info.isFile()) throw new WaError('MEDIA_NOT_FOUND', `media_path is not a file: ${mediaPath}`);
  if (info.size === 0) throw new WaError('INVALID_ARGUMENT', `media_path is empty: ${mediaPath}`);
  if (info.size > MAX_MEDIA_BYTES) {
    throw new WaError('MEDIA_TOO_LARGE', `media_path exceeds ${MAX_MEDIA_BYTES / 1024 / 1024} MB: ${mediaPath}`);
  }
}

/** Sticker content. WhatsApp only accepts .webp stickers. */
export function buildStickerContent(filePath: string): AnyMessageContent {
  if (path.extname(filePath).toLowerCase() !== '.webp') {
    throw new WaError('INVALID_ARGUMENT', 'Stickers must be .webp files (WhatsApp requires webp).');
  }
  return { sticker: { url: filePath } };
}

/** vCard 3.0 text for send_contact. */
export function buildVcard(name: string, phone: string, email?: string): string {
  const digits = phone.replace(/[^\d+]/g, '');
  const waid = digits.replace(/^\+/, '');
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${name}`,
    `TEL;type=CELL;type=VOICE;waid=${waid}:${digits}`,
  ];
  if (email) lines.push(`EMAIL:${email}`);
  lines.push('END:VCARD');
  return lines.join('\n');
}

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'audio/ogg': 'ogg',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/json': 'json',
};

/** Best-effort file extension for a mimetype (downloads). */
export function extForMime(mime: string): string {
  const base = mime.split(';')[0]?.trim().toLowerCase() ?? '';
  return MIME_EXT[base] ?? 'bin';
}

const MEDIA_NODES = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'];
const WRAPPERS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'documentWithCaptionMessage'];

/** Pull the media mimetype out of a raw WAMessage (handles wrapper messages). */
export function mediaMimetypeOf(raw: unknown): string | undefined {
  const message = (raw as { message?: Record<string, unknown> } | undefined)?.message;
  if (!message) return undefined;
  for (const node of MEDIA_NODES) {
    const part = message[node] as { mimetype?: unknown } | undefined;
    if (part && typeof part.mimetype === 'string') return part.mimetype;
  }
  for (const wrapper of WRAPPERS) {
    const inner = (message[wrapper] as { message?: unknown } | undefined)?.message;
    if (inner) {
      const hit = mediaMimetypeOf({ message: inner });
      if (hit) return hit;
    }
  }
  return undefined;
}
