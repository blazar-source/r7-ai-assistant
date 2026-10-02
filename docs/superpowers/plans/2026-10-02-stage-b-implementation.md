# Stage B Compatibility Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement and exercise only the accepted Stage B embedded R7 compatibility slice; produce evidence, not a premature Pilot RC.

**Architecture:** Self-contained browser plugin using the installed unchanged R7 SDK, small pure validation/settings modules, one-shot strict-bank HTTPS and a callback-owned editor bridge. UI owns chat/request/preview generations; editor mutations remain disabled unless runtime proves the narrowly supported target domain and atomic identity guard. Test HTTPS infrastructure lives outside the shipped allowlist and cannot bypass certificate validation.

**Tech Stack:** Browser JavaScript/CSS/HTML, R7 Plugin API, Node built-in test runner for development only, pinned Acorn for source audit; pinned esbuild for static browser bundling when needed. No runtime dependencies/services/CDN. Deterministic ZIP STORE packaging using Node standard library.

**Spec:** ../specs/2026-10-02-compatibility-vertical-slice-design.md (accepted by user, including trusted TLS mock addendum).

## Global Constraints

- Execute Stage B only. Do not start C–M, broad tool registry, agent loop/repair, DEB, enterprise policies or certification.
- Astra 1.7.9.41 advanced(voronezh), x86_64, kernel 6.1.152-1-generic, X11/Fly, R7 2026.1.2.1942 are the actual runtime gate.
- isVisual:true, isInsideMode:true, isModal:false; word/cell/slide panels mandatory, no positioning hacks.
- No production localhost HTTP/TCP, WebSocket, daemon, MCP, external Node/agent, telemetry or runtime downloads.
- Strict-bank body has only model/messages/max_tokens/temperature; read text choices[].message.content only. No native tools, streaming or structured-output API.
- Endpoint is a full HTTPS URL ending /v1/chat/completions (optional provider prefix), no URL credentials/query/fragment. No model substitutions or baked-in endpoint/key.
- New chat rotates chat UUID. Test connection always has a separate temporary UUID and no chat mutation.
- ASK cannot mutate. B always previews EDIT; never autoSave. Document/model text is untrusted; use textContent.
- No authored eval/new Function/Function/string execution or generated command bodies. Static inline function callCommand only; data via validated typed arguments/Asc.scope. Installed official SDK trusted under ADR 0002, unchanged, excluded narrowly from audit.
- Resource caps: settings endpoint/model/key 2048/128/4096 UTF-8 bytes; user/selection/replacement 8192 each; model/JSON/editor result 65536 each; request 98304; HTTP envelope 131072; sent history 32 messages/65536; displayed history 64 entries/131072.
- Callback 5000 ms, total analysis/connection 150000 ms, HTTP setting 5–120 s (default30), preview TTL120000 ms, Apply observation15000 ms. max_tokens64–8192(default1024), temperature0–2(default0.2), default model qwen.
- One active operation/one outstanding callback; immutable ownership/generation and adapter-slot tracking; late/duplicate callbacks cannot act. No retry of uncertain mutation. Dispatched write cannot honestly be cancelled.
- Non-secret namespaced localStorage; key memory default, explicit plain-storage opt-in with warning. No contents/keys/URLs/headers in logs/errors/Git/packages.
- Word B mutation: noncollapsed uniformly formatted text entirely in one ordinary body paragraph. Fail closed for collapsed/mixed/rich/table/field/link/control/drawing/tracked/header/footer/unknown targets. Stable locator+revision/document identity+original text validated at execution in same command/transaction as write. Text equality alone is insufficient.
- HTTPS mock is test infrastructure only, never shipped. Valid hostname/SAN/time/chain, trusted Astra/CEF TLS; no certificate bypass. Trust provisioning is documented/authorized in dev state only, never silent.
- Git local-only, atomic commits/clean boundaries, no remote/publication; approved isolated feature workspace. Preserve clean checkpoint and unsaved work.

## Review Focus

1. SDK async queue/late callback versus Apply ownership (AbortController cannot undo queued writes).
2. Same selected string at two locations and rich objects misclassified as plain text.
3. UTF-8 boundaries, history pair removal, HTTP envelope limit before JSON parse and prototype/unknown fields.
4. Secret lifecycle across opt-in storage failures/reset, safe error taxonomy and immutable settings during request.
5. Actual CEF CSP/origin/CA/preflight/redirect behavior; mock and host tests never substitute for target proof.

## File Map and Stable Interfaces

- src/shared/limits.js, errors.js, bytes.js: immutable caps, closed safe error codes, UTF-8 size/guard (no content in errors).
- src/config/settings.js, storage.js: validateSettings(raw), defaults, SettingsStore with save/load/reset and ephemeral key policy. Return frozen validated values; storage injected for tests.
- scripts/static-audit.mjs: auditSource(source,label) plus CLI over authored source; Acorn8.15.0 dev-only; reject direct/aliased/computed dynamic sinks and nonliteral/static callCommand bodies. Test fixtures are inert source strings, never executed.
- src/ai/protocol.js, transport.js: createRequest(settings,messages,uuid), parseModelContent(content,mode), requestCompletion with injected fetch/timers and cancellation; no agent loop.
- src/shared/session.js: secure UUID, bounded chat/request history and separate connection session.
- src/plugin/bridge.js, commands.js, config.json: callback-owned bridge, audited static editor probes/guarded commands, standard manifest. Capability records are truthful evidence, not guessed booleans.
- src/ui/controller.js, view.js, index.html, styles.css: generation/state machine and DOM rendering; controller dependencies injected for real behavioral tests.
- scripts/build-plugin.mjs, scripts/zip-store.mjs, packaging/plugin/README.md: exact release file allowlist, local bundling, deterministic archive.
- tests/unit/*.test.js, tests/security/*.test.js, tests/integration/*.test.js: focused host regressions/TDD.
- tests/acceptance/infrastructure/https-mock.mjs and README.md: externally configured test TLS server, no runtime/build import. No certs/keys/URLs checked in.
- docs/compatibility-matrix.md, target-environment.md, deployment.md, test-plan.md: actual evidence/steps and honest gaps. No handoff document.

## Task 1: B validation, settings storage and authored-code audit

**Files:** shared limits/errors/bytes, config settings/storage, scripts/static-audit.mjs, unit/settings/bytes and security/audit tests; package.json/package-lock.json, THIRD_PARTY_NOTICES.md, .gitattributes. No transport/editor/UI implementation.

- [x] Read accepted spec/ADR and this task/global constraints. Record baseline commit in ignored plan ledger. Set LF for JS/JSON/MD/scripts via .gitattributes; do not change unrelated documents.
- [x] Write tests first for valid defaults/frozen settings; exact HTTPS suffix/provider prefix; reject URL credentials/query/fragment, CR/LF key/model, unknown settings, numeric extremes/nonfinite values and byte-limit boundaries (including multibyte text).
- [x] Observe RED for missing behavior; avoid claiming module-load syntax errors as behavioral proof. Introduce only minimal stubs if needed to produce assertion-level RED, then implement pure validators.
- [x] Test ephemeral key default, opt-in plaintext warning state, load corruption/unavailable storage, key persistence removal when opting out, reset clears only namespace, and no secret echoed by errors. Implement minimal SettingsStore; never overwrite unrelated keys.
- [x] Pin acorn8.15.0 in devDependencies and update lockfile through npm; no install/build scripts beyond approved standard dev tools. Add node:test scripts; no runtime dependencies. Preserve commercial root license and third-party notice for build tooling.
- [x] Write audit regression tests for eval, optional/aliased/global/computed eval, Function/new Function/constructor chains, string timers, model/variable/string callCommand; valid inline static callCommand with data scope allowed. Indirect dynamic code fail closed; do not claim complete JavaScript sandboxing. Audit is source-control guard, not the model execution boundary.
- [x] Run RED then implement conservative AST checks with clear locations/codes. No vendor SDK source copied; exclude only actual vendor/runtime boundary, not src/plugin wholesale. Keep adversarial source strings inert in tests.
- [x] Focused tests while iterating; full npm test + npm run audit + git diff --check once before commit. Self-review, atomic commit `feat: add bounded settings and authored-code security audit`; report RED/GREEN evidence, touched files, pinned deps and known limits. No test is target compatibility proof.

## Task 2: One-shot bounded strict-bank HTTPS and session protocol

**Files:** ai protocol/transport, shared/session, unit/protocol/session/transport tests. Dependencies: Task1. Do not implement multi-step agent runtime, repair, broad adapters or provider-specific branches.

- [x] Test createRequest exact four-field body, three headers, immutable settings/session inputs, independent connection-test UUID and stable chat UUID; model ID remains verbatim.
- [x] Test JSON final and single replacement proposal (closed schemas, mode enforcement, one optional complete fence, no substring extraction). Reject unknown fields/tools, normal prose, oversized UTF-8 content/replacement and native tool payload fallback. ASK rejects tool proposal even if valid EDIT.
- [x] Test sent history pair culling/count+byte budget with system/current input retained, mandatory-message overflow rejection and display bounds; no document upload except bounded explicitly selected context.
- [x] Observe RED then implement protocol/session helpers, secure UUID using crypto.randomUUID or crypto.getRandomValues fallback (no Math.random session IDs).
- [x] Test fetch POST uses redirect:error, AbortController, no cache/credentials side channels, exact endpoint, no additional native-tool fields. Stream-read transport envelope bytes to enforce cap before accumulation/parse, but never AI/SSE streaming. Reject missing response-reader capability safely.
- [x] Test 401/403/429/5xx, network/DNS/CORS/TLS combined safe classification where CEF cannot distinguish, offline, timeout, external cancellation, oversized envelope and malformed content. Do not include raw error/body/key/endpoint in safe errors. No silent retry/substitution.
- [x] Observe RED and implement injected transport/timer ownership, 150s total cap and setting HTTP deadline; cleanup listeners/timers, ignore late settlement. Request returns only bounded parsed content to caller.
- [x] Full test/audit once; self-review; commit `feat: add one-shot strict-bank transport and isolated sessions`; report evidence. Actual CA/CEF/network acceptance remains Task5.

## Task 3: R7 callback bridge and safe capability/selection probes

**Files:** plugin bridge/commands/config, unit/bridge/commands/manifest tests. Dependencies: Task1. Read installed/package source only for named API risks; no copied implementation/vendor files.

- [x] Verify actual manifest shape from shipped R7 examples before selecting fields. Stable product GUID `asc.{7C91D48E-5F12-4B36-8A90-2DFA8467C013}`, name R7 AI Assistant, word/cell/slide support and required flags; local SDK assets only.
- [x] Test callback—not executeMethod return—is completion; missing/duplicate/late callback, disabled/missing API, one outstanding slot and timeout uncertain state. Test cancellation invalidates UI ownership without pretending platform call was retracted or allowing a queued second call.
- [x] RED then implement small bridge with callback deadline, immutable per-call inputs, slot-release tracking and safe result byte caps. No fabricated cell/slide parity.
- [x] Investigate actual supported word selection locator/revision + object-domain inspection + atomic transaction APIs through specific vendor package definitions and, later, static runtime probe. Keep exact method evidence in existing docs (not speculative names).
- [ ] Test eligibility and execution-time guard including identical text at another location, document change and rich/unknown objects. All author-written command bodies are inline static functions for callCommand; model data through bounded validated Asc.scope. SDK eval remains vendor internal.
- [x] If stable identity/domain/atomic write cannot be proven, implement/read expose truthful unavailable capability and keep mutation disabled. Never ship PasteText-only fallback. Report subgate unresolved; continue independent B UI/transport tests, never claim B PASS.
- [x] Full test/audit, self-review and commit `feat: add callback-owned R7 bridge and guarded capability probes`. Preserve actual API evidence versus NOT RUN distinction.

## Task 4: Embedded Russian UI, lifecycle integration and deterministic plugin archive

**Files:** ui controller/view/html/css; build/zip scripts; pinned esbuild0.25.10 dev-only package/lock/notice if bundling required; packaging/plugin README; integration/controller and build/package tests. Dependencies: Tasks1–3. Scope is B one-shot preview, not agent loop.

- [x] Write controller behavioral tests with injected platform/transport/storage/clock. Cover status, ASK/EDIT, selected-context ownership, explicit preview, TTL, Apply/Cancel, errors and all generation/callback/settings/new-chat/reset/selection changes around requests and pending writes.
- [x] Observe RED, implement state machine with one active operation. Freeze request/preview settings and targets. Dispatched/uncertain mutation disables Stop/New chat/Reset/settings actions until definite outcome; never claim rollback or retry. Show safe Russian explanation for unsupported capabilities/outcome uncertainty.
- [x] Test New chat changes UUID/history only; Test connection creates temporary UUID and no chat entries. Key masked, every connection setting editable, opt-in warning visible, reset namespace only. Storage/CA failures stay recoverable.
- [x] Implement accessible plain DOM view (labels, keyboard controls, aria-live statuses, responsive inside panel) with local system fonts/CSS, textContent only. Local installed SDK references are separate from bundled authored code; no SDK copy or CDN.
- [x] Write failing packaging tests for exact root manifest/asset inventory, local-only imports/assets, mock/test/key/config/runtime exclusion and repeat byte identity. RED then implement deterministic ZIP STORE and local browser bundle. Build writes ignored dist/artifacts only; product allowlist never glob-copies repository/tests/.local.
- [x] Test generated authored bundle with audit; ensure static functions remain static callCommand argument after bundling/minification (disable transformations that obscure reviewed safety boundary). No codegen eval/Function. No source maps/content leaked.
- [x] Full npm test/audit/build and dual archive SHA-256 comparison. Self-review; commit `feat: integrate Stage B panel and deterministic plugin package`. Runtime panel load still NOT RUN until Task5.

## Task 5: Trusted HTTPS test infrastructure and actual Astra/R7 compatibility gate

**Files:** tests/acceptance/infrastructure mock/docs and focused infrastructure tests; existing docs acceptance matrix/deployment/test-plan/target-environment; regression fixes only via owning implementer/review. Dependencies: Task4. Controller owns guest operations; implementer must not change VM/trust or start public services without authorization.

- [x] Write RED tests for mock exact strict-bank routes/fields/headers/session separation, bounded requests, deterministic final/proposal and controlled 401/403/429/5xx/timeout/oversize/redirect responses; no content/header/key logs.
- [x] Implement HTTPS-only mock with externally supplied key/cert paths and explicit listen address; reject missing TLS configuration and implicit HTTP fallback. No actual cert/key/endpoint in Git. Tests may use ignored generated ephemeral material but must not disable TLS verification; trust tests explicitly configure the test CA as trust input.
- [x] Document mock as development infrastructure, exclude from production artifact inventory, and require valid SAN/time/chain plus actual Astra/CEF trust. Determine available authorized trusted endpoint/cert or ask only for security-sensitive CA provisioning if needed. No trust changes to clean checkpoint, no -k/ignore-certificate-errors.
- [x] Verify current VM/checkpoint and unsaved work. Install local archive to actual proven user plugin path in dev state only, using SDK fingerprint and supported manifest/search behavior. Keep screenshots/logs outside Git; record only synthetic fixture/evidence metadata.
- [ ] Launch plugin inside actual word/cell/slide and verify local assets/CSP, init/Asc.plugin/executeMethod/callCommand/Api behavior, actual CEF capabilities, callback results and no new product runtime service/ports. Record each capability separately, not just aggregate 'loaded'.
- [ ] Prove selection guard/domain/write/formatting/undo on disposable supported and denied fixtures. If API safety impossible, report actual failure and keep Apply disabled; do not relax contract or begin C–M.
- [ ] Test direct HTTPS mock preflight/Authorization/Content-Type/X-Session-ID, separate connection session, content-only response, errors/offline/timeout/cancel/redirect refusal/envelope cap with valid trusted TLS. Test real settings restart/reset/opt-in deletion and absence of secrets.
- [ ] If authorized OpenRouter key is available outside Git, test exact primary+additional model IDs in strict-bank with synthetic selection only; otherwise report credential dependency. Never substitute IDs, native tools or response_format. Mock does not prove bank-specific CA/CORS/checkpoint.
- [x] Run focused regressions after actual defects; owning implementer fixes with RED/GREEN, fresh scoped re-review. Update matrix with PASS/FAIL/NOT RUN and evidence. Do not claim full Pilot/release or ZPS certification.
- [ ] Whole-branch independent review after host implementation plus actual gate evidence; review task verdicts and inherited risks. Commit stage evidence, clean tree. If all B criteria pass mark Stage B complete only; otherwise concrete report of remaining runtime/security dependency. Stop before C–M.

## Current execution status (evidence reconciliation, not scope expansion)

Host implementation steps are checked as implemented/tested under the failclosed fallback; they do not certify positive mutation semantics or target PASS. Actual standalone archive installation and narrow all-three inside/native transport/settings evidence are measured in the [matrix](<../../compatibility-matrix.md>). Task3 execution-time eligibility/identity/atomic-write proof remains unchecked/unresolved. Task5 composite native API/CSP/lifecycle, safe mutation/formatting/undo, full settings/custom restart and session attribution remain partial or NOT RUN. Bank requests remain NOT RUN until separately authorized Pilot RC work.

Whole-branch independent review found one authored static-audit enforcement regression (reflective constructor extraction), reproduced using inert parser input. Owning-implementer TDD fix becb6c5 is independently SPEC PASS/QUALITY APPROVED (C0/I0/M0); parent post-fix full356 tests/audit/two byte-identical builds pass with unchanged production archive508750. Acceptance review permits an explicit terminal failed/unresolved mutation report with Apply disabled, not a claim that all R7 API possibilities are impossible. No C–M/main integration/merge/push/publication is authorized. Final checklist completion is withheld until the bounded terminal gate report and evidence reconciliation are verified; mutation remains unresolved.

## Execution and Checkpoints

User has already authorized planning and execution using subagent-driven-development. Do not ask again whether to execute or select method. Fresh implementer per task, task reviewer covers spec+quality, max five fix/re-review rounds per task; broad final review. No simultaneous implementers. Use ignored plan-scoped .superpowers/sdd ledger/review packages; durable product decisions and evidence live in Git, not handoff files. Controller does not patch implementation after review: send findings to owning implementer.

Baseline: bootstrap has no product tests/scripts; record NOT RUN, do not claim zero tests as a passing suite. Source remains on an isolated local feature branch/worktree; no push/remote/publish. Security-sensitive trust changes, destructive checkpoint actions and integration outside the worktree require explicit authorization. Scope remains B even if the larger original goal mentions Pilot RC.
