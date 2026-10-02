// Small deterministic ZIP32 writer: STORE only, no metadata from the host filesystem.
export function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function zipStore(entries) {
  if (!Array.isArray(entries) || entries.length > 65535) throw new Error('INVALID_ARCHIVE');
  const seen = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry.name !== 'string' || !/^[A-Za-z0-9_@-][A-Za-z0-9_@./-]*$/.test(entry.name) ||
        entry.name.split('/').some(part => !part || part === '.' || part === '..') || !Buffer.isBuffer(entry.data) ||
        entry.data.length > 0xffffffff || Buffer.byteLength(entry.name) > 65535 || seen.has(entry.name)) throw new Error('INVALID_ARCHIVE');
    seen.add(entry.name);
  }
  const sorted = [...entries].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const local = []; const central = []; let offset = 0;
  for (const entry of sorted) {
    const name = Buffer.from(entry.name, 'utf8'); const crc = crc32(entry.data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x800, 6);
    head.writeUInt16LE(33, 12); head.writeUInt32LE(crc, 14); head.writeUInt32LE(entry.data.length, 18); head.writeUInt32LE(entry.data.length, 22); head.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(0x0314, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8);
    directory.writeUInt16LE(33, 14); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(entry.data.length, 20); directory.writeUInt32LE(entry.data.length, 24); directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE((0o100644 * 65536) >>> 0, 38); directory.writeUInt32LE(offset, 42);
    local.push(head, name, entry.data); central.push(directory, name);
    offset += head.length + name.length + entry.data.length;
    if (offset > 0xffffffff) throw new Error('ARCHIVE_TOO_LARGE');
  }
  const directoryBytes = Buffer.concat(central);
  if (offset + directoryBytes.length > 0xffffffff) throw new Error('ARCHIVE_TOO_LARGE');
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(sorted.length, 8); end.writeUInt16LE(sorted.length, 10); end.writeUInt32LE(directoryBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directoryBytes, end]);
}
