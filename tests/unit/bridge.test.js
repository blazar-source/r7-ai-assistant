import test from 'node:test';
import assert from 'node:assert/strict';
import { createR7Bridge } from '../../src/plugin/bridge.js';

function runContext(body) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'Api'); let identity = false;
  globalThis.Api = { GetDocumentId() { identity = true; return 'bounded-id'; }, ReplaceTextSmart() {}, GetDocument() { return { GetRangeBySelect() {}, IsTrackRevisions() { return false; } }; } };
  try { return { value: body(), identity }; }
  finally { if (previous) Object.defineProperty(globalThis, 'Api', previous); else delete globalThis.Api; }
}
function contextCommand(body, _close, _recalculate, callback) { callback(runContext(body).value); }
function rig(editorType = 'word', pluginOverrides = {}) {
  let now = 0;
  const scheduled = new Map();
  const calls = [];
  const plugin = {
    info: { editorType },
    executeMethod(name, params, callback) { calls.push({ name, params, callback }); return false; },
    callCommand(body, close, recalculate, callback) {
      const result = runContext(body);
      if (result.identity) callback(result.value);
      else calls.push({ body, close, recalculate, callback });
    },
    ...pluginOverrides
  };
  const bridge = createR7Bridge(plugin, {
    editorType, clock: { now: () => now },
    timers: { schedule(fn, ms) { const id = {}; scheduled.set(id, { fn, at: now + ms }); return id; }, clear(id) { scheduled.delete(id); } }
  });
  return { bridge, plugin, calls, scheduled, advance(ms) {
    now += ms;
    for (const [id, timer] of [...scheduled]) if (timer.at <= now) { scheduled.delete(id); timer.fn(); }
  }, setNow(value) { now = value; } };
}
const code = expected => error => error?.name === 'SafeError' && error.code === expected && error.message === expected && !error.cause;
const probe = [true, true, true, true, true, true];
const namedPresence = { api: true, getDocument: true, getDocumentId: true, replaceTextSmart: true, getRangeBySelect: true, isTrackRevisions: true };

test('read completion belongs to callback, not executeMethod false/queued status', async () => {
  const r = rig(); let settled = false;
  const promise = r.bridge.readSelection().then(value => { settled = true; return value; });
  await Promise.resolve(); assert.equal(settled, false);
  assert.equal(r.calls.length, 1); assert.equal(r.calls[0].name, 'GetSelectedText');
  assert.deepEqual(r.calls[0].params, []); assert.ok(Object.isFrozen(r.calls[0].params));
  r.calls[0].callback('выделено');
  const result = await promise;
  assert.equal(result.text, 'выделено'); assert.equal(result.editorType, 'word'); assert.equal(result.eligible, true);
  assert.ok(Object.isFrozen(result.target)); assert.deepEqual(result.target, {});
  assert.equal(r.bridge.getState().busy, false); assert.equal(r.scheduled.size, 0);
});

test('true and undefined executeMethod return values also never complete reads', async () => {
  for (const status of [true, undefined]) {
    let callback;
    const r = rig('word', { executeMethod(_name, _params, cb) { callback = cb; return status; } });
    let settled = false;
    const promise = r.bridge.readSelection().then(value => { settled = true; return value; });
    await Promise.resolve(); assert.equal(settled, false);
    callback('text'); assert.equal((await promise).text, 'text');
  }
});

test('one slot blocks reads and probes, never adds SDK queued work', async () => {
  const r = rig(); const first = r.bridge.readSelection();
  await assert.rejects(r.bridge.readSelection(), code('EDITOR_BUSY'));
  await assert.rejects(r.bridge.probeCapabilities(), code('EDITOR_BUSY'));
  assert.equal(r.calls.length, 1); r.calls[0].callback('a'); await first;
});

test('missing callback hits 5000 deadline and stays uncertain until matching late callback', async () => {
  const r = rig(); const first = r.bridge.readSelection();
  const rejection = assert.rejects(first, code('TIMEOUT'));
  r.advance(4999); assert.equal(r.bridge.getState().uncertain, false);
  r.advance(1); await rejection;
  assert.deepEqual(r.bridge.getState(), { editorType: 'word', busy: true, uncertain: true, disposed: false, writePending: false });
  await assert.rejects(r.bridge.readSelection(), code('EDITOR_BUSY'));
  r.calls[0].callback('late'); assert.equal(r.bridge.getState().busy, false);
  const second = r.bridge.readSelection(); r.calls[1].callback('fresh'); assert.equal((await second).text, 'fresh');
});

test('late callback checks clock even before timer delivery', async () => {
  const r = rig(); const promise = r.bridge.readSelection();
  const rejection = assert.rejects(promise, code('TIMEOUT'));
  r.setNow(5000); r.calls[0].callback('late'); await rejection;
  assert.equal(r.bridge.getState().busy, false); assert.equal(r.scheduled.size, 0);
});

test('an in-flight insert is a pending mutation the UI write lock can see', async () => {
  const r = rig();
  const pending = r.bridge.insertParagraph({ text: 'Абзац' });
  // The identity leg settles synchronously in this rig, so the insert dispatch is reached at the next
  // event-loop checkpoint: a fact about the bridge, not a guessed tick count.
  await new Promise(resolve => setImmediate(resolve));
  const insert = r.calls.find(call => call.name === 'PasteText');
  assert.ok(insert, 'the insert was dispatched');
  assert.equal(r.bridge.getState().writePending, true, 'a dispatched insert is a pending mutation');
  // The panel lock reads exactly this state (controller.writeLocked()), so a second mutation must be
  // refused for as long as it holds.
  assert.deepEqual(await r.bridge.insertParagraph({ text: 'Второй' }), { ok: false, code: 'EDITOR_BUSY' });
  insert.callback(true);
  assert.deepEqual(await pending, { ok: true, data: { sent: true } });
  assert.equal(r.bridge.getState().writePending, false, 'the lock is released when the insert settles');
  const next = r.bridge.insertParagraph({ text: 'Третий' });
  await new Promise(resolve => setImmediate(resolve));
  const nextInsert = r.calls.find(call => call.name === 'PasteText' && call !== insert);
  assert.ok(nextInsert, 'the released slot accepts the next mutation');
  nextInsert.callback(true);
  assert.deepEqual(await next, { ok: true, data: { sent: true } });

  // A read is not a mutation: it never sets the write lock even while it owns the slot.
  const readRig = rig();
  const read = readRig.bridge.readSelection();
  assert.equal(readRig.bridge.getState().busy, true);
  assert.equal(readRig.bridge.getState().writePending, false, 'a read is not a pending mutation');
  readRig.calls[0].callback('текст');
  await read;

  // A dispatched insert whose acknowledgement never arrives stays pending until its own callback:
  // the timeout is uncertain-until-callback, never a release of the lock.
  const heldRig = rig();
  const held = heldRig.bridge.insertParagraph({ text: 'Абзац' });
  await new Promise(resolve => setImmediate(resolve));
  const heldInsert = heldRig.calls.find(call => call.name === 'PasteText');
  assert.equal(heldRig.bridge.getState().writePending, true);
  heldRig.advance(5000);
  assert.deepEqual(await held, { ok: false, code: 'APPLY_UNCERTAIN' });
  assert.equal(heldRig.bridge.getState().writePending, true, 'uncertain-until-callback stays pending');
  assert.equal(heldRig.bridge.getState().uncertain, true);
  heldInsert.callback(true);
  assert.equal(heldRig.bridge.getState().writePending, false, 'the late callback releases the lock');
});

test('duplicate old callback cannot release or complete a new slot', async () => {
  const r = rig(); const first = r.bridge.readSelection(); const old = r.calls[0].callback;
  old('first'); await first;
  let settled = false; const second = r.bridge.readSelection().then(value => { settled = true; return value; });
  old('duplicate'); await Promise.resolve(); assert.equal(settled, false); assert.equal(r.bridge.getState().busy, true);
  r.calls[1].callback('second'); assert.equal((await second).text, 'second');
});

test('abort invalidates caller but queued SDK work owns slot until callback', async () => {
  const r = rig(); const controller = new AbortController();
  const first = r.bridge.readSelection({ signal: controller.signal });
  const rejection = assert.rejects(first, code('CANCELLED')); controller.abort(); await rejection;
  assert.equal(r.bridge.getState().uncertain, true); assert.equal(r.scheduled.size, 0);
  await assert.rejects(r.bridge.readSelection(), code('EDITOR_BUSY'));
  r.calls[0].callback('discarded'); assert.equal(r.bridge.getState().busy, false);
  const second = r.bridge.readSelection(); r.calls[0].callback('duplicate'); assert.equal(r.bridge.getState().busy, true);
  r.calls[1].callback('new'); assert.equal((await second).text, 'new');
});

test('pre-aborted signal never dispatches; lifecycle invalidation has same slot rule', async () => {
  const r = rig(); const controller = new AbortController(); controller.abort();
  await assert.rejects(r.bridge.readSelection({ signal: controller.signal }), code('CANCELLED')); assert.equal(r.calls.length, 0);
  const first = r.bridge.readSelection(); const rejection = assert.rejects(first, code('CANCELLED'));
  r.bridge.invalidate(); await rejection; await assert.rejects(r.bridge.probeCapabilities(), code('EDITOR_BUSY'));
  r.calls[0].callback('discarded'); assert.equal(r.bridge.getState().busy, false);
});

test('dispose never unlocks queued work and permanently disables this instance', async () => {
  const r = rig(); const first = r.bridge.readSelection(); const rejection = assert.rejects(first, code('CANCELLED'));
  r.bridge.dispose(); await rejection;
  assert.equal(r.bridge.getState().busy, true); assert.equal(r.bridge.getState().disposed, true);
  await assert.rejects(r.bridge.readSelection(), code('CAPABILITY_UNAVAILABLE'));
  r.calls[0].callback('late'); assert.equal(r.bridge.getState().busy, false);
  await assert.rejects(r.bridge.readSelection(), code('CAPABILITY_UNAVAILABLE'));
});

test('SDK throw is static safe error, conservatively uncertain until callback', async () => {
  let callback;
  const r = rig('word', { executeMethod(_name, _params, cb) { callback = cb; throw new Error('sensitive document/key/url'); } });
  await assert.rejects(r.bridge.readSelection(), code('EDITOR_ERROR'));
  assert.equal(r.bridge.getState().uncertain, true);
  await assert.rejects(r.bridge.readSelection(), code('EDITOR_BUSY'));
  callback('late'); assert.equal(r.bridge.getState().busy, false);
});

test('synchronous callback works and SDK throw after it cannot overturn completion', async () => {
  const r = rig('word', { executeMethod(_name, _params, cb) { cb('sync'); throw new Error('private'); } });
  assert.equal((await r.bridge.readSelection()).text, 'sync'); assert.equal(r.bridge.getState().busy, false);
});

test('selection is typed UTF-8 bounded, immutable, never truncated or eligibility proof', async () => {
  const r = rig();
  for (const [value, expected] of [['я'.repeat(4096), null], ['я'.repeat(4096) + 'a', 'BYTE_LIMIT'], ['x'.repeat(65537), 'BYTE_LIMIT'], [null, 'INVALID_DATA'], [{ text: 'a' }, 'INVALID_DATA'], ['', null]]) {
    const promise = r.bridge.readSelection(); const check = expected ? assert.rejects(promise, code(expected)) : promise;
    r.calls.at(-1).callback(value);
    if (expected) await check;
    else { const result = await check; assert.equal(result.text, value); assert.ok(Object.isFrozen(result)); assert.equal(result.eligible, value !== ''); assert.equal(result.target === null, value === ''); }
    assert.equal(r.bridge.getState().busy, false);
  }
});

test('missing adapters and unknown editor never dispatch', async () => {
  for (const editorType of ['cell', 'slide', 'unknown', undefined]) {
    const r = rig(editorType === undefined ? null : editorType);
    await assert.rejects(r.bridge.readSelection(), code('CAPABILITY_UNAVAILABLE'));
    const capabilities = await r.bridge.probeCapabilities();
    assert.equal(capabilities.selectionRead.available, false); assert.equal(capabilities.mutation.available, false); assert.equal(r.calls.length, 0);
  }
  const r = rig('word', { executeMethod: null, callCommand: null });
  await assert.rejects(r.bridge.readSelection(), code('CAPABILITY_UNAVAILABLE'));
  const capabilities = await r.bridge.probeCapabilities(); assert.equal(capabilities.adapter.executeMethod, false); assert.equal(capabilities.methodPresence, null);
});

test('capability callback exposes presence, never promotes host/mock positives to runtime proof', async () => {
  const r = rig(); let settled = false;
  const promise = r.bridge.probeCapabilities().then(value => { settled = true; return value; });
  await Promise.resolve(); assert.equal(settled, false);
  assert.equal(r.calls.length, 1); assert.equal(r.calls[0].close, false); assert.equal(r.calls[0].recalculate, false);
  r.calls[0].callback(probe); const result = await promise;
  assert.deepEqual(result.methodPresence, namedPresence); assert.ok(Object.isFrozen(result.methodPresence));
  assert.equal(result.runtimeVerified, false); assert.equal(result.selectionRead.runtimeVerified, false);
  assert.equal(result.mutation.available, false); assert.equal(result.mutation.reason, 'EXPLICIT_OWNED_PREVIEW_REQUIRED');
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.mutation));
});

test('capability tuple maps every distinct boolean pattern to frozen named presence without mutating input', async () => {
  const r = rig();
  for (let bits = 0; bits < 64; bits++) {
    const api = !!(bits & 1), doc = !!(bits & 2), id = !!(bits & 4), replace = !!(bits & 8), range = !!(bits & 16), revisions = !!(bits & 32);
    const input = [api, doc, id, replace, range, revisions];
    if (bits % 2) Object.freeze(input);
    const before = Object.getOwnPropertyDescriptors(input);
    const promise = r.bridge.probeCapabilities(); r.calls.at(-1).callback(input);
    const result = await promise;
    assert.deepEqual(result.methodPresence, { api, getDocument: doc, getDocumentId: id, replaceTextSmart: replace, getRangeBySelect: range, isTrackRevisions: revisions });
    assert.ok(Object.isFrozen(result.methodPresence)); assert.ok(Object.isFrozen(result));
    assert.equal(result.runtimeVerified, false); assert.equal(result.mutation.available, false);
    assert.deepEqual(Object.getOwnPropertyDescriptors(input), before);
  }
});

test('capability callback rejects every nonclosed tuple without executing accessors or serialization', async () => {
  const r = rig(); let reads = 0;
  const getter = () => { reads++; throw Error('private'); };
  const extra = (key, enumerable, value = true, input = [...probe]) => Object.defineProperty(input, key, { value, enumerable });
  const accessor = [...probe]; Object.defineProperty(accessor, '0', { get: getter, enumerable: true });
  const setter = [...probe]; Object.defineProperty(setter, '1', { set: getter, enumerable: true });
  const hiddenIndex = [...probe]; Object.defineProperty(hiddenIndex, '2', { enumerable: false });
  const hole = [...probe]; delete hole[3];
  const inherited = [...probe]; delete inherited[0]; Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), { 0: true }));
  const exotic = [...probe]; Object.setPrototypeOf(exotic, Object.create(Array.prototype, { secret: { get: getter } }));
  const nullPrototype = [...probe]; Object.setPrototypeOf(nullPrototype, null);
  // Real Array length cannot be an accessor; an array-shaped object must be
  // rejected before its throwing length/prototype getters are read.
  const fake = Object.create(Array.prototype, { length: { get: getter }, 0: { value: true, enumerable: true }, ['__proto__']: { get: getter } });
  const cases = [namedPresence, { error: 'CAPABILITY_UNAVAILABLE' }, undefined, null, 'true', 6, true, new Uint8Array(6), [], [true],
    [false, false, false, false, false], [...probe, false], [1, true, true, true, true, true], ['api', 'getDocument', 'getDocumentId', 'replaceTextSmart', 'getRangeBySelect', 'isTrackRevisions'],
    hole, accessor, setter, hiddenIndex, inherited, exotic, nullPrototype, fake, new Array(4294967295),
    extra(Symbol('extra'), false), extra('hidden', false), extra('visible', true), extra('toJSON', false, getter),
    ['private'], ['CAPABILITY_UNAVAILABLE', false], extra('extra', true, true, ['CAPABILITY_UNAVAILABLE']), extra(Symbol('error'), false, true, ['CAPABILITY_UNAVAILABLE'])];
  const errorAccessor = ['CAPABILITY_UNAVAILABLE']; Object.defineProperty(errorAccessor, '0', { get: getter, enumerable: true }); cases.push(errorAccessor);
  const errorHidden = ['CAPABILITY_UNAVAILABLE']; Object.defineProperty(errorHidden, '0', { enumerable: false }); cases.push(errorHidden);
  const errorHole = new Array(1); const errorExotic = ['CAPABILITY_UNAVAILABLE']; Object.setPrototypeOf(errorExotic, Object.create(Array.prototype));
  const errorNullPrototype = ['CAPABILITY_UNAVAILABLE']; Object.setPrototypeOf(errorNullPrototype, null);
  const errorSetter = ['CAPABILITY_UNAVAILABLE']; Object.defineProperty(errorSetter, '0', { set: getter, enumerable: true });
  cases.push(errorHole, errorExotic, errorNullPrototype, errorSetter, extra('hidden', false, true, ['CAPABILITY_UNAVAILABLE']), extra('toJSON', false, getter, ['CAPABILITY_UNAVAILABLE']));
  for (let index = 0; index < 6; index++) for (const wrong of [undefined, null, 0, 1, 'true', {}, [], () => true]) {
    const input = [...probe]; input[index] = wrong; cases.push(input);
  }
  for (const value of cases) {
    const before = value && typeof value === 'object' ? Object.getOwnPropertyDescriptors(value) : null;
    const promise = r.bridge.probeCapabilities(); const rejection = assert.rejects(promise, code('INVALID_DATA'));
    r.calls.at(-1).callback(value); await rejection;
    assert.equal(r.bridge.getState().busy, false);
    if (before) assert.deepEqual(Object.getOwnPropertyDescriptors(value), before);
  }
  assert.equal(reads, 0);
});

test('missing tuple index never consults a polluted descriptor-object prototype', async () => {
  const r = rig(); const input = [...probe]; delete input[3]; input.extra = true;
  const promise = r.bridge.probeCapabilities(); const rejection = assert.rejects(promise, code('INVALID_DATA'));
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, '3'); let reads = 0;
  Object.defineProperty(Object.prototype, '3', { configurable: true, get() { reads++; throw Error('private'); } });
  try { r.calls[0].callback(input); }
  finally { if (previous) Object.defineProperty(Object.prototype, '3', previous); else delete Object.prototype[3]; }
  await rejection; assert.equal(reads, 0);
});

test('only closed error tuple yields static capability unavailable without input mutation', async () => {
  const r = rig(); const input = Object.freeze(['CAPABILITY_UNAVAILABLE']); const before = Object.getOwnPropertyDescriptors(input);
  const promise = r.bridge.probeCapabilities(); const rejection = assert.rejects(promise, code('CAPABILITY_UNAVAILABLE'));
  r.calls[0].callback(input); await rejection;
  assert.deepEqual(Object.getOwnPropertyDescriptors(input), before); assert.equal(r.bridge.getState().busy, false);
});

test('clock failure before dispatch is content-free and leaves no occupied slot', async () => {
  let calls = 0;
  const bridge = createR7Bridge({ info: { editorType: 'word' }, callCommand: contextCommand, executeMethod() { calls += 1; } }, {
    editorType: 'word', clock: { now() { throw new Error('private'); } }
  });
  await assert.rejects(bridge.readSelection(), code('EDITOR_ERROR'));
  assert.equal(calls, 0); assert.equal(bridge.getState().busy, false);
});

test('cleanup exception cannot strand callback completion or leak its contents', async () => {
  let callback;
  const bridge = createR7Bridge({ info: { editorType: 'word' }, callCommand: contextCommand, executeMethod(_name, _params, cb) { callback = cb; } }, {
    editorType: 'word', clock: { now: () => 0 },
    timers: { schedule() { return 1; }, clear() { throw new Error('private'); } }
  });
  const promise = bridge.readSelection();
  callback('bounded');
  // Drain the microtask queue at the next event-loop checkpoint, not an assumed
  // number of async-return adoption microtasks. A stranded promise loses the race.
  const result = await Promise.race([promise, new Promise(resolve => setImmediate(() => resolve(null)))]);
  assert.equal(result?.text, 'bounded');
  assert.equal(bridge.getState().busy, false);
});

test('timer setup failure prevents SDK dispatch and exposes static failure only', async () => {
  let calls = 0;
  const bridge = createR7Bridge({ info: { editorType: 'word' }, callCommand: contextCommand, executeMethod() { calls += 1; } }, {
    editorType: 'word', clock: { now: () => 0 },
    timers: { schedule() { throw new Error('private'); }, clear() {} }
  });
  await assert.rejects(bridge.readSelection(), code('EDITOR_ERROR'));
  assert.equal(calls, 0); assert.equal(bridge.getState().busy, false);
});

test('recreating bridge cannot bypass a disposed but unresolved SDK owner', async () => {
  const r = rig(); const promise = r.bridge.readSelection();
  const rejection = assert.rejects(promise, code('CANCELLED')); r.bridge.dispose(); await rejection;
  assert.throws(() => createR7Bridge(r.plugin, { editorType: 'word' }), code('EDITOR_BUSY'));
  assert.equal(r.calls.length, 1); r.calls[0].callback('discarded');
  // New object only after actual platform reinitialization; old SDK identity remains owned.
  assert.throws(() => createR7Bridge(r.plugin, { editorType: 'word' }), code('EDITOR_BUSY'));
});

test('probe deadline keeps shared slot uncertain and discarded callback never becomes capability evidence', async () => {
  const r = rig(); const promise = r.bridge.probeCapabilities(); const rejection = assert.rejects(promise, code('TIMEOUT'));
  r.advance(5000); await rejection; await assert.rejects(r.bridge.readSelection(), code('EDITOR_BUSY'));
  r.calls[0].callback(probe); assert.equal(r.bridge.getState().busy, false);
  const controller = new AbortController(); const read = r.bridge.readSelection({ signal: controller.signal });
  r.calls[1].callback('first'); await read;
  const next = r.bridge.readSelection(); controller.abort(); r.calls[0].callback(probe);
  assert.equal(r.bridge.getState().busy, true); r.calls[2].callback('next'); assert.equal((await next).text, 'next');
});

test('Apply rejects caller-forged serializable target certificates without any SDK work', async () => {
  const r = rig();
  for (const target of [null, { originalText: 'same', locator: 'first' }, { originalText: 'same', locator: 'second' }, { documentId: 'changed', revision: 1 }, { eligible: true, domain: 'plain', json: { content: ['same'] } }, { domain: 'field' }, { domain: 'unknown' }]) {
    await assert.rejects(r.bridge.applySelection({ target, replacement: 'changed' }), code('SELECTION_CHANGED'));
  }
  assert.equal(r.calls.length, 0); assert.equal(r.bridge.getState().busy, false);
});

// --- Sprint 3: an insert acknowledgement that carries NO value -----------------------------------
// Proven natively on R7-Office 2026.3.1 (Windows): `PasteText` APPLIES the insert and then calls its
// callback with `undefined`. A callback value that carries nothing is neither evidence of success nor
// evidence of failure, so it is never an automatic success and never an ordinary known error. The
// ticket stays OWNED (still a pending mutation, still write-locked) and an ordered CONFIRMATION
// LADDER of independent public reads decides; the effect counts as verified only when one leg
// reproduces the dispatched payload through that leg's own exact rule.
//
// The ladder exists because the first read primitive cannot confirm on the measured build:
// `GetSelectedText` answers `""` immediately and after +400 ms — the paste does NOT leave the
// inserted text selected there — while `GetCurrentSentence` answers with exactly the inserted
// sentence. Leg 1 is kept first because it is the primitive that can confirm on another build; leg 2
// is the primitive the live build actually answers. Both are byte-exact equality reads with ONE
// documented normalization on leg 2 (a single trailing newline removed). A third leg over the
// whole-document `GetFileHTML` is deliberately ABSENT: `includes(payload)` in a whole-document export
// is satisfied by a payload that was already in the document, so it would claim a verified effect
// that never happened — a false success is worse than the false failure this fix removes.
const VERIFIED = { ok: true, data: { sent: true, effectVerified: true } };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function dispatchInsert(r, request = { text: 'Абзац' }) {
  const pending = r.bridge.insertParagraph(request);
  await tick();
  const insert = r.calls.find(call => call.name === 'PasteText');
  assert.ok(insert, 'the insert was dispatched');
  return { pending, insert };
}
const reads = r => r.calls.filter(call => call.name === 'GetSelectedText');
const inserts = r => r.calls.filter(call => call.name === 'PasteText');
const sentences = r => r.calls.filter(call => call.name === 'GetCurrentSentence');
const confirmationOrder = r => r.calls
  .filter(call => call.name === 'GetSelectedText' || call.name === 'GetCurrentSentence').map(call => call.name);
// Drive ladder legs 1 and 2 for the cases where leg 1 is refused: deliver the void acknowledgement,
// answer the selection leg, then answer the sentence leg the refusal must hand the ticket to. Every
// assertion inside the helper is part of the ladder contract, so a single-leg implementation fails
// here instead of hanging on an unanswered promise.
async function runLadder(r, { request = { text: 'Абзац' }, selection, sentence } = {}) {
  const { pending, insert } = await dispatchInsert(r, request);
  insert.callback(undefined);
  assert.equal(reads(r).length, 1, 'the ladder always starts at the selection leg');
  reads(r)[0].callback(selection);
  assert.equal(sentences(r).length, 1, 'a refused selection leg hands the ticket to the sentence leg');
  sentences(r)[0].callback(sentence);
  return pending;
}

test('a void insert acknowledgement is confirmed by the first ladder read when it reproduces the payload', async () => {
  const r = rig();
  const { pending, insert } = await dispatchInsert(r);
  assert.deepEqual(insert.params, ['Абзац'], 'the dispatched payload is the one the read must reproduce');
  assert.equal(r.bridge.getState().writePending, true);
  insert.callback(undefined); // the live 2026.3.1 callback value: no value at all
  assert.equal(reads(r).length, 1, 'the void acknowledgement starts exactly one confirmation read');
  assert.deepEqual(reads(r)[0].params, []);
  assert.ok(Object.isFrozen(reads(r)[0].params));
  assert.equal(r.bridge.getState().writePending, true, 'the write lock spans the whole confirmation window');
  reads(r)[0].callback('Абзац');
  assert.deepEqual(await pending, VERIFIED);
  assert.equal(r.bridge.getState().writePending, false, 'a confirmed effect settles the mutation');
  assert.equal(inserts(r).length, 1, 'the mutation is never retried');
  assert.equal(reads(r).length, 1, 'one dispatch, one selection read');
  assert.deepEqual(sentences(r), [], 'a confirmed first leg never dispatches the next leg');
  assert.deepEqual(confirmationOrder(r), ['GetSelectedText'], 'the ladder stops at its first confirming leg');
});

test('a boolean acknowledgement keeps the existing unverified envelope and reads nothing', async () => {
  // Requirement 8: the boolean path is unchanged and stays "sent, effect unverified" — its meaning on
  // the target Astra 2026.1.2.1942 build must be re-checked natively, so no marker is invented here.
  for (const value of [true, false]) {
    const r = rig();
    const { pending, insert } = await dispatchInsert(r);
    insert.callback(value);
    assert.deepEqual(await pending, { ok: true, data: { sent: value } });
    assert.deepEqual(reads(r), [], 'a boolean acknowledgement needs no confirmation read');
    assert.equal(r.bridge.getState().writePending, false);
  }
});

test('a void acknowledgement no leg can reproduce is the uncertain class, never a known error', async () => {
  // A different string and the empty string are both "not confirmed" at BOTH legs: the uncertain
  // class, one mutation, no retry, and the write lock is not released over an unknown outcome.
  for (const returned of ['Другой текст', '']) {
    const r = rig();
    const pending = await runLadder(r, { selection: returned, sentence: returned });
    const result = await pending;
    assert.deepEqual(result, { ok: false, code: 'APPLY_UNCERTAIN' }, JSON.stringify(returned));
    assert.notEqual(result.code, 'INVALID_DATA', 'a void acknowledgement is never a plain known error');
    assert.equal(inserts(r).length, 1, 'the mutation is never retried');
    assert.equal(reads(r).length, 1, 'exactly one selection read');
    assert.equal(sentences(r).length, 1, 'exactly one sentence read');
    assert.deepEqual(confirmationOrder(r), ['GetSelectedText', 'GetCurrentSentence'], 'the ladder is ordered');
    assert.equal(r.bridge.getState().writePending, true, 'an unconfirmed mutation stays pending');
    assert.equal(r.bridge.getState().uncertain, true);
    assert.deepEqual(await r.bridge.insertParagraph({ text: 'Второй' }), { ok: false, code: 'EDITOR_BUSY' },
      'no second mutation is dispatched over an unknown outcome');
    assert.equal(inserts(r).length, 1);
  }
});

test('a ladder leg that never answers, errs or cannot be dispatched keeps the mutation pending', async () => {
  // (a) no leg ever answers: the ticket's own callback deadline is the only settlement, and it is
  // uncertain. A silent leg is bounded by the ticket deadline, never by an unbounded wait.
  const stalled = rig();
  const stalledInsert = await dispatchInsert(stalled);
  stalledInsert.insert.callback(undefined);
  const late = reads(stalled)[0];
  stalled.advance(5000);
  assert.deepEqual(await stalledInsert.pending, { ok: false, code: 'APPLY_UNCERTAIN' });
  assert.equal(stalled.bridge.getState().writePending, true, 'an unanswered confirmation stays pending');
  assert.equal(stalled.bridge.getState().uncertain, true);
  late.callback('Абзац'); // a late callback only frees the owner; it never becomes a success
  assert.equal(stalled.bridge.getState().writePending, false);

  // (b) a leg callback carries a value the decode refuses: no usable observation exists, so the ladder
  // moves on instead of settling on a malformed result.
  const malformed = rig();
  const malformedInsert = await dispatchInsert(malformed);
  malformedInsert.insert.callback(undefined);
  reads(malformed)[0].callback(null);
  assert.equal(sentences(malformed).length, 1, 'an unusable observation is not a settlement: the ladder moves on');
  sentences(malformed)[0].callback('нет');
  assert.deepEqual(await malformedInsert.pending, { ok: false, code: 'APPLY_UNCERTAIN' });
  assert.equal(malformed.bridge.getState().writePending, true, 'an unusable confirmation read is not a release');

  // (c) no leg can even be dispatched: the SDK throws synchronously for every confirmation name.
  const calls = [];
  const thrown = rig('word', { executeMethod(name, params, callback) {
    calls.push({ name, params, callback });
    if (name === 'GetSelectedText' || name === 'GetCurrentSentence') throw new Error('private native detail');
    return false;
  } });
  const thrownPending = thrown.bridge.insertParagraph({ text: 'Абзац' });
  await tick();
  calls.find(call => call.name === 'PasteText').callback(undefined);
  const thrownResult = await thrownPending;
  assert.equal(thrownResult.ok, false);
  assert.equal(thrownResult.code, 'APPLY_UNCERTAIN');
  assert.equal(JSON.stringify(thrownResult).includes('private native detail'), false);
  assert.equal(calls.filter(call => call.name === 'GetSelectedText').length, 1, 'the first leg is attempted exactly once');
  assert.equal(calls.filter(call => call.name === 'GetCurrentSentence').length, 1,
    'a leg that cannot be dispatched is not the end of the ladder: the next leg is attempted exactly once');
  assert.equal(thrown.bridge.getState().writePending, true, 'a confirmation read that never ran is not a release');
});

test('a malformed non-boolean acknowledgement takes the same confirmation path and is never a success by itself', async () => {
  // A string, an object and `null` are all unusable acknowledgements: the SAME void path, never
  // INVALID_DATA, and no success unless an independent ladder leg proves the effect.
  for (const value of ['true', { acknowledged: true }, null]) {
    const label = JSON.stringify(value) ?? String(value);
    const refused = rig();
    const refusal = await dispatchInsert(refused);
    refusal.insert.callback(value);
    assert.equal(reads(refused).length, 1, `${label}: the malformed value starts the confirmation read`);
    reads(refused)[0].callback('Абзацx');
    assert.equal(sentences(refused).length, 1, `${label}: the refused leg hands the ticket to the sentence leg`);
    sentences(refused)[0].callback('Абзацx');
    assert.deepEqual(await refusal.pending, { ok: false, code: 'APPLY_UNCERTAIN' }, label);
    // The success below is the READ's proof, never the malformed native value's: the envelope says so.
    const confirmed = rig();
    const confirmation = await dispatchInsert(confirmed);
    confirmation.insert.callback(value);
    reads(confirmed)[0].callback('Абзац');
    assert.deepEqual(await confirmation.pending, VERIFIED, label);
    assert.deepEqual(sentences(confirmed), [], `${label}: a confirmed first leg stops the ladder`);
  }
});

test('each ladder leg is bounded by the dispatched payload itself, never an unbounded window', async () => {
  // 'Абзац' is 10 UTF-8 bytes. A read one byte longer is refused by that leg's decode bound and
  // therefore cannot be confirmed, while the exact payload is accepted: together the cases pin every
  // leg's budget to the payload's own byte length rather than to the 8 KiB selection window.
  const over = rig();
  const overInsert = await dispatchInsert(over);
  overInsert.insert.callback(undefined);
  reads(over)[0].callback('Абзацx'); // 11 bytes at the selection leg
  assert.equal(sentences(over).length, 1, 'an over-budget observation is not a settlement');
  sentences(over)[0].callback('Абзацx'); // 11 bytes at the sentence leg too
  assert.deepEqual(await overInsert.pending, { ok: false, code: 'APPLY_UNCERTAIN' });

  const exact = rig();
  const exactInsert = await dispatchInsert(exact);
  exactInsert.insert.callback(undefined);
  reads(exact)[0].callback('Абзац'); // exactly 10 bytes
  assert.deepEqual(await exactInsert.pending, VERIFIED);
  assert.deepEqual(sentences(exact), [], 'the exact payload never reaches the sentence leg');

  // `end` dispatches text + "\n", and each leg's budget is that DISPATCHED payload's own size: the
  // un-newlined text is not the SELECTION payload, and one byte short is not the payload.
  const short = rig();
  const shortInsert = await dispatchInsert(short, { text: 'Абзац', position: 'end' });
  assert.deepEqual(shortInsert.insert.params, ['Абзац\n'], 'the newline is part of the dispatched payload');
  shortInsert.insert.callback(undefined);
  reads(short)[0].callback('Абзац');
  assert.equal(sentences(short).length, 1, 'the un-newlined text is not the selection payload: the ladder moves on');
  sentences(short)[0].callback('нет');
  assert.deepEqual(await shortInsert.pending, { ok: false, code: 'APPLY_UNCERTAIN' });

  const ended = rig();
  const endedInsert = await dispatchInsert(ended, { text: 'Абзац', position: 'end' });
  endedInsert.insert.callback(undefined);
  reads(ended)[0].callback('Абзац\n'); // 11 bytes: only inside the budget if it is the payload's own
  assert.deepEqual(await endedInsert.pending, VERIFIED);
  assert.deepEqual(sentences(ended), [], 'the selection leg confirmed the newline payload on its own');
});

test('a duplicate acknowledgement for the same dispatch cannot preempt the confirmation read', async () => {
  const r = rig();
  const { pending, insert } = await dispatchInsert(r);
  insert.callback(undefined);
  insert.callback(true); // a second acknowledgement is not a settlement of the first one
  assert.equal(r.bridge.getState().writePending, true);
  assert.equal(reads(r).length, 1);
  reads(r)[0].callback('Абзац');
  assert.deepEqual(await pending, VERIFIED);
  assert.equal(inserts(r).length, 1);
});

test('a void acknowledgement that arrives past the deadline is the uncertain class, never a known timeout', async () => {
  // The callback arrived but the ticket's own timer had not run yet: the payload WAS dispatched, so the
  // only honest class is the uncertain one — reporting a plain TIMEOUT would be the same false-failure
  // shape this fix exists to remove. No confirmation read is attempted on an expired ticket.
  const r = rig();
  const { pending, insert } = await dispatchInsert(r);
  r.setNow(5000);
  insert.callback(undefined);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'APPLY_UNCERTAIN');
  assert.equal(reads(r).length, 0, 'an expired ticket does not dispatch a confirmation read');
  assert.equal(inserts(r).length, 1, 'and it certainly does not retry the mutation');
});

// --- the ladder's second leg: `GetCurrentSentence`, the primitive the live build answers ----------

test('GetSelectedText returning the measured empty string no longer condemns an insert the sentence leg confirms', async () => {
  // The measured 2026.3.1 behaviour: the paste does not leave the inserted text selected, so leg 1
  // answers "" both immediately and after +400 ms, while `GetCurrentSentence` answers with exactly the
  // inserted sentence. The insert is therefore CONFIRMED, in ladder order, with one call per leg.
  const r = rig();
  const { pending, insert } = await dispatchInsert(r);
  insert.callback(undefined);
  assert.equal(reads(r).length, 1);
  assert.equal(r.bridge.getState().writePending, true, 'the ticket is still owned while leg 1 answers');
  reads(r)[0].callback(''); // the live measurement, not a hypothetical
  assert.equal(sentences(r).length, 1, 'the refused selection leg dispatches the sentence leg');
  assert.deepEqual(sentences(r)[0].params, []);
  assert.ok(Object.isFrozen(sentences(r)[0].params));
  assert.deepEqual(confirmationOrder(r), ['GetSelectedText', 'GetCurrentSentence'], 'the ladder is ordered');
  assert.equal(r.bridge.getState().writePending, true, 'the write lock spans the whole ladder');
  sentences(r)[0].callback('Абзац');
  assert.deepEqual(await pending, VERIFIED);
  assert.equal(r.bridge.getState().writePending, false, 'a confirmed effect settles the mutation');
  assert.equal(reads(r).length, 1);
  assert.equal(sentences(r).length, 1, 'one call per leg');
  assert.equal(inserts(r).length, 1, 'the mutation is never retried');
});

test('the sentence leg refuses an empty or different sentence, including the measured trailing-period failure mode', async () => {
  // Measured on the live build: a payload ending with a sentence terminator leaves the caret past the
  // sentence and `GetCurrentSentence` answers "". That payload cannot be confirmed by leg 2, and the
  // ladder settles the uncertain class rather than inventing a success.
  const period = rig();
  const pending = await runLadder(period, { request: { text: 'Готово.' }, selection: '', sentence: '' });
  assert.deepEqual(await pending, { ok: false, code: 'APPLY_UNCERTAIN' });
  assert.equal(period.bridge.getState().writePending, true, 'an unconfirmed mutation keeps the slot and the lock');
  assert.equal(period.bridge.getState().uncertain, true);
  assert.equal(inserts(period).length, 1, 'no leg failure retries the mutation');

  const different = rig();
  assert.deepEqual(await runLadder(different, { selection: '', sentence: 'Другое предложение' }),
    { ok: false, code: 'APPLY_UNCERTAIN' });

  const prefix = rig();
  assert.deepEqual(await runLadder(prefix, { selection: '', sentence: 'Абза' }), { ok: false, code: 'APPLY_UNCERTAIN' },
    'a prefix of the payload is not equality');
});

test('the sentence leg normalization removes exactly one trailing newline and nothing else', async () => {
  // `position:'end'` dispatched `text + "\n"`; a sentence read cannot contain a paragraph break. The ONE
  // documented normalization is a single trailing newline removed — no other trimming, no case folding,
  // no fuzzy matching and no second newline.
  const end = rig();
  const { pending, insert } = await dispatchInsert(end, { text: 'Привет', position: 'end' });
  assert.deepEqual(insert.params, ['Привет\n']);
  insert.callback(undefined);
  reads(end)[0].callback('');
  assert.equal(sentences(end).length, 1);
  sentences(end)[0].callback('Привет'); // the payload minus its single trailing newline
  assert.deepEqual(await pending, VERIFIED, 'the end payload is confirmed through the one normalization');

  // The newline still on the sentence read is NOT the normalized form, so it must not confirm.
  const kept = rig();
  assert.deepEqual(await runLadder(kept, { request: { text: 'Привет', position: 'end' }, selection: '', sentence: 'Привет\n' }),
    { ok: false, code: 'APPLY_UNCERTAIN' });

  // No other whitespace is trimmed, and the verbatim payload is the only string that confirms.
  const padded = rig();
  assert.deepEqual(await runLadder(padded, { request: { text: ' Абзац ' }, selection: '', sentence: 'Абзац' }),
    { ok: false, code: 'APPLY_UNCERTAIN' });
  const verbatim = rig();
  assert.deepEqual(await runLadder(verbatim, { request: { text: ' Абзац ' }, selection: '', sentence: ' Абзац ' }),
    VERIFIED);

  const folded = rig();
  assert.deepEqual(await runLadder(folded, { request: { text: 'Абзац' }, selection: '', sentence: 'абзац' }),
    { ok: false, code: 'APPLY_UNCERTAIN' }, 'no case folding');
});

test('the sentence leg compares the payload literally, so quotes, angle brackets, ampersands and Cyrillic are not escaped', async () => {
  // The ladder legs are plain text reads, not the HTML export: an HTML-escaped echo of the payload is a
  // DIFFERENT string and must not confirm, while the verbatim payload must.
  const payload = 'Он сказал "да" <и> & всё';
  const verbatim = rig();
  assert.deepEqual(await runLadder(verbatim, { request: { text: payload }, selection: '', sentence: payload }), VERIFIED);

  const escaped = rig();
  assert.deepEqual(await runLadder(escaped, { request: { text: payload }, selection: '', sentence: 'Он сказал &quot;да&quot; &lt;и&gt; &amp; всё' }),
    { ok: false, code: 'APPLY_UNCERTAIN' }, 'no HTML escaping or unescaping is applied to a plain sentence read');
});

test('the ladder has no whole-document leg: an unconfirmed ladder never reaches for GetFileHTML', async () => {
  // `GetFileHTML` containment cannot distinguish a payload that just landed from one already in the
  // document, so it is deliberately absent: a false success is worse than the false failure fixed here.
  const r = rig();
  assert.deepEqual(await runLadder(r, { selection: '', sentence: 'нет' }), { ok: false, code: 'APPLY_UNCERTAIN' });
  assert.deepEqual(r.calls.filter(call => call.name === 'GetFileHTML'), [],
    'the whole-document read is never dispatched by the confirmation ladder');
  assert.deepEqual(confirmationOrder(r), ['GetSelectedText', 'GetCurrentSentence'], 'exactly two legs, in order');
});

test('a superseded leg callback is never judged by the next leg rule and never advances the ladder twice', async () => {
  const r = rig();
  const { pending, insert } = await dispatchInsert(r);
  insert.callback(undefined);
  reads(r)[0].callback(''); // leg 1 refused
  assert.equal(sentences(r).length, 1);
  reads(r)[0].callback('Абзац'); // a duplicate leg-1 callback carrying the payload
  assert.equal(sentences(r).length, 1, 'a superseded leg callback dispatches nothing');
  assert.equal(r.bridge.getState().writePending, true, 'and it does not confirm under another leg rule');
  sentences(r)[0].callback('Абзац'); // the current leg's own observation
  assert.deepEqual(await pending, VERIFIED);
  assert.equal(reads(r).length, 1);
  assert.equal(sentences(r).length, 1);
  assert.equal(inserts(r).length, 1);
});

test('an observation delivered past the ticket deadline is not confirmed and the ladder moves on', async () => {
  // A leg that times out is "not confirmed" and hands the ticket to the next leg — never a retry of
  // the mutation and never an immediate success.
  const r = rig();
  const { pending, insert } = await dispatchInsert(r);
  insert.callback(undefined);
  r.setNow(5000); // the ticket's own budget is spent before leg 1 answers
  reads(r)[0].callback(''); // '' is a mismatch anyway, but the ticket expiry is checked first
  assert.equal(sentences(r).length, 1, 'an expired observation is not a settlement: the next leg is dispatched');
  sentences(r)[0].callback('Абзац'); // the right string, but the ticket budget is already spent
  assert.deepEqual(await pending, { ok: false, code: 'APPLY_UNCERTAIN' });
  assert.equal(inserts(r).length, 1, 'the mutation is never retried');
  assert.equal(r.bridge.getState().writePending, true, 'an expired ladder leaves the mutation pending');
});
