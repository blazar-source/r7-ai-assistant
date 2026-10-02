import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequest, parseModelContent } from '../../src/ai/protocol.js';
import { validateRequestSettings } from '../../src/config/settings.js';
const uuid = '12345678-1234-4234-8234-123456789abc';
const settings = () => validateRequestSettings({ endpoint: 'https://example.invalid/prefix/v1/chat/completions', apiKey: 'synthetic-key', model: 'qwen/qwen3.8-27b:free' });
const messages = () => [{ role: 'system', content: 'rules' }, { role: 'user', content: 'question' }];
const code = want => error => error.name === 'SafeError' && error.code === want && error.message === want && !error.cause;

test('request preserves full endpoint/model and exact bank body/headers with frozen copies', () => {
  const input = messages();
  const draft = { ...settings() };
  const request = createRequest(draft, input, uuid);
  assert.equal(request.endpoint, 'https://example.invalid/prefix/v1/chat/completions');
  assert.deepEqual(request.headers, { Authorization: 'Bearer synthetic-key', 'Content-Type': 'application/json', 'X-Session-ID': uuid });
  assert.deepEqual(JSON.parse(request.body), { model: 'qwen/qwen3.8-27b:free', messages: messages(), max_tokens: 1024, temperature: 0.2 });
  input[1].content = 'changed'; draft.model = 'changed';
  assert.equal(JSON.parse(request.body).messages[1].content, 'question');
  assert.equal(request.settings.model, 'qwen/qwen3.8-27b:free');
  for (const value of [request, request.settings, request.headers, request.messages, ...request.messages]) assert.ok(Object.isFrozen(value));
});

test('request rejects missing credentials, header-injection UUID, invalid roles/fields and mandatory shape', () => {
  for (const id of ['', uuid + '\r\nInjected: yes', 'not-uuid']) assert.throws(() => createRequest(settings(), messages(), id), code('INVALID_DATA'));
  assert.throws(() => createRequest({}, messages(), uuid), code('INVALID_ENDPOINT'));
  for (const input of [[], [{ role: 'user', content: 'only' }], [...messages(), { role: 'tool', content: 'native' }], [{ role: 'system', content: 'rules', name: 'extra' }, messages()[1]], [{ role: 'system', content: 'rules' }, { role: 'user', content: 1 }]]) {
    assert.throws(() => createRequest(settings(), input, uuid), code('INVALID_DATA'));
  }
});

test('request rejects count/content/user and serialized escaped-body excess before sending', () => {
  assert.throws(() => createRequest(settings(), [messages()[0], { role: 'user', content: 'я'.repeat(4097) }], uuid), code('BYTE_LIMIT'));
  const many = [messages()[0], ...Array.from({ length: 16 }, () => [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]).flat(), messages()[1]];
  assert.throws(() => createRequest(settings(), many, uuid), code('BYTE_LIMIT'));
  assert.throws(() => createRequest(settings(), [{ role: 'system', content: 'a'.repeat(65536) }, messages()[1]], uuid), code('BYTE_LIMIT'));
  assert.throws(() => createRequest(settings(), [{ role: 'system', content: '\u0000'.repeat(20000) }, messages()[1]], uuid), code('BYTE_LIMIT'));
});

test('closed final works in both modes and a single complete json fence is accepted', () => {
  for (const mode of ['ASK', 'EDIT']) {
    const result = parseModelContent('  {"type":"final","message":"Привет"}  ', mode);
    assert.deepEqual(result, { type: 'final', message: 'Привет' });
    assert.ok(Object.isFrozen(result));
    assert.deepEqual(parseModelContent('```json\n{"type":"final","message":"ok"}\n```', mode), { type: 'final', message: 'ok' });
  }
});

test('only EDIT accepts frozen closed replacement proposal including empty replacement', () => {
  for (const text of ['new text', '']) {
    const content = JSON.stringify({ type: 'tool', tool: 'r7_replace_selection', arguments: { text } });
    const result = parseModelContent(content, 'EDIT');
    assert.deepEqual(result, { type: 'tool', tool: 'r7_replace_selection', arguments: { text } });
    assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.arguments));
    assert.throws(() => parseModelContent(content, 'ASK'), code('PROTOCOL_ERROR'));
  }
});

test('parser rejects prose, partial/multiple fences, unknown/prototype fields, tools and native fallback', () => {
  const invalid = ['hello', 'prefix {"type":"final","message":"ok"}', '{"type":"final","message":"ok"} tail', '```\n{"type":"final","message":"ok"}\n```', '```json\n{"type":"final","message":"ok"}', '```json\n{}\n```\n```json\n{}\n```', 'null', '[]', '{"type":"final","message":1}', '{"type":"final","message":"ok","extra":1}', '{"type":"final","message":"ok","__proto__":{}}', '{"type":"tool","tool":"other","arguments":{"text":"x"}}', '{"type":"tool","tool":"r7_replace_selection","arguments":{"text":"x","extra":1}}', '{"type":"tool","tool":"r7_replace_selection","arguments":{"text":1}}', '{"tool_calls":[{}]}', '{"type":"final","message":"ok","tool_calls":[]}'];
  for (const value of invalid) assert.throws(() => parseModelContent(value, 'EDIT'), code('PROTOCOL_ERROR'), value);
  assert.throws(() => parseModelContent('{}', 'unknown'), code('INVALID_DATA'));
  assert.throws(() => parseModelContent(null, 'ASK'), code('PROTOCOL_ERROR'));
});

test('canonical final result cannot exceed result budget through lone-surrogate JSON expansion', () => {
  const content = '{"type":"final","message":"' + '\ud800'.repeat(11000) + '"}';
  assert.throws(() => parseModelContent(content, 'ASK'), code('BYTE_LIMIT'));
});

test('request escaped serialization accepts exact wire cap and rejects next byte', () => {
  const skeleton = '{"model":"qwen/qwen3.8-27b:free","messages":[{"role":"system","content":""},{"role":"user","content":"question"}],"max_tokens":1024,"temperature":0.2}';
  const remaining = 98304 - skeleton.length;
  const content = '\u0000'.repeat(Math.floor(remaining / 6)) + 'a'.repeat(remaining % 6);
  const input = [{ role: 'system', content }, messages()[1]];
  assert.equal(createRequest(settings(), input, uuid).body.length, 98304);
  assert.throws(() => createRequest(settings(), [{ role: 'system', content: content + 'a' }, messages()[1]], uuid), code('BYTE_LIMIT'));
});

test('parser enforces UTF-8 content/result and replacement boundaries before processing', () => {
  const proposal = text => JSON.stringify({ type: 'tool', tool: 'r7_replace_selection', arguments: { text } });
  assert.equal(parseModelContent(proposal('я'.repeat(4096)), 'EDIT').arguments.text, 'я'.repeat(4096));
  assert.throws(() => parseModelContent(proposal('я'.repeat(4097)), 'EDIT'), code('BYTE_LIMIT'));
  const prefix = '{"type":"final","message":"'; const suffix = '"}';
  const exact = prefix + 'a'.repeat(65536 - prefix.length - suffix.length) + suffix;
  assert.equal(parseModelContent(exact, 'ASK').type, 'final');
  assert.throws(() => parseModelContent(exact + ' ', 'ASK'), code('BYTE_LIMIT'));
  assert.throws(() => parseModelContent(JSON.stringify({ type: 'final', message: '\u0000'.repeat(11000) }), 'ASK'), code('BYTE_LIMIT'));
});
