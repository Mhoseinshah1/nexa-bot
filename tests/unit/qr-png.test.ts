import { inflateSync } from 'node:zlib';
import jsQR from 'jsqr';
import { describe, expect, it } from 'vitest';
import { isNexaError } from '@nexa/contracts';
import {
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
});
