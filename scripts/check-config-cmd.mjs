// Verify the exact command line stored in ~/.claude.json works as an MCP server.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cfg = JSON.parse(readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
const name = ['as-wa-mcp', 'wa', 'whatsapp-code'].find((n) => cfg.mcpServers[n]);
if (!name) {
  console.log('no wa-mcp entry in ~/.claude.json mcpServers');
  process.exit(1);
}
const entry = cfg.mcpServers[name];
console.log('config entry (' + name + '):', JSON.stringify(entry));

const b = spawn(entry.command, entry.args, { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
let err = '';
const pend = new Map();
let id = 0;

b.stderr.on('data', (c) => {
  err += c.toString();
});
b.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  let at = buf.indexOf('\n');
  while (at >= 0) {
    const line = buf.slice(0, at).trim();
    buf = buf.slice(at + 1);
    at = buf.indexOf('\n');
    if (!line) continue;
    const msg = JSON.parse(line);
    const resolve = pend.get(msg.id);
    if (resolve) {
      pend.delete(msg.id);
      resolve(msg);
    }
  }
});

function request(method, params) {
  const rid = ++id;
  return new Promise((resolve) => {
    pend.set(rid, resolve);
    b.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }) + '\n');
    setTimeout(() => resolve({ error: 'timeout' }), 30000).unref();
  });
}

const init = await request('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'check-config-cmd', version: '1.0.0' },
});
console.log('initialize:', JSON.stringify(init.result?.serverInfo ?? init.error));

const tools = await request('tools/list', {});
console.log('tools:', JSON.stringify((tools.result?.tools ?? []).map((t) => t.name)));

const call = await request('tools/call', {
  name: 'wa_code',
  arguments: { code: 'return await wa.getStatus();' },
});
console.log('wa_code:', String(call.result?.content?.[0]?.text ?? JSON.stringify(call)).slice(0, 300));

b.stdin.end();
await new Promise((r) => setTimeout(r, 1500));
console.log('stderr:', err.slice(-300));
process.exit(0);
