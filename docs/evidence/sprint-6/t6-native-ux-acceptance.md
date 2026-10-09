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

## 6. Follow-up closure attempt: Word and Cell capability text

This section supersedes the earlier statement that Word was not raised; Cell remains incomplete.

### Windows Word — PASS

Exact sequence:

```powershell
# Start R7, then use the native Ctrl+O picker to open the fixture.
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('^o')
[System.Windows.Forms.SendKeys]::SendWait((Resolve-Path '.local/native-smoke/disposable-smoke.docx').Path)
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
node .local/native-smoke/cdp.mjs editor-eval-file .local/astra/vendor-open.js
node .local/native-smoke/cdp.mjs eval 4 "JSON.stringify({status:document.getElementById('status').textContent,body:document.body.innerText})"
. .local/sprint6/capture-r7.ps1
```

Rendered text: `Готово к запросу`; `Stage B · редактор: word · runtimeVerified: false`; and the capability/diagnostic explanation `Обычный текст Word; активное отслеживание изменений не поддерживается. Перед Применить проверяются текущий редактор, контекст и точное непустое выделение. Проверка и запись не атомарны.` The same surface showed `Выделение неизвестно`, explaining why selection-dependent action was not yet available. Raw DOM: `.local/sprint6/t6-windows-word-capability.json`; OS screenshot: `.local/sprint6/t6-windows-word-capability.png`. This proves the vendor-opened Word panel renders editor-specific reason and next-step context rather than a bare code.

### Windows Cell — NOT COMPLETED

The Cell fixture was visible in the R7 recent list, but repeated real CDP double-clicks did not transition from the shell, and a later `Ctrl+O` attempt raised `editors.exe - Системная ошибка`. Stopping here avoids claiming a rendered Cell state that was not observed. No Cell screenshot is claimed.

### Astra Word / Cell — NOT COMPLETED

The Astra run still had the Slide fixture raised. The Word and Cell fixture relaunches were not completed within this acceptance pass, so no Astra Word/Cell rendered-text claim is made.

Comparison: Windows Word is now evidenced; Cell on Windows and both Word/Cell scenarios on Astra remain open.

## 7. Follow-up closure attempt: Astra native Tab/focus

A single persistent WebSocket CDP session was used to avoid the earlier repeated-attach hang. Exact driver: `.local/sprint6/astra-persistent-tabs.mjs`, copied and run by `.local/sprint6/astra-run-persistent.py`. It issued real `Input.dispatchKeyEvent` `rawKeyDown`/`keyUp` pairs with `key:'Tab'` and recorded `document.activeElement` after each event.

Result: **NOT PASSED**. Across 24 dispatched Tab pairs, `document.activeElement` remained `BODY`; `#prompt` was never reached (`promptIndex:-1`). Raw record: `.local/sprint6/t6-astra-tabs-persistent.json`. Therefore there is no honest Astra traversal order, Enter/Space activation result, or prompt-focus screenshot. The previously proven Astra OS screenshot route remains valid, but a screenshot cannot prove keyboard focus when native Tab never moved focus into the plugin frame.

Windows comparison remains the earlier complete order: `endpoint → model → apiKey → httpTimeoutSeconds → maxTokens → temperature → rememberKey → save-settings → test-connection → reset → prompt → send`. Astra observed order is only `BODY` repeated, which is a failed traversal rather than an accepted order.

## 8. Follow-up live model run for UX-B5

Command (one bounded paid request family, DeepSeek):

```powershell
$env:DECK_PROVIDER='deepseek'
$env:DECK_MAX_TOKENS='256'
node .local/exit-gate-slides/run-deck.mjs 4 *> .local/sprint6/t6-live-progress-run.log
```

Observed controller publication sequence: `R7_PRESENCE_READY → ANALYZING → ANALYZING → ANALYZING → ANALYZING → COMPLETE`; terminal compact state `COMPLETE` / agent `FINAL`, 2 steps, 1 tool call, 7.1 s. The tool call was `read_presentation`, ending `INVALID_DATA`, and the bridge reported a transport/CDP failure; therefore this run does **not** prove a successful editor mutation. It does prove that a live `deepseek-chat` request returned terminally through the product controller.

The driver records controller statuses, not the mounted panel DOM's `#progress-stage`; no alive-stage screenshot was obtained during the 7.1-second interval. Therefore UX-B5's required rendered stage sequence and permanent-input transition remain **not passed**. Model spend caused: one bounded `deepseek-chat` run with `maxTokens=256`, two model steps reported by the runtime; the provider response did not expose a currency charge, so the exact monetary amount is unknown and must not be invented.

## 9. T1 contract proof mapping for T2–T6

This table makes the plan's exit-gate dependency explicit: every downstream scenario references `docs/superpowers/plans/2026-10-07-sprint-6-ux-contract.md`.

| T1 contract requirement | T2 artifact | T3 artifact | T4 artifact | T5 artifact | T6 artifact |
| --- | --- | --- | --- | --- | --- |
| Real 304 px Windows / 259 px Astra frame; responsive rules (§2) | `docs/evidence/sprint-6/t2-panel-layout-evidence.md` geometry and screenshots | `docs/evidence/sprint-6/t3-main-screen-evidence.md` compact main-screen geometry | Unit/native capability work referenced by the Sprint 6 plan and final bytes | `tests/unit/view.test.js`, `tests/unit/styles.test.js` accessibility/responsive gate | This file §§3,5: Windows `304×570`, Astra exact `259×499` |
| Only content scrolls; first/last lines reachable; composer fixed and no horizontal overflow (§2.1–2.6) | T2 evidence, overflow probes and both-stand screenshots | T3 evidence confirms compact composer on final screen | T4 preserves the same layout while moving diagnostics | T5 regression tests for reduced motion/focus/contrast | This file §3 and raw `.local/sprint6/t6-windows-geometry.json`, `.local/sprint6/t6-astra-scroll.json` |
| Permanent input: present, enabled, in-frame, focusable, draft preserved through states (§3) | T2 establishes in-frame composer | T3 evidence is the primary proof for normal/error/cancel/mode/busy transitions | T4 keeps prompt present while capability/status surfaces change | T5 keyboard and focus tests; Windows native order in this file §1 | This file §§1–2 and §7; Windows passes, Astra native traversal remains failed |
| Closed capability states; disabled action has reason + next step; defaults do not pre-refuse (§4) | Layout only; capability not owned by T2 | Main-screen presentation reserves diagnostics/capability placement | `tests/unit/view.test.js` capability/status coverage and T4 implementation on final bytes | T5 verifies states remain keyboard/accessibility safe | This file §4 and §6: Slide both stands, Word Windows; Cell/both-Astra Word/Cell still missing |
| Vendor activation guidance (§4.1) | Panel/layout evidence uses vendor-opened live frames | T3 live screen uses vendor-opened frame | T4 human guidance is in final UI tests/implementation | T5 keyboard coverage includes exposed controls | This file's commands use `.local/astra/vendor-open.js`; live Word was opened through the vendor host |
| Visible closed progress stages + human terminal status (§4.2) | Not T2-owned | Permanent input must remain during busy state | `tests/unit/view.test.js` derives five phrases and removes them terminally | T5 aria/status semantics cover live and terminal announcements | This file §8: controller reached `COMPLETE`, but rendered DOM stage sequence/screenshot is still missing |
| Four-part evidence standard: screenshot, geometry, no clipping, reproducible both-stand scenario (§5) | T2 evidence file includes commands, geometry and live captures | T3 evidence file includes measured main screen and Astra criterion | T4 unit/native artifacts prove capability text on final bytes | T5 test gate plus Windows native focus images | This file §§1–5 and Astra correction; complete for geometry/scroll, incomplete for the newly requested Astra keyboard and Word/Cell matrix |
| Target main-panel UX points 1–10 (§7) | T2 supplies responsive substrate | T3 evidence owns chat-first layout, compact composer, status and 259×499 criterion | T4 owns diagnostics/capabilities and progress text | T5 owns focus, contrast, aria-live and recovery | This file measures final native geometry, focus/Tab where available, editor text where obtained, and records failures honestly |

## WHAT THIS STILL DOES NOT SHOW — final

* Cell capability/diagnostics text was not rendered and captured on Windows or Astra.
* Word capability/diagnostics was not rendered and captured on Astra; Windows Word passed.
* Astra native Tab remained in the outer `BODY`; it did not reach plugin controls, so there is no accepted Astra order, Enter/Space activation, or prompt focus-ring screenshot.
* The paid DeepSeek run reached terminal controller state, but no mounted-panel DOM poll or during-run OS screenshot captured the live human progress-stage text. The required rendered UX-B5 stage sequence and permanent-input transitions therefore remain unproved.
* The DeepSeek provider did not return a monetary charge in the harness output; spend is recorded only as one bounded `deepseek-chat` run (`maxTokens=256`, two model steps), not an invented currency amount.
* The live task's presentation bridge failed (`INVALID_DATA` / CDP transport failure), so it proves terminal status flow, not a successful document mutation.

## CORRECTION (later in the same session): the Astra screenshot EXISTS

The sections above say no Astra screenshot could be obtained. That was true of the ATTEMPTS made then, but the
method was wrong, not the stand. The OS-level capture used on Windows works on Astra too - the mistake was
capturing the X root window (which the Fly window manager does not draw into, hence the empty 249-byte PNG). The
right target is the desktop's own full-screen window.

Route, reproduced on the FINAL bytes:

  * the plugin the page loads lives at
    `/home/r7dev/.local/share/r7-office/editors/sdkjs-plugins/{7C91D48E-5F12-4B36-8A90-2DFA8467C013}`;
  * the build deployed there is `panel.js` sha256
    `bacb29385578d52883ae13d02ca4ac21cf69c035c77ee91ab0c9fd0fc6250a1f`, which equals the local final T5 build
    (verified by hash after the deploy);
  * R7 is raised as a unit (`systemd-run --user --unit=r7-t6 --collect env DISPLAY=:0
    XAUTHORITY=/home/r7dev/.Xauthority ... --ascdesktop-support-debug-info <deck>`), the plugin is opened through
    the vendor path, and the window list is read with `xwininfo -root -tree`;
  * the capture target is the desktop window `0xe00717` (`FlyLocker`, 2048x1536) - NOT `root`;
    `import -window 0xe00717` produced a real 77,622-byte PNG;
  * the panel itself is cropped at 2x scale: `convert astra-final.png -crop 518x998+80+336 +repage`.

Artifacts (kept outside the repository by path reference, under `.local/sprint6/astra/`):
`astra-final.png` (full desktop, 77,622 bytes), `astra-final-panel.png` (the panel, 26,342 bytes),
`astra-final-small.png` (whole window at 50%, 48,782 bytes).

What this settles: the Astra screenshot requirement of contract §5 is now met ON THE FINAL BYTES, by the same
OS-level method that produced the Windows captures. What it does NOT settle: the Astra keyboard traversal and the
Astra rendered-focus check still have not been performed (a screenshot shows appearance, not traversal), and the
capability states were still observed on Slide only.

## 10. Requested native closure measurements (2026-10-08)

### Point 1 — direct-file editor launch

Windows commands (no `Ctrl+O`):

```powershell
Get-Process | ? {$_.Path -like '*R7-Office*'} | Stop-Process -Force
Get-ChildItem "$env:LOCALAPPDATA\R7-Office" -Recurse -Force -Filter 'Singleton*' | Remove-Item -Force -Recurse
& 'C:\Program Files\R7-Office\Editors-2026.3.1\DesktopEditors.exe' --ascdesktop-support-debug-info `
  'D:\Astra_coding\r7-ai-assistant\.worktrees\stage-b\.local\native-smoke\disposable-smoke.docx'
# repeated with disposable-cell-inventory.xlsx
```

Both process command lines and window titles contained the requested real fixture path, but this Windows build stayed on the Recent-files shell (`index.html?waitingloader=yes`): CDP exposed only contexts 1 and 3, no editor/plugin context, and `editor-eval-file` returned `no editor or plugin context found` (`contexts:2`). Therefore the direct process invocation did not furnish new Word/Cell rendered capability text. The prior valid Windows Word surface remains `.local/sprint6/t6-windows-word-capability.json` and screenshot `.local/sprint6/t6-windows-word-capability.png`; a shell screenshot from the requested direct invocation is `.local/sprint6/t6-windows-word-direct.png` and must not be mislabelled as panel evidence. Cell remains unproved.

Astra exact launch route was reproduced via:

```sh
pkill -f DesktopEditors || true
systemd-run --user --unit=r7-t6 --collect env DISPLAY=:0 XAUTHORITY=/home/r7dev/.Xauthority \
  /opt/r7-office/desktopeditors/DesktopEditors --ascdesktop-support-debug-info \
  /home/r7dev/r7-verification/stage-b/gate/deck-open.pptx
```

It reached a presentation target and produced the real OS capture below, but the requested Word/Cell fixture matrix was not completed on Astra in this pass. Thus Point 1 adds an honest launch-path measurement, not a new capability-state pass.

### Point 2 — Astra focus-first native Tab

The persistent CDP probe was changed only as measurement instrumentation: after `Runtime.enable`/`Page.enable`, it called `Page.bringToFront`, then `window.focus()` in plugin context 4 before real `Input.dispatchKeyEvent` Tab pairs. Exact observed sequence in `.local/sprint6/t6-astra-tabs-focused.json`:

`new-chat → SUMMARY → prompt → send → BODY` (then `BODY` repeated).

This corrects the earlier BODY-only result: native keyboard events reached the plugin document after target/frame focus. The sequence is short because the settings disclosure was collapsed; only currently rendered/focusable controls participated. A prompt-focus OS screenshot was attempted through `xwininfo -root -tree`, the 2048×1536 `FlyLocker` window, `import -window`, and `convert ... -crop 518x998+80+336 +repage`. Artifact: `.local/sprint6/astra/t6-astra-prompt-focused-panel.png` (26,342 bytes). However the capture helper relaunched the editor before capture, so it does **not** preserve the prompt focus established by the traversal and is not accepted as rendered-focus proof.

Windows comparison remains the expanded-settings order `endpoint → model → apiKey → httpTimeoutSeconds → maxTokens → temperature → rememberKey → save-settings → test-connection → reset → prompt → send`.

### Point 3 — live-run mounted-DOM observation

One additional bounded DeepSeek run was made with `DECK_PROVIDER=deepseek`, `DECK_MAX_TOKENS=128`. Controller sequence in `.local/sprint6/t6-live-progress-run-2.log` was `R7_PRESENCE_READY → ANALYZING → ANALYZING → ANALYZING → ANALYZING → COMPLETE`; it again ended with bridge `INVALID_DATA`/transport failure and no mutation.

The second CDP poll was started at roughly 1 s cadence, but because the direct-file launch had not yielded an editor/plugin context, `.local/sprint6/t6-live-panel-sequence.jsonl` remained 0 bytes. The during-run OS capture `.local/sprint6/t6-windows-live-during-run.png` is 33,140 bytes but shows the shell, not an alive mounted panel, and is therefore not accepted as UX-B5 proof. Terminal controller status was `COMPLETE`; terminal mounted-panel compact status was not observed. Spend: one additional bounded `deepseek-chat` request family, `maxTokens=128`; exact currency was not returned.

### Point 4 — proof-mapping delta

| Requirement newly targeted | New measurement | Proof status |
| --- | --- | --- |
| Direct-file Word/Cell launch, rendered reason + next step | Windows commands above; prior Word JSON/PNG retained | Word/Windows already proven; Cell and Astra Word/Cell still open because direct launch stayed on shell / matrix not completed |
| Astra focus-first keyboard traversal | `.local/sprint6/t6-astra-tabs-focused.json` | **Proven on Astra:** `new-chat → SUMMARY → prompt → send → BODY`; rendered prompt focus not proven |
| UX-B5 mounted DOM advances during real run | controller log, empty DOM poll, shell screenshot | **Not proven:** controller advances, but mounted `#progress-stage`/`#status` did not get sampled |
| Both-stand screenshot route | Windows OS capture and Astra FlyLocker capture/crop | Capture mechanisms proven; the specific alive-stage and Astra focused-prompt states remain uncaptured |

## WHAT THIS STILL DOES NOT SHOW — closure delta

* No new rendered Cell capability/diagnostics state exists on either stand; Astra Word is also still absent.
* The Windows direct-file command line contained the real DOCX/XLSX path, but the application remained on the Recent-files shell and exposed no editor/plugin context.
* Astra native traversal now reaches `new-chat`, `SUMMARY`, `prompt`, and `send`, but the saved screenshot does not preserve prompt focus because the capture helper relaunched the editor.
* No mounted-panel `#progress-stage`/`#status` sequence was captured during either paid run; only the controller status sequence advanced.
* The during-run Windows image is a shell capture, not evidence of an alive panel stage.
* The latest run again proves terminal controller flow, not successful presentation mutation.

## 11. Final native-closure attempt with the R7 bridge available (2026-10-08)

This append is measurement-only. `git status --short` was empty before this append; no product or test file was changed, and no commit/push/full-suite command was run. The newly installed `dsh-r7-office` bridge initially reported `connected:true, clientCount:2, developerMode:false`; safe `getDocumentText` / `getSelectedText` requests then timed out at 5000 ms, so bridge connectivity alone did not open another editor document.

### 11.1 Word and Cell capability, native editor routes

Windows clean-launch command (repeated with DOCX and XLSX):

```powershell
Get-Process | ? {$_.Name -match '^(DesktopEditors|editors|editors_helper)$' -or $_.Path -like '*R7-Office*'} |
  Stop-Process -Force
Get-ChildItem "$env:LOCALAPPDATA\R7-Office" -Recurse -Force -Filter 'Singleton*' | Remove-Item -Force -Recurse
Start-Process 'C:\Program Files\R7-Office\Editors-2026.3.1\DesktopEditors.exe' `
  -ArgumentList @('--ascdesktop-support-debug-info','<fixture>')
# poll http://127.0.0.1:8080/json/list for documenteditor/spreadsheeteditor
```

Measured symptom: after 90 s the XLSX direct route still exposed only `index.html?waitingloader=yes`; process command line contained the exact fixture. Launching the inner `editors.exe` instead produced a single process but no CDP listener. Therefore no new Windows Cell panel was fabricated. Windows Word remains the prior valid native proof: `.local/sprint6/t6-windows-word-capability.json` and `.local/sprint6/t6-windows-word-capability.png`, with `Готово к запросу`, `Stage B · редактор: word · runtimeVerified: false`, and `Обычный текст Word; активное отслеживание изменений не поддерживается. Перед Применить проверяются текущий редактор, контекст и точное непустое выделение. Проверка и запись не атомарны.`

Astra command, first Word then Cell:

```sh
pkill -f /opt/r7-office/desktopeditors/DesktopEditors
systemd-run --user --unit=r7-t6-<editor>-<timestamp> --collect \
  env DISPLAY=:0 XAUTHORITY=/home/r7dev/.Xauthority \
  /opt/r7-office/desktopeditors/DesktopEditors --ascdesktop-support-debug-info <fixture>
# poll /json/list; then invoke t1-open-panel.js and t1-click-plugin.js in editor context 2
```

Raw target proof: Word reached `.../apps/documenteditor/main/index.html`; Cell reached `.../apps/spreadsheeteditor/main/index.html` with `doctype=spreadsheet`; each then exposed plugin context 4. Raw panel files: `.local/sprint6/t6-astra-word-capability.json`, `.local/sprint6/t6-astra-cell-capability.json`. Rendered diagnostic badges were `Stage B · редактор: word · runtimeVerified: false` and `Stage B · редактор: cell · runtimeVerified: false`; compact status was `Готово`. The normal native panel did not render the detailed closed capability paragraph without an explicit `Проверить Р7`, so the only observed action explanation was the disabled Apply reason: `Кнопка станет доступна: сначала отправьте запрос в режиме правки. Необработанный ответ не будет применён. Срок предложения — 120 секунд. Команда Undo выполняется вручную.` This is reason + next step for Apply, but not the requested per-editor capability-check result.

Requested OS screenshots were attempted with `xwininfo` + `import`; the files `.local/sprint6/astra/t6-astra-word-capability.png` and `.local/sprint6/astra/t6-astra-cell-capability.png` are invalid evidence because the first matching `FlyLocker` window was the lock screen, not the editor. After `loginctl unlock-session 3`, the editor window capture `.local/sprint6/astra/t6-astra-prompt-focus-valid-full.png` showed the spreadsheet but not the side panel; it is also not capability proof. Thus comparison is: Windows Word PASS; Windows Cell not observed; Astra Word/Cell editor/plugin identities observed in DOM, but rendered capability text + valid panel screenshots remain incomplete.

### 11.2 Astra prompt focus

Exact focus/capture sequence (no editor relaunch between focus and capture):

```sh
# one persistent CDP connection
Page.bringToFront
window.focus(); document.getElementById('new-chat').focus()
# native Tab pairs until prompt; verify document.activeElement
xwininfo -root -tree
DISPLAY=:0 XAUTHORITY=/home/r7dev/.Xauthority import -window <editor-window> <out.png>
```

Raw sequence in the focused probe: `SUMMARY → prompt`; combined with the previously recorded whole traversal it remains `new-chat → SUMMARY → prompt → send → BODY`. Immediately before capture: `active:"prompt"`; computed focus styling: `outline: rgb(9, 92, 204) solid 3px`, `box-shadow: rgb(255, 255, 255) 0 0 0 5px`, border `rgb(120, 133, 150) 1px solid`. However the requested visual proof is still invalid: before unlock the mandated FlyLocker capture showed only the lock screen; after unlock the direct 1024×720 editor capture did not composite the plugin side panel. Screenshot path recording the symptom: `.local/sprint6/astra/t6-astra-prompt-focus-valid-full.png` (SHA-256 `117441e224d9280db7262e0a477f505c7de785941fe517e93ae74c190931d027`). DOM focus is valid; focus-ring pixels are not.

### 11.3 UX-B5 live progress sequence

No additional paid model run was started. The prerequisite order could not be satisfied with a trustworthy visible panel: on Windows the clean file route remained the Recent-files shell; on Astra the plugin DOM existed, but the OS capture path exposed either the lock screen or an editor window without the plugin panel. Starting another bounded request would have spent credits while leaving the decisive rendered screenshot condition unmet.

Therefore the only observed live sequence remains the previous controller sequence `R7_PRESENCE_READY → ANALYZING → ANALYZING → ANALYZING → ANALYZING → COMPLETE`, terminal controller status `COMPLETE`; no mounted `#progress-stage` / compact `#status` sample sequence was obtained, so UX-B5 still does not pass. Model spend added by this final attempt: **zero**. Cumulative documented spend remains two bounded `deepseek-chat` request families (`maxTokens=256` and `128`); provider currency was not returned.

## WHAT THIS STILL DOES NOT SHOW — final native closure

* Windows Cell capability/diagnostics text and screenshot were not obtained; the fully killed/Singleton-cleared direct XLSX route still ended on the shell.
* Astra reached real Word and Cell editor pages and plugin context 4, but the detailed per-editor capability-check result was not rendered/captured; only editor identity, compact Ready status, and the disabled Apply reason/next step were observed.
* The Astra prompt was genuinely active and had measured focus CSS, but neither available OS window capture composited the focused plugin pixels. The saved image is a symptom artifact, not a valid focus-ring screenshot.
* No rendered mounted-panel UX-B5 stage sequence or during-run panel screenshot exists. Controller-only `... → COMPLETE` remains insufficient.
* No new model credits were spent in this final attempt; exact currency for the two earlier bounded runs remains unavailable.

## 12. Remaining native-proof closure attempt (2026-10-08, ordered A–D)

This append records measured results only. No product/test file, commit, push, or full-suite command was used.

### A. Astra focus-ring pixel proof — NOT VALID

Commands:

```sh
loginctl unlock-session 3
DISPLAY=:0 XAUTHORITY=/home/r7dev/.Xauthority xwininfo -root -tree
DISPLAY=:0 XAUTHORITY=/home/r7dev/.Xauthority import -window 0xf7ab4d throwaway-unlocked.png
# CDP in plugin context 4: Page.bringToFront; window.focus(); prompt.focus(); verify activeElement
DISPLAY=:0 XAUTHORITY=/home/r7dev/.Xauthority import -window 0xf7ab4d t6-astra-prompt-focus-full.png
convert <2x source> -crop 518x998+80+336 +repage t6-astra-prompt-focus.png
```

The throwaway capture `.local/sprint6/astra/throwaway-unlocked.png` is 6,663 bytes and shows the spreadsheet editor rather than the lock screen, so unlock was confirmed. Immediately before capture the plugin DOM reported `active:"prompt"`, `outline: rgb(9, 92, 204) solid 3px`, `boxShadow: rgb(255,255,255) 0 0 0 5px`, and border `rgb(120,133,150) 1px solid`. Nevertheless, the desktop/compositor window available in the current 1024×720 session did not composite the plugin panel. `.local/sprint6/astra/t6-astra-prompt-focus.png` is only 5,264 bytes on disk and shows the spreadsheet grid, unlike the known-good 26,342-byte panel crop. Therefore DOM focus is valid but the requested pixel proof is not.

Windows comparison: Windows has valid prompt/Send focus captures; Astra does not yet have a valid focused-panel crop.

### B. Astra Word and Cell capability proofs — NOT CLOSED

The exact panel-DOM text successfully read in the preceding native editor launches was:

* Word: compact `Готово`; identity `Stage B · редактор: word · runtimeVerified: false`; visible panel body `R7 AI Assistant / Новый чат / Готово / Диагностика / Отправить`.
* Cell: compact `Готово`; identity `Stage B · редактор: cell · runtimeVerified: false`; visible panel body `R7 AI Assistant / Новый чат / Готово / Диагностика / Отправить`.

The detailed per-editor capability paragraph was not present in either captured panel DOM. The only detailed action explanation previously observed was shared rather than editor-specific: `Кнопка станет доступна: сначала отправьте запрос в режиме правки. Необработанный ответ не будет применён. Срок предложения — 120 секунд. Команда Undo выполняется вручную.` The current Word relaunch command reached a process with the requested DOCX path but did not expose a `documenteditor/main` target within 120 s, so no stronger text or screenshot was fabricated. Existing screenshot paths `.local/sprint6/astra/t6-astra-word-capability.png` and `.local/sprint6/astra/t6-astra-cell-capability.png` remain invalid lock-screen captures from the earlier attempt.

Windows comparison: Word remains valid on Windows with its detailed paragraph; Windows Cell and both detailed Astra paragraphs remain absent.

### C. UX-B5 rendered progress-stage sequence — NOT RUN; spend 0

Required prerequisite order was checked first: editor → panel mounted and visible in the desktop capture → bounded product-path run. The Astra desktop capture still omitted the mounted plugin panel even while plugin context 4 and `activeElement=prompt` were live. Starting another paid request would therefore have repeated the known failure mode without satisfying the decisive during-run screenshot requirement. No additional request was made.

Observed sequence remains controller-only from the prior bounded runs: `R7_PRESENCE_READY → ANALYZING → ANALYZING → ANALYZING → ANALYZING → COMPLETE`; terminal controller status `COMPLETE`. No mounted `#progress-stage` / compact `#status` sequence exists. Spend added here: **0**. Cumulative documented spend remains two bounded `deepseek-chat` request families (`maxTokens=256` and `128`); exact currency was not returned.

Windows comparison: the prior Windows during-run image was the shell, not a mounted panel; neither stand closes UX-B5.

### D. Windows Cell — one bounded attempt, measured platform symptom

Exact command shape:

```powershell
Get-Process | ? { $_.Name -match '^(DesktopEditors|editors|editors_helper)$' -or $_.Path -like '*R7-Office*' } | Stop-Process -Force
Get-ChildItem "$env:LOCALAPPDATA\R7-Office" -Recurse -Force -Filter 'Singleton*' | Remove-Item -Force -Recurse
Start-Process 'C:\Program Files\R7-Office\Editors-2026.3.1\DesktopEditors.exe' -ArgumentList @('--ascdesktop-support-debug-info','<real disposable-cell-inventory.xlsx>')
# poll http://127.0.0.1:8080/json/list for 120 s
```

Raw result: `spreadsheetEditor:false`. The target list contained only `apps/api/documents/index.html?placement=desktop&doctype=spreadsheet&...title=disposable-cell-inventory.xlsx` plus `index.html?waitingloader=yes`; no `spreadsheeteditor/main` page appeared. The inner process command line did contain the exact real XLSX path. Per instruction, attempts stopped here. This is the Windows-specific native-shell symptom; Astra had previously reached a real `spreadsheeteditor/main` page.

## WHAT THIS STILL DOES NOT SHOW

* A valid Astra pixel capture of the focused prompt: the prompt was active with the expected computed focus ring, but the current desktop capture contained only the editor grid, not the panel.
* Detailed per-editor Astra Word/Cell capability paragraphs and valid panel screenshots; only compact Ready, identity badges, and the shared disabled-Apply explanation were observed.
* A rendered mounted-panel UX-B5 sequence or during-run panel screenshot on either stand; controller-only states are insufficient.
* A Windows `spreadsheeteditor/main` page or Cell panel; the single bounded clean launch remained on the documents/recent shell.
* A successful model-driven document mutation. No new spend occurred in this closure attempt.

## STAGE VERDICT: ACCEPTED WITH PLATFORM-EVIDENCE LIMITATIONS

Sprint 6 is closed as ACCEPTED WITH PLATFORM-EVIDENCE LIMITATIONS. The items below were NOT proven natively on the
stands available in this environment. They are NOT pass, and nothing in this file or in the stage's commits may be
read as claiming otherwise.

1. **Windows Cell - the full UX journey was not exercised.** A clean launch (every R7 process killed, `Singleton*`
   cleared) on a real `.xlsx` DOES receive the file - the exact path appears in the process command line - but the
   debug endpoint exposes only the api documents page with `doctype=spreadsheet` plus the Recent-files shell, never
   `spreadsheeteditor/main`. The editor and plugin contexts are therefore unreachable on that stand, so the Cell
   journey (capability text, panel, apply/cancel, mutation) was not observed on Windows.
2. **Astra Word and Cell - no valid PIXEL screenshot.** The editors DO open natively (`documenteditor`,
   `spreadsheeteditor`) and the panel's DOM is readable for both: compact status `Готово`, the identity badge
   `Stage B · редактор: word` / `cell · runtimeVerified: false`, and the main-screen body
   `R7 AI Assistant / Новый чат / Готово / Диагностика / Отправить`. But the panel is not composited into the
   captured window: the crop is 5,264 bytes and shows the grid with no panel, against the known-good 26,342-byte
   panel crop. The earlier Word/Cell captures were lock-screen artifacts. No detailed per-editor capability
   paragraph rendered either, so the Astra Word/Cell evidence is identity and action state, not a capability pass.
3. **Astra focus-ring pixels were not captured.** Focus was verified in the DOM immediately before the capture
   (`activeElement` = prompt, computed ring `outline rgb(9,92,204) solid 3px` with a white 5px box-shadow), but the
   pixel proof failed for the same non-compositing reason as (2).
4. **UX-B5 - no live-render capture of the progress stages.** The controller-side sequence was observed
   (`R7_PRESENCE_READY -> ANALYZING x4 -> COMPLETE`, terminal `COMPLETE`), but the rendered `#progress-stage` and
   compact `#status` sequence from a MOUNTED panel was never recorded, because its prerequisite - a visible mounted
   panel on Astra - is exactly what fails. No additional model spend was incurred for it.

What IS proven natively and stands: the Astra screenshot on the final bytes (contract section 5 for Astra), the
section 7.9 criterion on the target stand (frame exactly 259x499 with the user message, the assistant message, the
composer and Send all fully visible with the document at 499/499 and no scrolling), scroll with a pinned composer on
BOTH stands, the Windows Tab order with Send activated without a model request, the Windows Word capability text and
screenshot, the Astra Tab order with the events reaching the panel, a live run reaching a real terminal status, and
the Astra Word/Cell panel identity and action state in the DOM.

Scope: no product or test byte was changed by any of these attempts. The limitations above are properties of the
stands, not defects of the product code.
