# Development Qwen workload harness (Task 11) — dev-only

`dev-qwen-workloads.mjs` drives the **real** Sprint 2 runtime — `runAgent`, the tool registry from
`createWordTools`, and a recording stub bridge (no R7, no document, no editor callback) — through the
three §15.2 pilot workloads, in order to calibrate the §12.2 guardrails (`maxSteps`, `maxToolCalls`,
operation deadline).

It is **dev-only** and it is **not part of `node --test`**: the file has no `.test`/`-test` suffix, so
`npm test` (`node --test`) never discovers or runs it. Run it by hand.

It is a **side-effecting module**: importing it runs `main()` once with the importing process's
arguments and sets `process.exitCode`. A non-mock import in a process whose environment lacks
`AGENT_DEV_ENDPOINT`/`AGENT_DEV_KEY` therefore exits `2` at import time (no network call). Do not import
it for its helpers; run it as a command.

```
node tests/acceptance/agent/dev-qwen-workloads.mjs --help
```

## What the harness does *not* re-implement

The outgoing request is produced by the product's own code, not by the harness:

- The body is built by `createRequest(settings, messages, uuid, { agent: true })`
  (`src/ai/protocol.js`), so the **98304-byte request-body ceiling**, the `snapshotAgentMessages`
  conversation shape, the exact four body fields and the three headers are the product's. A body the
  product refuses is the run's terminal `ERROR` with `code: "BYTE_LIMIT"` — it is never bypassed.
- The POST, the abort handling and the response ceilings are the product's own
  `requestCompletion` (`src/ai/transport.js`), so the per-request HTTP timeout is
  `min(settings.httpTimeoutSeconds × 1000, remaining operation deadline, 150 s)` — the transport's own
  arithmetic, not a harness approximation.
- **The only difference between mock and real mode is the HTTP/TLS client** handed to the transport:
  the global `fetch` in real mode, a per-request-CA `node:https` client for the loopback mock. The
  measurement wrapper around that client is identical in both modes.

## Guardrail overrides (calibration, §12.2)

`maxSteps`, `maxToolCalls` and `operationDeadlineMs` are varyable from the command line, so raising
them never needs a runtime (or harness-script) change. Every override is validated by the product's own
`createGuardrails`, so an impossible value fails closed the same way the product's would — at
argument-parse time, exit `2`, before any transport exists.

| Option | Guardrail | Default |
| --- | --- | --- |
| `--max-steps <n>` | `maxSteps` | `12` |
| `--max-tool-calls <n>` | `maxToolCalls` | `32` |
| `--deadline-ms <n>` | `operationDeadlineMs` | `150000` |
| `--http-timeout-seconds <n>` | `settings.httpTimeoutSeconds` (5–120) | `30` |

The **effective** values are recorded in every run (`guardrails`, `httpTimeoutSeconds`), so a record
always states the limits it ran under.

## `--frozen-now <ms>` — testing aid (mock mode only)

`--frozen-now` injects a **constant synthetic clock** into the runtime's own `now` for the run's
deadline arithmetic; the harness's transport is not given that clock, so the transport keeps `Date.now`.
It is an offline testing aid, not a calibration option: it is refused without `--mock`
(exit `2`, before any transport exists), must be a positive integer of at most 9 digits, and is not a
real timestamp. When it is used, the injected reading is published in the record as `frozenNow`, so a
reader can never mistake a frozen-clock run for a real-timed one; `ms` and `perStep[].ms` are still
measured with the host clock, because they report the run and not the deadline.

Why it exists: the `--deadline-ms 1` case is the one refusal a wall clock cannot reproduce reliably.
Two independent checks can fire it — the runtime's own pre-step check (which returns `LIMIT` and sends
nothing) and the transport's check at entry (which returns `ERROR`/`code: "TIMEOUT"` before the body is
built). Which one wins depends only on how many milliseconds the host spent between those two reads, so
on a slower run the same command legitimately reports `LIMIT` instead. `--frozen-now` removes the race
without sharing a clock: the runtime computes its deadline from the synthetic reading (so its own
`frozenNow >= frozenNow + 1` pre-step check is false on every host), and the transport still reads the
real `Date.now`, which is far larger than that synthetic deadline — so the transport's own
`start >= deadline` entry check is trivially true and the refusal is deterministic:

```powershell
node tests/acceptance/agent/dev-qwen-workloads.mjs word --mock --deadline-ms 1 --frozen-now 1000000
# → {"status":"ERROR","code":"TIMEOUT","frozenNow":1000000,...,"mock":{"requests":0,...}}
```

`tests/acceptance/agent/dev-qwen-workloads.test.js` uses exactly this form, so the
"refuses before a request body is even built" property is asserted on the refusal itself rather than on
how long the process took.

## Real mode (development endpoint — controller-owned step)

```powershell
$env:AGENT_DEV_ENDPOINT='https://openrouter.ai/api/v1/chat/completions'   # full https chat-completions URL
$env:AGENT_DEV_MODEL='qwen/qwen3.8-27b:free'                              # optional, this is the default
$env:AGENT_DEV_KEY='<development key from the local plugin settings>'     # never printed, never committed
node tests/acceptance/agent/dev-qwen-workloads.mjs word
```

| Variable | Contract |
| --- | --- |
| `AGENT_DEV_ENDPOINT` | Required for real mode. An absolute **https** URL of the chat-completions endpoint. |
| `AGENT_DEV_KEY` | Required for real mode. The development key. Used only as the `Authorization: Bearer` header value. |
| `AGENT_DEV_MODEL` | Optional. Default `qwen/qwen3.8-27b:free`. Must be a plain model id. |

Configuration comes **only** from the environment. If `AGENT_DEV_ENDPOINT` or `AGENT_DEV_KEY` is
missing, or the endpoint is not an absolute https URL, or the model is not a plain model id, the
harness prints **one line naming the variable** and exits `2` **before any transport exists**, so no
network call is possible. No environment value — the key, the endpoint, the model text — is ever
printed, logged or written, including on every failure path (a raw fetch error is never read, because
its message carries the URL).

`AGENT_DEV_MODEL` must match a plain model id: at most one `/`, no scheme separator, no whitespace and
at most 128 bytes. The model is only ever placed in the **request body** and in the printed record — it
never selects a host (the endpoint is validated separately, in both modes) — but a URL-shaped value is
refused anyway, so a mis-set variable can never be mistaken for an endpoint in a record.

## Mock mode (offline proof of the harness — no external network)

```powershell
node tests/acceptance/agent/dev-qwen-workloads.mjs word --mock
node tests/acceptance/agent/dev-qwen-workloads.mjs excel --mock
node tests/acceptance/agent/dev-qwen-workloads.mjs powerpoint --mock
node tests/acceptance/agent/dev-qwen-workloads.mjs word --mock --mock-profile proposal
node tests/acceptance/agent/dev-qwen-workloads.mjs word --mock --mock-profile proposal --max-steps 1
node tests/acceptance/agent/dev-qwen-workloads.mjs word --mock --mock-profile oversize
node tests/acceptance/agent/dev-qwen-workloads.mjs word --mock --mock-profile timeout --http-timeout-seconds 5
```

`--mock` requires no environment variable and makes **no external network call**. It starts the
reviewed local HTTPS mock (`../infrastructure/https-mock.mjs`) exactly as that mock's own tests start
it: an ephemeral CA/leaf pair from `../infrastructure/tls-fixture.mjs`, an ephemeral loopback port,
`prefix '/provider'`, `corsOrigin 'null'`, `delayMs 100`, and the deliberately public synthetic key
`PUBLIC-SYNTHETIC-TEST-ONLY`. The product transport then issues its own POST at the mock's endpoint.
The ephemeral CA is supplied as **per-request trust input**, exactly as `https-mock.test.js` does:
nothing is imported into a global, system or environment trust store, and the fixture directory is
removed on exit. A 3xx is refused without reading `Location`.

`--mock-profile` selects the mock's response profile (default `final`):

| Profile | Behaviour |
| --- | --- |
| `final` | The mock answers a closed JSON `final` envelope: the run reaches `FINAL`, exit `0`. |
| `proposal` | The mock answers the chat-shape proposal envelope, which the agent protocol refuses: the run burns its single repair and ends `PROTOCOL_ERROR` with `repairs: 1` over two accepted requests, exit `1`. This intentionally non-final run is the deterministic check of the multi-step and repair accounting through a real HTTPS loop; it is reported as it happened, never smoothed into a success. |
| `timeout` | The mock accepts the request and stalls past the per-request budget (its delay is derived from `--http-timeout-seconds`). The run ends `ERROR` with `code: "TIMEOUT"` after exactly the settings-governed budget, exit `1`. This is the deterministic check that a stalled endpoint is bounded per request. Use a small `--http-timeout-seconds` (5) — the run really waits that long. |
| `oversize` | The mock answers a response larger than the transport's envelope ceiling: the run ends `ERROR` with `code: "BYTE_LIMIT"`, exit `1` — a byte ceiling is a reported terminal outcome, never bypassed. |

**The three workloads are identical in mock mode.** The mock can only answer one fixed envelope, so
`word`, `excel` and `powerpoint` all produce exactly one model step, zero tool calls and the same
terminal status (`FINAL`), and exit `0`; only the request-body size differs between them, because the
prompt text differs. The `proposal` profile is the only mock profile that shows multi-step behaviour
(two model steps, one repair, `PROTOCOL_ERROR`), and `--max-steps 1` on top of it is the deterministic
`LIMIT`/`maxSteps` run. Mock mode proves the harness, the transport, the registry wiring and the
runtime loop. It does **not** calibrate the guardrails: calibration data can only come from the real
run.

The mock's own bounded integer counters are included under `mock` (`requests`, `posts`, `accepted`,
`rejected`, `sessions`, plus the bounded session **ordinals** — never session identities).

## What is measured (the whole output)

One line of JSON per run, built in a single `buildRecord` function:

```json
{"workload":"word","model":"qwen/qwen3.8-27b:free","status":"FINAL","steps":1,"toolCalls":0,"repairs":0,"ms":24,"guardrails":{"maxSteps":12,"maxToolCalls":32,"operationDeadlineMs":150000},"httpTimeoutSeconds":30,"perStep":[{"ms":23,"bytes":1036,"actions":0}],"actionBytes":[],"mock":{"requests":1,"posts":1,"accepted":1,"rejected":0,"sessions":1,"acceptedSessionOrdinals":[1],"sessionOrdinalCapacityReached":false}}
```

| Field | Meaning |
| --- | --- |
| `workload` | `word`, `excel` or `powerpoint` |
| `model` | the configured model id |
| `status` | the run's terminal status, exactly as `runAgent` reported it: `FINAL`, `LIMIT`, `ERROR`, `PROTOCOL_ERROR`, `PREVIEW_READY`, `CANCELLED`, `UNCERTAIN` |
| `steps` | model round-trips used |
| `toolCalls` | executed actions |
| `repairs` | protocol repairs used (at most one) |
| `ms` | wall-clock milliseconds of the whole `runAgent` call |
| `guardrails` | the effective `maxSteps`, `maxToolCalls` and `operationDeadlineMs` this run used |
| `httpTimeoutSeconds` | the settings-governed per-request HTTP timeout the transport read |
| `perStep` | one entry per model round-trip, in order: `ms` (the duration of that round-trip), `bytes` (the size of the request body `createRequest` produced, `null` when no body was sent) and `actions` (how many actions that step's envelope carried — `0` for a `final`, `null` when no valid envelope was observed) |
| `actionBytes` | the runtime's per-action result byte sizes, in dispatch order |
| `code` | present only when the run ended with a classified code (a closed `ERROR_CODES` constant, e.g. `TIMEOUT`, `BYTE_LIMIT`) |
| `limit` | present only when `status` is `LIMIT`: `{guardrail, steps, toolCalls, ms}` naming **which** guardrail was reached (`maxSteps`, `maxToolCalls` or `operationDeadlineMs`) |
| `mock` | mock mode only: the mock's bounded integer counters |
| `frozenNow` | present only when `--frozen-now` was used: the injected synthetic clock reading, so a frozen-clock run is never mistaken for a real-timed one |

`--steps-report <path>` writes the same count-only record to a file (useful for collecting the three
records of a calibration run). Choose a path outside Git or an ignored temporary location.

Exit codes: `0` the run reached `FINAL`; `1` the run reached any other status, or the harness itself
failed; `2` the arguments (including an invalid guardrail or HTTP-timeout override) or the real-mode
configuration were refused before any network call.

## Reading a `LIMIT` record

A `LIMIT` is never a completed workload, and the record says which guardrail produced it and with which
counts. Attribution: if a deadline check fired (the runtime observes its own clock through the injected
`now` — the host `Date.now` unless `--frozen-now` overrides it), the guardrail is `operationDeadlineMs`;
otherwise the exhausted counter is named (`maxSteps` when the step budget is spent, `maxToolCalls` when
the tool-call budget is). `ms` and `guardrails.operationDeadlineMs` are both in the record, so a reader
can see when more than one limit was in play.

Note that a *stalled request* is not a `LIMIT`: the transport's own deadline aborts it first and the run
ends `ERROR` with `code: "TIMEOUT"`. `limit.guardrail: "operationDeadlineMs"` means the runtime's loop
reached its deadline between model steps or between the actions of a batch.

## What is never recorded

No key, endpoint, header value, request or response content, document excerpt, session UUID or other
identifier is printed, logged or written — not in the record, not in the steps report, and not in any
error path. The stub bridge's recorded text is a fixed synthetic literal that never reaches the
output. Every measurement added to the record is an integer or a closed constant.

## Honesty rules

The harness reports what happened. A guardrail reached (`LIMIT`, with its own `limit` block), an
exhausted repair (`PROTOCOL_ERROR`), a `confirm` action awaiting preview (`PREVIEW_READY`), an uncertain
mutation (`UNCERTAIN`) and a classified error (`ERROR`, with its closed `code`) are all printed with
their own status and exit non-zero. Nothing is truncated or reshaped to fit the initial §12.2 numbers:
real work that exceeds them is a calibration finding.

## Scope of the three workloads

All three workloads are sent through the Sprint 2 Word catalogue (`createWordTools`), because that is
the only catalogue this sprint ships; the Excel and PowerPoint prompts calibrate the **engine**
(steps, tool calls, batch sizes, JSON discipline, guardrails), not the Excel/PowerPoint tools, which
arrive in Sprint 3+.
