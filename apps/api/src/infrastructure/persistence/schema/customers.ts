/**
 * Database schema — customers: the customer, captures, captchas, tags, notes, direct messages, terms, the mini app.
 *
 * One part of `../schema.ts`, which re-exports every part; import from there.
 */
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
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
  CUSTOMER_NOTE_MAX_LENGTH,
  CUSTOMER_TAG_COLORS,
  CUSTOMER_TAG_LABEL_MAX_LENGTH,
  CUSTOMER_STATUSES,
  START_CAPTCHA_IMAGE_REFRESH_MAX,
  START_CAPTCHA_OPTION_COUNT,
  START_CAPTCHA_QUESTION_KINDS,
  START_CAPTCHA_STATES,
  SERVICE_LOCATION_COOLDOWN_HOURS_MAX,
  SERVICE_LOCATION_MAX_CHANGES_MAX,
  SERVICE_LOCATION_PERIOD_DAYS_MAX,
  CUSTOMER_CAPTURE_PURPOSES,
  CUSTOMER_CAPTURE_CLOSE_REASONS,
  CUSTOMER_CAPTURE_STATES,
  TERMS_ACCEPTANCE_SOURCES,
  TERMS_BODY_MAX_LENGTH,
  TERMS_TITLE_MAX_LENGTH,
  TERMS_VERSION_STATUSES,
  TICKET_ATTACHMENT_FILE_NAME_MAX_LENGTH,
  TICKET_REPLY_FILE_TYPES,
  DIRECT_MESSAGE_CONTENT_KINDS,
  DIRECT_MESSAGE_TEXT_MAX_LENGTH,
} from '@nexa/contracts';
import {
  bytea,
  enumCheck,
  nullableEnumCheck,
  recordSourceChecks,
  recordSourceColumns,
  timestamptz,
} from './_shared.js';
import { botInstances, tenants } from './tenancy.js';
import { admins } from './identity.js';

// ---------------------------------------------------------------------------
// Phase 4 — customers, catalogue, commerce, settlement and provisioning
//
// Three rules run through every table below, each of which the legacy system
// breaks and pays for:
//
//   - Money is `bigint` minor units plus an explicit currency column, always as a
//     pair, and a CHECK refuses half a pair. There is no `doublePrecision` money
//     column anywhere and there is no `balance` column at all: a balance is
//     `SUM(signed amount)` over `wallet_entries`, which `check-boundaries.sh`
//     enforces by rejecting a migration that adds one.
//   - A historical fact is a SNAPSHOT, not a join. An order carries the title,
//     specification and price it was confirmed at; reading them back from
//     `products` is how «محصول حذف‌شده» happens and how renaming a plan rewrites
//     last month's report.
//   - Uniqueness that matters is a CONSTRAINT, not a count. One trial per
//     customer, one redemption per order, one attribution per referee and one
//     provider user per panel are partial or composite unique indexes, because a
//     count is a read followed by a write and two concurrent requests both read
//     zero.
// ---------------------------------------------------------------------------

/**
 * The customer.
 *
 * Keyed on `(tenant_id, telegram_user_id)` and deliberately not on the bot
 * instance: one tenant's several bots must converge on one customer, or a wallet
 * balance differs per bot and nobody can explain why. `first_bot_instance_id`
 * records where they arrived, which is reporting rather than identity — and it is
 * nullable because a customer created by an operator import has no such bot.
 *
 * `telegram_user_id` is TEXT. Every use of it is identity, never arithmetic, and
 * `provider-note.ts` already fixes the same choice for the same value.
 *
 * There is no `deleted_at`. A block is not a deletion: the orders, payments,
 * ledger entries and services survive it because they are facts, and a soft-delete
 * column would give two ways to express "not served" that every query would have to
 * know about.
 */
export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    telegramUserId: text('telegram_user_id').notNull(),
    /** Mutable metadata. Never identity, and nothing resolves a customer by it. */
    username: text('username'),
    firstName: text('first_name'),
    lastName: text('last_name'),
    /** Recorded and deliberately not yet consulted — the product ships one catalogue. */
    languageCode: text('language_code'),
    status: text('status').notNull().default('ACTIVE'),
    /** Where this customer first arrived. Reporting, not identity, hence nullable. */
    firstBotInstanceId: uuid('first_bot_instance_id').references(() => botInstances.id),
    firstSeenAt: timestamptz('first_seen_at').notNull().defaultNow(),
    lastSeenAt: timestamptz('last_seen_at').notNull().defaultNow(),
    blockedAt: timestamptz('blocked_at'),
    /**
     * Why an operator blocked this customer.
     *
     * SHOWN to the customer (File 01 §9, the owner's correction to WP10): the blocked
     * reply is `bot.blocked_with_reason` with this, read from THIS row at render time, and
     * `bot.blocked` when there is none. It is the only field of the block they are shown.
     */
    blockedReason: text('blocked_reason'),
    /**
     * Whether `blocked_reason` was written under the promise that the customer sees it.
     *
     * Until WP10's follow-up the Web Admin said of this very field "this note is for the
     * operator and is never shown to the customer", and operators wrote it on that promise.
     * Showing every stored reason would publish those notes to the people they are about
     * (pre-release hardening V2). So a reason is shown only when the block that wrote it
     * said so: this column is added FALSE for every existing row and set only by the
     * repository's block, whose every caller now writes under the shown-to-the-customer
     * copy. An unblock clears it with the reason.
     *
     * No CHECK ties it to `status` or `blocked_reason`, deliberately: the previous release's
     * unblock clears the reason and knows nothing of this column, and `botctl rollback`
     * keeps this schema under that code. The reader (`blockedReply`) requires all three
     * — BLOCKED, a reason, and this — so a stale TRUE on an active row shows nothing.
     */
    blockedReasonShown: boolean('blocked_reason_shown').notNull().default(false),
    /**
     * Round N close (§D): when the customer opted out of PROMOTIONAL broadcasts (`/stop`);
     * NULL while they receive them. A preference, not a status: it governs MARKETING
     * broadcasts only, and never a notification about their own payment, service or ticket.
     * Set and cleared by the customer's own Telegram turn through a conditional UPDATE.
     */
    marketingOptOutAt: timestamptz('marketing_opt_out_at'),
    /**
     * Round 11, B6: when the customer (or an operator on their behalf) turned OFF the service
     * expiry and volume reminders; NULL while they are reminded, which is the default for every
     * existing and every new customer. A preference, not a status: it governs the service
     * reminder sweep alone (`SERVICE_REMINDER_NOTIFICATION_KINDS`) and never a payment,
     * delivery, wallet, security, ticket or administrator message. Honoured only while the
     * `customer_reminder_opt_out` flag is on; the stored choice is kept when it is off.
     * Set and cleared through a conditional UPDATE naming the state it expects.
     */
    remindersOptOutAt: timestamptz('reminders_opt_out_at'),
    /**
     * Customer 360 (§11.4): when an operator exempted this customer from MANDATORY channel
     * membership; NULL while the gate applies to them. Read by the Telegram gate itself
     * (`BotRuntime.guardedAct`) from the row it resolves on every update — not a Web Admin
     * decoration. Set and cleared only by `CustomerControlService`, conditionally.
     */
    channelMembershipExemptAt: timestamptz('channel_membership_exempt_at'),
    /**
     * NEXA v095 PR-4 D: when an operator exempted this customer from phone verification;
     * NULL while it applies to them. Exempt means never asked for a phone — neither by the
     * bot-wide `phone_verification` gate (read from the row the update resolved, like the
     * channel exemption) nor by any payment route's verified-phone rule (read by the route
     * evaluation in the payment's own transaction). Set and cleared only by
     * `CustomerControlService`, conditionally.
     */
    phoneVerificationExemptAt: timestamptz('phone_verification_exempt_at'),
    /**
     * NEXA v095 PR-4 A/C: what the bot resumes once this customer has verified their phone —
     * the button they tapped (`c:` + its callback data) or the command they sent (`t:` +
     * its text) when a phone gate held it, and when that was. Bot UI state, not a fact about
     * the customer: written when the gate holds a tap, taken (read and cleared in one
     * conditional UPDATE, in the verification's own transaction) by the contact that
     * verifies, and ignored once stale. It names an action, never money: the resumed action
     * goes through every gate and its service decides it again. Both or neither
     * (`customers_phone_resume_check`).
     */
    phoneResume: text('phone_resume'),
    phoneResumeAt: timestamptz('phone_resume_at'),
    /**
     * Customer 360 (§11.4): a verified phone number, and when it was verified — by an
     * OPERATOR out of band, or (R11 B7, while `phone_verification` is on) by the customer
     * sharing their OWN Telegram contact in the bot. The audit row says which
     * (`customer.phone.verify` / `customer.phone.self_verify`). Both or neither
     * (`customers_phone_check`), so a number is never stored without the verification that
     * justified storing it — or (NEXA v099) without `phone_not_accepted_at` saying it was NOT.
     */
    phoneNumber: text('phone_number'),
    phoneVerifiedAt: timestamptz('phone_verified_at'),
    /**
     * NEXA v099 (owner): the customer shared their OWN contact while
     * `phone_verification.allowed_numbers` was IRAN_ONLY and the number is not a +98 one. The
     * number is stored in `phone_number` and this says when; `phone_verified_at` stays NULL,
     * so "verified" keeps its one meaning. It satisfies no gate and no route's verified-phone
     * rule while IRAN_ONLY is on; once the owner switches to ALL it counts as verified, decided
     * at READ time (`notAcceptedPhoneCounts`), so nothing is migrated and the switch is
     * reversible. A verification (the customer's or an operator's) clears it. A number is
     * verified or not accepted, never both (`customers_phone_check`).
     */
    phoneNotAcceptedAt: timestamptz('phone_not_accepted_at'),
    /**
     * R4 A4: when the import recorded that this customer had ACCEPTED the previous bot's
     * rules (`user.roll_Status`), or NULL. Written only by the legacy import — at customer
     * creation, or by its idempotent `terms-backfill` mode for an installation imported
     * before the column existed — through a conditional UPDATE `WHERE … IS NULL`, and never
     * cleared. The terms gate counts it as an acceptance unless the owner's
     * `terms_reprompt_on_new_version` flag is on. Not a `terms_acceptances` row: that table
     * records a tap on a version of THIS bot's rules, and this is no such tap.
     */
    legacyTermsAcceptedAt: timestamptz('legacy_terms_accepted_at'),
    /**
     * R10 D3: the customer's personal discount, a whole percent 0–100 an operator sets on
     * the customer's page (`users.discount.edit`); 0 is none. Applied by the pricing engine
     * to purchases and renewals while the `personal_discount` flag is on, as the larger of
     * it and the ordinary quote — never combined (`PERSONAL_DISCOUNT_STACKING`).
     *
     * Not a balance and not a counter: a standing term, like the other Customer 360
     * controls on this row. There is no history table: the audit row holds each change's
     * before and after, and every order's frozen quote holds what was applied to it.
     * Written only by `CustomerControlService` through a conditional UPDATE.
     */
    personalDiscountPercent: integer('personal_discount_percent').notNull().default(0),
    /** When an operator last CHANGED the percent; NULL while it has never been set. */
    personalDiscountSetAt: timestamptz('personal_discount_set_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    ...recordSourceColumns(),
  },
  (table) => [
    ...recordSourceChecks('customers', table),
    check('customers_personal_discount_check', sql`personal_discount_percent BETWEEN 0 AND 100`),
    /** The identity. Per tenant, so the same human may be a customer of two. */
    uniqueIndex('customers_tenant_telegram_key').on(table.tenantId, table.telegramUserId),
    /** The list's deterministic keyset: created_at then id, never a mutable column. */
    index('customers_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
    /**
     * Username search, lowercased, with `text_pattern_ops`.
     *
     * An expression index rather than a lowercased column, because storing a second
     * copy of a mutable field is a second thing to keep in step. Searches are
     * case-insensitive because a customer telling an operator their username does not
     * preserve case.
     *
     * `text_pattern_ops` is the part that makes it READABLE, and it was missing.
     * `/users?username=` is a PREFIX search, and a default-collation btree cannot
     * serve `LIKE 'x%'` at all — measured on 20 000 rows, the planner ignored this
     * index, walked `customers_tenant_created_idx` instead and discarded 12 289 rows
     * to return 26, at 364 shared buffers. With the operator class it is an Index
     * Cond carrying the prefix range: 111 rows and 31 buffers, and the gap grows with
     * the tenant's customer count. The repository's comment claimed this index served
     * the search all along, which made it a promise the plan did not keep — and an
     * index with no reader is the `callback_refs` situation from migration 0002.
     *
     * `customers-plan.test.ts` pins the plan, because a claim about an index that no
     * test reads is the claim that drifts.
     */
    index('customers_tenant_username_idx').on(
      table.tenantId,
      sql`lower(username) text_pattern_ops`,
    ),
    check('customers_status_check', enumCheck('status', CUSTOMER_STATUSES)),
    /** A blocked customer has a time; an active one does not. Neither state can lie. */
    check('customers_blocked_at_check', sql`(status = 'BLOCKED') = (blocked_at IS NOT NULL)`),
    check(
      'customers_phone_check',
      sql`(phone_number IS NULL) = (phone_verified_at IS NULL AND phone_not_accepted_at IS NULL) AND (phone_verified_at IS NULL OR phone_not_accepted_at IS NULL)`,
    ),
    check(
      'customers_phone_resume_check',
      sql`(phone_resume IS NULL) = (phone_resume_at IS NULL) AND (phone_resume IS NULL OR char_length(phone_resume) <= 300)`,
    ),
    check(
      'customers_phone_format_check',
      sql`phone_number IS NULL OR phone_number ~ '^[+][1-9][0-9]{7,14}$'`,
    ),
    /** The target of the composite references the child tables use. */
    unique('customers_tenant_id_key').on(table.tenantId, table.id),
  ],
);

/**
 * A customer's open plain-text window: what their next message is being read FOR.
 *
 * One table with a purpose column, the shape `admin_amount_captures` set, rather than a
 * third and fourth window table. The partial unique index is the rule: ONE open window
 * per (tenant, bot, customer), so the most recent prompt is the only reader, and a
 * message a customer sends with nothing open falls through to the command router.
 * `subject_id` names the service a note is for; a search and an amount have none.
 *
 * The amount is recorded ON the row (`AMOUNT_RECORDED`) while the customer picks a route,
 * so the figure a route button acts on is the one the customer typed and confirmed by
 * tapping, never one carried in the callback.
 */
export const customerTextCaptures = pgTable(
  'customer_text_captures',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    customerId: uuid('customer_id').notNull(),
    purpose: text('purpose').notNull(),
    subjectId: uuid('subject_id'),
    state: text('state').notNull().default('AWAITING_TEXT'),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }),
    amountCurrency: text('amount_currency'),
    openedAt: timestamptz('opened_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at').notNull(),
    closedAt: timestamptz('closed_at'),
    closeReason: text('close_reason'),
    /*
     * The Telegram `update_id` of the tap that opened a refund-reason window (WP19, Codex
     * review of #83, round 8). The window reads only a message whose update is newer, so a
     * message typed before the tap — processed late, by a concurrent webhook — never files
     * a refund request. Null for every other window, which keeps its old reading.
     */
    openedUpdateId: bigint('opened_update_id', { mode: 'bigint' }),
    /**
     * Package D: the custom-service volume the previous window read, in hundredths of a GB,
     * carried by the `CUSTOM_SERVICE_DAYS` window that asks for the days — and only by it.
     * The draft is made from what the customer typed, never from a callback.
     */
    customVolumeUnits: bigint('custom_volume_units', { mode: 'bigint' }),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'customer_text_captures_customer_fk',
    }),
    uniqueIndex('customer_text_captures_open_key')
      .on(table.tenantId, table.botInstanceId, table.customerId)
      .where(sql`closed_at IS NULL`),
    index('customer_text_captures_expiry_idx')
      .on(table.tenantId, table.expiresAt)
      .where(sql`closed_at IS NULL`),
    check('customer_text_captures_purpose_check', enumCheck('purpose', CUSTOMER_CAPTURE_PURPOSES)),
    check('customer_text_captures_state_check', enumCheck('state', CUSTOMER_CAPTURE_STATES)),
    check(
      'customer_text_captures_close_reason_check',
      nullableEnumCheck('close_reason', CUSTOMER_CAPTURE_CLOSE_REASONS),
    ),
    check('customer_text_captures_closed_check', sql`(closed_at IS NULL) = (close_reason IS NULL)`),
    check('customer_text_captures_expiry_check', sql`expires_at > opened_at`),
    check(
      'customer_text_captures_amount_currency_check',
      nullableEnumCheck('amount_currency', CURRENCY_CODES),
    ),
    check(
      'customer_text_captures_amount_check',
      sql`(amount_minor IS NULL) = (amount_currency IS NULL) AND (amount_minor IS NULL OR amount_minor > 0)`,
    ),
    /** Only an amount window records an amount, and a recorded state has one. */
    check(
      'customer_text_captures_amount_state_check',
      sql`(state = 'AMOUNT_RECORDED') = (amount_minor IS NOT NULL)
          AND (amount_minor IS NULL OR purpose = 'TOPUP_AMOUNT')`,
    ),
    /**
     * A note, a refund reason (WP19) and a transfer's recipient (Package F) name their
     * service, the two custom-service windows (Package D) their panel, and the two ticket
     * windows (WP-A7) their category or their ticket, a refund card (Round 6) its payment; the
     * other purposes name nothing.
     */
    check(
      'customer_text_captures_subject_check',
      sql`(purpose IN ('SERVICE_NOTE', 'SERVICE_REFUND_REASON', 'CUSTOM_SERVICE_VOLUME', 'CUSTOM_SERVICE_DAYS', 'SERVICE_TRANSFER_RECIPIENT', 'TICKET_NEW_MESSAGE', 'TICKET_REPLY', 'GATEWAY_REFUND_CARD', 'RESELLER_REQUEST_ANSWER', 'RESELLER_REQUEST_REPLY', 'RESELLER_REQUEST_ADMIN_MESSAGE', 'RESELLER_REQUEST_ADMIN_REASON')) = (subject_id IS NOT NULL)`,
    ),
    /** Only the days window carries a volume, and it always does (Package D). */
    check(
      'customer_text_captures_custom_volume_check',
      sql`(purpose = 'CUSTOM_SERVICE_DAYS') = (custom_volume_units IS NOT NULL)
          AND (custom_volume_units IS NULL OR custom_volume_units > 0)`,
    ),
  ],
);

// --- Customer 360 ------------------------------------------------------------------------

/**
 * A customer's location-change limit override (Customer 360, §11.4): the cooldown and the
 * rolling limit that REPLACE the configured location's for every service this customer
 * owns, while the row exists. The shape of `trial_limit_overrides`: one row per customer,
 * deleted to remove. Null fields mean "no limit of that kind" — exactly what they mean on
 * `service_locations`, so `locationChangeWindow` reads either without translation.
 *
 * Only the WINDOW is replaced. Which targets exist, their prices and whether the panel can
 * move the service are still decided by `LocationChangePolicy` from the configuration.
 */
export const customerLocationChangeOverrides = pgTable(
  'customer_location_change_overrides',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    cooldownHours: integer('cooldown_hours'),
    maxChanges: integer('max_changes'),
    periodDays: integer('period_days'),
    setAt: timestamptz('set_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'customer_location_change_overrides_pkey',
      columns: [table.tenantId, table.customerId],
    }),
    foreignKey({
      name: 'customer_location_change_overrides_customer_fk',
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    check(
      'customer_location_change_overrides_limits_check',
      sql`(cooldown_hours IS NULL OR cooldown_hours BETWEEN 1 AND ${sql.raw(String(SERVICE_LOCATION_COOLDOWN_HOURS_MAX))})
        AND (max_changes IS NULL OR max_changes BETWEEN 1 AND ${sql.raw(String(SERVICE_LOCATION_MAX_CHANGES_MAX))})
        AND (period_days IS NULL OR period_days BETWEEN 1 AND ${sql.raw(String(SERVICE_LOCATION_PERIOD_DAYS_MAX))})
        AND ((max_changes IS NULL) = (period_days IS NULL))`,
    ),
  ],
);

// --- Phase A2: a direct message from Customer 360 ---------------------------------------

/**
 * One message an operator wrote to ONE customer (`docs/direct-message-audit.md`).
 *
 * The row IS the message, the way `ticket_messages` is a ticket's: it is written once, in
 * the transaction that queues its `DIRECT_MESSAGE` / `DIRECT_MESSAGE_MEDIA` row on the
 * customer notification lane, and the lane reads the text, the caption and the file back
 * from here at send time. Where it GOT TO is the lane row's state — read through
 * `customer_notifications_subject_key`, never copied here, so the two cannot disagree.
 *
 * The file's bytes are staging, as on `ticket_reply_files`: kept only until Telegram has
 * them (the delivery stamps Telegram's handle and clears them in the same transaction), or
 * until `DIRECT_MESSAGE_FILE_RETENTION_DAYS` pass; the name, type, size and digest stay.
 *
 * Rate limits are COUNTED from this table (the customer and admin indexes) under the
 * tenant's direct-message advisory lock, so it is also the limiter's ledger.
 */
export const customerDirectMessages = pgTable(
  'customer_direct_messages',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    /** The bot it is sent through: the customer's own, resolved when it was written. */
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    /** Who wrote it. Never null: only an administrator can send one. */
    authorAdminId: uuid('author_admin_id').notNull(),
    contentKind: text('content_kind').notNull(),
    /** The text of a TEXT message, or a file's caption (null when it has none). */
    body: text('body'),
    fileMimeType: text('file_mime_type'),
    /** The name it is sent under, cleaned and ending in the verified type's extension. */
    fileName: text('file_name'),
    fileByteLength: integer('file_byte_length'),
    fileSha256: text('file_sha256'),
    /** The bytes, until Telegram has them or retention clears them. */
    fileContent: bytea('file_content'),
    /** When `file_content` was cleared, by the delivery or by retention. */
    filePurgedAt: timestamptz('file_purged_at'),
    telegramFileId: text('telegram_file_id'),
    telegramFileUniqueId: text('telegram_file_unique_id'),
    /** The request's key, namespaced by surface and administrator: a replay is this row. */
    idempotencyKey: text('idempotency_key').notNull(),
    /** What the key was first used for, so the same key with different content is refused. */
    requestHash: text('request_hash').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('customer_direct_messages_tenant_id_key').on(table.tenantId, table.id),
    unique('customer_direct_messages_key').on(table.tenantId, table.idempotencyKey),
    /** The customer's history, newest first, and the per-customer rate window. */
    index('customer_direct_messages_customer_idx').on(
      table.tenantId,
      table.customerId,
      table.createdAt,
      table.id,
    ),
    /** The per-operator rate window. */
    index('customer_direct_messages_admin_idx').on(
      table.tenantId,
      table.authorAdminId,
      table.createdAt,
    ),
    /** The staging bound's sum and the retention sweep's walk: the held bytes only. */
    index('customer_direct_messages_staged_idx')
      .on(table.tenantId, table.createdAt)
      .where(sql`file_content IS NOT NULL`),
    index('customer_direct_messages_retention_idx')
      .on(table.createdAt)
      .where(sql`file_content IS NOT NULL`),
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'customer_direct_messages_customer_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.authorAdminId],
      foreignColumns: [admins.tenantId, admins.id],
      name: 'customer_direct_messages_author_fk',
    }),
    check(
      'customer_direct_messages_kind_check',
      enumCheck('content_kind', DIRECT_MESSAGE_CONTENT_KINDS),
    ),
    check(
      'customer_direct_messages_body_check',
      sql`body IS NULL OR length(body) BETWEEN 1 AND ${sql.raw(String(DIRECT_MESSAGE_TEXT_MAX_LENGTH))}`,
    ),
    /** A TEXT message has text and no file; a PHOTO or DOCUMENT has a file. */
    check(
      'customer_direct_messages_shape_check',
      sql`CASE content_kind
            WHEN 'TEXT' THEN body IS NOT NULL AND file_mime_type IS NULL AND file_name IS NULL
              AND file_byte_length IS NULL AND file_sha256 IS NULL AND file_content IS NULL
              AND file_purged_at IS NULL AND telegram_file_id IS NULL
            ELSE file_mime_type IS NOT NULL AND file_name IS NOT NULL
              AND file_byte_length IS NOT NULL AND file_sha256 IS NOT NULL
          END`,
    ),
    /** The allow-list, from the contract: each type with its shape and its own bound. */
    check(
      'customer_direct_messages_file_type_check',
      sql`file_mime_type IS NULL OR CASE file_mime_type ${sql.raw(
        TICKET_REPLY_FILE_TYPES.map((type) => {
          if (!/^[a-z]+\/[a-z0-9.+-]+$/.test(type.mimeType) || !/^[A-Z]+$/.test(type.kind)) {
            throw new Error(`customer_direct_messages: "${type.mimeType}" is not a plain literal.`);
          }
          return `WHEN '${type.mimeType}' THEN content_kind = '${type.kind}' AND file_byte_length BETWEEN 1 AND ${String(type.maxBytes)}`;
        }).join(' '),
      )} ELSE false END`,
    ),
    check(
      'customer_direct_messages_file_content_check',
      sql`content_kind = 'TEXT'
          OR ((file_content IS NULL) = (file_purged_at IS NOT NULL)
              AND (file_content IS NULL OR octet_length(file_content) = file_byte_length))`,
    ),
    check(
      'customer_direct_messages_telegram_check',
      sql`(telegram_file_id IS NULL) = (telegram_file_unique_id IS NULL)`,
    ),
    check(
      'customer_direct_messages_sha256_check',
      sql`file_sha256 IS NULL OR file_sha256 ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'customer_direct_messages_name_check',
      sql`file_name IS NULL OR length(file_name) BETWEEN 1 AND ${sql.raw(String(TICKET_ATTACHMENT_FILE_NAME_MAX_LENGTH))}`,
    ),
  ],
);

/**
 * Program §6 — one version of a tenant's terms and rules (`docs/terms-audit.md`).
 *
 * At most one DRAFT per tenant (the partial unique index), edited in place with a revision
 * counter every edit names. Publishing is a conditional UPDATE from DRAFT at that revision
 * which gives the row the next `version_number`; from then on the row is IMMUTABLE — the
 * hand-written guard migration refuses any UPDATE or DELETE of a PUBLISHED row — so an
 * acceptance always points at the exact text the customer was shown.
 *
 * The CURRENT version is the PUBLISHED row with the greatest `version_number`. It is not
 * stored: a stored "current" flag would be a second fact that could disagree with the
 * numbers. `title` and `body` are the operator's raw text, never a rendered string.
 */
export const termsVersions = pgTable(
  'terms_versions',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    status: text('status').notNull(),
    versionNumber: integer('version_number'),
    title: text('title').notNull(),
    body: text('body').notNull(),
    revision: integer('revision').notNull().default(1),
    createdByAdminId: uuid('created_by_admin_id').references(() => admins.id),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    publishedByAdminId: uuid('published_by_admin_id').references(() => admins.id),
    publishedAt: timestamptz('published_at'),
  },
  (table) => [
    unique('terms_versions_tenant_id_key').on(table.tenantId, table.id),
    unique('terms_versions_tenant_number_key').on(table.tenantId, table.versionNumber),
    uniqueIndex('terms_versions_one_draft_key')
      .on(table.tenantId)
      .where(sql`status = 'DRAFT'`),
    check('terms_versions_status_check', enumCheck('status', TERMS_VERSION_STATUSES)),
    check(
      'terms_versions_published_check',
      sql`(status = 'PUBLISHED') = (version_number IS NOT NULL AND published_at IS NOT NULL)`,
    ),
    check('terms_versions_number_check', sql`version_number IS NULL OR version_number >= 1`),
    check('terms_versions_revision_check', sql`revision >= 1`),
    check(
      'terms_versions_title_check',
      sql`length(btrim(title)) BETWEEN 1 AND ${sql.raw(String(TERMS_TITLE_MAX_LENGTH))}`,
    ),
    check(
      'terms_versions_body_check',
      sql`length(btrim(body)) BETWEEN 1 AND ${sql.raw(String(TERMS_BODY_MAX_LENGTH))}`,
    ),
  ],
);

/**
 * Program §6 — a customer's acceptance of one published version.
 *
 * Append-only (the hand-written guard migration): written once, by the customer's own tap,
 * and never changed or removed. One row per (customer, version) by the unique key, so a
 * repeated or concurrent tap inserts nothing the second time. Both references carry the
 * tenant, so an acceptance cannot name another tenant's customer or version.
 */
export const termsAcceptances = pgTable(
  'terms_acceptances',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    termsVersionId: uuid('terms_version_id').notNull(),
    acceptedAt: timestamptz('accepted_at').notNull(),
    source: text('source').notNull(),
    /** The bot the tap arrived on, when there was one. */
    botInstanceId: uuid('bot_instance_id').references(() => botInstances.id),
    correlationId: text('correlation_id').notNull(),
  },
  (table) => [
    unique('terms_acceptances_once_key').on(table.tenantId, table.customerId, table.termsVersionId),
    index('terms_acceptances_version_idx').on(table.tenantId, table.termsVersionId),
    index('terms_acceptances_customer_idx').on(table.tenantId, table.customerId, table.acceptedAt),
    foreignKey({
      name: 'terms_acceptances_customer_fk',
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    foreignKey({
      name: 'terms_acceptances_version_fk',
      columns: [table.tenantId, table.termsVersionId],
      foreignColumns: [termsVersions.tenantId, termsVersions.id],
    }),
    check('terms_acceptances_source_check', enumCheck('source', TERMS_ACCEPTANCE_SOURCES)),
  ],
);

/**
 * R10 D5 (a): the `/start` captcha of ONE customer.
 *
 * A row exists only for a customer CREATED while `start_captcha` was on: it is inserted in the
 * transaction that creates the customer row, and nowhere else, so every customer created
 * before the switch, every imported one and every one created while it was off has none and
 * is never asked. `PENDING` holds the customer at the gate while the flag is on; turning the
 * flag off frees every PENDING row at once without touching it.
 *
 * The right answer is `options[answer_index]` and never leaves the server: the buttons carry
 * only the `challenge_id` and an index. Every change is a conditional UPDATE naming the state
 * and the `challenge_id` it read, so a stale or replayed tap changes nothing. There is no
 * failed state and no link to the customer's status: a failure is a cooldown (`locked_until`),
 * never a block.
 */
export const customerCaptchas = pgTable(
  'customer_captchas',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    state: text('state').notNull().default('PENDING'),
    /** The current question's id; a new question gets a new one. */
    challengeId: uuid('challenge_id').notNull(),
    /**
     * `captcha.kind`: the kind THIS question was asked with. A pending question keeps it
     * whatever the setting becomes. `MATH` for every row written before the kinds existed.
     */
    kind: text('kind').notNull().default('MATH'),
    /** `MATH` only (0 for the other kinds): the two numbers of the sum. */
    operandA: integer('operand_a').notNull(),
    operandB: integer('operand_b').notNull(),
    /**
     * The four offered answers, in button order: numbers for `MATH` and `WORD_NUMBER`, emoji
     * for `EMOJI`; empty for `IMAGE_NUMBER`, whose answer is TYPED.
     */
    options: jsonb('options').$type<Array<number | string>>().notNull(),
    answerIndex: integer('answer_index').notNull(),
    /**
     * `IMAGE_NUMBER` only: the digits on the picture, which the typed answer is compared to
     * and the picture is drawn from (nothing else is stored: not the image, never a file).
     * Never in callback data. Null for every other kind.
     */
    answerText: text('answer_text'),
    /** `IMAGE_NUMBER`: how many times this question was swapped for a new picture. */
    refreshes: integer('refreshes').notNull().default(0),
    /** Wrong answers since the last cooldown. */
    attempts: integer('attempts').notNull().default(0),
    issuedAt: timestamptz('issued_at').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    lockedUntil: timestamptz('locked_until'),
    passedAt: timestamptz('passed_at'),
    createdAt: timestamptz('created_at').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ name: 'customer_captchas_pkey', columns: [table.tenantId, table.customerId] }),
    foreignKey({
      name: 'customer_captchas_customer_fk',
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    check('customer_captchas_state_check', enumCheck('state', START_CAPTCHA_STATES)),
    check(
      'customer_captchas_answer_index_check',
      sql`answer_index BETWEEN 0 AND ${sql.raw(String(START_CAPTCHA_OPTION_COUNT - 1))}`,
    ),
    check('customer_captchas_kind_check', enumCheck('kind', START_CAPTCHA_QUESTION_KINDS)),
    check(
      'customer_captchas_options_check',
      sql`jsonb_typeof(options) = 'array' AND jsonb_array_length(options) = CASE WHEN kind = 'IMAGE_NUMBER' THEN 0 ELSE ${sql.raw(String(START_CAPTCHA_OPTION_COUNT))} END`,
    ),
    check(
      'customer_captchas_answer_text_check',
      sql`(kind = 'IMAGE_NUMBER') = (answer_text IS NOT NULL) AND (answer_text IS NULL OR answer_text ~ '^[0-9]{4}$')`,
    ),
    check(
      'customer_captchas_refreshes_check',
      sql`refreshes BETWEEN 0 AND ${sql.raw(String(START_CAPTCHA_IMAGE_REFRESH_MAX))}`,
    ),
    check('customer_captchas_attempts_check', sql`attempts >= 0`),
    check('customer_captchas_passed_check', sql`(state = 'PASSED') = (passed_at IS NOT NULL)`),
    check('customer_captchas_expiry_check', sql`expires_at > issued_at`),
  ],
);

// --- Customer notes and tags (program §8, `docs/customer-notes-tags.md`) ---------------

/**
 * The tenant's own customer tags. The `id` is the identity: an assignment, a list filter and
 * an event all name the id, so renaming a tag renames it everywhere at once and changes no
 * reference.
 *
 * UNIQUENESS is `customer_tags_active_label_key`: `lower(label)` among the tenant's ACTIVE
 * tags. The label is stored already normalised (`normaliseCustomerTagLabel`: NFC, one space
 * between words, none around) and the CHECK below refuses one that is not, so «VIP» and
 * « vip » collide here, in one place, for every writer. An archived tag leaves the index, so
 * its name can be reused; restoring it then collides, and is refused rather than merged.
 *
 * Nothing deletes a tag. An archived one stays on the customers that carry it (and in the
 * audit history that names it) and cannot be newly assigned — the CRM service's assignment
 * reads it `FOR SHARE`, so an archive and an assignment racing are decided one after the
 * other.
 */
export const customerTags = pgTable(
  'customer_tags',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    label: text('label').notNull(),
    /** One of the design system's semantic tones; null is neutral. */
    color: text('color'),
    archivedAt: timestamptz('archived_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    unique('customer_tags_tenant_id_key').on(table.tenantId, table.id),
    uniqueIndex('customer_tags_active_label_key')
      .on(table.tenantId, sql`lower(${table.label})`)
      .where(sql`archived_at IS NULL`),
    check('customer_tags_color_check', nullableEnumCheck('color', CUSTOMER_TAG_COLORS)),
    check(
      'customer_tags_label_check',
      sql`length(label) BETWEEN 1 AND ${sql.raw(String(CUSTOMER_TAG_LABEL_MAX_LENGTH))} AND label = btrim(regexp_replace(label, '\\s+', ' ', 'g'))`,
    ),
  ],
);

/**
 * Which customer carries which tag. One row per pair, so assigning twice is a no-op
 * (`ON CONFLICT DO NOTHING`) and removing deletes the row; the audit log is the history of
 * both. Both halves are composite foreign keys INSIDE the tenant, so a row cannot pair one
 * tenant's customer with another tenant's tag.
 *
 * The primary key leads `(tenant_id, customer_id)`, which serves the customer page and the
 * list filter's per-row EXISTS; `customer_tag_assignments_tag_idx` leads `(tenant_id,
 * tag_id)`, which serves the filter when the planner drives from the tag instead.
 */
export const customerTagAssignments = pgTable(
  'customer_tag_assignments',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    tagId: uuid('tag_id').notNull(),
    assignedByAdminId: uuid('assigned_by_admin_id').references(() => admins.id),
    assignedAt: timestamptz('assigned_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'customer_tag_assignments_pkey',
      columns: [table.tenantId, table.customerId, table.tagId],
    }),
    index('customer_tag_assignments_tag_idx').on(table.tenantId, table.tagId, table.customerId),
    foreignKey({
      name: 'customer_tag_assignments_customer_fk',
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    foreignKey({
      name: 'customer_tag_assignments_tag_fk',
      columns: [table.tenantId, table.tagId],
      foreignColumns: [customerTags.tenantId, customerTags.id],
    }),
  ],
);

/**
 * Operators' internal notes on a customer. APPEND-ONLY (`nexa_reject_mutation`, hand-written
 * in the guards migration): a correction is a second note, so what a customer was said to
 * have done can never be quietly rewritten. Operator-only — no customer surface reads this
 * table (`tests/unit/customer-crm-privacy.test.ts`).
 *
 * `author_label` is the operator's name as it was at the time, like `audit_logs.actor_label`.
 */
export const customerNotes = pgTable(
  'customer_notes',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    body: text('body').notNull(),
    authorAdminId: uuid('author_admin_id').references(() => admins.id),
    authorLabel: text('author_label').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('customer_notes_customer_idx').on(
      table.tenantId,
      table.customerId,
      table.createdAt,
      table.id,
    ),
    foreignKey({
      name: 'customer_notes_customer_fk',
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    check(
      'customer_notes_body_check',
      sql`length(body) BETWEEN 1 AND ${sql.raw(String(CUSTOMER_NOTE_MAX_LENGTH))}`,
    ),
    check('customer_notes_author_check', sql`length(author_label) BETWEEN 1 AND 200`),
  ],
);

// ---------------------------------------------------------------------------
// Round 9, C5 — the customer's Telegram Mini App
// ---------------------------------------------------------------------------

/**
 * One mini-app session: what ONE verified Telegram launch (`initData`) was exchanged for.
 *
 * The replay rule is a unique index, not a check in a process: `(tenant, bot, init_data_hash)`
 * is unique, so a launch mints at most one session whatever two replicas are asked at once,
 * and a launch copied out of a customer's device is worth nothing once it has been used.
 * The token itself is never stored — `token_hash` is its SHA-256 — so a read of this table
 * cannot act as anybody. A session belongs to one tenant, one bot and one customer; the
 * surface derives the scope from the row, never from the request.
 *
 * Expired rows are kept: they are what makes a replayed launch refused for as long as it
 * could still verify, and they are small. Nothing customer-facing is written here.
 */
export const miniAppSessions = pgTable(
  'miniapp_sessions',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    customerId: uuid('customer_id').notNull(),
    /** Telegram's numeric id, as text: the gates (channels, bound administrators) ask by it. */
    telegramUserId: text('telegram_user_id').notNull(),
    /** The launch's own `hash` field (64 hex). The replay key. */
    initDataHash: text('init_data_hash').notNull(),
    /** SHA-256 of the bearer secret, hex. Compared in constant time. */
    tokenHash: text('token_hash').notNull(),
    /** The launch's `auth_date`. */
    authDate: timestamptz('auth_date').notNull(),
    createdAt: timestamptz('created_at').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
  },
  (table) => [
    uniqueIndex('miniapp_sessions_launch_key').on(
      table.tenantId,
      table.botInstanceId,
      table.initDataHash,
    ),
    index('miniapp_sessions_tenant_customer_idx').on(
      table.tenantId,
      table.customerId,
      table.createdAt,
    ),
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'miniapp_sessions_customer_fk',
    }),
    check('miniapp_sessions_init_hash_check', sql`init_data_hash ~ '^[0-9a-f]{64}$'`),
    check('miniapp_sessions_token_hash_check', sql`token_hash ~ '^[0-9a-f]{64}$'`),
    check('miniapp_sessions_window_check', sql`expires_at > created_at`),
  ],
);
