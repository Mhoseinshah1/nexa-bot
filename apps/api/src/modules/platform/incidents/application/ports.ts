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
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';

export interface IncidentRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: IncidentKind;
  readonly severity: IncidentSeverity;
  readonly status: IncidentStatus;
  readonly title: string;
  readonly description: string;
  readonly customerMessage: string | null;
  readonly stopSales: boolean;
  readonly adminBanner: boolean;
  readonly scheduledStartAt: Date | null;
  readonly scheduledEndAt: Date | null;
  readonly startedAt: Date | null;
  readonly resolvedAt: Date | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly targets: readonly IncidentTarget[];
}

export interface IncidentEffectRecord {
  readonly kind: IncidentEffectKind;
  readonly targetKind: IncidentTargetKind;
  readonly targetRef: string;
  readonly subjectRef: string;
  readonly state: IncidentEffectState;
  readonly errorCode: string | null;
  readonly updatedAt: Date;
}

export interface IncidentEventRecord {
  readonly id: string;
  readonly kind: IncidentEventKind;
  readonly actorLabel: string | null;
  readonly detail: Record<string, unknown> | null;
  readonly occurredAt: Date;
}

/** The editable fields, as the service has validated them. */
export interface IncidentFields {
  readonly kind: IncidentKind;
  readonly severity: IncidentSeverity;
  readonly title: string;
  readonly description: string;
  readonly customerMessage: string | null;
  readonly stopSales: boolean;
  readonly adminBanner: boolean;
  readonly scheduledStartAt: Date | null;
  readonly scheduledEndAt: Date | null;
  readonly targets: readonly IncidentTarget[];
}

/**
 * A claim's answer. `BUSY`: another incident holds a live claim on the same subject — the
 * caller waits and asks again. `SETTLED`: this incident's row is in a state the claim does
 * not take (already applied, already restored).
 */
export type EffectClaim = 'CLAIMED' | 'BUSY' | 'SETTLED';

/** Another incident's row on a subject, and whether that incident still wants it withdrawn. */
export interface SubjectPeer {
  readonly incidentId: string;
  readonly state: IncidentEffectState;
  /** The peer incident is ACTIVE with stop-sales on: it wants the subject withdrawn. */
  readonly wants: boolean;
}

export interface IncidentRepository {
  insert(
    scope: TenantContext,
    input: IncidentFields & {
      readonly id: string;
      readonly status: IncidentStatus;
      readonly startedAt: Date | null;
      readonly createdByAdminId: string | null;
      readonly now: Date;
    },
    tx: TransactionScope,
  ): Promise<void>;
  find(scope: TenantContext, id: string, tx?: unknown): Promise<IncidentRecord | null>;
  /** `FOR UPDATE`. */
  lock(scope: TenantContext, id: string, tx: TransactionScope): Promise<IncidentRecord | null>;
  /** Newest first; `after` is the last row of the previous page (a keyset cursor). */
  list(
    scope: TenantContext,
    limit: number,
    after?: { readonly createdAt: Date; readonly id: string } | null,
  ): Promise<readonly IncidentRecord[]>;
  /** ACTIVE incidents that asked for a banner. */
  banner(scope: TenantContext): Promise<readonly IncidentRecord[]>;
  /** Edits the fields and replaces the targets, conditional on the version. */
  update(
    scope: TenantContext,
    id: string,
    expectedVersion: number,
    fields: IncidentFields,
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean>;
  /**
   * One conditional transition, naming its `from` statuses: `startedAt` / `resolvedAt` as
   * the target status requires. False when the row was not in a `from` status (or not at
   * `expectedVersion`, when one is given).
   */
  transition(
    scope: TenantContext,
    id: string,
    input: {
      readonly from: readonly IncidentStatus[];
      readonly to: IncidentStatus;
      readonly expectedVersion: number | null;
      readonly now: Date;
    },
    tx: TransactionScope,
  ): Promise<boolean>;
  /** SCHEDULED incidents whose start has come, in this tenant. */
  dueToStart(scope: TenantContext, now: Date): Promise<readonly string[]>;
  /** Tenants with a SCHEDULED incident due — the scheduler's walk. */
  tenantsWithDue(now: Date): Promise<readonly string[]>;

  appendEvent(
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
  ): Promise<void>;
  timeline(scope: TenantContext, id: string): Promise<readonly IncidentEventRecord[]>;

  effects(scope: TenantContext, id: string, tx?: unknown): Promise<readonly IncidentEffectRecord[]>;
  /**
   * The claim: insert the effect PENDING, or take over a stale claim (PENDING or
   * REVERTING older than `staleBefore`). True when this caller now holds it.
   */
  claimApply(
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
  ): Promise<EffectClaim>;
  /** APPLIED → REVERTING (or a stale REVERTING taken over). True when claimed. */
  claimRevert(
    scope: TenantContext,
    input: {
      readonly incidentId: string;
      readonly kind: IncidentEffectKind;
      readonly subjectRef: string;
      readonly staleBefore: Date;
      readonly now: Date;
    },
    tx: TransactionScope,
  ): Promise<EffectClaim>;
  /**
   * Serialises every decision about one SUBJECT across incidents, for the transaction: a
   * claim, a hand-over and an adoption are each taken under it. Taken before the claim, so
   * the claim's "is another live on this subject" check sees a settled answer.
   */
  lockSubject(
    scope: TenantContext,
    kind: IncidentEffectKind,
    subjectRef: string,
    tx: TransactionScope,
  ): Promise<void>;
  /** The OTHER incidents' rows on one subject, with whether each incident still wants it. */
  subjectPeers(
    scope: TenantContext,
    input: {
      readonly incidentId: string;
      readonly kind: IncidentEffectKind;
      readonly subjectRef: string;
    },
    tx: TransactionScope,
  ): Promise<readonly SubjectPeer[]>;
  /** Whether `incidentId` handed its withdrawal of this subject over to another incident. */
  handedOver(
    scope: TenantContext,
    input: {
      readonly incidentId: string;
      readonly kind: IncidentEffectKind;
      readonly subjectRef: string;
    },
  ): Promise<boolean>;
  /**
   * Records an effect that could not be claimed because another incident held the subject
   * for longer than the wait: FAILED, `incident.effect_contended`, unless it is settled.
   */
  markContended(
    scope: TenantContext,
    input: {
      readonly incidentId: string;
      readonly kind: IncidentEffectKind;
      readonly targetKind: IncidentTargetKind;
      readonly targetRef: string;
      readonly subjectRef: string;
      readonly now: Date;
    },
    tx: TransactionScope,
  ): Promise<boolean>;
  /** Settles a claim this caller holds: from PENDING or REVERTING to `state`. */
  settleEffect(
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
  ): Promise<boolean>;

  /** Customers a notice would reach now: live services on the scope, reachable on a bot. */
  audience(
    scope: TenantContext,
    incident: IncidentRecord,
    panels: readonly string[],
    tx?: unknown,
  ): Promise<readonly { readonly customerId: string; readonly botInstanceId: string }[]>;
  insertCommunication(
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
  ): Promise<void>;
  insertNotice(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly communicationId: string;
      readonly incidentId: string;
      readonly customerId: string;
      readonly now: Date;
    },
    tx: TransactionScope,
  ): Promise<void>;
  /** What a notice's lane row renders: the communication's message, and its incident. */
  noticeFacts(
    scope: TenantContext,
    noticeId: string,
  ): Promise<{ readonly message: string; readonly incidentId: string } | null>;
}

/** Whether the effect is in force on its subject right now, and (for a drain) whose. */
export interface EffectStatus {
  readonly inForce: boolean;
  /** The drain's reason, so a revert restores only a drain THIS incident set. */
  readonly marker: string | null;
}

/**
 * The incident's only way to change anything: the OWNING module's existing mechanism,
 * called as the operator, under that module's permission, audit and idempotency. The
 * composition root implements it over `PanelService.setDrain`, `ProductService.activate /
 * deactivate` and `PaymentGatewayService.setStatus`; nothing here writes their tables.
 */
export interface IncidentEffectPort {
  /** A target in this tenant, and the subject its effect changes; null when unknown. */
  resolve(
    scope: TenantContext,
    target: IncidentTarget,
  ): Promise<{ readonly kind: IncidentEffectKind; readonly subjectRef: string } | null>;
  /** For a LOCATION target, the panel it lives on — what a notice's audience reads. */
  panelOfLocation(scope: TenantContext, locationId: string): Promise<string | null>;
  status(
    scope: TenantContext,
    kind: IncidentEffectKind,
    subjectRef: string,
  ): Promise<EffectStatus | null>;
  set(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly kind: IncidentEffectKind;
      readonly subjectRef: string;
      readonly inForce: boolean;
      readonly idempotencyKey: string;
      readonly marker: string;
    },
  ): Promise<void>;
}
