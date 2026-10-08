# Sprint 8 T7 — `0.9.0-pilot-rc` artifact freeze

**Result: PASS for the artifact-identity and reproducibility boundary stated below.** The recorded artifacts were built from clean branch `stage-b` at release commit `6360dea5a784bfe804ecaa38d2bdee2fa2a757cc`. `git status --porcelain` was empty immediately before the release build and before/after each clean repeat build. Packaged `provenance.json` records that same full commit and product version `0.9.0-pilot-rc`.

## Frozen artifact set

| Artifact | SHA-256 |
| --- | --- |
| Plugin ZIP `dist/plugin/r7-ai-assistant.zip` | `9284f0de141d21cb6031e106f2bb3d87b27e15d940384ebbf1dd4be221a101f7` |
| DEB `dist/deb/r7-ai-assistant_0.9.0-pilot-rc_amd64.deb` | `cc83ddabcdb88c91373ebc812b2ccba18cf431fcba54d588d53346122dc72ea8` |
| SPDX 2.3 SBOM `dist/r7-ai-assistant.spdx.json` | `9e5c8becf2f3899e75227e5c142bcece4032cfc03797cfe47e8ee15a4dc713f7` |
| Packaged/built `panel.js` | `bacb29385578d52883ae13d02ca4ac21cf69c035c77ee91ab0c9fd0fc6250a1f` |

The tracked checksum manifest is `docs/evidence/sprint-8/SHA256SUMS`. Its format is the conventional text form `64 lowercase hexadecimal SHA-256 characters`, two spaces, then the repository-relative artifact path, one artifact per line. It covers the ZIP, DEB and SBOM. The generated `dist/` files remain intentionally untracked.

## Build commands and toolchain

The release set was generated with repository tooling, without a one-off version override:

```text
npm run build
npm run build:deb
npm run sbom
```

Recorded environment: Windows x64; Node `v24.21.0`; npm `11.19.0`; esbuild `0.25.10`.

## Reproducibility

`npm run reproducible` performed two clean plugin builds, validated packaged/standalone provenance equality, the full source commit, toolchain, and every payload hash. Results:

| Clean plugin build | ZIP SHA-256 | `provenance.json` SHA-256 |
| --- | --- | --- |
| 1 | `9284f0de141d21cb6031e106f2bb3d87b27e15d940384ebbf1dd4be221a101f7` | `8484068068654b33aecd02ce29c7c19b78b5cf52c7530679fef1293d2f563f21` |
| 2 | `9284f0de141d21cb6031e106f2bb3d87b27e15d940384ebbf1dd4be221a101f7` | `8484068068654b33aecd02ce29c7c19b78b5cf52c7530679fef1293d2f563f21` |

For the DEB, `dist/deb` was removed before each build, cleanliness was checked before and after each build, and `npm run build:deb` was run twice:

| Clean DEB build | SHA-256 |
| --- | --- |
| 1 | `cc83ddabcdb88c91373ebc812b2ccba18cf431fcba54d588d53346122dc72ea8` |
| 2 | `cc83ddabcdb88c91373ebc812b2ccba18cf431fcba54d588d53346122dc72ea8` |

The exact Sprint 7 boundary is retained: **byte-identical only for this exact commit, Node `v24.21.0`, esbuild `0.25.10`, and this Windows x64 platform.** Cross-OS, cross-architecture and different-toolchain reproducibility were not measured.

## Identity and archive verification

- The built `dist/plugin/panel.js` and the `panel.js` entry inside the ZIP both hash to `bacb29385578d52883ae13d02ca4ac21cf69c035c77ee91ab0c9fd0fc6250a1f`.
- All eight plugin payload files carried by the DEB were compared byte-for-byte with the corresponding ZIP entries; all eight matched.
- The SBOM was regenerated from the final ZIP. It parses as SPDX 2.3, names product version `0.9.0-pilot-rc`, records ZIP checksum `9284f0de...`, and all 9 archive entries were verified against the real archive bytes with no missing, extra or mismatched entry.
- As in Sprint 7, the DEB does **not** embed plugin `provenance.json`. Its hash can therefore remain stable when only ZIP `sourceCommit` provenance changes, while the ZIP hash moves with `sourceCommit`. This does not weaken the release rule: the whole set remains bound to one pinned commit.

## Frozen compatibility declaration

`packaging/compatibility.json` is present in the DEB at `/usr/share/r7-ai-assistant/compatibility.json`, and the shipped `/usr/bin/r7-ai-assistant-preflight` reads that path before activation. The exact supported tuple frozen in these artifacts is:

- Astra Linux SE `1.7.9`, build `1.7.9.41`, architecture `amd64`;
- package `r7-office`, package form `deb`, package version `2026.1.2-1942~astra-signed`, architecture `amd64`;
- R7 product version `2026.1.2.1942`, build `1942`;
- enforcement `shipped-preflight`; unsupported behavior `preflight-refuses-before-activation`.

## Sequencing and release identity

These hashes belong only to release commit `6360dea5a784bfe804ecaa38d2bdee2fa2a757cc`. The controller will add this freeze record and checksum manifest in a later commit. Because the ZIP embeds `sourceCommit`, rebuilding after that documentation commit will change ZIP provenance and ZIP/SBOM hashes. Therefore that later commit must **not** be described as this release unless the ZIP, DEB, SBOM and checksum manifest are rebuilt, re-recorded and re-tested under the new commit. Native acceptance must identify and use the exact hashes above for this frozen set.

## Not verified by T7

T7 did not touch the stand or perform native install, activation/load, Word/Cell/Slide journeys, upgrade/settings preservation, uninstall/product-only cleanup, unsupported-target execution, ZPS, system-wide paths, non-declared tuples, plugin-ZIP stand lifecycle, publication, tagging, or cross-platform/toolchain reproducibility. Those remain governed by the Sprint 8 acceptance evidence and consolidated limitations.
