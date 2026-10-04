import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createWordTools } from '../../src/tools/word.js';
import { createRegistry } from '../../src/tools/registry.js';
import { validateArguments } from '../../src/tools/schemas.js';
import { validateBatch, toolResultMessages } from '../../src/agent/protocol.js';
import { runAgent } from '../../src/agent/runtime.js';
import { createR7Bridge } from '../../src/plugin/bridge.js';
import { AGENT_CEILINGS, LIMITS } from '../../src/shared/limits.js';
import { utf8ByteLength } from '../../src/shared/bytes.js';
import { htmlPlatform } from '../fixtures/html-document.js';

// The insert confirmation counts in the document's DECODED TEXT: the platform boundary the plugin page
// supplies is injected here (the fixture stands in for the browser's own DOMParser).
function bridgeWith(plugin, options) { return createR7Bridge(plugin, { ...options, platform: htmlPlatform() }); }

function fakeBridge(overrides = {}) {
  const seen = [];
  return { seen, readSelection: async () => ({ text: 'привет', eligible: true, target: 1 }),
    // The bridge's real document-read envelope: the decoded text and its whole character count.
    readDocumentText: async () => ({ ok: true, text: 'привет', totalChars: 6 }),
    // The bridge's real insert envelope: the native acknowledgement is the only outcome it carries.
    insertParagraph: async (args) => { seen.push(args); return { ok: true, data: { sent: true } }; },
    canApply: () => true, ...overrides };
}

test('the representative descriptor set is well formed and policy-correct', () => {
  const tools = createWordTools(fakeBridge());
  const names = tools.map(tool => tool.name).sort();
  assert.deepEqual(names, ['insert_paragraph', 'read_context', 'read_document_text', 'read_paragraph', 'read_selection', 'replace_selection']);
  assert.equal(tools.find(tool => tool.name === 'insert_paragraph').policy, 'auto');
  assert.equal(tools.find(tool => tool.name === 'replace_selection').policy, 'confirm');
  assert.equal(tools.find(tool => tool.name === 'read_context').policy, 'deny',
    'an unverified public read may be neither offered nor executed');
  assert.ok(tools.every(tool => tool.editors.includes('word')));
});

test('read_context is withheld from every catalogue until a public document read is confirmed', () => {
  const tools = createWordTools(fakeBridge());
  const context = tools.find(entry => entry.name === 'read_context');
  // The switch is one value: the descriptor, its schema, its precondition and its handler stay in
  // place so a confirmed native probe turns read_context back on by changing this policy alone.
  assert.equal(context.policy, 'deny', 'never offered, never executable');
  assert.deepEqual(Object.keys(context).sort(),
    ['editors', 'execute', 'kind', 'name', 'policy', 'precondition', 'requires', 'schema'],
    'the descriptor keeps exactly the eight registry fields');
  assert.equal(typeof context.execute, 'function', 'the handler is kept for the probe-driven switch');
  assert.deepEqual(context.schema.properties.scope.enum, ['paragraph', 'section', 'structure'],
    'the schema is kept intact for the same reason');
  const registry = createRegistry(tools);
  const full = ['document.read', 'document.write'];
  for (const mode of ['EDIT', 'ASK']) {
    const offered = registry.catalogue({ editor: 'word', capabilities: full, mode });
    assert.equal(offered.some(tool => tool.name === 'read_context'), false, `${mode} must not offer read_context`);
  }
  // The registry object's own public descriptor list is a second door to the same withheld native
  // primitive. It is closed as well: `read_context` appears in neither `tools` nor any catalogue, so an
  // iterate-and-dispatch consumer cannot reach the handler the source module still keeps.
  assert.equal(registry.tools.some(tool => tool.name === 'read_context'), false,
    'the published descriptor list must not hand out a withheld tool');
  assert.deepEqual(registry.tools.map(tool => tool.name).sort(),
    ['insert_paragraph', 'read_document_text', 'read_paragraph', 'read_selection', 'replace_selection'],
    'every non-denied Word descriptor is still published');
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
  // Ruling A: read_context is policy 'deny' until a public document read is confirmed, so EDIT offers
  // every confirmed tool and ASK exposes neither a mutation nor the unverified read.
  assert.deepEqual(edit.map(tool => tool.name).sort(),
    ['insert_paragraph', 'read_document_text', 'read_paragraph', 'read_selection', 'replace_selection']);
  assert.deepEqual(ask.map(tool => tool.name), ['read_selection', 'read_document_text', 'read_paragraph']);
});

test('replace_selection advertises the argument ceiling its handler enforces', async () => {
  const tool = createWordTools(fakeBridge()).find(entry => entry.name === 'replace_selection');
  assert.equal(tool.schema.properties.text.maxBytes, AGENT_CEILINGS.argumentsBytes,
    'the per-action argument ceiling the runtime applies');
  assert.equal(AGENT_CEILINGS.argumentsBytes, 8192);
  assert.notEqual(tool.schema.properties.text.maxBytes, AGENT_CEILINGS.resultDataBytes,
    'the result-data ceiling is not the bound a model argument crosses');
  const over = await tool.execute({ text: 'я'.repeat(4097) }, { editor: 'word' });
  assert.equal(over.code, 'BYTE_LIMIT', 'a text above the advertised bound is a known error');
  assert.equal((await tool.execute({ text: 'замена' }, { editor: 'word' })).ok, true);
});

test('insert_paragraph reports the native acknowledgement instead of a plain success', async () => {
  const done = await createWordTools(fakeBridge()).find(entry => entry.name === 'insert_paragraph')
    .execute({ text: 'Абзац' }, { editor: 'word' });
  assert.equal(done.ok, true);
  assert.deepEqual(done.data, { acknowledged: true, bytes: 10 }, 'Абзац is 10 UTF-8 bytes');
  // The bridge's shape is {ok:true, data:{sent:<boolean>}}; an explicit false, an absent flag and a
  // non-boolean are all known errors, never a success claim about an insert the editor did not send.
  for (const data of [{ sent: false }, {}, { sent: 'true' }, null]) {
    const refused = await createWordTools(fakeBridge({ insertParagraph: async () => ({ ok: true, data }) }))
      .find(entry => entry.name === 'insert_paragraph').execute({ text: 'Абзац' }, { editor: 'word' });
    assert.equal(refused.ok, false, JSON.stringify(data));
    assert.equal(refused.code, 'TOOL_ERROR', JSON.stringify(data));
  }
  const noEnvelope = await createWordTools(fakeBridge({ insertParagraph: async () => ({ ok: true }) }))
    .find(entry => entry.name === 'insert_paragraph').execute({ text: 'Абзац' }, { editor: 'word' });
  assert.equal(noEnvelope.code, 'TOOL_ERROR');
});

test('insert_paragraph advertises the argument ceiling its handler enforces', async () => {
  const tool = createWordTools(fakeBridge()).find(entry => entry.name === 'insert_paragraph');
  assert.equal(tool.schema.properties.text.maxBytes, AGENT_CEILINGS.argumentsBytes);
  assert.equal(AGENT_CEILINGS.argumentsBytes, 8192, 'the per-action argument ceiling the runtime applies');
  const bridge = fakeBridge();
  const over = await createWordTools(bridge).find(entry => entry.name === 'insert_paragraph')
    .execute({ text: 'я'.repeat(4097) }, { editor: 'word' });
  assert.equal(over.code, 'BYTE_LIMIT', 'a text above the advertised bound is a known error');
  assert.deepEqual(bridge.seen, [], 'an over-ceiling argument never reaches the bridge');
});

test('insert_paragraph bounds the DISPATCHED payload, so the end position cannot overshoot the ceiling', async () => {
  // Finding 1 (fix round 3): the handler's check measured `args.text` only, while
  // bridge.insertParagraph appends ONE authored newline for `position:'end'` AFTER that check, so a
  // text of exactly argumentsBytes dispatched argumentsBytes+1 bytes. The advertised/enforced bound is
  // ONE value — the per-action argument ceiling — applied to the exact payload that goes out.
  const ceiling = AGENT_CEILINGS.argumentsBytes;
  assert.equal(ceiling, 8192, 'the per-action argument ceiling the runtime applies');
  const bridge = fakeBridge();
  const tool = createWordTools(bridge).find(entry => entry.name === 'insert_paragraph');
  const full = 'a'.repeat(ceiling);
  assert.equal(utf8ByteLength(full), ceiling, 'the fixture is exactly the advertised size');
  // `cursor` dispatches the text itself, so exactly the advertised size fits...
  const cursor = await tool.execute({ text: full, position: 'cursor' }, { editor: 'word' });
  assert.equal(cursor.ok, true, 'cursor dispatches the text itself, so the advertised size fits');
  assert.equal(cursor.data.bytes, ceiling);
  // ...and an omitted position is the bridge's own `cursor` default, never a newline.
  const omitted = await tool.execute({ text: full }, { editor: 'word' });
  assert.equal(omitted.ok, true, 'an omitted position keeps the bridge default (cursor)');
  assert.deepEqual(bridge.seen, [{ text: full, position: 'cursor' }, { text: full }]);
  bridge.seen.length = 0;
  // `end` adds one newline to the dispatched payload, so exactly the advertised size of text cannot
  // fit: it is refused as the same closed class and never reaches the bridge.
  const overshoot = await tool.execute({ text: full, position: 'end' }, { editor: 'word' });
  assert.equal(overshoot.ok, false);
  assert.equal(overshoot.code, 'BYTE_LIMIT', 'the newline makes the dispatched payload exceed the bound');
  assert.deepEqual(bridge.seen, [], 'the newline-overflow insert never reaches the bridge');
  // One byte less is the largest end-position text whose dispatched form still fits the ceiling; the
  // accepted result reports the dispatched byte count, newline included.
  const largest = 'a'.repeat(ceiling - 1);
  const accepted = await tool.execute({ text: largest, position: 'end' }, { editor: 'word' });
  assert.equal(accepted.ok, true, 'the largest end-position text whose dispatched form fits is accepted');
  assert.equal(accepted.data.bytes, ceiling);
  assert.deepEqual(bridge.seen, [{ text: largest, position: 'end' }], 'the bridge still owns the newline');
});

test('read_context requests each scope from its own ceiling', async () => {
  const seen = [];
  const bridge = fakeBridge({ readContext: async (args) => { seen.push(args); return { ok: true, text: 'текст' }; } });
  const tool = createWordTools(bridge).find(entry => entry.name === 'read_context');
  for (const scope of ['paragraph', 'section', 'structure']) {
    assert.equal((await tool.execute({ scope, index: 0 }, { editor: 'word' })).ok, true, scope);
  }
  // Each scope carries its OWN AGENT_CEILINGS entry: no scope is served from another scope's budget,
  // so a future divergence between paragraph/section/structure cannot silently re-map a read.
  assert.deepEqual(seen.map(request => request.maxBytes),
    ['paragraph', 'section', 'structure'].map(scope => AGENT_CEILINGS.contextReadBytes[scope]));
  // The three ceilings are equal today, so no runtime observation can tell a per-scope lookup from an
  // alias of one scope to another. Pin the mapping in the authored source as well: the budget may not
  // be a comparison chain that serves `structure` (or any scope) from another scope's entry.
  const source = await readFile(new URL('../../src/tools/word.js', import.meta.url), 'utf8');
  assert.equal(source.includes("scope === 'structure'"), false, 'structure must not alias another scope');
  assert.equal(source.includes("scope === 'section'"), false, 'section must not alias another scope');
});

test('read_context and insert_paragraph forward the caller signal to the bridge', async () => {
  const seen = [];
  const bridge = fakeBridge({
    readContext: async (args) => { seen.push(args); return { ok: true, text: 'текст' }; },
    insertParagraph: async (args) => { seen.push(args); return { ok: true, data: { sent: true } }; }
  });
  const tools = createWordTools(bridge);
  const controller = new AbortController();
  const ctx = { editor: 'word', signal: controller.signal };
  await tools.find(entry => entry.name === 'read_context').execute({ scope: 'paragraph', index: 0 }, ctx);
  await tools.find(entry => entry.name === 'insert_paragraph').execute({ text: 'Абзац' }, ctx);
  assert.deepEqual(seen.map(request => request.signal), [controller.signal, controller.signal]);
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

// The real plugin facade exposes the editor methods ONLY through its single public dispatch
// channel: `executeMethod(name, params, callback)` queues {methodName, params} to the editor, which
// resolves it to its own `pluginMethod_<name>`. `GetDocumentStructure`/`PasteText` are therefore NOT
// own properties of the facade, and this rig deliberately carries none: only the dispatch channel and
// the command channel exist. `dispatchChannel:false` puts the channel on the prototype: a plain
// `typeof` still sees it, the bridge's ownFunction (OWN data-descriptor) check must not.
function nativeRig({ scopeText = 'текст', dispatchChannel = true } = {}) {
  const calls = [];
  function dispatch(name, params, callback) {
    calls.push({ name, params, callback });
    return false;
  }
  const base = {
    info: { editorType: 'word' },
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
  const plugin = dispatchChannel
    ? { ...base, executeMethod: dispatch }
    : Object.assign(Object.create({ executeMethod: dispatch }), base);
  const bridge = bridgeWith(plugin, { editorType: 'word', clock: { now: () => 0 },
    timers: { schedule() { return {}; }, clear() {} } });
  // The identity probe reports a bounded document ID with every capability present and tracking off;
  // the SDK callback itself stays held until the test releases it.
  return { bridge, plugin, calls, scopeText,
    releaseIdentity() { calls[0].callback(['bounded-id', true, true, false]); },
    // The insert path reads the document's OWN HTML export once BEFORE the paste — the pre-dispatch
    // baseline that gates the mutation — so a test that wants the paste itself must answer that read
    // first. This helper asserts that the gate is the read the ticket reaches first; the mutation
    // follows only once the read answered a usable count.
    releaseBaseline(html = '<p>стар</p>') {
      const reads = calls.filter(call => call.name === 'GetFileHTML');
      assert.equal(reads.length, 1, 'the document baseline is the first read the insert dispatches');
      reads[0].callback(html);
    } };
}

test('bridge readContext serves a bounded public read through the owned slot', async () => {
  const r = nativeRig();
  assert.equal(Object.hasOwn(r.plugin, 'GetDocumentStructure'), false, 'the read is reached by name, not as a facade property');
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

test('bridge readContext decodes a paragraph or section read against the requested budget', async () => {
  // 6000 two-byte characters = 12000 UTF-8 bytes: above LIMITS.selectionBytes (8192) and below the
  // 16384 the paragraph/section descriptors request, so a legitimate read of this size must decode
  // rather than be refused by the selection read's 8 KiB window.
  const payload = 'я'.repeat(6000);
  assert.equal(utf8ByteLength(payload), 12000);
  for (const scope of ['paragraph', 'section']) {
    const r = nativeRig();
    const pending = r.bridge.readContext({ scope, index: 0, maxBytes: AGENT_CEILINGS.contextReadBytes[scope] });
    r.releaseIdentity();
    assert.equal(await untilDispatches(r.calls, 2), 2, scope);
    r.calls[1].callback(payload);
    assert.deepEqual(await pending, { ok: true, text: payload }, `${scope} read above the selection bound`);
    assert.equal(r.bridge.getState().busy, false, scope);
  }
});

test('bridge readContext refuses a payload above the requested budget or the editor-result ceiling', async () => {
  // 16384/20000: above the budget this ticket requested. 131072/70000: the requested budget is
  // larger than the 65536 editor-result ceiling that applies to any native read, so the ceiling
  // still bounds the decode.
  for (const [maxBytes, size] of [[16384, 20000], [131072, 70000]]) {
    const r = nativeRig();
    const pending = r.bridge.readContext({ scope: 'paragraph', index: 0, maxBytes });
    r.releaseIdentity();
    assert.equal(await untilDispatches(r.calls, 2), 2);
    r.calls[1].callback('x'.repeat(size));
    const result = await pending;
    assert.equal(result.ok, false, `maxBytes ${maxBytes} / ${size} bytes`);
    assert.equal(result.code, 'BYTE_LIMIT', `maxBytes ${maxBytes} / ${size} bytes`);
    assert.equal(JSON.stringify(result).includes('x'), false, 'no native content leaks into a refusal');
    assert.equal(r.bridge.getState().busy, false);
  }
});

test('bridge readContext and insertParagraph dispatch when the facade carries only the dispatch channel', async () => {
  // The real facade has no own GetDocumentStructure/PasteText property: the editor method is reached
  // by NAME through executeMethod. A rig without those properties must therefore still dispatch, and
  // a guard that consults a same-named facade property would refuse both legs here.
  const readRig = nativeRig();
  assert.equal(Object.hasOwn(readRig.plugin, 'GetDocumentStructure'), false, 'no same-named facade property');
  const read = readRig.bridge.readContext({ scope: 'paragraph', index: 0, maxBytes: 1024 });
  readRig.releaseIdentity();
  assert.equal(await untilDispatches(readRig.calls, 2), 2, 'the read is dispatched by name');
  assert.equal(readRig.calls[1].name, 'GetDocumentStructure');
  readRig.calls[1].callback('текст');
  assert.deepEqual(await read, { ok: true, text: 'текст' });

  const insertRig = nativeRig();
  assert.equal(Object.hasOwn(insertRig.plugin, 'PasteText'), false, 'no same-named facade property');
  const insert = insertRig.bridge.insertParagraph({ text: 'Абзац' });
  insertRig.releaseIdentity();
  assert.equal(await untilDispatches(insertRig.calls, 2), 2, 'the document baseline is dispatched by name');
  assert.equal(insertRig.calls[1].name, 'GetFileHTML');
  assert.deepEqual(insertRig.calls[1].params, {}, 'the plain public document read every native read uses');
  insertRig.releaseBaseline();
  assert.equal(await untilDispatches(insertRig.calls, 3), 3, 'the insert itself is dispatched by name');
  assert.equal(insertRig.calls[2].name, 'PasteText');
  insertRig.calls[2].callback(true);
  assert.deepEqual(await insert, { ok: true, data: { sent: true } });
});

test('bridge readContext and insertParagraph refuse a dispatch channel that is not an own data descriptor', async () => {
  // Same primitive as every other adapter leg: ownFunction inspects OWN data descriptors, so an
  // executeMethod a plain `typeof` sees through the prototype is not a capability the bridge owns.
  for (const kind of ['read', 'insert']) {
    const r = nativeRig({ dispatchChannel: false });
    assert.equal(typeof r.plugin.executeMethod, 'function', 'a plain typeof would accept the inherited method');
    const pending = kind === 'read'
      ? r.bridge.readContext({ scope: 'paragraph', index: 0, maxBytes: 1024 })
      : r.bridge.insertParagraph({ text: 'Абзац' });
    r.releaseIdentity();
    const result = await pending;
    assert.equal(result.ok, false, kind);
    assert.equal(result.code, 'CAPABILITY_UNAVAILABLE', kind);
    assert.deepEqual(r.calls.map(call => call.name), ['presence'], `${kind}: nothing is dispatched by name`);
    assert.equal(r.bridge.getState().busy, false, kind);
  }
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
  assert.equal(Object.hasOwn(r.plugin, 'PasteText'), false, 'the insert is reached by name, not as a facade property');
  const pending = r.bridge.insertParagraph({ text: 'Абзац', position: 'end' });
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].name, 'presence');
  assert.equal(r.bridge.getState().busy, true);
  assert.equal(r.bridge.getState().writePending, false, 'nothing is confirmed written before dispatch');
  r.releaseIdentity();
  assert.equal(await untilDispatches(r.calls, 2), 2, 'the document baseline is dispatched before the mutation');
  assert.equal(r.calls[1].name, 'GetFileHTML', 'the pre-dispatch baseline of the document delta');
  assert.equal(r.bridge.getState().writePending, false, 'a baseline read is not a dispatched mutation');
  r.releaseBaseline();
  assert.equal(await untilDispatches(r.calls, 3), 3, 'exactly one insert is dispatched, after its baseline');
  const insert = r.calls[2];
  assert.equal(insert.name, 'PasteText');
  assert.deepEqual(insert.params, ['Абзац\n'], 'the end position is expressed as an authored newline');
  assert.ok(Object.isFrozen(insert.params));
  insert.callback(true);
  const result = await pending;
  assert.deepEqual(result, { ok: true, data: { sent: true } });
  assert.equal(r.bridge.getState().busy, false);
});

test('the handler and the real bridge agree on one ceiling for the dispatched insert', async () => {
  // Finding 1 (fix round 3) pins the handler's own measure against the bridge's real transformation:
  // the handler counts the newline from its own rule, the bridge appends the newline it owns, and the
  // payload that actually crosses must still be exactly inside the advertised bound.
  const r = nativeRig();
  const tool = createWordTools(r.bridge).find(entry => entry.name === 'insert_paragraph');
  const largest = 'a'.repeat(AGENT_CEILINGS.argumentsBytes - 1);
  const pending = tool.execute({ text: largest, position: 'end' }, { editor: 'word' });
  r.releaseIdentity();
  assert.equal(await untilDispatches(r.calls, 2), 2, 'the document baseline is dispatched first');
  assert.equal(r.calls[1].name, 'GetFileHTML');
  r.releaseBaseline();
  assert.equal(await untilDispatches(r.calls, 3), 3, 'the accepted insert is dispatched');
  assert.equal(r.calls[2].name, 'PasteText');
  const dispatched = r.calls[2].params[0];
  assert.equal(utf8ByteLength(dispatched), AGENT_CEILINGS.argumentsBytes,
    'the dispatched payload fills the advertised ceiling exactly, never past it');
  assert.equal(dispatched.endsWith('\n'), true, 'the newline the handler counted is the one the bridge appends');
  r.calls[2].callback(true);
  assert.equal((await pending).ok, true);
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

test('bridge readContext and insertParagraph refuse a pre-aborted signal without any dispatch', async () => {
  const r = nativeRig();
  const controller = new AbortController();
  controller.abort();
  const read = await r.bridge.readContext({ scope: 'paragraph', index: 0, maxBytes: 1024, signal: controller.signal });
  assert.deepEqual(read, { ok: false, code: 'CANCELLED' });
  const insert = await r.bridge.insertParagraph({ text: 'Абзац', signal: controller.signal });
  assert.deepEqual(insert, { ok: false, code: 'CANCELLED' });
  assert.equal(r.calls.length, 0, 'a pre-aborted ticket never reaches the SDK');
  assert.equal(r.bridge.getState().busy, false);
});

test('an abort after the read was dispatched invalidates the caller and leaves the slot owned', async () => {
  const r = nativeRig();
  const controller = new AbortController();
  const pending = r.bridge.readContext({ scope: 'paragraph', index: 0, maxBytes: 1024, signal: controller.signal });
  r.releaseIdentity();
  assert.equal(await untilDispatches(r.calls, 2), 2, 'the read is dispatched before the abort');
  controller.abort();
  assert.deepEqual(await pending, { ok: false, code: 'CANCELLED' });
  // Queued SDK work is not retractable: it keeps the slot (and the uncertain flag) until its own
  // callback releases it, exactly like a cancelled selection read.
  assert.equal(r.bridge.getState().busy, true);
  assert.equal(r.bridge.getState().uncertain, true);
  r.calls[1].callback('поздний');
  assert.equal(r.bridge.getState().busy, false);
});

test('an abort during the baseline phase cancels before any paste, and one after the dispatch is uncertain', async () => {
  // (a) The baseline read is still BEFORE the irreversible boundary: an abort while it is outstanding
  // prevents the mutation entirely, so the honest class is the cancellation, not the "may have applied"
  // one.
  const early = nativeRig();
  const earlyController = new AbortController();
  const earlyPending = early.bridge.insertParagraph({ text: 'Абзац', signal: earlyController.signal });
  early.releaseIdentity();
  assert.equal(await untilDispatches(early.calls, 2), 2, 'the document baseline is the only dispatch so far');
  assert.equal(early.calls[1].name, 'GetFileHTML');
  earlyController.abort();
  assert.deepEqual(await earlyPending, { ok: false, code: 'CANCELLED' });
  assert.equal(early.calls.filter(call => call.name === 'PasteText').length, 0,
    'an abort before the paste dispatches no mutation at all');

  // (b) Once the paste has been dispatched the abort cannot retract it: the uncertain class, with the
  // slot and the uncertain flag held until the mutation's own callback.
  const r = nativeRig();
  const controller = new AbortController();
  const pending = r.bridge.insertParagraph({ text: 'Абзац', signal: controller.signal });
  r.releaseIdentity();
  assert.equal(await untilDispatches(r.calls, 2), 2, 'the document baseline is the next dispatch');
  r.releaseBaseline();
  assert.equal(await untilDispatches(r.calls, 3), 3, 'the insert is dispatched before the abort');
  assert.equal(r.calls[2].name, 'PasteText');
  controller.abort();
  assert.deepEqual(await pending, { ok: false, code: 'APPLY_UNCERTAIN' });
  // A dispatched write whose acknowledgement never arrived may have applied: it keeps the slot and
  // the uncertain flag until its own callback, never a success claim.
  assert.equal(r.bridge.getState().busy, true);
  assert.equal(r.bridge.getState().uncertain, true);
  r.calls[2].callback(true);
  assert.equal(r.bridge.getState().busy, false);
});

test('an insert whose native dispatch threw is the uncertain class and keeps its callback slot owned', async () => {
  const calls = [];
  let inserts = 0;
  const plugin = {
    info: { editorType: 'word' },
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
  const bridge = bridgeWith(plugin, { editorType: 'word', clock: { now: () => 0 }, timers: { schedule() { return {}; }, clear() {} } });
  const pending = bridge.insertParagraph({ text: 'Абзац' });
  await untilDispatches(calls, 1);
  calls[0].callback(['bounded-id', true, true, false]);
  assert.equal(await untilDispatches(calls, 2), 2, 'the document baseline is dispatched first');
  assert.equal(calls[1].name, 'GetFileHTML');
  calls[1].callback('<p>стар</p>'); // the gate opens: the mutation is dispatched and throws
  const result = await pending;
  assert.equal(result.ok, false, 'a dispatch that threw is never reported as a successful insert');
  assert.equal(result.code, 'APPLY_UNCERTAIN');
  assert.equal(JSON.stringify(result).includes('private native failure'), false);
  assert.deepEqual(calls.map(call => call.name),
    ['presence', 'GetFileHTML', 'PasteText'], 'the throwing insert really was dispatched');
  // A synchronous throw from the SDK is not proof that the command was not delivered: the ticket
  // stays owned (and flagged uncertain) until its matching callback releases it — the same
  // conservatism the existing write path uses.
  assert.equal(bridge.getState().busy, true, 'a synchronous dispatch throw never unlocks the slot');
  assert.equal(bridge.getState().uncertain, true);
  const busyRefusal = await bridge.insertParagraph({ text: 'Второй' });
  assert.deepEqual(busyRefusal, { ok: false, code: 'EDITOR_BUSY' }, 'the owned slot refuses a second action');
  assert.equal(calls.length, 3, 'the refusal dispatches nothing');
  calls[2].callback(true);
  assert.equal(bridge.getState().busy, false, 'the matching callback releases the owned slot');
  // The released slot really is usable again, and a native false acknowledgement is never turned
  // into a success claim, which is the observable the next action depends on.
  const followUp = bridge.insertParagraph({ text: 'Третий' });
  assert.equal(await untilDispatches(calls, 4), 4, 'a later action starts on the released slot');
  calls[3].callback(['bounded-id', true, true, false]);
  assert.equal(await untilDispatches(calls, 5), 5, 'the follow-up reads its own document baseline');
  assert.equal(calls[4].name, 'GetFileHTML');
  calls[4].callback('<p>стар</p>');
  assert.equal(await untilDispatches(calls, 6), 6);
  assert.equal(calls[5].name, 'PasteText');
  assert.deepEqual(calls[5].params, ['Третий']);
  calls[5].callback(false);
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

// The bridge does NOT throw its uncertain class: `insertParagraph` catches its own ticket settlement
// and RETURNS `{ok:false, code:'APPLY_UNCERTAIN'}` (src/plugin/bridge.js, pinned by
// tests/unit/bridge.test.js and tests/unit/tools-word.test.js above). The handler therefore meets the
// uncertain mutation class on BOTH legs — a throw and a returned envelope — and must classify them
// identically, or a genuinely unknown mutation outcome falls through as an ordinary known error and
// the run keeps going as if nothing uncertain had happened.
test('insert_paragraph classifies a RETURNED uncertain insert exactly like a thrown one', async () => {
  const returned = createWordTools(fakeBridge({ insertParagraph: async () => ({ ok: false, code: 'APPLY_UNCERTAIN' }) }))
    .find(entry => entry.name === 'insert_paragraph');
  const result = await returned.execute({ text: 'Абзац' }, { editor: 'word' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TOOL_UNCERTAIN', 'the returned uncertain class is the runtime-stopping class');
  // The authored caption is a UI concern; the descriptor publishes the closed class only, never a raw
  // bridge code or a raw exception text.
  assert.equal(result.message, 'отказ');
  assert.equal(JSON.stringify(result).includes('APPLY_UNCERTAIN'), false);
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
  const bridge = bridgeWith(plugin, { editorType: 'word', clock: { now: () => 0 }, timers: { schedule() { return {}; }, clear() {} } });
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

// --- Sprint 3: the void `PasteText` acknowledgement proven on the live 2026.3.1 editor -------------
// The native callback carries no value, so the bridge holds its ticket and asks the DOCUMENT itself: it
// counts the dispatched payload in the document's own `GetFileHTML` export ONCE BEFORE the paste (the
// pre-dispatch baseline, by construction) and ONCE AFTER it, and reports the effect verified only when
// the post count is exactly `baselineCount + 1`. The handler republishes that proof instead of dropping
// it, and republishes nothing when it is absent. The caret-scope reads the old rule used are gone.

test('the real bridge confirms a void acknowledgement by a document delta and the handler republishes it', async () => {
  const r = nativeRig();
  const tool = createWordTools(r.bridge).find(entry => entry.name === 'insert_paragraph');
  const pending = tool.execute({ text: 'Абзац', position: 'end' }, { editor: 'word' });
  r.releaseIdentity();
  assert.equal(await untilDispatches(r.calls, 2), 2, 'the document baseline is dispatched first');
  assert.equal(r.calls[1].name, 'GetFileHTML');
  r.releaseBaseline('<p>стар</p>'); // the pre-dispatch count of the payload is 0
  assert.equal(await untilDispatches(r.calls, 3), 3, 'exactly one insert is dispatched, after its baseline');
  const insert = r.calls[2];
  assert.equal(insert.name, 'PasteText');
  assert.deepEqual(insert.params, ['Абзац\n']);
  assert.equal(r.bridge.getState().writePending, true);
  insert.callback(undefined);
  assert.equal(await untilDispatches(r.calls, 4), 4, 'one confirmation read follows the dispatched insert');
  const read = r.calls[3];
  assert.equal(read.name, 'GetFileHTML');
  assert.deepEqual(read.params, {}, 'the confirmation read is the plain public document read');
  assert.ok(Object.isFrozen(read.params));
  assert.equal(r.bridge.getState().writePending, true, 'the confirmation window keeps the write lock');
  read.callback('<p>стар</p><p>Абзац\n</p>'); // exactly one NEW occurrence of the dispatched payload
  const result = await pending;
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { acknowledged: true, bytes: 11, effectVerified: true },
    'the newline is part of the counted payload, and the proof crosses to the run');
  assert.equal(r.bridge.getState().writePending, false);
  assert.equal(r.calls.filter(call => call.name === 'PasteText').length, 1, 'the mutation is never retried');
  assert.equal(r.calls.filter(call => call.name === 'GetFileHTML').length, 2, 'one baseline, one confirmation read');
  assert.equal(r.calls.some(call => call.name === 'GetSelectedText' || call.name === 'GetCurrentSentence'), false,
    'the retired caret-scope reads are never dispatched');
});

test('the handler publishes the effect the bridge proved and never invents one', async () => {
  const verified = await createWordTools(fakeBridge({ insertParagraph: async () => ({ ok: true, data: { sent: true, effectVerified: true } }) }))
    .find(entry => entry.name === 'insert_paragraph').execute({ text: 'Абзац' }, { editor: 'word' });
  assert.equal(verified.ok, true);
  assert.deepEqual(verified.data, { acknowledged: true, bytes: 10, effectVerified: true });
  // A boolean acknowledgement keeps the existing unverified shape exactly: no marker is invented for
  // an effect nobody proved (that path must be re-checked on the target build).
  const unverified = await createWordTools(fakeBridge()).find(entry => entry.name === 'insert_paragraph')
    .execute({ text: 'Абзац' }, { editor: 'word' });
  assert.deepEqual(unverified.data, { acknowledged: true, bytes: 10 });
  // The marker alone is never a success: the literal `sent === true` is still required.
  const forged = await createWordTools(fakeBridge({ insertParagraph: async () => ({ ok: true, data: { sent: false, effectVerified: true } }) }))
    .find(entry => entry.name === 'insert_paragraph').execute({ text: 'Абзац' }, { editor: 'word' });
  assert.equal(forged.ok, false);
  assert.equal(forged.code, 'TOOL_ERROR');
});

test('a void acknowledgement the document does not confirm is TOOL_UNCERTAIN and never a plain failure', async () => {
  const r = nativeRig();
  const tool = createWordTools(r.bridge).find(entry => entry.name === 'insert_paragraph');
  const pending = tool.execute({ text: 'Абзац' }, { editor: 'word' });
  r.releaseIdentity();
  assert.equal(await untilDispatches(r.calls, 2), 2, 'the document baseline is dispatched first');
  r.releaseBaseline('<p>стар</p>');
  assert.equal(await untilDispatches(r.calls, 3), 3, 'the insert follows its baseline');
  assert.equal(r.calls[2].name, 'PasteText');
  r.calls[2].callback(undefined);
  assert.equal(await untilDispatches(r.calls, 4), 4, 'the confirmation read follows the void acknowledgement');
  assert.equal(r.calls[3].name, 'GetFileHTML');
  r.calls[3].callback('<p>стар</p>'); // the document did not change: no delta, no confirmation
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TOOL_UNCERTAIN', 'the runtime-stopping uncertain class, not a known error');
  assert.equal(result.message, 'отказ');
  assert.equal(JSON.stringify(result).includes('APPLY_UNCERTAIN'), false);
  assert.equal(r.calls.filter(call => call.name === 'PasteText').length, 1,
    'an insert whose effect is unproven is never retried automatically');
  assert.equal(r.bridge.getState().writePending, true, 'an unconfirmed mutation is never released as settled');
  assert.equal(r.calls.some(call => call.name === 'GetSelectedText' || call.name === 'GetCurrentSentence'), false,
    'the retired caret-scope reads are never dispatched');
});

test('a document baseline above the ceiling is the closed BYTE_LIMIT class and dispatches no write', async () => {
  // The ceiling is an engineering limit, not a native failure: an export above it is refused (never
  // truncated and counted in a prefix) and the handler republishes that closed class unchanged.
  const r = nativeRig();
  const tool = createWordTools(r.bridge).find(entry => entry.name === 'insert_paragraph');
  const pending = tool.execute({ text: 'Абзац' }, { editor: 'word' });
  r.releaseIdentity();
  assert.equal(await untilDispatches(r.calls, 2), 2, 'the document baseline is dispatched first');
  assert.equal(r.calls[1].name, 'GetFileHTML');
  r.calls[1].callback('x'.repeat(LIMITS.documentHtmlBytes + 1));
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BYTE_LIMIT', 'the closed byte-limit class, never the uncertain one');
  assert.equal(result.message, 'отказ');
  assert.equal(r.calls.filter(call => call.name === 'PasteText').length, 0, 'no write is dispatched');
  assert.equal(r.bridge.getState().busy, false, 'the slot is released');
});

test('a proof through an escaped payload crosses to the run unchanged', async () => {
  // The payload contains every character the document HTML escapes, so the counting form is the
  // escaped one: the tool republishes the proof only because the DOCUMENT gained that escaped form once.
  const r = nativeRig();
  const tool = createWordTools(r.bridge).find(entry => entry.name === 'insert_paragraph');
  const payload = 'Он сказал "да" <и> & всё';
  const pending = tool.execute({ text: payload }, { editor: 'word' });
  r.releaseIdentity();
  assert.equal(await untilDispatches(r.calls, 2), 2, 'the document baseline is dispatched first');
  r.releaseBaseline('<p>стар</p>');
  assert.equal(await untilDispatches(r.calls, 3), 3, 'the insert follows its baseline');
  assert.equal(r.calls[2].name, 'PasteText');
  assert.deepEqual(r.calls[2].params, [payload], 'the payload crosses verbatim, unescaped');
  r.calls[2].callback(undefined);
  assert.equal(await untilDispatches(r.calls, 4), 4, 'the confirmation read follows the void acknowledgement');
  const escaped = payload.split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;').split('"').join('&quot;');
  r.calls[3].callback(`<p>стар</p><p>${escaped}</p>`);
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.data.effectVerified, true, 'the escaped-form delta is the proof the handler republishes');
  assert.equal(result.data.acknowledged, true);
  assert.equal(r.calls.filter(call => call.name === 'PasteText').length, 1);
});

test('a document baseline that cannot be read refuses the insert and dispatches no write at all', async () => {
  // The pre-dispatch read is the gate: without a usable baseline count there is no evidence to obtain,
  // so the mutation is never dispatched, the ticket settles its own KNOWN class and the slot is freed.
  const r = nativeRig();
  const tool = createWordTools(r.bridge).find(entry => entry.name === 'insert_paragraph');
  const pending = tool.execute({ text: 'Абзац' }, { editor: 'word' });
  r.releaseIdentity();
  assert.equal(await untilDispatches(r.calls, 2), 2, 'the document baseline is dispatched first');
  assert.equal(r.calls[1].name, 'GetFileHTML');
  r.calls[1].callback(null); // a malformed native answer leaves the baseline unusable
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_DATA', 'a closed known class, never the uncertain one');
  assert.equal(result.message, 'отказ');
  assert.equal(r.calls.filter(call => call.name === 'PasteText').length, 0,
    'a write is never dispatched without a usable baseline');
  assert.equal(r.bridge.getState().busy, false, 'the undispatched ticket releases the slot, not a wedge');
  assert.equal(r.bridge.getState().uncertain, false, 'nothing reached the editor');
});

// --- Sprint 3, tool 1: `read_document_text` — the bounded, chunked document read -------------------
// The mechanism is the ONE already measured on both builds and already used by the insert
// confirmation: the public `GetFileHTML` export, decoded by the bridge's own helper. The tool slices
// ONE bounded chunk out of that text. It adds no editor call, no new capability, no write path and no
// model/transport call of its own — nothing here sends the whole document anywhere.
const DOCUMENT = 'Первый абзац.\nВторой абзац.\nТретий абзац.';
// A bridge that records every request the tool makes, so "the refusal never reached the bridge" and
// "exactly one read, no write method" are observations rather than assumptions.
function documentBridge(text, extras = {}) {
  const requests = [];
  return { requests, readDocumentText: async (request) => { requests.push(request); return { ok: true, text, totalChars: text.length }; }, ...extras };
}
function readDocument(bridge) { return createWordTools(bridge).find(entry => entry.name === 'read_document_text'); }

test('read_document_text advertises the closed bounded schema the contract names', () => {
  const tool = readDocument(documentBridge(DOCUMENT));
  assert.equal(tool.kind, 'read');
  assert.equal(tool.policy, 'auto');
  assert.deepEqual(tool.editors, ['word']);
  assert.deepEqual(tool.requires, ['document.read']);
  assert.equal(tool.schema.type, 'object');
  assert.equal(tool.schema.additionalProperties, false);
  assert.deepEqual(tool.schema.required, []);
  assert.deepEqual(Object.keys(tool.schema.properties).sort(), ['maxChars', 'offset']);
  assert.equal(tool.schema.properties.offset.minimum, 0);
  assert.equal(tool.schema.properties.offset.maximum, LIMITS.readDocumentOffsetMax);
  assert.equal(tool.schema.properties.maxChars.minimum, 1);
  assert.equal(tool.schema.properties.maxChars.maximum, LIMITS.readDocumentMaxChars);
  // The bound is the SERIALIZED tool-result entry, not the raw text: the runtime refuses an entry whose
  // JSON exceeds `AGENT_CEILINGS.toolResultBytes` (16384), NOT `LIMITS.editorResultBytes` (65536), and
  // substitutes the literal refusal "the tool result could not be serialized". A Cyrillic character is
  // TWO UTF-8 bytes, and `readDocumentEntryBytes` is the envelope the entry's own serialization adds
  // on top of the encoded text, so the largest advertised chunk plus that envelope must fit:
  //   8000 * 2 + readDocumentEntryBytes = 16000 + 130 = 16130 <= 16384.
  assert.equal(LIMITS.readDocumentMaxChars, 8000, 'the largest advertised chunk that always fits');
  assert.equal(LIMITS.readDocumentEntryBytes, 130, 'the measured serialization envelope');
  assert.ok(LIMITS.readDocumentMaxChars * 2 + LIMITS.readDocumentEntryBytes <= AGENT_CEILINGS.toolResultBytes);
  assert.equal(LIMITS.readDocumentChars, 8000, 'the documented default chunk');
  assert.equal(LIMITS.readDocumentChars, LIMITS.readDocumentMaxChars);
  // The offset maximum is NOT the export byte bound: one export byte can decode to more than one
  // character (the element end tags add a newline each), so the bound is derived from the largest
  // export the bridge decodes plus the expansion it can add, and it must accept every `nextOffset`
  // the tool can publish.
  assert.equal(LIMITS.readDocumentOffsetMax, 524305);
  assert.equal(LIMITS.readDocumentOffsetMax, 2 * LIMITS.documentHtmlBytes + 1 + 16);
  assert.equal(LIMITS.editorResultBytes, 65536, 'the per-scope editor bound the tool no longer uses as a chunk cap');
});

test('read_document_text accepts its closed argument set and rejects everything else at the schema', () => {
  const tool = readDocument(documentBridge(DOCUMENT));
  for (const args of [{}, { offset: 0 }, { maxChars: 1 }, { offset: 0, maxChars: 1 },
    { offset: LIMITS.readDocumentOffsetMax }, { maxChars: LIMITS.readDocumentMaxChars }]) {
    assert.doesNotThrow(() => validateArguments(tool.schema, args), JSON.stringify(args));
  }
  // An unknown key, a non-integer, a value below `minimum` and a value above `maximum` are all closed
  // TOOL_ERRORs raised by the schema itself: none of them can reach the handler.
  for (const args of [{ extra: 1 }, { offset: 1.5 }, { offset: '0' }, { offset: -1 },
    { offset: LIMITS.readDocumentOffsetMax + 1 }, { maxChars: 0 }, { maxChars: null },
    { maxChars: LIMITS.readDocumentMaxChars + 1 }, []]) {
    assert.throws(() => validateArguments(tool.schema, args), /TOOL_ERROR/, JSON.stringify(args));
  }
});

test('read_document_text defaults an omitted offset and maxChars to the documented chunk', async () => {
  const document = 'я'.repeat(LIMITS.readDocumentChars + 500);
  const bridge = documentBridge(document);
  const result = await readDocument(bridge).execute({}, { editor: 'word' });
  assert.equal(result.ok, true);
  assert.deepEqual(bridge.requests, [{}], 'the model arguments stay out of the bridge request');
  assert.equal(result.data.text.length, LIMITS.readDocumentChars, 'the default chunk is readDocumentChars');
  assert.equal(result.data.offset, 0);
  assert.equal(result.data.totalChars, document.length);
  assert.equal(result.data.truncated, true);
  assert.equal(result.data.nextOffset, LIMITS.readDocumentChars);
});

test('read_document_text slices exactly the requested chunk and reports its resume point', async () => {
  const tool = readDocument(documentBridge(DOCUMENT));
  const total = DOCUMENT.length;
  const first = await tool.execute({ offset: 0, maxChars: 5 }, { editor: 'word' });
  assert.deepEqual(first.data, { text: DOCUMENT.slice(0, 5), offset: 0, totalChars: total, truncated: true, nextOffset: 5 });
  const middle = await tool.execute({ offset: 5, maxChars: 5 }, { editor: 'word' });
  assert.deepEqual(middle.data, { text: DOCUMENT.slice(5, 10), offset: 5, totalChars: total, truncated: true, nextOffset: 10 });
  // A chunk that reaches EXACTLY the end is not truncated and has no resume point.
  const tail = await tool.execute({ offset: total - 3, maxChars: 3 }, { editor: 'word' });
  assert.deepEqual(tail.data, { text: DOCUMENT.slice(total - 3), offset: total - 3, totalChars: total, truncated: false, nextOffset: null });
  // An offset at the exact end, and one beyond it, are both legitimate EMPTY reads of the tail — never
  // a refusal: the address is inside the schema's bound, there is simply nothing left to read there.
  const atEnd = await tool.execute({ offset: total, maxChars: 10 }, { editor: 'word' });
  assert.deepEqual(atEnd.data, { text: '', offset: total, totalChars: total, truncated: false, nextOffset: null });
  const beyond = await tool.execute({ offset: total + 100, maxChars: 10 }, { editor: 'word' });
  assert.deepEqual(beyond.data, { text: '', offset: total + 100, totalChars: total, truncated: false, nextOffset: null });
  // `maxChars` larger than what remains yields the remainder, not an error and not a padded chunk.
  const oversized = await tool.execute({ offset: 0, maxChars: total * 10 }, { editor: 'word' });
  assert.deepEqual(oversized.data, { text: DOCUMENT, offset: 0, totalChars: total, truncated: false, nextOffset: null });
});

test('read_document_text chunks walk the document with no gap, no overlap and no invented text', async () => {
  const tool = readDocument(documentBridge(DOCUMENT));
  const parts = [];
  let offset = 0;
  for (let step = 0; step < 100; step += 1) {
    const result = await tool.execute({ offset, maxChars: 7 }, { editor: 'word' });
    assert.equal(result.ok, true, `step ${step}`);
    assert.equal(result.data.truncated, result.data.nextOffset !== null, 'the two flags are one fact');
    parts.push(result.data.text);
    if (!result.data.truncated) break;
    assert.ok(result.data.nextOffset > offset, 'a resume point always advances');
    offset = result.data.nextOffset;
  }
  assert.equal(parts.join(''), DOCUMENT, 'the chunks reconstruct the document exactly');
});

test('read_document_text reports an EMPTY document as a legitimate empty result', async () => {
  // A document with no text is a real document, not a missing one: unlike a selection (where an empty
  // read means there is nothing to reason about and `known()` is the honest answer), an empty read of
  // the WHOLE document is the whole truth about it, so it is an `ok` with zero characters.
  const result = await readDocument(documentBridge('')).execute({}, { editor: 'word' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { text: '', offset: 0, totalChars: 0, truncated: false, nextOffset: null });
  const offsetIntoEmpty = await readDocument(documentBridge('')).execute({ offset: 0, maxChars: 10 }, { editor: 'word' });
  assert.deepEqual(offsetIntoEmpty.data, { text: '', offset: 0, totalChars: 0, truncated: false, nextOffset: null });
});

test('read_document_text refuses an editor that is not Word before any dispatch', async () => {
  const bridge = documentBridge(DOCUMENT);
  const tool = readDocument(bridge);
  assert.equal(tool.precondition({}, { editor: 'word' }), null);
  for (const ctx of [{ editor: 'cell' }, { editor: 'slide' }, {}, null]) {
    const refusal = tool.precondition({}, ctx);
    assert.equal(refusal.code, 'CAPABILITY_UNAVAILABLE', JSON.stringify(ctx));
    assert.equal(refusal.message, 'отказ');
  }
  // The precondition is a pure check: the read never happened, so nothing was dispatched.
  assert.deepEqual(bridge.requests, []);
});

test('read_document_text refuses a bridge that cannot serve the read instead of crashing', async () => {
  for (const bridge of [null, {}, { readSelection: async () => ({}) }]) {
    const result = await readDocument(bridge).execute({}, { editor: 'word' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'CAPABILITY_UNAVAILABLE');
    assert.equal(result.message, 'отказ');
  }
});

test('read_document_text republishes the closed class the bridge reported, never a raw failure', async () => {
  // The bridge's own refusals (an export above the HTML ceiling, an unusable parse, a malformed native
  // answer, a timeout) are KNOWN classes and cross unchanged; a code the closed vocabulary does not
  // define, and a raw thrown failure, collapse to the tool-error class with no text from the failure.
  for (const code of ['BYTE_LIMIT', 'CAPABILITY_UNAVAILABLE', 'INVALID_DATA', 'TIMEOUT', 'CANCELLED']) {
    const result = await readDocument(documentBridge('', { readDocumentText: async () => ({ ok: false, code }) }))
      .execute({}, { editor: 'word' });
    assert.equal(result.ok, false, code);
    assert.equal(result.code, code, code);
    assert.equal(result.message, 'отказ', code);
  }
  const privateCode = await readDocument(documentBridge('', { readDocumentText: async () => ({ ok: false, code: 'PRIVATE_DETAIL' }) }))
    .execute({}, { editor: 'word' });
  assert.equal(privateCode.code, 'TOOL_ERROR', 'a code outside the closed vocabulary is not republished');
  const thrown = await readDocument(documentBridge('', { readDocumentText: async () => { throw new Error('private native detail'); } }))
    .execute({}, { editor: 'word' });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.code, 'TOOL_ERROR');
  assert.equal(JSON.stringify(thrown).includes('private native detail'), false);
});

test('read_document_text treats an unusable bridge answer as the module\u2019s unknown/uncertain convention', async () => {
  // An envelope the tool cannot interpret is a KNOWN tool error — the convention every other read in
  // this module uses — while the bridge's own UNCERTAIN class keeps stopping the run fail-safe.
  for (const answer of [null, 'текст', 42, { ok: true }, { ok: true, text: 5, totalChars: 5 },
    { ok: true, text: 'текст', totalChars: 3 }, { ok: false }]) {
    const result = await readDocument(documentBridge('', { readDocumentText: async () => answer }))
      .execute({}, { editor: 'word' });
    assert.equal(result.ok, false, JSON.stringify(answer));
    assert.equal(result.code, 'TOOL_ERROR', JSON.stringify(answer));
  }
  for (const answer of [{ ok: false, code: 'APPLY_UNCERTAIN' }]) {
    const result = await readDocument(documentBridge('', { readDocumentText: async () => answer }))
      .execute({}, { editor: 'word' });
    assert.equal(result.code, 'TOOL_UNCERTAIN', 'the uncertain bridge class is never laundered into a known error');
    assert.equal(result.message, 'отказ');
  }
  const thrownUncertain = await readDocument(documentBridge('', {
    readDocumentText: async () => { const error = new Error('APPLY_UNCERTAIN'); error.code = 'APPLY_UNCERTAIN'; throw error; }
  })).execute({}, { editor: 'word' });
  assert.equal(thrownUncertain.code, 'TOOL_UNCERTAIN', 'the same class on the thrown leg');
});

test('read_document_text refuses an out-of-range address that never crossed the schema', async () => {
  const bridge = documentBridge(DOCUMENT);
  const tool = readDocument(bridge);
  for (const args of [{ offset: -1 }, { offset: LIMITS.readDocumentOffsetMax + 1 }, { maxChars: 0 },
    { maxChars: LIMITS.readDocumentMaxChars + 1 }, { offset: 1.5 }, { maxChars: '4' }, { offset: '0' }]) {
    const result = await tool.execute(args, { editor: 'word' });
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.equal(result.code, 'TOOL_ERROR', JSON.stringify(args));
  }
  assert.deepEqual(bridge.requests, [], 'an uninterpretable address never reaches the bridge');
});

test('read_document_text keeps a DEFAULT Cyrillic read inside the per-result serialization ceiling', async () => {
  // The defect this pins: the handler bounded the chunk by `editorResultBytes` (65536), while the
  // runtime refuses any tool-result entry whose serialization exceeds `AGENT_CEILINGS.toolResultBytes`
  // (16384) and substitutes "the tool result could not be serialized" — so the 12000-character default
  // (24000 Cyrillic bytes) published a refusal INSTEAD of text for the product's main language. The
  // document here is deliberately longer than that old threshold.
  const document = 'я'.repeat(12500);
  const tool = readDocument(documentBridge(document));
  const result = await tool.execute({}, { editor: 'word' });
  assert.equal(result.ok, true, 'a Cyrillic document read with the DEFAULT arguments delivers text');
  assert.equal(result.data.text.length, LIMITS.readDocumentChars);
  assert.equal(result.data.text, document.slice(0, LIMITS.readDocumentChars));
  assert.equal(result.data.truncated, true);
  assert.equal(result.data.nextOffset, LIMITS.readDocumentChars);
  // The measurement is the entry the runtime serializes: `{ tool, ...result }` in the protocol's own
  // key order, measured in UTF-8 bytes — never the raw text alone.
  const measured = utf8ByteLength(JSON.stringify({ tool: 'read_document_text', ...result }));
  assert.equal(measured, 16123, 'the exact serialized entry the runtime will measure');
  assert.ok(measured <= AGENT_CEILINGS.toolResultBytes, `${measured} <= ${AGENT_CEILINGS.toolResultBytes}`);
  // And the envelope `readDocumentEntryBytes` budgets for is this one: 8000 Cyrillic characters cost
  // 16000 bytes, plus 121 here, plus the widest field width below — all inside 16384.
  assert.equal(measured - utf8ByteLength(JSON.stringify(result.data.text)), 121,
    'the serialization envelope of this field width');
  assert.ok(LIMITS.readDocumentEntryBytes >= measured - utf8ByteLength(JSON.stringify(result.data.text)));
  // ...and the runtime's REAL serializer accepts it: this call throws TOOL_ERROR for an over-ceiling
  // entry, and the runtime then replaces the whole result with its literal refusal.
  const messages = toolResultMessages([{ tool: 'read_document_text', result }]);
  assert.equal(messages.length, 1);
  const modelVisible = JSON.parse(messages[0].content);
  assert.equal(modelVisible.results[0].tool, 'read_document_text');
  assert.equal(modelVisible.results[0].ok, true);
  assert.equal(modelVisible.results[0].data.text.length, LIMITS.readDocumentChars, 'the text survives, whole');
  assert.equal(utf8ByteLength(messages[0].content) <= AGENT_CEILINGS.toolResultBytes + 32, true,
    'the message envelope stays within one entry plus the framing slack');
  // The chunk is resumable: the tail is a second, fitting read that reaches the end.
  const tail = await tool.execute({ offset: result.data.nextOffset }, { editor: 'word' });
  assert.equal(tail.ok, true);
  assert.equal(tail.data.text, document.slice(LIMITS.readDocumentChars));
  assert.equal(tail.data.text.length, 12500 - LIMITS.readDocumentChars);
  assert.equal(tail.data.truncated, false);
  assert.equal(tail.data.nextOffset, null);
});

test('read_document_text measures the serialized entry the protocol serializer measures', async () => {
  // Backs the `readDocumentEntryBytes` constant the limits module names: it is the exact overhead the
  // real serialization adds on top of one JSON-encoded text value. If either the entry shape or the
  // constant drifts, this test and the tool's own measurement diverge — which is why the handler
  // measures the freshly built entry rather than trusting a fixed number for its verdict.
  const text = 'я'.repeat(100);
  const result = { ok: true, data: { text, offset: 0, totalChars: 100000, truncated: true, nextOffset: 100 } };
  const serialized = JSON.stringify({ tool: 'read_document_text', ...result });
  const overhead = utf8ByteLength(serialized) - utf8ByteLength(JSON.stringify(text));
  assert.equal(overhead, 121, 'the envelope of this field width');
  // The measured envelope is the WIDEST field width the schema admits — a six-digit offset and a
  // six-digit `totalChars`, with a four-character `null` resume point. This is the budget
  // `readDocumentEntryBytes` carries, and the real serialization must not exceed it.
  const widest = { ok: true, data: { text: 'я', offset: LIMITS.readDocumentOffsetMax - 1,
    totalChars: LIMITS.readDocumentOffsetMax, truncated: false, nextOffset: null } };
  const widestOverhead = utf8ByteLength(JSON.stringify({ tool: 'read_document_text', ...widest })) -
    utf8ByteLength(JSON.stringify('я'));
  assert.ok(widestOverhead <= LIMITS.readDocumentEntryBytes, `${widestOverhead} <= ${LIMITS.readDocumentEntryBytes}`);
  assert.ok(LIMITS.readDocumentEntryBytes >= overhead);
});

test('read_document_text delivers its default chunk to the model through the REAL runtime', async () => {
  // The end-to-end leg of the same defect, against the actual loop: the reviewer's reproduction ran
  // the real runtime and the model received `"the tool result could not be serialized"` with no text.
  // The assertion here is on the transport's own messages — what the model actually sees.
  const document = 'я'.repeat(12500);
  const sent = [];
  const transport = async messages => {
    sent.push(messages.map(message => message.content));
    return sent.length === 1
      ? { content: '{"type":"tool_calls","calls":[{"tool":"read_document_text","arguments":{}}]}' }
      : { content: '{"type":"final","message":"прочитано"}' };
  };
  const run = await runAgent({ registry: createRegistry(createWordTools(documentBridge(document))),
    editor: 'word', capabilities: ['document.read', 'document.write'], mode: 'EDIT', settings: {},
    uuid: '11111111-1111-4111-8111-111111111111', request: 'прочитай документ', transport });
  assert.equal(run.status, 'FINAL');
  assert.deepEqual(run.actions.map(action => [action.tool, action.outcome]), [['read_document_text', 'ok']]);
  const refusal = sent.flat().filter(content => content.includes('could not be serialized'));
  assert.deepEqual(refusal, [], 'the runtime must never substitute its literal refusal for this read');
  const resultMessages = sent.flat().filter(content => content.includes('"type":"tool_results"'));
  assert.equal(resultMessages.length, 1, 'exactly one tool-result message reached the model');
  const entry = JSON.parse(resultMessages[0]).results[0];
  assert.equal(entry.tool, 'read_document_text');
  assert.equal(entry.ok, true);
  assert.equal(entry.data.text.length, LIMITS.readDocumentChars, 'the model received the text, not a refusal');
  assert.ok(utf8ByteLength(JSON.stringify(entry)) <= AGENT_CEILINGS.toolResultBytes);
});

test('read_document_text serves the largest chunk its entry ceiling allows, for every encoding', async () => {
  // The fail-closed rule and the UPPER-BOUND rule together. Whatever the handler returns is an entry the
  // runtime's own serializer accepts: the handler measures the entry it is about to return rather than
  // trusting the advertised character cap, so an over-ceiling entry can never leave it. What changed is
  // what it does with an over-ceiling REQUEST: `maxChars` is a ceiling on the request, not a promise the
  // tool must refuse, so the request is SERVED as the largest smaller slice of the same offset. The
  // widest encoding reaches it legitimately — three bytes per character at the advertised maximum is
  // 24000 bytes, above the 16384-byte entry ceiling — and a hard refusal would make a SCHEMA-LEGAL call
  // fail for size with no way to learn the largest servable request. Serving the largest fitting chunk
  // makes every legal call deliver text, keeps the entry exactly measured, and costs no extra step.
  for (const [unit, width] of [['漢', 3], ['я', 2]]) {
    const document = unit.repeat(LIMITS.readDocumentMaxChars + 5);
    const result = await readDocument(documentBridge(document))
      .execute({ offset: 0, maxChars: LIMITS.readDocumentMaxChars }, { editor: 'word' });
    assert.equal(result.ok, true, `${unit}: a schema-legal request is served, never refused for size`);
    const served = result.data.text.length;
    assert.equal(result.data.text, document.slice(0, served), `${unit}: the served chunk is the document's own text`);
    assert.ok(served <= LIMITS.readDocumentMaxChars, `${unit}: the served chunk is never above the request`);
    assert.ok(utf8ByteLength(JSON.stringify({ tool: 'read_document_text', ...result })) <= AGENT_CEILINGS.toolResultBytes);
    assert.doesNotThrow(() => toolResultMessages([{ tool: 'read_document_text', result }]));
    if (width * LIMITS.readDocumentMaxChars > AGENT_CEILINGS.toolResultBytes) {
      // The requested chunk cannot fit, so it is SHRUNK: the served chunk is smaller than the request
      // and is exactly the largest slice of this offset that fits — one character more is over the
      // ceiling. That is what makes the shrink "as far as needed and no further".
      assert.ok(served < LIMITS.readDocumentMaxChars, `${unit}: the oversized request is served as a smaller slice`);
      assert.ok(entryBytesForLength(document, 0, served + 1) > AGENT_CEILINGS.toolResultBytes,
        `${unit}: one character more does not fit, so the served chunk is the largest`);
      continue;
    }
    // The request for an encoding that fits is served WHOLE, at exactly the requested size.
    assert.equal(served, LIMITS.readDocumentMaxChars, `${unit}: a request that fits is served whole`);
  }
  // A bridge whose character count is past every readable document is a promise this reader cannot
  // serve: the address bound would clamp its own range, so the answer is refused rather than published
  // with a `totalChars` the tool contradicts. (A real bridge answer is always inside the bound.)
  const overBound = await readDocument(documentBridge('x'.repeat(LIMITS.readDocumentOffsetMax + 5)))
    .execute({ offset: 0, maxChars: 1 }, { editor: 'word' });
  assert.equal(overBound.ok, false);
  assert.equal(overBound.code, 'BYTE_LIMIT');
  assert.equal(overBound.data, undefined);
  // A document one character short of the bound: its final chunk REACHES the end, so it publishes the
  // nil resume point rather than an address past it, and its entry is inside the ceiling.
  const ascii = 'x'.repeat(LIMITS.readDocumentOffsetMax - 1);
  const asciiTail = await readDocument(documentBridge(ascii))
    .execute({ offset: LIMITS.readDocumentOffsetMax - 8001, maxChars: LIMITS.readDocumentMaxChars }, { editor: 'word' });
  assert.equal(asciiTail.ok, true);
  assert.equal(asciiTail.data.text.length, LIMITS.readDocumentMaxChars);
  assert.equal(asciiTail.data.truncated, false);
  assert.equal(asciiTail.data.nextOffset, null);
  assert.ok(utf8ByteLength(JSON.stringify({ tool: 'read_document_text', ...asciiTail })) <= AGENT_CEILINGS.toolResultBytes);
});

test('read_document_text serves the largest chunk that fits instead of refusing the request', async () => {
  // The decision this round implements, at the unit boundary. The schema advertises `maxChars` up to
  // 8000, but for three-byte-per-character text 8000 characters (24000 bytes) cannot fit the 16384-byte
  // result entry, so a hard refusal would fail a SCHEMA-LEGAL call for size. `maxChars` is now an UPPER
  // BOUND: the tool serves the largest slice of the same `offset` whose published entry fits.
  const wide = '漢'.repeat(LIMITS.readDocumentMaxChars + 100);
  assert.ok(utf8ByteLength(wide.slice(0, LIMITS.readDocumentMaxChars)) > AGENT_CEILINGS.toolResultBytes,
    'the widest encoding of the advertised maximum exceeds the per-result ceiling');
  const served = await readDocument(documentBridge(wide)).execute({ maxChars: LIMITS.readDocumentMaxChars }, { editor: 'word' });
  assert.equal(served.ok, true, 'the oversized request is served, never refused for size');
  const length = served.data.text.length;
  assert.equal(served.data.text, wide.slice(0, length), 'the served chunk is the requested text, shortened');
  assert.ok(length < LIMITS.readDocumentMaxChars, 'the served chunk is smaller than the requested one');
  assert.equal(served.data.truncated, true);
  assert.equal(served.data.nextOffset, length, 'the resume point names the shrunk boundary');
  assert.equal(served.data.offset, 0, 'the chunk is still the chunk at the requested offset');
  // "Largest" is a measurement, not a claim: the entry of the served length fits, and one character more
  // does not. The shrink stopped exactly where it had to.
  assert.ok(entryBytesForLength(wide, 0, length) <= AGENT_CEILINGS.toolResultBytes);
  assert.ok(entryBytesForLength(wide, 0, length + 1) > AGENT_CEILINGS.toolResultBytes,
    'one character more is over the ceiling, so the served chunk is the largest that fits');
  assert.doesNotThrow(() => toolResultMessages([{ tool: 'read_document_text', result: served }]));
  // The same document is served in a chunk that fits when the REQUEST fits: the shrink is the request's
  // size and never a blanket cap on the tool.
  const fitting = await readDocument(documentBridge(wide)).execute({ maxChars: 4000 }, { editor: 'word' });
  assert.equal(fitting.ok, true);
  assert.equal(utf8ByteLength(fitting.data.text), 12000);
  assert.ok(utf8ByteLength(JSON.stringify({ tool: 'read_document_text', ...fitting })) <= AGENT_CEILINGS.toolResultBytes);
});

test('read_document_text serves every chunk it RETURNS inside the per-result ceiling', async () => {
  // The invariant the runtime enforces, asserted end to end: whatever the handler returns is an entry
  // the runtime's own serializer accepts, and a request whose slice is too wide is answered with the
  // largest smaller slice of the same offset — never an unparseable result and never a refusal while a
  // slice that fits exists. The schema's maximum is sized on Cyrillic (the product's language) and
  // ASCII, both of which are served whole at that maximum; a THREE-byte encoding of the same character
  // count is served as the largest slice that fits, which is the honest outcome for the widest script.
  for (const unit of ['я', 'x']) {
    const document = unit.repeat(LIMITS.readDocumentMaxChars + 5);
    for (const args of [{}, { maxChars: LIMITS.readDocumentMaxChars }, { maxChars: 1 },
      { offset: 0, maxChars: LIMITS.readDocumentMaxChars }, { offset: 4096, maxChars: LIMITS.readDocumentMaxChars - 1000 }]) {
      const result = await readDocument(documentBridge(document)).execute(args, { editor: 'word' });
      assert.equal(result.ok, true, `${unit} ${JSON.stringify(args)}`);
      assert.equal(result.data.text, document.slice(args.offset ?? 0, (args.offset ?? 0) + (args.maxChars ?? LIMITS.readDocumentChars)),
        `${unit} ${JSON.stringify(args)}: the chunk is the requested slice`);
      const measured = utf8ByteLength(JSON.stringify({ tool: 'read_document_text', ...result }));
      assert.ok(measured <= AGENT_CEILINGS.toolResultBytes,
        `${unit} ${JSON.stringify(args)}: ${measured} <= ${AGENT_CEILINGS.toolResultBytes}`);
      assert.doesNotThrow(() => toolResultMessages([{ tool: 'read_document_text', result }]),
        `${unit} ${JSON.stringify(args)}: the runtime serializer accepts the entry`);
    }
  }
  // The widest script at the advertised maximum: served as the largest slice that fits, with a resume
  // point that names the shrunk boundary so the walk still reaches the rest of the document.
  const wide = '漢'.repeat(LIMITS.readDocumentMaxChars + 100);
  const shrunk = await readDocument(documentBridge(wide)).execute({ maxChars: LIMITS.readDocumentMaxChars }, { editor: 'word' });
  assert.equal(shrunk.ok, true);
  assert.ok(shrunk.data.text.length < LIMITS.readDocumentMaxChars);
  assert.equal(shrunk.data.nextOffset, shrunk.data.text.length);
  assert.ok(utf8ByteLength(JSON.stringify({ tool: 'read_document_text', ...shrunk })) <= AGENT_CEILINGS.toolResultBytes);
  assert.doesNotThrow(() => toolResultMessages([{ tool: 'read_document_text', result: shrunk }]));
  // The same document at a size that fits is served whole, and its entry is inside the ceiling too.
  const fitting = await readDocument(documentBridge(wide)).execute({ maxChars: 4000 }, { editor: 'word' });
  assert.equal(fitting.ok, true);
  assert.equal(utf8ByteLength(fitting.data.text), 12000);
  assert.ok(utf8ByteLength(JSON.stringify({ tool: 'read_document_text', ...fitting })) <= AGENT_CEILINGS.toolResultBytes);
});

test('read_document_text never returns a lone surrogate, at either cut', async () => {
  // The defect this pins: the slice is over UTF-16 code units with no pair guard, so `"a😀b"` with
  // {offset:1, maxChars:1} returned `"\ud83d"` and {offset:2, maxChars:2} returned `"\ude00b"` — a raw
  // unit that is not UTF-8 encodable. `context.js` already steps back to forbid exactly this cut.
  const EMOJI = '😀';
  const document = `a${EMOJI}b`;
  assert.equal(document.length, 4, 'the emoji is one astral code point over two code units');
  const tool = readDocument(documentBridge(document));
  // Every high surrogate is followed by its low partner and no low surrogate stands alone.
  const surrogateFree = (text) => {
    for (let i = 0; i < text.length; i += 1) {
      const unit = text.charCodeAt(i);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = text.charCodeAt(i + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
        i += 1;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
    }
    return true;
  };
  // The reviewer's two reproductions, one per cut: neither may return a lone unit.
  const startCut = await tool.execute({ offset: 1, maxChars: 1 }, { editor: 'word' });
  assert.equal(startCut.ok, true);
  assert.notEqual(startCut.data.text, '\ud83d', 'a lone HIGH surrogate is never returned');
  assert.equal(surrogateFree(startCut.data.text), true, JSON.stringify(startCut.data.text));
  const endCut = await tool.execute({ offset: 2, maxChars: 2 }, { editor: 'word' });
  assert.equal(endCut.ok, true);
  assert.notEqual(endCut.data.text.charCodeAt(0), 0xde00, 'a lone LOW surrogate never starts the chunk');
  assert.equal(surrogateFree(endCut.data.text), true, JSON.stringify(endCut.data.text));
  // The pair at the START cut is served WHOLE — the smallest safe chunk is the pair itself.
  assert.equal(startCut.data.text.includes(EMOJI), true, 'the whole pair is the smallest safe chunk');
  // A pair exactly AT the chunk boundary: `maxChars` ends on the cut between the two units, so the
  // chunk is completed rather than truncated, and the resume point is the NEXT character.
  const boundary = await tool.execute({ offset: 0, maxChars: 2 }, { editor: 'word' });
  assert.deepEqual(boundary.data, { text: `a${EMOJI}`, offset: 0, totalChars: 4, truncated: true, nextOffset: 3 });
  // Ordinary neighbours are untouched.
  assert.equal((await tool.execute({ offset: 0, maxChars: 1 }, { editor: 'word' })).data.text, 'a');
  assert.equal((await tool.execute({ offset: 3, maxChars: 1 }, { editor: 'word' })).data.text, 'b');
  // Whatever the tool returns, the document is still walkable: for every chunk the text is well formed,
  // the chunks tile the document exactly, and every resume point ADVANCES — an offset inside the pair
  // can neither repeat a chunk nor stall the walk.
  for (const maxChars of [1, 2, 3, 4]) {
    const parts = [];
    let offset = 0;
    for (let step = 0; step < 20; step += 1) {
      const result = await tool.execute({ offset, maxChars }, { editor: 'word' });
      assert.equal(result.ok, true, `maxChars ${maxChars} step ${step}`);
      assert.equal(surrogateFree(result.data.text), true, `maxChars ${maxChars} step ${step}: ${JSON.stringify(result.data.text)}`);
      assert.equal(result.data.offset, offset, 'the result names the address it was asked for');
      parts.push(result.data.text);
      if (!result.data.truncated) break;
      assert.ok(result.data.nextOffset > offset, `maxChars ${maxChars}: the resume point advances`);
      offset = result.data.nextOffset;
    }
    assert.equal(parts.join(''), document, `maxChars ${maxChars}: the chunks reconstruct the document`);
  }
  // The reviewer's second reproduction address: an offset on the pair's TAIL either repeats no text
  // that was already served or steps off the pair, and it never stalls.
  const tailOffset = await tool.execute({ offset: 2, maxChars: 1 }, { editor: 'word' });
  assert.equal(tailOffset.ok, true);
  assert.equal(surrogateFree(tailOffset.data.text), true);
  assert.ok(tailOffset.data.nextOffset === null || tailOffset.data.nextOffset > 2);
});

test('read_document_text keeps every published nextOffset inside its own schema', async () => {
  // The defect this pins: `readDocumentOffsetMax` rested on "the export needs at least one byte per
  // character", so a 100-byte pure-text export decoding to 101 characters made a character count above
  // the maximum possible. For `totalChars = 262146` the tail {offset: 262144, maxChars: 1} published
  // `nextOffset 262145`, which this tool's OWN schema (`maximum: 262144`) rejects — the tail could
  // never be read. Every offset the tool can publish must be an offset it accepts.
  // The reviewer's reproduction, exactly: `totalChars = 262146` and the tail read
  // {offset: 262144, maxChars: 1}. It used to publish `nextOffset 262145`, which this tool's own
  // schema (`maximum: 262144`) then rejected, so that tail could never be read.
  const reproduction = 'x'.repeat(262146);
  const reviewer = readDocument(documentBridge(reproduction));
  const tail = await reviewer.execute({ offset: 262144, maxChars: 1 }, { editor: 'word' });
  assert.equal(tail.ok, true);
  assert.equal(tail.data.nextOffset, 262145);
  assert.doesNotThrow(() => validateArguments(reviewer.schema, { offset: tail.data.nextOffset }),
    'the reviewer\u2019s published resume point validates against the tool\u2019s own schema');
  assert.ok(tail.data.nextOffset <= LIMITS.readDocumentOffsetMax);
  assert.equal((await reviewer.execute({ offset: tail.data.nextOffset, maxChars: 1 }, { editor: 'word' })).ok, true,
    'the tail the old bound made unreadable is readable');
  // A length past the OLD bound publishes resume points the old schema would have refused, and each
  // one is accepted now.
  const document = 'x'.repeat(300000);
  const tool = readDocument(documentBridge(document));
  const middle = await tool.execute({ offset: 262153, maxChars: 1 }, { editor: 'word' });
  assert.equal(middle.ok, true);
  assert.equal(middle.data.text, 'x');
  assert.equal(middle.data.nextOffset, 262154);
  assert.doesNotThrow(() => validateArguments(tool.schema, { offset: middle.data.nextOffset }));
  // The last character of a document that ends INSIDE the bound, and the nil resume point an exactly
  // completed read publishes — no invalid address is ever named.
  const endInside = 'x'.repeat(LIMITS.readDocumentOffsetMax - 5);
  const lastInside = await readDocument(documentBridge(endInside)).execute({ offset: LIMITS.readDocumentOffsetMax - 6, maxChars: 1 }, { editor: 'word' });
  assert.equal(lastInside.ok, true);
  assert.equal(lastInside.data.text, 'x');
  assert.equal(lastInside.data.truncated, false);
  assert.equal(lastInside.data.nextOffset, null);
  // The bound itself is accepted. A chunk the readable range has to clamp is a FINISHED read: it
  // publishes no resume point, because the schema would reject the only one it could name. It is
  // unreachable for a real document (whose text is shorter than the bound) and is the fail-closed
  // guarantee that every PUBLISHED resume point stays inside the schema.
  const atBound = await readDocument(documentBridge('x'.repeat(LIMITS.readDocumentOffsetMax))).execute({ offset: LIMITS.readDocumentOffsetMax, maxChars: 1 }, { editor: 'word' });
  assert.deepEqual(atBound.data, { text: '', offset: LIMITS.readDocumentOffsetMax,
    totalChars: LIMITS.readDocumentOffsetMax, truncated: false, nextOffset: null });
  // The bound is a closed SCHEMA bound: an offset above it is refused before any dispatch...
  const bridge = documentBridge(endInside);
  const over = await readDocument(bridge).execute({ offset: LIMITS.readDocumentOffsetMax + 1, maxChars: 1 }, { editor: 'word' });
  assert.equal(over.ok, false);
  assert.equal(over.code, 'TOOL_ERROR');
  assert.deepEqual(bridge.requests, [], 'an out-of-bounds address never reaches the bridge');
  // ...while a document whose text runs past the bound would still publish a resume point the schema
  // accepts: the ADDRESS BOUND itself, whose read is the empty tail — the case the old bound resolved
  // by publishing an address past its own maximum, the unresumable tail this test forbids. (For a real
  // document the text ends before the bound, so its final chunk reaches the document end and publishes
  // the nil resume point; the clamped form is the fail-closed guard behind that.)
  const resumed = 'x'.repeat(LIMITS.readDocumentOffsetMax - 16);
  const last = await readDocument(documentBridge(resumed))
    .execute({ offset: LIMITS.readDocumentOffsetMax - 8000, maxChars: LIMITS.readDocumentMaxChars }, { editor: 'word' });
  assert.equal(last.ok, true);
  assert.equal(last.data.text, resumed.slice(LIMITS.readDocumentOffsetMax - 8000));
  assert.equal(last.data.truncated, false);
  assert.equal(last.data.nextOffset, null, 'the last chunk reaches the document\u2019s own end');
  // The address bound itself is accepted and answers the empty tail: nothing further can be named.
  const beyond = await readDocument(documentBridge(resumed))
    .execute({ offset: LIMITS.readDocumentOffsetMax, maxChars: 1 }, { editor: 'word' });
  assert.equal(beyond.ok, true);
  assert.equal(beyond.data.text, '');
  assert.equal(beyond.data.nextOffset, null);
  assert.equal(validateArguments(reviewer.schema, { offset: LIMITS.readDocumentOffsetMax }).offset, LIMITS.readDocumentOffsetMax);
  assert.throws(() => validateArguments(reviewer.schema, { offset: LIMITS.readDocumentOffsetMax + 1 }), /TOOL_ERROR/);
});

test('read_document_text publishes a resumable chunk for every length around the offset bound', async () => {
  // The property the bound exists for, asserted rather than argued: for texts at, around and far past
  // the bound, EVERY published `nextOffset` is accepted by the tool's own schema and the read resumes
  // from it. A chunk the readable range has to clamp cannot publish a resume point at all — that is
  // what keeps the invariant true at every length rather than only at the ones a fixture happens to
  // cover — so a clamped read is a finished one and never an invitation to call back.
  const lengths = [LIMITS.readDocumentOffsetMax - 2, LIMITS.readDocumentOffsetMax - 1, LIMITS.readDocumentOffsetMax,
    LIMITS.readDocumentOffsetMax - 5, 3 * LIMITS.readDocumentMaxChars];
  for (const length of lengths) {
    for (const unit of ['x', 'я']) {
      const document = unit.repeat(length);
      const tool = readDocument(documentBridge(document));
      const offsets = [0, length - 2, length - 1, length,
        Math.min(LIMITS.readDocumentOffsetMax - 1, length - 1), LIMITS.readDocumentOffsetMax]
        .filter(offset => Number.isSafeInteger(offset) && offset >= 0 && offset <= LIMITS.readDocumentOffsetMax);
      for (const offset of offsets) {
        const result = await tool.execute({ offset, maxChars: LIMITS.readDocumentMaxChars }, { editor: 'word' });
        assert.equal(result.ok, true, `length ${length} offset ${offset}`);
        assert.equal(result.data.offset, offset, `length ${length} offset ${offset}`);
        const text = result.data.text;
        assert.equal(text, document.slice(offset, offset + text.length),
          `length ${length} offset ${offset}: the chunk is the document's own text at that address`);
        assert.ok(text.length <= LIMITS.readDocumentMaxChars, `length ${length} offset ${offset}: never above maxChars`);
        if (result.data.nextOffset === null) continue;
        assert.equal(result.data.truncated, true);
        assert.ok(result.data.nextOffset > offset, `length ${length} offset ${offset}: the resume point advances`);
        assert.ok(result.data.nextOffset <= LIMITS.readDocumentOffsetMax,
          `length ${length} offset ${offset}: nextOffset ${result.data.nextOffset} is inside the schema bound`);
        // The next call the tool invites must be one the tool accepts — schema first, then the handler.
        assert.doesNotThrow(() => validateArguments(tool.schema, { offset: result.data.nextOffset, maxChars: 1 }),
          `length ${length} offset ${offset}: the schema accepts the published nextOffset`);
        const resumed = await tool.execute({ offset: result.data.nextOffset, maxChars: 1 }, { editor: 'word' });
        assert.equal(resumed.ok, true, `length ${length} offset ${offset}: the published resume point is readable`);
        assert.equal(resumed.data.offset, result.data.nextOffset);
      }
    }
  }
});

test('read_document_text forwards the caller signal to its single bridge read', async () => {
  const bridge = documentBridge(DOCUMENT);
  const controller = new AbortController();
  await readDocument(bridge).execute({}, { editor: 'word', signal: controller.signal });
  assert.deepEqual(bridge.requests, [{ signal: controller.signal }]);
});

test('read_document_text touches exactly one bridge read and no write path at all', async () => {
  const touched = [];
  const bridge = {
    readDocumentText: async (request) => { touched.push({ method: 'readDocumentText', request }); return { ok: true, text: DOCUMENT, totalChars: DOCUMENT.length }; },
    readSelection: async () => { touched.push({ method: 'readSelection' }); return {}; },
    readContext: async () => { touched.push({ method: 'readContext' }); return {}; },
    insertParagraph: async () => { touched.push({ method: 'insertParagraph' }); return { ok: true, data: {} }; },
    applySelection: async () => { touched.push({ method: 'applySelection' }); return {}; }
  };
  const result = await readDocument(bridge).execute({ offset: 2, maxChars: 3 }, { editor: 'word' });
  assert.deepEqual(result.data, { text: DOCUMENT.slice(2, 5), offset: 2, totalChars: DOCUMENT.length, truncated: true, nextOffset: 5 });
  assert.deepEqual(touched, [{ method: 'readDocumentText', request: {} }],
    'one read, no mutation leg, and no model argument handed to a bridge that does not serve it');
});

// --- The bridge leg itself: one public document-HTML read, decoded by the existing helper ---------

test('bridge readDocumentText reads the public document export once and reports its text and total', async () => {
  const r = nativeRig();
  assert.equal(Object.hasOwn(r.plugin, 'GetFileHTML'), false, 'the document read is reached by name, not as a facade property');
  const pending = r.bridge.readDocumentText({});
  assert.equal(r.calls.length, 1, 'the export read is the ONLY native dispatch of this leg');
  assert.equal(r.calls[0].name, 'GetFileHTML');
  assert.deepEqual(r.calls[0].params, {}, 'the plain public document read every native read uses');
  assert.ok(Object.isFrozen(r.calls[0].params));
  assert.equal(r.bridge.getState().busy, true, 'the slot stays owned until the native callback');
  r.calls[0].callback('<p>привет</p>');
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.text.startsWith('привет'), true);
  assert.equal(result.text.includes('<'), false, 'the decoded answer is text, never markup');
  assert.equal(result.totalChars, result.text.length, 'the total is the decoded text\u2019s own character count');
  assert.equal(r.bridge.getState().busy, false);
  assert.equal(r.calls.some(call => call.name === 'GetSelectedText' || call.name === 'GetDocumentStructure'), false,
    'no other read primitive is dispatched');
});

test('the bridge document read serves an empty document as a legitimate empty result', async () => {
  const r = nativeRig();
  const tool = readDocument(r.bridge);
  const pending = tool.execute({}, { editor: 'word' });
  assert.equal(await untilDispatches(r.calls, 1), 1);
  assert.equal(r.calls[0].name, 'GetFileHTML');
  r.calls[0].callback('');
  const result = await pending;
  assert.equal(result.ok, true, 'an empty document is a result, never a refusal');
  assert.equal(result.data.totalChars, result.data.text.length);
  assert.equal(result.data.offset, 0);
  assert.equal(result.data.truncated, false);
  assert.equal(result.data.nextOffset, null);
});

test('bridge readDocumentText refuses an export above the ceiling instead of truncating it', async () => {
  // The whole-document export has its OWN ceiling and a result above it is NOT truncated into a
  // prefix: a clipped export would publish a false `totalChars` and a slice of a document that was
  // never fully read. The refusal keeps the closed BYTE_LIMIT class, and no native text leaks.
  const r = nativeRig();
  const pending = r.bridge.readDocumentText({});
  r.calls[0].callback('x'.repeat(LIMITS.documentHtmlBytes + 1));
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BYTE_LIMIT');
  assert.equal(JSON.stringify(result).includes('x'), false);
  assert.equal(r.bridge.getState().busy, false);
});

test('bridge readDocumentText classifies a malformed answer and an unusable parse', async () => {
  for (const answer of [null, 42, undefined]) {
    const r = nativeRig();
    const pending = r.bridge.readDocumentText({});
    r.calls[0].callback(answer);
    const result = await pending;
    assert.equal(result.ok, false, JSON.stringify(answer));
    assert.equal(result.code, 'INVALID_DATA', JSON.stringify(answer));
    assert.equal(r.bridge.getState().busy, false);
  }
  // The injected platform boundary carries no `DOMParser`: the text cannot be built, so the read is
  // unusable — a closed CAPABILITY_UNAVAILABLE, never a raw TypeError and never an empty document.
  const calls = [];
  const plugin = { info: { editorType: 'word' }, executeMethod(name, params, callback) { calls.push({ name, params, callback }); return false; } };
  const bridge = createR7Bridge(plugin, { editorType: 'word', platform: {},
    clock: { now: () => 0 }, timers: { schedule() { return {}; }, clear() {} } });
  const pending = bridge.readDocumentText({});
  assert.equal(calls.length, 1);
  calls[0].callback('<p>текст</p>');
  assert.deepEqual(await pending, { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
  assert.equal(bridge.getState().busy, false);
});

test('bridge readDocumentText refuses a dispatch channel that is not an own data descriptor', async () => {
  const r = nativeRig({ dispatchChannel: false });
  assert.equal(typeof r.plugin.executeMethod, 'function', 'a plain typeof would accept the inherited method');
  const result = await r.bridge.readDocumentText({});
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CAPABILITY_UNAVAILABLE');
  assert.deepEqual(r.calls, [], 'nothing is dispatched by name');
  assert.equal(r.bridge.getState().busy, false);
});

test('bridge readDocumentText refuses a pre-aborted signal without any dispatch', async () => {
  const r = nativeRig();
  const controller = new AbortController();
  controller.abort();
  const result = await r.bridge.readDocumentText({ signal: controller.signal });
  assert.deepEqual(result, { ok: false, code: 'CANCELLED' });
  assert.deepEqual(r.calls, []);
  assert.equal(r.bridge.getState().busy, false);
});

// --- The catalogue and the runtime: existing alone is what offers the tool -------------------------

test('read_document_text is offered with policy auto and a model call dispatches exactly one read', async () => {
  const r = nativeRig();
  // The runtime builds its catalogue from the registry, and the registry from the descriptors: the
  // tool becomes available by EXISTING, with no runtime change at all.
  const registry = createRegistry(createWordTools(r.bridge));
  const catalogue = registry.catalogue({ editor: 'word', capabilities: ['document.read', 'document.write'], mode: 'EDIT' });
  const offered = catalogue.find(entry => entry.name === 'read_document_text');
  assert.ok(offered, 'the offered catalogue contains read_document_text');
  assert.equal(offered.policy, 'auto');
  assert.equal(offered.kind, 'read');
  assert.equal(offered.requires.includes('document.read'), true);
  // A model-emitted call validates against that same catalogue...
  const batch = validateBatch(catalogue, [{ tool: 'read_document_text', arguments: { maxChars: 8 } }]);
  assert.equal(batch.length, 1);
  assert.equal(batch[0].descriptor.name, 'read_document_text');
  // ...and the runtime dispatches it through the real bridge: ONE native export read for the whole
  // run, and not one write method anywhere in it.
  const responses = ['{"type":"tool_calls","calls":[{"tool":"read_document_text","arguments":{"maxChars":8}}]}',
    '{"type":"final","message":"прочитано"}'];
  let step = 0;
  const pending = runAgent({ registry, editor: 'word', capabilities: ['document.read', 'document.write'], mode: 'EDIT',
    settings: {}, uuid: '11111111-1111-4111-8111-111111111111', request: 'прочитай документ',
    transport: async () => ({ content: responses[step++] ?? responses[responses.length - 1] }) });
  assert.equal(await untilDispatches(r.calls, 1), 1, 'the document export is dispatched by the real handler');
  assert.equal(r.calls[0].name, 'GetFileHTML');
  r.calls[0].callback('<p>привет мир</p>');
  const run = await pending;
  assert.equal(run.status, 'FINAL');
  assert.deepEqual(run.actions.map(action => [action.tool, action.outcome]), [['read_document_text', 'ok']]);
  assert.deepEqual(r.calls.map(call => call.name), ['GetFileHTML'], 'one read, no write path touched');
  assert.equal(r.bridge.getState().busy, false);
});

// --- Regression: the published entry is the measured entry ----------------------------------------
// The re-review of `read_document_text` found that the handler measured the entry while ASSUMING the
// nil resume point — `documentEntryBytes(text, offset, totalChars, null)`, i.e. `truncated:false,
// nextOffset:null` — and then PUBLISHED `truncated:true` with a six-digit `nextOffset`. The published
// entry is 1 byte larger, so a chunk whose pre-measurement was exactly `AGENT_CEILINGS.toolResultBytes`
// (16384) passed the `> ceiling` check and then made `stringifyToolResults` (protocol.js:91) throw:
// `runtime.js:27-36` replaced the whole result with its literal refusal, the MODEL received no text,
// and the run's action log still recorded `outcome: "ok"` — a fail-open signal for exactly the chunk
// sizes the ceiling is meant to allow.
// The document the reviewer measured is reproduced here verbatim: 99998 'x' + 5397 '漢' + 1 'я' +
// 63 'x' = 105459 characters. At `{offset: 99998, maxChars: 5460}` the chunk pre-measures exactly
// 16384 (passes) and the published entry is 16385 (refused).
const REVIEWER_DOCUMENT = 'x'.repeat(99998) + '漢'.repeat(5397) + 'я' + 'x'.repeat(63);
const REVIEWER_CALLS = Object.freeze([99998, 99999, 100000, 100001, 107000, 107001, 262143, 262144, 300000, 516304]
  .map(offset => Object.freeze({ offset, maxChars: 5460 })));

// The bytes of the result entry exactly as `stringifyToolResults` builds and measures it, with no
// assumption about the fields: `{ tool, ...result }` in the protocol's own key order.
function entryBytes(result) {
  return utf8ByteLength(JSON.stringify({ tool: 'read_document_text', ...result }));
}
// The entry bytes of a HYPOTHETICAL chunk of `length` characters at `offset`, published exactly the way
// the handler publishes one (the resume point is `offset + length` precisely when that is still inside
// the document, the nil resume point otherwise). It exists to make "the LARGEST chunk that fits" a
// MEASUREMENT rather than an assumption: the served length fits, and this same function one character
// longer is over the ceiling. It reconstructs the protocol shape, never the handler's own decision.
function entryBytesForLength(document, offset, length) {
  const end = offset + length;
  const nextOffset = end > offset && end < document.length ? end : null;
  return utf8ByteLength(JSON.stringify({ tool: 'read_document_text', ok: true,
    data: { text: document.slice(offset, end), offset, totalChars: document.length,
      truncated: nextOffset !== null, nextOffset } }));
}
// EVERY user-role message the model actually saw on a run — the request and each tool result — from the
// transport's own argument. User-role only, because the context ALSO carries the system rules and the
// assistant's emitted envelope, and neither is a tool result. An assertion on this is an assertion on
// the model-visible transcript, not on the handler.
function modelContents(seen) {
  return seen.flat().filter(message => message.role === 'user').map(message => message.content);
}
// True only for the entry the runtime PUBLISHED for `read_document_text`. The runtime's substitution
// for an unparseable entry is a DIFFERENT entry (`tool: 'batch'`), so this discriminates the two.
function publishedEntry(content) {
  let parsed;
  try { parsed = JSON.parse(content); } catch { return null; }
  const entry = parsed?.results?.[0];
  return entry?.tool === 'read_document_text' ? entry : null;
}

test('read_document_text serves the exact-ceiling chunk as the largest slice that fits, end to end', async () => {
  // RED for the reviewer's spurious refusal. The chunk at `{offset:99998, maxChars:5460}` is 16255 text
  // bytes; its entry with the NIL resume point is exactly the ceiling (16384) and the entry it actually
  // publishes is 16385, so the chunk does not fit WHOLE. The previous round refused that request with
  // `BYTE_LIMIT` even though `maxChars: 5459` at the SAME offset was servable — a spurious refusal of a
  // schema-legal call. `maxChars` is an UPPER BOUND: the handler now serves the largest slice of the
  // same offset whose published entry fits, so the model receives text and the runtime never substitutes
  // its literal refusal.
  const seen = [];
  const transport = async messages => {
    seen.push(messages.map(message => ({ role: message.role, content: message.content })));
    return seen.length === 1
      ? { content: JSON.stringify({ type: 'tool_calls',
        calls: [{ tool: 'read_document_text', arguments: { offset: 99998, maxChars: 5460 } }] }) }
      : { content: '{"type":"final","message":"прочитано"}' };
  };
  const run = await runAgent({ registry: createRegistry(createWordTools(documentBridge(REVIEWER_DOCUMENT))),
    editor: 'word', capabilities: ['document.read', 'document.write'], mode: 'EDIT', settings: {},
    uuid: '11111111-1111-4111-8111-111111111111', request: 'прочитай документ', transport });
  assert.equal(run.status, 'FINAL');
  assert.deepEqual(run.actions.map(action => [action.tool, action.outcome]),
    [['read_document_text', 'ok']], 'the action log reports the read it served');
  const contents = modelContents(seen);
  assert.equal(contents.some(content => content.includes('could not be serialized')), false,
    'the runtime must never substitute its literal refusal');
  const resultMessages = contents.filter(content => content.includes('"type":"tool_results"'));
  assert.equal(resultMessages.length, 1, 'exactly one tool-result message reached the model');
  const entry = publishedEntry(resultMessages[0]);
  assert.ok(entry, 'the tool-result entry the model saw is the read, not a substituted batch refusal');
  assert.equal(entry.ok, true, 'the model received text, not a refusal');
  assert.equal(entry.data.offset, 99998, 'the chunk is still the chunk at the requested offset');
  assert.equal(entry.data.text.length, 5459, 'the largest slice of the same offset that fits');
  assert.equal(entry.data.text, REVIEWER_DOCUMENT.slice(99998, 99998 + 5459), 'the served text is the document\u2019s own');
  assert.equal(entry.data.nextOffset, 105457, 'the resume point names the shrunk boundary');
  assert.equal(entry.data.truncated, true);
  assert.ok(entryBytes(entry) <= AGENT_CEILINGS.toolResultBytes, 'the model-visible entry is inside the ceiling');
  // The proof that the shrink is a shrink and not a refusal: asking for one character LESS at the same
  // offset serves the SAME chunk, because both requests are above the largest slice that fits. The old
  // boundary between "served" and "refused" no longer exists — `maxChars` is an upper bound, and the
  // served length, `truncated` and `nextOffset` are the caller's own account of what was served.
  const fitting = await readDocument(documentBridge(REVIEWER_DOCUMENT))
    .execute({ offset: 99998, maxChars: 5459 }, { editor: 'word' });
  assert.equal(fitting.ok, true, 'one character less at the same offset is served');
  assert.equal(fitting.data.text.length, 5459);
  assert.equal(fitting.data.text, entry.data.text, 'both request sizes serve the same largest chunk');
  assert.equal(fitting.data.nextOffset, 105457);
  assert.ok(entryBytes(fitting) <= AGENT_CEILINGS.toolResultBytes);
  assert.doesNotThrow(() => toolResultMessages([{ tool: 'read_document_text', result: fitting }]));
});

test('read_document_text measures the exact entry it publishes, not one with the nil resume point', async () => {
  // The unit-level statement of the D1 defect, on the reviewer's own offsets. The entry the runtime
  // serializes is built from the fields the handler PUBLISHED; the pre-fix handler measured a DIFFERENT
  // entry — the same fields with the nil resume point assumed. The comparison below reconstructs both
  // shapes. For a chunk that ends inside the document the published shape carries a six-digit resume
  // point and the two differ by exactly the byte the defect dropped — which is why the 16255-byte chunk
  // at `{offset:99998, maxChars:5460}` was measured as 16384 (admitted) and published as 16385 (refused
  // by the runtime). The measurement is still taken on the published shape; what changed this round is
  // that an over-ceiling published shape makes the chunk SHRINK rather than making the call a refusal.
  const tool = readDocument(documentBridge(REVIEWER_DOCUMENT));
  for (const args of REVIEWER_CALLS) {
    const result = await tool.execute(args, { editor: 'word' });
    const label = JSON.stringify(args);
    // Every one of the reviewer's ten calls now delivers a chunk: `maxChars` is an upper bound.
    assert.equal(result.ok, true, label);
    const served = result.data.text.length;
    assert.ok(served <= args.maxChars, `${label}: never above the requested bound`);
    assert.equal(result.data.text, REVIEWER_DOCUMENT.slice(args.offset, args.offset + served),
      `${label}: the chunk is the document's own text at that address`);
    // The entry with the fields that were actually published — what the handler measures.
    const measured = entryBytes(result);
    assert.equal(result.data.truncated, result.data.nextOffset !== null, `${label}: the two flags are one fact`);
    assert.ok(measured <= AGENT_CEILINGS.toolResultBytes, `${label}: ${measured} <= ${AGENT_CEILINGS.toolResultBytes}`);
    assert.doesNotThrow(() => toolResultMessages([{ tool: 'read_document_text', result }]),
      `${label}: the runtime serializer accepts the published entry`);
    // The entry the pre-fix measurement re-derived: the same fields with the nil resume point. With no
    // resume point the two shapes are the same entry; a six-digit resume point makes the published entry
    // exactly one byte larger than the shape the defect measured.
    const assumed = utf8ByteLength(JSON.stringify({ tool: 'read_document_text', ok: true,
      data: { text: result.data.text, offset: result.data.offset, totalChars: result.data.totalChars,
        truncated: false, nextOffset: null } }));
    assert.equal(measured, result.data.nextOffset !== null ? assumed + 1 : assumed,
      `${label}: the published shape is the measured shape`);
    // And the served length is the LARGEST that fits, not an arbitrary smaller one: when the CEILING is
    // what stopped the chunk (there is more document, and the request was larger than what fits), the
    // same offset one character longer would be over the ceiling. A chunk the document's own end stopped
    // is at its natural length and has nothing to shrink.
    if (served < args.maxChars && args.offset + served < REVIEWER_DOCUMENT.length) {
      assert.ok(entryBytesForLength(REVIEWER_DOCUMENT, args.offset, served + 1) > AGENT_CEILINGS.toolResultBytes,
        `${label}: one character more is over the ceiling, so the served chunk is the largest that fits`);
    }
  }
  // The boundary this fix is about, as its own observation: the pre-fix measurement of this chunk is
  // EXACTLY the ceiling, so it passed the `> ceiling` check while its published entry is one larger.
  const boundary = REVIEWER_CALLS.find(args => args.offset === 99998);
  const chunk = REVIEWER_DOCUMENT.slice(boundary.offset, boundary.offset + boundary.maxChars);
  assert.equal(utf8ByteLength(chunk), 16255);
  assert.equal(utf8ByteLength(JSON.stringify({ tool: 'read_document_text', ok: true,
    data: { text: chunk, offset: boundary.offset, totalChars: REVIEWER_DOCUMENT.length,
      truncated: false, nextOffset: null } })), AGENT_CEILINGS.toolResultBytes,
  'the nil-resume-point measurement is exactly the ceiling and passes the check');
  const shrunk = await tool.execute(boundary, { editor: 'word' });
  assert.equal(shrunk.ok, true, 'the chunk that cannot be published whole is served as the largest slice that can');
  assert.equal(shrunk.data.text.length, boundary.maxChars - 1, 'the shrink drops exactly the character that did not fit');
  assert.equal(utf8ByteLength(JSON.stringify({ tool: 'read_document_text', ok: true,
    data: { text: chunk, offset: boundary.offset, totalChars: REVIEWER_DOCUMENT.length,
      truncated: true, nextOffset: 105458 } })), AGENT_CEILINGS.toolResultBytes + 1,
  'the published shape of the REQUESTED chunk is one byte over the ceiling — which is why it is shrunk');
});

test('read_document_text returns text the model receives for every reviewer offset', async () => {
  // The end-to-end sweep of the reviewer's ten calls, each through the REAL runtime: whatever the
  // handler publishes as `ok` must reach the model AS TEXT — never the runtime's substitution — and a
  // request whose slice does not fit whole must be served as the largest smaller slice of the same
  // offset rather than refused. The model-visible entry is asserted, not the handler's return value.
  for (const args of REVIEWER_CALLS) {
    const seen = [];
    const transport = async messages => {
      seen.push(messages.map(message => ({ role: message.role, content: message.content })));
      return seen.length === 1
        ? { content: JSON.stringify({ type: 'tool_calls', calls: [{ tool: 'read_document_text', arguments: args }] }) }
        : { content: '{"type":"final","message":"прочитано"}' };
    };
    const run = await runAgent({ registry: createRegistry(createWordTools(documentBridge(REVIEWER_DOCUMENT))),
      editor: 'word', capabilities: ['document.read', 'document.write'], mode: 'EDIT', settings: {},
      uuid: '11111111-1111-4111-8111-111111111111', request: 'прочитай документ', transport });
    const label = JSON.stringify(args);
    assert.equal(run.status, 'FINAL', label);
    assert.deepEqual(run.actions.map(action => [action.tool, action.outcome]),
      [['read_document_text', 'ok']], `${label}: every reviewer call delivers a chunk`);
    const contents = modelContents(seen);
    assert.equal(contents.some(content => content.includes('could not be serialized')), false,
      `${label}: the runtime never substituted its refusal`);
    // The model-visible entry is the read, and the text it carries is the served chunk: `maxChars` is an
    // upper bound, so the served length may be shorter than the request but the entry is ALWAYS a read
    // with text when the address has text, never a refusal and never the runtime's substitution.
    const published = contents.map(publishedEntry).find(entry => entry !== null);
    assert.ok(published, `${label}: an ok action published a read entry the model can parse`);
    assert.equal(published.ok, true, label);
    const served = published.data.text.length;
    assert.ok(served <= args.maxChars, `${label}: never above the requested bound`);
    assert.equal(published.data.text, REVIEWER_DOCUMENT.slice(args.offset, args.offset + served), label);
    assert.equal(published.data.truncated, published.data.nextOffset !== null, label);
    if (args.offset < REVIEWER_DOCUMENT.length) assert.ok(served > 0, `${label}: a readable offset delivers text`);
    assert.ok(utf8ByteLength(JSON.stringify(published)) <= AGENT_CEILINGS.toolResultBytes, label);
  }
});

test('read_document_text never publishes ok for an entry the runtime will refuse', async () => {
  // The invariant, swept around the serialization boundary over the reviewer's OWN document: chunks at
  // `maxChars` 8000 whose REQUESTED slice would land in the last 40 bytes below
  // `AGENT_CEILINGS.toolResultBytes`. Every case must be an entry the runtime's own serializer ACCEPTS,
  // inside the ceiling, measured with the fields it published — and, because `maxChars` is an upper
  // bound, every case must be an `ok` that delivers text: the exact-ceiling chunk whose published shape
  // is one byte larger is SHRUNK by one character rather than refused. A refusal here would be the
  // spurious failure this round removes.
  const total = REVIEWER_DOCUMENT.length;
  const tool = readDocument(documentBridge(REVIEWER_DOCUMENT));
  let cases = 0;
  for (let offset = 99500; offset <= 101500; offset += 1) {
    const args = { offset, maxChars: 8000 };
    const end = Math.min(total, offset + args.maxChars);
    const text = REVIEWER_DOCUMENT.slice(offset, end);
    // What the DEFECT measured: the entry with the nil resume point assumed. `entryBytes` below is the
    // same shape with the fields that are PUBLISHED — for a six-digit resume point, one byte more.
    const assumed = utf8ByteLength(JSON.stringify({ tool: 'read_document_text', ok: true,
      data: { text, offset, totalChars: total, truncated: false, nextOffset: null } }));
    if (assumed < AGENT_CEILINGS.toolResultBytes - 40 || assumed > AGENT_CEILINGS.toolResultBytes) continue;
    if (text.length === 0) continue;
    cases += 1;
    const label = JSON.stringify(args);
    const result = await tool.execute(args, { editor: 'word' });
    // An `ok` is a promise that the model receives this text: the entry the runtime serializes from the
    // PUBLISHED fields must be inside the ceiling, and the serializer must accept it.
    assert.equal(result.ok, true, `${label}: a boundary request is served, never refused for size`);
    const served = result.data.text.length;
    assert.ok(served > 0, `${label}: the served chunk is non-empty`);
    assert.ok(served <= args.maxChars, `${label}: never above the requested bound`);
    assert.equal(result.data.text, REVIEWER_DOCUMENT.slice(offset, offset + served), label);
    const published = entryBytes(result);
    assert.ok(published <= AGENT_CEILINGS.toolResultBytes,
      `${label}: ${published} <= ${AGENT_CEILINGS.toolResultBytes}`);
    assert.equal(result.data.truncated, result.data.nextOffset !== null, label);
    assert.equal(result.data.nextOffset, result.data.truncated ? offset + served : null, label);
    assert.doesNotThrow(() => toolResultMessages([{ tool: 'read_document_text', result }]),
      `${label}: the runtime serializer accepts every published entry`);
    // The shrink stopped exactly where it had to: at this boundary offset one character more is over
    // the ceiling, so the served chunk is the largest that fits.
    if (offset + served + 1 <= total) {
      assert.ok(entryBytesForLength(REVIEWER_DOCUMENT, offset, served + 1) > AGENT_CEILINGS.toolResultBytes,
        `${label}: one character more is over the ceiling`);
    }
  }
  assert.ok(cases >= 10, `${cases} boundary cases measured`);
});

// --- The upper-bound contract: the served chunk is the largest that fits ---------------------------

test('read_document_text shrinks a three-byte script exactly as far as needed and no further', async () => {
  // The "largest chunk that fits" claim, swept across request sizes on a three-byte-per-character
  // document. Three outcomes are possible and each is asserted where it applies: a request the entry
  // ceiling can satisfy is served WHOLE (no unnecessary shrink); a request it cannot satisfy is served
  // at the largest smaller length, measured by the test's own reconstruction of the published entry —
  // the served length fits and one character more does not; and every served entry is accepted by the
  // runtime's own serializer. `maxChars` is an upper bound in all three.
  const document = '漢'.repeat(20000);
  for (const maxChars of [8000, 6000, 5461, 5460, 5459, 5450, 5000, 1000, 2, 1]) {
    const label = `maxChars ${maxChars}`;
    const result = await readDocument(documentBridge(document)).execute({ offset: 0, maxChars }, { editor: 'word' });
    assert.equal(result.ok, true, label);
    const served = result.data.text.length;
    assert.ok(served <= maxChars, `${label}: never above the request`);
    assert.equal(result.data.text, document.slice(0, served), `${label}: the chunk is the document's own text`);
    assert.ok(entryBytesForLength(document, 0, served) <= AGENT_CEILINGS.toolResultBytes,
      `${label}: the served entry is inside the ceiling`);
    assert.doesNotThrow(() => toolResultMessages([{ tool: 'read_document_text', result }]), label);
    if (served < maxChars) {
      // Shrunk: and the shrink stopped exactly at the largest fitting length.
      assert.ok(entryBytesForLength(document, 0, served + 1) > AGENT_CEILINGS.toolResultBytes,
        `${label}: one character more does not fit, so no character was dropped unnecessarily`);
    } else {
      assert.equal(served, maxChars, `${label}: a request that fits is served whole`);
    }
  }
  // The advertised maximum is a request the ceiling cannot satisfy at this width, so it is served by
  // shrinking — the same length for every request above the fitting size, because the largest slice of
  // an offset does not depend on how much was asked for beyond it.
  const max = await readDocument(documentBridge(document)).execute({ offset: 0, maxChars: LIMITS.readDocumentMaxChars }, { editor: 'word' });
  const above = await readDocument(documentBridge(document)).execute({ offset: 0, maxChars: 6000 }, { editor: 'word' });
  assert.ok(max.data.text.length < LIMITS.readDocumentMaxChars, 'the schema-legal maximum is shrunk, not refused');
  assert.equal(max.data.text, above.data.text, 'every request above the fitting size serves the same largest chunk');
  assert.equal(max.data.nextOffset, above.data.nextOffset);
  assert.ok(entryBytesForLength(document, 0, max.data.text.length + 1) > AGENT_CEILINGS.toolResultBytes);
});

test('read_document_text tiles the document exactly when the shrink moves the boundary onto a pair', async () => {
  // The shrink must not break the walk. The chunk boundaries still TILE the document, so repeated
  // `nextOffset` reads reproduce the decoded text exactly — no skipped and no duplicated character —
  // including when the shrink moved the boundary, and including when an astral surrogate PAIR sits
  // exactly at the shrunk boundary (the next chunk must then start ON the pair and serve it whole).
  const probe = '漢'.repeat(20000);
  const probeResult = await readDocument(documentBridge(probe)).execute({ offset: 0, maxChars: 8000 }, { editor: 'word' });
  const fitted = probeResult.data.text.length;
  assert.ok(fitted < 8000, 'the three-byte maximum really is shrunk');
  // The character at index `fitted` is the high surrogate of an astral pair, so the shrunk boundary
  // lands exactly on it: the first chunk ends before the pair, the next begins with both its units.
  const document = '漢'.repeat(fitted) + '😀' + '漢'.repeat(20000 - fitted);
  assert.equal(document.length, 20002, 'the pair costs two code units, so the total is two longer than the probe');
  const surrogateFree = (text) => {
    for (let i = 0; i < text.length; i += 1) {
      const unit = text.charCodeAt(i);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = text.charCodeAt(i + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
        i += 1;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
    }
    return true;
  };
  const tool = readDocument(documentBridge(document));
  const first = await tool.execute({ offset: 0, maxChars: 8000 }, { editor: 'word' });
  assert.equal(first.ok, true);
  assert.equal(first.data.text.length, fitted, 'the total character count is one longer, the fitting length is not');
  assert.equal(first.data.nextOffset, fitted, 'the resume point is the shrunk boundary');
  assert.equal(document.charCodeAt(fitted), 0xd83d, 'the shrunk boundary lands on the pair\u2019s high surrogate');
  assert.equal(surrogateFree(first.data.text), true);
  // The walk: every chunk whole, every resume point advancing, and the concatenation exact.
  const parts = [];
  let offset = 0;
  for (let step = 0; step < 100; step += 1) {
    const result = await tool.execute({ offset, maxChars: 8000 }, { editor: 'word' });
    assert.equal(result.ok, true, `step ${step}`);
    assert.equal(surrogateFree(result.data.text), true, `step ${step}: no lone surrogate`);
    assert.equal(result.data.offset, offset, `step ${step}: the result names the address it was asked for`);
    parts.push(result.data.text);
    if (!result.data.truncated) break;
    assert.ok(result.data.nextOffset > offset, `step ${step}: the resume point advances`);
    offset = result.data.nextOffset;
  }
  assert.equal(parts.join(''), document, 'the chunks reconstruct the document exactly across the shrunk boundary');
  // The chunk AFTER the shrunk boundary begins with the whole pair, so the shrink dropped nothing.
  assert.equal(parts[1].startsWith('😀'), true, 'the pair at the shrunk boundary is served whole by the next chunk');
});

// --- The search's REAL restriction: monotonicity on character-boundary ends -----------------------
// The bisection above it replaces an earlier justification that has since been FALSIFIED, and these
// tests pin the true statement. For the text `'x👍яé'` at `offset = 3`, the end `3` serializes to 125
// bytes while the LONGER end `4` serializes to 123: entry bytes genuinely DECREASE with the end, so
// `fits` is not downward-closed on every integer end and a bisection over all of them would be
// unsound. The reason is precise — every probed unit of a VALID astral pair is 4 UTF-8 bytes, but a
// pair truncated at its high unit is emitted by `JSON.stringify` as the six-byte `\uXXXX` escape (one
// per unit), so dropping one unit from a slice that ends MID-pair can save MORE than the envelope
// grows. The handler never searches that zone: the floor and every probe are `characterEnd(...)`
// results, so each end is a whole-character boundary strictly greater than `offset`.
const PROBE_ENTRY = (text) => ({
  tool: 'read_document_text', ok: true,
  data: { text, offset: 0, totalChars: 1, truncated: false, nextOffset: null },
});
const DECREASE_TEXT = 'x\u{1F44D}\u044F\u00E9';

test('read_document_text serializes an entry per END, and entry bytes DECREASE with a longer end', async () => {
  // The reviewer's own falsification, re-measured: `offset = 3` here only changes the `offset` field,
  // which is constant ACROSS the two entries, so the comparison isolates what the end does to the
  // entry. End `3` is the end that EQUALS the offset, so it can publish no resume point and spells
  // `"nextOffset":null`; end `4` is one whole character later and spells the one-digit `"nextOffset":4`.
  // The longer slice is TWO bytes SMALLER in the entry — 123 against 125. The two spellings the end
  // moves are measured below (`null` against `4`, `false` against `true`); the exact byte arithmetic
  // is read off `at(...)`, not assumed.
  const at = (end, offset) => {
    const text = DECREASE_TEXT.slice(0, end);
    const nextOffset = end > offset && end < DECREASE_TEXT.length ? end : null;
    return utf8ByteLength(JSON.stringify({ tool: 'read_document_text', ok: true,
      data: { text, offset, totalChars: DECREASE_TEXT.length, truncated: nextOffset !== null, nextOffset } }));
  };
  assert.equal(JSON.stringify(DECREASE_TEXT), '"x\u{1F44D}\u044F\u00E9"',
    'the FALSIFYING text, written out: one ASCII unit, one astral PAIR, two two-byte characters');
  assert.equal(at(3, 3), 125, 'the end equal to the offset publishes the nil resume point');
  assert.equal(at(4, 3), 123, 'the longer, whole-character end is TWO bytes smaller');
  assert.ok(at(4, 3) < at(3, 3), 'bytes(e\') <= bytes(e) for e\' < e is FALSE as written');
  // The proposal is true only for ends that are CHARACTER boundaries — the ends the loop can probe.
  // TWO different mechanisms shrink the entry as the end grows, and both are measured here. First, a
  // slice ending on a pair's high unit alone escapes that one unit as six bytes, so completing the
  // pair makes the escaped text TWO bytes narrower (9 against 7); that moves the entry from 127 to 125
  // at end 3. Second, the end that EQUALS the offset can publish no resume point and spells the wider
  // `"nextOffset":null`, so the whole-character end 4 publishes the one-digit `4` and the entry drops
  // again, to 123. The searches' ends are whole characters strictly ABOVE the offset, where neither
  // mechanism can act.
  assert.equal(utf8ByteLength(JSON.stringify('x\uD83D')), 9, 'the bare high unit: 6 escaped + 2 quotes + 1');
  assert.equal(utf8ByteLength(JSON.stringify('x\u{1F44D}')), 7, 'the completed pair is TWO bytes NARROWER');
  assert.equal(at(2, 3), 127, 'the mid-pair slice');
  assert.equal(at(3, 3), 125, 'the same slice with the pair completed is two bytes smaller');
  assert.equal(at(4, 3), 123, 'and the nil resume point costs two more than the digit it becomes');
  assert.ok(at(2, 3) > at(3, 3), 'even appending the unit that COMPLETES the pair can shrink the entry');
  assert.ok(at(4, 3) < at(3, 3), 'bytes(e\') <= bytes(e) for e\' < e is FALSE as written');
  // For the ends the loop CAN probe — whole-character boundaries strictly above the offset — the entry
  // is non-decreasing, which is what makes `fits` downward-closed on the searched interval. It is not
  // strictly increasing everywhere: a boundary can gain two text bytes while the envelope gains none,
  // or gain two while the envelope gives them back. Equality is enough for a bisection.
  let previous = null;
  for (let cut = 3 + 1; cut <= DECREASE_TEXT.length; cut += 1) {
    const boundaryEnd = cut < DECREASE_TEXT.length
      && DECREASE_TEXT.charCodeAt(cut - 1) >= 0xd800 && DECREASE_TEXT.charCodeAt(cut - 1) <= 0xdbff
      && DECREASE_TEXT.charCodeAt(cut) >= 0xdc00 && DECREASE_TEXT.charCodeAt(cut) <= 0xdfff ? cut + 1 : cut;
    const bytes = at(boundaryEnd, 3);
    if (previous !== null) assert.ok(bytes >= previous, `end ${boundaryEnd}: ${bytes} >= ${previous}`);
    previous = bytes;
  }
  // The handler therefore serves the whole character at `offset = 3` — the probe it makes is a
  // whole-character end above both the offset and the end that would have fooled a raw comparison.
  const served = await readDocument(documentBridge(DECREASE_TEXT)).execute({ offset: 3, maxChars: 1 }, { editor: 'word' });
  assert.equal(served.ok, true);
  assert.equal(served.data.text, '\u044F', 'the whole character at the address, never half a pair');
  assert.equal(served.data.nextOffset, 4);
  assert.equal(served.data.truncated, true);
  assert.ok(entryBytes(served) <= AGENT_CEILINGS.toolResultBytes);
});

test('read_document_text serves a document with a lone surrogate inside the ceiling and still serializes', async () => {
  // The residual the reviewer named, measured rather than assumed: the text ALREADY holds a lone
  // surrogate (`'\uD83D'.repeat(6000)`), so `JSON.stringify` escapes each unit as six bytes and the
  // entry is far over the ceiling for the whole document. The tool must still fit the ceiling, publish
  // a whole-character prefix with a resume point, and produce an entry the runtime's own serializer
  // ACCEPTS. It republishes the units the document holds — a lone surrogate is a property of the
  // supplied text, not something the tool repairs, and the DOMParser/UTF-8 decode path cannot produce
  // one because a lone surrogate encodes as U+FFFD. This test DOCUMENTS that behaviour; it asserts no
  // repair, so a future change that repaired the text would have to update this comment and test.
  const text = '\uD83D'.repeat(6000);
  const tool = readDocument(documentBridge(text));
  const result = await tool.execute({ offset: 0, maxChars: 8000 }, { editor: 'word' });
  assert.equal(result.ok, true, 'a document holding a lone surrogate is still readable');
  const served = result.data.text.length;
  assert.ok(served > 0 && served < 8000, `${served}: inside the request, and shrunk by the ceiling`);
  assert.equal(result.data.text, text.slice(0, served), 'the served chunk is the document\u2019s own units');
  assert.equal(result.data.nextOffset, served);
  assert.equal(result.data.truncated, true);
  assert.ok(entryBytes(result) <= AGENT_CEILINGS.toolResultBytes,
    `${entryBytes(result)} <= ${AGENT_CEILINGS.toolResultBytes}`);
  assert.doesNotThrow(() => toolResultMessages([{ tool: 'read_document_text', result }]),
    'the runtime serializer accepts an entry whose text holds lone surrogates');
  // The six-byte escape of a lone unit IS the width that binds here: the ceiling is reached by the
  // ESCAPED text, so the fitting length is what `JSON.stringify` of those units leaves room for, and
  // one unit more is over it. `utf8ByteLength` on the RAW text counts a lone surrogate as the three
  // bytes it would encode to (U+FFFD), so the escaped figure is the one to compare.
  assert.equal(utf8ByteLength(JSON.stringify(result.data.text)), 16262,
    'the escaped text of the served prefix: 2710 units at six bytes of escape each');
  // The published entry for that prefix plus ONE more unit, in the exact shape the handler publishes
  // it (the longer slice still leaves the document unfinished, so it carries a resume point). It is
  // over the ceiling: the served prefix really is the largest that fits.
  const oneMore = utf8ByteLength(JSON.stringify({ tool: 'read_document_text', ok: true,
    data: { text: text.slice(0, served + 1), offset: 0, totalChars: text.length, truncated: true, nextOffset: served + 1 } }));
  assert.equal(oneMore, 16388);
  assert.ok(oneMore > AGENT_CEILINGS.toolResultBytes,
    `${oneMore} > ${AGENT_CEILINGS.toolResultBytes}: one unit more is over the ceiling`);
  assert.equal(result.data.text.includes('\uD83D'), true, 'what the document holds is republished, not repaired');
});

test('read_document_text never searches below four digits, because no shorter entry reaches the ceiling', async () => {
  // The envelope's one shrink — a nil resume point instead of a `nextOffset` — needs `end <= offset`,
  // and its one growth inside the search interval is the digit width of `nextOffset`. This test pins
  // both facts to the actual constants: a sub-4-digit end cannot reach `AGENT_CEILINGS.toolResultBytes`
  // at all, so the bisection can never run where the envelope's width matters at 1-3 digits, and the
  // smallest digit width it CAN search is 4. The measurement is the tool's own: the largest entry a
  // 999-unit end can produce, in the worst shape available to it (six-byte escapes), is 6116 bytes.
  const tip = utf8ByteLength(JSON.stringify(PROBE_ENTRY('x'.repeat(999))));
  const worst = utf8ByteLength(JSON.stringify({ tool: 'read_document_text', ok: true,
    data: { text: '\uD83D'.repeat(999), offset: 0, totalChars: 20000, truncated: true, nextOffset: 999 } }));
  assert.ok(worst < AGENT_CEILINGS.toolResultBytes,
    `${worst} < ${AGENT_CEILINGS.toolResultBytes}: the most expensive sub-4-digit end is still under the ceiling`);
  assert.ok(worst > tip, 'the six-byte escapes are the expensive shape, not plain ASCII');
  // The tool answers a small document whole, with no shrink and no publication of a digit width it
  // never had to search in: the whole 999-unit document is served, the end IS the document's own end,
  // and a chunk that consumed the document publishes no resume point at all.
  const small = '\uD83D'.repeat(999);
  const whole = await readDocument(documentBridge(small)).execute({ offset: 0, maxChars: 8000 }, { editor: 'word' });
  assert.equal(whole.ok, true);
  assert.equal(whole.data.text.length, 999, 'a request that fits is served whole');
  assert.equal(whole.data.nextOffset, null, 'a chunk that reached the document\u2019s end publishes no resume point');
  assert.equal(whole.data.truncated, false);
  assert.equal(entryBytes(whole), 6116, 'the whole 999-unit document, escaped: 5994 text + 122 envelope');
  assert.ok(entryBytes(whole) < AGENT_CEILINGS.toolResultBytes, 'a 3-digit end is nowhere near the ceiling');
  // A document long enough to bind the ceiling really binds it, and its end is in the 4-digit zone:
  // 2710 units at six bytes of escape each plus the envelope is the largest entry the ceiling admits
  // here, and `LIMITS.readDocumentOffsetMax` (524305, six digits) is the constant that keeps the
  // envelope from ever growing by more than the one byte a digit boundary can add inside the search.
  const binding = '\uD83D'.repeat(20000);
  const fitted = await readDocument(documentBridge(binding)).execute({ offset: 0, maxChars: 8000 }, { editor: 'word' });
  assert.equal(fitted.ok, true);
  const served = fitted.data.text.length;
  assert.equal(served, 2710, 'the measured fitting length at the ceiling for six-byte units');
  assert.equal(String(served).length, 4, 'the searched end is 4 digits, the smallest width this ceiling admits');
  assert.equal(entryBytes(fitted), 16383, 'the fitted entry, one byte under the ceiling');
  assert.ok(entryBytesForLength(binding, 0, served + 1) > AGENT_CEILINGS.toolResultBytes);
  assert.equal(String(LIMITS.readDocumentOffsetMax).length, 6, 'the address bound that bounds the envelope\u2019s growth');
  assert.equal(AGENT_CEILINGS.toolResultBytes, 16384, 'the result ceiling the whole argument depends on');
});

test('read_document_text refuses closed when not even ONE whole character can be served', async () => {
  // The FLOOR of the shrink is ONE whole character, never zero: a chunk that consumed nothing would
  // publish no resume point and stop the walk while text remained — exactly the skipped range the
  // boundary rule forbids. So the tool never serves an empty chunk while the document has text at the
  // address, and a request that not even one character can satisfy is a CLOSED refusal with no entry.
  // One character inside a readable document is served, at the requested size, with no shrink at all:
  const one = await readDocument(documentBridge('漢x')).execute({ offset: 0, maxChars: 1 }, { editor: 'word' });
  assert.equal(one.ok, true, 'one whole character is served');
  assert.equal(one.data.text, '漢');
  assert.equal(one.data.nextOffset, 1, 'the chunk consumed exactly one character');
  assert.equal(one.data.truncated, true);
  // The reachable way not even ONE character can be served is the ADDRESS bound: a document whose own
  // character count is past every readable range refuses before any chunk is built, because no resume
  // point inside the schema could name the rest of it. (At the current ceilings one character can never
  // reach the byte ceiling — at most a six-byte escaped surrogate plus the ~130-byte envelope — so the
  // byte-ceiling floor is the fail-closed guard behind this, not a reachable production case.)
  const unreadable = await readDocument(documentBridge('x'.repeat(LIMITS.readDocumentOffsetMax + 5)))
    .execute({ offset: 0, maxChars: 1 }, { editor: 'word' });
  assert.equal(unreadable.ok, false, 'not even one character can be addressed');
  assert.equal(unreadable.code, 'BYTE_LIMIT');
  assert.equal(unreadable.message, 'отказ');
  assert.equal(unreadable.data, undefined, 'a refusal carries no entry for the runtime to serialize');
  assert.equal(JSON.stringify(unreadable).includes('could not be serialized'), false);
  // And the floor holds along a shrunken walk: a chunk that publishes a resume point always served at
  // least one character, and a chunk that publishes none reached the document's own end.
  const document = '漢'.repeat(12000) + 'x'.repeat(50);
  const walk = readDocument(documentBridge(document));
  let offset = 0;
  let steps = 0;
  for (; steps < 50; steps += 1) {
    const result = await walk.execute({ offset, maxChars: 8000 }, { editor: 'word' });
    assert.equal(result.ok, true, `step ${steps}`);
    assert.equal(result.data.text, document.slice(offset, offset + result.data.text.length), `step ${steps}`);
    if (result.data.nextOffset === null) {
      assert.ok(offset + result.data.text.length >= document.length,
        `step ${steps}: no resume point only at the document's own end`);
      break;
    }
    assert.ok(result.data.text.length > 0, `step ${steps}: a chunk with a resume point served text`);
    offset = result.data.nextOffset;
  }
  assert.ok(offset >= document.length || steps > 0, 'the walk ran');
});

// --- Sprint 3, tool 2: `read_paragraph` — the caret context read -----------------------------------
//
// THE PRIMITIVE EVIDENCE, measured on the vendored copy of the installed build's word SDK source
// (`.local/stage-b-runtime/vendor-word-sdk-all.js`, dev-only), by counting occurrences in the file's
// text rather than with `Select-String`, which silently reports ZERO on this 15 MB bundle:
//   `pluginMethod_GetCurrentParagraph` 0, `pluginMethod_GetCurrentSentence` 0,
//   `pluginMethod_GetCurrentWord` 0, `pluginMethod_GetSelectedText` 0.
// Those zeros prove NOTHING, because `pluginMethod_` is not a naming convention in this bundle: it
// occurs FOUR times in total — the explicit `PasteHtml` / `PasteText` / `OnEncryption` members and the
// dispatcher's own `"pluginMethod_"+methodName` lookup — so the editor resolves every other method name
// dynamically and no prefixed literal exists to count.
// The BARE names are what exist: `GetCurrentParagraph` 125, `GetSelectedText` 101, `GetCurrentWord` 7,
// `GetCurrentSentence` 6. No plugin-level PARAGRAPH getter is established: every sampled
// `GetCurrentParagraph` is document-content-level (`documentContent.GetCurrentParagraph()` and
// `Ct.prototype.GetCurrentParagraph`, the `Api` builder route this descriptor is forbidden to use),
// which is why no `pluginMethod_GetCurrentParagraph` is dispatched anywhere in this repo.
// `GetCurrentSentence` IS established at the plugin level, by this repo's own history: commit ed65dd5
// dispatched exactly `plugin.executeMethod('GetCurrentSentence', [], callback)` through the one owned
// dispatch channel and records it as "the primitive the live build actually answers with the inserted
// sentence" on R7-Office 2026.3.1.
// The tool therefore reads the SENTENCE at the caret — the most precise caret read that exists — and
// says so in `scope`, rather than naming a paragraph the primitive cannot deliver.
const CARET_SENTENCE = 'Привет, мир.';

// A bridge that records every request the tool makes, so "the refusal never reached the bridge" and
// "exactly one read, no write method" are observations rather than assumptions.
function caretBridge(text, extras = {}) {
  const requests = [];
  return { requests, readParagraph: async (request) => { requests.push(request); return { ok: true, text }; }, ...extras };
}
function readParagraph(bridge) { return createWordTools(bridge).find(entry => entry.name === 'read_paragraph'); }

// The real plugin facade exposes the editor methods ONLY through its single public dispatch channel,
// exactly as `nativeRig` above documents. This leg carries NO identity probe: a caret context read
// returns no OWNED TARGET a later write could be applied to, so there is no handle whose ownership
// would have to be proven and the read is ONE dispatch.
function caretRig({ dispatchChannel = true } = {}) {
  const calls = [];
  function dispatch(name, params, callback) { calls.push({ name, params, callback }); return false; }
  const base = { info: { editorType: 'word' } };
  const plugin = dispatchChannel
    ? { ...base, executeMethod: dispatch }
    : Object.assign(Object.create({ executeMethod: dispatch }), base);
  const bridge = bridgeWith(plugin, { editorType: 'word', clock: { now: () => 0 },
    timers: { schedule() { return {}; }, clear() {} } });
  return { bridge, plugin, calls };
}

test('read_paragraph advertises the closed schema, the scope it really reads and the bound it enforces', () => {
  const tool = readParagraph(caretBridge(CARET_SENTENCE));
  assert.equal(tool.kind, 'read');
  assert.equal(tool.policy, 'auto');
  assert.deepEqual(tool.editors, ['word']);
  assert.deepEqual(tool.requires, ['document.read']);
  assert.equal(tool.schema.type, 'object');
  assert.equal(tool.schema.additionalProperties, false, 'the schema is CLOSED');
  assert.deepEqual(tool.schema.required, [], 'the caret read takes no model arguments at all');
  assert.deepEqual(Object.keys(tool.schema.properties), [],
    'the primitive takes no parameters, so the schema advertises none');
  // The bound is the SERIALIZED tool-result entry, not the raw text: the runtime refuses an entry whose
  // JSON exceeds `AGENT_CEILINGS.toolResultBytes` (16384) — NOT `LIMITS.editorResultBytes` (65536) — and
  // substitutes the literal "the tool result could not be serialized". The caret text is the product's
  // realistic worst case at two UTF-8 bytes per character, so the largest text the tool may publish
  // plus its measured envelope must fit: 16000 + 87 = 16087 <= 16384, with 297 bytes of slack.
  assert.equal(LIMITS.readParagraphBytes, 16000, 'the largest caret context the tool serves');
  assert.ok(LIMITS.readParagraphBytes + 87 <= AGENT_CEILINGS.toolResultBytes,
    'a full Cyrillic caret context plus its envelope fits the per-result ceiling');
  assert.ok(LIMITS.readParagraphBytes < AGENT_CEILINGS.contextReadBytes.paragraph,
    'the caret read has its OWN bound, never the paragraph context budget reused as an alias');
});

test('read_paragraph accepts only the empty argument object and rejects every other key at the schema', () => {
  const tool = readParagraph(caretBridge(CARET_SENTENCE));
  assert.doesNotThrow(() => validateArguments(tool.schema, {}), 'the one legal call site');
  // An unknown key — including one a plausible caller would guess, such as the SCOPE the RESULT names —
  // is a closed TOOL_ERROR raised by the schema itself and can never reach the handler. The result bound
  // is not a model argument: nothing the model sends can widen or narrow it.
  for (const args of [{ scope: 'sentence' }, { text: 'x' }, { bytes: 1 }, { maxBytes: 1 },
    { offset: 0 }, { extra: 1 }, [], null, 'text', 1]) {
    assert.throws(() => validateArguments(tool.schema, args), /TOOL_ERROR/, JSON.stringify(args));
  }
});

test('read_paragraph refuses an editor that is not Word before any dispatch', async () => {
  const bridge = caretBridge(CARET_SENTENCE);
  const tool = readParagraph(bridge);
  for (const editor of ['cell', 'slide', 'unknown']) {
    const refusal = tool.precondition({}, { editor });
    assert.equal(refusal.code, 'CAPABILITY_UNAVAILABLE', editor);
    assert.equal(refusal.message, 'отказ', editor);
  }
  assert.equal(tool.precondition({}, { editor: 'word' }), null);
  assert.deepEqual(bridge.requests, [], 'the precondition is what refuses, and it dispatches nothing');
});

test('read_paragraph returns the caret sentence with exact Cyrillic byte accounting', async () => {
  const bridge = caretBridge(CARET_SENTENCE);
  const result = await readParagraph(bridge).execute({}, { editor: 'word' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { scope: 'sentence', text: CARET_SENTENCE, bytes: 21 });
  assert.equal(result.data.bytes, utf8ByteLength(CARET_SENTENCE), 'the byte count is the text\u2019s own');
  assert.equal(CARET_SENTENCE.length, 12, 'and it is NOT the UTF-16 code-unit length');
  assert.equal(Object.isFrozen(result.data), true);
  assert.deepEqual(bridge.requests, [{ maxBytes: LIMITS.readParagraphBytes }],
    'the model arguments stay out of the bridge request');
});

test('read_paragraph treats an empty caret context as a closed known refusal, never as empty text', async () => {
  // THE STATED DECISION. An empty caret context means the caret is in no sentence at all — there is
  // nothing to reason about, exactly like an empty SELECTION in `read_selection` — so the tool refuses
  // with the module's closed `known()` class. This is deliberately NOT the whole-document convention
  // (`read_document_text` returns `ok` for an empty document), where `''` IS the complete answer to
  // "what does this document say". A caret read has no such question to answer.
  for (const empty of ['', null, undefined, 42, {}]) {
    const result = await readParagraph(caretBridge(empty)).execute({}, { editor: 'word' });
    assert.equal(result.ok, false, JSON.stringify(empty));
    assert.equal(result.code, 'TOOL_ERROR', JSON.stringify(empty));
    assert.equal(result.message, 'отказ', JSON.stringify(empty));
    assert.equal(result.data, undefined, 'a refusal carries no entry for the runtime to serialize');
  }
});

test('read_paragraph refuses a caret context longer than its bound as BYTE_LIMIT', async () => {
  const tool = readParagraph(caretBridge('я'.repeat(LIMITS.readParagraphBytes)));
  const over = await tool.execute({}, { editor: 'word' });
  assert.equal(over.ok, false);
  assert.equal(over.code, 'BYTE_LIMIT');
  assert.equal(over.message, 'отказ');
  assert.equal(JSON.stringify(over).includes('я'), false, 'no native text leaks through a refusal');
  // The boundary is exact and the served side is inside the per-result serialization ceiling: the
  // largest text the tool ACCEPTS still produces an entry the runtime serializer accepts.
  const edge = await readParagraph(caretBridge('я'.repeat(LIMITS.readParagraphBytes / 2))).execute({}, { editor: 'word' });
  assert.equal(edge.ok, true, 'the bound itself is served, not refused');
  assert.equal(edge.data.bytes, LIMITS.readParagraphBytes);
  assert.doesNotThrow(() => toolResultMessages([{ tool: 'read_paragraph', result: edge }]));
});

test('read_paragraph republishes the closed class the bridge reported, never a raw failure', async () => {
  const classes = ['TIMEOUT', 'CANCELLED', 'INVALID_DATA', 'CAPABILITY_UNAVAILABLE', 'EDITOR_BUSY', 'BYTE_LIMIT'];
  for (const code of classes) {
    const result = await readParagraph(caretBridge('', { readParagraph: async () => ({ ok: false, code }) }))
      .execute({}, { editor: 'word' });
    assert.equal(result.ok, false, code);
    assert.equal(result.code, code, `${code} crosses unchanged`);
    assert.equal(result.message, 'отказ', code);
  }
  // Only a class from the closed vocabulary is republished: an arbitrary bridge string keeps the
  // module's own tool-error fallback rather than reaching the run as an invented code.
  for (const code of ['SOMETHING_ELSE', '', 7, null]) {
    const result = await readParagraph(caretBridge('', { readParagraph: async () => ({ ok: false, code }) }))
      .execute({}, { editor: 'word' });
    assert.equal(result.code, 'TOOL_ERROR', JSON.stringify(code));
  }
  // A THROWN classified refusal crosses the same way as a returned one.
  const thrown = await readParagraph(caretBridge('', { readParagraph: async () => { const error = new Error('x'); error.code = 'TIMEOUT'; throw error; } }))
    .execute({}, { editor: 'word' });
  assert.equal(thrown.code, 'TIMEOUT');
});

test('read_paragraph maps a returned or thrown uncertain class to TOOL_UNCERTAIN', async () => {
  const returned = await readParagraph(caretBridge('', { readParagraph: async () => ({ ok: false, code: 'APPLY_UNCERTAIN' }) }))
    .execute({}, { editor: 'word' });
  assert.equal(returned.ok, false);
  assert.equal(returned.code, 'TOOL_UNCERTAIN', 'a returned uncertain bridge answer stops the run');
  const thrown = await readParagraph(caretBridge('', { readParagraph: async () => { const error = new Error('x'); error.code = 'APPLY_UNCERTAIN'; throw error; } }))
    .execute({}, { editor: 'word' });
  assert.deepEqual(thrown, { ok: false, code: 'TOOL_UNCERTAIN', message: 'отказ' },
    'a thrown uncertain answer is classified identically');
});

test('read_paragraph refuses a bridge that cannot serve the caret read instead of crashing', async () => {
  // The entry point is absent, or present and not a function: both are the same closed capability
  // refusal with NOTHING dispatched, never a raw TypeError out of the handler.
  for (const bridge of [null, undefined, {}, { readParagraph: 'no' }, { readParagraph: 7 }]) {
    const result = await readParagraph(bridge).execute({}, { editor: 'word' });
    assert.equal(result.ok, false, JSON.stringify(bridge));
    assert.equal(result.code, 'CAPABILITY_UNAVAILABLE', JSON.stringify(bridge));
    assert.equal(result.message, 'отказ', JSON.stringify(bridge));
  }
});

test('read_paragraph touches exactly one bridge read and no write method at all', async () => {
  const touched = [];
  const record = (method, value) => async () => { touched.push({ method }); return value; };
  const bridge = {
    readParagraph: async (request) => { touched.push({ method: 'readParagraph', request }); return { ok: true, text: CARET_SENTENCE }; },
    readSelection: record('readSelection', {}),
    readContext: record('readContext', {}),
    readDocumentText: record('readDocumentText', {}),
    insertParagraph: record('insertParagraph', { ok: true, data: {} }),
    applySelection: record('applySelection', {})
  };
  const result = await readParagraph(bridge).execute({}, { editor: 'word' });
  assert.equal(result.ok, true);
  assert.deepEqual(touched, [{ method: 'readParagraph', request: { maxBytes: LIMITS.readParagraphBytes } }],
    'one caret context read, no mutation leg, no other read leg');
  // READ-ONLY BY CONSTRUCTION: no mutate path is reachable from this descriptor, and the assertion is
  // over the set of write/other methods the bridge actually exposes rather than a claim about intent.
  for (const method of ['insertParagraph', 'applySelection', 'readSelection', 'readContext', 'readDocumentText']) {
    assert.equal(touched.some(entry => entry.method === method), false, `${method} is never reached`);
  }
});

test('read_paragraph forwards the caller signal to its single bridge read', async () => {
  const bridge = caretBridge(CARET_SENTENCE);
  const controller = new AbortController();
  await readParagraph(bridge).execute({}, { editor: 'word', signal: controller.signal });
  assert.deepEqual(bridge.requests, [{ maxBytes: LIMITS.readParagraphBytes, signal: controller.signal }]);
});

test('read_paragraph publishes an entry the runtime serializer accepts, measured exactly', async () => {
  const text = 'я'.repeat(4000);
  const tool = readParagraph(caretBridge(text));
  const result = await tool.execute({}, { editor: 'word' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { scope: 'sentence', text, bytes: 8000 });
  // The measurement is the entry the runtime PUBLISHES — `JSON.stringify({ tool, ...result })` — and it
  // must be inside the same ceiling `stringifyToolResults` enforces, so the model receives the text
  // instead of the literal "the tool result could not be serialized".
  const measured = utf8ByteLength(JSON.stringify({ tool: 'read_paragraph', ...result }));
  assert.ok(measured <= AGENT_CEILINGS.toolResultBytes, `${measured} <= ${AGENT_CEILINGS.toolResultBytes}`);
  const messages = toolResultMessages([{ tool: 'read_paragraph', result }]);
  assert.equal(messages.length, 1);
  const modelVisible = JSON.parse(messages[0].content);
  assert.equal(modelVisible.results[0].tool, 'read_paragraph');
  assert.equal(modelVisible.results[0].ok, true);
  assert.equal(modelVisible.results[0].data.scope, 'sentence', 'the model sees WHAT was read');
  assert.equal(modelVisible.results[0].data.text, text, 'the caret text survives, whole');
  assert.equal(modelVisible.results[0].data.bytes, 8000);
  assert.equal(utf8ByteLength(messages[0].content) <= AGENT_CEILINGS.toolResultBytes + 32, true,
    'the message envelope stays within one entry plus the framing slack');
});

test('read_paragraph refuses a context whose SERIALIZED entry alone is over the ceiling', async () => {
  // The raw byte count is NOT the entry, and this is the case the entry measurement exists for.
  // `JSON.stringify` escapes every C0 control character to TWO characters, so a caret context of 16000
  // newlines is 16000 raw bytes — inside `LIMITS.readParagraphBytes` — and an entry of 32087 bytes, far
  // outside `AGENT_CEILINGS.toolResultBytes`. A tool that measured only the raw text would publish `ok`
  // for an entry the runtime refuses, the model would receive the literal "the tool result could not be
  // serialized" instead of the sentence, and the action log would still claim success.
  const escaped = '\n'.repeat(LIMITS.readParagraphBytes);
  assert.equal(utf8ByteLength(escaped), LIMITS.readParagraphBytes, 'the raw text is inside the text bound');
  assert.ok(utf8ByteLength(JSON.stringify(escaped)) > AGENT_CEILINGS.toolResultBytes,
    'and its serialization is far outside the entry ceiling');
  const control = await readParagraph(caretBridge(escaped)).execute({}, { editor: 'word' });
  assert.equal(control.ok, false, 'the entry, not the raw text, is the enforced bound');
  assert.equal(control.code, 'BYTE_LIMIT');
  assert.equal(JSON.stringify(control).includes('\\n'), false, 'no native text leaks through the refusal');
  // A lone surrogate is the same defect by a different route: three raw UTF-8 bytes, SIX bytes once
  // serialized, so 15000 raw bytes of them make an entry of 30087.
  const lone = '\ud800'.repeat(5000);
  assert.equal(utf8ByteLength(lone), 15000, 'inside the text bound');
  const surrogate = await readParagraph(caretBridge(lone)).execute({}, { editor: 'word' });
  assert.equal(surrogate.ok, false);
  assert.equal(surrogate.code, 'BYTE_LIMIT');
  // And the escape rule is a bound on what is SERVED, not on what is legal: a context whose entries fit
  // is served with its own bytes, escapes and all, and the published entry still serializes.
  const small = await readParagraph(caretBridge('a\nb\tc')).execute({}, { editor: 'word' });
  assert.equal(small.ok, true);
  assert.equal(small.data.text, 'a\nb\tc');
  assert.equal(small.data.bytes, 5);
  assert.doesNotThrow(() => toolResultMessages([{ tool: 'read_paragraph', result: small }]));
});

test('bridge readParagraph dispatches GetCurrentSentence ONCE by name and decodes the sentence', async () => {
  const r = caretRig();
  assert.equal(Object.hasOwn(r.plugin, 'GetCurrentSentence'), false,
    'the caret read is reached by NAME, never as a facade property');
  const pending = r.bridge.readParagraph({ maxBytes: LIMITS.readParagraphBytes });
  assert.equal(typeof pending.then, 'function');
  assert.equal(r.calls.length, 1, 'the caret read is the ONLY native dispatch of this leg');
  assert.equal(r.calls[0].name, 'GetCurrentSentence');
  assert.deepEqual(r.calls[0].params, [], 'the public caret primitive takes no parameters');
  assert.ok(Object.isFrozen(r.calls[0].params));
  assert.equal(r.bridge.getState().busy, true, 'the slot stays owned until the native callback');
  r.calls[0].callback(CARET_SENTENCE);
  const result = await pending;
  assert.deepEqual(result, { ok: true, text: CARET_SENTENCE });
  assert.ok(Object.isFrozen(result));
  assert.equal(r.bridge.getState().busy, false);
  assert.deepEqual(r.calls.map(call => call.name), ['GetCurrentSentence'],
    'exactly one dispatch: no identity probe and no second read');
});

test('bridge readParagraph decodes against the requested budget and closes an oversized answer', async () => {
  const r = caretRig();
  const pending = r.bridge.readParagraph({ maxBytes: 8 });
  assert.equal(r.calls.length, 1);
  r.calls[0].callback('я'.repeat(20)); // 40 UTF-8 bytes, past the 8-byte window
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BYTE_LIMIT');
  assert.equal(JSON.stringify(result).includes('я'), false, 'an oversized native read never leaks');
  assert.equal(r.bridge.getState().busy, false);
});

test('bridge readParagraph refuses a budget or a dispatch channel it cannot use, with no SDK work', async () => {
  for (const raw of [{}, { maxBytes: 0 }, { maxBytes: -1 }, { maxBytes: 1.5 }, { maxBytes: null }, { maxBytes: '8' }]) {
    const r = caretRig();
    const result = await r.bridge.readParagraph(raw);
    assert.equal(result.ok, false, JSON.stringify(raw));
    assert.equal(result.code, 'CAPABILITY_UNAVAILABLE', JSON.stringify(raw));
    assert.deepEqual(r.calls, [], JSON.stringify(raw));
    assert.equal(r.bridge.getState().busy, false);
  }
  const r = caretRig({ dispatchChannel: false });
  assert.equal(typeof r.plugin.executeMethod, 'function', 'a plain typeof would accept the inherited method');
  const result = await r.bridge.readParagraph({ maxBytes: LIMITS.readParagraphBytes });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CAPABILITY_UNAVAILABLE');
  assert.deepEqual(r.calls, [], 'nothing is dispatched by name');
  assert.equal(r.bridge.getState().busy, false);
});

test('bridge readParagraph refuses a pre-aborted signal without any dispatch', async () => {
  const r = caretRig();
  const controller = new AbortController();
  controller.abort();
  const result = await r.bridge.readParagraph({ maxBytes: LIMITS.readParagraphBytes, signal: controller.signal });
  assert.deepEqual(result, { ok: false, code: 'CANCELLED' });
  assert.deepEqual(r.calls, [], 'nothing reaches the editor');
  assert.equal(r.bridge.getState().busy, false);
});

test('read_paragraph is offered with policy auto and a model call dispatches one caret read', async () => {
  const r = caretRig();
  const registry = createRegistry(createWordTools(r.bridge));
  const catalogue = registry.catalogue({ editor: 'word', capabilities: ['document.read', 'document.write'], mode: 'EDIT' });
  const offered = catalogue.find(entry => entry.name === 'read_paragraph');
  assert.ok(offered, 'the offered catalogue contains read_paragraph');
  assert.equal(offered.policy, 'auto');
  assert.equal(offered.kind, 'read');
  assert.equal(offered.requires.includes('document.read'), true);
  const batch = validateBatch(catalogue, [{ tool: 'read_paragraph', arguments: {} }]);
  assert.equal(batch.length, 1);
  assert.equal(batch[0].descriptor.name, 'read_paragraph');
  const responses = ['{"type":"tool_calls","calls":[{"tool":"read_paragraph","arguments":{}}]}',
    '{"type":"final","message":"прочитано"}'];
  let step = 0;
  const pending = runAgent({ registry, editor: 'word', capabilities: ['document.read', 'document.write'], mode: 'EDIT',
    settings: {}, uuid: '22222222-2222-4222-8222-222222222222', request: 'прочитай абзац',
    transport: async () => ({ content: responses[step++] ?? responses[responses.length - 1] }) });
  assert.equal(await untilDispatches(r.calls, 1), 1, 'the caret read is dispatched by the real handler');
  assert.equal(r.calls[0].name, 'GetCurrentSentence');
  r.calls[0].callback(CARET_SENTENCE);
  const run = await pending;
  assert.equal(run.status, 'FINAL');
  assert.deepEqual(run.actions.map(action => [action.tool, action.outcome]), [['read_paragraph', 'ok']]);
  assert.deepEqual(r.calls.map(call => call.name), ['GetCurrentSentence'],
    'one caret read for the whole run, and no write path touched');
  assert.equal(r.bridge.getState().busy, false);
});

