# Sprint 3 progress — the void `PasteText` acknowledgement and the new insert contract

Short record of Sprint 3's first item: the native defect proven in
[the Sprint 2 stage-b smoke findings](<../.superpowers/sdd/2026-10-04-sprint-2-agent-runtime/native-smoke-findings.md>),
and of the independent review round that followed it: the ordered exact-equality ladder it introduced
was still fail-open, because a post-dispatch read equal to the payload does not prove the paste applied
it. The ladder now requires a pre-dispatch baseline for every leg (see §3/§4 below).

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
3. **Preferred path: a PRE-DISPATCH BASELINE plus an ordered confirmation LADDER of independent
   bounded reads.** The ticket stays owned (the mutation is still a pending mutation, design §8.4, so
   the write lock is held for the whole dispatch-plus-confirmation window). Before the irreversible
   paste, the bridge dispatches **one baseline read per leg** — the SAME public observation that leg
   will later judge — and only then dispatches `PasteText`, exactly once. The effect is verified only
   when a leg's post-dispatch observation reproduces the dispatched payload through that leg's own
   exact rule **AND differs from that leg's baseline**:
   - **Leg 1 — `GetSelectedText`**: byte-equality against the dispatched payload.
   - **Leg 2 — `GetCurrentSentence`**: equality against the dispatched payload with exactly **one**
     trailing `"\n"` removed (the `position:'end'` payload is `text + "\n"`, and a sentence read cannot
     contain a paragraph break). Nothing else is normalized — no other whitespace is trimmed, no case
     is folded, no prefix/suffix or fuzzy matching is accepted.
   - **Baseline and confirmation share one budget rule**: the dispatched payload's own UTF-8 byte
     length, capped by `LIMITS.editorResultBytes`. Neither read can widen the window beyond the bytes
     it is checking for, and the same `assertByteLimit` refusal applies to both.
   - every other observation — a different string, `""`, a value that merely EQUALS the baseline, a
     malformed or byte-oversized value, a read error, an observation delivered past the ticket
     deadline, a leg whose dispatch threw — is **not confirmed** and hands the ticket to the next leg.
     No leg ever re-dispatches the mutation.
   - **A baseline read that throws, errors, times out, is malformed or is oversized makes ITS leg
     incapable of confirming** — never a confirmation by default. Such a leg is not even asked for a
     post-dispatch read, and the ladder moves to the next capable leg.
   - the last capable leg not confirming → `APPLY_UNCERTAIN`, the slot **not** released, which the tool
     republishes as `TOOL_UNCERTAIN` and the runtime stops the run for.
   - a confirming leg → `{ok:true, data:{sent:true, effectVerified:true}}`.
4. **Why the baseline is required (the fail-open leg an independent review reproduced).** Equality
   between a post-dispatch read and the payload proves only that **the caret scope equals the payload**,
   not that `PasteText` put it there. On a build whose `PasteText` calls back `undefined` and mutates
   nothing — its semantics on the target Astra/R7 2026.1.2.1942 remain **unmeasured** — a scope that
   ALREADY held the payload satisfied the old rule and produced
   `{sent:true, effectVerified:true}` for an insert that never happened. That is the mirror image of
   the false failure this repair exists to remove. The reviewer's reproduction is now a test: a fake
   `PasteText` that mutates nothing, over a caret sentence already equal to the payload, must settle
   the uncertain class.
   - **A no-op `PasteText` now fails every leg**, which is exactly the point.
   - The baseline phase is **gated**: the paste is dispatched only after every baseline leg has
     answered or failed, so a baseline observation is pre-paste **by construction** and never by an
     assumption about the editor's callback ordering — the same reason `PasteText` itself is not
     trusted. Consequence: the ticket's single `callbackTimeoutMs` window now also covers the baseline
     reads, and a baseline that never answers settles the ticket **before** anything is dispatched.
     That settlement is a **KNOWN** outcome, not a false uncertainty, and it **releases the slot** —
     see §4a.
5. **Why a ladder, and why it stops at two legs.** The first fix used `GetSelectedText` alone; measured
   natively on R7-Office 2026.3.1 it answers `""` (immediately and after +400 ms) because the paste does
   **not** leave the inserted text selected, so every insert settled uncertain and the run always
   stopped. `GetCurrentSentence` answers with exactly the inserted sentence (or `""` when the payload
   ends with a sentence terminator). Leg 1 is kept first because it is the primitive that can confirm on
   another build. A third leg over the whole-document `GetFileHTML` is **deliberately absent**: an
   `includes(payload)` containment test over the entire exported document is also satisfied by a payload
   that was already in the document, so it would report `effectVerified:true` for an effect that never
   happened — a false success is worse than the false failure this repair removes. The baseline now
   makes such a leg POSSIBLE to build honestly (a containment count before and after), but a count is
   not the exact-equality rule this ladder is built on, and the leg stays outside this repair.
6. **No automatic retry.** Exactly one `PasteText` dispatch; the bridge never re-dispatches a mutation.
7. **R1 survives.** A handler that returns OR throws the uncertain envelope still yields
   `TOOL_UNCERTAIN` and stops the run; the earlier tests are unchanged in strength.
8. **Boolean acknowledgements are untouched**: `true`/`false` still yield
   `{ok:true, data:{sent:<boolean>}}`, read nothing **after** the mutation, and mean **sent, effect
   unverified**. Their baselines are still read before the mutation, because at that moment the
   acknowledgement value is not yet known.
9. **Every other non-boolean value** (`null`, a string, an object, a number) takes the SAME void path —
   the ladder, or the uncertain class. A malformed value is never itself a success claim: when it
   becomes one, the envelope says `effectVerified` because a leg proved it.

`GetSelectedText` and `GetCurrentSentence` are the public read primitives measured on the live build; a
build whose `PasteText` does return a value goes through exactly the same door (the code is
contract-driven, not fitted to one build).

## 4a. One logical insert dispatches the paste exactly once (independent-review repair)

An independent review reproduced a **second `PasteText` for one logical insert**: a leg's baseline
`plugin.executeMethod` delivered its callback **synchronously and then threw**. The `catch` re-entered
the SAME leg, its baseline was dispatched twice, both answers each advanced the ladder, and the
mutation was dispatched twice — a violation of design §8.4 ("no mutation while one is unsettled") and
of the owner's "no automatic retry of the mutation". Measured host-side: 2 `GetCurrentSentence`
baselines → 2 `PasteText` dispatches → `{sent:true,effectVerified:true}`.

The repair is **structural**, never an assumption about native callback ordering:

- `owned.legDispatched[index]` is set before a leg's baseline is dispatched and checked on entry, so a
  baseline is dispatched **once per leg** even when the callback already ran and the dispatch then threw.
- `dispatchPaste` checks `owned.dispatched` on entry and sets it before the irreversible call, so the
  paste is dispatched **once per ticket**: `dispatchPaste` is idempotent and no ladder leg, duplicate
  callback or re-entrant `catch` can reach the mutation twice.
- The RED reproduction (one baseline per leg, one `PasteText`) is a test, and it failed before the
  change with `GetCurrentSentence: 2` and `PasteText: 2`.

## 4b. An insert that dispatched NOTHING is a KNOWN outcome and releases the slot

A baseline that never answers used to settle the ticket `APPLY_UNCERTAIN` while **nothing had been
dispatched** — a false uncertainty about a mutation that never happened — and, worse, the slot stayed
held forever: `getState()` reported `busy:true` with `writePending:false`, and `dispose()` could not
free it because the ticket was already settled, so `slot?.cancel()` early-returned. The panel reported
an unlocked state while the bridge refused every later operation.

The rule now follows the `owned.dispatched` distinction the write/insert classes already used:

- **Nothing dispatched** (a pre-dispatch baseline that never answered, or an abort that lands before
  the paste): the ticket settles its own **known** class (`TIMEOUT` on the deadline, `CANCELLED` on an
  abort or `dispose`) and **releases the slot**, so a later operation proceeds. `pendingMutation` stays
  false and the panel's write lock is not held.
- **Paste dispatched** (the control leg): behaviour is unchanged — `APPLY_UNCERTAIN`, the slot held, no
  retry, released only by the mutation's own matching native callback.
- The same release now applies to any undispatched ticket (a read/probe whose dispatch was never
  reached); a dispatched read/probe keeps the existing uncertain-until-callback behaviour.

## 4c. The target build's dispatch API (`executeCommand` vs `callCommand`)

Measured on the exact target (Astra Linux + R7-Office 2026.1.2.1942): the plugin facade exposes
`executeCommand` and `executeMethod` but **not** `callCommand`; on Windows R7-Office 2026.3.1 both
exist. `adapter.commandDispatch` resolved only `callCommand`, so on the target the runtime was never
verified, the panel fell back to the legacy flow, and every run ended in the authored
`CAPABILITY_UNAVAILABLE` caption without dispatching a write.

The rule now in force, stated exactly:

- `executeMethod` is the **METHOD** channel (`{type:'method', methodName, data}`). It is what the
  insert's irreversible `PasteText` dispatch needs, on **both** builds, and its use is unchanged.
- `callCommand` and `executeCommand` are the **COMMAND** channel, and they are **not interchangeable in
  general**. `callCommand` wraps an author-written function body into the command message; the installed
  2026.1.2 vendor SDK composes exactly that one out of `executeCommand`. The bridge therefore prefers
  `callCommand` whenever the facade exposes it — the measured-working Windows path, which now keeps
  receiving the same inline static body and the same `false, false` arguments — and falls back to
  `executeCommand` only when `callCommand` is absent.
- On the fallback the composed command source is built from the SAME authored body
  (`String(body)` of a static function literal, the statement form the vendor wrapper produces) and a
  static audit still passes.
- `adapter.commandDispatch` is true when **either** command entry point is an own function;
  `adapter.commandMethod` records which one carried the work. A build exposing **neither** still refuses
  honestly with `CAPABILITY_UNAVAILABLE` before any native dispatch (the read path and the insert's own
  gate both refuse, the slot is released, and no write is dispatched).

**Unverified, and stated as such:** the `executeCommand` fallback's framing is inferred from the
installed 2026.1.2 vendor SDK (where `callCommand` is exactly `executeCommand('command', composedSource,
callback)`); it was **not** run natively. If a target native rejects it, the command leg never answers,
the presence probe settles `TIMEOUT` and the insert refuses — the same honest refusal as before, never
a false success and never a wrong write.

## Accepted consequences of the baseline (conservative direction, never a false success)
- **A genuinely applied insert whose baseline already equalled the payload now settles
  `APPLY_UNCERTAIN` instead of verified.** This is intended. An observation that did not CHANGE cannot
  be distinguished from a paste that did nothing, and the whole point of this repair is that "the scope
  shows the payload" is not evidence that the paste put it there. The cost is a false UNCERTAIN (the
  run stops and the user re-checks) in exchange for the impossibility of a false VERIFIED. Losing a
  real success is recoverable; publishing an insert that never happened is not.
- **A leg's baseline is bounded by the payload's own byte length**, so a baseline observation LONGER
  than the payload is refused as oversized and leaves that leg incapable (the mutation is still
  dispatched). A payload inside a longer pre-existing sentence therefore cannot be confirmed by that
  leg. This is the budget rule the confirmation reads use, applied symmetrically, and it is pinned by
  tests; weakening it in one direction only (a wider baseline window) would let a leg compare a
  truncated baseline against a full payload.
- **The baseline phase gates the mutation.** The paste is dispatched only after every baseline leg has
  answered or failed, so an editor that never answers a baseline read gets no insert at all: the ticket
  settles the known `TIMEOUT` class with nothing dispatched, and (since §4b) releases the slot instead of
  wedging the bridge. That is deliberate. Awaiting the read is what makes the baseline genuinely
  pre-paste rather than relying on an unmeasured ordering guarantee between a queued read and the paste;
  a guessed ordering could cost the confirmation exactly where it is needed (the target build) and would
  reintroduce the false-failure shape this repair removes. The cost is bounded: every baseline that
  throws, errors, is malformed or is oversized still lets the mutation through exactly once.

## Open — target-build check (NOT claimed here)

- The **target Astra / R7 2026.1.2.1942 build was not exercised**. What a boolean `PasteText`
  acknowledgement means there, whether `GetSelectedText`/`GetCurrentSentence` answer at all, and what
  they answer BEFORE a paste, is **unverified**. A build where no leg both reproduces the payload and
  differs from its own baseline degrades to `APPLY_UNCERTAIN` (the run stops fail-safe); it can never
  produce a success claim.
- The **`GetCurrentSentence` miss for a payload ending with a sentence terminator** is a measured limit
  of the ladder: that payload ends with legs 1 and 2 unconfirmed, so it still settles
  `APPLY_UNCERTAIN`. Closing it honestly needs a document-delta read, which is not part of this repair.
- The **baseline's own live behaviour is unmeasured**. On the measured 2026.3.1 build the caret-scope
  read after a paste returns the inserted sentence, but nothing here measured what the same read
  returns BEFORE the paste, and the baseline's byte budget can refuse a long pre-existing sentence.
  Either case only ever removes a confirmation; it never creates one.
- The ladder and its baselines were **not** measured natively. This document claims host-side tests
  only: the focused bridge/dispatch-API/handler/integration suites, the full `node --test` suite
  (649/649 on the final tree, up from 633: six D-B/D-C tests in `tests/unit/bridge.test.js` and ten
  dispatch-API tests in `tests/unit/bridge-dispatch-api.test.js`), the static audit and the bundle
  build, all run on the final tree.
- The **`executeCommand` fallback framing is unverified natively** (§4c). It is inferred from the
  installed 2026.1.2 vendor SDK, where `callCommand` is exactly `executeCommand('command', composed,
  callback)`. A native that rejects the composed source leaves the command leg unanswered: the presence
  probe settles `TIMEOUT` and the insert refuses — the same honest refusal as before, never a false
  success and never a wrong write. The Windows path (`callCommand` present) is unchanged and keeps
  receiving the same inline static body and the same `false, false` arguments.

