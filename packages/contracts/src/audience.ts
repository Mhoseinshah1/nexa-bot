import { z } from 'zod';
import { uuidV7Schema } from './ids.js';
import { currencyCodeSchema } from './money.js';
import { SERVICE_STATES } from './provisioning.js';
import { BOT_INSTANCE_STATUSES } from './tenant.js';

/**
 * The shared AUDIENCE — who a broadcast, a mass action or a campaign reaches (round N,
 * `docs/round-n-broadcast-audit.md` §3).
 *
 * ONE definition and ONE query implementation serve every consumer. A broadcast, a mass
 * wallet credit, a mass traffic/time grant and a campaign each freeze a definition of this
 * shape and hand it to the same SQL builder; a second segmentation engine would be a second
 * answer to "who is in this group", and the two would disagree the first time somebody
 * edited only one of them.
 *
 * ## What the Mirza research makes parity, and what it does not
 *
 * VERIFIED on Mirza's `👥 شارژ همگانی` (UBR-021, UBR-022): a tier dimension — all users /
 * `f` / `n` / `n2` — and, independently, a purchase-history dimension — all / with purchases
 * / without purchases. Both are here: `segment` (ordinary customers vs each reseller tier)
 * and `purchase`. Everything else below is a Nexa addition, and "buyer" is NEXA's predicate
 * (Mirza has two that disagree, UNK-RSV2-001): a customer with at least one order in state
 * `PAID` whose purpose is a sale (`SALE_ORDER_PURPOSES`) — the same "PAID commercial order"
 * the business reports count (`docs/wp12-business-analytics-audit.md` rows 9-10). A trial is
 * not a purchase, a top-up is not a purchase, and a refunded order no longer counts.
 *
 * ## Determinism
 *
 * A definition is data, never code. `canonicalAudienceDefinition` fills every default,
 * sorts and de-duplicates every list and fixes the key order, so two definitions that select
 * the same customers serialise identically and hash identically. The relative criteria —
 * "expiring within N hours", "no purchase for N days", an account age — are evaluated
 * against ONE instant (`asOf`) that the evaluator is given, never against the database's
 * own `now()`, so a count and the materialisation that follows it read the same question.
 */

export const AUDIENCE_DEFINITION_VERSION = 1 as const;

/** At most this many explicitly named customers (the one-recipient / hand-picked mode). */
export const AUDIENCE_CUSTOMER_IDS_MAX = 100;
/** At most this many ids in any one list criterion (tiers, products, panels). */
export const AUDIENCE_LIST_MAX = 50;
/** The furthest ahead "expiring within" may look: one year, in hours. */
export const AUDIENCE_EXPIRING_WITHIN_HOURS_MAX = 24 * 366;
/** The largest day count any relative criterion accepts. */
export const AUDIENCE_DAYS_MAX = 3650;
/** How many customers a preview names, as ADR-0010's "show a sample". */
export const AUDIENCE_SAMPLE_SIZE = 10;

/**
 * Whose account status qualifies. `ACTIVE` is the default: a customer an operator blocked
 * is not somebody the installation should be messaging or gifting unless an operator says so.
 */
export const AUDIENCE_CUSTOMER_STATUSES = ['ACTIVE', 'BLOCKED', 'ANY'] as const;
export type AudienceCustomerStatus = (typeof AUDIENCE_CUSTOMER_STATUSES)[number];

/** Mirza's purchase-history dimension (UBR-022), on Nexa's own "buyer" predicate. */
export const AUDIENCE_PURCHASE_FILTERS = ['ANY', 'PURCHASED', 'NEVER_PURCHASED'] as const;
export type AudiencePurchaseFilter = (typeof AUDIENCE_PURCHASE_FILTERS)[number];

/** Whether the customer has ever been granted a free trial (`trial_grants`, any state). */
export const AUDIENCE_TRIAL_FILTERS = ['ANY', 'USED', 'NOT_USED'] as const;
export type AudienceTrialFilter = (typeof AUDIENCE_TRIAL_FILTERS)[number];

/**
 * The customer's part in the referral program (`referrals`): somebody who referred at least
 * one customer (`REFERRER`), somebody who was referred (`REFERRED`), either
 * (`PARTICIPANT`), or neither (`NON_PARTICIPANT`).
 */
export const AUDIENCE_REFERRAL_FILTERS = [
  'ANY',
  'PARTICIPANT',
  'NON_PARTICIPANT',
  'REFERRER',
  'REFERRED',
] as const;
export type AudienceReferralFilter = (typeof AUDIENCE_REFERRAL_FILTERS)[number];

/**
 * Broadcast V2 (program §19): whether the customer has a service that is ACTIVE right now —
 * state `ACTIVE` and an expiry that is open or still after `asOf`, the same instant every
 * relative criterion reads. `NONE` is the negation (no such service, including a customer
 * who never had one), which the "at least one matching service" block cannot express.
 */
export const AUDIENCE_ACTIVE_SERVICE_FILTERS = ['ANY', 'HAS', 'NONE'] as const;
export type AudienceActiveServiceFilter = (typeof AUDIENCE_ACTIVE_SERVICE_FILTERS)[number];

/** At most this many tag ids in either tag list. */
export const AUDIENCE_TAGS_MAX = 20;

const isoInstant = z.iso.datetime({ offset: true });
/** A signed minor-unit amount as decimal text: JSON has no bigint. */
const minorAmount = z.string().regex(/^-?(0|[1-9][0-9]{0,17})$/u, 'must be whole minor units');
const idList = (max: number) => z.array(uuidV7Schema).max(max);

/**
 * Who, by reseller standing. Mirza's `f` / `n` / `n2`, in Nexa's model: a reseller is a
 * customer with an ACTIVE `resellers` row (a SUSPENDED one is an ordinary customer, CLAUDE.md),
 * so `ordinary` selects every customer WITHOUT an active reseller row and `resellerTierIds`
 * selects active resellers in those tiers. `null` means everybody.
 */
export const audienceSegmentSchema = z
  .object({
    ordinary: z.boolean(),
    resellerTierIds: idList(AUDIENCE_LIST_MAX),
  })
  .strict()
  .refine((segment) => segment.ordinary || segment.resellerTierIds.length > 0, {
    message: 'a segment selects ordinary customers, at least one reseller tier, or both',
  });
export type AudienceSegment = z.infer<typeof audienceSegmentSchema>;

/**
 * Broadcast V2 (program §19): the operator-defined customer TAGS (program §8,
 * `docs/customer-notes-tags.md`), by id — never by an editable label. `anyOf`: the customer
 * carries at least one of these tags; `noneOf`: the customer carries none of them. Both
 * given: both hold. An archived tag still selects the customers that carry it, as it still
 * filters the customer list. Ids from another tenant select nobody (the assignment is looked
 * up inside the tenant).
 */
export const audienceTagsSchema = z
  .object({
    anyOf: idList(AUDIENCE_TAGS_MAX).default([]),
    noneOf: idList(AUDIENCE_TAGS_MAX).default([]),
  })
  .strict()
  .refine((tags) => tags.anyOf.length > 0 || tags.noneOf.length > 0, {
    message: 'a tag criterion names at least one tag',
  })
  .refine((tags) => !tags.anyOf.some((id) => tags.noneOf.includes(id)), {
    message: 'a tag cannot be both required and excluded',
  });
export type AudienceTags = z.infer<typeof audienceTagsSchema>;

/**
 * A SERVICE-level criterion: the customer qualifies when at least ONE of their services
 * matches every part given here together — a product, a panel, a state, an expiry window.
 * An empty block (`{}`) means "has at least one service in any state".
 *
 * For a service-targeted mass action (traffic/time) the same block is what picks the
 * SERVICES, so "customers on panel X" and "services on panel X" can never mean two things.
 *
 * - `expiringWithinHours`: an ACTIVE service with an expiry in `[asOf, asOf + N h)`.
 * - `expired`: a service in state `EXPIRED`, or ACTIVE with an expiry already `<= asOf`
 *   (the expiry sweep has not caught up with it yet).
 */
export const audienceServiceCriteriaSchema = z
  .object({
    productIds: idList(AUDIENCE_LIST_MAX).default([]),
    panelIds: idList(AUDIENCE_LIST_MAX).default([]),
    states: z.array(z.enum(SERVICE_STATES)).max(SERVICE_STATES.length).default([]),
    expiringWithinHours: z
      .number()
      .int()
      .min(1)
      .max(AUDIENCE_EXPIRING_WITHIN_HOURS_MAX)
      .nullable()
      .default(null),
    expired: z.boolean().default(false),
  })
  .strict()
  .refine((criteria) => !(criteria.expired && criteria.expiringWithinHours !== null), {
    message: 'a service cannot be both expired and expiring within a window',
  });
export type AudienceServiceCriteria = z.infer<typeof audienceServiceCriteriaSchema>;

/**
 * A wallet balance range, in ONE currency — money is never an amount without one. The
 * balance is derived from the append-only ledger at evaluation time (never a column).
 * Bounds are inclusive; `null` is open.
 */
export const audienceWalletBalanceSchema = z
  .object({
    currency: currencyCodeSchema,
    minMinor: minorAmount.nullable().default(null),
    maxMinor: minorAmount.nullable().default(null),
  })
  .strict()
  .refine((range) => range.minMinor !== null || range.maxMinor !== null, {
    message: 'a balance range needs a minimum, a maximum or both',
  })
  .refine(
    (range) =>
      range.minMinor === null ||
      range.maxMinor === null ||
      BigInt(range.minMinor) <= BigInt(range.maxMinor),
    { message: 'the minimum balance is above the maximum' },
  );
export type AudienceWalletBalance = z.infer<typeof audienceWalletBalanceSchema>;

/**
 * The definition, as a caller submits it. Every field is optional; an omitted one does not
 * narrow the audience. Instants are half-open `[from, before)`, as every reporting interval.
 */
export const audienceDefinitionSchema = z
  .object({
    version: z.literal(AUDIENCE_DEFINITION_VERSION),
    /** Hand-picked customers; `null` means no restriction. Mirza's per-user send (web). */
    customerIds: idList(AUDIENCE_CUSTOMER_IDS_MAX).min(1).nullable().default(null),
    customerStatus: z.enum(AUDIENCE_CUSTOMER_STATUSES).default('ACTIVE'),
    segment: audienceSegmentSchema.nullable().default(null),
    purchase: z.enum(AUDIENCE_PURCHASE_FILTERS).default('ANY'),
    /** Registration (`customers.first_seen_at`), half-open. */
    registeredFrom: isoInstant.nullable().default(null),
    registeredBefore: isoInstant.nullable().default(null),
    /** Account age at `asOf`, in whole days, inclusive. */
    accountAgeMinDays: z.number().int().min(0).max(AUDIENCE_DAYS_MAX).nullable().default(null),
    accountAgeMaxDays: z.number().int().min(0).max(AUDIENCE_DAYS_MAX).nullable().default(null),
    /** The customer's LAST purchase (`max(settled_at)` of their PAID sale orders), half-open. */
    lastPurchaseFrom: isoInstant.nullable().default(null),
    lastPurchaseBefore: isoInstant.nullable().default(null),
    /**
     * No purchase settled in the last N days before `asOf` — which includes a customer who
     * never bought. Combine with `purchase: PURCHASED` for lapsed buyers only.
     */
    noPurchaseForDays: z.number().int().min(1).max(AUDIENCE_DAYS_MAX).nullable().default(null),
    walletBalance: audienceWalletBalanceSchema.nullable().default(null),
    trial: z.enum(AUDIENCE_TRIAL_FILTERS).default('ANY'),
    referral: z.enum(AUDIENCE_REFERRAL_FILTERS).default('ANY'),
    service: audienceServiceCriteriaSchema.nullable().default(null),
    /** Broadcast V2: the customer's tags (program §8). */
    tags: audienceTagsSchema.nullable().default(null),
    /** Broadcast V2: has / has no service that is active now. */
    activeService: z.enum(AUDIENCE_ACTIVE_SERVICE_FILTERS).default('ANY'),
    /**
     * Roadmap C3: the bot the customer is reached through — `customers.first_bot_instance_id`,
     * the same bot a broadcast freezes onto each recipient row and sends through. `null`
     * means every bot. A bot of another tenant selects nobody; a customer who never wrote
     * to a bot is selected by no bot.
     */
    botInstanceIds: idList(AUDIENCE_LIST_MAX).min(1).nullable().default(null),
  })
  .strict()
  .refine(
    (d) =>
      d.registeredFrom === null ||
      d.registeredBefore === null ||
      Date.parse(d.registeredFrom) < Date.parse(d.registeredBefore),
    { message: 'the registration range is empty' },
  )
  .refine(
    (d) =>
      d.lastPurchaseFrom === null ||
      d.lastPurchaseBefore === null ||
      Date.parse(d.lastPurchaseFrom) < Date.parse(d.lastPurchaseBefore),
    { message: 'the last-purchase range is empty' },
  )
  .refine(
    (d) =>
      d.accountAgeMinDays === null ||
      d.accountAgeMaxDays === null ||
      d.accountAgeMinDays <= d.accountAgeMaxDays,
    { message: 'the account-age range is empty' },
  )
  .refine(
    (d) =>
      d.purchase !== 'NEVER_PURCHASED' ||
      (d.lastPurchaseFrom === null && d.lastPurchaseBefore === null),
    { message: 'a customer who never purchased has no last purchase' },
  );

type ParsedAudienceDefinition = z.output<typeof audienceDefinitionSchema>;

/**
 * The definition after parsing: every field present with its default — except the two
 * Broadcast V2 dimensions, which the CANONICAL form carries only when they narrow anything
 * (see `canonicalAudienceDefinition`). Absent means `null` / `'ANY'`.
 */
export type AudienceDefinition = Omit<
  ParsedAudienceDefinition,
  'tags' | 'activeService' | 'botInstanceIds'
> & {
  readonly tags?: AudienceTags | null;
  readonly activeService?: AudienceActiveServiceFilter;
  /** Roadmap C3: appended like the Broadcast V2 keys, only when it narrows anything. */
  readonly botInstanceIds?: readonly string[] | null;
};
/** What a caller may submit: omitted fields take their defaults. */
export type AudienceDefinitionInput = z.input<typeof audienceDefinitionSchema>;

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}

/** An ISO instant in its one canonical spelling: UTC, milliseconds, `Z`. */
function canonicalInstant(value: string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

/**
 * The ONE spelling of a definition: parsed, defaults filled, lists sorted and de-duplicated,
 * instants in UTC, keys in a fixed order. What is frozen into a snapshot and hashed.
 *
 * Throws the schema's own error on an invalid definition, so a caller cannot freeze one.
 */
export function canonicalAudienceDefinition(input: unknown): AudienceDefinition {
  const d = audienceDefinitionSchema.parse(input);
  return {
    version: AUDIENCE_DEFINITION_VERSION,
    customerIds: d.customerIds === null ? null : sortedUnique(d.customerIds),
    customerStatus: d.customerStatus,
    segment:
      d.segment === null
        ? null
        : {
            ordinary: d.segment.ordinary,
            resellerTierIds: sortedUnique(d.segment.resellerTierIds),
          },
    purchase: d.purchase,
    registeredFrom: canonicalInstant(d.registeredFrom),
    registeredBefore: canonicalInstant(d.registeredBefore),
    accountAgeMinDays: d.accountAgeMinDays,
    accountAgeMaxDays: d.accountAgeMaxDays,
    lastPurchaseFrom: canonicalInstant(d.lastPurchaseFrom),
    lastPurchaseBefore: canonicalInstant(d.lastPurchaseBefore),
    noPurchaseForDays: d.noPurchaseForDays,
    walletBalance:
      d.walletBalance === null
        ? null
        : {
            currency: d.walletBalance.currency,
            minMinor:
              d.walletBalance.minMinor === null
                ? null
                : BigInt(d.walletBalance.minMinor).toString(),
            maxMinor:
              d.walletBalance.maxMinor === null
                ? null
                : BigInt(d.walletBalance.maxMinor).toString(),
          },
    trial: d.trial,
    referral: d.referral,
    service:
      d.service === null
        ? null
        : {
            productIds: sortedUnique(d.service.productIds),
            panelIds: sortedUnique(d.service.panelIds),
            states: sortedUnique(d.service.states),
            expiringWithinHours: d.service.expiringWithinHours,
            expired: d.service.expired,
          },
    /*
     * Broadcast V2's two dimensions are APPENDED, and only when they narrow the audience. A
     * definition that uses neither therefore serialises byte for byte as it did before they
     * existed, so its sha256 is unchanged: a draft saved, or an audience frozen, by the
     * previous release still matches the hash it was confirmed under. Pinned by a golden hash
     * in `tests/unit/audience-definition.test.ts`.
     */
    ...(d.tags === null
      ? {}
      : { tags: { anyOf: sortedUnique(d.tags.anyOf), noneOf: sortedUnique(d.tags.noneOf) } }),
    ...(d.activeService === 'ANY' ? {} : { activeService: d.activeService }),
    // Roadmap C3, by the same rule: absent unless it narrows, so every older hash holds.
    ...(d.botInstanceIds === null ? {} : { botInstanceIds: sortedUnique(d.botInstanceIds) }),
  };
}

/**
 * The canonical JSON a definition is hashed and stored as. `canonicalAudienceDefinition`
 * fixes the key order, so `JSON.stringify` of its result is deterministic.
 */
export function canonicalAudienceJson(input: unknown): string {
  return JSON.stringify(canonicalAudienceDefinition(input));
}

/** The audience's fingerprint: the md5 of its sorted customer ids, as PostgreSQL computes it. */
export const audienceFingerprintSchema = z.string().regex(/^[0-9a-f]{32}$/u);

// --- HTTP -------------------------------------------------------------------------------

/** `POST /audience/preview`: count one definition now. Writes nothing. */
export const audiencePreviewRequestSchema = z.object({ definition: z.unknown() }).strict();
export type AudiencePreviewRequest = z.infer<typeof audiencePreviewRequestSchema>;

/** One sampled customer, by the fields an operator recognises them by. */
export const audienceSampleCustomerSchema = z.object({
  id: z.string(),
  firstName: z.string().nullable(),
  username: z.string().nullable(),
  telegramUserId: z.string(),
});
export type AudienceSampleCustomer = z.infer<typeof audienceSampleCustomerSchema>;

export const audiencePreviewSchema = z.object({
  /** The instant every relative criterion was evaluated against. */
  asOf: z.iso.datetime(),
  /** The canonical definition that was counted — what a confirmation must send back. */
  definition: z.unknown(),
  /** sha256 of the canonical JSON. */
  definitionHash: z.string().regex(/^[0-9a-f]{64}$/u),
  /** Every customer the definition selects. */
  customers: z.number().int().nonnegative(),
  /**
   * Of those, the ones with a bot to be reached through (`first_bot_instance_id`). A
   * customer with none can be credited but never messaged.
   */
  reachable: z.number().int().nonnegative(),
  /** md5 of the sorted ids: a confirmation binds to the SET, not only to its size. */
  fingerprint: audienceFingerprintSchema,
  /**
   * Broadcast V2 (program §19), the audience ESTIMATE for a MARKETING broadcast: of
   * `customers`, how many have opted out of promotions right now and would be skipped at
   * the send if they still have when it goes and the installation still honours the opt-out.
   * An estimate, not a promise — since #143 the SEND alone decides, so it is not subtracted
   * from `customers` and binds nothing. Absent or null where it does not apply: a service
   * announcement, a mass action, the policy switched off, or a frozen audience.
   */
  optedOut: z.number().int().nonnegative().nullable().optional(),
  sample: z.array(audienceSampleCustomerSchema).max(AUDIENCE_SAMPLE_SIZE),
});
export type AudiencePreview = z.infer<typeof audiencePreviewSchema>;

export const audiencePreviewResponseSchema = z.object({ preview: audiencePreviewSchema });
export type AudiencePreviewResponse = z.infer<typeof audiencePreviewResponseSchema>;

/**
 * `GET /audience/options`: the names a builder offers — reseller tiers, products, panels —
 * and the currency a balance range is written in. Names only; nothing a list page would
 * need its own permission for.
 */
export const audienceOptionsResponseSchema = z.object({
  currency: currencyCodeSchema,
  resellerTiers: z.array(z.object({ id: z.string(), name: z.string() })),
  products: z.array(z.object({ id: z.string(), title: z.string() })),
  panels: z.array(z.object({ id: z.string(), name: z.string() })),
  /**
   * Broadcast V2: the tenant's customer tags (program §8), archived ones included and marked —
   * an archived tag still selects the customers that carry it.
   */
  tags: z.array(z.object({ id: z.string(), label: z.string(), archived: z.boolean() })),
  /**
   * Roadmap C3: the tenant's bots, by the name Telegram knows them by and their status. A
   * response from a release before this one has none, and parses as an empty list.
   */
  bots: z
    .array(
      z.object({ id: z.string(), username: z.string(), status: z.enum(BOT_INSTANCE_STATUSES) }),
    )
    .default([]),
});
export type AudienceOptionsResponse = z.infer<typeof audienceOptionsResponseSchema>;

/** Paths under `API_PREFIX`. */
export const AUDIENCE_ROUTES = {
  preview: '/audience/preview',
  options: '/audience/options',
} as const;

// --- Frozen audiences (round N close, `docs/round-n-close-audit.md` §A) -----------------

/**
 * A FROZEN audience: the exact member identities a confirmation selected, materialised
 * durably at confirmation time, immutable afterwards, and named by id.
 *
 * Why it exists: a campaign hands its gifts and its announcement to the shared engines
 * AFTER its own confirmation commits, and a hand-over that is interrupted and retried later
 * used to re-evaluate the live definition — which had moved — and refuse (`OQ-C1-04`). A
 * definition selects "whoever matches now"; a frozen audience is "these people, decided
 * then". The engines accept either: a definition (evaluated live, as before) or a frozen
 * audience's id (its members copied, never re-selected). Live SAFETY facts — a customer
 * blocked since, a service no longer active, a panel no longer operable, a customer who
 * opted out of promotions — are still re-read at the actual money or provider write.
 *
 * `CUSTOMERS` freezes customer ids (the audience's customers); `SERVICES` freezes
 * `(customer, service)` pairs, for a traffic or time gift whose recipients are services.
 */
export const FROZEN_AUDIENCE_KINDS = ['CUSTOMERS', 'SERVICES'] as const;
export type FrozenAudienceKind = (typeof FROZEN_AUDIENCE_KINDS)[number];

/**
 * The grant a SERVICES audience was frozen FOR. Its members were selected by that grant's
 * own eligibility rule — a traffic grant needs a panel that can ADD_TRAFFIC, a time grant
 * one that can ADD_TIME — so a set frozen for one is not a set frozen for the other, and a
 * mass operation of the other kind refuses it (`FROZEN_KIND_MISMATCH`). Null for a
 * CUSTOMERS audience, which no grant rule selected.
 */
export const FROZEN_AUDIENCE_GRANT_KINDS = ['SERVICE_TRAFFIC', 'SERVICE_TIME'] as const;
export type FrozenAudienceGrantKind = (typeof FROZEN_AUDIENCE_GRANT_KINDS)[number];

/**
 * How long a frozen audience's member rows are kept once nothing live references them.
 * The header (count, fingerprint, definition, hash) is never deleted: it is the record of
 * what was confirmed. Members are released by a sweep only when every campaign action,
 * mass operation and broadcast that names the audience has ended, and at least this many
 * days have passed since it was frozen — never by age alone, because a campaign may be
 * confirmed up to fifty-nine days before it starts.
 */
export const FROZEN_AUDIENCE_RELEASE_AFTER_DAYS = 1;

/** A frozen audience as HTTP carries it: its header, never its members. */
export const frozenAudienceSchema = z.object({
  id: z.string(),
  kind: z.enum(FROZEN_AUDIENCE_KINDS),
  /** The grant a SERVICES audience was selected for; null for CUSTOMERS. */
  grantKind: z.enum(FROZEN_AUDIENCE_GRANT_KINDS).nullable(),
  /** sha256 of the canonical definition the audience was selected by. */
  definitionHash: z.string().regex(/^[0-9a-f]{64}$/u),
  /** The instant every relative criterion was evaluated against. */
  asOf: z.iso.datetime(),
  /** Members: customers for `CUSTOMERS`, services for `SERVICES`. */
  count: z.number().int().nonnegative(),
  /** md5 over the sorted member ids (customer ids, or service ids). */
  fingerprint: audienceFingerprintSchema,
  frozenAt: z.iso.datetime(),
  /** When the member rows were released by the sweep; null while they are still held. */
  releasedAt: z.iso.datetime().nullable(),
});
export type FrozenAudienceResponseItem = z.infer<typeof frozenAudienceSchema>;

export const AUDIENCE_ERROR_CODES = {
  /** The definition does not match its schema. */
  DEFINITION_INVALID: 'audience.definition_invalid',
  /**
   * The audience a confirmation named is not the audience that exists now: its size or its
   * membership (the fingerprint) changed since the preview. Nothing was written.
   */
  CHANGED: 'audience.changed',
  /** The definition selects nobody. */
  EMPTY: 'audience.empty',
  /** The frozen audience a confirmation named does not exist in this tenant. */
  FROZEN_NOT_FOUND: 'audience.frozen_not_found',
  /** The frozen audience's members were released by the sweep; it can seed nothing now. */
  FROZEN_RELEASED: 'audience.frozen_released',
  /**
   * A CUSTOMERS audience was given where a SERVICES one was needed, or the reverse — or a
   * SERVICES audience frozen for the other grant kind.
   */
  FROZEN_KIND_MISMATCH: 'audience.frozen_kind_mismatch',
} as const;
