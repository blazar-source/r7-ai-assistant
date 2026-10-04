import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContextWindow, CONTEXT_DROP_MARKER } from '../../src/agent/context.js';
import { AGENT_CEILINGS } from '../../src/shared/limits.js';
import { utf8ByteLength } from '../../src/shared/bytes.js';

function window(ceilingBytes = 400) {
  const context = createContextWindow({ ceilingBytes });
  context.append({ role: 'system', content: 'rules' });
  context.append({ role: 'user', content: 'исходная задача' });
  return context;
}

// Accounted size of the messages exactly as the window exposes them.
function accounted(messages) {
  return messages.reduce((sum, message) => sum + utf8ByteLength(message.content) + 16, 0);
}

test('keeps everything while it fits and reports nothing dropped', () => {
  const context = window();
  context.append({ role: 'user', content: 'tool_results: small' });
  assert.equal(context.dropped(), 0);
  assert.equal(context.messages().length, 3);
});

test('evicts oldest tool results first, never the system message or the original request', () => {
  const context = window();
  context.append({ role: 'user', content: 'A'.repeat(150) });
  context.append({ role: 'user', content: 'B'.repeat(150) });
  context.append({ role: 'user', content: 'C'.repeat(150) });
  const messages = context.messages();
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1].content, 'исходная задача');
  assert.ok(context.dropped() >= 1);
  assert.ok(messages.some(message => message.content === CONTEXT_DROP_MARKER));
  assert.ok(!messages.some(message => message.content === 'A'.repeat(150)));
  assert.ok(messages.some(message => 'C'.repeat(150).startsWith(message.content) && message.content.length > 0));
});

test('inserts the drop marker once, and cumulative bytes far above the ceiling still fit each request', () => {
  const context = window(300);
  for (let index = 0; index < 40; index += 1) context.append({ role: 'user', content: `step ${index}: ` + 'X'.repeat(100) });
  const messages = context.messages();
  const markerCount = messages.filter(message => message.content === CONTEXT_DROP_MARKER).length;
  assert.equal(markerCount, 1);
  assert.ok(context.dropped() >= 30);
  assert.ok(messages.length <= 4);
});

test('a single oversized newest message is truncated, not silently kept whole', () => {
  const context = window(300);
  context.append({ role: 'user', content: 'Y'.repeat(5000) });
  const messages = context.messages();
  const total = messages.reduce((sum, message) => sum + Buffer.byteLength(message.content, 'utf8'), 0);
  assert.ok(total <= 300);
});

test('the invariant holds after every append of a long randomised sequence and the pins never move', () => {
  const ceilingBytes = 1024;
  const context = window(ceilingBytes);
  let seed = 1234567;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let step = 0; step < 600; step += 1) {
    const roll = random();
    const marker = roll < 0.4;
    const unit = marker ? '"type":"tool_results"' : roll < 0.8 ? 'м' : 'x';
    const length = 1 + Math.floor(random() * 400);
    const content = (marker ? 'q' : 'p') + `#${step} ` + unit.repeat(length);
    context.append({ role: 'user', content });
    const messages = context.messages();
    assert.ok(accounted(messages) <= ceilingBytes, `append ${step} broke the ceiling`);
    assert.equal(messages[0].role, 'system');
    assert.equal(messages[0].content, 'rules');
    assert.equal(messages[1].content, 'исходная задача');
    assert.ok(messages.every(message => typeof message.content === 'string'));
  }
  assert.ok(context.dropped() > 0);
  assert.equal(context.messages().filter(message => message.content === CONTEXT_DROP_MARKER).length, 1);
});

test('a newest message far larger than the whole window is truncated to fit, never kept whole', () => {
  const ceilingBytes = 512;
  const context = window(ceilingBytes);
  context.append({ role: 'user', content: 'H'.repeat(20000) });
  const messages = context.messages();
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1].content, 'исходная задача');
  assert.equal(messages.length, 3);
  assert.ok(accounted(messages) <= ceilingBytes);
  assert.ok(messages[2].content.length > 0);
  assert.ok(utf8ByteLength(messages[2].content) < 20000);
  assert.ok(context.dropped() >= 1);
});

test('terminates promptly under far more appends than the ceiling can hold', () => {
  const context = window(AGENT_CEILINGS.activeContextBytes);
  const content = '{"type":"tool_results","results":[]}'.padEnd(4000, 'q');
  const started = Date.now();
  for (let step = 0; step < 2000; step += 1) context.append({ role: 'user', content });
  const elapsed = Date.now() - started;
  const messages = context.messages();
  assert.ok(elapsed < 20000, `2000 appends took ${elapsed} ms`);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1].content, 'исходная задача');
  assert.ok(accounted(messages) <= AGENT_CEILINGS.activeContextBytes);
  assert.equal(messages.filter(message => message.content === CONTEXT_DROP_MARKER).length, 1);
  assert.ok(context.dropped() > 1000);
});

test('the default ceiling comes from AGENT_CEILINGS and the reads are frozen', () => {
  const context = createContextWindow();
  assert.equal(context.totalBytes(), 0);
  context.append({ role: 'system', content: 's' });
  context.append({ role: 'user', content: 'u' });
  assert.equal(context.totalBytes(), 34);
  const messages = context.messages();
  assert.ok(Object.isFrozen(messages));
  assert.ok(messages.every(message => Object.isFrozen(message)));
  assert.throws(() => messages.push({ role: 'user', content: 'nope' }), TypeError);
  const long = createContextWindow();
  long.append({ role: 'system', content: 'rules' });
  long.append({ role: 'user', content: 'request' });
  long.append({ role: 'user', content: 'x'.repeat(AGENT_CEILINGS.activeContextBytes + 5000) });
  assert.ok(long.totalBytes() <= AGENT_CEILINGS.activeContextBytes);
  assert.throws(() => createContextWindow().append({ role: 'user', content: 7 }), /INVALID_DATA/);
});
