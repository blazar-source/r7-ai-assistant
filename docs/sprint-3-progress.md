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
3. **Preferred path: an ordered confirmation LADDER of independent bounded reads.** The ticket stays
   owned (the mutation is still a pending mutation, design §8.4, so the write lock is held for the
   whole dispatch-plus-confirmation window) and the bridge dispatches **one read per leg, once**, each
   leg bounded by its own budget. The effect is verified only when a leg reproduces the dispatched
   payload through that leg's own exact rule:
   - **Leg 1 — `GetSelectedText`**: byte-equality against the dispatched payload. Budget: the payload's
     own UTF-8 byte length, capped by `LIMITS.editorResultBytes`.
   - **Leg 2 — `GetCurrentSentence`**: equality against the dispatched payload with exactly **one**
     trailing `"\n"` removed (the `position:'end'` payload is `text + "\n"`, and a sentence read cannot
     contain a paragraph break). Nothing else is normalized — no other whitespace is trimmed, no case
     is folded, no prefix/suffix or fuzzy matching is accepted. Budget: the same payload byte length.
   - every other observation — a different string, `""`, a malformed or byte-oversized value, a read
     error, an observation delivered past the ticket deadline, a leg whose dispatch threw — is **not
     confirmed** and hands the ticket to the next leg. No leg ever re-dispatches the mutation.
   - the last leg not confirming → `APPLY_UNCERTAIN`, the slot **not** released, which the tool
     republishes as `TOOL_UNCERTAIN` and the runtime stops the run for.
   - a confirming leg → `{ok:true, data:{sent:true, effectVerified:true}}`.
4. **Why a ladder, and why it stops at two legs.** The first fix used `GetSelectedText` alone; measured
   natively on R7-Office 2026.3.1 it answers `""` (immediately and after +400 ms) because the paste does
   **not** leave the inserted text selected, so every insert settled uncertain and the run always
   stopped. `GetCurrentSentence` answers with exactly the inserted sentence (or `""` when the payload
   ends with a sentence terminator). Leg 1 is kept first because it is the primitive that can confirm on
   another build. A third leg over the whole-document `GetFileHTML` is **deliberately absent**: an
   `includes(payload)` containment test over the entire exported document is also satisfied by a payload
   that was already in the document, so it would report `effectVerified:true` for an effect that never
   happened — a false success is worse than the false failure this repair removes. Making it honest
   needs a pre-dispatch baseline count, i.e. a second read shape before the mutation, which is outside
   this repair.
5. **No automatic retry.** Exactly one `PasteText` dispatch; the bridge never re-dispatches a mutation.
6. **R1 survives.** A handler that returns OR throws the uncertain envelope still yields
   `TOOL_UNCERTAIN` and stops the run; the earlier tests are unchanged in strength.
7. **Boolean acknowledgements are untouched**: `true`/`false` still yield
   `{ok:true, data:{sent:<boolean>}}`, read nothing, and mean **sent, effect unverified**.
8. **Every other non-boolean value** (`null`, a string, an object, a number) takes the SAME void path —
   the ladder, or the uncertain class. A malformed value is never itself a success claim: when it
   becomes one, the envelope says `effectVerified` because a leg proved it.

`GetSelectedText` and `GetCurrentSentence` are the public read primitives measured on the live build; a
build whose `PasteText` does return a value goes through exactly the same door (the code is
contract-driven, not fitted to one build).

## Open — target-build check (NOT claimed here)

- The **target Astra / R7 2026.1.2.1942 build was not exercised**. What a boolean `PasteText`
  acknowledgement means there, and whether `GetSelectedText`/`GetCurrentSentence` reproduce a pasted
  payload there, is **unverified**. A build where no leg reproduces the payload degrades to
  `APPLY_UNCERTAIN` (the run stops fail-safe); it can never produce a success claim.
- The **`GetCurrentSentence` miss for a payload ending with a sentence terminator** is a measured limit
  of the ladder: that payload ends with legs 1 and 2 unconfirmed, so it still settles
  `APPLY_UNCERTAIN`. Closing it honestly needs a document-delta read (a pre-dispatch baseline), which is
  not part of this repair.
- The ladder was **not** measured natively. This document claims host-side tests only: the focused
  bridge/handler/integration suites, the full `node --test` suite, the static audit and the bundle
  build, all run on the final tree.
