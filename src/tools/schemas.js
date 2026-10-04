// src/tools/schemas.js
import { ERROR_CODES, SafeError } from '../shared/errors.js';
import { AGENT_CEILINGS } from '../shared/limits.js';
import { utf8ByteLength } from '../shared/bytes.js';

const types = new Set(['object', 'string', 'integer', 'boolean', 'array']);
const keywords = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum',
  'minimum', 'maximum', 'maxItems', 'maxBytes', 'minBytes']);
// A declared bound must be usable: maxBytes:'x' makes Math.min('x', ceil) NaN, so the
// caller's hard byte ceiling would FAIL OPEN. Every bound is a non-negative safe integer.
function bounded(value) {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 0) throw new SafeError(ERROR_CODES.INVALID_DATA);
}
function checkNumericKeywords(rule) {
  bounded(rule.maxBytes);
  bounded(rule.minBytes);
  bounded(rule.maxItems);
  bounded(rule.minimum);
  bounded(rule.maximum);
}
function validateItems(items) {
  if (items === null || typeof items !== 'object' || Array.isArray(items) || !types.has(items.type)) throw new SafeError(ERROR_CODES.INVALID_DATA);
  validateSchemaNode(items);
  if (items.type === 'object') validateToolSchema(items);
  if (items.type === 'array') validateItems(items.items);
}
function validateSchemaNode(schema) {
  for (const keyword of Object.keys(schema)) if (!keywords.has(keyword)) throw new SafeError(ERROR_CODES.INVALID_DATA);
  checkNumericKeywords(schema);
  if (schema.type === 'array' && (schema.items === undefined || schema.items === null)) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) throw new SafeError(ERROR_CODES.INVALID_DATA);
}
export function validateToolSchema(schema) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) throw new SafeError(ERROR_CODES.INVALID_DATA);
  validateSchemaNode(schema);
  if (schema.type !== 'object' || schema.additionalProperties !== false) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (schema.properties === null || typeof schema.properties !== 'object') throw new SafeError(ERROR_CODES.INVALID_DATA);
  const required = schema.required ?? [];
  if (!Array.isArray(required) || required.some(name => !Object.hasOwn(schema.properties, name))) throw new SafeError(ERROR_CODES.INVALID_DATA);
  for (const property of Object.values(schema.properties)) {
    if (!types.has(property?.type)) throw new SafeError(ERROR_CODES.INVALID_DATA);
    validateSchemaNode(property);
    if (property.type === 'object') validateToolSchema(property);
    if (property.type === 'array') validateItems(property.items);
  }
  return true;
}
function wrong(value, rule) {
  if (rule.type === 'string') return typeof value !== 'string';
  if (rule.type === 'integer') return !Number.isInteger(value);
  if (rule.type === 'boolean') return typeof value !== 'boolean';
  if (rule.type === 'array') return !Array.isArray(value);
  if (rule.type === 'object') return value === null || typeof value !== 'object' || Array.isArray(value);
  return true;
}
function checkValue(rule, value, limitBytes) {
  if (wrong(value, rule)) throw new SafeError(ERROR_CODES.TOOL_ERROR);
  if (rule.enum !== undefined && !rule.enum.includes(value)) throw new SafeError(ERROR_CODES.TOOL_ERROR);
  if (rule.type === 'string') {
    const bytes = utf8ByteLength(value);
    // The per-call ceiling is hard: a property's own maxBytes may tighten it, never raise it.
    const ceiling = rule.maxBytes === undefined ? limitBytes : Math.min(rule.maxBytes, limitBytes);
    if (bytes > ceiling) throw new SafeError(ERROR_CODES.TOOL_ERROR);
    if (rule.minBytes !== undefined && bytes < rule.minBytes) throw new SafeError(ERROR_CODES.TOOL_ERROR);
  }
  if (rule.type === 'integer') {
    if (rule.minimum !== undefined && value < rule.minimum) throw new SafeError(ERROR_CODES.TOOL_ERROR);
    if (rule.maximum !== undefined && value > rule.maximum) throw new SafeError(ERROR_CODES.TOOL_ERROR);
  }
  if (rule.type === 'array') {
    if (rule.maxItems !== undefined && value.length > rule.maxItems) throw new SafeError(ERROR_CODES.TOOL_ERROR);
    return Object.freeze(value.map(entry => checkValue(rule.items, entry, limitBytes)));
  }
  if (rule.type === 'object') {
    if (Object.keys(value).some(key => !Object.hasOwn(rule.properties, key))) throw new SafeError(ERROR_CODES.TOOL_ERROR);
    const normalized = {};
    for (const [name, child] of Object.entries(rule.properties)) {
      const required = (rule.required ?? []).includes(name);
      if (!Object.hasOwn(value, name)) {
        if (required) throw new SafeError(ERROR_CODES.TOOL_ERROR);
        continue;
      }
      normalized[name] = checkValue(child, value[name], limitBytes);
    }
    return Object.freeze(normalized);
  }
  return value;
}
export function validateArguments(schema, args, limitBytes = AGENT_CEILINGS.argumentsBytes) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new SafeError(ERROR_CODES.TOOL_ERROR);
  return checkValue(schema, args, limitBytes);
}
