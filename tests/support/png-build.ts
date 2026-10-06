import { crc32, deflateSync } from 'node:zlib';

/**
 * PNG files for tests of the QR background (Phase 2 item 4), written HERE rather than by the
 * production encoder so a decoder test does not read back what its own sibling wrote.
 *
 * Any colour type, bit depth and filter can be asked for — including the ones production
 * refuses — and `chunk` / `pngFromChunks` let a test hand-craft a hostile file (a bomb, a bad
 * CRC, a lying header).
 */

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function chunk(type: string, data: Buffer, options: { badCrc?: boolean } = {}): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE((crc32(typeAndData) ^ (options.badCrc === true ? 1 : 0)) >>> 0, 0);
  return Buffer.concat([length, typeAndData, crc]);
}

export function ihdr(
  width: number,
  height: number,
  colourType: number,
  options: { bitDepth?: number; interlace?: number } = {},
): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = options.bitDepth ?? 8;
  data[9] = colourType;
  data[10] = 0;
  data[11] = 0;
  data[12] = options.interlace ?? 0;
  return chunk('IHDR', data);
}

export function pngFromChunks(...chunks: Buffer[]): Buffer {
  return Buffer.concat([PNG_SIGNATURE, ...chunks]);
}

const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Filters one scanline with `type`, given the previous raw (unfiltered) line. */
function filterLine(type: number, line: Buffer, previous: Buffer, bpp: number): Buffer {
  const out = Buffer.alloc(line.length + 1);
  out[0] = type;
  for (let i = 0; i < line.length; i += 1) {
    const x = line[i] as number;
    const a = i >= bpp ? (line[i - bpp] as number) : 0;
    const b = previous[i] as number;
    const c = i >= bpp ? (previous[i - bpp] as number) : 0;
    const predictor =
      type === 0 ? 0 : type === 1 ? a : type === 2 ? b : type === 3 ? (a + b) >> 1 : paeth(a, b, c);
    out[i + 1] = (x - predictor) & 0xff;
  }
  return out;
}

export interface BuildPngOptions {
  readonly width: number;
  readonly height: number;
  /** 0 grey, 2 RGB, 3 palette, 4 grey+alpha, 6 RGBA. */
  readonly colourType: 0 | 2 | 3 | 4 | 6;
  /** The raw samples of pixel (x, y), in the colour type's channel order. */
  readonly pixel: (x: number, y: number) => readonly number[];
  /** The filter of row y; by default the rows cycle through all five. */
  readonly filterOf?: (y: number) => number;
  /** For colour type 3: RGB triples. */
  readonly palette?: readonly (readonly [number, number, number])[];
  /** For colour type 3: alpha per palette index. */
  readonly paletteAlpha?: readonly number[];
  /** Ancillary chunks to place before IDAT. */
  readonly extra?: readonly Buffer[];
}

/** An 8-bit, non-interlaced PNG of the given colour type. */
export function buildPng(options: BuildPngOptions): Buffer {
  const channels = CHANNELS[options.colourType] as number;
  const stride = options.width * channels;
  const lines: Buffer[] = [];
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < options.height; y += 1) {
    const line = Buffer.alloc(stride);
    for (let x = 0; x < options.width; x += 1) {
      const samples = options.pixel(x, y);
      for (let c = 0; c < channels; c += 1) line[x * channels + c] = samples[c] ?? 0;
    }
    const type = options.filterOf?.(y) ?? y % 5;
    lines.push(filterLine(type, line, previous, channels));
    previous = line;
  }
  const chunks: Buffer[] = [ihdr(options.width, options.height, options.colourType)];
  if (options.palette !== undefined) {
    chunks.push(chunk('PLTE', Buffer.from(options.palette.flat())));
  }
  if (options.paletteAlpha !== undefined) {
    chunks.push(chunk('tRNS', Buffer.from(options.paletteAlpha)));
  }
  chunks.push(...(options.extra ?? []));
  chunks.push(chunk('IDAT', deflateSync(Buffer.concat(lines))));
  chunks.push(chunk('IEND', Buffer.alloc(0)));
  return pngFromChunks(...chunks);
}

/** A gradient RGB background: every pixel differs from its neighbours, as a photo would. */
export function gradientBackground(width: number, height: number): Buffer {
  return buildPng({
    width,
    height,
    colourType: 2,
    pixel: (x, y) => [(x * 7 + y) & 0xff, (y * 5 + 40) & 0xff, ((x ^ y) * 3) & 0xff],
  });
}
