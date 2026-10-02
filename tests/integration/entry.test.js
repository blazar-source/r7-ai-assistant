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

// Removing any independent cleanup attempt strands a resource when its predecessor throws.
for (const route of ['dispose', 'editor change']) {
  for (const throwingStep of ['onTargetPositionChanged', 'onDocumentContentReady', 'view', 'controller', 'bridge']) {
    test(`${route} completes independent cleanup when ${throwingStep} throws`, () => {
      const tree = dom(); const attempts = []; const events = {};
      let creates = 0; let changes = 0;
      function cleanup(step) { attempts.push(step); if (step === throwingStep) throw Error('FIXTURE_SECRET'); }
      const plugin = {
        info: { editorType: 'word' },
        attachEvent(name, handler) { events[name] = handler; },
        detachEvent(name) { cleanup(name); }
      };
      const binding = bindPanel(plugin, tree.root, {
        bridgeFactory() { creates++; return { dispose() { cleanup('bridge'); } }; },
        controllerFactory() { return { contextChanged() { changes++; }, dispose() { cleanup('controller'); } }; },
        viewFactory() { return { dispose() { cleanup('view'); } }; }
      });
      plugin.init();
      if (route === 'editor change') plugin.info.editorType = 'cell';
      assert.doesNotThrow(() => route === 'dispose' ? binding.dispose() : plugin.init());
      assert.deepEqual(attempts, ['onTargetPositionChanged', 'onDocumentContentReady', 'view', 'controller', 'bridge']);
      if (route === 'editor change') assert.ok(tree.root.textContent.includes('Редактор изменился'));
      assert.equal(tree.root.textContent.includes('FIXTURE_SECRET'), false);
      const notice = tree.root.textContent;
      events.onTargetPositionChanged(); events.onDocumentContentReady();
      plugin.init(); binding.dispose();
      assert.equal(creates, 1); assert.equal(changes, 0);
      assert.equal(attempts.length, 5); assert.equal(tree.root.textContent, notice);
    });
  }
}

for (const failingStage of ['view', 'onTargetPositionChanged', 'onDocumentContentReady']) {
  test(`initialization failure at ${failingStage} disposes acquired resources and stays terminal`, () => {
    const tree = dom(); const attempts = []; const events = {};
    let creates = 0; let changes = 0;
    const plugin = {
      info: { editorType: 'word' },
      attachEvent(name, handler) { events[name] = handler; if (name === failingStage) throw Error('FIXTURE_SECRET'); },
      detachEvent(name) { attempts.push(name); throw Error('FIXTURE_SECRET'); }
    };
    const binding = bindPanel(plugin, tree.root, {
      bridgeFactory() { creates++; return { dispose() { attempts.push('bridge'); } }; },
      controllerFactory() { return { contextChanged() { changes++; }, dispose() { attempts.push('controller'); } }; },
      viewFactory() {
        if (failingStage === 'view') throw Error('FIXTURE_SECRET');
        return { dispose() { attempts.push('view'); throw Error('FIXTURE_SECRET'); } };
      }
    });
    assert.doesNotThrow(() => plugin.init());
    assert.deepEqual(attempts, failingStage === 'view'
      ? ['onTargetPositionChanged', 'onDocumentContentReady', 'controller', 'bridge']
      : ['onTargetPositionChanged', 'onDocumentContentReady', 'view', 'controller', 'bridge']);
    assert.ok(tree.root.textContent.includes('Панель недоступна'));
    assert.equal(tree.root.textContent.includes('FIXTURE_SECRET'), false);
    const notice = tree.root.textContent;
    for (const handler of Object.values(events)) handler();
    plugin.init(); plugin.info.editorType = 'slide'; plugin.init(); binding.dispose();
    assert.equal(creates, 1); assert.equal(changes, 0); assert.equal(tree.root.textContent, notice);
    assert.equal(attempts.length, failingStage === 'view' ? 4 : 5);
  });
}

test('controller factory failure disposes its already acquired bridge even when cleanup throws', () => {
  const tree = dom(); let creates = 0; let bridgeDisposals = 0; let controllerCreates = 0;
  const plugin = { info: { editorType: 'word' } };
  const binding = bindPanel(plugin, tree.root, {
    bridgeFactory() { creates++; return { dispose() { bridgeDisposals++; throw Error('FIXTURE_SECRET'); } }; },
    controllerFactory() { controllerCreates++; throw Error('FIXTURE_SECRET'); },
    viewFactory() { assert.fail('view must not mount after controller creation failed'); }
  });
  assert.doesNotThrow(() => plugin.init());
  assert.equal(bridgeDisposals, 1);
  assert.ok(tree.root.textContent.includes('Панель недоступна'));
  assert.equal(tree.root.textContent.includes('FIXTURE_SECRET'), false);
  const notice = tree.root.textContent;
  plugin.init(); plugin.info.editorType = 'cell'; plugin.init(); binding.dispose();
  assert.equal(creates, 1); assert.equal(controllerCreates, 1); assert.equal(bridgeDisposals, 1);
  assert.equal(tree.root.textContent, notice);
});
