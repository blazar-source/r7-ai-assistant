// Accepted Stage B resource contract. Bytes are UTF-8, not UTF-16 length.
import { ERROR_CODES, SafeError } from './errors.js';
export const LIMITS = Object.freeze({
  endpointBytes: 2048,
  modelBytes: 128,
  apiKeyBytes: 4096,
  userInputBytes: 8192,
  selectionBytes: 8192,
  replacementBytes: 8192,
  modelContentBytes: 65536,
  jsonBytes: 65536,
  editorResultBytes: 65536,
  requestBytes: 98304,
  httpEnvelopeBytes: 131072,
  sentHistoryMessages: 32,
  sentHistoryBytes: 65536,
  displayedHistoryEntries: 64,
  displayedHistoryBytes: 131072,
  callbackTimeoutMs: 5000,
  operationTimeoutMs: 150000,
  previewTtlMs: 120000,
  applyObservationMs: 15000,
  httpTimeoutMinSeconds: 5,
  httpTimeoutMaxSeconds: 120,
  maxTokensMin: 64,
  maxTokensMax: 8192,
  temperatureMin: 0,
  temperatureMax: 2
});

// Hard safety ceilings: per payload / per result / per request / per active context window.
// Never a lifetime limit for a user task, and never lowered to make a scenario fit.
export const AGENT_CEILINGS = Object.freeze({
  activeContextBytes: 65536,
  toolResultBytes: 16384,
  argumentsBytes: 8192,
  resultDataBytes: 65536,
  contextReadBytes: Object.freeze({ selection: 8192, paragraph: 16384, section: 16384, structure: 16384 }),
  actionsPerStep: 8,
  protocolRepair: 1
});

// Runtime task guardrails. These are engineering defaults calibrated on the pilot
// workloads; raising them must never require a runtime change.
const guardrailKeys = ['maxSteps', 'maxToolCalls', 'operationDeadlineMs'];
export function createGuardrails(overrides = {}) {
  for (const key of Object.keys(overrides)) if (!guardrailKeys.includes(key)) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const value = { maxSteps: 12, maxToolCalls: 32, operationDeadlineMs: LIMITS.operationTimeoutMs, ...overrides };
  for (const key of guardrailKeys) {
    if (!Number.isInteger(value[key]) || value[key] < 1) throw new SafeError(ERROR_CODES.INVALID_DATA);
  }
  return Object.freeze(value);
}
