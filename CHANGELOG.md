# Changelog

## 0.9.0-pilot-rc — release candidate prepared, not published

This local release-candidate stage packages the embedded R7 Desktop assistant for Word, Cell and Slide. The panel connects directly to a configured HTTPS `/v1/chat/completions` endpoint, exposes ASK and EDIT workflows, validates allowlisted editor actions, and keeps confirm-policy edits behind an explicit Preview/Apply boundary.

### Verification status

- Sprint 7 verified the data-only DEB mechanism on the exact supported Astra/R7 tuple: genuine install, fail-closed compatibility preflight, per-user activation and load, same-version reinstall, a synthetic test-only upgrade with settings preserved, uninstall/product-only cleanup, and incompatible-target refusal.
- Earlier sprints provide supporting workflow and UI evidence, but Sprint 8 native acceptance against the final `0.9.0-pilot-rc` ZIP/DEB hashes has **not yet been run**.
- Sprint 8 still must build from the pinned release commit, record ZIP/DEB/SBOM/checksum hashes and reproducibility, exercise the separately distributed ZIP lifecycle, run final Word/Cell/Slide acceptance, complete security review, and prove TESTED == SHIPPED. No RC artifact is published by this preparation change.

### Known limitations

- **ZPS:** ZPS state and product operation with ZPS enabled are **NOT VERIFIED**; never disable or weaken ZPS to obtain acceptance evidence.
- **Unsupported tuples:** Every Astra/R7/architecture tuple except Astra Linux SE `1.7.9` build `1.7.9.41` `amd64` with `r7-office 2026.1.2-1942~astra-signed` / executable `2026.1.2.1942` is **NOT VERIFIED** and is refused by preflight.
- **System-wide path:** A system-wide plugin path is not claimed or verified and must not be used; activation is supported only in the measured per-user brace-GUID directory.
- **Plugin ZIP lifecycle:** The separately distributed plugin ZIP's own target install/activation/load/removal lifecycle is **NOT VERIFIED** until Sprint 8 measures the final ZIP bytes.
- **Future upgrades:** Arbitrary future upgrade bytes are **NOT VERIFIED**; the Sprint 7 `.1` package was an unshipped test fixture and is not an operator upgrade path.
- **Astra pixel proof:** Astra Word/Cell screenshots and focused-panel/focus-ring pixels were not captured, so those pixel-level claims remain **NOT VERIFIED** even where semantic DOM/CSS evidence exists.
- **UX-B5 pixels:** The complete rendered transient UX-B5 progress-stage sequence has not been captured; final acceptance must still establish truthful user-visible terminal behavior, while any residual transient pixel-sequence gap remains an evidence limitation.
- **Qwen calibration:** Real Qwen calibration did not establish reliable completion within the measured envelope, and Bank Qwen acceptance remains **NOT RUN**; no availability or performance guarantee is made.
- **TIMEOUT/HTTP_ERROR:** Controlled and provider failures terminate with bounded `TIMEOUT` or `HTTP_ERROR` rather than false success, but exact bank TLS/CORS/AUTH behavior remains **NOT RUN**.

Installation, operation, administration, and the authoritative limitations list are documented in [docs/deployment.md](docs/deployment.md).
