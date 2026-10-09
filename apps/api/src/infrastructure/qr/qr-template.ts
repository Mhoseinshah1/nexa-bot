import { createHash } from 'node:crypto';
import {
  QR_BACKGROUND_MAX_SIDE,
  QR_TEMPLATE_MODULE_MIN_PX,
  QR_TEMPLATE_PREVIEW_TEXT,
  qrEffectiveModulePx,
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
import { encodeQrModulesPng, qrModules } from './qr-png.js';

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
 * - with a quiet zone of 0 (FIX-06) there is NO white around the code: only the code's own
 *   `count × scale` square is painted white under its dark modules, and the remainder of the
 *   floor is left as background. A region of exactly `count × scale` px is then the code edge
 *   to edge. The operator chose that, knowing a scanner may find it less reliably;
 * - the code is black on white whatever the background is, so the background's colours
 *   cannot lower the contrast a camera needs.
 *
 * Below `QR_TEMPLATE_MODULE_MIN_PX` — measured after Telegram downscales the photo to 1280 px
 * (`qrEffectiveModulePx`) — the template is NOT used: a long link in a small region gets the
 * plain QR instead of an unreadable decorated one.
 *
 * ## The fallback is the plain QR, never a failure
 *
 * The template is decoration. A background that no longer decodes, a region a replaced
 * background no longer contains, an unreadable setting — each sends the plain QR exactly as
 * before the feature existed and is REPORTED through `onFallback`, never thrown: a delivery
 * must not fail because a picture behind the code did. What IS thrown is what the plain
 * encoder throws, a link that cannot be encoded at all, exactly as before.
 */

/**
 * A composed image larger than this is not sent, and a template that would produce one for a
 * typical link is refused at save (`probeQrTemplate`).
 *
 * Far below Telegram's 10 MB photo limit on purpose: the upload has to finish inside the
 * customer send timeout (`NOTIFICATION_SEND_TIMEOUT_MS`, 10 s by default), and a send that
 * times out is an UNKNOWN outcome that the delivery card never retries. 1.5 MiB leaves that
 * upload room on a slow uplink; a photo-like 1280 px background composes well under it, and
 * a high-entropy 2048 px one (review of PR #218 measured 12.4 MB) is refused.
 */
export const QR_COMPOSITE_MAX_BYTES = 1.5 * 1024 * 1024;

export type QrComposition =
  | { readonly ok: true; readonly png: Uint8Array; readonly scale: number }
  | { readonly ok: false; readonly reason: QrTemplateFallbackReason; readonly scale: number };

type Modules = readonly (readonly boolean[])[];

/**
 * The code of `text` drawn on `background` as `template` says. Pure and deterministic.
 * Throws only what `qrModules` throws for text that cannot be encoded.
 */
export function composeQrOnBackground(
  text: string,
  background: RgbImage,
  template: QrTemplate,
): QrComposition {
  return composeModules(qrModules(text), background, template);
}

function composeModules(
  modules: Modules,
  background: RgbImage,
  template: QrTemplate,
): QrComposition {
  const count = modules.length;
  const scale = qrModuleScale(template.size, count, template.quietZoneModules);
  if (qrTemplatePlacementProblem(template, background) !== null) {
    return { ok: false, reason: 'OUTSIDE_BACKGROUND', scale };
  }
  // Measured as the customer receives it: Telegram downscales a photo over 1280 px.
  if (qrEffectiveModulePx(scale, background) < QR_TEMPLATE_MODULE_MIN_PX) {
    return { ok: false, reason: 'MODULE_TOO_SMALL', scale };
  }

  const { width, height } = background;
  const rgb = Buffer.from(background.rgb);
  const stride = width * 3;
  const side = count * scale;
  const left = template.x + Math.floor((template.size - side) / 2);
  const top = template.y + Math.floor((template.size - side) / 2);
  /*
   * The white: with a quiet zone, the whole region — the quiet zone, and the remainder of the
   * floor (exactly what every template drew before FIX-06, byte for byte). With none, the
   * code's own square only, so 0 really draws no white border. Compared with `> 0`, never by
   * truthiness, and the quiet zone is never defaulted here: 0 is a value.
   */
  const white =
    template.quietZoneModules > 0
      ? { x: template.x, y: template.y, side: template.size }
      : { x: left, y: top, side };
  for (let y = white.y; y < white.y + white.side; y += 1) {
    rgb.fill(0xff, y * stride + white.x * 3, y * stride + (white.x + white.side) * 3);
  }
  for (let row = 0; row < count; row += 1) {
    const cells = modules[row] as readonly boolean[];
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

/**
 * Whether `template` on the background `bytes` would be used for a link of typical length
 * (`QR_TEMPLATE_PREVIEW_TEXT`), or why not. The save guard's question: an operator learns at
 * save that a region is too small or a composite too large, not from a log line later.
 */
export function probeQrTemplate(
  template: QrTemplate,
  bytes: Uint8Array,
): QrTemplateFallbackReason | null {
  let image: RgbImage;
  try {
    image = decodePngToRgb(bytes);
  } catch {
    return 'BACKGROUND_UNREADABLE';
  }
  const composed = composeModules(qrModules(QR_TEMPLATE_PREVIEW_TEXT), image, template);
  return composed.ok ? null : composed.reason;
}

/** What the renderer reads of a tenant's configuration. All are tenant-scoped reads. */
export interface QrTemplateSources {
  /** `delivery.qr_template`; null is no template. */
  template(scope: TenantContext): Promise<QrTemplate | null>;
  /** The `QR_BACKGROUND` slot's SHA-256, read without its bytes; null when it is empty. */
  backgroundDigest(scope: TenantContext): Promise<string | null>;
  /** The `QR_BACKGROUND` slot's bytes; null when it is empty. Read only on a cache miss. */
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
  /** The stored background's dimensions, when it was read and decodes; else null. */
  readonly background: { readonly width: number; readonly height: number } | null;
}

/**
 * The plain QR (no template, or a template that could not be used): `encodeQrModulesPng`'s
 * defaults, which no setting changes. FIX-06 widened the TEMPLATE's quiet zone to 0..16; the
 * plain QR every tenant has always received keeps the standard's 4.
 */
const PLAIN_SCALE = 8;
const PLAIN_MARGIN = 4;

function plain(
  modules: Modules,
  fallback: QrTemplateFallbackReason | null,
  background: QrRenderOutcome['background'] = null,
): QrRenderOutcome {
  const side = (modules.length + 2 * PLAIN_MARGIN) * PLAIN_SCALE;
  return {
    bytes: encodeQrModulesPng(modules, { scale: PLAIN_SCALE, margin: PLAIN_MARGIN }),
    templated: false,
    fallback,
    scale: PLAIN_SCALE,
    width: side,
    height: side,
    background,
  };
}

/** A map that forgets its least recently used entries past a count and a byte budget. */
class Lru<V> {
  private readonly entries = new Map<string, V>();
  private bytes = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number,
    private readonly sizeOf: (value: V) => number,
  ) {}

  get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    const before = this.entries.get(key);
    if (before !== undefined) {
      this.bytes -= this.sizeOf(before);
      this.entries.delete(key);
    }
    this.entries.set(key, value);
    this.bytes += this.sizeOf(value);
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      const gone = this.entries.get(oldest.value) as V;
      this.entries.delete(oldest.value);
      this.bytes -= this.sizeOf(gone);
    }
  }
}

type DecodedBackground = { readonly image: RgbImage } | { readonly unreadable: unknown };

/** Decoded backgrounds kept: each is up to 2048 × 2048 × 3 bytes (12 MiB). */
const DECODED_MAX_ENTRIES = 2;
const DECODED_MAX_BYTES = 2 * QR_BACKGROUND_MAX_SIDE * QR_BACKGROUND_MAX_SIDE * 3;
/** Composed images kept: a link view tapped twice, a sweep's batch for one tenant. */
const COMPOSED_MAX_ENTRIES = 32;
const COMPOSED_MAX_BYTES = 24 * 1024 * 1024;

export interface PngDeliveryQrRendererOptions {
  /** The decoder; replaced in a test that counts decodes. */
  readonly decode?: (bytes: Uint8Array) => RgbImage;
}

/**
 * The `DeliveryQrRenderer` port: the plain QR, or the QR on the tenant's background.
 *
 * With no sources (or no template, or no background) the bytes are EXACTLY `encodeQrPng`'s —
 * the image every tenant received before this feature, byte for byte.
 *
 * ## Caches (review of PR #218)
 *
 * Composing runs on the thread that answers Telegram updates (the link view's QR) and the
 * Web Admin's preview, and costs up to a second at 2048 px. So the decoded background is
 * kept per (tenant, background SHA-256) and the composed image per (tenant, background
 * SHA-256, template, text), both bounded LRUs in this process. A render on a warm cache reads
 * the template and the background's digest — never its bytes — and decodes nothing. A
 * replaced background has a new digest, so nothing stale is ever served; a changed template
 * is a new key. The keys hold a subscription link, which never leaves the process.
 */
export class PngDeliveryQrRenderer implements DeliveryQrRenderer {
  private readonly decoded = new Lru<DecodedBackground>(
    DECODED_MAX_ENTRIES,
    DECODED_MAX_BYTES,
    (value) => ('image' in value ? value.image.rgb.length : 0),
  );
  private readonly composed = new Lru<QrRenderOutcome>(
    COMPOSED_MAX_ENTRIES,
    COMPOSED_MAX_BYTES,
    (value) => value.bytes.byteLength,
  );
  private readonly decode: (bytes: Uint8Array) => RgbImage;

  constructor(
    private readonly sources: QrTemplateSources | null = null,
    /** Told every time a configured template was not used. For a log line; never throws. */
    private readonly onFallback: (
      scope: TenantContext,
      reason: QrTemplateFallbackReason,
      error?: unknown,
    ) => void = () => undefined,
    options: PngDeliveryQrRendererOptions = {},
  ) {
    this.decode = options.decode ?? decodePngToRgb;
  }

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
   * replaces the stored template, `undefined` reads it. `describeBackground` reads the
   * background even when there is no template, so the preview can state its dimensions.
   */
  async renderText(
    scope: TenantContext,
    text: string,
    draft?: QrTemplate | null,
    options: { readonly describeBackground?: boolean } = {},
  ): Promise<QrRenderOutcome> {
    // Refuses text that cannot be encoded, exactly as the plain encoder always has. Built
    // once: the plain path and the composition both draw this matrix.
    const modules = qrModules(text);
    const sources = this.sources;
    if (sources === null) return plain(modules, 'NO_TEMPLATE');
    let template: QrTemplate | null;
    try {
      template = draft === undefined ? await sources.template(scope) : draft;
    } catch (error) {
      this.onFallback(scope, 'CONFIG_UNREADABLE', error);
      return plain(modules, 'CONFIG_UNREADABLE');
    }
    if (template === null && options.describeBackground !== true) {
      return plain(modules, 'NO_TEMPLATE');
    }
    let loaded: { readonly digest: string; readonly decoded: DecodedBackground } | null;
    try {
      loaded = await this.loadBackground(scope, sources);
    } catch (error) {
      this.onFallback(scope, 'BACKGROUND_UNREADABLE', error);
      return plain(modules, 'BACKGROUND_UNREADABLE');
    }
    const dimensions =
      loaded !== null && 'image' in loaded.decoded
        ? { width: loaded.decoded.image.width, height: loaded.decoded.image.height }
        : null;
    if (template === null) return plain(modules, 'NO_TEMPLATE', dimensions);
    if (loaded === null) {
      this.onFallback(scope, 'NO_BACKGROUND');
      return plain(modules, 'NO_BACKGROUND');
    }
    if (!('image' in loaded.decoded)) {
      this.onFallback(scope, 'BACKGROUND_UNREADABLE', loaded.decoded.unreadable);
      return plain(modules, 'BACKGROUND_UNREADABLE');
    }
    const key = [
      scope.tenantId,
      loaded.digest,
      template.x,
      template.y,
      template.size,
      template.quietZoneModules,
      text,
    ].join('\u0000');
    const cached = this.composed.get(key);
    if (cached !== undefined) return cached;

    const image = loaded.decoded.image;
    const composed = composeModules(modules, image, template);
    let outcome: QrRenderOutcome;
    if (composed.ok) {
      outcome = {
        bytes: composed.png,
        templated: true,
        fallback: null,
        scale: composed.scale,
        width: image.width,
        height: image.height,
        background: dimensions,
      };
    } else {
      this.onFallback(scope, composed.reason);
      outcome = plain(modules, composed.reason, dimensions);
    }
    this.composed.set(key, outcome);
    return outcome;
  }

  /**
   * The tenant's background, decoded, by its digest: the bytes are read and decoded only when
   * this digest is not cached. A background that does not decode is cached as such, so a
   * damaged file is not decoded again on every delivery.
   */
  private async loadBackground(
    scope: TenantContext,
    sources: QrTemplateSources,
  ): Promise<{ readonly digest: string; readonly decoded: DecodedBackground } | null> {
    const digest = await sources.backgroundDigest(scope);
    if (digest === null) return null;
    const hit = this.decoded.get(`${scope.tenantId}:${digest}`);
    if (hit !== undefined) return { digest, decoded: hit };
    const stored = await sources.background(scope);
    if (stored === null) return null;
    // Keyed by the digest of the bytes actually read: a replacement landing between the two
    // reads is cached under its own digest, never under the one it replaced.
    const actual = createHash('sha256').update(stored.bytes).digest('hex');
    let decoded: DecodedBackground;
    try {
      decoded = { image: this.decode(stored.bytes) };
    } catch (error) {
      decoded = { unreadable: error instanceof PngDecodeError ? error : undefined };
    }
    this.decoded.set(`${scope.tenantId}:${actual}`, decoded);
    return { digest: actual, decoded };
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
