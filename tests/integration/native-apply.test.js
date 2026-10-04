import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeRig, checkpoint } from '../fixtures/native-sdk.js';
import { createR7Bridge } from '../../src/plugin/bridge.js';

// Break caught: blanket denial or any native mutation before explicit Apply.
// The blank case uses a one-character replacement: the confirm tool's schema requires a non-empty
// `text`, so an empty proposal is a known protocol error and can never publish a Preview at all.
for (const replacement of ['short', 'long '.repeat(200), 'x', 'line1\nline2\t<script>data</script>']) test(`explicit Apply writes exact bounded data once (${replacement.length} chars), receipt is not effect proof`, async () => {
  const f = nativeRig({ replacement }); await f.preview();
  assert.equal(f.writes().length, 0); assert.equal(f.controller.getState().canApply, true); assert.equal(f.id('apply').disabled, false);
  const history = f.controller.getState().chat;
  assert.equal(await f.controller.apply(), true);
  assert.deepEqual(f.writes().map(call => call.params), [[[replacement], '\t', '\n']]);
  assert.deepEqual(f.calls.map(call => call.name), ['GetSelectedText', 'context', 'context', 'GetSelectedText', 'context', 'ReplaceTextSmart']);
  assert.equal(f.controller.getState().status, 'APPLY_ACKNOWLEDGED');
  assert.equal(f.controller.getState().preview, null); assert.equal(f.controller.getState().chat, history);
  assert.match(f.id('status').textContent, /не подтверждает|не доказан/); assert.doesNotMatch(f.id('status').textContent, /Документ изменён/);
  assert.equal(await f.controller.apply(), false); assert.equal(f.writes().length, 1); f.close();
});

// Break caught: leaked IDs/tokens, or trusting serializable equal-ID fake certificates.
test('private brand rejects foreign equal-ID and serialized/copied targets; UI/model/snapshots do not expose IDs or capability', async () => {
  const a = nativeRig(); const b = nativeRig();
  const captured = await a.bridge.readSelection(); assert.equal(captured.eligible, true); assert.ok(captured.target);
  const before = b.calls.length;
  for (const target of [captured.target, JSON.parse(JSON.stringify(captured.target)), { editor: 'word', id: a.state.id }, null]) {
    await assert.rejects(b.bridge.applySelection({ target, replacement: 'changed' }), { code: 'SELECTION_CHANGED' });
  }
  assert.equal(b.calls.length, before); assert.equal(b.writes().length, 0);
  await a.preview();
  const serialized = JSON.stringify(a.controller.getState());
  assert.equal(serialized.includes(a.state.id), false); assert.equal('target' in a.controller.getState().preview, false);
  assert.equal(a.root.textContent.includes(a.state.id), false); assert.equal(JSON.stringify(a.http).includes(a.state.id), false);
  a.close(); b.close();
});

// Break caught: stale/current-ID/editor/tracking or changed/empty selection accepted.
for (const [label, change] of [
  ['changed text', f => { f.state.text = 'different'; }], ['empty text', f => { f.state.text = ''; }],
  ['changed ID', f => { f.state.id = 'OTHER-ID'; }], ['changed editor', f => { f.plugin.info.editorType = 'cell'; }],
  ['unknown editor', f => { f.plugin.info.editorType = 'not-an-editor'; }],
  ['tracking active', f => { f.state.tracking = true; }], ['tracking unknown', f => { f.state.tracking = null; }],
  ['range unsupported', f => { f.state.contextOverride = [f.state.id, true, false, false]; }]
]) test(`Apply refuses ${label} with exact retry caption and no write`, async () => {
  const f = nativeRig(); await f.preview(); change(f);
  assert.equal(await f.controller.apply(), false); assert.equal(f.writes().length, 0);
  assert.equal(f.controller.getState().status, 'SELECTION_CHANGED');
  assert.equal(f.id('status').textContent, 'Выделение изменилось. Повторите команду');
  assert.equal(f.controller.getState().preview, null); f.close();
});
for (const tracking of [true, null, undefined, 'false']) test(`fresh read refuses tracking=${String(tracking)} without model/preview`, async () => {
  const f = nativeRig(); f.state.tracking = tracking;
  assert.equal(await f.controller.analyze('edit'), false); assert.equal(f.http.length, 0); assert.equal(f.writes().length, 0);
  assert.equal(f.controller.getState().preview, null); f.close();
});

test('identical relocation, movement event and same-editor init preserve unexpired Preview and then allow exact reread', async () => {
  const f = nativeRig(); await f.preview(); const preview = f.controller.getState().preview;
  f.events.onTargetPositionChanged(); f.plugin.init();
  assert.equal(f.controller.getState().preview, preview); assert.equal(f.controller.getState().canApply, true);
  assert.equal(await f.controller.apply(), true); assert.equal(f.writes().length, 1); f.close();
});
test('genuine document-content context change invalidates token; changed editor init disposes without rebind', async () => {
  const f = nativeRig(); const capture = await f.bridge.readSelection(); await f.preview();
  f.events.onDocumentContentReady(); assert.equal(f.controller.getState().preview, null);
  await assert.rejects(f.bridge.applySelection({ target: capture.target, replacement: 'x' }), { code: 'SELECTION_CHANGED' });
  f.plugin.info.editorType = 'slide'; f.plugin.init(); assert.equal(f.bridge.getState().disposed, true);
  assert.throws(() => createR7Bridge(f.plugin, { editorType: 'word' }), { code: 'EDITOR_BUSY' });
  assert.equal(f.writes().length, 0); f.close();
});

for (const options of [{ mode: 'ASK' }, { include: false }]) test(`no writable Preview without eligible EDIT capture: ${JSON.stringify(options)}`, async () => {
  const f = nativeRig(options); await f.controller.analyze('request');
  assert.equal(f.controller.getState().canApply, false); assert.equal(await f.controller.apply(), false); assert.equal(f.writes().length, 0); f.close();
});
test('empty original cannot create a writable Preview; UTF8 overflow never reaches native write', async () => {
  const f = nativeRig(); f.state.text = ''; await f.controller.analyze('request');
  assert.equal(f.controller.getState().canApply, false); assert.equal(await f.controller.apply(), false); assert.equal(f.writes().length, 0); f.close();
  const g = nativeRig({ replacement: 'я'.repeat(4096) + 'x', script: (() => { let step = 0; return () => (++step === 1 ? null : { type: 'final', message: 'стоп' }); })() });
  assert.equal(await g.controller.analyze('request'), true);
  // The oversized argument is refused BEFORE the executor: the proposal never becomes a tool call
  // (the run's own argument budget rejects it), so nothing is dispatched and no Preview exists.
  assert.deepEqual(g.controller.getState().agent.actions, []);
  assert.equal(g.controller.getState().agent.toolCalls, 0);
  assert.equal(g.controller.getState().status, 'COMPLETE');
  assert.equal(g.controller.getState().preview, null); assert.equal(g.writes().length, 0); g.close();
});
test('TTL is authoritative before and during revalidation with no timer delivery', async () => {
  const f = nativeRig(); await f.preview(); f.advance(120000, false);
  assert.equal(await f.controller.apply(), false); assert.equal(f.controller.getState().status, 'PREVIEW_EXPIRED'); assert.equal(f.writes().length, 0); f.close();
  const g = nativeRig(); await g.preview(); g.advance(119999, false); g.state.auto = false;
  const operation = g.controller.apply(); const call = g.calls.at(-1); assert.equal(call.name, 'context'); g.advance(1, false); call.callback(call.value);
  await checkpoint(); assert.equal(await operation, false); assert.equal(g.writes().length, 0); g.close();
});

for (const stopAt of ['context', 'selection', 'final context']) test(`Stop during ${stopAt} revalidation prevents dispatch and retains callback ownership`, async () => {
  const f = nativeRig(); await f.preview(); f.state.auto = false; const operation = f.controller.apply();
  if (stopAt !== 'context') { const c = f.calls.at(-1); c.callback(c.value); await checkpoint(); }
  if (stopAt === 'final context') { const c = f.calls.at(-1); c.callback(c.value); await checkpoint(); }
  const pending = f.calls.at(-1); f.controller.stop(); assert.equal(await operation, false);
  assert.equal(f.bridge.getState().busy, true); assert.equal(f.bridge.getState().uncertain, true); assert.equal(f.writes().length, 0);
  const before = f.controller.getState(); pending.callback(pending.value); await checkpoint();
  assert.equal(f.bridge.getState().busy, false); assert.equal(f.controller.getState().chat, before.chat); assert.equal(f.controller.getState().status, before.status);
  assert.equal(f.writes().length, 0); f.close();
});

async function dispatchWrite(f) {
  await f.preview(); f.state.auto = false; const operation = f.controller.apply();
  for (let step = 0; step < 3; step++) { const call = f.calls.at(-1); call.callback(call.value); await checkpoint(); }
  assert.equal(f.writes().length, 1); return { operation };
}
for (const receipt of [true, false, undefined, { text: 'private' }]) test(`settled write callback ${String(receipt)} never claims edit or permits retry of consumed Preview`, async () => {
  const f = nativeRig(); const { operation } = await dispatchWrite(f); const write = f.writes()[0]; write.callback(receipt);
  const result = await operation; assert.equal(result, receipt === true);
  assert.equal(f.controller.getState().status, receipt === true ? 'APPLY_ACKNOWLEDGED' : 'APPLY_UNCERTAIN');
  assert.equal(f.bridge.getState().busy, false); assert.equal(f.controller.getState().writeLocked, false);
  assert.equal(await f.controller.apply(), false); assert.equal(f.writes().length, 1); assert.equal(f.controller.getState().preview, null); f.close();
});
test('after dispatch conflicting controller/UI controls are disabled; timeout stays locked until real late callback without state resurrection', async () => {
  const f = nativeRig(); const { operation } = await dispatchWrite(f); const write = f.writes()[0]; const before = f.controller.getState();
  assert.equal(before.writeLocked, true); assert.equal(before.status, 'APPLYING');
  for (const id of ['stop', 'new-chat', 'reset', 'save-settings', 'test-connection', 'mode', 'include-context', 'endpoint', 'send', 'cancel-preview']) assert.equal(f.id(id).disabled, true, id);
  for (const action of [() => f.controller.stop(), () => f.controller.newChat(), () => f.controller.reset(), () => f.controller.settingsChanged(), () => f.controller.saveSettings({}), () => f.controller.setMode('ASK'), () => f.controller.setIncludeContext(false)]) action();
  assert.equal(f.controller.getState().generation, before.generation); assert.equal(f.controller.getState().chat, before.chat);
  f.advance(5000); assert.equal(await operation, false); assert.equal(f.controller.getState().status, 'APPLY_UNCERTAIN');
  assert.equal(f.controller.getState().writeLocked, true); assert.equal(await f.controller.checkR7(), false); assert.equal(await f.controller.analyze('retry'), false);
  const expired = f.controller.getState(); write.callback(true); await checkpoint();
  assert.equal(f.bridge.getState().busy, false); assert.equal(f.controller.getState().writeLocked, false);
  assert.equal(f.controller.getState().status, expired.status); assert.equal(f.controller.getState().chat, expired.chat); assert.equal(f.controller.getState().preview, null);
  assert.equal(f.id('new-chat').disabled, false); assert.equal(f.id('apply').disabled, true); f.close();
});
test('SDK exception after attempted write reports unknown outcome without claiming command delivery', async () => {
  const f = nativeRig(); await f.preview(); f.state.auto = false;
  const operation = f.controller.apply();
  for (let step = 0; step < 2; step++) { f.calls.at(-1).callback(f.calls.at(-1).value); await checkpoint(); }
  f.state.throwWrite = true; f.calls.at(-1).callback(f.calls.at(-1).value); await checkpoint();
  assert.equal(await operation, false); assert.equal(f.controller.getState().status, 'APPLY_UNCERTAIN'); assert.equal(f.controller.getState().writeLocked, true);
  assert.doesNotMatch(f.id('status').textContent, /Команда отправлена|Документ изменён/);
  f.writes()[0].callback(false); f.close();
});
test('15s observation deadline prevents dispatch even if callback timers never run', async () => {
  const f = nativeRig(); await f.preview(); f.state.auto = false; const operation = f.controller.apply();
  f.advance(15000, false); const callback = f.calls.at(-1); callback.callback(callback.value);
  await checkpoint(); assert.equal(await operation, false); assert.equal(f.writes().length, 0); f.close();
});
test('dispose after native dispatch retains slot/lease and discards late/duplicate result', async () => {
  const f = nativeRig(); const { operation } = await dispatchWrite(f); const write = f.writes()[0]; f.close();
  assert.equal(await operation, false); assert.equal(f.bridge.getState().busy, true);
  assert.throws(() => createR7Bridge(f.plugin, { editorType: 'word' }), { code: 'EDITOR_BUSY' });
  const before = f.controller.getState(); write.callback(true); write.callback(true); await checkpoint();
  assert.equal(f.bridge.getState().busy, false); assert.equal(f.controller.getState().chat, before.chat); assert.equal(f.controller.getState().preview, null); assert.equal(f.writes().length, 1);
});
test('Preview TTL starts at proposal publication, not at earlier native selection capture', async () => {
  const f = nativeRig(); let resolve; f.state.waitModel = new Promise(done => { resolve = done; });
  const analysis = f.controller.analyze('edit'); await checkpoint(); assert.equal(f.http.length, 1);
  f.advance(60000); resolve(); assert.equal(await analysis, true); assert.equal(f.controller.getState().preview.expiresAt, 180000);
  f.advance(119999); assert.equal(f.controller.getState().canApply, true); assert.equal(await f.controller.apply(), true); assert.equal(f.writes().length, 1); f.close();
});
test('movement cancels pending analysis and late model proposal cannot resurrect Preview/history', async () => {
  const f = nativeRig(); let resolve; f.state.waitModel = new Promise(done => { resolve = done; });
  const analysis = f.controller.analyze('edit'); await checkpoint(); f.events.onTargetPositionChanged();
  const before = f.controller.getState(); resolve(); assert.equal(await analysis, false);
  assert.equal(f.controller.getState().chat, before.chat); assert.equal(f.controller.getState().preview, null); assert.equal(f.writes().length, 0); f.close();
});
test('same-editor init alone preserves an in-flight analysis in its original bridge', async () => {
  const f = nativeRig(); let resolve; f.state.waitModel = new Promise(done => { resolve = done; });
  const analysis = f.controller.analyze('edit'); await checkpoint(); const before = f.controller.getState(); f.plugin.init();
  assert.equal(f.controller.getState().generation, before.generation); resolve(); assert.equal(await analysis, true); assert.equal(f.controller.getState().canApply, true); f.close();
});
test('duplicate old read callback cannot steal a pending native write slot', async () => {
  const f = nativeRig(); const { operation } = await dispatchWrite(f); const write = f.writes()[0];
  for (const call of f.calls.filter(call => call !== write)) call.callback(call.value);
  assert.equal(f.bridge.getState().busy, true); assert.equal(f.controller.getState().status, 'APPLYING');
  write.callback(true); assert.equal(await operation, true); f.close();
});
