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
