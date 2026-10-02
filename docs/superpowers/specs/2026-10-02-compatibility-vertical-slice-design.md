# Compatibility vertical slice design

Status: Accepted by user for Stage B with trusted HTTPS mock requirement; runtime gate NOT RUN. User authorized planning and execution of Stage B only; C–M remain outside current execution scope.

## Purpose

Build the first maintainable slice of R7 AI Assistant, not a disposable PoC: a visual inside panel in word/cell/slide, connection settings, selected context, direct strict-bank HTTPS and previewed replacement of a disposable Word selection. All later agent/editor functionality remains gated on target runtime evidence.

## Verified foundation

Guest Astra build 1.7.9.41, advanced(voronezh), x86_64, kernel 6.1.152-1-generic, X11/Fly. Running professional R7 Desktop 2026.1.2.1942 and installed package 2026.1.2-1942~astra-signed confirmed. R7 currently reports a 30-day trial. Existing clean checkpoint preserved; separate 03-r7-ai-dev-baseline created. ZPS status is not proven because its status utility requires root.

System plugin root and existing user plugin root/SDK are identified through actual guest SFTP. Writable installation/search behavior still requires test installation. SDK is trusted only under ADR 0002.

## Architecture choices

1. Recommended: standard R7 inside plugin, browser JS/CSS, locally installed unmodified SDK and direct HTTPS. Meets zero-service runtime requirements and package code exposes inside-panel support.
2. Zero-port embedded alternative: research only if direct HTTPS is proven impossible. No speculative alternative implementation.
3. External bridge/daemon/MCP: excluded by product specification, not an option.

## Slice boundaries

- `plugin`: manifest, local SDK initialization and callback-based adapter. executeMethod returns transport status; completion comes from callback. No assumption that UI side or API method parity is configurable.
- `shared/config`: validated immutable effective settings from a replaceable configuration-provider boundary; every setting editable in Pilot. No roles/managed policies.
- `ai`: strict-bank Fetch adapter using only model/messages/max_tokens/temperature; headers Authorization, Content-Type, X-Session-ID. No tools/tool_choice/tool_calls/streaming/response_format/structured-output API. Use redirect:error and AbortController; if the exact CEF lacks these capabilities, investigate supported safe transport rather than silently downgrade redirect/TLS policy. Require text message content; safe classified errors, timeout and cancellation. Main external test model qwen/qwen3.8-27b:free, additional compatibility qwen/qwen3.8-max-0902; never silently substitute models.
- `ui`: Russian chat/status, new chat, ASK/EDIT, context indicator, settings, connection test and preview Apply/Cancel. Use textContent, never model HTML.
- `security`: strict settings/argument validation, source static audit and bounded context/results. Authored functions only; no model code.
- `scripts/packaging`: reproducible local plugin archive and tests. DEB deferred until target deployment behavior is verified; no guessed maintainer scripts.

## Connection and storage

User supplies a full HTTPS completion URL ending in `/v1/chat/completions`; a provider prefix before `/v1` is permitted. Reject credentials, query strings and fragments in that URL; do not append paths automatically. No baked-in user hostname/key. Default model qwen. Timeout 30 seconds (5–120 seconds), max_tokens 1024 (64–8192), temperature 0.2 (0–2). One chat UUID stable across AI requests and rotated for New chat. Each Test connection action creates a separate temporary UUID, never reuses/rotates the chat UUID and never adds its request/response to chat messages.

Store non-secret settings in namespaced user CEF localStorage after validating reads. Session key defaults to memory only. Explicit opt-in to remember it may use the same user-level plain storage with a visible warning that it is not encrypted; do not claim a key vault. Reset clears the namespace/key and cancels active operations. Storage unavailable/corrupt is recoverable, not a reason to log content or wipe unrelated data. Restart persistence is tested in real CEF, not assumed.

## Document and model boundary

Document context is untrusted and limited to selection by default (8192 UTF-8 bytes); no automatic whole-document upload. For ASK, accept only a closed JSON final response and render its message as plain text. For EDIT, only a closed JSON proposal for the single allowed selection-replacement tool can become preview; malformed JSON and ordinary text are errors, never executable fallbacks. General multi-step Agent Runtime and controlled repair are deferred until B PASS. Bound JSON response and proposal/result data to 65536 UTF-8 bytes before processing.

Word GetSelectedText/PasteText are package-evidenced, not yet runtime-proven. GetSelectedText alone does not establish mutation safety. B's mutation domain is a noncollapsed text-only selection wholly inside one ordinary body paragraph, with uniform character formatting. Reject selections involving tables, mixed runs, hyperlinks, fields, content controls, drawings, tracked changes, headers/footers or unknown objects; inability to prove eligibility also denies mutation. Mixed/rich domains belong to later E, not an implicit PasteText permission.

Always explicit preview. Capture document/editor identity and a stable selection locator/revision, not just selected text. The author-written mutation command must validate this locator/revision, eligible object domain and original text at execution time before touching the document, in the same editor command/transaction as the write. Discover the actual supported API before choosing implementation; do not invent SDK methods or treat asynchronous GetSelectedText then PasteText as atomic. If exact R7 cannot provide safe identity/atomic validation for this domain, leave Apply disabled and report B's mutation subgate as failed/unresolved. Identical text at another location must not pass the guard. Verify formatting and undo visually on a disposable uniform-format fixture plus denied rich-object fixtures. Never Save automatically.

Cell/slide read capabilities are probed independently. B requires inside panels and a truthful editor/context/capability indication in all three editors; Word selected text + eligible preview/apply/formatting/undo are mandatory for B PASS. Cell/slide range/object read and mutation tools remain F/G scope: unavailable capabilities may be visibly disabled, never falsely reported as successful.

## B lifecycle and resource contract

One active assistant operation and at most one outstanding R7 API callback; never queue a second editor operation behind an unresolved one. Every operation owns immutable settings, chat UUID, editor/document identity and a monotonically increasing generation. Settings changes, Stop, New chat, Reset, editor/document/selection changes invalidate analysis and uncommitted previews. Ignore late/duplicate callbacks for UI/model state, but track adapter-slot release independently. A timed-out R7 callback leaves the bridge busy/uncertain until it settles or the plugin is safely reinitialized; do not automatically retry a mutation or start another call while its outcome is unknown.

Each callback deadline is 5000 ms. Analysis/connection deadline is 150000 ms, with HTTP timeout from settings capped by remaining time. Preview TTL is 120000 ms; expired previews cannot Apply. Applying has a 15000 ms observation deadline, not a promise the platform rolls back a timed-out write. Once a guarded mutation is dispatched, Stop/New chat/Reset/settings changes are disabled until a definite outcome; explain that an accepted editor command cannot be cancelled. If the callback times out, report 'outcome uncertain; check document' and keep mutations disabled. Stop before dispatch prevents the write; after dispatch never claim cancellation/rollback. Cancel affects pending preview only, not completed edits.

Concrete UTF-8 limits, enforced before serialization/copying where authored code controls that allocation:

| Data | Limit | Overflow behavior |
| --- | --- | --- |
| Endpoint / model / key | 2048 / 128 / 4096 bytes | reject settings; never echo key |
| User input / selected text / replacement text | 8192 bytes each | reject; never silently edit truncated selection |
| Chat history sent to model | 32 messages and 65536 bytes | drop oldest complete user/assistant pairs; retain system + current request; reject if mandatory messages alone exceed budget |
| Serialized request body | 98304 bytes | reject before network send |
| HTTP response envelope | 131072 bytes | count transport bytes while reading, abort before accumulating beyond limit |
| Model content / parsed proposal / editor result | 65536 bytes each | reject before parse/processing; do not log discarded content |
| UI conversation | 64 displayed entries and 131072 bytes | remove oldest displayed complete pairs; always retain current bounded response |

HTTP body reading for a byte ceiling is transport buffering only, not AI streaming: do not request stream or consume SSE/tool_calls. If CEF cannot enforce the envelope limit with supported APIs, report capability failure rather than relying on max_tokens. R7 may allocate its own callback payload before our callback; the editor-result bound limits authored processing, not an unproved platform-memory guarantee. Settings/history caps do not permit content logging.

## Security

ADR 0002 is binding: no authored eval/Function/string execution, no model-generated callCommand. Static check must reject direct and indirect dynamic execution and non-static callCommand bodies; vendor SDK remains unchanged and outside authored audit scope. No external telemetry, content logs, CDN, local sockets, daemon, WebSocket, Node user runtime or TLS bypass. Network request limited to configured HTTPS endpoint; reject URL credentials, fragments, non-HTTPS and redirects to another origin. If XHR/CEF cannot enforce required redirect constraints, record a gate failure rather than claim enforcement.

## HTTPS mock trust and packaging boundary

HTTPS mock is test infrastructure only. Keep its implementation under tests/acceptance/infrastructure; endpoints, certificates, private keys, CA material and runtime state are local ignored inputs. Never include the mock server, its dependencies/configuration/certificates or its endpoint in the production plugin archive. No localhost service is part of the end-user runtime.

Its TLS certificate must be valid (time, hostname/SAN and chain) and trusted by the actual Astra/CEF client. No TLS verification bypass, certificate-error flags, curl -k or equivalent. A test CA may be used only when installed through a documented authorized trust process in the separate dev state; never contaminate the clean checkpoint or silently change system/user trust. Missing authorized CA provisioning or a suitable trusted HTTPS endpoint is an explicit test-environment dependency, not grounds for HTTP downgrade or a false gate PASS. Mock success also does not prove the bank's internal CA/CORS compatibility.

## Acceptance and stop conditions

Host tests: settings validation/storage errors, static audit rejection/allowance, exact strict-bank shape, content-only parsing, each UTF-8 boundary including multibyte text, mandatory-message overflow and giant HTTP envelope. Lifecycle tests cover duplicate/missing/late callback, Stop/New chat/Reset/settings/editor changes before response/Apply, preview expiry, mutation timeout with no retry, adapter-slot ownership and same-text-different-location rejection. These are not R7 compatibility proof.

Target evidence: mandatory all-three inside panels, truthful per-editor capabilities and mandatory Word narrow-domain read/guarded-preview/apply/formatting/undo. Verify denial of collapsed/rich/unknown selections, identical text at another location, document switch and selection changes around Apply. Verify local assets and unchanged SDK fingerprint at the actual load path, settings restart/reset, direct POST headers/session ID and displayed content response. Test HTTPS/CORS/OPTIONS/CA, redirect refusal (including same-origin redirect), installed CSP and 401/403/429/5xx/network/offline/timeout. Two builds from the same committed source/input must produce byte-identical plugin archives; compare SHA-256, inventory and absence of secrets/runtime downloads. Report PASS/FAIL/NOT RUN individually. Authenticated model test requires a user-authorized credential; no secret enters fixtures/archive/Git.

Scope precedence: this specification defines the one-shot B slice. General ai-protocol's single controlled repair/multi-step loop is mandatory in D but intentionally not claimed in B. Connection URL policy and storage choice here supersede the earlier 'storage undecided' bootstrap note; no change to strict-bank fields, platform security boundary or overall Pilot acceptance.

Stop for proved network/platform blocker, needed secret/admin user action or risk of data loss. Never restore clean checkpoint over active work. Do not declare B PASS from package inspection, mocks or generic browser tests.

## Execution

Use subagent-driven-development: isolated feature work, fresh implementer and task review per independent component, broad final review. Preserve atomic commits, clean stage boundaries and no remote/publication. Implementation plan follows written-spec review. C–M receive their own scoped plans only after this gate passes.
