import { CALENDARS, CURRENCY_CODES, NexaError, PLATFORM_ERROR_CODES } from '@nexa/contracts';
import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { createDatabase } from './infrastructure/persistence/database.js';
import { tenants } from './infrastructure/persistence/schema.js';

/**
 * `provision-installation` — create the installation's primary tenant.
 *
 * The gap this closes was real and it stopped a fresh production install dead.
 * `bootstrap-owner` creates an owner FOR a tenant and refuses when there is
 * none; the only code in the repository that had ever created a tenant was the
 * development seed, which inserts two fictional stores and two fake bot tokens.
 * So a correctly migrated production database had nowhere to put an owner, and
 * the only way forward was to seed development fixtures into it.
 *
 * A separate CLI rather than an extension of `bootstrap-owner`, because they
 * answer different questions and have different idempotency: provisioning the
 * installation is a fact about the deployment, and creating its first owner is
 * a credential-handling operation that must never run twice.
 *
 * IDEMPOTENT ON PURPOSE. The installer may be rerun after a failure at any
 * later step, so meeting an already-provisioned installation is a success and
 * says so. It never modifies an existing tenant: a rerun that quietly renamed
 * the installation would be a rerun that changed what customers see.
 *
 * Reads DATABASE_URL and nothing else, exactly like the migration runner and
 * for the same reason — this runs before the application has ever booted, in a
 * context that legitimately holds no application secrets.
 */

export interface ProvisionInput {
  readonly slug: string;
  readonly displayName: string;
  readonly locale: string;
  readonly timezone: string;
  readonly calendar: string;
  readonly currency: string;
}

export interface ProvisionResult {
  readonly tenantId: string;
  readonly slug: string;
  /** False when a primary tenant already existed; nothing was written. */
  readonly created: boolean;
}

/**
 * A slug is part of an operator-facing identity and reaches a unique index.
 *
 * Restricted rather than sanitised: silently rewriting somebody's input to
 * something that fits is how an installation ends up with a name nobody chose.
 */
/**
 * The advisory-lock key for "provisioning this installation's primary tenant".
 *
 * An arbitrary constant, chosen once and never derived from input, so two
 * installers agree on it without coordinating. PostgreSQL advisory locks share
 * one namespace per database, so the value only has to be distinct from any
 * other advisory lock this application takes — it takes no others today, and
 * this comment is where the next one gets registered.
 */
const PROVISION_LOCK_KEY = 0x6e78_6131;

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function validateProvisionInput(input: ProvisionInput): void {
  const problems: string[] = [];

  if (!SLUG_PATTERN.test(input.slug)) {
    problems.push(
      `slug "${input.slug}" must be 1-63 characters of lowercase letters, digits and hyphens, ` +
        'starting and ending with a letter or digit.',
    );
  }
  if (input.displayName.trim().length === 0) problems.push('display name must not be empty.');
  if (input.displayName.length > 200) problems.push('display name must be at most 200 characters.');
  // Checked here rather than left to the CHECK constraint, so a typo is one
  // clear sentence instead of a Postgres constraint violation.
  if (!(CALENDARS as readonly string[]).includes(input.calendar)) {
    problems.push(`calendar must be one of ${CALENDARS.join(', ')}; got "${input.calendar}".`);
  }
  if (!(CURRENCY_CODES as readonly string[]).includes(input.currency)) {
    problems.push(`currency must be one of ${CURRENCY_CODES.join(', ')}; got "${input.currency}".`);
  }
  // A timezone the platform cannot resolve renders every date wrongly for every
  // administrator, and does it silently.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: input.timezone });
  } catch {
    problems.push(`"${input.timezone}" is not an IANA time zone, such as Asia/Tehran.`);
  }
  if (input.locale.trim().length === 0) problems.push('locale must not be empty.');

  if (problems.length > 0) {
    throw new NexaError({
      kind: 'CONFIGURATION',
      code: PLATFORM_ERROR_CODES.CONFIG_INVALID,
      message: `Cannot provision the installation:\n  - ${problems.join('\n  - ')}`,
    });
  }
}

export async function provisionInstallation(
  databaseUrl: string,
  input: ProvisionInput,
): Promise<ProvisionResult> {
  validateProvisionInput(input);

  const handle = createDatabase(databaseUrl, 1);
  try {
    // Two mechanisms, and they answer different questions.
    //
    // The partial unique index `tenants_single_primary_key` is the TRUTH: at
    // most one row may have kind = 'PRIMARY', whatever writes it and however
    // many writers there are. That is the installation's defining invariant
    // and it belongs in the database.
    //
    // The advisory lock below makes concurrent first provisioning DETERMINISTIC
    // rather than merely safe: without it both transactions reach the insert
    // and one dies on the index, which is correct but surfaces as an error on
    // a command the operator was told is idempotent. With it, the second
    // transaction waits, then sees the committed row and reports "already
    // exists" — the same answer a later rerun gives.
    //
    // What this replaced was `SELECT ... FOR UPDATE` on the empty table, and
    // the comment claiming it serialised installers. It cannot: a row lock
    // over zero rows locks nothing. Two first-run installers both saw an empty
    // table and both inserted. With the same slug one happened to fail on
    // `tenants_slug_key` — a different invariant catching this one by accident
    // — and with different slugs both committed, leaving two primary tenants.
    return await handle.db.transaction(async (tx) => {
      // Transaction-scoped, so it is released by COMMIT or ROLLBACK and cannot
      // be leaked by a crash between statements. The key names this specific
      // singleton; it is a constant, not derived from input.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${PROVISION_LOCK_KEY})`);

      const [existing] = await tx
        .select({ id: tenants.id, slug: tenants.slug })
        .from(tenants)
        .where(eq(tenants.kind, 'PRIMARY'))
        .orderBy(tenants.createdAt, tenants.id)
        .limit(1);

      if (existing) {
        return { tenantId: String(existing.id), slug: String(existing.slug), created: false };
      }

      // UUIDv7 generated in the application, per the repository's identity
      // rule: the id exists before the insert.
      const id = uuidv7();
      await tx.insert(tenants).values({
        id,
        kind: 'PRIMARY',
        // A primary tenant has no parent; the CHECK constraint enforces it.
        parentTenantId: null,
        slug: input.slug,
        displayName: input.displayName,
        status: 'ACTIVE',
        locale: input.locale,
        displayTimezone: input.timezone,
        calendar: input.calendar,
        currency: input.currency,
      });
      return { tenantId: id, slug: input.slug, created: true };
    });
  } finally {
    await handle.close();
  }
}

function readArgs(argv: readonly string[]): ProvisionInput {
  const get = (flag: string, fallback: string): string => {
    const index = argv.indexOf(flag);
    if (index === -1) return fallback;
    const value = argv[index + 1];
    // A flag with no value is not the same as an absent flag. Falling through
    // to the default here would provision an installation named something the
    // operator did not ask for, and report success.
    if (value === undefined || value.startsWith('--')) {
      throw new NexaError({
        kind: 'CONFIGURATION',
        code: PLATFORM_ERROR_CODES.CONFIG_INVALID,
        message: `${flag} needs a value.`,
      });
    }
    return value;
  };

  return {
    slug: get('--slug', 'nexa'),
    displayName: get('--display-name', 'Nexa'),
    locale: get('--locale', 'fa'),
    timezone: get('--timezone', 'Asia/Tehran'),
    calendar: get('--calendar', 'jalali'),
    currency: get('--currency', 'IRT'),
  };
}

function requireDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_URL;
  if (!url || !url.startsWith('postgres')) {
    throw new NexaError({
      kind: 'CONFIGURATION',
      code: PLATFORM_ERROR_CODES.CONFIG_INVALID,
      message: 'DATABASE_URL must be set to a postgres:// connection string to provision.',
    });
  }
  return url;
}

async function main(): Promise<void> {
  const result = await provisionInstallation(requireDatabaseUrl(), readArgs(process.argv.slice(2)));
  console.warn(
    result.created
      ? `Provisioned installation tenant "${result.slug}" (${result.tenantId}).`
      : `Installation tenant "${result.slug}" already exists (${result.tenantId}); nothing changed.`,
  );
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error: unknown) => {
    if (error instanceof NexaError) console.error(error.message);
    else console.error(error);
    process.exitCode = 1;
  });
}
