import { LIMITS } from '../shared/limits.js';
import { ERROR_CODES, SafeError } from '../shared/errors.js';
import { assertByteLimit } from '../shared/bytes.js';

// Draft/load state is usable without credentials. Requests must use validateRequestSettings.
export const DEFAULT_SETTINGS = Object.freeze({
  endpoint: '', model: 'qwen', apiKey: '', httpTimeoutSeconds: 30,
  maxTokens: 1024, temperature: 0.2, rememberKey: false
});
const fields = new Set(Object.keys(DEFAULT_SETTINGS));
function invalid(code = ERROR_CODES.INVALID_SETTINGS) { throw new SafeError(code); }
function checkEndpoint(endpoint) {
  if (typeof endpoint !== 'string') invalid(ERROR_CODES.INVALID_ENDPOINT);
  assertByteLimit(endpoint, LIMITS.endpointBytes);
  if (endpoint === '') return;
  if (!/^https:\/\//i.test(endpoint) || /[\s\\?#]/u.test(endpoint) || /^https:\/\/[^/]*@/i.test(endpoint)) invalid(ERROR_CODES.INVALID_ENDPOINT);
  let parsed;
  try { parsed = new URL(endpoint); } catch { invalid(ERROR_CODES.INVALID_ENDPOINT); }
  const rawPath = endpoint.replace(/^https:\/\/[^/]+/i, '');
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash ||
      !rawPath.endsWith('/v1/chat/completions') || parsed.pathname !== rawPath) invalid(ERROR_CODES.INVALID_ENDPOINT);
}
function checkText(value, maximum, code, allowEmpty = false) {
  if (typeof value !== 'string') invalid(code);
  assertByteLimit(value, maximum);
  if ((!allowEmpty && !value) || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) invalid(code);
}
function checkNumber(value, min, max, integer) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) invalid();
}
function validateDraft(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) invalid();
  for (const field of Reflect.ownKeys(raw)) if (!fields.has(field)) invalid();
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(raw))) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
  }
  const settings = { ...DEFAULT_SETTINGS, ...raw };
  checkEndpoint(settings.endpoint);
  checkText(settings.model, LIMITS.modelBytes, ERROR_CODES.INVALID_SETTINGS);
  checkText(settings.apiKey, LIMITS.apiKeyBytes, ERROR_CODES.INVALID_KEY, true);
  checkNumber(settings.httpTimeoutSeconds, LIMITS.httpTimeoutMinSeconds, LIMITS.httpTimeoutMaxSeconds, true);
  checkNumber(settings.maxTokens, LIMITS.maxTokensMin, LIMITS.maxTokensMax, true);
  checkNumber(settings.temperature, LIMITS.temperatureMin, LIMITS.temperatureMax, false);
  if (typeof settings.rememberKey !== 'boolean') invalid();
  return Object.freeze(settings);
}
export function validateSettings(raw = {}) {
  try { return validateDraft(raw); }
  catch (error) {
    let code = ERROR_CODES.INVALID_SETTINGS;
    try { if (error instanceof SafeError) code = error.code; } catch { /* Untrusted reflective exception. */ }
    invalid(code);
  }
}
export function validateRequestSettings(raw) {
  const settings = validateSettings(raw);
  if (!settings.endpoint) invalid(ERROR_CODES.INVALID_ENDPOINT);
  if (!settings.apiKey) invalid(ERROR_CODES.INVALID_KEY);
  return settings;
}
