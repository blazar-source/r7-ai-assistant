import { LIMITS } from '../shared/limits.js';
import { assertByteLimit } from '../shared/bytes.js';
import { ERROR_CODES, SafeError } from '../shared/errors.js';
import { dispatchCapabilityProbe } from './commands.js';

// Identity leases persist through disposal: replacing a JS adapter is not proof
// that queued SDK work was retracted. Only a genuinely new initialized plugin
// object may start a new lifecycle. Never call SDK outside this sole bridge.
const pluginOwners = new WeakSet();
const MUTATION_REASON = 'MUTATION_PROOF_UNRESOLVED';
const presenceKeys = Object.freeze(['api', 'getDocument', 'getDocumentId', 'replaceTextSmart', 'getRangeBySelect', 'isTrackRevisions']);

// Inspect data descriptors, never extract a command function for execution.
function ownFunction(object, name) {
  if (!object || typeof object !== 'object') return false;
  const descriptor = Object.getOwnPropertyDescriptors(object)[name];
  return !!descriptor && typeof descriptor.value === 'function';
}
function decodePresence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length === 1 && keys[0] === 'error' && descriptors.error.value === 'CAPABILITY_UNAVAILABLE') {
    throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
  }
  if (keys.length !== presenceKeys.length || keys.some(key => !presenceKeys.includes(key))) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const result = {};
  for (const key of presenceKeys) {
    const descriptor = descriptors[key];
    if (!descriptor || typeof descriptor.value !== 'boolean' || !descriptor.enumerable) throw new SafeError(ERROR_CODES.INVALID_DATA);
    result[key] = descriptor.value;
  }
  // Closed six-boolean schema is small before serialization; never stringify an
  // arbitrary callback object, accessors, hidden data, JSON or live range handles.
  assertByteLimit(JSON.stringify(result), LIMITS.editorResultBytes);
  return Object.freeze(result);
}
function decodeSelection(value, editorType) {
  assertByteLimit(value, LIMITS.editorResultBytes);
  assertByteLimit(value, LIMITS.selectionBytes);
  return Object.freeze({ text: value, editorType, eligible: false, target: null, reason: MUTATION_REASON });
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
  function start(kind, signal) {
    if (signal?.aborted) return Promise.reject(new SafeError(ERROR_CODES.CANCELLED));
    return new Promise((resolve, reject) => {
      const owned = { uncertain: false, settled: false, timer: null, deadline: readClock() + LIMITS.callbackTimeoutMs, cancel: null };
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
        settle(new SafeError(ERROR_CODES.CANCELLED));
      }
      owned.cancel = cancel;
      function callback(value) {
        if (slot !== owned) return; // old/duplicate callback cannot release a new owner
        slot = null; // actual settlement releases SDK slot, even after caller expiry
        if (owned.settled) return; // never process late content or update caller/UI
        try {
          if (signal?.aborted) throw new SafeError(ERROR_CODES.CANCELLED);
          if (readClock() >= owned.deadline) throw new SafeError(ERROR_CODES.TIMEOUT);
          settle(null, kind === 'read' ? decodeSelection(value, editor) : capabilities(decodePresence(value)));
        } catch (error) {
          settle(error instanceof SafeError ? error : new SafeError(ERROR_CODES.EDITOR_ERROR));
        }
      }
      try {
        signal?.addEventListener('abort', cancel, { once: true });
        owned.timer = timers.schedule(function () {
          if (slot !== owned || owned.settled) return;
          owned.uncertain = true;
          settle(new SafeError(ERROR_CODES.TIMEOUT));
        }, LIMITS.callbackTimeoutMs);
      } catch {
        slot = null; settle(new SafeError(ERROR_CODES.EDITOR_ERROR)); return;
      }
      try {
        // Return status (including false = queued) is NOT completion/rejection.
        if (kind === 'read') plugin.executeMethod('GetSelectedText', Object.freeze([]), callback);
        else dispatchCapabilityProbe(plugin, callback);
      } catch {
        // Dispatch may have reached the SDK before throwing. Never unlock on a
        // synchronous exception unless its matching callback already settled.
        if (slot === owned && !owned.settled) {
          owned.uncertain = true;
          settle(new SafeError(ERROR_CODES.EDITOR_ERROR));
        }
      }
    });
  }

  return Object.freeze({
    async readSelection({ signal } = {}) {
      ensureIdle();
      if (editor !== 'word' || !adapter.executeMethod) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
      return start('read', signal);
    },
    async probeCapabilities({ signal } = {}) {
      if (disposed) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
      if (slot !== null) throw new SafeError(ERROR_CODES.EDITOR_BUSY);
      if (signal?.aborted) throw new SafeError(ERROR_CODES.CANCELLED);
      if (editor !== 'word' || !adapter.commandDispatch) return capabilities();
      return start('probe', signal);
    },
    async applySelection() {
      // Public JSON is lossy. No proved exhaustive domain/body ownership, stable
      // target/revision/handle lifetime or atomic write. Do not inspect or bless
      // caller-provided target certificates; do not dispatch ANY mutation.
      throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
    },
    getState() { return Object.freeze({ editorType: editor, busy: slot !== null, uncertain: slot?.uncertain ?? false, disposed }); },
    invalidate() { slot?.cancel(); },
    dispose() { disposed = true; slot?.cancel(); }
  });
}
