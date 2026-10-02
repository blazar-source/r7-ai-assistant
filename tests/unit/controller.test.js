import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../../src/ui/controller.js';
import { SettingsStore } from '../../src/config/storage.js';
import { SafeError } from '../../src/shared/errors.js';

function deferred() { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function setup(options = {}) {
  let time = 100;
  let id = 0;
  const scheduled = new Map();
  const crypto = { randomUUID() { id++; return `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`; } };
  const storage = new Map([['unrelated', 'keep']]);
  const store = new SettingsStore({ getItem(k) { return storage.get(k) ?? null; }, setItem(k,v) { storage.set(k,v); }, removeItem(k) { storage.delete(k); }, get length() { return storage.size; }, key(i) { return [...storage.keys()][i]; } });
  const calls = [];
  const bridge = { getState() { return { editorType: 'word', busy: false, uncertain: false }; }, invalidate() {}, async readSelection() { return { text: 'выделено', editorType: 'word', eligible: false, target: null, reason: 'MUTATION_PROOF_UNRESOLVED' }; }, async applySelection() { throw Error('must never dispatch'); }, ...options.bridge };
  const clock = { now() { return time; } };
  const timers = { schedule(fn,ms) { const token = {}; scheduled.set(token, { fn, at: time + ms }); return token; }, clear(token) { scheduled.delete(token); } };
  const controller = createController({ bridge, store, crypto, clock, timers, transport: async (...args) => { calls.push(args); return options.response ?? { type: 'final', message: 'ответ' }; }, ...options.dependencies });
  controller.saveSettings({ endpoint: 'https://example.invalid/v1/chat/completions', apiKey: 'synthetic' });
  return { controller, calls, bridge, storage, clock, scheduled, advance(ms, fire = true) { time += ms; if (fire) for (const [token, t] of [...scheduled]) if (t.at <= time) { scheduled.delete(token); t.fn(); } } };
}

test('ASK uses fresh bounded selection as untrusted user context and appends a complete pair', async () => {
  const { controller: c, calls } = setup();
  assert.equal(await c.analyze('вопрос'), true);
  assert.equal(c.getState().status, 'COMPLETE');
  assert.equal(c.getState().context.kind, 'EXACT');
  assert.equal(c.getState().context.ownershipVerified, false);
  assert.deepEqual(calls[0][1].slice(-2).map(m => m.content), ['выделено', 'вопрос']);
  assert.equal(calls[0][1][0].content.includes('выделено'), false);
  assert.deepEqual(c.getState().chat.history.map(m => m.content), ['вопрос', 'ответ']);
  assert.equal(c.getState().preview, null);
});
test('EDIT creates immutable explicit preview; production Apply always denied without dispatch', async () => {
  const { controller: c } = setup({ response: { type: 'tool', tool: 'r7_replace_selection', arguments: { text: 'замена' } } });
  c.setMode('EDIT');
  await c.analyze('исправить');
  const preview = c.getState().preview;
  assert.ok(preview && Object.isFrozen(preview) && Object.isFrozen(preview.settings));
  assert.equal(preview.replacement, 'замена');
  assert.equal(preview.target, null);
  assert.equal(c.getState().canApply, false);
  assert.equal(await c.apply(), false);
  assert.equal(c.getState().status, 'CAPABILITY_UNAVAILABLE');
  c.cancelPreview();
  assert.equal(c.getState().preview, null);
});
test('preview expires at exactly 120000 milliseconds', async () => {
  const { controller: c, advance } = setup({ response: { type: 'tool', tool: 'r7_replace_selection', arguments: { text: '' } } });
  c.setMode('EDIT'); await c.analyze('delete');
  advance(119999); assert.ok(c.getState().preview);
  advance(1); assert.equal(c.getState().preview, null); assert.equal(c.getState().status, 'PREVIEW_EXPIRED');
});
test('Apply checks preview deadline even without timer task delivery', async () => {
  const { controller: c, advance } = setup({ response: { type: 'tool', tool: 'r7_replace_selection', arguments: { text: 'proposal' } } });
  c.setMode('EDIT'); await c.analyze('edit'); advance(120000, false);
  assert.ok(c.getState().preview); assert.equal(await c.apply(), false); assert.equal(c.getState().preview, null);
  assert.equal(c.getState().status, 'PREVIEW_EXPIRED');
});
for (const change of ['stop', 'newChat', 'reset', 'settings', 'editor', 'document', 'selection', 'mode', 'context']) {
  test(`${change} clears an already published uncommitted preview`, async () => {
    const { controller: c } = setup({ response: { type: 'tool', tool: 'r7_replace_selection', arguments: { text: 'proposal' } } });
    c.setMode('EDIT'); await c.analyze('edit'); assert.ok(c.getState().preview);
    if (change === 'settings') c.settingsChanged();
    else if (change === 'mode') c.setMode('ASK');
    else if (change === 'context') c.setIncludeContext(false);
    else if (['editor','document','selection'].includes(change)) c.contextChanged(change);
    else c[change]();
    assert.equal(c.getState().preview, null); assert.equal(c.getState().canApply, false);
  });
}
test('New chat rotates UUID and clears history only, keeping settings/mode/context preference', async () => {
  const { controller: c } = setup();
  c.setIncludeContext(false); c.setMode('EDIT'); await c.analyze('question');
  const before = c.getState(); c.newChat(); const after = c.getState();
  assert.notEqual(after.chat.uuid, before.chat.uuid);
  assert.equal(after.chat.history.length, 0);
  assert.deepEqual(after.settings, before.settings);
  assert.equal(after.mode, 'EDIT'); assert.equal(after.includeContext, false);
});
test('connection test owns temporary UUID, ASK schema and no selection/chat/history mutation', async () => {
  const { controller: c, calls } = setup({ bridge: { async readSelection() { throw Error('must not read'); } } });
  const uuid = c.getState().chat.uuid;
  assert.equal(await c.testConnection(), true);
  assert.notEqual(calls[0][2], uuid);
  assert.equal(calls[0][3].mode, 'ASK');
  assert.equal(c.getState().chat.uuid, uuid); assert.equal(c.getState().chat.history.length, 0);
  assert.equal(c.getState().status, 'CONNECTION_OK');
});
for (const change of ['stop', 'newChat', 'reset', 'settings', 'editor', 'document', 'selection', 'mode', 'context']) {
  test(`${change} invalidates late HTTP result and uncommitted preview/status/history`, async () => {
    const waiting = deferred();
    const { controller: c } = setup({ dependencies: { transport() { return waiting.promise; } } });
    c.setIncludeContext(false);
    const operation = c.analyze('old');
    await Promise.resolve();
    assert.equal(c.getState().active, true);
    if (change === 'settings') c.settingsChanged();
    else if (change === 'mode') c.setMode('EDIT');
    else if (change === 'context') c.setIncludeContext(true);
    else if (['editor','document','selection'].includes(change)) c.contextChanged(change);
    else c[change]();
    const state = c.getState();
    waiting.resolve({ type: 'final', message: 'late' }); await operation;
    assert.equal(c.getState().status, state.status);
    assert.equal(c.getState().chat.history.length, 0);
    assert.equal(c.getState().preview, null);
    assert.equal(c.getState().active, false);
  });
}
test('one active operation rejects overlap without replacing current ownership', async () => {
  const pending = deferred(); const { controller: c } = setup({ dependencies: { transport() { return pending.promise; } } });
  c.setIncludeContext(false); const first = c.analyze('first');
  assert.equal(await c.testConnection(), false);
  pending.resolve({ type: 'final', message: 'first answer' }); assert.equal(await first, true);
  assert.deepEqual(c.getState().chat.history.map(m => m.content), ['first', 'first answer']);
});
test('absolute deadline starts BEFORE context read; expired editor result never reaches HTTP', async () => {
  const pending = deferred(); const { controller: c, advance, calls } = setup({ bridge: { readSelection() { return pending.promise; } } });
  const operation = c.analyze('question'); advance(150000);
  pending.resolve({ text: 'late', editorType: 'word', eligible: false, target: null }); await operation;
  assert.equal(calls.length, 0); assert.equal(c.getState().status, 'TIMEOUT');
});
test('transport receives original operation deadline after time spent reading context', async () => {
  const pending = deferred(); const { controller: c, advance, calls } = setup({ bridge: { readSelection() { return pending.promise; } } });
  const operation = c.analyze('question'); advance(4000);
  pending.resolve({ text: 'selection', editorType: 'word', eligible: false, target: null }); await operation;
  assert.equal(calls.length, 1);
  assert.equal(calls[0][3].deadline, 150100);
  assert.ok(Object.isFrozen(calls[0][0]) && Object.isFrozen(calls[0][1]));
});
test('unknown/unavailable/empty/exact context is explicit; no cell/slide speculative read', async () => {
  const { controller: c } = setup({ bridge: { getState() { return { editorType: 'cell', busy: false, uncertain: false }; }, readSelection() { throw Error('must not call'); } } });
  assert.equal(c.getState().context.kind, 'UNKNOWN'); await c.refreshContext();
  assert.equal(c.getState().context.kind, 'UNAVAILABLE');
  assert.equal(await c.analyze('q'), false);
  c.setIncludeContext(false); assert.equal(await c.analyze('q'), true);
  const empty = setup({ bridge: { async readSelection() { return { text: '', editorType: 'word', eligible: false, target: null }; } } }).controller;
  await empty.refreshContext(); assert.equal(empty.getState().context.kind, 'EMPTY');
});
test('rejects UTF8 user/selection overflow without truncation or HTTP', async () => {
  const normal = setup(); await normal.controller.analyze('я'.repeat(4096) + 'x'); assert.equal(normal.calls.length, 0); assert.equal(normal.controller.getState().status, 'BYTE_LIMIT');
  const oversized = setup({ bridge: { async readSelection() { return { text: 'я'.repeat(4096) + 'x', editorType: 'word', eligible: false, target: null }; } } });
  await oversized.controller.analyze('q'); assert.equal(oversized.calls.length, 0); assert.equal(oversized.controller.getState().status, 'BYTE_LIMIT');
});
test('raw errors remain content-free and storage risk is independent of rememberKey', async () => {
  const { controller: c } = setup({ dependencies: { transport() { throw Error('SECRET endpoint'); } } });
  c.setIncludeContext(false); await c.analyze('q'); assert.equal(c.getState().status, 'INTERNAL_ERROR');
  const store = { load() { return { settings: { apiKey: '', rememberKey: false }, keyPersistenceWarning: true, storageError: null }; }, save() { return this.load(); }, reset() { return this.load(); } };
  const risky = setup({ dependencies: { store } }).controller;
  assert.equal(risky.getState().keyPersistenceWarning, true);
});
test('reset removes only settings namespace and restores ephemeral defaults', async () => {
  const { controller: c, storage } = setup(); c.reset();
  assert.equal(storage.get('unrelated'), 'keep'); assert.equal(storage.size, 1);
  assert.equal(c.getState().settings.apiKey, ''); assert.equal(c.getState().settings.endpoint, '');
});
test('timer setup failure remains recoverable rather than stranding active owner', async () => {
  const timers = { schedule() { throw Error('failure'); }, clear() {} };
  const { controller: c } = setup({ dependencies: { timers } }); c.setIncludeContext(false);
  assert.equal(await c.analyze('q'), false); assert.equal(c.getState().active, false);
  assert.equal(c.getState().status, 'INTERNAL_ERROR');
});
test('deadline recheck BEFORE final commit prevents history/preview publication', async () => {
  let reads = 0;
  const clock = { now() { reads++; return reads < 4 ? 0 : 150000; } };
  const { controller: c } = setup({ dependencies: { clock } }); c.setIncludeContext(false);
  assert.equal(await c.analyze('q'), false);
  assert.equal(c.getState().status, 'TIMEOUT'); assert.equal(c.getState().chat.history.length, 0); assert.equal(c.getState().preview, null);
});
test('SDK busy/uncertain prevents second read without recreating or clearing bridge', async () => {
  const { controller: c, calls } = setup({ bridge: { getState() { return { editorType: 'word', busy: true, uncertain: true }; }, readSelection() { throw new SafeError('EDITOR_BUSY'); } } });
  assert.equal(await c.analyze('q'), false); assert.equal(c.getState().status, 'EDITOR_BUSY'); assert.equal(calls.length, 0);
});
