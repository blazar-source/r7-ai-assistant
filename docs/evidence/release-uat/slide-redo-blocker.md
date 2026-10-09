# P1 — Slide ASK destroys native Redo

> Acceptance update, 2026-10-09: the owner explicitly accepted this exact unfixed history behavior as a known pilot limitation, including that restart does not restore lost Redo. Historical BLOCKED statements below describe the earlier decision. Remaining final UAT/security/package gates still apply.

**Reproduced, independently confirmed, release blocking.** Tested source `9b05063cc2c87b8eb2475f0e1b547ec6df33799a`, executing panel SHA-256 `95bf8ff53f5110102aa8816ac8657e55e3f0730fc19c36a6cb57dcf6eb7d9232`, Astra SE 1.7.9.41 / R7 2026.1.2.1942. This supersedes the earlier persistence blocker as the reason T8 remains NOT PASS.

## User reproduction

1. Open the synthetic [saved presentation](slide-redo-input.pptx). Its first slide is «Риски и меры», with a 40-point title.
2. In EDIT ask: «На первом слайде “Риски и меры” измени только размер заголовка на 28 пунктов. Сохрани остальные тексты, оформление и порядок слайдов.» The installed agent reads, formats, performs final control reads and reports completion. The smaller title appears immediately.
3. Use native Undo until the original 40-point title returns. In the recorded harness this required four clicks: the real change plus empty history steps from two agent control reads and one independent diagnostic after-read. No SDK reads occur between these clicks. Redo is available at this point: [before ASK](slide-before-ask-redo-available.png).
4. Switch the actual panel to ASK and ask: «Прочитай первый слайд и назови его заголовок. Ничего не меняй.» The model calls only `read_slide(0)`, then returns the correct title. The ASK harness performs **no diagnostic SDK read before or after this request**.
5. Click native Redo. The 28-point formatting cannot be restored; Redo is disabled: [after ASK](slide-after-ask-redo-lost.png).

[Receipts](slide-history-uat.json) include the prompts, real model call, native terminal state, document data and a subsequent read-only editor diagnostic. That diagnostic accesses history metadata directly without dispatching `callCommand`: the history index is at its last point, the redo branch is gone and the native Redo button is disabled. It does not modify the editor.

## Root cause and boundary

Read-only inspection of the installed, unmodified SDK shows the normal plugin command handler calls native `asc_canPaste()` before evaluating `callCommand` bodies, including getters. On this build the resulting Slide history points remain after finalization. Observed empty points contain only the SDK's history-description item; starting a new command after Undo discards the redo branch. The effect precedes our read handler and is not a model-requested mutation.

The authored ASK policy still prevents mutation tools, but **native read dispatch has a user-visible history side effect**. Therefore source policy tests and correct read results cannot establish the ASK promise on this target. This is a substantial functional failure, not merely the inconvenience of multiple Undo clicks.

No private history cleanup, automatic Undo/Redo/Save, SDK patch, dynamic model code, or message-flag bypass of native command guards was introduced. No vendor code was copied into the product. A verified history-neutral read route or platform correction is required, followed by the exact native Undo → ASK → Redo scenario and remaining final UAT. This reproduction has not been sent to the vendor.

## Changes already verified

`6fecf8e` adds one bounded interface-state notification after existing Slide mutations, retains uncertain ownership for restructure failures, and preflights all requested format setters before writing. `9b05063` adds the public history-point boundary before these edits. Independent review found no blocker in those source deltas; 35 targeted tests and the full 1447-test suite pass.

On these bytes, the natural compound move+format task and standalone move persist through native Save, close and reopen. Native Undo can reverse the actual change, but reads add empty steps and destroy Redo after Undo. Format-only save/reopen, duplicate, final process-restart/shared-profile smoke and final T8 are **not declared complete**. Earlier successful Word/Cell/compact-UX evidence is retained for unchanged components. No GitHub publication was performed.
