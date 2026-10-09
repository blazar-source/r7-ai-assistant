# Compact Chat-First Panel — Design Proposal

> **Status:** proposal only. Owner approval is required before any product implementation or native verification.

## Intent and constraints

The target is the R7 AI Assistant embedded panel at the measured Astra frame of **259 × 499 CSS px**. The owner wants the density of R7's native side panel, a chat-first hierarchy, a pinned compact composer, correct Markdown, and exactly one history scroll region. This document proposes presentation changes only.

The referenced owner screenshot was **not available in this delegated session**. Density is therefore derived from the owner's numeric brief, the checked-in UI, existing native Astra evidence, and the measured 259 × 499 browser renders below. No stand/editor was opened or changed.

## Current state: source and measured values

### Source structure

`src/ui/view.js` mounts the root in this order: `header`, `#status`, `#progress-stage`, `#content`, `#composer`. `#content` contains `#history`, `#preview`, and collapsed `#diagnostics`. Messages are `article.message` elements containing a role `h2` and a plain `pre`; Markdown is therefore **not parsed**. The composer contains a 3-row textarea, a normally hidden byte budget, Send, and a normally hidden Stop button.

The repository DOM harness (`tests/fixtures/dom.js`) is deliberately non-layout: it verifies structure and text but cannot return computed geometry. It does confirm that `#content` is the only element marked `data-scroll-container`, while the CSS and native evidence establish its actual scrolling behavior.

### Current numbers

| Area | Current value | Provenance |
| --- | ---: | --- |
| Body type | 14 px / 21 px | CSS `14px/1.5` |
| Root panel | 6 px padding at width ≤300; 6 px gap | CSS; rendered at 259 px |
| Header | 16 px title; 6 px gap | CSS |
| Header footprint | 39 px high (`y 6…45`) | rendered mockup, 259 × 499 |
| Compact status | inherits 14/21; 4 px vertical + 8 px horizontal padding; 3 px side rule | CSS |
| Status footprint | 29 px high (`y 51…80`) | rendered mockup |
| History region | `#content` flexes; `#history` has 6 px padding at ≤300, 1 px border, 8 px radius | CSS |
| History footprint | 273 px high (`y 86…359`) in the current comparison sample | rendered mockup |
| Message block | max-width 90%; margin 6 px vertical; padding 6 × 8 px; radius 8 px | CSS |
| Message heading | 14 px; zero margin inside message | CSS |
| Message text / code | `pre` inherits 14/21 | CSS |
| Paragraph rhythm | 8 px vertical margin globally | CSS |
| Generic section/details | 8 px margin; 6 px padding at ≤300; 1 px border; radius 8 px | CSS |
| Composer gap | 6 px; 2 px top padding | CSS |
| Textarea | 8 px padding; 60 px minimum; 25vh maximum; 3 rows in DOM | CSS + view.js |
| Rendered textarea | 81 px high (`y 367…448`) | rendered mockup |
| Controls | 14/21 text; 8 × 12 px padding; 1 px border | CSS |
| Send footprint | 39 px high, full 247 px width (`y 454…493`) at ≤300 | rendered mockup |
| Composer footprint | **128 px** (`y 365…493`) | rendered mockup; matches prior Astra evidence |
| Scrolling element | **only `#content`**: `overflow-y:auto`; `html`, `body`, and `main` are hidden | CSS + DOM marker + prior native evidence |

The prior checked-in Astra measurement on the product UI reports the same frame and baseline geometry: history `y 86…300` (214 px), composer `y 365…493` (128 px). The mockup's sample history is shorter than a long product history, so its `#content` has no overflow; it mirrors the current visual treatment and dimensions, not a native runtime claim.

### Current issues at 259 px

1. A 14/21 body and 16 px heading consume too much width and height for this frame.
2. Every message is a rounded bubble/card with 12 px inter-message rhythm (6 px margins on both sides), and the assistant adds a full border.
3. Each message repeats a visually strong heading; assistant messages say “Ассистент / предложение,” conflating role and artifact.
4. Plain `pre` preserves line breaks but does not render headings, lists, links, emphasis, or code as Markdown.
5. The 128 px composer occupies 26% of the entire frame, mainly because the textarea and full-width 39 px Send stack vertically.
6. Generic `section/details` card rules remain visually bulky when diagnostics or preview are opened.

## Proposed compact layout

### Chosen direction

Use a **flat transcript with slim role rules**, not chat bubbles. This preserves clear authorship without making each message a card. The one title remains `R7 AI Assistant` in the 32 px header; message roles are small labels, never duplicate panel headings. Compact status shares the header. New-chat and diagnostics survive as named icon controls with tooltips/accessible labels.

### Type scale

| Element | Proposed size / line height |
| --- | ---: |
| Panel/body and message text | **12.5 px / 17 px** |
| Header title | **13 px / 18 px**, semibold |
| Compact status and working stage | **11 px / 16 px** |
| Message role label | **10.5 px / 14 px**, semibold |
| Code / preformatted content | **11.5 px / 16 px**, monospace |
| Composer textarea | **12.5 px / 17 px** |
| Send glyph | 15 px; accessible label “Отправить” |
| Stop label | **10.5 px / 12 px** |

Normal message text remains above the owner's 12 px minimum. Muted colors must still achieve at least 4.5:1 for normal text; rules and control boundaries at least 3:1.

### Vertical rhythm and surfaces

- Root: no outer card; background fills the 259 px frame.
- Header: **32 px fixed height**, **3 px vertical / 6 px horizontal padding**, 4 px control gap, 1 px bottom divider.
- History: **4 px top / 6 px horizontal / 6 px bottom padding**.
- Message: **4 px top / 5 px bottom**, no radius, no outer card, 3 px between consecutive messages.
- User: 12 px left offset, 6 px inner horizontal padding, **2 px blue side rule**, very subtle blue wash.
- Assistant: 6 px left padding, **2 px neutral side rule**, no card background.
- Role label: 1 px gap before message body.
- Markdown paragraphs: 0 margin inside a single block; **4 px** between consecutive block elements.
- Lists: 2 px top margin, 16 px left indent; list lines use the 17 px body rhythm.
- Inline code: 0 × 2 px padding, 2 px radius. Fenced code: 4 px padding, horizontal overflow inside the code block only; it must not create a panel scrollbar.

### Markdown treatment

Assistant content should pass through the project's approved, sanitized Markdown renderer rather than a raw `pre`. Supported presentation should include paragraphs, hard/soft line breaks as specified by the renderer, headings demoted to the compact panel hierarchy, ordered/unordered lists, emphasis, links, inline code, and fenced code. Raw HTML stays disabled/sanitized. A message must not add another panel-level `h1`; Markdown headings begin at the message-content level and use compact 12.5/17 or 12/16 styles.

### Header and diagnostics

- Exactly one panel title: **R7 AI Assistant** in the header.
- Compact status moves into the header as dot + one of the existing five words.
- New chat becomes a **28 × 26 px visual control** with an expanded **34 × 32 px hit box** where the host permits it; accessible name remains “Новый чат.”
- Diagnostics becomes an overflow/ellipsis control with the same footprint. It opens the existing diagnostic content as an in-panel disclosure/sheet within the single `#content` scroll flow, or switches the content view; it must not reserve height while closed and must not add a nested vertical scrollbar.
- Technical badges, capability prose, settings, orchestration report, and action journal remain absent from the main chat surface until diagnostics is opened.

### Composer

- Pinned as the final root row, outside the history scroller.
- **73 px active footprint** in the working-state mockup; **51 px idle target** when Stop is absent.
- 5 px top / 6 px side / 6 px bottom padding, 4 px column gap.
- Textarea starts at **2 lines / 38 px**, grows with content to **72 px maximum**, then scrolls internally only for editing text. This textarea overflow is a control affordance, not a second page/history scrollbar.
- Action column is 34 px wide. Send is **34 × 34 px**; Stop is **34 × 24 px** and exists only while working.
- Send and Stop remain fully within the 259 × 499 frame. The controls require accessible names and visible focus. For this constrained desktop plugin, **34 × 34 px** is the proposed minimum primary hit target; secondary Stop is 34 × 24 only during an active run. If owner policy requires 44 px targets, use invisible hit-area expansion without increasing the visual footprint.
- Byte budget stays hidden below 75% of 8192 bytes; when shown it occupies one 14 px line above/within the composer and correspondingly reduces history, never pushes controls off-frame.

### Single scrolling region

The single transcript scrollbar remains on **`#content`** (or, if renamed during implementation, the one history/content element carrying the same responsibility). `html`, `body`, root, header, status, and composer do not scroll. No diagnostics, preview, message, or Markdown wrapper gets its own vertical scrollbar. The textarea may scroll its own draft after the 72 px cap; fenced code may scroll horizontally. Neither counts as an additional history/page vertical scrollbar.

### Remove or collapse

- Remove rounded message cards/bubbles and assistant full border.
- Remove message `h2` elements; replace with compact role labels.
- Remove “/ предложение” from the assistant role; proposal state belongs in the preview/action area.
- Collapse status into the header.
- Collapse diagnostics/settings/capability details to the overflow entry point.
- Remove generic card padding/borders from the main history path.
- Keep preview/action affordances contextual and inline; do not reserve an empty card.
- Keep the byte counter hidden until its existing threshold.

## Rendered comparison at 259 × 499

Both images are real Chromium captures at exactly **259 × 499 CSS pixels** from throwaway HTML under `.local/sprint9/`; neither HTML file is product code.

| | Current mirror | Proposed compact mockup |
| --- | --- | --- |
| HTML | `.local/sprint9/current.html` | `.local/sprint9/proposed.html` |
| PNG | `.local/sprint9/current-259x499.png` | `.local/sprint9/proposed-259x499.png` |
| Header | 39 px | 32 px |
| Status | separate 29 px row | in header |
| History viewport in sample | 273 px | **394 px** |
| Composer | **128 px** | **73 px active**, 51 px idle target |
| Textarea | 81 px | 38 px initial, max 72 px |
| Send | 247 × 39 px | 34 × 34 px |
| Scroll | `#content` only | `#content`/history only |

The proposed sample contains four messages plus a working-agent line above the composer. Its history measured `clientHeight 394`, `scrollHeight 396`, proving the mockup is at the onset of transcript overflow while the composer stays fixed. This is a mockup measurement, not Astra acceptance.

## Measurable acceptance criteria for the approved implementation

Native verification must occur on Astra at **exactly 259 × 499** after owner approval, with a long dialogue and a real working agent. RC cannot be declared until all checks pass.

1. **Viewport and containment:** plugin frame is 259 × 499 CSS px; document `scrollWidth == clientWidth == 259` and `scrollHeight == clientHeight == 499`.
2. **One transcript scrollbar:** exactly one non-control element has vertical overflow and it is `#content` (or its approved renamed history container). Root/document, diagnostics, preview, messages, and Markdown wrappers do not vertically scroll.
3. **Pinned composer:** composer remains fully visible at both `scrollTop=0` and maximum transcript scroll; idle height ≤ **51 px**, active/Stop height ≤ **73 px**, except byte-warning or expanded textarea states bounded by the declared maximum.
4. **Primary action containment:** Send is fully inside the frame at all times, minimum **34 × 34 px** visual/hit target (or invisible expansion to owner-required 44 px), with no clipping at 259 px.
5. **Textarea:** initial height **38 px / two lines**, grows no higher than **72 px**; growth reduces only transcript height and never causes document scroll or hides Send/Stop.
6. **Above-fold chat density:** in idle state, at least **18 lines** of 17 px message text-equivalent fit between the 32 px header and ≤51 px composer; in active state, at least **17 lines** fit above the ≤73 px composer. The real working-agent test must show at least the tail of the current response, the working stage, the input, and Send simultaneously.
7. **Long dialogue:** with at least **20 alternating messages**, first content is reachable at `scrollTop=0`, last content is reachable at max scroll, no horizontal panel overflow occurs, and the composer coordinates do not change between endpoints.
8. **Typography:** computed message font is **12–13 px** with 17 px line height; status 11/16; code 11.5/16; no main-surface heading exceeds 13 px.
9. **Rhythm:** history horizontal inset 6 px; message vertical padding no more than 5 px per edge; consecutive message gap no more than 3 px; side rule exactly 2 px.
10. **Role distinction without cards:** user and assistant have different `data-role`, role labels, and side-rule/background treatment; neither uses a rounded full-border card.
11. **No duplicated headings:** exactly one visible panel title; messages contain no repeated panel title and no “Ассистент / предложение” heading.
12. **Markdown:** native run demonstrates a paragraph, unordered list, emphasis, link, inline code, and fenced code rendered semantically; raw HTML does not execute; long code creates only horizontal code overflow, not a second vertical history scrollbar.
13. **Diagnostics:** closed diagnostics consumes zero main-flow height beyond its header icon; opening it preserves a single content scrollbar and exposes the existing technical information and settings.
14. **Working agent:** during a real agent run, compact status and progress update without layout jumps; Stop appears fully inside the frame and disappears after completion; draft focus and transcript reachability remain intact.
15. **Keyboard and contrast:** all controls have visible focus, logical tab order, accessible names, body/role/status contrast meets 4.5:1, and non-text boundaries/state indicators meet 3:1.

## Non-goals

This proposal does **not** change or propose changes to:

- agent runtime, orchestration, prompts, planning, execution, retries, or stop semantics;
- tools, tool schemas/contracts, tool journal data, or capability behavior;
- R7 bridge, editor adapters, API presence checks, apply/undo safety, or lifecycle behavior;
- byte/token/time/step/pass limits or their enforcement;
- connection settings semantics, storage, security model, or network behavior;
- frozen release artifacts, packaging, release declaration, or RC status;
- any file under `src/` or `tests/` at this stage.

## Approval gate

Owner approval is required for the type scale, flat role-rule treatment, 32 px header, 51/73 px composer targets, 34 px compact controls (and optional invisible 44 px hit expansion), diagnostics entry point, and the acceptance criteria above. Only after approval should an implementation plan and product changes be prepared, followed by native Astra verification at 259 × 499 with a long dialogue and a working agent.
