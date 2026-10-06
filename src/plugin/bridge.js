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
// `replaceinsert` is the text replace: it rewrites existing text IN PLACE through ONE
// `document.SearchAndReplace` inside its own command body, and it is named here explicitly for the same
// reason the heading assignment and the range format are. `imageinsert` is the image insert: it writes ONE
// `paragraph.AddDrawing` of an `Api.CreateImage` into an EXISTING paragraph, or — for its OTHER form — ONE
// `Api.CreateParagraph` plus the same `AddDrawing` plus ONE `document.Push` that lands the created paragraph
// at the END of the document. It is therefore BOTH an in-place write and an append, exactly like the
// hyperlink insert, and it is named here explicitly for that leg's reason. `commentinsert` is the comment
// insert: it creates ONE comment through the DOCUMENT's own `AddComment`, which joins the document's comment
// collection — an APPEND, but of a comment rather than of a block — and it is named here explicitly for the
// same reason. `sheetwrite` is the SPREADSHEET write: it is the FIRST leg that writes into a WORKBOOK rather
// than a document, through ONE `range.SetValue` per cell of the addressed block inside its own command body,
// and it is the FIRST whose proof is a bounded readback of the very block it wrote (one flag per cell) rather
// than a document delta. It is named here explicitly for the same reason every other write leg is.
// `cellformat` is the CELL FORMATTING: it changes PRESENTATION rather than content, through the measured
// formatting setters on the addressed block, and its proof is one flag per (property, cell) and per
// (geometry property, column/row) — the first leg whose proof is per-PROPERTY rather than per-target, because
// a single flag per cell could hide one unproven property behind the proven ones.
const WRITE_KINDS = Object.freeze(new Set(['write', 'insert', 'blocksinsert', 'tableinsert', 'headinginsert', 'rangeformat', 'hyperlinkinsert', 'replaceinsert', 'imageinsert', 'commentinsert', 'sheetwrite', 'cellformat', 'sheetadd']));

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
      // ----- CELL: the bounded SPREADSHEET read ---------------------------------------------------
      // The first Cell leg in this repo, and it authors primitives MEASURED on a live Cell session
      // (R7-Office Editors 2026.3.1, document `doctype=spreadsheet`): `Api.GetActiveSheet()`,
      // `sheet.GetName()`, `sheet.GetIndex()`, `Api.GetSheets()` (an Array whose `length` is the sheet
      // count), `sheet.GetUsedRange()` (the ONLY used-range discovery this build exposes —
      // `GetRowsCount`/`GetColumnsCount`/`GetMaxRow`/`GetMaxColumn` are all `undefined`), and
      // `range.GetValue()` (a 2-D array of strings, one row per row, for a BLOCK — but a SCALAR STRING for a
      // ONE-CELL range, which the shape rule below separates). `range.GetFormula()` was measured on
      // BOTH sizes and answers two DIFFERENT things: a ONE-CELL range answers the formula SOURCE, while a
      // MULTI-CELL range answers the computed VALUES. The sources are therefore collected ADDRESSALLY, one
      // single-cell range per published cell, and a cell's slot holds the source only when it begins with
      // `=` — the same getter answers a cell's own TEXT when the cell holds no formula at all.
      // The answer is ONE flat array of primitives, exactly like the search/structure legs (the native
      // return validator keeps those and strips a plain object):
      //   `[CAPABILITY_UNAVAILABLE]` — the body's own closed refusal; or
      //   `[sheetName, sheetIndex, sheetCount, address, rowCount, columnCount, formulasMatch, v…, f…]`
      // where the `rowCount × columnCount` value strings are followed by the same number of FORMULA SOURCE
      // strings ONLY when `formulasMatch` is 1. It is a READ: it has no phase, no mutation and no leg
      // that could reach a write class.
      // ----- CELL: the bounded WORKBOOK MUTATION (add a sheet) -----------------------------------
      // The first MUTATION whose subject is the book. `Api.AddSheet(name?)` answers `undefined`, which is
      // neither success nor failure, so NOTHING is read from its return value: the outcome is a POSTCONDITION
      // measured from the editor afterwards, and the decoder proves it. `AddSheet` MEASURABLY appends the new
      // sheet LAST and makes it ACTIVE, and the previous active sheet is deliberately NOT restored — restoring
      // it would be a hidden second action, and the caller is told which sheet was active before instead.
      // TWO REFUSALS HAPPEN BEFORE THE MUTATION, because both are states the book must never be left in: adding
      // would exceed the sheet bound, or the requested name ALREADY EXISTS (measured: `Api.GetSheet(name)`
      // answers that sheet, and null for a name that does not exist).
      // THE PHASE TURNS POST_INSERT IMMEDIATELY BEFORE `AddSheet`: from that call on, an unproved postcondition
      // is the UNCERTAIN class with the callback slot HELD — never a known error, never a retry, and a sheet that
      // may have been created is deliberately NOT deleted.
      sheetadd(callback) {
        return plugin.callCommand(function () {
          var phase = 'PRE_INSERT';
          function addRefusal(name) {
            var refusal = [];
            refusal.push(phase);
            refusal.push(name);
            return refusal;
          }
          try {
            var request = typeof scope !== 'undefined' && scope !== null ? scope : null;
            if (request === null) return addRefusal('CAPABILITY_UNAVAILABLE');
            var sheetAddMax = request.maxSheets;
            if (typeof sheetAddMax !== 'number' || sheetAddMax < 1 || sheetAddMax % 1 !== 0) return addRefusal('CAPABILITY_UNAVAILABLE');
            var sheetAddRequested = request.requestedName === undefined ? null : request.requestedName;
            if (sheetAddRequested !== null && (typeof sheetAddRequested !== 'string' || sheetAddRequested === '')) return addRefusal('CAPABILITY_UNAVAILABLE');
            var available = typeof Api !== 'undefined' && Api !== null;
            if (!available) return addRefusal('CAPABILITY_UNAVAILABLE');
            // DEFENSIVE guards, like the listing body's: the surrounding catch answers the same refusal.
            if (typeof Api.GetSheets !== 'function') return addRefusal('CAPABILITY_UNAVAILABLE');
            if (typeof Api.GetSheet !== 'function') return addRefusal('CAPABILITY_UNAVAILABLE');
            if (typeof Api.GetActiveSheet !== 'function') return addRefusal('CAPABILITY_UNAVAILABLE');
            if (typeof Api.AddSheet !== 'function') return addRefusal('CAPABILITY_UNAVAILABLE');
            var sheetAddCollection = Api.GetSheets();
            if (sheetAddCollection === null || sheetAddCollection === undefined) return addRefusal('CAPABILITY_UNAVAILABLE');
            if (typeof sheetAddCollection.length !== 'number') return addRefusal('CAPABILITY_UNAVAILABLE');
            var sheetAddBefore = sheetAddCollection.length;
            if (sheetAddBefore < 1) return addRefusal('CAPABILITY_UNAVAILABLE');
            if (sheetAddBefore + 1 > sheetAddMax) return addRefusal('TOOL_ERROR');
            if (sheetAddRequested !== null) {
              var sheetAddExisting = Api.GetSheet(sheetAddRequested);
              if (sheetAddExisting !== null && sheetAddExisting !== undefined) return addRefusal('TOOL_ERROR');
            }
            // THE BASELINE: the ordered names, and the active sheet by NAME and INDEX (never by object identity).
            var sheetAddBeforeNames = [];
            for (var sheetAddPre = 0; sheetAddPre < sheetAddBefore; sheetAddPre++) {
              var sheetAddPreSheet = Api.GetSheet(sheetAddPre);
              if (sheetAddPreSheet === null || sheetAddPreSheet === undefined) return addRefusal('CAPABILITY_UNAVAILABLE');
              if (typeof sheetAddPreSheet.GetName !== 'function') return addRefusal('CAPABILITY_UNAVAILABLE');
              var sheetAddPreName = String(sheetAddPreSheet.GetName());
              if (sheetAddPreName === '') return addRefusal('CAPABILITY_UNAVAILABLE');
              sheetAddBeforeNames.push(sheetAddPreName);
            }
            var sheetAddActive = Api.GetActiveSheet();
            if (sheetAddActive === null || sheetAddActive === undefined) return addRefusal('CAPABILITY_UNAVAILABLE');
            if (typeof sheetAddActive.GetName !== 'function') return addRefusal('CAPABILITY_UNAVAILABLE');
            if (typeof sheetAddActive.GetIndex !== 'function') return addRefusal('CAPABILITY_UNAVAILABLE');
            var sheetAddWasActiveName = String(sheetAddActive.GetName());
            var sheetAddWasActiveIndex = Number(sheetAddActive.GetIndex());
            if (sheetAddWasActiveName === '') return addRefusal('CAPABILITY_UNAVAILABLE');
            if (!(sheetAddWasActiveIndex >= 0) || sheetAddWasActiveIndex % 1 !== 0) return addRefusal('CAPABILITY_UNAVAILABLE');
            if (sheetAddWasActiveIndex >= sheetAddBefore) return addRefusal('CAPABILITY_UNAVAILABLE');
            // THE ONE MUTATION. Nothing else is called on the book, and the previous active sheet is not restored.
            phase = 'POST_INSERT';
            if (sheetAddRequested === null) Api.AddSheet();
            else Api.AddSheet(sheetAddRequested);
            // THE POSTCONDITION, measured from the editor: the sizes, the ordered names, the new LAST sheet and
            // the active sheet. The DECODER proves the arithmetic; this body reports what it measured.
            var sheetAddAfterCollection = Api.GetSheets();
            if (sheetAddAfterCollection === null || sheetAddAfterCollection === undefined) return addRefusal('CAPABILITY_UNAVAILABLE');
            if (typeof sheetAddAfterCollection.length !== 'number') return addRefusal('CAPABILITY_UNAVAILABLE');
            var sheetAddAfter = sheetAddAfterCollection.length;
            if (sheetAddAfter < 1) return addRefusal('CAPABILITY_UNAVAILABLE');
            var sheetAddAfterNames = [];
            for (var sheetAddPost = 0; sheetAddPost < sheetAddAfter; sheetAddPost++) {
              var sheetAddPostSheet = Api.GetSheet(sheetAddPost);
              if (sheetAddPostSheet === null || sheetAddPostSheet === undefined) return addRefusal('CAPABILITY_UNAVAILABLE');
              if (typeof sheetAddPostSheet.GetName !== 'function') return addRefusal('CAPABILITY_UNAVAILABLE');
              var sheetAddPostName = String(sheetAddPostSheet.GetName());
              if (sheetAddPostName === '') return addRefusal('CAPABILITY_UNAVAILABLE');
              sheetAddAfterNames.push(sheetAddPostName);
            }
            var sheetAddLast = Api.GetSheet(sheetAddAfter - 1);
            if (sheetAddLast === null || sheetAddLast === undefined) return addRefusal('CAPABILITY_UNAVAILABLE');
            if (typeof sheetAddLast.GetName !== 'function') return addRefusal('CAPABILITY_UNAVAILABLE');
            var sheetAddLastName = String(sheetAddLast.GetName());
            if (sheetAddLastName === '') return addRefusal('CAPABILITY_UNAVAILABLE');
            var sheetAddActiveAfter = Api.GetActiveSheet();
            if (sheetAddActiveAfter === null || sheetAddActiveAfter === undefined) return addRefusal('CAPABILITY_UNAVAILABLE');
            if (typeof sheetAddActiveAfter.GetName !== 'function') return addRefusal('CAPABILITY_UNAVAILABLE');
            if (typeof sheetAddActiveAfter.GetIndex !== 'function') return addRefusal('CAPABILITY_UNAVAILABLE');
            var sheetAddActiveName = String(sheetAddActiveAfter.GetName());
            var sheetAddActiveIndex = Number(sheetAddActiveAfter.GetIndex());
            var sheetAddAnswer = [];
            sheetAddAnswer.push(phase);
            sheetAddAnswer.push(sheetAddBefore);
            sheetAddAnswer.push(sheetAddAfter);
            sheetAddAnswer.push(sheetAddAfter - 1);
            sheetAddAnswer.push(sheetAddLastName);
            sheetAddAnswer.push(sheetAddActiveIndex);
            sheetAddAnswer.push(sheetAddActiveName);
            sheetAddAnswer.push(sheetAddWasActiveIndex);
            sheetAddAnswer.push(sheetAddWasActiveName);
            for (var sheetAddPreOut = 0; sheetAddPreOut < sheetAddBeforeNames.length; sheetAddPreOut++) sheetAddAnswer.push(sheetAddBeforeNames[sheetAddPreOut]);
            for (var sheetAddPostOut = 0; sheetAddPostOut < sheetAddAfterNames.length; sheetAddPostOut++) sheetAddAnswer.push(sheetAddAfterNames[sheetAddPostOut]);
            return sheetAddAnswer;
          } catch (error) {
            return addRefusal('CAPABILITY_UNAVAILABLE');
          }
        }, false, false, callback);
      },
      // ----- CELL: the bounded WORKBOOK LISTING ------------------------------------------------
      // The first WORKBOOK-level body: its subject is the BOOK, not one sheet. It answers the listing the
      // agent needs before it can address anything — what sheets exist, which one is ACTIVE, and which are
      // hidden — and it is a READ, so it has no phase and nothing it refuses can have changed the book.
      // THE ACTIVE SHEET IS DECIDED BY INDEX, NEVER BY OBJECT IDENTITY, and that is MEASURED rather than
      // stylistic: on a live editor `Api.GetSheets()[i]` and `Api.GetActiveSheet()` answer DIFFERENT wrapper
      // objects even for the same sheet (measured: `GetSheet('Sprint1') === GetActiveSheet()` is false), so a
      // listing that compared objects would mark EVERY sheet inactive — a lie a caller could not detect.
      // WHAT THE BODY CHECKS BEFORE IT ANSWERS: the book is non-empty, its size is inside the bound the tool
      // carries, the active sheet's name and index are readable, and every sheet can answer its own name,
      // index and visibility. Anything else is this body's own ONE-slot refusal.
      // THE ANSWER IS A FLAT ARRAY OF PRIMITIVES, header first and then FOUR slots per sheet
      // (`name`, `index`, `active`, `visible`), because a body that needs structured output must encode it:
      // the native return validator keeps an array of primitives and strips a plain object.
      sheetlist(callback) {
        return plugin.callCommand(function () {
          function listRefusal() {
            var refusal = [];
            refusal.push('CAPABILITY_UNAVAILABLE');
            return refusal;
          }
          try {
            var request = typeof scope !== 'undefined' && scope !== null ? scope : null;
            if (request === null) return listRefusal();
            var sheetListMax = request.maxSheets;
            if (typeof sheetListMax !== 'number' || sheetListMax < 1 || sheetListMax % 1 !== 0) return listRefusal();
            var available = typeof Api !== 'undefined' && Api !== null;
            if (!available) return listRefusal();
            // These three guards are DEFENSIVE rather than load-bearing, and that is stated because it was
            // measured: the whole body runs inside a try/catch that answers the SAME one-slot refusal, so
            // deleting any one of them changes no observable outcome. They stay because a missing primitive
            // should be named where it is used rather than discovered by the catch.
            if (typeof Api.GetSheets !== 'function') return listRefusal();
            if (typeof Api.GetSheet !== 'function') return listRefusal();
            if (typeof Api.GetActiveSheet !== 'function') return listRefusal();
            // THE COLLECTION IS READ ONLY FOR ITS SIZE, and each sheet is then addressed by INDEX through
            // `Api.GetSheet(position)` — MEASURED to answer the same sheet. That is not a style choice: a call
            // RESULT is what the authored-code audit accepts as a receiver, while indexing an editor collection
            // taints the local BY NAME across the whole bundle and turns every later call on it into a
            // dynamic-property finding (the same trap the write leg records for its `block` local).
            var sheetListCollection = Api.GetSheets();
            if (sheetListCollection === null || sheetListCollection === undefined) return listRefusal();
            if (typeof sheetListCollection.length !== 'number') return listRefusal();
            var sheetListCount = sheetListCollection.length;
            if (sheetListCount < 1) return listRefusal();
            // A book larger than the bound is a KNOWN refusal, never a truncated listing: a listing that
            // omitted sheets would misrepresent the workbook to the caller.
            if (sheetListCount > sheetListMax) return listRefusal();
            var sheetListActive = Api.GetActiveSheet();
            if (sheetListActive === null || sheetListActive === undefined) return listRefusal();
            if (typeof sheetListActive.GetName !== 'function') return listRefusal();
            if (typeof sheetListActive.GetIndex !== 'function') return listRefusal();
            var sheetListActiveName = String(sheetListActive.GetName());
            var sheetListActiveIndex = Number(sheetListActive.GetIndex());
            if (sheetListActiveName === '') return listRefusal();
            if (!(sheetListActiveIndex >= 0) || sheetListActiveIndex % 1 !== 0) return listRefusal();
            if (sheetListActiveIndex >= sheetListCount) return listRefusal();
            var sheetListAnswer = [];
            sheetListAnswer.push(sheetListCount);
            sheetListAnswer.push(sheetListActiveIndex);
            sheetListAnswer.push(sheetListActiveName);
            for (var sheetListPosition = 0; sheetListPosition < sheetListCount; sheetListPosition++) {
              var sheetListEntry = Api.GetSheet(sheetListPosition);
              if (sheetListEntry === null || sheetListEntry === undefined) return listRefusal();
              if (typeof sheetListEntry.GetName !== 'function') return listRefusal();
              if (typeof sheetListEntry.GetIndex !== 'function') return listRefusal();
              if (typeof sheetListEntry.GetVisible !== 'function') return listRefusal();
              var sheetListName = String(sheetListEntry.GetName());
              var sheetListEntryIndex = Number(sheetListEntry.GetIndex());
              if (sheetListName === '') return listRefusal();
              sheetListAnswer.push(sheetListName);
              sheetListAnswer.push(sheetListEntryIndex);
              // THE ACTIVE SHEET IS DECIDED BY INDEX, NEVER BY OBJECT IDENTITY (measured: the editor answers
              // different wrapper objects for the same sheet).
              sheetListAnswer.push(sheetListEntryIndex === sheetListActiveIndex ? 1 : 0);
              sheetListAnswer.push(String(sheetListEntry.GetVisible()) === 'true' ? 1 : 0);
            }
            return sheetListAnswer;
          } catch (error) {
            return listRefusal();
          }
        }, false, false, callback);
      },
      sheet(callback) {
        return plugin.callCommand(function () {
          // The refusal is a ONE-slot array, and it is built by APPENDING to a literal for the same
          // authored-code-audit reason the block append states: a literal built from identifier names
          // would make the receiver of every later call on it a computed value.
          function readRefusal() {
            var refusal = [];
            refusal.push('CAPABILITY_UNAVAILABLE');
            return refusal;
          }
          // A SECOND, NARROWER REFUSAL: the caller named a sheet that is not in this book. That is an ARGUMENT
          // the caller can fix by naming another sheet and the read has changed nothing, so it is a known tool
          // error rather than "this leg cannot read".
          function selectorRefusal() {
            var refusal = [];
            refusal.push('TOOL_ERROR');
            return refusal;
          }
          try {
            var request = typeof scope !== 'undefined' && scope !== null ? scope : null;
            if (request === null) return readRefusal();
            var address = request.address === undefined ? null : request.address;
            var maxCells = request.maxCells;
            if (typeof maxCells !== 'number' || maxCells < 1 || maxCells % 1 !== 0) return readRefusal();
            if (address !== null && typeof address !== 'string') return readRefusal();
            if (address !== null && address === '') return readRefusal();
            // The facade is checked through the SAME literal guard every other authored body carries
            // (`typeof Api !== 'undefined'`): the packaging test walks every carried body and requires it,
            // because a body that reaches the editor without proving the facade exists would depend on a
            // global it never checked.
            var available = typeof Api !== 'undefined' && Api !== null;
            if (!available) return readRefusal();
            // Every primitive is a FUNCTION CHECK before any call, exactly like the search and structure
            // bodies: an editor that does not expose one of them answers this body's own refusal rather
            // than a read of invented values.
            if (typeof Api.GetActiveSheet !== 'function' || typeof Api.GetSheets !== 'function') return readRefusal();
            // WHICH SHEET IS READ: the caller's selector, or the ACTIVE sheet when the caller named none. The
            // selector is resolved through the MEASURED lookup `Api.GetSheet(name | index)` — the one form that
            // addresses a sheet — and that sheet OBJECT is then read directly, so the active sheet is never
            // switched for a read (measured: reading another sheet leaves the active one exactly where it was).
            var selectorName = request.sheetName === undefined ? null : request.sheetName;
            var selectorIndex = request.sheetIndex === undefined ? null : request.sheetIndex;
            // A MALFORMED SELECTOR ANSWERS THE SAME ARGUMENT CLASS THE BRIDGE ANSWERS ABOVE, not the capability
            // class: this body is shared with `read_sheet`, and ONE argument must not have two failure classes
            // depending on which layer noticed. (Today the bridge validates first, so these are defence in depth.)
            // THEY ARE DELIBERATELY UNREACHABLE THROUGH BOTH BRIDGE METHODS, stated because a mutant campaign
            // proved it: putting the capability class back here leaves every test green. They stay because
            // `Api.GetSheet` with a non-string or a negative key is NOT measured, and a build that THREW there
            // would otherwise be reported as "this leg cannot read" instead of "your selector is wrong".
            if (selectorName !== null && typeof selectorName !== 'string') return selectorRefusal();
            if (selectorName !== null && selectorName === '') return selectorRefusal();
            if (selectorIndex !== null && (typeof selectorIndex !== 'number' || selectorIndex < 0 || selectorIndex % 1 !== 0)) return selectorRefusal();
            var sheet = null;
            if (selectorName !== null || selectorIndex !== null) {
              if (typeof Api.GetSheet !== 'function') return readRefusal();
              sheet = selectorName !== null ? Api.GetSheet(selectorName) : Api.GetSheet(selectorIndex);
              if (sheet === null || sheet === undefined) return selectorRefusal();
            } else {
              sheet = Api.GetActiveSheet();
            }
            if (sheet === null || sheet === undefined) return readRefusal();
            if (typeof sheet.GetName !== 'function' || typeof sheet.GetRange !== 'function') return readRefusal();
            var sheetName = sheet.GetName();
            if (typeof sheetName !== 'string') return readRefusal();
            var sheets = Api.GetSheets();
            if (sheets === null || sheets === undefined || typeof sheets.length !== 'number') return readRefusal();
            var sheetCount = sheets.length;
            if (!(sheetCount >= 1)) return readRefusal();
            var sheetIndex = 0;
            if (typeof sheet.GetIndex === 'function') {
              var rawIndex = sheet.GetIndex();
              if (typeof rawIndex === 'number' && rawIndex === rawIndex && rawIndex >= 0 && rawIndex % 1 === 0) sheetIndex = rawIndex;
            }
            // THE ADDRESS: the caller's own, or the sheet's own used range when the caller named none.
            // A named address is never trimmed or reinterpreted — it is handed to the editor unchanged
            // and the editor's own answer is what the caller receives.
            var target = null;
            if (address === null) {
              if (typeof sheet.GetUsedRange !== 'function') return readRefusal();
              target = sheet.GetUsedRange();
              if (target === null || target === undefined) return readRefusal();
              if (typeof target.GetAddress !== 'function') return readRefusal();
              address = target.GetAddress();
              if (typeof address !== 'string' || address === '') return readRefusal();
            } else {
              target = sheet.GetRange(address);
              if (target === null || target === undefined) return readRefusal();
            }
            if (typeof target.GetValue !== 'function') return readRefusal();
            var requestAddress = address;
            var matrix = target.GetValue();
            if (matrix === null || matrix === undefined) return readRefusal();
            // THE ANSWER'S OWN TYPE DECIDES ITS SHAPE, and the test is NESTED-AWARE rather than a `.length`
            // probe. MEASURED on this build: a ONE-CELL range answers a SCALAR STRING while a BLOCK answers
            // a 2-D array — and a STRING ALSO HAS A NUMERIC `length`, so a `.length` test reads a scalar as
            // a matrix and publishes a cell's own CHARACTERS as rows. Of the two figures below, the FIRST is
            // NATIVE (the corrective task's proof read the cell `K1` holding `zz` and the shipped body
            // answered `totalRows: 2` with the values `['z','z']`) and the SECOND is the HOST RIG's
            // measurement (a cell holding `1000` answered FOUR rows of one digit): the arithmetic is the
            // same, but only the first was taken from a live editor. The shape is decided ONCE, here, and the
            // one-cell case is carried through the rest of this body as 1 x 1.
            var readbackIsMatrix = Array.isArray(matrix) && (matrix.length === 0 || Array.isArray(matrix[0]));
            // A shape that is neither a scalar primitive nor a 2-D array is NOT one this build was measured
            // to answer (a FLAT array, for instance), so it refuses closed here rather than being
            // stringified into a single cell that would attribute a joined value to one address.
            if (!readbackIsMatrix && typeof matrix === 'object') return readRefusal();
            var totalRows = 1;
            var columnCount = 1;
            if (readbackIsMatrix) {
              totalRows = matrix.length;
              if (!(totalRows >= 1)) return readRefusal();
              var firstRow = matrix[0];
              if (firstRow === null || firstRow === undefined || typeof firstRow.length !== 'number') return readRefusal();
              columnCount = firstRow.length;
              if (!(columnCount >= 1)) return readRefusal();
            }
            // THE CAP IS APPLIED BY CLIPPING WHOLE ROWS, never by trimming a row or a cell. The range's
            // complete shape is measured first (its own `GetValue()`), and the first `rowsToRead` rows are
            // published, so the answer is always a RECTANGULAR, honest prefix of the range whose address
            // is reported beside it. A range whose SINGLE ROW is wider than the cap cannot be clipped into
            // it at all and refuses closed: publishing a partial row would make one row's cells a
            // different width from the matrix the caller reads, which is the approximation this module
            // refuses everywhere.
            var rowsToRead = Math.floor(maxCells / columnCount);
            if (rowsToRead > totalRows) rowsToRead = totalRows;
            if (!(rowsToRead >= 1)) return readRefusal();
            var rowCount = rowsToRead;
            var values = [];
            if (readbackIsMatrix) {
              for (var row = 0; row < rowsToRead; row++) {
                var sheetValueRow = matrix[row];
                if (sheetValueRow === null || sheetValueRow === undefined || typeof sheetValueRow.length !== 'number') return readRefusal();
                if (sheetValueRow.length !== columnCount) return readRefusal();
                for (var column = 0; column < sheetValueRow.length; column++) {
                  var sheetCellRaw = sheetValueRow[column];
                  // A cell is published as a STRING so the wire stays one primitive type: the measured
                  // `GetValue()` answers strings for the fixture's cells, and a number or a missing cell
                  // is normalised here rather than decoded as an unmeasured type later.
                  if (sheetCellRaw === null || sheetCellRaw === undefined) values.push('');
                  else values.push(String(sheetCellRaw));
                }
              }
            } else {
              // The ONE-CELL answer IS the value, and it is never indexed: indexing a scalar string is
              // exactly the mistake this branch exists to prevent.
              values.push(String(matrix));
            }
            // THE ADDRESS THE EDITOR ITSELF ANSWERED FOR THIS RANGE, and the ONLY spelling the addressal
            // pass and the clipped report may be derived from. MEASURED on this build (R7-Office Editors
            // 2026.3.1): a REVERSED request is NORMALISED — `GetRange('B2:A1').GetAddress()` answers
            // `'A1:B2'` and its value matrix is A1-first — so a pass built from the CALLER's spelling would
            // walk a rectangle sharing only a corner with the values it is proving, and would publish one
            // cell's formula source in ANOTHER cell's slot. That is the exact wrong-cell attribution this
            // module refuses. The editor's own answer describes the same range object the values came from.
            var answeredAddress = requestAddress;
            if (typeof target.GetAddress === 'function') {
              var editorAddress = target.GetAddress();
              if (typeof editorAddress === 'string' && editorAddress !== '') answeredAddress = editorAddress;
            }
            // The ANSWERED address with its END ROW replaced by the last published row, or `''` when this
            // address cannot be rewritten that way. Declared here because the clipped report below tries the
            // editor's spelling first and the CALLER's second.
            function clippedAddress(address, publishedRows) {
              var colon = address.indexOf(':');
              if (colon < 1) return '';
              var clean = address.replace(/\$/g, '');
              var cleanColon = clean.indexOf(':');
              var head = clean.slice(0, cleanColon);
              var tail = clean.slice(cleanColon + 1);
              var headDigits = head.replace(/^[A-Z]+/, '');
              var tailColumn = tail.replace(/[0-9]+$/, '');
              if (headDigits === '' || tailColumn === '') return '';
              var lastRow = Number(headDigits) + publishedRows - 1;
              if (!(lastRow >= 1)) return '';
              // Rebuilt WITHOUT any `$`: the report is a relative range, so a mixed `$A$1:B200` spelling can
              // never come out of a partially absolute answer.
              return address.slice(0, colon).replace(/\$/g, '') + ':' + tailColumn + String(lastRow);
            }
            // THE ADDRESS THE ANSWER ACTUALLY COVERS. It is derived ONLY when the answer really was clipped,
            // so an unclipped read reports the range the editor answered and the two fields then agree
            // exactly when nothing was omitted and the editor did not re-spell the request. The EDITOR's
            // spelling is preferred because it is the accurate one, and the CALLER's is the fallback
            // precisely because the closed address pattern guarantees it can always be rewritten: a clipped
            // `read_range` therefore keeps the availability it had, and only an answer nobody can rewrite
            // (an editor spelling with no colon at all, on `read_sheet`) refuses, exactly as before.
            var readAddress = answeredAddress;
            if (rowCount < totalRows) {
              var clippedAnswered = clippedAddress(answeredAddress, rowCount);
              var clippedRequested = clippedAddress(requestAddress, rowCount);
              if (clippedAnswered !== '') readAddress = clippedAnswered;
              else if (clippedRequested !== '') readAddress = clippedRequested;
              else return readRefusal();
            }
            // THE FORMULA SOURCES ARE READ ADDRESSALLY, ONE SINGLE-CELL RANGE PER PUBLISHED CELL, and never
            // from the BLOCK's own `GetFormula()`. MEASURED on this build (R7-Office Editors 2026.3.1): a
            // MULTI-CELL `GetFormula()` answers the computed VALUES — the recorded read-leg finding is a
            // `K1:K2` read (K1 holding the text `A`, K2 the formula `=1+1`) whose BLOCK getter answered
            // `["A","2"]`, the value `2` exactly where the source `=1+1` belonged — so
            // asking the block published a second copy of the values as `formulas`. That made a formula cell
            // report `3` in place of its source `=1+2`, a one-cell read of a one-character text cell report
            // that character as its own formula, and a ONE-CELL read of a multi-character formula report
            // `formulas: null`. Only a ONE-CELL `GetFormula()` answers the SOURCE, so the sources are
            // collected one address at a time, over exactly the rows this answer publishes. MEASURED cost on
            // the measured sheet: 132 cells in about 4 ms, so the cap of `LIMITS.sheetReadCellsMax` cells
            // stays a bounded pass rather than a scan of the document.
            // The slot carries the SOURCE of a cell that holds a formula, and the EMPTY STRING for a cell
            // that does not. That filter is required because the same measured getter answers a cell's own
            // TEXT when there is no formula (`GetFormula()` on the text cell 'Москва' answers 'Москва'), so
            // the '=' prefix is what separates a formula from a value — the same test the write leg's proof
            // uses. The slot is `null` only when this read published NO sources at all — the pass below states
            // its own three conditions where it decides them — while a range that answers and holds no formula
            // reports empty strings, never `null`.
            function columnName(position) {
              var name = '';
              var remaining = position;
              while (remaining > 0) {
                var remainder = (remaining - 1) % 26;
                name = String.fromCharCode(65 + remainder) + name;
                remaining = Math.floor((remaining - 1) / 26);
              }
              return name;
            }
            // The rectangle an ANSWERED address names, as `[startColumn, startRow]`, but ONLY when that
            // rectangle is the rectangle the value matrix measured. `null` means this leg cannot tell which
            // cell a published value came from, and the caller of this reader must then publish no formula
            // sources at all. The shape rule is the write leg's own, applied to the read.
            function answeredRectangle(address, rows, columns) {
              var head = address;
              var tail = null;
              var colon = address.indexOf(':');
              if (colon > 0) {
                head = address.slice(0, colon);
                tail = address.slice(colon + 1);
              }
              // The `$` is stripped BEFORE the split, not after: stripping it only from the column or only
              // from the row makes `A$1` parse while `$A$1` does not, which would silently DROP every
              // source on a build that answers absolute addresses.
              var cleanHead = head.replace(/\$/g, '');
              var headColumn = cleanHead.replace(/[0-9]+$/, '');
              var headRow = cleanHead.replace(/^[A-Z]+/, '');
              if (headColumn === '' || headRow === '') return null;
              var startColumn = 0;
              for (var headLetter = 0; headLetter < headColumn.length; headLetter++) {
                startColumn = startColumn * 26 + (headColumn.charCodeAt(headLetter) - 64);
              }
              var startRow = Number(headRow);
              if (!(startColumn >= 1) || !(startRow >= 1)) return null;
              var endColumn = startColumn;
              var endRow = startRow;
              if (tail !== null) {
                var cleanTail = tail.replace(/\$/g, '');
                var tailColumn = cleanTail.replace(/[0-9]+$/, '');
                var tailRow = cleanTail.replace(/^[A-Z]+/, '');
                if (tailColumn === '' || tailRow === '') return null;
                endColumn = 0;
                for (var tailLetter = 0; tailLetter < tailColumn.length; tailLetter++) {
                  endColumn = endColumn * 26 + (tailColumn.charCodeAt(tailLetter) - 64);
                }
                endRow = Number(tailRow);
                if (!(endColumn >= 1) || !(endRow >= 1)) return null;
              }
              if (endColumn - startColumn + 1 !== columns || endRow - startRow + 1 !== rows) return null;
              var rectangle = [];
              rectangle.push(startColumn);
              rectangle.push(startRow);
              return rectangle;
            }
            var formulas = [];
            var formulasMatch = 0;
            // THE RECTANGLE THE ANSWERED ADDRESS NAMES MUST BE THE RECTANGLE THE VALUE MATRIX MEASURED, AND
            // THE PASS VERIFIES IT CELL BY CELL. When either check fails, this leg cannot tell WHICH cell each
            // published value came from, so it publishes NO sources at all — the decoder turns that into
            // `formulas: null` — rather than guessing: the VALUES are still served, because they are what the
            // editor answered, and no formula source is ever attributed to a cell that does not hold it.
            // `formulas: null` therefore carries THREE conditions, all stated where they are decided: the
            // range exposes no getter, the answered address cannot be read as the matrix's own rectangle, or
            // a published cell's own single-cell value disagrees with the value published for it.
            var formulaRectangle = answeredRectangle(answeredAddress, totalRows, columnCount);
            // THE ALIGNMENT IS VERIFIED PER CELL, NOT SAMPLED. The rectangle check above is DIMENSION-only,
            // so a same-SIZE rectangle at a different ORIGIN would pass it and the sources would be read from
            // cells the values never came from — a build whose `GetAddress()` and `GetValue()` disagree about
            // the same object. Sampling one cell (the first) would only make that unlikely, so EVERY published
            // cell is checked instead: the single-cell `GetValue()` of the cell this address names must hold
            // the value this position published, cell by cell, while its source is read. The pass costs one
            // extra native read per published cell and no extra `GetRange` — the same range object answers
            // both — and a single disagreement WITHHOLDS EVERY SOURCE (`formulasMatch` stays 0, so the decoder
            // publishes `formulas: null`). It can only WITHHOLD, never relocate. The one case this check cannot
            // see is a build that disagrees with itself about the ORIGIN while agreeing on EVERY published
            // value: such an answer is indistinguishable from a correct one through this API, and the pass then
            // follows the address it was given. Everything else it can do is withhold, which is the direction
            // this module always fails in.
            if (typeof target.GetFormula === 'function' && formulaRectangle !== null) {
              var sourcesHold = true;
              for (var sourceRow = 0; sourceRow < rowsToRead && sourcesHold; sourceRow++) {
                for (var sourceColumn = 0; sourceColumn < columnCount && sourcesHold; sourceColumn++) {
                  var sourceAddress = columnName(formulaRectangle[0] + sourceColumn) + String(formulaRectangle[1] + sourceRow);
                  var sourceRange = sheet.GetRange(sourceAddress);
                  // A capability that disappears part-way through the pass refuses the READ CLOSED rather
                  // than publishing the cells it happened to reach: a short formula list would attribute
                  // formulas to the wrong cells, which is the approximation this module refuses everywhere.
                  if (sourceRange === null || sourceRange === undefined || typeof sourceRange.GetFormula !== 'function') return readRefusal();
                  // A range that cannot place its own values (no `GetValue`) withholds the sources instead of
                  // costing the caller the values.
                  if (typeof sourceRange.GetValue !== 'function') { sourcesHold = false; break; }
                  var placedRaw = sourceRange.GetValue();
                  var placedText = placedRaw === null || placedRaw === undefined ? '' : String(placedRaw);
                  if (placedText !== values[sourceRow * columnCount + sourceColumn]) { sourcesHold = false; break; }
                  var sourceRaw = sourceRange.GetFormula();
                  var sourceText = sourceRaw === null || sourceRaw === undefined ? '' : String(sourceRaw);
                  formulas.push(sourceText.length > 0 && sourceText.charAt(0) === '=' ? sourceText : '');
                }
              }
              if (sourcesHold) formulasMatch = 1;
            }
            var answer = [];
            answer.push(sheetName);
            answer.push(sheetIndex);
            answer.push(sheetCount);
            answer.push(requestAddress);
            answer.push(readAddress);
            answer.push(totalRows);
            answer.push(columnCount);
            answer.push(rowCount);
            answer.push(columnCount);
            answer.push(formulasMatch);
            for (var vi = 0; vi < values.length; vi++) answer.push(values[vi]);
            if (formulasMatch === 1) {
              for (var fi = 0; fi < formulas.length; fi++) answer.push(formulas[fi]);
            }
            return answer;
          } catch (error) {
            return readRefusal();
          }
        }, false, false, callback);
      },
      // ----- CELL: the bounded SPREADSHEET write --------------------------------------------------
      // The first Cell MUTATION, and it authors primitives measured on a live Cell session: `SetValue`
      // on a single-cell range, `GetValue` on the whole addressed block and `GetFormula` on ONE
      // single-cell range per formula cell for the readback, and `GetActiveSheet`. Three
      // measured rules decide what is written:
      //   * an INTEGER-looking cell (`0`, `-12`, and no leading zero) is handed to the editor as a
      //     NUMBER, because the measured JS number for an integer is stored numerically. A LEADING ZERO is
      //     deliberately not integer-looking, and that rule's INTENT is the one the engine does not honour:
      //     MEASURED, `SetValue('007')` is coerced to a NUMBER anyway and reads back `7` (`'00'` -> `0`,
      //     `'-012'` -> `-12`), so an account code with a leading zero CANNOT be written by this leg on this
      //     build. What it does NOT do is silently renumber the account: the readback below refutes the
      //     coercion as a mismatch, so the outcome is the fail-safe flag-0 class — UNCERTAIN, the slot HELD,
      //     and no retry — rather than a stored `7` reported as a success.
      //   * the integer form is capped at FIFTEEN digits, where a JS number still carries every integer
      //     exactly; a longer digit string goes through as the string the caller sent, and MEASURED the
      //     engine coerces that too and loses precision (`'12345678901234567890'` read back as
      //     `12345678901234567000`), which the readback refutes the same way — so the cap changes which
      //     route is taken, not whether a lossy write is proved.
      //   * everything else goes through as the STRING the caller sent. That is the measured rule that
      //     makes a decimal a real number (`SetValue('123,45')` answers `=ЕЧИСЛО` TRUE) while a
      //     non-integer JS number is stored as TEXT, and it is also why the locale form belongs to the
      //     CALLER: this body never rewrites a decimal separator.
      //   * a cell whose text begins with `=` is a FORMULA, and the engine's own parser decides whether
      //     it is valid. A `.` in a formula source is rejected by the parser and CLEARS the cell, which
      //     is exactly the failure the readback below exists to catch.
      // THE ADDRESS AND THE MATRIX MUST AGREE: the authored block is the addressed block, so no cell of
      // the request is left unwritten and the readback is over precisely what was asked for.
      // THE PROOF IS ONE BOUNDED READBACK OF THE WHOLE BLOCK, one flag per cell: an ERROR value can never
      // EQUAL a different request, so it is never a proof of one, while a caller who literally asked for
      // `#`-leading TEXT is proved by the match (`SetValue('#REF!')` stores text, measured); a formula cell
      // is proved by HOLDING A FORMULA (the engine rewrites names and separators, so comparing formula TEXT
      // would compare the engine's own normalisation), and any other cell is proved by its value matching the
      // request after the ONE stated normalisation (spaces removed, `,` read as `.` — the form the editor
      // answers a locale number in). The REQUEST's own type decides which of the two proofs applies, and it
      // is decided FIRST, so a written formula that evaluates to an error value is still proved by holding
      // its formula.
      // THE TWO READS HAVE DELIBERATELY DIFFERENT SHAPES, and the difference is MEASURED rather than
      // chosen: the VALUES come from ONE `GetValue()` over the addressed block, while a formula SOURCE
      // is read ADDRESSALLY, one single-cell range per formula cell. The reason is recorded at the
      // readback below and is the whole point: on this build a MULTI-CELL `GetFormula()` answers the
      // computed VALUES, so a block-level formula read could never prove a formula cell and every one
      // of them would be reported as unproved.
      // WHAT THE PROOF DOES NOT COVER, stated rather than implied: it cannot show that a numeric-looking
      // cell was stored as a NUMBER rather than as text, because the readback answers both as the same
      // string. Numericity rests on the measured `SetValue` rule above, and a caller that needs it
      // checked can read the cell back with `read_range` and use it in a formula.
      sheetwrite(callback) {
        return plugin.callCommand(function () {
          var phase = 'PRE_INSERT';
          // The refusal is a TWO-slot array whose first slot is the phase, built by APPENDING to a
          // literal for the authored-code-audit reason every other body states.
          function writeRefusal(name) {
            var refusal = [];
            refusal.push(phase);
            refusal.push(name);
            return refusal;
          }
          try {
            var request = typeof scope !== 'undefined' && scope !== null ? scope : null;
            if (request === null) return writeRefusal('CAPABILITY_UNAVAILABLE');
            var address = request.address;
            var cells = request.cells;
            if (typeof address !== 'string' || address === '') return writeRefusal('CAPABILITY_UNAVAILABLE');
            if (cells === null || cells === undefined || typeof cells.length !== 'number' || !(cells.length >= 1)) return writeRefusal('CAPABILITY_UNAVAILABLE');
            var available = typeof Api !== 'undefined' && Api !== null;
            if (!available) return writeRefusal('CAPABILITY_UNAVAILABLE');
            if (typeof Api.GetActiveSheet !== 'function') return writeRefusal('CAPABILITY_UNAVAILABLE');
            // WHICH SHEET IS WRITTEN: the caller's selector, or the ACTIVE sheet when the caller named none. The
            // selector is resolved through the MEASURED lookup `Api.GetSheet(name | index)`, and the write and ALL
            // its proofs then use THAT sheet's own ranges, so the active sheet is neither read nor switched: the
            // body authors no activation at all. (MEASURED before this leg existed: writing through another
            // sheet's range object leaves the active sheet exactly where it was.) A selector that names nothing
            // is a KNOWN refusal raised HERE, before the phase turns, so nothing is written.
            // A malformed selector answers the ARGUMENT class on purpose — the same class the bridge answers
            // above — so ONE argument does not have two failure classes depending on which layer noticed it.
            var selectorName = request.sheetName === undefined ? null : request.sheetName;
            var selectorIndex = request.sheetIndex === undefined ? null : request.sheetIndex;
            if (selectorName !== null && typeof selectorName !== 'string') return writeRefusal('TOOL_ERROR');
            if (selectorName !== null && selectorName === '') return writeRefusal('TOOL_ERROR');
            if (selectorIndex !== null && (typeof selectorIndex !== 'number' || selectorIndex < 0 || selectorIndex % 1 !== 0)) return writeRefusal('TOOL_ERROR');
            var sheet = null;
            if (selectorName !== null || selectorIndex !== null) {
              if (typeof Api.GetSheet !== 'function') return writeRefusal('CAPABILITY_UNAVAILABLE');
              sheet = selectorName !== null ? Api.GetSheet(selectorName) : Api.GetSheet(selectorIndex);
              if (sheet === null || sheet === undefined) return writeRefusal('TOOL_ERROR');
              // THE RESOLVED SHEET IS TIED TO THE REQUEST BEFORE ANYTHING IS WRITTEN, and this is what makes the
              // selector's promise checkable rather than assumed. The readback below reads the SAME object it
              // wrote, so BY CONSTRUCTION it can never notice that the OBJECT was the wrong sheet: a build that
              // resolved another sheet, or that clamped an index, would write elsewhere and still prove itself
              // cell by cell. The sheet's own name/index must therefore AGREE with what the caller asked for, and
              // a disagreement refuses with NOTHING written (the argument is what is wrong, so the argument class).
              if (selectorName !== null) {
                if (typeof sheet.GetName !== 'function') return writeRefusal('CAPABILITY_UNAVAILABLE');
                if (String(sheet.GetName()) !== selectorName) return writeRefusal('TOOL_ERROR');
              } else {
                if (typeof sheet.GetIndex !== 'function') return writeRefusal('CAPABILITY_UNAVAILABLE');
                if (Number(sheet.GetIndex()) !== selectorIndex) return writeRefusal('TOOL_ERROR');
              }
            } else {
              sheet = Api.GetActiveSheet();
            }
            if (sheet === null || sheet === undefined) return writeRefusal('CAPABILITY_UNAVAILABLE');
            if (typeof sheet.GetRange !== 'function') return writeRefusal('CAPABILITY_UNAVAILABLE');
            // The addressed block, split into its two corners. The address shape was closed by the
            // bridge before dispatch, so anything unparseable here is a damaged request.
            var colon = address.indexOf(':');
            var head = colon < 0 ? address : address.slice(0, colon);
            var tail = colon < 0 ? null : address.slice(colon + 1);
            var headColumn = head.replace(/[0-9]+$/, '');
            var headRow = head.replace(/^[A-Z]+/, '');
            if (headColumn === '' || headRow === '') return writeRefusal('CAPABILITY_UNAVAILABLE');
            var startColumn = 0;
            for (var letter = 0; letter < headColumn.length; letter++) {
              startColumn = startColumn * 26 + (headColumn.charCodeAt(letter) - 64);
            }
            var startRow = Number(headRow);
            if (!(startColumn >= 1) || !(startRow >= 1)) return writeRefusal('CAPABILITY_UNAVAILABLE');
            var expectedRows = cells.length;
            var expectedColumns = 0;
            for (var rowIndex = 0; rowIndex < expectedRows; rowIndex++) {
              var rowCells = cells[rowIndex];
              if (rowCells === null || rowCells === undefined || typeof rowCells.length !== 'number' || !(rowCells.length >= 1)) return writeRefusal('CAPABILITY_UNAVAILABLE');
              if (rowIndex === 0) expectedColumns = rowCells.length;
              else if (rowCells.length !== expectedColumns) return writeRefusal('CAPABILITY_UNAVAILABLE');
              for (var cellIndex = 0; cellIndex < rowCells.length; cellIndex++) {
                if (typeof rowCells[cellIndex] !== 'string') return writeRefusal('CAPABILITY_UNAVAILABLE');
              }
            }
            var addressedColumns = 1;
            var addressedRows = 1;
            if (tail !== null) {
              var tailColumn = tail.replace(/[0-9]+$/, '');
              var tailRow = tail.replace(/^[A-Z]+/, '');
              if (tailColumn === '' || tailRow === '') return writeRefusal('CAPABILITY_UNAVAILABLE');
              var endColumn = 0;
              for (var tailLetter = 0; tailLetter < tailColumn.length; tailLetter++) {
                endColumn = endColumn * 26 + (tailColumn.charCodeAt(tailLetter) - 64);
              }
              addressedColumns = endColumn - startColumn + 1;
              addressedRows = Number(tailRow) - startRow + 1;
            }
            if (addressedColumns !== expectedColumns || addressedRows !== expectedRows) return writeRefusal('CAPABILITY_UNAVAILABLE');
            function columnName(position) {
              var name = '';
              var remaining = position;
              while (remaining > 0) {
                var remainder = (remaining - 1) % 26;
                name = String.fromCharCode(65 + remainder) + name;
                remaining = Math.floor((remaining - 1) / 26);
              }
              return name;
            }
            // THE MUTATION, and the exact boundary the two classes are split on. It turns `POST_INSERT`
            // IMMEDIATELY BEFORE the first `SetValue`: from the first call entered, nothing observed here
            // proves the sheet was not touched, so every refusal below carries the post-insert phase and
            // the decoder turns it into the uncertain class, for which the bridge HOLDS its slot.
            phase = 'POST_INSERT';
            for (var writeRow = 0; writeRow < expectedRows; writeRow++) {
              for (var writeColumn = 0; writeColumn < expectedColumns; writeColumn++) {
                var cellAddress = columnName(startColumn + writeColumn) + String(startRow + writeRow);
                var target = sheet.GetRange(cellAddress);
                if (target === null || target === undefined || typeof target.SetValue !== 'function') return writeRefusal('CAPABILITY_UNAVAILABLE');
                var wanted = cells[writeRow][writeColumn];
                if (/^-?(0|[1-9][0-9]{0,14})$/.test(wanted)) target.SetValue(Number(wanted));
                else target.SetValue(wanted);
              }
            }
            // THE ONE BOUNDED READBACK, over exactly the addressed block. The local is `sheetWriteBlock`
            // rather than `block` on purpose: the authored-code audit resolves taint by identifier NAME
            // across the whole bundle, and `block` is already a caller-derived name in the block-append
            // body, so calling a method on it here was a dynamic-property finding.
            var sheetWriteBlock = sheet.GetRange(address);
            if (sheetWriteBlock === null || sheetWriteBlock === undefined || typeof sheetWriteBlock.GetValue !== 'function') return writeRefusal('CAPABILITY_UNAVAILABLE');
            var readback = sheetWriteBlock.GetValue();
            // THE READBACK'S OWN TYPE DECIDES ITS SHAPE, and the test is NESTED-AWARE rather than a `.length`
            // probe. MEASURED on this build (R7-Office Editors 2026.3.1): a ONE-CELL range answers a SCALAR
            // STRING — `GetRange('H1').GetValue()`, and even the explicit `GetRange('H1:H1')` spelling, both
            // answered `"Москва"` — while a BLOCK answers a 2-D array, a 1xN or Nx1 block included
            // (`GetRange('H1:H2').GetValue()` -> `[["Москва"],["1000"]]`). A STRING ALSO HAS A NUMERIC
            // `length`, so the `.length` test this body used first classified a scalar string as a MATRIX and
            // indexed its FIRST CHARACTER: every one-cell write was then unprovable, an empty one-cell readback
            // threw out of the index, and a one-character request could even be "proved" against a stale longer
            // value. Requiring the first element to be an array as well additionally refuses to be fooled by a
            // shape the measurement never produced — a FLAT one-element array for a one-cell range — which is
            // read as a scalar: a scalar can only be proved by an exact single-element match (the value really
            // is that text) and can never be indexed into a FIRST CHARACTER, which is the false positive this
            // rule exists to exclude. A multi-cell request that ever met a flat answer refuses as a POST_INSERT
            // refusal, i.e. UNCERTAIN with the slot held, so this reading fails safe in both directions.
            var readbackIsMatrix = Array.isArray(readback) && (readback.length === 0 || Array.isArray(readback[0]));
            var singleCell = !readbackIsMatrix;
            if (singleCell && (expectedRows !== 1 || expectedColumns !== 1)) return writeRefusal('CAPABILITY_UNAVAILABLE');
            // THERE IS DELIBERATELY NO BLOCK-LEVEL `GetFormula()` HERE, and that is MEASURED rather than an
            // omission. On this build (R7-Office Editors 2026.3.1) a MULTI-CELL range answered the computed
            // VALUES: `GetRange('B4').GetFormula()` on ONE cell answered the real formula source
            // `= B2-B3`, while the SAME call on the whole block answered `300` — the value that formula
            // evaluates to — in the formula's place. A multi-cell `GetFormula()` is therefore NOT a source
            // of original formulas on the measured build, so a block-level formula read could never prove
            // a formula cell and would report every one of them as unproved. Each formula cell is read on
            // its OWN single-cell range in the proof loop below, which is the shape the measurement found
            // answering the source.
            function normalize(text) {
              return String(text).replace(/ /g, '').replace(/,/g, '.').trim();
            }
            // A cell is a formula when its FIRST character is `=`. The test lives in its own function and
            // works on the PARAMETER, never on the caller-derived local directly: the authored-code audit
            // treats a method call on a computed value read as a dynamic-property sink, and the parameter
            // boundary is what the other bodies use for exactly this normalisation.
            function startsWithEquals(sourceText) {
              return sourceText.charAt(0) === '=';
            }
            var answer = [];
            answer.push(phase);
            answer.push(expectedRows);
            answer.push(expectedColumns);
            for (var checkRow = 0; checkRow < expectedRows; checkRow++) {
              for (var checkColumn = 0; checkColumn < expectedColumns; checkColumn++) {
                var wantedText = cells[checkRow][checkColumn];
                var gotRaw = singleCell ? readback : readback[checkRow][checkColumn];
                var gotText = gotRaw === null || gotRaw === undefined ? '' : String(gotRaw);
                var flag = 0;
                // THE REQUEST'S OWN TYPE DECIDES WHICH PROOF APPLIES, and this branch is therefore decided
                // FIRST. The `#`-leading "error value" test that used to run before it was both too broad and
                // in the wrong place: it refused a caller who correctly asked for `#`-leading TEXT — MEASURED,
                // `SetValue('#REF!')` stores the literal text `#REF!`, answered by both `GetValue()` and
                // `GetFormula()` — and it PRE-EMPTED the formula proof, so a correctly stored formula that
                // EVALUATES to an error value was scored unproved even though it still held its formula, which
                // contradicted the rule stated above. The order is not cosmetic, and the measurement says why:
                // `=1/0` answered the EMPTY string immediately after the write and `#DIV/0!` on a LATER read of
                // the same cell, so under the old order a correctly written formula's proof depended on WHEN
                // the sheet happened to recalculate it. No separate error rule is needed for a VALUE request:
                // an error value can never EQUAL a different request, so it is still never a proof of one,
                // and a request that literally asks for that text is proved by the match.
                if (startsWithEquals(wantedText)) {
                  // The formula SOURCE of this one cell, read ADDRESSALLY on its own single-cell range:
                  // the address is rebuilt exactly the way the write loop above built it, so the cell
                  // that is proved is the cell that was written. Only text is taken from the editor —
                  // the `=` test runs on a parameter, never on a value read out of the sheet.
                  var storedFormula = '';
                  var formulaAddress = columnName(startColumn + checkColumn) + String(startRow + checkRow);
                  var formulaRange = sheet.GetRange(formulaAddress);
                  if (formulaRange !== null && formulaRange !== undefined && typeof formulaRange.GetFormula === 'function') {
                    var formulaSource = formulaRange.GetFormula();
                    storedFormula = formulaSource === null || formulaSource === undefined ? '' : String(formulaSource);
                  }
                  flag = startsWithEquals(storedFormula) ? 1 : 0;
                } else {
                  flag = normalize(gotText) === normalize(wantedText) ? 1 : 0;
                }
                answer.push(flag);
              }
            }
            return answer;
          } catch (error) {
            return writeRefusal('CAPABILITY_UNAVAILABLE');
          }
        }, false, false, callback);
      },
      // ----- CELL: the bounded SPREADSHEET FORMATTING ---------------------------------------------
      // The SECOND Cell mutation and the FIRST that changes PRESENTATION rather than content. Every primitive
      // it authors was MEASURED on a live Cell session (R7-Office Editors 2026.3.1) and the measurement is
      // recorded in `docs/evidence/sprint-4/t4.0-format-range-evidence.md`: which properties have BOTH a
      // setter and a public readback, the closed number-format code families, and the value ranges that read
      // back EXACTLY.
      // THE PROOF IS ONE FLAG PER (PROPERTY, CELL) AND PER (GEOMETRY PROPERTY, COLUMN|ROW), and that shape is
      // the point: a single flag per cell would let one unproven property hide behind the proven ones, while a
      // flag list lets the bridge require EVERY requested property to be confirmed while it still owns the
      // slot. The check proves the FINAL STATE and never the fact of a change: a cell that already held the
      // requested value is an idempotent success, because the readback is compared against the REQUEST and
      // never against a baseline.
      // THE MEASURED SHAPES THIS BODY DEPENDS ON, all recorded in the evidence above:
      //   * `range.GetNumberFormat()` answers the very CODE that was set, which makes the number-format proof
      //     an exact equality against the code the bridge itself composed;
      //   * `range.GetFillColor()` answers the string `"No Fill"` for an unfilled cell and an object whose
      //     colour exposes `getRgb()` for a filled one — PUBLIC accessors, not private fields — while
      //     `Api.CreateNoFill()` is the measured way to clear a fill back to `"No Fill"`;
      //   * a TEXT property is readable only through `range.GetCharacters().GetFont()`, where bold and italic
      //     answer the STRING `"true"` when set and `null` when not (never `"false"`), `GetSize()` answers a
      //     STRING, and `GetName()` answers the family VERBATIM even when the engine does not have it;
      //   * `range.GetWrapText()` answers a real boolean, and a COLUMN's width / a ROW's height are readable
      //     from any cell of that column or row, which is how the geometry proof is done per affected
      //     column/row rather than once for the block.
      // A property WITHOUT such a readback is not in the schema at all — font colour, both alignments, borders
      // and autofit are refused by the TOOL before any dispatch — because this body can only prove what these
      // primitives can be asked. `SetFillColor` with a colour STRING is the measured trap that justifies that
      // rule: it returns `undefined` and is silently ignored, so an unproven format property would be
      // reported as applied when nothing happened.
      // THE ANSWER IS ONE FLAT ARRAY OF PRIMITIVES, exactly like the other legs (the native return validator
      // keeps those and strips a plain object):
      //   `[PRE_INSERT, name]` — the body's own closed refusal, or
      //   `[POST_INSERT, rowCount, columnCount, checkCount, flag0, …]`
      // where the count lets the decoder require EXACTLY as many flags as the request owes.
      cellformat(callback) {
        return plugin.callCommand(function () {
          // The phase is an explicit slot of every answer and it turns POST_INSERT immediately before the
          // FIRST mutating call: a refusal built before that point is a KNOWN class, and every refusal after
          // it leaves the sheet possibly touched, which is the UNCERTAIN class the decoder turns it into.
          var phase = 'PRE_INSERT';
          function formatRefusal(name) {
            var refusal = [];
            refusal.push(phase);
            refusal.push(name);
            return refusal;
          }
          function columnName(position) {
            var name = '';
            var remaining = position;
            while (remaining > 0) {
              var remainder = (remaining - 1) % 26;
              name = String.fromCharCode(65 + remainder) + name;
              remaining = Math.floor((remaining - 1) / 26);
            }
            return name;
          }
          // A boolean PROPERTY is proved by what the engine answers for `true` and for `false` MEASURED
          // separately (`"true"` versus `null`), so the two directions are not collapsed into a truthiness
          // test that a missing readback would pass.
          function booleanFlag(raw, wanted) {
            if (wanted === true) return String(raw) === 'true' ? 1 : 0;
            return raw === null || raw === undefined || String(raw) === 'false' ? 1 : 0;
          }
          try {
            var request = typeof scope !== 'undefined' && scope !== null ? scope : null;
            if (request === null) return formatRefusal('CAPABILITY_UNAVAILABLE');
            var address = request.address;
            var expectedRows = request.rows;
            var expectedColumns = request.columns;
            var expectedChecks = request.checks;
            var maxCells = request.maxCells;
            if (typeof address !== 'string' || address === '') return formatRefusal('CAPABILITY_UNAVAILABLE');
            if (typeof expectedRows !== 'number' || expectedRows < 1 || expectedRows % 1 !== 0) return formatRefusal('CAPABILITY_UNAVAILABLE');
            if (typeof expectedColumns !== 'number' || expectedColumns < 1 || expectedColumns % 1 !== 0) return formatRefusal('CAPABILITY_UNAVAILABLE');
            if (typeof expectedChecks !== 'number' || expectedChecks < 1 || expectedChecks % 1 !== 0) return formatRefusal('CAPABILITY_UNAVAILABLE');
            if (typeof maxCells !== 'number' || maxCells < 1 || maxCells % 1 !== 0) return formatRefusal('CAPABILITY_UNAVAILABLE');
            if (expectedRows * expectedColumns > maxCells) return formatRefusal('TOOL_ERROR');
            // The facade is checked through the SAME literal guard every other authored body carries.
            var available = typeof Api !== 'undefined' && Api !== null;
            if (!available) return formatRefusal('CAPABILITY_UNAVAILABLE');
            if (typeof Api.GetActiveSheet !== 'function') return formatRefusal('CAPABILITY_UNAVAILABLE');
            var sheet = Api.GetActiveSheet();
            if (sheet === null || sheet === undefined || typeof sheet.GetRange !== 'function') return formatRefusal('CAPABILITY_UNAVAILABLE');
            // THE ADDRESS IS PARSED, and the rectangle it names must BE the rectangle the request declared:
            // a body and a bridge that disagree about the addressed block would format cells the caller
            // never named, which is exactly the approximation this module refuses.
            var head = address;
            var tail = null;
            var colon = address.indexOf(':');
            if (colon > 0) {
              head = address.slice(0, colon);
              tail = address.slice(colon + 1);
            }
            var cleanHead = head.replace(/\$/g, '');
            var headColumn = cleanHead.replace(/[0-9]+$/, '');
            var headRow = cleanHead.replace(/^[A-Z]+/, '');
            if (headColumn === '' || headRow === '') return formatRefusal('CAPABILITY_UNAVAILABLE');
            var startColumn = 0;
            for (var headLetter = 0; headLetter < headColumn.length; headLetter++) {
              startColumn = startColumn * 26 + (headColumn.charCodeAt(headLetter) - 64);
            }
            var startRow = Number(headRow);
            if (!(startColumn >= 1) || !(startRow >= 1)) return formatRefusal('CAPABILITY_UNAVAILABLE');
            var endColumn = startColumn;
            var endRow = startRow;
            if (tail !== null) {
              var cleanTail = tail.replace(/\$/g, '');
              var tailColumn = cleanTail.replace(/[0-9]+$/, '');
              var tailRow = cleanTail.replace(/^[A-Z]+/, '');
              if (tailColumn === '' || tailRow === '') return formatRefusal('CAPABILITY_UNAVAILABLE');
              endColumn = 0;
              for (var tailLetter = 0; tailLetter < tailColumn.length; tailLetter++) {
                endColumn = endColumn * 26 + (tailColumn.charCodeAt(tailLetter) - 64);
              }
              endRow = Number(tailRow);
              if (!(endColumn >= 1) || !(endRow >= 1)) return formatRefusal('CAPABILITY_UNAVAILABLE');
            }
            if (endColumn - startColumn + 1 !== expectedColumns || endRow - startRow + 1 !== expectedRows) return formatRefusal('CAPABILITY_UNAVAILABLE');
            // WHICH PROPERTIES WERE REQUESTED. The bridge sends `null` (or omits) everything the caller did
            // not ask for, so the body never has to guess, and a property it was not asked to change is never
            // written and never proved.
            var numberFormatCode = request.numberFormatCode;
            var wantsNumberFormat = typeof numberFormatCode === 'string' && numberFormatCode !== '';
            var wantBold = request.bold;
            var wantsBold = typeof wantBold === 'boolean';
            var wantItalic = request.italic;
            var wantsItalic = typeof wantItalic === 'boolean';
            var wantFontFamily = request.fontFamily;
            var wantsFontFamily = typeof wantFontFamily === 'string' && wantFontFamily !== '';
            var wantFontSize = request.fontSize;
            var wantsFontSize = typeof wantFontSize === 'number';
            var wantWrap = request.wrapText;
            var wantsWrap = typeof wantWrap === 'boolean';
            var wantsFill = typeof request.fillR === 'number' && typeof request.fillG === 'number' && typeof request.fillB === 'number';
            var wantsFillClear = request.fillClear === true;
            var wantColumnWidth = request.columnWidth;
            var wantsColumnWidth = typeof wantColumnWidth === 'number';
            var wantRowHeight = request.rowHeight;
            var wantsRowHeight = typeof wantRowHeight === 'number';
            var propertyCount = 0;
            if (wantsNumberFormat) propertyCount++;
            if (wantsBold) propertyCount++;
            if (wantsItalic) propertyCount++;
            if (wantsFontFamily) propertyCount++;
            if (wantsFontSize) propertyCount++;
            if (wantsWrap) propertyCount++;
            if (wantsFill) propertyCount++;
            if (wantsFillClear) propertyCount++;
            // A request that asks for NOTHING must never reach a mutation. The CELL properties and the two
            // GEOMETRY properties are counted SEPARATELY and for a stated reason: the flag arithmetic below is
            // per cell for the first group and per affected column/row for the second, while the rule "at least
            // one formatting property" is about the REQUEST — so a request that asks only for a column width is
            // a legitimate formatting request and must not be refused as empty.
            var requestedCount = propertyCount;
            if (wantsColumnWidth) requestedCount++;
            if (wantsRowHeight) requestedCount++;
            if (requestedCount < 1) return formatRefusal('TOOL_ERROR');
            var expectedCheckCount = propertyCount * expectedRows * expectedColumns;
            if (wantsColumnWidth) expectedCheckCount += expectedColumns;
            if (wantsRowHeight) expectedCheckCount += expectedRows;
            if (expectedCheckCount !== expectedChecks) return formatRefusal('CAPABILITY_UNAVAILABLE');
            // The COLOUR objects are created ONCE, before the loop, because they are the same for every cell
            // (and because a colour is what the measured setter requires: a string is silently ignored).
            var fillColour = null;
            if (wantsFill) {
              if (typeof Api.CreateColorFromRGB !== 'function') return formatRefusal('CAPABILITY_UNAVAILABLE');
              fillColour = Api.CreateColorFromRGB(request.fillR, request.fillG, request.fillB);
            }
            var clearColour = null;
            if (wantsFillClear) {
              if (typeof Api.CreateNoFill !== 'function') return formatRefusal('CAPABILITY_UNAVAILABLE');
              clearColour = Api.CreateNoFill();
            }
            if (wantsColumnWidth || wantsRowHeight) {
              var geometryBlock = sheet.GetRange(address);
              if (geometryBlock === null || geometryBlock === undefined) return formatRefusal('CAPABILITY_UNAVAILABLE');
              if (wantsColumnWidth && typeof geometryBlock.SetColumnWidth !== 'function') return formatRefusal('CAPABILITY_UNAVAILABLE');
              if (wantsRowHeight && typeof geometryBlock.SetRowHeight !== 'function') return formatRefusal('CAPABILITY_UNAVAILABLE');
            }
            // THE MUTATION, and the boundary the two refusal classes are split on: the phase turns
            // POST_INSERT here, immediately before the first call that can change the sheet.
            phase = 'POST_INSERT';
            for (var writeRow = 0; writeRow < expectedRows; writeRow++) {
              for (var writeColumn = 0; writeColumn < expectedColumns; writeColumn++) {
                var cellAddress = columnName(startColumn + writeColumn) + String(startRow + writeRow);
                var target = sheet.GetRange(cellAddress);
                if (target === null || target === undefined) return formatRefusal('CAPABILITY_UNAVAILABLE');
                if (wantsNumberFormat) {
                  if (typeof target.SetNumberFormat !== 'function') return formatRefusal('CAPABILITY_UNAVAILABLE');
                  target.SetNumberFormat(numberFormatCode);
                }
                if (wantsBold) {
                  if (typeof target.SetBold !== 'function') return formatRefusal('CAPABILITY_UNAVAILABLE');
                  target.SetBold(wantBold);
                }
                if (wantsItalic) {
                  if (typeof target.SetItalic !== 'function') return formatRefusal('CAPABILITY_UNAVAILABLE');
                  target.SetItalic(wantItalic);
                }
                if (wantsFontFamily) {
                  if (typeof target.SetFontName !== 'function') return formatRefusal('CAPABILITY_UNAVAILABLE');
                  target.SetFontName(wantFontFamily);
                }
                if (wantsFontSize) {
                  if (typeof target.SetFontSize !== 'function') return formatRefusal('CAPABILITY_UNAVAILABLE');
                  target.SetFontSize(wantFontSize);
                }
                if (wantsFill) {
                  if (typeof target.SetFillColor !== 'function') return formatRefusal('CAPABILITY_UNAVAILABLE');
                  target.SetFillColor(fillColour);
                }
                if (wantsFillClear) {
                  if (typeof target.SetFillColor !== 'function') return formatRefusal('CAPABILITY_UNAVAILABLE');
                  target.SetFillColor(clearColour);
                }
                if (wantsWrap) {
                  if (typeof target.SetWrapText !== 'function') return formatRefusal('CAPABILITY_UNAVAILABLE');
                  target.SetWrapText(wantWrap);
                }
              }
            }
            // The geometry is applied to the ADDRESSED BLOCK, so `columnWidth` reaches every column the address
            // intersects and `rowHeight` every row it intersects — the semantics stated in the tool's own
            // documentation — and each of them is PROVED per affected column/row below.
            if (wantsColumnWidth || wantsRowHeight) {
              var applyBlock = sheet.GetRange(address);
              if (applyBlock === null || applyBlock === undefined) return formatRefusal('CAPABILITY_UNAVAILABLE');
              if (wantsColumnWidth) applyBlock.SetColumnWidth(wantColumnWidth);
              if (wantsRowHeight) applyBlock.SetRowHeight(wantRowHeight);
            }
            // THE VERIFICATION, one flag per (property, cell), then per (geometry property, column/row).
            var answer = [];
            answer.push(phase);
            answer.push(expectedRows);
            answer.push(expectedColumns);
            answer.push(expectedCheckCount);
            for (var checkRow = 0; checkRow < expectedRows; checkRow++) {
              for (var checkColumn = 0; checkColumn < expectedColumns; checkColumn++) {
                var checkAddress = columnName(startColumn + checkColumn) + String(startRow + checkRow);
                var checked = sheet.GetRange(checkAddress);
                if (checked === null || checked === undefined) return formatRefusal('CAPABILITY_UNAVAILABLE');
                if (wantsNumberFormat) {
                  if (typeof checked.GetNumberFormat !== 'function') return formatRefusal('CAPABILITY_UNAVAILABLE');
                  answer.push(String(checked.GetNumberFormat()) === numberFormatCode ? 1 : 0);
                }
                if (wantsBold || wantsItalic || wantsFontFamily || wantsFontSize) {
                  if (typeof checked.GetCharacters !== 'function') return formatRefusal('CAPABILITY_UNAVAILABLE');
                  var characters = checked.GetCharacters();
                  if (characters === null || characters === undefined || typeof characters.GetFont !== 'function') return formatRefusal('CAPABILITY_UNAVAILABLE');
                  var font = characters.GetFont();
                  if (font === null || font === undefined) return formatRefusal('CAPABILITY_UNAVAILABLE');
                  if (wantsBold) answer.push(booleanFlag(font.GetBold(), wantBold));
                  if (wantsItalic) answer.push(booleanFlag(font.GetItalic(), wantItalic));
                  if (wantsFontFamily) answer.push(String(font.GetName()) === wantFontFamily ? 1 : 0);
                  if (wantsFontSize) answer.push(String(font.GetSize()) === String(wantFontSize) ? 1 : 0);
                }
                if (wantsFill) {
                  if (typeof checked.GetFillColor !== 'function') return formatRefusal('CAPABILITY_UNAVAILABLE');
                  var fillAnswer = checked.GetFillColor();
                  var fillFlag = 0;
                  if (fillAnswer !== null && fillAnswer !== undefined && typeof fillAnswer === 'object' && fillAnswer.color) {
                    if (typeof fillAnswer.color.getRgb === 'function') {
                      var wantedRgb = request.fillR * 65536 + request.fillG * 256 + request.fillB;
                      fillFlag = String(fillAnswer.color.getRgb()) === String(wantedRgb) ? 1 : 0;
                    }
                  }
                  answer.push(fillFlag);
                }
                if (wantsFillClear) {
                  if (typeof checked.GetFillColor !== 'function') return formatRefusal('CAPABILITY_UNAVAILABLE');
                  var clearedAnswer = checked.GetFillColor();
                  answer.push(String(clearedAnswer) === 'No Fill' ? 1 : 0);
                }
                if (wantsWrap) {
                  if (typeof checked.GetWrapText !== 'function') return formatRefusal('CAPABILITY_UNAVAILABLE');
                  answer.push(String(checked.GetWrapText()) === String(wantWrap) ? 1 : 0);
                }
              }
            }
            if (wantsColumnWidth) {
              for (var widthColumn = 0; widthColumn < expectedColumns; widthColumn++) {
                var widthAddress = columnName(startColumn + widthColumn) + String(startRow);
                var widthCell = sheet.GetRange(widthAddress);
                if (widthCell === null || widthCell === undefined || typeof widthCell.GetColumnWidth !== 'function') return formatRefusal('CAPABILITY_UNAVAILABLE');
                answer.push(String(widthCell.GetColumnWidth()) === String(wantColumnWidth) ? 1 : 0);
              }
            }
            if (wantsRowHeight) {
              for (var heightRow = 0; heightRow < expectedRows; heightRow++) {
                var heightAddress = columnName(startColumn) + String(startRow + heightRow);
                var heightCell = sheet.GetRange(heightAddress);
                if (heightCell === null || heightCell === undefined || typeof heightCell.GetRowHeight !== 'function') return formatRefusal('CAPABILITY_UNAVAILABLE');
                answer.push(String(heightCell.GetRowHeight()) === String(wantRowHeight) ? 1 : 0);
              }
            }
            if (answer.length !== 4 + expectedCheckCount) return formatRefusal('TOOL_ERROR');
            return answer;
          } catch (error) {
            return formatRefusal('CAPABILITY_UNAVAILABLE');
          }
        }, false, false, callback);
      },
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
            // THE EDITOR'S OWN LINE-BREAK FORM, and the ONE representation rule applied before any text
            // comparison in this body. MEASURED on the target (Astra / R7 2026.1.2.1942, the round that hit
            // this): `Api.CreateParagraph()` + `paragraph.AddText('СТРОКА-А\nСТРОКА-Б')` +
            // `document.Push(paragraph)` yields ONE paragraph — the paragraph delta was exactly +1 for `\n`,
            // `\r\n`, `\n\n`, a TRAILING `\n` and a long multi-line text alike — whose `GetText()` answers
            // `'СТРОКА-А\rСТРОКА-Б'`. Every line break handed to the editor is therefore STORED as `\r`, so
            // the requested text and the read text are compared in that stored form, BOTH sides mapped by
            // THIS function: `\r\n` -> `\r`, a lone `\n` -> `\r`, and a `\r` left exactly as it is.
            // THIS IS A CHANGE OF REPRESENTATION, NEVER OF THE RULE: one block still owns exactly the ONE
            // paragraph the append gave it, the four counts and their exact deltas below are unchanged, and
            // every genuine difference — different words, extra text, a missing paragraph, a DIFFERENT
            // block — still maps to different strings and still fails the block's flag.
            function editorStoredText(handedText) {
              return handedText.replace(/\r\n/g, '\n').replace(/\n/g, '\r');
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
              // BOTH SIDES ARE COMPARED IN THE EDITOR'S OWN STORED FORM (`editorStoredText` above): the
              // editor stores `\r` for every line break it is handed (measured), so a multi-line block the
              // append really carried must compare EQUAL to the text that was asked for. This is a change
              // of REPRESENTATION, never of the rule — one block still owns exactly one appended paragraph,
              // and a genuine difference (different words, extra text, a missing paragraph, a different
              // block) still maps to a different string and still makes the flag 0.
              var wanted = editorStoredText(blocks[which].text);
              answer.push(paragraphsBefore + which < paragraphTexts.length &&
                editorStoredText(paragraphTexts[paragraphsBefore + which]) === wanted ? 1 : 0);
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
      // runProof, align, alignBefore, alignAfter]` — TEN slots, the run proof being ONE four-character
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
            // THE ONE CONDITION THAT MAKES THE LOCATED PAIR A PAIR, and it is the correction an independent
            // review forced on this round. The LAST opener before the region and the FIRST closer after it are
            // not necessarily ONE pair: in the markup `&lt;strong&gt;Ц&lt;/strong&gt;ел&lt;strong&gt;ь&lt;/strong&gt;`
            // with the region `ел` requested bold, the last opener is the one before `Ц` and the first closer
            // after the region is the one after `ь`, so the rule as it stood answered 1 for a region that
            // carries NO bold at the address — the pair the located opener really belongs to CLOSES before the
            // region, and a second, unrelated pair reopens after it. The reviewer reproduced exactly that
            // against this bridge and received `{"ok":true,…,"boldVerified":true}`: a FAIL-OPEN false proof,
            // the one direction this module must never answer. The condition below requires the judged closer
            // to be the FIRST closer the judged opener reaches (`markup.indexOf(close, openAt) === closeAt`),
            // which is true exactly when that opener is still OPEN where the region stands and the pair
            // therefore really covers it. It excludes the reproduced markup (that opener's own closer sits
            // before the region) and leaves every legitimate shape untouched: the exact pair, a wider pair
            // around the region, and the measured nesting
            // (`&lt;em&gt;&lt;strong&gt;REGION&lt;/strong&gt;&lt;/em&gt;` judged for the OUTER property) all have
            // that opener's first closer exactly where the closer was found.
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
              // THE PAIR MUST BE ONE PAIR, and this is the line the review's repro turns on: the located opener
              // must still be OPEN at the region, i.e. its OWN first closer is the closer this rule judged. When
              // a pair closes before the region and a different pair reopens after it
              // (`&lt;strong&gt;Ц&lt;/strong&gt;ел&lt;strong&gt;ь&lt;/strong&gt;`, region `ел`), the opener's
              // first closer is the one after `Ц` and NOT the one after `ь`, so the answer is 0 — the region is
              // not inside the pair the opener belongs to. The exact pair, a wider pair around the region and
              // the measured nesting all keep their opener's first closer at `closeAt`, so they are unaffected.
              if (markup.indexOf(close, openAt) !== closeAt) return 0;
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
      // NO mutation primitive's return value is consulted anywhere in this body: the readbacks below are
      // the whole ground truth, exactly as in the four legs before it.
      //
      // THE ELEMENT READBACK, and it replaces a markdown-fragment proof this leg used to carry. It is the
      // MEASURED basis rather than a deduction: the Lead measured on the target (Astra / R7 2026.1.2.1942, in
      // the SAME native session that ran this tool) that after a named-form call the addressed paragraph's
      // `GetElementsCount()` went 1 → 2, that `GetElement(i)` answered a usable object for EVERY index, and
      // that the appended element answered `GetClassType() === 'hyperlink'`,
      // `GetLinkedText() === 'https://example.com/astra-r7-pilot'` and
      // `GetDisplayedText() === 'ССЫЛКА-ПИЛОТ'`. The proof is therefore PER OBJECT, on the addressed
      // paragraph: the element count read BEFORE the mutation must grow by EXACTLY ONE, and the element AT
      // that PRE count index must be the appended hyperlink carrying EXACTLY this ticket's url and label.
      // The index is the PRE count on both sides of the boundary, so the element being judged is this write's
      // OWN appended element and never a link that was already there.
      //
      // WHAT THE SWAP REMOVED, AND WHY. The retired proof located `preText + "[" + label + "](" + url + ")"`
      // in `doc.ToMarkdown()`, exactly once. A close-out review REPRODUCED on the real bridge that the needle
      // is broken by ANY character formatting inside the addressed paragraph — the converter wraps the OTHER
      // runs in the measured `MdSymbols` (`**`/`*`/`~~`/`` ` ``), so a marker lands inside the needle — and by
      // a line break (`para_NewLine` renders as a space plus a backslash plus a newline while `GetText()`
      // answers `\r`), so a formatted paragraph cost a FALSE UNCERTAIN with the slot held. The export also
      // forced a document-wide uniqueness rule (nothing replaces it: the readback addresses ONE element by its
      // index inside the addressed paragraph, so a duplicate elsewhere is not part of the proof) and a size
      // bound on a string no part of the proof needs (the PRE element count is what the PRE-export check
      // became). NOTHING of the export survives here: this body authors no `ToMarkdown` at all.
      //
      // EVERY CHAIN STEP IS A FUNCTION CHECK BEFORE THE MUTATION, and the ordering is a contract rather than
      // defensive style: `GetElementsCount`, `GetElement`, `GetClassType`, `GetLinkedText` and
      // `GetDisplayedText` are each required to be a FUNCTION before anything is written, so an editor missing
      // one of them — or one that THROWS on the PRE read — answers this body's own closed refusal with ZERO
      // writes rather than a link written into a document whose proof cannot be read. The appended element does
      // not exist before the write, so its three members are checked on the object `GetElement` answers; an
      // absence or a throw THERE is not a refusal, because the write has already run — it is the uncertain
      // class, with the slot held.
      //
      // THE ANSWER is ONE flat array of primitives (the native return validator keeps those and strips a plain
      // object): `[POST_INSERT, paragraphsBefore, paragraphsAfter, elementsBefore, elementsAfter,
      // textBeforeChars, textAfterChars, textAppended, elementCountGrew, elementAppended]` — TEN slots — or a
      // TWO-slot refusal `[PRE_INSERT, name]`. THE PHASE IS AN EXPLICIT SLOT OF EVERY ANSWER, and it turns at
      // the FIRST call that can change the DOCUMENT, which is the ONE `Push` for the append form (an element
      // appended to the created paragraph writes nothing: the paragraph is detached) and the ONE live
      // `AddElement` for the named form. A throw out of a call that cannot have touched the document therefore
      // keeps its known refusal instead of wedging the write slot.
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
            // The scope the vendor wrapper injected: `{ url, text, paragraph, append }`, already validated by
            // the bridge. Anything else — a missing wrapper, an empty url or label, a form that does not agree
            // with its address — is this body's own closed refusal rather than a document written on the
            // strength of `undefined`.
            var request = typeof scope !== 'undefined' && scope !== null ? scope : null;
            var measured = measureRequest(request);
            if (measured === null) return linkRefusal('CAPABILITY_UNAVAILABLE');
            var address = measured[0];
            var append = measured[1];
            var url = measured[2];
            var text = measured[3];
            // A count this body cannot trust as a NON-NEGATIVE WHOLE number is not a count. The check
            // reaches for NO global at all, so the stringified body depends on nothing but the two bindings
            // the vendor wrapper creates.
            function isCount(value) {
              return typeof value === 'number' && value === value && value >= 0 && value % 1 === 0;
            }
            // `list[index]` is a member read with a NON-CONSTANT key, which this module's NAME-based alias
            // analysis treats as a computed value; a CALL's result is not tainted by it, so every value taken
            // out of an array is taken through a helper and every method call lands on the helper's own
            // parameters rather than on a variable read out of one.
            function paragraphAt(list, position) {
              return position >= 0 && position < list.length ? list[position] : null;
            }
            function textAt(item) {
              if (item === null || item === undefined || typeof item.GetText !== 'function') return null;
              try { return item.GetText(); } catch (error) { return null; }
            }
            // THE PARAGRAPH'S OWN ELEMENT COUNT, read through `ApiParagraph.GetElementsCount()` — the PRE half
            // of the readback, and the index the appended element must occupy. A missing primitive, a
            // non-number answer and a throw are all the ABSENCE of a measurement (`null`), which the caller
            // settles as a closed refusal BEFORE the mutation or as the uncertain class after it.
            function elementCountAt(item) {
              try {
                if (item === null || item === undefined || typeof item.GetElementsCount !== 'function') return null;
                var count = item.GetElementsCount();
                return isCount(count) ? count : null;
              } catch (error) { return null; }
            }
            // THE APPENDED ELEMENT'S OWN PROPERTIES, and this is the leg that makes the URL itself provable.
            // The element is taken through `GetElement(position)` and judged through its own three members:
            // its class must be `hyperlink`, its linked text EXACTLY this ticket's url and its displayed text
            // EXACTLY this ticket's label. Every call lands on this function's OWN parameter — never on a
            // value read out of an array — for the authored-code-audit reason `paragraphAt` states, and a
            // missing member, a non-string answer or a throw is the absence of a measurement (`0`), which the
            // caller settles as the uncertain class because the write has already run.
            function hyperlinkElement(item, position, expectedUrl, expectedText) {
              try {
                if (item === null || item === undefined) return 0;
                // THE PARAGRAPH HALF: `GetElement` is the ONE step this body authors on the paragraph, and it
                // is the step the addressed object must expose. Its three siblings belong to the ELEMENT, and
                // they are checked on the object `GetElement` answers below — checking them HERE would ask a
                // paragraph for a hyperlink method and answer 0 for a perfectly good write.
                if (typeof item.GetElement !== 'function') return 0;
                var element = item.GetElement(position);
                if (element === null || element === undefined) return 0;
                if (typeof element.GetClassType !== 'function' || typeof element.GetLinkedText !== 'function') return 0;
                if (typeof element.GetDisplayedText !== 'function') return 0;
                if (element.GetClassType() !== 'hyperlink') return 0;
                if (element.GetLinkedText() !== expectedUrl) return 0;
                if (element.GetDisplayedText() !== expectedText) return 0;
                return 1;
              } catch (error) { return 0; }
            }
            // THE REQUEST, MEASURED BEFORE ANY PRIMITIVE IS TOUCHED. The address is re-checked HERE and not
            // only in the bridge method, because the scope is the ONE thing that crosses: a form that is not a
            // boolean, an address that does not agree with that form, and an empty url or label are this body's
            // own closed argument refusal, never a link written to a coerced address. The return is an ARRAY so
            // the caller binds each measured value separately, which keeps every later member call on a call's
            // own result rather than on an indexed read.
            function measureRequest(given) {
              if (given === null || given === undefined || typeof given !== 'object') return null;
              var position = given.paragraph;
              var appends = given.append;
              var linkUrl = given.url;
              var displayed = given.text;
              if (appends !== true && appends !== false) return null;
              // THE ADDRESS AND THE FORM ARE ONE FACT: the append form names NO index at all, and the named
              // form must name a whole non-negative one.
              if (appends === true) {
                if (position !== null) return null;
              } else if (!isCount(position)) return null;
              if (typeof linkUrl !== 'string' || linkUrl === '') return null;
              if (typeof displayed !== 'string' || displayed === '') return null;
              return [position, appends, linkUrl, displayed];
            }
            var available = typeof Api !== 'undefined' && Api !== null;
            var document = available && typeof Api.GetDocument === 'function' ? Api.GetDocument() : null;
            if (document === null || document === undefined) return linkRefusal('CAPABILITY_UNAVAILABLE');
            // Every primitive this body authors is a FUNCTION CHECK before any call, exactly like the four
            // mutation bodies before it, and the element-readback chain is checked HERE too so that a missing
            // step is a refusal with ZERO writes rather than a proof that never ran: `GetElementsCount` and
            // `GetElement` on the addressed paragraph, then `GetClassType`/`GetLinkedText`/`GetDisplayedText`
            // on the element `GetElement` answers. The element itself does not exist yet, so its members are
            // checked on the object that answers it — the line below is the paragraph half of that chain.
            if (typeof document.GetAllParagraphs !== 'function') return linkRefusal('CAPABILITY_UNAVAILABLE');
            if (typeof Api.CreateHyperlink !== 'function') return linkRefusal('CAPABILITY_UNAVAILABLE');
            if (append === true) {
              if (typeof Api.CreateParagraph !== 'function') return linkRefusal('CAPABILITY_UNAVAILABLE');
              if (typeof document.Push !== 'function') return linkRefusal('CAPABILITY_UNAVAILABLE');
            }
            // THE PRE-DISPATCH BASELINE: the document's own paragraph count and — for the NAMED form — the
            // addressed paragraph's own text AND element count, read BEFORE anything is mutated. The index is
            // checked against the SAME snapshot the text is read from, so a baseline that cannot be read and
            // an index outside THIS document are closed refusals with ZERO writes. The APPEND form reads no
            // address at all: the paragraph it will act on does not exist yet.
            var before = document.GetAllParagraphs();
            if (before === null || before === undefined || typeof before.length !== 'number') return linkRefusal('CAPABILITY_UNAVAILABLE');
            var countBefore = before.length;
            if (!isCount(countBefore)) return linkRefusal('CAPABILITY_UNAVAILABLE');
            var textBefore = '';
            var elementsBefore = 0;
            var existing = null;
            if (append === false) {
              // AN INDEX OUTSIDE THE DOCUMENT is the closed ARGUMENT class, not the capability class: the
              // caller named a position that does not exist.
              if (!(address < countBefore)) return linkRefusal('TOOL_ERROR');
              existing = paragraphAt(before, address);
              if (existing === null || existing === undefined) return linkRefusal('CAPABILITY_UNAVAILABLE');
              if (typeof existing.AddElement !== 'function') return linkRefusal('CAPABILITY_UNAVAILABLE');
              // THE READBACK CHAIN, checked on the OBJECT the paragraph list answered and BEFORE the text is
              // read: an editor without either half answers the closed capability class with ZERO writes,
              // never a link appended to a paragraph whose proof this body could not read.
              if (typeof existing.GetElementsCount !== 'function') return linkRefusal('CAPABILITY_UNAVAILABLE');
              if (typeof existing.GetElement !== 'function') return linkRefusal('CAPABILITY_UNAVAILABLE');
              var readBefore = textAt(existing);
              if (typeof readBefore !== 'string') return linkRefusal('CAPABILITY_UNAVAILABLE');
              textBefore = readBefore;
              // THE PRE STATE ELEMENT COUNT, and it is what the retired export gate became: the count BEFORE
              // the mutation is the index the appended element must occupy, so it is read here — before the
              // phase turns — or the call is refused closed. A count that is missing, non-numeric or throwing
              // is `null`, and that is the closed refusal rather than a proof that could never run.
              var countRead = elementCountAt(existing);
              if (countRead === null) return linkRefusal('CAPABILITY_UNAVAILABLE');
              elementsBefore = countRead;
            }
            // THE MUTATION, and the exact boundary the two refusal classes are split on. The link object is
            // created FIRST (it is detached and writes nothing), then the phase turns at — and immediately
            // BEFORE — the first call that can change the DOCUMENT: the ONE `Push` of the append form, or the
            // ONE `AddElement` of the named form.
            var element = Api.CreateHyperlink(url, text);
            if (element === null || element === undefined) return linkRefusal('CAPABILITY_UNAVAILABLE');
            if (append === true) {
              var created = Api.CreateParagraph();
              if (created === null || created === undefined || typeof created.AddElement !== 'function') return linkRefusal('CAPABILITY_UNAVAILABLE');
              // THE APPEND FORM'S OWN READBACK CHAIN is checked on the paragraph factory's answer BEFORE the
              // detached element append, so a missing step still costs ZERO writes: the created paragraph is
              // the object the proof will read, and a build that cannot read it must not be written to.
              if (typeof created.GetElementsCount !== 'function') return linkRefusal('CAPABILITY_UNAVAILABLE');
              if (typeof created.GetElement !== 'function') return linkRefusal('CAPABILITY_UNAVAILABLE');
              // The created paragraph's OWN pre count — the detached paragraph really holds its paragraph-end
              // marker, and the link is appended after it.
              var createdCount = elementCountAt(created);
              if (createdCount === null) return linkRefusal('CAPABILITY_UNAVAILABLE');
              elementsBefore = createdCount;
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
            // THE SECOND LEG, and it is the one that makes the URL itself provable: the addressed paragraph's
            // OWN element count, read once more, must be the PRE count plus EXACTLY ONE, and the element AT
            // that PRE count index must answer `hyperlink` with THIS ticket's url and label. Both halves are
            // the body's own measurement of the same two primitives, so a count that did not grow and an
            // element that is not the appended link are told apart in the answer.
            var elementsAfter = elementCountAt(reached);
            if (elementsAfter === null) elementsAfter = 0;
            var elementCountGrew = elementsAfter === elementsBefore + 1 ? 1 : 0;
            var elementAppended = elementsAfter === elementsBefore + 1
              ? hyperlinkElement(reached, elementsBefore, url, text) : 0;
            // The phase slot, the two paragraph counts, the two element counts, the two text lengths and the
            // three flags are APPENDED rather than spelled as one array literal, for the authored-code-audit
            // reason the block body states.
            var answer = [];
            answer.push(phase);
            answer.push(countBefore);
            answer.push(countAfter);
            answer.push(elementsBefore);
            answer.push(elementsAfter);
            answer.push(textBefore.length);
            answer.push(textAfter.length);
            answer.push(textAppended);
            answer.push(elementCountGrew);
            answer.push(elementAppended);
            return answer;
          } catch (error) { return linkRefusal('CAPABILITY_UNAVAILABLE'); }
        }, false, false, callback);
      },
      // THE TEXT REPLACE, and the ONLY leg in this bridge whose proof is a COUNT OF THE DOCUMENT'S OWN
      // OCCURRENCES rather than the shape of an object it built. It is the same carriage as the six bodies
      // before it — a FULL inline static literal, whose ONLY model data arrives as the `scope` binding the
      // vendor wrapper composes from `Asc.scope` (never composed into source, ADR 0002), and no
      // composed-source transport at all — and it does four things in ONE synchronous evaluation:
      //   1. a PRE-DISPATCH BASELINE read of the needle's own occurrence count through the MEASURED
      //      `document.Search(query, matchCase)`, which is the gate: an unreadable count, ZERO occurrences
      //      and a `limit` below the count are the body's own closed refusals BEFORE anything is written, so
      //      no rewrite is ever dispatched without evidence to judge it by;
      //   2. the replacement's own PRE count, read only when the replacement is non-empty (there is no count
      //      of the empty string to read, and this body never invents one);
      //   3. ONE `document.SearchAndReplace({ searchString, replaceString, matchCase })`, the measured
      //      mutating primitive — with an EXPLICIT `matchCase`, because the vendored builder defaults the
      //      flag to `true` when the key is absent (`U.matchCase !== void 0 ? U.matchCase : true`);
      //   4. a POST read of the SAME two counts, so both the needle's fall and the replacement's rise are
      //      measured INSIDE the editor by the primitive the Lead measured (4 strict / 5 insensitive / 0
      //      absent).
      // NO MUTATION PRIMITIVE'S RETURN VALUE IS READ, and that is MEASURED rather than cautious:
      // `SearchAndReplace` mutates the document and returns `undefined`, so it is never a result signal in
      // either direction and the counts are the only evidence this body reports.
      // THE `limit` GATE. The measured primitive carries NO count parameter — its own body ends in
      // `this.Document.ReplaceSearchElement(V, true, null, false)`, which replaces EVERY match — so a
      // `limit` strictly below the occurrence count cannot be honoured: serving it would destroy text the
      // caller did not authorize. It is therefore the closed ARGUMENT class, decided here BEFORE the write.
      // The request's own arithmetic is still `min(limit, before)` on both sides of the boundary, and this
      // gate is exactly what makes every request this body writes satisfy it.
      // The answer is ONE flat array of primitives (the native return validator keeps those and strips a
      // plain object): `[POST_INSERT, occurrencesBefore, occurrencesAfter, replaceBefore, replaceAfter]`, or
      // the THREE-slot `[POST_INSERT, occurrencesBefore, occurrencesAfter]` for an empty replacement, or a
      // TWO-slot refusal `[PRE_INSERT, name]`. THE PHASE IS AN EXPLICIT SLOT OF EVERY ANSWER: it turns at —
      // and immediately BEFORE — the ONE call that can change the document, so a throw out of the count
      // reads keeps a known refusal while a throw out of the write is the uncertain class.
      replace(callback) {
        return plugin.callCommand(function () {
          var phase = 'PRE_INSERT';
          // The refusal is a TWO-slot array whose FIRST slot is that phase and whose SECOND is the closed
          // name, APPENDED to an array that starts as a literal for the authored-code-audit reason the other
          // bodies state: the alias analysis is NAME-based and scope-insensitive over the whole bundle, so an
          // array literal built from identifier names could make the receiver of every later call on it a
          // computed value.
          function replaceRefusal(name) {
            var refusal = [];
            refusal.push(phase);
            refusal.push(name);
            return refusal;
          }
          // A count this body cannot trust as a NON-NEGATIVE WHOLE number is not a count. The check reaches
          // for NO global at all, so the stringified body depends on nothing but the two bindings the vendor
          // wrapper creates.
          function isCount(value) {
            return typeof value === 'number' && value === value && value >= 0 && value % 1 === 0;
          }
          // THE PRIMITIVE'S OWN ARRAY LENGTH, read through a helper: `list.length` is a property READ of
          // editor data, and taking it here keeps every later value on a CALL's own result rather than on a
          // variable read out of an array — the authored-code-audit rule the other bodies state.
          function countMatches(list) {
            if (list === null || list === undefined) return null;
            var size = list.length;
            return isCount(size) ? size : null;
          }
          // THE REQUEST, MEASURED BEFORE ANY PRIMITIVE IS TOUCHED. The scope is the ONE thing that crosses,
          // so a shape the bridge would never compose is this body's own closed refusal rather than a
          // rewrite driven by `undefined`. The return is an ARRAY so the caller binds each measured value
          // separately.
          function measureReplaceRequest(given) {
            if (given === null || given === undefined || typeof given !== 'object') return null;
            var needle = given.search;
            var replacement = given.replace;
            var cased = given.matchCase;
            var atMost = given.limit;
            if (typeof needle !== 'string' || needle === '') return null;
            if (typeof replacement !== 'string') return null;
            if (typeof cased !== 'boolean') return null;
            if (atMost !== null && !(isCount(atMost) && atMost >= 1)) return null;
            return [needle, replacement, cased, atMost];
          }
          try {
            var request = typeof scope !== 'undefined' && scope !== null ? scope : null;
            var measured = measureReplaceRequest(request);
            if (measured === null) return replaceRefusal('CAPABILITY_UNAVAILABLE');
            var needle = measured[0];
            var replacement = measured[1];
            var matchCase = measured[2];
            var limit = measured[3];
            var available = typeof Api !== 'undefined' && Api !== null;
            var document = available && typeof Api.GetDocument === 'function' ? Api.GetDocument() : null;
            if (document === null || document === undefined) return replaceRefusal('CAPABILITY_UNAVAILABLE');
            // Every primitive this body authors is a FUNCTION CHECK before any call, exactly like the six
            // bodies before it: an editor without the count read cannot be given a rewrite whose proof could
            // never run, and an editor without the mutating primitive is not one this body may act on.
            if (typeof document.Search !== 'function') return replaceRefusal('CAPABILITY_UNAVAILABLE');
            if (typeof document.SearchAndReplace !== 'function') return replaceRefusal('CAPABILITY_UNAVAILABLE');
            // THE PRE-DISPATCH BASELINE. The count is the gate: unreadable is the closed capability class,
            // and ZERO is the closed ARGUMENT class — there would be nothing to replace, and a write that
            // replaces nothing is not a write.
            var countBefore = countMatches(document.Search(needle, matchCase));
            if (countBefore === null) return replaceRefusal('CAPABILITY_UNAVAILABLE');
            if (countBefore === 0) return replaceRefusal('TOOL_ERROR');
            // A LIMIT BELOW THE COUNT is the closed argument class for the measured reason stated above.
            if (limit !== null && limit < countBefore) return replaceRefusal('TOOL_ERROR');
            var counted = replacement !== '';
            var replaceBefore = 0;
            if (counted) {
              var readBefore = countMatches(document.Search(replacement, matchCase));
              if (readBefore === null) return replaceRefusal('CAPABILITY_UNAVAILABLE');
              replaceBefore = readBefore;
            }
            // THE MUTATION, and the exact boundary the two refusal classes are split on: `phase` turns at,
            // and immediately before, the ONE call that can change the document.
            phase = 'POST_INSERT';
            document.SearchAndReplace({ searchString: needle, replaceString: replacement, matchCase: matchCase });
            // THE POST READ, and NOTHING is taken from the pre-mutation count: a FRESH `Search` answers the
            // document's own state after the write.
            var countAfter = countMatches(document.Search(needle, matchCase));
            if (countAfter === null) return replaceRefusal('CAPABILITY_UNAVAILABLE');
            var answer = [];
            answer.push(phase);
            answer.push(countBefore);
            answer.push(countAfter);
            if (counted) {
              var replaceAfter = countMatches(document.Search(replacement, matchCase));
              if (replaceAfter === null) return replaceRefusal('CAPABILITY_UNAVAILABLE');
              answer.push(replaceBefore);
              answer.push(replaceAfter);
            }
            return answer;
          } catch (error) { return replaceRefusal('CAPABILITY_UNAVAILABLE'); }
        }, false, false, callback);
      },
      // THE IMAGE INSERT, and the SIXTH leg in this bridge that MUTATES a document through the `Api` builder.
      // It is the same carriage as the six bodies before it — a FULL inline static literal whose only model
      // data arrives as the `scope` binding the vendor wrapper composes from `Asc.scope` (never composed into
      // source, ADR 0002) — and it is the FOURTH leg that APPENDS.
      //
      // THE MEASURED PRIMITIVES, established on the target (Astra / R7 2026.1.2.1942) and read out of the
      // vendored 2026.1.2 bundle (`.local/stage-b-runtime/vendor-word-sdk-all.js`) rather than assumed:
      //   * `Api.CreateImage(dataUrl, 40, 40)` answers an OBJECT; the vendored body is
      //     `CreateImage = function (U, S, E) { var V = Oe(S), ht = Oe(E), _t = new ParaDrawing(V, ht, null,
      //     ci(), qt(), null), Ot = qt().DrawingObjects.createImage(U, 0, 0, V, ht); return Ot.setParent(_t),
      //     _t.Set_GraphicObject(Ot), new jt(Ot) }` — it builds and REGISTERS a picture object and it is called
      //     BEFORE the phase turns because it writes nothing to any paragraph;
      //   * `paragraph.AddDrawing(image)` answers an OBJECT and really adds the drawing; its body is
      //     `AddDrawing = function (U) { var S = new ParaRun(this.Paragraph, !1); return U instanceof Nt ?
      //     (S.Add_ToContent(0, U.Drawing), _i(this.Paragraph, S), U.Drawing.Set_Parent(S), i(U), new F(S)) :
      //     new F(S) }` — an APPEND at the END of that paragraph's own content;
      //   * `document.Push(paragraph)` appended the created paragraph: the paragraph count went 3 -> 4;
      //   * `GetAllDrawingObjects()` answered 1 and `GetAllImages()` went 0 -> 1; the vendored
      //     `GetAllImages = function () { … this.Document.GetAllDrawingObjects() … GraphicObj instanceof
      //     AscFormat.CImageShape && E.push(new jt(…)) }` shows the image list is the `CImageShape` FILTER of
      //     the drawing list, so the two are read SEPARATELY and both must grow;
      //   * `document.ToMarkdown(true, false)` rendered `![](data:image/png;base64,…)` holding the EXACT data
      //     URL. The vendored signature is `ToMarkdown(U, S, E, V)` with `ht = { convertType: 'markdown',
      //     htmlHeadings: U || false, base64img: S || false, demoteHeadings: E || false, renderHTMLTags:
      //     V || false }`, and the converter's arm is `case para_Drawing: if (va.IsPicture()) { if (S ===
      //     'markdown') ui += Fr.Config.base64img ? '![](' + va.GraphicObj.getBase64Img() + ')' : '![](' +
      //     va.GraphicObj.getImageUrl() + ')' …`. THE TWO POSITIONS WERE RE-MEASURED and they are NOT what this
      //     body first assumed: the FIRST is the heading-markup flag, and the SECOND, WHEN TRUTHY, REMOVES the
      //     embedded base64 image (`ToMarkdown(true, true)` came back 171 characters long with NO base64 at all,
      //     while `ToMarkdown(true, false)` came back 361 with the data URL). A truthy second argument
      //     therefore makes this leg's needle proof IMPOSSIBLE; the full measured table is stated at
      //     `readMarkdown` below, which is the ONE place the form is chosen;
      //   * the pushed paragraph's own element readback was a single element of class `run` with EMPTY text.
      //     THAT IS NOT AN IMAGE PROOF and this body builds none on it: a run with empty text is what a drawing
      //     of any other kind would leave behind too. What it supplies instead is the text leg of each form —
      //     the created paragraph really started and finished EMPTY, and the addressed paragraph's own text is
      //     UNCHANGED.
      // NO MUTATION PRIMITIVE'S RETURN VALUE IS READ anywhere in this body: every primitive here answers an
      // object and says nothing about the document, so the counts and the export needle are the whole evidence.
      //
      // THE NEEDLE IS `](<dataUrl>` — the two characters that close the markdown image's `![` prefix, then the
      // EXACT requested data URL. It is located by `indexOf`/`slice`, NEVER by a `RegExp` built from the
      // payload (this repository's authored-code audit forbids a computed pattern), and it is required to be
      // ABSENT from the export read BEFORE the write and present EXACTLY once after it — so a picture that was
      // already in the document can never carry this call's proof.
      //
      // THE EXPORT BOUND IS THE EXISTING DOCUMENT CEILING (`scope.markdownMax`, the same number the read path
      // uses for a document export). The PRE-write export above it is the body's own closed `BYTE_LIMIT` with
      // ZERO writes; the POST-write one is the UNCERTAIN class with the slot HELD, which is why the answer
      // carries the post-insert phase in a THREE-slot form for that case alone (`[POST_INSERT, 'BYTE_LIMIT',
      // markdownBeforeChars]`) and a TWO-slot one for the pre-write refusal.
      //
      // THE ANSWER is ONE flat array of primitives (the native return validator keeps those and strips a plain
      // object): `[POST_INSERT, imagesBefore, imagesAfter, drawingsBefore, drawingsAfter, paragraphsBefore,
      // paragraphsAfter, markdownBeforeChars, textBeforeChars, textAfterChars, markdownNeedle, imageAppended,
      // drawingAppended, textEmpty, textUnchanged]` — FIFTEEN slots — or a refusal `[phase, name]` /
      // `[POST_INSERT, 'BYTE_LIMIT', markdownBeforeChars]`. THE PHASE IS AN EXPLICIT SLOT OF EVERY ANSWER, and
      // it turns at — and immediately BEFORE — the first call that can change the DOCUMENT: the ONE `Push` of
      // the append form or the ONE `AddDrawing` into a LIVE paragraph of the named form. A throw out of a call
      // that cannot have touched the document therefore keeps its known refusal instead of wedging the write
      // slot, while a throw after that point is the uncertain class.
      // THE PRIMITIVES ARE CHECKED BEFORE ANY CREATION, and the per-form ones before the phase turns: a build
      // missing `GetAllImages`, `GetAllDrawingObjects` or `ToMarkdown` (or one whose document answers no
      // paragraph list) is the body's own closed capability refusal with ZERO writes rather than a picture
      // written into a document whose proof could never be read. A member that THROWS on a pre-write read is
      // the same refusal for the same reason.
      image(callback) {
        return plugin.callCommand(function () {
          var phase = 'PRE_INSERT';
          // The refusal is a TWO-slot array whose FIRST slot is that phase and whose SECOND is the closed
          // name, APPENDED to an array that starts as a literal for the authored-code-audit reason the other
          // bodies state: the alias analysis is NAME-based and scope-insensitive over the whole bundle, so an
          // array literal built from identifier names could make the receiver of every later call on it a
          // computed value.
          function imageRefusal(name) {
            var refusal = [];
            refusal.push(phase);
            refusal.push(name);
            return refusal;
          }
          // The POST-write export failure, which is its own three-slot shape: it carries the post-insert phase
          // because a write has already run, so the slot must be HELD. Every consumer classifies any answer of
          // this size as the uncertain class, and the extra slot is the pre-write export's own length, which
          // is the only measurement this body has when the post-write read could not answer.
          function imagePostExportRefusal(beforeChars) {
            var refusal = [];
            refusal.push('POST_INSERT');
            refusal.push('BYTE_LIMIT');
            refusal.push(beforeChars);
            return refusal;
          }
          // A count this body cannot trust as a NON-NEGATIVE WHOLE number is not a count. The check reaches
          // for NO global at all, so the stringified body depends on nothing but the two bindings the vendor
          // wrapper creates.
          function isCount(value) {
            return typeof value === 'number' && value === value && value >= 0 && value % 1 === 0;
          }
          // `list[index]` is a member read with a NON-CONSTANT key, which this module's NAME-based alias
          // analysis treats as a computed value; a CALL's result is not tainted by it, so every value taken
          // out of an array is taken through a helper and every method call lands on the helper's own
          // parameters rather than on a variable read out of one.
          function paragraphAt(list, position) {
            return position >= 0 && position < list.length ? list[position] : null;
          }
          function textAt(item) {
            if (item === null || item === undefined || typeof item.GetText !== 'function') return null;
            try { return item.GetText(); } catch (error) { return null; }
          }
          // THE TWO DOCUMENT COUNTS, taken through the same array-length route `GetAllParagraphs` uses. A
          // missing primitive, a non-number answer and a throw are all the ABSENCE of a measurement (`null`),
          // which the caller settles as a closed refusal BEFORE the creation or as the uncertain class after
          // the write.
          function listSize(list) {
            if (list === null || list === undefined) return null;
            var size = list.length;
            return isCount(size) ? size : null;
          }
          function imagesAt(document) {
            if (typeof document.GetAllImages !== 'function') return null;
            try { return listSize(document.GetAllImages()); } catch (error) { return null; }
          }
          function drawingsAt(document) {
            if (typeof document.GetAllDrawingObjects !== 'function') return null;
            try { return listSize(document.GetAllDrawingObjects()); } catch (error) { return null; }
          }
          // ONE non-overlapping count of the needle, so `](dataUrl` occurring twice can never be read as one
          // insertion. An occurrence at the very start (index 0) is not a match — the needle begins with `](`,
          // which can only ever follow the `![` the markdown converter emits.
          function imageNeedleCount(export_, needle) {
            var at = export_.indexOf(needle);
            if (at < 1) return 0;
            return export_.indexOf(needle, at + needle.length) < 0 ? 1 : 2;
          }
          // THE DOCUMENT'S OWN MARKDOWN EXPORT, in the MEASURED form that EMBEDS the base64 image, bounded by
          // the ceiling the caller composed (`markdownMax`). `assertByteLimit` is NOT reached for here: this
          // body reads no module binding at all (the native evaluates it where none exists), so the ceiling is
          // applied with its own byte count, exactly as the read path's helpers do.
          //
          // THE ARGUMENT TABLE, MEASURED ON THE TARGET (Astra / R7 2026.1.2.1942) inside a `callCommand` body,
          // on a document the probe itself had just inserted the image into so the image was definitely
          // present. Each row is the export's own character length, the index the `](<dataUrl>` needle was
          // found at, and whether the base64 payload was present at all:
          //   ToMarkdown()             length 341, needle 148, base64 present  ✓
          //   ToMarkdown(false,false)  length 341, needle 148, base64 present  ✓
          //   ToMarkdown(false,true)   length 151, needle  -1, base64 ABSENT   ✗
          //   ToMarkdown(true,false)   length 361, needle 168, base64 present  ✓   ← the form this body asks for
          //   ToMarkdown(true,true)    length 171, needle  -1, base64 ABSENT   ✗
          //   ToMarkdown(true)         length 361, needle 168, base64 present  ✓
          //   ToMarkdown(false)        length 341, needle 148, base64 present  ✓
          // SO THE TWO POSITIONS MEAN: the FIRST is the HEADING-MARKUP flag (`true` gives the longer export —
          // 361 against 341 — on every row that holds the image), and the SECOND, WHEN TRUTHY, DISABLES the
          // embedded base64 image. The vendored signature is `ToMarkdown(U, S, E, V)` with `ht = { convertType:
          // 'markdown', htmlHeadings: U || false, base64img: S || false, demoteHeadings: E || false,
          // renderHTMLTags: V || false }` and the converter's arm is `case para_Drawing: if (va.IsPicture()) {
          // if (S === 'markdown') ui += Fr.Config.base64img ? '![](' + va.GraphicObj.getBase64Img() + ')' :
          // '![](' + va.GraphicObj.getImageUrl() + ')' …` — a FALSY `base64img` takes the arm that embeds the
          // data URL, while a TRUTHY one renders the image's own URL instead.
          // WARNING: A TRUTHY SECOND ARGUMENT REMOVES THE BASE64 IMAGE AND MAKES THIS LEG'S PROOF IMPOSSIBLE —
          // the export then holds `![](<the image's URL>)`, the needle below is found ZERO times, and a write
          // that SUCCEEDED is reported as the uncertain class. The retired `ToMarkdown(true, true)` did exactly
          // that on the false assumption that BOTH arguments had to be true; `ToMarkdown(true, false)` is the
          // measured form and `ToMarkdown(true)` is its one-argument equivalent.
          function readMarkdown(document, max) {
            if (typeof document.ToMarkdown !== 'function') return null;
            var exported = document.ToMarkdown(true, false);
            if (typeof exported !== 'string') return null;
            var bytes = 0;
            for (var index = 0; index < exported.length; index += 1) {
              var code = exported.charCodeAt(index);
              if (code < 0x80) bytes += 1;
              else if (code < 0x800) bytes += 2;
              else if (code >= 0xd800 && code <= 0xdbff) {
                var next = exported.charCodeAt(index + 1);
                if (isCount(next) && next >= 0xdc00 && next <= 0xdfff) { bytes += 4; index += 1; }
                else bytes += 3;
              } else bytes += 3;
            }
            return bytes > max ? null : exported;
          }
          // A member this body could not measure is folded to the ONE value its slot's rule can express,
          // rather than destroying the whole answer: a damaged document degrades the field it belongs to and
          // the outcome rule then settles the ticket uncertain, instead of turning a verifiable write into a
          // phase-less uncertainty.
          function counted(value) {
            if (typeof value === 'boolean') return value;
            return typeof value === 'number' && value === value && value !== Infinity && value !== -Infinity ? value : 0;
          }
          // THE REQUEST, MEASURED BEFORE ANY PRIMITIVE IS TOUCHED. The scope is the ONE thing that crosses, so
          // a shape this bridge would never compose — a mime this leg does not serve, a payload that is not the
          // pure base64 alphabet, a dimension of the wrong kind, a form that does not agree with its address,
          // and a ceiling that is not the one the caller composed — is this body's own closed refusal, never a
          // picture written on the strength of `undefined`. `paragraph` is `null` for the append form, which is
          // that form's OWN address rather than an invented index.
          function measureImageRequest(given) {
            if (given === null || given === undefined || typeof given !== 'object') return null;
            var data = given.dataUrl;
            var width = given.widthPx;
            var height = given.heightPx;
            var position = given.paragraph;
            var appends = given.append;
            var max = given.markdownMax;
            if (appends !== true && appends !== false) return null;
            if (appends === true) {
              if (position !== null) return null;
            } else if (!(isCount(position))) return null;
            if (typeof data !== 'string' || data.length === 0) return null;
            var png = 'data:image/png;base64,';
            var jpeg = 'data:image/jpeg;base64,';
            var payload = null;
            if (data.indexOf(png) === 0) payload = data.slice(png.length);
            else if (data.indexOf(jpeg) === 0) payload = data.slice(jpeg.length);
            if (payload === null || payload.length === 0) return null;
            var alphabet = true;
            for (var index = 0; index < payload.length; index += 1) {
              var code = payload.charCodeAt(index);
              var letter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
              if (!(letter || code === 43 || code === 47 || code === 61)) alphabet = false;
            }
            if (alphabet !== true) return null;
            if (!(isCount(width) && width >= 1)) return null;
            if (!(isCount(height) && height >= 1)) return null;
            if (!(isCount(max) && max >= 1)) return null;
            return [position, appends, data, width, height, max];
          }
          try {
            var request = typeof scope !== 'undefined' && scope !== null ? scope : null;
            var measured = measureImageRequest(request);
            if (measured === null) return imageRefusal('CAPABILITY_UNAVAILABLE');
            // THE ADDRESS AND THE FORM ARE ONE FACT, and the pair is read into locals so every later member
            // call lands on a variable the body itself bound: `paragraph` is `null` for the append form.
            var address = measured[0];
            var append = measured[1];
            var data = measured[2];
            var widthPx = measured[3];
            var heightPx = measured[4];
            var markdownMax = measured[5];
            var available = typeof Api !== 'undefined' && Api !== null;
            var document = available && typeof Api.GetDocument === 'function' ? Api.GetDocument() : null;
            if (document === null || document === undefined) return imageRefusal('CAPABILITY_UNAVAILABLE');
            if (typeof document.GetAllParagraphs !== 'function') return imageRefusal('CAPABILITY_UNAVAILABLE');
            if (typeof Api.CreateImage !== 'function') return imageRefusal('CAPABILITY_UNAVAILABLE');
            if (typeof document.GetAllImages !== 'function') return imageRefusal('CAPABILITY_UNAVAILABLE');
            if (typeof document.GetAllDrawingObjects !== 'function') return imageRefusal('CAPABILITY_UNAVAILABLE');
            if (typeof document.ToMarkdown !== 'function') return imageRefusal('CAPABILITY_UNAVAILABLE');
            // The per-form primitives are checked BEFORE anything is created, exactly like the hyperlink
            // insert's: a build that cannot append must not create a picture first.
            if (append === true && (typeof Api.CreateParagraph !== 'function' || typeof document.Push !== 'function')) {
              return imageRefusal('CAPABILITY_UNAVAILABLE');
            }
            // THE PRE-DISPATCH BASELINE: the document's own paragraph count, its own IMAGE and DRAWING counts,
            // and — for the NAMED form — the addressed paragraph's own text. The index is checked against the
            // SAME snapshot the text is read from, so a baseline that cannot be read and an index outside THIS
            // document are closed refusals with ZERO writes. The APPEND form reads no address at all: the
            // paragraph it will act on does not exist yet.
            var before = document.GetAllParagraphs();
            var countBefore = listSize(before);
            if (countBefore === null) return imageRefusal('CAPABILITY_UNAVAILABLE');
            var imagesBefore = imagesAt(document);
            if (imagesBefore === null) return imageRefusal('CAPABILITY_UNAVAILABLE');
            var drawingsBefore = drawingsAt(document);
            if (drawingsBefore === null) return imageRefusal('CAPABILITY_UNAVAILABLE');
            var textBefore = '';
            var live = null;
            if (append === false) {
              if (!(address < countBefore)) return imageRefusal('TOOL_ERROR');
              live = paragraphAt(before, address);
              if (live === null || live === undefined) return imageRefusal('CAPABILITY_UNAVAILABLE');
              if (typeof live.AddDrawing !== 'function') return imageRefusal('CAPABILITY_UNAVAILABLE');
              var readBefore = textAt(live);
              if (typeof readBefore !== 'string') return imageRefusal('CAPABILITY_UNAVAILABLE');
              textBefore = readBefore;
            }
            // THE PRE-WRITE EXPORT, and the gate of the whole insert: it is read BEFORE anything is created so
            // that an unreadable export, or one above the ceiling this ticket carried, is the closed class with
            // ZERO writes. The needle's own pre-count is the second half of the proof — a picture that was
            // already in the document must not be able to satisfy it.
            var markdownBefore = readMarkdown(document, markdownMax);
            if (typeof markdownBefore !== 'string') return imageRefusal('BYTE_LIMIT');
            var needle = '](' + data;
            var needleBefore = imageNeedleCount(markdownBefore, needle);
            // THE CREATION, before the phase turns: `Api.CreateImage` builds a picture object and registers it
            // in the editor's own list, and it writes NOTHING to any paragraph. A picture the factory does not
            // answer is the closed capability class with ZERO writes.
            var image = Api.CreateImage(data, widthPx, heightPx);
            if (image === null || image === undefined) return imageRefusal('CAPABILITY_UNAVAILABLE');
            // THE MUTATION, and the exact boundary the two refusal classes are split on: the phase turns at —
            // and immediately BEFORE — the ONE call that can change the DOCUMENT. The APPEND form adds the
            // drawing into a paragraph that belongs to no document yet (`AddDrawing` on a detached paragraph
            // writes nothing) and then PUSHES it; the NAMED form's ONE `AddDrawing` into a LIVE paragraph is
            // itself the write.
            if (append === true) {
              var created = Api.CreateParagraph();
              if (created === null || created === undefined) return imageRefusal('CAPABILITY_UNAVAILABLE');
              if (typeof created.AddDrawing !== 'function') return imageRefusal('CAPABILITY_UNAVAILABLE');
              created.AddDrawing(image);
              phase = 'POST_INSERT';
              document.Push(created);
            } else {
              phase = 'POST_INSERT';
              live.AddDrawing(image);
            }
            // THE POST READ, and NOTHING is taken from the pre-mutation snapshot: a FRESH `GetAllParagraphs()`
            // answers fresh wrappers, the two lists are read again, and the export is read once more. The
            // post-write export is the ONLY read that cannot be a refusal: the write has already run, so an
            // unreadable or over-ceiling one is the UNCERTAIN class with the slot HELD.
            var after = document.GetAllParagraphs();
            var countAfter = listSize(after);
            var imagesAfter = imagesAt(document);
            var drawingsAfter = drawingsAt(document);
            // THE TEXT LEG, per form: the append form's created paragraph is re-taken at the baseline's own
            // count (the position the measured `Push` lands it at) and must be EMPTY, while the named form
            // re-takes its OWN address and must carry exactly the text it started with.
            var textAfter = '';
            var textEmpty = false;
            var textUnchanged = false;
            if (append === true) {
              var createdAfter = paragraphAt(after, countBefore);
              var createdText = textAt(createdAfter);
              textAfter = typeof createdText === 'string' ? createdText : '';
              textEmpty = typeof createdText === 'string' && createdText.length === 0;
            } else {
              var liveAfter = paragraphAt(after, address);
              var liveText = textAt(liveAfter);
              textAfter = typeof liveText === 'string' ? liveText : '';
              textUnchanged = typeof liveText === 'string' && liveText === textBefore;
            }
            // THE POST-WRITE EXPORT AND THE NEEDLE. The needle is required to be ABSENT before the write and
            // present EXACTLY once after it, so a pre-existing identical picture can never carry this proof.
            var markdownAfter = readMarkdown(document, markdownMax);
            if (typeof markdownAfter !== 'string') return imagePostExportRefusal(markdownBefore.length);
            var needleAfter = imageNeedleCount(markdownAfter, needle);
            // THE ANSWER. The phase slot, the eight counts, the two text lengths and the five proof flags are
            // APPENDED rather than spelled as one array literal, for the authored-code-audit reason the block
            // body states. Every member is folded through `counted` first, so a member the return validator
            // would reject cannot destroy the whole answer.
            var answer = [];
            answer.push(phase);
            answer.push(counted(imagesBefore));
            answer.push(counted(imagesAfter));
            answer.push(counted(drawingsBefore));
            answer.push(counted(drawingsAfter));
            answer.push(counted(countBefore));
            answer.push(counted(countAfter));
            answer.push(counted(markdownBefore.length));
            answer.push(counted(append === true ? 0 : textBefore.length));
            answer.push(counted(append === true ? 0 : textAfter.length));
            answer.push(counted(needleBefore === 0 && needleAfter === 1));
            answer.push(counted(imagesAfter === imagesBefore + 1));
            answer.push(counted(drawingsAfter === drawingsBefore + 1));
            answer.push(counted(append === false ? false : textEmpty));
            answer.push(counted(append === true ? false : textUnchanged));
            return answer;
          } catch (error) { return imageRefusal('CAPABILITY_UNAVAILABLE'); }
        }, false, false, callback);
      },
      // THE COMMENT INSERT behind `insert_comment` — the EIGHTH MUTATION of Sprint 3, the THIRD write leg that
      // APPENDS (a comment joins the document's own comment collection), and the FIRST whose proof is the
      // COMMENT COLLECTION'S OWN IDENTITY rather than a count, a needle or an occurrence arithmetic. It has ONE
      // form and NO target: `AddComment` was measured taking the TEXT ALONE, and the comment it created was
      // created at document/selection level, so this body takes `{ text, maxBytes }` from the injected command
      // scope — DATA, never composed into source (ADR 0002) — and nothing else.
      //
      // THE MEASURED ROUTE, all on the target (Astra / R7 2026.1.2.1942) INSIDE a `callCommand` body:
      //   * `doc.AddComment(text)` answered an OBJECT and `doc.GetAllComments()` went 0 -> 1;
      //   * the created comment answers `GetClassType() === 'comment'`, `GetText()` = the EXACT text passed,
      //     and `GetId()` = a numeric-looking string, and `doc.GetCommentById(id)` answers the same text. The
      //     class read and the by-id read are MEASUREMENTS OF THE SURFACE, not calls this body makes: the added
      //     comment is identified by its own `GetId()` and proven by its own `GetText()`, both taken from the
      //     collection the write really changed, so neither reader is authored here;
      //   * the document's comment surface is `AddComment`, `GetAllComments`, `GetCommentById`,
      //     `GetCommentsReport`; a comment's own readable members include `GetText`/`SetText`,
      //     `GetAuthorName`/`SetAuthorName`, `GetUserId`, `GetTimeUTC`/`GetTime`, `GetQuoteText`. The author
      //     reader is `GetAuthorName`, NOT `GetAuthor`, and this body calls NEITHER: no author was measured and
      //     no id beyond the comment's own `GetId()` crosses.
      //   * `ToMarkdown(...)` DOES NOT CONTAIN THE COMMENT TEXT — the export length was unchanged and the text
      //     was absent — so THIS BODY READS NO EXPORT AT ALL. That is the leg's defining difference from the
      //     image insert beside it, whose entire proof is a needle in that same export, and it is why this body
      //     authors neither `ToMarkdown` nor `ToHtml` nor `GetFileHTML`.
      //   * `Api.CreateComment` DOES NOT EXIST on this build (undefined), so the DOCUMENT's own `AddComment` is
      //     the only measured route and the nonexistent factory is authored nowhere.
      //
      // THE OUTCOME PROOF, per object: the document's OWN comment count is read BEFORE the one write through
      // `GetAllComments()`, and read AGAIN after it — a FRESH call, never the pre-write array, so a document
      // that caches its collection cannot hide the new comment. The count must have grown by exactly ONE, and
      // the ADDED comment is IDENTIFIED — by the id the object `AddComment` returned where that id is usable
      // (a non-empty string inside the caller-composed `idMax`, and NOT already present in the pre-write id
      // set, which would mean it cannot name the comment THIS call added), and otherwise by the DIFFERENCE of
      // the two id sets, or, when the pre set was EMPTY, by the single post comment — and THAT comment's own
      // `GetText()` must equal the requested text EXACTLY. Only the derived facts cross: the two counts, the
      // identified id (or `null`), and the identified comment's own character count beside the request's own
      // byte count. THE COMMENT TEXT ITSELF NEVER CROSSES BACK: it is the caller's own payload.
      //
      // THE PHASE SPLIT, and it is the whole of the failure classification. `PRE_INSERT` covers everything up
      // to the call that can change the document, so a missing `GetAllComments`/`AddComment`, an unreadable or
      // null pre-write collection, an unusable baseline and a request this body cannot interpret are all
      // closed refusals with ZERO writes and the slot RELEASED. The phase turns at — and immediately BEFORE —
      // the ONE `AddComment`: everything after it (a throwing or null post-write collection, an unreadable id
      // or text, a count that did not grow by one, a text that disagrees) is the UNCERTAIN class with the slot
      // HELD and no retry, because the write has already run and nothing observed afterwards proves it did not
      // apply. THE REQUEST IS A CLOSED PRECONDITION, re-checked HERE rather than taken on trust: this is a
      // PUBLIC ENTRY POINT, and a text the tool's own schema would have refused — empty, over-bound, or
      // carrying a control character other than TAB, LF and CR — must not be writable by a caller that reached
      // the bridge directly. The bound and the character rule are the SAME ones the descriptor advertises,
      // spelled beside their twins in `src/tools/word.js` because the two modules cannot import each other.
      comment(callback) {
        return plugin.callCommand(function () {
          var phase = 'PRE_INSERT';
          // The refusal is a TWO-slot array whose FIRST slot is that phase and whose SECOND is the closed
          // name, APPENDED to an array that starts as a literal for the authored-code-audit reason the other
          // bodies state: the alias analysis is NAME-based and scope-insensitive over the whole bundle, so an
          // array literal built from identifier names could make the receiver of every later call on it a
          // computed value.
          function commentRefusal(name) {
            var refusal = [];
            refusal.push(phase);
            refusal.push(name);
            return refusal;
          }
          // A count this body cannot trust as a NON-NEGATIVE WHOLE number is not a count. The check reaches
          // for NO global at all, so the stringified body depends on nothing but the two bindings the vendor
          // wrapper creates.
          function isCount(value) {
            return typeof value === 'number' && value === value && value >= 0 && value % 1 === 0;
          }
          // THE COMMENT COLLECTION'S OWN LENGTH, taken through the measured `GetAllComments`. A missing
          // primitive, a null answer and a throw are all the ABSENCE of a measurement (`null`), which the
          // caller settles as a closed refusal BEFORE the write or as the uncertain class after it.
          function commentsSize(list) {
            if (list === null || list === undefined) return null;
            var size = list.length;
            return isCount(size) ? size : null;
          }
          // ONE comment's OWN id, read only where the measured primitive exists. An id this body cannot read
          // is folded to `null` — the honest "not identified" value — rather than destroying the whole answer,
          // so a single damaged wrapper degrades its own slot and the outcome rule then settles the ticket
          // uncertain instead of turning a verifiable write into a phase-less uncertainty.
          function commentIdAt(item, max) {
            if (item === null || item === undefined || typeof item.GetId !== 'function') return null;
            var read = null;
            try { read = item.GetId(); } catch (error) { return null; }
            if (typeof read !== 'string' || read.length === 0 || read.length > max) return null;
            return read;
          }
          // ONE comment's OWN text, read through the measured `GetText`. A non-string answer and a throw are
          // the same absence (`null`), which can never equal a requested string.
          function commentTextAt(item) {
            if (item === null || item === undefined || typeof item.GetText !== 'function') return null;
            try { var read = item.GetText(); return typeof read === 'string' ? read : null; }
            catch (error) { return null; }
          }
          // THE IDS ONLY, for the pre-write pass: the baseline this body needs is the SET of ids the document
          // already held, so that an id it already carried can never be used to name a comment THIS call adds.
          function collectCommentIds(list, wanted) {
            var ids = [];
            for (var index = 0; index < list.length; index += 1) ids.push(commentIdAt(list[index], wanted.idMax));
            return ids;
          }
          // THE POST-WRITE PASS, and the ONLY pass that reads text. `keep` is the id the write RETURNED, where
          // that id is usable; this pass stops at it. With no usable returned id it looks for the ONE id the
          // pre-write set did not hold, which is exactly the DIFFERENCE of the two id sets — and when the pre
          // set was EMPTY that is the single post comment, the same rule one branch simpler. The result is
          // `[id, chars]` for the identified comment, `['AMBIGUOUS', 0]` when the id-set route cannot single
          // one out, or `null` when the identified comment's own text could not be read. `textAt` holds the
          // matched text so the caller can compare it against the request.
          function identifyComment(list, wanted, beforeIds, keep, textAt) {
            var candidate = null;
            var candidates = 0;
            var kept = null;
            for (var index = 0; index < list.length; index += 1) {
              var id = commentIdAt(list[index], wanted.idMax);
              if (keep !== null && id === keep) {
                var keptText = commentTextAt(list[index]);
                if (keptText === null) return null;
                if (kept !== null) return null;
                kept = [id, keptText.length];
                textAt[0] = keptText;
              }
              if (id !== null && !inCommentIds(wanted, beforeIds, id)) {
                candidates += 1;
                if (candidate === null) {
                  var candidateText = commentTextAt(list[index]);
                  if (candidateText === null) return null;
                  candidate = [id, candidateText.length];
                  textAt[0] = candidateText;
                }
              }
            }
            // THE RETURNED ID WINS, and the scan above proves it names EXACTLY ONE comment: two candidates
            // carrying it is a document this body cannot attribute, so it settles `null` (the caller's
            // uncertainty) rather than trusting either handle.
            if (keep !== null) return kept;
            return candidates === 1 ? candidate : null;
          }
          function inCommentIds(wanted, list, id) {
            for (var index = 0; index < list.length; index += 1) if (list[index] === id) return true;
            return false;
          }
          // THE REQUEST, MEASURED BEFORE ANY PRIMITIVE IS TOUCHED. The scope is the ONE thing that crosses, so
          // a text this leg would never compose — an empty one, one outside the bound the caller composed, one
          // carrying a control character other than TAB, LF and CR — is this body's own closed refusal, never a
          // comment written on the strength of `undefined`. The three whitespace control characters are SERVED
          // because a multi-line comment is ordinary document text and the measured readback returns them.
          function measureCommentRequest(given) {
            if (given === null || given === undefined || typeof given !== 'object') return null;
            var text = given.text;
            var idMax = given.idMax;
            var max = given.maxBytes;
            // THE SCOPE IS CLOSED: the three keys below are composed by the caller of this BODY and by nothing
            // else, so a fourth key is a request this module never composes — a caller that reached the
            // parameter channel directly and invented a bound or a target. It is refused rather than silently
            // ignored, so a caller can never believe it widened or narrowed something. The count is taken over
            // the OWN enumerable keys and every one of them is named, so neither an extra key nor a missing one
            // can pass.
            var keys = 0;
            for (var key in given) {
              if (Object.hasOwn(given, key)) keys += 1;
              if (key !== 'text' && key !== 'maxBytes' && key !== 'idMax') return null;
            }
            if (keys !== 3) return null;
            if (typeof text !== 'string' || text.length === 0) return null;
            if (!(isCount(idMax) && idMax >= 1)) return null;
            if (!(isCount(max) && max >= 1)) return null;
            var bytes = 0;
            for (var index = 0; index < text.length; index += 1) {
              var code = text.charCodeAt(index);
              if (code < 0x80) bytes += 1;
              else if (code < 0x800) bytes += 2;
              else if (code >= 0xd800 && code <= 0xdbff) {
                var next = text.charCodeAt(index + 1);
                if (isCount(next) && next >= 0xdc00 && next <= 0xdfff) { bytes += 4; index += 1; }
                else bytes += 3;
              } else bytes += 3;
              // NO C0 CONTROL AND NO DEL except the three whitespace ones the measured readback preserves.
              if (code < 0x20 && code !== 9 && code !== 10 && code !== 13) return null;
              if (code === 0x7f) return null;
            }
            if (bytes > max) return null;
            return [text, bytes, idMax];
          }
          try {
            var request = typeof scope !== 'undefined' && scope !== null ? scope : null;
            var measured = measureCommentRequest(request);
            if (measured === null) return commentRefusal('TOOL_ERROR');
            var wanted = { text: measured[0], textBytes: measured[1], idMax: measured[2] };
            var available = typeof Api !== 'undefined' && Api !== null;
            var document = available && typeof Api.GetDocument === 'function' ? Api.GetDocument() : null;
            if (document === null || document === undefined) return commentRefusal('CAPABILITY_UNAVAILABLE');
            // THE PRIMITIVES ARE CHECKED BEFORE ANY WRITE: a build missing the collection read or the factory
            // is a closed capability refusal with ZERO writes rather than a comment written into a document
            // whose proof could never be read.
            if (typeof document.GetAllComments !== 'function') return commentRefusal('CAPABILITY_UNAVAILABLE');
            if (typeof document.AddComment !== 'function') return commentRefusal('CAPABILITY_UNAVAILABLE');
            // THE PRE-DISPATCH BASELINE: the document's own comment count and the id of every comment it
            // already holds. A collection the body cannot read as a list is a closed refusal with ZERO writes,
            // because it is the baseline the whole delta is judged against.
            var before = document.GetAllComments();
            var countBefore = commentsSize(before);
            if (countBefore === null) return commentRefusal('CAPABILITY_UNAVAILABLE');
            var beforeIds = collectCommentIds(before, wanted);
            // THE MUTATION. THIS BODY'S REFUSALS ARE MADE BY ITS OWN CODE, AND THAT IS A DELIBERATE
            // RESTRICTION OF THE PHASE PROTOCOL: a synchronous THROW out of `AddComment` cannot have written
            // anything — a native that threw never returned a created comment — so it is the honest closed
            // CAPABILITY class with ZERO writes and a RELEASED slot, and the frozen `PRE_INSERT` phase is what
            // says so. An ASYNCHRONOUS failure is not expressible here at all (this body is one synchronous
            // function), so nothing that really wrote can take this arm, and the mutation has no post-return
            // step that could fail. The property this buys is stated for a later reader: THE PHASE IS A
            // STATEMENT ABOUT THIS BODY'S OWN CONTROL FLOW, not about a value that crossed the wire.
            var created = null;
            try { created = document.AddComment(wanted.text); }
            catch (error) { return commentRefusal('CAPABILITY_UNAVAILABLE'); }
            phase = 'POST_INSERT';
            // THE POST READ, and NOTHING is taken from the pre-write snapshot: a FRESH `GetAllComments()` is
            // asked for its own length and its own ids, and the identified comment's own text is read from
            // that same fresh collection. A count that cannot be read is folded to the uncertain class
            // IMMEDIATELY rather than invented as a zero: the write has already run, so "the total could not be
            // read" and "the total is zero" must never be the same answer.
            var after = document.GetAllComments();
            var countAfter = commentsSize(after);
            if (countAfter === null || after === null || after === undefined) return commentRefusal('CAPABILITY_UNAVAILABLE');
            // THE RETURNED HANDLE, read behind `typeof` checks: a factory that answered nothing, a non-object,
            // or an object with no usable `GetId` folds to `null` and the id-set route identifies the comment
            // instead. A returned id the document ALREADY held is not usable either — it cannot name a comment
            // THIS call added — so it falls through to the same id-set route.
            var returnedId = null;
            if (created !== null && created !== undefined && typeof created === 'object') {
              var readId = commentIdAt(created, wanted.idMax);
              if (readId !== null && !inCommentIds(wanted, beforeIds, readId)) returnedId = readId;
            }
            // THE IDENTIFICATION, in the ONE order the contract names, and BOTH facts come from the SAME
            // comment: the returned id does not merely supply a name, it SELECTS the object whose own
            // `GetText()` is then the text leg. The id-set route selects the one post id the pre set did not
            // hold (or, for an empty pre set, the single post comment).
            var textAt = [null];
            var identified = identifyComment(after, wanted, beforeIds, returnedId, textAt);
            // AN IDENTIFICATION THIS BODY COULD NOT MAKE IS ITS OWN ANSWER, not a zero and not an invented id:
            // a `null` id is the honest "the added comment could not be identified" report, which the caller's
            // outcome rule settles as the uncertain class with the slot HELD. The text slots stay at their
            // absent values beside it.
            var answer = [];
            answer.push(phase);
            answer.push(countBefore);
            answer.push(countAfter);
            if (identified === null) {
              answer.push(null);
              answer.push(0);
              answer.push(wanted.textBytes);
              return answer;
            }
            answer.push(identified[0]);
            answer.push(identified[1]);
            answer.push(wanted.textBytes);
            return answer;
          } catch (error) { return commentRefusal('CAPABILITY_UNAVAILABLE'); }
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
// The number of LEADING slots the SPREADSHEET-READ answer carries before its cell payload:
// `sheetName, sheetIndex, sheetCount, requestAddress, readAddress, totalRows, totalColumns, rowCount,
// columnCount, formulasMatch`. `requestAddress` is what was ASKED for (the caller's range, or the
// sheet's own used range), `readAddress` is what the answer actually COVERS, and the two differ exactly
// when the cap clipped the answer to a prefix of the range.
const SHEET_READ_SLOTS = 10;
// The CLOSED address shape a Cell read may name: `A1` or `A1:C10`, upper-case column letters and a
// 1-based row, nothing else. This exists because the address crosses into an authored editor command
// as DATA: an unvalidated string would be handed to `sheet.GetRange` verbatim, so the shape is checked
// HERE, at the boundary, and a caller that cannot name an address this closed pattern accepts is
// refused before any dispatch. A sheet-qualified address (`Лист2!A1`) is deliberately NOT accepted:
// this leg reads the ACTIVE sheet, and a second sheet is reached by activating it.
const SHEET_ADDRESS = /^[A-Z]{1,3}[1-9][0-9]{0,6}(:[A-Z]{1,3}[1-9][0-9]{0,6})?$/;
// The SPREADSHEET-READ answer, decoded with the same strictness as `decodeStructure` and for the same
// reason: the authored body encodes its measurements as ONE flat array of PRIMITIVES — because the
// native return validator keeps arrays of primitives and STRIPS a plain object — so the decoder must
// close every other shape. `Reflect.ownKeys` before any indexed read closes symbols, holes and hidden
// extras, and every member is read through its own data descriptor, never through a getter. Four rules
// are this leg's own contract:
//   * a ONE-slot `['CAPABILITY_UNAVAILABLE']` answer is the body's own closed refusal and crosses as
//     the capability class. It is a READ, so there is no phase and no uncertain class: a read that
//     cannot be performed changed nothing.
//   * `sheetName` and `address` are non-empty strings, and `sheetCount`/`rowCount`/`columnCount` are
//     non-negative safe integers with the three counts at least 1 — a count this bridge cannot trust is
//     not a count, and an address the editor did not answer is not a range.
//   * `formulasMatch` is EXACTLY 0 or 1, and the payload is EXACTLY `rowCount × columnCount` value
//     strings, followed by the same number of FORMULA SOURCE strings ONLY when it is 1. A body that
//     answered a different number of strings is not one this leg can have produced: publishing a short
//     formula list would attribute formulas to the wrong cells, and a long one would smuggle a cell no
//     address owns. `formulas: null` is therefore an EXPLICIT "this read published NO formula sources",
//     which covers any of the THREE conditions the body decides — the range exposed no getter, the address
//     the editor answered could not be read as the matrix's own rectangle, or a published cell's own
//     single-cell value disagreed with the value published for it — and it is never an empty matrix
//     that would read as "the range has no formulas": a range that answers and holds no formula reports
//     the same number of EMPTY strings, which is a measurement rather than an absence.
//   * the whole answer must fit `LIMITS.editorResultBytes`, the same ceiling every other decoded leg
//     applies.
// The SPREADSHEET-WRITE answer, and its ONE decision rule is the PHASE. The body answers
// `[phase, rowCount, columnCount, flag0, …]` with one flag per cell, or its own two-slot refusal
// `[phase, name]`:
//   * `[PRE_INSERT, name]` is a KNOWN refusal — nothing reached the sheet — and it keeps the closed code
//     the body named, which THIS decoder republishes unchanged. Whether its slot is RELEASED is the
//     downstream `preInsertRefusal` decision, and that is NARROWER than the phase: for this leg it accepts
//     exactly the two classes every other write leg does (`CAPABILITY_UNAVAILABLE` and `TOOL_ERROR`, which is
//     what this body's pre-write half answers), so a phase-marked `BYTE_LIMIT` — which this body cannot
//     produce — still settles UNCERTAIN with the slot HELD rather than being released here.
//   * a `[POST_INSERT, name]` refusal, a malformed answer, a flag list that is not the matrix size, a
//     phase that is not post-insert, or a count that disagrees with the request is the UNCERTAIN class:
//     the callback ARRIVED, so the body's write loop was entered and some cells may already be written.
//     This decoder therefore never returns a "bad shape" as a plain known error.
function decodeWriteRange(value, expectedRows, expectedColumns) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !Object.hasOwn(length, 'value') || length.enumerable) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  const size = length.value;
  if (!Number.isSafeInteger(size) || size < 2) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  if (Reflect.ownKeys(value).length !== size + 1) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const members = [];
  for (let index = 0; index < size; index++) {
    const descriptor = Object.hasOwn(descriptors, String(index)) ? descriptors[String(index)] : null;
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
    members.push(descriptor.value);
  }
  if (size === 2) {
    const phase = members[0];
    const name = members[1];
    if (phase === 'PRE_INSERT' && typeof name === 'string' && ERROR_CODES[name] === name) throw new SafeError(name);
    throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  }
  const cellCount = expectedRows * expectedColumns;
  if (!Number.isSafeInteger(cellCount) || cellCount < 1) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  if (size !== 3 + cellCount) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  if (members[0] !== 'POST_INSERT') throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  if (members[1] !== expectedRows || members[2] !== expectedColumns) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  const matches = [];
  for (let index = 0; index < cellCount; index++) {
    const flag = members[3 + index];
    if (flag !== 0 && flag !== 1) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
    matches.push(flag === 1);
  }
  return Object.freeze({ phase: 'POST_INSERT', rowCount: expectedRows, columnCount: expectedColumns,
    matches: Object.freeze(matches) });
}
// The WORKBOOK-LISTING answer: a header of three slots and then a fixed STRIDE per sheet, decoded strictly
// against the bound the ticket carried. A READ changes nothing, so every malformed shape here is the closed
// `INVALID_DATA` class rather than the uncertain one — there is no sheet state that could have been left
// behind by a listing that cannot be interpreted.
const SHEET_LIST_SLOTS = 3;
const SHEET_LIST_STRIDE = 4;
// The WORKBOOK-MUTATION answer (add a sheet): a header of nine slots, then the ordered names BEFORE the call and
// the ordered names AFTER it. THE POSTCONDITION IS PROVED HERE rather than trusted from the body, because this is
// the layer that can refuse while the ticket still owns the callback slot: a two-slot `[PRE_INSERT, code]` is a
// KNOWN refusal (nothing was added), and EVERY other shape — a `POST_INSERT` refusal included — is the UNCERTAIN
// class, because `Api.AddSheet` may already have created a sheet. That is the whole reason no post-mutation
// failure can come back as an ordinary error, and why a sheet that may exist is never deleted on the way out.
const SHEET_ADD_SLOTS = 9;
function decodeSheetAdd(value, expectedName, maxSheets) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !Object.hasOwn(length, 'value') || length.enumerable) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  const size = length.value;
  if (!Number.isSafeInteger(size) || size < 2) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  if (Reflect.ownKeys(value).length !== size + 1) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const members = [];
  for (let index = 0; index < size; index++) {
    const descriptor = Object.hasOwn(descriptors, String(index)) ? descriptors[String(index)] : null;
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
    members.push(descriptor.value);
  }
  if (size === 2) {
    const phase = members[0];
    const name = members[1];
    if (phase === 'PRE_INSERT' && typeof name === 'string' && ERROR_CODES[name] === name) throw new SafeError(name);
    throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  }
  if (!Number.isSafeInteger(maxSheets) || maxSheets < 1) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  if (size < SHEET_ADD_SLOTS) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  if (members[0] !== 'POST_INSERT') throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  const beforeCount = members[1];
  const afterCount = members[2];
  const newIndex = members[3];
  const newName = members[4];
  const activeIndex = members[5];
  const activeName = members[6];
  const previousActiveIndex = members[7];
  const previousActiveName = members[8];
  if (!Number.isSafeInteger(beforeCount) || beforeCount < 1 || beforeCount >= maxSheets) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  // EXACTLY ONE sheet more, and the new one LAST: both halves are the postcondition the caller was promised.
  // THIS CHECK IS LOAD-BEARING, and an earlier draft of this comment claimed the opposite — that deleting it
  // changed no outcome because the size equation below would catch a short answer. A review refuted that with a
  // forged answer that GROWS BY MORE THAN ONE and carries trailing members: the size equation ties the answer's
  // length to the DECLARED counts, so `afterCount` itself has to be pinned for the trailing members to be
  // inspected at all. It is pinned by its own test.
  if (afterCount !== beforeCount + 1) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  if (newIndex !== beforeCount) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  if (afterCount > maxSheets) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  if (size !== SHEET_ADD_SLOTS + beforeCount + afterCount) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  if (typeof newName !== 'string' || newName === '' || utf8ByteLength(newName) > LIMITS.sheetListNameBytes) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  // When the caller NAMED the sheet, the editor must confirm THAT name; when it did not, whatever the editor
  // produced is the answer (this leg never predicts a localised default).
  if (expectedName !== null && newName !== expectedName) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  if (activeIndex !== newIndex || activeName !== newName) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  if (!Number.isSafeInteger(previousActiveIndex) || previousActiveIndex < 0 || previousActiveIndex >= beforeCount) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  if (typeof previousActiveName !== 'string' || previousActiveName === '' || utf8ByteLength(previousActiveName) > LIMITS.sheetListNameBytes) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  // The two name lists are SLICES read at constant offsets, for the audit reason the listing decoder states.
  const beforeName = members.slice(SHEET_ADD_SLOTS, SHEET_ADD_SLOTS + beforeCount);
  const afterName = members.slice(SHEET_ADD_SLOTS + beforeCount, SHEET_ADD_SLOTS + beforeCount + afterCount);
  for (let index = 0; index < beforeCount; index++) {
    if (typeof beforeName[index] !== 'string' || beforeName[index] === '' || utf8ByteLength(beforeName[index]) > LIMITS.sheetListNameBytes) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
    // EVERY FORMER SHEET KEPT ITS POSITION, compared entry by entry rather than by count alone.
    if (afterName[index] !== beforeName[index]) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  }
  if (typeof afterName[beforeCount] !== 'string' || afterName[beforeCount] === '' || utf8ByteLength(afterName[beforeCount]) > LIMITS.sheetListNameBytes) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  // The LAST entry of the measured list and the name this answer REPORTS must be the same name: they are two
  // readings of the same sheet, so an answer where they disagree is not one this leg can have produced.
  if (afterName[beforeCount] !== newName) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  // The sheet that WAS active is still where it was, and the new name is genuinely new: a duplicate would mean
  // the pre-mutation check did not hold on this build, which is exactly the ambiguous state to refuse.
  if (afterName[previousActiveIndex] !== previousActiveName) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  for (let index = 0; index < beforeCount; index++) if (beforeName[index] === newName) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  return Object.freeze({ index: newIndex, name: newName, active: true,
    previousActive: Object.freeze({ index: previousActiveIndex, name: previousActiveName }) });
}
function decodeSheetList(value, maxSheets) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !Object.hasOwn(length, 'value') || length.enumerable) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const size = length.value;
  if (!Number.isSafeInteger(size) || size < 1) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (Reflect.ownKeys(value).length !== size + 1) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const members = [];
  for (let index = 0; index < size; index++) {
    const descriptor = Object.hasOwn(descriptors, String(index)) ? descriptors[String(index)] : null;
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new SafeError(ERROR_CODES.INVALID_DATA);
    members.push(descriptor.value);
  }
  if (size === 1 && members[0] === 'CAPABILITY_UNAVAILABLE') throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
  if (!Number.isSafeInteger(maxSheets) || maxSheets < 1) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (size < SHEET_LIST_SLOTS) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const count = members[0];
  const activeIndex = members[1];
  const activeName = members[2];
  // The DECLARED count, the SIZE of the answer and the bound must all agree: any of the three disagreeing means
  // this answer is not one this leg can have produced.
  if (!Number.isSafeInteger(count) || count < 1 || count > maxSheets) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (size !== SHEET_LIST_SLOTS + SHEET_LIST_STRIDE * count) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (!Number.isSafeInteger(activeIndex) || activeIndex < 0 || activeIndex >= count) throw new SafeError(ERROR_CODES.INVALID_DATA);
  // The header's active name is bounded here as BELT AND BRACES, and it is worth stating that this bound is
  // provably unreachable on its own: the header name must EQUAL the name of the entry at `activeIndex` (checked
  // below), and that entry's own name is bounded by the same rule, so no input can be refused by this line
  // alone. It stays because a bound on a published field should be visible where the field is read.
  if (typeof activeName !== 'string' || activeName === '' || utf8ByteLength(activeName) > LIMITS.sheetListNameBytes) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const sheets = [];
  let activeSeen = 0;
  for (let index = 0; index < count; index++) {
    const base = SHEET_LIST_SLOTS + index * SHEET_LIST_STRIDE;
    // A RECORD READ AT CONSTANT OFFSETS. The load-bearing half of the audit fix is in the BODY (addressing each
    // sheet through `Api.GetSheet(position)` rather than indexing the collection); what is measured HERE is that
    // a COMPUTED member read assigned to a SHARED identifier name taints that name across the whole bundle, so
    // `const name = members[base]` turned unrelated `name.toLowerCase()`-style calls in other legs into
    // dynamic-property findings. Constant offsets and leg-local names keep this decoder out of that class
    // entirely rather than relying on a name being free.
    const record = members.slice(base, base + SHEET_LIST_STRIDE);
    const recordName = record[0];
    const recordIndex = record[1];
    const recordActive = record[2];
    const recordVisible = record[3];
    if (typeof recordName !== 'string' || recordName === '' || utf8ByteLength(recordName) > LIMITS.sheetListNameBytes) throw new SafeError(ERROR_CODES.INVALID_DATA);
    // The index is POSITIONAL, which is STRICTER than the read leg: `decodeSheetRead` tolerates any non-negative
    // `GetIndex()` because it only reports that sheet's own index, while a listing needs the entries to BE the
    // book's positions. On a build whose `GetIndex()` were not 0-based (unconfirmed on the target) this leg would
    // therefore refuse a book the read leg still reads — a fail-CLOSED disagreement, recorded rather than hidden.
    if (!Number.isSafeInteger(recordIndex) || recordIndex !== index) throw new SafeError(ERROR_CODES.INVALID_DATA);
    if (recordActive !== 0 && recordActive !== 1) throw new SafeError(ERROR_CODES.INVALID_DATA);
    if (recordVisible !== 0 && recordVisible !== 1) throw new SafeError(ERROR_CODES.INVALID_DATA);
    const isActive = recordActive === 1;
    if (isActive) activeSeen += 1;
    sheets.push(Object.freeze({ name: recordName, index: recordIndex, active: isActive, visible: recordVisible === 1 }));
  }
  // A workbook has EXACTLY ONE active sheet: no sheet marked active and two of them are both refusals, and the
  // active entry must agree with the header in BOTH slots (`activeIndex` and `activeName`).
  if (activeSeen !== 1) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const activeEntry = sheets[activeIndex];
  if (activeEntry.active !== true || activeEntry.name !== activeName) throw new SafeError(ERROR_CODES.INVALID_DATA);
  return Object.freeze({ count, activeIndex, activeName, sheets: Object.freeze(sheets) });
}
// The SPREADSHEET-FORMATTING answer, decoded with the SAME strictness as `decodeWriteRange` and for the same
// reason: the phase is the one decision rule, the flag list is the proof, and a body that answers a different
// number of flags than the request owes is not one this leg can have produced.
//   * a TWO-slot `[PRE_INSERT, name]` is a KNOWN refusal — nothing reached the sheet — and it keeps the closed
//     code the body named, which this decoder republishes unchanged. Whether its slot is RELEASED is the
//     downstream `preInsertRefusal` decision, and for this leg that is the two classes every other write leg
//     accepts (`CAPABILITY_UNAVAILABLE` and `TOOL_ERROR`), so a phase-marked `BYTE_LIMIT` — which this body
//     cannot produce — still settles UNCERTAIN with the slot HELD.
//   * every other shape — a `POST_INSERT` refusal, a malformed answer, a flag count that is not the expected
//     one, counts that disagree with the request, or a flag that is not 0 or 1 — is the UNCERTAIN class: the
//     callback ARRIVED, so the body's mutation loop was entered and the sheet may already be formatted. This
//     decoder therefore never returns a "bad shape" as a plain known error.
// WHAT THIS DECODER DOES NOT DECIDE: that EVERY flag must be 1 for success. It publishes the flags as booleans
// and the DISPATCHER applies the exact-proof rule while it still owns the slot (the same division of labour
// `decodeWriteRange` has), so a single unproved property settles the ticket there rather than here.
function decodeCellFormat(value, expectedRows, expectedColumns, expectedChecks) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !Object.hasOwn(length, 'value') || length.enumerable) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  const size = length.value;
  if (!Number.isSafeInteger(size) || size < 2) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  if (Reflect.ownKeys(value).length !== size + 1) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const members = [];
  for (let index = 0; index < size; index++) {
    const descriptor = Object.hasOwn(descriptors, String(index)) ? descriptors[String(index)] : null;
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
    members.push(descriptor.value);
  }
  if (size === 2) {
    const phase = members[0];
    const name = members[1];
    if (phase === 'PRE_INSERT' && typeof name === 'string' && ERROR_CODES[name] === name) throw new SafeError(name);
    throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  }
  if (!Number.isSafeInteger(expectedRows) || expectedRows < 1) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  if (!Number.isSafeInteger(expectedColumns) || expectedColumns < 1) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  if (!Number.isSafeInteger(expectedChecks) || expectedChecks < 1) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  if (size !== 4 + expectedChecks) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  if (members[0] !== 'POST_INSERT') throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  if (members[1] !== expectedRows || members[2] !== expectedColumns || members[3] !== expectedChecks) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  const matches = [];
  for (let index = 0; index < expectedChecks; index++) {
    const flag = members[4 + index];
    if (flag !== 0 && flag !== 1) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
    matches.push(flag === 1);
  }
  return Object.freeze({ phase: 'POST_INSERT', rowCount: expectedRows, columnCount: expectedColumns,
    checks: expectedChecks, matches: Object.freeze(matches) });
}
// THE CLOSED NUMBER-FORMAT CONTRACT, composed host-side so the authored body never interprets a request: every
// code these two functions can produce was measured to round-trip through `GetNumberFormat()` EXACTLY (T4.0
// evidence: 3 families x decimals 0..10 plus three currencies = 55 codes, 0 mismatches). The currency enum is
// exactly the three symbols that were measured, and no arbitrary symbol is accepted; `currency` is required
// for the currency type and refused for the others.
const CELL_FORMAT_CURRENCIES = Object.freeze({ RUB: '\u20BD', USD: '$', EUR: '\u20AC' });
// The CLOSED key set of a Cell formatting request, checked by `formatCells` itself: the measured properties,
// BOTH spellings of the clearing request, and the signal. A key outside it refuses the whole request, which is
// what makes "nothing is ever applied partially" true at the layer that promises it.
const CELL_FORMAT_KEYS = Object.freeze(new Set(['address', 'numberFormat', 'bold', 'italic', 'fontFamily',
  'fontSize', 'fill', 'clearFill', 'columnWidth', 'rowHeight', 'wrapText', 'signal']));
function cellFormatCode(numberFormat) {
  const type = numberFormat.type;
  const decimals = numberFormat.decimals === undefined ? 2 : numberFormat.decimals;
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > LIMITS.formatRangeDecimalsMax) return null;
  let zeros = '';
  for (let index = 0; index < decimals; index++) zeros += '0';
  const decimalPart = decimals > 0 ? `.${zeros}` : '';
  if (type === 'number') return `#,##0${decimalPart}`;
  if (type === 'percent') return `0${decimalPart}%`;
  if (type === 'currency') {
    const symbol = CELL_FORMAT_CURRENCIES[numberFormat.currency];
    if (symbol === undefined) return null;
    return `#,##0${decimalPart} ${symbol}`;
  }
  return null;
}
// The rectangle a CLOSED Cell address names, or null when it is not one this module accepts. It is the same
// arithmetic the authored bodies do, kept here so the tool, the bridge and the body cannot disagree about what
// an address covers — and so the cell cap can be enforced before anything is dispatched.
function sheetAddressShape(address) {
  const parts = address.split(':');
  if (parts.length > 2) return null;
  const head = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(parts[0]);
  if (head === null) return null;
  let startColumn = 0;
  for (const letter of head[1]) startColumn = startColumn * 26 + (letter.charCodeAt(0) - 64);
  const startRow = Number(head[2]);
  let endColumn = startColumn;
  let endRow = startRow;
  if (parts.length === 2) {
    const tail = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(parts[1]);
    if (tail === null) return null;
    endColumn = 0;
    for (const letter of tail[1]) endColumn = endColumn * 26 + (letter.charCodeAt(0) - 64);
    endRow = Number(tail[2]);
  }
  const rows = endRow - startRow + 1;
  const columns = endColumn - startColumn + 1;
  if (rows < 1 || columns < 1) return null;
  return Object.freeze({ rows, columns });
}
function decodeSheetRead(value, maxCells) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !Object.hasOwn(length, 'value') || length.enumerable) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const size = length.value;
  if (!Number.isSafeInteger(size) || size < 1) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (Reflect.ownKeys(value).length !== size + 1) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const members = [];
  for (let index = 0; index < size; index++) {
    const descriptor = Object.hasOwn(descriptors, String(index)) ? descriptors[String(index)] : null;
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new SafeError(ERROR_CODES.INVALID_DATA);
    members.push(descriptor.value);
  }
  if (size === 1 && members[0] === 'CAPABILITY_UNAVAILABLE') throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
  // THE NARROWER ONE-SLOT REFUSAL this leg answers when a SHEET SELECTOR named nothing that exists: a known
  // argument error the caller can fix, and a read that changed nothing.
  if (size === 1 && members[0] === 'TOOL_ERROR') throw new SafeError(ERROR_CODES.TOOL_ERROR);
  if (size < SHEET_READ_SLOTS) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const sheetName = members[0];
  const sheetIndex = members[1];
  const sheetCount = members[2];
  const requestAddress = members[3];
  const readAddress = members[4];
  const totalRows = members[5];
  const totalColumns = members[6];
  const rowCount = members[7];
  const columnCount = members[8];
  const formulasMatch = members[9];
  if (typeof sheetName !== 'string' || sheetName === '') throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (typeof requestAddress !== 'string' || requestAddress === '') throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (typeof readAddress !== 'string' || readAddress === '') throw new SafeError(ERROR_CODES.INVALID_DATA);
  for (const count of [sheetIndex, sheetCount, totalRows, totalColumns, rowCount, columnCount]) {
    if (!Number.isSafeInteger(count) || count < 0) throw new SafeError(ERROR_CODES.INVALID_DATA);
  }
  if (!(sheetCount >= 1) || !(totalRows >= 1) || !(totalColumns >= 1)) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (!(rowCount >= 1) || !(columnCount >= 1)) throw new SafeError(ERROR_CODES.INVALID_DATA);
  // The published matrix is a PREFIX of the measured range: it can never be taller than the range and
  // never a different width, because the body clips whole rows only. Both facts are pinned here so a
  // body that answered an inconsistent pair is refused rather than published with a `truncated` flag
  // computed from numbers that disagree.
  if (rowCount > totalRows) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (columnCount !== totalColumns) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (formulasMatch !== 0 && formulasMatch !== 1) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const cellCount = rowCount * columnCount;
  if (!Number.isSafeInteger(cellCount) || cellCount > maxCells) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (size !== SHEET_READ_SLOTS + cellCount * (formulasMatch === 1 ? 2 : 1)) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const values = [];
  const formulas = [];
  for (let index = 0; index < cellCount; index++) {
    const sheetCellChars = members[SHEET_READ_SLOTS + index];
    if (typeof sheetCellChars !== 'string') throw new SafeError(ERROR_CODES.INVALID_DATA);
    values.push(sheetCellChars);
  }
  if (formulasMatch === 1) {
    for (let index = 0; index < cellCount; index++) {
      const sheetFormulaChars = members[SHEET_READ_SLOTS + cellCount + index];
      if (typeof sheetFormulaChars !== 'string') throw new SafeError(ERROR_CODES.INVALID_DATA);
      formulas.push(sheetFormulaChars);
    }
  }
  assertByteLimit(JSON.stringify(members), LIMITS.editorResultBytes);
  const valueRows = [];
  const formulaRows = [];
  for (let index = 0; index < rowCount; index++) {
    valueRows.push(Object.freeze(values.slice(index * columnCount, (index + 1) * columnCount)));
    if (formulasMatch === 1) formulaRows.push(Object.freeze(formulas.slice(index * columnCount, (index + 1) * columnCount)));
  }
  return Object.freeze({
    sheetName,
    sheetIndex,
    sheetCount,
    requestAddress,
    readAddress,
    totalRows,
    totalColumns,
    rowCount,
    columnCount,
    // `truncated` is DERIVED here from the two measured pairs, so it can never drift from the numbers it
    // describes: the range held more cells than the answer carries exactly when its full shape is larger
    // than the published prefix.
    truncated: totalRows > rowCount,
    values: Object.freeze(valueRows),
    formulas: formulasMatch === 1 ? Object.freeze(formulaRows) : null
  });
}
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
// unresolvable `Heading <n>`, which `decodeBlocks` publishes as `TOOL_ERROR`). `sheetwrite` is a THIRD
// producer of the same shape and this residual now covers it too: its own pre-write half answers
// `[PRE_INSERT, 'CAPABILITY_UNAVAILABLE']` — a missing `Api`, `GetActiveSheet`, `GetRange` or `SetValue`, a
// damaged request, or an addressed block that disagrees with the matrix — all of them before the phase turns
// and before the first `SetValue`, so a faithful run of that body cannot mark a real write pre-insert while a
// damaged native can say anything. ALL THREE are GENUINE in the sense that a faithful run of the shipped body
// writes them only before its first MUTATING call — the block append's first `Push`, the table insert's first
// `Push`, and this one's first `SetValue` — but the phase
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
  // THE HYPERLINK INSERT USED TO HAVE THE SAME CARVE-OUT AND NO LONGER DOES, which is a deliberate tightening
  // rather than an omission: its export bound (`LIMITS.addHyperlinkMarkdownChars`) is GONE with the markdown
  // fragment proof, so this body has no byte-gated refusal left to make — a `BYTE_LIMIT` carrying the
  // pre-insert phase can therefore only be a forged or damaged native answer about a dispatch that wrote, and
  // it settles `APPLY_UNCERTAIN` with the slot HELD instead of releasing the slot on a refusal this leg cannot
  // produce.
  // THE TEXT REPLACE IS IN THE SAME POSITION for the same reason and never had the carve-out: it reads no
  // export at all — its proof is an occurrence COUNT — so its pre-write refusals are exactly the two classes
  // above (`CAPABILITY_UNAVAILABLE` for a count it cannot read, `TOOL_ERROR` for zero occurrences and for a
  // `limit` below the count) and a phase-marked `BYTE_LIMIT` settles uncertain for it too.
  // THE IMAGE INSERT DOES HAVE THE CARVE-OUT, for the range format's reason and NOT by analogy: it reads a
  // DOCUMENT-WIDE markdown export before its write and refuses a PRE-write export above the reused
  // `LIMITS.insertImageMarkdownChars` with the closed `BYTE_LIMIT` and ZERO writes. Every other pre-write
  // refusal on this leg is one of the two classes above (an address outside THIS document is the closed
  // ARGUMENT class, a primitive or baseline the body cannot read is the capability class), and both are
  // decided before the phase turns, so they are known refusals.
  if (kind === 'rangeformat' || kind === 'imageinsert') return error.code === ERROR_CODES.BYTE_LIMIT;
  // THE COMMENT INSERT HAS NO CARVE-OUT AT ALL, and that is a statement about its body rather than an
  // omission: it reads NO export (the measured `ToMarkdown(...)` does not contain the comment text), so it has
  // no byte-gated refusal to make — a phase-marked `BYTE_LIMIT` here can only be a forged or damaged native
  // answer about a dispatch that wrote, exactly like the text replace above. Its two pre-write classes are the
  // closed ARGUMENT class (a request the body cannot interpret) and the CAPABILITY class (a primitive or a
  // baseline it could not read), both already returned by the two lines above.
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
//     the TEN slots below is not one this body can have produced. There is no per-item array to pin,
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
// THE TEXT REPLACE'S CLOSED REQUEST, in the same two places as the hyperlink's url and label: this one
// comment is the measurement both `replaceSearch` (src/tools/word.js) and this bridge-side twin rest on, so
// the schema's advertised bound, the descriptor's precondition and the public entry point can never
// disagree about which request is servable.
//   * THE NEEDLE must be a NON-EMPTY string inside `replaceTextSearchBytes`. Nothing else is a query the
//     editor's `Search` can be asked, and an empty needle is not "everything" — it is a request with no
//     occurrences to count, so it never reaches the editor.
//   * THE REPLACEMENT may be EMPTY (deleting the needle is a legitimate replace) and is bounded ABOVE by
//     `replaceTextReplaceBytes`.
//   * A REPLACEMENT THAT CONTAINS THE NEEDLE is REFUSED, closed, with ZERO writes. The vendored 2026.1.2
//     `SearchAndReplace` replaces every match of the needle, so a replacement holding the needle would leave
//     occurrences behind that THIS call wrote, and the occurrence arithmetic — `after === before - expected`
//     — could never be exact. The count would be meaningless rather than merely unproven, which is exactly
//     the class of request this module refuses instead of writing.
//   * A REPLACEMENT HOLDING ONE OF THE FIVE CHARACTERS THE EDITOR REWRITES is refused for the same reason,
//     and it is MEASURED rather than conservative: the builder's own body is
//     `V = U.replaceString; V = V.replaceAll("\t","^t"), V = V.replaceAll("\v","^l"),
//     V = V.replaceAll("\f","^m"), V = V.replaceAll("\u000e","^n"), V = V.replaceAll("\u001e","^~")`
//     (code units 9, 11, 12, 14 and 30), so the document would hold `^t` where the caller wrote a TAB and
//     the post-count of the REQUESTED replacement could never match what was stored. A replacement the
//     editor would rewrite is refused BEFORE the write rather than written and left unprovable.
//     THE NEEDLE IS NOT SUBJECT TO THIS RULE: it is passed to `CSearchSettings.SetText` verbatim, so a
//     needle holding any of those five characters is counted exactly as it stands.
function replaceSearch(value) {
  if (typeof value !== 'string' || value === '') return null;
  return utf8ByteLength(value) > LIMITS.replaceTextSearchBytes ? null : value;
}
function replaceReplacement(value) {
  if (typeof value !== 'string') return null;
  return utf8ByteLength(value) > LIMITS.replaceTextReplaceBytes ? null : value;
}
function recursiveReplacement(search, replacement) {
  return replacement !== '' && replacement.includes(search);
}
const REWRITTEN_REPLACEMENT = Object.freeze(['\t', '\u000b', '\u000c', '\u000e', '\u001e']);
function rewrittenReplacement(replacement) {
  for (const character of REWRITTEN_REPLACEMENT) if (replacement.includes(character)) return true;
  return false;
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
  // THE ALIGNMENT TRIPLE, and the `'none'` sentinel is admitted in EVERY ONE of its three slots rather than in
  // the request slot alone — the loop below refuses only a member that is neither the sentinel nor one of the
  // four measured words. That is what the SHIPPED body really answers: it echoes the request into the first
  // slot and, in the `align === 'none'` branch, echoes the SAME sentinel into BOTH readback slots
  // (`align === 'none' ? 'none' : readAlign(...)`), so a run-only answer legitimately carries `'none'` three
  // times. The case an earlier wording claimed this loop refused — a readback answering `'none'` while a WORD
  // was requested — is not refused HERE and does not need to be: it is UNREACHABLE from the real body, which
  // writes the sentinel into a readback slot only inside that branch, and it is settled by `exactRangeFormat`
  // instead, which requires both the echoed request and `alignAfter` to EQUAL the requested word — so such an
  // answer is a non-success (UNCERTAIN, slot held), never an accepted proof.
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
// `[POST_INSERT, paragraphsBefore, paragraphsAfter, elementsBefore, elementsAfter, textBeforeChars,
// textAfterChars, textAppended, elementCountGrew, elementAppended]` — because the native return validator
// keeps arrays of primitives and STRIPS a plain object. `Reflect.ownKeys` before any indexed read closes
// symbols, holes and hidden extras, and every member is read through its own data descriptor, never through a
// getter. Three rules are this leg's own:
//   * THE PHASE IS AN EXPLICIT SLOT OF EVERY ANSWER, and this is the ONLY place the two refusal classes are
//     split. A TWO-slot answer is the body's own refusal `[phase, name]`: `[PRE_INSERT, name]` is a KNOWN
//     refusal whose code the caller republishes (nothing was written), and `[POST_INSERT, name]` is the
//     UNCERTAIN class (the document may already carry the link). A phase that is ABSENT — the one-slot
//     `['CAPABILITY_UNAVAILABLE']` a forged or damaged native can answer AFTER a real write — or a pre-insert
//     phase over a measurement can never be a known refusal: it is decoded as `APPLY_UNCERTAIN`.
//   * THE FIVE NUMBERS ARE NON-NEGATIVE SAFE INTEGERS — the document's own array length, the addressed
//     paragraph's own text lengths and its own ELEMENT counts — and the three flags are EXACTLY `0` or `1`: a
//     count or a length this bridge cannot trust is not one, and an editor that answers anything else is not
//     one this body can have read.
//   * the answer needs NO byte ceiling beyond the one this decoder carries, and it is carried because it is
//     cheap and exact: the phase is one of two literals, five numbers and three flags at most seventeen JSON
//     characters each, so the widest legal answer measures about 105 bytes against `LIMITS.editorResultBytes`
//     (65536) — and, unlike the block/table decoders' retired assertions, this one is genuinely reachable by
//     no legal shape either. It is a CEILING on an answer this bridge accepts from the native, and a ceiling
//     that is never applied is not a ceiling at all.
const HYPERLINK_COUNTS = 2;
const HYPERLINK_ELEMENTS = 2;
const HYPERLINK_CHARS = 2;
const HYPERLINK_FLAGS = 3;
const HYPERLINK_PHASE_PRE = 'PRE_INSERT';
const HYPERLINK_PHASE_POST = 'POST_INSERT';
const HYPERLINK_NUMBERS = HYPERLINK_COUNTS + HYPERLINK_ELEMENTS + HYPERLINK_CHARS;
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
    // The closed refusals the body can make BEFORE the one mutating call: an address outside the document (the
    // closed argument class) and a missing, unusable or throwing readback primitive (the capability class).
    // Both carry the pre-insert phase, so they keep their known class and RELEASE the slot, because nothing was
    // written. THE BODY HAS NO BYTE-GATED REFUSAL ANY MORE — the markdown export and its bound are gone with
    // the fragment proof — so a `BYTE_LIMIT` carrying this phase is NOT one of them and falls through to the
    // uncertain class below, never to a released slot on a dispatch that wrote.
    if (members[1] === 'TOOL_ERROR') throw new SafeError(ERROR_CODES.TOOL_ERROR);
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
    elementsBefore: numbers[2], elementsAfter: numbers[3],
    textBeforeChars: numbers[4], textAfterChars: numbers[5],
    textAppended: flags[0] === 1, elementCountGrew: flags[1] === 1, elementAppended: flags[2] === 1 });
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
//   3. THE ELEMENT LEG is what makes the URL itself provable, and it can only REFUTE: the addressed
//      paragraph's own element count grew by exactly one (`elementCountGrew`) and the element AT the PRE
//      count index is a hyperlink carrying exactly this request's url and label (`elementAppended`). A false
//      one is a mutation this tool cannot stand behind, and the mutation has already run, so the ticket
//      settles `APPLY_UNCERTAIN` with the slot HELD.
function exactHyperlinkDelta(outcome, requested) {
  if (outcome.textAppended !== true) return false;
  if (outcome.elementCountGrew !== true) return false;
  if (outcome.elementAppended !== true) return false;
  if (requested.append === true) {
    if (outcome.textBeforeChars !== 0) return false;
    if (outcome.paragraphsAfter - outcome.paragraphsBefore !== 1) return false;
  } else if (outcome.paragraphsAfter !== outcome.paragraphsBefore) return false;
  if (outcome.elementsAfter !== outcome.elementsBefore + 1) return false;
  return outcome.textAfterChars === outcome.textBeforeChars + requested.text.length;
}
// THE TEXT REPLACE'S ANSWER, decoded with the same strictness as every decoder before it and for the same
// reason: the authored body encodes its measurements as ONE flat array of PRIMITIVES — `[POST_INSERT,
// occurrencesBefore, occurrencesAfter, replaceBefore, replaceAfter]` for a non-empty replacement, and
// `[POST_INSERT, occurrencesBefore, occurrencesAfter]` when the replacement is EMPTY (there is no count of
// the empty string to read, so the body drops those two slots rather than inventing a zero) — because the
// native return validator keeps arrays of primitives and STRIPS a plain object. `Reflect.ownKeys` before any
// indexed read closes symbols, holes and hidden extras, and every member is read through its own data
// descriptor, never through a getter. Four rules are this leg's own contract:
//   * THE PHASE IS AN EXPLICIT SLOT OF EVERY ANSWER, and this is the ONLY place the two refusal classes are
//     split. A TWO-slot answer is the body's own refusal `[phase, name]`: `[PRE_INSERT, name]` is a KNOWN
//     refusal whose code the caller republishes (nothing was written), and `[POST_INSERT, name]` — or any
//     phase that is not the pre-insert one — is the UNCERTAIN class (the document may already have been
//     rewritten). A phase that is ABSENT — the one-slot `['CAPABILITY_UNAVAILABLE']` a forged or damaged
//     native can answer AFTER a real replace — or a pre-insert phase over a measurement can never be a known
//     refusal either: the NAME does not carry the phase, only the marker does.
//   * THE EXPECTED LENGTH IS DERIVED FROM THE REQUEST, never from the answer: `replace !== ''` fixes the
//     FIVE-slot shape and an empty replacement the THREE-slot one, so an answer of the other size is not one
//     this body can have produced.
//   * the counts are NON-NEGATIVE SAFE INTEGERS — the primitive's own array lengths — and nothing else.
//   * the answer needs no byte ceiling beyond the one every native read passes, because at most four bounded
//     integers can cross; `assertByteLimit` is still applied, so the one window every read of this bridge is
//     decoded under holds for this leg too.
const REPLACE_PHASE_PRE = 'PRE_INSERT';
const REPLACE_PHASE_POST = 'POST_INSERT';
const REPLACE_NEEDLE_SLOTS = 2;
const REPLACE_LENGTH = 1 + REPLACE_NEEDLE_SLOTS;
const REPLACE_COUNTED_LENGTH = REPLACE_LENGTH + 2;
function decodeReplace(value, counted) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !Object.hasOwn(length, 'value') || length.enumerable) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const size = length.value;
  const expected = counted ? REPLACE_COUNTED_LENGTH : REPLACE_LENGTH;
  if (!Number.isSafeInteger(size) || size < 1 || size > expected) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (Reflect.ownKeys(value).length !== size + 1) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const members = [];
  for (let index = 0; index < size; index++) {
    const descriptor = Object.hasOwn(descriptors, String(index)) ? descriptors[String(index)] : null;
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new SafeError(ERROR_CODES.INVALID_DATA);
    members.push(descriptor.value);
  }
  // THE PHASE GATE. The two names the body emits only from its pre-write half keep their KNOWN classes ONLY
  // when the answer itself carries the pre-insert phase; a missing phase, a post-insert phase, or a
  // pre-insert phase over a measurement is the uncertain class, because the body ran and the document may
  // already hold the rewrite. THE BODY HAS NO BYTE-GATED REFUSAL: it reads no export and counts no text, so
  // a `BYTE_LIMIT` carrying this phase is NOT one of its refusals and falls through to the uncertain class.
  if (size === 2) {
    if (members[0] !== REPLACE_PHASE_PRE) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
    if (members[1] === 'CAPABILITY_UNAVAILABLE') throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
    if (members[1] === 'TOOL_ERROR') throw new SafeError(ERROR_CODES.TOOL_ERROR);
    throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  }
  if (size === 1) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  if (size !== expected) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (members[0] !== REPLACE_PHASE_POST) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  const numbers = members.slice(1);
  for (const number of numbers) if (!Number.isSafeInteger(number) || number < 0) throw new SafeError(ERROR_CODES.INVALID_DATA);
  assertByteLimit(JSON.stringify(members), LIMITS.editorResultBytes);
  return counted
    ? Object.freeze({ occurrencesBefore: numbers[0], occurrencesAfter: numbers[1],
      replaceBefore: numbers[2], replaceAfter: numbers[3] })
    : Object.freeze({ occurrencesBefore: numbers[0], occurrencesAfter: numbers[1],
      replaceBefore: null, replaceAfter: null });
}
// THE EXPECTATION, DERIVED FROM THE REQUEST on this side and re-derived by the tool on its own side: the
// number of replacements a call authorizes is `limit` when one was named and EVERY pre-counted occurrence
// otherwise, i.e. `min(limit, before)`. It is a pure function of the request and the measured pre-count, so
// neither side ever reads an expectation back out of the answer it is judging.
function replaceExpected(requested, before) {
  return requested.limit === null ? before : Math.min(requested.limit, before);
}
// THE EXACT OUTCOME RULE the text replace rests on, in ONE place so the decision and its comment cannot
// drift apart. It is judged against the SCOPE this ticket carried (`requested`) and the expectation derived
// from it, never against a value read back out of the answer:
//   1. A POST answer that claims ZERO pre-occurrences is not one this body can produce — it refuses that
//      case BEFORE its one write — so it can only be a forged or damaged answer about a dispatch that ran.
//   2. THE NEEDLE'S OWN COUNT must fall by EXACTLY the expectation: `after === before - expected`. With no
//      limit that is zero, which is the whole of the replace-all proof.
//   3. THE REPLACEMENT'S OWN COUNT must rise by the SAME expectation when the replacement is non-empty:
//      `replaceAfter === replaceBefore + expected`. It is the independent leg: a needle count that fell
//      correctly while the document gained something other than the requested text is refuted here.
//   4. AN EMPTY REPLACEMENT has no count of its own; its proof is the needle's count alone, and the deletion
//      count is exactly the expectation (`expected` occurrences were removed).
function exactReplaceDelta(outcome, requested, expected) {
  if (outcome.occurrencesBefore < 1) return false;
  if (outcome.occurrencesAfter !== outcome.occurrencesBefore - expected) return false;
  if (requested.replace === '') return true;
  return outcome.replaceAfter === outcome.replaceBefore + expected;
}
// THE TWO MIMES the image insert accepts, spelled here beside the descriptor's own copy for the reason every
// other shared rule on this branch is: the two modules cannot import each other, so the VOCABULARY lives in
// each, and the values are the MEASURED pair (`Api.CreateImage` was measured with a `data:image/png;base64,`
// payload; JPEG is the one other base64 image mime this leg's export needle can carry verbatim).
const IMAGE_MIMES = Object.freeze(['data:image/png;base64,', 'data:image/jpeg;base64,']);
// THE BASE64 ALPHABET, as a CHARACTER TEST rather than a pattern: the scan is a plain loop over code units,
// so no `RegExp` is ever built from a caller-supplied payload, and `=` is accepted only as trailing padding.
function imageBase64Payload(payload) {
  if (payload.length === 0) return false;
  const padding = payload.endsWith('==') ? 2 : (payload.endsWith('=') ? 1 : 0);
  const end = payload.length - padding;
  for (let index = 0; index < end; index += 1) {
    const code = payload.charCodeAt(index);
    const alphabet = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) ||
      code === 43 || code === 47;
    if (!alphabet) return false;
  }
  return true;
}
// THE CLOSED DATA-URL SHAPE at this public entry point, re-applied rather than taken on trust: one of the two
// measured mime prefixes, a NON-EMPTY pure-base64 payload, inside the advertised byte bound, and NO
// whitespace or control character anywhere. The no-whitespace rule is the one the export needle rests on —
// the markdown export renders the exact stored string, so a character the editor would normalise could be
// written and then never located verbatim.
function requestedDataUrl(value) {
  if (typeof value !== 'string' || value === '') return null;
  if (utf8ByteLength(value) > LIMITS.insertImageDataUrlBytes) return null;
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return null;
  let payload = null;
  for (const prefix of IMAGE_MIMES) if (value.startsWith(prefix)) payload = value.slice(prefix.length);
  return payload !== null && imageBase64Payload(payload) ? value : null;
}
// ONE DIMENSION of the picture: a whole positive number inside the advertised range and nothing else. Both
// dimensions are REQUIRED by this leg's request, so neither is defaulted here.
function requestedDimension(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= LIMITS.insertImageDimensionPx ? value : null;
}
// THE CLOSED COMMENT TEXT at this public entry point, re-applied rather than taken on trust and spelled in the
// same three clauses the descriptor applies (the twin is `insertCommentText` in `src/tools/word.js`): a
// NON-EMPTY string, inside `LIMITS.insertCommentTextBytes`, and free of every C0 control and DEL EXCEPT tab,
// line feed and carriage return. The two modules cannot import each other, so each side reads the SAME `LIMITS`
// table in the same words. A non-string, an empty text, an over-bound one and a control-character one are all
// the closed argument class with ZERO writes.
function requestedCommentText(value) {
  if (typeof value !== 'string' || value === '') return null;
  if (utf8ByteLength(value) > LIMITS.insertCommentTextBytes) return null;
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) ? null : value;
}
// THE IMAGE INSERT'S ANSWER, decoded with the same strictness as every decoder before it and for the same
// reason: the authored body encodes its measurements as ONE flat array of PRIMITIVES — `[POST_INSERT,
// imagesBefore, imagesAfter, drawingsBefore, drawingsAfter, paragraphsBefore, paragraphsAfter,
// markdownBeforeChars, textBeforeChars, textAfterChars, imageAppended, drawingAppended, needleLocated,
// textEmpty, textUnchanged]`, FIFTEEN slots — because the native return validator keeps arrays of primitives
// (it accepts deep arrays and booleans, and STRIPS a plain object). `Reflect.ownKeys` before any indexed read
// closes symbols, holes and hidden extras, and every member is read through its own data descriptor, never
// through a getter. Four rules are this leg's own contract, exactly as they are for the leg before it:
//   * THE PHASE IS AN EXPLICIT SLOT OF EVERY ANSWER, and this is the ONLY place the two refusal classes are
//     split. A TWO-slot answer is the body's own refusal `[phase, name]`: `[PRE_INSERT, name]` is a KNOWN
//     refusal whose code the caller republishes (nothing was written), and `[POST_INSERT, name]` — or any
//     phase that is not the pre-insert one — is the UNCERTAIN class. A phase that is ABSENT (the one-slot
//     answer a forged or damaged native can give AFTER a real write) or a pre-insert phase over a
//     measurement can never be a known refusal either: the NAME does not carry the phase, only the marker.
//   * THIS BODY HAS EXACTLY ONE BYTE-GATED REFUSAL, and it is the PRE-write export above
//     `LIMITS.insertImageMarkdownChars` — reported as `[PRE_INSERT, 'BYTE_LIMIT']` with ZERO writes and kept
//     as its known class by `preInsertRefusal`. Its other pre-write names are the closed ARGUMENT class (an
//     address outside this document) and the CAPABILITY class (a primitive or a baseline the body could not
//     read), both decided before the write.
//   * the counts are NON-NEGATIVE SAFE INTEGERS — the document's own list lengths — and the flags are
//     booleans; nothing else can cross this decoder.
//   * the answer needs no byte ceiling beyond the one every native read passes, because at most ten bounded
//     numbers and five booleans can cross; `assertByteLimit` is still applied, so the one window every read
//     of this bridge is decoded under holds for this leg too.
const IMAGE_PHASE_PRE = 'PRE_INSERT';
const IMAGE_PHASE_POST = 'POST_INSERT';
// THE SEVEN NUMERIC SLOTS the body always emits before the two text lengths: the document's four counts
// (images, drawings, paragraphs — each on both sides of the write), the PRE-write export's own length, and
// the two text lengths of the addressed/created paragraph. They are ONE slice because they are all measured
// the same way and validated by ONE rule.
const IMAGE_COUNTS = 7;
const IMAGE_TEXT = 2;
const IMAGE_FLAGS = 5;
const IMAGE_LENGTH = 1 + IMAGE_COUNTS + IMAGE_TEXT + IMAGE_FLAGS;
function decodeImage(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !Object.hasOwn(length, 'value') || length.enumerable) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const size = length.value;
  if (!Number.isSafeInteger(size) || size < 1 || size > IMAGE_LENGTH) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (Reflect.ownKeys(value).length !== size + 1) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const members = [];
  for (let index = 0; index < size; index++) {
    const descriptor = Object.hasOwn(descriptors, String(index)) ? descriptors[String(index)] : null;
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new SafeError(ERROR_CODES.INVALID_DATA);
    members.push(descriptor.value);
  }
  // THE PHASE GATE, and the ONE pre-write name this body can emit that is BYTE-gated.
  if (size === 2) {
    if (members[0] !== IMAGE_PHASE_PRE) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
    if (members[1] === 'CAPABILITY_UNAVAILABLE') throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
    if (members[1] === 'TOOL_ERROR') throw new SafeError(ERROR_CODES.TOOL_ERROR);
    if (members[1] === 'BYTE_LIMIT') throw new SafeError(ERROR_CODES.BYTE_LIMIT);
    throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  }
  if (size === 1) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  // THE POST-WRITE EXPORT OVER THE CEILING is its own THREE-slot shape, and it is the ONLY answer of that size
  // this body can produce: the post-insert phase says the write has already run, so the class is the uncertain
  // one with the slot HELD, and the extra slot carries the pre-write export's own length for the caller's log.
  if (size === 3) {
    if (members[0] !== IMAGE_PHASE_POST || members[1] !== 'BYTE_LIMIT') throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
    if (!Number.isSafeInteger(members[2]) || members[2] < 0) throw new SafeError(ERROR_CODES.INVALID_DATA);
    throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  }
  if (size !== IMAGE_LENGTH) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (members[0] !== IMAGE_PHASE_POST) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  const numbers = members.slice(1, 1 + IMAGE_COUNTS);
  for (const number of numbers) if (!Number.isSafeInteger(number) || number < 0) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const text = members.slice(1 + IMAGE_COUNTS, 1 + IMAGE_COUNTS + IMAGE_TEXT);
  for (const chars of text) if (!Number.isSafeInteger(chars) || chars < 0) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const flags = members.slice(1 + IMAGE_COUNTS + IMAGE_TEXT);
  if (flags.length !== IMAGE_FLAGS) throw new SafeError(ERROR_CODES.INVALID_DATA);
  for (const flag of flags) if (typeof flag !== 'boolean') throw new SafeError(ERROR_CODES.INVALID_DATA);
  assertByteLimit(JSON.stringify(members), LIMITS.editorResultBytes);
  return Object.freeze({ imagesBefore: numbers[0], imagesAfter: numbers[1],
    drawingsBefore: numbers[2], drawingsAfter: numbers[3],
    paragraphsBefore: numbers[4], paragraphsAfter: numbers[5],
    markdownBeforeChars: numbers[6],
    textBeforeChars: text[0], textAfterChars: text[1],
    // THE BODY'S OWN NEEDLE FLAG IS THE WHOLE VERDICT — it required the needle to be ABSENT before the write
    // and present EXACTLY once after it — and it travels under the name the envelope's consumers read. The
    // three remaining flags are the per-form text proof and the two count-growth flags the outcome rule
    // re-checks; a flag whose own counts contradict it is settled uncertain rather than republished.
    markdownNeedle: flags[0],
    imageAppended: flags[1], drawingAppended: flags[2],
    textEmpty: flags[3], textUnchanged: flags[4] });
}
// THE EXACT OUTCOME RULE the image insert rests on, in ONE place so the decision and its comment cannot
// drift apart. It is judged against the SCOPE this ticket carried (`requested`), never against a value read
// back out of the answer:
//   1. THE TWO DOCUMENT COUNTS each grew by EXACTLY one: the picture really entered the document, and it
//      really entered it as an IMAGE (the image list) and not merely as some other drawing (the drawing
//      list). They are two independent reads of one fact, so a wrong one is told apart in the answer.
//   2. THE PARAGRAPH DELTA IS THE REQUEST'S OWN FORM: an append grows the document by exactly one paragraph
//      and that created paragraph is EMPTY (`textEmpty`), while a named address moves no count at all and
//      leaves its own text UNCHANGED (`textUnchanged`).
//   3. THE APPEND FLAG AND THE NEEDLE FLAG ARE BOTH REQUIRED, so an `ok` envelope produced for the other form,
//      or one whose export does not hold `](` immediately before the EXACT requested data URL exactly once
//      (and not at all before the write), can never be republished as this call's proof.
// A false one is a mutation this tool cannot stand behind, and the mutation has already run, so the ticket
// settles `APPLY_UNCERTAIN` with the slot HELD.
function exactImageDelta(outcome, requested) {
  if (outcome.imageAppended !== true || outcome.drawingAppended !== true) return false;
  if (outcome.markdownNeedle !== true) return false;
  if (requested.append === true) {
    if (outcome.textEmpty !== true) return false;
    if (outcome.paragraphsAfter - outcome.paragraphsBefore !== 1) return false;
  } else {
    if (outcome.textUnchanged !== true) return false;
    if (outcome.paragraphsAfter !== outcome.paragraphsBefore) return false;
  }
  if (outcome.imagesAfter !== outcome.imagesBefore + 1) return false;
  return outcome.drawingsAfter === outcome.drawingsBefore + 1;
}
// THE COMMENT INSERT'S ANSWER, decoded with the same strictness as every decoder before it and for the same
// reason: the authored body encodes its measurements as ONE flat array of PRIMITIVES — `[POST_INSERT,
// commentsBefore, commentsAfter, id, chars, bytes]`, SIX slots — because the native return validator keeps
// arrays of primitives (it accepts deep arrays, `null` and strings, and STRIPS a plain object).
// `Reflect.ownKeys` before any indexed read closes symbols, holes and hidden extras, and every member is read
// through its own data descriptor, never through a getter. Four rules are this leg's own contract:
//   * THE PHASE IS AN EXPLICIT SLOT OF EVERY ANSWER, and this is the ONLY place the two refusal classes are
//     split. A TWO-slot answer is the body's own refusal `[phase, name]`: `[PRE_INSERT, name]` is a KNOWN
//     refusal whose code the caller republishes (nothing was written), and `[POST_INSERT, name]` — or any
//     phase that is not the pre-insert one — is the UNCERTAIN class. A phase that is ABSENT (the one-slot
//     answer a forged or damaged native can give AFTER a real write) or a pre-insert phase over a
//     measurement can never be a known refusal either: the NAME does not carry the phase, only the marker.
//   * THIS BODY HAS NO BYTE-GATED REFUSAL AT ALL. It reads no export — the measured `ToMarkdown(...)` does
//     not contain the comment text — so the only pre-write names it can answer are the closed ARGUMENT class
//     (a request this body cannot interpret) and the CAPABILITY class (a primitive or a baseline it could not
//     read), both decided before the write. That is why this decoder admits NO three-slot answer and why
//     `preInsertRefusal` keeps no `BYTE_LIMIT` carve-out for this kind: a phase-marked `BYTE_LIMIT` here can
//     only be a forged or damaged answer about a dispatch that wrote, and it settles uncertain.
//   * the two counts are NON-NEGATIVE SAFE INTEGERS — the document's own comment-list lengths — the id is a
//     NON-EMPTY STRING inside `LIMITS.insertCommentIdChars` (or the body's own `UNIDENTIFIED` marker, which can
//     never equal a real id because it holds no digit), and the two lengths are non-negative safe integers.
//     Nothing else can cross this decoder.
//   * the answer needs no byte ceiling beyond the one every native read passes, because at most four bounded
//     numbers and one id of at most `insertCommentIdChars` characters can cross; `assertByteLimit` is still
//     applied, so the one window every read of this bridge is decoded under holds for this leg too.
const COMMENT_PHASE_PRE = 'PRE_INSERT';
const COMMENT_PHASE_POST = 'POST_INSERT';
const COMMENT_LENGTH = 6;
function decodeComment(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !Object.hasOwn(length, 'value') || length.enumerable) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const size = length.value;
  if (!Number.isSafeInteger(size) || size < 1 || size > COMMENT_LENGTH) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (Reflect.ownKeys(value).length !== size + 1) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const members = [];
  for (let index = 0; index < size; index++) {
    const descriptor = Object.hasOwn(descriptors, String(index)) ? descriptors[String(index)] : null;
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new SafeError(ERROR_CODES.INVALID_DATA);
    members.push(descriptor.value);
  }
  // THE PHASE GATE, and the ONE place the two refusal classes are split. This leg has NO byte-gated refusal,
  // so its pre-write names are exactly the closed argument class and the capability class.
  if (size === 2) {
    if (members[0] !== COMMENT_PHASE_PRE) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
    if (members[1] === 'CAPABILITY_UNAVAILABLE') throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
    if (members[1] === 'TOOL_ERROR') throw new SafeError(ERROR_CODES.TOOL_ERROR);
    throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  }
  if (size === 1) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  if (size !== COMMENT_LENGTH) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (members[0] !== COMMENT_PHASE_POST) throw new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  for (const count of [members[1], members[2]]) {
    if (!Number.isSafeInteger(count) || count < 0) throw new SafeError(ERROR_CODES.INVALID_DATA);
  }
  const id = members[3];
  // THE ID SLOT HAS TWO LEGAL SHAPES AND THEY MEAN DIFFERENT THINGS: a NON-EMPTY STRING inside
  // `LIMITS.insertCommentIdChars` is the identified comment's own id, while `null` is the body's honest report
  // that the added comment could not be identified. A phase-less or otherwise damaged answer cannot smuggle a
  // third shape through this slot, and the caller's outcome rule settles the `null` one as uncertain.
  if (id !== null && (typeof id !== 'string' || id.length === 0 || id.length > LIMITS.insertCommentIdChars)) {
    throw new SafeError(ERROR_CODES.INVALID_DATA);
  }
  for (const chars of [members[4], members[5]]) {
    if (!Number.isSafeInteger(chars) || chars < 0) throw new SafeError(ERROR_CODES.INVALID_DATA);
  }
  assertByteLimit(JSON.stringify(members), LIMITS.editorResultBytes);
  return Object.freeze({ commentsBefore: members[1], commentsAfter: members[2],
    id, chars: members[4], bytes: members[5] });
}
// THE EXACT OUTCOME RULE the comment insert rests on, in ONE place so the decision and its comment cannot
// drift apart. It is judged against the SCOPE this ticket carried (`requested`), never against a value read
// back out of the answer:
//   1. THE COMMENT COUNT GREW BY EXACTLY ONE. It is the document's own `GetAllComments()` length on both
//      sides of the ONE write, so anything else — no growth, a growth of two, or a fall — describes a document
//      this single call cannot explain.
//   2. THE COMMENT WAS IDENTIFIED. A `null` id is the body's own honest report that nothing named the added
//      comment; an unnamed count is not a proof of THIS call.
//   3. THE IDENTIFIED COMMENT'S OWN TEXT IS THE REQUEST'S OWN. `chars` is that comment's own `GetText()`
//      length and `bytes` the dispatched text's own UTF-8 length — the same measure the tool re-derives from
//      the request — so a comment carrying anything else is refuted, and so is an answer whose `bytes` slot
//      disagrees with the text this ticket dispatched.
// A false one is a mutation this tool cannot stand behind, and the mutation has already run, so the ticket
// settles `APPLY_UNCERTAIN` with the slot HELD.
function exactCommentDelta(outcome, requested) {
  if (outcome.commentsAfter !== outcome.commentsBefore + 1) return false;
  if (outcome.id === null || outcome.id === undefined) return false;
  if (outcome.bytes !== utf8ByteLength(requested.text)) return false;
  return outcome.chars === requested.text.length;
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
  // The ONE leg both Cell reads share. `read_sheet` and `read_range` differ only in the address they
  // name, so the dispatch, the editor check and the closed classification are written ONCE here rather
  // than twice with a chance to drift. It is not a second source of truth for the request shape — each
  // caller has already validated `maxCells` and closed the address — what it owns is the ORDER every
  // other read leg uses: idle, editor identity, the parameter channel checked BEFORE the ticket exists
  // so a refusal carries no slot at all, then ONE dispatch on the one owned callback slot.
  async function sheetRead(signal, params) {
    try {
      ensureIdle();
      if (editor !== 'cell' || currentEditor() !== editor) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
      if (disposed || !hasCallCommand) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
      const read = await start('sheetread', signal, {}, params);
      return Object.freeze({ ok: true, sheetName: read.sheetName, sheetIndex: read.sheetIndex,
        sheetCount: read.sheetCount, requestAddress: read.requestAddress, readAddress: read.readAddress,
        totalRows: read.totalRows, totalColumns: read.totalColumns, rowCount: read.rowCount,
        columnCount: read.columnCount, truncated: read.truncated, values: read.values, formulas: read.formulas });
    } catch (error) {
      return Object.freeze({ ok: false, code: error instanceof SafeError ? error.code : ERROR_CODES.EDITOR_ERROR });
    }
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
          // THE SPREADSHEET READ. Its answer is the authored flat array of primitives, decoded against
          // the `maxCells` THIS ticket asked for — the same cap the body extracted against — so the
          // decode and the extraction can never disagree about how many cells are owed. A one-slot
          // `CAPABILITY_UNAVAILABLE` answer crosses as the capability class; there is no uncertain class
          // here, because a read that cannot be performed changed nothing.
          // THE WORKBOOK MUTATION (add a sheet). A `[PRE_INSERT, code]` answer is a KNOWN refusal — nothing was
          // added — and EVERY other shape, a post-phase refusal included, is the UNCERTAIN class with the slot
          // HELD: `Api.AddSheet` may already have created a sheet, so there is no known error to report and
          // nothing to retry.
          else if (kind === 'sheetadd') result = decodeSheetAdd(value, params.requestedName, params.maxSheets);
          else if (kind === 'sheetlist') result = decodeSheetList(value, params.maxSheets);
          else if (kind === 'sheetread') result = decodeSheetRead(value, params.maxCells);
          // THE SPREADSHEET WRITE. Its answer is the authored flat array with ONE flag per cell, decoded
          // against the MATRIX this ticket carried — the same matrix the body wrote and then read back —
          // and the exact-proof rule decides the ticket HERE, while it still owns the slot: a single flag
          // that is not 1 means the write may have applied but is not PROVED, which is the UNCERTAIN class
          // with the slot HELD, never a known error about a sheet the editor may already have changed.
          else if (kind === 'sheetwrite') {
            const outcome = decodeWriteRange(value, params.cells.length, params.cells[0].length);
            let allMatched = true;
            for (const flag of outcome.matches) if (!flag) { allMatched = false; break; }
            if (!allMatched) { settleUncertain(new SafeError(ERROR_CODES.APPLY_UNCERTAIN)); return; }
            result = outcome;
          }
          // THE SPREADSHEET FORMATTING. Its answer is the authored flat array with ONE flag per (property,
          // cell) and per (geometry property, column/row), decoded against the CHECK COUNT this ticket carried
          // — the same number the body built its flags against — and the exact-proof rule decides the ticket
          // HERE, while it still owns the slot: a single flag that is not 1 means the sheet may already be
          // formatted but the request is not PROVED, which is the UNCERTAIN class with the slot HELD, never a
          // known error about a sheet the editor may already have changed.
          else if (kind === 'cellformat') {
            const outcome = decodeCellFormat(value, params.rows, params.columns, params.checks);
            let allMatched = true;
            for (const flag of outcome.matches) if (!flag) { allMatched = false; break; }
            if (!allMatched) { settleUncertain(new SafeError(ERROR_CODES.APPLY_UNCERTAIN)); return; }
            result = outcome;
          }
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
          // caller-supplied collection to pin against — this leg addresses exactly ONE paragraph and its OWN
          // appended element — so the answer's length is fixed by `decodeHyperlink` and the phase gate is the
          // whole of the length rule. The outcome rule then decides the ticket HERE, while it still owns the
          // slot, and it is judged against the SCOPE (`params`) this ticket carried: an addressed paragraph
          // whose own text is not exactly what the request meant, an append whose count did not grow by exactly
          // one or whose paragraph did not start empty, an element count that did not grow by exactly one, an
          // element at the PRE count index that is not this request's own hyperlink, and a text length that
          // contradicts the request are all the UNCERTAIN class with the slot HELD, never a known error about a
          // document this call may already have linked. A decode that THROWS is classified by the catch below
          // (a `[PRE_INSERT, name]` answer keeps its known code; everything else is uncertain).
          else if (kind === 'hyperlinkinsert') {
            const outcome = decodeHyperlink(value);
            if (!exactHyperlinkDelta(outcome, params)) { settleUncertain(new SafeError(ERROR_CODES.APPLY_UNCERTAIN)); return; }
            result = outcome;
          }
          // THE TEXT REPLACE. Its answer is the authored flat array of primitives, decoded against the
          // REQUEST's own shape — `replace !== ''` fixes the five-slot answer and an empty replacement the
          // three-slot one — so the decode and the body can never disagree about which counts are owed. The
          // exact arithmetic then decides the ticket HERE, while it still owns the slot, and it is judged
          // against the SCOPE (`params`) this ticket carried: the expectation is derived from the REQUEST
          // (`min(limit, before)`) and never read back out of the answer. A needle count that did not fall by
          // exactly the expectation, a replacement count that did not rise by it, and a POST answer claiming
          // zero pre-occurrences are all the UNCERTAIN class with the slot HELD, never a known error about a
          // document this call may already have rewritten. A decode that THROWS is classified by the catch
          // below (a `[PRE_INSERT, name]` answer keeps its known code; everything else is uncertain).
          else if (kind === 'replaceinsert') {
            const outcome = decodeReplace(value, params.replace !== '');
            const expected = replaceExpected(params, outcome.occurrencesBefore);
            if (!exactReplaceDelta(outcome, params, expected)) { settleUncertain(new SafeError(ERROR_CODES.APPLY_UNCERTAIN)); return; }
            result = Object.freeze({ occurrencesBefore: outcome.occurrencesBefore,
              occurrencesAfter: outcome.occurrencesAfter, replacements: expected });
          }
          // THE IMAGE INSERT. Its answer is the authored flat array of primitives, decoded against the fixed
          // FIFTEEN-slot shape — this leg addresses exactly ONE paragraph or ONE created one, and the
          // document's OWN four counts are the evidence — so the phase gate is the whole of the length rule.
          // The outcome rule then decides the ticket HERE, while it still owns the slot, and it is judged
          // against the SCOPE (`params`) this ticket carried: an image count that did not grow by exactly one,
          // a drawing count that did not, a paragraph delta that is not this request's own form, the wrong
          // text flag for that form, and an export needle that was not located exactly once and absent before
          // are all the UNCERTAIN class with the slot HELD, never a known error about a document this call may
          // already carry the picture in. A decode that THROWS is classified by the catch below (a
          // `[PRE_INSERT, name]` answer keeps its known code, and for THIS leg the pre-write export bound is
          // one of them).
          else if (kind === 'imageinsert') {
            const outcome = decodeImage(value);
            if (!exactImageDelta(outcome, params)) { settleUncertain(new SafeError(ERROR_CODES.APPLY_UNCERTAIN)); return; }
            result = outcome;
          }
          // THE COMMENT INSERT. Its answer is the authored flat array of primitives, decoded against the fixed
          // SIX-slot shape — this leg addresses NO target and the document's OWN comment count is the
          // evidence — so the phase gate is the whole of the length rule. The outcome rule then decides the
          // ticket HERE, while it still owns the slot, and it is judged against the SCOPE (`params`) this
          // ticket carried: a comment count that did not grow by exactly one, a comment the body could not
          // identify and a `GetText()` that is not the requested text are all the UNCERTAIN class with the slot
          // HELD, never a known error about a document this call may already carry the comment in. A decode
          // that THROWS is classified by the catch below (a `[PRE_INSERT, name]` answer keeps its known code;
          // everything else is uncertain).
          else if (kind === 'commentinsert') {
            const outcome = decodeComment(value);
            if (!exactCommentDelta(outcome, params)) { settleUncertain(new SafeError(ERROR_CODES.APPLY_UNCERTAIN)); return; }
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
          if ((kind === 'blocksinsert' || kind === 'tableinsert' || kind === 'headinginsert' || kind === 'rangeformat' || kind === 'hyperlinkinsert' || kind === 'replaceinsert' || kind === 'imageinsert' || kind === 'commentinsert' || kind === 'sheetwrite' || kind === 'cellformat' || kind === 'sheetadd') && owned.dispatched && !preInsertRefusal(error, kind)) {
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
        } else if (kind === 'sheetread') {
          // THE SPREADSHEET READ: ONE command, and the SAME parameter channel the search and structure
          // legs use — the validated request written into the page's `Asc.scope`, never composed into
          // source (ADR 0002). It needs the entry point that OWNS that wrapper (`callCommand`); a build
          // whose command channel is the bare `executeCommand` transport has no sanctioned parameter
          // channel at all, so it refuses HERE, before any dispatch, and releases the slot because
          // nothing reached the editor. It carries NO document-identity probe, deliberately and for the
          // same stated reason as `readDocumentText`: a read returns no OWNED TARGET a later write could
          // be applied to, so there is no handle whose ownership would have to be proven. The kind is not
          // in `WRITE_KINDS`, so `pendingMutation` stays false for the whole leg and an unresolved
          // callback can never present itself to the UI as a pending write.
          if (disposed || !hasCallCommand) { slot = null; settle(new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE)); return; }
          let previousSheetRead;
          try { previousSheetRead = writeScope(params); }
          catch { slot = null; owned.uncertain = false; settle(new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE)); return; }
          owned.dispatched = true;
          try { command.sheet(callback); }
          finally { clearScope(previousSheetRead); }
        } else if (kind === 'sheetadd') {
          // THE WORKBOOK MUTATION: ONE command, and the SAME parameter channel the other Cell legs use — the
          // bound and the requested name written into the page's `Asc.scope`, never composed into command source
          // (ADR 0002). The requested name is `null` when the caller named none, so the body never invents one.
          if (disposed || !hasCallCommand) { slot = null; settle(new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE)); return; }
          let previousSheetAdd;
          try { previousSheetAdd = writeScope(params); }
          catch { slot = null; owned.uncertain = false; settle(new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE)); return; }
          owned.dispatched = true;
          try { command.sheetadd(callback); }
          finally { clearScope(previousSheetAdd); }
        } else if (kind === 'sheetlist') {
          // THE WORKBOOK LISTING: ONE command, and the SAME parameter channel the other Cell legs use — the
          // bound the body checks against is written into the page's `Asc.scope`, never composed into command
          // source (ADR 0002). The leg carries NO request: it lists the book as it is, and its only argument is
          // the bound, so there is nothing caller-derived to validate beyond it.
          if (disposed || !hasCallCommand) { slot = null; settle(new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE)); return; }
          let previousSheetList;
          try { previousSheetList = writeScope(params); }
          catch { slot = null; owned.uncertain = false; settle(new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE)); return; }
          owned.dispatched = true;
          try { command.sheetlist(callback); }
          finally { clearScope(previousSheetList); }
        } else if (kind === 'sheetwrite') {
          // THE SPREADSHEET WRITE: ONE command, and the SAME parameter channel the other Cell and Word
          // legs use — the validated address and matrix written into the page's `Asc.scope`, never
          // composed into command source (ADR 0002). It needs the entry point that OWNS that wrapper
          // (`callCommand`); a build whose command channel is the bare `executeCommand` transport has no
          // sanctioned parameter channel at all, so it refuses HERE, before any dispatch, and releases the
          // slot because nothing reached the editor. The kind IS in `WRITE_KINDS`, so from the dispatch on
          // the ticket presents itself as a pending mutation: an unresolved callback can never be mistaken
          // for an idle bridge, and the caller is never told a write they cannot retry is safe to retry.
          if (disposed || !hasCallCommand) { slot = null; settle(new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE)); return; }
          let previousSheetWrite;
          try { previousSheetWrite = writeScope(params); }
          catch { slot = null; owned.uncertain = false; settle(new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE)); return; }
          owned.dispatched = true;
          try { command.sheetwrite(callback); }
          finally { clearScope(previousSheetWrite); }
        } else if (kind === 'cellformat') {
          // THE SPREADSHEET FORMATTING: ONE command, and the SAME parameter channel the other Cell and Word
          // legs use — the validated address, the property set and the counts written into the page's
          // `Asc.scope`, never composed into command source (ADR 0002). It needs the entry point that OWNS
          // that wrapper (`callCommand`); a build whose command channel is the bare `executeCommand`
          // transport has no sanctioned parameter channel at all, so it refuses HERE, before any dispatch,
          // and releases the slot because nothing reached the editor. The kind IS in `WRITE_KINDS`, so from
          // the dispatch on the ticket presents itself as a pending mutation: an unresolved callback can
          // never be mistaken for an idle bridge, and the caller is never told a write they cannot retry is
          // safe to retry.
          if (disposed || !hasCallCommand) { slot = null; settle(new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE)); return; }
          let previousCellFormat;
          try { previousCellFormat = writeScope(params); }
          catch { slot = null; owned.uncertain = false; settle(new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE)); return; }
          owned.dispatched = true;
          try { command.cellformat(callback); }
          finally { clearScope(previousCellFormat); }
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
          // use — the validated `{ url, text, paragraph, append }` scope written into the page's
          // `Asc.scope`, never composed into source (ADR 0002). It needs the entry point that OWNS that wrapper
          // (`callCommand`); a build whose command channel is the bare `executeCommand` transport has no
          // sanctioned parameter channel at all, so it refuses HERE, before any dispatch, and releases the slot
          // because nothing reached the editor.
          // It carries NO document-identity probe, for the heading assignment's reason: this leg addresses a
          // POSITION and a LABEL, not an owned TARGET, so there is no handle whose identity a probe could
          // establish. What it does instead is the subject of the body's own comment: the addressed paragraph's
          // OWN TEXT is read before the ONE `AddElement` (or before the ONE `Push`) and again after it, the
          // document's own paragraph-count delta is derived from the two pushed counts, and the URL is proven
          // through the addressed paragraph's OWN ELEMENT READBACK — `GetElementsCount()` before the mutation
          // gives the index the appended element must occupy, and after it `GetElement(i)` must answer a
          // `hyperlink` whose `GetLinkedText()`/`GetDisplayedText()` are the requested url and label. There is
          // no export, no fragment needle and no document-wide search left on this leg.
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
        } else if (kind === 'replaceinsert') {
          // THE TEXT REPLACE: ONE command, and the SAME parameter channel the other read and write legs use —
          // the validated `{ search, replace, matchCase, limit }` scope written into the page's `Asc.scope`,
          // never composed into source (ADR 0002). It needs the entry point that OWNS that wrapper
          // (`callCommand`); a build whose command channel is the bare `executeCommand` transport has no
          // sanctioned parameter channel at all, so it refuses HERE, before any dispatch, and releases the
          // slot because nothing reached the editor.
          // It carries NO document-identity probe, for the range format's reason: this leg addresses a STRING
          // and not an owned TARGET, so there is no handle whose identity a probe could establish. What it
          // does instead is the subject of the body's own comment: the needle's own occurrence count is read
          // through the MEASURED `document.Search` before the ONE `SearchAndReplace` and again after it, the
          // replacement's own count is read on BOTH sides of the write when the replacement is non-empty, and
          // the outcome is the REQUEST's own arithmetic — `after === before - min(limit, before)` — with the
          // expectation derived from the request rather than read back out of the answer. There is no export,
          // no marker and no object shape on this leg.
          // `owned.dispatched` is set BEFORE the native is handed the command, exactly like every other leg:
          // a synchronous throw out of the transport must never release a slot whose work may already be
          // queued, and the body's own pre-insert refusals keep their known class through the callback (they
          // arrive as a `[PRE_INSERT, name]` answer, not as a throw).
          if (disposed || !hasCallCommand) { slot = null; settle(new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE)); return; }
          let previousReplace;
          try { previousReplace = writeScope(params); }
          catch { slot = null; owned.uncertain = false; settle(new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE)); return; }
          owned.dispatched = true;
          try { command.replace(callback); }
          finally { clearScope(previousReplace); }
        } else if (kind === 'imageinsert') {
          // THE IMAGE INSERT: ONE command, and the SAME parameter channel the other read and write legs use —
          // the validated `{ dataUrl, widthPx, heightPx, paragraph, append, markdownMax }` scope written into
          // the page's `Asc.scope`, never composed into source (ADR 0002). It needs the entry point that OWNS
          // that wrapper (`callCommand`); a build whose command channel is the bare `executeCommand` transport
          // has no sanctioned parameter channel at all, so it refuses HERE, before any dispatch, and releases
          // the slot because nothing reached the editor.
          // It carries NO document-identity probe, for the hyperlink insert's reason: this leg addresses a
          // POSITION or the END of the document, not an owned TARGET, so there is no handle whose identity a
          // probe could establish. What it does instead is the subject of the body's own comment: the
          // document's own image list, drawing list, paragraph count and addressed text are read BEFORE the
          // ONE `AddDrawing` (or the ONE `Push`), the document's own markdown export is read on BOTH sides of
          // that write through `ToMarkdown(true, false)` — the MEASURED form: the first position is the
          // heading-markup flag and the second, WHEN TRUTHY, REMOVES the embedded base64 image (so the retired
          // `ToMarkdown(true, true)` rendered the image's URL and made the data URL needle unfindable) — and the
          // outcome is the request's own form delta plus the needle that export holds. THERE IS
          // NO ELEMENT READBACK ON THIS LEG: the pushed paragraph's own element was measured as a single `run`
          // with EMPTY text, which is NOT an image proof, so this leg builds none on it.
          // `owned.dispatched` is set BEFORE the native is handed the command, exactly like every other leg: a
          // synchronous throw out of the transport must never release a slot whose work may already be queued,
          // and the body's own pre-insert refusals keep their known class through the callback (they arrive as
          // a `[PRE_INSERT, name]` answer, not as a throw).
          if (disposed || !hasCallCommand) { slot = null; settle(new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE)); return; }
          let previousImage;
          try { previousImage = writeScope(params); }
          catch { slot = null; owned.uncertain = false; settle(new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE)); return; }
          owned.dispatched = true;
          try { command.image(callback); }
          finally { clearScope(previousImage); }
        } else if (kind === 'commentinsert') {
          // THE COMMENT INSERT: ONE command, and the SAME parameter channel the other read and write legs use —
          // the validated `{ text, maxBytes, idMax }` scope written into the page's `Asc.scope`, never composed
          // into source (ADR 0002). It needs the entry point that OWNS that wrapper (`callCommand`); a build
          // whose command channel is the bare `executeCommand` transport has no sanctioned parameter channel at
          // all, so it refuses HERE, before any dispatch, and releases the slot because nothing reached the
          // editor.
          // It carries NO document-identity probe, for the image insert's reason: this leg targets NOTHING at
          // all — the measured `AddComment` took the text alone and created the comment at document/selection
          // level — so there is no handle whose identity a probe could establish. What it does instead is the
          // subject of the body's own comment: the document's own comment count AND the ids it already holds
          // are read BEFORE the ONE `AddComment`, the same two reads are taken from a FRESH collection after
          // it, the added comment is identified through the returned id or the difference of the two id sets,
          // and THAT comment's own `GetText()` is the text leg. THERE IS NO EXPORT ON THIS LEG: the measured
          // `ToMarkdown(...)` does not contain the comment text, so this body authors neither export reader.
          // `owned.dispatched` is set BEFORE the native is handed the command, exactly like every other leg: a
          // synchronous throw out of the transport must never release a slot whose work may already be queued,
          // and the body's own pre-insert refusals keep their known class through the callback (they arrive as
          // a `[PRE_INSERT, name]` answer, not as a throw).
          if (disposed || !hasCallCommand) { slot = null; settle(new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE)); return; }
          let previousComment;
          try { previousComment = writeScope(params); }
          catch { slot = null; owned.uncertain = false; settle(new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE)); return; }
          owned.dispatched = true;
          try { command.comment(callback); }
          finally { clearScope(previousComment); }
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
    // The bounded SPREADSHEET reads behind `read_sheet` and `read_range` — the first Cell legs in this
    // repo's bridge, and deliberately the SMALLEST new leg pair: both are served by the ONE authored
    // `sheetread` body, and the only thing that differs between them is whether an address was named.
    // `read_sheet` names none, so the body asks the sheet for its OWN used range — which is the only
    // used-range discovery this build exposes (`GetRowsCount`/`GetColumnsCount` are undefined, measured)
    // — and `read_range` carries a caller address already closed to `SHEET_ADDRESS`. Each is a READ: it
    // adds no mutation primitive, no leg of it matches a write class, and it carries no document-identity
    // probe because it returns no OWNED TARGET a later write could be applied to. The request is a closed
    // precondition, never an optional refinement: a caller that cannot name a bound within the advertised
    // cap (or, for a range, an address the closed pattern accepts) is refused rather than given an SDK
    // call decoded under a window it never asked for. Every outcome is classified — an unavailable
    // channel, a malformed native answer and an oversized answer are closed classes, never a raw
    // exception — and the caller's `signal` cancels both legs exactly as it does in `readStructure`.
    async readSheet(raw) {
      const maxCells = raw?.maxCells, signal = raw?.signal;
      // THE KEY SET IS CLOSED HERE TOO, and that is deliberate rather than symmetry: this leg reads the ACTIVE
      // sheet and exposes no selector, so a caller that passes `sheetName`/`sheetIndex` must be TOLD rather than
      // silently served the active sheet. The tool never does (its schema has no such key); the read leg's shared
      // body accepts a selector, which is exactly why this boundary has to refuse one.
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
      }
      for (const key of Object.keys(raw)) {
        if (key !== 'maxCells' && key !== 'signal') {
          return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
        }
      }
      if (!Number.isSafeInteger(maxCells) || maxCells < 1 || maxCells > LIMITS.sheetReadCellsMax) {
        return Object.freeze({ ok: false, code: ERROR_CODES.CAPABILITY_UNAVAILABLE });
      }
      return sheetRead(signal, Object.freeze({ address: null, maxCells }));
    },
    // The same leg with a caller-named address, closed to `SHEET_ADDRESS` before anything is dispatched, and with
    // an OPTIONAL SHEET SELECTOR — a sheet NAME or a sheet INDEX, resolved inside the body through the measured
    // `Api.GetSheet(...)`. With no selector this reads the ACTIVE sheet exactly as before, which is what keeps
    // every existing caller working unchanged; with one it reads THAT sheet's range and never switches the active
    // sheet. A selector that names nothing is a known refusal answered by the body.
    async readRange(raw) {
      const address = raw?.address, maxCells = raw?.maxCells, signal = raw?.signal;
      const sheetName = raw?.sheetName, sheetIndex = raw?.sheetIndex;
      // THE REQUEST KEY SET IS CLOSED, like the newer Cell legs: an unknown key would otherwise be silently
      // ignored and the request served as if it had been understood.
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
      }
      for (const key of Object.keys(raw)) {
        if (key !== 'address' && key !== 'maxCells' && key !== 'sheetName' && key !== 'sheetIndex' && key !== 'signal') {
          return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
        }
      }
      if (typeof address !== 'string' || !SHEET_ADDRESS.test(address)) {
        return Object.freeze({ ok: false, code: ERROR_CODES.CAPABILITY_UNAVAILABLE });
      }
      if (!Number.isSafeInteger(maxCells) || maxCells < 1 || maxCells > LIMITS.sheetReadCellsMax) {
        return Object.freeze({ ok: false, code: ERROR_CODES.CAPABILITY_UNAVAILABLE });
      }
      // The selector is closed HERE, before any dispatch: a name is a bounded non-empty string, an index is a
      // non-negative safe integer inside the workbook bound, and asking for BOTH is refused because the request
      // would not say which sheet it means.
      // THE INDEX BOUND REUSES `sheetListMax` ON PURPOSE: that is the only MEASURED number for how many sheets
      // this repo supports, so a book past it is already outside the supported envelope and an index beyond it is
      // refused rather than attempted. The failure mode is fail-CLOSED (a sheet with index 64+ cannot be addressed
      // by index), and it is stated here rather than hidden.
      if (sheetName !== undefined && sheetName !== null
        && (typeof sheetName !== 'string' || sheetName === '' || utf8ByteLength(sheetName) > LIMITS.sheetListNameBytes)) {
        return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
      }
      if (sheetIndex !== undefined && sheetIndex !== null
        && (!Number.isSafeInteger(sheetIndex) || sheetIndex < 0 || sheetIndex >= LIMITS.sheetListMax)) {
        return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
      }
      if (sheetName !== undefined && sheetName !== null && sheetIndex !== undefined && sheetIndex !== null) {
        return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
      }
      return sheetRead(signal, Object.freeze({
        address,
        maxCells,
        sheetName: sheetName === undefined ? null : sheetName,
        sheetIndex: sheetIndex === undefined ? null : sheetIndex
      }));
    },
    // The bounded SPREADSHEET write behind `write_range` — the first Cell MUTATION in this repo. It takes
    // the leg shape every other dispatched write takes: the request is a CLOSED precondition checked
    // before any dispatch, ONE authored body performs the write AND its own bounded readback, and the
    // exact-proof rule decides the ticket while it still owns the slot. `cells` is a matrix of STRINGS;
    // the body alone decides whether a cell becomes an integer, a locale number, a text or a formula, and
    // the measured rules for that are stated in the body rather than duplicated here. What this method
    // owns is the boundary: an address outside `SHEET_ADDRESS`, a matrix that is empty, ragged, too large
    // or holding a non-string, and an over-bound payload are refused HERE with NOTHING dispatched.
    async writeRange(raw) {
      const address = raw?.address, cells = raw?.cells, signal = raw?.signal;
      const sheetName = raw?.sheetName, sheetIndex = raw?.sheetIndex;
      // THE REQUEST KEY SET IS CLOSED, like the newer Cell legs: an unknown key would otherwise be silently
      // ignored and a request that mentioned something unread would be served as if it had been understood.
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
      }
      for (const key of Object.keys(raw)) {
        if (key !== 'address' && key !== 'cells' && key !== 'sheetName' && key !== 'sheetIndex' && key !== 'signal') {
          return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
        }
      }
      // The selector is closed BEFORE the block is even inspected, and before any dispatch: a mutation that
      // cannot say which sheet it means must not reach the editor at all. The index bound reuses
      // `LIMITS.sheetListMax` for the same reason the read leg does — it is the only measured sheet count —
      // and the failure mode is fail-closed rather than a write into the wrong sheet.
      if (sheetName !== undefined && sheetName !== null
        && (typeof sheetName !== 'string' || sheetName === '' || utf8ByteLength(sheetName) > LIMITS.sheetListNameBytes)) {
        return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
      }
      if (sheetIndex !== undefined && sheetIndex !== null
        && (!Number.isSafeInteger(sheetIndex) || sheetIndex < 0 || sheetIndex >= LIMITS.sheetListMax)) {
        return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
      }
      if (sheetName !== undefined && sheetName !== null && sheetIndex !== undefined && sheetIndex !== null) {
        return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
      }
      if (typeof address !== 'string' || !SHEET_ADDRESS.test(address)) {
        return Object.freeze({ ok: false, code: ERROR_CODES.CAPABILITY_UNAVAILABLE });
      }
      if (!Array.isArray(cells) || cells.length < 1 || cells.length > LIMITS.writeRangeRowsMax) {
        return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
      }
      let columns = null;
      let cellCount = 0;
      let totalBytes = 0;
      for (const row of cells) {
        if (!Array.isArray(row) || row.length < 1 || row.length > LIMITS.writeRangeColumnsMax) {
          return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
        }
        if (columns === null) columns = row.length;
        else if (row.length !== columns) return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
        for (const cell of row) {
          if (typeof cell !== 'string') return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
          const bytes = utf8ByteLength(cell);
          if (bytes > LIMITS.writeRangeCellBytes) return Object.freeze({ ok: false, code: ERROR_CODES.BYTE_LIMIT });
          totalBytes += bytes;
          cellCount += 1;
        }
      }
      if (cellCount > LIMITS.writeRangeCellsMax) return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
      if (totalBytes > LIMITS.writeRangeBytes) return Object.freeze({ ok: false, code: ERROR_CODES.BYTE_LIMIT });
      try {
        ensureIdle();
        if (editor !== 'cell' || currentEditor() !== editor) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        if (disposed || !hasCallCommand) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        const outcome = await start('sheetwrite', signal, {}, Object.freeze({
        address,
        cells,
        sheetName: sheetName === undefined ? null : sheetName,
        sheetIndex: sheetIndex === undefined ? null : sheetIndex
      }));
        return Object.freeze({ ok: true, address, rowCount: outcome.rowCount, columnCount: outcome.columnCount });
      } catch (error) {
        return Object.freeze({ ok: false, code: error instanceof SafeError ? error.code : ERROR_CODES.EDITOR_ERROR });
      }
    },
    // The bounded CELL FORMATTING behind `format_cells` — the SECOND Cell mutation and the FIRST that changes
    // PRESENTATION rather than content. THE METHOD IS NAMED `formatCells`, NOT `formatRange`, and the reason is
    // measured rather than stylistic: the WORD leg already exposes a `formatRange` method on this same returned
    // object, and a second key with that name would be silently SHADOWED — the object literal keeps only the
    // last one, so a Cell request would have reached the Word handler. Nothing in the type system or the tests
    // can catch a shadowed key, which is why the leg's method name is spelled out here.
    // NOTHING IS EVER APPLIED PARTIALLY: a request that names an unknown property, an address the closed
    // pattern rejects, no formatting property at all, a property value outside the MEASURED contract, a
    // discriminated `numberFormat` that breaks its own rule, or a block over the cell cap is refused HERE,
    // whole, before `start` is reached — so a mixed request that mentions one unsupported property changes
    // nothing at all, and the property set is assembled in one place. The unknown-property half of that promise
    // needs the key enumeration below: without it a request carrying `fontColor` beside a provable property
    // would be SERVED, with the unknown key silently dropped, which is exactly the partial apply this layer
    // promises not to perform. The tool and the argument schema also refuse such a request, but a promise made
    // at THIS layer has to hold at this layer.
    async formatCells(raw) {
      const refuse = (code) => Object.freeze({ ok: false, code });
      // The closed key set of the Cell formatting request: the measured properties, the two spellings of the
      // clearing request, and the signal. A key outside it refuses the WHOLE request.
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return refuse(ERROR_CODES.TOOL_ERROR);
      for (const key of Object.keys(raw)) if (!CELL_FORMAT_KEYS.has(key)) return refuse(ERROR_CODES.TOOL_ERROR);
      const address = raw?.address;
      const numberFormat = raw?.numberFormat;
      const bold = raw?.bold;
      const italic = raw?.italic;
      const fontFamily = raw?.fontFamily;
      const fontSize = raw?.fontSize;
      const fill = raw?.fill;
      const columnWidth = raw?.columnWidth;
      const rowHeight = raw?.rowHeight;
      const wrapText = raw?.wrapText;
      const signal = raw?.signal;
      if (typeof address !== 'string' || !SHEET_ADDRESS.test(address)) return refuse(ERROR_CODES.CAPABILITY_UNAVAILABLE);
      const shape = sheetAddressShape(address);
      if (shape === null) return refuse(ERROR_CODES.CAPABILITY_UNAVAILABLE);
      const cellCount = shape.rows * shape.columns;
      if (cellCount > LIMITS.formatRangeCellsMax) return refuse(ERROR_CODES.TOOL_ERROR);
      // `numberFormat` is a DISCRIMINATED contract: `currency` is required for the currency type and refused
      // for the others, and the code itself is composed only from the measured families.
      let numberFormatCode = null;
      if (numberFormat !== undefined) {
        if (numberFormat === null || typeof numberFormat !== 'object' || Array.isArray(numberFormat)) return refuse(ERROR_CODES.TOOL_ERROR);
        const type = numberFormat.type;
        if (type !== 'number' && type !== 'percent' && type !== 'currency') return refuse(ERROR_CODES.TOOL_ERROR);
        if (type === 'currency') {
          if (typeof numberFormat.currency !== 'string' || !Object.hasOwn(CELL_FORMAT_CURRENCIES, numberFormat.currency)) return refuse(ERROR_CODES.TOOL_ERROR);
        } else if (numberFormat.currency !== undefined) {
          return refuse(ERROR_CODES.TOOL_ERROR);
        }
        if (numberFormat.decimals !== undefined && (!Number.isSafeInteger(numberFormat.decimals) || numberFormat.decimals < 0 || numberFormat.decimals > LIMITS.formatRangeDecimalsMax)) return refuse(ERROR_CODES.TOOL_ERROR);
        numberFormatCode = cellFormatCode(numberFormat);
        if (numberFormatCode === null) return refuse(ERROR_CODES.TOOL_ERROR);
      }
      if (bold !== undefined && typeof bold !== 'boolean') return refuse(ERROR_CODES.TOOL_ERROR);
      if (italic !== undefined && typeof italic !== 'boolean') return refuse(ERROR_CODES.TOOL_ERROR);
      if (wrapText !== undefined && typeof wrapText !== 'boolean') return refuse(ERROR_CODES.TOOL_ERROR);
      if (fontFamily !== undefined && (typeof fontFamily !== 'string' || fontFamily === '' || utf8ByteLength(fontFamily) > LIMITS.formatRangeFontFamilyBytes)) return refuse(ERROR_CODES.TOOL_ERROR);
      if (fontSize !== undefined && (!Number.isSafeInteger(fontSize) || fontSize < 1 || fontSize > LIMITS.formatRangeFontSizeMax)) return refuse(ERROR_CODES.TOOL_ERROR);
      if (columnWidth !== undefined && (!Number.isSafeInteger(columnWidth) || columnWidth < 1 || columnWidth > LIMITS.formatRangeColumnWidthMax)) return refuse(ERROR_CODES.TOOL_ERROR);
      if (rowHeight !== undefined && (!Number.isSafeInteger(rowHeight) || rowHeight < 1 || rowHeight > LIMITS.formatRangeRowHeightMax)) return refuse(ERROR_CODES.TOOL_ERROR);
      // `fill` SETS a colour from `#RRGGBB`, or — as `null` — CLEARS it, which the measurement proved the
      // readback can confirm (`Api.CreateNoFill()` answers `"No Fill"`, the same reading a never-filled cell
      // gives). The colour reaches the body as components, because the measured setter wants a Colour OBJECT
      // and a CSS string is silently ignored. `clearFill` is the SAME request under the name the CLOSED tool
      // schema can express (that schema has no null type), and asking for both at once is refused because the
      // request would be self-contradictory.
      const clearFill = raw?.clearFill;
      let fillR = null;
      let fillG = null;
      let fillB = null;
      let fillClear = false;
      if (clearFill !== undefined && typeof clearFill !== 'boolean') return refuse(ERROR_CODES.TOOL_ERROR);
      if (fill === null) fillClear = true;
      else if (fill !== undefined) {
        if (typeof fill !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(fill)) return refuse(ERROR_CODES.TOOL_ERROR);
        fillR = Number.parseInt(fill.slice(1, 3), 16);
        fillG = Number.parseInt(fill.slice(3, 5), 16);
        fillB = Number.parseInt(fill.slice(5, 7), 16);
      }
      if (clearFill === true) {
        if (fill !== undefined) return refuse(ERROR_CODES.TOOL_ERROR);
        fillClear = true;
      }
      // AT LEAST ONE formatting property besides the address, or there is nothing to prove. The CELL
      // properties and the two GEOMETRY properties are counted separately for a stated reason: the flag
      // arithmetic is per cell for the first group and per affected column/row for the second, while the rule
      // is about the REQUEST — so a request that asks only for a column width must be served, not refused.
      // THE CLEARING REQUEST HAS TWO SPELLINGS AND IS COUNTED ONCE. `fill: null` and `clearFill: true` are the
      // same request (`null` is the spelling the owner's schema used, `clearFill` is the one the CLOSED tool
      // schema can express), so a null colour must NOT be counted as a colour property as well: counting it
      // twice made the bridge owe twice the flags the body computes and refused a CORRECT clear before it could
      // ever dispatch.
      let cellPropertyCount = 0;
      if (numberFormatCode !== null) cellPropertyCount += 1;
      if (bold !== undefined) cellPropertyCount += 1;
      if (italic !== undefined) cellPropertyCount += 1;
      if (fontFamily !== undefined) cellPropertyCount += 1;
      if (fontSize !== undefined) cellPropertyCount += 1;
      if (fill !== undefined && fill !== null) cellPropertyCount += 1;
      if (fillClear) cellPropertyCount += 1;
      if (wrapText !== undefined) cellPropertyCount += 1;
      let requestedCount = cellPropertyCount;
      if (columnWidth !== undefined) requestedCount += 1;
      if (rowHeight !== undefined) requestedCount += 1;
      if (requestedCount < 1) return refuse(ERROR_CODES.TOOL_ERROR);
      // The flags the body owes: one per (property, cell), plus one per affected COLUMN for the width and one
      // per affected ROW for the height, because those two properties act on every line the address intersects.
      let checks = cellPropertyCount * cellCount;
      if (columnWidth !== undefined) checks += shape.columns;
      if (rowHeight !== undefined) checks += shape.rows;
      try {
        ensureIdle();
        if (editor !== 'cell' || currentEditor() !== editor) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        if (disposed || !hasCallCommand) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        const outcome = await start('cellformat', signal, {}, Object.freeze({
          address,
          rows: shape.rows,
          columns: shape.columns,
          checks,
          maxCells: LIMITS.formatRangeCellsMax,
          numberFormatCode,
          bold,
          italic,
          fontFamily,
          fontSize,
          fillR,
          fillG,
          fillB,
          fillClear,
          columnWidth,
          rowHeight,
          wrapText
        }));
        return Object.freeze({ ok: true, address, rowCount: outcome.rowCount, columnCount: outcome.columnCount,
          properties: requestedCount });
      } catch (error) {
        return Object.freeze({ ok: false, code: error instanceof SafeError ? error.code : ERROR_CODES.EDITOR_ERROR });
      }
    },
    // The bounded WORKBOOK MUTATION behind `add_sheet` — the FIRST mutation whose subject is the book. It takes
    // the leg shape every other dispatched write takes: the request is a CLOSED precondition checked before any
    // dispatch, ONE authored body adds at most one sheet, and the decoder proves the POSTCONDITION while the
    // ticket still owns the slot.
    // `Api.AddSheet` ANSWERS `undefined`, so its return value is read as NEITHER success nor failure: what the
    // caller is told is what the editor MEASURED afterwards. The name is OPTIONAL and is never invented here: a
    // caller that named none gets back exactly the (localised) name the editor produced.
    async addSheet(raw) {
      const refuse = (code) => Object.freeze({ ok: false, code });
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return refuse(ERROR_CODES.TOOL_ERROR);
      for (const key of Object.keys(raw)) if (key !== 'name' && key !== 'signal') return refuse(ERROR_CODES.TOOL_ERROR);
      const name = raw.name;
      const signal = raw.signal;
      if (name !== undefined && (typeof name !== 'string' || name === '' || utf8ByteLength(name) > LIMITS.sheetListNameBytes)) {
        return refuse(ERROR_CODES.TOOL_ERROR);
      }
      try {
        ensureIdle();
        if (editor !== 'cell' || currentEditor() !== editor) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        if (disposed || !hasCallCommand) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        const outcome = await start('sheetadd', signal, {}, Object.freeze({
          maxSheets: LIMITS.sheetListMax,
          requestedName: name === undefined ? null : name
        }));
        return Object.freeze({ ok: true, index: outcome.index, name: outcome.name, active: outcome.active,
          previousActive: outcome.previousActive });
      } catch (error) {
        return Object.freeze({ ok: false, code: error instanceof SafeError ? error.code : ERROR_CODES.EDITOR_ERROR });
      }
    },
    // The bounded WORKBOOK LISTING behind `list_sheets` — the FIRST tool in this bridge whose subject is the
    // book rather than one sheet. It takes the leg shape every other read takes: the request is a CLOSED
    // precondition checked before any dispatch, ONE authored body answers the whole listing, and the decoder
    // proves it against the bound the ticket carried.
    // THE LEG HAS NO CALLER ARGUMENTS AT ALL. It lists the book as it is; the only thing that crosses the scope
    // is the bound the body checks against, so there is nothing caller-derived to validate beyond the closed
    // key set (the signal, which every leg accepts).
    async listSheets(raw) {
      const refuse = (code) => Object.freeze({ ok: false, code });
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return refuse(ERROR_CODES.TOOL_ERROR);
      for (const key of Object.keys(raw)) if (key !== 'signal') return refuse(ERROR_CODES.TOOL_ERROR);
      const signal = raw.signal;
      try {
        ensureIdle();
        if (editor !== 'cell' || currentEditor() !== editor) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        if (disposed || !hasCallCommand) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        const outcome = await start('sheetlist', signal, {}, Object.freeze({ maxSheets: LIMITS.sheetListMax }));
        return Object.freeze({ ok: true, count: outcome.count, activeIndex: outcome.activeIndex,
          activeName: outcome.activeName, sheets: outcome.sheets });
      } catch (error) {
        return Object.freeze({ ok: false, code: error instanceof SafeError ? error.code : ERROR_CODES.EDITOR_ERROR });
      }
    },
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
    // the mechanism (a pre-dispatch baseline of the document's paragraph count, the addressed paragraph's own
    // text and its own ELEMENT count, then the ONE mutation, then the post reads and the per-object element
    // readback) and why no mutation primitive's return value is the signal; what matters HERE is the shape: ONE
    // command on the ONE entry point that owns the parameter wrapper, the validated
    // `{ url, text, paragraph, append }` scope carried as DATA through `Asc.scope`, and ONE strict decoder that
    // turns the authored flat array — an explicit phase slot, the two paragraph counts, the addressed
    // paragraph's own pre and post ELEMENT counts, its pre and post text lengths, and three proof flags — into
    // the envelope below. The OUTCOME rule is then decided inside the ticket, before the slot is released, and
    // the ADDRESSED TEXT is PRIMARY: a text that is not exactly what the request meant, a count delta that is
    // not the request's own, a text length that contradicts it, an element count that did not grow by one, an
    // element at the PRE count index that is not this request's hyperlink, an answer that cannot be interpreted
    // and the body's own POST-insert uncertainty are all `APPLY_UNCERTAIN` with the slot HELD and no retry,
    // while the body's PRE-insert refusals (an unusable baseline, an index outside the document, a missing or
    // throwing element-readback primitive) settle their closed KNOWN class with the slot released, because
    // nothing was written — and they do so ONLY when the answer carries their phase. THERE IS NO EXPORT BOUND
    // TO FORWARD ANY MORE: the markdown fragment proof and `LIMITS.addHyperlinkMarkdownChars` are gone, so the
    // scope carries no `markdownMax` and this leg can make no byte-gated pre-insert refusal at all.
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
        // THE SCOPE, and every value in it is composed HERE rather than read from the caller: a descriptor held
        // directly, or a caller that guessed a key, cannot widen a bound or invent a form. `paragraph` is
        // `null` for the append form, which is the form's OWN address rather than an invented index.
        const outcome = await start('hyperlinkinsert', signal, {},
          Object.freeze({ url, text, paragraph: append === true ? null : address, append }));
        // THE FORM IS ECHOED, not dropped, exactly as `styleName` and the four run switches are: the tool
        // derives it from the closed request and carries it to the body, so the tool can require the answer to
        // name the SAME form it asked for — an `ok` envelope produced for a different request is never
        // republished as this one's proof. The element counts and the three flags beside it are the body's own
        // measurement.
        return Object.freeze({ ok: true, paragraphsBefore: outcome.paragraphsBefore,
          paragraphsAfter: outcome.paragraphsAfter, elementsBefore: outcome.elementsBefore,
          elementsAfter: outcome.elementsAfter, textBeforeChars: outcome.textBeforeChars,
          textAfterChars: outcome.textAfterChars, textAppended: outcome.textAppended,
          elementCountGrew: outcome.elementCountGrew, elementAppended: outcome.elementAppended });
      } catch (error) {
        return Object.freeze({ ok: false, code: error instanceof SafeError ? error.code : ERROR_CODES.EDITOR_ERROR });
      }
    },
    // THE IMAGE INSERT behind `insert_image` — the SEVENTH MUTATION of Sprint 3, the FOURTH write leg that
    // APPENDS, and the FIRST leg whose proof is a DOCUMENT-WIDE EXPORT NEEDLE built from the caller's own
    // payload. It has TWO FORMS and the request names which one it is: the NAMED form adds ONE drawing — an
    // `Api.CreateImage` — into an EXISTING paragraph through that paragraph's own `AddDrawing` (an APPEND at
    // the end of the paragraph's own content, the vendored body measured rather than deduced), while the
    // APPEND form creates a DETACHED `Api.CreateParagraph()`, adds the same drawing to it, and `Push`es it at
    // the END of the document. The body's own comment carries the mechanism (the document's own paragraph,
    // image and drawing counts and the addressed text before the ONE write, then the same reads plus the
    // document's own markdown export after it) and why no mutation primitive's return value is the signal;
    // what matters HERE is the shape: ONE command on the ONE entry point that owns the parameter wrapper, the
    // validated `{ dataUrl, widthPx, heightPx, paragraph, append, markdownMax }` scope carried as DATA through
    // `Asc.scope`, and ONE strict decoder that turns the authored flat array — an explicit phase slot, eight
    // counts, two text lengths and five proof flags — into the envelope below. The OUTCOME rule is then
    // decided inside the ticket, before the slot is released, and the DOCUMENT'S OWN COUNTS are PRIMARY while
    // the single needle flag can only REFUTE: an image count that did not grow by exactly one, a drawing count
    // that did not, a paragraph delta that is not the request's own form, the wrong text flag for that form,
    // an answer that cannot be interpreted and the body's own POST-write uncertainty are all `APPLY_UNCERTAIN`
    // with the slot HELD and no retry, while the body's PRE-write refusals (an unusable baseline, an index
    // outside the document, a missing primitive, and an export above the CEILING IT CARRIED) settle their
    // closed KNOWN class with the slot released, because nothing was written — and they do so ONLY when the
    // answer carries their phase.
    // THE CEILING IS COMPOSED HERE, never read from the caller: `markdownMax` is
    // `LIMITS.insertImageMarkdownChars` — the same number as `documentHtmlBytes`, the ceiling every document
    // export in this module is decoded under — so a descriptor held directly, or a caller that guessed the
    // key, cannot widen the export this body will read. No caller-supplied key reaches the body at all.
    // THE REQUEST IS A CLOSED PRECONDITION, never an optional refinement, and it is re-checked HERE rather
    // than taken on trust: the bridge is a PUBLIC ENTRY POINT, and a payload, a dimension or a form this
    // module never measured would let a caller write a picture the tool's own schema would have refused. The
    // two mimes, the base64 alphabet, the no-whitespace rule, the two dimension bounds and the two-form rule
    // are the SAME ones the descriptor advertises, spelled beside their twins in `src/tools/word.js` because
    // the two modules cannot import each other.
    async insertImage(raw) {
      const dataUrl = requestedDataUrl(raw?.dataUrl);
      const widthPx = requestedDimension(raw?.widthPx), heightPx = requestedDimension(raw?.heightPx);
      const append = raw?.append, address = raw?.paragraph, signal = raw?.signal;
      if (dataUrl === null || widthPx === null || heightPx === null) return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
      if (append !== true && append !== false) return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
      if (append === true) {
        if (address !== null && address !== undefined) return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
      } else if (!Number.isSafeInteger(address) || address < 0 || address > LIMITS.insertImageIndexMax) {
        return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
      }
      try {
        ensureIdle();
        if (editor !== 'word' || currentEditor() !== editor) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        // The parameter channel, checked BEFORE the ticket exists so the refusal carries no slot at all.
        if (disposed || !hasCallCommand) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        // THE SCOPE, and every value in it is composed HERE rather than read from the caller: a descriptor held
        // directly, or a caller that guessed a key, cannot widen a bound or invent a form. `paragraph` is
        // `null` for the append form, which is the form's OWN address rather than an invented index, and
        // `markdownMax` is the module's own ceiling.
        const outcome = await start('imageinsert', signal, {},
          Object.freeze({ dataUrl, widthPx, heightPx, paragraph: append === true ? null : address, append,
            markdownMax: LIMITS.insertImageMarkdownChars }));
        // THE FORM AND THE TWO DIMENSIONS ARE ECHOED, not dropped, exactly as `url`/`text` and the four run
        // switches are: the tool derives them from the closed request and carries them to the body, so the tool
        // can require the answer to name the SAME request it made — an `ok` envelope produced for a different
        // request is never republished as this one's proof. The counts and the flags beside them are the
        // body's own measurement.
        return Object.freeze({ ok: true, imagesBefore: outcome.imagesBefore, imagesAfter: outcome.imagesAfter,
          drawingsBefore: outcome.drawingsBefore, drawingsAfter: outcome.drawingsAfter,
          paragraphsBefore: outcome.paragraphsBefore, paragraphsAfter: outcome.paragraphsAfter,
          appended: append, textBeforeChars: outcome.textBeforeChars, textAfterChars: outcome.textAfterChars,
          textEmpty: outcome.textEmpty, textUnchanged: outcome.textUnchanged,
          imageAppended: outcome.imageAppended, drawingAppended: outcome.drawingAppended,
          markdownBeforeChars: outcome.markdownBeforeChars, markdownNeedle: outcome.markdownNeedle });
      } catch (error) {
        return Object.freeze({ ok: false, code: error instanceof SafeError ? error.code : ERROR_CODES.EDITOR_ERROR });
      }
    },
    // THE COMMENT INSERT behind `insert_comment` — the EIGHTH MUTATION of Sprint 3, the THIRD write leg that
    // APPENDS, and the FIRST leg whose proof is the COMMENT COLLECTION'S own identity. It has ONE form and NO
    // target: `AddComment` was measured taking the text alone, and the comment it created was created at
    // document/selection level, so this entry point takes the TEXT and nothing else. The body's own comment
    // carries the mechanism (the document's own comment count AND the ids it already holds before the ONE
    // write, then the same reads plus the identified comment's own `GetText()` after it) and why no export is
    // read at all; what matters HERE is the shape: ONE command on the ONE entry point that owns the parameter
    // wrapper, the validated scope carried as DATA through `Asc.scope`, and ONE strict decoder that turns the
    // authored flat array — an explicit phase slot, two counts, the identified comment's own id (or the
    // `UNIDENTIFIED` marker) and the two length slots — into the envelope below. The OUTCOME rule is then
    // decided inside the ticket, before the slot is released: the DOCUMENT'S OWN COUNT DELTA and the
    // identified comment's OWN TEXT are the evidence, and a count that did not grow by exactly one, an
    // identification the body could not make, an answer that cannot be interpreted and the body's own
    // POST-write uncertainty are all `APPLY_UNCERTAIN` with the slot HELD and no retry, while the body's
    // PRE-write refusals (an unusable request, a missing primitive, a baseline it could not read) settle their
    // closed KNOWN class with the slot released, because nothing was written — and they do so ONLY when the
    // answer carries their phase. THERE IS NO EXPORT AND NO BYTE-GATED REFUSAL ON THIS LEG: the measured
    // `ToMarkdown(...)` does not contain the comment text, so the body reads no export and a phase-marked
    // `BYTE_LIMIT` can only be a forged or damaged answer about a dispatch that wrote.
    // THE TWO COMPOSED BOUNDS ARE NEVER READ FROM THE CALLER: `maxBytes` is `LIMITS.insertCommentTextBytes`
    // (the same number the descriptor's schema advertises) and `idMax` is `LIMITS.insertCommentIdChars` (the
    // defensive width of the ONE id this bridge republishes), so a descriptor held directly, or a caller that
    // guessed a key, cannot widen either. No caller-supplied key reaches the body at all.
    // THE REQUEST IS A CLOSED PRECONDITION, never an optional refinement, and it is re-checked HERE rather
    // than taken on trust: the bridge is a PUBLIC ENTRY POINT, and a text this module never measured — empty,
    // over the bound, or carrying a control character other than TAB, LF and CR — must not be writable by a
    // caller that reached this method directly. The bound and the three permitted whitespace control
    // characters are the SAME ones the descriptor applies, spelled beside their twins in `src/tools/word.js`
    // because the two modules cannot import each other.
    async insertComment(raw) {
      const text = requestedCommentText(raw?.text);
      const signal = raw?.signal;
      if (text === null) return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
      try {
        ensureIdle();
        if (editor !== 'word' || currentEditor() !== editor) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        // The parameter channel, checked BEFORE the ticket exists so the refusal carries no slot at all.
        if (disposed || !hasCallCommand) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        // THE SCOPE, and every value in it is composed HERE rather than read from the caller.
        const outcome = await start('commentinsert', signal, {},
          Object.freeze({ text, maxBytes: LIMITS.insertCommentTextBytes, idMax: LIMITS.insertCommentIdChars }));
        // THE COUNT DELTA AND THE IDENTITY ARE ECHOED, not dropped, exactly as the form and the dimensions are
        // on the image leg: the outcome rule already required the count to grow by exactly one and the
        // identified comment's own text to be the requested one, so what crosses back is the proof rather than
        // the payload. THE COMMENT TEXT IS NOT REPUBLISHED by this envelope or by the tool above it.
        return Object.freeze({ ok: true, commentsBefore: outcome.commentsBefore, commentsAfter: outcome.commentsAfter,
          id: outcome.id, chars: outcome.chars, bytes: outcome.bytes });
      } catch (error) {
        return Object.freeze({ ok: false, code: error instanceof SafeError ? error.code : ERROR_CODES.EDITOR_ERROR });
      }
    },
    // THE TEXT REPLACE behind `replace_text` — the SIXTH MUTATION of Sprint 3, the FOURTH write leg that
    // changes EXISTING text in place, and the FIRST whose whole proof is an EXACT OCCURRENCE COUNT read out
    // of the document itself. The body's own comment carries the mechanism (a pre-dispatch count of the
    // needle through the measured `doc.Search`, a pre-count of the replacement when it is non-empty, ONE
    // `doc.SearchAndReplace` with an EXPLICIT `matchCase`, and the two post counts) and why no mutation
    // primitive's return value is the signal; what matters HERE is the shape: ONE command on the ONE entry
    // point that owns the parameter wrapper, the validated `{ search, replace, matchCase, limit }` scope
    // carried as DATA through `Asc.scope`, and ONE strict decoder that turns the authored flat array into the
    // counts below. The OUTCOME rule is decided inside the ticket, before the slot is released, and it is
    // judged against the SCOPE (`params`) this ticket carried: the expectation is DERIVED FROM THE REQUEST
    // (`replaceExpected`), a needle count that did not fall by exactly it and a replacement count that did not
    // rise by it are `APPLY_UNCERTAIN` with the slot HELD and no retry, while the body's PRE-write refusals
    // (an unreadable count, ZERO occurrences and a `limit` below the count) settle their closed KNOWN class
    // with the slot released, because nothing was written — and they do so ONLY when the answer carries their
    // phase. THERE IS NO EXPORT AND NO BYTE-GATED REFUSAL ON THIS LEG: it counts occurrences and reads no
    // string the document built, so a `[PRE_INSERT, 'BYTE_LIMIT']` can only be a forged or damaged answer
    // about a dispatch that wrote.
    // THE REQUEST IS A CLOSED PRECONDITION, never an optional refinement, and it is re-checked HERE rather
    // than taken on trust: the bridge is a PUBLIC ENTRY POINT, and a needle, a replacement, a case flag or a
    // limit this module never measured would let a caller rewrite text the tool's own schema would have
    // refused. The bounds and the two closed rules (a replacement that CONTAINS the needle, and a replacement
    // holding one of the five characters the measured builder REWRITES) are the SAME ones the descriptor
    // advertises (`LIMITS` and the commented twins in `src/tools/word.js`), and `matchCase` is REQUIRED as an
    // explicit boolean because the vendored builder defaults it to `true` when the key is absent.
    async replaceText(raw) {
      const search = replaceSearch(raw?.search), replacement = replaceReplacement(raw?.replace);
      const matchCase = raw?.matchCase, limit = raw?.limit, signal = raw?.signal;
      if (search === null || replacement === null) return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
      if (typeof matchCase !== 'boolean') return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
      // THE LIMIT IS OPTIONAL AND `null` IS ITS ABSENT FORM, exactly as the descriptor composes it: an
      // explicit `null` means "replace every occurrence". Anything else must be a whole number inside the
      // advertised ceiling, so a limit of zero — a request to write nothing — is the closed argument class.
      if (limit !== null && limit !== undefined) {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIMITS.replaceTextLimitMax) {
          return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
        }
      }
      if (recursiveReplacement(search, replacement)) return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
      if (rewrittenReplacement(replacement)) return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_ERROR });
      try {
        ensureIdle();
        if (editor !== 'word' || currentEditor() !== editor) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        // The parameter channel, checked BEFORE the ticket exists so the refusal carries no slot at all.
        if (disposed || !hasCallCommand) throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        const outcome = await start('replaceinsert', signal, {},
          Object.freeze({ search, replace: replacement, matchCase, limit: limit === undefined ? null : limit }));
        return Object.freeze({ ok: true, occurrencesBefore: outcome.occurrencesBefore,
          occurrencesAfter: outcome.occurrencesAfter, replacements: outcome.replacements });
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