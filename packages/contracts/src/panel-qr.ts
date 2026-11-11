/**
 * R11 A4 (second part): the kind of QR a RickPanel panel's customers are shown — «نوع بارکد».
 *
 *   SUB_LINK  the plain subscription-link QR. The default, and exactly what every panel drew
 *             before this option existed.
 *   SINGBOX   a sing-box import QR: scanning it opens sing-box and imports the subscription
 *             as a remote profile that refreshes itself.
 *   BOTH      both, each with a one-line caption.
 *
 * The option exists for RickPanel panels only (`panelSupportsQrKind`); the server refuses it
 * for any other type, and «فقط فایل، بدون لینک ساب» overrides it — with the link hidden no QR
 * of any kind is drawn. The functions here are pure so the Web Admin, the bot and the mini
 * app encode the same string.
 */
export const PANEL_QR_KINDS = ['SUB_LINK', 'SINGBOX', 'BOTH'] as const;
export type PanelQrKind = (typeof PANEL_QR_KINDS)[number];

/** One concrete QR that can be drawn: BOTH is two of these. */
export const QR_PAYLOAD_KINDS = ['SUB_LINK', 'SINGBOX'] as const;
export type QrPayloadKind = (typeof QR_PAYLOAD_KINDS)[number];

export const DEFAULT_PANEL_QR_KIND: PanelQrKind = 'SUB_LINK';

/** sing-box's remote-profile refresh, in minutes: six hours by default, a week at most. */
export const SINGBOX_INTERVAL_DEFAULT_MINUTES = 360;
export const SINGBOX_INTERVAL_MIN_MINUTES = 1;
export const SINGBOX_INTERVAL_MAX_MINUTES = 10_080;

export function isPanelQrKind(value: string): value is PanelQrKind {
  return (PANEL_QR_KINDS as readonly string[]).includes(value);
}

/** A valid interval: a whole number of minutes inside the bounds above. */
export function isSingboxInterval(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= SINGBOX_INTERVAL_MIN_MINUTES &&
    value <= SINGBOX_INTERVAL_MAX_MINUTES
  );
}

/** Only RickPanel panels have a choice of QR. */
export function panelSupportsQrKind(providerType: string): boolean {
  return providerType === 'rickpanel';
}

/**
 * «نام پروفایل در sing-box»: the name sing-box gives the imported profile, read from the URL
 * fragment. DEFAULT draws no fragment (sing-box names the profile after the subscription's
 * host, as it always did); USERNAME names it after the service's panel-account username;
 * CUSTOM uses the owner's own text, where `{username}` stands for that username.
 */
export const SINGBOX_NAME_MODES = ['DEFAULT', 'USERNAME', 'CUSTOM'] as const;
export type SingboxNameMode = (typeof SINGBOX_NAME_MODES)[number];
export const DEFAULT_SINGBOX_NAME_MODE: SingboxNameMode = 'DEFAULT';
export const SINGBOX_NAME_CUSTOM_MAX = 64;

export function isSingboxNameMode(value: string): value is SingboxNameMode {
  return (SINGBOX_NAME_MODES as readonly string[]).includes(value);
}

/**
 * The owner's custom text as it is stored: trimmed; `null` when it is empty (which behaves like
 * the default). Returns `undefined` for text that must be refused: a line break, or more than
 * `SINGBOX_NAME_CUSTOM_MAX` characters (counted as code points, the way a person counts).
 */
export function normalizeSingboxCustomName(text: string): string | null | undefined {
  const trimmed = text.trim();
  if (/[\r\n\u2028\u2029]/.test(trimmed)) return undefined;
  if ([...trimmed].length > SINGBOX_NAME_CUSTOM_MAX) return undefined;
  return trimmed === '' ? null : trimmed;
}

/**
 * The profile name to put in the fragment, or `null` for none. Pure, so the Web Admin preview,
 * the bot and the mini app resolve the same name. A custom text that is empty, or a username
 * that is empty, yields `null`: no fragment rather than an empty one.
 */
export function resolveSingboxProfileName(input: {
  readonly mode: SingboxNameMode;
  readonly custom: string | null;
  readonly username: string;
}): string | null {
  if (input.mode === 'USERNAME') return input.username === '' ? null : input.username;
  if (input.mode === 'CUSTOM') {
    const text = (input.custom ?? '').trim();
    if (text === '') return null;
    const name = text.split('{username}').join(input.username).trim();
    return name === '' ? null : name;
  }
  return null;
}

/**
 * The sing-box import string for a subscription link. The link is percent-encoded as a whole
 * (`encodeURIComponent`), so a `?`, `&`, `#` or `=` inside it stays inside the `url` value
 * and cannot become a parameter of this URL. A profile name, when given, is the fragment
 * (`#` + `encodeURIComponent(name)`), which is where sing-box reads it from.
 */
export function singboxImportUrl(
  subscriptionUrl: string,
  intervalMinutes: number,
  profileName?: string | null,
): string {
  return (
    'sing-box://import-remote-profile?url=' +
    encodeURIComponent(subscriptionUrl) +
    '&autoUpdate=true&autoUpdateInterval=' +
    String(intervalMinutes) +
    (profileName === undefined || profileName === null || profileName === ''
      ? ''
      : '#' + encodeURIComponent(profileName))
  );
}

/**
 * The QRs to draw for a service, in the order they are shown, and what each encodes.
 * Empty when the link is not to be shown (`filesOnly` wins over every kind).
 */
export function qrPayloads(input: {
  readonly kind: PanelQrKind;
  readonly intervalMinutes: number;
  readonly subscriptionUrl: string;
  readonly filesOnly: boolean;
  /** Only the SINGBOX payload carries it; the plain link never does. */
  readonly profileName?: string | null;
}): readonly { readonly kind: QrPayloadKind; readonly text: string }[] {
  if (input.filesOnly) return [];
  const link = { kind: 'SUB_LINK' as const, text: input.subscriptionUrl };
  const singbox = {
    kind: 'SINGBOX' as const,
    text: singboxImportUrl(input.subscriptionUrl, input.intervalMinutes, input.profileName),
  };
  if (input.kind === 'SINGBOX') return [singbox];
  if (input.kind === 'BOTH') return [link, singbox];
  return [link];
}
