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
  // The whole-document HTML export the insert confirmation counts occurrences in (`GetFileHTML`).
  // It is deliberately larger than `editorResultBytes`, because it bounds a DOCUMENT read rather than
  // a scoped one: the 64 KiB window that bounds a selection or paragraph read would refuse the export
  // of any non-trivial document and leave every insert uncertain. 256 KiB covers a text document of
  // roughly 260 000 characters plus its markup, and it keeps the confirmation to ONE linear scan over
  // a fixed maximum. A larger result is NOT truncated to a prefix — counting inside a prefix could
  // miss an occurrence or count a partial one — so it makes the read unusable and the insert settles
  // APPLY_UNCERTAIN (fail-closed), never a false success.
  documentHtmlBytes: 262144,
  // The bounded, CHUNKED whole-document text read (`read_document_text`). `readDocumentChars` is the
  // DEFAULT chunk a call that names no `maxChars` receives: 12000 characters, a comfortably large
  // working block for the model that still leaves the per-result ceiling three times over for a
  // Cyrillic document, where every character costs TWO UTF-8 bytes (24000 against `editorResultBytes`).
  // `readDocumentMaxChars` is the HARD per-call cap the schema advertises: 32768 characters, exactly
  // `editorResultBytes / 2` — the largest chunk whose Cyrillic encoding still fits the per-result
  // ceiling, and Cyrillic is this product's realistic worst case. It is deliberately NOT a proof for
  // every string: the widest UTF-8 encoding of one BMP character in this byte counter is THREE bytes
  // (CJK text, typographic punctuation; a lone surrogate counts as U+FFFD, also three), so a chunk of
  // 32768 such characters measures 98304 bytes — above the ceiling. The bound that is actually
  // ENFORCED is therefore the one the tool measures on the slice it is about to return, and an
  // over-ceiling chunk is refused with the closed `BYTE_LIMIT` class rather than truncated.
  readDocumentChars: 12000,
  readDocumentMaxChars: 32768,
  // The largest `offset` any readable document can address. The decoded text is derived from the
  // export, which is bounded by `documentHtmlBytes` bytes, and every character of that text costs at
  // least ONE UTF-8 byte, so no readable document's text can be longer than that many characters — an
  // offset at or above this bound lies beyond the end of every document this bridge can read. It is
  // still a closed SCHEMA bound: an offset above it is refused as an invalid argument (`TOOL_ERROR`)
  // before any dispatch, while an offset INSIDE the bound but past the end of THIS document is the
  // legitimate empty-tail read the handler answers with `ok` and no text.
  readDocumentOffsetMax: 262144,
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
