# Test plan

Status of all product tests: NOT RUN. No unit test claim substitutes for R7 runtime acceptance.

## A/B blocking gate

Verify exact OS/R7, real paths/SDK, word/cell/slide inside visual panel. Selection read/replace, formatting preservation and undo on disposable fixtures. Direct CEF HTTPS POST, Authorization, stable X-Session-ID and text response shown in UI. Test CORS/preflight, trusted/internal CA, timeout, DNS/offline, 401/403/429/5xx. No TLS bypass and no backend changes.

## Automated suites after gate PASS

Unit: strict-bank shape, content-only parse, JSON/fences/repair, closed schemas, forbidden tools, budgets, ASK policy, key redaction, settings validation.
Integration: bounded multi-step loop, timeout/cancel, stale target, result truncation, injection fixtures, preview cancellation and editor adapter capability failures.
All primary AI acceptance uses Qwen 3.8 strict-bank; Qwen 3.6 optional compatibility only. No native tools or streaming. Keys never committed.

## Real editor acceptance

DOCX: select/rewrite paragraph, preserve formatting, tables/formatting/lists, user Save, close/reopen and visual inspection.
XLSX: read range, update values/formulas/styles, add sheet, Save/reopen; verify values and formulas.
PPTX: read current slide, change text/styles, add object/slide, move slide, Save/reopen and visual inspection; unsupported objects preserved.
Settings: enter connection, test, restart, restore allowed settings, masked key, no secrets in logs, reset removes stored config.
Packaging: archive inventory/SBOM/checksums, clean install, upgrade, uninstall, no daemon/listening ports/Node/runtime downloads; separate ZPS ON state.

Each defect: minimal reproducer → failing regression → fix → verified PASS. Reports distinguish PASS, FAIL, NOT RUN and BLOCKED with concrete evidence; no fabricated screenshots or release gates.
