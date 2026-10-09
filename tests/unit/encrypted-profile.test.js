import test from 'node:test';
import assert from 'node:assert/strict';
import { SettingsStore, STORAGE_NAMESPACE } from '../../src/config/storage.js';
import { webcrypto } from 'node:crypto';

const profile = { endpoint: 'https://example.invalid/v1/chat/completions', model: 'qwen', apiKey: 'synthetic-encryption-fixture', rememberKey: true };
class Records {
  value = null;
  async read() { return structuredClone(this.value); }
  async write(value, revision) {
    if ((this.value?.revision ?? null) !== revision) return false;
    this.value = structuredClone(value); return true;
  }
}
class Local {
  data = new Map();
  get length() { return this.data.size; }
  key(i) { return [...this.data.keys()][i]; }
  getItem(k) { return this.data.get(k) ?? null; }
  setItem(k,v) { this.data.set(k,v); }
  removeItem(k) { this.data.delete(k); }
}
const create = (records, local = new Local(), crypto = webcrypto) => new SettingsStore(local, { records, crypto });

test('saved profile is encrypted, key is non-exportable, another panel and restart recover it', async () => {
  const records = new Records(); const local = new Local(); const store = create(records, local);
  assert.equal(typeof store.saveProfile, 'function');
  const saved = await store.saveProfile(profile, null);
  assert.equal(saved.storageError, null);
  assert.equal(saved.settings.apiKey, profile.apiKey);
  assert.equal(JSON.stringify(records.value).includes(profile.apiKey), false);
  assert.equal(JSON.stringify([...local.data]).includes(profile.apiKey), false);
  assert.equal(records.value.key.extractable, false);
  await assert.rejects(webcrypto.subtle.exportKey('raw', records.value.key));
  assert.equal((await create(records, local).refresh()).settings.apiKey, profile.apiKey);
});

test('new save uses fresh encryption and rejects a stale panel without overwriting shared profile', async () => {
  const records = new Records(); const a = create(records); const b = create(records);
  assert.equal(typeof a.saveProfile, 'function');
  const first = await a.saveProfile(profile, null); const iv = [...records.value.iv];
  const second = await a.saveProfile({ ...profile, model: 'updated' }, first.revision);
  assert.notDeepEqual([...records.value.iv], iv);
  assert.equal((await b.saveProfile(profile, first.revision)).storageError, 'SETTINGS_CONFLICT');
  assert.equal((await b.refresh()).settings.model, 'updated');
  assert.equal((await create(records).refresh()).revision, second.revision);
});

test('tampered ciphertext fails closed without plaintext fallback or leaking errors', async () => {
  const records = new Records(); const store = create(records);
  assert.equal(typeof store.saveProfile, 'function');
  await store.saveProfile(profile, null);
  records.value.ciphertext[0] ^= 1;
  const state = await create(records).refresh();
  assert.equal(state.storageError, 'STORAGE_CORRUPT');
  assert.equal(state.settings.apiKey, '');
  assert.equal(JSON.stringify(state).includes(profile.apiKey), false);
  const recovery = create(records);
  const damaged = await recovery.refresh();
  assert.equal((await recovery.resetProfile(damaged.revision)).storageError, null);
  assert.equal((await create(records).refresh()).settings.apiKey, '');
});

test('unavailable encryption never persists plaintext or reports saved', async () => {
  const records = new Records(); const local = new Local(); const store = create(records, local, {});
  assert.equal(typeof store.saveProfile, 'function');
  assert.equal((await store.saveProfile(profile, null)).storageError, 'STORAGE_UNAVAILABLE');
  assert.equal(records.value, null); assert.equal(local.data.size, 0);
});

test('legacy opt-in migrates only after encrypted commit, deleting the plaintext record', async () => {
  const records = new Records(); const local = new Local();
  const {apiKey, ...settings} = profile;
  local.setItem(STORAGE_NAMESPACE + 'settings', JSON.stringify(settings));
  local.setItem(STORAGE_NAMESPACE + 'apiKey', apiKey);
  const store = create(records, local);
  assert.equal(typeof store.refresh, 'function');
  const result = await store.refresh();
  assert.equal(result.storageError, null); assert.equal(result.settings.apiKey, apiKey);
  assert.equal(local.getItem(STORAGE_NAMESPACE + 'apiKey'), null);
  assert.equal((await create(records, local).refresh()).settings.apiKey, apiKey);
});

test('failed migration retains legacy record and shows a plaintext-removal warning', async () => {
  const local = new Local(); const {apiKey, ...settings} = profile;
  local.setItem(STORAGE_NAMESPACE + 'settings', JSON.stringify(settings)); local.setItem(STORAGE_NAMESPACE + 'apiKey', apiKey);
  const store = create(new Records(), local, {});
  assert.equal(typeof store.refresh, 'function');
  const state = await store.refresh();
  assert.equal(state.storageError, 'STORAGE_UNAVAILABLE');
  assert.equal(state.keyPersistenceWarning, true);
  assert.equal(local.getItem(STORAGE_NAMESPACE + 'apiKey'), apiKey);
});

test('reset tombstone prevents old open versions from resurrecting a plaintext profile', async () => {
  const records = new Records(); const local = new Local(); const store = create(records, local);
  assert.equal(typeof store.saveProfile, 'function');
  const saved = await store.saveProfile(profile, null);
  const reset = await store.resetProfile(saved.revision);
  assert.equal(reset.storageError, null);
  local.setItem(STORAGE_NAMESPACE + 'settings', JSON.stringify({ ...profile, apiKey: undefined }));
  local.setItem(STORAGE_NAMESPACE + 'apiKey', profile.apiKey);
  const reloaded = await create(records, local).refresh();
  assert.equal(reloaded.settings.apiKey, '');
  assert.equal(records.value.key, undefined);
});
