# Release UAT — 2026-10-09

**ACCEPTANCE RESUMED — owner accepted the Slide ASK/Redo limitation on 2026-10-09; T8 still pending.** The owner authorized autonomous private GitHub publication only after successful user acceptance and final-byte checks. Historical Sprint 8 PASS records do not establish acceptance of this revision. [Tested candidate identities](tested-candidate.json) pin source `9b05063`, panel `95bf8ff5…`; subsequent documentation commits do not redefine those bytes.

## Latest acceptance delta

The original standalone Slide persistence failure was fixed by a bounded interface-state notification and public history-point boundary (`6fecf8e`, `9b05063`). The natural move+format task and move-only task now persist through native Save/close/reopen. The follow-up history test found a new substantial failure: **Undo → ordinary ASK/read_slide → native Redo loses the redo branch**. Independent review confirmed the real ASK trace and pixels, with no diagnostic SDK reads around ASK. See [current blocker and reproduction](slide-redo-blocker.md) and [new receipts](slide-history-uat.json). The owner subsequently explicitly accepted this exact behavior as a known pilot limitation. The defect remains reproducible and unfixed; restarting the assistant or R7 does not recover lost Redo. This acceptance does not waive other functional or security gates.

Current checks: **1447/1447 tests PASS**, zero skipped; authored-code audit PASS; independent source-delta review PASS; reproducible ZIP matched; all nine SPDX file hashes and all eight DEB plugin payloads match the ZIP. Gitleaks found no secrets in Git history or extracted release payloads; an additional in-memory comparison found no known VM credential in 3212 reachable Git objects or artifacts. These bounded scan results are not a universal PII guarantee. Final publication freeze and T8 remain incomplete.

## Completed remaining native checks

- Format-only: title changed from 40 to 28 points, immediately visible, exact before/after formatting and native Save/close/reopen verified.
- Duplicate: four original slides unchanged, fifth slide is the requested copy at the end. After Save/close/reopen it matches the source text and full recorded formatting exactly. Native duplication adds one empty run before each endRun in memory; serialization removes that empty run. All five slides were inspected visually. [Raw receipts](slide-remaining-uat.json), [saved synthetic presentation](slide-final-uat.pptx).
- Full R7 process exit and restart: Word, Cell and Slide load the same encrypted profile revision without credential entry and execute the pinned panel. [Native profile/data receipts](restart-profile.json), screenshots `word-restart.png`, `cell-restart.png`, `slide-restart.png`. Normal trial notice acknowledged; no protection change.

- DEB reinstall, uninstall and restoration passed on the candidate bytes; supported preflight accepts and a synthetic unsupported tuple refuses with exit42. Local Storage, encrypted-profile IndexedDB and vendor SDK digests were unchanged across package operations. ZIP extraction/activation loaded the exact panel, native deactivation removed it from the Plugins ribbon, DEB activation was restored. [Lifecycle receipts](package-lifecycle.json), [loaded ZIP](zip-loaded.png), [deactivated ZIP](zip-deactivated-menu.png), [restored DEB](deb-restored.png).

## Earlier observed user scenarios

Real requests were entered through the installed panel in native Astra R7, using the configured development provider. Each scenario has independent public-SDK reads before/after and an immediate screenshot taken before the diagnostic after-read. Only disposable business fixtures were used. Test harness and original traces are retained locally under `.local/release-uat/`.

- Word creation on `58746da`: title, introductory paragraphs, three sections, four numbered text items, three-column table and deadline. Saved, closed and reopened; content matched. Numbered items use text markers, not native automatic numbering.
- Word follow-up on `8a35bb7`: changed 17:00 to 16:30 in the table and conclusion, inserted a new paragraph inside the quality section, preserved other paragraphs/headings/table. Native pixels and save/close/reopen matched. Earlier caret-based insertion failures are retained.
- Cell on `8a35bb7`: three budget rows, multiplication formulas, SUM total 50,800; bold/fill/currency formatting and sensible column widths. A separate request changed quantity 20 to 25; formulas remained and total became 59,800. Both scenarios saved/closed/reopened. The initial excessive-width failure is retained. One local console encoding error interrupted receipt collection after the completed Cell creation; its JSON before/after and immediate VM screenshot were recovered without repeating the edit.
- Slide on `8a35bb7`: three substantive slides with blue bold titles and readable text; a separate request added a second-position risk slide and amended the training week. Native content/order and save/close/reopen matched.
- Additional explicit Slide move+format task on `8a35bb7`: physical move and formatting were correct, but completion returned INCOMPLETE because the structure read preceded the final formatting. That attempt remains **FAIL**. `f3cbdd1` adds a precise missing-read reminder without weakening freshness, budgets or semantic review. On installed `096edbd` the repeated task performed the required final structure read and returned FINAL, but **save/reopen failed**: the risk slide was last in memory and second in the file. FINAL therefore does not establish user acceptance. See [minimal reproduction](slide-persistence-blocker.md).

[Independent before/after/reopened receipts](user-scenarios.json) contain the exact synthetic document texts and outcomes. The last Slide case explicitly records `contentAndOrderPersisted: false`.

## Corrected causes

Small changes address model-visible argument schemas, accidental long-document routing, progress/scrolling, first-run Cell/Slide capability probes, exact unique-paragraph Word insertion, Cell width units, and Slide completion read accounting. Word anchored writes preserve original paragraph texts and ordered new blocks; missing/ambiguous anchors refuse before writing, partial/wrong-position outcomes stay uncertain without retry.

Independent review found malformed profile revisions could prevent Reset/Save recovery. Read and transactional CAS now use the same bounded revision normalization. Damaged records can be explicitly replaced; a concurrent valid profile still rejects stale writers. 29 independent storage checks passed.

## Final checks and remaining gates

- [Full suite](full-tests.txt): **1447/1447 PASS**, zero skipped, on source `9b05063`. Authored-code audit PASS. Reproducible ZIP builds matched; installed/executing panel matches the pinned candidate. The ASK/Redo failure is retained as an explicitly accepted pilot limitation, not relabeled PASS.
- [Native compact UX](ux-native.jsonl): **259×499**, header32, idle/working composer50/73, contained overflow settings menu, no connection summary, 22-message history, visible401 settings/recovery, unchanged document and encrypted-profile revision. Error/long-dialog checks use controlled synthetic provider responses and are distinct from real-provider UAT.
- [Native profile recovery](profile-recovery.jsonl): real CEF IndexedDB/crypto with a separate disposable database; four damaged revision types recover through Reset/Save, concurrent valid saves remain protected, key non-exportability/plaintext absence checked, temporary DB removed. Production connection was untouched.
- Independent source security review has no open findings after the malformed-revision fix; independent reviewer confirmed the corrected persistence evidence and the new ASK/Redo failure. **T8 NOT PASS.**
- Still required: final pinned-commit artifact/SBOM/secret/inventory reconciliation and final T8 sign-off. Previous successful checks are carried only for unchanged components.
- No push, PR, merge, tag or GitHub Release was performed. A complete release artifact freeze and publication remain pending the remaining gates.

Supported target remains Astra SE 1.7.9 build 1.7.9.41 amd64, R7 2026.1.2-1942~astra-signed. Bank TLS/CORS/AUTH/Qwen, ZPS and other target tuples remain unverified. Browser-profile encryption is not an OS vault; model-assisted completion is not a deterministic proof of arbitrary natural-language requirements.
