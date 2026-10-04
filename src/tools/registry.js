// src/tools/registry.js
import { ERROR_CODES, SafeError } from '../shared/errors.js';
import { validateToolSchema } from './schemas.js';

const kinds = new Set(['read', 'mutate']);
const policies = new Set(['auto', 'confirm', 'deny']);
const editors = new Set(['word', 'cell', 'slide']);
const fieldNames = ['name', 'kind', 'editors', 'schema', 'policy', 'requires', 'precondition', 'execute'];
const capabilityFor = { read: 'document.read', mutate: 'document.write' };

export function defineTool(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new SafeError(ERROR_CODES.INVALID_DATA);
  // Object.keys() enumerates only own properties, so this allowlist sees no prototype-carried and
  // no non-enumerable key — those must never be able to contribute a field to the tool either.
  for (const key of Object.keys(raw)) if (!fieldNames.includes(key)) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (typeof raw.name !== 'string' || !/^[a-z][a-z0-9_]{2,39}$/.test(raw.name)) throw new SafeError(ERROR_CODES.INVALID_DATA);
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
  return Object.freeze({ tools: Object.freeze(defined), catalogue, resolve });
}
