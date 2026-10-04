# Sprint 3 progress — the void `PasteText` acknowledgement and the new insert contract

Short record of Sprint 3's first item: the native defect proven in
[the Sprint 2 stage-b smoke findings](<../.superpowers/sdd/2026-10-04-sprint-2-agent-runtime/native-smoke-findings.md>),
and of the two independent review rounds that followed it. The first repair added a pre-dispatch
baseline to an ordered ladder of caret-scope exact-equality reads; the second review showed that rule
was **still fail-open** (a concurrent non-paste change landing on the payload satisfied it), so the
confirmation is now a **document delta** measured on the document's own HTML export.

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
3. **The confirmation is a DOCUMENT DELTA, measured on the document's own HTML export.** The ticket
   stays owned (the mutation is still a pending mutation, design §8.4, so the write lock is held for
   the whole dispatch-plus-confirmation window). The bridge:
   - reads the document HTML **once BEFORE the paste** with
     `plugin.executeMethod('GetFileHTML', {}, callback)` — the same public method channel every other
     read uses — and counts the occurrences of the dispatched payload in it. That count is the
     **baseline**, and it is pre-paste **by construction**: the paste is dispatched only from that
     read's own callback, so no assumption about native callback ordering is involved;
   - dispatches `PasteText` **exactly once**, with exactly the payload this path carried before;
   - reads the document HTML **once AFTER the paste** and counts again;
   - reports `{ok:true, data:{sent:true, effectVerified:true}}` **only** when the post count is exactly
     `baselineCount + 1` — exactly one NEW occurrence is the evidence that THIS paste added the payload.
4. **The counting form is ONE documented string: the minimally HTML-escaped dispatched payload.**
   The document HTML escapes at least `&`, `<`, `>` and `"`, and the payload may contain Cyrillic,
   quotes, angle brackets or ampersands, so the rule is stated exactly: `&` → `&amp;`, `<` → `&lt;`,
   `>` → `&gt;`, `"` → `&quot;`, with `&` replaced **first** so an escape introduced by a later step is
   never escaped a second time. The SAME form is counted before and after, so the delta compares like
   with like; a document that renders the payload RAW is **not** a match (the raw form is a different
   string, and accepting either form would make the count depend on which one the editor emits). The
   count is non-overlapping, and an empty counting form is refused before any read.
5. **Every other outcome is "not confirmed".** No new occurrence, two or more new occurrences, a
   payload that is simply absent, a missing/malformed/non-string answer, a read that threw, a post read
   above the byte ceiling, an observation delivered past the ticket deadline — all of them settle
   `APPLY_UNCERTAIN`: the **uncertain** class, the slot **held**, **no retry** of the read and no retry
   of the mutation, which the tool republishes as `TOOL_UNCERTAIN` and the runtime stops the run for.
6. **The pre-dispatch read is a GATE (fail-closed).** A baseline that throws, errors, is malformed, is
   above the ceiling, or **never answers** leaves the ticket with no obtainable evidence, so the paste
   is **not dispatched at all**: the ticket settles its own **known** class (`TIMEOUT` on the deadline,
   `CANCELLED` on an abort or `dispose`, otherwise the closed class of the failure the read produced)
   and **RELEASES the slot**. Reporting `APPLY_UNCERTAIN` there would be a false uncertainty about a
   mutation that never happened, and holding the slot would wedge the bridge behind a settled ticket.
   Consequence, stated plainly: **an editor that does not implement `GetFileHTML` gets no insert** — a
   refusal, never a success and never a write nobody can check.
7. **Why a document delta and not a caret-scope equality (the second review's D-A finding).** A
   post-dispatch observation that reproduces the payload proves only that the caret scope **EQUALS**
   the payload, and "equals the payload and differs from its own pre-dispatch baseline" is **still not
   attribution**: a concurrent NON-paste change — the user typing, autocorrect, a native that moves the
   caret — that lands exactly on the payload satisfies both conditions while nothing was inserted, and
   the bridge reported `{sent:true, effectVerified:true}` for an insert that never happened. Only a
   change to the **DOCUMENT** is attributable to a paste that is the sole writer of that document in
   this window, and "exactly one new occurrence" is the narrowest honest form of that evidence. The
   reviewer's reproduction is now a test: a fake `PasteText` that mutates nothing while the caret scope
   moves onto the payload must settle the uncertain class.
8. **The caret-scope legs are GONE.** `GetSelectedText` and `GetCurrentSentence` no longer participate
   in the insert confirmation — they can no longer produce `effectVerified:true`, and a read that
   cannot settle success has no business costing a native round trip inside the write window. They
   remain the primitives of the ordinary context capture (`readSelection`), which is unchanged.
   Tests assert that the insert path dispatches neither of them, on the bridge, handler and
   controller levels.
9. **No automatic retry.** Exactly one `PasteText` dispatch and at most **two** `GetFileHTML` reads per
   logical insert (one baseline + at most one confirmation); a boolean acknowledgement dispatches one
   read and no confirmation read at all.
10. **R1 survives.** A handler that returns OR throws the uncertain envelope still yields
    `TOOL_UNCERTAIN` and stops the run; the earlier tests are unchanged in strength.
11. **Boolean acknowledgements are untouched in shape**: `true`/`false` still yield
    `{ok:true, data:{sent:<boolean>}}`, read nothing **after** the mutation, and mean **sent, effect
    unverified**. The gate read still runs before the mutation, because the acknowledgement value is
    not known until then.
12. **Every other non-boolean value** (`null`, a string, an object, a number) takes the SAME
    document-delta path. A malformed value is never itself a success claim: when the envelope becomes
    one, it says `effectVerified` because the document itself gained exactly one new occurrence.

## 4a. One logical insert dispatches the paste exactly once (first independent-review repair)

An independent review reproduced a **second `PasteText` for one logical insert**: a read's
`plugin.executeMethod` delivered its callback **synchronously and then threw**. The `catch` re-entered
the same step, its baseline was dispatched twice, both answers each advanced toward the mutation, and
the mutation was dispatched twice — a violation of design §8.4 ("no mutation while one is unsettled")
and of the owner's "no automatic retry of the mutation". Measured host-side: 2 baseline reads →
2 `PasteText` dispatches → `{sent:true,effectVerified:true}`.

The repair is **structural**, never an assumption about native callback ordering, and it is unchanged
by the move to one document read:

- `owned.htmlBaselineDispatched` is set before the baseline read goes out and checked on entry, so the
  baseline is dispatched **once per ticket** even when the callback already ran and the dispatch then
  threw. (It carries the property the old `owned.legDispatched` marks carried, now that there is one
  baseline read instead of one per leg.)
- A local `answered` flag makes the baseline observation **judged once**, so a duplicate callback
  cannot open the gate a second time.
- `dispatchPaste` checks `owned.dispatched` on entry and sets it before the irreversible call, so the
  paste is dispatched **once per ticket**: `dispatchPaste` is idempotent and no callback, duplicate
  answer or re-entrant `catch` can reach the mutation twice.
- `owned.htmlConfirmDispatched` does the same for the post-paste read, and `confirmInsert`'s
  `answered` flag judges its observation once.
- The RED reproductions (one baseline per ticket, one `PasteText`; a duplicate baseline answer
  dispatching nothing) are tests.

## 4b. An insert that dispatched NOTHING is a KNOWN outcome and releases the slot

A baseline that never answers used to settle the ticket `APPLY_UNCERTAIN` while **nothing had been
dispatched** — a false uncertainty about a mutation that never happened — and, worse, the slot stayed
held forever: `getState()` reported `busy:true` with `writePending:false`, and `dispose()` could not
free it because the ticket was already settled, so `slot?.cancel()` early-returned. The panel reported
an unlocked state while the bridge refused every later operation.

The rule follows the `owned.dispatched` distinction the write/insert classes already used:

- **Nothing dispatched** (a pre-dispatch baseline that never answered, was unreadable, or an abort that
  lands before the paste): the ticket settles its own **known** class (`TIMEOUT` on the deadline,
  `CANCELLED` on an abort or `dispose`, the closed read class otherwise) and **releases the slot**, so
  a later operation proceeds. `pendingMutation` stays false and the panel's write lock is not held.
- **Paste dispatched** (the control leg): behaviour is unchanged — `APPLY_UNCERTAIN`, the slot held, no
  retry, released only by the mutation's own matching native callback.
- The same release applies to any undispatched ticket (a read/probe whose dispatch was never reached);
  a dispatched read/probe keeps the existing uncertain-until-callback behaviour.

## 4c. The target build's dispatch API (`executeCommand` vs `callCommand`)

Measured on the target (Astra Linux + R7-Office 2026.1.2.1942): the plugin facade exposes
`executeCommand`, `executeMethod` **and** `callCommand` (an earlier "callCommand absent" reading came
from a truncated key listing and was corrected by direct instrumentation); on Windows R7-Office
2026.3.1 both exist as well.

The rule in force, stated exactly:

- `executeMethod` is the **METHOD** channel (`{type:'method', methodName, data}`). It is what the
  insert's irreversible `PasteText` dispatch and the document-HTML reads need, on **both** builds, and
  its use is unchanged.
- `callCommand` and `executeCommand` are the **COMMAND** channel, and they are **not interchangeable in
  general**. `callCommand` wraps an author-written function body into the command message; the installed
  2026.1.2 vendor SDK composes exactly that one out of `executeCommand`. The bridge therefore prefers
  `callCommand` whenever the facade exposes it — the measured-working Windows path, which keeps
  receiving the same inline static body and the same `false, false` arguments — and falls back to
  `executeCommand` only when `callCommand` is absent.
- On the fallback the composed command source is built from the SAME authored body (`String(body)` of a
  static function literal, the statement form the vendor wrapper produces) and the static audit passes.
- `adapter.commandDispatch` is true when **either** command entry point is an own function;
  `adapter.commandMethod` records which one carried the work. A build exposing **neither** still refuses
  honestly with `CAPABILITY_UNAVAILABLE` before any native dispatch (the read path and the insert's own
  gate both refuse, the slot is released, and no write is dispatched).

**Unverified, and stated as such:** the `executeCommand` fallback's framing is inferred from the
installed 2026.1.2 vendor SDK (where `callCommand` is exactly `executeCommand('command', composedSource,
callback)`); if a target native rejects it, the command leg never answers, the presence probe settles
`TIMEOUT` and the insert refuses — the same honest refusal as before, never a false success and never a
wrong write.

## Accepted consequences of the document delta (conservative direction, never a false success)

- **The pre-dispatch read gates the write.** An editor whose `GetFileHTML` is missing, errors, or never
  answers gets **no insert at all**: the ticket settles a known refusal and releases the slot. That is
  deliberate — an insert nobody can check is not worth dispatching — and it is the one behaviour change
  of this repair that can remove a working insert, so it is stated as such.
- **A byte ceiling bounds the read.** `LIMITS.documentHtmlBytes` (256 KiB, in `src/shared/limits.js`
  alongside the other ceilings) is larger than `editorResultBytes` because it bounds a WHOLE-DOCUMENT
  export rather than a scoped read; the 64 KiB scoped window would refuse the export of any non-trivial
  document. A result above the ceiling is **not** truncated and counted in a prefix: the read is
  unusable, which (before the paste) refuses the insert and (after it) settles `APPLY_UNCERTAIN`.
- **The counted needle is the DISPATCHED payload, newline included.** For `position:'end'` the payload is
  `text + "\n"`, and one trailing newline is NOT normalized away any more: the old sentence leg removed
  it because a sentence read cannot contain a paragraph break, but a document export is a different
  observation, and counting a prefix of the dispatched payload is exactly the kind of approximation this
  repair removes. An export that renders the paragraph break as markup rather than a literal newline
  therefore leaves an `end` insert **uncertain** (fail-closed).
- **A genuinely applied insert whose export does not show exactly one new occurrence settles
  `APPLY_UNCERTAIN` instead of verified.** This is intended: the cost of a false UNCERTAIN (the run
  stops and the user re-checks) is recoverable; publishing an insert that never happened is not.
- **A concurrent edit of a DIFFERENT region is invisible to the count** — that is the point — but a
  concurrent edit that adds the SAME payload once is indistinguishable from this paste. No client-side
  rule can attribute a write from the outside; the delta is the narrowest honest evidence available
  through the public read, and it is strictly stronger than the caret-scope equality it replaces.

## Open — target-build check (NOT claimed here)

- The **target Astra / R7 2026.1.2.1942 build was not exercised** for this repair. What a boolean
  `PasteText` acknowledgement means there, whether `GetFileHTML` answers at all, what its HTML export
  looks like (in particular how `&`, `<`, `>` and `"` are escaped, and how a paragraph break from an
  `end` payload is rendered), and how large a real document's export is against the 256 KiB ceiling are
  all **unmeasured**. A build where the export cannot be read refuses the insert (known class, slot
  released); a build where the delta is not exactly one settles `APPLY_UNCERTAIN`. Neither can ever
  produce a success claim.
- The **escaping rule is the documented minimum** (`&`, `<`, `>`, `"`). If a live export escapes more
  (for example `'` as `&#39;`, or non-ASCII as numeric entities, or a Cyrillic character as an entity),
  the counting form will not match what the document contains and the insert settles `APPLY_UNCERTAIN`
  — fail-closed. The fix in that case is to widen the DOCUMENTED escape set and its tests, never to
  fall back to a containment test.
- The document delta and the ceiling were **not** measured natively. This document claims host-side
  tests only: the focused bridge/dispatch-API/handler/integration suites, the full `node --test` suite
  (**651/651** on the final tree, up from 649), the static audit and the bundle build, all run on the
  final tree.
- The **`executeCommand` fallback framing is unverified natively** (§4c). It is inferred from the
  installed 2026.1.2 vendor SDK, where `callCommand` is exactly `executeCommand('command', composed,
  callback)`. A native that rejects the composed source leaves the command leg unanswered: the presence
  probe settles `TIMEOUT` and the insert refuses — the same honest refusal as before, never a false
  success and never a wrong write. The Windows path (`callCommand` present) is unchanged and keeps
  receiving the same inline static body and the same `false, false` arguments.
