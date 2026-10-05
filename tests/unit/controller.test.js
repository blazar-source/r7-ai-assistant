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
