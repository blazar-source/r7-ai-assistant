# History-neutral Slide read investigation — 2026-10-09

> Acceptance update, 2026-10-09: the owner explicitly accepted this exact unfixed history behavior as a known pilot limitation, including that restart does not restore lost Redo. Historical BLOCKED statements below describe the earlier decision. Remaining final UAT/security/package gates still apply.

Status: **BLOCKED, no product workaround introduced.** This supplements the [native Undo → ASK → Redo reproduction](slide-redo-blocker.md); it does not change candidate bytes or acceptance status.

## Newer SDK, inspected without installation

The official Astra package `r7-office_2026.3.1-3296~astra-signed_amd64.deb` was downloaded from `https://download.r7-office.ru/astra/r7-office_2026.3.1-3296~astra-signed_amd64.deb`. Size: 479759360 bytes. Published MD5 matched `95768261a617cd65cbe74cf5876c1317`; locally computed SHA-256: `4e08226cc32bf8850e0b8a0f3822e77cdff18927a06c5c49255f034494faf836`. Selected SDK files were extracted locally for inspection only. The package was not installed or executed; the working VM remains on 2026.1.2.1942.

The newer SDK retains the relevant normal-command `asc_canPaste()` path before the authored command body and the Slide finalization path without empty-history cleanup. No history-neutral arbitrary Slide reader was found in the exposed plugin-method inventory. This is static evidence against assuming an upgrade fixes the issue, **not a native failure result for the newer build**.

Official references: [download](https://support.r7-office.ru/download/desktop-editors/), [release notes](https://support.r7-office.ru/desktop-editors/release-notes/versija-2026-3-1-3296/), [vendor notice about network-file problems including Astra 1.7](https://support.r7-office.ru/desktop-editors/general-de/vazhnaja-informacija-o-sborke-desktop-redaktory-versija-2026-3-1-3296/).

## Public snapshot/export fallback

On the installed supported build, a fresh copy of the synthetic `slide-redo-input.pptx` was opened as `exportprobe-slide.pptx`. The public `executeMethod('GetFileToDownload', ['pptx'], callback)` was invoked once. The callback did not complete within 20 seconds. Native history metadata remained at index -1 / zero points, but the editor displayed an error warning recommending Save As and a persistent presentation-loading overlay. This route is **not accepted as a working read fallback**. No export result was used or claimed.

The disposable probe tab was closed through its native tab close button. A subsequent screenshot confirmed the pre-existing `uat8-slide.pptx` tab and the other editor tabs remain open; R7 was not restarted. No user document or VM checkpoint was changed. Raw receipt and screenshots remain ignored locally under `.local/release-uat/`: `slide-7-export-probe.jsonl`, `export-probe-observed.png`, `export-probe-closed.png`.

Public method reference: [GetFileToDownload](https://support.r7-office.ru/desktop-editors/developers-de/plugins/plugin-structure/plugin-code/methods-plugin/executemethod/getfiletodownload/). The installed `ConvertDocument` implementation handles Word HTML/Markdown and explicitly rejects other editor types; it is not a Slide alternative.

## Remaining boundary

No documented full-presentation read route that preserves Redo has been verified. Bypassing native command guards, modifying private history, or silently performing Undo/Save is not an accepted fix. A vendor-supported history-neutral command route or SDK correction is still needed, then the exact native regression and remaining UAT gates. The synthetic reproduction is prepared in this directory but has not been sent externally. No new full-suite run, rebuild, installation or GitHub publication was warranted by this investigation-only change.
