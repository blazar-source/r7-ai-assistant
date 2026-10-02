# ADR 0002: Trusted R7 SDK and static command boundary

Status: Accepted by explicit user clarification.

## Evidence

The installed user Plugin SDK bootstrap matches the vendor package by SHA-256:
`6aa574e212733b12c513622331f52a55adb24450e6990a89dbe45ba35fa6a23a`.
Its `plugin_init` handler evaluates API initialization supplied by the editor. This is not model execution and belongs to the trusted R7 platform boundary.

## Decision

Unmodified official R7 SDK is permitted even where it internally serializes static functions and uses eval or an equivalent mechanism. Do not modify the SDK to avoid that behavior or silently describe it as a zero-dynamic-execution platform.

In authored R7 AI Assistant source prohibit eval, new Function, Function calls, executing strings as JavaScript, model-generated JS/DocScript and passing model-generated code to callCommand. Responses follow only:

`text → JSON parse → schema validation → allowed tool → typed arguments → R7 API`.

callCommand may receive only author-written static functions. Model-derived arguments cross via JSON-serializable Asc.scope or typed executeMethod arguments after schema and policy validation. Never interpolate model data into source code.

## Enforcement

Add a static audit over authored source and build tooling. Vendor/runtime R7 is excluded as an explicit trusted boundary, not a general exclusion for arbitrary code. Test rejection of eval, Function construction, indirect global dynamic execution and string timers; test allowance of immutable author-written callCommand function bodies. Include an archive/source inventory and SDK fingerprint in compatibility/security evidence.

## Consequences

Any CSP required for platform initialization must explicitly document why trusted SDK needs dynamic execution; CSP alone cannot isolate SDK eval from authored code in the same frame. Static checks, typed tools, bounded schemas and absence of model-written commands remain required. SDK initialization permission never authorizes model-generated code execution.
