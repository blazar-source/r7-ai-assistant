import test from 'node:test';
import assert from 'node:assert/strict';
import { SettingsStore, STORAGE_NAMESPACE } from '../../src/config/storage.js';
import { DEFAULT_SETTINGS } from '../../src/config/settings.js';

// Browser Storage semantics, with no OS/filesystem or production test helpers.
class MemoryStorage {
  data = new Map();
  get length() { return this.data.size; }
  key(index) { return [...this.data.keys()].at(index) ?? null; }
  getItem(key) { return this.data.get(key) ?? null; }
  setItem(key, value) { this.data.set(String(key), String(value)); }
  removeItem(key) { this.data.delete(key); }
}
const keyName = STORAGE_NAMESPACE + 'apiKey';
const settingsName = STORAGE_NAMESPACE + 'settings';
const configured = { endpoint: 'https://example.invalid/v1/chat/completions', apiKey: 'synthetic-test-key' };

test('save/load stores nonsecret settings but defaults key to memory only', () => {
  const storage = new MemoryStorage();
  const store = new SettingsStore(storage);
  const state = store.save(configured);
  assert.equal(state.settings.apiKey, 'synthetic-test-key');
  assert.equal(state.keyPersistenceWarning, false);
  assert.equal(state.storageError, null);
  assert.ok(Object.isFrozen(state));
  assert.ok(Object.isFrozen(state.settings));
  assert.equal(storage.getItem(keyName), null);
  assert.ok(!storage.getItem(settingsName).includes('synthetic-test-key'));
  assert.equal(store.load().settings.apiKey, 'synthetic-test-key');
  assert.equal(new SettingsStore(storage).load().settings.apiKey, '');
  assert.equal(new SettingsStore(storage).load().settings.endpoint, configured.endpoint);
});

test('explicit opt-in persists plaintext and exposes warning on save and restart', () => {
  const storage = new MemoryStorage();
  const state = new SettingsStore(storage).save({ ...configured, rememberKey: true });
  assert.equal(state.keyPersistenceWarning, true);
  assert.equal(storage.getItem(keyName), 'synthetic-test-key');
  const loaded = new SettingsStore(storage).load();
  assert.equal(loaded.settings.apiKey, 'synthetic-test-key');
  assert.equal(loaded.keyPersistenceWarning, true);
});

test('opting out deletes old persisted key while retaining memory key', () => {
  const storage = new MemoryStorage();
  const store = new SettingsStore(storage);
  store.save({ ...configured, rememberKey: true });
  const state = store.save({ ...configured, rememberKey: false });
  assert.equal(state.settings.apiKey, 'synthetic-test-key');
  assert.equal(state.keyPersistenceWarning, false);
  assert.equal(storage.getItem(keyName), null);
  assert.equal(new SettingsStore(storage).load().settings.apiKey, '');
});

test('opt-out removes persisted key before nonsecret write even when quota write fails', () => {
  const storage = new MemoryStorage();
  const store = new SettingsStore(storage);
  store.save({ ...configured, rememberKey: true });
  storage.setItem = () => { throw new Error('synthetic-test-key'); };
  const state = store.save(configured);
  assert.equal(storage.getItem(keyName), null);
  assert.equal(state.settings.apiKey, 'synthetic-test-key');
  assert.equal(state.storageError, 'STORAGE_UNAVAILABLE');
});

test('reset removes only own namespace including future keys', () => {
  const storage = new MemoryStorage();
  storage.setItem('another-app:key', 'unrelated');
  storage.setItem('r7-ai-assistant-other', 'unrelated');
  storage.setItem(STORAGE_NAMESPACE + 'future', 'stale');
  const store = new SettingsStore(storage);
  store.save({ ...configured, rememberKey: true });
  const state = store.reset();
  assert.deepEqual(state.settings, DEFAULT_SETTINGS);
  assert.equal(state.keyPersistenceWarning, false);
  assert.deepEqual([...storage.data.entries()], [['another-app:key', 'unrelated'], ['r7-ai-assistant-other', 'unrelated']]);
  assert.deepEqual(new SettingsStore(storage).load().settings, DEFAULT_SETTINGS);
});

for (const corrupt of ['not JSON synthetic-test-key', '{"apiKey":"synthetic-test-key"}', '{"unknown":1}', '{"model":"","rememberKey":true}', '[]', 'null', 'x'.repeat(9000)]) {
  test(`corrupt storage is recoverable fixture ${corrupt.length}`, () => {
    const storage = new MemoryStorage();
    storage.setItem(settingsName, corrupt);
    storage.setItem(keyName, 'synthetic-test-key');
    storage.setItem('other', 'preserve');
    const state = new SettingsStore(storage).load();
    assert.deepEqual(state.settings, DEFAULT_SETTINGS);
    assert.equal(state.storageError, 'STORAGE_CORRUPT');
    assert.equal(state.keyPersistenceWarning, true);
    assert.equal(storage.getItem(keyName), 'synthetic-test-key');
    assert.equal(storage.getItem('other'), 'preserve');
    assert.ok(!JSON.stringify(state).includes('synthetic-test-key'));
  });
}

test('load refuses oversized or malformed persisted key without leaking it', () => {
  for (const apiKey of ['synthetic-test-key\n', 'я'.repeat(2049)]) {
    const storage = new MemoryStorage();
    new SettingsStore(storage).save({ ...configured, rememberKey: true });
    storage.setItem(keyName, apiKey);
    const state = new SettingsStore(storage).load();
    assert.equal(state.settings.apiKey, '');
    assert.equal(state.storageError, 'STORAGE_CORRUPT');
  }
});

test('unavailable storage load/save/reset safely retain only in-memory state', () => {
  const broken = {
    get length() { throw new Error('synthetic-test-key'); },
    getItem() { throw new Error('synthetic-test-key'); },
    setItem() { throw new Error('synthetic-test-key'); },
    removeItem() { throw new Error('synthetic-test-key'); }
  };
  for (const storage of [null, broken]) {
    const store = new SettingsStore(storage);
    assert.equal(store.load().storageError, 'STORAGE_UNAVAILABLE');
    const state = store.save(configured);
    assert.equal(state.settings.apiKey, 'synthetic-test-key');
    assert.equal(state.storageError, 'STORAGE_UNAVAILABLE');
    assert.equal(store.load().settings.apiKey, 'synthetic-test-key');
    const reset = store.reset();
    assert.deepEqual(reset.settings, DEFAULT_SETTINGS);
    assert.equal(reset.storageError, 'STORAGE_UNAVAILABLE');
  }
});

test('invalid save has no memory or persistence side effects and safe errors', () => {
  const storage = new MemoryStorage();
  const store = new SettingsStore(storage);
  store.save(configured);
  const before = [...storage.data.entries()];
  assert.throws(() => store.save({ ...configured, apiKey: 'synthetic-test-key\r' }), e => e.code === 'INVALID_KEY' && !e.message.includes('synthetic-test-key'));
  assert.deepEqual([...storage.data.entries()], before);
  assert.equal(store.load().settings.apiKey, 'synthetic-test-key');
});

test('failed opt-out and reset keep residual-key warning until verified removal', () => {
  const storage = new MemoryStorage();
  const store = new SettingsStore(storage);
  store.save({ ...configured, rememberKey: true });
  storage.removeItem = () => { throw new Error('synthetic-test-key'); };
  const optedOut = store.save(configured);
  assert.equal(optedOut.settings.rememberKey, false);
  assert.equal(optedOut.keyPersistenceWarning, true);
  assert.equal(optedOut.storageError, 'STORAGE_UNAVAILABLE');
  assert.equal(storage.getItem(keyName), 'synthetic-test-key');
  const reset = store.reset();
  assert.deepEqual(reset.settings, DEFAULT_SETTINGS);
  assert.equal(reset.keyPersistenceWarning, true);
  assert.equal(reset.storageError, 'STORAGE_UNAVAILABLE');
  storage.removeItem = MemoryStorage.prototype.removeItem;
  assert.equal(store.reset().keyPersistenceWarning, false);
  assert.equal(storage.getItem(keyName), null);
});

test('restart read failure and stale-key deletion failure report unknown persistence risk', () => {
  const storage = new MemoryStorage();
  new SettingsStore(storage).save({ ...configured, rememberKey: true });
  storage.getItem = () => { throw new Error('synthetic-test-key'); };
  const failedRead = new SettingsStore(storage).load();
  assert.equal(failedRead.keyPersistenceWarning, true);
  assert.equal(failedRead.storageError, 'STORAGE_UNAVAILABLE');
  assert.ok(!JSON.stringify(failedRead).includes('synthetic-test-key'));
  storage.getItem = MemoryStorage.prototype.getItem;
  storage.setItem(settingsName, JSON.stringify({ rememberKey: false }));
  storage.removeItem = () => { throw new Error('synthetic-test-key'); };
  const failedDelete = new SettingsStore(storage).load();
  assert.equal(failedDelete.keyPersistenceWarning, true);
  assert.equal(failedDelete.storageError, 'STORAGE_UNAVAILABLE');
  assert.equal(storage.getItem(keyName), 'synthetic-test-key');
});

test('stale persisted key is discarded when nonsecret state has no opt-in', () => {
  const storage = new MemoryStorage();
  storage.setItem(keyName, 'synthetic-test-key');
  const state = new SettingsStore(storage).load();
  assert.equal(state.settings.apiKey, '');
  assert.equal(storage.getItem(keyName), null);
});
