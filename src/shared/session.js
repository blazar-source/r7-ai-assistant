import { LIMITS, AGENT_CEILINGS } from './limits.js';
import { ERROR_CODES, SafeError } from './errors.js';
import { assertByteLimit, utf8ByteLength } from './bytes.js';

function invalid() { throw new SafeError(ERROR_CODES.INVALID_DATA); }
export function validateUUID(uuid) {
  if (typeof uuid !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid)) invalid();
  return uuid;
}
export function secureUUID(crypto = globalThis.crypto) {
  if (typeof crypto?.randomUUID === 'function') return validateUUID(crypto.randomUUID());
  if (typeof crypto?.getRandomValues !== 'function') throw new SafeError(ERROR_CODES.CAPABILITY_UNAVAILABLE);
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function message(raw, role, maximum) {
  if (!raw || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (Reflect.ownKeys(descriptors).length !== 2 || !Object.hasOwn(descriptors, 'role') || !Object.hasOwn(descriptors, 'content')) invalid();
  for (const descriptor of Object.values(descriptors)) if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
  if (raw.role !== role) invalid();
  assertByteLimit(raw.content, maximum);
  return Object.freeze({ role, content: raw.content });
}
function pairs(history) {
  if (!Array.isArray(history) || history.length % 2 !== 0) invalid();
  const historyPairs = [];
  for (let i = 0; i < history.length; i += 2) {
    historyPairs.push(message(history[i], 'user', LIMITS.userInputBytes));
    historyPairs.push(message(history[i + 1], 'assistant', LIMITS.modelContentBytes));
  }
  return historyPairs;
}
// Budgets count UTF-8 message content; the independently capped body includes JSON overhead/escaping.
function contentBytes(messages) { return messages.reduce((sum, entry) => sum + utf8ByteLength(entry.content), 0); }
export function snapshotRequestMessages(messages) {
  if (!Array.isArray(messages) || messages.length < 2) invalid();
  if (messages.length > LIMITS.sentHistoryMessages) throw new SafeError(ERROR_CODES.BYTE_LIMIT);
  const system = message(messages[0], 'system', LIMITS.sentHistoryBytes);
  const current = message(messages.at(-1), 'user', LIMITS.userInputBytes);
  // An odd inventory has ONE separate, bounded, explicitly untrusted selection
  // message immediately before current user. Never promote document text to system.
  const hasContext = messages.length % 2 === 1;
  const context = hasContext ? [message(messages.at(-2), 'user', LIMITS.selectionBytes)] : [];
  const result = [system, ...pairs(messages.slice(1, hasContext ? -2 : -1)), ...context, current];
  if (contentBytes(result) > LIMITS.sentHistoryBytes) throw new SafeError(ERROR_CODES.BYTE_LIMIT);
  return Object.freeze(result);
}
// One message of an agent conversation declares its own role, so the strict helper still owns every
// shape check: a second `system` message or an unknown role is refused by the helper's own role
// comparison, never by a check written here. A shape failure is retried under the other legal role;
// any classified failure other than that mismatch (a byte limit, for instance) is reported as itself.
function agentMessage(raw, maximum) {
  for (const role of ['user', 'assistant']) {
    try { return message(raw, role, maximum); }
    catch (error) {
      if (!(error instanceof SafeError) || error.code !== ERROR_CODES.INVALID_DATA) throw error;
    }
  }
  return invalid();
}
// The agent loop owns its conversation, so its snapshot is not the chat snapshot. There is
// deliberately NO alternation requirement: the context window preserves the runtime-authored order,
// pair eviction keeps the conversation coherent, and the drop marker is a deliberate adjacent `user`
// note telling the model it may re-read. An evicted tool result can likewise leave two adjacent
// assistant envelopes, and neither shape is one the model cannot answer.
//
// There is deliberately no message-count cap of its own: the window's content+per-message accounting
// and createRequest's existing requestBytes budget already bind the request, and §12.2 requires far
// larger maxSteps to work without a runtime change.
export function snapshotAgentMessages(messages) {
  if (!Array.isArray(messages) || messages.length < 2) invalid();
  const maximum = AGENT_CEILINGS.activeContextBytes;
  // Position 1 is the pinned ORIGINAL user request, and it is the user's own input: it keeps the
  // LIMITS.userInputBytes bound the Sprint 1 chat path applies to the same data, so the wider agent
  // ceiling cannot quietly turn a bounded input into a 64 KiB one. Every later message is
  // runtime-authored (tool results, envelopes, repair notes) and keeps the active-context bound.
  const result = [message(messages[0], 'system', maximum),
    message(messages[1], 'user', LIMITS.userInputBytes),
    ...messages.slice(2).map(raw => agentMessage(raw, maximum))];
  if (contentBytes(result) > maximum) throw new SafeError(ERROR_CODES.BYTE_LIMIT);
  return Object.freeze(result);
}
export function buildContextMessages(system, current, selection, history = []) {
  const head = message({ role: 'system', content: system }, 'system', LIMITS.sentHistoryBytes);
  const context = message({ role: 'user', content: selection }, 'user', LIMITS.selectionBytes);
  const user = message({ role: 'user', content: current }, 'user', LIMITS.userInputBytes);
  const mandatoryBytes = contentBytes([head, context, user]);
  if (mandatoryBytes > LIMITS.sentHistoryBytes) throw new SafeError(ERROR_CODES.BYTE_LIMIT);
  const previous = pairs(history);
  let start = 0;
  let bytes = mandatoryBytes + contentBytes(previous);
  while (previous.length - start + 3 > LIMITS.sentHistoryMessages || bytes > LIMITS.sentHistoryBytes) {
    bytes -= utf8ByteLength(previous[start].content) + utf8ByteLength(previous[start + 1].content);
    start += 2;
  }
  return Object.freeze([head, ...previous.slice(start), context, user]);
}
export function buildMessages(system, current, history = []) {
  const mandatory = [message({ role: 'system', content: system }, 'system', LIMITS.sentHistoryBytes), message({ role: 'user', content: current }, 'user', LIMITS.userInputBytes)];
  const mandatoryBytes = contentBytes(mandatory);
  if (mandatoryBytes > LIMITS.sentHistoryBytes) throw new SafeError(ERROR_CODES.BYTE_LIMIT);
  const previous = pairs(history);
  let start = 0;
  let bytes = mandatoryBytes + contentBytes(previous);
  while (previous.length - start + 2 > LIMITS.sentHistoryMessages || bytes > LIMITS.sentHistoryBytes) {
    bytes -= utf8ByteLength(previous[start].content) + utf8ByteLength(previous[start + 1].content);
    start += 2;
  }
  return Object.freeze([mandatory[0], ...previous.slice(start), mandatory[1]]);
}
export function boundDisplayHistory(history) {
  const entries = pairs(history);
  let bytes = contentBytes(entries);
  let start = 0;
  while (entries.length - start > LIMITS.displayedHistoryEntries || bytes > LIMITS.displayedHistoryBytes) {
    bytes -= utf8ByteLength(entries[start].content) + utf8ByteLength(entries[start + 1].content);
    start += 2;
  }
  return Object.freeze(entries.slice(start));
}
export function createChatSession(crypto = globalThis.crypto) {
  return Object.freeze({ uuid: secureUUID(crypto), history: Object.freeze([]) });
}
export function appendChatPair(session, user, assistant) {
  validateUUID(session.uuid);
  const history = boundDisplayHistory([...session.history, { role: 'user', content: user }, { role: 'assistant', content: assistant }]);
  return Object.freeze({ uuid: session.uuid, history });
}
export function newChat(crypto = globalThis.crypto) { return createChatSession(crypto); }
export function createConnectionSession(crypto = globalThis.crypto) { return createChatSession(crypto); }
