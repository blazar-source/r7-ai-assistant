# Sprint 7 — Packaging, Astra and ZPS compatibility: plan (T1–T8)

**Status: AUTHORIZED FOR PLANNING (2026-10-08).** The plan below is fixed; implementation starts after this fixation
and proceeds task by task. Authoritative upstream scope: [product roadmap to 0.9.0-pilot-rc](../product-roadmap-to-0.9.0-pilot-rc.md)
(SPRINT 7) and [roadmap](../../roadmap.md) row 7.

## Goal

Turn the development plugin into a **verifiable product**: a plugin package and an Astra DEB with a proven
install / upgrade / uninstall lifecycle, a reproducible build, an SBOM, and Astra/ZPS compatibility evidence that
never overstates what was measured.

## Decisions fixed before implementation (owner, 2026-10-08)

1. **Install path.** The **per-user** plugin location is the supported target. This session established, on Astra
   2026.3.1, that the page loads `~/.local/share/r7-office/editors/sdkjs-plugins/{GUID}` and does **not** load
   `…/editors/data/sdkjs-plugins/asc.{GUID}`. A system-wide (global) path is therefore **NOT VERIFIED** and must not
   be guessed: it may only be claimed after a separate measurement on the acceptance target.
2. **Version string.** `0.9.0-pilot-rc` is the **Sprint 8** release string and stays reserved for the published RC.
   Because [deployment.md](../../deployment.md) states that no installable release exists yet and bootstrap must not
   be treated as Pilot RC, every artifact built during Sprint 7 carries a development-marked version with recorded
   provenance (source commit plus toolchain versions) and is **never published**.
3. **Acceptance target.** Native lifecycle and ZPS acceptance run on the **R7 `2026.1.2.1942` (deb)** target recorded
   in [target-environment.md](../../target-environment.md). The Sprint 6 path evidence from 2026.3.1 is supporting
   evidence only; the install path is re-verified on 1942 in T1 and again in T6.
4. **ZPS.** T7 opens with a bounded feasibility probe of the stand's trust/signing. If no working mechanism can be
   established, ZPS is recorded **NOT VERIFIED** — the protection mechanism is never disabled or bypassed to obtain
   a PASS.

## Non-negotiable constraints (from deployment.md and the roadmap)

* The DEB is **data-only**: no daemon, no listener, no Node, no MCP server, no TCP/WebSocket bridge, no keys and no
  user endpoint. Static assets only, no CDN.
* Uninstall removes **product-owned files only**. Upgrade **preserves** user settings and data, and **rejects an
  incompatible target safely** (no partial install, no vendor file touched).
* Never modify vendor installation files opportunistically; never substitute ONLYOFFICE documentation for R7 runtime
  evidence.
* Clean-install acceptance starts from the preserved `02-astra-r7-clean` snapshot in a separate safe state; never
  restore over unsaved work.
* No development toolchain is required by end users.

## Tasks

| # | Task | Deliverable | Acceptance for the task |
| --- | --- | --- | --- |
| **T1** | Packaging contract: product-owned file manifest, GUID and per-user paths, the R7 version compatibility rule, the artifact inventory, and the re-verification of the install path on 1942 | `docs/superpowers/plans/2026-10-08-sprint-7-packaging-contract.md` | Manifest and paths are stated as verified facts with the command that proved each |
| **T2** | Plugin package: deterministic ZIP with an in-package **provenance manifest** (source commit, node and esbuild versions, per-file hashes) plus the version/compatibility gate | `dist/plugin` + manifest + SHA-256 | Two builds of the same commit produce the same hash; the manifest describes the shipped bytes |
| **T3** | SBOM and third-party notices: generate SPDX or CycloneDX from the pinned toolchain and the zero runtime dependencies; reconcile `THIRD_PARTY_NOTICES.md` and [licensing.md](../../licensing.md) | SBOM file + reconciliation report | The SBOM matches the actual payload, and "no runtime dependencies" is checked, not asserted |
| **T4** | Reproducible build: two clean builds from one commit produce **byte-identical** artifacts; declare the reproducibility boundary and what is excluded | Rebuild report + verification script | Equal hashes recorded, with the exact toolchain versions |
| **T5** | DEB (data-only): control files, install layout on the verified path, uninstall manifest, no daemon/Node/MCP/bridge/keys | `packaging/deb/` + built `.deb` | `dpkg-deb -c` inventory shows only product-owned files |
| **T6** | Lifecycle: clean install, upgrade preserving user settings, uninstall removing only product-owned files, safe refusal on an incompatible target | Lifecycle reports on the preserved Astra snapshot | Each of the four scenarios is measured end to end |
| **T7** | Astra compatibility matrix and ZPS: supported versions PASS, unsupported refused safely; ZPS with the mechanism **enabled**, else `NOT VERIFIED` | Compatibility and ZPS reports | No state is marked PASS without its own measurement |
| **T8** | Deployment documentation: verified install path, upgrade and uninstall procedure, where user settings live, known limitations, evidence index | Updated [deployment.md](../../deployment.md) | Every documented path and command matches a measured artifact |

## Exit gate

1. Plugin ZIP and DEB are built from **one commit** and both hashes are recorded.
2. A **repeat build reproduces the same hashes**; the reproducibility boundary is stated explicitly.
3. The SBOM is consistent with the real payload, and the zero-runtime-dependency claim is verified.
4. Clean install works on the prepared Astra target; **upgrade preserves** user settings; **uninstall** leaves user
   data intact and no product-owned file behind.
5. Inspection confirms **no** daemon, listener, Node, MCP, bridge or key material (processes, ports, file inventory).
6. R7 version compatibility: supported versions PASS, unsupported versions are **refused safely**.
7. ZPS with the protection mechanism **enabled** is either PASS or an explicit `NOT VERIFIED`; disabling the
   mechanism to obtain a PASS is forbidden.
8. **Tested build == shipped build** (hash equality), with an independent review of the artifacts and the evidence.

## Out of scope for Sprint 7

* Release publication, tags, checksum publishing and the final RC package — that is Sprint 8.
* Any change to the Agent Runtime, Tool Registry, bridge or limits: Sprint 7 is packaging and deployment only.
* A system-wide install path claim without a separate measurement.
* Any Bank/TLS/CORS/AUTH/Qwen acceptance, which remains NOT RUN per the roadmap.

## Honest limitations carried into Sprint 7

Sprint 6 closed as ACCEPTED WITH PLATFORM-EVIDENCE LIMITATIONS; its four unproven native items
(Windows Cell journey, Astra Word/Cell pixel screenshot, Astra focus-ring pixels, rendered UX-B5 stages) are recorded
in [the T6 evidence](../../evidence/sprint-6/t6-native-ux-acceptance.md) and are not reopened by this stage.
