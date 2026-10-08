# Sprint 7 — FINAL ARTIFACT RECONCILIATION

**Status: PARTIAL / EXIT GATE NOT CLOSED.** Final artifact provenance and reproducibility are verified. The final DEB installs and uninstalls, but its shipped preflight refuses the supported Astra target because it discards the R7 version output; therefore activation, real R7 load, final-DEB upgrade preservation, and tested-equals-shipped runtime equality are **NOT VERIFIED**. No gate was bypassed.

## One-commit, both-artifact provenance

The clean source HEAD was `8ed3bb62d3260175d0a4ec561007f5ec0c1438d5` (`stage-b`). Both artifacts below were built from that one committed tree:

- plugin ZIP SHA-256: `11b282dbd1bba6afa5974845850246f976f08fc5c4d212f07f028053aead22c4`
- DEB SHA-256: `cddf8367b514314d7f3a5679be33dac20a726b350f2e88004e6373e23b42a2cd`
- packaged `panel.js` SHA-256: `bacb29385578d52883ae13d02ca4ac21cf69c035c77ee91ab0c9fd0fc6250a1f`

The `provenance.json` packaged in the ZIP names exactly `sourceCommit=8ed3bb62d3260175d0a4ec561007f5ec0c1438d5` and records Node `v24.21.0` plus esbuild `0.25.10`. HEAD did not require a new commit before this build: it was already clean and the manifest is honest for the hashes above.

## Reproducibility at the final commit

The complete `dist/` output was removed between builds. Two clean builds produced the following:

| Artifact | Build 1 | Build 2 |
| --- | --- | --- |
| ZIP | `11b282dbd1bba6afa5974845850246f976f08fc5c4d212f07f028053aead22c4` | `11b282dbd1bba6afa5974845850246f976f08fc5c4d212f07f028053aead22c4` |
| DEB | `cddf8367b514314d7f3a5679be33dac20a726b350f2e88004e6373e23b42a2cd` | `cddf8367b514314d7f3a5679be33dac20a726b350f2e88004e6373e23b42a2cd` |
| `panel.js` | `bacb29385578d52883ae13d02ca4ac21cf69c035c77ee91ab0c9fd0fc6250a1f` | `bacb29385578d52883ae13d02ca4ac21cf69c035c77ee91ab0c9fd0fc6250a1f` |

`npm run reproducible` also passed at this commit. The reproducibility boundary is the exact committed tree and the recorded Windows x64/Node/esbuild toolchain; no cross-platform claim is made.

## Final-DEB lifecycle attempt under the existing owner authorisation

This re-run used the owner's earlier authorisation for the T6 lifecycle on the Astra stand. The preserved snapshot `02-astra-r7-clean` was never restored or modified. Before any change, the stand's existing per-user plugin and LevelDB settings inventory were backed up at:

`/tmp/r7-ai-assistant-t6-backup-20261008T135020`

The exact final DEB was transferred as `/tmp/r7-ai-assistant-final.deb`; its stand-side SHA-256 was again `cddf8367b514314d7f3a5679be33dac20a726b350f2e88004e6373e23b42a2cd`. Genuine `dpkg-deb -c`, `dpkg-deb -I`, and `sudo dpkg -i` succeeded, and `dpkg-query` reported `install ok installed 0.9.0-pilot-dev amd64`.

The installed shipped preflight then returned exit 42 on the exact supported stand:

```text
REFUSED unsupported target: product version 'unparseable'
PREFLIGHT_EXIT=42
```

Measured cause: `/opt/r7-office/desktopeditors/DesktopEditors --version` writes `Р7-Офис ver. 2026.1.2.1942` to **stderr**, while shipped preflight line 42 executes `DesktopEditors --version 2>/dev/null | sed ...`; it therefore discards the only version text and obtains an empty product version. This is a fail-closed refusal, but it is wrong for the declared supported target.

Because activation is contractually gated by this shipped preflight, the gate was not bypassed. Consequently:

- activation of the final package to `$HOME/.local/share/r7-office/editors/sdkjs-plugins/{7C91D48E-5F12-4B36-8A90-2DFA8467C013}`: **NOT VERIFIED**;
- final-DEB plugin frame load over CDP: **NOT VERIFIED**;
- loaded `panel.js` equals packaged payload: **NOT VERIFIED**;
- upgrade from this final DEB to a test-only source-equivalent bumped development fixture: **NOT VERIFIED**;
- settings preservation by that final-DEB upgrade: **NOT VERIFIED**.

The package was removed with genuine `dpkg -r`. Final checks reported the package absent and no `/usr/share/r7-ai-assistant`, `/usr/share/doc/r7-ai-assistant`, or `/usr/bin/r7-ai-assistant-preflight`; the pre-existing per-user plugin compared equal to the backup. The stand was left in its prior relevant state and the original R7 document remained running. This proves cleanup after the blocked attempt, not the complete requested install/activate/upgrade/uninstall lifecycle.

The install inventory remains 11 regular files: eight plugin payload files, `compatibility.json`, `product-owned-files.txt`, and the preflight. It contains no maintainer scripts, daemon, service, bundled Node, MCP/TCP/WebSocket bridge, key material, or configured endpoint. The only observed application listener remains R7's pre-authorised CDP listener, not package payload.

## Tested-equals-shipped equality report

### Verified byte equalities

- locally built DEB = stand-tested DEB: `cddf8367...` on both sides;
- both final clean DEB builds = each other: `cddf8367...`;
- both final clean ZIP builds = each other: `11b282db...`;
- ZIP provenance commit = source HEAD: `8ed3bb62...`;
- packaged plugin payload `panel.js` = locally extracted/built `panel.js`: `bacb2938...`.

### NOT VERIFIED runtime equalities

The installed payload's complete per-file hash manifest was not captured before the preflight blocker was found, and no final-DEB activation/load occurred. Therefore installed-payload-per-file equals packaged-payload, and loaded-file equals packaged-file, are **NOT VERIFIED** for the final DEB. Earlier T6 equality for DEB `7f2235ca...` cannot be attributed to the final DEB, and T7 refusal-only evidence cannot substitute for a load test.

The verified equality proves which archive bytes were installed and tested for the preflight behavior. It does **not** prove that R7 loaded the final payload or that the final-DEB upgrade preserves settings.

## Exit-gate disposition

- Item 1, one commit and both hashes: **VERIFIED**.
- Item 2, repeat build reproduces both hashes: **VERIFIED** within the stated boundary.
- Item 4, complete final-DEB lifecycle: **NOT VERIFIED** because the shipped preflight refuses the supported target before activation.
- Item 8, tested build equals shipped build: **PARTIAL** for archive transfer/build bytes; runtime installed/loaded equality is **NOT VERIFIED**.

The old upgrade fixture `0.9.0-pilot-dev.1` remains explicitly test-only and is not a shipped artifact.

---

## 2026-10-08 stderr parsing repair and real-stand final rerun

**Status at this rerun: final working-tree DEB install, supported acceptance, refusal, activation and real R7 load VERIFIED; bumped-version upgrade then NOT VERIFIED; committed provenance/reproducibility pending controller commit.** The later clean-commit inventory and closure section supersede those two pending conditions for DEB `f280af10...`; the earlier record remains valid for superseded DEB `cddf8367...`.

The preflight now captures both stdout and stderr from `DesktopEditors --version`, selects the first matching version-bearing line, and emits a specific fail-closed diagnostic only if neither stream contains a parseable version. A regression fixture writes the real version to stderr after a non-version stdout line; it failed before the repair with exit 42 and passed afterward.

Artifacts from the uncommitted working tree based on HEAD `8ed3bb62d3260175d0a4ec561007f5ec0c1438d5` were ZIP `11b282dbd1bba6afa5974845850246f976f08fc5c4d212f07f028053aead22c4`, DEB `f280af10e20314a96651b79734093bbd9684634890e6677f3b08ec85e6adaae1`, packaged/loaded `panel.js` `bacb29385578d52883ae13d02ca4ac21cf69c035c77ee91ab0c9fd0fc6250a1f`, and SPDX SBOM `e352c9c6f870a79b9768caf5af9f49910c74006121692fbf05cfc53374f1f65f`, using Node `v24.21.0` and esbuild `0.25.10`.

Because the tree was intentionally uncommitted, these hashes belong to working-tree bytes based on `8ed3bb6`, not to a commit containing the repaired preflight. `npm run reproducible` correctly refused with `DIRTY_WORKTREE`; repeat-build equality for this exact DEB is therefore **NOT VERIFIED** until the controller commits and reruns it. See [final-artifact-inventory.md](final-artifact-inventory.md).

On the pinned stand, genuine `dpkg-deb -c/-I` and `dpkg -i` succeeded. The installed package reported `install ok installed 0.9.0-pilot-dev amd64`, and installed per-file hashes were captured. The shipped preflight accepted the real full tuple with exit 0 and executed the activation marker. A mismatch supplied only through `R7_AI_ASTRA_VERSION_FILE=/tmp/astra_bad` returned exit 42; the marker was absent, and sorted before/after hashes for every activated plugin file plus vendor `v1/plugins.js` were identical (`diff` exit 0).

R7 was raised with the required user `systemd-run` recipe. The vendor host reported `isRunned after run: true`; CDP context 4 was the plugin frame under the supported `sdkjs-plugins/%7B...%7D/index.html` path with `hasStatus:true` and `hasPrompt:true`. Installed and activated/loaded `panel.js` hashes both equalled packaged `bacb2938...`.

Archive and installed inventories showed only the 11 declared files; dpkg info contained only `.list` and `.md5sums`. No package daemon, service, listener, Node, MCP/bridge, key, token or endpoint was found. This equality proves the installed payload files and the file loaded from the measured activation path were the bytes in this exact package. It does not prove semantic correctness beyond the observed R7 frame, other platforms/tuples, ZPS behavior, or reproducibility after a future commit.

A same-version `dpkg -i` reinstall preserved every LevelDB file hash (`SETTINGS_IDENTICAL`). At this rerun date no safely rebuilt `.1` package had been produced, so the bumped development fixture upgrade was then **NOT VERIFIED**; the closure measurement below supersedes that condition for exact DEB `f280af10...`.

`dpkg -r` removed every product-owned system file; the activated copy was removed and the prior plugin restored byte-for-byte from `/tmp/r7-ai-final-backup-20261008T140309/plugin-before`. The package is absent and `/usr/share/r7-ai-assistant`, `/usr/share/doc/r7-ai-assistant`, and `/usr/bin/r7-ai-assistant-preflight` do not exist. The preserved snapshot was untouched. The R7 document is running under user unit `r7-final`; this is the prior relevant interactive state with the backed-up plugin restored.

## 2026-10-08 closure: bumped-version upgrade on exact final bytes

Exact base DEB `f280af10e20314a96651b79734093bbd9684634890e6677f3b08ec85e6adaae1` was transferred, installed, accepted by the shipped preflight, activated, and observed in the existing R7 CDP contexts at its per-user plugin URL with `hasStatus:true` and `hasPrompt:true`. Installed and activated `panel.js` both hashed `bacb2938...`.

The base package was then upgraded by genuine `dpkg -i` to the clearly test-only, unshipped `0.9.0-pilot-dev.1` fixture (`ee26ff9b3a6b41cca0d4f52329cc2d7ea73e07557255b204ea8acc1a3c5ae567`). `dpkg-query` confirmed the bumped version. Complete LevelDB content hashes at `$HOME/.local/share/r7-office/editors/data/cache/Local Storage/leveldb/` were identical before and after; both manifest files hash `57cc0e6424a5f67c69640ccf74f78dc085cb19f95f623430bf0b671f48e0fd94`. The complete product-owned system-file manifest was also identical before/after and contained 11 files, proving no product-owned file was lost.

After `dpkg -r`, all product-owned system paths were absent, the backed-up prior per-user plugin compared equal after restoration, and the post-uninstall LevelDB manifest still hashed `57cc0e6424a5f67c69640ccf74f78dc085cb19f95f623430bf0b671f48e0fd94`. Backup: `/tmp/r7-ai-closure-backup-20261008T141713`. The stand is package-absent in its prior relevant interactive state; snapshot `02-astra-r7-clean` was never restored or modified. This closes the exact-final-DEB bumped-upgrade condition; it does not promote the `.1` fixture to a shipped artifact or prove arbitrary future upgrade bytes.