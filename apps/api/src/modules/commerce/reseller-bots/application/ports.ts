import type {
  CurrencyCode,
  HostedBotState,
  ResellerBotChargeKind,
  ResellerBotRequestState,
  TenantContext,
  UserId,
} from '@nexa/contracts';

/** A dedicated-bot request, and its subscription once approved. Never the token in clear. */
export interface ResellerBotRequestRecord {
  readonly id: string;
  readonly number: bigint;
  readonly customerId: UserId;
  readonly status: ResellerBotRequestState;
  readonly telegramBotId: string;
  readonly botUsername: string;
  readonly tokenCiphertext: string;
  readonly tokenKeyId: string;
  readonly domain: string | null;
  readonly feeAmountMinor: bigint;
  readonly feeCurrency: CurrencyCode;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly decidedAt: Date | null;
  readonly decidedByAdminId: string | null;
  readonly rejectReason: string | null;
  readonly cancelledAt: Date | null;
  readonly hostedTenantId: string | null;
  readonly linkedAt: Date | null;
  readonly paidThrough: Date | null;
  readonly lastPeriod: number;
  readonly feeStoppedAt: Date | null;
  readonly activationLinkId: string | null;
  readonly activationLinkCiphertext: string | null;
  readonly activationLinkKeyId: string | null;
  readonly activationLinkSentAt: Date | null;
}

export interface ResellerBotChargeRecord {
  readonly id: string;
  readonly requestId: string;
  readonly period: number;
  readonly kind: ResellerBotChargeKind;
  readonly walletEntryId: string;
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly createdAt: Date;
}

export interface ResellerBotNoticeRecord {
  readonly id: string;
  readonly requestId: string;
  readonly period: number;
  readonly noticeDay: string;
  readonly deadline: Date;
}

/** The stop/resume marks of a subscription, as audit rows recorded them (for the timeline). */
export interface ResellerBotLifecycleMark {
  readonly requestId: string;
  readonly event: 'STOPPED' | 'RESUMED';
  readonly at: Date;
}

/**
 * `reseller_bot_requests`, `reseller_bot_fee_charges` and `reseller_bot_fee_notices` — every
 * row the INSTALLATION tenant's. Every state change is a conditional UPDATE naming its `from`
 * state, answering false when it matched nothing.
 */
/** A due subscription's position in the renewal job's `(paidThrough, id)` order. */
export interface ResellerBotDueCursor {
  readonly id: string;
  readonly paidThrough: Date;
}

export interface ResellerBotRepository {
  insert(
    scope: TenantContext,
    row: {
      readonly id: string;
      readonly customerId: UserId;
      readonly telegramBotId: string;
      readonly botUsername: string;
      readonly tokenCiphertext: string;
      readonly tokenKeyId: string;
      readonly domain: string | null;
      readonly feeAmountMinor: bigint;
      readonly feeCurrency: CurrencyCode;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<ResellerBotRequestRecord>;
  find(
    scope: TenantContext,
    id: string,
    tx?: unknown,
    lock?: boolean,
  ): Promise<ResellerBotRequestRecord | null>;
  findByHosted(
    scope: TenantContext,
    hostedTenantId: string,
    tx?: unknown,
    lock?: boolean,
  ): Promise<ResellerBotRequestRecord | null>;
  findPendingByCustomer(
    scope: TenantContext,
    customerId: UserId,
    tx?: unknown,
  ): Promise<ResellerBotRequestRecord | null>;
  /** Another PENDING or APPROVED request already names this Telegram bot. */
  liveBotTaken(scope: TenantContext, telegramBotId: string, tx?: unknown): Promise<boolean>;
  listByCustomer(scope: TenantContext, customerId: UserId): Promise<ResellerBotRequestRecord[]>;
  listAll(
    scope: TenantContext,
    limit: number,
    cursor?: string,
  ): Promise<ResellerBotRequestRecord[]>;
  /** Minimal owner-only display fields, never customer secrets or unrelated profiles. */
  customerSummaries(
    scope: TenantContext,
    ids: readonly UserId[],
  ): Promise<
    readonly {
      id: string;
      firstName: string | null;
      lastName: string | null;
      username: string | null;
      telegramUserId: string | null;
    }[]
  >;
  hostedStates(
    scope: TenantContext,
    ids: readonly string[],
  ): Promise<
    readonly {
      id: string;
      state: HostedBotState;
    }[]
  >;
  approve(
    scope: TenantContext,
    id: string,
    input: { readonly adminId: string; readonly paidThrough: Date; readonly now: Date },
    tx: unknown,
  ): Promise<boolean>;
  reject(
    scope: TenantContext,
    id: string,
    input: { readonly adminId: string; readonly reason: string; readonly now: Date },
    tx: unknown,
  ): Promise<boolean>;
  cancel(scope: TenantContext, id: string, now: Date, tx: unknown): Promise<boolean>;
  link(
    scope: TenantContext,
    id: string,
    hostedTenantId: string,
    now: Date,
    tx: unknown,
  ): Promise<boolean>;
  /** Moves the subscription from `fromPeriod` to `period`; false when another run moved it. */
  advance(
    scope: TenantContext,
    id: string,
    input: {
      readonly fromPeriod: number;
      readonly period: number;
      readonly paidThrough: Date;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<boolean>;
  setFeeStopped(
    scope: TenantContext,
    id: string,
    stoppedAt: Date | null,
    now: Date,
    tx: unknown,
  ): Promise<boolean>;
  setActivationLink(
    scope: TenantContext,
    id: string,
    link: {
      readonly linkId: string;
      readonly ciphertext: string;
      readonly keyId: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<void>;
  /** The request whose newest link is this one, while that link is still open. */
  findByOpenLink(
    scope: TenantContext,
    linkId: string,
    now: Date,
  ): Promise<{ readonly request: ResellerBotRequestRecord; readonly expiresAt: Date } | null>;
  /**
   * The approved, linked subscriptions whose paid window has ended, oldest first, ordered by
   * `(paidThrough, id)` and starting strictly after `after` when given. The renewal job pages
   * through the WHOLE due set with it: a subscription it cannot settle this pass (short and
   * waiting, or a bot it may not touch) keeps its `paidThrough`, and without the cursor a full
   * first page of those would starve every newer one.
   */
  dueAfter(
    scope: TenantContext,
    now: Date,
    limit: number,
    after: ResellerBotDueCursor | null,
  ): Promise<ResellerBotDueCursor[]>;
  insertCharge(
    scope: TenantContext,
    row: Omit<ResellerBotChargeRecord, 'createdAt'> & { readonly now: Date },
    tx: unknown,
  ): Promise<boolean>;
  listCharges(
    scope: TenantContext,
    requestIds: readonly string[],
  ): Promise<ResellerBotChargeRecord[]>;
  /** Answers the new notice, or null when that (request, period, day) already has one. */
  insertNotice(
    scope: TenantContext,
    row: {
      readonly id: string;
      readonly requestId: string;
      readonly period: number;
      readonly noticeDay: string;
      readonly deadline: Date;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<ResellerBotNoticeRecord | null>;
  findNotice(scope: TenantContext, id: string): Promise<ResellerBotNoticeRecord | null>;
  /** The stop/resume audit marks of these requests, oldest first. */
  lifecycleMarks(
    scope: TenantContext,
    requestIds: readonly string[],
  ): Promise<ResellerBotLifecycleMark[]>;
}
