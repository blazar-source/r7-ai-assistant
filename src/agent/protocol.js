// src/agent/protocol.js
import { ERROR_CODES, SafeError } from '../shared/errors.js';
import { AGENT_CEILINGS } from '../shared/limits.js';
import { assertByteLimit, utf8ByteLength } from '../shared/bytes.js';
import { validateArguments } from '../tools/schemas.js';

const envelopeKeys = { final: ['type', 'message'], batch: ['type', 'calls'] };
function closed(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
export function parseEnvelope(content) {
  if (typeof content !== 'string') throw new SafeError(ERROR_CODES.PROTOCOL_ERROR);
  assertByteLimit(content, AGENT_CEILINGS.resultDataBytes);
  let text = content.trim();
  if (text.startsWith('```')) {
    const fence = /^```json\r?\n([\s\S]*)\r?\n```$/.exec(text);
    if (!fence) throw new SafeError(ERROR_CODES.PROTOCOL_ERROR);
    text = fence[1];
  }
  let value;
  try { value = JSON.parse(text); } catch { throw new SafeError(ERROR_CODES.PROTOCOL_ERROR); }
  if (closed(value, envelopeKeys.final) && value.type === 'final' && typeof value.message === 'string') {
    assertByteLimit(value.message, AGENT_CEILINGS.resultDataBytes);
    return Object.freeze({ type: 'final', message: value.message });
  }
  if (closed(value, envelopeKeys.batch) && value.type === 'tool_calls' && Array.isArray(value.calls) &&
      value.calls.length >= 1 && value.calls.length <= AGENT_CEILINGS.actionsPerStep) {
    const calls = value.calls.map(call => {
      if (!closed(call, ['tool', 'arguments']) || typeof call.tool !== 'string') throw new SafeError(ERROR_CODES.PROTOCOL_ERROR);
      return Object.freeze({ tool: call.tool, arguments: call.arguments });
    });
    return Object.freeze({ type: 'tool_calls', calls: Object.freeze(calls) });
  }
  throw new SafeError(ERROR_CODES.PROTOCOL_ERROR);
}
// A per-string bound is not a per-action bound: one action can carry several strings, each under
// argumentsBytes, whose serialized payload together breaks the ceiling. Bound the payload itself.
function assertArgumentsBytes(value) {
  let payload;
  try { payload = JSON.stringify(value); } catch { throw new SafeError(ERROR_CODES.TOOL_ERROR); }
  if (typeof payload !== 'string' || utf8ByteLength(payload) > AGENT_CEILINGS.argumentsBytes) throw new SafeError(ERROR_CODES.TOOL_ERROR);
}
// Whole-batch validation happens before ANY execution, so a rejected batch never mutates the document.
export function validateBatch(catalogue, calls) {
  if (!Array.isArray(calls) || calls.length < 1 || calls.length > AGENT_CEILINGS.actionsPerStep) {
    throw new SafeError(ERROR_CODES.PROTOCOL_ERROR);
  }
  const resolved = calls.map(call => {
    if (call === null || typeof call !== 'object' || Array.isArray(call) || typeof call.tool !== 'string') {
      throw new SafeError(ERROR_CODES.TOOL_ERROR);
    }
    assertArgumentsBytes(call.arguments);
    const descriptor = catalogue.find(tool => tool.name === call.tool);
    if (!descriptor) throw new SafeError(ERROR_CODES.TOOL_ERROR);
    return Object.freeze({ descriptor, arguments: validateArguments(descriptor.schema, call.arguments, AGENT_CEILINGS.argumentsBytes) });
  });
  if (resolved.some(entry => entry.descriptor.policy === 'confirm') && resolved.length > 1) {
    throw new SafeError(ERROR_CODES.PROTOCOL_ERROR);
  }
  return Object.freeze(resolved);
}
export function toolResultMessages(results) {
  const payload = JSON.stringify({ type: 'tool_results', results: results.map(entry => ({ tool: entry.tool, ...entry.result })) });
  assertByteLimit(payload, AGENT_CEILINGS.toolResultBytes * Math.max(1, results.length));
  return Object.freeze([Object.freeze({ role: 'user', content: payload })]);
}
export function repairMessage(error) {
  const code = error instanceof SafeError ? error.code : ERROR_CODES.PROTOCOL_ERROR;
  return `Ответ не соответствует протоколу (${code}). Верни ровно один JSON-объект: либо {"type":"tool_calls","calls":[…]} в пределах лимитов, либо {"type":"final","message":"…"}.`;
}
