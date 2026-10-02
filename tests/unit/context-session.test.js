import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContextMessages, snapshotRequestMessages } from '../../src/shared/session.js';
import { createRequest } from '../../src/ai/protocol.js';

// Removing separate untrusted context or weakening either independent cap breaks these tests.
test('selection and current user each retain 8192 bytes in separate user messages', () => {
  const messages = buildContextMessages('rules', 'u'.repeat(8192), 's'.repeat(8192));
  assert.equal(messages.length, 3);
  assert.deepEqual(messages.map(item => item.role), ['system', 'user', 'user']);
  assert.equal(messages[1].content.length, 8192);
  assert.equal(messages[2].content.length, 8192);
  assert.ok(Object.isFrozen(messages) && messages.every(Object.isFrozen));
  assert.equal(snapshotRequestMessages(messages).length, 3);
  const request = createRequest({ endpoint: 'https://example.invalid/v1/chat/completions', apiKey: 'synthetic' }, messages, '00000000-0000-4000-8000-000000000001');
  assert.equal(JSON.parse(request.body).messages.length, 3);
});
test('context builder rejects instead of truncating either UTF8 boundary', () => {
  assert.throws(() => buildContextMessages('rules', 'я'.repeat(4096) + 'x', 'ok'), { code: 'BYTE_LIMIT' });
  assert.throws(() => buildContextMessages('rules', 'ok', 'я'.repeat(4096) + 'x'), { code: 'BYTE_LIMIT' });
});
test('mandatory context retained and history culled only in complete pairs', () => {
  const history = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: String(i) }));
  const messages = buildContextMessages('rules', 'current', 'selection', history);
  assert.equal(messages.length, 31);
  assert.deepEqual(messages.slice(0, 3).map(item => item.content), ['rules', '12', '13']);
  assert.deepEqual(messages.slice(-2).map(item => item.content), ['selection', 'current']);
  assert.throws(() => buildContextMessages('x'.repeat(65536), 'current', 'selection'), { code: 'BYTE_LIMIT' });
});
