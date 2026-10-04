import { utf8ByteLength } from '../shared/bytes.js';

const statuses = Object.freeze({
  CHECKING_R7: 'Проверка наличия API Р7…', R7_PRESENCE_READY: 'Проверка наличия API завершена. Документ не изменён.', R7_CHECK_UNAVAILABLE: 'Проверка Р7 недоступна для этого редактора / моста. API не угадываются.',
  READY: 'Готово к запросу', ANALYZING: 'Анализ…', CONNECTING: 'Проверка соединения…', CONNECTION_OK: 'Соединение проверено',
  READING_CONTEXT: 'Чтение выделения…', CONTEXT_READY: 'Контекст прочитан', CONTEXT_CHANGED: 'Контекст изменился. Прочитайте выделение заново.',
  COMPLETE: 'Ответ получен', PREVIEW_READY: 'Предложение готово. Документ не изменён.', PREVIEW_EXPIRED: 'Срок предложения истёк', PREVIEW_CANCELLED: 'Предложение отменено. Документ не изменён.',
  SETTINGS_CHANGED: 'Настройки изменены; предыдущий запрос и предложение недействительны', SETTINGS_SAVED: 'Настройки применены', STOPPED: 'Запрос остановлен. Поздние ответы не используются.',
  AGENT_LIMIT: 'Достигнут предел выполнения задачи. Результат неполный; проверьте документ.',
  INVALID_SETTINGS: 'Проверьте настройки соединения', INVALID_ENDPOINT: 'Нужен полный HTTPS URL с окончанием /v1/chat/completions', INVALID_KEY: 'Введите корректный ключ',
  INVALID_DATA: 'Некорректные данные', BYTE_LIMIT: 'Превышен лимит UTF-8 для ввода, выделения или ответа; текст не обрезается.',
  STORAGE_UNAVAILABLE: 'Хранилище недоступно; настройки остаются в памяти', STORAGE_CORRUPT: 'Сохранённые настройки повреждены', INTERNAL_ERROR: 'Не удалось завершить операцию',
  PROTOCOL_ERROR: 'Ответ не соответствует разрешённому JSON формату', HTTP_UNAUTHORIZED: 'Сервер отклонил ключ (401)', HTTP_FORBIDDEN: 'Доступ запрещён (403)', HTTP_RATE_LIMIT: 'Лимит запросов (429); автоматического повтора нет',
  HTTP_SERVER_ERROR: 'Ошибка сервера', HTTP_ERROR: 'HTTP запрос не выполнен', NETWORK_ERROR: 'Сеть / DNS / CORS / TLS: соединение не выполнено. Проверка сертификата не отключается.',
  OFFLINE: 'Нет сети', CANCELLED: 'Операция отменена', TIMEOUT: 'Время ожидания истекло', CAPABILITY_UNAVAILABLE: 'Возможность недоступна. Безопасность изменения документа не доказана.',
  CHECKING_SELECTION: 'Проверка текущего редактора и выделения…', APPLYING: 'Команда замены отправлена. Её нельзя отменить; ожидается квитанция SDK.',
  APPLY_ACKNOWLEDGED: 'SDK подтвердил команду. Это не подтверждает изменение текста и форматирования; проверьте документ. Для отмены используйте штатный Undo.',
  APPLY_UNCERTAIN: 'Исход команды неизвестен; результат не доказан. Проверьте документ. Автоматического повтора и отката нет; незавершённый вызов блокирует изменения.',
  SELECTION_CHANGED: 'Выделение изменилось. Повторите команду',
  EDITOR_BUSY: 'Редактор занят / исход предыдущего вызова неизвестен. Дождитесь его завершения; новый мост не создаётся.', EDITOR_ERROR: 'Не удалось получить результат редактора'
});
export function statusText(code) { return statuses[code] ?? statuses.INTERNAL_ERROR; }
function contextText(value) {
  if (value.kind === 'UNAVAILABLE') return 'Чтение выделения недоступно для этого редактора';
  if (value.kind === 'EMPTY') return 'Выделение пустое';
  if (value.kind === 'EXACT') return `Прочитано точно: ${value.bytes} байт UTF-8 (не подтверждение цели)`;
  return 'Выделение неизвестно';
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
  const badge = node('p', 'Stage B · только предложение', 'editor'); badge.className = 'muted';
  const fresh = button('Новый чат', 'new-chat', function () { controller.newChat(); prompt.focus(); });
  header.append(title, badge, fresh);
  const status = node('p', '', 'status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.setAttribute('aria-atomic', 'true');
  const lifecycleWarning = node('p', 'Обычный текст Word; активное отслеживание изменений не поддерживается. Перед Применить проверяются текущий редактор, контекст и точное непустое выделение. Проверка и запись не атомарны.'); lifecycleWarning.className = 'notice';
  const toolbar = node('section'); toolbar.setAttribute('aria-label', 'Режим и контекст');
  const modeLabel = node('label', 'Режим'); modeLabel.htmlFor = 'mode';
  const mode = node('select', '', 'mode');
  for (const [value, label] of [['ASK', 'ASK — спросить'], ['EDIT', 'EDIT — предложить замену']]) { const option = node('option', label); option.value = value; mode.append(option); }
  on(mode, 'change', function () { controller.setMode(mode.value); });
  const include = field(toolbar, 'include-context', 'Передавать только выделенный текст', 'checkbox');
  on(include, 'change', function () { controller.setIncludeContext(include.checked); });
  const checkR7 = button('Проверить Р7', 'check-r7', function () { controller.checkR7(); });
  const capabilitySummary = node('p', '', 'r7-capabilities'); capabilitySummary.setAttribute('aria-live', 'polite');
  const refresh = button('Прочитать выделение', 'read-context', function () { controller.refreshContext(); });
  const context = node('p', '', 'context'); context.setAttribute('aria-live', 'polite');
  const selected = node('pre', '', 'selected-text');
  const contextDetails = node('details'); contextDetails.append(node('summary', 'Прочитанный текст'), selected);
  toolbar.append(modeLabel, mode, refresh, checkR7, capabilitySummary, context, contextDetails);
  const history = node('section', '', 'history'); history.setAttribute('aria-label', 'История чата');
  // The actions summary is a technical, content-free record: the tool name, the closed outcome and,
  // for a failed action, its closed code. It is rendered with textContent only, so no raw model JSON,
  // tool argument or document text can ever reach the DOM.
  const actions = node('section', '', 'actions'); actions.setAttribute('aria-live', 'polite'); actions.setAttribute('aria-label', 'Журнал действий');
  const composer = node('form', '', 'composer');
  const promptLabel = node('label', 'Запрос'); promptLabel.htmlFor = 'prompt';
  const prompt = node('textarea', '', 'prompt'); prompt.rows = 4; prompt.setAttribute('aria-describedby', 'input-budget');
  const budget = node('p', '0 / 8192 байт UTF-8 · Ctrl+Enter — отправить', 'input-budget'); budget.className = 'muted';
  on(prompt, 'input', function () { budget.textContent = `${utf8ByteLength(prompt.value)} / 8192 байт UTF-8 · Ctrl+Enter — отправить`; });
  const send = node('button', 'Отправить', 'send'); send.type = 'submit';
  const stop = button('Стоп', 'stop', function () { controller.stop(); prompt.focus(); });
  composer.append(promptLabel, prompt, budget, send, stop);
  const preview = node('section', '', 'preview'); preview.setAttribute('aria-label', 'Предложение замены');
  const replacement = node('pre', '', 'replacement');
  const reason = node('p', 'Только явное Применить: текущее непустое выделение должно точно совпадать с исходным текстом. Перевыделение такого же текста разрешено. Срок предложения — 120 секунд. Штатный Undo выполняется вручную.', 'apply-reason');
  const apply = button('Применить', 'apply', function () { controller.apply(); }); apply.disabled = true; apply.setAttribute('aria-describedby', 'apply-reason');
  const cancel = button('Отменить предложение', 'cancel-preview', function () { controller.cancelPreview(); prompt.focus(); });
  preview.append(node('h2', 'Предложение'), replacement, reason, apply, cancel);
  const settings = node('details'); settings.append(node('summary', 'Настройки соединения'));
  const form = node('form', '', 'settings-form');
  const endpoint = field(form, 'endpoint', 'Полный HTTPS URL /v1/chat/completions'); endpoint.spellcheck = false;
  field(form, 'model', 'Модель (без подмены)');
  const key = field(form, 'apiKey', 'API ключ', 'password'); key.autocomplete = 'off'; key.spellcheck = false;
  const timeout = field(form, 'httpTimeoutSeconds', 'HTTP тайм-аут, секунд (5–120)', 'number'); timeout.min = '5'; timeout.max = '120'; timeout.step = '1';
  const tokens = field(form, 'maxTokens', 'max_tokens (64–8192)', 'number'); tokens.min = '64'; tokens.max = '8192'; tokens.step = '1';
  const temperature = field(form, 'temperature', 'temperature (0–2)', 'number'); temperature.min = '0'; temperature.max = '2'; temperature.step = 'any';
  field(form, 'rememberKey', 'Запомнить ключ в незашифрованном хранилище', 'checkbox').setAttribute('aria-describedby', 'plaintext-warning persistence-warning');
  const plaintext = node('p', 'По умолчанию ключ только в памяти. Опция «Запомнить» сохраняет ключ открытым текстом. Это не защищённое хранилище.', 'plaintext-warning'); plaintext.className = 'notice';
  const persistence = node('p', 'Ключ может оставаться в открытом хранилище. Ошибка удаления не означает, что ключ стёрт.', 'persistence-warning'); persistence.setAttribute('role', 'status'); persistence.className = 'notice';
  const storage = node('p', '', 'storage-status');
  const save = node('button', 'Применить настройки', 'save-settings'); save.type = 'submit';
  function draft() {
    return { endpoint: controls.endpoint.value, model: controls.model.value, apiKey: controls.apiKey.value,
      httpTimeoutSeconds: Number(controls.httpTimeoutSeconds.value), maxTokens: Number(controls.maxTokens.value), temperature: Number(controls.temperature.value), rememberKey: controls.rememberKey.checked };
  }
  function saveDraft() { return controller.saveSettings(draft()); }
  const test = button('Проверить соединение', 'test-connection', function () { if (saveDraft()) controller.testConnection(); });
  const reset = button('Сбросить настройки', 'reset', function () { controller.reset(); controls.endpoint.focus(); });
  for (const el of Object.values(controls).filter(el => el !== include)) on(el, 'input', function () { controller.settingsChanged(); });
  on(form, 'submit', function (event) { event.preventDefault(); saveDraft(); });
  function submit() { if (controller.getState().active) return; if (saveDraft()) controller.analyze(prompt.value); }
  on(composer, 'submit', function (event) { event.preventDefault(); submit(); });
  on(prompt, 'keydown', function (event) { if (event.key === 'Enter' && event.ctrlKey && !event.isComposing) { event.preventDefault(); submit(); } });
  form.append(plaintext, persistence, storage, save, test, reset); settings.append(form);
  root.replaceChildren(header, status, lifecycleWarning, toolbar, history, composer, preview, actions, settings);
  let lastSettings = null;
  let lastHistory = null;
  let lastAgentActions = null;
  const unsubscribe = controller.subscribe(function (state) {
    const record = state.agent ?? null;
    status.textContent = state.status === 'ANALYZING' && record?.status === 'RUNNING' && record.steps > 0 ?
      `${statusText(state.status)} · шаг ${record.steps}` : statusText(state.status);
    badge.textContent = `Stage B · редактор: ${state.editorType} · runtimeVerified: false`;
    mode.value = state.mode; include.checked = state.includeContext;
    const locked = state.writeLocked === true;
    stop.disabled = !state.active || locked;
    send.disabled = state.active || locked; test.disabled = state.active || locked; refresh.disabled = state.active || locked; checkR7.disabled = state.active || locked;
    fresh.disabled = locked; reset.disabled = locked; save.disabled = locked; mode.disabled = locked;
    for (const control of Object.values(controls)) control.disabled = locked;
    apply.disabled = state.canApply !== true; cancel.disabled = state.active || locked;
    capabilitySummary.textContent = Number.isInteger(state.capabilityCount) && state.capabilityCount >= 0 && state.capabilityCount <= 6 ?
      `Наличие API: ${state.capabilityCount} / 6. Область, форматирование и отмена этой проверкой не подтверждены; она не разрешает Применить.` : '';
    context.textContent = contextText(state.context);
    selected.textContent = state.context.text;
    if (lastHistory !== state.chat.history) {
      lastHistory = state.chat.history;
      const entries = state.chat.history.map(function (entry) { const article = node('article'); article.append(node('h2', entry.role === 'user' ? 'Вы' : 'Ассистент / предложение'), node('pre', entry.content)); return article; });
      history.replaceChildren(...entries);
    }
    preview.hidden = !state.preview;
    replacement.textContent = state.preview?.replacement ?? '';
    const lines = Array.isArray(record?.actions) ? record.actions : [];
    if (lastAgentActions !== lines) {
      lastAgentActions = lines;
      // One paragraph per action: `tool: outcome`, plus the closed code when the action failed.
      // textContent only — a fixed, authored line, never a serialized model object.
      actions.replaceChildren(...lines.map(entry => node('p', entry.code === undefined ? `${entry.tool}: ${entry.outcome}` : `${entry.tool}: ${entry.outcome} (${entry.code})`)));
    }
    actions.hidden = lines.length === 0 && record?.status !== 'RUNNING';
    persistence.hidden = !state.keyPersistenceWarning;
    storage.textContent = state.storageError ? statusText(state.storageError) : '';
    if (lastSettings !== state.settings) {
      lastSettings = state.settings;
      for (const [name, value] of Object.entries(state.settings)) { const fieldControl = controls[name]; if (!fieldControl) continue; if (name === 'rememberKey') fieldControl.checked = value; else fieldControl.value = String(value); }
    }
  });
  return Object.freeze({ dispose() { unsubscribe(); for (const handler of handlers) handler.el.removeEventListener(handler.name, handler.handler); } });
}
