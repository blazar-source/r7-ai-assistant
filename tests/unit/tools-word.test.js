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

// A COMMENT-STRIPPED view of an authored command body, for the leg/route classifiers in this file. They are
// TEXT matches over the stringified body, and these bodies are densely commented, so a body that DROPPED a
// call while KEEPING the sentence that names it — a route note such as `document.Push(…)` or
// `Api.CreateTable(…)` next to the code that used to make the call — satisfied the same match as the living
// call and was classified as the old leg. Stripping line and block comments first makes the matches see CODE
// only; string literals are preserved, so a `//` or `/*` inside a string is never mistaken for a comment.
function withoutComments(source) {
  let out = '';
  let quote = null;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (quote !== null) {
      out += char;
      if (char === '\\') { out += next === undefined ? '' : next; index += 1; }
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; out += char; continue; }
    if (char === '/' && next === '/') { while (index < source.length && source[index] !== '\n') index += 1; out += '\n'; continue; }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1;
      index += 1;
      out += ' ';
      continue;
    }
    out += char;
  }
  return out;
}

function fakeBridge(overrides = {}) {
  const seen = [];
  return { seen, readSelection: async () => ({ text: 'привет', eligible: true, target: 1 }),
    // The bridge's real document-read envelope: the decoded text and its whole character count.
    readDocumentText: async () => ({ ok: true, text: 'привет', totalChars: 6 }),
    // The bridge's real insert envelope: the native acknowledgement is the only outcome it carries.
    insertParagraph: async (args) => { seen.push(args); return { ok: true, data: { sent: true } }; },
    // The bridge's real heading envelope: the two counts the delta was decided on and the body's own four
    // flags, exactly the six fields `setHeading` publishes.
    setHeading: async (args) => { seen.push(args); return { ok: true, headingsBefore: 3, headingsAfter: 4,
      targetAdded: true, textUnchanged: true, styleRead: true, styleMatches: true }; },
    canApply: () => true, ...overrides };
}

test('the representative descriptor set is well formed and policy-correct', () => {
  const tools = createWordTools(fakeBridge());
  const names = tools.map(tool => tool.name).sort();
  assert.deepEqual(names, ['find_text', 'insert_blocks', 'insert_paragraph', 'insert_table', 'read_context', 'read_document_text', 'read_paragraph', 'read_selection', 'read_structure', 'replace_selection', 'set_heading']);
  assert.equal(tools.find(tool => tool.name === 'insert_paragraph').policy, 'auto');
  assert.equal(tools.find(tool => tool.name === 'insert_blocks').policy, 'auto');
  assert.equal(tools.find(tool => tool.name === 'insert_blocks').kind, 'mutate');
  assert.equal(tools.find(tool => tool.name === 'insert_table').policy, 'auto');
  assert.equal(tools.find(tool => tool.name === 'insert_table').kind, 'mutate');
  assert.equal(tools.find(tool => tool.name === 'set_heading').policy, 'auto');
  assert.equal(tools.find(tool => tool.name === 'set_heading').kind, 'mutate');
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
    ['find_text', 'insert_blocks', 'insert_paragraph', 'insert_table', 'read_document_text', 'read_paragraph', 'read_selection', 'read_structure', 'replace_selection', 'set_heading'],
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

// --- `read_selection` is bounded by the SERIALIZED entry, exactly like the other reads --------------
//
// The runtime bounds ONE tool-result entry — `JSON.stringify({ tool, ...result })` — by
// `AGENT_CEILINGS.toolResultBytes` (16384): `stringifyToolResults` (src/agent/protocol.js:91) refuses an
// entry above it and `runtime.js:27-36` replaces the whole result with the literal "the tool result could
// not be serialized", so the model receives NO text while the run's action log still records `ok` — a
// fail-open signal for exactly the selections the ceiling exists to refuse. Bounding the raw text alone
// cannot see that: `JSON.stringify` escapes every C0 control character to TWO characters and every lone
// surrogate to SIX, so a selection inside `contextReadBytes.selection` (8192 raw bytes) can serialize to
// an entry far outside the ceiling.
function selectionBridge(text, extras = {}) {
  const requests = [];
  return { requests, readSelection: async (request) => { requests.push(request); return { eligible: true, text }; }, ...extras };
}
function readSelection(bridge) { return createWordTools(bridge).find(entry => entry.name === 'read_selection'); }

test('read_selection publishes an entry the runtime serializer accepts, measured exactly', async () => {
  // CHARACTERIZATION, not a reproduction of the fix: this 2000-character `read_selection` result, its
  // entry and every legal `ok` below are inside the ceiling BEFORE the entry measurement existed, so this
  // test passed on the pre-fix tree as well. It pins the entry shape the runtime really accepts; the
  // three tests that follow carry the RED — the over-ceiling selection, the boundary walk, and the
  // loop-level refusal.
  const text = 'я'.repeat(2000);
  const bridge = selectionBridge(text);
  const result = await readSelection(bridge).execute({}, { editor: 'word' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { text, bytes: 4000 });
  assert.deepEqual(bridge.requests, [{}], 'the selection read makes one bridge call and no arguments');
  // The measurement is the entry the runtime PUBLISHES — `JSON.stringify({ tool, ...result })` — and it
  // must be inside the same ceiling `stringifyToolResults` enforces, so the model receives the selection
  // instead of the literal "the tool result could not be serialized".
  const measured = utf8ByteLength(JSON.stringify({ tool: 'read_selection', ...result }));
  assert.ok(measured <= AGENT_CEILINGS.toolResultBytes, `${measured} <= ${AGENT_CEILINGS.toolResultBytes}`);
  const messages = toolResultMessages([{ tool: 'read_selection', result }]);
  assert.equal(messages.length, 1);
  const modelVisible = JSON.parse(messages[0].content);
  assert.equal(modelVisible.results[0].tool, 'read_selection');
  assert.equal(modelVisible.results[0].data.text, text, 'the selection survives, whole');
  assert.equal(modelVisible.results[0].data.bytes, 4000);
  assert.equal(utf8ByteLength(messages[0].content) <= AGENT_CEILINGS.toolResultBytes + 32, true,
    'the message envelope stays within one entry plus the framing slack');
  // Every legal call whose own bound admits it must publish an `ok` the serializer ACCEPTS: the walk
  // covers the escape-heavy shapes the entry ceiling really bites on, on both sides of the boundary.
  for (const length of [1, 2, 100, 4095, 4096]) {
    const walkResult = await readSelection(selectionBridge('я'.repeat(length))).execute({}, { editor: 'word' });
    assert.equal(walkResult.ok, true, `Cyrillic length ${length}`);
    assert.doesNotThrow(() => toolResultMessages([{ tool: 'read_selection', result: walkResult }]),
      `Cyrillic length ${length} must serialize inside the ceiling`);
  }
});

test('read_selection refuses a selection whose SERIALIZED entry alone is over the ceiling', async () => {
  // THE REVIEWER'S EXACT REPRODUCTION. A selection of 8192 newlines is 8192 RAW bytes — inside
  // `contextReadBytes.selection` — and its published entry is 16451 bytes: 16384 escaped characters plus
  // the 67-byte envelope. `toolResultMessages` (the runtime serializer) throws on it, so a handler that
  // measured only the raw text would publish `ok` for a result the runtime replaces with the literal
  // "the tool result could not be serialized".
  const text = '\n'.repeat(AGENT_CEILINGS.contextReadBytes.selection);
  assert.equal(AGENT_CEILINGS.contextReadBytes.selection, 8192);
  assert.equal(utf8ByteLength(text), 8192, 'the raw text is inside the text bound');
  const entry = utf8ByteLength(JSON.stringify({ tool: 'read_selection', ok: true, data: { text, bytes: 8192 } }));
  assert.equal(entry, 16451, 'the reviewer measured 16451 on this exact shape');
  assert.ok(entry > AGENT_CEILINGS.toolResultBytes, 'and the entry is outside the result ceiling');
  assert.throws(() => toolResultMessages([{ tool: 'read_selection', result: { ok: true, data: { text, bytes: 8192 } } }]),
    /TOOL_ERROR/, 'the runtime serializer really refuses that entry');
  const result = await readSelection(selectionBridge(text)).execute({}, { editor: 'word' });
  assert.equal(result.ok, false, 'the entry, not the raw text, is the enforced bound');
  assert.equal(result.code, 'BYTE_LIMIT', 'the closed refusal, never an `ok` the model does not receive');
  assert.equal(result.message, 'отказ');
  assert.equal(result.data, undefined, 'a refusal carries no document text at all');
  assert.equal(JSON.stringify(result).includes('\n'), false, 'no native text leaks through the refusal');
  assert.equal(JSON.stringify(result).includes('could not be serialized'), false);
  // The same defect by the other route: a lone surrogate is three raw UTF-8 bytes and SIX once
  // serialized, so 2730 of them are 8190 raw bytes and a 16447-byte entry.
  const lone = '\ud800'.repeat(2730);
  assert.equal(utf8ByteLength(lone), 8190, 'inside the text bound');
  assert.equal(utf8ByteLength(JSON.stringify({ tool: 'read_selection', ok: true, data: { text: lone, bytes: 8190 } })), 16447);
  const surrogate = await readSelection(selectionBridge(lone)).execute({}, { editor: 'word' });
  assert.equal(surrogate.ok, false);
  assert.equal(surrogate.code, 'BYTE_LIMIT');
  assert.equal(surrogate.data, undefined, 'a refusal carries no document text at all');
});

test('no read_selection ok result can exceed the runtime result ceiling', async () => {
  // The invariant, not a spot check: for every candidate shape, an `ok` answer must survive the real
  // runtime serializer, and an answer that cannot is a closed refusal that carries no document text.
  const candidates = ['a'.repeat(8192), 'a'.repeat(8193), '\n'.repeat(8158), '\n'.repeat(8159),
    '\n'.repeat(8192), '\ud800'.repeat(2719), '\ud800'.repeat(2720), 'я'.repeat(4096), 'я'.repeat(4097),
    '漢'.repeat(2730), '漢'.repeat(2731), `a${'\n'.repeat(100)}b`, 'a\nb\tc'];
  let served = 0;
  for (const text of candidates) {
    const result = await readSelection(selectionBridge(text)).execute({}, { editor: 'word' });
    if (result.ok) {
      served += 1;
      const measured = utf8ByteLength(JSON.stringify({ tool: 'read_selection', ...result }));
      assert.ok(measured <= AGENT_CEILINGS.toolResultBytes,
        `served entry ${measured} > ${AGENT_CEILINGS.toolResultBytes} for ${JSON.stringify(text.slice(0, 8))}`);
      assert.doesNotThrow(() => toolResultMessages([{ tool: 'read_selection', result }]),
        `served entry must serialize for ${JSON.stringify(text.slice(0, 8))}`);
      assert.equal(result.data.text, text, 'a served selection is never shortened');
    } else {
      assert.equal(result.code, 'BYTE_LIMIT', JSON.stringify(text.slice(0, 8)));
      assert.equal(result.data, undefined, 'a refusal carries no document text');
    }
  }
  assert.ok(served >= 3, `the walk really served some selections (served ${served})`);
});

test('a read_selection the runtime would refuse reaches the model as a closed refusal, never as ok', async () => {
  // End-to-end through the loop: the action log and the model-visible tool result must agree, and the
  // fail-open shape — the action recorded `ok` while the model received "could not be serialized" —
  // must be unobservable.
  const text = '\n'.repeat(AGENT_CEILINGS.contextReadBytes.selection);
  const registry = createRegistry(createWordTools(selectionBridge(text)));
  const responses = ['{"type":"tool_calls","calls":[{"tool":"read_selection","arguments":{}}]}',
    '{"type":"final","message":"прочитано"}'];
  const seen = [];
  let step = 0;
  const run = await runAgent({ registry, editor: 'word', capabilities: ['document.read', 'document.write'], mode: 'EDIT',
    settings: {}, uuid: '33333333-3333-4333-8333-333333333333', request: 'прочитай выделение',
    transport: async (messages) => { seen.push(messages.map(message => message.content)); return { content: responses[step++] ?? responses[responses.length - 1] }; } });
  assert.equal(run.status, 'FINAL');
  assert.deepEqual(run.actions.map(action => [action.tool, action.outcome, action.code]),
    [['read_selection', 'error', 'BYTE_LIMIT']], 'the run records the refusal it really produced');
  const crossed = seen[1].filter(content => content.includes('"type":"tool_results"'));
  assert.equal(crossed.length, 1, 'one tool-result message crossed to the model');
  const parsed = JSON.parse(crossed[0]);
  assert.equal(parsed.results[0].tool, 'read_selection');
  assert.equal(parsed.results[0].ok, false);
  assert.equal(parsed.results[0].code, 'BYTE_LIMIT');
  assert.equal(parsed.results[0].data, undefined, 'no document text crossed');
  assert.equal(crossed[0].includes('\\n\\n'), false, 'the selection itself never crossed');
  assert.equal(crossed[0].includes('could not be serialized'), false, 'the fail-open substitution never fired');
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

// --- the same entry measurement for the latent `read_context` bound ---------------------------------
//
// `read_context` is policy `deny` today, so the handler is unreachable through every catalogue and this
// leg cannot fail live. It is fixed anyway: the descriptor is executable when held directly (the
// registry's `deny` is what withholds it, not the handler), so the moment that policy is flipped to
// `auto` a raw-text-only bound would publish `ok` for entries the runtime refuses. What the measurement
// below CLOSES is exactly that fail-OPEN — an entry the runtime refuses can no longer be published as
// `ok`. It is NOT by itself what makes the flip safe, and this file does not claim that: the per-scope
// text ceiling is `contextReadBytes.paragraph` (16384), the WHOLE entry ceiling, so the entry
// measurement eats into the advertised raw bound and leaves a dead band, and the descriptor's own
// withdrawal condition — a native probe of the primitive — still stands.
test('read_context bounds the SERIALIZED entry, not only the raw text, so an entry the runtime refuses can never be published as ok', async () => {
  const text = '\n'.repeat(AGENT_CEILINGS.contextReadBytes.paragraph);
  const tool = createWordTools({ readContext: async () => ({ ok: true, text }) }).find(entry => entry.name === 'read_context');
  assert.equal(tool.policy, 'deny', 'withheld today, which is exactly why the latent bound is fixed now');
  const entry = utf8ByteLength(JSON.stringify({ tool: 'read_context', ok: true,
    data: { scope: 'paragraph', index: 0, text, bytes: 16384 } }));
  assert.equal(entry, 32864, 'the measured entry of the published shape');
  assert.ok(entry > AGENT_CEILINGS.toolResultBytes, 'the raw text is inside its own bound, the entry is not');
  assert.throws(() => toolResultMessages([{ tool: 'read_context', result: { ok: true,
    data: { scope: 'paragraph', index: 0, text, bytes: 16384 } } }]), /TOOL_ERROR/);
  const result = await tool.execute({ scope: 'paragraph', index: 0 }, { editor: 'word' });
  assert.equal(result.ok, false, 'the entry, not the raw text, is the enforced bound');
  assert.equal(result.code, 'BYTE_LIMIT');
  assert.equal(result.message, 'отказ');
  assert.equal(result.data, undefined, 'a refusal carries no document text at all');
  // The same defect by the other route: a lone surrogate triples the raw bytes once serialized.
  const lone = '\ud800'.repeat(3000);
  const surrogate = await createWordTools({ readContext: async () => ({ ok: true, text: lone }) })
    .find(entry => entry.name === 'read_context').execute({ scope: 'section', index: 1 }, { editor: 'word' });
  assert.equal(surrogate.ok, false);
  assert.equal(surrogate.code, 'BYTE_LIMIT');
  assert.equal(surrogate.data, undefined);
  // A context whose entry fits is still served whole, with its own scope and index republished.
  const served = await createWordTools({ readContext: async () => ({ ok: true, text: 'я'.repeat(100) }) })
    .find(entry => entry.name === 'read_context').execute({ scope: 'section', index: 3 }, { editor: 'word' });
  assert.equal(served.ok, true);
  assert.deepEqual(served.data, { scope: 'section', index: 3, text: 'я'.repeat(100), bytes: 200 });
  assert.doesNotThrow(() => toolResultMessages([{ tool: 'read_context', result: served }]));
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
    ['find_text', 'insert_blocks', 'insert_paragraph', 'insert_table', 'read_document_text', 'read_paragraph', 'read_selection', 'read_structure', 'replace_selection', 'set_heading']);
  assert.deepEqual(ask.map(tool => tool.name), ['read_selection', 'read_document_text', 'read_paragraph', 'find_text', 'read_structure']);
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
// text: `Select-String` was MISUSED on the first pass — its default form is LINE-level and
// case-insensitive, so on this single-line 15 MB bundle it reports 17 lines for `GetCurrent`, 12 for
// `GetSelectedText` and 2 for `pluginMethod_`, counts of LINES and never zero — while
// `Select-String -CaseSensitive -AllMatches` returns the exact per-occurrence totals 265 / 101 / 4, the
// same numbers the file's own text holds:
//   `pluginMethod_GetCurrentParagraph` 0, `pluginMethod_GetCurrentSentence` 0,
//   `pluginMethod_GetCurrentWord` 0, `pluginMethod_GetSelectedText` 0.
// Those zeros prove NOTHING, because `pluginMethod_` is not a naming convention in this bundle: it
// occurs FOUR times in total — the explicit `PasteHtml` / `PasteText` / `OnEncryption` members and the
// dispatcher's own `"pluginMethod_"+methodName` lookup — so the editor resolves every other method name
// dynamically and no prefixed literal exists to count.
// The BARE names are what exist: `GetCurrentParagraph` 125, `GetSelectedText` 101, `GetCurrentWord` 7,
// `GetCurrentSentence` 6. No plugin-level PARAGRAPH getter is established: the 125 hits decompose
// EXACTLY into four DISJOINT categories that sum to 125 — 45 bare `this.GetCurrentParagraph`, 12
// `this.<id>.GetCurrentParagraph`, 12 `<id>.prototype.GetCurrentParagraph` definitions (one of them
// `Ct.prototype.`, the `Api`/`getTargetDocContent()` route this descriptor is forbidden to use), and 56
// `<id>.GetCurrentParagraph` on another receiver — so 101 of the 124 hits other than that one
// `Ct.prototype.` literal are neither `this.X.…` nor a `*.prototype.` definition; the sample
// `documentContent.GetCurrentParagraph()` occurs ZERO times and must not be quoted — which is why no
// `pluginMethod_GetCurrentParagraph` is dispatched anywhere in this repo.
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

// ==================================================================================================
// Sprint 3, tool 3 — `find_text`, the bounded document SEARCH.
//
// THE PRIMITIVE, measured on the target (Astra / R7 2026.1.2.1942, this round) and treated as
// established: `Api.GetDocument().Search(query, matchCase)` returns a REAL Array of range objects —
// `count = 4` for the strict `'МАРКЕР-ПОИСК'`, `count = 5` for the case-insensitive `'маркер-поиск'`
// on the same document (the fifth occurrence is the lowercase one), `count = 0` (an EMPTY array, never
// null) for a needle the document does not hold — and `GetText()` on one element is that match's own
// text. `Start`/`End` exist but their UNIT is UNVERIFIED, so this tool publishes NO position: what a
// caller receives is the 0-based occurrence ORDER and each match's own text, and nothing else.
//
// The measurements are reproduced here at the boundary the TOOL actually sees (the bridge's
// `{ok:true, count, texts}` envelope); the native array itself is decoded by the real bridge below,
// and the command body that builds it is measured in tests/unit/bridge-dispatch-api.test.js.
// ==================================================================================================
const MARKER = 'МАРКЕР-ПОИСК';
const MARKER_LOWER = 'маркер-поиск';
// The measured document: four strict occurrences plus one lowercase occurrence.
const MEASURED_OCCURRENCES = Object.freeze([MARKER, MARKER, MARKER, MARKER, MARKER_LOWER]);

function searchBridge(answer, extras = {}) {
  const requests = [];
  return { requests, findText: async (request) => { requests.push(request); return typeof answer === 'function' ? answer(request) : answer; }, ...extras };
}
function findText(bridge) { return createWordTools(bridge).find(entry => entry.name === 'find_text'); }
const found = (count, texts) => ({ ok: true, count, texts });

test('find_text advertises the closed bounded schema and states the two bounds it adds', () => {
  const tool = findText(searchBridge(found(0, [])));
  assert.equal(tool.kind, 'read');
  assert.equal(tool.policy, 'auto');
  assert.deepEqual(tool.editors, ['word']);
  assert.deepEqual(tool.requires, ['document.read']);
  assert.equal(tool.schema.type, 'object');
  assert.equal(tool.schema.additionalProperties, false, 'the schema is CLOSED');
  assert.deepEqual(tool.schema.required, ['query'], 'only the needle is required');
  assert.deepEqual(Object.keys(tool.schema.properties).sort(), ['limit', 'matchCase', 'query']);
  assert.equal(tool.schema.properties.query.type, 'string');
  assert.equal(tool.schema.properties.query.minBytes, 1, 'an empty needle is not a search');
  assert.equal(tool.schema.properties.query.maxBytes, LIMITS.findQueryBytes);
  assert.equal(tool.schema.properties.matchCase.type, 'boolean');
  assert.equal(tool.schema.properties.limit.type, 'integer');
  assert.equal(tool.schema.properties.limit.minimum, 1);
  assert.equal(tool.schema.properties.limit.maximum, LIMITS.findMatchesMax);
  // WHY 256 BYTES AND WHY 32 MATCHES — arithmetic, not taste. The needle is a SEARCH STRING, not a
  // document, so its bound is not derived from any document ceiling: 256 bytes is 128 Cyrillic or 256
  // ASCII characters, longer than any realistic needle, and it is the same number the schema advertises
  // and the handler enforces. The match bound is the second one, and it is ALSO the default, so the
  // advertised space is a size a default call really returns: a search may match thousands of ranges,
  // and the tool must bound how many it reports (the TOTAL count still crosses in `count`).
  assert.equal(LIMITS.findQueryBytes, 256, 'a search string, never a document read');
  assert.equal(LIMITS.findMatchesMax, 32, 'the default and the hard cap are one value');
  // The worst REALISTIC call at those maxima, measured on the SERIALIZED entry the runtime bounds
  // (`JSON.stringify({ tool, ok, data })`, exactly what `stringifyToolResults` measures against
  // `AGENT_CEILINGS.toolResultBytes` = 16384): a Cyrillic needle at the byte maximum whose text is
  // reported for every one of the 32 matches. Every field is at its widest here — `matchCase:false`
  // and `truncated:false` are both one byte wider than their `true` forms.
  const query = 'я'.repeat(LIMITS.findQueryBytes / 2);
  const wide = (index, text) => ({ index, text });
  const matches = new Array(LIMITS.findMatchesMax).fill(query).map((text, index) => wide(index, text));
  const entry = utf8ByteLength(JSON.stringify({ tool: 'find_text', ok: true,
    data: { query, matchCase: false, count: LIMITS.findMatchesMax, matches, truncated: false } }));
  assert.equal(entry, 9283, 'the measured worst realistic case at the advertised maxima');
  assert.ok(entry <= AGENT_CEILINGS.toolResultBytes,
    `${entry} + nothing else <= ${AGENT_CEILINGS.toolResultBytes}, with ${AGENT_CEILINGS.toolResultBytes - entry} bytes of slack`);
  // `count` is the primitive's TOTAL, so its own digits are part of the entry and the bound must hold
  // for the widest value the schema can carry, not just for the one a default call returns. Widening it
  // from 2 digits to the 16 of `Number.MAX_SAFE_INTEGER` adds 14 bytes and nothing else.
  const widestCount = utf8ByteLength(JSON.stringify({ tool: 'find_text', ok: true,
    data: { query, matchCase: false, count: Number.MAX_SAFE_INTEGER, matches, truncated: false } }));
  assert.equal(widestCount, 9297, 'the true maximum: count at its widest, every other field widest');
  assert.ok(widestCount <= AGENT_CEILINGS.toolResultBytes,
    `${widestCount} <= ${AGENT_CEILINGS.toolResultBytes}, with ${AGENT_CEILINGS.toolResultBytes - widestCount} bytes of slack`);
  assert.doesNotThrow(() => toolResultMessages([{ tool: 'find_text',
    result: { ok: true, data: { query, matchCase: false, count: LIMITS.findMatchesMax, matches, truncated: false } } }]));
  // What cannot fit is the ESCAPE width, and there are TWO escape widths. A C0 control with a named
  // short escape (`\n`) serializes to the TWO characters `"\n"` — NOT six — and at the same maxima
  // measures 17731; a C0 control with no short escape serializes to the SIX-character `\uXXXX` and
  // measures 51523. Both are measured, not guessed, and both are REFUSED — the tool never shortens a
  // match's text silently. This is the arithmetic the limits module states.
  const shortEscapeQuery = '\n'.repeat(LIMITS.findQueryBytes);
  const shortEscapeMatches = new Array(LIMITS.findMatchesMax).fill(shortEscapeQuery)
    .map((text, index) => wide(index, text));
  const shortEscapeEntry = utf8ByteLength(JSON.stringify({ tool: 'find_text', ok: true,
    data: { query: shortEscapeQuery, matchCase: false, count: LIMITS.findMatchesMax,
      matches: shortEscapeMatches, truncated: false } }));
  assert.equal(shortEscapeEntry, 17731, 'the two-character-escape case, measured');
  assert.ok(shortEscapeEntry > AGENT_CEILINGS.toolResultBytes,
    'and it is outside the per-result ceiling');
  // The TRUE six-byte family: a C0 control whose JSON escape has no short form. `'\u0001'` here is the
  // real U+0001 character, and `JSON.stringify` emits the six characters `\u0001` for it.
  const sixEscapeQuery = '\u0001'.repeat(LIMITS.findQueryBytes);
  const sixEscapeMatches = new Array(LIMITS.findMatchesMax).fill(sixEscapeQuery)
    .map((text, index) => wide(index, text));
  const sixEscapeEntry = utf8ByteLength(JSON.stringify({ tool: 'find_text', ok: true,
    data: { query: sixEscapeQuery, matchCase: false, count: LIMITS.findMatchesMax,
      matches: sixEscapeMatches, truncated: false } }));
  assert.equal(sixEscapeEntry, 51523, 'the true six-character-escape worst case, measured');
  assert.ok(sixEscapeEntry > AGENT_CEILINGS.toolResultBytes,
    'and it is outside the per-result ceiling, like the two-character-escape case');
});

test('find_text accepts its closed argument set and rejects everything else at the schema', () => {
  const tool = findText(searchBridge(found(0, [])));
  assert.doesNotThrow(() => validateArguments(tool.schema, { query: MARKER }), 'the minimal legal call');
  assert.doesNotThrow(() => validateArguments(tool.schema, { query: MARKER, matchCase: true, limit: 1 }));
  assert.doesNotThrow(() => validateArguments(tool.schema, { query: 'a'.repeat(LIMITS.findQueryBytes) }));
  for (const args of [
    {},                                     // the needle is required
    { matchCase: true },                    // ...and no other key replaces it
    { query: MARKER, extra: 1 },            // CLOSED: an unknown key never reaches the handler
    { query: MARKER, scope: 'sentence' },   // including one another tool's result names
    { query: MARKER, matchCase: 'true' },   // a truthy string is not a boolean
    { query: MARKER, matchCase: 1 },
    { query: MARKER, limit: 0 },            // below the minimum
    { query: MARKER, limit: LIMITS.findMatchesMax + 1 },
    { query: MARKER, limit: 1.5 },
    { query: MARKER, limit: '2' },
    { query: '' },                          // minBytes 1
    { query: 'я'.repeat(LIMITS.findQueryBytes / 2 + 1) }, // 258 bytes, past maxBytes
    { query: 7 }, [], null, 'найти', 5
  ]) assert.throws(() => validateArguments(tool.schema, args), /TOOL_ERROR/, JSON.stringify(args));
});

test('find_text defaults matchCase to case-insensitive and limit to the schema maximum', async () => {
  // THE DOCUMENTED DEFAULT. The measured pair is the discriminator: on one document the strict needle
  // matches 4 ranges and the case-insensitive one matches 5. The default is the CASE-INSENSITIVE
  // search, for two reasons that are both observable to the caller:
  //   * it is the SUPERSET — a caller that wants the strict question passes `matchCase: true`;
  //   * the result ECHOES `matchCase`, so the model always knows which question was answered and can
  //     re-ask the other one. This deliberately mirrors the editor's own Find dialogue, where "match
  //     case" is unchecked by default, and it is not a fail-open: the tool reports the DOCUMENT's own
  //     text for every match, so a differently-cased occurrence is SEEN, never silently normalized.
  const bridge = searchBridge(found(5, MEASURED_OCCURRENCES));
  const result = await findText(bridge).execute({ query: MARKER_LOWER }, { editor: 'word' });
  assert.equal(result.ok, true);
  assert.deepEqual(bridge.requests, [{ query: MARKER_LOWER, matchCase: false, limit: LIMITS.findMatchesMax }],
    'the resolved default is what crosses to the bridge, never an omitted key');
  assert.deepEqual(result.data, { query: MARKER_LOWER, matchCase: false, count: 5,
    matches: MEASURED_OCCURRENCES.map((text, index) => ({ index, text })), truncated: false });
  // An EXPLICIT limit is the caller's, and it narrows the request rather than being applied in the tool
  // alone: the bridge is told how many texts to extract, so the native work is bounded too.
  const bounded = searchBridge(found(5, MEASURED_OCCURRENCES));
  await findText(bounded).execute({ query: MARKER_LOWER, matchCase: false, limit: 2 }, { editor: 'word' });
  assert.deepEqual(bounded.requests, [{ query: MARKER_LOWER, matchCase: false, limit: 2 }]);
});

test('find_text reports the MEASURED primitive shapes faithfully', async () => {
  const tool = findText(searchBridge((request) => request.matchCase
    ? found(4, [MARKER, MARKER, MARKER, MARKER])
    : found(5, MEASURED_OCCURRENCES)));
  // 1. The STRICT needle: four occurrences, every one of them the strict spelling.
  const strict = await tool.execute({ query: MARKER, matchCase: true }, { editor: 'word' });
  assert.equal(strict.ok, true);
  assert.deepEqual(strict.data, { query: MARKER, matchCase: true, count: 4,
    matches: [0, 1, 2, 3].map(index => ({ index, text: MARKER })), truncated: false });
  // 2. The case-insensitive needle: five occurrences, and the FIFTH is the document's own lowercase
  //    spelling — republished verbatim, never normalized to the needle. This is the measured 4-vs-5
  //    pair, and it is the reason the result echoes `matchCase`.
  const loose = await tool.execute({ query: MARKER_LOWER, matchCase: false }, { editor: 'word' });
  assert.equal(loose.ok, true);
  assert.deepEqual(loose.data, { query: MARKER_LOWER, matchCase: false, count: 5,
    matches: MEASURED_OCCURRENCES.map((text, index) => ({ index, text })), truncated: false });
  assert.equal(loose.data.matches[4].text, MARKER_LOWER, 'the document\u2019s own text, not the needle');
  assert.equal(loose.data.query, MARKER_LOWER, 'the query is echoed exactly as it was sent');
  assert.equal(strict.data.matches.some(match => match.text === MARKER_LOWER), false);
  assert.equal(Object.isFrozen(loose.data), true);
});

test('find_text treats a zero-match search as the COMPLETE answer, not as a refusal', async () => {
  // THE STATED DECISION. `Search` answers an EMPTY array (never null) for a needle the document does
  // not hold, and "the document holds no occurrence of this needle" IS the complete answer to the
  // question that was asked — deliberately unlike an empty CARET context (`read_paragraph`), where `''`
  // means there was nothing to reason about and the read is a closed refusal. `ok` with `count: 0` and
  // an empty `matches` is therefore published, and `truncated:false` says the empty list is not a cap.
  const bridge = searchBridge(found(0, []));
  const result = await findText(bridge).execute({ query: 'НЕТ-ТАКОГО-СЛОВА-12345', matchCase: true }, { editor: 'word' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { query: 'НЕТ-ТАКОГО-СЛОВА-12345', matchCase: true, count: 0, matches: [], truncated: false });
  assert.deepEqual(bridge.requests, [{ query: 'НЕТ-ТАКОГО-СЛОВА-12345', matchCase: true, limit: LIMITS.findMatchesMax }]);
  // The empty answer is small enough to cross for any needle inside the byte bound, and the runtime
  // serializer accepts it. The entry is measured, not assumed: 144 bytes for THIS 41-byte Cyrillic
  // needle — the echoed query and the envelope, with no match text at all.
  const entry = utf8ByteLength(JSON.stringify({ tool: 'find_text', ...result }));
  assert.equal(entry, 144, 'the measured entry of a zero-match answer');
  assert.doesNotThrow(() => toolResultMessages([{ tool: 'find_text', result }]));
});

test('find_text bounds how many matches it reports while count stays the TOTAL', async () => {
  // A narrow needle can match thousands of ranges. The request tells the bridge how many TEXTS to
  // extract, `matches` is capped there, and `count` still carries the primitive's own total, so the
  // model can tell "three occurrences" from "three of four hundred" without a second call.
  const bridge = searchBridge(found(500, ['первый', 'второй']));
  const result = await findText(bridge).execute({ query: 'о', limit: 2 }, { editor: 'word' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { query: 'о', matchCase: false, count: 500,
    matches: [{ index: 0, text: 'первый' }, { index: 1, text: 'второй' }], truncated: true });
  assert.equal(result.data.matches.length, 2, 'the reported array is bounded by the caller\u2019s limit');
  assert.equal(result.data.count, 500, 'the total the primitive returned is never narrowed to the report');
  // The boundary: exactly as many texts as the limit is NOT truncated; one fewer than the total is.
  const exact = await findText(searchBridge(found(2, ['a', 'b']))).execute({ query: 'a', limit: 2 }, { editor: 'word' });
  assert.deepEqual(exact.data, { query: 'a', matchCase: false, count: 2,
    matches: [{ index: 0, text: 'a' }, { index: 1, text: 'b' }], truncated: false });
});

test('find_text publishes an entry the runtime serializer accepts and refuses one it would refuse', async () => {
  // The raw text is NOT the bound: the runtime bounds the SERIALIZED entry, and `JSON.stringify`
  // escapes every C0 control character to six characters, so a legal needle at the byte maximum can
  // still produce an entry far outside the ceiling. The tool measures the entry it is about to publish
  // and refuses when even the bounded answer cannot fit — it never shortens a match's text silently.
  const escaped = '\n'.repeat(LIMITS.findQueryBytes);
  const texts = new Array(LIMITS.findMatchesMax).fill(escaped);
  const over = await findText(searchBridge(found(LIMITS.findMatchesMax, texts)))
    .execute({ query: escaped, matchCase: false, limit: LIMITS.findMatchesMax }, { editor: 'word' });
  assert.equal(over.ok, false, 'the entry, not the raw text, is the enforced bound');
  assert.equal(over.code, 'BYTE_LIMIT');
  assert.equal(over.message, 'отказ');
  assert.equal(over.data, undefined, 'a refusal carries no document text at all');
  assert.equal(JSON.stringify(over).includes('\\n'), false, 'no native text leaks through a refusal');
  // One byte of needle less is SERVED: the bound is a real measurement, not a blanket refusal. The
  // half-width control needle reports its matches with escapes and all, and the entry still serializes.
  const servedQuery = '\n'.repeat(LIMITS.findQueryBytes / 2);
  const served = await findText(searchBridge(found(LIMITS.findMatchesMax, new Array(LIMITS.findMatchesMax).fill(servedQuery))))
    .execute({ query: servedQuery, matchCase: false, limit: LIMITS.findMatchesMax }, { editor: 'word' });
  assert.equal(served.ok, true, 'the same shape one size down is inside the ceiling');
  const entry = utf8ByteLength(JSON.stringify({ tool: 'find_text', ...served }));
  assert.equal(entry, 9283, 'the measured entry the runtime accepts');
  assert.ok(entry <= AGENT_CEILINGS.toolResultBytes);
  assert.doesNotThrow(() => toolResultMessages([{ tool: 'find_text', result: served }]));
  // And the invariant across the boundary: no `ok` this handler publishes can exceed the ceiling.
  for (const width of [1, 2, 8, 16, 31, 32]) {
    const answer = found(width, new Array(width).fill(servedQuery));
    const result = await findText(searchBridge(answer)).execute({ query: servedQuery, limit: LIMITS.findMatchesMax }, { editor: 'word' });
    if (result.ok) {
      assert.ok(utf8ByteLength(JSON.stringify({ tool: 'find_text', ...result })) <= AGENT_CEILINGS.toolResultBytes, `width ${width}`);
      assert.doesNotThrow(() => toolResultMessages([{ tool: 'find_text', result }]), `width ${width}`);
      assert.equal(result.data.matches.length, width, 'a served result is never shortened');
    } else assert.equal(result.code, 'BYTE_LIMIT', `width ${width}`);
  }
});

test('find_text republishes the closed class the bridge reported, never a raw failure', async () => {
  const classes = ['TIMEOUT', 'CANCELLED', 'INVALID_DATA', 'CAPABILITY_UNAVAILABLE', 'EDITOR_BUSY', 'BYTE_LIMIT', 'TOOL_ERROR'];
  for (const code of classes) {
    const result = await findText(searchBridge({ ok: false, code })).execute({ query: MARKER }, { editor: 'word' });
    assert.equal(result.ok, false, code);
    assert.equal(result.code, code, `${code} crosses unchanged`);
    assert.equal(result.message, 'отказ', code);
    assert.equal(result.data, undefined, code);
  }
  // Only a class from the closed vocabulary is republished: an arbitrary bridge string keeps the
  // module's own tool-error fallback rather than reaching the run as an invented code.
  for (const code of ['SOMETHING_ELSE', '', 7, null, undefined]) {
    const result = await findText(searchBridge({ ok: false, code })).execute({ query: MARKER }, { editor: 'word' });
    assert.equal(result.code, 'TOOL_ERROR', JSON.stringify(code));
  }
  // A THROWN classified refusal crosses the same way as a returned one; a raw throw is the closed
  // tool-error class and never a raw exception message.
  const thrown = await findText(searchBridge(null, { findText: async () => { const error = new Error('private native detail'); error.code = 'TIMEOUT'; throw error; } }))
    .execute({ query: MARKER }, { editor: 'word' });
  assert.equal(thrown.code, 'TIMEOUT');
  assert.equal(thrown.message, 'отказ');
  const raw = await findText(searchBridge(null, { findText: async () => { throw new Error('private native detail'); } }))
    .execute({ query: MARKER }, { editor: 'word' });
  assert.deepEqual(raw, { ok: false, code: 'TOOL_ERROR', message: 'отказ' }, 'a raw native failure never leaks');
});

test('find_text maps a returned or thrown uncertain class to TOOL_UNCERTAIN', async () => {
  const returned = await findText(searchBridge({ ok: false, code: 'APPLY_UNCERTAIN' })).execute({ query: MARKER }, { editor: 'word' });
  assert.deepEqual(returned, { ok: false, code: 'TOOL_UNCERTAIN', message: 'отказ' },
    'a returned uncertain bridge answer stops the run');
  const thrown = await findText(searchBridge(null, { findText: async () => { const error = new Error('x'); error.code = 'APPLY_UNCERTAIN'; throw error; } }))
    .execute({ query: MARKER }, { editor: 'word' });
  assert.deepEqual(thrown, { ok: false, code: 'TOOL_UNCERTAIN', message: 'отказ' },
    'a thrown uncertain answer is classified identically');
});

test('find_text treats an unusable bridge answer as the module\u2019s unknown convention', async () => {
  // An answer this tool cannot interpret is the module's closed `known()` class, never a publication of
  // whatever the envelope happened to hold: a missing/negative/fractional count, a `texts` that is not a
  // bounded array of strings, and a count that contradicts the texts it sent are all uninterpretable.
  const answers = [
    null, undefined, 7, 'текст', [],
    { ok: true },
    { ok: true, count: 1 },
    { ok: true, texts: [] },
    { ok: true, count: -1, texts: [] },
    { ok: true, count: 1.5, texts: [] },
    { ok: true, count: '1', texts: [] },
    { ok: true, count: 1, texts: 'текст' },
    { ok: true, count: 1, texts: [7] },
    { ok: true, count: 0, texts: ['лишний'] },
    { ok: true, count: 1, texts: new Array(3).fill('x') }
  ];
  for (const answer of answers) {
    const result = await findText(searchBridge(answer)).execute({ query: MARKER, limit: 2 }, { editor: 'word' });
    assert.equal(result.ok, false, JSON.stringify(answer));
    assert.equal(result.code, 'TOOL_ERROR', JSON.stringify(answer));
    assert.equal(result.message, 'отказ', JSON.stringify(answer));
  }
  // An answer that carries MORE texts than the limit the caller set is uninterpretable too: the bridge
  // was told the cap, so more than that is not an answer this tool can attribute to its own request.
  const overLimit = await findText(searchBridge(found(3, ['a', 'b', 'c']))).execute({ query: MARKER, limit: 2 }, { editor: 'word' });
  assert.equal(overLimit.ok, false);
  assert.equal(overLimit.code, 'TOOL_ERROR');
});

test('find_text refuses an editor that is not Word before any dispatch', async () => {
  const bridge = searchBridge(found(4, [MARKER, MARKER, MARKER, MARKER]));
  const tool = findText(bridge);
  for (const editor of ['cell', 'slide', 'unknown']) {
    const refusal = tool.precondition({ query: MARKER }, { editor });
    assert.equal(refusal.code, 'CAPABILITY_UNAVAILABLE', editor);
    assert.equal(refusal.message, 'отказ', editor);
  }
  assert.equal(tool.precondition({ query: MARKER }, { editor: 'word' }), null);
  assert.deepEqual(bridge.requests, [], 'the precondition is what refuses, and it dispatches nothing');
});

test('find_text refuses a bridge that cannot serve the search instead of crashing', async () => {
  for (const bridge of [null, undefined, {}, { findText: 'no' }, { findText: 7 }]) {
    const result = await findText(bridge).execute({ query: MARKER }, { editor: 'word' });
    assert.equal(result.ok, false, JSON.stringify(bridge));
    assert.equal(result.code, 'CAPABILITY_UNAVAILABLE', JSON.stringify(bridge));
    assert.equal(result.message, 'отказ', JSON.stringify(bridge));
  }
});

test('find_text touches exactly one bridge search and no write method at all', async () => {
  const touched = [];
  const record = (method, value) => async () => { touched.push({ method }); return value; };
  const bridge = {
    findText: async (request) => { touched.push({ method: 'findText', request }); return found(1, [MARKER]); },
    readSelection: record('readSelection', {}),
    readDocumentText: record('readDocumentText', {}),
    readParagraph: record('readParagraph', {}),
    readContext: record('readContext', {}),
    insertParagraph: record('insertParagraph', { ok: true, data: {} }),
    applySelection: record('applySelection', {})
  };
  const result = await findText(bridge).execute({ query: MARKER, matchCase: true }, { editor: 'word' });
  assert.equal(result.ok, true);
  assert.deepEqual(touched, [{ method: 'findText', request: { query: MARKER, matchCase: true, limit: LIMITS.findMatchesMax } }],
    'ONE search, with the resolved defaults, and no other leg');
  // READ-ONLY BY CONSTRUCTION: no mutate path is reachable from this descriptor, and the assertion is
  // over the set of write/other methods the bridge actually exposes.
  for (const method of ['insertParagraph', 'applySelection', 'readSelection', 'readContext', 'readDocumentText', 'readParagraph']) {
    assert.equal(touched.some(entry => entry.method === method), false, `${method} is never reached`);
  }
});

test('find_text forwards the caller signal to its single bridge search', async () => {
  const bridge = searchBridge(found(0, []));
  const controller = new AbortController();
  await findText(bridge).execute({ query: MARKER }, { editor: 'word', signal: controller.signal });
  assert.deepEqual(bridge.requests, [{ query: MARKER, matchCase: false, limit: LIMITS.findMatchesMax, signal: controller.signal }]);
});

// --- the real bridge: the command channel, the scope carrier and the measured native decode --------
// The plugin facade exposes the command channel ONLY as `callCommand` (`executeMethod` queues editor
// methods to `pluginMethod_<name>` and cannot reach the `Api` builder at all), and the ONLY channel a
// command body can receive DATA through is `Asc.scope`: the vendor's own wrapper composes
// `var Asc = {}; Asc.scope = JSON.stringify(window.Asc.scope); var scope = Asc.scope; (<body>)();`
// before the body, so the body's `scope` binding IS that property. The rig below reproduces exactly
// that wrapper — it reads the namespace property SYNCHRONOUSLY (as the vendor does), hands the body
// that value, and evaluates the body the way the EDITOR does: in a FRESH, module-free scope, so a body
// that closed over a module binding of bridge.js would raise `ReferenceError` here exactly as it did
// natively on 2026.3.1 (commit 273d70e).
function measuredSearch(occurrences) {
  // The measured primitive: a literal search, case-sensitive when the caller asks for it, answering a
  // REAL Array of range-shaped objects whose `GetText()` is the match's own text.
  return function (needle, matchCase) {
    return occurrences
      .filter(text => matchCase ? text === needle : text.toLowerCase() === needle.toLowerCase())
      .map(text => ({ GetClassType() { return 'range'; }, GetText() { return text; } }));
  };
}
function evaluateSearchBody(body, api, scope) {
  return new Function('Api', 'scope', 'return (' + Function.prototype.toString.call(body) + ')();')(api, scope);
}
function findRig({ occurrences = MEASURED_OCCURRENCES, document = null, command = true, namespace = { scope: 'сентинел' }, omitCarrier = false } = {}) {
  const commands = [];
  const api = { GetDocument() { return document ?? { Search: measuredSearch(occurrences) }; } };
  const plugin = { info: { editorType: 'word' },
    callCommand: command ? function (body, close, recalculate, callback) {
      // `window.Asc.scope` is read HERE, synchronously, exactly as the vendor wrapper reads it.
      const scope = namespace?.scope;
      commands.push({ by: 'callCommand', body, close, recalculate, scope });
      callback(evaluateSearchBody(body, api, scope));
      return false;
    } : undefined };
  const options = { editorType: 'word', clock: { now: () => 0 }, timers: { schedule() { return {}; }, clear() {} } };
  if (!omitCarrier) options.ascNamespace = namespace;
  const bridge = bridgeWith(plugin, options);
  return { bridge, plugin, commands, namespace, api };
}

test('bridge findText dispatches ONE command, carries the needle as DATA and restores the namespace', async () => {
  const namespace = { scope: 'предыдущая-область' };
  const r = findRig({ namespace });
  const pending = r.bridge.findText({ query: MARKER, matchCase: true, limit: LIMITS.findMatchesMax });
  assert.equal(r.commands.length, 1, 'exactly ONE command is dispatched');
  assert.equal(r.commands[0].by, 'callCommand', 'the wrapper is the entry point the measured build exposes');
  assert.equal(typeof r.commands[0].body, 'function', 'the body is handed as an authored function literal, never as text');
  assert.equal(r.commands[0].close, false, 'the documented close/recalculate arguments are unchanged');
  assert.equal(r.commands[0].recalculate, false);
  assert.deepEqual(r.commands[0].scope, { query: MARKER, matchCase: true, limit: LIMITS.findMatchesMax },
    'the model data crosses as the command SCOPE, never interpolated into source');
  assert.equal(namespace.scope, 'предыдущая-область', 'the namespace is restored: a needle never outlives its dispatch');
  const result = await pending;
  assert.deepEqual(result, { ok: true, count: 4, texts: [MARKER, MARKER, MARKER, MARKER] });
  assert.ok(Object.isFrozen(result));
  assert.equal(r.bridge.getState().busy, false, 'the slot is released by the native callback');
});

test('bridge findText decodes the measured native shapes: 4 strict, 5 case-insensitive, 0 missing', async () => {
  const r = findRig();
  const strict = await r.bridge.findText({ query: MARKER, matchCase: true, limit: LIMITS.findMatchesMax });
  assert.deepEqual(strict, { ok: true, count: 4, texts: [MARKER, MARKER, MARKER, MARKER] }, 'the measured strict count');
  const loose = await r.bridge.findText({ query: MARKER_LOWER, matchCase: false, limit: LIMITS.findMatchesMax });
  assert.equal(loose.ok, true);
  assert.equal(loose.count, 5, 'the measured case-insensitive count');
  assert.equal(loose.texts[4], MARKER_LOWER, 'the fifth match is the document\u2019s own lowercase text');
  const missing = await r.bridge.findText({ query: 'НЕТ-ТАКОГО-СЛОВА-12345', matchCase: true, limit: LIMITS.findMatchesMax });
  assert.deepEqual(missing, { ok: true, count: 0, texts: [] }, 'a needle the document does not hold is an EMPTY answer');
  assert.equal(r.commands.length, 3, 'one command per search, and no identity probe');
  // The extraction is bounded at the source: the body asks for at most `limit` texts even when the
  // primitive matched more, and `count` is still the primitive's own total.
  const bounded = await r.bridge.findText({ query: MARKER, matchCase: true, limit: 2 });
  assert.deepEqual(bounded, { ok: true, count: 4, texts: [MARKER, MARKER] });
  assert.equal(r.commands.length, 4);
});

test('bridge findText refuses a build, a namespace or an answer it cannot use, with the closed class', async () => {
  // No command channel at all: nothing is dispatched, and the refusal is the closed capability class.
  const noCommand = findRig({ command: false });
  assert.deepEqual(await noCommand.bridge.findText({ query: MARKER, matchCase: true, limit: 4 }),
    { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
  assert.deepEqual(noCommand.commands, [], 'no command is dispatched by a facade that has none');
  // A namespace that cannot carry the scope is the SAME closed refusal, decided BEFORE the dispatch, so
  // the slot is released and nothing reached the editor. This is not cosmetic: the vendor wrapper reads
  // the property itself, so a scope nobody wrote would silently search for the PREVIOUS needle.
  assert.equal(globalThis.Asc, undefined, 'the omitted carrier falls back to the page namespace, absent here');
  for (const shape of [{ omitCarrier: true }, { namespace: null }, { namespace: Object.freeze({}) },
    { namespace: Object.freeze({ scope: 'предыдущая-область' }) }]) {
    const r = findRig(shape);
    const result = await r.bridge.findText({ query: MARKER, matchCase: true, limit: 4 });
    assert.deepEqual(result, { ok: false, code: 'CAPABILITY_UNAVAILABLE' }, JSON.stringify(shape));
    assert.deepEqual(r.commands, [], 'nothing is dispatched when the scope cannot cross');
    assert.equal(r.bridge.getState().busy, false, 'and the slot is released');
  }
  // A SEALED namespace still carries a writable `scope` data property, so it is served: the refusal is
  // about the property being unwritable or absent, never about the object being frozen as such.
  const sealed = Object.seal({ scope: 'предыдущая-область' });
  const sealedRig = findRig({ namespace: sealed });
  assert.deepEqual(await sealedRig.bridge.findText({ query: MARKER, matchCase: true, limit: 1 }),
    { ok: true, count: 4, texts: [MARKER] });
  assert.equal(sealed.scope, 'предыдущая-область', 'and the previous value is restored');
  // An Api facade without a usable `Search` answers the body's own refusal sentinel.
  for (const document of [{}, { Search: null }, { Search: 7 }]) {
    const r = findRig({ document });
    assert.deepEqual(await r.bridge.findText({ query: MARKER, matchCase: true, limit: 4 }),
      { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
    assert.equal(r.bridge.getState().busy, false);
  }
  // A native answer that is not the authored shape is INVALID_DATA, never a publication of whatever
  // arrived; one above the bridge's own read window is BYTE_LIMIT. Neither leaks the native text.
  const poisoned = (raw) => {
    const namespace = { scope: undefined };
    const plugin = { info: { editorType: 'word' }, callCommand: (_body, _close, _recalculate, callback) => { callback(raw); return false; } };
    return bridgeWith(plugin, { editorType: 'word', ascNamespace: namespace, clock: { now: () => 0 },
      timers: { schedule() { return {}; }, clear() {} } });
  };
  for (const raw of [null, undefined, 7, 'текст', {}, [true], ['CAPABILITY_UNAVAILABLE'], [5], [-1, 'a'], [1.5, 'a'], [2, 'a'],
    [1, 7], [1, 'a', 'b'], [0, 'лишний']]) {
    const result = await poisoned(raw).findText({ query: MARKER, matchCase: true, limit: 2 });
    assert.equal(result.ok, false, JSON.stringify(raw));
    assert.equal(result.code, raw && raw[0] === 'CAPABILITY_UNAVAILABLE' ? 'CAPABILITY_UNAVAILABLE' : 'INVALID_DATA',
      JSON.stringify(raw));
    assert.equal(JSON.stringify(result).includes('лишний'), false, 'no native text leaks through a refusal');
  }
  // The authored answer for a needle the document does not hold is LEGAL: `[0]` is what the body builds
  // when it found nothing, and the decoder must not confuse it with a malformed single-slot answer.
  assert.deepEqual(await poisoned([0]).findText({ query: MARKER, matchCase: true, limit: 2 }),
    { ok: true, count: 0, texts: [] });
  // The body extracts EXACTLY `min(count, limit)` texts, so an answer that reports fewer is not one the
  // authored body can have produced, and the decoder refuses it rather than publishing a short report
  // the tool would describe as its own `limit` cap.
  assert.deepEqual(await poisoned([4, 'a']).findText({ query: MARKER, matchCase: true, limit: 2 }),
    { ok: false, code: 'INVALID_DATA' });
  assert.deepEqual(await poisoned([4, 'a', 'b']).findText({ query: MARKER, matchCase: true, limit: 2 }),
    { ok: true, count: 4, texts: ['a', 'b'] }, 'min(4, 2) = 2 texts is the authored shape');
  const oversized = await poisoned([1, 'я'.repeat(40000)]).findText({ query: MARKER, matchCase: true, limit: 2 });
  assert.deepEqual(oversized, { ok: false, code: 'BYTE_LIMIT' }, 'an answer above the read window is refused');
});

test('bridge findText refuses a request it cannot interpret without any SDK work', async () => {
  for (const raw of [undefined, null, {}, { query: '' }, { query: 7 }, { query: MARKER }, { query: MARKER, matchCase: 'yes', limit: 1 },
    { query: MARKER, matchCase: true, limit: 0 }, { query: MARKER, matchCase: true, limit: LIMITS.findMatchesMax + 1 },
    { query: MARKER, matchCase: true, limit: 1.5 }, { query: MARKER, matchCase: true, limit: '2' },
    { query: 'a'.repeat(LIMITS.findQueryBytes + 1), matchCase: true, limit: 1 }]) {
    const r = findRig();
    const result = await r.bridge.findText(raw ?? {});
    assert.equal(result.ok, false, JSON.stringify(raw));
    assert.equal(result.code, 'CAPABILITY_UNAVAILABLE', JSON.stringify(raw));
    assert.deepEqual(r.commands, [], JSON.stringify(raw));
    assert.equal(r.bridge.getState().busy, false, JSON.stringify(raw));
  }
});

test('bridge findText refuses a pre-aborted signal without any dispatch', async () => {
  const r = findRig();
  const controller = new AbortController();
  controller.abort();
  const result = await r.bridge.findText({ query: MARKER, matchCase: true, limit: 4, signal: controller.signal });
  assert.deepEqual(result, { ok: false, code: 'CANCELLED' });
  assert.deepEqual(r.commands, [], 'nothing reaches the editor');
  assert.equal(r.bridge.getState().busy, false);
});

test('find_text is offered with policy auto and a model call dispatches exactly one search', async () => {
  const r = findRig();
  const registry = createRegistry(createWordTools(r.bridge));
  const catalogue = registry.catalogue({ editor: 'word', capabilities: ['document.read', 'document.write'], mode: 'EDIT' });
  const offered = catalogue.find(entry => entry.name === 'find_text');
  assert.ok(offered, 'the offered catalogue contains find_text');
  assert.equal(offered.policy, 'auto');
  assert.equal(offered.kind, 'read');
  assert.equal(offered.requires.includes('document.read'), true);
  const batch = validateBatch(catalogue, [{ tool: 'find_text', arguments: { query: MARKER, matchCase: true } }]);
  assert.equal(batch.length, 1);
  assert.equal(batch[0].descriptor.name, 'find_text');
  const responses = ['{"type":"tool_calls","calls":[{"tool":"find_text","arguments":{"query":"' + MARKER + '","matchCase":true}}]}',
    '{"type":"final","message":"найдено"}'];
  const crossed = [];
  let step = 0;
  const run = await runAgent({ registry, editor: 'word', capabilities: ['document.read', 'document.write'], mode: 'EDIT',
    settings: {}, uuid: '44444444-4444-4444-8444-444444444444', request: 'найди маркер',
    transport: async (messages) => { crossed.push(messages.map(message => message.content)); return { content: responses[step++] ?? responses[responses.length - 1] }; } });
  assert.equal(run.status, 'FINAL');
  assert.deepEqual(run.actions.map(action => [action.tool, action.outcome]), [['find_text', 'ok']]);
  assert.equal(r.commands.length, 1, 'one search for the whole run, and no write path touched');
  assert.equal(r.bridge.getState().busy, false);
  // The model really RECEIVES the bounded answer — the count and the matches' own texts — through the
  // runtime's own per-result serialization, not a summary this test invented.
  const toolResults = crossed.flat().filter(content => content.includes('"type":"tool_results"'));
  assert.equal(toolResults.length, 1, 'one tool-result message crossed to the model');
  const published = JSON.parse(toolResults[0]).results[0];
  assert.equal(published.tool, 'find_text');
  assert.equal(published.ok, true);
  assert.equal(published.data.count, 4);
  assert.deepEqual(published.data.matches.map(match => match.text), [MARKER, MARKER, MARKER, MARKER]);
  assert.equal(published.data.truncated, false);
});

// ==================================================================================================
// Sprint 3, tool 4 — `read_structure`, the bounded document-structure read
//
// The primitives, MEASURED on the target (Astra / R7 2026.1.2.1942, this round) and treated as
// established: `Api.GetDocument().GetStatistics()` answers an object with the numeric fields
// `PageCount`, `WordsCount`, `ParagraphCount`, `SymbolsCount`, `SymbolsWSCount`; `GetPageCount()`
// answers a number; `GetAllParagraphs()` answers an array (10 elements on the measured document) whose
// elements carry `GetClassType()`/`GetText()`; `GetAllHeadingParagraphs()` answers an array of the
// styled heading paragraphs (3 on the measured document); `GetAllTables()` 1; `GetSections()` 1. The
// native return validator keeps ARRAYS OF PRIMITIVES and a string and STRIPS a plain object, so the
// authored body encodes the whole structure as ONE flat array of primitives — the same reason the
// search body encodes its matches.
//
// The measurements below are reproduced at the boundary the TOOL actually sees (the bridge's decoded
// `{ ok, pages, statistics, counts, headings }` envelope); the native flat array itself is decoded by
// the real bridge further down and the command body is evaluated in tests/unit/bridge-dispatch-api.test.js
// and tests/integration/package.test.js.
// ==================================================================================================
const MEASURED_STATISTICS = Object.freeze({ PageCount: 1, WordsCount: 25, ParagraphCount: 10, SymbolsCount: 150, SymbolsWSCount: 165 });
const MEASURED_COUNTS = Object.freeze({ paragraphs: 10, headings: 3, tables: 1, sections: 1 });
const MEASURED_HEADINGS = Object.freeze(['ГЛАВА ПЕРВАЯ', 'ГЛАВА ВТОРАЯ', 'ПОДРАЗДЕЛ']);
function structureBridge(answer, extras = {}) {
  const requests = [];
  return { requests, readStructure: async (request) => { requests.push(request);
    return typeof answer === 'function' ? answer(request) : answer; }, ...extras };
}
function readStructure(bridge) { return createWordTools(bridge).find(entry => entry.name === 'read_structure'); }
function structured(overrides = {}) {
  return { ok: true, pages: 1, statistics: { ...MEASURED_STATISTICS },
    counts: { ...MEASURED_COUNTS }, headings: [...MEASURED_HEADINGS], ...overrides };
}
function structureData(headings, counts = MEASURED_COUNTS, statistics = MEASURED_STATISTICS, pages = 1) {
  return { pages, statistics: { ...statistics }, counts: { ...counts },
    headings: headings.map((text, index) => ({ index, text })), truncated: counts.headings > headings.length };
}

test('read_structure advertises the closed schema and the two bounds it adds', () => {
  const tool = readStructure(structureBridge(structured()));
  assert.equal(tool.kind, 'read');
  assert.equal(tool.policy, 'auto');
  assert.deepEqual(tool.editors, ['word']);
  assert.deepEqual(tool.requires, ['document.read']);
  assert.equal(tool.schema.type, 'object');
  assert.equal(tool.schema.additionalProperties, false, 'the schema is CLOSED');
  assert.deepEqual(tool.schema.required, [], 'every primitive this tool reads takes no parameter');
  assert.deepEqual(Object.keys(tool.schema.properties), [],
    'no argument is advertised: a value that did not have to be measured to matter is not added');
  // WHY 32 HEADINGS AND WHY 256 BYTES PER HEADING — arithmetic, not taste. The document read is a
  // STRUCTURE read: the count cap is how many heading texts a caller receives, and the text bound is
  // one heading's own width. Both are the numbers the schema-side contract advertises and the handler
  // enforces, and they are chosen so the worst REALISTIC call at both maxima fits the entry the runtime
  // bounds. A heading is a title, not a paragraph: 256 UTF-8 bytes is 128 Cyrillic or 256 ASCII
  // characters, and 32 covers the outline of a long report while keeping the count in the same place
  // `findMatchesMax` puts a search report.
  assert.equal(LIMITS.structureHeadingsMax, 32, 'the count cap');
  assert.equal(LIMITS.structureHeadingBytes, 256, 'one heading text, never a document read');
  // The worst REALISTIC call at those maxima, measured on the SERIALIZED entry the runtime bounds
  // (`JSON.stringify({ tool, ok, data })`, exactly what `stringifyToolResults` measures against
  // `AGENT_CEILINGS.toolResultBytes` = 16384): 32 headings of 128 Cyrillic characters each, with every
  // statistic and count at its own digit width and `truncated:false` (one byte wider than `true`).
  const heading = 'я'.repeat(LIMITS.structureHeadingBytes / 2);
  const headings = new Array(LIMITS.structureHeadingsMax).fill(heading).map((text, index) => ({ index, text }));
  const statistics = { PageCount: 842, WordsCount: 99999, ParagraphCount: 4321, SymbolsCount: 999999, SymbolsWSCount: 999999 };
  const counts = { paragraphs: 4321, headings: 999, tables: 99, sections: 9 };
  const entry = utf8ByteLength(JSON.stringify({ tool: 'read_structure', ok: true, data: { pages: 842,
    statistics, counts, headings, truncated: false } }));
  assert.equal(entry, 9192, 'the measured worst realistic case at the advertised maxima');
  assert.ok(entry <= AGENT_CEILINGS.toolResultBytes,
    `${entry} <= ${AGENT_CEILINGS.toolResultBytes}, with ${AGENT_CEILINGS.toolResultBytes - entry} bytes of slack`);
  assert.doesNotThrow(() => toolResultMessages([{ tool: 'read_structure', result: { ok: true,
    data: { pages: 842, statistics, counts, headings, truncated: false } } }]));
  // 9192 IS NOT THE TRUE MAXIMUM, and the former claim that 9315 was is wrong in BOTH its label and its
  // SHAPE. `JSON.stringify` escapes `"` as the TWO characters `\"` (and `\` as `\\`), so ONE raw heading
  // byte can serialize as two, and the 256-byte per-heading bound admits a FAR wider serialized heading
  // than 128 Cyrillic characters do: the escape family the earlier comment never named is the one that
  // binds, while the two families it DID name cannot fit at all. The old figure was also UNREACHABLE:
  // `truncated` is derived as `counts.headings > headings.length`, so 32 headings with a 16-digit
  // `counts.headings` are `truncated:true`, never the `false` that shape used. Measured on the same entry:
  //   * 32 headings of 240 `"` (240 raw bytes, inside the bound): 16341 bytes, 43 of slack, and SERVED;
  //   * 32 headings of 241 `"` (241 raw bytes):                   16405 bytes — refused.
  const quotes = (width) => new Array(LIMITS.structureHeadingsMax).fill('"'.repeat(width))
    .map((text, index) => ({ index, text }));
  const quoted = utf8ByteLength(JSON.stringify({ tool: 'read_structure', ok: true, data: { pages: 1,
    statistics: { ...MEASURED_STATISTICS },
    counts: { ...MEASURED_COUNTS, headings: LIMITS.structureHeadingsMax }, headings: quotes(240), truncated: false } }));
  assert.equal(quoted, 16341, 'the widest all-`"` heading, measured');
  assert.equal(AGENT_CEILINGS.toolResultBytes - quoted, 43, 'and its own slack');
  const quotedOver = utf8ByteLength(JSON.stringify({ tool: 'read_structure', ok: true, data: { pages: 1,
    statistics: { ...MEASURED_STATISTICS },
    counts: { ...MEASURED_COUNTS, headings: LIMITS.structureHeadingsMax }, headings: quotes(241), truncated: false } }));
  assert.equal(quotedOver, 16405, 'one more `"` per heading is outside the ceiling');
  assert.ok(quotedOver > AGENT_CEILINGS.toolResultBytes);
  // THE TRUE MAXIMUM IS THE CEILING EXACTLY, with ZERO slack. The widest publishable shape mixes ONE
  // plain ASCII byte into each heading — 238 `"` plus `a` is 239 raw bytes, still inside the 256-byte
  // bound, and its escaped width is an ODD 477 bytes instead of the 476 or 480 a uniform heading reaches
  // — with the nine non-heading numeric fields at `Number.MAX_SAFE_INTEGER` and `counts.headings` at 14
  // digits. That field cannot also be 16 digits: the same headings then measure 16386 and are refused,
  // and the widest 16-digit shape is 16354. The boundary check is `> 16384`, so exactly 16384 publishes.
  const MAX = Number.MAX_SAFE_INTEGER;
  const widest = new Array(LIMITS.structureHeadingsMax).fill('"'.repeat(238) + 'a')
    .map((text, index) => ({ index, text }));
  assert.equal(utf8ByteLength(widest[0].text), 239, 'the raw heading stays inside the 256-byte bound');
  const trueMax = utf8ByteLength(JSON.stringify({ tool: 'read_structure', ok: true, data: { pages: MAX,
    statistics: { PageCount: MAX, WordsCount: MAX, ParagraphCount: MAX, SymbolsCount: MAX, SymbolsWSCount: MAX },
    counts: { paragraphs: MAX, headings: 10 ** 13, tables: MAX, sections: MAX },
    headings: widest, truncated: true } }));
  assert.equal(trueMax, 16384, 'the true maximum: the ceiling exactly, never above it');
  assert.equal(AGENT_CEILINGS.toolResultBytes - trueMax, 0, 'zero slack, and the `> ceiling` check still passes it');
  // What cannot fit is the ESCAPE width, and there are TWO of them, exactly as `find_text` documents: a
  // heading of 256 `\n` characters serializes each one as the TWO characters `"\n"`, while a heading of
  // 256 C0 controls with no short escape serializes each as SIX characters `\uXXXX`. Both figures below
  // are the 32-text array at its OWN 2-digit `counts.headings` width (32) — the shape a served array
  // really has. Both are REFUSED with the closed BYTE_LIMIT by the entry measurement: a heading is never
  // shortened to fit.
  const escaped = new Array(LIMITS.structureHeadingsMax).fill('\n'.repeat(LIMITS.structureHeadingBytes))
    .map((text, index) => ({ index, text }));
  const shortEscape = utf8ByteLength(JSON.stringify({ tool: 'read_structure', ok: true,
    data: { pages: 1, statistics: { ...MEASURED_STATISTICS },
      counts: { ...MEASURED_COUNTS, headings: LIMITS.structureHeadingsMax }, headings: escaped, truncated: false } }));
  assert.equal(shortEscape, 17365, 'the two-character-escape case, measured at the array\u2019s own counts width');
  assert.ok(shortEscape > AGENT_CEILINGS.toolResultBytes, 'and it is outside the per-result ceiling');
  const sixEscaped = new Array(LIMITS.structureHeadingsMax).fill('\u0001'.repeat(LIMITS.structureHeadingBytes))
    .map((text, index) => ({ index, text }));
  const sixEscape = utf8ByteLength(JSON.stringify({ tool: 'read_structure', ok: true,
    data: { pages: 1, statistics: { ...MEASURED_STATISTICS },
      counts: { ...MEASURED_COUNTS, headings: LIMITS.structureHeadingsMax }, headings: sixEscaped, truncated: false } }));
  assert.equal(sixEscape, 50133, 'the true six-character-escape worst case, measured');
  assert.ok(sixEscape > AGENT_CEILINGS.toolResultBytes, 'and it is outside the per-result ceiling too');
});

test('read_structure accepts only the empty argument object and rejects every other key at the schema', () => {
  const tool = readStructure(structureBridge(structured()));
  assert.doesNotThrow(() => validateArguments(tool.schema, {}));
  for (const args of [
    { scope: 'structure' },       // another tool's result names its own scope, never an argument
    { index: 0 },
    { limit: 1 },
    { maxHeadings: 1 },
    { text: '' },
    [], null, 'structure', 5
  ]) assert.throws(() => validateArguments(tool.schema, args), /TOOL_ERROR/, JSON.stringify(args));
});

test('read_structure reports the MEASURED document structure faithfully', async () => {
  const bridge = structureBridge(structured());
  const result = await readStructure(bridge).execute({}, { editor: 'word' });
  assert.equal(result.ok, true);
  // Every field is the measured one, republished under the primitive's OWN names and with nothing
  // invented: the statistics object carries exactly the five fields `GetStatistics()` answered, the
  // counts are the array lengths, and each heading is that paragraph's own `GetText()`.
  assert.deepEqual(result.data, structureData(MEASURED_HEADINGS));
  assert.deepEqual(bridge.requests, [{ maxHeadings: LIMITS.structureHeadingsMax }],
    'the tool asks for the cap it advertises, and no other value crosses');
  assert.equal(Object.isFrozen(result.data), true);
  assert.equal(Object.isFrozen(result.data.headings), true);
  assert.equal(Object.isFrozen(result.data.headings[0]), true);
  assert.equal(Object.isFrozen(result.data.statistics), true);
  assert.equal(Object.isFrozen(result.data.counts), true);
});

test('read_structure treats an EMPTY structure as the complete answer, not a refusal', async () => {
  // THE STATED DECISION. A document with no styled headings and no tables has an EMPTY outline, and
  // "this document has no headings" IS the complete answer to "what is this document's structure" —
  // deliberately unlike an empty CARET context (`read_paragraph`), where `''` means there was nothing to
  // reason about. `ok` with `headings: []`, `counts.headings: 0` and `truncated: false` is published.
  const counts = { paragraphs: 1, headings: 0, tables: 0, sections: 1 };
  const statistics = { PageCount: 1, WordsCount: 0, ParagraphCount: 1, SymbolsCount: 0, SymbolsWSCount: 0 };
  const bridge = structureBridge(structured({ statistics, counts, headings: [] }));
  const result = await readStructure(bridge).execute({}, { editor: 'word' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, structureData([], counts, statistics));
  assert.deepEqual(result.data.headings, []);
  assert.equal(result.data.truncated, false, 'an empty list is not a cap');
  // The entry is measured, not assumed: 248 bytes for this answer, and the runtime serializer accepts it.
  assert.equal(utf8ByteLength(JSON.stringify({ tool: 'read_structure', ...result })), 248);
  assert.doesNotThrow(() => toolResultMessages([{ tool: 'read_structure', result }]));
});

test('read_structure bounds how many headings it reports while counts stay the TOTAL', async () => {
  // An outline can hold hundreds of headings. The request tells the bridge how many TEXTS to extract,
  // `headings` is capped there, and `counts.headings` still carries the primitive's own total, so the
  // model can tell "three headings" from "three of five hundred" from one call.
  const texts = new Array(LIMITS.structureHeadingsMax).fill('раздел');
  const bridge = structureBridge({ ok: true, pages: 1, statistics: { ...MEASURED_STATISTICS },
    counts: { ...MEASURED_COUNTS, headings: 500 }, headings: texts });
  const result = await readStructure(bridge).execute({}, { editor: 'word' });
  assert.equal(result.ok, true);
  assert.equal(result.data.headings.length, LIMITS.structureHeadingsMax, 'the reported array is capped');
  assert.equal(result.data.counts.headings, 500, 'the total is never narrowed to the report');
  assert.equal(result.data.truncated, true, 'and the cap is stated honestly');
  // The boundary: a document holding exactly as many headings as the cap is NOT truncated.
  const exact = await readStructure(structureBridge({ ok: true, pages: 1,
    statistics: { ...MEASURED_STATISTICS }, counts: { ...MEASURED_COUNTS, headings: LIMITS.structureHeadingsMax }, headings: texts }))
    .execute({}, { editor: 'word' });
  assert.equal(exact.ok, true);
  assert.equal(exact.data.truncated, false);
  assert.equal(exact.data.counts.headings, exact.data.headings.length);
});

test('read_structure bounds ONE heading text and publishes an explicit EMPTY omission, never a shortened heading', async () => {
  // A heading longer than the advertised text bound is NOT trimmed to fit — and it no longer refuses the
  // WHOLE read either. Pages, statistics and counts are measured facts about the document that no heading
  // TEXT can make untrue, and the old refusal was POSITIONAL: a 258-byte heading at index 0 refused the
  // whole answer while the same heading at index 40 was never extracted and the read succeeded, so two
  // documents holding the same over-wide heading got opposite outcomes for a difference the model cannot
  // see. The answer is `ok` with the scalars, `headings: []` and `truncated: true`: an UNREPRESENTABLE
  // heading is an explicit omission, never a total refusal and never a trimmed title.
  const over = 'Г'.repeat(LIMITS.structureHeadingBytes / 2 + 1);   // 258 bytes, two over the bound
  const omitted = await readStructure(structureBridge(structured({ headings: ['КОРОТКИЙ', over],
    counts: { ...MEASURED_COUNTS, headings: 2 } })))
    .execute({}, { editor: 'word' });
  assert.equal(omitted.ok, true, 'the scalars are still owed: an over-wide heading is an omission, not a refusal');
  assert.deepEqual(omitted.data.headings, [], 'the array is EMPTY, never partially filled');
  assert.equal(omitted.data.truncated, true, 'and the omission is stated');
  assert.equal(omitted.data.counts.headings, 2, 'counts.headings keeps the primitive TOTAL: a count, not a text');
  assert.equal(omitted.data.pages, 1);
  assert.deepEqual(omitted.data.statistics, { ...MEASURED_STATISTICS });
  assert.equal(JSON.stringify(omitted).includes('КОРОТКИЙ'), false, 'no heading text leaks into an omission');
  assert.equal(JSON.stringify(omitted).includes('ГГГГ'), false, 'and no part of the over-wide heading either');
  assert.doesNotThrow(() => toolResultMessages([{ tool: 'read_structure', result: omitted }]));
  // POSITION NO LONGER DECIDES: the SAME over-wide heading in the middle of a longer outline omits the
  // whole array just the same, and the short texts beside it are withheld rather than published as a
  // PARTIAL outline. A partial array with `truncated: true` already means "more headings exist than are
  // reported", so publishing one here would leave the model unable to tell a withheld outline from a
  // capped one — the two states are kept distinguishable by the array being EMPTY.
  const mid = await readStructure(structureBridge(structured({ headings: ['а', 'б', over, 'в'],
    counts: { ...MEASURED_COUNTS, headings: 4 } })))
    .execute({}, { editor: 'word' });
  assert.equal(mid.ok, true);
  assert.deepEqual(mid.data.headings, [], 'an over-wide heading anywhere withholds the array');
  assert.equal(mid.data.truncated, true);
  assert.equal(mid.data.counts.headings, 4);
  assert.equal(JSON.stringify(mid).includes('"б"'), false, 'no partial outline is published');
  // The CAPPED case keeps its own, older meaning: texts ARE reported and `truncated` says the document
  // holds more of them. It is the non-empty array that distinguishes it from the omission above.
  const capped = await readStructure(structureBridge(structured({
    headings: new Array(LIMITS.structureHeadingsMax).fill('а'),
    counts: { ...MEASURED_COUNTS, headings: 500 } })))
    .execute({}, { editor: 'word' });
  assert.equal(capped.ok, true);
  assert.equal(capped.data.headings.length, LIMITS.structureHeadingsMax);
  assert.equal(capped.data.truncated, true);
  assert.equal(capped.data.counts.headings, 500);
  // The boundary is exact: the longest text the bound ADVERTISES is served verbatim, one byte over it is
  // the omission.
  const widest = 'Г'.repeat(LIMITS.structureHeadingBytes / 2);
  const served = await readStructure(structureBridge(structured({ headings: [widest],
    counts: { ...MEASURED_COUNTS, headings: 1 } })))
    .execute({}, { editor: 'word' });
  assert.equal(served.ok, true);
  assert.equal(served.data.headings.length, 1);
  assert.equal(served.data.headings[0].text, widest, 'the document\u2019s own heading, unshortened');
  assert.equal(utf8ByteLength(served.data.headings[0].text), LIMITS.structureHeadingBytes);
  // An omission is still MEASURED like every other publication, and it is small by construction: with
  // the document's own counts at their widest it stays inside the entry ceiling the runtime applies.
  const many = new Array(LIMITS.structureHeadingsMax).fill('а');
  many[0] = over;
  const huge = await readStructure(structureBridge(structured({ headings: many,
    counts: { paragraphs: Number.MAX_SAFE_INTEGER, headings: Number.MAX_SAFE_INTEGER,
      tables: Number.MAX_SAFE_INTEGER, sections: Number.MAX_SAFE_INTEGER } })))
    .execute({}, { editor: 'word' });
  assert.equal(huge.ok, true);
  assert.deepEqual(huge.data.headings, []);
  assert.equal(huge.data.counts.headings, Number.MAX_SAFE_INTEGER, 'the total is never narrowed to the report');
  assert.ok(utf8ByteLength(JSON.stringify({ tool: 'read_structure', ...huge })) <= AGENT_CEILINGS.toolResultBytes);
  assert.doesNotThrow(() => toolResultMessages([{ tool: 'read_structure', result: huge }]));
});

test('read_structure publishes an entry the runtime serializer accepts and refuses one it would refuse', async () => {
  // The raw text is NOT the bound: the runtime bounds the SERIALIZED entry, and `JSON.stringify` escapes
  // every C0 control character, so a heading inside the byte bound can still produce an entry far outside
  // the ceiling. The tool measures the entry it is about to publish and refuses when even the bounded
  // answer cannot fit — it never shortens a heading.
  const escaped = '\n'.repeat(LIMITS.structureHeadingBytes);
  const texts = new Array(LIMITS.structureHeadingsMax).fill(escaped);
  const over = await readStructure(structureBridge({ ok: true, pages: 1, statistics: { ...MEASURED_STATISTICS },
    counts: { ...MEASURED_COUNTS, headings: LIMITS.structureHeadingsMax }, headings: texts }))
    .execute({}, { editor: 'word' });
  assert.equal(over.ok, false, 'the entry, not the raw text, is the enforced bound');
  assert.equal(over.code, 'BYTE_LIMIT');
  assert.equal(over.data, undefined);
  // Smaller headings of the SAME document are SERVED, escapes and all: the bound is a real measurement,
  // not a blanket refusal. This shape — 32 headings of 128 `\n`, whose short escapes double each heading
  // to 256 serialized bytes — measures 9173 bytes, with 7211 of slack.
  const servedText = '\n'.repeat(LIMITS.structureHeadingBytes / 2);
  const served = await readStructure(structureBridge({ ok: true, pages: 1, statistics: { ...MEASURED_STATISTICS },
    counts: { ...MEASURED_COUNTS, headings: LIMITS.structureHeadingsMax }, headings: new Array(LIMITS.structureHeadingsMax).fill(servedText) }))
    .execute({}, { editor: 'word' });
  assert.equal(served.ok, true);
  const entry = utf8ByteLength(JSON.stringify({ tool: 'read_structure', ...served }));
  assert.ok(entry <= AGENT_CEILINGS.toolResultBytes, `${entry} <= ${AGENT_CEILINGS.toolResultBytes}`);
  assert.doesNotThrow(() => toolResultMessages([{ tool: 'read_structure', result: served }]));
  // The invariant across the boundary: no `ok` this handler publishes can exceed the ceiling, and a
  // served result is never shortened.
  for (const width of [0, 1, 2, 8, 16, 31, 32]) {
    const result = await readStructure(structureBridge({ ok: true, pages: 1, statistics: { ...MEASURED_STATISTICS },
      counts: { ...MEASURED_COUNTS, headings: width }, headings: new Array(width).fill(servedText) }))
      .execute({}, { editor: 'word' });
    assert.equal(result.ok, true, `width ${width}`);
    assert.equal(result.data.headings.length, width, `width ${width}`);
    assert.ok(utf8ByteLength(JSON.stringify({ tool: 'read_structure', ...result })) <= AGENT_CEILINGS.toolResultBytes, `width ${width}`);
    assert.doesNotThrow(() => toolResultMessages([{ tool: 'read_structure', result }]), `width ${width}`);
  }
});

test('read_structure publishes an entry of exactly the ceiling at its true maximum, and refuses one byte more', async () => {
  // THE TRUE MAXIMUM IS PINNED AGAINST THE REAL HANDLER, not against a hand-written JSON literal: the
  // widest shape this tool can publish is exactly `AGENT_CEILINGS.toolResultBytes` (16384), with ZERO
  // slack, and the check is `> 16384` — so it is still published. The shape is the 2x-escape family the
  // earlier arithmetic never named: `JSON.stringify('"')` is the TWO characters `\"`, so 238 `"` plus one
  // plain ASCII byte is 239 raw bytes (inside the 256-byte per-heading bound) whose escaped width is an
  // ODD 477 bytes, and the document's own counts are at their widest — the nine non-heading fields at
  // `Number.MAX_SAFE_INTEGER`, `counts.headings` at 14 digits.
  const MAX = Number.MAX_SAFE_INTEGER;
  const wide = { pages: MAX,
    statistics: { PageCount: MAX, WordsCount: MAX, ParagraphCount: MAX, SymbolsCount: MAX, SymbolsWSCount: MAX },
    counts: { paragraphs: MAX, headings: 10 ** 13, tables: MAX, sections: MAX } };
  const widest = new Array(LIMITS.structureHeadingsMax).fill('"'.repeat(238) + 'a');
  const published = await readStructure(structureBridge({ ok: true, ...wide, headings: widest }))
    .execute({}, { editor: 'word' });
  assert.equal(published.ok, true, 'the true maximum is published, not refused');
  assert.equal(published.data.truncated, true, 'counts.headings is far past the reported array');
  assert.equal(utf8ByteLength(JSON.stringify({ tool: 'read_structure', ...published })), 16384,
    'exactly the ceiling: the handler cannot publish a wider `ok`');
  assert.equal(AGENT_CEILINGS.toolResultBytes - 16384, 0, 'zero slack');
  assert.doesNotThrow(() => toolResultMessages([{ tool: 'read_structure', result: published }]));
  // ONE MORE escaped byte per heading — 240 `"`, still inside the 256-byte per-heading bound, so the
  // refusal here is the ENTRY measurement — measures 16480 and is the closed BYTE_LIMIT.
  const oneMore = await readStructure(structureBridge({ ok: true, ...wide,
    headings: new Array(LIMITS.structureHeadingsMax).fill('"'.repeat(240)) }))
    .execute({}, { editor: 'word' });
  assert.equal(oneMore.ok, false, 'one escaped byte per heading is over the ceiling');
  assert.equal(oneMore.code, 'BYTE_LIMIT');
  assert.equal(oneMore.data, undefined, 'and nothing of the over-ceiling entry is published');
  // The 16-digit shape of the SAME headings refuses too (`counts.headings` at `MAX_SAFE_INTEGER`), which
  // is why the true maximum spends 14 digits on that field and its own widest 16-digit shape is 16354.
  const sixteen = await readStructure(structureBridge({ ok: true, ...wide,
    counts: { ...wide.counts, headings: MAX }, headings: widest }))
    .execute({}, { editor: 'word' });
  assert.equal(sixteen.ok, false);
  assert.equal(sixteen.code, 'BYTE_LIMIT');
  const sixteenNarrow = await readStructure(structureBridge({ ok: true, ...wide,
    counts: { ...wide.counts, headings: MAX }, headings: new Array(LIMITS.structureHeadingsMax).fill('"'.repeat(238)) }))
    .execute({}, { editor: 'word' });
  assert.equal(sixteenNarrow.ok, true);
  assert.equal(utf8ByteLength(JSON.stringify({ tool: 'read_structure', ...sixteenNarrow })), 16354);
});

test('read_structure republishes the closed class the bridge reported, never a raw failure', async () => {
  const classes = ['TIMEOUT', 'CANCELLED', 'INVALID_DATA', 'CAPABILITY_UNAVAILABLE', 'EDITOR_BUSY', 'BYTE_LIMIT', 'TOOL_ERROR'];
  for (const code of classes) {
    const result = await readStructure(structureBridge({ ok: false, code })).execute({}, { editor: 'word' });
    assert.equal(result.ok, false, code);
    assert.equal(result.code, code, `${code} crosses unchanged`);
    assert.equal(result.message, 'отказ', code);
    assert.equal(result.data, undefined, code);
  }
  // Only a class from the closed vocabulary is republished: an arbitrary bridge string keeps the
  // module's own tool-error fallback rather than reaching the run as an invented code.
  for (const code of ['SOMETHING_ELSE', '', 7, null, undefined]) {
    const result = await readStructure(structureBridge({ ok: false, code })).execute({}, { editor: 'word' });
    assert.equal(result.code, 'TOOL_ERROR', JSON.stringify(code));
  }
  const thrown = await readStructure(structureBridge(null, { readStructure: async () => { const error = new Error('private native detail'); error.code = 'TIMEOUT'; throw error; } }))
    .execute({}, { editor: 'word' });
  assert.equal(thrown.code, 'TIMEOUT');
  assert.equal(thrown.message, 'отказ');
  const raw = await readStructure(structureBridge(null, { readStructure: async () => { throw new Error('private native detail'); } }))
    .execute({}, { editor: 'word' });
  assert.deepEqual(raw, { ok: false, code: 'TOOL_ERROR', message: 'отказ' }, 'a raw native failure never leaks');
});

test('read_structure maps a returned or thrown uncertain class to TOOL_UNCERTAIN', async () => {
  const returned = await readStructure(structureBridge({ ok: false, code: 'APPLY_UNCERTAIN' })).execute({}, { editor: 'word' });
  assert.deepEqual(returned, { ok: false, code: 'TOOL_UNCERTAIN', message: 'отказ' },
    'a returned uncertain bridge answer stops the run');
  const thrown = await readStructure(structureBridge(null, { readStructure: async () => { const error = new Error('x'); error.code = 'APPLY_UNCERTAIN'; throw error; } }))
    .execute({}, { editor: 'word' });
  assert.deepEqual(thrown, { ok: false, code: 'TOOL_UNCERTAIN', message: 'отказ' },
    'a thrown uncertain answer is classified identically');
});

test('read_structure treats an unusable bridge answer as the module\u2019s unknown convention', async () => {
  // An answer this tool cannot interpret is the module's closed `known()` class, never a publication of
  // whatever the envelope happened to hold: a missing or negative or fractional page count, a statistics
  // object that is not the measured five-field shape, counts that disagree with the headings they sent,
  // and a headings array that is not a bounded array of strings are all uninterpretable.
  const answers = [
    null, undefined, 7, 'структура', [],
    { ok: true },
    { ok: true, pages: 1 },
    { ok: true, pages: 1, statistics: { ...MEASURED_STATISTICS }, counts: { ...MEASURED_COUNTS } },
    { ok: true, pages: 1, statistics: { ...MEASURED_STATISTICS }, counts: { ...MEASURED_COUNTS }, headings: 'текст' },
    { ok: true, pages: -1, statistics: { ...MEASURED_STATISTICS }, counts: { ...MEASURED_COUNTS, headings: 0 }, headings: [] },
    { ok: true, pages: 1.5, statistics: { ...MEASURED_STATISTICS }, counts: { ...MEASURED_COUNTS, headings: 0 }, headings: [] },
    { ok: true, pages: '1', statistics: { ...MEASURED_STATISTICS }, counts: { ...MEASURED_COUNTS, headings: 0 }, headings: [] },
    { ok: true, pages: 1, statistics: { ...MEASURED_STATISTICS, PageCount: '1' }, counts: { ...MEASURED_COUNTS, headings: 0 }, headings: [] },
    { ok: true, pages: 1, statistics: { ...MEASURED_STATISTICS, PageCount: -1 }, counts: { ...MEASURED_COUNTS, headings: 0 }, headings: [] },
    { ok: true, pages: 1, statistics: { ...MEASURED_STATISTICS, PageCount: 1.5 }, counts: { ...MEASURED_COUNTS, headings: 0 }, headings: [] },
    { ok: true, pages: 1, statistics: { ...MEASURED_STATISTICS, WordsCount: undefined }, counts: { ...MEASURED_COUNTS, headings: 0 }, headings: [] },
    { ok: true, pages: 1, statistics: null, counts: { ...MEASURED_COUNTS, headings: 0 }, headings: [] },
    { ok: true, pages: 1, statistics: { ...MEASURED_STATISTICS }, counts: null, headings: [] },
    { ok: true, pages: 1, statistics: { ...MEASURED_STATISTICS }, counts: { ...MEASURED_COUNTS, headings: -1 }, headings: [] },
    { ok: true, pages: 1, statistics: { ...MEASURED_STATISTICS }, counts: { ...MEASURED_COUNTS, paragraphs: 1.5 }, headings: [] },
    { ok: true, pages: 1, statistics: { ...MEASURED_STATISTICS }, counts: { ...MEASURED_COUNTS, headings: 1 }, headings: [] },
    { ok: true, pages: 1, statistics: { ...MEASURED_STATISTICS }, counts: { ...MEASURED_COUNTS, headings: 0 }, headings: ['лишний'] },
    { ok: true, pages: 1, statistics: { ...MEASURED_STATISTICS }, counts: { ...MEASURED_COUNTS, headings: 1 }, headings: [7] },
    { ok: true, pages: 1, statistics: { ...MEASURED_STATISTICS }, counts: { ...MEASURED_COUNTS, headings: 1 }, headings: ['а', 'б'] },
    { ok: true, pages: 1, statistics: { ...MEASURED_STATISTICS }, counts: { ...MEASURED_COUNTS, headings: 0 }, headings: new Array(3).fill('x') }
  ];
  for (const answer of answers) {
    const result = await readStructure(structureBridge(answer)).execute({}, { editor: 'word' });
    assert.equal(result.ok, false, JSON.stringify(answer));
    assert.equal(result.code, 'TOOL_ERROR', JSON.stringify(answer));
    assert.equal(result.message, 'отказ', JSON.stringify(answer));
    assert.equal(result.data, undefined, JSON.stringify(answer));
  }
  // A `headings` array LONGER than the cap the tool asked for is uninterpretable too: the bridge was
  // told the cap, so more than that is not an answer this tool can attribute to its own request.
  const overCap = await readStructure(structureBridge({ ok: true, pages: 1, statistics: { ...MEASURED_STATISTICS },
    counts: { ...MEASURED_COUNTS, headings: LIMITS.structureHeadingsMax + 1 },
    headings: new Array(LIMITS.structureHeadingsMax + 1).fill('а') })).execute({}, { editor: 'word' });
  assert.equal(overCap.ok, false);
  assert.equal(overCap.code, 'TOOL_ERROR');
});

test('read_structure refuses an editor that is not Word before any dispatch', async () => {
  const bridge = structureBridge(structured());
  const tool = readStructure(bridge);
  for (const editor of ['cell', 'slide', 'unknown']) {
    const refusal = tool.precondition({}, { editor });
    assert.equal(refusal.code, 'CAPABILITY_UNAVAILABLE', editor);
    assert.equal(refusal.message, 'отказ', editor);
  }
  assert.equal(tool.precondition({}, { editor: 'word' }), null);
  assert.deepEqual(bridge.requests, [], 'the precondition is what refuses, and it dispatches nothing');
});

test('read_structure refuses a bridge that cannot serve the read instead of crashing', async () => {
  for (const bridge of [null, undefined, {}, { readStructure: 'no' }, { readStructure: 7 }]) {
    const result = await readStructure(bridge).execute({}, { editor: 'word' });
    assert.equal(result.ok, false, JSON.stringify(bridge));
    assert.equal(result.code, 'CAPABILITY_UNAVAILABLE', JSON.stringify(bridge));
    assert.equal(result.message, 'отказ', JSON.stringify(bridge));
  }
});

test('read_structure touches exactly one bridge read and no write method at all', async () => {
  const touched = [];
  const record = (method, value) => async () => { touched.push({ method }); return value; };
  const bridge = {
    readStructure: async (request) => { touched.push({ method: 'readStructure', request }); return structured(); },
    readSelection: record('readSelection', {}),
    readDocumentText: record('readDocumentText', {}),
    readParagraph: record('readParagraph', {}),
    readContext: record('readContext', {}),
    findText: record('findText', { ok: true, count: 0, texts: [] }),
    insertParagraph: record('insertParagraph', { ok: true, data: {} }),
    applySelection: record('applySelection', {})
  };
  const result = await readStructure(bridge).execute({}, { editor: 'word' });
  assert.equal(result.ok, true);
  assert.deepEqual(touched, [{ method: 'readStructure', request: { maxHeadings: LIMITS.structureHeadingsMax } }],
    'ONE structure read, with the cap it advertises, and no other leg');
  for (const method of ['insertParagraph', 'applySelection', 'readSelection', 'readContext', 'readDocumentText', 'readParagraph', 'findText']) {
    assert.equal(touched.some(entry => entry.method === method), false, `${method} is never reached`);
  }
});

test('read_structure forwards the caller signal to its single bridge read', async () => {
  const bridge = structureBridge(structured());
  const controller = new AbortController();
  await readStructure(bridge).execute({}, { editor: 'word', signal: controller.signal });
  assert.deepEqual(bridge.requests, [{ maxHeadings: LIMITS.structureHeadingsMax, signal: controller.signal }]);
});

// --- the real bridge: the fourth authored command body and the flat native answer it decodes --------
// The rig reproduces the vendor wrapper exactly as `findRig` does: it reads `Asc.scope` SYNCHRONOUSLY,
// hands the body that value, and evaluates the body the way the EDITOR does — in a fresh, module-free
// scope whose only bindings are `Api` and `scope`.
function measuredDocument({ headings = MEASURED_HEADINGS, tables = 1, sections = 1, paragraphs = 10,
  statistics = MEASURED_STATISTICS, pageCount = 1 } = {}) {
  return {
    GetPageCount() { return pageCount; },
    GetStatistics() { return { ...statistics }; },
    GetAllParagraphs() { return new Array(paragraphs).fill(null).map(() => ({})); },
    GetAllHeadingParagraphs() { return headings.map(text => ({ GetClassType() { return 'paragraph'; }, GetText() { return text; } })); },
    GetAllTables() { return new Array(tables).fill(null).map(() => ({})); },
    GetSections() { return new Array(sections).fill(null).map(() => ({})); }
  };
}
function evaluateStructureBody(body, api, scope) {
  return new Function('Api', 'scope', 'return (' + Function.prototype.toString.call(body) + ')();')(api, scope);
}
function structureRig({ document = undefined, command = true, namespace = { scope: 'сентинел' }, omitCarrier = false } = {}) {
  const commands = [];
  const api = { GetDocument() { return document === undefined ? measuredDocument() : document; } };
  const plugin = { info: { editorType: 'word' },
    callCommand: command ? function (body, close, recalculate, callback) {
      const source = Function.prototype.toString.call(body);
      const scope = namespace?.scope;
      const answer = evaluateStructureBody(body, api, scope);
      commands.push({ by: 'callCommand', body, source, close, recalculate, scope, answer });
      callback(answer);
      return false;
    } : undefined };
  const options = { editorType: 'word', clock: { now: () => 0 }, timers: { schedule() { return {}; }, clear() {} } };
  if (!omitCarrier) options.ascNamespace = namespace;
  const bridge = bridgeWith(plugin, options);
  return { bridge, plugin, commands, namespace, api };
}

test('bridge readStructure dispatches ONE command, carries the cap as DATA and restores the namespace', async () => {
  const namespace = { scope: 'предыдущая-область' };
  const r = structureRig({ document: measuredDocument(), namespace });
  const pending = r.bridge.readStructure({ maxHeadings: LIMITS.structureHeadingsMax });
  assert.equal(r.commands.length, 1, 'exactly ONE command is dispatched');
  const carried = r.commands[0];
  assert.equal(carried.by, 'callCommand', 'the wrapper is the entry point the measured build exposes');
  assert.equal(typeof carried.body, 'function', 'the body is handed as an authored function literal, never as text');
  assert.equal(carried.close, false, 'the documented close/recalculate arguments are unchanged');
  assert.equal(carried.recalculate, false);
  assert.deepEqual(carried.scope, { maxHeadings: LIMITS.structureHeadingsMax },
    'the extraction cap crosses as the command SCOPE, never interpolated into source');
  assert.equal(namespace.scope, 'предыдущая-область', 'the namespace is restored: no cap outlives its dispatch');
  // The native answer is the flat array of PRIMITIVES the validator keeps, in the authored order.
  assert.deepEqual(carried.answer, [1, 1, 25, 10, 150, 165, 10, 3, 1, 1, 'ГЛАВА ПЕРВАЯ', 'ГЛАВА ВТОРАЯ', 'ПОДРАЗДЕЛ'],
    'the body encodes the measured structure as one array of primitives');
  // The body is SELF-CONTAINED: the text that reaches the editor names no module binding of bridge.js.
  assert.equal(/\b(?:capabilityBody|contextBody|commandTransport|createCommandDispatch|decodeStructure|pluginOwners|createR7Bridge)\b/.test(carried.source),
    false, 'the stringified body must be self-contained, not a closure over bridge.js');
  const result = await pending;
  assert.deepEqual(result, { ok: true, pages: 1, statistics: { ...MEASURED_STATISTICS },
    counts: { ...MEASURED_COUNTS }, headings: [...MEASURED_HEADINGS] });
  assert.ok(Object.isFrozen(result));
  assert.equal(r.bridge.getState().busy, false, 'the slot is released by the native callback');
});

test('the structure body answers the measured shapes in a fresh, module-free scope', async () => {
  // The editor's own evaluation, independent of the bridge: a free module identifier resolves to nothing
  // in this scope and the whole call dies, exactly as it did natively on 2026.3.1 (commit 273d70e).
  const r = structureRig({ document: measuredDocument({ headings: [] , tables: 0, sections: 1 }) });
  const pending = r.bridge.readStructure({ maxHeadings: LIMITS.structureHeadingsMax });
  const body = r.commands[0];
  const evaluated = evaluateStructureBody(body.body, r.api, body.scope);
  assert.deepEqual(evaluated, [1, 1, 25, 10, 150, 165, 10, 0, 0, 1],
    'an empty outline is the ten fixed slots and no texts');
  assert.deepEqual(await pending, { ok: true, pages: 1, statistics: { ...MEASURED_STATISTICS },
    counts: { paragraphs: 10, headings: 0, tables: 0, sections: 1 }, headings: [] });
  // The extraction is bounded IN THE EDITOR: a document with five hundred headings crosses at most
  // `maxHeadings` texts while the count it reports stays the primitive's own total.
  const many = structureRig({ document: measuredDocument({ headings: new Array(500).fill('раздел') }) });
  const bounded = await many.bridge.readStructure({ maxHeadings: LIMITS.structureHeadingsMax });
  assert.equal(bounded.ok, true);
  assert.equal(bounded.headings.length, LIMITS.structureHeadingsMax);
  assert.equal(bounded.counts.headings, 500, 'the total is the primitive\u2019s own, never the extracted count');
  assert.equal(many.commands[0].answer.length, 10 + LIMITS.structureHeadingsMax);
  // A body that cannot read the structure answers its own refusal sentinel, which the decoder maps to
  // the closed capability class rather than to a structure of zeros.
  for (const document of [null, {}, { GetPageCount: 1 }, { ...measuredDocument(), GetStatistics: null },
    { ...measuredDocument(), GetAllHeadingParagraphs: 7 }]) {
    const missing = structureRig({ document });
    const result = await missing.bridge.readStructure({ maxHeadings: 1 });
    assert.deepEqual(result, { ok: false, code: 'CAPABILITY_UNAVAILABLE' }, JSON.stringify(document));
    assert.equal(missing.bridge.getState().busy, false);
  }
});

test('bridge readStructure decodes the measured shapes and refuses an answer it cannot interpret', async () => {
  const r = structureRig();
  const missing = await r.bridge.readStructure({ maxHeadings: LIMITS.structureHeadingsMax });
  assert.deepEqual(missing, { ok: true, pages: 1, statistics: { ...MEASURED_STATISTICS },
    counts: { ...MEASURED_COUNTS }, headings: [...MEASURED_HEADINGS] });
  assert.equal(r.commands.length, 1, 'one command per read, and no identity probe');
  // A native answer that is not the authored shape is INVALID_DATA, never a publication of whatever
  // arrived; one above the bridge's own read window is BYTE_LIMIT. Neither leaks the native text.
  const poisoned = (raw) => {
    const plugin = { info: { editorType: 'word' }, callCommand: (_body, _close, _recalculate, callback) => { callback(raw); return false; } };
    return bridgeWith(plugin, { editorType: 'word', ascNamespace: { scope: undefined }, clock: { now: () => 0 },
      timers: { schedule() { return {}; }, clear() {} } });
  };
  const fixed = [1, 1, 25, 10, 150, 165, 10, 3, 1, 1];
  for (const raw of [null, undefined, 7, 'текст', {}, [true], ['CAPABILITY_UNAVAILABLE'], [5], [1],
    [...fixed.slice(0, 9)], [...fixed, 1], [...fixed, 'a'], [1.5, ...fixed.slice(1)],
    [-1, ...fixed.slice(1)], [1, '1', ...fixed.slice(2)], [1, ...fixed.slice(1), 1],
    [...fixed.map((value, index) => (index === 9 ? -1 : value))]]) {
    const result = await poisoned(raw).readStructure({ maxHeadings: 2 });
    assert.equal(result.ok, false, JSON.stringify(raw));
    assert.equal(result.code, raw && raw[0] === 'CAPABILITY_UNAVAILABLE' ? 'CAPABILITY_UNAVAILABLE' : 'INVALID_DATA',
      JSON.stringify(raw));
    assert.equal(JSON.stringify(result).includes('ГЛАВА'), false, 'no native text leaks through a refusal');
  }
  // The authored answer for a document whose outline is empty is LEGAL: ten slots and no texts.
  const noHeadings = [...fixed.slice(0, 7), 0, ...fixed.slice(8)];
  assert.deepEqual(await poisoned(noHeadings).readStructure({ maxHeadings: 2 }),
    { ok: true, pages: 1, statistics: { ...MEASURED_STATISTICS }, counts: { paragraphs: 10, headings: 0, tables: 1, sections: 1 }, headings: [] });
  // The body extracts EXACTLY `min(count, maxHeadings)` texts, so an answer with a different number is
  // not one the authored body can have produced, and the decoder refuses it rather than publishing a
  // short outline the tool would describe as its own cap.
  assert.deepEqual(await poisoned([...fixed, 'a']).readStructure({ maxHeadings: 2 }),
    { ok: false, code: 'INVALID_DATA' });
  assert.deepEqual(await poisoned([...fixed, 'a', 'b']).readStructure({ maxHeadings: 2 }),
    { ok: true, pages: 1, statistics: { ...MEASURED_STATISTICS }, counts: { ...MEASURED_COUNTS }, headings: ['a', 'b'] },
    'min(3, 2) = 2 texts is the authored shape, with the primitive\u2019s own total');
  const oversized = await poisoned([...fixed, 'я'.repeat(35000), 'я'.repeat(35000)]).readStructure({ maxHeadings: 2 });
  assert.equal(oversized.code, 'BYTE_LIMIT', 'an answer above the bridge\u2019s read window is refused');
});

test('bridge readStructure refuses a build, a namespace or a request it cannot use, with the closed class', async () => {
  // No command channel at all: nothing is dispatched, and the refusal is the closed capability class.
  const noCommand = structureRig({ command: false });
  assert.deepEqual(await noCommand.bridge.readStructure({ maxHeadings: 1 }), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
  assert.deepEqual(noCommand.commands, [], 'no command is dispatched by a facade that has none');
  // A namespace that cannot carry the cap is the SAME closed refusal, decided BEFORE the dispatch.
  for (const shape of [{ omitCarrier: true }, { namespace: null }, { namespace: Object.freeze({}) },
    { namespace: Object.freeze({ scope: 'предыдущая-область' }) }]) {
    const r = structureRig(shape);
    assert.deepEqual(await r.bridge.readStructure({ maxHeadings: 1 }), { ok: false, code: 'CAPABILITY_UNAVAILABLE' },
      JSON.stringify(shape));
    assert.deepEqual(r.commands, [], 'nothing is dispatched when the scope cannot cross');
    assert.equal(r.bridge.getState().busy, false, 'and the slot is released');
  }
  // A request this bridge cannot interpret is refused with the closed class and NO SDK work: the cap is
  // a closed precondition, never an optional refinement, and `maxHeadings` is bounded by the advertised
  // maximum so a caller cannot ask the editor to extract an unbounded outline.
  for (const raw of [undefined, null, {}, { maxHeadings: 0 }, { maxHeadings: -1 }, { maxHeadings: 1.5 },
    { maxHeadings: '2' }, { maxHeadings: LIMITS.structureHeadingsMax + 1 }]) {
    const r = structureRig();
    const result = await r.bridge.readStructure(raw ?? {});
    assert.equal(result.ok, false, JSON.stringify(raw));
    assert.equal(result.code, 'CAPABILITY_UNAVAILABLE', JSON.stringify(raw));
    assert.deepEqual(r.commands, [], JSON.stringify(raw));
    assert.equal(r.bridge.getState().busy, false, JSON.stringify(raw));
  }
  // A pre-aborted signal never reaches the editor.
  const r = structureRig();
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await r.bridge.readStructure({ maxHeadings: 1, signal: controller.signal }), { ok: false, code: 'CANCELLED' });
  assert.deepEqual(r.commands, []);
  assert.equal(r.bridge.getState().busy, false);
});

test('read_structure is offered with policy auto and a model call dispatches exactly one structure read', async () => {
  const r = structureRig();
  const registry = createRegistry(createWordTools(r.bridge));
  const catalogue = registry.catalogue({ editor: 'word', capabilities: ['document.read', 'document.write'], mode: 'EDIT' });
  const offered = catalogue.find(entry => entry.name === 'read_structure');
  assert.ok(offered, 'the offered catalogue contains read_structure');
  assert.equal(offered.policy, 'auto');
  assert.equal(offered.kind, 'read');
  assert.equal(offered.requires.includes('document.read'), true);
  const batch = validateBatch(catalogue, [{ tool: 'read_structure', arguments: {} }]);
  assert.equal(batch.length, 1);
  assert.equal(batch[0].descriptor.name, 'read_structure');
  const responses = ['{"type":"tool_calls","calls":[{"tool":"read_structure","arguments":{}}]}',
    '{"type":"final","message":"структура прочитана"}'];
  const crossed = [];
  let step = 0;
  const run = await runAgent({ registry, editor: 'word', capabilities: ['document.read', 'document.write'], mode: 'EDIT',
    settings: {}, uuid: '55555555-5555-4555-8555-555555555555', request: 'какая структура у документа',
    transport: async (messages) => { crossed.push(messages.map(message => message.content)); return { content: responses[step++] ?? responses[responses.length - 1] }; } });
  assert.equal(run.status, 'FINAL');
  assert.deepEqual(run.actions.map(action => [action.tool, action.outcome]), [['read_structure', 'ok']]);
  assert.equal(r.commands.length, 1, 'one structure read for the whole run, and no write path touched');
  assert.equal(r.bridge.getState().busy, false);
  // The model really RECEIVES the bounded answer — the statistics, the counts and the headings' own
  // texts — through the runtime's own per-result serialization, not a summary this test invented.
  const toolResults = crossed.flat().filter(content => content.includes('"type":"tool_results"'));
  assert.equal(toolResults.length, 1, 'one tool-result message crossed to the model');
  const published = JSON.parse(toolResults[0]).results[0];
  assert.equal(published.tool, 'read_structure');
  assert.equal(published.ok, true);
  assert.deepEqual(published.data.statistics, { ...MEASURED_STATISTICS });
  assert.deepEqual(published.data.counts, { ...MEASURED_COUNTS });
  assert.deepEqual(published.data.headings.map(heading => heading.text), [...MEASURED_HEADINGS]);
  assert.equal(published.data.truncated, false);
});


// --- Sprint 3, tool 5: `insert_blocks` — the FIRST MUTATION, under an EXACT-DELTA contract ----------
//
// THE MECHANISM'S GROUND TRUTH IS THE DOCUMENT, NEVER THE PRIMITIVE'S RETURN VALUE. Measured on the
// target (Astra / R7 2026.1.2.1942, this round): a mutation primitive's boolean carries NO information
// about what the document now holds — neither a `true` nor a `false` does (`Push` answered `true` for a
// paragraph and `false` for an image host; the legacy whole-array primitive answered `true` even for
// `[]`, `[null]` and `'nonsense'`). The evidence is the delta between the document's OWN counts before
// and after (`GetAllParagraphs()` went 10 → 11 and `GetAllHeadingParagraphs()` 3 → 4 for one inserted
// heading paragraph), plus one presence flag per block for the region the append added. The tool is
// therefore a pure arbiter over four counts and one presence flag per block, and every test below drives
// exactly those. THE ROUTE is `Push`, one call per block, which the target measures as an APPEND AT THE
// END; the tool never calls the legacy whole-array primitive, which the same target measures as landing
// at the BEGINNING (and, with a selection present, replacing existing text).
function blocksBridge(answer, extras = {}) {
  const seen = [];
  return { seen, insertBlocks: async (args) => { seen.push(args); return typeof answer === 'function' ? answer(args) : answer; }, ...extras };
}
function insertBlocksTool(bridge) { return createWordTools(bridge).find(entry => entry.name === 'insert_blocks'); }
// The envelope the REAL bridge publishes for an append of `count` blocks, `headingCount` of them
// headings: the four counts around the append (the delta is what is verified) and one presence flag per
// block, in the order the blocks were asked for.
function appended(before, headingsBefore, count, headingCount, overrides = {}) {
  return { ok: true, paragraphsBefore: before, paragraphsAfter: before + count,
    headingsBefore, headingsAfter: headingsBefore + headingCount,
    present: new Array(count).fill(true), ...overrides };
}
const TWO_BLOCKS = Object.freeze([{ text: 'Глава', heading: 1 }, { text: 'Текст' }]);

test('insert_blocks advertises the closed bounded schema and the four bounds it names', () => {
  const tool = insertBlocksTool(blocksBridge(appended(10, 3, 1, 0)));
  assert.equal(tool.name, 'insert_blocks');
  assert.equal(tool.kind, 'mutate');
  assert.deepEqual([...tool.editors], ['word']);
  assert.equal(tool.policy, 'auto');
  assert.deepEqual([...tool.requires], ['document.write']);
  const schema = tool.schema;
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['blocks']);
  assert.deepEqual(Object.keys(schema.properties), ['blocks']);
  const blocks = schema.properties.blocks;
  assert.equal(blocks.type, 'array');
  assert.equal(blocks.maxItems, LIMITS.insertBlocksMax);
  assert.equal(blocks.minItems, undefined,
    'the closed schema vocabulary has no minItems keyword (src/tools/schemas.js allowlists every keyword), so the lower bound is NOT advertised as a keyword nothing would enforce: it is enforced by the handler and by the bridge, and both are tested below');
  assert.equal(blocks.items.type, 'object');
  assert.equal(blocks.items.additionalProperties, false);
  assert.deepEqual(blocks.items.required, ['text']);
  assert.deepEqual(Object.keys(blocks.items.properties), ['text', 'heading']);
  assert.equal(blocks.items.properties.text.type, 'string');
  assert.equal(blocks.items.properties.text.minBytes, 1);
  assert.equal(blocks.items.properties.text.maxBytes, LIMITS.insertBlockBytes);
  assert.equal(blocks.items.properties.heading.type, 'integer');
  assert.equal(blocks.items.properties.heading.minimum, 1);
  assert.equal(blocks.items.properties.heading.maximum, LIMITS.insertHeadingMax);
  // The four named bounds, pinned as NUMBERS and as distinct quantities: none is an alias of another
  // tool's scope, and the whole-payload bound is the per-action argument ceiling the runtime applies.
  assert.deepEqual([LIMITS.insertBlocksMax, LIMITS.insertBlockBytes, LIMITS.insertBlocksBytes, LIMITS.insertHeadingMax],
    [64, 2048, 8192, 9]);
  assert.equal(LIMITS.insertBlocksBytes, AGENT_CEILINGS.argumentsBytes, 'the whole payload IS the per-action argument ceiling');
  assert.notEqual(LIMITS.insertBlockBytes, AGENT_CEILINGS.argumentsBytes, 'one block is not the whole action');
  assert.notEqual(LIMITS.insertHeadingMax, LIMITS.structureHeadingsMax, 'a heading LEVEL is not a heading COUNT');
  // And the module's own validator really carries it, so the descriptor is accepted whole.
  assert.equal(validateArguments(schema, { blocks: [{ text: 'а', heading: 2 }] }).blocks.length, 1);
});

test('insert_blocks refuses every illegal argument with nothing dispatched, at the schema or in the handler', async () => {
  // The closed schema vocabulary expresses ONE of this tool's two array bounds (`maxItems`), so the
  // lower bound and every deep rule the schema does carry are asserted the same way: an illegal argument
  // is refused — by `validateArguments` as TOOL_ERROR or by the handler as a closed refusal — and
  // NOTHING reaches the bridge. The empty array is the one row the schema cannot refuse, which is
  // exactly why the handler owns it.
  const illegal = [
    ['no argument object', null], ['missing blocks', {}], ['blocks is not an array', { blocks: 'а' }],
    ['an unknown top-level key', { blocks: [{ text: 'а' }], text: 'а' }],
    ['an EMPTY array (minItems 1, handler-owned)', { blocks: [] }],
    ['too many items', { blocks: new Array(LIMITS.insertBlocksMax + 1).fill({ text: 'а' }) }],
    ['an item that is not an object', { blocks: [null] }], ['an item with no text', { blocks: [{}] }],
    ['an item with an empty text', { blocks: [{ text: '' }] }], ['a non-string text', { blocks: [{ text: 7 }] }],
    ['an unknown key inside an item', { blocks: [{ text: 'а', style: 'Heading 1' }] }],
    ['a fractional heading', { blocks: [{ text: 'а', heading: 1.5 }] }],
    ['a heading below the bound', { blocks: [{ text: 'а', heading: 0 }] }],
    ['a heading above the bound', { blocks: [{ text: 'а', heading: LIMITS.insertHeadingMax + 1 }] }],
    ['a stringified heading', { blocks: [{ text: 'а', heading: '1' }] }],
    ['a null heading', { blocks: [{ text: 'а', heading: null }] }]
  ];
  for (const [label, args] of illegal) {
    const bridge = blocksBridge(appended(10, 3, 1, 0));
    const tool = insertBlocksTool(bridge);
    let schemaRefused = false;
    try { validateArguments(tool.schema, args); }
    catch (error) { schemaRefused = true; assert.equal(error.code, 'TOOL_ERROR', label); }
    if (!schemaRefused) {
      const result = await tool.execute(args, { editor: 'word' });
      assert.equal(result.ok, false, label);
      assert.equal(result.code, 'TOOL_ERROR', label);
      assert.equal(result.data, undefined, label);
    }
    assert.deepEqual(bridge.seen, [], `${label}: nothing is dispatched for an illegal argument`);
  }
  // The two BYTE bounds are the closed byte class, not the argument-shape class, on both sides of the
  // boundary: one text above its own bound (which the SCHEMA can already refuse), and a payload whose
  // texts are each legal while their SUM is not (which only the handler can). The bridge applies the
  // same two numbers, so a descriptor held directly is bounded too.
  const single = blocksBridge(appended(10, 3, 1, 0));
  assert.throws(() => validateArguments(insertBlocksTool(single).schema, { blocks: [{ text: 'я'.repeat(2048) }] }),
    /TOOL_ERROR/, 'a single text above its own bound is refused at the schema, before the handler');
  const sumBridge = blocksBridge(appended(10, 3, 1, 0));
  const sumTool = insertBlocksTool(sumBridge);
  const fiveLegal = { blocks: new Array(5).fill({ text: 'я'.repeat(900) }) };
  assert.equal(validateArguments(sumTool.schema, fiveLegal).blocks.length, 5,
    'the schema bounds ONE text and the COUNT: it cannot sum a payload, which is why the handler does');
  const sumResult = await sumTool.execute(fiveLegal, { editor: 'word' });
  assert.equal(sumResult.code, 'BYTE_LIMIT', 'five texts each inside insertBlockBytes, whose sum exceeds the payload bound');
  const overBlock = blocksBridge(appended(10, 3, 1, 0));
  const blockResult = await insertBlocksTool(overBlock).execute({ blocks: [{ text: 'я'.repeat(2048) }] }, { editor: 'word' });
  assert.equal(blockResult.code, 'BYTE_LIMIT', 'one text above insertBlockBytes is the closed byte class');
  assert.deepEqual([...overBlock.seen, ...sumBridge.seen], [],
    'neither over-bound payload reaches the bridge, and the handler owns the sum the schema cannot see');
});

test('insert_blocks appends through exactly ONE bridge call and publishes the measured delta', async () => {
  const bridge = blocksBridge(appended(10, 3, 2, 1));
  const controller = new AbortController();
  const result = await insertBlocksTool(bridge).execute({ blocks: TWO_BLOCKS }, { editor: 'word', signal: controller.signal });
  assert.equal(result.ok, true);
  // `bytes` is the dispatched payload's own size — the sum of the block texts' UTF-8 bytes — so the
  // result reports what crossed to the editor and not the result's own size.
  assert.deepEqual(result.data, { inserted: 2, headings: 1, paragraphsBefore: 10, paragraphsAfter: 12, bytes: 20 });
  assert.deepEqual(Object.keys(result.data), ['inserted', 'headings', 'paragraphsBefore', 'paragraphsAfter', 'bytes'],
    'the five measured fields and nothing else: an envelope cannot smuggle a field into the entry');
  // EXACTLY one bridge call: the append is dispatched once and never retried, and the caller's signal
  // crosses with it so a Stop cancels before the dispatch.
  assert.equal(bridge.seen.length, 1);
  assert.deepEqual(bridge.seen[0].blocks, TWO_BLOCKS);
  assert.equal(bridge.seen[0].signal, controller.signal);
  assert.equal(utf8ByteLength('Глава') + utf8ByteLength('Текст'), 20);
});

test('insert_blocks publishes a verified append ONLY for the exact delta, and never retries otherwise', async () => {
  const wrong = [
    ['one paragraph SHORT', appended(10, 3, 2, 1, { paragraphsAfter: 11 })],
    ['one paragraph OVER', appended(10, 3, 2, 1, { paragraphsAfter: 13 })],
    ['a document that SHRANK', appended(10, 3, 2, 1, { paragraphsAfter: 9 })],
    ['no paragraph growth at all', appended(10, 3, 2, 1, { paragraphsAfter: 10 })],
    ['a heading count that did not grow', appended(10, 3, 2, 0)],
    ['a heading count that grew twice over', appended(10, 3, 2, 2)]
  ];
  const run = async (answer, blocks = TWO_BLOCKS) => {
    const bridge = blocksBridge(answer);
    return { result: await insertBlocksTool(bridge).execute({ blocks }, { editor: 'word' }), bridge };
  };
  const verified = await run(appended(10, 3, 2, 1));
  assert.equal(verified.result.ok, true);
  assert.equal(verified.bridge.seen.length, 1);
  for (const [label, answer] of wrong) {
    const { result, bridge } = await run(answer);
    assert.equal(result.ok, false, label);
    assert.equal(result.code, 'TOOL_UNCERTAIN', label);
    assert.equal(result.message, 'отказ', label);
    assert.equal(result.data, undefined, `${label}: an uncertain outcome publishes no delta`);
    assert.equal(bridge.seen.length, 1, `${label}: NO retry — the append was dispatched exactly once`);
  }
  // A block text that is NOT in the document is the third leg of the same rule, even when both counts
  // grew exactly: the counts alone could be an unrelated edit, so presence is required as well.
  for (const present of [[true, false], [false, true], [false, false]]) {
    const { result, bridge } = await run(appended(10, 3, 2, 1, { present }));
    assert.equal(result.ok, false, JSON.stringify(present));
    assert.equal(result.code, 'TOOL_UNCERTAIN', JSON.stringify(present));
    assert.equal(bridge.seen.length, 1, JSON.stringify(present));
  }
  // A flag that is not a boolean is not a presence check at all: that envelope is UNINTERPRETABLE, and
  // the module's convention for one is the closed known class (`known()`), exactly as for a count that is
  // not an integer. The failure is not reachable through the real bridge — its decoder requires exactly
  // `0` or `1` per flag, publishes booleans, and turns its OWN uninterpretable answer into the uncertain
  // class with the slot held — so this leg closes the direct-descriptor path only.
  for (const present of [[1, 1], ['true', 'true'], [true, 0]]) {
    const { result } = await run(appended(10, 3, 2, 1, { present }));
    assert.equal(result.ok, false, JSON.stringify(present));
    assert.equal(result.code, 'TOOL_ERROR', JSON.stringify(present));
  }
});

test('insert_blocks refuses an unusable baseline or a heading style it cannot resolve, with nothing inserted', async () => {
  // THE BASELINE GATE. A bridge that cannot establish where the document started cannot establish the
  // delta either, so it refuses BEFORE the append: the closed capability class, and no `data` at all.
  const gated = await insertBlocksTool(blocksBridge({ ok: false, code: 'CAPABILITY_UNAVAILABLE' }))
    .execute({ blocks: TWO_BLOCKS }, { editor: 'word' });
  assert.equal(gated.ok, false);
  assert.equal(gated.code, 'CAPABILITY_UNAVAILABLE');
  assert.equal(gated.data, undefined);
  // THE STYLE GATE, and the code is TOOL_ERROR by a DECISION that is stated here: the editor's heading
  // capability is intact (it resolves styles and inserts content) — what this document does not define
  // is the requested `Heading <n>`, so the failure is about the ARGUMENT. It is not the uncertain class
  // either: the body resolves every style BEFORE its first `Push`, so nothing was inserted, and an
  // uncertain outcome would be false information about a documented mutation that provably did not
  // happen. The real bridge leg below proves the no-insert half of that statement.
  const styled = await insertBlocksTool(blocksBridge({ ok: false, code: 'TOOL_ERROR' }))
    .execute({ blocks: [{ text: 'Глава', heading: 1 }] }, { editor: 'word' });
  assert.equal(styled.ok, false);
  assert.equal(styled.code, 'TOOL_ERROR');
  assert.equal(styled.data, undefined);
});

test('insert_blocks republishes the closed class the bridge reported, never a raw failure', async () => {
  for (const code of ['CAPABILITY_UNAVAILABLE', 'TOOL_ERROR', 'BYTE_LIMIT', 'EDITOR_BUSY', 'TIMEOUT', 'CANCELLED', 'INVALID_DATA']) {
    const bridge = blocksBridge({ ok: false, code });
    const result = await insertBlocksTool(bridge).execute({ blocks: TWO_BLOCKS }, { editor: 'word' });
    assert.equal(result.ok, false, code);
    assert.equal(result.code, code, code);
    assert.equal(result.message, 'отказ', code);
    assert.equal(result.data, undefined, code);
    assert.equal(bridge.seen.length, 1, code);
  }
  // A code the closed vocabulary does not define is never republished, and a raw throw never leaks its
  // message: both keep the module's fallback class.
  const forged = await insertBlocksTool(blocksBridge({ ok: false, code: 'СЕКРЕТ-ДОКУМЕНТА' }))
    .execute({ blocks: TWO_BLOCKS }, { editor: 'word' });
  assert.equal(forged.code, 'TOOL_ERROR');
  assert.equal(JSON.stringify(forged).includes('СЕКРЕТ'), false);
  const thrown = await insertBlocksTool(blocksBridge(null, { insertBlocks: async () => { throw new Error('СЕКРЕТ-ДОКУМЕНТА'); } }))
    .execute({ blocks: TWO_BLOCKS }, { editor: 'word' });
  assert.equal(thrown.code, 'TOOL_ERROR');
  assert.equal(JSON.stringify(thrown).includes('СЕКРЕТ'), false);
  const thrownClosed = await insertBlocksTool(blocksBridge(null, { insertBlocks: async () => { throw Object.assign(new Error('x'), { code: 'EDITOR_BUSY' }); } }))
    .execute({ blocks: TWO_BLOCKS }, { editor: 'word' });
  assert.equal(thrownClosed.code, 'EDITOR_BUSY');
  // An envelope this tool cannot interpret is the module's closed unknown convention — `{ok:true}` with
  // no counts, a non-object, a non-boolean flag and a flag array of the wrong LENGTH are all refused
  // rather than published as a verified append. The real bridge cannot produce any of them (its decoder
  // guarantees the four integers and one boolean per block, and turns its OWN uninterpretable answer
  // into the uncertain class with the slot held), so this leg closes the direct-descriptor path.
  for (const answer of [null, undefined, 7, 'текст', [], { ok: true }, { ok: true, paragraphsBefore: 1 },
    appended(10, 3, 2, 1, { paragraphsBefore: '10' }), appended(10, 3, 2, 1, { headingsAfter: null }),
    appended(10, 3, 2, 1, { present: [true] }), appended(10, 3, 2, 1, { present: 'true' })]) {
    const bridge = blocksBridge(answer);
    const result = await insertBlocksTool(bridge).execute({ blocks: TWO_BLOCKS }, { editor: 'word' });
    assert.equal(result.ok, false, JSON.stringify(answer));
    assert.equal(result.code, 'TOOL_ERROR', JSON.stringify(answer));
    assert.equal(bridge.seen.length, 1, JSON.stringify(answer));
  }
});

test('insert_blocks maps a returned or thrown uncertain class to TOOL_UNCERTAIN and holds the run', async () => {
  // Both legs the bridge expresses one class in: a THROWN SafeError (a decode that could not interpret a
  // dispatched append) and a RETURNED envelope (the bridge's own settlement form). They classify
  // identically, and neither is retried.
  const returned = await insertBlocksTool(blocksBridge({ ok: false, code: 'APPLY_UNCERTAIN' }))
    .execute({ blocks: TWO_BLOCKS }, { editor: 'word' });
  assert.deepEqual({ ...returned }, { ok: false, code: 'TOOL_UNCERTAIN', message: 'отказ' });
  const seen = [];
  const thrown = await insertBlocksTool({ insertBlocks: async (args) => { seen.push(args); throw Object.assign(new Error('x'), { code: 'APPLY_UNCERTAIN' }); } })
    .execute({ blocks: TWO_BLOCKS }, { editor: 'word' });
  assert.equal(thrown.code, 'TOOL_UNCERTAIN');
  assert.equal(seen.length, 1, 'no retry of an uncertain append');
  // TOOL_UNCERTAIN is the runtime-facing class this handler already produces: a bridge that returns it
  // must NOT have it laundered into an ordinary known error...
  const passthrough = await insertBlocksTool(blocksBridge({ ok: false, code: 'TOOL_UNCERTAIN' }))
    .execute({ blocks: TWO_BLOCKS }, { editor: 'word' });
  assert.equal(passthrough.code, 'TOOL_UNCERTAIN');
  // ...and the runtime really records the outcome as the uncertain one that stops the run fail-safe.
  const registry = createRegistry([insertBlocksTool(blocksBridge({ ok: false, code: 'APPLY_UNCERTAIN' }))]);
  const run = await runAgent({ registry, editor: 'word', capabilities: ['document.read', 'document.write'], mode: 'EDIT',
    settings: {}, uuid: '66666666-6666-4666-8666-666666666666', request: 'добавь главу',
    transport: async () => ({ content: '{"type":"tool_calls","calls":[{"tool":"insert_blocks","arguments":{"blocks":[{"text":"Глава"}]}}]}' }) });
  assert.deepEqual(run.actions.map(action => [action.tool, action.outcome]), [['insert_blocks', 'uncertain']]);
});

test('insert_blocks refuses a non-Word editor and a bridge that cannot serve the append, before any dispatch', async () => {
  const tool = insertBlocksTool(blocksBridge(appended(10, 3, 1, 0)));
  assert.equal(tool.precondition({ blocks: TWO_BLOCKS }, { editor: 'word' }), null);
  for (const editor of ['cell', 'slide', 'unknown', undefined, null]) {
    const refusal = tool.precondition({ blocks: TWO_BLOCKS }, { editor });
    assert.equal(refusal.code, 'CAPABILITY_UNAVAILABLE', String(editor));
    assert.equal(refusal.message, 'отказ', String(editor));
  }
  for (const bridge of [{}, { insertBlocks: 7 }, { insertBlocks: null }, null, undefined]) {
    const result = await insertBlocksTool(bridge).execute({ blocks: TWO_BLOCKS }, { editor: 'word' });
    assert.equal(result.ok, false, JSON.stringify(bridge));
    assert.equal(result.code, 'CAPABILITY_UNAVAILABLE', JSON.stringify(bridge));
    assert.equal(result.data, undefined);
  }
});

test('insert_blocks measures the exact entry it publishes, and its five bounded integers cannot reach the ceiling', async () => {
  const bridge = blocksBridge(appended(10, 3, 2, 1));
  const blocks = [{ text: 'я'.repeat(1024), heading: 1 }, { text: 'т'.repeat(1024) }];
  const result = await insertBlocksTool(bridge).execute({ blocks }, { editor: 'word' });
  assert.equal(result.ok, true);
  assert.equal(result.data.bytes, 4096, 'two 2048-byte texts');
  // The measurement is the entry the runtime PUBLISHES — `JSON.stringify({ tool, ...result })` — and it
  // must be inside the same ceiling `stringifyToolResults` enforces, so the model receives the delta
  // instead of the literal "the tool result could not be serialized".
  const entry = utf8ByteLength(JSON.stringify({ tool: 'insert_blocks', ...result }));
  assert.equal(entry, 125, 'the measured entry of a real append');
  assert.ok(entry <= AGENT_CEILINGS.toolResultBytes);
  const messages = toolResultMessages([{ tool: 'insert_blocks', result }]);
  assert.equal(messages.length, 1);
  const modelVisible = JSON.parse(messages[0].content);
  assert.equal(modelVisible.results[0].tool, 'insert_blocks');
  assert.deepEqual(modelVisible.results[0].data, { inserted: 2, headings: 1, paragraphsBefore: 10, paragraphsAfter: 12, bytes: 4096 });
  // THE ENFORCED BOUND IS THE MEASUREMENT, and this test states exactly how much room it has: every
  // field of this result is a non-negative safe integer, so even the WIDEST shape the handler can
  // publish — all five at `Number.MAX_SAFE_INTEGER` — measures 195 bytes, more than sixteen thousand
  // bytes inside the ceiling. The `BYTE_LIMIT` branch is retained because it is the module's ONE entry
  // measurement (a field added to this result later must not widen the entry unmeasured), and it is
  // unreachable for the five integers this handler publishes — which is a fact about the shape, not a
  // claim that the check does nothing.
  const widest = utf8ByteLength(JSON.stringify({ tool: 'insert_blocks', ok: true,
    data: { inserted: Number.MAX_SAFE_INTEGER, headings: Number.MAX_SAFE_INTEGER, paragraphsBefore: Number.MAX_SAFE_INTEGER,
      paragraphsAfter: Number.MAX_SAFE_INTEGER, bytes: Number.MAX_SAFE_INTEGER } }));
  assert.equal(widest, 195);
  assert.ok(AGENT_CEILINGS.toolResultBytes - widest > 16000, `${AGENT_CEILINGS.toolResultBytes - widest} bytes of slack`);
  assert.doesNotThrow(() => toolResultMessages([{ tool: 'insert_blocks', result: { ...result, data: { inserted: Number.MAX_SAFE_INTEGER,
    headings: Number.MAX_SAFE_INTEGER, paragraphsBefore: Number.MAX_SAFE_INTEGER, paragraphsAfter: Number.MAX_SAFE_INTEGER,
    bytes: Number.MAX_SAFE_INTEGER } } }]));
});

// --- the real bridge: the FIFTH authored command body, and the FIRST one that mutates ---------------
// The rig reproduces the vendor wrapper exactly as `findRig`/`structureRig` do: it reads `Asc.scope`
// SYNCHRONOUSLY, hands the body that value, and evaluates the body the way the EDITOR does — in a fresh,
// module-free scope whose only bindings are `Api` and `scope`.
function paragraphDouble() {
  const state = { text: '', heading: false };
  return { state, AddText(text) { state.text = text; }, SetStyle() { state.heading = true; } };
}
// The DOCUMENT double, modelling the MEASURED route: `doc.Push(paragraph)` returned `true` and APPENDED
// AT THE END, in call order, so its ONE mutating primitive really appends and counts one call per
// paragraph. The legacy whole-array insert primitive is offered ONLY as a trap that records any call and
// lands its content at the BEGINNING — the measured behaviour of that route (measured on the target:
// `[МАРКЕР-МАРШРУТ-1, TARGET ROUTES CHECK, …]`, and with a selection present it replaced existing text),
// which is why this tool must never use it. `appends: false` models a primitive that answered and changed
// nothing, `prepends: true` models a mutation that lands at the START, and `answer` is the primitive's own
// RETURN VALUE — which the body never consults (measured `false` for an image host, `true` for a
// paragraph), so the knobs are deliberately independent.
function blocksDocument({ paragraphs = 10, headings = 3, styles = true, appends = true, prepends = false, answer = true } = {}) {
  const texts = [];
  for (let index = 0; index < paragraphs; index += 1) texts.push(`абзац-${index + 1}`);
  const styled = [];
  for (let index = 0; index < headings; index += 1) styled.push(texts[index]);
  const calls = { pushes: 0, pushed: [], insertContents: 0, styleNames: [] };
  return { texts, styled, calls, document: {
    GetAllParagraphs() { return texts.map(text => ({ GetClassType() { return 'paragraph'; }, GetText() { return text; } })); },
    GetAllHeadingParagraphs() { return styled.map(text => ({ GetText() { return text; } })); },
    GetStyle(name) { calls.styleNames.push(name); return styles ? { GetName() { return name; } } : null; },
    Push(item) {
      calls.pushes += 1;
      calls.pushed.push(item.state.text);
      if (appends) {
        if (prepends) { texts.unshift(item.state.text); if (item.state.heading) styled.unshift(item.state.text); }
        else { texts.push(item.state.text); if (item.state.heading) styled.push(item.state.text); }
      }
      return answer;
    },
    // NEVER the route this tool takes. It is here so a test can prove the body does not call it, and it
    // lands at the BEGINNING exactly as the measured legacy primitive does.
    InsertContent(items) {
      calls.insertContents += 1;
      for (const item of items) texts.unshift(item.state.text);
      return answer;
    }
  } };
}
// A SECOND document double, for the one shape the default cannot express: a document that ALREADY holds
// the block texts, and an append whose number of created paragraphs is right while the text it writes is
// not. `write: false` pushes an empty paragraph per block, `write: 'Другое'` pushes a text that is not the
// block's, and `write: true` is the real append — one `Push` per block, at the END, in call order. The
// texts are the ONLY state this double keeps, so a test can state exactly what the document holds after
// the call.
function blocksDocumentFromTexts(texts, { write = true } = {}) {
  const state = { texts: [...texts], pushes: 0, insertContents: 0 };
  return { state, document: {
    GetAllParagraphs() { return state.texts.map(text => ({ GetText() { return text; } })); },
    GetAllHeadingParagraphs() { return []; },
    GetStyle(name) { return { GetName() { return name; } }; },
    Push(item) {
      state.pushes += 1;
      state.texts.push(write === true ? item.state.text : (write === false ? '' : write));
      return true;
    },
    InsertContent(items) {
      state.insertContents += 1;
      for (const item of items) state.texts.unshift(item.state.text);
      return true;
    }
  } };
}
function evaluateBlocksBody(body, api, scope) {
  return new Function('Api', 'scope', 'return (' + Function.prototype.toString.call(body) + ')();')(api, scope);
}
// `forge` hands the bridge a REPLACEMENT for the answer the body really produced, after that body has
// run to completion against the document double — a real append included. It is the only way to model a
// hostile or damaged native answer for a dispatched append without weakening the body itself.
function blocksRig({ paragraphs = 10, headings = 3, styles = true, appends = true, prepends = false, answer = true,
  command = true, namespace = { scope: 'сентинел' }, omitCarrier = false, document = undefined, forge = undefined } = {}) {
  const commands = [];
  const measured = blocksDocument({ paragraphs, headings, styles, appends, prepends, answer });
  const api = { GetDocument() { return document === undefined ? measured.document : document; },
    CreateParagraph() { return paragraphDouble(); } };
  const plugin = { info: { editorType: 'word' },
    callCommand: command ? function (body, close, recalculate, callback) {
      const source = Function.prototype.toString.call(body);
      const scope = namespace?.scope;
      const answered = evaluateBlocksBody(body, api, scope);
      commands.push({ by: 'callCommand', body, source, close, recalculate, scope, answered });
      callback(forge === undefined ? answered : forge);
      return false;
    } : undefined };
  const options = { editorType: 'word', clock: { now: () => 0 }, timers: { schedule() { return {}; }, clear() {} } };
  if (!omitCarrier) options.ascNamespace = namespace;
  const bridge = bridgeWith(plugin, options);
  return { bridge, plugin, commands, namespace, api, doc: measured };
}

test('bridge insertBlocks dispatches ONE command, carries the blocks as DATA and verifies the measured delta', async () => {
  const namespace = { scope: 'предыдущая-область' };
  const r = blocksRig({ namespace });
  const blocks = [{ text: 'Глава первая', heading: 1 }, { text: 'Первый абзац.' }];
  const pending = r.bridge.insertBlocks({ blocks });
  assert.equal(r.commands.length, 1, 'exactly ONE command is dispatched for the whole append');
  const carried = r.commands[0];
  assert.equal(carried.by, 'callCommand', 'the wrapper is the entry point the measured build exposes');
  assert.equal(typeof carried.body, 'function', 'the body is handed as an authored function literal, never as text');
  assert.equal(carried.close, false, 'the documented close/recalculate arguments are unchanged');
  assert.equal(carried.recalculate, false);
  assert.deepEqual(carried.scope, { blocks }, 'the blocks cross as the command SCOPE, never interpolated into source');
  assert.equal(namespace.scope, 'предыдущая-область', 'the namespace is restored: no blocks outlive their dispatch');
  assert.equal(r.doc.calls.pushes, 2, 'ONE Push per block: the whole batch is appended one paragraph at a time');
  assert.deepEqual(r.doc.calls.pushed, ['Глава первая', 'Первый абзац.'], 'in block order, each at the END');
  assert.equal(r.doc.calls.insertContents, 0, 'the legacy whole-array primitive — which lands at the START — is never called');
  assert.deepEqual(r.doc.calls.styleNames, ['Heading 1'], 'the level is mapped to the measured style name');
  assert.deepEqual(carried.answered, ['POST_INSERT', 10, 12, 3, 4, 1, 1],
    'the body encodes the explicit phase slot, the four counts and one flag per block');
  assert.deepEqual(await pending, { ok: true, paragraphsBefore: 10, paragraphsAfter: 12, headingsBefore: 3, headingsAfter: 4,
    present: [true, true] });
  assert.equal(r.bridge.getState().busy, false, 'the slot is released by the native callback');
  assert.equal(r.bridge.getState().writePending, false);
  assert.equal(r.bridge.getState().uncertain, false);
});

test('the blocks body is self-contained: it answers the measured shapes in a fresh, module-free scope', async () => {
  const r = blocksRig({ paragraphs: 2, headings: 0 });
  const pending = r.bridge.insertBlocks({ blocks: [{ text: 'Один' }, { text: 'Два', heading: 2 }] });
  const carried = r.commands[0];
  assert.equal(/\b(?:capabilityBody|contextBody|commandTransport|createCommandDispatch|decodeBlocks|decodeSearch|decodeStructure|decodeTable|exactBlocksDelta|exactTableDelta|preInsertRefusal|pluginOwners|createR7Bridge)\b/.test(carried.source),
    false, 'the stringified body names no module binding of bridge.js');
  assert.match(carried.source, /typeof Api !== 'undefined'/, 'and it builds the public Api facade itself');
  // The EDITOR'S own evaluation, on a FRESH document so the assertion is about the body's answer and not
  // about how many times the rig ran it. Only `Api` and `scope` are bound here, so a body that closed
  // over a module binding would raise ReferenceError exactly as it did natively on 2026.3.1.
  const fresh = blocksDocument({ paragraphs: 2, headings: 0 });
  const freshApi = { GetDocument() { return fresh.document; }, CreateParagraph() { return paragraphDouble(); } };
  const evaluated = evaluateBlocksBody(carried.body, freshApi, carried.scope);
  assert.deepEqual(evaluated, ['POST_INSERT', 2, 4, 0, 1, 1, 1],
    'the blocks arrived as DATA and the counts are the document\'s own');
  assert.equal(fresh.calls.pushes, 2, 'and the two Push calls are where the mutation happens — one per block');
  assert.equal(fresh.calls.insertContents, 0, 'never through the legacy whole-array primitive');
  assert.deepEqual(fresh.texts, ['абзац-1', 'абзац-2', 'Один', 'Два']);
  assert.deepEqual(fresh.styled, ['Два'], 'only the block that asked for a heading became one');
  assert.deepEqual(carried.scope, { blocks: [{ text: 'Один' }, { text: 'Два', heading: 2 }] });
  assert.deepEqual((await pending).present, [true, true]);
});

test('the Push boolean is never the signal: a false that appended verifies, a true that appended nothing does not', async () => {
  // BOTH halves of a mutation primitive's uselessness, on the MEASURED route. `Push` answered `true` for
  // the paragraph this body hands it and `false` for an image host, and the legacy whole-array primitive
  // answered `true` even for `[]`, `[null]` and `'nonsense'`. A `true` therefore proves nothing, and a
  // `false` does not prove failure either.
  // The document's own delta is the only evidence, and it is what these two rigs vary.
  const lied = blocksRig({ paragraphs: 3, headings: 1, answer: false });
  assert.deepEqual(await lied.bridge.insertBlocks({ blocks: [{ text: 'Новое' }] }),
    { ok: true, paragraphsBefore: 3, paragraphsAfter: 4, headingsBefore: 1, headingsAfter: 1, present: [true] },
    'the document really grew by one paragraph, so the append IS verified although the primitive answered false');
  assert.equal(lied.bridge.getState().busy, false);
  const noop = blocksRig({ paragraphs: 3, headings: 1, appends: false });
  assert.deepEqual(await noop.bridge.insertBlocks({ blocks: [{ text: 'Новое' }] }),
    { ok: false, code: 'APPLY_UNCERTAIN' },
    'the primitive answered true and the document did not move: never a verified append');
  assert.equal(noop.doc.calls.pushes, 1, 'the mutation was dispatched exactly once and is never retried');
  const state = noop.bridge.getState();
  assert.equal(state.busy, true, 'the slot is HELD for an uncertain append');
  assert.equal(state.uncertain, true);
  assert.equal(state.writePending, true, 'and the write lock stays engaged, so no second mutation can start');
  assert.deepEqual(await noop.bridge.insertBlocks({ blocks: [{ text: 'Ещё' }] }), { ok: false, code: 'EDITOR_BUSY' },
    'no retry: the held slot refuses the next append');
  assert.equal(noop.commands.length, 1, 'and the refused call dispatches nothing at all');
  // THE PHASE BOUNDARY IS THE FIRST CALL, NOT ITS RETURN. A native that THROWS out of `Push` may already
  // have applied that block, so the body's phase turns uncertain IMMEDIATELY BEFORE the first push: a
  // throwing mutation is never reported as a known refusal with the slot released.
  const base = blocksDocument();
  const calls = { pushes: 0 };
  const document = { ...base.document, Push() { calls.pushes += 1; throw new Error('СЕКРЕТ-ДОКУМЕНТА'); } };
  const threw = blocksRig({ document });
  assert.deepEqual(await threw.bridge.insertBlocks({ blocks: [{ text: 'Новое' }] }), { ok: false, code: 'APPLY_UNCERTAIN' },
    'a primitive that threw out of the mutation is the uncertain class');
  assert.equal(calls.pushes, 1);
  assert.equal(threw.bridge.getState().busy, true, 'the slot is HELD: a throwing mutation may still have applied part of the array');
  assert.equal(threw.bridge.getState().writePending, true);
  assert.equal(JSON.stringify(await threw.bridge.insertBlocks({ blocks: [{ text: 'Ещё' }] })).includes('СЕКРЕТ'), false);
  assert.equal(calls.pushes, 1, 'and the uncertain append is never retried');
});

test('the outcome contract is ONE-TO-ONE over the APPENDED REGION, never an existential match over the document', async () => {
  // THE REVIEWER'S REPRODUCTION, on the measured route. The document ALREADY holds both block texts, and
  // the append creates the right NUMBER of paragraphs while writing no text at all. An existential
  // substring search over the whole document is satisfied by the pre-existing occurrences, so the old
  // check verified an append that carried nothing: `{ok:true, paragraphsBefore:2, paragraphsAfter:4,
  // present:[true,true]}` while the document ended `['Глава','Текст','','']`. The verifier must be
  // anchored to the REGION the append added — the paragraphs at indices `paragraphsBefore …` — so a text
  // that was already in the document cannot stand in for the block's own paragraph.
  const silent = blocksDocumentFromTexts(['Глава', 'Текст'], { write: false });
  const quiet = blocksRig({ document: silent.document });
  const result = await quiet.bridge.insertBlocks({ blocks: [{ text: 'Глава' }, { text: 'Текст' }] });
  assert.equal(silent.state.pushes, 2, 'the mutation was dispatched exactly once PER BLOCK');
  assert.deepEqual(silent.state.texts, ['Глава', 'Текст', '', ''],
    'the double created two paragraphs and carried no text — the count delta is exact and the text is not');
  assert.equal(result.ok, false, 'an append that carried no text is NEVER verified, whatever the document already held');
  assert.equal(result.code, 'APPLY_UNCERTAIN');
  assert.equal(result.data, undefined);
  const held = quiet.bridge.getState();
  assert.equal(held.busy, true, 'the slot is HELD for an append whose text did not arrive');
  assert.equal(held.uncertain, true);
  assert.equal(held.writePending, true);
  assert.deepEqual(await quiet.bridge.insertBlocks({ blocks: [{ text: 'Ещё' }] }), { ok: false, code: 'EDITOR_BUSY' },
    'no retry of an append whose outcome is unknown');
  assert.equal(silent.state.pushes, 2, 'and the refused call dispatches nothing');
  // The same region anchor closes the OTHER wrong-text shape: the paragraphs are created and filled with
  // something that is not the block's own text. The old existential rule could also be fed by a document
  // that merely CONTAINS the block's text somewhere else.
  const wrongText = blocksDocumentFromTexts(['Глава', 'Текст'], { write: 'Другое' });
  assert.deepEqual(await blocksRig({ document: wrongText.document }).bridge.insertBlocks({ blocks: [{ text: 'Глава' }] }),
    { ok: false, code: 'APPLY_UNCERTAIN' }, 'a paragraph that carries a different text is not this block\'s append');
  // THE TWO CASES THE ANCHOR MUST NOT BREAK. A block whose text ALREADY occurs elsewhere in the document
  // still verifies, because the append carried it in the slot the block owns.
  const elsewhere = blocksDocumentFromTexts(['Глава', 'Текст'], { write: true });
  const again = blocksRig({ document: elsewhere.document });
  assert.deepEqual(await again.bridge.insertBlocks({ blocks: [{ text: 'Глава' }] }),
    { ok: true, paragraphsBefore: 2, paragraphsAfter: 3, headingsBefore: 0, headingsAfter: 0, present: [true] },
    'the append really carried it, even though the document already held the same text');
  assert.deepEqual(elsewhere.state.texts, ['Глава', 'Текст', 'Глава']);
  // And DUPLICATE block texts verify: two blocks with the SAME text are two paragraphs, each in its own
  // slot. This is the case that rules out "each needle\'s occurrence count rose by exactly one" as the
  // implemented rule — that count rises by TWO for one duplicate needle, so a per-needle rule would have
  // to bookkeep multiplicity, while the per-slot rule can only be satisfied by two real paragraphs.
  const duplicates = blocksDocumentFromTexts(['старт'], { write: true });
  const twice = blocksRig({ document: duplicates.document });
  assert.deepEqual(await twice.bridge.insertBlocks({ blocks: [{ text: 'Дубль' }, { text: 'Дубль' }] }),
    { ok: true, paragraphsBefore: 1, paragraphsAfter: 3, headingsBefore: 0, headingsAfter: 0, present: [true, true] },
    'two blocks with the same text are two appended paragraphs, and both verify');
  assert.deepEqual(duplicates.state.texts, ['старт', 'Дубль', 'Дубль']);
  assert.equal(duplicates.state.pushes, 2);
});

// --- §13.2 the MEASURED append route: `Push` per block, in order, AT THE END -----------------------
// The Lead's native run corrected the route this body authors. Measured on the target (Astra / R7
// 2026.1.2.1942) on a document [TARGET ROUTES CHECK, ПЕРВЫЙ-АБЗАЦ-РОУТ, ВТОРОЙ-АБЗАЦ-РОУТ,
// ТРЕТИЙ-АБЗАЦ-РОУТ]: `doc.Push(paragraph)` returned `true` and APPENDED AT THE END
// (…, ТРЕТИЙ-АБЗАЦ-РОУТ, МАРКЕР-МАРШРУТ-2); the legacy whole-array insert primitive put its paragraph at
// the BEGINNING (МАРКЕР-МАРШРУТ-1, TARGET ROUTES CHECK, …) and, with a selection present, REPLACED
// existing text (a paragraph lost its first characters: `МАРКЕР-МАРШРУТ-1` came out as `-МАРШРУТ-1`), so
// select-then-insert is unsafe and is not used. The region anchor of §13.1 is what makes the tool's
// promise true on BOTH routes: content that lands at the START still grows the paragraph count, so only
// the per-slot region check can tell a real append from a start-landing mutation.

test('the body pushes ONE paragraph per block, in order, and never calls the legacy insert primitive', async () => {
  const r = blocksRig({ paragraphs: 4, headings: 0 });
  const blocks = [{ text: 'МАРКЕР-МАРШРУТ-1' }, { text: 'ВТОРОЙ-МАРКЕР' }, { text: 'ТРЕТИЙ-МАРКЕР', heading: 1 }];
  const result = await r.bridge.insertBlocks({ blocks });
  const carried = r.commands[0];
  // THE SOURCE THE EDITOR EVALUATES, WITH COMMENTS STRIPPED FIRST: these bodies are heavily commented, so a
  // match against the RAW carried source could be satisfied by a comment that merely NAMES the route — a
  // body that dropped the `Push` loop but kept the sentence describing it would have been classified as the
  // measured append leg all the same. `withoutComments` leaves the CODE only.
  const authored = withoutComments(carried.source);
  assert.match(authored, /\.Push\s*\(/, 'the carried body authors the measured append primitive');
  assert.equal(/\.InsertContent\s*\(/.test(authored), false, 'and never the route that lands at the START');
  // THE BEHAVIOUR: one Push PER BLOCK, in block order, each landing after the last existing paragraph.
  assert.equal(r.doc.calls.pushes, 3, 'ONE Push per block — three blocks are three calls');
  assert.deepEqual(r.doc.calls.pushed, ['МАРКЕР-МАРШРУТ-1', 'ВТОРОЙ-МАРКЕР', 'ТРЕТИЙ-МАРКЕР'], 'in block order');
  assert.equal(r.doc.calls.insertContents, 0, 'the legacy primitive is never called');
  assert.deepEqual(r.doc.texts, ['абзац-1', 'абзац-2', 'абзац-3', 'абзац-4', 'МАРКЕР-МАРШРУТ-1', 'ВТОРОЙ-МАРКЕР', 'ТРЕТИЙ-МАРКЕР'],
    'the content is at the END, in the order it was asked for');
  assert.deepEqual(carried.answered, ['POST_INSERT', 4, 7, 0, 1, 1, 1, 1],
    'the phase slot, the four counts and one flag per block — every flag over the region the append added');
  assert.deepEqual(result, { ok: true, paragraphsBefore: 4, paragraphsAfter: 7, headingsBefore: 0, headingsAfter: 1,
    present: [true, true, true] });
});

test('a mutation that lands at the START is TOOL_UNCERTAIN with the slot HELD: the region anchor catches it', async () => {
  // THE OLD ASSUMED ROUTE, modelled: the mutation answers and the content lands at the BEGINNING — the
  // measured behaviour of the legacy primitive this tool used to call. The paragraph count really grows,
  // so the count delta ALONE would call this a verified append; only the per-slot region check can see
  // that the block does not own the paragraph the append was supposed to give it.
  const r = blocksRig({ paragraphs: 4, headings: 0, prepends: true });
  const result = await r.bridge.insertBlocks({ blocks: [{ text: 'МАРКЕР-МАРШРУТ-1' }] });
  assert.equal(r.doc.calls.pushes, 1, 'the mutation was dispatched exactly once');
  assert.deepEqual(r.doc.texts, ['МАРКЕР-МАРШРУТ-1', 'абзац-1', 'абзац-2', 'абзац-3', 'абзац-4'],
    'it landed at the START, not the END');
  assert.deepEqual(r.commands[0].answered, ['POST_INSERT', 4, 5, 0, 0, 0],
    'the counts grew by exactly one and the block does NOT own the paragraph at index 4 — the flag is 0');
  assert.deepEqual(result, { ok: false, code: 'APPLY_UNCERTAIN' }, 'a start-landing mutation is NEVER a verified append');
  const held = r.bridge.getState();
  assert.equal(held.busy, true, 'the slot is HELD: the write really happened, just not where it was promised');
  assert.equal(held.uncertain, true);
  assert.equal(held.writePending, true);
  assert.deepEqual(await r.bridge.insertBlocks({ blocks: [{ text: 'Ещё' }] }), { ok: false, code: 'EDITOR_BUSY' },
    'and there is NO retry');
  assert.equal(r.commands.length, 1, 'the refused call dispatches nothing at all');
});

test('a Push that throws PART WAY THROUGH is TOOL_UNCERTAIN with the slot HELD, never a known refusal', async () => {
  // A block array is pushed ONE CALL AT A TIME, so a failure between two calls can leave the document
  // holding SOME of the batch. The phase turns POST_INSERT before the FIRST call, so that partial write
  // is never reported as a known refusal for a mutation that may already have happened — for a throw on
  // the first block as well as on a later one.
  for (const throwOn of [1, 2]) {
    const base = blocksDocument({ paragraphs: 3, headings: 0 });
    let pushes = 0;
    const document = { ...base.document,
      Push(item) { pushes += 1; if (pushes === throwOn) throw new Error('СЕКРЕТ-ДОКУМЕНТА'); return base.document.Push(item); } };
    const r = blocksRig({ document });
    const result = await r.bridge.insertBlocks({ blocks: [{ text: 'Первый' }, { text: 'Второй' }] });
    assert.equal(pushes, throwOn, `throwOn ${throwOn}: the batch stopped at the throwing Push`);
    if (throwOn === 2) {
      assert.deepEqual(base.texts, ['абзац-1', 'абзац-2', 'абзац-3', 'Первый'],
        'the FIRST block really landed and the second did not — a partial write the readback cannot verify');
    }
    assert.deepEqual(result, { ok: false, code: 'APPLY_UNCERTAIN' }, `throwOn ${throwOn}`);
    assert.equal(JSON.stringify(result).includes('СЕКРЕТ'), false, 'no native text leaks through the refusal');
    const held = r.bridge.getState();
    assert.equal(held.busy, true, `throwOn ${throwOn}: the slot is HELD`);
    assert.equal(held.uncertain, true);
    assert.equal(held.writePending, true);
    assert.deepEqual(await r.bridge.insertBlocks({ blocks: [{ text: 'Ещё' }] }), { ok: false, code: 'EDITOR_BUSY' },
      `throwOn ${throwOn}: an uncertain append is never retried`);
    assert.equal(r.commands.length, 1, `throwOn ${throwOn}: and the refused call dispatches nothing`);
  }
});

test('a document that offers ONLY the legacy primitive is refused up-front with NOTHING inserted', async () => {
  // The route this tool must not use is not a fallback. A build that does not expose the measured append
  // primitive gets the body's own closed refusal, answered BEFORE any write, with the slot released —
  // never a content-in-front mutation published as an append.
  const legacy = { texts: ['старт'], insertContents: 0 };
  const document = {
    GetAllParagraphs() { return legacy.texts.map(text => ({ GetText() { return text; } })); },
    GetAllHeadingParagraphs() { return []; },
    GetStyle(name) { return { GetName() { return name; } }; },
    InsertContent(items) { legacy.insertContents += 1; for (const item of items) legacy.texts.unshift(item.state.text); return true; }
  };
  const r = blocksRig({ document });
  assert.deepEqual(await r.bridge.insertBlocks({ blocks: [{ text: 'Новое' }] }), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
  assert.equal(legacy.insertContents, 0, 'the legacy primitive is never called');
  assert.deepEqual(legacy.texts, ['старт'], 'and nothing reached the document');
  assert.equal(r.bridge.getState().busy, false, 'the slot is RELEASED: nothing was inserted');
});

test('bridge insertBlocks refuses an unusable baseline or an unresolvable style with a closed class and NO Push', async () => {
  // THE PRE-DISPATCH GATE. Every shape below is a document whose BASELINE cannot be established, so the
  // delta the outcome rests on can never be computed: the body answers before it inserts.
  const gated = (override) => {
    const base = blocksDocument();
    const calls = { pushes: 0 };
    const document = { ...base.document, Push() { calls.pushes += 1; return true; }, ...override };
    return { r: blocksRig({ document }), calls };
  };
  for (const [label, override] of [
    ['no GetAllParagraphs at all', { GetAllParagraphs: null }],
    ['GetAllParagraphs is not a function', { GetAllParagraphs: 7 }],
    ['GetAllParagraphs answers no array', { GetAllParagraphs: () => 7 }],
    ['GetAllParagraphs answers a fractional length', { GetAllParagraphs: () => ({ length: 1.5 }) }],
    ['GetAllHeadingParagraphs answers null', { GetAllHeadingParagraphs: () => null }],
    ['no Push at all', { Push: null }],
    ['no GetStyle at all', { GetStyle: null }],
    ['no Api.CreateParagraph', {}]
  ]) {
    const { r, calls } = gated(override);
    if (label === 'no Api.CreateParagraph') r.api.CreateParagraph = null;
    const result = await r.bridge.insertBlocks({ blocks: [{ text: 'а' }] });
    assert.equal(result.ok, false, label);
    assert.equal(result.code, 'CAPABILITY_UNAVAILABLE', label);
    assert.equal(calls.pushes, 0, `${label}: the measured append primitive is never reached`);
    assert.equal(r.bridge.getState().busy, false, label);
  }
  // THE STYLE GATE, and it is a TOOL_ERROR rather than the uncertain class because the body resolves the
  // style BEFORE its first `Push`: nothing was inserted, so an uncertain outcome would be false
  // information about a mutation that provably did not happen.
  const style = blocksRig({ styles: false });
  assert.deepEqual(await style.bridge.insertBlocks({ blocks: [{ text: 'Глава', heading: 1 }] }),
    { ok: false, code: 'TOOL_ERROR' });
  assert.deepEqual(style.doc.calls.styleNames, ['Heading 1'], 'the level WAS mapped to the measured name before the refusal');
  assert.equal(style.doc.calls.pushes, 0, 'never a plain paragraph where a heading was asked for');
  assert.equal(style.bridge.getState().busy, false);
  // The same document serves a heading-less append: the style bound is about the ARGUMENT it cannot
  // serve, never about the document's ability to append.
  const plain = await style.bridge.insertBlocks({ blocks: [{ text: 'Просто текст' }] });
  assert.equal(plain.ok, true);
  assert.equal(style.doc.calls.pushes, 1);
});

test('bridge insertBlocks refuses a build, a namespace or a request it cannot use, with the closed class', async () => {
  const noCommand = blocksRig({ command: false });
  assert.deepEqual(await noCommand.bridge.insertBlocks({ blocks: [{ text: 'а' }] }), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
  assert.deepEqual(noCommand.commands, [], 'no command is dispatched by a facade that has none');
  for (const shape of [{ omitCarrier: true }, { namespace: null }, { namespace: Object.freeze({}) },
    { namespace: Object.freeze({ scope: 'предыдущая-область' }) }]) {
    const r = blocksRig(shape);
    assert.deepEqual(await r.bridge.insertBlocks({ blocks: [{ text: 'а' }] }), { ok: false, code: 'CAPABILITY_UNAVAILABLE' },
      JSON.stringify(shape));
    assert.deepEqual(r.commands, [], 'nothing is dispatched when the scope cannot cross');
    assert.equal(r.bridge.getState().busy, false, 'and the slot is released');
  }
  // A request this bridge cannot interpret is refused with the closed argument class and NO SDK work: the
  // shape rules and the two byte bounds are closed preconditions, not optional refinements.
  const malformed = [undefined, null, {}, { blocks: [] }, { blocks: 'а' }, { blocks: [null] }, { blocks: [{}] },
    { blocks: [{ text: '' }] }, { blocks: [{ text: 7 }] }, { blocks: [{ text: 'а', heading: 0 }] },
    { blocks: [{ text: 'а', heading: 1.5 }] }, { blocks: [{ text: 'а', heading: LIMITS.insertHeadingMax + 1 }] },
    { blocks: [{ text: 'а', heading: '1' }] }, { blocks: [{ text: 'а', heading: null }] },
    { blocks: new Array(LIMITS.insertBlocksMax + 1).fill({ text: 'а' }) }];
  for (const raw of malformed) {
    const r = blocksRig();
    const result = await r.bridge.insertBlocks(raw);
    assert.equal(result.ok, false, JSON.stringify(raw));
    assert.equal(result.code, 'TOOL_ERROR', JSON.stringify(raw));
    assert.deepEqual(r.commands, [], JSON.stringify(raw));
    assert.equal(r.bridge.getState().busy, false, JSON.stringify(raw));
  }
  for (const raw of [{ blocks: [{ text: 'я'.repeat(LIMITS.insertBlockBytes) }] },
    { blocks: new Array(5).fill({ text: 'я'.repeat(1024) }) }]) {
    const r = blocksRig();
    const result = await r.bridge.insertBlocks(raw);
    assert.equal(result.code, 'BYTE_LIMIT', JSON.stringify(raw));
    assert.deepEqual(r.commands, []);
    assert.equal(r.bridge.getState().busy, false);
  }
  // Exactly at both byte bounds is served, so the bound is a boundary and not an off-by-one.
  const largest = blocksRig();
  const atBound = await largest.bridge.insertBlocks({ blocks: [{ text: 'я'.repeat(LIMITS.insertBlockBytes / 2) }] });
  assert.equal(atBound.ok, true, 'one block of exactly insertBlockBytes is served');
  const controller = new AbortController();
  controller.abort();
  const aborted = blocksRig();
  assert.deepEqual(await aborted.bridge.insertBlocks({ blocks: [{ text: 'а' }], signal: controller.signal }),
    { ok: false, code: 'CANCELLED' });
  assert.deepEqual(aborted.commands, [], 'a pre-aborted signal never reaches the editor');
  assert.equal(aborted.bridge.getState().busy, false);
});

test('bridge insertBlocks decodes ONLY the authored shapes and never publishes a malformed native answer', async () => {
  const poisoned = (raw) => {
    const plugin = { info: { editorType: 'word' }, callCommand: (_body, _close, _recalculate, callback) => { callback(raw); return false; } };
    return bridgeWith(plugin, { editorType: 'word', ascNamespace: { scope: undefined }, clock: { now: () => 0 },
      timers: { schedule() { return {}; }, clear() {} } });
  };
  // The two PRE-insert sentinels are KNOWN refusals with the slot released (nothing was inserted); the
  // POST-insert sentinel and every other uninterpretable answer are the UNCERTAIN class with the slot
  // HELD, because the command body ran and the document may already hold the append.
  // THE PHASE IS AN EXPLICIT SLOT, and these rows pin the protocol in both directions:
  //   * a TWO-slot answer whose first slot is the PRE-insert phase is a KNOWN refusal — the two names the
  //     body emits only from its pre-insert half keep their closed class, and the slot is released;
  //   * a ONE-slot name (the forgery, phase ABSENT), a POST-insert phase, a phase-marked name that does
  //     not belong to that phase, and every other uninterpretable answer are the UNCERTAIN class with the
  //     slot HELD, because the command body ran and the document may already hold the append.
  // The two rows that used to assert the unconditional mapping of `['CAPABILITY_UNAVAILABLE']` and
  // `['STYLE_UNAVAILABLE']` are replaced by this pairing: the same name→class mapping is still asserted
  // (with the pre-insert phase), and the phase-less form is now asserted to be REFUSED as unprovable. The
  // replacement is strictly stronger: it covers the old mapping AND the forgery it could not see.
  const table = [
    [['PRE_INSERT', 'CAPABILITY_UNAVAILABLE'], 'CAPABILITY_UNAVAILABLE', false],
    [['PRE_INSERT', 'STYLE_UNAVAILABLE'], 'TOOL_ERROR', false],
    [['POST_INSERT', 'APPLY_UNCERTAIN'], 'APPLY_UNCERTAIN', true],
    [['POST_INSERT', 'CAPABILITY_UNAVAILABLE'], 'APPLY_UNCERTAIN', true],
    [['POST_INSERT', 'STYLE_UNAVAILABLE'], 'APPLY_UNCERTAIN', true],
    [['PRE_INSERT', 'APPLY_UNCERTAIN'], 'APPLY_UNCERTAIN', true],
    [['CAPABILITY_UNAVAILABLE'], 'APPLY_UNCERTAIN', true],
    [['STYLE_UNAVAILABLE'], 'APPLY_UNCERTAIN', true],
    [['APPLY_UNCERTAIN'], 'APPLY_UNCERTAIN', true],
    [['НЕИЗВЕСТНЫЙ-СЕНТИНЕЛ'], 'APPLY_UNCERTAIN', true],
    [null, 'APPLY_UNCERTAIN', true], [undefined, 'APPLY_UNCERTAIN', true], [7, 'APPLY_UNCERTAIN', true],
    ['текст', 'APPLY_UNCERTAIN', true], [{}, 'APPLY_UNCERTAIN', true], [[true], 'APPLY_UNCERTAIN', true],
    [[], 'APPLY_UNCERTAIN', true], [[1], 'APPLY_UNCERTAIN', true],
    [[10, 11, 3, 4, 1], 'APPLY_UNCERTAIN', true],
    [['POST_INSERT', 10, 11, 3, 4], 'APPLY_UNCERTAIN', true],
    [['POST_INSERT', 10, 11, 3, 4, 1, 0], 'APPLY_UNCERTAIN', true],
    [['PRE_INSERT', 10, 11, 3, 4, 1], 'APPLY_UNCERTAIN', true],
    [['POST_INSERT', 10.5, 11, 3, 4, 1], 'APPLY_UNCERTAIN', true],
    [['POST_INSERT', -1, 11, 3, 4, 1], 'APPLY_UNCERTAIN', true],
    [['POST_INSERT', 10, 11, 3, 4, 2], 'APPLY_UNCERTAIN', true],
    // The 40 000-character member is a FLAG of the wrong TYPE, and that is the rule it exercises: the
    // flag check runs before any byte measurement, and the byte bound this leg used to carry was
    // UNREACHABLE (four safe integers plus at most 64 one-character flags measure 211 bytes at their
    // widest, against a 65 536-byte ceiling), so it was deleted rather than left as an untested claim.
    [['POST_INSERT', 10, 11, 3, 4, 'я'.repeat(40000)], 'APPLY_UNCERTAIN', true],
    [['POST_INSERT', '10', 11, 3, 4, 1], 'APPLY_UNCERTAIN', true],
    [['POST_INSERT', 10, 10, 3, 3, 0], 'APPLY_UNCERTAIN', true]
  ];
  for (const [raw, code, held] of table) {
    const result = await poisoned(raw).insertBlocks({ blocks: [{ text: 'а' }] });
    assert.equal(result.ok, false, JSON.stringify(raw));
    assert.equal(result.code, code, JSON.stringify(raw));
    assert.equal(JSON.stringify(result).includes('НЕИЗВЕСТНЫЙ'), false, 'no native text leaks through a refusal');
  }
  for (const [raw, code, held] of table) {
    const bridge = poisoned(raw);
    await bridge.insertBlocks({ blocks: [{ text: 'а' }] });
    const state = bridge.getState();
    assert.equal(state.busy, held, `busy for ${JSON.stringify(raw)}`);
    assert.equal(state.writePending, held, `writePending for ${JSON.stringify(raw)}`);
  }
  // The authored MEASUREMENT is the one shape that publishes, and it publishes exactly the decoded delta.
  // The probe's single block asks for NO heading, so the document's heading count must not move either.
  assert.deepEqual(await poisoned(['POST_INSERT', 10, 11, 3, 3, 1]).insertBlocks({ blocks: [{ text: 'а' }] }),
    { ok: true, paragraphsBefore: 10, paragraphsAfter: 11, headingsBefore: 3, headingsAfter: 3, present: [true] });
  const headingProbe = await poisoned(['POST_INSERT', 10, 11, 3, 4, 1]).insertBlocks({ blocks: [{ text: 'Глава', heading: 1 }] });
  assert.deepEqual(headingProbe, { ok: true, paragraphsBefore: 10, paragraphsAfter: 11, headingsBefore: 3, headingsAfter: 4, present: [true] },
    'the same answer is UNCERTAIN for a heading-less block set and verified for this one: the expected delta is derived from the blocks, never from the answer');
});

test('the refusal PHASE is explicit in the protocol: a forged one-slot sentinel answered after a real append is uncertain, never a known class', async () => {
  // THE REVIEWER'S FORGERY. `blocksRefusal` flips the phase immediately before the first `Push`, but the
  // decoder used to map the PRE-insert sentinel NAMES unconditionally — so a forged post-insert answer
  // `['CAPABILITY_UNAVAILABLE']` (or `['STYLE_UNAVAILABLE']`) produced a false KNOWN refusal with the slot
  // RELEASED and `writePending` false, even though the body had really appended. The phase now travels IN
  // THE ANSWER, and a pre-insert refusal is a known class ONLY when the answer carries the pre-insert
  // phase. Every rig below evaluates the REAL body — one real append — and then hands the bridge the
  // forged answer in its place, which is exactly the shape the reviewer reproduced.
  for (const forged of [['CAPABILITY_UNAVAILABLE'], ['STYLE_UNAVAILABLE'], ['APPLY_UNCERTAIN'], ['НЕИЗВЕСТНЫЙ-СЕНТИНЕЛ']]) {
    const r = blocksRig({ paragraphs: 10, headings: 3, forge: forged });
    const result = await r.bridge.insertBlocks({ blocks: [{ text: 'Глава' }] });
    assert.equal(r.doc.calls.pushes, 1, `${JSON.stringify(forged)}: the body really appended before the answer`);
    assert.equal(result.ok, false, JSON.stringify(forged));
    assert.equal(result.code, 'APPLY_UNCERTAIN',
      `${JSON.stringify(forged)}: a phase that cannot be confirmed as PRE-insert is POST-insert`);
    const state = r.bridge.getState();
    assert.equal(state.busy, true, JSON.stringify(forged));
    assert.equal(state.uncertain, true, JSON.stringify(forged));
    assert.equal(state.writePending, true, `${JSON.stringify(forged)}: the write lock stays engaged`);
    assert.deepEqual(await r.bridge.insertBlocks({ blocks: [{ text: 'Ещё' }] }), { ok: false, code: 'EDITOR_BUSY' },
      `${JSON.stringify(forged)}: no retry of the append`);
    assert.equal(r.commands.length, 1, `${JSON.stringify(forged)}: and the refused call dispatched nothing`);
  }
  // THE GENUINE PRE-INSERT REFUSALS ARE UNCHANGED: the body answers them BEFORE the one mutation, with the
  // pre-insert phase, so each keeps its KNOWN class with the slot RELEASED and ZERO `Push`.
  const baseline = blocksRig({ document: { ...blocksDocument().document, GetAllParagraphs: null } });
  assert.deepEqual(await baseline.bridge.insertBlocks({ blocks: [{ text: 'а' }] }), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
  assert.equal(baseline.doc.calls.pushes, 0, 'an unusable baseline never reaches the mutation');
  assert.equal(baseline.bridge.getState().busy, false, 'and the slot is RELEASED: nothing was inserted');
  const style = blocksRig({ styles: false });
  assert.deepEqual(await style.bridge.insertBlocks({ blocks: [{ text: 'Глава', heading: 1 }] }), { ok: false, code: 'TOOL_ERROR' });
  assert.equal(style.doc.calls.pushes, 0, 'an unresolvable style never reaches the mutation');
  assert.equal(style.bridge.getState().busy, false);
  // A PHASE-MARKED answer that names a pre-insert class from the POST-insert half is still not a known
  // refusal: only the PRE-insert phase makes those names known.
  const postNamed = blocksRig({ paragraphs: 2, headings: 0, forge: ['POST_INSERT', 'CAPABILITY_UNAVAILABLE'] });
  assert.equal((await postNamed.bridge.insertBlocks({ blocks: [{ text: 'а' }] })).code, 'APPLY_UNCERTAIN');
  assert.equal(postNamed.bridge.getState().busy, true);
});

test('insert_blocks is offered with policy auto and a model call appends exactly one block batch', async () => {
  const r = blocksRig();
  const registry = createRegistry(createWordTools(r.bridge));
  const catalogue = registry.catalogue({ editor: 'word', capabilities: ['document.read', 'document.write'], mode: 'EDIT' });
  const offered = catalogue.find(entry => entry.name === 'insert_blocks');
  assert.ok(offered, 'the offered catalogue contains insert_blocks');
  assert.equal(offered.policy, 'auto');
  assert.equal(offered.kind, 'mutate');
  assert.equal(offered.requires.includes('document.write'), true);
  assert.equal(catalogue.find(entry => entry.name === 'insert_blocks').schema.properties.blocks.maxItems, LIMITS.insertBlocksMax);
  const batch = validateBatch(catalogue, [{ tool: 'insert_blocks', arguments: { blocks: [{ text: 'Глава', heading: 1 }] } }]);
  assert.equal(batch.length, 1);
  assert.equal(batch[0].descriptor.name, 'insert_blocks');
  const responses = ['{"type":"tool_calls","calls":[{"tool":"insert_blocks","arguments":{"blocks":[{"text":"Глава","heading":1}]}}]}',
    '{"type":"final","message":"глава добавлена"}'];
  const crossed = [];
  let step = 0;
  const run = await runAgent({ registry, editor: 'word', capabilities: ['document.read', 'document.write'], mode: 'EDIT',
    settings: {}, uuid: '77777777-7777-4777-8777-777777777777', request: 'добавь главу в конец',
    transport: async (messages) => { crossed.push(messages.map(message => message.content)); return { content: responses[step++] ?? responses[responses.length - 1] }; } });
  assert.equal(run.status, 'FINAL');
  assert.deepEqual(run.actions.map(action => [action.tool, action.outcome]), [['insert_blocks', 'ok']]);
  assert.equal(r.commands.length, 1, 'one command for the whole run, and no read/write path touched');
  assert.equal(r.doc.calls.pushes, 1, 'the one block of the batch became exactly one Push, at the END');
  assert.equal(r.bridge.getState().busy, false);
  assert.equal(r.bridge.getState().writePending, false);
  // The model really RECEIVES the measured delta through the runtime's own per-result serialization.
  const toolResults = crossed.flat().filter(content => content.includes('"type":"tool_results"'));
  assert.equal(toolResults.length, 1, 'one tool-result message crossed to the model');
  const published = JSON.parse(toolResults[0]).results[0];
  assert.equal(published.tool, 'insert_blocks');
  assert.equal(published.ok, true);
  assert.deepEqual(published.data, { inserted: 1, headings: 1, paragraphsBefore: 10, paragraphsAfter: 11, bytes: 10 },
    'the tool publishes the five fields it names; the four counts are the ones the bridge measured');
});


// --- Sprint 3, tool 6: `insert_table` — the SECOND MUTATION, an exact-delta contract over an APPEND ---
//
// A table is the first creation primitive whose SUCCESS is a claim about a STRUCTURE: the appended table
// must carry the requested MATRIX in its OWN cells. The mechanism is `insert_blocks`' (§13/§13.2) — a
// pre-dispatch baseline read, ONE authored static command body that builds the `Api` facade itself, the
// model data carried as `Asc.scope` DATA, the write through the route MEASURED to append at the END
// (`document.Push`), a post read, and an outcome that is `ok` ONLY on an exact proof — with the measured
// table primitives: `Api.CreateTable(rows, columns)` builds the structure, every cell is filled through
// `table.GetCell(r, c).GetContent().GetElement(0).AddText(text)` (measured: the cell text appears in the
// document), and the appended table's own cells are read back through the SAME element's `GetText()` —
// the symmetric read of the measured fill chain. `GetRowCount`/`GetColumnCount` were measured as
// `undefined` and are used NOWHERE; `GetAllTables()` (measured 0 → 1 after one insert) is the count the
// delta is decided on; and the legacy whole-array `InsertContent` primitive — measured to land at the
// BEGINNING and to replace existing text under a selection — is authored nowhere, because this tool's
// promise is an APPEND.
function tablesBridge(answer, extras = {}) {
  const seen = [];
  return { seen, insertTable: async (args) => { seen.push(args); return typeof answer === 'function' ? answer(args) : answer; }, ...extras };
}
function insertTableTool(bridge) { return createWordTools(bridge).find(entry => entry.name === 'insert_table'); }
// The envelope the REAL bridge publishes for ONE `rows × columns` table inserted into a document that
// held `before` tables: the two counts the delta is decided on, and one presence flag per CELL in
// row-major order — cell `[r][c]` owns the appended table's cell `(r, c)`.
function inserted(before, rows, columns, overrides = {}) {
  return { ok: true, tablesBefore: before, tablesAfter: before + 1,
    present: new Array(rows * columns).fill(true), ...overrides };
}
const TWO_BY_TWO = Object.freeze([['а', 'б'], ['в', 'г']]);
const TWO_BY_THREE = Object.freeze([['а', 'б', 'в'], ['г', 'д', 'е']]);

test('insert_table advertises the closed bounded schema and the four bounds it names', () => {
  const tool = insertTableTool(tablesBridge(inserted(1, 2, 2)));
  assert.equal(tool.name, 'insert_table');
  assert.equal(tool.kind, 'mutate');
  assert.deepEqual([...tool.editors], ['word']);
  assert.equal(tool.policy, 'auto');
  assert.deepEqual([...tool.requires], ['document.write']);
  const schema = tool.schema;
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['data']);
  // NO `header` OPTION EXISTS, and that is a MEASURED decision rather than an omission: no measured
  // primitive applies header formatting (nor is a header row distinguishable once it is in the
  // document), so advertising one would promise what this tool cannot do.
  assert.deepEqual(Object.keys(schema.properties), ['data']);
  const data = schema.properties.data;
  assert.equal(data.type, 'array');
  assert.equal(data.maxItems, LIMITS.insertTableRowsMax);
  assert.equal(data.minItems, undefined,
    'the closed schema vocabulary has no minItems keyword (src/tools/schemas.js allowlists every keyword), so the non-empty lower bound is enforced by the handler AND by the bridge, both tested below');
  assert.equal(data.items.type, 'array');
  assert.equal(data.items.maxItems, LIMITS.insertTableColumnsMax);
  assert.equal(data.items.minItems, undefined, 'the same rule one level down: a row with no cell is refused by the handler and by the bridge');
  assert.equal(data.items.items.type, 'string');
  assert.equal(data.items.items.maxBytes, LIMITS.insertTableCellBytes);
  assert.equal(data.items.items.minBytes, undefined,
    'a BLANK cell is a real table cell, so the schema advertises no lower bound on a cell text');
  // The four named bounds, pinned as NUMBERS and as distinct quantities: none is an alias of another
  // tool's scope, and the whole-payload bound is the per-action argument ceiling the runtime applies.
  assert.deepEqual([LIMITS.insertTableRowsMax, LIMITS.insertTableColumnsMax, LIMITS.insertTableCellBytes, LIMITS.insertTableBytes],
    [64, 16, 1024, 8192]);
  assert.equal(LIMITS.insertTableBytes, AGENT_CEILINGS.argumentsBytes, 'the whole payload IS the per-action argument ceiling');
  assert.notEqual(LIMITS.insertTableCellBytes, LIMITS.insertBlockBytes, 'a cell is not a paragraph, so it is not `insert_blocks`\' bound');
  assert.notEqual(LIMITS.insertTableColumnsMax, LIMITS.insertTableRowsMax, 'a column is not a row');
  assert.equal(validateArguments(schema, { data: TWO_BY_TWO }).data.length, 2);
});

test('insert_table refuses every illegal argument with nothing dispatched, at the schema or in the handler', async () => {
  // The closed schema vocabulary expresses the geometry bounds (`maxItems` twice) and the per-cell byte
  // bound, but NOT the non-empty array, NOT the non-empty row and NOT the rectangularity: those three
  // deep rules are refused by THIS handler (and by the bridge) as the closed argument class with nothing
  // dispatched — the same treatment every other deep rule of this schema gets.
  const illegal = [
    ['no argument object', null], ['missing data', {}], ['data is not an array', { data: 'а' }],
    ['an unknown top-level key', { data: TWO_BY_TWO, header: true }],
    ['an EMPTY data array (the handler owns the lower bound)', { data: [] }],
    ['too many rows', { data: new Array(LIMITS.insertTableRowsMax + 1).fill(['а']) }],
    ['a ragged matrix (a SHORT second row)', { data: [['а', 'б'], ['в']] }],
    ['a ragged matrix (a LONG second row)', { data: [['а'], ['б', 'в']] }],
    ['a row that is not an array', { data: ['а'] }], ['a null row', { data: [null] }],
    ['an EMPTY row (the handler owns the row lower bound)', { data: [[]] }],
    ['a row above the column bound', { data: [new Array(LIMITS.insertTableColumnsMax + 1).fill('а')] }],
    ['a cell that is not a string', { data: [[7]] }], ['a null cell', { data: [[null]] }],
    ['a nested array as a cell', { data: [[['а']]] }], ['an unknown key inside a row', { data: [{ '0': 'а' }] }]
  ];
  for (const [label, args] of illegal) {
    const bridge = tablesBridge(inserted(1, 1, 1));
    const tool = insertTableTool(bridge);
    let schemaRefused = false;
    try { validateArguments(tool.schema, args); }
    catch (error) { schemaRefused = true; assert.equal(error.code, 'TOOL_ERROR', label); }
    if (!schemaRefused) {
      const result = await tool.execute(args, { editor: 'word' });
      assert.equal(result.ok, false, label);
      assert.equal(result.code, 'TOOL_ERROR', label);
      assert.equal(result.data, undefined, label);
    }
    assert.deepEqual(bridge.seen, [], `${label}: nothing is dispatched for an illegal argument`);
  }
  // The two BYTE families are the closed byte class, not the argument-shape class, on both sides of the
  // boundary: ONE cell above its own bound (which the schema can already refuse), and a matrix whose cells
  // are each legal while their SUM is not (which only the handler can see).
  const single = tablesBridge(inserted(1, 1, 1));
  assert.throws(() => validateArguments(insertTableTool(single).schema, { data: [['я'.repeat(LIMITS.insertTableCellBytes)]] }),
    /TOOL_ERROR/, 'a single cell above its own bound is refused at the schema, before the handler');
  const sumBridge = tablesBridge(inserted(1, 3, 3));
  const sumTool = insertTableTool(sumBridge);
  const nineLegal = { data: new Array(3).fill(new Array(3).fill('я'.repeat(LIMITS.insertTableCellBytes / 2))) };
  assert.equal(validateArguments(sumTool.schema, nineLegal).data.length, 3,
    'the schema bounds ONE cell and the geometry: it cannot sum a payload, which is why the handler does');
  assert.equal(utf8ByteLength('я'.repeat(LIMITS.insertTableCellBytes / 2)) * 9, 9216, 'nine cells of 1024 bytes');
  const sumResult = await sumTool.execute(nineLegal, { editor: 'word' });
  assert.equal(sumResult.code, 'BYTE_LIMIT', 'nine legal cells whose sum exceeds the payload bound');
  const overCell = tablesBridge(inserted(1, 1, 1));
  const cellResult = await insertTableTool(overCell).execute({ data: [['я'.repeat(LIMITS.insertTableCellBytes)]] }, { editor: 'word' });
  assert.equal(cellResult.code, 'BYTE_LIMIT', 'one cell above insertTableCellBytes is the closed byte class');
  assert.deepEqual([...overCell.seen, ...sumBridge.seen], [],
    'neither over-bound payload reaches the bridge, and the handler owns the sum the schema cannot see');
});

test('insert_table inserts through exactly ONE bridge call and publishes the measured delta', async () => {
  const bridge = tablesBridge(inserted(1, 2, 2));
  const controller = new AbortController();
  const result = await insertTableTool(bridge).execute({ data: TWO_BY_TWO }, { editor: 'word', signal: controller.signal });
  assert.equal(result.ok, true);
  // `bytes` is the dispatched payload's own size — the sum of every cell's UTF-8 bytes — so the result
  // reports what crossed to the editor and not the result's own size.
  assert.deepEqual(result.data, { rows: 2, columns: 2, tablesBefore: 1, tablesAfter: 2, bytes: 8 });
  assert.deepEqual(Object.keys(result.data), ['rows', 'columns', 'tablesBefore', 'tablesAfter', 'bytes'],
    'the five measured fields and nothing else: an envelope cannot smuggle a field into the entry');
  assert.equal(bridge.seen.length, 1, 'EXACTLY one bridge call: the insert is dispatched once and never retried');
  assert.deepEqual(bridge.seen[0].data, TWO_BY_TWO);
  assert.equal(bridge.seen[0].signal, controller.signal, 'the caller\'s signal crosses with the matrix so a Stop cancels before the dispatch');
  assert.equal(utf8ByteLength('а') * 4, 8, 'four one-letter Cyrillic cells are eight bytes');
});

test('insert_table publishes a verified insert ONLY for the exact delta, and never retries otherwise', async () => {
  // THE PROOF IS ONE-TO-ONE OVER THE APPEND, and it has TWO halves that cannot substitute for each other:
  // the table list grew by EXACTLY one, and every cell flag of the table the append added is true. The
  // rows below break one half at a time.
  const wrong = [
    ['the table list did not grow', inserted(1, 2, 2, { tablesAfter: 1 })],
    ['two tables arrived', inserted(1, 2, 2, { tablesAfter: 3 })],
    ['the document shrank', inserted(1, 2, 2, { tablesAfter: 0 })],
    ['a cell of the appended table carries something else', inserted(1, 2, 2, { present: [true, false, true, true] })],
    ['the FIRST cell of the appended table is not the requested one', inserted(1, 2, 2, { present: [false, true, true, true] })],
    ['the appended table is empty', inserted(1, 2, 2, { present: [false, false, false, false] })]
  ];
  const run = async (answer, data = TWO_BY_TWO) => {
    const bridge = tablesBridge(answer);
    return { result: await insertTableTool(bridge).execute({ data }, { editor: 'word' }), bridge };
  };
  const verified = await run(inserted(1, 2, 2));
  assert.equal(verified.result.ok, true);
  assert.equal(verified.bridge.seen.length, 1);
  for (const [label, answer] of wrong) {
    const { result, bridge } = await run(answer);
    assert.equal(result.ok, false, label);
    assert.equal(result.code, 'TOOL_UNCERTAIN', label);
    assert.equal(result.message, 'отказ', label);
    assert.equal(result.data, undefined, `${label}: an uncertain outcome publishes no delta`);
    assert.equal(bridge.seen.length, 1, `${label}: NO retry — the insert was dispatched exactly once`);
  }
  // A flag list of the wrong LENGTH cannot describe THIS matrix, and a flag that is not a boolean — or a
  // count that is not a non-negative safe integer — is not a cell check or a count at all: all of them are
  // envelopes this handler cannot interpret, so they are the module's unknown convention (`known()`) exactly
  // as for a missing count. The real bridge cannot produce any of them (its decoder pins the flag count to
  // the same matrix and admits only two counts and 0/1 flags), so this closes the direct-descriptor path.
  for (const answer of [inserted(1, 2, 2, { present: [true] }), inserted(1, 2, 2, { present: new Array(5).fill(true) }),
    inserted(1, 2, 2, { present: [1, 1, 1, 1] }), inserted(1, 2, 2, { present: 'true' }),
    inserted(1, 2, 2, { tablesAfter: 1.5 }), inserted(1, 2, 2, { tablesBefore: '1' })]) {
    const bridge = tablesBridge(answer);
    const result = await insertTableTool(bridge).execute({ data: TWO_BY_TWO }, { editor: 'word' });
    assert.equal(result.ok, false, JSON.stringify(answer));
    assert.equal(result.code, 'TOOL_ERROR', JSON.stringify(answer));
    assert.equal(bridge.seen.length, 1, JSON.stringify(answer));
  }
});

test('insert_table refuses an unusable baseline with zero writes and republishes the closed class it was given', async () => {
  // THE BASELINE GATE. A bridge that cannot establish how many tables the document held cannot establish
  // the delta either, so it refuses BEFORE the insert: the closed capability class, and no `data` at all.
  const gated = await insertTableTool(tablesBridge({ ok: false, code: 'CAPABILITY_UNAVAILABLE' }))
    .execute({ data: TWO_BY_TWO }, { editor: 'word' });
  assert.equal(gated.ok, false);
  assert.equal(gated.code, 'CAPABILITY_UNAVAILABLE');
  assert.equal(gated.data, undefined);
  // Every closed class the bridge can report is republished unchanged; a code the closed vocabulary does
  // not define is never republished, and a raw throw never leaks its message.
  for (const code of ['CAPABILITY_UNAVAILABLE', 'TOOL_ERROR', 'BYTE_LIMIT', 'EDITOR_BUSY', 'TIMEOUT', 'CANCELLED', 'INVALID_DATA']) {
    const bridge = tablesBridge({ ok: false, code });
    const result = await insertTableTool(bridge).execute({ data: TWO_BY_TWO }, { editor: 'word' });
    assert.equal(result.ok, false, code);
    assert.equal(result.code, code, code);
    assert.equal(result.message, 'отказ', code);
    assert.equal(result.data, undefined, code);
    assert.equal(bridge.seen.length, 1, code);
  }
  const forged = await insertTableTool(tablesBridge({ ok: false, code: 'СЕКРЕТ-ДОКУМЕНТА' }))
    .execute({ data: TWO_BY_TWO }, { editor: 'word' });
  assert.equal(forged.code, 'TOOL_ERROR');
  assert.equal(JSON.stringify(forged).includes('СЕКРЕТ'), false);
  const thrown = await insertTableTool(tablesBridge(null, { insertTable: async () => { throw new Error('СЕКРЕТ-ДОКУМЕНТА'); } }))
    .execute({ data: TWO_BY_TWO }, { editor: 'word' });
  assert.equal(thrown.code, 'TOOL_ERROR');
  assert.equal(JSON.stringify(thrown).includes('СЕКРЕТ'), false);
  // An envelope this tool cannot interpret is refused rather than published as a verified insert.
  for (const answer of [null, undefined, 7, 'текст', [], { ok: true }, { ok: true, tablesBefore: 1 },
    inserted(1, 2, 2, { tablesAfter: null })]) {
    const bridge = tablesBridge(answer);
    const result = await insertTableTool(bridge).execute({ data: TWO_BY_TWO }, { editor: 'word' });
    assert.equal(result.ok, false, JSON.stringify(answer));
    assert.equal(result.code, 'TOOL_ERROR', JSON.stringify(answer));
    assert.equal(bridge.seen.length, 1, JSON.stringify(answer));
  }
});

test('insert_table maps a returned or thrown uncertain class to TOOL_UNCERTAIN and holds the run', async () => {
  // Both legs the bridge expresses one class in: a THROWN SafeError (a decode that could not interpret a
  // dispatched insert) and a RETURNED envelope (the bridge's own settlement form). They classify
  // identically, and neither is retried.
  const returned = await insertTableTool(tablesBridge({ ok: false, code: 'APPLY_UNCERTAIN' }))
    .execute({ data: TWO_BY_TWO }, { editor: 'word' });
  assert.deepEqual({ ...returned }, { ok: false, code: 'TOOL_UNCERTAIN', message: 'отказ' });
  const seen = [];
  const thrown = await insertTableTool({ insertTable: async (args) => { seen.push(args); throw Object.assign(new Error('x'), { code: 'APPLY_UNCERTAIN' }); } })
    .execute({ data: TWO_BY_TWO }, { editor: 'word' });
  assert.equal(thrown.code, 'TOOL_UNCERTAIN');
  assert.equal(seen.length, 1, 'no retry of an uncertain insert');
  // TOOL_UNCERTAIN is the runtime-facing class this handler already produces: a bridge that returns it
  // must NOT have it laundered into an ordinary known error.
  const passthrough = await insertTableTool(tablesBridge({ ok: false, code: 'TOOL_UNCERTAIN' }))
    .execute({ data: TWO_BY_TWO }, { editor: 'word' });
  assert.equal(passthrough.code, 'TOOL_UNCERTAIN');
  // ...and the runtime really records the outcome as the uncertain one that stops the run fail-safe.
  const registry = createRegistry([insertTableTool(tablesBridge({ ok: false, code: 'APPLY_UNCERTAIN' }))]);
  const run = await runAgent({ registry, editor: 'word', capabilities: ['document.read', 'document.write'], mode: 'EDIT',
    settings: {}, uuid: '88888888-8888-4888-8888-888888888888', request: 'вставь таблицу',
    transport: async () => ({ content: '{"type":"tool_calls","calls":[{"tool":"insert_table","arguments":{"data":[["а","б"]]}}]}' }) });
  assert.deepEqual(run.actions.map(action => [action.tool, action.outcome]), [['insert_table', 'uncertain']]);
});

test('insert_table refuses a non-Word editor and a bridge that cannot serve the insert, before any dispatch', async () => {
  const tool = insertTableTool(tablesBridge(inserted(1, 1, 1)));
  assert.equal(tool.precondition({ data: TWO_BY_TWO }, { editor: 'word' }), null);
  for (const editor of ['cell', 'slide', 'unknown', undefined, null]) {
    const refusal = tool.precondition({ data: TWO_BY_TWO }, { editor });
    assert.equal(refusal.code, 'CAPABILITY_UNAVAILABLE', String(editor));
    assert.equal(refusal.message, 'отказ', String(editor));
  }
  for (const bridge of [{}, { insertTable: 7 }, { insertTable: null }, null, undefined]) {
    const result = await insertTableTool(bridge).execute({ data: TWO_BY_TWO }, { editor: 'word' });
    assert.equal(result.ok, false, JSON.stringify(bridge));
    assert.equal(result.code, 'CAPABILITY_UNAVAILABLE', JSON.stringify(bridge));
    assert.equal(result.data, undefined);
  }
});

test('insert_table measures the exact entry it publishes, and its five bounded integers cannot reach the ceiling', async () => {
  const bridge = tablesBridge(inserted(1, 2, 2));
  const data = [['я'.repeat(512), 'я'.repeat(512)], ['я'.repeat(512), 'я'.repeat(512)]];
  const result = await insertTableTool(bridge).execute({ data }, { editor: 'word' });
  assert.equal(result.ok, true);
  assert.equal(result.data.bytes, 4096, 'four cells of 1024 bytes');
  // The measurement is the entry the runtime PUBLISHES — `JSON.stringify({ tool, ...result })` — and it
  // must be inside the same ceiling `stringifyToolResults` enforces, so the model receives the delta
  // instead of the literal "the tool result could not be serialized".
  const entry = utf8ByteLength(JSON.stringify({ tool: 'insert_table', ...result }));
  assert.equal(entry, 109, 'the measured entry of a real insert');
  assert.ok(entry <= AGENT_CEILINGS.toolResultBytes);
  const messages = toolResultMessages([{ tool: 'insert_table', result }]);
  assert.equal(messages.length, 1);
  const modelVisible = JSON.parse(messages[0].content);
  assert.equal(modelVisible.results[0].tool, 'insert_table');
  assert.deepEqual(modelVisible.results[0].data, { rows: 2, columns: 2, tablesBefore: 1, tablesAfter: 2, bytes: 4096 });
  // THE ENFORCED BOUND IS THE MEASUREMENT, and this test states exactly how much room it has: every field
  // of this result is a non-negative safe integer, so even the WIDEST shape the handler can publish — all
  // five at `Number.MAX_SAFE_INTEGER` — is far inside the 16384-byte ceiling. The `BYTE_LIMIT` branch is
  // retained because it is the module's ONE entry measurement (a field added to this result later must not
  // widen the entry unmeasured), and it is unreachable for the five integers this handler publishes.
  const widest = utf8ByteLength(JSON.stringify({ tool: 'insert_table', ok: true,
    data: { rows: Number.MAX_SAFE_INTEGER, columns: Number.MAX_SAFE_INTEGER, tablesBefore: Number.MAX_SAFE_INTEGER,
      tablesAfter: Number.MAX_SAFE_INTEGER, bytes: Number.MAX_SAFE_INTEGER } }));
  assert.equal(widest, 181);
  assert.ok(AGENT_CEILINGS.toolResultBytes - widest > 16000, `${AGENT_CEILINGS.toolResultBytes - widest} bytes of slack`);
  assert.doesNotThrow(() => toolResultMessages([{ tool: 'insert_table', result: { ...result, data: { rows: Number.MAX_SAFE_INTEGER,
    columns: Number.MAX_SAFE_INTEGER, tablesBefore: Number.MAX_SAFE_INTEGER, tablesAfter: Number.MAX_SAFE_INTEGER,
    bytes: Number.MAX_SAFE_INTEGER } } }]));
});

// --- the real bridge: the SIXTH authored command body, and the SECOND one that mutates -----------------
// One TABLE double, modelling the MEASURED creation/fill chain AND the MEASURED argument order of the
// factory: on the target, `Api.CreateTable(a, b)` creates `a` COLUMNS and `b` ROWS, so a double that is
// handed the OLD assumed order `(rows, columns)` really builds a TRANSPOSED table — which is exactly the
// defect the geometry precondition below exists to catch, and why `tableDouble` is parameterised on the
// terms it receives (`first` = what the factory got first, i.e. the column count on a correct build).
// `GetCell(r, c)` answers a cell whose `GetContent().GetElement(0)` carries the measured `AddText(text)`
// AND the symmetric `GetText()` the readback needs, and every cell keeps the text it was given, so a test
// can state exactly what the appended table holds. `write: false` fills every cell with NOTHING and
// `write: 'Другое'` fills every cell with a text that is not the requested one; both model an insert whose
// table really arrived while its content did not. `missingRow` builds a table with `missingRow` rows FEWER
// than the requested matrix (the created table is one row too SHORT) and `missingCell` removes that many
// cells from the end of its LAST row (one column too NARROW); both are the two DIRECTIONS of the measured
// out-of-range asymmetry — a row past the end answers `null`, while a column past the end of a row that
// does exist is an internal throw (`Cannot read properties of null (reading 'Pr')`), never a value a
// caller may invoke. `extraRow` is the opposite malformation: the table carries `extraRow` rows MORE than
// the matrix asked for, so an address PAST the matrix's own last row still answers a real cell.
function tableDouble(first, second, { write = true, initial = () => '', missingRow = 0, missingCell = 0, extraRow = 0 } = {}) {
  const cells = [];
  for (let row = 0; row < second - missingRow; row += 1) {
    const line = [];
    for (let column = 0; column < first; column += 1) line.push({ text: initial(row, column) });
    cells.push(line);
  }
  for (let removed = 0; removed < missingCell && cells.length > 0; removed += 1) cells[cells.length - 1].pop();
  const writes = { addTexts: 0, getCells: 0 };
  function cellAt(row, column) {
    writes.getCells += 1;
    if (row >= second && row < second + extraRow && column === 0) {
      const stray = { text: '' };
      const strayElement = {
        AddText(text) { writes.addTexts += 1; stray.text = text; },
        GetText() { return stray.text; }
      };
      return { GetContent() { return { GetElement(index) { return index === 0 ? strayElement : null; } }; } };
    }
    const line = cells[row];
    if (line === undefined) return null;
    if (column >= first && column < second) throw new Error('СЕКРЕТ-ДОКУМЕНТА');
    const holder = line[column];
    if (holder === undefined) return null;
    const element = {
      AddText(text) { writes.addTexts += 1; holder.text = write === true ? text : (write === false ? '' : write); },
      GetText() { return holder.text; }
    };
    return { GetContent() { return { GetElement(index) { return index === 0 ? element : null; } }; } };
  }
  return { cells, writes, GetCell: cellAt };
}
function tableTexts(table) { return table.cells.map(line => line.map(holder => holder.text)); }
// The DOCUMENT double, modelling the MEASURED route: `doc.Push(table)` answers and APPENDS AT THE END, so
// the table list really grows by one and counts one call per table. `grow: 0` models a primitive that
// answered and changed nothing and `grow: 2` a mutation that landed twice; `prepends: true` models a
// mutation that lands at the START. `InsertContent` is offered ONLY as a trap that records any call and
// lands its content at the BEGINNING — the measured behaviour of the legacy route — which is why this
// tool must never call it.
function tablesDocument({ tables = [], grow = 1, prepends = false, answer = true } = {}) {
  const state = { tables: [...tables], pushes: 0, created: [], insertContents: 0 };
  return { state, document: {
    GetAllTables() { return state.tables.slice(); },
    Push(table) {
      state.pushes += 1;
      state.created.push(table);
      for (let count = 0; count < grow; count += 1) { if (prepends) state.tables.unshift(table); else state.tables.push(table); }
      return answer;
    },
    InsertContent(items) { state.insertContents += 1; for (const item of items) state.tables.unshift(item); return answer; }
  } };
}
function evaluateTableBody(body, api, scope) {
  return new Function('Api', 'scope', 'return (' + Function.prototype.toString.call(body) + ')();')(api, scope);
}
// `forge` hands the bridge a REPLACEMENT for the answer the body really produced, after that body has run
// to completion against the document double — a real insert included. It is the only way to model a
// hostile or damaged native answer for a dispatched insert without weakening the body itself.
// `creationOrder` is the FACTORY MODEL: `'measured'` (the target: the first argument is the column count,
// the second the row count) or `'assumed'` (the pre-fix build: the body passed `(rows, columns)`, so the
// double really must build the transposed table the target builds for those arguments). `missingRow` and
// `missingCell` cut one row off the end and one cell off the last row's end respectively, so a wrong
// geometry can be modelled as an ABSENT cell in either of the two measured directions.
function tablesRig({ existing = 1, existingShape = [2, 2], grow = 1, prepends = false, answer = true, write = true,
  command = true, namespace = { scope: 'сентинел' }, omitCarrier = false, document = undefined, forge = undefined,
  createThrows = false, cellThrows = false, createTable = undefined, creationOrder = 'measured',
  missingRow = 0, missingCell = 0, extraRow = 0 } = {}) {
  const commands = [];
  const createdShapes = [];
  const tables = [];
  for (let index = 0; index < existing; index += 1) {
    tables.push(tableDouble(existingShape[0], existingShape[1], { initial: (row, column) => `старая-${index}-${row}-${column}` }));
  }
  const measured = tablesDocument({ tables, grow, prepends, answer });
  const api = { GetDocument() { return document === undefined ? measured.document : document; },
    CreateTable(first, second) {
      if (createThrows) throw new Error('СЕКРЕТ-ДОКУМЕНТА');
      createdShapes.push([first, second]);
      if (typeof createTable === 'function') return createTable(first, second);
      // THE TARGET'S OWN ARGUMENT ORDER, modelled: the factory's first argument is a COLUMN count and its
      // second is a ROW count. `creationOrder: 'assumed'` hands the double the pair the OLD body passed
      // (`(rows, columns)`), which on the target really builds the TRANSPOSED table — the created geometry
      // then no longer matches the requested matrix, and the tool must refuse it before any write.
      const shape = creationOrder === 'assumed' ? [second, first] : [first, second];
      const table = tableDouble(shape[0], shape[1], { write, missingRow, missingCell, extraRow });
      if (cellThrows) table.GetCell = () => { throw new Error('СЕКРЕТ-ДОКУМЕНТА'); };
      return table;
    } };
  const plugin = { info: { editorType: 'word' },
    callCommand: command ? function (body, close, recalculate, callback) {
      const source = Function.prototype.toString.call(body);
      const scope = namespace?.scope;
      const answered = evaluateTableBody(body, api, scope);
      commands.push({ by: 'callCommand', body, source, close, recalculate, scope, answered });
      callback(forge === undefined ? answered : forge);
      return false;
    } : undefined };
  const options = { editorType: 'word', clock: { now: () => 0 }, timers: { schedule() { return {}; }, clear() {} } };
  if (!omitCarrier) options.ascNamespace = namespace;
  const bridge = bridgeWith(plugin, options);
  return { bridge, plugin, commands, namespace, api, doc: measured, createdShapes };
}

test('bridge insertTable dispatches ONE command, carries the matrix as DATA and verifies the exact delta', async () => {
  const namespace = { scope: 'предыдущая-область' };
  const r = tablesRig({ namespace });
  const data = [['Глава', 'Текст'], ['Ещё', 'Строка']];
  const pending = r.bridge.insertTable({ data });
  assert.equal(r.commands.length, 1, 'exactly ONE command is dispatched for the whole insert');
  const carried = r.commands[0];
  assert.equal(carried.by, 'callCommand', 'the wrapper is the entry point the measured build exposes');
  assert.equal(typeof carried.body, 'function', 'the body is handed as an authored function literal, never as text');
  assert.equal(carried.close, false, 'the documented close/recalculate arguments are unchanged');
  assert.equal(carried.recalculate, false);
  assert.deepEqual(carried.scope, { data }, 'the matrix crosses as the command SCOPE, never interpolated into source');
  assert.equal(namespace.scope, 'предыдущая-область', 'the namespace is restored: no matrix outlives its dispatch');
  assert.deepEqual(r.createdShapes, [[2, 2]], 'the measured factory is called with (columns, rows) — the square case hides the order');
  assert.equal(r.doc.state.pushes, 1, 'ONE Push for the whole table: a table is ONE element, not one per cell');
  assert.equal(r.doc.state.insertContents, 0, 'the legacy whole-array primitive — which lands at the START — is never called');
  assert.deepEqual(carried.answered, ['POST_INSERT', 1, 2, 1, 1, 1, 1],
    'the body encodes the explicit phase slot, the two counts and one flag per CELL, in row-major order');
  assert.deepEqual(await pending, { ok: true, tablesBefore: 1, tablesAfter: 2, present: [true, true, true, true] });
  // The DOCUMENT really holds the table, and the table really holds the matrix: the double is state, not a
  // stub, so the assertion is about what the append left behind.
  assert.equal(r.doc.state.tables.length, 2);
  assert.deepEqual(tableTexts(r.doc.state.tables[1]), data, 'the appended table carries the requested matrix, cell for cell');
  assert.equal(r.bridge.getState().busy, false, 'the slot is released by the native callback');
  assert.equal(r.bridge.getState().writePending, false);
  assert.equal(r.bridge.getState().uncertain, false);
});

// --- THE MEASURED ARGUMENT ORDER OF THE FACTORY, and the GEOMETRY PRECONDITION it forces ----------------
// THE MEASURED FACT, established on the target (Astra / R7 2026.1.2.1942): `Api.CreateTable(a, b)` creates
// `a` COLUMNS and `b` ROWS — the OPPOSITE of the `(rows, columns)` order the first version of this tool
// assumed. A square matrix is its own transpose, which is exactly why the earlier native run passed and
// the pilot's main case — a one-row header table — went out as `CAPABILITY_UNAVAILABLE`. These tests pin
// the order AND the precondition that turns any build whose factory order differs into a CLOSED pre-insert
// refusal rather than a partially filled table.
for (const [label, shape, expected] of [
  ['ONE ROW × TWO COLUMNS (the pilot case: the row count is the SHORT one)', [1, 2], [2, 1]],
  ['TWO ROWS × ONE COLUMN (the transposed pilot case)', [2, 1], [1, 2]],
  ['a SQUARE 2 × 2 (the case that could never have caught the defect)', [2, 2], [2, 2]],
  ['THREE ROWS × FIVE COLUMNS', [3, 5], [5, 3]],
  ['FIVE ROWS × THREE COLUMNS', [5, 3], [3, 5]]
]) {
  test(`the factory is given (columns, rows): ${label}`, async () => {
    const [rows, columns] = shape;
    const data = new Array(rows).fill(null).map((_, row) => new Array(columns).fill(null).map((__, column) => `я${row}${column}`));
    const r = tablesRig({ existing: 0, namespace: { scope: { data } } });
    const result = await r.bridge.insertTable({ data });
    assert.deepEqual(r.createdShapes, [expected],
      `the measured signature is (columns, rows): ${columns} columns then ${rows} rows, never the reverse`);
    assert.equal(r.doc.state.pushes, 1, 'exactly one table is pushed for the whole matrix');
    assert.deepEqual(tableTexts(r.doc.state.tables[0]), data,
      'and the appended table carries the requested matrix read row by row and cell by cell');
    assert.deepEqual(result, { ok: true, tablesBefore: 0, tablesAfter: 1, present: new Array(rows * columns).fill(true) },
      'every cell of the created geometry is the cell the matrix asked for');
    assert.equal(r.bridge.getState().busy, false, 'a verified insert releases the slot');
  });
}

test('a factory that builds the OLD assumed geometry is a CLOSED pre-insert refusal with ZERO writes', async () => {
  // THE DEFECT ITSELF, modelled: the double is handed the pair the OLD body passed (`(rowCount,
  // columnCount)`) and, being the target's factory, builds that transposed table — `a` columns and `b`
  // rows. For a 1×2 matrix the result is a 2-column, 1-row table: the LAST cell the fill loop would touch,
  // `(rowCount - 1, columnCount - 1)` = `(0, 1)`, does not exist. The precondition must see that BEFORE
  // the one `Push`, so the insert is refused closed with nothing created and nothing written — never a
  // partially filled table. Both measured DIRECTIONS of the out-of-range asymmetry are modelled: an
  // absent cell (a `null` from an index past the end) and an internal THROW.
  const data = [['НОВАЯ-Т1', 'НОВАЯ-Т2']];
  const absent = tablesRig({ existing: 1, namespace: { scope: { data } }, creationOrder: 'assumed' });
  assert.deepEqual(await absent.bridge.insertTable({ data }), { ok: false, code: 'CAPABILITY_UNAVAILABLE' },
    'a factory that built the wrong geometry is the closed capability class, not a partial insert');
  assert.equal(absent.doc.state.pushes, 0, 'the mutation is NEVER reached');
  assert.equal(absent.doc.state.insertContents, 0, 'and neither is the legacy whole-array primitive');
  assert.equal(absent.doc.state.tables.length, 1, 'the document still holds exactly its one pre-existing table');
  assert.equal(absent.createdShapes.length, 1, 'the factory was tried once, with the body\'s own argument pair');
  assert.equal(absent.bridge.getState().busy, false, 'the slot is RELEASED: a pre-insert refusal proves nothing was inserted');
  assert.equal(absent.bridge.getState().uncertain, false);
  const throwing = tablesRig({ existing: 1, namespace: { scope: { data } }, creationOrder: 'assumed', cellThrows: true });
  assert.deepEqual(await throwing.bridge.insertTable({ data }), { ok: false, code: 'CAPABILITY_UNAVAILABLE' },
    'the same wrong geometry is closed when the out-of-range read THROWS instead of answering null');
  assert.equal(throwing.doc.state.pushes, 0);
  assert.equal(throwing.bridge.getState().busy, false);
  // A WIDER wrong shape, so the precondition is not tuned to one matrix: 1 row × 4 columns is created as a
  // 4-column, 1-row table and the last cell the loop would touch is again one that does not exist.
  const wide = [['а', 'б', 'в', 'г']];
  const wideRig = tablesRig({ existing: 0, namespace: { scope: { data: wide } }, creationOrder: 'assumed' });
  assert.deepEqual(await wideRig.bridge.insertTable({ data: wide }), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
  assert.equal(wideRig.doc.state.pushes, 0);
  assert.equal(wideRig.doc.state.tables.length, 0, 'and the wrong-shaped table never reached the document');
});

test('the geometry is a VERIFIED precondition: an absent cell in either direction refuses before any write', async () => {
  // The precondition reads the geometry it is about to fill rather than trusting the factory's argument
  // order: the LAST cell the fill loop will touch must exist and carry the measured chain, and the cell
  // immediately after it — `(rowCount, 0)`, the first index of a row past the end — must be ABSENT, both
  // with the same null/undefined/typeof guards the fill loop uses. The absent-cell directions are modelled
  // separately because the target's out-of-range behaviour is asymmetric: `null` in one direction and an
  // internal throw in the other, and BOTH are closed refusals.
  const data = [['а', 'б', 'в'], ['г', 'д', 'е']];
  for (const [label, options] of [
    ['the last cell is ABSENT (a table one column too narrow: the cell answers null)', { missingCell: 1 }],
    ['the last cell is ABSENT (a table one row too short: the row answers null)', { missingRow: 1 }],
    ['the last cell read THROWS (the asymmetry the guards must survive)', { missingCell: 1, cellThrows: true }],
    ['the row past the matrix still answers a cell (a table one row too tall)', { extraRow: 1 }]
  ]) {
    const r = tablesRig({ existing: 0, namespace: { scope: { data } }, ...options });
    assert.deepEqual(await r.bridge.insertTable({ data }), { ok: false, code: 'CAPABILITY_UNAVAILABLE' }, label);
    assert.equal(r.doc.state.pushes, 0, `${label}: nothing is pushed`);
    assert.equal(r.doc.state.tables.length, 0, `${label}: no table reached the document`);
    assert.equal(r.bridge.getState().busy, false, `${label}: the slot is released`);
  }
});

test('the table body is self-contained: it answers the measured shapes in a fresh, module-free scope', async () => {
  const r = tablesRig({ existing: 0 });
  const data = [['Один', 'Два'], ['Три', 'Четыре']];
  const pending = r.bridge.insertTable({ data });
  const carried = r.commands[0];
  assert.equal(/\b(?:capabilityBody|contextBody|commandTransport|createCommandDispatch|decodeBlocks|decodeTable|decodeSearch|decodeStructure|exactBlocksDelta|exactTableDelta|preInsertRefusal|pluginOwners|createR7Bridge)\b/.test(carried.source),
    false, 'the stringified body names no module binding of bridge.js');
  assert.match(carried.source, /typeof Api !== ['"]undefined['"]/, 'and it builds the public Api facade itself');
  assert.match(carried.source, /CreateTable\s*\(/, 'the table is created through the measured factory');
  assert.match(carried.source, /\.Push\s*\(/, 'the mutation is the measured append primitive');
  assert.equal(/\.InsertContent\s*\(/.test(carried.source), false, 'and the route that lands at the START is authored nowhere');
  assert.equal(/GetRowCount|GetColumnCount/.test(carried.source), false,
    'the two row/column getters measured as `undefined` are used nowhere');
  // The EDITOR'S own evaluation, in a FRESH document so the assertion is about the body's answer and not
  // about how many times the rig ran it. Only `Api` and `scope` are bound here, so a body that closed over
  // a module binding would raise ReferenceError exactly as it did natively on 2026.3.1.
  const fresh = tablesDocument({ tables: [] });
  const shapes = [];
  const freshApi = { GetDocument() { return fresh.document; },
    CreateTable(rows, columns) { shapes.push([rows, columns]); return tableDouble(rows, columns); } };
  const evaluated = evaluateTableBody(carried.body, freshApi, carried.scope);
  assert.deepEqual(shapes, [[2, 2]], 'the matrix arrived as DATA and decided the geometry');
  assert.deepEqual(evaluated, ['POST_INSERT', 0, 1, 1, 1, 1, 1],
    'the phase slot, the two counts and one true flag per cell — the counts are the document\'s own');
  assert.equal(fresh.state.pushes, 1, 'and the ONE Push is where the mutation happens');
  assert.equal(fresh.state.insertContents, 0, 'never through the legacy whole-array primitive');
  assert.deepEqual(tableTexts(fresh.state.tables[0]), data, 'the appended table carries the matrix');
  assert.deepEqual(carried.scope, { data }, 'the matrix crossed as scope data');
  assert.deepEqual((await pending).present, [true, true, true, true]);
});

test('the Push boolean is never the signal: a false that appended verifies, a true that appended nothing does not', async () => {
  // BOTH halves of a mutation primitive's uselessness, on the MEASURED route: `Push` answered `true` for a
  // paragraph and `false` for an image host, so a `true` proves nothing and a `false` is not proof of
  // failure either. The document's own delta is the only evidence, and it is what these two rigs vary.
  const lied = tablesRig({ existing: 1, answer: false });
  assert.deepEqual(await lied.bridge.insertTable({ data: [['Новое']] }),
    { ok: true, tablesBefore: 1, tablesAfter: 2, present: [true] },
    'the document really grew by one table, so the insert IS verified although the primitive answered false');
  assert.equal(lied.bridge.getState().busy, false);
  const noop = tablesRig({ existing: 1, grow: 0 });
  assert.deepEqual(await noop.bridge.insertTable({ data: [['Новое']] }),
    { ok: false, code: 'APPLY_UNCERTAIN' },
    'the primitive answered true and the table list did not move: never a verified insert');
  assert.equal(noop.doc.state.pushes, 1, 'the mutation was dispatched exactly once and is never retried');
  const state = noop.bridge.getState();
  assert.equal(state.busy, true, 'the slot is HELD for an uncertain insert');
  assert.equal(state.uncertain, true);
  assert.equal(state.writePending, true, 'and the write lock stays engaged, so no second mutation can start');
  assert.deepEqual(await noop.bridge.insertTable({ data: [['Ещё']] }), { ok: false, code: 'EDITOR_BUSY' },
    'no retry: the held slot refuses the next insert');
  assert.equal(noop.commands.length, 1, 'and the refused call dispatches nothing at all');
});

test('the table outcome contract is ONE-TO-ONE over the APPENDED TABLE, never a match over the document', async () => {
  // THE EXISTENTIAL TRAP, on the measured route. The document ALREADY holds the requested matrix in a
  // pre-existing table, and the insert creates its table while writing no cell text at all. A verifier
  // that searched the document for the cell texts — or read any table but the one the append added —
  // would be satisfied by the pre-existing occurrence and publish `ok` for an insert that carried
  // nothing. The anchor is the baseline the body took BEFORE `Push`: `Push` appends at the END, so the
  // insert's OWN table is the one at index `tablesBefore`, and its cells are read back cell by cell.
  const data = [['Глава', 'Текст']];
  const existing = tableDouble(2, 1, { initial: (row, column) => data[row][column] });
  const silentDocument = tablesDocument({ tables: [existing], grow: 1 });
  const api = { GetDocument() { return silentDocument.document; },
    CreateTable(columns, rows) { return tableDouble(columns, rows, { write: false }); } };
  const plugin = { info: { editorType: 'word' },
    callCommand(body, close, recalculate, callback) { callback(evaluateTableBody(body, api, { data })); return false; } };
  const quiet = bridgeWith(plugin, { editorType: 'word', ascNamespace: { scope: undefined },
    clock: { now: () => 0 }, timers: { schedule() { return {}; }, clear() {} } });
  const result = await quiet.insertTable({ data });
  assert.equal(silentDocument.state.pushes, 1, 'the mutation was dispatched exactly once');
  assert.equal(silentDocument.state.tables.length, 2, 'the table list really grew by exactly one');
  assert.deepEqual(tableTexts(silentDocument.state.tables[1]), [['', '']],
    'the created table carries NO text — the count delta is exact and the content is not, while the PRE-EXISTING table holds the very matrix');
  assert.equal(result.ok, false, 'an insert whose own cells are empty is NEVER verified, whatever the document already held');
  assert.equal(result.code, 'APPLY_UNCERTAIN');
  assert.equal(result.data, undefined);
  const held = quiet.getState();
  assert.equal(held.busy, true, 'the slot is HELD for an insert whose content did not arrive');
  assert.equal(held.uncertain, true);
  assert.equal(held.writePending, true);
  // The same anchor closes the other wrong-content shape: the cells are filled with something that is not
  // the requested text.
  const wrong = tablesRig({ existing: 0, write: 'Другое' });
  assert.deepEqual(await wrong.bridge.insertTable({ data: [['Глава']] }), { ok: false, code: 'APPLY_UNCERTAIN' },
    'a cell that carries a different text is not this matrix\'s cell');
  assert.deepEqual(tableTexts(wrong.doc.state.tables[0]), [['Другое']], 'the double really wrote the other text');
  // THE TWO CASES THE ANCHOR MUST NOT BREAK. A matrix whose texts ALREADY occur in another table still
  // verifies, because the append carried them in the cells the matrix owns.
  const duplicateText = tableDouble(2, 1, { initial: (row, column) => data[row][column] });
  const elsewhere = tablesRig({ existing: 0 });
  elsewhere.doc.state.tables.push(duplicateText);
  assert.deepEqual(await elsewhere.bridge.insertTable({ data }),
    { ok: true, tablesBefore: 1, tablesAfter: 2, present: [true, true] },
    'the append really carried the matrix, even though the document already held the same texts');
  assert.deepEqual(tableTexts(elsewhere.doc.state.tables[1]), data);
  // And DUPLICATE cell texts verify: two cells with the SAME text are two cells, each in its own slot.
  const duplicates = tablesRig({ existing: 0 });
  assert.deepEqual(await duplicates.bridge.insertTable({ data: [['Дубль', 'Дубль']] }),
    { ok: true, tablesBefore: 0, tablesAfter: 1, present: [true, true] });
  assert.deepEqual(tableTexts(duplicates.doc.state.tables[0]), [['Дубль', 'Дубль']]);
});

test('a table insert that lands at the START is TOOL_UNCERTAIN with the slot HELD: the anchor catches it', async () => {
  // THE OLD ASSUMED ROUTE, modelled: the mutation answers and the table lands at the BEGINNING. The table
  // count really grows by one, so the count delta ALONE would call this a verified insert; only reading
  // the table the baseline addresses — the one at index `tablesBefore` — can see that the insert does not
  // own it.
  const r = tablesRig({ existing: 1, prepends: true });
  const result = await r.bridge.insertTable({ data: [['МАРКЕР-ТАБЛИЦА']] });
  assert.equal(r.doc.state.pushes, 1, 'the mutation was dispatched exactly once');
  assert.deepEqual(tableTexts(r.doc.state.tables[0]), [['МАРКЕР-ТАБЛИЦА']], 'it landed at the START, not the END');
  assert.deepEqual(r.commands[0].answered, ['POST_INSERT', 1, 2, 0],
    'the count grew by exactly one and the table at index 1 (the baseline address) is NOT the inserted one — its flag is 0');
  assert.deepEqual(result, { ok: false, code: 'APPLY_UNCERTAIN' }, 'a start-landing insert is NEVER a verified append');
  const held = r.bridge.getState();
  assert.equal(held.busy, true, 'the slot is HELD: the write really happened, just not where it was promised');
  assert.equal(held.uncertain, true);
  assert.equal(held.writePending, true);
  assert.deepEqual(await r.bridge.insertTable({ data: [['Ещё']] }), { ok: false, code: 'EDITOR_BUSY' },
    'and there is NO retry');
  assert.equal(r.commands.length, 1, 'the refused call dispatches nothing at all');
});

test('a throw between the create and the push is a KNOWN refusal with zero writes; a throw in the push is UNCERTAIN', async () => {
  // THE MUTATION BOUNDARY IS THE ONE `Push`, NOT THE EARLIER WORK. A body that threw while CREATING or
  // FILLING the table provably dispatched nothing, so its refusal is a KNOWN class with the slot
  // RELEASED; a body that threw out of `Push` may already have applied it, so the phase has already
  // turned `POST_INSERT` and the outcome is `APPLY_UNCERTAIN` with the slot HELD and no retry.
  const created = tablesRig({ createThrows: true });
  assert.deepEqual(await created.bridge.insertTable({ data: [['а']] }), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
  assert.equal(created.doc.state.pushes, 0, 'a factory that threw never reaches the mutation');
  assert.equal(created.bridge.getState().busy, false, 'and the slot is RELEASED: nothing was inserted');
  const filled = tablesRig({ cellThrows: true });
  assert.deepEqual(await filled.bridge.insertTable({ data: [['а']] }), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
  assert.equal(filled.doc.state.pushes, 0, 'a throw BETWEEN the create and the push never reaches the mutation');
  assert.equal(filled.bridge.getState().busy, false);
  const base = tablesDocument({ tables: [tableDouble(1, 1, { initial: () => 'старая' })] });
  const calls = { pushes: 0 };
  const document = { ...base.document, Push() { calls.pushes += 1; throw new Error('СЕКРЕТ-ДОКУМЕНТА'); } };
  const threw = tablesRig({ document });
  assert.deepEqual(await threw.bridge.insertTable({ data: [['Новое']] }), { ok: false, code: 'APPLY_UNCERTAIN' },
    'a primitive that threw out of the mutation is the uncertain class');
  assert.equal(calls.pushes, 1);
  assert.equal(JSON.stringify(await threw.bridge.insertTable({ data: [['Ещё']] })).includes('СЕКРЕТ'), false);
  assert.equal(calls.pushes, 1, 'and the uncertain insert is never retried');
  assert.equal(threw.bridge.getState().busy, true, 'the slot is HELD: a throwing mutation may still have applied');
  assert.equal(threw.bridge.getState().writePending, true);
});

test('a document that offers ONLY the legacy primitive is refused up-front with NOTHING inserted', async () => {
  // The route `insert_blocks` must not use is not a fallback here either, and neither is a table built
  // without the measured append primitive: a document that does not expose `Push` gets the body's own
  // closed refusal, answered BEFORE any write.
  const legacy = { tables: [], pushes: 0, insertContents: 0 };
  const document = {
    GetAllTables() { return legacy.tables.slice(); },
    InsertContent(items) { legacy.insertContents += 1; for (const item of items) legacy.tables.unshift(item); return true; }
  };
  const r = tablesRig({ document });
  assert.deepEqual(await r.bridge.insertTable({ data: [['а']] }), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
  assert.equal(legacy.insertContents, 0, 'the legacy primitive is never called');
  assert.deepEqual(legacy.tables, [], 'and nothing reached the document');
  assert.equal(r.bridge.getState().busy, false, 'the slot is RELEASED: nothing was inserted');
});

test('bridge insertTable refuses an unusable baseline with a closed class and NO Push', async () => {
  // THE PRE-DISPATCH GATE. Every shape below is a document whose BASELINE cannot be established, so the
  // delta the outcome rests on can never be computed: the body answers before it inserts.
  const gated = (override, shape = [2, 2]) => {
    const base = tablesDocument({ tables: [tableDouble(shape[0], shape[1], { initial: () => 'старая' })] });
    const calls = { pushes: 0 };
    const document = { ...base.document, Push() { calls.pushes += 1; return true; }, ...override };
    return { r: tablesRig({ document }), calls };
  };
  for (const [label, override, shape] of [
    ['no GetAllTables at all', { GetAllTables: null }, [2, 2]],
    ['GetAllTables is not a function', { GetAllTables: 7 }, [2, 2]],
    ['GetAllTables answers no array', { GetAllTables: () => 7 }, [2, 2]],
    ['GetAllTables answers a fractional length', { GetAllTables: () => ({ length: 1.5 }) }, [2, 2]],
    ['no Push at all', { Push: null }, [2, 2]],
    ['no Api.CreateTable', {}, [2, 2]]
  ]) {
    const { r, calls } = gated(override, shape);
    if (label === 'no Api.CreateTable') r.api.CreateTable = null;
    const result = await r.bridge.insertTable({ data: [['а']] });
    assert.equal(result.ok, false, label);
    assert.equal(result.code, 'CAPABILITY_UNAVAILABLE', label);
    assert.equal(calls.pushes, 0, `${label}: the measured append primitive is never reached`);
    assert.equal(r.bridge.getState().busy, false, label);
  }
  // A table double whose CELL CHAIN is not the measured one is the same closed capability class, answered
  // BEFORE the one Push: the body checks every step of `GetCell(...).GetContent().GetElement(0)` — and the
  // symmetric `GetText()` the proof reads back through — as a function before it fills a cell.
  for (const [label, createTable] of [
    ['no GetCell on the created table', () => ({})],
    ['GetCell answers null', () => ({ GetCell: () => null })],
    ['GetContent is not a function', () => ({ GetCell: () => ({}) })],
    ['GetElement is not a function', () => ({ GetCell: () => ({ GetContent: () => ({}) }) })],
    ['AddText is not a function', () => ({ GetCell: () => ({ GetContent: () => ({ GetElement: () => ({ GetText: () => '' }) }) }) })],
    ['the readback GetText is not a function (the symmetric read is missing)', () => ({ GetCell: () => ({ GetContent: () => ({ GetElement: () => ({ AddText() {} }) }) }) })]
  ]) {
    const r = tablesRig({ existing: 0, createTable });
    assert.deepEqual(await r.bridge.insertTable({ data: [['а']] }), { ok: false, code: 'CAPABILITY_UNAVAILABLE' }, label);
    assert.equal(r.doc.state.pushes, 0, `${label}: never a half-filled table pushed into the document`);
    assert.equal(r.bridge.getState().busy, false, label);
  }
});

test('bridge insertTable refuses a build, a namespace or a request it cannot use, with the closed class', async () => {
  const noCommand = tablesRig({ command: false });
  assert.deepEqual(await noCommand.bridge.insertTable({ data: [['а']] }), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
  assert.deepEqual(noCommand.commands, [], 'no command is dispatched by a facade that has none');
  for (const shape of [{ omitCarrier: true }, { namespace: null }, { namespace: Object.freeze({}) },
    { namespace: Object.freeze({ scope: 'предыдущая-область' }) }]) {
    const r = tablesRig(shape);
    assert.deepEqual(await r.bridge.insertTable({ data: [['а']] }), { ok: false, code: 'CAPABILITY_UNAVAILABLE' },
      JSON.stringify(shape));
    assert.deepEqual(r.commands, [], 'nothing is dispatched when the scope cannot cross');
    assert.equal(r.bridge.getState().busy, false, 'and the slot is released');
  }
  // A request this bridge cannot interpret is refused with the closed argument class and NO SDK work: the
  // shape rules (the non-empty matrix, the rectangularity, the geometry bounds) and the two byte bounds
  // are closed preconditions, not optional refinements.
  const malformed = [undefined, null, {}, { data: [] }, { data: 'а' }, { data: ['а'] }, { data: [null] },
    { data: [[]] }, { data: [['а', 'б'], ['в']] }, { data: [['а'], ['б', 'в']] }, { data: [[7]] }, { data: [[null]] },
    { data: new Array(LIMITS.insertTableRowsMax + 1).fill(['а']) },
    { data: [new Array(LIMITS.insertTableColumnsMax + 1).fill('а')] }];
  for (const raw of malformed) {
    const r = tablesRig({ existing: 0 });
    const result = await r.bridge.insertTable(raw);
    assert.equal(result.ok, false, JSON.stringify(raw));
    assert.equal(result.code, 'TOOL_ERROR', JSON.stringify(raw));
    assert.deepEqual(r.commands, [], JSON.stringify(raw));
    assert.equal(r.bridge.getState().busy, false, JSON.stringify(raw));
  }
  for (const raw of [{ data: [['я'.repeat(LIMITS.insertTableCellBytes)]] },
    { data: new Array(3).fill(new Array(3).fill('я'.repeat(LIMITS.insertTableCellBytes / 2))) }]) {
    const r = tablesRig({ existing: 0 });
    const result = await r.bridge.insertTable(raw);
    assert.equal(result.code, 'BYTE_LIMIT', JSON.stringify(raw));
    assert.deepEqual(r.commands, []);
    assert.equal(r.bridge.getState().busy, false);
  }
  // Exactly at both byte bounds is served, so the bound is a boundary and not an off-by-one.
  const atCell = tablesRig({ existing: 0 });
  assert.equal((await atCell.bridge.insertTable({ data: [['я'.repeat(LIMITS.insertTableCellBytes / 2)]] })).ok, true,
    'one cell of exactly insertTableCellBytes is served');
  const controller = new AbortController();
  controller.abort();
  const aborted = tablesRig();
  assert.deepEqual(await aborted.bridge.insertTable({ data: [['а']], signal: controller.signal }),
    { ok: false, code: 'CANCELLED' });
  assert.deepEqual(aborted.commands, [], 'a pre-aborted signal never reaches the editor');
  assert.equal(aborted.bridge.getState().busy, false);
});

test('bridge insertTable decodes ONLY the authored shapes and never publishes a malformed native answer', async () => {
  const poisoned = (raw) => {
    const plugin = { info: { editorType: 'word' }, callCommand: (_body, _close, _recalculate, callback) => { callback(raw); return false; } };
    return bridgeWith(plugin, { editorType: 'word', ascNamespace: { scope: undefined }, clock: { now: () => 0 },
      timers: { schedule() { return {}; }, clear() {} } });
  };
  // THE PHASE IS AN EXPLICIT SLOT, and these rows pin the protocol in both directions:
  //   * a TWO-slot answer whose first slot is the PRE-insert phase is a KNOWN refusal — the one name the
  //     body emits only from its pre-insert half keeps its closed class, and the slot is released;
  //   * a ONE-slot name (the forgery, phase ABSENT), a POST-insert phase, a phase-marked name that does
  //     not belong to that phase, and every other uninterpretable answer are the UNCERTAIN class with the
  //     slot HELD, because the command body ran and the document may already hold the insert.
  // The matrix is 1×1, so the authored measurement is `[POST_INSERT, tablesBefore, tablesAfter, flag]`.
  const table = [
    [['PRE_INSERT', 'CAPABILITY_UNAVAILABLE'], 'CAPABILITY_UNAVAILABLE', false],
    [['POST_INSERT', 'APPLY_UNCERTAIN'], 'APPLY_UNCERTAIN', true],
    [['POST_INSERT', 'CAPABILITY_UNAVAILABLE'], 'APPLY_UNCERTAIN', true],
    [['PRE_INSERT', 'APPLY_UNCERTAIN'], 'APPLY_UNCERTAIN', true],
    [['PRE_INSERT', 'НЕИЗВЕСТНЫЙ-СЕНТИНЕЛ'], 'APPLY_UNCERTAIN', true],
    [['CAPABILITY_UNAVAILABLE'], 'APPLY_UNCERTAIN', true],
    [['НЕИЗВЕСТНЫЙ-СЕНТИНЕЛ'], 'APPLY_UNCERTAIN', true],
    [null, 'APPLY_UNCERTAIN', true], [undefined, 'APPLY_UNCERTAIN', true], [7, 'APPLY_UNCERTAIN', true],
    ['текст', 'APPLY_UNCERTAIN', true], [{}, 'APPLY_UNCERTAIN', true], [[true], 'APPLY_UNCERTAIN', true],
    [[], 'APPLY_UNCERTAIN', true], [[1], 'APPLY_UNCERTAIN', true],
    [[1, 2, 1], 'APPLY_UNCERTAIN', true],
    [['POST_INSERT', 1, 2], 'APPLY_UNCERTAIN', true],
    [['POST_INSERT', 1, 2, 1, 1], 'APPLY_UNCERTAIN', true],
    [['POST_INSERT', 1, 1, 1], 'APPLY_UNCERTAIN', true],
    [['POST_INSERT', 1.5, 2, 1], 'APPLY_UNCERTAIN', true],
    [['POST_INSERT', -1, 2, 1], 'APPLY_UNCERTAIN', true],
    [['POST_INSERT', '1', 2, 1], 'APPLY_UNCERTAIN', true],
    [['POST_INSERT', 1, 2, 2], 'APPLY_UNCERTAIN', true],
    [['POST_INSERT', 1, 2, 'я'.repeat(40000)], 'APPLY_UNCERTAIN', true]
  ];
  for (const [raw, code, held] of table) {
    const result = await poisoned(raw).insertTable({ data: [['а']] });
    assert.equal(result.ok, false, JSON.stringify(raw));
    assert.equal(result.code, code, JSON.stringify(raw));
    assert.equal(JSON.stringify(result).includes('НЕИЗВЕСТНЫЙ'), false, 'no native text leaks through a refusal');
  }
  for (const [raw, code, held] of table) {
    const bridge = poisoned(raw);
    await bridge.insertTable({ data: [['а']] });
    const state = bridge.getState();
    assert.equal(state.busy, held, `busy for ${JSON.stringify(raw)}`);
    assert.equal(state.writePending, held, `writePending for ${JSON.stringify(raw)}`);
  }
  // The authored MEASUREMENT is the one shape that publishes, and it publishes exactly the decoded delta.
  assert.deepEqual(await poisoned(['POST_INSERT', 4, 5, 1]).insertTable({ data: [['а']] }),
    { ok: true, tablesBefore: 4, tablesAfter: 5, present: [true] });
  // The same answer is UNCERTAIN for a matrix whose cell flag is 0: the expected proof is derived from the
  // REQUEST, never from the answer.
  assert.equal((await poisoned(['POST_INSERT', 4, 5, 0]).insertTable({ data: [['а']] })).code, 'APPLY_UNCERTAIN');
  // And the flag count is pinned to the SAME matrix the ticket carried: a 2×2 ticket cannot be answered by
  // a one-flag answer.
  assert.equal((await poisoned(['POST_INSERT', 4, 5, 1]).insertTable({ data: [['а', 'б'], ['в', 'г']] })).code, 'APPLY_UNCERTAIN');
});

test('the refusal PHASE is explicit in the table protocol: a forged one-slot sentinel answered after a real insert is uncertain', async () => {
  // THE SAME FORGERY `insert_blocks` was caught by (§13.1), on the table body: the body flips the phase
  // immediately before the one `Push`, so a phase-less answer cannot release a slot for an insert that may
  // already be in the document. Every rig below evaluates the REAL body — one real insert — and then hands
  // the bridge the forged answer in its place.
  for (const forged of [['CAPABILITY_UNAVAILABLE'], ['APPLY_UNCERTAIN'], ['НЕИЗВЕСТНЫЙ-СЕНТИНЕЛ']]) {
    const r = tablesRig({ existing: 1, forge: forged });
    const result = await r.bridge.insertTable({ data: [['Глава']] });
    assert.equal(r.doc.state.pushes, 1, `${JSON.stringify(forged)}: the body really inserted before the answer`);
    assert.equal(result.ok, false, JSON.stringify(forged));
    assert.equal(result.code, 'APPLY_UNCERTAIN',
      `${JSON.stringify(forged)}: a phase that cannot be confirmed as PRE-insert is POST-insert`);
    const state = r.bridge.getState();
    assert.equal(state.busy, true, JSON.stringify(forged));
    assert.equal(state.uncertain, true, JSON.stringify(forged));
    assert.equal(state.writePending, true, `${JSON.stringify(forged)}: the write lock stays engaged`);
    assert.deepEqual(await r.bridge.insertTable({ data: [['Ещё']] }), { ok: false, code: 'EDITOR_BUSY' },
      `${JSON.stringify(forged)}: no retry of the insert`);
    assert.equal(r.commands.length, 1, `${JSON.stringify(forged)}: and the refused call dispatched nothing`);
  }
  // THE GENUINE PRE-INSERT REFUSALS ARE UNCHANGED: the body answers them BEFORE the one mutation, with the
  // pre-insert phase, so the one name keeps its KNOWN class with the slot RELEASED and ZERO `Push`.
  const baseline = tablesRig({ document: { ...tablesDocument().document, GetAllTables: null } });
  assert.deepEqual(await baseline.bridge.insertTable({ data: [['а']] }), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
  assert.equal(baseline.doc.state.pushes, 0, 'an unusable baseline never reaches the mutation');
  assert.equal(baseline.bridge.getState().busy, false, 'and the slot is RELEASED: nothing was inserted');
  // A PHASE-MARKED answer that names a pre-insert class from the POST-insert half is still not a known
  // refusal: only the PRE-insert phase makes that name known.
  const postNamed = tablesRig({ existing: 1, forge: ['POST_INSERT', 'CAPABILITY_UNAVAILABLE'] });
  assert.equal((await postNamed.bridge.insertTable({ data: [['а']] })).code, 'APPLY_UNCERTAIN');
  assert.equal(postNamed.bridge.getState().busy, true);
});

test('insert_table is offered with policy auto and a model call inserts exactly one table', async () => {
  const r = tablesRig();
  const registry = createRegistry(createWordTools(r.bridge));
  const catalogue = registry.catalogue({ editor: 'word', capabilities: ['document.read', 'document.write'], mode: 'EDIT' });
  const offered = catalogue.find(entry => entry.name === 'insert_table');
  assert.ok(offered, 'the offered catalogue contains insert_table');
  assert.equal(offered.policy, 'auto');
  assert.equal(offered.kind, 'mutate');
  assert.equal(offered.requires.includes('document.write'), true);
  assert.equal(offered.schema.properties.data.maxItems, LIMITS.insertTableRowsMax);
  const batch = validateBatch(catalogue, [{ tool: 'insert_table', arguments: { data: [['Заголовок', 'Значение']] } }]);
  assert.equal(batch.length, 1);
  assert.equal(batch[0].descriptor.name, 'insert_table');
  const responses = ['{"type":"tool_calls","calls":[{"tool":"insert_table","arguments":{"data":[["Заголовок","Значение"]]}}]}',
    '{"type":"final","message":"таблица вставлена"}'];
  const crossed = [];
  let step = 0;
  const run = await runAgent({ registry, editor: 'word', capabilities: ['document.read', 'document.write'], mode: 'EDIT',
    settings: {}, uuid: '99999999-9999-4999-8999-999999999999', request: 'добавь таблицу в конец',
    transport: async (messages) => { crossed.push(messages.map(message => message.content)); return { content: responses[step++] ?? responses[responses.length - 1] }; } });
  assert.equal(run.status, 'FINAL');
  assert.deepEqual(run.actions.map(action => [action.tool, action.outcome]), [['insert_table', 'ok']]);
  assert.equal(r.commands.length, 1, 'one command for the whole run, and no read/write path touched');
  assert.equal(r.doc.state.pushes, 1, 'the one table of the call became exactly one Push, at the END');
  assert.deepEqual(tableTexts(r.doc.state.tables[1]), [['Заголовок', 'Значение']]);
  assert.equal(r.bridge.getState().busy, false);
  assert.equal(r.bridge.getState().writePending, false);
  // The model really RECEIVES the measured delta through the runtime's own per-result serialization.
  const toolResults = crossed.flat().filter(content => content.includes('"type":"tool_results"'));
  assert.equal(toolResults.length, 1, 'one tool-result message crossed to the model');
  const published = JSON.parse(toolResults[0]).results[0];
  assert.equal(published.tool, 'insert_table');
  assert.equal(published.ok, true);
  assert.deepEqual(published.data, { rows: 1, columns: 2, tablesBefore: 1, tablesAfter: 2,
    bytes: utf8ByteLength('Заголовок') + utf8ByteLength('Значение') },
  'the tool publishes the five fields it names; the two counts are the ones the bridge measured');
});


// --- Sprint 3, tool 7: `set_heading` — the THIRD MUTATION, and the FIRST one that appends NOTHING ---
//
// This leg changes an EXISTING paragraph IN PLACE, so it shares the machinery §13/§13.2/§14 hardened —
// a pre-dispatch baseline, ONE authored static command body that builds the `Api` facade itself, the
// model data carried as `Asc.scope` DATA, an explicit PRE_INSERT/POST_INSERT phase slot, a post read and
// an outcome that is `ok` ONLY on an exact proof — and it differs in exactly the things a STYLE
// ASSIGNMENT differs in: the ONE mutating call is `paragraph.SetStyle(style)` (no `Push`, no
// `InsertContent`, which §13.2 measured to land at the START and to REPLACE existing text under a
// selection), the paragraph count is an INVARIANT rather than a delta, and the proof is about the
// ADDRESSED paragraph rather than about the append region.
//
// THE STYLE READBACK IS A HYPOTHESIS THE TESTS PIN IN BOTH DIRECTIONS. The public `ApiParaPr` that
// `paragraph.GetParaPr()` returns registers `GetStyle`, so the target's own style is LIKELY readable as
// `paragraph.GetParaPr().GetStyle()` — but that exact call was NOT measured, so the authored body
// attempts it behind `typeof` checks inside its own `try` and reports what happened in a SEPARATE flag.
// The rigs below therefore cover all three states: the readback WORKS and matches (the strongest proof),
// the readback WORKS and does NOT match (a non-success, however good the counts look), and the readback
// is ABSENT or THROWS (the proof falls back to the measured signals and the result SAYS so with
// `styleRead: false` instead of assuming an identity it never read).
function headingTool(bridge) { return createWordTools(bridge).find(entry => entry.name === 'set_heading'); }
// A bridge double whose `setHeading` records the ONE request and answers a supplied envelope. The
// envelopes are built from the same fields the REAL bridge publishes, so a handler check that passes here
// is a check the real decoder's shape satisfies.
function headingBridge(answer, extras = {}) {
  const seen = [];
  return { seen, setHeading: async (args) => { seen.push(args); return typeof answer === 'function' ? answer(args) : answer; }, ...extras };
}
// The envelope the REAL bridge publishes for a style assignment on paragraph `paragraph`: the two heading
// counts the delta was decided on and the body's own four flags.
function headingAssigned(headingsBefore, overrides = {}) {
  return { ok: true, styleName: 'Heading 1', headingsBefore, headingsAfter: headingsBefore + 1, targetAdded: true,
    textUnchanged: true, styleRead: true, styleMatches: true, ...overrides };
}
function headingDocument({ texts = ['первый абзац', 'второй абзац'], headingIndexes = [], styles = true,
  apply = true, restyle = null, grow = 1, concurrent = null, noParaPr = false, paraPrThrows = false } = {}) {
  const state = { styleNames: [], styles: [], pushes: 0, pushed: [], insertContents: 0, setStyles: 0 };
  let resolved = null;
  let dispatches = 0;
  // THE STYLE OBJECT OF A NAME is one object per name, so a paragraph that carries `Heading 2` is
  // recognised by the same `GetName()` the style readback compares against.
  function styleFor(name) { return { GetName() { return name; } }; }
  const doubles = texts.map(text => ({
    text,
    style: null,
    // THE MUTATING PRIMITIVE THE BODY ACTUALLY CALLS, on the paragraph it ADDRESSED — measured on the
    // target and asserted by this file's own self-contained-body test. The style really lands here, so the
    // heading list below is DERIVED from the paragraphs that carry one and the double is told NOTHING about
    // a request. `state.setStyles` counts DISPATCHES, not calls: a run that styles two paragraphs (the
    // `grow:2` fault) must still show ONE dispatch, which is the property the tests assert.
    SetStyle(style) {
      const call = dispatches + 1;
      dispatches = call;
      state.setStyles = call;
      state.styles.push(style);
      if (concurrent !== null && this.text !== concurrent) this.text = concurrent;
      if (apply && restyle === null) {
        this.style = style === null || style === undefined ? null : style.GetName();
        for (let round = 1; round < grow; round += 1) {
          const extra = doubles[round % doubles.length];
          extra.style = style === null || style === undefined ? null : style.GetName();
        }
      }
      if (restyle === 'other' && doubles[1] !== undefined) doubles[1].style = style === null || style === undefined ? null : style.GetName();
    },
    GetText() { return this.text; }
  }));
  for (const index of headingIndexes) doubles[index].style = `Heading ${index + 1}`;
  for (const double of doubles) {
    if (noParaPr) continue;
    if (paraPrThrows) double.GetParaPr = () => { throw new Error('СЕКРЕТ-ДОКУМЕНТА'); };
    else double.GetParaPr = function () { const self = this; return { GetStyle() { return self.style; } }; };
  }
  // THE HEADING LIST IS DERIVED FROM THE PARAGRAPHS THAT CARRY A HEADING STYLE, exactly as the real editor
  // reports it: the double is told NOTHING about a request, so every count the body measures is the
  // document's own.
  const headingDoubles = () => doubles.filter(double => double.style !== null);
  return { state, doubles, document: {
    GetAllParagraphs() { return doubles.slice(); },
    GetAllHeadingParagraphs() { return headingDoubles().map(double => ({ GetText() { return double.text; } })); },
    GetStyle(name) { state.styleNames.push(name); resolved = styles ? styleFor(name) : null; return resolved; },
    // THE DOCUMENT-LEVEL MUTATING PRIMITIVE IS OFFERED AND NEVER TAKEN. The measured route is
    // `paragraph.SetStyle(style)` — asserted by the self-contained-body test below — so this remains a
    // trap that records any call rather than the route this leg uses. It is deliberately NOT the fault
    // injector: every `apply`/`restyle`/`grow`/`concurrent` case is modelled on the ADDRESSED PARAGRAPH's
    // own `SetStyle` above, which is the method the authored body really reaches.
    SetStyle() { state.documentSetStyles = (state.documentSetStyles ?? 0) + 1; return true; },
    Push(item) { state.pushes += 1; state.pushed.push(item); },
    InsertContent(items) { state.insertContents += 1; for (const item of items) doubles.push(item); }
  } };
}
// The IN-EDITOR rig for this leg, exactly the carriage `blocksRig`/`tablesRig` reproduce: the vendor
// wrapper reads `Asc.scope` SYNCHRONOUSLY, hands the body that value, and evaluates the body the way the
// EDITOR does — in a fresh, module-free scope whose only bindings are `Api` and `scope`. `forge` hands the
// bridge a REPLACEMENT for the answer the body really produced, AFTER that body ran to completion against
// the document double — a real `SetStyle` included — which is the only way to model a hostile or damaged
// native answer for a dispatched write without weakening the body itself. A CONCURRENT EDIT (the window a
// stale index lives in) is modelled by `override` wrapping `GetAllParagraphs` so the array the body reads
// already carries a paragraph whose text is not the one the caller addressed, on the SAME state object.
function headingRig(options = {}) {
  const commands = [];
  const measured = headingDocument(options);
  // `override` replaces ONE method on the SAME document double the assertions inspect, so a test that
  // models an unusable primitive or a concurrent edit still reads the state of the document it drove.
  const document = options.override === undefined ? measured.document : { ...measured.document, ...options.override };
  const api = { GetDocument: () => document };
  const plugin = { info: { editorType: 'word' },
    callCommand: options.command === false ? undefined : function (body, close, recalculate, callback) {
      const source = Function.prototype.toString.call(body);
      // THE SCOPE IS READ FROM THE NAMESPACE THE BRIDGE WROTE IT INTO — synchronously, exactly as the
      // vendor wrapper does — and NOT from `options.namespace`, because a rig with no explicit carrier
      // builds its own empty one and the request never reaches `options`.
      const scope = carrier.scope;
      const answered = new Function('Api', 'scope', 'return (' + source + ')();')(api, scope);
      commands.push({ by: 'callCommand', body, source, close, recalculate, scope, answered });
      callback(options.forge === undefined ? answered : options.forge);
      return false;
    } };
  // The default carrier starts EMPTY, exactly like a page whose `Asc.scope` the bridge has not written
  // yet: the vendor wrapper reads `Asc.scope` SYNCHRONOUSLY from the namespace the bridge wrote the request
  // into, so a carrier that already held an object would be reading a value the dispatch did not put there.
  // A test that wants the body to SEE an uninterpretable scope passes one explicitly.
  const carrier = options.namespace ?? { scope: {} };
  const bridgeOptions = { editorType: 'word', clock: { now: () => 0 }, timers: { schedule() { return {}; }, clear() {} } };
  if (options.omitCarrier !== true) bridgeOptions.ascNamespace = carrier;
  const bridge = bridgeWith(plugin, bridgeOptions);
  return { bridge, plugin, commands, namespace: carrier, api, doc: measured };
}

test('set_heading advertises the closed bounded schema and the two bounds it names', () => {
  const tool = headingTool(headingBridge(headingAssigned(3)));
  assert.equal(tool.name, 'set_heading');
  assert.equal(tool.kind, 'mutate');
  assert.deepEqual([...tool.editors], ['word']);
  assert.equal(tool.policy, 'auto');
  assert.deepEqual([...tool.requires], ['document.write']);
  const schema = tool.schema;
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['paragraph', 'level']);
  // The CLOSED property set: there is no `text` and no `style` argument, because this tool changes the
  // style of a paragraph the document already holds and a caller-supplied style name would address a name
  // this module never measured.
  assert.deepEqual(Object.keys(schema.properties), ['paragraph', 'level']);
  assert.equal(schema.properties.paragraph.type, 'integer');
  assert.equal(schema.properties.paragraph.minimum, 0);
  assert.equal(schema.properties.paragraph.maximum, LIMITS.setHeadingIndexMax);
  assert.equal(schema.properties.level.type, 'integer');
  assert.equal(schema.properties.level.minimum, 1);
  assert.equal(schema.properties.level.maximum, LIMITS.insertHeadingMax);
  // The bounds are pinned as NUMBERS and as DISTINCT quantities: the index bound is not an alias of the
  // level bound, of the block/table caps, or of the module's read-time index bound.
  assert.equal(LIMITS.setHeadingIndexMax, 128);
  assert.equal(LIMITS.insertHeadingMax, 9);
  assert.notEqual(LIMITS.setHeadingIndexMax, LIMITS.insertHeadingMax, 'an index is not a level');
  assert.notEqual(LIMITS.setHeadingIndexMax, LIMITS.insertBlocksMax, 'an index is not a block count');
  assert.notEqual(LIMITS.setHeadingIndexMax, LIMITS.insertTableRowsMax, 'an index is not a row count');
  assert.equal(validateArguments(schema, { paragraph: 0, level: 1 }).paragraph, 0);
});

test('set_heading refuses every illegal argument with nothing dispatched, at the schema or in the handler', async () => {
  const illegal = [
    ['no argument object', null], ['missing paragraph', { level: 1 }], ['missing level', { paragraph: 0 }],
    ['an unknown key', { paragraph: 0, level: 1, style: 'Heading 1' }],
    ['a text key (this tool takes no text)', { paragraph: 0, level: 1, text: 'а' }],
    ['a non-integer paragraph', { paragraph: 1.5, level: 1 }],
    ['a stringified paragraph', { paragraph: '0', level: 1 }],
    ['a negative paragraph', { paragraph: -1, level: 1 }],
    ['an index over the advertised cap', { paragraph: LIMITS.setHeadingIndexMax + 1, level: 1 }],
    ['a non-integer level', { level: 1.5, paragraph: 0 }], ['a stringified level', { paragraph: 0, level: '1' }],
    ['level 0 (outside the heading family)', { paragraph: 0, level: 0 }],
    ['a level over the heading family', { paragraph: 0, level: LIMITS.insertHeadingMax + 1 }],
    ['a negative level', { paragraph: 0, level: -1 }], ['a boolean level', { paragraph: 0, level: true }]
  ];
  for (const [label, args] of illegal) {
    const bridge = headingBridge(headingAssigned(3));
    const tool = headingTool(bridge);
    let schemaRefused = false;
    try { validateArguments(tool.schema, args); }
    catch (error) { schemaRefused = true; assert.equal(error.code, 'TOOL_ERROR', label); }
    if (!schemaRefused) {
      const result = await tool.execute(args, { editor: 'word' });
      assert.equal(result.ok, false, label);
      assert.equal(result.code, 'TOOL_ERROR', label);
      assert.equal(result.data, undefined, label);
    }
    assert.deepEqual(bridge.seen, [], `${label}: nothing is dispatched for an illegal argument`);
  }
  // THE STYLE RESOLUTION HAPPENS BEFORE THE MUTATION, so an unresolvable `Heading <n>` is the closed
  // argument class with ZERO writes — and the body's own style resolution is exercised for every level of
  // the family, so a level that mapped to a name the document does not define can never be an unstyled
  // paragraph reported as a heading.
  const r = headingRig({ styles: false, namespace: { scope: { paragraph: 0, level: 1, styleName: 'Heading 1' } } });
  assert.deepEqual(await r.bridge.setHeading({ paragraph: 0, level: 1, styleName: 'Heading 1' }),
    { ok: false, code: 'TOOL_ERROR' });
  assert.equal(r.doc.state.setStyles, 0, 'an unresolvable style never reaches the one SetStyle');
  assert.equal(r.bridge.getState().busy, false, 'and the slot is RELEASED: nothing was styled');
});

test('set_heading assigns the style through exactly ONE bridge call and publishes the measured proof', async () => {
  const bridge = headingBridge(headingAssigned(3, { styleName: 'Heading 2' }));
  const controller = new AbortController();
  const result = await headingTool(bridge).execute({ paragraph: 2, level: 2 }, { editor: 'word', signal: controller.signal });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { paragraph: 2, level: 2, heading: true, headingsBefore: 3, headingsAfter: 4,
    styleRead: true, styleMatches: true, bytes: utf8ByteLength('2:2:Heading 2') });
  assert.deepEqual(Object.keys(result.data),
    ['paragraph', 'level', 'heading', 'headingsBefore', 'headingsAfter', 'styleRead', 'styleMatches', 'bytes'],
    'the eight measured fields and nothing else: an envelope cannot smuggle a field into the entry');
  assert.equal(bridge.seen.length, 1, 'EXACTLY one bridge call: the assignment is dispatched once and never retried');
  assert.deepEqual(bridge.seen[0], { paragraph: 2, level: 2, styleName: 'Heading 2', signal: controller.signal });
  assert.equal(bridge.seen[0].signal, controller.signal, 'the caller\'s signal crosses so a Stop cancels before the dispatch');
  // `bytes` is the DISPATCHED payload's own size — the three values that cross to the editor, under the
  // same `paragraph:level:styleName` form the handler measured — never the result's own size.
  assert.equal(utf8ByteLength('2:2:Heading 2'), 13);
});

test('set_heading publishes ok ONLY for the exact proof, and never retries otherwise', async () => {
  // THE PROOF'S LEGS, broken ONE AT A TIME. Every envelope below is one a damaged or hostile native could
  // hand back, and none of them may become an `ok`.
  const wrong = [
    ['the heading count did not move', headingAssigned(3, { headingsAfter: 3 })],
    ['two headings arrived', headingAssigned(3, { headingsAfter: 5 })],
    ['the document lost headings', headingAssigned(3, { headingsAfter: 2 })],
    ['the target paragraph did not join the heading list', headingAssigned(3, { targetAdded: false })],
    ['the target paragraph\'s TEXT changed', headingAssigned(3, { textUnchanged: false })],
    ['a heading count that SHRANK by one', headingAssigned(3, { headingsAfter: 2 })]
  ];
  const run = async (answer, request = { paragraph: 1, level: 1 }) => {
    const bridge = headingBridge(answer);
    return { result: await headingTool(bridge).execute(request, { editor: 'word' }), bridge };
  };
  const verified = await run(headingAssigned(3));
  assert.equal(verified.result.ok, true);
  assert.equal(verified.bridge.seen.length, 1);
  for (const [label, answer] of wrong) {
    const { result, bridge } = await run(answer);
    assert.equal(result.ok, false, label);
    assert.equal(result.code, 'TOOL_UNCERTAIN', label);
    assert.equal(result.message, 'отказ', label);
    assert.equal(result.data, undefined, `${label}: an uncertain outcome publishes no proof`);
    assert.equal(bridge.seen.length, 1, `${label}: NO retry — the assignment was dispatched exactly once`);
  }
  // A PROOF WHOSE COUNT ITSELF IS NOT A COUNT is the unknown envelope class, checked before any flag: a
  // fractional, negative or unsafe count is not one this bridge's decoder can publish, so there is nothing
  // about a mutation to judge here either.
  for (const [label, answer] of [
    ['a count that is not a safe integer', headingAssigned(3, { headingsAfter: Number.MAX_SAFE_INTEGER + 2 })],
    ['a count below zero', headingAssigned(3, { headingsAfter: -1 })],
    ['a fractional count', headingAssigned(3, { headingsAfter: 3.5 })]
  ]) {
    const { result, bridge } = await run(answer);
    assert.equal(result.code, 'TOOL_ERROR', label);
    assert.equal(bridge.seen.length, 1, `${label}: the call was still dispatched exactly once`);
  }
  // A READBACK THAT DOES NOT MATCH IS A NON-SUCCESS even when every count looks perfect; a readback that was
  // NOT AVAILABLE is not: the proof falls back to the measured signals and SAYS so in the result.
  const blind = await run(headingAssigned(3, { styleRead: false, styleMatches: false }));
  assert.equal(blind.result.ok, true, 'without a readback the measured signals carry the proof');
  assert.deepEqual([blind.result.data.styleRead, blind.result.data.styleMatches], [false, false],
    'and the result states that no identity was established rather than inventing one');
  // AND THE HANDLER REFUTES A CONTRADICTION IT CAN SEE FOR ITSELF: an `ok` envelope whose readable
  // readback says the addressed paragraph carries a DIFFERENT style is never published as a verified
  // assignment, because the tool would be reporting a request it can prove was not applied.
  const contradicted = await run(headingAssigned(3, { styleMatches: false }), { paragraph: 1, level: 1 });
  assert.equal(contradicted.result.ok, false);
  // The BRIDGE never publishes this shape at all — `exactHeadingDelta` turns `styleRead && !styleMatches`
  // into `APPLY_UNCERTAIN` with the slot held, which the real-bridge test below drives — so this is the
  // handler's own closed refutation of a forged envelope, not a state the tool can reach.
  assert.equal(contradicted.result.code, 'TOOL_UNCERTAIN',
    'the bridge only publishes ok when the readable style MATCHES, so an ok that says it does not is not a verified assignment');
});

test('set_heading refuses an unusable baseline, an index outside the document and an unresolvable style with ZERO writes', async () => {
  const withRequest = (rig) => rig.bridge.setHeading({ paragraph: 1, level: 1, styleName: 'Heading 1' });
  // An index OUTSIDE this document is the closed argument class with nothing styled: the body checks it
  // against the array it read, not against the schema's advertised cap.
  const outside = headingRig({ namespace: { scope: { paragraph: 5, level: 1, styleName: 'Heading 1' } } });
  assert.deepEqual(await outside.bridge.setHeading({ paragraph: 5, level: 1, styleName: 'Heading 1' }),
    { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
  assert.equal(outside.doc.state.setStyles, 0, 'an index outside the document never reaches SetStyle');
  assert.equal(outside.doc.state.styleNames.length, 0, 'and the style is not even resolved');
  assert.equal(outside.bridge.getState().busy, false, 'the slot is RELEASED: nothing was styled');
  // A baseline that cannot be read is the same closed class with ZERO writes — no baseline means no delta
  // means no evidence means no write.
  const baseline = headingRig({ override: { GetAllParagraphs: null } });
  assert.deepEqual(await withRequest(baseline), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
  assert.equal(baseline.doc.state.setStyles, 0);
  assert.equal(baseline.bridge.getState().busy, false);
  // An INDEX BOUNDARY is re-decided in the bridge as well as by the schema and the descriptor: a caller
  // that is not this descriptor gets the closed argument class without any SDK work at all.
  const bounded = headingRig();
  assert.deepEqual(await bounded.bridge.setHeading({ paragraph: LIMITS.setHeadingIndexMax + 1, level: 1, styleName: 'Heading 1' }),
    { ok: false, code: 'TOOL_ERROR' });
  assert.deepEqual(await bounded.bridge.setHeading({ paragraph: 0, level: LIMITS.insertHeadingMax + 1, styleName: 'Heading 10' }),
    { ok: false, code: 'TOOL_ERROR' });
  assert.deepEqual(await bounded.bridge.setHeading({ paragraph: 0, level: 1, styleName: 'Заголовок 1' }),
    { ok: false, code: 'TOOL_ERROR' },
    'the style name is CROSS-CHECKED against the level: a name that does not mean this level is refused');
  assert.equal(bounded.commands.length, 0, 'and none of those three reached the editor');
});

test('set_heading maps each level to the measured style name and never invents one', async () => {
  for (let level = 1; level <= LIMITS.insertHeadingMax; level += 1) {
    const r = headingRig({ namespace: { scope: { paragraph: 0, level, styleName: `Heading ${level}` } } });
    await r.bridge.setHeading({ paragraph: 0, level, styleName: `Heading ${level}` });
    assert.deepEqual(r.doc.state.styleNames, [`Heading ${level}`], `level ${level} resolves the measured name`);
  }
});

test('set_heading refuses a non-Word editor and a bridge that cannot serve the assignment, before any dispatch', async () => {
  // The EDITOR gate is the precondition, exactly as it is for every other descriptor in this module: the
  // handler is only reached once the registry has accepted the precondition.
  for (const editor of ['cell', 'slide', undefined, null]) {
    const tool = headingTool(headingBridge(headingAssigned(3)));
    const refused = tool.precondition({ paragraph: 0, level: 1 }, { editor });
    assert.equal(refused.code, 'CAPABILITY_UNAVAILABLE', String(editor));
    assert.equal(refused.message, 'отказ', String(editor));
    assert.equal(tool.precondition({ paragraph: 0, level: 1 }, { editor: 'word' }), null);
  }
  // The ADDRESS and LEVEL gates are the same precondition, checked before any dispatch.
  const tool = headingTool(headingBridge(headingAssigned(3)));
  for (const args of [{ paragraph: -1, level: 1 }, { paragraph: LIMITS.setHeadingIndexMax + 1, level: 1 },
    { paragraph: 0, level: 0 }, { paragraph: 0, level: LIMITS.insertHeadingMax + 1 }, { level: 1 }]) {
    assert.equal(tool.precondition(args, { editor: 'word' }).code, 'TOOL_ERROR', JSON.stringify(args));
  }
  const missing = headingTool({});
  const result = await missing.execute({ paragraph: 0, level: 1 }, { editor: 'word' });
  assert.equal(result.code, 'CAPABILITY_UNAVAILABLE', 'a bridge with no entry point is a capability refusal');
});

test('set_heading republishes the closed class the bridge reported and maps uncertainty to TOOL_UNCERTAIN', async () => {
  const refused = headingBridge({ ok: false, code: 'CAPABILITY_UNAVAILABLE' });
  assert.deepEqual(await headingTool(refused).execute({ paragraph: 0, level: 1 }, { editor: 'word' }),
    { ok: false, code: 'CAPABILITY_UNAVAILABLE', message: 'отказ' });
  const returned = headingBridge({ ok: false, code: 'APPLY_UNCERTAIN' });
  assert.deepEqual(await headingTool(returned).execute({ paragraph: 0, level: 1 }, { editor: 'word' }),
    { ok: false, code: 'TOOL_UNCERTAIN', message: 'отказ' });
  const thrown = headingBridge(null, { setHeading: async () => { throw Object.assign(new Error('x'), { code: 'APPLY_UNCERTAIN' }); } });
  assert.deepEqual(await headingTool(thrown).execute({ paragraph: 0, level: 1 }, { editor: 'word' }),
    { ok: false, code: 'TOOL_UNCERTAIN', message: 'отказ' });
  const broken = headingBridge(null, { setHeading: async () => { throw Object.assign(new Error('СЕКРЕТ'), { code: 'EDITOR_ERROR' }); } });
  const failed = await headingTool(broken).execute({ paragraph: 0, level: 1 }, { editor: 'word' });
  assert.equal(failed.code, 'EDITOR_ERROR');
  assert.equal(JSON.stringify(failed).includes('СЕКРЕТ'), false, 'no raw exception text crosses');
  const envelope = headingBridge({ ok: true, headingsBefore: 3 });
  assert.equal((await headingTool(envelope).execute({ paragraph: 0, level: 1 }, { editor: 'word' })).code, 'TOOL_ERROR',
    'an uninterpretable envelope is the module\'s unknown convention');
  // A FORGED ENVELOPE WITH THE WRONG FIELD TYPES is that same unknown class, never an uncertain write: a
  // bridge cannot have produced these shapes, so nothing about a mutation is being judged here.
  for (const [label, answer] of [
    ['a non-boolean target flag', headingAssigned(3, { targetAdded: 'true' })],
    ['a non-boolean style readback flag', headingAssigned(3, { styleRead: 'yes' })],
    ['a missing text flag', { ok: true, headingsBefore: 3, headingsAfter: 4, targetAdded: true, styleRead: true }],
    ['a missing style readback flag', { ok: true, headingsBefore: 3, headingsAfter: 4, targetAdded: true, textUnchanged: true }],
    // THE REQUEST THE BRIDGE ANSWERED IS PART OF THE ENVELOPE. `styleName` is the one word that level
    // means; an `ok` answer whose own style name is a DIFFERENT one was produced for a request this
    // handler did not make, so it is never republished as this call's proof.
    ['a style name that is not the requested one', headingAssigned(3, { styleName: 'Heading 3' })],
    ['a missing style name', { ok: true, styleName: undefined, headingsBefore: 3, headingsAfter: 4,
      targetAdded: true, textUnchanged: true, styleRead: true, styleMatches: true }]
  ]) {
    assert.equal((await headingTool(headingBridge(answer)).execute({ paragraph: 0, level: 1 }, { editor: 'word' })).code,
      'TOOL_ERROR', label);
  }
});

test('set_heading measures the exact entry it publishes, and its bounded fields cannot reach the ceiling', async () => {
  const bridge = headingBridge(headingAssigned(7));
  const result = await headingTool(bridge).execute({ paragraph: 3, level: 3 }, { editor: 'word' });
  const entry = JSON.stringify({ tool: 'set_heading', ok: true, data: result.data });
  assert.equal(utf8ByteLength(entry) <= AGENT_CEILINGS.toolResultBytes, true, entry);
  // The WIDEST shape this handler can publish: every numeric field at its legal maximum. The measurement
  // is the module's ONE enforced bound, and this test pins that it is unreachable for eight bounded fields.
  const widestData = { paragraph: LIMITS.setHeadingIndexMax, level: LIMITS.insertHeadingMax, heading: true,
    headingsBefore: Number.MAX_SAFE_INTEGER, headingsAfter: Number.MAX_SAFE_INTEGER,
    styleRead: false, styleMatches: false, bytes: Number.MAX_SAFE_INTEGER };
  const widest = JSON.stringify({ tool: 'set_heading', ok: true, data: widestData });
  assert.equal(utf8ByteLength(widest) < AGENT_CEILINGS.toolResultBytes, true,
    `the widest publishable entry is ${utf8ByteLength(widest)} bytes`);
  // The REAL serializer the runtime applies accepts the entry it publishes, one-to-one.
  const crossed = toolResultMessages([{ tool: 'set_heading', result: { ok: true, data: widestData } }]);
  assert.equal(JSON.parse(crossed[0].content).results[0].data.paragraph, LIMITS.setHeadingIndexMax);
});

test('bridge setHeading dispatches ONE command, carries the request as DATA and verifies the exact proof', async () => {
  const namespace = { scope: 'предыдущая-область' };
  const r = headingRig({ texts: ['Ноль', 'Цель', 'Два'], headingIndexes: [0], namespace });
  const pending = r.bridge.setHeading({ paragraph: 1, level: 2, styleName: 'Heading 2' });
  assert.equal(r.commands.length, 1, 'exactly ONE command is dispatched for the whole assignment');
  const carried = r.commands[0];
  assert.equal(carried.by, 'callCommand', 'the wrapper is the entry point the measured build exposes');
  assert.equal(typeof carried.body, 'function', 'the body is handed as an authored function literal, never as text');
  assert.equal(carried.close, false, 'the documented close/recalculate arguments are unchanged');
  assert.equal(carried.recalculate, false);
  assert.deepEqual(carried.scope, { paragraph: 1, level: 2, styleName: 'Heading 2' },
    'the request crosses as the command SCOPE, never interpolated into source');
  assert.equal(namespace.scope, 'предыдущая-область', 'the namespace is restored: no request outlives its dispatch');
  assert.deepEqual(r.doc.state.styleNames, ['Heading 2'], 'the style is resolved by the name the level names');
  assert.equal(r.doc.state.setStyles, 1, 'and the ONE mutation is a single SetStyle');
  assert.equal(r.doc.state.pushes, 0, 'nothing is appended: this leg changes an EXISTING paragraph in place');
  assert.equal(r.doc.state.insertContents, 0, 'and the legacy whole-array primitive — which lands at the START — is never called');
  assert.equal(r.doc.state.documentSetStyles, undefined, 'and the DOCUMENT-level primitive is never called either');
  assert.deepEqual(carried.answered, ['POST_INSERT', 1, 2, 1, 1, 1, 1],
    'the body encodes the explicit phase slot, the two heading counts and its four flags');
  assert.deepEqual(await pending, { ok: true, styleName: 'Heading 2', headingsBefore: 1, headingsAfter: 2,
    targetAdded: true, textUnchanged: true, styleRead: true, styleMatches: true });
  // The DOCUMENT really holds the style: the double is state, not a stub. Paragraph 0 is the one the rig
  // seeded as a heading, so the paragraph the request ADDRESSED (index 1) is the one that changed.
  assert.equal(r.doc.doubles[1].style, 'Heading 2', 'the addressed paragraph carries the style the style object meant');
  assert.equal(r.doc.doubles[0].style, 'Heading 1', 'and no other paragraph was touched');
  assert.equal(r.bridge.getState().busy, false, 'the slot is released by the native callback');
  assert.equal(r.bridge.getState().writePending, false);
  assert.equal(r.bridge.getState().uncertain, false);
});

test('the heading body is self-contained: it answers the measured shapes in a fresh, module-free scope', async () => {
  const r = headingRig({ texts: ['Ноль', 'Цель'], namespace: { scope: { paragraph: 1, level: 3, styleName: 'Heading 3' } } });
  const pending = r.bridge.setHeading({ paragraph: 1, level: 3, styleName: 'Heading 3' });
  const carried = r.commands[0];
  assert.equal(/\b(?:capabilityBody|contextBody|commandTransport|createCommandDispatch|decodeBlocks|decodeSearch|decodeStructure|decodeTable|decodeHeading|exactBlocksDelta|exactTableDelta|exactHeadingDelta|preInsertRefusal|pluginOwners|createR7Bridge)\b/.test(carried.source),
    false, 'the stringified body names no module binding of bridge.js');
  assert.match(carried.source, /typeof Api !== 'undefined'/, 'and it builds the public Api facade itself');
  assert.match(withoutComments(carried.source), /SetStyle\(/, 'the ONE mutating call is SetStyle');
  assert.equal(withoutComments(carried.source).includes('InsertContent'), false, 'the legacy whole-array primitive is authored nowhere');
  assert.equal(withoutComments(carried.source).includes('Push('), false, 'and nothing is appended: this leg is not an insert');
  // The EDITOR'S own evaluation, on a FRESH document so the assertion is about the body's answer and not
  // about how many times the rig ran it. Only `Api` and `scope` are bound here, so a body that closed over
  // a module binding would raise ReferenceError exactly as it did natively on 2026.3.1.
  const fresh = headingDocument({ texts: ['Ноль', 'Цель'] });
  const freshApi = { GetDocument() { return fresh.document; } };
  const evaluated = new Function('Api', 'scope', 'return (' + carried.source + ')();')(freshApi, carried.scope);
  assert.deepEqual(evaluated, ['POST_INSERT', 0, 1, 1, 1, 1, 1],
    'the request arrived as DATA and the counts are the document\'s own');
  assert.equal(fresh.state.setStyles, 1, 'exactly one mutation, on the target the index named');
  assert.equal(fresh.doubles[1].style, 'Heading 3');
  assert.equal(fresh.doubles[0].style, null);
  assert.deepEqual((await pending).targetAdded, true);
});

test('a WRONG paragraph restyled, a target whose TEXT changed or a heading count that did not move is UNCERTAIN with the slot HELD', async () => {
  // THE THREE WAYS THE EXACT PROOF CAN FAIL ON THE MEASURED ROUTE, each driven through the REAL body
  // against a document double whose `SetStyle` really writes state:
  //   1. a route that styles the WRONG paragraph (`restyle: 'other'`) — the addressed paragraph's own style
  //      readback then does not match, and the addressed text is no longer the one that joined the list;
  for (const [label, options, request] of [
    ['a route that styled a DIFFERENT paragraph', { restyle: 'other' }, { paragraph: 0, level: 1, styleName: 'Heading 1' }],
    ['a route that styled NOTHING', { apply: false }, { paragraph: 0, level: 1, styleName: 'Heading 1' }],
    ['a route that added TWO headings', { grow: 2 }, { paragraph: 0, level: 1, styleName: 'Heading 1' }]
  ]) {
    const r = headingRig({ texts: ['Ноль', 'Цель'], namespace: { scope: request }, ...options });
    const result = await r.bridge.setHeading(request);
    assert.deepEqual(result, { ok: false, code: 'APPLY_UNCERTAIN' }, label);
    assert.equal(r.doc.state.setStyles, 1, `${label}: the mutation WAS dispatched exactly once`);
    const state = r.bridge.getState();
    assert.equal(state.busy, true, `${label}: the slot is HELD for an uncertain assignment`);
    assert.equal(state.uncertain, true, label);
    assert.equal(state.writePending, true, `${label}: and the write lock stays engaged, so no second mutation can start`);
    assert.deepEqual(await r.bridge.setHeading(request), { ok: false, code: 'EDITOR_BUSY' },
      `${label}: no retry — the held slot refuses the next assignment`);
    assert.equal(r.commands.length, 1, `${label}: and the refused call dispatches nothing at all`);
  }
  //   2. THE STALE INDEX / CONCURRENT EDIT: the paragraph the index addresses carries a text the caller
  //      never named by the time the one `SetStyle` runs — a concurrent edit above the index renumbered it.
  //      The style really lands and the heading count really moves by one, and the outcome is STILL
  //      uncertain, because the paragraph the index addresses is not the paragraph the caller meant.
  const drifted = headingRig({ texts: ['Ноль', 'Цель'], concurrent: 'ДРУГОЙ-АБЗАЦ',
    namespace: { scope: { paragraph: 0, level: 1, styleName: 'Heading 1' } } });
  assert.deepEqual(await drifted.bridge.setHeading({ paragraph: 0, level: 1, styleName: 'Heading 1' }),
    { ok: false, code: 'APPLY_UNCERTAIN' });
  assert.equal(drifted.doc.state.setStyles, 1, 'the mutation really applied — to the STALE paragraph');
  assert.deepEqual(drifted.doc.doubles.map(double => double.style), ['Heading 1', null],
    'and the heading count really moved by one: the STALE paragraph is now the document\'s only heading');
  assert.equal(drifted.bridge.getState().busy, true, 'so the slot is HELD and there is no retry');
  //   3. THE STYLE READBACK THAT IS ABSENT OR THROWS is NOT a failure: the proof rests on the measured
  //      signals and the result SAYS that no identity was established.
  for (const [label, options] of [
    ['a paragraph with no GetParaPr at all', { noParaPr: true }],
    ['a GetParaPr that THROWS', { paraPrThrows: true }]
  ]) {
    const r = headingRig({ texts: ['Ноль', 'Цель'], ...options,
      namespace: { scope: { paragraph: 1, level: 1, styleName: 'Heading 1' } } });
    const result = await r.bridge.setHeading({ paragraph: 1, level: 1, styleName: 'Heading 1' });
    assert.equal(result.ok, true, label);
    assert.equal(result.styleRead, false, `${label}: the result states that no style was read`);
    assert.equal(result.styleMatches, false, label);
    assert.equal(r.bridge.getState().busy, false, `${label}: a verified assignment releases the slot`);
  }
});

test('the refusal PHASE is explicit in the heading protocol: a phase-less sentinel answered after a real mutation is uncertain', async () => {
  // THE FORGERY THE PHASE GATE EXISTS FOR. The body flips its phase immediately before the one `SetStyle`,
  // so a forged post-mutation answer must never be read as a KNOWN refusal with the slot released.
  for (const forged of [['CAPABILITY_UNAVAILABLE'], ['STYLE_UNAVAILABLE'], ['APPLY_UNCERTAIN'], ['НЕИЗВЕСТНЫЙ-СЕНТИНЕЛ']]) {
    const r = headingRig({ texts: ['Ноль', 'Цель'], forge: forged,
      namespace: { scope: { paragraph: 0, level: 1, styleName: 'Heading 1' } } });
    const result = await r.bridge.setHeading({ paragraph: 0, level: 1, styleName: 'Heading 1' });
    assert.equal(r.doc.state.setStyles, 1, `${JSON.stringify(forged)}: the body really styled before the answer`);
    assert.equal(result.ok, false, JSON.stringify(forged));
    assert.equal(result.code, 'APPLY_UNCERTAIN',
      `${JSON.stringify(forged)}: a phase that cannot be confirmed as PRE-insert is POST-insert`);
    const state = r.bridge.getState();
    assert.equal(state.busy, true, JSON.stringify(forged));
    assert.equal(state.uncertain, true, JSON.stringify(forged));
    assert.equal(state.writePending, true, `${JSON.stringify(forged)}: the write lock stays engaged`);
    assert.deepEqual(await r.bridge.setHeading({ paragraph: 0, level: 1, styleName: 'Heading 1' }),
      { ok: false, code: 'EDITOR_BUSY' }, `${JSON.stringify(forged)}: no retry of the assignment`);
    assert.equal(r.commands.length, 1, `${JSON.stringify(forged)}: and the refused call dispatched nothing`);
  }
  // THE GENUINE PRE-INSERT REFUSALS ARE UNCHANGED: the body answers them BEFORE the one mutation, with the
  // pre-insert phase, so each keeps its KNOWN class with the slot RELEASED and ZERO `SetStyle`.
  const style = headingRig({ styles: false, namespace: { scope: { paragraph: 0, level: 1, styleName: 'Heading 1' } } });
  assert.deepEqual(await style.bridge.setHeading({ paragraph: 0, level: 1, styleName: 'Heading 1' }), { ok: false, code: 'TOOL_ERROR' });
  assert.equal(style.doc.state.setStyles, 0, 'an unresolvable style never reaches the one SetStyle');
  assert.equal(style.bridge.getState().busy, false, 'the slot is RELEASED: nothing was styled');
  // A PHASE-MARKED answer that names a pre-insert class from the POST-insert half is still not a known
  // refusal: only the PRE-insert phase makes those names known.
  const postNamed = headingRig({ texts: ['Ноль'], forge: ['POST_INSERT', 'CAPABILITY_UNAVAILABLE'],
    namespace: { scope: { paragraph: 0, level: 1, styleName: 'Heading 1' } } });
  assert.equal((await postNamed.bridge.setHeading({ paragraph: 0, level: 1, styleName: 'Heading 1' })).code, 'APPLY_UNCERTAIN');
  assert.equal(postNamed.bridge.getState().busy, true);
});

test('bridge setHeading refuses a build, a namespace or a request it cannot use, with the closed class', async () => {
  const request = { paragraph: 0, level: 1, styleName: 'Heading 1' };
  // No command wrapper at all: the parameter channel does not exist, so the refusal is made BEFORE the
  // ticket and nothing reaches the editor.
  const noCommand = headingRig({ command: false, namespace: { scope: request } });
  assert.deepEqual(await noCommand.bridge.setHeading(request), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
  assert.equal(noCommand.commands.length, 0);
  // A namespace that is not there: same class, no slot held.
  const noNamespace = headingRig({ omitCarrier: true, namespace: { scope: request } });
  assert.deepEqual(await noNamespace.bridge.setHeading(request), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
  assert.equal(noNamespace.commands.length, 0, 'nothing reached the editor');
  assert.equal(noNamespace.bridge.getState().busy, false, 'and no slot is held for work that never ran');
  // A namespace whose `scope` cannot be written: a frozen carrier is refused before the dispatch.
  const frozen = headingRig({ namespace: Object.freeze({ scope: request }) });
  assert.deepEqual(await frozen.bridge.setHeading(request), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
  assert.equal(frozen.commands.length, 0);
  assert.equal(frozen.bridge.getState().busy, false);
  // A PRE-ABORTED signal dispatches nothing at all.
  const abortedRig = headingRig({ namespace: { scope: request } });
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await abortedRig.bridge.setHeading({ ...request, signal: controller.signal }), { ok: false, code: 'CANCELLED' });
  assert.equal(abortedRig.commands.length, 0, 'an aborted caller never reaches the editor');
});

test('bridge setHeading decodes ONLY the authored shapes and never publishes a malformed native answer', async () => {
  const request = { paragraph: 0, level: 1, styleName: 'Heading 1' };
  const run = (forge) => headingRig({ texts: ['Ноль'], forge,
    namespace: { scope: request } }).bridge.setHeading(request);
  // A malformed answer is a dispatched write whose outcome cannot be interpreted: UNCERTAIN, never a known
  // error and never an `ok`.
  for (const [label, forge] of [
    ['a non-array answer', 'POST_INSERT'],
    ['a plain object answer', { phase: 'POST_INSERT' }],
    ['an answer with too few slots', ['POST_INSERT', 0, 1]],
    ['an answer with too many slots', ['POST_INSERT', 0, 1, 1, 1, 1, 1, 1]],
    ['a count that is not a safe integer', ['POST_INSERT', 0, 1.5, 1, 1, 1, 1]],
    ['a negative count', ['POST_INSERT', -1, 0, 1, 1, 1, 1]],
    ['a flag that is not 0 or 1', ['POST_INSERT', 0, 1, true, 1, 1, 1]],
    ['a flag of 2', ['POST_INSERT', 0, 1, 2, 1, 1, 1]],
    ['a PRE_INSERT phase over a measurement', ['PRE_INSERT', 0, 1, 1, 1, 1, 1]],
    ['an unknown phase', ['ПОСЛЕ', 0, 1, 1, 1, 1, 1]]
  ]) {
    const result = await run(forge);
    assert.equal(result.ok, false, label);
    assert.equal(result.code, 'APPLY_UNCERTAIN', label);
    // Every one of those is the BRIDGE's own uncertain class, whose envelope carries no message of its own:
    // nothing a native wrote reaches the model through this path.
    assert.equal(result.message, undefined, `${label}: no raw native text crosses`);
  }
  // The PRE-insert refusals keep their KNOWN classes, and only they do.
  assert.deepEqual(await run(['PRE_INSERT', 'CAPABILITY_UNAVAILABLE']), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
  assert.deepEqual(await run(['PRE_INSERT', 'STYLE_UNAVAILABLE']), { ok: false, code: 'TOOL_ERROR' });
  assert.deepEqual(await run(['PRE_INSERT', 'НЕИЗВЕСТНО']), { ok: false, code: 'APPLY_UNCERTAIN' });
});

test('set_heading is offered with policy auto and a model call assigns exactly one heading', async () => {
  const r = headingRig({ texts: ['Ноль', 'Цель', 'Два'], headingIndexes: [0] });
  const registry = createRegistry(createWordTools(r.bridge));
  const catalogue = registry.catalogue({ editor: 'word', capabilities: ['document.read', 'document.write'], mode: 'EDIT' });
  const offered = catalogue.find(entry => entry.name === 'set_heading');
  assert.ok(offered, 'the offered catalogue contains set_heading');
  assert.equal(offered.policy, 'auto');
  assert.equal(offered.kind, 'mutate');
  assert.equal(offered.requires.includes('document.write'), true);
  assert.equal(offered.schema.properties.paragraph.maximum, LIMITS.setHeadingIndexMax);
  assert.equal(offered.schema.properties.level.maximum, LIMITS.insertHeadingMax);
  // A mutation tool is NOT offered in ASK, and it needs the write capability.
  assert.equal(registry.catalogue({ editor: 'word', capabilities: ['document.read'], mode: 'EDIT' })
    .some(entry => entry.name === 'set_heading'), false, 'no write capability, no mutation tool');
  assert.equal(registry.catalogue({ editor: 'word', capabilities: ['document.read', 'document.write'], mode: 'ASK' })
    .some(entry => entry.name === 'set_heading'), false, 'ASK exposes no mutation tool');
  const batch = validateBatch(catalogue, [{ tool: 'set_heading', arguments: { paragraph: 1, level: 2 } }]);
  assert.equal(batch.length, 1);
  assert.equal(batch[0].descriptor.name, 'set_heading');
  const responses = ['{"type":"tool_calls","calls":[{"tool":"set_heading","arguments":{"paragraph":1,"level":2}}]}',
    '{"type":"final","message":"заголовок назначен"}'];
  const crossed = [];
  let step = 0;
  const run = await runAgent({ registry, editor: 'word', capabilities: ['document.read', 'document.write'], mode: 'EDIT',
    settings: {}, uuid: '12121212-1212-4121-8121-121212121212', request: 'сделай второй абзац заголовком',
    transport: async (messages) => { crossed.push(messages.map(message => message.content)); return { content: responses[step++] ?? responses[responses.length - 1] }; } });
  assert.equal(run.status, 'FINAL');
  assert.deepEqual(run.actions.map(action => [action.tool, action.outcome]), [['set_heading', 'ok']]);
  assert.equal(r.commands.length, 1, 'one command for the whole run, and no read/write path touched');
  assert.equal(r.doc.state.setStyles, 1, 'the one call became exactly ONE SetStyle, in place');
  assert.equal(r.doc.state.pushes, 0, 'and nothing was appended');
  assert.equal(r.bridge.getState().busy, false);
  assert.equal(r.bridge.getState().writePending, false);
  // The model really RECEIVES the proof through the runtime's own per-result serialization.
  const toolResults = crossed.flat().filter(content => content.includes('"type":"tool_results"'));
  assert.equal(toolResults.length, 1, 'one tool-result message crossed to the model');
  const published = JSON.parse(toolResults[0]).results[0];
  assert.equal(published.tool, 'set_heading');
  assert.equal(published.ok, true);
  assert.deepEqual(published.data, { paragraph: 1, level: 2, heading: true, headingsBefore: 1, headingsAfter: 2,
    styleRead: true, styleMatches: true, bytes: utf8ByteLength('1:2:Heading 2') },
  'the tool publishes the eight fields it names; the counts are the ones the bridge measured');
});


