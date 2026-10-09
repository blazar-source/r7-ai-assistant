# Release UAT — 2026-10-09

**IN PROGRESS; publication is not yet accepted.** The owner authorized autonomous private GitHub publication only after successful user acceptance and final-byte checks. Historical Sprint 8 PASS records do not establish acceptance of this revision.

## Observed user scenarios

Real requests were entered through the installed panel in native Astra R7, using the configured development provider. Each scenario has independent public-SDK reads before/after and an immediate screenshot taken before the diagnostic after-read. Only disposable business fixtures were used. Test harness and original traces are retained locally under `.local/release-uat/`.

- Word creation on `58746da`: title, introductory paragraphs, three sections, four numbered text items, three-column table and deadline. Saved, closed and reopened; content matched. Numbered items use text markers, not native automatic numbering.
- Word follow-up on `8a35bb7`: changed 17:00 to 16:30 in the table and conclusion, inserted a new paragraph inside the quality section, preserved other paragraphs/headings/table. Native pixels and save/close/reopen matched. Earlier caret-based insertion failures are retained.
- Cell on `8a35bb7`: three budget rows, multiplication formulas, SUM total 50,800; bold/fill/currency formatting and sensible column widths. A separate request changed quantity 20 to 25; formulas remained and total became 59,800. Both scenarios saved/closed/reopened. The initial excessive-width failure is retained. One local console encoding error interrupted receipt collection after the completed Cell creation; its JSON before/after and immediate VM screenshot were recovered without repeating the edit.
- Slide on `8a35bb7`: three substantive slides with blue bold titles and readable text; a separate request added a second-position risk slide and amended the training week. Native content/order and save/close/reopen matched.
- Additional explicit Slide move+format task: physical move and formatting were correct, but completion returned INCOMPLETE because the structure read preceded the final formatting. This is **FAIL**, not accepted by the final gate. `f3cbdd1` adds a precise missing-read reminder without weakening freshness, budgets or semantic review; native repeat is pending.

## Corrected causes

Small changes address model-visible argument schemas, accidental long-document routing, progress/scrolling, first-run Cell/Slide capability probes, exact unique-paragraph Word insertion, Cell width units, and Slide completion read accounting. Word anchored writes preserve original paragraph texts and ordered new blocks; missing/ambiguous anchors refuse before writing, partial/wrong-position outcomes stay uncertain without retry.

Independent review found malformed profile revisions could prevent Reset/Save recovery. Read and transactional CAS now use the same bounded revision normalization. Damaged records can be explicitly replaced; a concurrent valid profile still rejects stale writers. 29 independent storage checks passed.

## Remaining acceptance gates

- Repeat the failed Slide move+format task; inspect every resulting slide visually and save/reopen.
- Final candidate native UX at 259×499, persisted shared connection after process restart, and targeted native storage recovery using a separate synthetic database.
- Final full suite, authored/bundle security audit, independent T5/T8, reproducible ZIP/DEB, SPDX inventory, secret scan and exact installed/executing-byte identities.
- Reconcile documentation and final checksums. No GitHub publication while a required gate is incomplete.

Supported target remains Astra SE 1.7.9 build 1.7.9.41 amd64, R7 2026.1.2-1942~astra-signed. Bank TLS/CORS/AUTH/Qwen, ZPS and other target tuples remain unverified. Browser-profile encryption is not an OS vault; model-assisted completion is not a deterministic proof of arbitrary natural-language requirements.
