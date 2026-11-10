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
