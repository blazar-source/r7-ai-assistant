import { DEFAULT_SETTINGS, validateSettings, validateRequestSettings } from './settings.js';
import { ERROR_CODES, SafeError } from '../shared/errors.js';
import { assertByteLimit } from '../shared/bytes.js';
import { createProfileRecords } from './profile-records.js';

export const STORAGE_NAMESPACE = 'r7-ai-assistant:v1:';
const settingsKey = STORAGE_NAMESPACE + 'settings';
const apiKeyKey = STORAGE_NAMESPACE + 'apiKey';
const aad = new TextEncoder().encode('r7-ai-assistant:connection:v2');
function browserStorage() { try { return globalThis.localStorage ?? null; } catch { return null; } }

// AES-GCM protects the stored profile from plaintext disclosure and undetected edits.
// Its non-exportable CryptoKey lives in the browser profile, NOT an OS key vault.
// An attacker controlling that profile or this running origin can still decrypt it.
export class SettingsStore {
  #storage; #records; #crypto;
  #settings = DEFAULT_SETTINGS;
  #revision = null;
  #persistenceRisk = false;
  constructor(storage = browserStorage(), { records = createProfileRecords(), crypto = globalThis.crypto } = {}) {
    this.#storage = storage; this.#records = records; this.#crypto = crypto;
  }
  #state(storageError = null) {
    return Object.freeze({ settings: this.#settings, revision: this.#revision,
      keyPersistenceWarning: this.#persistenceRisk, storageError });
  }
  get shared() { return this.#records.available !== false; }
  load() { return this.#state(); }
  // Explicit volatile configuration for callers that do not request persistence.
  // No synchronous path can write an API key to localStorage.
  save(raw) {
    const settings = validateSettings(raw);
    if (settings.rememberKey) throw new SafeError(ERROR_CODES.INVALID_SETTINGS);
    this.#settings = settings;
    return this.#state();
  }
  #cleanLegacy() {
    this.#persistenceRisk = true;
    if (!this.#storage) throw new Error('storage');
    this.#storage.removeItem(apiKeyKey);
    this.#storage.removeItem(settingsKey);
    this.#persistenceRisk = false;
  }
  async refresh() {
    let record;
    try { record = await this.#records.read(); }
    catch { return this.#state(ERROR_CODES.STORAGE_UNAVAILABLE); }
    if (record) {
      try {
        if (typeof record.revision !== 'string' || record.revision.length > 100) throw new Error('record');
        if (record.revision !== this.#revision || this.#settings === DEFAULT_SETTINGS) {
          let settings = DEFAULT_SETTINGS;
          if (record.reset !== true) {
            if (!(record.iv instanceof Uint8Array) || record.iv.length !== 12 ||
                !(record.ciphertext instanceof Uint8Array) || record.ciphertext.length > 16384 ||
                record.key?.extractable !== false || record.key?.algorithm?.name !== 'AES-GCM' || record.key?.algorithm?.length !== 256) throw new Error('record');
            const bytes = await this.#crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv, additionalData: aad, tagLength: 128 }, record.key, record.ciphertext);
            settings = validateRequestSettings(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
          }
          this.#settings = settings; this.#revision = record.revision;
        }
      } catch { this.#settings = DEFAULT_SETTINGS; this.#revision = typeof record.revision === 'string' ? record.revision : null; return this.#state(ERROR_CODES.STORAGE_CORRUPT); }
      try { this.#cleanLegacy(); } catch { return this.#state(ERROR_CODES.STORAGE_UNAVAILABLE); }
      return this.#state();
    }
    if (this.#revision !== null) { this.#settings = DEFAULT_SETTINGS; this.#revision = null; }
    // Upgrade an explicitly remembered legacy profile; never fall back to it when
    // a v2 record exists (including reset tombstones or damaged ciphertext).
    try {
      if (!this.#storage) return this.#state();
      this.#persistenceRisk = this.#storage.getItem(apiKeyKey) !== null;
      const legacy = this.#storage.getItem(settingsKey);
      if (legacy === null) return this.#state();
      assertByteLimit(legacy, 4096);
      const raw = JSON.parse(legacy);
      if (Object.hasOwn(raw, 'apiKey')) throw new Error('record');
      const draft = validateSettings(raw);
      if (!draft.rememberKey) return this.#state();
      const settings = validateRequestSettings({ ...draft, apiKey: this.#storage.getItem(apiKeyKey) ?? '' });
      return await this.saveProfile(settings, null);
    } catch { return this.#state(ERROR_CODES.STORAGE_CORRUPT); }
  }
  async saveProfile(raw, expectedRevision) {
    const settings = validateRequestSettings({ ...validateSettings(raw), rememberKey: true });
    try {
      const key = await this.#crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      const iv = this.#crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = new Uint8Array(await this.#crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key,
        new TextEncoder().encode(JSON.stringify(settings))));
      const revision = this.#crypto.randomUUID();
      if (!await this.#records.write({ revision, key, iv, ciphertext }, expectedRevision)) return this.#state(ERROR_CODES.SETTINGS_CONFLICT);
      this.#settings = settings; this.#revision = revision;
      this.#cleanLegacy();
      return this.#state();
    } catch { return this.#state(ERROR_CODES.STORAGE_UNAVAILABLE); }
  }
  async resetProfile(expectedRevision) {
    try {
      const revision = this.#crypto.randomUUID();
      if (!await this.#records.write({ revision, reset: true }, expectedRevision)) return this.#state(ERROR_CODES.SETTINGS_CONFLICT);
      this.#revision = revision; this.#settings = DEFAULT_SETTINGS;
      this.#cleanLegacy(); return this.#state();
    } catch { return this.#state(ERROR_CODES.STORAGE_UNAVAILABLE); }
  }
  reset() {
    this.#settings = DEFAULT_SETTINGS;
    try {
      if (this.#storage) {
        const keys = [];
        for (let i = 0; i < this.#storage.length; i++) { const key = this.#storage.key(i); if (key?.startsWith(STORAGE_NAMESPACE)) keys.push(key); }
        for (const key of keys) this.#storage.removeItem(key);
      }
      this.#persistenceRisk = false;
      return this.#state();
    } catch { this.#persistenceRisk = true; return this.#state(ERROR_CODES.STORAGE_UNAVAILABLE); }
  }
}
