# R7 AI Assistant

Самостоятельный коммерческий AI-помощник внутри Р7 Desktop для документов, таблиц и презентаций. DeepSeek Harness используется только при разработке; продукт не является его плагином и не продолжает dsh-r7-office.

## Статус

Bootstrap. Pilot RC **не выпущен**. Целевая версия: `0.9.0-pilot-rc`.
Этап B — блокирующий gate: embedded UI, selection и прямой HTTPS должны быть подтверждены на точной Astra/Р7 до реализации следующих этапов. Наличие checkpoint не доказывает совместимость.

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
- [Этапы](docs/roadmap.md)
- [Лицензирование](docs/licensing.md)
- [ADR](docs/decisions/0001-embedded-runtime-and-compatibility-gate.md)

Локальный Git — источник истины. Remote отсутствует; публикация запрещена без отдельной команды. Secrets, пользовательские endpoints, персональные данные и содержимое рабочих документов не коммитятся.
