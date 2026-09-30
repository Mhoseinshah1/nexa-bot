import { z } from 'zod';
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
  /*
   * Telegram requires a bot that sells digital goods for Stars to answer `/paysupport`
   * (Package A). It is the existing support screen, not a second channel.
   */
  { command: 'paysupport', description: 'bot.command.paysupport' },
  /*
   * WP-A10: «📱 دانلود برنامه و آموزش اتصال». The connection guide that was reachable only
   * from the delivery card's «📚 مشاهده آموزش استفاده», now with the tenant's recommended
   * apps and their download links — the same screen, not a second guide.
   */
  { command: 'apps', description: 'bot.command.apps' },
  /*
   * WP-A7: the customer's support tickets. `/paysupport` stays the support screen Telegram
   * requires, and that screen links here.
   */
  { command: 'tickets', description: 'bot.command.tickets' },
] as const;

export type BotCommandName = (typeof BOT_COMMANDS)[number]['command'];

/**
 * R1: the two main-menu commands that are NOT registered with `setMyCommands`.
 *
 * Both are features a tenant may not be offering (no panel with a trial since F5; the
 * `referrals` flag off), and Telegram's command list is per BOT: registering `/trial`
 * would advertise a trial to every customer of a tenant that offers none. So they are reachable by their main-menu button, and by
 * typing them, exactly as `/admin` is — and a turn that resolves one answers from the
 * feature's own state, never from the button having been drawn.
 */
export const TRIAL_MENU_COMMAND = 'trial';
export const REFERRAL_MENU_COMMAND = 'referral';

/** What a main-menu button may stand for: a registered command, or one of the two above. */
export type MainMenuCommand =
  BotCommandName | typeof TRIAL_MENU_COMMAND | typeof REFERRAL_MENU_COMMAND;

/**
 * The stable identity of each main-menu button (R1, «دکمه‌های ربات»).
 *
 * What the Web Admin's bot-buttons page stores in `bot.main_menu` — never a label, which an
 * operator may rewrite, and never a position, which they may reorder. Closed, like every
 * other vocabulary a setting holds: an id nothing here declares fails at the schema.
 */
export const MAIN_MENU_BUTTON_IDS = [
  'catalog',
  'services',
  'wallet',
  'help',
  'trial',
  'referral',
  'apps',
  'tickets',
] as const;
export type MainMenuButtonId = (typeof MAIN_MENU_BUTTON_IDS)[number];

/** One button on the persistent main menu: a label, and the command it stands for. */
export interface BotMenuButton {
  readonly id: MainMenuButtonId;
  /**
   * The label the customer sees AND the text a tap sends back — rendered through the
   * tenant's own templates since R1, and routed from the same rendering (see
   * `MAIN_MENU_ROWS`).
   */
  readonly label: TemplateKey;
  /** The command this button is exactly equivalent to. Not a second handler. */
  readonly command: MainMenuCommand;
  /** Drawn on a row of its own: its label is long, and it is a place of its own. */
  readonly wide: boolean;
  /**
   * The feature flag that must be ON for the button to be drawn, or null.
   *
   * A keyboard is a promise, so a button for a feature a tenant has switched off is not
   * drawn at all — whatever the bot-buttons page says.
   */
  readonly feature: 'referrals' | null;
  /**
   * F5: drawn only while at least one panel offers a trial NOW — `trialOffersFor`, the one
   * answer the claim, the overview and this keyboard share. The trial has no flag since
   * F5: each panel's own trial is the switch, so "no panel offers one" is what hides it.
   * The tap still answers from the claim, never from the button having been drawn.
   */
  readonly needsTrialOffer: boolean;
}

/**
 * Whether something other than the operator's own switch can hide this button — a flag, or
 * no panel offering a trial. The layout rule "one button nothing else can hide stays on"
 * and the fallback keyboard both ask it, so they cannot disagree about which buttons count.
 */
export function mainMenuButtonIsGated(button: BotMenuButton): boolean {
  return button.feature !== null || button.needsTrialOffer;
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
 * A button for anything this release cannot do. Reseller, affiliate, promotions and a
 * wheel are not built, and a keyboard is a promise: a button that answers "not
 * available" is the legacy system's defect — a menu describing a product that does not
 * exist — reproduced deliberately. The list grows when a capability ships; the trial and
 * the referral program shipped (R1): the referral button is drawn only while its flag is on,
 * and the trial button only while a panel offers a trial (F5).
 *
 * ## Labels are the tenant's, and so are the routes (R1)
 *
 * Until R1 the keyboard was drawn from the SHARED catalogue, because a label a tenant
 * could rename was a route a tenant could break — and the tenant's `bot.menu.*` overrides
 * were accepted by the texts screen and then ignored. Now the keyboard's labels are
 * rendered through the tenant's templates AND the route table a tap is matched against is
 * built from the SAME rendering, so a renamed button still routes; the shared defaults
 * stay in the route table too, so a keyboard already sitting in a chat keeps working after
 * a rename. The order and the on/off switches are `bot.main_menu`.
 *
 * The keyboard also carries NO identifiers and therefore no authority. Every contextual
 * action — a product, a payment, a service, a confirmation — stays on `callback_data`
 * with its validated id and its ownership check. This is navigation and nothing else.
 */
export const MAIN_MENU_BUTTONS: readonly BotMenuButton[] = [
  {
    id: 'catalog',
    label: 'bot.menu.catalog',
    command: 'catalog',
    wide: false,
    feature: null,
    needsTrialOffer: false,
  },
  {
    id: 'services',
    label: 'bot.menu.services',
    command: 'services',
    wide: false,
    feature: null,
    needsTrialOffer: false,
  },
  {
    id: 'wallet',
    label: 'bot.menu.wallet',
    command: 'wallet',
    wide: false,
    feature: null,
    needsTrialOffer: false,
  },
  {
    id: 'help',
    label: 'bot.menu.help',
    command: 'help',
    wide: false,
    feature: null,
    needsTrialOffer: false,
  },
  /*
   * R1: «🧪 دریافت سرویس تست» and «👥 زیرمجموعه‌گیری», side by side. The referral button is
   * behind its flag; the trial button, since F5, behind a panel offering a trial.
   */
  {
    id: 'trial',
    label: 'bot.menu.trial',
    command: TRIAL_MENU_COMMAND,
    wide: false,
    feature: null,
    needsTrialOffer: true,
  },
  {
    id: 'referral',
    label: 'bot.menu.referral',
    command: REFERRAL_MENU_COMMAND,
    wide: false,
    feature: 'referrals',
    needsTrialOffer: false,
  },
  // WP-A10: a row of its own — the label is long, and it is a place, like the four above.
  {
    id: 'apps',
    label: 'bot.menu.apps',
    command: 'apps',
    wide: true,
    feature: null,
    needsTrialOffer: false,
  },
  // WP-A7: the ticket desk, on a row of its own.
  {
    id: 'tickets',
    label: 'bot.menu.tickets',
    command: 'tickets',
    wide: true,
    feature: null,
    needsTrialOffer: false,
  },
];

/** The declared button for an id. Total over `MAIN_MENU_BUTTON_IDS`. */
export function mainMenuButton(id: MainMenuButtonId): BotMenuButton {
  const found = MAIN_MENU_BUTTONS.find((button) => button.id === id);
  if (found === undefined) throw new Error(`main-menu button ${id} is not declared`);
  return found;
}

/**
 * Buttons, in order, packed into rows: two to a row, and a `wide` one alone.
 *
 * The one layout rule, so the default keyboard and a reordered one are drawn the same way
 * and an operator reordering buttons never has to think about rows.
 */
export function packMainMenuRows<T extends Pick<BotMenuButton, 'wide'>>(
  buttons: readonly T[],
): T[][] {
  const rows: T[][] = [];
  let open: T[] | null = null;
  for (const button of buttons) {
    if (button.wide) {
      rows.push([button]);
      open = null;
      continue;
    }
    if (open !== null && open.length < 2) {
      open.push(button);
      if (open.length === 2) open = null;
      continue;
    }
    open = [button];
    rows.push(open);
  }
  return rows;
}

/** The default keyboard, every declared button in its declared order. */
export const MAIN_MENU_ROWS: readonly (readonly BotMenuButton[])[] =
  packMainMenuRows(MAIN_MENU_BUTTONS);

/**
 * The operator's arrangement of the main menu (R1, `bot.main_menu`): the buttons in the
 * order they are drawn, each switched on or off.
 *
 * An id at most once. A declared button the stored value does not name — one a later
 * release added — is appended in its declared place, switched ON, so shipping a button
 * never needs a migration of anybody's arrangement (`resolveMainMenuLayout`).
 *
 * At least one button with no gate must be on: every gated button can be hidden by its
 * flag or, for the trial, by no panel offering one (`mainMenuButtonIsGated`), and a
 * keyboard with no buttons at all is one Telegram refuses — which would take every reply
 * that carries it down with it.
 */
export const mainMenuLayoutEntrySchema = z
  .object({ button: z.enum(MAIN_MENU_BUTTON_IDS), enabled: z.boolean() })
  .strict();
export type MainMenuLayoutEntry = z.infer<typeof mainMenuLayoutEntrySchema>;

export const mainMenuLayoutSchema = z
  .array(mainMenuLayoutEntrySchema)
  .max(MAIN_MENU_BUTTON_IDS.length)
  .refine((entries) => new Set(entries.map((entry) => entry.button)).size === entries.length, {
    message: 'Each button may appear once.',
  })
  .refine(
    (entries) =>
      resolveMainMenuLayout(entries).some(
        (entry) => entry.enabled && !mainMenuButtonIsGated(mainMenuButton(entry.button)),
      ),
    { message: 'At least one button that nothing else can hide must stay on.' },
  );

/** Every declared button, in its declared order, switched on. */
export const DEFAULT_MAIN_MENU_LAYOUT: readonly MainMenuLayoutEntry[] = MAIN_MENU_BUTTONS.map(
  (button) => ({ button: button.id, enabled: true }),
);

/**
 * A stored arrangement, completed: its entries in its order, then every declared button it
 * does not name, in declared order and switched on.
 */
export function resolveMainMenuLayout(
  stored: readonly MainMenuLayoutEntry[],
): readonly MainMenuLayoutEntry[] {
  const named = new Set(stored.map((entry) => entry.button));
  return [...stored, ...DEFAULT_MAIN_MENU_LAYOUT.filter((entry) => !named.has(entry.button))];
}

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
