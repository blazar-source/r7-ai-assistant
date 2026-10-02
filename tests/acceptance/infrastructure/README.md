# Separate trusted HTTPS compatibility mock (development only)

This Node standard-library server is **test infrastructure**, not a backend, proxy or product runtime. No production module imports it. The [build allowlist](../../../scripts/build-plugin.mjs) remains eight files and excludes this entire directory, test configuration, CA material and runtime state. No Node runtime dependencies are added.

## Parent-managed run, only after review/authorization

Run from the worktree: `node tests/acceptance/infrastructure/https-mock.mjs`. Importing the module does not start it. All inputs below are mandatory process environment variables; do not place concrete endpoints, certificates or private bytes in Git. Use external paths or ignored temporary state. The CLI refuses port zero; host tests explicitly use an ephemeral port zero on IPv4 loopback.

| Input | Contract |
| --- | --- |
| `R7_MOCK_TLS_KEY` | External PEM private-key path; key must match leaf certificate |
| `R7_MOCK_TLS_CERT` | External PEM certificate-chain path; leaf first, intermediates as needed; current validity required |
| `R7_MOCK_LISTEN_ADDRESS` | Explicit IP address, not `0.0.0.0` or `::`; controller authorizes any non-loopback exposure separately |
| `R7_MOCK_PORT` | Explicit integer 1–65535; no default port |
| `R7_MOCK_PREFIX` | Explicit empty string or slash-separated ASCII letters/digits/underscore/hyphen segments; no trailing slash |
| `R7_MOCK_PROFILE` | One of `final`, `proposal`, `401`, `403`, `429`, `5xx`, `timeout`, `oversize`, `redirect` |
| `R7_MOCK_CORS_ORIGIN` | Explicit `null` for an opaque origin, or exact HTTP(S) origin; no wildcard; actual CEF origin still needs target evidence |
| `R7_MOCK_DELAY_MS` | Explicit integer 1–120000; timeout profile response delay (other profiles ignore it) |

The configured completion path is `{prefix}/v1/chat/completions`, HTTPS only. Settings must use the full authorized HTTPS endpoint ending in this path; no actual endpoint is baked in. The only accepted key is the deliberately **public, non-secret, synthetic** literal `PUBLIC-SYNTHETIC-TEST-ONLY`. Enter it only for this mock, never for a bank or real model. There is no configurable real-key override, upstream network access, model substitution or silent fallback. Foreign keys receive a constant 401 response without logging.

Only POST is accepted at the exact path (query variants rejected). Body has exactly `model`, `messages`, `max_tokens`, `temperature`; required headers exactly `Authorization`, `Content-Type`, `X-Session-ID` (UUIDv4). Ordinary browser/transport metadata headers are permitted; extra custom headers are rejected. Native tool/stream/response-format fields are rejected. Message order matches the [request snapshot interface](../../../src/shared/session.js): system, complete user/assistant pairs, optional separate user selection, current user. User/selection 8192 UTF-8 bytes each, model128, total history65536, messages32, serialized body98304; max_tokens64–8192, temperature0–2. Byte ceiling applies while reading even without Content-Length; malformed UTF-8/JSON rejected. Buffer reading is not AI streaming.

OPTIONS requires exact configured Origin, requested method POST and exactly the three required headers (case/order insensitive). Replies explicitly allow `POST` and `Authorization, Content-Type, X-Session-ID`, never wildcard credentials. An allowed Origin also receives CORS on POST/error responses. Host success cannot prove CEF's actual Origin/CSP/CORS handling.

`final` emits content-only closed JSON final; `proposal` emits content-only `r7_replace_selection` proposal with fixed synthetic replacement. Profile selection comes solely from trusted test configuration, never document instructions or content parsing for commands. `5xx` emits503, `oversize` emits an envelope larger than131072 bytes, `redirect` emits307 to the same completion path (client must refuse even same-origin redirects). Timeout delay must exceed the tested client deadline. Stop/cancel must abort the client; no retry is implied. Reconfigure only between parent-managed runs.

Privacy: no request/response content, header values, session UUIDs, keys, endpoints, certificate bytes or raw exceptions are logged or persisted. Bounded transient request buffers exist only for validation. At most64 SHA-256 UUID digests enable matching; stats expose only technical counts/booleans, saturation is explicit, no identifiers are returned. Closing clears digests, timers and sockets. Startup output is a fixed readiness/failure token. SIGINT/SIGTERM close the CLI server; the parent must collect/kill its managed job. No service installation, firewall changes or unattended/persistent launch.

## Host TLS tests (not Astra/CEF proof)

`node --test tests/acceptance/infrastructure/https-mock.test.js` (also discovered by `npm test`). Tests generate a one-day ephemeral CA/leaf in OS Temp using existing Git OpenSSL on Windows or installed developer OpenSSL on Linux. No downloads/install. Mandatory tool failure fails tests rather than pretending proof or suite-before skip. Leaf SAN includes localhost and IPv4 loopback, CA constraints/key usage and serverAuth EKU; OpenSSL verifies chain/hostname, tests check current time, then real Node HTTPS requests explicitly supply CA as trust input. Untrusted CA and wrong SAN must fail. No global trust import, certificate bypass, insecure environment or hostname override. Finally closes servers/sockets/delay timers and removes every generated file. Executable fixture and actual authored mock are explicitly covered by the existing source guard, independently of its default exclusion of tests.

Explicit audit: `node scripts/static-audit.mjs tests/acceptance/infrastructure/https-mock.mjs tests/acceptance/infrastructure/tls-fixture.mjs`.

## Controller-owned deferred security/runtime gates — NOT RUN

Before actual target calls, obtain suitable externally provided certificate/endpoint inputs with valid SAN for the actual endpoint, current time and complete valid chain, trusted by the **actual Astra/CEF** client. Host test CA trust input is neither NSS nor system/CEF trust. If CA provisioning is needed, ask the parent for explicit security-sensitive authorization and use its documented separate-dev-state process. Do not import CA autonomously or alter the clean checkpoint. Guest NSS/CA/tool availability and absent certificates are dependencies marked NOT RUN, not failed certificate compatibility.

Actual VM/checkpoint/unsaved-work checks, supported install path/SDK fingerprint, word/cell/slide panels, capabilities, CEF TLS/CORS/CSP/redirect/envelope/cancel, settings restart/reset/opt-in removal, Word safe mutation/formatting/undo and exact authenticated Qwen model IDs remain controller-owned NOT RUN. No real OpenRouter/bank calls are made here. Mock success never proves bank CA/CORS/checkpoint, CEF trust, Stage B PASS, Pilot release or ZPS certification; no C–M work.
