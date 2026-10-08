import type { ScopeContext } from '@nexa/contracts';
import type {
  HandoffContext,
  HandoffContextSource,
} from '../../../commerce/business-chats/application/ports.js';
import type { DrizzleSupportAiJobRepository } from '../infrastructure/drizzle-support-ai-job.repository.js';

/**
 * Roadmap A5 — the safe operator context every handoff carries, read inside the handoff's own
 * transaction from what the support AI already recorded, so a handoff decided BEFORE any
 * provider call (the loop and progress guards, money, an unseen image, a stale job, a provider
 * that was unavailable, or the lane's own handoffs) still tells the person where things stood:
 *
 * - the latest decision's summary, topic and intent in this conversation (AI text about the
 *   chat, never the customer's words; stored on the escalation and purged with its summary);
 * - the steps tried: the automatic replies of the session that is ending (`sessionReplyCount`
 *   at the epoch before the bump — greetings not counted).
 *
 * Nothing new is stored about the conversation itself: no transcript is copied anywhere.
 */
export class SupportHandoffContext implements HandoffContextSource {
  constructor(
    private readonly deps: {
      readonly jobs: Pick<
        DrizzleSupportAiJobRepository,
        'latestDecisionContext' | 'sessionReplyCount'
      >;
    },
  ) {}

  async contextOf(
    scope: ScopeContext,
    input: { readonly conversationId: string; readonly epoch: number; readonly now: Date },
    tx: unknown,
  ): Promise<HandoffContext> {
    const [latest, stepsTried] = await Promise.all([
      // M1: the epoch that just ended, inside the retention — never an older issue's note.
      this.deps.jobs.latestDecisionContext(
        scope,
        { conversationId: input.conversationId, epoch: input.epoch, now: input.now },
        tx,
      ),
      // CX5: the steps tried are the replies the customer actually received.
      this.deps.jobs.sessionReplyCount(
        scope,
        {
          conversationId: input.conversationId,
          epoch: input.epoch,
          now: input.now,
          deliveredOnly: true,
        },
        tx,
      ),
    ]);
    return { ...latest, stepsTried };
  }
}
