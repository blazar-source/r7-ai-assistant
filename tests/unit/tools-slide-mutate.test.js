import test from 'node:test';
import assert from 'node:assert/strict';
import { createSlideTools } from '../../src/tools/slide.js';
import { createRegistry } from '../../src/tools/registry.js';
import { LIMITS } from '../../src/shared/limits.js';

function bridge() {
  const calls = { add: 0, text: 0, format: 0 };
  return { calls,
    async addSlide(request) { calls.add++; return { ok: true, slidesCount: 2, slideIndex: 1, layoutId: '306', layoutPreserved: true }; },
    async setSlideText(request) { calls.text++; return { ok: true, slideIndex: request.slideIndex ?? 0, objectOrdinal: request.objectOrdinal, textLength: request.text.length, textBytes: Buffer.byteLength(request.text) }; },
    async formatSlideText(request) { calls.format++; return { ok: true, slideIndex: request.slideIndex ?? 0, objectOrdinal: request.objectOrdinal, applied: ['bold'], textLength: 5 }; }
  };
}
function tool(value, name) { return createSlideTools(value).find(entry => entry.name === name); }
const ctx = { editor: 'slide' };

test('slide mutations are EDIT-only auto-policy tools with named arguments', () => {
  const tools = createSlideTools(bridge()); const registry = createRegistry(tools);
  assert.deepEqual(registry.catalogue({ editor: 'slide', capabilities: ['document.read', 'document.write'], mode: 'ASK' }).map(x => x.name), ['read_presentation', 'read_slide']);
  assert.deepEqual(registry.catalogue({ editor: 'slide', capabilities: ['document.read', 'document.write'], mode: 'EDIT' }).map(x => x.name), ['read_presentation', 'read_slide', 'add_slide', 'set_slide_text', 'format_slide_text']);
  for (const name of ['add_slide', 'set_slide_text', 'format_slide_text']) { const item = tool(bridge(), name); assert.equal(item.policy, 'auto'); }
  assert.match(tool(bridge(), 'add_slide').description, /layoutFromSlideIndex/);
  assert.match(tool(bridge(), 'set_slide_text').description, /slideIndex/); assert.match(tool(bridge(), 'set_slide_text').description, /objectOrdinal/); assert.match(tool(bridge(), 'set_slide_text').description, /text/);
  for (const argument of ['slideIndex', 'objectOrdinal', 'bold', 'italic', 'underline', 'fontSize', 'fontFamily', 'color']) assert.match(tool(bridge(), 'format_slide_text').description, new RegExp(argument));
});

test('mutation arguments are validated before bridge dispatch', async () => {
  const value = bridge(); const add = tool(value, 'add_slide'); const text = tool(value, 'set_slide_text');
  for (const args of [{ layoutFromSlideIndex: -1 }, { layoutFromSlideIndex: 1.5 }, { extra: 1 }, null]) assert.equal((await add.execute(args, ctx)).code, 'TOOL_ERROR');
  for (const args of [{}, { objectOrdinal: -1, text: '' }, { objectOrdinal: 0 }, { objectOrdinal: 0, text: 1 }, { objectOrdinal: 0, text: '', extra: 1 }, null]) assert.equal((await text.execute(args, ctx)).code, 'TOOL_ERROR');
  const format = tool(value, 'format_slide_text');
  for (const args of [{ objectOrdinal: 0 }, { objectOrdinal: 0, bold: true, extra: 1 }, { objectOrdinal: -1, bold: true }, { objectOrdinal: 0, bold: 'yes' }, { objectOrdinal: 0, fontSize: 0 }, { objectOrdinal: 0, fontSize: LIMITS.slideFormatFontSizeMax + 1 }, { objectOrdinal: 0, color: { r: 0, g: 0, b: 256 } }, null]) assert.equal((await format.execute(args, ctx)).code, 'TOOL_ERROR');
  assert.deepEqual(value.calls, { add: 0, text: 0, format: 0 });
});

test('set_slide_text refuses over-bound UTF-8 text before dispatch', async () => {
  const value = bridge(); const result = await tool(value, 'set_slide_text').execute({ objectOrdinal: 0, text: 'Ж'.repeat(LIMITS.slideReadTextBytes / 2 + 1) }, ctx);
  assert.equal(result.code, 'BYTE_LIMIT'); assert.equal(value.calls.text, 0);
});

test('mutation success is shape-checked and uncertain maps to TOOL_UNCERTAIN', async () => {
  const good = bridge(); assert.equal((await tool(good, 'add_slide').execute({}, ctx)).ok, true); assert.equal((await tool(good, 'set_slide_text').execute({ objectOrdinal: 0, text: '' }, ctx)).ok, true);
  const uncertain = { async addSlide() { return { ok: false, code: 'APPLY_UNCERTAIN' }; }, async setSlideText() { return { ok: false, code: 'APPLY_UNCERTAIN' }; } };
  assert.equal((await tool(uncertain, 'add_slide').execute({}, ctx)).code, 'TOOL_UNCERTAIN'); assert.equal((await tool(uncertain, 'set_slide_text').execute({ objectOrdinal: 0, text: '' }, ctx)).code, 'TOOL_UNCERTAIN');
});

test('mutation result byte bound is enforced', async () => {
  const huge = { async addSlide() { return { ok: true, slidesCount: 2, slideIndex: 1, layoutId: 'x'.repeat(LIMITS.slideReadResultBytes), layoutPreserved: true }; } };
  assert.equal((await tool(huge, 'add_slide').execute({}, ctx)).code, 'BYTE_LIMIT');
});
