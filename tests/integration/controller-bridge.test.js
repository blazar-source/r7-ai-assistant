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

// --- Task 9: the agent loop driven through the real owned bridge --------------------------------

test('the controller drives a real read tool through the owned bridge and renders the actions summary', async () => {
  let time = 0; const tasks = new Map(); const callbacks = []; const identity = []; let calls = 0;
  const timers = { schedule(fn, ms) { const key = {}; tasks.set(key, { fn, at: time + ms }); return key; }, clear(key) { tasks.delete(key); } };
  const clock = { now() { return time; } };
  const plugin = { info: { editorType: 'word' },
    // The document identity leg is the bridge's own synchronous callCommand probe; it stays native
    // until its callback is delivered, exactly like the selection read.
    callCommand(_body, _close, _recalculate, callback) { identity.push(callback); return false; },
    executeMethod(name, args, callback) { callbacks.push([name, args, callback]); return false; } };
  const bridge = createR7Bridge(plugin, { editorType: 'word', timers, clock });
  const queue = [JSON.stringify({ type: 'tool_calls', calls: [{ tool: 'read_selection', arguments: {} }] }), JSON.stringify({ type: 'final', message: 'Прочитано' })];
  const tree = dom();
  const controller = createController({ bridge, timers, clock, store: new SettingsStore(null),
    crypto: { randomUUID() { return '00000000-0000-4000-8000-000000000001'; } },
    transport: async () => { calls += 1; return { content: queue.shift() }; } });
  controller.saveSettings({ endpoint: 'https://example.invalid/v1/chat/completions', apiKey: 'synthetic' });
  const panel = mountPanel(tree.root, controller);
  const operation = controller.analyze('прочитай');
  const tick = () => new Promise(resolve => setImmediate(resolve));
  // The controller's own context capture: one selection read and one identity probe.
  assert.equal(callbacks.length, 1); assert.equal(callbacks[0][0], 'GetSelectedText');
  callbacks[0][2]('контекст запроса'); await tick();
  assert.equal(identity.length, 1);
  identity[0](['bounded-id', true, true, false]); await tick();
  // The model's read tool dispatches through the SAME owned slot: the tool's read and its identity
  // probe are delivered next, and only then does the loop take its second model step.
  assert.equal(callbacks.length, 2); assert.equal(callbacks[1][0], 'GetSelectedText');
  callbacks[1][2]('текст выделения'); await tick();
  assert.equal(identity.length, 2);
  identity[1](['bounded-id', true, true, false]); await operation;
  const state = controller.getState();
  assert.equal(state.status, 'COMPLETE');
  assert.equal(state.agent.status, 'FINAL');
  assert.equal(calls, 2, 'the read tool result feeds a second model step');
  assert.deepEqual(state.agent.actions.map(action => [action.tool, action.outcome]), [['read_selection', 'ok']]);
  assert.equal(tree.id('actions').textContent, 'read_selection: ok');
  assert.equal(tree.root.textContent.includes('текст выделения'), false, 'the tool result never reaches the DOM');
  panel.dispose(); controller.dispose();
});

// --- Final review, R2: the ONLY auto-mutation end to end through the real bridge ----------------
// `insert_paragraph` is the single `policy:'auto'` mutation the model can dispatch, and its native
// acknowledgement (`PasteText`) is the only evidence the bridge accepts. The bridge does NOT throw its
// uncertain class: a dispatched insert whose callback never arrives settles into a RETURNED
// `{ok:false, code:'APPLY_UNCERTAIN'}` envelope. This drives that exact shape through
// controller -> runAgent -> registry -> the real bridge and pins the terminal behaviour the R1 mapping
// exists for: an unknown mutation outcome stops the run (never COMPLETE), dispatches nothing further,
// and keeps the write lock. Without the `word.js` mapping this test sees COMPLETE/FINAL, a second
// model step and a second tool call — so it cannot pass on the reverted code.
test('an insert whose native PasteText callback never arrives stops the run as uncertain and keeps the write lock', async () => {
  let time = 0; const tasks = new Map(); const selections = []; const identity = []; const inserts = []; let calls = 0;
  const timers = { schedule(fn, ms) { const key = {}; tasks.set(key, { fn, at: time + ms }); return key; }, clear(key) { tasks.delete(key); } };
  const clock = { now() { return time; } };
  const plugin = { info: { editorType: 'word' },
    // The document identity leg is the bridge's own synchronous callCommand probe: it stays native
    // until its callback is delivered, exactly like the selection read and the insert below.
    callCommand(_body, _close, _recalculate, callback) { identity.push(callback); return false; },
    executeMethod(name, args, callback) {
      if (name === 'GetSelectedText') { selections.push(callback); return false; }
      // The dispatched mutation: the callback is RECORDED and deliberately never delivered, so the
      // ticket settles APPLY_UNCERTAIN rather than a success claim.
      if (name === 'PasteText') { inserts.push({ args, callback }); return false; }
      throw new Error(`unexpected native method ${name}`);
    } };
  const bridge = createR7Bridge(plugin, { editorType: 'word', timers, clock });
  const queue = [JSON.stringify({ type: 'tool_calls', calls: [{ tool: 'insert_paragraph', arguments: { text: 'Новый абзац' } }] }),
    JSON.stringify({ type: 'final', message: 'Готово' })];
  const tree = dom();
  const controller = createController({ bridge, timers, clock, store: new SettingsStore(null),
    crypto: { randomUUID() { return '00000000-0000-4000-8000-000000000001'; } },
    transport: async () => { calls += 1; return { content: queue.shift() }; } });
  controller.saveSettings({ endpoint: 'https://example.invalid/v1/chat/completions', apiKey: 'synthetic' });
  controller.setMode('EDIT');
  const panel = mountPanel(tree.root, controller);
  const operation = controller.analyze('добавь абзац');
  const tick = () => new Promise(resolve => setImmediate(resolve));
  // (1) the controller's own context capture: one selection read and one identity probe.
  assert.equal(selections.length, 1); assert.equal(identity.length, 0);
  selections[0]('контекст запроса'); await tick();
  assert.equal(identity.length, 1);
  identity[0](['bounded-id', true, true, false]); await tick();
  // (2) the model's mutation dispatch: the tool's own identity probe, then the insert itself. The
  // native insert acknowledgement is NEVER delivered.
  assert.equal(inserts.length, 0);
  assert.equal(identity.length, 2, 'the insert runs under its own document identity proof');
  identity[1](['bounded-id', true, true, false]); await tick();
  assert.equal(inserts.length, 1, 'exactly one mutation reached the native editor');
  assert.deepEqual(inserts[0].args, ['Новый абзац'], 'the validated payload crosses unchanged');
  assert.equal(bridge.getState().writePending, true, 'the dispatched mutation is pending');
  // The bridge's own callback deadline is the only thing that can settle a dispatched insert whose
  // native acknowledgement never arrives. The fake clock is advanced past that deadline but stays far
  // inside the controller's operation deadline, so the write settles APPLY_UNCERTAIN by itself.
  time += 5100;
  for (const [key, task] of [...tasks]) if (task.at <= time) { tasks.delete(key); task.fn(); }
  await operation;
  const state = controller.getState();
  // (a) the terminal status is the authored uncertain outcome, never COMPLETE.
  assert.equal(state.status, 'APPLY_UNCERTAIN');
  assert.notEqual(state.status, 'COMPLETE');
  assert.equal(state.agent.status, 'UNCERTAIN');
  assert.match(tree.id('status').textContent, /Исход команды неизвестен/);
  // (b) no second mutation was dispatched, and the loop spent no further step producing refusals.
  assert.equal(calls, 1, 'the run stops on the uncertain action; the second envelope is never requested');
  assert.equal(inserts.length, 1, 'a second native mutation is never dispatched');
  assert.equal(identity.length, 2, 'no further identity probe is made for a stopped run');
  assert.deepEqual(state.agent.actions.map(action => [action.tool, action.outcome, action.code]),
    [['insert_paragraph', 'uncertain', 'TOOL_UNCERTAIN']]);
  assert.equal(state.agent.steps, 1);
  assert.equal(tree.id('actions').textContent, 'insert_paragraph: uncertain (TOOL_UNCERTAIN)');
  // (c) the write lock holds: an unresolved dispatched write keeps the panel write-locked.
  assert.equal(bridge.getState().writePending, true);
  assert.equal(state.writeLocked, true);
  assert.equal(await controller.analyze('второй'), false, 'a write-locked panel refuses a new run');
  assert.equal(inserts.length, 1);
  panel.dispose(); controller.dispose();
});

// The CONTROL leg for the mutation mapping above: the same controller -> runAgent -> registry ->
// real-bridge path, but the native `PasteText` callback IS delivered with a boolean acknowledgement.
// The bridge envelope becomes `{ok:true, data:{sent:true}}`, which `word.js` must publish as an
// ordinary `ok` action, so the run reaches COMPLETE/FINAL with 2 steps and the action outcome `ok` —
// the new uncertain classifier must not have turned every insert into a run-stopping uncertain
// outcome. Once the delivered callback settles the ticket, no write lock may remain held.
test('an acknowledged insert reaches COMPLETE/FINAL with the action ok and no write lock left held', async () => {
  let time = 0; const tasks = new Map(); const selections = []; const identity = []; const inserts = []; let calls = 0;
  const timers = { schedule(fn, ms) { const key = {}; tasks.set(key, { fn, at: time + ms }); return key; }, clear(key) { tasks.delete(key); } };
  const clock = { now() { return time; } };
  const plugin = { info: { editorType: 'word' },
    // The document identity leg is the bridge's own synchronous callCommand probe: it stays native
    // until its callback is delivered, exactly like the selection read and the insert below.
    callCommand(_body, _close, _recalculate, callback) { identity.push(callback); return false; },
    executeMethod(name, args, callback) {
      if (name === 'GetSelectedText') { selections.push(callback); return false; }
      // The dispatched mutation: unlike the uncertain leg above, this callback IS delivered below.
      if (name === 'PasteText') { inserts.push({ args, callback }); return false; }
      throw new Error(`unexpected native method ${name}`);
    } };
  const bridge = createR7Bridge(plugin, { editorType: 'word', timers, clock });
  const queue = [JSON.stringify({ type: 'tool_calls', calls: [{ tool: 'insert_paragraph', arguments: { text: 'Новый абзац' } }] }),
    JSON.stringify({ type: 'final', message: 'Готово' })];
  const tree = dom();
  const controller = createController({ bridge, timers, clock, store: new SettingsStore(null),
    crypto: { randomUUID() { return '00000000-0000-4000-8000-000000000001'; } },
    transport: async () => { calls += 1; return { content: queue.shift() }; } });
  controller.saveSettings({ endpoint: 'https://example.invalid/v1/chat/completions', apiKey: 'synthetic' });
  controller.setMode('EDIT');
  const panel = mountPanel(tree.root, controller);
  const operation = controller.analyze('добавь абзац');
  const tick = () => new Promise(resolve => setImmediate(resolve));
  // (1) the controller's own context capture: one selection read and one identity probe.
  assert.equal(selections.length, 1); assert.equal(identity.length, 0);
  selections[0]('контекст запроса'); await tick();
  assert.equal(identity.length, 1);
  identity[0](['bounded-id', true, true, false]); await tick();
  // (2) the model's mutation dispatch under its own identity proof, then the acknowledgement.
  assert.equal(inserts.length, 0);
  assert.equal(identity.length, 2, 'the insert runs under its own document identity proof');
  identity[1](['bounded-id', true, true, false]); await tick();
  assert.equal(inserts.length, 1, 'exactly one mutation reached the native editor');
  assert.deepEqual(inserts[0].args, ['Новый абзац'], 'the validated payload crosses unchanged');
  inserts[0].callback(true); await tick();
  await operation;
  const state = controller.getState();
  // (a) an acknowledged insert is an ordinary success, never the uncertain outcome.
  assert.equal(state.status, 'COMPLETE');
  assert.equal(state.agent.status, 'FINAL');
  assert.equal(calls, 2, 'the acknowledged insert result feeds a second model step');
  assert.equal(state.agent.steps, 2);
  assert.deepEqual(state.agent.actions.map(action => [action.tool, action.outcome]),
    [['insert_paragraph', 'ok']]);
  assert.equal(tree.id('actions').textContent, 'insert_paragraph: ok');
  // (b) the delivered callback settled the ticket: no pending write and no write lock remains.
  assert.equal(bridge.getState().writePending, false, 'the acknowledged mutation is not left pending');
  assert.equal(state.writeLocked, false, 'a settled insert releases the write lock');
  panel.dispose(); controller.dispose();
});
