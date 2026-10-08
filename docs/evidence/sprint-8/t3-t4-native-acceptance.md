# Sprint 8 T3/T4 — native acceptance

## Corrected-byte rerun — commit `2e64c0ef019b3ef985163a4eb9434ea298265cee`

**Status: PARTIAL / REQUIRED JOURNEYS NOT VERIFIED.** The corrected DEB installation, exact-tuple preflight, direct per-user activation, plugin load path and loaded-byte identity passed. The three paid product-path requests could not be run because no DeepSeek/OpenRouter model credential was available to this delegated runtime; therefore Word, Cell and Slide end-to-end mutation/readback remain **NOT VERIFIED**, not silently replaced by direct tool calls or historical runs.

### Install and corrected activation — PASS

The transferred DEB hash was `4b54302a747fac03c0af1c39099ca7791357f6fe2a5d56e940c1fb5f69e9122a`. Genuine `sudo dpkg -i` succeeded. The shipped `/usr/bin/r7-ai-assistant-preflight` accepted exactly Astra `1.7.9` build `1.7.9.41`, `r7-office 2026.1.2-1942~astra-signed amd64`, executable `2026.1.2.1942`. The documented activation copied `/usr/share/r7-ai-assistant/plugin/.` into the brace-GUID target. The resulting target contained the eight payload files directly, including:

`$HOME/.local/share/r7-office/editors/sdkjs-plugins/{7C91D48E-5F12-4B36-8A90-2DFA8467C013}/panel.js`

Its hash was `bacb29385578d52883ae13d02ca4ac21cf69c035c77ee91ab0c9fd0fc6250a1f`; the nested `{GUID}/{GUID}` path did not exist. Receipt: `.local/sprint8/install-current.log`.

### Loaded bytes — PASS

Word, Cell and Slide each loaded a plugin frame whose URL was the corrected per-user brace-GUID path. In the mounted Slide frame, fetching `panel.js` relative to that exact frame and hashing the bytes with Web Crypto returned `bacb29385578d52883ae13d02ca4ac21cf69c035c77ee91ab0c9fd0fc6250a1f`, equal to the frozen packaged hash. Receipts: `.local/sprint8/word-load-probe.log`, `cell-load-probe.log`, `slide-load-probe.log`, and `loaded-panel-hash.log`.

### Word journey

**NOT VERIFIED.** A real `.docx` was raised through `systemd-run --user ... DesktopEditors --ascdesktop-support-debug-info`, and the corrected plugin frame mounted. No model credential was available, so no real request was sent and no before/after document-content readback exists. Terminal status and UX-B5 run sequence were not measured.

### Cell journey

**NOT VERIFIED.** A real `.xlsx` was raised and the corrected plugin frame mounted. No model credential was available, so no real request was sent and no before/after workbook readback exists. Terminal status and UX-B5 run sequence were not measured.

### Slide journey

**NOT VERIFIED.** A real `.pptx` was raised and the corrected plugin frame mounted. No model credential was available, so no real request was sent and no before/after presentation readback exists. Terminal status and UX-B5 run sequence were not measured.

### UX-B5 and pixels

The mounted idle panel was observed with compact status `Готово` and an empty `#progress-stage`. No advancing sequence or terminal run status exists because dispatch could not begin. `xwininfo -root -tree` found the native R7 window. The prescribed `import -window <id>` command did not produce a file, so no pixel capture is valid; the measured symptom is recorded in `.local/sprint8/loaded-hash-capture.log`.

### Model spend

Zero calls and zero spend. DeepSeek/OpenRouter credentials were unavailable in the delegated runtime, so the bounded three-journey budget was not consumed.

### Safety and final stand state

Before mutation, the package state, activated plugin and process list were backed up at `/tmp/r7-ai-sprint8-current-20261008T153847`. The prior per-user plugin was restored from that backup after probing. The RC package was already installed before this rerun and remains installed at the same version. The currently running editor was left open rather than risking unsaved work. Snapshot `02-astra-r7-clean` was never restored or modified. Receipt: `.local/sprint8/final-stand-state.log`.

## Earlier stopped acceptance — preserved history


**Status: BLOCKED BEFORE TARGET MUTATION / NOT VERIFIED.**

## Scope and release identity preflight

The requested source worktree was inspected before any operation on the Astra stand:

- branch: `stage-b`;
- clean HEAD: `6a2e1231dc5f9025d8cdb7c6ce5febab6ccfefaa`;
- `package.json` version at inspected commit `6a2e1231`: `0.9.0-pilot-dev` (historical preflight fact, superseded in the later RC-preparation tree);
- expected final version under the Sprint 8 release contract: `0.9.0-pilot-rc`;
- `dist/`: no release artifacts present.

The release contract requires the RC version to be committed and frozen before the release commit is pinned, then requires ZIP, DEB, SBOM, and checksums to be built from that exact commit and native acceptance to identify those exact bytes. Building from the supplied commit would instead produce development-labelled artifacts and could not constitute acceptance of the final shipped set.

Under the release contract, inability to identify and test the final shipped bytes is a release blocker. Work therefore stopped before installation or any target mutation rather than silently substituting Sprint 7 bytes or newly built development bytes.

Raw preflight observations are retained in `.local/sprint8/t3-t4-preflight-blocker.log`.

## Word journey

**NOT VERIFIED.** No final RC DEB/ZIP exists at the supplied clean commit, so no final-byte Word run was attempted.

- terminal status: not observed;
- document content before/after: not measured;
- mounted-panel UX-B5 sequence: not measured;
- pixel capture: not taken;
- panel activated-path/hash comparison: not measured.

## Cell journey

**NOT VERIFIED.** No final RC DEB/ZIP exists at the supplied clean commit, so no final-byte Cell run was attempted. The earlier Astra native `spreadsheeteditor` evidence is historical and was not reused as proof for different bytes.

- terminal status: not observed;
- document content before/after: not measured;
- mounted-panel UX-B5 sequence: not measured;
- pixel capture: not taken;
- panel activated-path/hash comparison: not measured.

## Slide journey

**NOT VERIFIED.** No final RC DEB/ZIP exists at the supplied clean commit, so no final-byte Slide run was attempted.

- terminal status: not observed;
- document content before/after: not measured;
- mounted-panel UX-B5 sequence: not measured;
- pixel capture: not taken;
- panel activated-path/hash comparison: not measured.

## Installation, activation, and invariants

**NOT VERIFIED for Sprint 8 final bytes.** Genuine `dpkg -i`, shipped compatibility preflight, and per-user activation were not run because the final shipped artifact set is absent. Consequently the installed inventory and absence of daemon/service/listener/Node/MCP/TCP/WebSocket bridge/key material/endpoint were not re-measured for RC bytes. Sprint 7 records remain historical evidence only.

## Model spend

Zero calls; zero spend.

## Final stand state

The Astra stand was not contacted or changed. The preserved snapshot `02-astra-r7-clean` was not restored, modified, or otherwise touched. No backup was necessary because no target lifecycle action began. The stand remains in its prior relevant state.

## What this does not show

This report does not establish installation, compatibility acceptance, activation, panel load, hash identity, semantic Word/Cell/Slide behavior, Preview/Apply behavior, terminal UI truthfulness, UX-B5 progress sequence, document mutation, or pixel composition for `0.9.0-pilot-rc`. T3/T4 must be rerun after T6/T7 provides the frozen final artifact tuple and its hashes at a pinned release commit.

## Final credentialed attempt — HEAD `db33b99bd90feaf6d46d60ada8f8eeb8251a98b0`

**Status: NOT VERIFIED.** The credential precondition passed, but the product journeys did not: before this attempt, the mounted Slide panel was reachable over CDP at the activated brace-GUID path. The machine credential file was readable and contained `DEEPSEEK_API_KEY` (35 characters; only `sk-***` was logged). No key value was written to evidence. During lifecycle setup, the existing R7 instance was terminated and attempts to raise fresh Word, Cell, and Slide instances with `--ascdesktop-support-debug-info` failed before a CDP listener appeared (`ECONNREFUSED 127.0.0.1:8080`). A visible trial-version modal was measured on the unlocked desktop; headless launches then exited immediately. Because the mounted panel could not be reached after that point, **zero model requests were dispatched and zero model spend occurred**. No product defect is claimed: the measured blocker is stand/editor lifecycle state, not an observed product-path failure.

### Credential and initial mounted product-path probe

Commands (secrets masked in the receipt):

```text
python .local/sprint8/credential_product_probe.py
cd /home/r7dev/r7-verification/stage-b
CDP_BASE=http://127.0.0.1:8080 /home/r7dev/node/bin/node cdp.mjs contexts
```

Raw observation: `credential_readable=true length=35 masked=sk-***`. The live CDP inventory returned a presentation editor plus plugin context id `4`, with URL `file:///home/r7dev/.local/share/r7-office/editors/sdkjs-plugins/%7B7C91D48E-5F12-4B36-8A90-2DFA8467C013%7D/index.html...`, `hasStatus:true`, and `hasPrompt:true`. This proves the credential was readable and a real mounted product panel existed. It does **not** prove that a model request traversed that panel; no request was dispatched before lifecycle setup lost CDP reachability. Receipt: `.local/sprint8/credential-product-probe.log`.

### Word journey — NOT VERIFIED

Attempted commands:

```text
pkill -TERM -f '/opt/r7-office/desktopeditors/DesktopEditors' || true
systemd-run --user --unit=sprint8-word-... --collect /opt/r7-office/desktopeditors/DesktopEditors --ascdesktop-support-debug-info /tmp/sprint8-word.docx
CDP_BASE=http://127.0.0.1:8080 node cdp.mjs editor-eval-file .../vendor-open.js
CDP_BASE=http://127.0.0.1:8080 node cdp.mjs contexts
```

Raw observation: the transient unit was accepted, but both CDP commands failed with `connect ECONNREFUSED 127.0.0.1:8080`. Therefore the panel controls could not be configured or submitted, terminal compact status was not observed, and no before/after SDK content pair exists. Outcome: **NOT VERIFIED**, not pass or fail.

### Cell journey — NOT VERIFIED

The same command sequence was attempted with `/tmp/sprint8-cell.xlsx`; the measured result was the same `ECONNREFUSED 127.0.0.1:8080`. No model request, terminal status, or workbook before/after readback exists. Outcome: **NOT VERIFIED**.

### Slide journey — NOT VERIFIED

The same command sequence was attempted with `/tmp/sprint8-slide.pptx`; the measured result was the same `ECONNREFUSED 127.0.0.1:8080`. A later attempt to reopen the prior `gate/deck-open.pptx` via `nohup ... --ascdesktop-support-debug-info` also exited immediately and exposed no `8080` listener. No model request, terminal status, or presentation before/after readback exists. Outcome: **NOT VERIFIED**.

The complete exact command stream and raw stderr are in `.local/sprint8/journeys.log`; reopen diagnostics are `.local/sprint8/reopen.log` and `.local/sprint8/reopen2.log`.

### UX-B5 — NOT VERIFIED

No journey reached dispatch, so there is no measured advancing or terminal sequence. The only earlier mounted observation remains the idle compact `Готово` with empty `#progress-stage`; this attempt did not add a running measurement. It would be false to infer `Анализирую → Выполняю → Проверяю → terminal` from the implementation.

### Astra pixel captures

The prescribed unlock command succeeded:

```text
loginctl unlock-session 3
loginctl show-session 3 -p LockedHint -p Active -p State
```

Raw state was `Active=yes`, `State=active`, `LockedHint=no`. A throwaway root capture succeeded (`1024x768`, 27,425 bytes) and visibly showed the R7 desktop, not the lock screen. It also showed a centered trial-version modal over `deck-open.pptx`. That file, `.local/sprint8/captures/throwaway-root.png`, is a **valid stand-state diagnostic**, but it is **not a valid product-panel acceptance capture**. No FlyLocker/panel crop was produced because no journey editor remained running when `xwininfo`/`import` could be applied.

### Exact model spend

- DeepSeek requests dispatched through the product: `0`.
- Prompt tokens, completion tokens, and billed cost: `0` / `0` / `0`.
- Reason: dispatch never began; CDP became unreachable during editor lifecycle setup.

### Backup, restoration, and final stand state

Before lifecycle work, the activated plugin and process inventory were backed up under `/tmp/r7-ai-sprint8-journeys-20261008T155254`. The activated plugin was restored from that backup. The RC package remains `install ok installed 0.9.0-pilot-rc`. The restored target contains `config.json`, `index.html`, `LICENSE`, `panel.js`, `styles.css`, and `THIRD_PARTY_NOTICES.md` directly below the brace-GUID directory. No `DesktopEditors` process or Sprint 8 transient unit remained at final measurement. Snapshot `02-astra-r7-clean` was never restored or modified. Receipt: `.local/sprint8/final-current-state.log`.

### What this does not show

This attempt does not show a successful credential use by the product transport, any paid model response, any Word/Cell/Slide document mutation, any terminal compact status, any advancing UX-B5 sequence, or a rendered product-panel pixel capture. It shows only that the credential was readable, the mounted panel initially existed at the correct activated path, the desktop was unlocked and capturable, and the subsequent R7 lifecycle attempts failed to expose the required CDP listener. All three journeys therefore remain **NOT VERIFIED**.

