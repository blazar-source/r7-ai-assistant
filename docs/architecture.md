# Architecture

## Intent and boundaries

Сотрудник работает с открытым документом внутри Р7; обычный чат скрывает технический JSON/tool loop. ASK не изменяет документ (каталог без mutation-tools); EDIT исполняет allowlisted tools, каждый по своей policy (auto | confirm | deny), где Preview/Apply — политика конкретного инструмента, а не общий шлюз для всех изменений. Пользователь сам задаёт подключение; история только в памяти. Production self-contained кроме HTTPS к настроенному AI endpoint.

## Decision

Предпочтён штатный visual inside plugin для word/cell/slide. `isVisual: true`, `isInsideMode: true`, `isModal: false` — требования; narrow native all-three inside UI evidence сохранено в [матрице](<compatibility-matrix.md>), не доказательство API parity/mutation. Размещение штатное, без UI-хаков. Node/OOXML/MCP reference не является production implementation.

Альтернативы: внешний bridge/daemon отвергнут требованиями; zero-port embedded integration исследуется только при доказанном невозможном direct HTTPS, без автоматического изменения архитектуры или AI Hub.

## Components and contracts

- `plugin`: lifecycle, callbacks и статические author-written `callCommand` handlers; никаких model-written scripts.
- `ui`: чат, настройки, контекст, ASK/EDIT, preview/Apply/Cancel, статусы и остановка.
- `agent`: последовательный bounded loop, conversation, JSON repair, cancellation; не знает UI хранения настроек.
- `ai`: immutable strict-bank request shape и content-only response, HTTPS, timeout и error taxonomy.
- `tools`: allowlist каталог + JSON Schemas + editor capabilities; неподтверждённые инструменты недоступны.
- `security`: strict schema/policy validation, budgets, confirmation, stale-context guard и безопасные технические события.
- `shared`: типы протокола, configuration-provider interface, context budgets.

Configuration provider возвращает validated effective settings; UI использует capability flags editable/locked без изменения agent. Сейчас все настройки editable. Managed settings/roles/provisioning не реализуются.

## Flow

User → bounded trusted command + untrusted selected context → AI text → strict JSON parse/schema → policy → preview if mutation → user approval → static R7 handler → bounded tool result → следующий AI запрос → final.

Sprint 1: user selection → read → AI proposal → Preview → explicit Apply → check same current document/editor → reread existing nonempty selection → exact original-text comparison → public native replacement. Несовпадение: no write, «Выделение изменилось. Повторите команду». Пользователь может вручную выделить другой идентичный текст в том же document/editor. Immutable locator/revision/ABA/object identity of identical text/atomic transaction не требуются; asynchronous reread/write не атомарны.

Первой поддерживается обычная текстовая selection; practically known unsupported/ambiguous selections отклоняются через public checks. Не обещать universal SmartArt/complex fields/tracked changes/OLE/mixed-rich support и не требовать exhaustive ideal-object inventory. Try ReplaceTextSmart first, then PasteText, then static Document API callCommand только после конкретного failed scenario. Native results, а не presence flags, определяют выбор; измерить font/size/bold/italic/color/paragraph style/surrounding text и native Undo на disposable fixtures. No private API/AGPL copying/model-generated executable code/automatic Save.

One active operation/one callback slot; callback5000ms, analysis/connection150000ms, HTTP5–120s(default30), previewTTL120000ms, Apply observation15000ms. После write dispatch конфликтующие controls выключены, busy/uncertain ownership сохраняется до definite settlement; нет uncertain-write retry или обещания cancellation/rollback.

## Current bounded Apply implementation

Reviewed cb291d7 uses [two static public read-only commands](<../src/plugin/commands.js#L3-L40>): the old six-position method-presence probe is not a mutation guard; the separate actual-context tuple reads the public document ID and tracking state. GetSelectionType is DOCS ONLY, not a native gate. Ordinary Word support is bounded, not a universal rich classifier.

[Private ownership and Apply](<../src/plugin/bridge.js#L93-L114>) combine live SDK-frame/bridge/editor ownership, per-bridge WeakMap brand and actual public ID within that context. Before write: current ID/support/tracking → exact nonempty selection reread → context recheck → one public data-only ReplaceTextSmart. No raw ID/ownership record enters public DTO/model/history/log/storage or a serialized certificate. Equal IDs cannot grant a foreign brand; global ID uniqueness is not promised. Movement alone/repeated same-editor init preserve unexpired Preview; genuine context changes invalidate it.

[Callback slot](<../src/plugin/bridge.js#L135-L211>) and permanent SDK WeakSet lease survive Stop/timeout/dispose. Late actual callback releases only its own slot, never publishes stale content. Callback receipt is not native effect proof; no retry/autoSave/authored Undo. See [evidence and pending native checks](<sprint-1-progress.md>).

## Architectural gate

Точный target: Astra Linux SE1.7.9.41 advanced(voronezh), x86_64/kernel6.1.152-1-generic/X11-Fly; R7 Office2026.1.2.1942. [Historical Stage B NOT PASS](<stage-b-gate-report.md>) сохраняет прежние измерения; [current Sprint 1 evidence](<sprint-1-progress.md>) separates measured DEV probe prerequisite GO, independently reviewed cb291d7 source candidate with Apply implemented, and Task 4 IN PROGRESS with scoped R10–R17 candidate native evidence, including integrated Preview/Apply/formatting/Undo; remaining gates are explicit and whole Task 4 / Stage B is NOT PASS. Task 1 done / Task 3 reviewed; old installed production Apply OFF is historical, not the current candidate. Active authority: [amended design](<superpowers/specs/2026-10-02-compatibility-vertical-slice-design.md>) / [Sprint 1 plan](<superpowers/plans/2026-10-02-sprint-1-practical-selection-editing.md>); [eight-sprint roadmap](<roadmap.md>), only Sprint 1 authorized.

Direct CEF HTTPS mock POST/OPTIONS, CORS ON/OFF, Authorization/X-Session-ID, timeout/redirect/diagnostics требуют native evidence, не Node/browser mock substitute. Closed prior evidence переиспользуется с явной provenance; retest только missing scenarios/relevant integration changes. Bank TLS/CORS/AUTH/Qwen NOT RUN до internal bank installation; no real-model calls in Sprint 1. Runtime FAIL escalation/cleanup — [test plan](<test-plan.md>). Недоступность guest — environment dependency, не доказательство SDK impossibility.
