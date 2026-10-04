import { LIMITS } from '../shared/limits.js';
import { assertByteLimit } from '../shared/bytes.js';
import { ERROR_CODES, SafeError } from '../shared/errors.js';
import { dispatchCapabilityProbe, dispatchContextProbe } from './commands.js';

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
// A native insert acknowledgement. Anything that is not a boolean is a malformed native result and
// never a success claim: the effect of an insert is not verified by the callback's own return value.
function insertAcknowledgement(value) {
  if (typeof value !== 'boolean') throw new SafeError(ERROR_CODES.INVALID_DATA);
  return Object.freeze({ acknowledged: value, effectVerified: false });
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
function timeoutFor(kind) {
  if (kind === 'write' || kind === 'insert') return new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
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
  const adapter = Object.freeze({ executeMethod: ownFunction(plugin, 'executeMethod'), commandDispatch: ownFunction(plugin, 'callCommand') });
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
        owned.uncertain = true;
        // A write-class call that was already dispatched may have applied; before dispatch the only
        // real outcome is the cancellation, so the caller gets the honest class back.
        settle(errorFor(kind, (kind === 'write' || kind === 'insert') && owned.dispatched ? null : new SafeError(ERROR_CODES.CANCELLED)));
      }
      owned.cancel = cancel;
      function callback(value) {
        if (slot !== owned) return; // old/duplicate callback cannot release a new owner
        slot = null; // actual settlement releases SDK slot, even after caller expiry
        if (owned.settled) { notify(); return; } // release only, never late content/UI
        try {
          if (signal?.aborted) throw new SafeError(ERROR_CODES.CANCELLED);
          if (readClock() >= owned.deadline) throw new SafeError(ERROR_CODES.TIMEOUT);
          let result;
          if (kind === 'read') result = decodeText(value, LIMITS.selectionBytes);
          else if (kind === 'context') result = decodeContext(value);
          else if (kind === 'contextread') result = decodeText(value, readBound);
          else if (kind === 'insert') result = insertAcknowledgement(value);
          else if (kind === 'probe') result = capabilities(decodePresence(value));
          else {
            if (typeof value !== 'boolean') throw new SafeError(ERROR_CODES.INVALID_DATA);
            result = Object.freeze({ acknowledged: value, effectVerified: false });
          }
          settle(null, result);
        } catch (error) {
          settle(errorFor(kind, error));
        }
        notify();
      }
      try {
        signal?.addEventListener('abort', cancel, { once: true });
        owned.timer = timers.schedule(function () {
          if (slot !== owned || owned.settled) return;
          owned.uncertain = true;
          settle(timeoutFor(kind));
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
        } else if (kind === 'read') plugin.executeMethod('GetSelectedText', Object.freeze([]), callback);
        else if (kind === 'context') dispatchContextProbe(plugin, callback);
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
          plugin.executeMethod('GetDocumentStructure', params, callback);
        } else if (kind === 'insert') {
          // The same guard, the same primitive, and the same limit on what is proven: the dispatch
          // channel is verified, the editor-side `PasteText` name is not. An editor that does not
          // implement the name never calls back, so the insert settles APPLY_UNCERTAIN (a write whose
          // acknowledgement never arrived may have applied) instead of claiming success. Whether the
          // installed R7 build exposes this public entry point under this name is PENDING NATIVE
          // VERIFICATION; nothing here reaches a private API or invents a second channel.
          if (disposed || !adapter.executeMethod) { slot = null; settle(new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE)); return; }
          owned.dispatched = true;
          plugin.executeMethod('PasteText', params, callback);
        } else dispatchCapabilityProbe(plugin, callback);
      } catch {
        // Dispatch may have reached the SDK before throwing. Never unlock on a
        // synchronous exception unless its matching callback already settled.
        if (slot === owned && !owned.settled) {
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
    // The caller's `signal` is honoured the same way: an abort before dispatch prevents it, an abort
    // after dispatch keeps the write-class uncertain-until-callback behaviour.
    async insertParagraph(raw) {
      const text = raw?.text, position = raw?.position ?? 'cursor', signal = raw?.signal;
      if (typeof text !== 'string' || text === '') return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
      if (position !== 'cursor' && position !== 'end') return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
      try {
        ensureIdle();
        if (editor !== 'word' || currentEditor() !== editor) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        // The document identity leg keeps this insert under the same ownership proof as every other
        // dispatched operation, and the Api-surface presence probe runs before the insert is dispatched.
        await start('context', signal);
        if (signal?.aborted) throw new SafeError(ERROR_CODES.CANCELLED);
        if (disposed) throw new SafeError(ERROR_CODES.CANCELLED);
        const acknowledgement = await start('insert', signal, {}, Object.freeze([position === 'end' ? `${text}\n` : text]));
        return Object.freeze({ ok: true, data: Object.freeze({ sent: acknowledgement.acknowledged }) });
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
