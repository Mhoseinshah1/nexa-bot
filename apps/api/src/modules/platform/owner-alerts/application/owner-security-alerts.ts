import {
  BULK_READ_PER_CALL_DEFAULT,
  BULK_READ_PER_WINDOW_DEFAULT,
  BULK_READ_SETTING_KEYS,
  BULK_READ_WINDOW_MINUTES_DEFAULT,
  OWNER_ALERT_BULK_READ_CODE,
  OWNER_ALERT_DATA_EXPORTED_CODE,
  OWNER_ALERT_LOGIN_NEW_IP_CODE,
  type ActorContext,
  type Clock,
  type OperationalEventRecorder,
  type ScopeContext,
  type SettingKey,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type {
  AdminReadWindowStore,
  DataExportKind,
  KnownAdminIpStore,
  OwnerExportAlerts,
} from './ports.js';

/**
 * Phase 6A D0: the installation owner's security alerts.
 *
 * WHO IS TOLD. Every alert is recorded in the INSTALLATION tenant's scope, so the operations
 * projection queues it for the installation operator's own operations group (SECURITY topic)
 * and for nobody else. A hosted tenant's scope is never the addressee: its owners must not
 * learn of the platform's security events, and the platform's owner is the one who acts on
 * them. With no installation tenant yet, nothing is recorded.
 *
 * WHAT IS SAID. Who (admin id and username), from where (the sign-in address), what (the
 * export's kind and row count, the resource read and how many rows) — never a secret, a
 * filter value, a customer's name or any row's content.
 *
 * - `auth.login_new_ip`: a Web Admin sign-in from an address this administrator has never
 *   signed in from. The FIRST sign-in an administrator ever makes only remembers its address
 *   (an owner told about every new account's first login learns to ignore the alert). Written
 *   in the transaction that mints the session, so the alert and the session commit together.
 *   An address the trusted-proxy configuration cannot vouch for (null) is neither remembered
 *   nor alerted on.
 * - `access.data_exported`: every export or download of data, recorded BEFORE the file is
 *   returned. Fail-closed: an export that cannot be announced is not handed out.
 * - `access.bulk_read`: one list or search above `security.bulk_read_rows`, or one
 *   administrator's reads in a fixed `security.bulk_read_window_minutes` window above
 *   `security.bulk_read_window_rows` — announced at most once per administrator per window.
 *   Fail-open: a counter that cannot be written never breaks the page that was read.
 */
export interface OwnerSecurityAlertsDeps {
  /** The NOTIFYING recorder: the projection to the operations group is the point. */
  readonly opsLog: OperationalEventRecorder;
  readonly knownIps: KnownAdminIpStore;
  readonly readWindows: AdminReadWindowStore;
  readonly settings: {
    valueOf<T>(scope: ScopeContext, key: SettingKey, tx?: unknown): Promise<T>;
  };
  readonly uow: UnitOfWork;
  /** The installation tenant; resolved per call (it is a row, known after construction). */
  readonly installationScope: () => TenantContext | null;
  readonly clock: Clock;
  readonly logger: { warn(context: Record<string, unknown>, message: string): void };
}

const ADMIN_ACTOR_TYPES: ReadonlySet<string> = new Set(['WEB_ADMIN', 'TELEGRAM_ADMIN']);

export class OwnerSecurityAlerts implements OwnerExportAlerts {
  constructor(private readonly deps: OwnerSecurityAlertsDeps) {}

  /** The owner's scope, or null when `scope` is not the installation's own tenant. */
  private ownerScopeFor(scope: TenantContext): TenantContext | null {
    const owner = this.deps.installationScope();
    if (owner === null) return null;
    return owner.tenantId === scope.tenantId ? owner : null;
  }

  /**
   * Inside the sign-in transaction (`tx`), after the session row: remembers the address and,
   * when it is new for an administrator who had others, records `auth.login_new_ip` in the
   * same transaction. A sign-in on a hosted tenant is not the owner's Web Admin: nothing.
   */
  async signedIn(
    scope: TenantContext,
    actor: ActorContext,
    admin: { readonly id: string; readonly username: string },
    ip: string | null,
    tx: unknown,
  ): Promise<void> {
    if (ip === null) return;
    const owner = this.ownerScopeFor(scope);
    if (owner === null) return;
    const now = this.deps.clock.now();
    const verdict = await this.deps.knownIps.remember(scope, { adminId: admin.id, ip, now }, tx);
    if (verdict !== 'NEW') return;
    await this.deps.opsLog.record(
      owner,
      {
        code: OWNER_ALERT_LOGIN_NEW_IP_CODE,
        severity: 'WARN',
        message: `Administrator ${admin.username} signed in from ${ip}, an address not seen for them before.`,
        context: { adminId: admin.id, adminUsername: admin.username, clientIp: ip },
        correlationId: actor.correlationId,
      },
      tx,
    );
  }

  /**
   * Every export or download of data, before the file leaves. Throws when the alert cannot
   * be recorded, so the caller does not hand out a file nobody was told about.
   */
  async dataExported(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly kind: DataExportKind;
      readonly rows: number | null;
      readonly format?: string;
    },
  ): Promise<void> {
    const owner = this.deps.installationScope();
    if (owner === null) return;
    const who = actor.label ?? actor.id ?? actor.type;
    await this.deps.opsLog.record(owner, {
      code: OWNER_ALERT_DATA_EXPORTED_CODE,
      severity: 'WARN',
      message:
        `${who} exported ${input.kind}` +
        (input.rows === null ? '' : ` (${String(input.rows)} rows)`) +
        (input.format === undefined ? '' : ` as ${input.format}`) +
        '.',
      context: {
        ...(actor.id === null ? {} : { adminId: actor.id }),
        ...(actor.label === null ? {} : { adminUsername: actor.label }),
        exportKind: input.kind,
        ...(input.rows === null ? {} : { rowCount: input.rows }),
        ...(input.format === undefined ? {} : { format: input.format }),
        ...(scope.tenantId === owner.tenantId ? {} : { scopeTenantId: scope.tenantId }),
      },
      correlationId: actor.correlationId,
    });
  }

  /**
   * One list or search returned `rows` rows of `resource` to an administrator. Counted into
   * their window; announced when the call alone, or the window, passes its threshold. Never
   * throws.
   */
  async rowsRead(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly resource: string; readonly rows: number },
  ): Promise<void> {
    if (!ADMIN_ACTOR_TYPES.has(actor.type) || actor.id === null || input.rows <= 0) return;
    const owner = this.deps.installationScope();
    if (owner === null) return;
    const adminId = actor.id;
    try {
      const perCall = await this.setting(
        owner,
        BULK_READ_SETTING_KEYS.perCall,
        BULK_READ_PER_CALL_DEFAULT,
      );
      const perWindow = await this.setting(
        owner,
        BULK_READ_SETTING_KEYS.perWindow,
        BULK_READ_PER_WINDOW_DEFAULT,
      );
      const windowMinutes = await this.setting(
        owner,
        BULK_READ_SETTING_KEYS.windowMinutes,
        BULK_READ_WINDOW_MINUTES_DEFAULT,
      );
      const now = this.deps.clock.now();
      const windowMs = windowMinutes * 60_000;
      const windowIndex = Math.floor(now.getTime() / windowMs);
      const windowStart = new Date(windowIndex * windowMs);
      const window =
        perWindow > 0
          ? await this.deps.uow.run(scope, (tx) =>
              this.deps.readWindows.add(
                scope,
                { adminId, windowStart, rows: input.rows, threshold: perWindow, now },
                tx,
              ),
            )
          : null;
      const callExceeded = perCall > 0 && input.rows > perCall;
      if (!callExceeded && window?.claimedAlert !== true) return;
      await this.deps.opsLog.record(owner, {
        code: OWNER_ALERT_BULK_READ_CODE,
        severity: 'WARN',
        message: callExceeded
          ? `${actor.label ?? adminId} read ${String(input.rows)} rows of ${input.resource} in one request (threshold ${String(perCall)}).`
          : `${actor.label ?? adminId} read ${String(window?.rowsInWindow ?? 0)} rows within ${String(windowMinutes)} minutes (threshold ${String(perWindow)}).`,
        context: {
          adminId,
          ...(actor.label === null ? {} : { adminUsername: actor.label }),
          readResource: input.resource,
          rowCount: callExceeded ? input.rows : (window?.rowsInWindow ?? input.rows),
          windowMinutes,
        },
        // One announcement per administrator per window, however many calls cross a line.
        dedupeKey: `${OWNER_ALERT_BULK_READ_CODE}:${adminId}@${String(windowIndex)}`,
        correlationId: actor.correlationId,
      });
    } catch (error) {
      this.deps.logger.warn(
        {
          code: OWNER_ALERT_BULK_READ_CODE,
          reason: error instanceof Error ? error.message : String(error),
        },
        'could not count or announce a Web Admin read; the read itself is unaffected',
      );
    }
  }

  private async setting(scope: TenantContext, key: string, fallback: number): Promise<number> {
    const value = await this.deps.settings.valueOf<unknown>(scope, key as SettingKey);
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }
}
