import type { TenantId, TenantKind } from '@nexa/contracts';

/** How often a role asks whether the tenant it cached at startup still exists. */
export const INSTALLATION_TENANT_CHECK_MS = 30_000;

/**
 * Whether `error` (or anything in its cause chain) is a PostgreSQL foreign-key violation on
 * a tenant reference: SQLSTATE 23503 whose constraint, detail or message names a tenant.
 * drizzle wraps the driver error, so the chain is walked.
 */
export function isTenantForeignKeyViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    const e = current as {
      code?: unknown;
      constraint?: unknown;
      detail?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (e.code === '23503') {
      const text = [e.constraint, e.detail, e.message]
        .filter((part): part is string => typeof part === 'string')
        .join(' ');
      if (/tenant/iu.test(text)) return true;
    }
    current = e.cause;
  }
  return false;
}

export interface InstallationTenantGuardDeps {
  /** The tenant the process resolved at startup (or last re-resolved). */
  readonly getCurrent: () => TenantId | null;
  readonly setCurrent: (tenantId: TenantId) => void;
  /**
   * A primary-key lookup: the tenant's kind, or null when the row does not exist in the
   * live database. A directory read (`tenants` carries no row-level security), made on
   * the audited system path when nothing is bound (ADR-0037).
   */
  readonly tenantKind: (tenantId: TenantId) => Promise<TenantKind | null>;
  /** The same resolution a role does at boot: the installation's one PRIMARY tenant. */
  readonly findPrimary: () => Promise<TenantId | null>;
  /** Process exit; Docker restarts the role and it resolves from scratch. */
  readonly exit: (code: number) => void;
  readonly logger: {
    warn(context: Record<string, unknown>, message: string): void;
    error(context: Record<string, unknown>, message: string): void;
  };
  readonly intervalMs?: number;
}

/**
 * Keeps a long-running role's cached installation tenant true after the database under it
 * is replaced (a Disaster Recovery restore, whose tenant id differs from the running one).
 *
 * Every role caches the tenant once at startup. After a restore that id names nothing: every
 * tenant-owned insert violates its foreign key (the login throttle, the recovery request),
 * and a role that only logs it fails for ever. This guard checks on a timer and when a
 * write fails with a tenant foreign-key violation:
 *
 * - the cached tenant still exists: nothing;
 * - it is gone and a primary exists: adopt it, once, and say so;
 * - it is gone and there is no primary: the install is not recoverable in this process, so
 *   exit and let Docker start the role again.
 *
 * The guard replaces only the INSTALLATION tenant. One install hosts many tenants
 * (ADR-0037), and "the primary" is the owner's installation tenant: a cached tenant the
 * guard has seen as any other kind (a reseller sales bot, a hosted bot) is never swapped
 * for the owner's when it disappears — that would move a stranger's work into the
 * owner's tenant. It is logged and kept; its writes keep failing, which is the truth.
 *
 * A role that never had a tenant (a fresh, unprovisioned install) is left alone. A check
 * that could not be answered (database down mid-restore) changes nothing. Concurrent calls
 * share one check. The guard never retries the write that failed.
 */
export class InstallationTenantGuard {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<TenantId | null> | null = null;
  /** The kind this guard last saw the cached tenant have, by id. */
  private lastSeen: { readonly tenantId: TenantId; readonly kind: TenantKind } | null = null;

  constructor(private readonly deps: InstallationTenantGuardDeps) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(
      () => void this.verify(),
      this.deps.intervalMs ?? INSTALLATION_TENANT_CHECK_MS,
    );
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Called with the error of a failed write; only a tenant FK violation does anything. */
  onWriteError(error: unknown): void {
    if (isTenantForeignKeyViolation(error)) void this.verify();
  }

  /** Resolves to the tenant this process uses once the check is done. Never throws. */
  verify(): Promise<TenantId | null> {
    this.inFlight ??= this.run().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async run(): Promise<TenantId | null> {
    const cached = this.deps.getCurrent();
    if (cached === null) return null;
    try {
      const kind = await this.deps.tenantKind(cached);
      if (kind !== null) {
        this.lastSeen = { tenantId: cached, kind };
        return cached;
      }
      const seen = this.lastSeen?.tenantId === cached ? this.lastSeen.kind : null;
      if (seen !== null && seen !== 'PRIMARY') {
        this.deps.logger.error(
          { cachedTenantId: cached, kind: seen },
          'the tenant this process cached no longer exists and was not the installation tenant; not replacing it with the installation tenant',
        );
        return cached;
      }
      const primary = await this.deps.findPrimary();
      if (primary === null) {
        this.deps.logger.error(
          { cachedTenantId: cached },
          'the installation tenant this process cached no longer exists and the database has no primary tenant; exiting so the role restarts',
        );
        this.deps.exit(1);
        return cached;
      }
      this.deps.setCurrent(primary);
      this.deps.logger.warn(
        { previousTenantId: cached, tenantId: primary },
        'the database was replaced; re-resolved the installation tenant',
      );
      return primary;
    } catch (error) {
      // Inconclusive (the database is unreachable, mid-cutover): change nothing, ask again.
      this.deps.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'could not verify the installation tenant; keeping the cached one',
      );
      return this.deps.getCurrent();
    }
  }
}
