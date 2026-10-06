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

/**
 * Phase 2 item 4: the pixels of an 8-bit greyscale or RGB PNG with ANY of the five scanline
 * filters — the composed QR is RGB and filtered per row. Written here, independently of the
 * production decoder (`png-codec.ts`), so a test never reads back an image with the code that
 * wrote it. Null for anything else.
 */
export function readPngPixels(
  png: Uint8Array,
): { readonly width: number; readonly height: number; readonly rgba: Uint8ClampedArray } | null {
  const view = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (view.length < 33 || view.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  const width = view.readUInt32BE(16);
  const height = view.readUInt32BE(20);
  const colourType = view[25];
  if (view[24] !== 8 || (colourType !== 0 && colourType !== 2) || view[28] !== 0) return null;
  const channels = colourType === 0 ? 1 : 3;
  const idat: Buffer[] = [];
  let offset = 8;
  while (offset < view.length) {
    const length = view.readUInt32BE(offset);
    const type = view.subarray(offset + 4, offset + 8).toString('ascii');
    if (type === 'IDAT') idat.push(view.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length !== (stride + 1) * height) return null;
  const lines = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] ?? 0;
    for (let i = 0; i < stride; i += 1) {
      const x = raw[y * (stride + 1) + 1 + i] ?? 0;
      const a = i >= channels ? (lines[y * stride + i - channels] ?? 0) : 0;
      const b = y > 0 ? (lines[(y - 1) * stride + i] ?? 0) : 0;
      const c = y > 0 && i >= channels ? (lines[(y - 1) * stride + i - channels] ?? 0) : 0;
      const p = a + b - c;
      const paeth =
        Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c)
          ? a
          : Math.abs(p - b) <= Math.abs(p - c)
            ? b
            : c;
      const predictor = [0, a, b, (a + b) >> 1, paeth][filter];
      if (predictor === undefined) return null;
      lines[y * stride + i] = (x + predictor) & 0xff;
    }
  }
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p += 1) {
    for (let c = 0; c < 3; c += 1) {
      rgba[p * 4 + c] = lines[p * channels + (channels === 1 ? 0 : c)] ?? 0;
    }
    rgba[p * 4 + 3] = 255;
  }
  return { width, height, rgba };
}

/** The text of a greyscale or RGB QR PNG of any filter, through `jsqr`; null when none. */
export function decodeAnyQrPng(png: Uint8Array): string | null {
  const image = readPngPixels(png);
  if (image === null) return null;
  return jsQR(image.rgba, image.width, image.height)?.data ?? null;
}
