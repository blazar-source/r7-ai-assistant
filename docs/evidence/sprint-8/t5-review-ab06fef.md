# T5 security delta review — `ab06fef`

Date: 2026-10-09. Frozen product commit: **`ab06fef4e42840dbb0f02893b853dfad2e646442`**.

**Result: no critical or release-blocking security defect found in the inspected delta and frozen artifacts.** This extends [the f304507 review](t5-review-f304507.md). It is a source/artifact security conclusion, not T8 acceptance or closure of the observed Slide task-completion failures. Fresh exact-byte native results remain required.

## Independently verified artifact identity

The reviewer recomputed all five actual hashes; they equal both `dist/SHA256SUMS` and `.local/sprint10/byte-identity.json`:

| Artifact | SHA-256 |
| --- | --- |
| `dist/plugin/r7-ai-assistant.zip` | `886785b5a5085a776a26a06c1cadcc7ac88aeadbffc264eba048285e07c0c35d` |
| `dist/deb/r7-ai-assistant_0.9.0-pilot-rc_amd64.deb` | `5f6bdcce3243fe27af88ae0c516a688431ddcaea32d5f89b51758a74438d5b6a` |
| `dist/r7-ai-assistant.spdx.json` | `016f38dedcfac9b7347714dd832862936fc839b326cb5e5e37d91e418c5c9a69` |
| `dist/plugin/panel.js` | `03162abe0b3f10eea55fac0dda6d3af3f5ab47a26790758dd9fcef91ae042aa9` |
| `dist/plugin/styles.css` | `34b9b9085d44152b9f7af582dc8505a4a46f36edc32fabefa4c8c063512cedde` |

Actual ZIP provenance names the frozen full commit. Its SHA-256 is `9fa3a3f295a5c7ef770ebd717ab77be5dce1bde253db1c0aa39e6d56a7b97637`. The ZIP retains the nine-file allowlist: license/notices, authored plugin manifest, HTML, bundled JS, provenance, two icons and CSS. DEB retains the eight plugin files without provenance, compatibility declaration, product-owned-files manifest and preflight: eleven regular files. Its control archive contains only `control`, without maintainer scripts.

All eight actual DEB plugin hashes equal their ZIP counterparts. Parsed SPDX filename sets and all nine file SHA-256 values exactly match the ZIP. No credential/settings/dev-runtime/service file appears in the inspected inventories. Repeated archive text scans found no supported private-key/provider-token pattern, development-browser marker, loopback or measured-stand address. These are bounded inventory/pattern checks, not universal secret detection.

## Source delta assessment

The only production delta from f304507 is the authored Slide structural-dependency rule in `src/agent/runtime.js`:

- The existing Slide EDIT condition selects the rule; ASK and Word/Cell are outside it.
- After closed batch/schema/catalogue validation and **before any action dispatch**, a batch of more than one call containing `add_slide`, `move_slide` or `duplicate_slide` is rejected in its entirety. This includes a structural action mixed with reads or ordinary mutations.
- Rejection uses the existing known `TOOL_ERROR` result path with static, bounded guidance explaining shifted indices and rereading current structure. No rejected action increments the dispatched tool count or reaches its handler; the model step still consumes the existing budget. The protocol-repair allowance is not spent.
- The same guidance appears in the initial Slide system rules and completion review. Successful standalone structural calls still use the unchanged registry, tool schemas and native bridge. No model input becomes executable code, no tool authority is expanded, and no additional network or storage path is introduced.
- Existing completion read revisions, incomplete status, uncertainty stopping, transport cancellation/deadline checks and Cell recalculation correction remain unchanged from the earlier reviewed commit.

The reviewer inspected regression changes covering wholly refused two-move and mixed batches with structural calls at different positions, zero action dispatch, unspent repair allowance, preserved ordinary read batching, and the completion-review tests updated to use standalone structural actions. The coordinator reports 189 scoped tests and the final 16 completion tests passing plus audit PASS; counts are overlapping scoped groups, not a full-suite total. These tests were not repeated by the reviewer. No artifact rebuild, SSH, VM action, trust change or credential-bearing file read was performed.

## Limits and pending native decision

The rule prevents dependent structural actions **within one batch**. It does not enforce correct indices across separate turns, compel a structural reread after each standalone action, or deterministically verify every natural-language requirement. Completion review still proves the presence of qualifying reads, not semantic correctness of all modified slides. Native assertions must therefore check count, original-slide preservation, every requested text, final order and absence of duplicate creation.

The coordinator reports that f304507 passed the original one-slide case but failed the ordered pair through two moves using a stale second index, and that the failed pair trace is retained under `.local/sprint10/f304507`. Those outcomes must remain labelled with their original bytes and must not be replaced by future successful attempts. This report does not independently grade the new native runs that were still underway when it was written.

Final T8 requires actual ab06fef single-slide and ordered two-slide outcomes, refreshed Cell visual/readback evidence, and exact-byte package/load/lifecycle receipts. Previous manual per-user ZIP/DEB lifecycle results remain evidence for their measured earlier byte sets until reconciled with the new set. Vendor ZIP-manager import, unsupported/system-wide paths, arbitrary future upgrades, ZPS and remaining platform limits remain unverified; Bank TLS/CORS/AUTH/Qwen remains NOT RUN. Trusted SDK/CEF, configurable HTTPS CSP, plaintext key opt-in and non-atomic Preview/Apply limitations are unchanged. No publication is authorized by this review.
