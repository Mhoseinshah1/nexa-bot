import type {
  AudienceDefinition,
  CampaignAnnouncementTerms,
  CampaignTimeGiftTerms,
  CampaignTrafficGiftTerms,
  CampaignWalletGiftTerms,
  Calendar,
  CampaignActionKind,
  CampaignActionState,
  CampaignState,
  CurrencyCode,
  DiscountKind,
  DiscountType,
  DiscountablePurpose,
  TenantContext,
} from '@nexa/contracts';

/**
 * The campaign module's ports (`docs/round-n-campaigns-audit.md`).
 *
 * A campaign is a composition record, so the only repository it owns is its own; every
 * rule it creates goes through the pricing module's own repositories, and every send,
 * credit or provider operation through the shared audience, Broadcast and mass-action
 * engines. Nothing here prices, credits, sends or dials.
 */

/** The terms of a campaign's discount: `DiscountRuleWrite` minus what the campaign owns. */
export interface CampaignDiscountTerms {
  readonly kind: DiscountKind;
  readonly code: string | null;
  readonly type: DiscountType;
  /** Whole percent for `PERCENTAGE`, minor units for `FIXED_AMOUNT`. */
  readonly value: bigint;
  readonly currency: CurrencyCode | null;
  readonly appliesTo: readonly DiscountablePurpose[];
  readonly productId: string | null;
  readonly categoryId: string | null;
  readonly firstPurchaseOnly: boolean;
  readonly minimumSubtotal: bigint | null;
  readonly totalLimit: number | null;
  readonly perCustomerLimit: number | null;
  readonly priority: number;
  readonly stackable: boolean;
}

/** The terms of a campaign's cashback: `CashbackRuleWrite` minus label and window. */
export interface CampaignCashbackTerms {
  readonly percent: number;
  readonly appliesTo: readonly DiscountablePurpose[];
  readonly productId: string | null;
  readonly categoryId: string | null;
}

/** An action's frozen configuration, by kind. */
export type CampaignActionConfig =
  | { readonly kind: 'DISCOUNT'; readonly terms: CampaignDiscountTerms }
  | { readonly kind: 'CASHBACK'; readonly terms: CampaignCashbackTerms }
  | { readonly kind: 'WALLET_GIFT'; readonly terms: CampaignWalletGiftTerms }
  | { readonly kind: 'TRAFFIC_GIFT'; readonly terms: CampaignTrafficGiftTerms }
  | { readonly kind: 'TIME_GIFT'; readonly terms: CampaignTimeGiftTerms }
  | { readonly kind: 'ANNOUNCEMENT'; readonly terms: CampaignAnnouncementTerms };

/** The kinds the shared mass-action engine runs. */
export type CampaignGiftConfig = Extract<
  CampaignActionConfig,
  { kind: 'WALLET_GIFT' | 'TRAFFIC_GIFT' | 'TIME_GIFT' }
>;

/**
 * A launched action's frozen confirmation binding: exactly what the operator confirmed for
 * its engine, kept so an interrupted hand-over is retried with the same request under the
 * same key (the engine then replays, never creates a second operation).
 */
export interface CampaignLaunchBindingRecord {
  readonly count: number;
  readonly fingerprint: string;
  readonly typedCount: number | null;
  /** Wallet gift only: amount × count, minor units, in the gift's currency. */
  readonly totalMinor: string | null;
}

export interface CampaignRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly state: CampaignState;
  readonly startsAt: Date;
  readonly endsAt: Date;
  /** The shared audience definition, as the audience engine's own contract parses it. */
  readonly audience: AudienceDefinition;
  readonly audienceHash: string;
  readonly audienceFrozenAt: Date | null;
  readonly audienceConfirmedCount: number | null;
  readonly audienceFingerprint: string | null;
  readonly createdByAdminId: string | null;
  readonly scheduledByAdminId: string | null;
  readonly scheduledAt: Date | null;
  readonly startedAt: Date | null;
  readonly pausedAt: Date | null;
  readonly completedAt: Date | null;
  readonly cancelledByAdminId: string | null;
  readonly cancelledAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CampaignActionRecord {
  readonly id: string;
  readonly campaignId: string;
  readonly kind: CampaignActionKind;
  readonly state: CampaignActionState;
  readonly config: CampaignActionConfig;
  readonly discountId: string | null;
  readonly cashbackRuleId: string | null;
  readonly broadcastId: string | null;
  readonly bulkOperationId: string | null;
  readonly binding: CampaignLaunchBindingRecord | null;
  /**
   * Round N close (§A): the frozen audience the engine record is seeded from, materialised
   * in the confirming transaction beside the binding. A hand-over retried after the live
   * audience moved copies its members, never re-selects.
   */
  readonly frozenAudienceId: string | null;
  readonly failureCode: string | null;
  readonly launchedAt: Date | null;
}

/** What an operator writes for a draft. The window is already resolved to instants. */
export interface CampaignDraftWrite {
  readonly name: string;
  readonly description: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  /** Canonical, from `freezeAudience`: one spelling, one hash. */
  readonly audience: AudienceDefinition;
  readonly audienceHash: string;
  readonly actions: readonly CampaignActionConfig[];
}

export interface CampaignCursor {
  readonly createdAt: string;
  readonly id: string;
}

export interface CampaignPage {
  readonly items: readonly CampaignRecord[];
  readonly nextCursor: CampaignCursor | null;
}

/** One figure grouped by the state it is in, with its sum in one currency. */
export interface StateTally {
  readonly state: string;
  readonly count: number;
  readonly amount: bigint;
  readonly currency: CurrencyCode | null;
}

/**
 * The persisted facts a campaign's discount produced: its redemptions, grouped by the
 * state their order is in NOW, with the amount the quote took off. Nothing here says a
 * purchase was CAUSED by the campaign; it says the order redeemed the campaign's rule.
 */
export interface DiscountOutcome {
  readonly byOrderState: readonly StateTally[];
}

/** The cashback promises made under the campaign's rule, by state, and their reversals. */
export interface CashbackOutcome {
  readonly byState: readonly StateTally[];
  /** One entry per currency: amounts in different currencies are never added together. */
  readonly totals: readonly {
    readonly currency: CurrencyCode;
    readonly earned: bigint;
    readonly reversedRecovered: bigint;
    readonly reversedUnrecovered: bigint;
  }[];
}

export interface CampaignRepository {
  insertDraft(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly write: CampaignDraftWrite;
      readonly actionIds: readonly string[];
      readonly createdByAdminId: string | null;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<CampaignRecord>;

  /** Replaces a DRAFT's fields and actions. False when the campaign is no longer a DRAFT. */
  replaceDraft(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly write: CampaignDraftWrite;
      readonly actionIds: readonly string[];
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<boolean>;

  findById(scope: TenantContext, id: string, tx?: unknown): Promise<CampaignRecord | null>;

  /** `SELECT … FOR UPDATE`: the outermost lock of every campaign command. */
  lockById(scope: TenantContext, id: string, tx: unknown): Promise<CampaignRecord | null>;

  actionsOf(
    scope: TenantContext,
    campaignId: string,
    tx?: unknown,
  ): Promise<readonly CampaignActionRecord[]>;

  list(
    scope: TenantContext,
    search: { readonly state?: CampaignState },
    limit: number,
    cursor: CampaignCursor | null,
  ): Promise<CampaignPage>;

  /** DRAFT → SCHEDULED, freezing the audience. Conditional; false when it did not move. */
  schedule(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly adminId: string | null;
      readonly confirmedCount: number;
      readonly fingerprint: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<boolean>;

  /** SCHEDULED → ACTIVE, only once `starts_at ≤ now`. Conditional. */
  start(scope: TenantContext, id: string, now: Date, tx: unknown): Promise<boolean>;

  /** ACTIVE → PAUSED. Conditional. */
  pause(scope: TenantContext, id: string, now: Date, tx: unknown): Promise<boolean>;

  /** PAUSED → ACTIVE, only while `now < ends_at`. Conditional. */
  resume(scope: TenantContext, id: string, now: Date, tx: unknown): Promise<boolean>;

  /** ACTIVE|PAUSED → COMPLETED, only once `ends_at ≤ now`. Conditional. */
  complete(scope: TenantContext, id: string, now: Date, tx: unknown): Promise<boolean>;

  /** Any non-terminal state → CANCELLED. Conditional. */
  cancel(
    scope: TenantContext,
    input: { readonly id: string; readonly adminId: string | null; readonly now: Date },
    tx: unknown,
  ): Promise<boolean>;

  /** Campaign ids whose start is due, oldest first, bounded. */
  dueToStart(scope: TenantContext, now: Date, limit: number): Promise<readonly string[]>;

  /** Campaign ids whose end has passed while ACTIVE or PAUSED, oldest first, bounded. */
  dueToComplete(scope: TenantContext, now: Date, limit: number): Promise<readonly string[]>;

  /** Freezes each launched action's binding and frozen audience, at the schedule. Conditional on PENDING. */
  bindAction(
    scope: TenantContext,
    input: {
      readonly actionId: string;
      readonly binding: CampaignLaunchBindingRecord;
      readonly frozenAudienceId: string;
    },
    tx: unknown,
  ): Promise<boolean>;

  /** Names the engine record a launched action became, and marks it LAUNCHED. */
  linkEngine(
    scope: TenantContext,
    input: {
      readonly actionId: string;
      readonly broadcastId?: string;
      readonly bulkOperationId?: string;
      readonly now: Date;
    },
    tx?: unknown,
  ): Promise<boolean>;

  /** PENDING → FAILED with the engine's refusal code. */
  failAction(
    scope: TenantContext,
    input: { readonly actionId: string; readonly code: string; readonly now: Date },
    tx?: unknown,
  ): Promise<boolean>;

  /** Names the rule an action created, and marks it LAUNCHED. Conditional on PENDING. */
  linkRule(
    scope: TenantContext,
    input: {
      readonly actionId: string;
      readonly discountId?: string;
      readonly cashbackRuleId?: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<boolean>;

  /** PENDING → CANCELLED for every action of the campaign that never launched. */
  cancelPendingActions(
    scope: TenantContext,
    campaignId: string,
    now: Date,
    tx: unknown,
  ): Promise<number>;

  discountOutcome(scope: TenantContext, discountId: string): Promise<DiscountOutcome>;

  cashbackOutcome(scope: TenantContext, cashbackRuleId: string): Promise<CashbackOutcome>;

  /**
   * Roadmap C3: the campaign discount's PAID redeemers set against the announcement's frozen
   * recipient rows (`broadcast_recipients`, never released). Distinct customers.
   */
  announcementAttribution(
    scope: TenantContext,
    input: { readonly broadcastId: string; readonly discountId: string },
  ): Promise<AnnouncementAttribution>;
}

/** Roadmap C3: who was told, who was delivered to, and who of each redeemed. */
export interface AnnouncementAttribution {
  readonly told: number;
  readonly delivered: number;
  readonly redeemersTold: number;
  readonly redeemersDelivered: number;
  readonly redeemersNotTold: number;
}

/** The tenant's own calendar and zone, and the one conversion a campaign window needs. */
export interface CampaignCalendar {
  presentationFor(
    scope: TenantContext,
    tx?: unknown,
  ): Promise<{ readonly timezone: string; readonly calendar: Calendar }>;

  /**
   * The instant the tenant's wall clock reads `time` (`HH:MM`) on `date` (`YYYY-MM-DD` in
   * the tenant's calendar). Null when either is unreadable or the date does not exist.
   */
  instantOf(
    date: string,
    time: string,
    presentation: { readonly timezone: string; readonly calendar: Calendar },
  ): Date | null;

  /** The inverse, for showing a stored instant back in the same form. */
  localOf(
    at: Date,
    presentation: { readonly timezone: string; readonly calendar: Calendar },
  ): { readonly date: string; readonly time: string };
}
