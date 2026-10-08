# Sprint 8 T3/T4 — exact capability refusal diagnosis

**Scope:** diagnosis only at `stage-b` / `dc93242`; no product code, document, editor lifecycle, or snapshot change. Live stand remained the protected Slide process PID `119782`. Raw evidence: `.local/sprint8/post-modal-capability.log`, `.local/sprint8/capability-live-probe.log`, `.local/sprint8/capability-refusal-live.log` (the new SSH attempt failed at banner before authentication/CDP, so it changed nothing). Cell/Word surface values below are therefore from the repository's already-recorded native measurements, not a switched live document.

## Exact false condition

`probeCapabilities()` now dispatches the same six-slot probe for every known editor (`bridge.js:8290-8295`). `capabilities()` then defines **both** `selectionRead.available` and `mutation.available` as:

```js
!disposed && methodPresence !== null &&
methodPresence.api === true && methodPresence.getDocument === true
```

(`bridge.js:6039-6046`). The controller grants `document.read/write` only from those booleans and throws `CAPABILITY_UNAVAILABLE` when neither is granted (`controller.js:305-310`).

- **Slide false flag:** `methodPresence.getDocument === false`, therefore `selectionRead.available=false`, `mutation.available=false`, capabilities `[]`, then line 310 throws. On R7 Slide the relevant root is `Api.GetPresentation()`, not `Api.GetDocument()`.
- **Cell false flag:** the same `methodPresence.getDocument === false`, therefore the same two availability flags are false and the same controller guard throws. On R7 Cell the relevant root is `Api.GetActiveSheet()` / `Api.GetSheets()`, not `Api.GetDocument()`.

### Raw values / classification

Live Slide plugin-frame evidence already recorded on this exact protected stand:

```text
editorType="slide"
own callCommand=true; own executeCommand=true; own executeMethod=true
Asc.scope=own writable value; Object.isExtensible(Asc)=true
exact six-slot probe callback=[true,true,true,true,true,true]
```

The last tuple is the crucial anomaly: the methods exist and the probe **reports** all true, yet availability still refuses. The reason is that `capabilityBody` calls `Api.GetDocument()` while constructing the tuple (`bridge.js:86-95`). In Slide, that word-shaped call cannot establish a Slide document boundary; the callback's booleans are therefore presence-like facade results, not proof of `Api.GetPresentation()`. `GetDocumentId`, `ReplaceTextSmart`, `GetRangeBySelect`, and `IsTrackRevisions` are present according to the tuple; none except `GetDocument()` is invoked by the probe (`bridge-dispatch-api.test.js:155-176`). `GetDocumentId`, `ReplaceTextSmart`, `GetRangeBySelect`, and `IsTrackRevisions` therefore **cannot be classified by this probe beyond “method exists”; their behavior was deliberately not interrogated to avoid identity/selection/write side effects**. Command dispatch exists and returned the closed tuple. The live attempt to collect an expanded no-write tuple failed before SSH authentication, so it supplies no additional values.

For Cell, no live switch was permitted. Existing native records establish the actual surface: `Api.GetActiveSheet`, `Api.GetSheets`, `Api.GetSheet`, sheet `GetName/GetIndex/GetRange`, and mutation `Api.AddSheet`; `AddSheet` returns `undefined`, so success is proven only by postcondition readback. The exact Cell six-slot callback at `dc93242` is **not freshly observed** under this protection and must not be claimed otherwise.

## Editor access surfaces on R7 2026.1.2.1942

| Editor | Genuine root / boundary | What the generic tuple means |
|---|---|---|
| Word | `Api.GetDocument()`; identity/selection methods (`GetDocumentId`, `ReplaceTextSmart`, document `GetRangeBySelect`, `IsTrackRevisions`) | Appropriate Word-shaped presence gate; later context decoder additionally requires nonempty id, replace/range true, tracking false. |
| Cell | `Api.GetActiveSheet()`, `Api.GetSheets()`, `Api.GetSheet(name/index)`; sheet identity by readable name+index; ranges from the resolved sheet | `GetDocument` is not the workbook boundary. Requiring it proves the wrong object and says nothing about the sheet addressed by shipped tools. |
| Slide | `Api.GetPresentation()`; `GetSlidesCount`, `GetCurrentSlide`, `GetCurSlideIndex`, `GetSlideByIndex`; mutations/readback through that presentation and addressed slide | `GetDocument` is not the presentation boundary. Sprint 5 proved these exact primitives on Astra 2026.1.2.1942, including `AddSlide` with count +1. |

## Can a proven per-editor primitive establish the boundary?

**Yes, without weakening fail-closed availability, if the probe is editor-specific and read-only.** Slide can require a non-null `GetPresentation()` plus the exact reader set used to address/read back a slide. Cell can require a non-null active sheet and sheets collection plus stable readable name/index and `GetSheet` resolution (and the range primitive needed by shipped reads). This still proves that the live editor exposes the same root, addressing, and readback family the shipped tool will use, and command transport/scope remain separately checked.

What it does **not** prove: a presence/read-only probe does not execute a mutation, prove every setter, or prove a future callback. That is already handled per operation by pre-mutation baselines, postcondition readback, and `APPLY_UNCERTAIN` after dispatch. Risk: a coarse “`GetPresentation` exists” or “`GetActiveSheet` exists” check alone would be weaker; the probe must check the complete minimal reader/address tuple used by that editor, without calling mutation methods.

## Minimal safe fix proposal (no code changed)

Keep the current dispatch/decoder/fail-closed structure, but replace the one Word-shaped presence tuple with a closed tuple selected by `editorType`:

- Word: retain the current six-slot probe.
- Slide: require `Api`, callable `GetPresentation`, non-null presentation, and callable `GetSlidesCount/GetCurrentSlide/GetCurSlideIndex/GetSlideByIndex` (optionally presence-only `AddSlide` for write advertisement; do not invoke it).
- Cell: require `Api`, callable `GetActiveSheet/GetSheets/GetSheet`, non-null active sheet, callable sheet `GetName/GetIndex/GetRange`, and a valid non-empty sheets collection (optionally presence-only `AddSheet`; do not invoke it).

Derive both availability flags from the matching editor tuple. Still fail closed on wrong editor identity, missing command transport, thrown/invalid callback, null root, missing required reader/address primitive, unusable `Asc.scope` for scoped tools, or any operation's own baseline/readback failure. Add focused tuple/decoder/controller tests only; do not relax the controller guard.