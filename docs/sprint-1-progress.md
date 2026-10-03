# Sprint 1 progress — bounded evidence inventory

## Current gate

Only [Sprint 1](<superpowers/plans/2026-10-02-sprint-1-practical-selection-editing.md>) is authorized under the [accepted design](<superpowers/specs/2026-10-02-compatibility-vertical-slice-design.md#L40-L50>). Task 1 documentation reconciliation is complete; Task 2 is **prerequisite GO**, not all-cases PASS; Task 3 implementation is **independently reviewed / completed**. Task 4 integrated native acceptance is **PENDING / NOT RUN on the new candidate**. Stage B remains **NOT PASS**; the [historical terminal report](<stage-b-gate-report.md#L11-L61>) is unchanged, not regraded. No Pilot, bank acceptance, later sprint, merge, push or publication follows.

Three evidence levels must remain separate:

- **MEASURED DEV PROBE:** native disposable Word experiments and independently reviewed retained artifacts below, not the production candidate's integrated Preview/Apply.
- **REVIEWED SOURCE CANDIDATE:** local commit `cb291d7d24a569775f0eee9a8ed9796eef817555`, with bounded Apply implemented and host verification. This is not the installed old production package whose Apply was OFF.
- **PENDING INTEGRATED READINESS:** exact-candidate native initialization, own frame/editor/lifecycle, Preview/Apply/effect/format/Undo, settings/session checks and final cleanup/review. Candidate/NSS preparation alone is not installation, CA import or deployment proof.

## Native Task 2 evidence and limits

Exact measured target: Astra Linux SE 1.7.9.41 advanced(voronezh), x86_64, kernel 6.1.152-1-generic, X11/Fly; R7 Office 2026.1.2.1942. Runtime owner performed native input/save/retrieval; independent HOST reviewers inspected saved artifacts, complete package/XML comparisons and retained actual native images, not a live replay or independently instrumented input/dispatch count. Parent subsequently checked installed probe/SDK provenance and unchanged old production eight files. No raw IDs, screenshots, private paths or binary evidence are portable deliverables here.

| Cases | Independently reviewed result | Scope retained |
| --- | --- | --- |
| N03–N06 | PASS: native-serialized baseline, shorter/longer/empty replacement; body Liberation Sans 14pt/bold/italic/#235789, effective Normal style, surroundings and original restoration after reported one native Undo | Ordinary synthetic fixture only; not universal rich fidelity or integrated candidate proof |
| N07 / N08 | PASS: changed nonempty / collapsed selection, actual «Выделение изменилось. Повторите команду», no-effect saved package | Complete 16/16 parts and archive bytes equal; GUI/no-effect is not native zero-dispatch instrumentation |
| N09 | Positive native document-owned SDK frames/own-context isolation and retained primary state; cross-document public-ID comparison/rejection branch **PARTIAL** | Other-editor actual behavior and integrated lifecycle remain pending; no global ID uniqueness or automatic tab-switch disposal promised |
| N10 | PASS bounded witness: retained FIRST baseline, identical SECOND selection accepted, only SECOND replaced, body-format/surroundings and reported one Undo restore original text | Comprehensive source-heading/native-normalization fidelity **PARTIAL**: undefined source Heading1, no isolated native-normalized prebaseline; not a ReplaceTextSmart heading-loss finding or whole metadata/catalog PASS |
| N11 | Scoped PASS: known tracking ON refuses retained old Apply and fresh Read; actual public Inspect ON=true → restored OFF=false; no text/format effect | Entire document/settings/styles unchanged; 15/16 complete parts equal, core modified timestamp only. Not all rich domains or whole-package byte equality |

Ignored artifact inventory (names/hashes only; retained evidence is not shipped):

- `task-2-native-round3-format-review.md`: seven complete baseline/after/Undo packages measured. `native-format-baseline-r2.docx` SHA256 `69293b32b9c9a1063c2a520fcd421595f3c1e4779ff5202d8a4dffe336f4ac9f`; full body/title/reference/style restoration checked, not ZIP equality.
- `task-2-native-round5-guards-review.md`: `native-format-r5-guards-noeffect.docx` and recovered comparison archive, 21,572 bytes each, SHA256 `34dfac4d46ef41cc16a86c73c2f73b11fd97b183ca42558fc445ced76a5f7dcd`.
- `task-2-native-round5-identical-review.md`: settled `native-identical-r5-undo.docx`, SHA256 `b609db135a7f3814473696130ee1b9f28e0744b7b2b1ac4dbae66805fd1becc2`. Premature transfer was after-state bytes, excluded as Undo proof. Native catalogs' internal unresolved style references and import normalization remain limits.
- `task-2-native-round6-context-tracking-review.md`: final `native-identical-r6-context-tracking-saved.docx`, 21,457 bytes, SHA256 `8b2278a53bdce3fb1a88c82a55eb3fced1cd8755d3be4eb5a4ac68606f0922d2`. Failed zero-byte transfer excluded. `task-2-round6-parent-gate-ruling.md` admits Task 3 with the limits above.

## Reviewed Task 3 candidate — HOST provenance

Source range: `c489a537e3f4b9987dc7404f791997613aaf2b8f..cb291d7d24a569775f0eee9a8ed9796eef817555`: **16 files, six production + ten host tests/fixture**. No network/settings/storage/limits/scripts/vendor/SDK changes. Native effect is not inferred from these host tests.

| Evidence | Result / provenance |
| --- | --- |
| Behavioural TDD | Author: 50 new tests RED, 45 assertion failures / 5 pass → GREEN; final focused 171/171 |
| Independent focused review | Fresh 171/171; unchanged adversarial security suite 87/87; authored audit PASS; C0 / I0 / M0 |
| Parent fresh full host suite | `task3-parent-round6-full.log`: 412/412, fail/cancelled/skipped 0 |
| Parent audit / complete reproducibility check | Audit PASS; two committed-source archives complete-byte identical, 87,195 bytes, exact eight entries; SHA256 `f45e6a6c4e64cea4f280d3716f615b464d658fd7c4fa6f229f9ea18594f68366` |
| Author committed-source checks | Same complete archive equality/size/hash/exact-eight inventory; audit/diff checks PASS, recorded in `task3-committed-builds.log` and `task3-committed-audit.log` |
| Independent receipt | `task-3-round6-independent-review.md`: candidate admissible to exact-candidate Task 4 native testing, not general release |

### Load-bearing current implementation

[Commands](<../src/plugin/commands.js#L3-L40>) retain the six-position **presence-only** probe separately from the actual four-primitive public context tuple: public ID, replacement presence, range presence, actual tracking state. GetSelectionType is **DOCS ONLY**, not a native gate or universal rich classifier.

[Bridge ownership](<../src/plugin/bridge.js#L93-L114>) uses a per-bridge private WeakMap token/context brand plus actual current public ID and current Word editor. Raw IDs and ownership records never become public controller DTOs/model/history/storage/logs or serializable certificates; opaque tokens stay in authored private memory. Equal public IDs cannot authorize a foreign brand. SDK object identity is permanently WeakSet-leased, including after Stop/timeout/dispose; it is not rebound as a new adapter.

[Read / Apply](<../src/plugin/bridge.js#L214-L269>): selection read → actual context → proposal → Preview → explicit Apply → owning live SDK document/frame/editor/private brand + current public ID/support/tracking → exact nonempty current selection reread → context recheck → public `ReplaceTextSmart` with data only. Identical relocation is allowed; movement alone and repeated same-editor init retain unexpired Preview. Genuine context/editor changes invalidate ownership. No immutable locator/revision/ABA/atomicity or exhaustive rich classifier is promised.

[Slot settlement / dispatch](<../src/plugin/bridge.js#L135-L211>): an actual matching callback alone releases dispatched ownership; late callbacks release only, never resurrect UI/history or steal a new slot. Transport return/Boolean callback receipt is **not native effect proof**. Timeout/Stop/dispose do not release uncertain dispatched work. No retry, automatic Save or authored Undo. User-operated native Undo remains a measured acceptance requirement.

## Remaining Task 4 gates

- Exact reviewed candidate/load-path/unchanged SDK and native own-frame/editor/lifecycle validation; integrated Preview → explicit Apply → replacement effect/format/surroundings → one native Undo on native-serialized disposable baselines. Changed/empty/tracking refusals, identical relocation and truthful Word/Cell/Slide indications still require integrated native evidence.
- Custom settings/public-dummy opt-in key full-process restart; persisted dummy-key Reset/namespace isolation; count-only ASK1/ASK2/Test/ASK3/New chat UUID attribution. Logical deletion is not physical DB/WAL erasure.
- Relevant fresh HTTPS mock flow and missing diagnostics; reuse closed historical transport cases only with unchanged-component provenance in the [matrix](<compatibility-matrix.md#L9-L71>) / [test plan](<test-plan.md#L20-L30>). Bank TLS/CORS/AUTH/Qwen and real-model calls remain **NOT RUN**; no real-model calls authorized in Sprint 1.
- Dev-only PKI preparation and exact temporary CA confirmation were user-approved. The runtime owner subsequently verified **exact-eight candidate installation** and **temporary user-NSS CA import/export**, with only one owned entry added and other normalized entries unchanged. No root/system/Windows trust or service changes were made. Native startup was requested but not established; candidate panel/HTTPS integration remain NOT RUN. Installation/trust proof is not native acceptance; final owned trust-footprint cleanup remains mandatory.
- Fresh broad final review, exact archive exclusion checks/final evidence, safe owned cleanup and parent local commit after independent docs review. No main/push/merge/publication or later Sprint.

This inventory is a sanitized HOST documentation reconciliation of existing reviewed evidence and parent verification summaries, not a new native run. It does not promote every native row or metadata/package catalog to PASS.
