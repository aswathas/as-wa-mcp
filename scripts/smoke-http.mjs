// Smoke test the HTTP transport: one daemon, one stdio bridge client.
//   daemon (http) <- bridge (stdio) <- client
// Uses a throwaway auth dir, so nothing touches the real WhatsApp session.
// Exits non-zero on the first failed expectation.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const daemonPath = path.join(root, 'dist', 'http.js');
const launchPath = path.join(root, 'dist', 'launch.js');

const authDir = mkdtempSync(path.join(tmpdir(), 'wa-mcp-http-'));
const port = 8000 + Math.floor(Math.random() * 1000);
const base = 'http://127.0.0.1:' + port;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function health() {
  try {
    const res = await fetch(base + '/health', { signal: AbortSignal.timeout(1000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log('PASS  ' + name);
  } else {
    failures++;
    console.log('FAIL  ' + name + (extra ? ' :: ' + JSON.stringify(extra) : ''));
  }
}

const daemon = spawn(process.execPath, [daemonPath, '--port', String(port), '--idle-ms', '4000', '--stale-ms', '4000', '--auth-dir', authDir], {
  stdio: ['ignore', 'ignore', 'pipe'],
});
let daemonErr = '';
daemon.stderr.on('data', (c) => {
  daemonErr += c.toString();
});
daemon.on('exit', (code) => {
  daemon.exitCode = code;
});

let up = null;
for (let i = 0; i < 60; i++) {
  await sleep(200);
  up = await health();
  if (up) break;
}
check('daemon answers /health', up !== null, { daemonErr: daemonErr.slice(-400) });
check('daemon reports its pid', up && typeof up.pid === 'number', up);

const child = spawn(process.execPath, [launchPath], {
  env: { ...process.env, WA_MCP_HTTP_PORT: String(port), WA_MCP_AUTH_DIR: authDir },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (c) => {
  stderr += c.toString();
});

const pending = new Map();
let nextId = 0;
let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let at = buffer.indexOf('\n');
  while (at >= 0) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    at = buffer.indexOf('\n');
    if (!line) continue;
    const msg = JSON.parse(line);
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

function request(method, params) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => reject(new Error('timeout waiting for ' + method)), 20000).unref?.();
  });
}

try {
  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke-http', version: '1.0.0' },
  });
  check('bridge initialize returns serverInfo', !!(init.result && init.result.serverInfo), init);
  const sessionId = init.result && init.result.serverInfo ? 'ok' : 'no';

  const tools = await request('tools/list', {});
  const names = tools.result && tools.result.tools ? tools.result.tools.map((t) => t.name) : [];
  check('tools/list exposes wa_code', names.includes('wa_code'), { names });

  const after = await health();
  check('daemon counts the client session', after && after.sessions >= 1, after);

  const call = await request('tools/call', {
    name: 'wa_code',
    arguments: { code: 'return await wa.getStatus();' },
  });
  const text = call.result && call.result.content ? call.result.content[0].text : '';
  let envelope = null;
  try {
    envelope = JSON.parse(text);
  } catch {
    /* reported below */
  }
  check('wa_code returns an envelope', envelope !== null && typeof envelope.ok === 'boolean', { text: String(text).slice(0, 300) });

  child.kill();
  await sleep(500);

  let gone = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if ((await health()) === null) {
      gone = true;
      break;
    }
  }
  check('daemon exits on idle after the client leaves', gone, { sessionId });
} catch (err) {
  failures++;
  console.log('FAIL  unexpected error :: ' + String(err));
  console.log(stderr.slice(-800));
} finally {
  try {
    child.kill();
  } catch {
    /* already gone */
  }
  try {
    daemon.kill();
  } catch {
    /* already gone */
  }
  rmSync(authDir, { recursive: true, force: true });
}

if (failures === 0) {
  console.log('all checks passed');
  process.exit(0);
}
console.log(failures + ' check(s) failed');
process.exit(1);
