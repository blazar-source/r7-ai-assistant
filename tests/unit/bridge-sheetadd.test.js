// Host coverage for the SHEETADD leg through the REAL bridge (Sprint 4, T5.2).
//
// `add_sheet` is a MUTATION whose subject is the workbook, so its proof is a POSTCONDITION measured after ONE
// `Api.AddSheet(...)`: the count grew by exactly one, the new sheet is the LAST one, its name is the name the
// editor reports, it is the active sheet (by NAME/INDEX — object identity is measurably unusable), and every
// former sheet kept its position. `AddSheet` returns `undefined`, which is neither success nor failure, so the
// answer is never read from its return value.
//
// THE RIG MODELS A BOOK, not a fixed answer: `AddSheet` really appends, and every knob is a way the editor
// could behave differently than the request assumed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createR7Bridge } from '../../src/plugin/bridge.js';
import { LIMITS } from '../../src/shared/limits.js';

function rig(options = {}) {
  // `sheets` is the live book; each entry is { name, visible }.
  const book = (options.sheets ?? [{ name: 'Sprint1' }]).map((entry) => ({ ...entry }));
  const active = { index: options.activeIndex ?? 0 };
  const namespace = { scope: {} };
  const commands = [];
  const addCalls = [];
  let setActiveCalls = 0;
  let deleteCalls = 0;
  const wrapper = (entry, index) => {
    const sheet = {};
    if (options.noGetName !== true) sheet.GetName = () => entry.name;
    if (options.noGetIndex !== true) sheet.GetIndex = () => index;
    if (options.noGetVisible !== true) sheet.GetVisible = () => entry.visible !== false;
    sheet.SetActive = () => { setActiveCalls += 1; active.index = index; };
    // A DELETE SPY, so "an uncertain add never deletes the sheet it may have created" is observable instead of
    // assumed: the tool must not reach for a cleanup it was never asked to perform.
    sheet.Delete = () => { deleteCalls += 1; };
    return sheet;
  };
  const api = {
    GetSheets: () => (options.noGetSheets === true ? undefined : book.map((entry, index) => wrapper(entry, index))),
    GetSheet: (key) => {
      if (options.noGetSheet === true) return undefined;
      const index = typeof key === 'number' ? key : book.findIndex((entry) => entry.name === key);
      return index >= 0 && book[index] !== undefined ? wrapper(book[index], index) : null;
    },
    GetActiveSheet: () => wrapper(book[active.index], active.index)
  };
  if (options.noAddSheet !== true) {
    api.AddSheet = (name) => {
      addCalls.push(name === undefined ? null : name);
      if (options.addDoesNothing === true) return undefined;
      // A wrong build can do any of these instead of a clean append + activate.
      if (options.addInsertsAtFront === true) {
        book.unshift({ name: options.addNamesDifferently === true ? 'Иначе' : (name ?? 'Лист1') });
        active.index = book.length - 1;
        return undefined;
      }
      book.push({ name: options.addNamesDifferently === true ? 'Иначе' : (name ?? 'Лист1') });
      if (options.addDoesNotActivate !== true) active.index = book.length - 1;
      if (options.reorderOnAdd === true) { book.reverse(); active.index = book.length - 1; }
      if (options.duplicateName === true && name !== undefined) book.push({ name });
      return undefined;
    };
  }
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
  return { bridge, commands, book, addCalls, api, setActiveCalls: () => setActiveCalls, deleteCalls: () => deleteCalls };
}

test('a named add is proved: one sheet more, last index, the requested name, active, others untouched', async () => {
  const f = rig({ sheets: [{ name: 'A' }, { name: 'B' }, { name: 'C' }], activeIndex: 1 });
  const result = await f.bridge.addSheet({ name: 'Итог' });
  assert.equal(result.ok, true);
  assert.deepEqual(result, { ok: true, index: 3, name: 'Итог', active: true,
    previousActive: { index: 1, name: 'B' } });
  assert.deepEqual(f.addCalls, ['Итог'], 'exactly ONE AddSheet call, with the requested name');
  assert.deepEqual(f.book.map((entry) => entry.name), ['A', 'B', 'C', 'Итог']);
  // The body's own answer: header first, then the BEFORE names and the AFTER names.
  assert.deepEqual(f.commands[0].answered,
    ['POST_INSERT', 3, 4, 3, 'Итог', 3, 'Итог', 1, 'B', 'A', 'B', 'C', 'A', 'B', 'C', 'Итог']);
  assert.deepEqual(f.commands[0].scope, { maxSheets: LIMITS.sheetListMax, requestedName: 'Итог' });
  assert.equal(f.setActiveCalls(), 0, 'the previous active sheet is NOT restored, and no SetActive is authored');
});

test('an add WITHOUT a name never predicts it: the name is the one the editor reports', async () => {
  const f = rig({ sheets: [{ name: 'Sprint1' }], activeIndex: 0 });
  const result = await f.bridge.addSheet({});
  assert.equal(result.ok, true);
  assert.equal(result.name, 'Лист1', 'the LOCALISED default the editor produced, read back');
  assert.equal(result.index, 1);
  assert.deepEqual(f.addCalls, [null], 'AddSheet is called with NO argument when the caller named none');
});

test('a name that already exists refuses BEFORE any mutation', async () => {
  const f = rig({ sheets: [{ name: 'A' }, { name: 'B' }] });
  const result = await f.bridge.addSheet({ name: 'B' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TOOL_ERROR');
  assert.deepEqual(f.addCalls, [], 'nothing was added');
  assert.deepEqual(f.commands[0].answered, ['PRE_INSERT', 'TOOL_ERROR'], 'a pre-mutation refusal');
  assert.deepEqual(f.book.map((entry) => entry.name), ['A', 'B']);
});

test('the book cap refuses BEFORE any mutation', async () => {
  const full = Array.from({ length: LIMITS.sheetListMax }, (_, index) => ({ name: `S${index}` }));
  const f = rig({ sheets: full });
  const result = await f.bridge.addSheet({ name: 'Ещё' });
  assert.equal(result.ok, false);
  assert.deepEqual(f.addCalls, [], 'the cap is checked before the mutation, not after');
  assert.equal(f.book.length, LIMITS.sheetListMax);
  // ONE below the cap is served, so the bound is not off by one.
  const room = rig({ sheets: full.slice(0, LIMITS.sheetListMax - 1) });
  assert.equal((await room.bridge.addSheet({ name: 'Ещё' })).ok, true);
});

test('a facade missing a primitive answers its own PRE-mutation refusal', async () => {
  for (const knob of [{ noAddSheet: true }, { noGetSheets: true }, { noGetSheet: true },
    { noGetName: true }, { noGetIndex: true }]) {
    const f = rig(knob);
    const result = await f.bridge.addSheet({ name: 'X' });
    assert.equal(result.ok, false, JSON.stringify(knob));
    assert.equal(result.code, 'CAPABILITY_UNAVAILABLE', JSON.stringify(knob));
    assert.deepEqual(f.addCalls, [], JSON.stringify(knob));
    // A refusal BEFORE the mutation changes nothing, so the slot is released and a second call really dispatches.
    const second = await f.bridge.addSheet({ name: 'X' });
    assert.equal(second.code, 'CAPABILITY_UNAVAILABLE');
    assert.equal(f.commands.length, 2, 'the second call dispatched rather than finding a busy bridge');
  }
});

test('an unproved POSTCONDITION is UNCERTAIN, and the slot stays HELD', async () => {
  // Every knob is a way a build could leave the book in a state this leg cannot prove. After the mutation the
  // only honest answer is UNCERTAIN — never a known error, never a retry, and the "failed" sheet is NOT deleted.
  const knobs = [
    [{ addDoesNothing: true }, 'the count did not grow'],
    [{ addNamesDifferently: true }, 'the sheet was named something else'],
    [{ addInsertsAtFront: true }, 'the new sheet is first, not last'],
    [{ addDoesNotActivate: true }, 'the new sheet is not active'],
    [{ reorderOnAdd: true }, 'the former sheets changed order'],
    [{ duplicateName: true }, 'the name was created even though it already did not exist (a duplicate)']
  ];
  for (const [knob, why] of knobs) {
    const f = rig({ sheets: [{ name: 'Sprint1' }], ...knob });
    const lengthBefore = f.book.length;
    const result = await f.bridge.addSheet({ name: 'Новый' });
    assert.equal(result.ok, false, why);
    assert.equal(result.code, 'APPLY_UNCERTAIN', why);
    // THE "NEVER DELETED" CLAUSE, asserted BEHAVIOURALLY: the rig counts every `Delete` on every wrapper it hands
    // out, and a sheet that the mutation may have created is still there. An assertion that merely observed the
    // book is non-empty could never fail.
    assert.equal(f.deleteCalls(), 0, `${why}: an uncertain add never deletes anything`);
    assert.ok(f.book.length >= lengthBefore, `${why}: the book is never left with FEWER sheets than it had`);
    // The slot stays HELD, and the class is the busy one rather than any failure at all.
    const second = await f.bridge.addSheet({ name: 'Другой' });
    assert.equal(second.code, 'EDITOR_BUSY', `${why}: the slot must stay held`);
  }
});

test('a forged or malformed answer after the mutation is UNCERTAIN, never a known error', async () => {
  const forged = [
    [[], 'an empty answer'],
    [['POST_INSERT'], 'a header with nothing behind it'],
    // EVERY size below is the one the DECLARED counts require (9 + before + after), so each case reaches the rule
    // it is named for instead of being refused earlier by the size equation. Two earlier drafts of this table got
    // that wrong, which is how a mutant campaign concluded that a load-bearing check was equivalent.
    [['POST_INSERT', 1, 2, 1, 'X', 1, 'X', 0, 'Sprint1', 'Sprint1', 'Sprint1', 'Иначе'], 'the after-list last name disagrees with the reported new name'],
    [['POST_INSERT', 1, 3, 1, 'X', 1, 'X', 0, 'Sprint1', 'Sprint1', 'Sprint1', 'X', 'ZZZ'], 'a count that grew by TWO, with a trailing member nothing validates'],
    [['POST_INSERT', 1, 2, 1, 'X', 1, 'X', 0, 'Sprint1', 'Sprint1', 'Sprint1', 'X', 'EXTRA'], 'one unvalidated trailing member under a correct count'],
    [['POST_INSERT', 1, 2, 0, 'X', 0, 'X', 0, 'Sprint1', 'Sprint1', 'Sprint1', 'X'], 'the new sheet claimed at a NON-last index'],
    [['POST_INSERT', 3, 4, 3, 'X', 3, 'X', 0, 'A', 'A', 'B', 'C', 'A', 'C', 'B', 'X'], 'the former sheets changed order away from the active position'],
    [['POST_INSERT', 1, 2, 1, 'X', 1, 'X', 0, 'X', 'X', 'X', 'X'], 'the new name DUPLICATES a former sheet'],
    [['POST_INSERT', 1, 2, 1, 'X', 1, 'X', 0, 'ZZZ', 'Sprint1', 'Sprint1', 'X'], 'the previous active NAME disagrees with the entry at its index'],
    [['POST_INSERT', 1, 2, 1, 'X', 1, 'X', 1, 'X', 'Sprint1', 'Sprint1', 'X'], 'a previous active INDEX pointing at the new sheet itself'],
    ['a string', 'not an array'],
    [null, 'null']
  ];
  for (const [forge, why] of forged) {
    const f = rig({ forge, sheets: [{ name: 'Sprint1' }] });
    const result = await f.bridge.addSheet({ name: 'X' });
    assert.equal(result.ok, false, why);
    assert.equal(result.code, 'APPLY_UNCERTAIN', why);
  }
  // A POST-phase refusal is also the uncertain class: the body reached the mutation before answering.
  const refused = rig({ forge: ['POST_INSERT', 'CAPABILITY_UNAVAILABLE'], sheets: [{ name: 'Sprint1' }] });
  assert.equal((await refused.bridge.addSheet({ name: 'X' })).code, 'APPLY_UNCERTAIN');
});

test('a PRE-phase refusal is a KNOWN class, and the slot is released', async () => {
  const f = rig({ forge: ['PRE_INSERT', 'TOOL_ERROR'], sheets: [{ name: 'Sprint1' }] });
  const known = await f.bridge.addSheet({ name: 'X' });
  assert.equal(known.ok, false);
  assert.equal(known.code, 'TOOL_ERROR');
  const second = await f.bridge.addSheet({ name: 'X' });
  assert.equal(second.code, 'TOOL_ERROR');
  assert.equal(f.commands.length, 2, 'a pre-mutation refusal released the slot');
});

test('the closed request class refuses BEFORE any dispatch', async () => {
  const cases = [
    [{ name: '' }, 'an empty name'],
    [{ name: 'я'.repeat(LIMITS.sheetListNameBytes / 2 + 1) }, 'a name above the byte bound'],
    [{ name: 42 }, 'a numeric name'],
    [{ name: 'X', extra: 1 }, 'an unknown key'],
    [null, 'no request at all'],
    ['name', 'a request that is not an object']
  ];
  for (const [raw, why] of cases) {
    const f = rig();
    const result = await f.bridge.addSheet(raw);
    assert.equal(result.ok, false, why);
    assert.equal(f.commands.length, 0, `${why}: nothing may reach the editor`);
  }
});
