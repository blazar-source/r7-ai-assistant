# Deployment

## Status and shipped artifacts

Sprint 7 produces development-only artifacts at version `0.9.0-pilot-dev`:

- the self-contained R7 plugin package (`dist/plugin/r7-ai-assistant.zip` and the equivalent plugin archive produced by the builder);
- the data-only Astra package `dist/deb/r7-ai-assistant_0.9.0-pilot-dev_amd64.deb`.

`0.9.0-pilot-rc` is reserved for the Sprint 8 release. Nothing from this stage is published, and the Sprint 7 bootstrap or development package must not be presented as Pilot RC. The package installs static files only: no daemon, listener, Node runtime, MCP server, TCP/WebSocket bridge, key, user endpoint, or network service. Assets are bundled locally with no CDN, and end users do not need the development toolchain.

## Supported target

The complete supported tuple is:

- Astra Linux SE `1.7.9`, build `1.7.9.41`, `amd64`;
- R7 deb package `r7-office 2026.1.2-1942~astra-signed`, `amd64`;
- R7 executable version `2026.1.2.1942`.

The product-owned declaration is [`../packaging/compatibility.json`](../packaging/compatibility.json). The shipped preflight reads the actual Astra version and build from `/etc/astra_version` and `/etc/astra/build_version`, then fails closed when either Astra value, the declared architecture, R7 package identity/version/architecture, or executable version is missing, unreadable, malformed, conflicting, or different. All other tuples, including R7 `2026.3.1`, are **NOT VERIFIED** and are refused until their own complete lifecycle is measured. See the [compatibility matrix](compatibility-matrix.md) and [T7 evidence](evidence/sprint-7/t7-astra-compatibility-zps.md).

## Install and activate

From a checkout where the measured Sprint 7 package has been built, run this at the repository root:

```sh
sudo dpkg -i ./dist/deb/r7-ai-assistant_0.9.0-pilot-dev_amd64.deb
```

`dpkg -i` installs an inert payload under `/usr/share/r7-ai-assistant/`, the product-owned file manifest under `/usr/share/doc/r7-ai-assistant/`, and the compatibility gate `/usr/bin/r7-ai-assistant-preflight`. It does not activate the plugin in a user profile.

As the desktop user who will run R7, first execute the shipped compatibility preflight, then copy the inert payload to the measured per-user location:

```sh
/usr/bin/r7-ai-assistant-preflight
GUID='{7C91D48E-5F12-4B36-8A90-2DFA8467C013}'
TARGET="$HOME/.local/share/r7-office/editors/sdkjs-plugins/$GUID"
install -d -m 0755 "$TARGET"
cp -a "/usr/share/r7-ai-assistant/plugin/$GUID/." "$TARGET/"
```

Do not perform the copy if preflight exits non-zero. A refusal occurs before activation and uses exit code `42` for an unsupported target.

The supported destination is exactly:

`$HOME/.local/share/r7-office/editors/sdkjs-plugins/{7C91D48E-5F12-4B36-8A90-2DFA8467C013}/`

The system-wide product plugin path is **NOT VERIFIED** and must not be used. In particular, the existence of vendor plugins below `/opt/r7-office/desktopeditors/editors/sdkjs-plugins/` is not evidence that this product may be installed there. The stale development directories below `$HOME/.local/share/r7-office/editors/data/sdkjs-plugins/` are also not supported activation targets.

## User settings and data

R7 stores the plugin's browser localStorage in its user CEF LevelDB at:

`$HOME/.local/share/r7-office/editors/data/cache/Local Storage/leveldb/`

Within that storage, the product keys are `r7-ai-assistant:v1:settings` and, only after explicit plaintext-persistence opt-in, `r7-ai-assistant:v1:apiKey`. The entire R7 profile root `$HOME/.local/share/r7-office/editors/data/` is user/vendor data and is not package-owned.

The T6 upgrade measurement compared the LevelDB inventory and every file hash immediately before and after `dpkg -i`; they were byte-identical. Upgrade preserves these settings. Uninstall does not touch them, including a remembered opt-in key; removal of the product namespace is the user's explicit **Reset** action in the plugin.

## Upgrade

The upgrade rule is to install a newer built-and-measured package with `dpkg -i`, then re-run preflight and refresh the per-user copy. Set `PACKAGE` to the real path of that measured package:

```sh
PACKAGE='/path/to/measured/r7-ai-assistant_<new-version>_amd64.deb'
sudo dpkg -i "$PACKAGE"
/usr/bin/r7-ai-assistant-preflight
GUID='{7C91D48E-5F12-4B36-8A90-2DFA8467C013}'
TARGET="$HOME/.local/share/r7-office/editors/sdkjs-plugins/$GUID"
install -d -m 0755 "$TARGET"
cp -a "/usr/share/r7-ai-assistant/plugin/$GUID/." "$TARGET/"
```

T6 exercised this lifecycle with test-only version `0.9.0-pilot-dev.1`. That `.1` package was a lifecycle-test fixture, is not shipped or published, and must not be used as an operator upgrade path. A real upgrade replaces it with an actually built-and-measured package supplied to the operator. Do not activate an upgrade when preflight refuses it. The package has no maintainer scripts and does not edit the R7 profile or vendor installation files.

## Uninstall and deactivate

Remove the package-owned system payload, then remove only this product's per-user activated copy as the desktop user:

```sh
sudo dpkg -r r7-ai-assistant
GUID='{7C91D48E-5F12-4B36-8A90-2DFA8467C013}'
rm -rf -- "$HOME/.local/share/r7-office/editors/sdkjs-plugins/$GUID"
```

The first command removes the package's `/usr/share/r7-ai-assistant/`, `/usr/share/doc/r7-ai-assistant/`, and `/usr/bin/r7-ai-assistant-preflight` entries through dpkg. Because the DEB has no maintainer scripts, it cannot remove a user's activated copy; the explicit second step is the measured deactivation procedure.

Uninstall and deactivation do **not** remove R7 localStorage settings, the remembered opt-in key, caches, documents, recovery data, the vendor-owned `v1/` SDK directory, other plugins, or stale development copies under `editors/data/sdkjs-plugins/`. Do not delete those paths opportunistically.

## Known limitations

- **ZPS is NOT VERIFIED.** `/usr/sbin/astra-digsig-control status` and `is-enabled` both required superuser rights and exited `1`. Installed/active Parsec and the attempted graphical alternative did not prove ZPS state. Nothing was disabled, bypassed, or weakened to obtain a result. Product load/run with ZPS enabled is therefore also **NOT VERIFIED**; never disable ZPS for acceptance.
- Every unsupported Astra/R7 tuple is **NOT VERIFIED** and refused. A tuple becomes supported only after its own identity capture, `dpkg -i` install, byte-confirmed per-user activation/load, upgrade with settings preservation, uninstall/product-only cleanup, and shipped refusal measurement.
- Reproducibility is bounded: byte identity was measured only for the same source commit, Node version, esbuild version, operating system, and CPU platform. Different inputs or platforms were not measured.
- The DEB install mechanism is deliberately `dpkg -i` plus explicit per-user activation after preflight. No system-wide product plugin directory has been verified.
- This development package is not the Pilot RC and is not published.

## Evidence index

- [Sprint 7 plan and T8 acceptance](superpowers/plans/2026-10-08-sprint-7-packaging-astra-zps.md)
- [Packaging contract: ownership, paths, settings, and fail-closed rule](superpowers/plans/2026-10-08-sprint-7-packaging-contract.md)
- [T4 reproducible-build evidence](evidence/sprint-7/t4-reproducible-build.md)
- [T5 DEB install-mechanism evidence](evidence/sprint-7/t5-deb-install-mechanism.md)
- [T6 install, activation, upgrade, and uninstall evidence](evidence/sprint-7/t6-lifecycle-astra.md)
- [T7 compatibility, shipped refusal, and ZPS evidence](evidence/sprint-7/t7-astra-compatibility-zps.md)
- [Compatibility matrix](compatibility-matrix.md)
- [Final artifact inventory and commit caveat](evidence/sprint-7/final-artifact-inventory.md)
- [Final artifact reconciliation and tested-equals-shipped evidence](evidence/sprint-7/final-artifact-reconciliation.md)

Clean-install lifecycle work used a separate safe Astra state and did not restore over unsaved work. Preserve that rule for future acceptance runs.
