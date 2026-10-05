// src/ui/orchestrator.js
//
// PLAN -> EXECUTE -> VERIFY -> CONTINUE for a LONG document-generation request, owned by the PANEL.
// Nothing here touches `src/agent/`: one pass is an ordinary agent request, the plan/execute/continue
// WORDING is composed by this module and carried in the REQUEST TEXT, and the panel's existing
// single-run path is untouched for an ordinary request.
//
// WHY A STATE MACHINE AT ALL. Measured on the owner's free-form ten-page request, two identical runs
// produced 2 -> 30 and 1 -> 7 headings, one of them 0 -> 2 tables and the other no tables at all, and
// the volume stayed at 914-1430 characters — far short of ~10 pages. The tool layer works; what was
// missing is a plan, execution in parts, a measurement of the RESULT, and a continuation when the plan
// is not fulfilled. This module therefore decides WHEN to run, WHAT to ask for, and WHEN to stop — and
// it never decides whether the document changed: that is measured, not asked.
import { LIMITS } from '../shared/limits.js';
import { utf8ByteLength } from '../shared/bytes.js';

// THE VOLUME TARGET. The owner asked for "примерно 10 страниц". A page of Russian text on A4 is
// computed, not guessed, from the document's own characters-with-spaces count: a full A4 text field is
// roughly 165 mm x 250 mm, which at 12 pt single-spaced Cyrillic (~2.3 mm of line pitch, ~90-95
// characters a line) holds about 2500 characters, while normal business formatting with paragraph
// spacing holds closer to 1800. This target takes the DENSE end of that range — 1800 characters a page
// — so a document that reaches it is ten pages of solid text rather than a short text with wide
// spacing: 10 x 1800 = 18000. The plan may name a HIGHER target; it may never lower this floor.
export const ORCHESTRATION_PAGE_CHARS = 1800;
export const ORCHESTRATION_TARGET_CHARS = 10 * ORCHESTRATION_PAGE_CHARS; // 18000
// A plan may ask for more than ten pages, but its target is bounded: the volume is a real requirement
// the model has to satisfy, so a plan that names a million characters would turn a bounded task into an
// unreachable one (the same reason the pass count is bounded below).
export const ORCHESTRATION_MAX_TARGET_CHARS = 100000;
// THE PASS CAP. The cheapest useful pass appends a bounded batch of blocks; six passes is enough for
// roughly ten chapters with tables and conclusions while keeping the worst-case model budget bounded
// (each pass is an ordinary run under the named guardrails). The cap is a NAMED number so the honest
// report can say exactly how many passes were spent when the plan is still unfulfilled.
export const ORCHESTRATION_MAX_EXECUTE_PASSES = 6;
// The plan is authored data bounded before it is reused in a request: a slice, never a rewrite, so the
// plan the model wrote is the plan the execute passes receive.
export const ORCHESTRATION_PLAN_BYTES = 8192;
// One bounded read serves the volume floor, the list and the conclusion check without a second read.
export const ORCHESTRATION_TEXT_PROBE_CHARS = 2000;
// The most headings the orchestrator asks for: the same cap the `read_structure` tool advertises, so
// the read is an ordinary supported request rather than an invented one.
export const ORCHESTRATION_MAX_HEADINGS = LIMITS.structureHeadingsMax;
// The elements this orchestrator can honestly verify from a read. `volume` and `sections` are CHECKED
// but never DECLARED: the volume is the owner's own requirement (the plan's `targetCharacters` can only
// move its floor up) and the section count is the plan's own array, so neither can be switched off by
// the model. The three declared elements are the plan's, and each must be an explicit boolean.
const DECLARABLE = Object.freeze(['tables', 'lists', 'conclusions']);
// A line beginning with a bullet or an ordinal marker, at any indent. The one list signal a bounded
// text read can decide on (a character count cannot tell a list from a paragraph). It is a heuristic
// and it is NAMED as one in the section comments below: it is used only where the volume and the
// section count already agreed, so a false negative can ask for one more pass but can never declare a
// short document complete.
const LIST_MARKER = /^[ \t]*(?:[•·▪◦‣∙–—]|[-*+])[ \t]+\S|\d{1,2}[.)][ \t]+\S/m;
const CONCLUSION_WORDS = Object.freeze(['вывод', 'заключени', 'итог', 'conclusion', 'summary']);

// The plan is MODEL OUTPUT and is never trusted as instruction: every field is validated, bounded and
// re-frozen, and an unrecognised element key is dropped rather than carried into a request.
function own(value, key) { return value !== null && typeof value === 'object' && Object.hasOwn(value, key); }
function boundedText(value, maxChars = 300) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, maxChars);
}
function booleanField(value) { return value === true ? true : value === false ? false : null; }
// A section entry is either a title or an object with a title. The TITLE is the only part that
// crosses: a per-section character budget the model volunteers is not a measurement this module can
// hold the document to, so it is deliberately not carried.
function sectionTitle(item) {
  if (typeof item === 'string') return boundedText(item, 200);
  if (item === null || typeof item !== 'object') return null;
  return boundedText(item.title ?? item.name ?? item.heading, 200);
}

// Returns the validated plan, or null when the answer is not a plan. `null` is the ONLY failure mode:
// the caller stops with an honest report rather than inventing a plan from an unparsable answer.
export function parsePlan(message) {
  if (typeof message !== 'string' || message.trim() === '') return null;
  // The plan is BOUNDED before it is parsed: a slice of a huge answer would be a plan nobody wrote, so
  // an answer above the named byte bound is refused whole rather than trimmed into something executable.
  if (utf8ByteLength(message) > ORCHESTRATION_PLAN_BYTES) return null;
  let parsed;
  try { parsed = JSON.parse(message); } catch { return null; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const rawSections = own(parsed, 'sections') ? parsed.sections : null;
  if (!Array.isArray(rawSections) || rawSections.length === 0 || rawSections.length > 40) return null;
  const sections = [];
  for (const item of rawSections) {
    const title = sectionTitle(item);
    if (title === null || sections.length >= 40) return null;
    sections.push(title);
  }
  const rawTarget = own(parsed, 'targetCharacters') ? parsed.targetCharacters : null;
  if (!Number.isSafeInteger(rawTarget) || rawTarget <= 0) return null;
  // The floor is OURS and the ceiling is OURS: the plan's number is clamped into the range this
  // orchestrator can act on, so a plan cannot name a target that contradicts the owner's requirement
  // and cannot name one no budget could reach.
  const targetChars = Math.min(Math.max(rawTarget, ORCHESTRATION_TARGET_CHARS), ORCHESTRATION_MAX_TARGET_CHARS);
  const rawRequired = own(parsed, 'required') ? parsed.required : null;
  if (rawRequired === null || typeof rawRequired !== 'object' || Array.isArray(rawRequired)) return null;
  // The plan DECLARES three elements; the other two checks are the owner's and this module's:
  // `volume` is the owner's ten pages and `sections` is the plan's own array, so neither can be
  // switched off by the plan. An absent declaration is refused rather than defaulted to false: a plan
  // that does not say whether tables are required is not a plan the document can be held to.
  const required = { volume: true, sections: true };
  for (const key of DECLARABLE) {
    const value = booleanField(rawRequired[key]);
    if (value === null) return null;
    required[key] = value;
  }
  const summary = boundedText(parsed.summary, 600);
  if (summary === null) return null;
  return Object.freeze({ sections: Object.freeze(sections), targetChars, required: Object.freeze(required), summary });
}

// The list of what a read PROVED missing, in the plan's own terms, so a continuation pass can name it.
// `volume` is measured from the document's own symbols-with-spaces count; the section count from the
// document's heading count; tables from the structure read's table count; conclusions from a heading or
// body keyword; lists from the line-marker heuristic. Nothing else is listed.
export function missingFrom(plan, measured) {
  const missing = [];
  if (measured.chars < plan.targetChars) {
    missing.push(`объём: ${measured.chars} из ${plan.targetChars} знаков (примерно ${Math.ceil(measured.chars / ORCHESTRATION_PAGE_CHARS)} из ${Math.ceil(plan.targetChars / ORCHESTRATION_PAGE_CHARS)} страниц)`);
  }
  if (measured.headings < plan.sections.length) {
    missing.push(`разделов (заголовков): ${measured.headings} из ${plan.sections.length} заявленных`);
  }
  if (plan.required.tables && measured.tables < 1) missing.push('таблиц нет ни одной');
  if (plan.required.lists && !measured.lists) missing.push('списков нет ни одного');
  if (plan.required.conclusions && !measured.conclusions) missing.push('нет раздела с выводами');
  return missing;
}

function composePlanRequest(request, profileInstruction) {
  return [
    'Ниже — задача владельца. Сейчас НУЖЕН ТОЛЬКО ПЛАН, без единого вызова инструмента: документ на этом шаге не изменяется.',
    '',
    'ЗАДАЧА:',
    request,
    '',
    'Верни ровно один JSON-объект с полями:',
    '- "sections": непустой массив заголовков будущих разделов (строки, 4-10 разделов);',
    '- "targetCharacters": целевой объём текста в знаках, не меньше 18000 (примерно 10 страниц);',
    '- "required": объект с булевыми полями "tables", "lists", "conclusions" — что обязательно должно быть в документе;',
    '- "summary": одна короткая строка о структуре документа.',
    'Никаких пояснений вокруг JSON и никаких вызовов инструментов: только план.',
    profileInstruction === null ? '' : `ОГРАНИЧЕНИЯ ЭТОГО РЕЖИМА: ${profileInstruction}`
  ].join('\n');
}

function composeExecuteRequest(request, plan, profileInstruction, missing) {
  const lines = [
    'Ниже — задача владельца и уже утверждённый ПЛАН. Выполни план ЧАСТЯМИ и не пересказывай его: содержимое должно попасть в документ.',
    '',
    'ЗАДАЧА ВЛАДЕЛЬЦА:',
    request,
    '',
    'УТВЕРЖДЁННЫЙ ПЛАН:',
    JSON.stringify(plan),
    ''
  ];
  if (missing.length === 0) {
    lines.push('Это ПЕРВЫЙ проход:',
      '- за один проход добавляй примерно 3000-5000 знаков текста, а не весь документ сразу;',
      '- начинай с первых разделов плана и не останавливайся, пока проход не даст этот объём;',
      '- заголовки разделов добавляй тем же инструментом, что и абзацы.');
  } else {
    lines.push('ПРЕДЫДУЩИЙ ПРОХОД НЕ ВЫПОЛНИЛ ПЛАН. Проверка самого документа показала, чего не хватает:',
      ...missing.map(item => `- ${item}`),
      '',
      'Добавь в документ ровно это, ничего не удаляя и не переписывая уже добавленное:',
      '- за один проход добавляй примерно 3000-5000 знаков текста;',
      '- не заканчивай ответ, пока не добавлено недостающее из списка выше.');
  }
  // The tools this pass is allowed to use, NAMED: the bulk profile keeps exactly these, and a pass that
  // reaches for a position-dependent tool it cannot use would end the run instead of adding text.
  lines.push('', 'Инструменты этого прохода: insert_blocks (абзацы и заголовки), insert_table (таблицы), format_range (оформление), read_structure и read_document_text (чтение).');
  if (profileInstruction !== null) lines.push('', `ОГРАНИЧЕНИЯ ЭТОГО РЕЖИМА: ${profileInstruction}`);
  return lines.join('\n');
}

function safeActions(value) {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value.map(action => Object.freeze({ tool: typeof action?.tool === 'string' ? action.tool : 'unknown',
    outcome: typeof action?.outcome === 'string' ? action.outcome : 'unknown',
    ...(typeof action?.code === 'string' ? { code: action.code } : {}) })));
}
// The action that made the pass uncertain, or null. The runtime stops a run fail-safe with `UNCERTAIN`
// and the panel's own transport failures carry the class directly, so both are checked by MEMBERSHIP in
// the closed vocabulary and never by a truthy flag.
export function uncertaintyOf(result) {
  // THE LOOP, NOT A METHOD CALL, and the reason is mechanical: the authored-code audit walks the BUILT
  // bundle and reports a method call whose callee is reached through an optionally-chained property read
  // (`result?.actions`) as DYNAMIC_PROPERTY. Reading the array with a `for...of` over the ordinary
  // property and calling no method on it keeps the same rule — one pass, first uncertain action wins —
  // while leaving nothing the bundle audit has to guess about. The FIRST match is preserved exactly: the
  // loop returns on the first `uncertain` outcome, in the runtime's own action order.
  for (const action of result.actions ?? []) {
    if (action?.outcome !== 'uncertain') continue;
    return Object.freeze({ tool: typeof action.tool === 'string' ? action.tool : 'unknown',
      code: typeof action.code === 'string' ? action.code : 'TOOL_UNCERTAIN' });
  }
  if (result?.error === 'TOOL_UNCERTAIN' || result?.status === 'UNCERTAIN') {
    return Object.freeze({ tool: 'unknown', code: 'TOOL_UNCERTAIN' });
  }
  return null;
}

// The pass outcome the controller reports for an execute pass that was PREVIEW_READY: the model asked
// for the selection replacement the panel publishes as a Preview. The write stays with the user, so the
// orchestration stops rather than executing a second pass over an unpublishable proposal.
function proposalStopped(result) { return result?.status === 'PREVIEW_READY'; }

function resultOf(phase, fields) {
  return Object.freeze({ phase, plan: null, passes: 0, verified: null, missing: Object.freeze([]),
    missingTools: Object.freeze([]), uncertainty: null, planCalledTools: false, ...fields });
}

// The long-generation trigger. Deliberately NARROW: it fires only on a request that names a volume,
// several parts or an explicit count, so an ordinary question or edit keeps the existing single-run
// path unchanged. The patterns are Russian (the product's own language) and case-insensitive.
const LONG_MARKERS = Object.freeze([
  /страниц/i, /страницы/i, /страницу/i,
  /глав(?:а|ы|у|е|ой|)/i,
  /раздел(?:ы|ов|а|е|)/i,
  /\b\d{3,}\s*(?:знак|символ|char)/i,
  /нескольк(?:о|их)\s+(?:таблиц|разделов|глав|списков)/i,
  /структурированн/i
]);
export function isLongGenerationRequest(request) {
  if (typeof request !== 'string') return false;
  const text = request.trim();
  // A short request cannot carry a long-generation instruction; the byte bound is the controller's own
  // user-input bound, applied here so the trigger is decided by the same number the request is held to.
  if (text === '' || text.length > 1200) return false;
  return LONG_MARKERS.some(pattern => pattern.test(text));
}

// The structure read's own heading texts plus the bounded body probe decide the list and conclusion
// flags; the volume comes from the document's symbols-with-spaces count. This function is DELIBERATELY
// pure: the controller performs the two bridge reads and hands their decoded results here, so the
// decision rule is unit-testable without a bridge at all.
export function measuredFrom({ statistics, counts, headings, text, totalChars } = {}) {
  const symbols = statistics?.SymbolsWSCount;
  const body = typeof text === 'string' ? text : '';
  const titles = Array.isArray(headings) ? headings : [];
  const titled = titles.map(entry => (typeof entry === 'string' ? entry : typeof entry?.text === 'string' ? entry.text : '')).join('\n').toLowerCase();
  return Object.freeze({
    // The character count is the DOCUMENT's own statistic when the structure read answered it, and the
    // decoded text's own length otherwise. A count no read established is never invented as zero.
    chars: Number.isSafeInteger(symbols) && symbols >= 0 ? symbols : (typeof totalChars === 'number' ? totalChars : body.length),
    // Paragraphs and headings are reported, not checked against the plan: the plan's granularity is
    // sections, and a section may be one paragraph or several. The count travels because the owner's
    // request was about a document's SHAPE, and the panel reports what the read measured.
    paragraphs: Number.isSafeInteger(statistics?.ParagraphCount) && statistics.ParagraphCount >= 0 ? statistics.ParagraphCount
      : (Number.isSafeInteger(counts?.paragraphs) ? counts.paragraphs : 0),
    headings: Number.isSafeInteger(counts?.headings) ? counts.headings : titles.length,
    tables: Number.isSafeInteger(counts?.tables) ? counts.tables : 0,
    lists: LIST_MARKER.test(body),
    conclusions: CONCLUSION_WORDS.some(word => titled.includes(word) || body.toLowerCase().includes(word))
  });
}

// THE VERIFICATION READ ITSELF. Two bridge reads, both of them the SAME public entry points the
// `read_structure` and `read_document_text` tools dispatch (no registry, no model step, no invented
// primitive): the structure read supplies pages, the measured statistics and the counts, the text read
// supplies the document's own character total and one bounded sample of its body for the list and
// conclusion checks. A refusal from either read is reported as a missing measurement — `ok:false` with
// the closed class — never as a zero.
export function createDocumentReader({ readStructure, readDocumentText, probeChars = ORCHESTRATION_TEXT_PROBE_CHARS, maxHeadings = ORCHESTRATION_MAX_HEADINGS } = {}) {
  return async function readDocumentState() {
    if (typeof readStructure !== 'function' || typeof readDocumentText !== 'function') {
      return Object.freeze({ ok: false, error: 'CAPABILITY_UNAVAILABLE' });
    }
    let structure;
    try { structure = await readStructure({ maxHeadings }); }
    catch { return Object.freeze({ ok: false, error: 'EDITOR_ERROR' }); }
    if (!structure || structure.ok !== true) return Object.freeze({ ok: false, error: typeof structure?.code === 'string' ? structure.code : 'EDITOR_ERROR' });
    let text;
    try { text = await readDocumentText({ offset: 0, maxChars: probeChars }); }
    catch { text = null; }
    const body = text && text.ok === true && typeof text.text === 'string' ? text.text : '';
    const totalChars = text && text.ok === true && Number.isSafeInteger(text.totalChars) ? text.totalChars : null;
    return Object.freeze({ ok: true, measured: measuredFrom({ statistics: structure.statistics, counts: structure.counts,
      headings: structure.headings, text: body, totalChars }) });
  };
}

export function createOrchestrator({ runPass, readDocument, emit = () => {}, profileInstruction = () => null } = {}) {
  // THE STATE MACHINE. `planning` -> `executing` -> `verifying` -> (`continuing` -> `executing` ...) ->
  // `complete` | `incomplete` | `uncertain` | `blocked`. Every transition is decided by a MEASUREMENT or
  // by a closed pass outcome, never by the model's own claim that it finished.
  async function run(request) {
    let plan = null; let passes = 0; let verified = null; let missing = Object.freeze([]);
    let missingTools = Object.freeze([]); let uncertainty = null; let planCalledTools = false;
    const publish = phase => emit(Object.freeze({ phase, passes, targetChars: ORCHESTRATION_TARGET_CHARS,
      plan, verified, missing, missingTools, uncertainty }));
    const stop = (phase, extra = {}) => resultOf(phase, { plan, passes, verified, missing, missingTools, uncertainty, planCalledTools, ...extra });
    // The registry's own contract: an ABSENT profile is `undefined` and answers null, while a name it does
    // not declare is a refusal. The plan pass therefore names no profile at all rather than passing null.
    const instructionFor = profile => profileInstruction(profile ?? undefined);

    // PLAN. One ordinary agent request whose text forbids tool calls; the answer is the plan.
    publish('planning');
    const planPass = await runPass({ kind: 'plan', text: composePlanRequest(request, instructionFor(null)), profile: undefined, pass: 0 });
    if (!planPass || planPass.ok !== true) {
      // A cancelled/failed plan pass never starts execution: a plan is what makes an execute pass
      // bounded, and running without one is the behaviour this orchestration exists to replace.
      return stop('blocked', { error: planPass?.error ?? 'INTERNAL_ERROR' });
    }
    // A plan pass that called tools anyway is REPORTED, not hidden: the plan text is still the plan.
    planCalledTools = Array.isArray(planPass.actions) ? planPass.actions.length > 0 : false;
    plan = parsePlan(planPass.message);
    if (plan === null) return stop('incomplete', { error: 'PLAN_UNUSABLE' });

    let budget = ORCHESTRATION_MAX_EXECUTE_PASSES;
    while (budget > 0) {
      budget -= 1; passes += 1;
      publish('executing');
      const pass = await runPass({ kind: 'execute', text: composeExecuteRequest(request, plan, instructionFor('bulk'), missing), profile: 'bulk', pass: passes });
      if (!pass || pass.ok !== true) {
        // An infrastructure failure (ownership lost, editor busy, cancelled, a classified transport
        // error) stops the orchestration where it stands. No pass is retried and the volume already
        // added stays in the document.
        return stop('blocked', { error: pass?.error ?? 'INTERNAL_ERROR' });
      }
      publish('verifying');
      // THE ONLY PLACE `TOOL_UNCERTAIN` IS HANDLED, and it is handled by STOPPING. An uncertain write
      // means the document's own state is unknown: the orchestration keeps it as it is, reports which
      // action is unverified and starts NO further pass. The runtime already holds the write slot.
      uncertainty = uncertaintyOf(pass);
      if (uncertainty !== null) {
        missingTools = Object.freeze([uncertainty.tool]);
        return stop('uncertain', { error: 'TOOL_UNCERTAIN' });
      }
      if (proposalStopped(pass)) {
        // A confirm-policy proposal can only END a run and the panel publishes it as a Preview; the user
        // owns that write, so no further pass is started over it.
        return stop('incomplete', { error: 'PREVIEW_READY' });
      }
      const measured = await readDocument();
      if (!measured || measured.ok !== true) return stop('blocked', { error: measured?.error ?? 'READ_UNAVAILABLE' });
      verified = Object.freeze({ ...measured.measured });
      missing = Object.freeze(missingFrom(plan, verified));
      if (missing.length === 0) return stop('complete');
      publish('continuing');
    }
    return stop('incomplete', { error: 'PASS_BUDGET_EXHAUSTED' });
  }
  return Object.freeze({ run });
}
