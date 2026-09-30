import { createHash } from 'node:crypto';
import {
  BOT_COMMANDS,
  type BotCommandEntry,
  type ScopeContext,
  type TemplateKey,
  type TemplateValues,
} from '@nexa/contracts';

export interface CommandMenuDeps {
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
  /** SHA-256 of the entries as sent, truncated to 32 hex characters. A change detector. */
  readonly hash: string;
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
        description: (await this.deps.templates.render(scope, entry.description, {}, tx))
          .trim()
          .slice(0, DESCRIPTION_MAX),
      })),
    );
    return { entries, hash: commandMenuHash(entries) };
  }
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
