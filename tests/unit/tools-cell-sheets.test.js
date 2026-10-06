// Unit coverage for `list_sheets` — the first WORKBOOK-level read (Sprint 4, T5.1).
//
// The bridge is a double here: these are host tests and are NOT native proof. What they own is the DESCRIPTOR
// contract — the closed argument class, the envelope re-check, the byte bounds, and the classification of the
// bridge's answer into a published listing, a known refusal, or the uncertain class. The DECODING of the flat
// answer and the rule that the active sheet is found by NAME/INDEX rather than by object identity are the
// bridge's own decisions and are covered through the REAL bridge in `tests/unit/bridge-sheetlist.test.js`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCellTools } from '../../src/tools/cell.js';
import { createRegistry } from '../../src/tools/registry.js';
import { AGENT_CEILINGS, LIMITS } from '../../src/shared/limits.js';
import { utf8ByteLength } from '../../src/shared/bytes.js';

const SHEETS = [
  { name: 'Свод', index: 0, active: true, visible: true },
  { name: 'Данные', index: 1, active: false, visible: false }
];
function listing(overrides = {}) {
  return { ok: true, count: SHEETS.length, activeIndex: 0, activeName: 'Свод', sheets: SHEETS, ...overrides };
}
function bridgeWith(answer) {
  const calls = { listSheets: 0 };
  return {
    calls,
    requests: [],
    async listSheets(request) {
      calls.listSheets += 1;
      this.requests.push(request);
      return typeof answer === 'function' ? answer(request) : answer;
    }
  };
}
function toolWith(bridge) { return createCellTools(bridge).find(entry => entry.name === 'list_sheets'); }
const cellCtx = { editor: 'cell' };

test('RED anchor: list_sheets exists, is a Cell read, and is offered in EDIT and ASK', () => {
  const bridge = bridgeWith(listing());
  const tool = toolWith(bridge);
  assert.ok(tool, 'list_sheets must exist');
  assert.deepEqual(tool.editors, ['cell']);
  assert.equal(tool.kind, 'read');
  assert.deepEqual(tool.requires, ['document.read']);
  const registry = createRegistry(createCellTools(bridge));
  const capabilities = ['document.read', 'document.write'];
  assert.deepEqual(registry.catalogue({ editor: 'cell', capabilities, mode: 'EDIT' }).map(e => e.name).sort(),
    ['add_sheet', 'format_cells', 'list_sheets', 'read_range', 'read_sheet', 'write_range']);
  assert.deepEqual(registry.catalogue({ editor: 'cell', capabilities, mode: 'ASK' }).map(e => e.name).sort(),
    ['list_sheets', 'read_range', 'read_sheet'], 'a read is offered to ASK as well');
});

test('a served listing dispatches ONCE and publishes every sheet with its state', async () => {
  const bridge = bridgeWith(listing());
  const result = await toolWith(bridge).execute({}, cellCtx);
  assert.equal(bridge.calls.listSheets, 1, 'exactly one dispatch');
  assert.equal(result.ok, true);
  assert.equal(result.data.count, 2);
  assert.equal(result.data.activeName, 'Свод');
  assert.equal(result.data.activeIndex, 0);
  assert.deepEqual(result.data.sheets.map(s => `${s.name}:${s.index}:${s.active}:${s.visible}`),
    ['Свод:0:true:true', 'Данные:1:false:false']);
  // The request carries NOTHING but the signal slot: this leg has no arguments.
  assert.deepEqual(bridge.requests[0], {}, 'no argument is invented for a leg that has none');
});

test('the closed argument class refuses any argument BEFORE any dispatch', async () => {
  const bridge = bridgeWith(listing());
  const tool = toolWith(bridge);
  for (const args of [{ sheet: 'Свод' }, { maxSheets: 10 }, { address: 'A1' }, { signal: undefined }]) {
    const result = await tool.execute(args, cellCtx);
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.equal(result.code, 'TOOL_ERROR', JSON.stringify(args));
  }
  assert.equal(bridge.calls.listSheets, 0, 'nothing refused ever reached the bridge');
});

test('an answer whose envelope disagrees with itself is a known refusal', async () => {
  // These are the SCALAR envelope rules, which are this handler's own. The PER-SHEET rules — an index that is
  // not positional, no active sheet or two of them, a header that disagrees with the entry it names, a name
  // above its bound — belong to the DECODER, the layer that reads the native answer, and are covered by
  // `tests/unit/bridge-sheetlist.test.js`.
  const cases = [
    // A bridge REFUSAL is republished with its own closed class, exactly like the other Cell legs; only a
    // structurally impossible listing becomes the generic tool error.
    [listing({ ok: false, code: 'EDITOR_BUSY' }), 'a bridge refusal', 'EDITOR_BUSY'],
    [listing({ count: 3 }), 'a count without the sheets to match', 'TOOL_ERROR'],
    [listing({ count: 0, sheets: [] }), 'no sheets at all', 'TOOL_ERROR'],
    [listing({ activeIndex: 5 }), 'an active index outside the list', 'TOOL_ERROR'],
    [listing({ activeName: '' }), 'an empty active name', 'TOOL_ERROR'],
    [listing({ sheets: 'нет' }), 'sheets that are not an array', 'TOOL_ERROR'],
    [null, 'no answer at all', 'TOOL_ERROR'],
    ['listing', 'an answer that is not an object', 'TOOL_ERROR']
  ];
  for (const [answer, why, expected] of cases) {
    const bridge = bridgeWith(answer);
    const result = await toolWith(bridge).execute({}, cellCtx);
    assert.equal(result.ok, false, why);
    assert.equal(result.code, expected, why);
  }
});

test('a refusal class from the bridge is republished, and an unknown one becomes a tool error', async () => {
  for (const [code, expected] of [['EDITOR_BUSY', 'EDITOR_BUSY'], ['CAPABILITY_UNAVAILABLE', 'CAPABILITY_UNAVAILABLE'],
    ['INVALID_DATA', 'INVALID_DATA'], ['TOOL_ERROR', 'TOOL_ERROR'], ['MADE_UP', 'TOOL_ERROR']]) {
    const bridge = bridgeWith({ ok: false, code });
    const result = await toolWith(bridge).execute({}, cellCtx);
    assert.equal(result.code, expected, `bridge code ${code}`);
  }
});

test('an uncertain answer stops the run as UNCERTAIN and is never retried', async () => {
  const returned = bridgeWith({ ok: false, code: 'APPLY_UNCERTAIN' });
  const result = await toolWith(returned).execute({}, cellCtx);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TOOL_UNCERTAIN');
  assert.equal(returned.calls.listSheets, 1, 'an uncertain outcome is never retried');

  const thrown = { calls: { listSheets: 1 },
    async listSheets() { const error = new Error('uncertain'); error.code = 'APPLY_UNCERTAIN'; throw error; } };
  assert.equal((await toolWith(thrown).execute({}, cellCtx)).code, 'TOOL_UNCERTAIN');
});

test('a bridge without the method refuses as a capability', async () => {
  const result = await toolWith({ calls: {} }).execute({}, cellCtx);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CAPABILITY_UNAVAILABLE');
});

test('a non-Cell editor is refused by the precondition', () => {
  const tool = toolWith(bridgeWith(listing()));
  assert.equal(tool.precondition({}, cellCtx), null);
  assert.equal(tool.precondition({}, { editor: 'word' }).code, 'CAPABILITY_UNAVAILABLE');
});

test('the empty argument object is the ONLY accepted argument shape', async () => {
  const schema = toolWith(bridgeWith(listing())).schema;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties), [], 'a leg with no arguments has no properties');
  assert.deepEqual(schema.required ?? [], []);
});

test('the handler re-checks the SCALAR envelope a drifted bridge could get wrong', async () => {
  // These rules are the HANDLER's own and are unreachable through the real bridge, whose decoder refuses first —
  // so they are pinned only here: a bridge that published a book wider than the cap, or a listing whose entries
  // breached the result ceiling, must never reach the runtime as this tool's result.
  const overCap = Array.from({ length: LIMITS.sheetListMax + 1 }, (_, index) => ({
    name: `S${index}`, index, active: index === 0, visible: true
  }));
  const drifted = bridgeWith({ ok: true, count: overCap.length, activeIndex: 0, activeName: 'S0', sheets: overCap });
  const refused = await toolWith(drifted).execute({}, cellCtx);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'TOOL_ERROR', 'a book wider than the cap is refused by the handler too');

  // Names far above the wire bound are NOT re-checked by this handler (the decoder owns the per-sheet shape);
  // what IS checked here is that the serialized entry fits, and an entry that cannot is a BYTE_LIMIT rather than
  // a published result.
  const huge = Array.from({ length: LIMITS.sheetListMax }, (_, index) => ({
    name: 'я'.repeat(400), index, active: index === 0, visible: true
  }));
  const oversized = bridgeWith({ ok: true, count: huge.length, activeIndex: 0, activeName: huge[0].name, sheets: huge });
  const result = await toolWith(oversized).execute({}, cellCtx);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BYTE_LIMIT', 'a result that cannot be serialized inside the ceiling is refused');
});

test('the listing stays inside the sheet cap and the entry byte bound', async () => {
  // The cap is the bridge's own: an over-cap answer is refused there. What the TOOL owes is that a listing at
  // the cap still serializes inside the result ceiling, which is what this pins.
  const many = Array.from({ length: LIMITS.sheetListMax }, (_, index) => ({
    name: 'Л'.repeat(31), index, active: index === 0, visible: true
  }));
  const bridge = bridgeWith({ ok: true, count: many.length, activeIndex: 0, activeName: many[0].name, sheets: many });
  const result = await toolWith(bridge).execute({}, cellCtx);
  assert.equal(result.ok, true);
  const entry = JSON.stringify({ tool: 'list_sheets', ok: true, data: result.data });
  assert.ok(utf8ByteLength(entry) <= AGENT_CEILINGS.toolResultBytes, `${utf8ByteLength(entry)} bytes`);

  const tool = toolWith(bridgeWith(listing()));
  assert.ok(tool.description.trim().length > 0);
  assert.equal(/[\u0000-\u001f\u007f]/.test(tool.description), false);
  assert.ok(utf8ByteLength(tool.description) <= 256, 'TOOL_DESCRIPTION_BYTES is 256');
});
