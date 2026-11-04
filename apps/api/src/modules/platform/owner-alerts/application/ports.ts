import type { ActorContext, TenantContext } from '@nexa/contracts';

/**
 * Phase 6A D0: the stores behind the installation owner's security alerts. Both are
 * tenant-owned (`tenant_id` leads every key), so row-level security covers them like every
 * other admin table.
 */

/** What remembering a sign-in address found. */
export type KnownIpVerdict =
  /** The administrator had no remembered address at all: their first sign-in. */
  | 'FIRST_EVER'
  /** The address was already remembered for them. */
  | 'KNOWN'
  /** They had other addresses, and not this one. */
  | 'NEW';

export interface KnownAdminIpStore {
  /**
   * Remembers `ip` for the administrator and says what it found, in ONE statement inside
   * the caller's transaction, so two sign-ins at once from one new address are one `NEW`
   * and one `KNOWN`, never two alerts.
   */
  remember(
    scope: TenantContext,
    input: { readonly adminId: string; readonly ip: string; readonly now: Date },
    tx: unknown,
  ): Promise<KnownIpVerdict>;
}

export interface AdminReadWindowStore {
  /**
   * Adds `rows` to the administrator's window starting at `windowStart` and returns the
   * rowsInWindow before and after, atomically. `claimAlert` sets the window's `alerted_at` only if
   * it was null and the new rowsInWindow exceeds `threshold`, returning whether THIS call claimed
   * it — so a window is announced once, whichever replica crosses it.
   */
  add(
    scope: TenantContext,
    input: {
      readonly adminId: string;
      readonly windowStart: Date;
      readonly rows: number;
      readonly threshold: number;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<{ readonly rowsInWindow: number; readonly claimedAlert: boolean }>;
}

/** What was exported (Phase 6A D0, `access.data_exported`). */
export type DataExportKind =
  'REPORT' | 'AUDIT_LOG' | 'GIFT_CARD_CODES' | 'RECOVERY_KIT' | 'BACKUP_ARCHIVE';

/**
 * The one call every export path makes before its file leaves. Throws when the owner's alert
 * cannot be recorded, so the caller hands out nothing nobody was told about.
 */
export interface OwnerExportAlerts {
  dataExported(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly kind: DataExportKind;
      readonly rows: number | null;
      readonly format?: string;
    },
  ): Promise<void>;
}
