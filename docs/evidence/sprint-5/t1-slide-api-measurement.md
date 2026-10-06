# Sprint 5 / T1 — bounded native Slide API measurement

**Статус:** T1 = DONE (measurement/evidence). Реализация T2–T5 НЕ начата.
**Метод:** поставочный плагин, активированный штатным путём вендора (лента «Плагины» → кнопка плагина), тела
исполнялись через вендорский канал `Asc.plugin.callCommand` на **живой** презентации (одноразовая копия колоды,
не сохранялась). Измерялась только поверхность, нужная §5 плана; полный дамп API не снимался.

**Стенды:**
* **Astra SE 1.7.9.41 + R7 2026.1.2.1942** — источник истины; на цели стоял **актуальный** артефакт
  `dist/plugin/panel.js` sha256 `e94109350c38fce8…` (тот же, что в репозитории на ревизии плана);
* **Windows R7 2026.3.1** — дополнительный стенд, та же колода, тот же плагин.

**Главный результат:** по всем измеренным пунктам **Astra и Windows совпали** — ни одного расхождения поверхности
или поведения. Поэтому колонки Windows/Astra ниже заполнены одинаковыми фактами там, где они совпали, и различие
указано явно там, где оно есть (таких пунктов нет).

## 1. Матрица: primitive → signature → Windows → Astra → readback/outcome proof → supported → proposed future tool

| primitive | signature (измерено) | Windows 2026.3.1 | Astra 2026.1.2.1942 | readback / outcome proof | supported | proposed future tool |
| --- | --- | --- | --- | --- | --- | --- |
| `Api.GetPresentation()` | `()` → presentation | fn, ok | fn, ok | сам объект | **yes** | база для всех чтений |
| `presentation.GetSlidesCount()` | `()` → number | 1 | 1 | число слайдов | **yes** | `read_presentation` |
| `presentation.GetSlideByIndex(i)` | `(index)` → slide | fn | fn | объект слайда | **yes** | `read_slide` |
| `presentation.GetCurrentSlide()` | `()` → slide | fn | fn | активный слайд | **yes** | адресация «текущий» |
| `presentation.GetCurSlideIndex()` | `()` → number | 0 | 0 | индекс активного | **yes** | то же |
| `slide.GetSlideIndex()` | `()` → number | fn | fn | индекс | **yes** | проверка адреса |
| `slide.GetClassType()` | `()` → `'slide'` | fn | fn | строка класса | **yes** | проверка типа цели |
| `slide.GetLayout()` | `()` → layout | fn | fn | `ToJSON().id` (напр. `304`) | **yes** | layout inheritance |
| `slide.GetTheme()` | `()` → theme | fn | fn | схемы (`GetColorScheme/FontScheme/FormatScheme`) | **yes** | сохранность theme |
| `slide.ToJSON()` | `()` → string | **34 481 симв.** | 34 481 симв. | JSON слайда | yes, **с лимитом** | bounded-чтение структуры |
| `presentation.SlidesToJSON()` | `()` → string | **34 536 симв.** | 34 536 симв. | JSON слайдов | yes, **с лимитом** | bounded-чтение презентации |
| `presentation.ToJSON()` | `()` → string | **205 339 симв.** | — | JSON целиком | **нет** для модели | не отдавать модели |
| `slide.GetAllShapes()` | `()` → array | 2 на новом слайде | 2 | `length`, поэлементно | **yes** | `read_slide_objects` |
| `slide.GetAllDrawings()` | `()` → array | fn | fn | `length` растёт после таблицы (3) | **yes** | readback добавления объектов |
| `slide.GetAllImages()/GetAllCharts()/GetAllOleObjects()` | `()` → array | 0/0/0 | 0/0/0 | `length` | **yes** | детект unsupported |
| `shape.GetContent()` | `()` → content | fn | fn | content-объект | **yes** | путь к тексту |
| `shape.GetPlaceholder()` | `()` → object | fn | fn | признак placeholder | **yes** | placeholder vs text box |
| `shape` текст-сеттер | — | **отсутствует** | **отсутствует** | — | **no** | текст только через content |
| `content.GetElementsCount()` | `()` → number | 1 | 1 | число абзацев | **yes** | чтение текста |
| `content.GetElement(0)` | `(index)` → paragraph | fn | fn | абзац | **yes** | чтение/запись текста |
| `paragraph.GetText()` | `()` → string | fn | fn | **возвращает записанный текст** | **yes** | **доказательство текста** |
| `paragraph.AddText(text)` | `(string)` | len=1, ok | len=1, ok | `GetText()` = `T1_TEXT_PROOF` | **yes** | запись текста |
| `content.RemoveAllElements()` + `content.AddElement(Api.CreateParagraph())` + `AddText` на **присоединённом** абзаце | — | ok | ok | `readback="WHOLE_OBJECT_TEXT"`, `elements=1` | **yes** | **замена текста целого объекта** |
| `paragraph.SetFontSize/SetBold/SetColor` | `(number/bool/3×number)` | ok | ok | **`GetTextPr().ToJSON()`** | **yes** | форматирование текста |
| `paragraph.GetTextPr()` | `()` → textPr | fn | fn | объект **write-only** (нет `GetFontSize/GetBold/GetColor`) | yes | readback только через `ToJSON()` |
| `content.ToJSON()` | `()` → string | 906 симв. | 906 симв. | JSON объекта | **yes** | bounded-доказательство объекта |
| `Api.AddSlide(...)` | `(arg)` → void, `length=1` | ok | ok | `GetSlidesCount()` +1, новый слайд **становится текущим** | **yes** | `add_slide` |
| `Api.AddSlide(layoutObject)` | `(layout)` | ok | ok | `newSlide.GetLayout().ToJSON().id === passed` → **true** | **yes** | **создание на существующем layout** |
| `slide.ApplyLayout(layout)` | `(layout)` | fn | fn | `GetLayout()` после | **yes** | выравнивание layout |
| `Api.CreateTable(rows, cols)` + `slide.AddObject(table)` | `(2,2)` | ok | ok | `GetAllDrawings().length` (3) | **yes** | таблица на слайде |
| `Api.CreateParagraph()` | `()` len=0 | ok | ok | абзац для content | **yes** | сборка текста |
| `Api.CreateImage` | `length=3` | fn | fn | не измерялся по существу | **unproven** | изображение — только после отдельного замера |
| `Api.AddShape` | `length=1` | fn | fn | не измерялся по существу | **unproven** | фигуры — после отдельного замера |
| `slide.Duplicate()` | `()` | ok | ok | `GetSlidesCount()` 2→3 | **yes** | дублирование слайда |
| `slide.MoveTo(index)` | `(index)` | ok | ok | `GetSlideIndex()` = 2 (последний) | **yes** | переупорядочивание |
| `slide.Delete()` / `presentation.RemoveSlides()` | — | fn | fn | — | **destructive** | **в Sprint 5 не включать** |
| `presentation.CreateNewHistoryPoint()` | `()` | ok | ok | — | yes | точка истории |
| `Api.Undo()` | `()` | **НЕ откатывает** мутации плагина | **НЕ откатывает** | `GetSlidesCount()` 5 → 5 (и внутри команды, и отдельным вызовом) | **no (этот путь)** | native Undo требует отдельного маршрута |
| `Api.Redo()` | `()` | fn | fn | — | не измерялся | — |

## 2. Что доказано для будущих мутаций (по контракту §6.0 плана)

* **Адресация доказуема:** активный слайд — `presentation.GetCurrentSlide()` + `GetCurSlideIndex()`; конкретный —
  `GetSlideByIndex(i)` + `slide.GetSlideIndex()`/`GetClassType()`; лист-аналог «имя/индекс» здесь = слайд/объект.
* **Конечное состояние доказуемо для текста:** `paragraph.AddText(text)` → `paragraph.GetText()` возвращает текст.
* **Конечное состояние доказуемо для layout:** `Api.AddSlide(layout)` → новый слайд отдаёт тот же `layout.id`.
* **Конечное состояние доказуемо для структуры:** `GetSlidesCount()`, `GetAllShapes().length`,
  `GetAllDrawings().length`, `GetAllImages/Charts/OleObjects().length`.
* **Форматирование:** сеттеры есть, но **per-property getters отсутствуют** — доказательство только через
  `GetTextPr().ToJSON()` / `content.ToJSON()` (bounded: 906 символов на объект).
* **Idempotency-путь проверяем:** повторная запись того же текста даёт тот же `GetText()` → это успех, а не отказ.

## 3. Открытые вопросы (переносятся в T2/T3 как задачи измерения, не как допущения)

1. **native Undo:** `Api.Undo()` мутации плагина не откатывает. Нужен отдельный маршрут (например, undo самого
   редактора). Критерий exit gate «native Undo для поддерживаемых операций» **пока не подтверждён**.
2. **Форматирование:** нужен явный выбор, что считается доказательством — `ToJSON()` (есть) или иной публичный
   readback; влияние `SetTextPr`/`SetFill` на runs не измерено.
3. **Таблицы/фигуры/изображения:** создание работает, но «содержимое объекта» не читается тем же путём, что текст;
   readback ограничен фактом наличия — этого достаточно для «добавлено», но не для «заполнено».
4. **Layouts как коллекция:** `GetLayouts`/`presentation.GetLayouts` отсутствуют; layout достижим **только** от
   слайда (`GetLayout()`), поэтому список доступных layouts требует отдельного замера.
5. **Unsupported-объекты:** `GetAllOleObjects/Charts/Images` есть, на колоде их 0 — поведение на реальном
   unsupported-объекте не наблюдалось.
6. **Полнота чтения:** `presentation.ToJSON()` = 205 339 символов — для модели нужен bounded-срез (T2).
