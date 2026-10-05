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
