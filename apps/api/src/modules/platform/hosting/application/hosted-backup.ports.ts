import type { BackupTrigger, ScopeContext } from '@nexa/contracts';
import type { BackupRunRow } from '../../backup/application/ports.js';

/** A `hosted_bot_backup_policies` row (Phase 6B PR-2, ADR-0039 § 7). */
export interface HostedBackupPolicyRow {
  readonly id: string;
  readonly hostedTenantId: string;
  readonly enabled: boolean;
  readonly dailyTime: string;
  readonly keep: number;
  readonly passwordCiphertext: string | null;
  readonly passwordKeyId: string | null;
  readonly passwordSetAt: Date | null;
  readonly runRequestedAt: Date | null;
  readonly updatedAt: Date;
}

export interface HostedBackupPolicyStore {
  find(
    scope: ScopeContext,
    hostedTenantId: string,
    tx?: unknown,
  ): Promise<HostedBackupPolicyRow | null>;
  ensure(
    scope: ScopeContext,
    input: {
      readonly id: string;
      readonly hostedTenantId: string;
      readonly enabled: boolean;
      readonly dailyTime: string;
      readonly keep: number;
      readonly now: Date;
    },
    tx?: unknown,
  ): Promise<HostedBackupPolicyRow>;
  setSchedule(
    scope: ScopeContext,
    input: {
      readonly id: string;
      readonly enabled: boolean;
      readonly dailyTime: string;
      readonly keep: number;
      readonly now: Date;
    },
    tx?: unknown,
  ): Promise<void>;
  setPassword(
    scope: ScopeContext,
    input: {
      readonly id: string;
      readonly ciphertext: string;
      readonly keyId: string;
      readonly now: Date;
    },
    tx?: unknown,
  ): Promise<void>;
  requestRun(
    scope: ScopeContext,
    input: { readonly id: string; readonly now: Date },
    tx?: unknown,
  ): Promise<void>;
  clearRunRequest(
    scope: ScopeContext,
    input: { readonly id: string; readonly requestedAt: Date },
  ): Promise<void>;
  withPassword(scope: ScopeContext): Promise<readonly HostedBackupPolicyRow[]>;
  enabledFor(scope: ScopeContext): Promise<boolean | null>;
}

/** One hosted tenant's archive runs (`DrizzleHostedArchiveRuns`). */
export interface HostedArchiveRuns {
  recent(subjectTenantId: string, limit: number): Promise<readonly BackupRunRow[]>;
  byId(subjectTenantId: string, id: string): Promise<BackupRunRow | null>;
  lastAttemptAt(subjectTenantId: string): Promise<Date | null>;
  lastVerifiedAt(subjectTenantId: string): Promise<Date | null>;
  pruneCandidates(subjectTenantId: string, keep: number): Promise<readonly BackupRunRow[]>;
  markPruned(subjectTenantId: string, id: string, now: Date): Promise<boolean>;
}

/** The tenant archive pipeline (`TenantArchiveService`), as the schedule drives it. */
export interface HostedArchiveRunner {
  run(input: {
    readonly tenantId: string;
    readonly trigger: BackupTrigger;
    readonly password: string;
  }): Promise<
    | { readonly kind: 'COMPLETED'; readonly run: BackupRunRow }
    | { readonly kind: 'BUSY'; readonly holder: BackupRunRow }
    | { readonly kind: 'NOT_ADMITTED' }
  >;
}

/** Where one hosted archive is on disk, and how it is removed (`BACKUP_WORK_DIR/hosted/…`). */
export interface HostedArchiveFiles {
  /** The archive file of a run, or null when it is not on disk. */
  archive(hostedTenantId: string, runId: string): Promise<{ path: string; bytes: number } | null>;
  /** Removes the run's directory. Answers whether nothing of it is left. */
  remove(hostedTenantId: string, runId: string): Promise<boolean>;
}
