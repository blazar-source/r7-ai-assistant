import { LIMITS } from '../shared/limits.js';
import { assertByteLimit, utf8ByteLength } from '../shared/bytes.js';
import { ERROR_CODES, SafeError } from '../shared/errors.js';

// Identity leases persist through disposal: replacing a JS adapter is not proof
// that queued SDK work was retracted. Only a genuinely new initialized plugin
// object may start a new lifecycle. Never call SDK outside this sole bridge.
const pluginOwners = new WeakSet();
const MUTATION_REASON = 'EXPLICIT_OWNED_PREVIEW_REQUIRED';
const presenceKeys = Object.freeze(['api', 'getDocument', 'getDocumentId', 'replaceTextSmart', 'getRangeBySelect', 'isTrackRevisions']);

// Inspect data descriptors, never extract a command function for execution.
function ownFunction(object, name) {
  if (!object || typeof object !== 'object') return false;
  const descriptors = Object.getOwnPropertyDescriptors(object);
  if (!Object.hasOwn(descriptors, name)) return false;
  const descriptor = descriptors[name];
  return !!descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'function';
}
// The COMMAND channel on a build that has no `callCommand`. Measured on the exact target (Astra Linux
// + R7-Office 2026.1.2.1942) the plugin facade exposes `executeCommand` and `executeMethod` but NOT
// `callCommand`; on Windows R7-Office 2026.3.1 both exist. The installed 2026.1.2 vendor SDK composes
// `callCommand` out of `executeCommand`: it builds `"var Asc = {}; Asc.scope = <scope>; (" + fn + ")();"`
// and sends it as the command data. The bodies below are the SAME author-written, synchronous,
// scope-only functions the reviewed `commands.js` probes dispatch, and they read the same public `Api`
// facade.
//
// The two natives are NOT interchangeable in general, and this code does not treat them as one: it
// keeps `callCommand` whenever the build exposes it (the measured-working Windows path, called with
// exactly the arguments it receives today) and uses `executeCommand` only when `callCommand` is absent.
// When neither is an own function the command dispatch is absent, the capability gate refuses before
// dispatching anything, and no API that is not on the facade is invented.
// The TWO author-written command bodies the bridge's command legs dispatch, selected by the same closed
// kind constant the reviewed `commands.js` probes use (`'capability'` for the presence probe,
// `'context'` for the document-identity read). Both are static: they read `Api` and nothing else, and
// each returns the closed tuple shape the bridge's own decoder validates (6 booleans, or 4 slots), so
// the two protocols cannot blur into one.
const capabilityBody = () => {
  try {
    var present = typeof Api !== 'undefined' && Api !== null;
    var getDocument = present && typeof Api.GetDocument === 'function';
    var document = getDocument ? Api.GetDocument() : null;
    return [
      present,
      getDocument,
      present && typeof Api.GetDocumentId === 'function',
      present && typeof Api.ReplaceTextSmart === 'function',
      document !== null && document !== undefined && typeof document.GetRangeBySelect === 'function',
      document !== null && document !== undefined && typeof document.IsTrackRevisions === 'function'
    ];
  } catch { return ['CAPABILITY_UNAVAILABLE']; }
};
const contextBody = () => {
  try {
    var available = typeof Api !== 'undefined' && Api !== null;
    var id = available && typeof Api.GetDocumentId === 'function' ? Api.GetDocumentId() : null;
    var document = available && typeof Api.GetDocument === 'function' ? Api.GetDocument() : null;
    var replace = available && typeof Api.ReplaceTextSmart === 'function';
    var range = document !== null && document !== undefined && typeof document.GetRangeBySelect === 'function';
    var tracking = document !== null && document !== undefined && typeof document.IsTrackRevisions === 'function' ? document.IsTrackRevisions() : null;
    return [id, replace, range, tracking];
  } catch { return [null, false, false, null]; }
};
// Compose the command source the transport carries: the SAME statement form the installed vendor
// `callCommand` builds around an author-written body. `String(...)` is a data conversion of an authored
// function literal, never execution of a string.
function commandTransport(which) {
  return 'var Asc = {}; \n  var scope = Asc.scope;\n  (' + String(which === 'context' ? contextBody : capabilityBody) + ')();\n  ';
}
// Resolve the command dispatch from the two own-function descriptors the facade may expose. The
// returned descriptor is frozen, so the choice cannot be rewritten after the bridge is constructed.
// Each entry point is reached as a LITERAL member call on the same facade, and its argument is an
// inline author-written body (or, for the target-only transport, the source composed from it), so the
// authored static boundary of `callCommand` is unchanged. The own-function booleans make each call
// reachable only when that native really is an own function; neither branch is taken otherwise.
function createCommandDispatch(plugin, hasCommand, hasTransport) {
  if (hasCommand) {
    return Object.freeze({ present: true, method: 'callCommand',
      probe(which, callback) {
        return which === 'context'
          ? plugin.callCommand(() => contextBody(), false, false, callback)
          : plugin.callCommand(() => capabilityBody(), false, false, callback);
      } });
  }
  if (hasTransport) {
    // The `executeCommand` transport of a build without the wrapper. It receives the composed command
    // source, which is the statement form of the same authored body the wrapper would have carried.
    return Object.freeze({ present: true, method: 'executeCommand',
      probe(which, callback) { return plugin.executeCommand('command', commandTransport(which), callback); } });
  }
  return Object.freeze({ present: false, method: null,
    probe() { throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE); } });
}
function decodeTuple(value, sizes) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new SafeError(ERROR_CODES.INVALID_DATA);
  // Inspect length before enumerating anything: even a giant sparse array is
  // rejected in constant work. Never read callback indices or invoke accessors.
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !Object.hasOwn(length, 'value') || length.enumerable ||
      !sizes.includes(length.value)) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const size = length.value;
  // Exact own-key count plus every expected own data index closes symbols,
  // hidden/enumerable extras and holes, without processing their contents.
  if (Reflect.ownKeys(value).length !== size + 1) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const members = [];
  for (let index = 0; index < size; index++) {
    const key = String(index);
    if (!Object.hasOwn(descriptors, key)) throw new SafeError(ERROR_CODES.INVALID_DATA);
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new SafeError(ERROR_CODES.INVALID_DATA);
    members.push(descriptor.value);
  }
  return members;
}
function decodePresence(value) {
  const tuple = decodeTuple(value, [1, presenceKeys.length]);
  if (tuple.length === 1) {
    if (tuple[0] === 'CAPABILITY_UNAVAILABLE') throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
    throw new SafeError(ERROR_CODES.INVALID_DATA);
  }
  const result = {};
  for (let index = 0; index < tuple.length; index++) {
    if (typeof tuple[index] !== 'boolean') throw new SafeError(ERROR_CODES.INVALID_DATA);
    result[presenceKeys[index]] = tuple[index];
  }
  assertByteLimit(JSON.stringify(result), LIMITS.editorResultBytes);
  return Object.freeze(result);
}
function decodeContext(value) {
  const tuple = decodeTuple(value, [4]);
  const [id, replace, range, tracking] = tuple;
  if (typeof replace !== 'boolean' || typeof range !== 'boolean' || (tracking !== null && typeof tracking !== 'boolean')) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (typeof id === 'string') assertByteLimit(id, 2048);
  else if (id !== null && (typeof id !== 'number' || !Number.isFinite(id))) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (id === null || id === '' || !replace || !range || tracking !== false) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
  return id;
}
// A native read string is bounded twice: first by the editor-result ceiling that applies to ANY
// native read, then by the byte budget THIS ticket actually requested. The selection read passes its
// own 8 KiB window explicitly, so its behaviour is unchanged; a paragraph/section/structure read
// passes the budget its tool asked the bridge for.
function decodeText(value, bound) {
  assertByteLimit(value, LIMITS.editorResultBytes);
  return assertByteLimit(value, bound);
}
// A native insert acknowledgement. `true`/`false` are the only values that carry information: they
// settle the ticket as an acknowledged-but-effect-UNVERIFIED outcome. Every other value — `undefined`,
// which is what the live R7-Office 2026.3.1 `PasteText` calls back with AFTER it has applied the
// insert, plus `null`, a string or an object — says nothing at all about the effect. Such a value is
// therefore neither an automatic success (the callback acknowledged nothing) nor an ordinary known
// error (the paste may well have applied), so `null` here means "the acknowledgement is unusable" and
// hands the still-owned ticket to the confirmation leg. The function is CONTRACT-DRIVEN, not fitted to
// one build: a build whose `PasteText` returns a value goes through exactly the same door.
function insertAcknowledgement(value) {
  return typeof value === 'boolean' ? Object.freeze({ acknowledged: value, effectVerified: false }) : null;
}
// One classified failure per dispatched kind. A write-class ticket whose callback never settled may
// already have applied, so it is the uncertain class; everything else keeps its own code, and a raw
// native failure is the closed editor-error class, never a raw exception.
function errorFor(kind, error) {
  if (error instanceof SafeError) return error;
  if (kind === 'write' || kind === 'insert') return new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  return new SafeError(ERROR_CODES.EDITOR_ERROR);
}
// The deadline expiring is its own class, never an editor error: the callback simply never arrived.
// `dispatched` is the whole distinction: a write-class ticket whose mutation WAS dispatched may have
// applied (uncertain), while one that dispatched NOTHING — an insert whose pre-dispatch baseline never
// answered — is a KNOWN timeout. Reporting it as uncertain would be a false uncertainty about a
// mutation that never happened, and (until the slot is released) it wedged the bridge.
function timeoutFor(kind, dispatched) {
  if ((kind === 'write' || kind === 'insert') && dispatched) return new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  return new SafeError(ERROR_CODES.TIMEOUT);
}
// Every mutation the bridge dispatches is a pending mutation from the moment it is dispatched until
// its ticket settles (a success, or uncertain-until-callback after a timeout or abort; a refusal is
// never dispatched and so is never pending). Design §8.4 requires that no mutation is dispatched
// while a previous one is unsettled, and the panel's write lock (controller.writeLocked) is what
// enforces it, so this predicate must cover the insert path as well as the selection replacement,
// not only `kind === 'write'`.
// The lock is INTENTIONALLY INDEFINITE while a native callback is unresolved: design §8.4 keeps a
// timed-out mutation busy/uncertain until it settles or the plugin is reinitialised, and the UI maps
// that uncertain outcome to an authored caption. An expired deadline must therefore never release it,
// and "fixing" this into a timeout-driven unlock would be a defect, not a repair.
function pendingMutation(slot) {
  return slot !== null && (slot.kind === 'write' || slot.kind === 'insert') && slot.dispatched;
}
function applyData(raw) {
  if (!raw || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const keys = Reflect.ownKeys(descriptors);
  const allowed = ['target', 'replacement', 'signal', 'deadline', 'beforeDispatch'];
  if (keys.some(key => !allowed.includes(key)) || !Object.hasOwn(descriptors, 'target') || !Object.hasOwn(descriptors, 'replacement')) throw new SafeError(ERROR_CODES.INVALID_DATA);
  for (const descriptor of Object.values(descriptors)) if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new SafeError(ERROR_CODES.INVALID_DATA);
  assertByteLimit(raw.replacement, LIMITS.replacementBytes);
  const deadline = Object.hasOwn(descriptors, 'deadline') ? raw.deadline : undefined;
  const beforeDispatch = Object.hasOwn(descriptors, 'beforeDispatch') ? raw.beforeDispatch : undefined;
  if (deadline !== undefined && (typeof deadline !== 'number' || !Number.isFinite(deadline))) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (beforeDispatch !== undefined && typeof beforeDispatch !== 'function') throw new SafeError(ERROR_CODES.INVALID_DATA);
  return Object.freeze({ target: raw.target, replacement: raw.replacement,
    signal: Object.hasOwn(descriptors, 'signal') ? raw.signal : undefined, deadline, beforeDispatch });
}

// One instance must own all SDK work for the plugin lifetime. UI must invalidate
// on context/generation changes and dispose on teardown; neither retracts work.
export function createR7Bridge(plugin, {
  editorType,
  clock = { now: () => Date.now() },
  timers = { schedule(callback, ms) { return setTimeout(function () { callback(); }, ms); }, clear(id) { clearTimeout(id); } }
} = {}) {
  if (plugin && typeof plugin === 'object') {
    if (pluginOwners.has(plugin)) throw new SafeError(ERROR_CODES.EDITOR_BUSY);
    pluginOwners.add(plugin);
  }
  const editor = ['word', 'cell', 'slide'].includes(editorType) ? editorType : 'unknown';
  // `executeMethod` is the METHOD channel every build exposes and the one the insert's irreversible
  // `PasteText` needs. `commandDispatch` is the COMMAND channel used by the identity/presence legs;
  // it is present when EITHER command entry point is an own function, and the descriptor records which
  // one carried the work (`callCommand` preferred, `executeCommand` as the target-only fallback).
  const hasCallCommand = ownFunction(plugin, 'callCommand');
  const hasExecuteCommand = ownFunction(plugin, 'executeCommand');
  const command = createCommandDispatch(plugin, hasCallCommand, hasExecuteCommand);
  const adapter = Object.freeze({ executeMethod: ownFunction(plugin, 'executeMethod'),
    commandDispatch: hasCallCommand || hasExecuteCommand, commandMethod: command.method });
  let slot = null;
  let disposed = false;
  let contextOwner = Object.freeze({});
  const targets = new WeakMap(); // private brand + raw ID; never public DTO/model data
  const listeners = new Set();
  function notify() { for (const listener of listeners) { try { listener(); } catch {} } }
  function currentEditor() {
    const info = plugin && Object.getOwnPropertyDescriptor(plugin, 'info');
    if (!info || !Object.hasOwn(info, 'value') || !info.value || typeof info.value !== 'object') return 'unknown';
    const type = Object.getOwnPropertyDescriptor(info.value, 'editorType');
    return type && Object.hasOwn(type, 'value') && ['word', 'cell', 'slide'].includes(type.value) ? type.value : 'unknown';
  }
  function ownedTarget(target) {
    const saved = target && typeof target === 'object' ? targets.get(target) : null;
    return !disposed && currentEditor() === editor && editor === 'word' && saved?.owner === contextOwner ? saved : null;
  }

  function capabilities(methodPresence = null) {
    const available = !disposed && editor === 'word' && adapter.executeMethod;
    return Object.freeze({
      editorType: editor, adapter, methodPresence, runtimeVerified: false,
      selectionRead: Object.freeze({ available, runtimeVerified: false, reason: available ? 'ADAPTER_PRESENT_RUNTIME_UNVERIFIED' : 'READ_UNAVAILABLE' }),
      mutation: Object.freeze({ available: false, runtimeVerified: false, reason: MUTATION_REASON })
    });
  }
  function ensureIdle() {
    if (disposed || editor === 'unknown') throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
    if (slot !== null) throw new SafeError(ERROR_CODES.EDITOR_BUSY);
  }
  function readClock() {
    try {
      const now = clock.now();
      if (typeof now !== 'number' || !Number.isFinite(now)) throw new SafeError(ERROR_CODES.EDITOR_ERROR);
      return now;
    } catch { throw new SafeError(ERROR_CODES.EDITOR_ERROR); }
  }
  // The insert parameters are optional and last so every pre-existing three-argument caller of
  // start() keeps its exact meaning.
  function start(kind, signal, { replacement, beforeDispatch, maxBytes } = {}, params) {
    if (signal?.aborted) return Promise.reject(new SafeError(ERROR_CODES.CANCELLED));
    // Decode bound for THIS ticket. A `contextread` ticket has exactly one creator, `readContext`,
    // which refuses a non-safe-integer or `< 1` `maxBytes` as CAPABILITY_UNAVAILABLE BEFORE it
    // dispatches, so this leg always carries its budget and there is no second window it can fall back
    // to — `LIMITS.selectionBytes` is not consulted on this branch at all, and a fallback here would be
    // dead code whose only effect was to hide a future caller that forgot the budget behind an 8 KiB
    // decode. Without one, such a caller gets `assertByteLimit`'s closed INVALID_DATA instead of a
    // silent under-bound decode. Every other kind keeps its own window (the selection read stays at
    // LIMITS.selectionBytes).
    const readBound = kind === 'contextread' ? Math.min(maxBytes, LIMITS.editorResultBytes) : LIMITS.selectionBytes;
    return new Promise((resolve, reject) => {
      const owned = { kind, dispatched: false, uncertain: false, settled: false, timer: null, deadline: readClock() + LIMITS.callbackTimeoutMs, cancel: null };
      slot = owned;
      function settle(error, value) {
        if (owned.settled) return;
        owned.settled = true;
        // Cleanup is best effort, never the authority to settle caller/SDK work.
        if (owned.timer !== null) {
          try { timers.clear(owned.timer); } catch {}
          owned.timer = null;
        }
        try { signal?.removeEventListener('abort', cancel); } catch {}
        if (error) reject(error); else resolve(value);
      }
      function cancel() {
        if (slot !== owned || owned.settled) return;
        // `owned.dispatched` decides both the class and the slot: a ticket whose work already reached
        // the SDK may have applied (write-class) or is still queued (a read/probe), so it keeps the
        // existing uncertain-until-matching-callback behaviour; a ticket that dispatched NOTHING has a
        // single known outcome — the cancellation — and must RELEASE the slot, or a lifecycle
        // invalidation/dispose would leave the bridge permanently busy behind an already-settled ticket
        // that `slot?.cancel()` can no longer reach.
        const pending = owned.dispatched;
        if (!pending) slot = null;
        owned.uncertain = pending;
        settle(errorFor(kind, pending && (kind === 'write' || kind === 'insert') ? null : new SafeError(ERROR_CODES.CANCELLED)));
      }
      owned.cancel = cancel;
      // The confirmation LADDER of an unusable insert acknowledgement, and the PRE-DISPATCH BASELINE
      // every leg of it needs. The acknowledgement carries no value, so the still-OWNED ticket asks an
      // ordered series of public reads, ONE dispatch per leg, on the same slot: the mutation stays
      // pending (design §8.4) and no second mutation can be dispatched while the effect is unknown. No
      // leg ever re-dispatches the mutation.
      //
      // A post-dispatch observation that reproduces the payload proves only that the caret scope
      // EQUALS the payload. On a build whose `PasteText` calls back `undefined` and silently does
      // nothing — its semantics on the target Astra/R7 2026.1.2.1942 are UNMEASURED — a scope that
      // already held the payload would satisfy that equality while no insert happened, and the bridge
      // would report a VERIFIED effect that never occurred. So every leg ALSO reads its own observation
      // BEFORE the paste, and confirms only when the post-dispatch observation reproduces the payload
      // through that leg's OWN exact rule AND differs from that baseline. Equality with the baseline is
      // "nothing observable changed": not confirmed, and never a success.
      //
      // The baseline phase is GATED: the paste is dispatched only after every baseline leg has answered
      // or failed, so a baseline observation is pre-paste BY CONSTRUCTION and never by an assumption
      // about the editor's callback ordering — the same reason `PasteText` itself is not trusted here.
      // A baseline that throws, errors, is malformed or is byte-oversized leaves ITS leg incapable of
      // confirming (that leg is then not even asked for a post-dispatch read); the mutation is still
      // dispatched exactly once, with exactly the payload this path carried before the baseline existed.
      //
      // Every other observation — a different string, the empty string, a malformed or byte-oversized
      // value, a read error, an observation delivered past the ticket deadline, a dispatch that threw —
      // is "not confirmed" and hands the ticket to the NEXT leg. Only when the LAST capable leg is not
      // confirmed does the ladder settle the uncertain class, and even then the slot is NOT released:
      // nothing observed here proves the paste did not apply.
      //
      // Leg 1 `GetSelectedText` byte-equality is kept FIRST because it is the primitive that can
      // confirm on a build whose paste leaves the inserted text selected. It is measured to answer `""`
      // on R7-Office 2026.3.1 (immediately and after +400 ms) — with an empty baseline it cannot
      // confirm there — but a read that does reproduce the payload still proves the effect, so the leg
      // stays a real first step. Leg 2 `GetCurrentSentence` is the primitive the live build actually
      // answers with the inserted sentence; its ONE normalization is documented at its comparison below.
      //
      // A whole-document `GetFileHTML` containment leg is deliberately ABSENT. `includes(payload)`
      // over the entire exported document is satisfied by a payload that was ALREADY in the document,
      // so on a build where the paste silently did nothing it would report `effectVerified:true` for an
      // effect that never happened. The baseline makes such a leg POSSIBLE to build honestly (a
      // containment count before and after), but a count is not the exact-equality rule this ladder is
      // built on, and adding it stays outside this repair; the ladder stops at the caret-scoped
      // exact-equality legs the live build was measured to answer.
      function beginInsert() {
        const payload = params[0]; // the exact string that will be dispatched to the editor
        try {
          // Both legs — baseline and confirmation alike — are bounded by THIS payload's own byte
          // length, capped by the editor-result ceiling that bounds every native read: neither the
          // baseline nor the confirmation can widen the read window beyond the bytes it checks for.
          const budget = Math.min(utf8ByteLength(payload), LIMITS.editorResultBytes);
          // Leg 2's expected observation. `position:'end'` dispatched `text + "\n"` and a sentence read
          // cannot contain a paragraph break, so exactly ONE trailing newline is removed — no other
          // whitespace is trimmed, no case is folded, and no prefix/suffix matching is accepted.
          const sentence = payload.endsWith('\n') ? payload.slice(0, -1) : payload;
          owned.confirmLegs = [
            Object.freeze({ method: 'GetSelectedText', budget, expected: payload }),
            Object.freeze({ method: 'GetCurrentSentence', budget, expected: sentence })
          ];
        } catch {
          // A leg set that cannot even be described proves nothing about the effect; the paste is still
          // dispatched exactly once and no leg can confirm.
          owned.confirmLegs = [];
        }
        owned.baselines = owned.confirmLegs.map(() => null);
        owned.baselineUsable = owned.confirmLegs.map(() => false);
        // The per-leg dispatch marks that make a baseline once per leg even when a native answers
        // synchronously and then throws out of the same call (see `readBaseline`).
        owned.legDispatched = owned.confirmLegs.map(() => false);
        owned.confirmLeg = -1;
        readBaseline(0);
        notify();
      }
      // ONE baseline dispatch per leg, before the mutation. A baseline never mutates anything, and an
      // unusable answer (a throw, a malformed value, a byte-oversized one, or an answer delivered past
      // the ticket deadline) only makes ITS leg incapable of confirming.
      //
      // The once-per-leg and once-per-ticket boundaries are STRUCTURAL, not an assumption about native
      // callback ordering. A measured-plausible native — one that delivers a leg's callback
      // SYNCHRONOUSLY and THEN throws out of the same call — used to re-enter THIS leg from the catch,
      // dispatch the baseline twice, and (because both answers each advanced the ladder) dispatch
      // `PasteText` TWICE for one logical insert. `legDispatched` makes a baseline once per leg and
      // `owned.dispatched` makes the paste once per ticket, so no native ordering can reach the
      // mutation twice: `dispatchPaste` is idempotent.
      function readBaseline(index) {
        if (slot !== owned || owned.settled || disposed) return; // a settled ticket never dispatches the mutation
        if (index >= owned.confirmLegs.length) { dispatchPaste(); return; }
        if (owned.legDispatched[index] === true) return; // this leg's single baseline already went out
        owned.legDispatched[index] = true;
        const leg = owned.confirmLegs[index];
        let answered = false;
        function baselineCallback(value) {
          if (slot !== owned) return;
          if (owned.settled) { slot = null; notify(); return; }
          if (answered) return; // one baseline observation per leg, never re-judged
          answered = true;
          try {
            if (signal?.aborted) throw new SafeError(ERROR_CODES.CANCELLED);
            if (readClock() >= owned.deadline) throw new SafeError(ERROR_CODES.TIMEOUT);
            const observed = decodeText(value, leg.budget);
            owned.baselines[index] = observed;
            owned.baselineUsable[index] = true;
          } catch { owned.baselineUsable[index] = false; }
          readBaseline(index + 1);
        }
        try {
          plugin.executeMethod(leg.method, Object.freeze([]), baselineCallback);
        } catch {
          // A baseline that cannot even be dispatched observed nothing: its leg cannot confirm, and the
          // mutation is neither blocked nor retried. If it already ANSWERED before throwing, the
          // callback above has advanced the ladder and this re-entry is refused by the once-per-leg
          // mark, so no native detail escapes and nothing is dispatched a second time.
          owned.baselineUsable[index] = false;
          readBaseline(index + 1);
        }
      }
      // The irreversible mutation, dispatched exactly once, with exactly the payload this path carried
      // before the baseline existed. A synchronous throw from the dispatch is the same closed class the
      // pre-baseline branch produced: a dispatch that may have reached the SDK is never a release.
      // The `owned.dispatched` check is the structural once-per-ticket boundary: after it, only the
      // mutation's own callback can settle the ticket, and no ladder leg can reach this function again.
      function dispatchPaste() {
        if (owned.dispatched || owned.settled || disposed) return;
        // An abort that landed during the baseline phase prevents the mutation entirely: nothing was
        // dispatched, so the ticket settles its own known cancellation and releases the slot.
        if (signal?.aborted) { slot = null; settle(new SafeError(ERROR_CODES.CANCELLED)); return; }
        owned.dispatched = true;
        try {
          plugin.executeMethod('PasteText', params, callback);
        } catch {
          if (slot === owned && !owned.settled) {
            owned.uncertain = true;
            settle(errorFor(kind, null));
            notify();
          }
        }
      }
      // The acknowledgement was unusable: ask the ladder, starting at its first CAPABLE leg (a leg
      // whose pre-dispatch baseline is unusable can never confirm and is never asked at all).
      function confirmInsert() {
        owned.confirming = true;
        owned.confirmLeg = -1;
        confirmNextLeg();
      }
      // ONE dispatch per leg, on the ticket's own slot. The callback is bound to THIS leg so a
      // duplicate or late callback from a leg the ladder has already left can never be judged by the
      // next leg's rule (that is the only way a stale read could fabricate a confirmation).
      function dispatchConfirmLeg() {
        const index = owned.confirmLeg;
        const leg = owned.confirmLegs[index];
        function legCallback(value) {
          if (slot !== owned) return;
          if (owned.settled) { slot = null; notify(); return; }
          if (index !== owned.confirmLeg) return; // a superseded leg observation is not this leg's
          let confirmed = false;
          try {
            if (signal?.aborted) throw new SafeError(ERROR_CODES.CANCELLED);
            if (readClock() >= owned.deadline) throw new SafeError(ERROR_CODES.TIMEOUT);
            // Without a usable PRE-DISPATCH baseline, reproducing the payload is exactly the
            // observation the fail-open defect relied on, so this leg can never confirm.
            if (owned.baselineUsable[index] === true) {
              const observed = decodeText(value, leg.budget);
              // BOTH conditions: the observation reproduces the payload through this leg's own rule AND
              // it differs from the baseline. Equality with the baseline is "nothing observable
              // changed" — the mirror image of a false success — and never a confirmation.
              confirmed = observed === leg.expected && observed !== owned.baselines[index];
            }
          } catch { confirmed = false; }
          if (confirmed) {
            slot = null;
            settle(null, Object.freeze({ acknowledged: null, effectVerified: true }));
            notify();
            return;
          }
          confirmNextLeg();
        }
        try {
          plugin.executeMethod(leg.method, Object.freeze([]), legCallback);
        } catch {
          // A leg that cannot even be dispatched observed nothing: not confirmed, next leg. No private
          // native detail escapes and the mutation is never re-dispatched.
          confirmNextLeg();
        }
      }
      function confirmNextLeg() {
        if (slot !== owned || owned.settled) return;
        owned.confirmLeg += 1;
        // A leg whose baseline is unusable cannot confirm, so it is not asked for a post-dispatch read
        // at all: the ladder moves straight to the next leg that can still decide.
        while (owned.confirmLeg < owned.confirmLegs.length && owned.baselineUsable[owned.confirmLeg] !== true) owned.confirmLeg += 1;
        if (owned.confirmLeg < owned.confirmLegs.length) { dispatchConfirmLeg(); notify(); return; }
        // The whole ladder failed to confirm: the uncertain class, with the slot still held.
        owned.uncertain = true;
        settle(new SafeError(ERROR_CODES.APPLY_UNCERTAIN));
        notify();
      }
      function callback(value) {
        if (slot !== owned) return; // old/duplicate callback cannot release a new owner
        if (owned.settled) { slot = null; notify(); return; } // release only, never late content/UI
        // A second acknowledgement for this same dispatch cannot preempt the confirmation ladder the
        // first one started: this ticket's outcome is decided by that ladder alone.
        if (owned.confirming) return;
        try {
          if (signal?.aborted) throw new SafeError(ERROR_CODES.CANCELLED);
          if (readClock() >= owned.deadline) throw new SafeError(ERROR_CODES.TIMEOUT);
          let result;
          if (kind === 'insert') {
            const acknowledgement = insertAcknowledgement(value);
            if (acknowledgement === null) { confirmInsert(); return; }
            result = acknowledgement;
          } else if (kind === 'read') result = decodeText(value, LIMITS.selectionBytes);
          else if (kind === 'context') result = decodeContext(value);
          else if (kind === 'contextread') result = decodeText(value, readBound);
          else if (kind === 'probe') result = capabilities(decodePresence(value));
          else {
            if (typeof value !== 'boolean') throw new SafeError(ERROR_CODES.INVALID_DATA);
            result = Object.freeze({ acknowledged: value, effectVerified: false });
          }
          slot = null; // actual settlement releases SDK slot, even after caller expiry
          settle(null, result);
        } catch (error) {
          slot = null;
          // A callback that actually ARRIVED for an already-dispatched insert can still leave the effect
          // unproven (its deadline expired just before the callback was delivered, so the ticket's own
          // timer had not run yet). That is the uncertain class — never a plain known error about a
          // document the editor has already touched, and never a success.
          settle(kind === 'insert' && owned.dispatched ? new SafeError(ERROR_CODES.APPLY_UNCERTAIN) : errorFor(kind, error));
        }
        notify();
      }
      try {
        signal?.addEventListener('abort', cancel, { once: true });
        owned.timer = timers.schedule(function () {
          if (slot !== owned || owned.settled) return;
          if (!owned.dispatched) {
            // The deadline expired while this ticket had dispatched NOTHING: for an insert that is a
            // pre-dispatch baseline read that never answered (or an unreached paste). That is not the
            // uncertain class — the mutation never happened — so the honest outcome is the ticket's own
            // known class, and the slot is RELEASED so a later operation can proceed instead of finding
            // a bridge wedged behind a settled ticket. (A dispatched ticket keeps its own class below.)
            owned.uncertain = false;
            slot = null;
            settle(timeoutFor(kind, false));
            notify();
            return;
          }
          owned.uncertain = true;
          settle(timeoutFor(kind, true));
          notify();
        }, LIMITS.callbackTimeoutMs);
      } catch {
        slot = null; settle(new SafeError(ERROR_CODES.EDITOR_ERROR)); return;
      }
      try {
        // Return status (including false = queued) is NOT completion/rejection.
        if (kind === 'write') {
          // The controller's authored guard runs after timer acquisition, before
          // the irreversible boundary. No model callback/code reaches this path.
          try { beforeDispatch?.(); }
          catch (error) { slot = null; settle(error instanceof SafeError ? error : new SafeError(ERROR_CODES.EDITOR_ERROR)); return; }
          if (signal?.aborted || disposed) { slot = null; settle(new SafeError(ERROR_CODES.CANCELLED)); return; }
          owned.dispatched = true;
          plugin.executeMethod('ReplaceTextSmart', Object.freeze([Object.freeze([replacement]), '\t', '\n']), callback);
        } else if (kind === 'read') { owned.dispatched = true; plugin.executeMethod('GetSelectedText', Object.freeze([]), callback); }
        else if (kind === 'context') { owned.dispatched = true; command.probe('context', callback); }
        else if (kind === 'contextread') {
          // The editor method is reached BY NAME through the ONE public dispatch channel this bridge
          // owns, and that channel is verified with ownFunction (an OWN data-descriptor check on the
          // facade) exactly like every other public method the read/write paths use. The facade exposes
          // no editor method as its own property — `executeMethod` queues {methodName, params} and the
          // editor resolves it — so a `plugin.GetDocumentStructure` property check would prove nothing
          // about the installed build and is NOT consulted here. What this guard proves is the dispatch
          // channel plus the Api-surface presence signal the identity leg above already required; it
          // does NOT prove that the installed R7 build implements `GetDocumentStructure`. That remains
          // PENDING NATIVE VERIFICATION: an editor without the method never calls back, and the ticket
          // then settles by its own read class (TIMEOUT), never as a success.
          if (disposed || !adapter.executeMethod) { slot = null; settle(new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE)); return; }
          owned.dispatched = true;
          plugin.executeMethod('GetDocumentStructure', params, callback);
        } else if (kind === 'insert') {
          // The same guard, the same primitive, and the same limit on what is proven: the dispatch
          // channel is verified, the editor-side `PasteText` name is not. An editor that does not
          // implement the name never calls back, so the insert settles APPLY_UNCERTAIN (a write whose
          // acknowledgement never arrived may have applied) instead of claiming success. Whether the
          // installed R7 build exposes this public entry point under this name is PENDING NATIVE
          // VERIFICATION; nothing here reaches a private API or invents a second channel.
          if (disposed || !adapter.executeMethod) { slot = null; settle(new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE)); return; }
          // The pre-dispatch baseline phase owns the ticket first and ends by dispatching the paste
          // itself, so the mutation still happens exactly once and only after its baselines answered.
          beginInsert();
        } else { owned.dispatched = true; command.probe('capability', callback); }
      } catch {
        // Dispatch may have reached the SDK before throwing. Never unlock on a
        // synchronous exception unless its matching callback already settled.
        if (slot === owned && !owned.settled) {
          // The ticket's own closed class wins before any dispatch (an unavailable command channel, a
          // timer that could not be armed): nothing reached NATIVE work, so the caller gets the honest
          // code and the slot is released. After a dispatch the conservative uncertain path is kept,
          // because a dispatch that reached the SDK is never a release.
          if (!owned.dispatched) {
            slot = null;
            owned.uncertain = false;
            settle(error instanceof SafeError ? error : errorFor(kind, null));
            notify();
            return;
          }
          owned.uncertain = true;
          settle(errorFor(kind, null));
          notify();
        }
      }
    });
  }

  return Object.freeze({
    async readSelection({ signal } = {}) {
      ensureIdle();
      if (editor !== 'word' || currentEditor() !== editor || !adapter.executeMethod || !adapter.commandDispatch) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
      const owner = contextOwner;
      const text = await start('read', signal);
      if (signal?.aborted) throw new SafeError(ERROR_CODES.CANCELLED);
      ensureIdle();
      if (owner !== contextOwner || currentEditor() !== editor) throw new SafeError(ERROR_CODES.SELECTION_CHANGED);
      const id = await start('context', signal);
      if (signal?.aborted) throw new SafeError(ERROR_CODES.CANCELLED);
      if (disposed || owner !== contextOwner || currentEditor() !== editor) throw new SafeError(ERROR_CODES.SELECTION_CHANGED);
      const target = text === '' ? null : Object.freeze({});
      if (target) targets.set(target, Object.freeze({ owner, id, text }));
      return Object.freeze({ text, editorType: editor, eligible: target !== null, target, reason: target ? 'OWNED_ORDINARY_TEXT' : 'EMPTY_SELECTION' });
    },
    // Bounded public read of one addressed document region, served through the SAME single owned
    // callback slot as every other SDK operation. Every leg is classified: an unavailable public
    // read, a malformed native result and a byte-oversized read are closed classes, never a raw
    // exception. The read is decoded against the `maxBytes` budget the caller requested (capped by
    // the editor-result ceiling), so a paragraph/section read is not silently held to the selection
    // read's 8 KiB window. The caller's `signal` cancels both legs exactly as it does in
    // readSelection: an abort before a leg prevents that dispatch, an abort after one invalidates
    // the caller while the queued SDK work keeps the slot until its own callback. Whether the
    // installed R7 build exposes this public read method at all is PENDING NATIVE VERIFICATION —
    // until it is measured on the real editor the name is unproven and an editor that does not
    // implement it never calls back, which settles as TIMEOUT, never as a verified scope.
    async readContext(raw) {
      const scope = raw?.scope, index = raw?.index, maxBytes = raw?.maxBytes, signal = raw?.signal;
      // The scope is a closed descriptor enum, but the bridge is a public entry point: a caller that
      // is not this descriptor gets a refusal rather than an SDK call with an uninterpretable triple.
      if (!['paragraph', 'section', 'structure'].includes(scope)) return Object.freeze({ ok: false, code: ERROR_CODES.CAPABILITY_UNAVAILABLE });
      if (!Number.isSafeInteger(index) || index < 0) return Object.freeze({ ok: false, code: ERROR_CODES.CAPABILITY_UNAVAILABLE });
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) return Object.freeze({ ok: false, code: ERROR_CODES.CAPABILITY_UNAVAILABLE });
      try {
        ensureIdle();
        if (editor !== 'word' || currentEditor() !== editor) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        // One action, two legs on the same slot: the document identity check, then the bounded read.
        await start('context', signal);
        if (signal?.aborted) throw new SafeError(ERROR_CODES.CANCELLED);
        if (disposed) throw new SafeError(ERROR_CODES.CANCELLED);
        const text = await start('contextread', signal, { maxBytes }, Object.freeze([Object.freeze([scope, index, maxBytes])]));
        if (text === '') return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
        return Object.freeze({ ok: true, text });
      } catch (error) {
        return Object.freeze({ ok: false, code: error instanceof SafeError ? error.code : ERROR_CODES.EDITOR_ERROR });
      }
    },
    // Automatic insert through the public paste entry point, served through the SAME owned callback
    // slot and under the same document-identity proof as every other dispatched operation. The
    // dispatch channel is verified with ownFunction before the irreversible call; whether the
    // installed R7 build implements `PasteText` is PENDING NATIVE VERIFICATION — an editor that does
    // not implement it never calls back, so the ticket settles APPLY_UNCERTAIN rather than success.
    // An acknowledgement that carries NO value is the one measured case on the live 2026.3.1 build
    // (the paste applies and the callback receives `undefined`): the ticket reads one PRE-DISPATCH
    // baseline per confirmation leg, dispatches the paste exactly once, and then reports success only
    // when a leg's post-dispatch observation reproduces the dispatched payload through that leg's own
    // exact rule AND differs from that leg's baseline. A payload that was already in the caret scope is
    // therefore never a success, and a `PasteText` that silently mutates nothing fails every leg. No
    // mutation is ever retried by this bridge.
    // The caller's `signal` is honoured the same way: an abort before the paste is dispatched prevents
    // it (including during the baseline phase), an abort after dispatch keeps the write-class
    // uncertain-until-callback behaviour.
    async insertParagraph(raw) {
      const text = raw?.text, position = raw?.position ?? 'cursor', signal = raw?.signal;
      if (typeof text !== 'string' || text === '') return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
      if (position !== 'cursor' && position !== 'end') return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
      try {
        ensureIdle();
        if (editor !== 'word' || currentEditor() !== editor) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        // The command channel carries this insert's document-identity leg. When the build exposes
        // neither command entry point the refusal is made HERE, before any dispatch, exactly like the
        // read path above — and the slot it owned is released, because nothing reached the SDK.
        if (!adapter.commandDispatch) { slot = null; throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE); }
        // The document identity leg keeps this insert under the same ownership proof as every other
        // dispatched operation, and the Api-surface presence probe runs before the insert is dispatched.
        await start('context', signal);
        if (signal?.aborted) throw new SafeError(ERROR_CODES.CANCELLED);
        if (disposed) throw new SafeError(ERROR_CODES.CANCELLED);
        const acknowledgement = await start('insert', signal, {}, Object.freeze([position === 'end' ? `${text}\n` : text]));
        // A boolean acknowledgement keeps today's envelope EXACTLY — the payload was sent and the
        // effect is NOT verified by the callback's own value. The only other way this ticket can
        // settle is the confirmation ladder above, which reports `effectVerified` because a bounded
        // read really did reproduce the dispatched payload at a scope that did not already hold it; no
        // other path reaches this line with a success.
        return Object.freeze({ ok: true, data: Object.freeze(acknowledgement.effectVerified === true
          ? { sent: true, effectVerified: true }
          : { sent: acknowledgement.acknowledged }) });
      } catch (error) {
        return Object.freeze({ ok: false, code: error instanceof SafeError ? error.code : ERROR_CODES.EDITOR_ERROR });
      }
    },
    async probeCapabilities({ signal } = {}) {
      if (disposed) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
      if (slot !== null) throw new SafeError(ERROR_CODES.EDITOR_BUSY);
      if (signal?.aborted) throw new SafeError(ERROR_CODES.CANCELLED);
      if (editor !== 'word' || !adapter.commandDispatch) return capabilities();
      return start('probe', signal);
    },
    canApply(target) { try { return slot === null && ownedTarget(target) !== null; } catch { return false; } },
    async applySelection(raw) {
      const { target, replacement, signal, deadline = readClock() + LIMITS.applyObservationMs, beforeDispatch } = applyData(raw);
      ensureIdle();
      const saved = ownedTarget(target);
      if (!saved) throw new SafeError(ERROR_CODES.SELECTION_CHANGED);
      function check() {
        if (signal?.aborted) throw new SafeError(ERROR_CODES.CANCELLED);
        if (ownedTarget(target) !== saved) throw new SafeError(ERROR_CODES.SELECTION_CHANGED);
        if (readClock() >= deadline) throw new SafeError(ERROR_CODES.TIMEOUT);
        ensureIdle();
      }
      async function currentIdentity() {
        check();
        let id;
        try { id = await start('context', signal); }
        catch (error) {
          if (error instanceof SafeError && [ERROR_CODES.INVALID_DATA, ERROR_CODES.CAPABILITY_UNAVAILABLE].includes(error.code)) throw new SafeError(ERROR_CODES.SELECTION_CHANGED);
          throw error;
        }
        check();
        if (id !== saved.id) throw new SafeError(ERROR_CODES.SELECTION_CHANGED);
      }
      await currentIdentity();
      const text = await start('read', signal);
      check();
      if (text === '' || text !== saved.text) throw new SafeError(ERROR_CODES.SELECTION_CHANGED);
      await currentIdentity();
      check();
      // Consume once. Async check/write is not atomic or an immutable locator.
      targets.delete(target);
      return start('write', signal, { replacement, beforeDispatch });
    },
    subscribe(listener) { listeners.add(listener); return function () { listeners.delete(listener); }; },
    getState() { return Object.freeze({ editorType: editor, busy: slot !== null, uncertain: slot?.uncertain ?? false, disposed, writePending: pendingMutation(slot) }); },
    invalidate() { contextOwner = Object.freeze({}); slot?.cancel(); },
    dispose() { disposed = true; contextOwner = Object.freeze({}); slot?.cancel(); }
  });
}
