import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, AGENT_CEILINGS, AGENT_GUARDRAILS, createGuardrails } from '../../src/shared/limits.js';

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

// The panel's named pilot configuration. It is a CONFIGURATION set, not a new default: the defaults
// asserted above are untouched and every other caller keeps them.
test('the named panel guardrail set is frozen, validated, and leaves the defaults untouched', () => {
  assert.ok(Object.isFrozen(AGENT_GUARDRAILS));
  assert.deepEqual({ ...AGENT_GUARDRAILS }, { maxSteps: 120, maxToolCalls: 400, operationDeadlineMs: 1800000 });
  // Built THROUGH createGuardrails, so the exported set is one the contract validated rather than a
  // hand-written literal that could drift from it.
  assert.deepEqual({ ...AGENT_GUARDRAILS },
    { ...createGuardrails({ maxSteps: 120, maxToolCalls: 400, operationDeadlineMs: 1800000 }) });
  // Every value is above the default it replaces, so the set can only widen a pilot run.
  assert.ok(AGENT_GUARDRAILS.maxSteps > createGuardrails().maxSteps);
  assert.ok(AGENT_GUARDRAILS.maxToolCalls > createGuardrails().maxToolCalls);
  assert.ok(AGENT_GUARDRAILS.operationDeadlineMs > createGuardrails().operationDeadlineMs);
  // The measured-run shape: five executed actions burned the 12-step default. The named set must cover
  // dozens of actions and several minutes without approaching the hard ceilings, which are per payload
  // and never a lifetime task total.
  assert.ok(AGENT_GUARDRAILS.maxSteps >= 100, '~40-55 pilot actions at the measured ~2.4 steps each');
  assert.ok(AGENT_GUARDRAILS.maxToolCalls >= 200, 'far above the ~40-55 actions a ten-page task needs');
  assert.ok(AGENT_GUARDRAILS.operationDeadlineMs >= 600000, 'several minutes, not one HTTP budget');
  assert.ok(AGENT_GUARDRAILS.operationDeadlineMs < 3600000, 'a bounded one-task window, not a lifetime');
  assert.equal(AGENT_CEILINGS.actionsPerStep, 8, 'the hard per-step ceiling is untouched');
});

test('createGuardrails defaults are the unchanged 12 / 32 / 150000 the CLI profile asserts', () => {
  assert.deepEqual({ ...createGuardrails() }, { maxSteps: 12, maxToolCalls: 32, operationDeadlineMs: 150000 });
  assert.deepEqual({ ...createGuardrails({}) }, { maxSteps: 12, maxToolCalls: 32, operationDeadlineMs: LIMITS.operationTimeoutMs });
});
