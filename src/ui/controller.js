import { LIMITS, AGENT_GUARDRAILS } from '../shared/limits.js';
import { assertByteLimit, utf8ByteLength } from '../shared/bytes.js';
import { ERROR_CODES, SafeError } from '../shared/errors.js';
import { validateSettings, validateRequestSettings } from '../config/settings.js';
import { SettingsStore } from '../config/storage.js';
import { createChatSession, createConnectionSession, appendChatPair } from '../shared/session.js';
import { requestCompletion } from '../ai/transport.js';
import { runAgent } from '../agent/runtime.js';
import { createRegistry } from '../tools/registry.js';
import { createWordTools } from '../tools/word.js';
import { createCellTools } from '../tools/cell.js';
import { createSlideTools } from '../tools/slide.js';
import { createOrchestrator, createDocumentReader, isLongGenerationRequest, ORCHESTRATION_TARGET_CHARS,
  ORCHESTRATION_MAX_EXECUTE_PASSES, ORCHESTRATION_MAX_HEADINGS } from './orchestrator.js';

const noContext = () => Object.freeze({ kind: 'UNKNOWN', text: '', bytes: 0, ownershipVerified: false });
// A published status is certified by MEMBERSHIP in the closed vocabulary, never by the error's
// prototype: `instanceof SafeError` is forgeable (`Object.create(SafeError.prototype)` with its own
// `code`), and an injected transport's forged error must not publish an arbitrary string as the
// status. Anything that is not a closed class falls back to the internal-error class.
function closedCode(value) { return typeof value === 'string' && ERROR_CODES[value] === value ? value : ERROR_CODES.INTERNAL_ERROR; }
function safeCode(error) { return error instanceof SafeError ? closedCode(error.code) : ERROR_CODES.INTERNAL_ERROR; }
// The catalogue is filtered by capability keys, and the only capability this controller can honestly
// state without guessing about the installed SDK is what §6/§9 make structural: a Word editor the
// controller already reads and (under its own owned-target proof) applies to. Every action is still
// refused at dispatch by the bridge's own owned-target check, which is the authority.
const CAPABILITIES = Object.freeze(['document.read', 'document.write']);
// The Agent Runtime's terminal vocabulary mapped onto the controller's existing status codes (§8).
const RUN_STATUS = Object.freeze({ FINAL: 'COMPLETE', PREVIEW_READY: 'PREVIEW_READY', UNCERTAIN: 'APPLY_UNCERTAIN',
  LIMIT: 'AGENT_LIMIT', CANCELLED: 'CANCELLED', PROTOCOL_ERROR: 'PROTOCOL_ERROR' });
const CONNECTION_REQUEST = 'Проверка соединения. Ответь JSON final.';
// The HOST-side bound the panel brackets one multi-step agent run with. It is NOT the single-shot
// 150 s operation timeout: a pilot task of a ten-page document needs dozens of tool calls and minutes
// (see AGENT_GUARDRAILS), so this bound is the SAME named configuration the request carries, plus ONE
// transport window — the runtime's per-request budget, `LIMITS.operationTimeoutMs` — so a request still
// in flight when the runtime's own deadline fires can settle before this controller invalidates. It is
// strictly ABOVE `AGENT_GUARDRAILS.operationDeadlineMs` on purpose: a task that exhausts its budget must
// report the runtime's own LIMIT (`AGENT_LIMIT`, completed changes kept), never this controller's
// TIMEOUT. Raising the guardrails therefore needs no runtime change (limits.js:598-599,
// session.js:74); it does need this host bound to move with them, which is all that happens here.
const AGENT_RUN_HOST_DEADLINE_MS = AGENT_GUARDRAILS.operationDeadlineMs + LIMITS.operationTimeoutMs;
// The panel's OWN statuses for the long-generation orchestration. They are published by MEMBERSHIP in
// this closed table (`ORCH_STATUS`) rather than assembled from a phase string, so a phase the panel does
// not know can never reach the UI as an arbitrary caption.
const ORCH_STATUS = Object.freeze({ planning: 'ORCH_PLANNING', executing: 'ORCH_EXECUTING',
  verifying: 'ORCH_VERIFYING', continuing: 'ORCH_CONTINUING',
  complete: 'ORCH_COMPLETE', incomplete: 'ORCH_INCOMPLETE', uncertain: 'ORCH_UNCERTAIN', blocked: 'ORCH_BLOCKED' });
// The last published orchestration record, in the ONE shape the panel and its view share. It carries
// the plan text, the measured numbers and the closed codes only; it never carries a model envelope.
function orchestrationRecord(progress, outcome) {
  const phase = ORCH_STATUS[outcome.phase] === undefined ? ORCH_STATUS.blocked : outcome.phase;
  return Object.freeze({
    phase: outcome.phase,
    status: ORCH_STATUS[phase],
    pass: progress.passes ?? 0,
    maxPasses: ORCHESTRATION_MAX_EXECUTE_PASSES,
    targetChars: progress.targetChars ?? ORCHESTRATION_TARGET_CHARS,
    // The criteria and the request-derived floor travel with the report, so the panel and a native check
    // can read exactly what was REQUIRED — not only what the plan said — next to what was measured.
    criteria: progress.criteria ?? null,
    floor: progress.floor ?? null,
    plan: progress.plan ?? null,
    verified: progress.verified ?? null,
    missing: progress.missing ?? Object.freeze([]),
    missingTools: progress.missingTools ?? Object.freeze([]),
    uncertainty: progress.uncertainty ?? null,
    planCalledTools: progress.planCalledTools === true,
    error: outcome.error ?? null
  });
}

// Multi-step Agent Runtime run + explicit Preview/Apply only. Ownership capabilities stay private;
// neither model proposals nor public UI snapshots can supply an editor target.
export function createController({ bridge, store = new SettingsStore(), transport = requestCompletion,
  crypto = globalThis.crypto, clock = { now: () => Date.now() },
  timers = { schedule(callback, ms) { return setTimeout(function () { callback(); }, ms); }, clear(id) { clearTimeout(id); } }
} = {}) {
  let stored = store.load();
  let chat = createChatSession(crypto);
  let mode = 'ASK';
  // Cell cannot provide the Word selection context this toggle requests. Defaulting it off prevents
  // a guaranteed local refusal before the model is contacted; the view also disables and explains it.
  let includeContext = bridge?.getState().editorType !== 'cell';
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
  // The last PLAN -> EXECUTE -> VERIFY -> CONTINUE summary the panel published, or null while no
  // orchestration is in flight. It is a closed, content-free record built from measurements and closed
  // codes — never from a model envelope — and it is cleared whenever a new run takes ownership.
  let orchestration = null;
  // The FINAL message of the run being observed. The chat pair is the ordinary path's business, so an
  // orchestrated plan pass — which keeps no chat pair — reads its own answer from here, and the variable
  // is overwritten by every FINAL run so no earlier reply can be read back as a later pass's result.
  let lastAssistantMessage = null;
  let registryBuilt = false;
  let registry = null;
  let disposed = false;
  const listeners = new Set();
  // Built exactly once from the injected bridge; a descriptor failure is a load-time contract
  // failure that surfaces as a closed code instead of a raw exception in the UI.
  function registryOrNull() {
    if (!registryBuilt) {
      registryBuilt = true;
      // The registry is the ONE closed catalogue of every tool this build ships, and the editor each
      // descriptor names is what decides whether the model is offered it: `createRegistry` filters by
      // `editors`, so a Word descriptor is never offered in a spreadsheet and a Cell descriptor is never
      // offered in a document. The agent path below (`runAgent` with `editor: owned.editorType`) was
      // already editor-agnostic and needed no change.
      try { registry = createRegistry([...createWordTools(bridge), ...createCellTools(bridge), ...createSlideTools(bridge)]); } catch { registry = null; }
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
  // It is built from the run it describes, so a record frozen at Stop keeps that run's own counters.
  function runRecord(runStatus, source = active) {
    const counters = source?.agent;
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
      preview, capabilityCount, agent, orchestration, canApply: canApply(), writeLocked: writeLocked(), generation, editorType: bridge?.getState().editorType ?? 'unknown',
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
    // The record is frozen from the run being invalidated, BEFORE its counters would be read back
    // from the cleared active slot: Stop must preserve the actions completed before it.
    if (agent !== null && agent.status === 'RUNNING') agent = runRecord('CANCELLED', old);
  }
  // The one ownership predicate every publication uses: the run must still be the active owned run
  // of its own generation, so a superseded run can never publish anything over its successor.
  function owns(owned) { return !disposed && active === owned && generation === owned.generation; }
  function valid(owned) {
    if (disposed || active !== owned || generation !== owned.generation) return false;
    if (now() >= owned.deadline) {
      invalidate('TIMEOUT', true); emit(); return false;
    }
    return true;
  }
  function begin(kind, orchestrated = false) {
    if (disposed || active || writeLocked()) return null;
    dropPreview();
    // A new run takes the panel over, so the previous orchestration report is cleared: a stale summary
    // must never be shown beside a status that belongs to a different request. An ORCHESTRATED pass is
    // the continuation of the report in flight, so it keeps it and republishes it per phase.
    if (!orchestrated) { orchestration = null; lastAssistantMessage = null; }
    const deadline = now() + AGENT_RUN_HOST_DEADLINE_MS; // BEFORE any context/SDK work
    const owned = { kind, generation: ++generation, settings: validateRequestSettings(stored.settings),
      mode: kind === 'connection' ? 'ASK' : mode, includeContext, uuid: kind === 'connection' ? createConnectionSession(crypto).uuid : chat.uuid,
      editorType: bridge?.getState().editorType ?? 'unknown', deadline, abort: new AbortController(), timer: null };
    active = owned;
    status = kind === 'connection' ? 'CONNECTING' : kind === 'context' ? 'READING_CONTEXT' : 'ANALYZING';
    try {
      owned.timer = timers.schedule(function () {
        if (active === owned) { invalidate('TIMEOUT', true); emit(); }
      }, AGENT_RUN_HOST_DEADLINE_MS);
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
  // The published status is derived from the run's OWN terminal outcome, never from the request kind:
  // only a FINAL run proves a connection, and a classified ERROR publishes only a closed code.
  function statusFor(kind, done, candidate) {
    if (done.status === 'FINAL') return kind === 'connection' ? 'CONNECTION_OK' : RUN_STATUS.FINAL;
    if (done.status === 'PREVIEW_READY') return candidate ? RUN_STATUS.PREVIEW_READY : 'CAPABILITY_UNAVAILABLE';
    if (done.status === 'ERROR') return closedCode(done.code);
    return RUN_STATUS[done.status] ?? ERROR_CODES.INTERNAL_ERROR;
  }
  // Publishes the terminal outcome for one owned run. The RUNNING record is already stored in `agent`
  // (the terminal one is committed before this call, under the same ownership); only a final answer
  // or a proposal appends a chat pair, and only a proposal exposes one.
  // Return contract for `analyze`/`testConnection`: `true` iff the terminal outcome was published
  // through THIS owned settle path. `false` does NOT mean nothing was published — an async transport
  // rejection, an ownership loss, a deadline breach and the busy path all publish their own status
  // (through `fail()` or through the invalidating action) while returning false, and only the early
  // guards (busy/disposed/write-locked) return false without publishing anything.
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
  async function run(kind, user, extra = {}) {
    if (disposed || active || writeLocked()) return false;
    // `profile` is the model-visible tool PROFILE this pass runs under. The registry's own contract is
    // that an ABSENT profile is `undefined` and a NAME it does not declare is a refusal, so an absent
    // profile is forwarded as `undefined` (never as `null`, which the registry refuses and the runtime's
    // own fallback would answer with the FULL list — the opposite of what an orchestrated pass wants).
    const profile = extra.profile ?? undefined;
    let owned = null;
    try {
      if (kind === 'analysis') assertByteLimit(user, LIMITS.userInputBytes);
      owned = begin(kind, extra.orchestrated === true);
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
      if (owns(owned)) agent = owned.agent;
      emit();
      const done = await runAgent({ registry: registryOrNull(), editor: owned.editorType, capabilities: CAPABILITIES,
        mode: owned.mode, settings, uuid, request: kind === 'connection' ? CONNECTION_REQUEST : user,
        profile,
        // The panel's agent runs carry the named pilot guardrails IN THE REQUEST: the runtime validates
        // them through the same `createGuardrails` (runtime.js:111) and needs no edit of its own
        // (limits.js:598-599, session.js:74). Without them the defaults (maxSteps 12 / maxToolCalls 32 /
        // 150 s) applied, which is what ended the owner's pilot request with AGENT_LIMIT after five
        // executed actions.
        guardrails: AGENT_GUARDRAILS,
        signal, transport: send, now,
        onEvent(event) {
          // One line per completed action: the tool name and the closed outcome only. The raw
          // envelope, arguments and results never reach the record or the DOM. The event only
          // republishes while its own run still owns the controller, so an action settling after
          // Stop cannot resurrect a running record over the invalidating status.
          owned.agent = Object.freeze({ status: 'RUNNING', steps: event.step, toolCalls: owned.agent.toolCalls + 1,
            actions: Object.freeze([...owned.agent.actions, Object.freeze({ tool: event.tool, outcome: event.outcome })]) });
          if (owns(owned)) { agent = owned.agent; emit(); }
        } });
      // The terminal run record is committed only for the owned run, or for a run that still holds
      // the current generation with nothing active: a superseded run may report its own outcome, but
      // it can never replace the record of a newer run that is publishing next to its own status. The
      // record is content-free and carries no control decision; the STATUS assignment below stays
      // generation-guarded as well.
      if (owns(owned) || (active === null && generation === owned.generation)) {
        agent = Object.freeze({ status: done.status, steps: done.steps, toolCalls: done.toolCalls, actions: done.actions });
      }
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
      if (done.status === 'FINAL' && typeof done.message === 'string') lastAssistantMessage = done.message;
      // An ORCHESTRATED pass reports its outcome through the orchestration record, not through the chat:
      // a plan pass and six multi-thousand-character execute requests would otherwise fill the history
      // with the panel's own wording. The panel's ordinary single-run path appends exactly as before.
      const append = kind === 'analysis' && extra.appendToChat !== false && (done.status === 'FINAL' || candidate) ? { user, assistant: reply } : null;
      return settle(owned, statusFor(kind, done, candidate), append, candidate, captured ? captured.target : null);
    } catch (error) { return fail(owned, error); }
  }
  // The panel's bridge legs the VERIFY step reads the document with: the same public entry points the
  // `read_structure` and `read_document_text` tools dispatch, called directly so no model step and no
  // tool-call budget is spent on measuring the result. Both are READS: neither can open a write slot.
  function structureLeg(raw) {
    if (typeof bridge?.readStructure !== 'function') return Promise.resolve({ ok: false, code: ERROR_CODES.CAPABILITY_UNAVAILABLE });
    return Promise.resolve(bridge.readStructure(raw));
  }
  function documentLeg(raw) {
    if (typeof bridge?.readDocumentText !== 'function') return Promise.resolve({ ok: false, code: ERROR_CODES.CAPABILITY_UNAVAILABLE });
    return Promise.resolve(bridge.readDocumentText(raw));
  }
  // ONE ORCHESTRATED PASS: an ordinary owned agent run under the controller's existing ownership,
  // deadline and transport rules, reported as a closed result rather than as a boolean. Nothing about
  // the single-run path moves: a pass is `run('analysis', text, { profile, appendToChat: false })` plus
  // the classification of its terminal outcome.
  async function runPass({ text, profile }) {
    let completed = false;
    try {
      if (typeof text !== 'string' || text === '') return Object.freeze({ ok: false, error: ERROR_CODES.INVALID_DATA });
      if (disposed || writeLocked()) return Object.freeze({ ok: false, error: bridge?.getState?.().busy === true ? ERROR_CODES.EDITOR_BUSY : ERROR_CODES.INTERNAL_ERROR });
      completed = await run('analysis', text, { profile, appendToChat: false, orchestrated: true });
    } catch (error) { return Object.freeze({ ok: false, error: safeCode(error) }); }
    // An orchestrated pass never publishes a Preview of its own: the selection-replacement proposal is
    // left to the ordinary single-run path, where the user's selection is what it was built from.
    dropPreview();
    const record = agent;
    // The run's own terminal outcome is the pass result. `completed === false` with the run still
    // owned means the pass was superseded or timed out: that is an infrastructure stop, never a silent
    // success, and the orchestration reports it instead of starting another pass.
    if (active !== null || !completed) {
      return Object.freeze({ ok: false, error: record?.status === 'CANCELLED' ? ERROR_CODES.CANCELLED : 'SUPERSEDED',
        status: record?.status ?? 'UNKNOWN', actions: record?.actions ?? Object.freeze([]), steps: record?.steps ?? 0 });
    }
    return Object.freeze({ ok: true, status: record?.status ?? 'UNKNOWN', message: lastAssistantMessage,
      actions: record?.actions ?? Object.freeze([]), steps: record?.steps ?? 0, toolCalls: record?.toolCalls ?? 0 });
  }
  // The plan pass's own answer. The controller does not keep chat history for an orchestrated pass, so
  // the FINAL message the runtime returned is captured here, where it is the pass's result and nothing
  // else: no reply text from any other run can be read back through this variable.
  async function runPlanPass(text) {
    lastAssistantMessage = null;
    const result = await runPass({ text, profile: null });
    return Object.freeze({ ...result, message: result.ok === true ? lastAssistantMessage : null });
  }
  // PLAN -> EXECUTE -> VERIFY -> CONTINUE, driven entirely from here. Every pass is an ordinary agent
  // request composed by the orchestrator module; the panel supplies the transport-level `runPass` and the
  // bridge-level document read, and publishes the outcome through its existing status/emit mechanism.
  async function runOrchestration(user) {
    try {
      const outcome = await createOrchestrator({
        // The plan pass needs the FINAL message as its plan; the execute passes need only their closed
        // outcome, so the message capture is switched on for the plan pass alone.
        runPass: pass => pass.kind === 'plan' ? runPlanPass(pass.text) : runPass(pass),
        readDocument: createDocumentReader({ readStructure: structureLeg, readDocumentText: documentLeg }),
        profileInstruction: profile => typeof registryOrNull()?.profileInstruction === 'function' ? registryOrNull().profileInstruction(profile) : null,
        emit: progress => publishOrchestration(progress, null)
      }).run(user);
      publishOrchestration(outcome, outcome);
      return true;
    } catch (error) {
      // The orchestration ends through the controller's own classified failure path, and the record of
      // what was measured so far is still published: a failure that occurs BEFORE any measurement must
      // not leave a stale report of a previous request standing.
      return fail(null, error);
    }
  }
  function publishOrchestration(progress, outcome) {
    if (disposed) return;
    const record = orchestrationRecord(progress, outcome ?? progress);
    orchestration = record;
    // The status is the orchestration's OWN status while none of the controller's guards has taken over:
    // a Stop, a superseded run or a refusal keeps its own closed status and the orchestration record is
    // the report of what was measured up to that point.
    if (!active && !writeLocked()) status = record.status;
    emit();
  }
  return Object.freeze({
    getState: snapshot,
    subscribe(listener) { listeners.add(listener); listener(snapshot()); return function () { listeners.delete(listener); }; },
    analyze(user) {
      // THE LONG-GENERATION ENTRY: a request that names a volume, several parts or an explicit count is
      // planned, executed in parts, measured and continued. Every other request keeps the existing
      // single-run path exactly as it was, so an ordinary question or edit is unchanged.
      if (mode === 'EDIT' && isLongGenerationRequest(user)) return runOrchestration(user);
      return run('analysis', user);
    },
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
        if (platform?.editorType !== 'word' && platform?.editorType !== 'cell' && platform?.editorType !== 'slide') {
          finish(owned, 'R7_CHECK_UNAVAILABLE'); return false;
        }
        if (typeof bridge?.probeCapabilities !== 'function') {
          finish(owned, 'R7_CHECK_UNAVAILABLE'); return false;
        }
        const capabilities = await bridge.probeCapabilities({ signal: owned.abort.signal });
        if (!valid(owned)) return false;
        // THE SPREADSHEET PATH. A Cell bridge has no Word method to probe, so it reports its capabilities LOCALLY
        // and `methodPresence` is null by construction — readiness is what the bridge says about ITSELF. The Word
        // decode below used to run for every editor, so a HEALTHY workbook was answered with
        // `R7_CHECK_UNAVAILABLE`; the exit-gate run reads and mutates sheets through exactly this adapter, which is
        // why this fix is editor-AWARE rather than a relaxed Word check.
        if (platform?.editorType === 'cell') {
          // The adapter the bridge reports is an OBJECT naming the primitives it can use
          // (`{ executeMethod, commandDispatch, commandMethod }`), not a string: readiness is that ONE of them is
          // available. An earlier version of this branch required a string and therefore refused a perfectly usable
          // spreadsheet — the shape is taken from the bridge's own measured report, and the test below uses it too.
          const adapter = capabilities?.adapter;
          const adapterUsable = adapter !== null && typeof adapter === 'object'
            && (adapter.commandDispatch === true || adapter.executeMethod === true);
          if (capabilities?.editorType !== 'cell' || adapterUsable !== true) {
            finish(owned, 'R7_CHECK_UNAVAILABLE'); return false;
          }
          const cellAvailability = [capabilities?.selectionRead?.available, capabilities?.mutation?.available];
          if (cellAvailability.some(value => typeof value !== 'boolean')) throw new SafeError(ERROR_CODES.INVALID_DATA);
          const cellCount = cellAvailability.filter(value => value === true).length;
          return finish(owned, 'R7_PRESENCE_READY', function () { capabilityCount = cellCount; });
        }
        // THE PRESENTATION PATH. The exit gate found this branch MISSING: a slide editor fell through to the Word
        // decode below, whose `methodPresence` schema no presentation reports, so a perfectly usable deck answered
        // `R7_CHECK_UNAVAILABLE` and the panel showed the editor as unavailable. The bridge publishes the slide
        // capability report LOCALLY for this editor, exactly as it does for a spreadsheet, so readiness is judged
        // the same way: the adapter must name a usable command entry point and the two availability flags must be
        // real booleans. `mutation.available` is false by design here — a presentation mutation is authorised by the
        // panel's own owned preview, whose reason the report carries — so it counts as unavailable rather than
        // making the whole editor unusable.
        if (platform?.editorType === 'slide') {
          const slideAdapter = capabilities?.adapter;
          const slideAdapterUsable = slideAdapter !== null && typeof slideAdapter === 'object'
            && (slideAdapter.commandDispatch === true || slideAdapter.executeMethod === true);
          if (capabilities?.editorType !== 'slide' || slideAdapterUsable !== true) {
            finish(owned, 'R7_CHECK_UNAVAILABLE'); return false;
          }
          const slideAvailability = [capabilities?.selectionRead?.available, capabilities?.mutation?.available];
          if (slideAvailability.some(value => typeof value !== 'boolean')) throw new SafeError(ERROR_CODES.INVALID_DATA);
          const slideCount = slideAvailability.filter(value => value === true).length;
          return finish(owned, 'R7_PRESENCE_READY', function () { capabilityCount = slideCount; });
        }
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
