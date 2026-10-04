import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnvelope, validateBatch, toolResultMessages, repairMessage } from '../../src/agent/protocol.js';
import { ERROR_CODES, SafeError } from '../../src/shared/errors.js';
import { createRegistry } from '../../src/tools/registry.js';

const base = { kind: 'read', editors: ['word'], policy: 'auto', requires: [],
  schema: { type: 'object', additionalProperties: false, required: [], properties: {} },
  precondition: () => null, execute: () => ({ ok: true, data: {} }) };
const blocks = { type: 'object', additionalProperties: false, required: [],
  properties: { first: { type: 'string' }, second: { type: 'string' }, third: { type: 'string' } } };
const registry = createRegistry([
  { ...base, name: 'read_selection' },
  { ...base, name: 'insert_paragraph', kind: 'mutate' },
  { ...base, name: 'replace_selection', kind: 'mutate', policy: 'confirm' },
  { ...base, name: 'write_blocks', kind: 'mutate', schema: blocks }
]);
const catalogue = registry.catalogue({ editor: 'word', capabilities: ['document.read', 'document.write'], mode: 'EDIT' });

test('parses a final envelope and a fenced tool_calls envelope', () => {
  assert.deepEqual(parseEnvelope('{"type":"final","message":"Готово"}'), { type: 'final', message: 'Готово' });
  const fenced = '```json\n{"type":"tool_calls","calls":[{"tool":"read_selection","arguments":{}}]}\n```';
  assert.deepEqual(parseEnvelope(fenced).calls.map(call => call.tool), ['read_selection']);
});

test('rejects prose, unknown fields, empty and oversized batches', () => {
  assert.throws(() => parseEnvelope('готово'), /PROTOCOL_ERROR/);
  assert.throws(() => parseEnvelope('{"type":"final","message":"ok","extra":1}'), /PROTOCOL_ERROR/);
  assert.throws(() => parseEnvelope('{"type":"tool_calls","calls":[]}'), /PROTOCOL_ERROR/);
  const nine = { type: 'tool_calls', calls: new Array(9).fill({ tool: 'read_selection', arguments: {} }) };
  assert.throws(() => parseEnvelope(JSON.stringify(nine)), /PROTOCOL_ERROR/);
});

test('enforces the closed envelope, fence and byte-ceiling rules', () => {
  assert.deepEqual(parseEnvelope('```json\r\n{"type":"final","message":"ok"}\r\n```'), { type: 'final', message: 'ok' });
  for (const content of [null, 42, '', '   ', '[]', '[{"type":"final","message":"ok"}]',
    '{"type":"final","message":1}',
    '{"type":"tool_calls","calls":"read_selection"}',
    '{"type":"tool_calls","calls":[{"tool":"read_selection"}]}',
    '{"type":"tool_calls","calls":[{"tool":"read_selection","arguments":{},"extra":1}]}',
    '```json {"type":"final","message":"ok"}```',
    '```javascript\n{"type":"final","message":"ok"}\n```',
    '```json\n{}\n```\n```json\n{}\n```']) {
    assert.throws(() => parseEnvelope(content), /PROTOCOL_ERROR/, `content ${JSON.stringify(content)}`);
  }
  // The response ceiling is enforced before parsing: oversized content is BYTE_LIMIT, never a parse verdict.
  assert.throws(() => parseEnvelope('a'.repeat(70000)), /BYTE_LIMIT/);
  assert.throws(() => parseEnvelope(`{"type":"final","message":"${'a'.repeat(70000)}"}`), /BYTE_LIMIT/);
});

test('validateBatch resolves the whole batch before any execution', () => {
  const calls = [{ tool: 'read_selection', arguments: {} }, { tool: 'insert_paragraph', arguments: {} }];
  const resolved = validateBatch(catalogue, calls);
  assert.equal(resolved.length, 2);
  assert.equal(resolved[0].descriptor.kind, 'read');
  assert.ok(Object.isFrozen(resolved));
  assert.throws(() => validateBatch(catalogue, [{ tool: 'read_selection', arguments: {} }, { tool: 'nope', arguments: {} }]), /TOOL_ERROR/);
  assert.throws(() => validateBatch(catalogue, [{ tool: 'insert_paragraph', arguments: {} }, { tool: 'replace_selection', arguments: {} }]), /PROTOCOL_ERROR/);
});

test('validateBatch bounds the whole serialized arguments payload of one action', () => {
  const chunk = 'я'.repeat(4000);
  const bulk = { tool: 'write_blocks', arguments: { first: chunk, second: chunk, third: chunk } };
  assert.throws(() => validateBatch(catalogue, [bulk]), /TOOL_ERROR/);
  assert.equal(validateBatch(catalogue, [{ tool: 'write_blocks', arguments: { first: 'ok' } }]).length, 1);
});

test('validateBatch refuses malformed batches with classified errors', () => {
  const block = { tool: 'read_selection', arguments: {} };
  assert.throws(() => validateBatch(catalogue, []), /PROTOCOL_ERROR/);
  assert.throws(() => validateBatch(catalogue, null), /PROTOCOL_ERROR/);
  assert.throws(() => validateBatch(catalogue, new Array(9).fill(block)), /PROTOCOL_ERROR/);
  assert.throws(() => validateBatch(catalogue, [null, block]), /TOOL_ERROR/);
  assert.throws(() => validateBatch(catalogue, [{ arguments: {} }]), /TOOL_ERROR/);
});

test('tool results travel as bounded compatible user messages', () => {
  const messages = toolResultMessages([{ tool: 'read_selection', result: { ok: true, data: { bytes: 4 } } }]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.match(messages[0].content, /read_selection/);
});

test('repairMessage carries only a closed code, never raw content', () => {
  const message = repairMessage(new Error('SECRET-DOCUMENT-TEXT'));
  assert.match(message, /PROTOCOL_ERROR/);
  assert.doesNotMatch(message, /SECRET-DOCUMENT-TEXT/);
  assert.match(repairMessage(new SafeError(ERROR_CODES.TOOL_ERROR)), /TOOL_ERROR/);
});
