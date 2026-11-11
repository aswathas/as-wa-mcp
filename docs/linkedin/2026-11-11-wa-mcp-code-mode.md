31 tools, 1 code tool, and a wait that finally survives the call.

Two limits in my WhatsApp MCP sandbox were bugs wearing an API shape. Both are gone.

The WhatsApp MCP server exposes 31 tools. Loading all of them into an agent session costs about 4k tokens of schema before a single message is read. So I added a second entry point: one tool that takes JavaScript, so the agent filters server side instead of pulling 200 raw messages through its context.

Then I used it and hit two walls that had nothing to do with tokens.

One: the sandbox had a 30 second budget, and the WhatsApp client caps a single wait at 60 seconds. A wait that outlived the budget died with a timeout error, and whatever it had already collected was gone. Two: the sandbox had no file access at all, so any media had to leave code mode to be read.

The wait fix clamps to the budget instead of overrunning it, chunks the 60 second client ceiling, and keeps a cursor per chat. A long wait is now a loop across calls: every call returns cleanly, and messages that arrive in the gap get picked up by the next one instead of being dropped.

The file fix is a rooted API, not raw filesystem access. Every path has to resolve inside a root, symlinks are resolved before the check so a link cannot escape, reads and writes are capped, and a media path handed to send has to be inside a root too. A snippet can now download, read, re-encode and send in one pass.

153 tests cover it. The part I did not expect is that both limits were invisible from the schema. Every tool looked complete until you actually waited on it.

Repo: https://github.com/aswathas/wa-mcp

Which limit would have bitten you first, the wait or the file?

#aiagents #mcp
