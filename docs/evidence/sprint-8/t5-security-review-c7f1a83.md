# Sprint 8 T5 — independent bounded security review

Review date: 2026-10-09. Pinned product commit: `c7f1a83d5406127894bc39a654689cd8807b6cb8`.

**Outcome: no critical or release-blocking security defect found in the inspected source and artifacts.** This is a bounded code/artifact review, not a penetration test, security certification, native acceptance result, or release authorization. T8 remains conditional on the final native evidence and documentation reconciliation below.

## Reviewed byte set

The reviewer independently recomputed every entry of `dist/SHA256SUMS`; all five matched. The same values are recorded in the supplied `.local/sprint9/byte-identity.json`.

| Artifact | SHA-256 |
| --- | --- |
| `dist/plugin/r7-ai-assistant.zip` | `48dfec347d87255e7ed6678982e1f9702a83c6889d286e98226e38c54d577c21` |
| `dist/deb/r7-ai-assistant_0.9.0-pilot-rc_amd64.deb` | `0c04ae8d13d4ae4f90d3e1710a73db2a10afacd4a7f889437d91a9b3e63b5d3f` |
| `dist/r7-ai-assistant.spdx.json` | `8754aa41d1098b1a20bcb42a05514600b12b8b65b71f905e21e841c155c04dfb` |
| `dist/plugin/panel.js` | `bd083137df0f710bd1aaeb5a1bba12d188e50aafbc6eae4d5521eae48cf2b10b` |
| `dist/plugin/styles.css` | `34b9b9085d44152b9f7af582dc8505a4a46f36edc32fabefa4c8c063512cedde` |

ZIP provenance names the pinned commit. Direct archive inspection found exactly `LICENSE`, `THIRD_PARTY_NOTICES.md`, `config.json`, `index.html`, `panel.js`, `provenance.json`, `resources/icon.png`, `resources/icon@2x.png`, and `styles.css`. `config.json` is the authored R7 plugin manifest, not user connection settings. The SPDX document parses and lists nine files.

The DEB contains the eight plugin files (without provenance), the compatibility declaration, product-owned-files manifest, and preflight executable: eleven regular files. Its control archive contains only `control`; there are no install/remove maintainer scripts. The reviewer compared the eight actual DEB plugin file hashes with their ZIP counterparts: all match. No key store, endpoint settings, test fixture, source map, Node runtime, browser automation dependency, development bridge, daemon, service unit, or listener executable appears in this inventory.

Redacted pattern scans of text entries in both archives found no private-key PEM header, supported provider-token pattern, localhost/loopback endpoint, measured stand address, or Playwright/Puppeteer marker. Exact allowlist inspection and empty credential defaults complement these scans; pattern matching alone is not proof that every possible secret format is absent. No credential-bearing ignored files were read.

## Controls inspected

| Area | Inspection and result |
| --- | --- |
| Direct network transport | `src/config/settings.js` requires an HTTPS endpoint ending in `/v1/chat/completions`, rejects URL credentials, query/fragment, whitespace/backslashes and normalized-path discrepancies. `src/ai/protocol.js` constructs the bounded request and Authorization header. `src/ai/transport.js` contains the authored network request: `POST` to that validated configured endpoint, `redirect: 'error'`, `credentials: 'omit'`, `cache: 'no-store'`, abort signal, bounded response reader and deadlines. No fallback endpoint, proxy, telemetry, WebSocket, EventSource or beacon path was found in authored source. TLS is delegated to the host browser; no certificate bypass is authored. |
| Runtime/tool policy | `src/tools/registry.js` filters by editor, mode and document capability; ASK excludes mutation descriptors and `deny` tools are excluded. `src/agent/protocol.js` validates closed envelopes and the whole batch before dispatch, enforces argument bounds, resolves only names in the filtered catalogue, and refuses mixed confirm batches. `src/agent/runtime.js` dispatches sequentially, enforces step/call/deadline limits, stops on uncertain mutation, and returns a preview for `confirm` without executing it. The bulk profile is explicitly a model-facing subset, not an additional security allowlist. |
| Preview/Apply | `src/ui/controller.js` requires EDIT, an unexpired owned preview, current generation, no active/conflicting write and bridge permission. `src/plugin/bridge.js` keeps target ownership in private records, rechecks current identity, rereads exact nonempty selection, rechecks identity again, consumes the target and only then dispatches. Stop/timeout do not claim cancellation of an already dispatched write. Ordinary `auto` tools remain authorized EDIT mutations; this review does not incorrectly claim every mutation requires Apply. |
| Credentials/storage | `src/config/settings.js` defaults to empty endpoint/key and `rememberKey: false`. `src/config/storage.js` separates the key from nonsecret settings, stores it only on explicit opt-in, deletes an old key before an opt-out settings write, retains a persistence-risk warning after failed deletion/read, and resets only the product namespace. The UI uses a password input and warns about plaintext persistence. Keys are necessarily present in process memory and the selected endpoint's Authorization header. No key-vault or physical-erasure claim is made. |
| Model/document data | The Markdown renderer authors DOM elements and uses text content; it has no HTML sink, loads no remote images, and restricts links to HTTPS without URL credentials. Links use `noopener noreferrer`; following a link is user navigation, not an automatic model fetch. Document image insertion accepts bounded PNG/JPEG data URLs. Document hyperlinks may include HTTP/HTTPS as document data; that does not constitute the transport's API destination. Model arguments reach static authored SDK handlers through closed schemas, not generated JavaScript. |
| Errors/logging | Transport errors are classified without exposing raw HTTP bodies or exceptions. Runtime action records retain tool/outcome/size and closed error codes rather than arguments, document content, headers or keys. Chat and agent context remain in memory. No authored console logging or second persistent chat/log store was found in the inspected source. |
| Packaging/preflight | The package is data-only apart from the shipped compatibility preflight. The preflight compares the declared Astra/R7/architecture tuple before an optional explicit activation command. Its environment overrides are local operator/test inputs, not model-controlled inputs; it is not a privileged security sandbox. No network access or trust-store weakening is authored in it. |

Existing regression coverage inspected includes settings/transport/storage validation, ASK catalogue filtering, unknown tool/field refusal, mixed-confirm-batch rejection, confirm nonexecution, uncertain-write stopping, stale/context-changed Apply, storage failure warnings, safe errors and static-audit negative cases. The coordinator reports the pinned full suite **1357/1357**, authored-code audit PASS and reproducibility PASS. Those results were not rerun by this reviewer; archive checks above were independently performed. No SSH, VM action, trust-store change or artifact rebuild was performed by this review.

## Findings and limitations

1. **No critical/blocking security finding identified.** The controls above support T5 completion within the stated source/artifact boundary.
2. **Low severity — documentation reconciliation required for T6.** At review time, `docs/security.md` still describes “Only Sprint 1 … authorized” and historical Stage B readiness. Those statements need an explicit current Sprint 8 scope/evidence section so administrators can distinguish historical evidence from this reviewed byte set. This is not evidence of a runtime policy bypass.
3. **Accepted trusted-platform limitation.** The packaged CSP permits `'unsafe-eval'` for the unchanged installed SDK and `connect-src 'self' https:` for configurable HTTPS. CSP cannot isolate SDK evaluation privileges or constrain the connection to one configured host. Safety therefore depends on authored-source restrictions, static handlers, input validation and the trusted SDK/CEF boundary. The static audit is a guard, not a sandbox or proof about arbitrary JavaScript.
4. **Native network/platform evidence is not supplied by this review.** Actual CEF redirect handling, CA/CORS/AUTH behavior, bank endpoint/Qwen acceptance and host-process network behavior were not exercised. Bank-specific checks remain NOT RUN and ZPS remains NOT VERIFIED unless separate measured evidence changes that status. No protection was disabled here.
5. **Mutation/storage limits remain explicit.** Preview check/write is asynchronous and non-atomic; an SDK callback alone is not document-effect proof. Same-text reselection is permitted by contract. Plaintext key opt-in is not encryption; logical Reset is not physical DB/WAL erasure. Prompt instructions cannot themselves guarantee semantic resistance to document prompt injection; the enforcement reviewed here is tool/mode/schema/capability policy.

## Conditional T8 recommendation

T5 has no security finding that blocks proceeding to the exit assessment. **Do not declare T8 PASS or RC from this report alone.** The independent exit assessment still needs tracked evidence tied to the hashes above for final target install/preflight/activation and Word/Cell/Slide journeys, with document-effect readback rather than callback-only claims. It must also reconcile the compact-panel native acceptance criteria, any safely bounded failures or unreachable cases, documentation, and inherited NOT VERIFIED items.

The final inventory must preserve the pinned commit/hash tuple and link the native results, reproducibility/SBOM verification, this review and the documentation reconciliation. A later documentation-only commit must not silently replace the pinned release identity. The separate ZIP lifecycle remains NOT VERIFIED unless measured; the release contract requires exercising that distribution path or excluding it from shipment. Recorded limitations must not be converted into claims of completed native verification, and publication remains outside this review's authority.
