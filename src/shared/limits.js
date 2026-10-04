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
  // The bounded, CHUNKED whole-document text read (`read_document_text`). What its schema advertises is
  // a CHARACTER count, but the bound that decides whether the read survives to the model is the byte
  // ceiling the runtime applies to ONE tool-result entry:
  //   `AGENT_CEILINGS.toolResultBytes` = 16384 bytes of `JSON.stringify({ tool, ...handlerResult })`
  //   (protocol.js: `stringifyToolResults`, which REFUSES an entry above it; runtime.js:27-36 then
  //   substitutes the literal "the tool result could not be serialized" and the model receives no text).
  // So the arithmetic is done on the SERIALIZED ENTRY, not on the raw text:
  //   Cyrillic (this product's realistic worst case): 2 UTF-8 bytes per character;
  //   ASCII: 1 byte; CJK / typographic punctuation: 3 bytes; an astral code point: 4 bytes (2 units).
  // `readDocumentEntryBytes` is the entry's own non-text envelope, measured on the widest field width
  // the schema admits (a six-digit offset, a six-digit `totalChars`, a four-character `null` resume
  // point) and pinned by a test against the protocol's serialization shape. The maximum chunk is
  // therefore the largest ROUND character count whose Cyrillic encoding plus that envelope fits:
  //   8000 * 2 + 130 = 16130 <= 16384, with 254 bytes of slack;
  //   the floor of the exact affordance is (16384 - 130) / 2 = 8127 characters.
  // `readDocumentChars` is the DEFAULT a call that names no `maxChars` receives — the same 8000, so a
  // default Cyrillic read (16000 bytes) is delivered whole instead of shrunk. `readDocumentMaxChars`
  // is the HARD per-call cap the schema advertises and equals the default: it is the largest ROUND
  // character count whose Cyrillic encoding — this product's realistic worst case — plus the envelope
  // fits, so the advertised maximum is a size a Cyrillic read returns in ONE whole chunk, and the
  // advertised space is not a promise of a size wider scripts can never receive.
  // The bound that is nevertheless ENFORCED is the one the tool measures on the entry it is about to
  // return, and a request whose slice does not fit it is served as the LARGEST smaller slice of the
  // SAME offset rather than refused (`maxChars` is an UPPER BOUND, not a hard requirement): every
  // schema-legal call delivers text, the entry is measured exactly, and only a slice where not even
  // ONE whole character fits is still the closed `BYTE_LIMIT` refusal.
  readDocumentChars: 8000,
  readDocumentMaxChars: 8000,
  // The measured non-text envelope of one `read_document_text` entry with the widest field values the
  // schema admits. It is exported because the tool and its test must name the SAME overhead the
  // protocol serializer contributes; the test recomputes it from the real serialization shape.
  readDocumentEntryBytes: 130,
  // The largest `offset` any readable document can address, and it is NOT the export byte bound.
  // The premise that bound rested on — "every character of the decoded text costs at least one UTF-8
  // byte, so the text cannot be longer than the export" — is false: the decoder appends one newline per
  // block-level element, so an export of N bytes can decode to MORE than N characters (the reviewer's
  // 100-byte pure-text export decodes to 101 characters). The bound is derived from the export it is
  // read through instead. `documentHtmlBytes` = 262144 bytes is the largest export the bridge decodes,
  // and the expansion is bounded by the export's own length: the newline per element costs one byte of
  // END tag, and an element contributing a newline without one contributes at least its two tag bytes,
  // so the decoded text cannot exceed twice the export plus the one character a zero-length export can
  // still yield: 2 * 262144 + 1 = 524289. The bound is that worst case plus 16 characters of margin.
  // The number exists for two properties, and both are tested:
  //   * it is at least as large as the largest `nextOffset` the tool can PUBLISH — a schema that
  //     rejects the tool's own resume point makes that tail unreadable (the defect this bound fixes:
  //     with the old 262144, `totalChars = 262146` published `nextOffset 262145`, which this tool's own
  //     schema then refused);
  //   * it bounds the readable range: a document whose own character count is past it is refused by the
  //     handler (`BYTE_LIMIT`, the `totalChars` fence), so the chunk it serves never runs past the bound
  //     and every published resume point is inside it by construction.
  // It stays a closed SCHEMA bound: an offset above it is refused as an invalid argument (`TOOL_ERROR`)
  // before any dispatch, while an offset INSIDE the bound but past the end of THIS document is the
  // legitimate empty-tail read the handler answers with `ok` and no text.
  readDocumentOffsetMax: 524305,
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
