import { IDENTITY_ERROR_CODES, isNexaError, type TenantContext } from '@nexa/contracts';
import { ZodError } from 'zod';
import { createContainer } from './container.js';
import { loadConfig } from './infrastructure/config/load-config.js';
import { ServerPasswordRecovery } from './modules/platform/identity/application/server-password-recovery.js';

/**
 * `botctl admin reset-password USERNAME` — owner recovery for a forgotten password.
 *
 * A CLI and never an endpoint, for the reason `admin:2fa-reset` is one: it has no caller
 * to authorize, so over HTTP it would be an unauthenticated route that sets a password.
 * Whoever can run this already holds the database credentials.
 *
 * The NEW PASSWORD arrives on STANDARD INPUT, one line, and nowhere else. An argument
 * would sit in `ps`, in the shell history and in the container's process listing; botctl
 * reads it from the terminal with echo off, asks twice, and pipes it here. Nothing in this
 * file prints it, and the messages that mention a failure never include it.
 *
 *   --username <name>   the administrator (required)
 *   --tenant <slug>     a tenant other than the primary one
 *
 * Output is Persian (it is read by the operator at a terminal): one line, success or the
 * reason. Exit 0 only when the password was written.
 */

export interface PasswordResetArgs {
  readonly username: string;
  readonly tenantSlug: string | null;
}

export class PasswordResetArgsError extends Error {}

/** Parsed strictly: an unknown flag is refused rather than silently ignored. */
export function parsePasswordResetArgs(argv: readonly string[]): PasswordResetArgs {
  const known = new Set(['--username', '--tenant']);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (!known.has(flag)) {
      throw new PasswordResetArgsError(
        'آرگومان ناشناخته. شکل درست: --username <نام‌کاربری> [--tenant <slug>]',
      );
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new PasswordResetArgsError(`${flag} به یک مقدار نیاز دارد.`);
    }
    values.set(flag, value);
    index += 1;
  }
  const username = values.get('--username');
  if (username === undefined) throw new PasswordResetArgsError('--username الزامی است.');
  return { username, tenantSlug: values.get('--tenant') ?? null };
}

/** One line from standard input, without its line ending. Refuses a terminal. */
export async function readPasswordFromStdin(
  stream: NodeJS.ReadableStream & { readonly isTTY?: boolean } = process.stdin,
): Promise<string> {
  if (stream.isTTY) {
    throw new PasswordResetArgsError(
      'رمز عبور باید از ورودی استاندارد برسد؛ این دستور را با «botctl admin reset-password» اجرا کنید.',
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  const password = Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
  if (password === '') throw new PasswordResetArgsError('رمز عبور خالی است.');
  return password;
}

async function main(): Promise<void> {
  const args = parsePasswordResetArgs(process.argv.slice(2));
  // Read BEFORE the container exists, so an empty or missing password never opens a
  // database connection.
  const password = await readPasswordFromStdin();
  const config = loadConfig();
  const container = createContainer(config, 'worker');
  try {
    const tenant =
      args.tenantSlug === null
        ? await container.tenants.findPrimary()
        : await container.tenants.findBySlug(args.tenantSlug);
    if (tenant === null) {
      throw new PasswordResetArgsError(
        args.tenantSlug === null
          ? 'هیچ tenant اصلی‌ای وجود ندارد.'
          : `tenantی با slug «${args.tenantSlug}» وجود ندارد.`,
      );
    }
    const scope: TenantContext = { tenantId: tenant.id, botInstanceId: null };
    const recovery = new ServerPasswordRecovery({
      uow: container.uow,
      admins: container.admins,
      sessions: container.sessions,
      throttle: container.loginThrottle,
      hasher: container.hasher,
      audit: container.audit,
      opsLog: container.opsLog,
      clock: container.clock,
      ids: container.ids,
    });
    const result = await recovery.resetPasswordFromServer(scope, {
      username: args.username,
      password,
    });
    console.warn(
      `رمز عبور «${args.username.trim().toLowerCase()}» تغییر کرد؛ ${String(result.endedSignIns)} نشست پایان یافت و شمارندهٔ ورود ناموفق پاک شد. اکنون با رمز جدید وارد شوید.`,
    );
  } finally {
    await container.shutdown();
  }
}

/** The operator-facing reason, never the password and never a stack. */
export function describeFailure(error: unknown): string {
  if (error instanceof PasswordResetArgsError) return error.message;
  if (error instanceof ZodError) {
    return 'نام کاربری یا رمز عبور مطابق سیاست نیست (رمز دست‌کم ۱۲ نویسه؛ نام‌کاربری فقط حروف کوچک، رقم، نقطه، خط تیره و زیرخط).';
  }
  if (isNexaError(error)) {
    return error.code === IDENTITY_ERROR_CODES.ADMIN_NOT_FOUND
      ? 'چنین مدیری وجود ندارد.'
      : `ناموفق: ${error.code}`;
  }
  return 'خطای پایگاه داده یا سیستم؛ رمز تغییر نکرد. «botctl logs api» را ببینید.';
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error: unknown) => {
    console.error(describeFailure(error));
    // The raw error to the debug stream only when asked; a driver error can echo a query.
    if (process.env['NEXA_DEBUG_CLI'] === '1') console.error(error);
    process.exitCode = 1;
  });
}
