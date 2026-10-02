# Test plan

## Authority and status

The [amended accepted design](<superpowers/specs/2026-10-02-compatibility-vertical-slice-design.md>) and [Sprint 1 plan](<superpowers/plans/2026-10-02-sprint-1-practical-selection-editing.md>) define the active practical editing contract. Only Sprint 1 of the [eight accepted sprints](<roadmap.md>) is authorized. Documentation reconciliation IN PROGRESS; fresh native practical editing acceptance **NOT RUN**; product Apply remains disabled. No tests/runtime code changes or native operations are part of Task 1.

The [historical Stage B report](<stage-b-gate-report.md>) remains **PARTIAL / NOT PASS**, not retroactively PASS. The [compatibility matrix](<compatibility-matrix.md>) records actual all-three inside panels, Word readonly selection/callback evidence, controlled HTTPS/CORS/profile/timeout/Stop samples, preview denial, key opt-in/out and Reset-defaults full restart, with per-artifact provenance. Earlier locator/revision/ABA/atomicity gaps explain the old outcome but are not current checklist prerequisites. Formatting/native Undo and positive practical replacement still need measurement. Host tests never prove native acceptance. Parent reports a fresh baseline 356/356 and audit PASS; docs-only reconciliation need not repeat that suite.

## Sprint 1 host and native gates

- Host integration (later Sprint 1 task): behavioural RED/GREEN for Preview/explicit Apply, ASK/no-preview denial, TTL, same current document/editor check, current nonempty selection reread and exact original-text comparison. Empty/changed selection or mismatched document/editor: no write, «Выделение изменилось. Повторите команду». User manually selecting identical text elsewhere in the same document/editor must be allowed. No immutable locator, revision ID, ABA, identical-text object identity or atomic transaction proof; asynchronous reread/write is not atomic.
- Practical ordinary text first: reject known unsupported/ambiguous selection using public checks. No universal SmartArt/complex fields/tracked changes/OLE/mixed-rich support or exhaustive ideal-object inventory prerequisite. Try ReplaceTextSmart, then PasteText, then static Document API callCommand only after a specific failed scenario. Select by real native results, not package presence.
- Disposable native fixtures: verify font, size, bold, italic, color, paragraph style, surrounding text, shorter/longer/empty replacement and native one-step Undo restoring the original state. Callback true and unchanged on-disk hashes do not establish in-memory fidelity. Never autoSave; no real user documents or payloads/keys/headers/endpoints/raw identifiers in artifacts.
- Preserve one operation/one callback slot; test late/duplicate/missing callback, dispatch exception, pre-dispatch Stop and post-dispatch disabled conflicting controls. Callback5000ms, analysis/connection150000ms, HTTP5–120s(default30), previewTTL120000ms, Apply observation15000ms. No retry of uncertain writes; keep busy/uncertain ownership until definite settlement. Do not claim an accepted write can be cancelled/rolled back.
- All-three inside UI/editor/capability indication stays truthful; Cell/Slide tools are not part of Sprint 1. Use public/static author-written handlers only, unchanged trusted SDK, no AGPL copying/private API/authored eval/Function/string execution/model JS/DocScript.
- Remaining small native checks: bounded custom nonsecret settings and public-dummy remembered-key full-process restart; persisted opt-in dummy-key Reset/namespace checks. Previously measured populated memory-key Reset is not persisted-key erasure proof; logical removal is not physical DB/WAL erasure. Selection/document/editor invalidation and dedicated CSP/offline evidence remain partial, not silently passed.
- Count-only session equality for ASK1/ASK2/Test/ASK3/New chat: aggregate repeatedSessions does not identify the post-Test UUID. No raw IDs or payload dumps.
- Parent integration/final gate: full host suite, authored audit, two committed-source byte-identical builds/SHA-256 and unchanged exact-eight-file archive exclusions. Host mocks permit native testing, never B PASS. Task 1 checks only docs links/scope/diff and self-review; independent scoped review is parent-owned.

## Network evidence reuse and remaining tests

Exact Astra1.7.9.41 advanced(voronezh), x86_64/kernel6.1.152-1-generic/X11-Fly; R7 Office2026.1.2.1942. Direct plugin/CEF HTTPS mock `/v1/chat/completions`: CORS ON/OFF, OPTIONS/POST, Authorization/X-Session-ID, timeout/redirect/diagnostics. Reuse closed evidence with explicit artifact/component provenance; retest only missing cases or relevant integration changes. The [separate HTTPS mock](<../tests/acceptance/infrastructure/README.md>) and Node/OpenSSL are development-only and excluded from production. Full `npm test` discovers infrastructure tests; missing required host OpenSSL fails, not proof.

Keep actual 401/403/429/503/307/envelope/timeout/Stop samples narrow. Controlled trust-absent native no-HTTP refusal is measured, but exact certificate-specific attribution is PARTIAL. Dedicated installed-CSP/offline, duplicate/late/partial-body and exact deadline coverage are not inferred from host doubles. Bank TLS/CORS/AUTH/Qwen **NOT RUN** until internal bank installation; **no real-model calls in Sprint 1**. Catalog availability does not prove authenticated models. No silent model substitution, native tools, AI streaming or structured-output API.

## Native operation ownership and cleanup (later Sprint 1 tasks only)

Controller owns the single native VM. Reuse verified dev infrastructure after checking access, current state, unsaved work, SDK/load path and retained fixture certificate validity/SAN/trust. Existing temporary test CA authorization in `03-r7-ai-dev-baseline` and narrow temporary Windows firewall authorization survive only within original limits/cleanup; prefer retained guest IPv4 loopback fixture. No VM/SSH/trust/firewall/network/model actions in Task 1. Do not restore clean checkpoints over active state, contaminate system trust, bypass TLS, add a new daemon/global Node or cause unexplained data loss.

Only disposable synthetic fixtures; inspect native UI/public reads, preserve original fixture state, clean synthetic unsaved edits without saving originals. Record exact source/artifact/probe provenance and measured outcome boundaries. Fingerprint-guarded owned trust removal, graceful owned mock shutdown/listener absence, remove owned firewall rule if created, Reset dummy credentials, close R7 safely and preserve original fixtures/checkpoints/designated dev-only retention. No forced discard of unrelated work or deleting unrelated locks/certificates.

## Runtime FAIL escalation

1. Record exact public API, scenario and observed failure.
2. Targeted ready-solution search in official docs/GitHub/issues/PR/plugins; check architecture/license before reuse. No AGPL copying/private API/security relaxation.
3. If multiple practical alternatives exist, briefly present pros/cons and recommendation; follow the measured fallback order rather than start a broad research cycle.
4. Only if none exists notify the user and request permission **before** narrow blocker research. No broad precautionary research. Stop for secret/admin action or data-loss risk.

## Later accepted scope — NOT AUTHORIZED / NOT RUN

Sprint 2: bounded agent/JSON schemas/repair and Qwen development validation; Sprint 3: Word tools; Sprint 4: Cell tools; Sprint 5: Slide tools; Sprint 6: common UX/security; Sprint 7: packaging/Astra/ZPS; Sprint 8: verified local `0.9.0-pilot-rc`, no publication. Each needs its own authorization; passing B does not start them. Real bank acceptance stays NOT RUN until internal installation.

Reports use per-scenario PASS/FAIL/NOT RUN/BLOCKED and exact provenance. Old NOT PASS stays historical. Mark current B PASS only after the new mandatory practical editing, formatting/Undo, network/settings checks are positively evidenced; otherwise concrete partial report. No fabricated native proof or enabling Apply from documentation.
