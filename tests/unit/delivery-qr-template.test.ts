import { createHash, randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  QR_TEMPLATE_PREVIEW_MODULES,
  QR_TEMPLATE_PREVIEW_TEXT,
  QR_TEMPLATE_MODULE_MIN_PX,
  qrModuleScale,
  resolvePanelPolicy,
  type BotInstanceId,
  type QrTemplate,
  type TenantContext,
} from '@nexa/contracts';
import {
  PngDecodeError,
  decodePngToRgb,
  encodeRgbPng,
  type RgbImage,
} from '../../apps/api/src/infrastructure/qr/png-codec';
import {
  PngDeliveryQrRenderer,
  QR_COMPOSITE_MAX_BYTES,
  QrBackgroundContentCheck,
  composeQrOnBackground,
  probeQrTemplate,
  type QrTemplateSources,
} from '../../apps/api/src/infrastructure/qr/qr-template';
import { encodeQrPng, qrModules } from '../../apps/api/src/infrastructure/qr/qr-png';
import {
  DeliveryService,
  type DeliveryServiceDeps,
} from '../../apps/api/src/modules/commerce/provisioning/application/delivery.service';
import type { ServiceRecord } from '../../apps/api/src/modules/commerce/provisioning/application/ports';
import type { CustomerFileMessage } from '../../apps/api/src/modules/commerce/messaging/application/ports';
import { FixedClock } from '../../apps/api/src/infrastructure/clock';
import { QrTemplatePreviewService } from '../../apps/api/src/modules/control/media/application/qr-template.service';
import { decodeAnyQrPng, decodeQrPng, readPngPixels } from '../support/qr-decode';
import { buildPng, chunk, gradientBackground, ihdr, pngFromChunks } from '../support/png-build';

/**
 * Phase 2 item 4: the subscription QR on a tenant's background.
 *
 * Every image this file asserts on is read back through `jsqr` and a PNG reader written in
 * `tests/support`, never through the production decoder — the decoded payload must be the
 * EXACT link, for the plain QR and for the composed one.
 */

const URL = 'https://panel.example.com:2096/sub/bnhxMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAw';
const A: TenantContext = { tenantId: 'tenant-a' as never, botInstanceId: null };
const B: TenantContext = { tenantId: 'tenant-b' as never, botInstanceId: null };
const TEMPLATE: QrTemplate = { x: 150, y: 120, size: 420, quietZoneModules: 4 };

function solid(width: number, height: number, rgb: readonly [number, number, number]): Buffer {
  return buildPng({ width, height, colourType: 2, pixel: () => rgb });
}

/** How many times any `sources()` stub has read background BYTES (not the digest). */
const reads = { count: 0 };

function sources(
  config: Partial<Record<string, { template: QrTemplate | null; background: Uint8Array | null }>>,
): QrTemplateSources {
  return {
    template: async (scope) => config[scope.tenantId]?.template ?? null,
    backgroundDigest: async (scope) => {
      const bytes = config[scope.tenantId]?.background ?? null;
      return bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
    },
    background: async (scope) => {
      reads.count += 1;
      const bytes = config[scope.tenantId]?.background ?? null;
      return bytes === null ? null : { bytes };
    },
  };
}

/** The pixel at (x, y) of an RGB image read back by the independent reader. */
function pixelAt(png: Uint8Array, x: number, y: number): [number, number, number] {
  const image = readPngPixels(png);
  if (image === null) throw new Error('unreadable');
  const i = (y * image.width + x) * 4;
  return [image.rgba[i] ?? -1, image.rgba[i + 1] ?? -1, image.rgba[i + 2] ?? -1];
}

describe('the PNG decoder (backgrounds)', () => {
  const W = 37;
  const H = 23;
  const sample = (x: number, y: number) => [
    (x * 13 + y * 7) & 0xff,
    (x * 3) & 0xff,
    (y * 11) & 0xff,
  ];

  it('reads RGB in all five scanline filters exactly', () => {
    const png = buildPng({ width: 200, height: 140, colourType: 2, pixel: (x, y) => sample(x, y) });
    const image = decodePngToRgb(png);
    expect(image.width).toBe(200);
    expect(image.height).toBe(140);
    for (const [x, y] of [
      [0, 0],
      [199, 0],
      [57, 33],
      [199, 139],
      [3, 4],
    ] as const) {
      const at = (y * 200 + x) * 3;
      expect([...image.rgb.subarray(at, at + 3)], `${x},${y}`).toEqual(sample(x, y));
    }
    void W;
    void H;
  });

  it('reads greyscale, palette, grey+alpha and RGBA, alpha flattened onto white', () => {
    const grey = decodePngToRgb(
      buildPng({ width: 130, height: 130, colourType: 0, pixel: (x) => [x] }),
    );
    expect([...grey.rgb.subarray(3 * 77, 3 * 77 + 3)]).toEqual([77, 77, 77]);

    const palette = decodePngToRgb(
      buildPng({
        width: 130,
        height: 130,
        colourType: 3,
        palette: [
          [10, 20, 30],
          [200, 100, 0],
        ],
        paletteAlpha: [255, 0],
        pixel: (x) => [x % 2],
      }),
    );
    expect([...palette.rgb.subarray(0, 3)]).toEqual([10, 20, 30]);
    // Index 1 is fully transparent: white.
    expect([...palette.rgb.subarray(3, 6)]).toEqual([255, 255, 255]);

    const greyAlpha = decodePngToRgb(
      buildPng({ width: 130, height: 130, colourType: 4, pixel: () => [0, 0] }),
    );
    expect([...greyAlpha.rgb.subarray(0, 3)]).toEqual([255, 255, 255]);

    const rgba = decodePngToRgb(
      buildPng({ width: 130, height: 130, colourType: 6, pixel: () => [0, 0, 0, 128] }),
    );
    // Half black over white.
    expect([...rgba.rgb.subarray(0, 3)]).toEqual([127, 127, 127]);
  });

  it('refuses 16-bit, sub-byte and interlaced images, and an unknown critical chunk', () => {
    const problem = (png: Buffer) => {
      try {
        decodePngToRgb(png);
        return 'ACCEPTED';
      } catch (error) {
        return (error as PngDecodeError).problem;
      }
    };
    expect(problem(pngFromChunks(ihdr(200, 200, 2, { bitDepth: 16 })))).toBe('UNSUPPORTED_FORMAT');
    expect(problem(pngFromChunks(ihdr(200, 200, 0, { bitDepth: 1 })))).toBe('UNSUPPORTED_FORMAT');
    expect(problem(pngFromChunks(ihdr(200, 200, 6, { interlace: 1 })))).toBe('UNSUPPORTED_FORMAT');
    const unknown = buildPng({
      width: 130,
      height: 130,
      colourType: 2,
      pixel: () => [1, 2, 3],
      extra: [chunk('ZZZZ', Buffer.from('x'))],
    });
    expect(problem(unknown)).toBe('UNSUPPORTED_FORMAT');
    // An unknown ANCILLARY chunk (lower-case first letter) is skipped, as the spec says.
    const ancillary = buildPng({
      width: 130,
      height: 130,
      colourType: 2,
      pixel: () => [1, 2, 3],
      extra: [chunk('tEXt', Buffer.from('Comment\0hello'))],
    });
    expect(problem(ancillary)).toBe('ACCEPTED');
  });

  it('refuses a decompression bomb by the header-declared size, before using a byte of it', () => {
    // 200 × 200 RGB declares 200 × 601 bytes; the stream inflates to 2048 × 6145.
    const bomb = pngFromChunks(
      ihdr(200, 200, 2),
      chunk('IDAT', deflateSync(Buffer.alloc(2048 * 6145))),
      chunk('IEND', Buffer.alloc(0)),
    );
    expect(bomb.length).toBeLessThan(20_000);
    expect(() => decodePngToRgb(bomb)).toThrow(
      expect.objectContaining({ problem: 'DECOMPRESSION_BOUND' }),
    );
    // A header claiming a gigapixel is refused from the header, before inflating anything.
    const giant = pngFromChunks(
      ihdr(60_000, 60_000, 2),
      chunk('IDAT', deflateSync(Buffer.alloc(10))),
      chunk('IEND', Buffer.alloc(0)),
    );
    expect(() => decodePngToRgb(giant)).toThrow(expect.objectContaining({ problem: 'DIMENSIONS' }));
  });

  it('refuses damage as CORRUPT: a bad checksum, a short stream, a bad filter, no IEND', () => {
    const good = solid(130, 130, [1, 2, 3]);
    const flipped = Buffer.from(good);
    flipped.writeUInt8((flipped[flipped.length - 20] ?? 0) ^ 0xff, flipped.length - 20);
    expect(() => decodePngToRgb(flipped)).toThrow(expect.objectContaining({ problem: 'CORRUPT' }));

    const short = pngFromChunks(
      ihdr(130, 130, 2),
      chunk('IDAT', deflateSync(Buffer.alloc(130 * 391 - 1))),
      chunk('IEND', Buffer.alloc(0)),
    );
    expect(() => decodePngToRgb(short)).toThrow(expect.objectContaining({ problem: 'CORRUPT' }));

    const raw = Buffer.alloc(130 * 391);
    raw[0] = 9;
    const badFilter = pngFromChunks(
      ihdr(130, 130, 2),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    );
    expect(() => decodePngToRgb(badFilter)).toThrow(
      expect.objectContaining({ problem: 'CORRUPT' }),
    );

    const noEnd = good.subarray(0, good.length - 12);
    expect(() => decodePngToRgb(noEnd)).toThrow(expect.objectContaining({ problem: 'CORRUPT' }));

    const outOfPalette = buildPng({
      width: 130,
      height: 130,
      colourType: 3,
      palette: [[1, 2, 3]],
      pixel: () => [5],
    });
    expect(() => decodePngToRgb(outOfPalette)).toThrow(
      expect.objectContaining({ problem: 'CORRUPT' }),
    );
  });

  it('checks every chunk’s CRC, an ancillary chunk the image does not need included', () => {
    const damaged = buildPng({
      width: 130,
      height: 130,
      colourType: 2,
      pixel: () => [1, 2, 3],
      extra: [chunk('tEXt', Buffer.from('Comment\0hello'), { badCrc: true })],
    });
    expect(() => decodePngToRgb(damaged)).toThrow(expect.objectContaining({ problem: 'CORRUPT' }));
  });

  it('answers every damaged file with a named refusal, never another exception', () => {
    const good = gradientBackground(140, 130);
    let seed = 7;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      return seed;
    };
    for (let round = 0; round < 300; round += 1) {
      const damaged = Buffer.from(good);
      const flips = 1 + (next() % 4);
      for (let f = 0; f < flips; f += 1) damaged[next() % damaged.length] = next() & 0xff;
      const cut = round % 3 === 0 ? damaged.subarray(0, next() % damaged.length) : damaged;
      try {
        decodePngToRgb(cut);
      } catch (error) {
        expect(error, `round ${round}`).toBeInstanceOf(PngDecodeError);
      }
    }
  });
});

describe('the RGB PNG encoder', () => {
  it('writes a file an independent reader returns exactly, deterministically', () => {
    const image: RgbImage = {
      width: 33,
      height: 17,
      rgb: Buffer.from(Array.from({ length: 33 * 17 * 3 }, (_, i) => (i * 37) & 0xff)),
    };
    const png = encodeRgbPng(image);
    expect(Buffer.from(encodeRgbPng(image)).equals(Buffer.from(png))).toBe(true);
    const read = readPngPixels(png);
    expect(read?.width).toBe(33);
    for (let p = 0; p < 33 * 17; p += 1) {
      for (let c = 0; c < 3; c += 1) {
        expect(read?.rgba[p * 4 + c]).toBe(image.rgb[p * 3 + c]);
      }
    }
  });
});

describe('composing the QR on a background', () => {
  const background = decodePngToRgb(gradientBackground(800, 700));

  it('draws the code where the template says, and it decodes to exactly the link', () => {
    const composed = composeQrOnBackground(URL, background, TEMPLATE);
    if (!composed.ok) throw new Error(composed.reason);
    expect(decodeAnyQrPng(composed.png)).toBe(URL);
    const read = readPngPixels(composed.png);
    expect(read?.width).toBe(800);
    expect(read?.height).toBe(700);
  });

  it('draws every module as an exact scale × scale block, centred, with the quiet zone white', () => {
    const modules = qrModules(URL);
    const count = modules.length;
    const composed = composeQrOnBackground(URL, background, TEMPLATE);
    if (!composed.ok) throw new Error(composed.reason);
    const scale = qrModuleScale(TEMPLATE.size, count, TEMPLATE.quietZoneModules);
    expect(composed.scale).toBe(scale);
    expect(scale).toBeGreaterThanOrEqual(QR_TEMPLATE_MODULE_MIN_PX);
    const side = count * scale;
    const left = TEMPLATE.x + Math.floor((TEMPLATE.size - side) / 2);
    const top = TEMPLATE.y + Math.floor((TEMPLATE.size - side) / 2);
    const image = readPngPixels(composed.png);
    if (image === null) throw new Error('unreadable');
    const at = (x: number, y: number) => image.rgba[(y * image.width + x) * 4] ?? -1;
    // Every pixel of every module, both corners of the block: one colour, the module's.
    for (let row = 0; row < count; row += 1) {
      for (let col = 0; col < count; col += 1) {
        const want = modules[row]?.[col] === true ? 0 : 255;
        for (const [dx, dy] of [
          [0, 0],
          [scale - 1, scale - 1],
          [scale - 1, 0],
        ] as const) {
          expect(at(left + col * scale + dx, top + row * scale + dy)).toBe(want);
        }
      }
    }
    // The quiet zone: at least `quietZoneModules` modules of white on every side.
    const quiet = TEMPLATE.quietZoneModules * scale;
    expect(left - TEMPLATE.x).toBeGreaterThanOrEqual(quiet);
    expect(TEMPLATE.x + TEMPLATE.size - (left + side)).toBeGreaterThanOrEqual(quiet);
    for (let y = TEMPLATE.y; y < TEMPLATE.y + TEMPLATE.size; y += 7) {
      for (let x = TEMPLATE.x; x < TEMPLATE.x + TEMPLATE.size; x += 7) {
        const inCode = x >= left && x < left + side && y >= top && y < top + side;
        if (!inCode) expect(at(x, y), `${x},${y}`).toBe(255);
      }
    }
  });

  it('never rounds the module up into the quiet zone: the scale is the floor', () => {
    // 37 modules + 2 × 4 quiet = 45 module widths; 440 / 45 = 9.78 → 9 px, never 10.
    const count = qrModules(URL).length;
    expect(count).toBe(37);
    const region: QrTemplate = { x: 100, y: 100, size: 440, quietZoneModules: 4 };
    const composed = composeQrOnBackground(URL, background, region);
    if (!composed.ok) throw new Error(composed.reason);
    expect(composed.scale).toBe(9);
    // The white margin inside the region is at least four 9 px modules on the left.
    const left = region.x + Math.floor((region.size - count * 9) / 2);
    expect(left - region.x).toBeGreaterThanOrEqual(4 * 9);
    expect(pixelAt(composed.png, left - 1, region.y + 220)).toEqual([255, 255, 255]);
    expect(decodeAnyQrPng(composed.png)).toBe(URL);
  });

  it('leaves the background outside the region exactly as it was', () => {
    const composed = composeQrOnBackground(URL, background, TEMPLATE);
    if (!composed.ok) throw new Error(composed.reason);
    for (const [x, y] of [
      [0, 0],
      [TEMPLATE.x - 1, TEMPLATE.y + 10],
      [TEMPLATE.x + TEMPLATE.size, TEMPLATE.y + 10],
      [TEMPLATE.x + 10, TEMPLATE.y + TEMPLATE.size],
      [799, 699],
    ] as const) {
      const i = (y * 800 + x) * 3;
      expect(pixelAt(composed.png, x, y), `${x},${y}`).toEqual([
        background.rgb[i],
        background.rgb[i + 1],
        background.rgb[i + 2],
      ]);
    }
  });

  it('follows the template to another place on the background', () => {
    const elsewhere: QrTemplate = { x: 20, y: 260, size: 300, quietZoneModules: 6 };
    const composed = composeQrOnBackground(URL, background, elsewhere);
    if (!composed.ok) throw new Error(composed.reason);
    expect(decodeAnyQrPng(composed.png)).toBe(URL);
    // The region's corner is white (quiet zone), the old region's centre is background again.
    expect(pixelAt(composed.png, 21, 261)).toEqual([255, 255, 255]);
    const i = (330 * 800 + 360) * 3;
    expect(pixelAt(composed.png, 360, 330)).toEqual([
      background.rgb[i],
      background.rgb[i + 1],
      background.rgb[i + 2],
    ]);
  });

  it('refuses a region too small for this link at the minimum module size', () => {
    const count = qrModules(URL).length;
    // One pixel short of four per module.
    const size = (count + 8) * QR_TEMPLATE_MODULE_MIN_PX - 1;
    const result = composeQrOnBackground(URL, background, {
      x: 0,
      y: 0,
      size,
      quietZoneModules: 4,
    });
    expect(result).toMatchObject({ ok: false, reason: 'MODULE_TOO_SMALL' });
    const fits = composeQrOnBackground(URL, background, {
      x: 0,
      y: 0,
      size: size + 1,
      quietZoneModules: 4,
    });
    expect(fits.ok).toBe(true);
  });

  it('refuses a region that does not lie inside the background', () => {
    expect(
      composeQrOnBackground(URL, background, { x: 500, y: 0, size: 301, quietZoneModules: 4 }),
    ).toMatchObject({ ok: false, reason: 'OUTSIDE_BACKGROUND' });
  });
});

describe('the delivery QR renderer', () => {
  const backgroundPng = gradientBackground(800, 700);

  it('with nothing configured, is byte for byte the plain QR every tenant received before', async () => {
    const plain = encodeQrPng(URL);
    for (const renderer of [
      new PngDeliveryQrRenderer(),
      new PngDeliveryQrRenderer(sources({})),
      new PngDeliveryQrRenderer(
        sources({ 'tenant-a': { template: null, background: backgroundPng } }),
      ),
    ]) {
      const image = await renderer.render(A, { kind: 'PAYLOAD', text: URL });
      expect(Buffer.from(image.bytes).equals(Buffer.from(plain))).toBe(true);
      expect(image).toMatchObject({ origin: 'NEXA_GENERATED', templated: false });
      expect(decodeQrPng(image.bytes)).toBe(URL);
    }
  });

  it('draws on the tenant background when a template places it, and decodes to the link', async () => {
    const renderer = new PngDeliveryQrRenderer(
      sources({ 'tenant-a': { template: TEMPLATE, background: backgroundPng } }),
    );
    const image = await renderer.render(A, { kind: 'PAYLOAD', text: URL });
    expect(image).toMatchObject({ origin: 'NEXA_GENERATED', templated: true });
    expect(decodeAnyQrPng(image.bytes)).toBe(URL);
    expect(readPngPixels(image.bytes)?.width).toBe(800);
    // Deterministic.
    const again = await renderer.render(A, { kind: 'PAYLOAD', text: URL });
    expect(Buffer.from(again.bytes).equals(Buffer.from(image.bytes))).toBe(true);
  });

  it('is the tenant’s own: another tenant without a template gets the plain QR', async () => {
    const renderer = new PngDeliveryQrRenderer(
      sources({ 'tenant-a': { template: TEMPLATE, background: backgroundPng } }),
    );
    const a = await renderer.render(A, { kind: 'PAYLOAD', text: URL });
    const b = await renderer.render(B, { kind: 'PAYLOAD', text: URL });
    expect(a.templated).toBe(true);
    expect(b.templated).toBe(false);
    expect(Buffer.from(b.bytes).equals(Buffer.from(encodeQrPng(URL)))).toBe(true);
  });

  it('uses a replaced background at once', async () => {
    const config = {
      'tenant-a': { template: TEMPLATE, background: solid(800, 700, [200, 10, 10]) },
    };
    const renderer = new PngDeliveryQrRenderer(sources(config));
    const red = await renderer.render(A, { kind: 'PAYLOAD', text: URL });
    expect(pixelAt(red.bytes, 5, 5)).toEqual([200, 10, 10]);
    config['tenant-a'].background = solid(800, 700, [10, 10, 200]);
    const blue = await renderer.render(A, { kind: 'PAYLOAD', text: URL });
    expect(pixelAt(blue.bytes, 5, 5)).toEqual([10, 10, 200]);
    expect(decodeAnyQrPng(blue.bytes)).toBe(URL);
  });

  it('falls back to the plain QR, and reports why, for every template it cannot use', async () => {
    const reasons: string[] = [];
    const cases: { template: QrTemplate; background: Uint8Array | null }[] = [
      { template: TEMPLATE, background: null },
      { template: TEMPLATE, background: Buffer.from('not a png at all') },
      // A background replaced by a smaller one after the template was saved.
      { template: TEMPLATE, background: solid(400, 400, [9, 9, 9]) },
      { template: { x: 0, y: 0, size: 128, quietZoneModules: 16 }, background: backgroundPng },
    ];
    for (const config of cases) {
      const renderer = new PngDeliveryQrRenderer(sources({ 'tenant-a': config }), (_s, reason) =>
        reasons.push(reason),
      );
      const image = await renderer.render(A, { kind: 'PAYLOAD', text: URL });
      expect(Buffer.from(image.bytes).equals(Buffer.from(encodeQrPng(URL)))).toBe(true);
      expect(image.templated).toBe(false);
    }
    expect(reasons).toEqual([
      'NO_BACKGROUND',
      'BACKGROUND_UNREADABLE',
      'OUTSIDE_BACKGROUND',
      'MODULE_TOO_SMALL',
    ]);
  });

  it('falls back when reading the configuration throws, and never fails the delivery', async () => {
    const reasons: string[] = [];
    const renderer = new PngDeliveryQrRenderer(
      {
        template: async () => {
          throw new Error('settings unreadable');
        },
        backgroundDigest: async () => null,
        background: async () => null,
      },
      (_s, reason) => reasons.push(reason),
    );
    const image = await renderer.render(A, { kind: 'PAYLOAD', text: URL });
    expect(decodeQrPng(image.bytes)).toBe(URL);
    // Its own reason: the setting failed to read, the background was never asked for.
    expect(reasons).toEqual(['CONFIG_UNREADABLE']);
  });

  it('falls back when reading the background throws, under the background’s reason', async () => {
    const reasons: string[] = [];
    const renderer = new PngDeliveryQrRenderer(
      {
        template: async () => TEMPLATE,
        backgroundDigest: async () => 'a'.repeat(64),
        background: async () => {
          throw new Error('media unreadable');
        },
      },
      (_s, reason) => reasons.push(reason),
    );
    const image = await renderer.render(A, { kind: 'PAYLOAD', text: URL });
    expect(Buffer.from(image.bytes).equals(Buffer.from(encodeQrPng(URL)))).toBe(true);
    expect(reasons).toEqual(['BACKGROUND_UNREADABLE']);
  });

  it('reads and decodes a background once, and composes a given link once', async () => {
    let decodes = 0;
    const renderer = new PngDeliveryQrRenderer(
      sources({ 'tenant-a': { template: TEMPLATE, background: backgroundPng } }),
      () => undefined,
      {
        decode: (bytes) => {
          decodes += 1;
          return decodePngToRgb(bytes);
        },
      },
    );
    const before = reads.count;
    const first = await renderer.render(A, { kind: 'PAYLOAD', text: URL });
    const second = await renderer.render(A, { kind: 'PAYLOAD', text: URL });
    expect(second.bytes).toBe(first.bytes);
    expect(reads.count - before, 'the background bytes are read once').toBe(1);
    expect(decodes, 'the background is decoded once').toBe(1);
    // Another link on the same background: composed anew, the background neither read nor
    // decoded again.
    const other = await renderer.render(A, { kind: 'PAYLOAD', text: `${URL}x` });
    expect(decodeAnyQrPng(other.bytes)).toBe(`${URL}x`);
    expect(reads.count - before).toBe(1);
    expect(decodes).toBe(1);
  });

  it('is cached per tenant: the same background and link for another tenant is its own entry', async () => {
    let decodes = 0;
    const renderer = new PngDeliveryQrRenderer(
      sources({
        'tenant-a': { template: TEMPLATE, background: backgroundPng },
        'tenant-b': { template: null, background: backgroundPng },
      }),
      () => undefined,
      {
        decode: (bytes) => {
          decodes += 1;
          return decodePngToRgb(bytes);
        },
      },
    );
    expect((await renderer.render(A, { kind: 'PAYLOAD', text: URL })).templated).toBe(true);
    expect((await renderer.render(B, { kind: 'PAYLOAD', text: URL })).templated).toBe(false);
    expect(decodes).toBe(1);
  });

  it('still refuses text that cannot be encoded, templated or not', async () => {
    const renderer = new PngDeliveryQrRenderer(
      sources({ 'tenant-a': { template: TEMPLATE, background: backgroundPng } }),
    );
    await expect(renderer.render(A, { kind: 'PAYLOAD', text: '' })).rejects.toMatchObject({
      code: 'qr.text_empty',
    });
  });

  it('passes a provider-originated image through untouched: never decoded, never re-encoded', async () => {
    const renderer = new PngDeliveryQrRenderer(
      sources({ 'tenant-a': { template: TEMPLATE, background: backgroundPng } }),
    );
    const provider = Uint8Array.from([1, 2, 3, 4, 5]);
    const image = await renderer.render(A, { kind: 'PROVIDER_IMAGE', bytes: provider });
    expect(image).toEqual({ bytes: provider, origin: 'PROVIDER_ORIGINATED', templated: false });
  });

  it('previews a draft template without storing it, and reports the plain fallback', async () => {
    const renderer = new PngDeliveryQrRenderer(
      sources({ 'tenant-a': { template: null, background: backgroundPng } }),
    );
    const draft = await renderer.renderText(A, URL, TEMPLATE);
    expect(draft).toMatchObject({ templated: true, fallback: null, width: 800, height: 700 });
    expect(decodeAnyQrPng(draft.bytes)).toBe(URL);
    const stored = await renderer.renderText(A, URL);
    expect(stored).toMatchObject({ templated: false, fallback: 'NO_TEMPLATE', scale: 8 });
  });
});

describe('the QR background content check', () => {
  const check = new QrBackgroundContentCheck();

  it('accepts a decodable PNG, and leaves every other slot alone', () => {
    expect(check.refusal('QR_BACKGROUND', 'image/png', gradientBackground(300, 200))).toBeNull();
    expect(check.refusal('REFERRAL_BANNER', 'image/png', Buffer.from('anything'))).toBeNull();
  });

  it('refuses what cannot be drawn on, with the reason', () => {
    expect(check.refusal('QR_BACKGROUND', 'image/png', solid(100, 300, [0, 0, 0]))).toMatchObject({
      reason: 'DIMENSIONS',
    });
    const bomb = pngFromChunks(
      ihdr(200, 200, 2),
      chunk('IDAT', deflateSync(Buffer.alloc(2048 * 6145))),
      chunk('IEND', Buffer.alloc(0)),
    );
    expect(check.refusal('QR_BACKGROUND', 'image/png', bomb)).toMatchObject({
      reason: 'DECOMPRESSION_BOUND',
    });
    const corrupt = Buffer.from(gradientBackground(300, 200));
    corrupt.writeUInt8((corrupt[60] ?? 0) ^ 0xff, 60);
    expect(check.refusal('QR_BACKGROUND', 'image/png', corrupt)).toMatchObject({
      reason: 'CORRUPT',
    });
  });
});

describe('the three delivery sites draw the configured template', () => {
  const BOT = 'bot-1' as BotInstanceId;
  const service = {
    id: 'svc-1',
    tenantId: 'tenant-a',
    panelId: 'panel-1',
    orderId: 'order-1',
    customerId: 'customer-1',
    providerUsername: 'nx7k2m9q',
    subscriptionUrl: URL,
    deliveryState: 'PENDING',
    deliveryAttempts: 0,
    deliveredAt: null,
  } as unknown as ServiceRecord;

  function harness() {
    const files: CustomerFileMessage[] = [];
    const deps: DeliveryServiceDeps = {
      services: {
        markSendStarted: async () => true,
        recordDelivery: async () => true,
        recordRateLimited: async () => true,
      } as unknown as DeliveryServiceDeps['services'],
      contacts: { contactFor: async () => ({ kind: 'NONE' }) } as never,
      messenger: {
        send: async () => ({ outcome: 'DELIVERED' }),
        sendFile: async (_s, message) => {
          files.push(message);
          return { outcome: 'DELIVERED' };
        },
        edit: async () => ({ outcome: 'DELIVERED' }),
        acknowledge: async () => undefined,
      },
      qr: new PngDeliveryQrRenderer(
        sources({ 'tenant-a': { template: TEMPLATE, background: gradientBackground(800, 700) } }),
      ),
      card: {
        factsFor: async () => ({
          productName: 'پلن پایه',
          serviceLocation: null,
          durationDays: 30,
          trafficBytes: 53_687_091_200n,
        }),
      },
      scopeActivity: { scopeIsActive: async () => true },
      uow: { run: async (_s: unknown, fn: (tx: never) => unknown) => fn({} as never) } as never,
      clock: new FixedClock(new Date('2026-10-06T10:00:00Z')),
      guard: { check: async () => undefined } as never,
      panelPolicy: {
        forPanel: async () =>
          resolvePanelPolicy({ delivery: { mode: 'CARD_WITH_QR' }, actions: {} }),
      },
      linkQr: { claim: async () => true },
    };
    return { delivery: new DeliveryService(deps), files };
  }

  const photoBytes = (file: CustomerFileMessage | undefined): Uint8Array => {
    if (file?.source.kind !== 'BYTES') throw new Error('no photo');
    return file.source.bytes;
  };

  const expectTemplated = (files: CustomerFileMessage[]) => {
    const photos = files.filter((file) => file.kind === 'PHOTO');
    expect(photos).toHaveLength(1);
    const bytes = photoBytes(photos[0]);
    expect(readPngPixels(bytes)?.width, 'drawn on the 800 px background').toBe(800);
    expect(decodeAnyQrPng(bytes)).toBe(URL);
  };

  it('the delivery card — a purchase and a trial alike — sends the templated QR', async () => {
    const h = harness();
    await h.delivery.deliver(A, service, '5150', BOT);
    expectTemplated(h.files);
  });

  it('a changed link (sendRotated) sends the templated QR', async () => {
    const h = harness();
    await h.delivery.deliver(A, service, '5150', BOT, { rotated: true });
    expectTemplated(h.files);
    expect(h.files[0]?.caption?.templateKey).toBe('bot.service.link_rotated');
  });

  it('the link photo of «🔗 لینک اشتراک» sends the templated QR', async () => {
    const h = harness();
    await h.delivery.redeliver(A, service, 'customer-1' as never, '5150', BOT, {
      card: { chatId: '5150', messageId: 77, botInstanceId: BOT } as never,
      linkQrKey: 'tap-1',
    });
    expectTemplated(h.files);
    // B9/C3: the one photo carries the link as its caption.
    expect(h.files[0]?.caption?.templateKey).toBe('bot.service.subscription');
  });
});

describe('review of PR #218: size, downscaling, the decoder’s bounds, the preview', () => {
  /** A raster with no structure for deflate to find: random bytes. */
  function noise(width: number, height: number): RgbImage {
    return { width, height, rgb: randomBytes(width * height * 3) };
  }

  it('the preview text’s module count is the one the contract states', () => {
    expect(qrModules(QR_TEMPLATE_PREVIEW_TEXT).length).toBe(QR_TEMPLATE_PREVIEW_MODULES);
  });

  it('refuses a composite over 1.5 MiB, and keeps a photo-like one under it', () => {
    expect(QR_COMPOSITE_MAX_BYTES).toBe(1.5 * 1024 * 1024);
    const template: QrTemplate = { x: 100, y: 100, size: 600, quietZoneModules: 4 };
    expect(composeQrOnBackground(URL, noise(1200, 1200), template)).toMatchObject({
      ok: false,
      reason: 'OUTPUT_TOO_LARGE',
    });
    const photo = decodePngToRgb(gradientBackground(1200, 1200));
    const fine = composeQrOnBackground(URL, photo, template);
    expect(fine.ok).toBe(true);
    if (fine.ok) expect(fine.png.byteLength).toBeLessThan(QR_COMPOSITE_MAX_BYTES);
  });

  it('measures the module after Telegram’s downscale: 4 px on 2048 px falls back', () => {
    const count = qrModules(URL).length;
    const big: RgbImage = { width: 2048, height: 2048, rgb: Buffer.alloc(2048 * 2048 * 3, 0x80) };
    const at = (scale: number) =>
      composeQrOnBackground(URL, big, {
        x: 0,
        y: 0,
        size: (count + 8) * scale,
        quietZoneModules: 4,
      });
    // 4 px reaches the customer at 2.5 px; 6 px at 3.75; 7 px at 4.375.
    expect(at(4)).toMatchObject({ ok: false, reason: 'MODULE_TOO_SMALL' });
    expect(at(6)).toMatchObject({ ok: false, reason: 'MODULE_TOO_SMALL' });
    expect(at(7).ok).toBe(true);
    // At 1280 px nothing is scaled, and 4 px is enough.
    const fits: RgbImage = { width: 1280, height: 900, rgb: Buffer.alloc(1280 * 900 * 3, 0x80) };
    expect(
      composeQrOnBackground(URL, fits, { x: 0, y: 0, size: (count + 8) * 4, quietZoneModules: 4 })
        .ok,
    ).toBe(true);
  });

  it('probes a template for a typical link, as the save guard asks', () => {
    const bg = gradientBackground(800, 700);
    expect(probeQrTemplate(TEMPLATE, bg)).toBeNull();
    expect(probeQrTemplate({ x: 0, y: 0, size: 128, quietZoneModules: 4 }, bg)).toBe(
      'MODULE_TOO_SMALL',
    );
    expect(probeQrTemplate({ ...TEMPLATE, x: 500 }, bg)).toBe('OUTSIDE_BACKGROUND');
    expect(probeQrTemplate(TEMPLATE, Buffer.from('not a png'))).toBe('BACKGROUND_UNREADABLE');
  });

  const problem = (png: Uint8Array) => {
    try {
      decodePngToRgb(png);
      return 'ACCEPTED';
    } catch (error) {
      return (error as PngDecodeError).problem;
    }
  };

  it('refuses a second IHDR', () => {
    const good = solid(130, 130, [1, 2, 3]);
    // Signature + IHDR is 33 bytes: insert a second IHDR right after the first.
    const twice = Buffer.concat([good.subarray(0, 33), ihdr(130, 130, 2), good.subarray(33)]);
    expect(problem(twice)).toBe('CORRUPT');
  });

  it('refuses a chunk whose length runs past the end of the file', () => {
    const good = solid(130, 130, [1, 2, 3]);
    const lying = Buffer.from(good);
    // The IDAT's length field, right after IHDR: claim far more than the file holds.
    lying.writeUInt32BE(0x00ffffff, 33);
    expect(problem(lying)).toBe('CORRUPT');
  });

  it('refuses a pixel that names a palette entry past the end', () => {
    const outOfPalette = buildPng({
      width: 130,
      height: 130,
      colourType: 3,
      palette: [
        [1, 2, 3],
        [4, 5, 6],
      ],
      pixel: (x) => [x === 129 ? 2 : 1],
    });
    expect(problem(outOfPalette)).toBe('CORRUPT');
  });

  it('applies a palette tRNS: a half-transparent entry over white, an absent one opaque', () => {
    const image = decodePngToRgb(
      buildPng({
        width: 130,
        height: 130,
        colourType: 3,
        palette: [
          [0, 0, 0],
          [0, 0, 0],
          [0, 0, 0],
        ],
        // Entry 2 has no alpha in tRNS: opaque.
        paletteAlpha: [128, 0],
        pixel: (x) => [x % 3],
      }),
    );
    expect([...image.rgb.subarray(0, 3)]).toEqual([127, 127, 127]);
    expect([...image.rgb.subarray(3, 6)]).toEqual([255, 255, 255]);
    expect([...image.rgb.subarray(6, 9)]).toEqual([0, 0, 0]);
  });

  it('the preview is charged settings.view before anything is rendered', async () => {
    let rendered = 0;
    const previewer = {
      renderText: async () => {
        rendered += 1;
        return {
          bytes: Uint8Array.from([1]),
          templated: false,
          fallback: 'NO_TEMPLATE' as const,
          scale: 8,
          width: 1,
          height: 1,
          background: { width: 800, height: 700 },
        };
      },
    };
    const checked: string[] = [];
    const refusing = new QrTemplatePreviewService(
      {
        check: async (_s: unknown, _a: unknown, permission: string) => {
          checked.push(permission);
          throw new Error('denied');
        },
      } as never,
      previewer,
    );
    await expect(refusing.preview(A, {} as never, null)).rejects.toThrow('denied');
    expect(checked).toEqual(['settings.view']);
    expect(rendered).toBe(0);

    const allowing = new QrTemplatePreviewService(
      { check: async () => undefined } as never,
      previewer,
    );
    expect(await allowing.preview(A, {} as never, null)).toMatchObject({
      background: { width: 800, height: 700 },
    });
    expect(rendered).toBe(1);
  });
});
