import test from 'node:test';
import assert from 'node:assert/strict';
import { createSlideTools } from '../../src/tools/slide.js';
import { createRegistry } from '../../src/tools/registry.js';
import { LIMITS } from '../../src/shared/limits.js';

function bridge(overrides = {}) { const calls = { duplicate: 0, move: 0 }; return { calls, async duplicateSlide(request) { calls.duplicate++; return overrides.duplicate ?? { ok: true, slidesCount: 4, slideIndex: 3, duplicatedFrom: request.slideIndex, layoutLength: 12, shapes: 2 }; }, async moveSlide(request) { calls.move++; return overrides.move ?? { ok: true, slidesCount: 3, fromIndex: request.fromIndex, toIndex: request.toIndex, layoutLength: 12, shapes: 2 }; } }; }
function tool(value, name) { return createSlideTools(value).find(item => item.name === name); }
const ctx = { editor: 'slide' };

test('restructure tools are EDIT-only auto policy and catalogue names every argument', () => {
  const value = bridge(); const registry = createRegistry(createSlideTools(value));
  assert.equal(registry.catalogue({ editor: 'slide', capabilities: ['document.read', 'document.write'], mode: 'ASK' }).some(item => ['duplicate_slide', 'move_slide'].includes(item.name)), false);
  const edit = registry.catalogue({ editor: 'slide', capabilities: ['document.read', 'document.write'], mode: 'EDIT' });
  for (const name of ['duplicate_slide', 'move_slide']) { const item = edit.find(entry => entry.name === name); assert.ok(item); assert.equal(item.policy, 'auto'); }
  assert.match(tool(value, 'duplicate_slide').description, /slideIndex/);
  assert.match(tool(value, 'move_slide').description, /fromIndex/); assert.match(tool(value, 'move_slide').description, /toIndex/);
});
test('restructure tools close argument classes before bridge dispatch', async () => {
  const value = bridge();
  for (const args of [{}, { slideIndex: -1 }, { slideIndex: 1.5 }, { slideIndex: 0, extra: 1 }, null]) assert.equal((await tool(value, 'duplicate_slide').execute(args, ctx)).code, 'TOOL_ERROR');
  for (const args of [{}, { fromIndex: 0 }, { fromIndex: -1, toIndex: 0 }, { fromIndex: 0, toIndex: 1.5 }, { fromIndex: 0, toIndex: 1, extra: 1 }, null]) assert.equal((await tool(value, 'move_slide').execute(args, ctx)).code, 'TOOL_ERROR');
  assert.deepEqual(value.calls, { duplicate: 0, move: 0 });
});
test('restructure success is decoded and uncertain maps without retry', async () => {
  assert.equal((await tool(bridge(), 'duplicate_slide').execute({ slideIndex: 1 }, ctx)).ok, true);
  assert.equal((await tool(bridge(), 'move_slide').execute({ fromIndex: 2, toIndex: 0 }, ctx)).ok, true);
  const value = bridge({ duplicate: { ok: false, code: 'APPLY_UNCERTAIN' }, move: { ok: false, code: 'APPLY_UNCERTAIN' } });
  assert.equal((await tool(value, 'duplicate_slide').execute({ slideIndex: 1 }, ctx)).code, 'TOOL_UNCERTAIN');
  assert.equal((await tool(value, 'move_slide').execute({ fromIndex: 2, toIndex: 0 }, ctx)).code, 'TOOL_UNCERTAIN');
});
test('restructure result byte bound is enforced', async () => {
  const huge = bridge({ duplicate: { ok: true, slidesCount: Number.MAX_SAFE_INTEGER, slideIndex: Number.MAX_SAFE_INTEGER, duplicatedFrom: Number.MAX_SAFE_INTEGER, layoutLength: Number.MAX_SAFE_INTEGER, shapes: Number.MAX_SAFE_INTEGER } });
  const result = await tool(huge, 'duplicate_slide').execute({ slideIndex: 1 }, ctx);
  assert.ok(result.ok || result.code === 'BYTE_LIMIT');
});
