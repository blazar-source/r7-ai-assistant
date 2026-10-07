import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../../src/ui/controller.js';
import { AGENT_GUARDRAILS, LIMITS } from '../../src/shared/limits.js';
import { SettingsStore } from '../../src/config/storage.js';
import { SafeError } from '../../src/shared/errors.js';

// The host-side bound the controller brackets ONE multi-step agent run with: the named pilot
// configuration plus one transport window. The injected clock starts at 100, so the absolute deadline
// the transport receives is 100 + this value. It is strictly above the guardrail deadline on purpose:
// an exhausted task must report the runtime's own LIMIT, not the panel's TIMEOUT.
const RUN_DEADLINE_MS = AGENT_GUARDRAILS.operationDeadlineMs + LIMITS.operationTimeoutMs;

const final = (message = 'ответ') => ({ type: 'final', message });
const toolCalls = (...tools) => ({ type: 'tool_calls', calls: tools.map(([tool, args]) => ({ tool, arguments: args })) });
// The runtime authors the trusted system rules and consumes a raw envelope (`{ content }`) that it
// parses itself. A raw content string passes through untouched; a parsed Sprint 1 object is
// re-serialized by the controller's adapter, and one node test below asserts that adaptation.
function pending() { const outer = {}; outer.promise = new Promise(resolve => { outer.resolve = resolve; }); return outer; }
function setup(options = {}) {
  let time = 100;
  let id = 0;
  const scheduled = new Map();
  const crypto = { randomUUID() { id++; return `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`; } };
  const storage = new Map([['unrelated', 'keep']]);
  const store = new SettingsStore({ getItem(k) { return storage.get(k) ?? null; }, setItem(k,v) { storage.set(k,v); }, removeItem(k) { storage.delete(k); }, get length() { return storage.size; }, key(i) { return [...storage.keys()][i]; } });
  const target = Object.freeze({}); const applied = []; const replies = [];
  const bridge = { getState() { return { editorType: 'word', busy: false, uncertain: false }; }, invalidate() {}, canApply(value) { return value === target; },
    async readSelection() { return { text: 'выделено', editorType: 'word', eligible: true, target }; },
    // The tool reports an insert as acknowledged only on a literal `data.sent === true`.
    async insertParagraph() { return { ok: true, data: { sent: true } }; },
    async applySelection(data) { assert.equal(data.target, target); data.beforeDispatch(); applied.push(data.replacement); return { acknowledged: true, effectVerified: false }; }, ...options.bridge };
  const clock = { now() { return time; } };
  const timers = { schedule(fn,ms) { const token = {}; scheduled.set(token, { fn, at: time + ms }); return token; }, clear(token) { scheduled.delete(token); } };
  // An ARRAY is a scripted sequence of model replies, one per runtime step; anything else is the
  // single reply every step sees.
  const scripted = Array.isArray(options.response) ? options.response : () => options.response ?? final();
  const transport = options.transport ?? (async (...args) => {
    replies.push(args);
    const reply = typeof scripted === 'function' ? scripted(...args) : scripted.shift();
    return typeof reply === 'function' ? reply(...args) : reply;
  });
  const controller = createController({ bridge, store, crypto, clock, timers, transport, ...options.dependencies });
  controller.saveSettings({ endpoint: 'https://example.invalid/v1/chat/completions', apiKey: 'synthetic' });
  return { controller, replies, transport, applied, bridge, storage, clock, scheduled, advance(ms, fire = true) { time += ms; if (fire) for (const [token, t] of [...scheduled]) if (t.at <= time) { scheduled.delete(token); t.fn(); } } };
}

test('R7 check with no bridge reports local unsupported without HTTP or credentials', async () => {
  const f = setup({ dependencies: { bridge: null } }); f.controller.reset();
  assert.equal(typeof f.controller.checkR7, 'function', 'controller read-only capability action');
  const before = f.controller.getState();
  assert.equal(await f.controller.checkR7(), false);
  assert.equal(f.controller.getState().status, 'R7_CHECK_UNAVAILABLE');
  assert.equal(f.controller.getState().capabilityCount, null); assert.equal(f.controller.getState().chat, before.chat);
  assert.equal(f.replies.length, 0); assert.equal(f.scheduled.size, 0);
});
test('R7 check timer acquisition failure cannot reach SDK or strand active ownership', async () => {
  let probes = 0;
  const f = setup({ bridge: { probeCapabilities() { probes++; throw Error('must not dispatch'); } }, dependencies: { timers: { schedule() { throw Error('SECRET'); }, clear() {} } } });
  assert.equal(typeof f.controller.checkR7, 'function', 'controller read-only capability action');
  assert.equal(await f.controller.checkR7(), false); assert.equal(probes, 0);
  assert.equal(f.controller.getState().status, 'INTERNAL_ERROR'); assert.equal(f.controller.getState().active, false);
});

test('presentation reads dispatch through the same registry when context is explicitly disabled', async () => {
  let reads = 0;
  const f = setup({ response: [toolCalls(['read_presentation', {}]), final()], bridge: {
    getState() { return { editorType: 'slide', busy: false, uncertain: false }; },
    async readPresentation() { reads++; return { ok: true, slidesCount: 0, currentSlideIndex: 0, slidesRead: 0, slidesTotal: 0, truncated: false, slides: [] }; }
  } });
  f.controller.setIncludeContext(false);
  assert.equal(await f.controller.analyze('структура презентации'), true);
  assert.equal(reads, 1);
  assert.deepEqual(f.controller.getState().agent.actions.map(action => [action.tool, action.outcome]), [['read_presentation', 'ok']]);
});

test('ASK uses fresh bounded selection as untrusted user context and appends a complete pair', async () => {
  const { controller: c, replies } = setup();
  assert.equal(await c.analyze('вопрос'), true);
  assert.equal(c.getState().status, 'COMPLETE');
  assert.equal(c.getState().context.kind, 'EXACT');
  assert.equal(c.getState().context.ownershipVerified, true);
  const sent = replies[0][1];
  assert.equal(sent.length, 2);
  assert.equal(sent[0].role, 'system'); assert.equal(sent[1].role, 'user');
  assert.equal(sent[1].content, 'вопрос');
  assert.equal(sent[0].content.includes('ASK'), true);
  assert.equal(sent[0].content.includes('выделено'), false);
  assert.deepEqual(c.getState().chat.history.map(m => m.content), ['вопрос', 'ответ']);
  assert.equal(c.getState().preview, null);
});
test('EDIT creates immutable sanitized preview and explicit Apply delegates only private owned target', async () => {
  const { controller: c, applied } = setup({ response: toolCalls(['replace_selection', { text: 'замена' }]) });
  c.setMode('EDIT'); await c.analyze('исправить');
  const preview = c.getState().preview;
  assert.ok(preview && Object.isFrozen(preview)); assert.equal(preview.replacement, 'замена');
  assert.equal('target' in preview, false); assert.equal('settings' in preview, false); assert.equal(applied.length, 0);
  assert.equal(c.getState().canApply, true); assert.equal(await c.apply(), true);
  assert.deepEqual(applied, ['замена']); assert.equal(c.getState().status, 'APPLY_ACKNOWLEDGED'); assert.equal(c.getState().preview, null);
});
test('preview expires at exactly 120000 milliseconds', async () => {
  const { controller: c, advance } = setup({ response: toolCalls(['replace_selection', { text: 'удалить' }]) });
  c.setMode('EDIT'); await c.analyze('delete');
  advance(119999); assert.ok(c.getState().preview);
  advance(1); assert.equal(c.getState().preview, null); assert.equal(c.getState().status, 'PREVIEW_EXPIRED');
});
test('Apply checks preview deadline even without timer task delivery', async () => {
  const { controller: c, advance } = setup({ response: toolCalls(['replace_selection', { text: 'proposal' }]) });
  c.setMode('EDIT'); await c.analyze('edit'); advance(120000, false);
  assert.ok(c.getState().preview); assert.equal(await c.apply(), false); assert.equal(c.getState().preview, null);
  assert.equal(c.getState().status, 'PREVIEW_EXPIRED');
});
for (const change of ['stop', 'newChat', 'reset', 'settings', 'editor', 'document', 'mode', 'context']) {
  test(`${change} clears an already published uncommitted preview`, async () => {
    const { controller: c } = setup({ response: toolCalls(['replace_selection', { text: 'proposal' }]) });
    c.setMode('EDIT'); await c.analyze('edit'); assert.ok(c.getState().preview);
    if (change === 'settings') c.settingsChanged();
    else if (change === 'mode') c.setMode('ASK');
    else if (change === 'context') c.setIncludeContext(false);
    else if (change === 'selection') c.selectionChanged();
    else if (['editor','document'].includes(change)) c.contextChanged();
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
  const { controller: c, replies } = setup({ bridge: { async readSelection() { throw Error('must not read'); } } });
  const uuid = c.getState().chat.uuid;
  assert.equal(await c.testConnection(), true);
  assert.notEqual(replies[0][2], uuid);
  assert.equal(replies[0][3].mode, 'ASK');
  assert.equal(c.getState().chat.uuid, uuid); assert.equal(c.getState().chat.history.length, 0);
  assert.equal(c.getState().status, 'CONNECTION_OK');
  assert.equal(c.getState().agent.status, 'FINAL');
});
test('a connection run ending FINAL publishes the verified caption', async () => {
  const f = setup();
  assert.equal(await f.controller.testConnection(), true);
  assert.equal(f.controller.getState().status, 'CONNECTION_OK');
});
test('a connection run ending PROTOCOL_ERROR never publishes the verified caption', async () => {
  const f = setup({ transport: async () => ({ content: 'not json' }) });
  assert.equal(await f.controller.testConnection(), true);
  assert.equal(f.controller.getState().status, 'PROTOCOL_ERROR');
});
test('a connection run ending ERROR publishes the closed code the runtime classified', async () => {
  const f = setup({ transport: function () { throw new SafeError('HTTP_UNAUTHORIZED'); } });
  assert.equal(await f.controller.testConnection(), true);
  assert.equal(f.controller.getState().status, 'HTTP_UNAUTHORIZED');
});
test('an async transport rejection publishes the classified status and reports false', async () => {
  const f = setup({ transport: async () => { throw new SafeError('NETWORK_ERROR'); } });
  assert.equal(await f.controller.analyze('q'), false);
  assert.equal(f.controller.getState().status, 'NETWORK_ERROR');
});
test('an unvalidated code from a forged error cannot become the published status', async () => {
  const forged = function () {
    const error = Object.create(SafeError.prototype);
    Object.defineProperty(error, 'code', { value: 'FORGED_SECRET' });
    return error;
  };
  // The synchronous throw reaches the controller through the runtime's classified ERROR outcome.
  const sync = setup({ dependencies: { transport: function () { throw forged(); } } });
  sync.controller.setIncludeContext(false);
  assert.equal(await sync.controller.analyze('q'), true);
  assert.equal(sync.controller.getState().status, 'INTERNAL_ERROR');
  assert.equal(JSON.stringify(sync.controller.getState()).includes('FORGED'), false);
  // The asynchronous rejection settles the dispatch promise instead, so it must pass the same gate.
  const asyncThrow = setup({ dependencies: { transport: async () => { throw forged(); } } });
  asyncThrow.controller.setIncludeContext(false);
  await asyncThrow.controller.analyze('q');
  assert.equal(asyncThrow.controller.getState().status, 'INTERNAL_ERROR');
  assert.equal(JSON.stringify(asyncThrow.controller.getState()).includes('FORGED'), false);
});
for (const change of ['stop', 'newChat', 'reset', 'settings', 'editor', 'document', 'selection', 'mode', 'context']) {
  test(`${change} invalidates late HTTP result and uncommitted preview/status/history`, async () => {
    const waiting = pending();
    const { controller: c } = setup({ transport: async () => waiting.promise });
    c.setIncludeContext(false);
    const operation = c.analyze('old');
    await Promise.resolve();
    assert.equal(c.getState().active, true);
    if (change === 'settings') c.settingsChanged();
    else if (change === 'mode') c.setMode('EDIT');
    else if (change === 'context') c.setIncludeContext(true);
    else if (change === 'selection') c.selectionChanged();
    else if (['editor','document'].includes(change)) c.contextChanged();
    else c[change]();
    const state = c.getState();
    waiting.resolve(final('late')); await operation;
    assert.equal(c.getState().status, state.status);
    assert.equal(c.getState().chat.history.length, 0);
    assert.equal(c.getState().preview, null);
    assert.equal(c.getState().active, false);
  });
}
test('one active operation rejects overlap without replacing current ownership', async () => {
  const waiting = pending(); const { controller: c } = setup({ transport: async () => waiting.promise });
  c.setIncludeContext(false); const first = c.analyze('first');
  assert.equal(await c.testConnection(), false);
  waiting.resolve(final('first answer')); assert.equal(await first, true);
  assert.deepEqual(c.getState().chat.history.map(m => m.content), ['first', 'first answer']);
});
test('absolute deadline starts BEFORE context read; expired editor result never reaches HTTP', async () => {
  const waiting = pending(); const { controller: c, advance, replies } = setup({ bridge: { readSelection() { return waiting.promise; } } });
  const operation = c.analyze('question'); advance(RUN_DEADLINE_MS);
  waiting.resolve({ text: 'late', editorType: 'word', eligible: false, target: null }); await operation;
  assert.equal(replies.length, 0); assert.equal(c.getState().status, 'TIMEOUT');
});
test('transport receives original operation deadline after time spent reading context', async () => {
  const waiting = pending(); const { controller: c, advance, replies } = setup({ bridge: { readSelection() { return waiting.promise; } } });
  const operation = c.analyze('question'); advance(4000);
  waiting.resolve({ text: 'selection', editorType: 'word', eligible: false, target: null }); await operation;
  assert.equal(replies.length, 1);
  // 100 (the injected clock at begin()) + the host bound, and the host bound must BRACKET the named
  // guardrail deadline rather than replace it: 1800000 + 150000 = 1950000.
  assert.equal(replies[0][3].deadline, 100 + RUN_DEADLINE_MS);
  assert.equal(replies[0][3].deadline, 1950100);
  assert.ok(replies[0][3].deadline > AGENT_GUARDRAILS.operationDeadlineMs,
    'the runtime guardrail deadline, not the panel TIMEOUT, is the binding limit of a long run');
  assert.ok(Object.isFrozen(replies[0][0]) && Object.isFrozen(replies[0][1]));
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
  const normal = setup(); await normal.controller.analyze('я'.repeat(4096) + 'x'); assert.equal(normal.replies.length, 0); assert.equal(normal.controller.getState().status, 'BYTE_LIMIT');
  const oversized = setup({ bridge: { async readSelection() { return { text: 'я'.repeat(4096) + 'x', editorType: 'word', eligible: false, target: null }; } } });
  await oversized.controller.analyze('q'); assert.equal(oversized.replies.length, 0); assert.equal(oversized.controller.getState().status, 'BYTE_LIMIT');
});
test('raw errors remain content-free and storage risk is independent of rememberKey', async () => {
  const { controller: c } = setup({ dependencies: { transport: function () { throw Error('SECRET endpoint'); } } });
  c.setIncludeContext(false); await c.analyze('q'); assert.equal(c.getState().status, 'INTERNAL_ERROR');
  assert.equal(JSON.stringify(c.getState()).includes('SECRET'), false);
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
  const clock = { now() { reads++; return reads < 4 ? 0 : RUN_DEADLINE_MS; } };
  const { controller: c } = setup({ dependencies: { clock } }); c.setIncludeContext(false);
  assert.equal(await c.analyze('q'), false);
  assert.equal(c.getState().status, 'TIMEOUT'); assert.equal(c.getState().chat.history.length, 0); assert.equal(c.getState().preview, null);
});
test('SDK busy/uncertain prevents second read without recreating or clearing bridge', async () => {
  const { controller: c, replies } = setup({ bridge: { getState() { return { editorType: 'word', busy: true, uncertain: true }; }, readSelection() { throw new SafeError('EDITOR_BUSY'); } } });
  assert.equal(await c.analyze('q'), false); assert.equal(c.getState().status, 'EDITOR_BUSY'); assert.equal(replies.length, 0);
});

// --- Task 9: the multi-step Agent Runtime lifecycle in the controller -------------------------

test('EDIT runs the agent loop, reaches COMPLETE and exposes the content-free actions summary', async () => {
  const f = setup({ response: [
    toolCalls(['insert_paragraph', { text: 'абзац' }]),
    toolCalls(['read_selection', {}]),
    final('Готово')
  ] });
  f.controller.setMode('EDIT');
  assert.equal(await f.controller.analyze('сделай'), true);
  const state = f.controller.getState();
  assert.equal(state.status, 'COMPLETE');
  assert.equal(f.replies.length, 3);
  assert.deepEqual(state.agent, { status: 'FINAL', steps: 3, toolCalls: 2,
    actions: [{ tool: 'insert_paragraph', outcome: 'ok', bytes: state.agent.actions[0].bytes }, { tool: 'read_selection', outcome: 'ok', bytes: state.agent.actions[1].bytes }] });
  assert.ok(state.agent.actions[0].bytes > 0 && state.agent.actions[1].bytes > 0);
  assert.ok(Object.isFrozen(state.agent) && Object.isFrozen(state.agent.actions[0]));
  assert.deepEqual(state.chat.history.map(m => m.content), ['сделай', 'Готово']);
  // The published record carries the closed tool names and outcomes, never a raw envelope key, the
  // model's arguments or its text.
  const serialized = JSON.stringify(state);
  for (const forbidden of ['"type":', '"calls"', '"arguments"', 'абзац']) assert.equal(serialized.includes(forbidden), false, forbidden);
  assert.equal(serialized.includes('insert_paragraph'), true);
});

// The panel's pilot guardrails reach the runtime IN THE REQUEST. There is no seam to spy on
// `runAgent` (and none is added: src/agent/ stays untouched), so both tests are BEHAVIOURAL: each run
// passes a budget the UNNAMED defaults would refuse, so it can only reach FINAL if the request carried
// the named set. Each test would fail against the old controller with status AGENT_LIMIT.
test('the panel carries the named guardrails: a run past the OLD 12-step default reaches FINAL', async () => {
  // 15 executed actions, each in its own model round-trip: 16 steps is past createGuardrails()'s
  // default maxSteps of 12 (the measured cause of the owner's AGENT_LIMIT after five tool calls).
  const calls = Array.from({ length: 15 }, (_, index) => toolCalls(['insert_paragraph', { text: `абзац ${index}` }]));
  const f = setup({ response: [...calls, final('Готово')] });
  f.controller.setMode('EDIT');
  assert.equal(await f.controller.analyze('создай документ'), true);
  const state = f.controller.getState();
  assert.equal(state.status, 'COMPLETE');
  assert.equal(state.agent.status, 'FINAL');
  assert.equal(state.agent.steps, 16);
  assert.equal(state.agent.toolCalls, 15);
  assert.ok(state.agent.steps > 12, 'past the unchanged DEFAULT maxSteps');
});

test('the panel carries the named guardrails: a 40-action run past the OLD 32-call default reaches FINAL', async () => {
  // Five envelopes of eight actions (the whole per-step allowance): 40 executed actions in 6 steps -
  // more than createGuardrails()'s default maxToolCalls of 32 while staying inside its default
  // maxSteps, so this run isolates the tool-call budget from the step budget.
  const batch = Array.from({ length: 8 }, (_, index) => ['insert_paragraph', { text: `пункт ${index}` }]);
  const f = setup({ response: [toolCalls(...batch), toolCalls(...batch), toolCalls(...batch), toolCalls(...batch), toolCalls(...batch), final('Готово')] });
  f.controller.setMode('EDIT');
  assert.equal(await f.controller.analyze('создай документ'), true);
  const state = f.controller.getState();
  assert.equal(state.status, 'COMPLETE');
  assert.equal(state.agent.status, 'FINAL');
  assert.equal(state.agent.steps, 6);
  assert.equal(state.agent.toolCalls, 40);
  assert.ok(state.agent.toolCalls > 32 && state.agent.steps < 12,
    'past the unchanged DEFAULT maxToolCalls, inside the unchanged DEFAULT maxSteps');
});

test('ASK sends read tools only and never exposes a mutation tool to the model', async () => {
  const f = setup({ response: final() });
  assert.equal(f.controller.getState().mode, 'ASK');
  assert.equal(await f.controller.analyze('сделай'), true);
  const system = f.replies[0][1][0].content;
  assert.equal(system.includes('insert_paragraph'), false);
  assert.equal(system.includes('replace_selection'), false);
  assert.equal(system.includes('read_selection'), true);
  assert.equal(system.includes('Режим: ASK'), true);
  assert.equal(f.controller.getState().agent.actions.length, 0);
  assert.equal(f.controller.getState().preview, null);
});

test('the adapter passes a raw runtime envelope through and re-serializes a parsed Sprint 1 object', async () => {
  const content = JSON.stringify({ type: 'final', message: 'готово' });
  const logged = [];
  const raw = setup({ dependencies: { transport: async (...args) => { logged.push(args); return { content, ignored: true }; } } });
  assert.equal(await raw.controller.analyze('q'), true);
  assert.equal(raw.controller.getState().status, 'COMPLETE');
  assert.deepEqual(raw.controller.getState().chat.history.map(m => m.content), ['q', 'готово']);
  assert.equal(logged[0][3].parse, 'raw');
  assert.equal(logged[0][3].agent, true);
  assert.equal(logged[0][3].mode, 'ASK');
  assert.equal(typeof logged[0][3].deadline, 'number');
  assert.equal(logged[0][3].signal.aborted, false);
  const parsed = setup({ response: { type: 'final', message: 'готово' } });
  assert.equal(await parsed.controller.analyze('q'), true);
  assert.equal(parsed.controller.getState().status, 'COMPLETE');
  assert.equal(parsed.controller.getState().agent.status, 'FINAL');
  const broken = setup({ dependencies: { transport: async () => ({ content: 'not json' }) } });
  // One controlled protocol repair per run, then a classified failure published as a terminal
  // outcome: the malformed text is never rewritten into an executable fallback.
  assert.equal(await broken.controller.analyze('q'), true);
  assert.equal(broken.controller.getState().status, 'PROTOCOL_ERROR');
  assert.equal(broken.controller.getState().agent.status, 'PROTOCOL_ERROR');
});

test('PREVIEW_READY publishes the Sprint 1 Preview from the validated confirm arguments with the TTL intact', async () => {
  const f = setup({ response: toolCalls(['replace_selection', { text: 'замена' }]) });
  f.controller.setMode('EDIT');
  assert.equal(await f.controller.analyze('исправить'), true);
  const state = f.controller.getState();
  assert.equal(state.status, 'PREVIEW_READY');
  assert.deepEqual(state.agent, { status: 'PREVIEW_READY', steps: 1, toolCalls: 0, actions: [] });
  assert.equal(state.preview.replacement, 'замена');
  assert.equal(state.preview.original, 'выделено');
  assert.equal(state.preview.expiresAt, 120100);
  assert.equal('target' in state.preview, false);
  assert.equal(state.canApply, true);
  assert.equal(await f.controller.apply(), true);
  assert.equal(f.controller.getState().status, 'APPLY_ACKNOWLEDGED');
  assert.deepEqual(f.applied, ['замена']);
});

test('UNCERTAIN maps to APPLY_UNCERTAIN and stops the run fail-safe', async () => {
  const f = setup({ response: [
    toolCalls(['insert_paragraph', { text: 'первый' }]),
    toolCalls(['insert_paragraph', { text: 'второй' }]),
    final('never reached')
  ], bridge: { async insertParagraph() { throw new SafeError('APPLY_UNCERTAIN'); } } });
  f.controller.setMode('EDIT');
  // A genuinely uncertain mutation is a terminal outcome the controller publishes and records; the
  // run was not a success, but it was honestly reported, and the record names the closed class.
  assert.equal(await f.controller.analyze('сделай'), true);
  const state = f.controller.getState();
  assert.equal(state.status, 'APPLY_UNCERTAIN');
  assert.equal(state.agent.status, 'UNCERTAIN');
  assert.equal(state.agent.steps, 1);
  assert.equal(state.agent.actions.length, 1);
  assert.equal(state.agent.actions[0].tool, 'insert_paragraph');
  assert.equal(state.agent.actions[0].outcome, 'uncertain');
  assert.equal(state.agent.actions[0].code, 'TOOL_UNCERTAIN');
  assert.equal(f.replies.length, 1, 'the run stops fail-safe: no further step is sent');
  assert.equal(state.chat.history.length, 0);
});

test('LIMIT maps to AGENT_LIMIT and keeps the completed actions', async () => {
  const f = setup({ transport: async () => toolCalls(['read_selection', {}]) });
  f.controller.setMode('EDIT');
  assert.equal(await f.controller.analyze('сделай'), true);
  const state = f.controller.getState();
  assert.equal(state.status, 'AGENT_LIMIT');
  assert.equal(state.agent.status, 'LIMIT');
  // The run stops at the panel's NAMED maxSteps (120), not at the unchanged DEFAULT 12 that ended the
  // owner's pilot request: this is the same carriage the two tests above pin from the other side.
  assert.equal(state.agent.steps, 120);
  assert.equal(state.agent.actions.length, 120);
  assert.equal(state.agent.actions.every(action => action.tool === 'read_selection' && action.outcome === 'ok'), true);
});

test('Stop aborts the running request and keeps the completed actions recorded', async () => {
  const abortSignals = [];
  const secondStep = pending();
  let delivered = 0;
  const hanging = function (settings, messages, uuid, options) {
    abortSignals.push(options.signal);
    delivered += 1;
    if (delivered === 1) return Promise.resolve(toolCalls(['read_selection', {}]));
    secondStep.resolve();
    return new Promise(function (_resolve, reject) {
      if (options.signal.aborted) { reject(new SafeError('CANCELLED')); return; }
      options.signal.addEventListener('abort', function () { reject(new SafeError('CANCELLED')); }, { once: true });
    });
  };
  const f = setup({ transport: hanging });
  f.controller.setMode('EDIT');
  const running = f.controller.analyze('сделай');
  await secondStep.promise;
  f.controller.stop();
  assert.equal(await running, false);
  const state = f.controller.getState();
  assert.equal(state.status, 'STOPPED');
  assert.equal(state.agent.status, 'CANCELLED');
  assert.equal(state.agent.actions.length, 1);
  assert.equal(state.agent.actions[0].tool, 'read_selection');
  assert.equal(state.agent.actions[0].outcome, 'ok');
  assert.equal(abortSignals.length, 2);
  assert.equal(abortSignals[0].aborted, true, 'Stop aborts the owned request of every step');
  assert.equal(state.active, false);
});

test('Stop publishes the actions completed before the abort in the CANCELLED record', async () => {
  const secondStep = pending();
  let delivered = 0;
  const hanging = function (settings, messages, uuid, options) {
    delivered += 1;
    if (delivered === 1) return Promise.resolve(toolCalls(['read_selection', {}]));
    secondStep.resolve();
    return new Promise(function (_resolve, reject) {
      if (options.signal.aborted) { reject(new SafeError('CANCELLED')); return; }
      options.signal.addEventListener('abort', function () { reject(new SafeError('CANCELLED')); }, { once: true });
    });
  };
  const f = setup({ transport: hanging });
  f.controller.setMode('EDIT');
  const running = f.controller.analyze('сделай');
  await secondStep.promise;
  f.controller.stop();
  // The record emitted BY Stop must carry the completed action, not an emptied counter set.
  const stopped = f.controller.getState();
  assert.equal(stopped.status, 'STOPPED');
  assert.equal(stopped.agent.status, 'CANCELLED');
  assert.equal(stopped.agent.steps, 1);
  assert.equal(stopped.agent.toolCalls, 1);
  assert.deepEqual(stopped.agent.actions.map(action => [action.tool, action.outcome]), [['read_selection', 'ok']]);
  assert.equal(await running, false);
});

test('an invalidated run settling after a newer run cannot replace the newer record', async () => {
  const late = pending();
  let calls = 0;
  const f = setup({ transport: async () => {
    calls += 1;
    if (calls === 1) return late.promise;
    return { content: JSON.stringify(final('новый ответ')) };
  } });
  f.controller.setIncludeContext(false);
  const first = f.controller.analyze('старый');
  await new Promise(resolve => setImmediate(resolve));
  f.controller.stop();
  const second = f.controller.analyze('новый');
  assert.equal(await second, true);
  assert.equal(f.controller.getState().agent.status, 'FINAL');
  // The superseded run's request settles LAST: it may not replace the newer run's record.
  late.resolve({ content: JSON.stringify(toolCalls(['read_selection', {}])) });
  assert.equal(await first, false);
  const state = f.controller.getState();
  assert.equal(state.status, 'COMPLETE');
  assert.equal(state.agent.status, 'FINAL', 'the superseded run cannot overwrite the newer record');
  assert.deepEqual(state.agent.actions, []);
  assert.deepEqual(state.chat.history.map(m => m.content), ['новый', 'новый ответ']);
});

test('the newer run publishes its own terminal record unchanged', async () => {
  const late = pending();
  let calls = 0;
  const f = setup({ transport: async () => {
    calls += 1;
    if (calls === 1) return late.promise;
    return { content: JSON.stringify(calls === 2 ? toolCalls(['read_selection', {}]) : final('новый ответ')) };
  } });
  f.controller.setIncludeContext(false);
  const first = f.controller.analyze('старый');
  await new Promise(resolve => setImmediate(resolve));
  f.controller.stop();
  const second = f.controller.analyze('новый');
  assert.equal(await second, true);
  const published = f.controller.getState().agent;
  assert.equal(published.status, 'FINAL');
  assert.equal(published.steps, 2);
  assert.equal(published.toolCalls, 1);
  assert.deepEqual(published.actions.map(action => [action.tool, action.outcome]), [['read_selection', 'ok']]);
  late.resolve({ content: JSON.stringify(final('поздний')) });
  assert.equal(await first, false);
  assert.deepEqual(f.controller.getState().agent, published, 'the newer terminal record is untouched by the late run');
});

test('a late action event after Stop cannot resurrect a running record', async () => {
  const insert = pending();
  let reached = 0;
  const f = setup({ response: [toolCalls(['insert_paragraph', { text: 'абзац' }]), final('поздно')],
    bridge: { async insertParagraph() { reached += 1; return insert.promise; } } });
  f.controller.setMode('EDIT');
  const observed = [];
  const unsubscribe = f.controller.subscribe(state => observed.push(state.agent?.status ?? null));
  const running = f.controller.analyze('сделай');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reached, 1, 'the mutation is in flight when Stop lands');
  f.controller.stop();
  assert.equal(f.controller.getState().agent.status, 'CANCELLED');
  const afterStop = observed.length;
  insert.resolve({ ok: true, data: { sent: true } });
  assert.equal(await running, false);
  unsubscribe();
  assert.equal(observed.slice(afterStop).includes('RUNNING'), false, 'a late action event never republishes a running record');
  assert.equal(f.controller.getState().agent.status, 'CANCELLED');
  assert.equal(f.controller.getState().status, 'STOPPED');
});

test('Stop before the first step cancels the run without inventing actions', async () => {
  const hanging = function (settings, messages, uuid, options) {
    return new Promise(function (_resolve, reject) {
      if (options.signal.aborted) { reject(new SafeError('CANCELLED')); return; }
      options.signal.addEventListener('abort', function () { reject(new SafeError('CANCELLED')); }, { once: true });
    });
  };
  const f = setup({ transport: hanging });
  f.controller.setIncludeContext(false);
  const running = f.controller.analyze('сделай');
  f.controller.stop();
  assert.equal(await running, false);
  const state = f.controller.getState();
  assert.equal(state.agent.status, 'CANCELLED'); assert.deepEqual(state.agent.actions, []);
  assert.equal(state.status, 'STOPPED');
});

// A LONG-GENERATION document the bridge READS: the VERIFY step measures these numbers, and a test moves
// them exactly as an editor would after a pass appended text. The two reads are the same public legs the
// `read_structure` and `read_document_text` tools dispatch.
function longDocument() {
  const doc = { chars: 0, headings: 0, tables: 0, paragraphs: 0, body: '', reads: 0 };
  function structure() {
    doc.reads += 1;
    return { ok: true, pages: Math.max(1, Math.ceil(doc.chars / 1800)),
      statistics: { PageCount: Math.max(1, Math.ceil(doc.chars / 1800)), WordsCount: Math.ceil(doc.chars / 6),
        ParagraphCount: doc.paragraphs, SymbolsCount: doc.chars, SymbolsWSCount: doc.chars },
      counts: { paragraphs: doc.paragraphs, headings: doc.headings, tables: doc.tables, sections: 1 },
      headings: Array.from({ length: doc.headings }, (_value, index) => ({ index, text: `Раздел ${index + 1}` })), truncated: false };
  }
  function text() { return { ok: true, text: doc.body, totalChars: doc.body.length }; }
  return { doc, structure, text };
}
// The plan pass and the execute passes as the MODEL answers them. Each execute answer names ONE
// `insert_blocks` batch, and the bridge-side effect of that batch is applied to the same document the
// verify step reads — a mutation the panel never sees as a claim, only as a measurement afterwards.
const orchestrationPlan = JSON.stringify({ sections: ['Введение', 'Глава 1', 'Глава 2', 'Выводы'],
  targetCharacters: 18000, required: { tables: true, lists: true, conclusions: true }, summary: 'структура' });
function orchestrationTransport(doc) {
  const requests = [];
  let step = 0;
  return { requests, transport: async (settings, messages) => {
    const user = messages[messages.length - 1].content;
    requests.push(user);
    step += 1;
    if (step === 1) return { content: JSON.stringify({ type: 'final', message: orchestrationPlan }) };
    // Every execute answer appends ONE batch and the panel's own verify step sees the document grow the
    // way an editor would. The volume reaches 5000 characters and ONE table in the FIRST execute pass, and
    // the model then ends that pass — which is exactly the measured pilot shape — so the verify finds it
    // far short of the criteria (the request asks for tables and the plan raises the volume) and one
    // continuation is required. The SECOND pass takes the document to the target and to its second table.
    doc.chars = Math.min(doc.chars + 1000, 19000);
    doc.paragraphs = Math.min(doc.paragraphs + 2, 30);
    doc.headings = 4; doc.tables = doc.chars === 5000 ? 1 : 2;
    doc.body = 'Выводы\n- пункт\n- пункт 2\n' + 'текст '.repeat(20);
    if (doc.chars === 5000 || doc.chars === 19000) return { content: JSON.stringify({ type: 'final', message: 'проход завершён' }) };
    return { content: JSON.stringify({ type: 'tool_calls', calls: [{ tool: 'insert_blocks',
      arguments: { blocks: [{ text: 'абзац', heading: 1 }, { text: 'абзац 2' }] } }] }) };
  } };
}
async function orchestrated(options = {}) {
  const model = longDocument();
  const run = orchestrationTransport(model.doc);
  const f = setup({ bridge: { readStructure: model.structure, readDocumentText: model.text, ...options.bridge },
    transport: options.transport ?? run.transport });
  f.controller.setMode('EDIT');
  await f.controller.analyze('создай структурированный документ примерно на 10 страниц, добавь главы, несколько таблиц, списки, выводы');
  return { ...f, model, requests: run.requests };
}
test('a long-generation request is planned, executed in parts, measured and continued until the plan holds', async () => {
  const f = await orchestrated();
  const state = f.controller.getState();
  const record = state.orchestration;
  assert.ok(record, 'the panel publishes the orchestration report');
  assert.equal(record.phase, 'complete');
  assert.equal(record.status, 'ORCH_COMPLETE');
  assert.equal(state.status, 'ORCH_COMPLETE');
  assert.equal(record.pass, 2, 'the first pass left the volume short, so exactly one more was run');
  assert.equal(record.maxPasses, 12);
  assert.equal(record.targetChars, 18000);
  assert.equal(record.plan.sections.length, 4);
  // The ENFORCED criteria and the request-derived floor are published with the report, so a native check
  // can read exactly what was required: the request's own two tables, its conclusion and the plan's volume.
  assert.deepEqual(record.floor, { targetChars: 18000, tables: 2, conclusions: true, sections: 2 });
  assert.deepEqual(record.criteria, { targetChars: 18000, tables: 2, lists: true, sections: 4, conclusions: true });
  // The verified numbers are the READ ones, not the model's: the first pass ended at 5000 characters and
  // the document was measured again after the second.
  assert.equal(record.verified.chars, 19000);
  assert.equal(record.verified.headings, 4);
  assert.equal(record.verified.tables, 2);
  assert.ok(record.verified.paragraphs >= 12);
  assert.deepEqual(record.missing, []);
  assert.equal(record.error, null);
  // The plan pass asked for the plan ONLY; the execute passes carried the plan and then the missing list.
  const planRequest = f.requests[0];
  const firstExecute = f.requests[1];
  const continuation = f.requests.find(text => text.includes('ПРЕДЫДУЩИЙ ПРОХОД НЕ ВЫПОЛНИЛ ПЛАН'));
  assert.match(planRequest, /ТОЛЬКО ПЛАН/);
  assert.equal(planRequest.includes('УТВЕРЖДЁННЫЙ ПЛАН'), false);
  assert.match(firstExecute, /УТВЕРЖДЁННЫЙ ПЛАН/);
  assert.match(firstExecute, /insert_blocks/);
  assert.ok(continuation, 'the second execute pass names what the first left missing');
  assert.match(continuation, /объём: 5000 из 18000 знаков/);
  assert.match(continuation, /таблиц 1 из 2/, 'the missing list names the unmet TABLE criterion with its numbers');
  // The missing list names EXACTLY what the read proved absent: the sections, the list and the conclusions
  // were already measured present, so only the volume and the second table are asked for.
  assert.equal(continuation.includes('разделов (заголовков)'), false);
  assert.equal(continuation.includes('списков нет ни одного'), false);
  assert.equal(continuation.includes('заключения нет'), false);
  assert.match(continuation, /ОГРАНИЧЕНИЯ ЭТОГО РЕЖИМА: Профиль 'bulk'/);
  assert.equal(f.controller.getState().chat.history.length, 0, 'the panel\'s own wording never becomes chat history');
});
test('an uncertain action stops the orchestration with no retry and names the unverified tool', async () => {
  const model = longDocument();
  let dispatches = 0;
  const transport = async (settings, messages) => {
    dispatches += 1;
    if (dispatches === 1) return { content: JSON.stringify({ type: 'final', message: orchestrationPlan }) };
    return { content: JSON.stringify({ type: 'tool_calls', calls: [{ tool: 'insert_blocks',
      arguments: { blocks: [{ text: 'абзац' }] } }] }) };
  };
  const f = setup({ bridge: { readStructure: model.structure, readDocumentText: model.text,
    async insertBlocks() { throw new SafeError('APPLY_UNCERTAIN'); } }, transport });
  f.controller.setMode('EDIT');
  await f.controller.analyze('создай документ примерно на 10 страниц с главами и таблицами');
  const state = f.controller.getState();
  assert.equal(state.status, 'ORCH_UNCERTAIN');
  assert.equal(state.orchestration.phase, 'uncertain');
  assert.equal(state.orchestration.error, 'TOOL_UNCERTAIN');
  assert.equal(state.orchestration.pass, 1);
  assert.deepEqual(state.orchestration.missingTools, ['insert_blocks']);
  assert.equal(dispatches, 2, 'no further pass is started after an uncertain write');
  assert.equal(state.agent.actions[0].outcome, 'uncertain');
});
test('the execute-pass budget is capped and the panel reports an honest incomplete list', async () => {
  const calls = [];
  const transport = async (settings, messages) => {
    const user = messages[messages.length - 1].content;
    calls.push(user);
    if (user.includes('ТОЛЬКО ПЛАН')) return { content: JSON.stringify({ type: 'final', message: orchestrationPlan }) };
    // Every execute pass appends nothing the verify step can see, so the plan never holds. The
    // orchestration must stop at its named cap and report what is still missing, not loop forever.
    return { content: JSON.stringify({ type: 'tool_calls', calls: [{ tool: 'insert_blocks',
      arguments: { blocks: [{ text: 'абзац' }] } }] }) };
  };
  const model = longDocument();
  const f = setup({ bridge: { readStructure: model.structure, readDocumentText: model.text }, transport });
  f.controller.setMode('EDIT');
  await f.controller.analyze('создай документ примерно на 10 страниц с главами, таблицами и выводами');
  const record = f.controller.getState().orchestration;
  assert.equal(f.controller.getState().status, 'ORCH_INCOMPLETE');
  assert.equal(record.phase, 'incomplete');
  assert.equal(record.error, 'PASS_BUDGET_EXHAUSTED');
  assert.equal(record.pass, 12, 'the named cap is twelve execute passes');
  assert.equal(record.verified.chars, 0);
  assert.ok(record.missing.length > 0);
  // The execute requests are the plan pass plus exactly twelve execute passes, and the last eleven of them
  // carry the missing list the previous verify measured. The `ТОЛЬКО ПЛАН` phrase also appears inside the
  // bulk PROFILES's own authored line, so the plan pass is identified by its own opening line instead.
  const planRequests = calls.filter(text => text.startsWith('Ниже — задача владельца. Сейчас НУЖЕН ТОЛЬКО ПЛАН'));
  const executeRequests = calls.filter(text => text.startsWith('Ниже — задача владельца и уже утверждённый ПЛАН'));
  const continuations = executeRequests.filter(text => text.includes('ПРЕДЫДУЩИЙ ПРОХОД НЕ ВЫПОЛНИЛ ПЛАН'));
  assert.equal(planRequests.length, 1);
  assert.equal(executeRequests.length, 12);
  assert.equal(continuations.length, 11);
  // Every execute pass states the criteria it will be measured against, including the last one.
  assert.equal(executeRequests.filter(text => text.includes('КРИТЕРИИ ПРИЁМКИ')).length, 12);
});
test('an unusable plan stops before any execute pass and reports it honestly', async () => {
  const sent = [];
  const f = setup({ transport: async (settings, messages) => {
    sent.push(messages[messages.length - 1].content);
    return { content: JSON.stringify({ type: 'final', message: 'не план' }) };
  } });
  f.controller.setMode('EDIT');
  await f.controller.analyze('создай документ примерно на 10 страниц');
  const record = f.controller.getState().orchestration;
  assert.equal(record.phase, 'incomplete');
  assert.equal(record.error, 'PLAN_UNUSABLE');
  assert.equal(record.pass, 0);
  assert.equal(record.plan, null);
  // The plan text the model wrote is NOT published as an authoring plan, and no execute pass ran: the
  // one request sent is the plan pass itself.
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Сейчас НУЖЕН ТОЛЬКО ПЛАН/);
});
test('the ordinary single-run path is unchanged: only a long-generation EDIT request is orchestrated', async () => {
  // The same long request in ASK exposes no mutation tool, so it is not an authoring task.
  const ask = setup({ response: final('ответ') });
  assert.equal(await ask.controller.analyze('документ примерно на 10 страниц'), true);
  assert.equal(ask.controller.getState().status, 'COMPLETE');
  assert.equal(ask.controller.getState().orchestration, null);
  assert.equal(ask.replies.length, 1);
  // An EDIT request that names no volume, several parts or a count keeps the single-run path.
  const edit = setup({ response: final('ответ') });
  edit.controller.setMode('EDIT');
  assert.equal(await edit.controller.analyze('исправь орфографию'), true);
  assert.equal(edit.controller.getState().status, 'COMPLETE');
  assert.equal(edit.controller.getState().orchestration, null);
  assert.equal(edit.replies.length, 1);
  // The preview/apply path is untouched by the orchestration: a confirm proposal still publishes the
  // Sprint 1 Preview from the ordinary single run.
  const preview = setup({ response: toolCalls(['replace_selection', { text: 'замена' }]) });
  preview.controller.setMode('EDIT');
  assert.equal(await preview.controller.analyze('исправь орфографию'), true);
  assert.equal(preview.controller.getState().status, 'PREVIEW_READY');
  assert.equal(preview.controller.getState().orchestration, null);
});

// --- Exit gate: the read-only capability probe must be EDITOR-AWARE --------------------------------
// MEASURED: on a healthy workbook the panel answered `R7_CHECK_UNAVAILABLE`, because the probe required the Word
// editor and then decoded a Word-only six-boolean payload. A Cell bridge has no Word method to probe at all — it
// reports its capabilities LOCALLY, with `methodPresence` null by construction — and the exit-gate run reads and
// mutates sheets through exactly that adapter. The Word path is untouched: these tests pin BOTH sides.

test('a CELL bridge reports presence for a spreadsheet instead of R7_CHECK_UNAVAILABLE', async () => {
  const readings = [];
  const cellBridge = {
    getState() { return { editorType: 'cell', busy: false, uncertain: false }; },
    invalidate() {},
    async probeCapabilities() {
      readings.push('probed');
      return Object.freeze({
        editorType: 'cell',
        // THE REAL SHAPE, from the bridge's own measured report: the adapter is an OBJECT naming the primitives,
        // not a string. The first version of this test used a string, so the branch under test refused a perfectly
        // usable spreadsheet — a rig that did not match the bridge is what hid the defect.
        adapter: Object.freeze({ executeMethod: false, commandDispatch: true, commandMethod: 'callCommand' }),
        methodPresence: null,
        runtimeVerified: false,
        selectionRead: Object.freeze({ available: false, runtimeVerified: false, reason: 'NO_SELECTION_IN_CELL' }),
        mutation: Object.freeze({ available: false, runtimeVerified: false, reason: 'EXPLICIT_OWNED_PREVIEW_REQUIRED' })
      });
    }
  };
  const f = setup({ dependencies: { bridge: cellBridge } });
  f.controller.reset();
  assert.equal(await f.controller.checkR7(), true, 'a workbook with a usable adapter is READY, not unavailable');
  assert.equal(f.controller.getState().status, 'R7_PRESENCE_READY');
  assert.equal(f.controller.getState().capabilityCount, 0, 'the count is the reported availability flags, not a Word list');
  assert.deepEqual(readings, ['probed'], 'and the bridge really was asked');
});

test('a SLIDE bridge reports presence for a healthy presentation', async () => {
  const readings = [];
  const slideBridge = {
    getState() { return { editorType: 'slide', busy: false, uncertain: false }; },
    invalidate() {},
    async probeCapabilities() {
      readings.push('probed');
      return Object.freeze({
        editorType: 'slide',
        adapter: Object.freeze({ executeMethod: false, commandDispatch: true, commandMethod: 'callCommand' }),
        methodPresence: null,
        runtimeVerified: false,
        selectionRead: Object.freeze({ available: true, runtimeVerified: false, reason: null }),
        mutation: Object.freeze({ available: false, runtimeVerified: false, reason: 'EXPLICIT_OWNED_PREVIEW_REQUIRED' })
      });
    }
  };
  const f = setup({ dependencies: { bridge: slideBridge } });
  f.controller.reset();
  assert.equal(await f.controller.checkR7(), true, 'a presentation with a usable adapter is READY, not unavailable');
  assert.equal(f.controller.getState().status, 'R7_PRESENCE_READY');
  assert.equal(f.controller.getState().capabilityCount, 1, 'count only the true reported availability flags');
  assert.deepEqual(readings, ['probed'], 'and the bridge really was asked');
});

test('a SLIDE bridge with executeMethod alone reports presentation presence', async () => {
  const readings = [];
  const slideBridge = {
    getState() { return { editorType: 'slide', busy: false, uncertain: false }; },
    invalidate() {},
    async probeCapabilities() {
      readings.push('probed');
      return Object.freeze({
        editorType: 'slide',
        adapter: Object.freeze({ executeMethod: true, commandDispatch: false, commandMethod: null }),
        methodPresence: null,
        runtimeVerified: false,
        selectionRead: Object.freeze({ available: true, runtimeVerified: false, reason: null }),
        mutation: Object.freeze({ available: false, runtimeVerified: false, reason: 'EXPLICIT_OWNED_PREVIEW_REQUIRED' })
      });
    }
  };
  const f = setup({ dependencies: { bridge: slideBridge } });
  f.controller.reset();
  assert.equal(await f.controller.checkR7(), true);
  assert.equal(f.controller.getState().status, 'R7_PRESENCE_READY');
  assert.equal(f.controller.getState().capabilityCount, 1);
  assert.deepEqual(readings, ['probed']);
});

for (const [name, editorType, adapter] of [
  ['mismatched editor type', 'word', { executeMethod: false, commandDispatch: true, commandMethod: 'callCommand' }],
  ['NO usable adapter primitive', 'slide', { executeMethod: false, commandDispatch: false, commandMethod: null }]
]) {
  test(`a SLIDE bridge with ${name} is refused`, async () => {
    const readings = [];
    const unavailable = { getState() { return { editorType: 'slide', busy: false }; }, invalidate() {},
      async probeCapabilities() { readings.push('probed'); return { editorType, methodPresence: null,
        adapter: Object.freeze(adapter),
        selectionRead: { available: true, runtimeVerified: false, reason: null },
        mutation: { available: false, runtimeVerified: false, reason: 'EXPLICIT_OWNED_PREVIEW_REQUIRED' } }; } };
    const f = setup({ dependencies: { bridge: unavailable } });
    f.controller.reset();
    assert.equal(await f.controller.checkR7(), false);
    assert.equal(f.controller.getState().status, 'R7_CHECK_UNAVAILABLE');
    assert.equal(f.controller.getState().capabilityCount, null);
    assert.deepEqual(readings, ['probed']);
  });
}

for (const flag of ['selectionRead', 'mutation']) {
  test(`a SLIDE bridge with non-boolean ${flag} availability reports invalid data`, async () => {
    const malformed = { getState() { return { editorType: 'slide', busy: false }; }, invalidate() {},
      async probeCapabilities() { return { editorType: 'slide', methodPresence: null,
        adapter: Object.freeze({ executeMethod: true, commandDispatch: false, commandMethod: null }),
        selectionRead: { available: flag === 'selectionRead' ? 'true' : true, runtimeVerified: false, reason: null },
        mutation: { available: flag === 'mutation' ? 0 : false, runtimeVerified: false, reason: 'EXPLICIT_OWNED_PREVIEW_REQUIRED' } }; } };
    const f = setup({ dependencies: { bridge: malformed } });
    f.controller.reset();
    assert.equal(await f.controller.checkR7(), false);
    assert.equal(f.controller.getState().status, 'INVALID_DATA');
    assert.equal(f.controller.getState().capabilityCount, null);
  });
}

test('a CELL bridge with NO usable adapter primitive is refused', async () => {
  // Readiness is that ONE of the named primitives is available: an object naming two unavailable ones is not an
  // adapter, and the panel must say so rather than offer a run that cannot dispatch anything.
  const unusable = { getState() { return { editorType: 'cell', busy: false }; }, invalidate() {},
    async probeCapabilities() { return { editorType: 'cell', methodPresence: null,
      adapter: Object.freeze({ executeMethod: false, commandDispatch: false, commandMethod: null }),
      selectionRead: { available: false, runtimeVerified: false, reason: 'READ_UNAVAILABLE' },
      mutation: { available: false, runtimeVerified: false, reason: 'EXPLICIT_OWNED_PREVIEW_REQUIRED' } }; } };
  const f = setup({ dependencies: { bridge: unusable } });
  f.controller.reset();
  assert.equal(await f.controller.checkR7(), false);
  assert.equal(f.controller.getState().status, 'R7_CHECK_UNAVAILABLE');
});

test('a CELL bridge that reports a misleading payload is refused, and the WORD decode is unchanged', async () => {
  // A cell bridge claiming the WORD shape must not be believed: the payload has to describe the editor it came from.
  const liar = { getState() { return { editorType: 'cell', busy: false }; }, invalidate() {},
    async probeCapabilities() { return { editorType: 'word', adapter: 'executeMethod', methodPresence: { api: true } }; } };
  const f = setup({ dependencies: { bridge: liar } });
  f.controller.reset();
  assert.equal(await f.controller.checkR7(), false);
  assert.equal(f.controller.getState().status, 'R7_CHECK_UNAVAILABLE');

  // And a WORD bridge keeps its exact previous behaviour: six booleans, counted.
  const wordBridge = { getState() { return { editorType: 'word', busy: false }; }, invalidate() {},
    async probeCapabilities() { return { editorType: 'word', adapter: 'executeMethod',
      methodPresence: { api: true, getDocument: true, getDocumentId: false, replaceTextSmart: true, getRangeBySelect: false, isTrackRevisions: false } }; } };
  const w = setup({ dependencies: { bridge: wordBridge } });
  w.controller.reset();
  assert.equal(await w.controller.checkR7(), true);
  assert.equal(w.controller.getState().status, 'R7_PRESENCE_READY');
  assert.equal(w.controller.getState().capabilityCount, 3, 'the Word count is the six-boolean sum, as before');
});
