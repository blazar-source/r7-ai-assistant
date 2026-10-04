import { LIMITS } from '../shared/limits.js';
import { assertByteLimit, utf8ByteLength } from '../shared/bytes.js';
import { ERROR_CODES, SafeError } from '../shared/errors.js';
import { validateSettings, validateRequestSettings } from '../config/settings.js';
import { SettingsStore } from '../config/storage.js';
import { createChatSession, createConnectionSession, appendChatPair } from '../shared/session.js';
import { requestCompletion } from '../ai/transport.js';
import { runAgent } from '../agent/runtime.js';
import { createRegistry } from '../tools/registry.js';
import { createWordTools } from '../tools/word.js';

const noContext = () => Object.freeze({ kind: 'UNKNOWN', text: '', bytes: 0, ownershipVerified: false });
function safeCode(error) { return error instanceof SafeError ? error.code : ERROR_CODES.INTERNAL_ERROR; }
// The catalogue is filtered by capability keys, and the only capability this controller can honestly
// state without guessing about the installed SDK is what §6/§9 make structural: a Word editor the
// controller already reads and (under its own owned-target proof) applies to. Every action is still
// refused at dispatch by the bridge's own owned-target check, which is the authority.
const CAPABILITIES = Object.freeze(['document.read', 'document.write']);
// The Agent Runtime's terminal vocabulary mapped onto the controller's existing status codes (§8).
const RUN_STATUS = Object.freeze({ FINAL: 'COMPLETE', PREVIEW_READY: 'PREVIEW_READY', UNCERTAIN: 'APPLY_UNCERTAIN',
  LIMIT: 'AGENT_LIMIT', CANCELLED: 'CANCELLED', PROTOCOL_ERROR: 'PROTOCOL_ERROR' });
const CONNECTION_REQUEST = 'Проверка соединения. Ответь JSON final.';

// Multi-step Agent Runtime run + explicit Preview/Apply only. Ownership capabilities stay private;
// neither model proposals nor public UI snapshots can supply an editor target.
export function createController({ bridge, store = new SettingsStore(), transport = requestCompletion,
  crypto = globalThis.crypto, clock = { now: () => Date.now() },
  timers = { schedule(callback, ms) { return setTimeout(function () { callback(); }, ms); }, clear(id) { clearTimeout(id); } }
} = {}) {
  let stored = store.load();
  let chat = createChatSession(crypto);
  let mode = 'ASK';
  let includeContext = true;
  let context = noContext();
  let status = 'READY';
  let generation = 0;
  let active = null;
  let preview = null;
  let previewTarget = null;
  let previewOwner = null;
  let previewTimer = null;
  let capabilityCount = null;
  let agent = null;
  let registryBuilt = false;
  let registry = null;
  let disposed = false;
  const listeners = new Set();
  // Built exactly once from the injected bridge; a descriptor failure is a load-time contract
  // failure that surfaces as a closed code instead of a raw exception in the UI.
  function registryOrNull() {
    if (!registryBuilt) {
      registryBuilt = true;
      try { registry = createRegistry(createWordTools(bridge)); } catch { registry = null; }
    }
    return registry;
  }
  function now() {
    const value = clock.now();
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new SafeError(ERROR_CODES.INTERNAL_ERROR);
    return value;
  }
  function clear(timer) { if (timer !== null) { try { timers.clear(timer); } catch {} } }
  function dropPreview() { clear(previewTimer); previewTimer = null; preview = null; previewTarget = null; previewOwner = null; }
  // One content-free technical record of the last run. It never carries the model's envelope,
  // arguments, results or document text — only the closed status, the counters and the action lines.
  function runRecord(runStatus) {
    const counters = active?.agent;
    return Object.freeze({ status: runStatus, steps: counters?.steps ?? 0, toolCalls: counters?.toolCalls ?? 0,
      actions: counters?.actions ?? Object.freeze([]) });
  }
  function writeLocked() { return active?.dispatched === true || bridge?.getState().writePending === true; }
  function canApply() {
    return !disposed && !active && !writeLocked() && mode === 'EDIT' && preview !== null && previewOwner?.generation === generation &&
      now() < preview.expiresAt && bridge?.canApply?.(previewTarget) === true;
  }
  function snapshot() {
    return Object.freeze({ status, active: active !== null, mode, includeContext, context, chat,
      settings: stored.settings, keyPersistenceWarning: stored.keyPersistenceWarning, storageError: stored.storageError,
      preview, capabilityCount, agent, canApply: canApply(), writeLocked: writeLocked(), generation, editorType: bridge?.getState().editorType ?? 'unknown',
      mutationReason: 'EXPLICIT_OWNED_PREVIEW_REQUIRED', runtimeVerified: false, lifecycleEventsVerified: false });
  }
  function emit() { if (disposed) return; const state = snapshot(); for (const listener of listeners) listener(state); }
  // Late real callback settlement may unlock controls, never publish late content,
  // overwrite the unknown receipt, resurrect Preview or append chat history.
  const unsubscribeBridge = bridge?.subscribe?.(function () { if (!disposed) emit(); });
  function invalidate(nextStatus = 'READY', forgetContext = false) {
    generation++;
    const old = active;
    active = null;
    if (old) { clear(old.timer); old.abort.abort(); }
    bridge?.invalidate();
    dropPreview();
    capabilityCount = null;
    if (forgetContext) context = noContext();
    status = old?.dispatched ? 'APPLY_UNCERTAIN' : nextStatus;
    if (agent !== null && agent.status === 'RUNNING') agent = runRecord('CANCELLED');
  }
  function valid(owned) {
    if (disposed || active !== owned || generation !== owned.generation) return false;
    if (now() >= owned.deadline) {
      invalidate('TIMEOUT', true); emit(); return false;
    }
    return true;
  }
  function begin(kind) {
    if (disposed || active || writeLocked()) return null;
    dropPreview();
    const deadline = now() + LIMITS.operationTimeoutMs; // BEFORE any context/SDK work
    const owned = { kind, generation: ++generation, settings: validateRequestSettings(stored.settings),
      mode: kind === 'connection' ? 'ASK' : mode, includeContext, uuid: kind === 'connection' ? createConnectionSession(crypto).uuid : chat.uuid,
      editorType: bridge?.getState().editorType ?? 'unknown', deadline, abort: new AbortController(), timer: null };
    active = owned;
    status = kind === 'connection' ? 'CONNECTING' : kind === 'context' ? 'READING_CONTEXT' : 'ANALYZING';
    try {
      owned.timer = timers.schedule(function () {
        if (active === owned) { invalidate('TIMEOUT', true); emit(); }
      }, LIMITS.operationTimeoutMs);
    } catch (error) { active = null; owned.abort.abort(); throw error; }
    emit();
    return owned;
  }
  function finish(owned, nextStatus, publish = function () {}) {
    if (!valid(owned)) return false;
    publish();
    clear(owned.timer); active = null; status = nextStatus; emit(); return true;
  }
  function fail(owned, error) {
    if (owned && active !== owned) return false;
    if (owned) { clear(owned.timer); owned.abort.abort(); active = null; }
    status = owned?.dispatched ? 'APPLY_UNCERTAIN' : safeCode(error); emit(); return false;
  }
  async function read(owned) {
    const platform = bridge?.getState();
    if (platform?.busy) throw new SafeError(ERROR_CODES.EDITOR_BUSY);
    if (platform?.editorType !== 'word') {
      context = Object.freeze({ kind: 'UNAVAILABLE', text: '', bytes: 0, ownershipVerified: false });
      throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
    }
    const result = await bridge.readSelection({ signal: owned.abort.signal });
    if (!valid(owned)) return null;
    assertByteLimit(result.text, LIMITS.selectionBytes);
    // Public context contains text and a bounded indicator only, never ID/token.
    context = Object.freeze({ kind: result.text === '' ? 'EMPTY' : 'EXACT', text: result.text,
      bytes: utf8ByteLength(result.text), ownershipVerified: result.eligible === true && bridge.canApply?.(result.target) === true });
    return result;
  }
  // A confirm-policy proposal becomes the SAME Preview object Sprint 1 published: the validated
  // replacement text and the run's own TTL. The owned editor target still comes only from the
  // private capture, never from the model's arguments, and Apply re-checks it.
  function previewFrom(done, captured) {
    if (done.status !== 'PREVIEW_READY' || !done.preview) return null;
    const eligible = captured?.text !== '' && captured?.eligible === true && bridge?.canApply?.(captured.target) === true;
    if (!eligible) return null;
    return Object.freeze({ replacement: done.preview.arguments.text, original: captured.text, expiresAt: now() + LIMITS.previewTtlMs });
  }
  function statusFor(kind, done, candidate) {
    if (kind === 'connection') return 'CONNECTION_OK';
    if (done.status === 'PREVIEW_READY') return candidate ? RUN_STATUS.PREVIEW_READY : 'CAPABILITY_UNAVAILABLE';
    if (done.status === 'ERROR') return done.code ?? ERROR_CODES.INTERNAL_ERROR;
    return RUN_STATUS[done.status] ?? ERROR_CODES.INTERNAL_ERROR;
  }
  // Publishes the terminal outcome for one owned run. The non-final run record is already stored in
  // `agent`; only a final answer or a proposal appends a chat pair, and only a proposal exposes one.
  // `target` is the private owned selection capture for this run, never model data.
  function settle(owned, nextStatus, append, candidate, target) {
    return finish(owned, nextStatus, function () {
      if (append) chat = appendChatPair(chat, append.user, append.assistant);
      if (candidate) {
        const timer = timers.schedule(function () {
          if (preview === candidate) { dropPreview(); status = 'PREVIEW_EXPIRED'; emit(); }
        }, LIMITS.previewTtlMs);
        previewTimer = timer; preview = candidate; previewTarget = target; previewOwner = owned;
      }
    });
  }
  // Drives one owned run through the bounded Agent Runtime. The injected Sprint 1 transport keeps its
  // own signature and is adapted to the runtime's shape here; completion publishes only after the
  // ownership/deadline recheck, exactly like the single-shot path did.
  async function run(kind, user) {
    if (disposed || active || writeLocked()) return false;
    let owned = null;
    try {
      if (kind === 'analysis') assertByteLimit(user, LIMITS.userInputBytes);
      owned = begin(kind);
      let capturedRun = null;
      if (kind === 'analysis' && owned.includeContext) capturedRun = await read(owned);
      if (!valid(owned)) return false;
      const settings = owned.settings;
      const uuid = owned.uuid;
      const deadline = owned.deadline;
      const signal = owned.abort.signal;
      // The runtime calls transport(messages, { signal, deadline }) and consumes { content }.
      // Owned.dispatch records a still-pending request so a valid() recheck can never publish a
      // snapshot that shows the operation over while its own settlement is still awaited (e.g. a
      // synchronously delivered transport result).
      const send = function (messages) {
        if (now() >= deadline) throw new SafeError(ERROR_CODES.TIMEOUT);
        let settleRequest = null;
        owned.dispatch = new Promise(function (resolve) { settleRequest = resolve; });
        const dispatched = owned.dispatch;
        try {
          const response = transport(settings, messages, uuid, { parse: 'raw', agent: true, mode: owned.mode, uuid, signal, deadline });
          Promise.resolve(response).then(function (value) {
            if (value !== null && typeof value === 'object' && typeof value.content === 'string') return Object.freeze({ content: value.content });
            // Sprint 1 injected transports answer with the parsed model object; re-serialize it so
            // the runtime's own closed protocol validation stays the single parser.
            return Object.freeze({ content: JSON.stringify(value) });
          }).then(function (envelope) { settleRequest(envelope); }, function (error) { settleRequest(Promise.reject(error)); });
        } catch (error) {
          owned.dispatch = null;
          throw error;
        }
        return dispatched;
      };
      owned.agent = { status: 'RUNNING', steps: 0, toolCalls: 0, actions: [] };
      agent = owned.agent;
      emit();
      const done = await runAgent({ registry: registryOrNull(), editor: owned.editorType, capabilities: CAPABILITIES,
        mode: owned.mode, settings, uuid, request: kind === 'connection' ? CONNECTION_REQUEST : user,
        signal, transport: send, now,
        onEvent(event) {
          // One line per completed action: the tool name and the closed outcome only. The raw
          // envelope, arguments and results never reach the record or the DOM.
          owned.agent = Object.freeze({ status: 'RUNNING', steps: event.steps, toolCalls: owned.agent.toolCalls + 1,
            actions: Object.freeze([...owned.agent.actions, Object.freeze({ tool: event.tool, outcome: event.outcome })]) });
          agent = owned.agent;
          emit();
        } });
      // The terminal run record is committed even for a superseded owner: it is content-free and
      // carries no control decision, while the STATUS assignment below stays generation-guarded so a
      // late run can never overwrite the invalidating status.
      agent = Object.freeze({ status: done.status, steps: done.steps, toolCalls: done.toolCalls, actions: done.actions });
      if (active === owned) owned.agent = agent;
      const dispatched = owned.dispatch;
      owned.dispatch = null;
      // A transport that already answered synchronously has NOT handed control back yet, so awaiting
      // its recorded settlement keeps the ownership/deadline recheck below on every path.
      if (dispatched) await dispatched;
      if (active !== owned || generation !== owned.generation) { emit(); return false; }
      if (now() >= deadline) { invalidate('TIMEOUT', true); emit(); return false; }
      const captured = kind === 'analysis' && capturedRun !== null && capturedRun.text !== '' ? capturedRun : null;      const candidate = previewFrom(done, captured);
      const reply = done.status === 'FINAL' && typeof done.message === 'string' ? done.message : candidate ? candidate.replacement : '';
      const append = kind === 'analysis' && (done.status === 'FINAL' || candidate) ? { user, assistant: reply } : null;
      return settle(owned, statusFor(kind, done, candidate), append, candidate, captured ? captured.target : null);
    } catch (error) { return fail(owned, error); }
  }
  return Object.freeze({
    getState: snapshot,
    subscribe(listener) { listeners.add(listener); listener(snapshot()); return function () { listeners.delete(listener); }; },
    analyze(user) { return run('analysis', user); },
    testConnection() { return run('connection'); },
    async checkR7() {
      if (disposed || active || writeLocked()) return false;
      let owned = null;
      try {
        // Local read-only check: no credential validation, UUID or AI request.
        const deadline = now() + LIMITS.operationTimeoutMs;
        invalidate('CHECKING_R7');
        owned = { kind: 'capabilities', generation, deadline, abort: new AbortController(), timer: null };
        active = owned;
        owned.timer = timers.schedule(function () { if (active === owned) { invalidate('TIMEOUT', true); emit(); } }, LIMITS.operationTimeoutMs);
        emit();
        const platform = bridge?.getState();
        if (platform?.busy) throw new SafeError(ERROR_CODES.EDITOR_BUSY);
        if (platform?.editorType !== 'word' || typeof bridge?.probeCapabilities !== 'function') {
          finish(owned, 'R7_CHECK_UNAVAILABLE'); return false;
        }
        const capabilities = await bridge.probeCapabilities({ signal: owned.abort.signal });
        if (!valid(owned)) return false;
        const flags = capabilities?.methodPresence;
        if (!flags) { finish(owned, 'R7_CHECK_UNAVAILABLE'); return false; }
        // The owned bridge decodes a closed six-boolean schema. Retain only a
        // count, never callback JSON, identifiers, API handles or method source.
        const booleans = [flags.api, flags.getDocument, flags.getDocumentId, flags.replaceTextSmart, flags.getRangeBySelect, flags.isTrackRevisions];
        if (booleans.some(value => typeof value !== 'boolean')) throw new SafeError(ERROR_CODES.INVALID_DATA);
        const count = booleans.filter(value => value === true).length;
        return finish(owned, 'R7_PRESENCE_READY', function () { capabilityCount = count; });
      } catch (error) { return fail(owned, error); }
    },
    async refreshContext() {
      if (disposed || active || writeLocked()) return false;
      let owned = null;
      try {
        // A read is permitted without connection credentials.
        const settings = stored.settings;
        const deadline = now() + LIMITS.operationTimeoutMs;
        invalidate('READING_CONTEXT', true);
        owned = { kind: 'context', generation, settings, deadline, abort: new AbortController(), timer: null };
        active = owned;
        owned.timer = timers.schedule(function () { if (active === owned) { invalidate('TIMEOUT', true); emit(); } }, LIMITS.operationTimeoutMs);
        emit(); await read(owned); return finish(owned, 'CONTEXT_READY');
      } catch (error) { return fail(owned, error); }
    },
    settingsChanged() { if (disposed || writeLocked()) return; invalidate('SETTINGS_CHANGED'); emit(); },
    saveSettings(raw) {
      if (disposed || writeLocked()) return false;
      invalidate('SETTINGS_CHANGED');
      try { const settings = validateSettings(raw); stored = store.save(settings); status = 'SETTINGS_SAVED'; emit(); return true; }
      catch (error) { status = safeCode(error); emit(); return false; }
    },
    setMode(next) { if (!['ASK', 'EDIT'].includes(next) || disposed || writeLocked()) return false; if (mode !== next) { invalidate(); mode = next; emit(); } return true; },
    setIncludeContext(next) { if (typeof next !== 'boolean' || disposed || writeLocked()) return false; if (includeContext !== next) { invalidate(); includeContext = next; emit(); } return true; },
    contextChanged() { if (disposed) return; invalidate('CONTEXT_CHANGED', true); emit(); },
    selectionChanged() {
      if (disposed || writeLocked()) return;
      // Movement cancels analysis/revalidation, NOT an already published Preview.
      if (active) { invalidate('CONTEXT_CHANGED', true); emit(); }
    },
    stop() { if (disposed || writeLocked()) return; invalidate('STOPPED', true); emit(); },
    newChat() { if (disposed || writeLocked()) return; invalidate(); try { chat = createChatSession(crypto); } catch (error) { status = safeCode(error); } emit(); },
    reset() { if (disposed || writeLocked()) return; invalidate(); stored = store.reset(); emit(); },
    cancelPreview() { if (active || disposed || writeLocked()) return false; dropPreview(); status = 'PREVIEW_CANCELLED'; emit(); return true; },
    async apply() {
      if (disposed || active || writeLocked()) return false;
      if (preview && now() >= preview.expiresAt) { dropPreview(); status = 'PREVIEW_EXPIRED'; emit(); return false; }
      if (!canApply()) { status = preview ? 'SELECTION_CHANGED' : 'CAPABILITY_UNAVAILABLE'; dropPreview(); emit(); return false; }
      const candidate = preview;
      const target = previewTarget;
      const sourceOwner = previewOwner;
      dropPreview();
      const owned = { kind: 'apply', generation: ++generation, settings: sourceOwner.settings, uuid: sourceOwner.uuid,
        editorType: sourceOwner.editorType, deadline: now() + LIMITS.applyObservationMs, abort: new AbortController(), timer: null, dispatched: false };
      active = owned; status = 'CHECKING_SELECTION';
      function readyToDispatch() {
        if (!valid(owned)) throw new SafeError(ERROR_CODES.CANCELLED);
        if (now() >= candidate.expiresAt) throw new SafeError(ERROR_CODES.PREVIEW_EXPIRED);
        // Accepted SDK command cannot be cancelled; lock BEFORE calling SDK.
        owned.dispatched = true; status = 'APPLYING'; emit();
      }
      try {
        owned.timer = timers.schedule(function () { if (active === owned) { invalidate('TIMEOUT', true); emit(); } }, LIMITS.applyObservationMs);
        emit();
        const receipt = await bridge.applySelection({ target, replacement: candidate.replacement, signal: owned.abort.signal,
          deadline: Math.min(owned.deadline, candidate.expiresAt), beforeDispatch: readyToDispatch });
        if (!valid(owned)) return false;
        const acknowledged = receipt?.acknowledged === true && receipt?.effectVerified === false;
        finish(owned, acknowledged ? 'APPLY_ACKNOWLEDGED' : 'APPLY_UNCERTAIN');
        return acknowledged;
      } catch (error) { return fail(owned, error); }
    },
    dispose() { if (disposed) return; invalidate('STOPPED', true); disposed = true; unsubscribeBridge?.(); bridge?.dispose?.(); listeners.clear(); }
  });
}
