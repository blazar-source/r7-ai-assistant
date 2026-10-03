import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchCapabilityProbe } from '../../src/plugin/commands.js';
import { createR7Bridge } from '../../src/plugin/bridge.js';
import { auditSource } from '../../scripts/static-audit.mjs';
import { readFile } from 'node:fs/promises';

// Invoke only the actual reviewed inline function object, directly. No SDK text execution.
function run(api) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Api');
  let result;
  const plugin = { callCommand(body, close, recalculate, callback) {
    assert.equal(typeof body, 'function'); assert.equal(close, false); assert.equal(recalculate, false);
    globalThis.Api = api;
    try { result = body(); callback(result); }
    finally { if (descriptor) Object.defineProperty(globalThis, 'Api', descriptor); else delete globalThis.Api; }
  } };
  dispatchCapabilityProbe(plugin, value => { result = value; });
  return result;
}

test('static probe observes public method presence only without selecting, reading JSON, IDs, or writing', () => {
  const forbidden = () => { assert.fail('presence probe must not invoke selection/identity/write methods'); };
  const doc = { GetRangeBySelect: forbidden, IsTrackRevisions: forbidden };
  const result = run({ GetDocument: () => doc, GetDocumentId: forbidden, ReplaceTextSmart: forbidden });
  assert.deepEqual(result, [true, true, true, true, true, true]);
});

test('static probe missing API/methods does not fabricate parity', () => {
  assert.deepEqual(run(undefined), [false, false, false, false, false, false]);
  assert.deepEqual(run({ GetDocument: () => null }), [true, true, false, false, false, false]);
  assert.deepEqual(run({ GetDocumentId() {}, ReplaceTextSmart() {} }), [true, false, true, true, false, false]);
});

test('static probe exceptions contain no editor content or raw exception', () => {
  assert.deepEqual(run({ GetDocument() { throw new Error('private document/name/key/url'); } }), ['CAPABILITY_UNAVAILABLE']);
});

// Narrow source-equivalent of the installed Word return validator l(y,t):
// primitives/null, recursive arrays (depth <= 5) and typed arrays pass; plain
// objects do not. This executes no vendor SDK or serialized command source.
function vendorAllows(value, depth = 0) {
  if (depth > 5) return false;
  switch (typeof value) {
    case 'undefined': case 'boolean': case 'number': case 'string': case 'symbol': case 'bigint': return true;
    case 'object':
      if (value === null) return true;
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index++) if (!vendorAllows(value[index], depth + 1)) return false;
        return true;
      }
      return ArrayBuffer.isView(value) && !(value instanceof DataView);
    default: return false;
  }
}

// Regression catches the actual emitted plain-object wire being stripped before
// the bridge callback, not merely a changed command snapshot.
test('actual probe survives native-compatible return filter end-to-end without granting mutation', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'Api');
  const forbidden = () => assert.fail('no identity/selection/write invocation');
  const api = { GetDocument: () => ({ GetRangeBySelect: forbidden }), ReplaceTextSmart: forbidden };
  const plugin = { callCommand(body, close, recalculate, callback) {
    assert.equal(close, false); assert.equal(recalculate, false);
    globalThis.Api = api;
    try { const raw = body(); callback(vendorAllows(raw) ? raw : undefined); }
    finally { if (previous) Object.defineProperty(globalThis, 'Api', previous); else delete globalThis.Api; }
  } };
  assert.equal(vendorAllows({ api: true }), false, 'old ordinary object is stripped');
  assert.equal(vendorAllows(['CAPABILITY_UNAVAILABLE']), true);
  const bridge = createR7Bridge(plugin, { editorType: 'word' });
  const result = await bridge.probeCapabilities();
  assert.deepEqual(result.methodPresence, { api: true, getDocument: true, getDocumentId: false, replaceTextSmart: true, getRangeBySelect: true, isTrackRevisions: false });
  assert.equal(result.runtimeVerified, false); assert.equal(result.mutation.available, false);
  await assert.rejects(bridge.applySelection({ target: null, replacement: 'x' }), { code: 'SELECTION_CHANGED' });
  api.GetDocument = () => { throw Error('private document/name/key/url'); };
  await assert.rejects(bridge.probeCapabilities(), { code: 'CAPABILITY_UNAVAILABLE' });
  assert.equal(bridge.getState().busy, false);
});

test('static probe preserves distinct API/document method positions through native filter', () => {
  const method = () => assert.fail('presence-only method invoked');
  for (let bits = 0; bits < 16; bits++) {
    const id = !!(bits & 1), replace = !!(bits & 2), range = !!(bits & 4), revisions = !!(bits & 8);
    const doc = { GetRangeBySelect: range ? method : null, IsTrackRevisions: revisions ? method : null };
    const actual = run({ GetDocument: () => doc, GetDocumentId: id ? method : null, ReplaceTextSmart: replace ? method : null });
    assert.equal(vendorAllows(actual), true);
    assert.deepEqual(actual, [true, true, id, replace, range, revisions]);
  }
});

test('shipped commands and bridge pass authored static boundary audit', async () => {
  for (const path of ['../../src/plugin/commands.js', '../../src/plugin/bridge.js']) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.deepEqual(auditSource(source), []);
  }
});
