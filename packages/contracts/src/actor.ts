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

export const SOURCE_SURFACES = ['TELEGRAM', 'WEB', 'WORKER', 'SCHEDULER', 'API'] as const;
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
