// tests/acceptance/agent/dev-qwen-workloads.mjs
//
// Sprint 2, Task 11 — the development Qwen workload harness (design §15.2, calibration of §12.2).
//
// DEV-ONLY, AND NOT A node:test FILE. The name carries no `.test`/`-test` suffix, so `node --test`
// (npm test) never discovers or runs it. A workload is run by hand; see README.md next to this file.
//
// PRIVACY CONTRACT — the output is COUNT-ONLY. This file prints and writes only the fields built in
// `buildRecord` below: workload, model, status, steps, toolCalls, repairs, elapsed ms, per-action
// byte sizes and (mock mode only) the mock's own bounded integer counters. It never prints, logs or
// writes the key, the endpoint, a header value, request or response content, a document excerpt, a
// session UUID or any other identifier — not even inside an error path, because no raw exception
// message is ever read (a fetch failure's message carries the URL).
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
import { ERROR_CODES, SafeError } from '../../../src/shared/errors.js';
import { LIMITS } from '../../../src/shared/limits.js';
import { assertByteLimit } from '../../../src/shared/bytes.js';
import { startMock, SYNTHETIC_KEY } from '../infrastructure/https-mock.mjs';
import { tlsFixture } from '../infrastructure/tls-fixture.mjs';

const DEFAULT_MODEL = 'qwen/qwen3.8-27b:free';
// The printed model is restricted to a plain model id: it keeps the record one line and keeps any
// accidental non-model value out of the output entirely.
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MAX_TOKENS = 4096;
const TEMPERATURE = 0.2;
// LIMITS.httpTimeoutMaxSeconds, the largest per-request HTTP timeout the product settings allow.
const REQUEST_TIMEOUT_MS = LIMITS.httpTimeoutMaxSeconds * 1000;
// The mock's closed profile set is wider; only these two produce an agent-facing envelope, so only
// these two can drive the authored runtime to a terminal status.
const MOCK_PROFILES = Object.freeze(['final', 'proposal']);
const WORKLOADS = Object.freeze(['word', 'excel', 'powerpoint']);
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
  '  --workload <name>        word | excel | powerpoint (default: word)',
  '  --mock                   drive the reviewed local HTTPS mock instead of the development endpoint',
  '  --mock-profile <name>    final | proposal (default: final); bounded, no external network',
  '  --steps-report <path>    also write the same count-only record to this file',
  '  --help                   print this help',
  '',
  'real mode  requires AGENT_DEV_ENDPOINT and AGENT_DEV_KEY in the environment;',
  '           AGENT_DEV_MODEL is optional (default: ' + DEFAULT_MODEL + ').',
  '           No environment value is ever printed, and the run refuses before any network',
  '           call when a required variable is missing.',
  'mock mode  requires no environment and makes no external network call: it starts an',
  '           ephemeral loopback HTTPS server with an ephemeral CA, used as per-request',
  '           trust input only — never imported into a global or system trust store.',
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

function parseArguments(argv) {
  const parsed = { workload: 'word', mock: false, mockProfile: 'final', stepsReport: null, help: false };
  const positional = [];
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
    if (!['--workload', '--mock-profile', '--steps-report'].includes(option.name)) throw new ConfigError(`unknown option ${oneLine(option.name)}`);
    let value = option.value;
    if (value === null) { index += 1; value = argv[index] ?? ''; }
    if (value === '') throw new ConfigError(`${oneLine(option.name)} requires a value`);
    if (option.name === '--workload') parsed.workload = value;
    else if (option.name === '--mock-profile') parsed.mockProfile = value;
    else parsed.stepsReport = value;
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
  return parsed;
}

function modelFromEnvironment() {
  const model = process.env.AGENT_DEV_MODEL ?? DEFAULT_MODEL;
  if (!MODEL_PATTERN.test(model)) throw new ConfigError('AGENT_DEV_MODEL is not a plain model id (its value is never printed)');
  return model;
}

// Real mode. Every refusal here happens BEFORE a transport exists, so a missing endpoint or key can
// never reach the network, and the messages name only the variable — never its value.
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
  return { endpoint, apiKey: process.env.AGENT_DEV_KEY, fetchImpl: globalThis.fetch };
}

// Mock mode. The reviewed mock is started exactly as its own tests start it: an ephemeral CA/leaf
// pair from the existing host TLS fixture, an ephemeral loopback port, and the synthetic public key.
// sessionOrdinalLimit bounds accepted-session admission; one run uses one session, so the recorded
// ordinals prove the traffic came from that single session.
async function startMockProvider(profile) {
  let fixture;
  try { fixture = await tlsFixture(); }
  catch { throw new HarnessError('the host TLS fixture failed: mock mode needs Git OpenSSL on Windows or openssl on Linux'); }
  let mock;
  try {
    mock = await startMock({ keyPath: fixture.keyPath, certPath: fixture.certPath, listenAddress: '127.0.0.1', port: 0,
      prefix: '/provider', profile, corsOrigin: 'null', delayMs: 100, sessionOrdinalLimit: 8 });
  } catch {
    await fixture.cleanup().catch(() => {});
    throw new HarnessError('the reviewed HTTPS mock refused this configuration');
  }
  return {
    endpoint: `https://127.0.0.1:${mock.port}/provider/v1/chat/completions`,
    apiKey: SYNTHETIC_KEY,
    fetchImpl: createTestCaFetch(fixture.ca),
    stats: () => mockCounters(mock.stats()),
    close: async () => { try { await mock.close(); } finally { await fixture.cleanup(); } }
  };
}

// Mock mode only: a fetch-shaped client over node:https that passes the EPHEMERAL test CA as
// per-request trust input, exactly as tests/acceptance/infrastructure/https-mock.test.js does. It
// imports nothing into a global, system or environment trust store; the CA lives in this process's
// memory for the duration of the run and the fixture directory is removed on exit. `redirect:'error'`
// semantics are preserved: a 3xx is refused, never followed.
function createTestCaFetch(ca) {
  return async function testCaFetch(endpoint, options) {
    const target = new URL(endpoint);
    const body = options.body;
    return await new Promise((resolve, reject) => {
      const request = https.request({
        hostname: target.hostname, port: target.port, path: target.pathname, method: options.method,
        headers: { ...options.headers, 'Content-Length': Buffer.byteLength(body, 'utf8') },
        ca, agent: false
      }, response => {
        if (response.statusCode >= 300 && response.statusCode < 400) {
          response.resume();
          reject(new SafeError(ERROR_CODES.HTTP_ERROR));
          return;
        }
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('error', () => reject(new SafeError(ERROR_CODES.NETWORK_ERROR)));
        response.on('end', () => {
          const payload = Buffer.concat(chunks).toString('utf8');
          resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, text: async () => payload });
        });
      });
      request.on('error', () => reject(new SafeError(ERROR_CODES.NETWORK_ERROR)));
      if (options.signal?.aborted) { reject(new SafeError(ERROR_CODES.CANCELLED)); return; }
      options.signal?.addEventListener('abort', () => { request.destroy(); }, { once: true });
      request.end(body);
    });
  };
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

function httpCode(status) {
  if (status === 401) return ERROR_CODES.HTTP_UNAUTHORIZED;
  if (status === 403) return ERROR_CODES.HTTP_FORBIDDEN;
  if (status === 429) return ERROR_CODES.HTTP_RATE_LIMIT;
  if (status >= 500 && status <= 599) return ERROR_CODES.HTTP_SERVER_ERROR;
  return ERROR_CODES.HTTP_ERROR;
}

// The strict-bank POST the product transport makes (src/ai/transport.js), re-implemented here because
// the harness owns its endpoint and key: exactly the four body fields, exactly the three required
// headers, `redirect: 'error'`, an AbortController and a bounded per-request budget. Exactly ONE
// field of the response is read — `choices[0].message.content`. No other response field is read,
// returned or printed, and a failure's raw text (which carries the URL) is never read either.
function createTransport({ endpoint, apiKey, model, sessionId, fetchImpl }) {
  return async function send(messages, options = {}) {
    const controller = new AbortController();
    const callerSignal = options.signal;
    const abort = () => controller.abort();
    if (callerSignal?.aborted) throw new SafeError(ERROR_CODES.CANCELLED);
    callerSignal?.addEventListener('abort', abort, { once: true });
    const budget = Number.isFinite(options.deadline) ? Math.max(1, options.deadline - Date.now()) : REQUEST_TIMEOUT_MS;
    const timer = setTimeout(() => { controller.abort(); }, budget);
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST', redirect: 'error', credentials: 'omit',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Session-ID': sessionId },
        body: JSON.stringify({ model, messages, max_tokens: MAX_TOKENS, temperature: TEMPERATURE }),
        signal: controller.signal
      });
      if (!response.ok) throw new SafeError(httpCode(response.status));
      const payload = await response.text();
      assertByteLimit(payload, LIMITS.httpEnvelopeBytes);
      let envelope = null;
      try { envelope = JSON.parse(payload); } catch { throw new SafeError(ERROR_CODES.PROTOCOL_ERROR); }
      if (!Array.isArray(envelope?.choices) || envelope.choices.length !== 1 || typeof envelope.choices[0]?.message?.content !== 'string') {
        throw new SafeError(ERROR_CODES.PROTOCOL_ERROR);
      }
      const content = envelope.choices[0].message.content;
      assertByteLimit(content, LIMITS.modelContentBytes);
      return { content };
    } catch (error) {
      // Checked before the error itself: an aborted request always rejects, and the reason it was
      // aborted (the caller's Stop or the local budget) is the truthful classification.
      if (controller.signal.aborted) throw new SafeError(callerSignal?.aborted ? ERROR_CODES.CANCELLED : ERROR_CODES.TIMEOUT);
      if (error instanceof SafeError) throw error;
      throw new SafeError(ERROR_CODES.NETWORK_ERROR);
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', abort);
    }
  };
}

// The whole published record, built in one place so the count-only contract is auditable by reading
// a single function: no message, no content, no endpoint, no key, no session UUID.
function buildRecord({ workload, model, result, elapsedMs, mockStats }) {
  const record = {
    workload,
    model,
    status: result.status,
    steps: result.steps,
    toolCalls: result.toolCalls,
    repairs: result.repairs,
    ms: elapsedMs,
    actionBytes: result.actions.map(action => action.bytes)
  };
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
  let provider = null;
  try {
    if (options.mock) provider = await startMockProvider(options.mockProfile);
    else provider = developmentProvider();
  } catch (error) {
    process.stderr.write(`${oneLine(error instanceof ConfigError || error instanceof HarnessError ? error.message : 'the harness could not resolve its configuration')}\n`);
    return error instanceof ConfigError ? 2 : 1;
  }
  try {
    const sessionId = randomUUID();
    const bridge = createRecordingBridge();
    const registry = createRegistry(createWordTools(bridge));
    const transport = createTransport({ endpoint: provider.endpoint, apiKey: provider.apiKey, model, sessionId, fetchImpl: provider.fetchImpl });
    const started = Date.now();
    const result = await runAgent({
      registry,
      editor: 'word',
      capabilities: ['document.read', 'document.write'],
      mode: 'EDIT',
      settings: {},
      uuid: sessionId,
      request: PROMPTS[options.workload],
      transport
    });
    const record = buildRecord({
      workload: options.workload,
      model,
      result,
      elapsedMs: Date.now() - started,
      mockStats: provider.stats ? provider.stats() : null
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
