import test from 'node:test';
import assert from 'node:assert/strict';
import { createR7Bridge } from '../../src/plugin/bridge.js';
import { createController } from '../../src/ui/controller.js';
import { SettingsStore } from '../../src/config/storage.js';
import { htmlPlatform } from '../fixtures/html-document.js';

// The insert confirmation counts in the document's DECODED TEXT, so every bridge in this file is handed
// the platform boundary the plugin page supplies (the fixture stands in for the browser's inert
// container parse). Nothing here depends on a browser global.
const platformBoundary = htmlPlatform();
function bridgeWith(plugin, options) { return createR7Bridge(plugin, { ...options, platform: platformBoundary }); }

// --- the target build's dispatch API: `executeCommand` vs `callCommand` ---------------------------
// Measured on the exact target (Astra Linux + R7-Office 2026.1.2.1942): the plugin object exposes
// `executeCommand` and `executeMethod` but NOT `callCommand`; on Windows R7-Office 2026.3.1 both
// exist. `adapter.commandDispatch` used to resolve ONLY `callCommand`, so on the target the runtime was
// never verified, the panel fell back to the legacy flow, and the write path refused with the authored
// CAPABILITY_UNAVAILABLE instead of dispatching.
//
// The rule this file pins is EXPLICIT, because the two natives are NOT interchangeable in general:
//   * `executeMethod` is the METHOD channel (`{type:'method', methodName, data}`); it is what the
//     insert's irreversible `PasteText` dispatch actually needs, and BOTH builds expose it.
//   * `callCommand` and `executeCommand` are the COMMAND channel. `callCommand` wraps an author-written
//     function body into the command message; `executeCommand` sends that message (the installed
//     2026.1.2 vendor SDK composes exactly the one out of the other). The bridge keeps using
//     `callCommand` whenever the build exposes it — the measured-working Windows path, called with
//     exactly the arguments it receives today — and falls back to `executeCommand` only when it does
//     not.
//   * A build exposing NEITHER command method still refuses honestly (CAPABILITY_UNAVAILABLE) before
//     any native dispatch. Nothing here invents an API that is not on the facade.
// So `adapter.commandDispatch` is true when EITHER command entry point is an own function, and the
// command dispatch selects `callCommand` first and `executeCommand` second.
//
// The fixture below is the pure transport: it records which native carried the command and the exact
// value it was handed, and it answers by executing the AUTHORED body it received (never source text,
// never a string-to-code conversion). The `executeCommand` shape is answered with the same public
// `Api` facade results, because the composed source it carries is the statement form of that body.

function commandApi() {
  return {
    GetDocumentId() { return 'bounded-id'; },
    GetDocument() { return { GetRangeBySelect() {}, IsTrackRevisions() { return false; } }; },
    ReplaceTextSmart() {}
  };
}
function runAuthored(body, api) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'Api');
  globalThis.Api = api;
  try { return body(); }
  finally { if (previous) Object.defineProperty(globalThis, 'Api', previous); else delete globalThis.Api; }
}
// Which authored body a carried value is. The `callCommand` shape receives a fresh wrapper whose own
// name is the body it forwards to; the `executeCommand` shape receives the composed source text.
function carriedWhich(value) {
  const text = typeof value === 'function' ? (value.name || Function.prototype.toString.call(value)) : String(value);
  return text.includes('capabilityBody') || text.includes('CAPABILITY_UNAVAILABLE') ? 'capability' : 'context';
}
// The composed command source carries the author-written body as text in the form the vendor
// `callCommand` builds: `var Asc = {}; var scope = Asc.scope; (<body>)();`.
function assertComposedSource(source) {
  assert.equal(typeof source, 'string', 'executeCommand carries the composed command source, never a function object');
  assert.ok(source.startsWith('var Asc = {}; \n  var scope = Asc.scope;\n  ('), 'the vendor command wrapper is reproduced');
  assert.ok(source.endsWith(')();\n  '), 'the body is invoked exactly as callCommand invokes it');
}
// The native's own answer for a carried body: the four-slot identity tuple for the context body, the
// six presence booleans for the capability body the reviewed static probe returns.
function commandAnswer(which) {
  return which === 'capability' ? [true, true, true, true, true, true] : ['bounded-id', true, true, false];
}

// A plugin fixture whose command channel can be switched to the measured build shapes:
//   'both'           — callCommand AND executeCommand (Windows 2026.3.1)
//   'callCommand'    — only the wrapper
//   'executeCommand' — only the transport (the target Astra build)
//   'neither'        — no command channel at all
function dispatchRig(command) {
  const calls = []; const commands = [];
  const api = commandApi();
  const plugin = {
    info: { editorType: 'word' },
    executeMethod(name, params, callback) { calls.push([name, params, callback]); return false; },
    callCommand: (command === 'both' || command === 'callCommand')
      ? function (body, close, recalculate, callback) {
        commands.push({ by: 'callCommand', body, close, recalculate, which: carriedWhich(body) });
        callback(runAuthored(body, api));
        return false;
      } : undefined,
    executeCommand: (command === 'both' || command === 'executeCommand')
      ? function (commandName, source, callback) {
        const which = carriedWhich(source);
        commands.push({ by: 'executeCommand', commandName, source, which });
        callback(commandAnswer(which));
        return false;
      } : undefined
  };
  const bridge = bridgeWith(plugin, { editorType: 'word' });
  return { bridge, commands, calls,
    pastes: () => calls.filter(call => call[0] === 'PasteText') };
}
const presence = expected => ({ api: true, getDocument: true, getDocumentId: expected, replaceTextSmart: true, getRangeBySelect: true, isTrackRevisions: expected });

test('a plugin exposing only executeCommand verifies the runtime through its own command transport', async () => {
  const r = dispatchRig('executeCommand');
  const capabilities = await r.bridge.probeCapabilities();
  assert.equal(r.commands.length, 1, 'exactly one presence command is dispatched');
  assert.equal(r.commands[0].by, 'executeCommand', 'the only command entry point the build has is used');
  assert.equal(r.commands[0].commandName, 'command', 'the command channel is addressed by its own name');
  assert.equal(r.commands[0].which, 'capability', 'the presence body is the one carried');
  assertComposedSource(r.commands[0].source);
  assert.deepEqual(capabilities.methodPresence, presence(true), 'the build native presence signal is decoded, not fabricated');
  assert.equal(capabilities.runtimeVerified, false, 'presence is never promoted to runtime proof');
  assert.equal(capabilities.mutation.available, false);
  assert.equal(capabilities.adapter.executeMethod, true);
  assert.equal(capabilities.adapter.commandDispatch, true);
  assert.equal(capabilities.adapter.commandMethod, 'executeCommand');
});

test('a plugin exposing only callCommand keeps the measured Windows path unchanged', async () => {
  const r = dispatchRig('callCommand');
  const capabilities = await r.bridge.probeCapabilities();
  assert.equal(r.commands.length, 1);
  assert.equal(r.commands[0].by, 'callCommand', 'the wrapper is preferred exactly as before');
  assert.equal(r.commands[0].close, false, 'its documented close/recalculate arguments are unchanged');
  assert.equal(r.commands[0].recalculate, false);
  assert.equal(typeof r.commands[0].body, 'function', 'the wrapper still receives the author-written function itself');
  const authored = Function.prototype.toString.call(r.commands[0].body);
  assert.equal(/^(async\s|function\s*\*)/.test(authored), false, 'the body stays synchronous and is not a generator');
  assert.deepEqual(capabilities.methodPresence, presence(true));
  assert.equal(capabilities.adapter.commandMethod, 'callCommand');
});

test('a plugin exposing both keeps using callCommand: the Windows behaviour does not change', async () => {
  const r = dispatchRig('both');
  const capabilities = await r.bridge.probeCapabilities();
  assert.equal(r.commands.length, 1);
  assert.equal(r.commands[0].by, 'callCommand', 'an added executeCommand never displaces the working wrapper');
  assert.equal(r.commands.some(entry => entry.by === 'executeCommand'), false);
  assert.deepEqual(capabilities.methodPresence, presence(true));
  assert.equal(capabilities.adapter.commandMethod, 'callCommand');
});

test('a plugin exposing neither command method still refuses honestly without dispatching', async () => {
  const r = dispatchRig('neither');
  const capabilities = await r.bridge.probeCapabilities();
  assert.equal(r.commands.length, 0, 'no command is dispatched on a build that cannot carry one');
  assert.equal(r.calls.length, 0, 'and no method either');
  assert.equal(capabilities.methodPresence, null, 'no presence is claimed, so no capability is fabricated');
  assert.equal(capabilities.runtimeVerified, false);
  assert.equal(capabilities.adapter.commandDispatch, false);
  assert.equal(capabilities.adapter.commandMethod, null);
  assert.equal(capabilities.mutation.available, false, 'and the mutation stays unavailable');
});

test('the presence body observes presence only: no identity call, no selection read, no write', async () => {
  const calls = [];
  // Every `Api` member the presence body must NOT invoke is a tripwire. The body may INSPECT these
  // members (`typeof Api.GetDocumentId === 'function`), so even one invocation fails this test.
  const forbidden = name => () => { calls.push(name); throw new Error('private'); };
  const api = { GetDocument: () => ({ GetRangeBySelect: forbidden('range'), IsTrackRevisions: forbidden('tracking') }),
    GetDocumentId: forbidden('id'), ReplaceTextSmart: forbidden('replace') };
  let carried = null;
  const plugin = { info: { editorType: 'word' },
    executeMethod(name) { calls.push(name); return false; },
    callCommand(body, _close, _recalculate, callback) {
      carried = body;
      const previous = Object.getOwnPropertyDescriptor(globalThis, 'Api');
      globalThis.Api = api;
      try { callback(body()); } finally { if (previous) Object.defineProperty(globalThis, 'Api', previous); else delete globalThis.Api; }
      return false;
    } };
  const bridge = bridgeWith(plugin, { editorType: 'word' });
  const result = await bridge.probeCapabilities();
  assert.deepEqual(result.methodPresence, presence(true), 'the facade is inspected as an object of methods, never invoked');
  assert.equal(carriedWhich(carried), 'capability', 'the presence body is the one dispatched by the capability probe');
  assert.deepEqual(calls, [], 'the presence body invokes no identity/selection/write method');
});

// --- the target shape through the PRODUCT path, not only through one bridge method ----------------
// The insert's irreversible dispatch has always been `executeMethod('PasteText', …)` and it stays that
// way on both builds; what the command channel carries is the document-identity leg and the presence
// gate. The tests below pin that every command shape reaches that dispatch, and that a build with no
// command channel never reaches a write at all.
function productRig(command) {
  let time = 0; const tasks = new Map();
  const selections = []; const html = []; const inserts = []; const commands = [];
  const timers = { schedule(fn, ms) { const key = {}; tasks.set(key, { fn, at: time + ms }); return key; }, clear(key) { tasks.delete(key); } };
  const clock = { now() { return time; } };
  const api = commandApi();
  const plugin = { info: { editorType: 'word' },
    executeMethod(name, args, callback) {
      if (name === 'GetSelectedText') { selections.push({ args, callback }); return false; }
      if (name === 'GetFileHTML') { html.push({ args, callback }); return false; }
      if (name === 'PasteText') { inserts.push({ args, callback }); return false; }
      throw new Error(`unexpected native method ${name}`);
    },
    callCommand: (command === 'both' || command === 'callCommand')
      ? function (body, _close, _recalculate, callback) {
        commands.push(carriedWhich(body));
        callback(runAuthored(body, api));
        return false;
      } : undefined,
    executeCommand: (command === 'both' || command === 'executeCommand')
      ? function (name, source, callback) {
        const which = carriedWhich(source);
        commands.push(`${name}:${which}`);
        callback(commandAnswer(which));
        return false;
      } : undefined };
  const bridge = bridgeWith(plugin, { editorType: 'word', timers, clock });
  return { bridge, commands, selections, html, inserts };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

for (const command of ['executeCommand', 'callCommand', 'both']) {
  test(`the ${command} build shape reaches the insert: identity on the command channel, paste still on executeMethod`, async () => {
    const r = productRig(command);
    const pending = r.bridge.insertParagraph({ text: 'Абзац' });
    await tick();
    assert.deepEqual(r.commands, [command === 'executeCommand' ? 'command:context' : 'context'],
      'the document identity leg ran on the command channel the build has');
    assert.equal(r.html.length, 1, 'and the document baseline followed, on the method channel');
    assert.deepEqual(r.html[0].args, {}, 'the same public document read both builds resolve');
    assert.equal(r.inserts.length, 0, 'no write is dispatched before the baseline answered');
    r.html[0].callback('<p>стар</p>');
    assert.equal(r.inserts.length, 1, 'the irreversible paste is dispatched exactly once, through executeMethod');
    assert.deepEqual(r.inserts[0].args, ['Абзац']);
    r.inserts[0].callback(true);
    assert.deepEqual(await pending, { ok: true, data: { sent: true } });
    assert.equal(r.selections.length, 0, 'the insert path never reads the caret scope');
  });
}

test('the callCommand build confirms a void acknowledgement by a document delta, unchanged by the fallback', async () => {
  // The Windows control: on the measured-working shape (`callCommand` present, `executeCommand` also
  // present) the command channel is untouched AND the new document-delta rule runs end to end.
  const r = productRig('both');
  const pending = r.bridge.insertParagraph({ text: 'Абзац' });
  await tick();
  assert.deepEqual(r.commands, ['context'], 'the wrapper still carries the identity leg');
  assert.equal(r.html.length, 1);
  r.html[0].callback('<p>стар</p>');
  assert.equal(r.inserts.length, 1);
  r.inserts[0].callback(undefined);
  assert.equal(r.html.length, 2, 'the void acknowledgement starts one confirmation read');
  r.html[1].callback('<p>стар</p><p>Абзац</p>');
  assert.deepEqual(await pending, { ok: true, data: { sent: true, effectVerified: true } });
  assert.equal(r.html.length, 2, 'exactly one baseline and one confirmation read');
  assert.equal(r.inserts.length, 1, 'the mutation is never retried');
});

test('a build with no command channel refuses the insert before any write', async () => {
  const r = productRig('neither');
  assert.deepEqual(await r.bridge.insertParagraph({ text: 'Абзац' }), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
  assert.equal(r.inserts.length, 0, 'a build that cannot dispatch must not be handed a write');
  assert.equal(r.bridge.getState().busy, false, 'and its slot is released');
});

test('the panel capability action reports presence on the executeCommand-only shape', async () => {
  let time = 0; const tasks = new Map();
  const timers = { schedule(fn, ms) { const key = {}; tasks.set(key, { fn, at: time + ms }); return key; }, clear(key) { tasks.delete(key); } };
  const clock = { now() { return time; } };
  const plugin = { info: { editorType: 'word' },
    executeMethod() { throw new Error('the presence probe must not read selection'); },
    executeCommand(_name, source, callback) { callback(commandAnswer(carriedWhich(source))); return false; } };
  const bridge = bridgeWith(plugin, { editorType: 'word', timers, clock });
  const controller = createController({ bridge, timers, clock, store: new SettingsStore(null),
    crypto: { randomUUID() { return '00000000-0000-4000-8000-000000000001'; } },
    transport: async () => { throw new Error('no HTTP for a capability probe'); } });
  assert.equal(await controller.checkR7(), true, 'the read-only action completes on the target shape');
  const state = controller.getState();
  assert.equal(state.status, 'R7_PRESENCE_READY');
  assert.equal(state.capabilityCount, 6);
  assert.equal(state.runtimeVerified, false, 'the panel still never promotes presence to runtime proof');
  controller.dispose();
});

// --- the carried function must survive STRINGIFICATION: the EDITOR evaluates it, not this module ----
// A native `callCommand` never calls the function it is handed. It stringifies it and evaluates the
// TEXT inside the editor, where none of bridge.js's module bindings exist. A wrapper that closes over
// a module-scope const (`() => contextBody()`) therefore cannot run there at all: measured on the live
// Windows R7-Office 2026.3.1 the editor raised `ReferenceError: contextBody is not defined` out of its
// own `sdk-all-min.js` evaluator, the insert died before the model was ever called, and the run's
// network capture was empty. Every rig above invokes the carried body IN this module's scope, so a
// call-SHAPE assertion (a function was passed) could never see it — evaluability is the gate, and this
// section reproduces the editor's own evaluation.
//
// `new Function` compiles the text in a fresh, module-free scope: the closest local stand-in for the
// editor's evaluator. Dynamic code is legitimate HERE — the authored static audit scans src/, scripts
// and shipped artifacts, never tests — and a test that proves evaluability needs the real evaluator.
function evaluateCarried(sourceText, api) {
  return new Function('Api', 'return (\n' + sourceText + '\n)();')(api);
}
// A recording facade for the `callCommand` shape: it captures the EXACT value the bridge hands the
// native (never calling it as a closure) and answers the method legs the surrounding operation needs.
function carriedRig(command = 'callCommand') {
  const commands = [];
  const api = commandApi();
  const plugin = { info: { editorType: 'word' },
    executeMethod(name, _params, callback) { if (name === 'GetSelectedText') callback('выделено'); return false; },
    callCommand: (command === 'both' || command === 'callCommand')
      ? function (body, _close, _recalculate, callback) {
        commands.push({ by: 'callCommand', source: Function.prototype.toString.call(body) });
        callback(runAuthored(body, api));
        return false;
      } : undefined,
    executeCommand: (command === 'both' || command === 'executeCommand')
      ? function (name, source, callback) {
        commands.push({ by: 'executeCommand', source });
        callback(commandAnswer(carriedWhich(source)));
        return false;
      } : undefined };
  const bridge = bridgeWith(plugin, { editorType: 'word' });
  return { bridge, commands };
}

test('what callCommand receives is evaluable in the editor scope: no module binding is referenced', async () => {
  const r = carriedRig();
  await r.bridge.probeCapabilities();  // the presence leg carries the capability body
  await r.bridge.readSelection();      // the identity leg carries the context body
  assert.equal(r.commands.length, 2, 'both author-written bodies were handed to the native');
  const [capability, context] = r.commands;
  assert.equal(r.commands.every(entry => entry.by === 'callCommand'), true, 'the measured Windows channel is the one measured here');
  for (const [label, carried, expected] of [
    ['capability', capability, [true, true, true, true, true, true]],
    ['context', context, ['bounded-id', true, true, false]]
  ]) {
    // The editor's own evaluation, FIRST: this is the failure a native run reported. A free module
    // identifier resolves to nothing here and the whole call dies, exactly as it did on 2026.3.1.
    let value;
    try { value = evaluateCarried(carried.source, commandApi()); }
    catch (error) {
      assert.fail(`the ${label} body stringified for callCommand must run in the editor's scope (no module bindings), but evaluating it raised: ${error}`);
    }
    assert.deepEqual(value, expected, `the ${label} body answers with its authored tuple in a fresh scope`);
    // And structurally: the text that reaches the editor names no module-scope command body at all.
    assert.equal(/\b(?:capability|context)Body\b/.test(carried.source), false,
      `the stringified ${label} body must be self-contained, not a closure over bridge.js`);
  }
});

test('the executeCommand fallback source is self-contained as well', async () => {
  const r = carriedRig('executeCommand');
  await r.bridge.probeCapabilities();
  await r.bridge.readSelection();
  assert.equal(r.commands.length, 2);
  const [capability, context] = r.commands;
  assert.equal(r.commands.every(entry => entry.by === 'executeCommand'), true);
  for (const [label, carried, expected] of [
    ['capability', capability, [true, true, true, true, true, true]],
    ['context', context, ['bounded-id', true, true, false]]
  ]) {
    assertComposedSource(carried.source);
    // The WHOLE composed statement list must run in a fresh scope without a ReferenceError...
    assert.doesNotThrow(() => new Function('Api', carried.source)(commandApi()),
      `the composed ${label} source must be evaluable in the editor's scope`);
    // ...and the body inside it must answer with the authored tuple.
    const body = carried.source.slice(
      'var Asc = {}; \n  var scope = Asc.scope;\n  ('.length,
      carried.source.length - ')();\n  '.length);
    assert.equal(/\b(?:capability|context)Body\b/.test(body), false, `the composed ${label} body names no module binding`);
    assert.deepEqual(evaluateCarried(body, commandApi()), expected, `the composed ${label} body is self-contained`);
  }
});

// --- the SEARCH leg's command body: the `Api` builder inside a static authored literal ------------
// `find_text` is the first READ that goes through the `Api` builder inside a command body, and it is
// the first body that must carry MODEL DATA. Both facts are pinned here:
//   * the body is a SELF-CONTAINED static literal. `callCommand` does not call it — it stringifies it
//     and evaluates the text inside the editor, where none of bridge.js's module bindings exist
//     (`ReferenceError: contextBody is not defined`, measured natively on 2026.3.1, commit 273d70e).
//     The rig below therefore evaluates `Function.prototype.toString` of the carried body in a FRESH
//     scope whose only bindings are the two the vendor's own wrapper creates: `Api` (the editor's
//     global facade) and `scope` (the JSON of `Asc.scope`).
//   * the model data crosses as the SCOPE, never interpolated into the source (ADR 0002). There is no
//     composed-source transport for this leg at all: the wrapper that turns `Asc.scope` into the body's
//     `scope` binding belongs to `callCommand`, so a build without it refuses before any dispatch.
const SEARCH_MARKER = 'МАРКЕР-ПОИСК';
const SEARCH_MARKER_LOWER = 'маркер-поиск';
// The MEASURED primitive (Astra / R7 2026.1.2.1942): `Api.GetDocument().Search(needle, matchCase)`
// returns a REAL Array of range-shaped objects whose `GetText()` is the match's own text.
function searchApi(occurrences) {
  return { GetDocument() { return { Search(needle, matchCase) { return occurrences
    .filter(text => matchCase ? text === needle : text.toLowerCase() === needle.toLowerCase())
    .map(text => ({ GetClassType() { return 'range'; }, GetText() { return text; } })); } }; } };
}
const searchOccurrences = [SEARCH_MARKER, SEARCH_MARKER, SEARCH_MARKER, SEARCH_MARKER, SEARCH_MARKER_LOWER];
function searchCarriedRig() {
  const commands = [];
  // The plugin page's OWN namespace object: the vendor wrapper reads `window.Asc.scope` from it.
  const namespace = { scope: undefined };
  const api = searchApi(searchOccurrences);
  const plugin = { info: { editorType: 'word' },
    callCommand: function (body, close, recalculate, callback) {
      const source = Function.prototype.toString.call(body);
      const scope = namespace.scope;
      commands.push({ by: 'callCommand', source, scope, close, recalculate });
      callback(new Function('Api', 'scope', 'return (\n' + source + '\n)();')(api, scope));
      return false;
    } };
  const bridge = createR7Bridge(plugin, { editorType: 'word', ascNamespace: namespace, platform: platformBoundary });
  return { bridge, commands, namespace, api };
}

test('the search body handed to callCommand runs in the editor scope and reads the needle from the scope', async () => {
  const r = searchCarriedRig();
  const pending = r.bridge.findText({ query: SEARCH_MARKER, matchCase: true, limit: 8 });
  assert.equal(r.commands.length, 1, 'ONE command carries the whole search');
  const carried = r.commands[0];
  assert.equal(carried.by, 'callCommand');
  assert.equal(carried.close, false, 'the wrapper arguments are unchanged');
  assert.equal(carried.recalculate, false);
  assert.deepEqual(carried.scope, { query: SEARCH_MARKER, matchCase: true, limit: 8 },
    'the model data is the SCOPE the vendor wrapper injects, never source text');
  // Structural: the text that reaches the editor names no module-scope binding of bridge.js.
  assert.equal(/\b(?:capabilityBody|contextBody|commandTransport|createCommandDispatch|decodeSearch|pluginOwners|createR7Bridge)\b/.test(carried.source),
    false, 'the stringified body must be self-contained, not a closure over bridge.js');
  // The editor's own evaluation, FIRST and independently of the bridge: a free module identifier
  // resolves to nothing in this scope and the whole call dies, exactly as it did on 2026.3.1.
  let value;
  try { value = new Function('Api', 'scope', 'return (\n' + carried.source + '\n)();')(r.api, carried.scope); }
  catch (error) { assert.fail(`the search body must run in the editor's scope (no module bindings), but evaluating it raised: ${error}`); }
  assert.deepEqual(value, [4, SEARCH_MARKER, SEARCH_MARKER, SEARCH_MARKER, SEARCH_MARKER],
    'the body answers the measured strict count and each match\u2019s own text');
  assert.deepEqual(await pending, { ok: true, count: 4, texts: [SEARCH_MARKER, SEARCH_MARKER, SEARCH_MARKER, SEARCH_MARKER] });
});

test('the search body answers the measured native shapes in a fresh, module-free scope', async () => {
  const body = async (query, matchCase, limit) => {
    const r = searchCarriedRig();
    const pending = r.bridge.findText({ query, matchCase, limit });
    return { carried: r.commands[0], result: await pending };
  };
  // The strict needle: four occurrences. The case-insensitive one: five — the fifth is the document's
  // own lowercase spelling, which the body republishes verbatim. A needle the document does not hold:
  // an EMPTY array, which the body turns into `[0]` — the count alone, with no texts to extract.
  const strict = await body(SEARCH_MARKER, true, 8);
  assert.deepEqual(strict.result.texts, [SEARCH_MARKER, SEARCH_MARKER, SEARCH_MARKER, SEARCH_MARKER]);
  const loose = await body(SEARCH_MARKER_LOWER, false, 8);
  assert.equal(loose.result.count, 5);
  assert.equal(loose.result.texts[4], SEARCH_MARKER_LOWER);
  const missing = await body('НЕТ-ТАКОГО-СЛОВА-12345', true, 8);
  assert.deepEqual(missing.result, { ok: true, count: 0, texts: [] });
  const evaluated = new Function('Api', 'scope', 'return (\n' + missing.carried.source + '\n)();')(searchApi([]), missing.carried.scope);
  assert.deepEqual(evaluated, [0], 'the empty answer is the count alone, never a null the decoder must guess at');
  // The LIMIT is enforced INSIDE the editor: the body extracts at most `limit` texts while the count it
  // reports stays the primitive's own total, so a thousand-match search never crosses a thousand texts.
  const bounded = await body(SEARCH_MARKER, true, 2);
  assert.deepEqual(bounded.result, { ok: true, count: 4, texts: [SEARCH_MARKER, SEARCH_MARKER] });
});

test('a search on a build without callCommand refuses before any dispatch: no composed-source transport', async () => {
  // The `executeCommand` transport cannot carry a parameter scope the sanctioned way (it takes a source
  // STRING, and composing model data into command source is forbidden by ADR 0002), and the wrapper
  // that turns `Asc.scope` into a binding belongs to `callCommand`. The refusal is therefore the closed
  // capability class, taken BEFORE anything is dispatched — never a search of the wrong needle.
  const carried = [];
  const plugin = { info: { editorType: 'word' }, executeCommand(name, source) { carried.push({ name, source }); return false; } };
  const bridge = createR7Bridge(plugin, { editorType: 'word', ascNamespace: { scope: undefined }, platform: platformBoundary });
  assert.equal(bridge.getState().editorType, 'word');
  assert.deepEqual(await bridge.findText({ query: SEARCH_MARKER, matchCase: true, limit: 8 }),
    { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
  assert.deepEqual(carried, [], 'nothing at all reaches the bare transport');
  assert.equal(bridge.getState().busy, false, 'and the slot is released');
});
