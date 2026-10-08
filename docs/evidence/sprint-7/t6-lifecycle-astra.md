# Sprint 7 T6 — Astra lifecycle evidence

**Status: BLOCKED / NOT ACCEPTED.** The real archive is accepted by `dpkg-deb`, but real `dpkg -i` rejects it before installation because its hand-built `data.tar` omits parent directory entries. Therefore activation/load, upgrade, and uninstall cannot honestly be marked verified. No model call was made; model spend: **zero**.

## Safety and prior state

The preserved clean snapshot `02-astra-r7-clean` was not restored, modified, or otherwise touched. Work was performed in the already-running separate Astra state. Before any potentially lossy action, CDP identified the open document `native-word-stage-b-round28.docx`; the editor probe returned `canSave:true`, `isDocumentCanSave:false`. The running editor was never stopped. The existing per-user plugin was backed up to:

`/tmp/r7-ai-assistant-t6-backup-20261008T131222`

The backup contains the complete prior six-file plugin directory and LevelDB inventory/hashes. Final recursive comparison of the plugin backup against the live target returned exit 0; LevelDB metadata comparison emitted no diff. Raw transcript: `.local/sprint7/t6-raw.log`.

## 1. Real package transfer and inspection

Transferred to writable temp path `/tmp/r7-ai-assistant_0.9.0-pilot-dev_amd64.deb`. SHA-256:

`ba75ecfb0ed47a02d45ed2d777fdb0fc0e6f08992318205fe5ea7b26b9e14c5a`

Both genuine commands returned exit 0:

- `dpkg-deb -c /tmp/r7-ai-assistant_0.9.0-pilot-dev_amd64.deb`
- `dpkg-deb -I /tmp/r7-ai-assistant_0.9.0-pilot-dev_amd64.deb`

The listing contains the eight contract payload files under `/usr/share/r7-ai-assistant/plugin/{GUID}` plus `product-owned-files.txt` under `/usr/share/doc/r7-ai-assistant/`. It contains no maintainer script, executable, daemon, Node, MCP/bridge, key, endpoint, or service payload. This is one metadata file beyond the eight runtime payload files, as explicitly allowed by the contract.

## 2. Clean install and invariants

`sudo dpkg -i` was run against the real transferred package. It failed:

```text
dpkg: error processing archive ... (--install):
 unable to create '/usr/share/doc/r7-ai-assistant/product-owned-files.txt.dpkg-new'
 (while processing './usr/share/doc/r7-ai-assistant/product-owned-files.txt'):
 No such file or directory
```

Measured cause: the archive lists regular files but no directory entries, and dpkg does not synthesize the missing parent directories. Post-failure state is `in  install ok not-installed`; neither `/usr/share/r7-ai-assistant` nor `/usr/share/doc/r7-ai-assistant` exists. No partial product payload remained. Vendor `v1/plugins.js` retained SHA-256 `6aa574e2...`; the prior per-user `panel.js` retained `bacb2938...`.

Consequently, a **clean-install PASS and installed `dpkg -L`/runtime invariant result are NOT VERIFIED**. Pre-install archive inventory is static-data-only, and the failed install left no process or product listener, but that is not a successful installed-state invariant measurement.

## 3. Activation and real R7 load

**NOT VERIFIED.** Activation was not attempted because there was no successfully installed inert payload to copy. R7 was not restarted and no new plugin CDP frame was created. The requested packaged-payload-versus-loaded-panel hash comparison therefore does not exist. The prior untouched plugin hash `bacb2938...` is only restoration evidence, not T6 load proof.

## 4. Upgrade and user settings preservation

**NOT VERIFIED.** A bumped test package was not built or installed over a successful first installation because that prerequisite failed. User settings location remains the contract path `$HOME/.local/share/r7-office/editors/data/cache/Local Storage/leveldb/`; before/final metadata showed no change, proving T6 did not disturb it, not proving an upgrade preserves it.

## 5. Uninstall/deactivation and final state

**NOT VERIFIED as a lifecycle scenario** because no package was installed and no T6 activation occurred. No `dpkg -r` was needed or valid. Final checks show package state `not-installed`, no `/usr/share/r7-ai-assistant` or `/usr/share/doc/r7-ai-assistant`, recursive equality with the backed-up prior plugin, no LevelDB metadata diff, and the original R7 process/document still running. Thus the stand is returned to its exact relevant prior state without requiring restoration.

## 6. Unsupported-target refusal

A non-destructive synthetic invocation of the contract's exact-tuple preflight used unsupported tuple `2026.3.1-9999~astra-signed / 2026.3.1.9999 / amd64`. It returned refusal code 42 and diagnostic `REFUSED unsupported target`; before/after hashes for the user plugin and vendor `plugins.js` were identical. This demonstrates the **specified preflight algorithm** fails closed without mutation.

However, **product-integrated refusal is NOT VERIFIED**: no executable activation/preflight implementation exists in the package/repository; compatibility currently exists only as provenance data and documentation. The test script is evidence scaffolding, not shipped product code.

## Raw logs and command accounting

All remote commands, stdout, stderr, and exit codes are captured verbatim in `.local/sprint7/t6-raw.log`. Supporting one-use scripts are in `.local/sprint7/`. One quoting-error attempt is also retained rather than smoothed over. Repository production files were not changed; only this evidence document and ignored raw logs were added. Per instruction, `node --test` was not run because no production/repository implementation file was changed beyond evidence. `git diff --numstat` is recorded in the final command output. Model spend: **zero**.
