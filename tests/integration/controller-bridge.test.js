import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../../src/ui/controller.js';
import { createR7Bridge } from '../../src/plugin/bridge.js';
import { SettingsStore } from '../../src/config/storage.js';

function setup(options = {}) {
  let time = 0; const tasks = new Map(); const callbacks = []; let calls = 0;
  const timers = { schedule(fn, ms) { const key = {}; tasks.set(key, { fn, at: time + ms }); return key; }, clear(key) { tasks.delete(key); } };
  const clock = { now() { return time; } };
  const plugin = { executeMethod(name, args, cb) { assert.equal(name, 'GetSelectedText'); assert.deepEqual(args, []); callbacks.push(cb); return false; } };
  const bridge = createR7Bridge(plugin, { editorType: 'word', timers, clock });
  const controller = createController({ bridge, timers, clock, store: new SettingsStore(null), crypto: { randomUUID() { return '00000000-0000-4000-8000-000000000001'; } }, transport: async () => { calls++; return { type: 'final', message: 'answer' }; }, ...options });
  controller.saveSettings({ endpoint: 'https://example.invalid/v1/chat/completions', apiKey: 'synthetic' });
  return { controller, bridge, callbacks, get calls() { return calls; }, advance(ms) { time += ms; for (const [key, task] of [...tasks]) if (task.at <= time) { tasks.delete(key); task.fn(); } } };
}
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
test('no production mutation dispatch even after EDIT and purported identical-text target', async () => {
  const f = setup({ transport: async () => ({ type: 'tool', tool: 'r7_replace_selection', arguments: { text: 'proposal' } }) });
  f.controller.setMode('EDIT'); const operation = f.controller.analyze('edit'); f.callbacks[0]('same text'); await operation;
  assert.equal(f.controller.getState().preview.target, null); assert.equal(await f.controller.apply(), false); assert.equal(f.callbacks.length, 1);
  assert.equal(f.controller.getState().runtimeVerified, false); f.controller.dispose();
});
