# wa-mcp

A WhatsApp **MCP server + CLI** built on [Baileys](https://github.com/WhiskeySockets/Baileys) (multi-device protocol — no deprecated WhatsApp Web session, no phone kept online).

- Text **and media** (image / video / audio / document) sending
- Session persisted in `auth/`; auto-reconnect with exponential backoff + jitter
- The MCP server **starts and answers every tool even when not paired** (structured error with the fix)
- One bad message or rejected promise never crashes the server
- Every tool returns the same JSON envelope: `{ ok, data, error }`

## Free for developers

MIT licensed, free to use, forever. No account, no API key, no licence server, no per-message fees. Clone it, run it on your own machine, point it at your own WhatsApp account. The session and the history store stay on your disk.

What costs money is not the code, it is the running of it. Hosted multi-tenant instances, uptime and reconnect supervision, session migration for you, ban monitoring and support, or embedding wa-mcp inside a product you sell. Ask for those, do not pay for the engine.

**Terms of service and account risk.** WhatsApp discourages unofficial clients. This project speaks the same multi-device protocol as WhatsApp Web, so WhatsApp can restrict or close a linked account. Run it on your own account, on your own risk, and keep the official WhatsApp Business Cloud API in mind if you need templates, broadcasts, catalogue or business-profile features. This project cannot do those.

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
- Optional env: `WA_MCP_AUTH_DIR` (session folder, default `<repo>/auth`), `WA_MCP_LOG_LEVEL` (pino level for Baileys, default `silent`), `WA_MCP_WEBHOOK_URL` (inbound push target), `WA_MCP_WEBHOOK_SECRET`, `WA_MCP_WEBHOOK_TIMEOUT_MS`.

> Run **one** process per session. If the CLI `send`/`sync` is used while the MCP server is live, the CLI refuses (use `--force` to override; it will kick the other connection off — WhatsApp allows one connection per linked device).

## Shared HTTP transport (many agents, one WhatsApp session)

WhatsApp allows **one live connection per linked device**. Over stdio every agent spawns its own server, so only the first one holds the session and the rest fall back to read-only. The HTTP transport fixes that: one daemon owns the session and serves every agent.

```
agent A ──stdio──┐
agent B ──stdio──┼── bridge (dist/launch.js) ──http── daemon (dist/http.js) ── WhatsApp
agent C ──stdio──┘
```

Point every agent at the bridge. It starts the daemon if needed and exits the daemon when the last client leaves.

```json
{
  "mcpServers": {
    "whatsapp-code": {
      "command": "node",
      "args": ["C:/Users/aswat/Projects/wa-mcp/dist/launch.js"]
    }
  }
}
```

```bash
node dist/http.js --port 8765        # daemon (usually started by the bridge)
node dist/http.js --always-on         # never exit on idle
node dist/cli.js stop                 # stop the running daemon
```

- Daemon endpoint: `http://127.0.0.1:8765/mcp`. `GET /health` returns `{ ok, pid, sessions, authDir }`.
- Bridge env: `WA_MCP_HTTP_PORT` (default 8765), `WA_MCP_AUTH_DIR`.
- Daemon flags: `--port`, `--idle-ms` (default 60000), `--stale-ms` (default 90000), `--auth-dir`, `--always-on`.
- The daemon exits after `--idle-ms` with **no** connected clients, so closing the last agent stops it. With `WA_MCP_WEBHOOK_URL` set it stays up (live inbound listener).
- A client that dies without a clean shutdown is dropped after `--stale-ms` of silence.

## Tool reference

All tools return `{ "ok": true, "data": …, "error": null }` or `{ "ok": false, "data": null, "error": { "code", "message", "hint?" } }`.
**32 tools** — see [COMPETITORS.md](COMPETITORS.md) for how this compares with the field.

| Tool | Args | Returns (`data`) |
|---|---|---|
| `send_message` | `to`, `text?`, `media_path?`, `caption?`, `reply_to?` | `{ to, message_ids[], parts }` |
| `send_location` | `to`, `latitude`, `longitude`, `name?`, `address?` | `{ to, latitude, longitude, name, address }` |
| `send_contact` | `to`, `contacts: [{name, phone, email?}]` | `{ to, sent }` |
| `send_sticker` | `to`, `media_path` (.webp) | `{ to, sticker }` |
| `react_message` | `chat`, `message_id`, `emoji` | `{ chat, message_id, emoji }` |
| `mark_read` | `chat`, `message_id?` | `{ chat, marked }` |
| `edit_message` | `chat`, `message_id`, `text` | `{ chat, message_id, edited }` |
| `delete_message` | `chat`, `message_id` | `{ chat, message_id, revoked }` |
| `send_typing` | `chat`, `state?` | `{ chat, state }` |
| `get_profile` | – | `{ number, jid, name, lid }` |
| `search_contacts` | `query`, `limit?` | `[{ id, name, number }]` |
| `list_contacts` | `query?`, `limit?` | every known contact (alphabetical), optionally filtered by name/number |
| `search_messages` | `query`, `limit?` | `[{ id, chat, chat_name, from, fromMe, ts, type, text, has_media? }]` |
| `list_chats` | `limit?` (1–200, default 20) | `[{ id, name, last_ts, unread? }]`, newest first |
| `get_chat` | `chat` | `{ id, name, is_group, last_ts, unread?, message_count }` |
| `get_messages` | `chat`, `limit?` | `[{ id, chat, from, fromMe, ts, type, text, pushName?, has_media? }]`, oldest first |
| `get_last_interaction` | `chat` | last message or `null` |
| `get_message_context` | `chat`, `message_id`, `before?`, `after?` | `{ messages[], index }` |
| `get_new_messages` | `since_ts`, `limit?`, `chat?` | cursor read, oldest first |
| `wait_for_messages` | `timeout_s?` (≤60), `chat?` | `{ messages[], timed_out }` — long-poll |
| `get_group_info` | `chat` (@g.us) | `{ subject, owner, description, created_at, participant_count, participants[] }` |
| `leave_group` | `chat` | `{ chat, left }` |
| `group_participants` | `chat`, `action` (add/remove/promote/demote), `phones[]` | `{ chat, action, results[] }` |
| `get_group_invite` | `chat`, `reset?` | `{ invite_code, link }` |
| `update_group` | `chat`, `subject?`, `description?` | `{ chat, subject, description }` |
| `create_group` | `subject`, `phones[]` | `{ id, subject, participant_count }` |
| `download_media` | `chat`, `message_id`, `save_dir?` | `{ path, bytes, mimetype }` |
| `get_status` | – | `{ status: paired\|pairing\|not_paired, connected, uptime_s, connected_for_s, last_reconnect, reconnect_count, last_error, me, hint? }` |
| `get_message_statuses` | `chat?`, `message_id?`, `limit?` | `{ receipts: [{ message_id, chat, status, ts, participant? }], count }` — status is `sent`\|`delivered`\|`read`\|`played`\|`error` |
| `get_delivery_status` | `chat?`, `message_id?` | `{ receipts: [{ message_id, chat, status, ts, participant? }], count }` — status is `sent`\|`delivered`\|`read`\|`played`\|`error` |
| `sync_contacts` | – | `{ synced, total }` — asks WhatsApp to resend contacts and reports how many are known |
| `get_webhook_status` | – | `{ enabled, url, delivered, failed, last_error, last_delivery_at, last_event_at }` |

Notes:

- `text` is required unless `media_path` is given. For image/video/document, `caption` (or `text`) is the caption. Audio can't carry a caption, so it is sent as a follow-up text; `.ogg`/`.opus` go as voice notes.
- `reply_to` quotes a message — it must still be in the local raw cache (the last ~200 messages).
- `to` accepts `+911234567890`, `91 12345-67890`, `00911234567890`, `…@s.whatsapp.net`, `…@c.us`, `…@g.us` (groups), `…@lid`.
- `search_*`, `list_chats`, `get_chat`, `get_messages`, `get_last_interaction`, `get_message_context` read the local cache in `auth/store.json`, filled live while the server is connected (Baileys v7 has no built-in store). History from before the first link is limited to what WhatsApp syncs.
- `download_media` works for messages still in the raw cache; older media needs a resend.
- Error codes: `NOT_PAIRED`, `NOT_CONNECTED`, `INVALID_RECIPIENT`, `INVALID_ARGUMENT`, `MEDIA_NOT_FOUND`, `MEDIA_TOO_LARGE` (>100 MB), `SEND_FAILED`, `INTERNAL`.
- `get_message_statuses` reports the delivery lifecycle of messages **you sent**: `sent` → `delivered` → `read` → `played` (or `error`). Statuses only move forward — a late `sent` never rolls back a `read`.
- `get_webhook_status` reports the inbound push sink: see [Webhooks](#webhooks).
- `delete_message`, `leave_group` and `group_participants` (remove/promote/demote) are destructive: they need `confirm: true` or they return `CONFIRMATION_REQUIRED` and do nothing.
- `get_messages` includes a `status` field per message when a delivery receipt is known for it.

## Code mode (token-lean second entry point)

The 32 tool definitions serialise to about 4k tokens of tool schema in every session that loads the main server. **Code mode is a second MCP server with exactly one tool** (`wa_code`, ~200 tokens of schema) that takes JavaScript instead of arguments, so the calling agent can filter and aggregate server-side rather than pulling 200 raw messages through its context.

```bash
node dist/codemode.js   # second stdio MCP server, one tool: wa_code
node dist/cli.js code "const chats = await wa.listChats(); return chats.length;"
```

MCP config:

```json
{
  "mcpServers": {
    "whatsapp-code": {
      "command": "node",
      "args": ["C:/Users/aswat/Projects/wa-mcp/dist/codemode.js"]
    }
  }
}
```

To run several agents against the same WhatsApp session, use `dist/launch.js` instead — see [Shared HTTP transport](#shared-http-transport-many-agents-one-whatsapp-session).

**The contract**

- Tool `wa_code`, arguments: `code` (string, required) and `timeout_ms` (optional string, default 5000, max 600000).
- The code is the **body of an async function**: `return` exits it and the returned value becomes `data`. Returning nothing gives `data: null`.
- Exactly one global is available — `wa`. All of its functions are async:

| Helper | Same as |
|---|---|
| `wa.getStatus()` | `get_status` |
| `wa.getProfile()` | `get_profile` |
| `wa.listChats(limit?)` | `list_chats` |
| `wa.getChat(chat)` | `get_chat` |
| `wa.getMessages(chat, limit?)` | `get_messages` |
| `wa.searchMessages(query, limit?)` | `search_messages` |
| `wa.listContacts(limit?)` | `list_contacts` |
| `wa.searchContacts(query, limit?)` | `search_contacts` |
| `wa.syncContacts()` | `sync_contacts` |
| `wa.getLastInteraction(chat)` | `get_last_interaction` |
| `wa.getMessageContext(chat, messageId, before?, after?)` | `get_message_context` |
| `wa.getNewMessages(sinceTs, limit?, chat?)` | `get_new_messages` |
| `wa.waitForMessages(timeoutS?, chat?)` | `wait_for_messages` (resumable, see below) |
| `wa.waitForMessage(timeoutS?, chat?, contains?)` | `wait_for_messages` filtered by a substring |
| `wa.getMessageStatus(chat?, messageId?, limit?)` | `get_message_status` |
| `wa.getWebhookStatus()` | `get_webhook_status` |
| `wa.downloadMedia(chat, messageId, saveDir?)` | `download_media` |
| `wa.send(to, text)` | `send_message` (text only) |
| `wa.sendMessage(to, text?, mediaPath?, caption?, replyTo?)` | `send_message` (full form) |
| `wa.sendLocation(to, latitude, longitude, name?, address?)` | `send_location` |
| `wa.sendContact(to, [{name, phone, email?}])` | `send_contact` |
| `wa.sendSticker(to, mediaPath)` | `send_sticker` |
| `wa.reactMessage(chat, messageId, emoji)` | `react_message` |
| `wa.markRead(chat, messageId?)` | `mark_read` |
| `wa.editMessage(chat, messageId, text)` | `edit_message` |
| `wa.sendTyping(chat, state?)` | `send_typing` |
| `wa.getGroupInfo(chat)` | `get_group_info` |
| `wa.createGroup(subject, phones[])` | `create_group` |
| `wa.updateGroup(chat, subject?, description?)` | `update_group` |
| `wa.getGroupInvite(chat, reset?)` | `get_group_invite` |
| `wa.deleteMessage(chat, messageId, confirm)` | `delete_message` (confirm required) |
| `wa.leaveGroup(chat, confirm)` | `leave_group` (confirm required) |
| `wa.groupParticipants(chat, action, phones[], confirm)` | `group_participants` (confirm required) |

Destructive helpers keep the tool server's guard: the `confirm` argument must be exactly `true`, otherwise the call is refused with `CONFIRMATION_REQUIRED` before anything is sent.

**Files: `wa.files`**

The sandbox has no `fs` and no host paths, so it cannot read a file - which used to mean every media operation had to leave code mode and go through the tool server. The sandbox now has a narrow, **rooted** file surface instead:

| Helper | What it does |
|---|---|
| `wa.files.root()` / `wa.files.roots()` | the roots the sandbox may touch |
| `wa.files.readText(path)` / `wa.files.readBase64(path)` | read a file as text or base64 |
| `wa.files.writeText(path, text)` / `wa.files.writeBase64(path, data)` | write a file, creating parent directories |
| `wa.files.list(dir?)` / `wa.files.stat(path)` / `wa.files.exists(path)` / `wa.files.remove(path)` | inspect and delete |

- Roots default to `<authDir>/media` and `<authDir>/files`. Extend them with `WA_MCP_FILE_ROOT` (a `;`-separated list of absolute paths).
- A path that resolves outside every root raises `FILE_FORBIDDEN`, and so does a symlink that points out of a root. Reads and writes are capped at 8 MB.
- A media path handed to `wa.sendMessage` or `wa.sendSticker` must be inside a root too, so a snippet cannot read any file on the machine by sending it. A `saveDir` passed to `wa.downloadMedia` is redirected into the sandbox.

That makes a full media pipeline possible inside one snippet: download, read the bytes, re-encode, write, send.

**Long waits: clamped and resumable**

`wa.waitForMessages` used to die with `CODE_TIMEOUT` whenever the wait outlived the snippet budget. Now:

- A wait longer than the remaining budget is **clamped**, not fatal. The result carries `clamped: true` and `budget_exhausted: true` so the caller knows to come back.
- The client's 60-second ceiling is chunked internally, so a five-minute wait is five 60-second waits.
- A cursor per chat makes a wait **resume across calls**: messages that arrived in the gap between two snippets are delivered to the next call instead of being lost, and nothing is delivered twice.
- `wa.waitForMessage(timeoutS?, chat?, contains?)` waits for a message whose text contains a substring; non-matching messages still come back in `messages`.

So the shape of a long wait is a loop over calls, and every call returns cleanly.

- The result envelope is the usual `{ok, data, error}`.
- Errors: a thrown error becomes `CODE_ERROR`, a timeout `CODE_TIMEOUT`, and a reference to a forbidden global (`require`, `process`, `fs`, `globalThis`, …) is refused **before execution** with `CODE_FORBIDDEN`.
- A host error with a known code keeps that code: `FILE_FORBIDDEN`, `FILE_NOT_FOUND`, `FILE_TOO_LARGE`, `NOT_PAIRED` and the rest reach the caller instead of being flattened into `CODE_ERROR`.
- The server answers even when WhatsApp is not paired: `wa.getStatus()` returns `status: "not_paired"` inside `data`.

**How the sandbox is built.** The snippet runs in a `node:vm` context with string code generation disabled, so `eval` and the `Function` constructor throw `EvalError` inside it. The context holds no host globals; `wa` is installed through a closure parameter, host values cross the boundary as JSON strings and are re-parsed inside the context, and the script runs under both a VM timeout (for a synchronous infinite loop) and a wall-clock race (for an unresolved `await`). A bad snippet can never crash the server.

## CLI

```text
node dist/cli.js pair [--phone <number>]
node dist/cli.js status
node dist/cli.js send <number> <text> [--media <path>] [--caption <text>] [--reply-to <id>] [--force]
node dist/cli.js sync [seconds]          # connect briefly to refresh the local cache
node dist/cli.js chats [limit]
node dist/cli.js messages <chat> [n]
node dist/cli.js statuses [chat] [limit]
node dist/cli.js webhook
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
node dist/cli.js edit <chat> <message_id> <text>
node dist/cli.js del <chat> <message_id>
node dist/cli.js typing <chat> [state]
node dist/cli.js all-contacts [limit]
node dist/cli.js new [since_ts] [limit] [chat]
node dist/cli.js wait [chat] [seconds]
node dist/cli.js leave <chat>
node dist/cli.js participants <action> <chat> <phone...>
node dist/cli.js invite <chat> [--reset]
node dist/cli.js group-set <chat> [--subject <s>] [--description <d>]
node dist/cli.js create-group <subject> <phone...>
```

`node scripts/list-tools.mjs` spawns the built server and prints the live tool list.


`status`, `chats` and `messages` don't open a connection (they read local state), so they're safe while the server runs.

## Webhooks (inbound push)

Set `WA_MCP_WEBHOOK_URL` and the server POSTs every inbound message and every delivery/read receipt to that endpoint as JSON:

```json
{ "type": "message", "ts": 1731200000, "data": { "id": "...", "chat": "...@s.whatsapp.net", "from": "...", "push_name": "...", "ts": 1731200000, "type": "text", "text": "...", "has_media": false } }
```

- `type` is `message` (inbound) or `receipt` (delivery/read update).
- `WA_MCP_WEBHOOK_SECRET` adds an `x-wa-mcp-signature: sha256=<hmac>` header over the raw body.
- `WA_MCP_WEBHOOK_TIMEOUT_MS` sets the per-attempt timeout (default 5000).
- Delivery is retried twice with backoff. A dead endpoint is logged and counted, never fatal — the WhatsApp connection keeps running.
- `get_webhook_status` (or `node dist/cli.js webhook`) shows whether the sink is enabled and how many deliveries succeeded or failed.

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
