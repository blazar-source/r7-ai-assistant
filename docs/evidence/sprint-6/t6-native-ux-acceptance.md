# Sprint 6 / T6 — native UX acceptance

Date: 2026-10-07. Branch/bytes measured: `stage-b`, HEAD `8a15757`. This is measurement evidence only; no product or test file was changed.

## Scope and proof standard

Applied `docs/superpowers/plans/2026-10-07-sprint-6-ux-ui-refinement.md` §2 T6 and `docs/superpowers/plans/2026-10-07-sprint-6-ux-contract.md` §§5,7. No model request was made and no model credits were spent. The live editor was Slide on both stands. Word and Cell capability text was not raised in this run.

## 1. Tab / keyboard

### Windows — PASS for traversal and Send activation; Stop not activated

Command:

```powershell
1..12 | % { node .local/native-smoke/cdp.mjs editor-key tab; node .local/native-smoke/cdp.mjs eval-file 4 .local/sprint6/t6-tab-probe.js }
node .local/native-smoke/cdp.mjs editor-key enter
node .local/native-smoke/cdp.mjs eval 4 "JSON.stringify({active:document.activeElement.id,status:document.getElementById('status').textContent,prompt:document.getElementById('prompt').value})"
```

Raw observed order: `endpoint → model → apiKey → httpTimeoutSeconds → maxTokens → temperature → rememberKey → save-settings → test-connection → reset → prompt → send`. Raw file: `.local/sprint6/t6-windows-tabs.json`.

Enter on focused `#send` produced `{"active":"send","status":"Введите корректный ключ","prompt":"привет"}`. This proves native keyboard activation reached Send; validation stopped it before transport, so no model run occurred. Stop was not activated because a real active run is required to expose/enable it; starting such a run would spend model credits.

### Astra — NOT PERFORMED

The existing CDP helper became unresponsive while repeatedly attaching for native `Tab` dispatch. The process was stopped rather than claiming a traversal result. No Astra keyboard order or activation claim is made.

## 2. Visual focus and rendered colours

### Windows — PASS

Commands:

```powershell
node .local/native-smoke/cdp.mjs eval 4 "document.getElementById('prompt').focus(); 'ok'"
. .local/sprint6/capture-r7.ps1
# focus Send by native Tab, then run capture-r7.ps1 again
```

Screenshots:

* `.local/sprint6/t6-windows-focus-prompt.png`
* `.local/sprint6/t6-windows-focus-send.png`

Rendered surface focus is a visible blue border around the white textarea. The accent button shows a visible white outer ring around the blue button. Computed base colours measured in `.local/sprint6/t6-windows-geometry.json`: surface text `rgb(23,38,56)` on `rgb(243,245,248)`; input `rgb(23,38,56)` on white with border `rgb(120,133,150)`; primary action white on `rgb(23,77,156)`. This reports appearance only; T5 owns numerical contrast ratios.

### Astra — NOT PERFORMED

No trustworthy rendered screenshot was obtainable: `import -window root` on this stand returns a 249-byte blank PNG, and the plugin frame is not composited by CDP. Therefore no Astra pixel-level focus/colour claim is made.

## 3. Scroll + sticky composer

### Windows — PASS

Command:

```powershell
node .local/native-smoke/cdp.mjs eval-file 4 .local/sprint6/t6-native-probe.js > .local/sprint6/t6-windows-geometry.json
```

Raw geometry: frame `304×570`; document `scrollWidth/clientWidth=304/304`, `scrollHeight/clientHeight=570/570`; `#content` rect `x12..292, y205..326`, `clientHeight=121`, overflowing `scrollHeight=638`, `overflowY=auto`; composer `x12..292, y338..558`; Send `x12..106, y519..558`. With 40 injected lines, the first line was reachable at `y205..226` and the last at `y305..326`; composer and Send stayed at the same rects at both endpoints. No horizontal/document overflow occurred.

### Astra — PASS

Command:

```powershell
python .local/sprint6/astra-eval-once.py .local/sprint6/t6-scroll-simple.js > .local/sprint6/t6-astra-scroll.json
```

Raw geometry: exact frame `259×499`; document `scrollWidth/clientWidth=259/259`, `scrollHeight/clientHeight=499/499`; `#content` `x6..253, y86..359`, `clientHeight=273`, `scrollHeight=2401`, `overflowY=auto`; composer `x6..253, y365..493`; Send `x6..253, y454..493`. First injected line reachable at `y86..107`; last at `y338..359`; composer and Send did not move at either endpoint. This proves both endpoints are reachable, the composer stays visible, and content—not the document—scrolls.

Comparison: Astra is 45 px narrower and 71 px shorter, but gives content 273 px versus Windows 121 px because its compact composer is 128 px versus Windows 220 px.

## 4. Capability states rendered

### Windows — PARTIAL PASS (Slide only)

The live screenshot `.local/sprint6/t6-windows-live.png` shows the Slide diagnostics/capability text rendered, including `Stage B · редактор: slide · runtimeVerified: false`, the invalid-key guidance `Введите корректный ключ`, and the contextual note explaining ordinary Word text/change tracking does not apply in the current editor. This proves the Slide state gives a reason/context rather than only a code.

### Astra — PARTIAL PASS (Slide only)

The live DOM probe reported `frame 259×499`, status in the compact allowed set, and a diagnostics container. Existing live Astra precise evidence `.local/sprint6/astra-t3-precise.log` reports the technical `#editor` line inside collapsed `#diagnostics` and not visible on the main surface. However, no Astra screenshot exists, so this does not satisfy pixel proof.

Word and Cell were not raised cheaply in this session; no claim is made for them.

## 5. Geometry on both stands and UX-contract §7.9

### Windows — PASS

Frame `304×570`; key rects: content `x12..292,y205..326`; composer `x12..292,y338..558`; prompt `x12..292,y367..469`; Send `x12..106,y519..558`. All composer/input/action rects are fully inside the frame without document scrolling. Screenshot: `.local/sprint6/t6-windows-live.png`.

### Astra — PASS, exact §7 criterion

Commands:

```powershell
python .local/sprint6/astra-t3.py
python .local/sprint6/astra-t3-key.py > .local/sprint6/t6-astra-key.json
```

Exact frame: **259×499**. With a user and assistant message injected into live chat, raw rects were: user `y9..143`, assistant `y151..285`, composer `y365..493`, Send `y454..493`; all `visible:true`, `fully:true`; document `scrollHeight/clientHeight=499/499`. Therefore §7.9 **passes**: part of chat + compact input + primary action are visible immediately without document scrolling or opening diagnostics.

No Astra screenshot is claimed for the reason in §2.

## Windows-vs-Astra summary

| Check | Windows | Astra |
| --- | --- | --- |
| Tab / keyboard | PASS: complete observed order; Send activated without transport; Stop not exercised | Not performed: repeated CDP attach hung |
| Visual focus / colours | PASS, screenshots obtained | Not performed: screenshot path produces blank image |
| Scroll + sticky composer | PASS | PASS |
| Capability state | Partial: Slide rendered; no Word/Cell | Partial: Slide DOM/diagnostics; no screenshot, no Word/Cell |
| Geometry + §7.9 | PASS at `304×570` | PASS at exact `259×499` |

## WHAT THIS DOES NOT SHOW

* It does not show a real model run, terminal model status, or Stop activation; this was deliberately avoided to spend no model credits.
* It does not prove Word or Cell native capability states; only Slide was live.
* It does not provide an Astra screenshot or pixel-level Astra focus/colour proof. The stand's available root capture is blank and CDP does not composite the plugin frame.
* It does not provide Astra native Tab traversal because the repeated-attach CDP helper hung during that procedure.
* Injected overflow lines and chat messages are ephemeral DOM measurement fixtures; they do not test persistence or model transport.
