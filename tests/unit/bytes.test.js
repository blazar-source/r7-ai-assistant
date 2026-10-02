import test from 'node:test';
import assert from 'node:assert/strict';
import { utf8ByteLength, assertByteLimit } from '../../src/shared/bytes.js';

test('UTF-8 measures ASCII, Cyrillic, emoji and unpaired surrogate replacement bytes', () => {
  for (const [text, expected] of [['', 0], ['abc', 3], ['я', 2], ['€', 3], ['😀', 4], ['\ud800', 3], ['\udc00', 3], ['\ud800a', 4]]) assert.equal(utf8ByteLength(text), expected);
});
for (const cap of [128, 2048, 4096, 8192, 65536, 98304, 131072]) {
  test(`byte guard accepts ${cap} and refuses excess without truncating`, () => {
    const text = '😀'.repeat(cap / 4);
    assert.equal(assertByteLimit(text, cap), text);
    assert.throws(() => assertByteLimit(text + 'a', cap), e => e.code === 'BYTE_LIMIT' && !e.message.includes(text));
  });
}
test('byte helpers refuse nonstrings and invalid budgets safely', () => {
  for (const text of [null, {}, 1]) assert.throws(() => utf8ByteLength(text), e => e.code === 'INVALID_DATA');
  for (const cap of [-1, NaN, Infinity, 1.5]) assert.throws(() => assertByteLimit('a', cap), e => e.code === 'INVALID_DATA');
});
