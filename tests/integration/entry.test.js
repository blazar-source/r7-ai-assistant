import test from 'node:test';
import assert from 'node:assert/strict';
import { bindPanel } from '../../src/ui/entry.js';
import { dom } from '../fixtures/dom.js';

test('SDK bridge is leased only AFTER init; duplicate init invalidates but never rebinds', () => {
  const tree = dom(); let creates = 0; let changes = 0; let disposed = 0;
  const events = {};
  const plugin = { info: { editorType: 'word' }, attachEvent(name, handler) { events[name] = handler; } };
  const binding = bindPanel(plugin, tree.root, { bridgeFactory(_, options) { creates++; assert.equal(options.editorType, 'word'); return {}; }, controllerFactory() { return { contextChanged() { changes++; }, dispose() { disposed++; } }; }, viewFactory() { return { dispose() {} }; } });
  assert.equal(creates, 0); assert.equal(typeof plugin.init, 'function');
  plugin.init(); assert.equal(creates, 1); plugin.init(); assert.equal(creates, 1); assert.equal(changes, 1);
  assert.equal(typeof events.onTargetPositionChanged, 'function'); events.onTargetPositionChanged(); assert.equal(changes, 2);
  assert.equal(typeof events.onDocumentContentReady, 'function'); events.onDocumentContentReady(); assert.equal(changes, 3);
  binding.dispose(); assert.equal(disposed, 1);
});
test('reinit with a different editor disposes old panel without reusing or recreating its bridge', () => {
  const tree = dom(); let creates = 0; let disposed = 0;
  const plugin = { info: { editorType: 'word' } };
  bindPanel(plugin, tree.root, { bridgeFactory() { creates++; return {}; }, controllerFactory() { return { contextChanged() {}, dispose() { disposed++; } }; }, viewFactory() { return { dispose() {} }; } });
  plugin.init(); plugin.info.editorType = 'cell'; plugin.init();
  assert.equal(creates, 1); assert.equal(disposed, 1); assert.ok(tree.root.textContent.includes('Редактор изменился'));
});
test('unknown editor never inferred from filename or document text; init failure safe and static', () => {
  const tree = dom(); let editor;
  const plugin = { info: { editorType: 'presentation', documentTitle: 'SECRET.docx' } };
  bindPanel(plugin, tree.root, { bridgeFactory(_, options) { editor = options.editorType; throw Error('SECRET'); } });
  assert.equal(typeof plugin.init, 'function');
  plugin.init(); assert.equal(editor, 'unknown'); assert.equal(tree.root.textContent.includes('SECRET'), false);
  assert.ok(tree.root.textContent.length > 0);
});
