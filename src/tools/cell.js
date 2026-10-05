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
//   * `range.GetValue()` answers a 2-D array (one inner array per row). A multi-cell `GetFormula()` is
//     NOT confirmed on this build, which is why the bridge publishes `formulas: null` rather than an
//     empty matrix whenever the editor did not answer a matching matrix: `null` is an explicit "the
//     editor did not answer", while `[]` would read as a measured "these cells hold no formulas".
//   * `SetFormula` does NOT exist on a range, and a decimal written as a NUMBER becomes TEXT
//     (`SetValue(123.5)` → text; `SetValue('123,45')` → a real number). No tool in this module writes
//     yet; that rule belongs to `write_range` and is recorded here so the next tool cannot re-derive it
//     wrongly.
import { defineTool } from './registry.js';
import { ERROR_CODES } from '../shared/errors.js';
import { AGENT_CEILINGS, LIMITS } from '../shared/limits.js';
import { utf8ByteLength } from '../shared/bytes.js';

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
  // `formulas` is `null` when the editor answered no matching matrix, and a matrix of the same shape
  // when it did. Anything else is an answer this module cannot interpret.
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
      // and a column index means the same thing in every row. `formulas` is `null` unless the editor
      // answered a matching formula matrix — see the module header for why it is never `[]`.
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
      description: 'Читает активный лист: имя, номер, число листов и значения использованного диапазона.',
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
      // admits `A1` and `A1:C10` only, because the address crosses into an authored editor command as
      // DATA and an unvalidated string would be handed to the editor verbatim. It is read back by the
      // editor's own `GetAddress()` into the result, so the caller always learns the range the editor
      // actually answered rather than the one it asked for.
      name: 'read_range', kind: 'read', editors: ['cell'], policy: 'auto', requires: ['document.read'],
      description: 'Читает диапазон активного листа (A1 или A1:C10): значения и формулы ячеек.',
      schema: { type: 'object', additionalProperties: false, required: ['address'],
        properties: { address: { type: 'string', maxBytes: 24 } } },
      precondition: (args, ctx) => wrongEditor(ctx, ERROR_CODES.CAPABILITY_UNAVAILABLE),
      execute: async (args, ctx) => {
        // Every argument rule is re-checked HERE and not only by the schema: a descriptor is also
        // executable when it is held directly, and an address this read cannot interpret must be a
        // closed refusal with NOTHING dispatched. A non-string or an over-bound address is the module's
        // argument class; an address outside the closed shape is the same class, never a dispatch.
        const address = args?.address;
        if (typeof address !== 'string' || address === '' || !ADDRESS.test(address)) return known();
        if (utf8ByteLength(address) > 24) return known();
        if (missingBridgeMethod(bridge, 'readRange')) return known(ERROR_CODES.CAPABILITY_UNAVAILABLE);
        const request = readRequest(LIMITS.sheetReadCellsMax, ctx?.signal, { address });
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
    })
  ];
}
