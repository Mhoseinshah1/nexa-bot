import { createHash } from 'node:crypto';
import {
  BOT_COMMANDS,
  type BotCommandEntry,
  type ScopeContext,
  type TemplateKey,
  type TemplateValues,
} from '@nexa/contracts';

/**
 * Round 9, C5: the mini app's chat menu button a tenant wants — its text and the public
 * origin it is served from — or null: the `mini_app` flag is off, or no public origin is
 * known yet. Read per tenant; the URL adds the bot (`<origin>/miniapp/<botId>/`).
 */
export interface MiniAppButtonSource {
  buttonFor(
    scope: ScopeContext,
    tx?: unknown,
  ): Promise<{ readonly text: string; readonly origin: string } | null>;
}

export interface CommandMenuDeps {
  /** Round 9, C5. Absent: no menu button is ever wanted (the lane as it always was). */
  readonly miniApp?: MiniAppButtonSource;
  /**
   * The tenant's own rendering — the resolver every customer message goes through, in the
   * default locale, through the caller's transaction when it has one.
   */
  readonly templates: {
    render(
      scope: ScopeContext,
      key: TemplateKey,
      values: TemplateValues,
      tx?: unknown,
    ): Promise<string>;
  };
}

/** The menu a tenant wants registered, and its digest. */
export interface DesiredCommandMenu {
  readonly entries: readonly BotCommandEntry[];
  /**
   * SHA-256 of the entries as sent, truncated to 32 hex characters. A change detector.
   * With the mini app's button wanted it is `m` + 31 hex of the entries AND the button, so a
   * stored revision says whether a button was set — which is what lets switching the flag
   * off reset it, and only then. With no button it is exactly the old digest: a tenant with
   * the flag off re-registers nothing on upgrade, and Telegram is asked nothing new.
   */
  readonly hash: string;
  /** The mini app's button, or null for none (and Telegram's default). */
  readonly menuButton: { readonly text: string; readonly origin: string } | null;
}

/** Whether a stored `commands_revision` was registered WITH the mini app's menu button. */
export function revisionHasMiniAppButton(revision: string | null): boolean {
  return revision !== null && revision.startsWith('m');
}

/** The mini app's address for one bot, under the tenant's public origin. */
export function miniAppUrl(origin: string, botId: string): string {
  return `${origin}/miniapp/${botId}/`;
}

/** Telegram's cap on a command description (Bot API, `BotCommand.description`: 1-256 chars). */
const DESCRIPTION_MAX = 256;

/**
 * The ONE answer to "what slash-command menu does this tenant want" (round P).
 *
 * `BOT_COMMANDS` is the customer scope — every command the runtime answers for a customer
 * and nothing else; the management panel's commands are `ADMIN_ONLY_COMMANDS` and never
 * reach here — and each description is the tenant's own `bot.command.*` text, rendered by
 * the resolver every customer message goes through. So an operator's rewording reaches
 * Telegram, and the installer's reconcile, the worker's lane and the Web Admin's state all
 * compare against the same digest.
 *
 * The digest recipe is the one the bootstrap gateway used before round P, over the same
 * shape, so an installation that never reworded a description upgrades with its stored
 * `commands_revision` still equal to the desired hash: no re-registration for nothing.
 * Truncated to 32 hex characters because it is a change detector stored in a column an
 * operator may read, not a security boundary.
 */
export class CommandMenu {
  constructor(private readonly deps: CommandMenuDeps) {}

  async desiredFor(scope: ScopeContext, tx?: unknown): Promise<DesiredCommandMenu> {
    const entries = await Promise.all(
      BOT_COMMANDS.map(async (entry) => ({
        command: entry.command,
        description: boundDescription(
          (await this.deps.templates.render(scope, entry.description, {}, tx)).trim(),
        ),
      })),
    );
    const base = commandMenuHash(entries);
    const menuButton = (await this.deps.miniApp?.buttonFor(scope, tx)) ?? null;
    if (menuButton === null) return { entries, hash: base, menuButton: null };
    const hash = `m${createHash('sha256')
      .update(`${base}|miniapp|${menuButton.origin}|${menuButton.text}`)
      .digest('hex')
      .slice(0, 31)}`;
    return { entries, hash, menuButton };
  }
}

/**
 * A description within Telegram's 256, cut so it never ends in half a surrogate pair.
 *
 * `slice(0, 256)` counts UTF-16 code units; an emoji straddling the cut would leave a lone
 * high surrogate that Telegram refuses, digested and re-sent for ever (Codex #5). The
 * bound is still code units, because that is what the Bot API counts, so a text of at
 * most 256 units is untouched and a longer one loses at most one unit more than the cut.
 */
export function boundDescription(text: string): string {
  if (text.length <= DESCRIPTION_MAX) return text;
  const last = text.charCodeAt(DESCRIPTION_MAX - 1);
  const cut = last >= 0xd800 && last <= 0xdbff ? DESCRIPTION_MAX - 1 : DESCRIPTION_MAX;
  return text.slice(0, cut);
}

/** The digest of a command list exactly as it is sent. Pure. */
export function commandMenuHash(entries: readonly BotCommandEntry[]): string {
  return createHash('sha256')
    .update(JSON.stringify(entries.map(({ command, description }) => ({ command, description }))))
    .digest('hex')
    .slice(0, 32);
}

/** Whether two lists are the same menu: same commands, same descriptions, same order. */
export function sameCommandMenu(
  a: readonly BotCommandEntry[],
  b: readonly BotCommandEntry[],
): boolean {
  return commandMenuHash(a) === commandMenuHash(b);
}
