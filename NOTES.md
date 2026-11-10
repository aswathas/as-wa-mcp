
## Build log (workshift 1)
DONE: full implementation in src/ (client, state machine, store, media, jid, tools, mcp server, cli, baileys factory), 68 vitest tests (mocked socket), README, dist built. Real-Baileys smoke: `pair` printed a QR; unpaired stdio MCP answers all 5 tools with NOT_PAIRED envelopes.
FINDINGS: shell has NODE_ENV=production, so `npm install` skips devDeps - use `npm install --include=dev`. Baileys v7 rc14 has no makeInMemoryStore - own ChatStore persists to auth/store.json. key.remoteJidAlt maps LID chats to phone JIDs.
DESIGN: server never connects when unpaired; ensureStarted() on each tool call picks up later pairing. 401 clears session, 440 does not reconnect-loop, 515 reconnects immediately. runtime.json lets CLI see a live server (refuses send/sync unless --force).
NEXT (needs a human): live pair with a real phone; verify media send + inbound history on a real account.
BLOCKERS: none.
