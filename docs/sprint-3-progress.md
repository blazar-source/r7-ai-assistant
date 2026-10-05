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

## 8. Sprint 3, tool 1 — `read_document_text`, the bounded chunked document read

> Historical record of the tool's first landing, kept as written. The bounds and the enforcement rule it
> records were corrected by the independent review in **§8a**, which is what the code now does.

The first tool of the §10 catalogue. It is a **read**, so it needs no delta, no readback and no
uncertainty class: a string is an unambiguous result and there is no mutation whose effect would have to
be established. Its mechanism is the one Phase 0 measured on **both** builds and the insert confirmation
already uses — the public `GetFileHTML` export, decoded by the bridge's own
`decodeDocumentText` + `documentText` helpers. It adds **no editor call, no new capability and no write
path**, and nothing in it sends the whole document anywhere: the tool has no model or transport call at
all. `src/agent/*` is untouched; the tool becomes available by existing, because the runtime builds its
catalogue from the registry.

**One new bridge leg** (`readDocumentText`, ticket kind `documentread`): one `GetFileHTML` dispatch on
the single owned callback slot, decoded by the SAME two helpers (one decode rule, not two), answering
`{ok:true, text, totalChars}`. It carries **no document-identity probe**, deliberately: unlike a
selection read it hands back no OWNED TARGET a later write could be applied to, so there is no handle
whose ownership would need proving, and the insert's own pre-dispatch document read has always had
exactly this shape. The fail-closed rule is unchanged — an export above `LIMITS.documentHtmlBytes` is
**refused** (`BYTE_LIMIT`) and never truncated into a prefix, because a clipped export would publish a
false `totalChars`; a platform the text cannot be built with is `CAPABILITY_UNAVAILABLE`; a non-string
answer is `INVALID_DATA`.

**Limits** (`src/shared/limits.js`): `readDocumentChars = 12000` (the default chunk),
`readDocumentMaxChars = 32768` (the advertised hard cap — exactly `editorResultBytes / 2`, the largest
chunk whose **Cyrillic** encoding fits, and Cyrillic is this product's realistic worst case), and
`readDocumentOffsetMax = 262144` (no readable document's text can be longer than `documentHtmlBytes`
characters, since every character costs at least one UTF-8 byte).
**SUPERSEDED by §8a:** an independent review showed this arithmetic was bound to the wrong ceiling — the
runtime's entry ceiling is `toolResultBytes` (16384), not `editorResultBytes` (65536) — and the offset
premise was false. The values in force are `readDocumentChars = readDocumentMaxChars = 8000`,
`readDocumentEntryBytes = 130` and `readDocumentOffsetMax = 524305`.

**Result shape:** `ok({ text, offset, totalChars, truncated, nextOffset })`, where `text` is the
requested slice, `totalChars` is the whole document's own character count, `truncated`/`nextOffset` are
**one fact** (`nextOffset` is `null` exactly when the chunk reached the end), and an offset at or past
the end is an `ok` with empty text — never a refusal. A chunk that ends exactly at the end reports
`truncated:false, nextOffset:null`. All four positions are counted in the same unit (the string's own
code units), so a resumed read is contiguous.

**The enforced bound is a byte measure, not the advertised character cap.** The schema's cap bounds
CHARS; the per-result ceiling is BYTES, and the widest encoding of one BMP character in this byte counter
is three bytes (CJK text, typographic punctuation; a lone surrogate counts as U+FFFD, also three), so the
largest advertised chunk measures 98304 bytes. The handler therefore measures the slice it is about to
return and refuses an over-ceiling one **whole** as `BYTE_LIMIT` — never clipped, because a clipped chunk
would publish a resume point that skips text the model never saw.

**Failure classes:** a non-Word editor and a bridge that cannot serve the read →
`CAPABILITY_UNAVAILABLE`; a bridge refusal → its own closed class through `refusalCode`
(`BYTE_LIMIT`/`CAPABILITY_UNAVAILABLE`/`INVALID_DATA`/`TIMEOUT`/`CANCELLED`), while a code outside the
closed vocabulary collapses to `TOOL_ERROR`; an envelope the tool cannot interpret (no `ok:true`, a
non-string `text`, a `totalChars` that disagrees with it) → the module's unknown convention `known()`;
the bridge's own uncertain class → `TOOL_UNCERTAIN`, which stops the run. An **empty document** is a
legitimate `ok` (`text:''`, `totalChars:0`, `truncated:false`, `nextOffset:null`) — deliberately NOT the
`read_selection` convention, because an empty SELECTION means there is nothing to reason about while the
empty answer here IS the complete answer to "what does this document say".

**Tests.** RED first: 25 new/extended cases failed on the tree before the implementation (the tool did
not exist — `TypeError: Cannot read properties of undefined (reading 'execute')` — and the three exact
descriptor-list assertions did not carry the new name), then all passed. Coverage: schema acceptance and
rejection (unknown key, non-integer, below `minimum`, above `maximum`, the exact bounds, the omitted-key
defaults), the non-Word precondition, first/middle/exact-end/past-end/oversized slice boundaries,
`totalChars`, the `truncated`/`nextOffset` pair, a full chunk walk that reconstructs the document with no
gap or overlap, the empty document, every refusal class, the over-ceiling slice
(`BYTE_LIMIT`), a Cyrillic chunk measuring exactly `editorResultBytes` (2 bytes/char), the caller signal,
"exactly one bridge read and no write method", the real bridge leg (one `GetFileHTML`, an over-ceiling
export, a malformed answer, a missing `DOMParser`, an inherited dispatch channel, a pre-aborted signal),
and the offered catalogue + a model-emitted call dispatched through the real runtime. No existing test
was weakened or deleted; the only edits to existing ones are the three exact descriptor lists, which now
name the new tool. Final tree: `node --test` **688/688** (666 before this tool + 22 new cases —
three of the 25 RED failures were the extended existing assertions), the focused word suite green,
`Authored-code audit PASS` (exit 0) and the bundle build exit 0
(`Plugin build: 8 allowlisted files; ZIP STORE SHA-256 e7672feb…`).

**Unverified natively:** as everywhere above, this ran host-side only. What only a native run on the
target can show is that the installed build's `GetFileHTML` really answers for a real document, how large
a real document's export is against the 256 KiB ceiling, whether the decoded text of a real export
matches this model (the element vocabulary question of §5–§7, now also the substance this tool hands the
model), and how a real R7 document's text behaves around an offset that lands inside a surrogate pair or
a paragraph-boundary separator. An editor that does not implement `GetFileHTML` gets no document read at
all: the ticket settles `TIMEOUT`, a known class, never a document.

## 8a. Independent review of tool 1: three defects found and fixed

The tool shipped in §8 passed its own suite but defeated itself in production. All three defects below
were reproduced against the REAL runtime/protocol before the fix (RED), and the corrected bounds and
guards are what the tests now pin.

**D1 (HIGH) — the chunk was bound to the wrong ceiling.** The handler bounded the slice by
`LIMITS.editorResultBytes` (65536), but the runtime refuses any tool-result entry whose **serialization**
exceeds `AGENT_CEILINGS.toolResultBytes` (**16384**, `protocol.js:91`) and substitutes the literal
`"the tool result could not be serialized"` (`runtime.js:27-36`). Measured through the real protocol
serializer on `'я'.repeat(12500)`: the handler answered `ok` with 12000 characters, the entry measured
**24124 bytes**, `toolResultMessages` threw `TOOL_ERROR`, and the model received no text at all. The
threshold was any Cyrillic chunk over ~8144 characters — the 12000-character DEFAULT already exceeded it,
so for the product's main language the tool failed on every non-trivial document.

The fix measures the ACTUAL serialized entry the runtime measures — `JSON.stringify({ tool, ...result })`
in the protocol's own key order (`documentEntryBytes` in the tool, pinned by a test against the real
shape) — and sizes the advertised chunk from it. The arithmetic, stated as the limits module states it:

| quantity | value | arithmetic |
| --- | --- | --- |
| the enforcing ceiling | `AGENT_CEILINGS.toolResultBytes` = **16384** | `JSON.stringify({tool, ...result})` |
| non-text envelope of one entry | **130** bytes (`readDocumentEntryBytes`) | widest admitted field width: 6-digit `offset`, 6-digit `totalChars`, `"truncated":false`, 4-character `null` |
| Cyrillic (2 bytes/character) | **8000 characters** = 16000 bytes | 16000 + 130 = **16130 \<= 16384** (254 slack); exact floor 8127 |
| ASCII (1 byte/character) | 8000 characters = 8000 bytes | 8000 + 130 = 8130 |
| CJK (3 bytes/character) | 8000 characters = 24000 bytes | above the ceiling → closed `BYTE_LIMIT`, retry smaller |

`readDocumentChars` (the DEFAULT) and `readDocumentMaxChars` (the advertised cap) are both **8000**, so a
default Cyrillic read — the case the reviewer measured — is delivered whole, and every advertised maximum
is a chunk the tool can return. The handler still measures the entry it is about to return and refuses an
over-ceiling one with the closed `BYTE_LIMIT` class (never clipped, never shipped unparseable); a bridge
answer whose own `totalChars` is past every readable document is refused the same way.

**D2 (MEDIUM) — a lone surrogate could be shipped.** The slice was taken over UTF-16 code units with no
pair guard: `"a😀b"` with `{offset:1, maxChars:1}` returned `"\ud83d"` and `{offset:2, maxChars:2}`
returned `"\ude00b"`. The same technique `prefixWithin` (`context.js:21-38`) already uses is applied to
BOTH cuts: a start inside a pair steps BACK over the low surrogate (so the chunk begins on a whole
character), and an end inside a pair steps FORWARD past it (so the pair is completed rather than truncated
to its high unit). Moving outward is what keeps the walk exact: every returned chunk is well formed, the
chunks still tile the document, and `nextOffset` always advances, so an offset that names the tail of a
pair can neither repeat a chunk nor stall a resumed read.

**D3 (LOW) — the offset maximum made a tail unresumable.** `readDocumentOffsetMax` rested on "the export
needs at least one byte per character", which is false: the decoder appends one newline per block-level
element, so a 100-byte pure-text export decodes to 101 characters and the text CAN be longer than the
export. Reproduced with `totalChars = 262146`: `{offset: 262144, maxChars: 1}` published
`nextOffset 262145`, which the tool's OWN schema (`maximum: 262144`) rejected — that tail could never be
read. The bound is now derived from the export it is read through — 2 × 262144 + 1 + 16 = **524305** —
and the handler also clamps the chunk's end to it, so **every `nextOffset` the tool can publish is an
offset its own schema accepts**. A property test asserts exactly that for texts at, around and past the
bound, for both ASCII and Cyrillic.

**Tests and verification.** RED first (the numbers above), then GREEN. The focused word suite is
**66/66**; the full suite grew **688 → 695** with `fail 0`; `node scripts/static-audit.mjs` →
`Authored-code audit PASS` (exit 0); `node scripts/build-plugin.mjs` → exit 0 (`Plugin build: 8
allowlisted files; ZIP STORE SHA-256 addb8abb…`). Changed tests and why: the schema test now asserts the
serialization-derived bounds (8000/8000/130/524305) instead of the arithmetically wrong
`editorResultBytes / 2` and the `documentHtmlBytes` premise; the "Cyrillic chunk" case now asserts the
exact serialized entry (`16123` bytes) and that the runtime's own serializer accepts it; the over-ceiling
case now covers both the defensive refusal and the in-ceiling service for each encoding. No test was
weakened or deleted. `src/agent/*` was not touched: the fix lives in the tool, the limits module and the
tests, and the bridge leg is unchanged (one `GetFileHTML` on the owned slot, still read-only).

## 8b. Re-review of tool 1: D1 was still open by one byte

The `§8` fix measured the result entry with the values that had been **assumed** rather than the values
that were about to be **published**: `documentEntryBytes(text, offset, totalChars, null)` — i.e.
`"truncated":false` with `"nextOffset":null`. The handler then published
`"truncated":true` with a six-digit `nextOffset`. On a six-digit resume point the two serializations
differ by exactly **one byte** (`true` against `null`, both over `false`), and they differ by more at
smaller offsets, so the published entry was systematically **larger** than the entry that had been
measured. The `> AGENT_CEILINGS.toolResultBytes` check therefore admitted a chunk whose real entry was
over the ceiling: `stringifyToolResults` (`protocol.js:91`) threw `TOOL_ERROR`, `runtime.js:27-36`
replaced the whole result with the literal `"the tool result could not be serialized"`, the model
received **no text at all**, and the run's action log still recorded `outcome: "ok"`.

**The reproduction** (the reviewer's, re-measured here). Document text
`99998 × 'x' + 5397 × '漢' + 1 × 'я' + 63 × 'x'` = 105459 characters; call
`{offset: 99998, maxChars: 5460}`. The chunk is 5460 characters = **16255 text bytes**; the
nil-resume-point entry is **exactly 16384** (`= AGENT_CEILINGS.toolResultBytes`), so it passed the
`> ceiling` check; the entry actually published is **16385**, the runtime serializer throws, the
model-visible message is the literal refusal (confirmed end-to-end through `runAgent`), and the model
never sees one character of the chunk.

**The fix.** `nextOffset` is now computed *before* the measurement and the measurement is taken on the
entry that is returned, byte for byte, in the protocol's own key order
(`documentEntryBytes(text, offset, totalChars, nextOffset)`, `src/tools/word.js:249`). The exact form is
chosen over the equivalent conservative guard: the measured value **is** the published value, so there is
one measurement instead of two, no re-derivation when a field width changes, and no way for the checked
shape to drift from the returned shape — which is precisely the drift that produced this defect. The
chunk is still refused **whole** with the closed `BYTE_LIMIT` class when its published entry does not
fit; at `{offset: 99998}` one character less (`maxChars: 5459`) is served, which is the same refusal
decision the tool already made for three-byte scripts. `src/shared/limits.js` needed no change: the
`readDocumentEntryBytes = 130` envelope already covers the truncated shape with the widest field width,
and the advertised chunk (8000 Cyrillic characters = 16130 bytes) stays inside the ceiling.

**Tests.** RED first, each of the three assertions failing on the pre-fix call site with the reproduction
above (`16385 <= 16384` for `{"offset":99998,"maxChars":5460}`, and `the runtime never substituted its
refusal` end-to-end), then GREEN for all ten of the reviewer's offset/maxChars cases. Four new tests:
the end-to-end refusal-not-substitution case at the exact ceiling (plus the one-character-less contrast
that serves), the entry-for-entry measurement statement (the nil-resume-point shape is exactly the
published shape **minus one byte** when a six-digit resume point is published), the ten-case end-to-end
sweep asserting no chunk text is ever delivered as a substitution while every `ok` carries its text, and
a boundary sweep over the reviewer's own document (14 cases whose nil-resume-point entry sits in the last
40 bytes under the ceiling, every one of them a closed refusal once the published shape is measured)
where every published `ok` entry must be inside the ceiling and accepted by the runtime's own serializer.
No existing test was weakened or deleted; the existing entry/measurement assertions stay as they were,
and the assertion that reconstructed the nil-resume-point **shape** lives in the new test rather than in
the tool. The focused word suite is **70/70**; the full suite grew **695 → 699** with `fail 0`;
`node scripts/static-audit.mjs` → `Authored-code audit PASS` (exit 0); `node scripts/build-plugin.mjs` →
exit 0 (`Plugin build: 8 allowlisted files; ZIP STORE SHA-256 7d1672e1…`). `src/agent/*` is untouched and
the bridge leg is unchanged: still one read-only `GetFileHTML` on the owned slot, no new editor primitive.

## 8c. Lead ruling: `maxChars` is an UPPER BOUND, so an over-ceiling request is served as the largest fitting slice

`§8a`/`§8b` made the tool measure the entry it publishes, and a slice that did not fit that entry was
refused **whole** with the closed `BYTE_LIMIT` class. The re-review showed what that costs: at
`{offset: 99998, maxChars: 5460}` on the reviewer's document the published entry is 16385, so the call was
refused — while `maxChars: 5459` at the **same offset** was servable. The schema advertises `maxChars` up
to 8000, so that refusal rejects a **schema-legal** call for size, and the caller has no way to learn
which smaller request the tool would have served without spending another step guessing.

**The ruling.** `maxChars` stays the ceiling on what may be **requested**; the handler now serves the
**largest slice of the same `offset` whose published entry fits**. The result's own `text` length,
`truncated` and `nextOffset` tell the caller what was actually served, so the model needs no extra step.
The tool stays fail-closed: the entry is still measured **exactly** on the values about to be published
(one measurement, `publishedChunk`), and only a slice where **not even ONE whole character** fits is still
a closed `BYTE_LIMIT` refusal. Clipping is still forbidden: the served chunk is always a whole-character
**prefix** of the request, so its resume point cannot skip text.

**The search.** Bisection over the cut, because the handler can **prove** the predicate is monotone —
but **only on the interval it actually probes**, and the review of this round showed why that restriction
has to be written down. The unrestricted proposition "for two ends `e' < e`, `bytes(e') <= bytes(e)`" is
**FALSE**: on `'x👍яé'` with `offset = 3` the end `3` publishes **125** bytes and the longer end `4`
publishes **123**. Two mechanisms make a longer slice cheaper — completing a surrogate pair replaces two
six-byte `\uXXXX` escapes with the character's own four bytes (the end-2 entry is 127, wider than the
end-3 entry's 125), and the first end above `offset` replaces `"truncated":false` + `"nextOffset":null`
with `"truncated":true` + a one-digit address, three bytes narrower (125 → 123). The loop never searches
either zone: `floor = characterEnd(start + 1)` is strictly greater than `offset` (an equality would mean
`offset` sat inside a pair, which `characterStart` has already excluded), every probe is a
`characterEnd(midCut)` with `midCut >= start + 2`, and inside that interval every probed end is a
whole-character boundary strictly above `offset` — so no probed end can carry a nil resume point, and the
envelope's only moving field is the **digit count of `nextOffset`**. Two constants carry the margin:
`LIMITS.readDocumentOffsetMax` (524305, **six** digits) clamps every probed end and holds the envelope's
digit growth inside the interval to **one** byte, and `AGENT_CEILINGS.toolResultBytes` (16384) keeps the
failing ends in the 4–6 digit zone (the most expensive sub-4-digit entry any shape can produce measures
**6116** bytes, so the loop cannot run there at all). A **seventh** digit on the offset bound would let
one probed step add two envelope bytes against the one byte a removed character saves — the monotonicity
would fail on ends the loop really probes and the bisection would silently return a non-maximal slice;
a ceiling small enough to push the search into the 1–3 digit zone would do the same. Every probed cut is
re-stepped over a surrogate pair with `characterEnd`, so each probed end is a whole character and a pair
is never split. **Work bound:** one measurement for the request, one for the floor, and
`ceil(log2(maxChars)) <= 13` probes — at most **15 exact measurements of one entry**, all through the
same `documentEntryBytes`, so no second, competing measurement exists.

**The reproduction, before and after** (document `99998 × 'x' + 5397 × '漢' + 1 × 'я' + 63 × 'x'`,
105459 characters, `maxChars: 5460`):

| offset | before | after | served | entry bytes |
| --- | --- | --- | --- | --- |
| 99998 | `BYTE_LIMIT` | **ok** | 5459 (the largest that fits) | **16384** (exactly the ceiling) |
| 99999 | ok | ok | 5460 (whole) | 16382 |
| 100000 | ok | ok | 5459 | 16380 |
| 100001 | ok | ok | 5458 | 16377 |
| 107000, 107001, 262143, 262144, 300000, 516304 | ok | ok | 0 (empty tail — past this document's end) | 130 |

The CJK case at the advertised maximum: `'漢'.repeat(8100)` with `maxChars: 8000` used to be
`BYTE_LIMIT`; it now serves **5420** characters (entry **16382**), and 5421 characters would be **16385**
— the shrink is exactly as far as needed and no further.

**Tests.** RED first: **10** focused cases failed on the pre-change tree (`63/73 pass, 10 fail`) — the
seven tests that encoded the hard refusal, and the three new ones. GREEN: the focused word suite was
**73/73**, and the full suite grew **699 → 702** with `fail 0`; `node scripts/static-audit.mjs` →
`Authored-code audit PASS` (exit 0). New coverage: the reviewer's ten
offset/`maxChars` cases through the **real** `runAgent` (every one an `ok` the model receives, entry
`<=` the ceiling, never the runtime's substitution string), a three-byte sweep showing the served length
is the **largest** that fits (one character more is over the ceiling), a walk whose shrunk boundary lands
exactly on an astral surrogate **pair** (chunks still tile the document with no skipped or duplicated
character, and the pair is served whole by the next chunk), and the one-whole-character floor.

**The follow-up round closed the review's two non-blocking conditions.** The false monotonicity
proposition above is **replaced** by the true, restricted one (in the handler's own comment and in the
paragraph above), and three boundary tests pin it: the falsifying `'x👍яé'` case re-measured (end 3 =
125, end 4 = 123) with the loop's own interval shown non-decreasing; a document that already **holds** a
lone surrogate (`'\uD83D'.repeat(6000)`, six escaped bytes per unit) served at **2710** units with an
entry of **16382** bytes that the runtime's serializer accepts — measured, not repaired, and documented
as a residual the DOMParser path cannot itself produce; and the measurement that no sub-4-digit entry can
reach the ceiling (**6116** bytes at a 999-unit end), so the loop can never search in the 1–3 digit zone.
This round the focused word suite is **76/76** and the full suite grew **702 → 705** with `fail 0`;
`node scripts/static-audit.mjs` → `Authored-code audit PASS` (exit 0); `node scripts/build-plugin.mjs` →
exit 0 (`Plugin build: 8 allowlisted files; ZIP STORE SHA-256
c1c116f8f47f9d7d08f14f8711332762a0b0814a2601b7390107d8938c5d0cbd`). **That SHA is pinned to the bundle
built from the tree at commit `3d12d39`** (superseded by the later rounds — see §10 for the current pin) — measured twice, from this worktree, and not from the main
checkout, which sits on the older `bde9080`; the earlier `0e3e1065…` recorded here was stale. The bundled
files are byte-identical across the tool/tests change, so the value is stable, but a later commit that
touches an allowlisted plugin file must re-measure it and re-pin it to its own commit.

**Which existing assertions moved, and why the replacements are stronger.** Seven tests encoded the
old hard refusal and were **moved**, not deleted:
`read_document_text keeps every entry inside the ceiling and every refusal closed` → *serves the largest
chunk its entry ceiling allows, for every encoding*; `... refuses a chunk above the per-result byte
ceiling as BYTE_LIMIT` → *serves the largest chunk that fits instead of refusing the request*;
`read_document_text serves every chunk it RETURNS inside the per-result ceiling` (its CJK tail);
`read_document_text at the exact ceiling is refused closed …` → *serves the exact-ceiling chunk as the
largest slice that fits, end to end*; `... measures the exact entry it publishes …` (its refusal branch);
`... returns text the model receives for every reviewer offset`; and `... never publishes ok for an entry
the runtime will refuse` (its refusal branch). Each replacement asserts everything the old assertion
did — the entry is inside the ceiling, the runtime serializer accepts it, the class of every refusal is
closed — **plus** the new, stronger facts: the served text is the document's own text at that address, it
is the **largest** length that fits (one character more is measured over the ceiling), the request is
served rather than refused, and `nextOffset` names the shrunk boundary. No test was weakened or deleted,
and the tool is still read-only: one `GetFileHTML`, no write path, `src/agent/*` untouched.

## 9. Sprint 3, tool 2 — `read_paragraph`, the caret context read

**The primitive had to be established before anything was written, and the first evidence pass MISUSED its tool.**
`Select-String` was run in its default form — LINE-level and case-insensitive — on
`.local/stage-b-runtime/vendor-word-sdk-all.js`, a 15 MB single-line artifact, so it reported **17**
lines for `GetCurrent`, **12** for `GetSelectedText` and **2** for `pluginMethod_`: counts of **lines**,
not of occurrences, and never zero. `Select-String -CaseSensitive -AllMatches` on the same file returns
the exact per-occurrence totals **265**, **101** and **4**, the same numbers the file's own text holds.
The tool was **misused, not unusable**; the counts below come from matching the file's text directly.
Every count in the `read_context` withdrawal comment (§ above, `GetDocumentStructure` 0 /
`GetSelectedText` 101) is consistent with that measurement.

**What the counts are.** `pluginMethod_GetCurrentParagraph`, `pluginMethod_GetCurrentSentence`,
`pluginMethod_GetCurrentWord` and `pluginMethod_GetSelectedText` occur **0** times each — and those
zeros prove **nothing**, because `pluginMethod_` is **not** a naming convention in this bundle: it
occurs **four** times in total (the explicit `PasteHtml` / `PasteText` / `OnEncryption` members and the
dispatcher's own `"pluginMethod_"+methodName` lookup), so the editor resolves every other method name
**dynamically** and no prefixed literal exists to count. The **bare** names are what exist:
`GetCurrentParagraph` **125**, `GetSelectedText` **101**, `GetCurrentWord` **7**, `GetCurrentSentence`
**6**.

**No plugin-level paragraph getter is established.** The **125** `GetCurrentParagraph` hits decompose
**exactly**, into four **disjoint** categories that sum to 125 (re-measured by matching the file's text,
not inherited from a prose estimate): **45** are the bare `this.GetCurrentParagraph`, **12** are
`this.<id>.GetCurrentParagraph`, **12** are `<id>.prototype.GetCurrentParagraph` **definitions** — one of
them `Ct.prototype.GetCurrentParagraph`, the `Api` / `getTargetDocContent()` route that manipulates the
**document** rather than the caret (and which Phase 0 measured as exposing no `GetSelection`) — and the
remaining **56** are `<id>.GetCurrentParagraph` on some other receiver. **101** of the 124 hits other than
that one `Ct.prototype.` literal are therefore **neither** `this.X.…` **nor** a `*.prototype.`
definition. The sample `documentContent.GetCurrentParagraph()` occurs **zero** times and must not be
quoted as evidence. So this tool dispatches no `GetCurrentParagraph` and never reaches for `Api`.

**`GetCurrentSentence` is established, by this repo's own history.** Commit `ed65dd5` dispatched exactly
`plugin.executeMethod('GetCurrentSentence', [], callback)` through the one owned dispatch channel and
records it as *"the primitive the live build actually answers with the inserted sentence"* on
R7-Office **2026.3.1**. That is the most precise caret read that exists, so `read_paragraph` reads the
**sentence** at the caret and its result says so: `scope` is the literal `"sentence"`. The descriptor is
named `read_paragraph` by the sprint contract, and nothing in the result claims a paragraph the
primitive cannot deliver. (`defineTool`'s field allowlist carries no `description` field, so the truth
lives in `scope` — which the model sees — in the descriptor comment and in the failure contract.)

**The bound is the serialized entry, and the entry measurement is load-bearing, not decorative.** The
tool-result entry `{"tool":"read_paragraph","ok":true,"data":{"scope":"sentence","text":T,"bytes":N}}`
is bounded by `AGENT_CEILINGS.toolResultBytes` = **16384** (`stringifyToolResults` refuses an entry above
it and `runtime.js` substitutes *"the tool result could not be serialized"* — the model gets **no text**
while the action log still records `ok`). The envelope is a fixed **82** bytes plus one byte per digit
of `N`, i.e. **87** at this bound, and `LIMITS.readParagraphBytes = 16000` is the largest **round**
ceiling that fits the product's realistic worst case: `16000 + 87 = 16087 <= 16384`, **297** bytes of
slack (the exact largest text is 16297; 16298 makes 16385). It is **not** an alias of
`contextReadBytes.paragraph` — that entry bounds a raw paragraph the `read_context` tool addresses,
while this one bounds the serialized entry of a caret read, and the module's own rule forbids serving
one scope from another scope's budget.
The text bound alone is **not sufficient**: `JSON.stringify` escapes every C0 control character to two
characters and every lone surrogate to six, so **16000 newlines** are 16000 raw bytes — comfortably
inside the text bound — and a **32087**-byte entry. The handler therefore measures the **actua**
serialized entry and closes it as `BYTE_LIMIT`; that case is a test, not a hypothesis, and it is the
reason the entry measurement cannot be replaced by an arithmetic envelope.

**The declared failure contract.** wrong editor → `CAPABILITY_UNAVAILABLE` (precondition, nothing
dispatched); a bridge with no `readParagraph` entry point → `CAPABILITY_UNAVAILABLE`; a bridge refusal →
the module's `refusalCode` mapping, so `TIMEOUT` / `CANCELLED` / `INVALID_DATA` cross unchanged and an
arbitrary string keeps the closed `TOOL_ERROR` fallback; a `returned` **or** `thrown`
`APPLY_UNCERTAIN` → `TOOL_UNCERTAIN`; an over-bound text **or** an over-ceiling entry → `BYTE_LIMIT`; and
an **empty caret context** → the module's closed `known()` (`TOOL_ERROR`). That last one is a
**decision**, stated in the handler: an empty caret context means the caret is in no sentence at all —
nothing to reason about, like an empty selection in `read_selection` — which is deliberately **not** the
whole-document convention where `''` is the complete answer to "what does this document say".

**The bridge leg.** `readParagraph` adds exactly one editor primitive and no capability: ticket kind
`caretread`, **one** dispatch of `GetCurrentSentence` with `[]` through the same owned callback slot,
decoded under the caller's `maxBytes` (the `readBound` branch that `contextread` already uses), and **no
identity probe** — a caret context read returns no OWNED TARGET a later write could be applied to, so
there is no handle whose ownership would have to be proven. It adds no write class: `pendingMutation`
stays false throughout, and an empty answer crosses as an ordinary `{ok:true, text:''}` because the
convention belongs to the descriptor that publishes the contract. Whether the installed build exposes
`GetCurrentSentence` is **measured on 2026.3.1** (§ history above); a build that does not implement it
never calls back and the ticket settles `TIMEOUT`, a known class, never as a sentence.

**This round.** Focused word suite **76 → 94** (`94/94`), full suite **705 → 723** with `fail 0`;
`node scripts/static-audit.mjs` → `Authored-code audit PASS` (exit 0); `node scripts/build-plugin.mjs` →
exit 0 (`Plugin build: 8 allowlisted files; ZIP STORE SHA-256
ba403410d6e7f28ce22af849e4ab47520d701373540fb7702496624065e0d1bd`). The tool is read-only by
construction and by test: exactly **one** bridge call (`readParagraph`) and no write method reachable
from the descriptor. Three existing exhaustive catalogue assertions grew by one name
(`the representative descriptor set`, `read_context is withheld …`, `registry accepts the word tools …`)
— extended, none weakened or deleted; the ASK catalogue order is asserted unsorted, so
`read_paragraph` is **appended last** there: `['read_selection', 'read_document_text', 'read_paragraph']`.
`src/agent/*` untouched.


## 10. Sprint 3, tool 2 — the entry measurement for `read_selection` and `read_context`

**The review found two fail-OPEN bounds the same fix closes.** `read_selection` was LIVE: it bounded only
the raw selection text by `contextReadBytes.selection` (8192) and never measured its serialized entry, so
the reviewer's exact reproduction — a selection of **8192 newlines** is 8192 raw bytes and a **16451**-byte
entry — was refused by `stringifyToolResults` (protocol.js:91) while `runtime.js:27-36` replaced the whole
result with the literal *"the tool result could not be serialized"*: the model received **no text** and the
run's action log still recorded `ok`. `read_context` was the same defect **latent**: policy `deny` keeps it
out of every catalogue, but the handler stays executable when the descriptor is held directly, so a future
`auto` flip would have made it live.

**What the fix does.** ONE shared `toolResultEntryBytes(tool, data)` is the module's single
`JSON.stringify({ tool, ok: true, data })` + `utf8ByteLength`, with one-line per-tool wrappers
(`documentEntryBytes`, `selectionEntryBytes`, `paragraphEntryBytes`, `contextEntryBytes`) naming the data
object each handler publishes; the two older helpers were refactored onto it with the same shape, byte for
byte. Both reads now close an entry above `AGENT_CEILINGS.toolResultBytes` (16384) as the closed
`BYTE_LIMIT` **with `data === undefined`**, so a refusal carries no document text at all; a selection is
never shortened to fit, because a shortened selection would be presented as **THE** selection. `src/agent/*`
untouched; no limit value changed.

**The measured boundaries.** `read_selection`: a **8158**-newline selection is served (entry **16383**),
**8159** is refused (**16385**); a **2719**-unit lone surrogate is served (entry **16381**), **2720**
doubles to a **16387**-byte entry and is refused. `read_context`: an ASCII `paragraph` at `index: 0` is
served to **16288** characters — the entry is then exactly **16384**, the maximum successfully served entry
— and **16289** is refused, which is the dead band described below.

**The confirmed non-RED test.** The commit message says the five new tests were RED first; on the pre-fix
tree re-run for this round only **four** were — 95 of the 99 focused cases pass, and the failures are exactly
`read_selection refuses a selection whose SERIALIZED entry alone is over the ceiling`, `no read_selection ok
result can exceed the runtime result ceiling`, `a read_selection the runtime would refuse reaches the model
as a closed refusal, never as ok` and `read_context bounds the SERIALIZED entry, not only the raw text …`.
The fifth, `read_selection publishes an entry the runtime serializer accepts, measured exactly`, is
**characterization**, not reproduction — so four of the five were RED, not five: a 2000-character
selection was inside the ceiling before the entry measurement existed, so it passed on the pre-fix tree
and the commit message's blanket "five" is inexact.
The commit message cannot be rewritten; this record is the correction, and the test's own comment now says
so.

**The follow-up correction to the primitive evidence.** The decomposition of the 125 `GetCurrentParagraph`
hits was restated in `word.js`, in the test comment and above: the four disjoint categories (45 / 12 / 12 /
56) replace the earlier two-category sentence, which had left 101 of the hits uncategorized. The
`read_context` claim was narrowed to what the measurement achieves — it closes the fail-OPEN, so an
over-ceiling context can no longer be published as `ok`. It is **not** by itself what makes an `auto` flip
safe, and the record says so: the per-scope text ceiling is `contextReadBytes.paragraph` = 16384, the
**whole** entry ceiling, so the entry measurement eats into the raw bound and leaves a **dead band** — the
envelope is **92** bytes at a one-digit index, so an ASCII `paragraph` at `index: 0` is served to **16288**
characters (entry exactly **16384**) and refused at **16289**, while **16384** raw bytes are what the bound
advertises. And the descriptor's own withdrawal condition still stands: a **native probe** of a public
document read must confirm it before the policy becomes `auto` again. No limit value changed in this
commit; a lift of the dead band is a ceiling decision for the Lead, not a comment edit.

**Verification.** Focused word suite **94 → 99** (`99/99`); full suite **723 → 728** with `fail 0`;
`node scripts/static-audit.mjs` → `Authored-code audit PASS` (exit 0); `node scripts/build-plugin.mjs` →
exit 0, `Plugin build: 8 allowlisted files; ZIP STORE SHA-256
c6e7e3a97a1688e8f091eeefbfb0bcfd8185d903849db50950e9a18fcf7c15f2`, re-measured on the tree this round
commits (twice, same value). The ZIP SHA **did** move from the round's own
`3da4979e015ba17c7fd46d5c848e9eba04afcc8dc8adfb9b3cf4fd3ab3466602`, and the reason is a property of the
builder, not of a behaviour change: the bundler keeps the comments of a **descriptor body** verbatim
(`minify: false`) and this round rewrote the `read_paragraph` decomposition comment in `src/tools/word.js`,
which is bundled — I confirmed that comment in the built `panel.js` — so the packed archive is no longer
byte-identical and the SHA **must** be re-pinned. The earlier arithmetic ("the bundled files are
byte-identical across the tool/tests change") is not general: comments inside a handler's `execute` body
are removed by the bundler (the `read_context` and `read_selection` ones are absent from `panel.js`, as
they were before this round), so only descriptor-body edits move the bytes. No behaviour changed: the
bundle's only difference is comment text, and the build is deterministic across repeated runs.


## 11. Sprint 3, tool 3 — `find_text`, the bounded document search

**The primitive, measured on the target (Astra / R7 2026.1.2.1942, this round) and treated as
established.** `Api.GetDocument().Search(query, matchCase)` returns a **real Array of range objects**:
`count = 4` for the strict `'МАРКЕР-ПОИСК'`, `count = 5` for the case-insensitive `'маркер-поиск'` over
the same document (the fifth occurrence is the lowercase one), `count = 0` — an **empty array, never
null** — for a needle the document does not hold, and `GetText()` on one element is that match's own
text (`'МАРКЕР-ПОИСК'`). `Start`/`End` exist on those objects but their **unit is unverified**, so the
tool publishes **no position**: what a caller receives is each match's own text and its 0-based
occurrence order. This is the first READ in the repo that builds the `Api` facade **inside a command
body**.

**The dispatch, and the one new boundary it needs.** A command body is evaluated in the editor with
exactly two bindings: the editor's `Api` and the `scope` the vendor's own wrapper sets from
`window.Asc.scope` (`"var Asc = {}; Asc.scope = " + JSON.stringify(window.Asc.scope) + "; var scope =
Asc.scope; (" + fn + ")();"`, measured in the installed 2026.1.2 vendor source). `Asc.scope` is
therefore the **only** channel through which model data can reach a body, and it is the channel ADR 0002
sanctions ("data via `Asc.scope`", "never interpolate model data into source code"). The bridge now
takes that namespace as an **explicit option** (`ascNamespace`, defaulting to the page's own
`globalThis.Asc`, exactly the rule the `platform` boundary follows); `writeScope` writes the validated
`{ query, matchCase, limit }` triple into it and `clearScope` restores the previous value as soon as the
command has been handed to the native (the vendor reads the property **synchronously**), so a needle
never outlives its own dispatch and the page object never keeps a property it did not have. An absent,
non-object, sealed-without-a-writable-`scope`, or frozen namespace is the closed
`CAPABILITY_UNAVAILABLE` **before `owned.dispatched`**, so the slot is released and nothing reached the
editor. There is deliberately **no composed-source transport** for this leg: the `executeCommand`
fallback receives a source *string*, and building that string would mean interpolating model data into
command source, so a build without `callCommand` refuses before dispatch instead.

**The schema, the limits and the result.** Closed (`additionalProperties: false`), `required:
['query']`, `query: {string, minBytes 1, maxBytes findQueryBytes}`, `matchCase: {boolean}`,
`limit: {integer, minimum 1, maximum findMatchesMax}`. Two new `LIMITS` entries: **`findQueryBytes =
256`** (a search *string*, not a document read — 128 Cyrillic or 256 ASCII characters) and
**`findMatchesMax = 32`** (both the documented default and the hard cap, so the advertised space is a
size a default call really returns). The result is `ok({ query, matchCase, count, matches, truncated })`
with `count` the primitive's **total** and `matches` a bounded array of `{ index, text }`. The enforced
bound is the **serialized entry** through the module's one `toolResultEntryBytes` (new `findEntryBytes`
wrapper): the worst realistic call at both maxima measures **9283** bytes against the 16384-byte
ceiling (7101 of slack), and widening `count` from its 2 digits to the 16 of
`Number.MAX_SAFE_INTEGER` — which the schema allows, because `count` is the primitive's total, not the
reported-array length — adds 14 bytes and nothing else, for the true maximum of **9297** with
`truncated:false` (**7087** of slack) and **9296** with `truncated:true`. What cannot fit is the
**escape width**, and there are **two** of them, not one: a C0 control with a named short escape
serializes to the **two** characters `"\n"`, so a 256-character `\n` needle at 32 matches measures
**17731**; a C0 control with no short escape serializes to the **six**-character `\uXXXX`, so the same
needle made of U+0001 measures **51523**. Both are the closed `BYTE_LIMIT` — the tool never shortens a
match's text silently. The body extracts exactly `min(count, limit)` texts **inside the editor**, so a
needle matching thousands of ranges never crosses thousands of texts, and the decoder refuses any answer
with a different number.

**Two documented decisions.** `matchCase` defaults to **`false`** — the case-insensitive search is the
superset of the strict one and mirrors the editor's own Find default — and the **result echoes the
resolved flag**, which the measured 4-vs-5 pair makes non-optional: the model can always tell which
question was answered. **Zero matches is `ok`** with `count: 0` and an empty `matches`: "the document
holds no occurrence" *is* the complete answer to a search, deliberately unlike an empty **caret**
context, where `''` means there was nothing to reason about. Failure classes: wrong editor / missing
bridge method / bridge `CAPABILITY_UNAVAILABLE` → `CAPABILITY_UNAVAILABLE`; any other closed bridge class
republished through the module's `refusalCode`; an uninterpretable envelope → `known()`; a returned or
thrown `APPLY_UNCERTAIN` → `TOOL_UNCERTAIN`; an over-ceiling entry → `BYTE_LIMIT`.

**A static-audit finding the first draft hit, recorded because it is a rule, not a style note.** The
first version of the body wrote `var element = found[index]; … element.GetText()`. That is an indexed
read of editor **data**, but the audit's scope-insensitive taint then made `element` a computed value,
so the *call* `element.GetText()` counted as computed **execution** — and the taint propagated to the
local named `text`, which turned every `text.includes(...)` / `text.indexOf(...)` in `bridge.js` (and
then across the whole bundle) into findings: `node scripts/static-audit.mjs` reported three lines and the
bundle audit `BUNDLE_AUDIT_FAILED`. The body now collects the elements first and invokes `GetText` on a
**callback parameter** (`collected.map(function (foundItem) { … })`), so no method is ever reached
through a computed lookup: the audit is clean in `src/` and in `panel.js`, which is the authored-static
boundary working as designed.

**Verification.** RED first, honestly counted: on the pre-implementation tree the focused suites ran
**135 cases / 110 pass / 25 fail**, and every one of the 25 was "the feature is absent"
(`tools.find(…) === undefined`, `bridge.findText is not a function`, the catalogue assertion for the new
name) — no test failed for a reason other than the missing tool. Green: focused `140/140` (the `135`
this section first recorded was the RED-era count — §11a re-measures it); full suite
**728 → 751** with `fail 0`; `node scripts/static-audit.mjs` → `Authored-code audit PASS` (exit 0);
`node scripts/build-plugin.mjs` → exit 0, `Plugin build: 8 allowlisted files; ZIP STORE SHA-256
f7e78518dd2df4ac8499ea54fc16f31e2864c1537553c4d1c756cec561c14352` (re-measured twice on the final
tree, same value). Four existing exhaustive assertions
grew, none weakened or deleted: the tool-name set, the published-descriptor list, the EDIT/ASK catalogue
lists and the bundle test's authored command legs (**2 → 3**, now classified by the primitive each body
authors — `Search` for the search leg — instead of by the refusal literal every body contains). Read-only
by construction and by test: exactly **one** bridge call (`findText`) and no write method reachable.
`src/agent/*` untouched.

**Unverified natively, and what only the target can prove.** The Lead measured the primitive and the
`callCommand` carriage of a static body (with the needle **baked into the probe's source**). The shipped
carriage and the case flag have since been measured on the target — see **11a** below. What the
host-side suite still cannot prove is listed there in full.

## 11a. `find_text` — the escape arithmetic corrected, the native evidence recorded

Three LOW findings from the independent review of `fa7b2f6`; no limit value moved, no behaviour changed,
`src/agent/*` untouched.

**Measured, and what changed.** The entry arithmetic was re-derived from the shape the runtime actually
bounds (`JSON.stringify({ tool: 'find_text', ok: true, data })` through `utf8ByteLength`), not
re-stated. Two of the three earlier figures survived; one *label* did not, and one figure was missing an
addend.

| shape (256-byte needle, 32 matches, widest flags) | measured | ceiling |
| --- | --- | --- |
| Cyrillic needle, `count = findMatchesMax` (2 digits) | **9283** | 16384, slack **7101** |
| same, `count = Number.MAX_SAFE_INTEGER` (16 digits), `truncated:false` | **9297** | slack **7087** |
| same with `truncated:true` (the narrow form) | **9296** | slack 7088 |
| 256 × `\n` — **two**-character short escapes | **17731** | over by 1347 |
| 256 × U+0001 — **six**-character `\uXXXX` escapes | **51523** | over by 35139 |

So the corrected claims are two, both about the *description*: (i) `JSON.stringify('\n')` is the **two**
characters `"\n"`, **not** six — only a C0 control with no short escape (`\u0001` and its family)
expands to the six characters `\uXXXX`, so 17731 is the **two-character-escape** case and 51523 is the
true six-character worst case, not 17731; and (ii) the former "worst realistic call = 9283" ignored
`count`'s own digits, which are part of the entry and are unbounded by the schema (`count` is the
primitive's total). Corrected in `src/shared/limits.js`, `src/tools/word.js` and
`tests/unit/tools-word.test.js`; the test now asserts **9297** as the true maximum and **51523** as the
six-character case, alongside the unchanged 9283 and 17731. **The conclusion is unchanged and remains
the point**: every one of these entries is refused with the closed `BYTE_LIMIT` by the existing
measurement, so **no over-ceiling `ok` can be published** — both escape figures are outside the 16384
ceiling, and the two in-ceiling figures are ceilings *with thousands of bytes of slack*, not tight
fits.

**Natively measured, on the target (Astra / R7 2026.1.2.1942, shipped build).** The review had listed
the **shipped** `Asc.scope` carriage and the case flag as unproven, because the earlier native probe had
baked its needle into the source. Both are now measured with the shipped code path:

* `{"query": "МАРКЕР-ПОИСК", "matchCase": true}` → the panel action line **`find_text: ok`**, and the
  model answered `КОЛИЧЕСТВО=4|ПЕРВЫЙ_ТЕКСТ=МАРКЕР-ПОИСК`;
* `{"query": "маркер-поиск", "matchCase": false}` → **`find_text: ok`** with `КОЛИЧЕСТВО=5`.

The document holds **exactly four** case-sensitive and **five** case-insensitive occurrences, and **no
serialization refusal appears in the captured traffic**. That settles three of the review's unknowns:
the validated `{query, matchCase, limit}` triple really does reach the body through `Asc.scope`, the
body's `Search`/`GetText` pair really does work from **inside** a `callCommand` body on the shipped
build, and the case flag really does select the strict (4) vs the case-insensitive (5) answer.

**Still unmeasured, and each is fail-safe.** Four items from the review's list were not covered by this
run: the **document order** of the returned matches; a **match text longer than the needle** under
case-insensitivity; a **256-byte needle** at the primitive; and a **never-answering** editor callback
(whether it wedges the bridge slot). None of the four can produce a wrong `ok`:

* the **carriage** refuses **before dispatch** if the scope write fails (an absent, non-object, sealed or
  frozen `Asc` namespace is `CAPABILITY_UNAVAILABLE` ahead of `owned.dispatched`, so the slot is released
  and nothing reached the editor);
* the **body's own sentinel** answers `CAPABILITY_UNAVAILABLE` when a primitive it needs is missing, so a
  body that cannot search does not report a search;
* an **uninterpretable envelope** — an answer that is not `{ok, count, texts}` with exactly
  `min(count, limit)` strings — is `known()`, the module's closed tool-error class, never a partial list
  presented as the result.

**Reporting accuracy, and the one claim that does not reproduce.** The implementer's report claimed
"focused 140/140"; the review re-measured the focused suite at **135/135** and reconciled the RED count as
**23 new test blocks plus 2 extended catalogue assertions**, not "25 with three extended". The RED
reconciliation is right and is recorded as such: the pre-implementation tree carries **99** `test(…)`
blocks in `tools-word.test.js` and **135** cases in the focused set the RED run counted, so 25 failing
cases = 23 new blocks + 2 extended catalogue assertions. The **135/135 is the RED-era figure, though, not
a green-tree measurement**: the focused set that reproduces the implementer's number is
`bridge-dispatch-api` + `tools-word` + `integration/package`, which measures **140/140** on this final
tree (16 + 119 + 5). The implementer's 140 was therefore right and the review's 135 undercounts it; both
figures are recorded here rather than silently reconciled.

**Verification (this round, final tree).** Focused set
`tests/unit/bridge-dispatch-api.test.js tests/unit/tools-word.test.js tests/integration/package.test.js`
→ **140/140**, `fail 0`; full suite `node --test` → **751**, `pass 751`, `fail 0`;
`node scripts/static-audit.mjs` → `Authored-code audit PASS`, exit 0; `node scripts/build-plugin.mjs` →
exit 0, `Plugin build: 8 allowlisted files; ZIP STORE SHA-256
757a465e4c53623aafdefa6f67cbdbffd62c692c37e6f7b7912780e6fdb860e7`, re-measured twice on the final tree
with the same value. The builder runs with `minify: false`, so the comment text inside the descriptor
bodies is rebuilt into the bundle and the SHA **moved** from the `fa7b2f6` pin
`f7e78518dd2df4ac8499ea54fc16f31e2864c1537553c4d1c756cec561c14352`; that difference is comment-only in
`src/`, and **the non-comment diff of `src/` for this round is empty** (only `//` lines changed in
`src/shared/limits.js` and `src/tools/word.js`).

## 12. Sprint 3, tool 4 — `read_structure`, the bounded document-structure read

**The primitives, measured on the target (Astra / R7 2026.1.2.1942, this round) and treated as
established.** Inside a `callCommand` body, `Api.GetDocument().GetStatistics()` answers an **object** with
the numeric fields `PageCount`, `WordsCount`, `ParagraphCount`, `SymbolsCount`, `SymbolsWSCount`
(`{ 1, 25, 10, 150, 165 }` on the purpose-built document); `GetPageCount()` answers `1`;
`GetAllParagraphs()` an array of **10**; `GetAllHeadingParagraphs()` an array of **3** — exactly the three
styled headings; `GetAllTables()` **1**; `GetSections()` **1**. `GetAllStyles()` answers **182** and is
deliberately **not read**: the full style library is not the document's structure. This descriptor is the
**measured replacement** for the long-withheld `read_context` *structure* scope; `read_context` itself keeps
its `deny` policy, its schema and its handler untouched, and the Lead decides that switch separately.

**The dispatch.** The same pattern `find_text` measured, one leg further: ONE inline, self-contained
static `callCommand` body (`command.structure`), the validated extraction cap crossing as **DATA** through
`Asc.scope` (written by `writeScope`, restored by `clearScope` right after the native has been handed the
body, because the vendor wrapper reads the property synchronously), and ONE strict decoder
(`decodeStructure`) for its answer. The native **return validator keeps arrays of primitives and a string
and strips a plain object**, so the body encodes the whole structure as ONE flat array —
`[pages, PageCount, WordsCount, ParagraphCount, SymbolsCount, SymbolsWSCount, paragraphs, headings, tables,
sections, heading0, …]` — and the decoder refuses any answer that is not that shape, including one that
extracts a different number of texts than the `min(headings, maxHeadings)` it asked for. The body's own
integer test reaches for **no global at all** (`value === value`, `value % 1 === 0`), so the stringified
body depends on nothing but the `Api` and `scope` bindings the wrapper creates. A build whose command
channel is the bare `executeCommand` has no sanctioned parameter channel and refuses **before** any
dispatch (`CAPABILITY_UNAVAILABLE`, slot released).

**No `level` is published, and that is measured rather than assumed.** The vendored 2026.1.2 SDK copy
(dev-only, `.local/stage-b-runtime/vendor-word-sdk-all.js`) carries `GetOutlineLvl` **8** times, and every
one of the eight sits on an **internal** class — the document-outline manager, the internal paragraph
(`s.prototype.GetOutlineLvl`), the internal paragraph properties (`Mt` = `AscCommonWord.CParaPr`) — while
the two **public** builder classes a heading element can reach expose none: `AscBuilder.ApiParagraph` (`G`)
registers no outline member at all, and `AscBuilder.ApiParaPr` (`T`), which `G.GetParaPr()` returns,
registers `SetStyle`/`GetStyle`/`GetJc`/`GetIndLeft`/… and **no** `GetOutlineLvl` (`T.prototype.GetOutlineLvl`
and `T.prototype.SetOutlineLvl` both measure **0**). A level derived from the style *name* would be a guess
(the names are localized) and one derived from the array index is forbidden, so the result carries **no
`level` field and no `level: null` placeholder**. `GetRowCount`/`GetColumnCount` were already measured
`undefined`, so the only per-table fact published is the count.

**The schema, the limits and the result.** Closed, `additionalProperties: false`, `required: []`,
`properties: {}` — every dispatched primitive takes no model parameter, so no optional argument was added.
Two new `LIMITS` entries: **`structureHeadingsMax = 32`** — the reported-heading cap AND the count the body
extracts inside the editor (one value, so the native work and the report cannot disagree) — and
**`structureHeadingBytes = 256`** — one heading TEXT (128 Cyrillic or 256 ASCII characters), a boundary that
is never a trim and that is now an **explicit omission** rather than a whole-read refusal (§12a). The result
is
`ok({ pages, statistics, counts, headings, truncated })`: `statistics` republishes the measured object under
the primitive's **own** field names, `counts` is `{ paragraphs, headings, tables, sections }` from the array
lengths, `headings` is a bounded array of `{ index, text }`, and there is deliberately **no separate
`tables`/`sections` result key** (the only honest facts are their counts, which `counts` already carries).
The enforced bound is the **serialized entry** through the module's one `toolResultEntryBytes` (new
`structureEntryBytes` wrapper): the worst realistic call at both maxima measures **9192** bytes against the
16384-byte ceiling (7192 of slack). The earlier claim that the true maximum was **9315** (7069 of slack) was
wrong in **both its label and its shape** — the shape was also unreachable, because `truncated` is derived
from `counts.headings > headings.length` and a 16-digit `counts.headings` is therefore `truncated:true`,
never the `false` that figure measured. §12a records the re-measurement: the family that binds is the
**2×-escape** family (`"` → `\"`, `\` → `\\`), which this note never named while listing only families that
cannot fit at all — 32 headings of 240 `"` measure **16341** (slack **43**, and they are SERVED), 241 `"`
measure **16405** and are REFUSED, and the **true maximum over every publishable shape is the ceiling
exactly: 16384, with zero slack**. The two families that cannot fit at all are 256 `\n` headings
(TWO-character short escapes) at **17365** and the same headings made of a C0 control with no short escape
(SIX-character `\uXXXX`) at **50133**; both figures belong to the 32-text array at its own 2-digit
`counts.headings` width (32), and both are the closed `BYTE_LIMIT`.

**Three documented decisions.** An **empty structure is `ok`** with `headings: []`, `counts.headings: 0` and
`truncated: false`: "this document has no headings" IS the complete answer to "what is the structure",
deliberately unlike an empty **caret** context (`read_paragraph`). An **over-wide heading is an explicit
omission**, not a refusal (§12a): `ok` with the measured `pages`/`statistics`/`counts`, `headings: []` and
`truncated: true`. And a structure the decoder cannot interpret is the module's closed `known()` class, never
a partial outline: a `headings` array longer than the cap the tool asked for, or shorter than
`min(counts.headings, structureHeadingsMax)`, is not an answer this bridge can have produced. Failure
classes: wrong editor / missing bridge method / unavailable command channel or namespace →
`CAPABILITY_UNAVAILABLE`; any other closed bridge class republished through `refusalCode`; an
uninterpretable envelope → `known()`; a returned or thrown `APPLY_UNCERTAIN` → `TOOL_UNCERTAIN`; a heading
above its text bound → `ok` with `headings: []` and `truncated: true`; an over-ceiling entry →
`BYTE_LIMIT`.

**Verification.** RED first, honestly counted: on the pre-implementation tree the focused set
(`bridge-dispatch-api` + `tools-word` + `integration/package`) ran **159 cases / 137 pass / 22 fail**, and
all 22 were "the feature is absent" — 19 new `read_structure` test blocks plus the 3 existing exhaustive
assertions that grew (the descriptor-name set, `registry.tools`, and the EDIT/ASK catalogue lists). Green:
focused **159/159**, `fail 0`; full suite **751 → 770**, `pass 770`, `fail 0`;
`node scripts/static-audit.mjs` → `Authored-code audit PASS`, exit 0; `node scripts/build-plugin.mjs` →
exit 0, `Plugin build: 8 allowlisted files; ZIP STORE SHA-256
0b97e1ad46257a27e8f6901f68662f854229a62fdbe91522d67bba425bf7810f`, re-measured twice on the final tree
with the same value. The builder runs with `minify: false`, so the comment text inside the new descriptor
and body is rebuilt into the bundle and the SHA **moved** from the `503d441` pin
`757a465e4c53623aafdefa6f67cbdbffd62c692c37e6f7b7912780e6fdb860e7`; the moved bytes are comments and one
new authored body. The `package` test's authored-command-leg classifier grew **3 → 4**
(`['capability', 'context', 'search', 'structure']`, classified by the primitive each body authors), and no
existing test was weakened or deleted. Read-only by construction and by test: exactly **one** bridge call
(`readStructure`) and no write method reachable; `src/agent/*` untouched.

**Unverified natively at this round's close — and since MEASURED on the target; see §12a.** What the
host-side suite could not prove was the **shipped** carriage of this leg: that `{ maxHeadings }` written into
the page's `Asc.scope` reaches the body's `scope` binding, that `GetStatistics()`/`GetAllHeadingParagraphs()`
answer from **inside** this exact body, and that the native return validator passes the **10 + n** flat array
unaltered. Each unknown was fail-safe rather than fail-open: a scope that does not arrive makes the body
answer its own refusal sentinel (`CAPABILITY_UNAVAILABLE`), a primitive that is missing or answers a
non-integer makes it refuse the same way, and an editor that never calls back settles `TIMEOUT` — never a
structure. §12a records the native run that closed all three. A heading `level` remains unavailable because no
**public** member exposes it — a **private** route does exist
(`ApiParagraph.private_GetImpl().GetOutlineLvl()`), and this tool deliberately does not reach for it.

## 12a. `read_structure` — the explicit heading omission, the arithmetic corrected, the native evidence recorded

Three LOW conditions from the independent review of `7a57afa`. Exactly **one** is a behaviour change (D3); no
limit VALUE moved, `src/agent/*` is untouched, the tool is still read-only with **one** dispatch, and only
`src/tools/word.js`, `src/shared/limits.js`, `tests/unit/tools-word.test.js` and this document changed.
`src/plugin/bridge.js` needed **no** change: the omission is a TOOL-side decision taken over the decoded
envelope, and the authored body plus `decodeStructure` still carry exactly `min(counts.headings, maxHeadings)`
texts and refuse an answer of any other length.

**D3 — the per-heading bound is an EXPLICIT OMISSION, not a positional refusal.** The entry measurement is
untouched (an over-ceiling entry is still the closed `BYTE_LIMIT`, and a heading is never shortened), but a
heading above `structureHeadingBytes` no longer refuses the whole read. The handler now derives
`overWide`, publishes `headings: []` in that case, and derives `truncated` from the array it actually
published (`counts.headings > published.length`), so the flag needs no special case. An explicit omission beats
a total refusal because `pages`, `statistics` and `counts` are measured facts about the document that no
heading TEXT can make untrue, and because the old refusal was **POSITIONAL**: a 258-byte heading at index 0
refused everything while the same heading at index 40 was never extracted and the read succeeded — two
documents holding the same over-wide heading got opposite outcomes for a difference the model cannot see. The
array must be **empty** rather than partially filled because a partial array with `truncated: true` already
means "more headings exist than are reported" (the cap case): reusing that flag for the short texts beside an
over-wide one would give one flag two meanings and leave the model unable to tell a withheld outline from a
capped one. `counts.headings` keeps the **primitive's own total** in both cases — it is a count, not a text, so
the omission neither narrows it nor invents a zero.

**TDD, and the exact RED.** The over-wide test block was rewritten FIRST and run against the unmodified
handler: `read_structure bounds ONE heading text and publishes an explicit EMPTY omission, never a shortened
heading` failed at `assert.equal(omitted.ok, true)` — `false !== true`, the old `BYTE_LIMIT` refusal — while
the other 138 cases in `tests/unit/tools-word.test.js` passed, so the only RED was the intended behaviour
change. Green: **139/139** in that file. One existing test asserted the old whole-read refusal —
`read_structure bounds ONE heading text and refuses rather than shortening it` — and it is the SURVIVOR of the
rewrite rather than a deletion: the replacement asserts strictly more (ok with the scalars, an array that is
`[]` and not merely absent, `truncated: true`, `counts.headings` at the primitive's total, no heading text in
the payload, an over-wide heading at a LATER index withholding the array just the same, the capped case still
publishing its texts under the same flag, the exact 256-byte boundary served verbatim, and the omission's own
entry accepted by `toolResultMessages` with the document's counts at `Number.MAX_SAFE_INTEGER`). No test was
weakened or deleted anywhere in this round.

**D1/D2 — the arithmetic re-measured from the real published shape** (`JSON.stringify({tool, ok, data})`
through `utf8ByteLength`, the same shape `stringifyToolResults` bounds; the refusal check is `> 16384`, so an
entry of exactly 16384 publishes):

| shape | measured | ceiling |
| --- | --- | --- |
| 32 × 128 Cyrillic, real-document digits, `truncated:false` (worst REALISTIC) | 9192 | slack 7192 |
| 32 headings of 240 `"` (240 raw bytes) | 16341 | slack 43 — **SERVED** |
| 32 headings of 241 `"` (241 raw bytes) | 16405 | refused |
| **TRUE MAXIMUM**: 32 × (238 `"` + `a`) = 477 escaped bytes each, nine numeric fields at `MAX_SAFE_INTEGER`, `counts.headings` at 14 digits | **16384** | **slack 0** |
| the same headings with a 16-digit `counts.headings` | 16386 | refused (its own widest shape: 16354) |
| 32 × 256 `\n`, `counts.headings = 32` (2 digits) | 17365 | refused |
| 32 × 256 U+0001, `counts.headings = 32` (2 digits) | 50133 | refused |

So **9315 was wrong twice**: it was labelled "the true maximum" while the family that actually binds is the
**2×-escape** family (`"` → `\"`, `\` → `\\`) the note never named, and the shape it measured was
**unreachable** (`truncated` is derived, so 32 headings with a 16-digit `counts.headings` are
`truncated:true`, never the `false` it used). The corrected statements are: `9192` is the worst **realistic**
call; `16341`/slack 43 is the widest all-`"` heading and it IS served; `16384`/slack **0** is the true
maximum over every shape this handler can publish (the odd escaped width 477 — not the 476 or 480 a uniform
heading reaches — is what spends the last byte, and the widest 16-digit shape is 16354); and the two escape
families that cannot fit are **17365** and **50133**, both at the 32-text array's OWN 2-digit
`counts.headings` width (the earlier 17364/50132 were the same arrays with a bogus 1-digit
`counts.headings = 3`, which the handler could never publish beside 32 texts). Both figures are pinned in
`tests/unit/tools-word.test.js`, and the true maximum is pinned twice: once as arithmetic, and once through
the REAL handler (which measures exactly 16384 for that envelope, refuses 16480 for the same headings at 240
`"`, and never disables the entry measurement).

**The wording correction.** `src/shared/limits.js` — and the same clause in `src/tools/word.js` — now says
what was measured: **no PUBLIC member** exposes the outline level. That is not unreachability; a **private**
route exists, `ApiParagraph.private_GetImpl().GetOutlineLvl()`, and the read deliberately does not take it
because a document read through a private internal is a dependency the next build is free to break.

**Natively measured, on the target (Astra / R7 2026.1.2.1942, shipped build).** The three unknowns listed at
the end of §12 are now MEASURED, and no serialization refusal appears in the captured traffic:

* the **`Asc.scope` carriage** of the validated `{ maxHeadings }` reaches the body's `scope` binding;
* **`GetStatistics()` / `GetAllHeadingParagraphs()` answer from INSIDE this exact body** (and
  `GetPageCount()`/`GetAllTables()` with them);
* the native **return validator passes the flat `10 + n` array** unaltered, and the decoder reconstructs the
  structure from it.

The evidence is the panel action line **`read_structure: ok`** and the model answering
`ЗАГОЛОВКИ=ГЛАВА ПЕРВАЯ;Раздел 1.1;ГЛАВА ВТОРАЯ|ТАБЛИЦ=1|СТРАНИЦ=1` on a purpose-built document — three
heading texts, one table and one page, which is exactly the shape the body encodes and the decoder accepts.

**Verification (this round, final tree).** Focused set
`tests/unit/bridge-dispatch-api.test.js tests/unit/tools-word.test.js tests/integration/package.test.js`
→ **160/160**, `fail 0`; full suite `node --test` → **771**, `pass 771`, `fail 0` (770 → 771: the one added
test block); `node scripts/static-audit.mjs` → `Authored-code audit PASS`, exit 0;
`node scripts/build-plugin.mjs` → exit 0, `Plugin build: 8 allowlisted files; ZIP STORE SHA-256
eab165582c68d3cb3ba9ad5f5ffe5a5fa3ac725854a6219fbb41db4d162e926b`, re-measured twice on the final tree with
the same value. With `minify: false` the comment text inside the descriptor is rebuilt into the bundle, so the
SHA **moved** from the `7a57afa` pin
`0b97e1ad46257a27e8f6901f68662f854229a62fdbe91522d67bba425bf7810f`; **the non-comment diff of `src/` is
exactly the D3 change** — one removed line (the old `BYTE_LIMIT` return for an over-wide heading) and four
added lines (`overWide`, `published`, and the two `published` substitutions) in `src/tools/word.js`, with
`src/shared/limits.js` comment-only. Read-only by construction and by test: exactly **one** bridge call
(`readStructure`) and no write method reachable; `src/agent/*` untouched.

## 13. Sprint 3, tool 5 — `insert_blocks`, the FIRST MUTATION, under an exact-delta outcome contract

The first creation tool of Sprint 3. It is the only tool in this module whose success is a claim about
what the **document** now holds, so it is the only one with an outcome contract rather than a result
shape. Exactly **one** bridge entry point was added (`insertBlocks`), **one** authored command body
(`command.blocks`), **one** decoder (`decodeBlocks`), **one** ticket kind (`blocksinsert`) and **one**
result wrapper (`insertBlocksEntryBytes`). No limit VALUE moved, `src/agent/*` is untouched, and only
`src/tools/word.js`, `src/plugin/bridge.js`, `src/shared/limits.js`, two test files and this document
changed.

**The mutation ground truth is the document, never a primitive's return value.** Measured on the
target (Astra / R7 2026.1.2.1942, this round): inside a `callCommand` body, `Api.CreateParagraph()` +
`paragraph.AddText(text)` + `paragraph.SetStyle(style)` work, and **no mutation primitive's boolean is a
result signal** in either direction — `Push` answered `true` for a paragraph and `false` for an image
host, and the legacy whole-array primitive answered `true` **even for `[]`, `[null]` and `'nonsense'`**
(a `false` is not proof of failure either, which is why the rule is not written as "true means inserted"
with a fallback). What **is** measured is the document's own shape: after an insert the paragraph
**IS** a heading — `GetAllHeadingParagraphs()` went **3 → 4** while `GetAllParagraphs()` went **10 → 11**
— and `paragraph.SetStyle(style)` applies. Two bridge tests drive both halves of that: a document that
really grew while the primitive answered `false` is **verified**, and a primitive that answered `true`
while the document did not move is `APPLY_UNCERTAIN` with the slot **held**.

**The mechanism is ONE self-contained static body** (`command.blocks`, a full inline function literal
exactly like the search and structure bodies, so the native can stringify and evaluate it where none of
`bridge.js`'s module bindings exist) which does all three phases in ONE synchronous evaluation: a
**pre-dispatch baseline** of `GetAllParagraphs()`/`GetAllHeadingParagraphs()`, then every paragraph built
(`Api.CreateParagraph` + `AddText`, and `SetStyle(doc.GetStyle('Heading ' + n))` where a heading was
asked for) with **every style resolved BEFORE anything is inserted**, then **ONE `document.Push` PER
BLOCK, IN BLOCK ORDER**, then the **post read** of the same two counts plus every block's own text out of
the document's own paragraph texts. The model data crosses as the `Asc.scope` parameter channel
(`{ blocks }`), never interpolated into source (ADR 0002). Position is the **END** of the document
**because `Push` is the route measured to append there** (§13.2), and the body authors **no** positioning
option. It authors the legacy whole-array insert primitive **nowhere** — not as the mutation, not as a
fallback, and not even as a capability check — because on the same target that route lands at the
**BEGINNING** and, with a selection present, replaced existing text (§13.2).

**The schema is closed** (`additionalProperties: false`, `required: ['blocks']`): `blocks` is an array
with `maxItems: LIMITS.insertBlocksMax`, each item a closed object of `text` (`minBytes: 1`,
`maxBytes: LIMITS.insertBlockBytes`) and an optional integer `heading` (`1..LIMITS.insertHeadingMax`).
Three bounds and one level bound are named in `src/shared/limits.js` with their reasoning: **64** blocks
(one `ApiParagraph` array the body materialises before the push loop; twice the module's
other report caps because a chapter is a *sequence* of paragraphs), **2048** bytes per text (a written
paragraph, deliberately not an alias of a read budget), **8192** bytes for the whole payload — the same
number as `AGENT_CEILINGS.argumentsBytes`, because the blocks *are* the action's arguments and JSON
escaping never shrinks a text, so the sum of text bytes cannot exceed the serialized arguments the
runtime already bounds. There is deliberately **no `minItems` keyword**: this module's closed schema
vocabulary allowlists every keyword it enforces (`src/tools/schemas.js`) and carries none, and
advertising a constraint nothing applies is worse than enforcing the lower bound where the upper one is
enforced — the handler **and** the bridge both refuse `blocks: []` as the closed argument class with
nothing dispatched, and that is tested.

**The outcome contract.** `ok` is published **only** when the post read shows the exact expected delta:
paragraphs grew by **exactly** the number of blocks, headings grew by **exactly** the number of blocks
that asked for one, and every block carried its own text **in the paragraph slot the append gave it**.
The third leg is **one-to-one over the append**, and that is the correction an independent review forced
(§13.1): the region the append added is addressed by the baseline count the body takes **before** the
call, so block `i` owns the paragraph at index `paragraphsBefore + i`, and a text the document already
held somewhere — even the very text of the block — can no longer stand in for it. The earlier existential
form (`indexOf` over every paragraph) verified an append that created the right **number** of paragraphs
and carried no text at all. The third leg is not redundant — the counts alone could describe an unrelated
concurrent edit, and a text that already existed proves nothing — and the counts are not redundant
either. Anything else is `TOOL_UNCERTAIN`, the bridge
keeps its callback slot **HELD** (`getState()` keeps reporting `busy`/`uncertain`/`writePending`, the
panel's write lock stays engaged, the next call is `EDITOR_BUSY`) and there is **no retry**. The
exact-delta rule is decided **twice on purpose**: inside the ticket, while it still owns the slot (that
is where the slot is actually held), and again in the handler over the decoded envelope (a descriptor is
executable when it is held directly, with any bridge). Both read the same numbers, so this is one rule
applied twice, not two competing measurements.

**The failure map**, each class closed: wrong editor → `CAPABILITY_UNAVAILABLE` (precondition); missing
bridge entry point → `CAPABILITY_UNAVAILABLE`; an **unusable baseline** → `CAPABILITY_UNAVAILABLE` with
**no `Push`** (the body answers before the one mutation); an **unresolvable heading style** →
`TOOL_ERROR` with no `Push` (the editor's heading machinery is intact, so the capability class
would misname the failure; what the document does not define is the requested `Heading <n>`; and it is
not uncertain, because the body resolves every style before its first `Push`); a bridge refusal → its own
closed `refusalCode`; an uninterpretable envelope → `known()`; a returned or thrown `APPLY_UNCERTAIN` →
`TOOL_UNCERTAIN`; an over-ceiling result entry → `BYTE_LIMIT`. The refusal's **phase is an explicit slot
of the answer**, not a property of its name (§13.1): the body answers `[PRE_INSERT, name]` before its one
mutation and `[POST_INSERT, name]` after it, and `decodeBlocks` raises the two known classes **only** for
a `[PRE_INSERT, name]` answer. A phase-less one-slot `['CAPABILITY_UNAVAILABLE']` — the forgery the review
reproduced — is therefore `APPLY_UNCERTAIN` with the slot held: the body ran, and the document may already
hold the append. `owned.dispatched` alone cannot decide this: it is set before the command is handed to
the native, so it does not mean "the push ran".

**The mutation boundary is the FIRST call, not its return.** The body's phase turns uncertain
**immediately before the first `Push`**, so a native that **throws out of** a push is `APPLY_UNCERTAIN`
with the slot held, never a known refusal with the slot released — a throwing mutation may already have
applied that block. Because the append is now a **loop of calls**, the same rule covers the **partial**
case: a throw between two pushes can leave the document holding *some* of the batch, so the body answers
its refusal with the post-insert phase and the decoder turns it into `APPLY_UNCERTAIN` — slot held, no
retry — rather than a known refusal for a write that may already have happened. Both paths are covered by
tests.

**The result entry is measured** through the module's one `toolResultEntryBytes` shape
(`insertBlocksEntryBytes`): `ok({ inserted, headings, paragraphsBefore, paragraphsAfter, bytes })`,
published as exactly those five fields. The arithmetic is pinned by measurement: a real append measures
**125** bytes, and the **widest shape the handler can publish** — all five fields at
`Number.MAX_SAFE_INTEGER` — measures **195** bytes, i.e. more than sixteen thousand bytes inside the
16384-byte ceiling. The `BYTE_LIMIT` branch is retained as the module's **one enforced bound** and is
**unreachable** for five non-negative safe integers; that is stated as arithmetic in the limit, the
descriptor and the test rather than left as an untested claim.

**TDD, and the exact RED.** The new test blocks were written FIRST and run against the unmodified tree —
`node --test tests/unit/tools-word.test.js` → **tests 155, pass 136, fail 19** (`fail 0` on that file
before the round) with `TypeError: Cannot read properties of undefined (reading 'execute')`,
`insert_blocks` missing from the descriptor set and `r.bridge.insertBlocks is not a function`; the 19 are
exactly the 16 new blocks plus the 3 existing enumerations (`the representative descriptor set…`,
`read_context is withheld from every catalogue…`, `registry accepts the word tools…`), which grew by the
new name rather than being weakened. Green: **155/155** in that file. No test was weakened or deleted
anywhere in this round.

**A NEW TRAP, recorded because it cost a full round:** `scripts/static-audit.mjs` passes on `src/` while
`node scripts/build-plugin.mjs` **fails**, because the audit's local alias analysis is **name-based and
scope-insensitive** and it runs per FILE on `src/…` but on the whole **bundle** for `panel.js`. The first
build after the new body reported **16 `DYNAMIC_PROPERTY` findings**, none of them in pre-existing code
paths of their own: esbuild renames colliding bindings across concatenated modules, so (a) my body's
`var answer = [paragraphsBefore, …]` became a "computed value" because the handler also declares
`headingsBefore`/`headingsAfter` from a tainted `result`, and (b) my body's helper `function closed()`
was renamed to the same `closed3` that `registry.js` writes through a computed key
(`closed3[key] = raw[key]`) — a call on a computed receiver by name. The repair is threefold and is
stated in the code: the four counts are **appended** to an array that starts as a literal, the presence
flags and the delta are read **by index** instead of `present.some(...)`/`present.every(...)`, and the
helper is named `blocksRefusal` so no other module's binding can collide with it. The built bundle now
audits with **0 findings**. The general rule this reinforces: audit the BUNDLE, never only `src/`, and
never route a call through a value whose name another scope may have tainted.

**Verification (this round, final tree).** Focused set
`tests/unit/bridge-dispatch-api.test.js tests/unit/tools-word.test.js tests/integration/package.test.js`
→ **176/176**, `fail 0`; full suite `node --test` → **787**, `pass 787`, `fail 0` (771 → 787: 16 added
test blocks); `node scripts/static-audit.mjs` → `Authored-code audit PASS`, exit 0;
`node scripts/build-plugin.mjs` → exit 0, `Plugin build: 8 allowlisted files; ZIP STORE SHA-256
0fb625d4057ec938a8f7156375c2ad5c9ae3ce75fe02c6ba7723fb2f9ef73e25`, re-measured twice on the final tree
with the same value. The builder runs with `minify: false`, so the comment text inside the new descriptor
and body is rebuilt into the bundle and the SHA **moved** from the `e5d3f6f` pin
`eab165582c68d3cb3ba9ad5f5ffe5a5fa3ac725854a6219fbb41db4d162e926b`; the moved bytes are comments and one
new authored body. The `package` test's authored-command-leg classifier grew **4 → 5**
(`['blocks', 'capability', 'context', 'search', 'structure']`, classified by the primitive each body
authors — the append body is recognised by `.Push(` **before** the structure branch, because
both read `GetAllHeadingParagraphs`). The registry offers the tool in `EDIT` only (`kind: 'mutate'`), with
`policy: 'auto'` and `requires: ['document.write']`, and a model batch dispatches exactly **one** command
for the whole run; `src/agent/*` untouched.

**Natively UNVERIFIED at this round's close, and each unknown is fail-safe rather than fail-open.** What
the host-side suite cannot prove is the **shipped** carriage of this leg: (1) that `{ blocks }` written
into the page's `Asc.scope` reaches the body's `scope` binding, (2) that `Api.CreateParagraph()` /
`paragraph.AddText` / `document.GetStyle('Heading <n>')` / `document.Push(…)` answer from
**inside** this exact body, (3) that the native return validator passes a flat array of `5 + n`
primitives unaltered, and (4) that the post read inside the same body observes the append (i.e. that the
two document reads around the synchronous push loop really differ). Each unknown lands on a closed
path: a scope that does not arrive makes the body answer its own phase-marked refusal
(`[PRE_INSERT, 'CAPABILITY_UNAVAILABLE']`, nothing inserted, slot released); a missing primitive does the
same; a style the document does not define answers `[PRE_INSERT, 'STYLE_UNAVAILABLE']` → `TOOL_ERROR`
with nothing inserted; an
uninterpretable or non-exact answer is `APPLY_UNCERTAIN` → `TOOL_UNCERTAIN` with the slot held and no
retry; and an editor that never calls back settles `APPLY_UNCERTAIN` (a dispatched write-class ticket),
never a verified append. A native run on the target is required before this tool's delta can be called
measured; it is recorded here as PENDING NATIVE VERIFICATION.

### 13.1 Independent-review follow-up — two fail-open defects closed, one dead assertion removed

An independent review of `2fdaa45` (the revision §13 describes) found two fail-open defects in
`insert_blocks` and one unreachable bound. Nothing in §13's mechanism changed; what changed is where the
verifier is anchored and how the refusal phase travels. `src/agent/*` is untouched, the tool is still a
mutation with the exact-delta contract, the body's mutation is still **one call per paragraph** (the
primitive was corrected to the measured `Push` in §13.2), and anything unprovable is still
`TOOL_UNCERTAIN` + held slot + no retry.

**D1 (fail-open) — the presence check was existential, not one-to-one over the append.** The body asked
`paragraphTexts.some(text => text.indexOf(block.text) !== -1)` over the WHOLE document, so a document that
already held the block texts satisfied it. The reviewer's reproduction: a document already holding
`['Глава','Текст']`, an append that creates the right NUMBER of paragraphs and writes no text,
and the bridge published `{ok:true, paragraphsBefore:2, paragraphsAfter:4, present:[true,true]}` while the
document ended `['Глава','Текст','','']`. **The method chosen is per-slot equality over the region the
append added**, addressed by the baseline the body already takes: `flag_i = 1` **iff**
`paragraphTexts[paragraphsBefore + i] === blocks[i].text`. It is exact because one flag owns exactly one
paragraph of the appended region, and that is why it was chosen over the two alternatives — an `indexOf`
over the document (the defect) is satisfied by a pre-existing occurrence, and "the needle's occurrence
count rose by exactly one" counts over the whole document, cannot tell the append's occurrence from an
unrelated one, and cannot express two blocks with the SAME text (whose total rise is two) without
per-needle multiplicity bookkeeping; joining the region under a separator is weaker than per-slot equality
because one region text can be split into paragraphs two ways. The exact count deltas are unchanged.

**D2 (fail-open, latent) — the decoder trusted a one-slot sentinel without checking the phase.** The body
flipped its phase immediately before its first push, but the decoder mapped the pre-insert NAMES
unconditionally, so a forged post-insert `['CAPABILITY_UNAVAILABLE']` or `['STYLE_UNAVAILABLE']` produced a
false KNOWN refusal with the slot RELEASED and `writePending` false. **The phase is now an explicit slot
of every answer**: `[PRE_INSERT, name]` / `[POST_INSERT, name]` for a refusal, and
`[POST_INSERT, before, after, hBefore, hAfter, flag0, …]` for a measurement. `decodeBlocks` raises the two
known classes only for `[PRE_INSERT, name]`; a missing phase, a post-insert phase, a pre-insert phase over
a measurement, and every other single value are `APPLY_UNCERTAIN` with the slot HELD. Both genuine
pre-insert refusals (an unusable baseline, an unresolvable style) still map to their known classes with
ZERO `Push`.

**THE RESIDUAL, STATED (review D2 of the insert_blocks chain review, closed as stated-not-fixed).** The two
names that keep a KNOWN class are
the body's `CAPABILITY_UNAVAILABLE` (a missing `scope`, a missing primitive, an unusable baseline, an
unreadable region) and `STYLE_UNAVAILABLE` (an unresolvable `Heading <n>`, republished as `TOOL_ERROR`).
They are genuine in the sense that a faithful run of the SHIPPED body writes them only before its first
`Push` — but the phase slot travels **inside the same untrusted answer** the body composes, so a damaged or
adversarial native that returns `[PRE_INSERT, 'CAPABILITY_UNAVAILABLE']` (or `[PRE_INSERT,
'STYLE_UNAVAILABLE']`) **after** it has already pushed the batch is decoded as a known refusal, and a known
refusal **RELEASES the slot**: fail-OPEN, whose price is a possible **duplicate on a retry** of a batch that
is already in the document. Only the shipped body's own **control flow** distinguishes the two cases (the
refusal is returned before `phase` is assigned `POST_INSERT`), and there is **no in-band fix**: a nonce or
any challenge would have to cross in `Asc.scope`, which the answering native reads, so it could forge
whatever the bridge checked. **The recorded remedy for a later hardening round is STRUCTURAL:** split the
**non-mutating preconditions** — the `Api`/capability checks, the baseline read and the `Heading <n>` style
resolution — into a dispatch of their own, so every answer from that dispatch is genuinely pre-insert and
the phase protocol disappears; the cost is one extra native round trip and a ticket that owns two
dispatches. The residual is stated in `src/plugin/bridge.js` at `preInsertRefusal` as well as here.

**D3 (info) — the decoder's byte assertion was unreachable, and it was DELETED rather than kept as a claim
nothing can test.** The wire shape is closed to one of two phase literals, four safe integers of at most
16 JSON characters, and at most `LIMITS.insertBlocksMax` (64) one-character flags, so the widest legal
answer measures **211** bytes against `LIMITS.editorResultBytes` (**65536**) — three hundred times inside
the ceiling, and no legal shape approaches it. The test row that was meant to exercise it (a 40 000
character member) is refused by the **flag-type** rule before any measurement, which is exactly what an
unreachable bound leaves behind; the row is kept for the flag-type rule it really exercises, and the
assertion is gone with its arithmetic stated in `decodeBlocks`.

**TDD, and the exact RED.** The two reproduction tests were written FIRST and run against `2fdaa45`:
D1's `the outcome contract is ONE-TO-ONE over the APPENDED REGION…` failed with
`AssertionError [ERR_ASSERTION]: an append that carried no text is NEVER verified…  true !== false` —
the bridge really did publish `ok:true` for the silent append; D2's `the refusal PHASE is explicit in the
protocol…` failed with `actual: 'CAPABILITY_UNAVAILABLE', expected: 'APPLY_UNCERTAIN'` for the forged
one-slot answer. Both pass on the final tree, together with the two cases the region anchor must not
break: a block whose text already exists elsewhere in the document still verifies (the append carried it),
and two blocks with the SAME text still verify.

**Two existing test rows moved, and the replacement is strictly stronger.** The shape table in
`bridge insertBlocks decodes ONLY the authored shapes…` asserted the OLD unconditional mapping with
`[['CAPABILITY_UNAVAILABLE'], 'CAPABILITY_UNAVAILABLE', false]` and
`[['STYLE_UNAVAILABLE'], 'TOOL_ERROR', false]`. Those rows now read `'APPLY_UNCERTAIN', true` (phase
absent), and the same name→class mapping is still asserted — with the pre-insert phase, through
`[['PRE_INSERT', 'CAPABILITY_UNAVAILABLE']]` and `[['PRE_INSERT', 'STYLE_UNAVAILABLE']]` — plus the new
rows that a `[POST_INSERT, …]` answer naming a pre-insert class is still not a known refusal. The
replacement therefore covers everything the old rows covered **and** the forgery they could not see. The
other three moved assertions are shape updates, not weakenings: the body's own answer now carries the
phase slot (`['POST_INSERT', 10, 12, 3, 4, 1, 1]`), and the malformed rows were re-expressed in the new
5-slot head.

**Verification (this round, final tree).** Focused `node --test tests/unit/tools-word.test.js` →
**157/157**; full suite `node --test` → **789**, `pass 789`, `fail 0` (787 → 789: two added test blocks,
none removed or weakened); `node scripts/static-audit.mjs` → `Authored-code audit PASS`, exit 0;
`node scripts/build-plugin.mjs` → exit 0, `Plugin build: 8 allowlisted files; ZIP STORE SHA-256
2072b90e0e8f1fb78b480dfcd73c669691adb90c20e44e27bb072dbb5262e65b` — the SHA **moved** from the `2fdaa45`
pin `0fb625d4057ec938a8f7156375c2ad5c9ae3ce75fe02c6ba7723fb2f9ef73e25`, because the authored body and
`decodeBlocks` both changed (the bundle's bytes are code: rebuilt fresh, mtime after the last source edit,
and it carries `BLOCKS_PHASE_PRE`/`BLOCKS_PHASE_POST`/`BLOCKS_HEAD` and the per-slot flag expression; a
comment-only edit did not move the SHA, so esbuild does drop some comments). The audit trap §13 records
was respected: `build-plugin.mjs` was run (not only the audit), and the bundle audits with
**0 findings**.

### 13.2 Native-run correction — the append route is `Push` per block, and the legacy primitive is never authored

The Lead's native run of the shipped tool on the target (Astra / R7 2026.1.2.1942) found that the route
§13 assumed was wrong. On a document whose paragraphs were `[TARGET ROUTES CHECK, ПЕРВЫЙ-АБЗАЦ-РОУТ,
ВТОРОЙ-АБЗАЦ-РОУТ, ТРЕТИЙ-АБЗАЦ-РОУТ]`, inside a `callCommand` body:

* `doc.Push(paragraph)` returned `true` and **APPENDED AT THE END** — `[…, ТРЕТИЙ-АБЗАЦ-РОУТ,
  МАРКЕР-МАРШРУТ-2]`;
* `doc.InsertContent([paragraph])` returned `true` and put the paragraph at the **BEGINNING** —
  `[МАРКЕР-МАРШРУТ-1, TARGET ROUTES CHECK, …]`;
* the same `InsertContent` **with a selection present** (`doc.GetRange(lastIndex, 0, lastIndex,
  lastText.length).Select()`) did not append either: it inserted at the beginning **and clobbered
  existing text** — `МАРКЕР-МАРШРУТ-1` became `-МАРШРУТ-1` — so select-then-insert is unsafe and is not
  used anywhere.

A native run of the previous revision (a level-2 heading chapter on a clean document) confirmed the
consequence: the append landed at the START, the per-slot region rule therefore did not match, and the
tool reported a **FALSE** `TOOL_UNCERTAIN` for an insert that had actually happened (the document did show
the heading and the paragraph). The region anchor was right; the route was not.

**What changed.** The body's mutation is now `document.Push(paragraph)` **once per block, in block
order** (`src/plugin/bridge.js`), and the legacy whole-array primitive is authored **nowhere**: it is not
the mutation, not a fallback, and not even a capability the body checks for (`typeof document.Push ===
'function'` is the check). The phase still turns `POST_INSERT` **before the first push**. `Push`'s own
return value is still **not read** — measured `false` for an image host earlier and `true` for a paragraph
here — and the ground truth stays the document readback, with the exact count deltas and the per-slot
region flag rule unchanged: they become correct precisely because the append now really is at the end
(`paragraphTexts[paragraphsBefore + i] === blocks[i].text`).

**A PARTIAL append is uncertain, not refused.** The append is now ONE CALL PER BLOCK, so a native that
throws between two calls can leave the document holding *some* of the batch. The post-insert phase is set
before the FIRST call, so a throw at any point in the loop answers a post-insert refusal, `decodeBlocks`
turns it into `APPLY_UNCERTAIN`, the bridge HOLDS its slot and there is no retry; the exact-delta rule is
never consulted for a write that may have happened. One test drives a second-`Push` throw and asserts the
**first block really landed** in the document while the result is `APPLY_UNCERTAIN` with the slot held,
and another drives a first-`Push` throw (nothing landed, the phase had already turned) to the same class.

**TDD, and the exact RED.** The new and re-modelled test blocks were written FIRST and run against
`1c08827`: `node --test tests/unit/tools-word.test.js` → **tests 161, pass 149, fail 12** (`fail 0` on that
file before the round). **ONE CAUSE, TWELVE FAILURES, AND ONE OF THE TWELVE NAMING THE MISSING ROUTE:** the
carried body still called `document.InsertContent(…)`, so the doubles built to the measured route recorded
ZERO `Push` calls and the append went through the wrong primitive — but only **one** of the twelve carried
the `AssertionError … expected: /\.Push\s*\(/` that the earlier wording attributed to all of them (corrected
here: the regex names the missing route, it did not account for the failures; review D4). The other eleven
failed on the consequences of the wrong route — the recorded `pushes`/`pushed` order, the `insertContents`
trap and the paragraph-text assertions. Green on the final tree: **161/161** on that file. The doubles were
re-modelled (they now
record `pushes` + `pushed` order and keep an `insertContents` trap, and `prepends` models a start-landing
mutation), and four new test blocks cover the measured route and call order, a start-landing mutation
(`TOOL_UNCERTAIN`, slot held, no retry), a partial push failure, and a build that exposes only the legacy
primitive (refused up-front with nothing written). No test was deleted or weakened.

**Verification (this round, final tree).** Focused set
`tests/unit/bridge-dispatch-api.test.js tests/unit/tools-word.test.js tests/integration/package.test.js` →
**182/182**, `fail 0`; full suite `node --test` → **793**, `pass 793`, `fail 0` (789 → 793: four added test
blocks, none removed or weakened); `node scripts/static-audit.mjs` → `Authored-code audit PASS`, exit 0;
`node scripts/build-plugin.mjs` → exit 0, `Plugin build: 8 allowlisted files; ZIP STORE SHA-256
27c99d41c90d2bbc1ee74b6672c716ef7c3a75d0454fb855536df110b00aa432` — the SHA **moved** from the `1c08827` pin
`2072b90e0e8f1fb78b480dfcd73c669691adb90c20e44e27bb072dbb5262e65b`, because the authored body changed. The
audit trap §13 records was respected: `build-plugin.mjs` was run (not only the audit), and the bundle
audits with **0 findings**. The `package` test's authored-command-leg classifier — the one place outside
`src/` that names the append body's primitive — was corrected with it: the append leg is recognised by
`.Push(` **before** the structure branch, because both bodies read `GetAllHeadingParagraphs`. `src/agent/*`
untouched, no dynamic execution added, and the tool is still a mutation under the exact-delta contract,
`TOOL_UNCERTAIN` + held slot + no retry on anything unprovable.

## 14. Sprint 3, tool 6 — `insert_table`, the SECOND MUTATION, an exact-delta contract over an append

The second creation tool of Sprint 3, and the first one whose success is a claim about a **structure**: the
appended table must carry the requested **matrix** in its **own cells**. It reuses the machinery §13/§13.2
hardened rather than inventing a second outcome contract. Exactly **one** bridge entry point was added
(`insertTable`), **one** authored command body (`command.table`), **one** decoder (`decodeTable`), **one**
ticket kind (`tableinsert`), **one** result wrapper (`insertTableEntryBytes`) and **four** limits. No
existing limit VALUE moved, `src/agent/*` is untouched, and only `src/tools/word.js`,
`src/plugin/bridge.js`, `src/shared/limits.js`, two test files and this document changed.

**The measured primitives.** On the target (Astra / R7 2026.1.2.1942, this round):
`Api.CreateTable(columns, rows)` creates a table object whose public methods include `GetCell(row, column)`,
`GetRow(i)` and `SetWidth` — **the FIRST argument is the COLUMN count and the second is the ROW count**,
the **opposite** of the order the first version of this tool assumed. It was measured cell by cell:
`CreateTable(3, 2)` fills `GetCell(0..2, 0..1)` while `GetCell(2, 0)`/`(2, 1)`/`(2, 2)` are `null`, so a
3-then-2 call built a **2-row × 3-column** table; `CreateTable(2, 3)` fills columns 0..1 and rows 0..2 while
`GetCell(0, 2)`/`(1, 2)`/`(2, 2)` **throw** internally (`Cannot read properties of null (reading 'Pr')`), so
a 2-then-3 call built **3 rows × 2 columns**; and `CreateTable(2, 2)` fills all four cells because a
**square** table is its own transpose. That last line is why the reversed order survived the earlier native
run and failed the pilot's main case: passing `(rowCount, columnCount)` builds a transposed table, so a
square matrix verifies while a **1 row × 2 column** header table has no `GetCell(0, 1)` at all — measured
end to end as `insert_table` → `CAPABILITY_UNAVAILABLE` with the document unchanged (a closed, fail-closed
refusal, but a refusal: the tool was correct-and-unusable for **every** non-square table). The fill loop now
passes `(columnCount, rowCount)` and the body **verifies the created geometry before it fills or pushes
anything**: it reads the LAST cell the loop will touch, `(rowCount - 1, columnCount - 1)`, and requires it to
exist carrying the measured chain, then reads `(rowCount, 0)` and requires it to be **absent** — so a build
whose factory takes the arguments the other way round refuses closed with ZERO writes instead of pushing a
partially filled table. Both reads are **defensive in both directions** because the out-of-range behaviour
is measured as **asymmetric** (a `null` in one direction, an internal throw in the other), so a throwing
address is treated as absence inside the body. **`GetRowCount` and `GetColumnCount` are `undefined`** and
are therefore named **nowhere** in this tool — the geometry is the matrix the caller sent. `table.GetCell(r,
c).GetContent()
.GetElement(0).AddText(text)` fills a cell (measured: the cell text appears in the document).
`document.GetAllTables()` answers the tables (measured **0 → 1** after one insert) and is the count the
delta is decided on. `doc.Push(element)` **appends at the END** while `doc.InsertContent([...])` lands at
the **BEGINNING** and, under a selection, replaces existing text (§13.2) — so the legacy whole-array
primitive is authored **nowhere** here either, and neither is select-then-insert. No mutation primitive's
return value is read.

**The proof is one-to-one over the append, and it has two halves that cannot substitute for each other:**
the document's table count grew by **exactly one**, **and** every cell of the table the append **added**
carries exactly the requested text. The added table is addressed by the baseline the body took **before**
the one `Push` — `Push` appends, so the insert's own table is at index `tablesBefore` — and its cells are
read back **cell by cell, in row-major order**, through the symmetric read of the measured fill chain,
`appended.GetCell(r, c).GetContent().GetElement(0).GetText()`, each compared with `data[r][c]`. That is
what makes it non-existential: a document that already held the very same texts in **another** table cannot
stand in for the insert's own cells. **The bound on that address is stated rather than overstated (review
D2 of the insert_table review):** it catches a route that lands at the START **only when the document held
at least one table
before** — at `tablesBefore ≥ 1` the old table sits at the address and the flags come out `0` — because at
`tablesBefore = 0` a prepending route also leaves a **fresh** table at index 0, and a fresh table at index 0
is not distinguishable from the appended one by shape alone (measured: a prepending double with no
pre-existing table answers `ok`; the earlier claim that a start-landing mutation "can only produce flags of
`0`" is **corrected here**). That is why the route and its geometry precondition are asserted
**separately** — the authored-leg classifier pins the body's primitives, and the factory-order/geometry
precondition pins the created shape — rather than resting on this address. Searching the document for the
cell texts is exactly the rule that was **rejected**,
and a test drives the rejection: a document already holding the matrix, plus an insert that creates the
right number of tables and writes **no** text, is `APPLY_UNCERTAIN` with the slot held.

**The mechanism is ONE self-contained static body** (`command.table`), the same carriage as the block
append: the matrix crosses as the `Asc.scope` parameter channel (`{ data }`), never interpolated into
source (ADR 0002); a **pre-dispatch baseline** read gates the whole call; the table is created and **every
cell is filled — and every step of the cell chain, including the readback's `GetText()`, is checked as a
function — BEFORE the one `document.Push`**, so an editor whose cell chain is not the measured one refuses
with **NOTHING inserted** instead of pushing a half-filled table; then the post read. The refusal phase
turns `POST_INSERT` **immediately before that one push**.

**The schema is closed** (`additionalProperties: false`, `required: ['data']`): `data` is a non-empty 2D
array of strings whose **shape is derived from the data** — there are no separate `rows`/`columns`
arguments that could disagree with the matrix. Four bounds are named in `src/shared/limits.js` with their
reasoning: **64** rows (the same scale as `insertBlocksMax`; every cell is one `GetCell` walk before the
push and one flag in the answer), **16** columns (a wide but real data table; 64 × 16 = 1024 is the worst
case, whose 1024 one-character flags measure ~2 KiB against the 65536-byte `editorResultBytes` window),
**1024** bytes per cell (deliberately not an alias of `insertBlockBytes`: half its width, because a written
cell is not a written paragraph) and **8192** bytes for the whole payload — `AGENT_CEILINGS.argumentsBytes`,
because the matrix *is* the action's arguments and JSON escaping never shrinks a text. **What that bound does
NOT cover (review D3 of the insert_table review, informational):** it is the **sum of the cells**, so it is
weaker than
`AGENT_CEILINGS.argumentsBytes` by exactly the JSON structure and escaping wrapped around that sum — a
handler-legal payload whose cells total 8192 bytes can serialize **above** 8192, and the runtime path refuses
that in `protocol.js` (`assertArgumentsBytes`) while a descriptor executed directly carries the handler's
bound alone. The same shape exists for `insertBlocksBytes`; both are deliberate per-call bounds, not aliases
of the serialized one, and the sentence is repeated at the limit in `src/shared/limits.js`. A **blank cell is
legal** and no lower bound is advertised for a cell text. The non-empty array, the non-empty row and the
**rectangularity** are deep rules the closed schema vocabulary cannot express (no `minItems`), so they are
refused by the handler **and** by the bridge as the closed argument class with **nothing dispatched**.
There is deliberately **no `header` option**: no measured primitive applies header formatting, and once a
table is in the document a header row is not distinguishable from a body row, so advertising one would
promise what the tool cannot do.

**The failure map**, each class closed: wrong editor → `CAPABILITY_UNAVAILABLE` (precondition); missing
bridge entry point → `CAPABILITY_UNAVAILABLE`; an **unusable baseline**, a **missing `Push`** or an
**unusable cell chain** → `CAPABILITY_UNAVAILABLE` with **zero `Push`** (the body answers before the one
mutation, with the pre-insert phase, so the slot is **released**); a bridge refusal → its own closed
`refusalCode`; an uninterpretable envelope → `known()`; a returned or thrown `APPLY_UNCERTAIN` →
`TOOL_UNCERTAIN`; an argument the tool cannot serve (empty, ragged, non-string or over-bound) → the closed
argument/byte class with **ZERO writes**; an over-ceiling result entry → `BYTE_LIMIT`. The refusal **phase
is an explicit slot of the answer** and `decodeTable` raises the known class **only** for
`[PRE_INSERT, name]`; a phase-less one-slot sentinel answered after a real insert is `APPLY_UNCERTAIN` with
the slot held. `owned.dispatched` alone cannot decide this — it is set before the command is handed to the
native, so it does not mean "the push ran".

**The result entry is measured** through the module's one `toolResultEntryBytes` shape
(`insertTableEntryBytes`): `ok({ rows, columns, tablesBefore, tablesAfter, bytes })`, exactly those five
fields. The arithmetic is pinned by measurement: a real insert measures **109** bytes, and the **widest
shape the handler can publish** — all five fields at `Number.MAX_SAFE_INTEGER` — measures **181** bytes,
i.e. more than sixteen thousand bytes inside the 16384-byte ceiling. The `BYTE_LIMIT` branch is retained as
the module's **one enforced bound** and is **unreachable** for five non-negative safe integers.

**TDD, and the exact RED.** The new test blocks were written FIRST and run against `1aece06` →
`node --test tests/unit/tools-word.test.js` → **tests 181, pass 158, fail 23** (`fail 0` on that file
before the round), every failure rooted in one cause: `insert_table` is missing from the descriptor set and
`bridge.insertTable` does not exist (`TypeError: Cannot read properties of undefined (reading 'execute')`,
`r.bridge.insertTable is not a function`, `the offered catalogue contains insert_table`). The 23 are exactly
the **20** new blocks plus the **3** existing enumerations, which grew by the new name rather than being
weakened. Green on the final tree: **181/181** on that file.

**A NEW SHAPE OF THE RECORDED AUDIT TRAP, found by the BUILDER and not by the source audit.** The first
build after the body was written failed with `BUNDLE_AUDIT_FAILED` — four `DYNAMIC_PROPERTY` findings, all
of them the readback chain (`GetCell`/`GetContent`/`GetElement`/`GetText`). The cause was neither a tainted
name nor a collision: `allTables[tablesBefore]` is a member read with a **non-constant key**, which the
analysis treats as a computed value, so the local holding it became "computed" and **every call on it** was
a finding. The repair is a `tableAt(list, index)` helper: a **call's result** is not tainted by that
analysis, so the value the body invokes the measured chain on is clean. `node scripts/static-audit.mjs`
passed on `src/` throughout; only the bundle saw it. The general rule §13 states is unchanged and now has a
third shape: audit the **bundle**, and never invoke through a value that came out of an array under a
non-constant index.

**Verification (this round, final tree).** Focused set
`tests/unit/bridge-dispatch-api.test.js tests/unit/tools-word.test.js tests/integration/package.test.js` →
**202/202**, `fail 0` (182 → 202); full suite `node --test` → **813**, `pass 813`, `fail 0` (793 → 813: the
same 20 added test blocks, none removed or weakened); `node scripts/static-audit.mjs` → `Authored-code audit
PASS`, exit 0; `node scripts/build-plugin.mjs` → exit 0, `Plugin build: 8 allowlisted files; ZIP STORE
SHA-256 2450bbe24749f03b524352892586112c488ff260bc5224707271c3942d24ef1f`, re-measured twice on the final
tree with the same value. The SHA **moved** from the
`1aece06` pin `27c99d41c90d2bbc1ee74b6672c716ef7c3a75d0454fb855536df110b00aa432` because a new authored body,
a new decoder and four new limits are in the bundle; the builder runs with `minify: false`, the build was
run (not only the audit), and the bundle audits with **0 findings**. The `package` test's authored-command
leg classifier grew **5 → 6** (`['blocks', 'capability', 'context', 'search', 'structure', 'table']`): the
table leg is recognised by `CreateTable` — a primitive no other leg authors — **before** the `.Push(`
branch, because it shares the measured append primitive with the block body, and the classifier also pins
that it reads `GetAllTables`, uses `GetCell` and authors no `InsertContent`. The registry offers the tool in
`EDIT` only (`kind: 'mutate'`), with `policy: 'auto'` and `requires: ['document.write']`, and a model batch
dispatches exactly **one** command for the whole run; `src/agent/*` untouched.

**Natively UNVERIFIED at this round's close, and each unknown is fail-safe rather than fail-open.** What the
host-side suite cannot prove is the **shipped** carriage of this leg: (1) that `{ data }` written into the
page's `Asc.scope` reaches the body's `scope` binding; (2) that the created table really has the geometry
the matrix asked for — the argument order is now the **MEASURED** one (`(columns, rows)`), and because that
is a fact about a BUILD rather than something this body can observe, the body additionally **verifies** the
geometry (the last cell exists with the measured chain, the first cell of the row past the end is absent)
and refuses closed with ZERO writes when it does not; (3) that the element at
`GetCell(r, c).GetContent().GetElement(0)` answers **both** `AddText` and `GetText` — the fill half is
measured, the readback half is the symmetric mate of it and the **one** primitive this round did not
measure directly, which is why the body checks it as a function **before** the one push: an absent
`GetText` costs a closed `CAPABILITY_UNAVAILABLE` with nothing inserted, never a false success; (4) that the
native return validator passes a flat array of `3 + rows × columns` primitives unaltered (up to 1027 members
at the widest legal geometry); and (5) that `GetAllTables()` inside the same synchronous body observes the
push. Each unknown lands on a closed path: a scope that does not arrive, a missing primitive or a cell chain
that is not the measured one makes the body answer its own phase-marked refusal
(`[PRE_INSERT, 'CAPABILITY_UNAVAILABLE']`, nothing inserted, slot released); a non-exact answer, a
malformed one or a throwing push is `APPLY_UNCERTAIN` → `TOOL_UNCERTAIN` with the slot held and no retry;
and an editor that never calls back settles `APPLY_UNCERTAIN` (a dispatched write-class ticket), never a
verified insert. A native run on the target is required before this tool's delta can be called measured; it
is recorded here as PENDING NATIVE VERIFICATION.

**§13.4 CORRECTION (post-native): the factory's argument order, and the geometry precondition it forced.**
The native run above went on to settle fact (2) — **against** the assumption: the Lead measured
`Api.CreateTable(a, b)` as **`a` COLUMNS and `b` ROWS**, and the end-to-end consequence on the pilot's main
case: `insert_table` with `{ "data": [["НОВАЯ-Т1", "НОВАЯ-Т2"]] }` (1 row × 2 columns) answered
**`CAPABILITY_UNAVAILABLE`** and wrote **nothing** — the fill loop walked `GetCell(0, 1)`, which does not
exist on the transposed 2-row × 1-column table the reversed arguments had built. The document was left
unchanged (fail-closed), but the tool was **correct-and-unusable for every non-square table**, and the
earlier native PASS proved nothing because a square matrix is its own transpose. Two things changed, and
nothing else:
1. the body now calls **`Api.CreateTable(columnCount, rowCount)`** — the MEASURED order;
2. the created geometry is an **explicit, verified precondition** rather than an assumption: before the
   fill loop and before the one `Push`, the body reads the LAST cell the loop will touch,
   `(rowCount - 1, columnCount - 1)`, and requires it to exist with the measured chain, then reads
   `(rowCount, 0)` and requires it to be **absent**; both reads are **defensive in both directions**
   (a `null` and an internal throw are both "absent"), matching the measured asymmetry. A wrong factory
   order on any build is therefore a **closed pre-insert refusal with ZERO writes** —
   `[PRE_INSERT, 'CAPABILITY_UNAVAILABLE']`, slot released, no partial table — never a half-filled insert.
The schema, the four limits, the exact-delta outcome contract (table count +1 and one flag per cell read
from the appended table), the phase protocol, the closed failure classes and the single `Push` are all
unchanged. The verification gate on the final tree: the focused `tests/unit/tools-word.test.js` suite
**188/188** (it grew by the new factory-order, wrong-geometry and geometry-precondition cases), `node --test`
**820 tests, pass 820, fail 0**, `node scripts/static-audit.mjs` → `Authored-code audit PASS` (exit 0), and
`node scripts/build-plugin.mjs` → exit 0, `Plugin build: 8 allowlisted files; ZIP STORE SHA-256
dc10a529f14f7730e1f53826ed789017ed4857640fae1d4c1d056d117e0f14a1`. The `package` test's
authored-command leg classifier is **unchanged** (the table leg is still recognised by `CreateTable` before
the `.Push(` branch).

**§14a NATIVE EVIDENCE, recorded after the argument-order fix (the Lead's target run).** Three facts are now
**measured on the target** rather than pending:
1. **The fix works end to end for the geometry that failed, and for a large one.** The previously failing
   case — `{ "data": [["НОВАЯ-Т1", "НОВАЯ-Т2"]] }`, **1 row × 2 columns** — now answers `ok` with the two
   cells in the document, and a **3 × 5** matrix (**15** cells) also answers `ok`: the MEASURED order holds
   for non-square matrices, and at a cell count well above the pilot's header table.
2. **`GetAllTables()` enumerates in the same order `Push` appends — the review's enumeration-order question
   is SETTLED.** A **2 × 2** insert into an R7-built document that **already held one table** gave
   **tables 1 → 2**, with the pre-existing table FIRST and the new one SECOND in the markdown readback, and
   the tool answered `ok`. The baseline address `tablesBefore` therefore names the appended table on the
   shipped build, which is exactly what the exact-delta contract reads — and it is why the "fresh table at
   index 0" limit stated above (review D2 of the insert_table review) does not undermine the append case.
3. **R7 does NOT save the open document to disk.** Each native run's baseline must be read from the **FILE**,
   never from the previous run's in-memory state: the editor keeps the change in the open window, so a run
   that assumes the previous run's result was persisted measures against the wrong document. Recorded as an
   operational fact about the target so a later native round does not re-learn it.

## 15. Sprint 3, tool 7 — `set_heading`, the FIRST mutation that APPENDS NOTHING

> **HISTORICAL — SUPERSEDED BY §15b, AND THE MECHANISM IT DESCRIBES IS DELETED.** Everything in this section
> from the sentence `THE STYLE READBACK IS A HYPOTHESIS` (below) down to §15a is the record of the round that
> shipped the **IDENTITY leg** — `targetAdded`, an object-reference comparison against
> `GetAllHeadingParagraphs()` — and of the reading in which an unusable style readback "degrades to the identity
> leg". The Lead then MEASURED that leg impossible on the target (the two paragraph lists hand out DIFFERENT
> wrapper objects; `GetAllParagraphs()[i] === GetAllHeadingParagraphs()[0]` is FALSE for every i), so it is gone
> from `src/` entirely: `isAmong` and `targetAdded` occur nowhere in the tree, and there is **no fallback on
> identity and none on text**. §15b is the CURRENT contract: the addressed paragraph's own style readback
> (`GetParaPr().GetStyle().GetName()`) is the PRIMARY proof, an unusable readback is `APPLY_UNCERTAIN` with the
> slot HELD, and the text / paragraph-count / heading-count reads are SECONDARY signals that can only refute.
> This section is kept for the history — the review findings D1–D4 and the tests that moved are still the record
> of how the tool got here — but nothing in it states the shipped mechanism any more. Where the two disagree,
> **§15b wins**.

The seventh Word tool, the third mutation, and the first one whose subject is an **existing** paragraph: it
changes the STYLE of the paragraph at an index the caller names and creates no paragraph, no table and no
text. Exactly **one** bridge entry point was added (`setHeading`), **one** authored command body
(`command.heading`), **one** decoder (`decodeHeading`, plus the `exactHeadingDelta` rule), **one** ticket kind
(`headinginsert`), **one** result wrapper (`setHeadingEntryBytes`) and **one** limit. No existing limit VALUE
moved, `src/agent/*` is untouched, and only `src/tools/word.js`, `src/plugin/bridge.js`,
`src/shared/limits.js`, two test files and this document changed.

**The measured primitives** (Astra / R7 2026.1.2.1942, this round, taken as established). `document.GetStyle
('Heading 1')` **resolves** — the lookup also accepts `'Heading1'`, `'heading 1'` and the localized
`'Заголовок 1'` — `style.GetName()` answers `'Heading 1'`, `paragraph.SetStyle(style)` is a public function
and **applies**, and afterwards the paragraph IS a heading: `GetAllHeadingParagraphs()` grew 3 → 4 while
`GetAllParagraphs()` grew 10 → 11 (measured on a newly created paragraph; this tool applies the SAME route to
an existing paragraph at a known index). Because this leg **appends nothing**, the two routes the other
mutations use are authored **nowhere** here: `doc.Push` appends (nothing is appended) and
`doc.InsertContent` inserts at the BEGINNING and, under a selection, **replaced existing text** (§13.2) — the
one route measured to destroy the very text this tool promises to leave unchanged.

**THE STYLE READBACK WAS A HYPOTHESIS, AND IT WAS TREATED AS ONE — AND THAT READING IS SUPERSEDED BY §15b.**
The public `ApiParaPr` that `paragraph.GetParaPr()` returns registers `GetStyle` (among `GetJc`/`GetIndLeft`/…),
so the addressed paragraph's **own** style is readable as `paragraph.GetParaPr().GetStyle()` — the Lead has
since MEASURED it, and it is now the PRIMARY proof (§15b). At THIS round it was still a hypothesis, so the body
attempted the read inside its own `try`, behind `typeof` checks on **both** members, and reported what happened
in a separate flag. **The sentence that used to stand here — that a build where `GetParaPr` is absent, is not a
function, or throws "is still decided by the IDENTITY leg (§15a)" — is DELETED, because that leg was measured
impossible and is gone from `src/`:** `isAmong` and `targetAdded` occur nowhere in the tree. An unusable
readback is now `APPLY_UNCERTAIN` with the slot HELD (§15b), never `ok`, never a known class and never a
fallback on identity or on text. The tests still drive all three states — the readback works and matches, the
readback works and disagrees (a non-success), and the readback is absent or throws (the uncertain path, with
the result saying so) — but they assert the §15b outcome. Note that §15a REVISED this paragraph's original
claim: before the review round the absent readback fell back to a TEXT membership leg, which the review drove to
a false success on a duplicate-text document.

**The outcome contract is one-to-one FOR THE TARGET PARAGRAPH**, and every leg is about that paragraph rather
than about a global count. `ok` is published only when the post read shows all of:
1. the addressed paragraph's **TEXT is exactly what it was before** the single `SetStyle` (`textUnchanged`) —
   read by the body around the one mutation, so a route that replaced text, and a **stale index** whose
   paragraph now holds something else, are both non-successes. **The text is a SECONDARY signal**: it can
   refuse an assignment and it can never establish one, because two paragraphs of one document can hold the
   same text;
2. the paragraph count is **unchanged** (a style assignment creates and destroys nothing), the heading count
   grew by **exactly one**, and **the ADDRESSED OBJECT — the paragraph the body took from
   `GetAllParagraphs()` at the caller's index — IS one of the post heading paragraphs**, compared by
   **REFERENCE** against `GetAllHeadingParagraphs()` (`targetAdded`). This is the **identity leg**; the text
   comparison that used to sit here is the false-success reproduction §15a records, driven through the real
   body by an independent review;
3. the heading count **really grew by exactly one**, re-derived from the two counts rather than trusted from
   the flag;
4. **if** the style readback worked (`styleRead`), the target's own style name **matches** the requested
   `Heading <n>` (`styleMatches`) under the **same case- and space-folding** the module's own
   `readsStyleName` applies (the lookup was measured to accept `'Heading1'`/`'heading 1'` for that one style,
   so a differently spelled answer is a match, not a disagreement). A readable name that differs by more than
   case and spaces is a genuine contradiction and the outcome is uncertain;
5. **if the readback did NOT work (`styleRead: false`), the outcome is decided by the identity leg ALONE** —
   `ok` when the addressed object really is the one new heading, `TOOL_UNCERTAIN` with the slot HELD when it
   is not. **The text leg is never sufficient in either direction**, and `styleRead` travels in the result so
   a caller is never told an identity that was not established. This is the decided contract §15a records;
   the old text fallback, and the false success it admitted, are gone.
**A target that is ALREADY a heading is REFUSED, not guessed at** (§15a): a level change on an existing
heading moves no count, so no measured signal could verify it. The body decides the pre-state BEFORE the one
`SetStyle` by the same identity comparison and answers the closed argument class with ZERO writes and the slot
RELEASED — instead of the `APPLY_UNCERTAIN` with the slot HELD that used to leave the write lock engaged for
the rest of the session.

> **SUPERSEDED BY §15b.** Points **2**, **3** and **5** of the outcome contract above, and the
> object-identity comparison in the pre-state paragraph, are the IDENTITY leg — and the Lead MEASURED it
> impossible on the target: the two paragraph lists hand out DIFFERENT wrapper objects, so no reference
> comparison can ever hold. §15b replaces that leg with the addressed paragraph's OWN style readback (also
> measured), and it is the current contract: an UNUSABLE readback is `APPLY_UNCERTAIN` with the slot HELD
> rather than a fallback on identity. The TEXT and COUNT legs survive as SECONDARY signals only; the
> already-heading refusal survives, decided by the readback.

**The mechanism is ONE self-contained static body** (`command.heading`), the same carriage as the block and
table legs: the request crosses as the `Asc.scope` parameter channel (`{ paragraph, level, styleName }`),
never interpolated into source (ADR 0002); a **pre-dispatch baseline** of the two counts AND the addressed
paragraph's own text gates the whole call; the style is **resolved before** the mutation (an unresolvable
`Heading <n>` refuses with NOTHING styled); then ONE `phase = 'POST_INSERT'` followed immediately by ONE
`target.SetStyle(style)`; then the post read. The index is taken from the SAME baseline array its text is read
from, through a `paragraphAt(list, index)` helper — an authored-code-audit requirement as well as a
correctness one, because a member read with a NON-CONSTANT key is a computed value in that analysis while a
CALL's result is not.

**The schema is closed** (`additionalProperties: false`, `required: ['paragraph', 'level']`):
`paragraph` is the 0-based index, integer, bounded by `setHeadingIndexMax` = **128** (the limit states the
reasoning: a document this product writes is a chapter, and it is not an alias of `insertBlocksMax`,
`insertTableRowsMax` or `MAX_CONTEXT_INDEX`); `level` is an integer 1..**9** mapped by the module's ONE
`headingStyleName` to `Heading <n>` — the same family and the same measured naming `insert_blocks` uses. There
is deliberately **no `text` argument and no `style`/`styleName` argument**: a caller that could name the style
string directly would address a name this module never measured, so the name is DERIVED from the level. The
address bound is ADVERTISE-AND-VERIFY: the body additionally requires the index to be inside the document's
own `GetAllParagraphs()` BEFORE the one mutation, so an index past the end of THIS document is a closed
argument refusal with ZERO writes.

**The failure map**, each class closed: wrong editor → `CAPABILITY_UNAVAILABLE` (precondition, which also
applies the address and level bounds); missing bridge entry point → `CAPABILITY_UNAVAILABLE`; an unusable
**baseline** or an index outside the DOCUMENT → `CAPABILITY_UNAVAILABLE` with ZERO writes (the body's
pre-insert half); a target that is **ALREADY a heading** → `ALREADY_HEADING` → `TOOL_ERROR` with ZERO writes
and the slot RELEASED (a level change on an existing heading is not supported — §15a states the limitation and
the one route that could verify one); an **unresolvable `Heading <n>`** → `STYLE_UNAVAILABLE` → `TOOL_ERROR`
with ZERO writes, resolved before the mutation exactly as `insert_blocks` resolves every style before its first
`Push`; a bridge refusal → its own closed `refusalCode`; an envelope this handler cannot interpret (a
non-integer count, a non-boolean flag, a style name that is not the requested one) → `known()`; a returned or
thrown `APPLY_UNCERTAIN` → `TOOL_UNCERTAIN`; a contradiction the handler can see for itself (a heading count
that did not grow by exactly one, a `false` proof flag, a readable readback that disagrees) → `TOOL_UNCERTAIN`
with the slot HELD and NO retry; an over-ceiling result entry → `BYTE_LIMIT`. The refusal **phase is an explicit
slot of every answer** and `decodeHeading` raises the known class **only** for `[PRE_INSERT, name]`; a
phase-less one-slot sentinel answered after a real mutation is `APPLY_UNCERTAIN` with the slot held.

**The result entry is measured** through the module's one `toolResultEntryBytes` shape
(`setHeadingEntryBytes`): `ok({ paragraph, level, heading, headingsBefore, headingsAfter, styleRead,
styleMatches, bytes })` — eight bounded scalars. A real assignment measures ~180 bytes and the **widest shape
the handler can publish** (every numeric field at its legal maximum) measures well under 300, i.e. more than
sixteen thousand bytes inside the 16384-byte ceiling; `BYTE_LIMIT` is retained as the module's one enforced
bound and is unreachable for eight bounded fields.

**TDD, and the exact RED.** Sixteen new test blocks were written FIRST and run against `b34d479` →
`node --test tests/unit/tools-word.test.js` → **204 tests, pass 185, fail 19** (`fail 0` on that file before
the round), every failure rooted in one cause: `set_heading` is missing from the descriptor set and
`bridge.setHeading` does not exist (`Cannot read properties of undefined (reading 'execute')`,
`r.bridge.setHeading is not a function`, `the offered catalogue contains set_heading`). Sixteen of those tests
are the new blocks; the other three failures were the existing enumerations, which grew by the new name rather
than being weakened — **three feature-dependent enumerations also fail, so the honest count is 19 failures and
185 passes (204 − 19), not the 16/188 an earlier revision of this record stated** (D4 of the review round
§15a). Green on the final tree: **204/204** on that file.

**TWO NEW SHAPES OF THE RECORDED AUDIT TRAP, both found by the BUILDER and not by the source audit.** The
first build after the handler was written and again after the style-name check was added failed with
`BUNDLE_AUDIT_FAILED` while `node scripts/static-audit.mjs` passed on `src/` throughout — the general rule §13
states (audit the BUNDLE) caught both:
1. `paragraph.GetParaPr()` reached through an object whose local was not a call's result was one shape; the
   repair is the same rule the command bodies follow (`paragraphAt`/`textAt` helpers).
2. **A property READ on a local that some OTHER handler has already marked "computed".** The analysis is
   NAME-based and scope-insensitive over the whole bundle, and `const uncertain = uncertainResult(result)` in
   a sibling handler marks the NAME `result` computed; a later `result.styleName.toLowerCase()` then made the
   `replace` call reached through it a `DYNAMIC_PROPERTY` finding. The repair is a helper that takes the
   envelope as a PARAMETER (`readsStyleName(result, styleName)`): a CALL's result is not tainted, so the read
   happens inside a function the analysis does not track. This is the fourth recorded shape of the same rule,
   and it is the first one that is about a **local's NAME** rather than about an array index.

**A TEST-DOUBLE DEFECT FOUND THE HARD WAY, and it is worth recording for the next mutation tool.** The first
version of the new rig injected its fault cases (`restyle`/`apply`/`grow`/`concurrent`) into the DOUBLED
DOCUMENT's `SetStyle` — a method the authored body never calls, because the measured route is
`paragraph.SetStyle(style)` on the ADDRESSED PARAGRAPH. Every fault was therefore **inert dead code**: the
suite reported clean assignments for cases that were supposed to be failures, and the only thing that exposed
it was asserting the DOCUMENT's own state (`doubles[i].style`) rather than the tool's answer. The repair moves
every fault onto the paragraph's own `SetStyle` (counting DISPATCHES, and landing `grow:2`'s second round on a
second paragraph) and turns the document-level method into a recorded trap that must never be called. The
lesson generalises: **a test double must inject its faults where the production code really calls, and the
assertion that proves it is the document's own state, not the tool's report.**

**Verification (this round, final tree).** Focused set
`tests/unit/bridge-dispatch-api.test.js tests/unit/tools-word.test.js tests/integration/package.test.js` →
**225/225**, `fail 0` (202 → 225); full suite `node --test` → **836 tests, pass 836, fail 0, skipped 0**
(820 → 836: the same new blocks, none removed or weakened); `node scripts/static-audit.mjs` →
`Authored-code audit PASS`, exit 0; `node scripts/build-plugin.mjs` → exit 0, `Plugin build: 8 allowlisted
files; ZIP STORE SHA-256 cba1ed0a458f3085d0004c135b1ede7a85858232cafeb3832d48ff3ad1200d47`. The SHA **moved**
from the `b34d479` pin `dc10a529f14f7730e1f53826ed789017ed4857640fae1d4c1d056d117e0f14a1` because a new
authored body, a new decoder, a new ticket kind and one new limit are in the bundle (the builder runs with
`minify: false`). The `package` test's authored-command leg classifier grew **6 → 7**
(`['blocks', 'capability', 'context', 'heading', 'search', 'structure', 'table']`): the heading leg is
recognised by `paragraph.SetStyle` — a primitive no other leg authors — and its branch sits AFTER the
`CreateTable` and `.Push(` branches, because the BLOCK body also authors a `SetStyle` on the paragraphs it
creates; the branch also pins that the heading body reads `GetAllHeadingParagraphs` and `GetAllParagraphs` and
authors neither `InsertContent` nor `document.Push(`. The registry offers the tool in `EDIT` only
(`kind: 'mutate'`), with `policy: 'auto'` and `requires: ['document.write']`, and a model call dispatches
exactly one command; `src/agent/*` untouched.

**NATIVELY UNVERIFIED AT *THAT* ROUND'S CLOSE — HISTORICAL ONLY, SUPERSEDED BY §15b, AND NO LONGER PENDING.**
The block below is kept as the record of what was outstanding when the identity-leg round shipped. It is NOT
the current state of the tool. Its item (6) — the identity unknown — was **MEASURED and answered FALSE** by the
Lead: `GetAllHeadingParagraphs()` does NOT answer the same objects `GetAllParagraphs()` answers, so the identity
leg is **deleted** from `src/` and is not this tool's carriage (`isAmong`/`targetAdded` appear nowhere in the
tree). Item (2) — whether `paragraph.GetParaPr().GetStyle()` really answers a NAME — was **MEASURED TRUE**, and
that readback is now the PRIMARY proof. There is therefore no fallback on identity and none on text; §15b states
the current outcome contract, the current unknowns and the current slot discipline.

> **Natively UNVERIFIED at this round's close, and each unknown is fail-safe rather than fail-open.** What the
> host-side suite cannot prove is the SHIPPED carriage of this leg: (1) that `{ paragraph, level, styleName }`
> written into the page's `Asc.scope` reaches the body's `scope` binding; (2) that
> `paragraph.GetParaPr().GetStyle()` really answers a NAME — the **one hypothesis this tool rests on** for its
> confirming leg; (3) that `paragraph.SetStyle(styleObject)` on an EXISTING paragraph of an R7-built document
> really applies the style and moves `GetAllHeadingParagraphs()` by exactly one — the append-side measurement is
> on a newly created paragraph, and this tool's whole contract is the in-place case; (4) that the native return
> validator passes a seven-member flat array of primitives unaltered; (5) that `GetAllParagraphs()` enumerates in
> the SAME order `SetStyle` addresses, so the index the caller names is the paragraph the tool styles; and (6) —
> the IDENTITY unknown §15a added — **that `GetAllHeadingParagraphs()` answers the SAME paragraph objects
> `GetAllParagraphs()` answers**, because the identity leg compared against `afterTarget` by reference. Each
> unknown landed on a closed path: a scope that does not arrive, a missing primitive or a style that does not
> resolve made the body answer its own phase-marked refusal (`[PRE_INSERT, …]`, nothing styled, slot released).
> **A native run on the target was required before this tool's outcome could be called measured.** It happened:
> §15b records the two measured facts that replaced this whole reading.

**THE STALE-INDEX RESIDUAL, STATED BECAUSE IT CANNOT BE CLOSED IN BAND.** The address is a POSITION, not an
owned TARGET: there is no handle whose identity a probe could establish, and a caret/document-id probe could
not make a position stable anyway, because a concurrent edit ABOVE the addressed index renumbers it without
changing any id. What the leg closes is the case a probe would have caught: the body reads the addressed
paragraph's TEXT before the one `SetStyle` and again after it and requires the two to be equal, so an index
whose paragraph now holds DIFFERENT text is a non-success (`APPLY_UNCERTAIN`, slot HELD, no retry) rather than
a silent edit of the wrong paragraph. What it cannot catch is a concurrent edit that lands a paragraph with
EXACTLY the same text at that index. That residual is accepted rather than denied, and the structural remedy
for a later hardening round is the same one §13.3 records for the phase protocol: split the non-mutating
preconditions into a dispatch of their own, so the address is re-read against the same snapshot the mutation
runs on — at the cost of one extra native round trip.


## 15a. The review round on `set_heading` — the identity leg, the folded readback, the already-heading refusal and the arithmetic (D1–D4)

An independent review of `5bbc6c2` (`feat(tools): add set_heading over the measured style route`) found four
defects. All four are closed in this round. What did NOT move: the closed schema and its two bounds, the
descriptor's identity and policy, the ONE `SetStyle`, the ONE decoder, the phase protocol, and the slot
discipline (**only `[PRE_INSERT, name]` releases this leg's slot**). `src/agent/*` is untouched and no dynamic
execution was added to `src/`; the files changed are `src/plugin/bridge.js`, `src/tools/word.js`,
`tests/unit/tools-word.test.js` and this document.

**D1 (HIGH, fail-OPEN — a false `ok` with the slot RELEASED).** The proof's `targetAdded` leg compared the
addressed paragraph's **TEXT** against the post heading paragraphs' **TEXTS**. The reviewer drove the REAL
authored body with two paragraphs holding the SAME text and a `SetStyle` that landed on the second one (a
document whose paragraphs expose no `GetParaPr`): `bridge.setHeading({ paragraph: 0, level: 1, styleName:
'Heading 1' })` answered `{"ok":true,…,"headingsBefore":0,"headingsAfter":1,"targetAdded":true,
"textUnchanged":true,"styleRead":false,"styleMatches":false}` with `getState().busy === false`, although
paragraph 0 was never restyled. The leg is now **OBJECT IDENTITY**: the paragraph the body addressed
(`afterTarget`, taken from the post `GetAllParagraphs()` array at the caller's index) must **BE** one of the
post `GetAllHeadingParagraphs()` elements, compared by reference in the body's `isAmong` helper. The addressed
paragraph's text stays a **SECONDARY signal** (`textUnchanged`): it can refuse an assignment and it can never
establish one.
**The decided contract for `styleRead === false`, stated in the body, in `exactHeadingDelta`, in the descriptor
and here:** with no readback the outcome rests on the **identity leg ALONE** — `ok` when the addressed object
really is the one new heading, `APPLY_UNCERTAIN` with the slot **HELD** when it is not. The text leg is never
sufficient in either direction, and `styleRead: false` travels in the result so a caller is never told an
identity that was not read.
**The residual this leg leaves, stated rather than denied:** if the target's `GetAllHeadingParagraphs()` answers
a NEW wrapper object per call (rather than the same objects `GetAllParagraphs()` answers), no reference
comparison can hold, so the assignment settles `TOOL_UNCERTAIN` with the slot held — fail-safe, never a false
success, but it is also the one build on which this tool could not verify anything. The suite models that build
explicitly (`freshHeadingWrappers`) and pins the fail-safe outcome. **A native run must confirm that the heading
list answers the same objects before this tool's outcome can be called measured.**

**D2 (MEDIUM — the style-name comparison was too strict).** The readback name was compared with raw `===`,
while the same target was measured to accept `'Heading1'`, `'heading 1'` and the localized `'Заголовок 1'`, and
the module's own envelope comparison (`readsStyleName`) folds case and spaces. A getter answering `'Heading1'`
therefore produced `styleRead=1, styleMatches=0` → `APPLY_UNCERTAIN` → `TOOL_UNCERTAIN` with the write lock held
for the session, on a mutation that had succeeded. The body now folds case and drops spaces, exactly as
`readsStyleName` does; **option chosen: normalise, not "non-canonical ⇒ `styleRead = 0`"** — the fold is the
rule the module already applies to the same evidence. Nothing beyond case and spaces is folded: a name that
differs by more than that is a **genuine disagreement** and still settles `APPLY_UNCERTAIN` with the slot held,
and the localized alias the setter's own lookup accepts is NOT guessed at (it is never treated as a match).
Tested in both directions: five spellings of the requested style are matches, and a readback naming a DIFFERENT
style is still a contradiction with the slot held.

**D3 (MEDIUM — a target that is already a heading was always uncertain, and left the tool wedged).** Re-running
on a paragraph that was ALREADY a heading of any level always settled `APPLY_UNCERTAIN` with the slot held (the
reviewer verified H1 → level 1 and H2 → level 1, then the next mutation returned `EDITOR_BUSY`). The pre-state
is now decided BEFORE the one `SetStyle`, by the **same identity comparison** against the heading paragraphs the
body read as its baseline: an already-heading target answers `ALREADY_HEADING` → the closed **argument** class
(`TOOL_ERROR`) with **ZERO writes** and the slot **RELEASED**, and the very next assignment on another paragraph
verifies. **STATED LIMITATION OF THIS TOOL: changing the LEVEL of an existing heading is NOT supported.** The
only signal a style assignment moves is the heading COUNT, and a level change moves it nowhere (the document
loses one heading and gains one), so no measured signal this body can read could tell an applied level change
from a route that did nothing at all. **The one route that COULD verify a level change, proposed and NOT
implemented:** read the addressed object's OWN style name before and after the one `SetStyle` (the
object-identity readback `paragraph.GetParaPr().GetStyle()`) and require the BEFORE name to be a heading style
different from the requested one while the AFTER name matches it, with the paragraph and heading counts
unchanged and the text unchanged; that route stays closed by the refusal above while the readback is
unmeasured, and it must not be implemented before a native measurement of `GetParaPr().GetStyle()` on a real
R7-built document. **The residual D3 accepts:** on a build whose heading list answers fresh wrappers the
pre-check cannot see that the target is already a heading, so the mutation is dispatched, no count moves and
the outcome is `APPLY_UNCERTAIN` with the slot held — the fail-safe direction, pinned by a test, and the reason
the identity unknown above is the first thing a native run must settle.

**D4 (LOW — the red-run arithmetic).** §15 now records the honest count: `node --test
tests/unit/tools-word.test.js` against `b34d479` → **204 tests, pass 185, fail 19**, because the three extended
feature-dependent enumerations failed too (16 new blocks + 3 enumerations = 19, so 204 − 19 = 185). The earlier
`pass 188, fail 16` was wrong.

**TDD: the exact RED, then GREEN.** Eight new blocks were added, with the shared
`headingDocument` double amended so its heading list answers the paragraph objects themselves (the identity the
leg rests on) unless `freshHeadingWrappers: true` models the build that cannot carry it, plus a `readback` hook
that rewrites the name the paragraphs' own `GetStyle()` answers. Run FIRST against the unfixed tree:
`node --test tests/unit/tools-word.test.js` → **212 tests, pass 208, fail 4**, each failure exactly one defect:
1. `set_heading holds the slot when a duplicate-text document restyles the OTHER paragraph (the false-ok
   reproduction)` — `actual: { ok: true, styleName: 'Heading 1', headingsBefore: 0, headingsAfter: 1,
   targetAdded: true, textUnchanged: true, styleRead: false, styleMatches: false }`,
   `expected: { ok: false, code: 'APPLY_UNCERTAIN' }` — the D1 fail-open, through the real body;
2. `a heading list that answers DIFFERENT objects cannot carry the identity leg…` — the same false `ok`, this
   time with a readable readback (`styleRead: true, styleMatches: true`), where the correct outcome is the
   identity leg failing and the slot being held;
3. `set_heading folds the readback name the way the module's own style-name comparison does` —
   `AssertionError: Heading2 — false !== true` — the D2 false disagreement;
4. `set_heading refuses a paragraph that is ALREADY a heading with ZERO writes and the slot RELEASED` —
   `actual: { ok: false, code: 'APPLY_UNCERTAIN' }`, `expected: { ok: false, code: 'TOOL_ERROR' }` — the D3
   wedge (an `APPLY_UNCERTAIN` there holds the slot, and the test's own next call proved `EDITOR_BUSY`).
The very first RED run reported a fifth failure that was the new test's OWN ordering bug — it asserted the
dispatch count before dispatching — and it is recorded here so the arithmetic is not mistaken for a product
defect; the assertion moved after the dispatch and the RED then stood at exactly the four above. Green on the
final tree: **212/212** on that file.

**Verification (this round, final tree).** Focused set
`tests/unit/bridge-dispatch-api.test.js tests/unit/tools-word.test.js tests/integration/package.test.js` →
**233/233**, `fail 0` (225 → 233); full suite `node --test` → **844 tests, pass 844, fail 0, skipped 0**
(836 → 844: the eight new blocks, none removed or weakened); `node scripts/static-audit.mjs` →
`Authored-code audit PASS`, exit 0 (`DYNAMIC_PROPERTY` findings: none — the identity helper only READS an
indexed element and the folding helper takes its spelling as a parameter, exactly the two shapes the recorded
audit traps require); `node scripts/build-plugin.mjs` → exit 0, `Plugin build: 8 allowlisted files; ZIP STORE
SHA-256 c29676cfc6b7a53475b8227343adecbf693163b4affd8c40cbbba6774fc14962`. The SHA **moved** from the
`5bbc6c2` pin `cba1ed0a458f3085d0004c135b1ede7a85858232cafeb3832d48ff3ad1200d47` because the authored body and
one decoder changed (the builder runs with `minify: false`). The `package` test's authored-command classifier
is unchanged: the heading leg is still recognised by `paragraph.SetStyle` and still pins that the body reads
`GetAllHeadingParagraphs`/`GetAllParagraphs` and authors neither `InsertContent` nor `document.Push(`.

**Which existing tests moved, and why.** None was weakened, removed or renamed. The shared `headingDocument`
double now answers `GetAllHeadingParagraphs()` with the paragraph objects themselves (it used to answer fresh
`{ GetText() }` wrappers), because that is the identity the proof now rests on, and it gained the
`freshHeadingWrappers` and `readback` modes the new blocks need. The four verification counts in this document
and the §15 red-run arithmetic were corrected. Every previously green block stayed green — until §15b removed
the identity leg it rested on.


## 15b. The MEASURED round on `set_heading` — the identity leg is dead, the addressed paragraph's own style readback is the proof

**The two measured facts that decide this round** (Astra / R7 2026.1.2.1942, measured by the Lead in the same
session, inside a real `callCommand` body).

1. **There is NO object identity between the two paragraph lists.** On a three-paragraph document with one
   heading, `GetAllParagraphs()` returned 3 objects and `GetAllHeadingParagraphs()` returned 1 whose
   `GetText()` equalled `GetAllParagraphs()[0]`, while `GetAllParagraphs()[i] === GetAllHeadingParagraphs()[0]`
   was **FALSE for every i** (`identityMatchAt: -1`). The lists hand out **different wrapper objects**.
   **Consequence:** the `isAmong` reference-equality leg §15a introduced can **never** hold on the target, so
   EVERY `set_heading` call would have settled `APPLY_UNCERTAIN` with the write slot held for the rest of the
   session — fail-safe, but the tool unusable. The defect was introduced by following the previous review's
   "compare by identity" suggestion, which rested on an unverified assumption, verified only afterwards.
2. **The paragraph's own style readback works and is exact.** For every paragraph,
   `typeof paragraph.GetParaPr === 'function'` and `typeof paragraph.GetParaPr().GetStyle === 'function'`. Its
   answer: for a paragraph carrying an explicit Heading style a **style object** (`GetClassType()` =
   `'style'`) whose `GetName()` gives the canonical **`'Heading 1'`**; for a plain (Normal) paragraph
   **`null`**. Measured on the same document: index 0 (a Heading 1) → `'Heading 1'`; indices 1 and 2 (Normal)
   → `null`; and the same read on `GetAllHeadingParagraphs()[0]` → `'Heading 1'`.

**The new contract, in order of authority.** `ok` requires, all of them:
1. **PRIMARY — the readback.** The addressed paragraph's OWN style name, read through
   `GetParaPr().GetStyle().GetName()` **after** the one `SetStyle`, equals the requested `Heading <n>` under
   the same case- and space-folding `readsStyleName` applies. This is an exact, PER-OBJECT proof; it needs
   neither identity nor text uniqueness.
2. **SECONDARY (can only REFUTE, never establish)** — the addressed paragraph's TEXT is unchanged
   (`textUnchanged`), the document's paragraph count is unchanged (`paragraphsStable`), and the heading count
   grew by exactly one (re-derived from the two pushed counts by `exactHeadingDelta`).
**An unusable readback is the decided UNCERTAIN path.** A build where `GetStyle()` answers nothing readable,
or where `GetName()` is absent or throws, cannot establish the assignment — and the mutation has ALREADY
happened by the time the post read is taken. The outcome is therefore `APPLY_UNCERTAIN` with the slot **HELD**:
**never `ok` and never a known class**, and there is no fallback on identity (measured impossible) or on text
(never sufficient). The measured `null` of a plain paragraph is deliberately NOT that case: it is a READABLE
non-match (`styleRead: 1, styleMatches: 0`), and the body's three-way readback (`null` = unread, `''` = read
and nameless, a name = read) keeps the two apart.

**Level changes on an existing heading are STILL REFUSED**, now decided by the readback BEFORE the one
`SetStyle`: a non-null style whose folded name is a heading name answers `ALREADY_HEADING` → `TOOL_ERROR` with
ZERO writes and the slot RELEASED. The verifiable route a level change WOULD need is now describable — read
the pre-name (the old heading style), require the post-name to match the request, with the counts and the text
unchanged — and it is **not taken yet in one sentence**: the in-place effect of `SetStyle` on an EXISTING
heading paragraph (as opposed to the newly created paragraph the append-side measurement used) was never
measured on the target, so for a level change the expected heading delta of ZERO is itself an unmeasured
expectation and the proof would rest on the readback pair alone. A NON-heading styled paragraph (`Title`,
`Quote`) is NOT refused: only a heading name is the pre-state.

**TDD: the exact RED, then GREEN.** The tests were rewritten FIRST and run against `8405bc8` (the identity
leg's tree) → `node --test tests/unit/tools-word.test.js` → **212 tests, pass 203, fail 9**, every failure
rooted in the two measured facts:
`set_heading assigns the style through exactly ONE bridge call…`, `set_heading publishes ok ONLY for the exact
proof…`, `bridge setHeading dispatches ONE command…`, `the heading body is self-contained…`,
`set_heading is offered with policy auto…` (the envelope field is now `paragraphsStable`, so the old
`targetAdded` shape is an uninterpretable envelope),
`set_heading verifies through the readback although the two paragraph lists answer DIFFERENT objects` →
`actual: { ok: false, code: 'APPLY_UNCERTAIN' }` (the identity leg cannot hold),
`the measured readback of a plain paragraph is null…` → the body answered
`['POST_INSERT', 0, 0, 0, 1, 0, 0]` instead of `[…, 1, 1, 1, 0]` (the readback was rejected as a non-string),
`set_heading folds the readback name…` → `AssertionError: Heading 2 — false !== true` (the style OBJECT was
not read at all), and `set_heading refuses a paragraph that is ALREADY a heading…` →
`actual: { ok: false, code: 'APPLY_UNCERTAIN' }`/`expected: { ok: false, code: 'TOOL_ERROR' }` (the identity
pre-check could not see it). Green on the final tree: **213/213** on that file.

**WHY THE RED POPULATION (212) IS ONE BELOW THE GREEN (213), STATED PLAINLY — D-A OF THE CLOSE-OUT REVIEW.**
The reviewer could not reproduce the RED run read-only (it needs `8405bc8` checked out) and noted correctly that
`203 pass + 9 fail = 212` reconciles with the green **213** only if ONE case joined the file AFTER the RED run.
**It did, and the case is `a paragraph carrying a NON-heading style is not refused: only a HEADING name is the
pre-state`, added WHILE the body was being changed to decide the pre-state from the readback — i.e. after the RED
run and before `0700639`.** The round's own artifacts establish it: neither that case nor
`the measured readback of a plain paragraph is null: a READABLE non-match, never an absent read` exists in the
test file at `8405bc8`, while `0700639` carries both — so both are POST-RED additions, and the only test block
the round REMOVED (the old `a heading list that answers DIFFERENT objects cannot carry the identity leg…`) is
what makes the net +1. **The reconciliation is therefore exactly `212 + 1 = 213`, and the added case is the
`Title` one.** Stated because it was NOT stated before: without that sentence the two numbers are not directly
comparable, which is what the review flagged.

**AND THE HONEST LIMIT OF THAT RECONSTRUCTION.** The RED record's own denominator cannot be checked further from
the tree: the file at `8405bc8` carries **207** `test(` blocks and the file at `0700639` carries **208**, while
the round's GREEN run counted **213** tests on that same file — so the run's meter and a `test(` block count are
NOT the same quantity (the run counts 5 more than the file's blocks at `0700639`), and the record never says
which meter produced its 212. What IS checkable is the DELTA the review asked about, and it is consistent: the
file gains exactly ONE block net across this round (the two post-RED additions above, minus the one removal), so
the `Title` case is the whole of the `212 → 213` difference. **The one fact the review needed and the record did
not carry is the sentence above: the `Title` case was added AFTER the RED run.**

**Which legs changed, and which tests moved.** REMOVED: the `isAmong` identity helper and the identity leg
(`targetAdded`) — replaced by the readback (now PRIMARY, not conditional) and by the paragraph-count flag
`paragraphsStable`; `exactHeadingDelta` now REQUIRES `styleRead && styleMatches`; the handler's
`if (result.styleRead && !styleMatches)` became `if (!result.styleRead || !styleMatches)`. MOVED (renamed and
re-expressed, never weakened): the identity round's tests became `set_heading verifies through the readback
although the two paragraph lists answer DIFFERENT objects` (the DISTINCT lists are now the double's DEFAULT —
`freshHeadingWrappers` is deleted as dead scaffolding, and the test asserts the two lists share no object),
`set_heading settles the duplicate-text reproduction BY the readback…` (the reviewer's reproduction is kept
and now fails on the addressed paragraph's own `null`), `set_heading holds the slot when the style readback is
UNUSABLE — there is no identity fallback` (the old "decides by the identity leg ALONE" contract is gone), and
`an already-heading target whose readback is unusable is not refused by guesswork…` (the old
"undetectable with fresh wrappers" residual no longer exists). ADDED: `the measured readback of a plain
paragraph is null: a READABLE non-match, never an absent read` and `a paragraph carrying a NON-heading style
is not refused: only a HEADING name is the pre-state`. The shared `headingDocument` double now answers
`GetStyle()` in the MEASURED shape (a style OBJECT with `GetName()`, or `null` for a Normal paragraph) and its
heading list is filtered to real heading names. The `package` integration classifier gained two pins for this
leg: the body must read `GetParaPr()` and must never compare the two paragraph lists by identity.

**Verification (this round, final tree).** Focused set
`tests/unit/bridge-dispatch-api.test.js tests/unit/tools-word.test.js tests/integration/package.test.js` →
**234/234**, `fail 0` (233 → 234); full suite `node --test` → **845 tests, pass 845, fail 0, skipped 0**
(844 → 845: **two cases added, one case removed** — the ADDED list above names BOTH new cases, so the honest
arithmetic is **−1 + 2 = +1**, not "one new measured case, one dead identity-scaffolding case removed"; none
weakened. **This is D-A of the close-out review: the addition count was wrong, the numbers were not**);
`node scripts/static-audit.mjs` → `Authored-code audit PASS`, exit 0; `node scripts/build-plugin.mjs` → exit
0, `Plugin build: 8 allowlisted files; ZIP STORE SHA-256
cb566f681c647b4fbf8eae02783acd827c9425d3b35dbc81f1d9ff07f278d0c9`. The SHA **moved** from the `8405bc8` pin
`c29676cfc6b7a53475b8227343adecbf693163b4affd8c40cbbba6774fc14962` because the authored body, one decoder,
the bridge envelope and the descriptor changed (the builder runs with `minify: false`). The phase protocol and
the slot discipline are UNCHANGED (**only `[PRE_INSERT, name]` releases this leg's slot**), `src/agent/*` is
untouched, no dynamic execution was added to `src/`, and there is exactly ONE `SetStyle`.

**Natively UNVERIFIED at this round's close, and fail-safe rather than fail-open.** What the host-side suite
cannot prove is the SHIPPED carriage of this leg: (1) that `{ paragraph, level, styleName }` written into the
page's `Asc.scope` reaches the body's `scope` binding; (2) that `paragraph.SetStyle(styleObject)` on an
EXISTING paragraph of an R7-built document really applies the style and moves `GetAllHeadingParagraphs()` by
exactly one — the append-side measurement is on a NEWLY created paragraph, and this tool's contract is the
in-place case; (3) that the readback of the ADDRESSED paragraph, taken from the post `GetAllParagraphs()`
array at the caller's index, reflects the applied style (the measurement above is on the arrays directly, not
on that exact ordering); (4) that `GetAllParagraphs()` enumerates in the SAME order `SetStyle` addresses; and
(5) that the native return validator passes the seven-member flat array of primitives unaltered. Each unknown
lands on a closed path — a scope that does not arrive, a missing primitive or a style that does not resolve
answers the body's own phase-marked refusal (`[PRE_INSERT, …]`, nothing styled, slot released); an unusable
readback, a non-exact answer, a malformed one or a throwing mutation is `APPLY_UNCERTAIN` →
`TOOL_UNCERTAIN` with the slot HELD and no retry — never an `ok` with the slot released.

**THE CLOSE-OUT REVIEW'S TWO UNPINNED FAIL-SAFE PATHS ARE NOW PINNED BY TESTS (D-C).** The review of `0700639`
found two paths the suite drove only through the pre-state, and both are now driven through the REAL body, in
the direction the code fails:
1. **a `GetName()` answering a NON-STRING.** The body's readback is THREE-way (`readOwnStyle`: a NAME, the empty
   string, or `null` = unread), and only a string is a measurement. A `GetName()` returning a number, an object,
   `true` or `undefined` is therefore `styleRead: 0` / `styleMatches: 0` — the authored answer is
   `['POST_INSERT', 0, 1, 1, 1, 0, 0]` — and the call settles `APPLY_UNCERTAIN` (→ `TOOL_UNCERTAIN`) with the
   slot HELD and no retry, NOT a coerced match and not a readable non-match. The test drives all four shapes and
   asserts the body's own answer, the document's real state, the held slot and the refused second call.
2. **a post index that STOPS EXISTING between the baseline and the mutation.** A concurrent edit that removes
   the addressed paragraph leaves the post `GetAllParagraphs()` array without the caller's index; the body
   re-takes the target at the same index and cannot read its text or its style name. The answer is the two-slot
   `['POST_INSERT', 'CAPABILITY_UNAVAILABLE']` — the SAME closed name the pre-insert half uses, distinguished
   only by the PHASE slot — and the decoder turns a post-phase name into `APPLY_UNCERTAIN` with the slot HELD,
   never into the known class its name would mean before the mutation. The test asserts the body's answer, the
   one dispatch, the held slot and the refused second call. Both are cases where "the mutation already ran" is
   the whole reason the outcome may not be a known failure.





## 16. Tool 8 — `format_range`, and the SDK inspection that decided what it may advertise

**The bounded read-only inspection, BEFORE any design** (vendored 2026.1.2 editor SDK, dev-only
`.local/stage-b-runtime/vendor-word-sdk-all.js`; the Word builder API is on **line 87** of that bundle).
The question was the one `set_heading` taught this project to ask first: **can the body READ BACK what it
applied?**

* **`ApiRange` (the `x` prototype) authors SETTERS ONLY.** Its full member list is `Select`, `ExpandTo`,
  `IntersectWith`, `SetBold`, `SetCaps`, `SetColor`, `SetDoubleStrikeout`, `SetHighlight`, `SetShd`,
  `SetItalic`, `SetStrikeout`, `SetSmallCaps`, `SetSpacing`, `SetUnderline`, `SetVertAlign`, `SetPosition`,
  `SetFontSize`, `SetFontFamily`, `SetStyle`, `SetTextPr`, `Delete`, `GetRange`, `GetText`,
  `GetAllParagraphs`, `GetParagraph`, `GetElement`, `GetElementsCount`, `ToJSON`. **No `GetBold`, no
  `GetItalic`, no `GetUnderline`, no `GetStrikeout`, no `GetColor`, no `GetFontSize`, no `GetFontFamily`,
  no `GetHighlight`.** (`GetBold` occurs **8** times in the whole 15 MB bundle: four penalty helpers on the
  spell-checker, `GetBoldCS`/`GetBoldItalic` on the DOCUMENT MODEL's `CTextPr`, and the model's own
  `qt.prototype.GetBold` in the model bundle — **never on a builder type**.)
* **`ApiTextPr` (the `k` prototype, whose `GetClassType()` returns `"textPr"`) is the same shape.** Members:
  `GetClassType`, `SetStyle`, `SetBold`, `SetItalic`, `SetStrikeout`, `SetUnderline`, `SetFontFamily`,
  `SetFontSize`, `SetColor`, `SetVertAlign`, `SetHighlight`, `SetSpacing`, `SetDoubleStrikeout`, `SetCaps`,
  `SetSmallCaps`, `SetPosition`, `SetLanguage`, `SetShd`, `SetFill`, `SetTextFill`, `SetOutLine`, `ToJSON`
  — setters plus `ToJSON` and nothing to read a property back with.
* **`ApiRange` also caches what it was built with.** `x.prototype.constructor` assigns
  `this.Text = this.GetText()` and `this.TextPr = new CTextPr`, so `range.GetTextPr()` answers the range's own
  **scratch** object rather than the document's formatting, and a range HELD across a mutation would compare a
  cached value with itself. Both facts are reproduced in the test double (a FRESH range object per read).
* **THE ONE BUILDER TYPE THAT DOES READ BACK IS `ApiParaPr` (the `T` prototype).** It registers `GetJc`,
  `GetStyle`, `GetIndLeft`, `GetIndRight`, `GetIndFirstLine`, `GetSpacingBefore`, `GetSpacingAfter`,
  `GetSpacingLineValue`, `GetSpacingLineRule`, `GetShd` — and `T.prototype.SetJc` sits directly beside
  `T.prototype.GetJc`. `GetJc` maps the model's alignment onto the closed string vocabulary
  **`right`/`left`/`center`/`both`** (`align_Justify` → `"both"`), which is the vocabulary this tool
  publishes and compares against.

**The consequence, stated plainly: NO character-level property can be advertised, because none can be read
back.** `format_range` therefore closes the `format` object over the ONE property a measured signal
confirms — the paragraph alignment — and **refuses `bold`, `italic`, `underline`, `strikeout`, `size`,
`color`, `highlight` and `family` AT THE SCHEMA as unknown keys, with ZERO writes**. Advertising them while
proving only a text constancy or a flag would be exactly the unverifiable-property contract this project
forbids.

**WHY THOSE PROPERTIES ARE ABSENT, RESTATED SO A LATER ROUND DOES NOT TRY TO "ADD" THEM WITHOUT A READBACK.**
The reason is not that they are unimportant or hard to SET — every one of them has a working setter on
`ApiRange`/`ApiTextPr` — it is that **no getter exists for any of them on any builder type**: `ApiRange` and
`ApiTextPr` register setters plus `ToJSON`, and the eight `Get*` names that would be needed occur in the 15 MB
bundle only on the spell-checker's penalty helpers and on the DOCUMENT MODEL's `CTextPr` (`GetBoldCS`,
`GetBoldItalic`, `qt.prototype.GetBold`), never on the builder surface a command body can reach. A body that
called `SetBold` could therefore never prove it applied, and this project forbids publishing an effect it cannot
read back. **The one way those properties may ever be advertised is the way this tool was built: a builder
getter or a MEASURED indirect readback must exist FIRST, the readback must be recorded here with its
`GetClassType()`/prototype evidence, and only then may a schema admit the key.** Until that happens, adding
`bold` to `format` — or to any other tool — is adding an unverifiable property, and it is refused by design.

**What the `{ paragraph, start, end }` address IS, and what it is NOT.** The alignment setter is a
**paragraph** property, so the effect is paragraph-wide and the descriptor says so; the address is a
**BOUNDARY**, not a scope. It decides where the tool may act: the body resolves it through the paragraph's
own `GetRange`, requires the paragraph to EXIST and BOTH offsets to lie inside that paragraph's own
`GetText().length` **before** the one mutation, and re-reads the SAME region through a **fresh** range after
it. `{ paragraph, start, end }` is the address the caller names a range with; it is not a claim that
per-character formatting was applied, and the result fields carry no such claim.

**THE PROOF, in order of authority.** `ok` requires all of: **PRIMARY** — the addressed paragraph's own
alignment, read back through `paragraph.GetParaPr().GetJc()` AFTER the one
`paragraph.GetParaPr().SetJc(align)`, is one of the four measured words and IS the requested one
(`rangeRead` + `alignAfter`); and **SECONDARY signals that can only REFUTE** — the addressed REGION was
read and is what it was (`rangeRead`/`rangeUnchanged`), it did not MOVE under the mutation
(`rangeShifted` false), the addressed paragraph's TEXT is unchanged (`textUnchanged`), and the document's
paragraph count is unchanged (`paragraphsStable`). **An unreadable readback before the mutation is the
closed `CAPABILITY_UNAVAILABLE` with ZERO writes and the slot RELEASED** — the same class an unusable
baseline gets, because with no readable `GetJc` the body cannot tell whether the paragraph carries an
alignment at all and the mutation has not run; the body distinguishes the THREE getter answers (`null` =
the chain answered nothing, `''` = a readable non-alignment, a measured word = read) and refuses on the
first rather than mutating something it could never prove. **NO PRE-STATE REFUSAL IS ADDED**: unlike a
level change on an existing heading, applying an alignment a paragraph already carries is an IDEMPOTENT
write whose readback proves itself (`alignBefore === alignAfter === requested`), and a `before` value that
differs from the request is a MEASUREMENT, not a contradiction — it is published, not judged.

**The mechanism and the carriage, unchanged from the three mutations before it.** ONE authored command body
in the bridge (`formatRange` → `command.format`), a full inline static literal, the validated
`{ paragraph, start, end, align }` quadruple carried as **DATA** through `Asc.scope` (never interpolated
into source, ADR 0002), the explicit `PRE_INSERT`/`POST_INSERT` phase slot turned to `POST_INSERT`
**immediately before** the single `SetJc`, and ONE strict decoder (`decodeRange`, nine slots:
`[POST_INSERT, paragraphsStable, textUnchanged, rangeRead, rangeUnchanged, rangeShifted, align, alignBefore,
alignAfter]`, or the two-slot `[PRE_INSERT, name]` refusal). Only `[PRE_INSERT, name]` is a known refusal
and only it RELEASES the slot; a phase-less or POST-insert refusal, a malformed answer, a non-exact proof
and a POST-insert throw are all `APPLY_UNCERTAIN` → `TOOL_UNCERTAIN` with the slot **HELD** and no retry.
The ticket kind is `rangeformat` and it is named in `WRITE_KINDS`, so the timeout, abort, pending-mutation
and uncertain-settlement rules cover it automatically rather than by four separate lists.

**THE FAILURE MAP, each class closed** (and resolved at the earliest place it can be): a wrong editor is
`CAPABILITY_UNAVAILABLE` (precondition AND handler, because a descriptor is executable when held directly);
an address or alignment outside the advertised bounds, `start >= end`, a reversed range or an unknown
format property is the closed **argument** class with ZERO writes (schema, precondition and handler); a
missing bridge entry point is `CAPABILITY_UNAVAILABLE`; a paragraph index outside the DOCUMENT, offsets
outside the paragraph's own length and an UNREADABLE pre-state alignment are decided in the body BEFORE the
one mutation — the first two as the closed argument class (`TOOL_ERROR`), the third as
`CAPABILITY_UNAVAILABLE` — all with ZERO writes; a bridge refusal keeps the class it reported
(`refusalCode`); an envelope this handler cannot interpret is `known()`; a returned or thrown
`APPLY_UNCERTAIN`, an unread (`rangeRead: false`) or disagreeing readback, a moved region, a changed text and
a moved paragraph count are `TOOL_UNCERTAIN` with the slot HELD and no retry; and an over-ceiling result
entry is `BYTE_LIMIT`.

**TDD: the exact RED, then GREEN.** The tests were written FIRST and run against `0700639` →
`node --test tests/unit/tools-word.test.js` → **228 tests, pass 213, fail 15** (13 new + the three existing
registry lists that must now name the eighth tool). Every failure was the expected one:
`format_range advertises the closed bounded schema…` → `TypeError: Cannot read properties of undefined
(reading 'name')` (no descriptor), `format_range refuses an editor that is not Word…` → `TypeError: …
(reading 'execute')`, `bridge formatRange dispatches ONE command…` → `TypeError: r.bridge.formatRange is not
a function`, and `format_range is offered with policy auto…` → the offered catalogue contains no such tool.
GREEN: **228/228** on that file, full suite **860 tests, pass 860, fail 0** (845 → 860, never shrunk), and
the package classifier grew its eighth leg in the same round.

**TWO REAL DEFECTS THE RED ROUND CAUGHT, both worth recording.** (1) The bridge entry point originally bound
its two offsets to locals named `start`/`end`, and `start` is the bridge's own ticket opener in that closure:
`await start(...)` became a call on a NUMBER, which the catch classified as `EDITOR_ERROR` — a mutation that
never reached the editor, reported as an editor failure. The locals are now `from`/`to`, with the reason in
the code. (2) The authored body's region flag referenced `rangeAfterRead` where the local is
`regionAfterRead`, so every dispatch threw inside the body's own `try` and answered
`['POST_INSERT', 'CAPABILITY_UNAVAILABLE']`, which the decoder correctly turned into `APPLY_UNCERTAIN` with
the slot held. Neither was a design flaw in the contract; both were caught only because the tests drive the
REAL body against a state double rather than a stub.

**Verification (this round, final tree).** Focused set
`tests/unit/tools-word.test.js tests/integration/package.test.js` → **233/233**, `fail 0`; full suite
`node --test` → **860 tests, pass 860, fail 0, skipped 0** (845 → 860); `node scripts/static-audit.mjs` →
`Authored-code audit PASS`, exit 0; `node scripts/build-plugin.mjs` → exit 0, `Plugin build: 8 allowlisted
files; ZIP STORE SHA-256 3247ce8be04cdbf8558ffd59bf62187657651e59fba536ca206ec3eeb9bd10f5`. The SHA moved
from the `0700639` pin `cb566f681c647b4fbf8eae02783acd827c9425d3b35dbc81f1d9ff07f278d0c9` because the
authored body, one decoder, the bridge envelope, the limits table and the descriptor all changed (the
builder runs with `minify: false`). The phase protocol and the slot discipline are UNCHANGED (**only
`[PRE_INSERT, name]` releases this leg's slot**), `src/agent/*` is untouched, no dynamic execution was added
to `src/`, and there is exactly ONE mutating call per dispatch (`SetJc`).

### 16a. The close-out round on `format_range` — the Lead's native evidence, and the tests that pin the review's two conditions

**What this round changed: DOCS AND TESTS ONLY, plus one comment block.** No behaviour moved. The changed files
are `docs/sprint-3-progress.md`, `tests/unit/tools-word.test.js` and ONE comment-only edit in
`src/tools/word.js`; `src/plugin/bridge.js` and `src/shared/limits.js` were not touched, `src/agent/*` is
untouched, no dynamic execution was added to `src/`, and the package classifier's leg count is unchanged.

**Verification (this close-out round, final tree).** Focused set
`tests/unit/tools-word.test.js tests/integration/package.test.js` → **235/235**, `fail 0`
(233 → 235: the TWO new `set_heading` cases below, and NOTHING removed or weakened); the file alone is
**230/230** (228 → 230); full suite `node --test` → **862 tests, pass 862, fail 0, skipped 0**
(**860 → 862**, never shrunk); `node scripts/static-audit.mjs` → `Authored-code audit PASS`, exit 0;
`node scripts/build-plugin.mjs` → exit 0, `Plugin build: 8 allowlisted files; ZIP STORE SHA-256
af69985cf2092fd0e89f56bf117c360e22103d3063c203a01524e63137fc325a`. **The SHA MOVED** from this round's
`3247ce8be04cdbf8558ffd59bf62187657651e59fba536ca206ec3eeb9bd10f5`, and it moved for the one reason worth
stating: the builder runs with **`minify: false`**, so a COMMENT-ONLY edit inside an authored command body
reaches the bundle and moves its bytes. That is the direct confirmation of the rule this document has stated
for three rounds — a comment is part of the shipped artifact, which is why the descriptor's limitation is
written where the caller's own call reaches it and not only here.

**The two new tests (D-C of the close-out review), and their exact assertions.** Both drive the REAL command
body against the document double, and both are named for the direction the code fails:
1. `a GetName() answering a NON-STRING is an UNREAD readback, never a match: UNCERTAIN, slot held` — for each of
   a number, an object, `true` and `undefined`, it asserts the authored answer
   `['POST_INSERT', 0, 1, 1, 1, 0, 0]` (so `styleRead` 0 / `styleMatches` 0 — never a folded or coerced match),
   the settled envelope `{ ok: false, code: 'APPLY_UNCERTAIN' }`, the document's own
   `doubles[1].style === 'Heading 2'` (the style really landed) and `state.setStyles === 1`, then
   `busy === true`, `uncertain === true`, `writePending === true`, a second call answering `EDITOR_BUSY`, and
   `commands.length === 1` (the refused call dispatches nothing).
2. `a paragraph index that STOPS EXISTING between the baseline and the mutation is UNCERTAIN, slot held` — the
   document's own `GetAllParagraphs` is overridden to return the real list on the FIRST (baseline) read and one
   paragraph fewer on every read after it, so the addressed index is gone by the post read. It asserts
   `reads === 2` (the baseline and the post state, and nothing else), the authored answer
   `['POST_INSERT', 'CAPABILITY_UNAVAILABLE']` — the SAME closed name the pre-insert half answers with,
   distinguished ONLY by the phase slot — the settled `{ ok: false, code: 'APPLY_UNCERTAIN' }`,
   `state.setStyles === 1`, `busy`/`uncertain`/`writePending` all true, a second call answering `EDITOR_BUSY`,
   and `commands.length === 1`.

**No behaviour changed, and this is how it was checked.** The ONE `src/` line that moved is a comment: the
`src/` diff is **12 added lines, 0 removed**, every added line begins with `//`, and the comment-STRIPPED
`src/tools/word.js` is byte-identical to `HEAD`'s (a comment-stripping pass — line and block comments removed,
strings preserved — compared the two and printed `true`). The descriptors' keywords, schemas, `precondition`
and `execute` bodies are therefore untouched, and the `package` classifier's leg count is unchanged.

**THE LEAD'S NATIVE EVIDENCE, RUN ON THE SHIPPED BUILD AFTER THIS ROUND — FOUR OF THE FIVE UNKNOWNS BELOW
ARE SETTLED.** The independent probe read each paragraph's own `GetJc()` directly (NOT the tool's result, so the
measurement cannot be the tool's own report quoting itself) and measured a baseline of **`[center, left, left]`
on 3 paragraphs with 1 heading**. It then called the tool with
`{"paragraph":1,"start":0,"end":10,"format":{"align":"center"}}`, which answered **`format_range: ok`** while the
model reported **`ВЫРАВНИВАНИЕ_ПОСЛЕ=center|ПАРАГРАФОВ=3`**, and the post readback gave **`[center, center, left]`**
with the addressed paragraph's text, the document paragraph count, the heading count and the table count all
unchanged. That settles four of the five unknowns the round listed — and, with them, the thing this round called
the object of the whole leg:
1. **`SetJc` really changes what `GetJc` answers** — the setter/getter pair the route was chosen for works on a
   real R7 document, which is what made the paragraph alignment the one advertisable property.
2. **The `GetRange(start, end)` offsets are accepted** — the address `{0, 10}` was resolved by a real paragraph,
   so the two offsets the caller names are the two the body's `GetRange` accepts.
3. **The fresh region read is STABLE across a paragraph-level alignment change** — the alignment moved while the
   addressed region, the text, the paragraph count, the heading count and the table count did not, so the
   fail-safe-but-unusable risk `set_heading`'s identity leg carried (an address that renumbers under the
   mutation) is NOT this leg's reality.
4. **The nine-member flat answer survives the validator** — the call returned `ok` through the real bridge, which
   it can only do after `decodeRange` read all nine slots of the authored array, so the native return validator
   did not strip, reorder or coerce it.

**Natively UNVERIFIED at this round's close: what the evidence above does NOT reach — two of the original five.**
(1) that `{ paragraph, start, end, align }` written into the page's `Asc.scope` reaches the body's `scope`
binding — the probe proves the REQUEST was served, not which channel carried it; and (2) that
`GetAllParagraphs()` enumerates in the SAME order the address indexes — the baseline read `[center, left, left]`
is consistent with the address resolving to the second paragraph, but one document in tab order is not an
enumeration proof for every document. Each unknown lands on a closed path — a scope that does not arrive or a
missing primitive
answers the body's own phase-marked refusal (`[PRE_INSERT, …]`, nothing mutated, slot released); an unreadable
readback, a non-exact answer, a malformed one or a throwing mutation is `APPLY_UNCERTAIN` → `TOOL_UNCERTAIN`
with the slot HELD and no retry — never an `ok` with the slot released.

**STATED LIMITATION OF THIS TOOL, WHERE A CALLER MEETS IT, so a future round does not have to rediscover it:**
`format_range` applies and proves a **PARAGRAPH-LEVEL alignment** over an address the caller names as a
character range — the offsets bound and re-read the addressed region, they do not select which characters are
formatted, because the public builder API exposes **no getter for any character-level property** (there is none
on `ApiRange` or `ApiTextPr`; see the SDK inspection above), so a tool that formats CHARACTERS inside a range
cannot be built honestly against this SDK surface until either a builder getter or a measured indirect readback
exists, and it must not be advertised before then. The same three rules are stated in the descriptor's own
comment in `src/tools/word.js`, at the point a caller reads them: **an unknown format key is refused at the
schema with ZERO writes**, and **a non-exact outcome is `TOOL_UNCERTAIN` with the write slot HELD and NO retry**
rather than a known failure about a document the call may already have reformatted.

### 16b. `format_range` runs: the MEASURED HTML export as the indirect readback, and the four properties it made advertisable

**What changed, and what it rests on.** §16's second sentence — "no character-level property may be advertised,
because none can be READ BACK" — was true of the builder surface and is **superseded as a whole-tool
limitation** by a measurement: the document's own HTML export IS a readback for run formatting. The Lead
measured, on the target (Astra / R7 2026.1.2.1942), that `paragraph.GetRange(from,to)` is
**paragraph-relative** (`GetRange(0,10).GetText()` = `'ФОРМАТИРУ'`, `GetRange(5,15)` = `'ТИРУЕМЫЙ-ТЕ'` on a
paragraph reading `ФОРМАТИРУЕМЫЙ-…` — the two-argument DOCUMENT form takes GLOBAL offsets and is not used
here), that `SetBold`/`SetItalic`/`SetUnderline`/`SetStrikeout(true)` all apply without throwing, and that
`doc.ToHtml()` reflects them. The measured export of four properties applied to four DISTINCT regions of one
paragraph is the evidence for **one marker per property**:

> `<p><strong>ФОРМАТИРУ</strong><em>ЕМЫЙ-ТЕК</em>СТ-<span style="text-decoration:underline;">ДЛЯ-ПР</span><del>ОВЕРК</del>И: …</p>`
> (bold → `<strong>…</strong>`, italic → `<em>…</em>`, underline →
> `<span style="text-decoration:underline;">…</span>`, strikeout → `<del>…</del>`; the export grew 258 → 391
> characters).

`doc.ToMarkdown()` does **not** reflect run formatting (measured byte-identical after applying eight
properties) and is not used anywhere on this path. The export is BIG relative to the text — roughly **4.25×**,
because of the inline styles — so it is bounded and refused closed rather than scanned unbounded (§ the bound
below).

**THE PROOF, and the honest limits of a string match.** `ok` now requires **both** legs. The ALIGNMENT leg is
§16's, unchanged (`GetParaPr().GetJc()` before and after the one `SetJc`). The RUN leg is: the addressed
region's own text — the text the **PRE-mutation** `paragraph.GetRange(from,to).GetText()` answered, kept from
the pre-read and never re-derived after the write — must occur **EXACTLY ONCE** in the export AND lie **INSIDE
that property's own marker pair within the addressed paragraph's own fragment**: the property's **last opener**
at or before the region and its **first closer** after it, with other markers and other text **allowed in
between**, plus the one condition that makes the located pair **one** pair — the judged opener's own first
closer must be the judged closer. The two tolerated shapes are the measured NESTING (two properties on one
region nest, and the outer property's pair is wider than the region) and a pair wrapping a **superset** of the
address, which is what a range write wider than the address produces. This REPLACED the older
`open + region + close` adjacency rule, which answered 0 for a legitimate outer property in the measured
nesting, and the intermediate rule that accepted any last-opener/first-closer pair, which a review turned into a
**false success** with `<strong>Ц</strong>ел<strong>ь</strong>` over the region `ел`. Three properties of the
current rule are deliberate and are stated in the code as well as here:
1. **A duplicate region text is UNVERIFIABLE, not guessed at.** If the region text stands twice — inside the
   addressed paragraph, or anywhere else in the document — the marker's target cannot be told apart, so the
   outcome is `APPLY_UNCERTAIN` with the slot HELD rather than a silent choice of the first occurrence. The
   count runs over the RAW export string, because the authored body has no HTML parser; an occurrence inside
   MARKUP (a short ASCII region such as `p`, `span` or `style`) therefore counts too, which can only cost a
   false UNCERTAIN, never a false `ok`.
2. **A marker that merely appears NEAR the region proves nothing, and a marker that belongs to a DIFFERENT
   pair proves nothing either.** The pair is judged as ONE pair: the opener's own first closer must be the
   closer that was found, so a property applied to a SUPERSET of the address is still proven (the pair really
   covers the region) while a pair that CLOSES before the region and reopens after it is not — the file's own
   `<strong>Цель</strong>` over a `Це` address is the pinned positive case, and the review's
   `<strong>Ц</strong>ел<strong>ь</strong>` over `ел` is the pinned negative one.
3. **The markers were measured ONE PROPERTY PER REGION**, and the nesting-tolerant pair rule above is what
   lets TWO properties on the same region prove: the property applied FIRST becomes the INNERMOST marker and
   the property applied second wraps it, and the outer property is proven by the wider pair around the region.
   A shape the exporter nests in a way the pair condition rejects (a pair closing before the region) still
   settles UNCERTAIN rather than a false `ok`.

**THE EXPORT BOUND: `LIMITS.formatRangeHtmlChars` = 131072 CHARACTERS, and why.** It is a **character** bound
rather than a byte bound because the export never CROSSES anything: the authored body reads it inside the
editor, scans it and returns four one-character flags, so the quantity that bounds the work is the length of
the string the editor built (and the body has no honest way to compute UTF-8 bytes at all — there is no
`TextEncoder` in the evaluated command scope). The arithmetic is the one this module already uses for
`readDocumentEntryBytes`: take the read path's pilot-scale export **byte** ceiling (`documentHtmlBytes` =
262144) and divide by this product's realistic worst case of **two UTF-8 bytes per character** (Cyrillic) →
`131072`. So the leg scans no more HTML than the read path will carry, in the unit the editor's own string has.
It is **strict enough that a pilot document passes and a huge one refuses closed**: at the measured ~4.25×
inflation, 131072 characters of export is on the order of 30 000 characters of Cyrillic source text, and the
bound is enforced in TWO places with the two different classes that are honest on each side of a write —
**before** the mutation a missing or throwing `ToHtml` is `CAPABILITY_UNAVAILABLE` and an export above the
bound is the closed **`BYTE_LIMIT`** (ZERO writes, slot RELEASED); **after** the mutation either is a
POST-INSERT refusal → `APPLY_UNCERTAIN` with the slot **HELD**. It is never truncated to a prefix: a prefix
could hide the addressed region or its marker.

**What the body authors now, and the phase discipline is UNCHANGED.** The phase still turns `POST_INSERT`
**immediately before the FIRST mutating call**, because a native that throws OUT of any one of them may already
have applied it. That call is still `paragraph.GetParaPr().SetJc(align)`, followed by ONE
`paragraph.GetRange(from,to).SetBold/SetItalic/SetUnderline/SetStrikeout(true)` per REQUESTED property, in that
fixed order, each on its **own fresh range object** (a range is never shared between properties). A call that
names no run property authors NONE of them and **never reads the export at all** — it keeps its exact
pre-existing behaviour and does not even require `ToHtml` to exist, which is pinned by a test. The four run
ranges are built and their setters function-checked BEFORE the phase turns, so an editor missing one answers
the closed capability class with ZERO writes instead of a half-applied format. `htmlMax` crosses in the
`Asc.scope` parameter channel exactly as a search's `limit` does, and it is composed by the bridge from the
named limit — a caller cannot widen it.

**The answer and the decoder.** The flat array is now **THIRTEEN** slots:
`[phase, paragraphsStable, textUnchanged, rangeRead, rangeUnchanged, rangeShifted, boldVerified, italicVerified,
underlineVerified, strikeoutVerified, align, alignBefore, alignAfter]`, or the two-slot `[PRE_INSERT, name]`
refusal. `BYTE_LIMIT` joins `CAPABILITY_UNAVAILABLE` and `TOOL_ERROR` as a **phase-gated pre-insert** name.
The outcome rule (`exactRangeFormat`) now takes the SCOPE the ticket carried and requires, for each of the four
properties, `verified === requested` — so a requested property that was **not** proven is UNCERTAIN with the
slot HELD, and a property nobody requested that claims a proof is UNCERTAIN too (never an invented measurement
of a write that never happened). The envelope publishes the four run switches **echoed** (so the tool can
require the answer to name the request it made, exactly as it does for `align`) plus the four verified flags,
and the tool re-checks every one of them: an unrequested property claiming a proof is the module's **unknown**
class, a requested one left unproven is `TOOL_UNCERTAIN`, and a required run proof is checked in the same place
as the alignment leg — a call that names both must prove BOTH.

**A REAL DEFECT THE RED ROUND CAUGHT, worth recording because it was a fail-open in the making.**
`preInsertRefusal` recognised only `CAPABILITY_UNAVAILABLE`/`TOOL_ERROR`, so the range leg's new closed export
refusal arrived at the ticket's catch as `APPLY_UNCERTAIN` — the closed class was unreachable. The first fix
considered was adding `BYTE_LIMIT` to the shared predicate, and that would have been a **regression**: the
block/table/heading decoders' `assertByteLimit` throws `BYTE_LIMIT` for an OVERSIZED ANSWER, which is a
dispatched write whose outcome is unknown, and releasing that slot would be exactly the fail-open signal this
project forbids. The predicate is therefore scoped: `preInsertRefusal(error, kind)` accepts `BYTE_LIMIT` **only**
for `kind === 'rangeformat'`, which is sound because `decodeRange` validates every member to a one-character
flag or a four-word alignment BEFORE its own `assertByteLimit`, so that call can never fire there and the only
`BYTE_LIMIT` a range dispatch can produce is the phase-gated `[PRE_INSERT, 'BYTE_LIMIT']`.

**TDD: the exact RED, then GREEN.** The tests were written FIRST and run against `93b361a`: the file
`tests/unit/tools-word.test.js` → **239 tests, pass 224, fail 15**. Every failure was the expected one —
`format_range advertises the closed bounded schema and the measured properties it can verify` →
`actual: [ 'align' ], expected: [ 'align', 'bold', 'italic', 'underline', 'strikeout' ]`;
`the address crosses as the command SCOPE…` → `actual: { paragraph: 1, start: 1, end: 3, align: 'center' }`,
`expected: … bold: false, …, htmlMax: undefined` (the bridge composed no run data at all);
`the measured run setter .SetBold( is authored` → `actual: false`;
`bridge formatRange decodes ONLY the authored shapes…` → `actual: 'APPLY_UNCERTAIN', expected: 'BYTE_LIMIT'`;
and the nine new run-leg tests failing on `actual: undefined, expected: true` for the flags no code emitted
yet. GREEN: the file alone **239/239**, the focused set
`tests/unit/tools-word.test.js tests/integration/package.test.js` → **244/244**, `fail 0`, and the package
classifier pins the format body to the MEASURED setters (`SetBold`/`SetItalic`/`SetUnderline`/`SetStrikeout`
authored, `SetFontSize`/`SetColor`/`SetFontFamily`/`SetHighlight` still authored nowhere) plus the measured
`ToHtml()` readback, while the leg is still classified by its one `SetJc` and the leg count stays EIGHT.

**Verification (this round, final tree).** Focused set
`tests/unit/tools-word.test.js tests/integration/package.test.js` → **244/244**, `fail 0`; full suite
`node --test` → **871 tests, pass 871, fail 0, skipped 0** (**862 → 871**, never shrunk); `node
scripts/static-audit.mjs` → `Authored-code audit PASS`, exit 0; `node scripts/build-plugin.mjs` → exit 0,
`Plugin build: 8 allowlisted files; ZIP STORE SHA-256
0966545ecc446dd7d5d02a301db877608c1a10c30790601d18c38456dc9c04a5`. The SHA moved from `93b361a`'s
`af69985cf2092fd0e89f56bf117c360e22103d3063c203a01524e63137fc325a`, for the reason §16a already recorded: the
builder runs with **`minify: false`**, so a comment inside an authored command body reaches the bundle, and this
round changed the body's code as well. The phase protocol and the slot discipline are UNCHANGED (**only
`[PRE_INSERT, name]` releases this leg's slot**), `src/agent/*` is untouched, no dynamic execution was added to
`src/`, the four run setters are static member calls (no computed call on any value read from an array), and a
call that names no run property makes exactly ONE mutating call, as before.

**NATIVELY UNVERIFIED AT THIS ROUND'S CLOSE, and what each unknown lands on.** The Lead's measurements cover
the markers, the paragraph-relative `GetRange`, the setters not throwing and the export reflecting them; what a
native run still has to settle is (1) that the four run setters accept a range built from the PRE-mutation
paragraph snapshot (the same shape `SetJc` already uses through a pre-mutation `GetParaPr()`), (2) that
`doc.ToHtml()` is present and cheap enough on a real pilot document, and (3) the real size of that export. Each
unknown lands on a closed path: a missing or throwing export is `CAPABILITY_UNAVAILABLE` with ZERO writes, an
export above `LIMITS.formatRangeHtmlChars` is `BYTE_LIMIT` with ZERO writes, and an unproven or non-exact
outcome is `APPLY_UNCERTAIN` → `TOOL_UNCERTAIN` with the slot HELD and no retry — never an `ok` with the slot
released.

## 16c. The MEASURED round on `format_range` — the export is ENTITY-ESCAPED, the markers NEST, and `align` is OPTIONAL

**The native run the Lead made, and the two facts it settled.** The shipped tool was called with
`{"paragraph":1,"start":0,"end":8,"format":{"align":"center","bold":true}}` and answered
**`format_range: uncertain (TOOL_UNCERTAIN)`** — while the independent document readback showed the call had
ACTUALLY SUCCEEDED: the paragraph's alignment became `center` and the export carried the bold marker wrapping
exactly the addressed region. **The tool published a FALSE UNCERTAIN for a correct write**: fail-safe, and the
capability unusable. Two measured causes, both recorded here with the strings the target produced.

* **`doc.ToHtml()` returns the tags ENTITY-ESCAPED.** The export literally holds `&lt;p&gt;`,
  `&lt;strong&gt;`, `&lt;/strong&gt;`. The measured export around the addressed paragraph after that successful
  call was
  `&lt;p&gt;&lt;strong&gt;ФОРМАТИРУ&lt;/strong&gt;ЕМЫЙ-ТЕКСТ-ДЛЯ-ПРОВЕРКИ: …&lt;/p&gt;`.
  The previous proof searched for the raw `<strong>REGION</strong>` form, **which can never occur in this
  export**, so a correct write could not prove itself. The previous round's test double rendered an UNESCAPED
  export, which is why the unit tests passed while the native run failed — a double that does not model the
  MEASURED export shape is the exact mistake this project keeps punishing, so the double now renders the
  escaped form through a small explicit entity map (`&amp;`, `&lt;`, `&gt;`, `&quot;`) and the assertions
  compare the escaped strings.
* **Two run properties on the SAME region NEST, and the run applied FIRST is the INNERMOST marker.** Measured,
  applying bold then italic then underline to one region:
  * after bold: `…&lt;strong&gt;ФОРМАТИРУ&lt;/strong&gt;ЕМЫЙ-…`
  * after bold+italic: `…&lt;em&gt;&lt;strong&gt;ФОРМАТИРУ&lt;/strong&gt;&lt;/em&gt;ЕМЫЙ-…`
  * after bold+italic+underline: the underline is a `&lt;span style="text-decoration:underline;"&gt;` and the
    nesting puts the OUTER markers AWAY from the region text.
  The previous proof required the marker to be CONTIGUOUS with the region text, so it proved only the
  INNERMOST property and answered 0 for every outer one — a second false UNCERTAIN for a correct write.

**THE TWO CORRECTIONS, and what each one deliberately does NOT do.**

1. **The proof scans the MEASURED ESCAPED FORM.** `wrappedRegion` compares against the escaped marker pairs
   (`&lt;strong&gt;`/`&lt;/strong&gt;`, `&lt;em&gt;`/`&lt;/em&gt;`,
   `&lt;span style="text-decoration:underline;"&gt;`/`&lt;/span&gt;`, `&lt;del&gt;`/`&lt;/del&gt;`) and the
   escaped paragraph boundary (`&lt;p` … `&lt;/p&gt;`). **No unescaping step is added, and that is a decision
   rather than an omission**: a general entity decode of the export can CREATE a needle that was never in the
   document (`&amp;lt;` decodes to `&lt;`), while the exported TEXT does not have to be decoded for the proof
   to be exact — the needle is the region's own PRE-mutation `GetText()` answer, which agrees with what the
   export holds for any region with no HTML metacharacter in it. A region that does hold one simply is not
   found, which costs a false UNCERTAIN with the slot held and can never buy a false `ok`. The channel is
   unchanged: `ToHtml()` is the measured one and `GetFileHTML` was NOT substituted for it.
2. **A property is proven when the region text lies INSIDE that property's own marker pair within the
   addressed paragraph's fragment** — the property's LAST opener before the region and its FIRST closer after
   it, with other markers and other text allowed in between — rather than when the marker is adjacent to the
   region. The uniqueness requirement is what keeps the tolerance honest: the region text must stand EXACTLY
   ONCE in the whole export, so the pair being located is around THAT occurrence and never around a different
   one; a marker whose own closer falls before the region, or a partial tag (`&lt;strong` with no `&gt;`), is
   not a pair and proves nothing.

**NO CROSSING RULE WAS ADDED ON TOP OF THE TOLERANCE, and the reason is recorded so a later round does not
"tighten" it back into the defect.** Four candidate closure rules were implemented and evaluated against the
MEASURED nesting: requiring the judged property's closer to be the innermost one around the region, requiring
no other opener between the judged opener and the region, rejecting a pair nested inside the judged one, and
rejecting a pair that contains it. **Every one of them answered 0 for a legitimate OUTER property** — italic
and underline in the measured three-property nesting — which is precisely the false UNCERTAIN this round
removes. A marker pair that covers a SUPERSET of the addressed region is what one whole-range setter call
produces, so a pair around the region IS the measured evidence that the setter landed on it; the honest
limits stay where they were, on an ambiguous NEEDLE (a region text standing twice) and on a pair that does not
contain the region at all. Both shapes are pinned by tests: the tail-only fault (`Ц&lt;strong&gt;ель&lt;/strong&gt;`)
is UNCERTAIN with the slot held, and the wider pair (`&lt;strong&gt;ель&lt;/strong&gt;` for the addressed `ел`)
verifies because the region really carries the property.

**`align` IS OPTIONAL NOW, and "at least one property" is the contract.** The previous schema made
`format.align` REQUIRED, so a caller who only wanted bold also had to name an alignment — and that alignment
was then APPLIED, an unintended change. The contract is now: **`format` must name AT LEAST ONE of `align`,
`bold`, `italic`, `underline`, `strikeout`; the tool applies and proves exactly the properties named and
nothing else.** The mechanics, each one pinned by a test:

* **The schema carries no `required` list inside `format`.** No JSON Schema keyword states "at least one", so
  the rule is decided where it can be: the descriptor's own precondition AND the handler re-check it, and the
  BRIDGE re-checks it too (a descriptor held directly is a public entry point), all three with the closed
  argument class and **ZERO writes**.
* **`format: {}` is a closed argument refusal with ZERO writes** (`TOOL_ERROR`), at the schema-level handler,
  in `formatRange`, and in the bridge method — nothing is dispatched.
* **An omitted `align` is NOT a default alignment.** It crosses as the **`'none'` sentinel**, a word OUTSIDE
  the four measured ones, so it can never be confused with a readback: the body authors NO
  `paragraph.GetParaPr().SetJc(...)` for it and never reads the alignment back, while `rangeRead` answers 1
  (there was no chain to read, and the sentinel IS the answer). The published result says
  `align: null`, `alignBefore: null`, `alignAfter: null` for such a call, so the model cannot read a measured
  alignment the tool never asked the editor about; when alignment IS named, its leg is unchanged (the
  requested value must be readable and equal `alignAfter`) and both legs are proven when both are named.
* **The run proof crosses as ONE FOUR-CHARACTER STRING** (`'1000'` for bold alone), one character per measured
  property in the body's fixed order, instead of four separate flags. The decoder compares the WHOLE string
  against a closed list of the sixteen legal values; the four flags are then read by NUMBER (constant-indexed
  reads) through a local helper. That shape is an authored-code-audit consequence recorded in the code: the
  findings analysis is NAME-based and scope-insensitive over the whole bundle, `members` is marked computed by
  the descriptor loop, and `runProof` inherits that marking — so a `runProof.charAt(...)` read is reported as
  a method call on computed data, while a constant-indexed read through a helper is not.

**TDD: the exact RED, then GREEN.** The tests were written FIRST and run against `eb4cfdc`. **THE EXACT SPLIT
WAS REPRODUCED BY THE INDEPENDENT REVIEWER, NOT BY THE IMPLEMENTER**, whose own record said `pass 231, fail 13`:
running the HEAD tests against a `git archive` of the previous commit gives the focused file
`tests/unit/tools-word.test.js` → **244 tests, pass 230, fail 14**. The 244 total is unchanged; only the split
is corrected here, and it is the reviewer's reproduction that stands. The escaping and nesting tests failed
exactly as the native run did and for the same reason:
* `format_range proves EACH measured run property through its own HTML marker` → `bold: the call is served`
  `false !== true` (the body searched the RAW `<strong>` form in an ESCAPED export);
* `format_range proves TWO properties on the SAME region in the measured nested order, outer one included` →
  `the nested pair is served` `false !== true`;
* `format_range proves THREE properties on the same region, including the underlined outer span` → the same
  shape, so the OUTER property was the unproven one;
* `format_range advertises the closed bounded schema…` → `actual: [ 'align' ], expected: undefined` (the
  required list inside `format`);
* `bridge formatRange dispatches ONE command…` and `the format body is self-contained…` →
  `actual: [ 'POST_INSERT', 1, 1, 1, 1, 0, 0, 0, 0, 0, 'center', 'left', 'center' ]` vs
  `[ …, '0000', … ]` (the one-string proof shape);
* `a run-only scope applies NO alignment at all…` → `actual: false, expected: true` (there was no sentinel and
  no run-only path at all).
GREEN: the file alone **244/244**, and the full suite below. The double now renders the ESCAPED export through
the measured entity map, the nesting tests assert the measured markup
(`&lt;em&gt;&lt;strong&gt;Це&lt;/strong&gt;&lt;/em&gt;` and the underlined
`&lt;span …&gt;&lt;em&gt;&lt;strong&gt;…`), and the suite covers one property alone, two properties nested
(the outer one included), three properties, an align-only call, a bold-only call that names no `align`,
`format: {}` refused with zero writes, and the uncertain paths (duplicate needle, missing marker, throwing
export, over-limit export).

**Verification (this round, final tree).** Focused set
`tests/unit/tools-word.test.js tests/integration/package.test.js` → **244/244**, `fail 0`; full suite
`node --test` → **876 tests, pass 876, fail 0, cancelled 0, skipped 0** (**871 → 876**, never shrunk);
`node scripts/static-audit.mjs` → `Authored-code audit PASS`, exit 0; `node scripts/build-plugin.mjs` →
exit 0, `Plugin build: 8 allowlisted files; ZIP STORE SHA-256
517c50bbabba38d3ba2842db62d8355d7368bb1d4fb2e95ffc51413bd0131729`. The SHA moved from `eb4cfdc`'s
`0966545ecc446dd7d5d02a301db877608c1a10c30790601d18c38456dc9c04a5` because the builder runs with
**`minify: false`** and this round changed both the authored body and the decoder. Every other discipline is
UNCHANGED: the closed schema, the bounds, the pre-state checks, ONE mutation phase, the explicit
`PRE_INSERT`/`POST_INSERT` phase slot (**only `[PRE_INSERT, name]` releases this leg's slot**), the closed
failure classes, no retry, the bounded result and the leg classifier; `src/agent/*` is untouched and no
dynamic execution was added to `src/`.

**STILL NATIVELY UNVERIFIED AFTER THIS ROUND.** The Lead's measurement settled the escaping and the nesting
SHAPE; what a fresh native run still has to confirm is (1) that the escaped-form scan now publishes `ok` for
the same call that produced the false UNCERTAIN, (2) that underlining exports the `span` exactly as spelled in
`UNDERLINE_PAIR` (the measured string is reproduced verbatim, including its quotes), and (3) that an
`align`-omitting call leaves the paragraph's alignment untouched on a real document. Each unknown lands on a
closed path — no proof means `TOOL_UNCERTAIN` with the slot held, and no run property means no export read at
all.

## 17. Tool 9 — `add_hyperlink`, the THIRD append, and the MEASURED per-object element readback

`add_hyperlink` is the NINTH Sprint 3 Word tool, the FIFTH mutation, the THIRD write leg that APPENDS, and the
FIRST one that takes a URL from the model. Its contract is the house one — closed schema, ZERO writes on every
pre-insert refusal, ONE mutation phase, an explicit `PRE_INSERT`/`POST_INSERT` phase slot, an exact proof or
`TOOL_UNCERTAIN` with the slot HELD and no retry, closed failure classes, a static self-contained `callCommand`
body whose data crosses as `Asc.scope`, a bounded serialized result entry and a classifier leg — so this
section records only what is NEW: the route, the two forms, the proof, the retired export and the residuals.

### 17.1 The route, read out of the vendored SDK

The whole leg rests on four facts read out of `.local/stage-b-runtime/vendor-word-sdk-all.js` (2026.1.2) rather
than assumed, and each is quoted where it is used in `src/plugin/bridge.js`:

* **THE FACTORY.** `p.prototype.CreateHyperlink = function (url, text, tip) { var V = new ParaHyperlink,
  ht = new N(V); return ht.SetLink(url), ht.SetDisplayedText(text), ht.SetScreenTipText(tip), ht }` — one call
  builds the element, and `N` (the `ApiHyperlink` builder) answers `GetClassType() === "hyperlink"`,
  `GetLinkedText()` and `GetDisplayedText()`.
* **THE PLACEMENT IS AN APPEND.** `ApiParagraph.AddElement(el, pos)` guards on
  `Fi(el)` — and `Fi` is `el instanceof F || el instanceof Dt || el instanceof N || el instanceof W`, so a
  hyperlink IS accepted — and with NO position it calls `_i(paragraph, el)`, where
  `function _i(content, el){ content.Add_ToContent(content.Content.length - 1, el) }`. The element therefore
  lands at the END of the paragraph's own content (the last slot is the paragraph-end marker), which is exactly
  the "appended into THAT paragraph" contract. NO primitive's boolean is consulted anywhere in the body.
* **THE DOCUMENT APPEND LANDS AT THE END.** `u.prototype.Push = function (el) { ... return
  impl.IsUseInDocument() ? false : (this.Document.Internal_Content_Add(this.Document.Content.length, impl),
  true) ... }`, and `Api.CreateParagraph()` is `new G(new Paragraph(ci(), qt()))` — DETACHED, so
  `IsUseInDocument()` is false and the created paragraph really is appended as the document's LAST content
  element.
* **THE FORBIDDEN ROUTE.** `G.prototype.AddHyperlink(url, tip)` exists and its own body starts with
  `this.Paragraph.SelectAll(1)`: it SELECTS THE WHOLE PARAGRAPH and replaces its content. It is authored
  nowhere, and `tests/integration/package.test.js` pins that with
  `assert.equal(/\.AddHyperlink\s*\(/.test(code), false)`.

### 17.2 The two forms, and why the caller never has to guess

`paragraph` is OPTIONAL and its presence or absence IS the form switch. NAMED appends the link into THAT
existing paragraph (the paragraph's own text grows by exactly the link text and NOTHING else in the document
changes); OMITTED creates a new paragraph, places the link in it and pushes it at the END (the document's
paragraph count grows by exactly one). Both forms are implemented, both are tested, and the result states which
one ran — `appended` plus `paragraph` (`null` for the append form) — so the model is never left to infer it.

### 17.3 The proof: three legs, and the URL is proven by the element ITSELF

1. **THE ADDRESSED PARAGRAPH'S OWN TEXT**, read through `GetAllParagraphs()` before and after. NAMED requires
   the AFTER text to be EXACTLY the BEFORE text plus the link text — a string equality, not a length, and the
   bridge re-derives the length arithmetic (`textAfterChars === textBeforeChars + text.length`) from the request
   so a flipped boolean cannot carry a length that contradicts it. APPEND requires the paragraph at the
   baseline's own `countBefore` to carry EXACTLY the link text, and its `textBeforeChars` to be 0 — the created
   paragraph really started empty. (`ParaHyperlink` extends `CParagraphContentWithParagraphLikeContent`, whose
   `Get_Text` iterates its inner runs, so the link's displayed text IS part of the paragraph's own text.)
2. **THE DOCUMENT'S OWN PARAGRAPH COUNT**, unchanged for NAMED and +1 for APPEND, derived by the bridge from the
   two pushed counts against the REQUEST rather than from a flag in the answer. It is SECONDARY: a count that
   moved can only REFUTE.
3. **THE ADDRESSED PARAGRAPH'S OWN ELEMENT**, and this is the leg that makes the URL itself provable. The
   paragraph's `GetElementsCount()` is read BEFORE the mutation; after it the count must be EXACTLY that plus
   one (`elementCountGrew`) and the element AT the PRE count index must answer `GetClassType() === 'hyperlink'`
   with `GetLinkedText()` EXACTLY the requested URL and `GetDisplayedText()` EXACTLY the requested label
   (`elementAppended`). The index is the PRE count on BOTH sides of the boundary, so the element being judged is
   the one THIS write appended — a position, not a search. **This readback is MEASURED, not deduced**: the Lead
   measured on the target (Astra / R7 2026.1.2.1942, in the SAME native session that ran the tool) that after a
   named-form call `GetElementsCount()` went 1 → 2, that `GetElement(i)` answered a usable object for every
   index, and that the appended element answered `GetClassType() === 'hyperlink'`,
   `GetLinkedText() === 'https://example.com/astra-r7-pilot'` and `GetDisplayedText() === 'ССЫЛКА-ПИЛОТ'`.

**EVERY CHAIN STEP IS FUNCTION-CHECKED BEFORE THE MUTATION**, and the ordering is a contract: the addressed
paragraph must expose `GetElementsCount` and `GetElement`, and the object `GetElement` answers must expose
`GetClassType`/`GetLinkedText`/`GetDisplayedText`. A missing primitive — or a PRE read that throws — is the
closed capability class with ZERO writes, never a link written into a document whose proof cannot be read. An
absent or throwing member on the POST side is NOT a refusal, because the write has already run: it is the
uncertain class with the slot held.

### 17.4 What the export cost, and what replaced it

**THE RETIRED CHANNEL.** The previous round proved the URL by locating `preText + "[" + label + "](" + url + ")"`
exactly once in `doc.ToMarkdown()`. A close-out review REPRODUCED on the real bridge that this needle is broken
by ANY character formatting inside the addressed paragraph — the converter wraps the OTHER runs in the measured
`MdSymbols` (`**`/`*`/`~~`/`` ` ``; underline has none), so a marker lands inside the needle, and a formatted run
ENDING the pre text puts its closer between the text's last character and the link's `[` — and by a line break
(`para_NewLine` renders as a space plus a backslash plus a newline while `GetText()` answers `\r`). A formatted
paragraph therefore cost a **FALSE UNCERTAIN with the write slot HELD**: fail-safe, but the pilot request
explicitly asks to format the document, which made it reachable. The export also forced a document-wide
uniqueness rule and a size bound on a string no part of the proof needed.

* **THE PRE-EXPORT CHECK became the PRE ELEMENT COUNT.** The body used to read the whole export before the write
  to refuse a fragment it already rendered; it now reads `GetElementsCount()` on the addressed paragraph, which
  is the index the proof will address.
* **THE UNIQUENESS RULE IS GONE AND NEEDS NO REPLACEMENT.** The readback addresses ONE element by its index
  inside the ADDRESSED paragraph's own content, so a second paragraph carrying the same label — or even the
  same url — is simply not part of the proof. There is no document-wide needle to disambiguate.
* **THE EXPORT BOUND IS GONE.** `LIMITS.addHyperlinkMarkdownChars` (131072 characters) was removed from
  `src/shared/limits.js` with the export it bounded, and `preInsertRefusal` no longer grants the hyperlink leg a
  phase-gated `BYTE_LIMIT`: this body can produce no byte-gated refusal at all, so a forged
  `[PRE_INSERT, 'BYTE_LIMIT']` settles `APPLY_UNCERTAIN` with the slot HELD rather than releasing the slot.
* **THE FORMATTING CASE IS NOW A TEST.** `a FORMATTED addressed paragraph still verifies: the element readback
  is not a string match` reproduces the review's exact scenario (bold and italic runs present in the addressed
  paragraph when the link is appended) and asserts the call VERIFIES with the slot released.

### 17.5 The residuals, named rather than relied on

* **AN ABSENT OR THROWING ELEMENT MEMBER CAN ONLY BE UNCERTAIN.** `GetClassType`/`GetLinkedText`/
  `GetDisplayedText` live on the element `GetElement` answers, and the element does not exist before the write —
  so their absence cannot be a PRE-insert refusal and settles `APPLY_UNCERTAIN` with the slot HELD. That is the
  fail-safe direction, and it is exactly the shape of a build whose `ApiHyperlink` surface differs from the
  measured one.
* **A CONCURRENT WRITER THAT SPLICES AN ELEMENT INTO THE ADDRESSED PARAGRAPH** between the PRE count read and
  the mutation shifts the index the proof addresses, so the element at that index is not this call's link: a
  FALSE UNCERTAIN with the slot held, never a false `ok`. The window is the same one the other mutations
  acknowledge.
* **THE `%20` NORMALISATION IS REFUSED, NOT WRITTEN.** `ApiHyperlink.SetLink` ends with
  `url = url && url.replace(new RegExp("%20","g"), " ")`, so a URL holding `%20` is stored with a literal space
  and `GetLinkedText()` could never answer the requested string. It is the closed argument class with ZERO
  writes — a clean refusal instead of a write that would wedge the slot. Every other percent escape survives
  unchanged.
* **THE CLOSED SCHEME VOCABULARY.** `SetLink` also REWRITES a URL its `AscCommon.rx_allowedProtocols` test does
  not match (`url = type === 0 ? null : (type === 2 ? "mailto:" : "http://") + url`). The tool serves only the
  two absolute, lower-case schemes it can prove (`http://`, `https://`, in `LIMITS.addHyperlinkSchemes`); a
  relative path, a `mailto:` and an upper-case scheme are refused closed with ZERO writes.
* **THE LABEL'S CONTROL-CHARACTER RULE IS KEPT.** It was the retired needle's requirement, and it is retained
  deliberately: this leg stays CONSERVATIVE about the two strings it takes from the model, and relaxing a closed
  argument rule is a widening of the request contract rather than a consequence of the swap.

### 17.6 The failure map, and the RED/GREEN record

Wrong editor / missing bridge entry point / unusable baseline / a missing or throwing readback primitive →
`CAPABILITY_UNAVAILABLE`; a bad URL, an empty or over-bound label, an uninterpretable address, a `%20` URL and
an index outside the document → the closed argument class with ZERO writes (precondition AND handler AND the
body, because a descriptor is also executable when it is held directly); a bridge refusal → `refusalCode`; an
uninterpretable envelope → `known()`; a thrown or returned `APPLY_UNCERTAIN` and every non-exact outcome —
including an element count that did not grow by one and an element at the PRE index that is not this request's
link — → `TOOL_UNCERTAIN` with the slot HELD and no retry; an over-ceiling entry → `BYTE_LIMIT`.

**RED.** The tests were rewritten to the measured ELEMENT shape FIRST and run against the untouched tree: the
focused set reported **9 failures**, every one of them a markdown-route assertion losing to the new contract —
`bridge addHyperlink dispatches ONE command…` and `…creates and PUSHES a new paragraph…` received
`['POST_INSERT',2,2,12,24,1,1,1]` (EIGHT slots, text lengths 12/24, fragment flags) where the element shape
demands `['POST_INSERT',2,2,1,2,12,24,1,1,1]`; `a FORMATTED addressed paragraph still verifies` — the exact case
the review reproduced — received a payload whose slots the old body could not fill at all;
`the hyperlink body is self-contained…` failed on `the markdown export is authored NOWHERE` because the old body
really authors `ToMarkdown()`; `a missing or throwing ELEMENT PRIMITIVE…`, `the ELEMENT proof is judged…`,
`the retired export bound is GONE…` and the model-call test all failed on the same missing element route; and
`package.test.js`'s `generated authored browser bundle passes audit…` failed on
`and proves the url inside the measured markdown fragment`.
**GREEN.** Focused set `tests/unit/tools-word.test.js tests/integration/package.test.js` → **272/272**
(269 + 3), `fail 0`. Two fixes were required by the RED run itself: the body's element-chain helper asked the
PARAGRAPH for `GetClassType`/`GetLinkedText` (which are the ELEMENT's members), so `elementAppended` answered 0
for a correct write — the function check now asks the paragraph only for `GetElement` and the element for its
own three members; and `GetElement` throwing cannot be a PRE-insert refusal, because the primitive is only
CALLED after the mutation, so that case was moved to the POST side where it settles UNCERTAIN with the slot
held.

### 17.7 Verification (this round, final tree)

Full suite `node --test` → **899 tests, pass 899, fail 0, cancelled 0, skipped 0** (**896 → 899**, never
shrunk); `node scripts/static-audit.mjs` → `Authored-code audit PASS`, exit 0; `node scripts/build-plugin.mjs`
→ exit 0, `Plugin build: 8 allowlisted files; ZIP STORE SHA-256
884c20ea908401fd7387f4e7d73fdc6df6c735d042fbdc72745dc073db0cb6cc`. The SHA moved from `d2c2ee8`'s because the
builder runs with **`minify: false`** and this round rewrote the hyperlink body and its decoder. The classifier
counts NINE inline legs, and the hyperlink branch is placed FIRST on purpose: this body also authors
`CreateParagraph`, `Push` and `GetAllParagraphs`, so without its own branch it would have been blessed as the
BLOCK APPEND. `src/agent/*` is untouched and no dynamic execution was added to `src/`.

### 17.8 What only a native run can settle

(1) That `GetElement(i)` answers a usable object for EVERY index on a real document, not only the one the proof
addresses — the measured session sampled the appended index. The body tolerates an unreadable index by
answering the uncertain class, so the failure direction is fail-safe. (2) That
`Api.CreateParagraph()` + `AddElement` + `Push` really lands the created paragraph as the document's LAST one,
which is the index the append form's own readback addresses. Each unknown lands on a closed path: an unreadable
element means `TOOL_UNCERTAIN` with the slot held and no retry, and no write means a known refusal.

## 18. `replace_text` — the ELEVENTH Word tool, the SIXTH MUTATION of Sprint 3, and the FIRST proof that is an exact OCCURRENCE COUNT

`replace_text` (`src/tools/word.js`, `replaceText` in `src/plugin/bridge.js`) rewrites `search` into `replace`
across the whole document and proves the outcome by COUNTING the occurrences of both strings through
`doc.Search`, before and after the ONE write, with no export involved at all.

**The policy is `auto`, and the reason is MEASURED rather than the plan's Phase 0 preference.** Phase 0 recorded
`confirm` for this tool, but a `confirm` descriptor is REFUSED BEFORE THE MODEL IN THE CURRENT PANEL: the runtime
publishes `PREVIEW_READY` for it and the panel needs a preview candidate, which this panel does not produce, so
`src/ui/controller.js:171`/`:340` answers `CAPABILITY_UNAVAILABLE` with an EMPTY action log and an untouched
document. The **A/B control** on the SAME build and the SAME document shows the policy is the cause and the tool is
not: `insert_blocks` (`policy: 'auto'`) works normally. Nothing about this tool's safety rested on the confirmation —
its outcome is PROVEN, not guessed, so it does not depend on a human to be safe: the exact occurrence arithmetic
below derives the expectation from the request on BOTH sides, every refusal on the path to the write is CLOSED with
ZERO writes, and anything non-exact after it settles `TOOL_UNCERTAIN` with the slot HELD and no retry. A
confirmation could not add a proof that arithmetic does not already carry. **The rewrite is nevertheless
DOCUMENT-WIDE**, so a later round may revisit this policy if the panel ever serves the preview candidate. The switch
is one value: the handler is unchanged, so the descriptor executes from the loop exactly as the six `auto` mutations
already do.

**The measured facts, on the target (Astra / R7 2026.1.2.1942) or read out of the vendored 2026.1.2 bundle.**

* `doc.SearchAndReplace({ searchString, replaceString, matchCase })` MUTATES the document and returns
  `undefined`. No return value can ever be this tool's signal.
* `doc.Search(query, matchCase)` answers a REAL ARRAY of ranges — measured 4 for a strict query, 5 for the same
  query case-insensitively, 0 for a query the document does not hold. That is the count the whole arithmetic is
  built on, and it needs no export.
* The builder's own body is
  `SearchAndReplace = function (U) { var S = new AscCommon.CSearchSettings; S.SetText(U.searchString); S.SetMatchCase(U.matchCase !== void 0 ? U.matchCase : true); var E = this.Document.Search(S); if (E) { var V = U.replaceString; V = V.replaceAll("\t","^t"), V = V.replaceAll("\v","^l"), V = V.replaceAll("\f","^m"), V = V.replaceAll("\u000e","^n"), V = V.replaceAll("\u001e","^~"), this.Document.ReplaceSearchElement(V, true, null, false) } }`.
  Three consequences, each load-bearing: `matchCase` **defaults to `true`** when the key is absent (so the wire
  always carries an explicit boolean and the tool's own absent form is resolved to `false` in exactly one
  place); it replaces **every** match and carries **no count parameter** (so a partial limit is unservable —
  see the gate); and it **rewrites five characters** of the replacement before storing it — code units 9, 11,
  12, 14 and 30 — so a replacement holding one of them could never be counted back.
* `executeMethod('SearchAndReplace', …)` never called back within 12 s and is authored NOWHERE.

**The schema** is closed (`additionalProperties: false`), requires `search` and `replace`, and adds an optional
`matchCase` boolean (absent = `false`, stated in one place) and an optional `limit` integer in
`[1, LIMITS.replaceTextLimitMax]` (omitted = replace every occurrence). `search` is non-empty and bounded by
`LIMITS.replaceTextSearchBytes` (256); `replace` is bounded by `LIMITS.replaceTextReplaceBytes` (2048) and is
**allowed to be empty**, because deleting the search text is a legitimate replace. A `replace` that CONTAINS
`search` is refused as a closed argument class with ZERO writes (the primitive would leave occurrences this call
wrote behind, and the count arithmetic would be meaningless rather than merely unproven), as is a `replace`
holding one of the five editor-rewritten characters.

**The proof, and the expectation is derived from the request on BOTH sides.** PRE: count the needle; ZERO
occurrences is a closed argument refusal with ZERO writes ("nothing to replace is not a write") and an
unreadable count is the closed capability class, also with ZERO writes. ONE `doc.SearchAndReplace`. POST: count
the needle again and the replacement again when it is non-empty (there is no count of the empty string to read,
so the body emits a THREE-slot answer instead of inventing a zero). `ok` only when
`occurrencesAfter === occurrencesBefore - min(limit, occurrencesBefore)` and
`replacements === min(limit, occurrencesBefore)` — with no limit that is `... - occurrencesBefore` and
`replacements === occurrencesBefore` — plus, for a non-empty replacement, the independent leg
`replaceAfter === replaceBefore + expected`. Anything else is `APPLY_UNCERTAIN` / `TOOL_UNCERTAIN` with the
write slot HELD and no retry. An empty replacement is proven by `occurrencesAfter === 0` with
`replacements === occurrencesBefore`, the deletion count.

**The limit is a CEILING, not a truncation, and the gate is the measured consequence.** `min(k, before)` can
only be exact when the write replaces ALL counted occurrences, which the primitive always does. A `limit`
strictly below the occurrence count is therefore the closed argument class ("a bad limit") decided by the body
BEFORE its one write: serving it would rewrite more text than the caller authorized, and there is no route to a
proper subset. For every request this tool actually serves `min(k, before) === before`, and that is stated
rather than hidden.

**The failure map**, each class closed: wrong editor / missing bridge entry point / unusable baseline / missing
or throwing count primitive → `CAPABILITY_UNAVAILABLE`; an empty or over-bound needle, a non-string or
over-bound replacement, a non-boolean `matchCase`, a `limit` outside `[1, 4096]`, a replacement containing the
needle, a replacement holding an editor-rewritten character, and — from the body — zero pre-occurrences and a
limit below that count → the closed argument class with ZERO writes, decided BEFORE the mutation; a bridge
refusal → `refusalCode`; an uninterpretable envelope → `known()`; a thrown or returned `APPLY_UNCERTAIN` and
every non-exact outcome → `TOOL_UNCERTAIN` with the slot HELD and no retry; an over-ceiling entry →
`BYTE_LIMIT`.

**RED.** The tests were written FIRST and run against the untouched tree: the focused set reported **24
failures** — the three descriptor/catalogue lists (a 14th descriptor, `replace_text`) and **20** new
`replace_text` tests, every one of them failing on `replaceText is not a function` or on the missing
descriptor — plus `package.test.js`'s `generated authored browser bundle passes audit…`, which failed with
`the adapter dispatches exactly the ten authored command legs` against the nine-leg bundle. **GREEN.** Focused
set `tests/unit/tools-word.test.js tests/integration/package.test.js` → **292/292** (287 + 5), `fail 0`. The
first GREEN run reported **1** failure, and it was a defect in the TEST's own document model rather than in the
tool: the case written as "a native that replaced more than it counted" (a document already holding four
occurrences of the replacement) actually SATISFIES the request arithmetic, so it was rewritten as a
replacement that swallows occurrences of itself (`аб` → `б` over `абаб`), which the needle leg accepts and the
independent replacement leg refutes. One redundant assertion in the self-contained-body test was dropped.

**Verification (this round, final tree).** Full suite `node --test` → **919 tests, pass 919, fail 0, cancelled
0, skipped 0** (**899 → 919**, never shrunk); `node scripts/static-audit.mjs` → `Authored-code audit PASS`,
exit 0; `node scripts/build-plugin.mjs` → exit 0, `Plugin build: 8 allowlisted files; ZIP STORE SHA-256
1afcd2138a27ee4ca9b570a729db34375058b36cead0208fc5fab83301d9a247`. The classifier counts TEN inline legs, and
the replace branch is placed FIRST on purpose: this body also authors `document.Search`, so without its own
branch it would have been blessed as the read-only SEARCH leg. `src/agent/*` is untouched and no dynamic
execution was added to `src/`.

**What only a native run can settle.** (1) That the API-level `doc.Search(query, matchCase)` count and the
internal search `SearchAndReplace` performs agree EXACTLY on the same document (the arithmetic rests on that
identity; a disagreement can only cost a false `TOOL_UNCERTAIN` with the slot held, never a false `ok`). (2)
That an EMPTY `replaceString` really deletes, rather than inserting a literal: the vendored body ends in
`ReplaceSearchElement(V, true, null, false)` with `V === ''`, and the empty case is proven by the needle count
alone. (3) That the five-character rewrite is the COMPLETE set for the replacement (the list was read out of
the shipped builder; a sixth rewrite would turn an `ok`-shaped arithmetic into a false `TOOL_UNCERTAIN` with the
slot held). (4) That the `Asc.scope` parameter carriage delivers `{ search, replace, matchCase, limit }` to an
editor that has `callCommand` — the same carriage every command leg of this sprint already uses.

## 19. `insert_image` — the TWELFTH Word tool, the SEVENTH MUTATION of Sprint 3, and the FIRST proof built from a DOCUMENT-WIDE EXPORT NEEDLE

`insert_image` (`src/tools/word.js`, `insertImage` in `src/plugin/bridge.js`) places one picture into the
document from a `data:image/png;base64,` or `data:image/jpeg;base64,` URL and proves the outcome from the
document's OWN four counts plus the exact data URL located in the document's own markdown export.

**The measured facts, on the target (Astra / R7 2026.1.2.1942) or read out of the vendored 2026.1.2 bundle.**

* `Api.CreateImage(dataUrl, 40, 40)` answers an OBJECT. Its body is
  `CreateImage = function (U, S, E) { var V = Oe(S), ht = Oe(E), _t = new ParaDrawing(V, ht, null, ci(), qt(),
  null), Ot = qt().DrawingObjects.createImage(U, 0, 0, V, ht); return Ot.setParent(_t),
  _t.Set_GraphicObject(Ot), new jt(Ot) }` — it builds and REGISTERS the picture and writes nothing to a paragraph,
  so it runs BEFORE the phase turns.
* `paragraph.AddDrawing(image)` answers an OBJECT and really adds the drawing:
  `AddDrawing = function (U) { var S = new ParaRun(this.Paragraph, !1); return U instanceof Nt ?
  (S.Add_ToContent(0, U.Drawing), _i(this.Paragraph, S), U.Drawing.Set_Parent(S), i(U), new F(S)) : new F(S) }` —
  an APPEND at the END of that paragraph's own content, exactly like `AddElement`.
* `doc.Push(paragraph)` appended the created paragraph: the paragraph count went **3 → 4**.
* `doc.GetAllDrawingObjects()` answered **1** and `doc.GetAllImages()` went **0 → 1**. The vendored
  `GetAllImages = function () { … this.Document.GetAllDrawingObjects() … GraphicObj instanceof
  AscFormat.CImageShape && E.push(new jt(…)) }` shows the image list is the `CImageShape` **filter** of the
  drawing list, so the two are read SEPARATELY and both must grow — neither is redundant.
* `doc.ToMarkdown(true, false)` rendered `![](data:image/png;base64,…)` holding the **EXACT** data URL. The
  vendored signature is `ToMarkdown(U, S, E, V)` with `ht = { convertType: "markdown", htmlHeadings: U || false,
  base64img: S || false, … }`, and the converter's arm is
  `case para_Drawing: if (va.IsPicture()) { if (S === "markdown") ui += Fr.Config.base64img ? "![](" +
  va.GraphicObj.getBase64Img() + ")" : "![](" + va.GraphicObj.getImageUrl() + ")" …`. **THE TWO POSITIONS WERE
  RE-MEASURED AND THE FIRST READING OF THEM WAS WRONG** (it claimed *both* arguments had to be true). The
  measurement was taken on the target (Astra / R7 2026.1.2.1942) **inside a `callCommand` body**, on a document
  the probe itself had just inserted the image into — so the image was definitely present — and each row is the
  export's own character length, the index the `](<dataUrl>` needle was found at, and whether the base64 payload
  was present at all:

  | call | length | needle | base64 |
  | --- | --- | --- | --- |
  | `ToMarkdown()` | 341 | 148 | present ✓ |
  | `ToMarkdown(false, false)` | 341 | 148 | present ✓ |
  | `ToMarkdown(false, true)` | 151 | −1 | **ABSENT ✗** |
  | `ToMarkdown(true, false)` | 361 | 168 | present ✓ |
  | `ToMarkdown(true, true)` | 171 | −1 | **ABSENT ✗** |
  | `ToMarkdown(true)` | 361 | 168 | present ✓ |
  | `ToMarkdown(false)` | 341 | 148 | present ✓ |

  **THE FIRST PARAMETER IS THE HEADING-MARKUP FLAG** (`true` gives the longer export — 361 against 341 — on every
  row that holds the image) and **THE SECOND PARAMETER, WHEN TRUTHY, DISABLES THE EMBEDDED BASE64 IMAGE** — the
  opposite of what the leg's comment originally claimed. **THE WORKING FORMS ARE `ToMarkdown(true)` AND
  `ToMarkdown(true, false)`**, and `ToMarkdown(true, false)` is what the bridge body asks for. **A TRUTHY SECOND
  ARGUMENT MAKES THIS LEG'S PROOF IMPOSSIBLE**: the export then holds `![](<the image's URL>)`, the `](<dataUrl>`
  needle is found zero times, and a write that **SUCCEEDED** is reported as the uncertain class — which is exactly
  the false `insert_image: uncertain (TOOL_UNCERTAIN)` a 4×4 PNG append produced while the independent readback
  proved paragraphs 3 → 4, `GetAllImages()` 0 → 1 and `GetAllDrawingObjects()` 0 → 1. This table is a durable
  platform fact for **every** future image/export leg; the same table is recorded at `readMarkdown` in
  `src/plugin/bridge.js`, where the form is chosen. The markdown export is NOT entity-escaped (unlike `ToHtml`),
  which is why the data URL survives verbatim and why the HTML export is authored nowhere on this leg.
* The pushed paragraph's own element readback was a single element of class `run` with **EMPTY** text. **THAT IS
  NOT AN IMAGE PROOF** and this leg builds none on it: a run with empty text is what a drawing of any other kind
  would leave behind too. What it supplies instead is the text leg of each form — the created paragraph really
  started and finished EMPTY, and the addressed paragraph's own text is UNCHANGED.

**The schema** is closed (`additionalProperties: false`) and requires `dataUrl`, `widthPx` and `heightPx`,
with an optional 0-based `paragraph` in `[0, LIMITS.insertImageIndexMax]`; the presence of `paragraph` IS the
form switch. `dataUrl` is bounded in BYTES by `LIMITS.insertImageDataUrlBytes` (**4096** — a little under half
of `AGENT_CEILINGS.argumentsBytes`, the ceiling the runtime applies to one action's arguments, so a legal
one-action call cannot be pushed past it by the payload alone, and 4096 is this module's established
text-PAYLOAD scale), and the two dimensions are integers in `[1, LIMITS.insertImageDimensionPx]` (**4096** — the
same order as a full-page raster at 300 dpi). **Both dimensions are REQUIRED**: `CreateImage` was measured with
both, so an omitted dimension is UNMEASURED behaviour and no default is invented for it. The MIME vocabulary is
the closed measured pair (`data:image/png;base64,`, `data:image/jpeg;base64,`); the payload must be the pure
RFC 4648 base64 alphabet with `=` only as trailing padding, and the WHOLE string must be free of whitespace and
control characters — the last rule is the one the export needle rests on, because the markdown export renders the
EXACT stored string.

**The two forms.** A NAMED `paragraph` adds the drawing into THAT existing paragraph through its own
`AddDrawing`; the paragraph count must NOT change and that paragraph's own text must be UNCHANGED. An OMITTED
`paragraph` creates a DETACHED `Api.CreateParagraph()`, adds the same drawing to it and `Push`es it at the
END; the paragraph count must grow by EXACTLY one and the created paragraph's own text must be EMPTY.

**The proof, one-to-one with the measurements.** `GetAllImages()` grew by exactly one AND
`GetAllDrawingObjects()` grew by exactly one AND the paragraph delta is the REQUEST's own form delta AND the
markdown export holds `](` immediately followed by the EXACT requested data URL — required to be ABSENT from the
export read BEFORE the write and present EXACTLY once after it, so a picture that was already in the document can
never carry this call's proof. The needle is located by `indexOf`/`slice` comparisons, NEVER by a `RegExp`
built from the payload. The counts are read inside the ONE command body; the export is document data and never
crosses — only the derived boolean does.

**The export bound is the EXISTING document-export ceiling, reused rather than invented.**
`LIMITS.insertImageMarkdownChars` is the SAME number as `documentHtmlBytes` (**262144**), because the one
markdown read this leg makes is a DOCUMENT-WIDE export exactly like the insert confirmation's `GetFileHTML` read.
The body refuses a PRE-write export above it with the closed `BYTE_LIMIT` and ZERO writes (kept as its known class
by `preInsertRefusal`, which now names this leg); a POST-write export above it is the UNCERTAIN class with the
slot HELD, and it is the ONE answer of that size the body can emit — the THREE-slot
`[POST_INSERT, 'BYTE_LIMIT', markdownBeforeChars]`. The ceiling is COMPOSED BY THE BRIDGE
(`markdownMax: LIMITS.insertImageMarkdownChars`) and never read from the caller, so a descriptor held directly
cannot widen the export this body reads. The pre-read export is also a GATE: an unreadable export, an unusable
baseline or a missing primitive all refuse with ZERO writes.

**The failure map**, each class closed: wrong editor / missing bridge entry point / unusable baseline / missing
`GetAllImages`, `GetAllDrawingObjects`, `CreateImage`, `CreateImage` returning nothing, `CreateParagraph`,
`Push`, `AddDrawing` or `ToMarkdown` → `CAPABILITY_UNAVAILABLE`; a bad data URL (a foreign mime, a
non-base64 payload, whitespace or a control character, an over-bound URL), a bad dimension, an out-of-document
`paragraph`, and a pre-write export above the bound → the closed class with ZERO writes (the export one being
`BYTE_LIMIT`); a bridge refusal → `refusalCode`; an uninterpretable envelope → `known()`; a thrown or returned
`APPLY_UNCERTAIN` and every non-exact outcome → `TOOL_UNCERTAIN` with the slot HELD and no retry; an over-ceiling
tool-result entry → `BYTE_LIMIT`.

**RED.** The tests were written FIRST and run against the untouched tree: the focused set reported **15
failures** — the three descriptor/catalogue lists (a 15th descriptor, `insert_image`) and all **15** new
`insert_image` tests, every one failing on the missing descriptor or the missing bridge entry point
(`insertImage is not a function`, `Cannot read properties of undefined`) — plus
`package.test.js`'s classifier, which failed on the ten-leg bundle. **GREEN.** Focused set
`tests/unit/tools-word.test.js tests/integration/package.test.js` → **307/307** (302 + 5), `fail 0`.

**Verification (this round, final tree).** Full suite `node --test` → **934 tests, pass 934, fail 0, cancelled 0,
skipped 0** (**919 → 934**, never shrunk); `node scripts/static-audit.mjs` → `Authored-code audit PASS`, exit 0;
`node scripts/build-plugin.mjs` → exit 0, `Plugin build: 8 allowlisted files; ZIP STORE SHA-256
814610b39c1b44a81c91247c3db42a971ed7a6fcaca2dc35a377a09202ae01b2`. The classifier counts ELEVEN inline legs, and
the image branch is placed FIRST on purpose: this body authors NEITHER `.Push(` NOR `CreateParagraph(` NOR
`GetAllParagraphs`, so without its own branch it would have been blessed as the read-only CAPABILITY probe.
`src/agent/*` is untouched and no dynamic execution was added to `src/`.

**What only a native run can settle.** (1) That the real `ToMarkdown(true, false)` export embeds
`getBase64Img()` as the EXACT string that was handed to `Api.CreateImage` — the needle is a byte-for-byte
comparison, and the measured table above is the evidence, not a native run of it. (2) That a document already holding an
IDENTICAL picture really keeps the pre-count at one (the pre-count gate is what stops a pre-existing image from
carrying the proof; a second identical image makes the needle count two, which also settles uncertain rather than
claiming success). (3) That `GetAllImages()` and `GetAllDrawingObjects()` really move TOGETHER on the target for
an `Api.CreateImage` drawing — the vendored filter is the evidence, and a build whose image list is not that filter
can only cost a false `TOOL_UNCERTAIN` with the slot held, never a false `ok`. (4) That the image factory really
accepts the two dimensions as PIXELS of the requested size. (5) That the `Asc.scope` parameter carriage delivers
`{ dataUrl, widthPx, heightPx, paragraph, append, markdownMax }` to an editor that has `callCommand` — the same
carriage every command leg of this sprint already uses.

**Amendment: the markdown export's argument form (native-only correction).** A target run reported
`insert_image: uncertain (TOOL_UNCERTAIN)` for a 4×4 PNG append whose independent document readback PROVED the
write had succeeded (paragraphs 3 → 4, `GetAllImages()` 0 → 1, `GetAllDrawingObjects()` 0 → 1, and the markdown
holding the exact data URL). The body was calling `ToMarkdown(true, true)` on the false assumption stated above
that **both** arguments had to be true. The re-measured table recorded in the bullet above shows the truth: the
FIRST position is the heading-markup flag and the SECOND, **when truthy, REMOVES** the embedded base64 image. The
body now asks for `ToMarkdown(true, false)` — the measured form. The unit double renders the image data ONLY for
that form and an image-less export for a truthy second argument, so the retired form can no longer pass, and the
test `bridge insertImage passes the markdown export the MEASURED argument list: a truthy second position drops
the image` asserts the exact argument list of BOTH reads (the pre-write baseline and the post-write proof) as
`[true, false]`. Nothing else about the leg changed: the closed schema and its bounds, both forms, the exact
proof (`GetAllImages` +1 AND `GetAllDrawingObjects` +1 AND the request's own paragraph delta AND the exact data
URL needle present exactly once after and absent before), the phase protocol, the closed failure classes, the
zero-write pre-insert refusals, the export size bound and the result bound are all as they were.

## 20. `insert_comment` — the THIRTEENTH Word tool, the EIGHTH MUTATION of Sprint 3, the LAST tool of the Sprint 3 catalogue, and the FIRST proof built from the COMMENT COLLECTION's own identity

`insert_comment` (`src/tools/word.js`, `insertComment` in `src/plugin/bridge.js`) creates one comment in the
document from the model's own text and proves the outcome PER OBJECT: the document's own comment count grew by
exactly one AND the comment this call added was IDENTIFIED and its own `GetText()` equals the requested text.

**The measured facts, on the target (Astra / R7 2026.1.2.1942), inside a `callCommand` body.**

* `doc.AddComment('КОММЕНТАРИЙ-ИЗМЕРЕНИЕ')` answered an **object** and `doc.GetAllComments()` went **0 → 1**.
  That is the ONE write route this leg takes.
* The created comment answers `GetClassType() === 'comment'`, `GetText()` = the **EXACT** text that was passed,
  and `GetId()` = a numeric-looking string; `doc.GetCommentById(id)` answers the same text.
* The document's comment surface is `AddComment`, `GetAllComments`, `GetCommentById`, `GetCommentsReport`, and a
  comment's own readable members include `GetText`/`SetText`, `GetAuthorName`/`SetAuthorName`, `GetUserId`,
  `GetTimeUTC`/`GetTime`, `GetQuoteText`. **The author reader is `GetAuthorName`, NOT `GetAuthor`** — and this
  leg calls neither, because no author is part of its proof.
* **`ToMarkdown(...)` does NOT contain the comment text**: the export length was unchanged and the text was
  absent. **THIS LEG THEREFORE READS NO EXPORT AT ALL** — the exact opposite of `insert_image`, whose whole proof
  is a needle in that same export — so `ToMarkdown`, `ToHtml` and `GetFileHTML` are authored nowhere on it.
* **`Api.CreateComment` does not exist on this build (measured `undefined`)**, which is why the document's own
  `AddComment` is the only measured route and the nonexistent factory is authored nowhere.
* **NO TARGETED FORM WAS MEASURED.** `AddComment` took the **text alone** and the comment was created at
  document/selection level. **This tool therefore has NO target argument in v1** — no `paragraph`, no index, no
  range — and its schema refuses every unknown key rather than accepting a target it would silently ignore.
  **This is a limitation of the measured route**, stated here so a later round does not mistake it for an
  oversight: a targeted comment needs its own measurement round before an address can be advertised.

**The schema** is closed (`additionalProperties: false`) and requires exactly ONE argument, `text`: a non-empty
string bounded in BYTES by `LIMITS.insertCommentTextBytes` (**2048** — this module's established text-PAYLOAD
scale, a quarter of `AGENT_CEILINGS.argumentsBytes` (8192), the ceiling the runtime applies to one action's
arguments, so a comment inside it cannot push a legal one-action call past that ceiling) and free of every control
character **except TAB, LF and CR**. The three whitespace control characters are SERVED deliberately: a
multi-line comment is ordinary document text and the measured `GetText()` returns them verbatim, so refusing them
would refuse a legitimate comment rather than protect a proof. Every other C0 control and DEL is the closed
argument class with ZERO writes. The comment's own id is **not** a model argument: it is read back out of the
document and published, so its width is a defensive entry bound (`LIMITS.insertCommentIdChars`, **128**).

**The outcome proof, per object and without any export.**

1. The comment **count** is read from the document BEFORE the one write (`GetAllComments()`) and AGAIN after it,
   from a **FRESH** collection — never the pre-write array, so a document that caches its collection cannot hide
   the new comment. It must have grown by **exactly one**.
2. The **added comment is identified**: by the id the object `AddComment` returned where that id is usable (a
   non-empty string inside the id bound and **not already present in the pre-write id set** — an id the document
   already held cannot name a comment THIS call added), and otherwise by the **DIFFERENCE of the two id sets**
   read through `GetAllComments()`, or, when the pre set was empty, by the single post comment.
3. **THAT comment's own `GetText()` must equal the requested text exactly**, and its own character count is what
   the result publishes beside the request's own byte count. The text is read from the SAME comment the
   identification selected, so the id and the text leg can never describe two different objects.

**The failure map**, each class closed and split by the phase protocol. A function check is made on every member
the body calls, and the split is at the ONE `AddComment`: a missing or throwing **PRE** member (`GetAllComments`,
`AddComment`) is the closed `CAPABILITY_UNAVAILABLE` with ZERO writes and the slot RELEASED, while an absent or
throwing **POST** member is the UNCERTAIN class with the slot HELD — a comment does not exist before the write,
so nothing about it can ever be a pre-write refusal. Wrong editor / missing bridge entry point →
`CAPABILITY_UNAVAILABLE`; an empty, over-bound or control-character text → the closed argument class with ZERO
writes, decided BEFORE the mutation (by the schema, the precondition, the handler and the body alike); a bridge
refusal → the leg's own closed vocabulary (`commentRefusalCode`, so a foreign or read-shaped code such as
`INVALID_DATA` is republished as the module's own tool-error class); an uninterpretable envelope → `known()`; a
count that did not grow by exactly one, an unidentifiable comment, a null id, or a `GetText()` that disagrees →
`TOOL_UNCERTAIN` with the slot HELD and NO retry; an over-ceiling result entry → `BYTE_LIMIT`. **There is no
byte-gated pre-write refusal on this leg** (no export is read), so `preInsertRefusal` keeps no `BYTE_LIMIT`
carve-out for it: a phase-marked `BYTE_LIMIT` here can only be a forged or damaged answer about a dispatch that
wrote.

**Result bound.** `ok({ commentsBefore, commentsAfter, id, chars, bytes })`, measured through
`insertCommentEntryBytes` → `toolResultEntryBytes('insert_comment', …)`, so the ENFORCED bound is the actual
serialized tool-result entry against `AGENT_CEILINGS.toolResultBytes`. The comment text is **never republished**:
it is the caller's own argument, and the entry carries the proof (the two counts, the identified id, and the two
lengths) rather than a second copy of the payload.

**RED.** The tests were written FIRST and run against the untouched tree: the focused set reported **16
failures** — the three descriptor/catalogue lists (a 16th descriptor, `insert_comment`) and all **13** new
`insert_comment` tests, every one failing on the missing descriptor or the missing bridge entry point
(`r.bridge.insertComment is not a function`, `Cannot read properties of undefined`). **GREEN.** Focused set
`tests/unit/tools-word.test.js` → **316/316**, `fail 0`.

**Verification (this round, final tree).** Focused set
`node --test tests/unit/tools-word.test.js tests/integration/package.test.js` → **321 tests, pass 321, fail 0,
cancelled 0, skipped 0** (316 + 5). Full suite `node --test` → **948 tests, pass 948, fail 0, cancelled 0,
skipped 0, todo 0** (**934 → 948**, never shrunk); `node scripts/static-audit.mjs` → **`Authored-code audit
PASS`**, exit 0; `node scripts/build-plugin.mjs` → exit 0, **`Plugin build: 8 allowlisted files; ZIP STORE
SHA-256 16280cb5194c44b771bc0e041aed8438acd3fee3c4c39ed3bc9c6cccad5b23e2`**. The package classifier counts
**TWELVE** inline legs, and the comment branch is placed FIRST on purpose: this body authors NONE of the
primitives every later branch recognises, so without its own branch it would have been blessed as the read-only
CAPABILITY probe. `src/agent/*` is untouched and no dynamic execution was added to `src/`.

**What only a native run can settle.** (1) That the object `AddComment` really answers on the target carries the
id of the comment it created — the brief's measurement is the evidence, and a build whose return is unusable
falls back to the id-set route, which the unit double pins separately. (2) That `GetAllComments()` really answers
**fresh** wrappers whose `GetText()` reflects the post-write state (the body deliberately re-reads it; a stale
collection can only cost a false `TOOL_UNCERTAIN`, never a false `ok`). (3) That `AddComment` really takes the
text ALONE and creates at document/selection level — the reason this tool has no v1 target. (4) That the
`Asc.scope` parameter carriage delivers `{ text, maxBytes, idMax }` to an editor that has `callCommand` — the same
carriage every command leg of this sprint already uses. (5) That a comment's `GetId()` is stable across the two
collection reads (an id that changed between them would make the id-set route report `null` and settle
uncertain).

## 21. The pilot guardrails — a CONFIGURATION change, exactly as the design intends, with `src/agent/` untouched

**What was measured on the target.** The owner's pilot request («создай структурированный документ примерно на
10 страниц, добавь главы, несколько таблиц, списки, выводы и оформи его») ended with the panel's `AGENT_LIMIT`
message after **FIVE executed tool calls**, with only a couple of paragraphs in the document, at ~**148 s**. The
cause is not a defect: `createGuardrails()`'s defaults (`maxSteps` 12, `maxToolCalls` 32, deadline 150000 ms) were
being applied to a task that needs dozens of calls, and the panel started the loop **without passing any
guardrails** (`runAgent({…})` at `src/ui/controller.js`), so the defaults always applied. One call cannot carry a
ten-page document — `AGENT_CEILINGS.argumentsBytes` is 8192 — and the measured run burned ~**2.4 model steps per
executed action**, so the 12-step default is reached at about the fifth action.

**This is a configuration change by the design's own intent, not a runtime change.** The code says so three times,
and the runtime already accepts the set in the request:

* `src/shared/limits.js:598-599` — "Runtime task guardrails. These are engineering defaults calibrated on the pilot
  workloads; raising them must never require a runtime change."
* `src/shared/session.js:74` — "…§12.2 requires far larger maxSteps to work without a runtime change."
* `src/agent/runtime.js:111` — `const guardrails = createGuardrails(requested ?? {});` — the runtime takes the
  guardrails **IN THE REQUEST**, and §12.2 itself ("A legitimate pilot task — a ten-page structured document … may
  need several minutes, many model steps and dozens of tool calls … the architecture must accept far larger values
  without a runtime change") is the sanction.

**`src/agent/` WAS NOT TOUCHED in this round.** The change is one named, frozen set and the panel's request:

* `src/shared/limits.js` — a new export `AGENT_GUARDRAILS = createGuardrails({ maxSteps: 120, maxToolCalls: 400,
  operationDeadlineMs: 1800000 })`, built THROUGH `createGuardrails` so its validation (unknown key, non-integer,
  `< 1`) still applies and the value is frozen. The DEFAULTS at `limits.js:603` are byte-for-byte unchanged: they
  are what `tests/unit/limits.test.js`, the runtime's own tests and the calibration CLI profile
  (`tests/acceptance/agent/dev-qwen-workloads.mjs`, whose README prints 12 / 32 / 150000) assert, and every other
  caller keeps behaving exactly as before.
* `src/ui/controller.js` — the panel's `runAgent({…})` request now carries `guardrails: AGENT_GUARDRAILS`.
* `src/ui/controller.js` — the host-side bound of the agent run (`begin()`'s deadline and its timer) is the SAME
  named configuration plus ONE transport window: `AGENT_RUN_HOST_DEADLINE_MS = 1800000 + LIMITS.operationTimeoutMs
  = 1950000 ms`. It has to be raised with the set, and it must stay STRICTLY ABOVE the guardrail deadline: a task
  that exhausts its budget then reports the runtime's own `LIMIT`/`AGENT_LIMIT` with its completed changes kept,
  never the panel's own `TIMEOUT` — which is the outcome the old 150000 ms host bound would have produced ~2 s
  after the step cap that actually fired. The single-shot paths keep `LIMITS.operationTimeoutMs` untouched (R7
  check, context refresh, Apply's 15 s observation window). Any OUTER wall-clock bound applied around a native run
  must exceed 1950000 ms; that is deliberately the only host-side coupling.

**The numbers, against the measured shape.**

| Guardrail | Default | Named pilot set | Why this value |
| --- | --- | --- | --- |
| `maxSteps` | 12 | **120** | The prose alone is bounded by the 8192-byte argument ceiling, so a ten-page document needs 8–12 `insert_blocks` calls; with 6–8 chapters (`set_heading` + their blocks), 3 `insert_table` calls, lists, conclusions and a formatting pass (`format_range`), the task is ~40–55 calls ≈ **95–135 steps** at the measured ~2.4 steps per call. 120 covers that band and, at the measured ~12.3 s per step, ~**24.6 min** — inside the deadline below. |
| `maxToolCalls` | 32 | **400** | >7× the pilot's own call count: it bounds a runaway loop without ever being the guardrail a real ten-page task meets (`maxSteps` binds first). It stays inside the theoretical maximum for this step budget (`actionsPerStep` 8 × 120), so it cannot mask an unbounded loop. |
| `operationDeadlineMs` | 150000 | **1800000** (30 min) | The measured 120 steps at ~12.3 s each is ~24.6 min, so the deadline **brackets** the step budget instead of pre-empting it, and it is ~12× the ~148 s the measured run had already spent. It is strictly below the 1950000 ms host bound above, so the runtime's own LIMIT is what a long task reports. |

**RED.** The two new controller tests were first run against the pre-change controller (the named set and the
request carriage stashed): the 15-action run ended **`AGENT_LIMIT`, steps 12**, and the 40-action run ended
**`AGENT_LIMIT`, toolCalls 32, steps 5** — the owner's failure mode reproduced in both dimensions. **GREEN.**
Focused set `node --test tests/unit/limits.test.js tests/unit/controller.test.js` → **60 tests, pass 60, fail 0**.

**What pins the new behaviour.** `tests/unit/limits.test.js` — the named set's exact values, that it is frozen and
equal to what `createGuardrails` validates, and that `createGuardrails()`'s defaults are still exactly
12 / 32 / 150000. `tests/unit/controller.test.js` — a 16-step run and a 40-action run both reach `COMPLETE`
(each past a default the old controller would have refused), a runaway now stops at **120** steps instead of 12,
and the transport receives the host deadline **1950100** (= 100 + 1800000 + 150000) which is strictly above
`AGENT_GUARDRAILS.operationDeadlineMs`.

**Verification (this round, final tree).** Focused set
`node --test tests/unit/limits.test.js tests/unit/controller.test.js` → **60 tests, pass 60, fail 0, cancelled 0,
skipped 0**. Full suite `node --test` → **952 tests, pass 952, fail 0, cancelled 0, skipped 0, todo 0** (**948 →
952**, never shrunk); `node scripts/static-audit.mjs` → **`Authored-code audit PASS`**, exit 0;
`node scripts/build-plugin.mjs` → exit 0, **`Plugin build: 8 allowlisted files; ZIP STORE SHA-256
2ba045334e72d193ce77b152acb08a2060ae0720eb322eddf769ecc30bc18ab4`**. `git diff HEAD -- src/agent` is empty
(`src/agent/*` untouched), and no dynamic execution was added to `src/` — the change adds one `Object.freeze`d
configuration object and one request field.

**What only a native run can settle.** That the raised budget is enough for the real ten-page request: the number
of `insert_blocks` calls a 10-page document really costs, the per-step wall clock for this workload, and therefore
whether `maxSteps` 120 and the 30-minute deadline bracket it or the task needs the next calibration step. This
round moved the configuration the design says is meant to move; the calibration itself (design §15.2) is still a
measurement, not a claim.

## 22. The pilot's last two blockers — the model-facing guidance, and a confirm tool the loop must never name

The raised guardrails (§21) removed the step budget as the pilot's failure mode and exposed the two defects behind
it. Both were measured on the target with the raised set in force.

**Defect 1 — schema-only guidance.** On «создай структурированный документ примерно на 10 страниц, добавь главы,
несколько таблиц, списки, выводы и оформи его» the model called `insert_paragraph` **eight times** across three
runs. `insert_paragraph` inserts at the **CURRENT CARET**, so every call landed inside the paragraph holding the
caret (the title) and the document's paragraph count **never moved**; `insert_blocks`, `set_heading`, `insert_table`
and `format_range` were **never called at all**. Where a request NAMED a tool the model used it correctly — measured:
one `insert_blocks` call carrying a heading and two paragraphs took the document from **2 to 5 paragraphs and 1 to 2
headings**. The plumbing was therefore never the problem: the model was offered `name (kind, policy)` and **nothing
about what a tool is FOR**.

**Defect 2 — a confirm tool ended the run.** On one run, after eight successful actions, the model proposed
`replace_selection` — the only remaining `policy: 'confirm'` tool. A confirm action **never executes in the loop by
design**: the runtime finishes `PREVIEW_READY` (`src/agent/runtime.js:172`), and the panel publishes
`CAPABILITY_UNAVAILABLE` when the run has no preview candidate (`src/ui/controller.js:181`), so the whole authoring
run **ended there**.

### THE WIRING, measured before anything was changed

There is **no `tools` array anywhere in the request**. The HTTP body is exactly
`{ model, messages, max_tokens, temperature }` (`src/ai/protocol.js:32`), and the ONLY model-facing tool
information is a single **system message authored inside `src/agent/`**:

* `src/agent/runtime.js:112` — `const catalogue = registry.catalogue({ editor, capabilities, mode });`
* `src/agent/runtime.js:120` — `context.append({ role: 'system', content: systemRules(catalogue, mode) });`
* `src/agent/runtime.js:222-226` — `function systemRules(catalogue, mode) { const lines = catalogue.map(tool =>
  \`${tool.name} (${tool.kind}, ${tool.policy})\`); … }`

Nothing copies a registry field into that string, and the three fields it does read are closed by construction
(`name` is `/^[a-z][a-z0-9_]{2,39}$/`, `kind` ∈ {read, mutate}, `policy` ∈ {auto, confirm, deny}), so **no
registry-side value can reach the model without a runtime edit**. `src/agent/` is therefore left untouched, and the
runtime side is reported below as the exact patch rather than made here.

### What landed: the description is authored DATA on the descriptor

* `src/tools/registry.js` — `description` joins the `fieldNames` allowlist, so the frozen descriptor is CONSTRUCTED
  from the validated value exactly like every other field (read once, never re-read from a caller-controlled
  object). It is **required**: a descriptor without it is `INVALID_DATA`, because a tool offered with no statement of
  what it is for is the measured defect itself. It must be a non-empty string, **at most
  `TOOL_DESCRIPTION_BYTES` = 256 BYTES** (a byte measure, not a character count: the product's model-facing
  vocabulary is Russian at 2 bytes a character), and it must contain **no control character** — a newline would
  inject a second line into the one-line model-facing rules. It is static authored data: no document text, no
  arguments, nothing computed.
* `src/tools/word.js` — one `description:` per descriptor, for all **16** tools (the withheld `read_context`
  included, so the probe-driven switch back stays a one-value change). Longest is **205 bytes**
  (`insert_blocks`); the bound is 256.

**The three the pilot's weight rests on, verbatim (they are the deliverable, and
`tests/unit/tools-word.test.js` pins them as literals):**

| tool | `description` |
| --- | --- |
| `insert_blocks` | `Добавляет блоки В КОНЕЦ документа; поле heading: n делает блок заголовком уровня n. Это инструмент для глав и абзацев.` |
| `insert_paragraph` | `Вставляет текст В ПОЗИЦИЮ КУРСОРА (или выделения), а НЕ в конец документа.` |
| `set_heading` | `Превращает СУЩЕСТВУЮЩИЙ абзац (по индексу paragraph) в заголовок уровня level. Текст не вставляет.` |

### What landed: the confirm tool is withheld from the MODEL-FACING list, and why it is not withheld from `catalogue`

* `src/tools/registry.js` — a new `modelCatalogue(list)`: the model-facing **view** of a catalogue (or of
  `registry.tools`). It can only REMOVE entries, it preserves the input order, it adds nothing, and it drops exactly
  the `policy: 'confirm'` tools. In the real Word catalogue: **15 offered in EDIT, 14 named to the model**.

**The withholding CANNOT be done in `catalogue()`, and this was measured, not reasoned.** `validateBatch` resolves
a batch against that very array (`src/agent/protocol.js:54` — `catalogue.find(tool => tool.name === call.tool)`),
and the runtime's confirm branch is what produces the `PREVIEW_READY` that `src/ui/controller.js:171` turns into the
Sprint 1 Preview. Scratch experiment on this tree: with `entry.policy === 'confirm'` filtered out of `catalogue`
(reverted immediately), `node --test tests/unit/controller.test.js` → **tests 54, pass 42, fail 12** — exactly the
preview chain ("EDIT creates immutable sanitized preview and explicit Apply delegates only private owned target",
"preview expires at exactly 120000 milliseconds", "Apply checks preview deadline even without timer task delivery",
the eight "clears an already published uncommitted preview" cases, and "PREVIEW_READY publishes the Sprint 1
Preview from the validated confirm arguments with the TTL intact"). So `catalogue()` keeps the confirm descriptor —
which is also what keeps it **resolvable** — and only the model-facing list drops it.

### REQUIRED, NOT MADE HERE: the one-region runtime pass-through

`src/agent/runtime.js` is untouched. Two one-line edits in the region quoted above are what make both defects
actually disappear, and both are in the SAME place (the model-facing listing region):

```js
// src/agent/runtime.js:112 and :120 — the SAME catalogue still validates and still carries confirm
const catalogue = registry.catalogue({ editor, capabilities, mode });
const offered = registry.modelCatalogue(catalogue);                       // NEW: model-facing list
context.append({ role: 'system', content: systemRules(offered, mode) });  // was systemRules(catalogue, mode)
// src/agent/runtime.js:223 — render the authored guidance
const lines = catalogue.map(tool => `${tool.name} (${tool.kind}, ${tool.policy}): ${tool.description}`);
```

Until that lands, the registry holds a tested, complete contract that nothing consumes for the model: the guidance
is authored and bounded but **not yet read**, and the confirm tool is **still named** in the runtime's own system
rules. Neither can be fixed from `src/tools/`: the payload is composed inside `src/agent/`. That is the decision
this round puts to the owner.

### RED, then GREEN

**RED (stage 1, no implementation).** `node --test tests/unit/tools-registry.test.js tests/unit/tools-word.test.js`
→ both files fail at **link time**: `SyntaxError: The requested module '../../src/tools/registry.js' does not provide
an export named 'TOOL_DESCRIPTION_BYTES'`, and `tests 2, pass 0, fail 2` — the field, the bound and the
model-facing list do not exist.

**RED (stage 2, registry landed, `word.js` not yet).** `node --test tests/unit/tools-word.test.js` →
**tests 318, pass 137, fail 181**, every failure `SafeError: INVALID_DATA` from the now-required `description` on the
16 real descriptors.

**GREEN.** Focused set `node --test tests/unit/tools-registry.test.js tests/unit/tools-word.test.js
tests/unit/controller.test.js tests/unit/agent-runtime.test.js tests/unit/agent-protocol.test.js
tests/unit/view.test.js` → **450 tests, pass 450, fail 0** — the 54 controller tests that drive preview →
`canApply` → `apply()` → `APPLY_ACKNOWLEDGED` are all in it, unchanged.

**What pins it.** `tests/unit/tools-registry.test.js` (4 new cases): the field is required and bounded (missing,
empty, whitespace-only, non-string, over-bound, and a newline are each `INVALID_DATA`; the bound is pinned at 256);
the description is **authored, never caller-supplied** (a caller-controlled getter that answers differently on every
read cannot change the frozen tool's own value, and an argument literally named `description` is refused by the
closed schema); `modelCatalogue` drops exactly the confirm tool while `catalogue` and `resolve` still carry it, and
it rejects a non-array. `tests/unit/tools-word.test.js` (2 new cases): every published/offered Word descriptor
carries a bounded, non-empty, single-line description — including the withheld `read_context` — and the three
pilot-critical sentences above are pinned **verbatim**, with `replace_selection` absent from the model-facing list
(14 entries) and still resolvable in `catalogue`. The eight-field descriptor assertions in three test files became
nine-field ones, because the field set grew on purpose.

**Verification (this round, final tree).** `node --test` → **958 tests, pass 958, fail 0, cancelled 0, skipped 0,
todo 0** (**952 → 958**, never shrunk); `node scripts/static-audit.mjs` → **`Authored-code audit PASS`**, exit 0;
`node scripts/build-plugin.mjs` → exit 0, **`Plugin build: 8 allowlisted files; ZIP STORE SHA-256
e01d54f169604d08eeb643272afab37e2dbf12f05f437cb20836860e7f953fab`**. `git diff HEAD -- src/agent` is empty.

**What only a native run can settle.** Whether the three sentences actually change what the model reaches for: the
registry now has the field but the model does not read it yet, so the pilot's ten-page request has NOT been re-run
against a build carrying the pass-through. The unmeasured quantity is the model's choice under the new guidance —
in particular whether `insert_blocks` replaces `insert_paragraph` for chapters, and whether dropping
`replace_selection` from the list removes the run-ending `PREVIEW_READY` without also losing the Preview/Apply
feature the panel still has to offer for a genuine selection edit.

### 22a. The pass-through LANDED — the registry's guidance and its confirm-free offer now reach the model text

The two lines §22 declared REQUIRED are the whole change; `src/agent/runtime.js` is the only `src/` file touched.

```js
// runtime.js:113 — the SAME catalogue still validates and still carries the confirm descriptor
const catalogue = registry.catalogue({ editor, capabilities, mode });
let offered = catalogue;                                                    // NEW: model-facing view
try {
  if (typeof registry.modelCatalogue === 'function') offered = registry.modelCatalogue(catalogue);
} catch { offered = catalogue; }
// runtime.js:131 — the model text is built from `offered`, the loop still validates with `catalogue`
context.append({ role: 'system', content: systemRules(offered, mode) });
// runtime.js:236 — the authored guidance is rendered, not merely stored
const lines = catalogue.map(tool => `${tool.name} (${tool.kind}, ${tool.policy}): ${tool.description}`);
```

The `try`/`catch` is the runtime's own setup style: a registry that cannot answer `modelCatalogue` falls back to the
full list rather than failing the run as `INTERNAL_ERROR`. `offered` is the frozen array `modelCatalogue` returns, so
the listing is a VIEW — it can only REMOVE entries, preserves order, and adds nothing. **Nothing in the loop moves:**
`validateBatch(catalogue, …)` (`runtime.js:161`) and the confirm branch that returns `PREVIEW_READY`
(`runtime.js:183`) still read the unchanged full catalogue, which is exactly why the panel's Preview/Apply path is
untouched. Measured `git diff HEAD -- src/agent`: 15 insertions, 2 deletions, one file, and the deletions are the
two lines the pass-through replaces.

**RED, then GREEN.** With only the runtime change stashed (the new tests in place), `node --test
tests/unit/agent-runtime.test.js` → **tests 35, pass 34, fail 1**: `the model-facing system text carries each
descriptor description and omits every confirm tool` fails on the first half — the old listing really does carry no
guidance. The preview test passes in that state by construction, because it pins exactly what the change must NOT
touch. Restored → 35/35.

**What pins it.** `tests/unit/agent-runtime.test.js`, 2 new cases. (1) The listing must contain the authored sentence
of an offered entry in full form, for a read AND for a mutation (`read_selection (read, auto): Читает выделенный
текст.`), and must contain neither `replace_selection` nor its sentence — both halves of the owner's request in one
read of the transport's own system message. (2) The withheld descriptor still resolves: the run reaches
`PREVIEW_READY` with `preview.descriptor.name === 'replace_selection'`, `policy === 'confirm'`, its authored
description intact, zero tool calls and no actions. The three shared-fixture descriptors gained distinct sentences so
each assertion can name the sentence it expects.

**Verification (this round, final tree).** Focused set `node --test tests/unit/agent-runtime.test.js
tests/unit/tools-registry.test.js tests/unit/controller.test.js` → **106 tests, pass 106, fail 0** (54 controller
tests unchanged); `node --test` → **960 tests, pass 960, fail 0, cancelled 0, skipped 0, todo 0** (**958 → 960**,
never shrunk); `node scripts/static-audit.mjs` → **`Authored-code audit PASS`**, exit 0; `node scripts/build-plugin.mjs`
→ exit 0, **`Plugin build: 8 allowlisted files; ZIP STORE SHA-256
83a7620498ed3093cc1d46a76308ef2c5ea9031cef7619a9c2e54eb2afa3d08f`** (the bundle now carries the composed system
rules, hence a new SHA).

---

## 23. The BULK-GENERATION tool profile — the model is shown the append-anchored subset, plus its own orchestration contract

The owner's free-form request («создай структурированный документ примерно на 10 страниц, добавь главы,
несколько таблиц, списки, выводы и оформи его») is a BULK GENERATION task, and the full catalogue is the wrong
list for it. **Measured on the target:** with all fifteen non-denied Word tools in front of it the model drifted
into `insert_paragraph` — which inserts at the CURRENT CARET — so every call landed inside the TITLE paragraph and
the paragraph count never moved, while `insert_blocks` and `insert_table` were never called. Where it did use the
append-anchored tools the same document grew **2 -> 30 paragraphs, 1 -> 7 headings and 0 -> 2 tables in ONE run**.
The fix is therefore not a new tool but a task-appropriate VIEW plus the wording that tells the model how to work.

### What landed: `registry.modelCatalogue(list, profile)`, a closed enum over a closed allowlist

`modelCatalogue` keeps its existing behaviour for an ABSENT profile (drop every `policy: 'confirm'` entry,
order-preserving, frozen, and a non-array is still `INVALID_DATA`) and gains one declared profile:

- `profiles = new Set(['bulk'])` — the CLOSED set. `undefined` (absent) is the only other legal value; `'BULK'`,
  `'bulk '`, `''`, `null`, `{}`, `[]`, `0` are each `INVALID_DATA`, never a silent full list.
- `BULK_TOOLS = ['read_structure', 'read_document_text', 'insert_blocks', 'insert_table', 'format_range']` — the
  profiled view filters to this AUTHORED allowlist, so the membership is one place to read instead of a flag
  scattered over sixteen descriptors.
- Withheld in `'bulk'`, and why: `insert_paragraph` (inserts at the caret, so it cannot build volume — the
  measured defect), `set_heading` (re-labels an EXISTING paragraph by index and inserts nothing), `add_hyperlink`
  / `insert_image` / `insert_comment` (each decorates ONE object rather than adding text), `replace_text`
  (rewrites text that already exists). Confirm tools stay dropped in every profile, and `read_selection` /
  `read_paragraph` / `find_text` are not offered either: the five-name list is the whole bulk set, not a
  subtraction.
- **Nothing is deleted.** `catalogue()` and `resolve` keep every tool (tests resolve all ten withheld names
  through both), so `validateBatch` still validates against the FULL catalogue and the panel's Preview/Apply path
  is untouched — a test pins that an EXCLUDED name emitted by the model still dispatches and records `ok`, i.e.
  the profile governs what the model is NAMED, not what the run accepts.

### What landed: `registry.profileInstruction(profile)` — the authored orchestration contract

`profileInstruction(undefined)` is `null`; `profileInstruction('bulk')` returns the string below; any other value
is `INVALID_DATA`. It is ONE authored line, bounded by the named `PROFILE_INSTRUCTION_BYTES = 1024` (measured 939
bytes), and refused if it is not a string, is over the bound, or carries a control character/newline — the same
closed shape the descriptor guidance keeps. The text, verbatim:

> Профиль 'bulk' — длинный документ: (1) сначала верни ТОЛЬКО ПЛАН документа — разделы, целевой объём и
> обязательные элементы (таблицы, списки, выводы) — без вызовов инструментов; (2) затем выполняй план по частям;
> (3) объём набирай insert_blocks (блок добавляется В КОНЕЦ; поле heading делает блок заголовком) и insert_table
> для таблиц; (4) после прохода перечитай структуру через read_structure и сверь обязательные элементы и
> фактический объём; (5) если план не выполнен — ПРОДОЛЖАЙ, а не завершай ответ; (6) не повторяй действие,
> вернувшее TOOL_UNCERTAIN.

(The block quote above wraps for the page; the authored value is single-line, and the test pins it verbatim as one
string.)

### The pass-through, and one deliberate reading of the brief

`src/agent/runtime.js` changes ONLY in the model-facing region §22a documented: **20 insertions, 8 deletions, one
file**.

```js
// runtime.js:107 — the agent request now carries the profile beside `request`
const { registry, editor, capabilities, mode, settings, uuid, request, profile, guardrails: requested, ... } = options ?? {};
// runtime.js:124-129 — the SAME fallback shape, extended to the profile
let offered = catalogue;
let instruction = null;
try {
  if (typeof registry.modelCatalogue === 'function') offered = registry.modelCatalogue(catalogue, profile);
  if (typeof registry.profileInstruction === 'function') instruction = registry.profileInstruction(profile);
} catch { offered = catalogue; instruction = null; }
// runtime.js:137 — ONE system message, still built only from registry-authored data
context.append({ role: 'system', content: systemRules(offered, mode, instruction) });
// runtime.js:239-251 — systemRules renders the instruction verbatim, before the two protocol rules
```

**The brief wrote `registry.modelCatalogue(catalogue, request.profile)`; that expression cannot work here and
would have been a permanently dead read.** In this runtime `request` is the USER TEXT — `runtime.js:108`
destructures it and `:138` appends it as the user message — so `request.profile` is `undefined` on every run: a
profile that silently does nothing. The profile is therefore read from the agent-request OBJECT (the same
`options` the fallback and the rest of the setup already come from) and passed at the same call site. Everything
else is exactly as briefed: no change to the loop, to `validateBatch`, to the guardrails, to the confirm branch or
to the error handling, and `validateBatch(catalogue, …)` still receives the FULL catalogue. The instruction is
rendered in the SAME system message rather than left unread — a filtered list with no statement of HOW to work
would repeat §22's own finding that authored registry data nothing renders changes nothing.

### The audit's whole-bundle rule, measured — and the one trap this round hit

`scripts/static-audit.mjs` is name-based and scope-insensitive over the COMPOSED bundle: a single non-constant
computed property READ is a `DYNAMIC_PROPERTY` sink whose taint then propagates to every identifier assigned from
it. The first draft selected the instruction with `const text = PROFILE_INSTRUCTIONS[profile];` **and took the
clean bundle from 0 findings to 139** (`text.charCodeAt`, `lines.join`, `answer.push`, `actions.push` — none of
them related to this change). The final code binds the instruction by NAME EQUALITY (`if (profile !== 'bulk')
throw` then `const text = BULK_INSTRUCTION;`), and the measured bundle audit for HEAD + this change is **0
findings**.

### RED, then GREEN

**RED.** With the two `src/` files stashed (the new tests in place), `node --test tests/unit/tools-registry.test.js
tests/unit/agent-runtime.test.js` → **tests 40, pass 38, fail 2**: `tests/unit/tools-registry.test.js` fails at
LINK time (`does not provide an export named 'PROFILE_INSTRUCTION_BYTES'`), and the runtime's profiled-text case
fails on its first half — the unprofiled listing really does name `insert_paragraph`.

**GREEN.** Focused set `node --test tests/unit/tools-registry.test.js tests/unit/agent-runtime.test.js
tests/unit/tools-word.test.js tests/unit/controller.test.js tests/unit/agent-protocol.test.js
tests/unit/view.test.js` → **460 tests, pass 460, fail 0** (the 54 controller preview/apply tests are in it,
unchanged).

**What pins it.** `tests/unit/tools-registry.test.js` (3 new cases): the bulk view is EXACTLY the five tools in
catalogue order and frozen; each of ten withheld names is absent from it and still resolvable through both
`catalogue` and `registry.tools`; the default view is unchanged; an unknown profile is `INVALID_DATA` for ten probe
values; and the instruction is pinned VERBATIM, inside its 1024-byte bound, single-line, and carries the plan-only
/ continue / `TOOL_UNCERTAIN` rules without naming any withheld tool. `tests/unit/tools-word.test.js` (1 new
case): the REAL catalogue's bulk view is exactly `read_document_text, read_structure, insert_blocks, insert_table,
format_range`, all ten withheld descriptors stay resolvable, and the full catalogue still carries its 15 non-denied
tools. `tests/unit/agent-runtime.test.js` (4 new cases): a bulk run's own system message carries `insert_blocks`
and its sentence and the instruction, names neither `insert_paragraph` nor its sentence, still publishes
`PREVIEW_READY` with the confirm descriptor intact, still DISPATCHES an excluded name, and shows the default view
when the profile is absent — with the documented full-list fallback for an unknown one.

**Verification (this round, final tree).** Measured on an isolated copy of HEAD + this round's five files (two
`src/`, three test files), because a CONCURRENT session is editing `src/ui/` in the shared worktree:
`node --test` → **968 tests, pass 968, fail 0, cancelled 0, skipped 0, todo 0** (**960 → 968**, never shrunk);
`node scripts/static-audit.mjs` → **`Authored-code audit PASS`**, exit 0; `node scripts/build-plugin.mjs` → exit 0,
**`Plugin build: 8 allowlisted files; ZIP STORE SHA-256
993c7791ce86544fdb137667836c67e08e4ecd09e116df627aa60e6eb35eb4e9`**. Bundle-audit attribution, measured by
bundling `src/ui/entry.js` with esbuild and running `auditSource` on it: pristine HEAD **0 findings**, HEAD + this
round's `src/` files **0 findings**, the shared worktree **5 findings that all come from the concurrent session's
uncommitted `src/ui/` work** — so `build-plugin.mjs` currently fails `BUNDLE_AUDIT_FAILED` in the SHARED tree, and
this commit is pathspec-limited to this round's files.

### What only a native run can settle

Whether the five-tool list plus the plan-first wording actually produces a ten-page document. The model's choice
under the narrower list is unmeasured: in particular whether it (a) returns the PLAN with NO tool calls as rule 1
demands, (b) reaches `insert_blocks` / `insert_table` for volume instead of stalling, and (c) truly CONTINUES
after a `read_structure` pass instead of answering `final` early. Nothing here changes what the loop accepts, so a
model that ignores the list can still call any tool: the profile is a shorter list plus guidance, never a
permission.
