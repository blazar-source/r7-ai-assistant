// Unit coverage for `format_cells` — the Cell FORMATTING mutation, and the first tool in this repository whose
// proof is per-PROPERTY rather than per-target.
//
// The bridge is a double here: these are host tests and are NOT native proof. What they own is the DESCRIPTOR
// contract — the closed argument class, the discriminated `numberFormat` rule, "at least one property", the
// measured value bounds, the whole-or-refused rule for a mixed request, and the classification of the bridge's
// envelope into a published format, a known refusal, or the UNCERTAIN class that must stop the run. What they
// do NOT own is the one-flag-per-property decoding: that is the bridge's own decision, made while it still
// owns the slot, and it is covered through the REAL bridge in `tests/unit/bridge-cellformat.test.js`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCellTools } from '../../src/tools/cell.js';
import { createRegistry } from '../../src/tools/registry.js';
import { AGENT_CEILINGS, LIMITS } from '../../src/shared/limits.js';
import { utf8ByteLength } from '../../src/shared/bytes.js';

function columnIndex(letters) {
  let value = 0;
  for (const letter of letters) value = value * 26 + (letter.charCodeAt(0) - 64);
  return value;
}
// The rectangle an address names, so the double answers the same counts the real bridge derives.
function shapeOf(address) {
  const [head, tail] = address.includes(':') ? address.split(':') : [address, address];
  const from = /^([A-Z]+)([0-9]+)$/.exec(head);
  const to = /^([A-Z]+)([0-9]+)$/.exec(tail);
  return { rows: Number(to[2]) - Number(from[2]) + 1, columns: columnIndex(to[1]) - columnIndex(from[1]) + 1 };
}
// The properties the request actually asks for: every field except the address and the signal is one.
function propertyCountOf(request) {
  // FORMATTING properties only, which is exactly what the real bridge counts: the sheet selector chooses the
  // SUBJECT of the mutation and is not something to apply, so it must not inflate this number.
  return Object.keys(request)
    .filter((key) => key !== 'address' && key !== 'signal' && key !== 'sheetName' && key !== 'sheetIndex').length;
}
function served(request, overrides = {}) {
  const shape = shapeOf(request.address);
  return { ok: true, address: request.address, rowCount: shape.rows, columnCount: shape.columns,
    properties: propertyCountOf(request), ...overrides };
}
function bridgeWith(answer) {
  const calls = { formatCells: 0 };
  return {
    calls,
    requests: [],
    async formatCells(request) {
      calls.formatCells += 1;
      this.requests.push(request);
      const base = typeof answer === 'function' ? answer(request) : answer;
      // A double either SERVES the request with the envelope the real bridge builds (including `ok: true`,
      // which the handler requires), or answers the explicit envelope it was handed — a refusal, or one of the
      // deliberately drifted envelopes the contract tests use.
      if (base === null || typeof base !== 'object') return base;
      if (base.ok === false || base.address !== undefined) return base;
      return { ...served(request), ...base };
    }
  };
}
function toolWith(bridge) { return createCellTools(bridge).find(entry => entry.name === 'format_cells'); }
const cellCtx = { editor: 'cell' };

test('RED anchor: format_cells exists, is a Cell mutation, and is offered in EDIT only', () => {
  const bridge = bridgeWith({});
  const tool = toolWith(bridge);
  assert.ok(tool, 'format_cells must exist');
  assert.deepEqual(tool.editors, ['cell']);
  assert.equal(tool.kind, 'mutate');
  assert.deepEqual(tool.requires, ['document.write']);
  const registry = createRegistry(createCellTools(bridge));
  const capabilities = ['document.read', 'document.write'];
  assert.deepEqual(registry.catalogue({ editor: 'cell', capabilities, mode: 'EDIT' }).map(e => e.name).sort(),
    ['add_sheet', 'format_cells', 'list_sheets', 'read_range', 'read_sheet', 'write_range']);
  assert.deepEqual(registry.catalogue({ editor: 'cell', capabilities, mode: 'ASK' }).map(e => e.name).sort(),
    ['list_sheets', 'read_range', 'read_sheet'], 'a mutation is never offered to ASK');
});

test('a served format dispatches ONCE and reports the proved format', async () => {
  const bridge = bridgeWith({});
  const result = await toolWith(bridge).execute({ address: 'A1:B2', bold: true }, cellCtx);
  assert.equal(bridge.calls.formatCells, 1, 'exactly one dispatch, never a retry');
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { address: 'A1:B2', rowCount: 2, columnCount: 2, properties: 1 });
});

test('the bridge receives exactly the properties the caller asked for, and nothing else', async () => {
  const bridge = bridgeWith({});
  await toolWith(bridge).execute({ address: 'A1:C2', bold: true, columnWidth: 20 }, cellCtx);
  assert.deepEqual(bridge.requests[0], { address: 'A1:C2', bold: true, columnWidth: 20 });
  const second = bridgeWith({});
  await toolWith(second).execute({ address: 'A1', numberFormat: { type: 'percent', decimals: 0 } }, cellCtx);
  assert.deepEqual(second.requests[0], { address: 'A1', numberFormat: { type: 'percent', decimals: 0 } });
});

test('an unproved format is UNCERTAIN, never a known error and never a retry', async () => {
  // The one-flag-per-property rule lives in the bridge decoder, because only the bridge can decide it while it
  // still owns the slot. What crosses to this tool is the CLASS: a bridge that could not prove every requested
  // property answers APPLY_UNCERTAIN, and the tool must publish the runtime's uncertain class so the run stops
  // fail-safe instead of reading a possibly-applied format as an ordinary error.
  const returned = bridgeWith({ ok: false, code: 'APPLY_UNCERTAIN' });
  const result = await toolWith(returned).execute({ address: 'A1:B2', bold: true }, cellCtx);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TOOL_UNCERTAIN');
  assert.equal(returned.calls.formatCells, 1, 'an uncertain format is never retried');

  const thrown = {
    calls: { formatCells: 1 },
    async formatCells() { const error = new Error('uncertain'); error.code = 'APPLY_UNCERTAIN'; throw error; }
  };
  assert.equal((await toolWith(thrown).execute({ address: 'A1:B2', bold: true }, cellCtx)).code, 'TOOL_UNCERTAIN');
});

test('a refused answer classifies as a KNOWN error, not as uncertainty', async () => {
  for (const [code, expected] of [['EDITOR_BUSY', 'EDITOR_BUSY'], ['CAPABILITY_UNAVAILABLE', 'CAPABILITY_UNAVAILABLE'],
    ['TOOL_ERROR', 'TOOL_ERROR'], ['MADE_UP', 'TOOL_ERROR']]) {
    const bridge = bridgeWith({ ok: false, code });
    const result = await toolWith(bridge).execute({ address: 'A1:B2', bold: true }, cellCtx);
    assert.equal(result.code, expected, `bridge code ${code}`);
  }
});

test('a call with nothing but an address is refused BEFORE any dispatch', async () => {
  const bridge = bridgeWith({});
  // `clearFill: false` is the same request class as an address alone: it asks for NOTHING (it is the absence
  // of the clearing request, not a request to un-clear), so it cannot be proved and must be refused whole.
  for (const args of [{ address: 'A1:B2' }, { address: 'A1', clearFill: false }]) {
    const result = await toolWith(bridge).execute(args, cellCtx);
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.equal(result.code, 'TOOL_ERROR', JSON.stringify(args));
  }
  assert.equal(bridge.calls.formatCells, 0, 'an empty formatting request never reaches the bridge');
});

test('an unsupported or unknown property refuses the WHOLE request, and a mixed one changes nothing', async () => {
  // Each of these was measured and EXCLUDED (docs/evidence/sprint-4/t4.0-format-range-evidence.md): they have a
  // setter but no public readback that can prove the application, so they cannot be attributed honestly. The
  // mixed case is the rule that matters most: a request that also asks for something provable must NOT be
  // applied partially — nothing at all may be written.
  const bridge = bridgeWith({});
  const tool = toolWith(bridge);
  const cases = [
    [{ address: 'A1', fontColor: '#FF0000' }, 'font colour'],
    [{ address: 'A1', horizontalAlignment: 'center' }, 'horizontal alignment'],
    [{ address: 'A1', verticalAlignment: 'center' }, 'vertical alignment'],
    [{ address: 'A1', borders: 'thin' }, 'borders'],
    [{ address: 'A1', autofit: true }, 'autofit'],
    [{ address: 'A1', shade: '#FFFFFF' }, 'an unknown property'],
    [{ address: 'A1', bold: true, signal: undefined }, 'a key from the internal call class, which is not an argument'],
    [{ address: 'A1', bold: true, fontColor: '#FF0000' }, 'a MIXED request (provable + unsupported)'],
    [{ address: 'A1', fontSize: 14, borders: 'thin', italic: true }, 'a mixed request with two provable properties']
  ];
  for (const [args, why] of cases) {
    const result = await tool.execute(args, cellCtx);
    assert.equal(result.ok, false, why);
    assert.equal(result.code, 'TOOL_ERROR', why);
  }
  assert.equal(bridge.calls.formatCells, 0, 'nothing refused ever reached the bridge');
});

test('the discriminated numberFormat enforces its own rule', async () => {
  const bridge = bridgeWith({});
  const tool = toolWith(bridge);
  const cases = [
    [{ address: 'A1', numberFormat: { type: 'currency' } }, 'currency without a currency code'],
    [{ address: 'A1', numberFormat: { type: 'currency', currency: 'GBP' } }, 'a currency nobody measured'],
    [{ address: 'A1', numberFormat: { type: 'number', currency: 'RUB' } }, 'currency on a number type'],
    [{ address: 'A1', numberFormat: { type: 'percent', currency: 'USD' } }, 'currency on a percent type'],
    [{ address: 'A1', numberFormat: { type: 'custom' } }, 'an unmeasured family'],
    [{ address: 'A1', numberFormat: { type: 'number', decimals: LIMITS.formatRangeDecimalsMax + 1 } }, 'too many decimals'],
    [{ address: 'A1', numberFormat: { type: 'number', decimals: -1 } }, 'a negative decimal count'],
    [{ address: 'A1', numberFormat: {} }, 'no type at all']
  ];
  for (const [args, why] of cases) {
    const result = await tool.execute(args, cellCtx);
    assert.equal(result.ok, false, why);
    assert.equal(result.code, 'TOOL_ERROR', why);
  }
  assert.equal(bridge.calls.formatCells, 0, 'nothing refused ever reached the bridge');
  // The three measured currency codes are accepted, and the request crosses unchanged.
  for (const currency of ['RUB', 'USD', 'EUR']) {
    const accepted = bridgeWith({});
    const result = await toolWith(accepted).execute({ address: 'A1', numberFormat: { type: 'currency', currency, decimals: 2 } }, cellCtx);
    assert.equal(result.ok, true, currency);
    assert.deepEqual(accepted.requests[0].numberFormat, { type: 'currency', currency, decimals: 2 });
  }
});

test('every value bound is the MEASURED one, and each is refused before any dispatch', async () => {
  const bridge = bridgeWith({});
  const tool = toolWith(bridge);
  const cases = [
    [{ address: 'A1', fontSize: 0 }, 'font size below one'],
    [{ address: 'A1', fontSize: LIMITS.formatRangeFontSizeMax + 1 }, 'font size above the measured maximum'],
    [{ address: 'A1', columnWidth: 0 }, 'a zero column width'],
    [{ address: 'A1', columnWidth: LIMITS.formatRangeColumnWidthMax + 1 }, 'a column width the engine clamps'],
    [{ address: 'A1', rowHeight: 0 }, 'a zero row height'],
    // 401 is the measured CLAMP boundary: the engine answered 409.5 for 500, so anything above 400 is a value
    // whose readback cannot be predicted and must never be requested.
    [{ address: 'A1', rowHeight: LIMITS.formatRangeRowHeightMax + 1 }, 'a row height above the measured ceiling'],
    [{ address: 'A1', fontFamily: 'x'.repeat(LIMITS.formatRangeFontFamilyBytes + 1) }, 'an over-wide family name'],
    [{ address: 'A1', fontFamily: '' }, 'an empty family name'],
    [{ address: 'A1', fill: 'FF0000' }, 'a colour without the leading hash'],
    [{ address: 'A1', fill: '#GGGGGG' }, 'a colour that is not hexadecimal'],
    [{ address: 'A1', fill: '#FFF' }, 'a short colour'],
    [{ address: 'A1', bold: 'yes' }, 'a non-boolean flag'],
    [{ address: 'A1', fill: '#FF0000', clearFill: true }, 'setting and clearing a fill in one request']
  ];
  for (const [args, why] of cases) {
    const result = await tool.execute(args, cellCtx);
    assert.equal(result.ok, false, why);
    assert.equal(result.code, 'TOOL_ERROR', why);
  }
  assert.equal(bridge.calls.formatCells, 0, 'nothing refused ever reached the bridge');
});

test('the value bounds accepted at their exact measured edges', async () => {
  const edges = [
    { fontSize: 1 }, { fontSize: LIMITS.formatRangeFontSizeMax }, { columnWidth: 1 },
    { columnWidth: LIMITS.formatRangeColumnWidthMax }, { rowHeight: 1 },
    { rowHeight: LIMITS.formatRangeRowHeightMax }, { fontFamily: 'Times New Roman' },
    { fill: '#000000' }, { fill: '#ffffff' }, { bold: false },
    { italic: true }, { wrapText: true }, { numberFormat: { type: 'number' } },
    { numberFormat: { type: 'number', decimals: 0 } },
    { numberFormat: { type: 'percent', decimals: LIMITS.formatRangeDecimalsMax } }
  ];
  for (const extra of edges) {
    const bridge = bridgeWith({});
    const result = await toolWith(bridge).execute({ address: 'A1', ...extra }, cellCtx);
    assert.equal(result.ok, true, JSON.stringify(extra));
    assert.equal(bridge.calls.formatCells, 1, JSON.stringify(extra));
  }
});

test('the cell cap is the measured 400 and an over-cap block never dispatches', async () => {
  const over = bridgeWith({});
  const refused = await toolWith(over).execute({ address: `A1:A${LIMITS.formatRangeCellsMax + 1}`, bold: true }, cellCtx);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'TOOL_ERROR');
  assert.equal(over.calls.formatCells, 0, 'an over-cap block never reaches the bridge');

  const at = bridgeWith({});
  const servedAtCap = await toolWith(at).execute({ address: `A1:A${LIMITS.formatRangeCellsMax}`, bold: true }, cellCtx);
  assert.equal(servedAtCap.ok, true);
  assert.deepEqual(servedAtCap.data, { address: `A1:A${LIMITS.formatRangeCellsMax}`, rowCount: LIMITS.formatRangeCellsMax,
    columnCount: 1, properties: 1 });

  // The cap is on CELLS, not on rows: a 21 x 20 block is 420 cells and must be refused even though each
  // dimension alone is modest.
  const wide = bridgeWith({});
  const refusedWide = await toolWith(wide).execute({ address: 'A1:T21', bold: true }, cellCtx);
  assert.equal(refusedWide.code, 'TOOL_ERROR');
  assert.equal(wide.calls.formatCells, 0);
});

test('the address class is the closed one every Cell leg shares', async () => {
  const bridge = bridgeWith({});
  const tool = toolWith(bridge);
  const cases = [
    [{ bold: true }, 'no address'],
    [{ address: 'a1', bold: true }, 'lower case'],
    [{ address: 'Sheet1!A1', bold: true }, 'a sheet-qualified address'],
    [{ address: 'A0', bold: true }, 'row zero'],
    [{ address: '1A', bold: true }, 'a reversed address'],
    [{ address: '', bold: true }, 'an empty address'],
    [{ address: 'A1', numberFormat: null }, 'a null number format']
  ];
  for (const [args, why] of cases) {
    const result = await tool.execute(args, cellCtx);
    assert.equal(result.ok, false, why);
  }
  assert.equal(bridge.calls.formatCells, 0, 'nothing refused ever reached the bridge');
});

test('the geometry properties are the ones that make a block one call', async () => {
  const bridge = bridgeWith({});
  const result = await toolWith(bridge).execute({ address: 'A1:C4', columnWidth: 24, rowHeight: 30 }, cellCtx);
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { address: 'A1:C4', rowCount: 4, columnCount: 3, properties: 2 });
  assert.deepEqual(bridge.requests[0], { address: 'A1:C4', columnWidth: 24, rowHeight: 30 });
});

test('a bridge whose envelope describes another format is a known refusal', async () => {
  // The envelope is re-checked here, so a bridge that drifted can never publish a format of another shape,
  // another block, or another property count as this call's result.
  const cases = [
    [{ address: 'A1:C5', rowCount: 4, columnCount: 3, properties: 2 }, 'a drifted address'],
    [{ address: 'A1:C4', rowCount: 3, columnCount: 3, properties: 2 }, 'drifted row count'],
    [{ address: 'A1:C4', rowCount: 4, columnCount: 4, properties: 2 }, 'drifted column count'],
    [{ address: 'A1:C4', rowCount: 4, columnCount: 3, properties: 99 }, 'a drifted property count'],
    [{ address: 'A1:C4', rowCount: 4, columnCount: 3 }, 'no property count at all']
  ];
  for (const [answer, why] of cases) {
    const bridge = bridgeWith(answer);
    const result = await toolWith(bridge).execute({ address: 'A1:C4', columnWidth: 24, rowHeight: 30 }, cellCtx);
    assert.equal(result.ok, false, why);
    assert.equal(result.code, 'TOOL_ERROR', why);
  }
});

test('a bridge without the method refuses as a capability, and a non-object answer is a known error', async () => {
  const absent = { calls: {} };
  const missing = await toolWith(absent).execute({ address: 'A1', bold: true }, cellCtx);
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'CAPABILITY_UNAVAILABLE');

  const nonsense = bridgeWith(null);
  const result = await toolWith(nonsense).execute({ address: 'A1', bold: true }, cellCtx);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TOOL_ERROR');
});

test('a non-Cell editor is refused by the precondition with nothing dispatched', async () => {
  // The precondition is the registry's own gate, applied BEFORE the handler runs, which is why it is checked
  // through the descriptor rather than by calling the handler with a strange context.
  const bridge = bridgeWith({});
  const tool = toolWith(bridge);
  assert.equal(tool.precondition({ address: 'A1', bold: true }, cellCtx), null);
  const refused = tool.precondition({ address: 'A1', bold: true }, { editor: 'word' });
  assert.equal(refused.code, 'CAPABILITY_UNAVAILABLE');
  assert.equal(bridge.calls.formatCells, 0, 'no dispatch happened while the gate was decided');
});

test('a stray key INSIDE numberFormat is refused, never silently dropped', async () => {
  // The closed key set is closed at BOTH levels: a `symbol` (or any other stray key) inside `numberFormat`
  // would otherwise be dropped and the request served as if it had been understood, which is the partial
  // understanding this descriptor promises not to have. The runtime's schema refuses it too; a descriptor is
  // executable when held directly, so the rule is stated here.
  const bridge = bridgeWith({});
  const tool = toolWith(bridge);
  for (const numberFormat of [{ type: 'number', symbol: '$' }, { type: 'currency', currency: 'RUB', extra: 1 }]) {
    const result = await tool.execute({ address: 'A1', numberFormat }, cellCtx);
    assert.equal(result.ok, false, JSON.stringify(numberFormat));
    assert.equal(result.code, 'TOOL_ERROR', JSON.stringify(numberFormat));
  }
  assert.equal(bridge.calls.formatCells, 0, 'nothing refused ever reached the bridge');
});

test('the published entry and the description stay inside their own byte bounds', async () => {
  // The tool measures its own result ENTRY against `AGENT_CEILINGS.toolResultBytes` before publishing — the
  // shape the runtime serializes — and this pins the number, so a future widened result cannot quietly exceed
  // the ceiling. The description bound is enforced by `defineTool` at load time (which every test here proves by
  // loading the catalogue) and is stated explicitly here as well, because a descriptor is also the model's
  // contract and not only a schema.
  const bridge = bridgeWith({});
  const result = await toolWith(bridge).execute({ address: 'A1:C4', columnWidth: 24, rowHeight: 30 }, cellCtx);
  assert.equal(result.ok, true);
  const entry = JSON.stringify({ tool: 'format_cells', ok: true, data: result.data });
  assert.ok(utf8ByteLength(entry) <= AGENT_CEILINGS.toolResultBytes, entry);

  const tool = toolWith(bridgeWith({}));
  assert.ok(tool.description.trim().length > 0);
  assert.equal(/[\u0000-\u001f\u007f]/.test(tool.description), false, 'one authored line, never a control character');
  assert.ok(utf8ByteLength(tool.description) <= 256, 'TOOL_DESCRIPTION_BYTES is 256');
});

// ---------------------------------------------------------------------------------------------------------
// THE SHEET SELECTOR on `format_cells` (T5.3c): the same two closed spellings, on the second mutation.
// ---------------------------------------------------------------------------------------------------------
test('format_cells offers the sheet selector as two optional, closed spellings', () => {
  const tool = toolWith(bridgeWith({}));
  assert.equal(tool.schema.additionalProperties, false);
  for (const key of ['address', 'sheet', 'sheetIndex']) assert.ok(key in tool.schema.properties, key);
  assert.deepEqual(tool.schema.required, ['address'], 'the address is still the only required argument');
  assert.equal(tool.schema.properties.sheet.maxBytes, LIMITS.sheetListNameBytes);
  assert.equal(tool.schema.properties.sheetIndex.maximum, LIMITS.sheetListMax - 1);
  assert.equal(tool.schema.properties.sheetIndex.minimum, 0);
});

test('format_cells forwards the selector, and index ZERO is a selector rather than an absent one', async () => {
  const plain = bridgeWith({});
  await toolWith(plain).execute({ address: 'A1', bold: true }, cellCtx);
  // A request that names no sheet must stay BYTE-IDENTICAL to what it always was: the selector keys are absent,
  // not present-and-null, which is this leg's own convention for every other optional property.
  assert.equal('sheetName' in plain.requests[0], false);
  assert.equal('sheetIndex' in plain.requests[0], false);

  const byName = bridgeWith({});
  await toolWith(byName).execute({ address: 'A1', bold: true, sheet: 'Данные' }, cellCtx);
  assert.equal(byName.requests[0].sheetName, 'Данные');
  assert.equal('sheetIndex' in byName.requests[0], false);

  const zero = bridgeWith({});
  await toolWith(zero).execute({ address: 'A1', bold: true, sheetIndex: 0 }, cellCtx);
  assert.equal(zero.requests[0].sheetIndex, 0, 'a zero index must cross as 0, never as null');
  assert.equal('sheetName' in zero.requests[0], false);
});

test('format_cells refuses an ambiguous or out-of-contract selector BEFORE any dispatch', async () => {
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
    const bridge = bridgeWith({});
    const result = await toolWith(bridge).execute({ address: 'A1', bold: true, ...selector }, cellCtx);
    assert.equal(result.ok, false, why);
    assert.equal(result.code, 'TOOL_ERROR', why);
    assert.equal(bridge.calls.formatCells, 0, `${why}: a mutation must not be dispatched`);
  }
  // A name exactly AT the bound is a valid selector, so the bound is not off by one.
  const served = bridgeWith({});
  assert.equal((await toolWith(served).execute({ address: 'A1', bold: true, sheet: exact }, cellCtx)).ok, true);
  assert.equal(served.calls.formatCells, 1);
});

test('the SELECTOR alone is not a formatting property, and the T4 rule still holds', async () => {
  // `format_cells` requires at least one FORMATTING property; naming a sheet is not one, so a request that only
  // selects a sheet must still be refused with nothing dispatched — the T4 contract, unchanged.
  const bridge = bridgeWith({});
  const result = await toolWith(bridge).execute({ address: 'A1', sheet: 'Данные' }, cellCtx);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TOOL_ERROR');
  assert.equal(bridge.calls.formatCells, 0, 'a sheet-only request never reaches the editor');
});

test('the formatting DESCRIPTION names the sheet arguments the model reads', async () => {
  // The description is the only MODEL-FACING field: the schema is validation-only and never rendered, so a
  // selector it does not name is undiscoverable. This asserts CONTENT, not merely that a description exists.
  const tool = toolWith(bridgeWith({}));
  assert.match(tool.description, /sheet\s*—/, 'names the sheet argument');
  assert.match(tool.description, /sheetIndex\s*—/, 'names the index argument');
  assert.ok(utf8ByteLength(tool.description) <= 256, 'and stays inside the model-facing byte bound');
});
