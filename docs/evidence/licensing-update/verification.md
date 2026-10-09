# Licensing update — 0.9.0-pilot-rc.1

Owner instructions, 2026-10-09: name **Бугров Геннадий Дмитрович** as rights holder; allow free personal noncommercial use, disallow general commercial use, and separately permit the bank pilot. LICENSE implements these bounds. The bank exception applies only to a bank supplied or confirmed by the rights holder for that pilot, not every bank or permanent production use. This engineering record is not legal certification; the bank can review the license with its counsel.

## Scope and verification

- No changes under `src/`; native assistant/UI/tool behavior is carried from accepted `v0.9.0-pilot-rc`, source23d6fc2. Executing panel SHA-256 remains `95bf8ff53f5110102aa8816ac8657e55e3f0730fc19c36a6cb57dcf6eb7d9232`.
- ZIP changes are limited to LICENSE and provenance; the other seven files must be identical. DEB changes are limited to LICENSE and the package version. No maintainer scripts, dependencies or activation paths are added.
- SBOM now includes the exact LICENSE bytes decoded from the supplied ZIP, rather than a hardcoded obsolete no-license-grant summary; product copyright/supplier identify the owner. npm metadata uses `SEE LICENSE IN LICENSE`.
- Regression proof: the exact-archived-license assertion failed against the old SBOM generator, then passed with the correction. **23 targeted packaging/SBOM/preflight/reproducibility tests PASS**, zero skipped. Authored-code audit PASS. The previous full1447 tests/native UAT are carried for unchanged runtime; no repeat full UAT is claimed.
- Separate review agent checked owner/scope consistency, metadata alignment and unchanged runtime. No engineering blocker found. This does not certify enforceability of legal terms.

## Final freeze

After committing this update, build ZIP/DEB/SBOM twice from the clean accepted commit, validate exact license/hash/inventory and unchanged runtime, scan for secrets, and verify the DEB update and activated ZIP on Astra without closing user documents. Record final checks and independent verdict in `release-manifest.json` and `final-review.md` attached to the `.1` private Pre-release. Tag the accepted commit after merging its PR and confirming it is an ancestor of main. Do not replace either original `v0.9.0-pilot-rc` tag or its assets.

The original Slide ASK/Redo FAIL remains owner-accepted for the pilot. Bank TLS/CORS/AUTH/Qwen, ZPS, other platform tuples and vendor plugin-manager import remain unverified; the license does not change those technical limits.
