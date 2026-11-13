import type { BackupDeliveryReason, BackupDeliveryState, Clock } from '@nexa/contracts';
import type { BackupDeliveryChannel, DeliveryAttempt } from './ports.js';
import {
  BACKUP_PART_DELIVERY_ATTEMPTS,
  partMaySendAgain,
  partRetryDelayMs,
} from './backup-retry-policy.js';

/**
 * Sends an archive's parts to Telegram IN ORDER, each until it arrives or the rule says stop
 * (NEXA-BACKUP-DELIVERY). One loop for the run's own DELIVER stage and for a re-delivery of a
 * finished run's undelivered parts, so the two cannot come to differ.
 *
 * PER PART. Sent; its answer recorded on its own row at once (state, reason, Telegram message
 * id, how many sends); then:
 *
 *   SUCCEEDED                       next part.
 *   may send again (the rule in     pause (30 s, then 2 min; a 429's `retry_after` when it is
 *   `partMaySendAgain`), sends      longer, up to 10 min), send again. The first copy may be in
 *   left, deadline not passed       the group — Telegram gives a bot no way to check — and the
 *                                   owner's rule is that twice is acceptable and lost is not.
 *   otherwise                       STOP. The parts after it are not sent: a later part
 *                                   without its predecessor is no use to a restore, and the
 *                                   run row then says exactly which part stopped and why.
 *
 * Never throws for a delivery: a channel that throws is an OUTCOME_UNKNOWN (bytes may have
 * left). A record write that throws propagates — the caller's run must not report a part
 * delivered that its row does not say was.
 */

export interface DeliverablePart {
  readonly partNumber: number;
  /** `[start, end)` of the archive. */
  readonly start: number;
  readonly end: number;
  readonly filename: string;
  /** Sends already made before this pass (a re-delivery continues the count). */
  readonly attemptsSoFar: number;
}

export interface PartOutcome {
  readonly partNumber: number;
  readonly state: BackupDeliveryState;
  readonly attemptedAt: Date;
  readonly messageId: number | null;
  readonly detail: string | null;
  readonly reason: BackupDeliveryReason | null;
  /** Sends of this part so far, this one included. */
  readonly attempts: number;
}

export interface PartDeliveryResult {
  /** Parts of this pass that Telegram answered `ok` for. */
  readonly delivered: number;
  /** The part that stopped the pass, and its last answer; null when every part arrived. */
  readonly stopped: {
    readonly partNumber: number;
    readonly state: 'FAILED_DEFINITIVE' | 'OUTCOME_UNKNOWN' | 'NOT_ATTEMPTED';
    readonly detail: string | null;
    readonly reason: BackupDeliveryReason | null;
  } | null;
}

export interface PartDeliveryDeps {
  readonly clock: Clock;
  /** The pause between two sends of a part. Tests pass one that advances a fake clock. */
  readonly sleep: (ms: number) => Promise<void>;
  readonly logger: { warn(context: Record<string, unknown>, message: string): void };
}

export async function deliverPartsInOrder(
  input: {
    readonly backupId: string;
    readonly channel: Pick<BackupDeliveryChannel, 'sendDocument'>;
    readonly archivePath: string;
    readonly parts: readonly DeliverablePart[];
    /** One part that IS the whole file: sent with no range. */
    readonly whole: boolean;
    /** The caption of a send; `resend` is true when this part was sent before. */
    readonly caption: (part: DeliverablePart, resend: boolean) => Promise<string>;
    readonly record: (outcome: PartOutcome) => Promise<void>;
    /**
     * Asked before every send: false stops the pass with the part NOT_ATTEMPTED (a
     * re-delivery whose lease was lost). Absent: always true.
     */
    readonly beforeSend?: () => Promise<boolean>;
    /** No resend starts after this instant. Null: bounded by the send count alone. */
    readonly deadline?: Date | null;
    readonly maxAttempts?: number;
  },
  deps: PartDeliveryDeps,
): Promise<PartDeliveryResult> {
  const maxAttempts = input.maxAttempts ?? BACKUP_PART_DELIVERY_ATTEMPTS;
  let delivered = 0;
  for (const part of input.parts) {
    let total = part.attemptsSoFar;
    let sends = 0;
    for (;;) {
      if (input.beforeSend !== undefined && !(await input.beforeSend())) {
        return {
          delivered,
          stopped: {
            partNumber: part.partNumber,
            state: 'NOT_ATTEMPTED',
            detail: 'The re-delivery lost its lease before this part was sent.',
            reason: null,
          },
        };
      }
      const attemptedAt = deps.clock.now();
      const resend = total > 0;
      total += 1;
      sends += 1;
      let attempt: DeliveryAttempt;
      try {
        attempt = await input.channel.sendDocument({
          archivePath: input.archivePath,
          filename: part.filename,
          caption: await input.caption(part, resend),
          ...(input.whole ? {} : { range: { start: part.start, end: part.end } }),
        });
      } catch (error) {
        // A channel is built not to throw. If one did anyway, bytes may have left: that is
        // precisely an outcome nobody observed, and it is recorded as one.
        attempt = {
          state: 'OUTCOME_UNKNOWN',
          reason: 'TRANSPORT_ERROR',
          detail: `The delivery did not complete: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const reason = attempt.state === 'SUCCEEDED' ? null : (attempt.reason ?? null);
      await input.record({
        partNumber: part.partNumber,
        state: attempt.state,
        attemptedAt,
        messageId: attempt.state === 'SUCCEEDED' ? (attempt.messageId ?? null) : null,
        detail: attempt.detail,
        reason,
        attempts: total,
      });
      if (attempt.state === 'SUCCEEDED') {
        delivered += 1;
        break;
      }
      // The real cause, in the log as well as on the row — never just «fetch failed».
      deps.logger.warn(
        {
          backupId: input.backupId,
          partNumber: part.partNumber,
          attempt: total,
          state: attempt.state,
          reason,
          detail: attempt.detail,
        },
        'a backup part did not arrive',
      );
      const stop = {
        delivered,
        stopped: {
          partNumber: part.partNumber,
          state: attempt.state,
          detail: attempt.detail,
          reason,
        },
      } as const;
      if (!partMaySendAgain(attempt) || sends >= maxAttempts) return stop;
      const delay = partRetryDelayMs(
        sends,
        attempt.state === 'OUTCOME_UNKNOWN' ? attempt.retryAfterMs : undefined,
      );
      if (delay === null) return stop;
      const deadline = input.deadline ?? null;
      if (deadline !== null && deps.clock.now().getTime() + delay >= deadline.getTime()) {
        return stop;
      }
      await deps.sleep(delay);
    }
  }
  return { delivered, stopped: null };
}
