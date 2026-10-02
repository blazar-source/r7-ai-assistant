import test from 'node:test';
import assert from 'node:assert/strict';
import { mountPanel, statusText } from '../../src/ui/view.js';
import { createController } from '../../src/ui/controller.js';
import { SettingsStore } from '../../src/config/storage.js';
import { dom } from '../fixtures/dom.js';

function fixture(response = { type: 'final', message: '<img src=x onerror=alert(1)> **not markdown**' }) {
  const tree = dom();
  const controller = createController({ store: new SettingsStore(null), crypto: { randomUUID() { return '00000000-0000-4000-8000-000000000001'; } }, bridge: { getState() { return { editorType: 'word', busy: false, uncertain: false }; }, invalidate() {}, async readSelection() { return { text: '<script>inert</script>', editorType: 'word', eligible: false, target: null }; } }, transport: async () => response });
  controller.saveSettings({ endpoint: 'https://example.invalid/v1/chat/completions', apiKey: 'synthetic' });
  const panel = mountPanel(tree.root, controller);
  assert.ok(tree.id('prompt'), 'mounted composer');
  return { ...tree, controller, panel };
}
test('BYTE_LIMIT status caption covers input, selection and response without implying truncation', () => {
  assert.equal(statusText('BYTE_LIMIT'), 'Превышен лимит UTF-8 для ввода, выделения или ответа; текст не обрезается.');
});
test('view supplies semantic labeled editable connection controls and masked key', () => {
  const { all, id, controller } = fixture();
  for (const name of ['endpoint','model','apiKey','httpTimeoutSeconds','maxTokens','temperature','rememberKey']) {
    const control = id(name); assert.ok(control, name);
    assert.equal(control.disabled, false);
    assert.ok(all().some(node => node.tagName === 'LABEL' && node.htmlFor === name));
  }
  assert.equal(id('apiKey').type, 'password');
  assert.equal(id('temperature').step, 'any');
  assert.equal(id('status').getAttribute('aria-live'), 'polite');
  assert.equal(id('plaintext-warning').hidden, false);
  assert.equal(id('persistence-warning').hidden, false);
  assert.equal(controller.getState().settings.rememberKey, false);
  assert.equal(id('apply').disabled, true);
});
test('model/document text remains literal DOM text, never HTML or markdown', async () => {
  const { id, controller, all } = fixture(); await controller.analyze('question');
  assert.ok(id('history').textContent.includes('<img src=x onerror=alert(1)> **not markdown**'));
  assert.ok(id('selected-text').textContent.includes('<script>inert</script>'));
  assert.equal(all().some(node => ['IMG','SCRIPT'].includes(node.tagName)), false);
  controller.dispose();
});
test('settings edits invalidate immediately without overwriting focused drafts on status updates', () => {
  const { id, controller, document } = fixture(); const model = id('model');
  model.focus(); model.value = 'draft'; model.dispatch('input');
  assert.equal(controller.getState().status, 'SETTINGS_CHANGED');
  controller.contextChanged();
  assert.equal(model.value, 'draft'); assert.equal(document.activeElement, model);
  id('settings-form').dispatch('submit');
  assert.equal(controller.getState().settings.model, 'draft');
  controller.dispose();
});
test('keyboard submit reaches controller and preview cancellation restores composer focus', async () => {
  const { id, controller, document } = fixture({ type: 'tool', tool: 'r7_replace_selection', arguments: { text: 'proposal' } });
  id('mode').value = 'EDIT'; id('mode').dispatch('change');
  id('prompt').value = 'edit'; id('prompt').dispatch('keydown', { key: 'Enter', ctrlKey: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.getState().status, 'PREVIEW_READY'); assert.equal(id('preview').hidden, false);
  assert.equal(id('replacement').textContent, 'proposal'); assert.equal(id('apply').disabled, true);
  id('cancel-preview').dispatch('click');
  assert.equal(controller.getState().preview, null); assert.equal(document.activeElement, id('prompt'));
  controller.dispose();
});
test('repeated keyboard submit cannot invalidate and supersede the active operation', async () => {
  let resolve; const pending = new Promise(done => { resolve = done; });
  const { id, controller } = fixture(pending);
  id('prompt').value = 'first'; id('prompt').dispatch('keydown', { key: 'Enter', ctrlKey: true });
  await Promise.resolve(); const before = controller.getState(); assert.equal(before.active, true);
  id('prompt').value = 'second'; id('prompt').dispatch('keydown', { key: 'Enter', ctrlKey: true });
  const after = controller.getState();
  resolve({ type: 'final', message: 'answer' }); await new Promise(done => setImmediate(done));
  const history = controller.getState().chat.history; controller.dispose();
  assert.equal(after.generation, before.generation);
  assert.equal(history[0].content, 'first');
});
test('view uses same complete edited settings for connection action and displays safe errors', async () => {
  const { id, controller } = fixture();
  id('endpoint').value = 'http://invalid'; id('endpoint').dispatch('input'); id('test-connection').dispatch('click');
  await Promise.resolve(); assert.equal(controller.getState().status, 'INVALID_ENDPOINT');
  assert.equal(id('status').textContent.includes('http://invalid'), false);
  controller.dispose();
});
