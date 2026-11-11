#!/usr/bin/env node
/**
 * The MCP SDK's generic request() path calls safeParse(resultSchema, ...) with
 * resultSchema undefined when a caller does not pass one, which throws
 * "Cannot read properties of undefined (reading '_zod')". A generic client
 * request therefore fails on every server, including a stock one.
 *
 * This makes the parse tolerant of a missing result schema. It is applied on
 * postinstall so a fresh install keeps working.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const target = path.join(
  'node_modules',
  '@modelcontextprotocol',
  'sdk',
  'dist',
  'esm',
  'shared',
  'protocol.js',
);

const OLD = 'const parseResult = safeParse(resultSchema, response.result);';
const NEW =
  'const parseResult = resultSchema ? safeParse(resultSchema, response.result) : { success: true, data: response.result };';

let source;
try {
  source = readFileSync(target, 'utf8');
} catch {
  process.stderr.write('[patch-sdk] SDK not installed yet; nothing to patch.\n');
  process.exit(0);
}

if (!source.includes(OLD)) {
  process.stderr.write('[patch-sdk] already patched or upstream changed; leaving as is.\n');
  process.exit(0);
}

writeFileSync(target, source.replace(OLD, NEW));
process.stderr.write('[patch-sdk] patched generic request() result parsing.\n');
