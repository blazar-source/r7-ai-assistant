# Sprint 8 T8 — independent exit review

Review date: 2026-10-09. Product commit: **`fda714d2cf8eedcc2331ff5529513c1b74c6a0db`**.

**Decision: NOT PASS. Release acceptance is blocked by an observed Slide workflow failure. No RC, publication, merge or tag is approved by this report.** This is a demonstrated failure to satisfy the user's requested slide position, not simply missing verification or an unreachable platform case. Successful tool receipts and a terminal assistant response do not satisfy the workflow gate.

## Evidence boundary

The reviewer read `.local/sprint9/native-word.jsonl`, `native-cell.jsonl` and `native-slide.jsonl` from the exact final run. Each records loaded `panel.js` SHA-256 `786372b69d155d80c29a6d1756012547532f502098b5b1c0fdc89f61cc89693e` and `styles.css` SHA-256 `34b9b9085d44152b9f7af582dc8505a4a46f36edc32fabefa4c8c063512cedde`. These equal the independently verified final package payloads in [the final T5 report](t5-security-review-final.md), which records the complete ZIP/DEB/SBOM tuple. This tracked report preserves the substantive observed results so the ignored raw logs are not the sole release claim.

This reviewer inspected source, artifact hashes/payloads and recorded native results; it did not itself operate the VM, invoke SSH, rerun the full suite, alter documents, change trust settings or publish artifacts. It subsequently reconciled the durable [final inventory](final-verification-fda714d.md), [native receipts](final-native-receipt.json), [package receipts](final-package-receipt.json), [native UI report](../sprint-9/native-compact-final.md) and three native PNGs. Final install/preflight/activation and reproducibility receipts now form part of this evidence set. Older freeze and acceptance sections refer to earlier commits and must not be read as final-byte proof.

## Final native journeys

| Journey | Actual result | Assessment |
| --- | --- | --- |
| Word append and reread | Paragraph count 2 → 3. The two original paragraphs remain, followed by exact `SPRINT9_WORD_NATIVE_FDA714D`. `insert_blocks` returns one insertion and `read_document_text` confirms it. An invalid `find_text` call receives a whole-batch `TOOL_ERROR`; the agent recovers with the valid document read. The later long-dialogue readback retains the same document text. | PASS for this narrow append/read journey. No broader formatting, Undo or Save/reopen claim follows. |
| Cell write and reread | Active sheet remains `P&L`; A1 changes from empty to exact `SPRINT9_CELL_NATIVE_FDA714D`. `write_range` reports one cell and `read_range` returns that value, empty formula and the addressed active sheet. Independent final readback matches. | PASS for this narrow A1 write/read journey; the earlier Word-root refusal is absent on final bytes. |
| Slide append and reread | Five slides become six; exact `SPRINT9_SLIDE_NATIVE_FDA714D` is written on newly inserted index 1. All five original slide texts are preserved in their relative order, but the existing last slide remains last. No `move_slide` call occurs. | **FAIL**: new slide is not at the end, despite the explicit request. |
| Separately guided Slide recovery | Explicit `move_slide({fromIndex:1,toIndex:5})` succeeds; count remains six. Independent after-read has the original five slide texts as its exact prefix and the marker on final index 5. | PASS for the guided move/readback primitive. Original autonomous append journey remains FAIL. |

### Slide failure: concrete cause and grade

The user requested: add one new slide **at the end**, put the exact marker on it, then reread it. The model first reads a five-slide presentation with current index 0. Its next batch calls `add_slide({layoutFromSlideIndex:0})` and speculatively reads index 5. The tool correctly returns `{slidesCount:6, slideIndex:1, layoutId:"306", layoutPreserved:true}`. Reading index 5 exposes the original last-slide text. The agent then reads index 1, writes the marker to object 0 there, and rereads it successfully. It never moves that slide.

Final text sequence, using zero-based indices:

| Index | Before | After |
| --- | --- | --- |
| 0 | blank | blank |
| 1 | blank | `SPRINT9_SLIDE_NATIVE_FDA714D` |
| 2 | blank | blank |
| 3 | `WHOLE_OBJECT_TEXT` | blank |
| 4 | `SPRINT1 unchanged Slide fixture` | `WHOLE_OBJECT_TEXT` |
| 5 | absent | `SPRINT1 unchanged Slide fixture` |

Removing the new index 1 from the final text sequence reproduces all five original texts in order. This proves preservation of those measured texts, not every layout/shape property. The assistant reports completion and index 1 without acknowledging that the requested end position was omitted.

**Open defect: P1 / release-blocking workflow semantic failure.** The bridge's returned index is correct on this run. The bounded descriptor already states after-current insertion, returned-index targeting and `move_slide` for end placement. The failure is therefore model/task compliance despite accurate tool guidance, not proof that the bridge appends incorrectly or returns a false index. The runtime validates individual tools and does not independently enforce this natural-language positional postcondition.

Do not change the meaning of `add_slide`, relax acceptance, count marker presence alone as success, or substitute the successful intermediate `a10732b` run to hide this result. The separately labelled guided `move_slide` follow-up now proves that primitive and recovery path; it does not retroactively satisfy the original autonomous request. Closing this defect requires an explicit product decision and fresh evidence appropriate to that decision, preserving this failed run in the record.

## Native compact-panel evidence reviewed

The final Word log reaches **22 messages** with semantic paragraphs, lists, emphasis, HTTPS links, inline code and fenced code. At both transcript endpoints and with diagnostics open, document/client size remains **259 × 499**, the single reported overflowing history container is `#content`, and the composer coordinates remain unchanged. Idle composer is **50 px**, textarea **38 px**, Send **34 × 34 px**, header **32 px**. During the long active run, composer is **73 px**, content height **394 px**, and working stage y404–420 is visible above the composer at y426.

The initial long request expands the textarea to its **72 px** cap and the composer to **84 px**, still contained in the viewport. This is the proposal's expressly allowed expanded-textarea exception, not failure of the 73 px unexpanded active target. Subsequent native measurements confirm the declared typography/rhythm, hidden diagnostics rectangle, labelled Tab sequence and 2 px focus outlines, and a one-line 14 px budget warning with contained actions. The native working screenshot visibly corroborates tail/stage/draft/Send/Stop and the ASCII new-chat glyph. Other screenshots corroborate the Cell/Slide panel rendering; they are not substitutes for SDK document-effect readback.

A separate fresh-panel ASK probe, with exact final JS/CSS hashes, rendered raw `<img>` as literal text (images 0, execution sentinel false) and long fenced code with client/scroll widths **224/3158** and heights **24/24**. Document dimensions remain 259 × 499 and only `#content` vertically overflows. Its independent Word before/after values match. Two earlier protocol refusals are retained as unsuccessful attempts, not rendering evidence. The complete transient five-state UX-B5 pixel sequence is still not established by one working screenshot or sampled geometry.

Two evidence boundaries prevent overstatement: the fresh renderer probe starts with one additional space after the Word title compared with the original journey's after-value, so its equal before/after proves only no change during that separate probe, not whole-session immutability. The Cell PNG visibly shows an empty A1 while native/tool readbacks report the marker; no cause for that pixel/readback discrepancy is established here. The Cell result is supported by the two readback paths, and the PNG is used only for panel/UI appearance. Neither discrepancy is evidence that the raw-HTML probe executed or that the recorded Cell value was absent from the SDK; neither should be silently converted into a stronger visual document-effect claim.

## Exit gate assessment and retained gaps

1. **No open release blocker:** FAIL because of the measured Slide positional failure above.
2. **Real Word/Cell/Slide workflows:** Word and Cell narrow journeys PASS; Slide requested journey FAIL. Slide was reachable, so the unreachable-workflow exception does not apply.
3. **Security:** T5 complete; bounded source/artifact review found no critical or blocking security issue. Trusted SDK/CEF and other limitations remain in [T5](t5-security-review-final.md).
4. **Documentation:** reconcile final native outcomes, final artifact identity, this open defect and all remaining limitations. Historical successful attempts must not supersede final-byte failures.
5. **Tested/shipped identity:** final source/ZIP/DEB/SBOM hashes are recorded in T5, independently recomputed, and final loaded JS/CSS match. Durable final build/reproducibility/install receipts have now been reconciled with that tuple. Later documentation commits do not silently redefine the pinned product identity.
6. **Independent acceptance:** NOT PASS. Completion of documentation or a guided recovery cannot by itself remove the observed semantic defect.

**Final-package lifecycle is now measured for the supported manual routes.** DEB receipts establish same-version reinstall, exact-tuple preflight, unsupported-Astra refusal with exit 42, uninstall and absence of product system paths, per-user deactivation, reinstall and restoration. Measured localStorage manifest and vendor SDK hashes match at before/reinstalled/uninstalled checkpoints. ZIP receipts establish its own nine-file extraction, manual per-user activation, fresh plugin load, matching JS/CSS/provenance hashes, deactivation and restoration of the exact prior DEB payload. Restored package state is installed; the protected PID remains `119782`. This closes the earlier blanket ZIP-lifecycle gap **for manual per-user installation only**. Vendor ZIP-manager import and arbitrary future-version upgrade behavior remain NOT VERIFIED.

ZPS, unsupported platform tuples, system-wide installation, Windows Cell and other inherited platform gaps remain explicitly **NOT VERIFIED**; only the measured per-user path is supported. Bank TLS/CORS/AUTH/Qwen remains **NOT RUN** pending internal installation. This report does not broaden native evidence to Save/reopen, native Undo, rich formatting preservation or all editor/platform combinations. The reviewed durable reports agree on the final hashes and preserve the original Slide failure; no new evidence closes that P1 blocker.
