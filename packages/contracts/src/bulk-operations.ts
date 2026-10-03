import { z } from 'zod';
import { audienceFingerprintSchema } from './audience.js';
import { customerNotificationStateSchema } from './customer-notifications.js';
import { uuidV7Schema } from './ids.js';
import { currencyCodeSchema } from './money.js';
import type { StateMachineDefinition } from './state-machine.js';
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

/*
 * Program §13: `SERVICE_SUSPEND` / `SERVICE_RESUME`, one durable `SUSPEND` / `RESUME`
 * provisioning operation per eligible service, planned through the operator request path's
 * own planner and executed by the same provisioner. Both are reversible by the other, which
 * is why they — and not terminate — are offered in bulk. They notify nobody: there is no
 * customer notification kind for an operator's status change (ADR-0030 is closed).
 */
export const BULK_OPERATION_KINDS = [
  'WALLET_CREDIT',
  'SERVICE_TRAFFIC',
  'SERVICE_TIME',
  'SERVICE_SUSPEND',
  'SERVICE_RESUME',
] as const;
/** The kinds whose items are services. */
export const BULK_SERVICE_KINDS = [
  'SERVICE_TRAFFIC',
  'SERVICE_TIME',
  'SERVICE_SUSPEND',
  'SERVICE_RESUME',
] as const satisfies readonly (typeof BULK_OPERATION_KINDS)[number][];
export type BulkServiceKind = (typeof BULK_SERVICE_KINDS)[number];
export type BulkOperationKind = (typeof BULK_OPERATION_KINDS)[number];

export const BULK_OPERATION_STATES = ['RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED'] as const;
export type BulkOperationState = (typeof BULK_OPERATION_STATES)[number];

export type BulkOperationEvent = 'PAUSE' | 'RESUME' | 'COMPLETE' | 'CANCEL';

/**
 * The machine (round N close, `docs/round-n-close-audit.md` §B). Every edge is a conditional
 * UPDATE naming its `from` states, so a replay, a double click and two worker replicas are
 * all safe.
 *
 * - `PAUSED` claims no new PENDING item: the processor's claim query names `RUNNING`.
 * - An item whose provider write is already PLANNED keeps being settled while paused: a
 *   reconciliation READ of an ambiguous write is not new work, and holding it back would
 *   leave a customer with a grant nobody records.
 * - `RESUME` is `PAUSED → RUNNING` once; a replayed resume finds `RUNNING` and is answered,
 *   not repeated, and nothing it did is done twice because the items decide, not the edge.
 * - `CANCEL` from either running state stops PENDING items only; a credit written and a
 *   grant planned are never reversed.
 * - `COMPLETED` is reached from `RUNNING` only, by the sweep that finds nothing left, so a
 *   paused operation is never closed under an operator who meant to resume it.
 */
export const BULK_OPERATION_MACHINE: StateMachineDefinition<
  BulkOperationState,
  BulkOperationEvent
> = {
  name: 'BulkOperation',
  initial: 'RUNNING',
  states: BULK_OPERATION_STATES,
  terminal: ['COMPLETED', 'CANCELLED'],
  transitions: [
    { from: 'RUNNING', to: 'PAUSED', on: 'PAUSE' },
    { from: 'PAUSED', to: 'RUNNING', on: 'RESUME' },
    { from: 'RUNNING', to: 'COMPLETED', on: 'COMPLETE' },
    { from: 'RUNNING', to: 'CANCELLED', on: 'CANCEL' },
    { from: 'PAUSED', to: 'CANCELLED', on: 'CANCEL' },
  ],
};

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
  z.object({ kind: z.literal('SERVICE_SUSPEND') }).strict(),
  z.object({ kind: z.literal('SERVICE_RESUME') }).strict(),
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
  /**
   * Program §13, the dry run for a service kind: of the services the audience's service
   * block selects, how many are left out and why — not in a state the operation is legal
   * from, on a panel that cannot perform it now (capability or health), or otherwise (no
   * limit in the granted dimension) — and a sample of them with that reason. Null for a
   * wallet credit. Each item is still re-decided when it is processed.
   */
  ineligible: z
    .object({
      selected: z.number().int().nonnegative(),
      notInState: z.number().int().nonnegative(),
      panelNotOperable: z.number().int().nonnegative(),
      other: z.number().int().nonnegative(),
      sample: z.array(
        z.object({
          serviceId: z.string(),
          serviceLabel: z.string(),
          customerId: z.string(),
          reason: z.enum(['NOT_IN_STATE', 'PANEL_NOT_OPERABLE', 'OTHER']),
        }),
      ),
    })
    .nullable()
    .default(null),
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
    /**
     * Round N close (§A): a FROZEN audience to seed the items from, instead of evaluating
     * `definition` live. Its members are copied exactly — a customer who joined the
     * definition since is not an item, one who left it still is — and the confirmation's
     * hash, count and fingerprint must be the frozen audience's own. `definition` still
     * carries the definition the audience was frozen by, for the record and the live
     * `customerStatus` re-check. There is no size cap: the cap on hand-picked ids protects
     * a request body, and a frozen audience is a row set.
     */
    frozenAudienceId: uuidV7Schema.nullable().default(null),
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
  /**
   * Customers whose notice the notification lane DELIVERED — read from the lane's own row,
   * never from the moment it was enqueued. An enqueued notice is not a told customer: it can
   * still end UNCONFIRMED, FAILED or SUPERSEDED (Codex R4 on PR #117).
   */
  notified: z.number().int().nonnegative(),
  /** Notices enqueued and not yet resolved by the lane (its PENDING state). */
  notificationQueued: z.number().int().nonnegative(),
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
  /** The frozen audience the items were copied from; null when a definition was evaluated. */
  frozenAudienceId: z.string().nullable(),
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
  /** Set while PAUSED; cleared by a resume. */
  pausedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  cancelledAt: z.iso.datetime().nullable(),
  /** Program §13: the operation whose FAILED items this one retries; null for a fresh one. */
  retryOfId: z.string().nullable().default(null),
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
  /** The lane DELIVERED this item's notice (`notificationState === 'DELIVERED'`). */
  notified: z.boolean(),
  /** The notification lane's state for this item's notice; null when none was enqueued. */
  notificationState: customerNotificationStateSchema.nullable(),
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
  pause: (id: string) => `/bulk-operations/${id}/pause`,
  resume: (id: string) => `/bulk-operations/${id}/resume`,
  /** Program §13: the FAILED items of a service operation, counted (a read). */
  retryPreview: (id: string) => `/bulk-operations/${id}/retry/preview`,
  /** Program §13: a NEW operation over exactly those items, confirmed against the count. */
  retry: (id: string) => `/bulk-operations/${id}/retry`,
} as const;

/**
 * Program §13 — retrying the FAILED items of a service operation.
 *
 * Only `FAILED`: the provider REFUSED the write, authoritatively (or a reconciliation read
 * decided it was not applied), so asking again cannot apply it twice. An item whose
 * outcome is UNKNOWN is still `PLANNED` and is never offered — the reconciliation read
 * decides it, not a second write. A `SKIPPED` item was never written and its reason is a
 * live fact; it is not "failed". The retry is a NEW operation (`retryOfId`) whose items
 * are copied from the failed ones, so the original's history is never rewritten, each
 * retry plans NEW provisioning operations under its own id, and a retry of a retry is the
 * same mechanism.
 */
export const bulkRetryPreviewSchema = z.object({
  operationId: z.string(),
  kind: z.enum(BULK_OPERATION_KINDS),
  count: z.number().int().nonnegative(),
  fingerprint: audienceFingerprintSchema,
});
export type BulkRetryPreview = z.infer<typeof bulkRetryPreviewSchema>;
export const bulkRetryPreviewResponseSchema = z.object({ preview: bulkRetryPreviewSchema });

export const bulkRetryRequestSchema = z
  .object({
    idempotencyKey: z.string().min(8).max(255),
    note: z.string().trim().min(1).max(BULK_NOTE_MAX_LENGTH),
    expectedCount: z.number().int().positive(),
    expectedFingerprint: audienceFingerprintSchema,
    confirmed: z.literal(true),
    typedCount: z.number().int().positive().nullable().default(null),
  })
  .strict();
export type BulkRetryRequest = z.input<typeof bulkRetryRequestSchema>;

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
  /** Program §13: a retry was asked of an operation with no FAILED service item. */
  RETRY_NOTHING: 'bulk.retry_nothing',
  /** Program §13: a status change asked to notify customers, which no notice exists for. */
  NOTIFY_UNSUPPORTED: 'bulk.notify_unsupported',
} as const;
