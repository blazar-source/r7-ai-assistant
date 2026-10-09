# Independent Word display review — `68b164f`

Date: 2026-10-09. Candidate source: **`68b164fcbf2ff76dfe862cac2b397ac82d752f0e`**.

**Decision: the observed Word append display P1 is closed for the measured native scenario. Overall RC acceptance remains suspended pending explicit reconciliation of the complete new byte set.** This bounded review does not promote the previous `ab06fef` T8 result to the new product identity.

## Reviewed change

The production delta changes only the Word block-insertion command's recalculation argument from `false` to `true`; the close argument remains `false`. Paragraph construction, scope/data handling, exact postcondition checks, mutation count, PRE_INSERT/POST_INSERT refusal classification and uncertainty-held slot remain unchanged. No extra refresh command, repeated write, network surface or authority is introduced.

The reviewer previously inspected the new real-bridge/SDK-body regression tests: successful two-paragraph append requests recalculation and keeps the panel open; a second-push failure leaves exactly the first append, reports `APPLY_UNCERTAIN`, retains the busy/uncertain slot and does not retry. The coordinator reports 482 scoped tests and authored-code audit PASS, including red-before/green-after flag regression. The reviewer did not repeat these tests.

## Native evidence and independent checks

Reviewed inputs are `.local/word-display/native-word.jsonl`, `immediate-word.png` and `install.json`, preserved in the durable [native, installation and executing-source receipt](word-display-68b164f.json), [immediate screenshot](word-display-immediate-68b164f.png) and [candidate checksums](SHA256SUMS-68b164f-candidate). The request was ordinary prose: “Привет, добавь короткое введение по теме R7 AI Assistant. Придумай сам содержание. Два абзаца.” It supplied no tool name or diagnostic readback instruction.

The first model request included invalid `heading: null` values and was refused as a known batch `TOOL_ERROR`. The model then issued two valid single-paragraph insertions. Recorded results show 2 → 3 and 3 → 4 paragraphs, followed by a terminal success response. The invalid batch is retained as a failure, not counted as a successful insertion. No model read or diagnostic refresh appears between the successful writes and the screenshot.

The log records terminal state, `capture-before-read`, `capture-complete`, then the independent SDK after-state. The reviewer inspected the screenshot: both new paragraph blocks are visibly rendered below the two original paragraphs, while the assistant remains open. The document viewport clips the right side of the page, so the screenshot proves display of both blocks rather than visual equality of every character.

Read-only local assertions over the raw log independently verified:

- Paragraph count increases from exactly 2 to 4.
- After-text equals the complete original text, a newline, the first submitted paragraph, a newline, and the second submitted paragraph.
- There are exactly two successful insertion results and one prior refusal.
- Screenshot completion precedes the independent after-read in the recorded event order.

Thus the visible result is corroborated by exact text preservation/readback, without relying on a later SDK read to make it appear. This directly addresses the previous symptom of updated internal paragraph data with an unchanged canvas.

## Installation and identity boundary

The reviewed receipt records owner-authorized backup, genuine DEB installation, exact-target preflight and per-user activation. Preflight identifies Astra `1.7.9` build `1.7.9.41`, `r7-office 2026.1.2-1942~astra-signed`, amd64, executable `2026.1.2.1942`. All recorded installation commands succeed. Protected editor PID `119782` remains running with `deck-open.pptx`.

Recorded transfer hashes are ZIP `25e7e0925d06c0bd05d204fe20579f46b8dbc782bf33cfa57019a8b6b7d78165` and DEB `222d32f3096aa169d0d2ad6e38510e6afd9ae8a6109fc6269b12280da5010ca8`. Installed and native-frame file hashes agree on panel `36227cee7aab7174a8abcca60fe51837faac5fa26342a42f2dd00901ceb47421` and CSS `34b9b9085d44152b9f7af582dc8505a4a46f36edc32fabefa4c8c063512cedde`.

The reviewer also inspected the durable receipt's `executingScript` record: `Debugger.getScriptSource` captured the actual loaded `panel.js` without reloading the plugin in `compact-word-v6.docx`. Its SHA-256 is the same `36227cee7aab7174a8abcca60fe51837faac5fa26342a42f2dd00901ceb47421`; the panel path is the expected per-user GUID, composer is present and status is ready. This corroborates executing-source identity separately from the installed/file-fetch hashes. The durable assertions agree with the reviewer's raw-log checks: exact original prefix, exactly two inserted paragraphs, successful tool arguments matching after-text, screenshot before independent read, and one schema refusal.

This review did not rebuild or independently re-audit the complete new ZIP/DEB/SPDX inventory, rerun package removal/restoration, or re-execute Cell/Slide acceptance on these bytes. No SSH, installation, native mutation or test run was performed by the reviewer. The authorized coordinator executed the native operations; this review independently assessed their captured evidence.

## Limits

The result covers this ordinary two-paragraph insertion on the measured Word build. Save/reopen, native Undo, other Word mutation paths, arbitrary documents, every formatting/layout property and other platform tuples remain outside this closure. Model recovery from one invalid argument is observed, not guaranteed. The old display failure and prior RC suspension remain part of the history; complete current RC acceptance requires its own explicit new-set decision.
