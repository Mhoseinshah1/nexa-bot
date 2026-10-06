import {
  QR_TEMPLATE_MODULE_MIN_PX,
  qrModuleScale,
  qrTemplatePlacementProblem,
  type QrTemplate,
  type QrTemplateFallbackReason,
  type TenantContext,
  type TenantMediaMimeType,
  type TenantMediaPurpose,
} from '@nexa/contracts';
import type { TenantMediaContentCheck } from '../../modules/control/media/application/ports.js';
import type {
  DeliveryQrImage,
  DeliveryQrRenderer,
  DeliveryQrSource,
} from '../../modules/commerce/provisioning/application/ports.js';
import { decodePngToRgb, encodeRgbPng, PngDecodeError, type RgbImage } from './png-codec.js';
import { encodeQrPng, qrModules } from './qr-png.js';

/**
 * Phase 2 item 4: the subscription QR on the tenant's own background.
 *
 * ## The composition, and why it cannot distort the code
 *
 * The region `(x, y, size)` is a square of the background. It is painted WHITE in full, and
 * the code is drawn black in its centre at `scale = floor(size / (modules + 2 × quiet))`
 * pixels per module — a whole number, the same in both directions. So:
 *
 * - every module is an exact `scale × scale` block: nothing is resampled or stretched;
 * - the white around the code is at least `quiet` modules on every side (the remainder of
 *   the floor only adds to it), so the background never touches a finder pattern;
 * - the code is black on white whatever the background is, so the background's colours
 *   cannot lower the contrast a camera needs.
 *
 * Below `QR_TEMPLATE_MODULE_MIN_PX` the template is NOT used: a long link in a small region
 * gets the plain QR instead of an unreadable decorated one.
 *
 * ## The fallback is the plain QR, never a failure
 *
 * The template is decoration. A background that no longer decodes, a region a replaced
 * background no longer contains, an unreadable setting — each sends the plain QR exactly as
 * before the feature existed and is REPORTED through `onFallback`, never thrown: a delivery
 * must not fail because a picture behind the code did. What IS thrown is what the plain
 * encoder throws, a link that cannot be encoded at all, exactly as before.
 */

/** A composed image larger than this is not sent; Telegram's photo upload limit is 10 MB. */
export const QR_COMPOSITE_MAX_BYTES = 5 * 1024 * 1024;

export type QrComposition =
  | { readonly ok: true; readonly png: Uint8Array; readonly scale: number }
  | { readonly ok: false; readonly reason: QrTemplateFallbackReason; readonly scale: number };

/**
 * The code of `text` drawn on `background` as `template` says. Pure and deterministic.
 * Throws only what `qrModules` throws for text that cannot be encoded.
 */
export function composeQrOnBackground(
  text: string,
  background: RgbImage,
  template: QrTemplate,
): QrComposition {
  const modules = qrModules(text);
  const count = modules.length;
  const scale = qrModuleScale(template.size, count, template.quietZoneModules);
  if (qrTemplatePlacementProblem(template, background) !== null) {
    return { ok: false, reason: 'OUTSIDE_BACKGROUND', scale };
  }
  if (scale < QR_TEMPLATE_MODULE_MIN_PX) return { ok: false, reason: 'MODULE_TOO_SMALL', scale };

  const { width, height } = background;
  const rgb = Buffer.from(background.rgb);
  const stride = width * 3;
  // The whole region white: the quiet zone, and the remainder of the floor.
  for (let y = template.y; y < template.y + template.size; y += 1) {
    rgb.fill(0xff, y * stride + template.x * 3, y * stride + (template.x + template.size) * 3);
  }
  const side = count * scale;
  const left = template.x + Math.floor((template.size - side) / 2);
  const top = template.y + Math.floor((template.size - side) / 2);
  for (let row = 0; row < count; row += 1) {
    const cells = modules[row] as boolean[];
    for (let col = 0; col < count; col += 1) {
      if (cells[col] !== true) continue;
      const x0 = left + col * scale;
      for (let dy = 0; dy < scale; dy += 1) {
        const at = (top + row * scale + dy) * stride + x0 * 3;
        rgb.fill(0x00, at, at + scale * 3);
      }
    }
  }
  const png = encodeRgbPng({ width, height, rgb });
  if (png.byteLength > QR_COMPOSITE_MAX_BYTES) {
    return { ok: false, reason: 'OUTPUT_TOO_LARGE', scale };
  }
  return { ok: true, png, scale };
}

/** What the renderer reads of a tenant's configuration. Both are tenant-scoped reads. */
export interface QrTemplateSources {
  /** `delivery.qr_template`; null is no template. */
  template(scope: TenantContext): Promise<QrTemplate | null>;
  /** The `QR_BACKGROUND` slot's bytes; null when it is empty. */
  background(scope: TenantContext): Promise<{ readonly bytes: Uint8Array } | null>;
}

/** A rendered QR and, for the preview, how it was decided. */
export interface QrRenderOutcome {
  readonly bytes: Uint8Array;
  readonly templated: boolean;
  readonly fallback: QrTemplateFallbackReason | null;
  /** Pixels per module in `bytes`. */
  readonly scale: number;
  readonly width: number;
  readonly height: number;
}

const PLAIN_SCALE = 8;
const PLAIN_MARGIN = 4;

function plain(
  text: string,
  moduleCount: number,
  fallback: QrTemplateFallbackReason | null,
): QrRenderOutcome {
  const side = (moduleCount + 2 * PLAIN_MARGIN) * PLAIN_SCALE;
  return {
    bytes: encodeQrPng(text),
    templated: false,
    fallback,
    scale: PLAIN_SCALE,
    width: side,
    height: side,
  };
}

/**
 * The `DeliveryQrRenderer` port: the plain QR, or the QR on the tenant's background.
 *
 * With no sources (or no template, or no background) the bytes are EXACTLY `encodeQrPng`'s —
 * the image every tenant received before this feature, byte for byte.
 */
export class PngDeliveryQrRenderer implements DeliveryQrRenderer {
  constructor(
    private readonly sources: QrTemplateSources | null = null,
    /** Told every time a configured template was not used. For a log line; never throws. */
    private readonly onFallback: (
      scope: TenantContext,
      reason: QrTemplateFallbackReason,
      error?: unknown,
    ) => void = () => undefined,
  ) {}

  async render(scope: TenantContext, source: DeliveryQrSource): Promise<DeliveryQrImage> {
    if (source.kind === 'PROVIDER_IMAGE') {
      /*
       * Item 6's seam, not implemented by this release: a QR the PROVIDER produced is
       * delivered byte for byte — never decoded, never re-encoded, never drawn on the
       * template — because a provider may put more in its code than the visible link.
       */
      return { bytes: source.bytes, origin: 'PROVIDER_ORIGINATED', templated: false };
    }
    const outcome = await this.renderText(scope, source.text);
    return { bytes: outcome.bytes, origin: 'NEXA_GENERATED', templated: outcome.templated };
  }

  /**
   * `text` as the tenant's configuration draws it; `draft` (for the Web Admin's preview)
   * replaces the stored template, `undefined` reads it.
   */
  async renderText(
    scope: TenantContext,
    text: string,
    draft?: QrTemplate | null,
  ): Promise<QrRenderOutcome> {
    // Refuses text that cannot be encoded, exactly as the plain encoder always has.
    const count = qrModules(text).length;
    if (this.sources === null) return plain(text, count, 'NO_TEMPLATE');
    let template: QrTemplate | null;
    let background: { readonly bytes: Uint8Array } | null;
    try {
      template = draft === undefined ? await this.sources.template(scope) : draft;
      if (template === null) return plain(text, count, 'NO_TEMPLATE');
      background = await this.sources.background(scope);
    } catch (error) {
      this.onFallback(scope, 'BACKGROUND_UNREADABLE', error);
      return plain(text, count, 'BACKGROUND_UNREADABLE');
    }
    if (background === null) {
      this.onFallback(scope, 'NO_BACKGROUND');
      return plain(text, count, 'NO_BACKGROUND');
    }
    let image: RgbImage;
    try {
      image = decodePngToRgb(background.bytes);
    } catch (error) {
      this.onFallback(
        scope,
        'BACKGROUND_UNREADABLE',
        error instanceof PngDecodeError ? error : undefined,
      );
      return plain(text, count, 'BACKGROUND_UNREADABLE');
    }
    const composed = composeQrOnBackground(text, image, template);
    if (!composed.ok) {
      this.onFallback(scope, composed.reason);
      return plain(text, count, composed.reason);
    }
    return {
      bytes: composed.png,
      templated: true,
      fallback: null,
      scale: composed.scale,
      width: image.width,
      height: image.height,
    };
  }
}

/**
 * The QR background's content rule for `TenantMediaService` (Phase 2 item 4): the file must
 * DECODE — within the dimension and decompression bounds — before it is stored, so a
 * background that could never be drawn on is refused at upload with the reason, rather than
 * found at the first delivery. Every other slot is accepted as the shared checks left it.
 */
export class QrBackgroundContentCheck implements TenantMediaContentCheck {
  refusal(
    purpose: TenantMediaPurpose,
    _mimeType: TenantMediaMimeType,
    bytes: Uint8Array,
  ): { readonly reason: string; readonly message: string } | null {
    if (purpose !== 'QR_BACKGROUND') return null;
    try {
      decodePngToRgb(bytes);
      return null;
    } catch (error) {
      if (error instanceof PngDecodeError) {
        return { reason: error.problem, message: error.message };
      }
      return { reason: 'CORRUPT', message: 'The PNG could not be decoded.' };
    }
  }
}
