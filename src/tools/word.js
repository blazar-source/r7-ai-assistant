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
        const end = characterEnd(document.text, Math.min(document.text.length, offset + maxChars, LIMITS.readDocumentOffsetMax));
        const text = document.text.slice(start, end);
        // `truncated` and `nextOffset` are ONE fact: a successor exists exactly when the chunk did not
        // reach the end of the document, and a chunk that ends exactly at the end — or an offset at or
        // past it — has none. Everything is counted in the string's own code units, the same unit
        // `offset`/`maxChars`/`totalChars` use, so a resumed read is contiguous and cannot skip.
        // A chunk that consumed NOTHING has no successor to publish: publishing `nextOffset === offset`
        // would invite a call that returns the same empty chunk forever. A chunk the ADDRESS BOUND
        // stopped publishes that bound as its resume point — an address the schema accepts, whose read
        // is the empty tail — because the bound and the end of the text are the same place from here.
        const nextOffset = end > offset && end < totalChars ? end
          : end === LIMITS.readDocumentOffsetMax && end < totalChars ? LIMITS.readDocumentOffsetMax : null;
        // The ENFORCED bound is the ACTUAL serialized tool-result entry, not the raw text and not
        // `LIMITS.editorResultBytes`: the runtime bounds `JSON.stringify({tool, ...result})` by
        // `AGENT_CEILINGS.toolResultBytes` — 16384 bytes, not 65536 — and an entry above it is refused
        // whole, with the model receiving the literal "the tool result could not be serialized" and NO
        // text. Measuring the entry here is what makes the tool's own bound and the runtime's the same
        // bound. The arithmetic (Cyrillic 2 bytes/character, ASCII 1, CJK 3, an astral pair 4 over two
        // units) plus the envelope `LIMITS.readDocumentEntryBytes` is what sizes the advertised chunk:
        // 8000 Cyrillic characters = 16000 bytes + 130 = 16130 <= 16384. A chunk that does not fit even
        // so is refused with the closed BYTE_LIMIT class, never truncated — a truncated chunk would
        // publish a resume point that skips text the model never saw — and the refusal is the only thing
        // an entry above the ceiling can ever produce from here. Together with the `totalChars` fence
        // above, this is the fail-closed floor: nothing the handler cannot serialize or cannot address
        // leaves it as a result at all.
        // The measurement carries the values that are ABOUT TO BE PUBLISHED, which is why `nextOffset`
        // is computed first: the truncated shape serializes `"truncated":true` plus a numeric resume
        // point, while the assumed nil shape serializes the shorter `"truncated":false` plus
        // `"nextOffset":null` — 1 byte LESS on the six-digit offsets (`true` against `null`, both over
        // `false`), and a wider gap at smaller offsets. A measurement taken against the nil resume point
        // therefore UNDERCOUNTED the published entry, and a chunk whose assumed entry was exactly
        // `AGENT_CEILINGS.toolResultBytes` (16384) passed the `> ceiling` check while the entry actually
        // published made `stringifyToolResults` (protocol.js:91) throw; `runtime.js:27-36` replaced the
        // whole result with its literal refusal, the model received NO text, and the run's action log
        // still recorded `ok` — a fail-open signal for exactly the chunk sizes the ceiling is meant to
        // allow. There is ONE measurement here, of the one entry, in the one shape that is published:
        // the alternative — keeping the nil-resume-point figure and widening the guard by a byte or
        // three — would be a second, competing measurement that has to be re-derived every time a field
        // width changes and is exactly the drift this handler was caught by. The exact form is sound
        // because the value measured is the value returned below, byte for byte, in the protocol's own
        // key order.
        const bytes = documentEntryBytes(text, offset, totalChars, nextOffset);
        if (bytes === null || bytes > AGENT_CEILINGS.toolResultBytes) return known(ERROR_CODES.BYTE_LIMIT);
        return ok({ text, offset, totalChars, truncated: nextOffset !== null, nextOffset });
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
