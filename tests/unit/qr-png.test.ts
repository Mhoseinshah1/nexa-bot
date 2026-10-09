import { inflateSync } from 'node:zlib';
import jsQR from 'jsqr';
import { describe, expect, it } from 'vitest';
import { isNexaError } from '@nexa/contracts';
import { readPngPixels } from '../support/qr-decode';
import {
  encodeQrModulesPng,
  encodeQrPng,
  PngQrCodeEncoder,
  QR_TEXT_MAX_LENGTH,
  qrModules,
} from '../../apps/api/src/infrastructure/qr/qr-png';

/**
 * The QR encoder, checked by a DECODER this repository did not write.
 *
 * `docs/real-panel-acceptance.md` records what a fake and an adapter from the same
 * author can prove: that they agree with each other. An encoder tested only by "the
 * PNG has the right header" is that shape of test. So the round trip below hands the
 * pixels to `jsqr`, an independent reader, and asserts the string that comes back is
 * the one that went in — for the exact kind of string a customer will scan.
 */

const SUBSCRIPTION_URL =
  'https://panel.example.net:8443/sub/3f9a1c7e5b2d4a6f8e0c1b3d5f7a9c2e?name=x#frag';

/** The PNG's IHDR fields, read from the bytes rather than trusted from the encoder. */
function readHeader(png: Uint8Array): {
  width: number;
  height: number;
  depth: number;
  colour: number;
} {
  const view = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  expect(view.subarray(0, 8)).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  expect(view.subarray(12, 16).toString('ascii')).toBe('IHDR');
  return {
    width: view.readUInt32BE(16),
    height: view.readUInt32BE(20),
    depth: view[24] ?? -1,
    colour: view[25] ?? -1,
  };
}

/**
 * The greyscale scanlines back out of the PNG, walked chunk by chunk and inflated, and
 * expanded to the RGBA `jsqr` reads. Decoding the FILE rather than asking the encoder
 * for its matrix is the point: it is the bytes Telegram will show that must scan.
 */
function pixelsOf(png: Uint8Array): { data: Uint8ClampedArray; size: number } {
  const view = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  const { width, height } = readHeader(png);
  expect(width).toBe(height);
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
  expect(raw.length).toBe(stride * height);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    // Filter byte 0 on every row: the encoder writes none, and a reader must see none.
    expect(raw[y * stride]).toBe(0);
    for (let x = 0; x < width; x += 1) {
      const grey = raw[y * stride + 1 + x] ?? 0;
      const i = (y * width + x) * 4;
      data[i] = grey;
      data[i + 1] = grey;
      data[i + 2] = grey;
      data[i + 3] = 255;
    }
  }
  return { data, size: width };
}

describe('the QR PNG encoder', () => {
  it('writes a valid 8-bit greyscale PNG whose dimensions follow the module count', () => {
    const modules = qrModules(SUBSCRIPTION_URL);
    const png = encodeQrPng(SUBSCRIPTION_URL);
    const header = readHeader(png);
    expect(header.depth).toBe(8);
    expect(header.colour).toBe(0);
    // Default scale 8 and margin 4 on each side.
    expect(header.width).toBe((modules.length + 8) * 8);
    expect(header.height).toBe(header.width);
    // The trailer, so a strict reader does not report a truncated file.
    expect(Buffer.from(png.subarray(png.length - 8, png.length - 4)).toString('ascii')).toBe(
      'IEND',
    );

    const custom = readHeader(encodeQrPng(SUBSCRIPTION_URL, { scale: 3, margin: 2 }));
    expect(custom.width).toBe((modules.length + 4) * 3);
  });

  it('is deterministic: the same text encodes to identical bytes', () => {
    const first = encodeQrPng(SUBSCRIPTION_URL);
    const second = encodeQrPng(SUBSCRIPTION_URL);
    expect(Buffer.compare(Buffer.from(first), Buffer.from(second))).toBe(0);
    expect(
      Buffer.compare(
        Buffer.from(new PngQrCodeEncoder().encode(SUBSCRIPTION_URL)),
        Buffer.from(first),
      ),
    ).toBe(0);
  });

  it('encodes different text to different bytes', () => {
    const one = encodeQrPng(SUBSCRIPTION_URL);
    const other = encodeQrPng(`${SUBSCRIPTION_URL}2`);
    expect(Buffer.compare(Buffer.from(one), Buffer.from(other))).not.toBe(0);
  });

  it('round-trips a subscription URL through an independent decoder', () => {
    const { data, size } = pixelsOf(encodeQrPng(SUBSCRIPTION_URL));
    const decoded = jsQR(data, size, size);
    expect(decoded).not.toBeNull();
    expect(decoded?.data).toBe(SUBSCRIPTION_URL);
  });

  it('round-trips text outside Latin-1, because the bytes are UTF-8 and not charCode & 0xff', () => {
    // The library's own conversion would turn this into different bytes silently.
    const text = 'https://example.net/sub/x?name=Σέρβις-№1';
    const { data, size } = pixelsOf(encodeQrPng(text));
    expect(jsQR(data, size, size)?.data).toBe(text);
  });

  it('refuses empty text and text over the bound with a validation error', () => {
    for (const bad of ['', 'a'.repeat(QR_TEXT_MAX_LENGTH + 1)]) {
      try {
        encodeQrPng(bad);
        expect.unreachable('an unencodable text was encoded');
      } catch (error) {
        expect(isNexaError(error)).toBe(true);
        if (isNexaError(error)) {
          expect(error.kind).toBe('VALIDATION');
          expect(error.code).toBe(bad === '' ? 'qr.text_empty' : 'qr.text_too_long');
        }
      }
    }
    // Exactly the bound, in ASCII, still fits a version-40 symbol at level M.
    expect(() => encodeQrPng('a'.repeat(QR_TEXT_MAX_LENGTH))).not.toThrow();
    // Under the character bound but over the byte capacity: refused, not a library error.
    try {
      encodeQrPng('€'.repeat(1500));
      expect.unreachable('an over-capacity text was encoded');
    } catch (error) {
      expect(isNexaError(error) && error.code === 'qr.text_too_long').toBe(true);
    }
  });

  it('refuses a scale or margin that is not a whole number in range', () => {
    expect(() => encodeQrPng('x', { scale: 0 })).toThrow();
    expect(() => encodeQrPng('x', { scale: 1.5 })).toThrow();
    expect(() => encodeQrPng('x', { margin: -1 })).toThrow();
    expect(() => encodeQrPng('x', { margin: 0 })).not.toThrow();
  });

  /*
   * FIX-06 (2026-10-09): a margin of 0 is a real margin of 0 — never "unset", never the
   * default 4. The guard against `options.margin || DEFAULT_MARGIN` and against a
   * truthiness test anywhere between the option and the scanlines.
   */
  it('draws margin 0 with no white border: the first pixel row and column are the code', () => {
    const modules = qrModules(SUBSCRIPTION_URL);
    const count = modules.length;
    const scale = 3;
    const png = encodeQrModulesPng(modules, { scale, margin: 0 });
    expect(readHeader(png).width).toBe(count * scale);
    const image = readPngPixels(png);
    if (image === null) throw new Error('unreadable');
    expect(image.width).toBe(count * scale);
    const at = (x: number, y: number) => image.rgba[(y * image.width + x) * 4] ?? -1;
    // The top-left finder pattern's corner is dark and sits on the bitmap's own edge.
    expect(modules[0]?.[0]).toBe(true);
    expect(at(0, 0)).toBe(0);
    // Every pixel of the first row and the first column is exactly its module: dark where the
    // code is dark, never a white margin pixel standing in front of it.
    for (let i = 0; i < count * scale; i += 1) {
      const module = Math.floor(i / scale);
      expect(at(i, 0), `row 0, x ${i}`).toBe(modules[0]?.[module] === true ? 0 : 255);
      expect(at(0, i), `column 0, y ${i}`).toBe(modules[module]?.[0] === true ? 0 : 255);
    }
    // And the last row and column, so the code is not shifted inside an unchanged canvas.
    const last = count * scale - 1;
    expect(at(last, 0)).toBe(0); // the top-right finder
    expect(at(0, last)).toBe(0); // the bottom-left finder
  });

  it('draws margin 16, and refuses 17, -1 and 1.5', () => {
    const modules = qrModules(SUBSCRIPTION_URL);
    const count = modules.length;
    const png = encodeQrModulesPng(modules, { scale: 2, margin: 16 });
    expect(readHeader(png).width).toBe((count + 32) * 2);
    const image = readPngPixels(png);
    if (image === null) throw new Error('unreadable');
    const at = (x: number, y: number) => image.rgba[(y * image.width + x) * 4] ?? -1;
    expect(at(0, 0)).toBe(255);
    expect(at(16 * 2 - 1, 16 * 2 - 1)).toBe(255);
    expect(at(16 * 2, 16 * 2)).toBe(0); // the finder's corner, just inside the margin
    expect(jsQR(image.rgba, image.width, image.height)?.data).toBe(SUBSCRIPTION_URL);
    for (const margin of [17, -1, 1.5]) {
      try {
        encodeQrPng('x', { margin });
        expect.unreachable(`margin ${margin} was drawn`);
      } catch (error) {
        expect(isNexaError(error) && error.code === 'qr.margin_invalid', String(margin)).toBe(
          true,
        );
      }
    }
  });

  it('keeps the default plain QR at margin 4 when no margin is given', () => {
    const modules = qrModules(SUBSCRIPTION_URL);
    expect(readHeader(encodeQrModulesPng(modules)).width).toBe((modules.length + 8) * 8);
    expect(readHeader(encodeQrModulesPng(modules, {})).width).toBe((modules.length + 8) * 8);
  });
});
