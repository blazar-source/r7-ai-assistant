import { validateRequestSettings } from '../config/settings.js';
import { LIMITS } from '../shared/limits.js';
import { ERROR_CODES, SafeError } from '../shared/errors.js';
import { assertByteLimit, utf8ByteLength } from '../shared/bytes.js';
import { validateUUID, snapshotRequestMessages } from '../shared/session.js';

function jsonStringBytes(text) {
  let bytes = 2;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit === 34 || unit === 92 || [8, 9, 10, 12, 13].includes(unit)) bytes += 2;
    else if (unit < 32) bytes += 6;
    else if (unit < 128) bytes += 1;
    else if (unit < 2048) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i += 1; }
    else if (unit >= 0xd800 && unit <= 0xdfff) bytes += 6;
    else bytes += 3;
  }
  return bytes;
}
export function createRequest(settings, messages, uuid) {
  const effective = validateRequestSettings(settings);
  validateUUID(uuid);
  const snapshot = snapshotRequestMessages(messages);
  // Empty-content serialization accounts for keys, punctuation and numeric settings.
  const skeleton = JSON.stringify({ model: effective.model, messages: snapshot.map(entry => ({ role: entry.role, content: '' })), max_tokens: effective.maxTokens, temperature: effective.temperature });
  let bytes = utf8ByteLength(skeleton);
  for (const entry of snapshot) bytes += jsonStringBytes(entry.content) - 2;
  if (bytes > LIMITS.requestBytes) throw new SafeError(ERROR_CODES.BYTE_LIMIT);
  const body = JSON.stringify({ model: effective.model, messages: snapshot, max_tokens: effective.maxTokens, temperature: effective.temperature });
  assertByteLimit(body, LIMITS.requestBytes);
  return Object.freeze({ endpoint: effective.endpoint, settings: effective, messages: snapshot,
    headers: Object.freeze({ Authorization: `Bearer ${effective.apiKey}`, 'Content-Type': 'application/json', 'X-Session-ID': uuid }), body });
}
function closed(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function protocolError() { throw new SafeError(ERROR_CODES.PROTOCOL_ERROR); }
export function parseModelContent(content, mode) {
  if (mode !== 'ASK' && mode !== 'EDIT') throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (typeof content !== 'string') protocolError();
  assertByteLimit(content, LIMITS.modelContentBytes);
  let text = content.trim();
  if (text.startsWith('```')) {
    const fence = /^```json\r?\n([\s\S]*)\r?\n```$/.exec(text);
    if (!fence) protocolError();
    text = fence[1];
  }
  let value;
  try { value = JSON.parse(text); } catch { protocolError(); }
  if (closed(value, ['type', 'message']) && value.type === 'final' && typeof value.message === 'string') {
    assertByteLimit(value.message, LIMITS.modelContentBytes);
    if ('{"type":"final","message":""}'.length + jsonStringBytes(value.message) - 2 > LIMITS.jsonBytes) throw new SafeError(ERROR_CODES.BYTE_LIMIT);
    return Object.freeze({ type: 'final', message: value.message });
  }
  if (mode === 'EDIT' && closed(value, ['type', 'tool', 'arguments']) && value.type === 'tool' &&
      value.tool === 'r7_replace_selection' && closed(value.arguments, ['text']) && typeof value.arguments.text === 'string') {
    assertByteLimit(value.arguments.text, LIMITS.replacementBytes);
    assertByteLimit(JSON.stringify(value), LIMITS.jsonBytes);
    return Object.freeze({ type: 'tool', tool: 'r7_replace_selection', arguments: Object.freeze({ text: value.arguments.text }) });
  }
  protocolError();
}
