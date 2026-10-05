import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrchestrator, createDocumentReader, parsePlan, missingFrom, measuredFrom, isLongGenerationRequest,
  uncertaintyOf, ORCHESTRATION_TARGET_CHARS, ORCHESTRATION_MAX_EXECUTE_PASSES, ORCHESTRATION_MAX_TARGET_CHARS,
  ORCHESTRATION_TEXT_PROBE_CHARS } from '../../src/ui/orchestrator.js';

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

test('the long-generation trigger is narrow: it fires on a named volume or several parts, not on an ordinary request', () => {
  assert.equal(isLongGenerationRequest('создай структурированный документ примерно на 10 страниц, добавь главы, несколько таблиц, списки, выводы и оформи его'), true);
  assert.equal(isLongGenerationRequest('добавь 5 разделов о безопасности'), true);
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
  assert.equal(parsePlan(JSON.stringify({ sections: ['A'], targetCharacters: 20000, required: { tables: 'да', lists: false, conclusions: false }, summary: 's' })), null);
  const floor = parsePlan(planJson({ targetCharacters: 1000 }));
  assert.equal(floor.targetChars, ORCHESTRATION_TARGET_CHARS, 'the owner\'s ten pages may not be lowered by a plan');
  const ceiling = parsePlan(planJson({ targetCharacters: 10 ** 9 }));
  assert.equal(ceiling.targetChars, ORCHESTRATION_MAX_TARGET_CHARS);
  const strings = parsePlan(JSON.stringify({ sections: ['A', { title: 'B' }], targetCharacters: 20000,
    required: { tables: false, lists: false, conclusions: false }, summary: 's' }));
  assert.deepEqual(strings.sections, ['A', 'B']);
});

test('a plan pass, an execute pass and a verify that confirms the plan ends complete after one pass', async () => {
  const doc = fakeDocument({ chars: 20000, headings: 4, tables: 2, paragraphs: 30, body: 'Выводы\n- первый пункт\n- второй пункт' });
  const scripted = scriptedPasses([okPass(), okPass('готово')]);
  const progress = [];
  const orchestrator = createOrchestrator({ runPass: scripted.runPass, readDocument: doc.readDocument,
    emit: record => progress.push(record) });
  const outcome = await orchestrator.run('документ на 10 страниц');
  assert.equal(outcome.phase, 'complete');
  assert.equal(outcome.passes, 1);
  assert.equal(outcome.plan.sections.length, 4);
  assert.equal(outcome.plan.targetChars, 20000);
  assert.deepEqual(outcome.missing, []);
  assert.deepEqual(outcome.verified, { chars: 20000, headings: 4, tables: 2, paragraphs: 30, lists: true, conclusions: true });
  // The plan pass is FIRST and asks for the plan only; the execute pass carries the plan itself.
  assert.equal(scripted.seen.length, 2);
  assert.equal(scripted.seen[0].kind, 'plan');
  // The plan pass names NO profile (`undefined` is the registry's own "absent"), so the tool list it
  // runs under is the ordinary confirm-free one rather than the bulk view.
  assert.equal(scripted.seen[0].profile, undefined);
  assert.match(scripted.seen[0].text, /ТОЛЬКО ПЛАН/);
  assert.equal(scripted.seen[1].kind, 'execute');
  assert.equal(scripted.seen[1].profile, 'bulk');
  assert.match(scripted.seen[1].text, /УТВЕРЖДЁННЫЙ ПЛАН/);
  assert.match(scripted.seen[1].text, /Глава 1/);
  assert.match(scripted.seen[1].text, /insert_blocks/);
  // The published phases are the state machine's own, in order: a plan, one execute pass and the verify
  // that CONFIRMED the plan, with no continuation because nothing was measured missing.
  assert.deepEqual(progress.map(record => record.phase), ['planning', 'executing', 'verifying']);
});

test('a verify that finds the volume short starts exactly one more pass and the request names the missing list', async () => {
  const doc = fakeDocument({ chars: 6000, headings: 2, tables: 0, paragraphs: 8, body: 'обычный текст' });
  const scripted = scriptedPasses([okPass(), okPass('часть 1'), () => {
    doc.state.chars = 20000; doc.state.headings = 4; doc.state.tables = 1; doc.state.body = 'выводы\n- пункт 1';
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
  assert.match(continuation.text, /нет раздела с выводами/);
});

test('the pass budget is bounded by the named cap and stops with an honest incomplete report', async () => {
  const doc = fakeDocument({ chars: 10, headings: 0, tables: 0, paragraphs: 1, body: '' });
  // The plan pass plus SEVEN execute answers: the cap must end the run after six of them, and the
  // seventh answer must never be requested.
  const scripted = scriptedPasses([okPass(), ...Array.from({ length: ORCHESTRATION_MAX_EXECUTE_PASSES + 1 }, () => okPass('часть'))]);
  const orchestrator = createOrchestrator({ runPass: scripted.runPass, readDocument: doc.readDocument });
  const outcome = await orchestrator.run('документ на 10 страниц');
  assert.equal(outcome.phase, 'incomplete');
  assert.equal(outcome.error, 'PASS_BUDGET_EXHAUSTED');
  assert.equal(outcome.passes, ORCHESTRATION_MAX_EXECUTE_PASSES);
  assert.equal(ORCHESTRATION_MAX_EXECUTE_PASSES, 6);
  assert.equal(scripted.seen.length, ORCHESTRATION_MAX_EXECUTE_PASSES + 1, 'six execute passes and one plan pass');
  assert.ok(outcome.missing.length > 0, 'the honest report carries what is still missing');
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
  const doc = fakeDocument({ chars: 20000, headings: 4, tables: 1, paragraphs: 20, body: 'Выводы\n- один\n- два' });
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

test('the missing list is derived only from what a read proved', () => {
  const plan = parsePlan(planJson({ targetCharacters: 18000 }));
  const measured = measuredFrom({ statistics: { SymbolsWSCount: 5000, ParagraphCount: 4 }, counts: { headings: 1, tables: 0, paragraphs: 4 },
    headings: [], text: 'обычный текст' });
  const missing = missingFrom(plan, measured);
  assert.equal(missing.length, 5);
  assert.match(missing[0], /объём: 5000 из 18000 знаков/);
  assert.match(missing[0], /3 из 10 страниц/);
  assert.equal(missingFrom(plan, measuredFrom({ statistics: { SymbolsWSCount: 19000, ParagraphCount: 9 },
    counts: { headings: 4, tables: 1, paragraphs: 9 }, headings: [], text: 'Выводы\n- один\n- два' })).length, 0);
});
