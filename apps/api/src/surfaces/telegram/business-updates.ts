import {
  BUSINESS_UPDATE_FAILED_CODE,
  type ActorContext,
  type TenantContext,
} from '@nexa/contracts';
import type { Container } from '../../container.js';
import {
  parseBusinessConnection,
  parseBusinessDeletion,
  parseBusinessMessage,
  type BusinessUpdate,
} from '../../modules/commerce/business-chats/domain/telegram-business.js';

/**
 * TB1 — what the webhook does with each of the four Telegram Business updates
 * (ADR-0033). Kept out of the controller for the reason `stars-updates.ts` and
 * `ops-group-updates.ts` are: a function can be tested where a route handler cannot.
 *
 * The two kinds fail differently, on the controller's existing precedents:
 *
 *   - a CONNECTION report PROPAGATES a failure, like the operations group's membership
 *     change. It is a fact Telegram tells nobody twice — a lost "disabled" would leave a
 *     connection NEXA believes it may send through. A non-2xx makes Telegram deliver it
 *     again, and the update key makes the redelivery a replay.
 *   - a MESSAGE is recorded and answered 2xx, like the customer turn. Redelivering a
 *     message whose only problem was a transient failure is an unbounded loop.
 *
 * A malformed payload of either kind is reported and answered 2xx: Telegram is not going
 * to send a different body, so a non-2xx would only loop.
 */
export async function handleBusinessUpdate(
  container: Pick<Container, 'businessConnections' | 'businessConversations' | 'opsLog'>,
  scope: TenantContext,
  actor: ActorContext,
  input: {
    readonly idempotencyKey: string;
    readonly botInstanceId: string;
    readonly updateId: string;
    readonly update: BusinessUpdate;
  },
): Promise<void> {
  const report = async (reason: string, error?: unknown): Promise<void> => {
    await container.opsLog.record(scope, {
      code: BUSINESS_UPDATE_FAILED_CODE,
      severity: reason === 'MALFORMED' ? 'WARN' : 'ERROR',
      message: 'A Telegram Business update could not be processed.',
      dedupeKey: `${BUSINESS_UPDATE_FAILED_CODE}:${reason.toLowerCase()}:${input.botInstanceId}`,
      context: {
        botInstanceId: input.botInstanceId,
        updateId: input.updateId,
        kind: input.update.kind,
        reason,
        ...(error === undefined ? {} : { error: error instanceof Error ? error.name : 'unknown' }),
      },
    });
  };

  switch (input.update.kind) {
    case 'CONNECTION': {
      const parsed = parseBusinessConnection(input.update.payload);
      if (parsed === null) {
        await report('MALFORMED').catch(() => undefined);
        return;
      }
      try {
        await container.businessConnections.applyReport(scope, actor, {
          idempotencyKey: input.idempotencyKey,
          botInstanceId: input.botInstanceId,
          report: parsed,
        });
      } catch (error) {
        await report('CONNECTION_NOT_APPLIED', error).catch(() => undefined);
        throw error;
      }
      return;
    }
    case 'MESSAGE':
    case 'EDITED_MESSAGE': {
      const parsed = parseBusinessMessage(input.update.payload);
      if (parsed === null) {
        await report('MALFORMED').catch(() => undefined);
        return;
      }
      try {
        // The update key is the message's own; the connection lookup derives its own key
        // from it inside the service, so one key is never presented with two hashes.
        await container.businessConversations.recordMessage(scope, actor, {
          idempotencyKey: input.idempotencyKey,
          botInstanceId: input.botInstanceId,
          message: parsed,
          edited: input.update.kind === 'EDITED_MESSAGE',
        });
      } catch (error) {
        // Guarded: a failed report must not turn a swallowed message failure into a non-2xx
        // and an unbounded redelivery loop (TB1 review S3).
        await report('MESSAGE_NOT_ROUTED', error).catch(() => undefined);
      }
      return;
    }
    case 'DELETED_MESSAGES': {
      const parsed = parseBusinessDeletion(input.update.payload);
      if (parsed === null) {
        await report('MALFORMED').catch(() => undefined);
        return;
      }
      try {
        await container.businessConversations.recordDeletion(scope, actor, {
          idempotencyKey: input.idempotencyKey,
          botInstanceId: input.botInstanceId,
          deletion: parsed,
        });
      } catch (error) {
        // Guarded, as above (TB1 review S3).
        await report('DELETION_NOT_APPLIED', error).catch(() => undefined);
      }
      return;
    }
  }
}
