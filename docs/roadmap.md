# Roadmap

## Accepted eight product sprints

Only **Sprint 1 is authorized**. Task 1 is done, Task 2 measured DEV probe gives prerequisite GO with N09 branch PARTIAL, and Task 3 cb291d7 Apply implementation is independently reviewed/completed. [Current evidence and limits](<sprint-1-progress.md>) keep Task 4 integrated native acceptance NOT RUN on this candidate; no deployment is inferred. The [historical Stage B NOT PASS](<stage-b-gate-report.md>) is not retroactively PASS. The [Sprint 1 execution plan](<superpowers/plans/2026-10-02-sprint-1-practical-selection-editing.md>) and [amended accepted design](<superpowers/specs/2026-10-02-compatibility-vertical-slice-design.md>) define the current contract.

| Sprint | Accepted product scope | Execution status |
| --- | --- | --- |
| 1 | Practical B selection: Preview, explicit Apply, same current document/editor check, current nonempty selection reread and exact original-text comparison, public native replacement, measured formatting and native Undo; close remaining small B checks | Task 1 done / Task 2 prerequisite GO / Task 3 implementation reviewed; Task 4 pending, integrated candidate native NOT RUN |
| 2 | Bounded agent runtime + Qwen development validation | NOT AUTHORIZED / NOT RUN |
| 3 | Word tools | NOT AUTHORIZED / NOT RUN |
| 4 | Cell tools | NOT AUTHORIZED / NOT RUN |
| 5 | Slide tools | NOT AUTHORIZED / NOT RUN |
| 6 | Common UX and security hardening | NOT AUTHORIZED / NOT RUN |
| 7 | Packaging, Astra install/upgrade/uninstall and separate ZPS compatibility state | NOT AUTHORIZED / NOT RUN |
| 8 | Verified local `0.9.0-pilot-rc` deliverables | NOT AUTHORIZED / NOT RUN; no publication |

The previous A–M lettering is historical sequencing, not current execution authorization. The [original Stage B plan](<superpowers/plans/2026-10-02-stage-b-implementation.md>) is archived with its measured completed/unchecked steps intact. Passing the current Sprint 1 gates does not itself authorize Sprint 2.

## Stage boundaries and escalation

After each authorized sprint: tests/evidence, independent scoped review, atomic local commits and clean working tree. No merge/push/publication. Host tests and package inspection do not prove native compatibility. Bank TLS/CORS/AUTH/Qwen remain **NOT RUN** until internal bank installation; no real-model calls in Sprint 1.

On runtime FAIL, record the exact public API, scenario and observed failure; search targeted ready solutions in official docs/GitHub/issues/PR/plugins and check architecture/license. If several practical alternatives exist, give brief pros/cons and a recommendation. If none exists, notify the user and request permission **before** narrow blocker research. No broad precautionary research or silent architecture/security relaxation. Stop for secrets/admin user action or data-loss risk; never restore a clean checkpoint over active work.

Later separate scope: managed settings, locked endpoint/model, centralized key provisioning, roles/group policies and corporate deployment integration. The configuration-provider boundary avoids agent runtime rewrite; none is authorized now.
