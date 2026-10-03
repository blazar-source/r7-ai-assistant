# Security and threat model

## Trust boundaries

User command, settings, remote model response and document data have different authority. Model and document content cannot bypass host policy. Document/comment/embedded content is untrusted even when it contains apparent system instructions. Prompt labels help but are not a security boundary: hard policy controls mutations.

## Trusted R7 platform boundary

Explicit user clarification permits internal dynamic execution of the unmodified official R7 SDK. Its serialization/evaluation of our static callCommand functions is part of the trusted platform, not execution of model code. See [ADR 0002](decisions/0002-trusted-r7-sdk-and-static-command-boundary.md).

Authored source must prohibit eval, new Function, Function calls, executing JavaScript strings and model-generated JS/DocScript. Only static author-written function bodies may be passed to callCommand; schema-validated allowlisted model arguments remain data (Asc.scope or typed executeMethod parameters). Add an automated static audit with an explicit, narrow vendor/runtime exclusion and regression cases for direct/indirect execution.

## Controls

- ASK: all mutations denied independent of model output.
- EDIT: strict closed schemas, tool allowlist, editor capability checks, bounded arguments/results/steps/time; every selection replacement requires Preview and explicit Apply.
- No eval, arbitrary model JS/DocScript, shell, filesystem commands, daemon, listening sockets or automatic Save.
- Before public native write check same current document/editor, reread current nonempty selection and compare exact original preview text. Empty/changed selection or document/editor mismatch: no write, «Выделение изменилось. Повторите команду». Manually reselecting identical text elsewhere in the same document/editor is allowed. No immutable locator/revision/ABA/object-identity/atomic-transaction requirement or asynchronous-atomicity claim.
- Ordinary selection first; reject practically known unsupported/ambiguous domains with public checks. No universal rich-object promise or exhaustive classification prerequisite. Measure formatting/surrounding text and native Undo on disposable fixtures; callback success is insufficient.
- One active operation/one callback slot, no uncertain-write retry. After dispatch disable conflicting controls and retain busy/uncertain ownership until definite settlement; do not claim dispatched writes can be cancelled or rolled back.
- No AGPL copying or undocumented/private R7/ONLYOFFICE APIs. Public independently authored static handlers only; SDK internals remain the unchanged trusted ADR 0002 boundary.
- Configured HTTPS only, TLS verification intact; reject credentials in URLs, non-HTTPS URLs and unapproved network destinations. Redirect behavior and CSP require real CEF testing.
- DOM text rendered as text, never model-provided HTML. No CDN/runtime downloads or telemetry.
- Keys masked, replaceable and deletable. Not in source/build/Git/logs/errors. Proposed B storage contract: non-secret settings in namespaced user CEF localStorage; key in memory by default, plain localStorage only with explicit opt-in and an unencrypted-storage warning. Do not claim encryption or a key vault. R16 now measures custom settings/dummy opt-in key full-process restart and logical persisted-dummy Reset followed by fresh-frame defaults; native other-namespace isolation and broader storage-failure behavior remain target gates. Logical deletion is not physical DB/WAL erasure.
- Chat in memory only. Logs contain only timestamp/tool/outcome/duration/error class/object count/step; no request/response/document content, headers, key or user URL.

## Current authorization and evidence

Only [Sprint 1](<superpowers/plans/2026-10-02-sprint-1-practical-selection-editing.md>) is authorized under the [amended design](<superpowers/specs/2026-10-02-compatibility-vertical-slice-design.md>); [current evidence inventory](<sprint-1-progress.md>) records measured DEV probe prerequisite GO and independently reviewed cb291d7 Apply implementation, plus Task 4 IN PROGRESS/scoped R10–R17 candidate native evidence, not integrated native readiness or whole Task 4 / Stage B PASS. Task 1 done; old installed production Apply OFF is historical, separate from the current candidate. Historical [Stage B NOT PASS](<stage-b-gate-report.md>) remains historical, not regraded. Bank TLS/CORS/AUTH/Qwen NOT RUN until internal installation; no real-model calls in Sprint 1. Closed evidence reuse, runtime FAIL escalation and native trust/fixture cleanup are governed by the [test plan](<test-plan.md>); Task 1 performs no native/network/trust operations.

Current source uses private per-bridge WeakMap ownership plus actual public ID/current editor/tracking; ownership records/raw IDs never enter public DTO/model/history/storage/logs or serializable certificates. Equal-ID foreign brands fail; global uniqueness is not assumed. Callback receipt is not effect proof; Stop/timeout/dispose preserve uncertain slot ownership and permanent SDK lease, late actual callbacks release only. No retry/automatic Save/authored Undo; see [reviewed implementation and limits](<sprint-1-progress.md>).

Dev-only PKI preparation and exact temporary CA import were separately user-approved. The runtime owner verified temporary **user-NSS import/export** (one owned entry added, other normalized entries unchanged) and **exact-eight candidate installation**; no root/system/Windows trust or service changes were made. This offline proof does not establish native startup, candidate panel or HTTPS acceptance. Owned footprint cleanup was mandatory and is recorded complete in the [R20 inventory and receipt](<sprint-1-progress.md#L69>), with exact temporary CA/DEV/access removal and preserved unrelated trust/candidate/fixtures. This documentation change itself performs no trust operation; cleanup is parent-observed evidence, not an independent native certificate.

## Release evidence

Injection fixtures, unknown tool/field tests, ASK enforcement, stale Apply, cancellation race, budgets and redacted error tests. Scan source and release archives for secrets and runtime dependencies. Validate CORS, CA, HTTPS headers and network failures on target; ZPS is a separate release gate when bank requires it. Security certification is not claimed.
