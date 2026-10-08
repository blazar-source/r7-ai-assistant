# Sprint 8 T7 — `0.9.0-pilot-rc` artifact freeze

## Current re-freeze — capability-fix commit `dc93242fe45811b4aad0a371200765b335302ce1`

**Result: PASS for artifact identity and reproducibility.** `git status --porcelain` was empty immediately before the repository-tooling build on branch `stage-b`, HEAD `dc93242fe45811b4aad0a371200765b335302ce1`. Packaged `provenance.json` names that full commit, product version `0.9.0-pilot-rc`, Node `v24.21.0`, and esbuild `0.25.10`; npm was `11.19.0`.

| Current frozen artifact | SHA-256 |
| --- | --- |
| Plugin ZIP `dist/plugin/r7-ai-assistant.zip` | `1eba90a54aa36566f05a510f2cec88983121639f8101ced1cce4c35a342ca474` |
| DEB `dist/deb/r7-ai-assistant_0.9.0-pilot-rc_amd64.deb` | `9eb7233f0b8aa76a9f973d4cc63de22e1653df3f4ba7eeb8f4cf45972a54304b` |
| SPDX 2.3 SBOM `dist/r7-ai-assistant.spdx.json` | `3dd84b70e21bef72dd6402e52c6d459e16a28994aaef87612be9a8c86158d243` |
| Packaged/built `panel.js` | `470b3a342a7b0a64d8ab566e2012bce6c31f735674972405051eab8e51e5e596` |

`npm run reproducible` produced the same ZIP twice. Two builds after independently removing `dist/deb` produced the same DEB hash. The regenerated SBOM matched all nine real ZIP entries with no missing, extra, or mismatched entry. Genuine target-side `dpkg-deb` extraction and comparison found all eight DEB plugin files byte-identical to the ZIP. The DEB hash changed from `4b54302a...` because the capability fix changed carried product bytes (`panel.js`); the DEB continues not to embed plugin provenance.

Raw receipts: `.local/sprint8/dc93242/refreeze-build.log`, `reproducibility.log`, `sbom-archive-verify.json`, `install-fixed.log`, and `initial-hashes.txt`.

## Previous current re-freeze — superseded history — commit `2e64c0ef019b3ef985163a4eb9434ea298265cee`

**Result: PASS for artifact identity and reproducibility.** `git status --porcelain` was empty immediately before the repository-tooling build at branch `stage-b`, HEAD `2e64c0ef019b3ef985163a4eb9434ea298265cee`, and remained empty after the build and both repeat builds. Packaged `provenance.json` names that full commit, product version `0.9.0-pilot-rc`, Node `v24.21.0`, and esbuild `0.25.10`.

| Current frozen artifact | SHA-256 |
| --- | --- |
| Plugin ZIP `dist/plugin/r7-ai-assistant.zip` | `5c6edba48421229dc2012ce170aaf2e48a887a19e2957de6d79e566d16ce0f79` |
| DEB `dist/deb/r7-ai-assistant_0.9.0-pilot-rc_amd64.deb` | `4b54302a747fac03c0af1c39099ca7791357f6fe2a5d56e940c1fb5f69e9122a` |
| SPDX 2.3 SBOM `dist/r7-ai-assistant.spdx.json` | `93f034aa511f6ed01a95823bdb6d6a80598e1a8fc8a77e440a749c03ed4badbd` |
| Packaged/built `panel.js` | `bacb29385578d52883ae13d02ca4ac21cf69c035c77ee91ab0c9fd0fc6250a1f` |

`npm run reproducible` produced the same ZIP twice at this commit. Two builds after independently removing `dist/deb` produced the same DEB hash. The DEB hash is unchanged from the previous corrected set (`4b54302a...`) because the DEB deliberately excludes plugin `provenance.json`; the ZIP embeds `sourceCommit`, so the ZIP and the ZIP-derived SBOM changed. The regenerated SPDX 2.3 SBOM was checked against all nine real ZIP entries: no missing, extra, or mismatched entry. All eight plugin files carried by the DEB matched their corresponding ZIP entries byte-for-byte. Genuine target-side `dpkg-deb -c` shows `panel.js` directly at `./usr/share/r7-ai-assistant/plugin/panel.js`, not below a GUID directory.

Raw receipts are under `.local/sprint8/`: `refreeze-build.log`, `reproducibility.log`, `sbom-archive-verify.json`, `deb-zip-identity.txt`, and `dpkg-archive-current.txt`.

## Earlier corrected re-freeze — superseded history

**Result: PASS for the corrected artifact-identity and reproducibility boundary.** Native acceptance proved that the original DEB installed its eight payload files under `/usr/share/r7-ai-assistant/plugin/{7C91D48E-5F12-4B36-8A90-2DFA8467C013}/`. The documented activation destination is already the brace-GUID directory, so that package shape could produce a nested brace-GUID directory rather than `panel.js` at the path R7 loads. The package was the wrong side of the contract: the corrected DEB places the eight files directly under `/usr/share/r7-ai-assistant/plugin/`, and the documented `cp -a "/usr/share/r7-ai-assistant/plugin/." "$TARGET/"` now lands them directly in the verified destination. A packaging regression test pins this source-to-destination result.

These re-frozen hashes belong to source commit `96fe82a93c38fa25b949bc27ded3ca7e77f232e3` plus the uncommitted re-freeze patch that the controller will commit; no commit or push was performed here. Because the ZIP provenance records `96fe82a93c38fa25b949bc27ded3ca7e77f232e3`, the controller must either commit without rebuilding and preserve this exact release identity statement, or rebuild/re-record under the resulting commit before describing that later commit as the release.

| Re-frozen artifact | SHA-256 |
| --- | --- |
| Plugin ZIP `dist/plugin/r7-ai-assistant.zip` | `4356915881a61f0d6c10ea6053e53cbb98d3a0649c100f523a86e877522bb773` |
| DEB `dist/deb/r7-ai-assistant_0.9.0-pilot-rc_amd64.deb` | `4b54302a747fac03c0af1c39099ca7791357f6fe2a5d56e940c1fb5f69e9122a` |
| SPDX 2.3 SBOM `dist/r7-ai-assistant.spdx.json` | `cad282af49bc46182415f7762966e1c88f6a89dc0bdac836bf944ccda6acb278` |
| Packaged/built `panel.js` | `bacb29385578d52883ae13d02ca4ac21cf69c035c77ee91ab0c9fd0fc6250a1f` |

Two clean plugin builds both produced ZIP `4356915881a61f0d6c10ea6053e53cbb98d3a0649c100f523a86e877522bb773` and provenance `9b4223e2d3fa82c684517dada290974281f0eaa4da3b02623995a2e27336962b`. Two DEB builds after removing `dist/deb` both produced `4b54302a747fac03c0af1c39099ca7791357f6fe2a5d56e940c1fb5f69e9122a`. All eight DEB payload files matched the ZIP byte-for-byte, and all nine SBOM file records matched the real ZIP entries. Genuine `dpkg-deb -c` showed `panel.js` at `./usr/share/r7-ai-assistant/plugin/panel.js`, with no nested GUID directory.

The stand repair removed the malformed nested activation and restored the prior per-user plugin from `/tmp/r7-ai-sprint8-backup-20261008T152429/plugin-before`. The RC package was retained because package installation itself succeeded and removing it was unnecessary to restore prior user state. A running editor with an open document was left untouched; the preserved `02-astra-r7-clean` snapshot was not restored or modified.

## Previous frozen set — superseded history

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
