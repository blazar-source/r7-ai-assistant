import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_CODES, SafeError } from '../../src/shared/errors.js';

test('agent error classes exist as closed content-free codes', () => {
  assert.equal(ERROR_CODES.TOOL_ERROR, 'TOOL_ERROR');
  assert.equal(ERROR_CODES.TOOL_UNCERTAIN, 'TOOL_UNCERTAIN');
  assert.equal(ERROR_CODES.AGENT_LIMIT, 'AGENT_LIMIT');
});

test('SafeError carries the new codes verbatim and falls back on unknown ones', () => {
  assert.equal(new SafeError(ERROR_CODES.TOOL_UNCERTAIN).code, 'TOOL_UNCERTAIN');
  assert.equal(new SafeError('NOT_A_CODE').code, 'INTERNAL_ERROR');
  assert.equal(new SafeError(ERROR_CODES.AGENT_LIMIT).message, 'AGENT_LIMIT');
});
