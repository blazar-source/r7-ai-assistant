import test from 'node:test';
import assert from 'node:assert/strict';
import { secureUUID, buildMessages, boundDisplayHistory, createChatSession, appendChatPair, newChat, createConnectionSession, snapshotRequestMessages, snapshotAgentMessages } from '../../src/shared/session.js';
import { createRequest } from '../../src/ai/protocol.js';
const code = want => error => error.code === want && error.message === want;
const cryptoSource = () => { let n = 0; return { randomUUID: () => `12345678-1234-4234-8234-${String(++n).padStart(12, '0')}` }; };
const pair = (user, assistant) => [{ role: 'user', content: user }, { role: 'assistant', content: assistant }];

test('secure UUID uses randomUUID or v4 bit-correct getRandomValues, never weak fallback', () => {
  assert.equal(secureUUID(cryptoSource()), '12345678-1234-4234-8234-000000000001');
  assert.equal(secureUUID({ getRandomValues: bytes => bytes.fill(255) }), 'ffffffff-ffff-4fff-bfff-ffffffffffff');
  assert.throws(() => secureUUID({}), code('CAPABILITY_UNAVAILABLE'));
  assert.throws(() => secureUUID({ randomUUID: () => 'unsafe' }), code('INVALID_DATA'));
});

test('chat requests keep UUID; temporary connection never rotates or appends chat; new chat rotates', () => {
  const crypto = cryptoSource();
  const initial = createChatSession(crypto);
  assert.deepEqual(initial.history, []);
  const chat = appendChatPair(initial, 'question', 'answer');
  assert.equal(chat.uuid, initial.uuid);
  const connection = createConnectionSession(crypto);
  assert.notEqual(connection.uuid, chat.uuid); assert.deepEqual(connection.history, []);
  assert.deepEqual(chat.history, pair('question', 'answer'));
  const next = newChat(crypto);
  assert.notEqual(next.uuid, chat.uuid); assert.notEqual(next.uuid, connection.uuid);
  assert.deepEqual(next.history, []);
  for (const value of [chat, chat.history, ...chat.history, connection, connection.history]) assert.ok(Object.isFrozen(value));
});

test('sent history culls oldest complete pairs and preserves system/current input by count', () => {
  const history = Array.from({ length: 20 }, (_, i) => pair(`q${i}`, `a${i}`)).flat();
  const sent = buildMessages('rules', 'current', history);
  assert.equal(sent.length, 32);
  assert.deepEqual(sent[0], { role: 'system', content: 'rules' });
  assert.deepEqual(sent[1], { role: 'user', content: 'q5' });
  assert.deepEqual(sent.at(-1), { role: 'user', content: 'current' });
  history.at(-1).content = 'mutated'; assert.equal(sent.at(-2).content, 'a19');
  assert.ok(Object.isFrozen(sent)); assert.ok(sent.every(Object.isFrozen));
});

test('sent history culls by UTF-8 bytes and rejects mandatory/user overflow without truncation', () => {
  const history = [...pair('old', 'a'.repeat(30000)), ...pair('new', 'b'.repeat(30000))];
  const sent = buildMessages('s'.repeat(10000), 'current', history);
  assert.deepEqual(sent.slice(1, -1), pair('new', 'b'.repeat(30000)));
  assert.equal(buildMessages('s'.repeat(57344), 'я'.repeat(4096)).length, 2);
  assert.throws(() => buildMessages('s'.repeat(57345), 'я'.repeat(4096)), code('BYTE_LIMIT'));
  assert.throws(() => buildMessages('rules', 'я'.repeat(4097)), code('BYTE_LIMIT'));
  for (const malformed of [[{ role: 'assistant', content: 'orphan' }], pair('u', 'a').reverse(), [{ role: 'user', content: 'u' }]]) assert.throws(() => buildMessages('rules', 'now', malformed), code('INVALID_DATA'));
});

// A realistic agent window, in the runtime-authored order: the pinned system rules and request, then
// one assistant envelope / tool-result user message per step. Position 2 is the drop marker (an
// adjacent user note after eviction) and step 8's tool result is missing (an eviction left two
// adjacent assistant envelopes). Both shapes are impossible for the Sprint 1 chat snapshot.
const agentWindow = () => {
  const messages = [
    { role: 'system', content: 'Режим: EDIT. Инструменты: read_selection (read, auto).' },
    { role: 'user', content: 'сделай отчёт по выделению' },
    { role: 'user', content: 'earlier tool results were dropped from context; re-read what you still need' }
  ];
  for (let n = 0; n < 19; n += 1) {
    messages.push({ role: 'assistant', content: `{"type":"tool_calls","calls":[{"tool":"read_selection","arguments":{}}],"n":${n}}` });
    if (n === 8) continue;
    messages.push({ role: 'user', content: `{"type":"tool_results","results":[{"tool":"read_selection","result":{"ok":true}}],"n":${n}}` });
  }
  messages.push({ role: 'assistant', content: '{"type":"final","message":"готово"}' });
  return messages;
};

test('the agent snapshot keeps the runtime-authored order with no chat alternation requirement', () => {
  const input = agentWindow();
  const snapshot = snapshotAgentMessages(input);
  assert.ok(input.length >= 40, 'the fixture must be a long agent conversation');
  assert.equal(snapshot.length, input.length);
  assert.deepEqual(snapshot, input);
  assert.deepEqual(snapshot.map(message => message.role), input.map(message => message.role));
  assert.equal(snapshot.filter(message => message.role === 'system').length, 1);
  assert.deepEqual(snapshot.slice(1, 3).map(message => message.role), ['user', 'user']);
  assert.deepEqual(snapshot.slice(19, 21).map(message => message.role), ['assistant', 'assistant']);
  assert.ok(Object.isFrozen(snapshot) && snapshot.every(Object.isFrozen));
  // Same conversation, strict chat snapshot: a run longer than the Sprint 1 count cap cannot be sent.
  assert.throws(() => snapshotRequestMessages(input), code('BYTE_LIMIT'));
});

test('the agent snapshot refuses a second system, an unknown role, a getter and both byte overflows', () => {
  const system = { role: 'system', content: 'rules' };
  assert.throws(() => snapshotAgentMessages('not an array'), code('INVALID_DATA'));
  assert.throws(() => snapshotAgentMessages([system]), code('INVALID_DATA'));
  assert.throws(() => snapshotAgentMessages([system, { role: 'system', content: 'again' }]), code('INVALID_DATA'));
  assert.throws(() => snapshotAgentMessages([system, { role: 'tool', content: '{}' }]), code('INVALID_DATA'));
  assert.throws(() => snapshotAgentMessages([system, Object.create({ role: 'user', content: 'x' })]), code('INVALID_DATA'));
  const getter = { role: 'user' };
  Object.defineProperty(getter, 'content', { enumerable: true, get: () => 'x' });
  assert.throws(() => snapshotAgentMessages([system, getter]), code('INVALID_DATA'));
  // 32769 UTF-8 two-byte characters = 65538 bytes, one byte pair past the active-context ceiling.
  // Finding 4 pins position 1 (the original request) to the user-input bound, so the window ceiling is
  // exercised on a later, runtime-authored message.
  const request = { role: 'user', content: 'сделай' };
  assert.throws(() => snapshotAgentMessages([system, request, { role: 'assistant', content: 'я'.repeat(32769) }]), code('BYTE_LIMIT'));
  // Every message inside the ceiling, but the total content past it: the aggregate bound still holds.
  assert.throws(() => snapshotAgentMessages([system, request, { role: 'assistant', content: 'a'.repeat(40000) }, { role: 'assistant', content: 'b'.repeat(40000) }]), code('BYTE_LIMIT'));
});

test('the agent snapshot bounds the pinned request by the user-input limit, not the window ceiling', () => {
  const system = { role: 'system', content: 'rules' };
  const request = { role: 'user', content: 'сделай' };
  // 4097 two-byte characters = 8194 bytes: one byte pair past LIMITS.userInputBytes (8192), yet far
  // inside the active-context window, so only the pinned-request bound can refuse it.
  assert.throws(() => snapshotAgentMessages([system, { role: 'user', content: 'я'.repeat(4097) }]), code('BYTE_LIMIT'));
  assert.equal(snapshotAgentMessages([system, { role: 'user', content: 'я'.repeat(4096) }]).length, 2);
  // A runtime-authored tool-result message keeps the much larger active-context bound.
  const large = `{"type":"tool_results","results":[{"tool":"read_selection","result":{"ok":true,"data":{"text":"${'a'.repeat(60000)}"}}}]}`;
  const snapshot = snapshotAgentMessages([system, request,
    { role: 'assistant', content: '{"type":"tool_calls","calls":[{"tool":"read_selection","arguments":{}}]}' },
    { role: 'user', content: large }]);
  assert.equal(snapshot.at(-1).content, large);
});

test('createRequest takes the agent snapshot only when the option asks for it', () => {
  const input = agentWindow();
  const settings = { endpoint: 'https://example.invalid/v1/chat/completions', apiKey: 'synthetic-key' };
  const uuid = '00000000-0000-4000-8000-000000000001';
  const request = createRequest(settings, input, uuid, { agent: true });
  assert.deepEqual(JSON.parse(request.body).messages, input);
  assert.equal(request.messages.length, input.length);
  // No option: the default chat snapshot is untouched and still refuses this conversation.
  assert.throws(() => createRequest(settings, input, uuid), code('BYTE_LIMIT'));
});

test('display retains current complete pair and culls oldest by count/bytes without mutation', () => {
  const entries = Array.from({ length: 40 }, (_, i) => pair(`q${i}`, `a${i}`)).flat();
  const display = boundDisplayHistory(entries);
  assert.equal(display.length, 64); assert.equal(display[0].content, 'q8'); assert.equal(display.at(-1).content, 'a39');
  const large = boundDisplayHistory([...pair('u1', 'a'.repeat(65536)), ...pair('u2', 'b'.repeat(65536))]);
  assert.deepEqual(large, pair('u2', 'b'.repeat(65536)));
  assert.throws(() => boundDisplayHistory(pair('я'.repeat(4097), 'ok')), code('BYTE_LIMIT'));
  assert.throws(() => boundDisplayHistory(pair('ok', 'a'.repeat(65537))), code('BYTE_LIMIT'));
  assert.equal(entries.length, 80);
});
