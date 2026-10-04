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
