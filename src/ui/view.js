import { utf8ByteLength } from '../shared/bytes.js';
import { renderMarkdown } from './markdown.js';

const statuses = Object.freeze({
  CHECKING_R7: 'Проверка наличия API Р7…', R7_PRESENCE_READY: 'Проверка наличия API завершена. Документ не изменён.', R7_CHECK_UNAVAILABLE: 'Проверка Р7 недоступна для этого редактора / моста. API не угадываются.',
  READY: 'Готово к запросу', ANALYZING: 'Анализ…', CONNECTING: 'Проверка соединения…', CONNECTION_OK: 'Соединение проверено',
  READING_CONTEXT: 'Чтение выделения…', CONTEXT_READY: 'Контекст прочитан', CONTEXT_CHANGED: 'Контекст изменился. Прочитайте выделение заново.',
  COMPLETE: 'Ответ получен', PREVIEW_READY: 'Предложение готово. Документ не изменён.', PREVIEW_EXPIRED: 'Срок предложения истёк', PREVIEW_CANCELLED: 'Предложение отменено. Документ не изменён.',
  SETTINGS_CHANGED: 'Настройки изменены; предыдущий запрос и предложение недействительны', SETTINGS_SAVED: 'Настройки применены', STOPPED: 'Запрос остановлен. Поздние ответы не используются.',
  AGENT_LIMIT: 'Достигнут предел выполнения задачи. Результат неполный; проверьте документ.',
  AGENT_INCOMPLETE: 'Завершение задачи не подтверждено контрольным чтением. Выполненные изменения остаются в открытом документе; проверьте результат.',
  ORCH_PLANNING: 'Составляю план документа… Документ не изменяется.',
  ORCH_EXECUTING: 'Выполняю план по частям…',
  ORCH_VERIFYING: 'Проверяю документ по факту: структура и объём.',
  ORCH_CONTINUING: 'План выполнен не полностью; продолжаю с недостающими элементами.',
  ORCH_COMPLETE: 'План выполнен: проверка самого документа подтвердила объём и обязательные элементы.',
  ORCH_INCOMPLETE: 'План выполнен не полностью. Изменения сохранены; ниже — чего не хватает.',
  ORCH_UNCERTAIN: 'Исход последнего действия неизвестен. Остановлено без повтора; проверьте документ.',
  ORCH_BLOCKED: 'Оркестрация остановлена: проверка или проход недоступны. Изменения сохранены.',
  INVALID_SETTINGS: 'Проверьте настройки соединения', INVALID_ENDPOINT: 'Нужен полный HTTPS URL с окончанием /v1/chat/completions', INVALID_KEY: 'Введите корректный ключ',
  INVALID_DATA: 'Некорректные данные', BYTE_LIMIT: 'Превышен лимит UTF-8 для ввода, выделения или ответа; текст не обрезается.',
  SETTINGS_CONFLICT: 'Настройки изменены в другом редакторе. Загрузите актуальный профиль и повторите изменение.',
  STORAGE_UNAVAILABLE: 'Не удалось сохранить или прочитать зашифрованный профиль. Проверьте доступ к хранилищу и повторите.', STORAGE_CORRUPT: 'Сохранённые настройки повреждены', INTERNAL_ERROR: 'Не удалось завершить операцию',
  PROTOCOL_ERROR: 'Ответ не соответствует разрешённому JSON формату', HTTP_UNAUTHORIZED: 'Сервер отклонил ключ (401)', HTTP_FORBIDDEN: 'Доступ запрещён (403)', HTTP_RATE_LIMIT: 'Лимит запросов (429); автоматического повтора нет',
  HTTP_SERVER_ERROR: 'Ошибка сервера', HTTP_ERROR: 'HTTP запрос не выполнен', NETWORK_ERROR: 'Сеть / DNS / CORS / TLS: соединение не выполнено. Проверка сертификата не отключается.',
  OFFLINE: 'Нет сети', CANCELLED: 'Операция отменена', TIMEOUT: 'Время ожидания истекло', CAPABILITY_UNAVAILABLE: 'Возможность недоступна. Безопасность изменения документа не доказана.',
  CHECKING_SELECTION: 'Проверка текущего редактора и выделения…', APPLYING: 'Команда замены отправлена. Её нельзя отменить; ожидается квитанция SDK.',
  APPLY_ACKNOWLEDGED: 'SDK подтвердил команду. Это не подтверждает изменение текста и форматирования; проверьте документ. Для отмены используйте штатный Undo.',
  APPLY_UNCERTAIN: 'Исход команды неизвестен; результат не доказан. Проверьте документ. Автоматического повтора и отката нет; незавершённый вызов блокирует изменения.',
  SELECTION_CHANGED: 'Выделение изменилось. Повторите команду',
  EDITOR_BUSY: 'Редактор занят / исход предыдущего вызова неизвестен. Дождитесь его завершения; новый мост не создаётся.', EDITOR_ERROR: 'Не удалось получить результат редактора'
});
// The owner fixed the compact set to five words (contract §7.7): Готово / Анализирую / Выполняю / Проверяю /
// Ошибка. A review of T3 caught the first version of this map labelling EVERY known-but-unlisted status as
// `Ошибка`, which made cancellations, an expired preview and a settings change look like failures. The three
// groups below are therefore EXHAUSTIVE over `statuses`, and the rule is honest:
//   * ACTIVE - the operation is in flight, so the label names the stage;
//   * CLEAN  - it ended and nothing needs the user's attention, so it is `Готово` (the detailed line says what
//              exactly happened: "предложение отменено", "операция отменена", "настройки изменены");
//   * ATTENTION - a genuine failure OR an outcome that is incomplete/unproven (a limit hit, an uncertain apply,
//              a blocked orchestration). `Ошибка` is the only one of the five words that does not claim success,
//              and the detailed line still explains the real state, so an unproven result is never dressed up as
//              `Готово`.
// An unknown status key deliberately falls back to `Готово` rather than to `Ошибка`: a state this UI has not
// classified must not be reported to the user as a failure. The exhaustive test in tests/unit/view.test.js walks
// every key of `statuses` and fails if any of them is unclassified, so the map cannot drift silently.
const compactActive = Object.freeze({
  ANALYZING: 'Анализирую', ORCH_PLANNING: 'Анализирую',
  READING_CONTEXT: 'Выполняю', APPLYING: 'Выполняю', ORCH_EXECUTING: 'Выполняю', ORCH_CONTINUING: 'Выполняю',
  CHECKING_R7: 'Проверяю', CONNECTING: 'Проверяю', CHECKING_SELECTION: 'Проверяю', ORCH_VERIFYING: 'Проверяю'
});
const compactClean = Object.freeze([
  'READY', 'COMPLETE', 'CONTEXT_READY', 'CONNECTION_OK', 'SETTINGS_SAVED', 'SETTINGS_CHANGED', 'R7_PRESENCE_READY',
  'PREVIEW_READY', 'PREVIEW_EXPIRED', 'PREVIEW_CANCELLED', 'CONTEXT_CHANGED', 'STOPPED', 'CANCELLED',
  'APPLY_ACKNOWLEDGED', 'ORCH_COMPLETE'
]);
const compactAttention = Object.freeze([
  'AGENT_LIMIT', 'AGENT_INCOMPLETE', 'ORCH_INCOMPLETE', 'ORCH_UNCERTAIN', 'ORCH_BLOCKED', 'APPLY_UNCERTAIN',
  'R7_CHECK_UNAVAILABLE', 'CAPABILITY_UNAVAILABLE', 'SELECTION_CHANGED', 'EDITOR_BUSY', 'EDITOR_ERROR',
  'INVALID_SETTINGS', 'INVALID_ENDPOINT', 'INVALID_KEY', 'INVALID_DATA', 'BYTE_LIMIT',
  'SETTINGS_CONFLICT', 'STORAGE_UNAVAILABLE', 'STORAGE_CORRUPT', 'INTERNAL_ERROR', 'PROTOCOL_ERROR',
  'HTTP_UNAUTHORIZED', 'HTTP_FORBIDDEN', 'HTTP_RATE_LIMIT', 'HTTP_SERVER_ERROR', 'HTTP_ERROR',
  'NETWORK_ERROR', 'OFFLINE', 'TIMEOUT'
]);
const compactStatuses = Object.freeze(Object.assign(Object.create(null), compactActive,
  Object.fromEntries(compactClean.map((code) => [code, 'Готово'])),
  Object.fromEntries(compactAttention.map((code) => [code, 'Ошибка']))));
const connectionErrors = new Set(['INVALID_SETTINGS', 'INVALID_ENDPOINT', 'INVALID_KEY',
  'SETTINGS_CONFLICT', 'STORAGE_UNAVAILABLE', 'STORAGE_CORRUPT', 'HTTP_UNAUTHORIZED',
  'HTTP_FORBIDDEN', 'HTTP_RATE_LIMIT', 'HTTP_SERVER_ERROR', 'HTTP_ERROR', 'NETWORK_ERROR', 'OFFLINE', 'TIMEOUT']);
export function statusText(code, compact = false) {
  if (compact) return compactStatuses[code] ?? 'Готово';
  return statuses[code] ?? statuses.INTERNAL_ERROR;
}
export function progressStageText(state) {
  if (state?.active !== true) return '';
  const orchestrating = state.orchestration?.status;
  if (state.status === 'ORCH_VERIFYING' || orchestrating === 'ORCH_VERIFYING' || state.status === 'CHECKING_SELECTION') return 'проверка результата';
  const record = state.agent;
  if (!record) return 'подготовка запроса';
  const steps = Number.isInteger(record.steps) && record.steps > 0 ? record.steps : 0;
  const toolCalls = Number.isInteger(record.toolCalls) && record.toolCalls > 0 ? record.toolCalls : 0;
  if (steps === 0) return 'запрос к модели';
  if (toolCalls > 0 && record.status === 'RUNNING') {
    return `выполнение шага ${steps}`;
  }
  return 'сборка результата';
}
// The orchestration report, in the same authored, closed coding the status captions use: the panel's own
// numbers and the plan's own text, never a model envelope. Every line is authored text rendered with
// textContent, so no plan or document text can become markup.
export function orchestrationText(record) {
  if (!record) return '';
  const lines = [`Проходов: ${record.pass} / ${record.maxPasses}. Целевой объём: ${record.targetChars} знаков.`];
  // The ENFORCED criteria are the panel's own authored numbers, printed before the measurement they were
  // checked against, so the report always shows what was required next to what was reached.
  if (record.criteria) {
    lines.push(`Критерии приёмки: знаков — ${record.criteria.targetChars}, заголовков — ${record.criteria.sections}, таблиц — ${record.criteria.tables}, списки — ${record.criteria.lists ? 'да' : 'нет'}, заключение — ${record.criteria.conclusions ? 'да' : 'нет'}.`);
  }
  if (record.verified) {
    lines.push(`Проверено по документу: абзацев — ${record.verified.paragraphs ?? '—'}, заголовков — ${record.verified.headings}, таблиц — ${record.verified.tables}, знаков — ${record.verified.chars}.`);
  }
  if (record.plan) {
    lines.push(`План: ${record.plan.sections.length} разделов, объём ${record.plan.targetChars} знаков, обязательные элементы: ${requiredText(record.plan.required)}.`);
    // The plan's own section titles are AUTHORED BY THE MODEL and are shown as DATA: one bullet per
    // title, joined into the same text node the report renders, so no title can become markup.
    lines.push(`Разделы плана: ${record.plan.sections.join(' · ')}`);
  }
  if (record.planCalledTools) lines.push('План был получен вместе с вызовами инструментов; текст плана сохранён.');
  if (record.missing.length > 0) lines.push(`Не хватает: ${record.missing.join('; ')}.`);
  if (record.missingTools.length > 0) lines.push(`Неподтверждённое действие: ${record.missingTools.join(', ')}.`);
  if (record.error) lines.push(`Причина остановки: ${record.error}.`);
  return lines.join('\n');
}
function requiredText(required) {
  const names = [];
  if (required.tables) names.push('таблицы');
  if (required.lists) names.push('списки');
  if (required.conclusions) names.push('выводы');
  return names.length === 0 ? 'нет' : names.join(', ');
}
function contextText(value) {
  if (value.kind === 'UNAVAILABLE') return 'Чтение выделения недоступно для этого редактора';
  if (value.kind === 'EMPTY') return 'Выделение пустое';
  if (value.kind === 'EXACT') return `Прочитано точно: ${value.bytes} байт UTF-8 (не подтверждение цели)`;
  return 'Выделение неизвестно';
}
const editorNames = Object.freeze({ word: 'Word', cell: 'Cell', slide: 'Slide' });
const numberWords = Object.freeze(['ноль', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть']);
const denominatorWords = Object.freeze({ 2: 'двух', 6: 'шести' });
function capabilityText(state) {
  if (state.writeLocked === true) return 'Изменение подготовлено и ждёт подтверждения. Отправка и повторное изменение недоступны, потому что редактор ещё не подтвердил предыдущую запись. Что сделать: подтвердите изменение в редакторе или дождитесь завершения операции.';
  if (state.status === 'CHECKING_R7') return 'Проверяю возможности редактора… Доступность ещё не определена, потому что проверка не завершена. Что сделать: дождитесь завершения проверки и повторите действие.';
  if (!Object.hasOwn(editorNames, state.editorType) || state.status === 'R7_CHECK_UNAVAILABLE') {
    return 'Доступно: запросы после подключения поддерживаемого редактора. Этот редактор не поддерживается. Что сделать: откройте документ, таблицу или презентацию, откройте панель через меню „Плагины“ и повторите проверку.';
  }
  if (Number.isInteger(state.capabilityCount)) {
    const ceiling = state.editorType === 'word' ? 6 : 2;
    const checked = state.editorType === 'word' ? 'шесть API-примитивов документа' : 'чтение выделения и изменение через адаптер';
    const available = `${numberWords[state.capabilityCount]} из ${denominatorWords[ceiling]}`;
    if (state.capabilityCount === ceiling) return `Редактор: ${editorNames[state.editorType]}. Доступно: ${available} — проверены ${checked}. Что сделать: можно отправлять запрос.`;
    const missing = ceiling - state.capabilityCount;
    if (state.editorType === 'cell' && state.capabilityCount === 1) {
      return `Проверено: ${checked}. Доступно: ${available} возможностей — изменение через адаптер. Недоступно: одна возможность, потому что проверка редактора её не подтвердила. Что сделать: оставьте передачу выделения выключенной и отправьте запрос без неё либо восстановите адаптер и повторите проверку.`;
    }
    return `Редактор: ${editorNames[state.editorType]}. Доступно: ${available} — проверены ${checked}. Недоступно: ${numberWords[missing]} возможности, потому что проверка редактора их не подтвердила. Что сделать: откройте диагностику редактора и повторите проверку после восстановления адаптера.`;
  }
  return 'Возможности редактора ещё не проверены. Откройте панель через меню „Плагины“, затем нажмите «Проверить Р7».';
}

// Build controls once. Status rendering must not replace a focused form or draft.
export function mountPanel(root, controller) {
  const doc = root.ownerDocument;
  const controls = {};
  const handlers = [];
  function node(tag, text = '', id) { const el = doc.createElement(tag); el.textContent = text; if (id) el.id = id; return el; }
  function on(el, name, handler) { el.addEventListener(name, handler); handlers.push({ el, name, handler }); }
  function button(text, id, action) { const el = node('button', text, id); el.type = 'button'; on(el, 'click', action); return el; }
  function field(parent, name, label, type = 'text') {
    const wrapper = node('div'); wrapper.className = 'field';
    const caption = node('label', label); caption.htmlFor = name;
    const el = node('input', '', name); el.type = type; el.name = name;
    controls[name] = el; wrapper.append(caption, el); parent.append(wrapper); return el;
  }
  const header = node('header');
  const title = node('h1', 'R7 AI Assistant');
  const fresh = button('+', 'new-chat', function () { controller.newChat(); prompt.focus(); });
  fresh.className = 'header-control'; fresh.setAttribute('aria-label', 'Новый чат'); fresh.title = 'Новый чат';
  const diagnostics = node('section', '', 'diagnostics'); diagnostics.hidden = true;
  diagnostics.setAttribute('aria-label', 'Диагностика');
  const menu = node('div', '', 'panel-menu'); menu.hidden = true; menu.setAttribute('aria-label', 'Меню');
  const menuToggle = button('⋯', 'toggle-menu', function () {
    menu.hidden = !menu.hidden; menuToggle.setAttribute('aria-expanded', String(!menu.hidden));
    if (!menu.hidden) (changeConnection.disabled ? diagnosticsToggle : changeConnection).focus();
  });
  menuToggle.className = 'header-control'; menuToggle.title = 'Меню'; menuToggle.setAttribute('aria-label', 'Меню');
  menuToggle.setAttribute('aria-controls', 'panel-menu'); menuToggle.setAttribute('aria-expanded', 'false');
  function closeMenu() { menu.hidden = true; menuToggle.setAttribute('aria-expanded', 'false'); }
  on(root, 'keydown', function (event) {
    if (event.key === 'Escape' && !menu.hidden) { event.preventDefault(); closeMenu(); menuToggle.focus(); }
  });
  on(root, 'click', function (event) {
    if (!menu.hidden && !event.target.closest?.('#panel-menu, #toggle-menu')) closeMenu();
  });
  const diagnosticsToggle = button('Диагностика', 'toggle-diagnostics', function () {
    closeMenu();
    menuToggle.focus();
    diagnostics.hidden = !diagnostics.hidden;
    diagnosticsToggle.setAttribute('aria-expanded', String(!diagnostics.hidden));
    if (!diagnostics.hidden) content.scrollTop = content.scrollHeight;
  });
  diagnosticsToggle.title = 'Диагностика';
  diagnosticsToggle.setAttribute('aria-label', 'Диагностика');
  diagnosticsToggle.setAttribute('aria-controls', 'diagnostics'); diagnosticsToggle.setAttribute('aria-expanded', 'false');
  const badge = node('p', 'Stage B · только предложение', 'editor'); badge.className = 'muted';
  const detailedStatus = node('p', '', 'status-details'); detailedStatus.setAttribute('aria-live', 'off'); detailedStatus.className = 'muted';
  diagnostics.append(node('h2', 'Диагностика'), badge, detailedStatus);
  const status = node('p', '', 'status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.setAttribute('aria-atomic', 'true');
  header.append(title, status, fresh, menuToggle, menu);
  const progressStage = node('p', '', 'progress-stage'); progressStage.setAttribute('aria-live', 'off'); progressStage.setAttribute('aria-busy', 'false'); progressStage.hidden = true;
  const lifecycleWarning = node('p', 'Обычный текст Word; активное отслеживание изменений не поддерживается. Перед Применить проверяются текущий редактор, контекст и точное непустое выделение. Проверка и запись не атомарны.'); lifecycleWarning.className = 'notice';
  const toolbar = node('section'); toolbar.setAttribute('aria-label', 'Режим и контекст');
  const modeLabel = node('label', 'Режим'); modeLabel.htmlFor = 'mode';
  const mode = node('select', '', 'mode');
  for (const [value, label] of [['ASK', 'ASK — спросить'], ['EDIT', 'EDIT — предложить замену']]) { const option = node('option', label); option.value = value; mode.append(option); }
  on(mode, 'change', function () { controller.setMode(mode.value); });
  const include = field(toolbar, 'include-context', 'Передавать только выделенный текст', 'checkbox');
  on(include, 'change', function () { controller.setIncludeContext(include.checked); });
  const checkR7 = button('Проверить Р7', 'check-r7', function () { controller.checkR7(); });
  const capabilitySummary = node('p', '', 'r7-capabilities'); capabilitySummary.setAttribute('aria-live', 'off');
  const capabilityState = node('p', '', 'capability-state'); capabilityState.setAttribute('aria-live', 'off');
  const refresh = button('Прочитать выделение', 'read-context', function () { controller.refreshContext(); });
  const context = node('p', '', 'context'); context.setAttribute('aria-live', 'off');
  const selected = node('pre', '', 'selected-text');
  const contextDetails = node('details'); contextDetails.append(node('summary', 'Прочитанный текст'), selected);
  const capabilityPointer = node('p', 'Недоступное действие объяснено ниже.', 'capability-pointer'); capabilityPointer.className = 'muted';
  toolbar.append(modeLabel, mode, refresh, checkR7, capabilitySummary, capabilityPointer, capabilityState, context, contextDetails);
  const content = node('div', '', 'content'); content.setAttribute('data-scroll-container', 'content');
  const history = node('section', '', 'history'); history.setAttribute('aria-label', 'История чата');
  // The actions summary is a technical, content-free record: the tool name, the closed outcome and,
  // for a failed action, its closed code. It is rendered with textContent only, so no raw model JSON,
  // tool argument or document text can ever reach the DOM. The element is named `journal` rather than
  // `actions` because the authored-code audit tracks an identifier by NAME across the whole bundle and
  // the `actions` name is shared with unrelated modules; the ELEMENT ID stays `actions`.
  const journal = node('section', '', 'actions'); journal.setAttribute('aria-live', 'off'); journal.setAttribute('aria-label', 'Журнал действий');
  // The orchestration report: the plan, the pass count, the VERIFIED numbers and what is still missing.
  // It is rendered with textContent only, so the plan text a model authored stays literal text and can
  // never become an element or an attribute.
  const orchestration = node('pre', '', 'orchestration'); orchestration.setAttribute('aria-live', 'off'); orchestration.hidden = true;
  const composer = node('form', '', 'composer');
  const prompt = node('textarea', '', 'prompt'); prompt.rows = 2; prompt.setAttribute('aria-label', 'Запрос'); prompt.setAttribute('aria-describedby', 'input-budget');
  prompt.placeholder = 'Сообщение…';
  const budget = node('p', '', 'input-budget'); budget.className = 'muted'; budget.hidden = true;
  on(prompt, 'input', function () {
    const followDraftTail = diagnostics.hidden && content.scrollHeight - content.scrollTop - content.clientHeight < 32;
    prompt.style.height = '38px';
    prompt.style.height = `${Math.min(72, Math.max(38, prompt.scrollHeight + 2))}px`;
    const bytes = utf8ByteLength(prompt.value);
    budget.textContent = `${bytes} / 8192 байт UTF-8`;
    budget.hidden = bytes < 6144;
    if (followDraftTail) content.scrollTop = content.scrollHeight;
  });
  const send = node('button', '↑', 'send'); send.type = 'submit'; send.setAttribute('aria-label', 'Отправить'); send.title = 'Отправить · Ctrl+Enter';
  const stop = button('Стоп', 'stop', function () { controller.stop(); prompt.focus(); }); stop.hidden = true;
  const composerActions = node('div', '', 'composer-actions'); composerActions.append(send, stop);
  composer.append(prompt, budget, composerActions);
  const preview = node('section', '', 'preview'); preview.setAttribute('aria-label', 'Предложение замены');
  const replacement = node('pre', '', 'replacement');
  const reason = node('p', 'Только явное Применить: текущее непустое выделение должно точно совпадать с исходным текстом. Перевыделение такого же текста разрешено. Срок предложения — 120 секунд. Штатный Undo выполняется вручную.', 'apply-reason');
  const apply = button('Применить', 'apply', function () { controller.apply(); }); apply.disabled = true; apply.setAttribute('aria-describedby', 'apply-reason');
  const cancel = button('Отменить предложение', 'cancel-preview', function () { controller.cancelPreview(); prompt.focus(); });
  preview.append(node('h2', 'Предложение'), replacement, reason, apply, cancel);
  let editingConnection = false;
  let dirtyConnection = false;
  let formRevision = null;
  function openConnection() {
    const current = controller.getState();
    if (current.active || current.settingsBusy || current.writeLocked) return;
    closeMenu(); editingConnection = true; dirtyConnection = false;
    renderConnection(current); content.scrollTop = 0; controls.endpoint.focus();
  }
  const changeConnection = button('Настройки подключения', 'change-connection', openConnection);
  menu.append(changeConnection, diagnosticsToggle);
  const connectionError = node('section', '', 'connection-error'); connectionError.hidden = true;
  connectionError.setAttribute('role', 'alert');
  const connectionErrorMessage = node('p', '', 'connection-error-message');
  const repairConnection = button('Настройки подключения', 'repair-connection', openConnection);
  connectionError.append(connectionErrorMessage, repairConnection);
  const settings = node('section', '', 'connection-setup'); settings.append(node('h2', 'Подключение ассистента'));
  settings.append(node('p', 'Настройте один раз для Word, Cell и Slide. Данные сохраняются локально для этого пользователя.'));
  const form = node('form', '', 'settings-form');
  const endpoint = field(form, 'endpoint', 'Полный HTTPS URL /v1/chat/completions'); endpoint.spellcheck = false;
  field(form, 'model', 'Модель (без подмены)');
  const key = field(form, 'apiKey', 'API ключ', 'password'); key.autocomplete = 'off'; key.spellcheck = false;
  const advanced = node('details'); advanced.append(node('summary', 'Дополнительно')); form.append(advanced);
  const timeout = field(advanced, 'httpTimeoutSeconds', 'HTTP тайм-аут, секунд (5–120)', 'number'); timeout.min = '5'; timeout.max = '120'; timeout.step = '1';
  const tokens = field(advanced, 'maxTokens', 'max_tokens (64–8192)', 'number'); tokens.min = '64'; tokens.max = '8192'; tokens.step = '1';
  const temperature = field(advanced, 'temperature', 'temperature (0–2)', 'number'); temperature.min = '0'; temperature.max = '2'; temperature.step = 'any';
  const encryption = node('p', 'API-ключ сохраняется с шифрованием. Доступ к профилю пользователя или работающему Р7 позволяет его использовать.', 'encryption-notice'); encryption.className = 'muted';
  const persistence = node('p', 'Ключ может оставаться в открытом хранилище. Ошибка удаления не означает, что ключ стёрт.', 'persistence-warning'); persistence.setAttribute('aria-live', 'off'); persistence.className = 'notice';
  const storage = node('p', '', 'storage-status');
  const save = node('button', 'Сохранить и проверить', 'save-settings'); save.type = 'submit';
  function draft() {
    return { endpoint: controls.endpoint.value, model: controls.model.value, apiKey: controls.apiKey.value,
      httpTimeoutSeconds: Number(controls.httpTimeoutSeconds.value), maxTokens: Number(controls.maxTokens.value), temperature: Number(controls.temperature.value), rememberKey: true };
  }
  const connectionStatus = node('p', '', 'connection-status'); connectionStatus.setAttribute('role', 'status');
  const reloadConnection = button('Загрузить актуальные настройки', 'reload-connection', function () {
    dirtyConnection = false; renderConnection(controller.getState());
  });
  const cancelConnection = button('Назад', 'cancel-connection', function () {
    editingConnection = false; dirtyConnection = false; renderConnection(controller.getState()); prompt.focus();
  });
  const reset = button('Сбросить настройки', 'reset', async function () {
    if (await controller.resetConnection()) {
      dirtyConnection = false; renderConnection(controller.getState()); controls.endpoint.focus();
    }
  });
  for (const el of Object.values(controls).filter(el => el !== include)) on(el, 'input', function () { dirtyConnection = true; controller.settingsChanged(); });
  on(form, 'submit', async function (event) {
    event.preventDefault();
    const ok = await controller.saveAndTestConnection(draft(), formRevision);
    if (ok) { editingConnection = false; dirtyConnection = false; renderConnection(controller.getState()); prompt.focus(); }
  });
  function renderConnection(state) {
    const configured = Boolean(state.settings.endpoint && state.settings.apiKey);
    const open = editingConnection || !configured;
    settings.hidden = !open; composer.hidden = open; history.hidden = open;
    if (open) { diagnostics.hidden = true; diagnosticsToggle.setAttribute('aria-expanded', 'false'); }
    const failure = state.storageError || (compactAttention.includes(state.status) ? state.status : null);
    connectionError.hidden = open || !failure;
    connectionErrorMessage.textContent = failure ? statusText(failure) : '';
    changeConnection.disabled = state.active || state.settingsBusy || state.writeLocked;
    repairConnection.disabled = changeConnection.disabled;
    repairConnection.hidden = !connectionErrors.has(failure);
    cancelConnection.hidden = !configured; cancelConnection.disabled = state.settingsBusy;
    const conflict = dirtyConnection && formRevision !== (state.settingsRevision ?? null);
    reloadConnection.hidden = !conflict && state.status !== 'SETTINGS_CONFLICT';
    connectionStatus.textContent = conflict ? statusText('SETTINGS_CONFLICT') : state.settingsBusy ? 'Проверка и сохранение подключения…' : state.storageError ? statusText(state.storageError) : statusText(state.status);
    if (!dirtyConnection) {
      formRevision = state.settingsRevision ?? null;
      for (const [name, value] of Object.entries(state.settings)) {
        const control = controls[name]; if (!control) continue;
        control.value = name === 'apiKey' && !open ? '' : String(value);
      }
    }
  }
  function submit() {
    if (controller.getState().active || controller.getState().settingsBusy) return;
    // An explicit new request follows its answer; passive updates still preserve
    // the position of someone reading earlier messages.
    content.scrollTop = content.scrollHeight;
    Promise.resolve(controller.analyze(prompt.value)).then(function () {
      if (controller.getState().status === 'COMPLETE') prompt.focus();
    });
  }
  on(composer, 'submit', function (event) { event.preventDefault(); submit(); });
  on(prompt, 'keydown', function (event) { if (event.key === 'Enter' && event.ctrlKey && !event.isComposing) { event.preventDefault(); submit(); } });
  form.append(encryption, persistence, storage, connectionStatus, reloadConnection, save, cancelConnection, reset); settings.append(form);
  diagnostics.append(lifecycleWarning, toolbar, orchestration, journal);
  content.append(settings, history, progressStage, preview, diagnostics, connectionError);
  root.replaceChildren(header, content, composer);
  let lastHistory = null;
  let lastAgentActions = null;
  let lastConnectionFailure = null;
  const unsubscribe = controller.subscribe(function (state) {
    // Measure before Stop/progress alter the available height. Preserve an intentional
    // scroll into older messages, but keep a reader at the tail with the working stage.
    const followTail = diagnostics.hidden && content.scrollHeight - content.scrollTop - content.clientHeight < 32;
    const record = state.agent ?? null;
    status.textContent = statusText(state.storageError || state.status, true);
    status.setAttribute('data-attention', String(status.textContent === 'Ошибка'));
    const stage = progressStageText(state);
    progressStage.textContent = stage;
    progressStage.hidden = stage === '';
    progressStage.setAttribute('aria-busy', stage === '' ? 'false' : 'true');
    detailedStatus.textContent = state.status === 'ANALYZING' && record?.status === 'RUNNING' && record.steps > 0 ?
      `${statusText(state.status)} · шаг ${record.steps}` : statusText(state.status);
    badge.textContent = `Stage B · редактор: ${state.editorType} · runtimeVerified: false`;
    mode.value = state.mode; include.checked = state.includeContext;
    const locked = state.writeLocked === true;
    const selectionUnavailable = state.editorType === 'cell';
    include.setAttribute('aria-describedby', 'capability-state');
    capabilityPointer.hidden = !selectionUnavailable;
    capabilityState.textContent = capabilityText(state);
    stop.hidden = !state.active;
    stop.disabled = locked;
    send.disabled = state.active || locked || state.settingsBusy; refresh.disabled = state.active || locked; checkR7.disabled = state.active || locked;
    fresh.disabled = locked; reset.disabled = locked || state.active || state.settingsBusy; save.disabled = locked || state.active || state.settingsBusy; mode.disabled = locked;
    for (const control of Object.values(controls)) control.disabled = locked || state.active || state.settingsBusy;
    include.disabled = locked || selectionUnavailable;
    apply.disabled = state.canApply !== true; cancel.disabled = state.active || locked;
    // THE DENOMINATOR BELONGS TO THE EDITOR. A spreadsheet readiness counts TWO booleans — the bridge's own adapter
    // flags — while a document counts SIX Word primitives, and printing "N / 6" for a spreadsheet told the user a
    // Word-shaped truth (the Astra run recorded exactly that string). The sentence after the count is editor-specific
    // for the same reason: on a spreadsheet the check is about the adapter, not about Word's selection and undo.
    const capabilityCeiling = state.editorType === 'cell' ? 2 : 6;
    capabilitySummary.textContent = Number.isInteger(state.capabilityCount) && state.capabilityCount >= 0 && state.capabilityCount <= capabilityCeiling ?
      (state.editorType === 'cell'
        ? `Наличие API: ${state.capabilityCount} / ${capabilityCeiling}. Проверка подтверждает только готовность адаптера; она не разрешает Применить.`
        : `Наличие API: ${state.capabilityCount} / ${capabilityCeiling}. Область, форматирование и отмена этой проверкой не подтверждены; она не разрешает Применить.`) : '';
    context.textContent = contextText(state.context);
    selected.textContent = state.context.text;
    if (lastHistory !== state.chat.history) {
      // History appends pairs and may evict old pairs at its byte cap. Keep the
      // retained suffix mounted: focused Markdown links must survive a reply.
      const previous = lastHistory ?? [];
      const next = state.chat.history;
      let retained = 0;
      for (let start = 0; start < previous.length; start += 1) {
        const suffix = previous.slice(start);
        if (suffix.length <= next.length && suffix.every((entry, index) => entry.role === next.at(index).role && entry.content === next.at(index).content)) {
          retained = suffix.length; break;
        }
      }
      for (let removed = previous.length - retained; removed > 0; removed -= 1) history.removeChild(history.children[0]);
      lastHistory = state.chat.history;
      const entries = state.chat.history.slice(retained).map(function (entry) {
        const article = node('article');
        const role = entry.role === 'user' ? 'user' : 'assistant';
        article.className = `message message-${role}`;
        article.setAttribute('data-role', role);
        const roleLabel = node('span', role === 'user' ? 'Вы' : 'Ассистент'); roleLabel.className = 'message-role';
        const body = node('div'); body.className = 'message-body';
        if (role === 'assistant') renderMarkdown(body, entry.content);
        else body.textContent = entry.content;
        article.append(roleLabel, body);
        return article;
      });
      history.append(...entries);
    }
    preview.hidden = !state.preview;
    replacement.textContent = state.preview?.replacement ?? '';
    const lines = Array.isArray(record?.actions) ? record.actions : [];
    if (lastAgentActions !== lines) {
      lastAgentActions = lines;
      // One paragraph per action: `tool: outcome`, plus the closed code when the action failed.
      // textContent only — a fixed, authored line, never a serialized model object.
      journal.replaceChildren(...lines.map(entry => node('p', entry.code === undefined ? `${entry.tool}: ${entry.outcome}` : `${entry.tool}: ${entry.outcome} (${entry.code})`)));
    }
    journal.hidden = lines.length === 0 && record?.status !== 'RUNNING';
    const report = orchestrationText(state.orchestration);
    orchestration.textContent = report;
    orchestration.hidden = report === '';
    persistence.hidden = !state.keyPersistenceWarning;
    storage.textContent = state.storageError ? statusText(state.storageError) : '';
    const connectionFailure = state.storageError || (compactAttention.includes(state.status) ? state.status : null);
    const newConnectionFailure = connectionFailure && connectionFailure !== lastConnectionFailure;
    lastConnectionFailure = connectionFailure;
    renderConnection(state);
    if (followTail || newConnectionFailure && !connectionError.hidden) content.scrollTop = content.scrollHeight;
  });
  const win = doc.defaultView;
  let syncTimer = null;
  function refreshConnection() { controller.syncSettings?.(); }
  if (win) {
    on(win, 'focus', refreshConnection); on(doc, 'visibilitychange', refreshConnection);
    syncTimer = win.setInterval(function () { refreshConnection(); }, 2000);
    refreshConnection();
  }
  return Object.freeze({ dispose() { unsubscribe(); if (syncTimer !== null) win.clearInterval(syncTimer); for (const handler of handlers) handler.el.removeEventListener(handler.name, handler.handler); } });
}
