# Final verification — 2026-10-09, product `ab06fef`

Product identity: **`ab06fef4e42840dbb0f02893b853dfad2e646442`**, version `0.9.0-pilot-rc`. The observed Slide P1 is corrected and both original and ordered-pair native scenarios pass. Cell A1 visual confirmation now passes. **Sprint 8 exit: PASS WITH RECORDED LIMITATIONS; local RC accepted, unpublished.** The independent [T8 decision](t8-review-ab06fef.md) confirms this bounded acceptance; [T5](t5-review-ab06fef.md) reports no blocking security finding. Later documentation commits do not redefine these tested bytes. Nothing is published, pushed, merged or tagged.

This report supersedes current-status claims in [the fda714d report](final-verification-fda714d.md). Its failed run remains historical evidence, as does the [intermediate f304507 pair failure](intermediate-f304507-native.json). Successful later runs do not retroactively pass either attempt.

## Cause and bounded correction

The old trace shows accurate insertion at index 1, successful text write/read, no `move_slide`, then a premature final answer. The original request was still in context. Runtime accepted the first valid final envelope without reviewing the compound task. The fix withholds that candidate after a successful Slide EDIT mutation and requests fresh structure/text reads against all original requirements. Missing review reads yield `INCOMPLETE`, rendered as an error with performed changes retained. Further mutations invalidate prior read evidence; uncertain writes and existing budgets still stop execution.

The first native follow-up exposed another dependency: two moves in one batch reused an index shifted by the first move. The minimal follow-up rejects a multi-action Slide EDIT batch containing `add_slide`, `move_slide` or `duplicate_slide` before any dispatch, requiring a separate response boundary and guiding fresh reads. Ordinary read/text batching remains available. Slide schemas, tools and bridge primitives are unchanged.

Completion review is model-assisted, not deterministic semantic verification. It requires fresh presentation and slide-text evidence but cannot prove every natural-language postcondition or prevent every stale index across separate turns. Acceptance below independently checks every requested marker, count, order, original text prefix and duplicate creation. See the [design and causal trace](completion-fix-design.md).

Cell had the correct SDK value and `General` format while A1 and the formula bar remained blank. A read/selection with recalculation enabled refreshed both without rewriting the value; selection alone did not. Only `sheetwrite`'s `callCommand` recalculation flag changes to true; the panel remains open. Final native evidence confirms immediate visible A1 text and the full marker in the formula bar, without a diagnostic refresh after writing.

## T7: frozen final bytes

| Artifact | SHA-256 |
| --- | --- |
| `dist/plugin/r7-ai-assistant.zip` | `886785b5a5085a776a26a06c1cadcc7ac88aeadbffc264eba048285e07c0c35d` |
| `dist/deb/r7-ai-assistant_0.9.0-pilot-rc_amd64.deb` | `5f6bdcce3243fe27af88ae0c516a688431ddcaea32d5f89b51758a74438d5b6a` |
| `dist/r7-ai-assistant.spdx.json` | `016f38dedcfac9b7347714dd832862936fc839b326cb5e5e37d91e418c5c9a69` |
| loaded `panel.js` | `03162abe0b3f10eea55fac0dda6d3af3f5ab47a26790758dd9fcef91ae042aa9` |
| loaded `styles.css` | `34b9b9085d44152b9f7af582dc8505a4a46f36edc32fabefa4c8c063512cedde` |

Clean product commit, existing Windows worktree; Node `24.21.0`, npm `11.19.0`, esbuild `0.25.10`. `npm run reproducible` built identical ZIPs; two `npm run build:deb` runs produced identical DEBs; `npm run sbom` generated the final SPDX. Both inventory checks matched all nine ZIP files/SBOM hashes and all eight shared DEB plugin files. DEB has eleven regular payload files, no maintainer scripts. ZIP provenance names the full product commit; its hash is `9fa3a3f295a5c7ef770ebd717ab77be5dce1bde253db1c0aa39e6d56a7b97637`. T5 independently recomputed the artifact identities. Sizes, build output, transfer/install and lifecycle receipts are preserved in [package-ab06fef.json](package-ab06fef.json); [SHA256SUMS](SHA256SUMS) identifies the current set.

## Addressed tests

Regression fixtures failed before the corrections and passed after them. Coverage includes withheld candidate completion, corrective movement, stale/failed/unserializable reads, later mutation, uncertainty, limits, late cancellation/deadline, zero-dispatch structural batch rejection, ordinary read batching, controller terminal cleanup/no candidate publication, and Cell recalculation/open-panel flags.

Passing scoped groups: runtime/protocol/context/controller/view/integration **223**; native Cell/Slide tools/bridge/completion **107**; controller/view/package **111**; final structural runtime/protocol/controller/view/package/workload group **189**; final completion regressions **16**. These groups overlap and must not be summed. Authored-code audit PASS. [Tracked test output](targeted-tests-ab06fef.json) preserves red/green evidence. The unchanged full suite was not repeated: previous **1361/1361** remains the baseline, with **50/50** for the prior glyph-only delta.

## T3/T4: actual native document effects

Exact target: Astra Linux SE `1.7.9` build `1.7.9.41`, amd64; `r7-office 2026.1.2-1942~astra-signed`, executable `2026.1.2.1942`. Actual panel composer/controller/HTTPS `deepseek-chat`/tool policy/native bridge executed each request. The mounted frame's JS/CSS hashes matched the table before each run. Independent SDK snapshots before and after, rather than assistant prose, determine acceptance. Full model/tool envelopes and snapshots are preserved in [native-ab06fef.json](native-ab06fef.json).

| Fresh fixture / request | Independently measured outcome | Result |
| --- | --- | --- |
| Slide: add one slide at end, exact text, reread | 5 → 6; first five text bodies unchanged; exact `SPRINT9_SLIDE_NATIVE_AB06FEF` at last index 5; exactly one creation; completion review and fresh reads | PASS |
| Slide: add two at end in A → B order, preserve originals, read both | 5 → 7; original five text bodies remain exact prefix; `SPRINT9_SLIDE_NATIVE_AB06FEF_A` at index 5 and `_B` at 6; exactly two creations; both target texts read after latest mutation and during review | PASS |
| Cell: write A1 and reread | Sheet remains `P&L`; empty A1 → exact `SPRINT9_CELL_NATIVE_AB06FEF`; surrounding A1:D5 values unchanged; tool and independent SDK reads agree; canvas text visible immediately and formula bar shows full value | PASS |
| Word: narrow final-byte compatibility append | 2 → 3 paragraphs; exact old text prefix plus final `SPRINT9_WORD_NATIVE_AB06FEF` | PASS |

The final Cell [screenshot](native-cell-ab06fef.png) corroborates display; its narrow column clips the marker on the canvas, while the formula bar displays it in full. The Slide pair [screenshot](native-slidepair-ab06fef.png) corroborates the panel and seven-slide count; the selected old slide is not proof of new-slide text. The SDK snapshots and envelopes supply that proof. No manual corrective prompt was used for either final Slide request.

One initial panel SDK startup attempt failed before any model request; a fresh mount succeeded. This is not counted as a passed document journey. The earlier intermediate pair's known failure remains labelled FAIL, including its two dependent moves, incorrect final position and external assertion failure.

All effects above are in-memory document checks. They do not establish Save/reopen, native Undo, every shape/layout property, arbitrary formulas or formatting. Fresh files/backups remain under `/home/r7dev/r7-verification/sprint10-20261009T020631`. Protected PID `119782` and `deck-open.pptx` stayed open. SSH fingerprint was checked before authentication; credentials were used in memory over stdin and are absent from the tracked receipts/product. No protection/trust-store/checkpoint change occurred.

## Exact-byte package lifecycle

Transferred ZIP/DEB hashes equal the frozen set. Genuine DEB install and reinstall, exact-tuple preflight, per-user activation/load, unsupported-Astra refusal (exit 42), uninstall, absence of package-owned paths, reversible per-user deactivation, reinstall and restoration all passed. The settings-file manifest stayed `908601d9ca77e0349bf9c15cb1d45b66c9ba555340872cff6039880420add9ad` at before/reinstalled/uninstalled checkpoints. Vendor `v1/plugins.js` stayed `6aa574e212733b12c513622331f52a55adb24450e6990a89dbe45ba35fa6a23a`.

The final ZIP's own nine-file manual extraction/activation/load/deactivation was measured using the installed DEB preflight (the ZIP contains no preflight executable). A fresh plugin frame loaded the expected JS/CSS/provenance, composer and ready status. The DEB per-user copy was then restored and compared byte-identical to its backup; package status is installed and the protected editor is still running. Product directories were moved into unique backups, not deleted. Backups: `.../sprint10-20261009T020631/lifecycle-1791500978295756100`.

This covers the documented manual per-user route and same-version reinstall. Sprint 7's separate synthetic upgrade measurement remains bounded historical evidence; no arbitrary future upgrade or vendor ZIP-manager import is claimed.

## T5/T6/T8 and carried evidence

[T5 delta/security review](t5-review-ab06fef.md) extends the earlier source/artifact review; [T8 independent acceptance](t8-review-ab06fef.md) assesses final native/lifecycle results and retained limits. Current README, changelog, deployment, security, compatibility and handoff identify this set. Earlier triage/freeze/native reports point here without rewriting their failed attempts.

The compact stylesheet is byte-identical to the previous accepted UI measurements. The runtime changes and added incomplete-status wording do not change layout/Markdown code. Existing [259 × 499 / 22-message native compact evidence](../sprint-9/native-compact-final.md), typography, focus, DOM-only Markdown, raw-HTML/code behavior and prior independent UI review are carried explicitly; the complete compact run was not repeated. Final targeted view/controller tests and narrow native geometry corroborate compatibility.

ZPS, unsupported tuples, system-wide placement, Windows Cell, arbitrary future upgrades, vendor ZIP-manager import and the complete transient UX-B5 pixel sequence remain NOT VERIFIED. Bank TLS/CORS/AUTH/Qwen remains NOT RUN. Trusted SDK/CEF, HTTPS CSP, plaintext key opt-in and non-atomic Preview/Apply limits remain. Model review does not guarantee arbitrary task compliance. These boundaries remain in [deployment limitations](../../deployment.md#known-limitations). No claim of universal slide-object preservation or automatic Save is made.
