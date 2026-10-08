# Changelog

## 0.9.0-pilot-rc — local preparation, not accepted or published

This local release-candidate stage packages the embedded R7 Desktop assistant for Word, Cell and Slide. The panel connects directly to a configured HTTPS `/v1/chat/completions` endpoint, exposes ASK and EDIT workflows, validates allowlisted editor actions, and keeps confirm-policy edits behind an explicit Preview/Apply boundary.

### Verification status

- Sprint 7 verified the data-only DEB mechanism on the exact supported Astra/R7 tuple: genuine install, fail-closed compatibility preflight, per-user activation and load, same-version reinstall, a synthetic test-only upgrade with settings preserved, uninstall/product-only cleanup, and incompatible-target refusal.
- Compact UI is implemented: 32 px header, flat role treatment, 50/73 px idle/active composer, capped draft growth, one history scrollbar and DOM-only Markdown. Real Astra checks use a 259 × 499 frame and 22-message working dialogue.
- Final tested source is `fda714d2cf8eedcc2331ff5529513c1b74c6a0db`. Full suite after native fixes: 1361/1361; final glyph-only delta: 50/50 focused tests. Audit, reproducibility, SBOM and archive identity pass. Final DEB lifecycle and manual per-user ZIP lifecycle are measured.
- Native Word and Cell edits pass actual before/after reads. Slide creates and edits the new slide but omits the requested end position. Guided recovery works; the original autonomous request remains a **P1 blocker**. T5 found no blocking security issue; independent T8 is **NOT PASS**. [Final evidence and hashes](docs/evidence/sprint-8/final-verification-fda714d.md) pin the tested bytes; later documentation commits do not redefine them.

### Known limitations

- **ZPS:** ZPS state and product operation with ZPS enabled are **NOT VERIFIED**; never disable or weaken ZPS to obtain acceptance evidence.
- **Unsupported tuples:** Every Astra/R7/architecture tuple except Astra Linux SE `1.7.9` build `1.7.9.41` `amd64` with `r7-office 2026.1.2-1942~astra-signed` / executable `2026.1.2.1942` is **NOT VERIFIED** and is refused by preflight.
- **System-wide path:** A system-wide plugin path is not claimed or verified and must not be used; activation is supported only in the measured per-user brace-GUID directory.
- **Slide placement:** A final-byte request to append a new slide put it after the current slide instead. Individual tool success and marker readback do not prove that the whole request was fulfilled. Check the actual slide order; RC acceptance is blocked.
- **Plugin ZIP:** Manual per-user extraction/activation/load/deactivation is measured for the final ZIP on the exact tuple, using the DEB-installed preflight. Vendor plugin-manager import and other installation routes are **NOT VERIFIED**.
- **Future upgrades:** Arbitrary future upgrade bytes are **NOT VERIFIED**; the Sprint 7 `.1` package was an unshipped test fixture and is not an operator upgrade path.
- **Platform scope:** Final Astra Word/Cell/Slide pixels and native focus/compact geometry are recorded. Windows Cell and other platform combinations remain **NOT VERIFIED**.
- **UX-B5 pixels:** A real working-stage screenshot and native progress/terminal observations are recorded; the complete transient five-state pixel sequence remains **NOT VERIFIED**.
- **Model compliance:** Two native raw-HTML/code requests ended with a bounded invalid-JSON error; a fresh explicit-envelope probe rendered correctly. Model output and natural-language task compliance are not guaranteed. Final narrow journeys do not reverify Save/reopen, native Undo or arbitrary rich-object preservation.
- **Cell visual effect:** Tool and independent SDK reads confirm the changed A1 value, but the captured cell still appears blank. The discrepancy is unresolved; the screenshot proves panel appearance only.
- **Qwen calibration:** Real Qwen calibration did not establish reliable completion within the measured envelope, and Bank Qwen acceptance remains **NOT RUN**; no availability or performance guarantee is made.
- **TIMEOUT/HTTP_ERROR:** Controlled and provider failures terminate with bounded `TIMEOUT` or `HTTP_ERROR` rather than false success, but exact bank TLS/CORS/AUTH behavior remains **NOT RUN**.

Installation, operation, administration, and the authoritative limitations list are documented in [docs/deployment.md](docs/deployment.md).
