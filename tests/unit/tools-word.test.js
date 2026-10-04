import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWordTools } from '../../src/tools/word.js';
import { createRegistry } from '../../src/tools/registry.js';
import { createR7Bridge } from '../../src/plugin/bridge.js';

function fakeBridge(overrides = {}) {
  const seen = [];
  return { seen, readSelection: async () => ({ text: 'привет', eligible: true, target: 1 }),
    insertParagraph: async (args) => { seen.push(args); return { ok: true, data: { inserted: args.text.length } }; },
    canApply: () => true, ...overrides };
}

test('the representative descriptor set is well formed and policy-correct', () => {
  const tools = createWordTools(fakeBridge());
  const names = tools.map(tool => tool.name).sort();
  assert.deepEqual(names, ['insert_paragraph', 'read_context', 'read_selection', 'replace_selection']);
  assert.equal(tools.find(tool => tool.name === 'insert_paragraph').policy, 'auto');
  assert.equal(tools.find(tool => tool.name === 'replace_selection').policy, 'confirm');
  assert.ok(tools.every(tool => tool.editors.includes('word')));
});

test('read_selection returns bounded data and marks refusals as known errors', async () => {
  const ok = createWordTools(fakeBridge()).find(tool => tool.name === 'read_selection');
  const result = await ok.execute({}, { editor: 'word' });
  assert.equal(result.ok, true);
  const refused = createWordTools(fakeBridge({ readSelection: async () => ({ text: '', eligible: false, target: null }) }))
    .find(tool => tool.name === 'read_selection');
  assert.equal((await refused.execute({}, { editor: 'word' })).code, 'TOOL_ERROR');
});

test('insert_paragraph requires non-empty text and passes it through unchanged', async () => {
  const bridge = fakeBridge();
  const tool = createWordTools(bridge).find(entry => entry.name === 'insert_paragraph');
  assert.equal((await tool.execute({ text: 'Абзац' }, { editor: 'word' })).ok, true);
  assert.deepEqual(bridge.seen, [{ text: 'Абзац' }]);
  assert.equal(tool.schema.required.includes('text'), true);
});

test('read_context refuses an out-of-range or unknown scope as a known error', async () => {
  const tool = createWordTools(fakeBridge()).find(entry => entry.name === 'read_context');
  assert.equal(tool.precondition({ scope: 'paragraph', index: 0 }, { editor: 'word' }), null);
  const bad = tool.precondition({ scope: 'galaxy', index: 0 }, { editor: 'word' });
  assert.equal(bad.code, 'TOOL_ERROR');
  assert.equal(tool.precondition({ scope: 'paragraph', index: 99 }, { editor: 'word' }).code, 'TOOL_ERROR');
});

test('replace_selection never executes from the loop and keeps its confirm policy', () => {
  const tool = createWordTools(fakeBridge()).find(entry => entry.name === 'replace_selection');
  assert.equal(tool.policy, 'confirm');
  assert.equal(typeof tool.execute, 'function');
});

test('registry accepts the word tools and filters them by mode', () => {
  const registry = createRegistry(createWordTools(fakeBridge()));
  const edit = registry.catalogue({ editor: 'word', capabilities: ['document.read', 'document.write'], mode: 'EDIT' });
  const ask = registry.catalogue({ editor: 'word', capabilities: ['document.read', 'document.write'], mode: 'ASK' });
  assert.equal(edit.length, 4);
  assert.deepEqual(ask.map(tool => tool.name), ['read_selection', 'read_context']);
});

// --- Bridge integration: the same owned callback slot the Sprint 1 read/apply paths use. ---
// Fake native surface only; no SDK, DOM or localStorage is imported by src/tools/word.js.

// The native callback of a real SDK call never arrives synchronously, and a test that assumes it
// does would only be asserting its own fixture. Every rig HOLDS its callback until the test releases
// it, so "the slot is still owned" is a fact about the bridge rather than about timing.
//
// The awaited bridge continuation runs on its own microtask chain, so the next dispatch becomes
// observable at the next event-loop checkpoint; the bounded loop below waits for it instead of
// guessing a tick count, and fails loudly when it never happens.
async function untilDispatches(calls, count) {
  for (let attempt = 0; attempt < 50 && calls.length < count; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  return calls.length;
}

function nativeRig({ scopeText = 'текст', methods = { PasteText() {}, GetDocumentStructure() {} } } = {}) {
  const calls = [];
  const plugin = {
    info: { editorType: 'word' },
    ...methods,
    executeMethod(name, params, callback) {
      calls.push({ name, params, callback });
      return false;
    },
    callCommand(body, _close, _recalculate, callback) {
      const previous = Object.getOwnPropertyDescriptor(globalThis, 'Api');
      globalThis.Api = {
        GetDocumentId() { return 'bounded-id'; },
        ReplaceTextSmart() {},
        GetDocument() { return { GetRangeBySelect() {}, IsTrackRevisions() { return false; } }; }
      };
      let value;
      try { value = body(); } finally { if (previous) Object.defineProperty(globalThis, 'Api', previous); else delete globalThis.Api; }
      calls.push({ name: 'presence', params: value, callback });
      return false;
    }
  };
  const bridge = createR7Bridge(plugin, { editorType: 'word', clock: { now: () => 0 },
    timers: { schedule() { return {}; }, clear() {} } });
  // The identity probe reports a bounded document ID with every capability present and tracking off;
  // the SDK callback itself stays held until the test releases it.
  return { bridge, calls, scopeText,
    releaseIdentity() { calls[0].callback(['bounded-id', true, true, false]); } };
}

test('bridge readContext serves a bounded public read through the owned slot', async () => {
  const r = nativeRig();
  const pending = r.bridge.readContext({ scope: 'paragraph', index: 2, maxBytes: 1024 });
  assert.equal(typeof pending.then, 'function');
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].name, 'presence', 'the identity probe owns the slot first');
  assert.equal(r.bridge.getState().busy, true, 'the slot stays owned until the native callback');
  r.releaseIdentity();
  assert.equal(await untilDispatches(r.calls, 2), 2, 'the bounded read is the next dispatch on the same slot');
  const read = r.calls[1];
  assert.equal(read.name, 'GetDocumentStructure');
  assert.deepEqual(read.params, [['paragraph', 2, 1024]]);
  assert.ok(Object.isFrozen(read.params));
  assert.equal(r.bridge.getState().busy, true, 'the read keeps the slot until its own callback');
  read.callback(r.scopeText);
  const result = await pending;
  assert.deepEqual(result, { ok: true, text: r.scopeText });
  assert.ok(Object.isFrozen(result));
  assert.equal(r.bridge.getState().busy, false);
});

test('bridge readContext refuses a byte-oversized native read and never returns a raw error', async () => {
  const r = nativeRig();
  const pending = r.bridge.readContext({ scope: 'section', index: 0, maxBytes: 8 });
  r.releaseIdentity();
  assert.equal(await untilDispatches(r.calls, 2), 2);
  r.calls[1].callback('я'.repeat(8192));
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BYTE_LIMIT');
  assert.equal(JSON.stringify(result).includes('я'), false, 'no native content leaks into a refusal');
  assert.equal(r.bridge.getState().busy, false);
});

test('bridge readContext without the public read method is a classified refusal, never a throw', async () => {
  const r = nativeRig({ methods: { PasteText() {} } });
  const pending = r.bridge.readContext({ scope: 'paragraph', index: 0, maxBytes: 1024 });
  r.releaseIdentity();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CAPABILITY_UNAVAILABLE');
  assert.equal(r.calls.length, 1, 'the absent read method is detected before any read dispatch');
  assert.equal(r.bridge.getState().busy, false);
});

test('bridge readContext refuses a scope or an address it cannot interpret without any SDK work', async () => {
  const r = nativeRig();
  for (const request of [{ scope: 'galaxy', index: 0, maxBytes: 1024 }, { scope: 'paragraph', index: -1, maxBytes: 1024 },
    { scope: 'paragraph', index: 0, maxBytes: 0 }, { scope: 'paragraph' }]) {
    const result = await r.bridge.readContext(request);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'CAPABILITY_UNAVAILABLE');
  }
  assert.equal(r.calls.length, 0, 'an uninterpretable address never reaches the SDK');
});

test('bridge insertParagraph dispatches the public insert once and reports a classified outcome', async () => {
  const r = nativeRig();
  const pending = r.bridge.insertParagraph({ text: 'Абзац', position: 'end' });
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].name, 'presence');
  assert.equal(r.bridge.getState().busy, true);
  assert.equal(r.bridge.getState().writePending, false, 'nothing is confirmed written before dispatch');
  r.releaseIdentity();
  assert.equal(await untilDispatches(r.calls, 2), 2, 'exactly one insert is dispatched');
  const insert = r.calls[1];
  assert.equal(insert.name, 'PasteText');
  assert.deepEqual(insert.params, ['Абзац\n'], 'the end position is expressed as an authored newline');
  assert.ok(Object.isFrozen(insert.params));
  insert.callback(true);
  const result = await pending;
  assert.deepEqual(result, { ok: true, data: { sent: true } });
  assert.equal(r.bridge.getState().busy, false);
});

test('bridge insertParagraph without the public insert method is CAPABILITY_UNAVAILABLE, never a throw', async () => {
  const r = nativeRig({ methods: { GetDocumentStructure() {} } });
  const pending = r.bridge.insertParagraph({ text: 'Абзац' });
  r.releaseIdentity();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CAPABILITY_UNAVAILABLE');
  assert.equal(r.calls.length, 1, 'the absent insert method is detected before any insert dispatch');
  assert.equal(r.bridge.getState().busy, false);
});

test('bridge insertParagraph refuses malformed text or an unknown position without any SDK work', async () => {
  const r = nativeRig();
  for (const request of [{}, { text: '' }, { text: 'a', position: 'after_section' }]) {
    const result = await r.bridge.insertParagraph(request);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'TOOL_ERROR');
  }
  assert.equal(r.calls.length, 0);
});

test('an insert whose native dispatch threw is the uncertain class and keeps its callback slot owned', async () => {
  const calls = [];
  let inserts = 0;
  const plugin = {
    info: { editorType: 'word' },
    PasteText() {},
    GetDocumentStructure() {},
    executeMethod(name, params, callback) {
      calls.push({ name, params, callback });
      // Only the FIRST insert refuses at dispatch; the follow-up below must be able to succeed, so
      // the slot's release is proven by a real second action rather than by reading bridge state.
      if (name === 'PasteText' && inserts++ === 0) throw new Error('private native failure');
      return false;
    },
    callCommand(body, _close, _recalculate, callback) {
      const previous = Object.getOwnPropertyDescriptor(globalThis, 'Api');
      globalThis.Api = { GetDocumentId() { return 'bounded-id'; }, ReplaceTextSmart() {}, GetDocument() { return { GetRangeBySelect() {}, IsTrackRevisions() { return false; } }; } };
      let value;
      try { value = body(); } finally { if (previous) Object.defineProperty(globalThis, 'Api', previous); else delete globalThis.Api; }
      calls.push({ name: 'presence', params: value, callback });
      return false;
    }
  };
  const bridge = createR7Bridge(plugin, { editorType: 'word', clock: { now: () => 0 }, timers: { schedule() { return {}; }, clear() {} } });
  const pending = bridge.insertParagraph({ text: 'Абзац' });
  await untilDispatches(calls, 1);
  calls[0].callback(['bounded-id', true, true, false]);
  const result = await pending;
  assert.equal(result.ok, false, 'a dispatch that threw is never reported as a successful insert');
  assert.equal(result.code, 'APPLY_UNCERTAIN');
  assert.equal(JSON.stringify(result).includes('private native failure'), false);
  assert.deepEqual(calls.map(call => call.name), ['presence', 'PasteText'], 'the throwing insert really was dispatched');
  // A synchronous throw from the SDK is not proof that the command was not delivered: the ticket
  // stays owned (and flagged uncertain) until its matching callback releases it — the same
  // conservatism the existing write path uses.
  assert.equal(bridge.getState().busy, true, 'a synchronous dispatch throw never unlocks the slot');
  assert.equal(bridge.getState().uncertain, true);
  const busyRefusal = await bridge.insertParagraph({ text: 'Второй' });
  assert.deepEqual(busyRefusal, { ok: false, code: 'EDITOR_BUSY' }, 'the owned slot refuses a second action');
  assert.equal(calls.length, 2, 'the refusal dispatches nothing');
  calls[1].callback(true);
  assert.equal(bridge.getState().busy, false, 'the matching callback releases the owned slot');
  // The released slot really is usable again, and a native false acknowledgement is never turned
  // into a success claim, which is the observable the next action depends on.
  const followUp = bridge.insertParagraph({ text: 'Третий' });
  assert.equal(await untilDispatches(calls, 3), 3, 'a later action starts on the released slot');
  calls[2].callback(['bounded-id', true, true, false]);
  assert.equal(await untilDispatches(calls, 4), 4);
  assert.equal(calls[3].name, 'PasteText');
  assert.deepEqual(calls[3].params, ['Третий']);
  calls[3].callback(false);
  assert.deepEqual(await followUp, { ok: true, data: { sent: false } });
  assert.equal(bridge.getState().busy, false);
});

test('insert_paragraph stops the run for an uncertain insert instead of reporting a plain failure', async () => {
  const uncertain = createWordTools(fakeBridge({
    insertParagraph: async () => { const error = new Error('APPLY_UNCERTAIN'); error.name = 'SafeError'; error.code = 'APPLY_UNCERTAIN'; throw error; }
  })).find(entry => entry.name === 'insert_paragraph');
  assert.equal((await uncertain.execute({ text: 'Абзац' }, { editor: 'word' })).code, 'TOOL_UNCERTAIN');
  const unavailable = createWordTools(fakeBridge({ insertParagraph: async () => ({ ok: false, code: 'CAPABILITY_UNAVAILABLE' }) }))
    .find(entry => entry.name === 'insert_paragraph');
  assert.equal((await unavailable.execute({ text: 'Абзац' }, { editor: 'word' })).code, 'CAPABILITY_UNAVAILABLE');
  const throwing = createWordTools(fakeBridge({ insertParagraph: async () => { throw new Error('private native detail'); } }))
    .find(entry => entry.name === 'insert_paragraph');
  const closed = await throwing.execute({ text: 'Абзац' }, { editor: 'word' });
  assert.equal(closed.ok, false);
  assert.equal(typeof closed.code, 'string');
  assert.equal(JSON.stringify(closed).includes('private native detail'), false);
});

test('a word tool refuses a bridge that does not expose the entry point instead of crashing', async () => {
  const tools = createWordTools({ readSelection: async () => ({ text: 'x', eligible: true, target: 1 }) });
  assert.equal((await tools.find(tool => tool.name === 'read_context').execute({ scope: 'paragraph', index: 0 }, { editor: 'word' })).code, 'CAPABILITY_UNAVAILABLE');
  assert.equal((await tools.find(tool => tool.name === 'insert_paragraph').execute({ text: 'Абзац' }, { editor: 'word' })).code, 'CAPABILITY_UNAVAILABLE');
  assert.equal((await createWordTools(null).find(tool => tool.name === 'read_selection').execute({}, { editor: 'word' })).code, 'CAPABILITY_UNAVAILABLE');
});

test('the write path still dispatches the caller replacement unchanged', async () => {
  // The insert handler shares start()'s ticket machinery. Its parameters are passed in a separate
  // slot, and this pins the property that matters: the replacement substance still reaches the SDK
  // verbatim for the pre-existing write caller (during this task a reordered signature silently
  // replaced it with undefined).
  const calls = [];
  const plugin = {
    info: { editorType: 'word' },
    executeMethod(name, params, callback) { calls.push({ name, params, callback }); return false; },
    callCommand(body, _c, _r, callback) { calls.push({ name: 'presence', callback }); return false; }
  };
  const bridge = createR7Bridge(plugin, { editorType: 'word', clock: { now: () => 0 }, timers: { schedule() { return {}; }, clear() {} } });
  const captured = bridge.readSelection();
  await untilDispatches(calls, 1);
  calls[0].callback('исходный');
  await untilDispatches(calls, 2);
  calls[1].callback(['bounded-id', true, true, false]);
  const selection = await captured;
  assert.equal(selection.eligible, true);
  // The write leg is the ordinary selection path, whose own legs must be answered in order:
  // identity, bounded read, identity again, and only then the write.
  const written = bridge.applySelection({ target: selection.target, replacement: 'замена' });
  await untilDispatches(calls, 3);
  calls[2].callback(['bounded-id', true, true, false]);
  await untilDispatches(calls, 4);
  calls[3].callback('исходный');
  await untilDispatches(calls, 5);
  calls[4].callback(['bounded-id', true, true, false]);
  await untilDispatches(calls, 6);
  const write = calls.find(call => call.name === 'ReplaceTextSmart');
  assert.ok(write, `the write was dispatched (calls: ${calls.map(call => call.name).join(',')})`);
  assert.deepEqual(write.params, [['замена'], '\t', '\n']);
  write.callback(true);
  assert.equal((await written).acknowledged, true);
});
