# Deployment

## Status and release artifacts

Version `0.9.0-pilot-rc` is a **release candidate prepared, not published**. After these version and documentation changes are committed, Sprint 8 must build and accept the exact pinned-commit artifact set:

- plugin ZIP: `dist/plugin/r7-ai-assistant.zip`;
- data-only Astra DEB: `dist/deb/r7-ai-assistant_0.9.0-pilot-rc_amd64.deb`;
- SPDX 2.3 SBOM: `dist/r7-ai-assistant.spdx.json`;
- checksums: `dist/SHA256SUMS`.

No final RC hash exists until that post-commit build is recorded. Nothing here publishes, tags, merges or distributes the candidate. The package installs static files only: no daemon, listener, Node runtime, MCP server, TCP/WebSocket bridge, key, user endpoint or network service. Assets are bundled locally with no CDN, and end users do not need the development toolchain.

## Supported target

The complete supported tuple is:

- Astra Linux SE `1.7.9`, build `1.7.9.41`, `amd64`;
- R7 deb package `r7-office 2026.1.2-1942~astra-signed`, `amd64`;
- R7 executable version `2026.1.2.1942`.

The product-owned declaration is [`../packaging/compatibility.json`](../packaging/compatibility.json). The shipped preflight reads `/etc/astra_version`, `/etc/astra/build_version`, the installed R7 package identity/version/architecture and `DesktopEditors --version`, then fails closed if any value is missing, unreadable, malformed, conflicting or different. All other tuples, including R7 `2026.3.1`, are **NOT VERIFIED** and refused until their own complete lifecycle is measured. See the [compatibility matrix](compatibility-matrix.md).

## Administrator install and per-user activation

Install the supplied, checksum-verified RC DEB from its containing directory:

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
cp -a "/usr/share/r7-ai-assistant/plugin/$GUID/." "$TARGET/"
```

Do not copy after a non-zero result; unsupported targets refuse before activation with exit code `42`. Restart R7 after activation when required for plugin discovery.

The supported destination is exactly:

`$HOME/.local/share/r7-office/editors/sdkjs-plugins/{7C91D48E-5F12-4B36-8A90-2DFA8467C013}/`

The system-wide product plugin path is **NOT VERIFIED** and must not be used. Do not copy into vendor directories below `/opt/r7-office/desktopeditors/editors/sdkjs-plugins/`, and do not use stale development directories below `$HOME/.local/share/r7-office/editors/data/sdkjs-plugins/`. Never disable or weaken ZPS to make installation or loading succeed.

## End-user configuration and operation

Open **R7 AI Assistant** in Word, Cell or Slide, expand **«Настройки соединения»**, then configure:

- a full HTTPS endpoint ending exactly in `/v1/chat/completions`;
- the provider's exact model identifier (the product does not silently substitute another model);
- the API key;
- optional HTTP timeout (`5–120` seconds), `max_tokens` (`64–8192`) and temperature (`0–2`).

Press **«Применить настройки»**, then **«Проверить соединение»**. The key remains in memory unless **«Запомнить ключ»** is selected; that option stores it as plaintext in the R7 user profile and is not protected secret storage.

Choose ASK for analysis or EDIT for a change request, choose document context only when the panel reports it available, enter a prompt and press **«Отправить»** or `Ctrl+Enter`. **«Стоп»** ends a pending operation. Confirm-policy edits appear as Preview and require explicit **«Применить»**; saving and Undo remain explicit R7 user actions. **«Сбросить настройки»** targets only the product settings namespace.

## User settings and data

R7 stores the plugin's browser localStorage in its user CEF LevelDB at:

`$HOME/.local/share/r7-office/editors/data/cache/Local Storage/leveldb/`

Product keys are `r7-ai-assistant:v1:settings` and, only after explicit plaintext-persistence opt-in, `r7-ai-assistant:v1:apiKey`. The entire profile root `$HOME/.local/share/r7-office/editors/data/` is user/vendor data and is not package-owned.

Sprint 7 measured a same-version reinstall and an upgrade to the explicitly unshipped `0.9.0-pilot-dev.1` fixture; complete LevelDB hashes were unchanged immediately before and after those exact transitions. This proves the package mechanism and settings boundary for those measured bytes only, not arbitrary future upgrades. Uninstall did not remove the settings; clearing the product namespace is the user's explicit **«Сбросить настройки»** action.

## Upgrade

Every real future upgrade must be independently built, preflighted and measured. Set `PACKAGE` to the actual supplied package path, install it, rerun preflight and refresh the per-user copy:

```sh
PACKAGE='/path/to/measured/r7-ai-assistant_<new-version>_amd64.deb'
sudo dpkg -i "$PACKAGE"
/usr/bin/r7-ai-assistant-preflight
GUID='{7C91D48E-5F12-4B36-8A90-2DFA8467C013}'
TARGET="$HOME/.local/share/r7-office/editors/sdkjs-plugins/$GUID"
install -d -m 0755 "$TARGET"
cp -a "/usr/share/r7-ai-assistant/plugin/$GUID/." "$TARGET/"
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
- **Plugin ZIP lifecycle:** The separately distributed plugin ZIP's own target install/activation/load/removal lifecycle is **NOT VERIFIED** until Sprint 8 measures the final ZIP bytes.
- **Future upgrades:** Arbitrary future upgrade bytes are **NOT VERIFIED**; the synthetic `.1` fixture is not an operator path.
- **Astra pixel proof:** Astra Word/Cell screenshots and focused-panel/focus-ring pixels were not captured, so those pixel-level claims remain **NOT VERIFIED** despite semantic evidence.
- **UX-B5 pixels:** The complete rendered transient UX-B5 progress-stage sequence was not captured; truthful terminal behavior must be checked on final workflows, while a residual transient pixel gap remains an evidence limitation.
- **Qwen calibration:** Real Qwen calibration did not establish reliable completion within the measured envelope, and Bank Qwen acceptance remains **NOT RUN**; no availability or performance guarantee is made.
- **TIMEOUT/HTTP_ERROR:** Controlled and provider failures terminate with bounded `TIMEOUT` or `HTTP_ERROR` rather than false success, but exact bank TLS/CORS/AUTH behavior remains **NOT RUN**.

Additionally, reproducibility is bounded to the same pinned source commit, Node/esbuild versions, operating system and CPU platform, and ignored `dist/` output is identified durably only by the tracked Sprint 8 inventory/checksums. The test-only upgrade fixture is excluded from the release artifact set.

## Evidence index

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
