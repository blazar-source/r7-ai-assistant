# Sprint 8 T3/T4 — native acceptance

**Status: BLOCKED BEFORE TARGET MUTATION / NOT VERIFIED.**

## Scope and release identity preflight

The requested source worktree was inspected before any operation on the Astra stand:

- branch: `stage-b`;
- clean HEAD: `6a2e1231dc5f9025d8cdb7c6ce5febab6ccfefaa`;
- `package.json` version: `0.9.0-pilot-dev`;
- expected final version under the Sprint 8 release contract: `0.9.0-pilot-rc`;
- `dist/`: no release artifacts present.

The release contract requires the RC version to be committed and frozen before the release commit is pinned, then requires ZIP, DEB, SBOM, and checksums to be built from that exact commit and native acceptance to identify those exact bytes. Building from the supplied commit would instead produce development-labelled artifacts and could not constitute acceptance of the final shipped set.

Under the release contract, inability to identify and test the final shipped bytes is a release blocker. Work therefore stopped before installation or any target mutation rather than silently substituting Sprint 7 bytes or newly built development bytes.

Raw preflight observations are retained in `.local/sprint8/t3-t4-preflight-blocker.log`.

## Word journey

**NOT VERIFIED.** No final RC DEB/ZIP exists at the supplied clean commit, so no final-byte Word run was attempted.

- terminal status: not observed;
- document content before/after: not measured;
- mounted-panel UX-B5 sequence: not measured;
- pixel capture: not taken;
- panel activated-path/hash comparison: not measured.

## Cell journey

**NOT VERIFIED.** No final RC DEB/ZIP exists at the supplied clean commit, so no final-byte Cell run was attempted. The earlier Astra native `spreadsheeteditor` evidence is historical and was not reused as proof for different bytes.

- terminal status: not observed;
- document content before/after: not measured;
- mounted-panel UX-B5 sequence: not measured;
- pixel capture: not taken;
- panel activated-path/hash comparison: not measured.

## Slide journey

**NOT VERIFIED.** No final RC DEB/ZIP exists at the supplied clean commit, so no final-byte Slide run was attempted.

- terminal status: not observed;
- document content before/after: not measured;
- mounted-panel UX-B5 sequence: not measured;
- pixel capture: not taken;
- panel activated-path/hash comparison: not measured.

## Installation, activation, and invariants

**NOT VERIFIED for Sprint 8 final bytes.** Genuine `dpkg -i`, shipped compatibility preflight, and per-user activation were not run because the final shipped artifact set is absent. Consequently the installed inventory and absence of daemon/service/listener/Node/MCP/TCP/WebSocket bridge/key material/endpoint were not re-measured for RC bytes. Sprint 7 records remain historical evidence only.

## Model spend

Zero calls; zero spend.

## Final stand state

The Astra stand was not contacted or changed. The preserved snapshot `02-astra-r7-clean` was not restored, modified, or otherwise touched. No backup was necessary because no target lifecycle action began. The stand remains in its prior relevant state.

## What this does not show

This report does not establish installation, compatibility acceptance, activation, panel load, hash identity, semantic Word/Cell/Slide behavior, Preview/Apply behavior, terminal UI truthfulness, UX-B5 progress sequence, document mutation, or pixel composition for `0.9.0-pilot-rc`. T3/T4 must be rerun after T6/T7 provides the frozen final artifact tuple and its hashes at a pinned release commit.
