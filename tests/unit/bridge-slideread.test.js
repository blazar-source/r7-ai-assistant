import test from 'node:test';
import assert from 'node:assert/strict';
import { createR7Bridge } from '../../src/plugin/bridge.js';
import { LIMITS } from '../../src/shared/limits.js';

function shape(text = 'Title') {
  return { GetClassType() { return 'drawing'; }, GetPlaceholder() { return {}; }, GetContent() { return { GetElementsCount() { return 1; }, GetElement() { return { GetText() { return text; } }; } }; } };
}
function slide({ index = 0, text = 'Title', layoutId = 304, shapes = [shape(text)], includeIndex = true, classType = 'slide' } = {}) {
  const value = { GetClassType() { return classType; }, GetLayout() { return { ToJSON() { return layoutId === null ? {} : { id: layoutId }; } }; }, GetAllShapes() { return shapes; }, GetAllDrawings() { return shapes; }, GetAllImages() { return []; }, GetAllCharts() { return []; }, GetAllOleObjects() { return []; } };
  if (includeIndex) value.GetSlideIndex = function () { return index; };
  return value;
}
function rig({ slides = [slide()], currentIndex = 0, currentSlide = slides[currentIndex], nativeEnvelope } = {}) {
  const namespace = { scope: {} };
  const presentation = { GetSlidesCount() { return slides.length; }, GetCurSlideIndex() { return currentIndex; }, GetCurrentSlide() { return currentSlide; }, GetSlideByIndex(index) { return slides[index] ?? null; } };
  const plugin = { info: { editorType: 'slide' }, callCommand(body, _close, _recalc, callback) { if (nativeEnvelope !== undefined) callback(nativeEnvelope); else callback(new Function('Api', 'scope', 'return (' + Function.prototype.toString.call(body) + ')();')({ GetPresentation() { return presentation; } }, namespace.scope)); } };
  return createR7Bridge(plugin, { editorType: 'slide', ascNamespace: namespace, clock: { now() { return 0; } }, timers: { schedule() { return {}; }, clear() {} } });
}
const presentationRequest = overrides => ({ maxSlides: LIMITS.slideReadSlidesMax, maxTextBytes: LIMITS.slideReadTextBytes, maxResultBytes: LIMITS.slideReadResultBytes, ...overrides });
const slideRequest = overrides => ({ slideIndex: null, maxObjects: LIMITS.slideReadObjectsMax, maxTextBytes: LIMITS.slideReadTextBytes, maxResultBytes: LIMITS.slideReadResultBytes, ...overrides });

test('presentation and addressed-slide bridge reads execute their own measured command body', async () => {
  const bridge = rig();
  const deck = await bridge.readPresentation(presentationRequest());
  assert.deepEqual(deck, { ok: true, slidesCount: 1, currentSlideIndex: 0, slidesRead: 1, slidesTotal: 1, truncated: false, slides: [{ index: 0, layoutId: 304, shapes: 1, drawings: 1, images: 0, charts: 0, oleObjects: 0, hasText: true }] });
  const one = await bridge.readSlide(slideRequest({ slideIndex: 0 }));
  assert.deepEqual(one, { ok: true, slideIndex: 0, layoutId: 304, objectCount: 1, objectsRead: 1, truncated: false, counts: { shapes: 1, drawings: 1, images: 0, charts: 0, oleObjects: 0 }, objects: [{ ordinal: 0, classType: 'drawing', placeholder: true, category: 'shape', text: 'Title', textOmitted: false }] });
});

test('omitted slide index proves only the current target class', async () => {
  const current = slide({ index: 1, includeIndex: false });
  const result = await rig({ slides: [slide({ index: 0 }), current], currentIndex: 1, currentSlide: current }).readSlide(slideRequest());
  assert.equal(result.ok, true);
  assert.equal(result.slideIndex, 1);
});

test('slide selectors reject non-slides, mismatches, and out-of-range targets', async () => {
  assert.deepEqual(await rig({ currentSlide: slide({ classType: 'drawing', includeIndex: false }) }).readSlide(slideRequest()), { ok: false, code: 'TOOL_ERROR' });
  assert.deepEqual(await rig({ slides: [slide({ index: 1 })] }).readSlide(slideRequest({ slideIndex: 0 })), { ok: false, code: 'TOOL_ERROR' });
  assert.deepEqual(await rig().readSlide(slideRequest({ slideIndex: 1 })), { ok: false, code: 'TOOL_ERROR' });
});

test('presentation and object caps truncate only whole logical entries', async () => {
  const deck = await rig({ slides: [slide({ index: 0 }), slide({ index: 1 })] }).readPresentation(presentationRequest({ maxSlides: 1 }));
  assert.equal(deck.slidesRead < deck.slidesTotal, true);
  assert.equal(deck.truncated, true);
  const objects = [shape('one'), shape('two')];
  const one = await rig({ slides: [slide({ shapes: objects })] }).readSlide(slideRequest({ slideIndex: 0, maxObjects: 1 }));
  assert.equal(one.objectsRead < one.objectCount, true);
  assert.equal(one.truncated, true);
});

test('slide text omission uses UTF-8 bytes and keeps the object', async () => {
  const over = 'Ж'.repeat(Math.floor(LIMITS.slideReadTextBytes / 2) + 1);
  const omitted = await rig({ slides: [slide({ shapes: [shape(over)] })] }).readSlide(slideRequest({ slideIndex: 0 }));
  assert.equal(omitted.objects.length, 1);
  assert.equal(omitted.objects[0].text, null);
  assert.equal(omitted.objects[0].textOmitted, true);
  const exact = 'Ж'.repeat(LIMITS.slideReadTextBytes / 2);
  const included = await rig({ slides: [slide({ shapes: [shape(exact)] })] }).readSlide(slideRequest({ slideIndex: 0 }));
  assert.equal(included.objects[0].text, exact);
  assert.equal(included.objects[0].textOmitted, false);
});

test('presentation summaries derive hasText and leave unmeasured layout id null', async () => {
  const deck = await rig({ slides: [slide({ index: 0, text: 'text', layoutId: null }), slide({ index: 1, text: '' })] }).readPresentation(presentationRequest());
  assert.equal(deck.slides[0].hasText, true);
  assert.equal(deck.slides[0].layoutId, null);
  assert.equal(deck.slides[1].hasText, false);
});

test('malformed native slide envelope is a known bridge refusal', async () => {
  assert.deepEqual(await rig({ nativeEnvelope: [1, 0] }).readSlide(slideRequest()), { ok: false, code: 'INVALID_DATA' });
});
