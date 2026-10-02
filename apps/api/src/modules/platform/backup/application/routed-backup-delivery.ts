import type { BackupDeliveryDestination, Clock, ScopeContext } from '@nexa/contracts';
import type {
  BackupDeliveryChannel,
  BackupDeliveryResolution,
  BackupDeliveryRouter,
  DeliveryAttempt,
} from './ports.js';

/**
 * Where the operations log group's backups topic is right now, as the backup pipeline
 * needs it. Implemented by the ops group module over its ONE topic provisioner, so the
 * backups topic is created, claimed and recreated exactly like every other topic Nexa
 * owns — a conditional claim, never a decision one process made (no duplicate topics
 * with two worker replicas).
 */
export type OpsGroupBackupRoute =
  | { readonly kind: 'NOT_CONNECTED' }
  /** A group is connected and the topic could not be made ready (bot stopped, refused…). */
  | { readonly kind: 'UNAVAILABLE'; readonly errorCode: string; readonly errorMessage: string }
  | {
      readonly kind: 'ROUTED';
      readonly chatId: string;
      readonly threadId: number;
      /** The group's own bot. Never leaves the process; never in a detail or a log. */
      readonly token: string;
    };

export interface OpsGroupBackupTopic {
  /** Whether a group is connected now. A database read; no Telegram call. */
  connected(scope: ScopeContext): Promise<boolean>;
  /**
   * The group's chat and the backups topic's thread, creating the topic if it is owed.
   * `staleThreadId` is the thread Telegram just said is gone: the topic is recreated
   * once for it, by whichever caller wins the claim.
   */
  route(scope: ScopeContext, staleThreadId: number | null): Promise<OpsGroupBackupRoute>;
  /** Bookkeeping: the topic received something. Never throws into delivery. */
  delivered(scope: ScopeContext, chatId: string, at: Date): Promise<void>;
}

export interface RoutedBackupDeliveryDeps {
  readonly opsGroup: OpsGroupBackupTopic;
  /** The installation's tenant; null before provisioning, when no group can exist. */
  readonly scope: () => ScopeContext | null;
  /** A channel into one chat and thread, from one bot. */
  readonly channelFor: (target: {
    readonly token: string;
    readonly chatId: string;
    readonly threadId: number;
  }) => Pick<BackupDeliveryChannel, 'sendDocument' | 'sendMessage'>;
  /** `BACKUP_TELEGRAM_CHAT_ID` + `BACKUP_TELEGRAM_BOT_TOKEN`: the explicit fallback. */
  readonly dedicated: BackupDeliveryChannel;
  readonly clock: Clock;
  readonly logger: {
    warn(context: Record<string, unknown>, message: string): void;
  };
}

/**
 * Backup delivery, routed (spec §13.1).
 *
 * PRECEDENCE, decided per run and documented in `docs/backup.md`:
 *
 *   1. A CONNECTED operations log group: its «💾 بکاپ‌ها» topic, posted by the group's
 *      own bot. The canonical destination — an operator who connected a group set up no
 *      second chat id.
 *   2. Otherwise — no group connected, or a connected group whose topic could not be made
 *      ready before ANY byte was sent — the environment's dedicated chat, when it is
 *      configured. That is the explicit fallback, and the only reason the two
 *      `BACKUP_TELEGRAM_*` variables still exist.
 *   3. Otherwise nothing: `NOT_ATTEMPTED` when nothing is configured anywhere, or a
 *      `FAILED_DEFINITIVE` naming why when a group is connected and unusable.
 *
 * A fallback is taken only when NOTHING was sent to the group. Once a send to the group
 * has been attempted its answer is the run's answer: an `OUTCOME_UNKNOWN` is never
 * followed by a second copy somewhere else, because the first may have landed — the same
 * three-outcome rule as ever (ADR-0025), and nothing here resends automatically.
 *
 * The one resend is the deleted topic: Telegram DEFINITIVELY refused the send because the
 * thread is gone, so nothing was posted; the topic is recreated through the provisioner's
 * claim (once per stale thread, whichever process wins) and the archive is sent once
 * more. A refusal of that second send is the answer.
 */
export class RoutedBackupDelivery implements BackupDeliveryRouter {
  constructor(private readonly deps: RoutedBackupDeliveryDeps) {}

  async describe(): Promise<BackupDeliveryDestination> {
    const scope = this.deps.scope();
    if (scope !== null && (await this.deps.opsGroup.connected(scope))) return 'OPS_GROUP_TOPIC';
    return this.deps.dedicated.configured ? 'DEDICATED_CHAT' : 'NONE';
  }

  async resolve(): Promise<BackupDeliveryResolution> {
    const scope = this.deps.scope();
    const route = scope === null ? null : await this.deps.opsGroup.route(scope, null);

    if (scope !== null && route !== null && route.kind === 'ROUTED') {
      return {
        kind: 'READY',
        destination: 'OPS_GROUP_TOPIC',
        channel: this.groupChannel(scope, route),
      };
    }
    if (this.deps.dedicated.configured) {
      if (route !== null && route.kind === 'UNAVAILABLE') {
        // Said out loud: the operator connected a group and the archive went elsewhere.
        this.deps.logger.warn(
          { errorCode: route.errorCode },
          'the operations group backups topic is unavailable; delivering to the dedicated backup chat instead',
        );
      }
      return { kind: 'READY', destination: 'DEDICATED_CHAT', channel: this.deps.dedicated };
    }
    if (route !== null && route.kind === 'UNAVAILABLE') {
      return {
        kind: 'UNAVAILABLE',
        detail:
          `The operations group's backups topic is unavailable (${route.errorCode}) and no ` +
          'dedicated backup chat is configured. The archive is retained on the server.',
      };
    }
    return { kind: 'NONE' };
  }

  /** The group's topic, with the one safe resend: after a definitive "topic is gone". */
  private groupChannel(
    scope: ScopeContext,
    first: Extract<OpsGroupBackupRoute, { kind: 'ROUTED' }>,
  ): Pick<BackupDeliveryChannel, 'sendDocument' | 'sendMessage'> {
    const send = async (
      call: (
        channel: Pick<BackupDeliveryChannel, 'sendDocument' | 'sendMessage'>,
      ) => Promise<DeliveryAttempt>,
    ): Promise<DeliveryAttempt> => {
      let target = first;
      let attempt = await call(this.deps.channelFor(target));
      if (attempt.state === 'FAILED_DEFINITIVE' && attempt.topicMissing === true) {
        const again = await this.reroute(scope, target.threadId);
        if (again !== null) {
          target = again;
          attempt = await call(this.deps.channelFor(target));
        }
      }
      if (attempt.state === 'SUCCEEDED') {
        await this.noteDelivered(scope, target.chatId);
        return {
          state: 'SUCCEEDED',
          detail: attempt.detail ?? 'Delivered to the operations log group’s backups topic.',
        };
      }
      return attempt;
    };
    return {
      sendDocument: (input) => send((channel) => channel.sendDocument(input)),
      sendMessage: (text) => send((channel) => channel.sendMessage(text)),
    };
  }

  /** The recreated topic, or null — in which case the definitive refusal stands. */
  private async reroute(
    scope: ScopeContext,
    staleThreadId: number,
  ): Promise<Extract<OpsGroupBackupRoute, { kind: 'ROUTED' }> | null> {
    try {
      const route = await this.deps.opsGroup.route(scope, staleThreadId);
      return route.kind === 'ROUTED' ? route : null;
    } catch (error) {
      this.deps.logger.warn(
        { reason: error instanceof Error ? error.message : String(error) },
        'the deleted backups topic could not be recreated',
      );
      return null;
    }
  }

  private async noteDelivered(scope: ScopeContext, chatId: string): Promise<void> {
    try {
      await this.deps.opsGroup.delivered(scope, chatId, this.deps.clock.now());
    } catch (error) {
      this.deps.logger.warn(
        { reason: error instanceof Error ? error.message : String(error) },
        'delivered a backup to the operations group but could not note it',
      );
    }
  }
}
