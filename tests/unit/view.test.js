import test from 'node:test';
import assert from 'node:assert/strict';
import { mountPanel, statusText } from '../../src/ui/view.js';
import { createController } from '../../src/ui/controller.js';
import { SettingsStore } from '../../src/config/storage.js';
import { SafeError } from '../../src/shared/errors.js';
import { dom } from '../fixtures/dom.js';

const final = (message) => JSON.stringify({ type: 'final', message });
const toolCalls = (...tools) => JSON.stringify({ type: 'tool_calls', calls: tools.map(([tool, args]) => ({ tool, arguments: args })) });
const injected = (reply) => ({ content: typeof reply === 'string' ? reply : JSON.stringify(reply) });

// The controller's transport receives (settings, messages, uuid, options); the Agent Runtime's own
// raw envelope is a string in `content`. A bare string is passed through untouched and anything else
// is wrapped, so both the raw and the parsed Sprint 1 style of fixture work here.
function fixture(response = final('<img src=x onerror=alert(1)> **not markdown**'), options = {}) {
  const tree = dom(); const target = Object.freeze({}); const replies = [];
  const scripted = Array.isArray(response) ? response : () => response;
  const transport = async (...args) => {
    replies.push(args);
    const reply = typeof scripted === 'function' ? scripted(...args) : scripted.shift();
    return typeof reply === 'string' ? injected(reply) : reply;
  };
  const bridge = { getState() { return { editorType: 'word', busy: false, uncertain: false }; }, invalidate() {}, canApply(value) { return value === target; },
    async readSelection() { return { text: '<script>inert</script>', editorType: 'word', eligible: true, target }; },
    async insertParagraph() { return { ok: true, data: { sent: true } }; }, ...options.bridge };
  const controller = createController({ store: new SettingsStore(null), crypto: { randomUUID() { return '00000000-0000-4000-8000-000000000001'; } },
    bridge, transport });
  controller.saveSettings({ endpoint: 'https://example.invalid/v1/chat/completions', apiKey: 'synthetic' });
  const panel = mountPanel(tree.root, controller);
  assert.ok(tree.id('prompt'), 'mounted composer');
  return { ...tree, controller, panel, replies, transport };
}
test('BYTE_LIMIT status caption covers input, selection and response without implying truncation', () => {
  assert.equal(statusText('BYTE_LIMIT'), 'Превышен лимит UTF-8 для ввода, выделения или ответа; текст не обрезается.');
});
test('LIMIT status caption states the run ceiling without claiming the task completed', () => {
  assert.match(statusText('AGENT_LIMIT'), /предел/);
  assert.match(statusText('AGENT_LIMIT'), /неполный/);
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
  const { id, controller, document } = fixture(toolCalls(['replace_selection', { text: 'proposal' }]));
  id('mode').value = 'EDIT'; id('mode').dispatch('change');
  id('prompt').value = 'edit'; id('prompt').dispatch('keydown', { key: 'Enter', ctrlKey: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.getState().status, 'PREVIEW_READY'); assert.equal(id('preview').hidden, false);
  assert.equal(id('replacement').textContent, 'proposal'); assert.equal(id('apply').disabled, false);
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
  resolve(injected(final('answer'))); await new Promise(done => setImmediate(done));
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

// --- Task 9: live step status and the actions summary ------------------------------------------

test('the live step status and the actions summary are rendered as text, never as raw JSON', async () => {
  const f = fixture([
    toolCalls(['insert_paragraph', { text: 'секретный текст документа' }]),
    final('Готово')
  ]);
  // The subscription is registered BEFORE the panel's own listener, so each entry records the state
  // and the DOM as the panel listener later sees it in that same emit.
  const snapshots = [];
  let liveStatus = null;
  const unsubscribe = f.controller.subscribe(state => {
    if (state.agent?.status === 'RUNNING') liveStatus = f.id('status').textContent;
    snapshots.push({ state, status: f.id('status').textContent, actions: f.id('actions').textContent });
  });
  f.id('mode').value = 'EDIT'; f.id('mode').dispatch('change');
  await f.controller.analyze('сделай');
  unsubscribe();
  // A running emit carries the live step counter and the completed action; the next emit has already
  // rendered both, as the recorded DOM text shows.
  const running = snapshots.filter(entry => entry.state.agent?.status === 'RUNNING' && entry.state.agent.steps > 0);
  assert.ok(running.length >= 1);
  // The live counter reached the DOM during the run: the last running emit was rendered as `шаг 1`.
  assert.equal(liveStatus, 'Анализ… · шаг 1');
  assert.equal(snapshots.at(-1).status, 'Ответ получен');
  assert.equal(snapshots.at(-1).actions, 'insert_paragraph: ok');
  assert.match(running.at(-1).state.status, /ANALYZING/);
  assert.equal(snapshots.at(-1).actions, 'insert_paragraph: ok');
  assert.match(f.id('status').textContent, /Ответ получен/);
  assert.match(f.id('actions').textContent, /insert_paragraph: ok/);
  // The raw model JSON, its arguments and the document text never appear in the rendered panel.
  const rendered = f.root.textContent;
  for (const forbidden of ['"type":', '"calls"', '"arguments"', 'секретный текст документа']) {
    assert.equal(rendered.includes(forbidden), false, forbidden);
  }
  assert.equal(f.id('actions').textContent.includes('insert_paragraph'), true);
  assert.equal(f.id('status').getAttribute('role'), 'status');
  assert.equal(f.id('status').getAttribute('aria-live'), 'polite');
  assert.equal(f.id('status').getAttribute('aria-atomic'), 'true');
  assert.equal(f.id('actions').getAttribute('aria-live'), 'polite');
  f.panel.dispose(); f.controller.dispose();
});

test('a failed action line renders its closed code and no raw error text', async () => {
  const f = fixture([toolCalls(['read_selection', {}]), final('Готово')],
    { bridge: { async readSelection() { throw new SafeError('EDITOR_ERROR'); } } });
  f.controller.setIncludeContext(false);
  f.controller.setMode('EDIT');
  await f.controller.analyze('сделай');
  // The renderer's error branch: the closed code, in the authored `tool: outcome (CODE)` form. The
  // bridge's thrown exception object never reaches the DOM.
  assert.equal(f.id('actions').textContent, 'read_selection: error (EDITOR_ERROR)');
  assert.equal(f.id('actions').hidden, false);
  f.panel.dispose(); f.controller.dispose();
});

test('a successful action line renders the outcome without a code', async () => {
  const f = fixture([toolCalls(['read_selection', {}]), final('Готово')]);
  f.controller.setMode('EDIT');
  await f.controller.analyze('сделай');
  assert.equal(f.id('actions').textContent, 'read_selection: ok');
  f.panel.dispose(); f.controller.dispose();
});

test('markup in a model final message stays verbatim text and never becomes an element', async () => {
  const markup = '<img src=x onerror=alert(1)> **not markdown**';
  const f = fixture(final(markup));
  await f.controller.analyze('вопрос');
  const history = f.id('history');
  const reply = history.children[1];
  // (a) the model's text is present VERBATIM: not parsed, escaped, stripped or shortened.
  assert.equal(reply.children[1].textContent, markup);
  assert.ok(history.textContent.includes(markup));
  // (b) the history is built only from the authored element types — no element was created from the
  // content, because the renderer sets textContent and never markup.
  assert.deepEqual(history.children.map(child => child.tagName), ['ARTICLE', 'ARTICLE']);
  assert.deepEqual(history.children[0].children.map(child => child.tagName), ['H2', 'PRE']);
  assert.deepEqual(reply.children.map(child => child.tagName), ['H2', 'PRE']);
  assert.equal(f.all().some(node => ['IMG', 'SCRIPT'].includes(node.tagName)), false);
  f.panel.dispose(); f.controller.dispose();
});

test('the actions block renders one line per action and stays empty for a run with none', async () => {
  const f = fixture([final('Готово')]);
  await f.controller.analyze('сделай');
  assert.equal(f.id('actions').textContent, '');
  assert.equal(f.id('actions').hidden, true);
  f.panel.dispose(); f.controller.dispose();
});
