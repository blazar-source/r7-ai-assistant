import test from 'node:test';
import assert from 'node:assert/strict';
import { zipStore } from '../../scripts/zip-store.mjs';
import { inventory } from '../fixtures/archive.js';
test('ZIP STORE has stable sorted inventory, fixed timestamp/modes and known CRC32', () => {
  const zip = zipStore([{ name: 'z.txt', data: Buffer.from('123456789') }, { name: 'a.txt', data: Buffer.from('A') }]);
  assert.ok(zip.length > 22);
  const entries = inventory(zip);
  assert.deepEqual(entries.map(e => e.name), ['a.txt', 'z.txt']);
  assert.equal(entries[1].crc, 0xcbf43926);
  for (const item of entries) { assert.equal(item.method, 0); assert.equal(item.time, 0); assert.equal(item.date, 33); }
  assert.deepEqual(zip, zipStore([{ name: 'a.txt', data: Buffer.from('A') }, { name: 'z.txt', data: Buffer.from('123456789') }]));
  const central = zip.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
  assert.equal(zip.readUInt32LE(central + 38) >>> 16, 0o100644);
});
test('ZIP refuses duplicate/traversal/absolute names and non-buffer data', () => {
  for (const name of ['../key', '/root', 'a\\b', 'a/../b', '.env', 'a//b']) assert.throws(() => zipStore([{ name, data: Buffer.from('x') }]));
  assert.throws(() => zipStore([{ name: 'x', data: Buffer.from('a') }, { name: 'x', data: Buffer.from('b') }]));
  assert.throws(() => zipStore([{ name: 'x', data: 'text' }]));
});
