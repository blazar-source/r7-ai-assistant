// src/agent/context.js
import { ERROR_CODES, SafeError } from '../shared/errors.js';
import { AGENT_CEILINGS } from '../shared/limits.js';
import { utf8ByteLength } from '../shared/bytes.js';

export const CONTEXT_DROP_MARKER = 'earlier tool results were dropped from context; re-read what you still need';

// Conservative per-message accounting (role, JSON framing). Content bytes are what §12.1 bounds,
// so the extra constant can only keep the real request smaller than the ceiling, never larger.
const MESSAGE_ACCOUNT_BYTES = 16;

function sizeOf(message) {
  return utf8ByteLength(message.content) + MESSAGE_ACCOUNT_BYTES;
}

// The longest prefix of text whose UTF-8 encoding fits budgetBytes (binary search: slicing by code
// unit never over-counts, and splitting a surrogate pair is not a prefix the search can return).
function prefixWithin(text, budgetBytes) {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8ByteLength(text.slice(0, middle)) <= budgetBytes) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low);
}

function assertMessage(message) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (typeof message.role !== 'string' || message.role.length === 0) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (typeof message.content !== 'string') throw new SafeError(ERROR_CODES.INVALID_DATA);
}

// Bounded window of the conversation actually sent to the model.
// Invariant, re-established by EVERY append: the accounted size of messages() is <= ceilingBytes.
// The system message and the original user request are pinned; the drop marker is inserted at most
// once; the newest message is never dropped silently — when it alone cannot fit, it is truncated.
export function createContextWindow({ ceilingBytes = AGENT_CEILINGS.activeContextBytes, dropMarker = CONTEXT_DROP_MARKER } = {}) {
  if (!Number.isSafeInteger(ceilingBytes) || ceilingBytes < 1) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (typeof dropMarker !== 'string' || dropMarker.length === 0) throw new SafeError(ERROR_CODES.INVALID_DATA);
  const messages = [];
  let dropped = 0;
  let marker = false;
  function total() {
    return messages.reduce((sum, message) => sum + sizeOf(message), 0);
  }
  // 1) oldest tool-result message, 2) oldest message after the pinned prefix. Never the pins,
  // never the marker, never the newest message being fitted, and it reports false instead of
  // forcing an eviction that cannot happen.
  function evict(target) {
    if (messages.length <= 2) return false;
    const toolIndex = messages.findIndex((message, index) => index > 1 && message !== target &&
      message.content.includes('"type":"tool_results"'));
    if (toolIndex !== -1) {
      messages.splice(toolIndex, 1);
      dropped += 1;
      return true;
    }
    const index = messages.findIndex((message, position) => position > 1 && message !== target && message.content !== dropMarker);
    if (index === -1) return false;
    messages.splice(index, 1);
    dropped += 1;
    return true;
  }
  // Reduce target (the newest message) until it fits what is left after the other messages, which
  // the pins and the optional marker already account for. Truncation is reduction, never removal.
  function truncateTarget(target) {
    const rest = total() - sizeOf(target);
    const cutBudget = Math.max(0, ceilingBytes - rest - MESSAGE_ACCOUNT_BYTES);
    const content = prefixWithin(target.content, cutBudget);
    const index = messages.indexOf(target);
    if (index === -1 || content.length === target.content.length) return false;
    messages[index] = Object.freeze({ role: target.role, content });
    dropped += 1;
    return true;
  }
  function append(message) {
    assertMessage(message);
    const target = Object.freeze({ role: message.role, content: message.content });
    messages.push(target);
    let evicted = false;
    while (total() > ceilingBytes) {
      if (evict(target)) evicted = true;
      if (!marker && evicted && messages.length >= 3) {
        messages.splice(2, 0, Object.freeze({ role: 'user', content: dropMarker }));
        marker = true;
      }
      if (total() <= ceilingBytes) break;
      if (!truncateTarget(target)) break;
    }
    return messages.length;
  }
  return Object.freeze({
    append,
    messages: () => Object.freeze([...messages]),
    dropped: () => dropped,
    totalBytes: total
  });
}
