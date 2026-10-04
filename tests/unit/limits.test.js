import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, AGENT_CEILINGS, createGuardrails } from '../../src/shared/limits.js';

test('existing Sprint 1 limits keep their exact values', () => {
  assert.equal(LIMITS.previewTtlMs, 120000);
  assert.equal(LIMITS.operationTimeoutMs, 150000);
  assert.equal(LIMITS.requestBytes, 98304);
});

test('hard ceilings are frozen and cover every bounded payload', () => {
  assert.ok(Object.isFrozen(AGENT_CEILINGS));
  assert.equal(AGENT_CEILINGS.activeContextBytes, 65536);
  assert.equal(AGENT_CEILINGS.toolResultBytes, 16384);
  assert.equal(AGENT_CEILINGS.argumentsBytes, 8192);
  assert.equal(AGENT_CEILINGS.actionsPerStep, 8);
  assert.equal(AGENT_CEILINGS.protocolRepair, 1);
  assert.equal(AGENT_CEILINGS.contextReadBytes.selection, 8192);
});

test('guardrails default to the initial engineering values and accept overrides', () => {
  const base = createGuardrails();
  assert.deepEqual({ ...base }, { maxSteps: 12, maxToolCalls: 32, operationDeadlineMs: 150000 });
  assert.ok(Object.isFrozen(base));
  const raised = createGuardrails({ maxSteps: 60, maxToolCalls: 400, operationDeadlineMs: 1800000 });
  assert.deepEqual({ ...raised }, { maxSteps: 60, maxToolCalls: 400, operationDeadlineMs: 1800000 });
});

test('guardrails reject nonsense instead of silently clamping', () => {
  assert.throws(() => createGuardrails({ maxSteps: 0 }), /INVALID_DATA/);
  assert.throws(() => createGuardrails({ maxToolCalls: -1 }), /INVALID_DATA/);
  assert.throws(() => createGuardrails({ operationDeadlineMs: 1.5 }), /INVALID_DATA/);
  assert.throws(() => createGuardrails({ unknown: 1 }), /INVALID_DATA/);
});
