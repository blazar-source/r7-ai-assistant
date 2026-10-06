// Unit coverage for `rename_sheet` — the last Cell tool of the series (Sprint 4, T5.4).
//
// The bridge is a double here: these are host tests and are NOT native proof. What they own is the DESCRIPTOR
// contract — the closed argument class (`newName` plus the source selector), the envelope re-check of what is
// PUBLISHED, the byte bounds, the model-facing description, and the classification of the bridge's answer into a
// published rename, a known refusal, or the UNCERTAIN class that must stop the run. The POSTCONDITION itself (the
// count, the order, the preserved index, the old name gone, the new name resolving) is the bridge's own decision
// and is covered through the REAL bridge in `tests/unit/bridge-sheetrename.test.js`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCellTools } from '../../src/tools/cell.js';
import { createRegistry } from '../../src/tools/registry.js';
import { AGENT_CEILINGS, LIMITS } from '../../src/shared/limits.js';
import { utf8ByteLength } from '../../src/shared/bytes.js';

function renamed(overrides = {}) {
  return { ok: true, index: 1, name: 'Итог', previousName: 'Данные', activeIndex: 0, activeName: 'Sprint1',
    ...overrides };
}
function bridgeWith(answer) {
  const calls = { renameSheet: 0 };
  return {
    calls,
    requests: [],
    async renameSheet(request) {
      calls.renameSheet += 1;
      this.requests.push(request);
      // WITH NO EXPLICIT ANSWER the double SERVES THE REQUEST: the confirmed name comes from the request's own
      // `newName`, so a handler that dropped or mangled an argument cannot be papered over by a fixed envelope.
      if (answer === undefined) {
        return { ok: true, index: 1, name: request.newName, previousName: 'Данные', activeIndex: 0, activeName: 'Sprint1' };
      }
      return typeof answer === 'function' ? answer(request) : answer;
    }
  };
}
function toolWith(bridge) { return createCellTools(bridge).find(entry => entry.name === 'rename_sheet'); }
const cellCtx = { editor: 'cell' };

test('RED anchor: rename_sheet exists, is a Cell mutation, and is offered in EDIT only', () => {
  const bridge = bridgeWith(renamed());
  const tool = toolWith(bridge);
  assert.ok(tool, 'rename_sheet must exist');
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

test('a served rename dispatches ONCE and publishes what the reader confirmed', async () => {
  // The double SERVES THE REQUEST (no fixed envelope), so this also pins that the handler forwards `newName`:
  // the published name is the one the request carried.
  const bridge = bridgeWith();
  const result = await toolWith(bridge).execute({ sheet: 'Данные', newName: 'Итог' }, cellCtx);
  assert.equal(bridge.calls.renameSheet, 1, 'exactly one dispatch, never a retry');
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { index: 1, name: 'Итог', previousName: 'Данные', activeIndex: 0, activeName: 'Sprint1' });
  assert.deepEqual(bridge.requests[0], { sourceName: 'Данные', newName: 'Итог' });
  // And the name the envelope carries FOLLOWS the request, so a handler that dropped it would be caught here.
  const other = bridgeWith();
  const second = await toolWith(other).execute({ newName: 'СовсемДругое' }, cellCtx);
  assert.equal(second.data.name, 'СовсемДругое');
  assert.equal(other.requests[0].newName, 'СовсемДругое');
});

test('the source selector is optional, and index ZERO is a selector rather than an absent one', async () => {
  const plain = bridgeWith(renamed());
  await toolWith(plain).execute({ newName: 'Итог' }, cellCtx);
  assert.deepEqual(plain.requests[0], { newName: 'Итог' }, 'no selector means the ACTIVE sheet');

  const zero = bridgeWith(renamed());
  await toolWith(zero).execute({ sheetIndex: 0, newName: 'Итог' }, cellCtx);
  assert.equal(zero.requests[0].sourceIndex, 0, 'a zero index must cross as 0, never as null');
  assert.equal('sourceName' in zero.requests[0], false);
});

test('the closed argument class refuses BEFORE any dispatch', async () => {
  const exact = 'я'.repeat(LIMITS.sheetListNameBytes / 2);
  assert.equal(utf8ByteLength(exact), LIMITS.sheetListNameBytes);
  const cases = [
    [{}, 'no new name at all'],
    [{ newName: '' }, 'an empty new name'],
    [{ newName: 'я'.repeat(LIMITS.sheetListNameBytes / 2 + 1) }, 'a new name above the byte bound'],
    [{ newName: 42 }, 'a numeric new name'],
    [{ newName: 'a\u0000b' }, 'a control character in the new name'],
    [{ newName: 'X', sheet: 'a', sheetIndex: 0 }, 'BOTH source spellings'],
    [{ newName: 'X', sheet: '' }, 'an empty source name'],
    [{ newName: 'X', sheetIndex: -1 }, 'a negative source index'],
    [{ newName: 'X', sheetIndex: LIMITS.sheetListMax }, 'a source index at the workbook bound'],
    [{ newName: 'X', extra: 1 }, 'an unknown key'],
    ['X', 'arguments that are not an object']
  ];
  for (const [args, why] of cases) {
    const bridge = bridgeWith(renamed());
    const result = await toolWith(bridge).execute(args, cellCtx);
    assert.equal(result.ok, false, why);
    assert.equal(result.code, 'TOOL_ERROR', why);
    assert.equal(bridge.calls.renameSheet, 0, `${why}: a mutation must not be dispatched`);
  }
  // A new name exactly AT the bound is a valid one, so the bound is not off by one.
  const served = bridgeWith(renamed({ name: exact }));
  assert.equal((await toolWith(served).execute({ newName: exact }, cellCtx)).ok, true);
  assert.equal(served.calls.renameSheet, 1);
});

test('an answer whose envelope cannot describe a rename is a known refusal', async () => {
  const cases = [
    [renamed({ ok: false, code: 'EDITOR_BUSY' }), 'a bridge refusal', 'EDITOR_BUSY'],
    [renamed({ index: -1 }), 'a negative index', 'TOOL_ERROR'],
    [renamed({ index: 1.5 }), 'a fractional index', 'TOOL_ERROR'],
    [renamed({ name: '' }), 'an empty confirmed name', 'TOOL_ERROR'],
    [renamed({ name: 'Данные' }), 'a name EQUAL to the previous one (nothing was renamed)', 'TOOL_ERROR'],
    [renamed({ previousName: '' }), 'an empty previous name', 'TOOL_ERROR'],
    [renamed({ activeIndex: -1 }), 'a negative active index', 'TOOL_ERROR'],
    [renamed({ activeName: 42 }), 'a non-string active name', 'TOOL_ERROR'],
    [null, 'no answer at all', 'TOOL_ERROR'],
    ['renamed', 'an answer that is not an object', 'TOOL_ERROR']
  ];
  for (const [answer, why, expected] of cases) {
    const result = await toolWith(bridgeWith(answer)).execute({ newName: 'Итог' }, cellCtx);
    assert.equal(result.ok, false, why);
    assert.equal(result.code, expected, why);
  }
});

test('a refusal class from the bridge is republished, and the uncertain one stops the run', async () => {
  for (const [code, expected] of [['EDITOR_BUSY', 'EDITOR_BUSY'], ['CAPABILITY_UNAVAILABLE', 'CAPABILITY_UNAVAILABLE'],
    ['APPLY_UNCERTAIN', 'TOOL_UNCERTAIN'], ['TOOL_ERROR', 'TOOL_ERROR'], ['MADE_UP', 'TOOL_ERROR']]) {
    const result = await toolWith(bridgeWith({ ok: false, code })).execute({ newName: 'X' }, cellCtx);
    assert.equal(result.code, expected, `bridge code ${code}`);
  }
  const thrown = { calls: { renameSheet: 1 },
    async renameSheet() { const error = new Error('uncertain'); error.code = 'APPLY_UNCERTAIN'; throw error; } };
  const result = await toolWith(thrown).execute({ newName: 'X' }, cellCtx);
  assert.equal(result.code, 'TOOL_UNCERTAIN');
  assert.equal(thrown.calls.renameSheet, 1, 'an uncertain rename is never retried');
});

test('a bridge without the method refuses as a capability, and a non-Cell editor is gated', async () => {
  assert.equal((await toolWith({ calls: {} }).execute({ newName: 'X' }, cellCtx)).code, 'CAPABILITY_UNAVAILABLE');
  const tool = toolWith(bridgeWith(renamed()));
  assert.equal(tool.precondition({}, cellCtx), null);
  assert.equal(tool.precondition({}, { editor: 'word' }).code, 'CAPABILITY_UNAVAILABLE');
});

test('the DESCRIPTION names newName AND both source spellings, because the model reads only that', async () => {
  // The description is the only MODEL-FACING field (the schema is validation-only and never rendered), so a
  // selector it does not name is undiscoverable — the lesson the T5.3b review rejected the work for.
  const tool = toolWith(bridgeWith(renamed()));
  assert.match(tool.description, /newName\s*—/, 'names the new-name argument');
  assert.match(tool.description, /sheet\s*—/, 'names the source-name argument');
  assert.match(tool.description, /sheetIndex\s*—/, 'names the source-index argument');
  assert.ok(utf8ByteLength(tool.description) <= 256, 'and stays inside the model-facing byte bound');
  assert.equal(/[\u0000-\u001f\u007f]/.test(tool.description), false, 'one authored line, never a control character');
  assert.equal(tool.schema.additionalProperties, false);
  assert.deepEqual(tool.schema.required, ['newName'], 'the new name is the one required argument');
  assert.deepEqual(Object.keys(tool.schema.properties).sort(), ['newName', 'sheet', 'sheetIndex']);
});

test('the published entry stays inside the runtime ceiling by construction', async () => {
  const tool = toolWith(bridgeWith(renamed({ name: 'я'.repeat(LIMITS.sheetListNameBytes / 2) })));
  const result = await tool.execute({ newName: 'я'.repeat(LIMITS.sheetListNameBytes / 2) }, cellCtx);
  assert.equal(result.ok, true);
  const entry = JSON.stringify({ tool: 'rename_sheet', ok: true, data: result.data });
  assert.ok(utf8ByteLength(entry) <= AGENT_CEILINGS.toolResultBytes, `${utf8ByteLength(entry)} bytes`);
});
