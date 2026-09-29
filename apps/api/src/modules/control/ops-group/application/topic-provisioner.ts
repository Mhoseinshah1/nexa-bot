import {
  OPS_LOG_TOPIC_NAME_TEMPLATES,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type Logger,
  type OperationalEventRecorder,
  type OpsLogTopicCategory,
  type ScopeContext,
  type TemplateKey,
} from '@nexa/contracts';
import type { TemplateResolver } from '../../templates/application/template-resolver.js';
import type { OpsGroupRecord, OpsGroupRepository, OpsGroupTelegram } from './ports.js';

/**
 * How long a creation claim holds. Far longer than one `createForumTopic` can take (the
 * call's own timeout is seconds), so a slow Telegram never lets a second creator in; short
 * enough that a creator that died mid-call releases the topic within a minute.
 */
export const TOPIC_CREATION_CLAIM_MS = 60_000;

export type EnsuredTopic =
  | { readonly kind: 'READY'; readonly threadId: number; readonly created: boolean }
  /** Somebody else holds the creation claim right now. Try again later. */
  | { readonly kind: 'BUSY' }
  | { readonly kind: 'FAILED'; readonly errorCode: string; readonly errorMessage: string };

/**
 * The ONE implementation of "make sure Nexa's topic exists", shared by the permission
 * check, the test send and the dispatcher's recovery of a deleted topic.
 *
 * Idempotent under concurrency by construction, not by timing:
 *
 *   1. the registry row for (chat, category) is created if absent — a unique key, so two
 *      callers converge on ONE row;
 *   2. only a caller that wins the conditional claim UPDATE (row not READY, no live claim)
 *      calls `createForumTopic`; every other caller answers BUSY or reads the READY row;
 *   3. the thread id is recorded only by the claim's holder.
 *
 * Recovery is the same path with a stale thread id: the row is moved READY → MISSING only
 * while it still names THAT thread, so two senders that met one deleted topic recreate it
 * once — the second finds the row READY on a new thread and uses it.
 *
 * Every Telegram call is outside a transaction.
 */
export class OpsTopicProvisioner {
  constructor(
    private readonly deps: {
      readonly repository: OpsGroupRepository;
      readonly telegram: OpsGroupTelegram;
      readonly templates: TemplateResolver;
      readonly audit: AuditWriter;
      /** The RAW recorder: a topic event must not be projected back into the group. */
      readonly opsLog: OperationalEventRecorder;
      readonly clock: Clock;
      readonly ids: IdGenerator;
      readonly logger: Logger;
    },
  ) {}

  async ensure(
    scope: ScopeContext,
    actor: ActorContext,
    group: OpsGroupRecord,
    category: OpsLogTopicCategory,
    token: string,
    staleThreadId: number | null = null,
  ): Promise<EnsuredTopic> {
    const { repository } = this.deps;
    let row = await repository.ensureTopicRow(scope, {
      id: this.deps.ids.uuid(),
      groupId: group.id,
      chatId: group.chatId,
      category,
      now: this.deps.clock.now(),
    });

    if (row.state === 'READY' && row.messageThreadId !== null) {
      if (staleThreadId === null || row.messageThreadId !== staleThreadId) {
        return { kind: 'READY', threadId: row.messageThreadId, created: false };
      }
      // The thread this caller was refused on is still the registered one: it is gone.
      await repository.markTopicMissing(scope, {
        topicId: row.id,
        staleThreadId,
        now: this.deps.clock.now(),
      });
    }

    const claimToken = this.deps.ids.uuid();
    const now = this.deps.clock.now();
    const claimed = await repository.claimTopicCreation(scope, {
      topicId: row.id,
      token: claimToken,
      until: new Date(now.getTime() + TOPIC_CREATION_CLAIM_MS),
      now,
    });
    if (claimed === null) {
      // Somebody else is creating it, or has just finished. Read again rather than guess.
      const topics = await repository.listTopics(scope, group.chatId);
      const current = topics.find((topic) => topic.id === row.id);
      if (current?.state === 'READY' && current.messageThreadId !== null) {
        if (staleThreadId === null || current.messageThreadId !== staleThreadId) {
          return { kind: 'READY', threadId: current.messageThreadId, created: false };
        }
      }
      return { kind: 'BUSY' };
    }
    row = claimed;
    // A row that ever had a thread is being RE-created: the old one was deleted.
    const recreated = row.messageThreadId !== null;

    const name = await this.deps.templates.render(
      scope,
      OPS_LOG_TOPIC_NAME_TEMPLATES[category] as TemplateKey,
      {},
    );
    const created = await this.deps.telegram.createTopic(token, group.chatId, name);
    if (created.outcome !== 'OK') {
      await repository.releaseTopicClaim(scope, {
        topicId: row.id,
        token: claimToken,
        now: this.deps.clock.now(),
      });
      return { kind: 'FAILED', errorCode: created.errorCode, errorMessage: created.errorMessage };
    }

    const recorded = await repository.completeTopicCreation(scope, {
      topicId: row.id,
      token: claimToken,
      threadId: created.threadId,
      recreated,
      now: this.deps.clock.now(),
    });
    if (!recorded) {
      // The claim lapsed while Telegram answered and another caller took it. That caller's
      // topic is the registered one; this one is an orphan in the group, said plainly.
      this.deps.logger.warn(
        { category, chatId: group.chatId },
        'Created an operations topic after its creation claim lapsed; the registry kept the other one',
      );
      return { kind: 'BUSY' };
    }

    await this.record(scope, actor, group, category, created.threadId, recreated);
    return { kind: 'READY', threadId: created.threadId, created: true };
  }

  /** The audit row and the operational event for a topic Nexa created. Never throws. */
  private async record(
    scope: ScopeContext,
    actor: ActorContext,
    group: OpsGroupRecord,
    category: OpsLogTopicCategory,
    threadId: number,
    recreated: boolean,
  ): Promise<void> {
    try {
      await this.deps.audit.record(scope, actor, {
        action: recreated ? 'ops_group.topic_recreated' : 'ops_group.topic_created',
        entityType: 'OpsLogGroup',
        entityId: group.id,
        before: null,
        after: { category, messageThreadId: threadId },
        result: 'SUCCESS',
      });
      if (recreated) {
        await this.deps.opsLog.record(scope, {
          code: 'ops_group.topic_recreated',
          severity: 'WARN',
          message:
            'An operations log topic Nexa owns was missing (deleted in Telegram) and was recreated.',
          context: { category, messageThreadId: threadId },
          dedupeKey: `ops_group.topic_recreated:${group.id}:${category}:${threadId}`,
        });
      }
    } catch (error) {
      this.deps.logger.error(
        { err: error instanceof Error ? error.message : String(error), category },
        'Created an operations topic but could not record it',
      );
    }
  }
}
