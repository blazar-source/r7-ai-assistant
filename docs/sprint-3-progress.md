# Sprint 3 progress — the void `PasteText` acknowledgement and the new insert contract

Short record of Sprint 3's first item: the native defect proven in
[the Sprint 2 stage-b smoke findings](<../.superpowers/sdd/2026-10-04-sprint-2-agent-runtime/native-smoke-findings.md>).

## The defect

On the live R7-Office 2026.3.1 (Windows desktop, CDP) `Asc.plugin.executeMethod('PasteText', …)`
**applied** the insert and then called its callback with **`undefined`**. The bridge decoded that value
with `insertAcknowledgement`, which required a boolean, so an **applied** mutation was reported as the
ordinary known error `INVALID_DATA` — the mirror image of the R1 defect (an unconfirmed mutation
reported as a plain known error).

## The acknowledgement contract now in force

`src/plugin/bridge.js`, insert path:

1. **`undefined` is never an automatic success** — the callback value is not evidence.
2. **`undefined` is never an ordinary known error** — the paste may have applied.
3. **Preferred path: one independent bounded read.** The ticket stays owned (the mutation is still a
   pending mutation, design §8.4, so the write lock is held for the whole dispatch-plus-confirmation
   window) and the bridge issues **exactly one** `GetSelectedText` — the same confirmed public read
   primitive every other read leg uses — with a byte budget equal to the **dispatched payload's own
   length** (capped by `LIMITS.editorResultBytes`). The effect is verified only when the read
   reproduces the dispatched payload **byte-for-byte**:
   - reproduced → `{ok:true, data:{sent:true, effectVerified:true}}`;
   - anything else (a different string, `""`, a malformed or oversized value, a read error, a read
     timeout, a confirmation dispatch that threw) → `APPLY_UNCERTAIN`, which the tool republishes as
     `TOOL_UNCERTAIN` and the runtime stops the run for.
4. **No automatic retry.** Exactly one `PasteText` dispatch; the bridge never re-dispatches a mutation.
5. **R1 survives.** A handler that returns OR throws the uncertain envelope still yields
   `TOOL_UNCERTAIN` and stops the run; the earlier tests are unchanged in strength.
6. **Boolean acknowledgements are untouched**: `true`/`false` still yield
   `{ok:true, data:{sent:<boolean>}}`, read nothing, and mean **sent, effect unverified**.
7. **Every other non-boolean value** (`null`, a string, an object, a number) takes the SAME void path —
   the confirmation read, or the uncertain class. A malformed value is never itself a success claim:
   when it becomes one, the envelope says `effectVerified` because the read proved it.

`GetSelectedText` is the one public read primitive confirmed on the live build; a build whose
`PasteText` does return a value goes through exactly the same door (the code is contract-driven, not
fitted to one build).

## Open — target-build check (NOT claimed here)

- The **target Astra / R7 2026.1.2.1942 build was not exercised**. What a boolean `PasteText`
  acknowledgement means there — and whether `GetSelectedText` really reproduces a pasted payload on
  that editor — is **unverified**. A build where the confirmation read does not reproduce the payload
  degrades to `APPLY_UNCERTAIN` (the run stops fail-safe); it can never produce a success claim.
- The confirmed-effect read was **not** measured natively. This document claims host-side tests only:
  the focused bridge/handler/integration suites, the full `node --test` suite, the static audit and the
  bundle build, all run on the final tree.
