import test from 'node:test';
import assert from 'node:assert/strict';
import { SettingsStore, STORAGE_NAMESPACE } from '../../src/config/storage.js';
import { DEFAULT_SETTINGS } from '../../src/config/settings.js';

class MemoryStorage {
  data = new Map();
  get length() { return this.data.size; }
  key(i) { return [...this.data.keys()][i] ?? null; }
  getItem(k) { return this.data.get(k) ?? null; }
  setItem(k, v) { this.data.set(k, v); }
  removeItem(k) { this.data.delete(k); }
}
const records = { async read() { return null; }, async write() { throw new Error('unavailable'); } };
const configured = { endpoint: 'https://example.invalid/v1/chat/completions', apiKey: 'synthetic-test-key' };

test('volatile configuration never persists a secret and resets to defaults on restart', () => {
  const local = new MemoryStorage(); const store = new SettingsStore(local);
  const state = store.save(configured);
  assert.equal(state.settings.apiKey, configured.apiKey);
  assert.equal(local.data.size, 0);
  assert.ok(Object.isFrozen(state.settings));
  assert.equal(store.load().settings.apiKey, configured.apiKey);
  assert.deepEqual(new SettingsStore(local).load().settings, DEFAULT_SETTINGS);
});

test('synchronous configuration cannot accidentally opt into plaintext storage', () => {
  const local = new MemoryStorage(); const store = new SettingsStore(local);
  assert.throws(() => store.save({ ...configured, rememberKey: true }), {code: 'INVALID_SETTINGS'});
  assert.equal(local.data.size, 0);
});

for (const corrupt of ['not JSON synthetic-test-key', '{"apiKey":"synthetic-test-key"}', '{"unknown":1}', '{"model":"","rememberKey":true}', '[]', 'null', 'x'.repeat(9000)]) {
  test(`corrupt legacy profile is retained without exposing its contents (${corrupt.length})`, async () => {
    const local = new MemoryStorage();
    local.setItem(STORAGE_NAMESPACE + 'settings', corrupt);
    local.setItem(STORAGE_NAMESPACE + 'apiKey', 'synthetic-test-key');
    const state = await new SettingsStore(local, { records }).refresh();
    assert.equal(state.storageError, 'STORAGE_CORRUPT');
    assert.deepEqual(state.settings, DEFAULT_SETTINGS);
    assert.equal(state.keyPersistenceWarning, true);
    assert.equal(local.getItem(STORAGE_NAMESPACE + 'settings'), corrupt);
    assert.equal(JSON.stringify(state).includes('synthetic-test-key'), false);
  });
}

test('legacy cleanup leaves other applications untouched and reports deletion failures safely', () => {
  const local = new MemoryStorage(); local.setItem('other', 'keep'); local.setItem(STORAGE_NAMESPACE + 'future', 'old');
  const store = new SettingsStore(local); store.save(configured);
  assert.deepEqual(store.reset().settings, DEFAULT_SETTINGS);
  assert.deepEqual([...local.data], [['other', 'keep']]);
  local.setItem(STORAGE_NAMESPACE + 'apiKey', 'synthetic-test-key');
  local.removeItem = () => { throw Error('synthetic-test-key'); };
  const state = store.reset();
  assert.equal(state.storageError, 'STORAGE_UNAVAILABLE'); assert.equal(state.keyPersistenceWarning, true);
  assert.equal(JSON.stringify(state).includes('synthetic-test-key'), false);
});
