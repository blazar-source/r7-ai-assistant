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

---

## 2026-10-08 dated re-run after builder repair

**Status: T6 lifecycle VERIFIED except product-integrated incompatible-target refusal, which remains NOT VERIFIED.** The earlier blocker record above is intentionally preserved. It also records an important oracle correction: the previous structural inspector, and genuine `dpkg-deb -c`/`-I`, accepted the malformed archive, while genuine `dpkg -i` refused it. Therefore real `dpkg` installation is the stronger lifecycle oracle.

### Builder repair and package inspection

`scripts/build-deb.mjs` now emits every parent directory of every data payload path as an explicit sorted ustar entry. Directories are `root:root` mode `0755`; regular files remain `root:root` mode `0644`; timestamps remain epoch zero. The inspector now distinguishes files from directories. The regression test derives all parents from every payload file, requires each immediate parent, and compares the complete directory set to the contract-derived payload inventory.

Rebuilt package: `dist/deb/r7-ai-assistant_0.9.0-pilot-dev_amd64.deb`.

SHA-256 locally and after transfer to `/tmp/r7-ai-assistant_0.9.0-pilot-dev_amd64.deb`:

`7f2235ca2b9ee7dc47b80b33dfa4e6b2c7e046fe2c928c870d6bba0831f81934`

Genuine `dpkg-deb -c` and `dpkg-deb -I` both returned exit 0. The listing now includes `./usr/`, `./usr/share/`, the product documentation branch, the product plugin branch, the GUID directory, and `resources/`, all `drwxr-xr-x root/root`, before the nine regular files.

### Install and installed-state invariants

Genuine `sudo dpkg -i` returned exit 0 and `dpkg-query` reported `install ok installed r7-ai-assistant 0.9.0-pilot-dev amd64`. `dpkg -L` contained exactly the claimed product directory tree, eight runtime files, and `product-owned-files.txt`. Installed payload hashes were recorded. `/var/lib/dpkg/info/` contained only `.list` and `.md5sums`, no maintainer scripts.

Installed-state checks found no product daemon, service unit, Node runtime, MCP server, TCP/WebSocket bridge, key/secret/token/endpoint file, or product listener. The only application listener was the already authorised R7 debug CDP listener on `127.0.0.1:8080`; it belonged to `DesktopEditors`, not the package. Thus the installed artifact remained static data only.

### Activation and genuine R7 load

Before restart, the editor probe again returned `canSave:true` and `isDocumentCanSave:false`; therefore no unsaved work was exposed to loss. Compatibility preflight matched the exact supported tuple `r7-office 2026.1.2-1942~astra-signed amd64` and `DesktopEditors 2026.1.2.1942`. The package payload was copied only then to the verified per-user target.

R7 was raised through `systemd-run --user --unit=r7-t6-rerun --collect env DISPLAY=:0 XAUTHORITY=/home/r7dev/.Xauthority ... --ascdesktop-support-debug-info native-word-stage-b-round28.docx`. The vendor host opened the plugin and reported `isRunned after run: true`, frame id `iframe_asc.{7C91D48E-5F12-4B36-8A90-2DFA8467C013}`, and a `259x499` frame. A fresh CDP context then showed the plugin frame URL under `/home/r7dev/.local/share/r7-office/editors/sdkjs-plugins/%7B...%7D/index.html` with `hasStatus:true` and `hasPrompt:true`.

Packaged `/usr/share/.../panel.js` SHA-256 and loaded per-user `panel.js` SHA-256 were identical:

`bacb29385578d52883ae13d02ca4ac21cf69c035c77ee91ab0c9fd0fc6250a1f`

### Upgrade and user settings

A test-only bumped development package `0.9.0-pilot-dev.1` was built and installed over the first package. Its SHA-256 was `ea518943dd517e697a419296c75a29330034deddac7567f1281020c6bb6af0d7`; `dpkg-query` reported the bumped installed version and the full product-owned inventory remained present.

Per contract, user settings live under `$HOME/.local/share/r7-office/editors/data/cache/Local Storage/leveldb/`. Immediately before and after `dpkg -i` upgrade, both the sorted metadata inventory and all LevelDB file SHA-256 values compared byte-for-byte with `diff` exit 0 (`UPGRADE_PAIR_IDENTICAL`). This proves the package upgrade preserved user settings. Later LevelDB log activity occurred while the relaunched R7 process continued running; that is live application activity, not upgrade mutation, and does not weaken the bounded before/after upgrade proof.

### Uninstall, deactivation, and final stand state

`sudo dpkg -r r7-ai-assistant` succeeded. The documented deactivation removed only the per-user GUID copy, after which the original plugin was restored from `/tmp/r7-ai-assistant-t6-backup-20261008T131222/plugin-before`. Final checks found no installed package and neither `/usr/share/r7-ai-assistant` nor `/usr/share/doc/r7-ai-assistant`. Recursive comparison of the restored plugin against the backup returned exit 0. The R7 document remains running from the same path, now under the new systemd unit, and the preserved snapshot `02-astra-r7-clean` was never touched.

Final backup location remains:

`/tmp/r7-ai-assistant-t6-backup-20261008T131222`

### Incompatible target

The safe synthetic unsupported tuple probe again returned refusal code 42 and the diagnostic `REFUSED unsupported target`. Before/after hashes of the user plugin and vendor `v1/plugins.js` were identical. This verifies the documented refusal algorithm is non-mutating.

**Product-integrated incompatible-target refusal remains NOT VERIFIED:** there is still no shipped preflight executable to exercise. No claim stronger than the synthetic algorithm proof is made.

### Tests and logs

One full `node --test` run passed: **1338 tests, 1338 pass, 0 fail**. `npm run audit` returned `Authored-code audit PASS`. The targeted regression first failed because `deb.directories` was absent, then passed 4/4 after the repair. Raw commands, transfer records, stdout, stderr, and exit codes are appended in `.local/sprint7/t6-raw.log`; local test, audit, build, and hash logs are also under `.local/sprint7/`.
