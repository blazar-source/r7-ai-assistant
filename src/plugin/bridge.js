import { LIMITS } from '../shared/limits.js';
import { assertByteLimit } from '../shared/bytes.js';
import { ERROR_CODES, SafeError } from '../shared/errors.js';

// Identity leases persist through disposal: replacing a JS adapter is not proof
// that queued SDK work was retracted. Only a genuinely new initialized plugin
// object may start a new lifecycle. Never call SDK outside this sole bridge.
const pluginOwners = new WeakSet();
const MUTATION_REASON = 'EXPLICIT_OWNED_PREVIEW_REQUIRED';
const presenceKeys = Object.freeze(['api', 'getDocument', 'getDocumentId', 'replaceTextSmart', 'getRangeBySelect', 'isTrackRevisions']);

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
  if (kind === 'write' || kind === 'insert') return new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
  return new SafeError(ERROR_CODES.EDITOR_ERROR);
}
// The deadline expiring is its own class, never an editor error: the callback simply never arrived.
// `dispatched` is the whole distinction: a write-class ticket whose mutation WAS dispatched may have
// applied (uncertain), while one that dispatched NOTHING — an insert whose pre-dispatch baseline never
// answered — is a KNOWN timeout. Reporting it as uncertain would be a false uncertainty about a
// mutation that never happened, and (until the slot is released) it wedged the bridge.
function timeoutFor(kind, dispatched) {
  if ((kind === 'write' || kind === 'insert') && dispatched) return new SafeError(ERROR_CODES.APPLY_UNCERTAIN);
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
  return slot !== null && (slot.kind === 'write' || slot.kind === 'insert') && slot.dispatched;
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
        settle(errorFor(kind, pending && (kind === 'write' || kind === 'insert') ? null : new SafeError(ERROR_CODES.CANCELLED)));
      }
      owned.cancel = cancel;
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
        if (slot !== owned || owned.settled) return;
        owned.uncertain = true;
        settle(new SafeError(ERROR_CODES.APPLY_UNCERTAIN));
        notify();
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
