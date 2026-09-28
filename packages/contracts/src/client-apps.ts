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

export const CLIENT_APP_ROUTES = {
  list: '/client-apps',
  create: '/client-apps',
  update: (id: string) => `/client-apps/${encodeURIComponent(id)}`,
  status: (id: string) => `/client-apps/${encodeURIComponent(id)}/status`,
  remove: (id: string) => `/client-apps/${encodeURIComponent(id)}/delete`,
} as const;
