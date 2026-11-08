/**
 * Database schema — referrals: referrals, codes, commissions, signup gifts.
 *
 * One part of `../schema.ts`, which re-exports every part; import from there.
 */
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  CURRENCY_CODES,
  REFERRAL_COMMISSION_PERCENT_MAX,
  REFERRAL_COMMISSION_PERCENT_MIN,
  REFERRAL_COMMISSION_SCOPES,
  REFERRAL_COMMISSION_STATES,
  REFERRAL_TRIGGERS,
} from '@nexa/contracts';
import { enumCheck, recordSourceChecks, recordSourceColumns, timestamptz } from './_shared.js';
import { tenants } from './tenancy.js';
import { customers } from './customers.js';
import { orders } from './orders.js';
import { refunds } from './refunds.js';
import { walletEntries } from './wallet.js';

/**
 * A referral attribution.
 *
 * Unique on `(tenant_id, referee_id)`: a customer is attributed to at most one referrer,
 * ever, and the constraint is what makes that true under concurrent `/start` commands
 * carrying different codes.
 *
 * `reward_entry_id` names the ledger entry that paid it, so "did this pay out" is a
 * column rather than a search. Null until the trigger fires, which for
 * `ON_FIRST_PAID_ORDER` may be much later than the attribution.
 */
export const referrals = pgTable(
  'referrals',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    referrerId: uuid('referrer_id').notNull(),
    refereeId: uuid('referee_id').notNull(),
    /** The policy in force when the attribution was made, snapshotted. */
    trigger: text('trigger').notNull(),
    rewardEntryId: uuid('reward_entry_id'),
    rewardedAt: timestamptz('rewarded_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    ...recordSourceColumns(),
  },
  (table) => [
    ...recordSourceChecks('referrals', table),
    foreignKey({
      columns: [table.tenantId, table.referrerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'referrals_referrer_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.refereeId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'referrals_referee_fk',
    }),
    /** One attribution per referee, for ever. */
    uniqueIndex('referrals_referee_key').on(table.tenantId, table.refereeId),
    index('referrals_referrer_idx').on(table.referrerId, table.createdAt, table.id),
    /*
     * WP9. The operator's lists lead with the tenant, as every tenant-owned index here
     * does; the Phase 0 index above does not, and is kept rather than replaced because an
     * index drop is not something to fold into a feature.
     */
    index('referrals_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
    index('referrals_tenant_referrer_idx').on(
      table.tenantId,
      table.referrerId,
      table.createdAt,
      table.id,
    ),
    /** What a commission's composite foreign key names. */
    unique('referrals_tenant_id_key').on(table.tenantId, table.id),
    /** Unrewarded attributions, for the payout pass. */
    index('referrals_unrewarded_idx')
      .on(table.tenantId, table.createdAt)
      .where(sql`rewarded_at IS NULL`),
    check('referrals_trigger_check', enumCheck('trigger', REFERRAL_TRIGGERS)),
    /** Self-referral is impossible in the database too, not only in the service. */
    check('referrals_not_self_check', sql`referrer_id <> referee_id`),
    /** A reward has an entry and a time, or neither. */
    check('referrals_reward_pair_check', sql`(reward_entry_id IS NULL) = (rewarded_at IS NULL)`),
  ],
);

/**
 * A customer's referral code, recorded the first time they ask for it (WP9 F3).
 *
 * The code is `referralCodeFor(customer_id)` and nothing else; the row exists so that
 * attribution can resolve a code to a customer INSIDE one tenant with an index rather
 * than by deriving every customer's code. Unique on the code within the tenant, so a
 * derivation that collides with another customer's is refused at insert and never
 * reassigned; unique on the customer, so a customer has one code.
 *
 * Append-only (migration 0108): a code that changed would orphan every link already
 * shared.
 */
export const referralCodes = pgTable(
  'referral_codes',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    code: text('code').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.customerId], name: 'referral_codes_pkey' }),
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'referral_codes_customer_fk',
    }),
    uniqueIndex('referral_codes_tenant_code_key').on(table.tenantId, table.code),
    check('referral_codes_code_check', sql`code ~ '^[0-9A-HJKMNP-TV-Z]{8}$'`),
  ],
);

/**
 * An order's referral commission, from promise to credit (WP9 F6, F7).
 *
 * Written at confirmation when the program is running and the buyer was referred, with
 * every term the promise was made on: the referral, both parties, the scope the
 * referral carries, the rate, the basis (the order's total) and the amount. The terms
 * are frozen by a trigger (migration 0108); the state moves forward once.
 *
 * `referee_id` is the order's customer, held by the same composite foreign key cashback
 * uses, so a commission can never name an order some other customer placed.
 *
 * At most ONE earned commission per referral under the first-order scope, held by a
 * partial unique index as well as by the earner's lock: two orders of one referee
 * delivered in the same instant cannot both pay, whichever reaches the database first.
 */
export const orderReferralCommissions = pgTable(
  'order_referral_commissions',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    orderId: uuid('order_id').notNull(),
    referralId: uuid('referral_id').notNull(),
    referrerId: uuid('referrer_id').notNull(),
    refereeId: uuid('referee_id').notNull(),
    scope: text('scope').notNull(),
    percent: integer('percent').notNull(),
    /** The order's final total, which the percent was taken of. */
    basisAmount: bigint('basis_amount', { mode: 'bigint' }).notNull(),
    /** What was promised: `floor(basis × percent / 100)`. */
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    state: text('state').notNull().default('PENDING'),
    earnedAmount: bigint('earned_amount', { mode: 'bigint' }),
    earnedEntryId: uuid('earned_entry_id'),
    earnedAt: timestamptz('earned_at'),
    voidedAt: timestamptz('voided_at'),
    /**
     * R10 D5 (b): a PENDING commission the referrer's daily cap held back is not earned before
     * this instant (the start of the next local day). Null for every other row. The earner's
     * discovery skips a row until it passes, so a held row never blocks the queue behind it.
     */
    notBefore: timestamptz('not_before'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.orderId, table.refereeId],
      foreignColumns: [orders.tenantId, orders.id, orders.customerId],
      name: 'order_referral_commissions_order_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.referralId],
      foreignColumns: [referrals.tenantId, referrals.id],
      name: 'order_referral_commissions_referral_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.referrerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'order_referral_commissions_referrer_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.earnedEntryId],
      foreignColumns: [walletEntries.tenantId, walletEntries.id],
      name: 'order_referral_commissions_earned_entry_fk',
    }),
    /** One commission per order. */
    uniqueIndex('order_referral_commissions_tenant_order_key').on(table.tenantId, table.orderId),
    /** First-order scope pays once per referral, in the database as well (F7). */
    uniqueIndex('order_referral_commissions_first_earned_key')
      .on(table.tenantId, table.referralId)
      .where(sql`state = 'EARNED' AND scope = 'FIRST_PAID_ORDER'`),
    /** The earner's discovery index. */
    index('order_referral_commissions_pending_idx')
      .on(table.tenantId, table.createdAt, table.id)
      .where(sql`state = 'PENDING'`),
    index('order_referral_commissions_tenant_created_idx').on(
      table.tenantId,
      table.createdAt,
      table.id,
    ),
    index('order_referral_commissions_tenant_referrer_idx').on(
      table.tenantId,
      table.referrerId,
      table.createdAt,
      table.id,
    ),
    check('order_referral_commissions_state_check', enumCheck('state', REFERRAL_COMMISSION_STATES)),
    check('order_referral_commissions_scope_check', enumCheck('scope', REFERRAL_COMMISSION_SCOPES)),
    check('order_referral_commissions_currency_check', enumCheck('currency', CURRENCY_CODES)),
    check('order_referral_commissions_amount_check', sql`amount > 0 AND amount <= basis_amount`),
    check(
      'order_referral_commissions_percent_check',
      sql`percent BETWEEN ${sql.raw(String(REFERRAL_COMMISSION_PERCENT_MIN))} AND ${sql.raw(String(REFERRAL_COMMISSION_PERCENT_MAX))}`,
    ),
    /** The referrer is never the buyer: self-referral is refused at attribution too. */
    check('order_referral_commissions_parties_check', sql`referrer_id <> referee_id`),
    check(
      'order_referral_commissions_earned_check',
      sql`(state = 'EARNED') = (earned_at IS NOT NULL) AND (state = 'EARNED') = (earned_amount IS NOT NULL) AND (earned_amount IS NULL OR (earned_amount >= 0 AND earned_amount <= amount))`,
    ),
    check(
      'order_referral_commissions_entry_check',
      sql`(earned_entry_id IS NOT NULL) = (earned_amount IS NOT NULL AND earned_amount > 0)`,
    ),
    check('order_referral_commissions_void_check', sql`(state = 'VOID') = (voided_at IS NOT NULL)`),
    unique('order_referral_commissions_tenant_id_key').on(table.tenantId, table.id),
  ],
);

/**
 * One reversal of an earned commission, caused by one completed refund (WP9 F8).
 * Append-only, and the same shape as `cashback_reversals` for the same reasons: `due`
 * from the cumulative formula, `recovered` what the referrer's balance could give as a
 * `REFERRAL_COMMISSION_REVERSAL` debit, `unrecovered` the rest, recorded and never
 * collected.
 */
export const referralCommissionReversals = pgTable(
  'referral_commission_reversals',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    commissionId: uuid('commission_id').notNull(),
    orderId: uuid('order_id').notNull(),
    referrerId: uuid('referrer_id').notNull(),
    refundId: uuid('refund_id').notNull(),
    dueAmount: bigint('due_amount', { mode: 'bigint' }).notNull(),
    recoveredAmount: bigint('recovered_amount', { mode: 'bigint' }).notNull(),
    unrecoveredAmount: bigint('unrecovered_amount', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    walletEntryId: uuid('wallet_entry_id'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.commissionId],
      foreignColumns: [orderReferralCommissions.tenantId, orderReferralCommissions.id],
      name: 'referral_commission_reversals_commission_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.referrerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'referral_commission_reversals_referrer_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.refundId],
      foreignColumns: [refunds.tenantId, refunds.id],
      name: 'referral_commission_reversals_refund_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.walletEntryId],
      foreignColumns: [walletEntries.tenantId, walletEntries.id],
      name: 'referral_commission_reversals_entry_fk',
    }),
    /** One reversal per refund: a replayed completion takes nothing twice. */
    uniqueIndex('referral_commission_reversals_tenant_refund_key').on(
      table.tenantId,
      table.refundId,
    ),
    index('referral_commission_reversals_commission_idx').on(table.tenantId, table.commissionId),
    check('referral_commission_reversals_currency_check', enumCheck('currency', CURRENCY_CODES)),
    check(
      'referral_commission_reversals_amounts_check',
      sql`due_amount > 0 AND recovered_amount >= 0 AND unrecovered_amount >= 0 AND due_amount = recovered_amount + unrecovered_amount`,
    ),
    check(
      'referral_commission_reversals_entry_check',
      sql`(wallet_entry_id IS NOT NULL) = (recovered_amount > 0)`,
    ),
  ],
);

/**
 * One membership gift per referral: the total and the two shares, snapshotted at the
 * FIRST claim so both sides always sum to one total whatever the settings say later.
 * Each side is claimed once — the claimed-at stamp is set by a conditional UPDATE and
 * the ledger entry it names is unique by reference — and neither side's claim depends on
 * the other's. Independent of `order_referral_commissions`, which is purchase money.
 */
export const referralSignupGifts = pgTable(
  'referral_signup_gifts',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    referralId: uuid('referral_id').notNull(),
    referrerId: uuid('referrer_id').notNull(),
    refereeId: uuid('referee_id').notNull(),
    totalAmount: bigint('total_amount', { mode: 'bigint' }).notNull(),
    referrerAmount: bigint('referrer_amount', { mode: 'bigint' }).notNull(),
    refereeAmount: bigint('referee_amount', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    referrerEntryId: uuid('referrer_entry_id'),
    refereeEntryId: uuid('referee_entry_id'),
    referrerClaimedAt: timestamptz('referrer_claimed_at'),
    refereeClaimedAt: timestamptz('referee_claimed_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.referralId],
      foreignColumns: [referrals.tenantId, referrals.id],
      name: 'referral_signup_gifts_referral_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.referrerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'referral_signup_gifts_referrer_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.refereeId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'referral_signup_gifts_referee_fk',
    }),
    /** One gift per referral, for ever. */
    uniqueIndex('referral_signup_gifts_referral_key').on(table.tenantId, table.referralId),
    index('referral_signup_gifts_referrer_idx').on(table.tenantId, table.referrerId),
    index('referral_signup_gifts_referee_idx').on(table.tenantId, table.refereeId),
    check('referral_signup_gifts_currency_check', enumCheck('currency', CURRENCY_CODES)),
    check('referral_signup_gifts_not_self_check', sql`referrer_id <> referee_id`),
    check(
      'referral_signup_gifts_amounts_check',
      sql`total_amount >= 0 AND referrer_amount >= 0 AND referee_amount >= 0
          AND referrer_amount + referee_amount = total_amount`,
    ),
    check(
      'referral_signup_gifts_referrer_claim_check',
      sql`(referrer_entry_id IS NULL) = (referrer_claimed_at IS NULL)`,
    ),
    check(
      'referral_signup_gifts_referee_claim_check',
      sql`(referee_entry_id IS NULL) = (referee_claimed_at IS NULL)`,
    ),
  ],
);
