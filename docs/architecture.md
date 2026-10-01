# Architecture

## Intent and boundaries

Сотрудник работает с открытым документом внутри Р7; обычный чат скрывает технический JSON/tool loop. ASK не изменяет документ; EDIT предлагает и применяет проверенные изменения. Пользователь сам задаёт подключение; история только в памяти. Production self-contained кроме HTTPS к настроенному AI endpoint.

## Decision

Предпочтён штатный visual inside plugin для word/cell/slide. `isVisual: true`, `isInsideMode: true`, `isModal: false` — требования, ещё не подтверждённые runtime. Размещение штатное, без UI-хаков. Node/OOXML/MCP reference не является production implementation.

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

Перед Apply повторно проверить editor/selection/context; при изменении отказаться, а не применить к другому объекту. Не уничтожать неизвестные объекты, не Save автоматически; проверить native undo по каждой категории.

## Architectural gate

A/B обязательны перед C–M: точный runtime и пути, SDK/API, inside UI, selection read/replace с сохранением форматирования, direct HTTPS POST с Authorization и X-Session-ID. CORS, preflight, CA и ошибки проверяются в реальном CEF, не только в Node/browser mock. Статус сейчас NOT RUN. Недоступность guest — environment access dependency, а не доказательство архитектурной невозможности.
