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
     * `/link` and `/role` — and the existence of an admin panel — to every customer of
     * every tenant. So these three are excluded here and asserted absent below, which
     * makes "not registered" a rule with a test rather than an omission.
     *
     * `/admin` is matched through `ADMIN_MENU_COMMAND` rather than a literal, so it
     * does not appear in `parsed` at all; the assertion below covers it.
     */
    const ADMIN_ONLY = new Set(['link', 'role']);
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
    for (const command of [ADMIN_MENU_COMMAND, 'link', 'role']) {
      expect(registered.has(command as never), command).toBe(false);
    }
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
