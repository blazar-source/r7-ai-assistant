// Host coverage for the SHEETLIST leg through the REAL bridge (Sprint 4, T5.1).
//
// `tools-cell-sheets.test.js` drives the `list_sheets` descriptor against a double, which can never exercise
// `decodeSheetList` or the `sheetlist` dispatch branch. This file does, and it reproduces the ONE measured fact
// the leg exists to respect: on a live editor `Api.GetSheets()[i]` and `Api.GetActiveSheet()` are DIFFERENT
// wrapper objects even for the same sheet, so a listing that decided "active" by object identity would mark
// every sheet inactive (and the decoder would refuse the answer, because a book always has exactly one active
// sheet). The rig therefore hands out a FRESH wrapper on every call, as the editor does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createR7Bridge } from '../../src/plugin/bridge.js';
import { LIMITS } from '../../src/shared/limits.js';

function rig(options = {}) {
  const fixture = options.sheets ?? [{ name: 'Sprint1' }, { name: 'Данные', visible: false }];
  const activeIndex = options.activeIndex ?? 0;
  const namespace = { scope: {} };
  const commands = [];
  // A FRESH wrapper per call, and never the same object twice: that is the measured behaviour, and it is what
  // makes an identity-based "active" test fail.
  const wrapper = (entry, index) => {
    const sheet = {};
    if (options.noGetName !== true) sheet.GetName = () => entry.name;
    if (options.noGetIndex !== true) sheet.GetIndex = () => index;
    if (options.noGetVisible !== true) sheet.GetVisible = () => entry.visible !== false;
    return sheet;
  };
  const api = {
    GetSheets: () => (options.noGetSheets === true ? undefined : fixture.map((entry, index) => wrapper(entry, index))),
    // The body addresses each sheet by INDEX through this call (a call result is a receiver the authored-code
    // audit accepts); the rig answers it the way the measured editor does, with a FRESH wrapper.
    GetSheet: (index) => (options.noGetSheet === true ? undefined
      : (typeof index === 'number' && fixture[index] !== undefined ? wrapper(fixture[index], index) : null)),
    GetActiveSheet: () => wrapper(fixture[activeIndex], activeIndex)
  };
  const plugin = { info: { editorType: 'cell' },
    callCommand(body, close, recalculate, callback) {
      const source = Function.prototype.toString.call(body);
      const scope = namespace.scope;
      let answered;
      try { answered = new Function('Api', 'scope', 'return (' + source + ')();')(api, scope); }
      catch (error) { answered = 'THREW: ' + error.message; }
      commands.push({ scope, answered });
      callback(options.forge === undefined ? answered : options.forge);
      return false;
    } };
  const bridge = createR7Bridge(plugin, { editorType: 'cell', ascNamespace: namespace,
    clock: { now: () => 0 }, timers: { schedule() { return {}; }, clear() {} } });
  return { bridge, commands, api };
}

test('a listing is served, proved, and carries every sheet with its live state', async () => {
  const f = rig();
  const result = await f.bridge.listSheets({});
  assert.equal(result.ok, true);
  assert.equal(result.count, 2);
  assert.equal(result.activeIndex, 0);
  assert.equal(result.activeName, 'Sprint1');
  assert.deepEqual(result.sheets.map((sheet) => `${sheet.name}:${sheet.index}:${sheet.active}:${sheet.visible}`),
    ['Sprint1:0:true:true', 'Данные:1:false:false']);
  // The authored body's own answer, as it crossed the native boundary: a header, then four slots per sheet.
  assert.deepEqual(f.commands[0].answered, [2, 0, 'Sprint1', 'Sprint1', 0, 1, 1, 'Данные', 1, 0, 0]);
  // The leg has NO arguments; the only thing the scope carries is the bound the body checks against.
  assert.deepEqual(f.commands[0].scope, { maxSheets: LIMITS.sheetListMax });
});

test('the active sheet is found by NAME/INDEX even though every wrapper is a different object', async () => {
  // The rig never returns the same wrapper twice, exactly as the measured editor behaves. A body that compared
  // objects would answer "no sheet is active", and the decoder would refuse that answer outright.
  const f = rig({ sheets: [{ name: 'A' }, { name: 'B' }, { name: 'C' }], activeIndex: 2 });
  const result = await f.bridge.listSheets({});
  assert.equal(result.ok, true);
  assert.equal(result.activeName, 'C');
  assert.equal(result.activeIndex, 2);
  assert.deepEqual(result.sheets.map((sheet) => sheet.active), [false, false, true], 'only the sheet at the active INDEX is active');
  // AND THE TRAP IS REAL IN THIS RIG, demonstrated rather than asserted in prose: the same sheet comes back as
  // two different objects, so an identity-based "active" test would have to fail.
  const collected = f.api.GetSheet(2);
  const active = f.api.GetActiveSheet();
  assert.notEqual(collected, active, 'the same sheet is a DIFFERENT object, exactly as measured');
  assert.equal(collected.GetName(), active.GetName(), 'and both name the sheet the listing marked active');
});

test('a hidden sheet is reported as not visible, and the active one may be hidden', async () => {
  const f = rig({ sheets: [{ name: 'A', visible: false }, { name: 'B' }], activeIndex: 0 });
  const result = await f.bridge.listSheets({});
  assert.equal(result.ok, true);
  assert.equal(result.sheets[0].active, true);
  assert.equal(result.sheets[0].visible, false, 'the active sheet really says it is hidden');
  assert.equal(result.sheets[1].visible, true);
});

test('a facade without the listing primitives answers its own known refusal', async () => {
  for (const knob of [{ noGetSheets: true }, { noGetSheet: true }, { noGetName: true }, { noGetIndex: true }, { noGetVisible: true }]) {
    const f = rig(knob);
    const result = await f.bridge.listSheets({});
    assert.equal(result.ok, false, JSON.stringify(knob));
    assert.equal(result.code, 'CAPABILITY_UNAVAILABLE', JSON.stringify(knob));
    assert.deepEqual(f.commands[0].answered, ['CAPABILITY_UNAVAILABLE'], 'the refusal is the leg own one-slot shape');
    // A READ changed nothing, so the slot is released and the next request really reaches the editor again.
    const second = await f.bridge.listSheets({});
    assert.equal(second.code, 'CAPABILITY_UNAVAILABLE');
    assert.equal(f.commands.length, 2, 'the second call dispatched rather than finding a busy bridge');
  }
});

test('a workbook above the sheet cap is a KNOWN refusal, never a truncated listing', async () => {
  const over = Array.from({ length: LIMITS.sheetListMax + 1 }, (_, index) => ({ name: `S${index}` }));
  const f = rig({ sheets: over });
  const result = await f.bridge.listSheets({});
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CAPABILITY_UNAVAILABLE');
  assert.deepEqual(f.commands[0].answered, ['CAPABILITY_UNAVAILABLE']);

  // A workbook exactly AT the cap is served, so the bound is not off by one.
  const at = Array.from({ length: LIMITS.sheetListMax }, (_, index) => ({ name: `S${index}` }));
  const served = await rig({ sheets: at }).bridge.listSheets({});
  assert.equal(served.ok, true);
  assert.equal(served.count, LIMITS.sheetListMax);
});

test('a malformed or forged answer is INVALID_DATA — this leg changes nothing, so it never says UNCERTAIN', async () => {
  const forged = [
    [[], 'an empty answer'],
    [[2, 0, 'A', 'A', 0, 1, 1, 'B', 1, 0], 'one slot too few'],
    [[2, 0, 'A', 'A', 0, 1, 1, 'B', 1, 0, 1, 1], 'one slot too many'],
    [[0, 0, 'A'], 'a book with no sheets'],
    [[2, 0, 'A', 'A', 0, 0, 1, 'B', 1, 0, 1], 'NO sheet marked active'],
    [[2, 0, 'A', 'A', 0, 1, 1, 'B', 1, 1, 1], 'TWO sheets marked active'],
    // The flag bound is pinned on a NON-active entry ON PURPOSE: a bad flag on the ACTIVE entry is refused by
    // the exactly-one-active rule instead, so without this case the bound could be deleted unnoticed.
    [[2, 0, 'A', 'A', 0, 1, 1, 'B', 1, 2, 1], 'a bad ACTIVE flag on a non-active entry'],
    [[2, 1, 'B', 'A', 0, 1, 1, 'B', 1, 1, 3], 'a bad VISIBLE flag on the active entry'],
    [[2, 0, 'A', 'A', 1, 1, 1, 'B', 0, 0, 1], 'indices that are not positional'],
    [[2, 0, 'A', 'B', 0, 1, 1, 'A', 1, 0, 1], 'the active name does not match the entry at that index'],
    [[2, 9, 'A', 'A', 0, 1, 1, 'B', 1, 0, 1], 'an active index outside the list'],
    [[2, 0, 'A', '', 0, 1, 1, 'B', 1, 0, 1], 'an empty sheet name'],
    [[2, 0, 'A', 'A', -1, 1, 1, 'B', 1, 0, 1], 'a negative index'],
    [[2, 0, 'A', 'A', 0, 2, 1, 'B', 1, 0, 1], 'a flag that is not 0 or 1'],
    [[2, 0, 'A', 'A', 0, 1, 1, 'B', 1, 0, 'yes'], 'a string flag'],
    [[LIMITS.sheetListMax + 1, 0, 'A', 'A', 0, 1, 1], 'a count above the cap'],
    ['a string', 'not an array'],
    [null, 'null']
  ];
  for (const [forge, why] of forged) {
    const f = rig({ forge });
    const result = await f.bridge.listSheets({});
    assert.equal(result.ok, false, why);
    assert.equal(result.code, 'INVALID_DATA', why);
  }
  // A name above the per-name byte bound is refused the same way, and a name exactly at it is served.
  const longName = 'я'.repeat(LIMITS.sheetListNameBytes / 2 + 1);
  const refused = await rig({ forge: [1, 0, longName, longName, 0, 1, 1] }).bridge.listSheets({});
  assert.equal(refused.code, 'INVALID_DATA');
  // The ENTRY bound is pinned separately from the header's, and on a NON-active entry: a long name used for
  // both slots is refused by the header rule first, so the record rule would look covered when it was not.
  const entryOverBound = await rig({ forge: [2, 0, 'A', 'A', 0, 1, 1, longName, 1, 0, 1] }).bridge.listSheets({});
  assert.equal(entryOverBound.code, 'INVALID_DATA', 'the entry name bound is its own rule');
  const border = 'я'.repeat(LIMITS.sheetListNameBytes / 2);
  const served = await rig({ forge: [1, 0, border, border, 0, 1, 1] }).bridge.listSheets({});
  assert.equal(served.ok, true);
  assert.equal(served.sheets[0].name, border);
});

test('the listing is ONE dispatch and leaves the slot free', async () => {
  const f = rig();
  assert.equal((await f.bridge.listSheets({})).ok, true);
  assert.equal((await f.bridge.listSheets({})).ok, true);
  assert.equal(f.commands.length, 2, 'a read never holds the slot');
});
