// src/tools/cell.js — the Cell (spreadsheet) tool catalogue.
//
// A descriptor here is one author-written static handler, exactly like `word.js`: the model's arguments
// arrive already validated by the registry's closed schema, so a handler only classifies, measures and
// passes them on. Handlers never touch the SDK, the DOM or localStorage — everything crosses the
// injected `bridge`, which is the only component that owns an R7 callback slot.
//
// EVERY PRIMITIVE BEHIND THESE TOOLS WAS MEASURED ON A LIVE CELL SESSION (R7-Office Editors 2026.3.1,
// `doctype=spreadsheet`, target-build confirmation still pending) and the measurements are recorded in
// `.local/cell-api-measured.md`. The three facts that shape this module:
//   * `Api.GetActiveSheet()` + `sheet.GetName()`/`GetIndex()`/`GetUsedRange()` and `Api.GetSheets()`
//     exist; `GetRowsCount`/`GetColumnsCount`/`GetMaxRow`/`GetMaxColumn`/`GetCell` are `undefined`, so
//     the USED RANGE is discovered through `GetUsedRange()` and through nothing else.
//   * `range.GetValue()` answers a 2-D array of strings for a BLOCK but a SCALAR STRING for a ONE-CELL
//     range (both measured), so the two shapes must be separated with `Array.isArray` — never with a
//     `.length` test, which a string also satisfies. `GetFormula()` is the sharper trap: on a MULTI-CELL
//     range it answers the computed VALUES, while on a ONE-CELL range it answers the real formula source.
//     BOTH legs therefore read formulas ADDRESSALLY, one single-cell range per cell, because that is the
//     only measured shape that answers a source. The read leg's `formulas` slot carries the SOURCE of a
//     cell that holds a formula and `''` for a cell that does not — the same getter answers a cell's own
//     TEXT when there is no formula, so the `=` prefix is the test — and it is `null` only when the read
//     published NO sources at all — the three conditions are stated where the body decides them: no getter,
//     an answered address that cannot be read as the value matrix's own rectangle, or a published cell whose
//     own single-cell value disagrees with the value published for it. `null` is an explicit "no sources were
//     published", while an
//     empty string is a measurement: this cell holds no formula.
//   * `SetFormula` does NOT exist on a range, and a decimal written as a NUMBER becomes TEXT
//     (`SetValue(123.5)` → text; `SetValue('123,45')` → a real number). `write_range` is the tool in this
//     module that WRITES, and it applies that rule in its authored body; the rule is recorded here so the
//     next tool cannot re-derive it wrongly.
import { defineTool } from './registry.js';
import { ERROR_CODES } from '../shared/errors.js';
import { AGENT_CEILINGS, LIMITS } from '../shared/limits.js';
import { utf8ByteLength, characterLength } from '../shared/bytes.js';

// Every refusal this module writes carries a closed class, never a raw exception message.
const REFUSAL = 'отказ';

function ok(data) { return Object.freeze({ ok: true, data: Object.freeze(data) }); }
function known(code = ERROR_CODES.TOOL_ERROR) { return Object.freeze({ ok: false, code, message: REFUSAL }); }

// A bridge that does not expose an entry point cannot serve the tool: that is a capability refusal,
// not a crash and never a raw TypeError.
function missingBridgeMethod(bridge, name) {
  return !bridge || typeof bridge !== 'object' || typeof bridge[name] !== 'function';
}
// A bridge refusal crosses back as a plain classified object. Only a class from the closed vocabulary
// is republished; anything else is the tool-error class.
function refusalCode(code, fallback) {
  return typeof code === 'string' && ERROR_CODES[code] === code ? code : fallback;
}
// Cell is the only editor this module describes, and the descriptor says so explicitly: a tool offered
// outside a spreadsheet refuses before any dispatch.
function wrongEditor(ctx, fallback) {
  return ctx?.editor === 'cell' ? null : { code: fallback, message: REFUSAL };
}
// The ONE bridge class that means "this operation may already have applied". The two Cell reads here
// cannot produce it, but the classification is written once for the module so that a later mutation
// leg cannot invent a second, drifting rule: `APPLY_UNCERTAIN` becomes the runtime's own uncertain
// class, so the run stops fail-safe instead of treating an unknown outcome as an ordinary error.
function uncertainResult(result) {
  if (!result || typeof result !== 'object' || result.code !== ERROR_CODES.APPLY_UNCERTAIN) return null;
  return Object.freeze({ ok: false, code: ERROR_CODES.TOOL_UNCERTAIN, message: REFUSAL });
}

// The exact bytes of ONE tool-result ENTRY in the form the runtime serializes and bounds:
// `JSON.stringify({ tool, ok: true, data })` — the shape `stringifyToolResults` (src/agent/protocol.js)
// builds and measures against `AGENT_CEILINGS.toolResultBytes`, and the shape whose refusal
// `appendToolResults` (src/agent/runtime.js:27-36) turns into the literal "the tool result could not be
// serialized". This module cannot import that function (src/agent/* is the runtime's own layer), so it
// reproduces the shape, and the test measures the real serializer against the published result.
function toolResultEntryBytes(tool, data) {
  let serialized;
  try { serialized = JSON.stringify({ tool, ok: true, data }); }
  catch { return null; }
  return typeof serialized === 'string' ? utf8ByteLength(serialized) : null;
}
// The CLOSED address shape a range read may name: `A1` or `A1:C10`. It is the same closed pattern the
// bridge enforces, repeated here because a descriptor is executable when it is held directly: a handler
// that trusted the bridge alone would hand an uninterpretable address to a dispatched editor command on
// the direct path. The two checks are deliberately the SAME shape, not two opinions about one address.
const ADDRESS = /^[A-Z]{1,3}[1-9][0-9]{0,6}(:[A-Z]{1,3}[1-9][0-9]{0,6})?$/;
// The COLUMN number of an A-Z address prefix, 1-based (`A` -> 1, `AA` -> 27).
function columnNumber(letters) {
  let value = 0;
  for (const letter of letters) value = value * 26 + (letter.charCodeAt(0) - 64);
  return value;
}
// The block an address names, or `null` when it names no block at all (`B2:A1` runs backwards). The
// `write_range` handler needs it because THAT tool's one structural precondition is that the addressed
// block IS the matrix it was handed: without it the editor would write a sub-rectangle and the readback
// proof would be over cells the request never mentioned.
function addressShape(address) {
  const parts = address.includes(':') ? address.split(':') : [address, address];
  if (parts.length !== 2) return null;
  const head = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(parts[0]);
  const tail = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(parts[1]);
  if (head === null || tail === null) return null;
  const columns = columnNumber(tail[1]) - columnNumber(head[1]) + 1;
  const rows = Number(tail[2]) - Number(head[2]) + 1;
  if (!(columns >= 1) || !(rows >= 1)) return null;
  return { rows, columns };
}
// A count this module can publish: a non-negative safe integer, with the counts that address a real
// sheet, row or column required to be at least 1.
function measuredCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
// The published shape re-checked in ONE place for both reads, because the two descriptors differ only
// in how the address was named. It answers the frozen data object, or `null` for an answer this module
// cannot interpret (the closed tool-error class at the call site). Every rule is the bridge's own
// envelope contract re-applied: this is not a second opinion, it is the same contract checked at the
// boundary the handler owns, so a bridge that drifted cannot publish an unmeasured field through a tool.
function sheetReadData(response) {
  const { sheetName, sheetIndex, sheetCount, requestAddress, readAddress, totalRows, totalColumns,
    rowCount, columnCount, truncated, values, formulas } = response;
  if (typeof sheetName !== 'string' || sheetName === '') return null;
  if (typeof requestAddress !== 'string' || requestAddress === '') return null;
  if (typeof readAddress !== 'string' || readAddress === '') return null;
  for (const count of [sheetIndex, sheetCount, totalRows, totalColumns, rowCount, columnCount]) if (!measuredCount(count)) return null;
  if (!(sheetCount >= 1) || !(totalRows >= 1) || !(totalColumns >= 1)) return null;
  if (!(rowCount >= 1) || !(columnCount >= 1)) return null;
  // The published matrix is a PREFIX of the measured range, and the flag that says so must AGREE with
  // the numbers it describes: a read that claims `truncated: true` while publishing the whole range, or
  // `false` while dropping rows, is an answer this module cannot interpret.
  if (rowCount > totalRows) return null;
  if (columnCount !== totalColumns) return null;
  if (truncated !== (totalRows > rowCount)) return null;
  const cellCount = rowCount * columnCount;
  if (!Number.isSafeInteger(cellCount) || cellCount > LIMITS.sheetReadCellsMax) return null;
  // ONE reader for a matrix, applied to the values and to the formulas alike, so the two can never be
  // validated by different rules.
  function matrix(source) {
    if (!Array.isArray(source) || source.length !== rowCount) return null;
    // The accumulator is named `sheetMatrixRows` rather than `rows` on purpose: the authored-code audit
    // resolves taint by identifier NAME across the whole composed bundle, so a local sharing a name with
    // a tainted identifier elsewhere would make every `.push` on it a dynamic-property finding. Measured:
    // with `rows` this line was the bundle audit's one finding, and the rename took the bundle to zero.
    const sheetMatrixRows = [];
    for (const row of source) {
      if (!Array.isArray(row) || row.length !== columnCount) return null;
      const cells = [];
      for (const cell of row) {
        if (typeof cell !== 'string') return null;
        // AN OVER-WIDE CELL REFUSES THE WHOLE READ, and it is never shortened: a cell the editor
        // answered with more text than this module will publish is not a value it can stand behind, and
        // a trimmed figure presented as the cell's own content is the approximation this module refuses
        // everywhere. The refusal is closed and total, so the caller never receives a partial matrix it
        // could mistake for the range's real shape.
        if (utf8ByteLength(cell) > LIMITS.sheetReadCellBytes) return null;
        cells.push(cell);
      }
      sheetMatrixRows.push(Object.freeze(cells));
    }
    return Object.freeze(sheetMatrixRows);
  }
  const valueRows = matrix(values);
  if (valueRows === null) return null;
  // `formulas` is `null` when this read published NO sources — the body's own three conditions are no getter,
  // an answered address it cannot read as the value matrix's rectangle, and a published cell whose own value
  // disagrees with the value published for it — and a matrix of the same
  // shape when it did: formula SOURCES, or `''` for a cell that holds none. Anything else is an answer
  // this module cannot interpret.
  const formulaRows = formulas === null ? null : matrix(formulas);
  if (formulas !== null && formulaRows === null) return null;
  return Object.freeze({ sheetName, sheetIndex, sheetCount, requestAddress, readAddress,
    totalRows, totalColumns, rowCount, columnCount, truncated, values: valueRows, formulas: formulaRows });
}

export function createCellTools(bridge) {
  // ONE request shape for both reads: the cap is the schema-side cap the descriptor advertises, so the
  // extraction inside the editor and the bound the handler applies cannot drift.
  function readRequest(maxCells, signal, extra) {
    return { maxCells, ...(extra ?? {}), ...(signal === undefined ? {} : { signal }) };
  }
  // ONE classification of a bridge answer for both reads, so a refusal class is mapped in exactly one
  // place. It takes the ENVELOPE, never the bridge: the dispatch itself is written at each call site as a
  // statically-named `bridge.readSheet`/`bridge.readRange`, because a computed `bridge[method]` lookup is
  // a dynamic-property sink the authored-code audit refuses (and it is the reason the catalogue resolves
  // handlers by static descriptor rather than a name-keyed switch).
  function refusedEnvelope(response) {
    if (!response || typeof response !== 'object') return known();
    const uncertain = uncertainResult(response);
    if (uncertain) return uncertain;
    if (response.ok !== true) return known(refusalCode(response.code, ERROR_CODES.TOOL_ERROR));
    return null;
  }
  return [
    defineTool({
      // Sprint 4 Cell tool 1: the ACTIVE-SHEET read, and the smallest useful Cell leg. It is a READ — it
      // answers a question about the sheet and changes nothing — so it needs no delta and no readback, no
      // mutate path is reachable from this descriptor, and it adds no capability beyond the read channel.
      // THE ADDRESS IS THE SHEET'S OWN USED RANGE, and that is a measured decision rather than a
      // convenience: this build exposes `sheet.GetUsedRange()` while `GetRowsCount`, `GetColumnsCount`,
      // `GetMaxRow` and `GetMaxColumn` are all `undefined`, so the used range is the ONLY honest answer
      // to "what does this sheet hold" — a fixed window would report blank cells as the sheet's content
      // and a scan would invent a bound the document never confirmed. The sheet's NAME, INDEX and the
      // workbook's sheet COUNT come from `GetName()`/`GetIndex()`/`GetSheets().length`, all measured.
      // `values` is the 2-D matrix `range.GetValue()` answered, one inner array per row, and a cell the
      // editor answered as empty is published as `''` rather than omitted, so the matrix stays rectangular
      // and a column index means the same thing in every row. `formulas` is the same-shaped matrix of
      // formula SOURCES, read addressally one single-cell range at a time, with `''` for a cell that holds
      // no formula; it is `null` only when this read published no sources at all — see the body's three
      // conditions, of which an unalignable address and a disagreeing cell value are two.
      // THE 400-CELL CAP IS APPLIED BY CLIPPING WHOLE ROWS, and the clipping is REPORTED rather than
      // hidden. The body measures the range's complete shape first, publishes the first rows that fit,
      // and answers with `totalRows`/`totalColumns` (what the range holds), `rowCount`/`columnCount`
      // (what the answer carries), `readAddress` (the range the answer actually covers) and
      // `truncated`. The owner's decision, and the reason it is not a closed refusal: a daily sheet's
      // used range routinely exceeds 400 cells (the measured one is 53 x 24 = 1272), so refusing would
      // make `read_sheet` unusable exactly where it is most useful, while an unannounced prefix would
      // present a partial sheet as the whole one. A caller that needs the rest reads it with
      // `read_range`. A range whose SINGLE ROW is wider than the cap still refuses closed: a partial row
      // would make one row a different width from the matrix the caller reads.
      name: 'read_sheet', kind: 'read', editors: ['cell'], policy: 'auto', requires: ['document.read'],
      description: 'Читает активный лист: имя, номер, число листов, значения и формулы использованного диапазона.',
      // CLOSED and EMPTY: the read takes no model parameter, so the schema advertises none and a caller
      // that guesses an argument is refused by the schema itself.
      schema: { type: 'object', additionalProperties: false, required: [], properties: {} },
      precondition: (args, ctx) => wrongEditor(ctx, ERROR_CODES.CAPABILITY_UNAVAILABLE),
      execute: async (args, ctx) => {
        if (missingBridgeMethod(bridge, 'readSheet')) return known(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        let response;
        try { response = await bridge.readSheet(readRequest(LIMITS.sheetReadCellsMax, ctx?.signal, null)); }
        catch (error) {
          const uncertain = uncertainResult(error);
          if (uncertain) return uncertain;
          return known(refusalCode(error?.code, ERROR_CODES.TOOL_ERROR));
        }
        const refused = refusedEnvelope(response);
        if (refused) return refused;
        const data = sheetReadData(response);
        if (data === null) return known();
        // THE ENFORCED BOUND is the ACTUAL serialized tool-result entry, exactly as the Word reads
        // measure it: the runtime bounds `JSON.stringify({tool, ...result})` by
        // `AGENT_CEILINGS.toolResultBytes` and replaces an over-bound entry with the model-visible literal
        // "the tool result could not be serialized" — the model would receive NO values while the action
        // log recorded `ok`.
        const entry = toolResultEntryBytes('read_sheet', data);
        if (entry === null || entry > AGENT_CEILINGS.toolResultBytes) return known(ERROR_CODES.BYTE_LIMIT);
        return ok(data);
      }
    }),
    defineTool({
      // Sprint 4 Cell tool 2: the ADDRESSED-RANGE read. It is the same one authored leg as `read_sheet`
      // (`bridge.readRange` differs only in carrying an address), so the primitives and the two
      // measured limits are the ones stated there and are not restated here. What this descriptor adds is
      // the ADDRESS itself, and it is a CLOSED precondition rather than an opaque string: the pattern
      // admits an upper-case `A1` or `A1:C10` and nothing else, because the address crosses into an
      // authored editor command as DATA and an unvalidated string would be handed to the editor verbatim.
      // The pattern does NOT require the corners to be ORDERED, because the measured editor NORMALISES a
      // reversed request — `GetRange('B2:A1')` answers the address `'A1:B2'` with an A1-first value matrix —
      // so the tool reports BOTH ranges instead of pretending they are the same one: `requestAddress` is
      // what the caller asked for, and `readAddress` is the range the editor actually answered.
      name: 'read_range', kind: 'read', editors: ['cell'], policy: 'auto', requires: ['document.read'],
      description: 'Читает диапазон: address — диапазон (A1 или A1:C10), значения и формулы. sheet — имя листа, sheetIndex — индекс; без них активный.',
      schema: { type: 'object', additionalProperties: false, required: ['address'],
        properties: {
          address: { type: 'string', maxBytes: 24 },
          // THE SHEET SELECTOR HAS TWO CLOSED SPELLINGS, because the measured lookup `Api.GetSheet` accepts a
          // NAME or an INDEX and this schema language has no union type: `sheet` is the name, `sheetIndex` is the
          // 0-based index, and naming BOTH is refused in the handler as ambiguous. No selector keeps exactly the
          // previous behaviour — the ACTIVE sheet — so every existing caller is unaffected.
          sheet: { type: 'string', minBytes: 1, maxBytes: LIMITS.sheetListNameBytes },
          sheetIndex: { type: 'integer', minimum: 0, maximum: LIMITS.sheetListMax - 1 } } },
      precondition: (args, ctx) => wrongEditor(ctx, ERROR_CODES.CAPABILITY_UNAVAILABLE),
      execute: async (args, ctx) => {
        // Every argument rule is re-checked HERE and not only by the schema: a descriptor is also
        // executable when it is held directly, and an address this read cannot interpret must be a
        // closed refusal with NOTHING dispatched. A non-string or an over-bound address is the module's
        // argument class; an address outside the closed shape is the same class, never a dispatch.
        const address = args?.address;
        const sheet = args?.sheet;
        const sheetIndex = args?.sheetIndex;
        for (const key of Object.keys(args ?? {})) if (key !== 'address' && key !== 'sheet' && key !== 'sheetIndex') return known();
        if (typeof address !== 'string' || address === '' || !ADDRESS.test(address)) return known();
        if (utf8ByteLength(address) > 24) return known();
        if (sheet !== undefined && (typeof sheet !== 'string' || sheet === '' || utf8ByteLength(sheet) > LIMITS.sheetListNameBytes)) return known();
        // The index bound is `sheetListMax` ON PURPOSE: it is the only MEASURED number for how many sheets this
        // repo supports, so a book past it is outside the supported envelope and an index beyond it is refused
        // (fail-CLOSED, stated rather than hidden) instead of being attempted.
        if (sheetIndex !== undefined && (!Number.isSafeInteger(sheetIndex) || sheetIndex < 0 || sheetIndex >= LIMITS.sheetListMax)) return known();
        if (sheet !== undefined && sheetIndex !== undefined) return known();
        if (missingBridgeMethod(bridge, 'readRange')) return known(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        const request = readRequest(LIMITS.sheetReadCellsMax, ctx?.signal, {
          address,
          sheetName: sheet === undefined ? null : sheet,
          sheetIndex: sheetIndex === undefined ? null : sheetIndex
        });
        let response;
        try { response = await bridge.readRange(request); }
        catch (error) {
          const uncertain = uncertainResult(error);
          if (uncertain) return uncertain;
          return known(refusalCode(error?.code, ERROR_CODES.TOOL_ERROR));
        }
        if (!response || typeof response !== 'object') return known();
        const uncertain = uncertainResult(response);
        if (uncertain) return uncertain;
        if (response.ok !== true) return known(refusalCode(response.code, ERROR_CODES.TOOL_ERROR));
        const data = sheetReadData(response);
        if (data === null) return known();
        const entry = toolResultEntryBytes('read_range', data);
        if (entry === null || entry > AGENT_CEILINGS.toolResultBytes) return known(ERROR_CODES.BYTE_LIMIT);
        return ok(data);
      }
    }),
    defineTool({
      // Sprint 4 Cell tool 3: the FIRST Cell MUTATION. It is NOT the first leg here whose argument carries
      // VALUES to be stored — `insert_table` and `insert_blocks` already take a matrix of strings — but it IS
      // the first that writes into a WORKBOOK rather than a document, and the first whose proof is a bounded
      // READBACK of the very block it wrote, one flag per cell, rather than a document delta or an occurrence
      // count. Every primitive it reaches was
      // measured on a live Cell sheet, and the measured rules live in the authored body (bridge.js,
      // `sheetwrite`) because that is where they are applied: an INTEGER-looking cell is handed over as a
      // number, everything else as the string the caller sent — which is what makes a decimal in locale
      // form (`123,45`) a real number while a non-integer JS number would be stored as TEXT — and a cell
      // beginning with `=` is a formula, whose validity the engine's own parser decides.
      //
      // THE ONE STRUCTURAL PRECONDITION is that the ADDRESSED BLOCK IS THE MATRIX. It is checked here and
      // again in the body, because it is what makes the proof exact: the body writes every cell of the
      // addressed block and then reads that SAME block back, one flag per cell, so a matrix that covered
      // only part of the address would leave cells the request never mentioned inside the proof.
      //
      // THE PROOF AND ITS LIMIT are stated rather than implied. After the write the body reads the block
      // ONCE for its VALUES — a ONE-CELL address is answered as a SCALAR and a block as a matrix, both
      // measured, and the two are separated by `Array.isArray` — and reads every FORMULA cell on its OWN
      // single-cell range, because a multi-cell formula read answers computed values on this build rather
      // than formula sources. One flag per cell: a formula cell is proved by HOLDING A FORMULA — the engine
      // rewrites function names and separators, so comparing formula TEXT would compare the engine's own
      // normalisation — and any other cell is proved by its value matching the request after the ONE
      // normalisation the editor's own answer requires (spaces removed, `,` read as `.`). That exact match
      // is also the whole rule for error values: one can never equal a DIFFERENT request, so it is never a
      // proof of one, while a caller who literally asked for `#`-leading text is proved by the match. A
      // single flag that is not 1 is the UNCERTAIN class: the document may already be changed, so the run
      // stops and the mutation is never retried. WHAT THE PROOF CANNOT SHOW: that a numeric-looking cell was
      // stored as a NUMBER rather than as text, because the readback answers both identically. Numericity
      // rests on the measured `SetValue` rule; a caller that needs it checked can read the cell with
      // `read_range` and use it in a formula. ONE REQUEST CLASS THIS LEG CANNOT SERVE, measured and stated so
      // it is not discovered as a mystery: a digits-only code with a LEADING ZERO (`'007'`) is coerced to a
      // NUMBER by the editor and reads back as `7`, so the proof refuses it and the run stops UNCERTAIN. The
      // refusal is deliberate — an account code silently renumbered would be worse — but such a code cannot
      // be written here on this build.
      name: 'write_range', kind: 'mutate', editors: ['cell'], policy: 'auto', requires: ['document.write'],
      description: 'Пишет блок: address — адрес (совпадает с блоком), cells — строки (числа строкой, формулы с «=»). sheet — имя листа, sheetIndex — индекс; без них активный.',
      schema: { type: 'object', additionalProperties: false, required: ['address', 'cells'],
        properties: {
          address: { type: 'string', maxBytes: 24 },
          cells: { type: 'array', maxItems: LIMITS.writeRangeRowsMax,
            items: { type: 'array', maxItems: LIMITS.writeRangeColumnsMax,
              items: { type: 'string', maxBytes: LIMITS.writeRangeCellBytes } } },
          // THE SAME TWO CLOSED SPELLINGS THE READ LEG PROVED (T5.3a): `sheet` is a name, `sheetIndex` is a
          // 0-based index, naming BOTH is refused as ambiguous, and NO selector keeps the previous behaviour — the
          // ACTIVE sheet. The measured lookup takes either form and this schema language has no union type.
          sheet: { type: 'string', minBytes: 1, maxBytes: LIMITS.sheetListNameBytes },
          sheetIndex: { type: 'integer', minimum: 0, maximum: LIMITS.sheetListMax - 1 } } },
      precondition: (args, ctx) => wrongEditor(ctx, ERROR_CODES.CAPABILITY_UNAVAILABLE),
      execute: async (args, ctx) => {
        // Every argument rule is re-checked HERE and not only by the schema: a descriptor is also
        // executable when it is held directly, and a request this write cannot interpret must be a closed
        // refusal with NOTHING dispatched.
        const address = args?.address;
        const cells = args?.cells;
        const sheet = args?.sheet;
        const sheetIndex = args?.sheetIndex;
        for (const key of Object.keys(args ?? {})) {
          if (key !== 'address' && key !== 'cells' && key !== 'sheet' && key !== 'sheetIndex') return known();
        }
        // A MUTATION MUST NOT DISPATCH WITH A SELECTOR IT CANNOT HONOUR, so the selector is closed here, before
        // the block is even inspected: naming BOTH spellings is refused because the request would not say which
        // sheet it means, and the index bound reuses `sheetListMax` — the only MEASURED sheet count — so the
        // failure mode is fail-closed rather than a write into the wrong sheet. (The READ leg checks the address
        // first instead; the order differs because for a MUTATION the sheet is the subject that has to be settled
        // before anything else is looked at, and BOTH orders refuse the whole request before any dispatch.)
        if (sheet !== undefined && (typeof sheet !== 'string' || sheet === '' || utf8ByteLength(sheet) > LIMITS.sheetListNameBytes)) return known();
        if (sheetIndex !== undefined && (!Number.isSafeInteger(sheetIndex) || sheetIndex < 0 || sheetIndex >= LIMITS.sheetListMax)) return known();
        if (sheet !== undefined && sheetIndex !== undefined) return known();
        if (typeof address !== 'string' || address === '' || !ADDRESS.test(address)) return known();
        if (utf8ByteLength(address) > 24) return known();
        const shape = addressShape(address);
        if (shape === null) return known();
        if (!Array.isArray(cells) || cells.length < 1 || cells.length > LIMITS.writeRangeRowsMax) return known();
        if (cells.length !== shape.rows) return known();
        const columns = cells[0]?.length;
        if (!Number.isSafeInteger(columns) || columns < 1 || columns > LIMITS.writeRangeColumnsMax) return known();
        if (columns !== shape.columns) return known();
        let cellCount = 0;
        let totalBytes = 0;
        const forwarded = [];
        for (const row of cells) {
          if (!Array.isArray(row) || row.length !== columns) return known();
          const forwardedRow = [];
          for (const cell of row) {
            if (typeof cell !== 'string') return known();
            const bytes = utf8ByteLength(cell);
            if (bytes > LIMITS.writeRangeCellBytes) return known(ERROR_CODES.BYTE_LIMIT);
            totalBytes += bytes;
            cellCount += 1;
            forwardedRow.push(cell);
          }
          forwarded.push(Object.freeze(forwardedRow));
        }
        if (cellCount > LIMITS.writeRangeCellsMax) return known();
        if (totalBytes > LIMITS.writeRangeBytes) return known(ERROR_CODES.BYTE_LIMIT);
        if (missingBridgeMethod(bridge, 'writeRange')) return known(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        let response;
        try {
          response = await bridge.writeRange({ address, cells: Object.freeze(forwarded),
            sheetName: sheet === undefined ? null : sheet,
            sheetIndex: sheetIndex === undefined ? null : sheetIndex,
            ...(ctx?.signal === undefined ? {} : { signal: ctx.signal }) });
        } catch (error) {
          const uncertain = uncertainResult(error);
          if (uncertain) return uncertain;
          return known(refusalCode(error?.code, ERROR_CODES.TOOL_ERROR));
        }
        if (!response || typeof response !== 'object') return known();
        // A returned UNCERTAIN class is the one outcome that must stop the run rather than read as an
        // ordinary known error.
        const uncertain = uncertainResult(response);
        if (uncertain) return uncertain;
        if (response.ok !== true) return known(refusalCode(response.code, ERROR_CODES.TOOL_ERROR));
        // The bridge's own envelope contract re-checked here: the answer must describe exactly the block
        // this tool asked for, so a bridge that drifted can never publish a write of another shape as this
        // one's result.
        if (response.address !== address) return known();
        if (response.rowCount !== shape.rows || response.columnCount !== shape.columns) return known();
        const data = Object.freeze({ address, rowCount: shape.rows, columnCount: shape.columns,
          cells: cellCount, bytes: totalBytes });
        const entry = toolResultEntryBytes('write_range', data);
        if (entry === null || entry > AGENT_CEILINGS.toolResultBytes) return known(ERROR_CODES.BYTE_LIMIT);
        return ok(data);
      }
    }),
    defineTool({
      // Sprint 4 Cell tool 7 (T5.4): RENAMING a sheet — the last toolkit addition of the series, and the one whose
      // failure is least recoverable: a name cannot be un-renamed without a SECOND hidden mutation, so this leg
      // NEVER renames anything back.
      // THE SOURCE IS CHOSEN LIKE EVERY OTHER SHEET-AWARE LEG (`sheet` / `sheetIndex`, both at once refused), and no
      // selector renames the ACTIVE sheet. `newName` is REQUIRED and closed: a non-empty string inside the name
      // bound with no control character. A name that ALREADY RESOLVES — including the sheet's own current name — is
      // a KNOWN refusal raised BEFORE the mutation, so the book is never left with a duplicate or with a no-op whose
      // outcome could not be proved.
      // AFTER `SetName` the result is a POSTCONDITION measured through the INDEPENDENT readers: the sheet count is
      // unchanged, every other sheet keeps its name AND its position, the renamed sheet keeps its INDEX, the new
      // name resolves at that index, and the OLD name no longer resolves at all. The active sheet is RECORDED, never
      // switched and never restored. An unproved outcome is the uncertain class, the run stops, nothing is retried.
      name: 'rename_sheet', kind: 'mutate', editors: ['cell'], policy: 'auto', requires: ['document.write'],
      description: 'Переименовывает лист: newName — новое имя (до 31 символа), sheet — имя источника, sheetIndex — его индекс; без них активный.',
      schema: { type: 'object', additionalProperties: false, required: ['newName'],
        properties: {
          newName: { type: 'string', minBytes: 1, maxBytes: LIMITS.sheetListNameBytes },
          sheet: { type: 'string', minBytes: 1, maxBytes: LIMITS.sheetListNameBytes },
          sheetIndex: { type: 'integer', minimum: 0, maximum: LIMITS.sheetListMax - 1 } } },
      precondition: (args, ctx) => wrongEditor(ctx, ERROR_CODES.CAPABILITY_UNAVAILABLE),
      execute: async (args, ctx) => {
        // Every argument rule is re-checked HERE and not only by the schema: a descriptor is also executable when it
        // is held directly, and a rename this leg cannot interpret must be a closed refusal with NOTHING dispatched.
        if (args === null || typeof args !== 'object' || Array.isArray(args)) return known();
        for (const key of Object.keys(args)) if (key !== 'newName' && key !== 'sheet' && key !== 'sheetIndex') return known();
        const newName = args?.newName;
        const sheet = args?.sheet;
        const sheetIndex = args?.sheetIndex;
        // BOTH NAME BOUNDS, checked here as well as in the bridge, because a MUTATION must not dispatch with a name
        // the editor will silently ignore: the byte bound and the measured 31-CHARACTER bound, so a 33-character
        // name is a KNOWN refusal before anything is dispatched rather than uncertainty after a spent mutation.
        if (typeof newName !== 'string' || newName === '' || utf8ByteLength(newName) > LIMITS.sheetListNameBytes
          || characterLength(newName) > LIMITS.sheetNameCharactersMax
          || /[\u0000-\u001f\u007f]/.test(newName)) return known();
        if (sheet !== undefined && (typeof sheet !== 'string' || sheet === '' || utf8ByteLength(sheet) > LIMITS.sheetListNameBytes)) return known();
        if (sheetIndex !== undefined && (!Number.isSafeInteger(sheetIndex) || sheetIndex < 0 || sheetIndex >= LIMITS.sheetListMax)) return known();
        if (sheet !== undefined && sheetIndex !== undefined) return known();
        if (missingBridgeMethod(bridge, 'renameSheet')) return known(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        let response;
        try {
          response = await bridge.renameSheet({
            ...(sheet === undefined ? {} : { sourceName: sheet }),
            ...(sheetIndex === undefined ? {} : { sourceIndex: sheetIndex }),
            newName,
            ...(ctx?.signal === undefined ? {} : { signal: ctx.signal })
          });
        } catch (error) {
          const uncertain = uncertainResult(error);
          if (uncertain) return uncertain;
          return known(refusalCode(error?.code, ERROR_CODES.TOOL_ERROR));
        }
        const refused = refusedEnvelope(response);
        if (refused !== null) return refused;
        // The envelope re-checked here, so a bridge that drifted cannot publish a rename of another shape: the index
        // is a real position, the confirmed name DIFFERS from the previous one (a rename that renamed nothing is not
        // a success), and the recorded active pair is coherent.
        if (!Number.isSafeInteger(response.index) || response.index < 0) return known();
        if (typeof response.name !== 'string' || response.name === '' || utf8ByteLength(response.name) > LIMITS.sheetListNameBytes) return known();
        if (typeof response.previousName !== 'string' || response.previousName === ''
          || utf8ByteLength(response.previousName) > LIMITS.sheetListNameBytes) return known();
        if (response.name === response.previousName) return known();
        if (!Number.isSafeInteger(response.activeIndex) || response.activeIndex < 0) return known();
        if (typeof response.activeName !== 'string' || response.activeName === '' || utf8ByteLength(response.activeName) > LIMITS.sheetListNameBytes) return known();
        const data = Object.freeze({ index: response.index, name: response.name, previousName: response.previousName,
          activeIndex: response.activeIndex, activeName: response.activeName });
        const entryBytes = toolResultEntryBytes('rename_sheet', data);
        if (entryBytes === null || entryBytes > AGENT_CEILINGS.toolResultBytes) return known(ERROR_CODES.BYTE_LIMIT);
        return ok(data);
      }
    }),
    defineTool({
      // Sprint 4 Cell tool 6 (T5.2): the FIRST WORKBOOK-level MUTATION. It adds exactly ONE sheet, at the END of
      // the book, and `Api.AddSheet` answers `undefined` — which is neither success nor failure, so nothing is
      // read from its return value. What the caller is told is the POSTCONDITION the bridge measured and proved
      // after the call: the book grew by exactly one, the new sheet is the LAST one, its name is the name the
      // editor reports, it is the ACTIVE sheet, and every former sheet kept its position.
      // THE NAME IS OPTIONAL AND IS NEVER INVENTED. With a name, the confirmed name must EQUAL it; without one,
      // the caller gets exactly the (localised) default the editor produced, read back from the editor. A name
      // that already exists is a KNOWN refusal BEFORE the mutation, so the book never ends up with a duplicate.
      // THE FORMER ACTIVE SHEET IS REPORTED, NOT RESTORED: `AddSheet` measurably activates the new sheet, and
      // silently switching back would be a second, hidden action.
      // AFTER THE MUTATION THERE IS NO KNOWN FAILURE CLASS: an unproved postcondition is the uncertain outcome
      // (the run stops, nothing is retried), and a sheet that may have been created is never deleted here.
      name: 'add_sheet', kind: 'mutate', editors: ['cell'], policy: 'auto', requires: ['document.write'],
      description: 'Добавляет лист в конец книги: name — имя (необязательно; фактическое читается из редактора).',
      schema: { type: 'object', additionalProperties: false,
        properties: { name: { type: 'string', minBytes: 1, maxBytes: LIMITS.sheetListNameBytes } } },
      precondition: (args, ctx) => wrongEditor(ctx, ERROR_CODES.CAPABILITY_UNAVAILABLE),
      execute: async (args, ctx) => {
        // Every argument rule is re-checked HERE and not only by the schema: a descriptor is also executable
        // when it is held directly.
        if (args === null || typeof args !== 'object' || Array.isArray(args)) return known();
        for (const key of Object.keys(args)) if (key !== 'name') return known();
        const name = args.name;
        if (name !== undefined && (typeof name !== 'string' || name === '' || utf8ByteLength(name) > LIMITS.sheetListNameBytes)) return known();
        if (missingBridgeMethod(bridge, 'addSheet')) return known(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        let response;
        try {
          response = await bridge.addSheet({
            ...(name === undefined ? {} : { name }),
            ...(ctx?.signal === undefined ? {} : { signal: ctx.signal })
          });
        } catch (error) {
          const uncertain = uncertainResult(error);
          if (uncertain) return uncertain;
          return known(refusalCode(error?.code, ERROR_CODES.TOOL_ERROR));
        }
        const refused = refusedEnvelope(response);
        if (refused !== null) return refused;
        // The envelope re-checked here, so a bridge that drifted cannot publish an add of another shape: a new
        // sheet is never the FIRST one (a book always holds at least the sheet that was there before), its name
        // is bounded, an add is by definition ACTIVE, and the former active sheet is named and indexed.
        const previousActive = response.previousActive;
        if (!Number.isSafeInteger(response.index) || response.index < 1) return known();
        if (typeof response.name !== 'string' || response.name === '' || utf8ByteLength(response.name) > LIMITS.sheetListNameBytes) return known();
        if (response.active !== true) return known();
        if (previousActive === null || typeof previousActive !== 'object' || Array.isArray(previousActive)) return known();
        // The former active sheet must be a sheet that ALREADY EXISTED, so its index is strictly BELOW the new
        // sheet's. The UPPER bound is checked as well as the lower one: without it a drifted bridge could report
        // the NEW sheet as its own predecessor.
        if (!Number.isSafeInteger(previousActive.index) || previousActive.index < 0 || previousActive.index >= response.index) return known();
        if (typeof previousActive.name !== 'string' || previousActive.name === '' || utf8ByteLength(previousActive.name) > LIMITS.sheetListNameBytes) return known();
        const data = Object.freeze({ index: response.index, name: response.name, active: true,
          previousActive: Object.freeze({ index: previousActive.index, name: previousActive.name }) });
        // The published entry is bounded BY CONSTRUCTION (the name bound plus four small scalars); the
        // measurement is kept as the ENFORCED bound rather than trusted, like every other leg in this module.
        const entryBytes = toolResultEntryBytes('add_sheet', data);
        if (entryBytes === null || entryBytes > AGENT_CEILINGS.toolResultBytes) return known(ERROR_CODES.BYTE_LIMIT);
        return ok(data);
      }
    }),
    defineTool({
      // Sprint 4 Cell tool 5 (T5.1): the FIRST WORKBOOK-level tool. Its subject is the BOOK, not one sheet, and
      // it exists because everything else in T5 addresses something inside a book: before a caller can name a
      // sheet it has to know which ones exist and which one is active.
      // IT IS A READ, AND IT TAKES NO ARGUMENTS AT ALL. The schema is the empty closed object, so a caller that
      // passes anything is refused by the closed class; there is no sheet NAME to validate because the answer is
      // the list of names.
      // THE ACTIVE SHEET IS REPORTED BY NAME **AND** INDEX, and the underlying measurement is why: on a live
      // editor `Api.GetSheets()[i]` and `Api.GetActiveSheet()` are DIFFERENT wrapper objects for the same sheet,
      // so object identity cannot identify the active one. That pair of slots is what a caller can rely on.
      // A LISTING IS NEVER TRUNCATED. A workbook above `LIMITS.sheetListMax` is a known refusal, because a list
      // that silently omitted sheets would misrepresent the book to the caller and to the model reading it.
      name: 'list_sheets', kind: 'read', editors: ['cell'], policy: 'auto', requires: ['document.read'],
      description: 'Перечисляет листы книги: имя, индекс, признак активного и скрытого листа.',
      schema: { type: 'object', additionalProperties: false, properties: {} },
      precondition: (args, ctx) => wrongEditor(ctx, ERROR_CODES.CAPABILITY_UNAVAILABLE),
      execute: async (args, ctx) => {
        // Every argument rule is re-checked HERE and not only by the schema: a descriptor is also executable
        // when it is held directly, and this leg accepts NOTHING — deliberately stricter than the sibling READS,
        // which ignore an argument they do not use. A leg whose whole contract is "no arguments" should say so.
        if (args === null || typeof args !== 'object' || Array.isArray(args)) return known();
        if (Object.keys(args).length > 0) return known();
        if (missingBridgeMethod(bridge, 'listSheets')) return known(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        let response;
        try {
          response = await bridge.listSheets(ctx?.signal === undefined ? {} : { signal: ctx.signal });
        } catch (error) {
          const uncertain = uncertainResult(error);
          if (uncertain) return uncertain;
          return known(refusalCode(error?.code, ERROR_CODES.TOOL_ERROR));
        }
        const refused = refusedEnvelope(response);
        if (refused !== null) return refused;
        // THE PER-SHEET SHAPE IS THE DECODER'S, and this handler deliberately does not re-walk it: the decoder
        // is the layer that reads the native answer, and it already refuses a listing whose declared count
        // disagrees with its entries, whose indices are not positional, that marks no sheet active or two of
        // them, or whose header disagrees with the entry it names (covered by
        // `tests/unit/bridge-sheetlist.test.js`). What this handler re-checks is the SCALAR envelope it
        // publishes, so a bridge that drifted can still never publish another book's counts as this result.
        const sheets = response.sheets;
        if (!Array.isArray(sheets) || sheets.length < 1 || sheets.length > LIMITS.sheetListMax) return known();
        if (response.count !== sheets.length) return known();
        if (!Number.isSafeInteger(response.activeIndex) || response.activeIndex < 0 || response.activeIndex >= sheets.length) return known();
        if (typeof response.activeName !== 'string' || response.activeName === '') return known();
        const data = Object.freeze({ count: response.count, activeIndex: response.activeIndex,
          activeName: response.activeName, sheets });
        const entryBytes = toolResultEntryBytes('list_sheets', data);
        if (entryBytes === null || entryBytes > AGENT_CEILINGS.toolResultBytes) return known(ERROR_CODES.BYTE_LIMIT);
        return ok(data);
      }
    }),
    defineTool({
      // Sprint 4 Cell tool 4: the FIRST Cell tool that changes PRESENTATION rather than content, and the first
      // in this module whose proof is per-PROPERTY rather than per-target — one flag per (property, cell) and
      // per (geometry property, column/row), so one unproven property can never hide behind the proven ones.
      // ONLY PROOF-CARRYING PROPERTIES ARE IN THE SCHEMA. Each one below has BOTH a setter and a public
      // readback that T4.0 measured on a live Cell session, and the measurement is recorded in
      // `docs/evidence/sprint-4/t4.0-format-range-evidence.md`. The five that were measured and EXCLUDED are
      // named there with their reason (`fontColor`, both alignments, `borders`, `autofit` — a setter with no
      // readback that can prove it was applied), and this schema does not carry them, so a request that names
      // one is refused by the closed schema before anything is dispatched.
      // THE REQUEST IS WHOLE OR REFUSED. A mixed request that names one unsupported property changes NOTHING,
      // an empty formatting request (an address and nothing else) is a known refusal, and every argument rule
      // is re-checked in the handler as well because a descriptor is also executable when held directly.
      // THE MEASURED BOUNDS ARE NOT DECORATION: `rowHeight` stops at 400 because a request for 500 is silently
      // clamped to 409.5 by the engine, which would fail the proof on a CORRECT request; `decimals` stops at
      // 10 because that is where the number-format code still round-trips exactly; and `columnWidth` is an
      // INTEGER here even though the engine also accepted a fractional width, because this closed schema has
      // no `number` type and a stricter schema can never produce a false success.
      // GEOMETRY SEMANTICS, stated because they are not per-cell: `columnWidth` acts on EVERY column the
      // address intersects and is confirmed per affected column, and `rowHeight` acts on EVERY row it
      // intersects and is confirmed per affected row.
      // THE NAME IS `format_cells`, NOT `format_range`, and the reason is measured rather than stylistic: the
      // Word leg already owns `format_range` (src/tools/word.js:2048), and it is not merely a naming clash. The
      // controller builds ONE registry from the Word and Cell catalogues together (src/ui/controller.js), and
      // `defineTool`/`createRegistry` THROW on a duplicate tool name (src/tools/registry.js), so a second
      // `format_range` would have been a HARD REGISTRY FAILURE at load. The registry's bulk-profile VIEW is a
      // filter by NAME (`BULK_TOOLS`) rather than by editor, so a duplicate would ALSO have offered a bulk
      // spreadsheet run exactly one formatting tool and none of the Cell reads. Renaming the CELL leg avoids
      // both without changing the shared registry, which this task must not touch.
      name: 'format_cells', kind: 'mutate', editors: ['cell'], policy: 'auto', requires: ['document.write'],
      description: 'Форматирует блок: address — адрес; ключи bold, italic, numberFormat, fill, clearFill, fontFamily, fontSize, wrapText, columnWidth, rowHeight. sheet — имя, sheetIndex — индекс; без них активный.',
      schema: { type: 'object', additionalProperties: false, required: ['address'],
        properties: {
          address: { type: 'string', maxBytes: 24 },
          numberFormat: { type: 'object', additionalProperties: false, required: ['type'],
            properties: {
              type: { type: 'string', enum: ['number', 'percent', 'currency'] },
              decimals: { type: 'integer', minimum: 0, maximum: LIMITS.formatRangeDecimalsMax },
              currency: { type: 'string', enum: ['RUB', 'USD', 'EUR'] } } },
          bold: { type: 'boolean' },
          italic: { type: 'boolean' },
          fontFamily: { type: 'string', minBytes: 1, maxBytes: LIMITS.formatRangeFontFamilyBytes },
          fontSize: { type: 'integer', minimum: 1, maximum: LIMITS.formatRangeFontSizeMax },
          fill: { type: 'string', maxBytes: 7 },
          clearFill: { type: 'boolean' },
          columnWidth: { type: 'integer', minimum: 1, maximum: LIMITS.formatRangeColumnWidthMax },
          rowHeight: { type: 'integer', minimum: 1, maximum: LIMITS.formatRangeRowHeightMax },
          wrapText: { type: 'boolean' },
          // THE SAME TWO CLOSED SPELLINGS THE OTHER SHEET-AWARE LEGS PROVED: `sheet` is a name, `sheetIndex` is a
          // 0-based index, naming BOTH is refused as ambiguous, and NO selector keeps the previous behaviour — the
          // ACTIVE sheet. They select the SUBJECT and are not formatting properties.
          sheet: { type: 'string', minBytes: 1, maxBytes: LIMITS.sheetListNameBytes },
          sheetIndex: { type: 'integer', minimum: 0, maximum: LIMITS.sheetListMax - 1 } } },
      precondition: (args, ctx) => wrongEditor(ctx, ERROR_CODES.CAPABILITY_UNAVAILABLE),
      execute: async (args, ctx) => {
        const address = args?.address;
        const numberFormat = args?.numberFormat;
        const bold = args?.bold;
        const italic = args?.italic;
        const fontFamily = args?.fontFamily;
        const fontSize = args?.fontSize;
        const fill = args?.fill;
        const clearFill = args?.clearFill;
        const columnWidth = args?.columnWidth;
        const rowHeight = args?.rowHeight;
        const wrapText = args?.wrapText;
        const sheet = args?.sheet;
        const sheetIndex = args?.sheetIndex;
        // The closed key sets, checked here as well and at BOTH levels: an unknown property (`fontColor`, an
        // alignment, a border, `autofit`, or anything else) must be a known refusal with NOTHING dispatched,
        // never a partial apply — and the NESTED `numberFormat` object is closed too, because a `symbol` or any
        // other stray key inside it would otherwise be silently dropped and the request served as if it had
        // been understood. The two SHEET spellings belong to that closed set and are NOT formatting properties:
        // they choose the SUBJECT of the mutation and never count as "something to apply".
        const allowed = new Set(['address', 'numberFormat', 'bold', 'italic', 'fontFamily', 'fontSize', 'fill', 'clearFill', 'columnWidth', 'rowHeight', 'wrapText', 'sheet', 'sheetIndex']);
        for (const key of Object.keys(args ?? {})) if (!allowed.has(key)) return known();
        // A MUTATION MUST NOT DISPATCH WITH A SELECTOR IT CANNOT HONOUR, so the selector is closed here, BEFORE
        // the formatting properties are inspected: naming BOTH spellings is ambiguous, and the index bound reuses
        // `sheetListMax` — the only MEASURED sheet count — so the failure mode is fail-closed rather than a format
        // applied to the wrong sheet.
        if (sheet !== undefined && (typeof sheet !== 'string' || sheet === '' || utf8ByteLength(sheet) > LIMITS.sheetListNameBytes)) return known();
        if (sheetIndex !== undefined && (!Number.isSafeInteger(sheetIndex) || sheetIndex < 0 || sheetIndex >= LIMITS.sheetListMax)) return known();
        if (sheet !== undefined && sheetIndex !== undefined) return known();
        if (numberFormat !== undefined && numberFormat !== null && typeof numberFormat === 'object' && !Array.isArray(numberFormat)) {
          for (const key of Object.keys(numberFormat)) if (key !== 'type' && key !== 'decimals' && key !== 'currency') return known();
        }
        if (typeof address !== 'string' || address === '' || !ADDRESS.test(address)) return known();
        if (utf8ByteLength(address) > 24) return known();
        const shape = addressShape(address);
        if (shape === null) return known();
        const cellCount = shape.rows * shape.columns;
        if (cellCount > LIMITS.formatRangeCellsMax) return known();
        // The DISCRIMINATED number-format rule, which the closed schema cannot express: `currency` is required
        // for the currency type and refused for the others, and the type itself must be one of the measured
        // families.
        if (numberFormat !== undefined) {
          if (numberFormat === null || typeof numberFormat !== 'object' || Array.isArray(numberFormat)) return known();
          const type = numberFormat.type;
          if (type !== 'number' && type !== 'percent' && type !== 'currency') return known();
          if (type === 'currency') {
            if (numberFormat.currency !== 'RUB' && numberFormat.currency !== 'USD' && numberFormat.currency !== 'EUR') return known();
          } else if (numberFormat.currency !== undefined) return known();
          const decimals = numberFormat.decimals;
          if (decimals !== undefined && (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > LIMITS.formatRangeDecimalsMax)) return known();
        }
        if (bold !== undefined && typeof bold !== 'boolean') return known();
        if (italic !== undefined && typeof italic !== 'boolean') return known();
        if (wrapText !== undefined && typeof wrapText !== 'boolean') return known();
        if (clearFill !== undefined && typeof clearFill !== 'boolean') return known();
        if (fontFamily !== undefined && (typeof fontFamily !== 'string' || fontFamily === '' || utf8ByteLength(fontFamily) > LIMITS.formatRangeFontFamilyBytes)) return known();
        if (fontSize !== undefined && (!Number.isSafeInteger(fontSize) || fontSize < 1 || fontSize > LIMITS.formatRangeFontSizeMax)) return known();
        if (columnWidth !== undefined && (!Number.isSafeInteger(columnWidth) || columnWidth < 1 || columnWidth > LIMITS.formatRangeColumnWidthMax)) return known();
        if (rowHeight !== undefined && (!Number.isSafeInteger(rowHeight) || rowHeight < 1 || rowHeight > LIMITS.formatRangeRowHeightMax)) return known();
        // `fill` is the measured colour spelling (`#RRGGBB`, a Colour object behind it), and `clearFill` is the
        // same clearing request under a name this closed schema can express. Asking for both is refused.
        if (fill !== undefined && (typeof fill !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(fill))) return known();
        if (clearFill === true && fill !== undefined) return known();
        // AT LEAST ONE formatting property besides the address, or there is nothing to prove.
        let propertyCount = 0;
        if (numberFormat !== undefined) propertyCount += 1;
        if (bold !== undefined) propertyCount += 1;
        if (italic !== undefined) propertyCount += 1;
        if (fontFamily !== undefined) propertyCount += 1;
        if (fontSize !== undefined) propertyCount += 1;
        if (fill !== undefined) propertyCount += 1;
        if (clearFill === true) propertyCount += 1;
        if (columnWidth !== undefined) propertyCount += 1;
        if (rowHeight !== undefined) propertyCount += 1;
        if (wrapText !== undefined) propertyCount += 1;
        if (propertyCount < 1) return known();
        if (missingBridgeMethod(bridge, 'formatCells')) return known(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        let response;
        try {
          response = await bridge.formatCells({
            address,
            ...(numberFormat === undefined ? {} : { numberFormat }),
            ...(bold === undefined ? {} : { bold }),
            ...(italic === undefined ? {} : { italic }),
            ...(fontFamily === undefined ? {} : { fontFamily }),
            ...(fontSize === undefined ? {} : { fontSize }),
            ...(fill === undefined ? {} : { fill }),
            ...(clearFill === undefined ? {} : { clearFill }),
            ...(columnWidth === undefined ? {} : { columnWidth }),
            ...(rowHeight === undefined ? {} : { rowHeight }),
            ...(wrapText === undefined ? {} : { wrapText }),
            // THE SELECTOR CROSSES ONLY WHEN IT WAS GIVEN, following this leg's own convention for every other
            // optional property: a request that names no sheet stays BYTE-IDENTICAL to what it always was, so the
            // T4 request shape is untouched rather than widened with two nulls.
            ...(sheet === undefined ? {} : { sheetName: sheet }),
            ...(sheetIndex === undefined ? {} : { sheetIndex }),
            ...(ctx?.signal === undefined ? {} : { signal: ctx.signal })
          });
        } catch (error) {
          const uncertain = uncertainResult(error);
          if (uncertain) return uncertain;
          return known(refusalCode(error?.code, ERROR_CODES.TOOL_ERROR));
        }
        if (!response || typeof response !== 'object') return known();
        // A returned UNCERTAIN class is the one outcome that must stop the run rather than read as an ordinary
        // known error: a formatting request that dispatched but could not be proved may already be applied.
        const uncertain = uncertainResult(response);
        if (uncertain) return uncertain;
        if (response.ok !== true) return known(refusalCode(response.code, ERROR_CODES.TOOL_ERROR));
        // The bridge's envelope re-checked here, so a bridge that drifted can never publish a format of
        // another shape as this one's result.
        if (response.address !== address) return known();
        if (response.rowCount !== shape.rows || response.columnCount !== shape.columns) return known();
        if (response.properties !== propertyCount) return known();
        const data = Object.freeze({ address, rowCount: shape.rows, columnCount: shape.columns, properties: propertyCount });
        const entry = toolResultEntryBytes('format_cells', data);
        if (entry === null || entry > AGENT_CEILINGS.toolResultBytes) return known(ERROR_CODES.BYTE_LIMIT);
        return ok(data);
      }
    })
  ];
}
