import { describe, expect, it } from 'vitest';
import {
  QR_BACKGROUND_MAX_SIDE,
  QR_BACKGROUND_MIN_SIDE,
  QR_TEMPLATE_QUIET_ZONE_MIN,
  QR_TEMPLATE_REGION_MIN,
  TENANT_MEDIA_MAX_BYTES,
  TENANT_MEDIA_PURPOSES,
  TENANT_MEDIA_PURPOSE_MIME_TYPES,
  inspectQrBackgroundPng,
  parseSettingValue,
  qrModuleScale,
  qrTemplatePlacementProblem,
  settingDefinition,
} from '@nexa/contracts';
import { buildPng, ihdr, pngFromChunks } from '../support/png-build';

/**
 * Phase 2 item 4: the QR background slot and the `delivery.qr_template` setting — the rules
 * the server and the Web Admin share.
 */
const TEMPLATE = { x: 100, y: 120, size: 400, quietZoneModules: 4 };

describe('the delivery.qr_template setting', () => {
  it('is declared, read by the delivery lane, and null (the plain QR) by default', () => {
    const definition = settingDefinition('delivery.qr_template');
    expect(definition.defaultValue).toBeNull();
    expect(definition.consumer).toBe('ACTIVE');
    expect(definition.zeroMeaning).toBe('DISABLES');
    expect(parseSettingValue('delivery.qr_template', null)).toEqual({ ok: true, value: null });
    expect(parseSettingValue('delivery.qr_template', TEMPLATE)).toEqual({
      ok: true,
      value: TEMPLATE,
    });
  });

  it('refuses a quiet zone under four modules, a region under the minimum, and fractions', () => {
    const bad = (patch: Record<string, unknown>) =>
      parseSettingValue('delivery.qr_template', { ...TEMPLATE, ...patch }).ok;
    expect(bad({ quietZoneModules: QR_TEMPLATE_QUIET_ZONE_MIN - 1 })).toBe(false);
    expect(bad({ quietZoneModules: QR_TEMPLATE_QUIET_ZONE_MIN })).toBe(true);
    expect(bad({ size: QR_TEMPLATE_REGION_MIN - 1 })).toBe(false);
    expect(bad({ size: QR_TEMPLATE_REGION_MIN })).toBe(true);
    expect(bad({ size: 400.5 })).toBe(false);
    expect(bad({ x: -1 })).toBe(false);
    expect(bad({ x: QR_BACKGROUND_MAX_SIDE + 1 })).toBe(false);
    // Width and height are one number: the region is a square, so the code cannot be stretched.
    expect(bad({ width: 400 })).toBe(false);
  });

  it('places the region wholly inside the background, and nowhere else', () => {
    expect(qrTemplatePlacementProblem(TEMPLATE, { width: 500, height: 520 })).toBeNull();
    expect(qrTemplatePlacementProblem(TEMPLATE, { width: 499, height: 520 })).toBe(
      'OUTSIDE_BACKGROUND',
    );
    expect(qrTemplatePlacementProblem(TEMPLATE, { width: 500, height: 519 })).toBe(
      'OUTSIDE_BACKGROUND',
    );
  });

  it('draws a whole number of pixels per module, never a fraction', () => {
    // 29 modules + 2 × 4 quiet = 37 module widths; 400 / 37 = 10.8 → 10.
    expect(qrModuleScale(400, 29, 4)).toBe(10);
    expect(qrModuleScale(370, 29, 4)).toBe(10);
    expect(qrModuleScale(369, 29, 4)).toBe(9);
  });
});

describe('the QR_BACKGROUND media slot', () => {
  it('is a slot of its own, PNG only, while the banner keeps PNG and JPEG', () => {
    expect(TENANT_MEDIA_PURPOSES).toContain('QR_BACKGROUND');
    expect(TENANT_MEDIA_PURPOSE_MIME_TYPES.QR_BACKGROUND).toEqual(['image/png']);
    expect(TENANT_MEDIA_PURPOSE_MIME_TYPES.REFERRAL_BANNER).toEqual(['image/png', 'image/jpeg']);
  });

  it('reads a background header: dimensions, and the formats this release decodes', () => {
    for (const colourType of [0, 2, 3, 4, 6] as const) {
      const png = pngFromChunks(ihdr(640, 480, colourType));
      expect(inspectQrBackgroundPng(png), String(colourType)).toEqual({
        ok: true,
        width: 640,
        height: 480,
      });
    }
  });

  it('refuses a JPEG, an empty file, an oversized file and a header it cannot read', () => {
    expect(inspectQrBackgroundPng(new Uint8Array(0))).toEqual({ ok: false, problem: 'EMPTY' });
    expect(inspectQrBackgroundPng(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toEqual({
      ok: false,
      problem: 'NOT_PNG',
    });
    const big = Buffer.alloc(TENANT_MEDIA_MAX_BYTES + 1);
    pngFromChunks(ihdr(640, 480, 2)).copy(big);
    expect(inspectQrBackgroundPng(big)).toEqual({ ok: false, problem: 'TOO_LARGE' });
    const truncated = pngFromChunks(ihdr(640, 480, 2)).subarray(0, 20);
    expect(inspectQrBackgroundPng(truncated)).toEqual({ ok: false, problem: 'UNREADABLE' });
  });

  it('refuses a side under the minimum or over the maximum', () => {
    const at = (w: number, h: number) => inspectQrBackgroundPng(pngFromChunks(ihdr(w, h, 2)));
    expect(at(QR_BACKGROUND_MIN_SIDE, QR_BACKGROUND_MIN_SIDE).ok).toBe(true);
    expect(at(QR_BACKGROUND_MAX_SIDE, QR_BACKGROUND_MAX_SIDE).ok).toBe(true);
    expect(at(QR_BACKGROUND_MIN_SIDE - 1, 400)).toEqual({ ok: false, problem: 'DIMENSIONS' });
    expect(at(400, QR_BACKGROUND_MAX_SIDE + 1)).toEqual({ ok: false, problem: 'DIMENSIONS' });
    // A header claiming a gigapixel is refused from the header, before anything is inflated.
    expect(at(65_535, 65_535)).toEqual({ ok: false, problem: 'DIMENSIONS' });
  });

  it('refuses 16-bit, sub-byte and interlaced images', () => {
    expect(inspectQrBackgroundPng(pngFromChunks(ihdr(400, 400, 2, { bitDepth: 16 })))).toEqual({
      ok: false,
      problem: 'UNSUPPORTED_FORMAT',
    });
    expect(inspectQrBackgroundPng(pngFromChunks(ihdr(400, 400, 3, { bitDepth: 4 })))).toEqual({
      ok: false,
      problem: 'UNSUPPORTED_FORMAT',
    });
    expect(inspectQrBackgroundPng(pngFromChunks(ihdr(400, 400, 6, { interlace: 1 })))).toEqual({
      ok: false,
      problem: 'UNSUPPORTED_FORMAT',
    });
  });

  it('accepts a complete PNG the test builder wrote', () => {
    const png = buildPng({ width: 200, height: 150, colourType: 2, pixel: () => [1, 2, 3] });
    expect(inspectQrBackgroundPng(png)).toEqual({ ok: true, width: 200, height: 150 });
  });
});
