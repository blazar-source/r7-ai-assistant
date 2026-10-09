# Immediate document rendering — 2026-10-09

Source fixes `68b96cb` and `fe372cd`; exact installed bytes are pinned in [candidate.json](candidate.json). **The measured mutation-display gate passes: 24 native cases cover all 21 currently exposed mutation tools.** This is not exhaustive coverage of every argument, document shape or editor version, and does not reinstate overall RC acceptance.

## Findings and corrections

- Request recalculation after Word table/heading/hyperlink/image insertion, Cell formatting and Slide object insertion. Existing Word block/Cell write recalculation remains. Working Slide structural primitives remain unchanged.
- Convert Word image pixel dimensions to EMU (48px = 457200 EMU). Passing pixel counts directly created a nearly invisible object. The native read and visible icon agree. [Documented CreateImage units](https://api.onlyoffice.com/docs/office-api/usage-api/document-api/Api/Methods/CreateImage).
- Convert the tool's explicit exclusive range end to the native inclusive end; reject empty/unusable ranges before writing. Native FORMATME range 0..7 includes all eight characters; 0..8 returned empty. Regression cases include the last and single character.
- Use the documented plugin comment path: GetAllComments → AddComment → GetAllComments → MoveToComment. The prior document-only insertion did not notify the visible comment UI. A bounded exact new-comment comparison precedes reveal; existing ownership, uncertain-write and no-retry rules apply. [Plugin comments sample](https://api.onlyoffice.com/docs/plugins/samples/extended-comments).
- Worksheet SetName updated data but left the tab label stale. The owner explicitly approved one `Api.sheetsChanged()` notification; [security scope](../../security.md#worksheet-notification--narrow-approved-exception-2026-10-09) documents its unsupported/private status and target-version limitation. Active and inactive renames now update labels without activating another sheet.

## Protocol and evidence

[Matrix with before/immediate screenshots](matrix.md). [Word reads](word-baseline.jsonl), [Cell reads](cell-baseline.jsonl), [Slide reads](slide-baseline.jsonl), exact arguments in the three `*-cases.json` files. [Dev-only harness](run.mjs) is not shipped.

Each task runs through the installed panel's real controller, agent runtime, registry and bridge. Provider replies are deterministic CDP-intercepted JSON; this is native tool/render acceptance, not a fresh test of an external model's planning. The first provider continuation after mutation is held; after 250ms for painting, a root-window screenshot is taken **before any follow-up read**, manual refresh, selection change or navigation. Independent SDK readback follows. The preview-only selection replacement has its normal explicit Apply; its screenshot is after Apply. `applyStatus` is captured before the harness resets its context checkbox. Word ToHtml is selection-dependent; complete paragraph arrays provide the independent text proof.

The initial Slide diagnostic reader used the wrong content accessor and returned nested object data that the SDK serializer dropped. Those incomplete local receipts are excluded. The retained run uses GetContent and JSON text transported in an array, requires a nonempty independent result, and contains complete before/after objects for every case. It ran on fresh visual5-slide.pptx; Word/Cell use visual4 fixtures. No product change was needed for this harness correction.

For Slide structural actions, visible evidence is the immediate slide count/active canvas; full order and duplicate contents are proved by readback. The panel covers the thumbnail sidebar, so these images do not claim a visible thumbnail-by-thumbnail order inspection. Slide formatting is corroborated by pixels and the tool's native postcondition; the independent reader preserves text/object counts but does not independently serialize font properties.

373 scoped tests passed for the rendering/comment/range changes; 27 scoped rename/package tests passed for the final notification delta (overlapping groups, not a new full-suite total). Source and bundled audits passed; two clean ZIP builds matched. Independent code review found no remaining blocker after the explicit security exception and native rename checks. Installation/preflight/transfer hashes and preserved PID119782 are in [installation receipt](install.json). A unique plugin backup was made; user documents, VM checkpoints and protection settings were preserved.

## Future acceptance rule

Every new or changed mutation must record: actual loaded bundle hash, independent before state, screenshot of the native visible effect before diagnostic read or user intervention, independent after state, and the expected invariant/change. Missing readback or merely `tool: ok` is a failure. Recheck affected native cases when mutation/transport changes; a UI-only relocation does not require repeating unchanged document mutations.

Overall T8/RC remains suspended: full process restart of the shared profile is untested while the owner's unsaved documents stay open, and existing deployment limitations remain. This document closes the bounded immediate-display gap only.
