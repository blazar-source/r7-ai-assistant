# Licensing

Standalone commercial product, private local repository, All Rights Reserved pending separate legal decision. No remote or publication authorized.

Possible future model: free personal/noncommercial use; commercial use requires commercial license. This is business intent, not a legal grant or finalized EULA. Rights holder and final terms require a separate decision.

MIT reference code does not convert the product to MIT. Any copied component must retain required attribution/license and appear in THIRD_PARTY_NOTICES and the artifact SBOM. SDK redistribution terms must be checked before bundling.

## Release-candidate reconciliation

The shipped plugin payload is compiled first-party source plus first-party static assets. Verification of `package.json`, `package-lock.json`, and the packaged browser bundle found zero runtime dependencies and no bundled third-party code or R7 SDK source. `THIRD_PARTY_NOTICES.md` is itself shipped and contains the notices for development/build tooling; its presence does not mean those tools are embedded in the application.

The deterministic SPDX 2.3 SBOM generator now declares the proprietary product package as `0.9.0-pilot-rc`; after the release commit is pinned, Sprint 8 must generate the final SBOM from the final ZIP and record its hash. The SBOM records every file actually present in the plugin archive with SHA-256 computed from the archive bytes and the exact Node.js and pinned esbuild build tools under their MIT licenses. Acorn is audit-only development tooling and neither determines nor enters the packaged bytes, so it remains documented in `THIRD_PARTY_NOTICES.md` rather than being presented as a shipped or byte-determining SBOM component. The candidate is prepared but not published.
