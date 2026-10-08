# Sprint 8 — Final verification / `0.9.0-pilot-rc`: plan (T1–T8)

**Status: AUTHORIZED (2026-10-08).** Executed autonomously; the owner is asked only on a real blocker or an
architectural choice. Authoritative upstream scope: [product roadmap to 0.9.0-pilot-rc](../product-roadmap-to-0.9.0-pilot-rc.md)
(SPRINT 8) and [roadmap](../../roadmap.md) row 8. Carried in from Sprint 7: the stage closed as ACCEPTED WITH
RECORDED LIMITATIONS, whose `NOT VERIFIED` list (ZPS, unsupported tuples, system-wide path, plugin-ZIP stand
lifecycle, future upgrade bytes) still stands unless this stage measures the opposite.

## Goal

Turn the verified pilot build into a releasable `0.9.0-pilot-rc`: no release-blocking defect, real Word/Cell/Slide
workflows proven on the target, security reviewed, documentation and known limitations complete, and a final artifact
set whose TESTED bytes are provably the SHIPPED bytes. Publication itself is out of scope and needs the owner.

## Hard constraints

* `main` is not touched; no merge, no tag, no publication, no release without explicit permission.
* Fix only defects that block the release; anything else is recorded, not "fixed while we are here".
* Never disable or weaken a protection (ZPS, TLS verification) to obtain a result; unproven stays `NOT VERIFIED`.
* Reuse the Sprint 7 packaging rules: data-only DEB, per-user activation on the verified path, fail-closed
  compatibility preflight, no daemon/listener/Node/MCP/bridge/keys/endpoint, reproducibility boundary as declared.

## Tasks

| # | Task | Deliverable | Acceptance for the task |
| --- | --- | --- | --- |
| **T1** | Release contract and inventory: what `0.9.0-pilot-rc` ships, the exact artifact list, the version-freeze rule, and the rule that makes tested == shipped for a ZIP whose hash moves with its recorded commit | `docs/superpowers/plans/2026-10-08-sprint-8-release-contract.md` | The inventory and the freeze rule are stated so the release commit can be pinned unambiguously |
| **T2** | Release-blocking defect sweep: triage every known limitation and open defect, decide release-blocking or not, and fix only the blockers | triage report + fixes | Each item has a decision and a reason; no silent "fix it on the way" |
| **T3** | Native acceptance A - install and Word: install the final artifacts on the target and run the Word workflow end to end | acceptance evidence | Installation and the Word journey measured, not described |
| **T4** | Native acceptance B - Cell and Slide: the same for spreadsheet and presentation, including the Cell journey that Sprint 6 could not prove natively | acceptance evidence | Both journeys measured; anything unreachable is recorded with its symptom |
| **T5** | Security review: direct HTTPS only, tool policies and Preview/Apply boundary, credential handling, artifact contents, no secret or key material, no unexpected network surface | security review report | Findings triaged with severity; no critical or blocking issue left open |
| **T6** | Documentation and known limitations: user and administrator documentation, changelog, licensing, deployment, and one honest consolidated limitations list | updated docs | Every documented command and path matches a measured artifact |
| **T7** | Tested == shipped identity for the final RC: build the release artifacts from the pinned commit, record ZIP, DEB and SBOM hashes and checksums together, re-verify reproducibility, and reconcile the evidence set | final inventory + checksums | Byte identity between the tested and the shipped set, with the boundary stated |
| **T8** | Independent acceptance and code review, then the stage exit gate | review outcome | An independent reviewer confirms the exit gate on the final bytes |

## Exit gate

1. The final artifacts install on the target with genuine package tooling, and no release-blocking defect remains open.
2. Real Word, Cell and Slide workflows pass on the target, or an unreachable one is recorded with its measured symptom.
3. Security review is complete with no critical or blocking finding; protections were never disabled to get a result.
4. Documentation is complete, executable as written, and its known-limitations list matches reality.
5. TESTED == SHIPPED: the release artifacts come from the pinned commit, their hashes are recorded together with the
   SBOM, and a repeat build reproduces them within the declared boundary.
6. The independent acceptance and code review agree, and every `NOT VERIFIED` item carried from Sprint 7 either got
   measured or stays explicitly `NOT VERIFIED` in the release documentation.

## Out of scope

Publication, tagging, `main`, release notes distribution, any Bank/TLS/CORS/AUTH/Qwen acceptance that the roadmap
keeps as NOT RUN, and any change to the Agent Runtime, Tool Registry, bridge or limits that a release defect does not
justify.
