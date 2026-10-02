import { DEFAULT_SETTINGS, validateSettings } from './settings.js';
import { ERROR_CODES } from '../shared/errors.js';
import { assertByteLimit } from '../shared/bytes.js';

export const STORAGE_NAMESPACE = 'r7-ai-assistant:v1:';
const settingsKey = STORAGE_NAMESPACE + 'settings';
const apiKeyKey = STORAGE_NAMESPACE + 'apiKey';
// Valid nonsecret settings fit well below this before JSON parsing.
const storedSettingsBytes = 4096;
function browserStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

// UI must show keyPersistenceWarning whenever true: storage is explicit plaintext,
// or an old persisted key cannot be ruled out (even if rememberKey is now false).
// Corrupt records are retained for recovery, with a conservative risk warning;
// successful opt-out deletion/reset clears that risk. Never echo storage errors.
// save validates a draft, not request readiness.
export class SettingsStore {
  #storage;
  #settings = DEFAULT_SETTINGS;
  // Independent of the current opt-in: a failed read/delete can leave an old key.
  #persistenceRisk = false;
  constructor(storage = browserStorage()) { this.#storage = storage; }

  #state(storageError = null) {
    return Object.freeze({ settings: this.#settings, keyPersistenceWarning: this.#settings.rememberKey || this.#persistenceRisk, storageError });
  }

  load() {
    // Until a successful opt-out deletion, persisted state is unknown/plaintext.
    this.#persistenceRisk = true;
    let record;
    let storedKey;
    try {
      if (!this.#storage) return this.#state(ERROR_CODES.STORAGE_UNAVAILABLE);
      record = this.#storage.getItem(settingsKey);
    } catch { return this.#state(ERROR_CODES.STORAGE_UNAVAILABLE); }
    let draft;
    try {
      if (record === null) draft = DEFAULT_SETTINGS;
      else {
        assertByteLimit(record, storedSettingsBytes);
        const raw = JSON.parse(record);
        if (raw && Object.hasOwn(raw, 'apiKey')) return this.#state(ERROR_CODES.STORAGE_CORRUPT);
        draft = validateSettings(raw);
      }
    } catch { return this.#state(ERROR_CODES.STORAGE_CORRUPT); }
    try {
      if (draft.rememberKey) storedKey = this.#storage.getItem(apiKeyKey);
      else {
        this.#storage.removeItem(apiKeyKey);
        this.#persistenceRisk = false;
      }
    } catch { return this.#state(ERROR_CODES.STORAGE_UNAVAILABLE); }
    try {
      this.#settings = validateSettings({ ...draft, apiKey: draft.rememberKey ? (storedKey ?? '') : this.#settings.apiKey });
    } catch { return this.#state(ERROR_CODES.STORAGE_CORRUPT); }
    return this.#state();
  }

  save(raw) {
    const settings = validateSettings(raw);
    this.#settings = settings;
    this.#persistenceRisk = true;
    try {
      if (!this.#storage) return this.#state(ERROR_CODES.STORAGE_UNAVAILABLE);
      // Delete first: an ensuing quota failure cannot leave an opted-out key behind.
      if (!settings.rememberKey) {
        this.#storage.removeItem(apiKeyKey);
        this.#persistenceRisk = false;
      }
      const { apiKey, ...nonsecret } = settings;
      this.#storage.setItem(settingsKey, JSON.stringify(nonsecret));
      if (settings.rememberKey) this.#storage.setItem(apiKeyKey, apiKey);
    } catch { return this.#state(ERROR_CODES.STORAGE_UNAVAILABLE); }
    return this.#state();
  }

  reset() {
    this.#settings = DEFAULT_SETTINGS;
    this.#persistenceRisk = true;
    try {
      if (!this.#storage) return this.#state(ERROR_CODES.STORAGE_UNAVAILABLE);
      const keys = [];
      for (let i = 0; i < this.#storage.length; i += 1) {
        const key = this.#storage.key(i);
        if (typeof key === 'string' && key.startsWith(STORAGE_NAMESPACE)) keys.push(key);
      }
      for (const key of keys) this.#storage.removeItem(key);
      this.#persistenceRisk = false;
    } catch { return this.#state(ERROR_CODES.STORAGE_UNAVAILABLE); }
    return this.#state();
  }
}
