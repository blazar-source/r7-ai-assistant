# Security and threat model

Current release acceptance is tracked in [the UAT record](evidence/release-uat/verification.md). Earlier security reviews remain bounded evidence for their revisions. The shared encrypted profile supersedes the old memory-only/plaintext-opt-in design. Publication is owner-authorized only after all required checks pass.

## Trust boundaries

User command, settings, remote model response and document data have different authority. Model and document content cannot bypass host policy. Document/comment/embedded content is untrusted even when it contains apparent system instructions. Prompt labels help but are not a security boundary: hard policy controls mutations.

## Trusted R7 platform boundary

Explicit user clarification permits internal dynamic execution of the unmodified official R7 SDK. Its serialization/evaluation of our static callCommand functions is part of the trusted platform, not execution of model code. See [ADR 0002](decisions/0002-trusted-r7-sdk-and-static-command-boundary.md).

Authored source must prohibit eval, new Function, Function calls, executing JavaScript strings and model-generated JS/DocScript. Only static author-written function bodies may be passed to callCommand; schema-validated allowlisted model arguments remain data (Asc.scope or typed executeMethod parameters). Add an automated static audit with an explicit, narrow vendor/runtime exclusion and regression cases for direct/indirect execution.

## Controls

- ASK: all authored mutation tools are denied independent of model output. On the supported R7 build a read command can nevertheless add native history steps and discard Redo after Undo. The owner explicitly accepted this unfixed SDK side effect as a pilot limitation on 2026-10-09; this is not a guarantee that ASK leaves native history unchanged. Restart does not restore lost Redo. See [reproduction and acceptance](evidence/release-uat/slide-redo-blocker.md).
- EDIT: strict closed schemas, tool allowlist, editor capability checks, bounded arguments/results/steps/time and per-tool execution policy (`auto` | `confirm` | `deny`). Only a tool whose policy is `confirm` (today the selection-replacement tool) requires Preview and explicit Apply; ordinary mutations execute under the user's request. ASK exposes no mutation tool at all.
- No eval, arbitrary model JS/DocScript, shell, filesystem commands, daemon, listening sockets or automatic Save.
- Before a public native write, revalidate that tool's declared precondition (for selection-replacement: same current document/editor, reread the current nonempty selection, compare the exact original preview text). Empty/changed selection or document/editor mismatch: no write, «Выделение изменилось. Повторите команду». Manually reselecting identical text elsewhere in the same document/editor is allowed. No immutable locator/revision/ABA/object-identity/atomic-transaction requirement or asynchronous-atomicity claim.
- Ordinary selection first; reject practically known unsupported/ambiguous domains with public checks. No universal rich-object promise or exhaustive classification prerequisite. Measure formatting/surrounding text and native Undo on disposable fixtures; callback success is insufficient.
- One active operation/one callback slot, no uncertain-write retry. After dispatch disable conflicting controls and retain busy/uncertain ownership until definite settlement; do not claim dispatched writes can be cancelled or rolled back.
- No AGPL copying or undocumented/private R7/ONLYOFFICE APIs, except the bounded compatibility notifications below. Public independently authored static handlers only; SDK internals remain the unchanged trusted ADR 0002 boundary.
- Configured HTTPS only, TLS verification intact; reject credentials in URLs, non-HTTPS URLs and unapproved network destinations. Redirect behavior and CSP require real CEF testing.
- Assistant Markdown uses authored DOM elements and textContent; raw HTML stays literal. Only validated HTTPS links become anchors, with noopener/noreferrer; images and executable schemes are not rendered. Document/context/preview text remains literal. No CDN/runtime downloads or telemetry.
- Keys masked, replaceable and deletable; no keys in source/build/Git/logs/errors. One shared per-OS-user IndexedDB profile is encrypted with AES-256-GCM and a non-exportable browser CryptoKey, without a hardcoded key or plaintext fallback. The CryptoKey is kept in the same browser profile: full-profile or running-origin access may permit decryption. This is not an OS vault. Migration removes legacy records only after encrypted commit; Reset uses a tombstone. Logical deletion is not physical DB/WAL or backup erasure. See [connection evidence](evidence/connection-profile/verification.md) and [admin procedure](admin-connection.md).
- Chat in memory only. Logs contain only timestamp/tool/outcome/duration/error class/object count/step; no request/response/document content, headers, key or user URL.

## Current authorization and evidence

### Worksheet notification — narrow approved exception, 2026-10-09

The owner explicitly approved one compatibility call, `Api.sheetsChanged()`, after the documented `ApiWorksheet.SetName()` in the static `sheetrename` command. On the tested Astra R7 build, SetName changes the workbook but leaves the visible worksheet tab stale. This notification refreshes the worksheet labels without switching sheets or writing the name twice. It is an undocumented editor-facade method; this exception grants no other private API access and does not permit model-generated code, SDK modification or copying vendor implementation.

The command checks that this method exists before any write. Absence refuses with `CAPABILITY_UNAVAILABLE`; an exception after dispatch returns `APPLY_UNCERTAIN`, retains ownership and never retries. Existing name/order/active-sheet postconditions still apply. Function presence is not proof of rendering: both active and inactive sheet renames require native immediate-display acceptance on each newly supported R7 build. A different editor build is unsupported for this exception until that check passes.

### Slide interface notification — bounded engineering exception, 2026-10-09

Under the owner's renewed authorization to independently fix UAT defects, the static `sliderestructure` (move/duplicate) and `slideformat` handlers use one `Api.UpdateInterfaceState()` after their existing mutations. This is a new narrowly scoped engineering exception, not an extension of the earlier worksheet-only grant or a claim that the owner specifically named this method. Independent review accepted this approach for native verification.

On R7 2026.1.2.1942, the underlying mutation records history, but plugin command finalization omits the interface/history-state refresh: Save stays disabled and closing can discard the change. A plain native selection click makes the change saveable. The facade notification invokes the editor's own state refresh; it does not set a dirty flag, save, select another slide, synthesize a content edit, or access private document objects. No vendor implementation is copied.

Method presence is checked before the first mutation. A missing method refuses with `CAPABILITY_UNAVAILABLE`; a notification exception after mutation is `APPLY_UNCERTAIN`, holds the SDK lease and permits no retry. Reads and ASK never reach this notification. Existing content/order/format postconditions remain required. This compatibility route is limited to the natively verified R7 build; availability alone is not proof on another version. Native move-only/format-only/duplicate, Save/reopen and natural compound UAT must pass before release acceptance. Native Undo/Redo measurements remain mandatory evidence; the owner explicitly accepted the measured extra Undo steps and lost Redo after ASK for this pilot only. This exception does not cover content persistence failures or other security/functional defects.

Current authorized work is Sprint 8 final verification plus the owner-approved Sprint 9 compact panel; see [the current handoff](handoff-to-codex.md) and [Sprint 8 plan](superpowers/plans/2026-10-08-sprint-8-final-verification.md). Sprints 6 and 7 are closed with recorded platform limitations. Local development-model calls on disposable Astra documents are authorized; Bank TLS/CORS/AUTH/Qwen remains NOT RUN until internal installation. Historical Sprint 1 and Stage B reports describe their measured revisions and do not override this authorization or establish current release readiness.

The historical `ab06fef` artifact passed the bounded [independent T5 delta/source/artifact review](evidence/sprint-8/t5-review-ab06fef.md), with no critical or blocking security finding. [Final native verification](evidence/sprint-8/final-verification-ab06fef.md) confirms Word/Cell effects, visible A1 and corrected Slide append/order workflows. [T8](evidence/sprint-8/t8-review-ab06fef.md) is PASS WITH RECORDED LIMITATIONS for the exact local pilot scope. This is not security certification or publication authorization. Slide review remains model-assisted and does not grant new tool authority.

Current source uses private per-bridge WeakMap ownership plus actual public ID/current editor/tracking; ownership records/raw IDs never enter public DTO/model/history/storage/logs or serializable certificates. Equal-ID foreign brands fail; global uniqueness is not assumed. Callback receipt is not effect proof; Stop/timeout/dispose preserve uncertain slot ownership and permanent SDK lease, late actual callbacks release only. No retry/automatic Save/authored Undo; see [reviewed implementation and limits](<sprint-1-progress.md>).

Dev-only PKI preparation and exact temporary CA import were separately user-approved. The runtime owner verified temporary **user-NSS import/export** (one owned entry added, other normalized entries unchanged) and **exact-eight candidate installation**; no root/system/Windows trust or service changes were made. This offline proof does not establish native startup, candidate panel or HTTPS acceptance. Owned footprint cleanup was mandatory and is recorded complete in the [R20 inventory and receipt](<sprint-1-progress.md#L69>), with exact temporary CA/DEV/access removal and preserved unrelated trust/candidate/fixtures. This documentation change itself performs no trust operation; cleanup is parent-observed evidence, not an independent native certificate.

## Release evidence

Injection fixtures, unknown tool/field tests, ASK enforcement, stale Apply, cancellation race, budgets and redacted error tests. Scan source and release archives for secrets and runtime dependencies. Validate CORS, CA, HTTPS headers and network failures on target; ZPS is a separate release gate when bank requires it. Security certification is not claimed.
