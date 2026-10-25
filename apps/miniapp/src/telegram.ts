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

export interface TelegramWebApp {
  readonly initData: string;
  readonly colorScheme: 'light' | 'dark';
  readonly BackButton: TelegramBackButton;
  ready(): void;
  expand(): void;
  openLink(url: string): void;
  openTelegramLink(url: string): void;
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
