# Test plan

Status of all product tests: NOT RUN. No unit test claim substitutes for R7 runtime acceptance.

## A/B blocking gate

Verify exact OS/R7, real paths/SDK, word/cell/slide inside visual panel. Selection read/replace, formatting preservation and undo on disposable fixtures. Direct CEF HTTPS POST, Authorization, stable X-Session-ID and text response shown in UI. Test CORS/preflight, trusted/internal CA, timeout, DNS/offline, 401/403/429/5xx. No TLS bypass and no backend changes.

## B host tests before runtime gate

Use the reviewed slice's concrete UTF-8/operation budgets. Test static audit, strict-bank shape, isolated connection-test UUID, storage failures, callback/Stop/reset races and narrow-domain stale-target guards. Passing mocks only permits target testing, never B PASS. Repeat plugin archive build twice and compare bytes/SHA-256.

## Broader automated suites after gate PASS

Unit: strict-bank shape, content-only parse, JSON/fences/repair, closed schemas, forbidden tools, budgets, ASK policy, key redaction, settings validation.
Integration: bounded multi-step loop, timeout/cancel, stale target, result truncation, injection fixtures, preview cancellation and editor adapter capability failures.
Primary AI acceptance uses `qwen/qwen3.8-27b:free` strict-bank; additional compatibility uses `qwen/qwen3.8-max-0902`. Bank setting is `qwen`, exact served checkpoint pending. Never substitute targets automatically. No native tools, streaming or structured output API. Keys never committed.

## Real editor acceptance

DOCX: select/rewrite paragraph, preserve formatting, tables/formatting/lists, user Save, close/reopen and visual inspection.
XLSX: read range, update values/formulas/styles, add sheet, Save/reopen; verify values and formulas.
PPTX: read current slide, change text/styles, add object/slide, move slide, Save/reopen and visual inspection; unsupported objects preserved.
Settings: enter connection, test, restart, restore allowed settings, masked key, no secrets in logs, reset removes stored config.
Packaging: archive inventory/SBOM/checksums, clean install, upgrade, uninstall, no daemon/listening ports/Node/runtime downloads; separate ZPS ON state.

Each defect: minimal reproducer → failing regression → fix → verified PASS. Reports distinguish PASS, FAIL, NOT RUN and BLOCKED with concrete evidence; no fabricated screenshots or release gates.
