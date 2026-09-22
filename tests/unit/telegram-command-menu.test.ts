import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ADMIN_MENU_COMMAND, BOT_COMMANDS, TEMPLATES } from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';

/**
 * The command menu Telegram draws, and the one list it comes from.
 *
 * `docs/phase4h-audit.md` §9 measured what this closes: the bot answered four commands,
 * registered NONE of them with Telegram, drew no keyboard, and `bot.start.welcome` named
 * only `/catalog` — so `/wallet` and `/services` were reachable only by a customer who
 * guessed them.
 *
 * `BOT_COMMANDS` is registered by the bootstrap gateway and rendered by `/help`. The
 * failure this pins is the one that would be silent in both directions: a command
 * registered and undocumented, or documented and unregistered.
 */
describe('the Telegram command menu', () => {
  it('names every command the runtime answers, and nothing it does not', () => {
    /*
     * Read from the SOURCE rather than a second list, because a constant here would be
     * the thing that drifts. The runtime parses commands with `command === '/x'`, so
     * that is what is matched.
     */
    const runtime = new URL('../../apps/api/src/surfaces/telegram/bot-runtime.ts', import.meta.url);
    const source = readFileSync(runtime, 'utf8');
    const parsed = [...source.matchAll(/command === '\/([a-z]+)'/g)].map((m) => m[1] ?? '');
    /*
     * The management panel's commands are parsed and deliberately NOT registered
     * (Phase 5T).
     *
     * Telegram's command list is per BOT, not per user: `setMyCommands` would advertise
     * `/link`, `/role` and `/service` — and the existence of an admin panel — to every
     * customer of every tenant. So these four are excluded here and asserted absent
     * below, which makes "not registered" a rule with a test rather than an omission.
     *
     * `/service` is Phase 6A's exact lookup and joins them for the same reason, with
     * one of its own: it is the singular of `/services`, which every customer HAS, so
     * registering it would put a command in their menu that reads as theirs and
     * answers as somebody else's.
     *
     * `/customer` is WP2's exact lookup by Telegram id, and joins them for both
     * reasons at once: registering it would advertise the panel, and a customer
     * reading «customer» in their own command menu would reasonably expect it to be
     * about them.
     *
     * `/admin` is matched through `ADMIN_MENU_COMMAND` rather than a literal, so it
     * does not appear in `parsed` at all; the assertion below covers it.
     */
    const ADMIN_ONLY = new Set(['link', 'role', 'service', 'customer']);
    const answered = parsed.filter((command) => !ADMIN_ONLY.has(command)).sort();

    expect([...BOT_COMMANDS].map((entry) => entry.command).sort()).toEqual(answered);

    /*
     * And the other half of the 5T rule: the panel's commands are registered NOWHERE.
     *
     * Asserted rather than assumed, because the failure would be invisible in exactly
     * the direction that matters — a `/admin` in the client's command menu is the
     * product telling every customer that a management panel exists, which is a fact
     * about the installation and not about them.
     */
    const registered = new Set([...BOT_COMMANDS].map((entry) => entry.command));
    for (const command of [
      ADMIN_MENU_COMMAND,
      'link',
      'role',
      'service',
      'customer',
      /*
       * WP5's three category commands. The underscore keeps them out of `parsed`
       * above (its pattern is `[a-z]+`), so they are named here directly: registering
       * any of them would advertise the management panel to every customer.
       */
      'category_new',
      'category_rename',
      'category_emoji',
    ]) {
      expect(registered.has(command as never), command).toBe(false);
    }
  });

  it('routes the admin keyboard label, because a keyboard tap arrives as text', () => {
    /*
     * The button was drawn and did nothing.
     *
     * `TelegramCustomerMessenger` appends `bot.menu.admin` to the keyboard for a bound
     * administrator, and a reply-keyboard tap reaches the bot as an ordinary TEXT
     * message — so unless the composition root maps that exact label to `/admin`,
     * `intentOf` answers `bot.unknown_command` and only typing the command works. The
     * keyboard's own comment in `bot-commands.ts` names this failure one constant over:
     * a label nothing routes is a button that tells the person the bot did not
     * understand.
     *
     * Read from the SOURCE of the composition root, for the reason the command list
     * above is: a constant here would be the thing that drifts.
     */
    const container = new URL('../../apps/api/src/container.ts', import.meta.url);
    const source = readFileSync(container, 'utf8');
    expect(source).toContain('CATALOGUE_FA[ADMIN_MENU_BUTTON.label]');
    expect(source).toContain('`/${ADMIN_MENU_COMMAND}`');
  });

  it('has a declared template key and a Persian description for every entry', () => {
    // A registered command with no description would be registered as an empty string,
    // which Telegram accepts and a customer reads as a blank menu row.
    for (const entry of BOT_COMMANDS) {
      expect(
        TEMPLATES.some((template) => template.key === entry.description),
        `${entry.command} names ${entry.description}, which the catalogue does not declare`,
      ).toBe(true);
      const text = CATALOGUE_FA[entry.description];
      expect(text, `${entry.command} has no Persian description`).toBeTruthy();
      // Telegram caps a command description at 256 characters.
      expect(text.length).toBeLessThanOrEqual(256);
    }
  });

  it('names only commands `bot.help` also lists, so the two cannot drift', () => {
    /*
     * The other direction. `/help` renders its own sentence rather than the list, so
     * this is what stops the sentence and the menu disagreeing — the exact failure mode
     * the audit found between the greeting and the four commands.
     */
    const help = CATALOGUE_FA['bot.help'];
    for (const entry of BOT_COMMANDS) {
      if (entry.command === 'start') continue; // /start is the entry point, not a listed action.
      expect(help, `bot.help does not mention /${entry.command}`).toContain(`/${entry.command}`);
    }
  });
});
