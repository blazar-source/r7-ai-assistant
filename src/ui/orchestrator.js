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
// THE PASS CAP. The cheapest useful pass appends a bounded batch of blocks; TWELVE passes is what the
// owner's measured ten-page request needs: three native runs each reached six passes and still fell short
// of 18 000 characters, so the cap that ended runs 1 and 2 was the volume's main ceiling. The cap stays a
// NAMED number (never an inlined literal) so the honest report can say exactly how many passes were spent
// when the criteria are still unmet.
export const ORCHESTRATION_MAX_EXECUTE_PASSES = 12;
// The plan is authored data bounded before it is reused in a request: a slice, never a rewrite, so the
// plan the model wrote is the plan the execute passes receive.
export const ORCHESTRATION_PLAN_BYTES = 8192;
// The most sections a plan may name, and the most tables a plan may make mandatory. Both are bounds on
// MODEL-RAISED requirements: they keep a plan from turning a bounded task into an unreachable one, the
// same reason the volume has a ceiling.
export const ORCHESTRATION_PLAN_SECTIONS_MAX = 40;
export const ORCHESTRATION_MAX_PLAN_TABLES = 20;
// One bounded read serves the volume floor, the list and the conclusion check without a second read.
export const ORCHESTRATION_TEXT_PROBE_CHARS = 2000;
// The most headings the orchestrator asks for: the same cap the `read_structure` tool advertises, so
// the read is an ordinary supported request rather than an invented one.
export const ORCHESTRATION_MAX_HEADINGS = LIMITS.structureHeadingsMax;
// The elements this orchestrator can honestly verify from a read. `volume` and `sections` are CHECKED
// but never DECLARED by the plan alone: the volume is the owner's own requirement (the plan's
// `targetCharacters` can only move its floor up) and the section count is the plan's own array. The three
// declared elements fall back to the request floor when the answer does not establish them.
// (The named list itself is declared with the plan parser below.)
// A line beginning with a bullet or an ordinal marker, at any indent. The one list signal a bounded
// text read can decide on (a character count cannot tell a list from a paragraph). It is a heuristic
// and it is NAMED as one in the section comments below: it is used only where the volume and the
// section count already agreed, so a false negative can ask for one more pass but can never declare a
// short document complete.
const LIST_MARKER = /^[ \t]*(?:[•·▪◦‣∙–—]|[-*+])[ \t]+\S|\d{1,2}[.)][ \t]+\S/m;
const CONCLUSION_WORDS = Object.freeze(['вывод', 'заключени', 'итог', 'conclusion', 'summary']);
// THE REQUEST ITSELF AS A FLOOR, so no plan can lower what the owner asked for. The markers are the
// product's own language and they are matched case-insensitively against the request text:
//   tables      — the request names a table (таблиц/таблица/таблицу)                      -> 2 tables;
//   conclusions — the request names conclusions or a summary                              -> required;
//   volume      — the request names pages or a large volume (10 страниц, ~10 страниц,
//                 крупный/большой объём, N знаков)                                        -> 18 000 characters;
//   sections    — the request names numbered parts (1) … 2) …) or a COUNT of its parts
//                 ("5 разделов")                                                           -> that many headings,
//                 and a bare plural chapter/section mention ("несколько глав")            -> at least 2.
// A SHORT page count ("на 3 страницы") still asks for a volume, and the un-lowerable product target is
// the same one the plan may raise. This function is DELIBERATELY pure so the derivation is unit-testable
// without a request.
const FLOOR_TABLE_MARKER = /таблиц|таблица|таблицу/i;
const FLOOR_CONCLUSION_MARKER = /вывод|заключени|итог/i;
const FLOOR_VOLUME_MARKER = /страниц|крупн\w*\s+объ[её]м|больш\w*\s+объ[её]м|\b\d{3,}\s*(?:знак|символ)/i;
const FLOOR_SECTIONS_MARKER = /глав[аыуеой]|раздел(?:ы|ов|а|е)/i;
// The most sections a COUNT may derive: the plan's own bound, so a request that lists forty numbered
// parts is honoured and one that lists a hundred is capped rather than turned into a task no budget could
// reach.
const FLOOR_SECTIONS_MAX = ORCHESTRATION_PLAN_SECTIONS_MAX;
// The floor's own table demand: the owner's request asks for tables in the PLURAL, and two is the
// smallest plural.
const FLOOR_TABLES = 2;
// A numbered part of a request: "1) … 2) … 3) …". The delimiter is REQUIRED, so "2.5 мм" is not a part;
// the lookbehind keeps the delimiter out of the match so the FIRST item is found at the start of a line.
const FLOOR_ORDINAL = /(?:^|(?<=[\s(]))(\d{1,2})\s*[).]\s*([^)\d\n][^\n]*?)(?=\s+\d{1,2}\s*[).]|$)/g;
// A COUNT of parts the request names: "добавь 5 разделов", "три главы". The count is the FLOOR's own
// requirement, which is exactly what the owner asked for.
const FLOOR_COUNT = /(?:^|\s)(\d{1,2})\s+(?:раздел|глав)/i;
const FLOOR_WORDS = Object.freeze([[10, /(?:^|\s)десят/], [9, /(?:^|\s)девят/], [8, /(?:^|\s)восем/],
  [7, /(?:^|\s)сем/], [6, /(?:^|\s)шест/], [5, /(?:^|\s)пят/], [4, /(?:^|\s)четыр/], [3, /(?:^|\s)[тт]р[иё]|(?:^|\s)трёх/]]);
// The canonical floor, applied by `parsePlan` when no request is at hand (a unit test, or any caller
// that only wants the plan validated): it matches the owner's measured ten-page request — two tables, a
// conclusion and the un-lowerable 18 000 characters — so even a plan parsed alone cannot lower them.
const FLOOR_CANONICAL = Object.freeze({ targetChars: ORCHESTRATION_TARGET_CHARS, tables: FLOOR_TABLES, conclusions: true, sections: null });
// A FIXED, PARSEABLE KEY SHAPE the plan pass prescribes and the panel reads defensively. The keys are
// Cyrillic and the values are bounded before they are used; a line the shape does not cover is ignored.
const KEY_FIELD = /^\s*(РАЗДЕЛЫ|ОБЪЁМ|ТАБЛИЦЫ|ЗАКЛЮЧЕНИЕ)\s*:\s*(\S[^\n]*)$/im;
// The numbered parts of the KEY SHAPE's own section line: "1) Введение 2) Глава 1".
const KEY_SECTION = /(?:^|(?<=[\s(]))(\d{1,2})\s*[).]\s*([^)\d\n][^\n]*?)(?=\s+\d{1,2}\s*[).]|$)/g;
// `parseInt` reads a DECIMAL number out of a value that may carry units or trailing text, and it answers
// only an in-range integer: an empty, negative or absurd value is discarded rather than clamped.
function intOrNull(value) {
  const number = parseInt(value, 10);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}
// The heading count the REQUEST itself asks for, or null when it asks for none. The numbered parts win
// over the weaker signals: "1) … 2) … 3)" is an explicit count of three, and a plural chapter word then
// adds nothing on top of it.
function sectionsFrom(text) {
  let highest = 0;
  let count = 0;
  FLOOR_ORDINAL.lastIndex = 0;
  for (let match = FLOOR_ORDINAL.exec(text); match !== null && count < FLOOR_SECTIONS_MAX; match = FLOOR_ORDINAL.exec(text)) {
    highest = Math.max(highest, Number(match[1]));
    count += 1;
  }
  if (count > 0) return Math.min(highest, FLOOR_SECTIONS_MAX);
  const digits = FLOOR_COUNT.exec(text);
  if (digits !== null) return Math.min(Number(digits[1]), FLOOR_SECTIONS_MAX);
  for (const [number, pattern] of FLOOR_WORDS) {
    if (pattern.test(text)) return number;
  }
  // A plural chapter/section mention with no count is the weakest signal and the smallest plural answer.
  return FLOOR_SECTIONS_MARKER.test(text) ? 2 : null;
}
// The owner's request as a floor over the criteria. An absent demand is the number ZERO (or false), which
// `criteriaFrom` takes the maximum of — never a silent requirement invented for a request that made none.
export function floorFrom(request) {
  const text = typeof request === 'string' ? request : '';
  const tables = FLOOR_TABLE_MARKER.test(text) ? FLOOR_TABLES : 0;
  const conclusions = FLOOR_CONCLUSION_MARKER.test(text);
  const targetChars = FLOOR_VOLUME_MARKER.test(text) ? ORCHESTRATION_TARGET_CHARS : 0;
  return Object.freeze({ targetChars, tables, conclusions, sections: sectionsFrom(text) });
}

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

// The three elements the PLAN may declare; the other two checks are the owner's and this module's:
// `volume` and `sections` can never be switched off by the plan.
const DECLARABLE = Object.freeze(['tables', 'lists', 'conclusions']);

// ONE FIELD OF THE FIXED KEY SHAPE, read defensively: the label is matched at the start of a line and the
// value is everything to the end of that line. An absent key answers null, which every caller resolves
// with `?? floor`, so a missing or malformed key can never become a zero requirement.
function keyField(message, label) {
  const match = message.match(new RegExp(`^\\s*${label}\\s*:\\s*(\\S[^\\n]*)$`, 'im'));
  return match === null ? null : match[1].trim();
}
// The sections of the key shape: "1) Введение 2) …" is parsed into titles, and the titles are bounded
// exactly like the JSON shape's so both spellings of a plan arrive identical.
function keySections(value) {
  if (value === null) return null;
  const sections = [];
  KEY_SECTION.lastIndex = 0;
  for (let match = KEY_SECTION.exec(value); match !== null && sections.length < ORCHESTRATION_PLAN_SECTIONS_MAX; match = KEY_SECTION.exec(value)) {
    const title = boundedText(match[2], 200);
    if (title === null) return null;
    sections.push(title);
  }
  return sections.length === 0 ? null : sections;
}
// The volume the PLAN asks for, bounded exactly as the JSON shape bounds it: a value it cannot establish
// falls back to the canonical 18 000 floor, and one above the ceiling is clamped to it.
function planVolume(value) {
  const volume = value === null ? null : intOrNull(value);
  return Math.min(volume === null || volume === 0 ? ORCHESTRATION_TARGET_CHARS : volume, ORCHESTRATION_MAX_TARGET_CHARS);
}
// The key shape's own plan. `floor` is NOT consumed here on purpose: a key the answer cannot establish is
// left UNDECLARED and `criteriaFrom` resolves it against the floor, so the fallback has exactly one home.
function planFromKeys(message, floor) {
  const sections = keySections(keyField(message, 'РАЗДЕЛЫ'));
  if (sections === null) return null;
  const targetChars = planVolume(keyField(message, 'ОБЪЁМ'));
  const tableValue = keyField(message, 'ТАБЛИЦЫ');
  const tables = tableValue === null ? null : intOrNull(tableValue);
  // A count the plan established at one or more makes tables mandatory, and the COUNT ITSELF travels so
  // the plan may raise the owner's two. An absent or unparseable count is undeclared, and the request
  // floor then supplies the requirement instead.
  const required = { volume: true, sections: true, tables: tables !== null && tables >= 1, lists: false,
    conclusions: (keyField(message, 'ЗАКЛЮЧЕНИЕ') ?? '').toLowerCase().startsWith('да') };
  return Object.freeze({ sections: Object.freeze(sections), targetChars, required: Object.freeze(required),
    requiredTables: tables, summary: '' });
}
// Returns the validated plan, or null when the answer is not a plan. `null` is the ONLY failure mode:
// the caller stops with an honest report rather than inventing a plan from an unparsable answer. BOTH
// spellings of the fixed contract are accepted — the panel's own JSON shape and the key shape the plan
// pass prescribes — and in both, a DECLARATION the answer cannot establish falls back to the REQUEST
// FLOOR rather than to false, so a modest answer can never lower the owner's demand.
export function parsePlan(message, floor = FLOOR_CANONICAL) {
  if (typeof message !== 'string' || message.trim() === '') return null;
  // The plan is BOUNDED before it is parsed: a slice of a huge answer would be a plan nobody wrote, so
  // an answer above the named byte bound is refused whole rather than trimmed into something executable.
  if (utf8ByteLength(message) > ORCHESTRATION_PLAN_BYTES) return null;
  // THE KEY SHAPE first: its own marker is enough to tell it from JSON, and a marker with unparseable
  // sections is an unusable answer rather than a fallback (the plan's own section list IS the plan).
  if (firstKeyLabel(message) !== null) return planFromKeys(message, floor);
  let parsed;
  try { parsed = JSON.parse(message); } catch { return null; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const rawSections = own(parsed, 'sections') ? parsed.sections : null;
  if (!Array.isArray(rawSections) || rawSections.length === 0 || rawSections.length > ORCHESTRATION_PLAN_SECTIONS_MAX) return null;
  const sections = [];
  for (const item of rawSections) {
    const title = sectionTitle(item);
    if (title === null || sections.length >= ORCHESTRATION_PLAN_SECTIONS_MAX) return null;
    sections.push(title);
  }
  // An absent volume takes the canonical floor; a PRESENT but unusable one is not a plan. The result is
  // clamped into the range this orchestrator can act on, so a plan cannot name a target that contradicts
  // the owner's requirement and cannot name one no budget could reach.
  const rawTarget = own(parsed, 'targetCharacters') ? parsed.targetCharacters : null;
  if (rawTarget !== null && (!Number.isSafeInteger(rawTarget) || rawTarget <= 0)) return null;
  const targetChars = Math.min(Math.max(rawTarget ?? ORCHESTRATION_TARGET_CHARS, ORCHESTRATION_TARGET_CHARS), ORCHESTRATION_MAX_TARGET_CHARS);
  const rawRequired = own(parsed, 'required') && parsed.required !== null && typeof parsed.required === 'object' && !Array.isArray(parsed.required)
    ? parsed.required : null;
  const required = { volume: true, sections: true };
  for (const key of DECLARABLE) {
    // The declaration wins when it is a real boolean; anything else — an absent key, a string like "да",
    // a number — is UNESTABLISHED and the request floor's own answer stands in its place.
    const declared = rawRequired === null ? null : booleanField(rawRequired[key]);
    required[key] = declared ?? (key === 'conclusions' ? floor.conclusions : false);
  }
  const summary = boundedText(parsed.summary, 600);
  if (summary === null) return null;
  // The JSON shape declares tables as a BOOLEAN, so the count it stands for is the plural floor; the key
  // shape may name an exact count instead and that count is carried through as `requiredTables`.
  return Object.freeze({ sections: Object.freeze(sections), targetChars, required: Object.freeze(required),
    requiredTables: null, summary });
}
// The first label of the key shape that appears in the answer, or null when the answer is not spelled in
// that shape at all (in which case it is parsed as JSON).
function firstKeyLabel(message) {
  const lookup = message.match(KEY_FIELD);
  return lookup === null ? null : lookup[1];
}

// What "the plan declares tables" is worth as a NUMBER: two is the smallest plural, and the same number
// the owner's own request derives, so a boolean declaration and a "ТАБЛИЦЫ: 2" line mean the same thing.
const DECLARED_TABLES = FLOOR_TABLES;
// THE CRITERIA — the numbers the document is held to after every pass. They are the MAXIMUM of the
// request-derived FLOOR and the plan's own numbers, so a modest plan cannot reduce the owner's demand and
// a plan MAY raise it (the volume keeps its existing ceiling, and the table count its own bound).
export function criteriaFrom(floor, plan) {
  const requested = plan === null ? 0 : plan.targetChars;
  const targetChars = Math.min(Math.max(floor.targetChars, requested), ORCHESTRATION_MAX_TARGET_CHARS);
  const declared = plan !== null && plan.required.tables === true ? DECLARED_TABLES : 0;
  const exact = plan === null || !Number.isSafeInteger(plan.requiredTables) ? 0 : plan.requiredTables;
  const tables = Math.min(Math.max(floor.tables, declared, exact), ORCHESTRATION_MAX_PLAN_TABLES);
  // A heading criterion exists only when the owner named sections: the floor is `null` otherwise, and a
  // plan that names no sections of its own then leaves the heading check off rather than failing forever.
  const sections = floor.sections === null ? plan.sections.length : Math.min(Math.max(floor.sections, plan.sections.length), ORCHESTRATION_PLAN_SECTIONS_MAX);
  return Object.freeze({ targetChars, tables, lists: plan !== null && plan.required.lists === true,
    sections, conclusions: floor.conclusions || plan.required.conclusions === true });
}

// THE MISSING LIST, composed as EXPLICIT UNMET CRITERIA. Every criterion the run is held to — the volume
// in characters, the heading count, the table count, the lists and the conclusion — is compared against
// what the read MEASURED, and each unmet one is named with both of its own numbers ("таблиц 1 из 2",
// "знаков 12 400 из 18 000", "заключения нет"). `volume` is the document's own symbols-with-spaces count;
// the heading count is the structure read's own; tables are the structure read's table count; conclusions
// are a heading or body keyword; lists are the line-marker heuristic. Nothing else is listed.
export function missingFrom(criteria, measured) {
  const missing = [];
  if (measured.chars < criteria.targetChars) {
    missing.push(`объём: ${measured.chars} из ${criteria.targetChars} знаков (примерно ${Math.ceil(measured.chars / ORCHESTRATION_PAGE_CHARS)} из ${Math.ceil(criteria.targetChars / ORCHESTRATION_PAGE_CHARS)} страниц)`);
  }
  if (measured.headings < criteria.sections) {
    missing.push(`разделов (заголовков): ${measured.headings} из ${criteria.sections} заявленных`);
  }
  // Every element names its own numbers against the CRITERION, so the list says what is unmet and how far
  // off it is — "таблиц 1 из 2" — rather than only that something is absent.
  if (criteria.tables > 0 && measured.tables < criteria.tables) {
    missing.push(measured.tables === 0 ? 'таблиц нет ни одной' : `таблиц ${measured.tables} из ${criteria.tables}`);
  }
  if (criteria.lists && !measured.lists) missing.push('списков нет ни одного');
  if (criteria.conclusions && !measured.conclusions) missing.push('заключения нет');
  return missing;
}

// THE CRITERIA AS ONE LINE, for the execute request: the model is told the same numbers the verify will
// hold it to, so a pass cannot be surprised by a criterion the panel never stated.
function criteriaText(criteria) {
  return ['знаков — ' + criteria.targetChars, 'заголовков — ' + criteria.sections, 'таблиц — ' + criteria.tables,
    'списки — ' + (criteria.lists ? 'да' : 'нет'), 'заключение — ' + (criteria.conclusions ? 'да' : 'нет')].join('; ');
}
// THE FIXED, PARSEABLE KEY SHAPE the plan pass must answer in, with the request-derived floor as its
// own named numbers: "РАЗДЕЛЫ: 1) … 2) …" / "ОБЪЁМ: 18000" / "ТАБЛИЦЫ: 2" / "ЗАКЛЮЧЕНИЕ: да". The same
// numbers are also accepted as the panel's own JSON object, so both spellings of the contract work.
function planFormatLines(floor) {
  return [
    `РАЗДЕЛЫ: 1) … 2) … (заголовки будущих разделов, от ${floor.sections === null ? 4 : floor.sections} до 10)`,
    `ОБЪЁМ: ${Math.max(floor.targetChars, ORCHESTRATION_TARGET_CHARS)}`,
    `ТАБЛИЦЫ: ${floor.tables}`,
    `ЗАКЛЮЧЕНИЕ: ${floor.conclusions ? 'да' : 'нет'}`
  ];
}
function composePlanRequest(request, profileInstruction, floor) {
  return [
    'Ниже — задача владельца. Сейчас НУЖЕН ТОЛЬКО ПЛАН, без единого вызова инструмента: документ на этом шаге не изменяется.',
    '',
    'ЗАДАЧА:',
    request,
    '',
    'Верни план ровно в таком виде — эти четыре строки и есть проверяемые критерии, ниже них опускаться нельзя:',
    ...planFormatLines(floor),
    '',
    'Дополнительно можно вернуть ровно один JSON-объект с полями:',
    '- "sections": непустой массив заголовков будущих разделов (строки, 4-10 разделов);',
    '- "targetCharacters": целевой объём текста в знаках, не меньше 18000 (примерно 10 страниц);',
    '- "required": объект с булевыми полями "tables", "lists", "conclusions" — что обязательно должно быть в документе;',
    '- "summary": одна короткая строка о структуре документа.',
    'Никаких пояснений вокруг плана и никаких вызовов инструментов: только план.',
    profileInstruction === null ? '' : `ОГРАНИЧЕНИЯ ЭТОГО РЕЖИМА: ${profileInstruction}`
  ].join('\n');
}

function composeExecuteRequest(request, plan, profileInstruction, missing, criteria) {
  const lines = [
    'Ниже — задача владельца и уже утверждённый ПЛАН. Выполни план ЧАСТЯМИ и не пересказывай его: содержимое должно попасть в документ.',
    '',
    'ЗАДАЧА ВЛАДЕЛЬЦА:',
    request,
    '',
    'КРИТЕРИИ ПРИЁМКИ (проверяются по самому документу после каждого прохода):',
    criteriaText(criteria),
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
  return Object.freeze({ phase, plan: null, passes: 0, verified: null, criteria: null, floor: null,
    missing: Object.freeze([]), missingTools: Object.freeze([]), uncertainty: null, planCalledTools: false, ...fields });
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
    // THE FLOOR IS DERIVED FROM THE OWNER'S REQUEST BEFORE ANYTHING ELSE HAPPENS, and the criteria are the
    // maximum of that floor and the plan's own numbers. Both are carried from the first publication to the
    // final report, so the panel and a native check can read exactly what was required — and a plan pass
    // that never answers leaves the floor standing rather than a zero.
    const floor = floorFrom(request);
    let criteria = null;
    const publish = phase => emit(Object.freeze({ phase, passes, targetChars: criteria === null ? floor.targetChars : criteria.targetChars,
      floor, criteria, plan, verified, missing, missingTools, uncertainty }));
    const stop = (phase, extra = {}) => resultOf(phase, { plan, passes, verified, criteria, floor, missing, missingTools, uncertainty, planCalledTools, ...extra });
    // The registry's own contract: an ABSENT profile is `undefined` and answers null, while a name it does
    // not declare is a refusal. The plan pass therefore names no profile at all rather than passing null.
    const instructionFor = profile => profileInstruction(profile ?? undefined);

    // PLAN. One ordinary agent request whose text forbids tool calls and PRESCRIBES the fixed key shape
    // with the derived floor as its own numbers; the answer is the plan.
    publish('planning');
    const planPass = await runPass({ kind: 'plan', text: composePlanRequest(request, instructionFor(null), floor), profile: undefined, pass: 0 });
    if (!planPass || planPass.ok !== true) {
      // A cancelled/failed plan pass never starts execution: a plan is what makes an execute pass
      // bounded, and running without one is the behaviour this orchestration exists to replace.
      return stop('blocked', { error: planPass?.error ?? 'INTERNAL_ERROR' });
    }
    // A plan pass that called tools anyway is REPORTED, not hidden: the plan text is still the plan.
    planCalledTools = Array.isArray(planPass.actions) ? planPass.actions.length > 0 : false;
    plan = parsePlan(planPass.message, floor);
    if (plan === null) return stop('incomplete', { error: 'PLAN_UNUSABLE' });
    criteria = criteriaFrom(floor, plan);

    let budget = ORCHESTRATION_MAX_EXECUTE_PASSES;
    while (budget > 0) {
      budget -= 1; passes += 1;
      publish('executing');
      const pass = await runPass({ kind: 'execute', text: composeExecuteRequest(request, plan, instructionFor('bulk'), missing, criteria), profile: 'bulk', pass: passes });
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
      // THE VERIFY IS AGAINST THE CRITERIA, never against a status and never against a model claim: the
      // pass ends COMPLETE only when every criterion is met by the document's own measurements. Any single
      // unmet criterion puts its own numbers into the missing list the next pass receives.
      missing = Object.freeze(missingFrom(criteria, verified));
      if (missing.length === 0) return stop('complete');
      publish('continuing');
    }
    return stop('incomplete', { error: 'PASS_BUDGET_EXHAUSTED' });
  }
  return Object.freeze({ run });
}
