# Handoff: DeepSeek Harness → Codex

**Current status / Текущий статус, 2026-10-09: RC acceptance suspended — NOT PASS.** The Word append/display defect is corrected and natively verified on candidate 68b164f: both paragraphs appear immediately, before diagnostic readback. The updated candidate is installed; the prior user document remains open. Full new-set RC acceptance has not been re-established. This supersedes earlier RC acceptance claims below. See [Word display blocker](evidence/sprint-8/word-display-blocker.md).

## Current status — Codex continuation, 2026-10-09

This section supersedes the historical handoff below. Work remains on `stage-b`; no clone, push, merge, tag, release or `main` modification. Product source and tested artifact identity are pinned to **`ab06fef4e42840dbb0f02893b853dfad2e646442`**. Later evidence/documentation commits do not redefine these bytes; do not rebuild from them and label the result this same set.

- Compact UI is complete with approved dimensions, safe DOM Markdown and independent UI fixes. Previous native 259 × 499 / 22-message measurements are carried for the byte-identical CSS; targeted view/controller and final narrow native checks pass.
- Slide P1 is closed. The first fix (`f304507`) withholds premature final answers for completion review; native ordered-pair testing then exposed dependent moves in one batch. The final minimal fix (`ab06fef`) separates structural Slide calls before dispatch. Slide tools/schemas/primitives are unchanged. Original one-slide and ordered two-slide tasks now pass exact before/after assertions for count, old text prefix, final order/markers and creation count.
- Cell A1's blank-canvas discrepancy was recalculation disabled after write. `sheetwrite` now requests recalculation; final native A1 is visible immediately and its formula bar shows the full marker. Word/Cell actual edit/readback checks pass.
- Targeted regression groups pass (final 189 scoped / 16 completion tests overlap), authored-code audit PASS. Earlier 1361 full-suite / 50 glyph-delta checks remain baseline evidence; no redundant full run. Final ZIP/DEB reproducibility, SBOM/inventory, transfer and mounted hashes pass.
- Final DEB reinstall/uninstall/settings-preservation and manual ZIP activation/load/deactivation pass on exact final bytes. Package is installed; exact DEB per-user copy restored. Settings/vendor hashes match across lifecycle checkpoints.
- T5 is complete without blocking security findings. **Independent T8: PASS WITH RECORDED LIMITATIONS. Local RC accepted, not published.** Model-assisted review is not a general semantic verifier; all retained deployment/platform limits remain. The failed fda714d and intermediate f304507 pair runs remain failed historical evidence.

Authoritative evidence: [final verification](evidence/sprint-8/final-verification-ab06fef.md), [native receipts](evidence/sprint-8/native-ab06fef.json), [package receipts](evidence/sprint-8/package-ab06fef.json), [T5](evidence/sprint-8/t5-review-ab06fef.md), [T8](evidence/sprint-8/t8-review-ab06fef.md), [carried compact UI](evidence/sprint-9/native-compact-final.md), [limitations](deployment.md#known-limitations).

Operational update: protected PID 119782 and `deck-open.pptx` stay open. Disposable tabs can be raised with `systemd-run --user` without killing/replacing that process. Final fixtures/backups are under `/home/r7dev/r7-verification/sprint10-20261009T020631`; earlier sprint9 and intermediate sprint10 directories are preserved. Ordinary session unlock permits native screenshots; a FlyLocker image is not panel evidence. Host-key pin and credential-handling restrictions below remain in force. Checkpoint `02-astra-r7-clean` was untouched. No further publication/distribution is authorized.

## Historical handoff at338c9b7


**Date:** 2026-10-09 · **Branch:** `stage-b` · **HEAD at handoff:** `0cef823`
**Remote state:** 18 commits ahead of `origin/stage-b`; **nothing was pushed**, `main` untouched, no tags, no release.
**Working tree at handoff:** clean (no modified, no untracked tracked-intent files).

## 1. Where the project stands

Sprints 6 and 7 are **closed**; Sprint 8 (final verification for `0.9.0-pilot-rc`) is **partially done**; the
Sprint 9 compact-UI work is **designed and approved but not implemented**.

| Stage | Status |
| --- | --- |
| Sprint 6 — UX/UI refinement | **CLOSED** as ACCEPTED WITH PLATFORM-EVIDENCE LIMITATIONS |
| Sprint 7 — packaging, Astra, ZPS | **CLOSED** as ACCEPTED WITH RECORDED LIMITATIONS |
| Sprint 8 — final verification `0.9.0-pilot-rc` | **IN PROGRESS**: T1/T2 done, T7 freeze done repeatedly, T3/T4 native journeys **not** completed, T5/T8 not started |
| Sprint 9 — compact panel (owner-approved) | **DESIGN ONLY**: proposal committed, implementation reverted |

## 2. What is implemented and committed

**Packaging and deployment (Sprint 7).** A deterministic plugin package with an authored provenance manifest
(`package.json`, the lockfile roots, `packaging/deb/control`, the three build scripts); an SPDX 2.3 SBOM generated
without dependencies (`scripts/generate-sbom.mjs`); a reproducibility verifier
(`scripts/verify-reproducible-build.mjs`, `npm run reproducible`); a data-only DEB (`scripts/build-deb.mjs`) whose
install mechanism was settled by measurement, not assumption; a single-source compatibility declaration
(`packaging/compatibility.json`) enforced by a **shipped** preflight (`packaging/deb/r7-ai-assistant-preflight`);
and rewritten deployment documentation. The product version is **`0.9.0-pilot-rc`** (prepared, **not published**).

**Sprint 8 work in this session.** A release contract and an 18-item defect triage (0 demonstrated release
blockers); an RC artifact freeze and re-freezes; and two genuine **product defect fixes**:

* `dc93242` — the capability probe now performs a real native check for word, cell and slide instead of declaring
  word-only availability and hard-coding mutation to `false`.
* `624b831` — ownership is editor-agnostic. Three **accidental** word-only gates were found and removed
  (`ownedTarget()`, `readSelection()`, the controller's read), while the **legitimate** Word-specific primitives and
  all fail-closed conditions were deliberately left intact.

**Sprint 9 design.** `docs/superpowers/plans/2026-10-09-panel-compact-proposal.md` — the owner approved it as
written (type scale, flat message treatment, combined header, composer dimensions, single scroll, Markdown,
acceptance criteria).

**Earlier stages** (Sprints 1–6) are in `docs/superpowers/plans/` and `docs/evidence/`.

## 3. What is NOT finished (and what happened)

1. **Compact UI implementation (Sprint 9) — not implemented.** Two implementer attempts died mid-task; the second
   left three failing view tests, and that partial state was **reverted** so the branch stays green. The approved
   numbers live in the proposal document; nothing in `src/` reflects them yet.
2. **The frozen RC set is stale.** The last freeze is at `dc93242` (ZIP `1eba90a5…`, DEB `9eb7233f…`,
   SBOM `3dd84b70…`, `panel.js` `470b3a34…`). The **ownership fix `624b831` changed product bytes after that**, so
   the frozen set must be rebuilt, re-recorded and re-tested before it may be called the release.
3. **Native acceptance of the fixed bytes was never completed.** At `dc93242` a real Slide dispatch still failed
   `CAPABILITY_UNAVAILABLE` **before** the ownership fix; Word and Cell could not be exercised because switching the
   editor would have disturbed the protected running presentation. The ownership fix is therefore **not yet verified
   natively at all** — this is the highest-value next measurement.
4. **Sprint 8 T5 (security review) and T8 (independent acceptance/code review + exit gate) are not started.**
5. **Astra stand state:** R7 is running as **PID 119782** with `deck-open.pptx`, the trial modal has been dismissed,
   the debug endpoint answers, and the plugin is mounted from the verified per-user path. **Do not kill that
   process** — killing it previously cost the debug endpoint. Word/Cell runs need the editor switched (or a second
   instance), which is the open operational question.

## 4. Known defects and limitations

* **The capability refusal** is fixed in code twice over but **unverified natively**; treat any claim about Slide or
  Cell mutation as unproven until measured on the stand.
* **ZPS is NOT VERIFIED** (the privileged state query needs superuser; nothing was disabled to obtain a result).
* **A system-wide install path is NOT VERIFIED** and must not be used; only the per-user path is proven.
* **The plugin ZIP has no own stand lifecycle** — only the DEB was exercised on the target.
* Sprint 6 platform gaps: the Windows Cell journey, Astra Word/Cell **pixel** screenshots, Astra focus-ring pixels
  and a rendered UX-B5 stage sequence are recorded as `NOT VERIFIED` with measured symptoms.
* **Qwen calibration** limitation and recorded `TIMEOUT`/`HTTP_ERROR` behaviour remain as documented.
* The Astra stand ships **no input tooling** (`xdotool`, `wmctrl`, `xte`, Python `Xlib` are absent; no passwordless
  sudo; apt has no candidates), so any GUI interaction needs a human at the VM console.

## 5. Last test results

* Full suite at `624b831`: **1350 tests, 1350 pass, 0 fail**; `npm run audit` — **Authored-code audit PASS**.
* After the UI revert the view suite is green again (35/35) on the same commit.
* The full suite was **not** re-run after the revert because the revert restored committed state and no code
  changed since. Re-run it once when you next change code.

## 6. Where everything lives

* **Plans:** `docs/superpowers/plans/` — `2026-10-08-sprint-8-final-verification.md`,
  `2026-10-08-sprint-8-release-contract.md`, `2026-10-08-sprint-7-packaging-astra-zps.md`,
  `2026-10-08-sprint-7-packaging-contract.md`, `2026-10-09-panel-compact-proposal.md`, plus the Sprint 1–6 plans.
* **Evidence:** `docs/evidence/sprint-6/`, `docs/evidence/sprint-7/` (including `final-artifact-inventory.md`),
  `docs/evidence/sprint-8/` (including `SHA256SUMS`, `t7-rc-artifact-freeze.md`,
  `t3-t4-capability-refusal-diagnosis.md`, `t3-t4-native-acceptance.md`).
* **Mockups (untracked, `.gitignore`d — they exist on this machine only):**
  `.local/sprint9/proposed-259x499.png`, `.local/sprint9/current-259x499.png`,
  `.local/sprint9/proposed.html`, `.local/sprint9/current.html`.
* **Raw logs (untracked):** `.local/sprint8/`, `.local/sprint7/`, `.local/sprint6/`.

## 7. Operational facts you will need

* **Astra stand:** SSH `172.21.125.36`, user `r7dev`. The password is in `.local/sprint5/astra-steps.py` on this
  machine — **never commit it**. Verify the host-key pin
  `SHA256:C8ZeXWfRCBdNyCnfQqNA7780JIKyAi99GeBtP5XhP2k` **before** authenticating.
* The stand is a **local Hyper-V VM `Astra-R7-Dev`**; its console opens with
  `vmconnect.exe localhost Astra-R7-Dev` (this is how the owner dismissed the trial modal).
* Raise R7 through a unit, not inside an SSH channel:
  `systemd-run --user --unit=<u> --collect env DISPLAY=:0 XAUTHORITY=/home/r7dev/.Xauthority /opt/r7-office/desktopeditors/DesktopEditors --ascdesktop-support-debug-info <file>`.
* The plugin the page **actually loads** is
  `/home/r7dev/.local/share/r7-office/editors/sdkjs-plugins/{7C91D48E-5F12-4B36-8A90-2DFA8467C013}` — not the
  `editors/data/...` copy.
* The plugin can be mounted over CDP through the **editor frame** (the context whose URL contains
  `presentationeditor`): `window.g_asc_plugins.run('asc.{7C91D48E-…}', 0, '')`. The same trick starts the desktop
  bridge (`asc.{D5B29457-194D-4E9A-A37F-02D739818FE1}`) that the `r7_desktop_*` tools need.
* Screenshots of the plugin panel are **not** obtainable over CDP (the panel frame is not a target and does not
  composite into a host capture). On Astra, capture the **desktop** window (`FlyLocker`, via `xwininfo -root -tree`
  then `import -window <id>`) and crop `518x998+80+336`; the X root window is blank.
* Commit messages: write them to a file and use `git commit -F <file>` (PowerShell mangles long quoted `-m`).

## 8. Recommended next task for Codex

1. **Implement the compact UI in three small, independently verified steps** (CSS numbers → `view.js` structure →
   `view.test.js` expectations), because a single large attempt failed twice. The approved numbers are in
   `docs/superpowers/plans/2026-10-09-panel-compact-proposal.md`. If the contrast check genuinely fails at the new
   type scale, treat that as a finding, not something to silence.
2. **Re-freeze the RC after `624b831`** (rebuild both artifacts, record the hashes together, re-verify
   reproducibility, the SBOM against the real archive and the DEB payload against the ZIP).
3. **Run the native acceptance on those exact hashes** on Astra: the Word, Cell and Slide journeys with the document
   content read before and after, the UX-B5 stage sequence, and the pixel captures where possible. This is the first
   run that can show whether the ownership fix unblocked mutation — and the RC may **not** be declared before the
   updated interface also passes.
4. **Then T5 (security review) and T8 (independent review + Sprint 8 exit gate).**

**Do not** push, merge, tag, release, touch `main`, or modify the preserved Astra checkpoint `02-astra-r7-clean`.
