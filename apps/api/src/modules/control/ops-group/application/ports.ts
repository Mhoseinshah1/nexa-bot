import type {
  OpsLogGroupHealth,
  OpsLogGroupProblem,
  OpsLogGroupStatus,
  OpsLogTopicCategory,
  OpsLogTopicState,
  ScopeContext,
} from '@nexa/contracts';

/** The tenant's operations log group, as stored. */
export interface OpsGroupRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly botInstanceId: string;
  readonly chatId: string;
  readonly title: string;
  readonly status: OpsLogGroupStatus;
  readonly health: OpsLogGroupHealth;
  readonly problems: readonly OpsLogGroupProblem[];
  readonly botMemberStatus: string | null;
  readonly checkedAt: Date | null;
  readonly lastDeliveredAt: Date | null;
  readonly connectedByAdminId: string | null;
  readonly connectedAt: Date;
  readonly disconnectedAt: Date | null;
}

/** One owned topic, as stored. `category` is the raw key; a reader maps unknown ones. */
export interface OpsTopicRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly groupId: string;
  readonly chatId: string;
  readonly category: string;
  readonly state: OpsLogTopicState;
  readonly messageThreadId: number | null;
  readonly creationClaimToken: string | null;
  readonly creationClaimedUntil: Date | null;
  readonly recreatedCount: number;
  readonly lastDeliveredAt: Date | null;
}

/**
 * Persistence for the ops group, its topics and its connection codes.
 *
 * Every state change is a conditional UPDATE naming what it expects to find (the chat, the
 * status, the claim token), so a replay, two worker replicas and a check that finished
 * after the group was rebound elsewhere all change nothing they should not.
 */
export interface OpsGroupRepository {
  findGroup(scope: ScopeContext, tx?: unknown): Promise<OpsGroupRecord | null>;
  /** Row lock on the tenant's group, inside a transaction. */
  lockGroup(scope: ScopeContext, tx: unknown): Promise<OpsGroupRecord | null>;

  insertCode(
    scope: ScopeContext,
    input: {
      readonly id: string;
      readonly botInstanceId: string;
      readonly codeHash: string;
      readonly issuedByAdminId: string;
      readonly issuedAt: Date;
      readonly expiresAt: Date;
    },
    tx: unknown,
  ): Promise<void>;
  /** The latest unconsumed, unexpired code's expiry, or null. */
  outstandingCodeExpiry(scope: ScopeContext, now: Date, tx?: unknown): Promise<Date | null>;
  /**
   * Consumes a code — once. Keyed by tenant AND bot, so a code issued for another bot or
   * tenant is not found. Null when there is no such unconsumed, unexpired code.
   */
  consumeCode(
    scope: ScopeContext,
    input: {
      readonly botInstanceId: string;
      readonly codeHash: string;
      readonly chatId: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<{ readonly issuedByAdminId: string } | null>;

  /** Binds (or rebinds) the tenant's one group row to a chat, CONNECTED and UNVERIFIED. */
  bindGroup(
    scope: ScopeContext,
    input: {
      readonly id: string;
      readonly botInstanceId: string;
      readonly chatId: string;
      readonly title: string;
      readonly connectedByAdminId: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<OpsGroupRecord>;
  /**
   * CONNECTED ⇄ DISCONNECTED, conditional on `from`. A reconnect resets health to
   * UNVERIFIED and stamps a new `connectedAt`, so a check that began before it cannot
   * record its findings over it.
   */
  transitionGroup(
    scope: ScopeContext,
    input: {
      readonly from: OpsLogGroupStatus;
      readonly to: OpsLogGroupStatus;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<boolean>;
  /**
   * Records a permission check's findings — only if the group is still CONNECTED to the
   * very binding the check started from: the same chat, bot and `connectedAt`. A check
   * that was still waiting on Telegram when an operator disconnected, rebound or
   * reconnected the group changes nothing (Codex review #1 of PR #99).
   */
  recordHealth(
    scope: ScopeContext,
    input: {
      readonly chatId: string;
      readonly botInstanceId: string;
      readonly connectedAt: Date;
      readonly health: OpsLogGroupHealth;
      readonly problems: readonly OpsLogGroupProblem[];
      readonly botMemberStatus: string | null;
      readonly title: string | null;
      readonly now: Date;
    },
    tx?: unknown,
  ): Promise<boolean>;
  /** Adds one problem (from a refused send), only if the group still names `chatId`. */
  addProblem(
    scope: ScopeContext,
    input: { readonly chatId: string; readonly problem: OpsLogGroupProblem; readonly now: Date },
    tx?: unknown,
  ): Promise<boolean>;
  /** A membership change Telegram reported: check the group again. */
  markUnverified(
    scope: ScopeContext,
    input: { readonly chatId: string; readonly botInstanceId: string; readonly now: Date },
    tx?: unknown,
  ): Promise<boolean>;
  noteDelivered(
    scope: ScopeContext,
    input: { readonly chatId: string; readonly category: string; readonly at: Date },
  ): Promise<void>;

  listTopics(scope: ScopeContext, chatId: string, tx?: unknown): Promise<OpsTopicRecord[]>;
  /** The row for (chat, category), created PENDING if it did not exist. Idempotent. */
  ensureTopicRow(
    scope: ScopeContext,
    input: {
      readonly id: string;
      readonly groupId: string;
      readonly chatId: string;
      readonly category: OpsLogTopicCategory;
      readonly now: Date;
    },
  ): Promise<OpsTopicRecord>;
  /** READY → MISSING, only while the row still names `staleThreadId`. */
  markTopicMissing(
    scope: ScopeContext,
    input: { readonly topicId: string; readonly staleThreadId: number; readonly now: Date },
  ): Promise<boolean>;
  /**
   * Claims the right to create this topic: a row that is not READY and whose previous
   * claim (if any) has lapsed. Null when somebody else holds it or it is READY.
   */
  claimTopicCreation(
    scope: ScopeContext,
    input: {
      readonly topicId: string;
      readonly token: string;
      readonly until: Date;
      readonly now: Date;
    },
  ): Promise<OpsTopicRecord | null>;
  /** Records the created thread, only for the holder of the claim. */
  completeTopicCreation(
    scope: ScopeContext,
    input: {
      readonly topicId: string;
      readonly token: string;
      readonly threadId: number;
      readonly recreated: boolean;
      readonly now: Date;
    },
  ): Promise<boolean>;
  releaseTopicClaim(
    scope: ScopeContext,
    input: { readonly topicId: string; readonly token: string; readonly now: Date },
  ): Promise<void>;
}

/** Outcome shape shared by every Telegram call the ops group makes. */
export type OpsTelegramFailure = {
  readonly outcome: 'FAILED';
  /** Whether retrying the same call later could answer differently. */
  readonly retryable: boolean;
  readonly errorCode: string;
  readonly errorMessage: string;
};

/**
 * The Telegram calls the ops group needs, and no others. Every one is made OUTSIDE a
 * transaction; the call core asserts it.
 */
export interface OpsGroupTelegram {
  botIdentity(
    token: string,
  ): Promise<{ readonly outcome: 'OK'; readonly botId: string } | OpsTelegramFailure>;
  describeChat(
    token: string,
    chatId: string,
  ): Promise<
    | {
        readonly outcome: 'OK';
        readonly type: string;
        readonly title: string | null;
        readonly isForum: boolean;
      }
    | OpsTelegramFailure
  >;
  botMembership(
    token: string,
    chatId: string,
    botUserId: string,
  ): Promise<
    | {
        readonly outcome: 'OK';
        readonly status: string;
        /**
         * `restricted` only: whether the bot is IN the chat right now (Bot API
         * ChatMemberRestricted.is_member). False is a bot that left while restricted.
         */
        readonly isMember: boolean | null;
        readonly canManageTopics: boolean | null;
        readonly canSendMessages: boolean | null;
      }
    | OpsTelegramFailure
  >;
  createTopic(
    token: string,
    chatId: string,
    name: string,
  ): Promise<{ readonly outcome: 'OK'; readonly threadId: number } | OpsTelegramFailure>;
  send(
    token: string,
    chatId: string,
    threadId: number | null,
    text: string,
  ): Promise<
    | { readonly outcome: 'OK' }
    | (OpsTelegramFailure & {
        readonly topicMissing: boolean;
        readonly chatProblem: OpsLogGroupProblem | null;
      })
  >;
}

/** The bot facts the ops group needs: which bots may join, and their credentials. */
export interface OpsGroupBots {
  /** The tenant's ACTIVE bots, oldest first. */
  activeBots(
    scope: ScopeContext,
  ): Promise<readonly { readonly id: string; readonly username: string }[]>;
  tokenFor(scope: ScopeContext, botInstanceId: string): Promise<string | null>;
  /** Any of the tenant's bots, whatever its status: the group's bot may have been stopped. */
  usernameOf(scope: ScopeContext, botInstanceId: string): Promise<string | null>;
}
