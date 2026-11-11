// Smoke test the BUILT MCP server over real stdio:
//   initialize -> tools/list -> tools/call, against a local webhook sink.
// Exits non-zero on the first failed expectation.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverPath = path.join(root, 'dist', 'mcp.js');

const received = [];
const sink = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    received.push({ url: req.url, body, headers: req.headers });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
});
await new Promise((resolve) => sink.listen(0, '127.0.0.1', resolve));
const port = sink.address().port;

const authDir = mkdtempSync(path.join(tmpdir(), 'wa-mcp-smoke-'));
const child = spawn(process.execPath, [serverPath], {
  env: {
    ...process.env,
    WA_MCP_AUTH_DIR: authDir,
    WA_MCP_WEBHOOK_URL: `http://127.0.0.1:${port}/hook`,
    WA_MCP_WEBHOOK_SECRET: 'smoke-secret',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stderr = '';
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
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
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15000).unref?.();
  });
}

const failures = [];
function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS  ${label}`);
  } else {
    failures.push(label);
    console.log(`FAIL  ${label}${detail ? ` -> ${detail}` : ''}`);
  }
}

try {
  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '1.0.0' },
  });
  check('initialize returns a serverInfo', Boolean(init.result?.serverInfo), JSON.stringify(init));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const list = await request('tools/list', {});
  const names = (list.result?.tools ?? []).map((t) => t.name);
  check('tools/list returns every tool', names.length >= 30, `got ${names.length}`);
  check('get_message_status is exposed', names.includes('get_message_status'));
  check('get_webhook_status is exposed', names.includes('get_webhook_status'));

  const status = await request('tools/call', { name: 'get_status', arguments: {} });
  const statusEnvelope = JSON.parse(status.result?.content?.[0]?.text ?? '{}');
  check('get_status answers while unpaired', statusEnvelope.ok === true && statusEnvelope.data?.status === 'not_paired', JSON.stringify(statusEnvelope));

  const webhook = await request('tools/call', { name: 'get_webhook_status', arguments: {} });
  const webhookEnvelope = JSON.parse(webhook.result?.content?.[0]?.text ?? '{}');
  check('get_webhook_status reports the configured sink', webhookEnvelope.data?.enabled === true && webhookEnvelope.data?.url === `http://127.0.0.1:${port}/hook`, JSON.stringify(webhookEnvelope));

  const receipts = await request('tools/call', { name: 'get_message_status', arguments: {} });
  const receiptsEnvelope = JSON.parse(receipts.result?.content?.[0]?.text ?? '{}');
  check('get_message_status answers with an envelope', receiptsEnvelope.ok === true && Array.isArray(receiptsEnvelope.data?.receipts), JSON.stringify(receiptsEnvelope));

  check('no webhook delivery before an inbound message', received.length === 0, `got ${received.length}`);
} catch (err) {
  failures.push(String(err));
  console.log(`FAIL  ${String(err)}`);
} finally {
  child.kill();
  sink.close();
}

if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed`);
  if (stderr.trim()) console.log(`server stderr:\n${stderr.trim()}`);
  process.exit(1);
}
console.log('\nall checks passed');
process.exit(0);
