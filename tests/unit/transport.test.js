import test from 'node:test';
import assert from 'node:assert/strict';
import { requestCompletion } from '../../src/ai/transport.js';
import { SafeError } from '../../src/shared/errors.js';
const uuid = '12345678-1234-4234-8234-123456789abc';
const settings = () => ({ endpoint: 'https://example.invalid/prefix/v1/chat/completions', apiKey: 'synthetic-key', model: 'qwen/qwen3.8-max-0902', httpTimeoutSeconds: 30 });
const messages = () => [{ role: 'system', content: 'rules' }, { role: 'user', content: 'question' }];
const code = want => error => error instanceof SafeError && error.code === want && error.message === want && !error.cause && !JSON.stringify(error).includes('synthetic-key');
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function environment() {
  let now = 1000; let id = 0; const pending = new Map(); const delays = [];
  return { clock: { now: () => now }, timers: { schedule: (fn, ms) => { delays.push(ms); pending.set(++id, fn); return id; }, clear: key => pending.delete(key) },
    pending, delays, advance: ms => { now += ms; }, fire: () => { for (const fn of [...pending.values()]) fn(); } };
}
const envelope = content => JSON.stringify({ id: 'unused', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { total_tokens: 1 } });
function response(text = envelope('{"type":"final","message":"ok"}'), status = 200, size = 7) {
  const bytes = new TextEncoder().encode(text); let cursor = 0; let reads = 0; let cancelled = 0; let released = 0;
  const reader = { read: async () => { reads++; if (cursor >= bytes.length) return { done: true }; const value = bytes.slice(cursor, cursor + size); cursor += size; return { done: false, value }; }, cancel: async () => { cancelled++; }, releaseLock: () => { released++; } };
  return { status, ok: status >= 200 && status < 300, body: { getReader: () => reader }, json: () => { throw new Error('must not parse unbounded'); }, text: () => { throw new Error('must not buffer unbounded'); }, reader, stats: () => ({ reads, cancelled, released }) };
}
const options = (env, fetch, extra = {}) => ({ clock: env.clock, timers: env.timers, fetch, ...extra });
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test('one POST uses exact endpoint/body/headers, immutable snapshot and secure fetch controls', async () => {
  const env = environment(); const held = deferred(); const draft = settings(); const input = messages(); let captured; let calls = 0;
  const result = requestCompletion(draft, input, uuid, options(env, (url, init) => { calls++; captured = { url, init }; return held.promise; }));
  await tick(); assert.ok(captured, 'request must dispatch');
  draft.model = 'changed'; input[1].content = 'changed';
  assert.equal(captured.url, 'https://example.invalid/prefix/v1/chat/completions');
  assert.deepEqual(captured.init.headers, { Authorization: 'Bearer synthetic-key', 'Content-Type': 'application/json', 'X-Session-ID': uuid });
  assert.deepEqual(JSON.parse(captured.init.body), { model: 'qwen/qwen3.8-max-0902', messages: messages(), max_tokens: 1024, temperature: 0.2 });
  assert.deepEqual(Object.keys(captured.init).sort(), ['body', 'cache', 'credentials', 'headers', 'method', 'redirect', 'signal']);
  assert.equal(captured.init.method, 'POST'); assert.equal(captured.init.redirect, 'error'); assert.equal(captured.init.credentials, 'omit'); assert.equal(captured.init.cache, 'no-store');
  assert.ok(captured.init.signal instanceof AbortSignal);
  held.resolve(response());
  assert.deepEqual(await result, { type: 'final', message: 'ok' }); assert.equal(calls, 1); assert.equal(env.pending.size, 0);
});

test('transport decodes split UTF-8 bytes and returns only frozen parsed content', async () => {
  const env = environment(); const reply = response(envelope('{"type":"final","message":"я😀"}'), 200, 1);
  const result = await requestCompletion(settings(), messages(), uuid, options(env, async () => reply));
  assert.deepEqual(result, { type: 'final', message: 'я😀' }); assert.ok(Object.isFrozen(result)); assert.equal(reply.stats().released, 1); assert.equal(env.pending.size, 0);
});

test('HTTP classes never read raw error bodies, retry, leak details or substitute models', async () => {
  for (const [status, want] of [[401, 'HTTP_UNAUTHORIZED'], [403, 'HTTP_FORBIDDEN'], [429, 'HTTP_RATE_LIMIT'], [500, 'HTTP_SERVER_ERROR'], [599, 'HTTP_SERVER_ERROR'], [302, 'HTTP_ERROR'], [404, 'HTTP_ERROR']]) {
    const env = environment(); const reply = response('synthetic-key private endpoint raw body', status); let calls = 0;
    await assert.rejects(requestCompletion(settings(), messages(), uuid, options(env, async () => { calls++; return reply; })), code(want));
    assert.equal(calls, 1); assert.equal(reply.stats().reads, 0); assert.equal(env.pending.size, 0);
  }
});

test('fetch and reader failures use combined safe network class; offline never sends', async () => {
  const env = environment();
  await assert.rejects(requestCompletion(settings(), messages(), uuid, options(env, async () => { throw new Error('synthetic-key DNS/CORS/TLS/private endpoint'); })), code('NETWORK_ERROR'));
  await assert.rejects(requestCompletion(settings(), messages(), uuid, options(env, async () => ({ status: 200, body: { getReader: () => ({ read: async () => { throw new Error('raw secret'); }, cancel: async () => {}, releaseLock() {} }) } }))), code('NETWORK_ERROR'));
  let calls = 0;
  await assert.rejects(requestCompletion(settings(), messages(), uuid, options(env, async () => { calls++; return response(); }, { online: false })), code('OFFLINE'));
  assert.equal(calls, 0); assert.equal(env.pending.size, 0);
});

test('missing bounded reader capability fails closed without json/text downgrade', async () => {
  const env = environment();
  for (const reply of [{ status: 200 }, { status: 200, body: {} }, { status: 200, body: { getReader: () => ({}) } }]) {
    await assert.rejects(requestCompletion(settings(), messages(), uuid, options(env, async () => reply)), code('CAPABILITY_UNAVAILABLE'));
    assert.equal(env.pending.size, 0);
  }
});

test('envelope cap is counted before accumulating or parsing, cancels reader, no extra read', async () => {
  const env = environment(); const chunks = [new Uint8Array(131072), new Uint8Array(1)]; let reads = 0; let cancelled = 0; let signal;
  const reply = { status: 200, body: { getReader: () => ({ read: async () => ({ done: false, value: chunks[reads++] }), cancel: async () => { cancelled++; }, releaseLock() {} }) } };
  await assert.rejects(requestCompletion(settings(), messages(), uuid, options(env, async (url, init) => { signal = init.signal; return reply; })), code('BYTE_LIMIT'));
  assert.equal(reads, 2); assert.equal(cancelled, 1); assert.equal(signal.aborted, true); assert.equal(env.pending.size, 0);
});

test('exact envelope cap succeeds and malformed/content/native-only/oversized responses reject', async () => {
  const exact = envelope('{"type":"final","message":"ok"}');
  const env = environment();
  assert.deepEqual(await requestCompletion(settings(), messages(), uuid, options(env, async () => response(exact + ' '.repeat(131072 - exact.length), 200, 131072))), { type: 'final', message: 'ok' });
  for (const bad of ['not JSON', '{"choices":[]}', '{"choices":[{"message":{"content":null,"tool_calls":[{}]}}]}', envelope('plain prose'), '{"choices":[{"message":{"content":{}}}]}', '{"choices":[{"message":{"content":"{}"}},{"message":{"content":"{}"}}]}']) {
    await assert.rejects(requestCompletion(settings(), messages(), uuid, options(env, async () => response(bad))), code('PROTOCOL_ERROR'));
  }
  await assert.rejects(requestCompletion(settings(), messages(), uuid, options(env, async () => response(envelope('я'.repeat(32769)), 200, 131072))), code('BYTE_LIMIT'));
  const oversizedProposal = envelope(JSON.stringify({ type: 'tool', tool: 'r7_replace_selection', arguments: { text: 'x'.repeat(8193) } }));
  await assert.rejects(requestCompletion(settings(), messages(), uuid, options(env, async () => response(oversizedProposal, 200, 131072), { mode: 'EDIT' })), code('BYTE_LIMIT'));
});

test('external cancellation settles ignoring fetch abort, removes listener/timer and ignores late result', async () => {
  const env = environment(); const external = new AbortController(); const held = deferred(); let owned; let adds = 0; let removes = 0;
  const add = external.signal.addEventListener.bind(external.signal); const remove = external.signal.removeEventListener.bind(external.signal);
  external.signal.addEventListener = (...args) => { adds++; return add(...args); };
  external.signal.removeEventListener = (...args) => { removes++; return remove(...args); };
  const pending = requestCompletion(settings(), messages(), uuid, options(env, (url, init) => { owned = init.signal; return held.promise; }, { signal: external.signal }));
  await tick(); external.abort(new Error('raw secret'));
  await assert.rejects(pending, code('CANCELLED')); assert.equal(owned.aborted, true); assert.equal(env.pending.size, 0); assert.equal(adds, removes);
  const late = response(); held.resolve(late); await tick(); assert.equal(late.stats().reads, 0);
});

test('pre-aborted requests do not send or install a timer', async () => {
  const env = environment(); const external = new AbortController(); external.abort(); let calls = 0;
  await assert.rejects(requestCompletion(settings(), messages(), uuid, options(env, async () => { calls++; }, { signal: external.signal })), code('CANCELLED'));
  assert.equal(calls, 0); assert.equal(env.delays.length, 0);
});

test('timeout independently settles ignored fetch; late rejection is consumed and resources released', async () => {
  const env = environment(); const held = deferred(); let owned;
  const pending = requestCompletion(settings(), messages(), uuid, options(env, (url, init) => { owned = init.signal; return held.promise; }));
  await tick(); assert.deepEqual(env.delays, [30000]); env.advance(30000); env.fire();
  await assert.rejects(pending, code('TIMEOUT')); assert.equal(owned.aborted, true); assert.equal(env.pending.size, 0);
  held.reject(new Error('raw secret late rejection')); await tick();
});

test('HTTP deadline is capped by remaining total deadline; expired operations never send', async () => {
  const env = environment(); const held = deferred(); let calls = 0;
  const pending = requestCompletion({ ...settings(), httpTimeoutSeconds: 120 }, messages(), uuid, options(env, () => held.promise, { deadline: 6000 }));
  await tick(); assert.deepEqual(env.delays, [5000]); env.advance(5000); env.fire(); await assert.rejects(pending, code('TIMEOUT'));
  await assert.rejects(requestCompletion(settings(), messages(), uuid, options(env, async () => { calls++; }, { deadline: 5999 })), code('TIMEOUT'));
  assert.equal(calls, 0);
});

test('clock deadline checks reject late fetch resolution even if timer never fires', async () => {
  const env = environment(); const held = deferred(); let cancelled = 0;
  const reply = response(); reply.body.cancel = async () => { cancelled++; };
  const pending = requestCompletion(settings(), messages(), uuid, options(env, () => held.promise));
  await tick(); env.advance(30001); held.resolve(reply);
  await assert.rejects(pending, code('TIMEOUT')); assert.equal(env.pending.size, 0);
  assert.equal(cancelled, 1, 'an arrived body whose deadline expired must be discarded');
});

test('ignored reader abort cannot hang cancellation or timeout; late chunks are ignored', async () => {
  for (const cancellation of [true, false]) {
    const env = environment(); const held = deferred(); const external = new AbortController(); let reads = 0; let cancelled = 0;
    const reply = { status: 200, body: { getReader: () => ({ read: () => { reads++; return held.promise; }, cancel: async () => { cancelled++; }, releaseLock() {} }) } };
    const pending = requestCompletion(settings(), messages(), uuid, options(env, async () => reply, { signal: external.signal }));
    await tick(); assert.equal(reads, 1);
    if (cancellation) external.abort(); else { env.advance(30000); env.fire(); }
    await assert.rejects(pending, code(cancellation ? 'CANCELLED' : 'TIMEOUT'));
    assert.equal(cancelled, 1); assert.equal(env.pending.size, 0);
    held.resolve({ done: false, value: new Uint8Array(200000) }); await tick(); assert.equal(reads, 1);
  }
});

test('EDIT returns only bounded proposal; ASK rejects the same proposal', async () => {
  const env = environment();
  const content = '{"type":"tool","tool":"r7_replace_selection","arguments":{"text":"новый"}}';
  const fetch = async () => response(envelope(content));
  assert.deepEqual(await requestCompletion(settings(), messages(), uuid, options(env, fetch, { mode: 'EDIT' })), { type: 'tool', tool: 'r7_replace_selection', arguments: { text: 'новый' } });
  await assert.rejects(requestCompletion(settings(), messages(), uuid, options(env, fetch)), code('PROTOCOL_ERROR'));
});

test('invalid request/mode/deadline cannot invoke Fetch or retain resources', async () => {
  const env = environment(); let calls = 0;
  const fetch = async () => { calls++; return response(); };
  for (const extra of [{ mode: 'other' }, { deadline: NaN }, { deadline: Infinity }]) {
    await assert.rejects(requestCompletion(settings(), messages(), uuid, options(env, fetch, extra)), code('INVALID_DATA'));
  }
  await assert.rejects(requestCompletion({ ...settings(), httpTimeoutSeconds: 121 }, messages(), uuid, options(env, fetch)), code('INVALID_SETTINGS'));
  assert.equal(calls, 0); assert.equal(env.pending.size, 0);
});

test('maximum HTTP setting remains 120 seconds even when caller attempts longer deadline', async () => {
  const env = environment(); const held = deferred();
  const pending = requestCompletion({ ...settings(), httpTimeoutSeconds: 120 }, messages(), uuid, options(env, () => held.promise, { deadline: 999999 }));
  await tick(); assert.deepEqual(env.delays, [120000]); env.advance(120000); env.fire();
  await assert.rejects(pending, code('TIMEOUT')); assert.equal(env.pending.size, 0);
});

test('clock checks during reading enforce deadline without scheduling dependence', async () => {
  const env = environment(); const held = deferred();
  const reply = { status: 200, body: { getReader: () => ({ read: () => held.promise, cancel: async () => {}, releaseLock() {} }) } };
  const pending = requestCompletion(settings(), messages(), uuid, options(env, async () => reply));
  await tick(); env.advance(150001); held.resolve({ done: true });
  await assert.rejects(pending, code('TIMEOUT')); assert.equal(env.pending.size, 0);
});

test('raw mode returns the bounded model content itself, never a parsed proposal', async () => {
  const env = environment();
  const prose = 'не JSON, просто текст';
  const result = await requestCompletion(settings(), messages(), uuid, options(env, async () => response(envelope(prose)), { parse: 'raw' }));
  assert.deepEqual(result, { content: prose });
  assert.ok(Object.isFrozen(result));
  // The very same content is a protocol error on the default, parsing path.
  await assert.rejects(requestCompletion(settings(), messages(), uuid, options(env, async () => response(envelope(prose)))), code('PROTOCOL_ERROR'));
});

test('raw mode keeps the strict-bank request shape and the model-content ceiling', async () => {
  const env = environment(); let captured; let calls = 0;
  const content = '{"type":"tool_calls","calls":[{"tool":"read_selection","arguments":{}}]}';
  const result = await requestCompletion(settings(), messages(), uuid, options(env, async (url, init) => { calls++; captured = { url, init }; return response(envelope(content)); }, { parse: 'raw' }));
  assert.deepEqual(result, { content });
  assert.equal(calls, 1);
  assert.equal(captured.url, 'https://example.invalid/prefix/v1/chat/completions');
  assert.deepEqual(Object.keys(captured.init).sort(), ['body', 'cache', 'credentials', 'headers', 'method', 'redirect', 'signal']);
  assert.deepEqual(JSON.parse(captured.init.body), { model: 'qwen/qwen3.8-max-0902', messages: messages(), max_tokens: 1024, temperature: 0.2 });
  await assert.rejects(requestCompletion(settings(), messages(), uuid, options(env, async () => response(envelope('я'.repeat(32769)), 200, 131072), { parse: 'raw' })), code('BYTE_LIMIT'));
});

test('raw mode releases the reader and its timer after one bounded read', async () => {
  const env = environment();
  const reply = response(envelope('{"type":"final","message":"ok"}'));
  const result = await requestCompletion(settings(), messages(), uuid, options(env, async () => reply, { parse: 'raw' }));
  assert.deepEqual(result, { content: '{"type":"final","message":"ok"}' });
  assert.equal(reply.stats().released, 1);
  assert.equal(env.pending.size, 0);
});

test('raw mode rejects a pre-aborted signal before any request', async () => {
  const env = environment(); const external = new AbortController(); external.abort(); let calls = 0;
  await assert.rejects(requestCompletion(settings(), messages(), uuid, options(env, async () => { calls++; return response(); }, { parse: 'raw', signal: external.signal })), code('CANCELLED'));
  assert.equal(calls, 0);
  assert.equal(env.delays.length, 0);
});
