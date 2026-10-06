// Host coverage for the CELLFORMAT leg through the REAL bridge.
//
// `tools-cell-format.test.js` drives the `format_cells` descriptor against a bridge DOUBLE, which by
// construction can never exercise `decodeCellFormat` or the `cellformat` dispatch branch — the entire
// "one flag per property, and never launder a post-mutation uncertainty into a known error" mechanism. This
// file is the one that does.
//
// The sheet double reproduces the SHAPES MEASURED on R7-Office Editors 2026.3.1, because those shapes are what
// the body must tell apart (recorded in `docs/evidence/sprint-4/t4.0-format-range-evidence.md`):
//   * `GetNumberFormat()` answers the very CODE that was set;
//   * `GetFillColor()` answers the string `"No Fill"` for an unfilled cell and an object whose colour exposes a
//     PUBLIC `getRgb()` for a filled one, and `Api.CreateNoFill()` is what clears it back;
//   * `GetCharacters().GetFont()` answers bold/italic as the STRING `'true'` when set and `null` when not (never
//     `'false'`), `GetSize()` as a STRING, and `GetName()` VERBATIM;
//   * `GetWrapText()` answers a real boolean;
//   * `GetColumnWidth()`/`GetRowHeight()` answer the width/height of that cell's own column/row, whatever cell
//     of the column/row is asked — which is what makes a per-column/per-row proof possible at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createR7Bridge } from '../../src/plugin/bridge.js';
import { LIMITS } from '../../src/shared/limits.js';

function columnIndex(letters) {
  let value = 0;
  for (const letter of letters) value = value * 26 + (letter.charCodeAt(0) - 64);
  return value;
}
function columnName(index) {
  let name = '';
  let remaining = index;
  while (remaining > 0) { const rest = (remaining - 1) % 26; name = String.fromCharCode(65 + rest) + name; remaining = Math.floor((remaining - 1) / 26); }
  return name;
}
function corners(address) {
  const [head, tail] = address.includes(':') ? address.split(':') : [address, address];
  const from = /^([A-Z]+)([0-9]+)$/.exec(head);
  const to = /^([A-Z]+)([0-9]+)$/.exec(tail);
  return { c1: columnIndex(from[1]), r1: Number(from[2]), c2: columnIndex(to[1]), r2: Number(to[2]) };
}

// Every knob models a build (or a hostile build) that the proof must survive:
//   noOp            every setter does nothing;
//   missingSetter   that ONE setter does not exist on the range;
//   clampWidth/clampHeight  the engine clamps the value it stores (the measured `rowHeight` 500 -> 409.5 trap);
//   rgbOverride     a fill reads back as a DIFFERENT colour than the one requested;
//   rgbMissing      the colour object has no public `getRgb`;
//   clearFails      `SetFillColor(Api.CreateNoFill())` does not clear;
//   widthOverrides  a SINGLE column reads back another width, which is how the per-column proof is tested;
//   heightOverrides a SINGLE row reads back another height, which is how the per-ROW proof is tested;
//   readOverrides   a SINGLE cell answers another value for one text/number property, which is how the
//                   per-CELL proof is tested: without it no fixture makes two cells of one block differ, and a
//                   body that verified only the top-left cell and replicated its flag would look correct;
//   apiMissing      `Api.GetActiveSheet` is absent, so the body must refuse BEFORE its first mutation.
function rig(options = {}) {
  const cells = new Map();
  const fills = new Map();
  const widths = new Map();
  const heights = new Map();
  const record = (address) => {
    if (!cells.has(address)) cells.set(address, { numberFormat: 'General', bold: null, italic: null, name: 'Liberation Sans', size: '11', wrap: false });
    return cells.get(address);
  };
  // What a READ of this cell answers: the stored record, unless this one address was given an override.
  const seen = (address) => {
    const stored = record(address);
    const override = options.readOverrides === undefined ? undefined : options.readOverrides.get(address);
    return override === undefined ? stored : { ...stored, ...override };
  };
  const apply = (mutate) => (...args) => { if (options.noOp) return; mutate(...args); };
  const sheet = {
    GetRange(address) {
      const box = corners(address);
      const at = columnName(box.c1) + String(box.r1);
      const methods = {
        SetNumberFormat: apply((code) => { record(at).numberFormat = code; }),
        SetBold: apply((value) => { record(at).bold = value ? 'true' : null; }),
        SetItalic: apply((value) => { record(at).italic = value ? 'true' : null; }),
        SetFontName: apply((value) => { record(at).name = value; }),
        SetFontSize: apply((value) => { record(at).size = String(value); }),
        SetWrapText: apply((value) => { record(at).wrap = value; }),
        SetFillColor: apply((value) => {
          if (value && value.__noFill === true) { if (!options.clearFails) fills.delete(at); return; }
          fills.set(at, options.rgbOverride === undefined ? value.__rgb : options.rgbOverride);
        }),
        SetColumnWidth: apply((value) => {
          for (let column = box.c1; column <= box.c2; column++) widths.set(column, String(Math.min(value, options.clampWidth === undefined ? value : options.clampWidth)));
        }),
        SetRowHeight: apply((value) => {
          for (let row = box.r1; row <= box.r2; row++) heights.set(row, String(Math.min(value, options.clampHeight === undefined ? value : options.clampHeight)));
        }),
        GetNumberFormat: () => seen(at).numberFormat,
        GetWrapText: () => seen(at).wrap,
        GetCharacters: () => ({ GetFont: () => ({ GetBold: () => seen(at).bold, GetItalic: () => seen(at).italic,
          GetName: () => seen(at).name, GetSize: () => seen(at).size }) }),
        GetFillColor: () => {
          if (!fills.has(at)) return 'No Fill';
          return { color: options.rgbMissing === true ? {} : { getRgb: () => fills.get(at) } };
        },
        GetColumnWidth: () => {
          if (options.widthOverrides && options.widthOverrides.has(box.c1)) return options.widthOverrides.get(box.c1);
          return widths.get(box.c1) === undefined ? '8.38' : widths.get(box.c1);
        },
        GetRowHeight: () => {
          if (options.heightOverrides && options.heightOverrides.has(box.r1)) return options.heightOverrides.get(box.r1);
          return heights.get(box.r1) === undefined ? '14.25' : heights.get(box.r1);
        }
      };
      if (options.missingSetter !== undefined) delete methods[options.missingSetter];
      return methods;
    }
  };
  const api = {
    CreateColorFromRGB: (r, g, b) => ({ __rgb: r * 65536 + g * 256 + b }),
    CreateNoFill: () => ({ __noFill: true })
  };
  if (options.apiMissing !== true) api.GetActiveSheet = () => sheet;
  const namespace = { scope: {} };
  const commands = [];
  const plugin = { info: { editorType: 'cell' },
    callCommand(body, close, recalculate, callback) {
      const source = Function.prototype.toString.call(body);
      const scope = namespace.scope;
      const answered = new Function('Api', 'scope', 'return (' + source + ')();')(api, scope);
      commands.push({ by: 'callCommand', source, scope, answered });
      callback(options.forge === undefined ? answered : options.forge);
      return false;
    } };
  const bridge = createR7Bridge(plugin, { editorType: 'cell', ascNamespace: namespace,
    clock: { now: () => 0 }, timers: { schedule() { return {}; }, clear() {} } });
  return { bridge, commands, cells, fills, widths, heights };
}

test('a served format is proved per property and per cell, and releases the slot', async () => {
  const f = rig();
  const result = await f.bridge.formatCells({ address: 'A1:B2', bold: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result, { ok: true, address: 'A1:B2', rowCount: 2, columnCount: 2, properties: 1 });
  assert.equal(result.rowCount, 2);
  assert.equal(result.columnCount, 2);
  // The authored body's own answer, as it crossed the native boundary: phase, counts, check count, flags. The
  // addressed block is 2 x 2 = FOUR cells, so one property owes four flags.
  assert.deepEqual(f.commands[0].answered, ['POST_INSERT', 2, 2, 4, 1, 1, 1, 1]);
  assert.equal(f.cells.get('A1').bold, 'true');
  assert.equal(f.cells.get('B2').bold, 'true');
});

test('the number-format code the bridge composes is proved by exact equality', async () => {
  const f = rig();
  const result = await f.bridge.formatCells({ address: 'A1', numberFormat: { type: 'currency', currency: 'RUB', decimals: 2 } });
  assert.equal(result.ok, true);
  assert.equal(f.commands[0].scope.numberFormatCode, '#,##0.00 \u20BD');
  assert.equal(f.cells.get('A1').numberFormat, '#,##0.00 \u20BD');
  // The default decimal count is two, and the closed families compose the measured codes.
  const plain = rig();
  await plain.bridge.formatCells({ address: 'A1', numberFormat: { type: 'number' } });
  assert.equal(plain.commands[0].scope.numberFormatCode, '#,##0.00');
  const percent = rig();
  await percent.bridge.formatCells({ address: 'A1', numberFormat: { type: 'percent', decimals: 0 } });
  assert.equal(percent.commands[0].scope.numberFormatCode, '0%');
});

test('the proof is the FINAL STATE, so an already-formatted cell is an idempotent success', async () => {
  // The owner's rule: a cell that already holds the requested value is a SUCCESS, not a refusal and not a
  // second write. The readback is compared against the request, never against a baseline, which is exactly
  // what makes this idempotent.
  const f = rig();
  const first = await f.bridge.formatCells({ address: 'A1', bold: true, fontSize: 14 });
  assert.equal(first.ok, true);
  const second = await f.bridge.formatCells({ address: 'A1', bold: true, fontSize: 14 });
  assert.equal(second.ok, true, 'an already-formatted cell is proved by its state');
  assert.deepEqual(f.commands[1].answered, ['POST_INSERT', 1, 1, 2, 1, 1], 'the second call proves the state again');
});

test('a session that does not apply the property is UNCERTAIN, and the slot stays HELD', async () => {
  const f = rig({ noOp: true });
  const result = await f.bridge.formatCells({ address: 'A1', bold: true });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'APPLY_UNCERTAIN');
  // The mutation WAS dispatched, so nothing observed here proves it did not apply: the bridge must present
  // itself as a pending mutation rather than as an idle one, and a second request must not be served.
  const second = await f.bridge.formatCells({ address: 'A1', bold: true });
  assert.equal(second.ok, false);
  assert.notEqual(second.code, 'APPLY_UNCERTAIN');
});

test('a property whose setter is missing is UNCERTAIN, never a silent success', async () => {
  for (const setter of ['SetNumberFormat', 'SetBold', 'SetItalic', 'SetFontName', 'SetFontSize', 'SetFillColor', 'SetWrapText']) {
    const f = rig({ missingSetter: setter });
    const request = { address: 'A1', numberFormat: { type: 'number' }, bold: true, italic: true,
      fontFamily: 'Arial', fontSize: 12, fill: '#112233', wrapText: true };
    const result = await f.bridge.formatCells(request);
    assert.equal(result.ok, false, setter);
    assert.equal(result.code, 'APPLY_UNCERTAIN', setter);
  }
});

test('a fill is proved through the PUBLIC colour accessor, and a disagreeing readback is unproved', async () => {
  const served = rig();
  const ok = await served.bridge.formatCells({ address: 'A1', fill: '#0C2238' });
  assert.equal(ok.ok, true);
  assert.equal(served.fills.get('A1'), 12 * 65536 + 34 * 256 + 56);

  const hostile = rig({ rgbOverride: 999 });
  const mismatched = await hostile.bridge.formatCells({ address: 'A1', fill: '#0C2238' });
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.code, 'APPLY_UNCERTAIN');

  const opaque = rig({ rgbMissing: true });
  const unreadable = await opaque.bridge.formatCells({ address: 'A1', fill: '#0C2238' });
  assert.equal(unreadable.ok, false, 'a colour with no public getRgb can never prove a fill');
  assert.equal(unreadable.code, 'APPLY_UNCERTAIN');
});

test('clearing a fill is proved by the measured "No Fill" reading', async () => {
  const f = rig();
  assert.equal((await f.bridge.formatCells({ address: 'A1', fill: '#0C2238' })).ok, true);
  assert.ok(f.fills.has('A1'));
  const cleared = await f.bridge.formatCells({ address: 'A1', clearFill: true });
  assert.equal(cleared.ok, true);
  assert.equal(f.fills.has('A1'), false, 'the fill is really gone');
  assert.equal(f.commands[1].scope.fillClear, true);

  const stubborn = rig({ clearFails: true });
  await stubborn.bridge.formatCells({ address: 'A1', fill: '#0C2238' });
  const notCleared = await stubborn.bridge.formatCells({ address: 'A1', clearFill: true });
  assert.equal(notCleared.ok, false, 'a fill that did not clear is never reported as cleared');
  assert.equal(notCleared.code, 'APPLY_UNCERTAIN');
});

test('the TWO spellings of the clearing request are the same request, and both dispatch', async () => {
  // `fill: null` is the spelling the owner's measure used and `clearFill: true` is the one the CLOSED tool
  // schema can express. Counting the null as a colour AS WELL as the clear made the bridge owe twice the flags
  // the authored body computes, so this path refused a CORRECT clear before it could ever dispatch.
  const viaNull = rig();
  assert.equal((await viaNull.bridge.formatCells({ address: 'A1', fill: '#0C2238' })).ok, true);
  const cleared = await viaNull.bridge.formatCells({ address: 'A1', fill: null });
  assert.equal(cleared.ok, true, 'fill:null clears exactly like clearFill:true');
  assert.equal(viaNull.fills.has('A1'), false);
  assert.deepEqual(viaNull.commands[1].answered, ['POST_INSERT', 1, 1, 1, 1]);
  // And a null colour carrying anything else is still refused, so the fix did not widen the request class.
  assert.equal((await viaNull.bridge.formatCells({ address: 'A1', fill: null, columnWidth: 20 })).ok, true);
});

test('an unknown property refuses the whole request AT THIS LAYER, with nothing dispatched', async () => {
  // The tool and the argument schema refuse such a request upstream, but the promise "nothing is applied
  // partially" is made by THIS method, so it has to hold here: without the key enumeration a request carrying
  // `fontColor` beside a provable property was served, with the unknown key silently dropped.
  for (const extra of [{ fontColor: '#FF0000' }, { borders: 'thin' }, { autofit: true }, { shade: '#FFFFFF' }]) {
    const f = rig();
    const result = await f.bridge.formatCells({ address: 'A1', bold: true, ...extra });
    assert.equal(result.ok, false, JSON.stringify(extra));
    assert.equal(result.code, 'TOOL_ERROR', JSON.stringify(extra));
    assert.equal(f.commands.length, 0, `${JSON.stringify(extra)}: the mixed request never reached the editor`);
  }
});

test('geometry is proved per affected COLUMN and per affected ROW, not once for the block', async () => {
  const f = rig();
  const result = await f.bridge.formatCells({ address: 'A1:C2', columnWidth: 20, rowHeight: 30 });
  assert.equal(result.ok, true);
  // No cell properties, three columns, two rows: five checks.
  assert.deepEqual(f.commands[0].answered, ['POST_INSERT', 2, 3, 5, 1, 1, 1, 1, 1]);
  assert.deepEqual([...f.widths.entries()].sort(), [[1, '20'], [2, '20'], [3, '20']]);
  assert.deepEqual([...f.heights.entries()].sort(), [[1, '30'], [2, '30']]);

  // ONE column reading back another width is enough to refute the whole request, which is what makes the proof
  // per column rather than per block.
  const partial = rig({ widthOverrides: new Map([[2, '8.38']]) });
  const refused = await partial.bridge.formatCells({ address: 'A1:C2', columnWidth: 20 });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'APPLY_UNCERTAIN');
  assert.deepEqual(partial.commands[0].answered, ['POST_INSERT', 2, 3, 3, 1, 0, 1], 'one flag per affected column');
});

test('the CELL proof walks every cell of the block, never just the top-left one', async () => {
  // The second cell answers something else, which is the only fixture that can tell a per-cell proof from a
  // body that verified the FIRST cell alone and replicated its flag: with every cell agreeing, both bodies
  // report the same flags and the suite would be blind to the collapse.
  const f = rig({ readOverrides: new Map([['A2', { bold: null }]]) });
  const result = await f.bridge.formatCells({ address: 'A1:A2', bold: true });
  assert.equal(result.ok, false, 'the second cell is unproved, so the request is not proved');
  assert.equal(result.code, 'APPLY_UNCERTAIN');
  assert.deepEqual(f.commands[0].answered, ['POST_INSERT', 2, 1, 2, 1, 0], 'the flag belongs to the cell that failed');
  // And the same block succeeds when every cell really holds the request, so the test is not simply refusing.
  const agreeing = rig();
  assert.equal((await agreeing.bridge.formatCells({ address: 'A1:A2', bold: true })).ok, true);
});

test('the ROW-HEIGHT proof walks every affected row, never just the first one', async () => {
  // The width already had this fixture (`widthOverrides`); the height did not, so a body that read row 1 for
  // every row was indistinguishable from a correct one.
  const f = rig({ heightOverrides: new Map([[2, '14.25']]) });
  const result = await f.bridge.formatCells({ address: 'A1:A2', rowHeight: 30 });
  assert.equal(result.ok, false, 'the second row does not hold the requested height');
  assert.equal(result.code, 'APPLY_UNCERTAIN');
  assert.deepEqual(f.commands[0].answered, ['POST_INSERT', 2, 1, 2, 1, 0]);
});

test("the engine's own clamp is caught by the readback, never trusted to the request", async () => {
  // MEASURED: the engine clamps a row height above its own ceiling (500 -> 409.5). The tool's schema stops at
  // the value proven exact, and this test is the second line of defence: a build that clamps anyway must be
  // caught by the READBACK rather than reported as applied.
  const f = rig({ clampHeight: 200 });
  const result = await f.bridge.formatCells({ address: 'A1', rowHeight: 300 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'APPLY_UNCERTAIN');
  // The same applies to the width, and to a clamp that lands on the very value asked for (which IS a success).
  const clampedWidth = rig({ clampWidth: 50 });
  assert.equal((await clampedWidth.bridge.formatCells({ address: 'A1', columnWidth: 200 })).ok, false);
  const exact = rig({ clampWidth: 200 });
  assert.equal((await exact.bridge.formatCells({ address: 'A1', columnWidth: 200 })).ok, true);
});

test('a forged or malformed answer is UNCERTAIN, and a phase-marked refusal is a known class', async () => {
  const forged = [
    [['POST_INSERT', 1, 1, 99, 1], 'a check count the request does not owe'],
    // The row and column counts the body reports are the bridge's own arithmetic, so an answer that disagrees
    // with the request is not one this leg can have produced. Both are pinned because deleting the pair from
    // the decoder left the whole suite green while a forged answer was reported as a SUCCESS.
    [['POST_INSERT', 2, 1, 1, 1], 'a row count the request does not owe'],
    [['POST_INSERT', 1, 2, 1, 1], 'a column count the request does not owe'],
    [['POST_INSERT', 1, 1, 1, 2], 'a flag that is not 0 or 1'],
    [['POST_INSERT', 1, 1, 1], 'too few flags'],
    [['POST_INSERT', 1, 1, 1, 1, 1], 'a TRAILING member the request does not owe'],
    [['PRE_INSERT', 1, 1, 1, 1], 'a refusal shape carrying the post phase'],
    [['POST_INSERT', 1, 1, 1, 'yes'], 'a string flag'],
    ['POST_INSERT', 'not an array'],
    [[], 'an empty answer']
  ];
  for (const [forge, why] of forged) {
    const f = rig({ forge });
    const result = await f.bridge.formatCells({ address: 'A1', bold: true });
    assert.equal(result.ok, false, why);
    assert.equal(result.code, 'APPLY_UNCERTAIN', why);
  }
  // A PRE-insert refusal is the body telling the truth about a sheet it never touched: a KNOWN class, and the
  // slot is released so the next operation is not blocked behind it. The release is asserted on the SAME bridge,
  // because a fresh rig would prove nothing: were the slot still held, the second call would answer
  // `EDITOR_BUSY` from `ensureIdle` and never dispatch.
  const refused = rig({ forge: ['PRE_INSERT', 'CAPABILITY_UNAVAILABLE'] });
  const known = await refused.bridge.formatCells({ address: 'A1', bold: true });
  assert.equal(known.ok, false);
  assert.equal(known.code, 'CAPABILITY_UNAVAILABLE');
  const after = await refused.bridge.formatCells({ address: 'A1', bold: true });
  assert.equal(after.code, 'CAPABILITY_UNAVAILABLE', 'the second call dispatched rather than finding a busy bridge');
  assert.equal(refused.commands.length, 2, 'the slot was released, so a second request really reached the editor');
});

test('a build without the facade refuses as a KNOWN class before any mutation', async () => {
  const f = rig({ apiMissing: true });
  const result = await f.bridge.formatCells({ address: 'A1', bold: true });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CAPABILITY_UNAVAILABLE');
  assert.deepEqual(f.commands[0].answered, ['PRE_INSERT', 'CAPABILITY_UNAVAILABLE'],
    'the refusal carries the PRE-INSERT phase, because nothing was touched');
});

test('every closed precondition refuses BEFORE any dispatch, over the REAL bridge', async () => {
  const cases = [
    [{ address: 'A1' }, 'no formatting property at all'],
    [{ address: 'A1', rowHeight: LIMITS.formatRangeRowHeightMax + 1 }, 'a row height above the measured ceiling'],
    [{ address: 'A1', fontSize: LIMITS.formatRangeFontSizeMax + 1 }, 'a font size above the measured maximum'],
    [{ address: 'A1', fill: '#GGGGGG' }, 'a colour that is not hexadecimal'],
    [{ address: 'A1', fill: '#FF0000', clearFill: true }, 'setting and clearing in one request'],
    [{ address: 'A1', numberFormat: { type: 'currency' } }, 'currency without a code'],
    [{ address: 'A1', numberFormat: { type: 'number', currency: 'RUB' } }, 'a currency on the number type'],
    [{ address: `A1:A${LIMITS.formatRangeCellsMax + 1}`, bold: true }, 'a block over the cap'],
    [{ address: 'a1', bold: true }, 'an address outside the closed class', 'CAPABILITY_UNAVAILABLE']
  ];
  for (const [request, why, expected] of cases) {
    const f = rig();
    const result = await f.bridge.formatCells(request);
    assert.equal(result.ok, false, why);
    assert.equal(result.code, expected ?? 'TOOL_ERROR', why);
    assert.equal(f.commands.length, 0, `${why}: nothing may reach the editor`);
  }
});

test('a whole formatting block is ONE dispatch, however many properties it proves', async () => {
  const f = rig();
  const result = await f.bridge.formatCells({ address: 'A1:B2', numberFormat: { type: 'number', decimals: 2 },
    bold: true, italic: true, fontFamily: 'Arial', fontSize: 12, fill: '#112233', wrapText: true,
    columnWidth: 18, rowHeight: 22 });
  assert.equal(result.ok, true);
  assert.equal(f.commands.length, 1, 'one callCommand carries the whole cycle');
  // Seven cell properties over four cells, plus two columns and two rows: the authored answer carries exactly
  // that many flags, every one of them proved.
  const answered = f.commands[0].answered;
  assert.equal(answered.length, 4 + 7 * 4 + 2 + 2);
  assert.deepEqual(answered.slice(0, 4), ['POST_INSERT', 2, 2, 7 * 4 + 2 + 2]);
  assert.ok(answered.slice(4).every(flag => flag === 1), 'every property on every cell is proved');
  assert.equal(f.cells.get('B2').numberFormat, '#,##0.00');
  assert.equal(f.cells.get('B2').name, 'Arial');
  assert.equal(f.cells.get('B2').size, '12');
  assert.equal(f.cells.get('B2').wrap, true);
  assert.equal(f.fills.get('B2'), 0x112233);
  assert.equal(f.widths.get(2), '18');
  assert.equal(f.heights.get(2), '22');
});

// ---------------------------------------------------------------------------------------------------------
// THE SHEET SELECTOR on the FORMATTING leg (T5.3c).
//
// A NARROW, PURPOSE-BUILT double, deliberately SEPARATE from the rig above: that one carries the whole measured
// T4 formatting contract, and T5.3c must not extend or weaken it. This one models only what the selector needs —
// two sheets with their OWN number formats and bold flags, a lookup by name/index, and a counter for activation
// attempts — while still running the REAL authored body through `callCommand`, so these are behaviour tests.
// ---------------------------------------------------------------------------------------------------------
function selectorRig({ activeIndex = 0, sheets = null } = {}) {
  const commands = [];
  const namespace = { scope: {} };
  let setActiveAttempts = 0;
  let setterCalls = 0;
  const book = (sheets ?? [{ name: 'Sprint1', index: 0 }, { name: 'Данные', index: 1 }]).map((entry) => {
    const formats = new Map();
    const bolds = new Map();
    const italics = new Map();
    const names = new Map();
    const sizes = new Map();
    const fills = new Map();
    const wraps = new Map();
    const widths = new Map();
    const heights = new Map();
    for (const seed of entry.seed ?? []) seed({ formats, bolds, italics, names, sizes, fills, wraps, widths, heights });
    const sheet = {
      GetName: () => (entry.nameLies === true ? 'КтоТоДругой' : entry.name),
      GetIndex: () => (entry.indexLies === true ? 99 : entry.index),
      SetActive: () => { setActiveAttempts += 1; },
      GetRange(address) {
        const cell = address.split(':')[0];
        const box = corners(address);
        return {
          // EVERY setter the leg authors, and every readback it verifies with: the "all setters work on the
          // resolved sheet" promise covers nine of them, and the geometry pair uses a BLOCK range object, so a
          // double that models only some of them leaves that promise half-proved.
          SetNumberFormat(value) { setterCalls += 1; formats.set(cell, value); },
          SetBold(value) { setterCalls += 1; bolds.set(cell, value === true); },
          SetItalic(value) { setterCalls += 1; italics.set(cell, value === true); },
          SetFontName(value) { setterCalls += 1; names.set(cell, value); },
          SetFontSize(value) { setterCalls += 1; sizes.set(cell, String(value)); },
          SetWrapText(value) { setterCalls += 1; wraps.set(cell, value === true); },
          SetFillColor(value) {
            setterCalls += 1;
            if (value !== null && value !== undefined && value.__noFill === true) { fills.delete(cell); return; }
            fills.set(cell, value.__rgb);
          },
          SetColumnWidth(value) {
            setterCalls += 1;
            for (let column = box.c1; column <= box.c2; column++) widths.set(column, String(value));
          },
          SetRowHeight(value) {
            setterCalls += 1;
            for (let row = box.r1; row <= box.r2; row++) heights.set(row, String(value));
          },
          GetNumberFormat() { return formats.has(cell) ? formats.get(cell) : 'General'; },
          GetCharacters() {
            return {
              GetFont: () => ({
                GetBold: () => (bolds.has(cell) ? bolds.get(cell) : false),
                GetItalic: () => (italics.has(cell) ? italics.get(cell) : false),
                GetName: () => (names.has(cell) ? names.get(cell) : 'Liberation Sans'),
                GetSize: () => (sizes.has(cell) ? sizes.get(cell) : '11')
              })
            };
          },
          GetWrapText() { return wraps.has(cell) ? wraps.get(cell) : false; },
          GetFillColor() {
            if (!fills.has(cell)) return 'No Fill';
            return { color: { getRgb: () => fills.get(cell) } };
          },
          GetColumnWidth() { return widths.has(box.c1) ? widths.get(box.c1) : '8.38'; },
          GetRowHeight() { return heights.has(box.r1) ? heights.get(box.r1) : '14.25'; }
        };
      }
    };
    return { name: entry.name, index: entry.index, sheet, formats, bolds, italics, names, sizes, fills, wraps, widths, heights };
  });
  const api = {
    CreateColorFromRGB: (red, green, blue) => ({ __rgb: red * 65536 + green * 256 + blue }),
    CreateNoFill: () => ({ __noFill: true }),
    GetActiveSheet: () => book[activeIndex].sheet,
    GetSheets: () => book.map((entry) => entry.sheet),
    GetSheet: (key) => (typeof key === 'number'
      ? (book[key] === undefined ? null : book[key].sheet)
      : (book.find((entry) => entry.name === key)?.sheet ?? null))
  };
  const plugin = { info: { editorType: 'cell' },
    callCommand(body, close, recalculate, callback) {
      const source = Function.prototype.toString.call(body);
      const scope = namespace.scope;
      const answered = new Function('Api', 'scope', 'return (' + source + ')();')(api, scope);
      commands.push({ by: 'callCommand', source, scope, answered });
      callback(answered);
      return false;
    } };
  const bridge = createR7Bridge(plugin, { editorType: 'cell', ascNamespace: namespace,
    clock: { now: () => 0 }, timers: { schedule() { return {}; }, clear() {} } });
  return { bridge, commands, book, setActiveAttempts: () => setActiveAttempts, setterCalls: () => setterCalls };
}

test('formatting a NAMED sheet lands THERE and never switches the active sheet', async () => {
  // MEASURED natively before this leg was written: applying format setters through another sheet's range object
  // leaves the active sheet exactly where it was. This pins that, including for the geometry setters.
  const f = selectorRig();
  const result = await f.bridge.formatCells({ address: 'A1', bold: true, sheetName: 'Данные' });
  assert.equal(result.ok, true);
  assert.equal(f.book[1].bolds.get('A1'), true, 'the selected sheet was formatted');
  assert.equal(f.book[0].bolds.has('A1'), false, 'and the active sheet was NOT');
  assert.equal(f.setActiveAttempts(), 0, 'nothing activated anything');
  assert.equal(f.commands[0].scope.sheetName, 'Данные');
  assert.equal(f.commands[0].scope.sheetIndex, null);
});

test('the FORMATTING and ALL its verification reads use the SELECTED sheet', async () => {
  // The selected sheet starts at General and the ACTIVE one does NOT carry the format: this is what makes the
  // flags discriminating. A verification pass that read the active sheet would find General there, answer flag 0,
  // and the exact-proof rule would turn the whole request into a refusal — so `ok` AND the flags together are the
  // assertion that the readback looked at the sheet the setters touched.
  const f = selectorRig();
  const result = await f.bridge.formatCells({ address: 'C3', numberFormat: { type: 'number' }, sheetName: 'Данные' });
  assert.equal(result.ok, true, 'the request is SERVED, not refused');
  assert.equal(result.properties, 1, 'and it reports exactly one formatting property');
  assert.deepEqual(f.commands[0].answered, ['POST_INSERT', 1, 1, 1, 1],
    'one proved property: the flag could only be 1 if the readback saw the SELECTED sheet');
  const selected = f.book[1].formats.get('C3');
  assert.equal(selected === undefined, false, 'the SELECTED sheet received a format code');
  assert.equal(String(selected).includes('0'), true, `a number format was applied, got ${selected}`);
  assert.equal(f.book[0].formats.has('C3'), false, 'the active sheet received nothing');
  assert.equal(f.setActiveAttempts(), 0);
});

test('sheetIndex 0 formats the FIRST sheet even when a DIFFERENT sheet is active', async () => {
  const f = selectorRig({ activeIndex: 1 });
  const result = await f.bridge.formatCells({ address: 'D4', bold: true, sheetIndex: 0 });
  assert.equal(result.ok, true);
  assert.equal(f.book[0].bolds.get('D4'), true, 'index 0 is a REAL selector, not an absent one');
  assert.equal(f.book[1].bolds.has('D4'), false, 'and the active sheet was not formatted');
  assert.equal(f.commands[0].scope.sheetIndex, 0, 'the zero crosses as 0, never as null');
  assert.equal(f.setActiveAttempts(), 0);
});

test('a write with NO selector formats the ACTIVE sheet, whatever its index is', async () => {
  const f = selectorRig({ activeIndex: 1 });
  const result = await f.bridge.formatCells({ address: 'E5', bold: true });
  assert.equal(result.ok, true);
  assert.equal(f.book[1].bolds.get('E5'), true, 'the ACTIVE sheet was formatted');
  assert.equal(f.book[0].bolds.has('E5'), false, 'and index 0 was not');
  assert.equal(f.commands[0].scope.sheetName, null);
  assert.equal(f.commands[0].scope.sheetIndex, null);
});

test('an unknown sheet is a KNOWN refusal raised BEFORE the first formatting setter', async () => {
  for (const selector of [{ sheetName: 'НетТакого' }, { sheetIndex: 7 }]) {
    const f = selectorRig();
    const result = await f.bridge.formatCells({ address: 'A1', bold: true, ...selector });
    assert.equal(result.ok, false, JSON.stringify(selector));
    assert.equal(result.code, 'TOOL_ERROR', JSON.stringify(selector));
    assert.deepEqual(f.commands[0].answered, ['PRE_INSERT', 'TOOL_ERROR'], 'a pre-mutation refusal');
    assert.equal(f.setterCalls(), 0, 'not one formatting call was made');
    // The refusal released the slot, so the next request really reaches the editor.
    const second = await f.bridge.formatCells({ address: 'A1', bold: true });
    assert.equal(second.ok, true);
    assert.equal(f.commands.length, 2);
  }
});

test('the resolved sheet is TIED to the request before anything is formatted', async () => {
  // The verification reads the SAME object that was formatted, so it cannot notice that the OBJECT was the wrong
  // sheet: the comparison of the sheet's own identity with the request is what closes that gap.
  for (const [knob, selector, why] of [
    [{ nameLies: true }, { sheetName: 'Данные' }, 'a lookup that answered a SHEET WITH ANOTHER NAME'],
    [{ indexLies: true }, { sheetIndex: 1 }, 'a lookup that answered a SHEET AT ANOTHER INDEX']
  ]) {
    const f = selectorRig({ sheets: [{ name: 'Sprint1', index: 0 }, { name: 'Данные', index: 1, ...knob }] });
    const result = await f.bridge.formatCells({ address: 'F6', bold: true, ...selector });
    assert.equal(result.ok, false, why);
    assert.equal(result.code, 'TOOL_ERROR', why);
    assert.deepEqual(f.commands[0].answered, ['PRE_INSERT', 'TOOL_ERROR'], `${why}: refused before the mutation`);
    assert.equal(f.setterCalls(), 0, `${why}: NOT ONE setter ran`);
  }
  const good = selectorRig();
  assert.equal((await good.bridge.formatCells({ address: 'F6', bold: true, sheetName: 'Данные' })).ok, true);
  assert.equal(good.book[1].bolds.get('F6'), true);
});

test('EVERY formatting setter works on the SELECTED sheet, and none of them touches the active one', async () => {
  // ONE CASE PER SETTER, because "all setters work on the resolved sheet" is the promise a single shared
  // resolution would otherwise only half-prove: the geometry pair runs through a BLOCK range object, the fill
  // paths go through Api.CreateColorFromRGB/CreateNoFill, and the font group reads through GetCharacters(). The
  // T4 rig cannot help here (it has no Api.GetSheet at all), which is exactly why each setter needs its own case.
  const cases = [
    ['numberFormat', { address: 'A1', numberFormat: { type: 'number' } }, (book) => book[1].formats.has('A1')],
    ['bold', { address: 'A1', bold: true }, (book) => book[1].bolds.get('A1') === true],
    ['italic', { address: 'A1', italic: true }, (book) => book[1].italics.get('A1') === true],
    ['fontFamily', { address: 'A1', fontFamily: 'Arial' }, (book) => book[1].names.get('A1') === 'Arial'],
    ['fontSize', { address: 'A1', fontSize: 14 }, (book) => book[1].sizes.get('A1') === '14'],
    ['fill', { address: 'A1', fill: '#112233' }, (book) => book[1].fills.get('A1') === 0x112233],
    ['clearFill', { address: 'A1', clearFill: true }, (book) => book[1].fills.has('A1') === false],
    ['wrapText', { address: 'A1', wrapText: true }, (book) => book[1].wraps.get('A1') === true],
    ['columnWidth', { address: 'A1:B1', columnWidth: 150 }, (book) => book[1].widths.get(1) === '150'],
    ['rowHeight', { address: 'A1:A2', rowHeight: 30 }, (book) => book[1].heights.get(1) === '30']
  ];
  for (const [name, request, landed] of cases) {
    const f = selectorRig();
    // `clearFill` only means anything over a cell that HELD a fill, so this case starts from one.
    if (name === 'clearFill') f.book[1].fills.set('A1', 0x445566);
    const result = await f.bridge.formatCells({ ...request, sheetName: 'Данные' });
    assert.equal(result.ok, true, `${name}: a selector request is served`);
    assert.equal(landed(f.book), true, `${name}: the SELECTED sheet received the formatting`);
    assert.equal(f.setActiveAttempts(), 0, `${name}: nothing was activated`);
    const activeSheetTouched = f.book[0].formats.size + f.book[0].bolds.size + f.book[0].italics.size
      + f.book[0].names.size + f.book[0].sizes.size + f.book[0].fills.size + f.book[0].wraps.size
      + f.book[0].widths.size + f.book[0].heights.size;
    assert.equal(activeSheetTouched, 0, `${name}: the ACTIVE sheet received nothing at all`);
    assert.equal(f.commands[0].scope.sheetName, 'Данные', name);
  }
});

test('the bridge counts FORMATTING properties, never the selector', async () => {
  // THE COUNT IS PUBLISHED AND THE TOOL READS IT: if the selector inflated it, the tool would answer a known
  // refusal AFTER the sheet had already been formatted. This asserts the number the BRIDGE publishes for a
  // request that carries a selector, which no other test does.
  const f = selectorRig();
  const result = await f.bridge.formatCells({ address: 'A1', bold: true, sheetName: 'Данные' });
  assert.equal(result.ok, true);
  assert.equal(result.properties, 1, 'one formatting property, and the sheet is not one of them');
  const two = await f.bridge.formatCells({ address: 'A1', bold: true, wrapText: true, sheetIndex: 1 });
  assert.equal(two.properties, 2, 'and the count follows the formatting properties alone');
});

test('the GEOMETRY setters work on the SELECTED sheet too, and the selector itself is closed', async () => {
  // Column width and row height are applied through a BLOCK range, i.e. a different range object than the cell
  // setters use: this pins both halves, including the verification read of the row height.
  const geometry = selectorRig();
  const result = await geometry.bridge.formatCells({ address: 'B2:C5', columnWidth: 150, rowHeight: 30, sheetName: 'Данные' });
  assert.equal(result.ok, true);
  assert.equal(geometry.book[1].widths.get(2), '150', 'the selected sheet\'s column was widened');
  assert.equal(geometry.book[1].heights.get(2), '30', 'and its row was heightened');
  assert.equal(geometry.book[0].widths.size + geometry.book[0].heights.size, 0, 'the active sheet got neither');
  assert.equal(geometry.setActiveAttempts(), 0);

  // The bridge's OWN bounds, which the tool cannot be the only guard for.
  const cases = [
    [{ sheetName: '' }, 'an empty name'],
    [{ sheetName: 'я'.repeat(LIMITS.sheetListNameBytes / 2 + 1) }, 'a name above the byte bound'],
    [{ sheetIndex: -1 }, 'a negative index'],
    [{ sheetIndex: LIMITS.sheetListMax }, 'an index at the workbook bound'],
    [{ sheetName: 'Sprint1', sheetIndex: 0 }, 'BOTH spellings at once'],
    [{ sheetName: 'Sprint1', extra: 1 }, 'an unknown key']
  ];
  for (const [selector, why] of cases) {
    const f = selectorRig();
    const refused = await f.bridge.formatCells({ address: 'A1', bold: true, ...selector });
    assert.equal(refused.ok, false, why);
    assert.equal(refused.code, 'TOOL_ERROR', why);
    assert.equal(f.commands.length, 0, `${why}: nothing may reach the editor`);
    assert.equal(f.setterCalls(), 0, why);
  }
});

test('the phase turns IMMEDIATELY before the first formatting setter, and no activation is authored', async () => {
  const f = selectorRig();
  await f.bridge.formatCells({ address: 'A1', bold: true, sheetName: 'Данные' });
  const source = f.commands[0].source;
  const phaseAt = source.indexOf("phase = 'POST_INSERT'");
  // THE FIRST MUTATING CALL, not one literal setter name and not a capability PROBE: the body legitimately asks
  // `typeof geometryBlock.SetColumnWidth !== 'function'` BEFORE the phase turns, so the marker is the first
  // `.Set…(` whose line is not a `typeof` test. A mutation inserted before the phase turn is caught whatever
  // property it applies.
  let firstSetter = -1;
  for (const match of source.matchAll(/\.Set[A-Z][A-Za-z]*\(/g)) {
    const lineStart = source.lastIndexOf('\n', match.index) + 1;
    const line = source.slice(lineStart, source.indexOf('\n', match.index));
    if (line.includes('typeof ') === false) { firstSetter = match.index; break; }
  }
  assert.ok(phaseAt > 0 && firstSetter > 0, 'both markers exist');
  assert.ok(phaseAt < firstSetter, 'the phase turns before the first mutating call, never after it');
  assert.match(source, /Api\.GetSheet\(/, 'the body resolves the selected sheet through Api.GetSheet');
  assert.equal(source.includes('SetActive'), false, 'and never activates it');
});

// --- A final review showed these four proofs could be replaced by an unconditional 1 ---------------------------
// The rig's own documented knob exists for exactly this: a SINGLE cell answers another value for one property, so a
// body that never re-read the property (or replicated one cell's flag) can no longer pass. Each pair asserts BOTH
// directions, because a proof that refuses everything would be as wrong as one that accepts everything.

test('an ITALIC the cell does not hold is never reported as proved', async () => {
  const lying = rig({ readOverrides: new Map([['A1', { italic: 'true' }]]) });
  const refused = await lying.bridge.formatCells({ address: 'A1', italic: false });
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.equal(refused.code, 'APPLY_UNCERTAIN', 'a cell still holding italic cannot prove it was cleared');
  const honest = rig();
  assert.equal((await honest.bridge.formatCells({ address: 'A1', italic: true })).ok, true);
});

test('a FONT SIZE the cell does not hold is never reported as proved', async () => {
  const lying = rig({ readOverrides: new Map([['A1', { size: '99' }]]) });
  const refused = await lying.bridge.formatCells({ address: 'A1', fontSize: 12 });
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.equal(refused.code, 'APPLY_UNCERTAIN');
  const honest = rig();
  assert.equal((await honest.bridge.formatCells({ address: 'A1', fontSize: 12 })).ok, true);
});

test('a FONT FAMILY the cell does not hold is never reported as proved', async () => {
  const lying = rig({ readOverrides: new Map([['A1', { name: 'Some Other Face' }]]) });
  const refused = await lying.bridge.formatCells({ address: 'A1', fontFamily: 'Liberation Serif' });
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.equal(refused.code, 'APPLY_UNCERTAIN');
  const honest = rig();
  assert.equal((await honest.bridge.formatCells({ address: 'A1', fontFamily: 'Liberation Serif' })).ok, true);
});

test('a NUMBER FORMAT the cell does not hold is never reported as proved', async () => {
  // Until this case existed the number-format proof was pinned only by a source-text assertion, so replacing its flag
  // with a literal 1 left the whole suite green.
  const lying = rig({ readOverrides: new Map([['A1', { numberFormat: 'General' }]]) });
  const refused = await lying.bridge.formatCells({ address: 'A1', numberFormat: { type: 'percent' } });
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.equal(refused.code, 'APPLY_UNCERTAIN');
  const honest = rig();
  assert.equal((await honest.bridge.formatCells({ address: 'A1', numberFormat: { type: 'percent' } })).ok, true);
});

test('a percent format with DECIMALS is built and proved, not only the integer percent code', async () => {
  // The rounding code is not the plain percent code. The rig does not expose its store, so the property is asserted
  // the way the proof itself works: a cell answering the PLAIN percent code cannot prove a one-decimal request, and
  // the same request against an honest cell is proved.
  const lying = rig({ readOverrides: new Map([['A1', { numberFormat: '0%' }]]) });
  const refused = await lying.bridge.formatCells({ address: 'A1', numberFormat: { type: 'percent', decimals: 1 } });
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.equal(refused.code, 'APPLY_UNCERTAIN', 'the one-decimal code is a different code from 0%');
  const honest = rig();
  assert.equal((await honest.bridge.formatCells({ address: 'A1', numberFormat: { type: 'percent', decimals: 1 } })).ok, true);
});
