# T5 security delta review — `f304507`

Date: 2026-10-09. Frozen product commit: **`f3045073620ce40adae2af893a431bd8972a6346`**.

**Result: no critical or release-blocking security defect found in this bounded source/artifact delta review.** This extends the prior [final T5 review for fda714d](t5-security-review-final.md), whose unchanged trust boundaries remain applicable. It does not close the historical Slide P1 or declare T8 PASS; new exact-byte native acceptance is required.

## Independently verified frozen artifacts

All five actual SHA-256 values match `dist/SHA256SUMS` and the coordinator's frozen tuple:

| Artifact | SHA-256 |
| --- | --- |
| `dist/plugin/r7-ai-assistant.zip` | `f8e0e04768e22e4817f1f50359db64a7d47f6775126bf268fba7e695941ad948` |
| `dist/deb/r7-ai-assistant_0.9.0-pilot-rc_amd64.deb` | `f01d9d22d6b4bb276a8fd04a92f1c1f34c1650a4fe0f4379624d0a62e11ff8d5` |
| `dist/r7-ai-assistant.spdx.json` | `e102f3294ebb0d7c2359736bf09c6ea055044ad71c1489d7c7a2fbeeacaa9a54` |
| `dist/plugin/panel.js` | `007fe1ed6060b906bda42a670bd7a71f84564c798ad64d860372f6bfc149859c` |
| `dist/plugin/styles.css` | `34b9b9085d44152b9f7af582dc8505a4a46f36edc32fabefa4c8c063512cedde` |

The actual ZIP retains exactly nine entries: `LICENSE`, `THIRD_PARTY_NOTICES.md`, `config.json`, `index.html`, `panel.js`, `provenance.json`, two resource icons and `styles.css`. Provenance names the full frozen product commit; its own SHA-256 is `614feabf738c30fed6b3f3e13b42423ca17b2c00848526b1a6f03cce4eab720b`.

The actual DEB contains eleven regular files: the eight plugin files without provenance, compatibility declaration, product-owned-files manifest and preflight. Its control archive contains only `control`, with no maintainer scripts. All eight DEB plugin file hashes match their actual ZIP counterparts. The SPDX document parses and all nine listed file hashes match the ZIP entries, with identical filename sets.

No user settings, credentials, development fixture/runtime, service or listener appears in those inventories. Repeated archive text scans returned no private-key header, supported provider-token pattern, development-browser marker, loopback or measured-stand address. Pattern scanning is bounded detection, not a universal secret detector. No credential-bearing files were read.

## Source delta reviewed

The change and its measured motivation are documented in [completion-fix-design.md](completion-fix-design.md). Independent review inspected the implementation before freeze and confirmed the final commit contains that change plus the requested controller/view regressions.

- **Slide completion review:** only Slide EDIT runs with successful mutations enter the new phase. The first final is discarded rather than published or echoed into context. A static authored instruction asks for comparison against the pinned original request and fresh structure/text reads. Read revision stamps are assigned only after successful, serializable tool results are appended; later successful mutations invalidate those stamps. A repeated final without both qualifying reads returns `INCOMPLETE`, without candidate prose.
- **Existing enforcement:** no Slide tool, argument schema, bridge primitive or permission changed. Tool dispatch remains sequential and allowlisted. Uncertain mutation stops immediately. The phase consumes existing step/call/deadline budgets; cancellation and deadline are checked again immediately after transport. The runtime does not automatically replay mutations or create additional slides; any further action still requires a validated model tool call under the existing policy.
- **Honest non-success UI:** controller maps `INCOMPLETE` to `AGENT_INCOMPLETE`; the view says completion was not confirmed and changes remain in the open document. It does not claim Save or mislabel the condition as an exhausted budget. The controller regression verifies retained actions, released active state and no candidate chat publication.
- **Cell recalculation:** the only native Cell mutation delta changes the `sheetwrite` `callCommand` recalculation flag from false to true while keeping the plugin open. No new write, argument, network path, dynamic code or runtime dependency is added. This addresses the independently measured stale canvas/formula-bar state; final native visual/readback evidence remains required.
- **Unchanged security surfaces:** configured HTTPS transport/redirect refusal, credential storage defaults, raw-HTML/Markdown handling, static SDK execution boundary, Preview/Apply ownership and package lifecycle code are unchanged by this delta.

The coordinator reports passing focused groups of 223 runtime/protocol/context/controller/view/integration tests, 107 Cell/Slide bridge/tool/completion tests, and 111 final controller/view/package tests; groups overlap and must not be summed into a full-suite total. Authored-code audit passes. The reviewer inspected the added regressions but did not repeat these suites, rebuild artifacts, use SSH or change trust settings. Hash, archive, payload and SBOM checks above were independently performed.

## Limits and T8 handoff

The gate is **model-assisted completion review, not deterministic semantic verification**. One qualifying `read_slide` does not prove every changed slide's text; a model can still disregard contradictory evidence. Successfully published evidence can later leave the bounded context. These limits are explicitly acknowledged in the design and must not become claims that all natural-language postconditions are enforced by code.

The original failed fda714d Slide trace and separate guided recovery remain historical evidence. Closing P1 on this new set requires unguided native requests with independent assertions of count, final positions/order, every requested marker, unchanged original-slide prefix and no duplicate creation. The proposed single-slide and ordered two-slide scenarios must be assessed on their actual outcomes, not scripted unit-test responses. Final Cell acceptance must pair SDK value/text readback with refreshed canvas/formula-bar pixels.

Previous fda714d manual ZIP and DEB lifecycle measurements establish that earlier byte set's route, not native installation of these changed f304507 bytes. Bind new install/load and required lifecycle evidence to the hashes above. Vendor ZIP-manager import, system-wide/unsupported paths, arbitrary future upgrades, ZPS and remaining platform limits stay explicitly unverified; Bank TLS/CORS/AUTH/Qwen remains NOT RUN. Trusted SDK/CEF, configurable HTTPS CSP, plaintext storage opt-in and non-atomic Preview/Apply limitations remain as previously documented. Publication is outside this review's authority.
