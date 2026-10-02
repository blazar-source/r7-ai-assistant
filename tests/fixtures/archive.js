export function inventory(bytes) {
  const result = []; let offset = 0;
  while (offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    const size = bytes.readUInt32LE(offset + 18); const length = bytes.readUInt16LE(offset + 26); const extra = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + length).toString('utf8');
    const start = offset + 30 + length + extra;
    result.push({ name, method: bytes.readUInt16LE(offset + 8), time: bytes.readUInt16LE(offset + 10), date: bytes.readUInt16LE(offset + 12), crc: bytes.readUInt32LE(offset + 14), data: bytes.subarray(start, start + size) });
    offset = start + size;
  }
  return result;
}
