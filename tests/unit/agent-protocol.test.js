import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnvelope, validateBatch, toolResultMessages, repairMessage } from '../../src/agent/protocol.js';
import { ERROR_CODES, SafeError } from '../../src/shared/errors.js';
import { AGENT_CEILINGS } from '../../src/shared/limits.js';
import { utf8ByteLength } from '../../src/shared/bytes.js';
import { createRegistry } from '../../src/tools/registry.js';
import { createWordTools } from '../../src/tools/word.js';

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
  // A mixed confirm batch is a KNOWN tool error (§6.2), not a protocol error: a protocol error would
  // consume the run's single repair slot, and its repair text never asks the model to split the step.
  assert.throws(() => validateBatch(catalogue, [{ tool: 'insert_paragraph', arguments: {} }, { tool: 'replace_selection', arguments: {} }]), /TOOL_ERROR/);
});

test('validateBatch reports a repeated confirm tool as a known tool error', () => {
  const call = { tool: 'replace_selection', arguments: {} };
  assert.throws(() => validateBatch(catalogue, [call, { ...call }]), /TOOL_ERROR/);
});

// --- Fix round 3, finding 2: the read_context withholding is pinned IN THE REPO -------------------
// Ruling A (src/tools/word.js) withholds `read_context` with policy `deny`. The registry's catalogue
// drops a denied entry, and `validateBatch` resolves a model-emitted tool name AGAINST that catalogue,
// so the action is a closed TOOL_ERROR with no descriptor to execute. Measured against the real word
// descriptors and the real registry — no UI, no test double for the catalogue and no external probe.
test('a model-emitted read_context action is a known tool error in EDIT and ASK while read_selection resolves in ASK', () => {
  const fakeBridge = { readSelection: async () => ({ text: 'текст', eligible: true, target: 1 }) };
  const wordRegistry = createRegistry(createWordTools(fakeBridge));
  const wordCatalogue = mode => wordRegistry.catalogue({ editor: 'word', capabilities: ['document.read', 'document.write'], mode });
  for (const mode of ['EDIT', 'ASK']) {
    const offered = wordCatalogue(mode);
    assert.equal(offered.some(entry => entry.name === 'read_context'), false, `${mode} must not offer read_context`);
    // A model-emitted name that is not in the catalogue is a KNOWN tool error (§6.2), never a protocol
    // error: the run's single repair slot is not consumed, and no descriptor is handed to the executor.
    assert.throws(() => validateBatch(offered, [{ tool: 'read_context', arguments: { scope: 'paragraph', index: 0 } }]),
      /TOOL_ERROR/, `${mode}: a model-emitted read_context is refused as a known tool error`);
  }
  // The refusal comes from the withholding, not from the batch path: the read that IS offered in ASK
  // still resolves there, so this pins the withheld tool rather than a broken resolve.
  const resolved = validateBatch(wordCatalogue('ASK'), [{ tool: 'read_selection', arguments: {} }]);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].descriptor.name, 'read_selection');
  assert.equal(resolved[0].descriptor.kind, 'read');
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

test('toolResultMessages bounds every single result, not only the batch total', () => {
  const ok = (tool, characters) => [{ tool, result: { ok: true, data: { text: 'я'.repeat(characters) } } }];
  // Each entry is bounded on its own (§12.1: 16 KiB per result), independently of the batch total.
  assert.throws(() => toolResultMessages(ok('read_selection', 9000)), /TOOL_ERROR/);
  // Finding 3 changed the aggregate semantics: a batch no longer travels as one batch-sized message,
  // so several small entries are ACCEPTED as one message per entry, each under the per-result
  // ceiling — never as a single message that the 64 KiB window would have to truncate or refuse.
  const twoSmall = [...ok('read_selection', 3000), ...ok('read_selection', 3000)];
  const messages = toolResultMessages(twoSmall);
  assert.equal(messages.length, 2);
  for (const message of messages) assert.ok(utf8ByteLength(message.content) <= AGENT_CEILINGS.toolResultBytes);
});

test('one message per result keeps every tool_results message inside the per-result ceiling', () => {
  const entry = index => ({ tool: 'read_selection', result: { ok: true, data: { index } } });
  // The published value keeps the protocol's existing flattened shape: { tool, ...result }.
  const published = index => ({ tool: 'read_selection', ok: true, data: { index } });
  const results = [0, 1, 2, 3, 4].map(entry);
  const messages = toolResultMessages(results);
  assert.equal(messages.length, 5, 'one message per result, not one message per batch');
  assert.ok(Object.isFrozen(messages) && messages.every(Object.isFrozen));
  for (const [index, message] of messages.entries()) {
    assert.equal(message.role, 'user');
    assert.ok(utf8ByteLength(message.content) <= AGENT_CEILINGS.toolResultBytes);
    assert.deepEqual(JSON.parse(message.content), { type: 'tool_results', results: [published(index)] });
  }
  // A single oversized entry is refused whatever the rest of the batch looks like.
  assert.throws(() => toolResultMessages([...results.slice(0, 4), { tool: 'read_selection', result: { ok: true, data: { text: 'я'.repeat(9000) } } }]), /TOOL_ERROR/);
});

test('toolResultMessages converts every malformed batch into a classified tool error', () => {
  assert.throws(() => toolResultMessages(null), /TOOL_ERROR/);
  assert.throws(() => toolResultMessages({ length: 1, 0: { tool: 'read_selection', result: { ok: true, data: {} } } }), /TOOL_ERROR/);
  assert.throws(() => toolResultMessages('results'), /TOOL_ERROR/);
  assert.throws(() => toolResultMessages([null]), /TOOL_ERROR/);
  // JSON.stringify throws the raw TypeError; it must never escape the classified-error contract.
  assert.throws(() => toolResultMessages([{ tool: 'read_selection', result: { ok: true, data: 10n } }]), /TOOL_ERROR/);
  const circular = { ok: true, data: {} };
  circular.data.self = circular;
  assert.throws(() => toolResultMessages([{ tool: 'read_selection', result: circular }]), /TOOL_ERROR/);
  const trap = { ok: true, get data() { throw new Error('trap'); } };
  assert.throws(() => toolResultMessages([{ tool: 'read_selection', result: trap }]), /TOOL_ERROR/);
});

test('repairMessage carries only a closed code, never raw content', () => {
  const message = repairMessage(new Error('SECRET-DOCUMENT-TEXT'));
  assert.match(message, /PROTOCOL_ERROR/);
  assert.doesNotMatch(message, /SECRET-DOCUMENT-TEXT/);
  assert.match(repairMessage(new SafeError(ERROR_CODES.TOOL_ERROR)), /TOOL_ERROR/);
});

// --- Fix round 4, finding 6(a): an entry is bounded by its OWN serialization ----------------------
// §12.1 bounds one tool RESULT. The 36-byte message envelope ({"type":"tool_results","results":[…]})
// CARRIES the entry; charging those bytes to the entry refused a legal result whose own serialization
// sat in the top 36 bytes of the ceiling (16348..16384) — a batch that previously travelled as one
// message accepted exactly that entry.

// Pad an entry's `text` so its own serialization — the value the protocol actually measures — is
// exactly `bytes`. The shape alone is 54 bytes, so the test builds sizes, never trusts a magic one.
const entryEnvelopeBytes = tool => utf8ByteLength(JSON.stringify({ tool, ok: true, data: { text: '' } }));
function entryOfOwnSize(tool, bytes) {
  const result = { ok: true, data: { text: '' } };
  const base = entryEnvelopeBytes(tool);
  assert.ok(bytes >= base, `cannot build a ${bytes}-byte entry: the shape alone is ${base} bytes`);
  result.data.text = 'a'.repeat(bytes - base);
  return { tool, result };
}
const ownSize = entry => utf8ByteLength(JSON.stringify({ tool: entry.tool, ...entry.result }));

test('a tool result is bounded by its own serialization, never by the envelope that carries it', () => {
  const limit = AGENT_CEILINGS.toolResultBytes;
  const exact = entryOfOwnSize('read_selection', limit);
  const justUnder = entryOfOwnSize('read_selection', limit - 1);
  const over = entryOfOwnSize('read_selection', limit + 1);
  assert.equal(ownSize(exact), limit);
  assert.equal(ownSize(justUnder), limit - 1);
  assert.equal(ownSize(over), limit + 1);
  for (const entry of [exact, justUnder]) {
    const messages = toolResultMessages([entry]);
    assert.equal(messages.length, 1);
    // The MESSAGE is larger than the per-result ceiling by the envelope's own bytes — that is the
    // point: the entry passed its bound, so the envelope must not be charged against it.
    assert.ok(utf8ByteLength(messages[0].content) > limit);
    assert.deepEqual(JSON.parse(messages[0].content), { type: 'tool_results', results: [{ tool: entry.tool, ...entry.result }] });
  }
  // One byte past the entry's own ceiling is still the entry's own breach.
  assert.throws(() => toolResultMessages([over]), /TOOL_ERROR/);
});

test('a multi-action batch accepts an entry in the previously-refused top-36-byte window', () => {
  // 16350 is inside 16348..16384: legal against the entry ceiling, but 16386 bytes once the envelope
  // was counted — which is exactly how the envelope came to refuse it.
  const wide = entryOfOwnSize('read_selection', 16350);
  const messages = toolResultMessages([wide, { tool: 'read_selection', result: { ok: true, data: {} } }]);
  assert.equal(messages.length, 2, 'one message per result, both accepted');
  assert.deepEqual(Object.keys(JSON.parse(messages[0].content)).sort(), ['results', 'type']);
  assert.equal(JSON.parse(messages[0].content).results[0].data.text.length, wide.result.data.text.length);
  assert.deepEqual(JSON.parse(messages[1].content), { type: 'tool_results', results: [{ tool: 'read_selection', ok: true, data: {} }] });
});
