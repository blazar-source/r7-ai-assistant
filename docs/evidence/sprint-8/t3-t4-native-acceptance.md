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
