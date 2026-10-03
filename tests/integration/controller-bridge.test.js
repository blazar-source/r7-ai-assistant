import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../../src/ui/controller.js';
import { createR7Bridge } from '../../src/plugin/bridge.js';
import { SettingsStore } from '../../src/config/storage.js';
import { mountPanel } from '../../src/ui/view.js';
import { dom } from '../fixtures/dom.js';

function setup(options = {}) {
  let time = 0; const tasks = new Map(); const callbacks = []; let calls = 0;
  const timers = { schedule(fn, ms) { const key = {}; tasks.set(key, { fn, at: time + ms }); return key; }, clear(key) { tasks.delete(key); } };
  const clock = { now() { return time; } };
  const plugin = { info: { editorType: 'word' }, callCommand(_body, _close, _recalculate, cb) { cb(['bounded-id', true, true, false]); },
    executeMethod(name, args, cb) { assert.equal(name, 'GetSelectedText'); assert.deepEqual(args, []); callbacks.push(cb); return false; } };
  const bridge = createR7Bridge(plugin, { editorType: 'word', timers, clock });
  const controller = createController({ bridge, timers, clock, store: new SettingsStore(null), crypto: { randomUUID() { return '00000000-0000-4000-8000-000000000001'; } }, transport: async () => { calls++; return { type: 'final', message: 'answer' }; }, ...options });
  controller.saveSettings({ endpoint: 'https://example.invalid/v1/chat/completions', apiKey: 'synthetic' });
  return { controller, bridge, callbacks, get calls() { return calls; }, advance(ms) { time += ms; for (const [key, task] of [...tasks]) if (task.at <= time) { tasks.delete(key); task.fn(); } } };
}
const presence = Object.freeze([true, true, false, true, false, true]);
function probeFixture(editorType = 'word', hasCommand = true) {
  let time = 100; let uuidCalls = 0; let httpCalls = 0; let reads = 0;
  const tasks = new Map(); const callbacks = []; const dispatchTasks = [];
  const timers = { schedule(fn, ms) { const key = {}; tasks.set(key, { fn, at: time + ms }); return key; }, clear(key) { tasks.delete(key); } };
  const clock = { now() { return time; } };
  const plugin = { executeMethod() { reads++; throw Error('probe must not read selection'); } };
  if (hasCommand) plugin.callCommand = function (body, close, recalculate, callback) {
    assert.equal(typeof body, 'function'); assert.equal(close, false); assert.equal(recalculate, false);
    dispatchTasks.push([...tasks.values()].map(task => task.at)); callbacks.push(callback); return false;
  };
  const bridge = createR7Bridge(plugin, { editorType, timers, clock });
  const controller = createController({ bridge, timers, clock, store: new SettingsStore(null),
    crypto: { randomUUID() { uuidCalls++; return '00000000-0000-4000-8000-000000000001'; } },
    transport() { httpCalls++; throw Error('no HTTP for probe'); } });
  const tree = dom(); const panel = mountPanel(tree.root, controller);
  function checkAction() { assert.equal(typeof controller.checkR7, 'function', 'owned controller capability action'); assert.ok(tree.id('check-r7'), 'reachable read-only UI action'); }
  return { ...tree, controller, bridge, panel, callbacks, tasks, dispatchTasks, checkAction,
    counters() { return { uuidCalls, httpCalls, reads }; },
    advance(ms, fire = true) { time += ms; if (fire) for (const [key, task] of [...tasks]) if (task.at <= time) { tasks.delete(key); task.fn(); } } };
}

test('UI capability action reaches native owned bridge without credentials, HTTP or chat/context changes', async () => {
  const f = probeFixture(); f.checkAction();
  const before = f.controller.getState(); const model = f.id('model');
  model.focus(); model.value = 'unsaved draft';
  f.id('check-r7').dispatch('click');
  assert.equal(f.controller.getState().active, true);
  assert.equal(f.id('check-r7').disabled, true); assert.equal(f.id('send').disabled, true);
  assert.equal(await f.controller.refreshContext(), false); assert.equal(await f.controller.testConnection(), false);
  assert.equal(await f.controller.checkR7(), false); assert.equal(f.callbacks.length, 1);
  assert.deepEqual(f.dispatchTasks, [[150100, 5100]], 'total deadline armed before SDK callback deadline');
  f.callbacks[0](presence); await new Promise(resolve => setImmediate(resolve));
  const after = f.controller.getState();
  assert.equal(after.status, 'R7_PRESENCE_READY'); assert.equal(after.capabilityCount, 4);
  assert.equal(after.chat, before.chat); assert.equal(after.context, before.context); assert.equal(after.settings, before.settings);
  assert.deepEqual(f.counters(), { uuidCalls: 1, httpCalls: 0, reads: 0 });
  assert.equal(after.runtimeVerified, false); assert.equal(after.canApply, false);
  assert.equal(f.id('apply').disabled, true); assert.match(f.id('r7-capabilities').textContent, /4 \/ 6/);
  assert.match(f.id('r7-capabilities').textContent, /не подтверждены/);
  assert.equal(model.value, 'unsaved draft'); assert.equal(f.document.activeElement, model);
  assert.equal(f.id('check-r7').disabled, false); assert.equal(f.tasks.size, 0);
  assert.equal(await f.controller.apply(), false); assert.equal(f.callbacks.length, 1);
  f.panel.dispose(); f.controller.dispose();
});

for (const editor of ['cell', 'slide', 'unknown', null]) test(`UI probe reports unsupported ${editor} locally without SDK guesses`, async () => {
  const f = probeFixture(editor); f.checkAction();
  assert.equal(await f.controller.checkR7(), false);
  assert.equal(f.controller.getState().status, 'R7_CHECK_UNAVAILABLE');
  assert.equal(f.controller.getState().capabilityCount, null); assert.equal(f.callbacks.length, 0);
  assert.match(f.id('status').textContent, /недоступна/); assert.equal(f.controller.getState().runtimeVerified, false);
  f.panel.dispose(); f.controller.dispose();
});
test('Word without callCommand reports unsupported rather than treating adapter metadata as runtime proof', async () => {
  const f = probeFixture('word', false); f.checkAction();
  assert.equal(await f.controller.checkR7(), false); assert.equal(f.controller.getState().status, 'R7_CHECK_UNAVAILABLE');
  assert.equal(f.controller.getState().capabilityCount, null); assert.equal(f.callbacks.length, 0);
  f.panel.dispose(); f.controller.dispose();
});
for (const change of ['stop', 'settingsChanged', 'contextChanged', 'newChat', 'reset', 'mode', 'context', 'dispose']) {
  test(`probe ${change} cancels caller; late callback only frees same SDK owner`, async () => {
    const f = probeFixture(); f.checkAction(); const operation = f.controller.checkR7();
    assert.equal(f.callbacks.length, 1); assert.equal(f.controller.getState().active, true);
    if (change === 'mode') f.controller.setMode('EDIT');
    else if (change === 'context') f.controller.setIncludeContext(false);
    else f.controller[change]();
    assert.equal(await operation, false); const state = f.controller.getState();
    assert.equal(f.bridge.getState().busy, true); assert.equal(f.bridge.getState().uncertain, true);
    assert.equal(await f.controller.checkR7(), false); assert.equal(f.callbacks.length, 1);
    const lateState = f.controller.getState();
    if (change !== 'dispose') assert.equal(lateState.status, 'EDITOR_BUSY');
    f.callbacks[0](presence); await Promise.resolve();
    assert.equal(f.bridge.getState().busy, false); assert.equal(f.controller.getState().status, lateState.status);
    assert.equal(f.controller.getState().capabilityCount, null); assert.equal(state.active, false);
    assert.deepEqual(f.counters(), { uuidCalls: change === 'newChat' ? 2 : 1, httpCalls: 0, reads: 0 });
    if (change !== 'dispose') {
      const fresh = f.controller.checkR7(); assert.equal(f.callbacks.length, 2);
      f.callbacks[0](presence); assert.equal(f.bridge.getState().busy, true, 'duplicate old callback cannot release new slot');
      f.callbacks[1](presence); assert.equal(await fresh, true);
    }
    f.panel.dispose(); f.controller.dispose();
  });
}
test('probe 5000ms callback timeout keeps SDK busy until matching callback, without publishing late presence', async () => {
  const f = probeFixture(); f.checkAction(); const operation = f.controller.checkR7();
  f.advance(5000); assert.equal(await operation, false); assert.equal(f.controller.getState().status, 'TIMEOUT');
  assert.equal(f.bridge.getState().busy, true); assert.equal(f.bridge.getState().uncertain, true);
  assert.equal(await f.controller.checkR7(), false); assert.equal(f.controller.getState().status, 'EDITOR_BUSY');
  f.callbacks[0](presence); assert.equal(f.bridge.getState().busy, false);
  assert.equal(f.controller.getState().capabilityCount, null); assert.equal(f.callbacks.length, 1);
  f.panel.dispose(); f.controller.dispose();
});
test('probe total deadline cancels signal even when SDK timer delivery is delayed', async () => {
  const f = probeFixture(); f.checkAction(); const operation = f.controller.checkR7();
  f.advance(150000, false);
  const total = [...f.tasks.values()].find(task => task.at === 150100); assert.ok(total); total.fn();
  assert.equal(await operation, false); assert.equal(f.controller.getState().status, 'TIMEOUT');
  assert.equal(f.bridge.getState().uncertain, true); f.callbacks[0](presence);
  assert.equal(f.controller.getState().status, 'TIMEOUT'); assert.equal(f.controller.getState().capabilityCount, null);
  f.panel.dispose(); f.controller.dispose();
});
test('probe rejects rich callback data without exposing raw fields or retaining previous summary', async () => {
  const f = probeFixture(); f.checkAction(); const first = f.controller.checkR7(); f.callbacks[0](presence); await first;
  const next = f.controller.checkR7(); assert.equal(f.controller.getState().capabilityCount, null);
  f.callbacks[1]({ ...presence, docId: 'SECRET_URL_KEY_<script>' });
  assert.equal(await next, false); assert.equal(f.controller.getState().status, 'INVALID_DATA');
  assert.equal(f.root.textContent.includes('SECRET_URL_KEY'), false); assert.equal(f.controller.getState().capabilityCount, null);
  f.panel.dispose(); f.controller.dispose();
});

test('real callback bridge: Stop invalidates caller but late callback only frees SDK slot, never appends UI', async () => {
  const f = setup(); const operation = f.controller.analyze('question'); assert.equal(f.callbacks.length, 1);
  f.controller.stop(); assert.equal(f.bridge.getState().busy, true);
  assert.equal(await operation, false); const state = f.controller.getState();
  assert.equal(await f.controller.analyze('second'), false); assert.equal(f.controller.getState().status, 'EDITOR_BUSY');
  f.callbacks[0]('late'); assert.equal(f.bridge.getState().busy, false); assert.equal(f.controller.getState().chat.history.length, 0); assert.equal(f.calls, 0);
  assert.equal(state.status, 'STOPPED'); f.controller.dispose();
});
test('real bridge missing callback times out but cannot queue second request or recreate adapter', async () => {
  const f = setup(); const operation = f.controller.analyze('q'); f.advance(5000); await operation;
  assert.equal(f.controller.getState().status, 'TIMEOUT'); assert.equal(f.bridge.getState().uncertain, true);
  f.controller.newChat(); await f.controller.refreshContext(); assert.equal(f.callbacks.length, 1);
  assert.equal(f.controller.getState().status, 'EDITOR_BUSY'); f.controller.dispose();
});
test('ASK final response cannot acquire Apply ownership even with a valid native capture', async () => {
  const f = setup(); const operation = f.controller.analyze('question'); f.callbacks[0]('same text'); await operation;
  assert.equal(f.controller.getState().preview, null); assert.equal(await f.controller.apply(), false); assert.equal(f.callbacks.length, 1);
  assert.equal(f.controller.getState().runtimeVerified, false); f.controller.dispose();
});
