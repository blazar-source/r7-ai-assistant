// Closed, content-free classes. Never pass raw exception messages or causes to UI.
export const ERROR_CODES = Object.freeze({
  INVALID_SETTINGS: 'INVALID_SETTINGS',
  INVALID_ENDPOINT: 'INVALID_ENDPOINT',
  INVALID_KEY: 'INVALID_KEY',
  INVALID_DATA: 'INVALID_DATA',
  BYTE_LIMIT: 'BYTE_LIMIT',
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
  STORAGE_CORRUPT: 'STORAGE_CORRUPT',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
});
const allowedCodes = new Set(Object.values(ERROR_CODES));
export class SafeError extends Error {
  constructor(code) {
    const safeCode = allowedCodes.has(code) ? code : ERROR_CODES.INTERNAL_ERROR;
    super(safeCode);
    this.name = 'SafeError';
    Object.defineProperty(this, 'code', { value: safeCode, enumerable: true });
  }
}
