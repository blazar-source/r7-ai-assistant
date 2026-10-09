# Shared encrypted connection — 2026-10-09

Source `a857d5b43be1b80d8c8eee9c7c5a2b546ae9f549`; branch `stage-b`; no publication. This supersedes the old memory-only/plaintext-opt-in connection UX. It does not declare RC acceptance.

## Measured checks

- 313 scoped storage, crypto, shared connection, settings, UI, controller, transport, entry and security tests pass. No repeated full editing suite. Encryption, stale forms, corrupt-profile recovery and visible storage failure regressions were observed failing before their corresponding fixes.
- 12 package checks pass. Their pre-existing unconditional `isCalc=false` assertion initially failed on the already accepted Word/Cell display corrections. It now requires `true` specifically for the classified `blocks`/`sheetwrite` legs and `false` for every other command. No bridge change was made here.
- Authored source and bundled code audit pass. Independent review found three P2 defects (corrupt recovery CAS, hidden storage error, retained key in dirty reset form); all were corrected and independently rechecked with synthetic data.
- Existing rendered compact acceptance passes at 259 × 499: header 32px, idle composer 50px, active composer 73px, bounded textarea, one content scroll container, keyboard navigation includes the new connection button. No browser errors.
- Reproducible ZIPs, DEB payload agreement and SPDX generation pass. [Candidate identities](candidate.json) pin the exact new bytes. A scan for the known local development credentials found none in tracked files or final artifacts.

## Native Astra

Pinned SSH fingerprint was checked before authentication. Genuine DEB installation, per-user activation and preflight passed. The previous plugin was backed up to a unique directory under `/home/r7dev/r7-verification/connection-20261009T030403`. The protected DesktopEditors PID 119782 remained running; existing user documents/panels were not closed. New disposable copies were used.

[Native crypto probe](native-crypto.jsonl) ran the production storage code with a synthetic key and a separate temporary IndexedDB database. AES-GCM-256, non-exportable CryptoKey, export refusal and absence of plaintext in the stored record were observed. Word wrote it; already open Cell and Slide read it. A fresh Store and DB connection recovered it. The temporary database was removed.

[Installed UI journey](native-ui.jsonl) checked the actual executing script in all three editors through `Debugger.getScriptSource`: SHA-256 `6dd4533287ce4f72eba84f1cc8e8819cd6a7b4ab1b5d423f2e43352d5952f4c1`. All three initially displayed onboarding. One Word **Сохранить и проверить** operation configured all three; the normal UI hid the key fields. Independent SDK reads before/after matched exactly for all three documents. An ordinary Word ASK request received a reply; both the encrypted profile revision and document contents remained unchanged.

[Native Cell panel reload](reopen.jsonl) restored the profile without any credential entry. [Final Word screenshot](ready.png) shows the normal connection summary, conversation and composer. The monitor was woken and the existing session unlocked through ordinary session controls; protection settings were not changed.

## Limits

**Full R7 process restart has not been tested**, because the owner's unsaved documents remain open. Panel reload and a fresh Store/DB connection are narrower evidence. No claim of completed T8/RC acceptance is made for this new candidate.

The key is encrypted at rest with a browser-managed non-exportable CryptoKey. This is not an OS vault: access to the full browser profile or running origin may allow decryption. Removing old localStorage entries does not securely erase historical disk pages, existing backups or copies made by old software. Already loaded old-version panels keep their old code until reopened; synchronization applies to panels running the new version.
