import { z } from 'zod';
import { TENANT_MEDIA_MAX_BYTES } from './customer-ux.js';

/**
 * Phase 2 item 4: the subscription QR drawn on a tenant's own background.
 *
 * The QR NEXA generates for a delivered link (the delivery card, a changed link, the QR under
 * the link view) is by default the plain black-on-white image `encodeQrPng` writes. A tenant
 * may instead upload a background (the `QR_BACKGROUND` media slot, PNG only) and say WHERE on
 * it the code goes (`delivery.qr_template`): a square region in background pixels and the
 * white quiet zone around the code. The code's CONTENT never changes — it is always the exact
 * link — only its presentation.
 *
 * Every rule here is shared by the server and the Web Admin, so the form refuses exactly what
 * the service would:
 *
 * - the background is a PNG within `QR_BACKGROUND_MIN_SIDE`..`QR_BACKGROUND_MAX_SIDE` pixels a
 *   side, 8 bits per channel, non-interlaced, greyscale / RGB / palette / grey+alpha / RGBA;
 * - the region is a square of `QR_TEMPLATE_REGION_MIN`.. px, wholly inside the background;
 * - the quiet zone is at least `QR_TEMPLATE_QUIET_ZONE_MIN` modules (the standard's minimum);
 * - the code is drawn at a WHOLE number of pixels per module — never stretched, never
 *   resampled — and refused below `QR_TEMPLATE_MODULE_MIN_PX`, in which case the plain QR is
 *   sent instead.
 *
 * A provider-originated QR (item 6) is NOT drawn on this template by this release: it is
 * delivered byte for byte as the provider produced it, and never re-encoded.
 */

/** The smallest background side, in pixels: below it no region fits a scannable code. */
export const QR_BACKGROUND_MIN_SIDE = 128;
/**
 * The largest background side, in pixels. Bounds the decoded image (2048 × 2048 × 4 bytes,
 * 16 MiB) BEFORE anything is inflated, which is the decompression-bomb bound.
 */
export const QR_BACKGROUND_MAX_SIDE = 2048;
/** The smallest QR region side, in pixels. */
export const QR_TEMPLATE_REGION_MIN = 128;
/** The quiet zone, in modules: 4 is ISO/IEC 18004's minimum. */
export const QR_TEMPLATE_QUIET_ZONE_MIN = 4;
export const QR_TEMPLATE_QUIET_ZONE_MAX = 16;
/**
 * The smallest module, in pixels, a templated code is drawn at. Telegram recompresses a
 * photo; under 4 px a module's edges blur into its neighbours and the decode rate drops.
 * A link that would need smaller modules in the configured region gets the plain QR.
 */
export const QR_TEMPLATE_MODULE_MIN_PX = 4;

/**
 * A text of the length a real subscription link has, for the Web Admin's preview. Never a
 * customer's link: the preview shows how a link of this length fits, and reports its module
 * size. A real link's length decides its own module count.
 */
export const QR_TEMPLATE_PREVIEW_TEXT =
  'https://sub.example.com:2096/sub/bnhxMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAw';

const pixel = z.number().int().min(0).max(QR_BACKGROUND_MAX_SIDE);

/** Where the code goes on the background: a square region, in background pixels. */
export const qrTemplateSchema = z
  .object({
    /** The region's left edge. */
    x: pixel,
    /** The region's top edge. */
    y: pixel,
    /** The region's side. The code is centred in it. */
    size: z.number().int().min(QR_TEMPLATE_REGION_MIN).max(QR_BACKGROUND_MAX_SIDE),
    /** The white margin around the code, in modules. */
    quietZoneModules: z
      .number()
      .int()
      .min(QR_TEMPLATE_QUIET_ZONE_MIN)
      .max(QR_TEMPLATE_QUIET_ZONE_MAX),
  })
  .strict();
export type QrTemplate = z.infer<typeof qrTemplateSchema>;

/** The setting's value: `null` is no template, and the plain QR. */
export const qrTemplateSettingSchema = qrTemplateSchema.nullable();
export type QrTemplateSetting = z.infer<typeof qrTemplateSettingSchema>;

/** Whether the region lies wholly inside a background of these dimensions. */
export function qrTemplatePlacementProblem(
  template: QrTemplate,
  background: { readonly width: number; readonly height: number },
): 'OUTSIDE_BACKGROUND' | null {
  return template.x + template.size <= background.width &&
    template.y + template.size <= background.height
    ? null
    : 'OUTSIDE_BACKGROUND';
}

/**
 * Pixels per module for a code of `moduleCount` modules in a region of `regionSize` px with
 * `quietZoneModules` of white on every side: the WHOLE number that fits, never a fraction —
 * a fractional scale is a resampled, distorted code.
 */
export function qrModuleScale(
  regionSize: number,
  moduleCount: number,
  quietZoneModules: number,
): number {
  return Math.floor(regionSize / (moduleCount + 2 * quietZoneModules));
}

/** Why a configured template was not used and the plain QR was sent instead. */
export const QR_TEMPLATE_FALLBACK_REASONS = [
  /** `delivery.qr_template` is null. */
  'NO_TEMPLATE',
  /** The `QR_BACKGROUND` slot is empty. */
  'NO_BACKGROUND',
  /** The background stored is not one this decoder reads (it was replaced, or corrupted). */
  'BACKGROUND_UNREADABLE',
  /** The region does not lie inside the background (it was replaced with a smaller one). */
  'OUTSIDE_BACKGROUND',
  /** This link needs more modules than the region holds at `QR_TEMPLATE_MODULE_MIN_PX`. */
  'MODULE_TOO_SMALL',
  /** The composed image is larger than a photo upload should be. */
  'OUTPUT_TOO_LARGE',
] as const;
export type QrTemplateFallbackReason = (typeof QR_TEMPLATE_FALLBACK_REASONS)[number];

/** Why a file is refused as a QR background. */
export const QR_BACKGROUND_PROBLEMS = [
  'EMPTY',
  'TOO_LARGE',
  /** Not a PNG: JPEG and every other type are refused for this slot. */
  'NOT_PNG',
  /** The header could not be read. */
  'UNREADABLE',
  /** A side under `QR_BACKGROUND_MIN_SIDE` or over `QR_BACKGROUND_MAX_SIDE`. */
  'DIMENSIONS',
  /** 16-bit, sub-byte, interlaced, or a colour type this decoder does not read. */
  'UNSUPPORTED_FORMAT',
  /** The image data inflates to more than its header declares. */
  'DECOMPRESSION_BOUND',
  /** The image data is damaged: a bad checksum, a truncated stream, a bad filter. */
  'CORRUPT',
] as const;
export type QrBackgroundProblem = (typeof QR_BACKGROUND_PROBLEMS)[number];

export type QrBackgroundInspection =
  | { readonly ok: true; readonly width: number; readonly height: number }
  | { readonly ok: false; readonly problem: QrBackgroundProblem };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** Colour types read at bit depth 8: greyscale, RGB, palette, grey+alpha, RGBA. */
export const QR_BACKGROUND_COLOUR_TYPES = [0, 2, 3, 4, 6] as const;

function u32(bytes: Uint8Array, at: number): number | null {
  if (at < 0 || at + 4 > bytes.byteLength) return null;
  return (
    (bytes[at] as number) * 0x1000000 +
    (((bytes[at + 1] as number) << 16) |
      ((bytes[at + 2] as number) << 8) |
      (bytes[at + 3] as number))
  );
}

/**
 * Whether `bytes` are a PNG this product accepts as a QR background, from the HEADER alone:
 * the signature, then the first chunk, which must be `IHDR`. Total and pure; every read is
 * bounds-checked. The server then DECODES the whole image before storing it, which is what
 * catches damaged image data; this is the half the browser can run before the upload.
 */
export function inspectQrBackgroundPng(bytes: Uint8Array): QrBackgroundInspection {
  if (bytes.byteLength === 0) return { ok: false, problem: 'EMPTY' };
  if (bytes.byteLength > TENANT_MEDIA_MAX_BYTES) return { ok: false, problem: 'TOO_LARGE' };
  if (
    bytes.byteLength < PNG_SIGNATURE.length ||
    !PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
  ) {
    return { ok: false, problem: 'NOT_PNG' };
  }
  const IHDR = [0x49, 0x48, 0x44, 0x52];
  if (
    bytes.byteLength < 33 ||
    u32(bytes, 8) !== 13 ||
    !IHDR.every((byte, index) => bytes[12 + index] === byte)
  ) {
    return { ok: false, problem: 'UNREADABLE' };
  }
  const width = u32(bytes, 16) as number;
  const height = u32(bytes, 20) as number;
  const bitDepth = bytes[24] as number;
  const colourType = bytes[25] as number;
  const compression = bytes[26] as number;
  const filter = bytes[27] as number;
  const interlace = bytes[28] as number;
  if (
    width < QR_BACKGROUND_MIN_SIDE ||
    height < QR_BACKGROUND_MIN_SIDE ||
    width > QR_BACKGROUND_MAX_SIDE ||
    height > QR_BACKGROUND_MAX_SIDE
  ) {
    return { ok: false, problem: 'DIMENSIONS' };
  }
  if (
    bitDepth !== 8 ||
    !(QR_BACKGROUND_COLOUR_TYPES as readonly number[]).includes(colourType) ||
    compression !== 0 ||
    filter !== 0 ||
    interlace !== 0
  ) {
    return { ok: false, problem: 'UNSUPPORTED_FORMAT' };
  }
  return { ok: true, width, height };
}

// --- HTTP: the Web Admin's preview -------------------------------------------------

/**
 * A preview of the QR as a customer would receive it, for a DRAFT template (or the plain
 * QR for `null`), drawn on the background stored now and encoding `QR_TEMPLATE_PREVIEW_TEXT`.
 * Read-only: nothing is stored. `settings.view`.
 */
export const deliveryQrPreviewRequestSchema = z.object({
  template: qrTemplateSettingSchema,
});
export type DeliveryQrPreviewRequest = z.infer<typeof deliveryQrPreviewRequestSchema>;

export const deliveryQrPreviewSchema = z.object({
  pngBase64: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  /** True when the template was used; false is the plain QR, and `fallback` says why. */
  templated: z.boolean(),
  fallback: z.enum(QR_TEMPLATE_FALLBACK_REASONS).nullable(),
  /** Pixels per module of the sample code, in the image returned. */
  moduleScale: z.number().int(),
});
export type DeliveryQrPreviewResponse = z.infer<typeof deliveryQrPreviewSchema>;

export const DELIVERY_QR_ROUTES = {
  preview: '/delivery-qr/preview',
} as const;
