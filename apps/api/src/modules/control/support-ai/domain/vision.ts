import {
  SUPPORT_AI_VISION_MAX_IMAGES,
  type BusinessMessageOrigin,
  type SupportAiImageSkipReason,
} from '@nexa/contracts';
import { promptWindow } from './prompt.js';

/**
 * TB6 — the pure half of vision (program §28, §36): which bytes are an image, and which of a
 * conversation's images a request may carry.
 */

/** The three types a support image may be. Never a document, never an SVG. */
export type SupportImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp';

/**
 * The type the MAGIC BYTES say an image is, or null. Never Telegram's declared type and never
 * a file name — both are claims from the other side of the network.
 *
 * - JPEG: `FF D8 FF`.
 * - PNG: the eight-byte signature `89 50 4E 47 0D 0A 1A 0A`.
 * - WEBP: a RIFF container (`RIFF` at 0) whose form type is `WEBP` (at 8).
 */
export function sniffSupportImage(bytes: Uint8Array): SupportImageMediaType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= png.length && png.every((byte, index) => bytes[index] === byte)) {
    return 'image/png';
  }
  const riff = [0x52, 0x49, 0x46, 0x46];
  const webp = [0x57, 0x45, 0x42, 0x50];
  if (
    bytes.length >= 12 &&
    riff.every((byte, index) => bytes[index] === byte) &&
    webp.every((byte, index) => bytes[8 + index] === byte)
  ) {
    return 'image/webp';
  }
  return null;
}

/** The decoded size of a base64 string, without decoding it. */
export function base64ByteLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

export interface VisionLine {
  readonly id: string;
  /** The line's text, which the prompt window's character ceiling counts. */
  readonly text?: string | null;
  readonly origin: BusinessMessageOrigin;
  readonly kind: 'TEXT' | 'PHOTO' | 'OTHER';
}

export interface VisionPlan {
  /** The customer images to fetch, most recent first — at most `SUPPORT_AI_VISION_MAX_IMAGES`. */
  readonly fetch: readonly string[];
  /** Customer images that will NOT be fetched, and why. */
  readonly skipped: ReadonlyMap<string, SupportAiImageSkipReason>;
  /** The customer's latest message, when it is an image; null otherwise. */
  readonly latestInboundImageId: string | null;
}

/**
 * Which of the transcript's customer images a request may carry.
 *
 * Only the window the prompt shows is considered (`promptWindow`), and only
 * the CUSTOMER's images: an image the business sent is not what the customer is asking about.
 * The `SUPPORT_AI_VISION_MAX_IMAGES` most recent are candidates; every older one is
 * `OVER_LIMIT`. Nothing is fetched when vision is off for the tenant, or when no configured
 * step could see an image at all — a download nobody can look at is a download of a
 * customer's photo for nothing.
 */
export function planVision(
  lines: readonly VisionLine[],
  options: { readonly visionEnabled: boolean; readonly visionStepConfigured: boolean },
): VisionPlan {
  const window = promptWindow(lines);
  const images = window.filter((line) => line.origin === 'INBOUND' && line.kind === 'PHOTO');
  const latestInbound = [...window].reverse().find((line) => line.origin === 'INBOUND');
  const latestInboundImageId =
    latestInbound !== undefined && latestInbound.kind === 'PHOTO' ? latestInbound.id : null;
  const recentFirst = [...images].reverse();
  const skipped = new Map<string, SupportAiImageSkipReason>();
  const fetch: string[] = [];
  for (const [index, image] of recentFirst.entries()) {
    if (index >= SUPPORT_AI_VISION_MAX_IMAGES) skipped.set(image.id, 'OVER_LIMIT');
    else if (!options.visionEnabled) skipped.set(image.id, 'VISION_DISABLED');
    else if (!options.visionStepConfigured) skipped.set(image.id, 'NO_VISION_CAPABILITY');
    else fetch.push(image.id);
  }
  return { fetch, skipped, latestInboundImageId };
}
