# Changelog

**Current status / Текущий статус, 2026-10-09: RC acceptance suspended — NOT PASS.** Manual Word testing exposed an append/display blocker: inserted paragraphs were stored but invisible until recalculation. The minimal source correction is prepared; activation and fresh native visual acceptance are pending. This supersedes earlier RC acceptance claims below. See [Word display blocker](docs/evidence/sprint-8/word-display-blocker.md).

## 0.9.0-pilot-rc — locally accepted with recorded limitations, unpublished

This local release-candidate stage packages the embedded R7 Desktop assistant for Word, Cell and Slide. The panel connects directly to a configured HTTPS `/v1/chat/completions` endpoint, exposes ASK and EDIT workflows, validates allowlisted editor actions, and keeps confirm-policy edits behind an explicit Preview/Apply boundary.

### Verification status

- Sprint 7 verified the data-only DEB mechanism on the exact supported Astra/R7 tuple: genuine install, fail-closed compatibility preflight, per-user activation and load, same-version reinstall, a synthetic test-only upgrade with settings preserved, uninstall/product-only cleanup, and incompatible-target refusal.
- Compact UI is implemented: 32 px header, flat role treatment, 50/73 px idle/active composer, capped draft growth, one history scrollbar and DOM-only Markdown. Real Astra checks use a 259 × 499 frame and 22-message working dialogue.
- Final tested source is `ab06fef4e42840dbb0f02893b853dfad2e646442`. Targeted regression groups pass (including final 189 scoped tests and 16 completion tests; overlapping), authored-code audit PASS. Previous 1361/1361 full-suite evidence is retained for unchanged components. ZIP/DEB reproducibility, SBOM/inventory, loaded hashes and exact-byte manual per-user lifecycles pass.
- Slide P1 is closed: original one-slide and ordered two-slide requests pass independent before/after assertions for count, original text prefix, exact final markers/order and no duplicate creation. Word/Cell pass narrow native edits; Cell A1 and formula-bar display are confirmed. T5 has no blocking security finding; independent T8 is **PASS WITH RECORDED LIMITATIONS**. [Final evidence and hashes](docs/evidence/sprint-8/final-verification-ab06fef.md) pin the tested bytes; later documentation commits do not redefine them.

### Known limitations

- **ZPS:** ZPS state and product operation with ZPS enabled are **NOT VERIFIED**; never disable or weaken ZPS to obtain acceptance evidence.
- **Unsupported tuples:** Every Astra/R7/architecture tuple except Astra Linux SE `1.7.9` build `1.7.9.41` `amd64` with `r7-office 2026.1.2-1942~astra-signed` / executable `2026.1.2.1942` is **NOT VERIFIED** and is refused by preflight.
- **System-wide path:** A system-wide plugin path is not claimed or verified and must not be used; activation is supported only in the measured per-user brace-GUID directory.
- **Slide completion:** The observed append/order P1 is closed on `ab06fef`. Completion review requires fresh structure/text reads and separates structural calls, but remains model-assisted: it does not deterministically prove all natural-language requirements or eliminate stale indices across turns. Check actual order/text for consequential work; completed changes remain in the document if review cannot finish.
- **Plugin ZIP:** Manual per-user extraction/activation/load/deactivation is measured for the final ZIP on the exact tuple, using the DEB-installed preflight. Vendor plugin-manager import and other installation routes are **NOT VERIFIED**.
- **Future upgrades:** Arbitrary future upgrade bytes are **NOT VERIFIED**; the Sprint 7 `.1` package was an unshipped test fixture and is not an operator upgrade path.
- **Platform scope:** Final Astra Word/Cell/Slide pixels and native focus/compact geometry are recorded. Windows Cell and other platform combinations remain **NOT VERIFIED**.
- **UX-B5 pixels:** A real working-stage screenshot and native progress/terminal observations are recorded; the complete transient five-state pixel sequence remains **NOT VERIFIED**.
- **Model compliance:** Two native raw-HTML/code requests ended with a bounded invalid-JSON error; a fresh explicit-envelope probe rendered correctly. Model output and natural-language task compliance are not guaranteed. Final narrow journeys do not reverify Save/reopen, native Undo or arbitrary rich-object preservation.
- **Cell display:** The A1 repaint discrepancy is corrected by recalculation after `write_range`. Final native A1 text is visible and the full value appears in the formula bar. This narrow check does not establish arbitrary formula/recalculation behavior.
- **Qwen calibration:** Real Qwen calibration did not establish reliable completion within the measured envelope, and Bank Qwen acceptance remains **NOT RUN**; no availability or performance guarantee is made.
- **TIMEOUT/HTTP_ERROR:** Controlled and provider failures terminate with bounded `TIMEOUT` or `HTTP_ERROR` rather than false success, but exact bank TLS/CORS/AUTH behavior remains **NOT RUN**.

Installation, operation, administration, and the authoritative limitations list are documented in [docs/deployment.md](docs/deployment.md).
