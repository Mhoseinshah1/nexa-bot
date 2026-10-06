import { inflateSync } from 'node:zlib';
import jsQR from 'jsqr';

/**
 * Reads back the text of a QR PNG this repository's encoder wrote, through `jsqr` — a decoder
 * this repository did not write (see `tests/unit/qr-png.test.ts` for why that matters).
 *
 * Handles exactly the shape `encodeQrPng` writes: 8-bit greyscale, square, filter byte 0 on
 * every row. Anything else answers null rather than a guess.
 */
export function decodeQrPng(png: Uint8Array): string | null {
  const view = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (view.length < 33 || view.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  const width = view.readUInt32BE(16);
  const height = view.readUInt32BE(20);
  if (width !== height || view[24] !== 8 || view[25] !== 0) return null;
  const idat: Buffer[] = [];
  let offset = 8;
  while (offset < view.length) {
    const length = view.readUInt32BE(offset);
    const type = view.subarray(offset + 4, offset + 8).toString('ascii');
    if (type === 'IDAT') idat.push(view.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width + 1;
  if (raw.length !== stride * height) return null;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    if (raw[y * stride] !== 0) return null;
    for (let x = 0; x < width; x += 1) {
      const grey = raw[y * stride + 1 + x] ?? 0;
      const i = (y * width + x) * 4;
      data[i] = grey;
      data[i + 1] = grey;
      data[i + 2] = grey;
      data[i + 3] = 255;
    }
  }
  return jsQR(data, width, height)?.data ?? null;
}
