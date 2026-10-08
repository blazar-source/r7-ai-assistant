# Sprint 8 T3/T4 capability diagnosis

**Scope:** bounded cause investigation only, branch `stage-b`, HEAD `d10e76f`. No product behaviour was changed; editor PID `119782` was not killed/restarted; snapshot `02-astra-r7-clean` was not touched.

## Verdict

**PRODUCT DEFECT.** The live API-mounted session contains the exact startup context and SDK channels that the product requires (`Asc.plugin.info.editorType === "slide"`, own `callCommand`, `executeCommand`, and `executeMethod`, writable `Asc.scope`). The failure is therefore not caused by missing ribbon context and not a genuine SDK-boundary absence. The product advertises generic `document.read` and `document.write` to the runtime without deriving them from the bridge probe, while the Slide bridge later has concrete, callable, self-verifying read/mutation implementations. The observed `CAPABILITY_UNAVAILABLE` is a product-path refusal despite those prerequisites being present.

## Code trace: what must hold

1. Startup reads only `Asc.plugin.info.editorType`: `src/ui/entry.js:15-20`. On first `plugin.init`, that value is passed to `createR7Bridge`; there is no `initDataType`, `initData`, or init payload dependency: `src/ui/entry.js:33-47`.
2. Bridge editor identity is accepted only for `word|cell|slide`: `src/plugin/bridge.js:5929-5963`. Adapter proof is own-function presence: own `executeMethod`; and command dispatch from own `callCommand` or `executeCommand`: `src/plugin/bridge.js:5964-5972`.
3. Runtime editor identity is re-read from own data descriptors `plugin.info.editorType`: `src/plugin/bridge.js:6000-6005`.
4. Slide reads require initial editor `slide`, current editor still `slide`, not disposed, and own `callCommand`: `src/plugin/bridge.js:6012-6018`. Slide mutation entry points impose the same gate (`addSlide` at `src/plugin/bridge.js:7223-7235`; `setSlideText` at `7237-7250`). Parameters cross through writable/extensible `Asc.scope`; an absent/accessor/non-writable scope boundary becomes `CAPABILITY_UNAVAILABLE`: `src/plugin/bridge.js:5955,5985-5998,6671-6678`.
5. `probeCapabilities` does **not** run the authored native probe for Slide: any non-Word editor returns local `capabilities()` at `src/plugin/bridge.js:8288-8294`. That helper computes `selectionRead.available` using `editor === 'word' && adapter.executeMethod`, and hard-codes `mutation.available:false`: `src/plugin/bridge.js:6039-6045`.
6. `checkR7` nevertheless declares a Slide editor ready if its adapter object reports either `commandDispatch` or `executeMethod`, and merely counts the two booleans; `mutation.available:false` does not make the editor unavailable: `src/ui/controller.js:478-496`.
7. Actual agent runs bypass the probe result altogether: the controller hard-codes `CAPABILITIES=['document.read','document.write']` at `src/ui/controller.js:23-27` and passes them to `runAgent` at `304-305`. The registry maps read/mutate to those strings and offers tools from that static grant: `src/tools/registry.js:21,100-119`. Slide tools then call the concrete bridge and surface its closed refusal: `src/tools/slide.js:71-105`; the mutation descriptors are real auto tools requiring `document.write`: `src/tools/slide.js:109-117`.
8. The user-visible detail is the closed `CAPABILITY_UNAVAILABLE` label (`src/ui/view.js:23`). Separately, a `PREVIEW_READY` without an owned Word selection candidate is also mapped to that same status (`src/ui/controller.js:220-235`), so this wording is not itself proof that the vendor API is absent.

## Raw live probe

Full raw receipt: `.local/sprint8/capability-live-probe.log`.

```text
119782 /opt/r7-office/desktopeditors/DesktopEditors --ascdesktop-support-debug-info .../deck-open.pptx
HTTP=200
plugin frame: .../sdkjs-plugins/%7B7C91...%7D/index.html?lang=ru-RU&theme-type=light
Asc.plugin.info.editorType = "slide"
Asc.plugin.info.documentTitle = "deck-open.pptx"
executeMethod own value function = true
callCommand own value function = true
executeCommand own value function = true
Asc.scope own value, writable = true
Object.isExtensible(Asc) = true
initDataType own = false
initData own = false
final PID = 119782
```

The plugin's `info.data` also contains the product's authored six-boolean probe body, showing that initialization delivered editor context and command data. Prior raw target receipt `.local/sprint8/post-modal-capability.log` executed the same body through the command envelope and got:

```json
[true,true,true,true,true,true]
```

Therefore the APIs are **present and return the expected shape**. The session is not missing context required by this product.

## Mounting-route hypothesis

Rejected on current evidence. `run(guid,0,'')` produced `plugin.info.editorType:"slide"`, document identity/title, theme and the command body. Source startup consumes only `plugin.info.editorType`; it does not inspect `initDataType`, `initData`, or an `onInit` payload. The absent `initDataType/initData` properties therefore cannot explain this refusal. Supplying alternate init data would test a value the product never reads and was not attempted. A ribbon launch is not required to settle this code-defined dependency; if the controller still wants a route A/B for release optics, the owner can close/open only the plugin pane from the Ribbon while preserving the editor, then repeat this same descriptor probe, but it is not needed for the cause verdict.

## Regression check

Earlier evidence **did show real native mutations on this Astra/R7 target**, although as direct product bridge/tool bodies rather than the current AI composer journey:

- `docs/evidence/sprint-5/t1-slide-api-measurement.md:47-58`: `Api.AddSlide` succeeded with `GetSlidesCount +1`; `Duplicate` changed 2→3.
- `docs/evidence/sprint-5/t2-slide-tools-evidence.md:44-60`: shipped readers recorded `slidesCount=5`, then `slidesCount=6` after insertion.
- `docs/evidence/sprint-5/exit-gate-slide-evidence.md:33-39,84,103,170-172`: shipped `add_slide`/text/format mutations succeeded, independent readback showed three slides, and reopened-document readback preserved the result.

Thus the SDK boundary and concrete Slide mutation implementation have worked natively on Astra. What has not previously been proven is the complete credentialed composer-to-model-to-tool journey. The current supported product journey failing before transport is release-significant and is consistent with a product integration defect, not an incapable R7 build.

## Conclusion

**Verdict: product defect.** The API-mounted route supplies everything the source checks; exact SDK channels are present and the authored probe returns six `true` values; prior Astra evidence proves real native Slide mutations. The defect is the inconsistent capability integration: a non-Word probe locally reports read false/mutation false, `checkR7` still calls Slide ready, agent capabilities are hard-coded independently, and concrete Slide tools later operate behind stricter checks. No fix was made. The controller should decide whether to authorize a release-blocker correction under the release contract (`docs/superpowers/plans/2026-10-08-sprint-8-release-contract.md:46-58`).

## OWNER DECISION (2026-10-08) and the shape of the fix

The owner has ruled the capability gate a RELEASE DEFECT to fix, and has chosen the authorisation model
explicitly:

* **The probe must be real for every editor.** word, cell and slide alike perform the native check they are
  capable of performing; `selectionRead.available` and `mutation.available` are derived from the OBSERVED result,
  not from the editor's name and not from a constant.
* **The owned preview remains the authorisation for a mutation.** Changing the document still happens only through
  the panel's own preview/apply path. This fix corrects what the product CLAIMS, and does not remove or weaken the
  enforcement that decides what it may DO.
* **Fail-closed stays.** Where the native probe cannot be performed or cannot establish the boundary, the
  capability remains unavailable with a reason that describes the real condition - a probe failure must not borrow
  the owned-preview reason, and the owned-preview reason must not be used to describe an unprobed editor.

Implementation sites located by the diagnosis: `src/plugin/bridge.js:9` (the reason constant), `:6039-6046`
(`capabilities()` hard-codes word-only read and always-false mutation), `:8288-8294` (`probeCapabilities` returns
the local declaration for anything that is not word), `src/ui/controller.js:144` (the duplicated reason),
`:478-496` (the slide branch judges readiness from those flags) and `:23-27,304-305` (the agent's hard-coded
document read/write).

Process note, recorded because it matters: two implementation attempts died mid-task and left no result; both were
reverted, and the tree was clean before the third. The third attempt is required to work in small, complete steps
and to run the focused tests after each, so that an interruption can never leave a renamed symbol with surviving
old references - which is exactly how the first attempt broke.
