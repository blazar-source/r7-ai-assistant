# Sprint 7 final artifact inventory

**Measured 2026-10-08 from clean branch `stage-b` at source commit `8e6b83a0324b2d32c64023e81737b94050c77cff`.** `git status --porcelain` was empty before the builds, after each reproducibility build, and after the final artifact build. The packaged `provenance.json` names that same full source commit.

| Artifact | SHA-256 |
| --- | --- |
| Plugin ZIP `dist/plugin/r7-ai-assistant.zip` | `4a6b1985733e1fa2743154055a88eaa3a1d22efa20417c9c081561facd7e911f` |
| DEB `dist/deb/r7-ai-assistant_0.9.0-pilot-dev_amd64.deb` | `f280af10e20314a96651b79734093bbd9684634890e6677f3b08ec85e6adaae1` |
| Packaged `panel.js` | `bacb29385578d52883ae13d02ca4ac21cf69c035c77ee91ab0c9fd0fc6250a1f` |
| SPDX SBOM `dist/r7-ai-assistant.spdx.json` | `91d3ea3f197f84e62b2ba8d399e58e1b450a88b9e82d0305a0eaf79202b36134` |
| Plugin provenance `dist/plugin/provenance.json` | `25ad70a2352b58f50b08591bb8c116d928ea9882d3bd9d9bdec583ef5222abc7` |

Toolchain: Windows x64, Node `v24.21.0`, esbuild `0.25.10`. `npm run reproducible` performed two clean plugin builds and both produced ZIP `4a6b1985...` and provenance `25ad70a2...`. The DEB was independently built twice with `dist/deb` removed before each build and a clean-tree check before and after each build; both produced `f280af10...`. Reproducibility is therefore verified for both artifact classes at this exact commit and toolchain.

The earlier pre-commit record was ZIP `11b282db...`, DEB `f280af10...`, packaged `panel.js` `bacb2938...`, and SBOM `e352c9c6...`, built from a dirty working tree based on `8ed3bb62...`. It is superseded by the clean-commit record above, not deleted: the ZIP and SBOM changed because the plugin provenance now records committed source `8e6b83a...`; the plugin payload files, including `panel.js`, did not change. The DEB intentionally packages the eight payload files but not plugin `provenance.json`, so this source-commit-only provenance change does not enter the DEB bytes.

The stand-tested DEB SHA-256 was `f280af10e20314a96651b79734093bbd9684634890e6677f3b08ec85e6adaae1`, exactly equal to the clean-commit rebuilt DEB. A binary SHA-256 comparison reported equality, `git diff --no-index --binary` over the extracted ar members returned exit `0`, and `git diff --no-index` over both extracted `data.tar` payload trees returned exit `0`. Thus there is no embedded source-commit-string difference in the DEB: the plugin provenance file is not part of the DEB. **Tested equals shipped is byte-for-byte verified for this DEB**: the stand-tested base artifact is the same bytes as the reproducible DEB rebuilt at commit `8e6b83a`. Its measured lifecycle comprises install, compatibility acceptance, activation/load, same-version reinstall, upgrade to the unshipped `.1` fixture with complete LevelDB hashes preserved, and uninstall/product-only cleanup. This does not extend stand verification to the separately distributed plugin ZIP, whose provenance-bearing bytes changed and whose stand lifecycle remains **NOT VERIFIED** because only the DEB was exercised on that stand.

The SBOM was generated from the clean-commit ZIP after the ZIP and DEB builds. Its zero-runtime-dependency statement covers the plugin payload and declared package graph; it does not independently describe the shell/Python preflight's target-provided executables.
