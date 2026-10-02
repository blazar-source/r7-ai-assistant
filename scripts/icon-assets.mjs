import { deflateSync } from 'node:zlib';
import { crc32 } from './zip-store.mjs';

// Original local product mark: a blue document with white text lines and cyan
// proposal tab. No borrowed SDK artwork, font, network or raster source input.
function chunk(type, data) {
  const name = Buffer.from(type, 'ascii'); const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, checksum]);
}
export function iconPng(size) {
  if (size !== 32 && size !== 64) throw new Error('INVALID_ICON_SIZE');
  const pixels = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const px = x * 32 / size; const py = y * 32 / size;
    let color = [0, 0, 0, 0];
    if (px >= 5 && px < 25 && py >= 3 && py < 29) color = [23, 77, 156, 255];
    if (px >= 9 && px < 21 && ((py >= 9 && py < 11) || (py >= 15 && py < 17) || (py >= 21 && py < 23))) color = [255, 255, 255, 255];
    if (px >= 23 && px < 29 && py >= 20 && py < 26) color = [0, 162, 190, 255];
    const offset = y * (size * 4 + 1) + 1 + x * 4;
    for (let channel = 0; channel < 4; channel++) pixels[offset + channel] = color[channel];
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
