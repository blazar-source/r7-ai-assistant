# Development Qwen workload harness (Task 11) — dev-only

`dev-qwen-workloads.mjs` drives the **real** Sprint 2 runtime — `runAgent`, the tool registry from
`createWordTools`, and a recording stub bridge (no R7, no document, no editor callback) — through the
three §15.2 pilot workloads, in order to calibrate the §12.2 guardrails (`maxSteps`, `maxToolCalls`,
operation deadline).

It is **dev-only** and it is **not part of `node --test`**: the file has no `.test`/`-test` suffix, so
`npm test` (`node --test`) never discovers or runs it. Run it by hand.

```
node tests/acceptance/agent/dev-qwen-workloads.mjs --help
```

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

## Mock mode (offline proof of the harness — no external network)

```powershell
node tests/acceptance/agent/dev-qwen-workloads.mjs word --mock
node tests/acceptance/agent/dev-qwen-workloads.mjs excel --mock
node tests/acceptance/agent/dev-qwen-workloads.mjs powerpoint --mock
node tests/acceptance/agent/dev-qwen-workloads.mjs word --mock --mock-profile proposal
```

`--mock` requires no environment variable and makes **no external network call**. It starts the
reviewed local HTTPS mock (`../infrastructure/https-mock.mjs`) exactly as that mock's own tests start
it: an ephemeral CA/leaf pair from `../infrastructure/tls-fixture.mjs`, an ephemeral loopback port,
`prefix '/provider'`, `corsOrigin 'null'`, `delayMs 100`, and the deliberately public synthetic key
`PUBLIC-SYNTHETIC-TEST-ONLY`. The same transport code then issues the identical strict-bank POST
(`model`, `messages`, `max_tokens`, `temperature`; `Authorization`, `Content-Type`, `X-Session-ID`;
`redirect: 'error'`; `AbortController`) at the mock's endpoint. The ephemeral CA is supplied as
**per-request trust input**, exactly as `https-mock.test.js` does: nothing is imported into a global,
system or environment trust store, and the fixture directory is removed on exit.

`--mock-profile` selects the mock's response profile (default `final`):

- `final` — the mock answers a closed JSON `final` envelope: the run reaches `FINAL`, exit `0`.
- `proposal` — the mock answers the chat-shape proposal envelope, which the agent protocol refuses:
  the run burns its single repair and ends `PROTOCOL_ERROR` with `repairs: 1` and two accepted
  requests, exit `1`. This intentionally non-final run is the deterministic check of the multi-step
  and repair accounting through a real HTTPS loop; it is reported as it happened, never smoothed into
  a success.

Mock mode proves the harness, the transport, the registry wiring and the runtime loop. It does **not**
calibrate the guardrails: the reviewed mock always answers a fixed envelope, so a mock run is one
model step (`steps: 1`, `toolCalls: 0`) and calibration data can only come from the real run.

The mock's own bounded integer counters are included under `mock` (`requests`, `posts`, `accepted`,
`rejected`, `sessions`, plus the bounded session **ordinals** — never session identities).

## What is measured (the whole output)

One line of JSON per run, built in a single `buildRecord` function:

```json
{"workload":"word","model":"qwen/qwen3.8-27b:free","status":"FINAL","steps":1,"toolCalls":0,"repairs":0,"ms":24,"actionBytes":[],"mock":{"requests":1,"posts":1,"accepted":1,"rejected":0,"sessions":1,"acceptedSessionOrdinals":[1],"sessionOrdinalCapacityReached":false}}
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
| `actionBytes` | the runtime's per-action result byte sizes, in dispatch order |
| `mock` | mock mode only: the mock's bounded integer counters |

`--steps-report <path>` writes the same count-only record to a file (useful for collecting the three
records of a calibration run). Choose a path outside Git or an ignored temporary location.

Exit codes: `0` the run reached `FINAL`; `1` the run reached any other status, or the harness itself
failed; `2` the arguments or the real-mode configuration were refused before any network call.

## What is never recorded

No key, endpoint, header value, request or response content, document excerpt, session UUID or other
identifier is printed, logged or written — not in the record, not in the steps report, and not in any
error path. The stub bridge's recorded text is a fixed synthetic literal that never reaches the
output.

## Honesty rules

The harness reports what happened. A guardrail reached (`LIMIT`), an exhausted repair
(`PROTOCOL_ERROR`), a `confirm` action awaiting preview (`PREVIEW_READY`), an uncertain mutation
(`UNCERTAIN`) and a classified error (`ERROR`) are all printed with their own status and exit
non-zero. Nothing is truncated or reshaped to fit the initial §12.2 numbers: real work that exceeds
them is a calibration finding.

## Scope of the three workloads

All three workloads are sent through the Sprint 2 Word catalogue (`createWordTools`), because that is
the only catalogue this sprint ships; the Excel and PowerPoint prompts calibrate the **engine**
(steps, tool calls, batch sizes, JSON discipline, guardrails), not the Excel/PowerPoint tools, which
arrive in Sprint 3+.
