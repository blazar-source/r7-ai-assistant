# R7 AI Assistant — full product roadmap to `0.9.0-pilot-rc`

## Status

- Original product roadmap designed on **2026-10-02**.
- Recovered into the repository on **2026-10-06** from the preserved project-conversation artifact.
- Этот документ фиксирует исходную восьмиспринтовую продуктовую ветку.
- Это **НЕ** означает, что файл существовал в Git раньше.
- Текущие более новые sprint-specific specs/plans имеют приоритет при расхождении деталей.

**Как читать этот документ.** Он хранит **исходный продуктовый замысел** — цели, scope и критерии PASS
каждого спринта в том виде, в каком они были спроектированы. Это **не** отчёт о выполнении: критерии PASS
ниже — это замысел, а **фактические текущие статусы** Sprint 1–4 живут в
[`docs/roadmap.md`](roadmap.md) и в соответствующих authoritative docs/коммитах. Никакой Sprint не
считается выполненным на основании этого документа.

## Зависимости спринтов

```
Stage B / real editing
        ↓
Generic Agent Runtime
        ↓
Word / Cell / Slide tool catalogues
        ↓
Unified UX + security hardening
        ↓
Packaging + Astra/ZPS
        ↓
0.9.0-pilot-rc
```

Word, Cell и Slide являются **независимыми editor-ветками** после общего Agent Runtime.
Рабочая последовательность: **Word → Cell → Slide**.

## Precedence / supersession

При расхождении деталей действует следующий порядок приоритета:

1. Security/architecture **ADRs** и более новые **accepted specs**.
2. **Sprint-specific accepted plan**.
3. **Этот full product roadmap**.
4. Старые **historical/bootstrap** документы.

То есть full roadmap хранит исходный продуктовый замысел, но **не может воскресить** устаревший
universal Preview, старые limits или отменённые исследовательские ветки. Конкретно:

- Sprint 2: более новый
  [`docs/superpowers/specs/2026-10-04-sprint-2-agent-runtime-design.md`](superpowers/specs/2026-10-04-sprint-2-agent-runtime-design.md)
  имеет приоритет над исходной формулировкой этого документа.
- Sprint 3: более новый
  [`docs/superpowers/plans/2026-10-04-sprint-3-word-tools.md`](superpowers/plans/2026-10-04-sprint-3-word-tools.md)
  и фактически реализованный Word Tool Registry имеют приоритет над исходным high-level scope.
- Sprint 4: текущий
  [`docs/superpowers/plans/2026-10-06-sprint-4-cell-tools.md`](superpowers/plans/2026-10-06-sprint-4-cell-tools.md)
  является authoritative Sprint 4 plan и **расширяет** исходную рамку ниже.

---

## SPRINT 1 — Working Word selection editing / Stage B

**Цель:** получить проверенный сценарий
`selection → user request → Preview → Apply → native Undo`.

**Исходный scope:**

- mutation contract;
- проверка document/editor;
- reread selection перед заменой;
- отказ при изменённом selection;
- `ReplaceTextSmart` → `PasteText` → static Document API только при необходимости;
- обычный text selection;
- оставшиеся Stage B settings/session/diagnostics gates.

**Native acceptance:**

- целевая Astra + R7 `2026.1.2.1942`;
- changed/empty selection;
- другой document/editor;
- font/size/bold/italic/color/paragraph style;
- untouched surrounding text;
- native Undo;
- HTTPS mock/network;
- settings restart/Reset;
- chat/Test session attribution.

**Исходный PASS:** selection contract работает, свойства сохраняются, Undo возвращает исходник,
unsupported cases **не мутируют** документ.

## SPRINT 2 — Generic JSON Agent Runtime

**Цель:** перейти от one-shot editing к **bounded multi-step agent**.

**Исходный scope:**

- bounded sequential loop;
- extensible Tool Registry;
- closed schemas;
- controlled JSON repair;
- step/time/context/result guardrails;
- ASK/EDIT;
- существующий HTTPS transport;
- development Qwen.

**Native/runtime acceptance:**

- direct CEF HTTPS;
- final response;
- read-tool chain;
- malformed JSON + repair;
- Stop/timeout;
- модель не может обходить security/tool allowlist.

**ВАЖНО (более новый документ имеет приоритет):**
[`docs/superpowers/specs/2026-10-04-sprint-2-agent-runtime-design.md`](superpowers/specs/2026-10-04-sprint-2-agent-runtime-design.md)
приоритетен над исходной формулировкой. В частности:

- нет universal Preview/Apply;
- policy определяется инструментом: `auto | confirm | deny`;
- ordinary mutations могут быть `auto`;
- `replace_selection` остаётся отдельным `confirm` flow;
- никакого model-generated executable code.

## SPRINT 3 — Practical Word tools

**Цель:** обычная полезная работа с DOCX.

**Исходный scope:**

- selection/paragraph context;
- rewrite / shorten / correct / translate;
- insertion and formatting of ordinary text;
- lists;
- simple tables;
- capability-based refusal;
- SmartArt/OLE/complex tracked/rich internals **вне scope**.

**Acceptance:**

- типовые DOCX workflows;
- formatting;
- native Undo;
- untouched/unsupported content preserved;
- Save/reopen.

Более новый Sprint 3 plan и фактически реализованный Word Tool Registry имеют приоритет над исходным
high-level scope.

## SPRINT 4 — Practical spreadsheet tools

**Цель:** основные spreadsheet workflows.

**Исходный scope:**

- selected/ranged data reading;
- values/formulas;
- styles;
- worksheet creation;
- workbook/sheet/range targeting;
- safe refusals.

**Acceptance:**

- values/formulas/references/styles;
- several sheets;
- protection/merged-range limitations;
- native Undo;
- Save/reopen;
- untouched cells preserved.

**ВАЖНО:** текущий
[`docs/superpowers/plans/2026-10-06-sprint-4-cell-tools.md`](superpowers/plans/2026-10-06-sprint-4-cell-tools.md)
является актуальным authoritative Sprint 4 plan и **расширяет** эту исходную рамку. Сохраняются его
**T1–T5**, corrective **T2 formulas** task и **P&L exit gate**; ничего из текущего Sprint 4 не
откатывается.

## SPRINT 5 — Practical presentation tools

**Цель:** обычная работа с презентациями.

**Исходный scope:**

- чтение текущего slide;
- чтение доступных text objects;
- replacement/editing текста;
- основные styles;
- добавление простых objects;
- добавление slides;
- ограниченные slide operations;
- проверка актуальной presentation/slide/target перед mutation;
- unsupported objects сохраняются и **не** конвертируются автоматически.

**Native acceptance:**

- обычные PPTX slides;
- text boxes;
- placeholders;
- theme/layout inheritance;
- formatting;
- native Undo;
- user Save/reopen;
- остальные объекты презентации не повреждаются.

**PASS:** поддерживаемые presentation workflows работают, layout/theme и незатронутые objects
сохраняются.

**Итог:** verified presentation toolset + PPTX acceptance suite.

**Sprint 5 пока НЕ авторизовать к реализации.** Сейчас фиксируется только его исходный scope.

## SPRINT 6 — Unified UX and security hardening

**Цель:** собрать Word/Cell/Slide adapters в единый устойчивый продукт.

**Scope:**

- единые chat/context/progress/Preview/error states;
- capability-aware UI;
- понятное отображение ограничений;
- connection diagnostics;
- practical context-budget improvements;
- conversation handling;
- prompt/document injection protections;
- malformed tool arguments;
- cancellation;
- lifecycle tests;
- **не** переписывать работающие settings/transport без реального дефекта.

**Native acceptance:**

- полные Word/Cell/Slide user journeys;
- смена document/editor;
- закрытие панели;
- Stop;
- Reset;
- New chat;
- CSP/offline;
- отсутствие утечки key/content;
- отсутствие зависших operations;
- AI/SDK error behaviour.

**PASS:** поддерживаемые workflows понятны пользователю; ASK/policies/allowlist/budgets выполняются;
критические известные ошибки устранены.

**Итог:** feature-complete pilot candidate + combined acceptance/security reports.

## SPRINT 7 — Packaging, Astra and ZPS compatibility

**Цель:** превратить dev plugin в **устанавливаемый продукт**.

**Scope:**

- plugin package;
- Astra DEB;
- install;
- upgrade;
- uninstall только product-owned files;
- сохранение user settings при upgrade;
- R7 version compatibility check;
- deployment documentation;
- SBOM;
- third-party notices;
- reproducible build.

**Native acceptance:**

- clean install из отдельного безопасного состояния;
- upgrade/uninstall;
- отсутствие потери чужих данных;
- отсутствие daemon/listener/Node/runtime downloads;
- ZPS — отдельное состояние только по реальным требованиям, **без отключения защиты ради PASS**.

**PASS:** package lifecycle работает на заявленной конфигурации; deployment/ZPS evidence честно
зафиксирован; непроверенные конфигурации указаны как **unsupported/not verified**.

**Итог:** verified plugin/DEB packages + SBOM + install/upgrade/uninstall reports + Astra compatibility
reports.

## SPRINT 8 — Final verification / `0.9.0-pilot-rc`

**Цель:** подготовить **локальный** RC для пилотной установки.

**Scope:**

- только release-blocking fixes;
- version/changelog;
- user/admin documentation;
- known limitations;
- final SHA/checksums;
- package inventory;
- evidence reconciliation;
- independent code/security review;
- independent acceptance review.

**Final native acceptance:**

- install final artifacts;
- ключевые Word workflows;
- ключевые Cell workflows;
- ключевые Slide workflows;
- direct HTTPS;
- settings;
- tool policies / Preview where applicable;
- Undo;
- cleanup;
- проверка, что **tested build == shipped build**.

**PASS:** pilot scope acceptance пройден; нет известных critical/blocking defects; артефакты
воспроизводимы; документация честно соответствует реально проверенному состоянию.

**Итог:** локальный комплект `0.9.0-pilot-rc`:

- plugin;
- DEB;
- SHA-256;
- SBOM;
- documentation;
- acceptance reports.

**Без публикации.** Bank TLS/CORS/AUTH/Qwen остаются **NOT RUN** до внутренней банковской установки,
если к тому моменту они реально не проверены.
