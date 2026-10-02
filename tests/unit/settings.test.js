import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, validateSettings, validateRequestSettings } from '../../src/config/settings.js';
import { SafeError } from '../../src/shared/errors.js';

const configured = { endpoint: 'https://example.invalid/provider/v1/chat/completions', apiKey: 'synthetic-test-key' };
const rejects = (raw, code = 'INVALID_SETTINGS', fn = validateSettings) => {
  assert.throws(() => fn(raw), e => e.code === code && !e.message.includes('synthetic-test-key'));
};

test('defaults are a frozen usable draft, not an effective request', () => {
  const draft = validateSettings();
  assert.deepEqual(draft, { endpoint: '', model: 'qwen', apiKey: '', httpTimeoutSeconds: 30, maxTokens: 1024, temperature: 0.2, rememberKey: false });
  assert.ok(Object.isFrozen(draft));
  assert.ok(Object.isFrozen(DEFAULT_SETTINGS));
  rejects(draft, 'INVALID_ENDPOINT', validateRequestSettings);
  rejects({ endpoint: configured.endpoint }, 'INVALID_KEY', validateRequestSettings);
});

test('HTTPS provider prefix is preserved and request snapshot is independent', () => {
  const raw = { ...configured, model: 'qwen/qwen3.8-27b:free' };
  const result = validateRequestSettings(raw);
  raw.apiKey = 'changed';
  assert.equal(result.endpoint, configured.endpoint);
  assert.equal(result.model, 'qwen/qwen3.8-27b:free');
  assert.equal(result.apiKey, 'synthetic-test-key');
  assert.ok(Object.isFrozen(result));
  assert.equal(validateSettings({ endpoint: 'https://example.invalid/v1/chat/completions' }).endpoint, 'https://example.invalid/v1/chat/completions');
});

test('at-sign in HTTPS provider-prefix path remains valid', () => {
  const endpoint = 'https://example.invalid/provider@tenant/v1/chat/completions';
  assert.equal(validateRequestSettings({ ...configured, endpoint }).endpoint, endpoint);
});

for (const endpoint of ['http://example.invalid/v1/chat/completions', 'https://u:p@example.invalid/v1/chat/completions', 'https://@example.invalid/v1/chat/completions', 'https://:@example.invalid/v1/chat/completions', 'https://example.invalid/v1/chat/completions?', 'https://example.invalid/v1/chat/completions#', 'https://example.invalid/v1/chat/completions/', 'https://example.invalid/v1/chat/completions?x=1', 'https://example.invalid/v1/chat/completions#x', ' https://example.invalid/v1/chat/completions', 'https://example.invalid/other', 'https://example.invalid/\nv1/chat/completions', 'https://example.invalid/a/../v1/chat/completions']) {
  test(`reject invalid endpoint fixture ${JSON.stringify(endpoint)}`, () => rejects({ endpoint }, 'INVALID_ENDPOINT'));
}

for (const [field, bad] of [ ['model', ''], ['model', 'qwen\rX'], ['apiKey', 'synthetic-test-key\nX'], ['model', ' qwen'], ['apiKey', ' key '], ['httpTimeoutSeconds', 4], ['httpTimeoutSeconds', 121], ['httpTimeoutSeconds', NaN], ['httpTimeoutSeconds', Infinity], ['httpTimeoutSeconds', 5.5], ['maxTokens', 63], ['maxTokens', 8193], ['maxTokens', 64.5], ['temperature', -0.1], ['temperature', 2.1], ['temperature', NaN], ['temperature', Infinity], ['temperature', '0.2'], ['rememberKey', 1] ]) {
  test(`reject ${field} invalid value ${JSON.stringify(String(bad))}`, () => rejects({ [field]: bad }, field === 'apiKey' ? 'INVALID_KEY' : 'INVALID_SETTINGS'));
}

test('closed plain settings schema rejects unknown/prototype inputs without reflecting data', () => {
  for (const raw of [null, [], 'synthetic-test-key', { unexpected: 'synthetic-test-key' }, JSON.parse('{"__proto__":{}}'), Object.create({ model: 'qwen' })]) rejects(raw);
});

test('accessor inputs are rejected without invoking secret-throwing getter', () => {
  rejects(Object.defineProperty({}, 'model', { get() { throw new Error('synthetic-test-key'); }, enumerable: true }));
});
test('hidden settings fields cannot be silently ignored', () => {
  rejects(Object.defineProperty({}, 'model', { value: 'other', enumerable: false }));
});
test('reflective exceptions become static safe errors', () => {
  rejects(new Proxy({}, { ownKeys() { throw new Error('synthetic-test-key'); } }));
});

test('mutated nominally safe errors are reclassified without reflecting their message', () => {
  const error = new SafeError('INVALID_SETTINGS');
  error.message = 'synthetic-test-key';
  rejects(new Proxy({}, { ownKeys() { throw error; } }));
});

test('numeric inclusive bounds and fractional temperature are valid', () => {
  for (const values of [{ httpTimeoutSeconds: 5, maxTokens: 64, temperature: 0 }, { httpTimeoutSeconds: 120, maxTokens: 8192, temperature: 2 }]) {
    const result = validateSettings(values);
    for (const [field, value] of Object.entries(values)) assert.equal(result[field], value);
  }
});

test('settings UTF-8 caps accept exact boundary and reject one byte over', () => {
  const suffix = '/v1/chat/completions';
  const prefix = 'https://example.invalid/';
  const endpoint = prefix + 'a'.repeat(2048 - prefix.length - suffix.length) + suffix;
  assert.equal(validateSettings({ endpoint }).endpoint.length, 2048);
  rejects({ endpoint: endpoint.replace(suffix, 'a' + suffix) }, 'BYTE_LIMIT');
  assert.equal(validateSettings({ model: 'я'.repeat(64) }).model, 'я'.repeat(64));
  rejects({ model: 'я'.repeat(64) + 'a' }, 'BYTE_LIMIT');
  assert.equal(validateSettings({ apiKey: 'я'.repeat(2048) }).apiKey, 'я'.repeat(2048));
  rejects({ apiKey: 'я'.repeat(2048) + 'a' }, 'BYTE_LIMIT');
});
