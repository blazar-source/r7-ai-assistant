# Roadmap

## Accepted eight product sprints

**Sprint 2 is the currently authorized sprint** (authorized by direct user instruction — see the [Sprint 2 design](<superpowers/specs/2026-10-04-sprint-2-agent-runtime-design.md>) status line; passing the Sprint 1 gates is not what authorized it). Sprint 1's Stage B execution keeps its own recorded status below. Task 1 is done, Task 2 measured DEV probe gives prerequisite GO with N09 branch PARTIAL, and Task 3 cb291d7 Apply implementation is independently reviewed/completed. [Current evidence and limits](<sprint-1-progress.md>) record Task 4 IN PROGRESS with scoped R10–R17 candidate native evidence and remaining gates, not whole Task 4 / Stage B PASS; no production deployment is inferred. The [historical Stage B NOT PASS](<stage-b-gate-report.md>) is not retroactively PASS. The [Sprint 1 execution plan](<superpowers/plans/2026-10-02-sprint-1-practical-selection-editing.md>) and [amended accepted design](<superpowers/specs/2026-10-02-compatibility-vertical-slice-design.md>) define the current contract.

| Sprint | Accepted product scope | Execution status |
| --- | --- | --- |
| 1 | Practical B selection: Preview, explicit Apply, same current document/editor check, current nonempty selection reread and exact original-text comparison, public native replacement, measured formatting and native Undo; close remaining small B checks | Task 1 done / Task 2 prerequisite GO / Task 3 implementation reviewed; Task 4 IN PROGRESS / scoped R10–R17 candidate native measured / remaining gates explicit / whole Stage B NOT PASS |
| 2 | Generic bounded Agent Runtime + extensible Tool Registry + per-tool execution policy (`auto`/`confirm`/`deny`), calibrated on Word/Excel/PowerPoint pilot workloads, with real development Qwen calls; see the [Sprint 2 design](<superpowers/specs/2026-10-04-sprint-2-agent-runtime-design.md>) | Generic bounded Agent Runtime, tool registry and per-tool policy **IMPLEMENTED** and independently reviewed (host-verified `603/603`, source + bundle audit PASS), with a **reduced representative toolset of exactly three tools** — `read_selection` (auto), `insert_paragraph` (auto), `replace_selection` (confirm); `read_context` is **WITHHELD** (`policy: 'deny'`) because no public document read is confirmed, so the full catalogue is not claimed. Pilot workload calibration **NOT RUN** — the development key is unreadable from this environment, so §12.2 keeps its initial engineering defaults. Minimal native R7 smoke **NOT RUN / BLOCKED** — no live plugin session; closing it needs the user's explicit authorization to run against the local R7-Office 2026.3.1 install, this plugin build installed, and a disposable document. The whole-branch final review HAS RUN and found that the runtime's uncertain-mutation leg was not enforced on the insert path; that defect is **FIXED AND RE-VERIFIED** in `f0781d8`, so the three-case error model is proven for the insert path (an acknowledged insert still reaches `FINAL`); see [Sprint 2 progress](<sprint-2-progress.md>) |
| 3 | Word tools | NOT AUTHORIZED / NOT RUN |
| 4 | Cell tools | NOT AUTHORIZED / NOT RUN |
| 5 | Slide tools | NOT AUTHORIZED / NOT RUN |
| 6 | Common UX and security hardening | NOT AUTHORIZED / NOT RUN |
| 7 | Packaging, Astra install/upgrade/uninstall and separate ZPS compatibility state | NOT AUTHORIZED / NOT RUN |
| 8 | Verified local `0.9.0-pilot-rc` deliverables | NOT AUTHORIZED / NOT RUN; no publication |

The previous A–M lettering is historical sequencing, not current execution authorization. The [original Stage B plan](<superpowers/plans/2026-10-02-stage-b-implementation.md>) is archived with its measured completed/unchecked steps intact. Sprint 2 is authorized by direct user instruction (recorded in the [Sprint 2 design](<superpowers/specs/2026-10-04-sprint-2-agent-runtime-design.md>) status line), not by Sprint 1's gates; sprints 3–8 are not authorized. See [Sprint 2 progress](<sprint-2-progress.md>) for its execution status.

## Stage boundaries and escalation

After each authorized sprint: tests/evidence, independent scoped review, atomic local commits and clean working tree. No merge/push/publication. Host tests and package inspection do not prove native compatibility. Bank TLS/CORS/AUTH/Qwen remain **NOT RUN** until internal bank installation; no real-model calls in Sprint 1.

On runtime FAIL, record the exact public API, scenario and observed failure; search targeted ready solutions in official docs/GitHub/issues/PR/plugins and check architecture/license. If several practical alternatives exist, give brief pros/cons and a recommendation. If none exists, notify the user and request permission **before** narrow blocker research. No broad precautionary research or silent architecture/security relaxation. Stop for secrets/admin user action or data-loss risk; never restore a clean checkpoint over active work.

Later separate scope: managed settings, locked endpoint/model, centralized key provisioning, roles/group policies and corporate deployment integration. The configuration-provider boundary avoids agent runtime rewrite; none is authorized now.
