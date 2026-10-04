// src/tools/registry.js
import { ERROR_CODES, SafeError } from '../shared/errors.js';
import { validateToolSchema } from './schemas.js';

const kinds = new Set(['read', 'mutate']);
const policies = new Set(['auto', 'confirm', 'deny']);
const editors = new Set(['word', 'cell', 'slide']);
const fieldNames = ['name', 'kind', 'editors', 'schema', 'policy', 'requires', 'precondition', 'execute'];
const capabilityFor = { read: 'document.read', mutate: 'document.write' };

export function defineTool(descriptor) {
  if (descriptor === null || typeof descriptor !== 'object' || Array.isArray(descriptor)) throw new SafeError(ERROR_CODES.INVALID_DATA);
  // Object.keys() enumerates only own properties, so this allowlist sees no prototype-carried and
  // no non-enumerable key — those must never be able to contribute a field to the tool either.
  for (const key of Object.keys(descriptor)) if (!fieldNames.includes(key)) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (typeof descriptor.name !== 'string' || !/^[a-z][a-z0-9_]{2,39}$/.test(descriptor.name)) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (!kinds.has(descriptor.kind)) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (!Array.isArray(descriptor.editors) || descriptor.editors.length === 0 || descriptor.editors.some(editor => !editors.has(editor))) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (!policies.has(descriptor.policy)) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (!Array.isArray(descriptor.requires)) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (typeof descriptor.precondition !== 'function' || typeof descriptor.execute !== 'function') throw new SafeError(ERROR_CODES.INVALID_DATA);
  validateToolSchema(descriptor.schema);
  // The frozen tool is CONSTRUCTED from the values just validated, never spread from the input:
  // spreading copies only own enumerable properties, so a descriptor whose fields live on its
  // prototype (or whose execute is non-enumerable) would otherwise pass every check above and
  // yet produce a catalogue entry with no handler — malformed at load, broken at runtime.
  const validated = {};
  for (const key of fieldNames) validated[key] = descriptor[key];
  validated.editors = Object.freeze([...validated.editors]);
  validated.requires = Object.freeze([...validated.requires]);
  return Object.freeze(validated);
}

export function createRegistry(descriptors) {
  if (!Array.isArray(descriptors)) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const tools = descriptors.map(defineTool);
  const names = new Set();
  for (const tool of tools) {
    if (names.has(tool.name)) throw new SafeError(ERROR_CODES.INVALID_DATA);
    names.add(tool.name);
  }
  // Dispatch is the descriptor's own static execute function: the catalogue is a closed
  // allowlist of validated descriptors, the model's name is only a data key, and no
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
    return Object.freeze(tools.filter(tool => tool.editors.includes(editor) &&
      (mode !== 'ASK' || tool.kind !== 'mutate') &&
      tool.policy !== 'deny' &&
      granted.has(capabilityFor[tool.kind])));
  }
  function resolve(list, name) {
    if (typeof name !== 'string') return null;
    return list.find(entry => entry.name === name) ?? null;
  }
  return Object.freeze({ tools: Object.freeze(tools), catalogue, resolve });
}
