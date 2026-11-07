import {
  INSTALLATION_TENANT_VANISHED_CODE,
  type OperationalEventInput,
  type TenantId,
  type TenantKind,
} from '@nexa/contracts';

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
  /** Points the process at the re-resolved installation tenant (always a PRIMARY). */
  readonly setCurrent: (tenantId: TenantId) => void;
  /**
   * Stops the process's scope: after this, nothing the role does is attributed to any tenant
   * (every loop's `scope()` answers null, the Web Admin's login scope is refused). Called with
   * the vanished tenant's id; never points the process at another tenant.
   */
  readonly stopScope: (vanishedTenantId: TenantId) => void;
  /**
   * A primary-key lookup: the tenant's kind, or null when the row does not exist in the
   * live database. A directory read (`tenants` carries no row-level security), made on
   * the audited system path when nothing is bound (ADR-0037).
   */
  readonly tenantKind: (tenantId: TenantId) => Promise<TenantKind | null>;
  /** The same resolution a role does at boot: the installation's one PRIMARY tenant. */
  readonly findPrimary: () => Promise<TenantId | null>;
  /**
   * Records `event` on the installation OWNER's operations log: the PRIMARY tenant's scope,
   * never the vanished tenant's or a hosted tenant's. Resolves false when there is no owner
   * to tell. May throw; the guard logs it.
   */
  readonly alertOwner: (event: OperationalEventInput) => Promise<boolean>;
  /** Process exit; Docker restarts the role and it resolves from scratch. */
  readonly exit: (code: number) => void;
  readonly logger: {
    warn(context: Record<string, unknown>, message: string): void;
    error(context: Record<string, unknown>, message: string): void;
  };
  readonly intervalMs?: number;
}

/** What the guard recorded about the cached tenant when the role set it. */
interface RecordedTenant {
  readonly tenantId: TenantId;
  /** null: the kind was not given when the scope was set — UNKNOWN, never assumed PRIMARY. */
  readonly kind: TenantKind | null;
}

/**
 * Keeps a long-running role's cached installation tenant true after the database under it
 * is replaced (a Disaster Recovery restore, whose tenant id differs from the running one).
 *
 * Every role caches the tenant once at startup. After a restore that id names nothing: every
 * tenant-owned insert violates its foreign key (the login throttle, the recovery request),
 * and a role that only logs it fails for ever. This guard checks on a timer and when a
 * write fails with a tenant foreign-key violation (the Web error filter, the recovery
 * executor's bounded writes).
 *
 * FAIL CLOSED (the owner's rule, PR #411). One install hosts many tenants (ADR-0037), and
 * "the primary" is the owner's installation tenant. The KIND of the cached tenant is recorded
 * where the role sets its scope (`record`, from `resolveInstallationTenant` at boot and from
 * every re-resolution) — never learnt later from a periodic check, so there is no window in
 * which a vanished tenant's kind is simply unknown and assumed to be the owner's.
 *
 * - the cached tenant still exists: nothing;
 * - it is gone and was RECORDED as PRIMARY: the restore case (#413). Adopt the database's
 *   primary, once, and say so; with no primary, exit so Docker restarts the role;
 * - it is gone and was recorded as any other kind (hosted, reseller): never fall back. Stop
 *   the scope (`stopScope`), log an error, and send ONE alert to the owner's operations group;
 * - it is gone and its kind is UNKNOWN (never recorded, or recorded for another id): the role
 *   cannot tell whose tenant it was. The same stop and alert, then exit non-zero rather than
 *   guess; the restarted role resolves its tenant afresh at boot, with its kind recorded.
 *
 * A role that never had a tenant (a fresh, unprovisioned install, or a scope this guard
 * stopped) is left alone. A check that could not be answered (database down mid-restore)
 * changes nothing. Concurrent calls share one check. The guard never retries the write that
 * failed.
 */
export class InstallationTenantGuard {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<TenantId | null> | null = null;
  private recorded: RecordedTenant | null = null;
  /** Vanished tenants already alerted on, so one disappearance is one alert. */
  private readonly alerted = new Set<TenantId>();

  constructor(private readonly deps: InstallationTenantGuardDeps) {}

  /**
   * What the role knows about the tenant it is setting as its scope, recorded at that moment.
   * `kind` is the resolved tenant's own kind (`findPrimary()` returns a PRIMARY); omitted or
   * null records UNKNOWN, which fails closed if that tenant later vanishes.
   */
  record(tenantId: TenantId | null, kind?: TenantKind | null): void {
    this.recorded = tenantId === null ? null : { tenantId, kind: kind ?? null };
  }

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

  /**
   * `verify` never rejects: it runs from a timer and from error handlers with nobody to catch
   * it. A dependency that throws (a logger, `stopScope`, or an `exit` that a test runner
   * replaces with a throwing stub) is logged and the current tenant kept, as before #411,
   * when every step sat inside one try.
   */
  private async run(): Promise<TenantId | null> {
    try {
      return await this.check();
    } catch (error) {
      try {
        this.deps.logger.error(
          { err: error instanceof Error ? error.message : String(error) },
          'the installation tenant check failed unexpectedly; keeping the current tenant',
        );
        return this.deps.getCurrent();
      } catch {
        return null;
      }
    }
  }

  private async check(): Promise<TenantId | null> {
    const cached = this.deps.getCurrent();
    if (cached === null) return null;
    let kind: TenantKind | null;
    try {
      kind = await this.deps.tenantKind(cached);
    } catch (error) {
      // Inconclusive (the database is unreachable, mid-cutover): change nothing, ask again.
      this.deps.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'could not verify the installation tenant; keeping the cached one',
      );
      return this.deps.getCurrent();
    }
    if (kind !== null) return cached;

    const recordedKind = this.recorded?.tenantId === cached ? this.recorded.kind : null;
    if (recordedKind !== 'PRIMARY') return this.failClosed(cached, recordedKind);

    let primary: TenantId | null;
    try {
      primary = await this.deps.findPrimary();
    } catch (error) {
      this.deps.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'could not resolve the installation tenant; keeping the cached one',
      );
      return this.deps.getCurrent();
    }
    if (primary === null) {
      this.deps.logger.error(
        { cachedTenantId: cached },
        'the installation tenant this process cached no longer exists and the database has no primary tenant; exiting so the role restarts',
      );
      this.deps.exit(1);
      return cached;
    }
    this.deps.setCurrent(primary);
    this.record(primary, 'PRIMARY');
    this.deps.logger.warn(
      { previousTenantId: cached, tenantId: primary },
      'the database was replaced; re-resolved the installation tenant',
    );
    return primary;
  }

  /**
   * The cached tenant is gone and was not known to be the installation's PRIMARY: its work
   * must never move onto the owner's tenant. Stop the scope, tell the owner once, and — when
   * the kind was never known — exit rather than guess.
   */
  private async failClosed(cached: TenantId, kind: TenantKind | null): Promise<TenantId | null> {
    const unknown = kind === null;
    this.deps.logger.error(
      { cachedTenantId: cached, recordedKind: kind ?? 'UNKNOWN' },
      unknown
        ? 'the tenant this process cached no longer exists and its kind was never recorded; refusing its writes, stopping its scope and exiting rather than guessing it was the installation tenant'
        : 'the tenant this process cached no longer exists and was not the installation tenant; refusing its writes and stopping its scope, never replacing it with the installation tenant',
    );
    let stopped = true;
    try {
      if (this.deps.getCurrent() === cached) this.deps.stopScope(cached);
    } catch (error) {
      stopped = false;
      this.deps.logger.error(
        { cachedTenantId: cached, err: error instanceof Error ? error.message : String(error) },
        "the vanished tenant's scope could not be stopped; exiting",
      );
    }
    if (!this.alerted.has(cached)) {
      this.alerted.add(cached);
      try {
        const told = await this.deps.alertOwner(vanishedTenantAlert(cached, kind));
        if (!told) {
          this.deps.logger.error(
            { cachedTenantId: cached },
            'no installation owner to alert about the vanished tenant',
          );
        }
      } catch (error) {
        this.deps.logger.error(
          { cachedTenantId: cached, err: error instanceof Error ? error.message : String(error) },
          'the owner could not be alerted about the vanished tenant',
        );
      }
    }
    if (unknown || !stopped) this.deps.exit(1);
    return this.deps.getCurrent();
  }
}

/** The owner's alert for a vanished, non-PRIMARY cached tenant: one condition per tenant. */
export function vanishedTenantAlert(
  tenantId: TenantId,
  kind: TenantKind | null,
): OperationalEventInput {
  return {
    code: INSTALLATION_TENANT_VANISHED_CODE,
    severity: 'CRITICAL',
    message:
      kind === null
        ? `مستأجر ${tenantId} که این سرویس با آن کار می‌کرد دیگر وجود ندارد و نوعش معلوم نیست؛ کارش متوقف شد و سرویس دوباره راه‌اندازی می‌شود.`
        : `مستأجر ${tenantId} (${kind}) که این سرویس با آن کار می‌کرد دیگر وجود ندارد؛ کارش متوقف شد و به مستأجر اصلی منتقل نشد.`,
    dedupeKey: `${INSTALLATION_TENANT_VANISHED_CODE}:${tenantId}`,
    context: { tenantId, kind: kind ?? 'UNKNOWN' },
  };
}
