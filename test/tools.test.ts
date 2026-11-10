import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { fail, ok, toEnvelope, WaError } from '../src/errors.js';
import { createServer } from '../src/server.js';
import { createTools } from '../src/tools.js';
import { makeHarness } from './helpers.js';

describe('error envelope', () => {
  it('ok shape', () => {
    expect(ok({ a: 1 })).toEqual({ ok: true, data: { a: 1 }, error: null });
  });
  it('WaError keeps code, message and hint', () => {
    expect(fail(new WaError('NOT_PAIRED', 'm', 'h'))).toEqual({ ok: false, data: null, error: { code: 'NOT_PAIRED', message: 'm', hint: 'h' } });
  });
  it('unknown throwables become INTERNAL, never uncaught', async () => {
    expect(await toEnvelope(() => { throw new Error('x'); })).toEqual({ ok: false, data: null, error: { code: 'INTERNAL', message: 'x' } });
    expect(await toEnvelope(() => Promise.reject('str'))).toMatchObject({ ok: false, error: { code: 'INTERNAL', message: 'str' } });
  });
});

describe('tools (not paired)', () => {
  it('every tool answers with a structured not-paired error or status', async () => {
    const h = makeHarness(false);
    await h.client.start();
    const tools = Object.fromEntries(createTools(h.client).map((t) => [t.name, t]));
    for (const [name, args] of [
      ['send_message', { to: '+911234567890', text: 'hi' }],
      ['get_profile', {}],
      ['list_chats', {}],
      ['get_messages', { chat: '+911234567890' }],
    ] as const) {
      const env = await tools[name]?.run(args);
      expect(env, name).toMatchObject({ ok: false, data: null, error: { code: 'NOT_PAIRED', hint: 'not paired, run: node dist/cli.js pair' } });
      expect(env?.ok === false && env.error.message).toContain('node dist/cli.js pair');
    }
    expect(await tools['get_status']?.run({})).toMatchObject({ ok: true, data: { status: 'not_paired' } });
  });

  it('validates arguments into INVALID_ARGUMENT', async () => {
    const h = makeHarness(true);
    await h.client.start();
    const tools = Object.fromEntries(createTools(h.client).map((t) => [t.name, t]));
    expect(await tools['send_message']?.run({ text: 'x' })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(await tools['list_chats']?.run({ limit: 0 })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(await tools['get_messages']?.run({ chat: 5 })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
  });
});

describe('MCP server over an in-memory transport', () => {
  it('lists the five tools and returns envelopes as text content', async () => {
    const h = makeHarness(false);
    await h.client.start();
    const server = createServer(h.client);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['get_messages', 'get_profile', 'get_status', 'list_chats', 'send_message']);

    const res = await client.callTool({ name: 'get_status', arguments: {} });
    const content = res.content as { type: string; text: string }[];
    expect(JSON.parse(content[0]?.text ?? '')).toMatchObject({ ok: true, data: { status: 'not_paired' }, error: null });

    const sent = await client.callTool({ name: 'send_message', arguments: { to: '+911234567890', text: 'hi' } });
    expect(sent.isError).toBe(true);
    const body = JSON.parse((sent.content as { text: string }[])[0]?.text ?? '');
    expect(body).toMatchObject({ ok: false, data: null, error: { code: 'NOT_PAIRED' } });
    await client.close();
  });
});
