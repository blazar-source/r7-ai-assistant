// src/tools/registry.js
import { ERROR_CODES, SafeError } from '../shared/errors.js';
import { utf8ByteLength } from '../shared/bytes.js';
import { validateToolSchema } from './schemas.js';

const kinds = new Set(['read', 'mutate']);
const policies = new Set(['auto', 'confirm', 'deny']);
const editors = new Set(['word', 'cell', 'slide']);
// `description` is the MODEL-FACING field: one short, static, authored sentence saying what the tool is
// FOR and — where it matters — what it does NOT do. It is authored data with no dynamic content: no
// document text, no arguments, nothing computed, so it can neither leak nor drift between the
// descriptor and the model.
const fieldNames = ['name', 'description', 'kind', 'editors', 'schema', 'policy', 'requires', 'precondition', 'execute'];
// The bound is a BYTE measure, not a character count: the list is one line of the model-facing rules and
// the product's own vocabulary is Russian (2 bytes a character), so 256 bytes is ~128 Cyrillic
// characters — one or two clauses, which is all a description is allowed to be.
export const TOOL_DESCRIPTION_BYTES = 256;
// A description must stay on ONE line: a newline would inject a second line into the model-facing rules,
// and a control character has no business in a sentence the model is meant to read.
const descriptionControl = /[\u0000-\u001f\u007f]/;
const capabilityFor = { read: 'document.read', mutate: 'document.write' };

export function defineTool(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new SafeError(ERROR_CODES.INVALID_DATA);
  // Object.keys() enumerates only own properties, so this allowlist sees no prototype-carried and
  // no non-enumerable key — those must never be able to contribute a field to the tool either.
  for (const key of Object.keys(raw)) if (!fieldNames.includes(key)) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (typeof raw.name !== 'string' || !/^[a-z][a-z0-9_]{2,39}$/.test(raw.name)) throw new SafeError(ERROR_CODES.INVALID_DATA);
  // The guidance is REQUIRED, never optional: a descriptor without it is a tool the model is offered
  // with no statement of what it is for, which is the measured pilot defect.
  if (typeof raw.description !== 'string' || raw.description.trim() === '') throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (utf8ByteLength(raw.description) > TOOL_DESCRIPTION_BYTES) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (descriptionControl.test(raw.description)) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (!kinds.has(raw.kind)) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (!Array.isArray(raw.editors) || raw.editors.length === 0) throw new SafeError(ERROR_CODES.INVALID_DATA);
  for (const editor of raw.editors) if (!editors.has(editor)) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (!policies.has(raw.policy)) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (!Array.isArray(raw.requires)) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (typeof raw.precondition !== 'function' || typeof raw.execute !== 'function') throw new SafeError(ERROR_CODES.INVALID_DATA);
  validateToolSchema(raw.schema);
  // The frozen tool is CONSTRUCTED from the values just validated, never spread from the input:
  // spreading copies only own enumerable properties, so a raw entry whose fields live on its
  // prototype (or whose execute is non-enumerable) would otherwise pass every check above and
  // yet produce a catalogue entry with no handler — malformed at load, broken at runtime.
  const closed = {};
  for (const key of fieldNames) closed[key] = raw[key];
  closed.editors = Object.freeze([...closed.editors]);
  closed.requires = Object.freeze([...closed.requires]);
  return Object.freeze(closed);
}

export function createRegistry(list) {
  if (!Array.isArray(list)) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const defined = list.map(defineTool);
  const names = new Set();
  for (const entry of defined) {
    if (names.has(entry.name)) throw new SafeError(ERROR_CODES.INVALID_DATA);
    names.add(entry.name);
  }
  // Dispatch is the entry's own static execute function: the catalogue is a closed
  // allowlist of validated entries, the model's name is only a data key, and no
  // computed function lookup exists (defineTool rejects a non-function execute, so a
  // catalogue entry always carries a static handler). Adding a tool therefore touches
  // only its descriptor — never the runtime and never a name-keyed switch.
  // `defined` stays the closed internal list (the identity/name check and the catalogue both read it);
  // what this object PUBLISHES as `tools` is only the descriptors a consumer may reach. A `deny` entry
  // is withheld from the catalogue, so publishing its descriptor here would keep a native primitive
  // alive that no public read backs — a future module iterating `tools` could reach it by name. The
  // withheld descriptor itself is not deleted from the source module: flipping its `policy` back is
  // still the one-value switch.
  const publishable = defined.filter(entry => entry.policy !== 'deny');
  function catalogue(request) {
    // Fail closed on anything not exactly interpretable: an unrecognised mode must never
    // silently promote a session to EDIT (design §9 makes "ASK exposes no mutation tool" a
    // property of this code, not of caller discipline), and a non-array capabilities argument
    // must not surface as a raw TypeError.
    if (request === null || typeof request !== 'object') throw new SafeError(ERROR_CODES.INVALID_DATA);
    const { editor, capabilities, mode } = request;
    if (typeof editor !== 'string' || editor === '') throw new SafeError(ERROR_CODES.INVALID_DATA);
    if (!Array.isArray(capabilities) || capabilities.some(capability => typeof capability !== 'string')) throw new SafeError(ERROR_CODES.INVALID_DATA);
    if (mode !== 'ASK' && mode !== 'EDIT') throw new SafeError(ERROR_CODES.INVALID_DATA);
    const granted = new Set(capabilities);
    const offered = [];
    for (const entry of defined) {
      if (!entry.editors.includes(editor)) continue;
      if (mode === 'ASK' && entry.kind === 'mutate') continue;
      if (entry.policy === 'deny') continue;
      if (!granted.has(capabilityFor[entry.kind])) continue;
      offered.push(entry);
    }
    return Object.freeze(offered);
  }
  function resolve(list, name) {
    if (typeof name !== 'string') return null;
    return list.find(entry => entry.name === name) ?? null;
  }
  // THE LIST THE MODEL IS NAMED. The model-facing tool list is one line per entry, and a `confirm` entry
  // can only ever END an authoring run: the runtime refuses to execute it inside the loop and finishes
  // `PREVIEW_READY` (runtime.js:172), which the panel publishes as `CAPABILITY_UNAVAILABLE` whenever the
  // run has no preview candidate (controller.js:181). Measured on the owner's pilot request: after eight
  // successful actions the model proposed `replace_selection` — the only remaining confirm tool — and the
  // whole authoring run ended there. So a confirm tool is never NAMED to the model.
  // It stays in `catalogue`, deliberately: `validateBatch` resolves a batch against that array, and the
  // panel's Preview/Apply flow needs the descriptor it finds there. Withholding it from `catalogue`
  // instead is NOT available — measured on this tree, that breaks 12 controller preview/apply tests
  // (preview -> canApply -> apply -> APPLY_ACKNOWLEDGED), because `catalogue` is the same array the
  // runtime validates with. This filter is therefore the model-facing VIEW of a catalogue (or of
  // `registry.tools`), never a second source of truth: it can only remove entries, preserves the input
  // order, and adds nothing.
  function modelCatalogue(list) {
    if (!Array.isArray(list)) throw new SafeError(ERROR_CODES.INVALID_DATA);
    return Object.freeze(list.filter(entry => entry.policy !== 'confirm'));
  }
  return Object.freeze({ tools: Object.freeze(publishable), catalogue, modelCatalogue, resolve });
}
