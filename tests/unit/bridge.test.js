import test from 'node:test';
import assert from 'node:assert/strict';
import { createR7Bridge } from '../../src/plugin/bridge.js';
import { LIMITS } from '../../src/shared/limits.js';
import { utf8ByteLength } from '../../src/shared/bytes.js';
import { htmlPlatform } from '../fixtures/html-document.js';

// The confirmation reads the document's DECODED TEXT, so the bridge needs the platform's own parser. Every
// rig below injects the fixture boundary through the bridge's own `platform` option: the boundary is
// explicit and injected, never reached for through a global, and the real plugin page passes the page's
// own `document` and `DOMParser`.
const platformBoundary = htmlPlatform();

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
  const bridge = documentBoundaryRig(plugin, {
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
  // The identity leg settles synchronously in this rig, so the ticket reaches its baseline read at
  // the next event-loop checkpoint: a fact about the bridge, not a guessed tick count. The baseline
  // read is the gate — the helper pins that the mutation is dispatched only after it answered.
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
  // lock reads — is still false while the baseline read runs.
  const preRig = rig();
  const pre = preRig.bridge.insertParagraph({ text: 'Абзац' });
  await tick();
  assert.equal(preRig.bridge.getState().busy, true, 'the baseline phase owns the slot');
  assert.equal(preRig.bridge.getState().writePending, false, 'a baseline read is not a dispatched mutation');
  assert.deepEqual(await preRig.bridge.insertParagraph({ text: 'Второй' }), { ok: false, code: 'EDITOR_BUSY' });
  assert.deepEqual(preRig.calls.map(call => call.name), ['GetFileHTML'], 'the document baseline is the only dispatch');
  assert.equal(inserts(preRig).length, 0, 'nothing reached the editor yet');
  preRig.calls.at(-1).callback('<p>стар</p>');
  assert.equal(inserts(preRig).length, 1, 'the gate opened and the paste is dispatched');
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
// ticket stays OWNED (still a pending mutation, still write-locked) and asks the DOCUMENT itself.
//
// THE DOCUMENT DELTA. An independent review found the earlier caret-scope rule fail-open: "a caret
// scope EQUALS the payload and DIFFERS from its pre-dispatch baseline" is not attribution — a
// concurrent NON-paste change (the user typing, autocorrect, a native that moves the caret) that lands
// exactly on the payload satisfies it while nothing was inserted. The owner's decision: correctness
// first, so `effectVerified:true` may only mean that the DOCUMENT itself gained the payload. The
// confirmation therefore counts the occurrences of the dispatched payload in the document's own
// `GetFileHTML` export — once BEFORE the paste (the pre-dispatch baseline, by construction) and once
// AFTER it — and confirms ONLY when the post count is exactly `baselineCount + 1`.
//
// THE COUNTING FORM. The confirmation counts in the document's DECODED TEXT, not in the markup: the
// export is parsed with `DOMParser` (`parseFromString(html, 'text/html')`), supplied through the same
// injected platform object as the DOM reference — a parsed document has NO browsing context, so no
// subresource is loaded and no handler can run — and the text nodes are collected with ONE `"\n"` after
// EVERY element boundary EXCEPT the explicitly listed INLINE names, so a paragraph break is a real
// separator and markup/attributes never enter the stream. The needle is the EXACT dispatched
// payload — `text` for `position:'cursor'`, `text + "\n"` for `position:'end'` — with no escaping at
// all: once markup is parsed away there is nothing left to escape, and a payload holding `&`, `<`, `>`
// or `"` matches by its real characters. (An independent review found the old markup counting
// fail-open: payload `amp` over a baseline holding `&amp;` counted TWO occurrences of "amp" — the
// literal `amp` in the text plus the one inside the decoded entity — so an unrelated `&` added by the
// user moved the count by one and a no-op paste was reported VERIFIED.) The fixture at
// `../fixtures/html-document.js` stands in for that platform boundary here and names its own inline set.
//
// THE FAIL-SAFE DIRECTION OF THE SEPARATOR RULE. The separator is inserted after every element boundary
// EXCEPT the named inline set (`INLINE_TAGS` in the bridge): the failure direction is the safe one. An
// unknown element — or an element that is genuinely inline but unnamed — gets an EXTRA separator, so a
// payload spanning it does NOT match and the insert settles UNCERTAIN (a false negative) instead of a
// false VERIFIED. The unlisted-block white list this replaced did the opposite: an export that rendered
// blocks with an element outside `BLOCK_TAGS` concatenated its neighbours and a no-op paste was reported
// VERIFIED (the reviewer's `<center>` reproduction, pinned below). Text inside RAWTEXT elements
// (`style`, `script`, `title`, `textarea`, `noscript`) is never document text at all: their subtrees are
// skipped whole, so their content cannot move a count (pinned below).
//
// THE CEILING. The HTML read is bounded by `LIMITS.documentHtmlBytes` (256 KiB) and a result above it
// is refused rather than truncated: counting inside a prefix could miss an occurrence or count a
// partial one. The pre-dispatch read is a GATE — without a usable baseline count there is no evidence
// to obtain, so the insert settles its own KNOWN class with NOTHING dispatched and its slot RELEASED;
// the post-paste read is not a gate, so an unusable one settles `APPLY_UNCERTAIN` with the slot HELD
// and no retry.
//
// THE CARET-SCOPE LEGS. `GetSelectedText` and `GetCurrentSentence` are GONE from this path: they can no
// longer produce `effectVerified:true`, and a read that cannot settle success has no business costing a
// native round trip inside the write window. The tests below assert that neither is ever dispatched.
const VERIFIED = { ok: true, data: { sent: true, effectVerified: true } };
const tick = () => new Promise(resolve => setImmediate(resolve));
const inserts = r => r.calls.filter(call => call.name === 'PasteText');
const htmlReads = r => r.calls.filter(call => call.name === 'GetFileHTML');
const caretReads = r => r.calls.filter(call => call.name === 'GetSelectedText' || call.name === 'GetCurrentSentence');
const lastPasteAt = r => { const last = inserts(r).at(-1); return last ? r.calls.indexOf(last) : -1; };
// The pre-dispatch baseline is the last HTML read before the mutation (before the mutation exists at
// all on a rig whose baseline never answered); the post-paste confirmation is the read after it.
const baselineRead = r => {
  const at = lastPasteAt(r);
  const before = at < 0 ? r.calls : r.calls.slice(0, at);
  return before.filter(call => call.name === 'GetFileHTML').at(-1) ?? null;
};
const confirmRead = r => {
  const at = lastPasteAt(r);
  return at < 0 ? null : (r.calls.slice(at + 1).find(call => call.name === 'GetFileHTML') ?? null);
};
// The boundary between the bridge and the parsed document: a real (tiny) parser injected through the
// bridge's `platform` option, exactly as the plugin page injects the platform's own.
function documentBoundaryRig(plugin, options) { return createR7Bridge(plugin, { ...options, platform: platformBoundary }); }
// A fake timer set for the rigs below. Without an injected timer a rig that never settles a ticket — the
// whole point of the uncertain cases — arms the bridge's REAL 5 s deadline as a `setTimeout`, which keeps
// the test process alive until it fires. The deadline is not what these tests assert, so it is held here
// instead of in the process: `advance` delivers it exactly when a test wants to reason about the timeout.
function fakeTimers() {
  let now = 0;
  const tasks = new Map();
  return {
    timers: { schedule(fn, ms) { const id = {}; tasks.set(id, { fn, at: now + ms }); return id; }, clear(id) { tasks.delete(id); } },
    clock: { now: () => now },
    advance(ms) { now += ms; for (const [id, timer] of [...tasks]) if (timer.at <= now) { tasks.delete(id); timer.fn(); } },
    setNow(value) { now = value; }
  };
}
// Minimal escaping for BUILDING a test document that renders a payload as TEXT, so the parsed text
// holds the payload's real characters. It is deliberately not the bridge's rule any more — nothing in
// the bridge escapes — and the tests below prove a genuinely added `"…&"` payload verifies through the
// decoded text without it.
function escapeHtml(text) {
  return text.split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;').split('"').join('&quot;');
}

// A real (tiny) document model whose callbacks the TEST drives, so every dispatch and every answer is
// the test's own decision: `html` is the document's OWN export and `htmlFails` is the optional hook
// that models a read which throws, answers a malformed value or answers above the ceiling (`nth` is 1
// for the pre-dispatch baseline and 2 for the post-paste read). Nothing answers by itself, and the
// retired caret reads are not implemented at all: dispatching one would leave the ticket unanswered and
// fail the test, which is exactly the signal wanted.
function documentRig({ html = '<p>стар</p>', htmlFails = null } = {}) {
  let now = 0;
  const scheduled = new Map();
  const calls = [];
  const plugin = {
    info: { editorType: 'word' },
    executeMethod(name, params, callback) {
      calls.push({ name, params, callback });
      if (name === 'GetFileHTML' && typeof htmlFails === 'function') {
        htmlFails(callback, calls.filter(call => call.name === 'GetFileHTML').length);
      }
      return false;
    },
    callCommand(body, _close, _recalculate, callback) {
      const result = runContext(body);
      if (result.identity) callback(result.value);
      else calls.push({ name: 'presence', callback });
      return false;
    }
  };
  const bridge = documentBoundaryRig(plugin, { editorType: 'word', clock: { now: () => now },
    timers: { schedule(fn, ms) { const id = {}; scheduled.set(id, { fn, at: now + ms }); return id; }, clear(id) { scheduled.delete(id); } } });
  return { bridge, calls, state: { html },
    named: name => calls.filter(call => call.name === name),
    advance(ms) { now += ms; for (const [id, timer] of [...scheduled]) if (timer.at <= now) { scheduled.delete(id); timer.fn(); } },
    setNow(value) { now = value; } };
}

// Drive one insert up to its dispatched paste: the baseline read goes out first and the mutation only
// after that read answered a usable count, which IS the gate. Every assertion here is part of the
// contract, so an implementation that dispatches the paste before — or without — its baseline fails
// here instead of being hidden.
async function dispatchInsert(r, request = { text: 'Абзац' }, baselineHtml = '<p>стар</p>') {
  const from = r.calls.length;
  const pending = r.bridge.insertParagraph(request);
  await tick();
  const reads = () => r.calls.slice(from).filter(call => call.name === 'GetFileHTML');
  const pastes = () => r.calls.slice(from).filter(call => call.name === 'PasteText');
  assert.equal(reads().length, 1, 'the document baseline is dispatched before the mutation');
  assert.equal(pastes().length, 0, 'no mutation is dispatched before its baseline answers');
  reads()[0].callback(baselineHtml);
  assert.equal(pastes().length, 1, 'the insert is dispatched exactly once, after a usable baseline');
  return { pending, insert: pastes()[0] };
}

// A synchronous variant for the reviewer's D-A reproduction, where the answer has to be the fake
// editor's own state rather than the test's decision: `caret` is the caret scope the retired ladder
// read and `caretAfter` a concurrent NON-paste change to it (the user typing, autocorrect, a native
// moving the caret). `PasteText` is either the reviewer's no-op or a paste that really appends the
// escaped payload, and it always calls back `undefined` — the measured live acknowledgement value.
function htmlRig({ html = '<p>стар</p>', caret = 'стар', applies = false, caretAfter = null } = {}) {
  const state = { html, caret };
  const calls = [];
  const timer = fakeTimers();
  const plugin = {
    info: { editorType: 'word' },
    executeMethod(name, params, callback) {
      calls.push({ name, params, callback });
      if (name === 'GetFileHTML') callback(state.html);
      else if (name === 'GetSelectedText' || name === 'GetCurrentSentence') callback(state.caret);
      else if (name === 'PasteText') {
        if (applies) state.html = `${state.html}<p>${escapeHtml(params[0])}</p>`;
        if (caretAfter !== null) state.caret = caretAfter;
        callback(undefined);
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
  const bridge = documentBoundaryRig(plugin, { editorType: 'word', clock: timer.clock, timers: timer.timers });
  return { bridge, calls, state, timer };
}

// The reviewer's D1 reproduction, as a rig: the fake editor's export is fixed BEFORE the paste and
// whatever it holds afterwards is the test's own choice, so the exported markup and the exported text
// can be varied independently. `applies` decides whether the paste really appends the payload as text.
function markupRig({ pre, post = null, applies = false } = {}) {
  const state = { html: pre };
  const calls = [];
  const timer = fakeTimers();
  const plugin = {
    info: { editorType: 'word' },
    executeMethod(name, params, callback) {
      calls.push({ name, params, callback });
      if (name === 'GetFileHTML') callback(state.html);
      else if (name === 'PasteText') {
        if (post !== null) state.html = post;
        else if (applies) state.html = `${state.html}<p>${escapeHtml(params[0])}</p>`;
        callback(undefined);
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
  const bridge = documentBoundaryRig(plugin, { editorType: 'word', clock: timer.clock, timers: timer.timers });
  return { bridge, calls, state, timer, named: name => calls.filter(call => call.name === name) };
}

test('D-A: a no-op PasteText whose caret scope moves onto the payload is never verified', async () => {
  // The reviewer's reproduction: the document does NOT gain the payload, `PasteText` mutates nothing,
  // and something OTHER than the paste moves the caret scope from a different sentence onto exactly
  // the payload. The retired rule read that as "the payload arrived" and settled a verified success
  // for an insert that never happened; a document delta cannot be fooled by it.
  const r = htmlRig({ html: '<p>друг</p>', caret: 'друг', applies: false, caretAfter: 'Абзац' });
  const result = await r.bridge.insertParagraph({ text: 'Абзац' });
  assert.equal(result.ok, false, 'an insert that never reached the document is never a success');
  assert.deepEqual(result, { ok: false, code: 'APPLY_UNCERTAIN' });
  assert.equal(r.bridge.getState().writePending, true, 'the unknown outcome keeps the slot and the write lock');
  assert.equal(r.calls.filter(call => call.name === 'PasteText').length, 1, 'the mutation is dispatched exactly once');
  assert.equal(r.state.html, '<p>друг</p>', 'the fake paste really changed nothing in the document');
});

test('a document that gained exactly one occurrence of the payload confirms the insert', async () => {
  const r = documentRig({ html: '<p>стар</p>' });
  const { pending, insert } = await dispatchInsert(r);
  assert.deepEqual(insert.params, ['Абзац'], 'the dispatched payload is the one the count must find');
  assert.equal(r.bridge.getState().writePending, true, 'the write lock spans the whole confirmation window');
  insert.callback(undefined); // the live 2026.3.1 callback value: no value at all
  assert.equal(r.named('GetFileHTML').length, 2, 'the void acknowledgement starts exactly one confirmation read');
  assert.deepEqual(confirmRead(r).params, {}, 'the same public document read the baseline used');
  assert.ok(Object.isFrozen(confirmRead(r).params));
  confirmRead(r).callback(`${r.state.html}<p>${escapeHtml('Абзац')}</p>`);
  assert.deepEqual(await pending, VERIFIED);
  assert.equal(r.bridge.getState().writePending, false, 'a confirmed effect settles the mutation');
  assert.equal(inserts(r).length, 1, 'the mutation is never retried');
  assert.equal(htmlReads(r).length, 2, 'exactly one baseline and one confirmation read');
  assert.deepEqual(caretReads(r), [], 'no caret-scope read is dispatched by this path');
});

test('a document that gained TWO new occurrences is not confirmation', async () => {
  // Two new occurrences mean the document changed in a way this single paste does not explain. The
  // delta rule is exact in BOTH directions, never "at least one".
  const r = documentRig({ html: '<p>стар</p>' });
  const { pending, insert } = await dispatchInsert(r);
  insert.callback(undefined);
  const escaped = escapeHtml('Абзац');
  confirmRead(r).callback(`${r.state.html}<p>${escaped}</p><p>${escaped}</p>`);
  assert.deepEqual(await pending, { ok: false, code: 'APPLY_UNCERTAIN' });
  assert.equal(r.bridge.getState().writePending, true, 'an unconfirmed mutation stays pending');
  assert.equal(r.bridge.getState().uncertain, true);
  assert.equal(inserts(r).length, 1, 'the mutation is never retried');
});

test('a payload that is absent after the paste is never a success, and a pre-existing count is not one either', async () => {
  // (a) `GetFileHTML` returns the document unchanged: nothing was added, so nothing is confirmed.
  const absent = htmlRig({ html: '<p>стар</p>', caret: 'стар', applies: false });
  assert.deepEqual(await absent.bridge.insertParagraph({ text: 'Абзац' }), { ok: false, code: 'APPLY_UNCERTAIN' });
  assert.equal(absent.calls.filter(call => call.name === 'GetFileHTML').length, 2, 'the read really did happen twice');
  assert.equal(absent.calls.filter(call => call.name === 'PasteText').length, 1);

  // (b) The payload is ALREADY in the document twice and the paste adds nothing: an absolute
  // containment count would have "proved" an effect here; the delta count does not move at all.
  const preexisting = documentRig({ html: '<p>Абзац</p><p>Абзац</p>' });
  const { pending, insert } = await dispatchInsert(preexisting, { text: 'Абзац' }, preexisting.state.html);
  insert.callback(undefined);
  confirmRead(preexisting).callback(preexisting.state.html);
  assert.deepEqual(await pending, { ok: false, code: 'APPLY_UNCERTAIN' },
    'a pre-existing occurrence is not evidence that THIS paste added one');
  assert.equal(preexisting.bridge.getState().writePending, true);

  // (c) The same document PLUS exactly one new occurrence IS one delta, whatever the absolute count.
  const delta = documentRig({ html: '<p>Абзац</p><p>Абзац</p>' });
  const added = await dispatchInsert(delta, { text: 'Абзац' }, delta.state.html);
  added.insert.callback(undefined);
  confirmRead(delta).callback(`${delta.state.html}<p>Абзац</p>`);
  assert.deepEqual(await added.pending, VERIFIED, 'the DELTA is the evidence, not the absolute count');
});

test('D1: the reviewer\'s reproduction — a no-op paste over an unrelated escaped ampersand is never verified', async () => {
  // The independent reproduction, exactly: payload `amp`, baseline export `<p>a &amp; b</p>`, the paste
  // inserts NOTHING, and an unrelated change adds one more escaped ampersand. The old markup count saw
  // TWO literal `amp` substrings in the baseline (`a` + `amp` + `&amp;` + ` b`), read the post export's
  // third `amp` as one new occurrence, and settled a VERIFIED success for an insert that never happened.
  // The decoded-text count reads `a & b` and `a & b` + `c & d` — the needle `amp` never occurs in the
  // TEXT of either — so the delta is zero and the outcome is the uncertain class.
  const r = markupRig({ pre: '<p>a &amp; b</p>', post: '<p>a &amp; b</p><p>c &amp; d</p>' });
  const result = await r.bridge.insertParagraph({ text: 'amp' });
  assert.deepEqual(result, { ok: false, code: 'APPLY_UNCERTAIN' },
    'an insert that never reached the document is never a success, however the markup moved');
  assert.equal(r.named('PasteText').length, 1, 'the mutation is dispatched exactly once');
  assert.equal(r.named('GetFileHTML').length, 2, 'exactly one baseline and one confirmation read');
  assert.equal(r.bridge.getState().writePending, true, 'the unknown outcome keeps the slot and the write lock');
  assert.equal(r.bridge.getState().uncertain, true);
});

test('D1: a payload containing & that the paste really adds once is verified, because entities decode', async () => {
  // The positive half of the same rule: `&` is a real character of the document's TEXT, so a payload
  // holding it verifies when — and only when — the document gained exactly one more occurrence.
  const r = markupRig({ pre: '<p>стар</p>', post: '<p>стар</p><p>a &amp; b</p>' });
  assert.deepEqual(await r.bridge.insertParagraph({ text: 'a & b' }), VERIFIED,
    'the payload matches the decoded text, not the `&amp;` spelling');
  assert.equal(r.named('PasteText').length, 1);
  assert.equal(r.named('GetFileHTML').length, 2);
  assert.equal(r.bridge.getState().writePending, false, 'a confirmed effect settles the mutation');
});

test('D1: markup never counts — a tag name or attribute value added only as markup is never a match', async () => {
  for (const [label, pre, post, text] of [
    ['tag name', '<p>стар</p>', '<p>стар</p><span>новое</span>', 'span'],
    ['attribute value', '<p>стар</p>', '<p>стар</p><p class="amp">новое</p>', 'amp'],
    ['block tag added later', '<p>стар</p>', '<div>новое</div>', 'div']
  ]) {
    const r = markupRig({ pre, post });
    assert.deepEqual(await r.bridge.insertParagraph({ text }), { ok: false, code: 'APPLY_UNCERTAIN' },
      `${label}: markup alone is never a document delta`);
    assert.equal(r.named('PasteText').length, 1, `${label}: the mutation is never retried`);
    assert.equal(r.named('GetFileHTML').length, 2, `${label}: exactly two reads`);
  }
});

test('D1: block boundaries are real boundaries — a payload spanning two paragraphs is never a match', async () => {
  // `01` is the END of one paragraph and the START of the next: the export holds it, the extracted
  // text does not, because the block boundary is a separator. Without the separator the two blocks
  // would concatenate into `...01...` and this no-op paste would be reported VERIFIED.
  const r = markupRig({ pre: '<p>стар</p>', post: '<p>стар</p><p>01</p><p>23</p>' });
  assert.deepEqual(await r.bridge.insertParagraph({ text: '0123' }), { ok: false, code: 'APPLY_UNCERTAIN' },
    'a payload that only exists across a block boundary is not in the document text');
  assert.equal(r.named('PasteText').length, 1);
  assert.equal(r.named('GetFileHTML').length, 2);
});

test('D-A: a no-op paste is never verified because an UNLISTED block element concatenated its neighbours', async () => {
  // The reviewer's reproduction, through the real bridge: the pre-dispatch export is `<p>стар</p>`, the
  // fake paste inserts NOTHING, and the unrelated change turns the post export into
  // `<p>стар</p><center>01</center><center>23</center>`. `center` is not in the retired `BLOCK_TAGS`
  // white list, so the old extraction concatenated `01` and `23` into `0123` and the no-op insert was
  // reported `{"ok":true,"data":{"sent":true,"effectVerified":true}}`. The separator is now inserted
  // after every boundary except the named inline set, so the extracted text is `стар\n01\n23\n`, the
  // payload `0123` is not in it, and the insert settles UNCERTAIN — the false negative this change
  // deliberately accepts instead of a false success.
  const r = markupRig({ pre: '<p>стар</p>', post: '<p>стар</p><center>01</center><center>23</center>' });
  const result = await r.bridge.insertParagraph({ text: '0123' });
  assert.deepEqual(result, { ok: false, code: 'APPLY_UNCERTAIN' },
    'an unlisted element is a boundary, so its neighbours cannot concatenate into the payload');
  assert.equal(r.named('PasteText').length, 1, 'the mutation is dispatched exactly once');
  assert.equal(r.named('GetFileHTML').length, 2, 'exactly one baseline and one confirmation read');
  assert.equal(r.bridge.getState().writePending, true, 'the unknown outcome keeps the slot and the write lock');
  // The same element on the BASELINE side: it is a boundary before the paste too, so the payload really
  // added later once still verifies — the fail-safe direction costs nothing when the payload IS text.
  const applied = markupRig({ pre: '<p>стар</p>', post: '<p>стар</p><center>0123</center>' });
  assert.deepEqual(await applied.bridge.insertParagraph({ text: '0123' }), VERIFIED,
    'a payload that really arrived as its own element text still verifies');
});

test('D-B: text inside a RAWTEXT element is never counted as document text', async () => {
  // `style`, `script`, `title`, `textarea` and `noscript` hold RAWTEXT: it is markup-level content, not
  // document text, so their subtrees are skipped whole. Without the skip the reviewer's no-op was
  // verified: post `<p>стар</p><style>delta</style>` with payload `delta` counted the stylesheet text as
  // a document delta.
  for (const [label, pre, post, payload] of [
    ['style', '<p>стар</p>', '<p>стар</p><style>delta</style>', 'delta'],
    ['script', '<p>стар</p>', '<p>стар</p><script>delta</script>', 'delta'],
    ['title', '<p>стар</p>', '<p>стар</p><title>delta</title>', 'delta'],
    ['textarea', '<p>стар</p>', '<p>стар</p><textarea>delta</textarea>', 'delta'],
    ['noscript', '<p>стар</p>', '<p>стар</p><noscript>delta</noscript>', 'delta']
  ]) {
    const r = markupRig({ pre, post });
    assert.deepEqual(await r.bridge.insertParagraph({ text: payload }), { ok: false, code: 'APPLY_UNCERTAIN' },
      `${label}: rawtext is never document text`);
    assert.equal(r.named('PasteText').length, 1, `${label}: the mutation is never retried`);
    assert.equal(r.named('GetFileHTML').length, 2, `${label}: exactly two reads`);
  }
  // The skip is not a blanket suppression of the element BOUNDARY either: an ordinary payload added
  // next to a rawtext block still verifies, so the skip cannot hide a real insert.
  const r = markupRig({ pre: '<p>стар</p>', post: '<p>стар</p><style>delta</style><p>Абзац</p>' });
  assert.deepEqual(await r.bridge.insertParagraph({ text: 'Абзац' }), VERIFIED,
    'a real insert next to a rawtext block is still confirmed');
});

test('the `end` needle is discriminating: an end payload is never a `trimEnd()`ed delta', async () => {
  // The exporter's `<span>` is inline, so it adds NO boundary of its own and the payload it carries is
  // separated only by the boundary of the block AROUND it. That is exactly what makes the trailing
  // newline of the `end` form (`text + "\n"`) either present in the counted text or absent, and the two
  // halves below pin both cases over the SAME baseline. The baseline export is `<p>стар</p>` (text
  // `стар\n\n`), which holds neither needle.
  //
  // (a) The payload ends its block: `<p>стар</p><span>Абзац</span>` extracts to `стар\nАбзац\n`, the
  // block's own trailing boundary IS the dispatched newline, and the `end` insert VERIFIES. This is the
  // measured shape of the reviewer's export, and it verifies for `end` as well as for `cursor` — the
  // newline is real, not invented.
  const ends = documentRig({ html: '<p>стар</p>' });
  const endsInsert = await dispatchInsert(ends, { text: 'Абзац', position: 'end' });
  assert.deepEqual(endsInsert.insert.params, ['Абзац\n'], 'the end form dispatches the payload with its newline');
  endsInsert.insert.callback(undefined);
  confirmRead(ends).callback('<p>стар</p><span>Абзац</span>');
  assert.deepEqual(await endsInsert.pending, VERIFIED,
    'a block-closing payload really does carry the dispatched newline');
  assert.equal(ends.named('GetFileHTML').length, 2);
  // (b) The DISCRIMINATOR, the same inline-element shape with the payload NOT ending its block:
  // `<p>стар</p><p><span>Абзац</span>хвост</p>` extracts to `стар\nАбзацхвост\n`. The `cursor` needle
  // `Абзац` occurs once more than in the baseline → VERIFIED; the `end` needle `Абзац\n` does not occur
  // at all (`Абзац` is followed by `хвост`, not by a boundary newline) → no delta, UNCERTAIN. A
  // `trimEnd()` of the dispatched payload would count `Абзац`, find that same new occurrence, and report
  // this insert VERIFIED — so this pair is what pins the needle to the EXACT dispatched payload.
  const cursor = documentRig({ html: '<p>стар</p>' });
  const cursorInsert = await dispatchInsert(cursor, { text: 'Абзац', position: 'cursor' });
  cursorInsert.insert.callback(undefined);
  confirmRead(cursor).callback('<p>стар</p><p><span>Абзац</span>хвост</p>');
  assert.deepEqual(await cursorInsert.pending, VERIFIED,
    'the cursor payload is in the export text, so the delta is exactly one');
  assert.equal(cursor.named('GetFileHTML').length, 2);
  const end = documentRig({ html: '<p>стар</p>' });
  const endInsert = await dispatchInsert(end, { text: 'Абзац', position: 'end' });
  endInsert.insert.callback(undefined);
  assert.deepEqual(confirmRead(end).params, {}, 'the same public document read the baseline used');
  confirmRead(end).callback('<p>стар</p><p><span>Абзац</span>хвост</p>');
  assert.deepEqual(await endInsert.pending, { ok: false, code: 'APPLY_UNCERTAIN' },
    'the dispatched newline is not in the counted text, so the end form is never a trimmed cursor form');
  assert.equal(end.named('PasteText').length, 1, 'the mutation is dispatched exactly once');
  assert.equal(end.named('GetFileHTML').length, 2, 'exactly one baseline and one confirmation read');
  assert.equal(end.bridge.getState().writePending, true, 'an unconfirmed end insert stays pending');
});

test('D1: the dispatched payload is the needle — an end insert matches a real paragraph break', async () => {
  // `position:'end'` dispatches `text + "\n"` (the caller's payload is unchanged by this ticket), and
  // with block separators that newline is a real character of the extracted text: when the paste lands
  // as its own block the needle is present exactly once more and the insert IS verified.
  const landed = markupRig({ pre: '<p>стар</p>', post: '<p>стар</p><p>0123</p>' });
  assert.deepEqual(await landed.bridge.insertParagraph({ text: '0123', position: 'end' }), VERIFIED,
    'the newline of the `end` payload is the block separator');
  assert.equal(landed.named('PasteText').length, 1);
  assert.equal(landed.named('GetFileHTML').length, 2);
  // The same characters split by a block boundary: the document holds `01` and `23` in two blocks, so
  // the extracted text is `01\n23\n` and the contiguous `0123\n` the payload dispatched is NOT in it.
  const split = markupRig({ pre: '<p>стар</p>', post: '<p>стар</p><p>01</p><p>23</p>' });
  assert.deepEqual(await split.bridge.insertParagraph({ text: '0123', position: 'end' }), { ok: false, code: 'APPLY_UNCERTAIN' },
    'a payload split by a block boundary is not in the document text');
  assert.equal(split.named('PasteText').length, 1);
  assert.equal(split.named('GetFileHTML').length, 2);
});

test('D1: the decoded text counts every character a payload can hold, with no escaping rule left', async () => {
  for (const [label, payload, plain, escaped] of [
    ['ampersand', 'a & b', '<p>стар</p><p>a &amp; b</p>', 'a &amp; b'],
    ['less-than', 'a < b', '<p>стар</p><p>a &lt; b</p>', 'a &lt; b'],
    ['greater-than', 'a > b', '<p>стар</p><p>a &gt; b</p>', 'a &gt; b'],
    ['double-quote', 'a "b" c', '<p>стар</p><p>a &quot;b&quot; c</p>', 'a &quot;b&quot; c']
  ]) {
    assert.equal(escapeHtml(payload), escaped, `${label}: the test document really spells the character as an entity`);
    const verified = markupRig({ pre: '<p>стар</p>', post: plain });
    assert.deepEqual(await verified.bridge.insertParagraph({ text: payload }), VERIFIED,
      `${label}: the entity decodes to the payload's real character`);
    // The SAME export with the character written RAW is the same text after decoding, so it is the same
    // evidence: the rule matches characters, not their spelling.
    const raw = markupRig({ pre: '<p>стар</p>', post: `<p>стар</p><p>${payload}</p>` });
    assert.deepEqual(await raw.bridge.insertParagraph({ text: payload }), VERIFIED,
      `${label}: the raw spelling decodes to the same character and is equally the payload`);
    // A no-op paste over an export that already holds the payload once is not a delta.
    const noop = markupRig({ pre: plain, post: plain });
    assert.deepEqual(await noop.bridge.insertParagraph({ text: payload }), { ok: false, code: 'APPLY_UNCERTAIN' },
      `${label}: a pre-existing occurrence is not evidence that THIS paste added one`);
  }
});

test('the HTML read is bounded by its own byte ceiling: exactly at it is accepted, one byte over is not', async () => {
  const ceiling = LIMITS.documentHtmlBytes;
  assert.equal(ceiling, 262144, 'the named ceiling for a whole-document read');
  const payload = 'Абзац'; // 10 UTF-8 bytes and no escaped character, so the needle is the payload
  const pad = 'x'.repeat(ceiling - 10);
  const accepted = documentRig({ html: pad });
  const { pending, insert } = await dispatchInsert(accepted, { text: payload }, pad);
  insert.callback(undefined);
  const atCeiling = `${accepted.state.html}${payload}`;
  assert.equal(utf8ByteLength(atCeiling), ceiling, 'the accepted post read is exactly at the ceiling');
  confirmRead(accepted).callback(atCeiling);
  assert.deepEqual(await pending, VERIFIED, 'a result exactly at the ceiling is read whole');

  const over = documentRig({ html: pad });
  const oversized = await dispatchInsert(over, { text: payload }, pad);
  oversized.insert.callback(undefined);
  const overCeiling = `${over.state.html}${payload}y`;
  assert.equal(utf8ByteLength(overCeiling), ceiling + 1, 'one byte over the ceiling');
  confirmRead(over).callback(overCeiling);
  assert.deepEqual(await oversized.pending, { ok: false, code: 'APPLY_UNCERTAIN' },
    'an oversized export is refused, never truncated and counted in a prefix');
  assert.equal(over.bridge.getState().writePending, true, 'the unknown outcome keeps the slot');
});

test('a pre-dispatch HTML read that never answers refuses the insert, releases the slot and dispatches nothing', async () => {
  const r = documentRig();
  const pending = r.bridge.insertParagraph({ text: 'Абзац' });
  await tick();
  assert.equal(r.named('GetFileHTML').length, 1, 'the baseline read owns the ticket first');
  assert.equal(r.bridge.getState().busy, true, 'the baseline phase owns the slot');
  assert.equal(r.bridge.getState().writePending, false, 'a baseline read is not a dispatched mutation');
  r.advance(5000);
  assert.deepEqual(await pending, { ok: false, code: 'TIMEOUT' },
    'an insert that dispatched NOTHING is a known failure, never a false uncertainty');
  assert.equal(r.bridge.getState().busy, false, 'the undispatched ticket releases its slot');
  assert.equal(r.bridge.getState().uncertain, false);
  assert.equal(inserts(r).length, 0, 'nothing reached the editor');
  // The released slot admits the next operation: the bridge is not wedged.
  const next = await dispatchInsert(r, { text: 'Второй' });
  assert.equal(r.named('GetFileHTML').length, 2, 'a later insert runs its own baseline');
  next.insert.callback(true);
  assert.deepEqual(await next.pending, { ok: true, data: { sent: true } });
});

test('a pre-dispatch HTML read that throws, is malformed or is oversized refuses the insert before any dispatch', async () => {
  const oversized = 'x'.repeat(LIMITS.documentHtmlBytes + 1);
  for (const [label, hook, expected] of [
    ['threw', () => { throw new Error('private native detail'); }, 'EDITOR_ERROR'],
    ['malformed', callback => callback(null), 'INVALID_DATA'],
    ['oversized', callback => callback(oversized), 'BYTE_LIMIT']
  ]) {
    const r = documentRig({ htmlFails: (callback, nth) => { if (nth === 1) hook(callback); } });
    const pending = r.bridge.insertParagraph({ text: 'Абзац' });
    await tick();
    const result = await pending;
    assert.equal(result.ok, false, label);
    assert.equal(result.code, expected, label);
    assert.equal(JSON.stringify(result).includes('private native detail'), false, label);
    assert.equal(inserts(r).length, 0, `${label}: no mutation is dispatched without a usable baseline`);
    assert.equal(r.named('GetFileHTML').length, 1, `${label}: exactly one read was attempted`);
    assert.equal(r.bridge.getState().busy, false, `${label}: the slot is released, not wedged`);
    assert.equal(r.bridge.getState().uncertain, false, `${label}: nothing reached the editor`);
  }
});

test('a post-paste HTML read that never answers is uncertain, keeps the slot and never retries', async () => {
  const r = documentRig();
  const { pending, insert } = await dispatchInsert(r);
  insert.callback(undefined);
  assert.equal(r.named('GetFileHTML').length, 2, 'the post-paste read is dispatched');
  r.advance(5000);
  assert.deepEqual(await pending, { ok: false, code: 'APPLY_UNCERTAIN' },
    'a dispatched mutation whose confirmation never arrived is uncertain, never a known timeout');
  assert.equal(r.bridge.getState().writePending, true, 'the unknown outcome keeps the slot and the write lock');
  assert.equal(r.bridge.getState().uncertain, true);
  assert.equal(inserts(r).length, 1, 'the mutation is never retried');
  assert.equal(r.named('GetFileHTML').length, 2, 'and neither is the read');
  assert.deepEqual(await r.bridge.insertParagraph({ text: 'Второй' }), { ok: false, code: 'EDITOR_BUSY' },
    'no second mutation is dispatched over an unknown outcome');
  confirmRead(r).callback(`${r.state.html}<p>Абзац</p>`); // a late answer only frees the owner
  assert.equal(r.bridge.getState().writePending, false);
});

test('a post-paste HTML read that throws, is malformed or is oversized is never a success and never a retry', async () => {
  const oversized = 'x'.repeat(LIMITS.documentHtmlBytes + 1);
  for (const [label, hook] of [
    ['threw', () => { throw new Error('private native detail'); }],
    ['malformed', callback => callback(null)],
    ['oversized', callback => callback(oversized)]
  ]) {
    const r = documentRig({ htmlFails: (callback, nth) => { if (nth === 2) hook(callback); } });
    const { pending, insert } = await dispatchInsert(r);
    insert.callback(undefined);
    const result = await pending;
    assert.deepEqual(result, { ok: false, code: 'APPLY_UNCERTAIN' }, label);
    assert.equal(JSON.stringify(result).includes('private native detail'), false, label);
    assert.equal(inserts(r).length, 1, `${label}: the mutation is never retried`);
    assert.equal(r.named('GetFileHTML').length, 2, `${label}: the read is never retried`);
    assert.equal(r.bridge.getState().writePending, true, `${label}: the unknown outcome keeps the slot`);
  }
});

test('one logical insert dispatches exactly one PasteText and at most two HTML reads', async () => {
  const confirmed = documentRig();
  const { pending, insert } = await dispatchInsert(confirmed);
  insert.callback(undefined);
  confirmRead(confirmed).callback(`${confirmed.state.html}<p>Абзац</p>`);
  assert.deepEqual(await pending, VERIFIED);
  assert.equal(inserts(confirmed).length, 1, 'the mutation is dispatched exactly once');
  assert.equal(htmlReads(confirmed).length, 2, 'exactly one baseline and one confirmation read');
  insert.callback(undefined); // a duplicate acknowledgement must not start a third read
  assert.equal(htmlReads(confirmed).length, 2, 'a duplicate acknowledgement dispatches nothing');

  const acknowledged = documentRig();
  const ack = await dispatchInsert(acknowledged);
  ack.insert.callback(true);
  assert.deepEqual(await ack.pending, { ok: true, data: { sent: true } });
  assert.equal(htmlReads(acknowledged).length, 1, 'a boolean acknowledgement needs no confirmation read');
  assert.equal(inserts(acknowledged).length, 1);
});

test('a boolean acknowledgement keeps the existing unverified envelope and reads nothing after the mutation', async () => {
  // Requirement: the boolean path is unchanged and stays "sent, effect unverified" — its meaning on the
  // target Astra 2026.1.2.1942 build must be re-checked natively, so no marker is invented here. The
  // gate read still runs BEFORE the mutation, because the acknowledgement value is unknown until then.
  for (const value of [true, false]) {
    const r = documentRig();
    const { pending, insert } = await dispatchInsert(r);
    assert.deepEqual(baselineRead(r).params, {}, 'the gate read is the plain public document read');
    assert.ok(Object.isFrozen(baselineRead(r).params));
    insert.callback(value);
    assert.deepEqual(await pending, { ok: true, data: { sent: value } });
    assert.equal(r.named('GetFileHTML').length, 1, 'a boolean acknowledgement dispatches no confirmation read');
    assert.equal(r.bridge.getState().writePending, false);
  }
});

test('D2: a duplicate acknowledgement cannot preempt the in-flight confirmation read', async () => {
  // The guard `if (owned.confirming) return;` had no assertion at all. It closes a real fail-open: a
  // SECOND acknowledgement for the same dispatch, arriving while the confirmation read is already in
  // flight, must not be judged on its own. Without the guard the acknowledged callback settles the
  // ticket the moment the promise executor has run (`owned.settled` becomes true), and the
  // confirmation read's own answer — the test's VERIFIED delta below — is then discarded by the stale
  // guard while the caller has already received "sent, unverified".
  const r = documentRig();
  const { pending, insert } = await dispatchInsert(r);
  insert.callback(undefined); // the void acknowledgement: the confirmation read is now in flight
  assert.equal(r.named('GetFileHTML').length, 2, 'exactly one confirmation read was dispatched');
  assert.equal(r.bridge.getState().writePending, true, 'the mutation is pending while the read is in flight');
  insert.callback(true); // the duplicate carries a value, and must still be ignored
  assert.equal(r.named('GetFileHTML').length, 2, 'the duplicate acknowledgement dispatches no third read');
  assert.equal(r.bridge.getState().writePending, true, 'the duplicate neither settles nor releases the ticket');
  confirmRead(r).callback(`${r.state.html}<p>Абзац</p>`); // exactly one NEW occurrence: the delta
  assert.deepEqual(await pending, VERIFIED,
    'a VERIFIED outcome can only come from the document delta, never from the duplicate acknowledgement');
  assert.equal(r.named('PasteText').length, 1, 'the mutation is never retried');
  assert.equal(r.named('GetFileHTML').length, 2, 'exactly one baseline and one confirmation read');
});

test('a malformed non-boolean acknowledgement takes the document-delta path and is never a success by itself', async () => {
  for (const value of ['true', { acknowledged: true }, null, 7]) {
    const label = JSON.stringify(value) ?? String(value);
    const refused = documentRig();
    const refusal = await dispatchInsert(refused);
    refusal.insert.callback(value);
    assert.equal(refused.named('GetFileHTML').length, 2, `${label}: the malformed value starts the confirmation read`);
    confirmRead(refused).callback(refused.state.html);
    assert.deepEqual(await refusal.pending, { ok: false, code: 'APPLY_UNCERTAIN' }, label);
    // The success below is the DOCUMENT's proof, never the malformed native value's.
    const confirmed = documentRig();
    const confirmation = await dispatchInsert(confirmed);
    confirmation.insert.callback(value);
    confirmRead(confirmed).callback(`${confirmed.state.html}<p>Абзац</p>`);
    assert.deepEqual(await confirmation.pending, VERIFIED, label);
  }
});

test('a void acknowledgement that arrives past the deadline is the uncertain class, never a known timeout', async () => {
  // The callback arrived but the ticket's own timer had not run yet: the payload WAS dispatched, so the
  // only honest class is the uncertain one. No confirmation read is attempted on an expired ticket.
  const r = documentRig();
  const { pending, insert } = await dispatchInsert(r);
  r.setNow(5000);
  insert.callback(undefined);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'APPLY_UNCERTAIN');
  assert.equal(r.named('GetFileHTML').length, 1, 'an expired ticket does not dispatch a confirmation read');
  assert.equal(inserts(r).length, 1, 'and it certainly does not retry the mutation');
});

test('an observation delivered past the ticket deadline is not confirmed', async () => {
  const r = documentRig();
  const { pending, insert } = await dispatchInsert(r);
  insert.callback(undefined);
  r.setNow(5000); // the ticket's own budget is spent before the confirmation read answers
  confirmRead(r).callback(`${r.state.html}<p>Абзац</p>`); // the right string, but the budget is spent
  assert.deepEqual(await pending, { ok: false, code: 'APPLY_UNCERTAIN' });
  assert.equal(inserts(r).length, 1, 'the mutation is never retried');
  assert.equal(r.bridge.getState().writePending, true, 'an expired confirmation leaves the mutation pending');
});

test('the counted needle is the DISPATCHED payload: an end insert carries its own newline', async () => {
  const r = documentRig();
  const { pending, insert } = await dispatchInsert(r, { text: 'Абзац', position: 'end' });
  assert.deepEqual(insert.params, ['Абзац\n'], 'the newline is part of the dispatched payload');
  insert.callback(undefined);
  // The document gained the text as its own block. The extracted text is `Абзац\n` — the block
  // separator IS the newline the `end` form dispatched — so the two agree and the insert is verified.
  // (Under the retired markup rule this read was the ESCAPED payload; with decoded text there is no
  // escaping left, and the newline is a real character of the text either way.)
  confirmRead(r).callback(`${r.state.html}<p>Абзац</p>`);
  assert.deepEqual(await pending, VERIFIED, 'the block separator is the dispatched newline');
  // The needle is the DISPATCHED payload and nothing else. The same document and the same added block,
  // but a `cursor` dispatch carries `Абзац` with NO newline: the extracted text `стар\nАбзац\n` matches
  // it exactly as it matched the `end` form, so this pins that the caller's payload was not changed —
  // both forms are counted as they were dispatched.
  const cursor = documentRig();
  const short = await dispatchInsert(cursor, { text: 'Абзац' });
  assert.deepEqual(short.insert.params, ['Абзац'], 'a cursor dispatch carries no newline');
  short.insert.callback(undefined);
  confirmRead(cursor).callback(`${cursor.state.html}<p>Абзац</p>`);
  assert.deepEqual(await short.pending, VERIFIED,
    'the cursor payload matches the block text it dispatched, with no newline invented for it');
});

test('a duplicate baseline answer cannot dispatch a second paste', async () => {
  // The baseline read is dispatched once per ticket and its answer is judged once: a native that
  // delivers the same callback twice must not open the gate twice.
  const r = documentRig();
  const pending = r.bridge.insertParagraph({ text: 'Абзац' });
  await tick();
  const read = r.named('GetFileHTML')[0];
  assert.equal(r.named('PasteText').length, 0);
  read.callback('<p>стар</p>');
  assert.equal(r.named('PasteText').length, 1, 'the gate opened once');
  read.callback('<p>стар</p>');
  assert.equal(r.named('PasteText').length, 1, 'a duplicate baseline answer dispatches nothing');
  r.named('PasteText')[0].callback(true);
  assert.deepEqual(await pending, { ok: true, data: { sent: true } });
});

test('a baseline exactly at the byte ceiling still opens the gate, and the oversized follow-up is refused', async () => {
  // The ceiling bounds the baseline read as well as the confirmation read, and a result exactly at it is
  // read WHOLE. Here the baseline itself fills the ceiling, so the only honest post-paste export would
  // exceed it: the paste is still dispatched (the gate opened), and the confirmation settles uncertain
  // because an oversized export is never truncated and counted in a prefix.
  const ceiling = LIMITS.documentHtmlBytes;
  const r = documentRig({ html: 'x'.repeat(ceiling) });
  const { pending, insert } = await dispatchInsert(r, { text: 'Абзац' }, 'x'.repeat(ceiling));
  assert.equal(utf8ByteLength(r.state.html), ceiling, 'the accepted baseline is exactly at the ceiling');
  insert.callback(undefined);
  confirmRead(r).callback(`${r.state.html}${'Абзац'}`);
  assert.deepEqual(await pending, { ok: false, code: 'APPLY_UNCERTAIN' },
    'one byte past the ceiling is unusable, never silently truncated');
  assert.equal(inserts(r).length, 1, 'the mutation was still dispatched exactly once');
  assert.equal(r.bridge.getState().writePending, true);
});

// --- D-B: one logical insert dispatches the paste EXACTLY ONCE, structurally ----------------------
// An independent review reproduced a second `PasteText` for ONE logical insert: a read's
// `plugin.executeMethod` called its callback SYNCHRONOUSLY and THEN threw, so the catch re-entered the
// same step, its baseline was dispatched twice, each answer advanced toward the mutation, and the
// mutation was dispatched twice — a violation of design §8.4 and of the owner's "no automatic retry of
// the mutation". The guard that closes it is structural (a once-per-ticket dispatch mark plus the
// idempotent `dispatchPaste`), never an assumption about native callback ordering.
test('a baseline that answers synchronously and then throws still dispatches one baseline and one paste', async () => {
  const calls = [];
  const plugin = {
    info: { editorType: 'word' },
    executeMethod(name, params, callback) {
      calls.push({ name, params, callback });
      if (name === 'PasteText') return false; // the mutation is held for the test to answer
      // The reviewer's shape: the native delivers THIS read's callback synchronously and then throws
      // out of the same call. A second baseline dispatch would be the defect.
      callback('<p>стар</p>');
      throw new Error('private native detail');
    },
    callCommand(body, _close, _recalculate, callback) {
      const result = runContext(body);
      if (result.identity) callback(result.value);
      else calls.push({ name: 'presence', callback });
      return false;
    }
  };
  const bridge = documentBoundaryRig(plugin, { editorType: 'word' });
  const pending = bridge.insertParagraph({ text: 'Абзац' });
  await tick();
  assert.equal(calls.filter(call => call.name === 'GetFileHTML').length, 1, 'the baseline is dispatched exactly once');
  const pastes = calls.filter(call => call.name === 'PasteText');
  assert.equal(pastes.length, 1, 'ONE logical insert dispatches the paste exactly once');
  assert.deepEqual(pastes[0].params, ['Абзац'], 'the single dispatch carries the unchanged payload');
  pastes[0].callback(true);
  const result = await pending;
  assert.deepEqual(result, { ok: true, data: { sent: true } }, 'the single dispatch still settles the ticket');
  assert.equal(JSON.stringify(result).includes('private native detail'), false, 'no native detail escapes');
});

test('a baseline dispatch that throws without answering dispatches nothing at all', async () => {
  // The mirror shape: the read never calls back and throws. Nothing observed the document, so there is
  // no baseline, no evidence and no write — the closed known class and a released slot.
  const calls = [];
  const plugin = {
    info: { editorType: 'word' },
    executeMethod(name, params, callback) {
      calls.push({ name, params, callback });
      if (name === 'GetFileHTML') throw new Error('private native detail');
      return false;
    },
    callCommand(body, _close, _recalculate, callback) {
      const result = runContext(body);
      if (result.identity) callback(result.value);
      return false;
    }
  };
  const bridge = documentBoundaryRig(plugin, { editorType: 'word' });
  const result = await bridge.insertParagraph({ text: 'Абзац' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'EDITOR_ERROR');
  assert.equal(JSON.stringify(result).includes('private native detail'), false);
  assert.equal(calls.filter(call => call.name === 'PasteText').length, 0, 'the paste is never dispatched');
  assert.equal(bridge.getState().busy, false, 'the undispatched ticket releases the slot');
});

// --- D-C: an insert whose paste was NEVER dispatched is a KNOWN outcome, and releases the slot -----
// Nothing reached the mutation, so the honest class is not the uncertain one, and the slot must not
// stay held: a hung baseline used to wedge the bridge permanently (busy with writePending false).
test('an insert aborted before its paste is dispatched releases the slot as the known cancellation', async () => {
  const r = documentRig();
  const controller = new AbortController();
  const pending = r.bridge.insertParagraph({ text: 'Абзац', signal: controller.signal });
  await tick();
  assert.equal(r.bridge.getState().busy, true);
  assert.equal(inserts(r).length, 0);
  controller.abort();
  assert.deepEqual(await pending, { ok: false, code: 'CANCELLED' }, 'nothing was dispatched: a known cancellation');
  assert.equal(r.bridge.getState().busy, false, 'the aborted undispatched ticket releases its slot');
  assert.equal(r.bridge.getState().uncertain, false);
  assert.equal(inserts(r).length, 0, 'an abort that lands before the paste prevents the mutation entirely');
  const next = await dispatchInsert(r, { text: 'Второй' });
  next.insert.callback(true);
  assert.deepEqual(await next.pending, { ok: true, data: { sent: true } });
});

test('an insert whose paste WAS dispatched keeps the uncertain class and the held slot on its deadline', async () => {
  const r = documentRig();
  const { pending } = await dispatchInsert(r);
  assert.equal(inserts(r).length, 1);
  r.advance(5000);
  assert.deepEqual(await pending, { ok: false, code: 'APPLY_UNCERTAIN' }, 'a dispatched paste keeps the uncertain class');
  assert.equal(r.bridge.getState().busy, true, 'the unknown outcome keeps the slot');
  assert.equal(r.bridge.getState().writePending, true);
  assert.equal(r.bridge.getState().uncertain, true);
  assert.deepEqual(await r.bridge.insertParagraph({ text: 'Второй' }), { ok: false, code: 'EDITOR_BUSY' });
  assert.equal(inserts(r).length, 1, 'the mutation is never retried');
});

test('an abort after the paste was dispatched is the uncertain class and keeps the slot', async () => {
  const r = documentRig();
  const controller = new AbortController();
  const { pending } = await dispatchInsert(r, { text: 'Абзац', signal: controller.signal });
  controller.abort();
  assert.deepEqual(await pending, { ok: false, code: 'APPLY_UNCERTAIN' });
  assert.equal(r.bridge.getState().busy, true);
  assert.equal(r.bridge.getState().uncertain, true);
});

test('a hung baseline no longer makes dispose() a no-op that leaves the bridge permanently busy', async () => {
  const r = documentRig();
  const pending = r.bridge.insertParagraph({ text: 'Абзац' });
  await tick();
  assert.equal(inserts(r).length, 0);
  r.bridge.dispose();
  assert.deepEqual(await pending, { ok: false, code: 'CANCELLED' }, 'dispose settles the undispatched ticket');
  assert.equal(r.bridge.getState().busy, false, 'the slot is freed, not wedged behind a settled ticket');
  assert.equal(r.bridge.getState().disposed, true);
  assert.equal(inserts(r).length, 0, 'dispose certainly never dispatches a paste');
});

test('the insert path never dispatches the retired caret-scope reads, even when a paste applies', async () => {
  const r = htmlRig({ html: '<p>стар</p>', caret: 'стар', applies: true });
  assert.deepEqual(await r.bridge.insertParagraph({ text: 'Абзац' }), VERIFIED);
  assert.deepEqual(r.calls.filter(call => call.name === 'GetSelectedText' || call.name === 'GetCurrentSentence'), [],
    'GetSelectedText and GetCurrentSentence can no longer produce a verified effect');
  assert.equal(r.calls.filter(call => call.name === 'GetFileHTML').length, 2, 'the document delta is the only rule');
});
