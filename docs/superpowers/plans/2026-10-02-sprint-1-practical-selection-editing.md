# Sprint 1 — Practical Word Selection Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. User approved the updated eight-sprint roadmap and execution of Sprint 1 only.

**Goal:** Complete the existing Stage B flow with public-R7 selection replacement, measured formatting/native Undo and the remaining small B acceptance checks. Not Pilot RC.

**Architecture:** Reuse the inside plugin, callback bridge, settings, strict-bank HTTPS and one-shot Preview UI. Immediately before write check the current document/editor, reread the current nonempty selection and compare its exact text to the preview source; write only after explicit Apply. Independently authored public SDK handlers only.

**Tech Stack:** Existing browser JavaScript/CSS, unchanged installed R7 SDK, Node built-in tests/Acorn/esbuild for development only.

**Spec:** [accepted amended design](<../specs/2026-10-02-compatibility-vertical-slice-design.md>). The user's explicitly accepted replacement contract below supersedes old locator/revision/atomicity clauses; historical evidence is not retroactively promoted.

**Current checkpoint:** [portable evidence inventory](<../../sprint-1-progress.md>): Task 1 done; Task 2 prerequisite GO with N09 cross-ID/other-editor branches PARTIAL, not all-cases PASS; Task 3 cb291d7 implementation independently reviewed/completed. Task 4 unchecked composite gates remain IN PROGRESS: exact candidate installed; scoped native Preview/Apply/Undo R10, refusals R11/R14, identical relocation R13 and resumed Cell/Slide truthfulness R15 measured. Additional scoped R16 full-process settings/dummy opt-in restart/logical Reset, R17 session counts, R18 two-Word read-only frame isolation, and R19 normal panel-close/fresh public Read are measured. R17 exact post-Test ASK3 attribution/native namespace isolation and broader cross-document/late-callback/TTL native proof remain PARTIAL or unproved, not whole Task 4 PASS. Fresh broad source/docs review C0/I0/M2 is returned; stale current docs summaries reconciled, minor capability DTO inconsistency retained/deferred. Parent R19 fresh full412/audit/independent archive byte/inventory/exclusion checks pass. R20 fingerprint-guarded owned cleanup is complete; native processes/CA/DEV installation/temporary SSH authorization/client keypair are absent, originals/current fixtures/candidate8/SDK retained unchanged. Independent final docs/disposition review is returned C0/I0/M2 with GO for a local docs commit/concrete partial report after minor status-wording corrections; parent applied those qualifications. Local commit/clean-branch handoff is parent-owned; no invented whole Task 4 PASS. The old production Apply OFF is historical and separate from the current installed reviewed candidate. Parent fresh host412/audit/two exact-eight byte-identical archives do not substitute for native acceptance.

## Global Constraints

- Execute Sprint 1 only on stage-b in D:/Astra_coding/r7-ai-assistant/.worktrees/stage-b. Baseline 9fed7d814d8bff206117b6e12d61df7f39cc5e1e; main bde90803c7e137b2e607947e3da0e15c21802f45 unchanged. No merge/push/publication or later sprint implementation.
- Exact target Astra Linux SE 1.7.9.41 advanced(voronezh), x86_64, kernel 6.1.152-1-generic, X11/Fly; R7 Office 2026.1.2.1942.
- Production standalone inside browser plugin; no localhost service, daemon, MCP, Node dependency, CDN/runtime downloads or telemetry. Keep existing exact-eight-file packaging and strict-bank adapter.
- Editing sequence: user selection -> read -> AI proposal -> Preview -> explicit Apply -> check same current document/editor and reread selection -> require existing nonempty selection and exact original text equality -> public native replacement. On mismatch no write and a clear Russian message: «Выделение изменилось. Повторите команду».
- Do NOT require immutable locator, revision ID, ABA protection, object identity for identical text or an atomic transaction the public SDK does not supply. User manually selecting another identical text is allowed. Do not present asynchronous reread/write as atomic.
- First support ordinary text selection. No universal SmartArt/complex fields/tracked changes/OLE/mixed-rich solution. Reject known unsupported or ambiguous selection using practical public checks; do not resurrect exhaustive ideal-object research as a prerequisite.
- Try ReplaceTextSmart first, then PasteText, then static Document API callCommand if a specific failed scenario requires it. Choose from real native results, not package presence. Verify font, size, bold, italic, color, paragraph style, surrounding text and native Undo restores the original state on disposable fixtures.
- No AGPL copying, model-generated JS/DocScript, authored eval/new Function/Function/string execution, undocumented/private R7/ONLYOFFICE API or automatic Save. Vendor internal execution remains the unchanged trusted ADR 0002 boundary.
- ASK cannot mutate; document/model text untrusted; DOM textContent only. No real documents, keys, raw identifiers, headers, endpoints or payloads in Git/logs/errors/artifacts. Synthetic fixture metadata and count-only observations permitted.
- Keep existing caps: settings endpoint/model/key 2048/128/4096 UTF-8 bytes; user/selection/replacement 8192 each; model/JSON/editor result 65536; request 98304; HTTP envelope 131072; sent history 32 messages/65536; displayed history 64 entries/131072.
- Callback deadline 5000 ms; analysis/connection 150000 ms; HTTP 5–120 s(default30); preview TTL120000 ms; Apply observation15000 ms. One active operation/one callback slot. No uncertain-write retry; do not claim a dispatched write can be cancelled or rolled back. Disable conflicting controls after write dispatch, preserve busy/uncertain ownership until definite settlement.
- Bank TLS/CORS/AUTH/Qwen remain NOT RUN until internal bank installation. No real-model calls in Sprint 1. Network gate: direct plugin/CEF HTTPS mock /v1/chat/completions, CORS ON/OFF, OPTIONS/POST, Authorization/X-Session-ID, timeout/redirect/diagnostics. Reuse closed evidence with explicit provenance; retest only missing scenarios or relevant integration changes.
- Existing authorization for temporary test CA in 03-r7-ai-dev-baseline and narrow temporary Windows firewall rule survives with the original limits/cleanup. Prefer retained guest loopback fixture; verify validity/SAN/trust before reuse. No clean checkpoint restore over active state, system trust contamination, TLS bypass, new daemon/global Node changes or unexplained data loss.
- Runtime FAIL procedure: record exact API/scenario/observed failure; then targeted ready-solution search in official docs/GitHub/issues/PR/plugins and check architecture/license. If multiple practical alternatives, briefly present pros/cons and recommendation. Only if none exists notify user and request permission BEFORE narrow blocker research. No broad precautionary research.

## Review Focus

1. Revalidation before actual write, document/editor mismatch, empty/changed selection and supported-domain refusal; identical relocated text is explicitly permitted.
2. SDK callback queue, mutation dispatch boundary, no post-dispatch false cancellation, late/duplicate/missing callback and uncertain slot semantics.
3. Real font/size/bold/italic/color/paragraph style/Undo, not callback true or unchanged on-disk hashes as in-memory proof.
4. Reuse of transport/UI/storage, strict caps/audit/no secret-content logging and no AGPL/private code.
5. Historical versus fresh artifact/runtime evidence and cleanup; host tests never stand in for native acceptance.

## Task 1: Reconcile binding documents and accepted product roadmap

**Files:** existing docs roadmap/architecture/security/test-plan/compatibility-matrix/stage-b-gate-report, accepted design, original Stage B plan; README only for stale status. No src/tests/runtime/VM changes.

- [x] Read current documents before edits. Amend accepted design to the explicit replacement contract above, retaining platform/network/budget/security/lifecycle constraints.
- [x] Retire original Stage B implementation plan as historical, with a prominent supersession link; retain actual completed steps and old evidence, not an active contradiction.
- [x] Update roadmap to the eight accepted product sprints: practical B selection; bounded agent+Qwen dev; Word tools; Cell tools; Slide tools; common UX/security; packaging/Astra/ZPS; local 0.9.0-pilot-rc.
- [x] Keep old NOT PASS historical and current evidence levels separate; never promote without native tests. Remove locator/revision/ABA/atomicity requirements from active checklists and distinguish measured limitations.
- [x] Record runtime FAIL escalation procedure and native testing/cleanup constraints. Bank gates NOT RUN and later sprints not authorized.
- [x] Initial Task 1 documentation links/diff/scope, local docs commit and scoped review completed. This current evidence reconciliation remains uncommitted for fresh independent review and parent local commit.

## Task 2: Practical disposable native replacement and Undo proof

**Status: prerequisite GO, not whole-checklist PASS.** N03–N08 scoped PASS; N10 relocation/body-format/Undo witness positive with comprehensive fidelity PARTIAL; N09 own-document SDK-frame route positive but cross-ID/other-editor branches PARTIAL; N11 known tracking refusal PASS. Unchecked composite rows retain integrated/branch limits; [inventory](<../../sprint-1-progress.md>) is authoritative for case scope. ReplaceTextSmart is the selected candidate; no fallback is presently required. Old installed production Apply OFF is not reviewed cb291d7 source Apply.

**Owner:** controller operates the one native VM; a fresh implementer may prepare independently authored dev probe/fixtures, but never controls VM/trust concurrently. No broad public primitive inventory.

- [x] Reuse existing verified dev infrastructure; confirm current access, no unsaved user work and actual SDK/load path. If access credential absent, ask for access securely; no guess/bruteforce or secret dumping.
- [x] Prepare small independently authored static public-API test plugin/fixtures outside production package. Try ReplaceTextSmart on ordinary selection. Log only bounded synthetic metadata/counts; inspect format through public reads and native UI. Verify document/editor identity route actually works.
- [ ] Check existing/changed/empty selection, other document/editor, known unsupported fixtures. Verify font,size,bold,italic,color,paragraph style, surrounding text, shorter/longer/empty replacement, native one-step Undo restores pre-write state.
- [ ] On an actual failure use the authorized targeted fallback procedure; next practical API instead of a new research cycle. No private API or model executable code. Record candidate selection and limitations.
- [ ] Collect exact probe source/artifact identity and actual native evidence; cleanup synthetic unsaved edits safely without saving original fixtures. Old installed production Apply was OFF; positive DEV results now underpin reviewed cb291d7 integration. Exact-candidate native acceptance and remaining cleanup are Task 4, not closed by this prerequisite.

## Task 3: TDD Apply integration in existing bridge/controller/view

**Files:** src/plugin/commands.js and bridge.js; src/ui/controller.js/view.js/entry.js as needed; shared errors if needed; focused unit/integration/security tests. No agent registry/loop, new transport, rich editor tooling or fake runtime enable flags.

- [x] Fresh implementer reads Task 2 native result and existing source/tests. Write behavioural failing tests first and record real assertion-level RED (50 tests, 45 assertion failures).
- [x] Capture bounded document/editor context with selection. Add callback-owned public same-document/editor revalidation and selection reread, exact text comparison and practical support checks, then selected proven native replacement. Model text remains data only; per-bridge private brand plus actual public ID/tracking, not serialized identity.
- [x] Replace blanket Apply-denial tests with explicit positive/negative contract tests: no preview/ASK, TTL, empty/changed selection, switched document/editor, unsupported domain, user relocated identical text allowed, overflow, callback error/late/duplicate/missing, no unsafe retry.
- [x] Integrate applying/uncertain UI state; conflicting controls disabled only at correct boundary; pre-dispatch Stop prevents write. Late callbacks do not resurrect UI/history or steal slots. Clear honest Russian statuses, no unconditional effect claim from transport return or callback receipt. Movement alone/repeated same-editor init retain unexpired Preview.
- [x] Focused171/full412/audit/reproducible builds/diff check, local cb291d7 commit and independent scoped review completed (C0/I0/M0, security87). Parent fresh full412/audit/exact-eight complete-byte archive comparison recorded in inventory; native integrated testing remains Task 4.

## Task 4: Integrated native acceptance, evidence and final Sprint 1 review

**Files:** acceptance fixtures/infrastructure only if concrete checks missing; existing evidence docs; product fixes only via owning implementer TDD/review.

- [ ] Install exact reviewed candidate to proven dev plugin root, preserve old bytes/SDK and launch native integrated Preview/Apply/Undo with the bounded HTTPS mock. No forged artifact/cache evidence.
- [ ] Verify changed/empty selection and document/editor mismatch no write, known unsupported domain refusal and actual formatting/Undo; latest word/cell/slide UI capability truth retained.
- [ ] Close small remaining settings full-process custom/dummy opt-in restart and persisted dummy-key Reset/namespace checks; count-only ASK1/ASK2/Test/ASK3/New chat UUID attribution. Don't repeat already completed implementation.
- [ ] Reconcile network cases and carry prior closed CORS/TLS/header/timeout/redirect evidence with explicit unchanged-component rationale; run relevant fresh flow and missing scoped diagnostics only. Keep other future adversarial coverage honestly deferred, not silently passed.
- [x] Run parent verification full host suite/audit/two byte-identical committed-source builds; scan production archive excludes fixtures/keys/dev runtime. Fresh broad final review over Sprint 1 changes with historical baseline explained.
- [x] Fingerprint-guarded owned trust removal, mock shutdown/listener absence, remove owned firewall rule if created, Reset synthetic credentials, close R7 safely, preserve original fixtures/checkpoints and designated dev-only retained infrastructure.
- [x] Update per-scenario PASS/FAIL/NOT RUN and exact provenance. Mark Stage B PASS only if the new agreed mandatory contract and network/settings tests are positively evidenced; otherwise concrete partial report. Atomic local commits, clean stage-b, main unchanged. Stop before Sprint 2.
