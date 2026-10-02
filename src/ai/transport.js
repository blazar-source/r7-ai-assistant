import { createRequest, parseModelContent } from './protocol.js';
import { LIMITS } from '../shared/limits.js';
import { ERROR_CODES, SafeError } from '../shared/errors.js';

// Injection uses schedule/clear so the authored audit sees literal synchronous timer bodies.
const defaultTimers = Object.freeze({
  schedule(callback, ms) { return globalThis.setTimeout(() => { callback(); }, ms); },
  clear(id) { globalThis.clearTimeout(id); }
});
const defaultClock = Object.freeze({ now: () => Date.now() });
function safe(code) { return new SafeError(code); }
function httpCode(status) {
  if (status === 401) return ERROR_CODES.HTTP_UNAUTHORIZED;
  if (status === 403) return ERROR_CODES.HTTP_FORBIDDEN;
  if (status === 429) return ERROR_CODES.HTTP_RATE_LIMIT;
  if (status >= 500 && status <= 599) return ERROR_CODES.HTTP_SERVER_ERROR;
  return ERROR_CODES.HTTP_ERROR;
}
function cancelReader(reader) {
  try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* Cleanup is best effort, never a raw error. */ }
}
function releaseReader(reader) {
  try { reader.releaseLock(); } catch { /* Pending platform read may still own its lock. */ }
}
function discardResponse(response) {
  try {
    if (typeof response?.body?.cancel === 'function') Promise.resolve(response.body.cancel()).catch(() => {});
  } catch { /* Late settlement has no caller ownership. */ }
}

// deadline is the caller's absolute operation deadline (same clock), e.g. analysis-start + 150000.
// It can shorten, never extend, the locally owned total/HTTP deadlines. No retries/repair.
export async function requestCompletion(settings, messages, uuid, options = {}) {
  const request = createRequest(settings, messages, uuid);
  const mode = options.mode ?? 'ASK';
  if (mode !== 'ASK' && mode !== 'EDIT') throw safe(ERROR_CODES.INVALID_DATA);
  const fetch = options.fetch ?? globalThis.fetch;
  const clock = options.clock ?? defaultClock;
  const timers = options.timers ?? defaultTimers;
  const signal = options.signal;
  if (typeof fetch !== 'function' || typeof globalThis.AbortController !== 'function' || typeof globalThis.TextDecoder !== 'function' ||
      typeof clock?.now !== 'function' || typeof timers?.schedule !== 'function' || typeof timers?.clear !== 'function') throw safe(ERROR_CODES.CAPABILITY_UNAVAILABLE);
  if (signal?.aborted) throw safe(ERROR_CODES.CANCELLED);
  if ((options.online ?? globalThis.navigator?.onLine) === false) throw safe(ERROR_CODES.OFFLINE);
  const start = clock.now();
  if (!Number.isFinite(start) || (options.deadline !== undefined && !Number.isFinite(options.deadline))) throw safe(ERROR_CODES.INVALID_DATA);
  const deadline = Math.min(start + LIMITS.operationTimeoutMs, options.deadline ?? Infinity, start + request.settings.httpTimeoutSeconds * 1000);
  if (start >= deadline) throw safe(ERROR_CODES.TIMEOUT);
  const controller = new AbortController();
  let stopped = null;
  let finished = false;
  let reader = null;
  let response = null;
  let discarded = false;
  let timer;
  let rejectStop;
  const interruption = new Promise((resolve, reject) => { rejectStop = reject; });
  // Attach a handler even when timer/signal setup fails before the first race.
  interruption.catch(() => {});
  function stop(code) {
    if (finished || stopped) return;
    stopped = safe(code);
    rejectStop(stopped);
    controller.abort();
  }
  function check() {
    if (stopped) throw stopped;
    if (signal?.aborted) stop(ERROR_CODES.CANCELLED);
    else if (clock.now() >= deadline) stop(ERROR_CODES.TIMEOUT);
    if (stopped) throw stopped;
  }
  const onAbort = () => { stop(ERROR_CODES.CANCELLED); };
  try {
    signal?.addEventListener('abort', onAbort, { once: true });
    check();
    timer = timers.schedule(() => { stop(ERROR_CODES.TIMEOUT); }, deadline - start);
    check();
    // Late fulfillment is handled separately, without parsing/reading a body after cancellation.
    const pendingFetch = Promise.resolve(fetch(request.endpoint, Object.freeze({ method: 'POST', headers: request.headers, body: request.body,
      redirect: 'error', signal: controller.signal, credentials: 'omit', cache: 'no-store' }))).then(response => {
      if (stopped || finished) { discardResponse(response); discarded = true; }
      return response;
    }, () => { throw safe(ERROR_CODES.NETWORK_ERROR); });
    response = await Promise.race([pendingFetch, interruption]);
    check();
    if (!Number.isInteger(response?.status) || response.status < 200 || response.status >= 300) {
      throw safe(httpCode(response?.status));
    }
    if (typeof response.body?.getReader !== 'function') throw safe(ERROR_CODES.CAPABILITY_UNAVAILABLE);
    reader = response.body.getReader();
    if (typeof reader?.read !== 'function' || typeof reader?.cancel !== 'function' || typeof reader?.releaseLock !== 'function') throw safe(ERROR_CODES.CAPABILITY_UNAVAILABLE);
    const chunks = [];
    let bytes = 0;
    while (true) {
      check();
      const chunk = await Promise.race([Promise.resolve(reader.read()).catch(() => { throw safe(ERROR_CODES.NETWORK_ERROR); }), interruption]);
      check();
      if (!chunk || typeof chunk.done !== 'boolean') throw safe(ERROR_CODES.PROTOCOL_ERROR);
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) throw safe(ERROR_CODES.PROTOCOL_ERROR);
      // Count the incoming transport bytes BEFORE retaining/copying the chunk or parsing anything.
      if (chunk.value.byteLength > LIMITS.httpEnvelopeBytes - bytes) throw safe(ERROR_CODES.BYTE_LIMIT);
      bytes += chunk.value.byteLength;
      // Empty reads must not accumulate unbounded zero-byte chunk objects.
      if (chunk.value.byteLength !== 0) chunks.push(new Uint8Array(chunk.value));
    }
    check();
    const buffer = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
    let envelope;
    try { envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)); }
    catch { throw safe(ERROR_CODES.PROTOCOL_ERROR); }
    check();
    if (!Array.isArray(envelope?.choices) || envelope.choices.length !== 1 || typeof envelope.choices[0]?.message?.content !== 'string') throw safe(ERROR_CODES.PROTOCOL_ERROR);
    const result = parseModelContent(envelope.choices[0].message.content, mode);
    check();
    finished = true;
    return result;
  } catch (error) {
    controller.abort();
    if (reader) cancelReader(reader);
    else if (response && !discarded) discardResponse(response);
    if (stopped) throw stopped;
    if (error instanceof SafeError) throw safe(error.code);
    // Fetch/reader exceptions cannot reliably separate DNS, CORS, TLS or network faults in CEF.
    throw safe(ERROR_CODES.NETWORK_ERROR);
  } finally {
    finished = true;
    if (timer !== undefined) timers.clear(timer);
    signal?.removeEventListener('abort', onAbort);
    if (reader) releaseReader(reader);
  }
}
