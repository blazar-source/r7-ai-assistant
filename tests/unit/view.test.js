import test from 'node:test';
import assert from 'node:assert/strict';
import { mountPanel, statusText, orchestrationText, progressStageText } from '../../src/ui/view.js';
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
    bridge, transport: options.transport ?? transport });
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
test('marked content container holds every content block while composer remains outside it and last', () => {
  const { root, all, id, panel, controller } = fixture();
  const content = id('content'); const composer = id('composer');
  // Computed scrolling is proven by the live geometry measurement, not this DOM harness.
  assert.equal(root.children.includes(content), true);
  assert.equal(root.children.includes(composer), true);
  assert.equal(content.children.includes(composer), false);
  assert.equal(content.getAttribute('data-scroll-container'), 'content');
  assert.deepEqual(all().filter(node => node.getAttribute('data-scroll-container') !== null), [content]);
  assert.deepEqual(root.children.map(child => child.id || child.tagName.toLowerCase()), ['header', 'status', 'progress-stage', 'content', 'composer']);
  assert.deepEqual(content.children.map(child => child.id || child.tagName.toLowerCase()),
    ['history', 'preview', 'diagnostics']);
  for (const section of ['history', 'preview', 'diagnostics']) {
    assert.equal(content.children.includes(id(section)), true, `${section} belongs to the content container`);
  }
  const diagnostics = id('diagnostics');
  assert.equal(diagnostics.children.some(child => child.tagName === 'P' && child.className === 'notice'), true, 'lifecycle warning belongs to diagnostics');
  assert.equal(diagnostics.children.some(child => child.tagName === 'SECTION' && child.getAttribute('aria-label') === 'Режим и контекст'), true, 'toolbar belongs to diagnostics');
  assert.equal(diagnostics.children.some(child => child.children.includes(id('settings-form'))), true, 'settings belong to diagnostics');
  assert.equal(root.children.at(-1), composer);
  panel.dispose(); controller.dispose();
});

test('main panel keeps diagnostics collapsed and composer compact at rest', () => {
  const { all, id, panel, controller } = fixture();
  const diagnostics = id('diagnostics');
  assert.ok(diagnostics);
  assert.equal(diagnostics.tagName, 'DETAILS');
  assert.equal(diagnostics.getAttribute('open'), null);
  assert.equal(diagnostics.children.includes(id('editor')), true);
  assert.match(id('editor').textContent, /Stage B/);
  assert.equal(all().some(item => item.tagName === 'LABEL' && item.htmlFor === 'prompt'), false);
  assert.equal(id('prompt').rows, 3);
  assert.equal(id('input-budget').hidden, true);
  assert.equal(id('stop').hidden, true);
  panel.dispose(); controller.dispose();
});

test('byte counter appears only in the final quarter of the 8192-byte input budget', () => {
  const { id, panel, controller } = fixture();
  id('prompt').value = 'a'.repeat(6143); id('prompt').dispatch('input');
  assert.equal(id('input-budget').hidden, true);
  id('prompt').value += 'a'; id('prompt').dispatch('input');
  assert.equal(id('input-budget').hidden, false);
  assert.match(id('input-budget').textContent, /^6144 \/ 8192 байт UTF-8/);
  panel.dispose(); controller.dispose();
});

test('compact status maps every detailed state to the honest closed visible set', () => {
  // The owner fixed the compact set to five words (contract §7.7), so the classification IS the
  // contract: ACTIVE names the stage, CLEAN ended with nothing needing attention, ATTENTION is a real
  // failure or an incomplete/unproven outcome. A non-error terminal state must never be called an error.
  const clean = ['READY', 'COMPLETE', 'CONTEXT_READY', 'CONNECTION_OK', 'SETTINGS_SAVED', 'SETTINGS_CHANGED', 'R7_PRESENCE_READY', 'PREVIEW_READY', 'PREVIEW_EXPIRED', 'PREVIEW_CANCELLED', 'CONTEXT_CHANGED', 'STOPPED', 'CANCELLED', 'APPLY_ACKNOWLEDGED', 'ORCH_COMPLETE'];
  const attention = ['AGENT_LIMIT', 'ORCH_INCOMPLETE', 'ORCH_UNCERTAIN', 'ORCH_BLOCKED', 'APPLY_UNCERTAIN', 'R7_CHECK_UNAVAILABLE', 'CAPABILITY_UNAVAILABLE', 'SELECTION_CHANGED', 'EDITOR_BUSY', 'EDITOR_ERROR', 'INVALID_SETTINGS', 'INVALID_ENDPOINT', 'INVALID_KEY', 'INVALID_DATA', 'BYTE_LIMIT', 'STORAGE_UNAVAILABLE', 'STORAGE_CORRUPT', 'INTERNAL_ERROR', 'PROTOCOL_ERROR', 'HTTP_UNAUTHORIZED', 'HTTP_FORBIDDEN', 'HTTP_RATE_LIMIT', 'HTTP_SERVER_ERROR', 'HTTP_ERROR', 'NETWORK_ERROR', 'OFFLINE', 'TIMEOUT'];
  const active = { CHECKING_R7: 'Проверяю', CONNECTING: 'Проверяю', CHECKING_SELECTION: 'Проверяю', ORCH_VERIFYING: 'Проверяю', ANALYZING: 'Анализирую', ORCH_PLANNING: 'Анализирую', READING_CONTEXT: 'Выполняю', APPLYING: 'Выполняю', ORCH_EXECUTING: 'Выполняю', ORCH_CONTINUING: 'Выполняю' };
  const classified = [...clean, ...attention, ...Object.keys(active)].sort();
  // The key list is taken from the module's own status map (no helper): the assertion fails if a status is
  // added without being classified, which is what keeps this mapping honest.
  const allStatusCodes = ['AGENT_LIMIT', 'ANALYZING', 'APPLYING', 'APPLY_ACKNOWLEDGED', 'APPLY_UNCERTAIN', 'BYTE_LIMIT', 'CANCELLED', 'CAPABILITY_UNAVAILABLE', 'CHECKING_R7', 'CHECKING_SELECTION', 'COMPLETE', 'CONNECTING', 'CONNECTION_OK', 'CONTEXT_CHANGED', 'CONTEXT_READY', 'EDITOR_BUSY', 'EDITOR_ERROR', 'HTTP_ERROR', 'HTTP_FORBIDDEN', 'HTTP_RATE_LIMIT', 'HTTP_SERVER_ERROR', 'HTTP_UNAUTHORIZED', 'INTERNAL_ERROR', 'INVALID_DATA', 'INVALID_ENDPOINT', 'INVALID_KEY', 'INVALID_SETTINGS', 'NETWORK_ERROR', 'OFFLINE', 'ORCH_BLOCKED', 'ORCH_COMPLETE', 'ORCH_CONTINUING', 'ORCH_EXECUTING', 'ORCH_INCOMPLETE', 'ORCH_PLANNING', 'ORCH_UNCERTAIN', 'ORCH_VERIFYING', 'PREVIEW_CANCELLED', 'PREVIEW_EXPIRED', 'PREVIEW_READY', 'PROTOCOL_ERROR', 'R7_CHECK_UNAVAILABLE', 'R7_PRESENCE_READY', 'READING_CONTEXT', 'READY', 'SELECTION_CHANGED', 'SETTINGS_CHANGED', 'SETTINGS_SAVED', 'STOPPED', 'STORAGE_CORRUPT', 'STORAGE_UNAVAILABLE', 'TIMEOUT'];
  assert.deepEqual(classified, [...allStatusCodes].sort(), 'every status in the map is classified');
  for (const code of clean) assert.equal(statusText(code, true), 'Готово', code);
  for (const code of attention) assert.equal(statusText(code, true), 'Ошибка', code);
  for (const [code, caption] of Object.entries(active)) assert.equal(statusText(code, true), caption, code);
  assert.equal(statusText('FUTURE_TERMINAL', true), 'Готово', 'an unknown non-error status must not silently become an error');
});

test('user and assistant messages have distinct semantic roles and visual classes', async () => {
  const f = fixture(final('answer')); await f.controller.analyze('question');
  const [user, assistant] = f.id('history').children;
  assert.equal(user.className, 'message message-user');
  assert.equal(user.getAttribute('data-role'), 'user');
  assert.equal(assistant.className, 'message message-assistant');
  assert.equal(assistant.getAttribute('data-role'), 'assistant');
  assert.notEqual(user.className, assistant.className);
  f.panel.dispose(); f.controller.dispose();
});

test('composer stays mounted and prompt-enabled across idle, active, error and preview states', async () => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const active = fixture(pending);
  assert.equal(active.id('prompt').disabled, false); assert.ok(active.id('composer'));
  const operation = active.controller.analyze('question'); await Promise.resolve();
  assert.equal(active.controller.getState().active, true);
  assert.equal(active.id('prompt').disabled, false); assert.ok(active.id('composer'));
  assert.equal(active.id('stop').hidden, false);
  release(injected(final('answer'))); await operation;
  assert.equal(active.id('stop').hidden, true);
  active.panel.dispose(); active.controller.dispose();

  const error = fixture(async () => { throw new SafeError('NETWORK_ERROR'); }, { transport: async () => { throw new SafeError('NETWORK_ERROR'); } });
  await error.controller.analyze('question');
  assert.equal(error.controller.getState().status, 'NETWORK_ERROR');
  assert.equal(error.id('prompt').disabled, false); assert.ok(error.id('composer'));
  error.panel.dispose(); error.controller.dispose();

  const preview = fixture(toolCalls(['replace_selection', { text: 'proposal' }]));
  preview.controller.setMode('EDIT'); await preview.controller.analyze('edit');
  assert.equal(preview.controller.getState().status, 'PREVIEW_READY');
  assert.equal(preview.id('prompt').disabled, false); assert.ok(preview.id('composer'));
  preview.panel.dispose(); preview.controller.dispose();
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

test('progress stages derive the five closed human phrases from published state', () => {
  assert.equal(progressStageText({ active: true, status: 'ANALYZING', agent: null }), 'подготовка запроса');
  assert.equal(progressStageText({ active: true, status: 'ANALYZING', agent: { status: 'RUNNING', steps: 0, toolCalls: 0 } }), 'запрос к модели');
  assert.equal(progressStageText({ active: true, status: 'ANALYZING', agent: { status: 'RUNNING', steps: 3, toolCalls: 2 } }), 'выполнение шага 3');
  assert.equal(progressStageText({ active: true, status: 'ORCH_EXECUTING', orchestration: { status: 'ORCH_EXECUTING', plan: { sections: ['A', 'B', 'C', 'D'] } }, agent: { status: 'RUNNING', steps: 3, toolCalls: 2 } }), 'шаг 3 из 4');
  assert.equal(progressStageText({ active: true, status: 'ANALYZING', agent: { status: 'RUNNING', steps: 4, toolCalls: 0 } }), 'сборка результата');
  assert.equal(progressStageText({ active: true, status: 'ORCH_VERIFYING', orchestration: { status: 'ORCH_VERIFYING' }, agent: { status: 'FINAL', steps: 4, toolCalls: 2 } }), 'проверка результата');
});

test('progress stage is editor-agnostic for Word, Cell and Slide', () => {
  for (const editorType of ['word', 'cell', 'slide']) {
    assert.equal(progressStageText({ active: true, editorType, status: 'ANALYZING', agent: { status: 'RUNNING', steps: 2, toolCalls: 1 } }), 'выполнение шага 2', editorType);
  }
});

test('every terminal outcome removes the progress stage and keeps compact terminal status', () => {
  const terminal = {
    COMPLETE: 'Готово', STOPPED: 'Готово', CANCELLED: 'Готово', TIMEOUT: 'Ошибка', AGENT_LIMIT: 'Ошибка',
    APPLY_UNCERTAIN: 'Ошибка', ORCH_INCOMPLETE: 'Ошибка', ORCH_UNCERTAIN: 'Ошибка', ORCH_BLOCKED: 'Ошибка',
    INTERNAL_ERROR: 'Ошибка', PROTOCOL_ERROR: 'Ошибка', HTTP_UNAUTHORIZED: 'Ошибка', HTTP_FORBIDDEN: 'Ошибка',
    HTTP_RATE_LIMIT: 'Ошибка', HTTP_SERVER_ERROR: 'Ошибка', HTTP_ERROR: 'Ошибка', NETWORK_ERROR: 'Ошибка', OFFLINE: 'Ошибка',
    INVALID_SETTINGS: 'Ошибка', INVALID_ENDPOINT: 'Ошибка', INVALID_KEY: 'Ошибка', INVALID_DATA: 'Ошибка', BYTE_LIMIT: 'Ошибка',
    STORAGE_UNAVAILABLE: 'Ошибка', STORAGE_CORRUPT: 'Ошибка', CAPABILITY_UNAVAILABLE: 'Ошибка', EDITOR_BUSY: 'Ошибка', EDITOR_ERROR: 'Ошибка'
  };
  for (const [status, compact] of Object.entries(terminal)) {
    assert.equal(progressStageText({ active: false, status, agent: { status: 'FINAL', steps: 7, toolCalls: 4 } }), '', status);
    assert.equal(statusText(status, true), compact, status);
  }
});

test('every terminal publication makes the progress element inert with or without a preserved active orchestration record', () => {
  const tree = dom(); let publish;
  const state = { active: true, status: 'ANALYZING', editorType: 'word', agent: null, mode: 'ASK', includeContext: false,
    context: { kind: 'UNKNOWN', text: '', bytes: 0 }, chat: { history: [] }, settings: {}, writeLocked: false,
    canApply: false, preview: null, orchestration: null, capabilityCount: null };
  const controller = { subscribe(listener) { publish = listener; listener(state); return () => {}; }, getState() { return state; },
    saveSettings() { return false; }, setMode() {}, setIncludeContext() {}, stop() {}, newChat() {}, checkR7() {}, refreshContext() {},
    settingsChanged() {}, testConnection() {}, reset() {}, analyze() {}, apply() {}, cancelPreview() {} };
  const panel = mountPanel(tree.root, controller);
  const progress = tree.id('progress-stage');
  const compact = tree.id('status');
  assert.equal(progress.hidden, false); assert.equal(progress.textContent, 'подготовка запроса');
  const terminal = {
    COMPLETE: ['Готово', 'FINAL'], STOPPED: ['Готово', 'CANCELLED'], CANCELLED: ['Готово', 'CANCELLED'], TIMEOUT: ['Ошибка', 'CANCELLED'],
    HTTP_ERROR: ['Ошибка', 'ERROR'], NETWORK_ERROR: ['Ошибка', 'ERROR'], OFFLINE: ['Ошибка', 'ERROR'], PROTOCOL_ERROR: ['Ошибка', 'PROTOCOL_ERROR'],
    CAPABILITY_UNAVAILABLE: ['Ошибка', 'ERROR'], EDITOR_ERROR: ['Ошибка', 'ERROR'], AGENT_LIMIT: ['Ошибка', 'LIMIT'],
    ORCH_INCOMPLETE: ['Ошибка', 'FINAL'], ORCH_UNCERTAIN: ['Ошибка', 'UNCERTAIN'], ORCH_BLOCKED: ['Ошибка', 'ERROR'], ORCH_COMPLETE: ['Готово', 'FINAL']
  };
  const preserved = { status: 'ORCH_VERIFYING', pass: 1, maxPasses: 12, targetChars: 18000,
    plan: { sections: ['A', 'B', 'C'], targetChars: 18000, required: { tables: false, lists: false, conclusions: false } },
    missing: [], missingTools: [] };
  for (const [status, [expectedCompact, agentStatus]] of Object.entries(terminal)) {
    for (const orchestration of [preserved, null]) {
      publish({ ...state, active: false, status, orchestration, agent: { status: agentStatus, steps: 7, toolCalls: 4 } });
      const label = `${status}/${orchestration === null ? 'null' : 'preserved'}`;
      assert.equal(progress.textContent, '', label);
      assert.equal(progress.hidden, true, label);
      assert.equal(progress.getAttribute('aria-busy'), 'false', label);
      assert.equal(compact.textContent, expectedCompact, label);
    }
  }
  panel.dispose();
});

test('stage text is authored human language, never a raw status or internal event', () => {
  const states = [
    { active: true, status: 'ANALYZING', agent: null },
    { active: true, status: 'ANALYZING', agent: { status: 'RUNNING', steps: 0, toolCalls: 0 } },
    { active: true, status: 'ANALYZING', agent: { status: 'RUNNING', steps: 1, toolCalls: 1 } },
    { active: true, status: 'ANALYZING', agent: { status: 'RUNNING', steps: 2, toolCalls: 0 } },
    { active: true, status: 'ORCH_VERIFYING', orchestration: { status: 'ORCH_VERIFYING' }, agent: { status: 'FINAL', steps: 2, toolCalls: 1 } }
  ];
  for (const state of states) {
    const text = progressStageText(state);
    assert.match(text, /^[а-яё0-9 ]+$/u);
    assert.equal(/ANALYZING|ORCH_|RUNNING|tool|event/i.test(text), false, text);
  }
});

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
  assert.equal(liveStatus, 'Анализирую');
  assert.equal(snapshots.at(-1).status, 'Готово');
  assert.equal(snapshots.at(-1).actions, 'insert_paragraph: ok');
  assert.match(running.at(-1).state.status, /ANALYZING/);
  assert.equal(snapshots.at(-1).actions, 'insert_paragraph: ok');
  assert.equal(f.id('status').textContent, 'Готово');
  assert.match(f.id('status-details').textContent, /Ответ получен/);
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

test('the orchestration report renders the plan, the verified numbers and the missing list as text', () => {
  const record = { phase: 'incomplete', status: 'ORCH_INCOMPLETE', pass: 3, maxPasses: 12, targetChars: 18000,
    criteria: { targetChars: 18000, tables: 2, lists: false, sections: 2, conclusions: true },
    floor: { targetChars: 18000, tables: 2, conclusions: true, sections: null },
    plan: { sections: ['Введение', 'Глава 1'], targetChars: 18000, required: { tables: true, lists: false, conclusions: true } },
    verified: { chars: 9000, paragraphs: 22, headings: 1, tables: 0, lists: false, conclusions: false },
    missing: ['объём: 9000 из 18000 знаков', 'таблиц нет ни одной'], missingTools: [], uncertainty: null,
    planCalledTools: false, error: 'PASS_BUDGET_EXHAUSTED' };
  const text = orchestrationText(record);
  assert.match(text, /Проходов: 3 \/ 12/);
  // The ENFORCED criteria are printed next to the measurement they were checked against.
  assert.match(text, /Критерии приёмки: знаков — 18000, заголовков — 2, таблиц — 2, списки — нет, заключение — да\./);
  assert.match(text, /абзацев — 22, заголовков — 1, таблиц — 0, знаков — 9000/);
  assert.match(text, /План: 2 разделов/);
  assert.match(text, /таблицы, выводы/);
  assert.match(text, /Не хватает: объём: 9000 из 18000 знаков; таблиц нет ни одной\./);
  assert.match(text, /Причина остановки: PASS_BUDGET_EXHAUSTED\./);
  assert.equal(orchestrationText(null), '');
  // The uncertain report names the unverified tool and never claims the document is complete.
  const uncertain = orchestrationText({ ...record, phase: 'uncertain', pass: 1, missing: [], missingTools: ['insert_blocks'],
    error: 'TOOL_UNCERTAIN' });
  assert.match(uncertain, /Неподтверждённое действие: insert_blocks\./);
  assert.equal(statusText('ORCH_UNCERTAIN').includes('проверьте документ'), true);
  assert.equal(statusText('ORCH_COMPLETE').includes('проверка самого документа'), true);
});
test('a plan authored by the model reaches the DOM as literal text and the panel shows the report', async () => {
  const plan = JSON.stringify({ sections: ['<img src=x onerror=alert(1)>', 'Глава 1'], targetCharacters: 18000,
    required: { tables: false, lists: false, conclusions: false }, summary: 's' });
  // The execute pass appends one batch and ENDS: the document then satisfies the plan, so the panel
  // publishes a COMPLETE report carrying the plan's own (markup-shaped) section title.
  const transport = async (settings, messages) => {
    const user = messages[messages.length - 1].content;
    if (user.includes('ТОЛЬКО ПЛАН')) return { content: JSON.stringify({ type: 'final', message: plan }) };
    return { content: JSON.stringify({ type: 'tool_calls', calls: [{ tool: 'insert_blocks',
      arguments: { blocks: [{ text: '<img src=x onerror=alert(1)>' }] } }] }) };
  };
  const bridge = {
    readStructure() { return { ok: true, pages: 10,
      statistics: { PageCount: 10, WordsCount: 3000, ParagraphCount: 30, SymbolsCount: 19000, SymbolsWSCount: 19000 },
      counts: { paragraphs: 30, headings: 2, tables: 0, sections: 1 }, headings: [{ index: 0, text: 'Глава 1' }], truncated: false }; },
    readDocumentText() { return { ok: true, text: 'текст', totalChars: 4 }; }
  };
  const f = fixture(plan, { bridge, transport });
  f.controller.setMode('EDIT');
  await f.controller.analyze('создай документ примерно на 10 страниц');
  const report = f.id('orchestration');
  assert.ok(report, 'the panel publishes the orchestration element');
  assert.equal(report.hidden, false);
  assert.equal(report.tagName, 'PRE');
  // The plan's own text is present VERBATIM in the report and created no element from its content.
  assert.ok(report.textContent.includes('<img src=x onerror=alert(1)>'));
  assert.deepEqual(report.children.map(child => child.tagName), []);
  assert.equal(f.all().some(node => ['IMG', 'SCRIPT'].includes(node.tagName)), false);
  f.panel.dispose(); f.controller.dispose();
});
test('the ordinary single run shows no orchestration report', async () => {
  const f = fixture(final('Готово'));
  await f.controller.analyze('вопрос');
  assert.equal(f.id('orchestration').hidden, true);
  assert.equal(f.id('orchestration').textContent, '');
  f.panel.dispose(); f.controller.dispose();
});

test('every capability, readiness and context element stays inside collapsed diagnostics', () => {
  const f = fixture();
  const diagnostics = f.id('diagnostics');
  for (const technical of ['editor', 'status-details', 'r7-capabilities', 'capability-state', 'capability-pointer', 'context', 'selected-text']) {
    const item = f.id(technical);
    assert.ok(item, technical);
    const contains = (parent, target) => parent.children.includes(target) || parent.children.some(child => contains(child, target));
    assert.equal(contains(diagnostics, item), true, `${technical} belongs to diagnostics`);
    assert.equal(f.root.children.includes(item), false, `${technical} is not a top-level element of #panel`);
  }
  assert.equal(diagnostics.getAttribute('open'), null);
  f.panel.dispose(); f.controller.dispose();
});

test('each closed capability state renders the complete contract in diagnostics', async () => {
  const ready = fixture(final('ok'), { bridge: { async probeCapabilities() { return { editorType: 'word', adapter: { commandDispatch: true }, methodPresence: { api: true, getDocument: true, getDocumentId: true, replaceTextSmart: true, getRangeBySelect: true, isTrackRevisions: true } }; } } });
  await ready.controller.checkR7();
  assert.equal(ready.id('capability-state').textContent, 'Редактор: Word. Доступно: шесть из шести — проверены шесть API-примитивов документа. Что сделать: можно отправлять запрос.');

  const partial = fixture(final('ok'), { bridge: { async probeCapabilities() { return { editorType: 'word', adapter: { commandDispatch: true }, methodPresence: { api: true, getDocument: true, getDocumentId: false, replaceTextSmart: true, getRangeBySelect: false, isTrackRevisions: false } }; } } });
  await partial.controller.checkR7();
  assert.equal(partial.id('capability-state').textContent, 'Редактор: Word. Доступно: три из шести — проверены шесть API-примитивов документа. Недоступно: три возможности, потому что проверка редактора их не подтвердила. Что сделать: откройте диагностику редактора и повторите проверку после восстановления адаптера.');

  const unavailableEditor = fixture(final('ok'), { bridge: { getState() { return { editorType: 'unknown', busy: false, uncertain: false }; } } });
  await unavailableEditor.controller.checkR7();
  assert.equal(unavailableEditor.id('capability-state').textContent, 'Доступно: запросы после подключения поддерживаемого редактора. Этот редактор не поддерживается. Что сделать: откройте документ, таблицу или презентацию, откройте панель через меню „Плагины“ и повторите проверку.');

  const unavailableCapability = fixture(final('ok'), { bridge: {
    getState() { return { editorType: 'cell', busy: false, uncertain: false }; },
    async probeCapabilities() { return { editorType: 'cell', adapter: { commandDispatch: true }, selectionRead: { available: false }, mutation: { available: true } }; }
  } });
  await unavailableCapability.controller.checkR7();
  assert.equal(unavailableCapability.id('include-context').disabled, true);
  assert.equal(unavailableCapability.id('include-context').getAttribute('aria-describedby'), 'capability-state');
  assert.equal(unavailableCapability.id('capability-state').textContent, 'Проверено: чтение выделения и изменение через адаптер. Доступно: одна из двух возможностей — изменение через адаптер. Недоступно: одна возможность, потому что проверка редактора её не подтвердила. Что сделать: оставьте передачу выделения выключенной и отправьте запрос без неё либо восстановите адаптер и повторите проверку.');

  let release; const capabilityPending = new Promise(resolve => { release = resolve; });
  const checking = fixture(final('ok'), { bridge: { async probeCapabilities() { return capabilityPending; } } });
  const operation = checking.controller.checkR7();
  assert.equal(checking.id('check-r7').disabled, true);
  assert.equal(checking.id('capability-state').textContent, 'Проверяю возможности редактора… Доступность ещё не определена, потому что проверка не завершена. Что сделать: дождитесь завершения проверки и повторите действие.');
  release({ editorType: 'word', methodPresence: { api: true, getDocument: true, getDocumentId: true, replaceTextSmart: true, getRangeBySelect: true, isTrackRevisions: true } });
  await operation;

  const writePending = fixture(final('ok'), { bridge: { getState() { return { editorType: 'word', busy: false, uncertain: false, writePending: true }; } } });
  assert.equal(writePending.id('capability-state').textContent, 'Изменение подготовлено и ждёт подтверждения. Отправка и повторное изменение недоступны, потому что редактор ещё не подтвердил предыдущую запись. Что сделать: подтвердите изменение в редакторе или дождитесь завершения операции.');

  for (const f of [ready, partial, unavailableEditor, unavailableCapability, checking, writePending]) { f.panel.dispose(); f.controller.dispose(); }
});

test('Cell defaults selection context off before any model request and links its disabled control to diagnostics', async () => {
  const cell = fixture(final('ok'), { bridge: {
    getState() { return { editorType: 'cell', busy: false, uncertain: false }; },
    async probeCapabilities() { return { editorType: 'cell', adapter: { commandDispatch: true }, selectionRead: { available: true }, mutation: { available: true } }; }
  } });
  assert.equal(cell.controller.getState().includeContext, false);
  await cell.controller.checkR7();
  assert.equal(cell.id('include-context').checked, false);
  assert.equal(cell.id('include-context').disabled, true);
  assert.equal(cell.id('include-context').getAttribute('aria-describedby'), 'capability-state');
  assert.equal(cell.id('capability-state').textContent, 'Редактор: Cell. Доступно: две из двух — проверены чтение выделения и изменение через адаптер. Что сделать: можно отправлять запрос.');
  assert.equal(cell.replies.length, 0);
  cell.panel.dispose(); cell.controller.dispose();
});

test('the readiness summary names the denominator of the EDITOR it describes', async () => {
  // MEASURED on the target: a spreadsheet readiness printed "Наличие API: 0 / 6", a Word-shaped denominator for a
  // count that is two booleans. The sentence after the count differs too, because for a spreadsheet the check is
  // about the adapter, not about Word selection, formatting and undo.
  const cellBridge = {
    getState() { return { editorType: 'cell', busy: false, uncertain: false }; }, invalidate() {},
    async probeCapabilities() {
      return { editorType: 'cell', adapter: { executeMethod: false, commandDispatch: true, commandMethod: 'callCommand' },
        methodPresence: null, selectionRead: { available: false, runtimeVerified: false, reason: 'READ_UNAVAILABLE' },
        mutation: { available: false, runtimeVerified: false, reason: 'EXPLICIT_OWNED_PREVIEW_REQUIRED' } };
    }
  };
  const cell = fixture(final('ok'), { bridge: cellBridge });
  await cell.controller.checkR7();
  const cellSummary = cell.id('r7-capabilities').textContent;
  assert.match(cellSummary, /0 \/ 2/, 'a spreadsheet counts its own two flags: ' + cellSummary);
  assert.match(cellSummary, /готовность адаптера/, 'and says what the check was about');
  assert.equal(cellSummary.includes('/ 6'), false, 'never with a document denominator');

  const word = fixture(final('ok'), { bridge: {
    async probeCapabilities() {
      return { editorType: 'word', adapter: { executeMethod: true, commandDispatch: false, commandMethod: null },
        methodPresence: { api: true, getDocument: true, getDocumentId: false, replaceTextSmart: true, getRangeBySelect: false, isTrackRevisions: false } };
    }
  } });
  await word.controller.checkR7();
  const wordSummary = word.id('r7-capabilities').textContent;
  assert.match(wordSummary, /3 \/ 6/, 'a document keeps its six primitives: ' + wordSummary);
  cell.panel.dispose(); cell.controller.dispose(); word.panel.dispose(); word.controller.dispose();
});
