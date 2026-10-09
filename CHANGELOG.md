# Changelog

## 0.9.0-pilot-rc — unreleased, acceptance blocked

The embedded Word/Cell/Slide assistant now has one shared encrypted connection profile, first-launch setup, administrator-editable settings in the overflow menu, and the approved compact interface. User UAT prompted fixes for model-visible tool schemas, short-document routing, Word section insertion, Cell column-width guidance, first-run capabilities and Slide completion checks. Damaged profile versions can be recovered without overwriting newer settings.

The tested candidate passes 1431 tests and native compact UX at 259 x 499. Word and Cell user workflows pass independent data checks and save/reopen. **Release is blocked by standalone Slide move/format persistence on the supported R7 build:** live changes can disappear after Save/reopen. No GitHub release is published. [Current evidence and reproduction](docs/evidence/release-uat/verification.md) supersede earlier local RC acceptance.

### Known limitations

- **ZPS:** ZPS state and product operation with ZPS enabled are **NOT VERIFIED**; never disable or weaken ZPS to obtain acceptance evidence.
- **Unsupported tuples:** Every Astra/R7/architecture tuple except Astra Linux SE `1.7.9` build `1.7.9.41` `amd64` with `r7-office 2026.1.2-1942~astra-signed` / executable `2026.1.2.1942` is **NOT VERIFIED** and is refused by preflight.
- **System-wide path:** A system-wide plugin path is not claimed or verified and must not be used; activation is supported only in the measured per-user brace-GUID directory.
- **Slide completion:** The earlier append/order cases passed on `ab06fef`; the current standalone persistence P1 remains open. Completion review requires fresh structure/text reads and separates structural calls, but remains model-assisted: it does not deterministically prove all natural-language requirements or eliminate stale indices across turns. Check actual order/text for consequential work; completed changes remain in the document if review cannot finish.
- **Plugin ZIP:** Manual per-user extraction/activation/load/deactivation was measured for historical `ab06fef` on the exact tuple, using the DEB-installed preflight. Vendor plugin-manager import and other installation routes are **NOT VERIFIED**.
- **Future upgrades:** Arbitrary future upgrade bytes are **NOT VERIFIED**; the Sprint 7 `.1` package was an unshipped test fixture and is not an operator upgrade path.
- **Platform scope:** Final Astra Word/Cell/Slide pixels and native focus/compact geometry are recorded. Windows Cell and other platform combinations remain **NOT VERIFIED**.
- **UX-B5 pixels:** A real working-stage screenshot and native progress/terminal observations are recorded; the complete transient five-state pixel sequence remains **NOT VERIFIED**.
- **Model compliance:** Two native raw-HTML/code requests ended with a bounded invalid-JSON error; a fresh explicit-envelope probe rendered correctly. Model output and natural-language task compliance are not guaranteed. Current user journeys verify Save/reopen and expose the Slide persistence blocker; native Undo and arbitrary rich-object preservation remain outside that bounded acceptance.
- **Cell display:** The A1 repaint discrepancy is corrected by recalculation after `write_range`. Final native A1 text is visible and the full value appears in the formula bar. This narrow check does not establish arbitrary formula/recalculation behavior.
- **Qwen calibration:** Real Qwen calibration did not establish reliable completion within the measured envelope, and Bank Qwen acceptance remains **NOT RUN**; no availability or performance guarantee is made.
- **TIMEOUT/HTTP_ERROR:** Controlled and provider failures terminate with bounded `TIMEOUT` or `HTTP_ERROR` rather than false success, but exact bank TLS/CORS/AUTH behavior remains **NOT RUN**.

Installation, operation, administration, and the authoritative limitations list are documented in [docs/deployment.md](docs/deployment.md).
