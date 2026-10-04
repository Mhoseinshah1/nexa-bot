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
  container: Pick<Container, 'businessConnections' | 'opsLog'>,
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
        await report('MALFORMED');
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
        await report('MALFORMED');
        return;
      }
      try {
        // A separate key from the update's own: the update key belongs to whatever TB2
        // records about the message, and one key presented with two request hashes is
        // refused as a payload mismatch.
        await container.businessConnections.routeMessage(scope, actor, {
          idempotencyKey: `${input.idempotencyKey}:connection`,
          botInstanceId: input.botInstanceId,
          message: parsed,
        });
      } catch (error) {
        await report('MESSAGE_NOT_ROUTED', error);
      }
      return;
    }
    case 'DELETED_MESSAGES': {
      // TB1 reads the deletion strictly and does nothing else: there is no stored message
      // text to purge until TB2 stores some. Malformed is still reported.
      if (parseBusinessDeletion(input.update.payload) === null) await report('MALFORMED');
      return;
    }
  }
}
