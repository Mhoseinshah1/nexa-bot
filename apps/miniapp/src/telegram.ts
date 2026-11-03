/**
 * Telegram's Mini App object (`telegram-web-app.js`), typed for the few members this app
 * uses. Absent outside Telegram: the app then says it must be opened from the bot and
 * draws nothing else — there is no stand-in identity and no demo mode.
 */
interface TelegramBackButton {
  show(): void;
  hide(): void;
  onClick(handler: () => void): void;
  offClick(handler: () => void): void;
}

/** What `openInvoice` reports when the invoice closes (Bot API, Mini Apps). */
export type InvoiceStatus = 'paid' | 'cancelled' | 'failed' | 'pending';

export interface TelegramWebApp {
  readonly initData: string;
  readonly colorScheme: 'light' | 'dark';
  readonly BackButton: TelegramBackButton;
  ready(): void;
  expand(): void;
  openLink(url: string): void;
  openTelegramLink(url: string): void;
  /** Absent on a Telegram client older than Bot API 6.1. */
  openInvoice?(url: string, callback?: (status: InvoiceStatus) => void): void;
  /**
   * NEXA v095 PR-4: asks the customer to share their own phone number with the bot (Bot API
   * 6.9). Telegram then sends their contact to the bot's chat as an ordinary message from
   * them, which the bot verifies; `shared` only says what the client saw. Absent on older
   * clients.
   */
  requestContact?(callback?: (shared: boolean) => void): void;
  onEvent(event: 'themeChanged', handler: () => void): void;
}

declare global {
  interface Window {
    readonly Telegram?: { readonly WebApp?: TelegramWebApp };
  }
}

export function webApp(): TelegramWebApp | null {
  const app = window.Telegram?.WebApp;
  return app !== undefined && typeof app.initData === 'string' ? app : null;
}

/**
 * The theme follows the customer's Telegram: dark is the Liquid Glass primary, light reads
 * Telegram's own `--tg-theme-*` colours (which `telegram-web-app.js` sets on the root) with
 * the tokens' light values beneath them. `data-theme` is always written, as in the admin.
 */
export function applyTheme(app: TelegramWebApp | null): void {
  document.documentElement.dataset['theme'] = app?.colorScheme === 'light' ? 'light' : 'dark';
}

/** Opens a provider's payment page or any other link the server handed back. */
export function openExternal(url: string): void {
  const app = webApp();
  if (app !== null) app.openLink(url);
  else window.open(url, '_blank', 'noopener');
}

/** Opens a `t.me` link (the bot's chat) inside Telegram. */
export function openTelegram(url: string): void {
  const app = webApp();
  if (app !== null) app.openTelegramLink(url);
  else window.open(url, '_blank', 'noopener');
}

/**
 * R11 B5: opens a Stars invoice link in place (`Telegram.WebApp.openInvoice`) and resolves
 * with the status Telegram's client reports when it closes, or `unsupported` where there is
 * no such method (outside Telegram, or an old client).
 *
 * The status is what the CLIENT saw and is never proof of payment: `paid` only means "ask the
 * server", which decides from the charge its webhook recorded.
 */
export function openStarsInvoice(url: string): Promise<InvoiceStatus | 'unsupported'> {
  const app = webApp();
  if (app === null || typeof app.openInvoice !== 'function') {
    return Promise.resolve('unsupported');
  }
  const open = app.openInvoice.bind(app);
  return new Promise((resolve) => {
    open(url, (status) => resolve(status));
  });
}

/**
 * NEXA v095 PR-4 A/C: asks for the customer's own contact (`Telegram.WebApp.requestContact`).
 * `shared` is what the CLIENT saw and proves nothing: the contact arrives in the bot's chat and
 * the server decides — the caller polls `/me` for it. `unsupported` where there is no method.
 */
export function requestOwnContact(): Promise<'shared' | 'cancelled' | 'unsupported'> {
  const app = webApp();
  if (app === null || typeof app.requestContact !== 'function') {
    return Promise.resolve('unsupported');
  }
  const request = app.requestContact.bind(app);
  return new Promise((resolve) => {
    request((shared) => resolve(shared ? 'shared' : 'cancelled'));
  });
}

/** Whether this client can ask for the contact in place (`requestContact`, Bot API 6.9). */
export function contactRequestAvailable(): boolean {
  const app = webApp();
  return app !== null && typeof app.requestContact === 'function';
}

/** The bot's chat, opened on its contact prompt (`/start verify_phone`), for a client without it. */
export function botPhonePromptLink(botLink: string): string {
  return `${botLink}?start=verify_phone`;
}
