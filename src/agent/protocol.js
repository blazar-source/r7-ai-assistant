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
  // §6.2: a confirm action must travel alone. This is a KNOWN tool error (the model can split the step
  // and retry immediately), never a protocol error — a protocol error would burn the run's only repair.
  if (resolved.some(entry => entry.descriptor.policy === 'confirm') && resolved.length > 1) {
    throw new SafeError(ERROR_CODES.TOOL_ERROR);
  }
  return Object.freeze(resolved);
}
// §12.1 bounds ONE result by its OWN serialization (`{ tool, ...result }`). The message envelope that
// carries it is not part of the entry, so its fixed overhead must never be charged against the entry's
// ceiling: an entry in the top 36 bytes of the limit (16348..16384) is legal and was refused before.
const TOOL_RESULTS_PREFIX = '{"type":"tool_results","results":[';
const TOOL_RESULTS_SUFFIX = ']}';
// The empty serialized envelope plus one byte for the comma between entries. The sanity bound adds
// this per entry, so a message can never refuse a batch whose every entry already passed its own bound.
const TOOL_RESULTS_ENVELOPE_BYTES = utf8ByteLength(JSON.stringify({ type: 'tool_results', results: [] })) + 1;
function toolResultsMessageBudget(count) {
  return (AGENT_CEILINGS.toolResultBytes + TOOL_RESULTS_ENVELOPE_BYTES) * Math.max(1, count);
}
// The mapping and the serialization of tool results are the last place model-adjacent data is touched
// before it becomes a message: a non-array, a null entry, a BigInt, a cycle or a throwing getter must
// all land on the closed error contract and escape as TOOL_ERROR, never as a raw exception.
function stringifyToolResults(results) {
  if (!Array.isArray(results)) throw new SafeError(ERROR_CODES.TOOL_ERROR);
  const payloads = results.map(entry => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new SafeError(ERROR_CODES.TOOL_ERROR);
    // Read every own property once, here: a value that cannot be serialized (BigInt, cycle, throwing
    // getter) is then refused by the bound check instead of exploding inside the aggregate stringify.
    const value = { tool: entry.tool, ...entry.result };
    let serialized;
    try { serialized = JSON.stringify(value); } catch { throw new SafeError(ERROR_CODES.TOOL_ERROR); }
    if (typeof serialized !== 'string') throw new SafeError(ERROR_CODES.TOOL_ERROR);
    // The ENTRY's own bytes, never the envelope's: per result first, so the reported code names the
    // real breach instead of the message total by accident.
    if (utf8ByteLength(serialized) > AGENT_CEILINGS.toolResultBytes) throw new SafeError(ERROR_CODES.TOOL_ERROR);
    return serialized;
  });
  // Assembled from the strings that were measured, so the published bytes are exactly the bounded ones.
  const payload = `${TOOL_RESULTS_PREFIX}${payloads.join(',')}${TOOL_RESULTS_SUFFIX}`;
  // A SANITY bound on the whole message only: it carries the envelope's own bytes as slack and can
  // therefore never refuse an entry that passed its own bound, while still capping the aggregate.
  if (utf8ByteLength(payload) > toolResultsMessageBudget(results.length)) throw new SafeError(ERROR_CODES.TOOL_ERROR);
  return payload;
}
export function toolResultMessages(results) {
  if (!Array.isArray(results)) throw new SafeError(ERROR_CODES.TOOL_ERROR);
  // ONE message per result. A single batch-sized message was bounded only by
  // toolResultBytes * results.length (up to ~128 KiB) — larger than the 64 KiB active-context window,
  // which evicts whole messages only, so a large read batch degraded into a truncation or a BYTE_LIMIT
  // before send. One entry per message keeps every message inside the per-result ceiling and lets the
  // window evict an individual tool result: its scan matches the "type":"tool_results" substring, which
  // each message still carries.
  return Object.freeze(results.map(entry => {
    let payload;
    try { payload = stringifyToolResults([entry]); } catch (error) {
      if (error instanceof SafeError) throw error;
      throw new SafeError(ERROR_CODES.TOOL_ERROR);
    }
    return Object.freeze({ role: 'user', content: payload });
  }));
}
export function repairMessage(error) {
  const code = error instanceof SafeError ? error.code : ERROR_CODES.PROTOCOL_ERROR;
  return `Ответ не соответствует протоколу (${code}). Верни ровно один JSON-объект: либо {"type":"tool_calls","calls":[…]} в пределах лимитов, либо {"type":"final","message":"…"}.`;
}
