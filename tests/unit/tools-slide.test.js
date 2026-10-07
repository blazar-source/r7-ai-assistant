import test from 'node:test';
import assert from 'node:assert/strict';
import { createSlideTools } from '../../src/tools/slide.js';
import { createRegistry } from '../../src/tools/registry.js';
import { LIMITS } from '../../src/shared/limits.js';

function bridgeWith(presentation, slide) {
  const calls = { readPresentation: 0, readSlide: 0, presentationRequest: null, slideRequest: null };
  return { calls,
    async readPresentation(request) { calls.readPresentation++; calls.presentationRequest = request; return typeof presentation === 'function' ? presentation(request) : presentation; },
    async readSlide(request) { calls.readSlide++; calls.slideRequest = request; return typeof slide === 'function' ? slide(request) : slide; } };
}
function tool(bridge, name) { return createSlideTools(bridge).find(entry => entry.name === name); }
const ctx = { editor: 'slide' };
const presentation = { ok: true, slidesCount: 2, currentSlideIndex: 1, slidesRead: 2, slidesTotal: 2, truncated: false,
  slides: [{ index: 0, layoutId: 304, shapes: 2, drawings: 2, images: 0, charts: 0, oleObjects: 0, hasText: true },
    { index: 1, layoutId: null, shapes: 0, drawings: 0, images: 1, charts: 0, oleObjects: 0, hasText: false }] };
const slide = { ok: true, slideIndex: 1, layoutId: 304, objectCount: 2, objectsRead: 2, truncated: false,
  counts: { shapes: 2, drawings: 2, images: 0, charts: 0, oleObjects: 0 },
  objects: [{ ordinal: 0, classType: 'drawing', placeholder: true, category: 'shape', text: 'Title', textOmitted: false },
    { ordinal: 1, classType: 'drawing', placeholder: false, category: 'unknown', text: null, textOmitted: false }] };

test('slide reads are the only presentation tools and are offered in ASK and EDIT', () => {
  const bridge = bridgeWith(presentation, slide);
  const registry = createRegistry(createSlideTools(bridge));
  for (const mode of ['ASK', 'EDIT']) assert.deepEqual(registry.catalogue({ editor: 'slide', capabilities: ['document.read', 'document.write'], mode }).map(entry => entry.name), ['read_presentation', 'read_slide']);
  assert.equal(registry.catalogue({ editor: 'word', capabilities: ['document.read'], mode: 'ASK' }).length, 0);
});

test('read_presentation requests only the measured slide/text caps and publishes a bounded whole-slide list', async () => {
  const bridge = bridgeWith(presentation, slide);
  const result = await tool(bridge, 'read_presentation').execute({}, ctx);
  assert.equal(result.ok, true);
  const { ok, ...expected } = presentation;
  assert.deepEqual(result.data, expected);
  assert.equal(bridge.calls.readPresentation, 1);
  assert.equal(Object.hasOwn(bridge.calls.presentationRequest, 'maxObjects'), false);
  assert.equal(bridge.calls.presentationRequest.maxSlides, LIMITS.slideReadSlidesMax);
  assert.equal(bridge.calls.presentationRequest.maxTextBytes, LIMITS.slideReadTextBytes);
});

test('read_slide accepts only an optional non-negative slideIndex and forwards the object/text caps', async () => {
  const bridge = bridgeWith(presentation, slide);
  const read = tool(bridge, 'read_slide');
  assert.equal((await read.execute({ slideIndex: 1 }, ctx)).ok, true);
  assert.equal(bridge.calls.readSlide, 1);
  assert.equal(bridge.calls.slideRequest.maxObjects, LIMITS.slideReadObjectsMax);
  assert.equal(bridge.calls.slideRequest.maxTextBytes, LIMITS.slideReadTextBytes);
  for (const args of [{ slideIndex: -1 }, { slideIndex: 1.5 }, { slideIndex: '1' }, { unexpected: 1 }, null]) {
    const result = await read.execute(args, ctx); assert.equal(result.code, 'TOOL_ERROR');
  }
  assert.equal(bridge.calls.readSlide, 1, 'invalid addressing never dispatches');
  assert.equal(read.schema.properties.slideIndex.minimum, 0);
  assert.equal(read.schema.properties.slideIndex.maximum, LIMITS.slideReadSlidesMax - 1);
});

test('read_slide refuses a malformed or text-fragmenting bridge envelope', async () => {
  for (const bad of [{ ...slide, objectsRead: 1, truncated: false }, { ...slide, objects: [{ ...slide.objects[0], text: 'x'.repeat(LIMITS.slideReadTextBytes + 1), textOmitted: false }] }, { ...slide, truncated: true, objectsRead: 2 }]) {
    const result = await tool(bridgeWith(presentation, bad), 'read_slide').execute({}, ctx);
    assert.equal(result.code, 'TOOL_ERROR');
  }
});

test('malformed native refusal remains known at the tool layer', async () => {
  for (const name of ['read_presentation', 'read_slide']) {
    const result = await tool(bridgeWith({ ok: false, code: 'INVALID_DATA' }, { ok: false, code: 'INVALID_DATA' }), name).execute({}, ctx);
    assert.deepEqual(result, { ok: false, code: 'INVALID_DATA', message: 'отказ' });
  }
});
