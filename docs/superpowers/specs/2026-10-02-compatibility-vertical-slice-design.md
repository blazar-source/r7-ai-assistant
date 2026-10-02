# Compatibility vertical slice design

Status: Proposed implementation design; runtime gate NOT RUN.

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

User supplies full HTTPS completion URL; no baked-in user hostname/key. Default model qwen. Timeout 30 seconds (5–120 seconds), max_tokens 1024 (64–8192), temperature 0.2 (0–2). One chat UUID stable across connection/AI requests and rotated for new chat.

Store non-secret settings in namespaced user CEF localStorage after validating reads. Session key defaults to memory only. Explicit opt-in to remember it may use the same user-level plain storage with a visible warning that it is not encrypted; do not claim a key vault. Reset clears the namespace/key and cancels active operations. Storage unavailable/corrupt is recoverable, not a reason to log content or wipe unrelated data. Restart persistence is tested in real CEF, not assumed.

## Document and model boundary

Document context is untrusted and limited to selection by default (8192 UTF-8 bytes); no automatic whole-document upload. For ASK, accept only a closed JSON final response and render its message as plain text. For EDIT, only a closed JSON proposal for the single allowed selection-replacement tool can become preview; malformed JSON and ordinary text are errors, never executable fallbacks. General multi-step Agent Runtime and controlled repair are deferred until B PASS. Bound JSON response and proposal/result data to 65536 UTF-8 bytes before processing.

Word GetSelectedText/PasteText are package-evidenced, not yet runtime-proven. Cell/slide selected context capabilities must be probed separately; unavailable operations disabled with an explanation rather than fabricated support. No replace action enabled until actual semantics and formatting preservation are verified on a disposable fixture. Apply rereads context and rejects stale selection; always explicit preview in this slice. Never Save automatically. Native undo and formatting are visually tested.

## Security

ADR 0002 is binding: no authored eval/Function/string execution, no model-generated callCommand. Static check must reject direct and indirect dynamic execution and non-static callCommand bodies; vendor SDK remains unchanged and outside authored audit scope. No external telemetry, content logs, CDN, local sockets, daemon, WebSocket, Node user runtime or TLS bypass. Network request limited to configured HTTPS endpoint; reject URL credentials, fragments, non-HTTPS and redirects to another origin. If XHR/CEF cannot enforce required redirect constraints, record a gate failure rather than claim enforcement.

## Acceptance and stop conditions

Host tests: settings validation/storage errors, static audit rejection/allowance, exact strict-bank shape, cancellation/timeouts, content-only parsing, selection adapter callback/error behavior and stale preview. These are not R7 compatibility proof.

Target evidence: panel loads inside all three editors, local assets only, read selected text, preview replacement, formatting preserved and undo works, settings survive restart where enabled, reset deletes stored config, direct POST includes required headers/session ID and content response is displayed. Test HTTPS/CORS/OPTIONS/CA and 401/403/429/5xx/network/offline/timeout. Report PASS/FAIL/NOT RUN individually. Authenticated model test requires a user-authorized credential; no secret enters fixtures/archive/Git.

Stop for proved network/platform blocker, needed secret/admin user action or risk of data loss. Never restore clean checkpoint over active work. Do not declare B PASS from package inspection, mocks or generic browser tests.

## Execution

Use subagent-driven-development: isolated feature work, fresh implementer and task review per independent component, broad final review. Preserve atomic commits, clean stage boundaries and no remote/publication. Implementation plan follows written-spec review. C–M receive their own scoped plans only after this gate passes.
