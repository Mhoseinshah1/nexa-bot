import { crc32, deflateSync, inflateSync } from 'node:zlib';
import {
  inspectQrBackgroundPng,
  type QrBackgroundProblem,
  QR_BACKGROUND_MAX_SIDE,
} from '@nexa/contracts';

/**
 * A bounded PNG decoder and an RGB PNG encoder, over `node:zlib` and nothing else
 * (Phase 2 item 4, the QR background).
 *
 * Why hand-written rather than `pngjs` or `sharp`: the same reason `qr-png.ts` gives. Every
 * dependency in a process that holds bot tokens is surface, and `sharp` is a native binary.
 * PNG is a signature, a list of CRC-checked chunks and one deflate stream of filtered
 * scanlines; Node ships the deflate.
 *
 * ## What is read, and what is refused
 *
 * Bit depth 8, non-interlaced, colour types 0 (grey), 2 (RGB), 3 (palette), 4 (grey+alpha)
 * and 6 (RGBA): every format a design tool exports a background in by default. 16-bit,
 * sub-byte depths and Adam7 interlacing are REFUSED with a named problem rather than decoded
 * wrongly. Alpha is flattened onto white, because the delivered photo has no alpha and
 * Telegram would flatten it onto whatever it chose.
 *
 * ## The decompression bomb
 *
 * A PNG of a few kilobytes can declare 65 535 × 65 535 pixels and inflate to gigabytes. The
 * bound is decided from the HEADER before a byte is inflated: each side at most
 * `QR_BACKGROUND_MAX_SIDE`, so the filtered image is at most 2048 × (1 + 2048 × 4) bytes, and
 * `inflateSync` is given EXACTLY the size the header implies as `maxOutputLength`. A stream
 * that inflates to more than its header declares is refused as `DECOMPRESSION_BOUND`, not
 * truncated and used. Chunk lengths are checked against the bytes present, so a lying length
 * cannot read past the buffer.
 */

export class PngDecodeError extends Error {
  constructor(
    readonly problem: QrBackgroundProblem,
    message: string,
  ) {
    super(message);
    this.name = 'PngDecodeError';
  }
}

/** An opaque 8-bit RGB raster, row-major, 3 bytes a pixel. */
export interface RgbImage {
  readonly width: number;
  readonly height: number;
  readonly rgb: Buffer;
}

const SIGNATURE_LENGTH = 8;
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Alpha over white, rounded. */
function overWhite(value: number, alpha: number): number {
  return Math.floor((value * alpha + 255 * (255 - alpha) + 127) / 255);
}

/**
 * Decodes a PNG to opaque RGB, or throws `PngDecodeError` naming why not. Never throws
 * anything else for any input: every malformed shape is a named refusal.
 */
export function decodePngToRgb(input: Uint8Array): RgbImage {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const header = inspectQrBackgroundPng(bytes);
  if (!header.ok)
    throw new PngDecodeError(header.problem, `The PNG is refused: ${header.problem}.`);
  const { width, height } = header;
  const colourType = bytes[25] as number;
  const channels = CHANNELS[colourType] as number;

  let palette: Buffer | null = null;
  let paletteAlpha: Buffer | null = null;
  const idat: Buffer[] = [];
  let sawEnd = false;
  let offset = SIGNATURE_LENGTH;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw corrupt('a chunk header is truncated');
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) throw corrupt('a chunk is longer than the file');
    const type = bytes.subarray(offset + 4, offset + 8).toString('latin1');
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const crc = bytes.readUInt32BE(offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) >>> 0 !== crc) {
      throw corrupt(`the ${JSON.stringify(type)} chunk fails its checksum`);
    }
    offset += 12 + length;
    if (type === 'IHDR') {
      if (offset !== SIGNATURE_LENGTH + 25) throw corrupt('a second IHDR');
    } else if (type === 'PLTE') {
      if (length === 0 || length % 3 !== 0 || length > 256 * 3) throw corrupt('a malformed PLTE');
      palette = Buffer.from(data);
    } else if (type === 'tRNS') {
      if (colourType === 3) paletteAlpha = Buffer.from(data);
      // For grey and RGB a tRNS is a colour key; the background is drawn opaque, so it is
      // ignored rather than refused. For the alpha types it is not allowed and ignored too.
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      sawEnd = true;
      break;
    } else if ((type.charCodeAt(0) & 0x20) === 0) {
      // A critical chunk this decoder does not know: the specification says to refuse.
      throw new PngDecodeError('UNSUPPORTED_FORMAT', `An unknown critical chunk ${type}.`);
    }
  }
  if (!sawEnd) throw corrupt('there is no IEND');
  if (idat.length === 0) throw corrupt('there is no image data');
  if (colourType === 3 && palette === null) throw corrupt('a palette image has no PLTE');

  const stride = width * channels;
  const expected = height * (stride + 1);
  // `QR_BACKGROUND_MAX_SIDE` is already enforced by the header check; restated as the
  // arithmetic bound the inflate is held to, so the two cannot drift apart silently.
  if (expected > QR_BACKGROUND_MAX_SIDE * (QR_BACKGROUND_MAX_SIDE * 4 + 1)) {
    throw new PngDecodeError('DIMENSIONS', 'The image is larger than a background may be.');
  }
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected });
  } catch (error) {
    if (
      error instanceof RangeError ||
      (error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE'
    ) {
      throw new PngDecodeError(
        'DECOMPRESSION_BOUND',
        'The image data inflates to more than its header declares.',
      );
    }
    throw corrupt('the image data is not a valid deflate stream');
  }
  if (raw.length !== expected) throw corrupt('the image data is shorter than its header declares');

  // Unfilter in place, row by row.
  const lines = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] as number;
    const source = y * (stride + 1) + 1;
    const target = y * stride;
    const previous = target - stride;
    for (let i = 0; i < stride; i += 1) {
      const x = raw[source + i] as number;
      const a = i >= channels ? (lines[target + i - channels] as number) : 0;
      const b = y > 0 ? (lines[previous + i] as number) : 0;
      const c = y > 0 && i >= channels ? (lines[previous + i - channels] as number) : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = x;
          break;
        case 1:
          value = x + a;
          break;
        case 2:
          value = x + b;
          break;
        case 3:
          value = x + ((a + b) >> 1);
          break;
        case 4:
          value = x + paeth(a, b, c);
          break;
        default:
          throw corrupt(`row ${String(y)} has the unknown filter ${String(filter)}`);
      }
      lines[target + i] = value & 0xff;
    }
  }

  const rgb = Buffer.alloc(width * height * 3);
  const pixels = width * height;
  for (let p = 0; p < pixels; p += 1) {
    const s = p * channels;
    const t = p * 3;
    switch (colourType) {
      case 0: {
        const grey = lines[s] as number;
        rgb[t] = grey;
        rgb[t + 1] = grey;
        rgb[t + 2] = grey;
        break;
      }
      case 2:
        rgb[t] = lines[s] as number;
        rgb[t + 1] = lines[s + 1] as number;
        rgb[t + 2] = lines[s + 2] as number;
        break;
      case 3: {
        const index = lines[s] as number;
        const plte = palette as Buffer;
        if (index * 3 + 2 >= plte.length)
          throw corrupt('a pixel names a palette entry past the end');
        const alpha =
          paletteAlpha !== null && index < paletteAlpha.length
            ? (paletteAlpha[index] as number)
            : 255;
        rgb[t] = overWhite(plte[index * 3] as number, alpha);
        rgb[t + 1] = overWhite(plte[index * 3 + 1] as number, alpha);
        rgb[t + 2] = overWhite(plte[index * 3 + 2] as number, alpha);
        break;
      }
      case 4: {
        const grey = overWhite(lines[s] as number, lines[s + 1] as number);
        rgb[t] = grey;
        rgb[t + 1] = grey;
        rgb[t + 2] = grey;
        break;
      }
      default: {
        const alpha = lines[s + 3] as number;
        rgb[t] = overWhite(lines[s] as number, alpha);
        rgb[t + 1] = overWhite(lines[s + 1] as number, alpha);
        rgb[t + 2] = overWhite(lines[s + 2] as number, alpha);
      }
    }
  }
  return { width, height, rgb };
}

function corrupt(why: string): PngDecodeError {
  return new PngDecodeError('CORRUPT', `The PNG is damaged: ${why}.`);
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData) >>> 0, 0);
  return Buffer.concat([length, typeAndData, crc]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * An RGB raster as an 8-bit RGB PNG: IHDR, one IDAT, IEND, and nothing else — no metadata an
 * uploaded file carried survives into what a customer receives.
 *
 * Every row uses ONE filter, Paeth: it compresses a photo-like background close to libpng's
 * per-row search at a fifth of the work (review of PR #218 measured the five-filter search at
 * up to 1.5 s for a 2048 px image, on the thread that answers Telegram updates). The first
 * row has no row above it, where Paeth reduces to Sub. Deterministic: the same raster gives
 * the same bytes.
 */
export function encodeRgbPng(image: RgbImage): Uint8Array {
  const { width, height, rgb } = image;
  const stride = width * 3;
  const out = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    const target = y * (stride + 1);
    out[target] = 4;
    for (let i = 0; i < stride; i += 1) {
      const a = i >= 3 ? (rgb[row + i - 3] as number) : 0;
      const b = y > 0 ? (rgb[row - stride + i] as number) : 0;
      const c = y > 0 && i >= 3 ? (rgb[row - stride + i - 3] as number) : 0;
      out[target + 1 + i] = ((rgb[row + i] as number) - paeth(a, b, c)) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(out, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
