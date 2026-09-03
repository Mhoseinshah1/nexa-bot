import { stdin, stdout } from 'node:process';
import { isNexaError, type TenantContext } from '@nexa/contracts';
import { Prompter, PromptInputError } from './infrastructure/tty/prompt.js';
import {
  checkOwnerDisplayName,
  checkOwnerPassword,
  checkOwnerUsername,
} from './infrastructure/tty/owner-input.js';
import { createContainer } from './container.js';
import { loadConfig } from './infrastructure/config/load-config.js';

/**
 * `pnpm admin:bootstrap` — create the installation's first owner.
 *
 * This is the ONLY entry point to `BootstrapOwnerService`. It is a CLI rather
 * than an endpoint on purpose: the operation has no caller to authorize, so
 * exposing it over HTTP would mean an unauthenticated route that creates an
 * owner. Whoever runs this already holds the database credentials, and the
 * service refuses outright once any administrator exists.
 *
 * The password is read from stdin, never from a command-line argument: argv is
 * visible in `ps` to every user on the machine and lands in shell history.
 */

interface Args {
  readonly username: string | null;
  readonly displayName: string | null;
  readonly tenantSlug: string | null;
  /**
   * Report whether this installation still needs a first owner, and create
   * nothing.
   *
   * The installer needs this because the owner is committed several steps
   * before the release manifest and `current` pointer are written. On a real
   * Ubuntu 24.04 staging host the install stopped in exactly that gap: the
   * owner existed, the stack was healthy, and `botctl version` reported "no
   * current release is recorded" for good, because a rerun reached this CLI
   * again and was refused — correctly — with BOOTSTRAP_ALREADY_DONE.
   *
   * Read-only, and it does NOT relax the fence in `BootstrapOwnerService`. It
   * answers a different question: not "is there an administrator" but "did this
   * installation's own bootstrap create them", which is the only version of the
   * question an installer may act on.
   */
  readonly status: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (flag: string): string | null => {
    const index = argv.indexOf(flag);
    if (index === -1) return null;
    const value = argv[index + 1];
    // A flag with no value is not the same as no flag.
    //
    // Returning null for both meant `--tenant` with nothing after it fell
    // through to `findPrimary()`, so an operator who explicitly aimed at one
    // tenant could create the installation's owner in a different one — and be
    // told it had worked. Refused instead.
    if (value === undefined || value.startsWith('--')) {
      throw new PromptInputError(`${flag} needs a value.`);
    }
    return value;
  };
  return {
    username: get('--username'),
    displayName: get('--display-name'),
    tenantSlug: get('--tenant'),
    status: argv.includes('--status'),
  };
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
          ? 'No primary tenant exists yet. Provision one before creating its owner.'
          : `No tenant with slug "${args.tenantSlug}".`,
      );
    }

    if (args.status) {
      // The ONLY thing on stdout, so a shell can read it without parsing prose.
      // Every other line this CLI writes goes to stderr.
      const scope: TenantContext = { tenantId: tenant.id, botInstanceId: null };
      process.stdout.write(`${await container.bootstrapOwner.status(scope)}\n`);
      return;
    }

    // ONE reader for all three questions. Mixing `readline` with a direct read
    // of the same stdin is what silently swallowed the password on a pipe and
    // exited 0 having created nothing — see `Prompter`.
    const prompt = new Prompter(stdin, stdout);
    let result;
    try {
      // Checked as each answer arrives, not all three at the end. A bad
      // username is worth knowing before typing a password twice, and the
      // password is worth rejecting before the confirmation rather than after.
      const username = checkOwnerUsername(args.username ?? (await prompt.line('Owner username: ')));
      const displayName = checkOwnerDisplayName(
        args.displayName ?? (await prompt.line('Display name: ')),
      );

      // Never echoed, and never taken from argv. This prompt used to say
      // "(input is not hidden)" — accurately, since `rl.question` echoes —
      // directly beneath a comment claiming it was not echoed back. The comment
      // was the aspiration and the prompt was the truth; now they agree, and
      // unit tests hold them to it.
      const password = checkOwnerPassword(await prompt.secret('Password: '));

      // Typed twice, because it is typed BLIND.
      //
      // Hiding the echo removed the operator's only way to notice a typo, and
      // this creates the installation's single owner: bootstrap refuses to run
      // again once that row exists, and there is no other account to rotate the
      // password from, so a mistyped one means editing the database by hand.
      // Only on a terminal — a piped password was not typed, and asking a
      // script to supply it twice buys nothing.
      if (stdin.isTTY === true) {
        const again = await prompt.secret('Confirm password: ');
        if (again !== password) {
          throw new PromptInputError('The passwords did not match. Nothing was created.');
        }
      }

      // Restored BEFORE the owner is written, not just afterwards.
      //
      // While stdin is in raw mode the tty driver does not turn Ctrl+C into
      // SIGINT — it arrives as a byte — and with no question pending the reader
      // has nothing to deliver it to. An installer who submitted the
      // confirmation and then tried to abort during the hash and the insert
      // would have had that cancellation silently ignored, and the owner
      // created anyway. Nothing more is read after this point, so there is no
      // reason to still hold the terminal; the `finally` stays as a fallback
      // for the paths that throw before reaching here.
      prompt.close();

      const scope: TenantContext = { tenantId: tenant.id, botInstanceId: null };
      result = await container.bootstrapOwner.execute(scope, {
        username,
        displayName,
        password,
      });
    } finally {
      // Leaving stdin in raw mode would hand the operator back a shell with no
      // echo and no line editing.
      prompt.close();
    }

    console.warn(
      `Owner "${result.username}" created for tenant "${tenant.slug}" (${result.adminId}).`,
    );
  } finally {
    await container.shutdown();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error: unknown) => {
    // A NexaError's message is written for an operator; anything else is a bug
    // and keeps its stack.
    if (isNexaError(error)) console.error(`${error.code}: ${error.message}`);
    // A truncated or empty input is the operator's mistake, not a bug, and one
    // clear line serves them better than a stack.
    else if (error instanceof PromptInputError) console.error(error.message);
    else console.error(error);
    process.exitCode = 1;
  });
}
