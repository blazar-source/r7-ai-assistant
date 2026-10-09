# Deployment

## Status and release artifacts

Version `0.9.0-pilot-rc` is undergoing final user acceptance. Publication is authorized only after successful native UAT and final-byte tests, security review and package verification. See [current acceptance](evidence/release-uat/verification.md); older Sprint 8 inventories identify historical candidates only.

- Plugin ZIP: `dist/plugin/r7-ai-assistant.zip`.
- Data-only Astra DEB: `dist/deb/r7-ai-assistant_0.9.0-pilot-rc_amd64.deb`.
- SPDX 2.3 SBOM: `dist/r7-ai-assistant.spdx.json`.
- Checksums: `dist/SHA256SUMS`.

The private GitHub release must remain a Pre-release until the bank environment and ZPS are accepted. The package installs static files only: no daemon, listener, Node runtime, MCP server, TCP/WebSocket bridge, key, user endpoint or network service. Assets are bundled locally with no CDN; end users need no development toolchain.

## Supported target

The complete supported tuple is:

- Astra Linux SE `1.7.9`, build `1.7.9.41`, `amd64`;
- R7 deb package `r7-office 2026.1.2-1942~astra-signed`, `amd64`;
- R7 executable version `2026.1.2.1942`.

The product-owned declaration is [`../packaging/compatibility.json`](../packaging/compatibility.json). The shipped preflight reads `/etc/astra_version`, `/etc/astra/build_version`, the installed R7 package identity/version/architecture and `DesktopEditors --version`, then fails closed if any value is missing, unreadable, malformed, conflicting or different. All other tuples, including R7 `2026.3.1`, are **NOT VERIFIED** and refused until their own complete lifecycle is measured. See the [compatibility matrix](compatibility-matrix.md).

## Administrator install and per-user activation

For authorized testing, install the supplied, checksum-verified DEB from its containing directory:

```sh
sudo dpkg -i ./r7-ai-assistant_0.9.0-pilot-rc_amd64.deb
```

`dpkg -i` installs an inert payload under `/usr/share/r7-ai-assistant/`, the product-owned file manifest under `/usr/share/doc/r7-ai-assistant/`, and `/usr/bin/r7-ai-assistant-preflight`. It does not activate the plugin in a user profile.

As the desktop user who will run R7, execute the shipped compatibility preflight and only on exit `0` copy the payload to the measured per-user location:

```sh
/usr/bin/r7-ai-assistant-preflight
GUID='{7C91D48E-5F12-4B36-8A90-2DFA8467C013}'
TARGET="$HOME/.local/share/r7-office/editors/sdkjs-plugins/$GUID"
install -d -m 0755 "$TARGET"
cp -a "/usr/share/r7-ai-assistant/plugin/." "$TARGET/"
```

Do not copy after a non-zero result; unsupported targets refuse before activation with exit code `42`. Restart R7 after activation when required for plugin discovery.

The supported destination is exactly:

`$HOME/.local/share/r7-office/editors/sdkjs-plugins/{7C91D48E-5F12-4B36-8A90-2DFA8467C013}/`

The system-wide product plugin path is **NOT VERIFIED** and must not be used. Do not copy into vendor directories below `/opt/r7-office/desktopeditors/editors/sdkjs-plugins/`, and do not use stale development directories below `$HOME/.local/share/r7-office/editors/data/sdkjs-plugins/`. Never disable or weaken ZPS to make installation or loading succeed.

## End-user configuration and operation

Open **R7 AI Assistant** in Word, Cell or Slide. Use the first-launch connection screen, or **⋯ → Настройки подключения**, to configure:

- a full HTTPS endpoint ending exactly in `/v1/chat/completions`;
- the provider's exact model identifier (the product does not silently substitute another model);
- the API key;
- optional HTTP timeout (`5–120` seconds), `max_tokens` (`64–8192`) and temperature (`0–2`).

On first launch, use the separate connection screen and press **«Сохранить и проверить»**. A successful check saves one encrypted connection profile shared by Word, Cell and Slide. Already open panels running this version synchronize while idle within two seconds, on focus, and before requests. Sending a message never saves the settings form. Use **⋯ → Настройки подключения** to change the profile; stale forms cannot overwrite a newer save. The pilot administrator may configure or rotate credentials remotely in the employee's desktop session; see the [administrator procedure](admin-connection.md). The pilot does not restrict this button to an administrator role.

Choose ASK for analysis or EDIT for a change request, choose document context only when the panel reports it available, enter a prompt and press **«Отправить»** or `Ctrl+Enter`. **«Стоп»** ends a pending operation. Confirm-policy edits appear as Preview and require explicit **«Применить»**; saving and Undo remain explicit R7 user actions. **«Сбросить настройки»** targets only the product settings namespace.

## User settings and data

R7 stores the plugin's browser localStorage in its user CEF LevelDB at:

`$HOME/.local/share/r7-office/editors/data/cache/Local Storage/leveldb/`

The connection profile is stored in IndexedDB `r7-ai-assistant:connection:v2`, encrypted using AES-256-GCM with a fresh random key and nonce per save. The non-exportable CryptoKey is stored in the same browser profile. This prevents plaintext settings disclosure, but is **not an OS key vault**: access to the complete user profile or the running plugin origin can permit decryption. No hardcoded encryption key or plaintext fallback is used. On upgrade an explicitly remembered v1 profile is migrated only after encrypted commit; the legacy `r7-ai-assistant:v1:settings` and `r7-ai-assistant:v1:apiKey` records are then removed. Old copies in backups or previously allocated disk space are not securely erased. Reset commits a tombstone so an old panel cannot resurrect a v1 profile. The entire profile root `$HOME/.local/share/r7-office/editors/data/` is user/vendor data and is not package-owned.

Final `ab06fef` DEB reinstall and uninstall preserved the complete LevelDB file-hash manifest and vendor SDK hash. Sprint 7 additionally measured an upgrade to the explicitly unshipped `0.9.0-pilot-dev.1` fixture. These are bounded measurements, not proof for arbitrary future upgrade bytes. Clearing the product namespace is the user's explicit **«Сбросить настройки»** action.

## Manual ZIP activation on the measured target

The final ZIP has a measured manual per-user lifecycle. This route uses the compatibility preflight supplied by the installed DEB; the ZIP alone does not carry that preflight. It does not establish vendor plugin-manager import. Close the product panel while replacing its files; keep documents open and preserve unsaved work.

After verifying the ZIP checksum against the pinned inventory, use a fresh staging directory and retain the previous plugin copy:

```sh
ZIP='/path/to/verified/r7-ai-assistant.zip'
STAGING="$(mktemp -d)"
python3 -m zipfile -e "$ZIP" "$STAGING/plugin"
/usr/bin/r7-ai-assistant-preflight || exit 42
GUID='{7C91D48E-5F12-4B36-8A90-2DFA8467C013}'
TARGET="$HOME/.local/share/r7-office/editors/sdkjs-plugins/$GUID"
if [ -d "$TARGET" ]; then cp -a "$TARGET" "$STAGING/previous-plugin"; fi
install -d -m 0755 "$TARGET"
cp -a "$STAGING/plugin/." "$TARGET/"
```

Reopen the panel. The native test verified its actual loaded JS, stylesheet and ZIP provenance hashes, then deactivated that exact GUID directory and restored the prior DEB copy. Deactivation affects only that product directory; settings and vendor SDK remain outside it. Preserve the staging backup until the replacement is verified.

## Upgrade

Every real future upgrade must be independently built, preflighted and measured. Set `PACKAGE` to the actual supplied package path, install it, rerun preflight and refresh the per-user copy:

```sh
PACKAGE='/path/to/measured/r7-ai-assistant_<new-version>_amd64.deb'
sudo dpkg -i "$PACKAGE"
/usr/bin/r7-ai-assistant-preflight
GUID='{7C91D48E-5F12-4B36-8A90-2DFA8467C013}'
TARGET="$HOME/.local/share/r7-office/editors/sdkjs-plugins/$GUID"
install -d -m 0755 "$TARGET"
cp -a "/usr/share/r7-ai-assistant/plugin/." "$TARGET/"
```

Do not activate an upgrade if preflight refuses it. The Sprint 7 `.1` fixture is unshipped and must never be used as an operator package or generalized to future bytes. The DEB has no maintainer scripts and does not edit the R7 profile or vendor installation files.

## Uninstall and deactivate

Remove the package-owned system payload, then as the desktop user remove only this product's per-user activated copy:

```sh
sudo dpkg -r r7-ai-assistant
GUID='{7C91D48E-5F12-4B36-8A90-2DFA8467C013}'
rm -rf -- "$HOME/.local/share/r7-office/editors/sdkjs-plugins/$GUID"
```

The first command removes the package's `/usr/share/r7-ai-assistant/`, `/usr/share/doc/r7-ai-assistant/`, and `/usr/bin/r7-ai-assistant-preflight` entries through dpkg. Because the DEB has no maintainer scripts, it cannot remove a user's activated copy; the explicit second step is the measured deactivation procedure.

Uninstall and deactivation do **not** remove R7 localStorage settings, a remembered opt-in key, caches, documents, recovery data, the vendor-owned `v1/` SDK directory, other plugins, or stale development copies under `editors/data/sdkjs-plugins/`. Do not delete those paths opportunistically.

## Known limitations

The consolidated release list is also reproduced in the [RC changelog](../CHANGELOG.md#known-limitations).

- **ZPS:** ZPS state and product operation with ZPS enabled are **NOT VERIFIED**; never disable or weaken ZPS to obtain acceptance evidence.
- **Unsupported tuples:** Every Astra/R7/architecture tuple except the exact supported tuple above is **NOT VERIFIED** and refused by preflight.
- **System-wide path:** A system-wide product plugin path is not claimed or verified and must not be used; only the per-user brace-GUID path above is supported.
- **Slide completion:** Earlier append/order cases passed on `ab06fef`; current compound-task acceptance is recorded separately. Completion review requires fresh structure/text reads and separates structural calls, but remains model-assisted: it does not deterministically prove all natural-language requirements or eliminate stale indices across turns. Check actual order/text for consequential work; completed changes remain in the document if review cannot finish.
- **Plugin ZIP:** Manual per-user activation/load/deactivation is measured for the final ZIP with the DEB-installed preflight; vendor plugin-manager import and other installation routes remain **NOT VERIFIED**.
- **Future upgrades:** Arbitrary future upgrade bytes are **NOT VERIFIED**; the synthetic `.1` fixture is not an operator path.
- **Platform scope:** Final Astra Word/Cell/Slide screenshots, focus and compact geometry are recorded. Windows Cell and other platform combinations remain **NOT VERIFIED**.
- **UX-B5 pixels:** A real working-stage screenshot and native progress/terminal observations are recorded; the complete transient five-state pixel sequence remains **NOT VERIFIED**.
- **Model compliance:** Two raw-HTML/code requests were rejected with the bounded invalid-JSON error; a fresh explicit-envelope probe passed. Model output and whole-task compliance are not guaranteed. The final narrow journeys do not reverify Save/reopen, native Undo or arbitrary rich-object preservation.
- **Cell display:** The A1 repaint discrepancy is corrected by recalculation after `write_range`. Final native A1 text is visible and the full value appears in the formula bar. This narrow check does not establish arbitrary formula/recalculation behavior.
- **Qwen calibration:** Real Qwen calibration did not establish reliable completion within the measured envelope, and Bank Qwen acceptance remains **NOT RUN**; no availability or performance guarantee is made.
- **TIMEOUT/HTTP_ERROR:** Controlled and provider failures terminate with bounded `TIMEOUT` or `HTTP_ERROR` rather than false success, but exact bank TLS/CORS/AUTH behavior remains **NOT RUN**.

Additionally, reproducibility is bounded to the same pinned source commit, Node/esbuild versions, operating system and CPU platform, and ignored `dist/` output is identified durably only by the tracked Sprint 8 inventory/checksums. The test-only upgrade fixture is excluded from the release artifact set.

## Evidence index

- [Historical ab06fef verification and hashes](evidence/sprint-8/final-verification-ab06fef.md)
- [Final native compact-panel evidence](evidence/sprint-9/native-compact-final.md)
- [Independent final T5 security review](evidence/sprint-8/t5-review-ab06fef.md)
- [Historical independent T8 exit review](evidence/sprint-8/t8-review-ab06fef.md)
- [Sprint 8 release contract](superpowers/plans/2026-10-08-sprint-8-release-contract.md)
- [Sprint 8 defect triage](evidence/sprint-8/t2-release-defect-triage.md)
- [Sprint 7 packaging contract](superpowers/plans/2026-10-08-sprint-7-packaging-contract.md)
- [Sprint 7 reproducible-build evidence](evidence/sprint-7/t4-reproducible-build.md)
- [Sprint 7 DEB install-mechanism evidence](evidence/sprint-7/t5-deb-install-mechanism.md)
- [Sprint 7 lifecycle evidence](evidence/sprint-7/t6-lifecycle-astra.md)
- [Sprint 7 compatibility, refusal and ZPS evidence](evidence/sprint-7/t7-astra-compatibility-zps.md)
- [Compatibility matrix](compatibility-matrix.md)
- [Sprint 7 final artifact inventory](evidence/sprint-7/final-artifact-inventory.md)
- [Sprint 7 final artifact reconciliation](evidence/sprint-7/final-artifact-reconciliation.md)

Future target acceptance must preserve unsaved work, use a separate safe Astra state, and never bypass preflight or protection mechanisms.
