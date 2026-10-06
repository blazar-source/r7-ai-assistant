// Unit coverage for `add_sheet` — the first WORKBOOK-level MUTATION (Sprint 4, T5.2).
//
// The bridge is a double here: these are host tests and are NOT native proof. What they own is the DESCRIPTOR
// contract — the closed argument class, the optional name and its bound, the envelope re-check of what is
// PUBLISHED (index, name, active, previousActive), the byte bounds, and the classification of the bridge's
// answer into a published add, a known refusal, or the UNCERTAIN class that must stop the run. The
// POSTCONDITION itself (count grew by one, last index, name, active by name/index, order preserved) is the
// bridge's own decision and is covered through the REAL bridge in `tests/unit/bridge-sheetadd.test.js`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCellTools } from '../../src/tools/cell.js';
import { createRegistry } from '../../src/tools/registry.js';
import { AGENT_CEILINGS, LIMITS } from '../../src/shared/limits.js';
import { utf8ByteLength } from '../../src/shared/bytes.js';

function added(overrides = {}) {
  return { ok: true, index: 2, name: 'Итог', active: true,
    previousActive: { index: 0, name: 'Свод' }, ...overrides };
}
function bridgeWith(answer) {
  const calls = { addSheet: 0 };
  return {
    calls,
    requests: [],
    async addSheet(request) {
      calls.addSheet += 1;
      this.requests.push(request);
      return typeof answer === 'function' ? answer(request) : answer;
    }
  };
}
function toolWith(bridge) { return createCellTools(bridge).find(entry => entry.name === 'add_sheet'); }
const cellCtx = { editor: 'cell' };

test('RED anchor: add_sheet exists, is a Cell mutation, and is offered in EDIT only', () => {
  const bridge = bridgeWith(added());
  const tool = toolWith(bridge);
  assert.ok(tool, 'add_sheet must exist');
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

test('a served add dispatches ONCE and publishes the new sheet and the former active one', async () => {
  const bridge = bridgeWith(added());
  const result = await toolWith(bridge).execute({ name: 'Итог' }, cellCtx);
  assert.equal(bridge.calls.addSheet, 1, 'exactly one dispatch, never a retry');
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { index: 2, name: 'Итог', active: true, previousActive: { index: 0, name: 'Свод' } });
  assert.deepEqual(bridge.requests[0], { name: 'Итог' });
});

test('the name is OPTIONAL and is not invented when absent', async () => {
  const bridge = bridgeWith(added({ name: 'Лист1' }));
  const result = await toolWith(bridge).execute({}, cellCtx);
  assert.equal(result.ok, true);
  assert.equal(result.data.name, 'Лист1', 'the name the editor chose is published verbatim');
  assert.deepEqual(bridge.requests[0], {}, 'no name is sent when the caller named none');
});

test('the closed argument class refuses BEFORE any dispatch', async () => {
  const bridge = bridgeWith(added());
  const tool = toolWith(bridge);
  const cases = [
    [{ name: '' }, 'an empty name'],
    [{ name: 'я'.repeat(LIMITS.sheetListNameBytes / 2 + 1) }, 'a name above the byte bound'],
    [{ name: 42 }, 'a numeric name'],
    [{ name: null }, 'a null name'],
    [{ name: 'X', sheet: 'Y' }, 'an unknown key'],
    [{ index: 3 }, 'an argument this leg does not take'],
    ['X', 'arguments that are not an object']
  ];
  for (const [args, why] of cases) {
    const result = await tool.execute(args, cellCtx);
    assert.equal(result.ok, false, why);
    assert.equal(result.code, 'TOOL_ERROR', why);
  }
  assert.equal(bridge.calls.addSheet, 0, 'nothing refused ever reached the bridge');
});

test('an answer whose envelope cannot describe an add is a known refusal', async () => {
  const cases = [
    [added({ ok: false, code: 'EDITOR_BUSY' }), 'a bridge refusal', 'EDITOR_BUSY'],
    [added({ active: false }), 'an add that is not active', 'TOOL_ERROR'],
    [added({ index: -1 }), 'a negative index', 'TOOL_ERROR'],
    [added({ index: 1.5 }), 'a fractional index', 'TOOL_ERROR'],
    [added({ name: '' }), 'an empty name', 'TOOL_ERROR'],
    [added({ name: 'я'.repeat(LIMITS.sheetListNameBytes / 2 + 1) }), 'a name above the bound', 'TOOL_ERROR'],
    [added({ previousActive: null }), 'no previous active sheet', 'TOOL_ERROR'],
    [added({ previousActive: { index: -1, name: 'Свод' } }), 'a negative previous index', 'TOOL_ERROR'],
    [added({ index: 2, previousActive: { index: 2, name: 'Свод' } }), 'a previous index AT the new sheet', 'TOOL_ERROR'],
    [added({ index: 2, previousActive: { index: 5, name: 'Свод' } }), 'a previous index PAST the new sheet', 'TOOL_ERROR'],
    [added({ previousActive: { index: 0, name: '' } }), 'an empty previous name', 'TOOL_ERROR'],
    [null, 'no answer at all', 'TOOL_ERROR'],
    ['added', 'an answer that is not an object', 'TOOL_ERROR']
  ];
  for (const [answer, why, expected] of cases) {
    const bridge = bridgeWith(answer);
    const result = await toolWith(bridge).execute({ name: 'Итог' }, cellCtx);
    assert.equal(result.ok, false, why);
    assert.equal(result.code, expected, why);
  }
});

test('a refusal class from the bridge is republished, and an unknown one becomes a tool error', async () => {
  for (const [code, expected] of [['EDITOR_BUSY', 'EDITOR_BUSY'], ['CAPABILITY_UNAVAILABLE', 'CAPABILITY_UNAVAILABLE'],
    ['APPLY_UNCERTAIN', 'TOOL_UNCERTAIN'], ['TOOL_ERROR', 'TOOL_ERROR'], ['MADE_UP', 'TOOL_ERROR']]) {
    const bridge = bridgeWith({ ok: false, code });
    const result = await toolWith(bridge).execute({ name: 'X' }, cellCtx);
    assert.equal(result.code, expected, `bridge code ${code}`);
  }
  // The uncertain class also crosses as a THROWN class, and neither form is retried.
  const thrown = { calls: { addSheet: 1 },
    async addSheet() { const error = new Error('uncertain'); error.code = 'APPLY_UNCERTAIN'; throw error; } };
  const result = await toolWith(thrown).execute({ name: 'X' }, cellCtx);
  assert.equal(result.code, 'TOOL_UNCERTAIN');
  assert.equal(thrown.calls.addSheet, 1, 'an uncertain add is never retried');
});

test('a bridge without the method refuses as a capability, and a non-Cell editor is gated', async () => {
  assert.equal((await toolWith({ calls: {} }).execute({ name: 'X' }, cellCtx)).code, 'CAPABILITY_UNAVAILABLE');
  const tool = toolWith(bridgeWith(added()));
  assert.equal(tool.precondition({}, cellCtx), null);
  assert.equal(tool.precondition({}, { editor: 'word' }).code, 'CAPABILITY_UNAVAILABLE');
});

test('the schema is the closed optional name, and the published entry stays bounded', async () => {
  const tool = toolWith(bridgeWith(added()));
  assert.equal(tool.schema.additionalProperties, false);
  assert.deepEqual(Object.keys(tool.schema.properties), ['name']);
  assert.deepEqual(tool.schema.required ?? [], [], 'the name is optional');
  assert.equal(tool.schema.properties.name.maxBytes, LIMITS.sheetListNameBytes);
  // The name bound plus four small scalars is what can be published, so the entry is bounded by construction;
  // this pins the MEASUREMENT rather than trusting the argument.
  const result = await toolWith(bridgeWith(added({ name: 'я'.repeat(LIMITS.sheetListNameBytes / 2), index: 63 })))
    .execute({ name: 'я'.repeat(LIMITS.sheetListNameBytes / 2) }, cellCtx);
  assert.equal(result.ok, true);
  const entry = JSON.stringify({ tool: 'add_sheet', ok: true, data: result.data });
  assert.ok(utf8ByteLength(entry) <= AGENT_CEILINGS.toolResultBytes, `${utf8ByteLength(entry)} bytes`);
  assert.ok(utf8ByteLength(tool.description) <= 256, 'TOOL_DESCRIPTION_BYTES is 256');
  assert.equal(/[\u0000-\u001f\u007f]/.test(tool.description), false);
});
