# Target environment

## Requested baseline (user supplied; guest verification pending)

Astra Linux SE 1.7.9.41; Воронеж; x86_64; kernel 6.1.152-1-generic; X11/Fly; Р7-Офис 2026.1.2.1942. LibreOffice остаётся установленным.

## Host-observed evidence

Hyper-V queried through its management API:

- VM `Astra-R7-Dev`: Running, Generation 2, 4 vCPU, 8 GiB startup RAM, Dynamic Memory false.
- Checkpoints `01-clean-astra` and `02-astra-r7-clean` already exist; duplicate not created.
- Guest KVP: No Contact; network adapter reports no guest IP addresses.
- Guest Service Interface is disabled; not enabled during discovery.
- Initial console was locked. Subsequently unlocked using a user-supplied credential; credential was not saved in project files or Git. Guest desktop and R7 About screen are now accessible.
- Created separate `03-r7-ai-dev-baseline` checkpoint before product installation/development changes. `02-astra-r7-clean` remains intact.

- Firmware reports Secure Boot Off; attached virtual disk logical capacity is 80 GiB (85,899,345,920 bytes).

## Guest-verified evidence

- Running R7 About screen: professional desktop version `2026.1.2.1942 (deb)`. It reports a trial license with 30 days remaining; permanent licensed operation is not established.
- `dpkg-query -W r7-office`: `2026.1.2-1942~astra-signed`.
- `uname -r`: `6.1.152-1-generic`; `uname -m`: `x86_64`.
- Desktop console reports `XDG_SESSION_TYPE=x11` and Fly terminal is running.
- Retrieved `/etc/astra_version` through SFTP: `1.7.9`. Exact update suffix `.41`, Voronezh policy and ZPS status still require verification; do not infer them from the requested baseline.
- Existing guest SSH service was already active. Host identity checked against guest-console ED25519 fingerprint before password authentication. No guest network service installed/enabled by this project. Development SSH is not part of production runtime.

No guest development dependencies installed. A temporary isolated SSH inspection library was installed on the development host only, outside Git/product artifacts. Plugin search/deployment paths, actual SDK behavior, embedded panel, selection and HTTPS gate remain unverified.

## Vendor installation media (not installed-runtime evidence)

Read the control archive of the supplied DEB without installation:

- Package: `r7-office`.
- Version: `2026.1.2-1942~astra-signed`.
- Architecture: `amd64`.
- SHA-256: `f5cf8db84f47fa15c1d2bd43ceac98ea1cf956e9976f7bbf48da7fa047bc4e7d`.

The DEB's `md5sums` inventory lists the binary at `/opt/r7-office/desktopeditors/DesktopEditors` and bundled plugin assets under `/opt/r7-office/desktopeditors/editors/sdkjs-plugins/`. It lists `v1/plugins.js`, `v1/plugins-ui.js`, `v1/plugins.css` and preinstalled plugin manifests. These are package-declared paths, not a verified writable deployment directory or confirmed user plugin search path. No SDK code has been copied into the product.

This identifies the supplied installation artifact only. It does not prove which version is running in the guest, certificate/signature validity or API compatibility.

## Required guest verification

Read OS release, kernel, architecture, active session; inspect installed R7 package version and package file inventory; launch R7; find global/user plugin paths from actual installed files and behavior. Read bundled Plugin SDK/config/examples. Establish supported methods for all editors with a minimal probe and visual evidence. Never substitute ONLYOFFICE documentation for R7 runtime evidence.

Do not restore checkpoints or alter disks without checking for unsaved work/data loss. Create a separate dev-state before installing development dependencies or installing the test plugin. Clean-install acceptance must start from `02-astra-r7-clean` in a safe separate state.
