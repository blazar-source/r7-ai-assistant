# Stage B — исторический итоговый доказательный отчёт: NOT PASS

> **HISTORICAL / NOT RETROACTIVELY PASS.** Все решения, измерения и прежние mutation obligations ниже относятся к завершённому обследованию Stage B. User-approved [Sprint 1 plan](<superpowers/plans/2026-10-02-sprint-1-practical-selection-editing.md>) / [amended design](<superpowers/specs/2026-10-02-compatibility-vertical-slice-design.md>) заменяют locator/revision/ABA/object-ID-of-identical-text/atomic-transaction obligations; старые gaps не являются активными prerequisites. [Original Stage B plan](<superpowers/plans/2026-10-02-stage-b-implementation.md>) архивирован. Старый outcome остаётся NOT PASS, provenance и narrow measured labels сохранены.

## Текущий Sprint 1 — не runtime proof

Documentation reconciliation IN PROGRESS; fresh native practical replacement/formatting/Undo acceptance **NOT RUN**. Apply остаётся disabled. Новый contract: Preview → explicit Apply → same current document/editor check → current nonempty selection reread → exact original-text comparison → public native replacement. User manually selecting identical text elsewhere в том же document/editor разрешён; asynchronous reread/write не atomic. Ordinary selection first, practical public unsupported/ambiguous refusal; native measured font/size/bold/italic/color/paragraph style/surrounding text/Undo обязательны. Try ReplaceTextSmart first, then PasteText, then static Document API callCommand по конкретному failed scenario; no private API/AGPL/generated code/autoSave.

Only Sprint 1 из [eight-sprint roadmap](<roadmap.md>) authorized. Bank TLS/CORS/AUTH/Qwen NOT RUN до internal bank installation; no real-model calls in Sprint 1. Closed prior network evidence переиспользуется с явной provenance; missing/relevant-change cases retest, не blanket PASS. Current acceptance/escalation/native cleanup — [test plan](<test-plan.md>). Этот docs-only Task 1 не меняет продукт и не запускает VM/network/trust actions.

## Историческое решение

**Stage B NOT PASS. Mutation subgate UNRESOLVED; Apply запрещён.** Это итог обследованного compatibility slice, не Pilot RC, не разрешение на C–M и не утверждение, что безопасная mutation в Р7 принципиально невозможна.

Принятая на момент исторического отчёта спецификация разрешала failed/unresolved отчёт с выключенным Apply, но требовала положительное доказательство Word mutation/formatting/undo по прежнему contract для B PASS. [Текущая amended спецификация](<superpowers/specs/2026-10-02-compatibility-vertical-slice-design.md>) заменяет требования, не это измеренное решение. [План](<superpowers/plans/2026-10-02-stage-b-implementation.md>) выполнен в допустимом failclosed режиме; составные native acceptance steps остаются частичными/неподтверждёнными. Подробные статусы и происхождение каждого наблюдения — в [матрице](<compatibility-matrix.md>), оставшиеся проверки — в [test plan](<test-plan.md>).

## Что реализовано и проверено

| Область | Измеренный результат | Граница вывода |
| --- | --- | --- |
| Host code | После audit-only исправления becb6c5: 356/356 tests, fail/cancel/skip0; authored audit PASS | Не native acceptance |
| Build | Две сборки, четыре ZIP/.plugin файла byte-identical; exact8 ZIP STORE, 73837bytes; SHA-256 `508750fc43b3885f224858df2d190d18885b660d48c1fad422fc0d1a229923cd` | Dev artifact, не production/Pilot promotion |
| Independent reviews | Whole-source C0/I1/M0; отражённый constructor audit gap исправлен true RED/GREEN, независимый scoped review SPEC PASS/QUALITY APPROVED/C0/I0/M0, 19 inert checks. Acceptance review отделяет mandatory gap/partial native coverage от source quality | Audit — ограниченный source-control guard, не произвольный JS sandbox |
| Exact runtime | Astra1.7.9.41 advanced(voronezh), x86_64/kernel6.1.152-1-generic/X11-Fly; Р7 2026.1.2.1942. Inside word/cell/slide UI, корректные editor labels/ready/runtimeVerified:false; неизменный установленный SDK | Trial30days; permanent license не подтверждена; current runtime bundle-cache digest не измерен |
| Word readonly | Native six-boolean capability tuple и явно выделенный текст34 UTF-8 bytes; document hashes неизменны | Presence/read не доказывают target ownership/domain/revision |
| Transport/UI | Strict four-field body/three authored headers; независимый Test UUID, ASK final, EDIT proposal preview/TTL/cancel/Apply denial. Native trusted TLS/CORS allow/omit, отдельные401/403/429/503/307/oversize/timeout/pending-HTTP Stop samples | Не exhaustive races/statuses/partial-body/deadline proof; исторические75b2239 и current f712331 наблюдения не смешиваются |
| Settings | Public-dummy opt-in/opt-out panel lifecycle; Reset/defaults panel reload и полный новый процесс; финальный Reset с непустым dummy-memory key показывает empty endpoint/key/qwen/HTTP30 | Не custom/remembered-key restart, persisted-key Reset, physical DB/WAL erasure или native crossnamespace canary |
| Untrusted negative | Owned CA removed, старые Р7 процессы завершены, новый процесс запущен штатно. Native Test ONCE показывает safe Network/DNS/CORS/TLS refusal; allowed-CORS mock: HTTP/OPTIONS/POST0. Тот же peer/time/purpose/literal-IP/DER проверен explicit CA до/после | Exact certificate-specific CEF code/proxy-policy attribution PARTIAL; historical trusted positive не contemporaneous; не broad TLS PASS |

Production — standalone browser plugin, не DSH extension: без Node/localhost service/MCP/telemetry/runtime downloads. Node/OpenSSL/mock/PKI находятся только в отдельном dev/test состоянии и не входят в exact-eight-file artifact.

## Почему mutation gate не может быть объявлен PASS

[Авторская команда](<../src/plugin/commands.js>) — синхронный literal readonly presence probe. [Bridge](<../src/plugin/bridge.js>) возвращает selection как bounded plain data, `eligible:false`, `target:null`; `applySelection` отказывает без SDK dispatch. [Controller](<../src/ui/controller.js>) не включает Apply даже после корректной EDIT preview.

Не доказаны одновременно:

1. Noncollapsed uniformly formatted text в одном ordinary body paragraph; отказ для tables/mixed runs/links/fields/controls/drawings/tracked changes/headers/unknown objects.
2. Stable document identity и selection locator/revision, включая same-text-at-other-location/ABA/document switch.
3. Проверка identity/revision/domain/original text в том же author-written editor command/transaction, что и write.
4. Реальное сохранение formatting и один корректный native undo на disposable eligible/denied fixtures.

Package methods/шесть presence flags/selected text/LOSSY JSON/action framing не являются таким сертификатом. Отрицательные blanket-Apply tests доказывают отказ, не положительную atomic guard/write семантику. Нет PasteText/text-reread fallback, private editor APIs, guessed methods, Save или model-generated executable code. **Вывод: UNRESOLVED, не доказанная SDK impossibility.** Новое положительное утверждение потребует отдельно ограниченного public-API inventory/primitive-tuple native probes и последующего доказательства безопасной atomic mutation; просто повторять network tests или включать write нельзя.

## Остальные неполные native проверки

- Custom nonsecret settings и remembered-public-key full-process restart; Reset с действительно persisted dummy key.
- Native selection/document/editor event completeness и stale-preview invalidation; installed-CSP enforcement/offline control.
- Count-only boolean UUID attribution ASK1/ASK2/Test/ASK3/New chat: aggregate repeatedSessions не идентифицирует post-Test match.
- SDK duplicate-response attribution, forced-late/partial-body cleanup и точные общие deadlines не выводятся из host doubles/narrow samples.
- Реальные bank TLS/CORS/AUTH/Qwen — **NOT RUN**, до отдельно разрешённого Pilot RC; mock этого не доказывает. DEB/enterprise/ZPS и rich Cell/Slide tools — позже, не scope B.

## Cleanup / сохранённая dev infrastructure

Owned mock graceful SIGTERM, outputs collected, port9443 отсутствует; owned CA удалён fingerprint-guarded, system trust/firewall не изменены. Финальный native Reset удалил синтетический endpoint и dummy-memory key; штатное закрытие без Save/discard/forcekill, все executable processes Р7 отсутствуют. Четыре synthetic fixture hashes совпадают с исходными.

По допустимой альтернативе **явно сохранены DEV-ONLY** portable Node22.23.3, short-lived test PKI, synthetic fixtures/evidence, прежние owned plugin backups и unprivileged NSS tools: без daemon/autostart/global PATH/system package/production dependency. Protected dirs0700/private key0600; public test certs0644 внутри0700 directory. Guest retention notice0600. Это retention, не физическое уничтожение; trust не восстанавливается автоматически, validity/SAN проверяются перед любой отдельно разрешённой reuse. Unrelated locks, system libraries/Node, NSS database/other certificates и clean VM checkpoints сохранены.

## Локальная граница и остановка

Изменения находятся только на branch `stage-b` в изолированном worktree. Main baseline `bde90803c7e137b2e607947e3da0e15c21802f45` не изменён, integration/merge/push/publication не выполнялись. C–M не начинались. Завершён **отчёт о failed/unresolved compatibility gate**, а не успешный Stage B и не готовность коммерческого релиза. Повторный pursuit B PASS требует отдельного решения по недоказанным obligations; этот отчёт не ослабляет контракты безопасности.
