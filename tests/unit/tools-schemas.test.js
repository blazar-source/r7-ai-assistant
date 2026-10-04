// tests/unit/tools-schemas.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateToolSchema, validateArguments } from '../../src/tools/schemas.js';

const schema = { type: 'object', additionalProperties: false, required: ['text', 'after'],
  properties: { text: { type: 'string', maxBytes: 8192 }, after: { type: 'integer', minimum: 0, maximum: 1000 } } };

test('accepts a valid closed schema and returns frozen arguments', () => {
  assert.equal(validateToolSchema(schema), true);
  const out = validateArguments(schema, { text: 'Привет', after: 2 }, 8192);
  assert.ok(Object.isFrozen(out));
  assert.deepEqual({ ...out }, { text: 'Привет', after: 2 });
});

test('rejects unknown schema keywords and open schemas', () => {
  assert.throws(() => validateToolSchema({ type: 'object', properties: {}, patternProperties: {} }), /INVALID_DATA/);
  assert.throws(() => validateToolSchema({ type: 'object', properties: {} }), /INVALID_DATA/);
  assert.throws(() => validateToolSchema({ type: 'object', additionalProperties: true, properties: {} }), /INVALID_DATA/);
});

test('rejects unknown, missing and wrong-typed arguments', () => {
  assert.throws(() => validateArguments(schema, { text: 'a', after: 1, extra: 1 }, 8192), /TOOL_ERROR/);
  assert.throws(() => validateArguments(schema, { text: 'a' }, 8192), /TOOL_ERROR/);
  assert.throws(() => validateArguments(schema, { text: 'a', after: 1.5 }, 8192), /TOOL_ERROR/);
  assert.throws(() => validateArguments(schema, { text: 5, after: 1 }, 8192), /TOOL_ERROR/);
  assert.throws(() => validateArguments(schema, { text: 'a', after: 2000 }, 8192), /TOOL_ERROR/);
});

test('enforces UTF-8 byte limits, not UTF-16 length', () => {
  assert.throws(() => validateArguments(schema, { text: 'ж'.repeat(3), after: 1 }, 4), /TOOL_ERROR/);
  assert.equal(validateArguments(schema, { text: 'ж', after: 1 }, 2).text, 'ж');
});

test('rejects unknown keywords on the root schema object', () => {
  assert.throws(() => validateToolSchema({ type: 'object', additionalProperties: false, properties: {}, description: 'x' }), /INVALID_DATA/);
  assert.throws(() => validateToolSchema({ type: 'object', additionalProperties: false, properties: {}, patternProperties: {} }), /INVALID_DATA/);
});

const arraySchema = { type: 'object', additionalProperties: false, required: ['tags'],
  properties: { tags: { type: 'array', items: { type: 'string' }, maxItems: 4 } } };

const objectArraySchema = { type: 'object', additionalProperties: false, required: ['items'],
  properties: { items: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { n: { type: 'integer' } } } } } };

test('freezes validated array values', () => {
  const out = validateArguments(arraySchema, { tags: ['a', 'b'] }, 8192);
  assert.ok(Object.isFrozen(out.tags));
});

test('returns a copy of a validated array, not the caller array', () => {
  const tags = ['a', 'b'];
  const out = validateArguments(arraySchema, { tags }, 8192);
  tags.push('c');
  assert.deepEqual(out.tags, ['a', 'b']);
});

test('freezes normalized object entries inside arrays', () => {
  const out = validateArguments(objectArraySchema, { items: [{ n: 1 }] }, 8192);
  assert.ok(Object.isFrozen(out.items[0]));
});

test('rejects item schemas that are not themselves closed and valid', () => {
  assert.throws(() => validateToolSchema({ type: 'object', additionalProperties: false,
    properties: { xs: { type: 'array', items: { type: 'object' } } } }), /INVALID_DATA/);
  assert.throws(() => validateToolSchema({ type: 'object', additionalProperties: false,
    properties: { xs: { type: 'array', items: { type: 'array' } } } }), /INVALID_DATA/);
  assert.throws(() => validateToolSchema({ type: 'object', additionalProperties: false,
    properties: { xs: { type: 'array', items: { type: 'array', items: { type: 'object' } } } } }), /INVALID_DATA/);
});

test('rejects unknown keywords nested inside an items schema', () => {
  assert.throws(() => validateToolSchema({ type: 'object', additionalProperties: false,
    properties: { xs: { type: 'array',
      items: { type: 'object', additionalProperties: false, properties: { n: { type: 'integer', bogus: 1 } } } } } }), /INVALID_DATA/);
  assert.throws(() => validateToolSchema({ type: 'object', additionalProperties: false,
    properties: { xs: { type: 'array', items: { type: 'array', items: { type: 'string', bogus: 1 } } } } }), /INVALID_DATA/);
});

const nestedItemsSchema = { type: 'object', additionalProperties: false, required: ['xs'],
  properties: { xs: { type: 'array', maxItems: 2, items: { type: 'object', additionalProperties: false,
    required: ['n'], properties: { n: { type: 'integer', minimum: 0 } } } } } };

test('validates array entries through a well-formed items object schema', () => {
  assert.equal(validateToolSchema(nestedItemsSchema), true);
  const out = validateArguments(nestedItemsSchema, { xs: [{ n: 1 }, { n: 2 }] }, 8192);
  assert.deepEqual({ ...out.xs[0] }, { n: 1 });
  assert.ok(Object.isFrozen(out.xs[0]));
  assert.throws(() => validateArguments(nestedItemsSchema, { xs: [{ n: 1, extra: 1 }] }, 8192), /TOOL_ERROR/);
  assert.throws(() => validateArguments(nestedItemsSchema, { xs: [{}] }, 8192), /TOOL_ERROR/);
  assert.throws(() => validateArguments(nestedItemsSchema, { xs: [{ n: -1 }] }, 8192), /TOOL_ERROR/);
  assert.throws(() => validateArguments(nestedItemsSchema, { xs: [{ n: 1 }, { n: 2 }, { n: 3 }] }, 8192), /TOOL_ERROR/);
});

test('rejects non-integer numeric keyword values', () => {
  assert.throws(() => validateToolSchema({ type: 'object', additionalProperties: false,
    properties: { text: { type: 'string', maxBytes: 'x' } } }), /INVALID_DATA/);
  assert.throws(() => validateToolSchema({ type: 'object', additionalProperties: false,
    properties: { n: { type: 'integer', minimum: 'x' } } }), /INVALID_DATA/);
  assert.throws(() => validateToolSchema({ type: 'object', additionalProperties: false,
    properties: { xs: { type: 'array', items: { type: 'string' }, maxItems: 1.5 } } }), /INVALID_DATA/);
  assert.throws(() => validateToolSchema({ type: 'object', additionalProperties: false,
    properties: { text: { type: 'string', maxBytes: -1 } } }), /INVALID_DATA/);
  assert.throws(() => validateToolSchema({ type: 'object', additionalProperties: false,
    properties: { n: { type: 'integer', maximum: Number.NaN } } }), /INVALID_DATA/);
  assert.throws(() => validateToolSchema({ type: 'object', additionalProperties: false,
    properties: { text: { type: 'string', minBytes: '1' } } }), /INVALID_DATA/);
  assert.throws(() => validateToolSchema({ type: 'object', additionalProperties: false,
    properties: { xs: { type: 'array', maxItems: 'x', items: { type: 'object', additionalProperties: false,
      properties: { n: { type: 'integer', maximum: 'x' } } } } } }), /INVALID_DATA/);
});

test('a tighter maxBytes still wins and a broken maxBytes can never be registered', () => {
  // Former fail-open: maxBytes:'x' made Math.min('x', 8192) NaN, so 20 000 bytes passed.
  assert.throws(() => validateToolSchema({ type: 'object', additionalProperties: false, required: ['text'],
    properties: { text: { type: 'string', maxBytes: 'x' } } }), /INVALID_DATA/);
  const tighter = { type: 'object', additionalProperties: false, required: ['text'],
    properties: { text: { type: 'string', maxBytes: 4 } } };
  assert.equal(validateToolSchema(tighter), true);
  assert.throws(() => validateArguments(tighter, { text: 'a'.repeat(20000) }, 8192), /TOOL_ERROR/);
  assert.throws(() => validateArguments(tighter, { text: 'aaaaa' }, 8192), /TOOL_ERROR/);
  assert.equal(validateArguments(tighter, { text: 'aaaa' }, 8192).text, 'aaaa');
});
