# Word display blocker — 2026-10-09

**Current status: RC acceptance suspended.** This supersedes the acceptance status of `ab06fef` / documentation `e4f12d6`. Earlier Slide and Cell fixes remain measured, but the normal Word append workflow has a newly demonstrated user-visible failure. A successful SDK readback without an immediately updated document canvas is insufficient acceptance.

The owner submitted an ordinary request for two introductory paragraphs in EDIT using `deepseek-chat`. The panel reported completion, while Word still displayed only the original title and subtitle. Repeating the request added another two paragraphs that also remained invisible. Read-only diagnosis found seven paragraphs: the original two, the earlier acceptance marker, and four paragraphs from the owner's two requests. The last run's journal contained two successful `insert_blocks` actions. No credential or mode correction was necessary.

The bridge's `blocks` command explicitly passed `isCalc=false`. On the same open document, a static SDK read with `isCalc=true` immediately displayed all seven paragraphs. The returned paragraph count and complete text were identical before and after that read. No text insertion, deletion, Save, document close, process restart or plugin reinstall was performed for this diagnosis. Both requested introductions remain; duplicate cleanup requires a separate user decision.

Local diagnostic evidence is retained under `.local/sprint10/manual-word-diagnosis.txt`, `manual-word-refresh.txt`, and `manual-word-before.png` / `manual-word-after.png`. Independent review may inspect these records without further native actions. The currently installed bundle remains the previous `03162abe…` version until a corrected candidate is explicitly activated.

## Minimal source correction

`blocks` now requests recalculation in the insertion command itself with `isClose=false`, `isCalc=true`. Paragraph construction, exact regional readback, pre-insert refusal, post-insert uncertainty, SDK ownership and no-retry behavior are unchanged. There is no additional write, follow-up refresh command or model prompt dependency. Slide and Cell tools are unchanged.

The new real-bridge regression failed before the correction because the command carried `recalculate:false` despite a successful insertion. It now passes. Partial insertion still returns `APPLY_UNCERTAIN`, retains the slot and does not retry. The existing Word integration assertion was updated to the corrected flag. **482 scoped tests PASS**, covering Word tools/bridge, dispatch, controller/integration and the prior Cell correction; authored-code audit PASS. No redundant full suite was run.

Independent delta review by `compact_review` found no blocking source/security issue: one SDK flag changes, no extra dispatch/permission/network/storage path, and uncertainty ownership remains intact. The reviewer explicitly did not equate host flag tests with native repaint evidence and did not install or operate the VM.

## Required acceptance before reopening RC

On the new candidate bytes, submit an ordinary two-paragraph request through the actual Word panel on a separate disposable file. Capture the canvas immediately after completion, before any diagnostic refresh or interaction that could hide the defect. Then independently read count/text and compare the original prefix and both inserted paragraphs. Confirm the visible result without manual recalculation, scroll/zoom workaround or second user prompt. Preserve the owner's current document, conversation and credentials. A passing host test or the diagnostic refresh on old bytes does not close this native gate.

The owner's instruction not to reinstall the already accepted plugin is still respected during preparation. Candidate activation and native final-byte acceptance are pending; the source correction alone does not restore RC acceptance.
