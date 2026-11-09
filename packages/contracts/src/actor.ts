import { z } from 'zod';
import type { CorrelationId } from './ids.js';

/**
 * Who is acting.
 *
 * Every write path takes an ActorContext. There are no exceptions, including
 * background jobs — a job acts as SYSTEM_JOB carrying its job id, so an audit
 * row always names someone.
 *
 * This union is fixed and is the same set used by the event envelope and by
 * `audit_logs.actor_type`. One vocabulary, three consumers.
 */

export const ACTOR_TYPES = [
  'CUSTOMER',
  'TELEGRAM_ADMIN',
  'WEB_ADMIN',
  'SYSTEM_JOB',
  'API',
  'PROVIDER_SYNC',
] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const actorTypeSchema = z.enum(ACTOR_TYPES);

/**
 * Which surface an action arrived through.
 *
 * `MINI_APP` (Round 9, C5) is the customer's Telegram Mini App: an authenticated HTTP surface
 * of its own, so its audit rows, its idempotency namespace and the purchases, renewals,
 * top-ups and tickets it creates say so — the operations log prints `منبع: مینی‌اپ` from it.
 */
export const SOURCE_SURFACES = [
  'TELEGRAM',
  'WEB',
  'WORKER',
  'SCHEDULER',
  'API',
  'MINI_APP',
] as const;
export type SourceSurface = (typeof SOURCE_SURFACES)[number];

export interface ActorContext {
  readonly type: ActorType;
  /** Stable internal id of the acting principal; null for anonymous system work. */
  readonly id: string | null;
  /** Human-readable label captured at action time, so audit survives renames. */
  readonly label: string | null;
  readonly surface: SourceSurface;
  readonly correlationId: CorrelationId;
  readonly requestId?: string;
  readonly ip?: string;
  readonly userAgent?: string;
  /**
   * The session this actor is acting on, when one exists.
   *
   * Carried so a mutation can confirm, under the lock it already takes, that
   * the session authorising it has not been revoked in the meantime. Session
   * validity is established once per request and then the request does work;
   * without re-reading it, a logout or a password rotation can revoke a session
   * and still have it commit a write — which would make "rotation revokes every
   * session" true of the rows and false of the requests already in flight.
   *
   * Optional because system work has no session, and a `SYSTEM_JOB` actor is
   * not a signed-in administrator wearing a different hat.
   */
  readonly sessionId?: string;
  /**
   * Phase 6B «ورود به پنل» (D5, ADR-0039 § 9 refinement 4): present when the installation
   * owner is acting inside a hosted tenant through an entered session. `id` is then the hosted
   * tenant's HOST principal (the rows it writes keep their composite admin foreign keys), and
   * THIS names the person: the audit writer records the act in the INSTALLATION's log, as the
   * owner, with the hosted tenant as `acted_in_tenant_id`, and writes nothing to the hosted
   * tenant's own audit log. Built only by the server from the session row, never from a request.
   */
  readonly impersonation?: ActorImpersonation;
}

/** Who is really acting behind a HOST principal (`ActorContext.impersonation`). */
export interface ActorImpersonation {
  /** The installation tenant, whose audit log records the act. */
  readonly installationTenantId: string;
  /** The installation owner's own admin id there. */
  readonly ownerAdminId: string;
  /** The owner's username, captured at the request, as every actor label is. */
  readonly ownerLabel: string;
  /** The «میزبانی‌ها» section session the entered session was opened from and ends with. */
  readonly hostingSessionId: string;
}

export const actorRefSchema = z.object({
  type: actorTypeSchema,
  id: z.string().nullable(),
});
export type ActorRef = z.infer<typeof actorRefSchema>;

export function actorRef(actor: ActorContext): ActorRef {
  return { type: actor.type, id: actor.id };
}

/** Constructs the actor a scheduled or queued job acts as. */
export function systemJobActor(jobId: string, correlationId: CorrelationId): ActorContext {
  return {
    type: 'SYSTEM_JOB',
    id: jobId,
    label: `job:${jobId}`,
    surface: 'WORKER',
    correlationId,
  };
}
