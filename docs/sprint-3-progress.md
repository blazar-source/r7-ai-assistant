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
4. **The counting form is the dispatched payload counted in the document's DECODED TEXT.** The export
   is parsed with `DOMParser` (`new DOMParser().parseFromString(html, 'text/html')`, the reference handed
   to the bridge through the injected `platform` object) and the text nodes are collected with a
   **three-way separator** after every element boundary — **one `"\n"`** after a known block element
   (`BLOCK_TAGS`), **nothing** after a known inline element (`INLINE_TAGS`), and the
   `SEPARATOR_SENTINEL` (`"\u0000"`) after an element in neither list — so **markup and attribute values
   never enter the count**, a paragraph break is a real separator, an unknown element can never
   **complete** the `end` form's needle, and text inside the RAWTEXT elements (`style`, `script`,
   `title`, `textarea`, `noscript`, `iframe`, `noembed`, `noframes`) is never counted at all. The needle
   is the **exact dispatched payload** — `text` for `position:'cursor'`, `text + "\n"` for
   `position:'end'` — and no escaping is applied anywhere: once the markup is parsed away, a payload
   holding `&`, `<`, `>`, `"` or Cyrillic matches by its real characters, and the raw and entity
   spellings of the same character are the same evidence. The count is non-overlapping, an empty needle
   is refused before any read, and a payload holding the sentinel is refused before any dispatch. (The
   earlier **minimally HTML-escaped** counting form is **retired** — see §5: it was fail-open. §6
   replaces the block white list this rule first used with an inline blacklist, and **§7 retracts §6's
   claim that an unknown element can only cause a false UNCERTAIN**: it can complete the `end` needle,
   so the unknown case now gets a sentinel instead of a newline.)
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
- The **decoded-text rule removes the escaping question** (§5). What is still unmeasured is the element
  vocabulary a live export uses. **§6 inverted this question's failure direction:** the separator now goes
  after every element boundary except the named inline set, so an unknown element SPLITS text rather than
  joining it — a payload spanning it settles UNCERTAIN instead of matching, and the white-list question
  ("is every real block named?") is replaced by the safe one ("is every real INLINE element named?"),
  whose cost is a false UNCERTAIN, never a false success.
- The document delta and the ceiling were **not** measured natively. This document claims host-side
  tests only: the focused bridge/dispatch-API/handler/integration suites, the full `node --test` suite
  (**651/651** on that tree, up from 649; **661/661** after §6), the static audit and the bundle build,
  all run on the final tree.
- The **`executeCommand` fallback framing is unverified natively** (§4c). It is inferred from the
  installed 2026.1.2 vendor SDK, where `callCommand` is exactly `executeCommand('command', composed,
  callback)`. A native that rejects the composed source leaves the command leg unanswered: the presence
  probe settles `TIMEOUT` and the insert refuses — the same honest refusal as before, never a false
  success and never a wrong write. The Windows path (`callCommand` present) is unchanged and keeps
  receiving the same inline static body and the same `false, false` arguments.

## Regression repair — the `callCommand` body must be self-contained (measured natively, 2026.3.1)

**What broke, and how it was found.** A real insert run on the live Windows R7-Office 2026.3.1 died
**before the model was ever called**. The editor's own console showed

```
ReferenceError: contextBody is not defined
    at eval (eval at <anonymous> (… editors/sdkjs/word/sdk-all-min.js …))
```

and the run's network capture was empty — the failure is local to the editor bridge, not the model call.

**Cause.** `callCommand` does not *call* the function it is handed: it **stringifies** it and evaluates
the text inside the editor, where none of `bridge.js`'s module bindings exist. Commit `273d70e` made the
bridge carry its own static bodies and then passed **closures over those bodies**:

```js
plugin.callCommand(() => contextBody(), false, false, callback)      // and () => capabilityBody()
```

The arrow closes over a module-scope `const`, so the stringified text referenced an identifier the
editor's evaluator has never heard of. The call shape was right; the *value* was unevaluable.

**Why every gate was green.** The unit rigs invoked the carried body **in this module's own scope**, so
`contextBody` resolved; and `tests/integration/package.test.js` asserted the body was an inline arrow
whose only statement was a **forward to one of those names** — the regression itself was pinned as
expected behaviour. A call-SHAPE assertion is not an evaluability assertion.

**Repair.** Each command leg now passes a full **inline function literal** carrying its own authored
statements — the same shape the reviewed `commands.js` probes passed on the measured build — and the
`(fn, false, false, callback)` argument list, the `callCommand`-preferred dispatch rule and the
`CAPABILITY_UNAVAILABLE`-before-any-dispatch refusal are untouched. The two module-level literals remain
**only** as the source the `executeCommand` fallback composes as text; naming either from inside a
`callCommand` body is now a tested failure. `String(...)` stays a data conversion of an authored literal,
so the authored static audit is unchanged (`Authored-code audit PASS`, exit 0).

**The test that would have caught it** (and now does) stringifies the value the bridge hands to
`callCommand` and evaluates it where no module binding of `bridge.js` exists: on the old shape that raises
exactly `ReferenceError: contextBody is not defined`; on the repaired shape both legs answer their
authored tuples. A second test does the same for the `executeCommand` fallback's composed source.

**Unverified natively:** the repaired shape was **not** re-run on the live 2026.3.1 editor in this
change; what is proven here is evaluability in a module-free scope (the class of failure the native
reported), host-side only. Final tree: `node --test` **653/653** (up from 651), the focused
bridge/dispatch-API/handler/integration suites green, `Authored-code audit PASS` (exit 0), and the bundle
build exit 0.

## 5. The count moves to DECODED TEXT, and the duplicate-acknowledgement guard gets its assertion

A third independent review found the document-delta rule from §4 still **fail-open**, but one layer
lower: the count ran over the export's **raw HTML source**, so **markup and entity vocabulary**
contributed occurrences that are not in the document's text.

**The reproduction (no file writes).** Payload `amp`; baseline export `<p>a &amp; b</p>`; the fake
`PasteText` inserts nothing while an unrelated change adds one more escaped ampersand → post export
`<p>a &amp; b</p><p>c &amp; d</p>`. The source holds **one** `amp` substring in the baseline (inside
`&amp;`) and **two** after the unrelated change — an exact delta of **one** — so the rule
`post === baseline + 1` fired and the insert was reported
`{"ok":true,"data":{"sent":true,"effectVerified":true}}` **although nothing was pasted**. The
non-adversarial trigger is ordinary: a user typing one `&` while a payload that collides with markup or
entity vocabulary (`amp`, `lt`, `gt`, `quot`, `style`, `span`, `p`, a bare Latin letter) is in flight.

**Repair (as landed then; superseded by §6).** The export is parsed with the platform's own container and
the text nodes are collected with explicit separators (a `BLOCK_TAGS` white list, one `"\n"` after each
named block-level element; inline elements add nothing, and a bare `<` that the platform reads as text is
text). The needle is the **exact
dispatched payload** and nothing else; the rule stays `post === baseline + 1`; a missing needle, a
different count, an unusable or oversized read, or a hung read still settle the **uncertain** class with
the slot held and no retry; the pre-dispatch read is still a fail-closed **gate** (unusable ⇒ no paste,
known class, slot released), and `LIMITS.documentHtmlBytes` still bounds the read and is still never
truncated. The platform DOM was made an **explicit option** of `createR7Bridge`, supplied by
`src/ui/entry.js` at the one place that already holds the page's own objects, so the
authored source touches no global. §6 replaces that option's shape (a `platform` object carrying both the
document and the `DOMParser`) and the separator rule itself.

**The escaping machinery is GONE** — `HTML_ESCAPES` / `escapedPayload` and the whole `&`-first escaping
rule are deleted. With the count over decoded text there is nothing left to escape, and a payload
containing `&`, `<`, `>` or `"` matches by its real characters; the raw and entity spellings of the same
character are now the same evidence rather than two different strings.

**Tests.** The reviewer's exact reproduction is RED on `25b4c6f` (it verified the no-op) and green after;
the new cases pin that an entity-decoded `&` payload really added is verified, that markup (a tag name, an
attribute value, a later block tag) never counts, that a payload spanning two paragraphs never matches,
that the `end` form's appended `"\n"` matches a real paragraph break, and that one logical insert still
dispatches one `PasteText` and at most two reads. The **`&`-first escaping test was removed and replaced
by the stronger decoded-text test** (it asserted the retired rule and its RED half asserted the exact
behaviour this change makes correct); `tests/fixtures/html-document.js` is the injected boundary, a small
parser whose block set is named independently of the implementation.

**D2 — the dropped guard assertion is restored.** An old test pinned that "a duplicate acknowledgement
for the same dispatch cannot preempt the confirmation read"; it was dropped in `6131312`, leaving
`if (owned.confirming) return;` with **no assertion at all**. The restored test sends
`insert.callback(undefined)` and then `insert.callback(true)` in flight and asserts exactly two reads,
`writePending === true` while the confirmation is in flight, and that the **VERIFIED** outcome can only
have come from the read's own `+1` delta — not from the duplicate. Verified **non-vacuous**: with the
guard line deleted the test fails ("the duplicate neither settles nor releases the ticket"), and with it
restored it passes.

**The `innerHTML` pin was dropped here, deliberately, for exactly that container parse; §6 restores it**
together with the other markup sinks, because the parse no longer needs any of them. Every other forbidden
string (dev/runtime markers, remote URLs, `window.parent`) stayed.

**Unverified natively:** the decoded-text rule has **not** been re-run on the live editor. What is proven
host-side is the counting rule, the gate, the ceiling and the guard; what only a native run can show is
the real `GetFileHTML` element vocabulary (whether the export renders a document paragraph with an element
outside the inline set — and therefore whether the separator rule splits it) and whether the extracted
text of a real export matches this model. §6 keeps that same open question and answers the white-list form
of it by construction.

## 6. The separator rule is inverted to an inline blacklist, rawtext is skipped, and the parse moves to `DOMParser`

A fourth independent review found **three fail-opens** in the decoded-text rule of §5 and one weakened
pin, all host-side reproducible through the real bridge.

**D-A — an unlisted block element concatenated its neighbours (medium, fail-open, demonstrated).** The
separator was inserted after elements in the hard-coded `BLOCK_TAGS` white list, so an export that
rendered blocks with an element **outside** that list concatenated their text. The reviewer drove the real
bridge with pre `<p>стар</p>`, post `<p>стар</p><center>01</center><center>23</center>` and
`insertParagraph({ text: '0123' })` over a **no-op paste** and got
`{"ok":true,"data":{"sent":true,"effectVerified":true}}` — the two `<center>` blocks concatenated into
`0123` across the boundary.

**Repair.** The principle is **inverted**: the separator is inserted after **every element boundary
except an explicitly listed inline set** (`INLINE_TAGS` in `src/plugin/bridge.js`: `a, abbr, b, bdi, bdo,
br, cite, code, data, dfn, em, i, kbd, mark, q, rp, rt, ruby, s, samp, small, span, strong, sub, sup,
time, u, var, wbr`). An **unknown element — or an unlisted element that is genuinely inline — gets an
EXTRA separator** instead of joining its neighbours. That is the deliberate trade: a false UNCERTAIN
stops the run for the user to re-check, a false VERIFIED publishes an insert that never happened.

**RETRACTED IN §7.** §6 stated that an unknown element "can only SPLIT text rather than join it — a
payload spanning it settles UNCERTAIN instead of matching", i.e. that **an unknown element can only cause
a false UNCERTAIN, never a false success**. **That sentence was FALSE** and §7 corrects it: the extra
separator §6 inserted was a `"\n"`, and for `position:'end'` the needle is `text + "\n"`, so an unlisted
**inline** element supplied exactly the newline that COMPLETED the needle and a no-op paste was reported
VERIFIED. The extra separator is now a sentinel that cannot complete a needle.

**D-B — rawtext was counted as document text (low-medium, fail-open, demonstrated).** `style`, `script`,
`title`, `textarea` and `noscript` content is markup-level content, not document text, but it entered the
count: post `<p>стар</p><style>delta</style>` with payload `delta` verified a no-op paste. There is now a
named `RAWTEXT_TAGS` skip set and those subtrees are **skipped whole** (no text and no separator of their
own), with a regression test per element.

**D-E — the parse is `DOMParser` again, and the dropped bundle pin is restored (low).** The parse used
`createElement('div')` + `innerHTML`, and `tests/integration/package.test.js` had dropped `innerHTML` from
its forbidden-strings list to allow it. A detached container is not fully inert — subresource loads and
`load`/`error` handlers remain possible, with only the page CSP in the way. The parse is now
`new DOMParser().parseFromString(html, 'text/html')` walking `documentElement`: a parsed document has **no
browsing context**, so no subresource is loaded and no handler can run. The `DOMParser` reference is read
off the **injected platform object** — the option was `platform: { document, DOMParser }`, supplied by
`src/ui/entry.js` and injected by tests (the fixture stands in for both); **§7 removes the `document`
member, which the bridge never read again**, leaving `platform: { DOMParser }` — and the pin is restored
with the same string plus `outerHTML`, `insertAdjacentHTML`, `createContextualFragment` and
`document.write(`, which now guard the whole string-into-markup sink family.

**The rationale for that injection was WRONG in §5 and is corrected here:** `scripts/static-audit.mjs`
does **not** require it. A member read such as `globalThis.document` passes the audit; only a bare
`globalThis` **VALUE** (aliasing it, or destructuring it) is reported as `DYNAMIC_EXECUTION`. The
injection is kept for the **explicit boundary and testability**, not because the audit forces it.

**D-C — record accuracy.** The `amp` reproduction's counts in the bridge comment and in §5 were wrong
(they read the source's `amp` substrings as including the literal text `a`). Measured: baseline **1**,
post **2**, delta **1**, which is why the old rule fired. Both records now say so.

**The weakened pin.** The `end`-needle case had lost discriminating power: `trimEnd()`ing the dispatched
payload would have gone unnoticed. The new test pins the pair over one baseline — the payload rendered
inside an inline element with trailing text (`<p><span>Абзац</span>хвост</p>`) makes
`position:'cursor'` VERIFY while `position:'end'` settles UNCERTAIN, because the dispatched newline is not
in the counted text. Measured while writing it: the reviewer's shorter export
`<p>стар</p><span>Абзац</span>` verifies for BOTH positions, because there the span's payload is closed by
the paragraph's own boundary newline; the discriminating shape needs the payload not to end its block.
Both are now pinned, so the measurement is recorded rather than assumed.

**Tests.** RED first, through the real bridge, on the tree of §5: the `<center>` no-op verified, the
`<style>` no-op verified, and the `end`/span case verified. All three are green after the change, and no
other test was weakened or deleted — the `html-document.js` fixture now exposes `INLINE_TAGS` (renamed
from `BLOCK_TAGS`), `RAWTEXT_TAGS`, `htmlPlatform()` and its own `DOMParser` instead of the
`createElement`/`innerHTML` container, so the fixture still names the rule's sets independently of the
implementation and a fallback to the retired container parse cannot pass. Final tree: `node --test`
**661/661**, the focused bridge/dispatch-API/word/integration suites green, `Authored-code audit PASS`
(exit 0) and the bundle build exit 0.

**Unverified natively:** as in §5, none of this ran on a live editor. What only a native run can show is
the real `GetFileHTML` element vocabulary — in particular whether an export renders a document block with
an element outside `INLINE_TAGS` (which would now split text that belongs together, a false UNCERTAIN) —
and whether a real document's extracted text matches this model. The programmatic injection is a real
page's own `DOMParser`; the fixture is not a browser.

## 7. The separator gets a third class, so it can never COMPLETE an `end` needle, and rawtext covers the whole class

A fifth independent review reproduced a **HIGH fail-open** through the real bridge, plus a narrow rawtext
gap and three low findings. All of it was host-side reproducible; none of it ran on a live editor.

**D-1 — an unknown element could COMPLETE the `end` needle (HIGH, fail-open, reproduced).** §6's stated
invariant — "an unknown element can only cause a false UNCERTAIN, never a false success" — was **FALSE**.
The `end` form's needle is `text + "\n"` (the exact dispatched payload), and the extraction inserted a
`"\n"` after every boundary that was not named inline, so a genuinely inline element missing from
`INLINE_TAGS` supplied exactly the newline that completed the needle. R7 emits `<img>` for an inline
picture and `<ins>`/`<del>` for tracked changes, so this was realistic, not theoretical. Reproduced (real
bridge, exit 0), no-op paste:

| post export | payload | measured then | measured now |
| --- | --- | --- | --- |
| `<p>start</p><p><label>delta</label>tail</p>` | `delta`, `position:'end'` | `effectVerified:true` | `APPLY_UNCERTAIN` |
| `<p>start</p><p>delta<img src="a"></p>` | `delta`, `position:'end'` | `effectVerified:true` | `APPLY_UNCERTAIN` |
| `<p>start</p><p><ins>delta</ins>tail</p>` | `delta`, `position:'end'` | `effectVerified:true` | `APPLY_UNCERTAIN` |

**Repair — the separator classifies THREE ways** (the rule and its record are in `src/plugin/bridge.js`):
1. a **known block** element (`BLOCK_TAGS`: `html`, `body`, `head`, `p`, `div`, `li`, the table cells,
   `h1`–`h6`, `pre`, the section containers, `hr`, …) → exactly one `"\n"`, the only thing that may
   complete the `end` form's needle;
2. a **known inline** element (`INLINE_TAGS`, unchanged) → **nothing**;
3. **neither** → `SEPARATOR_SENTINEL = "\u0000"`, never a newline.

The sentinel is safe **by construction**, not by hope: the needle IS the dispatched payload, and
`insertParagraph` now **refuses a payload containing the sentinel before any dispatch** (closed known
class, nothing read, nothing written, no slot held), so no needle can end with the sentinel either. Every
other needle tail is either a payload character the document must really hold or the authored `"\n"` of
the `end` form, which only class 1 supplies. U+0000 is also not a character an HTML text node carries (a
literal NUL in the source is replaced with U+FFFD), so the sentinel in the counted text can only come
from this rule. Consequence, stated plainly: an unknown element can now only SPLIT text (a payload
spanning it settles UNCERTAIN — fail-safe for the cursor form) or inject a sentinel no needle holds
(fail-safe for the `end` form).

**Corrected invariant sentence.** Where §6 (and the bridge comment it mirrored) said *"an unknown element
— or an element that is genuinely inline but unnamed — now gets an EXTRA separator, so a payload spanning
it will NOT match the extracted text and the insert settles UNCERTAIN (a false negative, fail-safe)
instead of being reported as a verified success"*, the corrected statement is: **an unknown element gets
the sentinel separator, so it can only split text (a false UNCERTAIN for the cursor form) or inject a
character no needle can hold (a false UNCERTAIN for the `end` form) — it can never complete a needle.**
An independent review then found the follow-on sentence ("only a known block boundary can supply the
`end` form's newline") to be **literally false**: a raw `"\n"` already present in an export text node, and
the body/html document-edge separator, can also complete the `end` needle. That is a PRE-EXISTING
residual, not introduced by the sentinel rule, and it is unreachable while the export is unchanged — with
identical pre and post exports the count delta is 0 and the insert settles UNCERTAIN, so a true no-op
paste is never verified as a success. It sits in the same concurrent-writer window the design already
acknowledges, and closing it would need newline normalisation of the extracted text (a separate change).
§6's claim is marked retracted in place.

**D-2 — the rawtext set was incomplete (MEDIUM, narrow).** `iframe`, `noembed` and `noframes` are
RAWTEXT elements of the real parser exactly like `style`: their content is markup-level, not document
text. Measured then: post `<p><iframe>delta</iframe></p>` with payload `delta` → VERIFIED; now
UNCERTAIN, with a regression test for each of the three plus the nested shape.

**D-3 — vestigial field, fixture divergence (LOW).** (a) `platform.document` was never read after the
parse moved to `DOMParser`, so it is **removed** from the bridge option, from `src/ui/entry.js` and from
the fixture: the injected boundary now names exactly the ONE platform capability this path uses, and the
fixture no longer offers a `createElement` helper either, so a fallback to the retired detached-container
parse fails on a missing capability. (b) The fixture parser diverged from the real HTML parser in two
ways a test could pin as if it were real: it read `<?…?>` as an **element** (the real parser makes it a
bogus comment) and it **walked `<template>` content** (the real parser puts those children in
`template.content`, never in the element's own `childNodes`). Both are fixed, and a fixture-fidelity test
pins them. **No pre-existing test depended on the divergence** — neither shape appeared anywhere in the
suite — so the pins are new coverage, not a rewrite of an existing expectation.

**Tests.** RED first, through the real bridge, on the tree of §6: all six reproductions above settled
`effectVerified:true`/`VERIFIED` before the change and `APPLY_UNCERTAIN` after it; the fixture-fidelity
test failed on the invented `?XML` element before the fixture fix. Controls kept green: a genuine
known-block boundary after the payload still lets the `end` form VERIFY (`<p>…<p>01</p>` and
`<p>…<span>01</span>`), a payload spanning an unknown element still settles UNCERTAIN, and the boundary
between two known blocks still does not create a false match. No other test was weakened or deleted; the
only edits to existing tests are **comments** (the bridge test file's header statement of the retracted
invariant, the `<center>` test's explanation of what an unknown boundary now is, and the fixture's doc
comments) plus the new `RAWTEXT_TAGS` membership pin. Final tree: `node --test` **666/666** (661 before
this change + 5 new cases), the focused bridge/dispatch-API/word/integration suites green,
`Authored-code audit PASS` (exit 0) and the bundle build exit 0.

**Unverified natively:** as in §5 and §6, none of this ran on a live editor. What only a native run can
show is the real `GetFileHTML` element vocabulary — in particular which elements R7 actually emits at an
inline boundary (the sentinel turns any unlisted one into a false UNCERTAIN, never a false success), and
whether a real export ever carries a NUL in its text (it must not, or the refusal above fires) — and
whether a real document's extracted text matches this model. The programmatic injection is a real page's
own `DOMParser`; the fixture is not a browser.
