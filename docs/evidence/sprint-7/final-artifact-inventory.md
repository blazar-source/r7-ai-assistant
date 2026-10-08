# Sprint 7 final artifact inventory

**Measured 2026-10-08 from an uncommitted `stage-b` working tree based on source HEAD `8ed3bb62d3260175d0a4ec561007f5ec0c1438d5`.** These hashes belong to the exact working-tree bytes measured below, not yet to a commit that contains them. The controller must commit the packaging/evidence changes, rebuild, and re-verify the provenance manifest against that new commit before treating these as committed release-candidate artifacts.

| Artifact | SHA-256 |
| --- | --- |
| Plugin ZIP `dist/plugin/r7-ai-assistant.zip` | `11b282dbd1bba6afa5974845850246f976f08fc5c4d212f07f028053aead22c4` |
| DEB `dist/deb/r7-ai-assistant_0.9.0-pilot-dev_amd64.deb` | `f280af10e20314a96651b79734093bbd9684634890e6677f3b08ec85e6adaae1` |
| Packaged `panel.js` | `bacb29385578d52883ae13d02ca4ac21cf69c035c77ee91ab0c9fd0fc6250a1f` |
| SPDX SBOM `dist/r7-ai-assistant.spdx.json` | `e352c9c6f870a79b9768caf5af9f49910c74006121692fbf05cfc53374f1f65f` |

Toolchain: Windows x64, Node `v24.21.0`, esbuild `0.25.10`. The ZIP is unchanged because the plugin payload is unchanged; the DEB changed because it embeds the corrected preflight. The standard `npm run reproducible` command deliberately refused this dirty tree with `DIRTY_WORKTREE`, so repeat-build equality for this exact uncommitted DEB is **NOT VERIFIED**. Reproducibility at clean HEAD `8ed3bb6` remains recorded in [final-artifact-reconciliation.md](final-artifact-reconciliation.md), but applies to the superseded DEB `cddf8367...`, not this one.

The SBOM was generated from the same working tree after the ZIP and DEB builds. Its zero-runtime-dependency statement covers the plugin payload and declared package graph; it does not independently describe the shell/Python preflight's target-provided executables.
