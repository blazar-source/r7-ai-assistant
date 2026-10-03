# R7 AI Assistant

Самостоятельный коммерческий AI-помощник внутри Р7 Desktop для документов, таблиц и презентаций. DeepSeek Harness используется только при разработке; продукт не является его плагином и не продолжает dsh-r7-office.

## Статус

Pilot RC **не выпущен**. Целевая версия: `0.9.0-pilot-rc`. [Исторический Stage B NOT PASS](<docs/stage-b-gate-report.md>) не пересчитан в PASS.
Принят [план восьми спринтов](<docs/roadmap.md>); разрешён только [Sprint 1](<docs/superpowers/plans/2026-10-02-sprint-1-practical-selection-editing.md>): practical selection editing с Preview, explicit Apply, same current document/editor check, current-selection reread и exact text comparison. Task 1 done; Task 2 measured DEV probe prerequisite GO (N09 branch PARTIAL); Task 3 Apply implemented in independently reviewed local candidate cb291d7. [Текущие доказательства и ограничения](<docs/sprint-1-progress.md>): integrated native Preview/Apply on this candidate NOT RUN, Task 4 pending; installed old production Apply OFF не является текущим source contract. Host tests не native proof; bank TLS/CORS/AUTH/Qwen NOT RUN, real-model calls в Sprint 1 запрещены.

## Runtime

Только встроенный browser plugin: Chat UI → Context Manager → bounded JSON Agent Runtime → Security Validator → allowlisted R7 Plugin API tools / HTTPS AI adapter.
Нет Node runtime, MCP, daemon, localhost, WebSocket, CDN, telemetry, автоматического сохранения документа.

## Документы

- [Архитектура](docs/architecture.md)
- [Целевая среда и наблюдения](docs/target-environment.md)
- [Протокол AI](docs/ai-protocol.md)
- [Безопасность](docs/security.md)
- [Установка](docs/deployment.md)
- [План проверки](docs/test-plan.md)
- [Матрица совместимости](docs/compatibility-matrix.md)
- [Спецификация vertical slice](docs/superpowers/specs/2026-10-02-compatibility-vertical-slice-design.md)
- [Этапы](docs/roadmap.md)
- [Лицензирование](docs/licensing.md)
- [ADR](docs/decisions/0001-embedded-runtime-and-compatibility-gate.md)

Локальный Git — источник истины. Remote отсутствует; публикация запрещена без отдельной команды. Secrets, пользовательские endpoints, персональные данные и содержимое рабочих документов не коммитятся.
