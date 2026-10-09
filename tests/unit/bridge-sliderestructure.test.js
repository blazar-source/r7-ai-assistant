import test from 'node:test';
import assert from 'node:assert/strict';
import { createR7Bridge } from '../../src/plugin/bridge.js';
import { LIMITS } from '../../src/shared/limits.js';

function object(text) {
  return { GetContent() { return { GetElementsCount() { return 1; }, GetElement() { return { GetText() { return text; } }; } }; } };
}
function rig(options = {}) {
  const namespace = { scope: {} };
  let dispatches = 0;
  let mutations = 0;
  const notifications = [];
  let deliver;
  let current = 0;
  let deck = (options.slides ?? [
    { layout: '{"id":"306"}', texts: ['A', ''], json: '{"slide":"A"}' },
    { layout: '{"id":"219"}', texts: ['B', ''], json: '{"slide":"BBBB"}' },
    { layout: '{"id":"306"}', texts: ['C', ''], json: '{"slide":"CCCCCCCC"}' }
  ]).map(value => ({ ...value }));
  function wrapper(value) {
    return {
      GetClassType() { return 'slide'; },
      GetSlideIndex() { return deck.indexOf(value); },
      GetLayout() { return { ToJSON() { return value.layout; } }; },
      GetAllShapes() { return value.texts.map(object); },
      ToJSON() { return value.json; },
      Duplicate() {
        mutations++;
        const copy = { ...value, texts: value.texts.slice(), json: value.json + ' duplicate' };
        if (options.copyMismatch) copy.texts[0] += '!';
        if (options.duplicateNext) deck.splice(deck.indexOf(value) + 1, 0, copy); else deck.push(copy);
        if (options.foreignChange) deck[0].json += '!';
        return wrapper(copy);
      },
      MoveTo(index) {
        mutations++;
        if (options.moveFalse) return false;
        const from = deck.indexOf(value);
        if (index < 0 || index >= deck.length) return false;
        if (from !== index) { deck.splice(from, 1); deck.splice(index, 0, value); }
        if (options.moveWrong && from !== index) { deck.splice(index, 1); deck.splice(from, 0, value); }
        if (options.foreignChange) deck.find(item => item !== value).json += '!';
        return true;
      }
    };
  }
  const presentation = { GetSlidesCount() { return deck.length; }, GetCurSlideIndex() { return current; }, GetCurrentSlide() { return wrapper(deck[current]); }, GetSlideByIndex(index) { return deck[index] ? wrapper(deck[index]) : null; } };
  const Api = { GetPresentation() { return presentation; } };
  if (!options.noNotification) Api.UpdateInterfaceState = function () {
    notifications.push(deck.map(value => value.texts[0]));
    if (options.notificationThrows) throw new Error('native notification failed');
  };
  const plugin = { info: { editorType: 'slide' }, callCommand(body, _close, _recalc, callback) { dispatches++; const value = new Function('Api', 'scope', 'return (' + Function.prototype.toString.call(body) + ')();')(Api, namespace.scope); if (options.defer) deliver = () => callback(value); else callback(value); } };
  return { bridge: createR7Bridge(plugin, { editorType: 'slide', ascNamespace: namespace, clock: { now() { return 0; } }, timers: { schedule() { return {}; }, clear() {} } }), dispatches: () => dispatches, mutations: () => mutations, notifications, deliver: () => deliver() };
}
const request = values => ({ maxResultBytes: LIMITS.slideReadResultBytes, ...values });

test('duplicate_slide proves end copy content and unchanged other fingerprints', async () => {
  assert.deepEqual(await rig().bridge.duplicateSlide(request({ slideIndex: 1 })), { ok: true, slidesCount: 4, slideIndex: 3, duplicatedFrom: 1, layoutLength: 12, shapes: 2 });
});
test('duplicate_slide rejects naive adjacent placement and proof changes as uncertain', async () => {
  for (const options of [{ duplicateNext: true }, { copyMismatch: true }, { foreignChange: true }]) assert.equal((await rig(options).bridge.duplicateSlide(request({ slideIndex: 1 }))).code, 'APPLY_UNCERTAIN');
});
test('move_slide proves moved fingerprint and preserves remaining set including same-index success', async () => {
  assert.deepEqual(await rig().bridge.moveSlide(request({ fromIndex: 2, toIndex: 0 })), { ok: true, slidesCount: 3, fromIndex: 2, toIndex: 0, layoutLength: 12, shapes: 2 });
  assert.deepEqual(await rig().bridge.moveSlide(request({ fromIndex: 1, toIndex: 1 })), { ok: true, slidesCount: 3, fromIndex: 1, toIndex: 1, layoutLength: 12, shapes: 2 });
});
test('move_slide maps false to known error and failed proof to uncertain', async () => {
  assert.deepEqual(await rig({ moveFalse: true }).bridge.moveSlide(request({ fromIndex: 2, toIndex: 0 })), { ok: false, code: 'TOOL_ERROR' });
  for (const options of [{ moveWrong: true }, { foreignChange: true }]) assert.equal((await rig(options).bridge.moveSlide(request({ fromIndex: 2, toIndex: 0 }))).code, 'APPLY_UNCERTAIN');
});
test('restructure requests reject closed and out-of-range arguments before mutation dispatch', async () => {
  for (const [method, value] of [['duplicateSlide', { slideIndex: -1 }], ['duplicateSlide', { slideIndex: 3 }], ['moveSlide', { fromIndex: 3, toIndex: 0 }], ['moveSlide', { fromIndex: 0, toIndex: 3 }], ['moveSlide', { fromIndex: 0, toIndex: 1, extra: 1 }]]) { const target = rig(); assert.equal((await target.bridge[method](request(value))).code, 'TOOL_ERROR'); if (value.slideIndex === -1 || value.extra) assert.equal(target.dispatches(), 0); }
});

for (const [method, args, expected] of [
  ['moveSlide', { fromIndex: 1, toIndex: 2 }, ['A', 'C', 'B']],
  ['duplicateSlide', { slideIndex: 1 }, ['A', 'B', 'C', 'B']]
]) {
  test(`${method} refreshes native interface once after the actual change`, async () => {
    const target = rig();
    assert.equal((await target.bridge[method](request(args))).ok, true);
    assert.deepEqual(target.notifications, [expected]);
    assert.equal(target.mutations(), 1);
  });
  test(`${method} refuses before mutation without native interface capability`, async () => {
    const target = rig({ noNotification: true });
    assert.deepEqual(await target.bridge[method](request(args)), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
    assert.equal(target.mutations(), 0);
  });
  test(`${method} fails uncertain without retry when native interface notification throws`, async () => {
    const target = rig({ notificationThrows: true });
    assert.deepEqual(await target.bridge[method](request(args)), { ok: false, code: 'APPLY_UNCERTAIN' });
    assert.equal(target.mutations(), 1);
    assert.equal(target.notifications.length, 1);
    assert.equal((await target.bridge[method](request(args))).ok, false);
    assert.equal(target.mutations(), 1);
  });
}

test('cancelled dispatched move remains uncertain until its actual late callback and never repeats the write', async () => {
  const target = rig({ defer: true });
  const controller = new AbortController();
  const pending = target.bridge.moveSlide(request({ fromIndex: 1, toIndex: 2, signal: controller.signal }));
  controller.abort();
  assert.deepEqual(await pending, { ok: false, code: 'APPLY_UNCERTAIN' });
  assert.equal((await target.bridge.moveSlide(request({ fromIndex: 1, toIndex: 2 }))).ok, false);
  assert.equal(target.mutations(), 1);
  target.deliver();
  assert.equal(target.mutations(), 1);
  assert.deepEqual(target.notifications, [['A', 'C', 'B']]);
});
test('known move refusal does not notify the interface and releases the bridge', async () => {
  const target = rig({ moveFalse: true });
  assert.deepEqual(await target.bridge.moveSlide(request({ fromIndex: 1, toIndex: 2 })), { ok: false, code: 'TOOL_ERROR' });
  assert.deepEqual(target.notifications, []);
  assert.deepEqual(await target.bridge.moveSlide(request({ fromIndex: 1, toIndex: 2 })), { ok: false, code: 'TOOL_ERROR' });
  assert.equal(target.mutations(), 2);
});
