import { isNexaError, type AdminId, type TenantContext } from '@nexa/contracts';
import { createContainer } from './container.js';
import { loadConfig } from './infrastructure/config/load-config.js';

/**
 * `pnpm admin:2fa-reset` — owner recovery for two-step sign-in (Phase D2).
 *
 * The documented way back for an administrator — typically the only owner — who has
 * lost both their authenticator and their backup codes. `docs/deployment.md` ("Owner
 * recovery: two-step sign-in") is the runbook; `botctl admin reset-2fa` is the installed
 * entry point.
 *
 * A CLI and never an endpoint, for the reason `admin:bootstrap` is one: it has no caller
 * to authorize, so over HTTP it would be an unauthenticated route that strips a second
 * factor. Whoever can run this already holds the database credentials.
 *
 * It does as little as recovery needs and nothing more:
 *
 *   - removes the administrator's second factor and every backup code;
 *   - ends every session they hold;
 *   - records an audit row (`admin.totp_reset`, actor `SYSTEM_JOB`, with the REASON the
 *     operator gave) and a WARN on the alerts page (`admin.second_factor_reset`).
 *
 * It never sets a password and never creates a session: the person recovering still
 * needs the password to sign in, and enrols a new device afterwards. Nothing secret is
 * read or printed — the username and the reason are both arguments, and both are
 * ordinary text.
 *
 *   --username <name>   the administrator (required)
 *   --reason <text>     why, recorded in the audit row (required, unless --check)
 *   --tenant <slug>     a tenant other than the primary one
 *   --check             read-only: print `on`, `pending` or `off` and change nothing
 */

export interface ResetArgs {
  readonly username: string;
  readonly reason: string | null;
  readonly tenantSlug: string | null;
  readonly check: boolean;
}

export class ResetArgsError extends Error {}

/** Parsed strictly: an unknown flag is refused rather than silently ignored. */
export function parseResetArgs(argv: readonly string[]): ResetArgs {
  const known = new Set(['--username', '--reason', '--tenant', '--check']);
  const values = new Map<string, string>();
  let check = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (!known.has(flag)) {
      throw new ResetArgsError(
        `Unknown argument (${String(index + 1)} of ${String(argv.length)}). Usage: --username <name> --reason <text> [--tenant <slug>] [--check]`,
      );
    }
    if (flag === '--check') {
      check = true;
      continue;
    }
    const value = argv[index + 1];
    // A flag with no value is not the same as no flag (the bootstrap CLI's rule).
    if (value === undefined || value.startsWith('--')) {
      throw new ResetArgsError(`${flag} needs a value.`);
    }
    values.set(flag, value);
    index += 1;
  }
  const username = values.get('--username');
  if (username === undefined) throw new ResetArgsError('--username is required.');
  const reason = values.get('--reason') ?? null;
  if (!check && (reason === null || reason.trim() === '')) {
    throw new ResetArgsError('--reason is required: it is recorded in the audit log.');
  }
  return { username, reason, tenantSlug: values.get('--tenant') ?? null, check };
}

async function main(): Promise<void> {
  const args = parseResetArgs(process.argv.slice(2));
  const config = loadConfig();
  const container = createContainer(config, 'worker');
  try {
    const tenant =
      args.tenantSlug === null
        ? await container.tenants.findPrimary()
        : await container.tenants.findBySlug(args.tenantSlug);
    if (tenant === null) {
      throw new ResetArgsError(
        args.tenantSlug === null
          ? 'No primary tenant exists.'
          : `No tenant with slug "${args.tenantSlug}".`,
      );
    }
    const scope: TenantContext = { tenantId: tenant.id, botInstanceId: null };

    if (args.check) {
      const admin = await container.admins.findByUsername(
        scope,
        args.username.trim().toLowerCase(),
      );
      if (admin === null) throw new ResetArgsError('No such administrator.');
      const factor = await container.secondFactors.findFactor(scope, admin.id as AdminId);
      // The ONLY line on stdout, so a shell can read it.
      process.stdout.write(
        `${factor === null ? 'off' : factor.state === 'ACTIVE' ? 'on' : 'pending'}\n`,
      );
      return;
    }

    const result = await container.accountSecurity.resetFromServer(scope, {
      username: args.username,
      reason: args.reason ?? '',
    });
    console.warn(
      result.hadSecondFactor
        ? `Two-step sign-in removed for "${args.username.trim().toLowerCase()}"; ${String(result.endedSignIns)} session(s) ended. They sign in with their password and can enrol a new device.`
        : `"${args.username.trim().toLowerCase()}" had no two-step sign-in; ${String(result.endedSignIns)} session(s) ended. Recorded in the audit log.`,
    );
  } finally {
    await container.shutdown();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error: unknown) => {
    if (isNexaError(error)) console.error(`${error.code}: ${error.message}`);
    else if (error instanceof ResetArgsError) console.error(error.message);
    else console.error(error);
    process.exitCode = 1;
  });
}
