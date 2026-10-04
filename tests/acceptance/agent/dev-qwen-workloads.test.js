// tests/acceptance/agent/dev-qwen-workloads.test.js
//
// Final review, R4 — the calibration instrument had NO automated coverage: `dev-qwen-workloads.mjs`
// carries no `.test` suffix, so `node --test` never discovered it and every claim the Task 11 status
// document quotes about its mock mode was only re-verifiable by hand.
//
// This test drives the harness EXACTLY as its README says to run it — a child process, the real CLI
// arguments, the real exit code — so the instrument stays standalone-runnable and this file only
// observes it. It makes NO external network call: the profiled runs start the harness's own reviewed
// in-process loopback HTTPS mock on an ephemeral 127.0.0.1 port (`--mock`, the harness's documented
// offline mode), and the two no-run cases refuse before a transport exists.
//
// It is deliberately FAST and non-flaky: only immediate-answer mock profiles are used (the stalling
// `timeout` profile and the multi-second `--http-timeout-seconds 5` case are NOT run here, because
// they are wall-clock waits, not behavioural coverage), and every assertion is on a deterministic
// status/exit code, never on a duration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HARNESS = fileURLToPath(new URL('./dev-qwen-workloads.mjs', import.meta.url));
// npm test runs on Windows and on POSIX, so the executable is always this exact Node binary — never a
// shell, never a PATH lookup of a `node` that may be a different major than the suite's.
const NODE = process.execPath;
const EXTERNAL_VARIABLES = ['AGENT_DEV_ENDPOINT', 'AGENT_DEV_KEY', 'AGENT_DEV_MODEL'];

// One child run of the instrument. `env` defaults to this process's environment so the suite's own
// Node configuration still applies; only the two no-run cases below replace it, and they replace it
// precisely to prove the harness refuses WITHOUT the real-development variables.
function runHarness(args, options = {}) {
  const result = spawnSync(NODE, [HARNESS, ...args], {
    cwd: fileURLToPath(new URL('../../..', import.meta.url)),
    encoding: 'utf8',
    env: options.env ?? process.env,
    timeout: options.timeoutMs ?? 30000,
    windowsHide: true
  });
  assert.equal(result.error, undefined, `the child process could not be started: ${result.error?.message}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
// The printed record is the ONLY machine-readable output of the harness, so it must parse as exactly
// one JSON object on stdout, with nothing else.
function recordOf(run) {
  const lines = run.stdout.split('\n').filter(line => line !== '');
  assert.equal(lines.length, 1, `the harness prints exactly one record line (got ${lines.length})`);
  const record = JSON.parse(lines[0]);
  // Count-only shape: the published fields are the closed set below. A message, a prompt, a request or
  // response body, a document excerpt or an identifier would have to appear as a NEW key here.
  const allowed = ['workload', 'model', 'status', 'steps', 'toolCalls', 'repairs', 'ms', 'guardrails',
    'httpTimeoutSeconds', 'perStep', 'actionBytes', 'mock', 'code', 'limit'];
  for (const key of Object.keys(record)) {
    assert.ok(allowed.includes(key), `unexpected record field "${key}"`);
  }
  for (const key of ['workload', 'model', 'status', 'steps', 'toolCalls', 'repairs', 'ms', 'httpTimeoutSeconds']) {
    assert.ok(Object.hasOwn(record, key), `the record always carries "${key}"`);
  }
  assert.equal(typeof record.status, 'string');
  assert.ok(Number.isSafeInteger(record.steps) && record.steps >= 0);
  assert.ok(Number.isSafeInteger(record.toolCalls) && record.toolCalls >= 0);
  assert.ok(Number.isSafeInteger(record.repairs) && record.repairs >= 0);
  assert.ok(Array.isArray(record.perStep));
  assert.ok(Array.isArray(record.actionBytes) && record.actionBytes.every(Number.isSafeInteger));
  assert.deepEqual(Object.keys(record.guardrails).sort(),
    ['maxSteps', 'maxToolCalls', 'operationDeadlineMs']);
  // Every mock run is served by the harness's own reviewed loopback mock.
  assert.equal(typeof record.mock, 'object');
  assert.equal(record.mock.accepted, record.mock.requests, 'every POST is accepted by the reviewed mock');
  // A run can legitimately make zero requests (the 1 ms deadline case below fires before the body is
  // built); when it does make one, that request belongs to exactly one session.
  if (record.mock.requests > 0) assert.equal(record.mock.sessions, 1, 'one session per run');
  return record;
}
// The four real-development variables are the only environment input the harness reads; a no-run case
// proves its refusal names the variable and that no transport existed, so a leak of any of these
// values (or of a newline-carrying value) would show up here.
function withoutExternalVariables() {
  const env = { ...process.env };
  for (const name of EXTERNAL_VARIABLES) delete env[name];
  return env;
}

test('mock final profile: the harness reaches FINAL and exits 0', () => {
  const run = runHarness(['word', '--mock']);
  assert.equal(run.status, 0, `exit code (stderr: ${run.stderr})`);
  const record = recordOf(run);
  assert.equal(record.workload, 'word');
  assert.equal(record.status, 'FINAL');
  assert.equal(record.steps, 1, 'the mock answers a final envelope on the first step');
  assert.equal(record.toolCalls, 0, 'a final envelope dispatches no tool');
  assert.equal(record.repairs, 0);
  assert.equal(record.mock.requests, 1);
  assert.equal(record.perStep.length, 1);
  assert.equal(record.perStep[0].actions, 0, 'a final envelope carries zero actions');
});

test('mock proposal profile: one protocol repair ends PROTOCOL_ERROR, never a smoothed success', () => {
  const run = runHarness(['word', '--mock', '--mock-profile', 'proposal']);
  assert.equal(run.status, 1, `a non-FINAL run exits 1 (stderr: ${run.stderr})`);
  const record = recordOf(run);
  assert.equal(record.status, 'PROTOCOL_ERROR');
  assert.equal(record.steps, 2, 'the refused envelope burns the step, the repair is the second');
  assert.equal(record.repairs, 1, 'exactly the single authored repair');
  assert.equal(record.toolCalls, 0);
  assert.equal(record.mock.accepted, 2);
  for (const step of record.perStep) assert.equal(step.actions, null, 'no valid agent envelope was observed');
});

test('mock proposal profile with --max-steps 1: LIMIT attributes the exhausted maxSteps guardrail', () => {
  const run = runHarness(['word', '--mock', '--mock-profile', 'proposal', '--max-steps', '1']);
  assert.equal(run.status, 1, `a LIMIT run exits 1 (stderr: ${run.stderr})`);
  const record = recordOf(run);
  assert.equal(record.status, 'LIMIT');
  assert.equal(record.limit.guardrail, 'maxSteps');
  assert.equal(record.limit.steps, 1);
  assert.equal(record.limit.toolCalls, 0);
  // The effective guardrail is the override, and it is recorded with the run that used it.
  assert.equal(record.guardrails.maxSteps, 1);
  assert.equal(record.steps, 1);
  assert.equal(record.repairs, 1, 'the refused envelope still burned its repair before the limit');
});

test('mock oversize profile: a byte-ceiling refusal is a reported terminal ERROR, not a bypass', () => {
  const run = runHarness(['word', '--mock', '--mock-profile', 'oversize']);
  assert.equal(run.status, 1, `a classified ERROR exits 1 (stderr: ${run.stderr})`);
  const record = recordOf(run);
  assert.equal(record.status, 'ERROR');
  assert.equal(record.code, 'BYTE_LIMIT');
  assert.equal(record.mock.accepted, 1, 'the mock accepted the body; the RESPONSE was refused');
  assert.equal(Object.hasOwn(record, 'limit'), false, 'an ERROR is not a LIMIT');
});

test('an invalid guardrail override exits 2 with no run at all', () => {
  for (const args of [['word', '--mock', '--max-steps', '0'], ['word', '--mock', '--max-tool-calls', '0'],
    ['word', '--mock', '--deadline-ms', '-1'], ['word', '--mock', '--max-steps', '12abc']]) {
    const run = runHarness(args);
    assert.equal(run.status, 2, `${args.join(' ')} must be refused at argument-parse time`);
    assert.equal(run.stdout, '', 'a refused invocation prints no record');
    assert.match(run.stderr, /the guardrail overrides are invalid/);
  }
});

test('a missing real-development environment exits 2 before any transport exists', () => {
  const run = runHarness(['word'], { env: withoutExternalVariables() });
  assert.equal(run.status, 2);
  assert.equal(run.stdout, '', 'no record is printed when the configuration is refused');
  assert.match(run.stderr, /AGENT_DEV_ENDPOINT and AGENT_DEV_KEY are required for the real development run/);
  assert.match(run.stderr, /values are never printed/);
  // The refusal happens BEFORE a provider (and therefore a transport) is built, so no request could
  // have been attempted; the harness's own end-to-end mock runs in the tests above prove it can run.
});

test('a 1 ms operation deadline refuses before a request body is even built', () => {
  const run = runHarness(['word', '--mock', '--deadline-ms', '1']);
  assert.equal(run.status, 1);
  const record = recordOf(run);
  assert.equal(record.status, 'ERROR');
  assert.equal(record.code, 'TIMEOUT');
  assert.equal(record.mock.requests, 0, 'the mock saw zero requests: the product deadline fired first');
  assert.equal(record.perStep.length, 1);
  assert.equal(record.perStep[0].bytes, null, 'no request body was produced');
});
