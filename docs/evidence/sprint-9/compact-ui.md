# Sprint 9 compact panel — implementation evidence

Owner-approved design: `docs/superpowers/plans/2026-10-09-panel-compact-proposal.md`. The approval in the 2026-10-09 handoff/current request supersedes the proposal-only wording in that historical design file.

Implemented CSS, then view structure, then updated structural expectations and added Markdown, draft and focus checks. Runtime, tools, bridge, limits and connection semantics are unchanged.

## Local verification

- Full suite after review fixes: **1357 tests, 1357 pass, 0 fail** (`npm test`).
- `npm run audit`: PASS. No audit suppression or dependency added.
- Real Chromium at 259 × 499, 20 alternating messages: document/client dimensions both 259 × 499; only `#content` vertically scrolls; header 32 px; composer 50 px idle / 73 px active; textarea 38 px initially, 72 px cap; Send 34 × 34; history viewport 417 / 394 px; message type 12.5/17.
- Composer coordinates unchanged between transcript endpoints; expanded textarea preserves document containment; diagnostics retains one scroller; keyboard focus has a 2 px visible outline and new chat → diagnostics → draft → Send order with empty history.
- Working stage stays at the tail when Stop appears and when a draft grows. Earlier-message readers keep their scroll position. Existing Markdown links remain mounted and focused as replies arrive.
- Evidence: `.local/sprint9/full-tests.txt`, `geometry.json`, `implemented-idle-259x499.png`, `implemented-active-259x499.png`; repeatable dev harness `tests/acceptance/ui/compact-panel.mjs`.

## Independent review

Fresh reviewer `compact_review` found two P2 issues: draft expansion lost tail tracking; rerendering history destroyed focused Markdown links. Both fixed, with failing reproduction before fixes, focused tests/browser probes after, and the full green suite above. No additional security finding. This is UI code review, not native acceptance or the Sprint 8 exit gate.

## Implementation decisions

No existing chat Markdown renderer was present; the build permits only authored `src` JavaScript. Added a small DOM-only renderer: paragraphs, soft/hard breaks, demoted headings, lists, emphasis, HTTPS links and code. Raw HTML is literal; no images load; unsafe URLs remain text; no HTML sink or runtime dependency. Unsupported Markdown remains literal. This is a presentation subset, not a claim of full CommonMark compliance.

Preserved contrast-checked product colors rather than the mockup’s lighter decorative rules. Compact focus uses a 2 px outline instead of the old oversized halo. The only absolute-positioned CSS is the approved header-icon hit expansion (28 × 26 visual, 34 × 32 hit area). All content remains in normal flow.

## Acceptance boundary

Local rendered evidence uses a controlled transport and is **not** native Astra acceptance. Artifact hashes, native document read-before/read-after results and Sprint 8 exit status will be recorded separately. RC is not declared.
