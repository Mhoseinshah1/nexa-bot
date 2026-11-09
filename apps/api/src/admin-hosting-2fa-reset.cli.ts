import { isNexaError, type TenantContext } from '@nexa/contracts';
import { createContainer } from './container.js';
import { loadConfig } from './infrastructure/config/load-config.js';
import { DrizzleHostingRepository } from './modules/platform/hosting/infrastructure/drizzle-hosting.repository.js';
import { ServerHostingFactorRecovery } from './modules/platform/hosting/application/server-hosting-factor-recovery.js';

/**
 * `botctl admin reset-hosting-2fa` — owner recovery for a lost «میزبانی‌ها» section
 * factor (the creator panel's own TOTP, not the Web Admin sign-in factor: that one is
 * `admin:2fa-reset`).
 *
 * A CLI and never an endpoint, for the reason `admin:2fa-reset` is one. It removes the
 * section's factor, its recovery codes and the section sessions, and records
 * `hosting.totp_reset` (actor `SYSTEM_JOB`, with the REASON the operator gave) in the
 * installation's audit log. It never touches the password, the sign-in factor or the
 * Web Admin sessions. Always the installation (primary) tenant: the section exists nowhere else.
 *
 *   --username <name>   the installation owner (required)
 *   --reason <text>     why, recorded in the audit row (required)
 */

export interface HostingResetArgs {
  readonly username: string;
  readonly reason: string;
}

export class HostingResetArgsError extends Error {}

/** Parsed strictly: an unknown flag is refused rather than silently ignored. */
export function parseHostingResetArgs(argv: readonly string[]): HostingResetArgs {
  const known = new Set(['--username', '--reason']);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (!known.has(flag)) {
      throw new HostingResetArgsError(
        `Unknown argument (${String(index + 1)} of ${String(argv.length)}). Usage: --username <name> --reason <text>`,
      );
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new HostingResetArgsError(`${flag} needs a value.`);
    }
    values.set(flag, value);
    index += 1;
  }
  const username = values.get('--username');
  if (username === undefined) throw new HostingResetArgsError('--username is required.');
  const reason = values.get('--reason');
  if (reason === undefined || reason.trim() === '') {
    throw new HostingResetArgsError('--reason is required: it is recorded in the audit log.');
  }
  return { username, reason };
}

async function main(): Promise<void> {
  const args = parseHostingResetArgs(process.argv.slice(2));
  const config = loadConfig();
  const container = createContainer(config, 'worker', { connection: 'owner' });
  try {
    const tenant = await container.tenants.findPrimary();
    if (tenant === null) throw new HostingResetArgsError('No primary tenant exists.');
    const installation: TenantContext = { tenantId: tenant.id, botInstanceId: null };
    // Built HERE and nowhere else: the container does not carry it, so no surface can.
    const recovery = new ServerHostingFactorRecovery({
      uow: container.uow,
      repository: new DrizzleHostingRepository(container.database.db),
      admins: container.admins,
      audit: container.audit,
      clock: container.clock,
      ids: container.ids,
    });
    const result = await recovery.resetFromServer(installation, args);
    console.warn(
      result.hadFactor
        ? `Hosting-section two-step removed for "${args.username.trim().toLowerCase()}"; ${String(result.recoveryCodesRemoved)} recovery code(s) removed, ${String(result.endedSectionSessions)} section session(s) ended. They enrol a new device in the section.`
        : `"${args.username.trim().toLowerCase()}" had no hosting-section two-step; ${String(result.endedSectionSessions)} section session(s) ended. Recorded in the audit log.`,
    );
  } finally {
    await container.shutdown();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error: unknown) => {
    if (isNexaError(error)) console.error(`${error.code}: ${error.message}`);
    else if (error instanceof HostingResetArgsError) console.error(error.message);
    else console.error(error);
    process.exitCode = 1;
  });
}
