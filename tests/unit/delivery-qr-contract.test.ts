import { describe, expect, it } from 'vitest';
import {
  QR_TELEGRAM_PHOTO_MAX_SIDE,
  QR_TEMPLATE_MODULE_MIN_PX,
  qrEffectiveModulePx,
  QR_BACKGROUND_MAX_SIDE,
  QR_BACKGROUND_MIN_SIDE,
  QR_TEMPLATE_QUIET_ZONE_DEFAULT,
  QR_TEMPLATE_QUIET_ZONE_MAX,
  QR_TEMPLATE_QUIET_ZONE_MIN,
  deliveryQrPreviewRequestSchema,
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

  it('refuses a region under the minimum, and fractions', () => {
    const bad = (patch: Record<string, unknown>) =>
      parseSettingValue('delivery.qr_template', { ...TEMPLATE, ...patch }).ok;
    expect(bad({ size: QR_TEMPLATE_REGION_MIN - 1 })).toBe(false);
    expect(bad({ size: QR_TEMPLATE_REGION_MIN })).toBe(true);
    expect(bad({ size: 400.5 })).toBe(false);
    expect(bad({ x: -1 })).toBe(false);
    expect(bad({ x: QR_BACKGROUND_MAX_SIDE + 1 })).toBe(false);
    // Width and height are one number: the region is a square, so the code cannot be stretched.
    expect(bad({ width: 400 })).toBe(false);
  });

  /*
   * FIX-06 (2026-10-09): the white margin is the operator's choice from 0 to 16 whole
   * modules. 0 is a real value — no margin at all — not "unset"; the default a NEW template
   * starts from stays 4, the ISO/IEC 18004 minimum, and nothing stored changes.
   */
  it('accepts a quiet zone of 0..16 whole modules and refuses -1, 17 and 1.5', () => {
    expect(QR_TEMPLATE_QUIET_ZONE_MIN).toBe(0);
    expect(QR_TEMPLATE_QUIET_ZONE_MAX).toBe(16);
    expect(QR_TEMPLATE_QUIET_ZONE_DEFAULT).toBe(4);
    const accepts = (quietZoneModules: unknown) =>
      parseSettingValue('delivery.qr_template', { ...TEMPLATE, quietZoneModules }).ok;
    const previewAccepts = (quietZoneModules: unknown) =>
      deliveryQrPreviewRequestSchema.safeParse({ template: { ...TEMPLATE, quietZoneModules } })
        .success;
    for (const check of [accepts, previewAccepts]) {
      for (const ok of [0, 1, 3, 4, 15, 16]) expect(check(ok), String(ok)).toBe(true);
      for (const no of [-1, 17, 1.5, 0.5, '0', null, Number.NaN]) {
        expect(check(no), String(no)).toBe(false);
      }
    }
    // A value stored before this change reads back exactly as it was.
    for (const stored of [4, 8, 16]) {
      expect(
        parseSettingValue('delivery.qr_template', { ...TEMPLATE, quietZoneModules: stored }),
      ).toEqual({ ok: true, value: { ...TEMPLATE, quietZoneModules: stored } });
    }
    expect(parseSettingValue('delivery.qr_template', { ...TEMPLATE, quietZoneModules: 0 })).toEqual(
      { ok: true, value: { ...TEMPLATE, quietZoneModules: 0 } },
    );
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
    // With no quiet zone the whole region is the code: 29 modules in 290 px is 10 px each.
    expect(qrModuleScale(290, 29, 0)).toBe(10);
    expect(qrModuleScale(289, 29, 0)).toBe(9);
    expect(qrModuleScale(400, 29, 16)).toBe(6);
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
    expect(at(QR_BACKGROUND_MAX_SIDE + 1, 400)).toEqual({ ok: false, problem: 'DIMENSIONS' });
    expect(at(400, QR_BACKGROUND_MIN_SIDE - 1)).toEqual({ ok: false, problem: 'DIMENSIONS' });
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

describe('the module minimum after Telegram downscales the photo', () => {
  it('measures a module as the customer receives it, not as it was uploaded', () => {
    expect(QR_TELEGRAM_PHOTO_MAX_SIDE).toBe(1280);
    // At or under 1280 px nothing is scaled.
    expect(qrEffectiveModulePx(4, { width: 1280, height: 900 })).toBe(4);
    expect(qrEffectiveModulePx(4, { width: 800, height: 700 })).toBe(4);
    // A 2048 px background is shown at 1280: a 4 px module arrives as 2.5 px.
    expect(qrEffectiveModulePx(4, { width: 2048, height: 1000 })).toBe(2.5);
    expect(qrEffectiveModulePx(4, { width: 1000, height: 2048 })).toBeLessThan(
      QR_TEMPLATE_MODULE_MIN_PX,
    );
    // The longest side decides: 6.4 px × 1280 / 2048 = 4.
    expect(qrEffectiveModulePx(6.4, { width: 2048, height: 2048 })).toBe(4);
  });
});
