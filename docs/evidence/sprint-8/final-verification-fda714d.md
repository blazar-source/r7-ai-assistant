# Final verification — 2026-10-09, product `fda714d`

**Current supersession, 2026-10-09:** [ab06fef final verification](final-verification-ab06fef.md) closes the observed Slide P1 with fresh original/pair native assertions and visible Cell A1. Independent [T8](t8-review-ab06fef.md) is PASS WITH RECORDED LIMITATIONS; the local RC remains unpublished. Attempts below retain their original outcomes and byte identities. Current checksums: [SHA256SUMS](SHA256SUMS).

**Sprint 8 exit: NOT PASS. RC is not declared or published.** Compact UI is implemented. Exact-byte native Word and Cell edits pass; Slide creates and edits the new slide but fails the requested end position. The independent review classifies that semantic failure as a release blocker. A separate guided move succeeds without retroactively passing the original request.

This report supersedes the current-status claims in older Sprint 8 freezes and native attempts, while preserving those attempts as history. Product source identity is **`fda714d2cf8eedcc2331ff5529513c1b74c6a0db`**. Later evidence/documentation commits do not change this tested artifact identity.

## T7: exact artifact identity

| Artifact | SHA-256 |
| --- | --- |
| `dist/plugin/r7-ai-assistant.zip` | `f96babdee1a6066afe16c513774426335c76cefdf3c3a2de5e7cc4320786df85` |
| `dist/deb/r7-ai-assistant_0.9.0-pilot-rc_amd64.deb` | `7b986d7b3abd19dbf4b1408a7634eb2495c8e624aee3331e0f4f20105cd50bec` |
| `dist/r7-ai-assistant.spdx.json` | `0dbaf0c515550b7f9042f19cacdef9c9ba18bbf39fed8f4e7aa465a02d79508a` |
| loaded `panel.js` | `786372b69d155d80c29a6d1756012547532f502098b5b1c0fdc89f61cc89693e` |
| loaded `styles.css` | `34b9b9085d44152b9f7af582dc8505a4a46f36edc32fabefa4c8c063512cedde` |

The clean product commit was built using Node `v24.21.0`, npm `11.19.0`, esbuild `0.25.10` on the existing Windows worktree. `npm run reproducible` produced two identical ZIPs; the repeated DEB build reproduced the recorded DEB. SPDX file/hash verification matched all nine archive files. The eight plugin files in the DEB equal the ZIP files byte-for-byte; only the ZIP carries `provenance.json`. DEB contains eleven regular payload files and no maintainer scripts. Provenance source commit matches the pinned commit. Final repeat and independent review reproduced the five hashes above. See [SHA256SUMS](SHA256SUMS) and [package receipts](final-package-receipt.json).

Verification is bounded to this source/toolchain/platform. Do not rebuild from a later documentation commit and label it this same set. Nothing is shipped by recording these files.

## Tests and changes

- Compact CSS/view/Markdown implementation and review fixes: `c7f1a83`; first full suite **1357/1357**.
- Native-proven Cell capability-root correction, accurate Slide tool guidance, and literal intraword underscores: `a10732b`; full suite **1361/1361**, zero failures; authored-code audit PASS.
- Final `fda714d` changes only the unsupported fullwidth new-chat glyph to ASCII `+`; **50/50** focused UI/Markdown/package tests and audit PASS. No redundant full suite was run for that glyph-only delta.
- The portable Chromium acceptance harness covers 20 messages, exact geometry, focus, draft growth, diagnostics, tail following and preserving focused links. Independent UI review found two P2 issues; both have regression coverage and are fixed.

No agent-runtime, permission, limit or Apply semantics were changed for compact UI. The separately established Cell blocker uses actual spreadsheet APIs rather than the Word-only `GetDocument()` root, which is present but throws in native Cell. The probe checks method presence without writing a cell. It preserves fail-closed results for unavailable APIs.

## T3/T4: native document effects

Target: Astra Linux SE `1.7.9`, build `1.7.9.41`, amd64; `r7-office 2026.1.2-1942~astra-signed`, executable `2026.1.2.1942`. New disposable copies were opened in the existing R7 process; protected PID `119782` and `deck-open.pptx` were not killed, replaced or closed. Host fingerprint was checked before authentication. No protection settings, trust stores or checkpoints changed.

Each journey used the actual panel composer, controller, HTTPS transport, model (`deepseek-chat`), tool policy and native bridge. JS/CSS hashes were read from the mounted frame before dispatch. Separate static SDK reads captured the document before and after; a model's final answer was never the sole success criterion. The credential was passed over SSH stdin, used in memory with persistence unchecked, and excluded from product/artifacts/receipts.

| Journey | Before → after | Outcome |
| --- | --- | --- |
| Word | 2 paragraphs → 3; original prefix unchanged; exact final paragraph `SPRINT9_WORD_NATIVE_FDA714D`; later ASK read retains the same text | PASS for append/readback |
| Cell | Active sheet `P&L`, empty A1 → exact `SPRINT9_CELL_NATIVE_FDA714D`; native and `read_range` readbacks agree | PASS for A1 write/readback |
| Slide original request | 5 → 6 slides; marker `SPRINT9_SLIDE_NATIVE_FDA714D` on new index 1; all five old text bodies preserved in order | **FAIL for requested append-to-end**; model omitted `move_slide` |
| Slide guided recovery | Existing new index 1 moved to index 5; count remains 6; first five text bodies equal the original presentation; final marker on last slide | PASS for explicitly requested `move_slide(1,5)` and readback; does not close original failure |

The final Slide request is not replaced by the successful intermediate `a10732b` append run. The final model accurately received `slideIndex:1`, corrected its initial speculative read of index 5, then still omitted the move. The runtime validates individual actions but does not independently enforce the natural-language positional postcondition. See the [independent T8 finding](t8-independent-exit-review.md) and [native receipts](final-native-receipt.json).

These are narrow in-memory document-effect checks. They do not claim Save/reopen, native Undo, arbitrary formulas, rich formatting or all slide-object preservation. Documents remain available on the VM under `/home/r7dev/r7-verification/sprint9-20261009T013401`.

The independent review noted that the Cell screenshot shows blank A1 despite both positive readbacks; visual cell-effect confirmation remains unresolved. The separate late Word renderer probe starts with an extra title space and preserves that starting text; it does not establish whole-session immutability. These evidence boundaries are retained in the native UI report and receipts.

## Final-package lifecycle

The transferred ZIP and DEB hashes equal the table above. Genuine `dpkg -i`, shipped exact-tuple preflight and documented per-user activation passed. Each real native journey loaded the expected panel and stylesheet.

A bounded final lifecycle then measured same-version DEB reinstall, unsupported-Astra override refusal (exit 42), `dpkg -r`, absence of package-owned system paths, reversible deactivation of the exact per-user GUID directory, reinstall and restoration. The complete settings-file hash manifest stayed `018b51b5bbe729ca01afea8968bef37bb25c09276f1e442c984f68b007c88b18` before/reinstall/uninstall. Vendor `v1/plugins.js` stayed `6aa574e212733b12c513622331f52a55adb24450e6990a89dbe45ba35fa6a23a`. No unrelated profile/vendor file was removed.

The **final ZIP's own manual per-user lifecycle is now measured**: extract its nine files to a unique staging directory, preflight the exact installed target, activate that directory's files, reload only the disposable Word plugin frame, read actual loaded JS/CSS/provenance hashes, then deactivate that GUID copy. ZIP provenance loaded as `298a5c3b70932f0dd413b2b805cf42058f7674cc0d6643ee49780ba7f18b358c`. The exact DEB copy was restored and compared identical to its backup. R7 documents and process remained open. This does not establish vendor ZIP-manager import, arbitrary upgrade versions or other install paths.

Backups are retained at `.../sprint9-20261009T013401/lifecycle-1791499292365932400`; deactivation moved product directories there instead of deleting data. Final state: package `0.9.0-pilot-rc` installed, verified DEB per-user payload active, protected editor running. No checkpoint was overwritten.

## Compact native UI and review

See [Sprint 9 native UI evidence](../sprint-9/native-compact-final.md) for the exact 259 × 499 measurements, 22-message real dialogue, semantic Markdown, working-agent capture and remaining pixel/protocol limits. [T5 security review](t5-security-review-final.md) found no critical or blocking security issue. [T8 independent exit review](t8-independent-exit-review.md) is **NOT PASS** because the original Slide positional requirement failed.

## Remaining gates

The open Slide semantic defect prevents RC acceptance. Do not redefine `add_slide` or count text presence as complete placement verification. A future solution requires an explicit behavioral design and new evidence on its final bytes.

ZPS operation, unsupported tuples, system-wide plugin placement, Windows Cell, arbitrary future upgrade bytes, and the complete transient UX-B5 pixel sequence remain unverified where not superseded by specific evidence. Bank TLS/CORS/AUTH/Qwen remains NOT RUN. These boundaries are consolidated in [deployment](../../deployment.md#known-limitations). No push, merge, tag, release or `main` change occurred.
