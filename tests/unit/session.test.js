import test from 'node:test';
import assert from 'node:assert/strict';
import { secureUUID, buildMessages, boundDisplayHistory, createChatSession, appendChatPair, newChat, createConnectionSession } from '../../src/shared/session.js';
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
