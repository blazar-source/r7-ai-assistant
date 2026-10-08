# Sprint 8 release contract — `0.9.0-pilot-rc`

**Status:** T1 contract, 2026-10-08. This document defines the local release candidate that Sprint 8 may accept. It does not publish, tag, merge, or authorize use of `main`.

Authoritative scope: [Sprint 8 final-verification plan](2026-10-08-sprint-8-final-verification.md) and the [product roadmap, Sprint 8](../../product-roadmap-to-0.9.0-pilot-rc.md#sprint-8--final-verification--090-pilot-rc). The measured predecessor is the [Sprint 7 closure](2026-10-08-sprint-7-packaging-astra-zps.md#closure-2026-10-08), particularly its [final artifact inventory](../../evidence/sprint-7/final-artifact-inventory.md).

## 1. Release boundary and exact artifact set

`0.9.0-pilot-rc` is a **local, immutable release set**, not merely a source revision or a pair of binaries. It ships exactly the following classes of deliverable from one pinned release commit:

| Shipped item | Canonical production location | How it is produced | Required verification before acceptance |
| --- | --- | --- | --- |
| Plugin ZIP | `dist/plugin/r7-ai-assistant.zip` | `npm run build` / `scripts/build-plugin.mjs`; deterministic STORE ZIP containing the eight plugin payload files plus `provenance.json` | Clean-tree build at the pinned release commit; provenance `sourceCommit`, product version, Node/esbuild versions and every payload hash match the archive; two clean builds are byte-identical; SHA-256 is recorded; Sprint 8 native acceptance identifies these bytes. Sprint 7 proved the mechanism and boundary, not the RC hash: [T4 reproducibility](../../evidence/sprint-7/t4-reproducible-build.md#declared-reproducibility-boundary). |
| Astra data-only DEB | `dist/deb/r7-ai-assistant_0.9.0-pilot-rc_amd64.deb` | `npm run build:deb` / `scripts/build-deb.mjs`; inert plugin payload, compatibility declaration, product-owned-files manifest and preflight, with no maintainer scripts | `dpkg-deb -I/-c`, SHA-256 and two clean byte-identical builds; genuine install, exact-tuple preflight, per-user activation/load, upgrade/settings-preservation check, uninstall/product-only cleanup and unsupported-target fail-closed refusal on the target. The RC bytes, not Sprint 7's development DEB, must be measured. Precedent: [Sprint 7 final lifecycle](../../evidence/sprint-7/final-artifact-reconciliation.md#2026-10-08-closure-bumped-version-upgrade-on-exact-final-bytes). |
| SPDX 2.3 SBOM | `dist/r7-ai-assistant.spdx.json` | `npm run sbom` / `scripts/generate-sbom.mjs`, from the final plugin ZIP | Parse successfully; product/version and ZIP checksum match the final ZIP; every archived file and SHA-256 matches; zero runtime dependencies and declared build tools are checked; SHA-256 is recorded. Sprint 7 boundary: [final inventory](../../evidence/sprint-7/final-artifact-inventory.md#L19). |
| Checksums | `dist/SHA256SUMS` (or the T7-selected tracked release-manifest name, fixed before final acceptance) | Generated only after the release commit is pinned and the final ZIP, DEB and SBOM exist | Contains exact relative names and SHA-256 values for all three binary/generated artifacts; verified by recomputation in a clean checkout and recorded verbatim in the final tracked inventory. It is regenerated whenever any listed artifact changes. |
| User documentation | `README.md`, `CHANGELOG.md`, and the user-facing operation/limitations sections referenced by them | Updated in Sprint 8 T6 from measured RC behavior | Every version, command, path, supported workflow, refusal and known limitation agrees with final native acceptance and final hashes; no development artifact is called RC. |
| Administrator documentation | `docs/deployment.md`, `docs/compatibility-matrix.md`, `docs/licensing.md`, `docs/security.md`, `THIRD_PARTY_NOTICES.md` | Updated/reconciled in T6 against the RC package inventory and security review | Commands execute as written against the RC names; supported tuple/path and data-only boundary match package inspection and target measurements; licensing/SBOM/notices reconcile; one explicit known-limitations list contains every remaining `NOT VERIFIED` item. |
| Acceptance and review evidence | Tracked reports under `docs/evidence/sprint-8/`, including T2 triage, Word/Cell/Slide native acceptance, security review, documentation/limitations reconciliation, final artifact inventory/checksums/reproducibility, and independent acceptance/code review | Written from Sprint 8 T2–T8 measurements against the final release set | Each report names the pinned release commit and artifact hashes it covers (or clearly states it is source-only); the final inventory links every report and resolves contradictions/superseded attempts. No ignored `.local/` receipt is the sole release claim. |

`dist/` is intentionally ignored by Git (`.gitignore`); therefore the generated files are not preserved by a source commit alone. The **tracked Sprint 8 final inventory and evidence index** are the durable record of artifact names, sizes/hashes, producing commands, toolchain, release commit and acceptance results. Operators receive the generated artifacts together with that tracked documentation set; reconstructing an unrecorded `dist/` directory is not the release.

## 2. Version freeze

The release version is exactly `0.9.0-pilot-rc`. Today the build still carries Sprint 7's `0.9.0-pilot-dev` in:

* `package.json` and both root records in `package-lock.json`;
* `scripts/build-plugin.mjs` (`PRODUCT_VERSION`, therefore ZIP `provenance.json`);
* `scripts/build-deb.mjs` (default `VERSION`, therefore DEB control metadata and filename; the environment override is not the release source of truth);
* `scripts/generate-sbom.mjs` (`PRODUCT_VERSION`, therefore SPDX name, namespace, package version and validation);
* version assertions in `tests/integration/package.test.js` and `tests/packaging/deb-package.test.js`;
* development-state documentation including `docs/deployment.md`, `docs/licensing.md`, and `packaging/plugin/README.md`.

Sprint 7 intentionally reserved `0.9.0-pilot-rc` for this stage and shipped only development-marked bytes: [Sprint 7 decision 2](2026-10-08-sprint-7-packaging-astra-zps.md#decisions-fixed-before-implementation-owner-2026-10-08) and [inventory](../../evidence/sprint-7/final-artifact-inventory.md).

**Freeze rule:** T6/T7 must replace the production/build metadata above with one consistent `0.9.0-pilot-rc` value, update its assertions and user/admin wording, and commit those changes before the release commit is pinned. No RC artifact may be built by supplying a one-off environment version that disagrees with the committed defaults, and this T1/T2 task changes none of those files.

## 3. TESTED == SHIPPED for both artifacts

Sprint 7 established an important asymmetry: the ZIP embeds `provenance.sourceCommit`, so a later commit changes ZIP/provenance (and normally SBOM) bytes; the DEB excludes `provenance.json`, so a source-commit-only documentation change can leave the DEB byte-stable. See [Sprint 7 final inventory, lines 15–17](../../evidence/sprint-7/final-artifact-inventory.md#L15-L17).

The RC freeze procedure is therefore:

1. Complete every intended source, version and documentation change, obtain a clean tree, and pin the full **release commit**.
2. In a clean checkout of exactly that commit and the declared toolchain, build ZIP and DEB, generate the SBOM, then generate checksums. Confirm ZIP provenance names that release commit.
3. Record release commit, toolchain, filenames and hashes together in the tracked Sprint 8 final inventory.
4. Install and run native acceptance/security checks on those exact ZIP/DEB bytes (transfer-side hashes must equal the inventory), and bind every report to them. For the separately distributed ZIP, exercise its documented stand lifecycle or otherwise do not ship it.
5. Rebuild twice from the same pinned commit and verify byte equality within the declared boundary; recompute SBOM/checksums and reconcile the complete set.
6. After this point, **no later commit may be described as this release**. A documentation-only commit still changes the release commit and therefore the provenance-bearing ZIP: either rebuild, retest as required, and re-record the entire set under the new commit, or leave the previously pinned commit and bytes as the sole RC.

The DEB's possible byte stability across later commits does not exempt it from this rule: release identity is the tuple **(pinned commit, ZIP hash, DEB hash, SBOM hash, checksum manifest, acceptance evidence)**, not an individual unchanged hash.

## 4. Release-blocking definition

An item is **release-blocking** when at least one of these is true for a shipped artifact, supported tuple or promised core workflow:

1. it can cause document/data/settings loss or unintended mutation, security/privacy exposure, protection bypass, secret inclusion, unexpected network/runtime surface, or removal/modification of non-product files;
2. install, compatibility preflight, activation/load, upgrade, uninstall, or a promised Word/Cell/Slide journey fails on the declared target, or cannot reach a safe terminal state;
3. unsupported/incompatible input is accepted or mutates instead of failing closed;
4. the final RC version/inventory/provenance/SBOM/checksums are inconsistent, generated bytes are not reproducible within the declared boundary, or TESTED bytes cannot be identified as the SHIPPED bytes;
5. a critical/blocking security or independent-review finding remains open, or required operator instructions would make safe installation/use impossible.

A **recorded limitation is not a blocker** when shipped behavior remains fail-closed or safely bounded, the configuration/workflow is outside the explicitly supported release boundary, and the limitation plus its measured symptom and operator consequence is visible in final documentation. Missing proof alone is not automatically a defect. However, missing proof of a required Sprint 8 exit-gate fact (final target install, final Word/Cell/Slide journeys, security review, or final byte identity) must be **measured in this stage**; it becomes blocking if measurement reveals a real defect or if the release continues to claim/ship an unverified path.

Only blockers may be fixed in Sprint 8. Measurements and documentation do not authorize changes to the Agent Runtime, Tool Registry, bridge or limits.

## 5. Explicitly excluded

The local RC does **not** include or authorize:

* publication or distribution through a public/internal channel, checksum publication, release-note distribution, a Git tag, merge to or modification of `main`, or any release action requiring owner permission;
* the test-only `0.9.0-pilot-dev.1` upgrade fixture or any arbitrary future upgrade package;
* a system-wide plugin path, unsupported Astra/R7/architecture tuple, or a ZPS-enabled claim unless separately measured and promoted;
* Bank TLS/CORS/AUTH/Qwen acceptance. Those roadmap items remain **NOT RUN** until internal bank installation; public catalogue presence, OpenRouter development runs, controlled HTTPS fixtures, `TIMEOUT`, or `HTTP_ERROR` do not substitute for them;
* any change to Agent Runtime, Tool Registry, bridge or limits, except a separately established release blocker under this contract (none is authorized by T1/T2).
