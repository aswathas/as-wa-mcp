# COMPETITORS — WhatsApp MCP landscape (checked 2026-11-11)

Our v1 shipped 5 tools. This file exists because that was specced from memory, not from a
market sweep. Here is the sweep, the gap, and what we did about it.

## The field

| Project | Shape | Tools | Transport | Notes |
|---|---|---|---|---|
| **lharries/whatsapp-mcp** (~6.9k★) | Go `whatsmeow` bridge + SQLite + Python MCP | **12** | Linked devices (multi-device) | The reference open-source one. Needs Go + Python + UV + CGO on Windows; two processes. |
| **spirit122 WhatsApp MCP** | Cloud API wrapper (Meta Business) | **35** across 8 modules (some Pro/Enterprise) | Official WhatsApp Business Cloud API | Templates, buttons/lists, flows, catalogs, analytics, business profile, webhooks-as-polling, safety/allowlist, AI auto-reply. Requires a Business account + phone number + API key. |
| **Hosted services** (Blueticks, Spun, Perisclaw, Kondo/Volt) | Managed MCP endpoint | varies | Linked devices, hosted | Zero setup, paid, data leaves the machine. |
| **AiChargeLabs Everyhand** (what we replaced) | MCP + licence | ~5–8 | Linked devices | Licence-gated — suspended on this machine. The reason we built ours. |
| **wa-mcp (ours)** | Single Node process, MCP **and** CLI on one core | **30** | Linked devices (Baileys v7) | No licence, no bridge, no Business account. |

## Tool-by-tool matrix

| Capability | lharries | spirit122 | ours (after this pass) |
|---|---|---|---|
| Send text | ✅ | ✅ | ✅ (+ `reply_to` quoting) |
| Send media (image/video/audio/document) | ✅ | ✅ (URL/upload) | ✅ (local path, 100 MB) |
| Voice notes | ✅ (`send_audio_message`, ffmpeg) | ✅ | ✅ (`ptt` for .ogg/.opus, no ffmpeg) |
| Stickers | — | ✅ | ✅ `send_sticker` |
| Location pin | — | ✅ | ✅ `send_location` |
| Contact cards (vCard) | — | ✅ | ✅ `send_contact` |
| React to a message | — | ✅ | ✅ `react_message` |
| Mark as read | — | ✅ | ✅ `mark_read` |
| Reply / quote | — | ✅ | ✅ `send_message(reply_to)` |
| Search contacts | ✅ | — | ✅ `search_contacts` |
| Search messages (full text) | ✅ (SQL) | ✅ (`search_conversations`) | ✅ `search_messages` (cached window) |
| List chats | ✅ | — | ✅ `list_chats` |
| Chat metadata | ✅ `get_chat` | — | ✅ `get_chat` |
| Last interaction | ✅ | — | ✅ `get_last_interaction` |
| Message context (before/after) | ✅ | — | ✅ `get_message_context` |
| Download media from a message | ✅ | ✅ | ✅ `download_media` |
| Group info / participants | — | — | ✅ `get_group_info` |
| Group admin (leave/add/remove/promote/demote/invite/create/rename) | — | — | ✅ `leave_group`, `group_participants`, `get_group_invite`, `update_group`, `create_group` |
| Edit / delete own message | — | — | ✅ `edit_message`, `delete_message` |
| Typing / presence | — | — | ✅ `send_typing` |
| Inbound long-poll | — | ✅ (polling) | ✅ `wait_for_messages` (60 s) |
| Delivery/read receipts | — | ✅ | ✅ `get_message_statuses` |
| Real-time inbound push | — | — | ✅ webhook sink (`WA_MCP_WEBHOOK_URL`) |
| Full history store | ✅ (SQLite) | ✅ | ✅ (SQLite, node:sqlite) |
| Profile | — | ✅ business profile | ✅ `get_profile` |
| Connection status | — | — | ✅ `get_status` |
| **Total tools** | **12** | **35** | **30** |

## What the 35-tool server has that we cannot (or should not) match

These need the **WhatsApp Business Cloud API**, not the Linked-Devices protocol we use:

- Message templates, interactive buttons/lists, WhatsApp Flows, product catalogs
- Phone-number analytics, quality rating, messaging tiers, conversation cost
- Business profile read/write
- Approved-template management

Trying to fake these on Baileys would produce broken UX. If a business workflow needs them,
the right architecture is a separate Cloud-API adapter beside this one — not a rewrite.

## What we still lack that is actually reachable on Baileys

| Gap | Why it matters | Effort |
|---|---|---|
| Cloud-API business features (templates, buttons, flows, catalogs) | Not possible on Linked Devices — separate adapter | Large |

## Our structural advantages (keep these)

1. **One process, one core** — MCP and CLI share it; no Go/Python bridge, no CGO on Windows.
2. **Unpaired-safe** — the server starts and answers all 30 tools with structured errors.
3. **One-connection guard** — refuses to kick the live session; `--force` when you mean it.
4. **No licence, no account, no API key** — Linked Devices only.
5. **Token-lean tool schemas** — 30 tools, zod-validated, envelope-only responses.

## Sources

- [lharries/whatsapp-mcp](https://github.com/lharries/whatsapp-mcp)
- [All 35 Tools — spirit122 WhatsApp MCP](https://spirit122.github.io/whatsapp-mcp-server/tools.html)
- [Best WhatsApp MCP Server in 2026 (Blueticks)](https://blueticks.co/blog/best-whatsapp-mcp-servers)
- [6 Best WhatsApp MCP Servers Compared (Perisclaw)](https://www.perisclaw.com/blog/best-whatsapp-mcp-servers-compared)
- [WhatsApp MCP Servers Compared (Spun)](https://spun.com/guides/whatsapp-mcp-servers-compared/)
