# Target environment

## Requested baseline (user supplied; guest verification pending)

Astra Linux SE 1.7.9.41; Воронеж; x86_64; kernel 6.1.152-1-generic; X11/Fly; Р7-Офис 2026.1.2.1942. LibreOffice остаётся установленным.

## Host-observed evidence

Hyper-V queried through its management API:

- VM `Astra-R7-Dev`: Running, Generation 2, 4 vCPU, 8 GiB startup RAM, Dynamic Memory false.
- Checkpoints `01-clean-astra` and `02-astra-r7-clean` already exist; duplicate not created.
- Guest KVP: No Contact; network adapter reports no guest IP addresses.
- Guest Service Interface is disabled; not enabled during discovery.
- Read-only console thumbnail after harmless Shift wake shows the Astra lock screen requesting a password. Guest access requires user unlock; no password guessed, collected or stored.

- Firmware reports Secure Boot Off; attached virtual disk logical capacity is 80 GiB (85,899,345,920 bytes).

Actual OS and installed R7 package version, launch, plugin directories, SDK and API are not yet guest-verified. Existing clean checkpoint is preserved. No guest development dependencies installed.

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
