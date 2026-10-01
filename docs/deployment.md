# Deployment

No installable release exists yet. Do not treat bootstrap as Pilot RC.

Deliverables: self-contained R7 plugin package, Astra DEB, SHA-256 checksums, SBOM and documentation. Actual installation directory must first be verified on Р7 2026.1.2.1942; no guessed global path or maintainer script is supplied.

DEB must not install a daemon, Node, MCP, TCP/WebSocket bridge, keys or user endpoint. Bundle static assets without CDN. Uninstall removes product-owned files only; user settings handling is documented separately. Upgrade must preserve user data/config and reject incompatible targets safely. Do not modify vendor installation files opportunistically.

Clean-install/upgrade/uninstall tested from preserved `02-astra-r7-clean` using separate safe test state. Never restore over unsaved work. No development toolchain is required by end users. Users configure endpoint/model/key through plugin settings after install.

ZPS-enabled testing requires a separate state, exact trust/signing process if needed and evidence; never disable ZPS to obtain final acceptance.
