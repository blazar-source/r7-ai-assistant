# Word display blocker — 2026-10-09

**Current status: Word display P1 corrected and natively verified on `68b164f`; overall RC acceptance remains suspended.** This supersedes the acceptance status of `ab06fef` / documentation `e4f12d6`. Earlier Slide and Cell fixes remain measured. A successful SDK readback without an immediately updated document canvas is insufficient acceptance.

The owner submitted an ordinary request for two introductory paragraphs in EDIT using `deepseek-chat`. The panel reported completion, while Word still displayed only the original title and subtitle. Repeating the request added another two paragraphs that also remained invisible. Read-only diagnosis found seven paragraphs: the original two, the earlier acceptance marker, and four paragraphs from the owner's two requests. The last run's journal contained two successful `insert_blocks` actions. No credential or mode correction was necessary.

The bridge's `blocks` command explicitly passed `isCalc=false`. On the same open document, a static SDK read with `isCalc=true` immediately displayed all seven paragraphs. The returned paragraph count and complete text were identical before and after that read. No text insertion, deletion, Save, document close, process restart or plugin reinstall was performed for this diagnosis. Both requested introductions remain; duplicate cleanup requires a separate user decision.

Local diagnostic evidence is retained under `.local/sprint10/manual-word-diagnosis.txt`, `manual-word-refresh.txt`, and `manual-word-before.png` / `manual-word-after.png`. Independent review may inspect these records without further native actions. These diagnostic records concern the old `03162abe…` bundle, before the separately authorized update below.

## Minimal source correction

`blocks` now requests recalculation in the insertion command itself with `isClose=false`, `isCalc=true`. Paragraph construction, exact regional readback, pre-insert refusal, post-insert uncertainty, SDK ownership and no-retry behavior are unchanged. There is no additional write, follow-up refresh command or model prompt dependency. Slide and Cell tools are unchanged.

The new real-bridge regression failed before the correction because the command carried `recalculate:false` despite a successful insertion. It now passes. Partial insertion still returns `APPLY_UNCERTAIN`, retains the slot and does not retry. The existing Word integration assertion was updated to the corrected flag. **482 scoped tests PASS**, covering Word tools/bridge, dispatch, controller/integration and the prior Cell correction; authored-code audit PASS. No redundant full suite was run.

Independent delta review by `compact_review` found no blocking source/security issue: one SDK flag changes, no extra dispatch/permission/network/storage path, and uncertainty ownership remains intact. The reviewer explicitly did not equate host flag tests with native repaint evidence and did not install or operate the VM.

## Corrective native acceptance

The owner explicitly authorized updating and testing the correction after reviewing the prepared change. Clean source **`68b164fcbf2ff76dfe862cac2b397ac82d752f0e`** produced reproducible ZIPs, a DEB and matching SPDX/inventories. The old artifact set was preserved separately; the new [candidate checksums](SHA256SUMS-68b164f-candidate) must not be confused with the historical ab06fef release manifest.

Genuine DEB installation, exact-target preflight and per-user activation passed, with a unique backup. The editor process was not restarted or closed. The owner's existing document and panel/conversation were left open; a fresh `compact-word-v6.docx` tab loaded the corrected bundle. The actual executing script was read through `Debugger.getScriptSource` without reload: SHA-256 **`36227cee7aab7174a8abcca60fe51837faac5fa26342a42f2dd00901ceb47421`**.

The ordinary request was: “Привет, добавь короткое введение по теме R7 AI Assistant. Придумай сам содержание. Два абзаца.” It contained no tool name, marker or readback instruction. The model first sent invalid `heading:null` arguments; the entire batch was refused before dispatch. It recovered with two valid single-paragraph insertions. Both appeared on the Word canvas immediately after completion. The [native screenshot](word-display-immediate-68b164f.png) was captured **before** the independent SDK after-read, with no diagnostic recalculation, scroll/zoom action or second user prompt. The screenshot's right edge is clipped by the existing 100% viewport; both new paragraph blocks are visibly laid out.

Independent readback proves 2 → 4 paragraphs, unchanged exact original text prefix, and both added texts equal the two successful tool requests. No extra insertion occurred. [Durable native/build/install/executing-source receipts](word-display-68b164f.json) preserve this evidence and the refused attempt. One earlier harness startup failed before any model request; it is not counted as a successful journey.

[Independent review](word-display-review-68b164f.md) closes the measured Word display P1. This is a corrective Word acceptance, not a repeat of the entire RC campaign: the new byte set has not undergone a newly reconciled full T8/lifecycle acceptance. The earlier T8 PASS remains historical and is not silently transferred to the new candidate. Existing already-loaded panels retain old JavaScript until reopened; the new test tab is the corrected manual-check surface. No user text, duplicates, conversation or unsaved document was removed.
