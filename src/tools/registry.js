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
// A profile is a CLOSED name for a model-facing SUBSET of the catalogue. It exists because the model
// must be shown a task-appropriate list, and the reason is measured: on the owner's free-form
// ten-page request with the FULL catalogue the model drifted into `insert_paragraph`, which inserts at
// the CURRENT CARET — every call landed inside the title paragraph, the paragraph count never moved,
// and the document never grew — while for the same request, once it reached `insert_blocks` and
// `insert_table`, the document grew 2 -> 30 paragraphs, 1 -> 7 headings and 0 -> 2 tables in ONE run.
const profiles = new Set(['bulk']);
// The ONE bulk (long document generation) list is a closed AUTHORED allowlist rather than a flag spread
// over sixteen descriptors: the membership is one place to read, the profile can only REMOVE entries
// from the model-facing view, and every excluded tool stays defined, published and resolvable through
// the full `catalogue()`. The excluded ones and the measured reason:
//   `insert_paragraph` inserts at the CURRENT CARET and so cannot build volume (the measured defect);
//   `set_heading` addresses an EXISTING paragraph by index and inserts nothing;
//   `add_hyperlink`, `insert_image` and `insert_comment` each decorate ONE object instead of adding text;
//   `replace_text` rewrites text that already exists rather than appending any.
const BULK_TOOLS = Object.freeze(['read_structure', 'read_document_text', 'insert_blocks', 'insert_table', 'format_range']);
// The bound is a BYTE measure on ONE authored line, like every other model-facing string: the text is
// Russian (2 bytes a character), so 1024 bytes is ~500 characters — six short orchestration rules and
// nothing more, measured at 939 bytes below with the slack left for one more measured rule.
export const PROFILE_INSTRUCTION_BYTES = 1024;
// The profile's orchestration contract, authored HERE and rendered verbatim by the runtime: a profile
// that filtered the list without stating HOW to work would leave the model to invent the plan-and-check
// cycle that the bulk task needs, which is the same defect the descriptor guidance exists to remove.
// It is bound to its profile by NAME EQUALITY below, never by a computed lookup: the bundle-wide static
// audit classifies a non-constant computed property READ as a dynamic-property sink, and ONE such read
// taints every identifier it is assigned to across the whole composed bundle (measured: a single
// `INSTRUCTIONS[profile]` read took the audit's clean bundle from 0 to 139 findings).
const BULK_INSTRUCTION = "Профиль 'bulk' — длинный документ: (1) сначала верни ТОЛЬКО ПЛАН документа — разделы, целевой объём и обязательные элементы (таблицы, списки, выводы) — без вызовов инструментов; (2) затем выполняй план по частям; (3) объём набирай insert_blocks (блок добавляется В КОНЕЦ; поле heading делает блок заголовком) и insert_table для таблиц; (4) после прохода перечитай структуру через read_structure и сверь обязательные элементы и фактический объём; (5) если план не выполнен — ПРОДОЛЖАЙ, а не завершай ответ; (6) не повторяй действие, вернувшее TOOL_UNCERTAIN.";

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
  function modelCatalogue(list, profile) {
    if (!Array.isArray(list)) throw new SafeError(ERROR_CODES.INVALID_DATA);
    // A profile is a CLOSED name: "no profile" is the ABSENT argument, and anything else that is not a
    // declared profile is a refusal — never a silent full list, which would hand a bulk task every
    // position-dependent tool again while the caller believed the run had been constrained.
    if (profile !== undefined && !profiles.has(profile)) throw new SafeError(ERROR_CODES.INVALID_DATA);
    const offered = list.filter(entry => entry.policy !== 'confirm');
    if (profile !== 'bulk') return Object.freeze(offered);
    // The profiled view is still a VIEW of the same array: order-preserving, frozen, and only ever a
    // REMOVAL — the excluded descriptors remain in `catalogue` and remain resolvable by name.
    return Object.freeze(offered.filter(entry => BULK_TOOLS.includes(entry.name)));
  }
  // The profile's bounded, authored orchestration line, or null when there is none. It is ONE string
  // (never a line array): it is joined into the runtime's single system message, so a second line would
  // inject an unaccounted-for rule into that text. The closed shape is enforced here, exactly like the
  // descriptor guidance: a non-string, an over-bound text or a control character is INVALID_DATA.
  function profileInstruction(profile) {
    if (profile === undefined) return null;
    // The same CLOSED set the view is checked against decides whether there is an instruction at all.
    if (!profiles.has(profile)) throw new SafeError(ERROR_CODES.INVALID_DATA);
    // The authored line is selected by NAME EQUALITY, never by a computed lookup: `bulk` is the one
    // declared profile, and the bound below is what keeps its single-line shape.
    const text = BULK_INSTRUCTION;
    if (typeof text !== 'string' || utf8ByteLength(text) > PROFILE_INSTRUCTION_BYTES || descriptionControl.test(text)) {
      throw new SafeError(ERROR_CODES.INVALID_DATA);
    }
    return text;
  }
  return Object.freeze({ tools: Object.freeze(publishable), catalogue, modelCatalogue, profileInstruction, resolve });
}
