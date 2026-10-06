// Unit coverage for `write_range` — the first Cell MUTATION.
//
// The bridge is a double here: these are host tests and are NOT native proof. What they own is the
// DESCRIPTOR contract — the closed argument class and the size bounds in front of any dispatch, the
// address-vs-matrix precondition, and the classification of the bridge's envelope into a published write, a
// known refusal, or the UNCERTAIN class that must stop the run. What they do NOT own is the DECODING of the
// phase and the one-flag-per-cell rule: that is the bridge's own decision, made while it still owns the
// slot, and a double cannot exercise it. It is covered through the REAL bridge in
// `tests/unit/bridge-sheetwrite.test.js`, which is where a change to that rule will fail a test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCellTools } from '../../src/tools/cell.js';
import { createRegistry } from '../../src/tools/registry.js';
import { LIMITS } from '../../src/shared/limits.js';
import { utf8ByteLength } from '../../src/shared/bytes.js';

// A well-shaped bridge answer: the authored body reports the post-write phase and ONE flag per cell,
// 1 meaning "the cell now holds exactly what was asked for".
function outcome(flags, overrides = {}) {
  return { ok: true, rowCount: 2, columnCount: 2, matches: flags, ...overrides };
}
function bridgeWith(answer) {
  const calls = { writeRange: 0 };
  return {
    calls,
    async writeRange(request) {
      calls.writeRange += 1;
      this.lastRequest = request;
      // The real bridge echoes the address it wrote, so the double does too: an envelope without it is
      // not one this leg can have produced, and the handler checks exactly that.
      return typeof answer === 'function' ? { address: request.address, ...answer(request) } : { address: request.address, ...answer };
    }
  };
}
function toolWith(bridge) { return createCellTools(bridge).find(entry => entry.name === 'write_range'); }
const cellCtx = { editor: 'cell' };
const GRID = [['Выручка', '1000'], ['Себестоимость', '700']];

test('RED anchor: write_range exists, is a Cell mutation, and is offered in EDIT only', () => {
  const bridge = bridgeWith(outcome([true, true, true, true]));
  const tool = toolWith(bridge);
  assert.ok(tool, 'write_range must exist');
  assert.deepEqual(tool.editors, ['cell']);
  assert.equal(tool.kind, 'mutate');
  assert.deepEqual(tool.requires, ['document.write']);
  const registry = createRegistry(createCellTools(bridge));
  const capabilities = ['document.read', 'document.write'];
  assert.deepEqual(registry.catalogue({ editor: 'cell', capabilities, mode: 'EDIT' }).map(e => e.name).sort(),
    ['add_sheet', 'format_cells', 'list_sheets', 'read_range', 'read_sheet', 'rename_sheet', 'write_range']);
  assert.deepEqual(registry.catalogue({ editor: 'cell', capabilities, mode: 'ASK' }).map(e => e.name).sort(),
    ['list_sheets', 'read_range', 'read_sheet'], 'a mutation is never offered to ASK');
});

test('a served write dispatches ONCE and reports the proved write', async () => {
  const bridge = bridgeWith(outcome([true, true, true, true]));
  const result = await toolWith(bridge).execute({ address: 'A1:B2', cells: GRID }, cellCtx);
  assert.equal(bridge.calls.writeRange, 1, 'exactly one dispatch, never a retry');
  assert.equal(result.ok, true);
  assert.equal(result.data.address, 'A1:B2');
  assert.equal(result.data.rowCount, 2);
  assert.equal(result.data.columnCount, 2);
});

test('an unproved write is UNCERTAIN, never a known error and never a retry', async () => {
  // The ONE-FLAG-PER-CELL rule lives in the bridge decoder, because only the bridge can decide it while
  // it still owns the slot. What crosses to this tool is therefore the CLASS: a bridge that could not
  // prove the write answers APPLY_UNCERTAIN, and the tool must publish the runtime's uncertain class so
  // the run stops fail-safe instead of treating a possibly-applied mutation as an ordinary error.
  const returned = bridgeWith({ ok: false, code: 'APPLY_UNCERTAIN' });
  const result = await toolWith(returned).execute({ address: 'A1:B2', cells: GRID }, cellCtx);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TOOL_UNCERTAIN');
  assert.equal(returned.calls.writeRange, 1, 'an uncertain write is never retried');

  const thrown = {
    calls: { writeRange: 1 },
    async writeRange() { const error = new Error('uncertain'); error.code = 'APPLY_UNCERTAIN'; throw error; }
  };
  assert.equal((await toolWith(thrown).execute({ address: 'A1:B2', cells: GRID }, cellCtx)).code, 'TOOL_UNCERTAIN');
});

test('a refused answer classifies as a KNOWN error, not as uncertainty', async () => {
  for (const [code, expected] of [['EDITOR_BUSY', 'EDITOR_BUSY'], ['CAPABILITY_UNAVAILABLE', 'CAPABILITY_UNAVAILABLE'],
    ['TOOL_ERROR', 'TOOL_ERROR'], ['MADE_UP', 'TOOL_ERROR']]) {
    const bridge = bridgeWith({ ok: false, code });
    const result = await toolWith(bridge).execute({ address: 'A1:B2', cells: GRID }, cellCtx);
    assert.equal(result.code, expected, `bridge code ${code}`);
  }
});

test('the closed argument class refuses BEFORE any dispatch', async () => {
  const bridge = bridgeWith(outcome([true]));
  const tool = toolWith(bridge);
  const cases = [
    [{ cells: GRID }, 'no address', 'TOOL_ERROR'],
    [{ address: 'a1', cells: GRID }, 'lower-case address', 'TOOL_ERROR'],
    [{ address: 'Sprint1!A1', cells: GRID }, 'sheet-qualified address', 'TOOL_ERROR'],
    [{ address: 'B2:A1', cells: [['a', 'b'], ['c', 'd']] }, 'a backwards range names no block', 'TOOL_ERROR'],
    [{ address: 'A1:B2', cells: [] }, 'empty matrix', 'TOOL_ERROR'],
    [{ address: 'A1:B2', cells: [[]] }, 'empty row', 'TOOL_ERROR'],
    [{ address: 'A1:B2', cells: [['a'], ['b', 'c']] }, 'ragged matrix', 'TOOL_ERROR'],
    [{ address: 'A1:B2', cells: [['a', 'b'], ['c', 3]] }, 'a non-string cell', 'TOOL_ERROR'],
    // The three SIZE guards are each probed under an address that MATCHES the matrix they carry, so no
    // other rule can be the reason they are refused. Under `A1:B2` (as this list first had them) the COLUMN
    // case and the per-cell byte case were both stopped by the SHAPE rule before their own bound ran, which
    // left those two bounds with no test at all: deleting either guard kept the whole suite green.
    [{ address: 'A1:Q1', cells: [Array.from({ length: LIMITS.writeRangeColumnsMax + 1 }, () => 'x')] },
      'too many columns under a matching address', 'TOOL_ERROR'],
    [{ address: `A1:A${LIMITS.writeRangeRowsMax + 1}`,
      cells: Array.from({ length: LIMITS.writeRangeRowsMax + 1 }, () => ['x']) }, 'too many rows', 'TOOL_ERROR'],
    [{ address: 'A1', cells: [['x'.repeat(LIMITS.writeRangeCellBytes + 1)]] }, 'over-wide cell', 'BYTE_LIMIT']
  ];
  for (const [args, why, code] of cases) {
    const result = await tool.execute(args, cellCtx);
    assert.equal(result.ok, false, why);
    assert.equal(result.code, code, why);
  }
  assert.equal(bridge.calls.writeRange, 0, 'nothing refused ever reached the bridge');
});

test('the matrix shape must match the address the caller named', async () => {
  // `A1:B2` is a 2x2 block: a 1x1 or 3x1 matrix under that address is a request this tool cannot serve,
  // because the readback proof is over exactly the addressed block.
  const bridge = bridgeWith(outcome([true]));
  const tool = toolWith(bridge);
  for (const address of ['A1:B2', 'A1:C3']) {
    const result = await tool.execute({ address, cells: [['x']] }, cellCtx);
    assert.equal(result.ok, false, `${address} with a 1x1 matrix`);
    assert.equal(result.code, 'TOOL_ERROR');
  }
  assert.equal(bridge.calls.writeRange, 0);
  // And the matching shape is served: the double echoes whatever block it was handed, like the real one.
  const echo = bridgeWith(request => ({ ok: true, rowCount: request.cells.length,
    columnCount: request.cells[0].length, matches: [] }));
  const ok = await toolWith(echo).execute({ address: 'A1:C3', cells: [['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i']] }, cellCtx);
  assert.equal(ok.ok, true);
  assert.equal(ok.data.rowCount, 3);
  assert.equal(ok.data.columnCount, 3);
});

test('an outcome whose shape disagrees with the request is refused, not published', async () => {
  // The tool-facing envelope describes the block it wrote; a bridge that reported a different block
  // cannot have served this request. (The ONE-FLAG-PER-CELL rule is the decoder's, in bridge.js: an
  // answer whose flag count is not the matrix size settles UNCERTAIN there, because only the bridge can
  // decide that while it still owns the slot.)
  for (const wrong of [{ rowCount: 3, columnCount: 2 }, { rowCount: 2, columnCount: 3 }, { rowCount: 2, columnCount: 2, address: 'A1:C3' }]) {
    const tool = toolWith(bridgeWith({ ok: true, matches: [true, true, true, true], ...wrong }));
    const result = await tool.execute({ address: 'A1:B2', cells: GRID }, cellCtx);
    assert.equal(result.ok, false, JSON.stringify(wrong));
    assert.equal(result.code, 'TOOL_ERROR');
  }
});

test('the whole-payload byte bound refuses an over-bound write before any dispatch', async () => {
  // 3 rows x 16 columns of 256-byte cells is 12288 bytes, above the 8192-byte payload bound, while every
  // single cell is legal and the cell count is far inside the cap: the bound that must refuse it is the
  // payload one.
  const cell = 'y'.repeat(LIMITS.writeRangeCellBytes);
  const cells = Array.from({ length: 3 }, () => Array.from({ length: 16 }, () => cell));
  const bridge = bridgeWith({ ok: true, rowCount: 3, columnCount: 16, matches: [] });
  const result = await toolWith(bridge).execute({ address: 'A1:P3', cells }, cellCtx);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BYTE_LIMIT');
  assert.equal(bridge.calls.writeRange, 0, 'an over-bound payload is refused before any dispatch');

  // The same shape inside the payload bound is served, so the refusal is the byte bound and not a
  // blanket refusal of wide blocks.
  const smaller = Array.from({ length: 3 }, () => Array.from({ length: 16 }, () => 'y'.repeat(100)));
  const fitting = bridgeWith({ ok: true, rowCount: 3, columnCount: 16, matches: [] });
  assert.equal((await toolWith(fitting).execute({ address: 'A1:P3', cells: smaller }, cellCtx)).ok, true);
  assert.equal(fitting.calls.writeRange, 1);

  // THE CELL-COUNT bound is the third size rule and needs its own probe under a matching address: 26 x 16
  // is 416 cells, every one of them legal and one byte wide, so neither the column bound (16) nor the
  // payload bound (8192 bytes) can be what refuses it.
  const wide = Array.from({ length: 26 }, () => Array.from({ length: 16 }, () => 'z'));
  const counted = bridgeWith({ ok: true, rowCount: 26, columnCount: 16, matches: [] });
  const countedResult = await toolWith(counted).execute({ address: 'A1:P26', cells: wide }, cellCtx);
  assert.equal(countedResult.ok, false, '416 cells is above the 400-cell cap');
  assert.equal(countedResult.code, 'TOOL_ERROR');
  assert.equal(counted.calls.writeRange, 0);
});

test('the write description stays one authored line inside the byte bound', () => {
  const tool = toolWith(bridgeWith(outcome([true])));
  assert.ok(tool.description.trim().length > 0);
  assert.equal(/[\u0000-\u001f\u007f]/.test(tool.description), false);
  assert.equal(tool.precondition({}, { editor: 'word' }).code, 'CAPABILITY_UNAVAILABLE');
  assert.equal(tool.precondition({}, cellCtx), null);
});

// ---------------------------------------------------------------------------------------------------------
// THE SHEET SELECTOR on `write_range` (T5.3b): the same two closed spellings `read_range` proved, on a MUTATION.
// ---------------------------------------------------------------------------------------------------------
test('write_range offers the sheet selector as two optional, closed spellings', () => {
  const tool = toolWith(bridgeWith(outcome([true])));
  assert.equal(tool.schema.additionalProperties, false);
  assert.deepEqual(Object.keys(tool.schema.properties).sort(), ['address', 'cells', 'sheet', 'sheetIndex']);
  assert.deepEqual(tool.schema.required, ['address', 'cells'], 'the block is still the required part');
  assert.equal(tool.schema.properties.sheet.maxBytes, LIMITS.sheetListNameBytes);
  assert.equal(tool.schema.properties.sheetIndex.maximum, LIMITS.sheetListMax - 1);
  assert.equal(tool.schema.properties.sheetIndex.minimum, 0);
});

test('write_range forwards the selector, and index ZERO is a selector rather than an absent one', async () => {
  const plain = bridgeWith(outcome([true]));
  await toolWith(plain).execute({ address: 'A1', cells: [['a']] }, cellCtx);
  assert.equal(plain.lastRequest.sheetName, null);
  assert.equal(plain.lastRequest.sheetIndex, null);

  const byName = bridgeWith(outcome([true]));
  await toolWith(byName).execute({ address: 'A1', cells: [['a']], sheet: 'Данные' }, cellCtx);
  assert.equal(byName.lastRequest.sheetName, 'Данные');
  assert.equal(byName.lastRequest.sheetIndex, null);

  const zero = bridgeWith(outcome([true]));
  await toolWith(zero).execute({ address: 'A1', cells: [['a']], sheetIndex: 0 }, cellCtx);
  assert.equal(zero.lastRequest.sheetIndex, 0, 'a zero index must cross as 0, never as null');
  assert.equal(zero.lastRequest.sheetName, null);
});

test('write_range refuses an ambiguous or out-of-contract selector BEFORE any dispatch', async () => {
  const exact = 'я'.repeat(LIMITS.sheetListNameBytes / 2);
  assert.equal(utf8ByteLength(exact), LIMITS.sheetListNameBytes);
  const cases = [
    [{ sheet: 'Sprint1', sheetIndex: 0 }, 'BOTH spellings'],
    [{ sheet: '' }, 'an empty name'],
    [{ sheet: exact + 'я' }, 'a name one byte above the bound'],
    [{ sheet: 42 }, 'a numeric name'],
    [{ sheetIndex: -1 }, 'a negative index'],
    [{ sheetIndex: 1.5 }, 'a fractional index'],
    [{ sheetIndex: LIMITS.sheetListMax }, 'an index at the workbook bound'],
    [{ sheet: 'Sprint1', extra: 1 }, 'an unknown key']
  ];
  for (const [selector, why] of cases) {
    const bridge = bridgeWith(outcome([true]));
    const result = await toolWith(bridge).execute({ address: 'A1', cells: [['a']], ...selector }, cellCtx);
    assert.equal(result.ok, false, why);
    assert.equal(result.code, 'TOOL_ERROR', why);
    assert.equal(bridge.calls.writeRange, 0, `${why}: a mutation must not be dispatched`);
  }
  // A name exactly AT the bound is a valid selector, so the bound is not off by one.
  const served = bridgeWith(outcome([true], { rowCount: 1, columnCount: 1 }));
  const ok = await toolWith(served).execute({ address: 'A1', cells: [['a']], sheet: exact }, cellCtx);
  assert.equal(ok.ok, true);
  assert.equal(served.calls.writeRange, 1);
});

test('BOTH sheet-addressing tools NAME their arguments in the DESCRIPTION the model reads', async () => {
  // THE DESCRIPTION IS THE ONLY MODEL-FACING FIELD: the catalogue is rendered as `name (kind, policy):
  // description` (src/agent/runtime.js) and the JSON schema is validation-only, never shown. A selector that the
  // description does not name is therefore UNDISCOVERABLE — the agent would emit `{address, cells}` and silently
  // target the active sheet — which is why this asserts the CONTENT of both lines rather than their length.
  const bridge = bridgeWith(outcome([true]));
  const tools = createCellTools(bridge);
  const write = tools.find((entry) => entry.name === 'write_range');
  const read = tools.find((entry) => entry.name === 'read_range');
  for (const [tool, name] of [[write, 'write_range'], [read, 'read_range']]) {
    assert.match(tool.description, /sheet\s*—/, `${name} names the sheet argument`);
    assert.match(tool.description, /sheetIndex\s*—/, `${name} names the index argument`);
    assert.ok(utf8ByteLength(tool.description) <= 256, `${name} stays inside the model-facing byte bound`);
  }
});

test('a selected write keeps the published shape and crosses both failure classes unchanged', async () => {
  const selected = bridgeWith(outcome([true], { rowCount: 1, columnCount: 1 }));
  const result = await toolWith(selected).execute({ address: 'A1', cells: [['a']], sheet: 'Данные' }, cellCtx);
  assert.equal(result.ok, true);
  // The published result is UNCHANGED by the selector: no new field, so nothing that read it before is affected,
  // and the identity of the sheet is proven by the READBACK of the selected sheet rather than by a new field.
  assert.deepEqual(result.data, { address: 'A1', rowCount: 1, columnCount: 1, cells: 1, bytes: 1 });
  // A PRE-mutation refusal (an unknown sheet) is the known argument class; a post-mutation one is uncertain.
  for (const [answer, expected] of [[{ ok: false, code: 'TOOL_ERROR' }, 'TOOL_ERROR'],
    [{ ok: false, code: 'APPLY_UNCERTAIN' }, 'TOOL_UNCERTAIN']]) {
    const bridge = bridgeWith(answer);
    const refused = await toolWith(bridge).execute({ address: 'A1', cells: [['a']], sheet: 'Нет' }, cellCtx);
    assert.equal(refused.ok, false);
    assert.equal(refused.code, expected);
    assert.equal(bridge.calls.writeRange, 1, 'and it is never retried');
  }
});
