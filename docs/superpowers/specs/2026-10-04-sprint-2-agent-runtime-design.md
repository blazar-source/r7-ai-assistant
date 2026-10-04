# Sprint 2 design — generic bounded Agent Runtime and extensible Tool Registry

Status: proposed design for user review. Sprint 2 is authorized by direct user instruction;
Sprint 1 / Stage B scope is historical and is **not** the product contract. No implementation starts
before this spec is approved. Only Sprint 2 is authorized; later sprints need separate authorization.

Revision 2: sized for pilot workload, not for the Sprint 2 demo — §1 (pilot tasks, role of selection
replacement), §3 (no demo-shaped engine), §12 (hard safety ceilings separated from configurable task
guardrails), §14 (minimal toolset, pilot-sized engine), §15 (Word/Excel/PowerPoint calibration
workloads + minimal native R7 smoke), §16 (resolved decisions).

Revision 3: §12.1 ceilings are explicitly **per payload / per result / per request / per active
context window**, never a lifetime task total; the previous 128 KiB cumulative cap is removed and
replaced by §12.3 — simple bounded context management (evict oldest tool results first, one marker,
data re-readable through tools; no memory subsystem), with matching host tests in §15.1.

## 1. Purpose

R7 AI Assistant is a universal AI agent inside R7. The employee writes an ordinary task in the chat
("добавь после этого раздела вывод", "создай таблицу 4×5 и заполни её", "создай документ —
исследование на тему работы Р7 примерно на 10 страниц…"), and the agent itself decides which R7
operations to perform and performs them through a closed set of our own tools — the previous
Harness + dsh-r7-office experience, but fully inside the standalone plugin: no Harness, no MCP, no
Node and no external agent runtime on the employee's machine.

Sprint 2 builds the engine, not the catalogue: a generic bounded runtime plus an extensible tool
registry, proven end-to-end with a few representative tools and real development Qwen calls.

The engine is designed for the **pilot workload**, not for the Sprint 2 demo. Pilot tasks are compound
and long: «добавь новую главу», «допиши раздел выводами», «создай документ — исследование на тему
работы Р7 примерно на 10 страниц», «сделай расчёт», «построй P&L модель», «заполни формулы на три
года», «создай презентацию на 10–15 слайдов», «переделай структуру презентации». One phrase delegates
creating, extending, recomputing or reworking a substantial part of a document, and the agent must
carry that out autonomously over many model steps and tens of tool calls.

> **Sprint 2 implementation uses a small representative toolset, but Agent Runtime is designed for
> long, compound pilot workloads across Word/Cell/Slide. Current step/tool/time limits are calibratable
> guardrails, not product-task limits.**

### 1.1 Role of selection replacement

`selection → AI result → Preview → Apply/Cancel → replace_selection` remains an important registered
scenario ("перепиши", "сократи", "исправь", "переведи выделенный фрагмент") and one tool policy
(`confirm`). It is one scenario among many and it does **not** define the shape of the runtime or the
product architecture.

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
- **No designing the engine around the Sprint 2 demo** — a one- or two-action task, a short
  replacement, a small document or a short session. Sprint 2 ships few tools; the runtime ships
  sized for the pilot workloads in §1 and §15.2.
- No native OpenAI tools / tool_choice / tool_calls / streaming / response_format / structured output.
- No external service, daemon, MCP, socket, Node.js or model-generated code in the runtime.
- No automatic whole-document upload, no automatic Save, no content logging.

## 4. Components

```
src/agent/     runtime.js   bounded loop, batch dispatch, limits/guardrails, repair, cancellation
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
src/shared/    limits.js    hard ceilings + configurable guardrails (§12); errors.js, bytes.js, session.js unchanged
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
| `auto` | After schema + capability + precondition validation the runtime executes the handler immediately; the bounded result goes back to the model | `read_context`, `read_selection`, `insert_paragraph` |
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

## 12. Limits: hard safety ceilings vs runtime task guardrails

Two different things, deliberately separated.

### 12.1 Hard safety ceilings (enforced before allocation; not lowered to fit a demo)

| Ceiling | Value | Scope |
| --- | --- | --- |
| model response content | 65536 B | one response |
| JSON envelope / parsed action batch | 65536 B | one response |
| arguments per action | 8192 B | one action |
| one tool result returned to the model | 16 KiB | one result |
| context read | 8 KiB selection, 16 KiB paragraph/section | one read |
| active model context window (system + catalogue + retained history + tool results) | 64 KiB content | one request |
| `maxActionsPerStep` (batch size) | 8 | one batch |
| `protocolRepair` | 1 | per task |
| HTTP response envelope | 131072 B (transport, §11) | one response |
| request body | 98304 B (unchanged strict-bank) | one request |

These exist to stop runaway behaviour, unbounded memory/network use and malformed input — not to cap
legitimate work. **Every ceiling here is per payload, per result, per request or per active context
window — none of them is a lifetime limit for a user task.** A long compound task may legitimately read
and process far more than any single number above, across many steps; what stays bounded is each
payload and the size of the conversation actually sent to the model at that moment (§12.3). "Make the
acceptance scenario fit" is never a reason to lower a ceiling.

### 12.3 Active context window (simple bounded context management)

The conversation grows with every step; only the window sent to the model is bounded:

1. Before each request the runtime enforces `activeContextBytes` (64 KiB of content, plus the
   unchanged request-body ceiling). If adding the newest tool results would exceed it, the runtime
   evicts **oldest first**: completed tool-result messages, then the oldest complete
   assistant/tool-result pairs, never the system rules + tool catalogue, never the current user
   request.
2. Eviction is removal, not summarization: the runtime inserts one short literal marker ("earlier tool
   results were dropped from context; re-read what you still need") so the model knows it can re-read
   through the read tools. No extra model call, no memory subsystem, no retrieval framework.
3. Data that leaves the window is re-obtainable on demand from the document through read tools — the
   document is the store of record, not the conversation.
4. The same rule applies to chat history between requests (the existing `sentHistoryMessages` /
   `sentHistoryBytes` behaviour extended to tool results).

This is deliberately the whole mechanism: evict oldest, mark, allow re-read. Anything beyond that
(rolling summaries, embeddings, a memory layer) is out of scope for Sprint 2 and for this design.

All limits live in one table (§4 `limits.js`). `previewTtlMs` (120000 ms) and `applyObservationMs`
(15000 ms) stay and apply to `confirm` tools only.

### 12.2 Runtime task guardrails (configurable; calibrated on the pilot workloads)

| Guardrail | Initial engineering default | Meaning |
| --- | --- | --- |
| `maxSteps` | 12 | model round-trips per user task |
| `maxToolCalls` | 32 | executed actions per user task |
| operation deadline | 150000 ms | wall-clock guardrail for one user task |
| HTTP timeout | settings, 5–120 s | unchanged, per request |

A legitimate pilot task — a ten-page structured document, a P&L model, a 10–15 slide deck — may need
several minutes, many model steps and dozens of tool calls. The numbers above are **development
defaults**, not a product limit: the pilot guardrails are set from the measurements in §15.2, and the
architecture must accept far larger values without a runtime change. When a guardrail is reached, the
run stops with a clear "задача превысила текущий лимит" outcome, completed changes stay (native Undo
is the user's rollback), and nothing is silently truncated.

> **Calibration status (recorded by Task 13, 2026-10-04): the §15.2 pilot calibration was NOT RUN, so
> the values above are still the INITIAL ENGINEERING DEFAULTS, not measured pilot guardrails.** The
> development endpoint key lives in the DSH credential store and is unreadable from the implementation
> environment, so no real Qwen workload was executed; mock harness records are explicitly **not**
> calibration data (the fixed envelope yields one model step, zero tool calls and loop-overhead
> latency). The measurements listed in §15.2 remain PENDING, and the gap with its dependencies is
> recorded in [Sprint 2 progress](../../sprint-2-progress.md).

All limits live in one table (§4 `limits.js`). `previewTtlMs` (120000 ms) and `applyObservationMs`
(15000 ms) stay and apply to `confirm` tools only.

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

## 14. Sprint 2 deliverable set (minimal tools, pilot-sized engine)

The Sprint 2 toolset is deliberately minimal; the engine is not.

| Tool | Kind | Policy | Proves |
| --- | --- | --- | --- |
| `read_selection` | read | auto | bounded read tool + result feed |
| `read_context` (paragraph/section/structure) | read | auto | agent-driven context, no whole-document upload |
| `insert_paragraph` | mutate | auto | high-level automatic mutation without per-step confirmation |
| `replace_selection` | mutate | confirm | per-tool policy: the existing Preview/Apply scenario |

`insert_text` is deliberately **not** added in Sprint 2: it has no distinct real semantics yet, and a
second near-duplicate tool would prove nothing about extensibility. It arrives when a distinct
semantics exists (for example inline insertion inside an existing paragraph).

Engine properties that must hold at the end of Sprint 2, because Sprint 3+ builds on them: generic
registry; batch execution; read→result→next model step; automatic mutations; a `confirm` mutation;
known-error replanning; uncertain stop; `final`; hard ceilings + configurable guardrails; malformed
JSON with one controlled repair; Stop; catalogue filtering; real development Qwen calls; and the
minimal native R7 smoke (§15.3).

Sprint 3+ only **adds** Word/Cell/Slide tools to the same registry — protocol, loop, batch, registry,
policies, limits and error semantics must not be rewritten. Tools stay high-level and user-level:
`insert_section`/`insert_blocks` where the public API allows it cleanly, `insert_table` with
rows/columns/data, `create_list`, `format_range`, `set_heading`, `add_hyperlink` for Word;
`set_range_values`, `set_range_formulas`, `format_range` (never `set_cell` × N) for Cell; `add_slide`,
`set_slide_content`, `add_shape`, `format_shape` for Slide. Never one giant `do_everything`, and never
hundreds of micro-calls per user task.

## 15. Verification plan

### 15.1 Host tests (`node:test`, no R7, no network)

Registry descriptor validation; closed-schema validator (every keyword, multibyte byte bounds,
unknown fields); catalogue filtering by editor/capability/mode; policy `deny` rejection by name; batch
sequential execution order and per-action results; `confirm`-must-be-alone rule; known error returned
and the loop continues; precondition failure is a known error; uncertain stops the run and prevents
further dispatch; hard ceilings enforced on every path (response, batch, arguments, one result, totals);
configured `maxSteps`/`maxToolCalls`/deadline guardrails enforced and independently raisable in tests;
repair once then fail; malformed JSON and prose rejected; Stop cancels network and prevents future
actions; late callback releases only; no-eval/static-dispatch audit extended to the new modules;
active-context-window enforcement (oldest tool results evicted first, system rules/catalogue and the
current user request never evicted, marker inserted once, a task whose cumulative bytes far exceed the
window still completes because eviction — not a lifetime cap — bounds it, and evicted data stays
re-readable).

### 15.2 Pilot workload calibration (dev transport, real Qwen; measures the guardrails)

Three representative workloads are run through the real runtime before Pilot RC. They exist to
calibrate §12.2, not to prove the tools:

| Workload | Task | What is measured |
| --- | --- | --- |
| Word | create a structured ~10-page document from scratch (title/headings, chapters, several tables, formatting, conclusions), then revise part of it | model steps, tool calls, batch sizes, latency per step, total runtime, context/result bytes, JSON discipline failures, guardrails reached |
| Excel | create a meaningful P&L model (several sheets, assumptions, values, formulas over three years, totals, percentages, formatting, check of the calculations) | same |
| PowerPoint | create a 10–15 slide deck (structure, headings, body text, tables/simple shapes, formatting), then change several slides | same |

These run with the dev transport (OpenRouter + Qwen) and a recording stub bridge first; the same
scenarios then back the native smoke in §15.3 for the parts the real R7 supports. The measured values
decide the pilot guardrails — real work is never reshaped to fit the initial numbers. The three
workloads are the primary evidence for "the engine is not sized for a demo"; a workload that cannot
fit must be reported as a calibration finding, not silently truncated.

Supporting dev-transport scenarios (cheap, deterministic): multi-step document task; multi-tool batch
(«добавь раздел, заголовок жирным, таблица 3×4»); selection-based italic; malformed-JSON repair;
known-error replanning; `confirm` policy on `replace_selection`.

### 15.3 Minimal native R7 end-to-end smoke

One small smoke on the real R7 proves the new runtime is actually wired into the live plugin and is
not only working against a stub bridge:

```
user request → development Qwen → new Agent Runtime → Tool Registry
→ read tool → one simple auto-mutation → real R7 → bounded result
→ next model step → final
```

Scope: a request that needs at least two model steps, one read tool and one real `insert_paragraph`
mutation in Word, plus a `final`. Full native catalogue acceptance is **not** required in Sprint 2 and
is not claimed here.

### 15.4 Evidence discipline and what this does not prove

Evidence is count-only (steps, tool names, outcomes, durations, sizes) — no request/response content,
keys, headers or identifiers. §15.1–§15.2 prove the engine and the model's JSON discipline; §15.3
proves the live wiring for one representative path. None of them proves bank Qwen, bank TLS/CORS/AUTH,
or editor mutation beyond the single smoked tool.

**Not in Sprint 2:** full native acceptance of the catalogue, Word/Cell/Slide catalogue, DEB/packaging,
bank installation.

## 16. Resolved decisions and remaining calibration

Resolved by the user:

1. Envelope is `{"type":"tool_calls","calls":[…]}` plus `{"type":"final",…}`, with no single-call
   shorthand.
2. Sprint 2 ships one representative auto-mutation tool: `insert_paragraph` (`insert_text` deferred
   until it has distinct real semantics).
3. The §12.2 values are initial engineering defaults; the pilot guardrails come from the §15.2
   measurements. §12.1 ceilings are not calibrated down.
4. The §2 doc alignment is applied as the **first** Sprint 2 commit after this spec is approved, and
   before any runtime implementation.
5. Byte ceilings are per payload / per result / per request / per active context window — never a
   lifetime task total. Long tasks are bounded by §12.3 eviction (oldest tool results first, marker,
   re-readable), not by a cumulative cap.

Remaining calibration (measurement work, not design blockers): final `maxSteps`/`maxToolCalls`/deadline
per editor and workload class; whether `maxActionsPerStep` above 8 helps on long tasks; context-read
sizes for large documents.
