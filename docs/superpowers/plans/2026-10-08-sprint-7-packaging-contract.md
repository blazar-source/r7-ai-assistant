# Sprint 7 T1 — packaging contract and acceptance-target measurements

**Status:** T1 design/docs contract. No package was built or installed and no stand file was written. Source provenance for this document: branch `stage-b`, commit `d7ee92c6f1a625c59c7dece45123e55dae9f0538` at measurement time. The acceptance stand was reached only after matching the SSH ED25519 pin `SHA256:C8ZeXWfRCBdNyCnfQqNA7780JIKyAi99GeBtP5XhP2k` from `.local/sprint5/astra-steps.py`.

## 1. Product-owned file manifest

### 1.1 Plugin payload: exact owned set

The product plugin GUID is `asc.{7C91D48E-5F12-4B36-8A90-2DFA8467C013}`. The on-disk directory name is the brace-only identifier `{7C91D48E-5F12-4B36-8A90-2DFA8467C013}`: the `asc.` prefix belongs to the manifest GUID, not to the directory name.

The installed plugin directory is:

`$HOME/.local/share/r7-office/editors/sdkjs-plugins/{7C91D48E-5F12-4B36-8A90-2DFA8467C013}/`

That directory and only these eight relative payload files are product-owned:

1. `LICENSE`
2. `THIRD_PARTY_NOTICES.md`
3. `config.json`
4. `index.html`
5. `panel.js`
6. `resources/icon.png`
7. `resources/icon@2x.png`
8. `styles.css`

Repository proof: `scripts/build-plugin.mjs` exports exactly this `RELEASE_FILES` list and rejects any differing sorted inventory; `packaging/plugin/README.md` repeats the same release allowlist. GUID proof: `src/plugin/config.json`, field `guid`. Acceptance-stand file proof: read-only `find` of the supported directory found the installed candidate files; the current stand candidate predates the icon files, so presence there is evidence of the load directory, not evidence that the future eight-file package is already installed.

The vendor SDK sibling directory `$HOME/.local/share/r7-office/editors/sdkjs-plugins/v1/` is **vendor-owned**, not product-owned. The DEB must neither package nor modify it. Today’s read-only command

`sha256sum ~/.local/share/r7-office/editors/sdkjs-plugins/v1/plugins.js /opt/r7-office/desktopeditors/editors/sdkjs-plugins/v1/plugins.js`

returned the same SHA-256 for both copies: `6aa574e212733b12c513622331f52a55adb24450e6990a89dbe45ba35fa6a23a`.

### 1.2 What the DEB owns

T5 must make the DEB data-only and make its `dpkg-deb -c` payload exactly the directory in §1.1 plus the same eight files beneath it, with parent directories claimed only when they were created solely for this product. It must own no vendor SDK, `/opt/r7-office` file, daemon, listener, Node runtime, MCP/TCP/WebSocket bridge, key, cache, log, or user endpoint. If packaging metadata needs a package-owned manifest under the normal DEB metadata database, that is dpkg metadata, not an extra product runtime payload.

Because the supported destination contains `$HOME`, a conventional root installation cannot safely choose an arbitrary login user. The exact T5 mechanism for targeting a user home is **NOT VERIFIED** by T1; T5 must implement and test an explicit target-user contract without writing vendor files or guessing a global path.

### 1.3 User data/settings: never package-owned

User data/settings live in R7's user CEF storage, not in the plugin payload. The product namespace is:

- `r7-ai-assistant:v1:settings` — validated non-secret settings;
- `r7-ai-assistant:v1:apiKey` — plaintext only after explicit user opt-in; default key storage is memory-only.

Source proof: `src/config/storage.js` defines `STORAGE_NAMESPACE = 'r7-ai-assistant:v1:'`, the two keys, and namespace-only Reset. Stand location proof: with the already-running R7 process, read-only inspection of `/proc/<DesktopEditors-pid>/fd` found the live LevelDB lock at `$HOME/.local/share/r7-office/editors/data/cache/Local Storage/leveldb/LOCK`.

Therefore the entire R7 profile/cache root `$HOME/.local/share/r7-office/editors/data/`, including its `cache/Local Storage/leveldb/` contents, is **user/vendor data, not product-owned**. Upgrade and uninstall must preserve it. They must also preserve all unrelated files under `$HOME/.local/share/r7-office/`. Uninstall removes only the GUID directory and its package-owned entries; it must not clear localStorage, user settings, remembered opt-in key, caches, documents, recovery data, `v1/`, or another plugin. This is the contract T5/T6 must verify. (Security note: preserving the opt-in plaintext key on uninstall is deliberate under the owner’s “user data survives uninstall” rule; removal remains the user's explicit Reset action.)

The stale development copies observed today under

- `$HOME/.local/share/r7-office/editors/data/sdkjs-plugins/{7C91D48E-5F12-4B36-8A90-2DFA8467C013}/`
- `$HOME/.local/share/r7-office/editors/data/sdkjs-plugins/asc.{7C91D48E-5F12-4B36-8A90-2DFA8467C013}/`

are **not** part of the Sprint 7 product-owned DEB manifest. T5/T6 must not delete them opportunistically; cleanup is outside this packaging contract unless a later separately authorized migration identifies them as this package's own prior-version files.

## 2. Paths and GUID

### Supported target

The supported per-user target is:

`$HOME/.local/share/r7-office/editors/sdkjs-plugins/{7C91D48E-5F12-4B36-8A90-2DFA8467C013}/`

Evidence chain:

1. `src/plugin/config.json` gives manifest GUID `asc.{7C91D48E-5F12-4B36-8A90-2DFA8467C013}`.
2. On the acceptance stand, read-only `find ~/.local/share/r7-office /opt/r7-office -path '*7C91D48E-5F12-4B36-8A90-2DFA8467C013*' ...` found the brace-only plugin directory at that root, alongside two stale alternative development copies under `editors/data/`.
3. `docs/evidence/sprint-6/t6-native-ux-acceptance.md` §9 records behavior on the final Sprint 6 bytes: R7 loaded the plugin from `/home/r7dev/.local/share/r7-office/editors/sdkjs-plugins/{7C91D48E-5F12-4B36-8A90-2DFA8467C013}`, with installed `panel.js` SHA-256 `bacb2938...`; today's read-only hash of that same root copy is the same full value `bacb29385578d52883ae13d02ca4ac21cf69c035c77ee91ab0c9fd0fc6250a1f`. The two `editors/data/sdkjs-plugins/...` copies instead hash to `d42f9eb1...` and were not the recorded loaded bytes.
4. The installed vendor SDK and examples use `/opt/r7-office/desktopeditors/editors/sdkjs-plugins/{brace-GUID}/` and `/opt/.../sdkjs-plugins/v1/`; read-only `dpkg-query -L r7-office` and `find /opt/r7-office/.../sdkjs-plugins` prove that convention. `plugins.js` loads `./config.json` relative to a plugin directory.

The behavior evidence in item 3 is the load confirmation; mere directory existence is not treated as load proof. A new plugin frame was not opened today: that would have altered the running stand UI, and the task forbids stand changes. Passive CDP `/json/list` showed the already-running document and launcher pages but no currently open plugin frame.

### Explicit negative decision

A system-wide installation path is **NOT VERIFIED** (owner decision 1). The existence of `/opt/r7-office/desktopeditors/editors/sdkjs-plugins/` and vendor plugins there proves only R7's vendor package layout; it does not authorize the product to modify vendor installation files and does not establish a supported writable/global product installation path. Sprint 7 must not claim or use one without a separate acceptance-target behavior measurement.

`$HOME/.local/share/r7-office/editors/data/sdkjs-plugins/asc.{GUID}` and its brace-only sibling are also not supported targets: they are stale development copies, not the measured loaded location.

## 3. R7 version compatibility rule

### Claimed support

Sprint 7 packaging claims support only for the measured acceptance line **R7 Office 2026.1.2 build 1942, deb package on Astra Linux SE 1.7.9/1.7.9.41, amd64**. It does not claim all 2026 releases or the separately observed 2026.3.1 environment. Additional versions remain unsupported until individually measured in T7.

Acceptance-target proof collected read-only today:

- `/opt/r7-office/desktopeditors/DesktopEditors --version` → `Р7-Офис ver. 2026.1.2.1942`;
- `dpkg-query -W -f='${Package}\t${Version}\t${Architecture}\n' r7-office` → `r7-office  2026.1.2-1942~astra-signed  amd64`;
- `cat /etc/astra_version` → `1.7.9`;
- `cat /etc/astra/build_version` → `1.7.9.41`.

### Safe refusal and where it lives

The compatibility check belongs in T2's packaging/install gate, before any payload is copied or replaced. It must obtain the target version from installed R7 evidence (`dpkg-query` for package/version/architecture and, where available without launching, `DesktopEditors --version`), normalize it, and require the exact supported tuple above. Missing R7, unparsable/conflicting versions, wrong architecture, wrong package form, or any unmeasured R7 version must fail closed with a clear diagnostic and non-zero status. Refusal must occur before creating/replacing the GUID directory; no partial install, rollback-dependent state, vendor-file edit, settings/profile change, or deletion of an existing plugin is allowed.

`src/plugin/config.json` has no minimum/maximum R7 version field today. The installed 1942 vendor configs inspected with a read-only Python JSON listing show ordinary fields such as `guid`, optional plugin `version`, and `variations`; they do not establish a vendor-supported host min/max schema. Therefore this contract does **not** invent `minVersion`/`maxVersion` fields.

T2 must add a product version/compatibility declaration to an authored package-level provenance/compatibility manifest consumed by the installer/preflight gate, not an unverified R7 manifest field. At minimum it records the development-marked product version, exact supported R7 package/version/build/architecture tuple, source commit, and toolchain versions. If T2 later establishes a vendor-defined host-version field from this installed SDK/runtime, it may mirror the rule into `config.json`, but until then that is **NOT VERIFIED** and cannot replace the pre-install check.

Vendor-grounding evidence: the installed files `/opt/r7-office/desktopeditors/editors/sdkjs-plugins/v1/plugins.js`, `v1/plugins-ui.js`, and the shipped `/opt/.../sdkjs-plugins/*/config.json` examples were read directly. They establish the local SDK/config shape and relative `config.json` loading, not cross-version compatibility.

## 4. Artifact inventory and version rule

Sprint 7 produces development-only, never-published artifacts from one recorded source commit:

1. deterministic plugin ZIP (`r7-ai-assistant.zip`);
2. byte-identical plugin-format archive where retained by the builder (`r7-ai-assistant.plugin`);
3. data-only Astra DEB;
4. SBOM (SPDX or CycloneDX, selected in T3) and reconciled third-party notices;
5. in-package provenance manifest with source commit, development-marked product version, Node/esbuild/toolchain versions, compatibility tuple, per-file hashes and artifact hashes;
6. detached SHA-256 records for ZIP/plugin and DEB;
7. reproducible-build report (two clean builds and equality results);
8. clean-install/upgrade/uninstall/incompatible-target lifecycle reports;
9. Astra/R7 compatibility matrix and ZPS report, using `NOT VERIFIED` rather than an invented PASS;
10. artifact inventory/inspection report proving the DEB is static data only and contains no daemon, listener, Node, MCP/bridge/key material;
11. deployment/evidence documentation and tested-build-equals-shipped-build provenance report.

Historical Sprint 7 owner decision 2 was binding for that stage: **`0.9.0-pilot-rc` was reserved for Sprint 8**. No Sprint 7 artifact could carry that release string or be published as an RC. Sprint 8 has now prepared the release candidate, not published it. Sprint 7 T2 had to define one deterministic development-marked version format and apply it consistently to ZIP manifest, plugin metadata where supported, DEB version, SBOM and reports. Required information is a development marker plus immutable provenance (full source commit and toolchain versions); for example, the policy may use `0.9.0~dev.s7+g<commit>` in DEB-compatible form and an equivalent semver-compatible display string. The precise encoding is T2-owned, but it must be reproducible, sortable as pre-release/development, never equal to `0.9.0-pilot-rc`, and traceable to the same source commit.

## 5. Acceptance-target install-path re-verification

**Result: VERIFIED on the required target, with a bounded evidence distinction.**

Measured target today:

- R7 executable: `2026.1.2.1942`;
- installed DEB: `2026.1.2-1942~astra-signed`, `amd64`;
- Astra: `1.7.9`, build `1.7.9.41`.

The supported loaded path is:

`/home/r7dev/.local/share/r7-office/editors/sdkjs-plugins/{7C91D48E-5F12-4B36-8A90-2DFA8467C013}/`

Read-only re-verification combined:

- current target identity from `DesktopEditors --version`, `dpkg-query`, and the two Astra files;
- current filesystem and byte identity from `find`/`sha256sum` across all three candidate locations;
- behavior evidence from `docs/evidence/sprint-6/t6-native-ux-acceptance.md` §9, which records that the page actually loaded the root `editors/sdkjs-plugins/{GUID}` candidate and records the same `panel.js` hash found there today.

The two `editors/data/sdkjs-plugins/...` candidates contain different, older bytes. They are not the supported path and were not the bytes identified by the recorded running-page measurement. The `asc.`-prefixed directory form is therefore refuted for this target; the brace-only directory under `editors/sdkjs-plugins/` is confirmed.

No stand launch, install, upgrade, uninstall, copy, delete, or file write was performed for T1. A fresh same-day plugin-frame launch was not performed because it would change the running stand UI; passive inspection found no plugin frame already open. T6 must repeat the behavior measurement against the actual DEB-installed Sprint 7 artifact during its separately authorized lifecycle run.
