# Sprint 8 T5 — final artifact security delta review

Review date: 2026-10-09. Pinned product commit: **`fda714d2cf8eedcc2331ff5529513c1b74c6a0db`**.

**Outcome: no critical or release-blocking security finding identified. T5 is complete within the bounded source/artifact review scope.** This report extends [the independent c7f1a83 review](t5-security-review-c7f1a83.md); its unchanged controls and limitations remain applicable. This is not security certification, final native acceptance, T8 PASS, or permission to release.

## Final bytes independently verified

The reviewer recomputed all five `dist/SHA256SUMS` entries and compared the actual ZIP/DEB plugin payloads. Every check matched. ZIP provenance names the pinned full commit above; `.local/sprint9/byte-identity-final.json` records the same tuple.

| Artifact | SHA-256 |
| --- | --- |
| `dist/plugin/r7-ai-assistant.zip` | `f96babdee1a6066afe16c513774426335c76cefdf3c3a2de5e7cc4320786df85` |
| `dist/deb/r7-ai-assistant_0.9.0-pilot-rc_amd64.deb` | `7b986d7b3abd19dbf4b1408a7634eb2495c8e624aee3331e0f4f20105cd50bec` |
| `dist/r7-ai-assistant.spdx.json` | `0dbaf0c515550b7f9042f19cacdef9c9ba18bbf39fed8f4e7aa465a02d79508a` |
| `dist/plugin/panel.js` | `786372b69d155d80c29a6d1756012547532f502098b5b1c0fdc89f61cc89693e` |
| `dist/plugin/styles.css` | `34b9b9085d44152b9f7af582dc8505a4a46f36edc32fabefa4c8c063512cedde` |

The final ZIP retains the exact nine-file allowlist: license/notices, authored plugin manifest, HTML, bundled JS, provenance, two icons and CSS. The final DEB retains eleven regular files: eight corresponding plugin files, compatibility declaration, product-owned-files manifest and preflight. All eight actual DEB plugin payload hashes match the corresponding ZIP entries. No user connection settings, development fixture/runtime, service, listener or credential file appears in either inventory. Final archive text scans again returned zero matches for the private-key/provider-token/development-runtime/stand-address patterns used in the earlier review. Scans are bounded detection, not proof against every possible secret format.

## Security-relevant delta

| Change | Independent assessment |
| --- | --- |
| Cell capability probe | `src/plugin/bridge.js` now chooses an authored Cell-specific body for both supported command transports. It reads the active sheet and the fixed `A1` range and checks `GetValue`/`SetValue` method presence without invoking either mutation or the invalid Word root. Decoder selection requires the Cell tuple length and boolean members through the existing descriptor-safe tuple boundary. Read and write availability are calculated independently and remain labelled `runtimeVerified: false`. This removes a false refusal without making mere method presence a proof of successful mutation. Existing tool-specific validation, editor gating, write ownership and uncertain-result handling remain in force. |
| Slide placement guidance | The bounded static `add_slide` description states that insertion is after the current slide, the layout argument selects only layout, and callers must use the returned index and `move_slide` to append. No tool policy, schema, mutation implementation or executable model input was added. This corrects misleadingly incomplete model guidance; it does not guarantee semantic model compliance. Acceptance must independently verify final order and unchanged old slide content. |
| Markdown identifiers | Unicode-aware underscore boundaries keep intraword identifiers literal. DOM construction, raw-HTML treatment, HTTPS-link validation, recursion bound and absence of remote images are unchanged. No HTML/execution/network sink was introduced. |
| New-chat glyph | Replacing fullwidth `＋` with ASCII `+` affects presentation only; accessible naming and action behavior are unchanged. |
| Security documentation | `docs/security.md` now states current Sprint 8/approved compact-panel authorization, historical evidence boundaries and the need for fresh hashes after native defects. The earlier low-severity stale-authorization finding is resolved. |

The reviewer inspected the new Cell regression tests for both command transports, absence of writes/Word-root calls, read-only range support and missing-sheet refusal; the package assertions pin the additional authored static command body. The Markdown regression covers preservation of identifiers and ordinary emphasis. The coordinator reports **1361/1361** full-suite tests at `a10732b`, then **50 passing UI/Markdown/package tests** after the glyph-only `fda714d` change, plus final audit, reproducibility, SBOM and DEB/ZIP verification PASS. These test/build results were not rerun by this reviewer. Hash/payload/scan results above were independently measured without rebuilding artifacts.

## Limitations and T8 handoff

The prior review's trusted SDK/CEF boundary, CSP `unsafe-eval` and configurable HTTPS allowance, plaintext opt-in storage, non-atomic Preview/Apply, and prompt-injection policy limitations remain explicit. This review made no SSH/VM/trust-store changes and read no credential-bearing scripts. Bank TLS/CORS/AUTH/Qwen checks remain NOT RUN; ZPS and other carried platform gaps remain NOT VERIFIED unless separate evidence measures them.

Earlier `c7f1a83` native evidence established a Cell refusal and a Slide placement failure. The reviewer subsequently inspected all three final `fda714d` native JSONL records and their matching loaded JS/CSS hashes: Word appends the exact marker as a third paragraph; Cell writes and reads the exact marker in active-sheet A1. Slide creates and writes a new slide at the correctly returned index 1, preserving the five preexisting slide texts, but omits `move_slide` and does not satisfy the explicit request to append at the end. The successful intermediate `a10732b` append run cannot replace this failed exact-final-byte journey. See [independent T8 exit review](t8-independent-exit-review.md). The final Word record also supplies 22-message native Markdown and geometry evidence; broader UI checks retain their recorded limits.

**T8 recommendation: NOT PASS; release acceptance remains blocked by the measured Slide semantic failure.** T5 remains complete with no critical/blocking security finding; the workflow defect is a separate acceptance failure and must not be hidden by tool-level success. A separately labelled guided move follow-up now succeeds, but cannot retroactively pass the original request. Preserve this pinned commit/hash tuple when later committing documentation; do not silently rebuild under a new provenance identity. Publication remains outside the review's authority.

## Final receipt reconciliation

The reviewer subsequently inspected [final verification](final-verification-fda714d.md), [native receipts](final-native-receipt.json), [package receipts](final-package-receipt.json), [native compact-panel evidence](../sprint-9/native-compact-final.md), and its three PNG captures. They retain the same final product/hash identity. The original Slide failure remains present and is not substituted by recovery.

The package receipts now establish final-byte DEB reinstall, unsupported-Astra refusal (exit 42), uninstall, product-directory deactivation, reinstall and restoration. The measured localStorage file-manifest hash and vendor `v1/plugins.js` hash remain identical at the before/reinstalled/uninstalled checkpoints. This is evidence for those measured files and operations, not proof of physical secret erasure or arbitrary future upgrades.

**The final ZIP's manual per-user lifecycle is now VERIFIED within that route:** extraction of its nine files, activation on the measured path, fresh plugin-frame load with exact JS/CSS and provenance hashes, deactivation, and restoration of the prior DEB payload. Loaded provenance SHA-256 is `298a5c3b70932f0dd413b2b805cf42058f7674cc0d6643ee49780ba7f18b358c`, equal to the recorded build provenance. Vendor ZIP-manager import remains NOT VERIFIED; this result does not broaden installation to system-wide or unsupported paths. Final receipts show package `0.9.0-pilot-rc` installed and protected editor PID `119782` still running.

The separate fresh-panel native ASK rendering receipt now demonstrates literal raw `<img>` text, zero image elements, an unset execution sentinel, and a fenced line with horizontal-only overflow (width 224/3158; height 24/24). Exact JS/CSS hashes match. Its independent document before/after values are equal. The two prior protocol refusals remain failures and are not used as renderer proof. Native font/rhythm/Tab/focus/budget measurements further narrow earlier UI gaps; the complete transient UX-B5 pixel sequence and bank/platform limits remain explicitly unverified.
