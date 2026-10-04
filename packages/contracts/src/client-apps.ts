import { z } from 'zod';
import { PROVIDER_TYPES } from './provider.js';

/**
 * WP-A10 — app downloads and connection guides.
 *
 * The client apps a tenant recommends to its customers, per platform, each with its
 * download links and a short connection guide. CONTENT, maintained by an operator in the
 * Web Admin: nothing here names a real app, a store listing or a vendor, and this release
 * seeds none — no link in this repository was ever approved for a customer to follow, and
 * a default download link is a claim about somebody else's binary that nobody here can
 * stand behind. An installation starts with an empty list and the platform guides that
 * `bot.tutorial.<platform>` already carried.
 *
 * The bot entry «📱 دانلود برنامه و آموزش اتصال» is the EXISTING connection guide
 * (`tu:` / `to:<platform>`) grown into this, not a second guide beside it: a button
 * already sitting in a customer's chat opens the new screen, and a platform with no
 * configured app still shows the `bot.tutorial.<platform>` guide it always did.
 */

// --- Vocabularies ------------------------------------------------------------------

/**
 * Where an app runs. The first five are `CONNECTION_GUIDE_PLATFORMS`, in the same order,
 * so a `to:<platform>` button already sitting in a customer's chat keeps naming a
 * platform this list knows. `OTHER` is offered to a customer only when at least one
 * enabled, relevant entry is filed under it — "Other when configured".
 */
export const CLIENT_APP_PLATFORMS = [
  'ANDROID',
  'IOS',
  'WINDOWS',
  'MACOS',
  'LINUX',
  'OTHER',
] as const;
export type ClientAppPlatform = (typeof CLIENT_APP_PLATFORMS)[number];
export const clientAppPlatformSchema = z.enum(CLIENT_APP_PLATFORMS);

export const CLIENT_APP_STATUSES = ['ENABLED', 'DISABLED'] as const;
export type ClientAppStatus = (typeof CLIENT_APP_STATUSES)[number];
export const clientAppStatusSchema = z.enum(CLIENT_APP_STATUSES);

/**
 * How a service reaches the customer's device, as far as THIS installation can tell.
 *
 * Each member is derived from a fact the installation already holds, never typed in:
 *   - `SUBSCRIPTION_LINK` — the service holds a subscription URL (it is deliverable);
 *   - `CONNECTION_FILES` — the service's panel can hand over ready-made connection files,
 *     the `SUBSCRIPTION_FILES` capability, decided by the same `offered` check that draws
 *     «📁 دریافت فایل‌های اتصال».
 *
 * A format a client parses out of a subscription (sing-box JSON, Clash YAML, a base64
 * v2ray list) is NOT here: the panel picks it per client from the request, so nothing
 * this installation stores says which one a service "is", and a member no service could
 * ever carry would be a filter that silently hides an app from everybody.
 */
export const CLIENT_APP_DELIVERY_KINDS = ['SUBSCRIPTION_LINK', 'CONNECTION_FILES'] as const;
export type ClientAppDeliveryKind = (typeof CLIENT_APP_DELIVERY_KINDS)[number];

/**
 * Proxy protocols an app can speak. Known for a service only where its panel's activation
 * names the protocols its accounts are created with; unknown otherwise, and an unknown
 * fact never hides an app.
 */
export const CLIENT_APP_PROTOCOLS = ['vless', 'vmess', 'trojan', 'shadowsocks'] as const;
export type ClientAppProtocol = (typeof CLIENT_APP_PROTOCOLS)[number];

// --- Bounds ---------------------------------------------------------------------------

export const CLIENT_APP_NAME_MAX_LENGTH = 64;
/** An emoji or a short mark drawn before the name. Emoji sequences run to ~11 code units. */
export const CLIENT_APP_ICON_MAX_LENGTH = 16;
export const CLIENT_APP_DESCRIPTION_MAX_LENGTH = 300;
/**
 * Short enough that the detail message — name, description, guide and the template's own
 * words — stays one Telegram message (4,096) with room to spare.
 */
export const CLIENT_APP_GUIDE_MAX_LENGTH = 2500;
export const CLIENT_APP_URL_MAX_LENGTH = 2048;
export const CLIENT_APP_SORT_MIN = 0;
export const CLIENT_APP_SORT_MAX = 100_000;
/**
 * Per tenant, across every platform. Telegram caps an inline keyboard at 100 buttons, and
 * one platform's list is its apps plus two navigation buttons.
 */
export const CLIENT_APP_MAX_ENTRIES = 60;

// --- The image (HF-A10) -------------------------------------------------------------------

/**
 * An entry's optional picture: one raster image per entry, stored with the entry and sent
 * by the bot ahead of the app's screen. The emoji `icon` stays what the list's buttons
 * show — an inline keyboard button carries text and nothing else.
 *
 * The storage rule the referral banner set (`tenant_media_assets`): the BYTES in the
 * database, bounded by a CHECK, never a filesystem path and never a bot-scoped Telegram
 * `file_id` as the source of truth. Bounded in total by `CLIENT_APP_MAX_ENTRIES`, and
 * removed with its entry, so there is nothing to retain or collect.
 *
 * PNG and JPEG only — the two types `sendPhoto` is known to take, and the banner's two.
 * NEVER SVG: it is a document that can carry script, not a picture, and Telegram does not
 * send it as a photo anyway. The declared type must match the file's own magic number.
 */
export const CLIENT_APP_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg'] as const;
export type ClientAppImageMimeType = (typeof CLIENT_APP_IMAGE_MIME_TYPES)[number];
export const clientAppImageMimeTypeSchema = z.enum(CLIENT_APP_IMAGE_MIME_TYPES);

/** 512 KiB. A picture of an app needs far less; sixty of them stay a few tens of MiB. */
export const CLIENT_APP_IMAGE_MAX_BYTES = 512 * 1024;
/** Each side, in pixels. Below the minimum is not a picture; above the maximum is not an icon. */
export const CLIENT_APP_IMAGE_MIN_SIDE = 16;
export const CLIENT_APP_IMAGE_MAX_SIDE = 2048;
/** Telegram refuses a photo whose sides differ by more than a factor of 20. */
export const CLIENT_APP_IMAGE_MAX_ASPECT = 20;

// --- Tutorial video (spec §7) --------------------------------------------------------

/**
 * Spec §7: a client app's tutorial VIDEO is set from Telegram by an administrator
 * («تنظیم ویدیو»), and what is stored is Telegram's own reference to it — `file_id`, which
 * sends it again with no byte downloaded, and `file_unique_id`, stable across bots — never
 * the video's bytes. A `file_id` is valid only for the bot that received it, so a video is
 * stored PER BOT: the bot an administrator sent it to is the bot that can show it.
 *
 * How long the «send the video now» prompt stays open. Longer than an amount capture's five
 * minutes: a video is picked from a phone's gallery and uploaded, which takes a while.
 */
export const CLIENT_APP_VIDEO_CAPTURE_TTL_MS = 15 * 60 * 1000;
/** Bounds on the identifiers Telegram gives; a longer one is not a Telegram identifier. */
export const CLIENT_APP_VIDEO_FILE_ID_MAX_LENGTH = 256;
export const CLIENT_APP_VIDEO_FILE_UNIQUE_ID_MAX_LENGTH = 128;

/** Why a file is refused as an entry's image. */
export type ClientAppImageProblem =
  | 'EMPTY'
  | 'TOO_LARGE'
  /** The bytes do not begin with the declared type's magic number. */
  | 'TYPE_MISMATCH'
  /** The header that states the dimensions is missing or truncated. */
  | 'UNREADABLE'
  /** Outside `CLIENT_APP_IMAGE_MIN_SIDE`..`MAX_SIDE`, or more elongated than `MAX_ASPECT`. */
  | 'DIMENSIONS';

export type ClientAppImageInspection =
  | { readonly ok: true; readonly width: number; readonly height: number }
  | { readonly ok: false; readonly problem: ClientAppImageProblem };

const IMAGE_MAGIC: Readonly<Record<ClientAppImageMimeType, readonly number[]>> = {
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/jpeg': [0xff, 0xd8, 0xff],
};

/**
 * Whether `bytes` are an image this product accepts under the declared type, and its size.
 *
 * Reads HEADERS only and decodes nothing: the magic number, then PNG's `IHDR` or the first
 * JPEG start-of-frame. The server and the Web Admin call this one function, so the form
 * refuses exactly what the service would. Total and pure; every read is bounds-checked, so
 * a truncated or hostile header is `UNREADABLE`, never an exception.
 */
export function inspectClientAppImage(
  mimeType: ClientAppImageMimeType,
  bytes: Uint8Array,
): ClientAppImageInspection {
  if (bytes.byteLength === 0) return { ok: false, problem: 'EMPTY' };
  if (bytes.byteLength > CLIENT_APP_IMAGE_MAX_BYTES) return { ok: false, problem: 'TOO_LARGE' };
  const magic = IMAGE_MAGIC[mimeType];
  if (bytes.byteLength < magic.length || !magic.every((byte, index) => bytes[index] === byte)) {
    return { ok: false, problem: 'TYPE_MISMATCH' };
  }
  const size = mimeType === 'image/png' ? pngSize(bytes) : jpegSize(bytes);
  if (size === null) return { ok: false, problem: 'UNREADABLE' };
  const { width, height } = size;
  const within = (side: number) =>
    side >= CLIENT_APP_IMAGE_MIN_SIDE && side <= CLIENT_APP_IMAGE_MAX_SIDE;
  if (
    !within(width) ||
    !within(height) ||
    Math.max(width, height) > CLIENT_APP_IMAGE_MAX_ASPECT * Math.min(width, height)
  ) {
    return { ok: false, problem: 'DIMENSIONS' };
  }
  return { ok: true, width, height };
}

function uint16(bytes: Uint8Array, at: number): number | null {
  if (at < 0 || at + 2 > bytes.byteLength) return null;
  return ((bytes[at] as number) << 8) | (bytes[at + 1] as number);
}

function uint32(bytes: Uint8Array, at: number): number | null {
  const high = uint16(bytes, at);
  const low = uint16(bytes, at + 2);
  return high === null || low === null ? null : high * 0x10000 + low;
}

/** The signature, then the FIRST chunk, which the PNG specification requires to be `IHDR`. */
function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const IHDR = [0x49, 0x48, 0x44, 0x52];
  if (bytes.byteLength < 24 || !IHDR.every((byte, index) => bytes[12 + index] === byte)) {
    return null;
  }
  const width = uint32(bytes, 16);
  const height = uint32(bytes, 20);
  return width === null || height === null ? null : { width, height };
}

/**
 * The segments after SOI, walked by their lengths to the first start-of-frame. Markers
 * without a length (RST0–7, TEM) are stepped over; reaching start-of-scan, end-of-image or
 * the end of the bytes first is `null`. Every step advances, so the walk ends.
 */
function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  let at = 2;
  while (at < bytes.byteLength) {
    if (bytes[at] !== 0xff) return null;
    // Fill bytes: any number of 0xFF may precede a marker.
    while (at < bytes.byteLength && bytes[at] === 0xff) at += 1;
    if (at >= bytes.byteLength) return null;
    const marker = bytes[at] as number;
    at += 1;
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = uint16(bytes, at);
    if (length === null || length < 2) return null;
    // SOF0–SOF15, less DHT (C4), JPG (C8) and DAC (CC), which share the range.
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      // length(2) precision(1) height(2) width(2)
      if (length < 7) return null;
      const height = uint16(bytes, at + 3);
      const width = uint16(bytes, at + 5);
      return width === null || height === null ? null : { width, height };
    }
    at += length;
  }
  return null;
}

// --- Links ------------------------------------------------------------------------------

/**
 * A download or help link, normalised, or `null` when it is not one this product sends.
 *
 * HTTPS ONLY, and that is the whole scheme policy. Every link here becomes a Telegram URL
 * button, and Telegram opens `http`, `https` and `tg` there and refuses the rest — so a
 * store scheme (`market://`, `itms-apps://`) would be a button Telegram rejects, and both
 * stores publish an `https://` address for every listing anyway. `http` is refused because
 * a download over plaintext can be swapped in transit. `javascript:`, `data:` and every
 * other scheme fail the first check.
 *
 * Deliberately a strict grammar rather than `new URL()`, which repairs what it is given
 * (`https:\\host`, a missing slash, a space) — what is stored must be what was checked.
 * Refused as well:
 *   - userinfo (`https://store.example@evil.example`), the classic way to show one host
 *     and open another;
 *   - an IP literal or a dotless host: a download link on a bare address is not a store;
 *   - anything but printable ASCII — an internationalised host arrives as its punycode,
 *     and a character outside the grammar is refused rather than escaped for the operator.
 *
 * The scheme and host are lowercased; the rest is kept exactly as typed.
 */
export function normalizeClientAppUrl(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0 || value.length > CLIENT_APP_URL_MAX_LENGTH) return null;
  // Printable ASCII only, and none of the characters RFC 3986 never admits unescaped.
  if (!/^[\x21-\x7E]+$/u.test(value) || /[\\<>"'`{}|^]/u.test(value)) return null;
  const match = /^https:\/\/([^/?#]+)([/?#].*)?$/iu.exec(value);
  if (match === null) return null;
  const authority = (match[1] ?? '').toLowerCase();
  const rest = match[2] ?? '';
  if (authority.includes('@')) return null;
  const hostPort = /^([a-z0-9.-]+)(?::([0-9]{1,5}))?$/u.exec(authority);
  if (hostPort === null) return null;
  const host = hostPort[1] ?? '';
  const port = hostPort[2];
  if (port !== undefined) {
    const number = Number(port);
    if (number < 1 || number > 65_535) return null;
  }
  if (host.length > 253) return null;
  const labels = host.split('.');
  if (labels.length < 2) return null;
  for (const label of labels) {
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)) return null;
  }
  const tld = labels[labels.length - 1] ?? '';
  // A top-level label is letters, or an IDN's punycode — never all digits (an IPv4).
  if (!/^([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/u.test(tld)) return null;
  return `https://${authority}${rest}`;
}

const clientAppUrlSchema = z
  .string()
  .max(CLIENT_APP_URL_MAX_LENGTH * 2)
  .transform((value, ctx) => {
    const normalized = normalizeClientAppUrl(value);
    if (normalized === null) {
      ctx.addIssue({ code: 'custom', message: 'must be an https:// link to a named host' });
      return z.NEVER;
    }
    return normalized;
  });

/** An optional link: empty or absent is `null`, anything else must be a valid link. */
const optionalClientAppUrlSchema = z
  .union([z.string(), z.null()])
  .optional()
  .transform((value, ctx) => {
    if (value === undefined || value === null || value.trim() === '') return null;
    const normalized = normalizeClientAppUrl(value);
    if (normalized === null) {
      ctx.addIssue({ code: 'custom', message: 'must be an https:// link to a named host' });
      return z.NEVER;
    }
    return normalized;
  });

// --- Text safety ---------------------------------------------------------------------------

/**
 * C0 controls other than tab, newline and carriage return, and DEL. Never meaningful in
 * operator text. By code unit rather than a regular expression, which lint rightly
 * refuses to hold control characters.
 */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
/** Anything a browser or Telegram's HTML parser would read as the start of a tag. */
const MARKUP = /<\s*\/?\s*[a-z!?]/iu;
/**
 * Schemes that execute or embed rather than link, refused anywhere in the text. `data:`
 * and `file:` only in their URL shapes, so an ordinary sentence ("mobile data: on") is
 * not mistaken for one.
 */
const EXECUTABLE_SCHEME =
  /\b(?:javascript|vbscript)\s*:|\bdata\s*:\s*(?:[a-z-]+\/|[;,])|\bfile\s*:\s*\/\//iu;
/** `[label](target)`, the one inline construct the guide admits. */
const LINK = /\[([^\]\n]{1,200})\]\(([^)\s]{1,2100})\)/gu;
/**
 * A link written BARE in the text: any `scheme://…`, or a `www.` host with no scheme.
 *
 * Telegram auto-links both in a plain-text message — a `www.` host as `http://` — so a
 * bare `http://…` in a guide or a description is a plaintext download link as surely as
 * a `[label](http://…)` is, and only the latter used to be checked (Codex review #1 of
 * PR #95, C5). A bare token is acceptable only as an `https://` link that
 * `normalizeClientAppUrl` accepts; every other scheme, and every scheme-less `www.` host,
 * is refused. A bare domain with neither (`example.com/app.apk`) is not matched: it
 * cannot be told from a file name, and refusing every dotted word would refuse ordinary
 * guide text.
 */
const BARE_URL = /(?:\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.)[^\s<>"'`]*/giu;
/** Sentence punctuation that follows a link in prose and is not part of it. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}\u060C\u061B]+$/u;

/** Whether a bare URL-like token is one this product lets a customer be sent to. */
function isSafeBareUrl(token: string): boolean {
  const core = token.replace(TRAILING_PUNCTUATION, '');
  return /^https:\/\//iu.test(core) && normalizeClientAppUrl(core) !== null;
}

/** Why a piece of operator text is refused, or null when it is acceptable. */
export type ClientAppTextProblem = 'CONTROL' | 'MARKUP' | 'EXECUTABLE_SCHEME' | 'UNSAFE_LINK';

/**
 * The one check every free-text field of an entry passes, name to guide.
 *
 * Refusing rather than stripping, for the rule `normalizeClientAppUrl` states: what is
 * stored is what the operator saw. The guide is rendered as PLAIN TEXT in Telegram and as
 * a text node on the web, so markup could not execute in either — it is refused anyway,
 * because a guide carrying `<b>` is a guide its author expected to render differently
 * from how it will, and that is better said at save time than discovered by a customer.
 */
export function clientAppTextProblem(value: string): ClientAppTextProblem | null {
  if (hasControlCharacter(value)) return 'CONTROL';
  if (MARKUP.test(value)) return 'MARKUP';
  if (EXECUTABLE_SCHEME.test(value)) return 'EXECUTABLE_SCHEME';
  for (const match of value.matchAll(LINK)) {
    if (normalizeClientAppUrl(match[2] ?? '') === null) return 'UNSAFE_LINK';
  }
  // The links' targets were judged above; what remains is text, bare links included.
  const text = value.replace(LINK, (_whole, label: string) => label);
  for (const match of text.matchAll(BARE_URL)) {
    if (!isSafeBareUrl(match[0])) return 'UNSAFE_LINK';
  }
  return null;
}

const PROBLEM_MESSAGES: Readonly<Record<ClientAppTextProblem, string>> = {
  CONTROL: 'must not contain control characters',
  MARKUP: 'must not contain HTML',
  EXECUTABLE_SCHEME: 'must not contain javascript:, data:, vbscript: or file: links',
  UNSAFE_LINK: 'every link, bare or [label](link), must be an https:// link to a named host',
};

function safeText(max: number, options: { readonly multiline: boolean }) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .superRefine((value, ctx) => {
      if (!options.multiline && /[\r\n]/u.test(value)) {
        ctx.addIssue({ code: 'custom', message: 'one line, no line breaks' });
        return;
      }
      const problem = clientAppTextProblem(value);
      if (problem !== null) ctx.addIssue({ code: 'custom', message: PROBLEM_MESSAGES[problem] });
    });
}

// --- The guide's Markdown-like subset --------------------------------------------------------

/**
 * The guide as a customer reads it: PLAIN TEXT, the same string for Telegram and for the
 * Web Admin's preview.
 *
 * The subset, and all of it:
 *   - a line starting `- `, `* ` or `• ` is a bullet, drawn `• `;
 *   - a line starting with a number and `.` or `)` — Latin or Persian digits — is a step,
 *     drawn `<number>. `;
 *   - `[label](https://…)` is a link, drawn `label: https://…` so Telegram makes the
 *     address tappable on its own;
 *   - a bare `https://…` link is kept as written;
 *   - a blank line separates paragraphs; runs of blank lines collapse to one.
 * Everything else is literal text. There is no bold, no heading and no raw HTML, because
 * the detail message is sent with NO parse mode: a subset that promised emphasis would
 * be rendered by Telegram as the asterisks the operator typed.
 *
 * Total and pure: a link that fails `normalizeClientAppUrl` — which validation already
 * refuses, so only a row written around it could hold one — is drawn as its label alone,
 * never as a link; a bare URL-like token that `clientAppTextProblem` would refuse
 * (`http://…`, `www.…`, any other scheme) is DROPPED, its trailing punctuation kept, so
 * Telegram has nothing to auto-link; and markup has nothing to be interpreted by.
 */
export function renderClientAppGuide(content: string): string {
  const lines = content.replace(/\r\n?/gu, '\n').split('\n');
  const drawn = lines.map((raw) => {
    const line = raw.replace(/\s+$/u, '');
    const bullet = /^\s*[-*•]\s+(.*)$/u.exec(line);
    if (bullet !== null) return `• ${inline(bullet[1] ?? '')}`;
    const step = /^\s*([0-9۰-۹٠-٩]{1,3})[.)]\s+(.*)$/u.exec(line);
    if (step !== null) return `${step[1] ?? ''}. ${inline(step[2] ?? '')}`;
    return inline(line.trim());
  });
  return drawn
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function inline(text: string): string {
  return neutralizeClientAppBareLinks(
    text.replace(LINK, (_whole, label: string, target: string) => {
      const url = normalizeClientAppUrl(target);
      return url === null ? label : `${label}: ${url}`;
    }),
  );
}

/**
 * Operator text with every bare URL-like token `clientAppTextProblem` would refuse —
 * `http://…`, a scheme-less `www.…`, any scheme but https, an https link
 * `normalizeClientAppUrl` refuses — DROPPED, its trailing punctuation kept. A safe bare
 * `https://` link and all other text are left exactly as written.
 *
 * The one implementation of that step: `renderClientAppGuide` applies it to the guide, and
 * the customer's read applies it to an entry's name, icon and description (Codex review #2
 * of PR #95, C6). Validation already refuses such a token in every field, so this only
 * changes a row written around the service — a restore, a migration, a hand edit — and
 * there it is what keeps Telegram from auto-linking a plaintext address in the message.
 * Total and pure.
 */
export function neutralizeClientAppBareLinks(text: string): string {
  return text.replace(BARE_URL, (token) =>
    isSafeBareUrl(token) ? token : (TRAILING_PUNCTUATION.exec(token)?.[0] ?? ''),
  );
}

// --- The entry ------------------------------------------------------------------------------

function distinctSubset<T extends string>(values: readonly [T, ...T[]]) {
  return z
    .array(z.enum(values))
    .max(values.length)
    .refine((list) => new Set(list).size === list.length, { message: 'no repeats' })
    .default([]);
}

/**
 * What an operator writes. Empty compatibility lists mean "any": an entry that names no
 * provider type is offered whatever panel a customer's service is on.
 */
export const clientAppInputSchema = z.object({
  platform: clientAppPlatformSchema,
  name: safeText(CLIENT_APP_NAME_MAX_LENGTH, { multiline: false }),
  icon: z
    .union([z.string(), z.null()])
    .optional()
    .transform((value, ctx) => {
      const trimmed = value?.trim() ?? '';
      if (trimmed === '') return null;
      if (trimmed.length > CLIENT_APP_ICON_MAX_LENGTH || /\s/u.test(trimmed)) {
        ctx.addIssue({ code: 'custom', message: 'a short mark with no spaces' });
        return z.NEVER;
      }
      const problem = clientAppTextProblem(trimmed);
      if (problem !== null) {
        ctx.addIssue({ code: 'custom', message: PROBLEM_MESSAGES[problem] });
        return z.NEVER;
      }
      return trimmed;
    }),
  description: safeText(CLIENT_APP_DESCRIPTION_MAX_LENGTH, { multiline: false }),
  officialUrl: clientAppUrlSchema,
  alternativeUrl: optionalClientAppUrlSchema,
  helpUrl: optionalClientAppUrlSchema,
  guide: safeText(CLIENT_APP_GUIDE_MAX_LENGTH, { multiline: true }),
  deliveryKinds: distinctSubset(CLIENT_APP_DELIVERY_KINDS),
  protocols: distinctSubset(CLIENT_APP_PROTOCOLS),
  providerTypes: distinctSubset(PROVIDER_TYPES),
  sortOrder: z.number().int().min(CLIENT_APP_SORT_MIN).max(CLIENT_APP_SORT_MAX),
});
export type ClientAppInput = z.output<typeof clientAppInputSchema>;

// --- HTTP -------------------------------------------------------------------------------------

/**
 * What the Web Admin sees of an entry's image: metadata, never the bytes. The bytes are
 * served on their own route (`CLIENT_APP_ROUTES.image`) for the editor's preview.
 */
export const clientAppImageSchema = z.object({
  mimeType: clientAppImageMimeTypeSchema,
  byteLength: z.number().int(),
  width: z.number().int(),
  height: z.number().int(),
  sha256: z.string(),
  updatedAt: z.iso.datetime(),
});
export type ClientAppImageResponse = z.infer<typeof clientAppImageSchema>;

export const clientAppSchema = z.object({
  id: z.string(),
  platform: clientAppPlatformSchema,
  name: z.string(),
  icon: z.string().nullable(),
  description: z.string(),
  officialUrl: z.string(),
  alternativeUrl: z.string().nullable(),
  helpUrl: z.string().nullable(),
  guide: z.string(),
  deliveryKinds: z.array(z.enum(CLIENT_APP_DELIVERY_KINDS)),
  protocols: z.array(z.enum(CLIENT_APP_PROTOCOLS)),
  providerTypes: z.array(z.enum(PROVIDER_TYPES)),
  status: clientAppStatusSchema,
  sortOrder: z.number().int(),
  version: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /** HF-A10. Null when the entry has no picture, which is the emoji-and-text screen. */
  image: clientAppImageSchema.nullable(),
});
export type ClientAppResponse = z.infer<typeof clientAppSchema>;

export const clientAppListSchema = z.object({ items: z.array(clientAppSchema) });
export type ClientAppListResponse = z.infer<typeof clientAppListSchema>;

const idempotencyKeySchema = z.string().min(8).max(255);

/** A new entry is ENABLED, as a new FAQ entry is ACTIVE; switching it off is its own command. */
export const createClientAppRequestSchema = clientAppInputSchema.extend({
  idempotencyKey: idempotencyKeySchema,
});
export type CreateClientAppRequest = z.input<typeof createClientAppRequestSchema>;

export const updateClientAppRequestSchema = clientAppInputSchema.extend({
  idempotencyKey: idempotencyKeySchema,
  expectedVersion: z.number().int().min(1),
});
export type UpdateClientAppRequest = z.input<typeof updateClientAppRequestSchema>;

export const setClientAppStatusRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  status: clientAppStatusSchema,
  expectedVersion: z.number().int().min(1),
});
export type SetClientAppStatusRequest = z.infer<typeof setClientAppStatusRequestSchema>;

/** Removal states the version it read, like every other write here. */
export const deleteClientAppRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  expectedVersion: z.number().int().min(1),
});
export type DeleteClientAppRequest = z.infer<typeof deleteClientAppRequestSchema>;

export const clientAppDeletedSchema = z.object({ id: z.string(), deleted: z.literal(true) });
export type ClientAppDeletedResponse = z.infer<typeof clientAppDeletedSchema>;

/**
 * HF-A10. Sets or replaces an entry's image: base64 in JSON, the referral banner's shape,
 * bounded here by the DECODED size so a padded payload cannot pass. The service decodes
 * and runs `inspectClientAppImage` on the bytes before storing. States the entry's version
 * like every other write on it, and bumps it.
 */
export const uploadClientAppImageRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  expectedVersion: z.number().int().min(1),
  mimeType: clientAppImageMimeTypeSchema,
  contentBase64: z
    .string()
    .regex(/^[A-Za-z0-9+/]+={0,2}$/u)
    .refine((value) => Math.floor((value.length * 3) / 4) <= CLIENT_APP_IMAGE_MAX_BYTES + 3, {
      message: `at most ${CLIENT_APP_IMAGE_MAX_BYTES} bytes`,
    }),
});
export type UploadClientAppImageRequest = z.infer<typeof uploadClientAppImageRequestSchema>;

/** HF-A10. Removes an entry's image; the entry goes back to its emoji and text. */
export const clearClientAppImageRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  expectedVersion: z.number().int().min(1),
});
export type ClearClientAppImageRequest = z.infer<typeof clearClientAppImageRequestSchema>;

// --- Tutorial video from the Web Admin (UX Batch 01 item 6) ------------------------------

/**
 * «افزودن ویدیو از تلگرام»: the Web Admin opens the SAME `CLIENT_APP_VIDEO` prompt the
 * Telegram panel's «تنظیم ویدیو» opens — one row in `admin_amount_captures`, naming the tenant,
 * the administrator, the bot and the app, with a deadline — and the administrator then sends
 * the video to that bot from the Telegram account bound to them (`admins.telegram_user_id`).
 * The bot stores it exactly as it stores a video sent after the Telegram tap, and the page
 * polls the prompt until it is closed.
 *
 * A prompt opened from the web has no tap to be newer than, so it reads only a message
 * Telegram dated no earlier than the prompt's opening, less this allowance for the two clocks.
 */
export const CLIENT_APP_VIDEO_WEB_CLOCK_SKEW_MS = 30 * 1000;

/**
 * What the page shows of one prompt. `OPEN` until a video lands (`CONFIRMED`), the
 * administrator cancels (`CANCELLED`), another prompt replaces it (`SUPERSEDED`), or its
 * deadline passes (`EXPIRED` — reported from the clock as soon as it has passed; the row is
 * stamped only by a write: a late video, or a cancel).
 */
export const CLIENT_APP_VIDEO_SESSION_STATES = [
  'OPEN',
  'CONFIRMED',
  'CANCELLED',
  'SUPERSEDED',
  'EXPIRED',
] as const;
export type ClientAppVideoSessionState = (typeof CLIENT_APP_VIDEO_SESSION_STATES)[number];

/**
 * A stored tutorial video, as the page shows it: metadata only. The bot-scoped `file_id` is
 * a sending handle the page has no use for, and is not sent.
 */
export const clientAppVideoSchema = z.object({
  fileUniqueId: z.string(),
  mimeType: z.string().nullable(),
  durationSeconds: z.number().int().nullable(),
  /** Bytes, as a decimal string — a bigint on the server. */
  fileSize: z.string().nullable(),
  updatedAt: z.iso.datetime(),
});
export type ClientAppVideoResponse = z.infer<typeof clientAppVideoSchema>;

/** One of the tenant's bots, and the video this app has on it. */
export const clientAppVideoBotSchema = z.object({
  botInstanceId: z.string(),
  username: z.string(),
  /** `https://t.me/<username>`: the chat the administrator sends the video to. */
  chatUrl: z.string(),
  active: z.boolean(),
  video: clientAppVideoSchema.nullable(),
});

export const clientAppVideosSchema = z.object({
  /** Whether the viewing administrator has a Telegram account bound — needed to send one. */
  telegramLinked: z.boolean(),
  bots: z.array(clientAppVideoBotSchema),
});
export type ClientAppVideosResponse = z.infer<typeof clientAppVideosSchema>;

export const clientAppVideoSessionSchema = z.object({
  sessionId: z.string(),
  botInstanceId: z.string(),
  username: z.string(),
  chatUrl: z.string(),
  state: z.enum(CLIENT_APP_VIDEO_SESSION_STATES),
  openedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  /** The video the prompt stored, once `CONFIRMED`. */
  video: clientAppVideoSchema.nullable(),
});
export type ClientAppVideoSessionResponse = z.infer<typeof clientAppVideoSessionSchema>;

export const openClientAppVideoSessionRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  botInstanceId: z.uuid(),
});
export type OpenClientAppVideoSessionRequest = z.infer<
  typeof openClientAppVideoSessionRequestSchema
>;

export const cancelClientAppVideoSessionRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
});
export type CancelClientAppVideoSessionRequest = z.infer<
  typeof cancelClientAppVideoSessionRequestSchema
>;

export const CLIENT_APP_ROUTES = {
  list: '/client-apps',
  create: '/client-apps',
  update: (id: string) => `/client-apps/${encodeURIComponent(id)}`,
  status: (id: string) => `/client-apps/${encodeURIComponent(id)}/status`,
  remove: (id: string) => `/client-apps/${encodeURIComponent(id)}/delete`,
  /** GET: the stored image's bytes, as the type they were verified to be. POST: upload. */
  image: (id: string) => `/client-apps/${encodeURIComponent(id)}/image`,
  clearImage: (id: string) => `/client-apps/${encodeURIComponent(id)}/image/clear`,
  /** UX Batch 01 item 6. GET: this app's video on each of the tenant's bots. */
  videos: (id: string) => `/client-apps/${encodeURIComponent(id)}/videos`,
  /** POST: open a «send it from Telegram» prompt for one bot. */
  videoSessions: (id: string) => `/client-apps/${encodeURIComponent(id)}/video-sessions`,
  /** GET: one prompt's state, polled by the page. */
  videoSession: (id: string, sessionId: string) =>
    `/client-apps/${encodeURIComponent(id)}/video-sessions/${encodeURIComponent(sessionId)}`,
  /** POST: cancel it. */
  videoSessionCancel: (id: string, sessionId: string) =>
    `/client-apps/${encodeURIComponent(id)}/video-sessions/${encodeURIComponent(sessionId)}/cancel`,
} as const;
