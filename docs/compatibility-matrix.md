# Compatibility matrix

This is a development evidence matrix, not a Pilot RC PASS report.

| Capability | Environment/evidence | Status |
| --- | --- | --- |
| Astra exact build | Guest `/etc/astra/build_version`: 1.7.9.41; astra-version package corroborates | VERIFIED |
| Security level | Guest documented `astra-modeswitch getname`: advanced(voronezh), exit 0 | VERIFIED |
| Kernel / CPU architecture | Guest uname: 6.1.152-1-generic / x86_64 | VERIFIED |
| Desktop session | Guest console XDG_SESSION_TYPE=x11; Fly terminal launched | VERIFIED |
| Installed R7 | Package 2026.1.2-1942~astra-signed; About 2026.1.2.1942 (deb) | VERIFIED |
| R7 launch | Existing running application observed and About opened | VERIFIED |
| word/cell/slide launch/rendering | Existing DOCX/XLSX/PPTX smoke fixtures opened through R7 UI; all three editor tabs rendered | VERIFIED LAUNCH ONLY |
| Vendor converter / CEF library | Actual converter/x2t executable and libcef.so readable; no converter/CEF transport test | VERIFIED EXISTENCE ONLY |
| R7 permanent license | About reports trial with 30 days remaining | NOT VERIFIED |
| Clean / dev separation | 02-astra-r7-clean preserved, 03-r7-ai-dev-baseline created | VERIFIED |
| System/user plugin roots | Actual directories and installed v1 SDK inspected by SFTP | VERIFIED EXISTENCE ONLY |
| SDK identity | User bootstrap SHA-256 matches supplied vendor package | VERIFIED |
| Inside panel support | Actual installed product Word and Cell inside panels reached ready on exact dev target; local assets/installed SDK loaded | VERIFIED NARROW NATIVE GATE |
| Plugin installation/search | Exact eight-file archive installed in isolated user plugin root; unchanged vendor SDK, no production Node/service | VERIFIED DEV INSTALL ONLY |
| word/cell/slide inside UI | Word and Cell actual panels display correct editor identity and runtimeVerified:false; full all-three latest-artifact gate remains pending | PARTIAL NATIVE EVIDENCE |
| Word selected text | Actual fresh unlocked synthetic Word selection read returned 34 UTF-8 bytes; repeated after tuple correction, document rehash unchanged, no transmission | VERIFIED READ ONLY; NO TARGET OWNERSHIP PROOF |
| Native readonly capability callback | 75b2239 closes a six-boolean array wire tuple because installed SDK strips plain-object command results; actual native Word callback now decodes, UI reports6/6 presence and explicitly leaves domain/formatting/undo unproved and Apply denied | VERIFIED PRESENCE ONLY; runtimeVerified:false |
| Replace / formatting / undo | No guarded target/revision/ordinary-body/atomic mutation proof; Apply unconditionally denied | UNRESOLVED; B NOT PASS |
| Direct CEF HTTPS / strict synthetic POST | Correct-CORS native test: valid OPTIONS1 + strict accepted POST1, UI connection success; served leaf actual IP SAN and independent verifying handshake checked | VERIFIED DEV TRANSPORT ONLY; NOT BANK |
| Actual CEF missing-CORS response headers | Same trusted fixture/TLS, response permissions omitted: valid OPTIONS1, POST0, safe generic failure UI | VERIFIED NATIVE CORS REFUSAL |
| Native untrusted certificate refusal | Actual CEF trust-removal negative test not yet performed; independent TLS verifier result is not a substitute | NOT RUN |
| Connection status and settings restart/reset | Actual native connection success/refusal shown; restart/reset/plaintext opt-in lifecycle still pending | PARTIAL NATIVE EVIDENCE |
| qwen/qwen3.8-27b:free availability | Exact ID found in public OpenRouter GET /api/v1/models; context_length 262144 | CATALOG VERIFIED ONLY |
| qwen/qwen3.8-max-0902 availability | Exact ID found in public OpenRouter GET /api/v1/models; context_length 1000000 | CATALOG VERIFIED ONLY |
| Qwen strict-bank authenticated acceptance | No model request sent; no credits used by catalog lookup | NOT RUN |
| Bank served checkpoint | Qwen 3.8 family likely 27B; exact served ID/access unconfirmed | NOT VERIFIED |
| ZPS current state | Documented status commands return superuser-rights requirement | NOT VERIFIED |
| Plugin archive | Deterministic eight-file ZIP/.plugin exists; native tuple correction 75b2239 rebuilt and installed byte-identically in dev user root, SHA-256262fae65ac7a088ae322c0258167523a20951bf3568f6cf09090fc7402bf116e | VERIFIED DEVELOPMENT ARTIFACT ONLY |
| DEB / clean install / upgrade / uninstall | No production packaging/install lifecycle acceptance yet | NOT RUN |
| ZPS ON acceptance | No separate ZPS state exercised | NOT RUN |

Public model inventory source: https://openrouter.ai/api/v1/models . Availability is point-in-time data, not a guarantee of provider uptime, tool behavior or acceptance. No native tools, streaming or structured output were requested. Production remains provider/checkpoint-independent.

Status rules: VERIFIED is limited to the evidence named; PACKAGE EVIDENCE ONLY and CATALOG VERIFIED ONLY never imply target runtime PASS. Update after real tests rather than inferring from mocks. ZPS permission failure is not evidence that ZPS is disabled.

Native evidence provenance: correct/missing-CORS gates and initial Cell inside-panel check used prior archive SHA-25697ef924bded6cbdff47a9613b2f34f6492ca61ab86f787905f56af62e53371d3; native Word tuple/selection checks used latest75b2239 artifact SHA-256262fae65ac7a088ae322c0258167523a20951bf3568f6cf09090fc7402bf116e. Do not silently promote prior-artifact transport observations to full latest-artifact acceptance. Actual served leaf includes IP Address:127.0.0.1; DNS:localhost alone is insufficient for the literal-IP endpoint. Independent explicit-CA chain/purpose/IP verification and live verifying handshake passed, but only a native trust-removal negative test can establish the still-pending native untrusted-refusal gate. Sanitized public status is recorded here; raw documents, payloads, headers, identifiers, keys and private fixture material are not committed.

## Task 5 host-only HTTPS infrastructure (not target acceptance)

| Capability | Evidence / boundary | Status |
| --- | --- | --- |
| HTTPS-only strict mock / request caps / profiles / session matching | [Host test infrastructure](<../tests/acceptance/infrastructure/README.md>); exact path/body/required headers, explicit CORS, bounded transient buffers and metadata | HOST TEST PASS |
| Node TLS CA / SAN / time / chain | Ephemeral CA/leaf; explicitly supplied test-process CA; untrusted CA and wrong SAN denied; no trust-store changes | HOST TEST PASS ONLY |
| Actual Astra/CEF certificate / NSS trust / tool availability | Authorized dev-only test CA and isolated user test Node provisioned; actual IP SAN/independent verifying handshake plus native correct-CORS response measured; native trust-removal negative test pending | PARTIAL TARGET EVIDENCE; NOT BANK |
| Actual install / all-three panels / runtime APIs / HTTPS / settings / safe Word mutation | Controller-owned native evidence above/below; host Node TLS never substitutes for target gates; settings/all-three latest artifact/mandatory mutation not complete | PARTIAL TARGET EVIDENCE; B NOT PASS |

The mock is excluded from the unchanged eight-file production archive. No guest, trust, firewall, installation, real-model or persistent/public-service action is performed by this host task. Mandatory Word mutation remains unresolved and Apply disabled; Stage B is not PASS.

## Task 3 authored bridge boundary (host implementation, not target PASS)

- The [bridge](<../src/plugin/bridge.js>) owns one callback slot shared by selection reads and static Word method-presence probes. Completion is callback-only: `executeMethod` returning false may mean queued, not rejection. Cancellation, lifecycle invalidation, timeout or a dispatch exception settle the caller but keep the slot busy/uncertain until the matching callback arrives. Duplicate old closure callbacks cannot release a new owner. Disposal is not SDK reinitialization; recreating an adapter for the same plugin object is denied.
- [Commands](<../src/plugin/commands.js>) contain only a synchronous inline author-written `callCommand` presence probe. It calls public `Api.GetDocument` to inspect public method presence, not selection/domain/JSON/ID values. It neither captures live handles nor reads the whole document. All capability records retain `runtimeVerified:false`; positive host doubles cannot enable production Apply. Cell/slide reads remain unavailable independently; unknown editor is disabled.
- [Manifest](<../src/plugin/config.json>) uses the shipped R7 `variations` shape, fixed product GUID and word/cell/slide inside flags. Its local HTML/icon paths are the Task 4 packaging contract; assets/init and actual load are NOT RUN here. Official SDK remains installed and unchanged under ADR 0002; no SDK copy or remote fallback.
- `readSelection` returns bounded plain text solely as explicitly selected context, `eligible:false`, `target:null`. `applySelection` always fails closed without an SDK call. No text/JSON snapshot is a target certificate, no PasteText/Delete+AddText fallback, bookmark insertion, Save, private editor access or simulated-positive mutation path exists.

### Exact package observations and unresolved mandatory mutation subgate

Focused evidence is the actual supplied 2026.1.2-1942~astra-signed Word bundle, inspected via its [newline projection](<C:/Users/Пользователь/AppData/Local/Temp/r7-vendor-engine-4bd6752854d04a58a2ce0d0fcce7e6b5/sdk-all.reading.txt>). These line numbers refer to that projection, not an upstream source map or runtime probe:

| Definition / projection lines | Observation only |
| --- | --- |
| SDK `executeMethod`, 22406–22414; callback handlers, 22380–22387 | Waiting method calls may queue and return false; callbacks have distinct method/command channels. Actual callback reliability/duplicate attribution is NOT RUN. |
| SDK `callCommand`, 22424–22428; host dispatch, 22453–22464 | SDK JSON-serializes `Asc.scope`, serializes author function text, and uses trusted internal execution/action framing. Live range handles cannot cross JSON scope. Action framing is not atomic rollback/undo proof. |
| `ApiDocument.GetRangeBySelect`, 116500–116503; `ApiRange.GetText/IntersectWith`, 115901–115941 | Public selection/range methods exist in package. Intersection and text equality do not yet prove exact target identity, ownership or handle lifetime across commands/doc switches. |
| `Api.GetDocumentId`, 118231 | Presence only; uniqueness, reuse and lifetime semantics unproved. No document-name fallback. |
| `ApiParagraph.ToJSON`, 116973–116974; paragraph serializer, 119512–119526; run serializer, 119706–119759 | Public JSON is **LOSSY**: unknown children/run items can disappear; field emission is conditional. No exhaustive public run-object inventory or affirmative ordinary-body ownership is proved. A strings-only JSON snapshot cannot establish eligibility or stable revision/ABA protection. |
| `Api.ReplaceTextSmart`, 118147–118221 | Selection-dependent formatting-aware replacement implementation exists. Guarded atomic write, meaningful success, fidelity and one user-visible undo step remain unproved; this bridge never invokes it. |

Mutation-domain/identity/atomicity subgate: **UNRESOLVED, production Apply disabled**. This is not a claim that R7 is impossible based on package inspection. Authorized later runtime/public-API evidence is required. Independent B read/panel/HTTPS work continues; final B cannot PASS without the mandatory safe Word mutation/formatting/undo proof. No actual R7/CEF callbacks, panels, read method, formatting or undo were tested by Task 3.
