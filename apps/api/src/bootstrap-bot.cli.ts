import { readFileSync } from 'node:fs';
import { stdin, stdout } from 'node:process';
import { isNexaError, type TenantContext } from '@nexa/contracts';
import { Prompter, PromptInputError } from './infrastructure/tty/prompt.js';
import { createContainer } from './container.js';
import { loadConfig } from './infrastructure/config/load-config.js';

/**
 * The fresh install's Telegram step — the one that asks for the bot token.
 *
 * A CLI rather than an endpoint, for the reason `bootstrap-owner.cli.ts` gives
 * about the owner's password and one more besides: this accepts a BEARER
 * CREDENTIAL for the installation's bot and decides where Telegram delivers its
 * updates. Over HTTP that would be an unauthenticated route that can repoint an
 * installation. `scripts/check-boundaries.sh` has its own check for it.
 *
 * The token is read from a terminal with no echo, and never from argv: argv is
 * readable by every user on the machine through `ps` and lands in the operator's
 * shell history. `--bot-token-file` exists for unattended installs the way
 * `--owner-password-file` does; it is not the normal path and nothing here
 * steers anyone towards it.
 */

interface Args {
  /**
   * Report what this installation's Telegram bootstrap still needs, and change
   * nothing.
   *
   * The installer calls this BEFORE it decides whether to prompt. That is the
   * whole mechanism behind "a rerun never asks for the token again": the
   * question is answered from the database, not from whether a previous run
   * left a file behind.
   */
  readonly status: boolean;
  readonly publicBaseUrl: string | null;
  readonly tokenFile: string | null;
  readonly tenantSlug: string | null;
}

export function parseArgs(argv: readonly string[]): Args {
  const get = (flag: string): string | null => {
    const index = argv.indexOf(flag);
    if (index === -1) return null;
    const value = argv[index + 1];
    // A flag with no value is not the same as no flag — the lesson
    // `bootstrap-owner.cli.ts` records about `--tenant`, which fell through to
    // the primary tenant and reported success for the wrong one.
    if (value === undefined || value.startsWith('--')) {
      throw new PromptInputError(`${flag} needs a value.`);
    }
    return value;
  };
  // Refused rather than ignored. An operator who passes `--bot-token` expects
  // it to be used, and silently prompting instead is confusing; silently USING
  // it would put the credential in `ps` and in shell history.
  if (argv.some((argument) => argument === '--bot-token' || argument.startsWith('--bot-token='))) {
    throw new PromptInputError(
      'The bot token is never taken from a command line: argv is readable by every user on this ' +
        'machine through `ps`, and it lands in shell history. Run this without the flag and it ' +
        'will ask, or pass --bot-token-file for an unattended install.',
    );
  }
  return {
    status: argv.includes('--status'),
    publicBaseUrl: get('--public-base-url'),
    tokenFile: get('--bot-token-file'),
    tenantSlug: get('--tenant'),
  };
}

/**
 * A token read from a file, with the trailing newline every editor adds removed.
 *
 * Only the trailing newline: the rest is left exactly as written, and the
 * service does the shape check. A reader that stripped more would silently
 * "fix" a file whose content is wrong in a way the operator can see.
 */
export function tokenFromFile(path: string): string {
  const raw = readFileSync(path, 'utf8');
  const token = raw.replace(/\r?\n$/, '');
  if (token.trim() === '') {
    throw new PromptInputError(`The bot token file at ${path} is empty.`);
  }
  return token;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const container = createContainer(config, 'worker');

  try {
    const tenant =
      args.tenantSlug === null
        ? await container.tenants.findPrimary()
        : await container.tenants.findBySlug(args.tenantSlug);

    if (tenant === null) {
      throw new Error(
        args.tenantSlug === null
          ? 'No primary tenant exists yet. Provision one before configuring its bot.'
          : `No tenant with slug "${args.tenantSlug}".`,
      );
    }

    const scope: TenantContext = { tenantId: tenant.id, botInstanceId: null };
    const publicBaseUrl = requirePublicBaseUrl(args.publicBaseUrl);

    if (args.status) {
      // The ONLY thing on stdout, so a shell can read it without parsing prose.
      // Every other line this CLI writes goes to stderr.
      process.stdout.write(`${await container.bootstrapBot.status(scope, publicBaseUrl)}\n`);
      return;
    }

    /*
     * Asked ONLY when there is no bot instance yet.
     *
     * This is ADR-0029 decision 3 in one branch: a rerun is reconciliation, not
     * a credential operation, so it must not so much as ask. An installer that
     * asked anyway and then discarded the answer would be training operators to
     * type a bearer credential into a prompt that does nothing with it.
     */
    const needsToken = (await container.bootstrapBot.status(scope, publicBaseUrl)) === 'none';
    const token = needsToken ? await readToken(args.tokenFile) : null;

    const result = await container.bootstrapBot.execute(scope, { token, publicBaseUrl });

    switch (result.kind) {
      case 'CREATED':
        console.warn(
          `Telegram bot @${result.username} (${result.telegramBotId}) configured for tenant ` +
            `"${tenant.slug}". Updates will arrive at ${result.webhookUrl}.`,
        );
        break;
      case 'RECONCILED':
        console.warn(
          `Telegram webhook registered for @${result.username} at ${result.webhookUrl}.`,
        );
        break;
      case 'ALREADY_COMPLETE':
        console.warn(
          `Telegram bot @${result.username} is already configured and receiving updates at ` +
            `${result.webhookUrl}. Nothing was changed.`,
        );
        break;
    }
  } finally {
    await container.shutdown();
  }
}

/**
 * The token, from a terminal or from a file, and from nowhere else.
 *
 * The prompt is `Telegram Bot Token:` and the input is not echoed — the same
 * `Prompter.secret` the first owner's password uses, which puts the terminal in
 * raw mode.
 *
 * NOT typed twice. A password is typed blind and creates a row that cannot be
 * re-created; a token is PASTED, and `getMe` validates it against Telegram
 * before anything is written, so a mistyped one comes back with a specific
 * reason rather than being silently stored.
 */
async function readToken(tokenFile: string | null): Promise<string> {
  if (tokenFile !== null) return tokenFromFile(tokenFile);

  if (stdin.isTTY !== true) {
    // Refused rather than read from the pipe. A piped stdin here is an
    // unattended install that forgot the flag, and reading it would work
    // exactly often enough to be relied on — and then read whatever else the
    // pipe happened to carry.
    throw new PromptInputError(
      'No terminal and no --bot-token-file: there is no safe way to read the bot token. Pass ' +
        '--bot-token-file, or run this from a terminal.',
    );
  }

  const prompt = new Prompter(stdin, stdout);
  try {
    return await prompt.secret('Telegram Bot Token: ');
  } finally {
    // Leaving stdin in raw mode hands the operator back a shell with no echo
    // and no line editing.
    prompt.close();
  }
}

/**
 * The installation's public origin, which the installer knows and the
 * application deliberately does not.
 *
 * NOT derived from `WEB_ADMIN_ORIGINS`. That value is the CSRF origin for the
 * admin session and it is a list; making it mean "and also where Telegram
 * should deliver" would tie two unrelated decisions together, so that adding a
 * second admin origin would silently change which one a webhook is registered
 * against. The service validates the shape.
 */
function requirePublicBaseUrl(supplied: string | null): string {
  if (supplied === null || supplied.trim() === '') {
    throw new PromptInputError(
      '--public-base-url is required: the webhook URL Telegram is given must be the origin this ' +
        'installation actually answers on, for example https://bot.example.com.',
    );
  }
  return supplied;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error: unknown) => {
    // A NexaError's message is written for an operator; anything else is a bug
    // and keeps its stack.
    if (isNexaError(error)) console.error(`${error.code}: ${error.message}`);
    else if (error instanceof PromptInputError) console.error(error.message);
    else console.error(error);
    // Non-zero, always. ADR-0029 decision 4: an installation whose bot cannot
    // receive updates is not a completed installation, and the row surviving is
    // what makes the rerun cheap — not a reason to call this a success.
    process.exitCode = 1;
  });
}
