import type { TemplateKey } from './templates.js';

/**
 * Every command this bot answers, with the description Telegram shows beside it.
 *
 * ONE list, used twice: `setMyCommands` registers it with Telegram so the commands
 * appear in the client's own menu, and `/help` renders it. Two lists would be two
 * things to keep in step, and the failure would be silent in the direction that matters
 * — a command registered and undocumented, or documented and unregistered.
 *
 * `docs/phase4h-audit.md` §9 measured why this exists: the bot answered four commands,
 * registered none of them with Telegram, drew no keyboard, and `bot.start.welcome`
 * named only `/catalog`. So `/wallet` and `/services` were reachable only by a customer
 * who guessed them.
 *
 * The descriptions are TEMPLATE KEYS, not strings, because they are customer-facing text
 * and `nexa-conventions` admits no literal in a surface. Telegram caps a command
 * description at 256 characters and the command itself at 32; both are far above what
 * any entry here uses, and the catalogue's own length checks apply to the rendered text.
 */
export const BOT_COMMANDS = [
  { command: 'start', description: 'bot.command.start' },
  { command: 'catalog', description: 'bot.command.catalog' },
  { command: 'services', description: 'bot.command.services' },
  { command: 'wallet', description: 'bot.command.wallet' },
  { command: 'help', description: 'bot.command.help' },
] as const;

export type BotCommandName = (typeof BOT_COMMANDS)[number]['command'];

/** One button on the persistent main menu: a label, and the command it stands for. */
export interface BotMenuButton {
  /** The label the customer sees AND the text a tap sends back. */
  readonly label: TemplateKey;
  /** The command this button is exactly equivalent to. Not a second handler. */
  readonly command: BotCommandName;
}

/**
 * The persistent main menu, row by row.
 *
 * Real v0.2.0 staging acceptance exposed the gap this closes: the bot answered five
 * commands and registered them with `setMyCommands`, and an ordinary customer still had
 * to know to type a slash. `setMyCommands` stays — it is the client's own menu and the
 * fallback — and this is the keyboard sitting under the chat.
 *
 * ## Why each button names a COMMAND rather than an intent
 *
 * The equivalence is the point. A button must reach the same application flow as its
 * slash command, and the cheapest way to guarantee that is to have no second route at
 * all: the surface turns a tapped label back into `/catalog`, `/services`, `/wallet` or
 * `/help` and lets the EXISTING branch decide. There is no parallel dispatch table to
 * drift, and `BotCommandName` is already the closed set of what this bot answers.
 *
 * ## What is deliberately NOT here
 *
 * A button for anything this release cannot do. Referral, reseller, affiliate, cashback,
 * promotions, a wheel and a trial are Phase 7, and a keyboard is a promise: a button that
 * answers "not available" is the legacy system's defect — a menu describing a product
 * that does not exist — reproduced deliberately. The list grows when a capability ships.
 *
 * The keyboard also carries NO identifiers and therefore no authority. Every contextual
 * action — a product, a payment, a service, a confirmation — stays on `callback_data`
 * with its validated id and its ownership check. This is navigation and nothing else.
 */
export const MAIN_MENU_ROWS: readonly (readonly BotMenuButton[])[] = [
  [
    { label: 'bot.menu.catalog', command: 'catalog' },
    { label: 'bot.menu.services', command: 'services' },
  ],
  [
    { label: 'bot.menu.wallet', command: 'wallet' },
    { label: 'bot.menu.help', command: 'help' },
  ],
];

/** Every menu button, flattened. The rows are layout; this is the set. */
export const MAIN_MENU_BUTTONS: readonly BotMenuButton[] = MAIN_MENU_ROWS.flat();

/**
 * The management panel's entry, and why it is not in `MAIN_MENU_ROWS`.
 *
 * Phase 5T. The rows above are what EVERY customer sees, and this is drawn only for a
 * Telegram account bound to an ACTIVE administrator who holds at least one of the
 * panel's own permissions — so it is a separate constant appended per turn rather than
 * a fifth entry somebody could render unconditionally by accident.
 *
 * Its command is deliberately absent from `BOT_COMMANDS`. That list is what
 * `setMyCommands` registers with Telegram, and Telegram's command list is per BOT, not
 * per user: registering `/admin` would advertise the panel's existence to every customer
 * of every tenant. A customer who types it anyway is answered exactly as they are for
 * any other unknown command, by the same fallback, because the runtime resolves the
 * binding before it decides anything and an absent binding is not a different reply.
 *
 * Drawing the button is NOT the authorization. Every action inside the panel re-checks
 * its permission server-side, which is the rule `docs/conventions.md` states as "never
 * by not drawing a button".
 */
export const ADMIN_MENU_COMMAND = 'admin';

/** The label, and the command a tap on it stands for. Same shape as a menu button. */
export const ADMIN_MENU_BUTTON = {
  label: 'bot.menu.admin',
  command: ADMIN_MENU_COMMAND,
} as const satisfies { readonly label: TemplateKey; readonly command: string };
