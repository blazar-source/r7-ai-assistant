// Host coverage for the SHEETRENAME leg through the REAL bridge (Sprint 4, T5.4).
//
// `rename_sheet` is a MUTATION of the BOOK, so its proof is a POSTCONDITION measured after ONE `SetName(...)`: the
// count is unchanged, every other sheet keeps its name AND its position, the renamed sheet keeps its INDEX, the new
// name resolves at that index, and the OLD name no longer resolves at all. The active sheet is only RECORDED —
// never switched and never "restored" — because the measured behaviour is what it is.
//
// THE RIG MODELS A BOOK: `SetName` really rewrites the entry's name, so every knob is a way a build could behave
// differently than the request assumed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createR7Bridge } from '../../src/plugin/bridge.js';
import { LIMITS } from '../../src/shared/limits.js';
import { utf8ByteLength } from '../../src/shared/bytes.js';

function rig(options = {}) {
  const book = (options.sheets ?? [{ name: 'Sprint1' }, { name: 'Данные' }]).map((entry, index) => ({
    name: entry.name, index: entry.index ?? index
  }));
  const active = { index: options.activeIndex ?? 0 };
  const namespace = { scope: {} };
  const commands = [];
  const renameCalls = [];
  let setActiveAttempts = 0; let notifications = 0; let paintedNames = book.map(x => x.name);
  let live = book;   // a build that adds/removes a sheet on rename would change this
  // Names a build failed to RETIRE: the old name keeps resolving, which the postcondition must catch.
  const stale = new Map();
  const wrapper = (entry, lookupKey) => {
    const sheet = {
      GetName: () => (options.nameLies === true ? 'КтоТоДругой' : entry.name),
      // `lookupKey` is defined only on the two RESOLUTION paths (by name and by index), never on the collection or
      // the active sheet, which is what lets this knob model a lookup answering the right sheet under the WRONG
      // index without disturbing how the book lists itself.
      GetIndex: () => (options.indexLies === true ? 99
        : (options.indexShiftsLookup === true && lookupKey !== undefined ? entry.index + 1 : entry.index)),
      SetActive: () => { setActiveAttempts += 1; active.index = book.indexOf(entry); }
    };
    if (options.noSetNameMethod !== true) {
      sheet.SetName = (value) => {
        renameCalls.push(value);
        // A NATIVE THAT FAILS. This is the one build behaviour the whole phase machinery exists for, and it is the
        // only way the body's `catch` is reachable: without it the phase ordering is unobservable.
        if (options.setNameThrows === true) throw new Error('the native refused to rename');
        if (options.doesNothing === true) return undefined;
        if (options.keepsOldNameResolvable === true) stale.set(entry.name, entry);
        entry.name = options.renamesToSomethingElse === true ? 'Иначе' : value;
        if (options.dropsASheet === true) { live = book.slice(1); return undefined; }
        // A build that ADDED a sheet while renaming: the count grew, which the postcondition must reject.
        if (options.growsASheet === true) { live = book.concat([{ name: 'Лишний', index: book.length }]); return undefined; }
        // A build that moved the renamed sheet: its INDEX was not preserved.
        if (options.indexShifts === true) { entry.index = entry.index + 1; return undefined; }
        // A build that renamed the WRONG sheet, or that swapped the names of the others.
        if (options.swapsOthers === true) {
          const first = book[0], second = book[1];
          const held = first.name; first.name = second.name; second.name = held;
        }
        if (options.reorders === true) { book.reverse(); }
        return undefined;
      };
    }
    return sheet;
  };
  const api = {
    GetSheets: () => (options.noGetSheets === true ? undefined : (options.dropsASheet === true || options.growsASheet === true ? live : book).map((entry) => wrapper(entry))),
    GetSheet: (key) => {
      if (options.noGetSheet === true) return undefined;
      if (typeof key === 'number') {
        // A build whose ORDERED collection disagrees with what the per-index lookup answers: the index and the name
        // then disagree about which sheet is which, which the body must notice before renaming anything.
        const entry = (options.dropsASheet === true || options.growsASheet === true ? live : book)[key];
        return entry === undefined ? null : wrapper(entry, key);
      }
      if (stale.has(key)) return wrapper(stale.get(key), undefined);
      const found = book.find((entry) => entry.name === key);
      return found === undefined ? null : wrapper(found, undefined);
    },
    GetActiveSheet: () => wrapper(book[active.index], undefined)
  };
  if (!options.noNotification) api.sheetsChanged = () => {
    notifications++;
    if (options.notificationThrows) throw Error('UI event failed');
    paintedNames = book.map(x => x.name);
  };
  const plugin = { info: { editorType: 'cell' },
    callCommand(body, close, recalculate, callback) {
      const source = Function.prototype.toString.call(body);
      const scope = namespace.scope;
      let answered;
      try { answered = new Function('Api', 'scope', 'return (' + source + ')();')(api, scope); }
      catch (error) { answered = 'THREW: ' + error.message; }
      commands.push({ scope, source, answered });
      callback(options.forge === undefined ? answered : options.forge);
      return false;
    } };
  const bridge = createR7Bridge(plugin, { editorType: 'cell', ascNamespace: namespace,
    clock: { now: () => 0 }, timers: { schedule() { return {}; }, clear() {} } });
  return { paintedNames: () => paintedNames, notifications: () => notifications, bridge, commands, book, renameCalls, setActiveAttempts: () => setActiveAttempts,
    live: () => (options.dropsASheet === true ? live : book) };
}

test('RED anchor: a rename of a NAMED sheet is proved and the book is otherwise untouched', async () => {
  const f = rig({ sheets: [{ name: 'Sprint1' }, { name: 'Данные' }, { name: 'Третий' }], activeIndex: 1 });
  const result = await f.bridge.renameSheet({ sourceName: 'Данные', newName: 'Итог' });
  assert.equal(result.ok, true);
  assert.deepEqual(f.renameCalls, ['Итог'], 'exactly ONE SetName call, with the requested name');
  assert.deepEqual(f.book.map((entry) => entry.name), ['Sprint1', 'Итог', 'Третий'],
    'the renamed sheet kept its POSITION and every other name is unchanged');
  assert.equal(result.index, 1, 'and it kept its INDEX');
  assert.equal(result.name, 'Итог');
  assert.equal(result.previousName, 'Данные');
  assert.equal(f.setActiveAttempts(), 0, 'the active sheet is not switched and not restored');
  assert.deepEqual(f.commands[0].scope, { maxSheets: LIMITS.sheetListMax, sourceName: 'Данные', sourceIndex: null, newName: 'Итог' });
});

test('a rename BY INDEX renames the sheet at that index, whatever its name is', async () => {
  const f = rig({ sheets: [{ name: 'Первый' }, { name: 'Второй' }] });
  const result = await f.bridge.renameSheet({ sourceIndex: 1, newName: 'НовоеИмя' });
  assert.equal(result.ok, true);
  assert.deepEqual(f.book.map((entry) => entry.name), ['Первый', 'НовоеИмя']);
  assert.equal(result.index, 1);
  assert.equal(result.previousName, 'Второй');
});

test('a rename with NO selector renames the ACTIVE sheet, and the fact is RECORDED, not fixed up', async () => {
  // "Active sheet" behaviour is MEASURED, not assumed or corrected: the leg renames whatever sheet is active and
  // reports the active identity it observed afterwards. Nothing is switched and nothing is restored.
  const f = rig({ sheets: [{ name: 'Первый' }, { name: 'Второй' }], activeIndex: 1 });
  const result = await f.bridge.renameSheet({ newName: 'Переименованный' });
  assert.equal(result.ok, true);
  assert.deepEqual(f.book.map((entry) => entry.name), ['Первый', 'Переименованный']);
  assert.equal(result.index, 1);
  assert.equal(result.activeIndex, 1, 'the active sheet is still the one that was renamed');
  assert.equal(result.activeName, 'Переименованный', 'and it reports the name the editor now answers for it');
  assert.equal(f.setActiveAttempts(), 0);
});

test('a TAKEN name refuses BEFORE any mutation', async () => {
  for (const [request, why] of [
    [{ sourceName: 'Данные', newName: 'Sprint1' }, 'a name another sheet already carries'],
    [{ sourceName: 'Данные', newName: 'Данные' }, 'the sheet own current name (a no-op rename)']
  ]) {
    const f = rig();
    const result = await f.bridge.renameSheet(request);
    assert.equal(result.ok, false, why);
    assert.equal(result.code, 'TOOL_ERROR', why);
    assert.deepEqual(f.renameCalls, [], `${why}: nothing was renamed`);
    assert.deepEqual(f.commands[0].answered, ['PRE_INSERT', 'TOOL_ERROR'], why);
  }
});

test('a MISSING source sheet refuses BEFORE any mutation', async () => {
  for (const source of [{ sourceName: 'НетТакого' }, { sourceIndex: 7 }]) {
    const f = rig();
    const result = await f.bridge.renameSheet({ ...source, newName: 'Итог' });
    assert.equal(result.ok, false, JSON.stringify(source));
    assert.equal(result.code, 'TOOL_ERROR', JSON.stringify(source));
    assert.deepEqual(f.renameCalls, [], 'nothing was renamed');
  }
});

test('an unproved postcondition after the mutation is UNCERTAIN, the slot stays HELD, and NOTHING is renamed back', async () => {
  const knobs = [
    [{ doesNothing: true }, 'the name never changed'],
    [{ renamesToSomethingElse: true }, 'the editor used a different name'],
    [{ dropsASheet: true }, 'a sheet disappeared'],
    [{ reorders: true }, 'the book changed order'],
    [{ keepsOldNameResolvable: true }, 'the OLD name still resolves']
  ];
  for (const [knob, why] of knobs) {
    const f = rig(knob);
    const result = await f.bridge.renameSheet({ sourceName: 'Данные', newName: 'Итог' });
    assert.equal(result.ok, false, why);
    assert.equal(result.code, 'APPLY_UNCERTAIN', why);
    assert.deepEqual(f.renameCalls, ['Итог'], `${why}: exactly one attempt, and NEVER a rename back`);
    const second = await f.bridge.renameSheet({ sourceName: 'Данные', newName: 'Другое' });
    assert.equal(second.code, 'EDITOR_BUSY', `${why}: the slot must stay held`);
  }
});

test('the closed request class refuses BEFORE any dispatch', async () => {
  const cases = [
    [{ sourceName: 'Sprint1', newName: '' }, 'an empty new name'],
    [{ sourceName: 'Sprint1', newName: 'я'.repeat(LIMITS.sheetNameCharactersMax + 1) }, 'a new name above the measured character bound'],
    [{ sourceName: 'Sprint1', newName: 42 }, 'a numeric new name'],
    [{ sourceName: 'Sprint1', newName: 'a\u0000b' }, 'a control character in the new name'],
    [{ sourceName: 'Sprint1', sourceIndex: 0, newName: 'X' }, 'BOTH source spellings'],
    [{ sourceName: 'Sprint1', extra: 1, newName: 'X' }, 'an unknown key'],
    [{ newName: 'X', noSuch: true }, 'an unknown key beside a bare new name']
  ];
  for (const [raw, why] of cases) {
    const f = rig();
    const result = await f.bridge.renameSheet(raw);
    assert.equal(result.ok, false, why);
    assert.equal(f.commands.length, 0, `${why}: nothing may reach the editor`);
  }
});

test('a sheet whose rename primitive is MISSING refuses as a capability, before the mutation', async () => {
  const f = rig({ noSetNameMethod: true });
  const result = await f.bridge.renameSheet({ sourceName: 'Данные', newName: 'Итог' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CAPABILITY_UNAVAILABLE', 'the leg cannot rename at all on this build');
  assert.deepEqual(f.renameCalls, [], 'and it did NOT try');
  assert.deepEqual(f.commands[0].answered, ['PRE_INSERT', 'CAPABILITY_UNAVAILABLE'], 'a pre-mutation refusal');
});

test('source INDEX 0 renames the FIRST sheet even when a DIFFERENT sheet is active', async () => {
  // The index-zero trap every selector leg has: `sourceIndex || null` would rename the ACTIVE sheet instead, which
  // is invisible unless the active sheet is not index 0.
  const f = rig({ sheets: [{ name: 'Первый' }, { name: 'Второй' }], activeIndex: 1 });
  const result = await f.bridge.renameSheet({ sourceIndex: 0, newName: 'Нулевой' });
  assert.equal(result.ok, true);
  assert.deepEqual(f.book.map((entry) => entry.name), ['Нулевой', 'Второй'], 'index 0 is a REAL selector');
  assert.equal(result.index, 0);
  assert.equal(f.commands[0].scope.sourceIndex, 0, 'the zero crosses as 0, never as null');
});

test('the resolved sheet is TIED to the request before anything is renamed', async () => {
  // A build whose lookup answers a DIFFERENT sheet would otherwise rename the wrong one: the postcondition below
  // reads whatever it renamed, so only the comparison of the sheet's OWN identity with the request closes this.
  for (const [knob, request, why] of [
    [{ nameLies: true }, { sourceName: 'Данные' }, 'a lookup that answered a SHEET WITH ANOTHER NAME'],
    [{ indexLies: true }, { sourceIndex: 1 }, 'a lookup that answered a SHEET AT ANOTHER INDEX']
  ]) {
    const f = rig({ sheets: [{ name: 'Sprint1' }, { name: 'Данные' }], ...knob });
    const result = await f.bridge.renameSheet({ ...request, newName: 'Итог' });
    assert.equal(result.ok, false, why);
    assert.equal(result.code, 'TOOL_ERROR', why);
    assert.deepEqual(f.renameCalls, [], `${why}: NOT ONE rename was attempted`);
    assert.deepEqual(f.commands[0].answered, ['PRE_INSERT', 'TOOL_ERROR'], `${why}: refused before the mutation`);
  }
  const good = rig({ sheets: [{ name: 'Sprint1' }, { name: 'Данные' }] });
  assert.equal((await good.bridge.renameSheet({ sourceName: 'Данные', newName: 'Итог' })).ok, true);
});

test('a count that GREW, an INDEX that moved, or the other names swapping are all refused', async () => {
  // Each of these is a postcondition clause of its own: the book must be the same SIZE, the renamed sheet must keep
  // its INDEX, and every OTHER sheet must keep its name and position.
  const cases = [
    [{ growsASheet: true }, { sourceName: 'Данные', newName: 'Итог' }, 'the count grew by one'],
    [{ indexShifts: true }, { sourceName: 'Данные', newName: 'Итог' }, 'the renamed sheet moved to another index'],
    [{ swapsOthers: true, sheets: [{ name: 'Первый' }, { name: 'Второй' }, { name: 'Третий' }] },
      { sourceName: 'Третий', newName: 'Итог' }, 'two OTHER sheets swapped their names']
  ];
  for (const [knob, request, why] of cases) {
    const f = rig(knob);
    const result = await f.bridge.renameSheet(request);
    assert.equal(result.ok, false, why);
    assert.equal(result.code, 'APPLY_UNCERTAIN', why);
    assert.deepEqual(f.renameCalls, [request.newName], `${why}: one attempt, never a rename back`);
  }
});

test('a FORGED or malformed answer is UNCERTAIN, never a known error', async () => {
  // The body cannot lie about what the readers answered, but a forged answer is exactly how a wrong implementation
  // would look: every shape below must be refused as post-mutation uncertainty.
  const forged = [
    [['POST_INSERT', 2, 2, 1, 0, 1, 1, 0, 'Sprint1', 'Sprint1', 'Данные', 'Sprint1', 'Другое'], 'the renamed entry does NOT carry the requested name'],
    [['POST_INSERT', 2, 2, 1, 1, 1, 1, 0, 'Sprint1', 'Sprint1', 'Данные', 'Sprint1', 'Итог'], 'the OLD name still resolves'],
    [['POST_INSERT', 2, 2, 1, 0, 0, 1, 0, 'Sprint1', 'Sprint1', 'Данные', 'Sprint1', 'Итог'], 'the INDEX no longer resolves to the renamed sheet'],
    [['POST_INSERT', 2, 2, 1, 0, 1, 0, 0, 'Sprint1', 'Sprint1', 'Данные', 'Sprint1', 'Итог'], 'the new NAME resolves at another index'],
    [['POST_INSERT', 2, 3, 1, 0, 1, 1, 0, 'Sprint1', 'Sprint1', 'Данные', 'Sprint1', 'Итог', 'Лишний'], 'the count grew'],
    [['POST_INSERT', 2, 2, 1, 0, 1, 1, 0, 'Sprint1', 'Sprint1', 'Данные', 'Sprint1'], 'the answer is one member short'],
    [['POST_INSERT', 2, 2, 1, 0, 1, 1, 0, 'Sprint1', 'Sprint1', 'Данные', 'Sprint1', 'Итог', 'EXTRA'], 'the answer carries a trailing member'],
    [['POST_INSERT', 'CAPABILITY_UNAVAILABLE'], 'a POST-mutation refusal, which must never be a known error'],
    [['PRE_INSERT', 2, 2, 1, 0, 1, 1, 0, 'Sprint1', 'Sprint1', 'Данные', 'Sprint1', 'Итог'], 'a PRE-phase answer carrying measurements as if the mutation were proved'],
    [['POST_INSERT', 2, 2, 1, 0, 1, 1, 0, '', 'Sprint1', 'Данные', 'Sprint1', 'Итог'], 'an EMPTY recorded active name'],
    [['POST_INSERT', 2, 2, 1, 0, 1, 1, 0, 'Данные', 'Sprint1', 'Данные', 'Sprint1', 'Итог'], 'a recorded active pair that DISAGREES with the measured list'],
    [['POST_INSERT', 2, 2, 1, 0, 1, 1, 0, 'Итог', 'Итог', 'Данные', 'Итог', 'Итог'], 'another sheet ALREADY carries the requested name'],
    [[], 'an empty answer'],
    [null, 'no answer at all']
  ];
  for (const [forge, why] of forged) {
    const f = rig({ forge });
    const result = await f.bridge.renameSheet({ sourceName: 'Данные', newName: 'Итог' });
    assert.equal(result.ok, false, why);
    assert.equal(result.code, 'APPLY_UNCERTAIN', why);
  }
  // A PRE-mutation refusal is still the known class, and it releases the slot.
  const known = rig({ forge: ['PRE_INSERT', 'TOOL_ERROR'] });
  const refused = await known.bridge.renameSheet({ sourceName: 'Данные', newName: 'Итог' });
  assert.equal(refused.code, 'TOOL_ERROR');
  assert.equal((await known.bridge.renameSheet({ sourceName: 'Данные', newName: 'Итог' })).code, 'TOOL_ERROR');
  assert.equal(known.commands.length, 2, 'a pre-mutation refusal released the slot');
});

test('the bridge bounds the NEW NAME itself, not only the tool', async () => {
  // The tool refuses an over-bound name before dispatch, so the bridge's own bounds are only observable here — which
  // is exactly why they need their own cases: the bridge is reachable directly. NOTE the BYTE bound is now SUBSUMED
  // for this argument (31 characters can never exceed 128 bytes), so it stays as belt and braces while the
  // CHARACTER bound below is the one that can actually refuse a real name.
  const f = rig();
  const over = await f.bridge.renameSheet({ sourceName: 'Данные', newName: 'я'.repeat(LIMITS.sheetNameCharactersMax + 1) });
  assert.equal(over.ok, false);
  assert.equal(over.code, 'TOOL_ERROR');
  assert.equal(f.commands.length, 0, 'nothing reached the editor');
  assert.deepEqual(f.renameCalls, [], 'and the editor was never asked');
});

test('a name above the MEASURED 31-CHARACTER limit is refused BEFORE the mutation, never as uncertainty', async () => {
  // MEASURED natively: the editor SILENTLY IGNORES a 33-character name, keeping the old one, so the request used to
  // spend a mutation and come back as UNCERTAIN. It is now a known refusal with nothing dispatched — and the bound
  // is CHARACTERS, not bytes, so 31 Cyrillic characters (62 bytes) must still be accepted.
  const at_limit = 'я'.repeat(LIMITS.sheetNameCharactersMax);
  assert.equal(utf8ByteLength(at_limit) > 31, true, 'the fixture really is above 31 BYTES, so the byte bound cannot be what accepts it');
  const served = rig();
  assert.equal((await served.bridge.renameSheet({ sourceName: 'Данные', newName: at_limit })).ok, true,
    'a name AT the character limit is served');
  assert.equal(served.commands.length, 1, 'and it did reach the editor');
  assert.equal(served.book[1].name, at_limit);

  const over = rig();
  const tooLong = 'я'.repeat(LIMITS.sheetNameCharactersMax + 1);
  const refused = await over.bridge.renameSheet({ sourceName: 'Данные', newName: tooLong });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'TOOL_ERROR', 'a known-invalid name is a KNOWN refusal, not uncertainty');
  assert.equal(over.commands.length, 0, 'and NOTHING was dispatched, so no mutation was ever spent');
  assert.deepEqual(over.renameCalls, [], 'and the editor was never asked to rename');
});

test('a native that THROWS during the rename is UNCERTAIN with the slot HELD, and is never retried', async () => {
  // THE ORDERING THIS WHOLE LEG DEPENDS ON, and the only test in either file that reaches the body's catch: the
  // phase must ALREADY be POST_INSERT when `SetName` throws. If it were not, a failure whose effect is unknown
  // would come back as a KNOWN capability error, the slot would be released, and the rename would be RETRIED.
  const f = rig({ sheets: [{ name: 'Sprint1' }, { name: 'Данные' }], setNameThrows: true });
  const result = await f.bridge.renameSheet({ sourceName: 'Данные', newName: 'Итог' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'APPLY_UNCERTAIN', 'the phase had turned, so the failure is the uncertain class');
  assert.deepEqual(f.commands[0].answered, ['POST_INSERT', 'CAPABILITY_UNAVAILABLE'],
    'the body answers POST_INSERT because the throwing call was already inside the mutation');
  assert.deepEqual(f.renameCalls, ['Итог'], 'exactly one attempt, and never a rename back');
  const second = await f.bridge.renameSheet({ sourceName: 'Данные', newName: 'Другое' });
  assert.equal(second.code, 'EDITOR_BUSY', 'the slot stays HELD');
  assert.equal(f.commands.length, 1, 'and nothing dispatched again');
});

test('a build whose lookup disagrees with its ordered collection can never turn into a SUCCESS', async () => {
  // A build that answers the right sheet under the WRONG index: the body's index/name agreement check is
  // defence-in-depth here and the DECODER's coherence clause is what refuses in this model, which is why the
  // assertion is on the OUTCOME (a post-mutation refusal, never a success) rather than on a specific class.
  const f = rig({ sheets: [{ name: 'Первый' }, { name: 'Второй' }, { name: 'Третий' }], indexShiftsLookup: true });
  const result = await f.bridge.renameSheet({ sourceName: 'Второй', newName: 'Итог' });
  assert.equal(result.ok, false, 'a collection that disagrees with its own lookup can never be a proved rename');
  assert.equal(result.code, 'APPLY_UNCERTAIN', 'the disagreement is caught AFTER the mutation, so it is the uncertain class');
  assert.deepEqual(f.renameCalls, ['Итог'], 'and nothing is renamed back');
});

test('a book wider than the supported bound is refused before the mutation', async () => {
  // The bound is the same MEASURED sheet count the listing leg uses; a book past it is outside the supported
  // envelope, and the refusal has to happen before the rename rather than after.
  const wide = Array.from({ length: LIMITS.sheetListMax + 1 }, (unused, index) => ({ name: `Лист${index}` }));
  const f = rig({ sheets: wide, activeIndex: 0 });
  const result = await f.bridge.renameSheet({ sourceIndex: 3, newName: 'Итог' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TOOL_ERROR', 'the book is wider than this leg supports');
  assert.deepEqual(f.renameCalls, [], 'nothing was renamed');
  assert.deepEqual(f.commands[0].answered, ['PRE_INSERT', 'TOOL_ERROR']);
});

test('a facade missing the COLLECTION or the LOOKUP refuses as a capability, before the mutation', async () => {
  for (const knob of [{ noGetSheets: true }, { noGetSheet: true }]) {
    const f = rig(knob);
    const result = await f.bridge.renameSheet({ sourceName: 'Данные', newName: 'Итог' });
    assert.equal(result.ok, false, JSON.stringify(knob));
    assert.equal(result.code, 'CAPABILITY_UNAVAILABLE', JSON.stringify(knob));
    assert.deepEqual(f.renameCalls, [], JSON.stringify(knob));
    assert.deepEqual(f.commands[0].answered, ['PRE_INSERT', 'CAPABILITY_UNAVAILABLE'], JSON.stringify(knob));
  }
});

test('renaming refreshes sheet labels without activating another worksheet', async () => {
  const f=rig();
  assert.equal((await f.bridge.renameSheet({sourceIndex:1,newName:'VISIBLE'})).ok,true);
  assert.deepEqual(f.paintedNames(), ['Sprint1','VISIBLE']);
  assert.equal(f.notifications(),1);
  assert.equal(f.setActiveAttempts(),0);
});
test('missing sheet notification refuses before rename; notification failure after rename is uncertain', async () => {
  const missing=rig({noNotification:true});
  assert.equal((await missing.bridge.renameSheet({sourceIndex:0,newName:'VISIBLE'})).code,'CAPABILITY_UNAVAILABLE');
  assert.deepEqual(missing.renameCalls,[]);
  const thrown=rig({notificationThrows:true});
  assert.equal((await thrown.bridge.renameSheet({sourceIndex:0,newName:'VISIBLE'})).code,'APPLY_UNCERTAIN');
  assert.equal(thrown.bridge.getState().busy,true);
  assert.deepEqual(thrown.renameCalls,['VISIBLE']);
});
