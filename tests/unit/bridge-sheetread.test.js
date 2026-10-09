// Host coverage for the SHEETREAD leg through the REAL bridge.
//
// `tools-cell.test.js` drives the Cell reads against a bridge DOUBLE, which hands the descriptor a
// ready-made envelope and therefore can never execute the authored `sheetread` body at all. This file is
// the one that runs the body, because the defect it pins lives INSIDE the body: what the `formulas` slot
// actually contains.
//
// THE DEFECT THIS FILE EXISTS FOR. On R7-Office Editors 2026.3.1 a range's `GetFormula()` answers
// differently by SIZE, and both halves are MEASURED:
//   * a ONE-CELL range answers the formula SOURCE (`"= B2-B3"`, and the cell's own text when it holds no
//     formula at all — `GetFormula()` on the text cell 'Москва' answers `"Москва"`);
//   * a MULTI-CELL range answers the computed VALUES — the recorded read-leg finding is a `K1:K2` read
//     (K1 the text `A`, K2 the formula `=1+1`) whose block getter answered `["A","2"]`, the value `2`
//     exactly where the source `=1+1` belonged.
// The body used to ask the BLOCK for its formulas, so a matching value matrix satisfied its shape test and
// the values were published as `formulas`: a formula cell reported `3` where its source `=1+2` belonged,
// and a one-character text cell reported that character as its own formula.
//
// The rig reproduces the vendor `callCommand` wrapper — it reads `Asc.scope` SYNCHRONOUSLY and evaluates
// the authored body in a fresh, module-free scope whose only bindings are `Api` and `scope` — and its sheet
// double reproduces the size rule above, so these tests fail against the old body and pass against the fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createR7Bridge } from '../../src/plugin/bridge.js';
import { LIMITS } from '../../src/shared/limits.js';
import { utf8ByteLength } from '../../src/shared/bytes.js';

const checkpoint = () => new Promise(resolve => setImmediate(resolve));

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

// The sheet double. `store` holds what each cell HOLDS: a plain string is a value, a string beginning
// with `=` is a formula SOURCE. `computed` is what a formula's own `GetValue()` answers, because that is
// a different question from what the cell holds. `failAt` makes the Nth `GetRange` call answer `null`,
// which models a capability that disappears part-way through an addressal read.
function readSheetDouble(store, { computed = new Map(), usedAddress = null, noGetFormula = false, failAt = 0, flatArrayAt = null, noNormalise = false, shiftAddress = false, noColonAddress = false, absoluteAddress = false, growAddress = false, raggedAt = -1, singleOverrides = new Map(), noGetValueOnCell = false, name = 'Sprint1', index = 0, onSetActive = null } = {}) {
  let rangeCalls = 0;
  function held(cell) { const value = store.get(cell); return value === undefined ? '' : String(value); }
  function valueAt(cell) {
    const raw = held(cell);
    if (raw.charAt(0) !== '=') return raw;
    const answer = computed.get(cell);
    return answer === undefined ? '' : String(answer);
  }
  function matrixOf(box, reader) {
    const rows = [];
    for (let row = box.r1; row <= box.r2; row++) {
      const line = [];
      for (let column = box.c1; column <= box.c2; column++) line.push(reader(columnName(column) + String(row)));
      rows.push(line);
    }
    return rows;
  }
  function rangeFor(requested) {
    // MEASURED: the editor NORMALISES a range's corners — `GetRange('B2:A1').GetAddress()` answers
    // `'A1:B2'` and its value matrix is A1-first — so the double normalises too. `noNormalise` models a
    // build that answers the RAW request while the matrix is normalised, which is the shape the leg has to
    // refuse because it cannot tell which cell the matrix starts at.
    const raw = corners(requested);
    const c1 = Math.min(raw.c1, raw.c2), c2 = Math.max(raw.c1, raw.c2);
    const r1 = Math.min(raw.r1, raw.r2), r2 = Math.max(raw.r1, raw.r2);
    const box = { c1, r1, c2, r2 };
    const single = c1 === c2 && r1 === r2;
    const cell = columnName(c1) + String(r1);
    const canonical = single ? cell : cell + ':' + columnName(c2) + String(r2);
    // `noNormalise` answers the RAW request, `noColonAddress` answers the head ALONE, `shiftAddress` shifts
    // BOTH corners by one row — a same-SIZE rectangle at a different ORIGIN, which the dimension check cannot
    // catch — and `absoluteAddress` answers the canonical form with `$` on both parts. Each models a way a
    // build can disagree with its own values.
    const shifted = single ? columnName(c1) + String(r1 + 1) : columnName(c1) + String(r1 + 1) + ':' + columnName(c2) + String(r2 + 1);
    const grown = single ? cell : cell + ':' + columnName(c2) + String(r2 + 3);
    const absolute = single
      ? '$' + columnName(c1) + '$' + String(r1)
      : '$' + columnName(c1) + '$' + String(r1) + ':$' + columnName(c2) + '$' + String(r2);
    let answered = noNormalise ? requested : canonical;
    if (noColonAddress) answered = cell;
    if (shiftAddress) answered = shifted;
    if (absoluteAddress) answered = absolute;
    if (growAddress) answered = grown;
    // `singleOverrides` makes a SINGLE-CELL read disagree with the block read for one cell, which is how the
    // per-cell alignment check is shown to look at every published cell rather than only the first.
    function placedAt(cellAddress) { return singleOverrides.has(cellAddress) ? singleOverrides.get(cellAddress) : valueAt(cellAddress); }
    const range = {
      GetAddress() { return answered; }
    };
    // `noGetValueOnCell` models a build whose PER-CELL range cannot answer a value while the addressed block
    // can: the pass must then withhold its sources instead of costing the caller the values.
    if (!(noGetValueOnCell && single)) {
      range.GetValue = function () {
        if (flatArrayAt !== null && requested === flatArrayAt) return [valueAt(cell)];
        if (!single && raggedAt >= 0) {
          const rows = matrixOf(box, valueAt);
          if (raggedAt < rows.length) rows[raggedAt] = rows[raggedAt].slice(0, Math.max(1, rows[raggedAt].length - 1));
          return rows;
        }
        return single ? placedAt(cell) : matrixOf(box, valueAt);
      };
    }
    if (!noGetFormula) {
      // MEASURED, and the reason this whole file exists: one cell -> the SOURCE, a block -> the VALUES.
      range.GetFormula = function () { return single ? held(cell) : matrixOf(box, valueAt); };
    }
    return range;
  }
  return {
    GetName() { return name; },
    GetIndex() { return index; },
    // A READ MUST NEVER SWITCH THE ACTIVE SHEET, so the double records any attempt: the selector path reads the
    // sheet OBJECT and must not reach for activation at all.
    SetActive() { if (onSetActive !== null) onSetActive(); },
    GetRange(address) {
      rangeCalls += 1;
      if (failAt > 0 && rangeCalls === failAt) return null;
      return rangeFor(address);
    },
    GetUsedRange() { return usedAddress === null ? null : rangeFor(usedAddress); }
  };
}

function rig({ store = new Map(), computed, usedAddress = null, noGetFormula = false, failAt = 0, flatArrayAt = null, noNormalise = false, shiftAddress = false, noColonAddress = false, absoluteAddress = false, growAddress = false, raggedAt = -1, singleOverrides, noGetValueOnCell = false, editorType = 'cell', sheets = null, activeIndex = 0 } = {}) {
  const commands = [];
  const namespace = { scope: {} };
  let setActiveAttempts = 0;
  const shared = { computed, usedAddress, noGetFormula, failAt, flatArrayAt, noNormalise, shiftAddress, noColonAddress, absoluteAddress, growAddress, raggedAt, singleOverrides, noGetValueOnCell };
  // ONE BOOK, possibly with SEVERAL sheets: the selector tests need two sheets whose cells differ, and they need
  // the collection and the lookup to answer the SAME sheet objects so "the active sheet never moved" is provable.
  // A per-sheet entry may override any shared double option, which is what lets two sheets differ in their FORMULA
  // SOURCES while agreeing on their computed values.
  const book = (sheets ?? [{ name: 'Sprint1', index: 0, store }]).map((entry) => readSheetDouble(entry.store ?? new Map(), {
    ...shared, ...entry, name: entry.name, index: entry.index, onSetActive: () => { setActiveAttempts += 1; }
  }));
  const api = {
    GetActiveSheet: () => book[activeIndex],
    GetSheets: () => book.slice(),
    GetSheet: (key) => (typeof key === 'number' ? (book[key] ?? null) : (book.find((candidate) => candidate.GetName() === key) ?? null))
  };
  const plugin = { info: { editorType },
    callCommand(body, close, recalculate, callback) {
      const source = Function.prototype.toString.call(body);
      const scope = namespace.scope;
      const answered = new Function('Api', 'scope', 'return (' + source + ')();')(api, scope);
      commands.push({ by: 'callCommand', source, scope, answered });
      callback(answered);
      return false;
    } };
  const bridge = createR7Bridge(plugin, { editorType, ascNamespace: namespace,
    clock: { now: () => 0 }, timers: { schedule() { return {}; }, clear() {} } });
  return { bridge, commands, sheet: book[activeIndex], book, setActiveAttempts: () => setActiveAttempts };
}

const CAP = LIMITS.sheetReadCellsMax;

test('a BLOCK read publishes formula SOURCES, never the values the block getter answers', async () => {
  // The exact measured trap: the block's own `GetFormula()` answers `["Выручка","3"]` — the values — and
  // the source `=1+2` is reachable ONLY through the single-cell getter.
  const f = rig({ store: new Map([['A1', 'Показатель'], ['B1', 'Сумма'], ['A2', 'Выручка'], ['B2', '=1+2']]),
    computed: new Map([['B2', '3']]) });
  const result = await f.bridge.readRange({ address: 'A1:B2', maxCells: CAP });
  assert.equal(result.ok, true);
  assert.deepEqual(result.values, [['Показатель', 'Сумма'], ['Выручка', '3']],
    'the values slot keeps the computed value of the formula cell');
  assert.deepEqual(result.formulas, [['', ''], ['', '=1+2']],
    'and the formulas slot carries the SOURCE, with no entry for a cell that holds no formula');
});

test('a ONE-CHARACTER cell is not reported as holding a formula', async () => {
  // The other half of the defect, and the same root cause: a scalar string also has a numeric `length`,
  // so a one-cell read whose getter answers the cell's own text was published as `formulas: ["A"]`.
  const f = rig({ store: new Map([['A1', 'A']]) });
  const result = await f.bridge.readRange({ address: 'A1', maxCells: CAP });
  assert.deepEqual(result.values, [['A']]);
  assert.deepEqual(result.formulas, [['']], 'a text cell holds no formula, so its slot is empty');
});

test('a plain text cell the engine answers verbatim is still not a formula', async () => {
  // `GetFormula()` on a text cell answers that cell's own text (measured), which is exactly why the body
  // may not pass the getter's answer through unfiltered.
  const f = rig({ store: new Map([['K1', 'zz'], ['K2', '#REF!']]) });
  const result = await f.bridge.readRange({ address: 'K1:K2', maxCells: CAP });
  assert.deepEqual(result.values, [['zz'], ['#REF!']]);
  assert.deepEqual(result.formulas, [[''], ['']]);
});

test('a ONE-CELL formula read publishes its source beside its computed value', async () => {
  const f = rig({ store: new Map([['B2', '=1+2']]), computed: new Map([['B2', '3']]) });
  const result = await f.bridge.readRange({ address: 'B2', maxCells: CAP });
  assert.deepEqual(result.values, [['3']]);
  assert.deepEqual(result.formulas, [['=1+2']]);
});

test('a build that exposes no formula getter publishes `formulas: null`, never an empty matrix', async () => {
  // `null` is the body's own "the editor would not answer", which is a different statement from "this
  // range holds no formulas" — the distinction the module header pins.
  const f = rig({ store: new Map([['A1', 'x']]), noGetFormula: true });
  const result = await f.bridge.readRange({ address: 'A1', maxCells: CAP });
  assert.equal(result.ok, true);
  assert.deepEqual(result.values, [['x']]);
  assert.equal(result.formulas, null);
});

test('a range that holds NO formula reports empty strings, which is not the same as `null`', async () => {
  const f = rig({ store: new Map([['A1', 'a'], ['B1', 'b']]) });
  const result = await f.bridge.readRange({ address: 'A1:B1', maxCells: CAP });
  assert.deepEqual(result.formulas, [['', '']], 'the getter answered, and no cell in the range holds a formula');
});

test('a ONE-CELL read whose text is longer than one character is ONE cell, never its own characters', async () => {
  // MEASURED, and found by the same native proof that pinned the formula defect: a one-cell
  // `GetValue()` answers a SCALAR STRING, and a string also has a numeric `.length` — so a body that
  // treats the answer as a matrix publishes `'zz'` as TWO rows of `'z'`, and `read_range('K1')` reports
  // `totalRows: 2` for an address that names one cell.
  const f = rig({ store: new Map([['K1', 'zz']]) });
  const result = await f.bridge.readRange({ address: 'K1', maxCells: CAP });
  assert.equal(result.totalRows, 1, 'the address names ONE row');
  assert.equal(result.columnCount, 1);
  assert.deepEqual(result.values, [['zz']], 'the text is one cell, not one row per character');
  assert.deepEqual(result.formulas, [['']]);
});

test('a ONE-CELL numeric value is published whole, not split into digits', async () => {
  const f = rig({ store: new Map([['B2', '1000']]) });
  const result = await f.bridge.readRange({ address: 'B2', maxCells: CAP });
  assert.equal(result.totalRows, 1);
  assert.deepEqual(result.values, [['1000']]);
});

test('a used range that is a single cell is read as that one cell', async () => {
  const f = rig({ store: new Map([['A1', 'Итого']]), usedAddress: 'A1' });
  const result = await f.bridge.readSheet({ maxCells: CAP });
  assert.equal(result.requestAddress, 'A1');
  assert.equal(result.totalRows, 1);
  assert.deepEqual(result.values, [['Итого']]);
});

test('a shape the build was never measured to answer refuses closed, rather than being stringified', async () => {
  // A FLAT array is neither of the two measured answers (a scalar primitive for one cell, a 2-D array for
  // a block). Stringifying it would attribute a joined value to a single address, so the read refuses.
  const f = rig({ store: new Map([['A1', 'x']]), flatArrayAt: 'A1' });
  const result = await f.bridge.readRange({ address: 'A1', maxCells: CAP });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CAPABILITY_UNAVAILABLE');
});

test('a REVERSED request is addressed from the range the EDITOR answered, never from the caller spelling', async () => {
  // MEASURED: `GetRange('B2:A1').GetAddress()` answers `'A1:B2'` and the value matrix is A1-first. Deriving
  // the addressal start from the CALLER's spelling would walk B2, C2, B3, C3 — a rectangle sharing only a
  // corner with the values — and would publish B2's source in A1's slot while B2's own slot stayed empty.
  const f = rig({ store: new Map([['A1', 'a1'], ['B1', 'b1'], ['A2', 'a2'], ['B2', '=b2src']]),
    computed: new Map([['B2', '3']]) });
  const result = await f.bridge.readRange({ address: 'B2:A1', maxCells: CAP });
  assert.equal(result.ok, true);
  assert.equal(result.requestAddress, 'B2:A1', 'the caller still learns what it ASKED for');
  assert.equal(result.readAddress, 'A1:B2', 'and the range the editor actually ANSWERED');
  assert.deepEqual(result.values, [['a1', 'b1'], ['a2', '3']]);
  assert.deepEqual(result.formulas, [['', ''], ['', '=b2src']], 'the source stays in its OWN slot');
});

test('an address that cannot be aligned with its own values publishes NO sources, but still reads', async () => {
  // A build that answers the RAW request while the value matrix is normalised: the leg cannot tell which
  // cell each value came from, so it publishes no formula sources at all rather than attributing one to the
  // wrong cell. The VALUES are still served, because the editor aligned those itself — the read's
  // availability does not depend on the formula getter or on the address being alignable.
  const f = rig({ store: new Map([['A1', 'a1'], ['B1', 'b1'], ['A2', 'a2'], ['B2', '=b2src']]),
    computed: new Map([['B2', '3']]), noNormalise: true });
  const result = await f.bridge.readRange({ address: 'B2:A1', maxCells: CAP });
  assert.equal(result.ok, true, 'the values are still readable');
  assert.deepEqual(result.values, [['a1', 'b1'], ['a2', '3']]);
  assert.equal(result.formulas, null, 'and no source is published, because none of them can be placed');
});

test('an answered address of the RIGHT SIZE but the WRONG ORIGIN publishes no sources', async () => {
  // The rectangle check is DIMENSION-only, so a same-SIZE rectangle at a different ORIGIN passes it — which
  // is exactly what this double answers (request `A1:B2`, answer `A2:B3`). Only the per-cell alignment check
  // catches it, and a mismatch only ever REMOVES sources: the values are still served and nothing is
  // attributed to a cell that does not hold it. Note this test FAILS if the alignment check is disabled,
  // while it PASSES if only the dimension check survives — the two checks are distinguishable.
  const f = rig({ store: new Map([['A1', 'a1'], ['B1', 'b1'], ['A2', 'a2'], ['B2', '=b2src']]),
    computed: new Map([['B2', '3']]), shiftAddress: true });
  const result = await f.bridge.readRange({ address: 'A1:B2', maxCells: CAP });
  assert.equal(result.ok, true, 'the values are still readable');
  assert.deepEqual(result.values, [['a1', 'b1'], ['a2', '3']]);
  assert.equal(result.formulas, null, 'and the sources are withheld, because their cells cannot be trusted');
});

test('an answered address that disagrees about the SIZE withholds, even when the values line up', async () => {
  // The DIMENSION check is a separate guard from the per-cell alignment check. Here the origin is right and
  // every published cell holds its own value — the per-cell pass would be satisfied — and only the rectangle's
  // own SIZE disagrees (the editor answered three rows more than it returned). Sources would then describe a
  // range that does not cover the payload, so they are withheld instead.
  const f = rig({ store: new Map([['A1', 'a1'], ['B1', '=b1src']]), computed: new Map([['B1', 'b1']]),
    growAddress: true });
  const result = await f.bridge.readRange({ address: 'A1:B1', maxCells: CAP });
  assert.equal(result.ok, true);
  assert.deepEqual(result.values, [['a1', 'b1']]);
  assert.equal(result.formulas, null, 'a rectangle the values do not fill cannot place them');
});

test('a mismatch at a LATER cell also withholds, so the check is not sample-only', async () => {
  // The first cell agrees here and only the SECOND one disagrees, which is what proves the alignment check
  // walks every published cell rather than the first alone.
  const f = rig({ store: new Map([['A1', 'a1'], ['A2', 'a2']]), singleOverrides: new Map([['A2', 'zz']]) });
  const result = await f.bridge.readRange({ address: 'A1:A2', maxCells: CAP });
  assert.equal(result.ok, true);
  assert.deepEqual(result.values, [['a1'], ['a2']], 'the published values are the block answer');
  assert.equal(result.formulas, null, 'and one disagreeing cell is enough to withhold every source');
});

test('an ABSOLUTE answered address parses, so its sources are published', async () => {
  // `$A$1:$B$1` must be read like a relative address: stripping `$` from only one part would make `A$1`
  // parse while `$A$1` did not, silently dropping every source on such a build.
  const f = rig({ store: new Map([['A1', 'a1'], ['B1', '=1+2']]), computed: new Map([['B1', '3']]),
    absoluteAddress: true });
  const result = await f.bridge.readRange({ address: 'A1:B1', maxCells: CAP });
  assert.equal(result.ok, true);
  assert.equal(result.readAddress, '$A$1:$B$1', 'the editor answered an absolute range');
  assert.deepEqual(result.formulas, [['', '=1+2']], 'and its sources are published rather than dropped');
});

test('a CLIPPED read still serves values when the answered address cannot be rewritten', async () => {
  // The editor's spelling is preferred for the clip report because it is the accurate one, but the CLOSED
  // pattern guarantees the CALLER's spelling can always be rewritten — so a build answering an address with
  // no colon at all must not cost a clipped `read_range` the values it used to serve. 300 rows of two
  // columns exceed the 400-cell cap, so 200 whole rows are published and the clip path really runs.
  const store = new Map();
  for (let row = 1; row <= 300; row++) { store.set(`A${row}`, `a${row}`); store.set(`B${row}`, `b${row}`); }
  const f = rig({ store, noColonAddress: true });
  const result = await f.bridge.readRange({ address: 'A1:B300', maxCells: CAP });
  assert.equal(result.ok, true, 'the clipped read is still served');
  assert.equal(result.totalRows, 300);
  assert.equal(result.rowCount, 200, '400 cells over two columns is 200 whole rows');
  assert.equal(result.truncated, true);
  assert.equal(result.readAddress, 'A1:B200', 'rewritten from the CALLER spelling, which the pattern guarantees');
  assert.equal(result.values.length, 200);
});

test('a RAGGED block is refused rather than read as if its rows all had the same width', async () => {
  const f = rig({ store: new Map([['A1', 'a1'], ['B1', 'b1'], ['A2', 'a2'], ['B2', 'b2']]), raggedAt: 1 });
  const result = await f.bridge.readRange({ address: 'A1:B2', maxCells: CAP });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CAPABILITY_UNAVAILABLE');
});

test('a CLIPPED answer that came back ABSOLUTE still reports a relative, rewritable range', async () => {
  // The clip report is rebuilt from the answered spelling, so a build that answers `$A$1:$B$300` must not
  // produce a mixed `$A$1:B200`: both halves are stripped, and the published range describes the prefix.
  const store = new Map();
  for (let row = 1; row <= 300; row++) { store.set(`A${row}`, `a${row}`); store.set(`B${row}`, `b${row}`); }
  const f = rig({ store, absoluteAddress: true });
  const result = await f.bridge.readRange({ address: 'A1:B300', maxCells: CAP });
  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
  assert.equal(result.readAddress, 'A1:B200', 'no `$` survives into the rebuilt report');
});

test('a per-cell range that cannot answer a VALUE withholds the sources, keeping the values', async () => {
  // The addressed block still answers, but every single-cell range cannot answer a value, so the pass cannot
  // place its sources: it withholds them and the caller keeps the values.
  const f = rig({ store: new Map([['A1', 'a'], ['B1', 'b']]), noGetValueOnCell: true });
  const result = await f.bridge.readRange({ address: 'A1:B1', maxCells: CAP });
  assert.equal(result.ok, true);
  assert.deepEqual(result.values, [['a', 'b']]);
  assert.equal(result.formulas, null);
});

test('a used-range read reports the sheet own address and the sources inside it', async () => {
  const f = rig({ store: new Map([['A1', 'Итого'], ['A2', '=1+2']]), computed: new Map([['A2', '3']]),
    usedAddress: 'A1:A2' });
  const result = await f.bridge.readSheet({ maxCells: CAP });
  assert.equal(result.requestAddress, 'A1:A2');
  assert.deepEqual(result.values, [['Итого'], ['3']]);
  assert.deepEqual(result.formulas, [[''], ['=1+2']]);
});

test('a CLIPPED read pays for and publishes exactly the rows it carries, never the whole range', async () => {
  // The measured used range shape: 53 rows x 24 columns clipped to 16 whole rows under the 400-cell cap.
  // The addressal loop must therefore be bounded by the PUBLISHED rows, exactly like the value loop, or a
  // clipped read would silently cost the whole sheet.
  const store = new Map([['A1', 'x'], ['X53', '=1+2']]);
  const f = rig({ store, computed: new Map([['X53', '3']]), usedAddress: 'A1:X53' });
  const result = await f.bridge.readSheet({ maxCells: CAP });
  assert.equal(result.rowCount, 16);
  assert.equal(result.totalRows, 53);
  assert.equal(result.truncated, true);
  assert.equal(result.formulas.length, 16, 'one formula row per PUBLISHED row');
  assert.equal(result.formulas[0].length, 24);
  assert.deepEqual(result.formulas[15][23], '', 'row 53 was never published, so its formula cannot appear');
  assert.deepEqual(result.values[15][23], '');
});

test('a per-cell capability that disappears mid-read refuses the read CLOSED, publishing nothing', async () => {
  // The call order is: the addressed block, then one single-cell range per published cell — so `failAt: 3`
  // takes out the SECOND per-cell read, after the first has already been read. A read that cannot finish its
  // addressal pass must not publish the cells it happened to get: a short formulas slot would attribute
  // formulas to the wrong cells.
  const f = rig({ store: new Map([['A1', 'a'], ['B1', 'b']]), failAt: 3 });
  const result = await f.bridge.readRange({ address: 'A1:B1', maxCells: CAP });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CAPABILITY_UNAVAILABLE');
});

test('a range that cannot place its own value WITHHOLDS the sources rather than failing the read', async () => {
  // The per-cell addressal pass is also the alignment check, so a cell whose single-cell value disagrees with
  // the published one withholds every source (`formulas: null`) — it never costs the caller the values, and it
  // never guesses. Here the block answers normally and the SINGLE-CELL read of the same cell does not.
  const f = rig({ store: new Map([['A1', 'a'], ['B1', 'b']]), singleOverrides: new Map([['A1', 'zz']]) });
  const result = await f.bridge.readRange({ address: 'A1:B1', maxCells: CAP });
  assert.equal(result.ok, true);
  assert.deepEqual(result.values, [['a', 'b']]);
  assert.equal(result.formulas, null);
});

test('the read is still a read: neither call reaches a mutation primitive', async () => {
  const f = rig({ store: new Map([['A1', 'a']]) });
  const result = await f.bridge.readRange({ address: 'A1', maxCells: CAP });
  assert.equal(result.ok, true);
  assert.equal(f.commands.length, 1);
  for (const command of f.commands) {
    assert.equal(command.source.includes('SetValue'), false, 'a read body never writes');
    assert.equal(command.source.includes('Push('), false);
  }
  await checkpoint();
});

// ---------------------------------------------------------------------------------------------------------
// THE SHEET SELECTOR (T5.3a): read a range of a NAMED or INDEXED sheet, through the measured `Api.GetSheet`,
// without switching the active sheet. With no selector the leg keeps reading the active sheet exactly as before.
// ---------------------------------------------------------------------------------------------------------
function twoSheetRig() {
  return rig({
    activeIndex: 0,
    sheets: [
      { name: 'Sprint1', index: 0, store: new Map([['A1', 'active-a1'], ['B1', 'active-b1']]) },
      { name: 'Данные', index: 1, store: new Map([['A1', 'data-a1'], ['B1', 'data-b1']]) }
    ]
  });
}

test('a read WITHOUT a selector still reads the ACTIVE sheet and publishes its identity', async () => {
  const f = twoSheetRig();
  const result = await f.bridge.readRange({ address: 'A1:B1', maxCells: CAP });
  assert.equal(result.ok, true);
  assert.equal(result.sheetName, 'Sprint1');
  assert.equal(result.sheetIndex, 0);
  assert.deepEqual(result.values, [['active-a1', 'active-b1']]);
  assert.equal(f.commands[0].scope.sheetName, null, 'no selector crosses as null, never as a guessed name');
  assert.equal(f.commands[0].scope.sheetIndex, null);
  assert.equal(f.setActiveAttempts(), 0);
});

test('a read BY NAME reads THAT sheet and never switches the active one', async () => {
  const f = twoSheetRig();
  const result = await f.bridge.readRange({ address: 'A1:B1', maxCells: CAP, sheetName: 'Данные' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.values, [['data-a1', 'data-b1']], 'the values are the SELECTED sheet own cells');
  // The published identity describes WHAT WAS READ, which is what lets a caller holding several reads tell them
  // apart; the ACTIVE sheet is untouched and no activation was even attempted.
  assert.equal(result.sheetName, 'Данные');
  assert.equal(result.sheetIndex, 1);
  assert.equal(f.setActiveAttempts(), 0, 'a read never activates anything');
  assert.equal(f.commands[0].scope.sheetName, 'Данные');
  assert.equal(f.commands[0].scope.sheetIndex, null);
});

test('a read BY INDEX reads that sheet, and the answer carries its identity', async () => {
  const f = twoSheetRig();
  const result = await f.bridge.readRange({ address: 'A1', maxCells: CAP, sheetIndex: 1 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.values, [['data-a1']]);
  assert.equal(result.sheetName, 'Данные');
  assert.equal(result.sheetIndex, 1);
  assert.equal(f.setActiveAttempts(), 0);
  assert.equal(f.commands[0].scope.sheetIndex, 1);
});

test('a selector that names NOTHING is a KNOWN argument refusal, not a capability one', async () => {
  for (const selector of [{ sheetName: 'НетТакогоЛиста' }, { sheetIndex: 7 }]) {
    const f = twoSheetRig();
    const result = await f.bridge.readRange({ address: 'A1', maxCells: CAP, ...selector });
    assert.equal(result.ok, false, JSON.stringify(selector));
    assert.equal(result.code, 'TOOL_ERROR', JSON.stringify(selector));
    assert.deepEqual(f.commands[0].answered, ['TOOL_ERROR'], 'the narrower one-slot refusal reaches the bridge');
    // A read changed nothing, so the slot is released and the next request really reaches the editor again.
    const second = await f.bridge.readRange({ address: 'A1', maxCells: CAP });
    assert.equal(second.ok, true);
    assert.equal(f.commands.length, 2, 'the refusal released the slot');
  }
});

test('the selector is CLOSED before any dispatch, and an ambiguous one is refused', async () => {
  const cases = [
    [{ sheetName: '' }, 'an empty name'],
    [{ sheetName: 'я'.repeat(LIMITS.sheetListNameBytes / 2 + 1) }, 'a name above the byte bound'],
    [{ sheetName: 42 }, 'a numeric name'],
    [{ sheetIndex: -1 }, 'a negative index'],
    [{ sheetIndex: 1.5 }, 'a fractional index'],
    [{ sheetIndex: LIMITS.sheetListMax }, 'an index at the workbook bound'],
    [{ sheetName: 'Sprint1', sheetIndex: 0 }, 'BOTH spellings at once'],
    [{ sheetName: 'Sprint1', extra: 1 }, 'an unknown key']
  ];
  for (const [selector, why] of cases) {
    const f = twoSheetRig();
    const result = await f.bridge.readRange({ address: 'A1', maxCells: CAP, ...selector });
    assert.equal(result.ok, false, why);
    assert.equal(result.code, 'TOOL_ERROR', why);
    assert.equal(f.commands.length, 0, `${why}: nothing may reach the editor`);
  }
});

test('the selector path authored in the body uses the measured lookup, not the active sheet', async () => {
  const f = twoSheetRig();
  await f.bridge.readRange({ address: 'A1', maxCells: CAP, sheetName: 'Данные' });
  const source = f.commands[0].source;
  assert.match(source, /GetSheet\(/, 'the body resolves the selected sheet through Api.GetSheet');
  assert.equal(source.includes('SetActive'), false, 'and never activates it');
  await checkpoint();
});

test('sheetIndex 0 selects the FIRST sheet even when a DIFFERENT sheet is active', async () => {
  // THE INDEX-ZERO TRAP: an implementation that treats 0 as "no selector" (`sheetIndex || null`, or a truthiness
  // test in the body) reads the ACTIVE sheet and is invisible unless the active sheet is NOT index 0.
  const f = rig({
    activeIndex: 1,
    sheets: [
      { name: 'Sprint1', index: 0, store: new Map([['A1', 'first-a1']]) },
      { name: 'Второй', index: 1, store: new Map([['A1', 'second-a1']]) }
    ]
  });
  const result = await f.bridge.readRange({ address: 'A1', maxCells: CAP, sheetIndex: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.sheetName, 'Sprint1', 'index 0 is a REAL selector, not an absent one');
  assert.equal(result.sheetIndex, 0);
  assert.deepEqual(result.values, [['first-a1']], 'and the values are that sheet own cell');
  assert.equal(f.commands[0].scope.sheetIndex, 0, 'the zero crosses as 0, never as null');
  assert.equal(f.setActiveAttempts(), 0);
});

test('the FORMULAS a selected read publishes are the SELECTED sheet own sources', async () => {
  // Two sheets whose B2 answers the SAME computed value from a DIFFERENT source: the values agree, so the values
  // alone cannot tell a correct read from one whose formula pass ran on the ACTIVE sheet — only the sources can,
  // and attributing another sheet's source to this sheet's cell is exactly the class the read leg exists to avoid.
  const f = rig({
    activeIndex: 0,
    sheets: [
      { name: 'Sprint1', index: 0, store: new Map([['A2', 'Выручка'], ['B2', '=1+2']]), computed: new Map([['B2', '3']]) },
      { name: 'Данные', index: 1, store: new Map([['A2', 'Выручка'], ['B2', '=9+9']]), computed: new Map([['B2', '3']]) }
    ]
  });
  const selected = await f.bridge.readRange({ address: 'A2:B2', maxCells: CAP, sheetName: 'Данные' });
  assert.equal(selected.ok, true);
  assert.equal(selected.sheetName, 'Данные');
  assert.deepEqual(selected.values, [['Выручка', '3']], 'both sheets compute the same value');
  assert.deepEqual(selected.formulas, [['', '=9+9']], 'but the SOURCE must be the selected sheet own formula');
  // And the ACTIVE sheet's own read still answers ITS source, so the pass is not simply returning one of them.
  const active = await f.bridge.readRange({ address: 'A2:B2', maxCells: CAP });
  assert.deepEqual(active.formulas, [['', '=1+2']]);
  assert.equal(f.setActiveAttempts(), 0);
  await checkpoint();
});

test('a name exactly AT the byte bound is served, so the bound is not off by one', async () => {
  const exact = 'я'.repeat(LIMITS.sheetListNameBytes / 2);
  assert.equal(utf8ByteLength(exact), LIMITS.sheetListNameBytes);
  const f = rig({ sheets: [{ name: exact, index: 0, store: new Map([['A1', 'ok']]) }] });
  const result = await f.bridge.readRange({ address: 'A1', maxCells: CAP, sheetName: exact });
  assert.equal(result.ok, true, 'a name at exactly the bound is a valid selector');
  assert.equal(result.sheetName, exact);
  // One byte MORE is refused, before any dispatch.
  const over = rig({ sheets: [{ name: exact, index: 0, store: new Map([['A1', 'ok']]) }] });
  const refused = await over.bridge.readRange({ address: 'A1', maxCells: CAP, sheetName: exact + 'я' });
  assert.equal(refused.code, 'TOOL_ERROR');
  assert.equal(over.commands.length, 0);
});

test('readSheet REFUSES a selector rather than silently serving the active sheet', async () => {
  // This leg reads the active sheet and exposes no selector: a raw caller that passes one must be told, because the
  // shared body below WOULD happily honour it.
  const f = twoSheetRig();
  const result = await f.bridge.readSheet({ maxCells: CAP, sheetName: 'Данные' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TOOL_ERROR');
  assert.equal(f.commands.length, 0, 'nothing was dispatched');
  // The leg itself still works: a rig whose sheet HAS a used range answers it.
  const used = rig({ store: new Map([['A1', 'a']]), usedAddress: 'A1:A1' });
  assert.equal((await used.bridge.readSheet({ maxCells: CAP })).ok, true);
});

test('a read request that is not an object is refused as a bad request', async () => {
  for (const raw of [undefined, null, [], 'A1']) {
    const f = twoSheetRig();
    const result = await f.bridge.readRange(raw);
    assert.equal(result.ok, false, String(raw));
    assert.equal(result.code, 'TOOL_ERROR', String(raw));
    assert.equal(f.commands.length, 0, String(raw));
  }
});
