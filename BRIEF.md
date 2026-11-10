# BRIEF — wa-mcp: our own WhatsApp MCP (best-in-market target)

Build a WhatsApp MCP server + CLI in THIS directory (`C:\Users\aswat\Projects\wa-mcp`).
This must be a genuinely best-in-market MCP: multi-device (no deprecated Web protocol),
media support, bulletproof reconnect, clean MCP ergonomics, real tests.

## Stack (fixed)
- Node 24, TypeScript (strict, no `any`), `@whiskeysockets/baileys` (multi-device),
  `@modelcontextprotocol/sdk` (stdio server), `qrcode-terminal`, `vitest`.
- Layout: `src/` (core + mcp + cli), `dist/` (built), `auth/` (gitignored session state).

## Deliverables
1. **MCP stdio server** (`dist/mcp.js`) with these tools (each returns a JSON envelope
   `{ok, data, error}`; errors are structured, never uncaught):
   - `send_message(to, text, media_path?, caption?)` — text and media (image/document/audio/video);
     `to` accepts `+911234567890` or a JID.
   - `get_profile()` — the linked number/name.
   - `list_chats(limit?)` — recent chats (id, name, last ts).
   - `get_messages(chat, limit?)` — recent messages in a chat.
   - `get_status()` — `paired|pairing|not_paired`, uptime, last reconnect.
2. **CLI** (`dist/cli.js`) — `pair` (print QR in terminal; also support phone-number
   pairing code), `status`, `send <number> <text>`, `chats`, `messages <chat> <n>`.
3. **Reliability**: session persisted in `auth/`; auto-reconnect with exponential backoff;
   the MCP server must start and answer tools even when not paired (structured
   "not paired, run: node dist/cli.js pair" error); one message must not crash the server.
4. **Tests** (vitest, mocked Baileys socket — no live WhatsApp in tests): send_message
   frame construction, pairing state machine, get_status transitions, error envelope,
   JID normalization. All green.
5. **README.md**: install, pair (QR), MCP config snippet for cmdc/agy/claude, tool reference.

## Verify commands (ALL must pass before you finish)
```
npx tsc --noEmit
npm test
node dist/cli.js status
```

## Ground rules
- Work only in this directory. `git init` here is fine; **no pushes**.
- `auth/`, `node_modules/` in `.gitignore`.
- If the Baileys API differs from your memory, read its shipped types (`node_modules/@whiskeysockets/baileys`) — do not guess.
- Append durable findings (what worked, what broke, what's left) to NOTES.md.
