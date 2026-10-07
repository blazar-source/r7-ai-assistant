import test from 'node:test';
import assert from 'node:assert/strict';
import { createR7Bridge } from '../../src/plugin/bridge.js';
import { LIMITS } from '../../src/shared/limits.js';

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function content(text = 'Hello', initial = {}, options = {}) {
  const rPr = clone(initial);
  const calls = [];
  const fontSizeArguments = [];
  const paragraph = {
    GetText() { return options.changedText !== undefined && Object.hasOwn(rPr, 'b') ? options.changedText : text; },
    GetTextPr() { return { ToJSON() { return '{"bFromDocument":false,"type":"textPr"}'; } }; },
    SetBold(value) { calls.push('bold'); rPr.b = value; },
    SetItalic(value) { calls.push('italic'); rPr.i = value; },
    SetUnderline(value) { calls.push('underline'); rPr.u = value ? 'sng' : 'none'; },
    SetFontSize(value) { calls.push('fontSize'); fontSizeArguments.push(value); rPr.sz = value * 50; },
    SetFontFamily(value) { calls.push('fontFamily'); rPr.latin = value; rPr.cs = value; },
    SetColor(r, g, b) { calls.push('color'); rPr.uniFill = { fill: { color: { rgba: { red: 0, green: 0, blue: 0, alpha: 255 }, color: { rgba: { red: r, green: g, blue: b, alpha: 255 }, type: 'srgb' } } } }; }
  };
  return { calls, fontSizeArguments, rPr,
    GetElementsCount() { return options.count ?? 1; },
    GetElement(index) { return index === 0 && options.missingElement !== true ? paragraph : null; },
    ToJSON() {
      if (options.unparseable) return '{';
      const visible = clone(rPr);
      if (options.hideRequested) delete visible.b;
      if (options.changeUnrequested && Object.hasOwn(rPr, 'b')) visible.i = initial.i === undefined ? true : !initial.i;
      return JSON.stringify({ content: [{ rPr: visible }] });
    }
  };
}
function shape(value, noContent = false) { return noContent ? {} : { GetContent() { return value; } }; }
function slide(index, objects, classType = 'slide') { return { GetClassType() { return classType; }, GetSlideIndex() { return index; }, GetAllShapes() { return objects; } }; }
function rig({ targetContent = content(), slides, currentIndex = 0, nativeEnvelope, directScope } = {}) {
  const namespace = { scope: directScope === undefined ? {} : directScope }; let dispatches = 0;
  const deck = slides ?? [slide(0, [shape(targetContent)])];
  const presentation = { GetCurSlideIndex() { return currentIndex; }, GetCurrentSlide() { return deck[currentIndex]; }, GetSlideByIndex(index) { return deck[index] ?? null; } };
  const Api = { GetPresentation() { return presentation; } };
  const plugin = { info: { editorType: 'slide' }, callCommand(body, _close, _recalc, callback) { dispatches++; callback(nativeEnvelope ?? new Function('Api', 'scope', 'return (' + Function.prototype.toString.call(body) + ')();')(Api, directScope === undefined ? namespace.scope : directScope)); } };
  return { bridge: createR7Bridge(plugin, { editorType: 'slide', ascNamespace: namespace, clock: { now() { return 0; } }, timers: { schedule() { return {}; }, clear() {} } }), dispatches: () => dispatches, targetContent };
}
const request = overrides => ({ slideIndex: null, objectOrdinal: 0, bold: true, maxFontSize: LIMITS.slideFormatFontSizeMax, maxResultBytes: LIMITS.slideReadResultBytes, ...overrides });

test('format_slide_text applies exactly requested setters and proves measured rPr without changing text', async () => {
  const value = content('Measured', { i: true, latin: 'Old', cs: 'Old' }); const { bridge } = rig({ targetContent: value });
  assert.deepEqual(await bridge.formatSlideText(request({ bold: true, fontSize: 14, color: { r: 255, g: 0, b: 0 } })), { ok: true, slideIndex: 0, objectOrdinal: 0, applied: ['bold', 'fontSize', 'color'], textLength: 8 });
  assert.deepEqual(value.calls, ['bold', 'fontSize', 'color']); assert.equal(value.rPr.sz, 1400); assert.equal(value.rPr.i, true);
});

for (const [points, halfPoints, hundredths] of [[12, 24, 1200], [28, 56, 2800], [56, 112, 5600]]) {
  test(`format_slide_text converts ${points} points to ${halfPoints} half-points and proves sz ${hundredths}`, async () => {
    const targetContent = content();
    const { bridge } = rig({ targetContent });
    const result = await bridge.formatSlideText(request({ bold: undefined, fontSize: points }));
    assert.deepEqual(targetContent.fontSizeArguments, [halfPoints]);
    assert.equal(targetContent.rPr.sz, hundredths);
    assert.deepEqual(result, { ok: true, slideIndex: 0, objectOrdinal: 0, applied: ['fontSize'], textLength: 5 });
  });
}

test('format_slide_text returns APPLY_UNCERTAIN when stored font size differs from requested hundredths', async () => {
  const targetContent = content();
  const measuredSetter = targetContent.GetElement(0).SetFontSize;
  targetContent.GetElement(0).SetFontSize = function (value) { measuredSetter.call(this, value); targetContent.rPr.sz += 1; };
  const { bridge } = rig({ targetContent });
  const result = await bridge.formatSlideText(request({ bold: undefined, fontSize: 28 }));
  assert.deepEqual(targetContent.fontSizeArguments, [56]);
  assert.equal(targetContent.rPr.sz, 2801);
  assert.deepEqual(result, { ok: false, code: 'APPLY_UNCERTAIN' });
});

test('format_slide_text succeeds idempotently and supports named addressing', async () => {
  const first = content('Same', { b: true }); const second = content('Same', { b: true }); const { bridge } = rig({ slides: [slide(0, [shape(first)]), slide(1, [shape(second)])], currentIndex: 1 });
  assert.equal((await bridge.formatSlideText(request())).slideIndex, 1);
  assert.equal((await bridge.formatSlideText(request({ slideIndex: 0 }))).slideIndex, 0);
});

test('format_slide_text refuses malformed closed requests before dispatch', async () => {
  const cases = [request({ extra: true }), request({ bold: undefined }), request({ bold: 'yes' }), request({ bold: undefined, italic: 1 }), request({ bold: undefined, fontSize: 0 }), request({ bold: undefined, fontSize: LIMITS.slideFormatFontSizeMax + 1 }), request({ bold: undefined, fontFamily: 7 }), request({ bold: undefined, color: { r: -1, g: 0, b: 0 } }), request({ bold: undefined, color: { r: 0, g: 0, b: 256 } }), request({ bold: undefined, color: { r: 0, g: 0, b: 0, a: 1 } })];
  for (const input of cases) { const value = rig(); assert.equal((await value.bridge.formatSlideText(input)).code, 'TOOL_ERROR'); assert.equal(value.dispatches(), 0); }
});

test('slideformat body refuses malformed scopes before setters or snapshots', async () => {
  const cases = [
    { slideIndex: null, objectOrdinal: 0 },
    { slideIndex: null, objectOrdinal: 0, bold: true, shadow: true },
    { slideIndex: null, objectOrdinal: 0, fontSize: 0 },
    { slideIndex: null, objectOrdinal: 0, fontSize: -1 },
    { slideIndex: null, objectOrdinal: 0, fontSize: 1.5 },
    { slideIndex: null, objectOrdinal: 0, fontSize: request().maxFontSize + 1 },
    { slideIndex: null, objectOrdinal: 0, color: { r: -1, g: 0, b: 0 } },
    { slideIndex: null, objectOrdinal: 0, color: { r: 0, g: 0, b: 256 } },
    { slideIndex: null, objectOrdinal: 0, bold: 'yes' },
    { slideIndex: null, objectOrdinal: 0, fontFamily: '' }
  ];
  for (const input of cases) {
    const targetContent = content();
    let snapshots = 0;
    const originalToJSON = targetContent.ToJSON;
    targetContent.ToJSON = function () { snapshots += 1; return originalToJSON.call(this); };
    const value = rig({ targetContent, directScope: { maxFontSize: request().maxFontSize, ...input } });
    const result = await value.bridge.formatSlideText(request({ bold: true }));
    assert.deepEqual(result, { ok: false, code: 'TOOL_ERROR' });
    assert.deepEqual(targetContent.calls, []);
    assert.equal(snapshots, 0);
  }
});

test('slideformat body accepts inclusive font and color bounds', async () => {
  const cases = [
    [{ fontSize: 1 }, ['fontSize']],
    [{ fontSize: request().maxFontSize }, ['fontSize']],
    [{ color: { r: 0, g: 0, b: 0 } }, ['color']],
    [{ color: { r: 255, g: 255, b: 255 } }, ['color']]
  ];
  for (const [overrides, expectedCalls] of cases) {
    const targetContent = content();
    const value = rig({ targetContent });
    const result = await value.bridge.formatSlideText(request({ bold: undefined, ...overrides }));
    assert.equal(result.ok, true);
    assert.deepEqual(targetContent.calls, expectedCalls);
    assert.ok(result.applied.length >= 1);
  }
});

test('slideformat body uses a different scope maxFontSize as its inclusive boundary', async () => {
  for (const maxFontSize of [request().maxFontSize - 1, request().maxFontSize + 1]) {
    for (const fontSize of [1, maxFontSize, maxFontSize + 1]) {
      const targetContent = content();
      const directScope = request({ bold: undefined, maxFontSize, fontSize });
      const value = rig({ targetContent, directScope });
      const result = await value.bridge.formatSlideText(request());
      if (fontSize <= directScope.maxFontSize) {
        assert.equal(result.ok, true);
        assert.deepEqual(targetContent.calls, ['fontSize']);
        assert.equal(targetContent.rPr.sz, fontSize * 100);
      } else {
        assert.deepEqual(result, { ok: false, code: 'TOOL_ERROR' });
        assert.deepEqual(targetContent.calls, []);
      }
    }
  }
});

test('slideformat body refuses missing or invalid scope maxFontSize as capability unavailable', async () => {
  for (const maxFontSize of [undefined, null, '12', 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const directScope = request({ fontSize: 1, maxFontSize });
    if (maxFontSize === undefined) delete directScope.maxFontSize;
    const targetContent = content();
    let snapshots = 0;
    const originalToJSON = targetContent.ToJSON;
    targetContent.ToJSON = function () { snapshots += 1; return originalToJSON.call(this); };
    const value = rig({ targetContent, directScope });
    assert.deepEqual(await value.bridge.formatSlideText(request()), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
    assert.deepEqual(targetContent.calls, []);
    assert.equal(snapshots, 0);
  }
});

test('format_slide_text rejects bad slide/object proofs as TOOL_ERROR', async () => {
  const wrongSlide = rig({ slides: [slide(1, [shape(content())])] }); assert.equal((await wrongSlide.bridge.formatSlideText(request({ slideIndex: 0 }))).code, 'TOOL_ERROR');
  const missingObject = rig({ slides: [slide(0, [])] }); assert.equal((await missingObject.bridge.formatSlideText(request())).code, 'TOOL_ERROR');
  const missingContent = rig({ slides: [slide(0, [shape(content(), true)])] }); assert.equal((await missingContent.bridge.formatSlideText(request())).code, 'TOOL_ERROR');
  const empty = rig({ targetContent: content('x', {}, { count: 0, missingElement: true }) }); assert.equal((await empty.bridge.formatSlideText(request())).code, 'TOOL_ERROR');
});

test('format_slide_text is uncertain for unusable or contradictory post-dispatch proof', async () => {
  const cases = [
    [content('x', {}, { unparseable: true }), {}],
    [content('x', {}, { hideRequested: true }), {}],
    [content('x', { i: true }, { changeUnrequested: true }), {}],
    [content('x', {}, { changedText: 'y' }), {}]
  ];
  for (const [targetContent, overrides] of cases) {
    const value = rig({ targetContent }); assert.deepEqual(await value.bridge.formatSlideText(request(overrides)), { ok: false, code: 'APPLY_UNCERTAIN' });
  }
});

test('format_slide_text closes malformed native envelopes as uncertain', async () => {
  assert.deepEqual(await rig({ nativeEnvelope: [9] }).bridge.formatSlideText(request()), { ok: false, code: 'APPLY_UNCERTAIN' });
});
