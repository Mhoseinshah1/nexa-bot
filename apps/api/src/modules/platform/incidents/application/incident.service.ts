import {
  COMMERCE_ERROR_CODES,
  INCIDENT_EFFECT_CLAIM_STALE_MS,
  INCIDENT_ERROR_CODES,
  INCIDENT_LIST_PAGE_SIZE,
  isIncidentId,
  PLATFORM_ERROR_CODES,
  errors,
  incidentConditionKey,
  incidentOpsCode,
  isNexaError,
  isValidIncidentTarget,
  systemJobActor,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type CorrelationId,
  type IdGenerator,
  type IdempotencyStore,
  type IncidentEffectKind,
  type IncidentEventKind,
  type IncidentStatus,
  type IncidentTarget,
  type OperationalEventRecorder,
  type PermissionKey,
  type TenantContext,
  type UnitOfWork,
  type UserId,
  type BotInstanceId,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../access/application/permission-guard.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
} from '../../access/application/authorized-mutation.js';
import { rememberOnce } from '../../idempotency/application/remember-once.js';
import { hashRequest } from '../../idempotency/infrastructure/drizzle-idempotency-store.js';
import type { SessionRepository } from '../../identity/application/ports.js';
import type { ScopeActivityReader } from '../../system/application/record-ping.service.js';
import type { OutboxWriter } from '../../eventing/infrastructure/outbox-writer.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  IncidentEffectPort,
  IncidentEffectRecord,
  IncidentEventRecord,
  IncidentFields,
  IncidentRecord,
  IncidentRepository,
  EffectClaim,
} from './ports.js';

export const INCIDENTS_VIEW: PermissionKey = 'incidents.view';
export const INCIDENTS_MANAGE: PermissionKey = 'incidents.manage';
export const INCIDENTS_NOTIFY: PermissionKey = 'incidents.notify';
/** What the scheduler acts under: the one key a system job holds. */
export const INCIDENT_SCHEDULER_PERMISSION: PermissionKey = 'maintenance.run';

export interface IncidentServiceDeps {
  readonly repository: IncidentRepository;
  readonly effects: IncidentEffectPort;
  readonly notifier: {
    notifyThrough(
      scope: TenantContext,
      customerId: UserId,
      botInstanceId: BotInstanceId,
      kind: 'INCIDENT_NOTICE',
      subjectId: string,
      now: Date,
      tx: TransactionScope,
    ): Promise<boolean>;
  };
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: { error: (context: Record<string, unknown>, message: string) => void };
  /** The open-condition reader, keyed as the recorder dedupes. */
  readonly conditions: {
    conditionIsOpen(
      scope: TenantContext,
      dedupeKey: string,
      tx?: TransactionScope,
    ): Promise<boolean>;
  };
}

export interface IncidentView {
  readonly incident: IncidentRecord;
  readonly effects: readonly IncidentEffectRecord[];
}

/** The fields, validated against the clock and the tenant (targets resolved by the caller). */
export interface IncidentInput {
  readonly kind: IncidentFields['kind'];
  readonly severity: IncidentFields['severity'];
  readonly title: string;
  readonly description: string;
  readonly customerMessage: string | null;
  readonly stopSales: boolean;
  readonly adminBanner: boolean;
  readonly scheduledStartAt: string | null;
  readonly scheduledEndAt: string | null;
  readonly targets: readonly IncidentTarget[];
}

const ACTIVE_OR_SCHEDULED: readonly IncidentStatus[] = ['SCHEDULED', 'ACTIVE'];

/**
 * Incidents and maintenance (Phase E3, `docs/incidents.md`).
 *
 * The record — status, window, scope, timeline, communications — is this module's. Every
 * OPERATIONAL EFFECT is the owning module's: `IncidentEffectPort` calls panel drain,
 * product deactivation and gateway status as the operator, so each is authorised, audited
 * and idempotent there, and refuses NEW sales before any money moves. An incident never
 * pauses an order already paid, and never touches anything it does not name.
 *
 * Every write here takes the operator's scope and actor, is charged through the guard
 * (again inside its transaction), reads scope activity inside that transaction, is
 * idempotent (a key, or a conditional UPDATE naming its `from`), writes its audit row, its
 * timeline row and its outbox event in that same transaction, and records its operational
 * event through the ordinary recorder — which is how it reaches the Notification Center
 * and the Telegram operations group with no special case.
 */
export class IncidentService {
  constructor(private readonly deps: IncidentServiceDeps) {}

  // --- reads ----------------------------------------------------------------------------

  /**
   * One page, newest first, and the cursor of the page after it (Codex, #162: a list that
   * stopped at 100 hid every older incident). `cursor` is the previous page's `nextCursor`.
   */
  async list(
    scope: TenantContext,
    actor: ActorContext,
    cursor: string | null = null,
  ): Promise<{ readonly incidents: readonly IncidentView[]; readonly nextCursor: string | null }> {
    await this.deps.guard.check(scope, actor, INCIDENTS_VIEW);
    const after = cursor === null ? null : parseListCursor(cursor);
    const rows = await this.deps.repository.list(scope, INCIDENT_LIST_PAGE_SIZE + 1, after);
    const page = rows.slice(0, INCIDENT_LIST_PAGE_SIZE);
    const last = page[page.length - 1];
    return {
      incidents: await Promise.all(page.map(async (incident) => this.viewOf(scope, incident))),
      nextCursor:
        rows.length > INCIDENT_LIST_PAGE_SIZE && last !== undefined
          ? `${last.createdAt.toISOString()}_${last.id}`
          : null,
    };
  }

  async get(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
  ): Promise<IncidentView & { readonly timeline: readonly IncidentEventRecord[] }> {
    await this.deps.guard.check(scope, actor, INCIDENTS_VIEW);
    const incident = await this.require(scope, id);
    const [view, timeline] = await Promise.all([
      this.viewOf(scope, incident),
      this.deps.repository.timeline(scope, incident.id),
    ]);
    return { ...view, timeline };
  }

  /**
   * The Web Admin banner: ACTIVE incidents that asked for one. Every ADMINISTRATOR may read
   * it — the banner is how somebody without `incidents.view` learns that something is
   * going on — but nothing more than the title, kind, severity and window.
   */
  async banner(scope: TenantContext, actor: ActorContext): Promise<readonly IncidentRecord[]> {
    this.adminIdOf(actor);
    return this.deps.repository.banner(scope);
  }

  // --- writes ---------------------------------------------------------------------------

  async create(
    scope: TenantContext,
    actor: ActorContext,
    input: IncidentInput & { readonly idempotencyKey: string },
  ): Promise<IncidentView> {
    const denial = { action: 'incident.create', entityType: 'Incident', entityId: null };
    await this.authorize(scope, actor, INCIDENTS_MANAGE, denial);
    const now = this.deps.clock.now();
    const fields = await this.fieldsOf(scope, input, now, true);
    const requestHash = hashRequest({ op: 'incident.create', ...input });
    const replay = await this.deps.idempotency.find<{ id: string }>(
      scope,
      actor.surface,
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) return this.viewOf(scope, await this.require(scope, replay.result.id));

    const id = this.deps.ids.uuid();
    const status: IncidentStatus = fields.scheduledStartAt === null ? 'ACTIVE' : 'SCHEDULED';
    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      INCIDENTS_MANAGE,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        await this.deps.repository.insert(
          scope,
          {
            ...fields,
            id,
            status,
            startedAt: status === 'ACTIVE' ? now : null,
            createdByAdminId: this.adminIdOf(actor),
            now,
          },
          tx,
        );
        await this.event(
          scope,
          actor,
          id,
          'CREATED',
          { status, targets: fields.targets.length },
          now,
          tx,
        );
        if (status === 'SCHEDULED') {
          await this.event(
            scope,
            actor,
            id,
            'SCHEDULED',
            {
              startAt: fields.scheduledStartAt?.toISOString() ?? null,
              endAt: fields.scheduledEndAt?.toISOString() ?? null,
            },
            now,
            tx,
          );
        } else {
          await this.event(scope, actor, id, 'STARTED', null, now, tx);
        }
        await this.stateChanged(tx, actor, id, fields.kind, null, status);
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'incident.create',
            entityType: 'Incident',
            entityId: id,
            before: null,
            after: {
              kind: fields.kind,
              severity: fields.severity,
              status,
              title: fields.title,
              stopSales: fields.stopSales,
              targets: fields.targets,
            },
            result: 'SUCCESS',
          },
          tx,
        );
        await this.recordOps(
          scope,
          { id, kind: fields.kind, title: fields.title, severity: fields.severity },
          status === 'ACTIVE' ? 'started' : 'scheduled',
          tx,
        );
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          input.idempotencyKey,
          requestHash,
          { id },
          tx,
        );
      },
    );
    if (status === 'ACTIVE') await this.reconcile(scope, actor, id);
    return this.viewOf(scope, await this.require(scope, id));
  }

  /** Edits a SCHEDULED or ACTIVE incident at the version the editor read. */
  async update(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
    input: IncidentInput & { readonly idempotencyKey: string; readonly expectedVersion: number },
  ): Promise<IncidentView> {
    const denial = { action: 'incident.update', entityType: 'Incident', entityId: id };
    await this.authorize(scope, actor, INCIDENTS_MANAGE, denial);
    const now = this.deps.clock.now();
    const current = await this.require(scope, id);
    const fields = await this.fieldsOf(scope, input, now, current.status === 'SCHEDULED');
    const requestHash = hashRequest({ op: 'incident.update', id, ...input });
    const replay = await this.deps.idempotency.find<{ id: string }>(
      scope,
      actor.surface,
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) return this.viewOf(scope, await this.require(scope, id));

    let status: IncidentStatus = current.status;
    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      INCIDENTS_MANAGE,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const before = await this.deps.repository.lock(scope, id, tx);
        if (before === null) throw this.notFound();
        if (!ACTIVE_OR_SCHEDULED.includes(before.status)) throw this.stateConflict(before.status);
        if (before.version !== input.expectedVersion) throw this.versionConflict(before.version);
        // An ACTIVE incident keeps its start; only a SCHEDULED one may move its window.
        const effective: IncidentFields =
          before.status === 'ACTIVE'
            ? { ...fields, scheduledStartAt: before.scheduledStartAt }
            : fields;
        if (before.status === 'SCHEDULED' && effective.scheduledStartAt === null) {
          throw errors.validation(
            INCIDENT_ERROR_CODES.SCHEDULE_INVALID,
            'A scheduled window needs a start.',
          );
        }
        const updated = await this.deps.repository.update(
          scope,
          id,
          input.expectedVersion,
          effective,
          now,
          tx,
        );
        if (!updated) throw this.versionConflict(before.version);
        status = before.status;
        const scopeChanged =
          !sameTargets(before.targets, effective.targets) ||
          before.stopSales !== effective.stopSales;
        await this.event(
          scope,
          actor,
          id,
          scopeChanged ? 'SCOPE_CHANGED' : 'UPDATED',
          scopeChanged
            ? {
                before: { targets: before.targets, stopSales: before.stopSales },
                after: { targets: effective.targets, stopSales: effective.stopSales },
              }
            : null,
          now,
          tx,
        );
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'incident.update',
            entityType: 'Incident',
            entityId: id,
            before: {
              title: before.title,
              severity: before.severity,
              stopSales: before.stopSales,
              targets: before.targets,
            },
            after: {
              title: effective.title,
              severity: effective.severity,
              stopSales: effective.stopSales,
              targets: effective.targets,
            },
            result: 'SUCCESS',
          },
          tx,
        );
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          input.idempotencyKey,
          requestHash,
          { id },
          tx,
        );
      },
    );
    if (status === 'ACTIVE') await this.reconcile(scope, actor, id);
    return this.viewOf(scope, await this.require(scope, id));
  }

  /** SCHEDULED → ACTIVE, by an operator now (the scheduler does it at the start time). */
  async start(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
    input: { idempotencyKey: string; expectedVersion: number },
  ): Promise<IncidentView> {
    await this.transition(scope, actor, id, input, ['SCHEDULED'], 'ACTIVE', 'incident.start');
    await this.reconcile(scope, actor, id);
    return this.viewOf(scope, await this.require(scope, id));
  }

  /** ACTIVE → RESOLVED, then every effect this incident applied is restored. */
  async resolve(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
    input: { idempotencyKey: string; expectedVersion: number },
  ): Promise<IncidentView> {
    await this.transition(scope, actor, id, input, ['ACTIVE'], 'RESOLVED', 'incident.resolve');
    await this.reconcile(scope, actor, id);
    return this.viewOf(scope, await this.require(scope, id));
  }

  /** SCHEDULED → CANCELLED. A cancelled window applied nothing, so restores nothing. */
  async cancel(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
    input: { idempotencyKey: string; expectedVersion: number },
  ): Promise<IncidentView> {
    await this.transition(scope, actor, id, input, ['SCHEDULED'], 'CANCELLED', 'incident.cancel');
    return this.viewOf(scope, await this.require(scope, id));
  }

  /**
   * Brings the effects in line with the incident: applied on every target while it is
   * ACTIVE with `stopSales`, restored otherwise. The operator's explicit action after a
   * scheduled start (the scheduler cannot act under a module's key), and a retry after a
   * module refused. Charged `incidents.manage`, and each module call its own key.
   */
  async applyEffects(scope: TenantContext, actor: ActorContext, id: string): Promise<IncidentView> {
    const denial = { action: 'incident.effects', entityType: 'Incident', entityId: id };
    await this.authorize(scope, actor, INCIDENTS_MANAGE, denial);
    await this.require(scope, id);
    await this.reconcile(scope, actor, id);
    const after = await this.require(scope, id);
    /*
     * The "effects pending" condition closes only when every effect the incident wants is
     * in force — APPLIED, or ALREADY withdrawn. A FAILED one (an operator without the
     * module's key) leaves it open: the stop-sale the window asked for has not happened,
     * and the inbox must keep saying so (Codex, #162).
     */
    if (await this.effectsInForce(scope, after)) {
      await this.deps.uow.run(scope, async (tx) => {
        await this.assertScopeActive(scope, tx);
        await this.clearEffectsPending(scope, after, tx);
      });
    }
    return this.viewOf(scope, after);
  }

  /** How many customers a notice would reach now — the count the confirmation repeats. */
  async noticePreview(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
  ): Promise<{ recipients: number; version: number }> {
    await this.deps.guard.check(scope, actor, INCIDENTS_NOTIFY);
    const incident = await this.require(scope, id);
    const audience = await this.deps.repository.audience(
      scope,
      incident,
      await this.panelsOf(scope, incident),
    );
    return { recipients: audience.length, version: incident.version };
  }

  /**
   * The customer notice: one INCIDENT_NOTICE per affected customer on the notification
   * lane, in ONE transaction with the communication record, the timeline, the audit row.
   * The confirmation names the version and the count the preview showed; anything else is
   * refused, so a preview authorises only the send it described (ADR-0010's shape).
   */
  async notify(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
    input: {
      readonly idempotencyKey: string;
      readonly expectedVersion: number;
      readonly expectedRecipients: number;
    },
  ): Promise<IncidentView & { readonly queued: number }> {
    const denial = { action: 'incident.notify', entityType: 'Incident', entityId: id };
    await this.authorize(scope, actor, INCIDENTS_NOTIFY, denial);
    const requestHash = hashRequest({ op: 'incident.notify', id, ...input });
    const replay = await this.deps.idempotency.find<{ queued: number }>(
      scope,
      actor.surface,
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      return {
        ...(await this.viewOf(scope, await this.require(scope, id))),
        queued: replay.result.queued,
      };
    }
    const queued = await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      INCIDENTS_NOTIFY,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const incident = await this.deps.repository.lock(scope, id, tx);
        if (incident === null) throw this.notFound();
        if (!ACTIVE_OR_SCHEDULED.includes(incident.status))
          throw this.stateConflict(incident.status);
        if (incident.version !== input.expectedVersion)
          throw this.versionConflict(incident.version);
        if (incident.customerMessage === null) {
          throw errors.validation(
            INCIDENT_ERROR_CODES.NOTICE_REFUSED,
            'Write a customer message first.',
            { reason: 'NO_MESSAGE' },
          );
        }
        const audience = await this.deps.repository.audience(
          scope,
          incident,
          await this.panelsOf(scope, incident),
          tx,
        );
        if (audience.length !== input.expectedRecipients) {
          throw errors.conflict(
            INCIDENT_ERROR_CODES.NOTICE_REFUSED,
            'The affected customers changed since the preview; preview again.',
            {
              reason: 'COUNT_CHANGED',
              recipients: audience.length,
            },
          );
        }
        const now = this.deps.clock.now();
        const communicationId = this.deps.ids.uuid();
        await this.deps.repository.insertCommunication(
          scope,
          {
            id: communicationId,
            incidentId: id,
            message: incident.customerMessage,
            recipients: audience.length,
            sentByAdminId: this.adminIdOf(actor),
            now,
          },
          tx,
        );
        let count = 0;
        for (const member of audience) {
          const noticeId = this.deps.ids.uuid();
          await this.deps.repository.insertNotice(
            scope,
            { id: noticeId, communicationId, incidentId: id, customerId: member.customerId, now },
            tx,
          );
          if (
            await this.deps.notifier.notifyThrough(
              scope,
              member.customerId as UserId,
              member.botInstanceId as BotInstanceId,
              'INCIDENT_NOTICE',
              noticeId,
              now,
              tx,
            )
          )
            count += 1;
        }
        await this.event(
          scope,
          actor,
          id,
          'COMMUNICATED',
          { communicationId, recipients: count },
          now,
          tx,
        );
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'incident.notify',
            entityType: 'Incident',
            entityId: id,
            before: null,
            after: {
              communicationId,
              recipients: count,
              messageLength: Array.from(incident.customerMessage).length,
            },
            result: 'SUCCESS',
          },
          tx,
        );
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          input.idempotencyKey,
          requestHash,
          { queued: count },
          tx,
        );
        return count;
      },
    );
    return { ...(await this.viewOf(scope, await this.require(scope, id))), queued };
  }

  // --- the scheduler ----------------------------------------------------------------------

  /**
   * One scheduler pass for a tenant: every SCHEDULED window whose start has come becomes
   * ACTIVE, as a system job holding `maintenance.run` and nothing else. Effects are NOT
   * applied here — each needs its module's key, which a system job does not hold — so a
   * window with effects records EFFECTS_PENDING and a WARN the Notification Center shows,
   * and an operator applies them with one action. Two worker replicas are safe: the
   * transition is conditional on SCHEDULED, so each window starts once.
   */
  async startDue(scope: TenantContext): Promise<number> {
    const actor = systemJobActor('incident-scheduler', this.deps.ids.uuid() as CorrelationId);
    if (!(await this.deps.guard.has(scope, actor, INCIDENT_SCHEDULER_PERMISSION))) return 0;
    const now = this.deps.clock.now();
    let started = 0;
    for (const id of await this.deps.repository.dueToStart(scope, now)) {
      const moved = await this.deps.uow.run(scope, async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return false;
        const incident = await this.deps.repository.lock(scope, id, tx);
        if (incident === null || incident.status !== 'SCHEDULED') return false;
        const ok = await this.deps.repository.transition(
          scope,
          id,
          { from: ['SCHEDULED'], to: 'ACTIVE', expectedVersion: null, now },
          tx,
        );
        if (!ok) return false;
        await this.event(scope, actor, id, 'STARTED', { scheduled: true }, now, tx);
        await this.stateChanged(tx, actor, id, incident.kind, 'SCHEDULED', 'ACTIVE');
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'incident.start',
            entityType: 'Incident',
            entityId: id,
            before: { status: 'SCHEDULED' },
            after: { status: 'ACTIVE', scheduled: true },
            result: 'SUCCESS',
          },
          tx,
        );
        await this.recordOps(scope, incident, 'started', tx);
        if (incident.stopSales && incident.targets.length > 0) {
          await this.event(
            scope,
            actor,
            id,
            'EFFECTS_PENDING',
            { targets: incident.targets.length },
            now,
            tx,
          );
          await this.deps.opsLog.record(
            scope,
            {
              code: incidentOpsCode(incident.kind, 'effects_pending'),
              severity: 'WARN',
              message: `"${incident.title}" started on schedule; its sales stops wait for an operator to apply them.`,
              dedupeKey: `${incidentConditionKey(id)}:effects`,
              context: { incidentId: id },
            },
            tx,
          );
        }
        return true;
      });
      if (moved) started += 1;
    }
    return started;
  }

  // --- the lane's half --------------------------------------------------------------------

  /** What an INCIDENT_NOTICE renders, read from its communication at send time. */
  async noticeFacts(
    scope: TenantContext,
    noticeId: string,
  ): Promise<{ readonly values: { message: string } } | null> {
    const facts = await this.deps.repository.noticeFacts(scope, noticeId);
    return facts === null ? null : { values: { message: facts.message } };
  }

  // --- effects --------------------------------------------------------------------------

  /**
   * Desired effects: every target's, while ACTIVE with `stopSales`; none otherwise. Each is
   * CLAIMED before its module is called (a row insert, or a conditional update), so it runs
   * once however many callers race; each module call is idempotent by a key derived from
   * the incident and the subject. A refusal is recorded FAILED and changes nothing; it
   * never stops the other effects.
   */
  private async reconcile(scope: TenantContext, actor: ActorContext, id: string): Promise<void> {
    let incident = await this.require(scope, id);
    let desired = await this.desiredOf(scope, incident);
    const marker = markerOf(incident);

    for (const [, effect] of desired) {
      const claim = await this.claimWaiting(
        scope,
        effect.kind,
        effect.subjectRef,
        (tx, staleBefore) =>
          this.deps.repository.claimApply(
            scope,
            {
              incidentId: id,
              kind: effect.kind,
              targetKind: effect.target.kind,
              targetRef: effect.target.ref,
              subjectRef: effect.subjectRef,
              staleBefore,
              now: this.deps.clock.now(),
            },
            tx,
          ),
      );
      if (claim === 'BUSY') {
        await this.deps.uow.run(scope, async (tx) => {
          await this.assertScopeActive(scope, tx);
          const now = this.deps.clock.now();
          const marked = await this.deps.repository.markContended(
            scope,
            {
              incidentId: id,
              kind: effect.kind,
              targetKind: effect.target.kind,
              targetRef: effect.target.ref,
              subjectRef: effect.subjectRef,
              now,
            },
            tx,
          );
          if (marked) {
            await this.event(
              scope,
              actor,
              id,
              'EFFECT',
              {
                step: 'apply',
                kind: effect.kind,
                subjectRef: effect.subjectRef,
                state: 'FAILED',
                errorCode: 'incident.effect_contended',
              },
              now,
              tx,
            );
          }
        });
        continue;
      }
      if (claim !== 'CLAIMED') continue;
      let state: 'APPLIED' | 'ALREADY' | 'FAILED' = 'FAILED';
      let errorCode: string | null = null;
      try {
        const before = await this.deps.effects.status(scope, effect.kind, effect.subjectRef);
        if (before === null) {
          errorCode = INCIDENT_ERROR_CODES.TARGET_INVALID;
        } else if (before.inForce) {
          // A drain carrying this incident's marker is ours — a claim taken over from a
          // process that applied it and died before settling. Anything else predates us.
          state = effect.kind === 'PANEL_DRAIN' && before.marker === marker ? 'APPLIED' : 'ALREADY';
        } else {
          await this.deps.effects.set(scope, actor, {
            kind: effect.kind,
            subjectRef: effect.subjectRef,
            inForce: true,
            idempotencyKey: effectKey(incident, effect.kind, effect.subjectRef, 'on'),
            marker,
          });
          state = 'APPLIED';
        }
      } catch (error) {
        errorCode = this.failureCode(error);
      }
      await this.settleApply(scope, actor, id, effect.kind, effect.subjectRef, state, errorCode);
    }

    /*
     * Asked AGAIN after the apply pass (Codex, #162). A resolution that committed while an
     * effect was being applied found that effect PENDING and could not restore it; it is
     * settled APPLIED only now, so this pass — which re-reads the incident after its own
     * settles — is the one that sees RESOLVED and restores it. Without this a stop-sale
     * outlived the incident that made it.
     */
    incident = await this.require(scope, id);
    desired = await this.desiredOf(scope, incident);

    // Everything applied that is no longer desired is restored — or handed to another
    // incident that still wants it — and only if it is still as this incident left it.
    for (const effect of await this.deps.repository.effects(scope, id)) {
      if (desired.has(`${effect.kind}:${effect.subjectRef}`)) continue;
      if (effect.state !== 'APPLIED' && effect.state !== 'REVERTING') continue;
      let handed = false;
      const claim = await this.claimWaiting(
        scope,
        effect.kind,
        effect.subjectRef,
        async (tx, staleBefore) => {
          const claimed = await this.deps.repository.claimRevert(
            scope,
            {
              incidentId: id,
              kind: effect.kind,
              subjectRef: effect.subjectRef,
              staleBefore,
              now: this.deps.clock.now(),
            },
            tx,
          );
          if (claimed !== 'CLAIMED') return claimed;
          handed = await this.handOver(scope, actor, id, effect.kind, effect.subjectRef, tx);
          return claimed;
        },
      );
      if (claim !== 'CLAIMED' || handed) continue;
      let state: 'REVERTED' | 'KEPT' | 'APPLIED' = 'APPLIED';
      let errorCode: string | null = null;
      try {
        const now = await this.deps.effects.status(scope, effect.kind, effect.subjectRef);
        const ours =
          now !== null &&
          now.inForce &&
          (effect.kind !== 'PANEL_DRAIN' ||
            (await this.markerIsOurs(scope, now.marker, marker, effect.kind, effect.subjectRef)));
        if (!ours) {
          state = 'KEPT';
        } else {
          await this.deps.effects.set(scope, actor, {
            kind: effect.kind,
            subjectRef: effect.subjectRef,
            inForce: false,
            idempotencyKey: effectKey(incident, effect.kind, effect.subjectRef, 'off'),
            marker,
          });
          state = 'REVERTED';
        }
      } catch (error) {
        // Still applied: a later reconcile (the operator's "apply effects") tries again.
        errorCode = this.failureCode(error);
      }
      await this.settle(
        scope,
        actor,
        id,
        effect.kind,
        effect.subjectRef,
        'REVERTING',
        state,
        errorCode,
        'revert',
      );
    }
  }

  /** What the incident wants withdrawn now: every target's subject while ACTIVE with stop-sales. */
  private async desiredOf(
    scope: TenantContext,
    incident: IncidentRecord,
  ): Promise<
    Map<string, { kind: IncidentEffectKind; target: IncidentTarget; subjectRef: string }>
  > {
    const desired = new Map<
      string,
      { kind: IncidentEffectKind; target: IncidentTarget; subjectRef: string }
    >();
    if (incident.status === 'ACTIVE' && incident.stopSales) {
      for (const target of incident.targets) {
        const resolved = await this.deps.effects.resolve(scope, target);
        if (resolved !== null) {
          desired.set(`${resolved.kind}:${resolved.subjectRef}`, {
            kind: resolved.kind,
            target,
            subjectRef: resolved.subjectRef,
          });
        }
      }
    }
    return desired;
  }

  /** Whether every effect the incident wants is in force: APPLIED or ALREADY, each one. */
  private async effectsInForce(scope: TenantContext, incident: IncidentRecord): Promise<boolean> {
    const desired = await this.desiredOf(scope, incident);
    if (desired.size === 0) return true;
    const effects = await this.deps.repository.effects(scope, incident.id);
    return [...desired.values()].every((wanted) =>
      effects.some(
        (effect) =>
          effect.kind === wanted.kind &&
          effect.subjectRef === wanted.subjectRef &&
          (effect.state === 'APPLIED' || effect.state === 'ALREADY'),
      ),
    );
  }

  /**
   * A claim on one subject, under the subject's lock, waiting while ANOTHER incident holds a
   * live claim on it: at most one change per subject is in flight across every incident, so
   * a hand-over or an adoption is decided with nothing moving underneath it. `BUSY` after
   * the wait is recorded by the caller as a contended FAILED effect, retried by "apply".
   */
  private async claimWaiting(
    scope: TenantContext,
    kind: IncidentEffectKind,
    subjectRef: string,
    claim: (tx: TransactionScope, staleBefore: Date) => Promise<EffectClaim>,
  ): Promise<EffectClaim> {
    for (let attempt = 0; ; attempt += 1) {
      const answer = await this.deps.uow.run(scope, async (tx) => {
        await this.assertScopeActive(scope, tx);
        await this.deps.repository.lockSubject(scope, kind, subjectRef, tx);
        const staleBefore = new Date(
          this.deps.clock.now().getTime() - INCIDENT_EFFECT_CLAIM_STALE_MS,
        );
        return claim(tx, staleBefore);
      });
      if (answer !== 'BUSY' || attempt >= CLAIM_WAIT_ATTEMPTS) return answer;
      await new Promise((resolve) => setTimeout(resolve, CLAIM_WAIT_MS));
    }
  }

  /**
   * At this incident's end (or a scope change), under the subject's lock and holding its
   * REVERTING claim: when another incident still wants the subject withdrawn, nothing is
   * restored — that incident takes ownership (its ALREADY or FAILED row becomes APPLIED, it
   * restores the subject when IT ends) and this one is HANDED_OVER. An incident that already
   * owns it (APPLIED) needs no hand-over. True when the subject was handed over.
   */
  private async handOver(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
    kind: IncidentEffectKind,
    subjectRef: string,
    tx: TransactionScope,
  ): Promise<boolean> {
    const peers = (
      await this.deps.repository.subjectPeers(scope, { incidentId: id, kind, subjectRef }, tx)
    ).filter((peer) => peer.wants);
    if (peers.length === 0) return false;
    const now = this.deps.clock.now();
    const owner = peers.find((peer) => peer.state === 'APPLIED');
    if (owner === undefined) {
      const heir = peers.find((peer) => peer.state === 'ALREADY' || peer.state === 'FAILED');
      if (heir === undefined) return false;
      const adopted = await this.deps.repository.settleEffect(
        scope,
        {
          incidentId: heir.incidentId,
          kind,
          subjectRef,
          from: heir.state,
          state: 'APPLIED',
          errorCode: null,
          now,
        },
        tx,
      );
      if (!adopted) return false;
      await this.event(
        scope,
        actor,
        heir.incidentId,
        'EFFECT',
        { step: 'adopt', kind, subjectRef, state: 'APPLIED', from: id },
        now,
        tx,
      );
    }
    await this.deps.repository.settleEffect(
      scope,
      {
        incidentId: id,
        kind,
        subjectRef,
        from: 'REVERTING',
        state: 'HANDED_OVER',
        errorCode: null,
        now,
      },
      tx,
    );
    await this.event(
      scope,
      actor,
      id,
      'EFFECT',
      {
        step: 'revert',
        kind,
        subjectRef,
        state: 'HANDED_OVER',
        to: (owner ?? peers[0])?.incidentId ?? null,
      },
      now,
      tx,
    );
    return true;
  }

  /**
   * Settles an apply under the subject's lock. An ALREADY outcome first looks for an ORPHANED
   * owner — another incident's APPLIED row whose incident no longer wants the subject (it
   * ended while this claim was in flight, and so could not hand over) — and adopts it: this
   * incident becomes the owner and restores the subject when it ends.
   */
  private async settleApply(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
    kind: IncidentEffectKind,
    subjectRef: string,
    outcome: 'APPLIED' | 'ALREADY' | 'FAILED',
    errorCode: string | null,
  ): Promise<void> {
    await this.deps.uow.run(scope, async (tx) => {
      await this.deps.repository.lockSubject(scope, kind, subjectRef, tx);
      const now = this.deps.clock.now();
      let state = outcome;
      let adoptedFrom: string | null = null;
      if (outcome === 'ALREADY') {
        const orphan = (
          await this.deps.repository.subjectPeers(scope, { incidentId: id, kind, subjectRef }, tx)
        ).find((peer) => peer.state === 'APPLIED' && !peer.wants);
        if (
          orphan !== undefined &&
          (await this.deps.repository.settleEffect(
            scope,
            {
              incidentId: orphan.incidentId,
              kind,
              subjectRef,
              from: 'APPLIED',
              state: 'HANDED_OVER',
              errorCode: null,
              now,
            },
            tx,
          ))
        ) {
          state = 'APPLIED';
          adoptedFrom = orphan.incidentId;
          await this.event(
            scope,
            actor,
            orphan.incidentId,
            'EFFECT',
            { step: 'revert', kind, subjectRef, state: 'HANDED_OVER', to: id },
            now,
            tx,
          );
        }
      }
      const settled = await this.deps.repository.settleEffect(
        scope,
        { incidentId: id, kind, subjectRef, from: 'PENDING', state, errorCode, now },
        tx,
      );
      if (!settled) return;
      await this.event(
        scope,
        actor,
        id,
        'EFFECT',
        {
          step: adoptedFrom === null ? 'apply' : 'adopt',
          kind,
          subjectRef,
          state,
          errorCode,
          ...(adoptedFrom === null ? {} : { from: adoptedFrom }),
        },
        now,
        tx,
      );
    });
  }

  /**
   * Whether a drain's reason is this incident's — or the marker of an incident that handed
   * its withdrawal of this subject over, which is how an adopted drain is recognised: a
   * drain cannot be re-marked while it holds, so ownership is read from the hand-over.
   */
  private async markerIsOurs(
    scope: TenantContext,
    found: string | null,
    mine: string,
    kind: IncidentEffectKind,
    subjectRef: string,
  ): Promise<boolean> {
    if (found === mine) return true;
    if (found === null || !found.startsWith('incident:')) return false;
    const from = found.slice('incident:'.length);
    if (!isIncidentId(from)) return false;
    return this.deps.repository.handedOver(scope, { incidentId: from, kind, subjectRef });
  }

  private async settle(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
    kind: IncidentEffectKind,
    subjectRef: string,
    from: 'PENDING' | 'REVERTING',
    state: 'APPLIED' | 'ALREADY' | 'FAILED' | 'REVERTED' | 'KEPT',
    errorCode: string | null,
    step: 'apply' | 'revert',
  ): Promise<void> {
    await this.deps.uow.run(scope, async (tx) => {
      await this.deps.repository.lockSubject(scope, kind, subjectRef, tx);
      const now = this.deps.clock.now();
      const settled = await this.deps.repository.settleEffect(
        scope,
        { incidentId: id, kind, subjectRef, from, state, errorCode, now },
        tx,
      );
      if (!settled) return;
      await this.event(
        scope,
        actor,
        id,
        'EFFECT',
        { step, kind, subjectRef, state, errorCode },
        now,
        tx,
      );
    });
  }

  private failureCode(error: unknown): string {
    if (isNexaError(error)) return error.code.slice(0, 100);
    this.deps.logger.error(
      { err: error instanceof Error ? error.name : 'unknown' },
      'incident effect failed',
    );
    return 'incident.effect_failed';
  }

  // --- helpers ----------------------------------------------------------------------------

  private async transition(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
    input: { readonly idempotencyKey: string; readonly expectedVersion: number },
    from: readonly IncidentStatus[],
    to: IncidentStatus,
    action: string,
  ): Promise<void> {
    const denial = { action, entityType: 'Incident', entityId: id };
    await this.authorize(scope, actor, INCIDENTS_MANAGE, denial);
    const requestHash = hashRequest({ op: action, id, expectedVersion: input.expectedVersion });
    const replay = await this.deps.idempotency.find<{ id: string }>(
      scope,
      actor.surface,
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) return;
    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      INCIDENTS_MANAGE,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const before = await this.deps.repository.lock(scope, id, tx);
        if (before === null) throw this.notFound();
        if (!from.includes(before.status)) throw this.stateConflict(before.status);
        if (before.version !== input.expectedVersion) throw this.versionConflict(before.version);
        const now = this.deps.clock.now();
        const moved = await this.deps.repository.transition(
          scope,
          id,
          { from, to, expectedVersion: input.expectedVersion, now },
          tx,
        );
        if (!moved) throw this.versionConflict(before.version);
        const kind: IncidentEventKind =
          to === 'ACTIVE' ? 'STARTED' : to === 'RESOLVED' ? 'RESOLVED' : 'CANCELLED';
        await this.event(scope, actor, id, kind, null, now, tx);
        await this.stateChanged(tx, actor, id, before.kind, before.status, to);
        await this.deps.audit.record(
          scope,
          actor,
          {
            action,
            entityType: 'Incident',
            entityId: id,
            before: { status: before.status },
            after: { status: to },
            result: 'SUCCESS',
          },
          tx,
        );
        await this.recordOps(
          scope,
          before,
          to === 'ACTIVE' ? 'started' : to === 'RESOLVED' ? 'resolved' : 'cancelled',
          tx,
        );
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          input.idempotencyKey,
          requestHash,
          { id },
          tx,
        );
      },
    );
  }

  /**
   * The operational record, through the ordinary recorder. `started` opens one condition per
   * incident (its dedupe key); `resolved` is its RECOVERY, which closes it — so the
   * Notification Center shows the incident while it runs and marks it resolved after.
   */
  private async recordOps(
    scope: TenantContext,
    incident: Pick<IncidentRecord, 'id' | 'kind' | 'title' | 'severity'>,
    what: 'scheduled' | 'started' | 'resolved' | 'cancelled',
    tx: TransactionScope,
  ): Promise<void> {
    const key = incidentConditionKey(incident.id);
    const context = { incidentId: incident.id };
    if (what === 'started') {
      await this.deps.opsLog.record(
        scope,
        {
          code: incidentOpsCode(incident.kind, 'started'),
          severity:
            incident.severity === 'MINOR'
              ? 'WARN'
              : incident.severity === 'MAJOR'
                ? 'ERROR'
                : 'CRITICAL',
          message: `${incident.kind === 'INCIDENT' ? 'Incident' : 'Maintenance'} started: ${incident.title}`,
          dedupeKey: key,
          context,
        },
        tx,
      );
      return;
    }
    if (what === 'resolved') {
      await this.deps.opsLog.record(
        scope,
        {
          code: incidentOpsCode(incident.kind, 'resolved'),
          severity: 'INFO',
          message: `${incident.kind === 'INCIDENT' ? 'Incident' : 'Maintenance'} resolved: ${incident.title}`,
          context,
          recoversCode: incidentOpsCode(incident.kind, 'started'),
          recoversDedupeKey: key,
        },
        tx,
      );
      await this.clearEffectsPending(scope, incident, tx);
      return;
    }
    await this.deps.opsLog.record(
      scope,
      {
        code: incidentOpsCode(incident.kind, what),
        severity: 'INFO',
        message: `${incident.kind === 'INCIDENT' ? 'Incident' : 'Maintenance'} ${what}: ${incident.title}`,
        context,
      },
      tx,
    );
  }

  /**
   * Closes the scheduler's "effects pending" condition, when one is open: once the effects
   * were reconciled by an operator, or the incident is over. Asked of the open set first,
   * so a resolution that has nothing pending records no recovery row.
   */
  private async clearEffectsPending(
    scope: TenantContext,
    incident: Pick<IncidentRecord, 'id' | 'kind' | 'title'>,
    tx?: TransactionScope,
  ): Promise<void> {
    const key = `${incidentConditionKey(incident.id)}:effects`;
    if (!(await this.deps.conditions.conditionIsOpen(scope, key, tx))) return;
    await this.deps.opsLog.record(
      scope,
      {
        code: `${incidentOpsCode(incident.kind, 'effects_pending')}_cleared`,
        severity: 'INFO',
        message: `Effects of "${incident.title}" are no longer pending.`,
        context: { incidentId: incident.id },
        recoversCode: incidentOpsCode(incident.kind, 'effects_pending'),
        recoversDedupeKey: key,
      },
      tx,
    );
  }

  private async event(
    scope: TenantContext,
    actor: ActorContext,
    incidentId: string,
    kind: IncidentEventKind,
    detail: Record<string, unknown> | null,
    now: Date,
    tx: TransactionScope,
  ): Promise<void> {
    await this.deps.repository.appendEvent(
      scope,
      { id: this.deps.ids.uuid(), incidentId, kind, actor, detail, now },
      tx,
    );
  }

  private async stateChanged(
    tx: TransactionScope,
    actor: ActorContext,
    id: string,
    kind: IncidentRecord['kind'],
    from: IncidentStatus | null,
    to: IncidentStatus,
  ): Promise<void> {
    await this.deps.outbox.write(tx, actor, {
      eventType: 'IncidentStateChanged',
      aggregateType: 'Incident',
      aggregateId: id,
      payload: { incidentId: id, kind, from, to },
    });
  }

  /** Validates the fields: the window against the clock, every target against the tenant. */
  private async fieldsOf(
    scope: TenantContext,
    input: IncidentInput,
    now: Date,
    mayBeScheduled: boolean,
  ): Promise<IncidentFields> {
    const startAt = input.scheduledStartAt === null ? null : new Date(input.scheduledStartAt);
    const endAt = input.scheduledEndAt === null ? null : new Date(input.scheduledEndAt);
    if (mayBeScheduled && startAt !== null && startAt.getTime() <= now.getTime()) {
      throw errors.validation(
        INCIDENT_ERROR_CODES.SCHEDULE_INVALID,
        'A scheduled start must be in the future.',
      );
    }
    if (endAt !== null && endAt.getTime() <= (startAt ?? now).getTime()) {
      throw errors.validation(
        INCIDENT_ERROR_CODES.SCHEDULE_INVALID,
        'The end must come after the start.',
      );
    }
    const unique = new Map<string, IncidentTarget>();
    for (const target of input.targets) unique.set(`${target.kind}:${target.ref}`, target);
    for (const target of unique.values()) {
      if (
        !isValidIncidentTarget(target) ||
        (await this.deps.effects.resolve(scope, target)) === null
      ) {
        throw errors.validation(
          INCIDENT_ERROR_CODES.TARGET_INVALID,
          'A target is not part of this installation.',
          { target },
        );
      }
    }
    return {
      kind: input.kind,
      severity: input.severity,
      title: input.title.trim(),
      description: input.description.trim(),
      customerMessage:
        input.customerMessage === null || input.customerMessage.trim() === ''
          ? null
          : input.customerMessage.trim(),
      stopSales: input.stopSales,
      adminBanner: input.adminBanner,
      scheduledStartAt: mayBeScheduled ? startAt : null,
      scheduledEndAt: endAt,
      targets: [...unique.values()],
    };
  }

  /** The panels a notice's audience is read from: PANEL targets, and each LOCATION's panel. */
  private async panelsOf(scope: TenantContext, incident: IncidentRecord): Promise<string[]> {
    const panels = new Set<string>();
    for (const target of incident.targets) {
      if (target.kind === 'PANEL') panels.add(target.ref);
      if (target.kind === 'LOCATION') {
        const panel = await this.deps.effects.panelOfLocation(scope, target.ref);
        if (panel !== null) panels.add(panel);
      }
    }
    return [...panels];
  }

  private async viewOf(scope: TenantContext, incident: IncidentRecord): Promise<IncidentView> {
    return { incident, effects: await this.deps.repository.effects(scope, incident.id) };
  }

  private async require(scope: TenantContext, id: string): Promise<IncidentRecord> {
    // A strict UUID: anything else would reach the database's uuid cast and fail there as a
    // 500 rather than the NOT_FOUND it is (Codex, #162).
    if (!isIncidentId(id)) throw this.notFound();
    const incident = await this.deps.repository.find(scope, id);
    if (incident === null) throw this.notFound();
    return incident;
  }

  private adminIdOf(actor: ActorContext): string {
    if ((actor.type === 'WEB_ADMIN' || actor.type === 'TELEGRAM_ADMIN') && actor.id !== null)
      return actor.id;
    throw errors.permissionDenied(
      PLATFORM_ERROR_CODES.PERMISSION_DENIED,
      'Only an administrator can do this.',
    );
  }

  private notFound() {
    return errors.notFound(INCIDENT_ERROR_CODES.NOT_FOUND, 'No such incident.');
  }

  private stateConflict(status: IncidentStatus) {
    return errors.conflict(
      INCIDENT_ERROR_CODES.STATE_CONFLICT,
      'That is not possible for this incident now.',
      { status },
    );
  }

  private versionConflict(version: number) {
    return errors.conflict(
      INCIDENT_ERROR_CODES.VERSION_CONFLICT,
      'This incident changed since it was opened; reload it.',
      { version },
    );
  }

  private async authorize(
    scope: TenantContext,
    actor: ActorContext,
    permission: PermissionKey,
    denial: { action: string; entityType: string; entityId: string | null },
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, permission);
    } catch (error) {
      await recordMutationDenial(this.mutationDeps(), scope, actor, permission, denial, error);
      throw error;
    }
  }

  private async assertScopeActive(scope: TenantContext, tx: TransactionScope): Promise<void> {
    if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'This installation has stopped accepting work.',
      );
    }
  }

  private mutationDeps() {
    return {
      uow: this.deps.uow,
      guard: this.deps.guard,
      audit: this.deps.audit,
      opsLog: this.deps.opsLog,
      sessions: this.deps.sessions,
      clock: this.deps.clock,
    };
  }
}

/** The mark a drain carries so its revert can tell it apart from an operator's own drain. */
/**
 * The key a module write carries. The incident's VERSION is part of it: an effect is applied
 * at most once and reverted at most once per version (a revert needs an edit or a resolve,
 * each a new version), so a re-apply after an edit took it off is a new command — with the
 * bare `incident:<id>:<kind>:<subject>:on` it was a replay, the module answered with the
 * first result, changed nothing, and the effect was recorded APPLIED while not in force.
 */
function effectKey(
  incident: { readonly id: string; readonly version: number },
  kind: IncidentEffectKind,
  subjectRef: string,
  step: 'on' | 'off',
): string {
  return `incident:${incident.id}:v${incident.version}:${kind}:${subjectRef}:${step}`;
}

/** How long a claim waits for another incident's claim on the same subject: 50 × 100 ms. */
const CLAIM_WAIT_ATTEMPTS = 50;
const CLAIM_WAIT_MS = 100;

/** The list cursor `createdAt_id`, shape-checked by the contract's query schema. */
function parseListCursor(cursor: string): { createdAt: Date; id: string } {
  const at = cursor.lastIndexOf('_');
  const createdAt = new Date(cursor.slice(0, at));
  const id = cursor.slice(at + 1);
  if (at < 0 || Number.isNaN(createdAt.getTime()) || !isIncidentId(id)) {
    throw errors.validation(INCIDENT_ERROR_CODES.NOT_FOUND, 'Not a list cursor.');
  }
  return { createdAt, id };
}

export function markerOf(incident: Pick<IncidentRecord, 'id'>): string {
  return `incident:${incident.id}`;
}

function sameTargets(a: readonly IncidentTarget[], b: readonly IncidentTarget[]): boolean {
  const key = (list: readonly IncidentTarget[]) =>
    list
      .map((t) => `${t.kind}:${t.ref}`)
      .sort()
      .join('|');
  return key(a) === key(b);
}
