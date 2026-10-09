# P1 — Slide changes disappear after Save/reopen

Historical status: **reproduced on the earlier bytes below** on Astra SE 1.7.9.41 amd64 with R7 2026.1.2.1942. Product source `096edbd`, loaded panel SHA-256 `c227d1bb26f2249813688765740fbfbb4f3f15e4ee7a4911f47f36b248c9ea7f`.

## Superseding result

On `9b05063` the natural compound move+format and move-only scenarios persist through Save/close/reopen. The fix adds a guarded native interface-state refresh and public history point, without rewriting the tools. This record preserves the earlier failure. **Release remains blocked by [ASK destroying Redo](slide-redo-blocker.md).** The later bounded compatibility decision is documented in `docs/security.md`; statements below about no notification describe the earlier revision.

## Original reproduction

Use the synthetic [four-slide fixture](slide-persistence-input.pptx). Its order is goal, risks, plan, criteria. In the installed plugin, EDIT request:

> Перенеси слайд «Риски и меры» в самый конец презентации. Оформи его в том же стиле, что остальные: синий полужирный заголовок 40 пунктов и основной текст 20 пунктов. Тексты и остальные слайды сохрани.

The actual agent calls `move_slide(1,3)`, reads the new structure, formats the target, reads all slide texts, and (after the targeted completion reminder) reads the structure again. Public SDK after-read reports goal, plan, criteria, risks. The user receives a final success message. However, the editor has no unsaved marker and its native Save toolbar control is disabled. A native Save attempt followed by closing/reopening restores goal, risks, plan, criteria. Direct parsing of PPTX `presentation.xml` and its relationships confirms the old order. [Receipts](user-scenarios.json), [immediate screenshot](slide-move-not-persisted.png).

## Isolation

On disposable copies, the same loss was reproduced with the documented primitive alone:

```js
Asc.plugin.callCommand(function () {
  var presentation = Api.GetPresentation();
  return presentation.GetSlideByIndex(1).MoveTo(3);
}, false, true, function (result) {
  // result === true; manually Save, close, reopen to check persistence.
});
```

Both `isCalc=true` and adding documented `presentation.CreateNewHistoryPoint()` before MoveTo failed to make the order persist. A fresh isolated copy with no prior document-serialization probe behaved the same. A separate formatting-only probe (`SetFontSize` on an existing title) also left Save disabled and its saved XML unchanged. These probes did not alter the product or production profile.

The R7 public documentation describes [MoveTo](https://support.r7-office.ru/using-api-document-builder/api_presentation/apislide/moveto-2/), [CreateNewHistoryPoint](https://support.r7-office.ru/using-api-document-builder/api_presentation/apipresentation/createnewhistorypoint/) and [callCommand recalculation](https://support.r7-office.ru/desktop-editors/developers-de/plugins/plugin-structure/plugin-code/methods-plugin/methods-plugin-methods-plugin/callcommand/). None of the tested routes establishes reliable persistence on this build. Earlier cases that also created slides/text made the presentation dirty and passed save/reopen; they do not prove standalone move/format behavior.

Independent review confirmed the original order in three saved PPTX files and found no verified public alternative. No vendor implementation was copied. No dirty-flag override, undocumented notification, fake content edit, slide reconstruction or automatic Save was added. The existing worksheet-only exception does not authorize such Slide workarounds.

Required closure: a verified public route or vendor correction that makes standalone move/format visible, editable through native history and persistent after user Save/reopen, while preserving all original slide content. Then repeat affected UAT and final T8. This reproduction is prepared locally; it has not been sent to the vendor.
