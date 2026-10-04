import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createWordTools } from '../../src/tools/word.js';
import { createRegistry } from '../../src/tools/registry.js';
import { createR7Bridge } from '../../src/plugin/bridge.js';
import { AGENT_CEILINGS, LIMITS } from '../../src/shared/limits.js';
import { utf8ByteLength } from '../../src/shared/bytes.js';

function fakeBridge(overrides = {}) {
  const seen = [];
  return { seen, readSelection: async () => ({ text: 'привет', eligible: true, target: 1 }),
    // The bridge's real insert envelope: the native acknowledgement is the only outcome it carries.
    insertParagraph: async (args) => { seen.push(args); return { ok: true, data: { sent: true } }; },
    canApply: () => true, ...overrides };
}

test('the representative descriptor set is well formed and policy-correct', () => {
  const tools = createWordTools(fakeBridge());
  const names = tools.map(tool => tool.name).sort();
  assert.deepEqual(names, ['insert_paragraph', 'read_context', 'read_selection', 'replace_selection']);
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
    ['insert_paragraph', 'read_selection', 'replace_selection'],
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
  // the three confirmed tools and ASK exposes neither a mutation nor the unverified read.
  assert.deepEqual(edit.map(tool => tool.name).sort(),
    ['insert_paragraph', 'read_selection', 'replace_selection']);
  assert.deepEqual(ask.map(tool => tool.name), ['read_selection']);
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
  const bridge = createR7Bridge(plugin, { editorType: 'word', clock: { now: () => 0 },
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
  const bridge = createR7Bridge(plugin, { editorType: 'word', clock: { now: () => 0 }, timers: { schedule() { return {}; }, clear() {} } });
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
