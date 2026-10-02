import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchCapabilityProbe } from '../../src/plugin/commands.js';
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
  assert.deepEqual(result, { api: true, getDocument: true, getDocumentId: true, replaceTextSmart: true, getRangeBySelect: true, isTrackRevisions: true });
});

test('static probe missing API/methods does not fabricate parity', () => {
  assert.deepEqual(run(undefined), { api: false, getDocument: false, getDocumentId: false, replaceTextSmart: false, getRangeBySelect: false, isTrackRevisions: false });
  assert.deepEqual(run({ GetDocument: () => null }), { api: true, getDocument: true, getDocumentId: false, replaceTextSmart: false, getRangeBySelect: false, isTrackRevisions: false });
});

test('static probe exceptions contain no editor content or raw exception', () => {
  assert.deepEqual(run({ GetDocument() { throw new Error('private document/name/key/url'); } }), { error: 'CAPABILITY_UNAVAILABLE' });
});

test('shipped commands and bridge pass authored static boundary audit', async () => {
  for (const path of ['../../src/plugin/commands.js', '../../src/plugin/bridge.js']) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.deepEqual(auditSource(source), []);
  }
});
