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
  // The bounded CARET-CONTEXT read (`read_paragraph`) — the SECOND Sprint 3 Word tool. Its scope is the
  // SENTENCE the caret sits in, because that is the primitive the live build answers with (the
  // descriptor carries the evidence), so this is the largest caret text the reader may publish.
  // It is DERIVED FROM THE SERIALIZED ENTRY, not from the raw text, because the entry is the value the
  // runtime actually bounds:
  //   `AGENT_CEILINGS.toolResultBytes` = 16384 bytes of `JSON.stringify({ tool, ...handlerResult })`
  //   (protocol.js: `stringifyToolResults`, which REFUSES an entry above it; runtime.js:27-36 then
  //   substitutes the literal "the tool result could not be serialized" and the model receives no text).
  // The entry is `{"tool":"read_paragraph","ok":true,"data":{"scope":"sentence","text":T,"bytes":N}}`, and
  // its non-text envelope — measured by the descriptor's own `paragraphEntryBytes` and pinned by a test —
  // is a fixed 82 bytes plus one byte per DIGIT of `N`. At this bound `N` is five digits, so the envelope
  // is 87 bytes. 16000 is the largest ROUND ceiling that fits the product's realistic worst case,
  // Cyrillic at two UTF-8 bytes per character:
  //   16000 + 87 = 16087 <= 16384, with 297 bytes of slack.
  // The EXACT largest text that fits is 16297 bytes (its entry is exactly 16384; 16298 makes 16385), so
  // 16000 is deliberately conservative and round — the same rule `readDocumentChars` follows, so the
  // advertised bound is a size a Cyrillic caret read returns whole.
  // This is NOT an alias of `AGENT_CEILINGS.contextReadBytes.paragraph`: that entry bounds a raw
  // PARAGRAPH addressed by `read_context`, while this one bounds the SERIALIZED entry of a caret read,
  // and this module's own rule forbids serving one scope from another scope's budget.
  // The bound is a TEXT bound and is deliberately NOT the whole enforcement: `JSON.stringify` escapes
  // every C0 control character and every lone surrogate to two or six characters, so a text inside this
  // bound can still serialize to an entry far above the ceiling. The handler therefore measures the
  // ACTUAL entry as well, and that measurement is the enforced bound.
  readParagraphBytes: 16000,
  // The bounded document SEARCH (`find_text`) — the THIRD Sprint 3 Word tool. It adds exactly TWO
  // static per-call bounds, and NEITHER is derived from a document ceiling, because a search does not
  // read a document:
  //   * `findQueryBytes` bounds the NEEDLE. It is a search string, not a document: 256 bytes is 128
  //     Cyrillic or 256 ASCII characters — longer than any realistic needle — and it is the same number
  //     the schema advertises and the handler enforces. It is deliberately NOT an alias of any read
  //     bound (`readDocumentChars` counts characters of a served chunk, `selectionBytes` bounds a
  //     caret-scoped read); aliasing them would tie a search string's width to a document read's width.
  //   * `findMatchesMax` bounds how many MATCHES the tool REPORTS, and it is BOTH the documented default
  //     and the hard schema maximum (the `readDocumentChars`/`readDocumentMaxChars` rule, with one
  //     value). A search can match thousands of ranges, so the tool must bound what it publishes while
  //     `count` still carries the primitive's own TOTAL — the model learns "3 of 400" from one call.
  // THE ARITHMETIC, measured on the SERIALIZED entry the runtime bounds (`AGENT_CEILINGS.toolResultBytes`
  // = 16384 bytes of `JSON.stringify({ tool, ok, data })`, the shape `stringifyToolResults` measures and
  // `runtime.js:27-36` replaces with the literal "the tool result could not be serialized" when it is
  // exceeded). The entry is
  // `{"tool":"find_text","ok":true,"data":{"query":Q,"matchCase":B,"count":C,"matches":[{…}],"truncated":B}}`
  // and each reported match's text is the needle's OWN text as the document spells it — the primitive
  // matches a literal, so a match is as long as the query and cannot be longer. At both maxima, with the
  // widest field forms (`matchCase:false` and `truncated:false` are one byte wider than their `true`
  // forms), a Cyrillic needle at the byte maximum whose text is reported for every match measures
  //   EXACTLY 9283 bytes <= 16384, with 7101 bytes of slack.
  // That figure is the widest REALISTIC call, and it still ignores `count`'s own digits: `count` is the
  // primitive's TOTAL, not the reported-array length, so it can be any safe integer. Widening it from
  // the 2 digits of `count = findMatchesMax` to the 16 digits of `Number.MAX_SAFE_INTEGER` adds 14 bytes
  // and nothing else changes, which is the true maximum this schema can carry:
  //   9297 bytes <= 16384 (with `truncated:false`, the widest field form) — 7087 bytes of slack;
  //   9296 with `truncated:true` (the narrow form, `truncated: count > matches.length`).
  // A count that large is never told apart by the entry: 51 bytes of headroom separate the two forms.
  // That is a bound, not a promise about every character: the width of a character's JSON ESCAPE is what
  // breaks it, and there are TWO escape widths, not one. `JSON.stringify` emits a C0 control with a
  // named short escape (or `\b`, `\f`, `\n`, `\r`, `\t`) as a TWO-character escape — `JSON.stringify('\n')`
  // is the two characters `"\n"`, not six — while a control with no short form escapes as SIX characters,
  // `\uXXXX`. Both at the same maxima, measured:
  //   a 256-character needle of `\n` (two-character escapes) measures 17731 and CANNOT fit;
  //   a 256-character needle of a C0 control with no short escape (six-character `\uXXXX`) measures 51523
  //   and CANNOT fit.
  // The tool measures the entry it is about to publish and refuses either one with the closed
  // BYTE_LIMIT — it never shortens a match's text silently, because a shortened match presented as the
  // match is exactly the kind of approximation the other reads refuse. The two figures bracket the whole
  // escape family, so no needle above this bound is ever published as `ok`.
  findQueryBytes: 256,
  findMatchesMax: 32,
  // The bounded DOCUMENT-STRUCTURE read (`read_structure`) — the FOURTH Sprint 3 Word tool. It adds
  // exactly TWO static per-call bounds, and NEITHER is a document READ bound reused from another scope,
  // because a structure read is not a text read:
  //   * `structureHeadingsMax` bounds how many heading PARAGRAPHS the tool REPORTS, and it is ALSO the
  //     count the authored command body extracts INSIDE the editor (one value, so the native work and
  //     the published report can never disagree about how many texts are owed). An outline can hold
  //     hundreds of headings, so the tool must bound what it publishes while `counts.headings` still
  //     carries the primitive's own TOTAL — the model learns "32 of 500" from one call.
  //   * `structureHeadingBytes` bounds ONE heading TEXT, in UTF-8 bytes. A heading is a TITLE, not a
  //     paragraph: 256 bytes is 128 Cyrillic or 256 ASCII characters, longer than any realistic heading.
  //     A heading above it is never trimmed, and it no longer refuses the whole read either: the scalars
  //     and the counts are published with `headings: []` and `truncated: true`, an explicit omission
  //     explained with the arithmetic below.
  // THE ARITHMETIC, measured on the SERIALIZED entry the runtime bounds (`AGENT_CEILINGS.toolResultBytes`
  // = 16384 bytes of `JSON.stringify({ tool, ok, data })`, the shape `stringifyToolResults` measures and
  // `runtime.js:27-36` replaces with the literal "the tool result could not be serialized" when it is
  // exceeded; the check is `> 16384`, so an entry of EXACTLY 16384 still publishes). The entry is
  // `{"tool":"read_structure","ok":true,"data":{"pages":N,"statistics":{…5 fields…},"counts":{…4 fields…},"headings":[{"index":N,"text":T}…],"truncated":B}}`.
  // At BOTH advertised maxima — 32 headings of 128 Cyrillic characters, with the statistics and counts at
  // the digit widths a real document makes them — the entry measures EXACTLY 9192 <= 16384, with 7192
  // bytes of slack: the worst REALISTIC call. That is NOT the true maximum, and the earlier claim that
  // 9315 was is wrong in both its label and its shape. `JSON.stringify` escapes `"` as the TWO characters
  // `\"` (and `\` as `\\`), so ONE raw heading byte can serialize as two and the 256-byte per-heading
  // bound admits a far wider serialized heading than 128 Cyrillic characters ever do — the 2x-escape
  // family this comment used to skip while naming only families that CANNOT fit. The old figure was also
  // an UNREACHABLE shape: `truncated` is derived as `counts.headings > published.length`, so 32 headings
  // with a 16-digit `counts.headings` are `truncated:true`, never the `false` it measured. Measured:
  //   * 32 headings of 240 `"` (240 raw bytes, inside the bound): 16341, with 43 bytes of slack — SERVED;
  //   * 32 headings of 241 `"` (241 raw bytes):                  16405 — refused.
  // THE TRUE MAXIMUM IS THE CEILING EXACTLY, with ZERO slack: 16384 bytes, reached by 32 headings of 239
  // raw bytes each (238 `"` plus one plain ASCII byte, which makes the escaped width an ODD 477 bytes
  // per heading rather than the 476 or 480 a uniform heading reaches) with the nine non-heading numeric
  // fields at `Number.MAX_SAFE_INTEGER` and `counts.headings` at 14 digits. That field cannot also be 16
  // digits — the same headings then measure 16386 and are refused, and the widest 16-digit shape is
  // 16354 — and one escaped byte more per heading (480) measures 16480 and is refused.
  // That is a bound, not a promise about every character: `JSON.stringify` escapes C0 controls, and there
  // are TWO escape widths, exactly as `find_text` documents. An all-`\n` heading of 256 characters
  // (TWO-character short escapes) measures 17365 and CANNOT fit; the same heading made of a C0 control
  // with no short escape (SIX-character `\uXXXX`) measures 50133 and CANNOT fit. BOTH figures are the
  // 32-text array at its OWN 2-digit `counts.headings` width (32) — the shape a served array really has,
  // and the width the earlier figures got wrong. The tool measures the entry it is about to publish and
  // refuses either one with the closed BYTE_LIMIT — it never shortens a heading to fit.
  // AN OVER-WIDE HEADING IS AN OMISSION, NOT A REFUSAL. A heading above `structureHeadingBytes` is never
  // trimmed, but it does not refuse the read either: the answer is `ok` with the measured
  // `pages`/`statistics`/`counts`, `headings: []` and `truncated: true`. An explicit omission is better
  // than a total refusal for two reasons: the scalars and the counts are facts about the document that no
  // heading TEXT can make untrue, and the refusal was POSITIONAL — a 258-byte heading at index 0 refused
  // everything while the same heading at index 40 is never extracted and the read succeeded, so two
  // documents holding the same over-wide heading got opposite outcomes for a difference the model cannot
  // see. The array must be EMPTY rather than partially filled because a partial array with
  // `truncated: true` already means "more headings exist than are reported" (the cap case): publishing
  // the short texts beside an over-wide one under the SAME flag would give one flag two meanings and
  // leave the model unable to tell a withheld outline from a capped one. `counts.headings` reports the
  // PRIMITIVE'S OWN TOTAL in both cases — it is a count, not a text, so the omission neither narrows it
  // nor invents a zero.
  // NO `level` IS PUBLISHED, and that is a MEASURED decision rather than an omission. The vendored copy
  // of the installed build's SDK source (dev-only, `.local/stage-b-runtime/vendor-word-sdk-all.js`)
  // carries `GetOutlineLvl` 8 times, and EVERY one of the eight is on an INTERNAL class — the
  // document-outline manager, the internal paragraph (`s.prototype.GetOutlineLvl`) and the internal
  // paragraph properties (`Mt`, registered as `AscCommonWord.CParaPr`). NO PUBLIC MEMBER exposes the
  // outline level: `AscBuilder.ApiParagraph` (`G`) publishes no public outline getter (its alias list
  // runs `…GetParaPr…GetText…GetTextPr…` and never an outline member), and `AscBuilder.ApiParaPr` (`T`)
  // publishes `SetStyle`/`GetStyle`/`GetJc`/`GetIndLeft`/… but no `GetOutlineLvl`. That is NOT
  // unreachability: a PRIVATE route exists (`ApiParagraph.private_GetImpl().GetOutlineLvl()`), and this
  // read deliberately does not take it, because a document read through a private internal is a
  // dependency the next build is free to break. A level derived from the style NAME would be a guess (the
  // names are localized), and one derived from the array index is forbidden, so no `level` field exists
  // to drift from the truth.
  structureHeadingsMax: 32,
  structureHeadingBytes: 256,
  // The bounded BLOCK APPEND (`insert_blocks`) — the FIRST Sprint 3 MUTATION, the FIFTH authored command
  // body and the only leg that both WRITES and VERIFIES inside ONE command. It adds FOUR static per-call
  // bounds, and none of them is a READ bound reused from another scope, because an append is neither a
  // read nor a single paragraph:
  //   * `insertBlocksMax` bounds how many paragraphs ONE call may append. Every block becomes one
  //     `ApiParagraph` the editor-side body materialises BEFORE the single `InsertContent` call, so this
  //     cap bounds both the array the body builds and the arithmetic the result publishes. 64 is twice
  //     the module's other per-report cap (`findMatchesMax`/`structureHeadingsMax` = 32) because a
  //     chapter is a SEQUENCE of paragraphs — a heading plus its body — rather than a list of independent
  //     items, and the total payload is bounded separately below, so 64 can never make the dispatched
  //     payload unbounded.
  //   * `insertBlockBytes` bounds ONE block's TEXT in UTF-8 bytes. A block is a paragraph the model
  //     WRITES, not a document chunk the editor reads: 2048 bytes is 1024 Cyrillic or 2048 ASCII
  //     characters, longer than any realistic single paragraph, and it is deliberately NOT an alias of
  //     `readParagraphBytes` (a caret READ's budget) or of `structureHeadingBytes` (a title's): a written
  //     paragraph and a read one are different quantities, and aliasing them would tie one tool's input
  //     width to another tool's output width.
  //   * `insertBlocksBytes` bounds the WHOLE payload — the sum of every block's text bytes — and its
  //     value is `AGENT_CEILINGS.argumentsBytes` (8192; the two are pinned equal by a test, because this
  //     table is declared before that one and cannot name it). That is not a coincidence and not an alias
  //     of convenience: the blocks ARE the action's arguments, the bridge writes that very array into
  //     `Asc.scope` (which the vendor wrapper serializes with `JSON.stringify`), and JSON escaping never
  //     shrinks a text, so the sum of text bytes can never EXCEED the serialized arguments the runtime
  //     already bounds. The handler applies the same number, so a descriptor held directly — where no
  //     runtime bound runs — is bounded too, and the bound can only refuse a call the runtime would also
  //     have refused.
  //   * `insertHeadingMax` bounds the `heading` LEVEL, and it exists to keep the style NAME derivable:
  //     the body maps the level to the style `'Heading <n>'`, the OOXML built-in heading family runs
  //     `Heading1`…`Heading9`, and the lookup accepts the English name on a localized document too
  //     (measured on the target: `GetStyle('Heading 1')` and the same style as `'Heading1'`, `'heading 1'`
  //     and the localized `'Заголовок 1'` all resolve). The bound does NOT replace the fail-closed
  //     resolution: a document that does not DEFINE `Heading <n>` answers `null` and the whole call
  //     refuses with NOTHING inserted — never a plain paragraph where a heading was asked for.
  // THE ENTRY ARITHMETIC, measured on the SERIALIZED entry the runtime bounds
  // (`AGENT_CEILINGS.toolResultBytes` = 16384 bytes of `JSON.stringify({tool, ok, data})`, the shape
  // `stringifyToolResults` measures and `runtime.js:27-36` replaces with the literal "the tool result
  // could not be serialized" when it is exceeded). The entry is
  // `{"tool":"insert_blocks","ok":true,"data":{"inserted":N,"headings":N,"paragraphsBefore":N,"paragraphsAfter":N,"bytes":N}}`
  // and EVERY field is a non-negative safe integer: three of them bounded by the limits above and two by
  // the document's own array lengths (decoded as non-negative safe integers). Five integers cannot fill
  // 16384 bytes: with all five at `Number.MAX_SAFE_INTEGER` the entry measures 195 bytes — measured in the
  // tool's own test — so this guard cannot fire for any shape this handler can publish. The measurement
  // is nevertheless the ENFORCED bound: it is the module's ONE entry measurement, and a field added to
  // this result later must not be able to widen the entry unmeasured.
  insertBlocksMax: 64,
  insertBlockBytes: 2048,
  insertBlocksBytes: 8192,
  insertHeadingMax: 9,
  // The bounded TABLE INSERT (`insert_table`) — the SIXTH Sprint 3 Word tool, the SECOND MUTATION, and the
  // only leg that both CREATES a structure and FILLS it inside ONE command. It adds FOUR static per-call
  // bounds, and none of them is a bound reused from another scope, because a table is neither a paragraph
  // nor a read:
  //   * `insertTableRowsMax` bounds the ROW count of the requested matrix. Every row becomes one
  //     `GetCell(row, column)` walk the authored body performs BEFORE the single `Push`, and every cell one
  //     region flag in the answer, so this cap bounds both the editor-side work and the answer's width. 64
  //     is the same scale as `insertBlocksMax` — a long table and a chapter of paragraphs are the same
  //     amount of authored content — and it is deliberately NOT an alias of it: a row is not a paragraph.
  //   * `insertTableColumnsMax` bounds the COLUMN count. 16 columns is a wide but real data table, and
  //     64 × 16 = 1024 cells is the absolute worst case the geometry bounds admit: the answer's 1024
  //     one-character flags measure about 2 KiB of the 65536-byte `editorResultBytes` window, and the
  //     fill + readback loops stay bounded. The common four-column layout table costs 256 cells at most.
  //   * `insertTableCellBytes` bounds ONE CELL's text in UTF-8 bytes. A cell is a table cell, not a
  //     paragraph: 1024 bytes is 512 Cyrillic or 1024 ASCII characters, longer than any realistic cell,
  //     and it is deliberately NOT an alias of `insertBlockBytes` (half its width, because a written
  //     paragraph and a written cell are different quantities).
  //   * `insertTableBytes` bounds the WHOLE payload — the sum of every cell's text bytes — and its value is
  //     `AGENT_CEILINGS.argumentsBytes` (8192; the two are pinned equal by a test, because this table is
  //     declared before that one and cannot name it). The reasoning is `insertBlocksBytes`': the matrix IS
  //     the action's arguments, the bridge writes that very array into `Asc.scope` (which the vendor
  //     wrapper serializes with `JSON.stringify`), and JSON escaping never shrinks a text, so the sum of
  //     cell bytes can never EXCEED the serialized arguments the runtime already bounds. The handler
  //     applies the same number, so a descriptor held directly — where no runtime bound runs — is bounded
  //     too, and the bound can only refuse a call the runtime would also have refused. THE ENFORCED BOUND IS
  //     THE SUM OF THE CELLS, NOT THE SERIALIZED SIZE, so it is WEAKER than `AGENT_CEILINGS.argumentsBytes`
  //     by exactly the JSON structure and escaping wrapped around that sum: a handler-legal payload whose
  //     cells total 8192 bytes can serialize ABOVE 8192, and the runtime path refuses that in
  //     `src/agent/protocol.js` (`assertArgumentsBytes`) while a descriptor executed directly carries the
  //     handler's bound alone. The same shape exists for `insertBlocksBytes`, and it is a deliberate
  //     per-call bound rather than an alias of the serialized one.
  // A BLANK CELL IS LEGAL and no lower bound is advertised for a cell text: an empty cell is a real table
  // cell, and unlike the non-empty matrix (enforced by the handler and the bridge where `minItems` cannot
  // be advertised) there is nothing for a lower bound to protect.
  // NO `header` OPTION EXISTS. No measured primitive applies header formatting — the R7 public `ApiTable`
  // surface this module reads exposes no header/row-style member — and once a table is in the document a
  // header row is not distinguishable from a body row, so advertising one would promise what the tool
  // cannot do.
  // THE ENTRY ARITHMETIC, measured on the SERIALIZED entry the runtime bounds
  // (`AGENT_CEILINGS.toolResultBytes` = 16384 bytes of `JSON.stringify({tool, ok, data})`, the shape
  // `stringifyToolResults` measures and `runtime.js:27-36` replaces with the literal "the tool result
  // could not be serialized" when it is exceeded). The entry is
  // `{"tool":"insert_table","ok":true,"data":{"rows":N,"columns":N,"tablesBefore":N,"tablesAfter":N,"bytes":N}}`
  // and EVERY field is a non-negative safe integer: three of them bounded by the limits above and two by
  // the document's own table count (decoded as a non-negative safe integer). Five integers cannot fill
  // 16384 bytes: with all five at `Number.MAX_SAFE_INTEGER` the entry measures 181 bytes — measured in the
  // tool's own test — so this guard cannot fire for any shape this handler can publish. The measurement is
  // nevertheless the ENFORCED bound: it is the module's ONE entry measurement, and a field added to this
  // result later must not be able to widen the entry unmeasured.
  insertTableRowsMax: 64,
  insertTableColumnsMax: 16,
  insertTableCellBytes: 1024,
  insertTableBytes: 8192,
  // The bounded SPREADSHEET reads (`read_sheet`, `read_range`) — the first CELL legs in this repo. Every
  // bound below is measured, not chosen: they are the caps the authored body extracts against and the
  // same caps the decoder requires, so extraction and decode can never disagree.
  //   * `sheetReadCellsMax` bounds how many CELLS one read may return. A reported cell carries BOTH its
  //     value and its formula, so it costs two strings, and the payload is bounded separately by
  //     `sheetReadBytes`. 400 cells is a daily-work table (a 20 x 20 block, or the 10 x 5 plan-fact and
  //     P&L shapes this product targets) and is deliberately far below a whole-sheet read: the owner's
  //     good-enough scope is ordinary daily spreadsheets, not tens of sheets or huge ranges.
  //   * `sheetReadCellBytes` bounds ONE cell's text in UTF-8 bytes. A written cell is not a paragraph:
  //     512 bytes is half of `insertTableCellBytes` and still an order of magnitude above any daily
  //     figure, label or formula this product authors.
  sheetReadCellsMax: 400,
  sheetReadCellBytes: 512,
  // The bounded SPREADSHEET write (`write_range`). It is the first Cell MUTATION, so its bounds are the
  // ones the authored body writes against and the decoder proves against:
  //   * `writeRangeRowsMax`/`writeRangeColumnsMax` bound the block one call may write. They are the
  //     INSERT TABLE bounds of this same file (64 x 16), not new numbers: a written block of cells and a
  //     written table of cells are the same daily-work scale, and an alias would be invisible at runtime
  //     and silently wrong the moment the two diverge, so each scope names its own entry.
  //   * `writeRangeCellBytes` bounds ONE cell's text. It is a QUARTER of `insertTableCellBytes` (1024) and
  //     HALF of `sheetReadCellBytes` (512) — a quarter of a kilobyte — because a written cell is a value
  //     or a formula, never a document paragraph, and a formula over a daily sheet fits several times over.
  //   * `writeRangeBytes` bounds the whole payload — the sum of every cell's bytes. It deliberately
  //     equals `insertTableBytes`: the two are the same kind of bound and the same pilot scale.
  // `writeRangeCellsMax` is the total cell count and equals `sheetReadCellsMax`, so a block this product
  // can WRITE is always a block it can READ BACK to prove, which is the readback this mutation owes.
  writeRangeRowsMax: 64,
  writeRangeColumnsMax: 16,
  writeRangeCellBytes: 256,
  writeRangeBytes: 8192,
  writeRangeCellsMax: 400,
  // The bounded CELL FORMATTING (`format_range`) — the SECOND Cell mutation, and the FIRST one that changes
  // PRESENTATION rather than content. Every bound below is MEASURED (T4.0, see
  // `docs/evidence/sprint-4/t4.0-format-range-evidence.md`), because the authored formatter must never ask
  // the engine for a value outside the range it reads back EXACTLY: a silently clamped value would fail the
  // proof on a CORRECT request and settle it uncertain.
  //   * `formatRangeCellsMax` equals `sheetReadCellsMax`/`writeRangeCellsMax`. The 1..400-cell calibration
  //     measured a whole cycle (mutation plus per-property, per-cell verification) at 0.2 ms for one cell and
  //     7–9 ms for 400, with the worst confirmed channel — the per-cell font readback — costing about 2 ms at
  //     400 cells, so the cap is affordable rather than merely conventional. It is WINDOWS-calibrated and must
  //     be re-verified on the target build before Sprint 4 PASS.
  //   * `formatRangeDecimalsMax` is the largest decimal count whose number-format CODE round-trips exactly
  //     (`0.0000000000` measured equal); 0..10 were all exact.
  //   * `formatRangeFontSizeMax` and `formatRangeColumnWidthMax` are the largest values measured to read back
  //     exactly (1000 each; the engine also accepted a fractional column width, which the closed schema
  //     deliberately refuses because it has no `number` type).
  //   * `formatRangeRowHeightMax` is DELIBERATELY below what the engine accepts: a request for 500 was measured
  //     to be clamped to 409.5, so the bound stops at the largest value proven exact.
  //   * `formatRangeFontFamilyBytes` bounds ONE family name. The engine returns any name VERBATIM (including a
  //     name it does not have), so this is a schema guard rather than a measured engine limit.
  formatRangeCellsMax: 400,
  formatRangeDecimalsMax: 10,
  formatRangeFontSizeMax: 1000,
  formatRangeColumnWidthMax: 1000,
  formatRangeRowHeightMax: 400,
  formatRangeFontFamilyBytes: 64,
  // The bounded WORKBOOK LISTING (`list_sheets`) — the first WORKBOOK-level read, and the first tool in this
  // module whose subject is the book rather than one sheet.
  //   * `sheetListMax` bounds how many SHEETS one listing may carry. A daily workbook has a handful, and 64 is
  //     the same scale as this module's other block caps (`insertTableRowsMax`/`writeRangeRowsMax`); the bound
  //     exists so the listing cannot grow with the book without limit. A workbook ABOVE it is a KNOWN refusal,
  //     never a silently truncated list — a listing that omitted sheets would misrepresent the book.
  //   * `sheetListNameBytes` bounds ONE sheet name. Excel caps a sheet name at 31 CHARACTERS; in this product's
  //     own locale that is at most 62 UTF-8 bytes, so 128 is four times the worst case and cannot refuse a name
  //     the editor would have accepted.
  //   * `sheetNameCharactersMax` is that 31-character limit as an ENFORCED bound, because a byte bound alone is
  //     not the limit the editor applies. MEASURED natively: a 33-character NAME was SILENTLY REJECTED by
  //     `SetName` — the sheet kept its old name and the new one did not resolve — so a request carrying one used to
  //     spend a mutation and come back as uncertainty. It is now a KNOWN refusal BEFORE any mutation, which is why
  //     the bound is characters and not bytes: 31 Cyrillic characters are 62 bytes and must still be accepted.
  sheetListMax: 64,
  sheetListNameBytes: 128,
  sheetNameCharactersMax: 31,
  // The bounded HEADING STYLE ASSIGNMENT (`set_heading`) — the SEVENTH Sprint 3 Word tool, the THIRD
  // MUTATION, and the FIRST one that changes an EXISTING paragraph IN PLACE rather than appending a new
  // element. It adds exactly ONE static per-call bound, and it is not a read or a payload bound, because
  // this tool has no payload at all:
  //   * `setHeadingIndexMax` bounds the paragraph INDEX a caller may name. The index is the tool's ONE
  //     address, and unlike `insert_blocks`/`insert_table` it is NOT self-identifying: a wrong index is
  //     not a refusal but a mutation of the WRONG paragraph, which is why the authored body reads the
  //     target's TEXT before the one `SetStyle`, reads it again after, requires the two to be equal AND
  //     requires the target paragraph to be among the document's heading paragraphs afterwards. 128 is
  //     TWICE the bound the other index-addressed descriptor in this module carries for a READ
  //     (`MAX_CONTEXT_INDEX` = 64, src/tools/word.js) and is the same scale as this module's two other
  //     per-call caps (`insertBlocksMax`/`insertTableRowsMax` = 64): a document this product WRITES is a
  //     chapter, an outline plus body paragraphs, not a whole book, and a caller that has to address
  //     paragraph 129 of one is addressing text this module never authored. It is deliberately NOT an
  //     alias of any of those three — an index names a position, a block count names a payload, and a
  //     caret read names a budget. The bound does NOT replace the fail-closed check: the authored body
  //     requires the index to be INSIDE the document's own `GetAllParagraphs()` array BEFORE the one
  //     mutation, so an index past the end of THIS document is the closed argument class with ZERO
  //     writes, never a style applied to `undefined` or to some other paragraph.
  // NO TEXT BOUND IS ADDED, and that is deliberate rather than an omission: this tool takes NO text from
  // the model — it changes the STYLE of a paragraph the document already holds — so there is nothing for a
  // per-call byte bound to bound. The paragraph's text that the body compares is a document read, bounded
  // by the editor-result ceiling the bridge decodes under, never by a caller-supplied width.
  // THE ENTRY ARITHMETIC, measured on the SERIALIZED entry the runtime bounds
  // (`AGENT_CEILINGS.toolResultBytes` = 16384 bytes of `JSON.stringify({tool, ok, data})`, the shape
  // `stringifyToolResults` measures and `runtime.js:27-36` replaces with the literal "the tool result
  // could not be serialized" when it is exceeded). The entry is
  // `{"tool":"set_heading","ok":true,"data":{"paragraph":N,"level":N,"heading":true,"headingsBefore":N,"headingsAfter":N,"styleRead":B,"styleMatches":B,"bytes":N}}`
  // and EVERY field is a non-negative safe integer or a boolean: the index by the bound above, the level
  // by the heading family (1..9), the two counts by the document's own array lengths, and `bytes` by the
  // dispatched scope. Eight bounded scalars cannot fill 16384 bytes: with the index, the level and both
  // counts at `Number.MAX_SAFE_INTEGER` the entry measures well under 300 bytes — measured in the tool's
  // own test — so this guard cannot fire for any shape this handler can publish. The measurement is
  // nevertheless the ENFORCED bound: it is the module's ONE entry measurement, and a field added to this
  // result later must not be able to widen the entry unmeasured.
  setHeadingIndexMax: 128,
  // The bounded RANGE FORMAT (`format_range`) — the EIGHTH Sprint 3 Word tool, the FOURTH MUTATION, and the
  // SECOND one that changes an EXISTING paragraph in place. It adds FOUR static per-call bounds, and the
  // first two are an ADDRESS rather than a payload:
  //   * `formatRangeIndexMax` bounds the PARAGRAPH INDEX a caller may name. It is a SEPARATE constant from
  //     `setHeadingIndexMax` although the two bound the same kind of quantity, because they are separate
  //     decisions: this tool addresses a paragraph AND an offset inside it, so a future widening of one
  //     address must not silently widen two tools. 128 is the same scale as the heading index — a document
  //     this product WRITES is a chapter, not a whole book.
  //   * `formatRangeOffsetMax` bounds EACH character offset of the addressed range. It is deliberately NOT
  //     an alias of `insertBlockBytes` (2048) or of `readParagraphBytes` (16000), which bound TEXT, not a
  //     POSITION: a position is an index into the paragraph, and the same 8192 is the argument ceiling the
  //     runtime applies to a whole call (`AGENT_CEILINGS.argumentsBytes`), so no address this schema admits
  //     can even fill the arguments it travels in. The bound does not stand alone: the authored body checks
  //     BOTH offsets against the addressed paragraph's OWN `GetText().length` BEFORE the mutation, so a
  //     range past the end of THIS paragraph is the closed argument class with ZERO writes.
  //   * `formatRangeAlign` is the CLOSED alignment vocabulary, and it is a LIST rather than a bound because
  //     that is what the editor's own getter answers. It is MEASURED, not invented: `ApiParaPr.GetJc` (the
  //     vendored 2026.1.2 SDK, `T.prototype.GetJc`) maps the model's alignment onto exactly these four
  //     strings, and `both` — not `justify` — is the value the editor itself uses for justified text. The
  //     tool publishes this list and the body compares its readback against the SAME four strings, so the
  //     advertised vocabulary and the measured one cannot drift apart.
  //   * `formatRangeHtmlChars` bounds the HTML EXPORT the run proof is read through — the second readback, and
  //     the one that makes a character-level property advertisable at all. Its own comment below states the
  //     unit, the scale and the two places it is enforced.
  // NO TEXT BOUND IS ADDED, for `set_heading`'s reason exactly: this tool takes NO text from the model, so
  // there is nothing for a per-call text byte bound to bound. The paragraph's text that the body resolves
  // the offsets against is a document read, bounded by the editor-result ceiling the bridge decodes under.
  // THE ENTRY ARITHMETIC, measured on the SERIALIZED entry the runtime bounds
  // (`AGENT_CEILINGS.toolResultBytes` = 16384 bytes), and it is the WIDEST of the two mutating-in-place
  // legs: the entry is
  // `{"tool":"format_range","ok":true,"data":{"paragraph":N,"start":N,"end":N,"align":"both","alignBefore":"center","alignAfter":"center","paragraphsStable":B,"textUnchanged":B,"rangeRead":B,"rangeUnchanged":B,"rangeShifted":B,"bold":B,"italic":B,"underline":B,"strikeout":B,"boldVerified":B,"italicVerified":B,"underlineVerified":B,"strikeoutVerified":B,"bytes":N}}`
  // — four bounded numbers, two alignment strings from a closed four-word vocabulary, THIRTEEN booleans (five
  // range flags, four run requests and four run proofs) and one more bounded number. Nineteen bounded scalars
  // cannot fill 16384 bytes (measured in the tool's own test at well under 400), so this guard cannot fire for
  // any shape the handler can publish; the measurement is nevertheless the ENFORCED bound, exactly as it is
  // for the other three mutations. THE EXPORT IS NOT PART OF THIS ENTRY: `formatRangeHtmlChars` bounds a
  // string the authored body scans INSIDE the editor, and only the four one-character run flags derived from
  // it ever cross, so the export can never widen what the model receives.
  formatRangeIndexMax: 128,
  formatRangeOffsetMax: 8192,
  formatRangeAlign: Object.freeze(['left', 'center', 'right', 'both']),
  // `formatRangeHtmlChars` bounds the HTML EXPORT this leg SCANS, and it is a CHARACTER bound rather than a
  // byte bound for a reason that is not a convenience: the export never CROSSES anything. The authored body
  // reads it inside the editor, scans it, and returns four one-character flags — so the only quantity that
  // bounds the work this leg pays is the LENGTH of the string the editor built, and the body has no honest way
  // to compute UTF-8 bytes at all (there is no `TextEncoder` in the evaluated command scope, and reaching for
  // one would be reaching for a global the body must not depend on).
  // THE ARITHMETIC, and it is the same one this module already does for `readDocumentEntryBytes`: take the
  // export BYTE ceiling the read path fixes for a pilot document (`documentHtmlBytes` = 262144) and divide by
  // THIS product's realistic worst case of two UTF-8 bytes per character (Cyrillic) — 262144 / 2 = 131072
  // characters. So the leg scans no more HTML than the read path will carry, measured in the unit the editor's
  // own string has, and the export is BIG relative to the text (the Lead measured roughly 4.25x because of the
  // inline styles): 131072 characters of export is on the order of 30 000 characters of Cyrillic source text.
  // A document this product WRITES (a chapter, an outline plus body paragraphs) is far below that, and a
  // document whose export needs more is outside the size this leg will scan and is REFUSED CLOSED. The bound is
  // enforced in TWO places: the authored body refuses a PRE-mutation export above it with the closed
  // `BYTE_LIMIT` and ZERO writes, and it refuses a POST-mutation export above it as the UNCERTAIN class with
  // the slot held (a write has already run, so nothing there can be a known refusal). It is never truncated
  // to a prefix: a prefix could hide the addressed region or its marker, so a large export makes the read
  // unusable rather than partially trusted.
  formatRangeHtmlChars: 131072,
  // The bounded HYPERLINK INSERT (`add_hyperlink`) — the NINTH Sprint 3 Word tool, the FIFTH MUTATION, the
  // THIRD one that APPENDS, and the FIRST to take a URL from the model. It adds FOUR static per-call bounds
  // and ONE closed vocabulary, and the two that bound TEXT are payload bounds rather than an address:
  //   * `addHyperlinkUrlBytes` bounds the URL. 2048 is this module's existing text-PAYLOAD scale
  //     (`insertBlockBytes`), and it is deliberately its own constant rather than an alias: a URL is a
  //     single opaque token whose own scheme decides whether the editor even keeps it, so a later widening
  //     of one payload bound must not silently widen two tools. The bound is ALREADY the schema's advertised
  //     width (`maxBytes`), so a caller's over-bound URL is refused at the schema with ZERO writes; the
  //     precondition and the bridge entry point re-check the SAME number because a descriptor is also
  //     executable when it is held directly.
  //   * `addHyperlinkTextBytes` bounds the VISIBLE link text. 512 is TWICE the module's search-needle bound
  //     (`findQueryBytes` = 256), because a link's visible text is a LABEL the document renders inline
  //     rather than a paragraph: the measure is a phrase, not a block. It is not an alias of
  //     `findQueryBytes`: a needle is matched against text, a label becomes text.
  //   * `addHyperlinkIndexMax` bounds the optional paragraph INDEX. It is a SEPARATE constant from
  //     `setHeadingIndexMax` and `formatRangeIndexMax` although all three bound the same kind of quantity,
  //     because they are separate decisions and a later widening of one address must not silently widen
  //     three tools. 128 is the same scale as both — a document this product WRITES is a chapter. An index
  //     past THIS document's own `GetAllParagraphs()` array is the closed argument class with ZERO writes,
  //     decided by the authored body before the one mutation, never a link appended to `undefined`.
  //   * `addHyperlinkSchemes` is the CLOSED scheme list, and it is a LIST because the accepted shape of the
  //     URL is a vocabulary rather than a bound. It is deliberately NARROWER than the editor's own
  //     `AscCommon.rx_allowedProtocols` (measured in the vendored 2026.1.2 SDK): `ApiHyperlink.SetLink`
  //     REWRITES a URL that test does not match — a bare `AscCommon.getUrlType(U) === 2` value gets a
  //     `mailto:` prefix and everything else an `http://` prefix — and it ALSO rewrites every `%20` to a
  //     literal space (`U.replace(new RegExp("%20","g"), " ")`). The element readback compares the URL
  //     VERBATIM against what the editor STORED (`ApiHyperlink.GetLinkedText`), so a URL the editor would
  //     rewrite could never be proven to be the requested one. The list holds only the two ABSOLUTE schemes
  //     this tool serves, spelled in lower case exactly as `SetLink` matches them; `mailto:` and a relative
  //     path are the closed argument class with ZERO writes, and a URL that contains `%20` is refused there
  //     too rather than written and left unprovable.
  // NO EXPORT BOUND EXISTS ON THIS LEG ANY MORE, and the removal is the point of the round that added the
  // element readback. The bound this table used to carry (`addHyperlinkMarkdownChars`) existed ONLY because
  // the outcome was proved by locating a fragment in a document-wide `doc.ToMarkdown()` export; that export
  // is no longer READ at all (the review measured its needle broken by ANY character formatting inside the
  // addressed paragraph — the converter wraps other runs in `MdSymbols` — and by a line break, so a formatted
  // paragraph cost a FALSE UNCERTAIN with the write slot held). The proof is now PER-OBJECT and reads no
  // string the document built: on the addressed paragraph, after the write, `GetElementsCount()` must be the
  // PRE count + 1 and the appended element must answer `GetClassType() === 'hyperlink'`,
  // `GetLinkedText() === url` and `GetDisplayedText() === text`, with the paragraph's own text still equal to
  // the PRE text plus the label. The `GetElementsCount` PRE read is what the retired PRE-export check became,
  // and the per-object readback is what the retired document-wide uniqueness rule became: the element the
  // readback judges IS this call's own appended element, identified by its INDEX in the addressed paragraph,
  // so no document-wide search and therefore no export bound is involved. A per-call bound that bounds
  // nothing would be worse than absent — it would advertise a refusal this leg can no longer make.
  // THE ENTRY ARITHMETIC, measured on the SERIALIZED entry the runtime bounds
  // (`AGENT_CEILINGS.toolResultBytes` = 16384 bytes of `JSON.stringify({tool, ok, data})`, the shape
  // `stringifyToolResults` measures and `runtime.js:27-36` replaces with the literal "the tool result
  // could not be serialized" when it is exceeded). The entry is
  // `{"tool":"add_hyperlink","ok":true,"data":{"appended":B,"paragraph":N|null,"paragraphsBefore":N,"paragraphsAfter":N,"elementsBefore":N,"elementsAfter":N,"textBeforeChars":N,"textAfterChars":N,"textAppended":B,"elementCountGrew":B,"elementAppended":B,"bytes":N}}`
  // and EVERY field is a non-negative safe integer, `null`, or a boolean: the index by the bound above, the
  // two paragraph counts by the document's own array lengths, the two element counts by the addressed
  // paragraph's own content, the two character counts by its own text, and `bytes` by the dispatched scope.
  // ELEVEN bounded scalars cannot fill 16384 bytes (measured in the tool's own test at well under 400), so
  // this guard cannot fire for any shape the handler can publish; the measurement is nevertheless the
  // ENFORCED bound, exactly as it is for the other four mutations. THE URL AND THE LINK TEXT ARE NOT PART OF
  // THIS ENTRY: they are the caller's own words, and the element readback that proves them happens inside the
  // editor — only the flags derived from it cross.
  addHyperlinkUrlBytes: 2048,
  addHyperlinkTextBytes: 512,
  addHyperlinkIndexMax: 128,
  addHyperlinkSchemes: Object.freeze(['http://', 'https://']),
  // The bounded TEXT REPLACE (`replace_text`) — the ELEVENTH Word tool, the SIXTH MUTATION of Sprint 3, and
  // the FIRST tool whose whole proof is an EXACT OCCURRENCE COUNT read out of the document itself. It adds
  // THREE static per-call bounds and NO vocabulary:
  //   * `replaceTextSearchBytes` bounds the NEEDLE. 256 is the same scale as `findQueryBytes` and it is
  //     deliberately its own constant rather than an alias: a needle is what the document is COUNTED by, so
  //     a later widening of the search read must not silently widen two tools.
  //   * `replaceTextReplaceBytes` bounds the REPLACEMENT, which MAY BE EMPTY (deleting the needle is a
  //     legitimate replace) and is therefore bounded ABOVE only. 2048 is this module's existing text-PAYLOAD
  //     scale (`insertBlockBytes`/`addHyperlinkUrlBytes`) because a replacement becomes document text.
  //   * `replaceTextLimitMax` bounds the optional `limit` — the number of replacements the caller authorizes
  //     in ONE confirmed call. It is its own constant and not an alias of `findMatchesMax` (32) or of an
  //     index bound: those bound a REPORT and an ADDRESS, while this bounds how much text one confirmation
  //     may rewrite, and a chapter-sized document routinely holds thousands of occurrences of a common word.
  //     It is an UPPER CEILING on the request, never a truncation: the measured primitive carries NO count
  //     parameter (the vendored 2026.1.2 `SearchAndReplace` replaces EVERY match through
  //     `ReplaceSearchElement(V, true, null, false)`), so a `limit` strictly below the occurrence count is
  //     REFUSED CLOSED before the write — a partial replacement cannot be honoured and destroying more text
  //     than the caller authorized is not an option. The consequence is that the request's own arithmetic,
  //     `occurrencesAfter === occurrencesBefore - min(limit, occurrencesBefore)`, is exactly `... - occurrencesBefore`
  //     for every request this leg actually serves.
  // THE ENTRY ARITHMETIC, measured on the SERIALIZED entry the runtime bounds
  // (`AGENT_CEILINGS.toolResultBytes` = 16384 bytes of `JSON.stringify({tool, ok, data})`, the shape
  // `stringifyToolResults` measures and `runtime.js:27-36` replaces with the literal "the tool result
  // could not be serialized" when it is exceeded). This is the FIRST result on this branch that echoes the
  // caller's own words, so its bound is ARITHMETIC rather than a count of scalars: `search` and `replace`
  // are at most `replaceTextSearchBytes` (256) and `replaceTextReplaceBytes` (2048) UTF-8 bytes, and the
  // most expensive serialization of a string is a LONE SURROGATE — three UTF-8 bytes that `JSON.stringify`
  // emits as six ASCII characters, a doubling. Even at 2 × (256 + 2048) = 4608 bytes, plus five bounded
  // numbers (at most 16 digits each) and the fixed envelope, the entry stays under 5 KiB against 16384, so
  // the tool's own guard cannot fire for any shape its handler can publish; it is nevertheless the ENFORCED
  // bound, exactly as it is for the six mutations before it.
  replaceTextSearchBytes: 256,
  replaceTextReplaceBytes: 2048,
  replaceTextLimitMax: 4096,
  // The bounded IMAGE INSERT (`insert_image`) — the TWELFTH Word tool, the SEVENTH MUTATION of Sprint 3, and
  // the FIRST leg whose proof is a DOCUMENT-WIDE EXPORT NEEDLE built from the caller's OWN payload. It adds
  // THREE static per-call bounds and NO vocabulary:
  //   * `insertImageDataUrlBytes` bounds the WHOLE data URL. 4096 is a LITTLE under HALF of
  //     `AGENT_CEILINGS.argumentsBytes` (8192), which is the ceiling the runtime applies to ONE action's
  //     arguments (`JSON.stringify` of the call's `arguments`): a data URL of 4096 bytes cannot on its own
  //     push a legal one-action call past that ceiling, and the request's own shape — the two dimensions, the
  //     optional index and the JSON envelope — is bounded by a FEW DOZEN bytes beside it. 4096 is also this
  //     module's established text-PAYLOAD scale (`insertBlockBytes`/`addHyperlinkUrlBytes`/
  //     `replaceTextReplaceBytes` are 2048, `formatRangeHtmlChars` is an export bound), and it is the SAME
  //     order as a small real picture: a 3 KiB PNG encodes to about 4 KiB of base64. It is a CEILING, never a
  //     truncation — a data URL above it is the closed argument class with ZERO writes.
  //   * `insertImageDimensionPx` bounds EACH dimension. 4096 pixels is the same order as a full-page raster at
  //     300 dpi (A4 is 2480 x 3508) and it is a whole number of pixels, which is what the measured
  //     `Api.CreateImage(dataUrl, width, height)` takes. BOTH dimensions are REQUIRED by the schema: the
  //     primitive was measured WITH both, so an omitted dimension has no measured behaviour at all and this
  //     table states no default for it.
  //   * `insertImageIndexMax` bounds the optional paragraph ADDRESS. It is its own constant rather than an
  //     alias of `addHyperlinkIndexMax` for the reason that table states: an address is a per-tool decision,
  //     and a later widening of the link leg's bound must not silently widen this one. The value is equal
  //     today, and the equality is asserted as a SCALE rather than hidden behind an alias.
  // THE EXPORT BOUND IS NOT A NEW CONSTANT: the needle is located in the document's OWN markdown export, so
  // the read is a DOCUMENT-WIDE export read exactly like the insert confirmation's `GetFileHTML` read, and it
  // is bounded by `documentHtmlBytes` (262144) — the SAME ceiling every document export in this module is
  // decoded under. `insertImageMarkdownChars` names that decision explicitly (it is an ALIAS of
  // `documentHtmlBytes` on purpose: one ceiling, two readers) so the tool, its test and the bridge can name
  // the bound without reaching for a constant that belongs to another leg. The data URL is ASCII by
  // construction (this leg refuses any character outside `[A-Za-z0-9+/=]`), so the export's byte length and
  // its character length are the same number, and a 4096-byte needle cannot approach the ceiling on its own.
  insertImageDataUrlBytes: 4096,
  insertImageDimensionPx: 4096,
  insertImageIndexMax: 128,
  insertImageMarkdownChars: 262144,
  // The bounded COMMENT INSERT (`insert_comment`) — the THIRTEENTH Word tool, the EIGHTH MUTATION of Sprint 3,
  // and the FIRST leg whose proof is the COMMENT COLLECTION's own identity. It adds TWO static bounds and NO
  // vocabulary, and it takes NO target argument at all:
  //   * `insertCommentTextBytes` bounds the COMMENT TEXT. 2048 is this module's established text-PAYLOAD scale
  //     (`insertBlockBytes`, `addHyperlinkUrlBytes` and `replaceTextReplaceBytes` are the same number) because
  //     a comment becomes document text, and it is a QUARTER of `AGENT_CEILINGS.argumentsBytes` (8192) — the
  //     ceiling the runtime applies to ONE action's arguments (`JSON.stringify` of the call's `arguments`) —
  //     so a comment inside it cannot on its own push a legal one-action call past that ceiling. It is a
  //     CEILING, never a truncation: a text above it is the closed argument class with ZERO writes, decided
  //     before the mutation. THE CONTROL-CHARACTER RULE IS THE TOOL'S, not this table's: every C0 control and
  //     DEL is refused by `insertCommentText` in `src/tools/word.js` (with TAB, LF and CR allowed, because a
  //     multi-line comment is ordinary document text and those three are what the measured `GetText()` answers
  //     back verbatim), while the schema can express only the byte bound.
  //   * `insertCommentIdChars` is NOT a model argument and NOT a request rule: the comment's own id is READ
  //     BACK out of the document and published as the identity of the comment this call added, so this is a
  //     defensive width bound on ONE published field. The target answered a numeric-looking string; 128
  //     characters is room for any plausible id (a decimal, a GUID, a `word/comments.xml`-style serialized
  //     reference) and it is also what makes the entry arithmetic of this leg STATIC: at most 128 characters
  //     (a lone surrogate serializing to six ASCII characters apiece) plus four numbers of at most 16 digits
  //     keeps the entry far inside `AGENT_CEILINGS.toolResultBytes` (16384). An id longer than it is folded to
  //     `null` by the body — the honest "could not identify" report — which falls back to the id-set route and,
  //     failing that, settles the UNCERTAIN class with the slot HELD. Widening it later is safe; narrowing it
  //     can only cost a false `TOOL_UNCERTAIN`, never a false `ok`.
  // THE COMMENT TEXT IS NOT BOUNDED IN THE ENTRY: it is the caller's own request and is NEVER republished —
  // only the identified comment's own CHARACTER count and the request's own BYTE count cross.
  insertCommentTextBytes: 2048,
  insertCommentIdChars: 128,
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

// The panel's OWN agent-run guardrails: a NAMED, frozen configuration set built THROUGH the validated
// contract above, so an out-of-contract value could not have been exported at all.
//
// THIS IS A CONFIGURATION CHANGE BY THE DESIGN'S OWN INTENT, not a runtime change. The design says so
// three times, and the runtime already accepts the set IN THE REQUEST:
//   - above: "Runtime task guardrails. These are engineering defaults calibrated on the pilot workloads;
//     raising them must never require a runtime change."
//   - session.js:74: "…§12.2 requires far larger maxSteps to work without a runtime change."
//   - runtime.js:111 `const guardrails = createGuardrails(requested ?? {});` and §12.2: "A legitimate
//     pilot task — a ten-page structured document … may need several minutes, many model steps and
//     dozens of tool calls … the architecture must accept far larger values without a runtime change."
// The DEFAULTS above stay exactly as they are: they are what the tests and the calibration CLI profile
// (`tests/acceptance/agent/dev-qwen-workloads.mjs`, whose README prints 12 / 32 / 150000) assert, and
// every other caller keeps behaving as before. Only the panel's request carries the set below.
//
// THE NUMBERS, against the measured pilot shape. The owner's pilot request (a ~10-page structured
// document with chapters, several tables, lists, conclusions and formatting) ended AGENT_LIMIT after
// FIVE tool calls at ~148 s, i.e. ~2.4 steps and ~12.3 s of wall clock per executed action:
//   maxSteps 120            the prose alone is bounded by the 8192-byte argument ceiling, so a ten-page
//                           document needs 8-12 `insert_blocks` calls; with 6-8 chapters (`set_heading`
//                           plus their blocks), 3 `insert_table` calls, lists, conclusions and a
//                           formatting pass (`format_range`) the task is ~40-55 calls, which at the
//                           measured 2.4 steps per call is ~95-135 steps. 120 covers that band and, at
//                           the measured 12.3 s per step, ~24.6 minutes - inside the deadline below.
//   maxToolCalls 400        more than 7x the pilot's own call count: it bounds a runaway loop without
//                           ever being the guardrail a real ten-page task meets (maxSteps binds first).
//                           It stays inside the theoretical maximum for this step budget
//                           (AGENT_CEILINGS.actionsPerStep 8 x 120 steps), so it cannot mask a loop.
//   1800000 ms (30 min)     the measured 120 steps at ~12.3 s each is ~24.6 minutes, so the deadline
//                           BRACKETS the step budget instead of pre-empting it, and it is several
//                           times the ~148 s the measured run had already spent. It is deliberately
//                           BELOW the host-side bound the panel brackets a run with (the same deadline
//                           plus ONE transport window: 1800000 + LIMITS.operationTimeoutMs = 1950000 ms,
//                           `AGENT_RUN_HOST_DEADLINE_MS` in src/ui/controller.js), so a long task reports
//                           the runtime's own LIMIT/AGENT_LIMIT with its completed changes kept, never
//                           the panel's TIMEOUT. Any outer wall-clock bound applied around a native run
//                           must therefore exceed that host bound.
export const AGENT_GUARDRAILS = createGuardrails({ maxSteps: 120, maxToolCalls: 400, operationDeadlineMs: 1800000 });
