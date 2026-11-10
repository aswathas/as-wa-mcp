import { z } from 'zod';
import type { WaClient } from './client.js';
import { WaError, toEnvelope } from './errors.js';
import type { Envelope } from './errors.js';

export interface ToolDef {
  name: string;
  description: string;
  /** Zod raw shape, as consumed by the MCP SDK. */
  shape: z.ZodRawShape;
  run(args: Record<string, unknown>): Promise<Envelope<unknown>>;
}

const limitSchema = (def: number) => z.number().int().min(1).max(200).default(def);

function parse<S extends z.ZodRawShape>(shape: S, args: Record<string, unknown>): z.infer<z.ZodObject<S>> {
  const res = z.object(shape).safeParse(args);
  if (!res.success) {
    const msg = res.error.issues.map((i) => `${i.path.join('.') || 'args'}: ${i.message}`).join('; ');
    throw new WaError('INVALID_ARGUMENT', msg);
  }
  return res.data;
}

export function createTools(client: WaClient): ToolDef[] {
  const sendShape = {
    to: z.string().describe('Recipient: phone number like +911234567890, or a JID (…@s.whatsapp.net, …@g.us).'),
    text: z.string().optional().describe('Message text. Required unless media_path is given; used as caption if no caption.'),
    media_path: z.string().optional().describe('Absolute path to a local image/video/audio/document to send.'),
    caption: z.string().optional().describe('Caption for image/video/document (audio sends it as a follow-up text).'),
  };
  const chatsShape = { limit: limitSchema(20).describe('Max chats to return (1-200).') };
  const messagesShape = {
    chat: z.string().describe('Chat: phone number like +911234567890, or a JID.'),
    limit: limitSchema(20).describe('Max messages to return, newest last (1-200).'),
  };

  return [
    {
      name: 'send_message',
      description:
        'Send a WhatsApp text or media message (image/video/audio/document). Returns {ok,data,error}. If not paired: run `node dist/cli.js pair`.',
      shape: sendShape,
      run: (args) =>
        toEnvelope(async () => {
          const a = parse(sendShape, args);
          const input: { text?: string; mediaPath?: string; caption?: string } = {};
          if (a.text !== undefined) input.text = a.text;
          if (a.media_path !== undefined) input.mediaPath = a.media_path;
          if (a.caption !== undefined) input.caption = a.caption;
          return client.send(a.to, input);
        }),
    },
    {
      name: 'get_profile',
      description: 'Get the linked WhatsApp account (number, JID, name).',
      shape: {},
      run: () => toEnvelope(async () => {
        await client.ensureStarted();
        return client.getProfile();
      }),
    },
    {
      name: 'list_chats',
      description: 'List recent chats (id, name, last message timestamp), newest first.',
      shape: chatsShape,
      run: (args) =>
        toEnvelope(async () => {
          const a = parse(chatsShape, args);
          return client.listChats(a.limit);
        }),
    },
    {
      name: 'get_messages',
      description: 'Get recent messages in a chat (oldest first within the returned window).',
      shape: messagesShape,
      run: (args) =>
        toEnvelope(async () => {
          const a = parse(messagesShape, args);
          return client.getMessages(a.chat, a.limit);
        }),
    },
    {
      name: 'get_status',
      description: 'Connection status: paired | pairing | not_paired, uptime, last reconnect.',
      shape: {},
      run: () => toEnvelope(async () => {
        await client.ensureStarted();
        return client.status();
      }),
    },
  ];
}
