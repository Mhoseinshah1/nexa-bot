import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { isNexaError, type TenantContext } from '@nexa/contracts';
import { readSecret } from './infrastructure/tty/read-secret.js';
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
}

function parseArgs(argv: readonly string[]): Args {
  const get = (flag: string): string | null => {
    const index = argv.indexOf(flag);
    if (index === -1) return null;
    return argv[index + 1] ?? null;
  };
  return {
    username: get('--username'),
    displayName: get('--display-name'),
    tenantSlug: get('--tenant'),
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

    // Readline first, and CLOSED before the password is read. It owns stdin
    // while it is open — in terminal mode it puts the tty in raw mode and
    // echoes what it receives — so reading the secret from the same stream
    // underneath it would have echoed the password after all.
    let username: string;
    let displayName: string;
    const rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY });
    try {
      username = args.username ?? (await rl.question('Owner username: '));
      displayName = args.displayName ?? (await rl.question('Display name: '));
    } finally {
      rl.close();
    }

    // Read straight from the terminal with echo off, never from argv. This
    // prompt used to say "(input is not hidden)" — accurately, since
    // `rl.question` echoes — directly beneath a comment claiming it was not
    // echoed back. The comment was the aspiration and the prompt was the truth;
    // now they agree, and a unit test holds them to it.
    const password = await readSecret(stdin, stdout, 'Password: ');

    const scope: TenantContext = { tenantId: tenant.id, botInstanceId: null };
    const result = await container.bootstrapOwner.execute(scope, {
      username,
      displayName,
      password,
    });

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
    else console.error(error);
    process.exitCode = 1;
  });
}
