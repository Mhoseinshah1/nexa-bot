import type {
  ActorContext,
  AuditWriter,
  PermissionKey,
  ScopeContext,
  SecretReentryItem,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../access/application/permission-guard.js';
import { recordMutationDenial } from '../../access/application/authorized-mutation.js';

/** The secrets a restore cleared that still need re-entering, decided at read time. */
export interface SecretReentryReader {
  outstanding(scope: ScopeContext): Promise<SecretReentryItem[]>;
}

/**
 * Who may see the strip: `backup.view`, the permission that already reads every recovery
 * and its `restoreTest` (which names the same purposes and counts). Deny by default — a
 * caller without it gets PERMISSION_DENIED and an audited denial, never an empty list.
 */
export const SECRET_REENTRY_VIEW: PermissionKey = 'backup.view';

/**
 * NEXA-FIX-RESTORE-SECRETS §2.3: the Web Admin attention strip after a restore that
 * cleared the secrets it could not read. Read-only.
 */
export class SecretReentryService {
  constructor(
    private readonly deps: {
      readonly reader: SecretReentryReader;
      readonly guard: PermissionGuard;
      readonly audit: AuditWriter;
      readonly opsLog: { record(scope: ScopeContext, event: unknown): Promise<unknown> };
    },
  ) {}

  async list(scope: ScopeContext, actor: ActorContext): Promise<SecretReentryItem[]> {
    try {
      await this.deps.guard.check(scope, actor, SECRET_REENTRY_VIEW);
    } catch (denied) {
      await recordMutationDenial(
        { guard: this.deps.guard, audit: this.deps.audit, opsLog: this.deps.opsLog as never },
        scope,
        actor,
        SECRET_REENTRY_VIEW,
        { action: 'secret_reentry.list', entityType: 'SecretReentry', entityId: null },
        denied,
      );
      throw denied;
    }
    return this.deps.reader.outstanding(scope);
  }
}
