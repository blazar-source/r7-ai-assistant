# Sprint 7 T7 — Astra compatibility and ZPS evidence

**Status: compatibility/refusal PASS; ZPS NOT VERIFIED.** Measurements were made on the existing Astra stand. The preserved snapshot `02-astra-r7-clean` was not restored or modified. No protection mechanism was disabled, bypassed, or weakened.

## Compatibility matrix

| Target | Result | Evidence / promotion rule |
| --- | --- | --- |
| Astra Linux SE 1.7.9 build 1.7.9.41, amd64; R7 deb `r7-office 2026.1.2-1942~astra-signed`; executable `2026.1.2.1942` | **SUPPORTED / PASS** | T6 measured install, activation, real plugin load, upgrade with settings preserved, uninstall, and restored prior state. T7 re-read the exact OS/package/product tuple and exercised the shipped fail-closed preflight. |
| Any different Astra version/build, architecture, R7 package form/version/build, including separately observed R7 2026.3.1 | **NOT VERIFIED / refused** | Promotion requires its own target identity capture plus the complete T6 lifecycle: install, activation and byte-confirmed load, upgrade/settings preservation, uninstall/product-only cleanup, and this shipped incompatible-target gate. Observation or historical use alone is insufficient. |
| System-wide product plugin path | **NOT VERIFIED** | Promotion requires separate behavior proof that R7 loads the product there without modifying vendor-owned files. The supported path remains the measured per-user brace-GUID directory. |

This table and enforcement are deliberately exact-tuple. `packaging/compatibility.json` is the product compatibility declaration and the single source consumed both by plugin provenance generation and by the shipped preflight. Missing, malformed, conflicting, or non-exact target evidence is refused; therefore the fail-closed rule cannot silently broaden the table.

## Product-integrated incompatible-target refusal

The DEB now ships `/usr/bin/r7-ai-assistant-preflight` and `/usr/share/r7-ai-assistant/compatibility.json`. The preflight reads the declaration, obtains the installed package/version/architecture through `dpkg-query`, obtains the executable product version through `DesktopEditors --version`, and exits 42 before executing an optional activation command unless all values equal the declaration.

Stand demonstration used the real installed T7 DEB (`SHA-256 cddf8367b514314d7f3a5679be33dac20a726b350f2e88004e6373e23b42a2cd`) and its installed `/usr/bin/r7-ai-assistant-preflight`. A controlled unsupported target adapter reported `r7-office / 2026.3.1-9999~astra-signed / amd64 / 2026.3.1.9999`. Output:

```text
REFUSED unsupported target: package tuple 'r7-office  2026.3.1-9999~astra-signed  amd64'
REFUSAL_EXIT=42
PLUGIN_HASHES_UNCHANGED=0
VENDOR_HASHES_UNCHANGED=0
```

The activation marker did not exist after refusal. Before/after sorted SHA-256 manifests of every file under the supported user plugin directory compared with `diff` exit 0. Before/after SHA-256 records for both user and `/opt` vendor `v1/plugins.js` compared with `diff` exit 0. Thus there was no partial activation and no product or vendor file changed. The test DEB was then removed; `dpkg-query` reported it not installed. Backup/hash records were kept at `/tmp/r7-t7-before` and `/tmp/r7-t7-after`; the existing T6 full plugin backup remains `/tmp/r7-ai-assistant-t6-backup-20261008T131222`.

The script is a small local activation/preflight program. It does not run automatically at package install/removal, is not a daemon or listener, and contains no Node runtime, MCP/TCP/WebSocket bridge, key, endpoint, or network behavior. In the deployment contract's sense the package remains data-only: dpkg installs inert files, while a user explicitly runs this bounded local gate before per-user activation.

## ZPS bounded feasibility probe

ZPS enabled state and ZPS-on product operation are **NOT VERIFIED**. Observation was bounded to existing status tools, packages, files, and services:

- `/usr/sbin/astra-digsig-control status` → `Для запуска нужны права суперпользователя`, exit 1.
- `/usr/sbin/astra-digsig-control is-enabled` → the same superuser-rights diagnostic, exit 1.
- `astra-digsig-control` is supplied by installed package `astra-safepolicy`; it is outside the unprivileged PATH but exists at `/usr/sbin/astra-digsig-control`.
- Parsec packages are installed and `parsec.service` is active (exited successfully). That proves the Parsec subsystem exists, not that ZPS is enabled.
- `fly-admin-smc --help` without the graphical environment failed at Qt/XCB (exit 134), so it did not expose a usable read-only state.

A working privileged ZPS state query was not established in the bounded probe. Consequently no claim is made that ZPS is ON or OFF, and plugin load/run with ZPS enabled remains NOT VERIFIED. The measured symptom is permission denial from the documented status utility. No configuration, signing policy, service, trust store, or enforcement state was changed.

## Repository checks

Tests pin that the shipped preflight consumes the same declaration used by plugin provenance, accepts the exact tuple, refuses an unsupported tuple before activation, and is present in the DEB. Raw stand output is retained in ignored `.local/sprint7/t7-raw.log`; this document contains the sanitized result.
