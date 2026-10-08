# Sprint 7 T4 — reproducible plugin build evidence

**Result:** PASS for the boundary stated below. Two builds from the clean committed tree at `339bfa2d81ea9d42f859c6705ad1104aec747ef6` produced byte-identical plugin archives and byte-identical provenance manifests.

## Commands and clean-state procedure

A temporary detached worktree was created at the exact source commit so T4 implementation edits could not contaminate the proof:

```powershell
git worktree add --detach D:\Astra_coding\r7-ai-assistant\.worktrees\stage-b-t4-clean-proof 339bfa2d81ea9d42f859c6705ad1104aec747ef6
cd D:\Astra_coding\r7-ai-assistant\.worktrees\stage-b-t4-clean-proof
npm ci --ignore-scripts
```

For each of the two builds, the complete output directory was removed, cleanliness was checked immediately before invoking the builder, and hashes were calculated from the new output:

```powershell
Remove-Item -Recurse -Force dist -ErrorAction SilentlyContinue
git status --porcelain
node scripts/build-plugin.mjs
Get-FileHash dist/plugin/r7-ai-assistant.zip -Algorithm SHA256
Get-FileHash dist/plugin/provenance.json -Algorithm SHA256
```

The same three commands were then repeated for build 2. The temporary worktree was removed after verification:

```powershell
git worktree remove --force D:\Astra_coding\r7-ai-assistant\.worktrees\stage-b-t4-clean-proof
```

`git status --porcelain` returned an empty string immediately before both builds. `git rev-parse HEAD` returned `339bfa2d81ea9d42f859c6705ad1104aec747ef6`.

## Recorded hashes

| Build | ZIP SHA-256 | `provenance.json` SHA-256 |
| --- | --- | --- |
| 1 | `83818062dd433d071c0f027653baad1e99a6c7dba6bb597ee38f7ac6512e06cc` | `b2066c32392a86d7b5f5d4d0e0f4e318fb23e64da863a5a8b42fed9354824453` |
| 2 | `83818062dd433d071c0f027653baad1e99a6c7dba6bb597ee38f7ac6512e06cc` | `b2066c32392a86d7b5f5d4d0e0f4e318fb23e64da863a5a8b42fed9354824453` |

Both comparisons are equal. This is a **byte-identical** result, not merely content-identical.

## Provenance verification

For each build, the verifier parsed `dist/plugin/provenance.json` and confirmed:

- `sourceCommit` was exactly `339bfa2d81ea9d42f859c6705ad1104aec747ef6`, the value of `git rev-parse HEAD`;
- the tree was clean immediately before the build (`git status --porcelain` was empty);
- each SHA-256 under `files` matched the bytes of the corresponding packaged payload file;
- the recorded toolchain was Node `v24.21.0` and esbuild `0.25.10`.

The proof above used the committed T2 builder directly because the durable T4 verifier is necessarily an uncommitted T4 deliverable and was not present at source commit `339bfa2`. The durable future check is `npm run reproducible`, implemented by `scripts/verify-reproducible-build.mjs`. It refuses a dirty tree, deletes its output before each build, performs two builds, checks cleanliness again after each build, opens the ZIP to compare its packaged manifest with the standalone manifest, verifies every declared payload hash against packaged bytes, checks the source commit and pinned toolchain, and exits non-zero if either build differs.

## Declared reproducibility boundary

The demonstrated claim is: **the plugin ZIP is byte-identical across two clean builds of this exact commit using Node `v24.21.0`, pinned esbuild `0.25.10`, and this Windows x64 environment.** The same applies to the standalone `provenance.json` bytes.

The byte identity is enabled by the deterministic STORE-only ZIP writer: entries are sorted; compression is absent; DOS time/date and Unix mode are fixed; filesystem timestamps are not copied; and neither ZIP metadata nor the provenance manifest contains absolute paths. The source commit, Node version, and esbuild version are intentional byte inputs recorded in provenance.

## What this does not show

This evidence does **not** establish byte identity under a different Node version or major, a different esbuild version, a different operating system, or a different CPU architecture. It does not claim that such builds fail; they were not measured. It does not cover a dirty worktree, because uncommitted bytes can differ from the recorded `sourceCommit` and the durable verifier rejects that state. It does not cover the Sprint 7 DEB (T5), installation, upgrade/uninstall behavior, Astra runtime compatibility, or ZPS behavior. No DEB was built or installed for T4.
