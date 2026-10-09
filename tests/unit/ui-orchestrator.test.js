import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrchestrator, createDocumentReader, parsePlan, floorFrom, criteriaFrom, missingFrom, measuredFrom,
  isLongGenerationRequest, uncertaintyOf, ORCHESTRATION_TARGET_CHARS, ORCHESTRATION_MAX_EXECUTE_PASSES,
  ORCHESTRATION_MAX_TARGET_CHARS, ORCHESTRATION_MAX_PLAN_TABLES, ORCHESTRATION_TEXT_PROBE_CHARS,
  ORCHESTRATION_PLAN_SECTIONS_MAX } from '../../src/ui/orchestrator.js';

// A plan that satisfies the parser's closed contract. `sections` is the only part the verification
// counts against the document's own heading count.
const planJson = (overrides = {}) => JSON.stringify({ sections: ['Введение', 'Глава 1', 'Глава 2', 'Выводы'],
  targetCharacters: 20000, required: { tables: true, lists: true, conclusions: true }, summary: 'структура', ...overrides });
// The SCRIPTED pass runner: one entry per call, so a test can name exactly which pass received which
// request. Each entry is either a result object or a function of the pass.
function scriptedPasses(passes) {
  const seen = [];
  const queue = [...passes];
  return { seen, runPass: async pass => {
    seen.push(pass);
    if (queue.length === 0) throw new Error('unexpected pass');
    const entry = queue.shift();
    return typeof entry === 'function' ? entry(pass) : entry;
  } };
}
// A mutable fake document the VERIFY step reads: the test moves the numbers, the reader reports them.
function fakeDocument(initial) {
  const state = { chars: 0, headings: 0, tables: 0, paragraphs: 0, body: '', ...initial };
  return { state, readDocument: async () => Object.freeze({ ok: true, measured: Object.freeze({
    chars: state.chars, headings: state.headings, tables: state.tables, paragraphs: state.paragraphs,
    lists: /^[ \t]*[•-]\s/m.test(state.body), conclusions: /вывод/i.test(state.body) }) }) };
}
const okPass = (message = planJson(), actions = []) => ({ ok: true, status: 'FINAL', message, actions, steps: 1, toolCalls: 0 });

// The exact criteria format the plan pass's OWN request text prescribes, built here from the numbers so
// every test can say what the criteria are without retyping the authored line. `null` omits the key.
const planKeys = ({ sections = ['Введение', 'Глава 1', 'Глава 2', 'Выводы'], volume = 20000, tables = 2, conclusion = 'да' } = {}) => [
  sections === null ? null : `РАЗДЕЛЫ: ${sections.map((title, index) => `${index + 1}) ${title}`).join(' ')}`,
  volume === null ? null : `ОБЪЁМ: ${volume}`,
  tables === null ? null : `ТАБЛИЦЫ: ${tables}`,
  conclusion === null ? null : `ЗАКЛЮЧЕНИЕ: ${conclusion}`
].filter(line => line !== null).join('\n');
// The request-derived floor for the owner's measured ten-page request: tables, conclusions, ten pages,
// chapters.
const floor = floorFrom('создай структурированный документ примерно на 10 страниц, добавь главы, несколько таблиц, списки, выводы');
// The canonical criteria: this floor raised by the full plan above (20000 characters, 2 tables, 4 sections).
const criteria = criteriaFrom(floor, parsePlan(planJson()));

test('long generation requires creation with an explicit large volume, not ordinary structure or edits', () => {
  assert.equal(isLongGenerationRequest('создай структурированный документ примерно на 10 страниц, добавь главы, несколько таблиц, списки, выводы и оформи его'), true);
  assert.equal(isLongGenerationRequest('добавь 5 разделов о безопасности'), false);
  assert.equal(isLongGenerationRequest('Подготовь структурированную памятку с тремя разделами, двумя вводными абзацами, списком из четырёх шагов и таблицей.'), false);
  assert.equal(isLongGenerationRequest('Создай документ на 3 страницы'), false);
  assert.equal(isLongGenerationRequest('Напиши текст на 500 символов'), false);
  assert.equal(isLongGenerationRequest('Измени срок в разделе «Контроль качества» на 16:30'), false);
  assert.equal(isLongGenerationRequest('Исправь орфографию в документе на 10 страниц'), false);
  assert.equal(isLongGenerationRequest('Подготовь документ на 18000 знаков'), true);
  assert.equal(isLongGenerationRequest('Напиши документ на десять страниц'), true);
  for (const request of [
    'Подготовь краткое резюме документа на 10 страниц в двух абзацах.',
    'Сделай краткую памятку на 500 символов по документу на 10 страниц.',
    'Напиши краткий ответ: в исходном документе 18000 знаков, что улучшить?',
    'Подготовь резюме исходного документа на 10 страниц.',
    'Создай памятку по документу на 10 страниц.'
  ]) assert.equal(isLongGenerationRequest(request), false, request);
  assert.equal(isLongGenerationRequest('исправь орфографию в первом абзаце'), false);
  assert.equal(isLongGenerationRequest('что такое R7?'), false);
  assert.equal(isLongGenerationRequest(''), false);
  assert.equal(isLongGenerationRequest(null), false);
});

test('the plan parser refuses anything that is not a bounded plan and clamps a lower volume target up to the floor', () => {
  assert.equal(parsePlan('не json'), null);
  assert.equal(parsePlan(''), null);
  assert.equal(parsePlan('{}'), null, 'no sections');
  assert.equal(parsePlan(JSON.stringify({ sections: [], targetCharacters: 20000, required: { tables: false, lists: false, conclusions: false }, summary: 's' })), null);
  assert.equal(parsePlan(JSON.stringify({ sections: ['A'], targetCharacters: 0, required: { tables: false, lists: false, conclusions: false }, summary: 's' })), null);
  // A key that is MALFORMED is undeclared, not a refusal: the FLOOR supplies the requirement, so a plan
  // that lists nothing required still cannot lower the owner's demand (the parser has no floor argument,
  // and the canonical floor requires a conclusion).
  const malformed = parsePlan(JSON.stringify({ sections: ['A'], targetCharacters: 20000,
    required: { tables: 'да', lists: 'нет', conclusions: 'ага' }, summary: 's' }));
  assert.equal(malformed.required.tables, false);
  assert.equal(malformed.required.conclusions, true, 'an unparseable declaration falls back to the floor');
  const floor = parsePlan(planJson({ targetCharacters: 1000 }));
  assert.equal(floor.targetChars, ORCHESTRATION_TARGET_CHARS, 'the owner\'s ten pages may not be lowered by a plan');
  const ceiling = parsePlan(planJson({ targetCharacters: 10 ** 9 }));
  assert.equal(ceiling.targetChars, ORCHESTRATION_MAX_TARGET_CHARS);
  const strings = parsePlan(JSON.stringify({ sections: ['A', { title: 'B' }], targetCharacters: 20000,
    required: { tables: false, lists: false, conclusions: false }, summary: 's' }));
  assert.deepEqual(strings.sections, ['A', 'B']);
});

test('the fixed key format is parsed defensively, and a missing or malformed key falls back to the request floor, never below it', () => {
  const ownerFloor = floorFrom('создай документ примерно на 10 страниц с несколькими таблицами и выводами');
  assert.deepEqual(ownerFloor, { targetChars: 18000, tables: 2, conclusions: true, sections: null });
  assert.deepEqual(floorFrom('исправь орфографию в первом абзаце'), { targetChars: 0, tables: 0, conclusions: false, sections: null });
  assert.deepEqual(floorFrom('добавь 5 разделов о безопасности'), { targetChars: 0, tables: 0, conclusions: false, sections: 5 });
  assert.equal(floorFrom('сделай главы и подглавы').sections, 2, 'a plural chapter request is at least two headings');
  assert.equal(floorFrom('создай документ на 10 страниц').targetChars, ORCHESTRATION_TARGET_CHARS);
  assert.equal(floorFrom('создай документ на 3 страницы').targetChars, ORCHESTRATION_TARGET_CHARS, 'a SHORT page count is still a volume request, so the floor holds');
  assert.equal(floorFrom('выведи 1) цели 2) задачи 3) риски 4) выводы').sections, 4, 'the named ordinal list is the count');
  assert.equal(floorFrom('документ с таблицами').tables, 2);
  assert.equal(floorFrom('сделай выводы').conclusions, true);

  // THE FLOOR, the plan's own JSON, and the same plan as the fixed keys — three spellings, one answer.
  assert.deepEqual(parsePlan(planJson()), { sections: ['Введение', 'Глава 1', 'Глава 2', 'Выводы'], targetChars: 20000,
    required: { volume: true, sections: true, tables: true, lists: true, conclusions: true }, requiredTables: null, summary: 'структура' });
  // The same plan spelled as keys: the count the key shape declares is EXACT (two), so both spellings mean
  // the same two tables, and a key that names no count at all is unestablished rather than zero.
  assert.deepEqual(parsePlan(planKeys()), { sections: ['Введение', 'Глава 1', 'Глава 2', 'Выводы'], targetChars: 20000,
    required: { volume: true, sections: true, tables: true, lists: false, conclusions: true }, requiredTables: 2, summary: '' });
  assert.equal(parsePlan(planKeys({ tables: null })).requiredTables, null);
  // A plan MAY raise the volume and is bounded by the existing ceiling; a malformed VOLUME cannot lower it.
  assert.equal(criteriaFrom(ownerFloor, parsePlan(planKeys({ volume: 25000 }))).targetChars, 25000);
  assert.equal(criteriaFrom(ownerFloor, parsePlan(planKeys({ volume: 10 ** 9 }))).targetChars, ORCHESTRATION_MAX_TARGET_CHARS);
  assert.equal(criteriaFrom(ownerFloor, parsePlan(planKeys({ volume: null }))).targetChars, ownerFloor.targetChars, 'the floor is the fallback, never zero');
  assert.equal(criteriaFrom(ownerFloor, parsePlan(planKeys({ volume: 'не число' }))).targetChars, ownerFloor.targetChars);
  assert.equal(criteriaFrom(ownerFloor, parsePlan(planKeys({ tables: null }))).tables, ownerFloor.tables);
  assert.equal(criteriaFrom(ownerFloor, parsePlan(planKeys({ conclusion: null }))).conclusions, true);
  // A key the PLAN raises is honoured; one it cannot establish falls back to the request's own number.
  assert.deepEqual(parsePlan(planKeys({ tables: 5 })).required, { volume: true, sections: true, tables: true, lists: false, conclusions: true });
  assert.equal(criteriaFrom(ownerFloor, parsePlan(planKeys({ tables: 5 }))).tables, 5);
  assert.equal(criteriaFrom(ownerFloor, parsePlan(planKeys({ tables: 'две' }))).tables, ownerFloor.tables, 'an unparseable table count never lowers the owner\'s two tables');
  // A plan whose key shape carries no section line at all is not a plan: the section list IS the plan.
  assert.equal(parsePlan(planKeys({ sections: null })), null);
  // A malformed or unbounded table count falls back to the floor rather than refusing the whole plan.
  assert.equal(criteriaFrom(ownerFloor, parsePlan(planKeys({ tables: 0 }))).tables, ownerFloor.tables);
  assert.equal(criteriaFrom(ownerFloor, parsePlan(planKeys({ tables: 999 }))).tables, ORCHESTRATION_MAX_PLAN_TABLES);
  assert.equal(parsePlan(planKeys({ tables: 999 })).required.tables, true);
  // The plan pass is the ONLY place the plan's own text is free-form; the keys are bounded by the parser.
  assert.equal(parsePlan(planJson({ sections: Array.from({ length: ORCHESTRATION_PLAN_SECTIONS_MAX + 1 }, () => 'A') })), null);
});


test('a plan pass, an execute pass and a verify that confirms the plan ends complete after one pass', async () => {
  const doc = fakeDocument({ chars: 20000, headings: 4, tables: 2, paragraphs: 30, body: 'Выводы\n- первый пункт\n- второй пункт' });
  const scripted = scriptedPasses([okPass(), okPass('готово')]);
  const progress = [];
  const orchestrator = createOrchestrator({ runPass: scripted.runPass, readDocument: doc.readDocument,
    emit: record => progress.push(record) });
  const outcome = await orchestrator.run('создай документ примерно на 10 страниц с несколькими таблицами, главами и выводами');
  assert.equal(outcome.phase, 'complete');
  assert.equal(outcome.passes, 1);
  assert.equal(outcome.plan.sections.length, 4);
  assert.equal(outcome.plan.targetChars, 20000);
  assert.deepEqual(outcome.missing, []);
  assert.deepEqual(outcome.verified, { chars: 20000, headings: 4, tables: 2, paragraphs: 30, lists: true, conclusions: true });
  // The criteria the verify holds the document to are exposed next to the verified numbers.
  assert.deepEqual(outcome.criteria, { targetChars: 20000, tables: 2, lists: true, sections: 4, conclusions: true });
  // The plan pass is FIRST and asks for the plan only; the execute pass carries the plan itself.
  assert.equal(scripted.seen.length, 2);
  assert.equal(scripted.seen[0].kind, 'plan');
  // The plan pass names NO profile (`undefined` is the registry's own "absent"), so the tool list it
  // runs under is the ordinary confirm-free one rather than the bulk view.
  assert.equal(scripted.seen[0].profile, undefined);
  assert.match(scripted.seen[0].text, /ТОЛЬКО ПЛАН/);
  // THE FIXED KEY SHAPE is prescribed by the plan pass's own request text and derived from the request.
  assert.match(scripted.seen[0].text, /РАЗДЕЛЫ: 1\)/);
  assert.match(scripted.seen[0].text, /ОБЪЁМ: 18000/);
  assert.match(scripted.seen[0].text, /ТАБЛИЦЫ: 2/);
  assert.match(scripted.seen[0].text, /ЗАКЛЮЧЕНИЕ: да/);
  assert.equal(scripted.seen[1].kind, 'execute');
  assert.equal(scripted.seen[1].profile, 'bulk');
  assert.match(scripted.seen[1].text, /УТВЕРЖДЁННЫЙ ПЛАН/);
  assert.match(scripted.seen[1].text, /Глава 1/);
  assert.match(scripted.seen[1].text, /insert_blocks/);
  // The FIRST execute pass names the criteria themselves, so the model can aim at them from the start.
  assert.match(scripted.seen[1].text, /КРИТЕРИИ ПРИЁМКИ/);
  assert.match(scripted.seen[1].text, /знаков — 20000/);
  assert.match(scripted.seen[1].text, /таблиц — 2/);
  // The published phases are the state machine's own, in order: a plan, one execute pass and the verify
  // that CONFIRMED the plan, with no continuation because nothing was measured missing.
  assert.deepEqual(progress.map(record => record.phase), ['planning', 'executing', 'verifying']);
  // The criteria travel in the PUBLISHED progress as well, so the panel's report carries them.
  assert.deepEqual(progress[1].criteria, { targetChars: 20000, tables: 2, lists: true, sections: 4, conclusions: true });
});

test('a verify that finds the volume short starts exactly one more pass and the request names the missing list', async () => {
  const doc = fakeDocument({ chars: 6000, headings: 2, tables: 0, paragraphs: 8, body: 'обычный текст' });
  const scripted = scriptedPasses([okPass(), okPass('часть 1'), () => {
    doc.state.chars = 20000; doc.state.headings = 4; doc.state.tables = 2; doc.state.body = 'выводы\n- пункт 1';
    return okPass('часть 2');
  }]);
  const orchestrator = createOrchestrator({ runPass: scripted.runPass, readDocument: doc.readDocument });
  const outcome = await orchestrator.run('документ примерно на 10 страниц');
  // The SECOND verification sees a document whose volume and sections now satisfy the plan, so the
  // orchestration stops at two execute passes instead of spending its budget.
  assert.equal(outcome.phase, 'complete');
  assert.equal(outcome.passes, 2);
  const continuation = scripted.seen[2];
  assert.equal(continuation.kind, 'execute');
  assert.equal(continuation.profile, 'bulk');
  assert.match(continuation.text, /НЕ ВЫПОЛНИЛ ПЛАН/);
  assert.match(continuation.text, /объём: 6000 из 20000 знаков/);
  assert.match(continuation.text, /разделов \(заголовков\): 2 из 4/);
  assert.match(continuation.text, /таблиц нет ни одной/);
  assert.match(continuation.text, /списков нет ни одного/);
  assert.match(continuation.text, /заключения нет/);
});

test('the pass budget is bounded by the named cap and stops with an honest incomplete report', async () => {
  const doc = fakeDocument({ chars: 10, headings: 0, tables: 0, paragraphs: 1, body: '' });
  // The plan pass plus THIRTEEN execute answers: the cap must end the run after twelve of them, and the
  // thirteenth answer must never be requested.
  const scripted = scriptedPasses([okPass(), ...Array.from({ length: ORCHESTRATION_MAX_EXECUTE_PASSES + 1 }, () => okPass('часть'))]);
  const orchestrator = createOrchestrator({ runPass: scripted.runPass, readDocument: doc.readDocument });
  const outcome = await orchestrator.run('документ на 10 страниц');
  assert.equal(outcome.phase, 'incomplete');
  assert.equal(outcome.error, 'PASS_BUDGET_EXHAUSTED');
  assert.equal(outcome.passes, ORCHESTRATION_MAX_EXECUTE_PASSES);
  assert.equal(ORCHESTRATION_MAX_EXECUTE_PASSES, 12, 'the cap is the named twelve passes');
  assert.equal(scripted.seen.length, ORCHESTRATION_MAX_EXECUTE_PASSES + 1, 'twelve execute passes and one plan pass');
  assert.ok(outcome.missing.length > 0, 'the honest report carries what is still missing');
  // The report exposes WHAT was required and WHAT was reached, so the native check can read both.
  assert.equal(outcome.floor.targetChars, 18000);
  assert.equal(outcome.criteria.targetChars, 20000, 'the plan MAY raise the volume; the floor cannot be lowered');
  assert.ok(outcome.criteria.sections > 0, 'the plan\'s own section count is the heading criterion');
  assert.equal(outcome.verified.chars, 10);
  const last = scripted.seen[scripted.seen.length - 1];
  assert.match(last.text, /НЕ ВЫПОЛНИЛ ПЛАН/, 'the continuation carries the missing list the verify measured');
  assert.match(last.text, /объём: 10 из 20000 знаков/);
});

test('the plan pass asks for the fixed, parseable key shape and the first execute pass pins the criteria', async () => {
  const doc = fakeDocument({ chars: 20000, headings: 4, tables: 2, paragraphs: 30, body: 'Выводы\n- один\n- два' });
  const scripted = scriptedPasses([okPass(planJson()), okPass('done')]);
  const outcome = await createOrchestrator({ runPass: scripted.runPass, readDocument: doc.readDocument })
    .run('создай документ примерно на 10 страниц с несколькими таблицами и выводами');
  const planRequest = scripted.seen[0].text;
  assert.match(planRequest, /РАЗДЕЛЫ: 1\)/);
  assert.match(planRequest, /ОБЪЁМ: 18000/);
  assert.match(planRequest, /ТАБЛИЦЫ: 2/);
  assert.match(planRequest, /ЗАКЛЮЧЕНИЕ: да/);
  assert.match(scripted.seen[1].text, /КРИТЕРИИ ПРИЁМКИ/);
  assert.match(scripted.seen[1].text, /знаков — 20000/);
  assert.match(scripted.seen[1].text, /таблиц — 2/);
  assert.deepEqual(outcome.criteria, { targetChars: 20000, tables: 2, lists: true, sections: 4, conclusions: true });
  assert.equal(outcome.phase, 'complete', 'all criteria were measured met, so the orchestration is complete');
});

test('complete needs EVERY criterion: one missed criterion keeps the run going and the report honest', async () => {
  // The document meets the volume, the sections, the tables and the conclusions, and misses ONLY the plan's
  // lists — one unmet criterion is enough to keep the run honest and to stop it being called complete.
  const doc = fakeDocument({ chars: 20000, headings: 4, tables: 2, paragraphs: 30, body: 'Выводы\nобычный текст' });
  const scripted = scriptedPasses([okPass(planJson({ targetCharacters: 20000 })),
    ...Array.from({ length: ORCHESTRATION_MAX_EXECUTE_PASSES }, () => okPass('часть'))]);
  const outcome = await createOrchestrator({ runPass: scripted.runPass, readDocument: doc.readDocument })
    .run('создай документ примерно на 10 страниц с несколькими таблицами и выводами');
  assert.equal(outcome.phase, 'incomplete');
  assert.equal(outcome.error, 'PASS_BUDGET_EXHAUSTED');
  assert.equal(outcome.criteria.tables, 2, 'the floor\'s two tables, raised by nothing here');
  assert.deepEqual(outcome.missing, ['списков нет ни одного'], 'only the one unmet criterion is named');
  // THE COMPLETE RULE: the document met the volume, the sections, the tables and the conclusions, and the
  // run still did not report a done — one missed criterion is enough to keep it honest.
  assert.equal(outcome.passes, ORCHESTRATION_MAX_EXECUTE_PASSES);
  assert.match(scripted.seen[scripted.seen.length - 1].text, /списков нет ни одного/);
});

test('a plan that cannot establish a key falls back to the request floor, and a plan below it can never lower the demand', async () => {
  const doc = fakeDocument({ chars: 20000, headings: 4, tables: 2, paragraphs: 30, body: 'Выводы\n- один\n- два' });
  // THE MODEST PLAN: it declares the owner's demand away completely, and the floor restores it.
  const modest = planJson({ targetCharacters: 1000, required: { tables: false, lists: false, conclusions: false } });
  const modestRun = await createOrchestrator({ runPass: scriptedPasses([okPass(modest), okPass('done')]).runPass,
    readDocument: doc.readDocument }).run('создай документ примерно на 10 страниц с таблицами и выводами');
  assert.equal(modestRun.criteria.targetChars, ORCHESTRATION_TARGET_CHARS);
  assert.equal(modestRun.criteria.tables, 2);
  assert.equal(modestRun.criteria.conclusions, true);
  // THE MALFORMED KEYS: sections parse, volume and tables do not, so both fall back to the floor.
  const malformed = planKeys({ volume: 'очень много', tables: 'две' });
  const malformedRun = await createOrchestrator({ runPass: scriptedPasses([okPass(malformed), okPass('done')]).runPass,
    readDocument: doc.readDocument }).run('создай документ примерно на 10 страниц с таблицами и выводами');
  assert.equal(malformedRun.criteria.targetChars, ORCHESTRATION_TARGET_CHARS, 'never zero, never below the floor');
  assert.equal(malformedRun.criteria.tables, 2);
  assert.equal(malformedRun.phase, 'complete');
});

test('the far end of the cap is reached with a full twelve-pass budget and the criteria are recomputed for the report', async () => {
  const doc = fakeDocument({ chars: 100, headings: 1, tables: 0, paragraphs: 2, body: '' });
  const plan = planJson({ targetCharacters: 50000, sections: ['A', 'B', 'C', 'D', 'E', 'F'] });
  const scripted = scriptedPasses([okPass(plan), ...Array.from({ length: ORCHESTRATION_MAX_EXECUTE_PASSES }, () => okPass('часть'))]);
  const outcome = await createOrchestrator({ runPass: scripted.runPass, readDocument: doc.readDocument })
    .run('создай документ на 10 страниц с несколькими таблицами и выводами');
  assert.equal(ORCHESTRATION_MAX_EXECUTE_PASSES, 12);
  assert.equal(outcome.passes, 12);
  assert.equal(scripted.seen.length, 13, 'one plan pass and twelve execute passes');
  assert.equal(outcome.criteria.targetChars, 50000, 'the plan raised the volume inside the bounded range');
  assert.equal(outcome.criteria.sections, 6, 'the plan MAY raise the owner\'s heading count too');
  assert.equal(outcome.criteria.tables, 2);
  assert.ok(outcome.missing.some(item => item.includes('из 50000')));
  assert.ok(outcome.verified.chars === 100, 'the report carries the reached numbers next to the criteria');
});

test('an uncertain action stops the orchestration with no further pass and names the unverified tool', async () => {
  const doc = fakeDocument({ chars: 5000, headings: 1, tables: 0, paragraphs: 4, body: '' });
  const uncertain = { ok: true, status: 'UNCERTAIN', message: null,
    actions: [{ tool: 'insert_blocks', outcome: 'uncertain', code: 'TOOL_UNCERTAIN' }], steps: 1, toolCalls: 1 };
  const scripted = scriptedPasses([okPass(), uncertain, okPass('never reached')]);
  const orchestrator = createOrchestrator({ runPass: scripted.runPass, readDocument: doc.readDocument });
  const outcome = await orchestrator.run('документ на 10 страниц');
  assert.equal(outcome.phase, 'uncertain');
  assert.equal(outcome.error, 'TOOL_UNCERTAIN');
  assert.equal(outcome.passes, 1);
  assert.deepEqual(outcome.missingTools, ['insert_blocks']);
  assert.equal(outcome.uncertainty.tool, 'insert_blocks');
  assert.equal(scripted.seen.length, 2, 'no third pass is started after an uncertain write');
  assert.equal(uncertaintyOf({ status: 'UNCERTAIN', actions: [] }).code, 'TOOL_UNCERTAIN');
  assert.equal(uncertaintyOf({ status: 'FINAL', actions: [{ tool: 'x', outcome: 'ok' }] }), null);
});

test('a plan pass that wrongly calls tools keeps its plan text and reports the calls', async () => {
  const doc = fakeDocument({ chars: 20000, headings: 4, tables: 2, paragraphs: 20, body: 'Выводы\n- один\n- два' });
  const planWithTools = { ok: true, status: 'FINAL', message: planJson(),
    actions: [{ tool: 'read_structure', outcome: 'ok' }], steps: 2, toolCalls: 1 };
  const scripted = scriptedPasses([planWithTools, okPass('выполнено')]);
  const orchestrator = createOrchestrator({ runPass: scripted.runPass, readDocument: doc.readDocument });
  const outcome = await orchestrator.run('документ на 10 страниц');
  assert.equal(outcome.planCalledTools, true);
  assert.ok(outcome.plan.sections.length > 0, 'the plan text is kept');
  assert.equal(outcome.phase, 'complete');
});

test('a plan pass with an unusable answer and a failed plan pass both stop before any execute pass', async () => {
  const doc = fakeDocument({ chars: 20000, headings: 4, tables: 1, paragraphs: 20, body: 'выводы' });
  const unusable = scriptedPasses([okPass('я не буду возвращать JSON'), okPass('never')]);
  const first = await createOrchestrator({ runPass: unusable.runPass, readDocument: doc.readDocument }).run('документ на 10 страниц');
  assert.equal(first.phase, 'incomplete');
  assert.equal(first.error, 'PLAN_UNUSABLE');
  assert.equal(first.passes, 0);
  assert.equal(unusable.seen.length, 1, 'no execute pass without a plan');
  const failed = scriptedPasses([{ ok: false, error: 'PROTOCOL_ERROR' }, okPass('never')]);
  const second = await createOrchestrator({ runPass: failed.runPass, readDocument: doc.readDocument }).run('документ на 10 страниц');
  assert.equal(second.phase, 'blocked');
  assert.equal(second.error, 'PROTOCOL_ERROR');
  assert.equal(failed.seen.length, 1);
});

test('a confirmation proposal ends the orchestration instead of starting another pass', async () => {
  const doc = fakeDocument({ chars: 5000, headings: 1, tables: 0, paragraphs: 3, body: '' });
  const scripted = scriptedPasses([okPass(), { ok: true, status: 'PREVIEW_READY', message: null, actions: [], steps: 1, toolCalls: 0 }]);
  const outcome = await createOrchestrator({ runPass: scripted.runPass, readDocument: doc.readDocument }).run('документ на 10 страниц');
  assert.equal(outcome.phase, 'incomplete');
  assert.equal(outcome.error, 'PREVIEW_READY');
  assert.equal(scripted.seen.length, 2);
});

test('a refused document read stops the orchestration instead of reporting an invented volume', async () => {
  const scripted = scriptedPasses([okPass(), okPass('часть')]);
  const outcome = await createOrchestrator({ runPass: scripted.runPass,
    readDocument: async () => Object.freeze({ ok: false, error: 'CAPABILITY_UNAVAILABLE' }) }).run('документ на 10 страниц');
  assert.equal(outcome.phase, 'blocked');
  assert.equal(outcome.error, 'CAPABILITY_UNAVAILABLE');
  assert.equal(outcome.passes, 1);
});

test('the document reader reads the structure and one bounded text probe through the public legs', async () => {
  const calls = [];
  const read = createDocumentReader({
    readStructure: async raw => { calls.push(['structure', raw]); return { ok: true,
      statistics: { PageCount: 7, SymbolsWSCount: 16234, ParagraphCount: 41 }, counts: { headings: 5, tables: 2, paragraphs: 41 },
      headings: [{ index: 0, text: 'Введение' }] }; },
    readDocumentText: async raw => { calls.push(['text', raw]); return { ok: true, text: '- пункт', totalChars: 6 }; }
  });
  const result = await read();
  assert.equal(result.ok, true);
  assert.equal(result.measured.chars, 16234, 'the document\'s own statistic is the volume');
  assert.equal(result.measured.headings, 5);
  assert.equal(result.measured.tables, 2);
  assert.equal(result.measured.paragraphs, 41);
  assert.equal(result.measured.lists, true);
  assert.deepEqual(calls[0][1], { maxHeadings: 32 });
  assert.deepEqual(calls[1][1], { offset: 0, maxChars: ORCHESTRATION_TEXT_PROBE_CHARS });
  // A missing bridge leg is a refusal, never a zero measurement.
  const refused = await createDocumentReader({ readStructure: null, readDocumentText: null })();
  assert.deepEqual(refused, { ok: false, error: 'CAPABILITY_UNAVAILABLE' });
});

test('the missing list reports the unmet CRITERIA with their numbers, and complete is reached only when none is unmet', () => {
  // The floor ALONE, with a plan that lowered the declarable elements and the volume: `max` restores the
  // owner's demand, so several criteria are unmet at once and the list names each with its own numbers.
  const modest = parsePlan(planJson({ targetCharacters: 1000, sections: ['A'],
    required: { tables: false, lists: false, conclusions: false } }));
  const strong = criteriaFrom(floor, modest);
  assert.deepEqual(strong, { targetChars: 18000, tables: 2, lists: false, sections: 2, conclusions: true });
  const measured = measuredFrom({ statistics: { SymbolsWSCount: 5000, ParagraphCount: 4 }, counts: { headings: 3, tables: 1, paragraphs: 4 },
    headings: [], text: 'обычный текст' });
  const missing = missingFrom(strong, measured);
  assert.deepEqual(missing, ['объём: 5000 из 18000 знаков (примерно 3 из 10 страниц)', 'таблиц 1 из 2', 'заключения нет']);
  // The exact wording the owner asked for, on the measured numbers of a real run.
  const thin = measuredFrom({ statistics: { SymbolsWSCount: 12400, ParagraphCount: 40 }, counts: { headings: 8, tables: 1, paragraphs: 40 },
    headings: [], text: '- пункт' });
  assert.deepEqual(missingFrom(criteria, thin), ['объём: 12400 из 20000 знаков (примерно 7 из 12 страниц)', 'таблиц 1 из 2', 'заключения нет']);
  // A document that leaves exactly ONE criterion unmet is missing exactly that one, and no other.
  const met = measuredFrom({ statistics: { SymbolsWSCount: 20000, ParagraphCount: 9 },
    counts: { headings: 4, tables: 2, paragraphs: 9 }, headings: [], text: 'Заключение\n- один\n- два' });
  assert.deepEqual(missingFrom(criteria, met), []);
  assert.deepEqual(missingFrom(criteria, { ...met, chars: 100 }), ['объём: 100 из 20000 знаков (примерно 1 из 12 страниц)']);
  assert.deepEqual(missingFrom(criteria, { ...met, headings: 3 }), ['разделов (заголовков): 3 из 4 заявленных']);
  assert.deepEqual(missingFrom(criteria, { ...met, tables: 1 }), ['таблиц 1 из 2']);
  assert.deepEqual(missingFrom(criteria, { ...met, tables: 0 }), ['таблиц нет ни одной']);
  assert.deepEqual(missingFrom(criteria, { ...met, conclusions: false }), ['заключения нет']);
  const withLists = criteriaFrom(floor, parsePlan(planJson()));
  assert.deepEqual(missingFrom(withLists, { ...met, lists: false }), ['списков нет ни одного']);
  // A plan MAY raise a criterion above the floor: the max is the plan's own number.
  assert.equal(criteriaFrom(floor, parsePlan(planJson({ sections: ['A', 'B', 'C', 'D', 'E'] }))).sections, 5);
});

