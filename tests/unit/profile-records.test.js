import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createProfileRecords } from '../../src/config/profile-records.js';
import { SettingsStore } from '../../src/config/storage.js';

// Exercise the production transaction adapter; only IndexedDB events are doubled.
function fixture(initial) {
  let value = initial;
  const indexedDB = { open() {
    const request = {};
    request.result = { close() {}, transaction() {
      const transaction = { objectStore() { return {
        get() { const read = {}; queueMicrotask(() => {
          read.result = structuredClone(value); read.onsuccess();
          queueMicrotask(() => transaction.oncomplete());
        }); return read; },
        put(next) { value = structuredClone(next); }
      }; } }; return transaction;
    } };
    queueMicrotask(() => request.onsuccess()); return request;
  } };
  const records = createProfileRecords(indexedDB);
  const store = () => new SettingsStore({ removeItem() {}, getItem() { return null; } }, { records, crypto: webcrypto });
  return { store, read: () => value };
}
const profile = { endpoint: 'https://example.invalid/v1/chat/completions', model: 'test', apiKey: 'synthetic-only' };
for (const revision of [42, {}, undefined, '', 'x'.repeat(101)]) {
  for (const action of ['reset', 'save']) test(`damaged revision ${JSON.stringify(revision)} permits explicit ${action}`, async () => {
    const f = fixture({ revision, reset: true }); const store = f.store();
    const damaged = await store.refresh();
    assert.equal(damaged.storageError, 'STORAGE_CORRUPT');
    assert.equal(damaged.revision, null);
    const result = action === 'reset' ? await store.resetProfile(damaged.revision) : await store.saveProfile(profile, damaged.revision);
    assert.equal(result.storageError, null);
    assert.equal((await f.store().refresh()).settings.apiKey, action === 'reset' ? '' : profile.apiKey);
  });
}
for (const action of ['reset', 'save']) test(`damaged-record ${action} cannot overwrite a concurrent valid save`, async () => {
  const f = fixture({ revision: 42, reset: true }); const stale = f.store(); const fresh = f.store();
  const damaged = await stale.refresh(); await fresh.refresh();
  const saved = await fresh.saveProfile(profile, null); assert.equal(saved.storageError, null);
  const result = action === 'reset' ? await stale.resetProfile(damaged.revision) : await stale.saveProfile({ ...profile, model: 'stale' }, damaged.revision);
  assert.equal(result.storageError, 'SETTINGS_CONFLICT');
  assert.equal(f.read().revision, saved.revision);
  assert.equal((await f.store().refresh()).settings.model, 'test');
});
