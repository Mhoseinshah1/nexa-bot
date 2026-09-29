import { z } from 'zod';
import { audienceFingerprintSchema } from './audience.js';
import { currencyCodeSchema } from './money.js';
import { TRAFFIC_GB_PATTERN } from './traffic-input.js';

/**
 * Safe mass actions — «عملیات گروهی» (round N, B2; `docs/round-n-broadcast-audit.md` §6).
 *
 * Three kinds, each over the SHARED audience (`audience.ts`):
 *
 * - `WALLET_CREDIT`: one append-only `MASS_CREDIT` ledger entry per customer. Mirza's
 *   `👥 شارژ همگانی` (UBR-020..023) keeps its amount → tier → purchase history → notify
 *   dimensions, and gains what Mirza does not have: an exact count, the total liability, a
 *   confirmation bound to the previewed set, and a record.
 * - `SERVICE_TRAFFIC` / `SERVICE_TIME`: one durable `ADD_TRAFFIC` / `ADD_TIME` provisioning
 *   operation per ELIGIBLE existing service, planned through the same planner a purchased
 *   add-on uses (`ProvisioningService`), executed by the same provisioner, with no new provider
 *   write path. Mirza's `🔋 حجم یا زمان همگانی` exists but every behaviour of it is UNKNOWN
 *   (UNK-UM-014), so none of this is claimed as parity.
 *
 * ## Exactly once, and what cancelling means
 *
 * Every item is processed in ONE transaction that moves it out of `PENDING` by a conditional
 * UPDATE and writes its effect beside it. A wallet entry's reference is
 * `bulk:<operation>:<customer>`, unique per tenant, so even a transaction that somehow ran
 * twice could not credit twice; a provisioning operation's id is derived from the bulk
 * operation and the service, so a replayed plan is the same operation. Cancelling moves every
 * item still `PENDING` to `CANCELLED` in one UPDATE; an item already processed keeps its
 * effect — a credit is never reversed by a cancel, and a planned provider operation runs to
 * its own authoritative end.
 */

export const BULK_OPERATION_KINDS = ['WALLET_CREDIT', 'SERVICE_TRAFFIC', 'SERVICE_TIME'] as const;
export type BulkOperationKind = (typeof BULK_OPERATION_KINDS)[number];

export const BULK_OPERATION_STATES = ['RUNNING', 'COMPLETED', 'CANCELLED'] as const;
export type BulkOperationState = (typeof BULK_OPERATION_STATES)[number];

export const BULK_ITEM_STATES = [
  /** Not processed yet. The only state a cancel touches. */
  'PENDING',
  /** WALLET_CREDIT: the ledger entry is written. Terminal. */
  'CREDITED',
  /** SERVICE_*: the provisioning operation is planned; its own state decides what follows. */
  'PLANNED',
  /** SERVICE_*: the provider applied it, authoritatively (including after reconciliation). */
  'SUCCEEDED',
  /** SERVICE_*: the provider refused it, or it was abandoned after reconciliation. */
  'FAILED',
  /** A live eligibility fact at processing time said no; `reason` says which. Nothing written. */
  'SKIPPED',
  /** The operation was cancelled before this item was processed. */
  'CANCELLED',
] as const;
export type BulkItemState = (typeof BULK_ITEM_STATES)[number];

/**
 * Why an item was skipped. Each is a LIVE fact re-read when the item is processed, because a
 * frozen list decides WHO, and only the present can decide whether money or a provider write
 * is still safe.
 */
export const BULK_SKIP_REASONS = [
  'CUSTOMER_BLOCKED',
  'CURRENCY_CHANGED',
  'SERVICE_NOT_ELIGIBLE',
  'SERVICE_NOT_OWNED',
  'PANEL_NOT_OPERABLE',
  'ACTION_IN_PROGRESS',
  'UNLIMITED',
  'LIMIT_EXCEEDED',
  'REFUND_REQUESTED',
  'TERMINATION_PENDING',
] as const;
export type BulkSkipReason = (typeof BULK_SKIP_REASONS)[number];

/** From this many items the count must also be TYPED back, as for a broadcast. */
export const BULK_LARGE_OPERATION = 100;
/** A mass traffic grant's bound per service: 1 TB, typed in GB. */
export const BULK_TRAFFIC_MAX_BYTES = 1024n * 1_073_741_824n;
/** A mass time grant's bound per service, in days. */
export const BULK_DURATION_MAX_DAYS = 365;
export const BULK_NOTE_MAX_LENGTH = 300;
export const BULK_PAGE_DEFAULT = 25;
export const BULK_PAGE_MAX = 100;

export const bulkOperationListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(BULK_PAGE_MAX).optional(),
  cursor: z.string().min(1).max(200).optional(),
});

export const bulkItemListQuerySchema = z.object({
  state: z.enum(BULK_ITEM_STATES).optional(),
  limit: z.coerce.number().int().min(1).max(BULK_PAGE_MAX).optional(),
  cursor: z.string().min(1).max(200).optional(),
});

// --- HTTP -------------------------------------------------------------------------------

const minorAmount = z.string().regex(/^[1-9][0-9]{0,17}$/u, 'must be positive whole minor units');

/** What each kind grants. Exactly one of the three shapes, by `kind`. */
export const bulkGrantSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('WALLET_CREDIT'),
      amountMinor: minorAmount,
      currency: currencyCodeSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('SERVICE_TRAFFIC'),
      /** Typed in GB, at most two decimals (WP21). */
      trafficGb: z.string().regex(TRAFFIC_GB_PATTERN),
    })
    .strict(),
  z
    .object({
      kind: z.literal('SERVICE_TIME'),
      durationDays: z.number().int().min(1).max(BULK_DURATION_MAX_DAYS),
    })
    .strict(),
]);
export type BulkGrant = z.infer<typeof bulkGrantSchema>;

export const bulkPreviewRequestSchema = z
  .object({ grant: bulkGrantSchema, definition: z.unknown() })
  .strict();
export type BulkPreviewRequest = z.infer<typeof bulkPreviewRequestSchema>;

export const bulkPreviewSchema = z.object({
  kind: z.enum(BULK_OPERATION_KINDS),
  asOf: z.iso.datetime(),
  definition: z.unknown(),
  definitionHash: z.string().regex(/^[0-9a-f]{64}$/u),
  /** Customers for a wallet credit; eligible SERVICES for a traffic/time grant. */
  count: z.number().int().nonnegative(),
  /** Distinct customers behind `count`. */
  customers: z.number().int().nonnegative(),
  fingerprint: audienceFingerprintSchema,
  /** Wallet credit only: amount × count, in the grant's currency. Null otherwise. */
  totalLiability: z.object({ amountMinor: z.string(), currency: currencyCodeSchema }).nullable(),
  /** Traffic grant only: the bytes each service is given. */
  trafficBytesPerItem: z.string().nullable(),
  /** Time grant only: the days each service is given. */
  durationDaysPerItem: z.number().int().nullable(),
  sample: z.array(
    z.object({
      customerId: z.string(),
      firstName: z.string().nullable(),
      username: z.string().nullable(),
      serviceId: z.string().nullable(),
      serviceLabel: z.string().nullable(),
    }),
  ),
});
export type BulkPreview = z.infer<typeof bulkPreviewSchema>;
export const bulkPreviewResponseSchema = z.object({ preview: bulkPreviewSchema });
export type BulkPreviewResponse = z.infer<typeof bulkPreviewResponseSchema>;

/**
 * The destructive confirmation. It binds to what the operator saw — the definition's hash,
 * the count, the set's fingerprint and, for money, the total liability — and it carries a
 * mandatory reason (ADR-0010). From `BULK_LARGE_OPERATION` items, and ALWAYS for a wallet
 * credit, the count must also be typed back.
 */
export const createBulkOperationRequestSchema = z
  .object({
    idempotencyKey: z.string().min(8).max(255),
    grant: bulkGrantSchema,
    definition: z.unknown(),
    notify: z.boolean(),
    note: z.string().trim().min(1).max(BULK_NOTE_MAX_LENGTH),
    expectedDefinitionHash: z.string().regex(/^[0-9a-f]{64}$/u),
    expectedCount: z.number().int().positive(),
    expectedFingerprint: audienceFingerprintSchema,
    expectedTotalMinor: z
      .string()
      .regex(/^[0-9]{1,24}$/u)
      .nullable()
      .default(null),
    confirmed: z.literal(true),
    typedCount: z.number().int().positive().nullable().default(null),
    /**
     * The earliest instant any item may be processed; null means at once. The items and the
     * confirmation are still frozen NOW — only the processing waits, so a campaign can
     * schedule a grant the operator has already seen, counted and confirmed. A cancel before
     * this instant cancels every item, and nothing is credited or granted.
     */
    notBefore: z.iso.datetime({ offset: true }).nullable().default(null),
  })
  .strict();
export type CreateBulkOperationRequest = z.input<typeof createBulkOperationRequestSchema>;

export const bulkCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  credited: z.number().int().nonnegative(),
  planned: z.number().int().nonnegative(),
  /** Of `planned`: operations whose outcome is UNKNOWN and waits on a reconciliation read. */
  awaitingReconciliation: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  /** Customers told, through the notification lane, of an effect that happened. */
  notified: z.number().int().nonnegative(),
});
export type BulkCounts = z.infer<typeof bulkCountsSchema>;

const operatorSchema = z.object({ id: z.string(), username: z.string() }).nullable();

export const bulkOperationSchema = z.object({
  id: z.string(),
  kind: z.enum(BULK_OPERATION_KINDS),
  state: z.enum(BULK_OPERATION_STATES),
  amount: z.object({ amountMinor: z.string(), currency: currencyCodeSchema }).nullable(),
  trafficBytes: z.string().nullable(),
  durationDays: z.number().int().nullable(),
  notify: z.boolean(),
  note: z.string(),
  audience: z.unknown(),
  audienceHash: z.string(),
  audienceAsOf: z.iso.datetime(),
  /** No item is processed before this instant; null means at once. */
  notBefore: z.iso.datetime().nullable(),
  itemCount: z.number().int().nonnegative(),
  fingerprint: z.string(),
  /** Wallet credit: amount × items, what the confirmation promised at most. */
  totalLiability: z.object({ amountMinor: z.string(), currency: currencyCodeSchema }).nullable(),
  /** Wallet credit: what the ledger actually holds for this operation. */
  creditedTotal: z.object({ amountMinor: z.string(), currency: currencyCodeSchema }).nullable(),
  counts: bulkCountsSchema,
  progressPercent: z.number().int().min(0).max(100),
  createdBy: operatorSchema,
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  cancelledAt: z.iso.datetime().nullable(),
});
export type BulkOperationResponseItem = z.infer<typeof bulkOperationSchema>;
export const bulkOperationResponseSchema = z.object({ operation: bulkOperationSchema });
export type BulkOperationResponse = z.infer<typeof bulkOperationResponseSchema>;
export const bulkOperationListResponseSchema = z.object({
  operations: z.array(bulkOperationSchema),
  nextCursor: z.string().nullable(),
});
export type BulkOperationListResponse = z.infer<typeof bulkOperationListResponseSchema>;

export const bulkItemSchema = z.object({
  id: z.string(),
  customerId: z.string(),
  firstName: z.string().nullable(),
  username: z.string().nullable(),
  serviceId: z.string().nullable(),
  serviceLabel: z.string().nullable(),
  state: z.enum(BULK_ITEM_STATES),
  skipReason: z.enum(BULK_SKIP_REASONS).nullable(),
  /** SERVICE_*: the provisioning operation's own state, read through, never copied. */
  operationState: z.string().nullable(),
  /** A provider failure kind, never a provider's raw message. */
  failureKind: z.string().nullable(),
  notified: z.boolean(),
  processedAt: z.iso.datetime().nullable(),
});
export type BulkItemRow = z.infer<typeof bulkItemSchema>;
export const bulkItemListResponseSchema = z.object({
  items: z.array(bulkItemSchema),
  nextCursor: z.string().nullable(),
});
export type BulkItemListResponse = z.infer<typeof bulkItemListResponseSchema>;

/** Paths under `API_PREFIX`. */
export const BULK_OPERATION_ROUTES = {
  list: '/bulk-operations',
  create: '/bulk-operations',
  preview: '/bulk-operations/preview',
  one: (id: string) => `/bulk-operations/${id}`,
  items: (id: string) => `/bulk-operations/${id}/items`,
  cancel: (id: string) => `/bulk-operations/${id}/cancel`,
} as const;

export const BULK_ERROR_CODES = {
  NOT_FOUND: 'bulk.not_found',
  STATE_CONFLICT: 'bulk.state_conflict',
  /** The total liability the confirmation named is not amount × count. */
  LIABILITY_MISMATCH: 'bulk.liability_mismatch',
  /** The count was not typed back, or was typed wrong. */
  CONFIRMATION_REQUIRED: 'bulk.confirmation_required',
  /** A wallet credit in a currency this installation does not sell in. */
  CURRENCY_UNSUPPORTED: 'bulk.currency_unsupported',
  AMOUNT_INVALID: 'bulk.amount_invalid',
} as const;
