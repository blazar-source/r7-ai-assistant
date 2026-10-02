# Architecture

## Intent and boundaries

Сотрудник работает с открытым документом внутри Р7; обычный чат скрывает технический JSON/tool loop. ASK не изменяет документ; EDIT предлагает и применяет проверенные изменения. Пользователь сам задаёт подключение; история только в памяти. Production self-contained кроме HTTPS к настроенному AI endpoint.

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

## Architectural gate

Точный target: Astra Linux SE1.7.9.41 advanced(voronezh), x86_64/kernel6.1.152-1-generic/X11-Fly; R7 Office2026.1.2.1942. [Historical Stage B NOT PASS](<stage-b-gate-report.md>) сохраняет прежние измерения; fresh practical Sprint 1 acceptance NOT RUN, docs reconciliation IN PROGRESS, Apply disabled. Active authority: [amended design](<superpowers/specs/2026-10-02-compatibility-vertical-slice-design.md>) / [Sprint 1 plan](<superpowers/plans/2026-10-02-sprint-1-practical-selection-editing.md>); [eight-sprint roadmap](<roadmap.md>), only Sprint 1 authorized.

Direct CEF HTTPS mock POST/OPTIONS, CORS ON/OFF, Authorization/X-Session-ID, timeout/redirect/diagnostics требуют native evidence, не Node/browser mock substitute. Closed prior evidence переиспользуется с явной provenance; retest только missing scenarios/relevant integration changes. Bank TLS/CORS/AUTH/Qwen NOT RUN до internal bank installation; no real-model calls in Sprint 1. Runtime FAIL escalation/cleanup — [test plan](<test-plan.md>). Недоступность guest — environment dependency, не доказательство SDK impossibility.
