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
| Inside panel support | Vendor editor code contains inside-mode handler; no actual product loaded | PACKAGE EVIDENCE ONLY |
| Plugin installation/search | No product installation performed yet | NOT RUN |
| word/cell/slide inside UI | No product UI yet | NOT RUN |
| Selection read/replace/formatting/undo | Package code inspection only, no product command execution | NOT RUN |
| Direct CEF HTTPS/POST/headers/CORS/CA | No product CEF request yet | NOT RUN |
| Connection status and settings restart/reset | No product runtime yet | NOT RUN |
| qwen/qwen3.8-27b:free availability | Exact ID found in public OpenRouter GET /api/v1/models; context_length 262144 | CATALOG VERIFIED ONLY |
| qwen/qwen3.8-max-0902 availability | Exact ID found in public OpenRouter GET /api/v1/models; context_length 1000000 | CATALOG VERIFIED ONLY |
| Qwen strict-bank authenticated acceptance | No model request sent; no credits used by catalog lookup | NOT RUN |
| Bank served checkpoint | Qwen 3.8 family likely 27B; exact served ID/access unconfirmed | NOT VERIFIED |
| ZPS current state | Documented status commands return superuser-rights requirement | NOT VERIFIED |
| Plugin archive / DEB / clean install / upgrade / uninstall | No release artifacts exist | NOT RUN |
| ZPS ON acceptance | No separate ZPS state exercised | NOT RUN |

Public model inventory source: https://openrouter.ai/api/v1/models . Availability is point-in-time data, not a guarantee of provider uptime, tool behavior or acceptance. No native tools, streaming or structured output were requested. Production remains provider/checkpoint-independent.

Status rules: VERIFIED is limited to the evidence named; PACKAGE EVIDENCE ONLY and CATALOG VERIFIED ONLY never imply target runtime PASS. Update after real tests rather than inferring from mocks. ZPS permission failure is not evidence that ZPS is disabled.
