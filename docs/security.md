# Security and threat model

## Trust boundaries

User command, settings, remote model response and document data have different authority. Model and document content cannot bypass host policy. Document/comment/embedded content is untrusted even when it contains apparent system instructions. Prompt labels help but are not a security boundary: hard policy controls mutations.

## Controls

- ASK: all mutations denied independent of model output.
- EDIT: strict closed schemas, tool allowlist, editor capability checks, bounded arguments/results/steps/time, preview and explicit approval for substantial changes.
- No eval, arbitrary model JS/DocScript, shell, filesystem commands, daemon, listening sockets or automatic Save.
- Revalidate target before Apply; preserve unsupported objects and native undo where verified.
- Configured HTTPS only, TLS verification intact; reject credentials in URLs, non-HTTPS URLs and unapproved network destinations. Redirect behavior and CSP require real CEF testing.
- DOM text rendered as text, never model-provided HTML. No CDN/runtime downloads or telemetry.
- Keys masked, replaceable and deletable. Not in source/build/Git/logs/errors. Storage mechanism is undecided until SDK/CEF inspection; do not claim encryption. Prefer ephemeral key unless persisted storage has explicitly understood risks.
- Chat in memory only. Logs contain only timestamp/tool/outcome/duration/error class/object count/step; no request/response/document content, headers, key or user URL.

## Release evidence

Injection fixtures, unknown tool/field tests, ASK enforcement, stale Apply, cancellation race, budgets and redacted error tests. Scan source and release archives for secrets and runtime dependencies. Validate CORS, CA, HTTPS headers and network failures on target; ZPS is a separate release gate when bank requires it. Security certification is not claimed.
