# T8 independent exit review — `ab06fef`

**Superseded current acceptance:** [Word display blocker](word-display-blocker.md) suspends RC acceptance after manual testing. The PASS below remains the historical decision for its measured scope, not current release readiness.

Date: 2026-10-09. Frozen product: **`ab06fef4e42840dbb0f02893b853dfad2e646442`**, `0.9.0-pilot-rc`.

**Verdict: PASS WITH RECORDED LIMITATIONS for the current local pilot contract and exact supported target.** No remaining blocking defect was found in the reviewed source/artifact delta, final native journeys or package lifecycle evidence. The observed Slide completion/order P1 and Cell display defect can be closed for the measured regression scenarios. This does not guarantee arbitrary model task completion, authorize publication, or extend support to untested platforms. The release handoff must retain this exact identity and the limitations below; documentation-only commits do not redefine the tested product bytes.

## Scope and evidence method

The reviewer independently inspected the final raw `.local/sprint10/native-{slide,slidepair,cell,word}.jsonl`, Cell screenshot, `lifecycle.json`, `zip-load.json` and `lifecycle-restored.json`. Local read-only assertions recomputed the document postconditions from before/after arrays and counted creation requests, rather than trusting the stored acceptance flags or assistant prose. No SSH, rebuild, full-suite repetition or native document operation was performed by the reviewer.

Durable counterparts are [native-ab06fef.json](native-ab06fef.json), [package-ab06fef.json](package-ab06fef.json), [Cell screenshot](native-cell-ab06fef.png), [targeted test output](targeted-tests-ab06fef.json) and [final verification](final-verification-ab06fef.md). The preceding [T5 review](t5-review-ab06fef.md) independently verified current source/artifact security, hashes and inventories; its then-pending native decision is supplied here.

Measured platform: Astra Linux SE `1.7.9`, build `1.7.9.41`, amd64; `r7-office 2026.1.2-1942~astra-signed`, executable `2026.1.2.1942`; actual panel/model/native bridge journeys on disposable documents. All four journey frames loaded panel SHA-256 `03162abe0b3f10eea55fac0dda6d3af3f5ab47a26790758dd9fcef91ae042aa9` and CSS `34b9b9085d44152b9f7af582dc8505a4a46f36edc32fabefa4c8c063512cedde`.

## Native acceptance

| Case | Independently checked effect | Decision |
| --- | --- | --- |
| Original one-slide append | Count 5 → 6; original five text bodies remain the exact prefix; `SPRINT9_SLIDE_NATIVE_AB06FEF` is the last body at index 5; one creation request and no duplication | PASS |
| Ordered two-slide append | Count 5 → 7; original five text bodies remain the exact prefix; `_A` at index 5, `_B` at index 6; two creation requests and no duplication | PASS |
| Cell A1 | Active sheet stays `P&L`; empty A1 becomes exact `SPRINT9_CELL_NATIVE_AB06FEF`; every other measured value in A1:D5 is unchanged | PASS |
| Word append | Paragraph count 2 → 3; document text equals the exact original text plus one newline and `SPRINT9_WORD_NATIVE_AB06FEF` | PASS |

The one-slide trace demonstrates the completion fix: the first candidate final described index 1 before the requested end placement was complete. The runtime withheld that candidate, requested review, obtained current structure, executed `move_slide(1, 5)`, and obtained fresh structure/text reads before publishing the final answer. Independent after-state confirms the end position. No separate corrective user prompt was needed.

The pair trace shows separate structural operations with fresh structure reads: create first slide, move 1 → 5, write A; create second slide (returned index 2), move 2 → 6, write B. Both final target texts and structure are read after the latest mutation and again in completion review. This measured run follows the dependency guidance; the zero-dispatch rejection of unsafe mixed structural batches is established by source inspection and focused regressions, not by claiming this native run exercised a rejected batch.

The Cell screenshot shows rendered text in selected A1, clipped by the existing narrow column, and the complete exact marker in the formula bar. It closes the previous blank-canvas/formula-bar symptom; complete marker visibility within the narrow cell is not claimed. Word is a narrow compatibility check, not a new full document-formatting campaign.

These are in-memory outcomes. Slide preservation is established for the measured text sequence and observed structure; the three identical blank text bodies cannot independently prove every slide identity or property. Save/reopen, all shapes/layouts/styles, native Undo and arbitrary formulas are not established by these runs.

## Identity and lifecycle

Current ZIP SHA-256 is `886785b5a5085a776a26a06c1cadcc7ac88aeadbffc264eba048285e07c0c35d`; DEB is `5f6bdcce3243fe27af88ae0c516a688431ddcaea32d5f89b51758a74438d5b6a`; SPDX is `016f38dedcfac9b7347714dd832862936fc839b326cb5e5e37d91e418c5c9a69`. T5 recomputation agrees with [SHA256SUMS](SHA256SUMS). Current package records retain reproducibility and ZIP/DEB/SPDX payload identity evidence.

The lifecycle receipts show successful same-version DEB reinstall, supported-tuple preflight, uninstall and absence of package-owned paths, explicit per-user deactivation, reinstall and restoration. The sole nonzero lifecycle result is the intentional unsupported-Astra refusal, exit 42. Settings manifest hash `908601d9ca77e0349bf9c15cb1d45b66c9ba555340872cff6039880420add9ad` is identical at before/reinstalled/uninstalled checkpoints. Vendor `v1/plugins.js` hash `6aa574e212733b12c513622331f52a55adb24450e6990a89dbe45ba35fa6a23a` is identical at all three checkpoints.

The actual ZIP's nine files were safely extracted, activated in the per-user GUID directory and loaded in a fresh plugin frame. Loaded JS/CSS match the above; provenance SHA-256 is `9fa3a3f295a5c7ef770ebd717ab77be5dce1bde253db1c0aa39e6d56a7b97637`; composer presence and ready status were observed. This is the manual per-user ZIP route, with the installed preflight available, not vendor ZIP-manager import. Subsequent ZIP deactivation and restoration of the DEB per-user copy passed a recursive byte comparison with its backup. Final panel/CSS hashes match, package status is installed, and protected editor PID `119782` remains running with `deck-open.pptx`.

Settings equality is measured at the named checkpoints, not claimed as a continuous trace or a new hash measurement after every ZIP action. Final per-user restoration is separately evidenced by the successful byte comparison. No material inconsistency was found between the reviewed receipts and these bounded conclusions.

## Carried evidence and remaining limits

The [previous native compact UI evidence](../sprint-9/native-compact-final.md) is carried explicitly: 259 × 499 panel, 22-message scroll/composer behavior, typography/focus, safe DOM Markdown and inert raw HTML/contained long code. CSS is byte-identical; layout and Markdown code are unchanged by the completion fixes. Narrow final geometry and view/controller tests corroborate compatibility. The complete compact campaign was not repeated, and the full transient UX-B5 pixel sequence remains NOT VERIFIED.

The earlier 1361-test full suite remains a baseline. Current passing targeted groups overlap; the final structural group has 189 tests and final completion group has 16. They must not be summed or described as a newly repeated full suite. Audit and bounded independent T5 review found no blocking security issue.

Historical `fda714d` single-slide failure and [f304507 pair failure](intermediate-f304507-native.json) remain failed attempts under their original identities. The present successful runs do not rewrite them. The prior guided move was a separate recovery probe and is not used to pass the current original requests. The reported startup failure before a model request is likewise not counted as a successful journey.

Remaining limits: Bank TLS/CORS/AUTH/Qwen NOT RUN; ZPS, unsupported Astra/R7 tuples, system-wide plugin placement, Windows Cell, vendor ZIP-manager import and arbitrary future upgrades NOT VERIFIED. The measured lifecycle covers same-version reinstall and the documented manual per-user route. Trusted SDK/CEF, configurable HTTPS CSP, plaintext key opt-in and non-atomic Preview/Apply limits remain unchanged.

Completion review checks usable fresh read evidence and asks the model to assess the whole task; it does not deterministically prove all natural-language requirements. The structural rule prevents dependent structural operations within one batch, not every possible stale index across turns. These limitations must remain visible even though both observed append regressions now pass on the exact final bytes.
