// src/tools/word.js — representative Word tools; Sprint 3+ adds the full catalogue here.
//
// A descriptor here is one author-written static handler: the model's arguments arrive already
// validated by the registry's closed schema, so a handler only classifies, measures and passes
// them on. Handlers never touch the SDK, the DOM or localStorage: everything crosses the injected
// `bridge`, which is the only component that owns an R7 callback slot.
import { defineTool } from './registry.js';
import { ERROR_CODES } from '../shared/errors.js';
import { AGENT_CEILINGS } from '../shared/limits.js';
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
      // registry's `catalogue` skips a denied entry, and that catalogue is the only place the PRODUCT
      // turns a model tool name into an executable descriptor — `runAgent` builds its catalogue through
      // that call and `validateBatch` resolves against it — so a model-emitted `read_context` is a
      // closed TOOL_ERROR with no dispatch. That is NOT a property of the registry as a whole:
      // `registry.tools` still hands out this descriptor, and a caller that bypasses the catalogue and
      // invokes `descriptor.execute` directly still reaches the handler kept below. The product never
      // does that, so the catalogue-scoped `resolve`/`validateBatch` path is what makes the tool
      // unexecutable in the product — no more and no less. PENDING NATIVE VERIFICATION.
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
          if (error?.code === ERROR_CODES.APPLY_UNCERTAIN) {
            return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_UNCERTAIN, message: REFUSAL });
          }
          return known(refusalCode(error?.code, ERROR_CODES.TOOL_ERROR));
        }
        if (!result || typeof result !== 'object') return known();
        if (result.ok !== true) return known(refusalCode(result.code, ERROR_CODES.TOOL_ERROR));
        // The native acknowledgement is the only insert evidence there is: the bridge envelope carries
        // {ok:true, data:{sent:<boolean>}} and the native return value is never effect proof. Only a
        // literal own `true` is reported as an acknowledged insert; an explicit false, an absent flag
        // and a non-boolean are known errors, so the model is never told that an insert the editor did
        // not acknowledge succeeded.
        const data = result.data;
        const acknowledged = data !== null && typeof data === 'object' && Object.hasOwn(data, 'sent') ? data.sent : undefined;
        if (acknowledged !== true) return known(ERROR_CODES.TOOL_ERROR);
        // `bytes` is the dispatched payload's own size, the same value the bound above measured (so an
        // `end` insert reports the newline too, exactly like the bytes that crossed to the editor).
        return ok({ acknowledged: true, bytes: utf8ByteLength(dispatched) });
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
