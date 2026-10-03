import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeRig, checkpoint } from '../fixtures/native-sdk.js';
import { createR7Bridge } from '../../src/plugin/bridge.js';

// Break caught: identity result treated as generic JSON/accessed before closed descriptor checks.
test('actual context tuple rejects prototypes, accessors, holes, symbols/extras, deep/oversized and typed-array data without invoking getters', async () => {
  let reads = 0; const getter = () => { reads++; throw Error('private'); };
  const tuple = () => ['id', true, true, false];
  const accessor = tuple(); Object.defineProperty(accessor, '0', { get: getter, enumerable: true });
  const hole = tuple(); delete hole[2];
  const hidden = tuple(); Object.defineProperty(hidden, '1', { enumerable: false });
  const extra = tuple(); Object.defineProperty(extra, 'hidden', { get: getter });
  const symbol = tuple(); symbol[Symbol('extra')] = true;
  const toJSON = tuple(); toJSON.toJSON = getter;
  const inherited = tuple(); delete inherited[0]; Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), { 0: 'id' }));
  const exotic = tuple(); Object.setPrototypeOf(exotic, Object.create(Array.prototype));
  const nil = tuple(); Object.setPrototypeOf(nil, null);
  const nested = tuple(); nested[0] = [[[[[['id']]]]]];
  for (const input of [accessor, hole, hidden, extra, symbol, toJSON, inherited, exotic, nil, nested, new Array(4294967295), new Uint8Array(4), { id: 'id' }, ['id', 1, true, false], ['id', true, 'true', false], ['id', true, true, 'false'], ['id', true, true, false, true]]) {
    const f = nativeRig(); f.state.contextOverride = input;
    await assert.rejects(f.bridge.readSelection(), { code: 'INVALID_DATA' });
    assert.equal(f.bridge.getState().busy, false); assert.equal(f.writes().length, 0); f.close();
  }
  assert.equal(reads, 0);
});
for (const id of [null, undefined, '', NaN, Infinity, {}, 'я'.repeat(1024) + 'a']) test(`invalid or overflowing public ID is refused privately (${typeof id})`, async () => {
  const f = nativeRig(); f.state.id = id;
  await assert.rejects(f.bridge.readSelection()); assert.equal(f.writes().length, 0); assert.equal(f.bridge.getState().busy, false); f.close();
});
for (const id of ['я'.repeat(1024), 0, 1.5]) test(`bounded primitive public ID permits owned token (${typeof id})`, async () => {
  const f = nativeRig(); f.state.id = id; const capture = await f.bridge.readSelection();
  assert.equal(capture.eligible, true); assert.equal(JSON.stringify(capture.target), '{}');
  const result = await f.bridge.applySelection({ target: capture.target, replacement: '' });
  assert.deepEqual(result, { acknowledged: true, effectVerified: false }); assert.equal(f.writes().length, 1);
  await assert.rejects(f.bridge.applySelection({ target: capture.target, replacement: 'retry' }), { code: 'SELECTION_CHANGED' }); assert.equal(f.writes().length, 1); f.close();
});
test('closed unavailable context tuple refuses selection without raw error', async () => {
  const f = nativeRig(); f.state.contextOverride = [null, false, false, null];
  await assert.rejects(f.bridge.readSelection(), { code: 'CAPABILITY_UNAVAILABLE' }); assert.equal(f.bridge.getState().busy, false); f.close();
});
test('current editor info accessors are not invoked to grant write', async () => {
  const f = nativeRig(); const capture = await f.bridge.readSelection(); let reads = 0;
  Object.defineProperty(f.plugin.info, 'editorType', { get() { reads++; return 'word'; } });
  await assert.rejects(f.bridge.applySelection({ target: capture.target, replacement: 'x' }), { code: 'SELECTION_CHANGED' });
  assert.equal(reads, 0); assert.equal(f.writes().length, 0); f.close();
});
test('new target/replacement input must be closed descriptor-safe and bounded before any SDK call', async () => {
  const f = nativeRig(); const capture = await f.bridge.readSelection(); let reads = 0;
  const accessor = { target: capture.target }; Object.defineProperty(accessor, 'replacement', { enumerable: true, get() { reads++; return 'x'; } });
  const exotic = Object.create({ replacement: 'x' }); exotic.target = capture.target;
  const before = f.calls.length;
  for (const input of [accessor, exotic, { target: capture.target, replacement: {}, extra: true }, { target: capture.target, replacement: 'x', id: 'forged' }, { target: capture.target, replacement: 'я'.repeat(4096) + 'x' }]) await assert.rejects(f.bridge.applySelection(input));
  assert.equal(reads, 0); assert.equal(f.calls.length, before); f.close();
});
test('context equality is revalidated again after exact selection read, before write', async () => {
  const f = nativeRig(); const capture = await f.bridge.readSelection(); f.state.auto = false;
  const operation = f.bridge.applySelection({ target: capture.target, replacement: 'x' }); const rejected = assert.rejects(operation, { code: 'SELECTION_CHANGED' });
  f.calls.at(-1).callback(f.calls.at(-1).value); await checkpoint();
  f.state.id = 'other'; f.calls.at(-1).callback('original'); await checkpoint();
  f.calls.at(-1).callback(f.calls.at(-1).value); await rejected; assert.equal(f.writes().length, 0); f.close();
});
test('optional Apply data ignores polluted prototype fields without invoking accessors', async () => {
  const f = nativeRig(); const capture = await f.bridge.readSelection(); let reads = 0;
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'deadline'); let promise;
  Object.defineProperty(Object.prototype, 'deadline', { configurable: true, get() { reads++; throw Error('private'); } });
  try { promise = f.bridge.applySelection({ target: capture.target, replacement: 'x' }).catch(error => error); }
  finally { if (previous) Object.defineProperty(Object.prototype, 'deadline', previous); else delete Object.prototype.deadline; }
  assert.equal(reads, 0); assert.deepEqual(await promise, { acknowledged: true, effectVerified: false }); f.close();
});
test('missing SDK adapter descriptors never consult polluted Object prototype', () => {
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'executeMethod'); let reads = 0; let bridge;
  Object.defineProperty(Object.prototype, 'executeMethod', { configurable: true, get() { reads++; return { value() {} }; } });
  try { bridge = createR7Bridge({ info: { editorType: 'word' } }, { editorType: 'word' }); }
  finally { if (previous) Object.defineProperty(Object.prototype, 'executeMethod', previous); else delete Object.prototype.executeMethod; }
  assert.equal(reads, 0); assert.equal(bridge.getState().busy, false); bridge.dispose();
});

test('synchronous SDK exception during write retains uncertain callback ownership; transport false never retries', async () => {
  const f = nativeRig(); const capture = await f.bridge.readSelection(); f.state.auto = false;
  const operation = f.bridge.applySelection({ target: capture.target, replacement: 'x' }); const rejected = assert.rejects(operation, { code: 'APPLY_UNCERTAIN' });
  for (let step = 0; step < 2; step++) { f.calls.at(-1).callback(f.calls.at(-1).value); await checkpoint(); }
  f.state.throwWrite = true; f.calls.at(-1).callback(f.calls.at(-1).value); await checkpoint(); await rejected;
  assert.equal(f.writes().length, 1); assert.equal(f.bridge.getState().uncertain, true); assert.equal(f.bridge.getState().busy, true);
  await assert.rejects(f.bridge.readSelection(), { code: 'EDITOR_BUSY' }); f.writes()[0].callback(true); assert.equal(f.bridge.getState().busy, false); f.close();
});
