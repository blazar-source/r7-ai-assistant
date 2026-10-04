# Sprint 2 design — generic bounded Agent Runtime and extensible Tool Registry

Status: proposed design for user review. Sprint 2 is authorized by direct user instruction;
Sprint 1 / Stage B scope is historical and is **not** the product contract. No implementation starts
before this spec is approved. Only Sprint 2 is authorized; later sprints need separate authorization.

## 1. Purpose

R7 AI Assistant is a universal AI agent inside R7. The employee writes an ordinary task in the chat
("добавь после этого раздела вывод", "создай таблицу 4×5 и заполни её", "создай документ —
исследование на тему работы Р7 примерно на 10 страниц…"), and the agent itself decides which R7
operations to perform and performs them through a closed set of our own tools — the previous
Harness + dsh-r7-office experience, but fully inside the standalone plugin: no Harness, no MCP, no
Node and no external agent runtime on the employee's machine.

Sprint 2 builds the engine, not the catalogue: a generic bounded runtime plus an extensible tool
registry, proven end-to-end with a few representative tools and real development Qwen calls.

## 2. What this spec replaces (doc alignment)

Selection replacement was the Stage B vertical slice that proved live editing inside the exact R7. Its
narrow scope must not remain the product contract. The following statements are superseded by this
spec (file:line as of commit a9784e4):

| Where | Current statement | Superseded by |
| --- | --- | --- |
| `spec:7` | Purpose = "previewed replacement of a disposable Word selection" | §1: universal assistant; replacement is one tool |
| `spec:38` | "only a closed JSON proposal for the single allowed selection-replacement tool can become preview" | §6–§7: any registry tool; preview is a per-tool policy |
| `spec:38` | "Document context … limited to selection by default" | §10: bounded read tools for selection/paragraph/section/structure/table/slide |
| `spec:42` | "Editing sequence: … Preview → explicit Apply …" as the editing model | §8: editing = request → runtime → tool calls → final; replace keeps its own sequence |
| `spec:48-50` | one active operation / one callback slot for a single mutation | §8.4: same invariant applied to a sequence of actions |
| `spec:88` | "This specification defines the one-shot Sprint 1 B slice" | this spec defines the Sprint 2 engine |
| `ai-protocol:7` | "No tools, tool_choice, streaming, response_format … or native tool_calls processing" | §11: **native** OpenAI tool fields stay forbidden; our JSON tool loop inside `message.content` is the mechanism |
| `security:15` | "ASK: all mutations denied" | unchanged, restated in §9 |
| `security:16` | "every selection replacement requires Preview and explicit Apply" | §6: `replace_selection` policy `confirm`; ordinary mutations `auto` |
| `security:18` | selection exact-text precondition as the general write precondition | §5/§10: per-tool precondition |
| `architecture:5` | "EDIT предлагает и применяет проверенные изменения" | §4/§9: the agent executes allowlisted tools under per-tool policy; ASK never mutates |
| `roadmap:10` | Sprint 2 = "Bounded agent runtime + Qwen development validation" | same scope, now defined: registry + per-tool policy + batch loop |
| `limits.js` | `previewTtlMs` / `applyObservationMs` as global contract | §12: they apply to `confirm` tools only |

Nothing in ADR 0002, the strict-bank request shape, the content-only response rule, the no-service /
no-Node runtime, the no-auto-Save rule or the no-retry-for-uncertain rule is relaxed.

## 3. Non-goals

- No universal Plan Builder: mutations are **not** accumulated into one global plan requiring one
  global Preview/Apply. (The Stage B plan/preview stays as `replace_selection`'s own policy.)
- No transaction engine, dependency graph, rollback planner, compensation framework or automatic
  recovery research. Error semantics stay the simple three-case model in §8.
- No full Word/Cell/Slide catalogue (Sprint 3+), but the registry must accept new tools without
  changing the runtime.
- No native OpenAI tools / tool_choice / tool_calls / streaming / response_format / structured output.
- No external service, daemon, MCP, socket, Node.js or model-generated code in the runtime.
- No automatic whole-document upload, no automatic Save, no content logging.

## 4. Components

```
src/agent/     runtime.js   bounded loop, batch dispatch, budgets, repair, cancellation
               protocol.js  closed envelope parse/validate for model responses
               prompt.js    system rules + tool catalogue rendering (trusted text)
src/tools/     registry.js  descriptor validation + name→handler literal table
               schemas.js   closed JSON-Schema-subset validator
               word.js      Word tool descriptors + static handlers (Sprint 2 subset)
src/ai/        transport.js unchanged strict-bank single POST
               protocol.js  strict-bank request construction (unchanged)
src/plugin/    bridge.js    per-tool SDK handlers behind one owned callback slot
src/ui/        controller.js run lifecycle, actions log, Stop
               view.js      chat, live step status, actions summary (never raw JSON)
src/shared/    limits.js    agent budgets (§12); errors.js, bytes.js, session.js unchanged
```

Boundary rules: `agent` never touches the SDK (it calls registry handlers through one interface);
`tools` handlers never touch settings, storage or the network; `ui` never sees raw model JSON as
markup; `ai` keeps the strict-bank shape and remains the only network path.

## 5. Tool descriptor

Each tool is one author-written descriptor plus one author-written static handler:

```js
{
  name: 'insert_table',            // literal, unique, lowercase snake_case
  kind: 'read' | 'mutate',
  editors: ['word'],               // or ['word','cell','slide']
  schema: { … },                   // closed JSON-Schema subset (§5.1)
  policy: 'auto' | 'confirm' | 'deny',
  requires: ['document.read'] ,    // capability keys checked at catalogue time
  precondition(args, ctx),         // pure, synchronous, may return a safe refusal
  execute(args, ctx)               // static function → bounded result object
}
```

Registry rules:

1. Descriptors are validated at load: closed property set, literal name, known `kind`, non-empty
   `editors`, closed `schema`, valid `policy`, array `requires`, functions for
   `precondition`/`execute`. A malformed descriptor is a build/startup failure, not a runtime guess.
2. Dispatch is a **closed literal table** `{insert_table: handlerInsertTable, …}`. The model's tool
   name is only a key lookup **after** allowlist validation. `globalThis[name]`, `eval`, `new
   Function`, string timers and computed function access are rejected by the static audit.
3. Every handler returns a bounded plain-data result `{ ok: true, data }` or
   `{ ok: false, code, message }` with `code` from a fixed enum. Exactly one code,
   `EDITOR_UNCERTAIN`, means "it is unknown whether the mutation executed" and is the only code that
   stops the run (§8.3); every other code is a known tool error returned to the model. Unknown/extra
   fields are rejected.
4. Sprint 3+ adds tools by adding descriptors and handlers; the runtime, protocol and UI do not change.

### 5.1 Closed schema subset

`type` (`object|string|integer|boolean|array`), `properties`, `required`, `additionalProperties:false`,
`items`, `enum`, `minimum`, `maximum`, `maxItems`, `maxBytes` (UTF-8, checked before allocation).
Unknown keywords are rejected. Validation is authored code (no dependency, no schema library).

## 6. Per-tool execution policy

| Policy | Meaning | Sprint 2 tools |
| --- | --- | --- |
| `auto` | After schema + capability + precondition validation the runtime executes the handler immediately; the bounded result goes back to the model | `read_context`, `read_selection`, `insert_text`, `insert_paragraph` |
| `confirm` | The runtime does **not** execute; it publishes a proposal through the existing Preview → explicit Apply UX | `replace_selection` |
| `deny` | Filtered out of the catalogue (never offered, never executable) | every `mutate` tool in ASK; tools whose `requires` are unmet; unsupported editors |

Rules:

1. Policy is declared by the tool, not by the mode. ASK/EDIT only filters the catalogue (§9).
2. A batch containing a `confirm` action must contain **only** that action; policy validation otherwise
   returns a known tool error asking the model to split the step. This keeps the existing Preview
   contract crisp and avoids ambiguous mixed batches.
3. `confirm` actions never execute during the loop; the run reports `PREVIEW_READY` and waits for the
   user. Apply executes exactly the approved action with its precondition re-checked (Stage B
   behaviour, unchanged).
4. A future genuinely dangerous operation gets `confirm` by declaring it — an exception for one tool,
   never a global mutation gate.

## 7. Model protocol (text inside `message.content`)

One closed JSON object per model response, optionally wrapped in a single complete ```json fence:

```json
{"type":"tool_calls","calls":[{"tool":"read_context","arguments":{"scope":"section","index":2}},
                             {"tool":"insert_paragraph","arguments":{"position":"after_section","index":2,"text":"…"}}]}
```

```json
{"type":"final","message":"Готово"}
```

Rules: `calls` length 1..`maxActionsPerStep`; each `tool` must be an allowlisted name for the current
catalogue; each `arguments` must validate against that tool's closed schema. Unknown fields, unknown
tools, wrong arity, non-string content, ordinary prose and JSON arrays at the top level are protocol
errors (never executable fallbacks). Tool results are returned to the model as **compatible
conversation messages** carrying bounded JSON (never native function/tool messages). System rules and
the catalogue are trusted text; document context and tool results are explicitly untrusted data.

Protocol repair: at most **one** controlled repair request per user task — the runtime returns the
validation error and asks for a corrected object. A second failure ends the run with a safe classified
error. Malformed JSON never becomes an executable fallback.

## 8. Runtime semantics

### 8.1 Loop

```
run(userRequest):
  for step in 1..maxSteps:
     response = transport(messages, settings)          # strict-bank POST, one request per step
     parsed   = parse(response.content)                 # §7 (repair ≤1)
     if parsed.type == 'final': return done(parsed.message)
     validateBatch(parsed.calls)                        # names/arity/schema + confirm-must-be-alone (§6.2)
     results = []
     for call in parsed.calls:                          # sequential, in order
        desc = registry.allowlist(catalogue, call.tool)  # unknown → known tool error
        validate capability + precondition
        if desc.policy == 'confirm': publish preview; return previewReady()
        if desc.policy != 'auto': return knownToolError()
        result = desc.execute(call.arguments, ctx)       # static handler, bounded result
        results.push({tool, result})
        if result.code == 'EDITOR_UNCERTAIN': return uncertain()   # §8.3 — run stops
        # any other handled failure is a known tool error: keep going, the model sees it and may replan
     messages += toolResultMessage(results)
  return limitReached()
```

### 8.2 Batch

Actions of one batch execute sequentially with bounded results returned for each. A known error on
action *k* does **not** discard the results of actions 1..k-1 or cancel the rest by rule: the runtime
continues through the batch where the next action is still valid, and the model sees every result and
can replan on the next step. No formal dependency graph is built; if a concrete follow-up action is
impossible, its own precondition fails with a known error and the model adapts.

### 8.3 Error semantics (three cases only)

| Case | Behaviour |
| --- | --- |
| Success | bounded result returned to the model; the loop continues |
| Known tool error (schema, capability, precondition, refused public API, handler `ok:false`) | returned to the model as a tool result; the model may pick another tool, other arguments, re-read context, skip an optional action or take another route; the user task is **not** aborted because of one local failure |
| Uncertain mutation outcome | only when it is genuinely unknown whether a mutation executed: the run stops safely, conflicting controls stay disabled, and the user is told to check the document. No retry, no rollback claim, no recovery research |

### 8.4 Ownership and cancellation

One active run; at most one outstanding R7 API callback **per dispatched action**. A mutation is never
dispatched while a previous mutation is unsettled. Stop: cancels the active network request where
possible, prevents not-yet-started actions and future steps, and leaves completed changes in place
(native Undo is the user's rollback). Settings change, New chat, Reset, editor/document change
invalidate the run before any further dispatch. Late/duplicate callbacks release only their own slot
and never publish stale content.

## 9. ASK and EDIT

- **ASK**: catalogue contains `read` tools only. No model output can reach a mutation: `mutate` tools
  are absent from the catalogue and rejected by policy validation even if named.
- **EDIT**: `read` + permitted `mutate` tools under their own policy; ordinary editing runs
  automatically; `replace_selection` uses the existing Preview/Apply.
- The mode never decides preview; the tool policy does.

## 10. Context

Context is obtained by the agent through bounded read tools, never by automatically uploading the
whole document:

| Tool | Returns |
| --- | --- |
| `read_selection` | current selection text/format summary (bounded) |
| `read_context` | `scope: paragraph \| section \| structure \| table \| slide`, addressed by a bounded 0-based `index` validated against the structure read (out of range is a known tool error, never a guess) |
| (Sprint 3+) | `read_range`, `read_slide_objects`, … |

Each read is bounded (§12), returns plain data, and marks content as untrusted. Long tasks read the
structure first, then only the needed parts.

## 11. Strict-bank AI contract (unchanged)

POST to the configured HTTPS `/v1/chat/completions` endpoint; request fields only `model`, `messages`,
`max_tokens`, `temperature`; headers `Authorization`, `Content-Type`, `X-Session-ID`; response read
only from `choices[].message.content` as text; `redirect: 'error'`, AbortController, byte ceiling
while reading. **No** native `tools`, `tool_choice`, `tool_calls`, streaming, `response_format` or
structured-output API. The whole tool protocol lives inside ordinary text `message.content`, so the
loop is several ordinary completion requests, each holding the conversation plus bounded tool results.

## 12. Budgets (initial engineering defaults, calibratable)

| Budget | Initial value | Note |
| --- | --- | --- |
| `maxSteps` | 12 | model round-trips per user task |
| `maxToolCalls` | 32 | executed actions per task |
| `maxActionsPerStep` | 8 | batch size in one model response |
| `protocolRepair` | 1 | controlled repair per task |
| operation deadline | 150000 ms | existing `operationTimeoutMs` |
| HTTP timeout | settings, 5–120 s | unchanged |
| tool result / tool-results total | 16 KiB / 128 KiB | bounded before returning to the model |
| context read | 8 KiB selection, 16 KiB paragraph/section | per read |
| catalogue size | bounded by editor + capabilities | rendered into the system prompt |

These are engineering defaults, expected to be calibrated on real Qwen/R7 scenarios (for example a
10-page document task). They live in one table (§4 `limits.js`), so changing them never requires a
runtime change. `previewTtlMs` (120000 ms) and `applyObservationMs` (15000 ms) stay but apply to
`confirm` tools only.

## 13. Security invariants (ADR 0002 binding)

- Model output is data: `text → JSON parse → schema validation → policy → capability → typed
  arguments → static handler`. No eval, `new Function`, string execution, string timers, model-written
  JS/DocScript, or model-supplied callCommand bodies. `callCommand` may receive only author-written
  static functions; model arguments cross as JSON data.
- Tool dispatch is a closed literal table; the audit rejects dynamic lookup of functions, indirect
  global dynamic execution and non-static command bodies, and gains regression cases for the new
  modules.
- Catalogue filtering by editor, capabilities and mode; unknown tools and unknown fields are errors.
- No secrets, endpoints, headers, raw identifiers or content in logs/errors/artifacts; count-only
  technical events (`step`, `tool`, `outcome`, `duration`, `result bytes`).
- No new network destination, no daemon/socket, no auto-Save, no CDN/runtime download.

## 14. Sprint 2 deliverable set

Representative tools proving the architecture (not the full catalogue):

| Tool | Kind | Policy | Proves |
| --- | --- | --- | --- |
| `read_selection` | read | auto | bounded read tool + result feed |
| `read_context` (paragraph/section/structure) | read | auto | agent-driven context, no whole-document upload |
| `insert_paragraph` / `insert_text` | mutate | auto | automatic mutation without per-step confirmation |
| `replace_selection` | mutate | confirm | per-tool policy: existing Preview/Apply preserved |

Plus: generic registry, batch execution, read→result→next step, known-error replanning, uncertain
stop, `final`, budgets, malformed JSON + repair, Stop, catalogue filtering, and real development Qwen
calls. Word insert/format/table/list/hyperlink, Cell and Slide tools are Sprint 3+ additions to the
same registry.

## 15. Verification plan

**Host tests (`node:test`, no R7, no network):**
registry descriptor validation; closed-schema validator (every keyword, multibyte byte bounds,
unknown fields); catalogue filtering by editor/capability/mode; policy `deny` rejection by name;
batch sequential execution order and per-action results; `confirm`-must-be-alone rule; known error
returned and loop continues; precondition failure is a known error; uncertain stops the run and
prevents further dispatch; `maxSteps`/`maxToolCalls`/`maxActionsPerStep` enforcement; repair once then
fail; malformed JSON and prose rejected; Stop cancels network and prevents future actions; late
callback releases only; no-eval/static-dispatch audit with new modules; byte bounds on every path.

**Real development Qwen validation (dev transport only):** an ignored host-side dev harness runs the
authored `src/agent` + `src/tools` modules against OpenRouter with the user's configured endpoint/key
and a recording stub bridge (no R7, no document). Scenarios: multi-step document task; multi-tool
batch ("добавь раздел, заголовок жирным, таблица 3×4"); selection-based italic; malformed-JSON repair;
known-error replanning; `confirm` policy on `replace_selection`. Evidence is count-only (steps, tool
names, outcomes, durations, sizes) — no request/response content, keys, headers or identifiers. This
validates the engine and the model's JSON discipline; it is **not** native R7 acceptance and does not
prove bank Qwen, bank TLS/CORS/AUTH or any editor mutation.

**Not in Sprint 2:** native R7 acceptance of the new tools, full catalogue, DEB/packaging, bank
installation.

## 16. Open items for the reviewer

1. Exact envelope naming (`tool_calls` + `final`) and whether a single-call shorthand is worth it.
2. Whether `insert_paragraph` and `insert_text` are both needed in Sprint 2 or one suffices.
3. Final initial values of §12 once the 10-page scenario is measured.
4. Whether §2 doc alignment is applied together with this spec or as the first Sprint 2 commit.
