import { readFileSync } from 'node:fs';
import { stdin, stdout } from 'node:process';
import { isNexaError, type TenantContext } from '@nexa/contracts';
import type { BotBootstrapStatus } from './modules/platform/tenancy/application/bot-bootstrap.service.js';
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
 * shell history.
 *
 * For unattended installs there are two other sources, and the installer uses
 * `--bot-token-stdin` rather than `--bot-token-file`. The image runs as `node`
 * (uid 1000), and the file the documented flow tells an operator to create is
 * root-owned and mode 0600 — bind-mounted, it is unreadable inside the container
 * and the whole automation path fails with EACCES. `bootstrap-owner.cli.ts` has
 * always streamed the owner's password on stdin; not copying it was the mistake.
 * `--bot-token-file` remains for a file the container genuinely can read.
 *
 * Neither is the normal path and nothing here steers anyone towards them.
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
  /**
   * Read the token from stdin, to EOF.
   *
   * This is the path the INSTALLER uses, and `--bot-token-file` is not: the
   * release image runs as `node` (uid 1000), and a bind-mounted file the
   * operator created under `umask 077` is root-owned and mode 0600, so reading
   * it inside the container fails with EACCES. The documented unattended flow
   * could not work. `bootstrap-owner.cli.ts` has always streamed the owner's
   * password this way; not copying it was the mistake.
   *
   * `--bot-token-file` stays for the case it is actually good for — a file the
   * container CAN read, such as a Docker secret — and is never how the installer
   * reaches this process.
   */
  readonly tokenStdin: boolean;
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
  const args = {
    status: argv.includes('--status'),
    publicBaseUrl: get('--public-base-url'),
    tokenFile: get('--bot-token-file'),
    tokenStdin: argv.includes('--bot-token-stdin'),
    tenantSlug: get('--tenant'),
  };
  /*
   * Everything else is REFUSED, and this is the same rule as the missing-value
   * check above rather than tidiness.
   *
   * That check exists because `--tenant` followed by nothing fell through to the
   * primary tenant, so an operator aiming at one tenant configured another and
   * was told it had worked. `--tenent reseller` does exactly that and was not
   * caught: the parser took the flags it recognised and ignored the rest, so the
   * typo left `tenantSlug` null and the run reconciled the primary tenant's bot
   * and printed success.
   *
   * Positional values too. Nothing here takes one, so a bare word is either a
   * flag's value that a typo has orphaned or a misunderstanding of the command —
   * and both are better said out loud than acted on.
   */
  const consumed = new Set<number>();
  for (const flag of ['--public-base-url', '--bot-token-file', '--tenant'] as const) {
    const index = argv.indexOf(flag);
    if (index === -1) continue;
    consumed.add(index);
    consumed.add(index + 1);
  }
  for (const [index, argument] of argv.entries()) {
    if (consumed.has(index)) continue;
    if (argument === '--status' || argument === '--bot-token-stdin') continue;
    throw new PromptInputError(
      `Unrecognised argument "${argument}". This command takes --status, --public-base-url, ` +
        '--tenant, --bot-token-file and --bot-token-stdin, and nothing else. It is refused ' +
        'rather than ignored: a mistyped --tenant would otherwise fall through to the primary ' +
        "tenant and configure a different tenant's bot while reporting success.",
    );
  }
  // Two sources is not a preference to resolve, it is a caller that does not
  // know where its own credential is coming from.
  if (args.tokenFile !== null && args.tokenStdin) {
    throw new PromptInputError('Pass either --bot-token-file or --bot-token-stdin, not both.');
  }
  return args;
}

/**
 * The token the CALLER supplied, if any — never a prompt.
 *
 * Read whatever the state turns out to be, and that is the point. A rerun must
 * not ASK for a token (ADR-0029 decision 3), but an operator who explicitly
 * handed one over has not been asked: ignoring it silently is how a token for a
 * DIFFERENT bot slipped past the refusal that exists to catch it, and the
 * installer printed success having changed nothing.
 *
 * The service uses only the id half of a supplied token on a reconcile, and only
 * ever to refuse. The secret half never replaces a stored credential.
 */
export async function suppliedToken(args: Args): Promise<string | null> {
  if (args.tokenStdin) return readTokenFromStdin();
  if (args.tokenFile !== null) return tokenFromFile(args.tokenFile);
  return null;
}

/**
 * The token from stdin, read to EOF.
 *
 * To EOF rather than one line, so a file with no trailing newline and a file
 * with one both arrive whole; `trimToken` then removes exactly the trailing
 * newline an editor adds. Nothing is echoed and nothing is written anywhere.
 */
async function readTokenFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  const token = trimToken(Buffer.concat(chunks).toString('utf8'));
  if (token.trim() === '') {
    throw new PromptInputError('The bot token arrived empty on stdin.');
  }
  return token;
}

/**
 * Removes the trailing newline an editor adds, and nothing else.
 *
 * The rest is left exactly as written and the service does the shape check. A
 * reader that stripped more would silently "fix" a file whose content is wrong
 * in a way the operator can see.
 */
export function trimToken(raw: string): string {
  return raw.replace(/\r?\n$/, '');
}

/** A token read from a file the CONTAINER can read — a Docker secret, say. */
export function tokenFromFile(path: string): string {
  const token = trimToken(readFileSync(path, 'utf8'));
  if (token.trim() === '') {
    throw new PromptInputError(`The bot token file at ${path} is empty.`);
  }
  return token;
}

/**
 * The token this run uses: supplied, prompted for, or none.
 *
 * A pure decision with the prompt injected, because it is the ONE place two
 * rules meet and getting either wrong is silent.
 *
 *  - A rerun must not ASK. ADR-0029 decision 3: reconciliation is not a
 *    credential operation, and an installer that asked and then discarded the
 *    answer would be training operators to type a bearer credential into a
 *    prompt that does nothing with it.
 *  - A SUPPLIED token is not an answer to a question. It is read whatever the
 *    state and handed on, because the service needs it to REFUSE a token naming
 *    another bot — and because ignoring it silently is how such a token slipped
 *    past that refusal while the installer printed success.
 *
 * The service uses only the id half of a supplied token on a reconcile, and only
 * ever to refuse.
 */
export async function tokenForRun(
  supplied: string | null,
  state: BotBootstrapStatus,
  prompt: () => Promise<string>,
): Promise<string | null> {
  if (supplied !== null) return supplied;
  return state === 'none' ? prompt() : null;
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
      const { state, reason } = await container.bootstrapBot.statusWithReason(scope, publicBaseUrl);
      // The ONLY thing on stdout, so a shell can read it without parsing prose.
      // Every other line this CLI writes goes to stderr.
      process.stdout.write(`${state}\n`);
      /*
       * And WHY, on stderr, when there is a why (`OQ-TG-04` item 9).
       *
       * `unavailable` used to be the whole answer, while the service had already
       * computed which of three conditions produced it and thrown the sentence
       * away. The `--skip-telegram` text sends operators to this command to find
       * out, and skipping is precisely the path that avoids the `execute` call
       * that would have told them.
       *
       * Stderr keeps the stdout contract exactly as `docs/deployment.md`
       * documents it: a shell reading this still gets one word. A reason on
       * stdout would break every caller that compares it.
       */
      if (reason !== null) console.warn(reason);
      return;
    }

    const supplied = await suppliedToken(args);
    const state = await container.bootstrapBot.status(scope, publicBaseUrl);
    const token = await tokenForRun(supplied, state, promptForToken);

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
 * The interactive prompt, and the only path that ASKS.
 *
 * `Telegram Bot Token:`, not echoed — the same `Prompter.secret` the first
 * owner's password uses, which puts the terminal in raw mode.
 *
 * NOT typed twice. A password is typed blind and creates a row that cannot be
 * re-created; a token is PASTED, and `getMe` validates it against Telegram
 * before anything is written, so a mistyped one comes back with a specific
 * reason rather than being silently stored.
 */
async function promptForToken(): Promise<string> {
  if (stdin.isTTY !== true) {
    // Refused rather than read from the pipe. Reading an UNANNOUNCED pipe would
    // work exactly often enough to be relied on, and then read whatever else the
    // pipe happened to carry. `--bot-token-stdin` is how a caller says the pipe
    // is the token.
    throw new PromptInputError(
      'No terminal and no token supplied: there is no safe way to read the bot token. Pass ' +
        '--bot-token-stdin (piping the token in) or --bot-token-file, or run this from a terminal.',
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
