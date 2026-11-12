/**
 * Database schema — a reseller's dedicated hosted bot (reseller-phase PR-6, §5.9): the request,
 * its fee debits and its short-wallet notices.
 *
 * One part of `../schema.ts`, which re-exports every part; import from there.
 */
import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  CURRENCY_CODES,
  RESELLER_BOT_CHARGE_KINDS,
  RESELLER_BOT_REJECT_REASON_MAX,
  RESELLER_BOT_REJECT_REASON_MIN,
  RESELLER_BOT_REQUEST_STATES,
} from '@nexa/contracts';
import { enumCheck, timestamptz } from './_shared.js';
import { tenants } from './tenancy.js';
import { admins } from './identity.js';
import { customers } from './customers.js';
import { walletEntries } from './wallet.js';
import { hostedBots } from './hosting.js';

/**
 * A reseller's request for a dedicated hosted bot, and — once APPROVED — its subscription.
 *
 * OWNED BY THE INSTALLATION TENANT: hosting is the installation owner's alone, so only the
 * installation's resellers ask, and the owner decides in his own scope. The reseller is a
 * customer of that tenant (`customer_id`).
 *
 * The bot token is sealed (`hosting.reseller_bot_token`, entity = this row) and never returned;
 * the Telegram identity `getMe` answered is kept beside it. The fee is SNAPSHOTTED when the
 * request is filed: the approval and every renewal charge that figure, never a later setting.
 *
 * The subscription is three columns: `paid_through` (the end of the last paid period),
 * `last_period` (its number; the next debit is `last_period + 1`) and `fee_stopped_at` (set
 * while the renewal job holds the hosted bot stopped for an unpaid fee). Every debit is a row
 * in `reseller_bot_fee_charges` and a `HOSTED_BOT_FEE` ledger entry.
 */
export const resellerBotRequests = pgTable(
  'reseller_bot_requests',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** The number the reseller and the owner quote. */
    number: bigint('number', { mode: 'bigint' }).generatedAlwaysAsIdentity().notNull(),
    customerId: uuid('customer_id').notNull(),
    status: text('status').notNull().default('PENDING'),
    telegramBotId: text('telegram_bot_id').notNull(),
    botUsername: text('bot_username').notNull(),
    tokenCiphertext: text('token_ciphertext').notNull(),
    tokenKeyId: text('token_key_id').notNull(),
    domain: text('domain'),
    feeAmountMinor: bigint('fee_amount_minor', { mode: 'bigint' }).notNull(),
    feeCurrency: text('fee_currency').notNull(),
    createdAt: timestamptz('created_at').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
    decidedAt: timestamptz('decided_at'),
    decidedByAdminId: uuid('decided_by_admin_id'),
    rejectReason: text('reject_reason'),
    cancelledAt: timestamptz('cancelled_at'),
    /** The hosted bot created for it (`hosted_bots`), once the owner made it. */
    hostedTenantId: uuid('hosted_tenant_id'),
    linkedAt: timestamptz('linked_at'),
    paidThrough: timestamptz('paid_through'),
    lastPeriod: integer('last_period').notNull().default(0),
    feeStoppedAt: timestamptz('fee_stopped_at'),
    /** The newest activation link issued for the hosted bot, sealed for the lane to send. */
    activationLinkId: uuid('activation_link_id'),
    activationLinkCiphertext: text('activation_link_ciphertext'),
    activationLinkKeyId: text('activation_link_key_id'),
    activationLinkSentAt: timestamptz('activation_link_sent_at'),
  },
  (table) => [
    unique('reseller_bot_requests_tenant_id_key').on(table.tenantId, table.id),
    /** One request waits for the owner per reseller. */
    uniqueIndex('reseller_bot_requests_one_pending_key')
      .on(table.tenantId, table.customerId)
      .where(sql`status = 'PENDING'`),
    /** A Telegram bot is in at most one live request: two subscriptions for one bot are none. */
    uniqueIndex('reseller_bot_requests_live_bot_key')
      .on(table.tenantId, table.telegramBotId)
      .where(sql`status IN ('PENDING', 'APPROVED')`),
    /** A hosted bot is linked to at most one request. */
    uniqueIndex('reseller_bot_requests_hosted_key')
      .on(table.tenantId, table.hostedTenantId)
      .where(sql`hosted_tenant_id IS NOT NULL`),
    index('reseller_bot_requests_customer_idx').on(
      table.tenantId,
      table.customerId,
      table.createdAt,
    ),
    index('reseller_bot_requests_status_idx').on(table.tenantId, table.status, table.createdAt),
    /** The renewal job's read: approved, linked subscriptions. */
    index('reseller_bot_requests_renewal_idx')
      .on(table.tenantId, table.paidThrough)
      .where(sql`status = 'APPROVED' AND hosted_tenant_id IS NOT NULL`),
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'reseller_bot_requests_customer_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.decidedByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
      name: 'reseller_bot_requests_decided_by_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.hostedTenantId],
      foreignColumns: [hostedBots.tenantId, hostedBots.hostedTenantId],
      name: 'reseller_bot_requests_hosted_fk',
    }),
    check('reseller_bot_requests_status_check', enumCheck('status', RESELLER_BOT_REQUEST_STATES)),
    check('reseller_bot_requests_currency_check', enumCheck('fee_currency', CURRENCY_CODES)),
    check('reseller_bot_requests_fee_check', sql`fee_amount_minor > 0`),
    check(
      'reseller_bot_requests_decided_check',
      sql`(status IN ('APPROVED', 'REJECTED')) = (decided_at IS NOT NULL)
        AND (status IN ('APPROVED', 'REJECTED')) = (decided_by_admin_id IS NOT NULL)`,
    ),
    check(
      'reseller_bot_requests_reason_check',
      sql`(status = 'REJECTED') = (reject_reason IS NOT NULL)
        AND (reject_reason IS NULL OR length(reject_reason) BETWEEN ${sql.raw(String(RESELLER_BOT_REJECT_REASON_MIN))} AND ${sql.raw(String(RESELLER_BOT_REJECT_REASON_MAX))})`,
    ),
    check(
      'reseller_bot_requests_cancelled_check',
      sql`(status = 'CANCELLED') = (cancelled_at IS NOT NULL)`,
    ),
    /** Only an approved request is paid, has a hosted bot, or is stopped for its fee. */
    check(
      'reseller_bot_requests_approved_check',
      sql`(status = 'APPROVED') = (paid_through IS NOT NULL)
        AND (status = 'APPROVED') = (last_period >= 1)
        AND (status = 'APPROVED' OR (hosted_tenant_id IS NULL AND fee_stopped_at IS NULL))
        AND (hosted_tenant_id IS NULL) = (linked_at IS NULL)`,
    ),
    check(
      'reseller_bot_requests_link_check',
      sql`(activation_link_id IS NULL) = (activation_link_ciphertext IS NULL)
        AND (activation_link_ciphertext IS NULL) = (activation_link_key_id IS NULL)`,
    ),
  ],
);

/**
 * One debit of a dedicated bot's fee: the approval's first month, a renewal, or the reseller's
 * own «پرداخت و فعال‌سازی دوباره». Append-only by use.
 *
 * `(request, period)` is unique — the database's statement that a period is charged once,
 * whoever charges it — and the ledger entry's reference `hosted-bot-fee:<request>:<period>` is
 * unique per tenant as well.
 */
export const resellerBotFeeCharges = pgTable(
  'reseller_bot_fee_charges',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    requestId: uuid('request_id').notNull(),
    period: integer('period').notNull(),
    kind: text('kind').notNull(),
    walletEntryId: uuid('wallet_entry_id').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    periodStart: timestamptz('period_start').notNull(),
    periodEnd: timestamptz('period_end').notNull(),
    createdAt: timestamptz('created_at').notNull(),
  },
  (table) => [
    unique('reseller_bot_fee_charges_tenant_id_key').on(table.tenantId, table.id),
    unique('reseller_bot_fee_charges_period_key').on(table.tenantId, table.requestId, table.period),
    unique('reseller_bot_fee_charges_entry_key').on(table.tenantId, table.walletEntryId),
    foreignKey({
      columns: [table.tenantId, table.requestId],
      foreignColumns: [resellerBotRequests.tenantId, resellerBotRequests.id],
      name: 'reseller_bot_fee_charges_request_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.walletEntryId],
      foreignColumns: [walletEntries.tenantId, walletEntries.id],
      name: 'reseller_bot_fee_charges_entry_fk',
    }),
    check('reseller_bot_fee_charges_kind_check', enumCheck('kind', RESELLER_BOT_CHARGE_KINDS)),
    check('reseller_bot_fee_charges_currency_check', enumCheck('currency', CURRENCY_CODES)),
    check('reseller_bot_fee_charges_period_check', sql`period >= 1`),
    check('reseller_bot_fee_charges_amount_check', sql`amount_minor > 0`),
    check('reseller_bot_fee_charges_window_check', sql`period_end > period_start`),
  ],
);

/**
 * One short-wallet notice: a row per (request, period, UTC day), which is the subject of one
 * `HOSTED_BOT_FEE_SHORT` notification — so a reseller is told at most once a day.
 */
export const resellerBotFeeNotices = pgTable(
  'reseller_bot_fee_notices',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    requestId: uuid('request_id').notNull(),
    /** The unpaid period the notice is about. */
    period: integer('period').notNull(),
    noticeDay: date('notice_day', { mode: 'string' }).notNull(),
    /** When the bot stops if the period stays unpaid. */
    deadline: timestamptz('deadline').notNull(),
    createdAt: timestamptz('created_at').notNull(),
  },
  (table) => [
    unique('reseller_bot_fee_notices_tenant_id_key').on(table.tenantId, table.id),
    unique('reseller_bot_fee_notices_day_key').on(
      table.tenantId,
      table.requestId,
      table.period,
      table.noticeDay,
    ),
    foreignKey({
      columns: [table.tenantId, table.requestId],
      foreignColumns: [resellerBotRequests.tenantId, resellerBotRequests.id],
      name: 'reseller_bot_fee_notices_request_fk',
    }),
    check('reseller_bot_fee_notices_period_check', sql`period >= 1`),
  ],
);
