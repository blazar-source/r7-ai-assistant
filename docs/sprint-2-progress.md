# Sprint 2 progress — the delivered engine, the unrun calibration and the native-smoke gap

## Status at a glance

Sprint 2 delivered the generic bounded **Agent Runtime**, the extensible **Tool Registry** and the
per-tool execution policy (`auto` / `confirm` / `deny`). The engine is verified **host-side only**:
full suite `604/604`, source static audit PASS, bundle build PASS (all quoted below, measured on the
final tree).

**Two things are NOT proven, and nothing in this document claims otherwise:**

1. **Pilot workload calibration (§15.2) is NOT RUN.** The values in
   [design §12.2](<superpowers/specs/2026-10-04-sprint-2-agent-runtime-design.md#L320-L342>) remain
   the **initial engineering defaults** (`maxSteps` 12, `maxToolCalls` 32, operation deadline
   150000 ms). No real-workload measurement exists.
2. **The minimal native R7 end-to-end smoke (§15.3, plan Task 12) is NOT RUN — BLOCKED.** No live R7
   plugin session is available on this host, and no host-side mock can substitute for a live editor.

The final-review defect that was item 1 here — the uncertain-mutation outcome on the insert path — is
**fixed and re-verified**; it is recorded under [What was proven after the final review](#what-was-proven-after-the-final-review)
and is no longer an open defect.

Sprint 2's implementation range is **40 commits**, `a9784e4..HEAD` on branch `stage-b`, of which the
final-review fix `f0781d8` and the closing correction commits (`c324d09`, `c7ae521`, plus this round's
tests/documents commit) are the last few. **No `src/` file changed after `f0781d8`**, so the tree this
document records and the tree the three verification commands below were run on have the same product
code and the same bundle input.

## What Sprint 2 delivered

| Area | Representative commit | What is in the repository |
| --- | --- | --- |
| Design + plan + doc alignment | `0f0d35f`, `bcc8279`, `e94196f` | Sprint 2 [design](<superpowers/specs/2026-10-04-sprint-2-agent-runtime-design.md>) and [plan](<superpowers/plans/2026-10-04-sprint-2-agent-runtime.md>), plus the Stage B docs aligned with the agent contract |
| Hard ceilings + task guardrails | `845153c` | `AGENT_CEILINGS` and `createGuardrails` in [src/shared/limits.js](<../src/shared/limits.js>); §12.1 ceilings fixed, §12.2 guardrails configurable |
| Closed schema-subset validator | `a4d539f` (+ `86ee976`, `8b11b41`) | [src/tools/schemas.js](<../src/tools/schemas.js>): closed root/property/item schema validation at arbitrary depth, UTF-8 byte bounds, integer-keyword type checks |
| Tool registry | `1f8e7d6` (+ `993f80b`, `80aea36`) | [src/tools/registry.js](<../src/tools/registry.js>): frozen descriptors, `ASK`/`EDIT` catalogue filtering, per-tool policy, static `descriptor.execute` dispatch (no name-keyed switch) |
| Agent protocol | `86ac6a9` (+ `4bc261b`) | [src/agent/protocol.js](<../src/agent/protocol.js>): closed envelope parsing, whole-batch validation before execution, per-entry byte-bounded tool-result messages, one protocol repair |
| Active context window | `23b061d` (+ `e952688`, `816aa95`, `9e88be9`) | [src/agent/context.js](<../src/agent/context.js>): bounded window, oldest-first eviction, single drop marker, pinned system rules and original request never evicted |
| Bounded runtime loop | `d05307a` (+ `8bc2857`, `e34e460`, `06048b0`) | [src/agent/runtime.js](<../src/agent/runtime.js>): multi-step loop, batch execution, `auto`/`confirm`/`deny`, the three-case per-action error model — whose **uncertain-mutation leg was not enforced on the insert path** until the final-review fix `f0781d8`, after which it is proven (see below) — Stop, deadline |
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

All three commands were re-run on the FINAL tree — commit `f0781d8` plus this round's test/doc-only
commit — and the numbers below were measured on that tree. Only test and documentation files changed
after `f0781d8`, so the bundle input is byte-identical and the bundle hash is `f0781d8`'s own. Exact
result lines:

- **Full host suite** — `node --test` (three consecutive runs, every one identical):
  `ℹ tests 604` / `ℹ pass 604` / `ℹ fail 0` / `ℹ cancelled 0` / `ℹ skipped 0` / `ℹ todo 0`.
- **Source static audit** — `node scripts/static-audit.mjs`:
  `Authored-code audit PASS` (exit 0).
- **Bundle audit** — `node scripts/build-plugin.mjs`:
  `Plugin build: 8 allowlisted files; ZIP STORE SHA-256 05b75be9fa5b9367d2bf40dbfba9c74711ba6ebb4a666b3dad880e55175c6386`
  (exit 0).

The per-source audit passing does not imply the concatenated `panel.js` passes, which is why the
**bundle** build is a separate gate.

The superseded pair of numbers is kept here for the record: the earlier state `a9784e4..adeae0f`
reported `591/591` and bundle SHA-256 `e963c93a…`. That state is no longer the accepted one — `f0781d8`
changed `src/` (and added tests), so its numbers may not be quoted for the current tree.

## What was proven after the final review

The **whole-branch final review** over `a9784e4..HEAD` found, not by any per-task review, that the
runtime's three-case error model was **not enforced on the insert path**: the bridge
[src/plugin/bridge.js](<../src/plugin/bridge.js>) RETURNS `{ok:false, code:'APPLY_UNCERTAIN'}` when a
dispatched insert times out, while [src/tools/word.js](<../src/tools/word.js>) mapped only the
**thrown** form, so the returned form fell through to the ordinary `ok:false` branch as a known tool
error that does not stop the run — a genuinely unknown mutation outcome could have been reported as
`COMPLETE`. Design §8.3 requires the opposite: such an outcome stops the run fail-safe.

The fix is committed as **`f0781d8`** — *fix(tools): treat a returned uncertain insert as uncertain and
stop exporting withheld tools*. It:

- classifies **both** the thrown and the RETURNED `{ok:false, code:'APPLY_UNCERTAIN'}` insert outcome as
  `TOOL_UNCERTAIN`, so the runtime halts on a genuinely unknown mutation outcome;
- withholds the `read_context` descriptor from `registry.tools` and from every `catalogue(...)` result,
  so no consumer iterating either surface can reach it; `createWordTools` itself still returns the
  descriptor by design (its denial-site comment says so), which is what keeps the probe-driven switch
  back a one-value change;
- adds the controller→`runAgent`→real-bridge mutation integration test and the registry/word
  regression tests for both legs.

**Independently re-verified in this round** (not merely re-run by the author of the fix):

- `tests/integration/controller-bridge.test.js` — *"an insert whose native PasteText callback never
  arrives stops the run as uncertain and keeps the write lock"*: the controller terminal status is
  `APPLY_UNCERTAIN`, `state.agent.status` is `UNCERTAIN` (never `COMPLETE`), exactly one model step and
  one native mutation were dispatched, the action is `insert_paragraph`/`uncertain`/`TOOL_UNCERTAIN`,
  and the write lock holds. PASS.
- The control leg: an acknowledged insert (`{ok:true, data:{sent:true}}`) still reaches `COMPLETE` /
  `FINAL` with the second model step — pinned by *"an acknowledged insert reaches COMPLETE/FINAL with the
  action ok and no write lock left held"* in
  [tests/integration/controller-bridge.test.js](<../tests/integration/controller-bridge.test.js>) — so
  the new mapping cannot have turned every insert into an uncertain outcome.
- `tests/unit/tools-word.test.js` — *"insert_paragraph classifies a RETURNED uncertain insert exactly
  like a thrown one"* and the pre-existing thrown-form pin both PASS;
  `tests/unit/tools-registry.test.js` — *"registry.tools publishes no withheld descriptor"* PASS;
  `tests/unit/tools-word.test.js` — *"read_context is withheld from every catalogue until a public
  document read is confirmed"* (which now also asserts `registry.tools`) PASS.
- The three commands above (604/604, audit PASS, bundle PASS) were run on the final tree.

The **uncertain-mutation leg therefore belongs in the PROVEN list** and the three-case per-action model
is claimed for the insert path, the one auto-mutation this sprint ships.

### A wall-clock-flaky acceptance test, found and fixed in the same round

The focused acceptance file [tests/acceptance/agent/dev-qwen-workloads.test.js](<../tests/acceptance/agent/dev-qwen-workloads.test.js>)
contained a case that depended on wall-clock timing: with `--deadline-ms 1`, either the runtime's own
pre-step check fires (`LIMIT`, nothing sent) or the transport's entry check fires (`ERROR`/`TIMEOUT`,
no body built) depending only on how many milliseconds the host spent between the two reads. Across
runs it produced both outcomes, so a suite that contained it could not support any stable `x/x` claim.

The harness now takes a dev-only **`--frozen-now <ms>`** clock injection (mock mode only, refused
otherwise; documented in the [harness README](<../tests/acceptance/agent/README.md#L53-L80>) as a
testing aid), and the test uses it. The injection reaches only the runtime's own `now`: the harness's
transport still calls the product's `requestCompletion` without a `clock`, so the transport keeps
`Date.now`, while the deadline the runtime hands it is computed from the synthetic reading. Determinism
comes from that synthetic deadline staying far below any real timestamp (the option parser caps the
frozen reading and the deadline override at 9 digits each), so the transport's own
`start >= deadline` entry check is already true when it runs — not from a shared clock. The assertion is
**not** a weaker one — it still requires `status: ERROR`, `code: TIMEOUT`, `mock.requests: 0` (no request
was made) and `perStep[0].bytes: null` (no body was built); it simply no longer depends on how long the
process took.
`frozenNow` is published in the record so a frozen-clock run can never be mistaken for a real-timed one.
Evidence: the focused file passed **10/10** consecutive runs, and the full suite **3/3** runs.

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
Task 1 is docs-only and Task 2's limits code is covered by the full suite. The per-task narrative above
is corroborated by the execution ledger at
[`.superpowers/sdd/2026-10-04-sprint-2-agent-runtime/progress.md`](<../.superpowers/sdd/2026-10-04-sprint-2-agent-runtime/progress.md>)
(the per-task rulings, review verdicts and fix-round counts, next to the review diffs and the task
reports in the same directory); the reader should know that this path is **deliberately untracked**
(`.superpowers/sdd/.gitignore` contains `*`), so it does **not** travel with a clone and is not part of
the reviewed commit range. The **whole-branch final review** over `a9784e4..HEAD` has since been
performed; it is the review that found the uncertain-mutation defect fixed in `f0781d8`, and this
correction pass applies its documentation findings.

## What is NOT proven

### 1. Pilot workload calibration — NOT RUN

**Status:** the harness is built and reviewed; the **real run never happened.** The development endpoint
key lives in the DSH credential store (`OPENCUST_API_KEY`) and is **unreadable from this environment**,
so the harness cannot authenticate a real Qwen workload.

- The §15.2 numbers (`maxSteps`, `maxToolCalls`, batch sizes, per-step latency, context/result bytes,
  JSON-discipline and guardrail-reached counts) **do not exist**.
- **Mock records are not calibration data.** In `--mock` mode the fixed envelope yields exactly **one
  model step and zero tool calls** for all three workloads, and the elapsed ms is loop **overhead**, not
  model latency. The [harness README](<../tests/acceptance/agent/README.md#L139-L146>) states this, and
  mock mode proves the harness/transport/registry wiring only.
- What mock mode *does* demonstrate: the multi-step and repair accounting (`proposal` profile),
  a `LIMIT` with the named guardrail (`--max-steps 1`), a bounded per-request `TIMEOUT`, and an
  over-ceiling `BYTE_LIMIT` — all through the product's own `createRequest`/`requestCompletion`.
  The evidence is now a committed `node --test` artifact:
  [tests/acceptance/agent/dev-qwen-workloads.test.js](<../tests/acceptance/agent/dev-qwen-workloads.test.js>)
  drives three of the four mock profiles as child processes — `final`, `proposal` and `oversize`; the
  stalling `timeout` profile is deliberately excluded because it waits on wall-clock time — and all
  nine of the file's cases pass in the full suite (9/9), beside the documented commands in the
  [harness README](<../tests/acceptance/agent/README.md#L111-L119>).
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

- **`read_context` is WITHHELD, not delivered.** The descriptor stays in the repository but carries
  `policy: 'deny'`, so it is filtered out of both the EDIT and the ASK catalogue and a model-emitted
  `read_context` call is refused as a known tool error (design §6 `deny`: never offered, never
  executable). The reason is that **no confirmed public document read exists**: the installed build's
  SDK source copy has no `GetDocumentStructure`. The design's §10 context-tool table and §14
  representative-tool list keep the row as the design's intent and now mark it WITHHELD; the delivered
  representative toolset is the three offered tools. The design text is no longer read as shipping it.
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
  the uncertain outcome to an authored caption. On the insert path that outcome reached the UI for the
  THROWN bridge form, and the final-review fix `f0781d8` extended it to the RETURNED form, without any
  change to the UI behaviour itself. An acknowledged insert still reaches `COMPLETE`/`FINAL`, pinned by
  *"an acknowledged insert reaches COMPLETE/FINAL with the action ok and no write lock left held"* in
  [tests/integration/controller-bridge.test.js](<../tests/integration/controller-bridge.test.js>).
- **Constraint discovered — the audit is scope-insensitive.** After esbuild concatenation, two modules
  with same-named locals can produce a **spurious `DYNAMIC_PROPERTY`**. The remedy is **renaming in the
  colliding module, never weakening the audit**; a regression test now documents this. A security gate
  is not relaxed to accommodate authored code.
- **The `native-apply` suite no longer asserts the end-to-end `BYTE_LIMIT` status** for an over-limit
  model response (dropped when the blank-replacement case became unreachable through the UI). That
  end-to-end assertion is **GONE, not relocated**. The over-limit `BYTE_LIMIT` path stays pinned at the
  layers that remain reachable: the content-ceiling pins in
  [tests/unit/transport.test.js:70](<../tests/unit/transport.test.js#L70>) (`envelope cap is counted
  before accumulating or parsing, cancels reader, no extra read`) and
  [tests/unit/transport.test.js:77](<../tests/unit/transport.test.js#L77>) (`exact envelope cap succeeds
  and malformed/content/native-only/oversized responses reject`), the per-entry bound pins in
  [tests/unit/agent-protocol.test.js:119](<../tests/unit/agent-protocol.test.js#L119>)
  (`toolResultMessages bounds every single result, not only the batch total`) and
  [tests/unit/agent-protocol.test.js:188](<../tests/unit/agent-protocol.test.js#L188>) (`a tool result
  is bounded by its own serialization, never by the envelope that carries it`), and the controller's
  refusal path in [tests/unit/controller.test.js:217](<../tests/unit/controller.test.js#L217>)
  (`rejects UTF8 user/selection overflow without truncation or HTTP`).

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

- **PROVEN (host-side):** the bounded runtime's loop, batch dispatch, guardrails, Stop and deadline, the
  closed protocol, the bounded context window, the registry and policy, the representative Word tool
  descriptors/handlers behind the injected bridge, the UI lifecycle, and the static/bundle security
  audits — `604/604`, both audits PASS, per-task independent reviews with rework where needed. The
  runtime's **uncertain-mutation leg is in this list as of `f0781d8`**: the returned
  `APPLY_UNCERTAIN` insert outcome stops the run as `TOOL_UNCERTAIN`, and an acknowledged insert still
  reaches `FINAL` (pinned by the control test in
  [tests/integration/controller-bridge.test.js](<../tests/integration/controller-bridge.test.js>);
  see "What was proven after the final review").
- **FIXED AND RE-VERIFIED (was the final review's defect):** the uncertain-mutation outcome on the insert
  path — commit `f0781d8`; the withheld `read_context` is also no longer exported through
  `registry.tools`. No host-side defect from the final review remains open.
- **NOT RUN:** pilot workload calibration (§15.2) — no readable development key.
- **NOT RUN / BLOCKED:** the native R7 smoke (§15.3 / Task 12) — needs the user's authorization to use
  the local R7 install, the plugin installed, a disposable document, and the dev key or a trusted mock;
  the install itself is present.
- **DONE:** the whole-branch final review of `a9784e4..HEAD` has run; it found the uncertain-mutation
  defect now fixed by `f0781d8`, and its documentation findings are applied by this correction pass.
