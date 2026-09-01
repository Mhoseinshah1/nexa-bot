import { z } from 'zod';
import {
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdempotencyStore,
  type ScopeContext,
  type UnitOfWork,
  type PermissionKey,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../access/application/permission-guard.js';
import type { OutboxWriter } from '../../eventing/infrastructure/outbox-writer.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import { hashRequest } from '../../idempotency/infrastructure/drizzle-idempotency-store.js';

/**
 * The canonical write path, with nothing else in it.
 *
 * This service exists so that the seven steps every business write must follow
 * are real, composed and tested BEFORE any business write exists:
 *
 *   1. AUTHENTICATE  — the caller supplies an ActorContext
 *   2. RESOLVE TENANT — the caller supplies a ScopeContext
 *   3. AUTHORIZE      — permission checked against the frozen catalog, deny by default
 *   4. VALIDATE       — a typed command, parsed at the boundary
 *   5. IDEMPOTENCY    — a replayed key returns the first result
 *   6. TRANSACT       — domain change + audit row + outbox row, one transaction
 *   7. PROJECT        — the relay publishes; consumers do the rest
 *
 * It records a ping. It deliberately does no business work: Phase 0 has no
 * business features, and a foundation demonstrated with a fake purchase would
 * be a foundation demonstrated with a lie.
 */

export const recordPingCommandSchema = z.object({
  idempotencyKey: z.string().min(8).max(255),
  source: z.enum(['telegram', 'http', 'test']),
  note: z.string().max(200).optional(),
});

export type RecordPingCommand = z.infer<typeof recordPingCommandSchema>;

export interface RecordPingResult {
  readonly eventId: string;
  readonly sequence: number;
  readonly replayed: boolean;
}

/** The permission this operation requires. Deny by default applies. */
export const RECORD_PING_PERMISSION: PermissionKey = 'maintenance.run';

export class RecordPingService {
  constructor(
    private readonly guard: PermissionGuard,
    private readonly uow: UnitOfWork<TransactionScope>,
    private readonly outbox: OutboxWriter,
    private readonly audit: AuditWriter,
    private readonly idempotency: IdempotencyStore,
    private readonly clock: Clock,
  ) {}

  async execute(
    scope: ScopeContext,
    actor: ActorContext,
    input: unknown,
  ): Promise<RecordPingResult> {
    // 3. AUTHORIZE — before anything is read or written. A denial is audited by
    //    the guard as an operational event and recorded below as an audit row.
    try {
      await this.guard.check(scope, actor, RECORD_PING_PERMISSION);
    } catch (denial) {
      await this.audit.record(scope, actor, {
        action: 'system.ping',
        entityType: 'System',
        entityId: null,
        before: null,
        after: null,
        result: 'DENIED',
      });
      throw denial;
    }

    // 4. VALIDATE — a typed command object, parsed at the boundary.
    const command = recordPingCommandSchema.parse(input);
    const requestHash = hashRequest({ source: command.source, note: command.note ?? null });

    // 5. IDEMPOTENCY — a replay returns the first result rather than repeating
    //    the work. A key reused with different input throws instead.
    // Namespaced by the acting surface. Without that, every system-scoped
    // caller shares one namespace and one surface can consume another's keys.
    const existing = await this.idempotency.find<Omit<RecordPingResult, 'replayed'>>(
      scope,
      actor.surface,
      command.idempotencyKey,
      requestHash,
    );
    if (existing) {
      return { ...existing.result, replayed: true };
    }

    // 6. TRANSACT — the change, its audit row and its outbox row commit together.
    const result = await this.uow.run(scope, async (tx) => {
      const written = await this.outbox.write(tx, actor, {
        eventType: 'SystemPinged',
        aggregateType: 'System',
        aggregateId: 'system',
        payload: { source: command.source, ...(command.note ? { note: command.note } : {}) },
      });

      await this.audit.record(
        scope,
        actor,
        {
          action: 'system.ping',
          entityType: 'System',
          entityId: 'system',
          before: null,
          after: { source: command.source, at: this.clock.now().toISOString() },
          result: 'SUCCESS',
        },
        tx,
      );

      await this.idempotency.remember(
        scope,
        actor.surface,
        command.idempotencyKey,
        requestHash,
        { eventId: written.eventId, sequence: written.sequence },
        tx,
      );

      return written;
    });

    // 7. PROJECT happens asynchronously: the relay picks the outbox row up.
    return { eventId: result.eventId, sequence: result.sequence, replayed: false };
  }
}
