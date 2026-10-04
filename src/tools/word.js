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
// `JSON.stringify({ tool: name, ...result })` in that key order — the shape `stringifyToolResults`
// (src/agent/protocol.js) builds and measures against `AGENT_CEILINGS.toolResultBytes`, and the shape
// whose refusal `appendToolResults` (src/agent/runtime.js) turns into the literal "the tool result
// could not be serialized". This module cannot import that function (src/agent/* is the runtime's own
// layer), so it reproduces the shape; a test pins the two together by measuring the real serializer.
// `utf8ByteLength` counts a STRING value's contribution exactly as `JSON.stringify` emits it, including
// the `\uXXXX` escaping of control characters and lone surrogates, so the whole entry is measured, not
// just the text.
function documentEntryBytes(text, offset, totalChars, nextOffset) {
  let serialized;
  try {
    serialized = JSON.stringify({ tool: 'read_document_text', ok: true,
      data: { text, offset, totalChars, truncated: nextOffset !== null, nextOffset } });
  } catch { return null; }
  return typeof serialized === 'string' ? utf8ByteLength(serialized) : null;
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

// The exact bytes of ONE `read_paragraph` tool-result ENTRY in the form the runtime serializes and
// bounds: `JSON.stringify({ tool: name, ...result })` in that key order, the same shape and the same
// reasoning as `documentEntryBytes` above (the runtime's own serializer is `stringifyToolResults` in
// src/agent/protocol.js, which this module cannot import, so a test pins the two shapes together).
// The measurement is NOT a formality and it is NOT the text's own byte count: `JSON.stringify` escapes
// every C0 control character to two characters and every lone surrogate to six, so a caret context well
// inside `LIMITS.readParagraphBytes` can serialize to an entry far above `AGENT_CEILINGS.toolResultBytes`.
// Measuring the real entry is the only bound that cannot be defeated by the text's own characters.
function paragraphEntryBytes(text, bytes) {
  let serialized;
  try {
    serialized = JSON.stringify({ tool: 'read_paragraph', ok: true, data: { scope: 'sentence', text, bytes } });
  } catch { return null; }
  return typeof serialized === 'string' ? utf8ByteLength(serialized) : null;
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
      // (`.local/stage-b-runtime/vendor-word-sdk-all.js`, dev-only) was counted by scanning the file's
      // TEXT: `Select-String` reports ZERO matches for every one of these names on that 15 MB bundle and
      // is NOT usable as evidence here (measured: it returns 0 for `GetCurrent`, `GetSelectedText` and
      // `pluginMethod_` alike, while the file's text holds 265, 101 and 4). `pluginMethod_GetCurrentParagraph`,
      // `pluginMethod_GetCurrentSentence`, `pluginMethod_GetCurrentWord` and `pluginMethod_GetSelectedText`
      // each occur 0 times, and those zeros prove NOTHING: `pluginMethod_` is not a naming convention in
      // this bundle, it occurs FOUR times in total — the explicit `PasteHtml` / `PasteText` /
      // `OnEncryption` members and the dispatcher's own `"pluginMethod_"+methodName` lookup — so the
      // editor resolves every other method name dynamically and no prefixed literal exists to count.
      // The BARE names are what exist: `GetCurrentParagraph` 125, `GetSelectedText` 101,
      // `GetCurrentWord` 7, `GetCurrentSentence` 6. NO plugin-level PARAGRAPH getter is established:
      // every sampled `GetCurrentParagraph` is document-content-level — `documentContent.GetCurrentParagraph()`
      // and the single `Ct.prototype.GetCurrentParagraph`, i.e. the `Api`/`getTargetDocContent()` route,
      // which manipulates the DOCUMENT rather than the caret and which Phase 0 measured as exposing no
      // `GetSelection` — so this descriptor dispatches no `GetCurrentParagraph` and never reaches for
      // `Api`. `GetCurrentSentence` IS established at the plugin level, by this repo's own history:
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
