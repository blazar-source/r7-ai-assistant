// src/agent/context.js
import { ERROR_CODES, SafeError } from '../shared/errors.js';
import { AGENT_CEILINGS } from '../shared/limits.js';
import { utf8ByteLength } from '../shared/bytes.js';

export const CONTEXT_DROP_MARKER = 'earlier tool results were dropped from context; re-read what you still need';

// Conservative per-message accounting (role, JSON framing). Content bytes are what §12.1 bounds,
// so the extra constant can only keep the real request smaller than the ceiling, never larger.
const MESSAGE_ACCOUNT_BYTES = 16;

// A tool result is recognised by the protocol's own envelope discriminator, not by identity.
function isToolResult(message) {
  return message.content.includes('"type":"tool_results"');
}

function sizeOf(message) {
  return utf8ByteLength(message.content) + MESSAGE_ACCOUNT_BYTES;
}

// The longest prefix of text whose UTF-8 encoding fits budgetBytes (binary search: slicing by code
// unit never over-counts). A cut between a high and a low surrogate is stepped back by one so the
// returned prefix is always well formed — JSON.stringify would otherwise emit a 6-byte \ud83d escape.
function prefixWithin(text, budgetBytes) {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8ByteLength(text.slice(0, middle)) <= budgetBytes) low = middle;
    else high = middle - 1;
  }
  if (low > 0 && low < text.length) {
    const last = text.charCodeAt(low - 1);
    const next = text.charCodeAt(low);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) low -= 1;
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
//
// "Newest" is a POSITION (the last element), never an object identity: truncation replaces the last
// element with a new object, so an identity guard would stop protecting it, the emptied husk would
// be evicted next, and the loop would break over budget with the newest message silently dropped.
export function createContextWindow({ ceilingBytes = AGENT_CEILINGS.activeContextBytes, dropMarker = CONTEXT_DROP_MARKER } = {}) {
  if (!Number.isSafeInteger(ceilingBytes) || ceilingBytes < 1) throw new SafeError(ERROR_CODES.INVALID_DATA);
  if (typeof dropMarker !== 'string' || dropMarker.length === 0) throw new SafeError(ERROR_CODES.INVALID_DATA);
  let messages = [];
  const markerMessage = Object.freeze({ role: 'user', content: dropMarker });
  const markerBytes = sizeOf(markerMessage);
  let dropped = 0;
  let marker = false;
  function arrayTotal(array) {
    return array.reduce((sum, message) => sum + sizeOf(message), 0);
  }
  // The public read reports the PUBLISHED window, never the private copy an in-flight append is
  // working on.
  function publishedTotal() {
    return arrayTotal(messages);
  }
  // 1) oldest tool-result message, 2) the oldest remaining message after the pinned prefix. Never
  // the pins, never the drop marker, never the newest message, and it reports 0 instead of forcing
  // an eviction that cannot happen.
  //
  // §12.3 also names "oldest complete assistant/tool-result pairs". That form is deliberately NOT
  // implemented here and the single-message form is used instead: the pair branch is unreachable
  // while the tool-result scan (1) runs first, because a tool result that is not the newest message
  // is always found and removed by (1) before any pair is considered, and a tool result that IS the
  // newest message is never evicted at all. The pair branch was therefore removed rather than left
  // as untestable dead code — see the Task 6 fix-round report for the reachability argument.
  function evict(array) {
    if (array.length <= 2) return 0;
    const newest = array.length - 1;
    // The marker guard is applied to the tool-result scan: a caller-supplied dropMarker whose text
    // contains the tool-results discriminator must not be chosen as the message to drop either.
    const toolIndex = array.findIndex((message, index) => index > 1 && index < newest &&
      message.content !== dropMarker && isToolResult(message));
    if (toolIndex !== -1) {
      array.splice(toolIndex, 1);
      return 1;
    }
    // The drop marker is a bookkeeping note, never eviction material: when it is the only candidate
    // nothing is evictable and the newest message has to be shortened instead.
    const index = array.findIndex((message, position) => position > 1 && position < newest &&
      message.content !== dropMarker);
    if (index === -1) return 0;
    array.splice(index, 1);
    return 1;
  }
  // Reduce the LAST element (the newest message) until it fits what is left after the others. The
  // remaining budget is recomputed from the CURRENT last element, never from a stale size taken
  // before an eviction, and truncation is reduction, never removal.
  //
  // The pinned prefix is protected by construction, not by a special case: position 1 (the original
  // user request) is only ever the LAST element while the window holds exactly the pins, and then
  // shortening it is precisely "fit the request into a ceiling that can hold it". Once anything
  // follows it, the last element is some later message, `evict` never scans index <= 1, and no code
  // path reaches position 0 at all — so an append that cannot fit is refused (AGENT_LIMIT) instead of
  // the request being shortened.
  function truncateNewest(array) {
    const newest = array.length - 1;
    const last = array[newest];
    const rest = arrayTotal(array) - sizeOf(last);
    const cutBudget = Math.max(0, ceilingBytes - rest - MESSAGE_ACCOUNT_BYTES);
    const content = prefixWithin(last.content, cutBudget);
    if (content.length === last.content.length) return false;
    array[newest] = Object.freeze({ role: last.role, content });
    dropped += 1;
    return true;
  }
  function append(message) {
    assertMessage(message);
    const frozen = Object.freeze({ role: message.role, content: message.content });
    // Every change lands in a private copy; the published window is replaced only once the ceiling is
    // known to hold. A refused append (AGENT_LIMIT) therefore publishes nothing — never an
    // over-budget husk — and the marker flag is recomputed from the published window each time.
    const working = [...messages, frozen];
    marker = messages.some(candidate => candidate.content === dropMarker);
    // Phase 1 — evict first, until nothing older is evictable. Truncation is never allowed while an
    // evictable message remains, so an older message always pays before the newest one is cut. Every
    // round removes a message, so this always terminates.
    let evicted = 0;
    while (arrayTotal(working) > ceilingBytes) {
      const count = evict(working);
      if (count === 0) break;
      evicted += count;
    }
    // Phase 2 — the marker, placed only into room that already exists. The window without the newest
    // message must still fit with the marker added; the newest message is then fitted into whatever
    // remains. The marker is never allowed to shrink the newest message — it is a bookkeeping note,
    // and the message the caller is waiting to send keeps its bytes.
    if (evicted > 0 && !marker && working.length > 2) {
      const withoutNewest = arrayTotal(working) - sizeOf(working[working.length - 1]);
      if (withoutNewest + markerBytes <= ceilingBytes) {
        working.splice(2, 0, markerMessage);
        marker = true;
      }
    }
    // Phase 3 — truncate last. Reduce the newest message into what is left. If it cannot be shortened
    // any further the ceiling cannot hold even one message and its framing: an impossible budget is
    // refused, never silently violated.
    if (arrayTotal(working) > ceilingBytes) {
      if (!truncateNewest(working)) throw new SafeError(ERROR_CODES.AGENT_LIMIT);
      if (arrayTotal(working) > ceilingBytes) throw new SafeError(ERROR_CODES.AGENT_LIMIT);
    }
    dropped += evicted;
    messages = working;
    return messages.length;
  }
  return Object.freeze({
    append,
    messages: () => Object.freeze([...messages]),
    dropped: () => dropped,
    totalBytes: publishedTotal
  });
}
