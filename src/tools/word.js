// src/tools/word.js — representative Word tools; Sprint 3+ adds the full catalogue here.
//
// A descriptor here is one author-written static handler: the model's arguments arrive already
// validated by the registry's closed schema, so a handler only classifies, measures and passes
// them on. Handlers never touch the SDK, the DOM or localStorage: everything crosses the injected
// `bridge`, which is the only component that owns an R7 callback slot.
import { defineTool } from './registry.js';
import { ERROR_CODES } from '../shared/errors.js';
import { AGENT_CEILINGS, LIMITS } from '../shared/limits.js';
import { utf8ByteLength } from '../shared/bytes.js';

// Every refusal this module writes carries a closed class, never a raw exception message.
const REFUSAL = 'отказ';

function ok(data) { return Object.freeze({ ok: true, data: Object.freeze(data) }); }
function known(code = ERROR_CODES.TOOL_ERROR) { return Object.freeze({ ok: false, code, message: REFUSAL }); }

// A bridge that does not expose an entry point cannot serve the tool: that is a capability refusal,
// not a crash and never a raw TypeError.
function missingBridgeMethod(bridge, name) {
  return !bridge || typeof bridge !== 'object' || typeof bridge[name] !== 'function';
}
// A bridge refusal crosses back as a plain classified object. Only a class from the closed
// vocabulary is republished; anything else is the tool-error class.
function refusalCode(code, fallback) {
  return typeof code === 'string' && ERROR_CODES[code] === code ? code : fallback;
}
// Word is the only editor this module describes, and the descriptor says so explicitly: a tool
// offered outside Word refuses before any dispatch.
function wrongEditor(ctx, fallback) {
  return ctx?.editor === 'word' ? null : { code: fallback, message: REFUSAL };
}
// The ONE bridge class that means "this mutation may already have applied". The bridge expresses it in
// two shapes — a thrown SafeError and, because `insertParagraph` catches its own ticket settlement, a
// RETURNED `{ok:false, code:'APPLY_UNCERTAIN'}` envelope — and both legs must classify it identically:
// the handler publishes the runtime's own uncertain class, so the run stops fail-safe instead of
// treating a mutation whose outcome is unknown as an ordinary known error.
// Membership-certified, never compared against a caller-supplied string: only a `code` that
// ERROR_CODES itself defines can be classified, so an arbitrary bridge code keeps its closed fallback.
// `APPLY_UNCERTAIN` is the only uncertain class this run's ERROR_CODES defines for a bridge result;
// CANCELLED (an aborted read, and an insert aborted BEFORE dispatch) and TIMEOUT (the non-write legs)
// are KNOWN outcomes and stay ordinary classified errors. `TOOL_UNCERTAIN` is deliberately not
// remapped — it is the runtime-facing class this handler already produces, so republishing it would
// only launder a handler that illegally returned its own output class.
function uncertainResult(result) {
  if (!result || typeof result !== 'object' || result.code !== ERROR_CODES.APPLY_UNCERTAIN) return null;
  return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_UNCERTAIN, message: REFUSAL });
}

// A byte bound is a static literal per scope, never a computed read of a caller-controlled key:
// the schema advertises the largest bound, and the per-scope ceiling is applied where the read is
// requested. The bridge decodes the returned text under its own editor-result ceiling too.
// Each scope names its OWN AGENT_CEILINGS entry. The three ceilings are equal today, so an alias
// (serving `structure` from `section`) would be invisible at runtime and would become silently wrong
// the moment they diverge, so no scope may be mapped through another scope's entry.
const CONTEXT_READ_BYTES = Object.freeze({
  paragraph: AGENT_CEILINGS.contextReadBytes.paragraph,
  section: AGENT_CEILINGS.contextReadBytes.section,
  structure: AGENT_CEILINGS.contextReadBytes.structure
});
// The advertised scopes are also the ones the preconditions serve: a scope this closed set does not
// name is refused before any dispatch, so the schema never advertises one the code cannot serve.
const SCOPES = Object.freeze({ paragraph: true, section: true, structure: true });
// A pure per-scope lookup of the closed table above: no comparison chain and no scope served from
// another scope's budget. The closed SCOPES set is checked before this is called; the fallback only
// keeps an unexpected key on the smallest budget.
function scopeLimit(scope) {
  return Object.hasOwn(CONTEXT_READ_BYTES, scope) ? CONTEXT_READ_BYTES[scope] : CONTEXT_READ_BYTES.paragraph;
}

// The read_context index is 0-based and bounded by the schema. The runtime publishes no structure
// count yet, so this closed upper bound is the only bound the precondition can apply; a genuinely
// established document count would tighten it where the structure read resolves the address.
const MAX_CONTEXT_INDEX = 64;

// The exact bytes of ONE tool-result ENTRY in the form the runtime serializes and bounds:
// `JSON.stringify({ tool, ok: true, data })` — the shape `stringifyToolResults` (src/agent/protocol.js)
// builds from `{ tool, ...result }` for the handler's own `ok(data)` result and measures against
// `AGENT_CEILINGS.toolResultBytes`, and the shape whose refusal `appendToolResults`
// (src/agent/runtime.js:27-36) turns into the literal "the tool result could not be serialized". This
// module cannot import that function (src/agent/* is the runtime's own layer), so it reproduces the
// shape; tests pin the two together by measuring the real serializer against the published result.
// `utf8ByteLength` counts a STRING value's contribution exactly as `JSON.stringify` emits it, including
// the `\uXXXX` escaping of control characters and lone surrogates, so the whole entry is measured, not
// just the text.
// There is ONE such measurement for the whole module — every read handler's bound is this call, and the
// per-tool wrappers below only name the data object their handler publishes. That is deliberate: a
// second, competing measurement of the same entry is how `read_selection` and `read_context` came to
// bound their raw text alone while the entries they published were refused, so the shape cannot be
// allowed to drift from one tool to the next.
function toolResultEntryBytes(tool, data) {
  let serialized;
  try { serialized = JSON.stringify({ tool, ok: true, data }); }
  catch { return null; }
  return typeof serialized === 'string' ? utf8ByteLength(serialized) : null;
}
// `read_document_text`'s own entry: `truncated` and `nextOffset` are ONE fact (`nextOffset !== null`),
// exactly as the handler publishes them.
function documentEntryBytes(text, offset, totalChars, nextOffset) {
  return toolResultEntryBytes('read_document_text',
    { text, offset, totalChars, truncated: nextOffset !== null, nextOffset });
}
// `read_selection`'s own entry, measured on the values ABOUT TO BE PUBLISHED (`text` and its own byte
// count), exactly like the two reads above it.
function selectionEntryBytes(text, bytes) {
  return toolResultEntryBytes('read_selection', { text, bytes });
}
// `read_context`'s own entry, measured on the fields its handler republishes — including the scope and
// the index, which are part of the entry the runtime bounds.
function contextEntryBytes(scope, index, text, bytes) {
  return toolResultEntryBytes('read_context', { scope, index, text, bytes });
}
// The slice is over UTF-16 code units, so a cut can land BETWEEN the two units of one character's
// surrogate pair. A chunk that begins on a low surrogate or ends on an unpaired high one is not a
// well-formed string (JSON.stringify would emit a 6-byte `\ud83d` escape and the raw code unit never
// becomes UTF-8), which is the cut `prefixWithin` in src/agent/context.js already steps back to avoid.
// The same rule is applied here, to BOTH ends:
//   * a START inside a pair is moved back over the low surrogate, to the pair's high unit — the chunk
//     then begins on a complete character and not on half of one;
//   * an END inside a pair is moved forward past the low surrogate, so the pair is completed instead of
//     being truncated to its high unit.
// Moving OUTWARD is what keeps the walk exact: the returned chunk still covers a whole character, its
// resume point is the next character's first unit, and `nextOffset > offset` always advances, so an
// offset that names the tail of a pair can neither repeat a chunk nor stall a resumed read.
function characterStart(text, offset) {
  const previous = text.charCodeAt(offset - 1);
  const current = text.charCodeAt(offset);
  return offset > 0 && previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff
    ? offset - 1 : offset;
}
function characterEnd(text, cut) {
  const previous = text.charCodeAt(cut - 1);
  const current = text.charCodeAt(cut);
  return cut < text.length && previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff
    ? cut + 1 : cut;
}
// ONE chunk exactly as the handler publishes it, built and measured from the SAME `end`: the served
// text, the `truncated`/`nextOffset` pair, and the byte count of the result entry the runtime will
// serialize (`documentEntryBytes`, the module's one measurement). Everything the entry publishes is
// derived here, so the value measured is the value returned, byte for byte — there is no second,
// competing measurement that a field-width change could make drift from the returned shape.
// `truncated` and `nextOffset` are ONE fact: a successor exists exactly when the chunk did not reach
// the end of the document, and a chunk that ends exactly at the end — or an offset at or past it — has
// none. Everything is counted in the string's own code units, the same unit `offset`/`maxChars`/
// `totalChars` use, so a resumed read is contiguous and cannot skip. A chunk that consumed NOTHING has
// no successor to publish: publishing `nextOffset === offset` would invite a call that returns the same
// empty chunk forever. A chunk the ADDRESS BOUND stopped publishes that bound as its resume point — an
// address the schema accepts, whose read is the empty tail — because the bound and the end of the text
// are the same place from here.
function publishedChunk(document, start, end, offset, totalChars) {
  const text = document.slice(start, end);
  const nextOffset = end > offset && end < totalChars ? end
    : end === LIMITS.readDocumentOffsetMax && end < totalChars ? LIMITS.readDocumentOffsetMax : null;
  return { text, nextOffset, bytes: documentEntryBytes(text, offset, totalChars, nextOffset) };
}

// The exact bytes of ONE `read_paragraph` tool-result ENTRY, through the module's one measurement
// (`toolResultEntryBytes`): `JSON.stringify({ tool: 'read_paragraph', ok: true,
// data: { scope: 'sentence', text, bytes } })`, the shape this handler publishes.
// The measurement is NOT a formality and it is NOT the text's own byte count: `JSON.stringify` escapes
// every C0 control character to two characters and every lone surrogate to six, so a caret context well
// inside `LIMITS.readParagraphBytes` can serialize to an entry far above `AGENT_CEILINGS.toolResultBytes`.
// Measuring the real entry is the only bound that cannot be defeated by the text's own characters.
function paragraphEntryBytes(text, bytes) {
  return toolResultEntryBytes('read_paragraph', { scope: 'sentence', text, bytes });
}
// `find_text`'s own entry, measured on the values ABOUT TO BE PUBLISHED through the module's one
// measurement: the echoed query, the resolved case flag, the primitive's own TOTAL, the bounded
// matches array and its `truncated` flag. The measurement is what decides whether this search can be
// delivered at all — `JSON.stringify` escapes every C0 control character to six characters, so a
// needle INSIDE `LIMITS.findQueryBytes` can still produce an entry the runtime refuses — and it is
// taken on the exact object the handler returns, never on a competing shape.
function findEntryBytes(data) {
  return toolResultEntryBytes('find_text', data);
}
// `read_structure`'s own entry, measured on the values ABOUT TO BE PUBLISHED through the module's one
// measurement: the page count, the statistics object, the counts and the bounded heading array. The
// measurement is taken on the exact object the handler returns, never on a competing shape, and it is
// what decides whether this structure can be delivered at all: `JSON.stringify` escapes every C0 control
// character in a heading, so a heading inside its own byte bound can still produce an entry the runtime
// refuses (`find_text` documents the same two-escape bracket).
function structureEntryBytes(data) {
  return toolResultEntryBytes('read_structure', data);
}
// `insert_blocks`'s own entry, measured on the values ABOUT TO BE PUBLISHED through the module's ONE
// measurement: the appended block count, the heading count derived from the blocks that asked for one,
// the two document counts the delta was decided on, and the dispatched payload's own byte size. The
// measurement is NOT a formality here either, even though FIVE bounded integers cannot approach the
// ceiling (`LIMITS.insertBlocksBytes` states the arithmetic and the tool's own test pins it): it is the
// module's single ENFORCED bound, and a field added to this result later must not be able to widen the
// entry unmeasured.
function insertBlocksEntryBytes(data) {
  return toolResultEntryBytes('insert_blocks', data);
}
// `insert_table`'s own entry, measured on the values ABOUT TO BE PUBLISHED through the module's ONE
// measurement: the matrix geometry, the two table counts the delta was decided on, and the dispatched
// payload's own byte size. The measurement is NOT a formality here either, even though FIVE bounded
// integers cannot approach the ceiling (`LIMITS.insertTableBytes` states the arithmetic and the tool's own
// test pins it): it is the module's single ENFORCED bound, and a field added to this result later must not
// be able to widen the entry unmeasured.
function insertTableEntryBytes(data) {
  return toolResultEntryBytes('insert_table', data);
}
// `set_heading`'s own entry, measured on the values ABOUT TO BE PUBLISHED through the module's ONE
// measurement: the addressed index, the requested level, the proof's own flags and the two heading counts
// the delta was decided on. The measurement is NOT a formality here either, even though the fields are
// bounded scalars (`LIMITS.setHeadingIndexMax` states the arithmetic): it is the module's single ENFORCED
// bound, and a field added to this result later must not be able to widen the entry unmeasured.
function setHeadingEntryBytes(data) {
  return toolResultEntryBytes('set_heading', data);
}
// THE LEVEL → STYLE NAME MAPPING, in ONE place so the request the editor receives and the name the body
// resolves can never be two different strings. The whole OOXML built-in heading family is `Heading 1` …
// `Heading 9`, and the lookup was MEASURED on the target to accept the English name on a LOCALIZED
// document too (`GetStyle('Heading 1')`, `'Heading1'`, `'heading 1'` and the localized `'Заголовок 1'` all
// resolve the same style), so this is not a guess about the document's language. The bound is enforced in
// two places ON PURPOSE: the schema advertises it, and this function re-checks the level before it names a
// style, because a descriptor is also executable when it is held directly.
function headingStyleName(level) {
  return Number.isSafeInteger(level) && level >= 1 && level <= LIMITS.insertHeadingMax ? `Heading ${level}` : null;
}
// THE TWO STYLE NAMES ARE THE SAME NAME under the spellings the editor's own lookup accepts (measured on the
// target: `'Heading 1'`, `'Heading1'` and `'heading 1'` all resolve the same style), so the comparison folds
// the case and drops the spaces. THE COMMAND BODY FOLDS THE SAME WAY (`folded` in the authored body), because
// the paragraph's own `GetStyle()` answer is compared there: a getter answering `'Heading1'` must be a MATCH
// and not the false disagreement that settled the write as UNCERTAIN with the slot held on a mutation that had
// in fact succeeded. THE CANDIDATE IS READ BY A HELPER rather than dereferenced at the guard, and
// that is an authored-code-audit requirement rather than a style choice: the findings analysis is NAME-based
// and scope-insensitive over the whole bundle, so a local called `result` has been marked "computed" by some
// OTHER handler's `const uncertain = uncertainResult(result)` long before this one runs, and a property READ
// on a computed name makes every call reached through it a `DYNAMIC_PROPERTY` finding. A CALL's result is not
// tainted by that analysis — the same rule the command bodies' array indices follow.
function readsStyleName(value, name) {
  if (value === null || typeof value !== 'object') return false;
  const carried = value.styleName;
  return typeof carried === 'string' && carried.toLowerCase().replace(/ /g, '') === name.toLowerCase().replace(/ /g, '');
}
// A count this module publishes is a NON-NEGATIVE SAFE INTEGER and nothing else. The bridge decodes the
// same rule, and the handler re-applies it because a descriptor is also executable when it is held
// directly: publishing a fractional, negative, NaN or stringified count as "the document's own number"
// would be exactly the invented field this module's result contract forbids.
function measuredCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
// The FIVE fields `GetStatistics()` was measured to answer, each one a `measuredCount`. The fields are
// re-read into the result object below rather than republished by reference, so an object carrying extra
// keys cannot smuggle an unmeasured field into the entry.
function measuredStatistics(value) {
  return value !== null && typeof value === 'object' && measuredCount(value.PageCount) &&
    measuredCount(value.WordsCount) && measuredCount(value.ParagraphCount) &&
    measuredCount(value.SymbolsCount) && measuredCount(value.SymbolsWSCount);
}
// The FOUR array lengths the structure read reports. There is deliberately no table row/column getter
// here: `GetRowCount`/`GetColumnCount` were measured as `undefined`, so the only per-table fact this
// module can honestly publish is how many tables the document holds.
function measuredCounts(value) {
  return value !== null && typeof value === 'object' && measuredCount(value.paragraphs) &&
    measuredCount(value.headings) && measuredCount(value.tables) && measuredCount(value.sections);
}

export function createWordTools(bridge) {
  return [
    defineTool({
      name: 'read_selection', kind: 'read', editors: ['word'], policy: 'auto', requires: ['document.read'],
      schema: { type: 'object', additionalProperties: false, required: [], properties: {} },
      precondition: (args, ctx) => wrongEditor(ctx, ERROR_CODES.CAPABILITY_UNAVAILABLE),
      execute: async () => {
        if (missingBridgeMethod(bridge, 'readSelection')) return known(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        let selection;
        try { selection = await bridge.readSelection({}); }
        catch (error) { return known(refusalCode(error?.code, ERROR_CODES.TOOL_ERROR)); }
        if (!selection || typeof selection !== 'object' || selection.eligible !== true ||
            typeof selection.text !== 'string' || selection.text === '') return known();
        const bytes = utf8ByteLength(selection.text);
        if (bytes > AGENT_CEILINGS.contextReadBytes.selection) return known(ERROR_CODES.BYTE_LIMIT);
        // The RAW bound above is not the bound the runtime applies. The runtime bounds ONE tool-result
        // ENTRY — `JSON.stringify({ tool, ...result })` — by `AGENT_CEILINGS.toolResultBytes`, and
        // `JSON.stringify` escapes every C0 control character to TWO characters and every lone surrogate
        // to SIX: a selection of 8192 newlines is 8192 raw bytes and a 16451-byte entry, which
        // `stringifyToolResults` (protocol.js:91) refuses, `runtime.js:27-36` replaces with the literal
        // "the tool result could not be serialized", and the run's action log still records `ok` — the
        // model receives NO text for a call the run calls successful. A selection read must NOT be
        // shortened to fit either: a shortened selection would be presented as THE selection, and the
        // model cannot tell it from one the user really made, so the only closed outcome left is the
        // refusal. The entry is measured on the values about to be published, exactly as
        // `read_paragraph` and `read_document_text` measure theirs.
        const entry = selectionEntryBytes(selection.text, bytes);
        if (entry === null || entry > AGENT_CEILINGS.toolResultBytes) return known(ERROR_CODES.BYTE_LIMIT);
        return ok({ text: selection.text, bytes });
      }
    }),
    defineTool({
      // The bounded, CHUNKED read of the document's own text — the first Sprint 3 Word tool. It is a
      // READ, so it needs no delta and no readback: a string is an unambiguous result and there is no
      // mutation whose effect would have to be established. The mechanism is the document-export path
      // the insert confirmation already uses (`GetFileHTML` → `decodeDocumentText` → `documentText`
      // inside the bridge), reused verbatim: this tool adds NO editor call and NO new capability.
      // It answers with exactly ONE bounded chunk; nothing in this module sends the whole document
      // anywhere, and no model or transport call exists on this path at all.
      name: 'read_document_text', kind: 'read', editors: ['word'], policy: 'auto', requires: ['document.read'],
      // Closed and bounded. Both keys are OPTIONAL and each is bounded by the named LIMITS entry it
      // advertises: an omitted `offset` is 0 and an omitted `maxChars` is the documented default chunk.
      // `offset` may address anything inside `readDocumentOffsetMax` — past the end of the document that
      // is the legitimate empty tail below — and `maxChars` is capped by `readDocumentMaxChars`.
      schema: { type: 'object', additionalProperties: false, required: [],
        properties: { offset: { type: 'integer', minimum: 0, maximum: LIMITS.readDocumentOffsetMax },
          maxChars: { type: 'integer', minimum: 1, maximum: LIMITS.readDocumentMaxChars } } },
      precondition: (args, ctx) => wrongEditor(ctx, ERROR_CODES.CAPABILITY_UNAVAILABLE),
      execute: async (args, ctx) => {
        if (missingBridgeMethod(bridge, 'readDocumentText')) return known(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        // The address is re-checked HERE and not only by the schema: a descriptor is also executable
        // when it is held directly, and an address this read cannot interpret must be a closed refusal
        // with NOTHING dispatched, never a silent slice of whatever a coercion produced.
        const offset = args.offset ?? 0;
        const maxChars = args.maxChars ?? LIMITS.readDocumentChars;
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > LIMITS.readDocumentOffsetMax) return known();
        if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > LIMITS.readDocumentMaxChars) return known();
        // The caller's signal is forwarded so a Stop can cancel the in-flight read: an abort before the
        // read is dispatched prevents it, while an abort after dispatch invalidates the caller and
        // leaves the queued SDK work owning the bridge slot until its own callback. The bounds do NOT
        // cross: the ONE request this tool makes is the document read itself, which serves the whole
        // decoded text and its character count, and the slicing happens here.
        const request = { ...(ctx?.signal === undefined ? {} : { signal: ctx.signal }) };
        let document;
        try { document = await bridge.readDocumentText(request); }
        catch (error) {
          // A bridge that reports its own UNCERTAIN class means the read's outcome is unknown: that is
          // the one case which stops the run, and it is classified before any ordinary refusal path.
          const uncertain = uncertainResult(error);
          if (uncertain) return uncertain;
          return known(refusalCode(error?.code, ERROR_CODES.TOOL_ERROR));
        }
        // An answer this tool cannot interpret — no envelope, no literal `ok:true`, a `text` that is
        // not a string, or a `totalChars` that disagrees with that text's own length — is the module's
        // unknown convention (`known()`, the closed tool-error class), while the bridge's own UNCERTAIN
        // class stops the run. A bridge REFUSAL in between keeps the closed class it reported.
        if (!document || typeof document !== 'object') return known();
        const uncertain = uncertainResult(document);
        if (uncertain) return uncertain;
        if (document.ok !== true) return known(refusalCode(document.code, ERROR_CODES.TOOL_ERROR));
        if (typeof document.text !== 'string' || document.totalChars !== document.text.length) return known();
        const totalChars = document.totalChars;
        // A character count beyond what ANY readable document can hold cannot be true of a document
        // this bridge read: the export is bounded by `documentHtmlBytes` and its decoded text cannot
        // exceed `readDocumentOffsetMax` characters. The check is not cosmetic — the address bound is
        // what makes every published resume point valid, and a count past it would make the read's own
        // range unservable — so the answer is a closed BYTE_LIMIT refusal, never a `totalChars` the
        // tool itself would contradict by clamping. The bound is stated in the limits module and covers
        // every export shape; a real bridge answer is always inside it.
        if (totalChars > LIMITS.readDocumentOffsetMax) return known(ERROR_CODES.BYTE_LIMIT);
        // An EMPTY document is a legitimate RESULT, not a refusal: the text of a document nobody has
        // typed into yet is '' with length 0, so `ok` with `text:''`, `totalChars:0`,
        // `truncated:false`, `nextOffset:null` is the whole truth about it. That is deliberately NOT
        // the `read_selection` convention of treating an empty read as `known()`: there an empty
        // SELECTION means there is nothing to reason about, while here the empty answer IS the complete
        // answer to "what does this document say".
        // The chunk, made of whole UTF-16 characters: both cuts are stepped off a surrogate pair, so no
        // lone surrogate can reach the result (`characterStart` / `characterEnd` above). Nothing is
        // trimmed, normalised or re-encoded: the slice is the document's own text.
        //
        // The END is also clamped by `readDocumentOffsetMax`. The address bound is what makes every
        // PUBLISHED resume point valid, so no chunk may run past it; the `totalChars` fence above keeps
        // every document this reader serves inside that range, which is what makes the clamp a
        // fail-closed guarantee rather than a routine truncation. The publish rule below still handles
        // the clamped shape, because a bound that is never enforced defensively is not a bound.
        const start = characterStart(document.text, Math.min(offset, document.text.length));
        const requestedCut = Math.min(document.text.length, offset + maxChars, LIMITS.readDocumentOffsetMax);
        const requestedEnd = characterEnd(document.text, requestedCut);
        // The smallest chunk this read serves is ONE whole character after `start`. A chunk that
        // consumed nothing publishes no resume point, so shrinking PAST this floor would stop the walk
        // in the middle of the document — the skipped range the publish rule forbids — which is why the
        // floor is a refusal boundary and never an empty `ok`. The cut is stepped over a surrogate pair
        // (`characterEnd`), so one character may be two code units and a pair is never split. `floor` can
        // never exceed the requested end: the request is at least one character wide and is clamped to
        // the same address bound, so the guard only keeps the two in the stated order.
        const floor = start < document.text.length ? characterEnd(document.text, start + 1) : start;
        let end = requestedEnd < floor ? floor : requestedEnd;
        // The ENFORCED bound is the ACTUAL serialized tool-result entry, not the raw text and not
        // `LIMITS.editorResultBytes`: the runtime bounds `JSON.stringify({tool, ...result})` by
        // `AGENT_CEILINGS.toolResultBytes` — 16384 bytes, not 65536 — and an entry above it is replaced
        // with the model-visible literal "the tool result could not be serialized" and no text. Measuring
        // the entry here is what makes the tool's own bound and the runtime's the same bound. The
        // arithmetic (Cyrillic 2 bytes/character, ASCII 1, CJK 3, an astral pair 4 over two units) plus
        // the envelope `LIMITS.readDocumentEntryBytes` is what sizes the advertised chunk: 8000 Cyrillic
        // characters = 16000 bytes + 130 = 16130 <= 16384.
        //
        // `maxChars` IS AN UPPER BOUND, NOT A HARD REQUIREMENT. The schema advertises `maxChars` up to
        // 8000, but 8000 characters of three-byte text is 24000 bytes and cannot fit this 16384-byte
        // entry, so refusing the request for size would fail a SCHEMA-LEGAL call and leave the caller
        // unable to learn which smaller request the tool would serve. The tool therefore serves the
        // LARGEST slice of the SAME `offset` whose published entry fits: every legal call delivers text,
        // the tool stays fail-closed (the entry is still measured exactly, and not even one whole
        // character fitting is still a closed refusal), and the model spends no extra step — the
        // result's own `text` length, `truncated` and `nextOffset` tell the caller what was served. A
        // clipped chunk is deliberately NOT what happens: clipping the requested slice would publish a
        // resume point that skips text the model never saw, so the SHRINK is the whole serving rule.
        //
        // The measurement carries the values that are ABOUT TO BE PUBLISHED (`publishedChunk` builds
        // text, `truncated` and `nextOffset` together and measures that one entry): the truncated shape
        // serializes `"truncated":true` plus a numeric resume point, while the assumed nil shape
        // serializes the shorter `"truncated":false` plus `"nextOffset":null` — 1 byte LESS on the
        // six-digit offsets (`true` against `null`, both over `false`), and a wider gap at smaller
        // offsets. A measurement taken against the nil resume point therefore UNDERCOUNTED the published
        // entry, and a chunk whose assumed entry was exactly `AGENT_CEILINGS.toolResultBytes` (16384)
        // passed the `> ceiling` check while the entry actually published made `stringifyToolResults`
        // (protocol.js:91) throw; `runtime.js:27-36` replaced the whole result with its literal refusal,
        // the model received NO text, and the run's action log still recorded `ok` — a fail-open signal
        // for exactly the chunk sizes the ceiling is meant to allow. There is ONE measurement here, of
        // the one entry, in the one shape that is published: the alternative — keeping the
        // nil-resume-point figure and widening the guard by a byte or three — would be a second,
        // competing measurement that has to be re-derived every time a field width changes and is
        // exactly the drift this handler was caught by.
        //
        // The SHRINK is the bounded bisection below. It finds the LARGEST slice that fits, not merely
        // one that fits, because "largest" is the whole point of the contract: a smaller slice than the
        // ceiling allows makes the caller spend another step to learn what this one could have carried.
        // The search needs no heuristic step size because `fits` is downward-closed ON THE INTERVAL THE
        // LOOP ACTUALLY PROBES — and the restriction is load-bearing, so it is stated exactly.
        //
        // The naive proposition "for ANY two ends e' < e, `bytes(e') <= bytes(e)`" is FALSE, and a
        // future reader must not restore it: `bytes` is NOT monotone in the end over every integer end.
        // Measured on `'x👍яé'` with `offset = 3`: the end 3 publishes 125 bytes and the LONGER end 4
        // publishes 123. Two separate mechanisms make a longer slice cheaper. (a) A slice ending on a
        // surrogate pair's high unit alone serializes that unit as a six-byte `\uXXXX` escape, while
        // the same slice with the pair completed serializes the pair as the character's own four bytes
        // — completing a pair makes the escaped text two bytes narrower, so the end 2 entry (127) is
        // WIDER than the end 3 entry (125). (b) An end at or below `offset` can publish no resume point
        // and spells the wider `"nextOffset":null` plus `"truncated":false`; the first end above
        // `offset` spells a digit plus `"truncated":true`, which at a one-digit address is three bytes
        // narrower, so the end 3 entry (125) is WIDER than the end 4 entry (123).
        //
        // What the loop actually probes is `[floor, requestedEnd]` with `floor = characterEnd(start + 1)`,
        // and in that interval BOTH mechanisms are out of reach, so `bytes` is non-decreasing there:
        //   * every probed end is a whole-character boundary (`characterEnd` re-steps each cut over a
        //     surrogate pair), so mechanism (a) cannot fire — a probed end never leaves the slice on
        //     half a pair;
        //   * every probed end is STRICTLY GREATER THAN `offset`, so mechanism (b) cannot fire and no
        //     probed end can carry a null resume point. This is where `floor` earns its place: `start`
        //     steps back to the high unit of a pair and `characterEnd(start + 1)` then steps forward
        //     past the low one, so `floor > offset` always — an equality here would mean `offset` sat
        //     inside a pair, which `characterStart` has already excluded. The bisection's own lower
        //     bound `start + 1` is inside `[offset, floor]`, but the loop stops at `highCut - lowCut > 1`
        //     and every probe it makes is `characterEnd(midCut)` with `midCut >= start + 2`, hence at
        //     least `offset + 2`; the boundary the loop returns is a `chunk` it already measured.
        // Inside that interval the entry's envelope can also not shrink, and can grow by at most ONE
        // byte: `text` and `offset` are fixed for the call, `nextOffset` is non-null, so the only field
        // that moves is the DIGIT COUNT of `nextOffset`, which adds one byte at 999→1000, 9999→10000,
        // 99999→100000 and never more. Each removed character costs the slice at least one UTF-8 byte
        // (the cheapest unit is one ASCII byte), so a one-byte envelope gain can never outweigh the
        // text the shorter end loses: `bytes(e') <= bytes(e)` holds on the probed interval, `fits` is
        // downward-closed there, and bisection over the cut finds the exact boundary.
        //
        // THE CONSTANTS THE LOOP'S CORRECTNESS DEPENDS ON, so a change to either is a change to this
        // proof and not a local tweak:
        //   * `LIMITS.readDocumentOffsetMax` = 524305 (SIX digits, and the clamp on `requestedCut`).
        //     It bounds every probed end from above and therefore caps the envelope's digit growth
        //     inside the interval at one byte, which is the whole margin. A SEVENTH digit (>= 1000000)
        //     would let one probed step add MORE than the one byte a removed character can save at the
        //     999999→1000000 boundary, the monotonicity would fail on ends the loop really does probe
        //     (1-byte text against a 2-byte envelope step), and this bisection would silently return a
        //     non-maximal slice — it must then be re-derived, not merely re-bounded.
        //   * `AGENT_CEILINGS.toolResultBytes` = 16384 (the result ceiling this doc comment measures
        //     against). It must stay large enough that failing ends stay in the 4-6 digit zone: the
        //     most expensive sub-4-digit entry any shape can produce is well under it (measured: 6116
        //     bytes for a 999-unit end of six-byte escapes), so today the loop can never run in the
        //     1-3 digit zone at all. A ceiling small enough to push the search down there would put
        //     failing ends where the envelope's width is a large fraction of the budget and the
        //     one-byte margin no longer covers it.
        // `characterEnd` re-steps every probed cut over a surrogate pair, so each probed end is a whole
        // character and a pair is never split. The worst case is ONE measurement for the request, ONE
        // for the floor, and ceil(log2(maxChars)) <= 13 probes of the same exact
        // `documentEntryBytes` measurement — at most 15 measurements of one entry, and never a second,
        // competing measurement.
        let chunk = publishedChunk(document.text, start, end, offset, totalChars);
        if (chunk.bytes === null || chunk.bytes > AGENT_CEILINGS.toolResultBytes) {
          // The floor is the smallest chunk this read can serve; if even that does not fit, there is no
          // slice to serve and the answer is the one closed refusal left.
          const floorChunk = publishedChunk(document.text, start, floor, offset, totalChars);
          if (floorChunk.bytes === null || floorChunk.bytes > AGENT_CEILINGS.toolResultBytes) return known(ERROR_CODES.BYTE_LIMIT);
          // `fits(E(start))` (the empty chunk) and `fits(E(floor))` hold, `fits(requestedEnd)` does not:
          // bisect the CUT between a cut that fits and one that does not, keeping the last fitting end.
          // The lower bound is `start + 1` — the cut that produces the floor — and not `start`, because
          // the invariant is `chunk === E(lowCut)` and `E(start + 1) === floor` is the chunk the check
          // above proved fits. The request is at least one character wide, so `start + 1 <= highCut`;
          // equality would mean the requested chunk IS the floor chunk, which the `chunk` check above
          // has already found fitting, so the branch would not be entered at all.
          let lowCut = start + 1;
          let highCut = requestedCut;
          chunk = floorChunk;
          while (highCut - lowCut > 1) {
            const midCut = lowCut + ((highCut - lowCut) >> 1);
            const candidate = publishedChunk(document.text, start, characterEnd(document.text, midCut), offset, totalChars);
            if (candidate.bytes !== null && candidate.bytes <= AGENT_CEILINGS.toolResultBytes) {
              lowCut = midCut;
              chunk = candidate;
            } else highCut = midCut;
          }
        }
        // Not even ONE whole character fits (or the entry cannot be serialized at all): the one closed
        // refusal left, and it still carries no character of the document. Together with the `totalChars`
        // fence above, this is the fail-closed floor: nothing the handler cannot serialize, cannot
        // address or cannot serve within the ceiling leaves it as a result at all.
        if (chunk.bytes === null || chunk.bytes > AGENT_CEILINGS.toolResultBytes) return known(ERROR_CODES.BYTE_LIMIT);
        return ok({ text: chunk.text, offset, totalChars, truncated: chunk.nextOffset !== null, nextOffset: chunk.nextOffset });
      }
    }),
    defineTool({
      // Sprint 3 Word tool 2: the caret context read. It is a READ, so it needs no delta and no
      // readback: a string is an unambiguous result and there is no mutation whose effect would have to
      // be established. It adds ONE editor primitive to the catalogue and no capability beyond the read
      // channel every other leg already uses.
      //
      // THE PRIMITIVE EVIDENCE. The vendored copy of the installed build's word SDK source
      // (`.local/stage-b-runtime/vendor-word-sdk-all.js`, dev-only) was counted by matching the file's
      // TEXT. `Select-String` was MISUSED on the first pass — its default form is LINE-level and
      // case-insensitive, so on this single-line 15 MB bundle it reports 17 lines for `GetCurrent`, 12
      // for `GetSelectedText` and 2 for `pluginMethod_`: counts of LINES, never zero — and it is the
      // misuse, not the tool, that was wrong: `Select-String -CaseSensitive -AllMatches` returns the
      // exact per-occurrence totals the file's text holds, 265 / 101 / 4, the same numbers quoted below.
      // `pluginMethod_GetCurrentParagraph`,
      // `pluginMethod_GetCurrentSentence`, `pluginMethod_GetCurrentWord` and `pluginMethod_GetSelectedText`
      // each occur 0 times, and those zeros prove NOTHING: `pluginMethod_` is not a naming convention in
      // this bundle, it occurs FOUR times in total — the explicit `PasteHtml` / `PasteText` /
      // `OnEncryption` members and the dispatcher's own `"pluginMethod_"+methodName` lookup — so the
      // editor resolves every other method name dynamically and no prefixed literal exists to count.
      // The BARE names are what exist: `GetCurrentParagraph` 125, `GetSelectedText` 101,
      // `GetCurrentWord` 7, `GetCurrentSentence` 6. NO plugin-level PARAGRAPH getter is established.
      // The 125 hits decompose EXACTLY, into four DISJOINT categories that sum to 125 — re-measured by
      // matching the file's text, not inherited from a prose estimate: 45 are the bare
      // `this.GetCurrentParagraph`, 12 are `this.<id>.GetCurrentParagraph`, 12 are
      // `<id>.prototype.GetCurrentParagraph` DEFINITIONS (one of them `Ct.prototype.`, the
      // `Api`/`getTargetDocContent()` route), and the remaining 56 are `<id>.GetCurrentParagraph` on
      // some other receiver. 101 of the 124 hits other than the one `Ct.prototype.` literal are NEITHER
      // `this.X.…` nor a `*.prototype.` definition, and the sample
      // `documentContent.GetCurrentParagraph()` occurs ZERO times and must not be quoted as evidence.
      // Every category is document-content-level, and that level manipulates the DOCUMENT rather than
      // the caret and was
      // measured by Phase 0 as exposing no `GetSelection` — so this descriptor dispatches no
      // `GetCurrentParagraph` and never reaches for `Api`. `GetCurrentSentence` IS established at the
      // plugin level, by this repo's own history:
      // commit ed65dd5 dispatched exactly `plugin.executeMethod('GetCurrentSentence', [], callback)`
      // through the one owned dispatch channel and records it as "the primitive the live build actually
      // answers with the inserted sentence" on R7-Office 2026.3.1. That is the most precise caret read
      // that exists, so this tool reads the SENTENCE at the caret, and the result's `scope` says
      // `"sentence"` — never a name the primitive cannot deliver.
      // The registry's `defineTool` field allowlist carries no `description` field, so the truth lives
      // in `scope` (which the model sees), in this comment, and in the failure contract below.
      name: 'read_paragraph', kind: 'read', editors: ['word'], policy: 'auto', requires: ['document.read'],
      // CLOSED and EMPTY: the primitive takes no parameters (`GetCurrentSentence` is dispatched with
      // `[]`), so the schema advertises none. A caller that guesses an argument — including the `scope`
      // the RESULT names — is refused by the schema itself, and nothing the model sends can widen the
      // bound the handler applies.
      schema: { type: 'object', additionalProperties: false, required: [], properties: {} },
      precondition: (args, ctx) => wrongEditor(ctx, ERROR_CODES.CAPABILITY_UNAVAILABLE),
      execute: async (args, ctx) => {
        if (missingBridgeMethod(bridge, 'readParagraph')) return known(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        // The ONE request this tool makes. The budget is this tool's own bound, so the bridge's decode
        // window and the bound the tool advertises are the same number. The caller's signal crosses
        // with it so a Stop cancels before dispatch, while an abort after dispatch invalidates the
        // caller and leaves the queued SDK work owning the bridge slot until its own callback.
        const request = { maxBytes: LIMITS.readParagraphBytes,
          ...(ctx?.signal === undefined ? {} : { signal: ctx.signal }) };
        let response;
        try { response = await bridge.readParagraph(request); }
        catch (error) {
          // A bridge that reports its own UNCERTAIN class means the read's outcome is unknown: that is
          // the one case which stops the run, and it is classified before any ordinary refusal path.
          const uncertain = uncertainResult(error);
          if (uncertain) return uncertain;
          return known(refusalCode(error?.code, ERROR_CODES.TOOL_ERROR));
        }
        // An answer this tool cannot interpret is the module's unknown convention (`known()`, the
        // closed tool-error class), while a bridge REFUSAL in between keeps the closed class it
        // reported. Only a class from the closed vocabulary is republished.
        if (!response || typeof response !== 'object') return known();
        const uncertain = uncertainResult(response);
        if (uncertain) return uncertain;
        if (response.ok !== true) return known(refusalCode(response.code, ERROR_CODES.TOOL_ERROR));
        // THE EMPTY-CARET DECISION. An empty caret context means the caret is in no sentence at all —
        // there is nothing to reason about, exactly like an empty SELECTION in `read_selection` — so it
        // is the module's closed `known()` refusal. This is deliberately NOT the whole-document
        // convention (`read_document_text` answers `ok` for an empty document), where `''` IS the
        // complete answer to "what does this document say". A caret read has no such question to
        // answer, so an empty answer is never published as a result with an empty `text`.
        if (typeof response.text !== 'string' || response.text === '') return known();
        // TWO bounds, both closed as BYTE_LIMIT, and they are NOT the same bound. The first is the text
        // ceiling `LIMITS.readParagraphBytes` advertises. The second is the ACTUAL serialized entry
        // measured against `AGENT_CEILINGS.toolResultBytes`, and it is the binding one: `JSON.stringify`
        // escapes every C0 control character to two characters and every lone surrogate to six, so a
        // caret context comfortably inside the first bound can still produce an entry the runtime
        // refuses — and a refused entry reaches the model as the literal "the tool result could not be
        // serialized" with NO text, while the action log would still record `ok`. Measuring the entry
        // exactly is what makes the difference between a delivered sentence and a fail-open `ok`.
        const bytes = utf8ByteLength(response.text);
        if (bytes > LIMITS.readParagraphBytes) return known(ERROR_CODES.BYTE_LIMIT);
        const entry = paragraphEntryBytes(response.text, bytes);
        if (entry === null || entry > AGENT_CEILINGS.toolResultBytes) return known(ERROR_CODES.BYTE_LIMIT);
        return ok({ scope: 'sentence', text: response.text, bytes });
      }
    }),
    defineTool({
      // Sprint 3 Word tool 3: the bounded document SEARCH. It is a READ — a search answers a question
      // about the document and changes nothing — so it needs no delta and no readback, and no mutate
      // path is reachable from this descriptor. It adds ONE editor primitive and no capability beyond
      // the read channel every other leg already uses.
      //
      // THE PRIMITIVE EVIDENCE, measured on the target (Astra / R7 2026.1.2.1942, this round) and
      // treated as established: `Api.GetDocument().Search(query, matchCase)` returns a REAL Array of
      // range objects — `count = 4` for the strict `'МАРКЕР-ПОИСК'`, `count = 5` for the
      // case-insensitive `'маркер-поиск'` over the same document (the fifth occurrence is the lowercase
      // one), `count = 0` — an EMPTY array, never null — for a needle the document does not hold — and
      // `GetText()` on one element is that match's own text. This is the first READ in this repo that
      // builds the `Api` facade itself: the dispatch is ONE static authored command body (bridge
      // `findText` → `command.search`), evaluated inside the editor, where the ONLY model data it can
      // see is the `scope` binding the vendor's `callCommand` wrapper composes from `Asc.scope`.
      // `Start`/`End` exist on those range objects but their UNIT IS UNVERIFIED, so this tool publishes
      // NO position and no ordering claim beyond the occurrence ORDER the array itself has: what the
      // caller receives is each match's own text and its 0-based index.
      //
      // THE TWO DECISIONS THE RESULT CARRIES, both documented where they are made:
      //   * `matchCase` defaults to FALSE — the case-insensitive search, a SUPERSET of the strict one,
      //     which is also the editor's own Find default — and the result ECHOES the resolved flag, so
      //     the model always knows which question was answered and can ask the other one. The measured
      //     4-vs-5 pair is exactly why the echo is not optional.
      //   * ZERO matches is `ok` with `count: 0` and an empty `matches`, not a refusal: "the document
      //     holds no occurrence" IS the complete answer to a search, deliberately unlike an empty CARET
      //     context (`read_paragraph`), where `''` means there was nothing to answer.
      name: 'find_text', kind: 'read', editors: ['word'], policy: 'auto', requires: ['document.read'],
      // CLOSED and bounded. `query` is required and is bounded by `LIMITS.findQueryBytes` — a search
      // string, not a document read — and `limit` is bounded by `LIMITS.findMatchesMax`, which is ALSO
      // the default: the advertised space is a size a default call really returns. An omitted
      // `matchCase` resolves to `false` in the handler and is echoed in the result.
      schema: { type: 'object', additionalProperties: false, required: ['query'],
        properties: { query: { type: 'string', minBytes: 1, maxBytes: LIMITS.findQueryBytes },
          matchCase: { type: 'boolean' },
          limit: { type: 'integer', minimum: 1, maximum: LIMITS.findMatchesMax } } },
      precondition: (args, ctx) => wrongEditor(ctx, ERROR_CODES.CAPABILITY_UNAVAILABLE),
      execute: async (args, ctx) => {
        if (missingBridgeMethod(bridge, 'findText')) return known(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        // The defaults, resolved ONCE: the bridge is told what was decided (`matchCase:false`,
        // `limit:findMatchesMax`) rather than being left to guess an omitted key, so the request the
        // editor executes and the result the model reads describe the SAME search.
        const query = args.query;
        const matchCase = args.matchCase ?? false;
        const limit = args.limit ?? LIMITS.findMatchesMax;
        // Re-checked HERE and not only by the schema: a descriptor is also executable when it is held
        // directly, and a needle or a bound this read cannot interpret must be a closed refusal with
        // NOTHING dispatched, never a silent search of whatever a coercion produced.
        if (typeof query !== 'string' || query === '' || utf8ByteLength(query) > LIMITS.findQueryBytes) return known();
        if (typeof matchCase !== 'boolean') return known();
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIMITS.findMatchesMax) return known();
        // The caller's signal is forwarded so a Stop cancels the in-flight search: an abort before the
        // dispatch prevents it, while an abort after dispatch invalidates the caller and leaves the
        // queued SDK work owning the bridge slot until its own callback.
        const request = { query, matchCase, limit,
          ...(ctx?.signal === undefined ? {} : { signal: ctx.signal }) };
        let response;
        try { response = await bridge.findText(request); }
        catch (error) {
          // A bridge that reports its own UNCERTAIN class means the search's outcome is unknown: that is
          // the one case which stops the run, and it is classified before any ordinary refusal path.
          const uncertain = uncertainResult(error);
          if (uncertain) return uncertain;
          return known(refusalCode(error?.code, ERROR_CODES.TOOL_ERROR));
        }
        // An answer this tool cannot interpret is the module's unknown convention (`known()`, the closed
        // tool-error class), while a bridge REFUSAL in between keeps the closed class it reported. Only a
        // class from the closed vocabulary is republished.
        if (!response || typeof response !== 'object') return known();
        const uncertain = uncertainResult(response);
        if (uncertain) return uncertain;
        if (response.ok !== true) return known(refusalCode(response.code, ERROR_CODES.TOOL_ERROR));
        // The bridge's own envelope contract, re-checked here because the descriptor is executable on
        // its own: a non-negative safe-integer TOTAL, and EXACTLY `min(count, limit)` texts — the count
        // the authored body extracted. An answer with a different number of texts is not one this bridge
        // can have produced, and publishing it would let the tool present a short report as its own cap.
        const count = response.count;
        const texts = response.texts;
        if (!Number.isSafeInteger(count) || count < 0) return known();
        if (!Array.isArray(texts) || texts.length > limit) return known();
        if (texts.length !== Math.min(count, limit)) return known();
        if (texts.some(text => typeof text !== 'string')) return known();
        const matches = Object.freeze(texts.map((text, index) => Object.freeze({ index, text })));
        const data = Object.freeze({ query, matchCase, count, matches, truncated: count > matches.length });
        // THE ENFORCED BOUND is the ACTUAL serialized tool-result entry, exactly as the other three
        // reads measure it: the runtime bounds `JSON.stringify({tool, ...result})` by
        // `AGENT_CEILINGS.toolResultBytes` (16384) and replaces an entry above it with the model-visible
        // literal "the tool result could not be serialized" — the model would receive NO search result
        // while the action log recorded `ok`. The worst REALISTIC call at the advertised maxima measures
        // 9283 bytes (see `LIMITS.findQueryBytes`); widening `count` to `Number.MAX_SAFE_INTEGER` adds 14
        // bytes of total, for 9297 with `truncated:false` (7087 of slack) and 9296 with `truncated:true`.
        // What actually cannot fit is the ESCAPE width, and there are two of them: a control character
        // with a named short escape (`\n`) serializes to the TWO-character `"\n"` and, at a 256-character
        // needle times 32 matches, measures 17731; a C0 control with no short escape serializes to the
        // SIX-character `\uXXXX` and measures 51523. Both are REFUSED here rather than shortened: a
        // shortened match text presented as the match would be an approximation this module forbids.
        const entry = findEntryBytes(data);
        if (entry === null || entry > AGENT_CEILINGS.toolResultBytes) return known(ERROR_CODES.BYTE_LIMIT);
        return ok(data);
      }
    }),
    defineTool({
      // Sprint 3 Word tool 4: the bounded DOCUMENT-STRUCTURE read. It is a READ — it answers a question
      // about the document's shape and changes nothing — so it needs no delta and no readback, no mutate
      // path is reachable from this descriptor, and it adds no capability beyond the read channel every
      // other leg already uses. It IS the measured replacement for the long-withheld `read_context`
      // structure scope: this descriptor reads the document structure with primitives the Lead MEASURED
      // on the target, while `read_context` keeps its `deny` policy and its own comment untouched.
      //
      // THE PRIMITIVE EVIDENCE, measured on the target (Astra / R7 2026.1.2.1942, this round) and
      // treated as established: inside a `callCommand` body, `Api.GetDocument().GetStatistics()` answers
      // an OBJECT with the numeric fields `PageCount`, `WordsCount`, `ParagraphCount`, `SymbolsCount`,
      // `SymbolsWSCount` (`{1, 25, 10, 150, 165}` on the purpose-built document); `GetPageCount()`
      // answers `1`; `GetAllParagraphs()` an array of 10 whose elements carry `GetClassType()` and
      // `GetText()`; `GetAllHeadingParagraphs()` an array of EXACTLY the 3 styled headings;
      // `GetAllTables()` 1; `GetSections()` 1. `GetAllStyles()` answers 182 and is deliberately NOT read:
      // the full style library is not the document's structure.
      //
      // THE NO-`level` DECISION, and it is measured rather than assumed. The vendored copy of the
      // installed build's SDK source (dev-only, `.local/stage-b-runtime/vendor-word-sdk-all.js`) was
      // searched with the file's TEXT matched case-sensitively: `GetOutlineLvl` occurs 8 times, and every
      // one of the eight sits on an INTERNAL class — the document-outline manager, the internal paragraph
      // (`s.prototype.GetOutlineLvl`), and the internal paragraph properties (`Mt`, registered as
      // `AscCommonWord.CParaPr`) — while the two PUBLIC builder classes an element of
      // `GetAllHeadingParagraphs()` can reach expose none: `AscBuilder.ApiParagraph` (`G`) registers no
      // PUBLIC outline getter (its alias list runs `…GetParaPr…GetText…GetTextPr…` and never an outline
      // member), and `AscBuilder.ApiParaPr` (`T`), which `G.GetParaPr()` returns, registers
      // `SetStyle`/`GetStyle`/`GetJc`/`GetIndLeft`/`GetIndRight`/`GetIndFirstLine`/`GetSpacing*`/… and NO
      // `GetOutlineLvl` (its measured method count is 0 for both `T.prototype.GetOutlineLvl` and
      // `T.prototype.SetOutlineLvl`). That is a statement about PUBLIC members, not unreachability: a
      // PRIVATE route does exist (`ApiParagraph.private_GetImpl().GetOutlineLvl()`), and this tool
      // deliberately does not reach for it, because reading a document through a private internal is a
      // dependency the next build is free to break. Deriving a level from the style NAME would be a guess
      // the document need not confirm (style names are localized), and deriving it from the array index is
      // explicitly forbidden, so this tool publishes NO `level` field — and no `level: null` placeholder
      // either, because a null would read as a measured "no outline level" the run never measured.
      //
      // THE RESULT IS SHAPED BY WHAT WAS MEASURED, not by what a structure read might ideally carry:
      // `pages` is `GetPageCount()`'s own answer; `statistics` republishes the measured object under the
      // primitive's OWN field names, so no renamed or invented field can drift from it; `counts` is the
      // four array lengths (`paragraphs`, `headings`, `tables`, `sections`); `headings` is a BOUNDED
      // array of `{ index, text }` — each text is that paragraph's own `GetText()`, in the order the
      // primitive returned it — and `truncated` says whether the document holds more headings than are
      // reported. There is deliberately NO separate `tables`/`sections` RESULT key: the only facts this
      // module can honestly state about them are their counts, which `counts` already carries, and a
      // per-table row/column report would need `GetRowCount`/`GetColumnCount`, which were measured as
      // `undefined`. Two competing fields for one count is how a report comes to describe a limitation
      // it did not impose.
      //
      // THE EMPTY-STRUCTURE DECISION. A document with no styled headings and no tables answers `ok` with
      // `headings: []`, `counts.headings: 0` and `truncated: false`: "this document has no headings" IS
      // the complete answer to "what is this document's structure", deliberately unlike an empty CARET
      // context (`read_paragraph`), where `''` means there was nothing to reason about.
      name: 'read_structure', kind: 'read', editors: ['word'], policy: 'auto', requires: ['document.read'],
      // CLOSED and EMPTY: every primitive this read dispatches takes no model parameter, so the schema
      // advertises none and a caller that guesses an argument (including `scope`, which the WITHHELD
      // `read_context` schema names) is refused by the schema itself. An optional argument no measurement
      // showed to matter would only be a second way to ask the same question.
      schema: { type: 'object', additionalProperties: false, required: [], properties: {} },
      precondition: (args, ctx) => wrongEditor(ctx, ERROR_CODES.CAPABILITY_UNAVAILABLE),
      execute: async (args, ctx) => {
        if (missingBridgeMethod(bridge, 'readStructure')) return known(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        // The ONE request this tool makes, and the cap it carries is the cap the schema side advertises:
        // one value, so the extraction inside the editor and the bound this handler applies cannot drift.
        // The caller's signal crosses with it so a Stop cancels before dispatch, while an abort after
        // dispatch invalidates the caller and leaves the queued SDK work owning the bridge slot until its
        // own callback.
        const request = { maxHeadings: LIMITS.structureHeadingsMax,
          ...(ctx?.signal === undefined ? {} : { signal: ctx.signal }) };
        let response;
        try { response = await bridge.readStructure(request); }
        catch (error) {
          // A bridge that reports its own UNCERTAIN class means the read's outcome is unknown: that is
          // the one case which stops the run, and it is classified before any ordinary refusal path.
          const uncertain = uncertainResult(error);
          if (uncertain) return uncertain;
          return known(refusalCode(error?.code, ERROR_CODES.TOOL_ERROR));
        }
        // An answer this tool cannot interpret is the module's unknown convention (`known()`, the closed
        // tool-error class), while a bridge REFUSAL in between keeps the closed class it reported. Only a
        // class from the closed vocabulary is republished.
        if (!response || typeof response !== 'object') return known();
        const uncertain = uncertainResult(response);
        if (uncertain) return uncertain;
        if (response.ok !== true) return known(refusalCode(response.code, ERROR_CODES.TOOL_ERROR));
        // The bridge's own envelope contract, re-checked here because the descriptor is executable on
        // its own: a non-negative safe-integer page count, the five measured statistic fields, the four
        // measured counts, and EXACTLY `min(counts.headings, structureHeadingsMax)` heading texts. An
        // answer with a different number of texts is not one this bridge can have produced, and
        // publishing it would let the tool present a short outline as its own cap.
        const pages = response.pages;
        const statistics = response.statistics;
        const counts = response.counts;
        const headings = response.headings;
        if (!measuredCount(pages)) return known();
        if (!measuredStatistics(statistics)) return known();
        if (!measuredCounts(counts)) return known();
        if (!Array.isArray(headings) || headings.length > LIMITS.structureHeadingsMax) return known();
        if (headings.length !== Math.min(counts.headings, LIMITS.structureHeadingsMax)) return known();
        if (headings.some(text => typeof text !== 'string')) return known();
        // THE PER-HEADING BOUND IS AN EXPLICIT OMISSION, not a trim and not a total refusal. A heading
        // wider than `LIMITS.structureHeadingBytes` is never shortened — a shortened title presented as
        // the document's own is the approximation this module refuses everywhere — but it must not refuse
        // the whole READ either. `pages`, `statistics` and `counts` are measured facts about the document
        // that no heading TEXT can make untrue, and the refusal that used to answer here was POSITIONAL:
        // an over-wide heading at index 0 refused everything while the same heading at index 40 is never
        // extracted and the read succeeded, so two documents holding the same over-wide heading got
        // opposite outcomes for a difference the model cannot see. So the outline is WITHHELD whole:
        // `headings: []` with `truncated: true` is an explicit, unambiguous omission the model can act on,
        // and the scalars still arrive.
        // THE ARRAY MUST BE EMPTY RATHER THAN PARTIALLY FILLED. A partial array with `truncated: true`
        // already means "more headings exist than are reported" (the cap case), so publishing the short
        // texts beside an over-wide one under the SAME flag would give one flag two meanings and leave the
        // model unable to tell a withheld outline from a capped one. `truncated: true` with an EMPTY array
        // has no competing reading: none of the outline is reported.
        // `counts.headings` KEEPS THE PRIMITIVE'S OWN TOTAL in both cases: it is a COUNT, not a text, so
        // the omission neither narrows it nor invents a zero, and the model still learns how many headings
        // the document holds even though none of their texts can be published.
        const overWide = headings.some(text => utf8ByteLength(text) > LIMITS.structureHeadingBytes);
        const published = overWide ? [] : headings.map((text, index) => Object.freeze({ index, text }));
        // The published object is BUILT here field by field, so an envelope carrying an extra key cannot
        // put an unmeasured field into the entry, and `truncated` is derived from the two numbers the
        // result SHOWS — the primitive's total against the array actually published, which is EMPTY when
        // the outline was withheld, so that omission is stated without a second meaning for the flag.
        const data = Object.freeze({
          pages,
          statistics: Object.freeze({ PageCount: statistics.PageCount, WordsCount: statistics.WordsCount,
            ParagraphCount: statistics.ParagraphCount, SymbolsCount: statistics.SymbolsCount,
            SymbolsWSCount: statistics.SymbolsWSCount }),
          counts: Object.freeze({ paragraphs: counts.paragraphs, headings: counts.headings,
            tables: counts.tables, sections: counts.sections }),
          headings: Object.freeze(published),
          truncated: counts.headings > published.length
        });
        // THE ENFORCED BOUND is the ACTUAL serialized tool-result entry, exactly as the other four reads
        // measure it: the runtime bounds `JSON.stringify({tool, ...result})` by
        // `AGENT_CEILINGS.toolResultBytes` (16384) and replaces an entry above it with the model-visible
        // literal "the tool result could not be serialized" — the model would receive NO structure while
        // the action log recorded `ok`. The arithmetic is stated in `LIMITS.structureHeadingsMax`: the
        // worst realistic call at the advertised maxima measures 9192 bytes, the 2x-escape family the
        // review caught (`"` → `\"`) binds far above it (16341 at 32 headings of 240 `"`, with 43 bytes of
        // slack; 16405 at 241, refused), and the true maximum over every publishable shape is the ceiling
        // EXACTLY — 16384, zero slack. The two families that cannot fit at all (17365 for `\n`, 50133 for a
        // C0 control with no short escape) are refused rather than shortened. An over-wide heading is NOT
        // refused here: the omission above already publishes an entry that fits.
        const entry = structureEntryBytes(data);
        if (entry === null || entry > AGENT_CEILINGS.toolResultBytes) return known(ERROR_CODES.BYTE_LIMIT);
        return ok(data);
      }
    }),
    defineTool({
      // Ruling A — WITHHELD FROM EVERY OFFERED CATALOGUE. `read_context` rests on a public document
      // read primitive that is NOT verified: the installed build's word SDK source copy (dev-only
      // evidence, `.local/stage-b-runtime/vendor-word-sdk-all.js`) contains
      // `GetDocumentStructure` 0 times and `pluginMethod_GetDocumentStructure` 0 times, while
      // `GetSelectedText` occurs 101 times and `pluginMethod_PasteText` exists. The dispatch resolves
      // methods BY NAME, so this is evidence AGAINST the primitive rather than conclusive proof, and
      // no positive evidence exists because the native target is unreachable from here. A native probe
      // must confirm a public document read before this becomes `auto` again. The descriptor, its
      // schema, its precondition and its handler are deliberately kept, so the switch back is this one
      // value.
      // What `deny` actually guarantees (stated exactly, so this comment cannot over-claim): the
      // registry skips a denied entry in BOTH of its public collections — `catalogue`, the only place
      // the PRODUCT turns a model tool name into an executable descriptor (`runAgent` builds its
      // catalogue through that call and `validateBatch` resolves against it), and `registry.tools`,
      // which publishes only the non-denied descriptors — so no consumer reaches this descriptor, and
      // a model-emitted `read_context` is a closed TOOL_ERROR with no dispatch. The descriptor, its
      // schema, its precondition and its handler are kept in this module (the registry's `deny` policy
      // is what withholds them; the descriptor itself is still executable if held directly), which is
      // what makes the probe-driven switch back a one-value change. PENDING NATIVE VERIFICATION.
      name: 'read_context', kind: 'read', editors: ['word'], policy: 'deny', requires: ['document.read'],
      schema: { type: 'object', additionalProperties: false, required: ['scope', 'index'],
        properties: { scope: { type: 'string', enum: ['paragraph', 'section', 'structure'] },
          index: { type: 'integer', minimum: 0, maximum: MAX_CONTEXT_INDEX } } },
      precondition: (args, ctx) => {
        if (ctx?.editor !== 'word') return { code: ERROR_CODES.CAPABILITY_UNAVAILABLE, message: REFUSAL };
        if (!Object.hasOwn(SCOPES, args.scope)) return { code: ERROR_CODES.TOOL_ERROR, message: REFUSAL };
        if (!Number.isSafeInteger(args.index) || args.index < 0 || args.index > MAX_CONTEXT_INDEX) {
          return { code: ERROR_CODES.TOOL_ERROR, message: REFUSAL };
        }
        return null;
      },
      execute: async (args, ctx) => {
        if (!Object.hasOwn(SCOPES, args.scope)) return known();
        if (missingBridgeMethod(bridge, 'readContext')) return known(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        const maxBytes = scopeLimit(args.scope);
        // The caller's signal is forwarded so a Stop can cancel the in-flight read: an abort before
        // the read is dispatched prevents it, while an abort after dispatch invalidates the caller
        // and leaves the queued SDK work owning the bridge slot until its own callback.
        const request = { scope: args.scope, index: args.index, maxBytes,
          ...(ctx?.signal === undefined ? {} : { signal: ctx.signal }) };
        let response;
        try { response = await bridge.readContext(request); }
        catch (error) { return known(refusalCode(error?.code, ERROR_CODES.TOOL_ERROR)); }
        if (!response || typeof response !== 'object') return known();
        if (response.ok !== true) return known(refusalCode(response.code, ERROR_CODES.TOOL_ERROR));
        if (typeof response.text !== 'string' || response.text === '') return known();
        const bytes = utf8ByteLength(response.text);
        if (bytes > maxBytes) return known(ERROR_CODES.BYTE_LIMIT);
        // The SAME measurement the other reads apply, and it is taken here while the policy is still
        // `deny`. The registry's `deny` withholds this descriptor from every catalogue, but the handler
        // stays executable when the descriptor is held directly, so without this measurement a flip to
        // `auto` would publish `ok` for an entry the runtime refuses — the model would receive the
        // literal "the tool result could not be serialized" and the action log would still record `ok`.
        // THIS measurement is exactly what closes that fail-OPEN: an over-ceiling context can no longer
        // be published as `ok`. It is NOT by itself what makes a future `auto` flip safe, and this
        // comment does not claim that:
        //   * the ceiling here is `AGENT_CEILINGS.contextReadBytes.paragraph` = 16384, the WHOLE entry
        //     ceiling, so the entry measurement necessarily eats into the raw-text bound this handler
        //     applies and leaves a DEAD BAND — for an ASCII `paragraph` at `index: 0` the envelope is 92
        //     bytes, so the largest text that fits is 16288 and a 16288-byte read whose entry is exactly
        //     16384 is served while 16289 is refused even though 16384 raw bytes are what the bound
        //     advertises (the band is the envelope's width, one byte more at a two-digit index);
        //   * the descriptor above still carries its own withdrawal condition: a native probe must
        //     confirm a public document read before this policy becomes `auto` again.
        const entry = contextEntryBytes(args.scope, args.index, response.text, bytes);
        if (entry === null || entry > AGENT_CEILINGS.toolResultBytes) return known(ERROR_CODES.BYTE_LIMIT);
        return ok({ scope: args.scope, index: args.index, text: response.text, bytes });
      }
    }),
    defineTool({
      name: 'insert_paragraph', kind: 'mutate', editors: ['word'], policy: 'auto', requires: ['document.write'],
      // The schema advertises the per-action argument ceiling on `text`; the handler applies that same
      // ceiling to the payload the bridge actually dispatches, so the advertised and the enforced bound
      // are one value on both sides. The handler's note below states the `end` consequence: the appended
      // newline is part of the dispatched payload, so `end` carries at most `argumentsBytes - 1` of text.
      schema: { type: 'object', additionalProperties: false, required: ['text'],
        properties: { text: { type: 'string', maxBytes: AGENT_CEILINGS.argumentsBytes, minBytes: 1 },
          position: { type: 'string', enum: ['cursor', 'end'] } } },
      precondition: (args, ctx) => wrongEditor(ctx, ERROR_CODES.CAPABILITY_UNAVAILABLE),
      execute: async (args, ctx) => {
        if (missingBridgeMethod(bridge, 'insertParagraph')) return known(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        // The advertised bound is the bound this handler applies, and it is applied to the payload the
        // bridge actually dispatches — never to a prefix of it. `bridge.insertParagraph` expresses
        // `position:'end'` by appending ONE authored newline AFTER this call, so measuring `args.text`
        // alone let a text of exactly argumentsBytes dispatch argumentsBytes+1 bytes. Both sides name
        // the same ceiling and this handler's subject is the dispatched form:
        //   `cursor` (and an omitted position, the bridge's own default) → at most argumentsBytes of text;
        //   `end`                                                       → at most argumentsBytes-1 of text.
        // A text that passes the schema but overflows only once that newline is counted is refused here
        // as the same closed BYTE_LIMIT class, so the dispatched bytes can never exceed the bound.
        const dispatched = args.position === 'end' ? `${args.text}\n` : args.text;
        if (utf8ByteLength(dispatched) > AGENT_CEILINGS.argumentsBytes) return known(ERROR_CODES.BYTE_LIMIT);
        // The validated arguments cross to the bridge unchanged; an omitted position stays omitted so
        // the bridge's own default is the single place that decides it (the measure above assumes that
        // same default). The caller's signal crosses with them so a Stop can cancel before dispatch and
        // marks a dispatched insert uncertain.
        const forwarded = { text: args.text, ...(args.position === undefined ? {} : { position: args.position }),
          ...(ctx?.signal === undefined ? {} : { signal: ctx.signal }) };
        let result;
        try { result = await bridge.insertParagraph(forwarded); }
        catch (error) {
          // A write whose callback never settled may already have applied: that is the one case
          // which stops the run. Every other bridge throw is a closed local failure.
          const uncertain = uncertainResult(error);
          if (uncertain) return uncertain;
          return known(refusalCode(error?.code, ERROR_CODES.TOOL_ERROR));
        }
        // The bridge answers its own uncertain settlement by RETURNING this envelope rather than
        // throwing it, so the same class is classified here before any ordinary-refusal path can treat
        // it as a known error. A returned `APPLY_UNCERTAIN` is the same unknown mutation outcome as a
        // thrown one and stops the run identically.
        const uncertain = uncertainResult(result);
        if (uncertain) return uncertain;
        if (!result || typeof result !== 'object') return known();
        if (result.ok !== true) return known(refusalCode(result.code, ERROR_CODES.TOOL_ERROR));
        // The native acknowledgement is the only insert evidence there is: the bridge envelope carries
        // {ok:true, data:{sent:<boolean>}} for a boolean acknowledgement and
        // {ok:true, data:{sent:true, effectVerified:true}} when the bridge's own bounded confirmation
        // read reproduced the dispatched payload. The native return value is never effect proof. Only a
        // literal own `true` is reported as an acknowledged insert; an explicit false, an absent flag
        // and a non-boolean are known errors, so the model is never told that an insert the editor did
        // not acknowledge succeeded.
        const data = result.data;
        const acknowledged = data !== null && typeof data === 'object' && Object.hasOwn(data, 'sent') ? data.sent : undefined;
        if (acknowledged !== true) return known(ERROR_CODES.TOOL_ERROR);
        // The verified marker is republished, never dropped and never invented: it is present only
        // because the bridge's bounded read proved the effect, and it reaches the run so the model is
        // told what was actually established instead of a bare "sent".
        const verified = data.effectVerified === true;
        // `bytes` is the dispatched payload's own size, the same value the bound above measured (so an
        // `end` insert reports the newline too, exactly like the bytes that crossed to the editor).
        return ok({ acknowledged: true, bytes: utf8ByteLength(dispatched), ...(verified ? { effectVerified: true } : {}) });
      }
    }),
    defineTool({
      // Sprint 3 tool 5: the BLOCK APPEND — the FIRST MUTATION of this sprint and the only tool in this
      // module whose success is a claim about what the DOCUMENT now holds. It is therefore the one
      // descriptor with an OUTCOME CONTRACT rather than a result shape, and the mutation ground truth is
      // the document's own structure, never the primitive that changed it.
      //
      // WHY NO MUTATION PRIMITIVE'S RETURN VALUE IS THE SIGNAL. Measured on the target (Astra / R7
      // 2026.1.2.1942, this round): `Push` returned `true` for a paragraph this tool hands it and `false`
      // for an image host, and the legacy whole-array insert primitive `doc.InsertContent([paragraph])`
      // returned `true` EVEN FOR `[]`, `[null]` and `'nonsense'` — so no boolean is a result signal in
      // either direction (and a `false` is not proof of failure, which is why the rule is not written as
      // "true means inserted" with a fallback). What IS measured is the document's own shape: after an
      // insert the paragraph IS a heading — `GetAllHeadingParagraphs()` went 3 → 4 while
      // `GetAllParagraphs()` went 10 → 11 — so the delta between the two reads is the evidence, and this
      // handler verifies it EXACTLY.
      //
      // WHERE THE CONTENT GOES IS MEASURED TOO, AND THE ROUTE IS `Push`. On the same target, inside a
      // `callCommand` body on a document [TARGET ROUTES CHECK, ПЕРВЫЙ-АБЗАЦ-РОУТ, ВТОРОЙ-АБЗАЦ-РОУТ,
      // ТРЕТИЙ-АБЗАЦ-РОУТ]: `doc.Push(paragraph)` returned `true` and APPENDED AT THE END (…,
      // ТРЕТИЙ-АБЗАЦ-РОУТ, МАРКЕР-МАРШРУТ-2), while `doc.InsertContent([paragraph])` put the paragraph at
      // the BEGINNING ([МАРКЕР-МАРШРУТ-1, TARGET ROUTES CHECK, …]) and, once a selection existed
      // (`doc.GetRange(lastIndex, 0, lastIndex, lastText.length).Select()`), REPLACED existing text — the
      // marker was written as `МАРКЕР-МАРШРУТ-1` and read back as `-МАРШРУТ-1`. This tool therefore authors
      // `Push` ONE CALL PER BLOCK, IN BLOCK ORDER, and authors `InsertContent` nowhere: it is not the
      // mutation, not a fallback, and not even a capability this tool checks for, and select-then-insert —
      // the shape that clobbered text — is never authored either. So the tool's position semantics are
      // "appends at the END of the document via `Push`", not "writes at the end because the insert
      // primitive is assumed to".
      //
      // THE OUTCOME CONTRACT, in one sentence: `ok` is published ONLY when the post read shows the exact
      // expected delta — paragraphs grew by exactly the number of blocks, headings grew by exactly the
      // number of blocks that asked for a heading, and every block carried its own text in the paragraph
      // slot the append gave it. The third leg is ONE-TO-ONE OVER THE APPEND, not an existential match
      // over the document: the body addresses the region the append added by the baseline count it took
      // before the call, so a text the document already held somewhere cannot stand in for the block's
      // own paragraph (an `indexOf` over the whole document verified exactly that, and was wrong).
      // Anything else is `TOOL_UNCERTAIN` (the runtime stops the run fail-safe), the bridge keeps its
      // callback slot HELD, and there is NO retry of the append.
      //
      // THE MECHANISM is ONE authored command body in the bridge (`insertBlocks` → `command.blocks`),
      // static and self-contained exactly like the search and structure bodies: it builds the `Api`
      // facade itself, receives the blocks as DATA through the `Asc.scope` parameter channel (never
      // interpolated into source), reads the baseline, builds every paragraph and resolves every heading
      // style, then pushes EVERY created paragraph with `document.Push`, ONE `Push` PER BLOCK in block
      // order, and reads the document back. It authors NO positioning option: the append is at the END of
      // the document because `Push` is the route measured to append there.
      //
      // A FAILURE PART WAY THROUGH THE PUSH LOOP IS UNCERTAIN, NOT A REFUSAL. Because the append is one
      // call per block, a native that throws between two calls can leave the document holding SOME of the
      // batch; the body flips its phase to post-insert immediately before the FIRST push, so a throw at
      // any point in the loop answers a post-insert refusal, the bridge decodes it as `APPLY_UNCERTAIN`,
      // HOLDS its slot, and the run stops with `TOOL_UNCERTAIN`. It is never a known refusal for a write
      // that may already have happened, and there is no retry.
      //
      // THE SCHEMA is closed. `blocks` is required, bounded above by `LIMITS.insertBlocksMax`, and each
      // item is a closed object of `text` (bounded by `LIMITS.insertBlockBytes`) and an optional integer
      // `heading` (bounded by `LIMITS.insertHeadingMax`, and mapped to the style name `Heading <n>`). The
      // lower bound of the array is 1 and it is NOT a schema keyword: this module's closed schema
      // vocabulary (src/tools/schemas.js) allowlists every keyword it enforces, and it carries no
      // `minItems`, so advertising one would advertise a constraint nothing applies. The empty array is
      // therefore refused by THIS handler (and by the bridge) as the closed argument class with nothing
      // dispatched — the same treatment every other deep rule of this schema gets.
      //
      // THE FAILURE MAP, each class closed: a wrong editor is `CAPABILITY_UNAVAILABLE` (precondition); a
      // missing bridge entry point is `CAPABILITY_UNAVAILABLE`; a bridge refusal keeps the closed class it
      // reported (`refusalCode`); an envelope this handler cannot interpret is the module's unknown
      // convention, `known()`; a returned or thrown `APPLY_UNCERTAIN` is `TOOL_UNCERTAIN`; an
      // UNRESOLVABLE heading style is `TOOL_ERROR`; and an over-ceiling result entry is `BYTE_LIMIT`.
      //
      // WHY AN UNRESOLVABLE STYLE IS `TOOL_ERROR` RATHER THAN `CAPABILITY_UNAVAILABLE` OR UNCERTAIN. The
      // editor's heading machinery is intact — it resolves styles and it inserts content — so the
      // capability class would misname the failure as "this editor cannot do headings". What this
      // DOCUMENT does not define is the requested `Heading <n>`, so the failure is about the ARGUMENT,
      // and it is not uncertain either: the authored body resolves EVERY style BEFORE its first `Push`, so
      // nothing was inserted, and an uncertain outcome would be false information about a mutation that
      // provably did not happen. The style name is still the MEASURED one — the
      // lookup accepts the English `'Heading <n>'` on a localized document too (`GetStyle('Heading 1')`
      // and the same style as `'Heading1'`, `'heading 1'` and `'Заголовок 1'` all resolve on the target),
      // so the mapping is not a guess about the document's language.
      name: 'insert_blocks', kind: 'mutate', editors: ['word'], policy: 'auto', requires: ['document.write'],
      schema: { type: 'object', additionalProperties: false, required: ['blocks'],
        properties: { blocks: { type: 'array', maxItems: LIMITS.insertBlocksMax,
          items: { type: 'object', additionalProperties: false, required: ['text'],
            properties: { text: { type: 'string', minBytes: 1, maxBytes: LIMITS.insertBlockBytes },
              heading: { type: 'integer', minimum: 1, maximum: LIMITS.insertHeadingMax } } } } } },
      precondition: (args, ctx) => wrongEditor(ctx, ERROR_CODES.CAPABILITY_UNAVAILABLE),
      execute: async (args, ctx) => {
        if (missingBridgeMethod(bridge, 'insertBlocks')) return known(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        // Every argument rule is re-checked HERE and not only by the schema: a descriptor is also
        // executable when it is held directly, and an argument this append cannot interpret must be a
        // closed refusal with NOTHING dispatched, never an append of whatever a coercion produced. The
        // SHAPE family is the module's argument class and the BYTE family is its byte class, the same two
        // the bridge reports for the same two families.
        const blocks = args?.blocks;
        if (!Array.isArray(blocks) || blocks.length < 1 || blocks.length > LIMITS.insertBlocksMax) return known();
        const forwarded = [];
        let bytes = 0;
        let headings = 0;
        for (const block of blocks) {
          if (block === null || typeof block !== 'object' || Array.isArray(block)) return known();
          if (typeof block.text !== 'string' || block.text === '') return known();
          const textBytes = utf8ByteLength(block.text);
          if (textBytes > LIMITS.insertBlockBytes) return known(ERROR_CODES.BYTE_LIMIT);
          const hasHeading = Object.hasOwn(block, 'heading');
          if (hasHeading && (!Number.isSafeInteger(block.heading) || block.heading < 1 || block.heading > LIMITS.insertHeadingMax)) return known();
          bytes += textBytes;
          if (hasHeading) headings += 1;
          forwarded.push(hasHeading ? { text: block.text, heading: block.heading } : { text: block.text });
        }
        // The advertised whole-payload bound, applied to the payload the bridge actually dispatches: the
        // SAME ceiling the runtime applies to one action's arguments (`AGENT_CEILINGS.argumentsBytes`), so
        // this bound can only refuse a call the runtime would have refused anyway. The caller's signal
        // crosses with the blocks so a Stop cancels before dispatch and marks a dispatched append
        // uncertain.
        if (bytes > LIMITS.insertBlocksBytes) return known(ERROR_CODES.BYTE_LIMIT);
        const request = { blocks: Object.freeze(forwarded),
          ...(ctx?.signal === undefined ? {} : { signal: ctx.signal }) };
        let result;
        try { result = await bridge.insertBlocks(request); }
        catch (error) {
          // A write whose outcome is unknown may already have applied: that is the one case which stops
          // the run. Every other bridge throw is a closed local failure.
          const uncertain = uncertainResult(error);
          if (uncertain) return uncertain;
          return known(refusalCode(error?.code, ERROR_CODES.TOOL_ERROR));
        }
        // The bridge settles its own uncertain outcome by RETURNING that envelope (rather than throwing
        // it) when the ticket has already been created, so the class is classified here before any
        // ordinary-refusal path can treat it as a known error.
        const uncertain = uncertainResult(result);
        if (uncertain) return uncertain;
        if (!result || typeof result !== 'object') return known();
        if (result.ok !== true) return known(refusalCode(result.code, ERROR_CODES.TOOL_ERROR));
        // THE ENVELOPE CONTRACT, re-checked here because the descriptor is executable on its own: the four
        // counts are the document's own non-negative safe integers and `present` is EXACTLY one boolean per
        // block — block `i`'s flag says the paragraph the append gave that block carries EXACTLY its text.
        // An answer of any other shape is not one this bridge can have produced — the real bridge's
        // decoder guarantees this shape and turns its own uninterpretable answer into the uncertain class —
        // so publishing it would let a forged envelope pass as a verified append.
        const before = result.paragraphsBefore;
        const after = result.paragraphsAfter;
        const headingsBefore = result.headingsBefore;
        const headingsAfter = result.headingsAfter;
        const present = result.present;
        if (!measuredCount(before) || !measuredCount(after)) return known();
        if (!measuredCount(headingsBefore) || !measuredCount(headingsAfter)) return known();
        if (!Array.isArray(present) || present.length !== blocks.length) return known();
        // The flags are read by INDEX, never through `present.some(...)`/`present.every(...)`. That is not
        // a style choice: this module's authored-code audit treats an invocation reached through a value
        // its local alias analysis has tainted as a computed-execution sink, the analysis is NAME-based
        // and scope-insensitive over the whole bundle, and this local's name is derived from a
        // `result` that another leg taints. An indexed READ of a data array is exactly what it is, and
        // every argument rule below is still checked one flag at a time.
        let everyBlockPresent = true;
        for (let index = 0; index < present.length; index += 1) {
          if (typeof present[index] !== 'boolean') return known();
          if (present[index] !== true) everyBlockPresent = false;
        }
        // THE EXACT-DELTA OUTCOME CONTRACT. Three independent conditions, all of them required, and none
        // of them the primitive's return value: the paragraphs grew by exactly the requested block count,
        // the headings by exactly the blocks that asked for one, and every block carried its own text in
        // the region the append added. A delta that is short, long, or accompanied by a block whose own
        // paragraph does not carry its text is NOT a verified append: the tool publishes the runtime's own
        // uncertain class, the bridge has held its slot, and no retry is ever issued. The region half is
        // required in addition to the counts because the counts alone could describe an unrelated
        // concurrent edit; the counts are required in addition to the region because the region is
        // addressed by `paragraphsBefore`, and a baseline that moved would make the region meaningless.
        // It is NOT "the text exists somewhere in the document": that existential form was satisfiable by
        // a document that already held the block texts, so it verified an append that carried no text.
        const exact = after - before === blocks.length && headingsAfter - headingsBefore === headings &&
          everyBlockPresent;
        if (!exact) return known(ERROR_CODES.TOOL_UNCERTAIN);
        const data = Object.freeze({ inserted: blocks.length, headings, paragraphsBefore: before,
          paragraphsAfter: after, bytes });
        // THE ENFORCED BOUND is the ACTUAL serialized tool-result entry, exactly as the reads measure it:
        // the runtime bounds `JSON.stringify({tool, ...result})` by `AGENT_CEILINGS.toolResultBytes`
        // (16384) and replaces an entry above it with the model-visible literal "the tool result could not
        // be serialized" — the model would receive NO result while the action log recorded `ok`. Every
        // field here is a non-negative safe integer, so this guard cannot fire for any shape this handler
        // can publish (`LIMITS.insertBlocksBytes` states the arithmetic: 195 bytes at every field's widest
        // legal width); it is retained because it is the module's ONE entry measurement, and the failure
        // class for it is closed regardless of reachability.
        const entry = insertBlocksEntryBytes(data);
        if (entry === null || entry > AGENT_CEILINGS.toolResultBytes) return known(ERROR_CODES.BYTE_LIMIT);
        return ok(data);
      }
    }),
    defineTool({
      // Sprint 3 Word tool 6: the TABLE INSERT — the SECOND MUTATION, and the first creation primitive
      // whose success is a claim about a STRUCTURE rather than only about a count. It is the same machinery
      // as `insert_blocks` (§13/§13.2 of docs/sprint-3-progress.md): a pre-dispatch baseline read, ONE
      // self-contained static command body that builds the `Api` facade itself and receives the model's
      // data as `Asc.scope` DATA, a write through the route MEASURED to append at the END (`document.Push`),
      // a post read, and an outcome that is `ok` ONLY on an exact proof.
      //
      // THE MEASURED PRIMITIVES, all established on the target (Astra / R7 2026.1.2.1942) for this round:
      // `Api.CreateTable(columns, rows)` builds the structure and its arguments are in THAT order — the
      // FIRST argument is the COLUMN count and the second is the ROW count. This was measured cell by cell:
      // `CreateTable(3, 2)` fills `GetCell(0..2, 0..1)` while `GetCell(2, 0)`/`(2, 1)`/`(2, 2)` are `null`,
      // so a 3-then-2 call built a 2-row × 3-column table, and `CreateTable(2, 3)` fills columns 0..1 and
      // rows 0..2 while `GetCell(0, 2)`/`(1, 2)`/`(2, 2)` THROW internally (`Cannot read properties of null
      // (reading 'Pr')`), so a 2-then-3 call built 3 rows × 2 columns. `CreateTable(2, 2)` fills all four
      // cells because a SQUARE table is its own transpose — which is why the first version of this tool,
      // passing `(rowCount, columnCount)`, passed a native run on a square matrix and refused the pilot's
      // 1×2 header table with `CAPABILITY_UNAVAILABLE` and nothing written (the fill loop walked a cell
      // that does not exist). `table.GetCell(r, c).GetContent()
      // .GetElement(0).AddText(text)` fills a cell (measured: the cell text appears in the document);
      // `document.GetAllTables()` answers the tables (measured 0 → 1 after one insert); `doc.Push(element)`
      // APPENDS AT THE END while `doc.InsertContent([...])` lands at the BEGINNING and can replace existing
      // text under a selection; and `GetRowCount`/`GetColumnCount` are `undefined`, so this tool uses them
      // NOWHERE — the geometry is the matrix the caller sent, and the count the delta is decided on is the
      // document's own table count. Neither mutation primitive's return value is read: `Push` answered
      // `true` for a paragraph and `false` for an image host, so no boolean says anything about what the
      // document now holds.
      //
      // THE GEOMETRY IS AN EXPLICIT VERIFIED PRECONDITION, not an assumption about the factory (see the
      // bridge body): because the argument order is an assumption about a BUILD, the body reads the LAST
      // cell the fill loop will touch — `(rowCount - 1, columnCount - 1)` — and requires it to exist and to
      // carry the measured chain, and reads `(rowCount, 0)` and requires it to be ABSENT. The probe is
      // defensive in BOTH directions because the target's out-of-range behaviour is measured as
      // ASYMMETRIC (a `null` in one direction, an internal throw in the other), so an inaccessible or
      // throwing address is treated as absence inside the body instead of escaping it. A build whose
      // factory takes the arguments the other way round therefore answers the closed
      // `CAPABILITY_UNAVAILABLE` with ZERO writes rather than a partially filled table.
      //
      // THE PROOF IS ONE-TO-ONE OVER THE APPEND, and for a table that is TWO conditions that cannot
      // substitute for each other: the table count grew by EXACTLY one, AND the table the append added
      // carries EXACTLY the requested matrix in its OWN cells, read back cell by cell in row-major order
      // through the symmetric read of the measured fill chain (`...GetContent().GetElement(0).GetText()`).
      // The appended table is addressed by the baseline the body took BEFORE the one `Push` — `Push`
      // appends, so the insert's table is at index `tablesBefore` — which is what makes the check
      // non-existential: a document that already held the same texts in another table cannot stand in for
      // the insert's own cells. WHAT THE ADDRESS DOES NOT PROVE, corrected here: it catches a route that
      // lands at the START only when the document held at least ONE table before — `tablesBefore >= 1` puts
      // the OLD table at that address, so the flags come out 0 — because at `tablesBefore = 0` a prepending
      // route also leaves a FRESH table at index 0, which is indistinguishable from the appended one by
      // shape alone (measured: such a double answers `ok`). The route is therefore asserted SEPARATELY, by
      // the leg's own primitives and the body's factory-order/geometry precondition, and never by this
      // address alone.
      //
      // THE SCHEMA is closed. `data` is required — a non-empty 2D array of strings whose SHAPE IS DERIVED
      // FROM THE DATA, which is what "rows, columns and data at once" means: the tool has no separate
      // `rows`/`columns` arguments to disagree with the matrix. `LIMITS.insertTableRowsMax`,
      // `insertTableColumnsMax`, `insertTableCellBytes` and `insertTableBytes` bound the row count, the
      // column count, each cell and the whole payload, each with its reasoning stated in limits.js. The
      // lower bound of the array, the lower bound of a row and the RECTANGULARITY are NOT schema keywords:
      // this module's closed schema vocabulary (src/tools/schemas.js) carries no `minItems` and no
      // rectangularity at all, so they are refused by THIS handler and by the bridge as the closed argument
      // class with nothing dispatched — the same treatment every other deep rule of this schema gets.
      // There is deliberately NO `header` option: no measured primitive applies header formatting, so
      // advertising one would promise what the tool cannot do.
      //
      // THE FAILURE MAP, each class closed: a wrong editor is `CAPABILITY_UNAVAILABLE` (precondition); a
      // missing bridge entry point is `CAPABILITY_UNAVAILABLE`; a bridge refusal keeps the closed class it
      // reported (`refusalCode`); an envelope this handler cannot interpret is the module's unknown
      // convention, `known()`; a returned or thrown `APPLY_UNCERTAIN` is `TOOL_UNCERTAIN`; an argument the
      // tool cannot serve (an empty, ragged or over-bound matrix) is the closed argument/byte class with
      // ZERO writes; an over-ceiling result entry is `BYTE_LIMIT`. The refusal PHASE is an explicit slot of
      // the answer, exactly as `insert_blocks` states it: the body answers `[PRE_INSERT, name]` while
      // nothing has been pushed, and it turns `POST_INSERT` IMMEDIATELY BEFORE the one `Push`. A throw OUT
      // OF the push is therefore never a known refusal with the slot released; a throw while the table is
      // being created or filled is a known refusal (the phase is still pre-insert, and provably nothing
      // reached the document). The bridge holds its slot for anything unprovable and issues NO retry.
      name: 'insert_table', kind: 'mutate', editors: ['word'], policy: 'auto', requires: ['document.write'],
      schema: { type: 'object', additionalProperties: false, required: ['data'],
        properties: { data: { type: 'array', maxItems: LIMITS.insertTableRowsMax,
          items: { type: 'array', maxItems: LIMITS.insertTableColumnsMax,
            items: { type: 'string', maxBytes: LIMITS.insertTableCellBytes } } } } },
      precondition: (args, ctx) => wrongEditor(ctx, ERROR_CODES.CAPABILITY_UNAVAILABLE),
      execute: async (args, ctx) => {
        if (missingBridgeMethod(bridge, 'insertTable')) return known(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        // Every argument rule is re-checked HERE and not only by the schema: a descriptor is also
        // executable when it is held directly, and a matrix this insert cannot interpret must be a closed
        // refusal with NOTHING dispatched, never an insert of whatever a coercion produced. The SHAPE
        // family (the non-empty matrix, the non-empty row, the rectangularity, the geometry bounds) is the
        // module's argument class and the BYTE family (one cell, then the sum) is its byte class, the same
        // two the bridge reports for the same two families.
        const data = args?.data;
        if (!Array.isArray(data) || data.length < 1 || data.length > LIMITS.insertTableRowsMax) return known();
        const forwarded = [];
        let columns = null;
        let bytes = 0;
        for (const row of data) {
          if (!Array.isArray(row) || row.length < 1 || row.length > LIMITS.insertTableColumnsMax) return known();
          if (columns === null) columns = row.length;
          else if (row.length !== columns) return known();
          const shapedRow = [];
          for (const cell of row) {
            if (typeof cell !== 'string') return known();
            const cellBytes = utf8ByteLength(cell);
            if (cellBytes > LIMITS.insertTableCellBytes) return known(ERROR_CODES.BYTE_LIMIT);
            bytes += cellBytes;
            shapedRow.push(cell);
          }
          forwarded.push(Object.freeze(shapedRow));
        }
        // The advertised whole-payload bound, applied to the payload the bridge actually dispatches: the
        // SAME ceiling the runtime applies to one action's arguments (`AGENT_CEILINGS.argumentsBytes`), so
        // this bound can only refuse a call the runtime would have refused anyway. `columns` cannot be null
        // here: `data` is non-empty and every row is non-empty, which is what the two checks above establish
        // — and a null would make the flag count below meaningless rather than silently wrong.
        if (columns === null || columns < 1) return known();
        if (bytes > LIMITS.insertTableBytes) return known(ERROR_CODES.BYTE_LIMIT);
        const request = { data: Object.freeze(forwarded),
          ...(ctx?.signal === undefined ? {} : { signal: ctx.signal }) };
        let result;
        try { result = await bridge.insertTable(request); }
        catch (error) {
          // A write whose outcome is unknown may already have applied: that is the one case which stops
          // the run. Every other bridge throw is a closed local failure.
          const uncertain = uncertainResult(error);
          if (uncertain) return uncertain;
          return known(refusalCode(error?.code, ERROR_CODES.TOOL_ERROR));
        }
        // The bridge settles its own uncertain outcome by RETURNING that envelope (rather than throwing it)
        // when the ticket has already been created, so the class is classified here before any
        // ordinary-refusal path can treat it as a known error.
        const uncertain = uncertainResult(result);
        if (uncertain) return uncertain;
        if (!result || typeof result !== 'object') return known();
        if (result.ok !== true) return known(refusalCode(result.code, ERROR_CODES.TOOL_ERROR));
        // THE ENVELOPE CONTRACT, re-checked here because the descriptor is executable on its own: the two
        // counts are the document's own non-negative safe integers and `present` is EXACTLY one boolean per
        // cell of THIS matrix — cell `[r][c]`'s flag says the inserted table's own cell `(r, c)` carries
        // exactly the requested text. An answer of any other shape is not one this bridge can have produced
        // — the real bridge's decoder guarantees this shape and turns its own uninterpretable answer into
        // the uncertain class — so publishing it would let a forged envelope pass as a verified insert.
        const rows = data.length;
        const before = result.tablesBefore;
        const after = result.tablesAfter;
        const present = result.present;
        if (!measuredCount(before) || !measuredCount(after)) return known();
        if (!Array.isArray(present) || present.length !== rows * columns) return known();
        // The flags are read by INDEX, never through `present.some(...)`/`present.every(...)`. That is not a
        // style choice: this module's authored-code audit treats an invocation reached through a value its
        // local alias analysis has tainted as a computed-execution sink, the analysis is NAME-based and
        // scope-insensitive over the whole bundle, and this local's name is derived from a `result` that
        // another leg taints. An indexed READ of a data array is exactly what it is, and every argument rule
        // below is still checked one flag at a time.
        let everyCellPresent = true;
        for (let index = 0; index < present.length; index += 1) {
          if (typeof present[index] !== 'boolean') return known();
          if (present[index] !== true) everyCellPresent = false;
        }
        // THE EXACT-DELTA OUTCOME CONTRACT. Two independent conditions, both required, and neither of them
        // the primitive's return value: the document's table count grew by EXACTLY one, and EVERY cell of
        // the table the append added carries EXACTLY the requested text in the slot this matrix owns. A
        // delta that is short, long, or accompanied by a cell whose own text is not the requested one is
        // NOT a verified insert: the tool publishes the runtime's own uncertain class, the bridge has held
        // its slot, and no retry is ever issued. The cell half is required in addition to the count because
        // the count alone could describe an unrelated concurrent edit; the count is required in addition to
        // the cells because the cells are addressed by `tablesBefore`, and a baseline that moved would make
        // the address meaningless. It is NOT "the matrix exists somewhere in the document": that existential
        // form was satisfiable by a document that already held the same texts in another table.
        const exact = after - before === 1 && everyCellPresent;
        if (!exact) return known(ERROR_CODES.TOOL_UNCERTAIN);
        const published = Object.freeze({ rows, columns, tablesBefore: before, tablesAfter: after, bytes });
        // THE ENFORCED BOUND is the ACTUAL serialized tool-result entry, exactly as the reads measure it:
        // the runtime bounds `JSON.stringify({tool, ...result})` by `AGENT_CEILINGS.toolResultBytes` (16384)
        // and replaces an entry above it with the model-visible literal "the tool result could not be
        // serialized" — the model would receive NO result while the action log recorded `ok`. Every field
        // here is a non-negative safe integer, so this guard cannot fire for any shape this handler can
        // publish (`LIMITS.insertTableBytes` states the arithmetic: 181 bytes at every field's widest legal
        // width); it is retained because it is the module's ONE entry measurement, and the failure class for
        // it is closed regardless of reachability.
        const entry = insertTableEntryBytes(published);
        if (entry === null || entry > AGENT_CEILINGS.toolResultBytes) return known(ERROR_CODES.BYTE_LIMIT);
        return ok(published);
      }
    }),
    defineTool({
      // Sprint 3 Word tool 7: the HEADING STYLE ASSIGNMENT. It is the THIRD MUTATION of this sprint and the
      // FIRST one that does NOT append: it changes an EXISTING paragraph IN PLACE, at an index the caller
      // names, and it creates no paragraph, no table and no text. That difference is the whole shape of
      // this descriptor, so the mutation ground truth is stated again rather than inherited:
      //
      // THE MEASURED PRIMITIVES, established on the target (Astra / R7 2026.1.2.1942, this round) and
      // treated as given: `document.GetStyle('Heading 1')` RESOLVES (the lookup also accepts `'Heading1'`,
      // `'heading 1'` and the localized `'Заголовок 1'`), `style.GetName()` answers `'Heading 1'`,
      // `paragraph.SetStyle(style)` is a public function and APPLIES, and afterwards the paragraph really
      // IS a heading — `GetAllHeadingParagraphs()` grew 3 → 4 while `GetAllParagraphs()` grew 10 → 11 on a
      // newly created paragraph. Here the SAME measured route is applied to an EXISTING paragraph at a
      // known index, which is why no `Push` and no `InsertContent` appears anywhere in this leg:
      // `doc.Push` appends (nothing is appended here) and `doc.InsertContent` inserts at the BEGINNING and
      // can REPLACE text under a selection (measured, §13.2) — a route that would destroy the very text
      // this tool promises to leave unchanged.
      //
      // THE STYLE READBACK IS MEASURED, AND IT IS THE PROOF. The target was MEASURED (Astra / R7
      // 2026.1.2.1942) to answer the paragraph's OWN style through the chain
      // `paragraph.GetParaPr().GetStyle().GetName()`: for a paragraph carrying an explicit Heading style
      // `GetStyle()` returns a STYLE OBJECT (`GetClassType()` = `'style'`) whose `GetName()` answers the
      // canonical `'Heading 1'`, and for a plain Normal paragraph it answers `null`. That is an exact,
      // PER-OBJECT proof and it needs neither identity nor text uniqueness.
      // AN EARLIER REVISION OF THIS LEG IS DEAD BECAUSE THE LEAD MEASURED IT FALSE: it decided "the addressed
      // paragraph is now a heading" by OBJECT IDENTITY — the object the body addressed had to BE an element
      // of `GetAllHeadingParagraphs()`. On a three-paragraph document with one heading, the two lists answered
      // equal TEXT while `GetAllHeadingParagraphs()[0] === GetAllParagraphs()[i]` was FALSE for EVERY i: the
      // lists hand out DIFFERENT wrapper objects, so no reference comparison can ever hold, and relying on it
      // would have turned EVERY call into `TOOL_UNCERTAIN` with the write slot held for the session.
      //
      // THE OUTCOME CONTRACT IS ONE-TO-ONE FOR THE TARGET PARAGRAPH, and the READBACK is its PRIMARY leg.
      // `ok` is published ONLY when the post read shows ALL of:
      //   1. the addressed paragraph's OWN style name WAS READ (`styleRead`) and MATCHES the requested
      //      `Heading <n>` (`styleMatches`) under the SAME case- and space-folding `readsStyleName` applies
      //      (the editor's lookup was measured to accept `'Heading1'`/`'heading 1'` for that one style, so a
      //      differently SPELLED answer is a match and not the false disagreement that used to hold the
      //      write lock on a mutation that had succeeded). A readable name that differs by more than case and
      //      spaces — INCLUDING the measured `null` of a plain paragraph, which arrives as a READABLE
      //      non-match — is a genuine contradiction and the outcome is uncertain. THIS LEG IS THE ONLY ONE
      //      THAT CAN ESTABLISH AN ASSIGNMENT;
      //   2. the addressed paragraph's TEXT is EXACTLY what it was BEFORE the mutation (`textUnchanged`) —
      //      read by the body around the single `SetStyle`, so a route that replaced text (the measured
      //      `InsertContent`-under-a-selection behaviour) and a stale index whose paragraph now holds
      //      something else can never be reported as a success. THE TEXT IS A SECONDARY SIGNAL: it can
      //      REFUTE an assignment and it can never ESTABLISH one, because two paragraphs of one document can
      //      carry the same text. (An independent review drove exactly that false success through the real
      //      body when an even older text-membership leg stood here: two paragraphs with the SAME text and a
      //      `SetStyle` that landed on the second one was reported `ok` with the slot released while the
      //      addressed paragraph was never restyled. The duplicate-text case is now settled by the addressed
      //      paragraph's OWN style, and the reviewer's reproduction is kept as a regression test.)
      //   3. the document's paragraph count is UNCHANGED (`paragraphsStable`) — a style assignment changes no
      //      paragraph's existence, so a paragraph count that moved means something else happened to the
      //      document and the outcome is uncertain — and its heading count grew by EXACTLY one. Both are
      //      SECONDARY signals that can only REFUTE.
      // THE DECIDED FAILURE PATH FOR AN UNUSABLE READBACK: a build where `GetStyle()` answers nothing
      // readable, or where `GetName()` is absent or throws, cannot establish the assignment — and the
      // mutation has ALREADY happened by the time the post read is taken. The honest outcome is therefore
      // `TOOL_UNCERTAIN` with the slot HELD: never `ok`, and never a known class. There is NO fallback on
      // identity (measured impossible, above) and none on the text (never sufficient).
      // THE ONE CASE THIS TOOL CANNOT VERIFY IS REFUSED, NOT GUESSED AT: a paragraph whose OWN style name is
      // already a HEADING name is not a supported target. The one signal a style assignment moves is the
      // heading COUNT, and a LEVEL CHANGE on an existing heading moves it NOWHERE (the document loses one
      // heading and gains one), so no measured signal could tell an applied level change from a route that
      // did nothing at all. The body detects it BEFORE the one `SetStyle` — from the SAME readback, on the
      // addressed paragraph itself — and answers the closed argument class (`TOOL_ERROR`) with ZERO writes
      // and the slot RELEASED. It is recorded as a stated limitation in §15b of docs/sprint-3-progress.md,
      // together with the verifiable route a level change WOULD need: the pre-name must be the old heading
      // style and the post-name must match the request, with the counts and the text unchanged. That route
      // is NOT taken yet, in one sentence, because the in-place effect of `SetStyle` on an EXISTING heading
      // paragraph (as opposed to the newly created paragraph the append-side measurement used) was never
      // measured on the target, so the count legs could neither confirm nor refute a level change and the
      // proof would rest on the readback pair alone.
      // NO MUTATION PRIMITIVE'S RETURN VALUE IS READ anywhere in this leg: `Push` answered `true` for a
      // paragraph and `false` for an image host, and the legacy whole-array primitive answered `true` even
      // for `[]`, `[null]` and `'nonsense'` (all measured), so no boolean says anything about what the
      // document now holds. The post read is the evidence, exactly as in `insert_blocks`/`insert_table`.
      //
      // THE SCHEMA IS CLOSED, `additionalProperties: false`, `required: ['paragraph', 'level']`:
      //   * `paragraph` is the 0-BASED index, integer, bounded by `LIMITS.setHeadingIndexMax` (128; the
      //     limit states the reasoning, and the descriptor's own comment is not a second copy of it). The
      //     bound is ADVERTISE-AND-VERIFY: the body additionally requires the index to be inside the
      //     document's OWN `GetAllParagraphs()` array BEFORE the single mutation, so an index past the end
      //     of this document is a closed argument refusal with ZERO writes.
      //   * `level` is the heading level, integer 1..`LIMITS.insertHeadingMax` (9), mapped by
      //     `headingStyleName` to the style name `Heading <n>` — the SAME family and the SAME measured
      //     naming `insert_blocks` already uses, so a level means one thing in this whole module.
      // There is deliberately NO `text` argument and no `style`/`styleName` argument: the tool changes the
      // style of a paragraph the DOCUMENT already holds, and a caller that could name the style string
      // directly would address a name this module never measured. The style is DERIVED from the level.
      //
      // THE FAILURE MAP, each class closed: a wrong editor is `CAPABILITY_UNAVAILABLE` (precondition); an
      // index or level outside the advertised bounds is the closed argument class with ZERO writes
      // (precondition — the same place `read_context` applies its own address bound); a missing bridge
      // entry point is `CAPABILITY_UNAVAILABLE`; a BASELINE that cannot be read and an index outside the
      // DOCUMENT are `CAPABILITY_UNAVAILABLE` with ZERO writes (the body's pre-insert half, measured
      // BEFORE the one `SetStyle`, exactly as `insert_blocks` resolves every style before its first
      // `Push`); a target whose own style name is ALREADY a heading name is the closed ARGUMENT class
      // (`ALREADY_HEADING` → `TOOL_ERROR`) with ZERO writes and the slot RELEASED — a level change on an
      // existing heading is not supported, and the body decides it BEFORE the mutation rather than settling
      // `TOOL_UNCERTAIN` on it;
      // an unresolvable `Heading <n>` is the closed argument/style class (`STYLE_UNAVAILABLE` →
      // `TOOL_ERROR`) with ZERO writes, resolved BEFORE the mutation for the same reason; a bridge refusal
      // keeps the closed class it reported (`refusalCode`); an envelope this handler cannot interpret is
      // the module's unknown convention, `known()`; a returned or thrown `APPLY_UNCERTAIN` is
      // `TOOL_UNCERTAIN`; an outcome that is not the exact proof above is `TOOL_UNCERTAIN` with the slot
      // HELD and NO retry; and an over-ceiling result entry is `BYTE_LIMIT`.
      //
      // THE MECHANISM is ONE authored command body in the bridge (`setHeading` → `command.heading`),
      // static and self-contained exactly like the search, structure, block and table bodies: it builds
      // the `Api` facade itself, receives `{ paragraph, level, styleName }` as DATA through the `Asc.scope`
      // parameter channel (never interpolated into source, ADR 0002), reads the baseline, resolves the
      // style, reads the addressed paragraph's own style name and text, turns its phase to `POST_INSERT`
      // IMMEDIATELY BEFORE the single `paragraph.SetStyle(style)`, and then re-reads the whole document
      // state. The phase is an explicit slot of every answer, exactly as `insert_blocks`/`insert_table`
      // state it: a throw out of the mutation is never a known refusal with the slot released.
      name: 'set_heading', kind: 'mutate', editors: ['word'], policy: 'auto', requires: ['document.write'],
      schema: { type: 'object', additionalProperties: false, required: ['paragraph', 'level'],
        properties: { paragraph: { type: 'integer', minimum: 0, maximum: LIMITS.setHeadingIndexMax },
          level: { type: 'integer', minimum: 1, maximum: LIMITS.insertHeadingMax } } },
      precondition: (args, ctx) => {
        if (ctx?.editor !== 'word') return { code: ERROR_CODES.CAPABILITY_UNAVAILABLE, message: REFUSAL };
        // The address and the level are re-checked HERE and not only by the schema: a descriptor is also
        // executable when it is held directly, and an address or a level this mutation cannot interpret
        // must be a closed refusal with NOTHING dispatched, never a style applied to whatever a coercion
        // produced. This is the same treatment `read_context` gives its own bounded index.
        if (!Number.isSafeInteger(args?.paragraph) || args.paragraph < 0 || args.paragraph > LIMITS.setHeadingIndexMax) {
          return { code: ERROR_CODES.TOOL_ERROR, message: REFUSAL };
        }
        if (headingStyleName(args?.level) === null) return { code: ERROR_CODES.TOOL_ERROR, message: REFUSAL };
        return null;
      },
      execute: async (args, ctx) => {
        if (missingBridgeMethod(bridge, 'setHeading')) return known(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        // The level maps to ONE style name, computed ONCE and carried to the body, so the name the editor
        // resolves and the name this handler measured against cannot be two different strings.
        const styleName = headingStyleName(args?.level);
        if (!Number.isSafeInteger(args?.paragraph) || args.paragraph < 0 || args.paragraph > LIMITS.setHeadingIndexMax) return known();
        if (styleName === null) return known();
        // `bytes` is the size of the dispatched SCOPE — the three values that cross to the editor — and it
        // is measured on exactly what is forwarded, never on a prefix or on the caller's raw object.
        const request = { paragraph: args.paragraph, level: args.level, styleName,
          ...(ctx?.signal === undefined ? {} : { signal: ctx.signal }) };
        const bytes = utf8ByteLength(`${args.paragraph}:${args.level}:${styleName}`);
        let result;
        try { result = await bridge.setHeading(request); }
        catch (error) {
          // A write whose outcome is unknown may already have applied: that is the one case which stops
          // the run. Every other bridge throw is a closed local failure.
          const uncertain = uncertainResult(error);
          if (uncertain) return uncertain;
          return known(refusalCode(error?.code, ERROR_CODES.TOOL_ERROR));
        }
        // The bridge settles its own uncertain outcome by RETURNING that envelope (rather than throwing it)
        // when the ticket has already been created, so the class is classified here before any
        // ordinary-refusal path can treat it as a known error.
        const uncertain = uncertainResult(result);
        if (uncertain) return uncertain;
        if (!result || typeof result !== 'object') return known();
        if (result.ok !== true) return known(refusalCode(result.code, ERROR_CODES.TOOL_ERROR));
        // THE ENVELOPE CONTRACT, re-checked here because the descriptor is executable on its own: the two
        // counts are the document's own non-negative safe integers, and the three flags are EXACTLY
        // booleans — `paragraphsStable` says the document's paragraph count did not move, `textUnchanged`
        // that the addressed paragraph's text is what it was before the mutation, and `styleRead` says
        // whether the ADDRESSED paragraph's own style name was READABLE at all (`styleMatches` is then
        // meaningful, and is `false` when it was not read). An answer of any other shape is not one this
        // bridge can have produced — the real bridge's decoder guarantees this shape and turns its own
        // uninterpretable answer into the uncertain class — so publishing it would let a forged envelope
        // pass as a verified assignment.
        const headingsBefore = result.headingsBefore;
        const headingsAfter = result.headingsAfter;
        // THE ENVELOPE CONTRACT, re-decided here because the descriptor is executable on its own. The order
        // of these checks is the CONTRACT and not a style choice: everything a real run of this bridge
        // cannot produce is the module's unknown class (`known()`, the closed tool-error class), while the
        // two shapes it CAN produce and yet not stand behind are the runtime's own `TOOL_UNCERTAIN`.
        if (!measuredCount(headingsBefore) || !measuredCount(headingsAfter)) return known();
        if (typeof result.paragraphsStable !== 'boolean' || typeof result.textUnchanged !== 'boolean') return known();
        if (typeof result.styleRead !== 'boolean') return known();
        // The envelope NAMES THE STYLE IT WAS PRODUCED FOR, and it must be the one THIS request meant: the
        // name is DERIVED from the level and carried to the body, so an `ok` answer carrying a different
        // name — or no name at all — was produced for a request this handler did not make and is never
        // republished as its proof. `readsStyleName` carries the comparison and its rationale; the name the
        // handler PUBLISHES is still the `Heading <n>` this request meant, so a differently spelled answer
        // can never leak into the result.
        if (!readsStyleName(result, styleName)) return known();
        // THE OUTCOME IS DECIDED BY THE BRIDGE, which is the only party that read the editor: this handler
        // republishes the proof and refuses to publish a state that claims to be verified while its own
        // fields contradict it. Two contradictions are closed as `TOOL_UNCERTAIN` rather than as an unknown
        // envelope, because they are exactly the shapes a write that may already have applied leaves
        // behind: a heading count that did not grow by exactly one, and a proof flag that is `false`. The
        // bridge publishes `ok` ONLY for the exact proof, so an `ok` whose own delta or flags say otherwise
        // is a mutation whose outcome this tool cannot claim — and the run stops fail-safe instead of
        // reporting a known failure about a document that may already carry the style.
        if (headingsAfter - headingsBefore !== 1) return known(ERROR_CODES.TOOL_UNCERTAIN);
        if (result.paragraphsStable !== true || result.textUnchanged !== true) return known(ERROR_CODES.TOOL_UNCERTAIN);
        // A READBACK THAT WAS NOT READ, AND A READABLE READBACK THAT DISAGREES, ARE BOTH THE SAME
        // CONTRADICTION: `exactHeadingDelta` never lets either out of the bridge as an `ok` (the readback is
        // its PRIMARY leg and there is no identity or text fallback), so an `ok` carrying one is never a
        // verified assignment — and the run stops fail-safe instead of reporting a known failure about a
        // document that may already carry the style.
        const styleMatches = result.styleMatches === true;
        if (!result.styleRead || !styleMatches) return known(ERROR_CODES.TOOL_UNCERTAIN);
        const published = Object.freeze({ paragraph: args.paragraph, level: args.level, heading: true,
          headingsBefore, headingsAfter, styleRead: result.styleRead, styleMatches, bytes });
        // THE ENFORCED BOUND is the ACTUAL serialized tool-result entry, exactly as the reads and the two
        // other mutations measure it: the runtime bounds `JSON.stringify({tool, ...result})` by
        // `AGENT_CEILINGS.toolResultBytes` (16384) and replaces an entry above it with the model-visible
        // literal "the tool result could not be serialized" — the model would receive NO result while the
        // action log recorded `ok`. The fields are bounded scalars (`LIMITS.setHeadingIndexMax` states the
        // arithmetic), so this guard cannot fire for any shape this handler can publish; it is retained
        // because it is the module's ONE entry measurement, and its failure class is closed regardless.
        const entry = setHeadingEntryBytes(published);
        if (entry === null || entry > AGENT_CEILINGS.toolResultBytes) return known(ERROR_CODES.BYTE_LIMIT);
        return ok(published);
      }
    }),
    defineTool({
      name: 'replace_selection', kind: 'mutate', editors: ['word'], policy: 'confirm',
      requires: ['document.read', 'document.write'],
      schema: { type: 'object', additionalProperties: false, required: ['text'],
        properties: { text: { type: 'string', maxBytes: AGENT_CEILINGS.argumentsBytes, minBytes: 1 } } },
      precondition: () => null,
      // Never reached from the loop: the runtime publishes PREVIEW_READY for a confirm descriptor.
      // The advertised bound is still the one the runtime applies (`AGENT_CEILINGS.argumentsBytes`),
      // and the handler applies the same bound so advertised and enforced cannot drift apart.
      execute: async (args) => {
        if (utf8ByteLength(args.text) > AGENT_CEILINGS.argumentsBytes) return known(ERROR_CODES.BYTE_LIMIT);
        return ok({ proposed: utf8ByteLength(args.text) });
      }
    })
  ];
}
