// Unit coverage for the Cell (spreadsheet) descriptors: `read_sheet` and `read_range`.
//
// The primitives behind these tools are measured natively and recorded in `.local/cell-api-measured.md`;
// what these tests own is the DESCRIPTOR CONTRACT — which editor each tool is offered in, which
// arguments are refused before any dispatch, how a bridge envelope is classified, and the ONE
// measurement that keeps a published result inside the runtime's entry ceiling. The bridge is a double:
// these are host tests and are not native proof, exactly as the module header states.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCellTools } from '../../src/tools/cell.js';
import { createWordTools } from '../../src/tools/word.js';
import { createRegistry } from '../../src/tools/registry.js';
import { AGENT_CEILINGS, LIMITS } from '../../src/shared/limits.js';
import { utf8ByteLength } from '../../src/shared/bytes.js';

// A minimal, well-shaped bridge answer. Every field is the one the authored body emits, so a test that
// wants a malformed envelope changes exactly the field it is about.
function envelope(overrides = {}) {
  return {
    ok: true,
    sheetName: 'Sprint1',
    sheetIndex: 0,
    sheetCount: 1,
    requestAddress: 'A1:B2',
    readAddress: 'A1:B2',
    totalRows: 2,
    totalColumns: 2,
    rowCount: 2,
    columnCount: 2,
    truncated: false,
    values: [['a', 'b'], ['c', 'd']],
    formulas: [['', ''], ['', '']],
    ...overrides
  };
}
// The bridge double: only the two entry points the module reaches, each answering the envelope it is
// given. `calls` records what crossed the boundary, so a refusal can be proven to have dispatched
// NOTHING.
function bridgeWith(sheet, range) {
  const calls = { readSheet: 0, readRange: 0 };
  return {
    calls,
    async readSheet() { calls.readSheet += 1; return sheet; },
    async readRange() { calls.readRange += 1; return range; }
  };
}
function toolNamed(bridge, name) {
  return createCellTools(bridge).find(entry => entry.name === name);
}
const cellCtx = { editor: 'cell' };

test('the Cell reads are offered for the cell editor only, and Word tools never reach a spreadsheet', () => {
  const bridge = bridgeWith(envelope(), envelope());
  const registry = createRegistry([...createWordTools(bridge), ...createCellTools(bridge)]);
  const capabilities = ['document.read', 'document.write'];
  const cellEdit = registry.catalogue({ editor: 'cell', capabilities, mode: 'EDIT' }).map(entry => entry.name);
  assert.deepEqual(cellEdit.sort(), ['read_range', 'read_sheet', 'write_range'],
    'a spreadsheet is offered the Cell reads and the Cell write, and no Word descriptor');
  const cellAsk = registry.catalogue({ editor: 'cell', capabilities, mode: 'ASK' }).map(entry => entry.name);
  assert.deepEqual(cellAsk.sort(), ['read_range', 'read_sheet'],
    'ASK offers the reads and withholds the mutation');
  for (const name of cellAsk) {
    const entry = registry.resolve(registry.catalogue({ editor: 'cell', capabilities, mode: 'ASK' }), name);
    assert.deepEqual(entry.editors, ['cell']);
    assert.equal(entry.kind, 'read');
    assert.deepEqual(entry.requires, ['document.read']);
  }
  const write = registry.resolve(registry.catalogue({ editor: 'cell', capabilities, mode: 'EDIT' }), 'write_range');
  assert.equal(write.kind, 'mutate');
  assert.deepEqual(write.requires, ['document.write']);
  const wordEdit = registry.catalogue({ editor: 'word', capabilities, mode: 'EDIT' }).map(entry => entry.name);
  assert.equal(wordEdit.includes('read_sheet'), false, 'the Cell reads are withheld from a document');
  assert.equal(wordEdit.includes('read_range'), false);
});

test('read_sheet publishes the measured envelope and derives truncated from the two row counts', async () => {
  const bridge = bridgeWith(envelope(), envelope());
  const result = await toolNamed(bridge, 'read_sheet').execute({}, cellCtx);
  assert.equal(bridge.calls.readSheet, 1);
  assert.equal(result.ok, true);
  assert.equal(result.data.sheetName, 'Sprint1');
  assert.equal(result.data.sheetIndex, 0);
  assert.equal(result.data.sheetCount, 1);
  assert.deepEqual(result.data.values, [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(result.data.formulas, [['', ''], ['', '']]);
  assert.equal(result.data.truncated, false);
});

test('a CLIPPED answer publishes the prefix it carries, the full shape and the read address', async () => {
  // The measured shape of a real used range: 53 rows x 24 columns clipped to 16 whole rows under the
  // 400-cell cap, which is exactly what the live session answered.
  const values = Array.from({ length: 16 }, () => Array.from({ length: 24 }, () => 'x'));
  const formulas = Array.from({ length: 16 }, () => Array.from({ length: 24 }, () => ''));
  const bridge = bridgeWith(envelope({ requestAddress: 'A1:X53', readAddress: 'A1:X16', totalRows: 53,
    totalColumns: 24, rowCount: 16, columnCount: 24, truncated: true, values, formulas }), envelope());
  const result = await toolNamed(bridge, 'read_sheet').execute({}, cellCtx);
  assert.equal(result.ok, true);
  assert.equal(result.data.requestAddress, 'A1:X53', 'the caller learns the range the sheet really holds');
  assert.equal(result.data.readAddress, 'A1:X16', 'and the range the answer actually covers');
  assert.equal(result.data.totalRows, 53);
  assert.equal(result.data.rowCount, 16);
  assert.equal(result.data.truncated, true);
  assert.equal(result.data.values.length, 16);
});

test('a truncated flag that disagrees with the numbers it describes is refused, not published', async () => {
  const values = [['a', 'b'], ['c', 'd']];
  for (const truncated of [true, undefined]) {
    const bridge = bridgeWith(envelope({ truncated, values }), envelope());
    const result = await toolNamed(bridge, 'read_sheet').execute({}, cellCtx);
    assert.equal(result.ok, false, `truncated: ${String(truncated)} must be refused`);
    assert.equal(result.code, 'TOOL_ERROR');
  }
  // And the converse: rows were dropped but the flag says the range was complete.
  const bridge = bridgeWith(envelope({ totalRows: 3, rowCount: 2, truncated: false }), envelope());
  const result = await toolNamed(bridge, 'read_sheet').execute({}, cellCtx);
  assert.equal(result.ok, false);
});

test('an answer wider than the cap, or taller than its own total, is refused', async () => {
  const overCap = Array.from({ length: 21 }, () => Array.from({ length: 20 }, () => 'x'));
  const bridge = bridgeWith(envelope({ totalRows: 21, totalColumns: 20, rowCount: 21, columnCount: 20,
    values: overCap, formulas: null, truncated: false }), envelope());
  assert.equal((await toolNamed(bridge, 'read_sheet').execute({}, cellCtx)).code, 'TOOL_ERROR',
    '420 cells is above the advertised cap of 400');

  const taller = bridgeWith(envelope({ totalRows: 2, rowCount: 3, truncated: false }), envelope());
  assert.equal((await toolNamed(bridge, 'read_sheet').execute({}, cellCtx)).code, 'TOOL_ERROR',
    'a published prefix can never be taller than the range it prefixes');

  const narrower = bridgeWith(envelope({ totalColumns: 3, columnCount: 2, truncated: false }), envelope());
  assert.equal((await toolNamed(bridge, 'read_sheet').execute({}, cellCtx)).code, 'TOOL_ERROR',
    'and never a different width: the body clips whole rows only');
});

test('an over-wide cell refuses the whole read instead of being shortened', async () => {
  const wide = 'x'.repeat(LIMITS.sheetReadCellBytes + 1);
  const bridge = bridgeWith(envelope({ values: [[wide, 'b'], ['c', 'd']] }), envelope());
  const result = await toolNamed(bridge, 'read_sheet').execute({}, cellCtx);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TOOL_ERROR');
});

test('the enforced bound is the ACTUAL serialized entry, so an over-long result is a byte refusal', async () => {
  // 400 cells of 100 bytes each is inside every stated per-cell and per-range count bound, and still far
  // above the runtime's 16384-byte entry ceiling: the bound that must refuse it is the entry one.
  const cell = 'y'.repeat(100);
  const values = Array.from({ length: 2 }, () => Array.from({ length: 200 }, () => cell));
  const bridge = bridgeWith(envelope({ requestAddress: 'A1:GR2', readAddress: 'A1:GR2', totalRows: 2,
    totalColumns: 200, rowCount: 2, columnCount: 200, truncated: false, values, formulas: null }), envelope());
  const result = await toolNamed(bridge, 'read_sheet').execute({}, cellCtx);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BYTE_LIMIT');
  // And the same shape one cell narrower per row fits, so the refusal is the ENTRY bound and not a
  // blanket refusal of long results.
  const fits = Array.from({ length: 2 }, () => Array.from({ length: 60 }, () => 'y'.repeat(100)));
  const okBridge = bridgeWith(envelope({ requestAddress: 'A1:BH2', readAddress: 'A1:BH2', totalRows: 2,
    totalColumns: 60, rowCount: 2, columnCount: 60, truncated: false, values: fits, formulas: null }), envelope());
  const accepted = await toolNamed(okBridge, 'read_sheet').execute({}, cellCtx);
  assert.equal(accepted.ok, true);
  const entry = utf8ByteLength(JSON.stringify({ tool: 'read_sheet', ok: true, data: accepted.data }));
  assert.ok(entry <= AGENT_CEILINGS.toolResultBytes);
});

test('read_range closes its address before anything is dispatched', async () => {
  const bridge = bridgeWith(envelope(), envelope());
  const tool = toolNamed(bridge, 'read_range');
  for (const address of ['a1', 'A0', 'Sprint1!A1', 'A1:', ':A1', 'A1:B', '', 'A1:B2:C3', 'AAAAAAAA1']) {
    const result = await tool.execute({ address }, cellCtx);
    assert.equal(result.ok, false, `${address} must be refused`);
    assert.equal(result.code, 'TOOL_ERROR', `${address} is the closed argument class`);
  }
  assert.equal(bridge.calls.readRange, 0, 'no refused address ever reached the bridge');
  assert.equal((await tool.execute({}, cellCtx)).code, 'TOOL_ERROR', 'a missing address is refused too');
  for (const address of ['A1', 'A1:C10', 'B2']) {
    const result = await tool.execute({ address }, cellCtx);
    assert.equal(result.ok, true, `${address} must be served`);
  }
  assert.equal(bridge.calls.readRange, 3);
});

test('read_range names the address it asked for and the bridge answer is what is published', async () => {
  const bridge = bridgeWith(envelope(), envelope({ requestAddress: 'A1:C3', readAddress: 'A1:C3',
    totalRows: 3, totalColumns: 3, rowCount: 3, columnCount: 3, truncated: false,
    values: [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9']], formulas: null }));
  const result = await toolNamed(bridge, 'read_range').execute({ address: 'A1:C3' }, cellCtx);
  assert.equal(result.ok, true);
  assert.equal(result.data.requestAddress, 'A1:C3');
  assert.equal(result.data.values.length, 3);
  assert.equal(result.data.formulas, null, 'a build that answers no formula matrix publishes null, never []');
});

test('a foreign editor refuses before any dispatch, and a missing entry point is a capability refusal', async () => {
  const bridge = bridgeWith(envelope(), envelope());
  const tool = toolNamed(bridge, 'read_sheet');
  // The editor refusal is the descriptor's PRECONDITION, which the runtime evaluates before it calls the
  // handler: asserting it through `execute` would test a path the product never takes.
  assert.equal(tool.precondition({}, cellCtx), null, 'the cell editor passes the precondition');
  const word = tool.precondition({}, { editor: 'word' });
  assert.equal(word.code, 'CAPABILITY_UNAVAILABLE');
  assert.equal(word.message, 'отказ');
  const slide = await toolNamed(bridge, 'read_range').execute({ address: 'A1' }, cellCtx);
  assert.equal(slide.ok, true, 'the precondition and the handler agree for the served editor');
  assert.equal(bridge.calls.readSheet, 0, 'a failed precondition means no Cell read ever ran');

  const withoutMethod = { calls: { readSheet: 0, readRange: 0 } };
  const result = await toolNamed(withoutMethod, 'read_sheet').execute({}, cellCtx);
  assert.equal(result.code, 'CAPABILITY_UNAVAILABLE', 'a bridge with no entry point cannot serve the tool');
});

test('bridge refusals keep their closed class, an unknown code becomes the tool-error class', async () => {
  for (const [code, expected] of [['EDITOR_BUSY', 'EDITOR_BUSY'], ['CAPABILITY_UNAVAILABLE', 'CAPABILITY_UNAVAILABLE'],
    ['BYTE_LIMIT', 'BYTE_LIMIT'], ['MADE_UP_CLASS', 'TOOL_ERROR'], [undefined, 'TOOL_ERROR']]) {
    const bridge = bridgeWith({ ok: false, code }, envelope());
    const result = await toolNamed(bridge, 'read_sheet').execute({}, cellCtx);
    assert.equal(result.ok, false);
    assert.equal(result.code, expected, `bridge code ${String(code)}`);
  }
});

test('a returned or thrown APPLY_UNCERTAIN is the runtime uncertain class, never an ordinary error', async () => {
  const returned = bridgeWith({ ok: false, code: 'APPLY_UNCERTAIN' }, envelope());
  assert.equal((await toolNamed(returned, 'read_sheet').execute({}, cellCtx)).code, 'TOOL_UNCERTAIN');

  const thrown = {
    calls: { readSheet: 1, readRange: 0 },
    async readSheet() { const error = new Error('uncertain'); error.code = 'APPLY_UNCERTAIN'; throw error; },
    async readRange() { return envelope(); }
  };
  assert.equal((await toolNamed(thrown, 'read_sheet').execute({}, cellCtx)).code, 'TOOL_UNCERTAIN');

  // An answer that is not an object at all is the module's unknown convention.
  const shapeless = { calls: { readSheet: 1, readRange: 0 }, async readSheet() { return null; }, async readRange() { return envelope(); } };
  assert.equal((await toolNamed(shapeless, 'read_sheet').execute({}, cellCtx)).code, 'TOOL_ERROR');
});

test('both Cell descriptors carry a one-line authored description inside the byte bound', () => {
  const bridge = bridgeWith(envelope(), envelope());
  for (const entry of createCellTools(bridge)) {
    assert.ok(entry.description.trim().length > 0);
    assert.ok(utf8ByteLength(entry.description) <= 256, `${entry.name} description bytes`);
    assert.equal(/[\u0000-\u001f\u007f]/.test(entry.description), false, `${entry.name} stays on one line`);
    assert.deepEqual(entry.requires, [entry.kind === 'mutate' ? 'document.write' : 'document.read']);
    assert.equal(entry.policy, 'auto');
  }
});
