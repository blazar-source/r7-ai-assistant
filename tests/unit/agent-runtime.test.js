import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../../src/agent/runtime.js';
import { createRegistry } from '../../src/tools/registry.js';
import { ERROR_CODES, SafeError } from '../../src/shared/errors.js';

const base = { kind: 'read', editors: ['word'], policy: 'auto', requires: [],
  schema: { type: 'object', additionalProperties: false, required: [], properties: {} } };
const calls = [];
const registry = createRegistry([
  { ...base, name: 'read_selection', precondition: () => null, execute: () => ({ ok: true, data: { bytes: 4 } }) },
  { ...base, name: 'insert_paragraph', kind: 'mutate', precondition: () => null,
    execute: (args) => { calls.push(args); return { ok: true, data: { inserted: true } }; } },
  { ...base, name: 'replace_selection', kind: 'mutate', policy: 'confirm', precondition: () => null, execute: () => ({ ok: true, data: {} }) }
]);
const editor = { editor: 'word', capabilities: ['document.read', 'document.write'], mode: 'EDIT' };
const baseArgs = { registry, ...editor, settings: {}, uuid: '11111111-1111-4111-8111-111111111111', request: 'сделай' };

function respond(sequence) {
  let index = 0;
  return async () => ({ content: sequence[Math.min(index++, sequence.length - 1)] });
}

test('runs read then a batch of auto mutations then final, in order', async () => {
  calls.length = 0;
  const result = await runAgent({ ...baseArgs, transport: respond([
    '{"type":"tool_calls","calls":[{"tool":"read_selection","arguments":{}}]}',
    '{"type":"tool_calls","calls":[{"tool":"insert_paragraph","arguments":{}},{"tool":"insert_paragraph","arguments":{}}]}',
    '{"type":"final","message":"Готово"}'
  ]) });
  assert.equal(result.status, 'FINAL');
  assert.equal(result.message, 'Готово');
  assert.equal(result.steps, 3);
  assert.equal(result.toolCalls, 3);
  assert.equal(calls.length, 2);
});

test('a known tool error is returned to the model and the run continues', async () => {
  const failing = createRegistry([
    { ...base, name: 'read_selection', precondition: () => null, execute: () => ({ ok: false, code: 'TOOL_ERROR', message: 'нет документа' }) }
  ]);
  const result = await runAgent({ ...baseArgs, registry: failing, transport: respond([
    '{"type":"tool_calls","calls":[{"tool":"read_selection","arguments":{}}]}',
    '{"type":"final","message":"обошёл"}'
  ]) });
  assert.equal(result.status, 'FINAL');
  assert.equal(result.actions[0].outcome, 'error');
});

test('an uncertain mutation stops the run and prevents the rest of the batch', async () => {
  calls.length = 0;
  // Brief fixture corrected: the batch's FIRST action really does execute, so the marker can only
  // belong to the action AFTER the uncertain one — which is exactly what must not run. The
  // assertion below is the brief's, unchanged.
  const uncertain = createRegistry([
    { ...base, name: 'read_selection', precondition: () => null, execute: () => ({ ok: true, data: {} }) },
    { ...base, name: 'insert_paragraph', kind: 'mutate', precondition: () => null,
      execute: () => ({ ok: false, code: 'TOOL_UNCERTAIN', message: 'unknown' }) },
    { ...base, name: 'read_context', precondition: () => null, execute: () => { calls.push('late'); return { ok: true, data: {} }; } }
  ]);
  const result = await runAgent({ ...baseArgs, registry: uncertain, transport: respond([
    '{"type":"tool_calls","calls":[{"tool":"read_selection","arguments":{}},{"tool":"insert_paragraph","arguments":{}},{"tool":"read_context","arguments":{}}]}'
  ]) });
  assert.equal(result.status, 'UNCERTAIN');
  assert.equal(result.toolCalls, 2);
  assert.deepEqual(calls, []);
});

test('a confirm tool yields a preview and never executes in the loop', async () => {
  calls.length = 0;
  const result = await runAgent({ ...baseArgs, transport: respond([
    '{"type":"tool_calls","calls":[{"tool":"replace_selection","arguments":{}}]}'
  ]) });
  assert.equal(result.status, 'PREVIEW_READY');
  assert.equal(result.toolCalls, 0);
});

test('malformed JSON gets exactly one repair request, then a second failure ends the run', async () => {
  const repaired = await runAgent({ ...baseArgs, transport: respond(['не json', '{"type":"final","message":"ок"}']) });
  assert.equal(repaired.status, 'FINAL');
  assert.equal(repaired.repairs, 1);
  const dead = await runAgent({ ...baseArgs, transport: respond(['не json', 'тоже не json', '{"type":"final","message":"ок"}']) });
  assert.equal(dead.status, 'PROTOCOL_ERROR');
});

test('guardrails stop the run: maxToolCalls', async () => {
  const result = await runAgent({ ...baseArgs,
    guardrails: { maxSteps: 10, maxToolCalls: 1, operationDeadlineMs: 150000 },
    transport: respond(['{"type":"tool_calls","calls":[{"tool":"read_selection","arguments":{}},{"tool":"read_selection","arguments":{}}]}']) });
  assert.equal(result.status, 'LIMIT');
  assert.equal(result.toolCalls, 1);
});

test('Stop prevents not-yet-started actions and leaves completed ones recorded', async () => {
  const controller = new AbortController();
  const stopping = createRegistry([
    { ...base, name: 'insert_paragraph', kind: 'mutate', precondition: () => null,
      execute: () => { controller.abort(); return { ok: true, data: { inserted: true } }; } },
    { ...base, name: 'read_selection', precondition: () => null, execute: () => { calls.push('must-not-run'); return { ok: true, data: {} }; } }
  ]);
  calls.length = 0;
  const result = await runAgent({ ...baseArgs, registry: stopping, signal: controller.signal, transport: respond([
    '{"type":"tool_calls","calls":[{"tool":"insert_paragraph","arguments":{}},{"tool":"read_selection","arguments":{}}]}'
  ]) });
  assert.equal(result.status, 'CANCELLED');
  assert.equal(result.actions.length, 1);
  assert.deepEqual(calls, []);
});

// --- Controller rulings beyond the brief's snippet -------------------------------------------

test('an already-expired operation deadline returns LIMIT without a transport call', async () => {
  let reads = 0;
  let sent = 0;
  const clock = () => (reads++ === 0 ? 0 : 1000);
  const result = await runAgent({ ...baseArgs, now: clock,
    guardrails: { maxSteps: 5, maxToolCalls: 5, operationDeadlineMs: 1000 },
    transport: async () => { sent += 1; return { content: '{"type":"final","message":"late"}' }; } });
  assert.equal(result.status, 'LIMIT');
  assert.equal(result.steps, 0);
  assert.equal(result.toolCalls, 0);
  assert.equal(sent, 0);
});

test('the deadline guardrail stops the run between two steps', async () => {
  let clock = 0;
  let sent = 0;
  const result = await runAgent({ ...baseArgs, now: () => clock,
    guardrails: { maxSteps: 5, maxToolCalls: 5, operationDeadlineMs: 100 },
    transport: async () => { sent += 1; clock = 5000; return { content: '{"type":"tool_calls","calls":[{"tool":"read_selection","arguments":{}}]}' }; } });
  assert.equal(result.status, 'LIMIT');
  assert.equal(result.steps, 1);
  assert.equal(sent, 1);
});

test('an unknown tool is refused as a tool result and never spends the protocol repair', async () => {
  const seen = [];
  let index = 0;
  const sequence = [
    '{"type":"tool_calls","calls":[{"tool":"missing_tool","arguments":{}}]}',
    'не json',
    '{"type":"final","message":"ок"}'
  ];
  const result = await runAgent({ ...baseArgs, transport: async (messages) => {
    seen.push(messages.map(message => message.content));
    return { content: sequence[Math.min(index++, sequence.length - 1)] };
  } });
  // The later malformed envelope still gets the one and only repair: the tool error spent none.
  assert.equal(result.status, 'FINAL');
  assert.equal(result.repairs, 1);
  assert.equal(result.toolCalls, 0);
  assert.deepEqual(result.actions, []);
  assert.ok(seen[1].some(content => content.includes('"type":"tool_results"')), 'the refusal must reach the model as a tool result');
});

test('a mixed confirm batch is refused whole, before any action executes', async () => {
  calls.length = 0;
  const result = await runAgent({ ...baseArgs, transport: respond([
    '{"type":"tool_calls","calls":[{"tool":"replace_selection","arguments":{}},{"tool":"insert_paragraph","arguments":{}}]}',
    '{"type":"final","message":"разделил"}'
  ]) });
  assert.equal(result.status, 'FINAL');
  assert.equal(result.message, 'разделил');
  assert.equal(result.repairs, 0);
  assert.equal(result.toolCalls, 0);
  assert.equal(result.actions.length, 0);
  assert.deepEqual(calls, []);
});

test('a transport failure is classified and never spends the protocol repair', async () => {
  let sent = 0;
  const result = await runAgent({ ...baseArgs, transport: async () => { sent += 1; throw new SafeError(ERROR_CODES.NETWORK_ERROR); } });
  assert.equal(result.status, 'ERROR');
  assert.equal(result.code, 'NETWORK_ERROR');
  assert.equal(result.repairs, 0);
  assert.equal(sent, 1, 'a transport failure must not be answered with a repair request');
  assert.deepEqual(result.actions, []);
});

test('a cancelled transport settles the run as CANCELLED without a repair', async () => {
  let sent = 0;
  const result = await runAgent({ ...baseArgs, transport: async () => { sent += 1; throw new SafeError(ERROR_CODES.CANCELLED); } });
  assert.equal(result.status, 'CANCELLED');
  assert.equal(result.repairs, 0);
  assert.equal(sent, 1);
});

test('every assistant envelope and tool result is appended through the bounded window', async () => {
  const wire = [];
  let index = 0;
  const sequence = ['{"type":"tool_calls","calls":[{"tool":"read_selection","arguments":{}}]}', '{"type":"final","message":"ок"}'];
  const result = await runAgent({ ...baseArgs, transport: async (messages) => {
    wire.push(messages.map(message => message.role));
    return { content: sequence[Math.min(index++, sequence.length - 1)] };
  } });
  assert.equal(result.status, 'FINAL');
  assert.deepEqual(wire, [['system', 'user'], ['system', 'user', 'assistant', 'user']]);
});

test('a batch dispatches one handler at a time, in order, never concurrently', async () => {
  let outstanding = 0;
  let peak = 0;
  const order = [];
  const serial = createRegistry([
    { ...base, name: 'serial_write', kind: 'mutate', precondition: () => null,
      schema: { type: 'object', additionalProperties: false, required: ['index'], properties: { index: { type: 'integer' } } },
      execute: async (args) => {
        outstanding += 1;
        peak = Math.max(peak, outstanding);
        await new Promise(resolve => { setImmediate(resolve); });
        order.push(args.index);
        outstanding -= 1;
        return { ok: true, data: { index: args.index } };
      } }
  ]);
  const result = await runAgent({ ...baseArgs, registry: serial, transport: respond([
    '{"type":"tool_calls","calls":[{"tool":"serial_write","arguments":{"index":1}},{"tool":"serial_write","arguments":{"index":2}},{"tool":"serial_write","arguments":{"index":3}}]}',
    '{"type":"final","message":"ок"}'
  ]) });
  assert.equal(result.status, 'FINAL');
  assert.equal(result.toolCalls, 3);
  assert.equal(peak, 1);
  assert.deepEqual(order, [1, 2, 3]);
});

test('the actions log carries outcome and size only, never arguments or content', async () => {
  const result = await runAgent({ ...baseArgs, transport: respond([
    '{"type":"tool_calls","calls":[{"tool":"read_selection","arguments":{}}]}',
    '{"type":"final","message":"ок"}'
  ]) });
  assert.deepEqual(Object.keys(result.actions[0]).sort(), ['bytes', 'outcome', 'tool']);
  assert.equal(result.actions[0].tool, 'read_selection');
  assert.equal(result.actions[0].outcome, 'ok');
  assert.ok(Number.isInteger(result.actions[0].bytes) && result.actions[0].bytes > 0);
  assert.ok(Object.isFrozen(result.actions[0]));
});

test('an uncertain action is recorded as uncertain, not as an ordinary tool error', async () => {
  const uncertain = createRegistry([
    { ...base, name: 'insert_paragraph', kind: 'mutate', precondition: () => null,
      execute: async () => ({ ok: false, code: 'TOOL_UNCERTAIN', message: 'unknown' }) }
  ]);
  const result = await runAgent({ ...baseArgs, registry: uncertain, transport: respond([
    '{"type":"tool_calls","calls":[{"tool":"insert_paragraph","arguments":{}}]}'
  ]) });
  assert.equal(result.status, 'UNCERTAIN');
  assert.deepEqual(result.actions.map(action => action.outcome), ['uncertain']);
});

test('an invalid setup is a closed result, never a rejected promise', async () => {
  let sent = 0;
  const invalidMode = await runAgent({ ...baseArgs, mode: 'OTHER', transport: async () => { sent += 1; } });
  assert.equal(invalidMode.status, 'ERROR');
  assert.equal(invalidMode.code, 'INVALID_DATA');
  assert.equal(invalidMode.steps, 0);
  assert.equal(sent, 0);
  const missing = await runAgent({});
  assert.equal(missing.status, 'ERROR');
  assert.equal(missing.code, 'INTERNAL_ERROR');
  assert.deepEqual(missing.actions, []);
});

test('without an injected transport the default send is the strict-bank request path', async () => {
  // No fetch is stubbed: settings validation fails first, so the wiring is asserted without a
  // network call. A missing default send would surface as INTERNAL_ERROR instead.
  const result = await runAgent({ ...baseArgs });
  assert.equal(result.status, 'ERROR');
  assert.equal(result.code, 'INVALID_ENDPOINT');
  assert.equal(result.repairs, 0);
  assert.deepEqual(result.actions, []);
});
