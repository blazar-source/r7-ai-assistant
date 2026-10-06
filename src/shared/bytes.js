import { ERROR_CODES, SafeError } from './errors.js';

// Count without allocating an encoded copy; lone surrogates encode as U+FFFD.
function countBytes(text, maximum) {
  if (typeof text !== 'string') throw new SafeError(ERROR_CODES.INVALID_DATA);
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
    if (bytes > maximum) throw new SafeError(ERROR_CODES.BYTE_LIMIT);
  }
  return bytes;
}
export function utf8ByteLength(text) {
  return countBytes(text, Infinity);
}
// The number of CHARACTERS a string carries, counted as CODE POINTS rather than UTF-16 units: a limit the editor
// states in characters must not depend on how a name happens to be encoded, and the two differ for astral letters.
// It sits beside the byte counter because a sheet name is bounded by BOTH (31 characters AND 128 bytes), and a
// caller should be able to read the two limits in one place.
export function characterLength(text) {
  if (typeof text !== 'string') throw new SafeError(ERROR_CODES.INVALID_DATA);
  let characters = 0;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) i += 1;
    characters += 1;
  }
  return characters;
}
export function assertByteLimit(text, maximum) {
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new SafeError(ERROR_CODES.INVALID_DATA);
  countBytes(text, maximum);
  return text;
}
