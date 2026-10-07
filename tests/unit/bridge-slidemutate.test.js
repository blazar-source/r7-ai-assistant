import test from 'node:test';
import assert from 'node:assert/strict';
import { createR7Bridge } from '../../src/plugin/bridge.js';
import { LIMITS } from '../../src/shared/limits.js';

function layout(serialized = '{"id":"306","master":"101"}') {
  return { ToJSON() { return serialized; } };
}
function content(initialText = '', { readBackText, countAfter = 1 } = {}) {
  let stored = [initialText];
  return {
    RemoveAllElements() { stored = []; },
    AddElement(paragraph) { stored.push(paragraph._text); },
    GetElement(index) { return { AddText(text) { stored[index] = text; }, GetText() { return readBackText === undefined ? stored[index] : readBackText; } }; },
    GetElementsCount() { return countAfter; }
  };
}
function shape(text = '', options) { const value = content(text, options); return { value, GetContent() { return value; } }; }
function slide(index, serialized, objects = [shape()], { noApplyLayout = false, appliedLayout = null } = {}) { let slideLayout = layout(serialized); const value = { GetClassType() { return 'slide'; }, GetSlideIndex() { return index; }, GetLayout() { return slideLayout; }, GetAllShapes() { return objects; } }; if (!noApplyLayout) value.ApplyLayout = function (nextLayout) { slideLayout = appliedLayout === null ? nextLayout : layout(appliedLayout); }; return value; }
function rig({ slides = [slide(0, '{"id":"306","master":"101"}')], currentIndex = 0, addedLayout = null, noApplyLayout = false, appliedLayout = null, noGrowth = false, nativeEnvelope } = {}) {
  const namespace = { scope: {} };
  let deck = slides.slice();
  let current = currentIndex;
  let dispatches = 0;
  const presentation = { GetSlidesCount() { return deck.length; }, GetCurSlideIndex() { return current; }, GetCurrentSlide() { return deck[current]; }, GetSlideByIndex(index) { return deck[index] ?? null; } };
  const Api = { GetPresentation() { return presentation; }, AddSlide(_ignoredLayout) { if (!noGrowth) { const serialized = addedLayout ?? deck[current].GetLayout().ToJSON(); current += 1; deck.splice(current, 0, slide(current, serialized, [shape()], { noApplyLayout, appliedLayout })); } }, CreateParagraph() { return { _text: '', AddText(text) { this._text = text; } }; } };
  const plugin = { info: { editorType: 'slide' }, callCommand(body, _close, _recalc, callback) { dispatches++; if (nativeEnvelope !== undefined) callback(nativeEnvelope); else callback(new Function('Api', 'scope', 'return (' + Function.prototype.toString.call(body) + ')();')(Api, namespace.scope)); } };
  return { bridge: createR7Bridge(plugin, { editorType: 'slide', ascNamespace: namespace, clock: { now() { return 0; } }, timers: { schedule() { return {}; }, clear() {} } }), dispatches: () => dispatches };
}
const addRequest = overrides => ({ layoutFromSlideIndex: null, maxResultBytes: LIMITS.slideReadResultBytes, ...overrides });
const textRequest = overrides => ({ slideIndex: null, objectOrdinal: 0, text: 'Hello', maxTextBytes: LIMITS.slideReadTextBytes, maxResultBytes: LIMITS.slideReadResultBytes, ...overrides });

test('add_slide inherits a named non-current layout and extracts serialized string id', async () => {
  const { bridge } = rig({ slides: [slide(0, '{"id":"306"}'), slide(1, '{"id":"219"}')], currentIndex: 0 });
  assert.deepEqual(await bridge.addSlide(addRequest({ layoutFromSlideIndex: 1 })), { ok: true, slidesCount: 3, slideIndex: 1, layoutId: '219', layoutPreserved: true });
});

test('add_slide omitted source uses current slide and missing id publishes null', async () => {
  const { bridge } = rig({ slides: [slide(0, '{"master":"101"}')] });
  assert.deepEqual(await bridge.addSlide(addRequest()), { ok: true, slidesCount: 2, slideIndex: 1, layoutId: null, layoutPreserved: true });
});

test('add_slide rejects mismatched named source before mutation', async () => {
  const bad = slide(2, '{"id":"306"}'); const { bridge } = rig({ slides: [bad] });
  assert.deepEqual(await bridge.addSlide(addRequest({ layoutFromSlideIndex: 0 })), { ok: false, code: 'TOOL_ERROR' });
});

test('add_slide count proof failure is uncertain', async () => {
  assert.deepEqual(await rig({ noGrowth: true }).bridge.addSlide(addRequest()), { ok: false, code: 'APPLY_UNCERTAIN' });
});

test('add_slide missing ApplyLayout is uncertain after creation', async () => {
  assert.deepEqual(await rig({ noApplyLayout: true }).bridge.addSlide(addRequest()), { ok: false, code: 'APPLY_UNCERTAIN' });
});

test('add_slide does not report preservation when ApplyLayout leaves a differing layout', async () => {
  const { bridge } = rig({ appliedLayout: '{"id":"306","master":"999"}' });
  const result = await bridge.addSlide(addRequest());
  assert.deepEqual(result, { ok: false, code: 'APPLY_UNCERTAIN' });
  assert.notEqual(result.layoutPreserved, true);
});

test('add_slide extracts layoutId as a string from the measured serialized layout', async () => {
  const { bridge } = rig();
  const result = await bridge.addSlide(addRequest());
  assert.deepEqual(result, { ok: true, slidesCount: 2, slideIndex: 1, layoutId: '306', layoutPreserved: true });
});

test('set_slide_text re-fetches the attached wrapper and proves the round trip', async () => {
  const target = shape('Old'); const { bridge } = rig({ slides: [slide(0, '{"id":"306"}', [target])] });
  assert.deepEqual(await bridge.setSlideText(textRequest({ text: 'Привет' })), { ok: true, slideIndex: 0, objectOrdinal: 0, textLength: 6, textBytes: 12 });
  assert.equal(target.value.GetElement(0).GetText(), 'Привет');
});

test('set_slide_text supports named and current addressing plus idempotent write', async () => {
  const first = shape('Same'); const second = shape('Same'); const { bridge } = rig({ slides: [slide(0, '{"id":"306"}', [first]), slide(1, '{"id":"219"}', [second])], currentIndex: 1 });
  assert.equal((await bridge.setSlideText(textRequest({ text: 'Same' }))).slideIndex, 1);
  assert.equal((await bridge.setSlideText(textRequest({ slideIndex: 0, text: 'Same' }))).slideIndex, 0);
});

test('set_slide_text rejects mismatched slide and missing object before mutation', async () => {
  const { bridge } = rig({ slides: [slide(1, '{"id":"306"}', [])] });
  assert.deepEqual(await bridge.setSlideText(textRequest({ slideIndex: 0 })), { ok: false, code: 'TOOL_ERROR' });
  assert.deepEqual(await bridge.setSlideText(textRequest({ objectOrdinal: 2 })), { ok: false, code: 'TOOL_ERROR' });
});

test('set_slide_text proof mismatch is uncertain', async () => {
  const target = shape('Old', { readBackText: 'wrong' }); const { bridge } = rig({ slides: [slide(0, '{"id":"306"}', [target])] });
  assert.deepEqual(await bridge.setSlideText(textRequest()), { ok: false, code: 'APPLY_UNCERTAIN' });
});

test('bridge argument validation and text byte bound refuse before dispatch', async () => {
  const add = rig(); assert.equal((await add.bridge.addSlide(addRequest({ layoutFromSlideIndex: -1 }))).code, 'TOOL_ERROR'); assert.equal(add.dispatches(), 0);
  const text = rig(); assert.equal((await text.bridge.setSlideText(textRequest({ text: 'Ж'.repeat(LIMITS.slideReadTextBytes / 2 + 1) }))).code, 'BYTE_LIMIT'); assert.equal(text.dispatches(), 0);
});

test('malformed mutation envelopes are closed uncertain after dispatch', async () => {
  assert.deepEqual(await rig({ nativeEnvelope: [7] }).bridge.addSlide(addRequest()), { ok: false, code: 'APPLY_UNCERTAIN' });
  assert.deepEqual(await rig({ nativeEnvelope: [7] }).bridge.setSlideText(textRequest()), { ok: false, code: 'APPLY_UNCERTAIN' });
});
