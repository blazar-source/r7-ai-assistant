# Test plan

Stage B target acceptance is **PARTIAL / NOT PASS**, not blanket NOT RUN. The [compatibility matrix](<compatibility-matrix.md>) records actual all-three inside panels, Word readonly selection/callback evidence, controlled HTTPS/CORS/profile/timeout/Stop samples, preview denial, key opt-in/out and reset-defaults full restart. Mandatory safe Word domain/identity/revision/atomic replacement/formatting/undo remains UNRESOLVED; Apply is disabled. Custom-settings/remembered-key process restart, persisted-key Reset, native lifecycle invalidation and dedicated CSP/offline controls are not fully evidenced. Controlled trust-absent native no-HTTP refusal is measured; exact certificate-specific attribution remains partial. Host tests are not target proof. The [separate HTTPS mock](<../tests/acceptance/infrastructure/README.md>) and Node/OpenSSL are development-only; full `npm test` discovers them and missing required host OpenSSL fails rather than claiming proof. Real bank CA/CORS/AUTH/Qwen acceptance is NOT RUN until separately authorized Pilot RC work.

## A/B blocking gate

Verify exact OS/R7, real paths/SDK, word/cell/slide inside visual panel. Selection read/replace, formatting preservation and undo on disposable fixtures. Direct CEF HTTPS POST, Authorization, stable X-Session-ID and text response shown in UI. Test CORS/preflight, trusted/internal CA, timeout, DNS/offline, 401/403/429/5xx. No TLS bypass and no backend changes.

## B host tests before runtime gate

Use the reviewed slice's concrete UTF-8/operation budgets. Test static audit, strict-bank shape, isolated connection-test UUID, storage failures, callback/Stop/reset races and narrow-domain stale-target guards. Passing mocks only permits target testing, never B PASS. Repeat plugin archive build twice and compare bytes/SHA-256.

## Broader automated suites after gate PASS

Unit: strict-bank shape, content-only parse, JSON/fences/repair, closed schemas, forbidden tools, budgets, ASK policy, key redaction, settings validation.
Integration: bounded multi-step loop, timeout/cancel, stale target, result truncation, injection fixtures, preview cancellation and editor adapter capability failures.
Primary AI acceptance uses `qwen/qwen3.8-27b:free` strict-bank; additional compatibility uses `qwen/qwen3.8-max-0902`. Bank setting is `qwen`, exact served checkpoint pending. Never substitute targets automatically. No native tools, streaming or structured output API. Keys never committed.

## Stage B target checks still required for PASS

- Prove ordinary-body uniform Word domain, stable document/selection locator+revision, same-text/ABA rejection and atomic guard/write; visually verify formatting and undo. Until proven, retain Apply denial and report failed/unresolved gate—not SDK impossibility.
- Prove bounded custom nonsecret settings and public-dummy remembered-key restart; test Reset with a persisted opt-in dummy key. A separate final cleanup measured populated memory-key Reset; it is not persisted-key erasure proof. Logical storage removal is not physical DB/WAL erasure.
- Measure real selection/document/editor invalidation and explicit installed-CSP/offline controls; retain partial native lifecycle evidence honestly.
- Attribute chat-session equality with count-only booleans across ASK1/ASK2/Test/ASK3/New chat; aggregate repeatedSessions does not identify the post-Test UUID.
- A terminal B NOT PASS report is permitted by the accepted specification when the mutation subgate remains unresolved. Do not perform unsafe writes or weaken security to turn incomplete evidence into PASS.

## Later-scope real editor and packaging acceptance (C–M; not authorized by Stage B)

DOCX: select/rewrite paragraph, preserve formatting, tables/formatting/lists, user Save, close/reopen and visual inspection.
XLSX: read range, update values/formulas/styles, add sheet, Save/reopen; verify values and formulas.
PPTX: read current slide, change text/styles, add object/slide, move slide, Save/reopen and visual inspection; unsupported objects preserved.
Settings: enter connection, test, restart, restore allowed settings, masked key, no secrets in logs, reset removes stored config.
Packaging: archive inventory/SBOM/checksums, clean install, upgrade, uninstall, no daemon/listening ports/Node/runtime downloads; separate ZPS ON state.

Each defect: minimal reproducer → failing regression → fix → verified PASS. Reports distinguish PASS, FAIL, NOT RUN and BLOCKED with concrete evidence; no fabricated screenshots or release gates.
