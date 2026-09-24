import { deflateSync, crc32 } from 'node:zlib';
import { errors } from '@nexa/contracts';
import qrcode from 'qrcode-generator';
import type { QrCodeEncoder } from '../../modules/commerce/provisioning/application/ports.js';

/**
 * A QR code, as an 8-bit greyscale PNG, with no dependency that touches a canvas.
 *
 * Why this exists rather than `qrcode` (the npm package most people reach for): that
 * one pulls in a PNG encoder, a canvas shim and a terminal renderer to produce one
 * image, and every dependency in a process that holds bot tokens is surface. The
 * module matrix is the only part of a QR code that needs a library — Reed–Solomon
 * codewords and the mask evaluation — and `qrcode-generator` is a single file that
 * does exactly that. The PNG around it is four chunks and a deflate stream, both of
 * which Node already ships in `node:zlib`.
 *
 * Every choice that decides the bytes is fixed here, so the same text encodes to the
 * SAME file on every process and every release:
 *
 * - error correction `M` (15% recoverable): the level a phone camera reads reliably
 *   off a screen at the sizes Telegram renders a photo, without the 25–30% size
 *   cost of `Q` and `H`, which exist for print that gets scuffed;
 * - Byte mode, over the UTF-8 bytes. `qrcode-generator`'s own `stringToBytes` takes
 *   `charCode & 0xff`, which is Latin-1 and silently mangles anything outside it, so
 *   the text is UTF-8 encoded HERE and handed over as a binary string whose char
 *   codes ARE the bytes. A subscription URL is ASCII today; the encoder must not be
 *   the thing that decides it always will be;
 * - automatic version, so the symbol is the smallest that holds the text;
 * - scale 8 and a quiet zone of 4 modules (the standard's minimum). Below 4 the
 *   locator patterns merge into whatever the chat background is and the decode
 *   rate drops off a cliff; above 8 the file grows quadratically for no gain;
 * - `deflateSync` at one fixed level. zlib's output for a given input and level is
 *   stable, which is what makes "same input, identical bytes" a property rather
 *   than a hope.
 *
 * A PNG rather than an SVG or a data URL because Telegram's `sendPhoto` accepts a
 * raster and nothing else, and greyscale rather than RGBA because the image has two
 * colours and three redundant channels would quadruple the deflate input.
 */

/** The PNG signature every decoder checks before reading a chunk. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The most text this encoder accepts, in UTF-16 code units.
 *
 * Above this a QR code at level `M` is at or past version 40 for any text that is
 * not pure ASCII, and even for ASCII it is a 177-module symbol that a phone reads
 * from a screen unreliably. A subscription URL is a few hundred characters; anything
 * near this bound is a caller passing the wrong thing, and the honest answer is a
 * refusal rather than an image nothing can scan.
 */
export const QR_TEXT_MAX_LENGTH = 2048;

/**
 * Byte-mode capacity of the largest symbol (version 40) at level `M`, from the
 * standard's capacity table. Checked before the library is asked, because it reports
 * an overflow as a bare `Error` whose message is about codewords, and a caller
 * catching validation errors would not recognise it.
 */
const QR_BYTE_CAPACITY_M = 2331;

const DEFAULT_SCALE = 8;
const DEFAULT_MARGIN = 4;

export interface QrPngOptions {
  /** Pixels per module. Default 8. */
  readonly scale?: number;
  /** Quiet zone, in modules, on every side. Default 4, the standard's minimum. */
  readonly margin?: number;
}

/**
 * The module matrix for `text`: `true` is a dark module. Row-major, no quiet zone.
 *
 * Exported so a test can decode what was encoded without re-deriving it from the
 * PNG's pixels — the matrix IS the QR code; the PNG is a rendering of it — and so
 * the refusals live in one place whichever entry point a caller uses.
 */
export function qrModules(text: string): boolean[][] {
  if (text.length === 0) {
    throw errors.validation('qr.text_empty', 'A QR code needs text to encode.');
  }
  if (text.length > QR_TEXT_MAX_LENGTH) {
    throw errors.validation(
      'qr.text_too_long',
      `A QR code may encode at most ${QR_TEXT_MAX_LENGTH} characters.`,
      { length: text.length, max: QR_TEXT_MAX_LENGTH },
    );
  }
  const utf8 = new TextEncoder().encode(text);
  if (utf8.length > QR_BYTE_CAPACITY_M) {
    throw errors.validation(
      'qr.text_too_long',
      `A QR code may encode at most ${QR_BYTE_CAPACITY_M} bytes of UTF-8.`,
      { bytes: utf8.length, max: QR_BYTE_CAPACITY_M },
    );
  }

  // See the module docblock: the library's byte conversion is Latin-1, so it is given
  // a string whose code units are the UTF-8 bytes and it copies them through intact.
  let binary = '';
  for (const byte of utf8) binary += String.fromCharCode(byte);

  const qr = qrcode(0, 'M');
  qr.addData(binary, 'Byte');
  qr.make();

  const count = qr.getModuleCount();
  const rows: boolean[][] = [];
  for (let row = 0; row < count; row += 1) {
    const cells: boolean[] = [];
    for (let col = 0; col < count; col += 1) cells.push(qr.isDark(row, col));
    rows.push(cells);
  }
  return rows;
}

/** One PNG chunk: length, type, data, CRC over type and data. */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData) >>> 0, 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * The 8-bit greyscale scanlines for a module matrix, each led by the PNG filter byte
 * `0` (no filter). Two-colour images compress well enough unfiltered that choosing a
 * filter per row would add code paths and change nothing a scanner can see.
 */
function scanlines(
  modules: readonly (readonly boolean[])[],
  scale: number,
  margin: number,
): { readonly raw: Buffer; readonly size: number } {
  const count = modules.length;
  const size = (count + margin * 2) * scale;
  const stride = size + 1;
  const raw = Buffer.alloc(stride * size, 0xff);
  for (let y = 0; y < size; y += 1) {
    raw[y * stride] = 0;
    const moduleRow = Math.floor(y / scale) - margin;
    if (moduleRow < 0 || moduleRow >= count) continue;
    const row = modules[moduleRow];
    if (row === undefined) continue;
    for (let x = 0; x < size; x += 1) {
      const moduleCol = Math.floor(x / scale) - margin;
      if (moduleCol < 0 || moduleCol >= count) continue;
      if (row[moduleCol] === true) raw[y * stride + 1 + x] = 0;
    }
  }
  return { raw, size };
}

/**
 * `text` as a QR code in an 8-bit greyscale PNG.
 *
 * Deterministic: the same text and options produce byte-identical output. Refuses
 * empty text and text over `QR_TEXT_MAX_LENGTH` with a validation error rather than
 * producing an image that encodes nothing or that nothing can read.
 */
export function encodeQrPng(text: string, options: QrPngOptions = {}): Uint8Array {
  const scale = options.scale ?? DEFAULT_SCALE;
  const margin = options.margin ?? DEFAULT_MARGIN;
  if (!Number.isInteger(scale) || scale < 1) {
    throw errors.validation('qr.scale_invalid', 'A QR scale is a positive integer.', { scale });
  }
  if (!Number.isInteger(margin) || margin < 0) {
    throw errors.validation('qr.margin_invalid', 'A QR margin is a non-negative integer.', {
      margin,
    });
  }

  const { raw, size } = scanlines(qrModules(text), scale, margin);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); // width
  ihdr.writeUInt32BE(size, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type: greyscale
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method: adaptive (per-scanline filter byte)
  ihdr[12] = 0; // interlace: none

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * The `QrCodeEncoder` port over `encodeQrPng`, with the defaults.
 *
 * A class rather than the bare function so the composition root hands the
 * provisioning lane an object it can replace in a test with one that records what it
 * was asked to encode — which, by the port's contract, must be the subscription URL
 * and nothing else.
 */
export class PngQrCodeEncoder implements QrCodeEncoder {
  encode(text: string): Uint8Array {
    return encodeQrPng(text);
  }
}
