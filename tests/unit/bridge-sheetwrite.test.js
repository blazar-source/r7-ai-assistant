// Host coverage for the SHEETWRITE leg through the REAL bridge.
//
// `tools-cell-write.test.js` drives the `write_range` descriptor against a bridge DOUBLE, which by
// construction can never exercise `decodeWriteRange` or the `sheetwrite` dispatch branch — the entire
// "never launder a post-write uncertainty into a known error" mechanism. This file is the one that does.
//
// The rig reproduces the vendor `callCommand` wrapper: it reads `Asc.scope` SYNCHRONOUSLY and evaluates the
// authored body in a fresh, module-free scope whose only bindings are `Api` and `scope`. The sheet double
// reproduces the SHAPE rules MEASURED on R7-Office Editors 2026.3.1, because those shapes are what the body
// must tell apart:
//   * a one-cell range answers a SCALAR STRING (`GetValue()`), and its `GetFormula()` answers the source;
//   * a multi-cell range answers a 2-D ARRAY, and its `GetFormula()` answers the computed VALUES — NOT the
//     formula sources — while still answering a matrix of the correct shape;
//   * an empty cell answers `''`, and a FORMULA cell's `GetValue()` answers its computed value (`'=1/0'`
//     measured as the empty string).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createR7Bridge } from '../../src/plugin/bridge.js';
import { LIMITS } from '../../src/shared/limits.js';

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

// `store` holds what was really written; `noOp` makes every `SetValue` a no-op so a test can prove the
// readback cannot be satisfied by a cell the write never touched; `values` overrides what `GetValue()`
// answers for an address, which is how a hostile or differently-behaving build is modelled.
function sheetDouble(store, { noOp = false, values = new Map(), formulas = new Map(), name = 'Sprint1', index = 0, nameLies = false, indexLies = false, onSetValue = null, onSetActive = null } = {}) {
  // Storage is keyed by the CANONICAL single-cell address, so `A1` and the explicit `A1:A1` spelling are the
  // SAME cell. That is what the measured build answers, and keying by the literal address instead made the
  // very shape that settled the one-cell question untestable.
  function valueAt(cell) {
    if (values.has(cell)) return values.get(cell);
    const stored = store.get(cell);
    if (stored === undefined) return '';
    return String(stored).charAt(0) === '=' ? '' : stored;
  }
  function matrix(box) {
    const rows = [];
    for (let row = box.r1; row <= box.r2; row++) {
      const line = [];
      for (let column = box.c1; column <= box.c2; column++) line.push(valueAt(columnName(column) + String(row)));
      rows.push(line);
    }
    return rows;
  }
  return {
    // The sheet's OWN identity, which the body verifies against the request before it writes: `nameLies` and
    // `indexLies` model a build whose lookup resolves a DIFFERENT sheet than the caller asked for.
    GetName() { return nameLies ? 'КтоТоДругой' : name; },
    GetIndex() { return indexLies ? 99 : index; },
    // A WRITE MUST NEVER ACTIVATE ANYTHING, so the double records the attempt: without this method the mutant
    // "activate the selected sheet first" would be silently equivalent, because the body's own guard would not
    // find a method to call.
    SetActive() { if (onSetActive !== null) onSetActive(); },
    GetRange(address) {
      const box = corners(address);
      const single = box.c1 === box.c2 && box.r1 === box.r2;
      const cell = columnName(box.c1) + String(box.r1);
      return {
        SetValue(value) { if (onSetValue !== null) onSetValue(); if (!noOp) store.set(cell, value); },
        // MEASURED: one cell -> a scalar; a block -> a matrix.
        GetValue() { return single ? valueAt(cell) : matrix(box); },
        // MEASURED: a one-cell range answers the real source; a MULTI-CELL range answers the VALUES, so a
        // block-level formula read can never prove a formula cell. `formulas` overrides the SOURCE a single cell
        // answers, which is how a build that stored text instead of a formula is modelled.
        GetFormula() {
          if (single && formulas.has(cell)) return formulas.get(cell);
          return single ? (store.get(cell) === undefined ? '' : String(store.get(cell))) : matrix(box);
        }
      };
    }
  };
}

function rig({ forge, noOp = false, editorType = 'cell', values, formulas, sheets = null, activeIndex = 0 } = {}) {
  const commands = [];
  const namespace = { scope: {} };
  let setActiveAttempts = 0;
  let setValueCalls = 0;
  // ONE BOOK, possibly with SEVERAL sheets: the selector tests need the write to land in a DIFFERENT store than
  // the active sheet's, which is the only way to tell a correct write from one that wrote to the active sheet.
  const book = (sheets ?? [{ name: 'Sprint1', index: 0 }]).map((entry) => {
    const entryStore = entry.store ?? new Map();
    return {
      name: entry.name,
      index: entry.index,
      store: entryStore,
      sheet: sheetDouble(entryStore, {
        noOp,
        values: entry.values ?? values,
        formulas: entry.formulas ?? formulas,
        name: entry.name,
        index: entry.index,
        nameLies: entry.nameLies === true,
        indexLies: entry.indexLies === true,
        onSetValue: () => { setValueCalls += 1; },
        onSetActive: () => { setActiveAttempts += 1; }
      })
    };
  });
  const api = {
    GetActiveSheet: () => book[activeIndex].sheet,
    GetSheets: () => book.map((entry) => entry.sheet),
    GetSheet: (key) => (typeof key === 'number'
      ? (book[key] === undefined ? null : book[key].sheet)
      : (book.find((entry) => entry.name === key)?.sheet ?? null))
  };
  const plugin = { info: { editorType },
    callCommand(body, close, recalculate, callback) {
      const source = Function.prototype.toString.call(body);
      const scope = namespace.scope;
      const answered = new Function('Api', 'scope', 'return (' + source + ')();')(api, scope);
      commands.push({ by: 'callCommand', source, scope, answered });
      callback(forge === undefined ? answered : forge);
      return false;
    } };
  const bridge = createR7Bridge(plugin, { editorType, ascNamespace: namespace,
    clock: { now: () => 0 }, timers: { schedule() { return {}; }, clear() {} } });
  return { bridge, commands, store: book[activeIndex].store, book,
    setActiveAttempts: () => setActiveAttempts, setValueCalls: () => setValueCalls };
}

test('a served block write is proved and releases the slot', async () => {
  const f = rig();
  const result = await f.bridge.writeRange({ address: 'A1:B2', cells: [['a', 'b'], ['c', 'd']] });
  assert.deepEqual(result, { ok: true, address: 'A1:B2', rowCount: 2, columnCount: 2 });
  assert.equal(f.store.get('A1'), 'a');
  assert.equal(f.store.get('B2'), 'd');
  assert.equal(f.bridge.getState().busy, false, 'a proved write releases the slot');
});

test('a ONE-CELL write is proved: the readback is a scalar string, not a matrix', async () => {
  // The regression this pins: a scalar STRING also has a numeric `length`, so a `.length` shape probe
  // classifies it as a matrix and compares the cell's FIRST CHARACTER with the whole requested text. In the
  // measured world that made every one-cell write unprovable (UNCERTAIN with the slot held).
  const f = rig();
  const result = await f.bridge.writeRange({ address: 'A1', cells: [['Москва']] });
  assert.deepEqual(result, { ok: true, address: 'A1', rowCount: 1, columnCount: 1 });
  assert.equal(f.store.get('A1'), 'Москва');
  assert.equal(f.bridge.getState().busy, false);
});

test('a ONE-CELL empty write is proved rather than throwing out of the readback', async () => {
  const f = rig();
  const result = await f.bridge.writeRange({ address: 'A1', cells: [['']] });
  assert.equal(result.ok, true, 'an empty cell is a legal one-cell request');
  assert.equal(f.bridge.getState().busy, false);
});

test('a ONE-CELL write cannot be "proved" by a stale longer value the write never touched', async () => {
  // The false positive the same shape bug allowed: request `М` over a cell already holding `Москва` with the
  // write a NO-OP. Comparing `'Москва'[0][0]` proved `М` about a cell that still holds `Москва`.
  const f = rig({ noOp: true, values: new Map([['A1', 'Москва']]) });
  const result = await f.bridge.writeRange({ address: 'A1', cells: [['М']] });
  assert.equal(result.ok, false, 'a cell holding Москва is not a proof of М');
  assert.equal(result.code, 'APPLY_UNCERTAIN', 'an unproved write is UNCERTAIN, never a known error');
  assert.equal(f.bridge.getState().busy, true, 'the slot stays HELD: the mutation is never retried');
  assert.equal(f.bridge.getState().uncertain, true);
});

test('the explicit ONE-CELL spelling `A1:A1` is proved as a scalar too', async () => {
  // The exact spelling the blocker measurement turned on: on the measured build `GetRange('H1:H1').GetValue()`
  // also answers a SCALAR, so the two one-cell spellings must behave identically. The double keys storage
  // canonically, which is what makes this shape exercisable at all.
  const f = rig();
  const result = await f.bridge.writeRange({ address: 'A1:A1', cells: [['Москва']] });
  assert.deepEqual(result, { ok: true, address: 'A1:A1', rowCount: 1, columnCount: 1 });
  assert.equal(f.store.get('A1'), 'Москва', 'stored under the canonical cell address');
  assert.equal(f.bridge.getState().busy, false);
});

test('a flat one-element array for a ONE-CELL range is read as a scalar, never indexed', async () => {
  // A shape the measurement never produced, and the residual the reviewer asked about: a native answering a
  // one-cell range with `['Москва']`. Reading a scalar cannot index a FIRST CHARACTER, so a one-character
  // request cannot be "proved" against it.
  const f = rig({ noOp: true, values: new Map([['A1', ['Москва']]]) });
  const result = await f.bridge.writeRange({ address: 'A1', cells: [['М']] });
  assert.equal(result.ok, false, 'М is not a proof of the flat answer Москва');
  assert.equal(result.code, 'APPLY_UNCERTAIN');
  assert.equal(f.bridge.getState().busy, true);
});

test('a requested `#`-leading VALUE is proved by the match', async () => {
  // MEASURED: `SetValue('#REF!')` stores the literal text. The `#`-error test that used to run before the
  // request-type branch refused such a cell after a perfectly correct write, so the run stopped and the slot
  // stayed held for a legal request.
  const f = rig({ values: new Map([['A1', '#REF!']]) });
  const result = await f.bridge.writeRange({ address: 'A1', cells: [['#REF!']] });
  assert.equal(result.ok, true, 'text the caller literally asked for is proved by the match');
});

test('a VALUE the readback answers as an error is still never a proof of a different request', async () => {
  const f = rig({ values: new Map([['A1', '#VALUE!']]) });
  const result = await f.bridge.writeRange({ address: 'A1', cells: [['300']] });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'APPLY_UNCERTAIN');
});

test('a FORMULA is proved by holding a formula even when its VALUE reads as an error', async () => {
  // The request type decides which proof applies, and it is decided FIRST. With the error-value test running
  // first, a correctly stored formula that evaluates to an error was scored unproved, contradicting the
  // stated rule that a formula cell is proved by HOLDING A FORMULA.
  const f = rig({ values: new Map([['A1', '#DIV/0!']]) });
  const result = await f.bridge.writeRange({ address: 'A1', cells: [['=1/0']] });
  assert.equal(result.ok, true, 'the cell still holds its formula, which is the stated proof');
});

test('a formula inside a BLOCK is proved by the addressal read, not by the block read', async () => {
  // The double reproduces the measured block behaviour: `GetFormula()` over a multi-cell range answers the
  // computed VALUES. A proof built on that block read scores the formula cell 0; only the addressal
  // single-cell read proves it.
  const f = rig();
  const result = await f.bridge.writeRange({ address: 'A1:B1', cells: [['x', '=1+1']] });
  assert.equal(result.ok, true, 'the block carries a text cell and a formula cell');
  assert.equal(f.store.get('B1'), '=1+1');
});

test('a PRE_INSERT refusal is a KNOWN error that RELEASES the slot', async () => {
  const f = rig({ forge: ['PRE_INSERT', 'CAPABILITY_UNAVAILABLE'] });
  const result = await f.bridge.writeRange({ address: 'A1', cells: [['x']] });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CAPABILITY_UNAVAILABLE', 'nothing reached the sheet, so it is a known class');
  assert.equal(f.bridge.getState().busy, false);
  assert.equal(f.bridge.getState().uncertain, false);
});

test('a POST_INSERT refusal is UNCERTAIN and the slot is HELD', async () => {
  // The single most important pin in this file: the phase slot travels inside the answer the untrusted
  // native composes, so a post-write answer that merely LOOKS like a refusal must never be read as a known
  // error — a known error would release the slot and invite a retry of a mutation that may have happened.
  const f = rig({ forge: ['POST_INSERT', 'CAPABILITY_UNAVAILABLE'] });
  const result = await f.bridge.writeRange({ address: 'A1', cells: [['x']] });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'APPLY_UNCERTAIN');
  assert.equal(f.bridge.getState().uncertain, true);
  assert.equal(f.bridge.getState().busy, true);
});

test('an unproved flag and a malformed answer both settle UNCERTAIN with the slot held', async () => {
  for (const forge of [
    ['POST_INSERT', 1, 1, 0],          // one flag, not proved
    ['POST_INSERT', 2, 2, 1, 1, 1, 1], // a shape that disagrees with the 1x1 request
    ['POST_INSERT', 1, 1],             // a missing flag
    ['POST_INSERT'],                   // no shape at all
    ['PRE_INSERT', 'NOT_A_REAL_CODE']  // an unknown name cannot release the slot either
  ]) {
    const f = rig({ forge });
    const result = await f.bridge.writeRange({ address: 'A1', cells: [['x']] });
    assert.equal(result.ok, false, JSON.stringify(forge));
    assert.equal(result.code, 'APPLY_UNCERTAIN', JSON.stringify(forge));
    assert.equal(f.bridge.getState().busy, true, `slot held for ${JSON.stringify(forge)}`);
    await checkpoint();
  }
});

test('the leg refuses before any dispatch when the caller is not a Cell editor or the request is malformed', async () => {
  const wrong = rig({ editorType: 'word' });
  assert.equal((await wrong.bridge.writeRange({ address: 'A1', cells: [['x']] })).ok, false);
  assert.equal(wrong.commands.length, 0, 'nothing is dispatched for the wrong editor');

  const f = rig();
  for (const [request, code] of [
    [{ address: 'a1', cells: [['x']] }, 'CAPABILITY_UNAVAILABLE'],
    [{ address: 'A1', cells: [] }, 'TOOL_ERROR'],
    [{ address: 'A1', cells: [[]] }, 'TOOL_ERROR'],
    [{ address: 'A1', cells: [['x', 1]] }, 'TOOL_ERROR'],
    [{ address: 'A1', cells: [['x'.repeat(LIMITS.writeRangeCellBytes + 1)]] }, 'BYTE_LIMIT'],
    [{ address: 'A1', cells: Array.from({ length: LIMITS.writeRangeRowsMax + 1 }, () => ['x']) }, 'TOOL_ERROR']
  ]) {
    const result = await f.bridge.writeRange(request);
    assert.equal(result.ok, false, JSON.stringify(request).slice(0, 60));
    assert.equal(result.code, code, JSON.stringify(request).slice(0, 60));
    assert.equal(f.commands.length, 0, 'a refused request never reaches the editor');
  }
  assert.equal(f.store.size, 0, 'and nothing was written');
});

test('the BODY refuses an address that disagrees with the matrix, as a KNOWN pre-insert refusal', async () => {
  // The bridge bounds the request but does NOT compare the address with the matrix: that precondition is
  // the body's, and it is answered BEFORE the phase turns. So the command IS dispatched, and the answer is
  // still a known refusal that releases the slot rather than an uncertainty about a write that never ran.
  for (const request of [
    { address: 'A1:B2', cells: [['x']] },
    { address: 'B2:A1', cells: [['a', 'b'], ['c', 'd']] }
  ]) {
    const f = rig();
    const result = await f.bridge.writeRange(request);
    assert.equal(result.ok, false, JSON.stringify(request));
    assert.equal(result.code, 'CAPABILITY_UNAVAILABLE', JSON.stringify(request));
    assert.equal(f.commands.length, 1, 'the request did reach the editor');
    assert.equal(f.store.size, 0, 'and the body refused before its first SetValue');
    assert.equal(f.bridge.getState().busy, false, 'a genuine pre-insert refusal releases the slot');
  }
});

// ---------------------------------------------------------------------------------------------------------
// THE SHEET SELECTOR (T5.3b): write an addressed block into a NAMED or INDEXED sheet, through the measured
// `Api.GetSheet`, and prove it with a readback OF THAT SHEET. A write is a MUTATION, so a refusal BEFORE the
// first `SetValue` is a known class while any unproved outcome after it is the uncertain one.
// ---------------------------------------------------------------------------------------------------------
function twoSheetRig() {
  return rig({
    activeIndex: 0,
    sheets: [
      { name: 'Sprint1', index: 0, store: new Map([['A1', 'active-a1']]) },
      { name: 'Данные', index: 1, store: new Map([['A1', 'data-a1']]) }
    ]
  });
}

test('a write into a NAMED sheet lands THERE and never switches the active sheet', async () => {
  // MEASURED natively before this leg was written: writing through another sheet's own range object leaves the
  // active sheet exactly where it was. This test pins that, so a future implementation that activates the target
  // (or restores the previous sheet by hand) fails here.
  const f = twoSheetRig();
  const result = await f.bridge.writeRange({ address: 'B2', cells: [['written']], sheetName: 'Данные' });
  assert.equal(result.ok, true);
  assert.deepEqual(result, { ok: true, address: 'B2', rowCount: 1, columnCount: 1 });
  assert.equal(f.book[1].store.get('B2'), 'written', 'the value is in the SELECTED sheet');
  assert.equal(f.book[0].store.get('B2'), undefined, 'and NOT in the active one');
  assert.equal(f.book[0].store.get('A1'), 'active-a1', 'whose own cells are untouched');
  assert.equal(f.setActiveAttempts(), 0, 'nothing activated anything');
  assert.equal(f.commands[0].scope.sheetName, 'Данные');
  assert.equal(f.commands[0].scope.sheetIndex, null);
});

test('the write and ALL its proofs read the SELECTED sheet, not the active one', async () => {
  // The selected sheet's A1 holds text while the active sheet's A1 holds DIFFERENT text: a readback that ran on
  // the active sheet cannot satisfy the proof, so this single test kills a write-side and a proof-side mistake.
  const f = rig({
    activeIndex: 0,
    sheets: [
      { name: 'Sprint1', index: 0, store: new Map([['B2', 'from-active']]) },
      { name: 'Данные', index: 1, store: new Map([['B2', 'from-selected']]) }
    ]
  });
  const selected = await f.bridge.writeRange({ address: 'B2', cells: [['new']], sheetName: 'Данные' });
  assert.equal(selected.ok, true);
  assert.equal(f.book[1].store.get('B2'), 'new');
  assert.equal(f.book[0].store.get('B2'), 'from-active', 'the active sheet still holds ITS value');
  assert.equal(f.setActiveAttempts(), 0);
  // A write to a sheet that does NOT exist cannot reach a cell at all, which is the other half of the same rule.
  const missing = rig({ activeIndex: 0, sheets: [{ name: 'Sprint1', index: 0 }] });
  const refused = await missing.bridge.writeRange({ address: 'B2', cells: [['new']], sheetName: 'Нет' });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'TOOL_ERROR');
  assert.equal(missing.setValueCalls(), 0, 'not one cell was written');
});

test('sheetIndex 0 writes into the FIRST sheet even when a DIFFERENT sheet is active', async () => {
  const f = rig({
    activeIndex: 1,
    sheets: [
      { name: 'Sprint1', index: 0, store: new Map() },
      { name: 'Второй', index: 1, store: new Map() }
    ]
  });
  const result = await f.bridge.writeRange({ address: 'C3', cells: [['first']], sheetIndex: 0 });
  assert.equal(result.ok, true);
  assert.equal(f.book[0].store.get('C3'), 'first', 'index 0 is a REAL selector, not an absent one');
  assert.equal(f.book[1].store.get('C3'), undefined, 'and the active sheet received nothing');
  assert.equal(f.commands[0].scope.sheetIndex, 0, 'the zero crosses as 0, never as null');
  assert.equal(f.setActiveAttempts(), 0);
});

test('an unknown sheet is a KNOWN refusal raised BEFORE the first mutation', async () => {
  for (const selector of [{ sheetName: 'НетТакого' }, { sheetIndex: 7 }]) {
    const f = twoSheetRig();
    const result = await f.bridge.writeRange({ address: 'A1', cells: [['x']], ...selector });
    assert.equal(result.ok, false, JSON.stringify(selector));
    assert.equal(result.code, 'TOOL_ERROR', JSON.stringify(selector));
    assert.deepEqual(f.commands[0].answered, ['PRE_INSERT', 'TOOL_ERROR'], 'a pre-mutation refusal');
    assert.equal(f.setValueCalls(), 0, 'nothing was written');
    assert.equal(f.book[1].store.get('A1'), 'data-a1', 'the target sheet still holds exactly its own value');
    assert.equal(f.book[1].store.has('B2'), false, 'and the cell the request named is still absent');
    // A refusal before the mutation releases the slot, so the next request really reaches the editor.
    const second = await f.bridge.writeRange({ address: 'A1', cells: [['x']] });
    assert.equal(second.ok, true, 'the slot was released');
    assert.equal(f.commands.length, 2);
  }
});

test('the selector is CLOSED before any dispatch, and the slot is not taken', async () => {
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
    const result = await f.bridge.writeRange({ address: 'A1', cells: [['x']], ...selector });
    assert.equal(result.ok, false, why);
    assert.equal(result.code, 'TOOL_ERROR', why);
    assert.equal(f.commands.length, 0, `${why}: nothing may reach the editor`);
    assert.equal(f.setActiveAttempts(), 0, why);
  }
});

test('a FORMULA written into a selected sheet is proved against THAT sheet', async () => {
  // The formula half of the proof runs its own addressal read, so it can silently run on the WRONG sheet: the
  // active sheet's cell would hold no formula, the check would fail and a legitimate write would be reported
  // UNCERTAIN. Only a test that writes a FORMULA through a selector reaches that code at all.
  const f = rig({
    activeIndex: 0,
    sheets: [
      { name: 'Sprint1', index: 0, store: new Map() },
      { name: 'Данные', index: 1, store: new Map() }
    ]
  });
  const result = await f.bridge.writeRange({ address: 'D5', cells: [['=1+2']], sheetName: 'Данные' });
  assert.equal(result.ok, true, 'a formula write into a named sheet is PROVED, not merely performed');
  assert.equal(f.book[1].store.get('D5'), '=1+2', 'the selected sheet holds the source');
  assert.equal(f.book[0].store.get('D5'), undefined, 'and the active sheet holds nothing');
  assert.equal(f.setActiveAttempts(), 0);
  // The other side of the same rule: when the addressed cell did NOT end up holding a formula, the body's own
  // flag must SAY so rather than pass. The flag is what the tool publishes and the tool is what refuses a zero.
  const hostile = rig({
    activeIndex: 0,
    sheets: [
      { name: 'Sprint1', index: 0, store: new Map() },
      { name: 'Данные', index: 1, store: new Map(), formulas: new Map([['D5', 'stored-as-text']]) }
    ]
  });
  const unproved = await hostile.bridge.writeRange({ address: 'D5', cells: [['=1+2']], sheetName: 'Данные' });
  assert.deepEqual(hostile.commands[0].answered, ['POST_INSERT', 1, 1, 0],
    'the flag reports that the cell does NOT hold a formula');
  assert.equal(unproved.ok, false, 'and a zero flag can never pass the exact-proof rule');
  assert.equal(unproved.code, 'APPLY_UNCERTAIN', 'which after the mutation is the uncertain class, not a known one');
  assert.equal(hostile.bridge.getState().busy, true, 'and the slot stays held');
  await checkpoint();
});

test('a write with NO selector goes to the ACTIVE sheet, whatever its index is', async () => {
  // "No selector means the active sheet" has to hold for a book whose active sheet is NOT index 0: an
  // implementation that fell back to `Api.GetSheet(0)` would be indistinguishable in a single-sheet book.
  const f = rig({
    activeIndex: 1,
    sheets: [
      { name: 'Sprint1', index: 0, store: new Map() },
      { name: 'Второй', index: 1, store: new Map() }
    ]
  });
  const result = await f.bridge.writeRange({ address: 'E5', cells: [['active-target']] });
  assert.equal(result.ok, true);
  assert.equal(f.book[1].store.get('E5'), 'active-target', 'the ACTIVE sheet received the write');
  assert.equal(f.book[0].store.get('E5'), undefined, 'and index 0 received nothing');
  assert.equal(f.commands[0].scope.sheetName, null);
  assert.equal(f.commands[0].scope.sheetIndex, null);
  assert.equal(f.setActiveAttempts(), 0);
});

test('the resolved sheet is TIED to the request before anything is written', async () => {
  // THE GAP THIS CLOSES: the readback reads the same object it wrote, so it can never notice that the OBJECT was
  // the wrong sheet. A build whose lookup resolves a different sheet (or clamps an index) must therefore be
  // caught by comparing the sheet's OWN identity with the request — BEFORE the mutation.
  for (const [knob, selector, why] of [
    [{ nameLies: true }, { sheetName: 'Данные' }, 'a lookup that answered a SHEET WITH ANOTHER NAME'],
    [{ indexLies: true }, { sheetIndex: 1 }, 'a lookup that answered a SHEET AT ANOTHER INDEX']
  ]) {
    const f = rig({
      activeIndex: 0,
      sheets: [
        { name: 'Sprint1', index: 0, store: new Map() },
        { name: 'Данные', index: 1, store: new Map(), ...knob }
      ]
    });
    const result = await f.bridge.writeRange({ address: 'F6', cells: [['x']], ...selector });
    assert.equal(result.ok, false, why);
    assert.equal(result.code, 'TOOL_ERROR', why);
    assert.deepEqual(f.commands[0].answered, ['PRE_INSERT', 'TOOL_ERROR'], `${why}: refused before the mutation`);
    assert.equal(f.setValueCalls(), 0, `${why}: NOT ONE cell was written`);
    assert.equal(f.book[1].store.has('F6'), false, `${why}: the target sheet is untouched`);
    assert.equal(f.book[0].store.has('F6'), false, `${why}: and so is the active one`);
  }
  // The honest case still writes, so the tie is not a blanket refusal.
  const good = rig({
    activeIndex: 0,
    sheets: [
      { name: 'Sprint1', index: 0, store: new Map() },
      { name: 'Данные', index: 1, store: new Map() }
    ]
  });
  assert.equal((await good.bridge.writeRange({ address: 'F6', cells: [['x']], sheetName: 'Данные' })).ok, true);
  assert.equal(good.book[1].store.get('F6'), 'x');
});

test('the phase turns IMMEDIATELY before the first SetValue, and no activation is authored', async () => {
  const f = twoSheetRig();
  await f.bridge.writeRange({ address: 'A1', cells: [['x']], sheetName: 'Данные' });
  const source = f.commands[0].source;
  const phaseAt = source.indexOf("phase = 'POST_INSERT'");
  const firstWrite = source.indexOf('SetValue(');
  assert.ok(phaseAt > 0 && firstWrite > 0, 'both markers exist');
  assert.ok(phaseAt < firstWrite, 'the phase turns before the first mutating call, never after it');
  assert.match(source, /GetSheet\(/, 'the body resolves the selected sheet through Api.GetSheet');
  assert.equal(source.includes('SetActive'), false, 'and never activates it');
  await checkpoint();
});
