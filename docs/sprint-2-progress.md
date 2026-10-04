# Sprint 2 progress — the delivered engine, the unrun calibration and the native-smoke gap

## Status at a glance

Sprint 2 delivered the generic bounded **Agent Runtime**, the extensible **Tool Registry** and the
per-tool execution policy (`auto` / `confirm` / `deny`). The engine is verified **host-side only**:
full suite `591/591`, source static audit PASS, bundle build PASS (both quoted below).

**Two things are NOT proven, and nothing in this document claims otherwise:**

1. **Pilot workload calibration (§15.2) is NOT RUN.** The values in
   [design §12.2](<superpowers/specs/2026-10-04-sprint-2-agent-runtime-design.md#L320-L342>) remain
   the **initial engineering defaults** (`maxSteps` 12, `maxToolCalls` 32, operation deadline
   150000 ms). No real-workload measurement exists.
2. **The minimal native R7 end-to-end smoke (§15.3, plan Task 12) is NOT RUN — BLOCKED.** No live R7
   plugin session is available on this host, and no host-side mock can substitute for a live editor.

The Sprint 2 implementation range this document verifies is **35 commits**, `a9784e4..adeae0f` — the
state the three verification commands below were run against. This status document is a docs-only
commit on top of that range, on branch `stage-b`.

## What Sprint 2 delivered

| Area | Representative commit | What is in the repository |
| --- | --- | --- |
| Design + plan + doc alignment | `0f0d35f`, `bcc8279`, `e94196f` | Sprint 2 [design](<superpowers/specs/2026-10-04-sprint-2-agent-runtime-design.md>) and [plan](<superpowers/plans/2026-10-04-sprint-2-agent-runtime.md>), plus the Stage B docs aligned with the agent contract |
| Hard ceilings + task guardrails | `845153c` | `AGENT_CEILINGS` and `createGuardrails` in [src/shared/limits.js](<../src/shared/limits.js>); §12.1 ceilings fixed, §12.2 guardrails configurable |
| Closed schema-subset validator | `a4d539f` (+ `86ee976`, `8b11b41`) | [src/tools/schemas.js](<../src/tools/schemas.js>): closed root/property/item schema validation at arbitrary depth, UTF-8 byte bounds, integer-keyword type checks |
| Tool registry | `1f8e7d6` (+ `993f80b`, `80aea36`) | [src/tools/registry.js](<../src/tools/registry.js>): frozen descriptors, `ASK`/`EDIT` catalogue filtering, per-tool policy, static `descriptor.execute` dispatch (no name-keyed switch) |
| Agent protocol | `86ac6a9` (+ `4bc261b`) | [src/agent/protocol.js](<../src/agent/protocol.js>): closed envelope parsing, whole-batch validation before execution, per-entry byte-bounded tool-result messages, one protocol repair |
| Active context window | `23b061d` (+ `e952688`, `816aa95`, `9e88be9`) | [src/agent/context.js](<../src/agent/context.js>): bounded window, oldest-first eviction, single drop marker, pinned system rules and original request never evicted |
| Bounded runtime loop | `d05307a` (+ `8bc2857`, `e34e460`, `06048b0`) | [src/agent/runtime.js](<../src/agent/runtime.js>): multi-step loop, batch execution, `auto`/`confirm`/`deny`, three-case per-action errors, Stop, deadline |
| Representative Word tools | `94a1dcc` (+ `349865c`, `b7ea7a7`, `41a0ffd`) | [src/tools/word.js](<../src/tools/word.js>) and the [src/plugin/bridge.js](<../src/plugin/bridge.js>) read/insert handlers |
| UI run lifecycle | `c3f63ab` (+ `9d3e00a`) | [src/ui/controller.js](<../src/ui/controller.js>) + [src/ui/view.js](<../src/ui/view.js>): run lifecycle, live step status, actions summary, Stop, write lock |
| Static-audit regressions | `d045913` (+ `c0e6fd2`) | [tests/security/audit.test.js](<../tests/security/audit.test.js>): literal-dispatch pins and the bundle-collision hazard |
| Dev Qwen workload harness | `ab0fd72` (+ `adeae0f`) | [tests/acceptance/agent/dev-qwen-workloads.mjs](<../tests/acceptance/agent/dev-qwen-workloads.mjs>) + README: dev-only, not part of `node --test` |

**Delivered representative toolset:** `read_selection` (`auto`), `insert_paragraph` (`auto`),
`replace_selection` (`confirm`).

**`read_context` is deliberately withheld** (`policy: 'deny'`): the installed build's SDK source copy
contains no `GetDocumentStructure`, so **no public document read is confirmed**. The descriptor and
handler stay one value away from being re-enabled when a native probe confirms a public read. All
native method names, result shapes and the **document-identity legs** of the bridge handlers remain
**PENDING NATIVE VERIFICATION**.

## Verification actually performed

All three commands were run on the state this document records. Exact result lines:

- **Full host suite** — `node --test`:
  `ℹ tests 591` / `ℹ pass 591` / `ℹ fail 0` / `ℹ cancelled 0` / `ℹ skipped 0` / `ℹ todo 0`.
- **Source static audit** — `node scripts/static-audit.mjs`:
  `Authored-code audit PASS` (exit 0).
- **Bundle audit** — `node scripts/build-plugin.mjs`:
  `Plugin build: 8 allowlisted files; ZIP STORE SHA-256 e963c93a9731b29d10994d335eb4bd672ec70e340277233ddbda8e62e7c1528b`
  (exit 0).

The per-source audit passing does not imply the concatenated `panel.js` passes, which is why the
**bundle** build is a separate gate.

**Per-task independent review.** Tasks 3–11 were each dispatched to a fresh reviewer session that read
the committed diff read-only and reproduced its findings, rather than trusting the implementer's report.
Two reviews returned **NEEDS REWORK** and were re-reviewed after the fixes: **Task 6** (the first
reviewer reproduced a real context-window budget defect the controller's own inspection had missed;
fix round 1 still failed the completion gate, fix round 2 passed and a *different* reviewer re-reviewed
it) and **Task 9** (six findings, then fix round 1, then APPROVED). Fix rounds by task: Task 3 two,
Task 4 two, Task 5 one, Task 6 two, Task 7 **four**, Task 8 three, Task 9 one, Task 10 one, Task 11 one.
The reviewers ran in isolated contexts but on the same model family (per-session model overrides were
not permitted in this execution), so independence comes from isolation plus read-only diff review, not
from a different model family — a same-family reviewer may share a blind spot. **Tasks 1 and 2** ran
inline before the executor switched to subagent-driven development, so they have no separate reviewer;
Task 1 is docs-only and Task 2's limits code is covered by the full suite. The **whole-branch final
review** over `a9784e4..HEAD` is still **queued** and had not been performed when this document was
written.

## What is NOT proven

### 1. Pilot workload calibration — NOT RUN

**Status:** the harness is built and reviewed; the **real run never happened.** The development endpoint
key lives in the DSH credential store (`OPENCUST_API_KEY`) and is **unreadable from this environment**,
so the harness cannot authenticate a real Qwen workload.

- The §15.2 numbers (`maxSteps`, `maxToolCalls`, batch sizes, per-step latency, context/result bytes,
  JSON-discipline and guardrail-reached counts) **do not exist**.
- **Mock records are not calibration data.** In `--mock` mode the fixed envelope yields exactly **one
  model step and zero tool calls** for all three workloads, and the elapsed ms is loop **overhead**, not
  model latency. The [harness README](<../tests/acceptance/agent/README.md#L110-L117>) states this, and
  mock mode proves the harness/transport/registry wiring only.
- What mock mode *does* demonstrate: the multi-step and repair accounting (`proposal` profile),
  a `LIMIT` with the named guardrail (`--max-steps 1`), a bounded per-request `TIMEOUT`, and an
  over-ceiling `BYTE_LIMIT` — all through the product's own `createRequest`/`requestCompletion`.
- **What would close it:** a real run of the three workloads
  (`node tests/acceptance/agent/dev-qwen-workloads.mjs word|excel|powerpoint` with
  `AGENT_DEV_ENDPOINT`/`AGENT_DEV_KEY` from a readable development credential) and setting §12.2 from
  the measured maxima plus margin. Until then the initial engineering defaults stand and are labelled as
  such in §12.2.

### 2. Minimal native R7 end-to-end smoke — NOT RUN / BLOCKED

**Status:** unproven. The plan's [Task 12](<superpowers/plans/2026-10-04-sprint-2-agent-runtime.md#L1555-L1590>)
chain — user request → development Qwen → Agent Runtime → Tool Registry → read tool → a real
`insert_paragraph` → bounded result → next model step → `final`, with the inserted paragraph read back
as proof — has never run against a live editor.

**Facts on this host** (checked read-only while writing this document; a host-side mock cannot stand in
for a live editor):

- **R7-Office 2026.3.1 IS installed** at `C:\Program Files\R7-Office\Editors-2026.3.1`. The blocker is
  **not** a missing application.
- **No R7 window is running or attached:** no `DesktopEditors`/`editors` process is present, and the
  R7 Desktop bridge reports `connected: false`, `clientCount: 0`, `port: 7888`,
  `developerMode: false`.
- `adb` is absent; it is Android tooling and not part of the R7 path, but no device route exists either.
- The previous round's temporary remote native target (SSH access, test NSS CA, mock and tunnel) was
  **deliberately torn down**; no remote target remains.

**Exact dependency — what would close it:**

1. The user's **explicit authorization** to use their local R7 installation for a native run.
2. **Installing this plugin build** into that installation.
3. A **disposable Word document**, so no real file is touched.
4. Either the **development key** (for a real Qwen call) or the Sprint 1 native pattern of the
   **acceptance mock plus a CA trusted by R7**.
5. Proving the mutation by **reading the paragraph back** through a public read.

Because the tool paths were authored against unverified public method names, the smoke is also the first
real test of the `insert_paragraph` native dispatch, the read handler and the document-identity legs.

## Design deviations and deferred minors a reader must know

These are recorded, deliberate, and none is a hidden success claim:

- **§12.3 pair eviction is NOT implemented.** The design's "oldest complete assistant/tool-result pairs"
  tier is replaced by a single-message tier: after the tool-result scan, one message at a time is
  evicted, and the newest message is never evicted. The pair form is *subsumed* (the tool-result scan
  always runs first), so a drop can leave an **orphan assistant message or tool result**. §12.3 still
  describes the pair tier; the deviation is recorded here, and the code in
  [src/agent/context.js](<../src/agent/context.js>) is the authority.
- **`validateArguments` trusts its schema argument.** It does not re-validate the schema it is handed;
  every caller must run `validateToolSchema` first. Unreachable from the product path today because
  `defineTool` validates each descriptor at load.
- **`defineTool`'s freeze is shallow for `schema`.** The schema stays by reference, so mutating a
  descriptor's schema object after registration can re-open the gate.
- **`checkNumericKeywords` forces `minimum`/`maximum` non-negative**, although JSON Schema allows signed
  bounds. Fails closed at load; no current descriptor is affected.
- **A result whose inner `result` is a primitive serializes to `{}`** and is accepted. Unreachable from
  the runtime (it always passes an object result).
- **The second disjunct of the UI controller's terminal ownership guard**
  ([src/ui/controller.js:254](<../src/ui/controller.js#L254>), `active === null && generation === owned.generation`)
  **appears to be unreachable dead code**. Harmless, but it is not evidence of a reachable state.
- **An indefinite UI write-lock after a native callback never arrives is INTENTIONAL** (design §8.4: a
  timed-out mutation stays busy/uncertain until it settles or the plugin is reinitialised). The UI maps
  the uncertain outcome to an authored caption.
- **Constraint discovered — the audit is scope-insensitive.** After esbuild concatenation, two modules
  with same-named locals can produce a **spurious `DYNAMIC_PROPERTY`**. The remedy is **renaming in the
  colliding module, never weakening the audit**; a regression test now documents this. A security gate
  is not relaxed to accommodate authored code.
- **The `native-apply` suite no longer asserts the end-to-end `BYTE_LIMIT` status** for an over-limit
  model response (dropped when the blank-replacement case became unreachable through the UI). The
  over-limit path is still pinned elsewhere.

## What Sprint 3+ is expected to add

Sprint 3+ grows the **catalogue**, not the runtime:

- **Word tools** (Sprint 3), **Cell tools** (Sprint 4) and **Slide tools** (Sprint 5): new descriptors
  and static handlers registered through the same registry — no runtime, protocol or context-window
  change. This is the design property the `descriptor.execute` dispatch exists for.
- **The Excel (`P&L`) and PowerPoint (10–15 slide) §15.2 workloads** require those catalogues; today's
  harness sends all three prompts through the Word catalogue and calibrates the **engine** only.
- **The §15.2 calibration itself** and **the §15.3 native smoke** remain open from this sprint and are
  prerequisites for any "sized for real work" claim.
- Out of Sprint 2 and still not claimed: full native catalogue acceptance, bank TLS/CORS/AUTH/Qwen,
  DEB/packaging, and publication.

## Where things stand

- **PROVEN (host-side):** the bounded runtime, the closed protocol, the bounded context window, the
  registry and policy, the representative Word tool descriptors/handlers behind the injected bridge, the
  UI lifecycle, and the static/bundle security audits — `591/591`, both audits PASS, per-task
  independent reviews with rework where needed.
- **NOT RUN:** pilot workload calibration (§15.2) — no readable development key.
- **NOT RUN / BLOCKED:** the native R7 smoke (§15.3 / Task 12) — needs the user's authorization to use
  the local R7 install, the plugin installed, a disposable document, and the dev key or a trusted mock;
  the install itself is present.
- **PENDING:** the whole-branch final review of `a9784e4..HEAD`.
