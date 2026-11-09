import { sql, type SQL } from 'drizzle-orm';
import { HOSTED_BOT_STATES, HOSTED_BOT_TENANT_STATUS } from '@nexa/contracts';
import type { DatabaseHandle } from '../../../../infrastructure/persistence/database.js';
import { withSystemScope } from '../../../../infrastructure/persistence/database-scope.js';

/**
 * Phase 6B (ADR-0039 § 4): a hosted bot held still while it is replaced.
 *
 * The TENANT row is what stops a bot (`ScopeActivityReader`, inside every write path's
 * transaction, the webhook, sign-in): a replace sets an ACTIVE bot's tenant `STOPPED` before it
 * archives the rows it will replace, so nothing writes between that PRE_REPLACE archive and the
 * replace's one transaction. The register (`hosted_bots.state`) is never touched: it is the
 * owner's word, and the tenant always ends at the status that state holds
 * (`HOSTED_BOT_TENANT_STATUS`) — the replace sets it in its own transaction, `release` after a
 * failure, and the next admitted restore reconciles a crashed one. Only the hosting system path
 * otherwise writes a hosted tenant's status, always to that same mapping, so reconciling to it
 * never undoes anybody's decision.
 *
 * The hosted tenant is not the caller's (the installation's work), so both statements run on
 * the system path under their own reasons, and each names the installation as the parent.
 */
export class DrizzleTenantReplaceHold {
  constructor(
    private readonly app: DatabaseHandle,
    private readonly now: () => Date,
  ) {}

  async hold(installationTenantId: string, hostedTenantId: string): Promise<void> {
    await withSystemScope('tenant archive: hold a hosted bot still for its replace', () =>
      this.app.db.execute(sql`
        UPDATE tenants t SET status = 'STOPPED', updated_at = ${this.now()}
          FROM hosted_bots b
         WHERE t.id = ${hostedTenantId}::uuid
           AND t.kind = 'HOSTED' AND t.parent_tenant_id = ${installationTenantId}::uuid
           AND b.tenant_id = ${installationTenantId}::uuid AND b.hosted_tenant_id = t.id
           AND t.status = 'ACTIVE'`),
    );
  }

  async release(installationTenantId: string, hostedTenantId: string | null): Promise<void> {
    const status = registerStatus(sql`b.state`);
    await withSystemScope('tenant archive: return a hosted bot to its register status', () =>
      this.app.db.execute(sql`
        UPDATE tenants t SET status = ${status}, updated_at = ${this.now()}
          FROM hosted_bots b
         WHERE t.kind = 'HOSTED' AND t.parent_tenant_id = ${installationTenantId}::uuid
           AND b.tenant_id = ${installationTenantId}::uuid AND b.hosted_tenant_id = t.id
           ${hostedTenantId === null ? sql`` : sql`AND t.id = ${hostedTenantId}::uuid`}
           AND t.status IS DISTINCT FROM ${status}`),
    );
  }
}

/** `HOSTED_BOT_TENANT_STATUS` as a SQL CASE over `state` (a closed enum, literals only). */
export function registerStatus(state: SQL): SQL {
  return sql`(CASE ${state} ${sql.join(
    HOSTED_BOT_STATES.map(
      (s) => sql`WHEN ${sql.raw(`'${s}'`)} THEN ${sql.raw(`'${HOSTED_BOT_TENANT_STATUS[s]}'`)}`,
    ),
    sql` `,
  )} END)`;
}
