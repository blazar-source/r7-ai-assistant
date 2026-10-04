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
  // The identity leg settles synchronously in this rig, so the ticket reaches its baseline phase at
  // the next event-loop checkpoint: a fact about the bridge, not a guessed tick count. The baselines
  // are answered by the helper, which also pins that the mutation waits for them.
  const first = await dispatchInsert(r, { text: 'Абзац' });
  assert.equal(r.bridge.getState().writePending, true, 'a dispatched insert is a pending mutation');
  // The panel lock reads exactly this state (controller.writeLocked()), so a second mutation must be
  // refused for as long as it holds.
  assert.deepEqual(await r.bridge.insertParagraph({ text: 'Второй' }), { ok: false, code: 'EDITOR_BUSY' });
  first.insert.callback(true);
  assert.deepEqual(await first.pending, { ok: true, data: { sent: true } });
  assert.equal(r.bridge.getState().writePending, false, 'the lock is released when the insert settles');
  const next = await dispatchInsert(r, { text: 'Третий' });
  next.insert.callback(true);
  assert.deepEqual(await next.pending, { ok: true, data: { sent: true } }, 'the released slot accepts the next mutation');

  // Before the paste, the ticket is already owned (a second mutation is refused) but no mutation has
  // been dispatched, so `writePending` — the "a mutation may have reached the editor" flag the write
  // lock reads — is still false while the baseline reads run.
  const preRig = rig();
  const pre = preRig.bridge.insertParagraph({ text: 'Абзац' });
  await tick();
  assert.equal(preRig.bridge.getState().busy, true, 'the baseline phase owns the slot');
  assert.equal(preRig.bridge.getState().writePending, false, 'a baseline read is not a dispatched mutation');
  assert.deepEqual(await preRig.bridge.insertParagraph({ text: 'Второй' }), { ok: false, code: 'EDITOR_BUSY' });
  baselineReads(preRig)[0].callback('');
  baselineReads(preRig)[1].callback('');
  assert.equal(inserts(preRig).length, 1);
  assert.equal(preRig.bridge.getState().writePending, true, 'the dispatched paste is the pending mutation');
  inserts(preRig)[0].callback(true);
  assert.deepEqual(await pre, { ok: true, data: { sent: true } });

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
  const held = (await dispatchInsert(heldRig, { text: 'Абзац' })).pending;
  assert.equal(heldRig.bridge.getState().writePending, true);
  heldRig.advance(5000);
  assert.deepEqual(await held, { ok: false, code: 'APPLY_UNCERTAIN' });
  assert.equal(heldRig.bridge.getState().writePending, true, 'uncertain-until-callback stays pending');
  assert.equal(heldRig.bridge.getState().uncertain, true);
  inserts(heldRig)[0].callback(true);
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
// reproduces the dispatched payload through that leg's own exact rule AND that observation differs
// from the same observation read BEFORE the paste.
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
//
// EVERY leg also reads its own observation BEFORE the mutation. A post-dispatch read that reproduces
// the payload proves only that the caret scope EQUALS the payload; a `PasteText` that calls back
// `undefined` and does nothing over a scope that already held the payload would satisfy it without an
// insert happening. So the ticket first dispatches one baseline read per leg (gated: the paste is
// dispatched only after they answered or failed), and a leg confirms only when its post-dispatch
// observation reproduces the payload AND differs from that baseline.
const VERIFIED = { ok: true, data: { sent: true, effectVerified: true } };
const tick = () => new Promise(resolve => setImmediate(resolve));
const isLeg = call => call.name === 'GetSelectedText' || call.name === 'GetCurrentSentence';
const inserts = r => r.calls.filter(call => call.name === 'PasteText');
const lastPasteAt = r => { const last = inserts(r).at(-1); return last ? r.calls.indexOf(last) : -1; };
// The leg reads immediately PRECEDING the last mutation are its baselines (the baseline phase is
// contiguous and ends by dispatching the paste); the leg reads after the mutation are the ladder's.
// Before the mutation exists at all, only the baselines are present.
const baselineReads = r => {
  const at = lastPasteAt(r);
  const before = at < 0 ? r.calls : r.calls.slice(0, at);
  let from = before.length;
  while (from > 0 && isLeg(before[from - 1])) from -= 1;
  return before.slice(from);
};
const postReads = r => { const at = lastPasteAt(r); return at < 0 ? [] : r.calls.slice(at + 1).filter(isLeg); };
const reads = r => postReads(r).filter(call => call.name === 'GetSelectedText');
const sentences = r => postReads(r).filter(call => call.name === 'GetCurrentSentence');
const confirmationOrder = r => postReads(r).map(call => call.name);
// Reach the dispatched mutation: the ticket is owned from the start, but each leg's baseline read must
// be answered before the paste exists at all. The ordering assertions here are part of the contract,
// so a build that dispatches the mutation before its baselines fails here rather than being hidden.
// Everything this insert dispatches is read from `from`, so a rig that already ran an earlier insert
// on the same bridge still reports THIS one's baselines and mutation.
async function dispatchInsert(r, request = { text: 'Абзац' }, baseline = { selection: '', sentence: '' }) {
  const from = r.calls.length;
  const pending = r.bridge.insertParagraph(request);
  await tick();
  const legs = () => r.calls.slice(from).filter(isLeg);
  const pastes = () => r.calls.slice(from).filter(call => call.name === 'PasteText');
  assert.deepEqual(legs().map(call => call.name), ['GetSelectedText'],
    'the selection baseline is dispatched before the mutation');
  assert.equal(pastes().length, 0, 'no mutation is dispatched before its baselines answer');
  legs()[0].callback(baseline.selection);
  assert.deepEqual(legs().map(call => call.name), ['GetSelectedText', 'GetCurrentSentence'],
    'the sentence baseline follows, still before the mutation');
  assert.equal(pastes().length, 0, 'the mutation waits for every baseline');
  legs()[1].callback(baseline.sentence);
  assert.equal(pastes().length, 1, 'the insert is dispatched exactly once, after its baselines');
  return { pending, insert: pastes()[0] };
}
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
    assert.deepEqual(baselineReads(r).map(call => call.name), ['GetSelectedText', 'GetCurrentSentence'],
      'the baselines are dispatched before the mutation because its acknowledgement is unknown until then');
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

  // (c) no leg can even be dispatched: the SDK throws synchronously for every confirmation name, so
  // no baseline is usable and neither leg can confirm — the paste is still dispatched exactly once.
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
  assert.equal(calls.filter(call => call.name === 'GetSelectedText').length, 1,
    'the selection baseline is attempted exactly once');
  assert.equal(calls.filter(call => call.name === 'GetCurrentSentence').length, 1,
    'the sentence baseline is attempted exactly once');
  assert.equal(calls.filter(call => call.name === 'PasteText').length, 1, 'the mutation is never retried');
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

// --- the PRE-DISPATCH BASELINE: "the scope shows the payload" is not "the scope changed to it" -----
// An independent review reproduced a fail-open leg in a unit rig: a fake `PasteText` that calls back
// `undefined` and mutates NOTHING, over a caret scope that ALREADY held the payload, satisfied the
// post-dispatch exact-equality rule and settled `{sent:true, effectVerified:true}` for an insert that
// never happened. That is the mirror image of the false failure this repair exists to remove, so the
// rule is tightened: a leg confirms only when its post-dispatch observation reproduces the payload
// through that leg's own rule AND differs from the SAME observation read BEFORE the paste.
//
// The reproduction comes first. This fixture is a real (tiny) document model, and `PasteText` is
// either the reviewer's no-op or genuinely applies the payload, so nothing here asserts a fixture's
// own timing: every callback is delivered synchronously and the dispatch ORDER is a fact of the rig.
function documentRig({ selection = '', sentence = '', applies = false } = {}) {
  const state = { selection, sentence };
  const calls = [];
  const plugin = {
    info: { editorType: 'word' },
    executeMethod(name, params, callback) {
      calls.push({ name, params, callback });
      if (name === 'GetSelectedText') callback(state.selection);
      else if (name === 'GetCurrentSentence') callback(state.sentence);
      else if (name === 'PasteText') {
        // A no-op paste leaves BOTH observations exactly as they were; an applying paste moves the
        // caret scope to the dispatched payload (the measured live shape: nothing stays selected).
        if (applies) {
          state.selection = '';
          state.sentence = params[0].endsWith('\n') ? params[0].slice(0, -1) : params[0];
        }
        callback(undefined); // the measured live acknowledgement value
      } else throw new Error(`unexpected native method ${name}`);
      return false;
    },
    callCommand(body, _close, _recalculate, callback) {
      const result = runContext(body);
      if (result.identity) callback(result.value);
      else calls.push({ name: 'presence', callback });
      return false;
    }
  };
  const bridge = createR7Bridge(plugin, { editorType: 'word' });
  const order = () => calls.filter(call => ['GetSelectedText', 'GetCurrentSentence', 'PasteText'].includes(call.name)).map(call => call.name);
  return { bridge, calls, state, order };
}

test('the reviewer reproduction: a no-op PasteText over a caret sentence that already equals the payload is never verified', async () => {
  const r = documentRig({ selection: '', sentence: 'Абзац', applies: false });
  const result = await r.bridge.insertParagraph({ text: 'Абзац' });
  assert.equal(result.ok, false, 'an insert that never applied is never reported as a success');
  assert.deepEqual(result, { ok: false, code: 'APPLY_UNCERTAIN' });
  assert.equal(r.bridge.getState().writePending, true, 'the unknown outcome keeps the slot and the write lock');
  assert.equal(r.calls.filter(call => call.name === 'PasteText').length, 1, 'the mutation is dispatched exactly once');
  assert.deepEqual(r.state, { selection: '', sentence: 'Абзац' }, 'the fake paste really changed nothing');
});

test('a genuinely applied insert is verified when its baseline differed from the payload', async () => {
  // 'стар'/'друг' are inside the payload's own 10-byte budget and differ from it: a baseline that is
  // itself LONGER than the payload would be refused by that leg's bound (pinned below), which is the
  // budget rule the confirmation legs already use, applied to the baseline as well.
  const r = documentRig({ selection: 'стар', sentence: 'друг', applies: true });
  assert.deepEqual(await r.bridge.insertParagraph({ text: 'Абзац' }), VERIFIED,
    'the sentence leg saw the payload arrive where a different sentence had been');
});

test('a genuinely applied insert whose baseline already equalled the payload settles uncertain, never success', async () => {
  // The accepted conservative cost: an observation that did not CHANGE cannot be told apart from a
  // paste that did nothing, so the ticket settles the uncertain class even though this paste applied.
  const r = documentRig({ selection: '', sentence: 'Абзац', applies: true });
  const result = await r.bridge.insertParagraph({ text: 'Абзац' });
  assert.deepEqual(result, { ok: false, code: 'APPLY_UNCERTAIN' }, 'never a false success');
  assert.equal(r.bridge.getState().writePending, true, 'the conservative class keeps the write lock');
});

test('every leg baseline is dispatched before the irreversible paste, whose payload is unchanged', async () => {
  const r = documentRig({ selection: '', sentence: 'друг', applies: true });
  assert.deepEqual(await r.bridge.insertParagraph({ text: 'Абзац' }), VERIFIED);
  const order = r.order();
  const at = order.indexOf('PasteText');
  assert.equal(at, 2, `both leg baselines precede the mutation (order: ${order.join(',')})`);
  assert.deepEqual(order.slice(0, at), ['GetSelectedText', 'GetCurrentSentence'], 'one baseline per leg, in ladder order');
  assert.deepEqual(order.slice(at + 1), ['GetSelectedText', 'GetCurrentSentence'], 'the ladder then asks one post-dispatch read per leg');
  assert.deepEqual(r.calls.find(call => call.name === 'PasteText').params, ['Абзац'],
    'the baseline changes neither the payload nor the number of paste dispatches');
  assert.equal(r.calls.filter(call => call.name === 'PasteText').length, 1);
});

// A manual-callback rig whose per-method answers are programmable: the FIRST call of a method name is
// its pre-dispatch BASELINE and can be answered (or made to throw) by the fixture, while later calls
// are the ladder's post-dispatch reads and stay held for the test to drive.
function baselineScaffold(baselines = {}) {
  const calls = [];
  const seen = new Map();
  const plugin = {
    info: { editorType: 'word' },
    executeMethod(name, params, callback) {
      calls.push({ name, params, callback });
      const nth = (seen.get(name) ?? 0) + 1;
      seen.set(name, nth);
      const answer = baselines[name];
      if (nth === 1 && typeof answer === 'function') answer(callback);
      return false;
    },
    callCommand(body, _close, _recalculate, callback) {
      const result = runContext(body);
      if (result.identity) callback(result.value);
      else calls.push({ name: 'presence', callback });
      return false;
    }
  };
  const bridge = createR7Bridge(plugin, { editorType: 'word' });
  return { bridge, calls,
    named: name => calls.filter(call => call.name === name),
    paste: () => calls.find(call => call.name === 'PasteText') };
}

test('a leg whose baseline read threw, was malformed or was oversized can never confirm and is not asked again', async () => {
  for (const [label, selectionBaseline] of [
    ['threw', () => { throw new Error('private native detail'); }],
    ['malformed', callback => callback(null)],
    ['oversized', callback => callback('Абзацx')] // 11 bytes against the payload's own 10-byte budget
  ]) {
    const r = baselineScaffold({ GetSelectedText: selectionBaseline, GetCurrentSentence: callback => callback('друг') });
    const pending = r.bridge.insertParagraph({ text: 'Абзац' });
    await tick();
    assert.equal(r.named('GetSelectedText').length, 1, `${label}: the selection baseline is attempted once`);
    assert.equal(r.named('GetCurrentSentence').length, 1, `${label}: the sentence baseline still follows`);
    assert.ok(r.paste(), `${label}: an unusable baseline never blocks the mutation`);
    r.paste().callback(undefined);
    assert.equal(r.named('GetSelectedText').length, 1,
      `${label}: a leg with no usable baseline cannot confirm and is not even asked for a post read`);
    assert.equal(r.named('GetCurrentSentence').length, 2, `${label}: the capable sentence leg is asked for its post-dispatch observation`);
    r.named('GetCurrentSentence')[1].callback('Абзац');
    const result = await pending;
    assert.deepEqual(result, VERIFIED, `${label}: the capable leg still proves the effect`);
    assert.equal(JSON.stringify(result).includes('private native detail'), false, `${label}: no native detail escapes`);
  }
});

test('an oversized baseline leaves its own leg incapable while the other leg still decides', async () => {
  // The sentence leg's baseline is longer than the payload's own budget, so that leg can never confirm
  // (and is not asked again); the selection leg's baseline is inside the budget, and its post-dispatch
  // read — equal to the payload, different from the baseline — decides.
  const r = baselineScaffold({ GetSelectedText: callback => callback(''), GetCurrentSentence: callback => callback('Абзацx') });
  const pending = r.bridge.insertParagraph({ text: 'Абзац' });
  await tick();
  assert.equal(r.named('GetSelectedText').length, 1);
  assert.equal(r.named('GetCurrentSentence').length, 1, 'the oversized baseline is dispatched and refused');
  r.paste().callback(undefined);
  assert.equal(r.named('GetCurrentSentence').length, 1, 'the oversized-baseline leg is never asked for a post read');
  assert.equal(r.named('GetSelectedText').length, 2, 'the capable selection leg is asked');
  r.named('GetSelectedText')[1].callback('Абзац');
  assert.deepEqual(await pending, VERIFIED);
});

// --- D-B: one logical insert dispatches the paste EXACTLY ONCE, structurally ----------------------
// An independent review reproduced a second `PasteText` for ONE logical insert: a leg's baseline
// `plugin.executeMethod` called its callback SYNCHRONOUSLY and THEN threw, so the catch re-entered the
// SAME leg, its baseline was dispatched twice, each answer advanced to `dispatchPaste`, and the
// mutation was dispatched twice — a violation of design §8.4 and of the owner's "no automatic retry of
// the mutation". The guard that closes it is structural (an `owned.dispatched` check that makes the
// paste a once-per-ticket boundary, plus a per-leg `dispatched` mark that makes a baseline
// once-per-leg), never an assumption about native callback ordering.
function callbackThenThrowScaffold({ selectionSynchronously = true } = {}) {
  const calls = [];
  const seen = new Map();
  const plugin = {
    info: { editorType: 'word' },
    executeMethod(name, params, callback) {
      calls.push({ name, params, callback });
      if (name === 'PasteText') return false; // the mutation is held for the test to answer
      const nth = (seen.get(name) ?? 0) + 1;
      seen.set(name, nth);
      // The reviewer's shape: the native delivers THIS leg's baseline callback synchronously and then
      // throws out of the same call. A second baseline dispatch would be the defect.
      if (selectionSynchronously) callback('');
      throw new Error('private native detail');
    },
    callCommand(body, _close, _recalculate, callback) {
      const result = runContext(body);
      if (result.identity) callback(result.value);
      else calls.push({ name: 'presence', callback });
      return false;
    }
  };
  const bridge = createR7Bridge(plugin, { editorType: 'word' });
  return { bridge, calls };
}

test('a baseline that answers synchronously and then throws still dispatches one baseline per leg and one paste', async () => {
  const r = callbackThenThrowScaffold();
  const pending = r.bridge.insertParagraph({ text: 'Абзац' });
  await tick();
  const baselines = name => r.calls.filter(call => call.name === name);
  assert.equal(baselines('GetSelectedText').length, 1, 'the selection baseline is dispatched exactly once');
  assert.equal(baselines('GetCurrentSentence').length, 1, 'the sentence baseline is dispatched exactly once');
  const pastes = r.calls.filter(call => call.name === 'PasteText');
  assert.equal(pastes.length, 1, 'ONE logical insert dispatches the paste exactly once');
  assert.deepEqual(pastes[0].params, ['Абзац'], 'the single dispatch carries the unchanged payload');
  assert.equal(r.calls.some(call => call.name === 'GetFileHTML'), false);
  pastes[0].callback(true);
  const result = await pending;
  assert.deepEqual(result, { ok: true, data: { sent: true } }, 'the single dispatch still settles the ticket');
  assert.equal(JSON.stringify(result).includes('private native detail'), false, 'no native detail escapes');
});

test('a callback then a throw cannot dispatch a second paste even when no baseline answered', async () => {
  // The same shape for the OTHER leg: `GetSelectedText` throws without ever calling back, while
  // `GetCurrentSentence` calls back and then throws. The paste must still be dispatched once.
  const calls = [];
  let selectionThrew = false;
  const plugin = {
    info: { editorType: 'word' },
    executeMethod(name, params, callback) {
      calls.push({ name, params, callback });
      if (name === 'PasteText') return false;
      if (name === 'GetSelectedText') { selectionThrew = true; throw new Error('private'); }
      callback('');
      throw new Error('private');
    },
    callCommand(body, _close, _recalculate, callback) {
      const result = runContext(body);
      if (result.identity) callback(result.value);
      return false;
    }
  };
  const bridge = createR7Bridge(plugin, { editorType: 'word' });
  const pending = bridge.insertParagraph({ text: 'Абзац' });
  await tick();
  assert.equal(selectionThrew, true, 'the selection baseline threw instead of answering');
  assert.equal(calls.filter(call => call.name === 'PasteText').length, 1, 'the paste is dispatched once');
  calls.find(call => call.name === 'PasteText').callback(true);
  assert.deepEqual(await pending, { ok: true, data: { sent: true } });
});

// --- D-C: an insert whose paste was NEVER dispatched is a KNOWN outcome, and releases the slot -----
// Nothing reached the mutation, so the honest class is not the uncertain one, and the slot must not
// stay held: a hung baseline used to wedge the bridge permanently (busy with writePending false),
// leaving the panel reporting an unlocked state while the bridge refused every later operation.
test('a baseline that never answers settles a known timeout, releases the slot and admits the next insert', async () => {
  const r = rig();
  const stalled = r.bridge.insertParagraph({ text: 'Абзац' });
  await tick();
  assert.equal(r.bridge.getState().busy, true, 'the baseline phase owns the slot');
  assert.equal(r.bridge.getState().writePending, false, 'nothing was dispatched');
  assert.deepEqual(r.calls.map(call => call.name), ['GetSelectedText']);
  r.advance(5000);
  assert.deepEqual(await stalled, { ok: false, code: 'TIMEOUT' },
    'an insert that dispatched NOTHING is a known failure, never a false uncertainty');
  assert.equal(r.bridge.getState().busy, false, 'the undispatched ticket releases its slot');
  assert.equal(r.bridge.getState().writePending, false);
  assert.equal(r.bridge.getState().uncertain, false);
  assert.equal(inserts(r).length, 0, 'nothing was dispatched');
  // The released slot admits the next operation: the bridge is not wedged.
  const next = r.bridge.insertParagraph({ text: 'Второй' });
  await tick();
  assert.equal(r.calls.filter(call => call.name === 'GetSelectedText').length, 2, 'a later insert reaches its own baseline phase');
  r.calls.at(-1).callback('');
  r.calls.at(-1).callback('');
  assert.equal(inserts(r).length, 1, 'the later insert dispatches its own single paste');
  inserts(r)[0].callback(true);
  assert.deepEqual(await next, { ok: true, data: { sent: true } });
});

test('an insert aborted before its paste is dispatched releases the slot as the known cancellation', async () => {
  const r = rig();
  const controller = new AbortController();
  const pending = r.bridge.insertParagraph({ text: 'Абзац', signal: controller.signal });
  await tick();
  assert.equal(r.bridge.getState().busy, true);
  assert.equal(inserts(r).length, 0);
  controller.abort();
  assert.deepEqual(await pending, { ok: false, code: 'CANCELLED' }, 'nothing was dispatched: a known cancellation');
  assert.equal(r.bridge.getState().busy, false, 'the aborted undispatched ticket releases its slot');
  assert.equal(inserts(r).length, 0, 'an abort that lands before the paste prevents the mutation entirely');
  const next = r.bridge.insertParagraph({ text: 'Второй' });
  await tick();
  assert.equal(r.calls.filter(call => call.name === 'GetSelectedText').length, 2, 'the next insert is dispatchable');
  r.calls.at(-1).callback('');
  r.calls.at(-1).callback('');
  inserts(r)[0].callback(true);
  assert.deepEqual(await next, { ok: true, data: { sent: true } });
});

test('an insert whose paste WAS dispatched keeps the uncertain class and the held slot on its deadline', async () => {
  // The control leg: once `PasteText` has been dispatched, the deadline keeps today's behaviour —
  // the uncertain class, the slot held, and no retry.
  const r = rig();
  const { pending, insert } = await dispatchInsert(r);
  assert.equal(inserts(r).length, 1);
  r.advance(5000);
  assert.deepEqual(await pending, { ok: false, code: 'APPLY_UNCERTAIN' }, 'a dispatched paste keeps the uncertain class');
  assert.equal(r.bridge.getState().busy, true, 'the unknown outcome keeps the slot');
  assert.equal(r.bridge.getState().writePending, true);
  assert.equal(r.bridge.getState().uncertain, true);
  assert.deepEqual(await r.bridge.insertParagraph({ text: 'Второй' }), { ok: false, code: 'EDITOR_BUSY' });
  assert.equal(inserts(r).length, 1, 'the mutation is never retried');
  insert.callback(true);
  assert.equal(r.bridge.getState().busy, false, 'the late callback releases the owner');
});

test('a hung baseline no longer makes dispose() a no-op that leaves the bridge permanently busy', async () => {
  const r = rig();
  const pending = r.bridge.insertParagraph({ text: 'Абзац' });
  await tick();
  assert.equal(inserts(r).length, 0);
  r.bridge.dispose();
  assert.deepEqual(await pending, { ok: false, code: 'CANCELLED' }, 'dispose settles the undispatched ticket');
  assert.equal(r.bridge.getState().busy, false, 'the slot is freed, not wedged behind a settled ticket');
  assert.equal(r.bridge.getState().disposed, true);
  assert.equal(inserts(r).length, 0, 'dispose certainly never dispatches a paste');
});

test('a ladder whose every baseline is unusable asks nothing and settles the uncertain class', async () => {
  const fail = () => { throw new Error('private native detail'); };
  const r = baselineScaffold({ GetSelectedText: fail, GetCurrentSentence: fail });
  const pending = r.bridge.insertParagraph({ text: 'Абзац' });
  await tick();
  assert.ok(r.paste(), 'the mutation is still dispatched');
  r.paste().callback(undefined);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'APPLY_UNCERTAIN');
  assert.equal(JSON.stringify(result).includes('private native detail'), false);
  assert.equal(r.named('GetSelectedText').length, 1, 'no leg without a baseline is asked for a post read');
  assert.equal(r.named('GetCurrentSentence').length, 1, 'the same for the sentence leg');
  assert.equal(r.bridge.getState().writePending, true, 'the unknown outcome keeps the slot and the write lock');
});
