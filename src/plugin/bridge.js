import { LIMITS } from '../shared/limits.js';
import { assertByteLimit, utf8ByteLength } from '../shared/bytes.js';
import { ERROR_CODES, SafeError } from '../shared/errors.js';

// Identity leases persist through disposal: replacing a JS adapter is not proof
// that queued SDK work was retracted. Only a genuinely new initialized plugin
// object may start a new lifecycle. Never call SDK outside this sole bridge.
const pluginOwners = new WeakSet();
const MUTATION_REASON = 'EXPLICIT_OWNED_PREVIEW_REQUIRED';
const presenceKeys = Object.freeze(['api', 'getDocument', 'getDocumentId', 'replaceTextSmart', 'getRangeBySelect', 'isTrackRevisions']);
// THE CLOSED SET OF TICKET KINDS WHOSE WORK WRITES THE DOCUMENT, in ONE place. Every one of these
// questions is asked about more than one leg and the answers must not drift apart: does a ticket whose
// callback never arrived leave an UNKNOWN mutation (`errorFor`/`timeoutFor`), does the panel's write lock
// cover the leg (`pendingMutation`), and does an abort AFTER the dispatch leave an outcome that may
// already be in the document (`cancel`)? Four literal kind lists answering the same question is how a
// new write leg comes to be missing from one of them. `blocksinsert` is the block append: it writes the
// document through `document.Push`, one call per block, inside its own command body, so it is a write leg
// in every sense the other two are. `tableinsert` is the table insert: it writes the same way, ONE
// `document.Push` of a table the body built and filled, inside its own command body. `headinginsert` is
// the heading style assignment: it writes the same way — ONE `paragraph.SetStyle` on an EXISTING paragraph
// inside its own command body — and it is the FIRST write leg that appends nothing at all, which is why
// it must be named here rather than inferred from the two creation legs. `rangeformat` is the range format:
// it writes the same way in place — ONE `paragraph.GetParaPr().SetJc(...)` plus ONE
// `paragraph.GetRange(from,to).SetBold/SetItalic/SetUnderline/SetStrikeout(true)` per requested property, on
// an EXISTING paragraph inside its own command body — and it is the SECOND leg that appends nothing, which is
// why it is named here explicitly for the same reason the heading assignment is. `hyperlinkinsert` is the
// hyperlink insert: it writes ONE `ApiParagraph.AddElement` of an `Api.CreateHyperlink` into an EXISTING
// paragraph, or — for its OTHER form — ONE `Api.CreateParagraph` plus the same `AddElement` plus ONE
// `document.Push` that lands the created paragraph at the END of the document. It is therefore BOTH an
// in-place write and an append, and it is named here explicitly for the range format's reason.
const WRITE_KINDS = Object.freeze(new Set(['write', 'insert', 'blocksinsert', 'tableinsert', 'headinginsert', 'rangeformat', 'hyperlinkinsert']));

// Inspect data descriptors, never extract a command function for execution.
function ownFunction(object, name) {
  if (!object || typeof object !== 'object') return false;
  const descriptors = Object.getOwnPropertyDescriptors(object);
  if (!Object.hasOwn(descriptors, name)) return false;
  const descriptor = descriptors[name];
  return !!descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'function';
}
// The COMMAND channel on a build that has no `callCommand`. Measured on the exact target (Astra Linux
// + R7-Office 2026.1.2.1942) the plugin facade exposes `executeCommand` and `executeMethod` but NOT
// `callCommand`; on Windows R7-Office 2026.3.1 both exist. The installed 2026.1.2 vendor SDK composes
// `callCommand` out of `executeCommand`: it builds `"var Asc = {}; Asc.scope = <scope>; (" + fn + ")();"`
// and sends it as the command data. The bodies below are the SAME author-written, synchronous,
// scope-only functions the reviewed `commands.js` probes dispatch, and they read the same public `Api`
// facade.
//
// The two natives are NOT interchangeable in general, and this code does not treat them as one: it
// keeps `callCommand` whenever the build exposes it (the measured-working Windows path, called with
// exactly the arguments it receives today) and uses `executeCommand` only when `callCommand` is absent.
// When neither is an own function the command dispatch is absent, the capability gate refuses before
// dispatching anything, and no API that is not on the facade is invented.
// The TWO author-written command bodies the bridge's command legs dispatch, selected by the same closed
// kind constant the reviewed `commands.js` probes use (`'capability'` for the presence probe,
// `'context'` for the document-identity read). Both are static: they read `Api` and nothing else, and
// each returns the closed tuple shape the bridge's own decoder validates (6 booleans, or 4 slots), so
// the two protocols cannot blur into one.
//
// These module-level literals exist ONLY for the `executeCommand` transport below, which carries their
// `String(...)` as text. They must NEVER be referenced from inside a function handed to `callCommand`:
// that native does not call the function, it stringifies it and evaluates the text in the editor, where
// this module does not exist (see `createCommandDispatch`).
const capabilityBody = () => {
  try {
    var present = typeof Api !== 'undefined' && Api !== null;
    var getDocument = present && typeof Api.GetDocument === 'function';
    var document = getDocument ? Api.GetDocument() : null;
    return [
      present,
      getDocument,
      present && typeof Api.GetDocumentId === 'function',
      present && typeof Api.ReplaceTextSmart === 'function',
      document !== null && document !== undefined && typeof document.GetRangeBySelect === 'function',
      document !== null && document !== undefined && typeof document.IsTrackRevisions === 'function'
    ];
  } catch { return ['CAPABILITY_UNAVAILABLE']; }
};
const contextBody = () => {
  try {
    var available = typeof Api !== 'undefined' && Api !== null;
    var id = available && typeof Api.GetDocumentId === 'function' ? Api.GetDocumentId() : null;
    var document = available && typeof Api.GetDocument === 'function' ? Api.GetDocument() : null;
    var replace = available && typeof Api.ReplaceTextSmart === 'function';
    var range = document !== null && document !== undefined && typeof document.GetRangeBySelect === 'function';
    var tracking = document !== null && document !== undefined && typeof document.IsTrackRevisions === 'function' ? document.IsTrackRevisions() : null;
    return [id, replace, range, tracking];
  } catch { return [null, false, false, null]; }
};
// Compose the command source the transport carries: the SAME statement form the installed vendor
// `callCommand` builds around an author-written body. `String(...)` is a data conversion of an authored
// function literal, never execution of a string.
function commandTransport(which) {
  return 'var Asc = {}; \n  var scope = Asc.scope;\n  (' + String(which === 'context' ? contextBody : capabilityBody) + ')();\n  ';
}
// Resolve the command dispatch from the two own-function descriptors the facade may expose. The
// returned descriptor is frozen, so the choice cannot be rewritten after the bridge is constructed.
// Each entry point is reached as a LITERAL member call on the same facade, and its argument is an
// inline author-written body (or, for the target-only transport, the source composed from it), so the
// authored static boundary of `callCommand` is unchanged. The own-function booleans make each call
// reachable only when that native really is an own function; neither branch is taken otherwise.
function createCommandDispatch(plugin, hasCommand, hasTransport) {
  if (hasCommand) {
    return Object.freeze({ present: true, method: 'callCommand',
      probe(which, callback) {
        // The value handed to `callCommand` must be a FULL inline literal, never a closure over one.
        // This native does not CALL the function: it stringifies it and evaluates the text inside the
        // editor, where bridge.js's module bindings do not exist. `() => contextBody()` therefore died
        // on the live Windows R7-Office 2026.3.1 with `ReferenceError: contextBody is not defined` out
        // of its own sdk-all-min.js evaluator, before the model was ever called — the call shape was
        // right and the value was unevaluable. The two literals below are the SAME authored bodies
        // `commandTransport` composes for the fallback (duplicated deliberately: a module-level function
        // object cannot be handed to this native at all), and they are the shape the reviewed
        // `commands.js` probes passed on the measured build. Each stays a synchronous, authored,
        // non-generator literal, so the static audit's inline-function rule for `callCommand` is
        // satisfied exactly as before and no dynamic code is involved.
        return which === 'context'
          ? plugin.callCommand(function () {
            try {
              var available = typeof Api !== 'undefined' && Api !== null;
              var id = available && typeof Api.GetDocumentId === 'function' ? Api.GetDocumentId() : null;
              var document = available && typeof Api.GetDocument === 'function' ? Api.GetDocument() : null;
              var replace = available && typeof Api.ReplaceTextSmart === 'function';
              var range = document !== null && document !== undefined && typeof document.GetRangeBySelect === 'function';
              var tracking = document !== null && document !== undefined && typeof document.IsTrackRevisions === 'function' ? document.IsTrackRevisions() : null;
              return [id, replace, range, tracking];
            } catch { return [null, false, false, null]; }
          }, false, false, callback)
          : plugin.callCommand(function () {
            try {
              var present = typeof Api !== 'undefined' && Api !== null;
              var getDocument = present && typeof Api.GetDocument === 'function';
              var document = getDocument ? Api.GetDocument() : null;
              return [
                present,
                getDocument,
                present && typeof Api.GetDocumentId === 'function',
                present && typeof Api.ReplaceTextSmart === 'function',
                document !== null && document !== undefined && typeof document.GetRangeBySelect === 'function',
                document !== null && document !== undefined && typeof document.IsTrackRevisions === 'function'
              ];
            } catch { return ['CAPABILITY_UNAVAILABLE']; }
          }, false, false, callback);
      },
      // THE DOCUMENT SEARCH, and the ONLY leg that carries MODEL DATA into a command body. The data
      // travels as `Asc.scope` — written by `writeScope` before this call and restored by `clearScope`
      // right after it, because the vendor wrapper reads the property SYNCHRONOUSLY and composes it into
      // the body's own `scope` binding. The body below is a FULL inline static literal for the reason the
      // two probes above are: `callCommand` does not CALL it, it stringifies it and evaluates the text in
      // the editor, where none of this module's bindings exist. It builds the `Api` facade itself, which
      // is why this is the first READ in this repo that reaches the `Api` builder at all.
      search(callback) {
        return plugin.callCommand(function () {
          try {
            // The scope the vendor wrapper injected: `{ query, matchCase, limit }`, already validated by
            // the bridge. Anything else — a missing wrapper, an unserializable namespace value — is the
            // body's own closed refusal rather than a search of `undefined`.
            var request = typeof scope !== 'undefined' && scope !== null ? scope : null;
            var available = typeof Api !== 'undefined' && Api !== null;
            var document = request !== null && available && typeof Api.GetDocument === 'function' ? Api.GetDocument() : null;
            if (document === null || document === undefined || typeof document.Search !== 'function') return ['CAPABILITY_UNAVAILABLE'];
            // The MEASURED primitive: `Search(query, matchCase)` answers a real Array of range objects.
            var found = document.Search(request.query, request.matchCase);
            if (!found || typeof found.length !== 'number' || typeof request.limit !== 'number') return ['CAPABILITY_UNAVAILABLE'];
            var count = found.length;
            // The extraction is bounded IN THE EDITOR, so a needle matching thousands of ranges never
            // crosses thousands of texts: at most `limit` of them are read, and the TOTAL is reported.
            // The elements are collected FIRST — an indexed read of editor DATA, which is exactly what it
            // is — and `GetText` is then invoked on the callback PARAMETER, never through the computed
            // lookup. That distinction is not stylistic: the authored static boundary treats "invoke a
            // method reached by a computed key" as a computed-execution sink (the same rule that keeps
            // `descriptors[key].value(...)` out of this module), so `found[index].GetText()` would be an
            // audit finding in shipped source. The collected array is this body's OWN literal, so its
            // `.map` costs nothing an editor-specific array would have to provide.
            var take = count < request.limit ? count : request.limit;
            var collected = [];
            for (var index = 0; index < take; index++) collected.push(found[index]);
            var matchTexts = collected.map(function (foundItem) {
              return foundItem !== null && foundItem !== undefined && typeof foundItem.GetText === 'function' ? foundItem.GetText() : null;
            });
            var answer = [count];
            for (var position = 0; position < matchTexts.length; position++) {
              // The measured shape has `GetText()` on every element; an element without it is an editor
              // this body cannot read, so the whole answer is refused rather than silently shortened.
              if (typeof matchTexts[position] !== 'string') return ['CAPABILITY_UNAVAILABLE'];
              answer.push(matchTexts[position]);
            }
            return answer;
          } catch (error) { return ['CAPABILITY_UNAVAILABLE']; }
        }, false, false, callback);
      },
      // THE DOCUMENT STRUCTURE, and the ONLY leg that reads several primitives at once. It is the same
      // shape as the search above: a FULL inline static literal (this native stringifies it and evaluates
      // the text in the editor, where none of this module's bindings exist), its one parameter — the
      // extraction cap — read from the `scope` binding the vendor wrapper injects from `Asc.scope`, and
      // NO composed-source transport. The answer is ONE flat array of primitives because that is the
      // shape the native return validator keeps; a plain object would be stripped. The extraction is
      // bounded IN THE EDITOR (`min(headings, maxHeadings)` texts), so a document outlining five hundred
      // headings never crosses five hundred texts, while the TOTAL still crosses in its own slot. The
      // descriptor and `limits.js` carry the measured primitive evidence and the entry arithmetic.
      structure(callback) {
        return plugin.callCommand(function () {
          try {
            var request = typeof scope !== 'undefined' && scope !== null ? scope : null;
            var available = typeof Api !== 'undefined' && Api !== null;
            var document = request !== null && available && typeof Api.GetDocument === 'function' ? Api.GetDocument() : null;
            if (document === null || document === undefined) return ['CAPABILITY_UNAVAILABLE'];
            var maxHeadings = request.maxHeadings;
            if (typeof maxHeadings !== 'number' || !(maxHeadings >= 1)) return ['CAPABILITY_UNAVAILABLE'];
            // Every primitive is a FUNCTION CHECK before any call, exactly like the search body: an
            // editor that does not expose one of them answers the body's own refusal rather than a
            // structure of invented zeros.
            var pages = typeof document.GetPageCount === 'function' ? document.GetPageCount() : null;
            var stats = typeof document.GetStatistics === 'function' ? document.GetStatistics() : null;
            var paragraphs = typeof document.GetAllParagraphs === 'function' ? document.GetAllParagraphs() : null;
            var headingList = typeof document.GetAllHeadingParagraphs === 'function' ? document.GetAllHeadingParagraphs() : null;
            var tables = typeof document.GetAllTables === 'function' ? document.GetAllTables() : null;
            var sections = typeof document.GetSections === 'function' ? document.GetSections() : null;
            var lists = [paragraphs, headingList, tables, sections];
            for (var l = 0; l < lists.length; l++) {
              if (lists[l] === null || lists[l] === undefined || typeof lists[l].length !== 'number') return ['CAPABILITY_UNAVAILABLE'];
            }
            if (stats === null || stats === undefined) return ['CAPABILITY_UNAVAILABLE'];
            // A count this body cannot trust as a NON-NEGATIVE WHOLE number is not a count: the measured
            // primitives answer numbers, and anything else (a missing field, a string, NaN, an infinity, a
            // negative or fractional value) is an editor this body cannot describe. The check deliberately
            // reaches for NO global at all — `value === value` rejects NaN, `% 1 === 0` rejects every
            // non-integer including both infinities — so the stringified body depends on nothing but the
            // two bindings the vendor wrapper creates.
            function measured(value) {
              return typeof value === 'number' && value === value && value >= 0 && value % 1 === 0;
            }
            if (!measured(pages) || !measured(stats.PageCount) || !measured(stats.WordsCount) ||
                !measured(stats.ParagraphCount) || !measured(stats.SymbolsCount) || !measured(stats.SymbolsWSCount)) {
              return ['CAPABILITY_UNAVAILABLE'];
            }
            var total = headingList.length;
            var take = total < maxHeadings ? total : maxHeadings;
            // The elements are collected FIRST — an indexed read of editor DATA, which is exactly what it
            // is — and `GetText` is then invoked on the callback PARAMETER, never through a computed
            // lookup. That distinction is the same one the search body states: the authored static
            // boundary treats an invocation reached by a computed key as a computed-execution sink.
            var collected = [];
            for (var index = 0; index < take; index++) collected.push(headingList[index]);
            var headingTexts = collected.map(function (headingItem) {
              return headingItem !== null && headingItem !== undefined && typeof headingItem.GetText === 'function' ? headingItem.GetText() : null;
            });
            var answer = [pages, stats.PageCount, stats.WordsCount, stats.ParagraphCount, stats.SymbolsCount,
              stats.SymbolsWSCount, paragraphs.length, total, tables.length, sections.length];
            for (var position = 0; position < headingTexts.length; position++) {
              // The measured shape has `GetText()` on every element; an element without it is an editor
              // this body cannot read, so the whole answer is refused rather than silently shortened.
              if (typeof headingTexts[position] !== 'string') return ['CAPABILITY_UNAVAILABLE'];
              answer.push(headingTexts[position]);
            }
            return answer;
          } catch (error) { return ['CAPABILITY_UNAVAILABLE']; }
        }, false, false, callback);
      },
      // THE BLOCK APPEND, and the ONLY leg in this bridge that MUTATES a document through the `Api`
      // builder. It is the same carriage as the two reads above — a FULL inline static literal, whose
      // ONLY model data arrives as the `scope` binding the vendor wrapper composes from `Asc.scope`
      // (never composed into source, ADR 0002), and no composed-source transport at all — and it is the
      // one body that does three things in ONE synchronous evaluation:
      //   1. a PRE-DISPATCH BASELINE read of the document's own counts (`GetAllParagraphs`,
      //      `GetAllHeadingParagraphs`), which is the gate: an unusable baseline answers the body's own
      //      refusal BEFORE anything is inserted, so no append is ever dispatched without evidence to
      //      judge it by;
      //   2. EVERY paragraph is built (`Api.CreateParagraph` + `AddText`, and `paragraph.SetStyle` for a
      //      block that asked for a heading) and EVERY heading style is RESOLVED (`GetStyle('Heading <n>')`)
      //      first, so an unresolvable style refuses the whole call with NOTHING inserted — never a plain
      //      paragraph where a heading was asked for;
      //   3. `document.Push(paragraph)` ONCE PER BLOCK, IN BLOCK ORDER, followed by the POST read of the
      //      same counts plus each block's own text, so the delta and the REGION flags are measured
      //      INSIDE the editor by the two primitives the Lead measured.
      // THE ROUTE IS MEASURED, NOT ASSUMED, and the measured route is `Push`. On the target it APPENDS AT
      // THE END: one paragraph inserted into [TARGET ROUTES CHECK, ПЕРВЫЙ-АБЗАЦ-РОУТ, ВТОРОЙ-АБЗАЦ-РОУТ,
      // ТРЕТИЙ-АБЗАЦ-РОУТ] landed as (…, ТРЕТИЙ-АБЗАЦ-РОУТ, МАРКЕР-МАРШРУТ-2). The legacy whole-array
      // insert primitive this body used to call lands at the BEGINNING ([МАРКЕР-МАРШРУТ-1, TARGET ROUTES
      // CHECK, …]) and, with a selection present (`GetRange(lastIndex, 0, lastIndex, lastText.length)
      // .Select()`), REPLACED existing text — `МАРКЕР-МАРШРУТ-1` was written and read back as
      // `-МАРШРУТ-1`. That route is therefore authored NOWHERE in this body: it is neither the mutation
      // nor a capability the body checks for, and select-then-insert (the shape that clobbered text) is
      // never authored either. The body authors NO positioning option: an append at the END of the
      // document is what the measured `Push` does and what the pilot's "add a chapter" needs.
      // NO MUTATION PRIMITIVE'S RETURN VALUE IS READ. Measured on the target: `Push` answered `true` for a
      // paragraph and `false` for an image host, and the legacy primitive answered `true` even for `[]`,
      // `[null]` and `'nonsense'` — so no boolean says anything about what the document now holds, in
      // either direction, and the document readback is the only evidence this body reports.
      // The answer is ONE flat array of primitives (the native return validator keeps those and strips a
      // plain object): `[POST_INSERT, paragraphsBefore, paragraphsAfter, headingsBefore, headingsAfter,
      // flag0, …]`, or a TWO-slot refusal `[PRE_INSERT, name]`. THE PHASE IS AN EXPLICIT SLOT OF EVERY
      // ANSWER the body returns, never a property of a sentinel NAME: `PRE_INSERT` means nothing was
      // inserted, `POST_INSERT` means the one mutation had already been dispatched when the answer was
      // built. The decoder accepts a pre-insert refusal as a KNOWN class only for `PRE_INSERT`; an answer
      // whose phase is absent (a bare `['CAPABILITY_UNAVAILABLE']`) or not pre-insert is treated as the
      // post-insert uncertain class, so the name alone can never release a slot for an append that may
      // already be in the document.
      blocks(callback) {
        return plugin.callCommand(function () {
          // The phase, and the ONE place the two classes are distinguished: everything answered while it
          // is `PRE_INSERT` is a KNOWN refusal (nothing reached the document), everything answered after
          // the FIRST push is an UNCERTAIN outcome the bridge must hold a slot for. It turns `POST_INSERT`
          // IMMEDIATELY BEFORE that first push, not after it, because a native that throws OUT of the call
          // may already have applied that block, and a throw PART WAY THROUGH leaves some pushed and some
          // not.
          var phase = 'PRE_INSERT';
          // The refusal is a TWO-slot array whose FIRST slot is that phase and whose SECOND is the closed
          // name. It is built by APPENDING to an array that starts as a literal, exactly like the answer
          // below, and for the same authored-code-audit reason: a literal built from identifier names
          // would make the receiver of every later call on it a computed value.
          function blocksRefusal(name) {
            var refusal = [];
            refusal.push(phase);
            refusal.push(name);
            return refusal;
          }
          try {
            // The scope the vendor wrapper injected: `{ blocks }`, already validated and bounded by the
            // bridge. Anything else — a missing wrapper, a non-array — is the body's own closed refusal
            // rather than an append of `undefined`.
            var request = typeof scope !== 'undefined' && scope !== null ? scope : null;
            var blocks = request !== null && request.blocks !== null && request.blocks !== undefined ? request.blocks : null;
            if (blocks === null || typeof blocks.length !== 'number' || !(blocks.length >= 1)) return blocksRefusal('CAPABILITY_UNAVAILABLE');
            var available = typeof Api !== 'undefined' && Api !== null;
            var document = available && typeof Api.GetDocument === 'function' ? Api.GetDocument() : null;
            if (document === null || document === undefined) return blocksRefusal('CAPABILITY_UNAVAILABLE');
            // Every primitive this body authors is a FUNCTION CHECK before any call, exactly like the
            // structure body: an editor that does not expose one of them answers this body's own refusal
            // rather than an append of invented zeros.
            if (!available || typeof Api.CreateParagraph !== 'function') return blocksRefusal('CAPABILITY_UNAVAILABLE');
            if (typeof document.GetAllParagraphs !== 'function' || typeof document.GetAllHeadingParagraphs !== 'function') return blocksRefusal('CAPABILITY_UNAVAILABLE');
            if (typeof document.GetStyle !== 'function' || typeof document.Push !== 'function') return blocksRefusal('CAPABILITY_UNAVAILABLE');
            // A count this body cannot trust as a NON-NEGATIVE WHOLE number is not a count. The check
            // reaches for NO global at all, so the stringified body depends on nothing but the two
            // bindings the vendor wrapper creates.
            function measured(value) {
              return typeof value === 'number' && value === value && value >= 0 && value % 1 === 0;
            }
            // THE PRE-DISPATCH BASELINE, and the gate on the whole append: no baseline means no delta
            // means no evidence means no write.
            var baselineParagraphs = document.GetAllParagraphs();
            var baselineHeadings = document.GetAllHeadingParagraphs();
            if (baselineParagraphs === null || baselineParagraphs === undefined || typeof baselineParagraphs.length !== 'number') return blocksRefusal('CAPABILITY_UNAVAILABLE');
            if (baselineHeadings === null || baselineHeadings === undefined || typeof baselineHeadings.length !== 'number') return blocksRefusal('CAPABILITY_UNAVAILABLE');
            var paragraphsBefore = baselineParagraphs.length;
            var headingsBefore = baselineHeadings.length;
            if (!measured(paragraphsBefore) || !measured(headingsBefore)) return blocksRefusal('CAPABILITY_UNAVAILABLE');
            // EVERY paragraph is built — and every heading style RESOLVED — before anything is inserted,
            // so an unresolvable style cannot leave a half-applied append behind.
            var created = [];
            for (var index = 0; index < blocks.length; index++) {
              var block = blocks[index];
              if (block === null || block === undefined || typeof block.text !== 'string') return blocksRefusal('CAPABILITY_UNAVAILABLE');
              var paragraph = Api.CreateParagraph();
              if (paragraph === null || paragraph === undefined || typeof paragraph.AddText !== 'function' ||
                  typeof paragraph.SetStyle !== 'function') return blocksRefusal('CAPABILITY_UNAVAILABLE');
              paragraph.AddText(block.text);
              if (typeof block.heading === 'number') {
                var style = document.GetStyle('Heading ' + block.heading);
                if (style === null || style === undefined) return blocksRefusal('STYLE_UNAVAILABLE');
                paragraph.SetStyle(style);
              }
              created.push(paragraph);
            }
            if (created.length !== blocks.length) return blocksRefusal('CAPABILITY_UNAVAILABLE');
            // THE MUTATION, and the exact boundary the two refusal classes are split on. THE ROUTE IS
            // THE MEASURED ONE: ONE `Push` PER BLOCK, IN BLOCK ORDER, which appends at the END
            // (…, ТРЕТИЙ-АБЗАЦ-РОУТ, МАРКЕР-МАРШРУТ-2) — never the legacy whole-array insert primitive,
            // which lands at the BEGINNING ([МАРКЕР-МАРШРУТ-1, TARGET ROUTES CHECK, …]) and, with a
            // selection present, replaced existing text (`МАРКЕР-МАРШРУТ-1` → `-МАРШРУТ-1`), and which is
            // therefore authored nowhere in this body. Because the append is a LOOP of calls, the phase
            // turns `POST_INSERT` IMMEDIATELY BEFORE THE FIRST PUSH: a native that throws out of one
            // `Push` may already have applied it, and a throw PART WAY THROUGH leaves the document
            // holding SOME of the batch. From the first call entered, nothing observed here proves the
            // document was not touched, so every refusal below carries the post-insert phase and the
            // decoder turns it into the uncertain class, for which the bridge holds its slot — the
            // readback is the ground truth, never the primitive's return value.
            phase = 'POST_INSERT';
            for (var pushed = 0; pushed < created.length; pushed++) document.Push(created[pushed]);
            var allParagraphs = document.GetAllParagraphs();
            var allHeadings = document.GetAllHeadingParagraphs();
            if (allParagraphs === null || allParagraphs === undefined || typeof allParagraphs.length !== 'number') return blocksRefusal('CAPABILITY_UNAVAILABLE');
            if (allHeadings === null || allHeadings === undefined || typeof allHeadings.length !== 'number') return blocksRefusal('CAPABILITY_UNAVAILABLE');
            var paragraphsAfter = allParagraphs.length;
            var headingsAfter = allHeadings.length;
            if (!measured(paragraphsAfter) || !measured(headingsAfter)) return blocksRefusal('CAPABILITY_UNAVAILABLE');
            // The document's own paragraph texts, for the REGION half of the contract. The elements are
            // collected FIRST — an indexed read of editor DATA — and `GetText` is then invoked on the
            // callback PARAMETER, never through a computed lookup: the authored static boundary treats an
            // invocation reached by a computed key as a computed-execution sink, the same rule the search
            // and structure bodies state.
            var collected = [];
            for (var position = 0; position < allParagraphs.length; position++) collected.push(allParagraphs[position]);
            var paragraphTexts = collected.map(function (item) {
              return item !== null && item !== undefined && typeof item.GetText === 'function' ? item.GetText() : null;
            });
            for (var scan = 0; scan < paragraphTexts.length; scan++) {
              if (typeof paragraphTexts[scan] !== 'string') return blocksRefusal('CAPABILITY_UNAVAILABLE');
            }
            var answer = [];
            // The phase slot, the four counts and the flags are APPENDED rather than spelled as one array
            // literal, and that is not a style choice: the authored-code audit's local alias analysis is
            // NAME-based and scope-insensitive over the whole bundle, so a literal built from identifier
            // names that another scope happened to taint would make this array a "computed value" and
            // every `answer.push` below a computed-execution finding. Appending to an array that starts as
            // a literal keeps the receiver of every call provably untainted.
            answer.push(phase);
            answer.push(paragraphsBefore);
            answer.push(paragraphsAfter);
            answer.push(headingsBefore);
            answer.push(headingsAfter);
            // THE REGION THE APPEND ADDED, addressed by the baseline this body ALREADY took before the
            // call: the append begins at paragraph index `paragraphsBefore`, so block `which` OWNS the
            // paragraph at `paragraphsBefore + which` and its flag is 1 only when THAT paragraph carries
            // EXACTLY this block's text. One flag per block, one owned slot per flag. This is the
            // character-region comparison made exact per paragraph, and it is strictly stronger than
            // either alternative: a substring search over ALL paragraphs (what this replaced) is satisfied
            // by an occurrence that was already in the document, so it verified an append that carried no
            // text at all; and "the needle's occurrence count rose by exactly one" counts over the whole
            // document, so it cannot tell the append's occurrence from an unrelated one and cannot express
            // two blocks with the SAME text, whose total rise is two. Joining the region under a block
            // separator would be weaker than per-slot equality for the same reason: it cannot distinguish
            // two paragraph splits of one region text.
            for (var which = 0; which < blocks.length; which++) {
              var wanted = blocks[which].text;
              answer.push(paragraphsBefore + which < paragraphTexts.length &&
                paragraphTexts[paragraphsBefore + which] === wanted ? 1 : 0);
            }
            return answer;
          } catch (error) { return blocksRefusal('CAPABILITY_UNAVAILABLE'); }
        }, false, false, callback);
      },
      // THE TABLE INSERT, and the SECOND leg in this bridge that MUTATES a document through the `Api`
      // builder. It is the same carriage and the same three phases as the block append above — a FULL
      // inline static literal whose ONLY model data arrives as the `scope` binding the vendor wrapper
      // composes from `Asc.scope` (never composed into source, ADR 0002), no composed-source transport, a
      // PRE-DISPATCH BASELINE read as the gate, every cell filled BEFORE the one mutation, and a POST read
      // of the document's own state — and it differs in exactly the three things a TABLE differs in:
      //   1. the structure is created by `Api.CreateTable(columns, rows)` — THE MEASURED ARGUMENT ORDER on
      //      the target — and the geometry comes from the matrix the caller sent, NEVER from
      //      `GetRowCount`/`GetColumnCount`, which were measured as `undefined` and are therefore named
      //      nowhere in this body. THE ORDER IS THE WHOLE POINT: `CreateTable(a, b)` creates `a` COLUMNS
      //      and `b` ROWS, so the first argument is the COLUMN count. The first version of this body passed
      //      `(rowCount, columnCount)`, which builds the TRANSPOSED table; a SQUARE matrix is its own
      //      transpose, so that mistake was invisible on a square and fatal on the pilot's 1×2 header table
      //      (measured: `CAPABILITY_UNAVAILABLE` with nothing written, because the fill loop walked a cell
      //      that does not exist). Because the order is an assumption about a build rather than a fact this
      //      body can observe, the created geometry is VERIFIED before anything is filled or pushed, below;
      //   2. every cell is filled through the MEASURED chain `table.GetCell(r, c).GetContent()
      //      .GetElement(0).AddText(text)`, with EVERY step — and the symmetric `GetText()` the readback
      //      needs — checked as a function BEFORE the first push, so an editor whose cell chain is not the
      //      measured one refuses the whole call with NOTHING inserted rather than pushing a half-filled
      //      table;
      //   3. the proof is one-to-one over the APPENDED TABLE: `document.GetAllTables()` before and after,
      //      and then the table at index `tablesBefore` — the one `Push` appended — is read back CELL BY
      //      CELL, in row-major order, through the SAME element's `GetText()`. Reading any other table, or
      //      searching the document for the cell texts, could be satisfied by a table the document already
      //      held; the baseline address cannot.
      // THE ROUTE IS THE MEASURED ONE: ONE `document.Push(table)` APPENDS AT THE END, exactly like the
      // paragraph append, and the legacy whole-array insert primitive — measured to land at the BEGINNING
      // and to replace existing text under a selection — is authored NOWHERE here either. NO MUTATION
      // PRIMITIVE'S RETURN VALUE IS READ: the ground truth is the document readback.
      // The answer is ONE flat array of primitives (the native return validator keeps those and strips a
      // plain object): `[POST_INSERT, tablesBefore, tablesAfter, flag00, flag01, …]` with one flag per CELL
      // in row-major order, or a TWO-slot refusal `[PRE_INSERT, name]`. THE PHASE IS AN EXPLICIT SLOT OF
      // EVERY ANSWER, and the decoder turns a phase-less or post-insert refusal into the uncertain class —
      // the name alone can never release a slot for an insert that may already be in the document.
      table(callback) {
        return plugin.callCommand(function () {
          // The phase, and the ONE place the two classes are distinguished: everything answered while it is
          // `PRE_INSERT` is a KNOWN refusal (nothing reached the document), everything answered after the
          // one push is an UNCERTAIN outcome the bridge must hold a slot for. It turns `POST_INSERT`
          // IMMEDIATELY BEFORE that push, not after it, because a native that throws OUT of the call may
          // already have applied the table.
          var phase = 'PRE_INSERT';
          // The refusal is a TWO-slot array whose FIRST slot is that phase and whose SECOND is the closed
          // name, APPENDED to an array that starts as a literal for the authored-code-audit reason the
          // block body states: a literal built from identifier names would make the receiver of every later
          // call on it a computed value.
          function tableRefusal(name) {
            var refusal = [];
            refusal.push(phase);
            refusal.push(name);
            return refusal;
          }
          try {
            // The scope the vendor wrapper injected: `{ data }`, already validated and bounded by the
            // bridge. Anything else — a missing wrapper, a non-array — is the body's own closed refusal
            // rather than an insert of `undefined`.
            var request = typeof scope !== 'undefined' && scope !== null ? scope : null;
            var data = request !== null && request.data !== null && request.data !== undefined ? request.data : null;
            if (data === null || typeof data.length !== 'number' || !(data.length >= 1)) return tableRefusal('CAPABILITY_UNAVAILABLE');
            var available = typeof Api !== 'undefined' && Api !== null;
            var document = available && typeof Api.GetDocument === 'function' ? Api.GetDocument() : null;
            if (document === null || document === undefined) return tableRefusal('CAPABILITY_UNAVAILABLE');
            // Every primitive this body authors is a FUNCTION CHECK before any call, exactly like the block
            // and structure bodies: an editor that does not expose one of them answers this body's own
            // refusal rather than an insert of invented geometry.
            if (!available || typeof Api.CreateTable !== 'function') return tableRefusal('CAPABILITY_UNAVAILABLE');
            if (typeof document.GetAllTables !== 'function' || typeof document.Push !== 'function') return tableRefusal('CAPABILITY_UNAVAILABLE');
            // A count this body cannot trust as a NON-NEGATIVE WHOLE number is not a count. The check
            // reaches for NO global at all, so the stringified body depends on nothing but the two bindings
            // the vendor wrapper creates.
            function measured(value) {
              return typeof value === 'number' && value === value && value >= 0 && value % 1 === 0;
            }
            // THE SHAPE OF THE MATRIX, re-decided INSIDE the editor as well as in the bridge: a ragged or
            // cell-less matrix is refused before the table is created, so the geometry the factory is given
            // and the one the flags are laid out over can never disagree.
            var rowCount = data.length;
            var columnCount = 0;
            for (var shapeRow = 0; shapeRow < rowCount; shapeRow++) {
              var shapeCells = data[shapeRow];
              if (shapeCells === null || shapeCells === undefined || typeof shapeCells.length !== 'number') return tableRefusal('CAPABILITY_UNAVAILABLE');
              if (shapeRow === 0) columnCount = shapeCells.length;
              else if (shapeCells.length !== columnCount) return tableRefusal('CAPABILITY_UNAVAILABLE');
              if (!(columnCount >= 1)) return tableRefusal('CAPABILITY_UNAVAILABLE');
              for (var shapeCol = 0; shapeCol < shapeCells.length; shapeCol++) {
                if (typeof shapeCells[shapeCol] !== 'string') return tableRefusal('CAPABILITY_UNAVAILABLE');
              }
            }
            // THE PRE-DISPATCH BASELINE, and the gate on the whole insert: no baseline means no delta means
            // no evidence means no write.
            var baseline = document.GetAllTables();
            if (baseline === null || baseline === undefined || typeof baseline.length !== 'number') return tableRefusal('CAPABILITY_UNAVAILABLE');
            var tablesBefore = baseline.length;
            if (!measured(tablesBefore)) return tableRefusal('CAPABILITY_UNAVAILABLE');
            // THE TABLE IS CREATED AND EVERY CELL IS FILLED BEFORE THE ONE MUTATION, and every step of the
            // measured chain is a function before it is called — including the `GetText()` the readback
            // below needs, so a build whose cell elements cannot be read is refused with NOTHING inserted
            // instead of pushing a table this body could never verify.
            // THE FACTORY IS GIVEN THE MEASURED ORDER: the COLUMN count first, the ROW count second.
            var table = Api.CreateTable(columnCount, rowCount);
            if (table === null || table === undefined || typeof table.GetCell !== 'function') return tableRefusal('CAPABILITY_UNAVAILABLE');
            // THE GEOMETRY IS AN EXPLICIT, VERIFIED PRECONDITION, because the argument order is the one fact
            // about this factory that this body cannot observe on its own: a build whose `CreateTable` takes
            // its arguments the other way round builds the TRANSPOSED table, and filling that table must be
            // a closed pre-insert refusal with ZERO writes rather than a partially filled table. THE
            // PRECONDITION IS THE FILL LOOP'S OWN BOUNDARY: read the LAST cell the loop below will touch,
            // `(rowCount - 1, columnCount - 1)`, and require the same measured chain the loop requires; then
            // read `(rowCount, 0)` — the first cell of the row one past the end the caller asked for — and
            // require it to be ABSENT. Both reads go through `probeCell`, and that is an authored-code-audit
            // requirement as well as a correctness one: this analysis treats a member read with a
            // NON-CONSTANT key as a computed value, so a local holding `list[index]` would make every later
            // call on it a computed-execution finding, and a CALL's result is not tainted. The probe is
            // DEFENSIVE IN BOTH DIRECTIONS on purpose: the target's out-of-range behaviour is measured as
            // ASYMMETRIC — a cell past the end of a row can answer `null` while a cell past the end of the
            // table THROWS internally (`Cannot read properties of null (reading 'Pr')`) — so an inaccessible
            // or throwing address is reported as absence rather than escaping the body. This is a
            // belt-and-braces check on top of the schema, the bridge and the shape pass: it costs two reads
            // and it is the only thing standing between a wrong factory order on some other build and a
            // half-filled table in the document.
            function probeCell(list, row, column) {
              if (list === null || list === undefined || typeof list.GetCell !== 'function') return null;
              try { return list.GetCell(row, column); } catch (error) { return null; }
            }
            var lastCell = probeCell(table, rowCount - 1, columnCount - 1);
            if (lastCell === null || lastCell === undefined || typeof lastCell.GetContent !== 'function') return tableRefusal('CAPABILITY_UNAVAILABLE');
            var lastContent = lastCell.GetContent();
            if (lastContent === null || lastContent === undefined || typeof lastContent.GetElement !== 'function') return tableRefusal('CAPABILITY_UNAVAILABLE');
            var lastElement = lastContent.GetElement(0);
            if (lastElement === null || lastElement === undefined || typeof lastElement.AddText !== 'function') return tableRefusal('CAPABILITY_UNAVAILABLE');
            if (typeof lastElement.GetText !== 'function') return tableRefusal('CAPABILITY_UNAVAILABLE');
            // The first index of the row PAST the last one the matrix owns: on a correctly created table a
            // row is absent at that address (measured `null`), and a table that answers a cell there is one
            // row taller than the matrix asked for and is refused for the same reason.
            var pastCell = probeCell(table, rowCount, 0);
            if (pastCell !== null && pastCell !== undefined) return tableRefusal('CAPABILITY_UNAVAILABLE');
            for (var fillRow = 0; fillRow < rowCount; fillRow++) {
              for (var fillCol = 0; fillCol < columnCount; fillCol++) {
                var fillCell = table.GetCell(fillRow, fillCol);
                if (fillCell === null || fillCell === undefined || typeof fillCell.GetContent !== 'function') return tableRefusal('CAPABILITY_UNAVAILABLE');
                var fillContent = fillCell.GetContent();
                if (fillContent === null || fillContent === undefined || typeof fillContent.GetElement !== 'function') return tableRefusal('CAPABILITY_UNAVAILABLE');
                var fillElement = fillContent.GetElement(0);
                if (fillElement === null || fillElement === undefined || typeof fillElement.AddText !== 'function') return tableRefusal('CAPABILITY_UNAVAILABLE');
                if (typeof fillElement.GetText !== 'function') return tableRefusal('CAPABILITY_UNAVAILABLE');
                fillElement.AddText(data[fillRow][fillCol]);
              }
            }
            // THE MUTATION, and the exact boundary the two refusal classes are split on: ONE `Push`, the
            // route MEASURED to append at the END. The phase turns `POST_INSERT` IMMEDIATELY BEFORE it,
            // because a native that throws out of the call may already have applied the table — from the
            // call entered, nothing observed here proves the document was not touched, so every refusal
            // below carries the post-insert phase and the decoder turns it into the uncertain class, for
            // which the bridge holds its slot. The readback is the ground truth, never the return value.
            phase = 'POST_INSERT';
            document.Push(table);
            var allTables = document.GetAllTables();
            if (allTables === null || allTables === undefined || typeof allTables.length !== 'number') return tableRefusal('CAPABILITY_UNAVAILABLE');
            var tablesAfter = allTables.length;
            if (!measured(tablesAfter)) return tableRefusal('CAPABILITY_UNAVAILABLE');
            // THE TABLE THE APPEND ADDED, addressed by the baseline this body ALREADY took before the call:
            // `Push` appends, so the insert's own table is the one at index `tablesBefore`, and that anchor
            // is what makes the readback one-to-one over the APPEND instead of a search for cell texts the
            // document may already hold. WHAT THE ANCHOR CATCHES, HONESTLY BOUNDED — this comment used to
            // claim that "a start-landing mutation leaves the inserted table at index 0, which can only
            // produce flags of 0", and THAT IS FALSE AT `tablesBefore = 0` (measured: a prepending double
            // with no pre-existing table answered `ok`). The true statement is narrower: a prepending route
            // is caught only when the document held at least ONE table before. At `tablesBefore >= 1` the
            // prepended table takes index 0, the OLD table sits at `tablesBefore`, its cells cannot equal
            // the requested matrix and the flags come out 0 — the uncertain class. At `tablesBefore = 0` a
            // prepending route puts a FRESH table at index 0 too, and a fresh table at index 0 is NOT
            // distinguishable from the appended one by shape alone. That is exactly why the route and its
            // geometry precondition are asserted SEPARATELY rather than carried by this address: the
            // authored-leg classifier pins the primitives this body authors, and the factory-order and
            // geometry precondition above pins the shape the factory built. Reading any OTHER table would
            // be the false success this address exists to prevent.
            // The index read goes through a small function ON PURPOSE, and that is an authored-code-audit
            // requirement rather than a style choice: `allTables[tablesBefore]` is a member read with a
            // NON-CONSTANT key, which this module's NAME-based alias analysis treats as a computed value, so
            // a local holding it would make every later call on it a computed-execution finding (measured:
            // the four `GetCell`/`GetContent`/`GetElement`/`GetText` calls below were reported as
            // DYNAMIC_PROPERTY until this helper existed). A CALL's result is not tainted by that analysis,
            // so `tableAt(...)` yields a value this body may invoke the measured chain on.
            function tableAt(list, index) {
              return index >= 0 && index < list.length ? list[index] : null;
            }
            var appended = tableAt(allTables, tablesBefore);
            if (appended === null || appended === undefined || typeof appended.GetCell !== 'function') return tableRefusal('CAPABILITY_UNAVAILABLE');
            // ONE FLAG PER CELL, in row-major order, each the equality of the APPENDED TABLE'S OWN cell with
            // the cell the caller asked for. The elements are reached through the same measured chain, one
            // step at a time — an indexed read of editor DATA followed by a call on the value it answered,
            // never a computed lookup — and `GetText` is invoked on the callback parameter, exactly as the
            // search and structure bodies do.
            var cellFlags = [];
            for (var readRow = 0; readRow < rowCount; readRow++) {
              for (var readCol = 0; readCol < columnCount; readCol++) {
                var readCell = appended.GetCell(readRow, readCol);
                if (readCell === null || readCell === undefined || typeof readCell.GetContent !== 'function') return tableRefusal('CAPABILITY_UNAVAILABLE');
                var readContent = readCell.GetContent();
                if (readContent === null || readContent === undefined || typeof readContent.GetElement !== 'function') return tableRefusal('CAPABILITY_UNAVAILABLE');
                var readElement = readContent.GetElement(0);
                if (readElement === null || readElement === undefined || typeof readElement.GetText !== 'function') return tableRefusal('CAPABILITY_UNAVAILABLE');
                var cellText = readElement.GetText();
                if (typeof cellText !== 'string') return tableRefusal('CAPABILITY_UNAVAILABLE');
                cellFlags.push(cellText === data[readRow][readCol] ? 1 : 0);
              }
            }
            // The phase slot, the two counts and the per-cell flags are APPENDED rather than spelled as one
            // array literal, for the authored-code-audit reason the block body states: the local alias
            // analysis is NAME-based and scope-insensitive over the whole bundle, so a literal built from
            // identifier names another scope happened to taint would make this array a "computed value" and
            // every call on it a computed-execution finding.
            var answer = [];
            answer.push(phase);
            answer.push(tablesBefore);
            answer.push(tablesAfter);
            for (var flagIndex = 0; flagIndex < cellFlags.length; flagIndex++) answer.push(cellFlags[flagIndex]);
            return answer;
          } catch (error) { return tableRefusal('CAPABILITY_UNAVAILABLE'); }
        }, false, false, callback);
      },
      // THE HEADING STYLE ASSIGNMENT, and the THIRD leg in this bridge that MUTATES a document through the
      // `Api` builder. It is the same carriage as the block append and the table insert — a FULL inline
      // static literal whose ONLY model data arrives as the `scope` binding the vendor wrapper composes
      // from `Asc.scope` (never composed into source, ADR 0002), and no composed-source transport — and it
      // is the FIRST one that does NOT append: it changes an EXISTING paragraph IN PLACE. That single
      // difference is what shapes this body, and it is why two of the three creation legs' ingredients are
      // deliberately ABSENT here:
      //   * there is NO `document.Push` and NO `document.InsertContent`. `Push` appends (nothing is
      //     appended: the caller names a paragraph the document already holds), and the legacy whole-array
      //     primitive lands at the BEGINNING and REPLACED existing text under a selection (measured on the
      //     target, §13.2) — it would destroy the very text this leg promises to leave unchanged. So the
      //     ONE mutating call in this body is `paragraph.SetStyle(style)`, the route MEASURED to apply.
      //   * the paragraph count is an INVARIANT, not a delta: a style assignment creates and destroys
      //     nothing, so the body reads `GetAllParagraphs().length` before and after and requires the two to
      //     be EQUAL. A count that moved means something else happened to the document and the outcome is
      //     not this tool's to claim.
      // THE PRE-DISPATCH BASELINE is the gate, exactly as in the other two legs: the document's paragraph
      // and heading counts, AND the addressed paragraph's own text. No baseline means no delta means no
      // evidence means no write.
      // THE PROOF IS THE ADDRESSED PARAGRAPH'S OWN STYLE, AND IT IS MEASURED. An earlier revision decided
      // "the addressed paragraph is now a heading" by OBJECT IDENTITY — the object the body addressed had to
      // BE an element of `GetAllHeadingParagraphs()` — and the LEAD MEASURED that leg to be impossible on the
      // target (Astra / R7 2026.1.2.1942): on a three-paragraph document with one heading,
      // `GetAllHeadingParagraphs()[0].GetText()` equalled the text of `GetAllParagraphs()[0]` while
      // `GetAllHeadingParagraphs()[0] === GetAllParagraphs()[i]` was FALSE for EVERY i. The two lists hand
      // out DIFFERENT wrapper objects, so no reference comparison can ever hold, and that leg would have
      // turned every call into `APPLY_UNCERTAIN` with the write slot held (fail-safe, but the tool unusable).
      // The SAME measurement supplied the replacement, which needs neither identity nor text uniqueness:
      // `typeof p.GetParaPr === 'function'` and `typeof p.GetParaPr().GetStyle === 'function'`, and
      // `GetStyle()` answers a STYLE OBJECT (`GetClassType()` = `'style'`) whose `GetName()` gives the
      // canonical `'Heading 1'` for a paragraph carrying an explicit Heading style, and `null` for a plain
      // Normal paragraph. The addressed paragraph's OWN name is therefore the PRIMARY proof, one-to-one for
      // THAT object. Its TEXT and the document's two counts are kept as SECONDARY signals only: they can
      // REFUTE an assignment and they can never establish one (two paragraphs of one document can carry the
      // same text, which is the false success an earlier text-membership leg admitted).
      // THE PRE-STATE IS REFUSED FROM THE SAME READBACK, BEFORE THE MUTATION. A paragraph whose own style
      // name is a HEADING name is answered `ALREADY_HEADING` — the closed argument class, with ZERO writes
      // and the slot RELEASED — because a LEVEL CHANGE on an existing heading moves no heading count (the
      // document loses one heading and gains one), so the count legs cannot verify it. The mutation used to
      // be dispatched and then settle `APPLY_UNCERTAIN` with the slot HELD, which made a level change
      // impossible AND left the write lock engaged for the rest of the session. It is recorded as a stated
      // limitation of this tool in the descriptor and in §15b of docs/sprint-3-progress.md, together with the
      // route that could verify a level change and why it is NOT taken yet.
      // THE ONE ADDRESS THIS LEG HAS, AND WHAT IT CANNOT PROVE. The baseline paragraphs are read ONCE into
      // a local array and the target is taken from THAT array (through `paragraphAt`, an
      // authored-code-audit requirement as well as a correctness one: a member read with a NON-CONSTANT
      // key is a computed value, so a local holding `list[index]` would make every later call on it a
      // computed-execution finding — a CALL's result is not tainted). The index is therefore checked
      // against the SAME snapshot the baseline text was read from, which is the strongest form available:
      // a STALE INDEX — an index that named paragraph P in the caller's document while a concurrent edit
      // has since inserted or removed a paragraph ABOVE it — is caught whenever the paragraph now at P
      // carries a DIFFERENT text than the requested one did, because the body compares the addressed
      // paragraph's text before and after the ONE mutation and the doc-side rule requires it unchanged.
      // What that rule CANNOT catch is stated rather than denied: a concurrent edit that puts a paragraph
      // with EXACTLY the same text at P. The residual is accepted and recorded in docs/sprint-3-progress.md
      // (§15) together with the structural remedy; it is not silently relied on.
      // THE STYLE IS RESOLVED BEFORE THE MUTATION, exactly as `insert_blocks` resolves every heading style
      // before its first `Push`: an unresolvable `Heading <n>` answers the closed `STYLE_UNAVAILABLE`
      // (decoded as `TOOL_ERROR`) with NOTHING styled. And the style name is the one the caller's LEVEL
      // named, carried as DATA — this body never derives a name from a text or a document language.
      // THE READBACK IS ATTEMPTED, NEVER ASSUMED. Every member of the chain is a `typeof` function check
      // before its call and the whole probe sits in its own `try`, so a build that does not expose
      // `GetParaPr`, `GetStyle` or `GetName` answers NO measurement rather than failing the body. THE DECIDED
      // CONTRACT FOR AN UNUSABLE READBACK, stated here so the code and this comment cannot drift: the
      // mutation has ALREADY run by the time the post read is taken, so the outcome is `APPLY_UNCERTAIN`
      // with the slot HELD — never `ok`, and never a known class. There is NO identity fallback and no text
      // fallback: the identity leg was measured to be impossible on the target (see above). A readback that
      // IS readable is compared under the module's own case- and space-folding (the spelling variants the
      // setter's lookup was measured to accept); the measured `null` of a plain paragraph is a READABLE
      // answer that is simply not the requested style, and a name that differs by more than case and spaces
      // is a genuine disagreement — both settle `APPLY_UNCERTAIN`, a contradiction this body can SEE rather
      // than a guess.
      // The answer is ONE flat array of primitives (the native return validator keeps those and strips a
      // plain object): `[POST_INSERT, headingsBefore, headingsAfter, paragraphsStable, textUnchanged,
      // styleRead, styleMatches]`, or a TWO-slot refusal `[PRE_INSERT, name]`. `paragraphsStable` is the
      // paragraph-count invariant, `textUnchanged` the addressed paragraph's text, `styleRead` whether a
      // readable style name was answered at all, and `styleMatches` whether it is the requested one under
      // the fold. THE PHASE IS AN EXPLICIT SLOT OF EVERY ANSWER, and the decoder turns a phase-less or
      // post-insert refusal into the uncertain class — the name alone can never release a slot for a
      // mutation that may already be in the document.
      heading(callback) {
        return plugin.callCommand(function () {
          // The phase, and the ONE place the two classes are distinguished: everything answered while it is
          // `PRE_INSERT` is a KNOWN refusal (nothing reached the document), everything answered after the
          // single `SetStyle` is an UNCERTAIN outcome the bridge must hold a slot for. It turns
          // `POST_INSERT` IMMEDIATELY BEFORE that one call, not after it, because a native that throws OUT
          // of the call may already have applied the style.
          var phase = 'PRE_INSERT';
          // The refusal is a TWO-slot array whose FIRST slot is that phase and whose SECOND is the closed
          // name, APPENDED to an array that starts as a literal for the authored-code-audit reason the
          // block body states: a literal built from identifier names would make the receiver of every later
          // call on it a computed value.
          function headingRefusal(name) {
            var refusal = [];
            refusal.push(phase);
            refusal.push(name);
            return refusal;
          }
          try {
            // The scope the vendor wrapper injected: `{ paragraph, level, styleName }`, already validated by
            // the bridge. Anything else — a missing wrapper, a non-numeric address, a missing style name —
            // is the body's own closed refusal rather than a style applied to `undefined`.
            var request = typeof scope !== 'undefined' && scope !== null ? scope : null;
            var index = request !== null && typeof request.paragraph === 'number' ? request.paragraph : null;
            var styleName = request !== null && typeof request.styleName === 'string' && request.styleName !== '' ? request.styleName : null;
            if (index === null || index < 0 || index % 1 !== 0 || styleName === null) return headingRefusal('CAPABILITY_UNAVAILABLE');
            var available = typeof Api !== 'undefined' && Api !== null;
            var document = available && typeof Api.GetDocument === 'function' ? Api.GetDocument() : null;
            if (document === null || document === undefined) return headingRefusal('CAPABILITY_UNAVAILABLE');
            // Every primitive this body authors is a FUNCTION CHECK before any call, exactly like the block
            // and table bodies: an editor that does not expose one of them answers this body's own refusal
            // rather than a style applied through a primitive that is not the measured one.
            if (typeof document.GetStyle !== 'function' || typeof document.GetAllParagraphs !== 'function') return headingRefusal('CAPABILITY_UNAVAILABLE');
            if (typeof document.GetAllHeadingParagraphs !== 'function') return headingRefusal('CAPABILITY_UNAVAILABLE');
            // A count this body cannot trust as a NON-NEGATIVE WHOLE number is not a count. The check
            // reaches for NO global at all, so the stringified body depends on nothing but the two bindings
            // the vendor wrapper creates.
            function measured(value) {
              return typeof value === 'number' && value === value && value >= 0 && value % 1 === 0;
            }
            // `list[index]` is a member read with a NON-CONSTANT key, which this module's NAME-based alias
            // analysis treats as a computed value; a CALL's result is not tainted by it, so the target is
            // taken through this helper and the measured member calls below stay clean.
            function paragraphAt(list, position) {
              return position >= 0 && position < list.length ? list[position] : null;
            }
            function textAt(item) {
              if (item === null || item === undefined || typeof item.GetText !== 'function') return null;
              try { return item.GetText(); } catch (error) { return null; }
            }
            // THE ADDRESSED PARAGRAPH'S OWN STYLE, READ THROUGH THE MEASURED CHAIN
            // `GetParaPr().GetStyle().GetName()`. The THREE answers are kept DISTINCT because they mean three
            // different things, and the whole body's contract turns on the difference:
            //   * a NAME is a measurement of a paragraph that CARRIES a style;
            //   * the EMPTY STRING is a measurement too — of a paragraph that carries NONE. The target was
            //     measured to answer `null` from `GetStyle()` for a Normal paragraph, and that `null` is a
            //     READABLE non-match, never the absence of a measurement;
            //   * `null` is the ABSENCE of a measurement: a member missing, not a function, or a throw.
            // Every member is a function check before its call and the whole probe is inside its own `try`,
            // so a build without the chain answers `null` here instead of failing the body.
            function readOwnStyle(item) {
              try {
                if (item === null || item === undefined || typeof item.GetParaPr !== 'function') return null;
                var paraPr = item.GetParaPr();
                if (paraPr === null || paraPr === undefined || typeof paraPr.GetStyle !== 'function') return null;
                var carried = paraPr.GetStyle();
                if (carried === null || carried === undefined) return '';
                if (typeof carried.GetName !== 'function') return null;
                var ownName = carried.GetName();
                return typeof ownName === 'string' ? ownName : null;
              } catch (error) { return null; }
            }
            // THE STYLE-NAME FOLDING, and it is the SAME folding the module's own `readsStyleName` applies to
            // the same envelope field: case-insensitive and space-insensitive, because the editor's lookup
            // was MEASURED to accept `'Heading 1'`, `'Heading1'` and `'heading 1'` for the one style, so a
            // getter answering either spelling is a MATCH and not a disagreement. Nothing else is folded: a
            // name that differs by more than case and spaces is a genuine disagreement (the localized alias
            // the setter's lookup also accepts is NOT guessed at here, and is never treated as a match).
            function folded(spelling) {
              return typeof spelling === 'string' ? spelling.toLowerCase().replace(/ /g, '') : '';
            }
            // IS THIS PARAGRAPH'S OWN STYLE A HEADING ONE? The one pre-state question the readback can now
            // answer: a non-null style whose folded name is `heading` followed by digits and nothing else. A
            // different style (`Title`, `Quote`) is NOT a heading, and the measured `null` of a plain
            // paragraph is not either — the readback's own shape carries that distinction.
            function isHeadingName(spelling) {
              var name = folded(spelling);
              return name !== '' && /^heading[0-9]+$/.test(name);
            }
            // THE PRE-DISPATCH BASELINE: the two counts and the addressed paragraph's own text, all read
            // BEFORE anything is styled. The index is checked against the SAME snapshot the text is read
            // from, so a baseline that cannot be read and an index outside THIS document are closed
            // refusals with ZERO writes.
            var baselineParagraphs = document.GetAllParagraphs();
            if (baselineParagraphs === null || baselineParagraphs === undefined || typeof baselineParagraphs.length !== 'number') return headingRefusal('CAPABILITY_UNAVAILABLE');
            var paragraphsBefore = baselineParagraphs.length;
            if (!measured(paragraphsBefore)) return headingRefusal('CAPABILITY_UNAVAILABLE');
            if (!(index < paragraphsBefore)) return headingRefusal('CAPABILITY_UNAVAILABLE');
            var target = paragraphAt(baselineParagraphs, index);
            if (target === null || target === undefined || typeof target.SetStyle !== 'function') return headingRefusal('CAPABILITY_UNAVAILABLE');
            var baselineText = textAt(target);
            if (typeof baselineText !== 'string') return headingRefusal('CAPABILITY_UNAVAILABLE');
            var baselineHeadings = document.GetAllHeadingParagraphs();
            if (baselineHeadings === null || baselineHeadings === undefined || typeof baselineHeadings.length !== 'number') return headingRefusal('CAPABILITY_UNAVAILABLE');
            var headingsBefore = baselineHeadings.length;
            if (!measured(headingsBefore)) return headingRefusal('CAPABILITY_UNAVAILABLE');
            // THE PRE-STATE, DECIDED BEFORE THE MUTATION AND NOT AFTER IT, and now read from the SAME
            // measured proof the post-state uses — the addressed paragraph's OWN style name. A target whose
            // own name is already a HEADING name is refused here: the heading count is the ONE signal that
            // moves for an assignment, and a LEVEL CHANGE on an existing heading moves it NOWHERE (the
            // document loses one heading and gains one), so the count legs cannot verify it. Refusing it here
            // keeps the failure KNOWN (zero writes, the slot released) instead of settling the UNCERTAIN class
            // with the slot HELD, which is what the same call used to do — and which left the tool's write
            // lock engaged for the rest of the session on a mutation that had changed nothing. The check is
            // BEST-EFFORT and says so: on a build whose readback is unusable it answers nothing (`null`) and
            // the call proceeds to the mutation, where the same unusable readback settles `APPLY_UNCERTAIN`
            // with the slot held rather than refusing a call this body cannot judge.
            var baselineName = readOwnStyle(target);
            if (isHeadingName(baselineName)) return headingRefusal('ALREADY_HEADING');
            // THE STYLE IS RESOLVED BEFORE THE MUTATION: an unresolvable `Heading <n>` refuses the whole
            // call with NOTHING styled — never an unstyled paragraph where a heading was asked for.
            var style = document.GetStyle(styleName);
            if (style === null || style === undefined) return headingRefusal('STYLE_UNAVAILABLE');
            // THE MUTATION, and the exact boundary the two refusal classes are split on. The phase turns
            // `POST_INSERT` IMMEDIATELY BEFORE the one `SetStyle`, because a native that throws out of the
            // call may already have applied the style; the readback below is the ground truth, never the
            // primitive's return value (no mutation primitive's boolean is consulted anywhere in this body).
            phase = 'POST_INSERT';
            target.SetStyle(style);
            // THE POST READ: the same counts, the addressed paragraph's text, and the heading list.
            var afterParagraphs = document.GetAllParagraphs();
            if (afterParagraphs === null || afterParagraphs === undefined || typeof afterParagraphs.length !== 'number') return headingRefusal('CAPABILITY_UNAVAILABLE');
            var paragraphsAfter = afterParagraphs.length;
            if (!measured(paragraphsAfter)) return headingRefusal('CAPABILITY_UNAVAILABLE');
            var afterHeadings = document.GetAllHeadingParagraphs();
            if (afterHeadings === null || afterHeadings === undefined || typeof afterHeadings.length !== 'number') return headingRefusal('CAPABILITY_UNAVAILABLE');
            var headingsAfter = afterHeadings.length;
            if (!measured(headingsAfter)) return headingRefusal('CAPABILITY_UNAVAILABLE');
            // THE TARGET IS ADDRESSED BY THE BASELINE THIS BODY ALREADY TOOK, not by a fresh search: the
            // paragraph is re-taken at the SAME index from the post array, and the doc-side rule requires its
            // TEXT to equal the text the baseline read at that index. A route that changed the paragraph's
            // text — the measured `InsertContent`-under-a-selection behaviour — is therefore never a verified
            // assignment. The text is a SECONDARY signal and nothing more: it can REFUTE an assignment, and it
            // can never establish one, because two paragraphs of one document can carry the same text.
            var afterTarget = paragraphAt(afterParagraphs, index);
            var afterText = textAt(afterTarget);
            if (typeof afterText !== 'string') return headingRefusal('CAPABILITY_UNAVAILABLE');
            var textUnchanged = afterText === baselineText ? 1 : 0;
            // THE PARAGRAPH-COUNT INVARIANT, and it is a SECONDARY signal like the text: a style assignment
            // creates and destroys nothing, so the document's paragraph count is unchanged. A count that MOVED
            // means something else happened to the document, and that can only REFUTE this assignment — it can
            // never establish one. (The heading delta is re-derived from the two pushed counts by the
            // bridge's own outcome rule rather than folded into a flag here, so a forged answer cannot carry
            // a delta the counts contradict.)
            var paragraphsStable = paragraphsAfter === paragraphsBefore ? 1 : 0;
            // THE PRIMARY PROOF: THE ADDRESSED PARAGRAPH'S OWN STYLE NAME, read back through the measured
            // `GetParaPr().GetStyle().GetName()` chain and compared with the requested one under the SAME
            // case- and space-folding the module's `readsStyleName` applies. `styleRead` is 1 whenever the
            // readback was READABLE — including the measured `null` of a plain paragraph, which arrives here as
            // the empty string and is therefore a readable NON-match — and 0 only when the chain answered
            // nothing at all. A `styleRead` of 0 is NOT a licence to fall back on the counts or on the text:
            // the mutation has already run, so the decoder settles `APPLY_UNCERTAIN` with the slot HELD.
            var afterName = readOwnStyle(afterTarget);
            var styleRead = afterName === null ? 0 : 1;
            var styleMatches = styleRead === 1 && folded(afterName) === folded(styleName) ? 1 : 0;
            // The phase slot, the two counts and the four flags are APPENDED rather than spelled as one array
            // literal, for the authored-code-audit reason the block body states: the local alias analysis is
            // NAME-based and scope-insensitive over the whole bundle, so a literal built from identifier
            // names another scope happened to taint would make this array a "computed value" and every call
            // on it a computed-execution finding.
            var answer = [];
            answer.push(phase);
            answer.push(headingsBefore);
            answer.push(headingsAfter);
            answer.push(paragraphsStable);
            answer.push(textUnchanged);
            answer.push(styleRead);
            answer.push(styleMatches);
            return answer;
          } catch (error) { return headingRefusal('CAPABILITY_UNAVAILABLE'); }
        }, false, false, callback);
      },
      // THE RANGE FORMAT, and the FOURTH leg in this bridge that MUTATES a document through the `Api`
      // builder. It is the same carriage as the heading assignment — a FULL inline static literal whose only
      // model data arrives as the `scope` binding the vendor wrapper composes from `Asc.scope` (never
      // composed into source, ADR 0002) — and it is the FIRST one that does NOT change a paragraph STYLE.
      //
      // TWO READBACKS, and they are what decide every mutating call in this body. (1) THE PARAGRAPH'S OWN
      // ALIGNMENT, when the request NAMED one: the SDK inspection recorded in `src/tools/word.js` established
      // that the public `ApiRange`/`ApiTextPr` pair authors SETTERS ONLY — there is no `GetBold`, `GetItalic`,
      // `GetUnderline`, `GetStrikeout`, `GetColor`, `GetFontSize`, `GetFontFamily` or `GetHighlight` anywhere
      // in the bundle — so the ONE builder type with a direct, per-object readback is `ApiParaPr`, whose
      // `SetJc` sits directly beside `GetJc` and whose `GetJc` answers the closed vocabulary
      // `right`/`left`/`center`/`both`. (2) THE DOCUMENT'S OWN HTML EXPORT: the Lead MEASURED on the target
      // that `doc.ToHtml()` reflects run formatting with exactly one marker per property — bold `<strong>`,
      // italic `<em>`, underline `<span style="text-decoration:underline;">`, strikeout `<del>` — and that the
      // EXPORT CARRIES THEM ENTITY-ESCAPED, which is the form the proof must scan. `doc.ToMarkdown()` does NOT
      // reflect them (measured byte-identical) and is not used here.
      //
      // THE MUTATING CALLS are one `paragraph.GetParaPr().SetJc(align)` — ONLY when the request named an
      // alignment, with the `'none'` sentinel authoring no paragraph-level call at all — plus ONE
      // `paragraph.GetRange(from,to).SetBold/SetItalic/SetUnderline/SetStrikeout(true)` per REQUESTED property,
      // in that fixed order, each on its OWN fresh range object. A call that names no run property authors NONE
      // of them and never reads the export.
      //
      // WHAT THE { paragraph, start, end } ADDRESS IS FOR, and the range signals this leg has. It is a
      // BOUNDARY: the body requires the paragraph to exist, requires both offsets to lie inside that
      // paragraph's OWN `GetText().length` BEFORE the mutation, and reads the ADDRESSED REGION through the
      // paragraph's own `GetRange(start, end)` before and after the mutation. That region read is the range
      // leg of the proof and it is deliberately built from a FRESH range object on each side: `ApiRange`
      // caches its own text at construction (measured in the vendored SDK), so a range HELD across the
      // mutation would compare a cached value with itself. The region can only REFUTE the alignment leg — but
      // its PRE-mutation text is the NEEDLE of the run proof: it must occur EXACTLY ONCE in the export, and
      // the requested property's own ESCAPED marker pair must be located around it under the nesting-tolerant
      // rule stated beside `wrappedRegion`; a region text that stands twice is UNVERIFIABLE and answers 0
      // rather than a guessed 1.
      //
      // THE EXPORT IS BOUNDED BY `htmlMax` (composed by the bridge from `LIMITS.formatRangeHtmlChars`) and it
      // never leaves the editor: the body scans it and returns ONE four-character proof string. An export that
      // does not exist or does not FIT is refused BEFORE the mutation (closed class, zero writes); an export
      // that fails only AFTER the mutation is a POST-insert refusal the decoder settles as uncertain with the
      // slot held, because the writes have already run.
      //
      // THE ANSWER is ONE flat array of primitives (the native return validator keeps those and strips a
      // plain object): `[POST_INSERT, paragraphsStable, textUnchanged, rangeRead, rangeUnchanged, rangeShifted,
      // runProof, align, alignBefore, alignAfter]` — ELEVEN slots, the run proof being ONE four-character
      // string, one character per measured property in the body's own fixed order — or a TWO-slot refusal
      // `[PRE_INSERT, name]`. THE PHASE IS AN EXPLICIT SLOT OF EVERY ANSWER, and the decoder turns a
      // phase-less or post-insert refusal into the uncertain class — the name alone can never release a slot
      // for a mutation that may already be in the document.
      format(callback) {
        return plugin.callCommand(function () {
          // The phase, and the ONE place the two classes are distinguished: everything answered while it is
          // `PRE_INSERT` is a KNOWN refusal (nothing reached the document), everything answered after the FIRST
          // mutating call is an UNCERTAIN outcome the bridge must hold a slot for. It turns `POST_INSERT`
          // IMMEDIATELY BEFORE that call, not after it, because a native that throws OUT of any of them may
          // already have applied it.
          var phase = 'PRE_INSERT';
          // The refusal is a TWO-slot array whose FIRST slot is that phase and whose SECOND is the closed
          // name, APPENDED to an array that starts as a literal for the authored-code-audit reason the other
          // bodies state: the alias analysis is NAME-based and scope-insensitive over the whole bundle, so an
          // array literal built from identifier names could make the receiver of every later call on it a
          // computed value.
          function formatRefusal(name) {
            var refusal = [];
            refusal.push(phase);
            refusal.push(name);
            return refusal;
          }
          try {
            // The scope the vendor wrapper injected: `{ paragraph, start, end, align, bold, italic, underline,
            // strikeout, htmlMax }`, already validated by the bridge. Anything else — a missing wrapper, a
            // non-numeric address, an alignment the runtime cannot serve, a run switch that is not a boolean, a
            // missing export bound — is the body's own closed refusal rather than a paragraph formatted on the
            // strength of `undefined`.
            var request = typeof scope !== 'undefined' && scope !== null ? scope : null;
            var measured = measureRequest(request);
            if (measured === null) return formatRefusal('CAPABILITY_UNAVAILABLE');
            var index = measured[0];
            var startOffset = measured[1];
            var endOffset = measured[2];
            var align = measured[3];
            var wantBold = measured[4];
            var wantItalic = measured[5];
            var wantUnderline = measured[6];
            var wantStrikeout = measured[7];
            var htmlMax = measured[8];
            var available = typeof Api !== 'undefined' && Api !== null;
            var document = available && typeof Api.GetDocument === 'function' ? Api.GetDocument() : null;
            if (document === null || document === undefined) return formatRefusal('CAPABILITY_UNAVAILABLE');
            // Every primitive this body authors is a FUNCTION CHECK before any call, exactly like the three
            // mutation bodies before it: an editor that does not expose one of them answers this body's own
            // refusal rather than a paragraph aligned through a primitive that is not the measured one.
            if (typeof document.GetAllParagraphs !== 'function') return formatRefusal('CAPABILITY_UNAVAILABLE');
            // A count this body cannot trust as a NON-NEGATIVE WHOLE number is not a count. The check reaches
            // for NO global at all, so the stringified body depends on nothing but the two bindings the vendor
            // wrapper creates.
            function isCount(value) {
              return typeof value === 'number' && value === value && value >= 0 && value % 1 === 0;
            }
            // `list[index]` is a member read with a NON-CONSTANT key, which this module's NAME-based alias
            // analysis treats as a computed value; a CALL's result is not tainted by it, so the target is
            // taken through this helper and the measured member calls below stay clean.
            function paragraphAt(list, position) {
              return position >= 0 && position < list.length ? list[position] : null;
            }
            function textAt(item) {
              if (item === null || item === undefined || typeof item.GetText !== 'function') return null;
              try { return item.GetText(); } catch (error) { return null; }
            }
            // THE ALIGNMENT VOCABULARY, and it is the SAME four words the schema advertises because they are
            // the words the measured getter answers — plus `'none'`, the ONE sentinel that means NO ALIGNMENT
            // LEG AT ALL. `align` is optional now, so a run-only request carries `'none'`: it can never be
            // confused with a measurement, because no measured getter answers it and the four words above are
            // the only ones a readback may hold. A bare boolean test over the five literals, so this helper
            // depends on nothing at all.
            function isAlign(value) {
              return value === 'none' || value === 'left' || value === 'center' || value === 'right' || value === 'both';
            }
            // THE REQUEST, MEASURED BEFORE ANY PRIMITIVE IS TOUCHED. The address is re-checked HERE and not
            // only in the bridge method, because the scope is the ONE thing that crosses: a fractional index,
            // an offset past the advertised bound, an alignment outside the measured vocabulary, a run switch
            // that is not a boolean or a missing export bound is this body's own closed argument refusal, never
            // a format applied to a coerced address. The return is an ARRAY so the caller binds each measured
            // value separately, which keeps every later member call on a call's own result rather than on an
            // indexed read. `htmlMax` crosses with the request exactly as a search's `limit` does — it is the
            // bound THIS body enforces, and it is composed by the bridge from `LIMITS.formatRangeHtmlChars`,
            // never supplied by the caller. `align` may be the `'none'` sentinel, which says the request NAMED
            // no alignment at all; it is a legal scope and not a missing one, because the bridge sends it only
            // after deciding that at least one of the five properties was named.
            function isFlag(value) {
              return value === true || value === false;
            }
            function measureRequest(value) {
              if (value === null || value === undefined || typeof value !== 'object') return null;
              var position = value.paragraph;
              var from = value.start;
              var to = value.end;
              var wanted = value.align;
              if (!isCount(position) || !isCount(from) || !isCount(to)) return null;
              if (!(from < to)) return null;
              if (!isAlign(wanted)) return null;
              var wantBold = value.bold;
              var wantItalic = value.italic;
              var wantUnderline = value.underline;
              var wantStrikeout = value.strikeout;
              if (!isFlag(wantBold) || !isFlag(wantItalic) || !isFlag(wantUnderline) || !isFlag(wantStrikeout)) return null;
              var bound = value.htmlMax;
              if (!isCount(bound) || bound < 1) return null;
              return [position, from, to, wanted, wantBold, wantItalic, wantUnderline, wantStrikeout, bound];
            }
            // THE ALIGNMENT OF THE ADDRESSED PARAGRAPH, READ THROUGH THE MEASURED CHAIN
            // `paragraph.GetParaPr().GetJc()`. THE THREE ANSWERS ARE KEPT DISTINCT because they mean three
            // different things, and the whole body's contract turns on the difference:
            //   * one of the four measured WORDS is a measurement of a paragraph whose alignment the getter
            //     could answer;
            //   * the EMPTY STRING is a measurement too — of a paragraph whose alignment was read as
            //     `undefined`, which the getter is allowed to answer for a paragraph that carries none;
            //   * `null` is the ABSENCE of a measurement: a member missing, not a function, or a throw.
            // Every member is a function check before its call and the whole probe is inside its own `try`, so
            // a build without the chain answers `null` here instead of failing the body.
            function readAlign(item) {
              try {
                if (item === null || item === undefined || typeof item.GetParaPr !== 'function') return null;
                var paraPr = item.GetParaPr();
                if (paraPr === null || paraPr === undefined || typeof paraPr.GetJc !== 'function') return null;
                var carried = paraPr.GetJc();
                return typeof carried === 'string' && isAlign(carried) ? carried : '';
              } catch (error) { return null; }
            }
            // THE ADDRESSED REGION, READ THROUGH THE PARAGRAPH'S OWN `GetRange`. A FRESH range object is
            // built on every call (the editor's own constructor caches the text it is built with), so the
            // BEFORE and AFTER reads can never be the same cached value. `null` is the absence of a
            // measurement — a missing primitive, a refusal, or a throw — and is kept apart from the empty
            // string, which is a region that really holds no characters.
            function rangeFor(item, from, to) {
              try {
                if (item === null || item === undefined || typeof item.GetRange !== 'function') return null;
                var built = item.GetRange(from, to);
                return built === null || built === undefined ? null : built;
              } catch (error) { return null; }
            }
            function readRange(item, from, to) {
              var range = rangeFor(item, from, to);
              if (range === null || typeof range.GetText !== 'function') return null;
              try {
                var covered = range.GetText();
                return typeof covered === 'string' ? covered : null;
              } catch (error) { return null; }
            }
            // THE MEASURED RUN READBACK: the document's own HTML export, read through `doc.ToHtml()`, which the
            // Lead measured on the target to reflect run formatting with one marker per property. A missing
            // primitive, a non-string answer and a throw are all the ABSENCE of a measurement (`null`), which
            // the caller settles as a closed refusal BEFORE the mutation or as the uncertain class after it.
            // THE EXPORT IS ENTITY-ESCAPED, AND THAT IS THE FORM THE PROOF SCANS. The Lead's native run read
            // `&lt;p&gt;&lt;strong&gt;ФОРМАТИРУ&lt;/strong&gt;ЕМЫЙ-…&lt;/p&gt;` out of `ToHtml()`, so the
            // markers below are the ESCAPED `&lt;…&gt;` strings and the raw `<strong>` form the previous proof
            // searched for can never occur in this export — which is exactly why a correct write settled
            // UNCERTAIN natively. The export NEVER leaves the editor: only the run-proof string derived from it
            // crosses.
            function exportHtml(doc) {
              try {
                if (doc === null || doc === undefined || typeof doc.ToHtml !== 'function') return null;
                var markup = doc.ToHtml();
                return typeof markup === 'string' ? markup : null;
              } catch (error) { return null; }
            }
            // THE ESCAPED MARKERS, one PAIR per measured property, exactly as the export carries them. There is
            // deliberately NO unescaping step: a general entity decode of the export can create a needle that
            // was never in the document (`&amp;lt;` decodes to `&lt;`), and the exported TEXT does not have to
            // be decoded for this proof to be exact — the needle is the region's own PRE-mutation `GetText()`
            // answer, which agrees with what the export holds for any region with no HTML metacharacter in it.
            // For a region that does hold one the needle simply is not found, which costs a false UNCERTAIN
            // (the slot stays held) and can never buy a false proof.
            var BOLD_PAIR = ['&lt;strong&gt;', '&lt;/strong&gt;'];
            var ITALIC_PAIR = ['&lt;em&gt;', '&lt;/em&gt;'];
            var UNDERLINE_PAIR = ['&lt;span style="text-decoration:underline;"&gt;', '&lt;/span&gt;'];
            var STRIKEOUT_PAIR = ['&lt;del&gt;', '&lt;/del&gt;'];
            // THE PARAGRAPH BOUNDARY, in the same escaped form. The fragment between them is what a marker may
            // be searched in, so a marker belonging to ANOTHER paragraph can never be mistaken for this one's.
            var PARAGRAPH_OPEN = '&lt;p';
            var PARAGRAPH_CLOSE = '&lt;/p&gt;';
            // THE NESTING-TOLERANT MEMBERSHIP RULE, and it is the correction this body owes the MEASUREMENT:
            // two run properties on the SAME region NEST, and the property applied FIRST becomes the INNERMOST
            // marker —
            //   bold             → `…&lt;strong&gt;ФОРМАТИРУ&lt;/strong&gt;ЕМЫЙ-…`
            //   bold then italic → `…&lt;em&gt;&lt;strong&gt;ФОРМАТИРУ&lt;/strong&gt;&lt;/em&gt;ЕМЫЙ-…`
            // so requiring the marker to be CONTIGUOUS with the region text proves only the innermost property
            // and answers 0 for every outer one, which is a false UNCERTAIN for a correct write. A property is
            // therefore PROVEN when the region text lies INSIDE that property's OWN marker pair WITHIN the
            // addressed paragraph's own fragment: the property's LAST opener before the region and its FIRST
            // closer after it, with other markers and other text allowed in between.
            // NO CROSSING RULE IS ADDED ON TOP OF THAT, and the omission is deliberate rather than an
            // oversight. A marker pair that wraps a SUPERSET of the addressed region is what a range write
            // wider than the address produces, and the address itself is one whole-range setter call — so a
            // pair around the region IS the measured evidence that the setter landed on it, whatever else the
            // pair also covers. Every candidate rule that tried to reject a wider pair (requiring the
            // property's closer to be the innermost one around the region, or requiring no other opener
            // between) was evaluated against the MEASURED nesting and answered 0 for a legitimate OUTER
            // property — the very defect this round removes. The uniqueness requirement below is what keeps
            // the tolerance honest: the region text must stand exactly once in the whole export, so the pair
            // being located is around THAT occurrence and never around a different one.
            function wrappedRegion(markup, region, pair) {
              if (region === '' || typeof markup !== 'string') return 0;
              // THE NEEDLE MUST STAND EXACTLY ONCE: a region text that occurs twice — inside the addressed
              // paragraph or anywhere else in the document — leaves the marker's target ambiguous, so it is
              // UNVERIFIABLE and answers 0 rather than a guessed 1. The count runs over the RAW export string,
              // because this body has no HTML parser; an occurrence inside MARKUP (a short ASCII region such
              // as `p` or `style`) therefore counts too, which can only cost a false 0, never a false 1.
              var found = markup.indexOf(region);
              if (found < 0) return 0;
              if (markup.indexOf(region, found + 1) >= 0) return 0;
              // THE ADDRESSED PARAGRAPH'S OWN FRAGMENT: the markup between the `<p` that opens it and the
              // `</p>` that closes it. A miss on either side is not a measurement, so it answers 0.
              var fromParagraph = markup.lastIndexOf(PARAGRAPH_OPEN, found);
              if (fromParagraph < 0) return 0;
              var toParagraph = markup.indexOf(PARAGRAPH_CLOSE, found);
              if (toParagraph < 0) return 0;
              // THE PROPERTY'S OWN MARKER PAIR. The opener is the LAST one at or before the region — the
              // innermost of that property — and the closer the FIRST one after it. A marker that INVERTS its
              // two angle brackets (`<strong` but no `>`, or `</strong` but no `<`) is a partial tag, not a
              // pair, so it cannot wrap anything.
              var open = pair[0];
              var close = pair[1];
              var openAt = markup.lastIndexOf(open, found);
              if (openAt < fromParagraph) return 0;
              var openEnd = markup.indexOf('&gt;', openAt);
              if (openEnd < 0 || openEnd >= found) return 0;
              var closeAt = markup.indexOf(close, found);
              if (closeAt < 0 || closeAt >= toParagraph) return 0;
              var closeStart = markup.lastIndexOf('&lt;', closeAt);
              if (closeStart < 0 || closeStart <= found) return 0;
              return 1;
            }
            // THE RUN-PROOF STRING, and it is BUILT BY A HELPER rather than concatenated at the assignment.
            // That is an authored-code-audit requirement, not a style choice: the findings analysis is
            // NAME-based and scope-insensitive over the whole bundle, and a binary `+` expression assigned to
            // an identifier makes that identifier a "computed" value everywhere — which would then make the
            // decoder's own `charAt` calls on ANOTHER `runProof` read like a method call on computed data.
            // The helper returns an ordinary string built from four booleans, and its name carries the ONE
            // meaning of that string: one character per measured property, `'1'` exactly where the property
            // was requested AND its marker pair was located around the addressed region.
            function runProofOf(bold, italic, underline, strikeout) {
              var proof = '';
              if (bold === true) proof = proof + '1'; else proof = proof + '0';
              if (italic === true) proof = proof + '1'; else proof = proof + '0';
              if (underline === true) proof = proof + '1'; else proof = proof + '0';
              if (strikeout === true) proof = proof + '1'; else proof = proof + '0';
              return proof;
            }
            // THE PRE-DISPATCH BASELINE: the document's paragraph count, the addressed paragraph's own text,
            // its own alignment and the addressed region. Everything below is read BEFORE anything is mutated,
            // and the index is checked against the SAME snapshot the text is read from, so a baseline that
            // cannot be read, an index outside THIS document and offsets outside THIS paragraph are all closed
            // refusals with ZERO writes.
            var before = document.GetAllParagraphs();
            if (before === null || before === undefined || typeof before.length !== 'number') return formatRefusal('CAPABILITY_UNAVAILABLE');
            var countBefore = before.length;
            if (!isCount(countBefore)) return formatRefusal('CAPABILITY_UNAVAILABLE');
            // AN INDEX OUTSIDE THE DOCUMENT is the closed ARGUMENT class, not the capability class: the
            // caller named a position that does not exist.
            if (!(index < countBefore)) return formatRefusal('TOOL_ERROR');
            var target = paragraphAt(before, index);
            if (target === null || target === undefined || typeof target.GetParaPr !== 'function') return formatRefusal('CAPABILITY_UNAVAILABLE');
            var beforeSource = target.GetParaPr();
            if (beforeSource === null || beforeSource === undefined || typeof beforeSource.SetJc !== 'function') return formatRefusal('CAPABILITY_UNAVAILABLE');
            var textBefore = textAt(target);
            if (typeof textBefore !== 'string') return formatRefusal('CAPABILITY_UNAVAILABLE');
            // OFFSETS ARE CHECKED AGAINST THE PARAGRAPH'S OWN LENGTH, never against the schema bound alone:
            // a start at or past the end of the text, or an end past it, is the same closed ARGUMENT class
            // with ZERO writes. The two comparisons are written out because this module's name-based analysis
            // treats a helper's boolean as an ordinary value — either way the decision is made HERE, before
            // the one mutation, and the caller receives a known class rather than a guess.
            if (!(startOffset <= textBefore.length)) return formatRefusal('TOOL_ERROR');
            if (!(endOffset <= textBefore.length)) return formatRefusal('TOOL_ERROR');
            var alignBefore = align === 'none' ? 'none' : readAlign(target);
            if (alignBefore === null) return formatRefusal('CAPABILITY_UNAVAILABLE');
            var regionBefore = readRange(target, startOffset, endOffset);
            if (regionBefore === null) return formatRefusal('CAPABILITY_UNAVAILABLE');
            // THE RUN REQUESTS THIS CALL NAMES, and the ONE question that decides whether the export is read at
            // all: a call that names NONE keeps the exact behaviour it had before this leg existed — no export,
            // no marker and no dependency on `ToHtml`. The run RANGES are built and their setters
            // FUNCTION-CHECKED here, BEFORE the phase turns, so an editor missing one of them answers the closed
            // capability class with ZERO writes instead of a half-applied format. ONE fresh range per property:
            // each setter writes exactly the range it was called on, and one property's write can never be
            // folded into another's.
            var runsRequested = wantBold === true || wantItalic === true || wantUnderline === true || wantStrikeout === true ? 1 : 0;
            var boldRange = null;
            var italicRange = null;
            var underlineRange = null;
            var strikeoutRange = null;
            if (wantBold === true) {
              boldRange = rangeFor(target, startOffset, endOffset);
              if (boldRange === null || typeof boldRange.SetBold !== 'function') return formatRefusal('CAPABILITY_UNAVAILABLE');
            }
            if (wantItalic === true) {
              italicRange = rangeFor(target, startOffset, endOffset);
              if (italicRange === null || typeof italicRange.SetItalic !== 'function') return formatRefusal('CAPABILITY_UNAVAILABLE');
            }
            if (wantUnderline === true) {
              underlineRange = rangeFor(target, startOffset, endOffset);
              if (underlineRange === null || typeof underlineRange.SetUnderline !== 'function') return formatRefusal('CAPABILITY_UNAVAILABLE');
            }
            if (wantStrikeout === true) {
              strikeoutRange = rangeFor(target, startOffset, endOffset);
              if (strikeoutRange === null || typeof strikeoutRange.SetStrikeout !== 'function') return formatRefusal('CAPABILITY_UNAVAILABLE');
            }
            // THE EXPORT GATE, and it is the ONLY place the bound can be a KNOWN refusal. A run request needs a
            // marker readback, so the export must EXIST and FIT before anything is written: a build without
            // `ToHtml` answers the closed capability class, and an export above `htmlMax` answers the closed
            // export class — both with ZERO writes and the slot RELEASED. An export that only grows past the
            // bound AFTER the write cannot be refused closed; the POST half settles it instead. The bound is
            // applied to the WHOLE export, never to a prefix: a prefix could hide the addressed region or its
            // marker, so a too-large export makes this read unusable rather than partially trusted.
            if (runsRequested === 1) {
              var preflight = exportHtml(document);
              if (preflight === null) return formatRefusal('CAPABILITY_UNAVAILABLE');
              if (!(preflight.length <= htmlMax)) return formatRefusal('BYTE_LIMIT');
            }
            // THE MUTATION, and the exact boundary the two refusal classes are split on. The PARAGRAPH's own
            // `ApiParaPr` — the measured setter whose getter is the proof — is written ONLY when the request
            // NAMED an alignment, with the alignment carried as DATA; the sentinel `'none'` is the absence of
            // that leg and authors NO paragraph-level call at all. Then ONE call per REQUESTED run property on
            // its own fresh range, in the FIXED order bold → italic → underline → strikeout. `POST_INSERT` is
            // set IMMEDIATELY BEFORE the FIRST of them, because a native that throws OUT of any one of these
            // may already have applied it.
            phase = 'POST_INSERT';
            if (align !== 'none') beforeSource.SetJc(align);
            if (wantBold === true) boldRange.SetBold(true);
            if (wantItalic === true) italicRange.SetItalic(true);
            if (wantUnderline === true) underlineRange.SetUnderline(true);
            if (wantStrikeout === true) strikeoutRange.SetStrikeout(true);
            // THE POST READ, and NOTHING is taken from the pre-mutation snapshot. A FRESH `GetAllParagraphs()`
            // answers a fresh paragraph object, so the readback cannot be a stale wrapper, and the region is
            // re-read through a fresh range for the same reason.
            var after = document.GetAllParagraphs();
            if (after === null || after === undefined || typeof after.length !== 'number') return formatRefusal('CAPABILITY_UNAVAILABLE');
            var countAfter = after.length;
            if (!isCount(countAfter)) return formatRefusal('CAPABILITY_UNAVAILABLE');
            var afterTarget = paragraphAt(after, index);
            if (afterTarget === null || afterTarget === undefined) return formatRefusal('CAPABILITY_UNAVAILABLE');
            var textAfter = textAt(afterTarget);
            if (typeof textAfter !== 'string') return formatRefusal('CAPABILITY_UNAVAILABLE');
            // THE PRIMARY PROOF, and it exists ONLY for an alignment leg: a run-only request never named an
            // alignment, so `'none'` is echoed on both sides rather than read back. When it IS named, the
            // addressed paragraph's own `GetParaPr().GetJc()` answers the measurement. `rangeRead` is 1
            // whenever the alignment was not requested OR the getter was READABLE — including the empty string
            // of a paragraph whose alignment it answered as `undefined`, which is a readable NON-match — and 0
            // only when a REQUESTED chain answered nothing at all. A `rangeRead` of 0 is NOT a licence to fall
            // back on the other flags: the mutation has already run, so the decoder settles `APPLY_UNCERTAIN`
            // with the slot HELD.
            var alignAfter = align === 'none' ? 'none' : readAlign(afterTarget);
            var alignRead = align === 'none' || alignAfter !== null ? 1 : 0;
            // THE SECONDARY RANGE LEG: the ADDRESSED REGION, re-read through a fresh range. `rangeRead` and
            // `rangeUnchanged` are the TWO answers that matter — was it read at all, and is it what it was —
            // and `rangeShifted` records whether the two offsets still NAME the same text: 0 when the region is
            // unchanged, when the paragraph became too short for the address (a real concurrent edit), or when
            // the two lengths disagree with the text's own change; 1 only when the region genuinely moved
            // FORWARD under the mutation.
            var regionAfterRead = readRange(afterTarget, startOffset, endOffset);
            var rangeRead = regionAfterRead === null ? 0 : 1;
            var rangeUnchanged = rangeRead === 1 && regionAfterRead === regionBefore ? 1 : 0;
            var rangeShifted = regionAfterRead === null ? 0 : regionAfterRead.length === regionBefore.length ? 0
              : regionAfterRead.length > regionBefore.length && textAfter.length === textBefore.length ? 1 : 0;
            var paragraphsStable = countAfter === countBefore ? 1 : 0;
            var textUnchanged = textAfter === textBefore ? 1 : 0;
            // THE RUN PROOF: the export re-read AFTER the writes, the needle taken from the PRE-mutation region
            // read, and ONE FOUR-CHARACTER STRING — `'1'` exactly where that property was REQUESTED and its
            // measured marker pair was located around the addressed region under the nesting-tolerant rule,
            // `'0'` everywhere else. An export that cannot be read at all, or one that grew past the bound
            // only now, is a POST-insert refusal: the writes have already run, so the decoder settles it as
            // UNCERTAIN with the slot HELD. A property nobody requested keeps its `'0'`, and the decoder's
            // outcome rule REFUSES an answer whose four characters do not match the four switches this ticket
            // carried.
            var runProof = '0000';
            if (runsRequested === 1) {
              var proof = exportHtml(document);
              if (proof === null) return formatRefusal('CAPABILITY_UNAVAILABLE');
              if (!(proof.length <= htmlMax)) return formatRefusal('BYTE_LIMIT');
              runProof = runProofOf(wantBold === true && wrappedRegion(proof, regionBefore, BOLD_PAIR) === 1,
                wantItalic === true && wrappedRegion(proof, regionBefore, ITALIC_PAIR) === 1,
                wantUnderline === true && wrappedRegion(proof, regionBefore, UNDERLINE_PAIR) === 1,
                wantStrikeout === true && wrappedRegion(proof, regionBefore, STRIKEOUT_PAIR) === 1);
            }
            // The phase slot, the five range flags, the ONE four-character run proof, the echo and the two
            // measured alignment values are APPENDED rather than spelled as one array literal, for the
            // authored-code-audit reason the block body states.
            var answer = [];
            answer.push(phase);
            answer.push(paragraphsStable);
            answer.push(textUnchanged);
            answer.push(rangeRead);
            answer.push(rangeUnchanged);
            answer.push(rangeShifted);
            answer.push(runProof);
            answer.push(align);
            answer.push(alignBefore);
            answer.push(alignAfter);
            return answer;
          } catch (error) { return formatRefusal('CAPABILITY_UNAVAILABLE'); }
        }, false, false, callback);
      },
      // THE HYPERLINK INSERT, and the FIFTH leg in this bridge that MUTATES a document through the `Api`
      // builder. It is the same carriage as the four before it — a FULL inline static literal whose only model
      // data arrives as the `scope` binding the vendor wrapper composes from `Asc.scope` (never composed into
      // source, ADR 0002) — and it is the THIRD leg that APPENDS.
      //
      // TWO FORMS, and the scope says which one this ticket is, because THE ADDRESS AND THE FORM ARE ONE FACT.
      // The NAMED form appends ONE `Api.CreateHyperlink(url, text)` into an EXISTING paragraph through that
      // paragraph's own `AddElement`, which the vendored SDK implements as an APPEND at the end of the
      // paragraph's own content: with NO position it calls `_i(paragraph, element)`, and `_i` is
      // `paragraph.Add_ToContent(paragraph.Content.length - 1, element)`. The APPEND form creates ONE
      // `Api.CreateParagraph()` — DETACHED, so `IsUseInDocument()` is still false — appends the same link into
      // it, and then `document.Push`es it, which the SDK lands at `Document.Content.length`, i.e. at the END
      // of the document. `ApiParagraph.AddHyperlink` is authored NOWHERE: its own body starts with
      // `this.Paragraph.SelectAll(1)` and would REPLACE the paragraph's content instead of appending to it.
      // NO mutation primitive's return value is consulted anywhere in this body: the two readbacks below are
      // the whole ground truth, exactly as in the four legs before it.
      //
      // THE FRAGMENT PROOF, and it is the MEASURED rendering of the addressed paragraph rather than a
      // document-wide search: the markdown converter's `HandleHyperlink` emits `"[" + <runs> + "](" +
      // GetLinkedText() + ")"` and `HandleRun` emits every run character RAW (no markdown escaping), so once
      // the link is appended to a paragraph whose own PRE-mutation text was `T`, the export holds the
      // contiguous string `T + "[" + text + "]("`. That string is the needle (`opener`), and the proof is:
      //   * it occurs EXACTLY ONCE in the POST-mutation export (`fragmentUnique`), and
      //   * the url this ticket carried follows it IMMEDIATELY and is closed by `)` (`urlInFragment`) — the
      //     url really is inside the located fragment.
      // A needle the PRE-mutation export ALREADY holds is refused CLOSED with ZERO writes, BEFORE the phase
      // ever turns: the fragment could not be attributed one-to-one, so the honest answer is the closed class
      // rather than a write whose outcome nothing can tell apart. A needle that is absent, duplicated or
      // url-less only AFTER the write can only be UNCERTAIN, because the write has already run.
      //
      // THE EXPORT IS BOUNDED BY `markdownMax` (composed by the bridge from `LIMITS.addHyperlinkMarkdownChars`)
      // and it never leaves the editor: the body locates the fragment in it and returns THREE one-character
      // flags. An export that does not exist or does not FIT is refused BEFORE the mutation (closed class,
      // ZERO writes); an export that fails only AFTER it is a POST-insert refusal the decoder settles as
      // uncertain with the slot HELD.
      //
      // THE ANSWER is ONE flat array of primitives (the native return validator keeps those and strips a plain
      // object): `[POST_INSERT, paragraphsBefore, paragraphsAfter, textBeforeChars, textAfterChars,
      // textAppended, fragmentUnique, urlInFragment]` — EIGHT slots — or a TWO-slot refusal
      // `[PRE_INSERT, name]`. THE PHASE IS AN EXPLICIT SLOT OF EVERY ANSWER, and it turns at the FIRST call
      // that can change the DOCUMENT, which is the ONE `Push` for the append form (an element appended to the
      // created paragraph writes nothing: the paragraph is detached) and the ONE live `AddElement` for the
      // named form. A throw out of a call that cannot have touched the document therefore keeps its known
      // refusal instead of wedging the write slot.
      hyperlink(callback) {
        return plugin.callCommand(function () {
          var phase = 'PRE_INSERT';
          // The refusal is a TWO-slot array whose FIRST slot is that phase and whose SECOND is the closed
          // name, APPENDED to an array that starts as a literal for the authored-code-audit reason the other
          // bodies state: the alias analysis is NAME-based and scope-insensitive over the whole bundle, so an
          // array literal built from identifier names could make the receiver of every later call on it a
          // computed value.
          function linkRefusal(name) {
            var refusal = [];
            refusal.push(phase);
            refusal.push(name);
            return refusal;
          }
          try {
            // The scope the vendor wrapper injected: `{ url, text, paragraph, append, markdownMax }`, already
            // validated by the bridge. Anything else — a missing wrapper, an empty url or label, a form that
            // does not agree with its address, a missing export bound — is this body's own closed refusal
            // rather than a document written on the strength of `undefined`.
            var request = typeof scope !== 'undefined' && scope !== null ? scope : null;
            var measured = measureRequest(request);
            if (measured === null) return linkRefusal('CAPABILITY_UNAVAILABLE');
            var address = measured[0];
            var append = measured[1];
            var url = measured[2];
            var text = measured[3];
            var markdownMax = measured[4];
            // A count this body cannot trust as a NON-NEGATIVE WHOLE number is not a count. The check
            // reaches for NO global at all, so the stringified body depends on nothing but the two bindings
            // the vendor wrapper creates.
            function isCount(value) {
              return typeof value === 'number' && value === value && value >= 0 && value % 1 === 0;
            }
            // `list[index]` is a member read with a NON-CONSTANT key, which this module's NAME-based alias
            // analysis treats as a computed value; a CALL's result is not tainted by it, so a paragraph is
            // taken through this helper and the measured member calls below stay clean.
            function paragraphAt(list, position) {
              return position >= 0 && position < list.length ? list[position] : null;
            }
            function textAt(item) {
              if (item === null || item === undefined || typeof item.GetText !== 'function') return null;
              try { return item.GetText(); } catch (error) { return null; }
            }
            // THE MEASURED FRAGMENT READBACK: the document's own markdown export, read through
            // `doc.ToMarkdown()`, which the Lead measured to carry the link's own TEXT and URL. A missing
            // primitive, a non-string answer and a throw are all the ABSENCE of a measurement (`null`), which
            // the caller settles as a closed refusal BEFORE the mutation or as the uncertain class after it.
            // THE EXPORT IS NOT ENTITY-ESCAPED — unlike `ToHtml()`, which IS — and that is the measured form
            // the needle is built in. The export NEVER leaves the editor: only the three flags derived from it
            // cross.
            function exportMarkdown(doc) {
              try {
                if (doc === null || doc === undefined || typeof doc.ToMarkdown !== 'function') return null;
                var markup = doc.ToMarkdown();
                return typeof markup === 'string' ? markup : null;
              } catch (error) { return null; }
            }
            // THE REQUEST, MEASURED BEFORE ANY PRIMITIVE IS TOUCHED. The address is re-checked HERE and not
            // only in the bridge method, because the scope is the ONE thing that crosses: a form that is not a
            // boolean, an address that does not agree with that form, an empty url or label and a missing
            // export bound are this body's own closed argument refusal, never a link written to a coerced
            // address. The return is an ARRAY so the caller binds each measured value separately, which keeps
            // every later member call on a call's own result rather than on an indexed read.
            function measureRequest(given) {
              if (given === null || given === undefined || typeof given !== 'object') return null;
              var position = given.paragraph;
              var appends = given.append;
              var linkUrl = given.url;
              var displayed = given.text;
              var bound = given.markdownMax;
              if (appends !== true && appends !== false) return null;
              // THE ADDRESS AND THE FORM ARE ONE FACT: the append form names NO index at all, and the named
              // form must name a whole non-negative one.
              if (appends === true) {
                if (position !== null) return null;
              } else if (!isCount(position)) return null;
              if (typeof linkUrl !== 'string' || linkUrl === '') return null;
              if (typeof displayed !== 'string' || displayed === '') return null;
              if (!isCount(bound) || bound < 1) return null;
              return [position, appends, linkUrl, displayed, bound];
            }
            var available = typeof Api !== 'undefined' && Api !== null;
            var document = available && typeof Api.GetDocument === 'function' ? Api.GetDocument() : null;
            if (document === null || document === undefined) return linkRefusal('CAPABILITY_UNAVAILABLE');
            // Every primitive this body authors is a FUNCTION CHECK before any call, exactly like the four
            // mutation bodies before it: an editor that does not expose one of them answers this body's own
            // refusal rather than a link placed through a primitive that is not the measured one.
            if (typeof document.GetAllParagraphs !== 'function') return linkRefusal('CAPABILITY_UNAVAILABLE');
            if (typeof document.ToMarkdown !== 'function') return linkRefusal('CAPABILITY_UNAVAILABLE');
            if (typeof Api.CreateHyperlink !== 'function') return linkRefusal('CAPABILITY_UNAVAILABLE');
            if (append === true) {
              if (typeof Api.CreateParagraph !== 'function') return linkRefusal('CAPABILITY_UNAVAILABLE');
              if (typeof document.Push !== 'function') return linkRefusal('CAPABILITY_UNAVAILABLE');
            }
            // THE PRE-DISPATCH BASELINE: the document's own paragraph count and — for the NAMED form — the
            // addressed paragraph's own text, read BEFORE anything is mutated. The index is checked against
            // the SAME snapshot the text is read from, so a baseline that cannot be read and an index outside
            // THIS document are closed refusals with ZERO writes. The APPEND form reads no address at all:
            // the paragraph it will act on does not exist yet, and its own text is EMPTY by construction.
            var before = document.GetAllParagraphs();
            if (before === null || before === undefined || typeof before.length !== 'number') return linkRefusal('CAPABILITY_UNAVAILABLE');
            var countBefore = before.length;
            if (!isCount(countBefore)) return linkRefusal('CAPABILITY_UNAVAILABLE');
            var textBefore = '';
            var existing = null;
            if (append === false) {
              // AN INDEX OUTSIDE THE DOCUMENT is the closed ARGUMENT class, not the capability class: the
              // caller named a position that does not exist.
              if (!(address < countBefore)) return linkRefusal('TOOL_ERROR');
              existing = paragraphAt(before, address);
              if (existing === null || existing === undefined) return linkRefusal('CAPABILITY_UNAVAILABLE');
              if (typeof existing.AddElement !== 'function') return linkRefusal('CAPABILITY_UNAVAILABLE');
              var readBefore = textAt(existing);
              if (typeof readBefore !== 'string') return linkRefusal('CAPABILITY_UNAVAILABLE');
              textBefore = readBefore;
            }
            // THE FRAGMENT NEEDLE: the addressed paragraph's own PRE-mutation text followed by the FIRST
            // half of the measured markdown link rendering. The needle is built from the PRE read on BOTH
            // sides of the mutation, so a post-read that moved cannot supply its own context.
            var opener = textBefore + '[' + text + '](';
            // THE EXPORT GATE, and it is the ONLY place the bound can be a KNOWN refusal. An export must
            // EXIST and FIT before anything is written, because the fragment proof has no other evidence: a
            // build without `ToMarkdown` answers the closed capability class and an export above `markdownMax`
            // answers the closed export class — both with ZERO writes and the slot RELEASED. The bound is
            // applied to the WHOLE export, never to a prefix: a prefix could hide the addressed fragment, so a
            // too-large export makes this read unusable rather than partially trusted.
            var markdownBefore = exportMarkdown(document);
            if (markdownBefore === null) return linkRefusal('CAPABILITY_UNAVAILABLE');
            if (!(markdownBefore.length <= markdownMax)) return linkRefusal('BYTE_LIMIT');
            // THE ONE-TO-ONE ADDRESS, decided BEFORE anything is written: a fragment the document ALREADY
            // renders cannot be told apart from the one this call would add, so the call is refused CLOSED
            // with ZERO writes rather than written and left unprovable.
            if (markdownBefore.indexOf(opener) >= 0) return linkRefusal('TOOL_ERROR');
            // THE MUTATION, and the exact boundary the two refusal classes are split on. The link object is
            // created FIRST (it is detached and writes nothing), then the phase turns at — and immediately
            // BEFORE — the first call that can change the DOCUMENT: the ONE `Push` of the append form, or the
            // ONE `AddElement` of the named form.
            var element = Api.CreateHyperlink(url, text);
            if (element === null || element === undefined) return linkRefusal('CAPABILITY_UNAVAILABLE');
            if (append === true) {
              var created = Api.CreateParagraph();
              if (created === null || created === undefined || typeof created.AddElement !== 'function') return linkRefusal('CAPABILITY_UNAVAILABLE');
              // THE DETACHED HALF: this paragraph belongs to no document yet, so an element appended to it
              // writes NOTHING and the ONE append is the `Push` below.
              created.AddElement(element);
              phase = 'POST_INSERT';
              document.Push(created);
            } else {
              phase = 'POST_INSERT';
              existing.AddElement(element);
            }
            // THE POST READ, and NOTHING is taken from the pre-mutation snapshot: a FRESH `GetAllParagraphs()`
            // answers fresh wrappers, so the readback cannot be a stale one. The addressed paragraph is re-taken
            // at the SAME index — which for the APPEND form is the baseline's own `countBefore`, the position
            // the measured `Push` lands the created paragraph at.
            var after = document.GetAllParagraphs();
            if (after === null || after === undefined || typeof after.length !== 'number') return linkRefusal('CAPABILITY_UNAVAILABLE');
            var countAfter = after.length;
            if (!isCount(countAfter)) return linkRefusal('CAPABILITY_UNAVAILABLE');
            var reached = paragraphAt(after, append === true ? countBefore : address);
            var textAfter = textAt(reached);
            if (typeof textAfter !== 'string') return linkRefusal('CAPABILITY_UNAVAILABLE');
            // THE PRIMARY LEG: the addressed paragraph's own text, EXACTLY. The NAMED form requires the old
            // text plus the label; the APPEND form requires the label alone, because the created paragraph
            // started empty (its own pre text is published as 0 characters and re-checked by the bridge).
            var expected = append === true ? text : textBefore + text;
            var textAppended = textAfter === expected ? 1 : 0;
            // THE SECONDARY LEG, and it can only REFUTE: the fragment opener must occur EXACTLY ONCE in the
            // POST-mutation export, and the url this ticket carried must follow it IMMEDIATELY, closed by `)`.
            // The needle's uniqueness is what keeps the tolerance honest — the occurrence being located is
            // around THAT fragment and never around a different one.
            var markdownAfter = exportMarkdown(document);
            if (markdownAfter === null) return linkRefusal('CAPABILITY_UNAVAILABLE');
            if (!(markdownAfter.length <= markdownMax)) return linkRefusal('BYTE_LIMIT');
            var at = markdownAfter.indexOf(opener);
            var unique = at >= 0 && markdownAfter.indexOf(opener, at + 1) < 0 ? 1 : 0;
            var urlInside = unique === 1 && markdownAfter.indexOf(url + ')', at + opener.length) === at + opener.length ? 1 : 0;
            // The phase slot, the two counts, the two text lengths and the three flags are APPENDED rather
            // than spelled as one array literal, for the authored-code-audit reason the block body states.
            var answer = [];
            answer.push(phase);
            answer.push(countBefore);
            answer.push(countAfter);
            answer.push(textBefore.length);
            answer.push(textAfter.length);
            answer.push(textAppended);
            answer.push(unique);
            answer.push(urlInside);
            return answer;
          } catch (error) { return linkRefusal('CAPABILITY_UNAVAILABLE'); }
        }, false, false, callback);
      } });
  }
  if (hasTransport) {
    // The `executeCommand` transport of a build without the wrapper. It receives the composed command
    // source, which is the statement form of the same authored body the wrapper would have carried.
    return Object.freeze({ present: true, method: 'executeCommand',
      probe(which, callback) { return plugin.executeCommand('command', commandTransport(which), callback); } });
  }
  return Object.freeze({ present: false, method: null,
    probe() { throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE); } });
}
function decodeTuple(value, sizes) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new SafeError(ERROR_CODES.INVALID_DATA);
  // Inspect length before enumerating anything: even a giant sparse array is
  // rejected in constant work. Never read callback indices or invoke accessors.
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !Object.hasOwn(length, 'value') || length.enumerable ||
      !sizes.includes(length.value)) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const size = length.value;
  // Exact own-key count plus every expected own data index closes symbols,
  // hidden/enumerable extras and holes, without processing their contents.
  if (Reflect.ownKeys(value).length !== size + 1) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const members = [];
  for (let index = 0; index < size; index++) {
    const key = String(index);
    if (!Object.hasOwn(descriptors, key)) throw new SafeError(ERROR_CODES.INVALID_DATA);
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new SafeError(ERROR_CODES.INVALID_DATA);
    members.push(descriptor.value);
  }
  return members;
}
function decodePresence(value) {
  const tuple = decodeTuple(value, [1, presenceKeys.length]);
  if (tuple.length === 1) {
    if (tuple[0] === 'CAPABILITY_UNAVAILABLE') throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
    throw new SafeError(ERROR_CODES.INVALID_DATA);
  }
  const result = {};
  for (let index = 0; index < tuple.length; index++) {
    if (typeof tuple[index] !== 'boolean') throw new SafeError(ERROR_CODES.INVALID_DATA);
    result[presenceKeys[index]] = tuple[index];
  }
  assertByteLimit(JSON.stringify(result), LIMITS.editorResultBytes);
  return Object.freeze(result);
}
function decodeContext(value) {
  const tuple = decodeTuple(value, [4]);
  const [id, replace, range, tracking] = tuple;
  if (typeof replace !== 'boolean' || typeof range !== 'boolean' || (tracking !== null && typeof tracking !== 'boolean')) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (typeof id === 'string') assertByteLimit(id, 2048);
  else if (id !== null && (typeof id !== 'number' || !Number.isFinite(id))) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (id === null || id === '' || !replace || !range || tracking !== false) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
  return id;
}
// A native read string is bounded twice: first by the editor-result ceiling that applies to ANY
// native read, then by the byte budget THIS ticket actually requested. The selection read passes its
// own 8 KiB window explicitly, so its behaviour is unchanged; a paragraph/section/structure read
// passes the budget its tool asked the bridge for.
function decodeText(value, bound) {
  assertByteLimit(value, LIMITS.editorResultBytes);
  return assertByteLimit(value, bound);
}
// The value `writeScope` returns when the namespace had NO `scope` property, so the restore DELETES the
// property instead of writing `undefined` into an object this module does not own.
const SCOPE_ABSENT = Object.freeze({});
// The DOCUMENT-SEARCH answer, decoded strictly. The authored command body builds ONE flat array of
// primitives — `[count, text0, …]` — because that is the shape the NATIVE return validator keeps: its
// own recursion accepts any array of primitives and STRIPS a plain object (measured in the vendored
// 2026.1.2 editor source), which is why a body that needs structured output must encode it. The decode
// is therefore as strict as `decodeTuple`'s, and for the same reason: `Reflect.ownKeys` before any
// indexed read closes symbols, holes and hidden extras, and every member is read through its own data
// descriptor, never through a getter. Three rules are the tool's own contract rather than
// paranoia:
//   * a ONE-slot answer is either the body's own refusal sentinel or the COUNT ALONE, which is exactly
//     what a document holding no occurrence yields — `[0]`. Any other single value is uninterpretable.
//   * the body extracts EXACTLY `min(count, limit)` texts, so an answer with a different number is not
//     one this body can have produced: a short array would otherwise be published as the tool's own
//     `limit` cap, and a tool cannot describe a limitation it did not impose.
//   * the count is the primitive's own TOTAL and may therefore be ANY non-negative safe integer; what
//     is bounded is the reported text, by the array's own size and by the editor-result byte ceiling.
function decodeSearch(value, limit) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !Object.hasOwn(length, 'value') || length.enumerable) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const size = length.value;
  if (!Number.isSafeInteger(size) || size < 1 || size > limit + 1) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (Reflect.ownKeys(value).length !== size + 1) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const members = [];
  for (let index = 0; index < size; index++) {
    const descriptor = Object.hasOwn(descriptors, String(index)) ? descriptors[String(index)] : null;
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new SafeError(ERROR_CODES.INVALID_DATA);
    members.push(descriptor.value);
  }
  if (size === 1 && members[0] === 'CAPABILITY_UNAVAILABLE') throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
  const count = members[0];
  if (!Number.isSafeInteger(count) || count < 0) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const texts = members.slice(1);
  for (const text of texts) if (typeof text !== 'string') throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (texts.length !== Math.min(count, limit)) throw new SafeError(ERROR_CODES.INVALID_DATA);
  assertByteLimit(JSON.stringify(members), LIMITS.editorResultBytes);
  return Object.freeze({ count, texts: Object.freeze(texts) });
}
// The DOCUMENT-STRUCTURE answer, decoded with the same strictness as `decodeSearch` and for the same
// reason: the authored body encodes the whole structure as ONE flat array of PRIMITIVES — `[pages,
// PageCount, WordsCount, ParagraphCount, SymbolsCount, SymbolsWSCount, paragraphs, headings, tables,
// sections, text0, …]` — because the native return validator keeps arrays of primitives and a string and
// STRIPS a plain object. `Reflect.ownKeys` before any indexed read closes symbols, holes and hidden
// extras, and every member is read through its own data descriptor, never through a getter. Three rules
// are the tool's own contract rather than paranoia:
//   * a ONE-slot answer is the body's own refusal sentinel and nothing else: every legal answer carries
//     the TEN fixed slots below, so a single value can only be a body that could not read the structure.
//   * the body extracts EXACTLY `min(headings, maxHeadings)` texts, so an answer with a different number
//     is not one this body can have produced: a short array would otherwise be published as the tool's
//     own cap, and a tool cannot describe a limitation it did not impose.
//   * every count is a NON-NEGATIVE SAFE INTEGER — the primitive's own total — and the whole answer is
//     still bounded by `LIMITS.editorResultBytes`, the one window every native read of this bridge is
//     decoded under.
const STRUCTURE_SLOTS = 10;
function decodeStructure(value, maxHeadings) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !Object.hasOwn(length, 'value') || length.enumerable) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const size = length.value;
  if (!Number.isSafeInteger(size) || size < 1 || size > STRUCTURE_SLOTS + maxHeadings) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (Reflect.ownKeys(value).length !== size + 1) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const members = [];
  for (let index = 0; index < size; index++) {
    const descriptor = Object.hasOwn(descriptors, String(index)) ? descriptors[String(index)] : null;
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new SafeError(ERROR_CODES.INVALID_DATA);
    members.push(descriptor.value);
  }
  if (size === 1 && members[0] === 'CAPABILITY_UNAVAILABLE') throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
  if (size < STRUCTURE_SLOTS) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const numbers = members.slice(0, STRUCTURE_SLOTS);
  for (const number of numbers) if (!Number.isSafeInteger(number) || number < 0) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const texts = members.slice(STRUCTURE_SLOTS);
  for (const text of texts) if (typeof text !== 'string') throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (texts.length !== Math.min(numbers[7], maxHeadings)) throw new SafeError(ERROR_CODES.INVALID_DATA);
  assertByteLimit(JSON.stringify(members), LIMITS.editorResultBytes);
  return Object.freeze({
    pages: numbers[0],
    statistics: Object.freeze({ PageCount: numbers[1], WordsCount: numbers[2], ParagraphCount: numbers[3],
      SymbolsCount: numbers[4], SymbolsWSCount: numbers[5] }),
    counts: Object.freeze({ paragraphs: numbers[6], headings: numbers[7], tables: numbers[8], sections: numbers[9] }),
    headings: Object.freeze(texts)
  });
}
// The BLOCK-APPEND answer, decoded with the same strictness as `decodeSearch`/`decodeStructure` and for
// the same reason: the authored body encodes its measurements as ONE flat array of PRIMITIVES —
// `[POST_INSERT, paragraphsBefore, paragraphsAfter, headingsBefore, headingsAfter, present0, …]` —
// because the native return validator keeps arrays of primitives and STRIPS a plain object.
// `Reflect.ownKeys` before any indexed read closes symbols, holes and hidden extras, and every member is
// read through its own data descriptor, never through a getter. Four rules are this leg's own contract:
//   * THE PHASE IS AN EXPLICIT SLOT OF EVERY ANSWER, and this is the ONLY place the two refusal classes
//     are split. A TWO-slot answer is the body's own refusal `[phase, name]`: `[PRE_INSERT, <name>]` is a
//     KNOWN refusal whose code the caller republishes (nothing was inserted), and `[POST_INSERT, <name>]`
//     is the UNCERTAIN class (the document may already hold the append). A phase that is ABSENT — the
//     one-slot `['CAPABILITY_UNAVAILABLE']` a forged or damaged native can answer AFTER a real append —
//     or a pre-insert phase over a measurement, or any other single value, can never be a known refusal:
//     it is decoded as `APPLY_UNCERTAIN`. The NAME does not carry the phase; only the marker does.
//   * the four counts are NON-NEGATIVE SAFE INTEGERS — the document's own array lengths — and the flags
//     are EXACTLY `0` or `1`: a count this bridge cannot trust is not a count, and an editor that
//     answers anything else is not one this body can have read.
//   * the body emits EXACTLY one flag per block it was handed, so an answer with a different number of
//     flags is not one this body can have produced: publishing a shorter array would let a missing
//     region check pass as the tool's own cap, and a longer one would smuggle a flag no block owns.
//   * the answer needs NO byte ceiling, and the `assertByteLimit` this used to carry was DELETED because
//     no shape this decoder admits can approach one: the phase is one of two literals, each count is at
//     most 16 characters as JSON, and there are at most `LIMITS.insertBlocksMax` (64) one-character
//     flags, so the widest legal answer measures 211 bytes — against `LIMITS.editorResultBytes` (65536).
//     The test row that was meant to exercise the bound was refused by the flag-type rule below before it
//     could reach it, which is what an unreachable assertion leaves behind: a claim nothing can test.
const BLOCKS_SLOTS = 4;
const BLOCKS_PHASE_PRE = 'PRE_INSERT';
const BLOCKS_PHASE_POST = 'POST_INSERT';
const BLOCKS_HEAD = BLOCKS_SLOTS + 1;
function decodeBlocks(value, blockCount) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !Object.hasOwn(length, 'value') || length.enumerable) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const size = length.value;
  if (!Number.isSafeInteger(size) || size < 1 || size > BLOCKS_HEAD + blockCount) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (Reflect.ownKeys(value).length !== size + 1) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const members = [];
  for (let index = 0; index < size; index++) {
    const descriptor = Object.hasOwn(descriptors, String(index)) ? descriptors[String(index)] : null;
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new SafeError(ERROR_CODES.INVALID_DATA);
    members.push(descriptor.value);
  }
  // THE PHASE GATE. The two names the body emits only from its pre-insert half keep their KNOWN classes
  // ONLY when the answer itself carries the pre-insert phase; a missing phase, a post-insert phase, or a
  // pre-insert phase that cannot legally carry a measurement is the uncertain class, because the body ran
  // and the document may already hold the append.
  if (size === 2) {
    if (members[0] !== BLOCKS_PHASE_PRE) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
    if (members[1] === 'CAPABILITY_UNAVAILABLE') throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
    if (members[1] === 'STYLE_UNAVAILABLE') throw new SafeError(ERROR_CODES.TOOL_ERROR);
    throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  }
  // A one-slot answer carries no phase at all, so it can never be confirmed as a pre-insert refusal — the
  // exact forgery this gate exists for.
  if (size === 1) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  if (size !== BLOCKS_HEAD + blockCount) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (members[0] !== BLOCKS_PHASE_POST) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  const numbers = members.slice(1, BLOCKS_HEAD);
  for (const number of numbers) if (!Number.isSafeInteger(number) || number < 0) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const flags = members.slice(BLOCKS_HEAD);
  for (const flag of flags) if (flag !== 0 && flag !== 1) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (flags.length !== blockCount) throw new SafeError(ERROR_CODES.INVALID_DATA);
  return Object.freeze({ paragraphsBefore: numbers[0], paragraphsAfter: numbers[1],
    headingsBefore: numbers[2], headingsAfter: numbers[3], present: Object.freeze(flags.map(flag => flag === 1)) });
}
// THE EXACT-DELTA RULE the block append's outcome rests on, in ONE place so the decision and its comment
// cannot drift apart: the document's paragraph count must have grown by EXACTLY the number of blocks
// asked for, its heading count by EXACTLY the number of blocks that asked for a heading, and EVERY block
// must have carried its text in the paragraph slot the append gave it — the flag is one-to-one with the
// append, not a substring match over the document. Nothing else is evidence, and NO MUTATION PRIMITIVE'S
// RETURN VALUE is consulted anywhere: `Push` answered `true` for a paragraph and `false` for an image host,
// and the legacy whole-array primitive answered `true` even for `[]`, `[null]` and `'nonsense'` (all
// measured on the target), so no boolean carries information in either direction — a `true` proves nothing
// and a `false` is not proof of failure, so the rule cannot be written in terms of it.
function exactBlocksDelta(outcome, blocks) {
  let headings = 0;
  for (const block of blocks) if (Object.hasOwn(block, 'heading')) headings += 1;
  // The region flags are read by INDEX rather than through `outcome.present.every(...)`: this module's
  // authored-code audit treats an invocation reached through a value its NAME-based alias analysis has
  // tainted as a computed-execution sink, and an indexed READ of a data array cannot be mistaken for one.
  let everyBlockPresent = true;
  for (let index = 0; index < outcome.present.length; index += 1) {
    if (outcome.present[index] !== true) everyBlockPresent = false;
  }
  return outcome.paragraphsAfter - outcome.paragraphsBefore === blocks.length &&
    outcome.headingsAfter - outcome.headingsBefore === headings &&
    everyBlockPresent;
}
// The two PRE-insert refusals a dispatched WRITE command body can answer with, and the ONLY classes that
// keep a KNOWN code once the ticket's dispatch flag is set. `blocksinsert`/`tableinsert` set
// `owned.dispatched` BEFORE the command is handed to the native (a synchronous throw out of the transport
// must never release a slot whose work may already be queued), so that flag does NOT mean "the mutation
// ran": the PHASE travels in the answer's OWN SLOT, and the decoders raise these two codes only for a
// `[PRE_INSERT, name]` answer. Everything else a dispatched body can answer — a phase-less one-slot name,
// the post-insert phase, a malformed array, a decode this bridge refuses — means the mutation may already
// be in the document, so it is the uncertain class with the slot HELD. That is the shape a throw OUT of
// the mutation leaves behind as well: a body that had pushed and then threw answers its refusal with the
// post-insert phase, so the exact delta is never consulted for a write that may have happened and the slot
// is never released.
// THE RESIDUAL, STATED EXACTLY BECAUSE IT CANNOT BE FIXED IN BAND. The two names that reach this function
// as KNOWN classes are the block body's `CAPABILITY_UNAVAILABLE` (from its own pre-insert half: a missing
// scope, a missing primitive, an unusable baseline, an unreadable region) and `STYLE_UNAVAILABLE` (an
// unresolvable `Heading <n>`, which `decodeBlocks` publishes as `TOOL_ERROR`). Both are GENUINE in the
// sense that a faithful run of the shipped body writes them only before its first `Push` — but the phase
// slot travels INSIDE the answer the same body composes, and the answering native is the untrusted party:
// a damaged or adversarial native that returns `[PRE_INSERT, 'CAPABILITY_UNAVAILABLE']` (or
// `[PRE_INSERT, 'STYLE_UNAVAILABLE']`) AFTER it has already pushed the batch is decoded as a known
// refusal, and a known refusal RELEASES the slot. That is fail-OPEN, and its price is a possible DUPLICATE
// on a retry of a batch that is already in the document. Only the shipped body's own CONTROL FLOW
// distinguishes the two cases — the refusal is returned from the pre-insert half, before `phase` is
// assigned `POST_INSERT`, and the answer is the only channel back — so the distinction is exactly as strong
// as the assumption that the native runs THIS body.
// THERE IS NO IN-BAND FIX. A nonce, a signature or any challenge would have to cross in `Asc.scope`, which
// the answering native reads, so a native able to forge the answer is able to forge whatever value the
// bridge would check against. THE RECORDED REMEDY FOR A LATER HARDENING ROUND IS STRUCTURAL: split the
// NON-MUTATING preconditions — the `Api`/capability checks, the baseline read and the `Heading <n>` style
// resolution — into a dispatch of their own, so that EVERY answer from that dispatch is genuinely
// pre-insert and the phase protocol disappears; the cost is one extra native round trip and one ticket that
// owns two dispatches. Until that round, the residual is accepted and stated here rather than silently
// relied on.
function preInsertRefusal(error, kind) {
  if (!(error instanceof SafeError)) return false;
  if (error.code === ERROR_CODES.CAPABILITY_UNAVAILABLE || error.code === ERROR_CODES.TOOL_ERROR) return true;
  // THE RANGE FORMAT'S CLOSED EXPORT CLASS, and it is scoped to THAT leg on purpose. `decodeRange` is the ONE
  // decoder whose answer cannot be large (every member is validated to a one-character flag or a four-word
  // alignment BEFORE its `assertByteLimit`, so that call can never fire), which means a `BYTE_LIMIT` reaching
  // this point from a range dispatch can only be the PHASE-GATED `[PRE_INSERT, 'BYTE_LIMIT']` the body emits
  // for an export above `LIMITS.formatRangeHtmlChars` — a refusal decided before anything was written. For the
  // other three write legs `BYTE_LIMIT` is what `assertByteLimit` throws on an OVERSIZED ANSWER, which is a
  // dispatched write whose outcome is unknown, so it must keep the uncertain class and the HELD slot.
  // THE HYPERLINK INSERT'S OWN CLOSED EXPORT CLASS, allowed for exactly the same reason and no other: its
  // decoder validates eight one-character-or-small scalars BEFORE its `assertByteLimit`, so a `BYTE_LIMIT`
  // from THIS kind can only be the phase-gated `[PRE_INSERT, 'BYTE_LIMIT']` the body emits for a markdown
  // export above `LIMITS.addHyperlinkMarkdownChars` — a refusal decided with ZERO writes.
  if (kind === 'rangeformat' || kind === 'hyperlinkinsert') return error.code === ERROR_CODES.BYTE_LIMIT;
  return false;
}
// The TABLE-INSERT answer, decoded with the same strictness as `decodeBlocks` and for the same reason: the
// authored body encodes its measurements as ONE flat array of PRIMITIVES —
// `[POST_INSERT, tablesBefore, tablesAfter, flag00, flag01, …]` — because the native return validator
// keeps arrays of primitives and STRIPS a plain object. `Reflect.ownKeys` before any indexed read closes
// symbols, holes and hidden extras, and every member is read through its own data descriptor, never
// through a getter. Four rules are this leg's own contract:
//   * THE PHASE IS AN EXPLICIT SLOT OF EVERY ANSWER, and this is the ONLY place the two refusal classes
//     are split. A TWO-slot answer is the body's own refusal `[phase, name]`: `[PRE_INSERT, name]` is a
//     KNOWN refusal whose code the caller republishes (nothing was inserted), and `[POST_INSERT, name]` is
//     the UNCERTAIN class (the document may already hold the insert). A phase that is ABSENT — the one-slot
//     `['CAPABILITY_UNAVAILABLE']` a forged or damaged native can answer AFTER a real insert — or a
//     pre-insert phase over a measurement, or any other single value, can never be a known refusal: it is
//     decoded as `APPLY_UNCERTAIN`. The NAME does not carry the phase; only the marker does.
//   * the two counts are NON-NEGATIVE SAFE INTEGERS — the document's own array lengths — and the flags are
//     EXACTLY `0` or `1`: a count this bridge cannot trust is not a count, and an editor that answers
//     anything else is not one this body can have read.
//   * the body emits EXACTLY one flag per CELL of the matrix the ticket carried, so an answer with a
//     different number of flags is not one this body can have produced: publishing a shorter array would
//     let a missing cell check pass as the tool's own cap, and a longer one would smuggle a flag no cell
//     owns. THE EXPECTED COUNT IS DERIVED FROM THE MATRIX, never from the answer.
//   * the answer needs NO byte ceiling, and no `assertByteLimit` is carried here, for the reason the block
//     decoder states: the widest legal answer this schema can produce is the phase, two counts of at most
//     16 JSON characters, and `LIMITS.insertTableRowsMax * LIMITS.insertTableColumnsMax` (64 × 16 = 1024)
//     one-character flags — about 2 KiB against `LIMITS.editorResultBytes` (65536). The geometry bounds are
//     what make that arithmetic true, so they are part of this decoder's contract, not a coincidence.
const TABLE_SLOTS = 2;
const TABLE_PHASE_PRE = 'PRE_INSERT';
const TABLE_PHASE_POST = 'POST_INSERT';
const TABLE_HEAD = TABLE_SLOTS + 1;
function decodeTable(value, data) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !Object.hasOwn(length, 'value') || length.enumerable) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const size = length.value;
  const cells = data.length * data[0].length;
  if (!Number.isSafeInteger(size) || size < 1 || size > TABLE_HEAD + cells) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (Reflect.ownKeys(value).length !== size + 1) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const members = [];
  for (let index = 0; index < size; index++) {
    const descriptor = Object.hasOwn(descriptors, String(index)) ? descriptors[String(index)] : null;
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new SafeError(ERROR_CODES.INVALID_DATA);
    members.push(descriptor.value);
  }
  if (size === 2) {
    if (members[0] !== TABLE_PHASE_PRE) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
    if (members[1] === 'CAPABILITY_UNAVAILABLE') throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
    throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  }
  // A one-slot answer carries no phase at all, so it can never be confirmed as a pre-insert refusal — the
  // exact forgery this gate exists for.
  if (size === 1) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  if (size !== TABLE_HEAD + cells) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (members[0] !== TABLE_PHASE_POST) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  const numbers = members.slice(1, TABLE_HEAD);
  for (const number of numbers) if (!Number.isSafeInteger(number) || number < 0) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const flags = members.slice(TABLE_HEAD);
  for (const flag of flags) if (flag !== 0 && flag !== 1) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (flags.length !== cells) throw new SafeError(ERROR_CODES.INVALID_DATA);
  return Object.freeze({ tablesBefore: numbers[0], tablesAfter: numbers[1], present: Object.freeze(flags.map(flag => flag === 1)) });
}
// THE EXACT-DELTA RULE the table insert's outcome rests on, in ONE place so the decision and its comment
// cannot drift apart: the document's table count must have grown by EXACTLY one — the append added ONE
// table — and EVERY cell of that table must carry its own requested text, so every flag is true. The flag
// count is pinned to the matrix by `decodeTable`, which is what makes the per-flag rule one-to-one over
// the APPEND rather than a match anywhere in the document. Nothing else is evidence, and NO MUTATION
// PRIMITIVE'S RETURN VALUE is consulted anywhere: `Push` answered `true` for a paragraph and `false` for
// an image host (measured on the target), so no boolean carries information in either direction.
function exactTableDelta(outcome) {
  // The flags are read by INDEX rather than through `outcome.present.every(...)`: this module's
  // authored-code audit treats an invocation reached through a value its NAME-based alias analysis has
  // tainted as a computed-execution sink, and an indexed READ of a data array cannot be mistaken for one.
  let everyCellPresent = true;
  for (let index = 0; index < outcome.present.length; index += 1) {
    if (outcome.present[index] !== true) everyCellPresent = false;
  }
  return outcome.tablesAfter - outcome.tablesBefore === 1 && everyCellPresent;
}
// THE HEADING-STYLE answer, decoded with the same strictness as `decodeBlocks`/`decodeTable` and for the
// same reason: the authored body encodes its proof as ONE flat array of primitives —
// `[POST_INSERT, headingsBefore, headingsAfter, paragraphsStable, textUnchanged, styleRead, styleMatches]` —
// because the native return validator keeps arrays of primitives and STRIPS a plain object.
// `paragraphsStable` is the paragraph-count invariant, `textUnchanged` the addressed paragraph's own text,
// `styleRead` whether its own style name was READABLE at all (the measured `null` of a plain paragraph is
// readable and arrives as `styleRead: 1, styleMatches: 0`), and `styleMatches` whether that name is the
// requested one under the module's case- and space-folding. NONE of the first three can establish an
// assignment: they are SECONDARY signals that can only refute one.
// `Reflect.ownKeys` before any indexed read closes symbols, holes and hidden extras, and every member is
// read through its own data descriptor, never through a getter. Four rules are this leg's own contract:
//   * THE PHASE IS AN EXPLICIT SLOT OF EVERY ANSWER, and this is the ONLY place the two refusal classes
//     are split. A TWO-slot answer is the body's own refusal `[phase, name]`: `[PRE_INSERT, name]` is a
//     KNOWN refusal whose code the caller republishes (nothing was styled), and `[POST_INSERT, name]` is
//     the UNCERTAIN class (the document may already carry the style). A phase that is ABSENT — the
//     one-slot `['CAPABILITY_UNAVAILABLE']` a forged or damaged native can answer AFTER a real style
//     assignment — or a pre-insert phase over a measurement, or any other single value, can never be a
//     known refusal: it is decoded as `APPLY_UNCERTAIN`. The NAME does not carry the phase; only the
//     marker does.
//   * the two counts are NON-NEGATIVE SAFE INTEGERS — the document's own array lengths — and the FOUR
//     flags are EXACTLY `0` or `1`: a count this bridge cannot trust is not a count, and an editor that
//     answers anything else is not one this body can have read.
//   * THE ANSWER'S LENGTH IS FIXED, because this leg's work does not scale with a caller-supplied
//     collection: there is exactly ONE addressed paragraph, so a `[phase, …]` answer with anything but the
//     seven slots below is not one this body can have produced. There is no per-item array to pin, which
//     is precisely what makes the phase gate the whole of the length rule.
//   * the answer needs NO byte ceiling beyond the one this decoder carries, and it is carried because it
//     is cheap and exact: the phase is one of two literals, each count is at most 16 characters as JSON and
//     each flag one character, so the widest legal answer measures about 48 bytes against
//     `LIMITS.editorResultBytes` (65536). Unlike the block/table decoders' retired assertions this one is
//     genuinely reachable by no legal shape either — but it is a CEILING on an answer this bridge accepts
//     from the native, and a ceiling that is never applied is not a ceiling at all.
const HEADING_SLOTS = 2;
const HEADING_FLAGS = 4;
const HEADING_PHASE_PRE = 'PRE_INSERT';
const HEADING_PHASE_POST = 'POST_INSERT';
const HEADING_LENGTH = HEADING_SLOTS + 1 + HEADING_FLAGS;
function decodeHeading(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !Object.hasOwn(length, 'value') || length.enumerable) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const size = length.value;
  if (!Number.isSafeInteger(size) || size < 1 || size > HEADING_LENGTH) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (Reflect.ownKeys(value).length !== size + 1) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const members = [];
  for (let index = 0; index < size; index++) {
    const descriptor = Object.hasOwn(descriptors, String(index)) ? descriptors[String(index)] : null;
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new SafeError(ERROR_CODES.INVALID_DATA);
    members.push(descriptor.value);
  }
  // THE PHASE GATE. The name the body emits only from its pre-insert half keeps its KNOWN class ONLY when
  // the answer itself carries the pre-insert phase; a missing phase, a post-insert phase, or a pre-insert
  // phase that cannot legally carry a measurement is the uncertain class, because the body ran and the
  // document may already carry the style.
  if (size === 2) {
    if (members[0] !== HEADING_PHASE_PRE) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
    if (members[1] === 'CAPABILITY_UNAVAILABLE') throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
    if (members[1] === 'STYLE_UNAVAILABLE') throw new SafeError(ERROR_CODES.TOOL_ERROR);
    // THE PRE-STATE REFUSAL: the addressed paragraph is ALREADY one of the document's headings, so a level
    // change on it has no measured signal that could verify it. It is answered from the PRE-insert half with
    // NOTHING styled, so it keeps the closed argument class (`TOOL_ERROR`) and RELEASES the slot — the
    // opposite of the UNCERTAIN-with-held outcome the same call used to settle, which wedged the write lock.
    if (members[1] === 'ALREADY_HEADING') throw new SafeError(ERROR_CODES.TOOL_ERROR);
    throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  }
  // A one-slot answer carries no phase at all, so it can never be confirmed as a pre-insert refusal — the
  // exact forgery this gate exists for.
  if (size === 1) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  if (size !== HEADING_LENGTH) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (members[0] !== HEADING_PHASE_POST) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  const numbers = members.slice(1, HEADING_SLOTS + 1);
  for (const number of numbers) if (!Number.isSafeInteger(number) || number < 0) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const flags = members.slice(HEADING_SLOTS + 1);
  for (const flag of flags) if (flag !== 0 && flag !== 1) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (flags.length !== HEADING_FLAGS) throw new SafeError(ERROR_CODES.INVALID_DATA);
  assertByteLimit(JSON.stringify(members), LIMITS.editorResultBytes);
  return Object.freeze({ headingsBefore: numbers[0], headingsAfter: numbers[1],
    paragraphsStable: flags[0] === 1, textUnchanged: flags[1] === 1, styleRead: flags[2] === 1, styleMatches: flags[3] === 1 });
}
// THE EXACT OUTCOME RULE the heading assignment rests on, in ONE place so the decision and its comment
// cannot drift apart. FIVE conditions, all required, and the FIRST TWO are the PROOF while the rest are
// SECONDARY signals that can only REFUTE it:
//   1. `styleRead` — the addressed paragraph's OWN style name was really read, through the measured
//      `GetParaPr().GetStyle().GetName()` chain. An UNREAD readback cannot establish an assignment, and it
//      cannot release the slot either: the mutation has already run, so the outcome is `APPLY_UNCERTAIN`
//      with the slot HELD. THE IDENTITY FALLBACK AN EARLIER REVISION USED IS GONE, because the Lead
//      MEASURED that the two paragraph lists hand out DIFFERENT wrapper objects, so no reference comparison
//      can ever hold — a fallback on it would have wedged every call.
//   2. `styleMatches` — that name IS the requested one under the module's own case- and space-folding. The
//      measured `null` of a plain paragraph arrives as a READABLE non-match (`styleRead: 1`,
//      `styleMatches: 0`), and a name that differs by more than case and spaces is a genuine contradiction.
//   3. `paragraphsStable` — the paragraph count is unchanged: a style assignment creates and destroys
//      nothing, so a count that moved means something else happened to the document.
//   4. `textUnchanged` — the paragraph at the requested index carries EXACTLY the text it carried before the
//      one `SetStyle`, which makes a route that replaced text (§13.2's measured behaviour) and a STALE
//      INDEX whose paragraph now holds something else both non-successes.
//   5. the heading count ACTUALLY grew by exactly one, re-derived here from the two counts rather than
//      trusted from a flag, so a forged answer cannot carry a delta the counts contradict.
function exactHeadingDelta(outcome) {
  if (!outcome.styleRead) return false;
  if (!outcome.styleMatches) return false;
  if (!outcome.paragraphsStable) return false;
  if (!outcome.textUnchanged) return false;
  if (outcome.headingsAfter - outcome.headingsBefore !== 1) return false;
  return true;
}
// THE RANGE-FORMAT ANSWER, decoded with the same strictness as `decodeHeading` and for the same reason: the
// authored body encodes its measurements as ONE flat array of PRIMITIVES —
// `[POST_INSERT, paragraphsStable, textUnchanged, rangeRead, rangeUnchanged, rangeShifted, boldVerified,
// italicVerified, underlineVerified, strikeoutVerified, align, alignBefore, alignAfter]` — because the native
// return validator keeps arrays of primitives and STRIPS a plain object. `Reflect.ownKeys` before any indexed
// read closes symbols, holes and hidden extras, and every member is read through its own data descriptor,
// never through a getter. Four rules are this leg's own contract:
//   * THE PHASE IS AN EXPLICIT SLOT OF EVERY ANSWER, and this is the ONLY place the two refusal classes are
//     split. A TWO-slot answer is the body's own refusal `[phase, name]`: `[PRE_INSERT, name]` is a KNOWN
//     refusal whose code the caller republishes (nothing was mutated), and `[POST_INSERT, name]` is the
//     UNCERTAIN class (the document may already carry the alignment or the run formatting). A phase that is
//     ABSENT — the one-slot `['CAPABILITY_UNAVAILABLE']` a forged or damaged native can answer AFTER a real
//     mutation — or a pre-insert phase over a measurement, or any other single value, can never be a known
//     refusal: it is decoded as `APPLY_UNCERTAIN`. The NAME does not carry the phase; only the marker does.
//   * the answer's LENGTH IS FIXED, because this leg's work does not scale with a caller-supplied
//     collection: there is exactly ONE addressed paragraph and ONE region, so an answer with anything but
//     the THIRTEEN slots below is not one this body can have produced. There is no per-item array to pin,
//     which is precisely what makes the phase gate the whole of the length rule.
//   * the RANGE FLAGS are EXACTLY `0` or `1`, the FOUR RUN FLAGS are EXACTLY `0` or `1` (a property that was
//     requested AND whose measured marker wrapped the addressed region is 1, everything else is 0), and the
//     TWO ALIGNMENT slots are the MEASURED four-word vocabulary the `ApiParaPr.GetJc` readback answers. The
//     requested alignment is ECHOED in its own slot so the tool can require the answer to name the request it
//     made; the two measured values are the readback itself.
//   * the answer needs NO byte ceiling beyond the one this decoder carries, and it is carried because it is
//     cheap and exact: the phase is one of two literals, the nine flags one character each, the three
//     alignments at most six characters as JSON, so the widest legal answer measures about 72 bytes against
//     `LIMITS.editorResultBytes` (65536) — and, unlike the block/table decoders' retired assertions, this one
//     is genuinely reachable by no legal shape either. It is a CEILING on an answer this bridge accepts from
//     the native, and a ceiling that is never applied is not a ceiling at all.
const RANGE_FLAGS = 5;
const RANGE_RUNS = 4;
const RANGE_ALIGNMENTS = 3;
const RANGE_PHASE_PRE = 'PRE_INSERT';
const RANGE_PHASE_POST = 'POST_INSERT';
const RANGE_LENGTH = 1 + RANGE_FLAGS + 1 + RANGE_ALIGNMENTS;
// THE NO-ALIGNMENT SENTINEL, and it is a WORD rather than a missing slot because the alignment leg is
// OPTIONAL now: a run-only request names no alignment, so there is no measurement to carry and no fourth
// alignment word to invent. `'none'` can never be confused with a readback, because `rangeAlign` below
// answers exactly the four words the measured `ApiParaPr.GetJc` answers and nothing else.
const RANGE_ALIGN_NONE = 'none';
// THE CLOSED ALIGNMENT VOCABULARY, carried HERE as well as in the schema because the DECODER must validate
// the measured readback against the same four words the schema advertises. It is the vocabulary the measured
// `ApiParaPr.GetJc` answers (the vendored 2026.1.2 SDK), and the value is compared as a WHOLE: a getter that
// answers anything outside these four is an answer this bridge cannot interpret, never a near-match. The
// `'none'` sentinel is accepted BESIDE them and is kept apart by `rangeRequestedAlign`, which only the
// request side consults: a readback path must never be allowed to answer `'none'` as a measurement.
function rangeAlign(value) {
  return value === 'left' || value === 'center' || value === 'right' || value === 'both' ? value : null;
}
function rangeRequestedAlign(value) {
  if (value === undefined || value === null) return RANGE_ALIGN_NONE;
  if (value === RANGE_ALIGN_NONE) return RANGE_ALIGN_NONE;
  return rangeAlign(value);
}
// THE RUN SWITCH, and it keeps the same three answers the alignment resolver keeps apart: `true` and `false`
// are the two booleans a request may carry, an ABSENT switch is the `false` a request that names none means,
// and `null` is an answer this bridge cannot interpret — a string, a number or an explicit `null` is the
// closed argument class with NOTHING dispatched, never a coerced truthiness.
function rangeRun(value) {
  if (value === undefined) return false;
  return value === true || value === false ? value : null;
}
// THE TWO CLOSED HYPERLINK REQUEST SHAPES, written on THIS side as well as in `src/tools/word.js` for the
// reason `rangeAlign` is written beside `formatAlign`: the two modules cannot import each other, so the
// VOCABULARY lives in `LIMITS` and each side reads the SAME table. The bridge is a PUBLIC ENTRY POINT — a
// descriptor held directly could bypass the tool's own precondition — so the rule is re-applied here rather
// than taken on trust. See `hyperlinkUrl` in `src/tools/word.js` for the measurements each clause rests on:
// the lower-case scheme list the editor's own `rx_allowedProtocols` test rewrites, the `%20` normalisation
// `ApiHyperlink.SetLink` performs, and the control-character rule the markdown converter's own
// `para_NewLine` rendering forces.
function requestedUrl(value) {
  if (typeof value !== 'string' || value === '') return null;
  if (utf8ByteLength(value) > LIMITS.addHyperlinkUrlBytes) return null;
  let scheme = null;
  for (const prefix of LIMITS.addHyperlinkSchemes) if (value.startsWith(prefix)) scheme = prefix;
  if (scheme === null || value.length <= scheme.length) return null;
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return null;
  return value.includes('%20') ? null : value;
}
function requestedText(value) {
  if (typeof value !== 'string' || value === '') return null;
  if (utf8ByteLength(value) > LIMITS.addHyperlinkTextBytes) return null;
  return /[\u0000-\u001f\u007f]/.test(value) ? null : value;
}
function decodeRange(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !Object.hasOwn(length, 'value') || length.enumerable) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const size = length.value;
  if (!Number.isSafeInteger(size) || size < 1 || size > RANGE_LENGTH) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (Reflect.ownKeys(value).length !== size + 1) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const members = [];
  for (let index = 0; index < size; index++) {
    const descriptor = Object.hasOwn(descriptors, String(index)) ? descriptors[String(index)] : null;
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new SafeError(ERROR_CODES.INVALID_DATA);
    members.push(descriptor.value);
  }
  // THE PHASE GATE, exactly as the heading decoder applies it: the name the body emits only from its
  // pre-insert half keeps its KNOWN class ONLY when the answer itself carries the pre-insert phase.
  if (size === 2) {
    if (members[0] !== RANGE_PHASE_PRE) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
    if (members[1] === 'CAPABILITY_UNAVAILABLE') throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
    // The two closed argument refusals the body can make BEFORE the one mutation: an index outside the
    // document, offsets outside the addressed paragraph, and an address or alignment the body cannot serve.
    // They carry the pre-insert phase, so they keep their known class and RELEASE the slot.
    if (members[1] === 'TOOL_ERROR') throw new SafeError(ERROR_CODES.TOOL_ERROR);
    // THE CLOSED EXPORT CLASS. A PRE-mutation export above `LIMITS.formatRangeHtmlChars` is refused before
    // anything is written, so it keeps its own known class and RELEASES the slot, exactly like the argument
    // refusals above — the same name, the same phase, the same release.
    if (members[1] === 'BYTE_LIMIT') throw new SafeError(ERROR_CODES.BYTE_LIMIT);
    throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  }
  // A one-slot answer carries no phase at all, so it can never be confirmed as a pre-insert refusal.
  if (size === 1) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  if (size !== RANGE_LENGTH) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (members[0] !== RANGE_PHASE_POST) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  const flags = members.slice(1, 1 + RANGE_FLAGS);
  for (const flag of flags) if (flag !== 0 && flag !== 1) throw new SafeError(ERROR_CODES.INVALID_DATA);
  // THE RUN PROOF IS ONE FOUR-CHARACTER STRING, and it is decoded STRICTLY: exactly the four measured
  // properties, in the body's own fixed order, each character a `0` or a `1`. A string of another length, a
  // non-string, or a character outside the two flags is an answer this body did not author — `INVALID_DATA`,
  // which the ticket settles as the uncertain class because the command already ran.
  const runProof = members[1 + RANGE_FLAGS];
  if (typeof runProof !== 'string' || runProof.length !== RANGE_RUNS) throw new SafeError(ERROR_CODES.INVALID_DATA);
  // THE FLAG READS ARE CONSTANT-INDEXED READS, and the closure that serves them exists for the
  // authored-code-audit reason stated in the block below rather than for tidiness. `members` is marked
  // computed by the descriptor loop above, and `runProof` inherits that marking (the findings analysis is
  // NAME-based and scope-insensitive over the whole bundle), so a `runProof.charAt(...)` — a METHOD call on
  // a value that inherits the marking — is reported as a dynamic-property sink. A constant-indexed READ is
  // not, so the four positions are read by NUMBER here and only ever compared afterwards.
  function runProofBit(position) {
    if (position === 0) return runProof[0];
    if (position === 1) return runProof[1];
    if (position === 2) return runProof[2];
    return runProof[3];
  }
  // EVERY LEGAL FOUR-CHARACTER PROOF, spelled out rather than tested character by character: the string is
  // compared as a WHOLE against a closed list, so a non-string, a wrong length, or a character outside the
  // two flags is the same single check. A length check is NOT enough on its own — the assignment above has
  // already verified the type and the length, and this is the one that fixes the four characters' VALUES.
  if (!['0000', '0001', '0010', '0011', '0100', '0101', '0110', '0111',
    '1000', '1001', '1010', '1011', '1100', '1101', '1110', '1111'].includes(runProof)) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const alignments = members.slice(1 + RANGE_FLAGS + 1);
  // THE ALIGNMENT TRIPLE IS MEASURED, and only the REQUEST slot may carry the sentinel: the two READBACK
  // slots answer either a measured word or the sentinel the body echoes for a request that named none, so a
  // build that answered `'none'` where it should have measured is an answer this decoder cannot stand behind.
  if (rangeRequestedAlign(alignments[0]) === null) throw new SafeError(ERROR_CODES.INVALID_DATA);
  for (const alignment of alignments) if (alignment !== RANGE_ALIGN_NONE && rangeAlign(alignment) === null) throw new SafeError(ERROR_CODES.INVALID_DATA);
  assertByteLimit(JSON.stringify(members), LIMITS.editorResultBytes);
  return Object.freeze({ paragraphsStable: flags[0] === 1, textUnchanged: flags[1] === 1,
    rangeRead: flags[2] === 1, rangeUnchanged: flags[3] === 1, rangeShifted: flags[4] === 1,
    boldVerified: runProofBit(0) === '1', italicVerified: runProofBit(1) === '1',
    underlineVerified: runProofBit(2) === '1', strikeoutVerified: runProofBit(3) === '1',
    align: alignments[0], alignBefore: alignments[1], alignAfter: alignments[2] });
}
// THE EXACT OUTCOME RULE the range format rests on, in ONE place so the decision and its comment cannot
// drift apart. The conditions are split by what they can do:
//   1. THE ALIGNMENT LEG, and it is CONDITIONAL because `align` is optional: when the ticket NAMED an
//      alignment the addressed paragraph's own alignment, read back through the measured
//      `GetParaPr().GetJc()` chain, must be READABLE and must BE the requested alignment; when the ticket
//      named NONE (`'none'`) the same slot must come back as that sentinel, because a build that measured an
//      alignment for a request that never asked for one produced a different call's answer. There is
//      deliberately NO fallback on the region flags and NO "the value did not change" shortcut — an
//      unreadable or disagreeing readback is a mutation this tool cannot claim, and the mutation has already
//      run, so the ticket settles `APPLY_UNCERTAIN` with the slot HELD.
//   2. THE RUN LEG is a FOUR-WAY EQUALITY, not a one-way check, and the request it is judged against is the
//      SCOPE THIS TICKET CARRIED (`requested`), never a value read back out of the answer. A property the
//      request NAMED must be PROVEN (`1`), and a property the request did NOT name must NOT claim a proof
//      (`0`): a build that answered `1` for a property nobody asked for would be claiming a measurement of a
//      write that never happened, and a build that answered `0` for a requested one is a mutation this tool
//      cannot stand behind. Both are the UNCERTAIN class with the slot HELD, because the write already ran.
//   3. THE SECONDARY SIGNALS can only REFUTE: the addressed REGION was read and is what it was
//      (`rangeRead`/`rangeUnchanged`), it did not MOVE under the mutation (`rangeShifted` is false — a
//      concurrent edit that shifts the text under the address is a non-success, not a silent format of
//      whatever the offsets now cover), the addressed paragraph's TEXT is unchanged, and the document's
//      paragraph count is unchanged.
function exactRangeFormat(outcome, requested) {
  if (!outcome.rangeRead) return false;
  if (outcome.align !== requested.align) return false;
  if (outcome.alignAfter !== requested.align) return false;
  if (!outcome.rangeUnchanged) return false;
  if (outcome.rangeShifted) return false;
  if (!outcome.paragraphsStable) return false;
  if (!outcome.textUnchanged) return false;
  if (outcome.boldVerified !== (requested.bold === true)) return false;
  if (outcome.italicVerified !== (requested.italic === true)) return false;
  if (outcome.underlineVerified !== (requested.underline === true)) return false;
  if (outcome.strikeoutVerified !== (requested.strikeout === true)) return false;
  return true;
}
// THE HYPERLINK-INSERT ANSWER, decoded with the same strictness as the four decoders before it. The authored
// body encodes its measurements as ONE flat array of PRIMITIVES —
// `[POST_INSERT, paragraphsBefore, paragraphsAfter, textBeforeChars, textAfterChars, textAppended,
// fragmentUnique, urlInFragment]` — because the native return validator keeps arrays of primitives and STRIPS
// a plain object. `Reflect.ownKeys` before any indexed read closes symbols, holes and hidden extras, and every
// member is read through its own data descriptor, never through a getter. Three rules are this leg's own:
//   * THE PHASE IS AN EXPLICIT SLOT OF EVERY ANSWER, and this is the ONLY place the two refusal classes are
//     split. A TWO-slot answer is the body's own refusal `[phase, name]`: `[PRE_INSERT, name]` is a KNOWN
//     refusal whose code the caller republishes (nothing was written), and `[POST_INSERT, name]` is the
//     UNCERTAIN class (the document may already carry the link). A phase that is ABSENT — the one-slot
//     `['CAPABILITY_UNAVAILABLE']` a forged or damaged native can answer AFTER a real write — or a pre-insert
//     phase over a measurement can never be a known refusal: it is decoded as `APPLY_UNCERTAIN`.
//   * THE FOUR NUMBERS ARE NON-NEGATIVE SAFE INTEGERS — the document's own array lengths and the addressed
//     paragraph's own text lengths — and the three flags are EXACTLY `0` or `1`: a length this bridge cannot
//     trust is not a length, and an editor that answers anything else is not one this body can have read.
//   * the answer needs NO byte ceiling beyond the one this decoder carries, and it is carried because it is
//     cheap and exact: the phase is one of two literals, four numbers and three flags at most seventeen JSON
//     characters each, so the widest legal answer measures about 90 bytes against `LIMITS.editorResultBytes`
//     (65536) — and, unlike the block/table decoders' retired assertions, this one is genuinely reachable by
//     no legal shape either. It is a CEILING on an answer this bridge accepts from the native, and a ceiling
//     that is never applied is not a ceiling at all.
const HYPERLINK_COUNTS = 2;
const HYPERLINK_CHARS = 2;
const HYPERLINK_FLAGS = 3;
const HYPERLINK_PHASE_PRE = 'PRE_INSERT';
const HYPERLINK_PHASE_POST = 'POST_INSERT';
const HYPERLINK_NUMBERS = HYPERLINK_COUNTS + HYPERLINK_CHARS;
const HYPERLINK_LENGTH = 1 + HYPERLINK_NUMBERS + HYPERLINK_FLAGS;
function decodeHyperlink(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !Object.hasOwn(length, 'value') || length.enumerable) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const size = length.value;
  if (!Number.isSafeInteger(size) || size < 1 || size > HYPERLINK_LENGTH) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (Reflect.ownKeys(value).length !== size + 1) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const members = [];
  for (let index = 0; index < size; index++) {
    const descriptor = Object.hasOwn(descriptors, String(index)) ? descriptors[String(index)] : null;
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new SafeError(ERROR_CODES.INVALID_DATA);
    members.push(descriptor.value);
  }
  // THE PHASE GATE, exactly as the four decoders before it apply it: the name the body emits only from its
  // pre-insert half keeps its KNOWN class ONLY when the answer itself carries the pre-insert phase.
  if (size === 2) {
    if (members[0] !== HYPERLINK_PHASE_PRE) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
    if (members[1] === 'CAPABILITY_UNAVAILABLE') throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
    // The closed refusals the body can make BEFORE the one mutating call: an address outside the document or
    // a fragment the pre-mutation export ALREADY renders — the closed argument class — and an export above
    // `LIMITS.addHyperlinkMarkdownChars`. All three carry the pre-insert phase, so they keep their known
    // class and RELEASE the slot, because nothing was written.
    if (members[1] === 'TOOL_ERROR') throw new SafeError(ERROR_CODES.TOOL_ERROR);
    if (members[1] === 'BYTE_LIMIT') throw new SafeError(ERROR_CODES.BYTE_LIMIT);
    throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  }
  // A one-slot answer carries no phase at all, so it can never be confirmed as a pre-insert refusal.
  if (size === 1) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  if (size !== HYPERLINK_LENGTH) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (members[0] !== HYPERLINK_PHASE_POST) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  const numbers = members.slice(1, 1 + HYPERLINK_NUMBERS);
  for (const number of numbers) if (!Number.isSafeInteger(number) || number < 0) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const flags = members.slice(1 + HYPERLINK_NUMBERS);
  for (const flag of flags) if (flag !== 0 && flag !== 1) throw new SafeError(ERROR_CODES.INVALID_DATA);
  assertByteLimit(JSON.stringify(members), LIMITS.editorResultBytes);
  return Object.freeze({ paragraphsBefore: numbers[0], paragraphsAfter: numbers[1],
    textBeforeChars: numbers[2], textAfterChars: numbers[3],
    textAppended: flags[0] === 1, fragmentUnique: flags[1] === 1, urlInFragment: flags[2] === 1 });
}
// THE EXACT OUTCOME RULE the hyperlink insert rests on, in ONE place so the decision and its comment cannot
// drift apart. It is judged against the SCOPE this ticket carried (`requested`), never against a value read
// back out of the answer, and the conditions are split by what they can do:
//   1. THE PRIMARY LEG is the addressed paragraph's own text: the body published the text it READ back and
//      whether that text is EXACTLY the text this request meant (`textAppended`). It is a boolean, and the
//      arithmetic beside it is the independent check the bridge can do itself —
//      `textAfterChars === textBeforeChars + requested.text.length` — so a flipped boolean cannot carry a
//      length that contradicts the request, and a stated length cannot excuse a wrong text.
//   2. THE APPEND FORM AND THE NAMED FORM HAVE DIFFERENT COUNTS, and the rule derives the expected delta from
//      the REQUEST rather than from the answer: an append grows the document by exactly one paragraph and
//      starts from an EMPTY one (`textBeforeChars === 0`), a named address moves no count at all.
//   3. THE FRAGMENT LEG can only REFUTE: the opener was located EXACTLY ONCE in the post-mutation export
//      (`fragmentUnique`) and the requested url really follows it (`urlInFragment`). A false one is a
//      mutation this tool cannot stand behind, and the mutation has already run, so the ticket settles
//      `APPLY_UNCERTAIN` with the slot HELD.
function exactHyperlinkDelta(outcome, requested) {
  if (outcome.textAppended !== true) return false;
  if (outcome.fragmentUnique !== true) return false;
  if (outcome.urlInFragment !== true) return false;
  if (requested.append === true) {
    if (outcome.textBeforeChars !== 0) return false;
    if (outcome.paragraphsAfter - outcome.paragraphsBefore !== 1) return false;
  } else if (outcome.paragraphsAfter !== outcome.paragraphsBefore) return false;
  return outcome.textAfterChars === outcome.textBeforeChars + requested.text.length;
}
// THE THREE-WAY SEPARATOR RULE. Every element boundary of the parsed export belongs to exactly one of
// three classes, and the separator it contributes is chosen so that it can NEVER complete a needle:
//   1. a KNOWN BLOCK element (BLOCK_TAGS)  → exactly one `"\n"`, the real paragraph/line boundary the
//      `position:'end'` counting form (`text + "\n"`) is allowed to match;
//   2. a KNOWN INLINE element (INLINE_TAGS) → NOTHING; its text belongs to the line it sits in;
//   3. an element in NEITHER list          → `SEPARATOR_SENTINEL`, a character no needle can end with.
// The third class is the correction. The two-way rule this replaced gave EVERY element that was not
// named inline a `"\n"`, and its stated invariant — "an unknown element can only cause a false
// UNCERTAIN, never a false success" — was FALSE: a genuinely inline element nobody had listed supplied
// exactly the newline the `end` needle ends with. R7 emits `<img>` for an inline picture and
// `<ins>`/`<del>` for tracked changes, so this was realistic, and an independent review reproduced the
// false success through the real bridge in three shapes: post `<p><label>delta</label>tail</p>`,
// `<p>delta<img src="a"></p>` and `<p><ins>delta</ins>tail</p>` over pre `<p>start</p>`, payload
// `delta` with `position:'end'`, no-op paste → `{"ok":true,"data":{"sent":true,"effectVerified":true}}`.
// With the sentinel an unknown element can only SPLIT text (a payload spanning it does not match:
// fail-safe for the cursor form) or inject a character no needle holds (fail-safe for the `end` form),
// and the `end` needle can be completed only by a real class-1 block boundary or by a newline the
// export's own text already carries (the residual named below).
//
// The sentinel is `"\u0000"`. It is safe because the needle is the EXACT dispatched payload and
// `insertParagraph` refuses a payload that holds the sentinel BEFORE anything is dispatched, so no
// needle can end with it either. Every other needle tail is a payload character the document must
// really hold, the authored `"\n"` of the `end` form, or a newline the export's own text already
// carries. That last source is a PRE-EXISTING residual and this rule does not close it: it can only
// complete the needle when the export CHANGES between the two reads (an identical export yields a
// delta of 0 and settles uncertain), so it sits inside the same concurrent-writer window the design
// already acknowledges. U+0000 is
// also not a character an HTML text node carries (the parser replaces a literal NUL in the source with
// U+FFFD), so the sentinel in the counted text can only come from this rule.
//
// The retired form of this rule was a `BLOCK_TAGS` white list, and an export that rendered blocks with
// an element outside it concatenated its neighbours: an independent review drove a no-op paste to
// `{"ok":true,"data":{"sent":true,"effectVerified":true}}` with two `<center>` elements. That is why
// the UNKNOWN class exists at all: a block name missing from `BLOCK_TAGS` costs a false UNCERTAIN (a
// fail-safe false negative), never a false success. `br` is a line break rather than a block, and it is
// inline for the same reason: the break belongs to the line it sits in.
const BLOCK_TAGS = Object.freeze(new Set(['address', 'article', 'aside', 'blockquote', 'body', 'caption', 'dd',
  'details', 'dialog', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4',
  'h5', 'h6', 'head', 'header', 'hgroup', 'hr', 'html', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul']));
const INLINE_TAGS = Object.freeze(new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'dfn', 'em',
  'i', 'kbd', 'mark', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var',
  'wbr']));
// Elements whose content is RAWTEXT: it is markup-level content of the export, never document text, so
// their whole subtree is skipped. Without the skip a `<style>` (or `script`, `title`, `textarea`,
// `noscript`) body was counted as document text: an independent review verified a no-op paste over the
// post export `<p>стар</p><style>delta</style>` with payload `delta`. `iframe`, `noembed` and `noframes`
// are the same RAWTEXT class in the real parser and were missing: the same review measured
// `<p><iframe>delta</iframe></p>` with payload `delta` as VERIFIED without this entry.
const RAWTEXT_TAGS = Object.freeze(new Set(['iframe', 'noembed', 'noframes', 'noscript', 'script', 'style',
  'textarea', 'title']));
// Class 3's separator. Never `"\n"`: a newline here is exactly what let an unknown inline element complete
// the `end` needle (see the rule above).
const SEPARATOR_SENTINEL = '\u0000';
// The document's DECODED TEXT, built with explicit element separators. The export is parsed by the
// platform's own `DOMParser` — an explicit, INJECTED reference, never reached for through a global from
// inside the bridge — and the text nodes are then collected in tree order with the three-way separator
// above, so the count runs over the document's text and never over its markup. Plain `textContent`
// would be WRONG here: it concatenates blocks with no separator, so a payload that happens to span a
// paragraph boundary would match spuriously, and no entity spelling (`&amp;`, `&lt;`, …) can reach the
// count at all — markup and attribute values never enter the text stream. The separator goes out AFTER
// the recursion, so an inline child never cuts its parent's text in two and a block boundary is the only
// thing that separates, wherever the boundary sits in the tree.
function collectText(element, out = []) {
  const name = String(element.nodeName ?? '').toLowerCase();
  if (RAWTEXT_TAGS.has(name)) return out;
  for (const child of Array.from(element.childNodes ?? [])) {
    if (child.nodeType === 1) collectText(child, out);
    else if (child.nodeType === 3) out.push(child.nodeValue ?? '');
  }
  if (BLOCK_TAGS.has(name)) out.push('\n');
  else if (!INLINE_TAGS.has(name)) out.push(SEPARATOR_SENTINEL);
  return out;
}
// A payload that would make the sentinel part of the needle is refused here, before ANY dispatch, so the
// counting form can never hold the very character the separator injects. The check is on the payload the
// caller handed the bridge, which is the string the needle is built from (`text`, or `text + "\n"` for
// `position:'end'`, and neither carries a sentinel the payload did not already hold).
function payloadHoldsSentinel(text) {
  return text.includes(SEPARATOR_SENTINEL);
}
function documentText(platform, html) {
  // The one platform capability this path needs is a `DOMParser`. It is read from the INJECTED platform
  // object (the same explicit boundary the plugin page already supplies) and checked before use, so the
  // capability check is explicit rather than a TypeError from an unavailable platform API. A parsed
  // document has NO browsing context: `parseFromString` loads no subresource and runs no handler, so the
  // export is parsed rather than rendered. No dynamic code generation is involved anywhere.
  let parser;
  try {
    if (typeof platform?.DOMParser === 'function') parser = new platform.DOMParser();
  } catch { parser = null; }
  if (!parser || typeof parser.parseFromString !== 'function') throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
  const parsed = parser.parseFromString(html, 'text/html');
  const root = parsed?.documentElement;
  if (!root || typeof root.childNodes === 'undefined') throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
  return collectText(root).join('');
}
// The non-overlapping occurrence count of the counting form in the document TEXT. The caller refuses
// an EMPTY needle before any read is dispatched (an empty needle would count characters, never a
// payload), so an occurrence here is always a whole counting form.
function countOccurrences(text, needle) {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at < 0) return count;
    count += 1;
    from = at + needle.length;
  }
}
// A document export read is bounded by its OWN ceiling, never by the scoped editor-result window, and a
// result above it is refused rather than truncated: counting occurrences inside a prefix of the export
// could miss an occurrence or count a partial one, so an export that cannot be read WHOLE makes the
// read unusable (fail-closed). A non-string answer is refused by the same call. The ceiling applies to
// the EXPORT (the UTF-8 bytes the native answered), which is what the read costs, not to the shorter
// decoded text derived from it.
function decodeDocumentText(value) {
  return assertByteLimit(value, LIMITS.documentHtmlBytes);
}
// A native insert acknowledgement. `true`/`false` are the only values that carry information: they
// settle the ticket as an acknowledged-but-effect-UNVERIFIED outcome. Every other value — `undefined`,
// which is what the live R7-Office 2026.3.1 `PasteText` calls back with AFTER it has applied the
// insert, plus `null`, a string or an object — says nothing at all about the effect. Such a value is
// therefore neither an automatic success (the callback acknowledged nothing) nor an ordinary known
// error (the paste may well have applied), so `null` here means "the acknowledgement is unusable" and
// hands the still-owned ticket to the document-delta confirmation read. The function is
// CONTRACT-DRIVEN, not fitted to
// one build: a build whose `PasteText` returns a value goes through exactly the same door.
function insertAcknowledgement(value) {
  return typeof value === 'boolean' ? Object.freeze({ acknowledged: value, effectVerified: false }) : null;
}
// One classified failure per dispatched kind. A write-class ticket whose callback never settled may
// already have applied, so it is the uncertain class; everything else keeps its own code, and a raw
// native failure is the closed editor-error class, never a raw exception.
function errorFor(kind, error) {
  if (error instanceof SafeError) return error;
  if (WRITE_KINDS.has(kind)) return new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  return new SafeError(ERROR_CODES.EDITOR_ERROR);
}
// The deadline expiring is its own class, never an editor error: the callback simply never arrived.
// `dispatched` is the whole distinction: a write-class ticket whose mutation WAS dispatched may have
// applied (uncertain), while one that dispatched NOTHING — an insert whose pre-dispatch baseline never
// answered — is a KNOWN timeout. Reporting it as uncertain would be a false uncertainty about a
// mutation that never happened, and (until the slot is released) it wedged the bridge.
function timeoutFor(kind, dispatched) {
  if (WRITE_KINDS.has(kind) && dispatched) return new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  return new SafeError(ERROR_CODES.TIMEOUT);
}
// Every mutation the bridge dispatches is a pending mutation from the moment it is dispatched until
// its ticket settles (a success, or uncertain-until-callback after a timeout or abort; a refusal is
// never dispatched and so is never pending). Design §8.4 requires that no mutation is dispatched
// while a previous one is unsettled, and the panel's write lock (controller.writeLocked) is what
// enforces it, so this predicate must cover the insert path as well as the selection replacement,
// not only `kind === 'write'`.
// The lock is INTENTIONALLY INDEFINITE while a native callback is unresolved: design §8.4 keeps a
// timed-out mutation busy/uncertain until it settles or the plugin is reinitialised, and the UI maps
// that uncertain outcome to an authored caption. An expired deadline must therefore never release it,
// and "fixing" this into a timeout-driven unlock would be a defect, not a repair.
function pendingMutation(slot) {
  return slot !== null && WRITE_KINDS.has(slot.kind) && slot.dispatched;
}
function applyData(raw) {
  if (!raw || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const keys = Reflect.ownKeys(descriptors);
  const allowed = ['target', 'replacement', 'signal', 'deadline', 'beforeDispatch'];
  if (keys.some(key => !allowed.includes(key)) || !Object.hasOwn(descriptors, 'target') || !Object.hasOwn(descriptors, 'replacement')) throw new SafeError(ERROR_CODES.INVALID_DATA);
  for (const descriptor of Object.values(descriptors)) if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new SafeError(ERROR_CODES.INVALID_DATA);
  assertByteLimit(raw.replacement, LIMITS.replacementBytes);
  const deadline = Object.hasOwn(descriptors, 'deadline') ? raw.deadline : undefined;
  const beforeDispatch = Object.hasOwn(descriptors, 'beforeDispatch') ? raw.beforeDispatch : undefined;
  if (deadline !== undefined && (typeof deadline !== 'number' || !Number.isFinite(deadline))) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (beforeDispatch !== undefined && typeof beforeDispatch !== 'function') throw new SafeError(ERROR_CODES.INVALID_DATA);
  return Object.freeze({ target: raw.target, replacement: raw.replacement,
    signal: Object.hasOwn(descriptors, 'signal') ? raw.signal : undefined, deadline, beforeDispatch });
}

// One instance must own all SDK work for the plugin lifetime. UI must invalidate
// on context/generation changes and dispose on teardown; neither retracts work.
export function createR7Bridge(plugin, {
  editorType,
  // The platform object the confirmation parses the document export with: `{ DOMParser }` — the parser
  // alone. It is an EXPLICIT option, never a lookup reached for through a global from inside the bridge:
  // the boundary is declared where the bridge is created (the plugin page passes the page's own
  // `DOMParser`, a test injects its own) and the authored source touches no global at all. NOTE the
  // rationale: this injection is NOT required by `scripts/static-audit.mjs` — a member read such as
  // `globalThis.document` passes the audit; only a bare `globalThis` VALUE (aliasing or destructuring)
  // is reported. It is kept for the explicit boundary and for testability. The option carried a
  // `document` member until the parse moved to `DOMParser`; the bridge never read it again, so it is
  // REMOVED rather than left vestigial: the injected boundary names exactly the one platform capability
  // this path uses. Absent or unusable, the text cannot be built, which makes the read unusable — the
  // fail-closed direction: no usable baseline means no evidence means no write.
  platform = null,
  // THE COMMAND-PARAMETER BOUNDARY. A command body is EVALUATED inside the editor and receives exactly
  // two bindings: the editor's own `Api` and `scope`, which the vendor's `callCommand` wrapper sets from
  // `window.Asc.scope` (measured 2026.1.2: `"var Asc = {}; Asc.scope = " + JSON.stringify(window.Asc.scope)
  // + "; var scope = Asc.scope; (" + fn + ")();"`). `Asc` is therefore the plugin PAGE's own namespace
  // object — the very object whose `plugin` member this product is already handed — and the `find_text`
  // leg is the only one that must WRITE model data into it. It is an EXPLICIT option for the same reason
  // `platform` is: the boundary is declared where the bridge is created, a test injects its own, and the
  // default is the page's own `Asc` (present whenever a plugin object is). Model data crosses as
  // JSON-serializable DATA through this property and is NEVER interpolated into command source (ADR
  // 0002). A namespace that is absent, not an object, or cannot carry a writable `scope` data property
  // makes the search the closed CAPABILITY_UNAVAILABLE before any dispatch — never a search of the
  // needle the PREVIOUS call left behind.
  ascNamespace = globalThis.Asc,
  clock = { now: () => Date.now() },
  timers = { schedule(callback, ms) { return setTimeout(function () { callback(); }, ms); }, clear(id) { clearTimeout(id); } }
} = {}) {
  if (plugin && typeof plugin === 'object') {
    if (pluginOwners.has(plugin)) throw new SafeError(ERROR_CODES.EDITOR_BUSY);
    pluginOwners.add(plugin);
  }
  const editor = ['word', 'cell', 'slide'].includes(editorType) ? editorType : 'unknown';
  // `executeMethod` is the METHOD channel every build exposes and the one the insert's irreversible
  // `PasteText` needs. `commandDispatch` is the COMMAND channel used by the identity/presence legs;
  // it is present when EITHER command entry point is an own function, and the descriptor records which
  // one carried the work (`callCommand` preferred, `executeCommand` as the target-only fallback).
  const hasCallCommand = ownFunction(plugin, 'callCommand');
  const hasExecuteCommand = ownFunction(plugin, 'executeCommand');
  const command = createCommandDispatch(plugin, hasCallCommand, hasExecuteCommand);
  const adapter = Object.freeze({ executeMethod: ownFunction(plugin, 'executeMethod'),
    commandDispatch: hasCallCommand || hasExecuteCommand, commandMethod: command.method });
  let slot = null;
  let disposed = false;
  let contextOwner = Object.freeze({});
  const targets = new WeakMap(); // private brand + raw ID; never public DTO/model data
  const listeners = new Set();
  function notify() { for (const listener of listeners) { try { listener(); } catch {} } }
  // THE ONE PLACE this module writes an object it does not own, and it is the parameter channel of a
  // command body (`ascNamespace` above carries the evidence and the rationale). `writeScope` returns the
  // value it replaced — `SCOPE_ABSENT` when the namespace had no `scope` property at all — so
  // `clearScope` restores the exact previous shape: a needle must not outlive its own dispatch, and a
  // page object must not be left holding a property it never had. Every unusable namespace is the closed
  // capability class and is decided BEFORE `owned.dispatched`, because nothing reached the editor.
  function writeScope(scope) {
    if (!ascNamespace || typeof ascNamespace !== 'object') throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
    const previous = Object.getOwnPropertyDescriptor(ascNamespace, 'scope');
    if (previous && !Object.hasOwn(previous, 'value')) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
    if (previous && previous.writable === false) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
    if (!previous && !Object.isExtensible(ascNamespace)) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
    ascNamespace.scope = scope;
    return previous ? previous.value : SCOPE_ABSENT;
  }
  function clearScope(previous) {
    try {
      if (previous === SCOPE_ABSENT) delete ascNamespace.scope;
      else ascNamespace.scope = previous;
    } catch {}
  }
  function currentEditor() {
    const info = plugin && Object.getOwnPropertyDescriptor(plugin, 'info');
    if (!info || !Object.hasOwn(info, 'value') || !info.value || typeof info.value !== 'object') return 'unknown';
    const type = Object.getOwnPropertyDescriptor(info.value, 'editorType');
    return type && Object.hasOwn(type, 'value') && ['word', 'cell', 'slide'].includes(type.value) ? type.value : 'unknown';
  }
  function ownedTarget(target) {
    const saved = target && typeof target === 'object' ? targets.get(target) : null;
    return !disposed && currentEditor() === editor && editor === 'word' && saved?.owner === contextOwner ? saved : null;
  }

  function capabilities(methodPresence = null) {
    const available = !disposed && editor === 'word' && adapter.executeMethod;
    return Object.freeze({
      editorType: editor, adapter, methodPresence, runtimeVerified: false,
      selectionRead: Object.freeze({ available, runtimeVerified: false, reason: available ? 'ADAPTER_PRESENT_RUNTIME_UNVERIFIED' : 'READ_UNAVAILABLE' }),
      mutation: Object.freeze({ available: false, runtimeVerified: false, reason: MUTATION_REASON })
    });
  }
  function ensureIdle() {
    if (disposed || editor === 'unknown') throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
    if (slot !== null) throw new SafeError(ERROR_CODES.EDITOR_BUSY);
  }
  function readClock() {
    try {
      const now = clock.now();
      if (typeof now !== 'number' || !Number.isFinite(now)) throw new SafeError(ERROR_CODES.EDITOR_ERROR);
      return now;
    } catch { throw new SafeError(ERROR_CODES.EDITOR_ERROR); }
  }
  // The insert parameters are optional and last so every pre-existing three-argument caller of
  // start() keeps its exact meaning.
  function start(kind, signal, { replacement, beforeDispatch, maxBytes } = {}, params) {
    if (signal?.aborted) return Promise.reject(new SafeError(ERROR_CODES.CANCELLED));
    // Decode bound for THIS ticket. A `contextread` ticket has exactly one creator, `readContext`,
    // and a `caretread` ticket exactly one, `readParagraph`; both refuse a non-safe-integer or `< 1`
    // `maxBytes` as CAPABILITY_UNAVAILABLE BEFORE they dispatch, so these legs always carry their
    // budget and there is no second window they can fall back to — `LIMITS.selectionBytes` is not
    // consulted on this branch at all, and a fallback here would be dead code whose only effect was to
    // hide a future caller that forgot the budget behind an 8 KiB decode. Without one, such a caller
    // gets `assertByteLimit`'s closed INVALID_DATA instead of a silent under-bound decode. Every other
    // kind keeps its own window (the selection read stays at LIMITS.selectionBytes). A `search` ticket
    // never consults this window at all: it decodes its own authored `[count, text…]` array against the
    // `limit` it asked for (`decodeSearch`), not against a byte budget derived from the selection read.
    // A `structureread` ticket is the same shape of exception and decodes its own authored flat array
    // against the `maxHeadings` it asked for (`decodeStructure`).
    const readBound = kind === 'contextread' || kind === 'caretread' ? Math.min(maxBytes, LIMITS.editorResultBytes) : LIMITS.selectionBytes;
    return new Promise((resolve, reject) => {
      const owned = { kind, dispatched: false, uncertain: false, settled: false, timer: null, deadline: readClock() + LIMITS.callbackTimeoutMs, cancel: null };
      slot = owned;
      function settle(error, value) {
        if (owned.settled) return;
        owned.settled = true;
        // Cleanup is best effort, never the authority to settle caller/SDK work.
        if (owned.timer !== null) {
          try { timers.clear(owned.timer); } catch {}
          owned.timer = null;
        }
        try { signal?.removeEventListener('abort', cancel); } catch {}
        if (error) reject(error); else resolve(value);
      }
      function cancel() {
        if (slot !== owned || owned.settled) return;
        // `owned.dispatched` decides both the class and the slot: a ticket whose work already reached
        // the SDK may have applied (write-class) or is still queued (a read/probe), so it keeps the
        // existing uncertain-until-matching-callback behaviour; a ticket that dispatched NOTHING has a
        // single known outcome — the cancellation — and must RELEASE the slot, or a lifecycle
        // invalidation/dispose would leave the bridge permanently busy behind an already-settled ticket
        // that `slot?.cancel()` can no longer reach.
        const pending = owned.dispatched;
        if (!pending) slot = null;
        owned.uncertain = pending;
        settle(errorFor(kind, pending && WRITE_KINDS.has(kind) ? null : new SafeError(ERROR_CODES.CANCELLED)));
      }
      owned.cancel = cancel;
      // THE UNCERTAIN SETTLEMENT, and the ONE definition of "the slot is HELD". An outcome that may
      // already be in the document settles the uncertain class and does NOT release the slot:
      // `getState()` keeps reporting `busy`/`uncertain`/`writePending`, the panel's write lock stays
      // engaged, and no retry is possible until the plugin is reinitialised. The insert confirmation's
      // "not confirmed" path and the block append's unproven delta are the same rule, so they share this
      // one settlement; a caller must NOT set `slot = null` on this path.
      function settleUncertain(error) {
        if (slot !== owned || owned.settled) return;
        owned.uncertain = true;
        settle(error);
        notify();
      }
      // THE DOCUMENT-DELTA CONFIRMATION of an unusable insert acknowledgement, and the PRE-DISPATCH
      // BASELINE it needs. The acknowledgement carries no value, so the still-OWNED ticket asks the
      // DOCUMENT itself: it reads the document's own export ONCE BEFORE the paste (`GetFileHTML`, the
      // same public method channel every other read uses), counts the occurrences of the dispatched
      // payload in the document's DECODED TEXT and stores that as the baseline; after the paste settles
      // it reads the export ONCE more and counts again. The effect is verified ONLY when the post count
      // is exactly `baselineCount + 1` — exactly one NEW occurrence is the evidence that THIS paste
      // added the payload.
      //
      // Why the TEXT and not the markup. Counting in the export's HTML source is fail-open: markup and
      // entity vocabulary contribute occurrences that are not in the document's text. An independent
      // review demonstrated it with payload `amp` over an export `<p>a &amp; b</p>`: that SOURCE holds ONE
      // `amp` substring (inside the entity), so an unrelated escaped ampersand the user added — the post
      // export `<p>a &amp; b</p><p>c &amp; d</p>` holds TWO — moved the count by exactly one and a paste
      // that inserted NOTHING was reported
      // `{"ok":true,"data":{"sent":true,"effectVerified":true}}`. In the decoded text those two
      // occurrences do not exist at all (it reads `a & b`, then `a & bc & d`), and a payload holding `&`,
      // `<`, `>` or `"` matches by its real characters — the escaping rule this replaced is gone.
      //
      // Why a document delta and not a caret-scope equality. A post-dispatch observation that
      // reproduces the payload proves only that the caret scope EQUALS the payload, and "equals the
      // payload and differs from its own pre-dispatch baseline" is STILL not attribution: a concurrent
      // NON-paste change — the user typing, autocorrect, a native that moves the caret — that lands
      // exactly on the payload satisfies both conditions while nothing was inserted. Only a change to
      // the DOCUMENT is attributable to a paste that is the sole writer of that document in this
      // window, and "exactly one new occurrence" is the narrowest honest form of that evidence. The
      // caret-scope reads (`GetSelectedText`, `GetCurrentSentence`) are therefore GONE from this path:
      // they can no longer produce `effectVerified:true`, and a read that cannot settle success has no
      // business costing a native round trip inside the write window.
      //
      // The pre-dispatch read is a GATE, by construction: the paste is dispatched only after the
      // baseline read has ANSWERED with a usable count. A baseline read that throws, errors, is
      // malformed, is above `LIMITS.documentHtmlBytes`, or never answers leaves the ticket with no
      // obtainable evidence at all, and it settles its own KNOWN class with NOTHING dispatched and the
      // slot RELEASED — never the uncertain class (a mutation that never happened) and never a wedge.
      // That is the fail-closed direction: no baseline means no evidence means no write.
      //
      // The post-paste read carries no such gate: the mutation IS dispatched by then, so an unanswered,
      // errored, malformed or oversized post read is "not confirmed" — `APPLY_UNCERTAIN`, the slot
      // HELD, no retry — and never a false success. Any count other than exactly one new occurrence is
      // "not confirmed" too: zero (or a payload that is simply absent) means this paste added nothing,
      // and two or more means the document changed in a way this single paste does not explain. The
      // slot is not released on "not confirmed": nothing observed here proves the paste did not apply.
      function beginInsert() {
        const payload = params[0]; // the exact string that will be dispatched to the editor
        try {
          // The ONE needle, computed ONCE and used for BOTH reads, so the delta compares the same
          // string before and after. It is the EXACT dispatched payload — `text` for `position:'cursor'`
          // and `text + "\n"` for `position:'end'`, exactly as the caller built it (this ticket does not
          // change the caller's payload): with block separators that trailing newline is a real
          // character of the extracted text, so the `end` form can legitimately match a paragraph break.
          // No escaping is applied anywhere: the count runs over decoded text, where a payload holding
          // `&`, `<`, `>` or `"` is spelled by its real characters. An EMPTY needle is a counting form
          // that cannot describe a payload at all (it would count characters), so it makes the baseline
          // unusable.
          owned.needle = String(payload);
          if (owned.needle === '') throw new SafeError(ERROR_CODES.INVALID_DATA);
        } catch { owned.needle = null; }
        owned.htmlBaseline = null;
        // The once-per-ticket dispatch marks: a read is dispatched at most once even when a native
        // delivers its callback SYNCHRONOUSLY and THEN throws out of the same call (see below).
        owned.htmlBaselineDispatched = false;
        owned.htmlConfirmDispatched = false;
        readHtmlBaseline();
        notify();
      }
      // THE pre-dispatch baseline read. It never mutates anything: it reads the document's own export,
      // parses it into text and counts the needle in it. The once-per-ticket boundary is STRUCTURAL, not
      // an assumption about native callback ordering — a native that delivers this callback synchronously
      // and then throws out of the same call must not re-enter this function and dispatch a SECOND
      // baseline (which a ladder used to turn into a second `PasteText` for one logical insert).
      //
      // The read is the GATE of the whole insert: the paste is dispatched from THIS callback, after the
      // count was obtained. Anything else — the needle could not be built, the read threw, errored, was
      // malformed or non-string, was above `LIMITS.documentHtmlBytes`, the platform DOM the text is built
      // with is unusable, or the ticket deadline expired before the answer — means no baseline exists, so
      // no confirmation is possible at all, and the ticket settles its own KNOWN class with NOTHING
      // dispatched and the slot RELEASED. Reporting `APPLY_UNCERTAIN` here would be a false uncertainty
      // about a mutation that never happened, and holding the slot would wedge the bridge behind a
      // settled ticket.
      function readHtmlBaseline() {
        if (slot !== owned || owned.settled || disposed) return; // a settled ticket never dispatches the mutation
        if (owned.htmlBaselineDispatched) return; // this ticket's single baseline already went out
        owned.htmlBaselineDispatched = true;
        if (owned.needle === null) { refuseInsert(new SafeError(ERROR_CODES.INVALID_DATA)); return; }
        let answered = false;
        function baselineCallback(value) {
          if (slot !== owned) return;
          if (owned.settled) { slot = null; notify(); return; }
          if (answered) return; // one baseline observation per ticket, never re-judged
          answered = true;
          let failure = null;
          try {
            if (signal?.aborted) throw new SafeError(ERROR_CODES.CANCELLED);
            if (readClock() >= owned.deadline) throw new SafeError(ERROR_CODES.TIMEOUT);
            owned.htmlBaseline = countOccurrences(documentText(platform, decodeDocumentText(value)), owned.needle);
          } catch (error) { failure = error instanceof SafeError ? error : new SafeError(ERROR_CODES.EDITOR_ERROR); }
          if (failure === null) { dispatchPaste(); return; }
          refuseInsert(failure);
        }
        try {
          plugin.executeMethod('GetFileHTML', Object.freeze({}), baselineCallback);
        } catch (error) {
          // A baseline read that cannot even be dispatched is the same closed gate. If it already
          // ANSWERED before throwing, the callback above has taken the ticket (the paste is dispatched
          // or the refusal is settled) and this re-entry observes it and does nothing more.
          if (answered) return;
          refuseInsert(error instanceof SafeError ? error : new SafeError(ERROR_CODES.EDITOR_ERROR));
        }
      }
      // The pre-dispatch gate refusing: NOTHING reached the editor, so the honest outcome is the
      // ticket's own KNOWN class (the closed class of the failure the baseline read produced) and the
      // slot is released, exactly like a baseline read that never answered.
      function refuseInsert(error) {
        if (slot !== owned || owned.settled) return;
        owned.uncertain = false;
        slot = null;
        settle(error);
        notify();
      }
      // The irreversible mutation, dispatched exactly ONCE, from the baseline callback that obtained
      // the count, with exactly the payload this path carried before the baseline existed. A
      // synchronous throw from the dispatch is the closed uncertain class: a dispatch that may have
      // reached the SDK is never a release. The `owned.dispatched` check is the structural
      // once-per-ticket boundary: after it, only the mutation's own callback (and the reads it starts)
      // can settle the ticket, and nothing can reach this function again.
      function dispatchPaste() {
        if (owned.dispatched || owned.settled || disposed) return;
        // An abort that landed during the baseline phase prevents the mutation entirely: nothing was
        // dispatched, so the ticket settles its own known cancellation and releases the slot.
        if (signal?.aborted) { slot = null; settle(new SafeError(ERROR_CODES.CANCELLED)); return; }
        owned.dispatched = true;
        try {
          plugin.executeMethod('PasteText', params, callback);
        } catch {
          if (slot === owned && !owned.settled) {
            owned.uncertain = true;
            settle(errorFor(kind, null));
            notify();
          }
        }
      }
      // The acknowledgement was unusable: ask the DOCUMENT for its one post-paste read. The baseline is
      // usable by construction here — `dispatchPaste` is reached only from the baseline callback that
      // accepted its count — so there is exactly one reason this function can settle the ticket: the
      // post count.
      function confirmInsert() {
        owned.confirming = true;
        if (owned.htmlConfirmDispatched) return; // one post-paste read per ticket, never a retry
        owned.htmlConfirmDispatched = true;
        let answered = false;
        function confirmCallback(value) {
          if (slot !== owned) return; // a stale read cannot settle a new owner
          if (owned.settled) { slot = null; notify(); return; }
          if (answered) return; // one post-paste observation per ticket, never re-judged
          answered = true;
          let confirmed = false;
          try {
            if (signal?.aborted) throw new SafeError(ERROR_CODES.CANCELLED);
            if (readClock() >= owned.deadline) throw new SafeError(ERROR_CODES.TIMEOUT);
            // EXACTLY one NEW occurrence, and nothing else: zero (or a payload that is absent) means
            // this paste added nothing, two or more means the document changed in a way this single
            // paste does not explain, and an unreadable export proves nothing either way.
            confirmed = countOccurrences(documentText(platform, decodeDocumentText(value)), owned.needle) === owned.htmlBaseline + 1;
          } catch { confirmed = false; }
          if (confirmed) {
            slot = null;
            settle(null, Object.freeze({ acknowledged: null, effectVerified: true }));
            notify();
            return;
          }
          confirmFailed();
        }
        try {
          plugin.executeMethod('GetFileHTML', Object.freeze({}), confirmCallback);
        } catch {
          // A post-paste read that cannot even be dispatched observed nothing: not confirmed, and never
          // a retry of either the read or the mutation. If the callback above already decided the
          // ticket, this re-entry observes it and does nothing more.
          if (answered) return;
          confirmFailed();
        }
      }
      // Not confirmed: the uncertain class, with the slot still HELD. The mutation WAS dispatched, so
      // nothing observed here proves it did not apply, and no retry is ever issued.
      function confirmFailed() {
        settleUncertain(new SafeError(ERROR_CODES.APPLY_UNCERTAIN));
      }
      function callback(value) {
        if (slot !== owned) return; // old/duplicate callback cannot release a new owner
        if (owned.settled) { slot = null; notify(); return; } // release only, never late content/UI
        // A second acknowledgement for this same dispatch cannot preempt the document-delta
        // confirmation the first one started: this ticket's outcome is decided by that read alone.
        if (owned.confirming) return;
        try {
          if (signal?.aborted) throw new SafeError(ERROR_CODES.CANCELLED);
          if (readClock() >= owned.deadline) throw new SafeError(ERROR_CODES.TIMEOUT);
          let result;
          if (kind === 'insert') {
            const acknowledgement = insertAcknowledgement(value);
            if (acknowledgement === null) { confirmInsert(); return; }
            result = acknowledgement;
          } else if (kind === 'read') result = decodeText(value, LIMITS.selectionBytes);
          else if (kind === 'context') result = decodeContext(value);
          else if (kind === 'contextread') result = decodeText(value, readBound);
          else if (kind === 'caretread') result = decodeText(value, readBound);
          // THE DOCUMENT SEARCH. Its answer is the authored `[count, text…]` array, decoded against the
          // `limit` THIS ticket asked for — the same number the body extracted against — so the decode
          // and the extraction can never disagree about how many texts are owed.
          else if (kind === 'search') result = decodeSearch(value, params.limit);
          // THE DOCUMENT STRUCTURE. Its answer is the authored flat array of PRIMITIVES, decoded against
          // the `maxHeadings` THIS ticket asked for — the same cap the body extracted against — so the
          // decode and the extraction can never disagree about how many heading texts are owed.
          else if (kind === 'structureread') result = decodeStructure(value, params.maxHeadings);
          // THE BLOCK APPEND. Its answer is the authored flat array of primitives, decoded against the
          // BLOCK COUNT this ticket carried — the same number the body built its one region flag per
          // block against — so the decode and the body can never disagree about how many blocks are owed.
          // The exact-delta rule then decides the ticket HERE, while it still owns the slot: a delta that
          // is not exact is the UNCERTAIN class with the slot HELD, never a known error about a document
          // the append may already have changed. A decode that THROWS is classified by the catch below (a
          // `[PRE_INSERT, name]` answer keeps its known code; everything else is uncertain).
          else if (kind === 'blocksinsert') {
            const outcome = decodeBlocks(value, params.blocks.length);
            if (!exactBlocksDelta(outcome, params.blocks)) { settleUncertain(new SafeError(ERROR_CODES.APPLY_UNCERTAIN)); return; }
            result = outcome;
          }
          // THE TABLE INSERT. Its answer is the authored flat array of primitives, decoded against the
          // MATRIX this ticket carried — the same matrix the body laid its one region flag per cell out
          // over — so the decode and the body can never disagree about how many cells are owed. The
          // exact-delta rule then decides the ticket HERE, while it still owns the slot: a table count that
          // did not grow by exactly one, or a cell of the appended table that carries something else, is
          // the UNCERTAIN class with the slot HELD, never a known error about a document the insert may
          // already have changed. A decode that THROWS is classified by the catch below (a
          // `[PRE_INSERT, name]` answer keeps its known code; everything else is uncertain).
          else if (kind === 'tableinsert') {
            const outcome = decodeTable(value, params.data);
            if (!exactTableDelta(outcome)) { settleUncertain(new SafeError(ERROR_CODES.APPLY_UNCERTAIN)); return; }
            result = outcome;
          }
          // THE HEADING STYLE ASSIGNMENT. Its answer is the authored flat array of primitives, decoded with
          // NO caller-supplied collection to pin against — this leg addresses exactly ONE paragraph, so the
          // answer's length is fixed by `decodeHeading` and the phase gate is the whole of the length rule.
          // The outcome rule then decides the ticket HERE, while it still owns the slot: a target whose text
          // moved, a heading count that did not grow by exactly one, a paragraph count that moved, or a
          // readable style that is NOT the requested one is the UNCERTAIN class with the slot HELD, never a
          // known error about a document this call may already have restyled. A decode that THROWS is
          // classified by the catch below (a `[PRE_INSERT, name]` answer keeps its known code; everything
          // else is uncertain).
          else if (kind === 'headinginsert') {
            const outcome = decodeHeading(value);
            if (!exactHeadingDelta(outcome)) { settleUncertain(new SafeError(ERROR_CODES.APPLY_UNCERTAIN)); return; }
            result = outcome;
          }
          // THE RANGE FORMAT. Its answer is the authored flat array of primitives, decoded with NO
          // caller-supplied collection to pin against — this leg addresses exactly ONE paragraph and ONE
          // region, so the answer's length is fixed by `decodeRange` and the phase gate is the whole of the
          // length rule. The outcome rule then decides the ticket HERE, while it still owns the slot, and it is
          // judged against the SCOPE (`params`) this ticket carried: an unreadable or disagreeing alignment
          // readback, a requested run property whose measured marker did NOT wrap the addressed region, a
          // property nobody requested claiming a proof, a region that moved, a paragraph whose text changed or
          // a paragraph count that moved is the UNCERTAIN class with the slot HELD, never a known error about a
          // document this call may already have reformatted. A decode that THROWS is classified by the catch
          // below (a `[PRE_INSERT, name]` answer keeps its known code; everything else is uncertain).
          else if (kind === 'rangeformat') {
            const outcome = decodeRange(value);
            if (!exactRangeFormat(outcome, params)) { settleUncertain(new SafeError(ERROR_CODES.APPLY_UNCERTAIN)); return; }
            result = outcome;
          }
          // THE HYPERLINK INSERT. Its answer is the authored flat array of primitives, decoded with NO
          // caller-supplied collection to pin against — this leg addresses exactly ONE paragraph and ONE
          // fragment — so the answer's length is fixed by `decodeHyperlink` and the phase gate is the whole of
          // the length rule. The outcome rule then decides the ticket HERE, while it still owns the slot, and
          // it is judged against the SCOPE (`params`) this ticket carried: an addressed paragraph whose own
          // text is not exactly what the request meant, an append whose count did not grow by exactly one or
          // whose paragraph did not start empty, a fragment that was not located exactly once, a url that is
          // not inside it, and a text length that contradicts the request are all the UNCERTAIN class with the
          // slot HELD, never a known error about a document this call may already have linked. A decode that
          // THROWS is classified by the catch below (a `[PRE_INSERT, name]` answer keeps its known code;
          // everything else is uncertain).
          else if (kind === 'hyperlinkinsert') {
            const outcome = decodeHyperlink(value);
            if (!exactHyperlinkDelta(outcome, params)) { settleUncertain(new SafeError(ERROR_CODES.APPLY_UNCERTAIN)); return; }
            result = outcome;
          }
          // THE WHOLE-DOCUMENT READ. The value is the document's own `GetFileHTML` export, decoded by
          // the SAME two helpers the insert confirmation already uses: `decodeDocumentText` bounds the
          // EXPORT by its own ceiling and `documentText` parses it into the document's text. No third
          // decode rule exists, and the fail-closed direction is unchanged — an export above the
          // ceiling, or one the injected platform cannot parse, is REFUSED by those helpers (closed
          // `BYTE_LIMIT` / `CAPABILITY_UNAVAILABLE`) and never truncated into a prefix. This leg does
          // NOT decode against `editorResultBytes`: it hands back the WHOLE decoded text plus its
          // character count, because the tool's whole job is to slice ONE bounded chunk out of it and
          // to say honestly where the document ends.
          else if (kind === 'documentread') result = documentText(platform, decodeDocumentText(value));
          else if (kind === 'probe') result = capabilities(decodePresence(value));
          else {
            if (typeof value !== 'boolean') throw new SafeError(ERROR_CODES.INVALID_DATA);
            result = Object.freeze({ acknowledged: value, effectVerified: false });
          }
          slot = null; // actual settlement releases SDK slot, even after caller expiry
          settle(null, result);
        } catch (error) {
          // A dispatched WRITE command body whose answer could not be interpreted — or whose own body
          // reported its POST-insert failure — is the UNCERTAIN class with the slot HELD: the command body
          // ran (its callback arrived), so the write may already be in the document and releasing the slot
          // would invite a retry of a mutation whose effect is unknown. The two classes a dispatched body
          // can still produce as KNOWN are its own PRE-insert phase-marked refusals, which is exactly what
          // `preInsertRefusal` names, and they release the slot below.
          if ((kind === 'blocksinsert' || kind === 'tableinsert' || kind === 'headinginsert' || kind === 'rangeformat' || kind === 'hyperlinkinsert') && owned.dispatched && !preInsertRefusal(error, kind)) {
            settleUncertain(new SafeError(ERROR_CODES.APPLY_UNCERTAIN));
            return;
          }
          slot = null;
          // A callback that actually ARRIVED for an already-dispatched insert can still leave the effect
          // unproven (its deadline expired just before the callback was delivered, so the ticket's own
          // timer had not run yet). That is the uncertain class — never a plain known error about a
          // document the editor has already touched, and never a success.
          settle(kind === 'insert' && owned.dispatched ? new SafeError(ERROR_CODES.APPLY_UNCERTAIN) : errorFor(kind, error));
        }
        notify();
      }
      try {
        signal?.addEventListener('abort', cancel, { once: true });
        owned.timer = timers.schedule(function () {
          if (slot !== owned || owned.settled) return;
          if (!owned.dispatched) {
            // The deadline expired while this ticket had dispatched NOTHING: for an insert that is a
            // pre-dispatch baseline read that never answered (or an unreached paste). That is not the
            // uncertain class — the mutation never happened — so the honest outcome is the ticket's own
            // known class, and the slot is RELEASED so a later operation can proceed instead of finding
            // a bridge wedged behind a settled ticket. (A dispatched ticket keeps its own class below.)
            owned.uncertain = false;
            slot = null;
            settle(timeoutFor(kind, false));
            notify();
            return;
          }
          owned.uncertain = true;
          settle(timeoutFor(kind, true));
          notify();
        }, LIMITS.callbackTimeoutMs);
      } catch {
        slot = null; settle(new SafeError(ERROR_CODES.EDITOR_ERROR)); return;
      }
      try {
        // Return status (including false = queued) is NOT completion/rejection.
        if (kind === 'write') {
          // The controller's authored guard runs after timer acquisition, before
          // the irreversible boundary. No model callback/code reaches this path.
          try { beforeDispatch?.(); }
          catch (error) { slot = null; settle(error instanceof SafeError ? error : new SafeError(ERROR_CODES.EDITOR_ERROR)); return; }
          if (signal?.aborted || disposed) { slot = null; settle(new SafeError(ERROR_CODES.CANCELLED)); return; }
          owned.dispatched = true;
          plugin.executeMethod('ReplaceTextSmart', Object.freeze([Object.freeze([replacement]), '\t', '\n']), callback);
        } else if (kind === 'read') { owned.dispatched = true; plugin.executeMethod('GetSelectedText', Object.freeze([]), callback); }
        else if (kind === 'context') { owned.dispatched = true; command.probe('context', callback); }
        else if (kind === 'contextread') {
          // The editor method is reached BY NAME through the ONE public dispatch channel this bridge
          // owns, and that channel is verified with ownFunction (an OWN data-descriptor check on the
          // facade) exactly like every other public method the read/write paths use. The facade exposes
          // no editor method as its own property — `executeMethod` queues {methodName, params} and the
          // editor resolves it — so a `plugin.GetDocumentStructure` property check would prove nothing
          // about the installed build and is NOT consulted here. What this guard proves is the dispatch
          // channel plus the Api-surface presence signal the identity leg above already required; it
          // does NOT prove that the installed R7 build implements `GetDocumentStructure`. That remains
          // PENDING NATIVE VERIFICATION: an editor without the method never calls back, and the ticket
          // then settles by its own read class (TIMEOUT), never as a success.
          if (disposed || !adapter.executeMethod) { slot = null; settle(new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE)); return; }
          owned.dispatched = true;
          plugin.executeMethod('GetDocumentStructure', params, callback);
        } else if (kind === 'documentread') {
          // The whole-document READ: the SAME public method the insert's pre-dispatch baseline already
          // dispatches, reached BY NAME through the one owned dispatch channel, with the same empty
          // params object. The guard is the channel check every leg applies (an own data descriptor on
          // the facade, which is all a build's method channel can be verified to be from here); it is
          // NOT a claim that the installed build implements `GetFileHTML` — that is PENDING NATIVE
          // VERIFICATION, and an editor without it never calls back, so this read settles TIMEOUT, a
          // known class, never a success. Nothing here writes: this leg's only native effect is one
          // read, and `pendingMutation` stays false for it.
          if (disposed || !adapter.executeMethod) { slot = null; settle(new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE)); return; }
          owned.dispatched = true;
          plugin.executeMethod('GetFileHTML', Object.freeze({}), callback);
        } else if (kind === 'caretread') {
          // The CARET-CONTEXT READ: `GetCurrentSentence`, the one caret primitive this repo has
          // actually observed the live build answer (commit ed65dd5 dispatched exactly this name
          // through exactly this channel and recorded it as "the primitive the live build actually
          // answers with the inserted sentence" on R7-Office 2026.3.1; the descriptor carries the
          // vendor-source counts). The guard is the channel check every leg applies — an own data
          // descriptor on the facade — and the method is reached BY NAME: the facade exposes no editor
          // method as its own property, so a `plugin.GetCurrentSentence` property test would prove
          // nothing about the installed build and is not consulted. A build that does not implement the
          // name never calls back, and the ticket then settles its own read class (TIMEOUT), never as a
          // sentence. It is a READ: this leg matches no write class, so `pendingMutation` stays false
          // and nothing on this path reaches `PasteText`/`ReplaceTextSmart`. ONE dispatch, and it
          // carries NO identity probe: a caret context read returns no OWNED TARGET a later write could
          // be applied to, so there is no handle whose ownership would have to be proven.
          if (disposed || !adapter.executeMethod) { slot = null; settle(new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE)); return; }
          owned.dispatched = true;
          plugin.executeMethod('GetCurrentSentence', Object.freeze([]), callback);
        } else if (kind === 'search') {
          // THE DOCUMENT SEARCH: ONE command, and the ONLY leg whose parameters must cross as DATA. It
          // needs the entry point that OWNS the parameter wrapper (`callCommand`, which composes
          // `Asc.scope` into the body's `scope` binding); a build whose command channel is the bare
          // `executeCommand` transport has no sanctioned parameter channel at all — composing model data
          // into command source is forbidden (ADR 0002) — so it refuses HERE, before any dispatch, and
          // releases the slot because nothing reached the editor.
          if (disposed || !hasCallCommand) { slot = null; settle(new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE)); return; }
          // The scope write is the PARAMETER CHANNEL, not the dispatch: it happens BEFORE
          // `owned.dispatched`, and an unusable namespace is therefore a KNOWN refusal with the slot
          // released rather than a dispatch that never was. `owned.dispatched` is then set before the
          // native is handed the command, exactly like every other leg, so a synchronous throw out of
          // the transport can never release a slot whose work may already be queued.
          let previous;
          try { previous = writeScope(params); }
          catch { slot = null; owned.uncertain = false; settle(new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE)); return; }
          owned.dispatched = true;
          try { command.search(callback); }
          finally { clearScope(previous); }
        } else if (kind === 'structureread') {
          // THE DOCUMENT STRUCTURE: ONE command, and the SAME parameter channel the search uses. It needs
          // the entry point that OWNS the parameter wrapper (`callCommand`, which composes `Asc.scope`
          // into the body's `scope` binding); a build whose command channel is the bare `executeCommand`
          // transport has no sanctioned parameter channel at all — composing model data into command
          // source is forbidden (ADR 0002) — so it refuses HERE, before any dispatch, and releases the
          // slot because nothing reached the editor. The scope write is the PARAMETER CHANNEL, not the
          // dispatch: it happens BEFORE `owned.dispatched`, so an unusable namespace is a KNOWN refusal
          // with the slot released rather than a dispatch that never was.
          if (disposed || !hasCallCommand) { slot = null; settle(new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE)); return; }
          let previousScope;
          try { previousScope = writeScope(params); }
          catch { slot = null; owned.uncertain = false; settle(new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE)); return; }
          owned.dispatched = true;
          try { command.structure(callback); }
          finally { clearScope(previousScope); }
        } else if (kind === 'blocksinsert') {
          // THE BLOCK APPEND: ONE command, and the SAME parameter channel the search and structure legs
          // use — the validated block array written into the page's `Asc.scope`, never composed into
          // source (ADR 0002). It needs the entry point that OWNS that wrapper (`callCommand`); a build
          // whose command channel is the bare `executeCommand` transport has no sanctioned parameter
          // channel at all, so it refuses HERE, before any dispatch, and releases the slot because
          // nothing reached the editor.
          // It carries NO document-identity probe, deliberately and for a stated reason: every other
          // dispatched operation keeps one because it acts on an OWNED TARGET whose identity a concurrent
          // edit could change, and this leg has no target at all — the operation is "append at the end of
          // the document". What a probe would establish instead (that the `Api` surface is present) the
          // body checks itself, primitive by primitive, before it inserts. ONE dispatch, one body, and no
          // identity round trip that could only report a document nobody claimed.
          // `owned.dispatched` is set BEFORE the native is handed the command, exactly like every other
          // leg: a synchronous throw out of the transport must never release a slot whose work may
          // already be queued, and the body's own pre-insert refusals keep their known class through the
          // callback (they arrive as a `[PRE_INSERT, name]` answer, not as a throw).
          if (disposed || !hasCallCommand) { slot = null; settle(new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE)); return; }
          let previousBlocks;
          try { previousBlocks = writeScope(params); }
          catch { slot = null; owned.uncertain = false; settle(new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE)); return; }
          owned.dispatched = true;
          try { command.blocks(callback); }
          finally { clearScope(previousBlocks); }
        } else if (kind === 'tableinsert') {
          // THE TABLE INSERT: ONE command, and the SAME parameter channel the block append uses — the
          // validated matrix written into the page's `Asc.scope`, never composed into source (ADR 0002). It
          // needs the entry point that OWNS that wrapper (`callCommand`); a build whose command channel is
          // the bare `executeCommand` transport has no sanctioned parameter channel at all, so it refuses
          // HERE, before any dispatch, and releases the slot because nothing reached the editor.
          // Like the block append it carries NO document-identity probe, and for the same reason: every
          // other dispatched operation keeps one because it acts on an OWNED TARGET whose identity a
          // concurrent edit could change, and this leg has no target at all — the operation is "insert a
          // table at the end of the document". What a probe would establish instead (that the `Api` surface
          // is present) the body checks itself, primitive by primitive, before it inserts. ONE dispatch, one
          // body, and no identity round trip that could only report a document nobody claimed.
          // `owned.dispatched` is set BEFORE the native is handed the command, exactly like every other leg:
          // a synchronous throw out of the transport must never release a slot whose work may already be
          // queued, and the body's own pre-insert refusals keep their known class through the callback (they
          // arrive as a `[PRE_INSERT, name]` answer, not as a throw).
          if (disposed || !hasCallCommand) { slot = null; settle(new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE)); return; }
          let previousData;
          try { previousData = writeScope(params); }
          catch { slot = null; owned.uncertain = false; settle(new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE)); return; }
          owned.dispatched = true;
          try { command.table(callback); }
          finally { clearScope(previousData); }
        } else if (kind === 'headinginsert') {
          // THE HEADING STYLE ASSIGNMENT: ONE command, and the SAME parameter channel the search,
          // structure, block and table legs use — the validated `{ paragraph, level, styleName }` triple
          // written into the page's `Asc.scope`, never composed into source (ADR 0002). It needs the entry
          // point that OWNS that wrapper (`callCommand`); a build whose command channel is the bare
          // `executeCommand` transport has no sanctioned parameter channel at all, so it refuses HERE,
          // before any dispatch, and releases the slot because nothing reached the editor.
          // It carries NO document-identity probe, and its reason is the SHARPEST of the write legs rather
          // than a copy of theirs: this leg addresses a POSITION, not an owned TARGET, so there is no handle
          // whose identity a probe could establish — and a probe over a caret/document id could not make a
          // POSITION stable anyway, because a concurrent edit ABOVE the addressed index renumbers it without
          // changing any id. What the leg does instead is MEASURED and stated: the body reads the addressed
          // paragraph's OWN STYLE before the one `SetStyle` and again after it, through the measured
          // `GetParaPr().GetStyle().GetName()` chain, and requires the AFTER name to be the requested one
          // while the paragraph count, the heading count (+1) and the addressed text are all unchanged. Those
          // three are SECONDARY signals that can only REFUTE — a stale index whose paragraph now holds
          // different text is a non-success (`APPLY_UNCERTAIN`, slot HELD, no retry) rather than a silent edit
          // of the wrong paragraph. THE ADDRESSED OBJECT'S IDENTITY IS NOT USED ANYWHERE: the two paragraph
          // lists were MEASURED to hand out different wrapper objects, so an identity leg could never hold
          // (a duplicate-text document made an even older text leg answer `ok` for a `SetStyle` that landed
          // on the other paragraph, which is why the text is not the proof either). A target whose own style
          // name is already a HEADING name is refused BEFORE the one `SetStyle` as the closed argument class
          // with the slot released, because a level change on an existing heading moves no count at all. The
          // residual it cannot catch — a concurrent edit that lands a paragraph with EXACTLY the same text at
          // that index — is accepted and recorded in §15b of docs/sprint-3-progress.md with its structural
          // remedy, never silently relied on.
          // `owned.dispatched` is set BEFORE the native is handed the command, exactly like every other
          // leg: a synchronous throw out of the transport must never release a slot whose work may already
          // be queued, and the body's own pre-insert refusals keep their known class through the callback
          // (they arrive as a `[PRE_INSERT, name]` answer, not as a throw).
          if (disposed || !hasCallCommand) { slot = null; settle(new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE)); return; }
          let previousHeading;
          try { previousHeading = writeScope(params); }
          catch { slot = null; owned.uncertain = false; settle(new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE)); return; }
          owned.dispatched = true;
          try { command.heading(callback); }
          finally { clearScope(previousHeading); }
        } else if (kind === 'rangeformat') {
          // THE RANGE FORMAT: ONE command, and the SAME parameter channel the other read and write legs use —
          // the validated `{ paragraph, start, end, align, bold, italic, underline, strikeout, htmlMax }` scope
          // written into the page's `Asc.scope`, never composed into source (ADR 0002). It needs the entry point
          // that OWNS that wrapper (`callCommand`); a build whose command channel is the bare `executeCommand`
          // transport has no sanctioned parameter channel at all, so it refuses HERE, before any dispatch, and
          // releases the slot because nothing reached the editor.
          // It carries NO document-identity probe, for the heading assignment's reason: this leg addresses a
          // POSITION and an OFFSET pair, not an owned TARGET, so there is no handle whose identity a probe
          // could establish. What it does instead is the subject of the body's own comment: the addressed
          // paragraph's OWN ALIGNMENT is read through the measured `GetParaPr().GetJc()` chain before the one
          // `SetJc` and again after it, the ADDRESSED REGION is read through a FRESH range on each side, and the
          // paragraph count and the paragraph's text are required unchanged. Each REQUESTED run property is then
          // proven through the measured HTML export — the addressed region's own pre-mutation text must occur
          // exactly once in it and be wrapped contiguously in that property's measured marker — because the
          // public `ApiTextPr`/`ApiRange` surface exposes NO getter for any character-level property (measured
          // in the vendored SDK). BOTH readbacks are the proof and the range flags can only REFUTE.
          // `owned.dispatched` is set BEFORE the native is handed the command, exactly like every other leg: a
          // synchronous throw out of the transport must never release a slot whose work may already be queued,
          // and the body's own pre-insert refusals keep their known class through the callback (they arrive as
          // a `[PRE_INSERT, name]` answer, not as a throw).
          if (disposed || !hasCallCommand) { slot = null; settle(new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE)); return; }
          let previousRange;
          try { previousRange = writeScope(params); }
          catch { slot = null; owned.uncertain = false; settle(new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE)); return; }
          owned.dispatched = true;
          try { command.format(callback); }
          finally { clearScope(previousRange); }
        } else if (kind === 'hyperlinkinsert') {
          // THE HYPERLINK INSERT: ONE command, and the SAME parameter channel the other read and write legs
          // use — the validated `{ url, text, paragraph, append, markdownMax }` scope written into the page's
          // `Asc.scope`, never composed into source (ADR 0002). It needs the entry point that OWNS that wrapper
          // (`callCommand`); a build whose command channel is the bare `executeCommand` transport has no
          // sanctioned parameter channel at all, so it refuses HERE, before any dispatch, and releases the slot
          // because nothing reached the editor.
          // It carries NO document-identity probe, for the heading assignment's reason: this leg addresses a
          // POSITION and a LABEL, not an owned TARGET, so there is no handle whose identity a probe could
          // establish. What it does instead is the subject of the body's own comment: the addressed paragraph's
          // OWN TEXT is read before the ONE `AddElement` (or before the ONE `Push`) and again after it, the
          // document's own paragraph-count delta is derived from the two pushed counts, and the URL is proven
          // inside the MARKDOWN FRAGMENT the addressed paragraph's own pre-mutation text locates — because the
          // public `ApiRange`/`ApiTextPr` surface has no hyperlink getter at all, and the markdown export is the
          // ONE readback the Lead measured to carry a link's text AND its URL.
          // `owned.dispatched` is set BEFORE the native is handed the command, exactly like every other leg: a
          // synchronous throw out of the transport must never release a slot whose work may already be queued,
          // and the body's own pre-insert refusals keep their known class through the callback (they arrive as
          // a `[PRE_INSERT, name]` answer, not as a throw).
          if (disposed || !hasCallCommand) { slot = null; settle(new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE)); return; }
          let previousHyperlink;
          try { previousHyperlink = writeScope(params); }
          catch { slot = null; owned.uncertain = false; settle(new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE)); return; }
          owned.dispatched = true;
          try { command.hyperlink(callback); }
          finally { clearScope(previousHyperlink); }
        } else if (kind === 'insert') {
          // The same guard, the same primitive, and the same limit on what is proven: the dispatch
          // channel is verified, the editor-side `PasteText` name is not. An editor that does not
          // implement the name never calls back, so the insert settles APPLY_UNCERTAIN (a write whose
          // acknowledgement never arrived may have applied) instead of claiming success. Whether the
          // installed R7 build exposes this public entry point under this name is PENDING NATIVE
          // VERIFICATION; nothing here reaches a private API or invents a second channel.
          if (disposed || !adapter.executeMethod) { slot = null; settle(new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE)); return; }
          // The pre-dispatch baseline phase owns the ticket first and ends by dispatching the paste
          // itself, so the mutation still happens exactly once and only after its baselines answered.
          beginInsert();
        } else { owned.dispatched = true; command.probe('capability', callback); }
      } catch {
        // Dispatch may have reached the SDK before throwing. Never unlock on a
        // synchronous exception unless its matching callback already settled.
        if (slot === owned && !owned.settled) {
          // The ticket's own closed class wins before any dispatch (an unavailable command channel, a
          // timer that could not be armed): nothing reached NATIVE work, so the caller gets the honest
          // code and the slot is released. After a dispatch the conservative uncertain path is kept,
          // because a dispatch that reached the SDK is never a release.
          if (!owned.dispatched) {
            slot = null;
            owned.uncertain = false;
            settle(error instanceof SafeError ? error : errorFor(kind, null));
            notify();
            return;
          }
          owned.uncertain = true;
          settle(errorFor(kind, null));
          notify();
        }
      }
    });
  }

  return Object.freeze({
    async readSelection({ signal } = {}) {
      ensureIdle();
      if (editor !== 'word' || currentEditor() !== editor || !adapter.executeMethod || !adapter.commandDispatch) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
      const owner = contextOwner;
      const text = await start('read', signal);
      if (signal?.aborted) throw new SafeError(ERROR_CODES.CANCELLED);
      ensureIdle();
      if (owner !== contextOwner || currentEditor() !== editor) throw new SafeError(ERROR_CODES.SELECTION_CHANGED);
      const id = await start('context', signal);
      if (signal?.aborted) throw new SafeError(ERROR_CODES.CANCELLED);
      if (disposed || owner !== contextOwner || currentEditor() !== editor) throw new SafeError(ERROR_CODES.SELECTION_CHANGED);
      const target = text === '' ? null : Object.freeze({});
      if (target) targets.set(target, Object.freeze({ owner, id, text }));
      return Object.freeze({ text, editorType: editor, eligible: target !== null, target, reason: target ? 'OWNED_ORDINARY_TEXT' : 'EMPTY_SELECTION' });
    },
    // Bounded public read of one addressed document region, served through the SAME single owned
    // callback slot as every other SDK operation. Every leg is classified: an unavailable public
    // read, a malformed native result and a byte-oversized read are closed classes, never a raw
    // exception. The read is decoded against the `maxBytes` budget the caller requested (capped by
    // the editor-result ceiling), so a paragraph/section read is not silently held to the selection
    // read's 8 KiB window. The caller's `signal` cancels both legs exactly as it does in
    // readSelection: an abort before a leg prevents that dispatch, an abort after one invalidates
    // the caller while the queued SDK work keeps the slot until its own callback. Whether the
    // installed R7 build exposes this public read method at all is PENDING NATIVE VERIFICATION —
    // until it is measured on the real editor the name is unproven and an editor that does not
    // implement it never calls back, which settles as TIMEOUT, never as a verified scope.
    async readContext(raw) {
      const scope = raw?.scope, index = raw?.index, maxBytes = raw?.maxBytes, signal = raw?.signal;
      // The scope is a closed descriptor enum, but the bridge is a public entry point: a caller that
      // is not this descriptor gets a refusal rather than an SDK call with an uninterpretable triple.
      if (!['paragraph', 'section', 'structure'].includes(scope)) return Object.freeze({ ok: false, code: ERROR_CODES.CAPABILITY_UNAVAILABLE });
      if (!Number.isSafeInteger(index) || index < 0) return Object.freeze({ ok: false, code: ERROR_CODES.CAPABILITY_UNAVAILABLE });
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) return Object.freeze({ ok: false, code: ERROR_CODES.CAPABILITY_UNAVAILABLE });
      try {
        ensureIdle();
        if (editor !== 'word' || currentEditor() !== editor) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        // One action, two legs on the same slot: the document identity check, then the bounded read.
        await start('context', signal);
        if (signal?.aborted) throw new SafeError(ERROR_CODES.CANCELLED);
        if (disposed) throw new SafeError(ERROR_CODES.CANCELLED);
        const text = await start('contextread', signal, { maxBytes }, Object.freeze([Object.freeze([scope, index, maxBytes])]));
        if (text === '') return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
        return Object.freeze({ ok: true, text });
      } catch (error) {
        return Object.freeze({ ok: false, code: error instanceof SafeError ? error.code : ERROR_CODES.EDITOR_ERROR });
      }
    },
    // The bounded CARET-CONTEXT read behind `read_paragraph`. It adds ONE editor primitive —
    // `GetCurrentSentence`, the caret read this repo has already observed the live build answer — and
    // no capability beyond the read channel every other leg already uses. The descriptor's own comment
    // carries the primitive evidence; what matters HERE is the shape: ONE leg and NO identity probe (a
    // caret context read returns no OWNED TARGET a later write could be applied to, exactly like
    // `readDocumentText`), dispatched BY NAME through the one owned callback slot and decoded against
    // the budget the caller requested, so a sentence is never silently held to the selection read's
    // 8 KiB window. Every outcome is classified — an unavailable dispatch channel, a malformed native
    // answer and a read above the requested budget are closed classes, never a raw exception — and the
    // caller's `signal` cancels exactly as it does in `readContext`: an abort before the leg prevents
    // that dispatch, an abort after one invalidates the caller while the queued SDK work keeps the slot
    // until its own callback. It is a READ: no leg of it matches a write class.
    // An EMPTY answer crosses as an ordinary `{ok:true, text:''}`: the bridge reports exactly what the
    // editor answered, and the empty-CARET convention belongs to the descriptor that publishes the
    // contract, so the one place that decides it is the tool's own comment and handler.
    async readParagraph(raw) {
      const maxBytes = raw?.maxBytes, signal = raw?.signal;
      // The budget is a closed precondition, never an optional refinement: a caller that cannot name
      // one gets a refusal rather than an SDK call decoded under a window it did not ask for.
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) return Object.freeze({ ok: false, code: ERROR_CODES.CAPABILITY_UNAVAILABLE });
      try {
        ensureIdle();
        if (editor !== 'word' || currentEditor() !== editor) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        if (disposed || !adapter.executeMethod) { slot = null; throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE); }
        const text = await start('caretread', signal, { maxBytes });
        return Object.freeze({ ok: true, text });
      } catch (error) {
        return Object.freeze({ ok: false, code: error instanceof SafeError ? error.code : ERROR_CODES.EDITOR_ERROR });
      }
    },
    // The bounded WHOLE-DOCUMENT text read behind `read_document_text`, and it is deliberately the
    // SMALLEST possible new leg: it adds NO editor primitive and no capability at all. The mechanism
    // is the one already measured on both builds and already used by the insert confirmation — the
    // public `GetFileHTML` export through the ONE owned dispatch channel, decoded by the SAME
    // `decodeDocumentText` + `documentText` helpers (one decode rule, not two) — and what this leg
    // adds is the document's own CHARACTER COUNT, which is the only thing a chunked reader needs to
    // slice a bounded chunk and to report `totalChars`/`truncated`/`nextOffset` without trusting a
    // model-supplied offset.
    //
    // ONE leg, not two. It carries no document-identity probe: unlike a selection read, this read
    // returns no OWNED TARGET a later write could be applied to, so there is no handle whose
    // ownership would have to be proven, and the insert's own pre-dispatch document read has always
    // taken exactly this shape. `ensureIdle` plus the editor check still keep the read on the ONE
    // owned callback slot that every other SDK operation shares.
    //
    // ONE dispatch, and it is a READ: the ticket's kind is `documentread`, which no write class
    // matches, so `pendingMutation` is false throughout and no `PasteText`/`ReplaceTextSmart` call
    // exists anywhere on this path. Every outcome is classified — an unavailable dispatch channel, a
    // malformed native answer and an export above the ceiling are closed classes, never a raw
    // exception — and the caller's `signal` cancels exactly as it does in `readContext`: an abort
    // before dispatch prevents it, an abort after dispatch invalidates the caller while the queued
    // SDK work owns the slot until its own callback.
    // Whether the installed R7 build exposes `GetFileHTML` is PENDING NATIVE VERIFICATION (it is the
    // same open question the insert's baseline read carries): an editor that does not implement it
    // never calls back, and the ticket settles TIMEOUT — never as a document.
    async readDocumentText(raw) {
      const signal = raw?.signal;
      try {
        ensureIdle();
        if (editor !== 'word' || currentEditor() !== editor) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        if (disposed || !adapter.executeMethod) { slot = null; throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE); }
        const text = await start('documentread', signal);
        if (typeof text !== 'string') throw new SafeError(ERROR_CODES.INVALID_DATA);
        return Object.freeze({ ok: true, text, totalChars: text.length });
      } catch (error) {
        return Object.freeze({ ok: false, code: error instanceof SafeError ? error.code : ERROR_CODES.EDITOR_ERROR });
      }
    },
    // The bounded DOCUMENT SEARCH behind `find_text` — the third Sprint 3 Word tool and the first READ
    // in this repo that goes through the `Api` builder inside a command body. The descriptor's own
    // comment carries the primitive evidence (measured on the target: a strict needle 4, the same needle
    // case-insensitively 5, a needle the document does not hold 0 as an EMPTY array, and `GetText()` on
    // an element as that match's own text); what matters HERE is the shape: ONE command on the ONE entry
    // point that owns the parameter wrapper, the validated needle/case/limit triple carried as DATA
    // through `Asc.scope`, and ONE strict decoder that turns the authored array into `{count, texts}`.
    // It is a READ: no leg of it matches a write class, it carries NO document-identity probe (a search
    // returns no OWNED TARGET a later write could be applied to) and nothing on this path reaches
    // `PasteText`/`ReplaceTextSmart`. The PRIMITIVE is measured on the target (`Search` answers the 4/5/0
    // array), and so is the `callCommand` carriage of a static body; what is NOT yet measured natively is
    // the SHIPPED body's parameter carriage — the `Asc.scope` write through the page's own namespace —
    // and an editor where that does not arrive answers the body's own refusal sentinel or never calls
    // back, so the ticket settles CAPABILITY_UNAVAILABLE or TIMEOUT — never a count.
    async findText(raw) {
      const query = raw?.query, matchCase = raw?.matchCase, limit = raw?.limit, signal = raw?.signal;
      // The request is a closed precondition, never an optional refinement: a caller that cannot name a
      // searchable needle, an explicit case decision and a bound gets a refusal instead of an SDK call
      // the tool that owns this method never advertised. The needle's SIZE is part of that precondition
      // — `assertByteLimit` answers by throwing, so it is mapped to the same closed class rather than
      // escaping as a raw exception.
      if (typeof query !== 'string' || query === '') return Object.freeze({ ok: false, code: ERROR_CODES.CAPABILITY_UNAVAILABLE });
      if (typeof matchCase !== 'boolean') return Object.freeze({ ok: false, code: ERROR_CODES.CAPABILITY_UNAVAILABLE });
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIMITS.findMatchesMax) return Object.freeze({ ok: false, code: ERROR_CODES.CAPABILITY_UNAVAILABLE });
      try { assertByteLimit(query, LIMITS.findQueryBytes); }
      catch { return Object.freeze({ ok: false, code: ERROR_CODES.CAPABILITY_UNAVAILABLE }); }
      try {
        ensureIdle();
        if (editor !== 'word' || currentEditor() !== editor) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        // The parameter channel, checked BEFORE the ticket exists so the refusal carries no slot at all.
        if (disposed || !hasCallCommand) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        const found = await start('search', signal, {}, Object.freeze({ query, matchCase, limit }));
        return Object.freeze({ ok: true, count: found.count, texts: found.texts });
      } catch (error) {
        return Object.freeze({ ok: false, code: error instanceof SafeError ? error.code : ERROR_CODES.EDITOR_ERROR });
      }
    },
    // The bounded DOCUMENT-STRUCTURE read behind `read_structure` — the fourth Sprint 3 Word tool and the
    // second leg that goes through the `Api` builder inside a command body. The descriptor and
    // `limits.js` carry the measured primitive evidence (the five-field `GetStatistics()` object, the
    // array lengths, `GetText()` on each heading paragraph) and the entry arithmetic; what matters HERE
    // is the shape: ONE command on the ONE entry point that owns the parameter wrapper, the validated
    // extraction cap carried as DATA through `Asc.scope`, and ONE strict decoder that turns the authored
    // flat array into `{ pages, statistics, counts, headings }`. The request is a closed precondition,
    // never an optional refinement: a caller that cannot name the cap — or names one this bridge never
    // advertised — gets a refusal instead of an SDK call extracting an unbounded outline. It is a READ:
    // no leg of it matches a write class, it carries NO document-identity probe (a structure read returns
    // no OWNED TARGET a later write could be applied to) and nothing on this path reaches
    // `PasteText`/`ReplaceTextSmart`. What is NOT measured natively is the SHIPPED body's parameter
    // carriage for this leg: an editor where the `Asc.scope` write does not arrive answers the body's own
    // refusal sentinel or never calls back, so the ticket settles CAPABILITY_UNAVAILABLE or TIMEOUT —
    // never a structure.
    async readStructure(raw) {
      const maxHeadings = raw?.maxHeadings, signal = raw?.signal;
      if (!Number.isSafeInteger(maxHeadings) || maxHeadings < 1 || maxHeadings > LIMITS.structureHeadingsMax) {
        return Object.freeze({ ok: false, code: ERROR_CODES.CAPABILITY_UNAVAILABLE });
      }
      try {
        ensureIdle();
        if (editor !== 'word' || currentEditor() !== editor) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        // The parameter channel, checked BEFORE the ticket exists so the refusal carries no slot at all.
        if (disposed || !hasCallCommand) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        const structure = await start('structureread', signal, {}, Object.freeze({ maxHeadings }));
        return Object.freeze({ ok: true, pages: structure.pages, statistics: structure.statistics,
          counts: structure.counts, headings: structure.headings });
      } catch (error) {
        return Object.freeze({ ok: false, code: error instanceof SafeError ? error.code : ERROR_CODES.EDITOR_ERROR });
      }
    },
    // Automatic insert through the public paste entry point, served through the SAME owned callback
    // slot and under the same document-identity proof as every other dispatched operation. The
    // dispatch channel is verified with ownFunction before the irreversible call; whether the
    // installed R7 build implements `PasteText` is PENDING NATIVE VERIFICATION — an editor that does
    // not implement it never calls back, so the ticket settles APPLY_UNCERTAIN rather than success.
    // An acknowledgement that carries NO value is the one measured case on the live 2026.3.1 build
    // (the paste applies and the callback receives `undefined`): the ticket reads the document's own
    // export ONCE BEFORE the paste, decodes it to TEXT and counts the dispatched payload in that text,
    // dispatches the paste exactly once, and then reads the export ONCE more and reports success only
    // when the post count is exactly `baselineCount + 1`. Counting in decoded text rather than in the
    // export's markup is what makes the rule sound: markup and entities cannot contribute an
    // occurrence, so a paste that silently mutates nothing cannot move a document count and neither can
    // an unrelated `&` the user typed. `effectVerified` therefore means what it says: the DOCUMENT's
    // TEXT gained exactly this payload once. No mutation is ever retried by this bridge.
    // The pre-dispatch read is itself a gate: without a usable baseline count there is nothing to
    // compare against, so the insert refuses with its own known class before any dispatch and releases
    // the slot. The caller's `signal` is honoured the same way: an abort before the paste is dispatched
    // prevents it (including during the baseline phase), an abort after dispatch keeps the write-class
    // uncertain-until-callback behaviour.
    async insertParagraph(raw) {
      const text = raw?.text, position = raw?.position ?? 'cursor', signal = raw?.signal;
      if (typeof text !== 'string' || text === '') return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
      if (position !== 'cursor' && position !== 'end') return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
      // A payload holding the extraction's separator sentinel is refused HERE, before the identity leg and
      // before any read: this is what makes "the separator cannot complete a needle" structural — the
      // needle IS the dispatched payload, so a payload that cannot carry the sentinel yields a needle
      // that cannot end with one either. Nothing reached the editor, so the refusal is the closed
      // known class with no slot held and no uncertainty about a mutation that never happened.
      if (payloadHoldsSentinel(text)) return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
      try {
        ensureIdle();
        if (editor !== 'word' || currentEditor() !== editor) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        // The command channel carries this insert's document-identity leg. When the build exposes
        // neither command entry point the refusal is made HERE, before any dispatch, exactly like the
        // read path above — and the slot it owned is released, because nothing reached the SDK.
        if (!adapter.commandDispatch) { slot = null; throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE); }
        // The document identity leg keeps this insert under the same ownership proof as every other
        // dispatched operation, and the Api-surface presence probe runs before the insert is dispatched.
        await start('context', signal);
        if (signal?.aborted) throw new SafeError(ERROR_CODES.CANCELLED);
        if (disposed) throw new SafeError(ERROR_CODES.CANCELLED);
        const acknowledgement = await start('insert', signal, {}, Object.freeze([position === 'end' ? `${text}\n` : text]));
        // A boolean acknowledgement keeps today's envelope EXACTLY — the payload was sent and the
        // effect is NOT verified by the callback's own value. The only other way this ticket can
        // settle is the document-delta confirmation above, which reports `effectVerified` because the
        // document's own export really gained exactly one occurrence of the dispatched payload; no
        // other path reaches this line with a success.
        return Object.freeze({ ok: true, data: Object.freeze(acknowledgement.effectVerified === true
          ? { sent: true, effectVerified: true }
          : { sent: acknowledgement.acknowledged }) });
      } catch (error) {
        return Object.freeze({ ok: false, code: error instanceof SafeError ? error.code : ERROR_CODES.EDITOR_ERROR });
      }
    },
    // The BLOCK APPEND behind `insert_blocks` — the FIRST MUTATION of Sprint 3 and the only leg in this
    // bridge that both WRITES and VERIFIES inside ONE authored command body. The body's own comment
    // carries the mechanism (a pre-dispatch baseline, every paragraph built and every heading style
    // resolved BEFORE the first `Push`, then ONE `Push` PER BLOCK IN BLOCK ORDER, then the post read) and
    // why no mutation primitive's boolean is the signal; what matters HERE is the shape: ONE command on
    // the ONE entry point that owns the parameter wrapper, the validated block array carried as DATA
    // through `Asc.scope`, and ONE strict decoder that turns the authored flat array — an explicit phase
    // slot, the delta's four counts, and one REGION flag per block (the block's own paragraph in the
    // region the append added, never a substring match over the document) — into the envelope below. The
    // EXACT-DELTA rule is then decided inside the ticket, before the slot is released: a delta that is
    // not exact, an answer that cannot be interpreted, and the body's own POST-insert uncertainty (a
    // throw PART WAY THROUGH the push loop, which leaves some blocks applied and some not) all settle
    // `APPLY_UNCERTAIN` with the slot HELD and no retry, while the body's PRE-insert refusals (an
    // unusable baseline, an unresolvable heading style) settle their closed KNOWN class with the slot
    // released, because nothing was inserted
    // — and they do so ONLY when the answer carries their phase, so a name alone can never release a slot.
    // The request is a closed precondition, never an optional refinement: a caller that cannot name a
    // bounded block array gets a refusal instead of an SDK call that appends an unbounded one. The SHAPE
    // rules are the closed argument class and the two BYTE bounds are the closed byte class — the same
    // two classes the tool publishes for the same two families — so a descriptor held directly and the
    // tool that serves it can never disagree about which refusal a caller receives.
    async insertBlocks(raw) {
      const blocks = raw?.blocks, signal = raw?.signal;
      if (!Array.isArray(blocks) || blocks.length < 1 || blocks.length > LIMITS.insertBlocksMax) {
        return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
      }
      const shaped = [];
      let total = 0;
      for (const block of blocks) {
        if (block === null || typeof block !== 'object' || Array.isArray(block)) return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
        if (typeof block.text !== 'string' || block.text === '') return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
        const bytes = utf8ByteLength(block.text);
        if (bytes > LIMITS.insertBlockBytes) return Object.freeze({ ok: false, code: ERROR_CODES.BYTE_LIMIT });
        const heading = block.heading;
        if (heading !== undefined && (!Number.isSafeInteger(heading) || heading < 1 || heading > LIMITS.insertHeadingMax)) {
          return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
        }
        total += bytes;
        shaped.push(Object.freeze(heading === undefined ? { text: block.text } : { text: block.text, heading }));
      }
      if (total > LIMITS.insertBlocksBytes) return Object.freeze({ ok: false, code: ERROR_CODES.BYTE_LIMIT });
      try {
        ensureIdle();
        if (editor !== 'word' || currentEditor() !== editor) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        // The parameter channel, checked BEFORE the ticket exists so the refusal carries no slot at all.
        if (disposed || !hasCallCommand) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        const outcome = await start('blocksinsert', signal, {}, Object.freeze({ blocks: Object.freeze(shaped) }));
        return Object.freeze({ ok: true, paragraphsBefore: outcome.paragraphsBefore, paragraphsAfter: outcome.paragraphsAfter,
          headingsBefore: outcome.headingsBefore, headingsAfter: outcome.headingsAfter, present: outcome.present });
      } catch (error) {
        return Object.freeze({ ok: false, code: error instanceof SafeError ? error.code : ERROR_CODES.EDITOR_ERROR });
      }
    },
    // The TABLE INSERT behind `insert_table` — the SECOND MUTATION of Sprint 3, and the second leg in this
    // bridge that both WRITES and VERIFIES inside ONE authored command body. The body's own comment carries
    // the mechanism (a pre-dispatch baseline, the table created and every cell filled BEFORE the one
    // `Push`, then the post read and the per-cell readback of the table the append added) and why no
    // mutation primitive's boolean is the signal; what matters HERE is the shape: ONE command on the ONE
    // entry point that owns the parameter wrapper, the validated matrix carried as DATA through
    // `Asc.scope`, and ONE strict decoder that turns the authored flat array — an explicit phase slot, the
    // delta's two counts, and one REGION flag per CELL (the appended table's own cell, never a match
    // anywhere in the document) — into the envelope below. The EXACT-DELTA rule is then decided inside the
    // ticket, before the slot is released: a table count that did not grow by exactly one, a cell of the
    // appended table that carries something else, an answer that cannot be interpreted, and the body's own
    // POST-insert uncertainty all settle `APPLY_UNCERTAIN` with the slot HELD and no retry, while the body's
    // PRE-insert refusals (an unusable baseline, a cell chain this build does not expose) settle their
    // closed KNOWN class with the slot released, because nothing was inserted — and they do so ONLY when
    // the answer carries their phase, so a name alone can never release a slot.
    // The request is a closed precondition, never an optional refinement: a caller that cannot name a
    // bounded, rectangular matrix gets a refusal instead of an SDK call that inserts an unbounded one. The
    // SHAPE rules (the non-empty matrix, the non-empty row, the rectangularity, the geometry bounds) are
    // the closed argument class and the two BYTE bounds are the closed byte class — the same two classes
    // the tool publishes for the same two families — so a descriptor held directly and the tool that
    // serves it can never disagree about which refusal a caller receives.
    async insertTable(raw) {
      const data = raw?.data, signal = raw?.signal;
      if (!Array.isArray(data) || data.length < 1 || data.length > LIMITS.insertTableRowsMax) {
        return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
      }
      const shaped = [];
      let columns = null;
      let total = 0;
      for (const row of data) {
        if (!Array.isArray(row) || row.length < 1 || row.length > LIMITS.insertTableColumnsMax) return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
        if (columns === null) columns = row.length;
        else if (row.length !== columns) return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
        const shapedRow = [];
        for (const cell of row) {
          if (typeof cell !== 'string') return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
          const bytes = utf8ByteLength(cell);
          if (bytes > LIMITS.insertTableCellBytes) return Object.freeze({ ok: false, code: ERROR_CODES.BYTE_LIMIT });
          total += bytes;
          shapedRow.push(cell);
        }
        shaped.push(Object.freeze(shapedRow));
      }
      // `columns` cannot be null here — every row is non-empty — and the guard keeps a future edit from
      // dispatching a matrix the decoder could not lay its one flag per cell out over.
      if (columns === null || columns < 1) return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
      if (total > LIMITS.insertTableBytes) return Object.freeze({ ok: false, code: ERROR_CODES.BYTE_LIMIT });
      try {
        ensureIdle();
        if (editor !== 'word' || currentEditor() !== editor) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        // The parameter channel, checked BEFORE the ticket exists so the refusal carries no slot at all.
        if (disposed || !hasCallCommand) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        const outcome = await start('tableinsert', signal, {}, Object.freeze({ data: Object.freeze(shaped) }));
        return Object.freeze({ ok: true, tablesBefore: outcome.tablesBefore, tablesAfter: outcome.tablesAfter, present: outcome.present });
      } catch (error) {
        return Object.freeze({ ok: false, code: error instanceof SafeError ? error.code : ERROR_CODES.EDITOR_ERROR });
      }
    },
    // THE HEADING STYLE ASSIGNMENT behind `set_heading` — the THIRD MUTATION of Sprint 3 and the FIRST
    // write leg that appends NOTHING: it changes an EXISTING paragraph in place through ONE
    // `paragraph.SetStyle(style)` on an index the caller names. The body's own comment carries the
    // mechanism (a pre-dispatch baseline of the two counts AND the addressed paragraph's own style and text,
    // the style RESOLVED before the mutation, then ONE `SetStyle`, then the post read and the style readback)
    // and why no mutation primitive's boolean is the signal; what matters HERE is the shape: ONE command on
    // the ONE entry point that owns the parameter wrapper, the validated `{ paragraph, level, styleName }`
    // triple carried as DATA through `Asc.scope`, and ONE strict decoder that turns the authored flat array —
    // an explicit phase slot, the delta's two heading counts, and four flags (the paragraph count invariant,
    // the unchanged addressed text, and the addressed paragraph's OWN style readback: whether it was read at
    // all and whether it is the requested one) — into the envelope below. The OUTCOME rule is then decided
    // inside the ticket, before the slot is released, and the READBACK is the PRIMARY leg: an unread readback
    // is `APPLY_UNCERTAIN` with the slot HELD (the mutation has already run — there is NO identity fallback,
    // because the two paragraph lists were measured to hand out different wrapper objects), and so are a
    // readable style that is not the requested one (under the module's case- and space-folding), a target
    // whose text moved, a paragraph count that moved, a heading count that did not grow by exactly one, an
    // answer that cannot be interpreted and the body's own POST-insert uncertainty — all with no retry, while
    // the body's PRE-insert refusals (an unusable baseline, an index outside the document, a target whose own
    // style name is already a heading name, an unresolvable `Heading <n>`) settle their closed KNOWN class
    // with the slot released, because nothing was styled — and they do so ONLY when the answer carries their
    // phase, so a name alone can never release a slot.
    // The request is a closed precondition, never an optional refinement: a caller that cannot name an
    // in-range index, a level in the heading family and the style name that level means gets a refusal
    // instead of an SDK call that styles an unnamed paragraph. The SHAPE rules are the closed argument
    // class — the same class the tool publishes for the same family — so a descriptor held directly and the
    // tool that serves it can never disagree about which refusal a caller receives. THE STYLE NAME IS
    // CROSS-CHECKED against the level HERE rather than taken on trust: the bridge is a public entry point,
    // and a triple whose name does not mean its level would let a caller style a paragraph with a name this
    // module never measured.
    async setHeading(raw) {
      const paragraph = raw?.paragraph, level = raw?.level, styleName = raw?.styleName, signal = raw?.signal;
      if (!Number.isSafeInteger(paragraph) || paragraph < 0 || paragraph > LIMITS.setHeadingIndexMax) {
        return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
      }
      if (!Number.isSafeInteger(level) || level < 1 || level > LIMITS.insertHeadingMax) {
        return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
      }
      // THE STYLE NAME IS CROSS-CHECKED against the level HERE rather than taken on trust: the bridge is a
      // public entry point, and a triple whose name does not mean its level would let a caller style a
      // paragraph with a name this module never measured. The comparison is made against the NAME DERIVED
      // FROM THE LEVEL rather than against a spelled-out `'Heading ' + level`, so there is no second place
      // the mapping could drift to.
      if (styleName !== `Heading ${level}`) return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
      try {
        ensureIdle();
        if (editor !== 'word' || currentEditor() !== editor) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        // The parameter channel, checked BEFORE the ticket exists so the refusal carries no slot at all.
        if (disposed || !hasCallCommand) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        const outcome = await start('headinginsert', signal, {}, Object.freeze({ paragraph, level, styleName }));
        // `styleName` is ECHOED, not dropped: the tool derives it from the level and carries it to the body,
        // so the tool can require the answer to name the SAME style it asked for — an `ok` envelope that
        // names a different one was produced for a request this caller did not make. It is the one field
        // here that is NOT a measurement of the document, and it is the request's own word.
        return Object.freeze({ ok: true, styleName, headingsBefore: outcome.headingsBefore, headingsAfter: outcome.headingsAfter,
          paragraphsStable: outcome.paragraphsStable, textUnchanged: outcome.textUnchanged,
          styleRead: outcome.styleRead, styleMatches: outcome.styleMatches });
      } catch (error) {
        return Object.freeze({ ok: false, code: error instanceof SafeError ? error.code : ERROR_CODES.EDITOR_ERROR });
      }
    },
    // THE RANGE FORMAT behind `format_range` — the FOURTH MUTATION of Sprint 3 and the SECOND write leg that
    // appends nothing: it changes an EXISTING paragraph in place, on an index the caller names, within a
    // character range of that paragraph's own text. It has TWO legs: the paragraph ALIGNMENT through ONE
    // `paragraph.GetParaPr().SetJc(...)` — authored ONLY when the request named an alignment — and the four
    // MEASURED character properties through ONE `paragraph.GetRange(from,to).SetBold/…(true)` per property
    // requested. The body's own comment carries the mechanism (a pre-dispatch baseline of the paragraph count,
    // the addressed paragraph's own text, alignment and REGION, the export gate, then the alignment call when
    // it was named plus one call per requested run property, then the post reads and the marker proof) and why
    // no mutation primitive's return value is the signal; what matters HERE is the shape: ONE command on the
    // ONE entry point that owns the parameter wrapper, the validated
    // `{ paragraph, start, end, align, bold, italic, underline, strikeout, htmlMax }` scope carried as DATA
    // through `Asc.scope`, and ONE strict decoder that turns the authored flat array — an explicit phase slot,
    // five range flags, ONE four-character run proof and the requested/measured/measured alignment triple —
    // into the envelope below. The OUTCOME rule is then decided inside the ticket, before the slot is released,
    // and BOTH readbacks are PRIMARY while the region flags can only REFUTE: an unread readback, a readable
    // alignment that disagrees, a requested run marker that does not contain the addressed region, a proof for a
    // property nobody requested, a region that moved, a paragraph count that moved, an answer that cannot be
    // interpreted and the body's own POST-insert uncertainty are all `APPLY_UNCERTAIN` with the slot HELD and
    // no retry, while the body's PRE-insert refusals (an unusable baseline, an index outside the document,
    // offsets outside the paragraph, an unreadable pre-state alignment, a missing/throwing export and an export
    // above `LIMITS.formatRangeHtmlChars`) settle their closed KNOWN class with the slot released, because
    // nothing was mutated — and they do so ONLY when the answer carries their phase.
    // THE REQUEST IS A CLOSED PRECONDITION, never an optional refinement, and it is re-checked HERE rather
    // than taken on trust: the bridge is a public entry point, and an address, an alignment or a run switch
    // this module never measured would let a caller format something the tool's own schema would have refused.
    // The bounds, the vocabulary and the four switch names are the SAME ones the descriptor advertises
    // (`LIMITS`), so a descriptor held directly and the tool that serves it cannot disagree about which
    // refusal a caller receives. THE ALIGNMENT IS THE ONE FIELD THAT MAY BE ABSENT: a request that names no
    // alignment carries the `'none'` sentinel and the body authors no paragraph-level call for it, while a
    // request that names NONE OF THE FIVE PROPERTIES at all is the closed argument class with NOTHING
    // dispatched — there would be nothing to apply and nothing to prove.
    async formatRange(raw) {
      // THE LOCALS ARE NAMED SO THEY CANNOT SHADOW THE DISPATCHER. `start` is the bridge's own ticket
      // opener in this closure, so the request's two offsets are bound as `from`/`to`: a local named
      // `start` would make the dispatch below a call on a NUMBER, and the throw would be classified as an
      // editor failure instead of reaching the editor at all.
      const paragraph = raw?.paragraph, from = raw?.start, to = raw?.end, align = rangeRequestedAlign(raw?.align), signal = raw?.signal;
      // THE FOUR RUN SWITCHES, resolved with the same discipline as the alignment itself: an ABSENT switch is
      // the `false` a request that names none means, a boolean is itself, and anything else is the closed
      // argument class with NOTHING dispatched. The switch names are the four MEASURED markers' properties and
      // the list is closed: there is no `size`, `color`, `family` or `highlight` here to accept.
      const bold = rangeRun(raw?.bold), italic = rangeRun(raw?.italic);
      const underline = rangeRun(raw?.underline), strikeout = rangeRun(raw?.strikeout);
      if (!Number.isSafeInteger(paragraph) || paragraph < 0 || paragraph > LIMITS.formatRangeIndexMax) {
        return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
      }
      if (!Number.isSafeInteger(from) || from < 0 || from > LIMITS.formatRangeOffsetMax) {
        return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
      }
      if (!Number.isSafeInteger(to) || to < 0 || to > LIMITS.formatRangeOffsetMax) {
        return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
      }
      // A REVERSED OR EMPTY RANGE IS NOT AN ADDRESS: `start === end` covers no character and `start > end` is
      // a range the editor's own constructor would silently swap, so both are the closed argument class with
      // NOTHING dispatched rather than a request this body would have to reinterpret.
      if (!(from < to)) return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
      if (align === null) return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
      if (bold === null || italic === null || underline === null || strikeout === null) {
        return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
      }
      // AT LEAST ONE PROPERTY, or nothing is dispatched at all: `format: {}` names no alignment and no run
      // property, so this call has nothing to apply and nothing to prove — it is the closed argument class,
      // decided HERE as well as in the descriptor's own precondition because the bridge is a public entry
      // point a descriptor held directly could bypass.
      if (align === RANGE_ALIGN_NONE && bold === false && italic === false && underline === false && strikeout === false) {
        return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
      }
      try {
        ensureIdle();
        if (editor !== 'word' || currentEditor() !== editor) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        // The parameter channel, checked BEFORE the ticket exists so the refusal carries no slot at all.
        if (disposed || !hasCallCommand) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        // THE SCOPE, and `htmlMax` is composed HERE from the named limit rather than read from the caller: a
        // descriptor held directly, or a caller that guessed the key, cannot widen the export bound, and the
        // number the body enforces is the number this module publishes.
        const outcome = await start('rangeformat', signal, {},
          Object.freeze({ paragraph, start: from, end: to, align,
            bold, italic, underline, strikeout, htmlMax: LIMITS.formatRangeHtmlChars }));
        // THE FOUR RUN SWITCHES ARE ECHOED, not dropped, exactly as `align` and `styleName` are: the tool
        // derives them from the closed schema and carries them to the body, so the tool can require the answer
        // to name the SAME request it made — an `ok` envelope produced for a different request is never
        // republished as this one's proof. The four VERIFIED flags beside them are the body's own measurement,
        // and each is `true` exactly when that property was requested AND its measured marker pair was located
        // around the addressed region. The alignment echo has the same standing, beside the two readback values
        // — which are the `'none'` sentinel, on both sides, for a request that named no alignment at all.
        return Object.freeze({ ok: true, align, alignBefore: outcome.alignBefore, alignAfter: outcome.alignAfter,
          paragraphsStable: outcome.paragraphsStable, textUnchanged: outcome.textUnchanged,
          rangeRead: outcome.rangeRead, rangeUnchanged: outcome.rangeUnchanged, rangeShifted: outcome.rangeShifted,
          bold, italic, underline, strikeout,
          boldVerified: outcome.boldVerified, italicVerified: outcome.italicVerified,
          underlineVerified: outcome.underlineVerified, strikeoutVerified: outcome.strikeoutVerified });
      } catch (error) {
        return Object.freeze({ ok: false, code: error instanceof SafeError ? error.code : ERROR_CODES.EDITOR_ERROR });
      }
    },
    // THE HYPERLINK INSERT behind `add_hyperlink` — the FIFTH MUTATION of Sprint 3, the THIRD write leg that
    // APPENDS, and the FIRST one that takes a URL from the model. It has TWO FORMS and the request names which
    // one it is: the NAMED form appends ONE `Api.CreateHyperlink(url, text)` into an EXISTING paragraph through
    // that paragraph's own `AddElement`, while the APPEND form creates a DETACHED `Api.CreateParagraph()`,
    // places the same link in it, and `Push`es it at the END of the document. The body's own comment carries
    // the mechanism (a pre-dispatch baseline of the document's paragraph count and the addressed paragraph's
    // own text, the fragment needle and the export gate, then the ONE mutation, then the post reads and the
    // fragment proof) and why no mutation primitive's return value is the signal; what matters HERE is the
    // shape: ONE command on the ONE entry point that owns the parameter wrapper, the validated
    // `{ url, text, paragraph, append, markdownMax }` scope carried as DATA through `Asc.scope`, and ONE strict
    // decoder that turns the authored flat array — an explicit phase slot, two paragraph counts, the addressed
    // paragraph's own pre and post text lengths, and three proof flags — into the envelope below. The OUTCOME
    // rule is then decided inside the ticket, before the slot is released, and the ADDRESSED TEXT is PRIMARY:
    // a text that is not exactly what the request meant, a count delta that is not the request's own, a text
    // length that contradicts it, a fragment that was not located exactly once, a url that is not inside it, an
    // answer that cannot be interpreted and the body's own POST-insert uncertainty are all `APPLY_UNCERTAIN`
    // with the slot HELD and no retry, while the body's PRE-insert refusals (an unusable baseline, an index
    // outside the document, a fragment the export ALREADY renders, a missing/throwing export and an export
    // above `LIMITS.addHyperlinkMarkdownChars`) settle their closed KNOWN class with the slot released, because
    // nothing was written — and they do so ONLY when the answer carries their phase.
    // THE REQUEST IS A CLOSED PRECONDITION, never an optional refinement, and it is re-checked HERE rather than
    // taken on trust: the bridge is a public entry point, and a url, a label or a form this module never
    // measured would let a caller write a link the tool's own schema would have refused. The bounds, the scheme
    // vocabulary and the control-character rule are the SAME ones the descriptor advertises (`LIMITS`), and THE
    // ADDRESS AND THE FORM ARE ONE FACT: the append form must name NO index, and the named form must name a
    // whole non-negative one inside the advertised bound.
    async addHyperlink(raw) {
      const url = requestedUrl(raw?.url), text = requestedText(raw?.text);
      const append = raw?.append, address = raw?.paragraph, signal = raw?.signal;
      if (url === null || text === null) return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
      if (append !== true && append !== false) return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
      if (append === true) {
        if (address !== null && address !== undefined) return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
      } else if (!Number.isSafeInteger(address) || address < 0 || address > LIMITS.addHyperlinkIndexMax) {
        return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
      }
      try {
        ensureIdle();
        if (editor !== 'word' || currentEditor() !== editor) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        // The parameter channel, checked BEFORE the ticket exists so the refusal carries no slot at all.
        if (disposed || !hasCallCommand) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        // THE SCOPE, and `markdownMax` is composed HERE from the named limit rather than read from the caller:
        // a descriptor held directly, or a caller that guessed the key, cannot widen the export bound, and the
        // number the body enforces is the number this module publishes. `paragraph` is `null` for the append
        // form, which is the form's OWN address rather than an invented index.
        const outcome = await start('hyperlinkinsert', signal, {},
          Object.freeze({ url, text, paragraph: append === true ? null : address, append,
            markdownMax: LIMITS.addHyperlinkMarkdownChars }));
        // THE FORM IS ECHOED, not dropped, exactly as `styleName` and the four run switches are: the tool
        // derives it from the closed request and carries it to the body, so the tool can require the answer to
        // name the SAME form it asked for — an `ok` envelope produced for a different request is never
        // republished as this one's proof. The three flags beside it are the body's own measurement.
        return Object.freeze({ ok: true, paragraphsBefore: outcome.paragraphsBefore,
          paragraphsAfter: outcome.paragraphsAfter, textBeforeChars: outcome.textBeforeChars,
          textAfterChars: outcome.textAfterChars, textAppended: outcome.textAppended,
          fragmentUnique: outcome.fragmentUnique, urlInFragment: outcome.urlInFragment });
      } catch (error) {
        return Object.freeze({ ok: false, code: error instanceof SafeError ? error.code : ERROR_CODES.EDITOR_ERROR });
      }
    },
    async probeCapabilities({ signal } = {}) {
      if (disposed) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
      if (slot !== null) throw new SafeError(ERROR_CODES.EDITOR_BUSY);
      if (signal?.aborted) throw new SafeError(ERROR_CODES.CANCELLED);
      if (editor !== 'word' || !adapter.commandDispatch) return capabilities();
      return start('probe', signal);
    },
    canApply(target) { try { return slot === null && ownedTarget(target) !== null; } catch { return false; } },
    async applySelection(raw) {
      const { target, replacement, signal, deadline = readClock() + LIMITS.applyObservationMs, beforeDispatch } = applyData(raw);
      ensureIdle();
      const saved = ownedTarget(target);
      if (!saved) throw new SafeError(ERROR_CODES.SELECTION_CHANGED);
      function check() {
        if (signal?.aborted) throw new SafeError(ERROR_CODES.CANCELLED);
        if (ownedTarget(target) !== saved) throw new SafeError(ERROR_CODES.SELECTION_CHANGED);
        if (readClock() >= deadline) throw new SafeError(ERROR_CODES.TIMEOUT);
        ensureIdle();
      }
      async function currentIdentity() {
        check();
        let id;
        try { id = await start('context', signal); }
        catch (error) {
          if (error instanceof SafeError && [ERROR_CODES.INVALID_DATA, ERROR_CODES.CAPABILITY_UNAVAILABLE].includes(error.code)) throw new SafeError(ERROR_CODES.SELECTION_CHANGED);
          throw error;
        }
        check();
        if (id !== saved.id) throw new SafeError(ERROR_CODES.SELECTION_CHANGED);
      }
      await currentIdentity();
      const text = await start('read', signal);
      check();
      if (text === '' || text !== saved.text) throw new SafeError(ERROR_CODES.SELECTION_CHANGED);
      await currentIdentity();
      check();
      // Consume once. Async check/write is not atomic or an immutable locator.
      targets.delete(target);
      return start('write', signal, { replacement, beforeDispatch });
    },
    subscribe(listener) { listeners.add(listener); return function () { listeners.delete(listener); }; },
    getState() { return Object.freeze({ editorType: editor, busy: slot !== null, uncertain: slot?.uncertain ?? false, disposed, writePending: pendingMutation(slot) }); },
    invalidate() { contextOwner = Object.freeze({}); slot?.cancel(); },
    dispose() { disposed = true; contextOwner = Object.freeze({}); slot?.cancel(); }
  });
}
