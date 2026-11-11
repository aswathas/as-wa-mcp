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

const limitSchema = (def: number, max = 200) => z.number().int().min(1).max(max).default(def);
const chatArg = z.string().describe('Chat: phone number like +911234567890, or a JID (…@s.whatsapp.net, …@g.us).');

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
    reply_to: z.string().optional().describe('Message id to quote as a reply (must be in the recent-message cache).'),
  };
  const chatsShape = { limit: limitSchema(20).describe('Max chats to return (1-200).') };
  const messagesShape = {
    chat: chatArg,
    limit: limitSchema(20).describe('Max messages to return, newest last (1-200).'),
  };
  const searchShape = {
    query: z.string().min(1).describe('Case-insensitive substring to search for.'),
    limit: limitSchema(20).describe('Max results (1-200).'),
  };
  const reactionShape = {
    chat: chatArg,
    message_id: z.string().min(1).describe('Id of the message to react to.'),
    emoji: z.string().describe('Emoji to react with (empty string removes the reaction).'),
  };
  const contactShape = {
    to: z.string().describe('Recipient phone number or JID.'),
    contacts: z
      .array(z.object({ name: z.string(), phone: z.string(), email: z.string().optional() }))
      .min(1)
      .describe('Contact cards to send.'),
  };

  return [
    {
      name: 'send_message',
      description:
        'Send a WhatsApp text or media message (image/video/audio/document). Optionally quote a message with reply_to. Returns {ok,data,error}. If not paired: run `node dist/cli.js pair`.',
      shape: sendShape,
      run: (args) =>
        toEnvelope(async () => {
          const a = parse(sendShape, args);
          const input: { text?: string; mediaPath?: string; caption?: string; replyTo?: string } = {};
          if (a.text !== undefined) input.text = a.text;
          if (a.media_path !== undefined) input.mediaPath = a.media_path;
          if (a.caption !== undefined) input.caption = a.caption;
          if (a.reply_to !== undefined) input.replyTo = a.reply_to;
          return client.send(a.to, input);
        }),
    },
    {
      name: 'send_location',
      description: 'Send a location pin (latitude, longitude, optional name and address).',
      shape: {
        to: z.string().describe('Recipient phone number or JID.'),
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        name: z.string().optional().describe('Place name shown in the pin.'),
        address: z.string().optional().describe('Address text.'),
      },
      run: (args) =>
        toEnvelope(async () => {
          const a = parse(
            {
              to: z.string(),
              latitude: z.number().min(-90).max(90),
              longitude: z.number().min(-180).max(180),
              name: z.string().optional(),
              address: z.string().optional(),
            },
            args,
          );
          return client.sendLocation(a.to, a.latitude, a.longitude, a.name, a.address);
        }),
    },
    {
      name: 'send_contact',
      description: 'Send one or more contact cards (name, phone, optional email).',
      shape: contactShape,
      run: (args) =>
        toEnvelope(async () => {
          const a = parse(contactShape, args);
          return client.sendContact(a.to, a.contacts);
        }),
    },
    {
      name: 'send_sticker',
      description: 'Send a sticker from a local .webp file.',
      shape: {
        to: z.string().describe('Recipient phone number or JID.'),
        media_path: z.string().describe('Absolute path to a .webp sticker.'),
      },
      run: (args) =>
        toEnvelope(async () => {
          const a = parse({ to: z.string(), media_path: z.string() }, args);
          return client.sendSticker(a.to, a.media_path);
        }),
    },
    {
      name: 'react_message',
      description: 'React to a message with an emoji (empty string removes the reaction).',
      shape: reactionShape,
      run: (args) =>
        toEnvelope(async () => {
          const a = parse(reactionShape, args);
          return client.react(a.chat, a.message_id, a.emoji);
        }),
    },
    {
      name: 'mark_read',
      description: 'Mark a chat as read (or a single message with message_id).',
      shape: {
        chat: chatArg,
        message_id: z.string().optional().describe('Specific message to mark read; omit for the recent unread window.'),
      },
      run: (args) =>
        toEnvelope(() => {
          const a = parse({ chat: z.string(), message_id: z.string().optional() }, args);
          return client.markRead(a.chat, a.message_id);
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
      name: 'search_contacts',
      description: 'Search contacts and chat names by name or phone number.',
      shape: searchShape,
      run: (args) =>
        toEnvelope(async () => {
          const a = parse(searchShape, args);
          return client.searchContacts(a.query, a.limit);
        }),
    },
    {
      name: 'search_messages',
      description: 'Full-text search across cached messages, newest first.',
      shape: searchShape,
      run: (args) =>
        toEnvelope(async () => {
          const a = parse(searchShape, args);
          return client.searchMessages(a.query, a.limit);
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
      name: 'get_chat',
      description: 'Metadata for one chat: name, group flag, last timestamp, unread, cached message count.',
      shape: { chat: chatArg },
      run: (args) =>
        toEnvelope(async () => {
          const a = parse({ chat: z.string() }, args);
          return client.getChat(a.chat);
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
      name: 'get_last_interaction',
      description: 'Most recent cached message exchanged with a contact or group.',
      shape: { chat: chatArg },
      run: (args) =>
        toEnvelope(async () => {
          const a = parse({ chat: z.string() }, args);
          return client.lastInteraction(a.chat);
        }),
    },
    {
      name: 'get_message_context',
      description: 'Window of messages around one message id (before/after), for replying in context.',
      shape: {
        chat: chatArg,
        message_id: z.string().min(1).describe('Message id to centre on.'),
        before: limitSchema(3, 50).describe('Messages before it (0-50).'),
        after: limitSchema(3, 50).describe('Messages after it (0-50).'),
      },
      run: (args) =>
        toEnvelope(async () => {
          const a = parse(
            {
              chat: z.string(),
              message_id: z.string().min(1),
              before: limitSchema(3, 50),
              after: limitSchema(3, 50),
            },
            args,
          );
          return client.messageContext(a.chat, a.message_id, a.before, a.after);
        }),
    },
    {
      name: 'get_group_info',
      description: 'Group metadata: subject, owner, description, creation time, participants.',
      shape: { chat: chatArg },
      run: (args) =>
        toEnvelope(async () => {
          const a = parse({ chat: z.string() }, args);
          return client.getGroupInfo(a.chat);
        }),
    },
    {
      name: 'download_media',
      description: 'Download media from a recent message to local disk and return the file path.',
      shape: {
        chat: chatArg,
        message_id: z.string().min(1).describe('Id of the message whose media to download.'),
        save_dir: z.string().optional().describe('Directory to write into (default: <auth>/media).'),
      },
      run: (args) =>
        toEnvelope(async () => {
          const a = parse({ chat: z.string(), message_id: z.string().min(1), save_dir: z.string().optional() }, args);
          return client.downloadMedia(a.chat, a.message_id, a.save_dir);
        }),
    },
    {
      name: 'edit_message',
      description: 'Edit the text of one of your own sent messages.',
      shape: { chat: chatArg, message_id: z.string().min(1), text: z.string().min(1) },
      run: (args) =>
        toEnvelope(async () => {
          const a = parse({ chat: z.string(), message_id: z.string().min(1), text: z.string().min(1) }, args);
          return client.edit(a.chat, a.message_id, a.text);
        }),
    },
    {
      name: 'delete_message',
      description: 'Revoke (delete for everyone) one of your own messages. Requires confirm:true.',
      shape: { chat: chatArg, message_id: z.string().min(1), confirm: z.boolean().optional().describe('Must be true to actually delete.') },
      run: (args) =>
        toEnvelope(async () => {
          const a = parse({ chat: z.string(), message_id: z.string().min(1), confirm: z.boolean().optional() }, args);
          return client.remove(a.chat, a.message_id, a.confirm === true);
        }),
    },
    {
      name: 'send_typing',
      description: 'Show or clear the typing/recording indicator in a chat.',
      shape: {
        chat: chatArg,
        state: z.enum(['composing', 'paused', 'recording', 'available', 'unavailable']).default('composing'),
      },
      run: (args) =>
        toEnvelope(async () => {
          const a = parse(
            { chat: z.string(), state: z.enum(['composing', 'paused', 'recording', 'available', 'unavailable']).default('composing') },
            args,
          );
          return client.presence(a.chat, a.state);
        }),
    },
    {
      name: 'list_contacts',
      description: 'List every known contact and chat name (alphabetical), optionally filtered by a name or number.',
      shape: {
        query: z.string().optional().describe('Optional case-insensitive filter on name, number or jid.'),
        limit: limitSchema(5000, 100000).describe('Max contacts to return (1-100000).'),
      },
      run: (args) =>
        toEnvelope(async () => {
          const a = parse({ query: z.string().optional(), limit: limitSchema(5000, 100000) }, args);
          return client.listContacts(a.limit, a.query);
        }),
    },
    {
      name: 'get_new_messages',
      description: 'Messages at or after a timestamp (seconds), oldest first — cursor-style polling.',
      shape: {
        since_ts: z.number().int().min(0).describe('Unix timestamp in seconds; 0 returns the cached window.'),
        limit: limitSchema(50).describe('Max messages (1-200).'),
        chat: z.string().optional().describe('Restrict to one chat (number or JID).'),
      },
      run: (args) =>
        toEnvelope(async () => {
          const a = parse(
            { since_ts: z.number().int().min(0), limit: limitSchema(50), chat: z.string().optional() },
            args,
          );
          return client.newMessages(a.since_ts, a.limit, a.chat);
        }),
    },
    {
      name: 'wait_for_messages',
      description:
        'Long-poll up to 60 s: return as soon as a new message arrives (optionally in one chat). timed_out=true when nothing arrived.',
      shape: {
        timeout_s: z.number().int().min(1).max(60).default(30).describe('How long to wait, in seconds (1-60).'),
        chat: z.string().optional().describe('Only wake for this chat (number or JID).'),
      },
      run: (args) =>
        toEnvelope(async () => {
          const a = parse(
            { timeout_s: z.number().int().min(1).max(60).default(30), chat: z.string().optional() },
            args,
          );
          return client.waitForMessages({ timeoutMs: a.timeout_s * 1000, ...(a.chat ? { chat: a.chat } : {}) });
        }),
    },
    {
      name: 'leave_group',
      description: 'Leave a group (your account is removed from it). Requires confirm:true.',
      shape: { chat: chatArg, confirm: z.boolean().optional().describe('Must be true to actually leave.') },
      run: (args) =>
        toEnvelope(async () => {
          const a = parse({ chat: z.string(), confirm: z.boolean().optional() }, args);
          return client.leaveGroup(a.chat, a.confirm === true);
        }),
    },
    {
      name: 'group_participants',
      description: 'Add, remove, promote or demote group participants (admin rights required for most actions).',
      shape: {
        chat: chatArg,
        action: z.enum(['add', 'remove', 'promote', 'demote']).describe('What to do with the listed participants.'),
        phones: z.array(z.string()).min(1).describe('Participant phone numbers (or user JIDs).'),
        confirm: z.boolean().optional().describe('Must be true for remove/promote/demote.'),
      },
      run: (args) =>
        toEnvelope(async () => {
          const a = parse(
            {
              chat: z.string(),
              action: z.enum(['add', 'remove', 'promote', 'demote']),
              phones: z.array(z.string()).min(1),
              confirm: z.boolean().optional(),
            },
            args,
          );
          return client.groupParticipants(a.chat, a.action, a.phones, a.confirm === true);
        }),
    },
    {
      name: 'get_group_invite',
      description: 'Get the group invite code and link; reset=true revokes it and returns a fresh one.',
      shape: { chat: chatArg, reset: z.boolean().default(false).describe('Revoke the current code first.') },
      run: (args) =>
        toEnvelope(async () => {
          const a = parse({ chat: z.string(), reset: z.boolean().default(false) }, args);
          return client.getGroupInvite(a.chat, a.reset);
        }),
    },
    {
      name: 'update_group',
      description: 'Change the group subject and/or description (admin required).',
      shape: {
        chat: chatArg,
        subject: z.string().optional().describe('New group name.'),
        description: z.string().optional().describe('New group description.'),
      },
      run: (args) =>
        toEnvelope(async () => {
          const a = parse({ chat: z.string(), subject: z.string().optional(), description: z.string().optional() }, args);
          return client.updateGroup(a.chat, { ...(a.subject ? { subject: a.subject } : {}), ...(a.description ? { description: a.description } : {}) });
        }),
    },
    {
      name: 'create_group',
      description: 'Create a new group with a subject and initial participants.',
      shape: {
        subject: z.string().min(1).describe('Group name.'),
        phones: z.array(z.string()).min(1).describe('Participant phone numbers (or user JIDs).'),
      },
      run: (args) =>
        toEnvelope(async () => {
          const a = parse({ subject: z.string().min(1), phones: z.array(z.string()).min(1) }, args);
          return client.createGroup(a.subject, a.phones);
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
    {
      name: 'get_message_status',
      description:
        'Delivery/read status of messages you sent: sent, delivered, read, played or error. Returns the status of one message, or of every tracked message when message_id is omitted.',
      shape: {
        chat: z.string().optional().describe('Restrict to one chat (number or JID).'),
        message_id: z.string().optional().describe('Restrict to one message id.'),
      },
      run: (args) =>
        toEnvelope(async () => {
          const a = parse({ chat: z.string().optional(), message_id: z.string().optional() }, args);
          const all = await client.listReceipts(200, a.chat);
          const receipts = a.message_id ? all.filter((r) => r.message_id === a.message_id) : all;
          return { receipts, count: receipts.length };
        }),
    },
    {
      name: 'sync_contacts',
      description: 'Ask WhatsApp to resend the contact list, persist every contact, and report {synced, total}.',
      shape: {},
      run: () => toEnvelope(async () => client.syncContacts()),
    },
    {
      name: 'get_webhook_status',
      description:
        'Status of the inbound webhook sink (WA_MCP_WEBHOOK_URL): enabled, url, delivered/failed counts, last error.',
      shape: {},
      run: () => toEnvelope(async () => client.webhookStatus()),
    },
  ];
}
