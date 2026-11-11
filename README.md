# wa-mcp

A WhatsApp **MCP server + CLI** built on [Baileys](https://github.com/WhiskeySockets/Baileys) (multi-device protocol — no deprecated WhatsApp Web session, no phone kept online).

- Text **and media** (image / video / audio / document) sending
- Session persisted in `auth/`; auto-reconnect with exponential backoff + jitter
- The MCP server **starts and answers every tool even when not paired** (structured error with the fix)
- One bad message or rejected promise never crashes the server
- Every tool returns the same JSON envelope: `{ ok, data, error }`

## Install

Requires Node 24+.

```bash
npm install --include=dev   # --include=dev if NODE_ENV=production is set in your shell
npm run build
```

## Pair (once)

```bash
node dist/cli.js pair                      # prints a QR in the terminal
node dist/cli.js pair --phone +911234567890   # or: 8-character pairing code, no camera needed
```

QR: WhatsApp → Settings → Linked devices → Link a device → scan.
Code: … → Link a device → *Link with phone number instead* → enter the printed code.

Credentials land in `auth/` (gitignored). Delete that folder to unlink locally. Check with:

```bash
node dist/cli.js status
```

## MCP config

Use an absolute path to `dist/mcp.js`. Logs go to stderr only (stdout is the protocol).

**Claude Code**

```bash
claude mcp add whatsapp -- node C:/Users/aswat/Projects/wa-mcp/dist/mcp.js
```

**Generic JSON (Claude Desktop, cmdc, agy, any stdio MCP client)**

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "node",
      "args": ["C:/Users/aswat/Projects/wa-mcp/dist/mcp.js"]
    }
  }
}
```

- **cmdc / agy:** add the same `command` + `args` block to the client's MCP servers config (e.g. `mcp_config.json`).
- Optional env: `WA_MCP_AUTH_DIR` (session folder, default `<repo>/auth`), `WA_MCP_LOG_LEVEL` (pino level for Baileys, default `silent`).

> Run **one** process per session. If the CLI `send`/`sync` is used while the MCP server is live, the CLI refuses (use `--force` to override; it will kick the other connection off — WhatsApp allows one connection per linked device).

## Tool reference

All tools return `{ "ok": true, "data": …, "error": null }` or `{ "ok": false, "data": null, "error": { "code", "message", "hint?" } }`.
17 tools — see [COMPETITORS.md](COMPETITORS.md) for how this compares with the field.

| Tool | Args | Returns (`data`) |
|---|---|---|
| `send_message` | `to`, `text?`, `media_path?`, `caption?`, `reply_to?` | `{ to, message_ids[], parts }` |
| `send_location` | `to`, `latitude`, `longitude`, `name?`, `address?` | `{ to, latitude, longitude, name, address }` |
| `send_contact` | `to`, `contacts: [{name, phone, email?}]` | `{ to, sent }` |
| `send_sticker` | `to`, `media_path` (.webp) | `{ to, sticker }` |
| `react_message` | `chat`, `message_id`, `emoji` | `{ chat, message_id, emoji }` |
| `mark_read` | `chat`, `message_id?` | `{ chat, marked }` |
| `get_profile` | – | `{ number, jid, name, lid }` |
| `search_contacts` | `query`, `limit?` | `[{ id, name, number }]` |
| `search_messages` | `query`, `limit?` | `[{ id, chat, chat_name, from, fromMe, ts, type, text, has_media? }]` |
| `list_chats` | `limit?` (1–200, default 20) | `[{ id, name, last_ts, unread? }]`, newest first |
| `get_chat` | `chat` | `{ id, name, is_group, last_ts, unread?, message_count }` |
| `get_messages` | `chat`, `limit?` | `[{ id, chat, from, fromMe, ts, type, text, pushName?, has_media? }]`, oldest first |
| `get_last_interaction` | `chat` | last message or `null` |
| `get_message_context` | `chat`, `message_id`, `before?`, `after?` | `{ messages[], index }` |
| `get_group_info` | `chat` (@g.us) | `{ subject, owner, description, created_at, participant_count, participants[] }` |
| `download_media` | `chat`, `message_id`, `save_dir?` | `{ path, bytes, mimetype }` |
| `get_status` | – | `{ status: paired\|pairing\|not_paired, connected, uptime_s, connected_for_s, last_reconnect, reconnect_count, last_error, me, hint? }` |

Notes:

- `text` is required unless `media_path` is given. For image/video/document, `caption` (or `text`) is the caption. Audio can't carry a caption, so it is sent as a follow-up text; `.ogg`/`.opus` go as voice notes.
- `reply_to` quotes a message — it must still be in the local raw cache (the last ~200 messages).
- `to` accepts `+911234567890`, `91 12345-67890`, `00911234567890`, `…@s.whatsapp.net`, `…@c.us`, `…@g.us` (groups), `…@lid`.
- `search_*`, `list_chats`, `get_chat`, `get_messages`, `get_last_interaction`, `get_message_context` read the local cache in `auth/store.json`, filled live while the server is connected (Baileys v7 has no built-in store). History from before the first link is limited to what WhatsApp syncs.
- `download_media` works for messages still in the raw cache; older media needs a resend.
- Error codes: `NOT_PAIRED`, `NOT_CONNECTED`, `INVALID_RECIPIENT`, `INVALID_ARGUMENT`, `MEDIA_NOT_FOUND`, `MEDIA_TOO_LARGE` (>100 MB), `SEND_FAILED`, `INTERNAL`.

## CLI

```text
node dist/cli.js pair [--phone <number>]
node dist/cli.js status
node dist/cli.js send <number> <text> [--media <path>] [--caption <text>] [--reply-to <id>] [--force]
node dist/cli.js sync [seconds]          # connect briefly to refresh the local cache
node dist/cli.js chats [limit]
node dist/cli.js messages <chat> [n]
node dist/cli.js contacts <query> [limit]
node dist/cli.js search <query> [limit]
node dist/cli.js chat <id>
node dist/cli.js last <chat>
node dist/cli.js context <chat> <message_id> [before] [after]
node dist/cli.js react <chat> <message_id> [emoji]
node dist/cli.js read <chat> [message_id]
node dist/cli.js download <chat> <message_id> [dir]
node dist/cli.js loc <to> <lat> <lng> [name] [address]
node dist/cli.js sticker <to> <path.webp>
node dist/cli.js vcard <to> <name> <phone> [email]
node dist/cli.js group <chat>
```

`node scripts/list-tools.mjs` spawns the built server and prints the live tool list.


`status`, `chats` and `messages` don't open a connection (they read local state), so they're safe while the server runs.

## Reliability

- **Reconnect:** drops retry after `1s, 2s, 4s … 60s` (±25 % jitter); the counter resets once connected. A post-pairing restart (515) reconnects immediately.
- **Logged out from the phone (401):** the session is cleared and status becomes `not_paired` — re-run `pair`.
- **Replaced (440, another process took the session):** no reconnect fight; the next tool call reconnects.
- **Paired after the server started:** the server notices on the next tool call; no restart needed.

## Develop

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest, mocked Baileys socket — no live WhatsApp
npm run build
```
