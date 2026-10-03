import { OPS_GROUP_ERROR_CODES, type ActorContext, type ScopeContext } from '@nexa/contracts';
import type {
  OpsGroupBackupRoute,
  OpsGroupBackupStanding,
  OpsGroupBackupTopic,
} from '../../../platform/backup/application/routed-backup-delivery.js';
import type { OpsGroupService } from './ops-group.service.js';
import type { OpsGroupBots } from './ports.js';

/**
 * The operations log group's «💾 بکاپ‌ها» topic, as the backup pipeline sees it (spec
 * §13.1).
 *
 * Thin by design: `OpsGroupService.route` is the dispatcher's own send-time resolution —
 * the connected binding, the scope-activity check, and the ONE topic provisioner with its
 * conditional creation claim. So the backups topic is created once however many worker
 * replicas deliver at once, and a deleted one is recreated once per stale thread, exactly
 * like every other topic Nexa owns. Nothing here decides anything about topics.
 *
 * The token is the group's own bot's: only a member of the group can post in it, which
 * is why the archive no longer needs `BACKUP_TELEGRAM_BOT_TOKEN` when a group is
 * connected. It is read per route and never leaves the process.
 */
export class OpsGroupBackupTopicAdapter implements OpsGroupBackupTopic {
  constructor(
    private readonly service: Pick<OpsGroupService, 'route' | 'binding' | 'noteDelivered'>,
    private readonly bots: Pick<OpsGroupBots, 'tokenFor'>,
    private readonly systemActor: () => ActorContext,
  ) {}

  /**
   * Whether the group can take this backup, from what is already recorded (Codex review
   * of PR #142): a group whose latest check found a PROBLEM — the bot removed, unable to
   * send or to manage topics — is not handed the archive, and neither is one whose bot has
   * no token. `UNVERIFIED` is not a known problem (a group just bound, or one Telegram said
   * changed), so it is tried; a refusal is then the run's recorded answer.
   */
  async standing(scope: ScopeContext): Promise<OpsGroupBackupStanding> {
    const binding = await this.service.binding(scope);
    if (binding === null) return { kind: 'NOT_CONNECTED' };
    if (binding.health === 'PROBLEM') {
      return {
        kind: 'UNUSABLE',
        errorCode: 'ops_group.problem',
        errorMessage: `The operations group's latest check found: ${binding.problems.join(', ')}.`,
      };
    }
    if ((await this.bots.tokenFor(scope, binding.botInstanceId)) === null) {
      return {
        kind: 'UNUSABLE',
        errorCode: 'telegram.no_bot_configured',
        errorMessage: 'The bot bound to the operations group is not active.',
      };
    }
    return { kind: 'USABLE' };
  }

  async route(scope: ScopeContext, staleThreadId: number | null): Promise<OpsGroupBackupRoute> {
    const route = await this.service.route(scope, this.systemActor(), 'BACKUPS', staleThreadId);
    if (route.kind === 'UNAVAILABLE') {
      // Nothing connected is not a failure of the group; it is the absence of one.
      return route.errorCode === OPS_GROUP_ERROR_CODES.NOT_CONNECTED
        ? { kind: 'NOT_CONNECTED' }
        : { kind: 'UNAVAILABLE', errorCode: route.errorCode, errorMessage: route.errorMessage };
    }
    const token = await this.bots.tokenFor(scope, route.botInstanceId);
    if (token === null) {
      return {
        kind: 'UNAVAILABLE',
        errorCode: 'telegram.no_bot_configured',
        errorMessage: 'The bot bound to the operations group is not active.',
      };
    }
    return { kind: 'ROUTED', chatId: route.chatId, threadId: route.topicId, token };
  }

  delivered(scope: ScopeContext, chatId: string, at: Date): Promise<void> {
    return this.service.noteDelivered(scope, 'BACKUPS', chatId, at);
  }
}
