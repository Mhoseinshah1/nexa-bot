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
 * The sing-box import string for a subscription link. The link is percent-encoded as a whole
 * (`encodeURIComponent`), so a `?`, `&`, `#` or `=` inside it stays inside the `url` value
 * and cannot become a parameter of this URL.
 */
export function singboxImportUrl(subscriptionUrl: string, intervalMinutes: number): string {
  return (
    'sing-box://import-remote-profile?url=' +
    encodeURIComponent(subscriptionUrl) +
    '&autoUpdate=true&autoUpdateInterval=' +
    String(intervalMinutes)
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
}): readonly { readonly kind: QrPayloadKind; readonly text: string }[] {
  if (input.filesOnly) return [];
  const link = { kind: 'SUB_LINK' as const, text: input.subscriptionUrl };
  const singbox = {
    kind: 'SINGBOX' as const,
    text: singboxImportUrl(input.subscriptionUrl, input.intervalMinutes),
  };
  if (input.kind === 'SINGBOX') return [singbox];
  if (input.kind === 'BOTH') return [link, singbox];
  return [link];
}
