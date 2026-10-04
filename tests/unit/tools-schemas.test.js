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
