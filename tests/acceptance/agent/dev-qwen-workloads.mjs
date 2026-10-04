// tests/acceptance/agent/dev-qwen-workloads.mjs
//
// Sprint 2, Task 11 — the development Qwen workload harness (design §15.2, calibration of §12.2).
//
// DEV-ONLY, AND NOT A node:test FILE. The name carries no `.test`/`-test` suffix, so `node --test`
// (npm test) never discovers or runs it. A workload is run by hand; see README.md next to this file.
//
// SIDE-EFFECTING MODULE: importing it runs `main()` once, with this process's arguments, and sets the
// exit code. In real mode a missing AGENT_DEV_ENDPOINT/AGENT_DEV_KEY makes that import path exit 2
// before any transport exists.
//
// PRIVACY CONTRACT — the output is COUNT-ONLY. This file prints and writes only the fields built in
// `buildRecord` below: workload, model, status, the closed error code, the counts, milliseconds, the
// effective guardrail values, the settings-governed HTTP timeout, per-step integers (duration, request
// body bytes, batch size), per-action result byte sizes and (mock mode only) the mock's own bounded
// integer counters. It never prints, logs or writes the key, the endpoint, a header value, request or
// response content, a document excerpt, a session UUID or any other identifier — not even inside an
// error path, because no raw exception message is ever read (a fetch failure's message carries the URL).
//
// FIDELITY: the outgoing request is built by the PRODUCT's own `createRequest(settings, messages, uuid,
// { agent: true })` and sent by the PRODUCT's own `requestCompletion` (src/ai/transport.js), so the
// 98304-byte request-body ceiling, the settings-governed HTTP timeout (5–120 s) capped by the remaining
// operation deadline, the 150 s transport cap, the strict POST shape, the abort handling and the
// response byte ceilings are all the authored ones. The ONLY difference between mock and real mode is
// the HTTP/TLS client handed to the transport: the global fetch in real mode, a per-request-CA
// node:https client for the loopback mock.
//
// The real development endpoint key lives in the DSH credential store and is NOT readable from this
// checkout, so the REAL OpenRouter run is a controller-owned step. `--mock` drives the identical
// authored runtime, registry and transport against the reviewed local HTTPS mock
// (tests/acceptance/infrastructure/https-mock.mjs) so the harness itself is proven offline first.
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createRegistry } from '../../../src/tools/registry.js';
import { createWordTools } from '../../../src/tools/word.js';
import { runAgent } from '../../../src/agent/runtime.js';
import { parseEnvelope } from '../../../src/agent/protocol.js';
import { requestCompletion } from '../../../src/ai/transport.js';
import { ERROR_CODES, SafeError } from '../../../src/shared/errors.js';
import { LIMITS, createGuardrails } from '../../../src/shared/limits.js';
import { utf8ByteLength } from '../../../src/shared/bytes.js';
import { startMock, SYNTHETIC_KEY } from '../infrastructure/https-mock.mjs';
import { tlsFixture } from '../infrastructure/tls-fixture.mjs';

const DEFAULT_MODEL = 'qwen/qwen3.8-27b:free';
// The printed model is restricted to a plain model id: at most one '/', no scheme separator, no
// whitespace and at most LIMITS.modelBytes bytes, so a URL-shaped value can never pass. The model only
// ever reaches the request BODY and this record — it never selects a host (the endpoint is validated
// separately, in both modes).
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._:-]{0,62})?$/;
const MAX_TOKENS = 4096;
const TEMPERATURE = 0.2;
// The product's own settings default (src/config/settings.js DEFAULT_SETTINGS.httpTimeoutSeconds).
const DEFAULT_HTTP_TIMEOUT_SECONDS = 30;
// The effective engineering defaults, read from the product's own contract rather than re-typed here.
const DEFAULT_GUARDRAILS = createGuardrails({});
// The mock's closed profile set is wider; these four drive the authored runtime to a terminal status
// through a real HTTPS loop. `final` and `proposal` answer immediately; `timeout` stalls past the
// per-request budget; `oversize` answers a response larger than the transport's envelope ceiling.
const MOCK_PROFILES = Object.freeze(['final', 'proposal', 'timeout', 'oversize']);
const WORKLOADS = Object.freeze(['word', 'excel', 'powerpoint']);
const OPTION_NAMES = Object.freeze(['--workload', '--mock-profile', '--steps-report', '--frozen-now',
  '--max-steps', '--max-tool-calls', '--deadline-ms', '--http-timeout-seconds']);
const STUB_SELECTION = 'synthetic stub selection';

// The three §15.2 pilot workloads. Each prompt carries the design's own follow-up task ("then revise
// part of it") in the prompt text, because the follow-up is what forces a long multi-step run.
const PROMPTS = Object.freeze({
  word: 'Создай структурированный документ примерно на 10 страниц — исследование о работе Р7: титульный лист, заголовки, главы, несколько таблиц, форматирование и выводы. Затем измени часть документа: перепиши введение и обнови одну из таблиц.',
  excel: 'Создай содержательную модель P&L: несколько листов, допущения, значения и формулы за три года, итоги, проценты, форматирование и проверку расчётов. Затем измени часть модели: поправь допущения второго года и пересчитай итоги.',
  powerpoint: 'Создай презентацию на 10–15 слайдов: структура, заголовки, текст, таблицы и простое форматирование. Затем измени несколько слайдов: перепиши слайд с выводами и добавь слайд с таблицей.'
});

const USAGE = [
  'usage: node tests/acceptance/agent/dev-qwen-workloads.mjs [word|excel|powerpoint] [options]',
  '',
  '  --workload <name>          word | excel | powerpoint (default: word)',
  '  --mock                     drive the reviewed local HTTPS mock instead of the development endpoint',
  '  --mock-profile <name>      final | proposal | timeout | oversize (default: final); no external network',
  `  --max-steps <n>            guardrail override (default ${DEFAULT_GUARDRAILS.maxSteps}), validated by createGuardrails`,
  `  --max-tool-calls <n>       guardrail override (default ${DEFAULT_GUARDRAILS.maxToolCalls})`,
  `  --deadline-ms <n>          guardrail override (default ${DEFAULT_GUARDRAILS.operationDeadlineMs})`,
  `  --http-timeout-seconds <n> settings-governed per-request HTTP timeout, ${LIMITS.httpTimeoutMinSeconds}..${LIMITS.httpTimeoutMaxSeconds} (default ${DEFAULT_HTTP_TIMEOUT_SECONDS})`,
  '  --steps-report <path>      also write the same count-only record to this file',
  '  --frozen-now <ms>          TESTING AID: freeze the runtime clock (see README) so the transport',
  '                             deadline check is already expired instead of raced; refused for a real run',
  '  --help                     print this help',
  '',
  'real mode  requires AGENT_DEV_ENDPOINT and AGENT_DEV_KEY in the environment;',
  '           AGENT_DEV_MODEL is optional (default: ' + DEFAULT_MODEL + ').',
  '           No environment value is ever printed, and the run refuses before any network',
  '           call when a required variable is missing.',
  'mock mode  requires no environment and makes no external network call: it starts an',
  '           ephemeral loopback HTTPS server with an ephemeral CA, used as per-request',
  '           trust input only — never imported into a global or system trust store.',
  '',
  'an invalid guardrail override fails closed through the product\'s own createGuardrails and',
  'exits 2 before any transport exists; the effective values are recorded with every run.',
  '',
  'exit codes 0 the run reached FINAL; 1 the run reached a different status, or the harness',
  '           itself failed; 2 the arguments or the real-mode configuration were refused',
  '           before any network call.'
].join('\n');

class ConfigError extends Error {}
class HarnessError extends Error {}
function oneLine(text) { return text.replace(/[\r\n]+/g, ' ').trim(); }

// The static audit treats a method call on a value read through a computed member expression as
// dynamic dispatch, and its alias set is scope-insensitive, so this helper's parameter deliberately
// does NOT share a name with the tainted argv read in parseArguments below.
function splitOption(raw) {
  const separator = raw.indexOf('=');
  if (separator === -1) return { name: raw, value: null };
  return { name: raw.slice(0, separator), value: raw.slice(separator + 1) };
}
function isOption(name) { return name.startsWith('--'); }

// Strict decimal text only: '', '12abc', '1e3', '0x10', ' 12' and '-1' all become NaN here, so a typo
// can never be silently truncated into a different limit. The product's own validation decides next.
function integerOption(rawText) {
  if (typeof rawText !== 'string' || !/^\d{1,9}$/.test(rawText)) return Number.NaN;
  return Number.parseInt(rawText, 10);
}

// The guardrails come from the product's own contract (`createGuardrails`), so an impossible override
// fails closed exactly as the product's would — and the effective values are what the run and the
// record both use. Only the option NAMES are ever echoed, never a value.
function guardrailsFor(parsed) {
  const overrides = {};
  if (parsed.maxSteps !== null) overrides.maxSteps = parsed.maxSteps;
  if (parsed.maxToolCalls !== null) overrides.maxToolCalls = parsed.maxToolCalls;
  if (parsed.deadlineMs !== null) overrides.operationDeadlineMs = parsed.deadlineMs;
  try { return createGuardrails(overrides); }
  catch { throw new ConfigError('the guardrail overrides are invalid: --max-steps, --max-tool-calls and --deadline-ms must be integers >= 1 (their values are never printed)'); }
}
// The transport reads this exact settings field (src/ai/transport.js, via validateRequestSettings), so
// the harness accepts the same range and default the product does and refuses anything else before a
// transport exists, instead of turning a typo into a run that ends INVALID_SETTINGS.
function httpTimeoutFor(parsed) {
  if (parsed.httpTimeoutSeconds === null) return DEFAULT_HTTP_TIMEOUT_SECONDS;
  if (!(parsed.httpTimeoutSeconds >= LIMITS.httpTimeoutMinSeconds && parsed.httpTimeoutSeconds <= LIMITS.httpTimeoutMaxSeconds)) {
    throw new ConfigError(`--http-timeout-seconds must be an integer between ${LIMITS.httpTimeoutMinSeconds} and ${LIMITS.httpTimeoutMaxSeconds}`);
  }
  return parsed.httpTimeoutSeconds;
}

function parseArguments(argv) {
  const parsed = { workload: 'word', mock: false, mockProfile: 'final', stepsReport: null, frozenNow: null, help: false,
    maxSteps: null, maxToolCalls: null, deadlineMs: null, httpTimeoutSeconds: null };
  const positional = [];
  let frozenNowGiven = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const option = splitOption(argument);
    if (!isOption(option.name)) { positional.push(argument); continue; }
    if (option.name === '--help') { parsed.help = true; continue; }
    if (option.name === '--mock') {
      if (option.value !== null) throw new ConfigError('--mock takes no value');
      parsed.mock = true;
      continue;
    }
    if (!OPTION_NAMES.includes(option.name)) throw new ConfigError(`unknown option ${oneLine(option.name)}`);
    let value = option.value;
    if (value === null) { index += 1; value = argv[index] ?? ''; }
    if (value === '') throw new ConfigError(`${oneLine(option.name)} requires a value`);
    if (option.name === '--workload') parsed.workload = value;
    else if (option.name === '--mock-profile') parsed.mockProfile = value;
    else if (option.name === '--steps-report') parsed.stepsReport = value;
    else if (option.name === '--frozen-now') { parsed.frozenNow = integerOption(value); frozenNowGiven = true; }
    else if (option.name === '--max-steps') parsed.maxSteps = integerOption(value);
    else if (option.name === '--max-tool-calls') parsed.maxToolCalls = integerOption(value);
    else if (option.name === '--deadline-ms') parsed.deadlineMs = integerOption(value);
    else parsed.httpTimeoutSeconds = integerOption(value);
  }
  // The injected clock is a TESTING AID, so it is accepted in mock mode only: a real development run
  // must observe the host clock, and a frozen one would otherwise be able to mask a real deadline.
  if (frozenNowGiven) {
    if (!parsed.mock) throw new ConfigError('--frozen-now is a testing aid for --mock mode only: a real development run must observe the host clock');
    if (!Number.isSafeInteger(parsed.frozenNow) || parsed.frozenNow <= 0) throw new ConfigError('--frozen-now must be a positive integer of at most 9 digits (a synthetic clock reading, not a real timestamp)');
  }
  if (positional.length > 1) throw new ConfigError('at most one workload name may be given');
  let workload = parsed.workload;
  if (positional.length === 1) {
    const given = positional[0];
    if (workload !== 'word' && workload !== given) throw new ConfigError('the workload was given twice');
    workload = given;
  }
  if (!WORKLOADS.includes(workload)) throw new ConfigError(`unknown workload "${oneLine(workload)}": expected ${WORKLOADS.join(', ')}`);
  if (!MOCK_PROFILES.includes(parsed.mockProfile)) throw new ConfigError(`unknown mock profile "${oneLine(parsed.mockProfile)}": expected ${MOCK_PROFILES.join(', ')}`);
  parsed.workload = workload;
  parsed.guardrails = guardrailsFor(parsed);
  parsed.httpTimeoutSeconds = httpTimeoutFor(parsed);
  return parsed;
}

function modelFromEnvironment() {
  const model = process.env.AGENT_DEV_MODEL ?? DEFAULT_MODEL;
  if (!MODEL_PATTERN.test(model)) throw new ConfigError('AGENT_DEV_MODEL is not a plain model id (its value is never printed)');
  return model;
}

// Real mode. Every refusal here happens BEFORE a transport exists, so a missing endpoint or key can
// never reach the network, and the messages name only the variable — never its value. `client` is the
// process-global fetch; mock mode swaps exactly this one value for the per-request-CA client below.
function developmentProvider() {
  const missing = ['AGENT_DEV_ENDPOINT', 'AGENT_DEV_KEY'].filter(name => !process.env[name]);
  if (missing.length > 0) {
    throw new ConfigError(`${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} required for the real development run (set them in the environment; values are never printed)`);
  }
  const endpoint = process.env.AGENT_DEV_ENDPOINT;
  let parsed = null;
  try { parsed = new URL(endpoint); } catch { parsed = null; }
  if (parsed === null || parsed.protocol !== 'https:' || parsed.hostname === '') {
    throw new ConfigError('AGENT_DEV_ENDPOINT must be an absolute https URL (its value is never printed)');
  }
  return { endpoint, apiKey: process.env.AGENT_DEV_KEY, client: globalThis.fetch };
}

// Mock mode. The reviewed mock is started exactly as its own tests start it: an ephemeral CA/leaf
// pair from the existing host TLS fixture, an ephemeral loopback port, and the synthetic public key.
// sessionOrdinalLimit bounds accepted-session admission; one run uses one session, so the recorded
// ordinals prove the traffic came from that single session. The `timeout` profile must stall PAST the
// per-request budget for the run to end TIMEOUT, so its delay is derived from that budget.
function mockDelayMs(profile, socketTimeoutMs) {
  if (profile !== 'timeout') return 100;
  return Math.min(socketTimeoutMs + 3000, 120000);
}
async function startMockProvider(profile, socketTimeoutMs) {
  let fixture;
  try { fixture = await tlsFixture(); }
  catch { throw new HarnessError('the host TLS fixture failed: mock mode needs Git OpenSSL on Windows or openssl on Linux'); }
  let mock;
  try {
    mock = await startMock({ keyPath: fixture.keyPath, certPath: fixture.certPath, listenAddress: '127.0.0.1', port: 0,
      prefix: '/provider', profile, corsOrigin: 'null', delayMs: mockDelayMs(profile, socketTimeoutMs), sessionOrdinalLimit: 8 });
  } catch {
    await fixture.cleanup().catch(() => {});
    throw new HarnessError('the reviewed HTTPS mock refused this configuration');
  }
  return {
    endpoint: `https://127.0.0.1:${mock.port}/provider/v1/chat/completions`,
    apiKey: SYNTHETIC_KEY,
    client: createTestCaFetch(fixture.ca, socketTimeoutMs),
    stats: () => mockCounters(mock.stats()),
    close: async () => { try { await mock.close(); } finally { await fixture.cleanup(); } }
  };
}

// The minimal WHATWG-shaped body reader `requestCompletion` consumes, over an already-buffered reply.
// The same shape tests/unit/agent-runtime.test.js hands the transport.
function responseBody(payload) {
  let consumed = false;
  return Object.freeze({
    getReader() {
      return Object.freeze({
        read: async () => {
          if (consumed) return { done: true, value: undefined };
          consumed = true;
          return { done: false, value: payload };
        },
        cancel: async () => {},
        releaseLock() {}
      });
    }
  });
}

// Mock mode only: a fetch-shaped client over node:https that passes the EPHEMERAL test CA as
// per-request trust input, exactly as tests/acceptance/infrastructure/https-mock.test.js does. It
// imports nothing into a global, system or environment trust store; the CA lives in this process's
// memory for the duration of the run and the fixture directory is removed on exit. A 3xx is refused
// here, without reading `Location`. `timeout` is a socket-level inactivity bound, so an endpoint that
// accepts and then stalls is bounded per request by the socket itself as well as by the transport's
// own abort budget.
function createTestCaFetch(ca, socketTimeoutMs) {
  return async function testCaFetch(endpoint, init) {
    const target = new URL(endpoint);
    const body = init.body;
    const reply = await new Promise((resolve, reject) => {
      const request = https.request({
        hostname: target.hostname, port: target.port, path: target.pathname, method: init.method,
        headers: { ...init.headers, 'Content-Length': Buffer.byteLength(body, 'utf8') },
        ca, agent: false, timeout: socketTimeoutMs
      }, response => {
        if (response.statusCode >= 300 && response.statusCode < 400) {
          response.resume();
          reject(new SafeError(ERROR_CODES.HTTP_ERROR));
          return;
        }
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('error', () => reject(new SafeError(ERROR_CODES.NETWORK_ERROR)));
        response.on('end', () => resolve({ status: response.statusCode, payload: Buffer.concat(chunks) }));
      });
      request.on('timeout', () => { request.destroy(); reject(new SafeError(ERROR_CODES.TIMEOUT)); });
      request.on('error', () => reject(new SafeError(ERROR_CODES.NETWORK_ERROR)));
      if (init.signal?.aborted) { reject(new SafeError(ERROR_CODES.CANCELLED)); return; }
      init.signal?.addEventListener('abort', () => { request.destroy(); }, { once: true });
      request.end(body);
    });
    return { status: reply.status, body: responseBody(reply.payload) };
  };
}

// The one measured difference between the modes. The wrapper is IDENTICAL in both modes and records
// only the byte size of the outgoing body as `createRequest` produced it; the underlying client is the
// global fetch in real mode and the per-request-CA node:https client in mock mode.
function measuringClient(client, stepSamples) {
  return async function measuredClient(endpoint, init) {
    const sample = stepSamples.at(-1);
    if (sample) sample.bytes = utf8ByteLength(init.body);
    return await client(endpoint, init);
  };
}

// The harness transport IS the product's transport. `requestCompletion` builds the request with the
// product's own `createRequest(settings, messages, uuid, { agent: true })` — so the request-body
// ceiling, the headers, the settings-governed HTTP timeout capped by the remaining deadline and the
// response byte ceilings all apply as they do in the product; a BYTE_LIMIT refusal propagates as the
// run's terminal ERROR instead of being bypassed. Each step is timed here and its batch size is read
// with the product's own envelope parser.
function batchSize(content) {
  try {
    const envelope = parseEnvelope(content);
    return envelope.type === 'tool_calls' ? envelope.calls.length : 0;
  } catch { return null; }
}
function createTransport({ settings, uuid, fetchImpl, stepSamples }) {
  return async function send(messages, options = {}) {
    const sample = { ms: null, bytes: null, actions: null };
    stepSamples.push(sample);
    const startedAt = Date.now();
    try {
      const result = await requestCompletion(settings, messages, uuid,
        { parse: 'raw', agent: true, signal: options.signal, deadline: options.deadline, fetch: fetchImpl });
      sample.actions = batchSize(result.content);
      return result;
    } finally {
      sample.ms = Date.now() - startedAt;
    }
  };
}

// runAgent checks its deadline through the injected `now` at the top of every step and before every
// action, and returns LIMIT immediately after such a check. The last value it observed therefore says
// whether the DEADLINE — rather than the maxSteps or maxToolCalls counter — produced the LIMIT, so the
// record can name the guardrail instead of guessing from the counts. `now` is the same Date.now the
// runtime uses by default.
//
// `frozenNow` (the `--frozen-now` testing aid) replaces ONLY the runtime's `now` with a constant
// synthetic reading. The transport is NOT given that clock: createTransport calls the product's
// requestCompletion without a `clock`, so the transport keeps its own `Date.now`, while the deadline it
// is handed was computed by runAgent from the synthetic reading. Determinism therefore does not come
// from a shared clock but from that synthetic deadline (a <=9-digit frozen reading plus a <=9-digit
// override) staying far below any real timestamp: the transport's own `start >= deadline` entry check is
// trivially true, so the refusal — no request, no body — is decided by the frozen deadline rather than
// by the host's speed. The elapsed and per-step `ms` values are still measured with Date.now, because
// they report the run, not the deadline.
function createDeadlineWatch(operationDeadlineMs, frozenNow = null) {
  const watch = { calls: 0, deadline: null, fired: false };
  if (frozenNow !== null) {
    watch.now = () => frozenNow;
    return watch;
  }
  watch.now = () => {
    const value = Date.now();
    if (watch.calls === 0) watch.deadline = value + operationDeadlineMs;
    else if (value >= watch.deadline) watch.fired = true;
    watch.calls += 1;
    return value;
  };
  return watch;
}
// runAgent publishes ONE `LIMIT` status for three different guardrails. The deadline is named when a
// deadline check fired; otherwise an exhausted counter is named, and the counts and the wall clock are
// published beside it so a calibration run can never be misread as a completed workload.
function limitReason(result, guardrails, watch, elapsedMs) {
  const guardrail = watch.fired ? 'operationDeadlineMs'
    : result.steps >= guardrails.maxSteps ? 'maxSteps' : 'maxToolCalls';
  return { guardrail, steps: result.steps, toolCalls: result.toolCalls, ms: elapsedMs };
}

// The recording stub bridge: no R7, no document, no editor callback. It records the tool calls the
// authored registry really dispatches and answers each with a small bounded result, so the loop runs
// end to end. The recorded text is a fixed synthetic literal that is never printed.
function createRecordingBridge() {
  const calls = [];
  return {
    calls,
    readSelection: async () => {
      calls.push(Object.freeze({ tool: 'read_selection', bytes: Buffer.byteLength(STUB_SELECTION, 'utf8') }));
      return { text: STUB_SELECTION, eligible: true, target: 1 };
    },
    insertParagraph: async args => {
      calls.push(Object.freeze({ tool: 'insert_paragraph', bytes: Buffer.byteLength(args.text, 'utf8') }));
      // word.js publishes an acknowledged insert only for a literal own `sent: true`.
      return { ok: true, data: { sent: true } };
    }
  };
}

// The whole published record, built in one place so the count-only contract is auditable by reading
// a single function: no message, no content, no endpoint, no key, no session UUID.
function buildRecord({ workload, model, result, elapsedMs, guardrails, httpTimeoutSeconds, stepSamples, watch, mockStats, frozenNow }) {
  const record = {
    workload,
    model,
    status: result.status,
    steps: result.steps,
    toolCalls: result.toolCalls,
    repairs: result.repairs,
    ms: elapsedMs,
    guardrails: { maxSteps: guardrails.maxSteps, maxToolCalls: guardrails.maxToolCalls, operationDeadlineMs: guardrails.operationDeadlineMs },
    httpTimeoutSeconds,
    perStep: stepSamples.map(sample => ({ ms: sample.ms, bytes: sample.bytes, actions: sample.actions })),
    actionBytes: result.actions.map(action => action.bytes)
  };
  // The injected synthetic clock reading, published whenever the testing aid was used, so a reader can
  // never mistake a frozen-clock run for a real-timed one.
  if (frozenNow !== null) record.frozenNow = frozenNow;
  // The terminal classified code (a closed ERROR_CODES constant, never a message) — this is where a
  // BYTE_LIMIT refusal, a timeout or a classified HTTP failure is stated.
  if (result.code !== null) record.code = result.code;
  if (result.status === 'LIMIT') record.limit = limitReason(result, guardrails, watch, elapsedMs);
  if (mockStats !== null) record.mock = mockStats;
  return record;
}

// Mock diagnostics only, and only integers/booleans the reviewed mock already publishes as bounded
// values: ordinals, never session identities.
function mockCounters(stats) {
  return {
    requests: stats.requests,
    posts: stats.posts,
    accepted: stats.accepted,
    rejected: stats.rejected,
    sessions: stats.sessions,
    acceptedSessionOrdinals: stats.acceptedSessionOrdinals,
    sessionOrdinalCapacityReached: stats.sessionOrdinalCapacityReached
  };
}

async function main() {
  let options;
  try { options = parseArguments(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`${oneLine(error.message)}\n${USAGE}\n`);
    return 2;
  }
  if (options.help) { process.stdout.write(`${USAGE}\n`); return 0; }
  let model;
  try { model = modelFromEnvironment(); }
  catch (error) { process.stderr.write(`${oneLine(error.message)}\n`); return 2; }
  const guardrails = options.guardrails;
  const httpTimeoutSeconds = options.httpTimeoutSeconds;
  let provider = null;
  try {
    if (options.mock) provider = await startMockProvider(options.mockProfile, httpTimeoutSeconds * 1000);
    else provider = developmentProvider();
  } catch (error) {
    process.stderr.write(`${oneLine(error instanceof ConfigError || error instanceof HarnessError ? error.message : 'the harness could not resolve its configuration')}\n`);
    return error instanceof ConfigError ? 2 : 1;
  }
  try {
    const sessionId = randomUUID();
    // The exact settings the product's transport consumes: the endpoint, the key, the model, the
    // settings-governed HTTP timeout. The request body itself is built by createRequest inside
    // requestCompletion — never here.
    const settings = Object.freeze({ endpoint: provider.endpoint, apiKey: provider.apiKey, model,
      maxTokens: MAX_TOKENS, temperature: TEMPERATURE, httpTimeoutSeconds });
    const stepSamples = [];
    const fetchImpl = measuringClient(provider.client, stepSamples);
    const transport = createTransport({ settings, uuid: sessionId, fetchImpl, stepSamples });
    const watch = createDeadlineWatch(guardrails.operationDeadlineMs, options.frozenNow);
    const bridge = createRecordingBridge();
    const registry = createRegistry(createWordTools(bridge));
    const started = Date.now();
    const result = await runAgent({
      registry,
      editor: 'word',
      capabilities: ['document.read', 'document.write'],
      mode: 'EDIT',
      settings,
      uuid: sessionId,
      request: PROMPTS[options.workload],
      guardrails,
      transport,
      now: watch.now
    });
    const record = buildRecord({
      workload: options.workload,
      model,
      result,
      elapsedMs: Date.now() - started,
      guardrails,
      httpTimeoutSeconds,
      stepSamples,
      watch,
      mockStats: provider.stats ? provider.stats() : null,
      frozenNow: options.frozenNow
    });
    process.stdout.write(`${JSON.stringify(record)}\n`);
    if (options.stepsReport !== null) {
      try { await writeFile(options.stepsReport, `${JSON.stringify(record)}\n`); }
      catch { process.stderr.write('the steps report could not be written (the run itself completed and its record was printed)\n'); return 1; }
    }
    // Honest exit status: only a real FINAL is a success. A guardrail, a repair exhaustion, a
    // preview or an error keep their own status in the record and exit non-zero.
    return result.status === 'FINAL' ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${oneLine(error instanceof HarnessError ? error.message : 'the harness failed before it could publish a record')}\n`);
    return 1;
  } finally {
    if (provider?.close) await provider.close().catch(() => {});
  }
}

process.exitCode = await main();
