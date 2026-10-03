import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import type {
  ActorContext,
  IncidentEffectKind,
  IncidentEffectState,
  IncidentEventKind,
  IncidentKind,
  IncidentSeverity,
  IncidentStatus,
  IncidentTarget,
  IncidentTargetKind,
  TenantContext,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  incidentCommunications,
  incidentEffects,
  incidentEvents,
  incidentNotices,
  incidentTargets,
  incidents,
} from '../../../../infrastructure/persistence/schema.js';
import type {
  IncidentEffectRecord,
  IncidentEventRecord,
  IncidentFields,
  IncidentRecord,
  IncidentRepository,
} from '../application/ports.js';

type Row = typeof incidents.$inferSelect;

/** Incidents and everything recorded about them (Phase E3). Every query names the tenant. */
export class DrizzleIncidentRepository implements IncidentRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  private async withTargets(tenantId: string, rows: readonly Row[], tx?: unknown) {
    if (rows.length === 0) return [];
    const targets = await this.exec(tx)
      .select()
      .from(incidentTargets)
      .where(
        and(
          eq(incidentTargets.tenantId, tenantId),
          inArray(
            incidentTargets.incidentId,
            rows.map((row) => row.id),
          ),
        ),
      )
      .orderBy(asc(incidentTargets.kind), asc(incidentTargets.ref));
    return rows.map((row) =>
      toRecord(
        row,
        targets.filter((t) => t.incidentId === row.id),
      ),
    );
  }

  async insert(
    scope: TenantContext,
    input: IncidentFields & {
      readonly id: string;
      readonly status: IncidentStatus;
      readonly startedAt: Date | null;
      readonly createdByAdminId: string | null;
      readonly now: Date;
    },
    tx: TransactionScope,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    await this.exec(tx).insert(incidents).values({
      id: input.id,
      tenantId,
      kind: input.kind,
      severity: input.severity,
      status: input.status,
      title: input.title,
      description: input.description,
      customerMessage: input.customerMessage,
      stopSales: input.stopSales,
      adminBanner: input.adminBanner,
      scheduledStartAt: input.scheduledStartAt,
      scheduledEndAt: input.scheduledEndAt,
      startedAt: input.startedAt,
      createdByAdminId: input.createdByAdminId,
      createdAt: input.now,
      updatedAt: input.now,
    });
    await this.writeTargets(tenantId, input.id, input.targets, tx);
  }

  private async writeTargets(
    tenantId: string,
    incidentId: string,
    targets: readonly IncidentTarget[],
    tx: TransactionScope,
  ): Promise<void> {
    await this.exec(tx)
      .delete(incidentTargets)
      .where(
        and(eq(incidentTargets.tenantId, tenantId), eq(incidentTargets.incidentId, incidentId)),
      );
    if (targets.length === 0) return;
    await this.exec(tx)
      .insert(incidentTargets)
      .values(targets.map((t) => ({ tenantId, incidentId, kind: t.kind, ref: t.ref })));
  }

  async find(scope: TenantContext, id: string, tx?: unknown): Promise<IncidentRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(incidents)
      .where(and(eq(incidents.tenantId, tenantId), eq(incidents.id, id)))
      .limit(1);
    const [record] = await this.withTargets(tenantId, rows, tx);
    return record ?? null;
  }

  async lock(
    scope: TenantContext,
    id: string,
    tx: TransactionScope,
  ): Promise<IncidentRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(incidents)
      .where(and(eq(incidents.tenantId, tenantId), eq(incidents.id, id)))
      .for('update');
    const [record] = await this.withTargets(tenantId, rows, tx);
    return record ?? null;
  }

  async list(scope: TenantContext, limit: number): Promise<readonly IncidentRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select()
      .from(incidents)
      .where(eq(incidents.tenantId, tenantId))
      .orderBy(desc(incidents.createdAt), desc(incidents.id))
      .limit(limit);
    return this.withTargets(tenantId, rows);
  }

  async banner(scope: TenantContext): Promise<readonly IncidentRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select()
      .from(incidents)
      .where(
        and(
          eq(incidents.tenantId, tenantId),
          eq(incidents.status, 'ACTIVE'),
          eq(incidents.adminBanner, true),
        ),
      )
      .orderBy(desc(incidents.startedAt), desc(incidents.id))
      .limit(10);
    return this.withTargets(tenantId, rows);
  }

  async update(
    scope: TenantContext,
    id: string,
    expectedVersion: number,
    fields: IncidentFields,
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(incidents)
      .set({
        kind: fields.kind,
        severity: fields.severity,
        title: fields.title,
        description: fields.description,
        customerMessage: fields.customerMessage,
        stopSales: fields.stopSales,
        adminBanner: fields.adminBanner,
        scheduledStartAt: fields.scheduledStartAt,
        scheduledEndAt: fields.scheduledEndAt,
        version: sql`${incidents.version} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(incidents.tenantId, tenantId),
          eq(incidents.id, id),
          eq(incidents.version, expectedVersion),
          inArray(incidents.status, ['SCHEDULED', 'ACTIVE']),
        ),
      )
      .returning({ id: incidents.id });
    if (rows.length === 0) return false;
    await this.writeTargets(tenantId, id, fields.targets, tx);
    return true;
  }

  async transition(
    scope: TenantContext,
    id: string,
    input: {
      readonly from: readonly IncidentStatus[];
      readonly to: IncidentStatus;
      readonly expectedVersion: number | null;
      readonly now: Date;
    },
    tx: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const stamps =
      input.to === 'ACTIVE'
        ? { startedAt: input.now }
        : input.to === 'RESOLVED' || input.to === 'CANCELLED'
          ? { resolvedAt: input.now }
          : {};
    const rows = await this.exec(tx)
      .update(incidents)
      .set({
        status: input.to,
        ...stamps,
        version: sql`${incidents.version} + 1`,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(incidents.tenantId, tenantId),
          eq(incidents.id, id),
          inArray(incidents.status, [...input.from]),
          ...(input.expectedVersion === null ? [] : [eq(incidents.version, input.expectedVersion)]),
        ),
      )
      .returning({ id: incidents.id });
    return rows.length > 0;
  }

  async dueToStart(scope: TenantContext, now: Date): Promise<readonly string[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select({ id: incidents.id })
      .from(incidents)
      .where(
        and(
          eq(incidents.tenantId, tenantId),
          eq(incidents.status, 'SCHEDULED'),
          lte(incidents.scheduledStartAt, now),
        ),
      )
      .orderBy(asc(incidents.scheduledStartAt), asc(incidents.id))
      .limit(50);
    return rows.map((row) => row.id);
  }

  async tenantsWithDue(now: Date): Promise<readonly string[]> {
    const rows = await this.db
      .selectDistinct({ tenantId: incidents.tenantId })
      .from(incidents)
      .where(and(eq(incidents.status, 'SCHEDULED'), lte(incidents.scheduledStartAt, now)));
    return rows.map((row) => row.tenantId);
  }

  async appendEvent(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly incidentId: string;
      readonly kind: IncidentEventKind;
      readonly actor: ActorContext;
      readonly detail: Record<string, unknown> | null;
      readonly now: Date;
    },
    tx: TransactionScope,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    await this.exec(tx).insert(incidentEvents).values({
      id: input.id,
      tenantId,
      incidentId: input.incidentId,
      kind: input.kind,
      actorType: input.actor.type,
      actorId: input.actor.id,
      actorLabel: input.actor.label,
      detail: input.detail,
      occurredAt: input.now,
    });
  }

  async timeline(scope: TenantContext, id: string): Promise<readonly IncidentEventRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select()
      .from(incidentEvents)
      .where(and(eq(incidentEvents.tenantId, tenantId), eq(incidentEvents.incidentId, id)))
      .orderBy(asc(incidentEvents.occurredAt), asc(incidentEvents.id));
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind as IncidentEventKind,
      actorLabel: row.actorLabel,
      detail: (row.detail as Record<string, unknown> | null) ?? null,
      occurredAt: row.occurredAt,
    }));
  }

  async effects(
    scope: TenantContext,
    id: string,
    tx?: unknown,
  ): Promise<readonly IncidentEffectRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(incidentEffects)
      .where(and(eq(incidentEffects.tenantId, tenantId), eq(incidentEffects.incidentId, id)))
      .orderBy(asc(incidentEffects.createdAt), asc(incidentEffects.subjectRef));
    return rows.map((row) => ({
      kind: row.kind as IncidentEffectKind,
      targetKind: row.targetKind as IncidentTargetKind,
      targetRef: row.targetRef,
      subjectRef: row.subjectRef,
      state: row.state as IncidentEffectState,
      errorCode: row.errorCode,
      updatedAt: row.updatedAt,
    }));
  }

  async claimApply(
    scope: TenantContext,
    input: {
      readonly incidentId: string;
      readonly kind: IncidentEffectKind;
      readonly targetKind: IncidentTargetKind;
      readonly targetRef: string;
      readonly subjectRef: string;
      readonly staleBefore: Date;
      readonly now: Date;
    },
    tx: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    /*
     * One statement: a new effect is inserted PENDING; an existing one is re-claimed only
     * when it is a FAILED attempt, a REVERTED/KEPT one being wanted again (the scope came
     * back), or a claim gone stale. APPLIED and ALREADY are settled and stay as they are, so
     * a racing second caller claims nothing.
     */
    const result = await this.exec(tx).execute(sql`
      INSERT INTO incident_effects (tenant_id, incident_id, kind, target_kind, target_ref,
                                    subject_ref, state, error_code, created_at, updated_at)
      VALUES (${tenantId}, ${input.incidentId}, ${input.kind}, ${input.targetKind},
              ${input.targetRef}, ${input.subjectRef}, 'PENDING', NULL, ${input.now}, ${input.now})
      ON CONFLICT (tenant_id, incident_id, kind, subject_ref) DO UPDATE
         SET state = 'PENDING', error_code = NULL, updated_at = EXCLUDED.updated_at,
             target_kind = EXCLUDED.target_kind, target_ref = EXCLUDED.target_ref
       WHERE incident_effects.state IN ('FAILED', 'REVERTED', 'KEPT')
          OR (incident_effects.state = 'PENDING' AND incident_effects.updated_at < ${input.staleBefore})
      RETURNING subject_ref`);
    return result.rows.length > 0;
  }

  async claimRevert(
    scope: TenantContext,
    input: {
      readonly incidentId: string;
      readonly kind: IncidentEffectKind;
      readonly subjectRef: string;
      readonly staleBefore: Date;
      readonly now: Date;
    },
    tx: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const result = await this.exec(tx).execute(sql`
      UPDATE incident_effects SET state = 'REVERTING', updated_at = ${input.now}
       WHERE tenant_id = ${tenantId} AND incident_id = ${input.incidentId}
         AND kind = ${input.kind} AND subject_ref = ${input.subjectRef}
         AND (state = 'APPLIED'
              OR (state = 'REVERTING' AND updated_at < ${input.staleBefore}))
      RETURNING subject_ref`);
    return result.rows.length > 0;
  }

  async settleEffect(
    scope: TenantContext,
    input: {
      readonly incidentId: string;
      readonly kind: IncidentEffectKind;
      readonly subjectRef: string;
      readonly from: IncidentEffectState;
      readonly state: IncidentEffectState;
      readonly errorCode: string | null;
      readonly now: Date;
    },
    tx: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(incidentEffects)
      .set({ state: input.state, errorCode: input.errorCode, updatedAt: input.now })
      .where(
        and(
          eq(incidentEffects.tenantId, tenantId),
          eq(incidentEffects.incidentId, input.incidentId),
          eq(incidentEffects.kind, input.kind),
          eq(incidentEffects.subjectRef, input.subjectRef),
          eq(incidentEffects.state, input.from),
        ),
      )
      .returning({ subjectRef: incidentEffects.subjectRef });
    return rows.length > 0;
  }

  async audience(
    scope: TenantContext,
    incident: IncidentRecord,
    panels: readonly string[],
    tx?: unknown,
  ): Promise<readonly { readonly customerId: string; readonly botInstanceId: string }[]> {
    const tenantId = requireTenantId(scope);
    const products = incident.targets.filter((t) => t.kind === 'PRODUCT').map((t) => t.ref);
    const scoped = panels.length > 0 || products.length > 0;
    /*
     * Customers with a LIVE service on the scope — a panel the incident names (or a
     * location's), or a product it names — who can be reached: ACTIVE, on a bot. An
     * incident that names no panel, location or product (a gateway outage, an
     * installation-wide window) reaches every customer with a live service.
     */
    const result = await this.exec(tx).execute(sql`
      SELECT c.id AS customer_id, c.first_bot_instance_id AS bot_instance_id
        FROM customers c
       WHERE c.tenant_id = ${tenantId}
         AND c.status = 'ACTIVE'
         AND c.first_bot_instance_id IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM services s
            WHERE s.tenant_id = c.tenant_id AND s.customer_id = c.id
              AND s.state IN ('ACTIVE', 'SUSPENDED')
              ${
                scoped
                  ? sql`AND (s.panel_id = ANY(${sql.param([...panels])}::uuid[])
                         OR s.product_id = ANY(${sql.param(products)}::uuid[]))`
                  : sql``
              }
         )
       ORDER BY c.id`);
    return (result.rows as { customer_id: string; bot_instance_id: string }[]).map((row) => ({
      customerId: row.customer_id,
      botInstanceId: row.bot_instance_id,
    }));
  }

  async insertCommunication(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly incidentId: string;
      readonly message: string;
      readonly recipients: number;
      readonly sentByAdminId: string | null;
      readonly now: Date;
    },
    tx: TransactionScope,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    await this.exec(tx).insert(incidentCommunications).values({
      id: input.id,
      tenantId,
      incidentId: input.incidentId,
      message: input.message,
      recipients: input.recipients,
      sentByAdminId: input.sentByAdminId,
      createdAt: input.now,
    });
  }

  async insertNotice(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly communicationId: string;
      readonly incidentId: string;
      readonly customerId: string;
      readonly now: Date;
    },
    tx: TransactionScope,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    await this.exec(tx).insert(incidentNotices).values({
      id: input.id,
      tenantId,
      communicationId: input.communicationId,
      incidentId: input.incidentId,
      customerId: input.customerId,
      createdAt: input.now,
    });
  }

  async noticeFacts(
    scope: TenantContext,
    noticeId: string,
  ): Promise<{ readonly message: string; readonly incidentId: string } | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.db
      .select({ message: incidentCommunications.message, incidentId: incidentNotices.incidentId })
      .from(incidentNotices)
      .innerJoin(
        incidentCommunications,
        and(
          eq(incidentCommunications.tenantId, incidentNotices.tenantId),
          eq(incidentCommunications.id, incidentNotices.communicationId),
        ),
      )
      .where(and(eq(incidentNotices.tenantId, tenantId), eq(incidentNotices.id, noticeId)))
      .limit(1);
    return row ?? null;
  }
}

function toRecord(
  row: Row,
  targets: readonly (typeof incidentTargets.$inferSelect)[],
): IncidentRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    kind: row.kind as IncidentKind,
    severity: row.severity as IncidentSeverity,
    status: row.status as IncidentStatus,
    title: row.title,
    description: row.description,
    customerMessage: row.customerMessage,
    stopSales: row.stopSales,
    adminBanner: row.adminBanner,
    scheduledStartAt: row.scheduledStartAt,
    scheduledEndAt: row.scheduledEndAt,
    startedAt: row.startedAt,
    resolvedAt: row.resolvedAt,
    version: row.version,
    createdAt: row.createdAt,
    targets: targets.map((t) => ({ kind: t.kind as IncidentTargetKind, ref: t.ref })),
  };
}
