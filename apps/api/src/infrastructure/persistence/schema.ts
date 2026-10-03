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
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  doublePrecision,
  customType,
} from 'drizzle-orm/pg-core';
import { sql, type SQL } from 'drizzle-orm';
import {
  ACTOR_TYPES,
  ADMIN_STATUSES,
  BACKUP_DELIVERY_STATES,
  BACKUP_RUN_STATES,
  BACKUP_STAGES,
  BACKUP_TRIGGERS,
  AUDIT_RESULTS,
  BOT_INSTANCE_STATUSES,
  CALENDARS,
  CURRENCY_CODES,
  CUSTOMER_NOTE_MAX_LENGTH,
  CUSTOMER_TAG_COLORS,
  CUSTOMER_TAG_LABEL_MAX_LENGTH,
  GATEWAY_PROVIDER_UNITS,
  FX_BASE_ASSETS,
  FX_SOURCES,
  FX_USABLE_QUOTE_STATES,
  GATEWAY_CONVERSION_POLICIES,
  SALES_CURRENCY_CODES,
  DELIVERY_OUTCOMES,
  NOTIFICATION_KINDS,
  NOTIFICATION_STATUSES,
  NOTIFICATION_TRANSPORTS,
  OPERATIONAL_SEVERITIES,
  PANEL_HEALTH_STATES,
  MONITOR_DEFERRAL_REASONS,
  PANEL_BALANCING_STRATEGIES,
  PANEL_PLACEMENT_DECIDERS,
  PANEL_STATUSES,
  PRODUCT_SORT_MAX,
  PRODUCT_SORT_MIN,
  PRODUCT_CATEGORY_EMOJI_MAX_CODE_POINTS,
  PRODUCT_CATEGORY_NAME_MAX_LENGTH,
  PRODUCT_CATEGORY_STATUSES,
  PRODUCT_CATEGORY_VISIBILITIES,
  PERMISSION_OVERRIDE_EFFECTS,
  PROVIDER_FAILURE_KINDS,
  PROVIDER_TYPES,
  SOURCE_SURFACES,
  RECOVERY_ACTIVE_DESTRUCTIVE_STATES,
  RECOVERY_FAILURE_CODES,
  RECOVERY_SOURCES,
  INSTALLATION_KEY_SOURCES,
  RECOVERY_STAGES,
  RECOVERY_STATES,
  TEMPLATE_REVISION_ACTIONS,
  TENANT_KINDS,
  TENANT_STATUSES,
  // Phase 4. Every CHECK below is built from one of these, so the database's
  // vocabulary cannot drift from the contract's.
  CUSTOMER_STATUSES,
  PRODUCT_STATUSES,
  PRODUCT_AUDIENCES,
  // Legacy migration prerequisites (Items 14, 15).
  LEGACY_SHAPE_RESOLUTIONS,
  LEGACY_SHAPE_TARIFF_STATUSES,
  LEGACY_SHAPE_UNRESOLVED_REASONS,
  LEGACY_TRIAL_DECISIONS,
  SERVICE_ADDON_KINDS,
  SERVICE_ADDON_STATUSES,
  COMMERCIAL_ORDER_PURPOSES,
  ORDER_ORIGINS,
  ORDER_PURPOSES,
  ORDER_SETTLED_STATES,
  ORDER_STATES,
  PAYMENT_GATEWAY_PROVIDERS,
  PROVIDER_REVIEW_GATEWAY_PROVIDERS,
  CENTRALPAY_INTEGER_MAX,
  CENTRALPAY_INTEGER_MIN,
  TONPAYS_TELEGRAM_REVIEW_WINDOW_HOURS,
  GATEWAY_CARD_NAME_MAX_LENGTH,
  GATEWAY_CARD_NUMBER_MAX_LENGTH,
  GATEWAY_CARD_SOURCES,
  GATEWAY_CARD_CHANGE_STATES,
  GATEWAY_RECEIPT_CAPTURE_CLOSE_REASONS,
  GATEWAY_RECEIPT_SUBMISSION_STATES,
  GATEWAY_INVOICE_CREATION_STATES,
  GATEWAY_INVOICE_OUTCOMES,
  REFUND_CHANNELS,
  REFUND_STATES,
  PAYMENT_GATEWAY_STATUSES,
  PAYMENT_RECEIPT_KINDS,
  RECEIPT_CAPTURE_CLOSE_REASONS,
  ADMIN_AMOUNT_CAPTURE_CLOSE_REASONS,
  ADMIN_CAPTURE_PURPOSES,
  ADMIN_CAPTURE_REASON_MAX_LENGTH,
  RECEIPT_REVIEW_PUSH_STATES,
  SERVICE_REFUND_REASON_MAX_LENGTH,
  SERVICE_REFUND_REASON_MIN_LENGTH,
  SERVICE_REFUND_REQUEST_STATES,
  PAYMENT_STATES,
  PAYMENT_METHODS,
  PAYMENT_EVIDENCE_KINDS,
  PAYMENT_RESOLVED_STATES,
  PAYMENT_GATEWAY_TOPUP_CASHBACK_PERCENT_MAX,
  CUSTOMER_FEE_BASIS_POINTS_MAX,
  CUSTOMER_FEE_BASIS_POINTS_MIN,
  PAYMENT_GATEWAY_TOPUP_CASHBACK_PERCENT_MIN,
  RECEIPT_CAPTION_MAX_LENGTH,
  RECEIPT_CREDIT_NOTE_MAX_LENGTH,
  LEDGER_DIRECTIONS,
  LEDGER_REASONS,
  SERVICE_DELIVERY_STATES,
  CUSTOMER_NOTIFICATION_KINDS,
  CUSTOMER_NOTIFICATION_STATES,
  SERVICE_STATES,
  SERVICE_REMINDER_KINDS,
  DEFAULT_USERNAME_PREFIX,
  DEFAULT_USERNAME_STRATEGY,
  SERVICE_USERNAME_MODES,
  USERNAME_STRATEGIES,
  USERNAME_CAPTURE_CLOSE_REASONS,
  OPERATION_STATES,
  OPERATION_TYPES,
  DISCOUNT_TYPES,
  DISCOUNT_STATUSES,
  DISCOUNT_KINDS,
  DISCOUNTABLE_PURPOSES,
  DISCOUNT_CODE_CAPTURE_CLOSE_REASONS,
  DISCOUNT_LABEL_MAX_LENGTH,
  DISCOUNT_PRIORITY_MIN,
  DISCOUNT_PRIORITY_MAX,
  CASHBACK_RULE_STATUSES,
  // Round N, C1: campaigns.
  CAMPAIGN_ACTION_KINDS,
  CAMPAIGN_ACTION_STATES,
  CAMPAIGN_DESCRIPTION_MAX_LENGTH,
  CAMPAIGN_NAME_MAX_LENGTH,
  CAMPAIGN_STATES,
  CASHBACK_STATES,
  CASHBACK_PERCENT_MIN,
  CASHBACK_PERCENT_MAX,
  REFERRAL_COMMISSION_PERCENT_MAX,
  REFERRAL_COMMISSION_PERCENT_MIN,
  REFERRAL_COMMISSION_SCOPES,
  REFERRAL_COMMISSION_STATES,
  REFERRAL_TRIGGERS,
  RESELLER_STATUSES,
  RESELLER_PRICING_MODES,
  RESELLER_OVERRIDE_MODES,
  RESELLER_GRANT_KINDS,
  RESELLER_GRANTABLE_OPERATIONS,
  RESELLER_ENTITLEMENT_DIMENSIONS,
  RESELLER_MINIMUM_NOTICE_KINDS,
  RESELLER_PRICE_LAYERS,
  TRIAL_LIMIT_MAX,
  PANEL_TRIAL_HOURS_MAX,
  PANEL_TRIAL_HOURS_MIN,
  PANEL_TRIAL_LABEL_MAX_LENGTH,
  PANEL_TRIAL_TRAFFIC_MAX_BYTES,
  TRIAL_LIMIT_MIN,
  // Package D: the custom service.
  CUSTOM_SERVICE_LABEL_MAX_LENGTH,
  // WP-A6: service location change.
  SERVICE_LOCATION_KEY_MAX_LENGTH,
  SERVICE_LOCATION_LABEL_MAX_LENGTH,
  SERVICE_LOCATION_COOLDOWN_HOURS_MAX,
  SERVICE_LOCATION_MAX_CHANGES_MAX,
  SERVICE_LOCATION_PERIOD_DAYS_MAX,
  CUSTOM_SERVICE_RULE_DIMENSIONS,
  CUSTOM_SERVICE_RULE_LEVELS,
  // Customer UX completion.
  CUSTOMER_CAPTURE_PURPOSES,
  CUSTOMER_CAPTURE_CLOSE_REASONS,
  CUSTOMER_CAPTURE_STATES,
  SERVICE_LAST_SEEN_STATES,
  SERVICE_NOTE_MAX_LENGTH,
  SUPPORT_FAQ_STATUSES,
  TERMS_ACCEPTANCE_SOURCES,
  TERMS_BODY_MAX_LENGTH,
  TERMS_TITLE_MAX_LENGTH,
  TERMS_VERSION_STATUSES,
  SUPPORT_FAQ_QUESTION_MAX_LENGTH,
  SUPPORT_FAQ_ANSWER_MAX_LENGTH,
  TENANT_MEDIA_PURPOSES,
  TENANT_MEDIA_MIME_TYPES,
  TENANT_MEDIA_MAX_BYTES,
  PRODUCT_SERVICE_LOCATION_LABEL_MAX_LENGTH,
  // WP-A10: client apps and connection guides.
  CLIENT_APP_DELIVERY_KINDS,
  CLIENT_APP_DESCRIPTION_MAX_LENGTH,
  CLIENT_APP_GUIDE_MAX_LENGTH,
  CLIENT_APP_ICON_MAX_LENGTH,
  CLIENT_APP_IMAGE_MAX_BYTES,
  CLIENT_APP_IMAGE_MAX_SIDE,
  CLIENT_APP_IMAGE_MIME_TYPES,
  CLIENT_APP_IMAGE_MIN_SIDE,
  CLIENT_APP_NAME_MAX_LENGTH,
  CLIENT_APP_PLATFORMS,
  CLIENT_APP_VIDEO_FILE_ID_MAX_LENGTH,
  CLIENT_APP_VIDEO_FILE_UNIQUE_ID_MAX_LENGTH,
  CLIENT_APP_PROTOCOLS,
  CLIENT_APP_SORT_MAX,
  CLIENT_APP_SORT_MIN,
  CLIENT_APP_STATUSES,
  CLIENT_APP_URL_MAX_LENGTH,
  // WP-A7: support tickets.
  TICKET_ATTACHMENT_FILE_NAME_MAX_LENGTH,
  TICKET_ATTACHMENT_KINDS,
  TICKET_ATTACHMENT_MAX_BYTES,
  TICKET_REPLY_FILE_TYPES,
  DIRECT_MESSAGE_CONTENT_KINDS,
  DIRECT_MESSAGE_TEXT_MAX_LENGTH,
  INCIDENT_KINDS,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  INCIDENT_TARGET_KINDS,
  INCIDENT_EFFECT_KINDS,
  INCIDENT_EFFECT_STATES,
  INCIDENT_EVENT_KINDS,
  INCIDENT_TITLE_MAX_LENGTH,
  INCIDENT_CUSTOMER_MESSAGE_MAX_LENGTH,
  // Migration P4: legacy import metadata.
  LEGACY_IMPORT_ENTITY_TYPES,
  LEGACY_IMPORT_MAP_STATUSES,
  LEGACY_IMPORT_REASON_CODES,
  LEGACY_IMPORT_RUN_FAILURE_CODES,
  LEGACY_IMPORT_RUN_MODES,
  LEGACY_IMPORT_RUN_STATUSES,
  TICKET_CATEGORY_SORT_MAX,
  TICKET_CATEGORY_TITLE_MAX_LENGTH,
  TICKET_MESSAGE_MAX_LENGTH,
  TICKET_MESSAGE_SENDERS,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_SUBJECT_MAX_LENGTH,
  TICKET_SYSTEM_EVENTS,
  // WP-A4: the operations log group.
  OPS_LOG_GROUP_HEALTH,
  OPS_LOG_GROUP_PROBLEMS,
  OPS_LOG_GROUP_STATUSES,
  OPS_LOG_TOPIC_STATES,
  // R2: the Telegram messages edited in place.
  TELEGRAM_WIZARD_KINDS,
  TELEGRAM_WIZARD_STEPS,
  TELEGRAM_REVIEW_MESSAGE_ROLES,
  // Round N: broadcast and safe mass actions.
  BROADCAST_CONTENT_KINDS,
  BROADCAST_PIN_STATES,
  BROADCAST_PURPOSES,
  BROADCAST_MEDIA_FILE_NAME_MAX_LENGTH,
  BROADCAST_MEDIA_TYPES,
  BROADCAST_PAUSE_REASONS,
  BROADCAST_RECIPIENT_STATES,
  BROADCAST_STATES,
  BROADCAST_TITLE_MAX_LENGTH,
  BULK_ITEM_STATES,
  BULK_NOTE_MAX_LENGTH,
  BULK_OPERATION_KINDS,
  BULK_OPERATION_STATES,
  FROZEN_AUDIENCE_GRANT_KINDS,
  FROZEN_AUDIENCE_KINDS,
  BULK_SKIP_REASONS,
  // Premium UI: appearance slots and the per-bot custom emoji test.
  APPEARANCE_SLOTS,
  APPEARANCE_TEST_ERROR_CODES,
  APPEARANCE_TEST_OUTCOMES,
} from '@nexa/contracts';

/**
 * Builds a CHECK constraint from a contract enum, so the database rejects any
 * value the contract does not define. The legacy system encodes one service
 * status four different ways — `active`, `فعال`, and two emoji-prefixed Persian
 * phrases — because nothing constrained the column.
 */
/**
 * What an enum literal may contain.
 *
 * Letters, digits, underscore, hyphen and DOT. The dot arrived with
 * `RECOVERY_FAILURE_CODES`, whose members are dotted (`recovery.cutover_failed`)
 * for the same reason error codes and operational event codes are — they are
 * namespaced, and flattening them to match a character class would make the
 * database's vocabulary differ from the contract's.
 *
 * Widening it is safe for the reason the original class was narrow: this is not
 * the escaping. The `'` doubling below is the escaping, and it still runs. This
 * pattern is the assertion that the input is a compile-time enum literal and
 * not something derived at runtime, and a dot does not weaken that — a quote, a
 * backslash, a space, a semicolon and a comment marker are all still refused,
 * which `tests/unit/schema-ddl-guards.test.ts` asserts one character at a time.
 */
const ENUM_LITERAL = /^[A-Za-z0-9_.-]+$/;

export function enumCheck(column: string, values: readonly string[]): SQL {
  // This is the only sql.raw in the codebase. Every argument today is a
  // compile-time literal from a contract enum, which is what makes it safe — so
  // assert that rather than trust it, and escape anyway. A runtime-derived list
  // would otherwise turn a DDL helper into an injection point.
  if (!/^[a-z_][a-z0-9_]*$/.test(column)) {
    throw new Error(`enumCheck: "${column}" is not a plain column name.`);
  }
  const list = values
    .map((value) => {
      if (!ENUM_LITERAL.test(value)) {
        throw new Error(`enumCheck: "${value}" is not a plain enum literal.`);
      }
      return `'${value.replace(/'/g, "''")}'`;
    })
    .join(', ');
  return sql.raw(`${column} IN (${list})`);
}

/**
 * A text-array column holding a non-empty subset of an enum (WP8: `applies_to`).
 *
 * The array counterpart of `enumCheck`, with the same assertions and the same escaping:
 * every member is a compile-time enum literal, and the column name is a plain one. Empty
 * is refused because "applies to nothing" is a rule that silently never fires.
 */
export function enumSubsetCheck(column: string, values: readonly string[]): SQL {
  if (!/^[a-z_][a-z0-9_]*$/.test(column)) {
    throw new Error(`enumSubsetCheck: "${column}" is not a plain column name.`);
  }
  const list = values
    .map((value) => {
      if (!ENUM_LITERAL.test(value)) {
        throw new Error(`enumSubsetCheck: "${value}" is not a plain enum literal.`);
      }
      return `'${value.replace(/'/g, "''")}'`;
    })
    .join(', ');
  return sql.raw(`cardinality(${column}) > 0 AND ${column} <@ ARRAY[${list}]::text[]`);
}

/**
 * The same constraint for a column that is allowed to be NULL.
 *
 * `column IN (...)` is NULL — not false — when the column is NULL, and a CHECK
 * passes on NULL. Relying on that is correct SQL and completely invisible to a
 * reader, so it is stated: this column holds one of these values, or nothing.
 */
export function nullableEnumCheck(column: string, values: readonly string[]): SQL {
  if (!/^[a-z_][a-z0-9_]*$/.test(column)) {
    throw new Error(`nullableEnumCheck: "${column}" is not a plain column name.`);
  }
  const list = values
    .map((value) => {
      if (!ENUM_LITERAL.test(value)) {
        throw new Error(`nullableEnumCheck: "${value}" is not a plain enum literal.`);
      }
      return `'${value.replace(/'/g, "''")}'`;
    })
    .join(', ');
  return sql.raw(`${column} IS NULL OR ${column} IN (${list})`);
}

/**
 * A text-array column holding any subset of an enum, the empty set included (WP-A4:
 * `ops_log_groups.problems`, where no problem is the normal case). `enumSubsetCheck`'s
 * assertions and escaping, without its non-empty rule.
 */
export function enumArrayCheck(column: string, values: readonly string[]): SQL {
  if (!/^[a-z_][a-z0-9_]*$/.test(column)) {
    throw new Error(`enumArrayCheck: "${column}" is not a plain column name.`);
  }
  const list = values
    .map((value) => {
      if (!ENUM_LITERAL.test(value)) {
        throw new Error(`enumArrayCheck: "${value}" is not a plain enum literal.`);
      }
      return `'${value.replace(/'/g, "''")}'`;
    })
    .join(', ');
  return sql.raw(`${column} <@ ARRAY[${list}]::text[]`);
}

/**
 * Phase 0 schema — the foundation tables, and nothing else.
 *
 * Conventions, all enforced here rather than by memory:
 *   - `id` is UUIDv7, generated in the application so the value exists before
 *     the INSERT and can be written into an outbox row in the same statement.
 *   - every timestamp is `timestamptz`, stored UTC.
 *   - every status is a CHECK-constrained text column, never free text.
 *   - tenant-owned rows carry `tenant_id NOT NULL`; rows that genuinely belong
 *     to no tenant carry NULL and say so.
 *   - append-only tables are protected by a trigger, not by convention
 *     (see migrations/0001_foundation.sql).
 *
 * There is deliberately no `balance` column, no money column and no product
 * table here. Phase 0 has no business features.
 */

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey(),
    kind: text('kind').notNull(),
    parentTenantId: uuid('parent_tenant_id'),
    slug: text('slug').notNull(),
    displayName: text('display_name').notNull(),
    status: text('status').notNull().default('ACTIVE'),
    locale: text('locale').notNull().default('fa'),
    displayTimezone: text('display_timezone').notNull().default('Asia/Tehran'),
    calendar: text('calendar').notNull().default('jalali'),
    currency: text('currency').notNull().default('IRT'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('tenants_slug_key').on(table.slug),
    // Exactly ONE primary tenant per database, enforced here rather than by
    // the code that inserts it.
    //
    // The primary tenant IS the installation: it is the only kind with no
    // parent, and every reseller bot hangs off it. Two of them is not a
    // degraded installation, it is two installations sharing a database.
    //
    // The provisioning CLI used to guard this with `SELECT ... FOR UPDATE`
    // inside a transaction, which locks nothing when it matches no rows — so
    // two first-run installers both saw an empty table and both inserted. With
    // the same slug one happened to die on `tenants_slug_key`, which is a
    // different invariant catching this one by accident; with different slugs
    // both committed.
    uniqueIndex('tenants_single_primary_key')
      .on(table.kind)
      .where(sql`kind = 'PRIMARY'`),
    check('tenants_kind_check', enumCheck('kind', TENANT_KINDS)),
    check('tenants_status_check', enumCheck('status', TENANT_STATUSES)),
    check('tenants_calendar_check', enumCheck('calendar', CALENDARS)),
    check('tenants_currency_check', enumCheck('currency', CURRENCY_CODES)),
    // A reseller sales bot is a tenant with a parent; a primary tenant has none.
    check(
      'tenants_parent_check',
      sql`(kind = 'PRIMARY' AND parent_tenant_id IS NULL) OR (kind <> 'PRIMARY' AND parent_tenant_id IS NOT NULL)`,
    ),
  ],
);

/**
 * A bot instance is a Telegram bot. It is NOT a tenant: one tenant may own
 * several, and a reseller sales bot is its own tenant that owns one.
 */
export const botInstances = pgTable(
  'bot_instances',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    username: text('username').notNull(),
    /**
     * Telegram's own numeric id for this bot, as a decimal STRING.
     *
     * The identity a rerun is decided against. A username can be changed in BotFather
     * and a token can be rotated; this cannot, so it is what says whether a second
     * bootstrap is rotating THIS bot's token or repointing the installation at a
     * different bot — the refusal ADR-0029 records, because repointing would leave
     * every stored `telegram_user_id` attached to conversations that bot never had.
     *
     * Text rather than bigint for the reason every other id on the wire is text: JSON
     * has one numeric type, and a value stored and compared for the life of an
     * installation must not be able to lose a digit in transit.
     *
     * Nullable because rows created before the bootstrap existed have no way to know
     * it. `getMe` fills it the first time a bootstrap runs against such a row.
     */
    telegramBotId: text('telegram_bot_id'),
    /**
     * When Telegram last ACCEPTED a `setWebhook` for this bot, and the URL it took.
     *
     * Separate from the row existing, because the two fail independently and the whole
     * recovery story depends on telling them apart. A crash between the local commit
     * and `setWebhook` leaves a row with this NULL: the rerun decrypts the stored token
     * and retries the registration, and never asks for a token again. A crash after
     * Telegram accepted but before this was written leaves the same NULL, and the rerun
     * re-registers and then marks it. Both crashes converge, which is why the marker is
     * written AFTER the call rather than with the row.
     *
     * A repeat `setWebhook` is NOT a no-op — an earlier version of this comment said it
     * was. It replaces the registration, and it discards whatever Telegram has queued if
     * the caller asks it to, which is why `dropPendingUpdates` is true only on a first
     * registration.
     *
     * It is also what `--status` reports, and therefore what stops an installer
     * claiming a Telegram-enabled installation is complete while the bot cannot
     * receive a single update.
     */
    webhookRegisteredAt: timestamptz('webhook_registered_at'),
    webhookUrl: text('webhook_url'),
    /**
     * SHA-256 of the secret the webhook was registered WITH, as hex.
     *
     * Not a credential: it is a one-way digest of one, and it is here because
     * the marker above records what was registered and the secret is the other
     * half of what `setWebhook` carried. Without it a rotated
     * `TELEGRAM_WEBHOOK_SECRET` produces an installation that reports itself
     * ready while the route refuses every update Telegram signs — the operator
     * followed the rotation procedure the template documents, and the only
     * remedy was SQL.
     *
     * A digest rather than the value, because nothing needs to read it back:
     * the question is only "is this the same secret", and a stored plaintext
     * would be a second copy of a credential that already lives in exactly one
     * file. Nullable for the rows that predate it; a NULL means "unknown", and
     * an unknown fingerprint is treated as needing registration rather than as
     * matching.
     */
    webhookSecretFingerprint: text('webhook_secret_fingerprint'),
    /**
     * A digest of the command menu Telegram was last given, as hex.
     *
     * `OQ-4H-02`: `setMyCommands` ran inside `execute` and nowhere else, and
     * `execute` returns ALREADY_COMPLETE before reaching it on an installation
     * whose webhook is current. So an installation that UPGRADES into a release
     * carrying a new command keeps whatever menu it had — for most, none — and
     * the discoverability 4H shipped applied to fresh installs only.
     *
     * A digest rather than a hand-bumped version number, for the reason
     * `webhook_secret_fingerprint` above is one: a number somebody has to
     * remember to increment is a number that will be forgotten in exactly the
     * release that changed the list. It covers the rendered menu — the commands
     * AND their descriptions — so a catalogue rewording re-registers too.
     *
     * NULL means "unknown", never "matches". A row written before this column
     * needs one registration to become knowable, and one unnecessary
     * `setMyCommands` is a far cheaper mistake than a silent claim. It is the
     * same argument the fingerprint above makes, and the same answer.
     */
    commandsRevision: text('commands_revision'),
    status: text('status').notNull().default('ACTIVE'),
    /** Envelope-encrypted. Never returned by any API, never logged. */
    tokenCiphertext: text('token_ciphertext').notNull(),
    tokenKeyId: text('token_key_id').notNull(),
    /**
     * R4 (item 12) — the claim a Web Admin token replacement holds while it talks to
     * Telegram, and when that claim lapses.
     *
     * A replacement registers the webhook and reads it back BEFORE it stores the token,
     * and those calls cannot run inside a transaction — so no row lock can keep a second
     * replacement (another tab, a double-click under a new key, another api replica) from
     * interleaving its `setWebhook` with this one's. This conditional claim does, and it is
     * a lease rather than a flag so a process that dies mid-replacement blocks the next
     * attempt for minutes, not for ever. Activation is conditional on the claim still being
     * this attempt's, so a replacement whose claim lapsed and was taken over stores nothing.
     *
     * Both NULL, or both set: the CHECK below.
     */
    tokenReplacementClaim: uuid('token_replacement_claim'),
    tokenReplacementClaimedUntil: timestamptz('token_replacement_claimed_until'),
    /**
     * Premium UI — what the last «ارسال پیام آزمایشی» through THIS bot found
     * (`docs/premium-ui-audit.md` §6).
     *
     * Per bot, not per tenant: the Bot API grants custom emoji entities to "bots that
     * purchased additional usernames on Fragment", which is a property of one bot. Only a
     * recorded `SENT` lets the messenger decorate a message from this bot; NULL means
     * untested and is treated exactly as a refusal — never assumed. The three columns are
     * one fact: all NULL, or tested-at and outcome set with the error code NULL iff `SENT`
     * (the CHECK below). No raw answer is stored; the error code is a closed vocabulary.
     */
    customEmojiTestedAt: timestamptz('custom_emoji_tested_at'),
    customEmojiTestOutcome: text('custom_emoji_test_outcome'),
    customEmojiTestErrorCode: text('custom_emoji_test_error_code'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('bot_instances_username_key').on(table.username),
    /**
     * One Telegram bot, one row. The identity, not the display name.
     *
     * `bot_instances_username_key` looked like it already held this and does not:
     * a username is changed in BotFather at will, and the stored copy goes stale
     * the moment it is (OQ-TG-02). So bootstrapping a SECOND tenant with the same
     * token after a rename passes the username index — `getMe` returns the new
     * name, which collides with nothing — and writes a second row carrying the
     * same `telegram_bot_id`. Telegram has one webhook per bot, so the second
     * registration moves it, and the first row goes on reporting `ready` for a
     * URL that no longer receives anything.
     *
     * PARTIAL, because the column is nullable for rows that predate migration
     * 0038 and a unique index would otherwise make at most one of them legal.
     * `getMe` fills those in the first time a bootstrap runs against them, which
     * is the point at which the constraint should start applying to them — and
     * does.
     *
     * Deliberately NOT scoped to the tenant. Cross-tenant is the case: two
     * tenants on one installation binding the same bot is exactly the collision,
     * and a `(tenant_id, telegram_bot_id)` index would permit it.
     */
    uniqueIndex('bot_instances_telegram_bot_id_key')
      .on(table.telegramBotId)
      .where(sql`telegram_bot_id IS NOT NULL`),
    index('bot_instances_tenant_idx').on(table.tenantId),
    check('bot_instances_status_check', enumCheck('status', BOT_INSTANCE_STATUSES)),
    check(
      'bot_instances_token_replacement_claim_check',
      sql`(token_replacement_claim IS NULL) = (token_replacement_claimed_until IS NULL)`,
    ),
    check(
      'bot_instances_custom_emoji_test_outcome_check',
      enumCheck('custom_emoji_test_outcome', APPEARANCE_TEST_OUTCOMES),
    ),
    check(
      'bot_instances_custom_emoji_test_error_code_check',
      enumCheck('custom_emoji_test_error_code', APPEARANCE_TEST_ERROR_CODES),
    ),
    check(
      'bot_instances_custom_emoji_test_shape_check',
      sql`(custom_emoji_tested_at IS NULL AND custom_emoji_test_outcome IS NULL AND custom_emoji_test_error_code IS NULL)
        OR (custom_emoji_tested_at IS NOT NULL AND custom_emoji_test_outcome IS NOT NULL
            AND ((custom_emoji_test_outcome = 'SENT') = (custom_emoji_test_error_code IS NULL)))`,
    ),
  ],
);

/**
 * Premium UI — one row per appearance slot a tenant has configured
 * (`docs/premium-ui-audit.md` §3). A slot with no row is the catalogue fallback, switched
 * on; a row holds at most a Telegram `custom_emoji_id` and a switch. Never HTML, never a
 * rendered string. Per TENANT, deliberately: the icons are the tenant's brand, and every
 * bot of the tenant draws them — subject to that bot's own eligibility test on its row above.
 */
export const botAppearanceSlots = pgTable(
  'bot_appearance_slots',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    slot: text('slot').notNull(),
    /** Telegram's decimal custom emoji id. NULL means "no custom emoji; draw the fallback". */
    customEmojiId: text('custom_emoji_id'),
    enabled: boolean('enabled').notNull().default(true),
    version: integer('version').notNull().default(1),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    updatedByAdminId: uuid('updated_by_admin_id'),
  },
  (table) => [
    uniqueIndex('bot_appearance_slots_tenant_slot_key').on(table.tenantId, table.slot),
    check('bot_appearance_slots_slot_check', enumCheck('slot', APPEARANCE_SLOTS)),
    check(
      'bot_appearance_slots_custom_emoji_id_check',
      sql`custom_emoji_id IS NULL OR custom_emoji_id ~ '^[0-9]{1,32}$'`,
    ),
    check('bot_appearance_slots_version_check', sql`version >= 1`),
    // Only an administrator of this tenant can have edited this tenant's slot.
    foreignKey({
      name: 'bot_appearance_slots_tenant_admin_fk',
      columns: [table.tenantId, table.updatedByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
  ],
);

/**
 * Round P (COMMAND-MENU) — one bot's slash-command sync state (`docs/command-menu-audit.md`).
 *
 * What Telegram was LAST GIVEN stays `bot_instances.commands_revision`, the one column the
 * installer's reconcile and the Web Admin's menu state already read; this row is the lane's
 * bookkeeping beside it. `desired_hash` is the digest of the menu the tenant wants now —
 * `BOT_COMMANDS` rendered through the tenant's own `bot.command.*` texts — and the sync is
 * due exactly while `next_attempt_at` is set. A NULL `next_attempt_at` means nothing is
 * queued, whatever `attempts` says: the counter is what the back-off and the operational
 * warning read, and it is reset by a success and by the operator's «همگام‌سازی دوباره».
 *
 * `claimed_until` is a lease, taken by conditional UPDATE, because the `setMyCommands` call
 * cannot run inside a transaction and two worker replicas on a rolling update is the normal
 * case. A process that dies mid-call leaves a claim that lapses, and the next tick retries.
 *
 * `last_error_code` is a CODE (`telegram.unreachable`, `telegram.rate_limited`,
 * `telegram.rejected.401`), bounded, and never Telegram's description: the description
 * quotes the request URL, and the bot token is a segment of it.
 */
export const botCommandSyncs = pgTable(
  'bot_command_syncs',
  {
    botInstanceId: uuid('bot_instance_id')
      .primaryKey()
      .references(() => botInstances.id),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    desiredHash: text('desired_hash').notNull(),
    /** Moves on each time `desired_hash` changes. What the Web Admin shows as the version. */
    desiredVersion: integer('desired_version').notNull().default(1),
    lastSyncedAt: timestamptz('last_synced_at'),
    lastAttemptedAt: timestamptz('last_attempted_at'),
    lastErrorCode: text('last_error_code'),
    /** Consecutive failures since the last success or reset. */
    attempts: integer('attempts').notNull().default(0),
    /** When the next attempt is due; NULL when none is queued. */
    nextAttemptAt: timestamptz('next_attempt_at'),
    /** The lease a running attempt holds; NULL when none does. */
    claimedUntil: timestamptz('claimed_until'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('bot_command_syncs_tenant_idx').on(table.tenantId),
    // The lane's claim query: due rows only, so the index stays the size of the backlog.
    index('bot_command_syncs_due_idx')
      .on(table.nextAttemptAt)
      .where(sql`next_attempt_at IS NOT NULL`),
    check('bot_command_syncs_attempts_check', sql`attempts >= 0`),
    check('bot_command_syncs_version_check', sql`desired_version >= 1`),
  ],
);

// ---------------------------------------------------------------------------
// Eventing — the transactional outbox
// ---------------------------------------------------------------------------

export const outboxMessages = pgTable(
  'outbox_messages',
  {
    id: uuid('id').primaryKey(),
    /** NULL for platform events that belong to no tenant. */
    tenantId: uuid('tenant_id'),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    /** Monotonic per aggregate. Ordering is guaranteed per aggregate only. */
    sequence: integer('sequence').notNull(),
    eventType: text('event_type').notNull(),
    eventVersion: integer('event_version').notNull().default(1),
    payload: jsonb('payload').notNull(),
    actor: jsonb('actor').notNull(),
    correlationId: text('correlation_id').notNull(),
    causationId: text('causation_id'),
    occurredAt: timestamptz('occurred_at').notNull(),
    publishedAt: timestamptz('published_at'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    /**
     * When the relay may try this message again after a failure (WP20, brief §3.1). NULL
     * means due now: a message that has never failed, and every row written before this
     * column existed. A failure moves only its own row, so the messages behind it are not
     * held up.
     */
    nextAttemptAt: timestamptz('next_attempt_at'),
    /**
     * When the relay gave up on this message and said so (WP20, brief §3.2): set by the
     * failure that reached `DELIVERY_MAX_FAILED_ATTEMPTS`, in the transaction that records
     * the announcement. NULL means still retried. A mark rather than a count, because a
     * count can grow under a release that never decides or announces anything.
     */
    exhaustedAt: timestamptz('exhausted_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('outbox_messages_aggregate_sequence_key').on(
      table.aggregateType,
      table.aggregateId,
      table.sequence,
    ),
    // Partial index: keeps the relay's claim query O(unpublished), not O(table).
    index('outbox_messages_unpublished_idx')
      .on(table.occurredAt)
      .where(sql`published_at IS NULL`),
    // The same partial set, led by tenant.
    //
    // The index above orders ALL unpublished rows by time, which is right when
    // everything is dispatchable and wrong when it is not: a stopped tenant's
    // backlog had to be walked in full to prove it held nothing for an active
    // one. Leading with `tenant_id` lets the relay go straight to the rows it
    // may actually act on, and skip a paused tenant's entirely.
    index('outbox_messages_tenant_unpublished_idx')
      .on(table.tenantId, table.occurredAt)
      .where(sql`published_at IS NULL`),
    check('outbox_messages_sequence_check', sql`sequence >= 1`),
    check('outbox_messages_attempts_check', sql`attempts >= 0`),
  ],
);

/**
 * Consumer-side dedupe.
 *
 * The outbox gives at-least-once delivery. Effectively-once EFFECTS come from
 * each consumer recording the event ids it has already applied.
 */
export const processedMessages = pgTable(
  'processed_messages',
  {
    consumer: text('consumer').notNull(),
    messageId: uuid('message_id').notNull(),
    processedAt: timestamptz('processed_at').notNull().defaultNow(),
  },
  (table) => [uniqueIndex('processed_messages_pkey').on(table.consumer, table.messageId)],
);

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

export const requestIdempotency = pgTable(
  'request_idempotency',
  {
    id: uuid('id').primaryKey(),
    /**
     * The tenant id as text, or the literal 'SYSTEM'. A plain nullable
     * `tenant_id` cannot participate in a unique constraint, because Postgres
     * treats NULLs as distinct — which would silently allow duplicate keys.
     */
    scopeRef: text('scope_ref').notNull(),
    tenantId: uuid('tenant_id'),
    key: text('key').notNull(),
    /** Hash of the request payload. A reused key with different input is a bug. */
    requestHash: text('request_hash').notNull(),
    result: jsonb('result'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [uniqueIndex('request_idempotency_scope_key').on(table.scopeRef, table.key)],
);

// ---------------------------------------------------------------------------
// Audit — who changed what, with before and after
// ---------------------------------------------------------------------------

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id'),
    occurredAt: timestamptz('occurred_at').notNull(),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    /** Captured at action time so the record survives a later rename. */
    actorLabel: text('actor_label'),
    /** A machine code such as 'wallet.credit'. Never a prose sentence. */
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    /** Values, not references. Secrets are replaced by a marker before writing. */
    before: jsonb('before'),
    after: jsonb('after'),
    reason: text('reason'),
    correlationId: text('correlation_id').notNull(),
    requestId: text('request_id'),
    sourceSurface: text('source_surface').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    /** Denials are audited too. */
    result: text('result').notNull(),
  },
  (table) => [
    index('audit_logs_tenant_occurred_idx').on(table.tenantId, table.occurredAt),
    index('audit_logs_entity_idx').on(table.entityType, table.entityId),
    index('audit_logs_correlation_idx').on(table.correlationId),
    check('audit_logs_actor_type_check', enumCheck('actor_type', ACTOR_TYPES)),
    check('audit_logs_result_check', enumCheck('result', AUDIT_RESULTS)),
    check('audit_logs_surface_check', enumCheck('source_surface', SOURCE_SURFACES)),
  ],
);

// ---------------------------------------------------------------------------
// Operational events — what the system did
// ---------------------------------------------------------------------------

export const operationalEvents = pgTable(
  'operational_events',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id'),
    code: text('code').notNull(),
    severity: text('severity').notNull(),
    message: text('message').notNull(),
    context: jsonb('context'),
    /**
     * Which dedupe namespace this row belongs to: the tenant id, or 'SYSTEM'.
     *
     * Without it the unique index below is global, and two tenants recording
     * the same dedupe key collapse onto ONE row — a cross-tenant write that no
     * repository predicate can prevent, because the collision happens in the
     * index rather than in a query.
     */
    dedupeScope: text('dedupe_scope').notNull().default('SYSTEM'),
    /** Repeats within one scope collapse onto one row and increment the counter. */
    dedupeKey: text('dedupe_key'),
    occurrenceCount: integer('occurrence_count').notNull().default(1),
    firstSeenAt: timestamptz('first_seen_at').notNull(),
    lastSeenAt: timestamptz('last_seen_at').notNull(),
    correlationId: text('correlation_id'),
    /** Set when this event records recovery from an earlier failure code. */
    recoversCode: text('recovers_code'),
    /**
     * When the condition this row records was observed to have cleared.
     *
     * Set by a recovery event naming this row's code, and cleared again if the
     * condition recurs. NOTHING IS DELETED either way: the failure row keeps its
     * message, its counter and its first-seen time, and the recovery event
     * stands beside it. History is the sequence of events; this column is a
     * marker over it, so an operator can tell an ongoing incident from one that
     * was fixed at four in the morning.
     */
    resolvedAt: timestamptz('resolved_at'),
    /** The recovery event that closed it. */
    resolvedByEventId: uuid('resolved_by_event_id'),
  },
  (table) => [
    index('operational_events_tenant_seen_idx').on(table.tenantId, table.lastSeenAt),
    index('operational_events_code_idx').on(table.code),
    uniqueIndex('operational_events_dedupe_key').on(table.dedupeScope, table.dedupeKey),
    // There is deliberately no index on `resolved_at`. One was drafted for a
    // retention sweep, and the sweep turned out not to be able to exist (the
    // table refuses DELETE — ADR-0020). An index whose only query was removed is
    // a write cost with nothing on the other side of it, so it went too.
    check('operational_events_severity_check', enumCheck('severity', OPERATIONAL_SEVERITIES)),
    check('operational_events_occurrence_check', sql`occurrence_count >= 1`),
    // A resolver without a resolution time is nonsense in either direction. The
    // UPDATE guard in migration 0011 says the same thing for updates; this says
    // it for inserts, which a BEFORE UPDATE trigger never sees.
    check(
      'operational_events_resolution_check',
      sql`resolved_by_event_id IS NULL OR resolved_at IS NOT NULL`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Identity and RBAC — Phase 1
// ---------------------------------------------------------------------------

/**
 * Administrators.
 *
 * Scoped to the TENANT, not to a bot instance. `UNK-ADM-004` is unresolved, and
 * the tenant-wide model is the one that can be narrowed later — adding
 * `bot_instance_id` to `admin_roles` is additive, while removing a scope that
 * turned out to be wrong is not.
 *
 * An Admin is not a Customer. They will not share a table, an id space or a
 * status vocabulary, because in the legacy system they do and "is this person
 * an admin" is therefore the same row as "is this person a buyer".
 *
 * `username` is stored already lower-cased — the CHECK enforces it — so the
 * composite unique index is enough to stop `Owner` and `owner` becoming two
 * accounts, with no query needing to remember `lower()`.
 */
export const admins = pgTable(
  'admins',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    username: text('username').notNull(),
    displayName: text('display_name').notNull(),
    /**
     * The self-describing output of the PasswordHasher: algorithm, parameters,
     * salt and digest in one string. Never a plaintext, never a bare digest,
     * and never returned by any query a surface can reach.
     */
    passwordHash: text('password_hash').notNull(),
    passwordUpdatedAt: timestamptz('password_updated_at').notNull(),
    status: text('status').notNull().default('ACTIVE'),
    /**
     * The Telegram admin seam. A later Telegram admin surface attaches to THIS
     * identity rather than creating a second admin table — which is how the
     * legacy system ended up with two role vocabularies for one column.
     * Stored as text: Telegram ids exceed 2^53 and must not become floats.
     */
    telegramUserId: text('telegram_user_id'),
    lastLoginAt: timestamptz('last_login_at'),
    disabledAt: timestamptz('disabled_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    // Redundant with the primary key on `id` alone, and deliberately so: it is
    // the candidate key that lets a child row say "this admin, IN THIS TENANT".
    unique('admins_tenant_id_key').on(table.tenantId, table.id),
    uniqueIndex('admins_tenant_username_key').on(table.tenantId, table.username),
    // Partial: two tenants may each have an admin with no Telegram link.
    uniqueIndex('admins_tenant_telegram_key')
      .on(table.tenantId, table.telegramUserId)
      .where(sql`telegram_user_id IS NOT NULL`),
    index('admins_tenant_status_idx').on(table.tenantId, table.status),
    check('admins_status_check', enumCheck('status', ADMIN_STATUSES)),
    check('admins_username_lowercase_check', sql`username = lower(username)`),
    check('admins_username_shape_check', sql`username ~ '^[a-z0-9._-]{3,64}$'`),
    check(
      'admins_telegram_shape_check',
      sql`telegram_user_id IS NULL OR telegram_user_id ~ '^[0-9]{1,20}$'`,
    ),
    // A disabled admin has a disabling timestamp and an active one does not, so
    // the two columns cannot drift into disagreeing about the same fact.
    check(
      'admins_disabled_at_check',
      sql`(status = 'DISABLED' AND disabled_at IS NOT NULL) OR (status <> 'DISABLED' AND disabled_at IS NULL)`,
    ),
  ],
);

/**
 * Roles: a tenant-scoped, editable composition over the frozen permission
 * catalog. Never an enum — the legacy role column is one, which is why it holds
 * four values in one surface and seven in the other, cannot be changed, and
 * audits nothing.
 *
 * System roles are seeded from `ROLE_SEEDS` and cannot be deleted. An
 * installation that deleted its owner role would have no way back in.
 */
export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    key: text('key').notNull(),
    name: text('name').notNull(),
    isSystem: boolean('is_system').notNull().default(false),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    /**
     * Phase D3: optimistic concurrency for the role editor. An edit names the version it
     * was made from and the UPDATE matches on it; a zero row count is a conflict, never
     * a merge (ADR-0021's rule for every versioned edit).
     */
    version: integer('version').notNull().default(1),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    unique('roles_tenant_id_key').on(table.tenantId, table.id),
    check('roles_version_check', sql`version >= 1`),
    uniqueIndex('roles_tenant_key_key').on(table.tenantId, table.key),
    check('roles_key_shape_check', sql`key ~ '^[a-z][a-z0-9_]{1,63}$'`),
  ],
);

/**
 * Which permissions a role carries.
 *
 * `tenant_id` is carried here as well as on `roles`, and is part of the unique
 * index. It is denormalised on purpose: it makes every scoped query a
 * single-table predicate rather than a join the caller could forget, which is
 * the whole basis of application-level tenant isolation (ADR-0004).
 */
export const rolePermissions = pgTable(
  'role_permissions',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    roleId: uuid('role_id').notNull(),
    permissionKey: text('permission_key').notNull(),
  },
  (table) => [
    uniqueIndex('role_permissions_pkey').on(table.tenantId, table.roleId, table.permissionKey),
    index('role_permissions_role_idx').on(table.roleId),
    // Composite: the role must belong to THIS tenant. A single-column reference
    // would let a row name tenant A while granting tenant B's role.
    foreignKey({
      name: 'role_permissions_tenant_role_fk',
      columns: [table.tenantId, table.roleId],
      foreignColumns: [roles.tenantId, roles.id],
    }),
  ],
);

/** Role assignment. An admin may hold several roles; effective = the union. */
export const adminRoles = pgTable(
  'admin_roles',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    adminId: uuid('admin_id').notNull(),
    roleId: uuid('role_id').notNull(),
    assignedAt: timestamptz('assigned_at').notNull().defaultNow(),
    /**
     * The admin who granted this. NULL only for the installation bootstrap,
     * which has no acting administrator because none exists yet — a fabricated
     * actor there would be the invented identity this codebase refuses. The
     * audit row, with actor SYSTEM_JOB, carries the full story.
     */
    assignedByAdminId: uuid('assigned_by_admin_id'),
  },
  (table) => [
    uniqueIndex('admin_roles_pkey').on(table.tenantId, table.adminId, table.roleId),
    index('admin_roles_admin_idx').on(table.adminId),
    index('admin_roles_role_idx').on(table.roleId),
    foreignKey({
      name: 'admin_roles_tenant_admin_fk',
      columns: [table.tenantId, table.adminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
    foreignKey({
      name: 'admin_roles_tenant_role_fk',
      columns: [table.tenantId, table.roleId],
      foreignColumns: [roles.tenantId, roles.id],
    }),
    // Only an administrator of this tenant can have granted a role in it.
    foreignKey({
      name: 'admin_roles_tenant_assigned_by_fk',
      columns: [table.tenantId, table.assignedByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
  ],
);

/**
 * Per-admin overrides on top of their roles.
 *
 * Justified by the resolution rule already frozen in the contract
 * (`resolveEffectivePermissions`): effective = (roles ∪ GRANT) − DENY, DENY
 * always wins, and an expired override stops applying without anyone running a
 * cleanup job. A `reason` is mandatory — an unexplained standing exception is
 * indistinguishable from a mistake six months later.
 */
export const adminPermissionOverrides = pgTable(
  'admin_permission_overrides',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    adminId: uuid('admin_id').notNull(),
    permissionKey: text('permission_key').notNull(),
    effect: text('effect').notNull(),
    reason: text('reason').notNull(),
    expiresAt: timestamptz('expires_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    createdByAdminId: uuid('created_by_admin_id'),
  },
  (table) => [
    uniqueIndex('admin_permission_overrides_pkey').on(
      table.tenantId,
      table.adminId,
      table.permissionKey,
      table.effect,
    ),
    index('admin_permission_overrides_admin_idx').on(table.adminId),
    check(
      'admin_permission_overrides_effect_check',
      enumCheck('effect', PERMISSION_OVERRIDE_EFFECTS),
    ),
    foreignKey({
      name: 'admin_permission_overrides_tenant_admin_fk',
      columns: [table.tenantId, table.adminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
    foreignKey({
      name: 'admin_permission_overrides_tenant_created_by_fk',
      columns: [table.tenantId, table.createdByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
  ],
);

/**
 * Sessions.
 *
 * Only the SHA-256 of the token is stored, so reading this table cannot
 * impersonate anyone — a database backup, a log line or a support screenshot
 * carries nothing usable. The plaintext exists in exactly one response body and
 * is never recoverable afterwards.
 *
 * Revocation is a timestamp rather than a delete, so "when was this session
 * killed, and by what" survives.
 */
export const adminSessions = pgTable(
  'admin_sessions',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    adminId: uuid('admin_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    issuedAt: timestamptz('issued_at').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    lastSeenAt: timestamptz('last_seen_at').notNull(),
    revokedAt: timestamptz('revoked_at'),
    revokedReason: text('revoked_reason'),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (table) => [
    // Global rather than per-tenant: the token is the lookup key and is
    // presented before any tenant is known, so it must be unique everywhere.
    uniqueIndex('admin_sessions_token_key').on(table.tokenHash),
    index('admin_sessions_admin_idx').on(table.tenantId, table.adminId),
    index('admin_sessions_expiry_idx')
      .on(table.expiresAt)
      .where(sql`revoked_at IS NULL`),
    // Retention, and deliberately NOT partial.
    //
    // The index above is partial on `revoked_at IS NULL`, which is right for
    // finding live sessions and useless to the sweeper: retention collects
    // revoked rows too, so its query cannot imply that predicate and would fall
    // back to a sequential scan. Harmless on a small table, and not harmless at
    // all now that connections carry a statement timeout — a backlog big enough
    // to scan past it would have made every sweep fail, leaving growth an
    // attacker can drive permanent.
    index('admin_sessions_retention_idx').on(table.expiresAt),
    // The session lookup is the one read that is unscoped by necessity, and it
    // RETURNS the tenant everything downstream is scoped to. A row naming the
    // wrong tenant would hand a caller a scope that is not theirs.
    foreignKey({
      name: 'admin_sessions_tenant_admin_fk',
      columns: [table.tenantId, table.adminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
  ],
);

/**
 * Login throttling.
 *
 * Durable rather than in Redis, for two reasons: an attacker must not be able
 * to clear their own counter by waiting for a cache eviction or a restart, and
 * the tests must be deterministic — the window advances by the injected Clock,
 * not by sleeping.
 *
 * Keyed by subject rather than by admin id, so a username that does not exist
 * is throttled exactly like one that does. Throttling only real accounts would
 * turn the lockout itself into a username oracle.
 */
export const adminLoginThrottle = pgTable(
  'admin_login_throttle',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    subjectKind: text('subject_kind').notNull(),
    subject: text('subject').notNull(),
    failedCount: integer('failed_count').notNull().default(0),
    windowStartedAt: timestamptz('window_started_at').notNull(),
    lockedUntil: timestamptz('locked_until'),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('admin_login_throttle_pkey').on(table.tenantId, table.subjectKind, table.subject),
    // Retention. The unique index above leads with `tenant_id` and serves the
    // per-subject lookups; nothing supported the sweeper's predicate, so every
    // batch scanned the whole table — the one an unauthenticated caller can
    // grow at will, and the one a statement timeout then makes unsweepable.
    index('admin_login_throttle_retention_idx').on(table.windowStartedAt, table.lockedUntil),
    check('admin_login_throttle_kind_check', enumCheck('subject_kind', ['USERNAME', 'IP'])),
    check('admin_login_throttle_count_check', sql`failed_count >= 0`),
  ],
);

// ---------------------------------------------------------------------------
// Admin security — Phase D2 (program §17)
// ---------------------------------------------------------------------------

/**
 * An administrator's TOTP factor (RFC 6238). At most ONE row per administrator.
 *
 * `PENDING` is an enrolment that has displayed its secret and is waiting for the first
 * code; `ACTIVE` is a factor sign-in demands. No row is "disabled": disabling DELETES the
 * row, so a turned-off factor leaves no ciphertext behind, and enrolling again mints a new
 * row id — which is the entity the secret's AEAD context names, so an old ciphertext
 * cannot be put back.
 *
 * `last_used_step` is the replay defence: the 30-second step of the last code accepted.
 * A code is accepted only for a step STRICTLY greater, decided by a conditional UPDATE
 * under the row lock, so one code is good once even when two requests carry it at the
 * same instant. `integer` is enough: the step count passes 2^31 in the year 4011.
 */
export const adminTotpFactors = pgTable(
  'admin_totp_factors',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    adminId: uuid('admin_id').notNull(),
    state: text('state').notNull(),
    totpSecretCiphertext: text('totp_secret_ciphertext').notNull(),
    totpSecretKeyId: text('totp_secret_key_id').notNull(),
    lastUsedStep: integer('last_used_step'),
    /**
     * The session that started a PENDING enrolment. Activation is refused from any other
     * session: the secret was shown to that one, and a different session presenting a
     * code is somebody guessing rather than somebody scanning (security review, D2).
     * Null once active, and for an enrolment made without a session.
     */
    enrolledSessionId: uuid('enrolled_session_id'),
    /** Wrong activation codes against this PENDING row; past the cap it is discarded. */
    activationAttempts: integer('activation_attempts').notNull().default(0),
    createdAt: timestamptz('created_at').notNull(),
    activatedAt: timestamptz('activated_at'),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('admin_totp_factors_admin_key').on(table.tenantId, table.adminId),
    check('admin_totp_factors_state_check', enumCheck('state', ['PENDING', 'ACTIVE'])),
    // The two columns cannot disagree about whether the factor is on.
    check(
      'admin_totp_factors_activated_check',
      sql`(state = 'ACTIVE') = (activated_at IS NOT NULL)`,
    ),
    check('admin_totp_factors_step_check', sql`last_used_step IS NULL OR last_used_step >= 0`),
    check('admin_totp_factors_attempts_check', sql`activation_attempts >= 0`),
    foreignKey({
      name: 'admin_totp_factors_tenant_admin_fk',
      columns: [table.tenantId, table.adminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
  ],
);

/**
 * Backup codes: one row per code of the administrator's CURRENT generation.
 *
 * Only a hash is stored. The code is 80 bits from the CSPRNG, so — as with a session
 * token — a plain SHA-256 is right and a slow KDF would only add latency: there is
 * nothing to brute-force. The hash is domain-separated and salted with the tenant and
 * administrator, so equal hashes in two rows say nothing.
 *
 * Regenerating DELETES the previous generation in the transaction that inserts the new
 * one; disabling the factor deletes them all. A used code keeps its row (with `used_at`)
 * until then, which is what "N of 10 remaining" counts. Consumption is one conditional
 * UPDATE on `used_at IS NULL`, so a code is spent once however many requests race it.
 */
export const adminBackupCodes = pgTable(
  'admin_backup_codes',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    adminId: uuid('admin_id').notNull(),
    codeHash: text('code_hash').notNull(),
    createdAt: timestamptz('created_at').notNull(),
    usedAt: timestamptz('used_at'),
  },
  (table) => [
    uniqueIndex('admin_backup_codes_hash_key').on(table.tenantId, table.adminId, table.codeHash),
    foreignKey({
      name: 'admin_backup_codes_tenant_admin_fk',
      columns: [table.tenantId, table.adminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
  ],
);

/**
 * A password-verified sign-in waiting for its second factor.
 *
 * Not a session, and deliberately not a row in `admin_sessions` with a flag: every reader
 * of that table — authentication, `isLive`, the session list, revocation counts — would
 * have to remember the flag, and the one that forgot would be a session that skipped
 * the second factor. A separate table cannot be mistaken for a session.
 *
 * Only the SHA-256 of the challenge token is stored, like a session's. The
 * `credential_fingerprint` is a SHA-256 of the password hash the first step verified:
 * the session is minted only if the stored hash still matches it, so a password rotated
 * between the two steps voids the challenge exactly as it voids a login in flight.
 * `attempts` bounds the guesses one challenge allows; `consumed_at` makes it single-use.
 */
export const adminLoginChallenges = pgTable(
  'admin_login_challenges',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    adminId: uuid('admin_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    credentialFingerprint: text('credential_fingerprint').notNull(),
    issuedAt: timestamptz('issued_at').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    attempts: integer('attempts').notNull().default(0),
    consumedAt: timestamptz('consumed_at'),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (table) => [
    // Global, like the session token: it is presented before any tenant is known.
    uniqueIndex('admin_login_challenges_token_key').on(table.tokenHash),
    index('admin_login_challenges_admin_idx').on(table.tenantId, table.adminId),
    // Retention.
    index('admin_login_challenges_retention_idx').on(table.expiresAt),
    check('admin_login_challenges_attempts_check', sql`attempts >= 0`),
    foreignKey({
      name: 'admin_login_challenges_tenant_admin_fk',
      columns: [table.tenantId, table.adminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
  ],
);

// ---------------------------------------------------------------------------
// Control plane — Phase 2
// ---------------------------------------------------------------------------

/**
 * A tenant's override of one template body.
 *
 * Current state, one row per `(tenant, key, locale)`. The RAW source, exactly as
 * an administrator typed it — never a rendered string. In the legacy system the
 * edit screen echoes the rendered text, so the raw template cannot be read back
 * from the screen that edits it, and a save from that view would store the
 * editor's own name where a placeholder was (TBR-TXT-004).
 *
 * `version` carries optimistic concurrency: an UPDATE matches on it and a zero
 * row count is a conflict, never a retry (ADR-0021).
 *
 * There is no `is_default` column and no copy of the default body. A tenant that
 * has not overridden a key has NO ROW, which is what lets an improved default
 * reach them.
 */
export const templateOverrides = pgTable(
  'template_overrides',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    templateKey: text('template_key').notNull(),
    locale: text('locale').notNull(),
    /** Raw source. Placeholders un-substituted. Never a rendered message. */
    body: text('body').notNull(),
    version: integer('version').notNull().default(1),
    /** The revision in `template_revisions` this body came from. */
    revision: integer('revision').notNull(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    updatedByAdminId: uuid('updated_by_admin_id'),
  },
  (table) => [
    uniqueIndex('template_overrides_key').on(table.tenantId, table.templateKey, table.locale),
    check('template_overrides_version_check', sql`version >= 1`),
    check('template_overrides_body_check', sql`length(body) BETWEEN 1 AND 4096`),
    // Only an administrator of this tenant can have edited this tenant's copy.
    foreignKey({
      name: 'template_overrides_tenant_admin_fk',
      columns: [table.tenantId, table.updatedByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
  ],
);

/**
 * Every change to a tenant's template body, including the reverts.
 *
 * Append-only. A revert deletes the override row and writes a revision here
 * saying so, which is why `body` is nullable: a REVERT revision has no body,
 * because reverting means going back to the default rather than storing a copy
 * of it.
 *
 * This is NOT the audit log and does not duplicate it. The audit row answers
 * "who changed what", is redacted, and is governed by a retention policy; this
 * table holds the content itself, is read by a product feature, and lives as
 * long as the tenant. Both are written in the same transaction.
 */
export const templateRevisions = pgTable(
  'template_revisions',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    templateKey: text('template_key').notNull(),
    locale: text('locale').notNull(),
    /** Monotonic per `(tenant, key, locale)`, starting at 1. */
    revision: integer('revision').notNull(),
    action: text('action').notNull(),
    /** Raw source for a SET. NULL for a REVERT. */
    body: text('body'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    createdByAdminId: uuid('created_by_admin_id'),
  },
  (table) => [
    uniqueIndex('template_revisions_key').on(
      table.tenantId,
      table.templateKey,
      table.locale,
      table.revision,
    ),
    check('template_revisions_action_check', enumCheck('action', TEMPLATE_REVISION_ACTIONS)),
    check('template_revisions_revision_check', sql`revision >= 1`),
    // A SET carries a body; a REVERT never does. Without this the two shapes
    // drift and "which revision restored the default" stops being answerable.
    check(
      'template_revisions_body_check',
      sql`(action = 'SET' AND body IS NOT NULL AND length(body) BETWEEN 1 AND 4096) OR (action = 'REVERT' AND body IS NULL)`,
    ),
    foreignKey({
      name: 'template_revisions_tenant_admin_fk',
      columns: [table.tenantId, table.createdByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
  ],
);

/**
 * A tenant's value for one registered setting.
 *
 * Absence means the default applies. That is the whole source-resolution rule,
 * and it is stored as absence rather than as a flag beside the value, because a
 * flag and a value can disagree and absence cannot.
 *
 * The value is `jsonb` because the registry's schemas are heterogeneous — a
 * string, an integer, an enum, a nullable integer. It is NOT a free-form
 * document: it is parsed by that key's declared zod schema on the way in and on
 * the way out, and a key that is not registered has no row and cannot get one.
 */
export const settingValues = pgTable(
  'setting_values',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    settingKey: text('setting_key').notNull(),
    value: jsonb('value').notNull(),
    version: integer('version').notNull().default(1),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    updatedByAdminId: uuid('updated_by_admin_id'),
  },
  (table) => [
    uniqueIndex('setting_values_key').on(table.tenantId, table.settingKey),
    check('setting_values_version_check', sql`version >= 1`),
    foreignKey({
      name: 'setting_values_tenant_admin_fk',
      columns: [table.tenantId, table.updatedByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
  ],
);

/**
 * Round T — one row per PUBLISH of a tenant's main-menu layout
 * (`docs/round-t-button-builder-audit.md` §11.1, §11.8).
 *
 * Append-only, by trigger (`nexa_reject_mutation`, migration 0156), like
 * `template_revisions`, and kept for the tenant's life (OQ-T-3): the only record of what
 * the keyboard used to be. Only a publish writes one — a draft save, a reset and a restore
 * change the draft alone. `snapshot` is the explicit layout exactly as published, with its
 * own `v`, so a release that cannot read it says so instead of guessing.
 *
 * `restored_from_revision_id` names the revision a restored draft came from; the composite
 * foreign key keeps it inside the tenant.
 */
export const mainMenuRevisions = pgTable(
  'main_menu_revisions',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** Monotonic per tenant, starting at 1. */
    revision: integer('revision').notNull(),
    snapshot: jsonb('snapshot').notNull(),
    restoredFromRevisionId: uuid('restored_from_revision_id'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    createdByAdminId: uuid('created_by_admin_id'),
  },
  (table) => [
    uniqueIndex('main_menu_revisions_tenant_revision_key').on(table.tenantId, table.revision),
    // The target of the tenant-scoped foreign keys below and on `main_menu_layouts`.
    unique('main_menu_revisions_tenant_id_key').on(table.tenantId, table.id),
    check('main_menu_revisions_revision_check', sql`revision >= 1`),
    check('main_menu_revisions_snapshot_check', sql`jsonb_typeof(snapshot) = 'object'`),
    foreignKey({
      name: 'main_menu_revisions_restored_from_fk',
      columns: [table.tenantId, table.restoredFromRevisionId],
      foreignColumns: [table.tenantId, table.id],
    }),
    foreignKey({
      name: 'main_menu_revisions_tenant_admin_fk',
      columns: [table.tenantId, table.createdByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
  ],
);

/**
 * Round T — a tenant's main-menu builder state: the DRAFT and the PUBLISHED head, one row
 * per tenant (`docs/round-t-button-builder-audit.md` §11.1).
 *
 * No row means the tenant never saved a draft, and the keyboard is the legacy path over
 * `bot.main_menu`, byte for byte. The runtime reads `published` only, never `draft`.
 *
 * `projection_setting_version` is the `setting_values.version` of `bot.main_menu` the
 * publish wrote in the same transaction. When the setting's version has moved past it —
 * written by an older release during a rollback, the one remaining writer — the published
 * layout is SUPERSEDED: the keyboard follows the setting and the builder says so.
 *
 * Every write is a conditional UPDATE naming the version it read (`draft_version`, and for
 * a publish `published_revision` too); the first write is `INSERT … ON CONFLICT DO NOTHING`.
 */
export const mainMenuLayouts = pgTable(
  'main_menu_layouts',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id),
    draft: jsonb('draft').notNull(),
    draftVersion: integer('draft_version').notNull().default(1),
    draftUpdatedAt: timestamptz('draft_updated_at').notNull(),
    draftUpdatedByAdminId: uuid('draft_updated_by_admin_id'),
    draftRestoredFromRevisionId: uuid('draft_restored_from_revision_id'),
    /**
     * The draft's LEGACY BASELINE: the `bot.main_menu` version it was derived from (NULL:
     * the setting had no row). Set by the first draft save (from the version the page was
     * seeded from), by a reset or reseed, and by every publish. While nothing is published,
     * or the published layout is superseded, a publish requires the setting to still be at
     * this version — a draft is never published over a legacy write nobody looked at.
     */
    draftLegacySettingVersion: integer('draft_legacy_setting_version'),
    published: jsonb('published'),
    publishedRevision: integer('published_revision'),
    publishedAt: timestamptz('published_at'),
    publishedByAdminId: uuid('published_by_admin_id'),
    projectionSettingVersion: integer('projection_setting_version'),
  },
  (table) => [
    check('main_menu_layouts_draft_check', sql`jsonb_typeof(draft) = 'object'`),
    check('main_menu_layouts_draft_version_check', sql`draft_version >= 1`),
    check(
      'main_menu_layouts_draft_legacy_setting_version_check',
      sql`draft_legacy_setting_version IS NULL OR draft_legacy_setting_version >= 1`,
    ),
    check(
      'main_menu_layouts_published_check',
      sql`published IS NULL OR jsonb_typeof(published) = 'object'`,
    ),
    check(
      'main_menu_layouts_published_revision_check',
      sql`published_revision IS NULL OR published_revision >= 1`,
    ),
    // A published head is whole or absent: never a layout without its revision, its time
    // or the projection version it wrote.
    check(
      'main_menu_layouts_published_shape_check',
      sql`(published IS NULL) = (published_revision IS NULL) AND (published IS NULL) = (published_at IS NULL) AND (published IS NULL) = (projection_setting_version IS NULL)`,
    ),
    foreignKey({
      name: 'main_menu_layouts_restored_from_fk',
      columns: [table.tenantId, table.draftRestoredFromRevisionId],
      foreignColumns: [mainMenuRevisions.tenantId, mainMenuRevisions.id],
    }),
    foreignKey({
      name: 'main_menu_layouts_draft_admin_fk',
      columns: [table.tenantId, table.draftUpdatedByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
    foreignKey({
      name: 'main_menu_layouts_published_admin_fk',
      columns: [table.tenantId, table.publishedByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
  ],
);

/**
 * A tenant's state for one registered feature flag.
 *
 * `enabled` is a boolean column, and that is a design constraint rather than an
 * incidental type: it gives configuration nowhere to hide. The legacy capability
 * screen has four shapes behind it (CBR-011), three of which are settings
 * wearing a toggle's clothes; those live in `setting_values`.
 */
export const featureFlagStates = pgTable(
  'feature_flag_states',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    flagKey: text('flag_key').notNull(),
    enabled: boolean('enabled').notNull(),
    version: integer('version').notNull().default(1),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    updatedByAdminId: uuid('updated_by_admin_id'),
    /** The latest change's optional note; since WP-A2 no flag requires one. */
    reason: text('reason'),
  },
  (table) => [
    uniqueIndex('feature_flag_states_key').on(table.tenantId, table.flagKey),
    check('feature_flag_states_version_check', sql`version >= 1`),
    foreignKey({
      name: 'feature_flag_states_tenant_admin_fk',
      columns: [table.tenantId, table.updatedByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
  ],
);

/**
 * A notification INTENT.
 *
 * One row per thing that should be communicated, created inside the transaction
 * that produced it. Never one row per send: a retry appends to
 * `notification_delivery_attempts` and leaves this row alone.
 *
 * `dedupe_key` is the intent's identity within its tenant, and the unique index
 * is what makes "a retry must not create a second logical notification" a
 * property of the database rather than of the queue behaving well.
 *
 * `destination` is a SNAPSHOT taken when the intent was created, not a reference
 * to the setting that produced it: an attempt from March must still say which
 * chat it was addressed to after somebody repoints the destination in April.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: text('kind').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    /** The rendered destination, as it stood when the intent was created. */
    destination: jsonb('destination').notNull(),
    /** Typed values for the template this kind renders. Redacted like any log. */
    payload: jsonb('payload').notNull(),
    templateKey: text('template_key').notNull(),
    status: text('status').notNull().default('PENDING'),
    attemptCount: integer('attempt_count').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull(),
    correlationId: text('correlation_id'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    lastAttemptAt: timestamptz('last_attempt_at'),
    /**
     * The earliest moment the next attempt may run.
     *
     * Three jobs in one column: the initial "send now", the back-off after a
     * retryable failure, and the LEASE the dispatcher takes when it claims a
     * row. Pushing it forward before the send means an intent whose sender dies
     * mid-flight becomes eligible again on its own, instead of staying claimed
     * by a process that no longer exists.
     */
    nextAttemptAt: timestamptz('next_attempt_at').notNull().defaultNow(),
    /** When it reached SENT or FAILED. NULL while PENDING. */
    completedAt: timestamptz('completed_at'),
  },
  (table) => [
    // The candidate key a composite foreign key needs on the referenced side,
    // so a delivery attempt can say "the notification with this id, IN THIS
    // TENANT" rather than naming a globally unique id and hoping. Redundant
    // with the primary key on purpose (migration 0007 explains the pattern).
    unique('notifications_tenant_id_key').on(table.tenantId, table.id),
    uniqueIndex('notifications_dedupe_key').on(table.tenantId, table.dedupeKey),
    // The administrator-facing list: this tenant's notifications, newest first.
    index('notifications_tenant_created_idx').on(table.tenantId, table.createdAt),
    /**
     * The dispatcher's claim.
     *
     * `SELECT ... WHERE status = 'PENDING' AND next_attempt_at <= now ORDER BY
     * next_attempt_at FOR UPDATE SKIP LOCKED` — one query, run on a tick, and
     * the only reason this index exists.
     *
     * Partial, and it stays small: a row leaves the index the moment it reaches
     * SENT or FAILED, so it holds work in flight rather than all history.
     * Deliberately not led by `tenant_id` — the dispatcher runs for the
     * installation and has no tenant to fix, so a tenant-leading index would be
     * a scan.
     */
    index('notifications_pending_idx')
      .on(table.nextAttemptAt)
      .where(sql`status = 'PENDING'`),
    check('notifications_kind_check', enumCheck('kind', NOTIFICATION_KINDS)),
    check('notifications_status_check', enumCheck('status', NOTIFICATION_STATUSES)),
    check('notifications_attempts_check', sql`attempt_count >= 0 AND max_attempts >= 1`),
    // A terminal status has a completion time and a pending one does not. Two
    // fields that can contradict each other are a bug with a migration attached.
    check(
      'notifications_completed_check',
      sql`(status = 'PENDING' AND completed_at IS NULL) OR (status <> 'PENDING' AND completed_at IS NOT NULL)`,
    ),
  ],
);

/**
 * Claims handed back without ever reaching the transport.
 *
 * `attempt_count` on the intent counts claims ISSUED, and it is deliberately
 * monotonic: a claim whose process died with the socket open has to count, or a
 * crash-looping worker retries for ever. So capacity cannot be returned by
 * decrementing it, and the first attempt to do so was wrong in two ways at
 * once. A decrement matched on `attempt_count = attemptNumber` could only be
 * applied by whichever claim happened to be current, so two outstanding claims
 * releasing out of order silently lost one attempt's capacity; and it required
 * `status = 'PENDING'`, so a sweep that terminalised the row a moment earlier
 * made the hand-back impossible.
 *
 * A release is a FACT about one attempt number, recorded here. Spend is then
 * derived — `attempt_count` minus the releases — so order does not matter, a
 * repeated release is a no-op against the primary key, and a release can be
 * recorded after the intent has been written off.
 */
export const notificationReleasedClaims = pgTable(
  'notification_released_claims',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    notificationId: uuid('notification_id').notNull(),
    attemptNumber: integer('attempt_number').notNull(),
    releasedAt: timestamptz('released_at').notNull(),
    /** Why the claim was handed back. A machine code, never a sentence. */
    reason: text('reason').notNull(),
  },
  (table) => [
    // The identity of a release IS the attempt it releases. Idempotent by
    // construction: a retry after an ambiguous commit inserts nothing new,
    // which is what makes a release safe to repeat when its outcome is unknown.
    primaryKey({
      name: 'notification_released_claims_pk',
      columns: [table.tenantId, table.notificationId, table.attemptNumber],
    }),
    check('notification_released_claims_number_check', sql`attempt_number >= 1`),
    foreignKey({
      name: 'notification_released_claims_tenant_notification_fk',
      columns: [table.tenantId, table.notificationId],
      foreignColumns: [notifications.tenantId, notifications.id],
    }),
  ],
);

/**
 * One attempt to deliver one notification. Append-only.
 *
 * The record of what actually happened on the wire, which the legacy system does
 * not keep at all — it has no delivery-status field anywhere, which is why
 * whether its notification report means "sent" or "matched" is UNKNOWN
 * (UNK-LGR-015).
 *
 * `retry_after_ms` holds what the transport ASKED FOR, when it said anything. A
 * 429 that names a wait is honoured rather than second-guessed.
 */
export const notificationDeliveryAttempts = pgTable(
  'notification_delivery_attempts',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    notificationId: uuid('notification_id').notNull(),
    attemptNumber: integer('attempt_number').notNull(),
    transport: text('transport').notNull(),
    outcome: text('outcome').notNull(),
    startedAt: timestamptz('started_at').notNull(),
    finishedAt: timestamptz('finished_at').notNull(),
    /** A machine code from the transport, never a prose sentence. */
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    retryAfterMs: integer('retry_after_ms'),
  },
  (table) => [
    uniqueIndex('notification_delivery_attempts_key').on(
      table.tenantId,
      table.notificationId,
      table.attemptNumber,
    ),
    check('notification_delivery_attempts_outcome_check', enumCheck('outcome', DELIVERY_OUTCOMES)),
    check(
      'notification_delivery_attempts_transport_check',
      enumCheck('transport', NOTIFICATION_TRANSPORTS),
    ),
    check('notification_delivery_attempts_number_check', sql`attempt_number >= 1`),
    // A success carries no error; a failure carries a code. Otherwise "why did
    // this fail" is answered by an empty column half the time.
    check(
      'notification_delivery_attempts_error_check',
      sql`(outcome = 'SUCCEEDED' AND error_code IS NULL) OR (outcome <> 'SUCCEEDED' AND error_code IS NOT NULL)`,
    ),
    foreignKey({
      name: 'notification_delivery_attempts_tenant_notification_fk',
      columns: [table.tenantId, table.notificationId],
      foreignColumns: [notifications.tenantId, notifications.id],
    }),
  ],
);

/** A counter that keeps the outbox `sequence` monotonic per aggregate. */
export const aggregateSequences = pgTable(
  'aggregate_sequences',
  {
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    lastSequence: bigint('last_sequence', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
  },
  (table) => [uniqueIndex('aggregate_sequences_pkey').on(table.aggregateType, table.aggregateId)],
);
// ---------------------------------------------------------------------------
// Panels — a tenant's connections to the provider software it sells access to
// ---------------------------------------------------------------------------

/**
 * A panel: what to call, and what an operator calls it.
 *
 * Three tables rather than one, and the split is by LIFETIME rather than by
 * tidiness. This row changes when an operator edits configuration.
 * `panel_credentials` changes when a credential is replaced, which is a
 * different permission and a different audit action. `panel_health` changes on
 * every probe — many times an hour once Phase 3C schedules them — and putting
 * that in this row would move `updated_at` on a row nobody edited, make every
 * probe contend with every operator edit for the same tuple lock, and drag
 * ciphertext through the buffer pool on every list query.
 *
 * There is no `priority` or `sort` column. The legacy corpus does not evidence
 * one (it is NOT_EXPOSED, which is not the same as absent), nothing in Phase 3
 * orders panels, and panel SELECTION is Phase 4's problem. An integer column
 * added then is a one-line additive migration; a column added now is a column
 * whose meaning gets decided by whoever first writes to it.
 *
 * There is no customer-visibility flag either, and that is deliberate rather
 * than forgotten. The legacy system gates a panel behind FOUR independent
 * conditions — a display toggle, a tier-group set, a per-customer hidden list,
 * and a separate delivery toggle (PBR-005) — and collapsing those into one
 * boolean now is exactly the decision Phase 4 would have to undo. `status`
 * here is operational: whether THIS installation uses the panel at all.
 */
export const panels = pgTable(
  'panels',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    /**
     * A value from `PROVIDER_TYPES`, constrained by the database.
     *
     * The CHECK is the outer half of a pair. It stops an unknown provider being
     * written; `providerAdapter()` refuses to instantiate one if a migration or
     * a direct write ever gets one past it. Either alone would leave a row that
     * names an adapter nothing can build.
     */
    providerType: text('provider_type').notNull(),
    baseUrl: text('base_url').notNull(),
    status: text('status').notNull().default('ACTIVE'),
    /**
     * The per-panel configuration this provider needs before it can build a config.
     *
     * `requiredActivationFields` on the descriptor has named this since Phase 3 and
     * nothing stored a value, so a 3X-UI panel could be connected, probed and reported
     * healthy while being unable to produce the one thing a customer buys.
     *
     * Validated against `PANEL_ACTIVATION_SCHEMAS[providerType]` at the application
     * boundary, never here: the shape is per provider and a CHECK constraint cannot
     * know which provider a row is. Null means unset, which is a real state a fresh
     * panel is in and which `PANEL_NOT_OPERABLE` names rather than guesses past.
     */
    activation: jsonb('activation'),
    /**
     * The most services this panel may carry, or NULL for no limit.
     *
     * Phase 6B, and NULL is the honest default rather than a large number: this
     * installation does not know what any given panel can take. The number is an
     * operator's judgement about their own machine, so the absence of one means
     * "nobody has said", not "unlimited is proven safe".
     *
     * A SOFT cap. Lowering it below current usage refuses new sales and terminates
     * nothing — a limit that could delete a customer's service because somebody
     * mistyped a number is not a limit, it is an outage with a form field.
     */
    maxServices: integer('max_services'),
    /**
     * Which username modes a customer buying on this panel may use.
     *
     * Both default to true, so every panel that exists when this migration runs keeps
     * offering everything and nothing an operator configured changes underneath them.
     * `panels_username_policy_check` refuses both being false: a panel a customer
     * cannot name a service on is a panel nothing can be bought from, and it would
     * fail at their purchase rather than at the operator's save.
     */
    allowCustomUsername: boolean('allow_custom_username').notNull().default(true),
    allowAutomaticUsername: boolean('allow_automatic_username').notNull().default(true),
    /**
     * Which of the four presets generates an AUTOMATIC name here.
     *
     * NOT NULL with a real default, and that is the correction 0094 carries. A
     * nullable column meaning "nobody has configured this, so something else decides"
     * is a migration state in a vocabulary every surface has to render, and it makes
     * the generator unreadable: an operator could not answer "what will the next
     * customer be called" without knowing what the absence falls back to.
     *
     * `PREFIX_RANDOM` with the prefix `nx` renders twelve characters —
     * `DEFAULT_USERNAME_PATTERN`. Existing services are not renamed.
     */
    usernameStrategy: text('username_strategy').notNull().default(DEFAULT_USERNAME_STRATEGY),
    /**
     * The `PREFIX_RANDOM` prefix. NULL under any other strategy.
     *
     * Defaulted, and it HAS to be: `username_strategy` defaults to PREFIX_RANDOM, and
     * `panels_username_prefix_check` is a biconditional, so a prefix with no default
     * makes a panel created without a policy unstorable. 0095 is that correction —
     * found by the integration case that creates a panel and names no policy, which
     * is the commonest way an operator makes one.
     */
    usernamePrefix: text('username_prefix').default(DEFAULT_USERNAME_PREFIX),
    /** The `CUSTOM_TEMPLATE` template. NULL under any other strategy. */
    usernameTemplate: text('username_template'),
    /** Set when the panel is archived, so the event has a time and not just a state. */
    archivedAt: timestamptz('archived_at'),
    /**
     * When an operator DRAINED this panel, or NULL when it is taking new business.
     *
     * Phase C2. Its own column and deliberately not a `status`: `DISABLED` stops the
     * monitor probing the panel and every operation that needs it, and a drained
     * panel must keep both — it is `ACTIVE`, monitored, and every existing service on
     * it keeps working. What drain does is refuse NEW allocations, and it does that
     * through `decideEligibility` (reason `DRAINING`), the one evaluator the
     * catalogue, confirmation and settlement already ask. `decideOperability` never
     * reads it. Nothing is migrated, terminated or deleted by setting it.
     */
    drainedAt: timestamptz('drained_at'),
    /** The operator's reason for the current drain. Present exactly when `drained_at` is. */
    drainReason: text('drain_reason'),
    /**
     * Phase C3: the balancing group, or NULL for none.
     *
     * An operator's statement that this panel is interchangeable with the others in the
     * group for a NEW account. NULL — every existing panel — means the explicit route
     * only: a product bound here sells here. Read by the draft's placement and by the
     * catalogue's reach, never by anything that operates an existing service.
     */
    balancingGroup: text('balancing_group'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('panels_tenant_status_idx').on(table.tenantId, table.status),
    /** A drain and its reason, or neither — the same biconditional shape as the username policy. */
    check(
      'panels_balancing_group_check',
      sql`${table.balancingGroup} IS NULL OR ${table.balancingGroup} ~ '^[a-z0-9][a-z0-9_-]{0,39}$'`,
    ),
    check(
      'panels_drain_reason_check',
      sql`(${table.drainedAt} IS NULL) = (${table.drainReason} IS NULL)`,
    ),
    /**
     * At least one username mode, always.
     *
     * A CHECK rather than a service-layer rule because it is the kind of invariant a
     * direct write, a restore or a future surface can break, and a panel with no mode
     * is only discovered by a customer trying to buy.
     */
    check(
      'panels_username_policy_check',
      sql`${table.allowCustomUsername} OR ${table.allowAutomaticUsername}`,
    ),
    check('panels_username_strategy_check', enumCheck('username_strategy', USERNAME_STRATEGIES)),
    /**
     * A preset and the configuration it needs, or neither. Not "or something".
     *
     * Two biconditionals rather than two one-way implications, so a template left
     * behind by a strategy change cannot sit in the row pretending to be inert: the
     * one-checkbox edit that re-selects `CUSTOM_TEMPLATE` would then go live against
     * a value nobody looked at. The service nulls the other field on every write.
     */
    check(
      'panels_username_prefix_check',
      sql`(${table.usernameStrategy} = 'PREFIX_RANDOM') = (${table.usernamePrefix} IS NOT NULL)`,
    ),
    check(
      'panels_username_template_check',
      sql`(${table.usernameStrategy} = 'CUSTOM_TEMPLATE') = (${table.usernameTemplate} IS NOT NULL)`,
    ),
    /**
     * Unique among a tenant's LIVE panels only.
     *
     * Archiving releases the name, which is the behaviour an operator expects:
     * a panel replaced by a rebuilt one should be able to keep its label. A
     * plain unique index would make the archive permanent in a way archiving is
     * not supposed to be.
     */
    uniqueIndex('panels_tenant_name_live_key')
      .on(table.tenantId, table.name)
      .where(sql`status <> 'ARCHIVED'`),
    /*
     * The list's page-key traversal is NOT declared here.
     *
     * `panels_tenant_created_page_idx` — `(tenant_id, created_at, id)` over
     * live panels — is built concurrently, outside the migrator's transaction,
     * by `online-indexes.ts`. Declaring it here would have drizzle-kit generate
     * an ordinary `CREATE INDEX` migration for it, which is the blocking build
     * that arrangement exists to avoid, and the drift check would never come
     * back clean while both existed.
     *
     * `panels_tenant_page_idx` was that index on `(tenant_id, name, id)`, and
     * it is retired by 0026: the keyset moved off `name`, which an operator can
     * edit and which therefore cannot order a stable traversal.
     */
    check('panels_status_check', enumCheck('status', PANEL_STATUSES)),
    check('panels_provider_type_check', enumCheck('provider_type', PROVIDER_TYPES)),
    /** An archived panel has a time; a live one does not. Neither state can lie. */
    check('panels_archived_at_check', sql`(status = 'ARCHIVED') = (archived_at IS NOT NULL)`),
    /**
     * A cap is a positive number or it is absent.
     *
     * Zero is the interesting case and it is refused rather than accepted as "sell
     * nothing": an operator who wants a panel to stop taking business has
     * `DISABLED`, which says so, stops the probes and reads as a decision. A zero
     * cap would be a second way to spell it that nothing else in the system
     * recognises — the health view would still say `HEALTHY`, the panel would still
     * be probed, and the catalogue would go quiet with no state anywhere naming why.
     */
    check('panels_max_services_check', sql`max_services IS NULL OR max_services > 0`),
    /**
     * Redundant against the primary key, and the target of a composite
     * reference rather than a lookup path.
     *
     * `panel_credentials` and `panel_health` carry a denormalised `tenant_id`,
     * and two separate foreign keys let a child row name panel A while
     * claiming tenant B — the database accepted exactly that. The rewrap
     * rebuilds a credential's Secret Envelope v2 context from the CHILD row's
     * tenant, so such a row would re-encrypt the secret under a context its
     * owner cannot reproduce, and the credential would be unreadable for good.
     * A composite foreign key needs something unique to point at; this is it.
     */
    unique('panels_tenant_id_key').on(table.tenantId, table.id),
  ],
);

/**
 * A panel's credentials, envelope-encrypted, one row per panel.
 *
 * Every column here is either ciphertext, the key id that decrypts it, or the
 * time it was last replaced. There is no plaintext column and no column that
 * could hold one. The legacy web admin rendered a panel's stored password as
 * readable text on its detail page (WEB-BR-007) — a shape where the value
 * exists in the clear anywhere is a shape where some page eventually shows it.
 *
 * `tenant_id` is denormalised from the panel deliberately. It is what the
 * secret registry's rewrap reads to rebuild the AEAD context, and a rewrap that
 * had to join to find the tenant would be one join away from re-encrypting a
 * row under the wrong context.
 *
 * Each credential is nullable because providers differ: Marzban uses a username
 * and a password, and a token-shaped provider uses neither. A NULL ciphertext
 * and a NULL key id travel together — the CHECKs below refuse a half-written
 * credential, which is what an interrupted write would otherwise leave.
 */
export const panelCredentials = pgTable(
  'panel_credentials',
  {
    panelId: uuid('panel_id')
      .primaryKey()
      .references(() => panels.id),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    usernameCiphertext: text('username_ciphertext'),
    usernameKeyId: text('username_key_id'),
    usernameSetAt: timestamptz('username_set_at'),
    passwordCiphertext: text('password_ciphertext'),
    passwordKeyId: text('password_key_id'),
    passwordSetAt: timestamptz('password_set_at'),
    apiTokenCiphertext: text('api_token_ciphertext'),
    apiTokenKeyId: text('api_token_key_id'),
    apiTokenSetAt: timestamptz('api_token_set_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('panel_credentials_tenant_idx').on(table.tenantId),
    /**
     * The pair, not the two halves.
     *
     * `panel_id` and `tenant_id` each had their own foreign key, which
     * constrained them individually and said nothing about them agreeing. A
     * row naming another tenant's panel satisfied both and violated the
     * invariant every query in the repository relies on.
     */
    foreignKey({
      columns: [table.tenantId, table.panelId],
      foreignColumns: [panels.tenantId, panels.id],
      name: 'panel_credentials_tenant_panel_fk',
    }),

    check(
      'panel_credentials_username_check',
      sql`(username_ciphertext IS NULL) = (username_key_id IS NULL)
          AND (username_ciphertext IS NULL) = (username_set_at IS NULL)`,
    ),
    check(
      'panel_credentials_password_check',
      sql`(password_ciphertext IS NULL) = (password_key_id IS NULL)
          AND (password_ciphertext IS NULL) = (password_set_at IS NULL)`,
    ),
    check(
      'panel_credentials_api_token_check',
      sql`(api_token_ciphertext IS NULL) = (api_token_key_id IS NULL)
          AND (api_token_ciphertext IS NULL) = (api_token_set_at IS NULL)`,
    ),
  ],
);

/**
 * The LATEST health of a panel. One row, overwritten.
 *
 * Not a history table, and that is an argued decision rather than a shortcut.
 * A history of probes is unbounded by construction — Phase 3C probes on a
 * schedule — and the legacy system's own failure mode was a log group holding
 * 36 + 15 + 8 + 1 identical TLS errors in one day with no way to collapse them.
 * What an operator needs from history is "this condition started at T and is
 * still going", and `operational_events` already answers exactly that, with a
 * dedupe key and an occurrence counter and a resolution event. So health
 * TRANSITIONS become operational events and the current state lives here.
 *
 * The absence of a row means never probed. That is why `state` has no
 * `UNCHECKED` value: inventing a row to record that nothing has happened makes
 * a never-checked panel indistinguishable from a checked one at a glance, which
 * is the mistake behind the legacy statistics screen counting CONFIGURED panels
 * and labelling them connected (RSV2-BR-021).
 */
export const panelHealth = pgTable(
  'panel_health',
  {
    panelId: uuid('panel_id')
      .primaryKey()
      .references(() => panels.id),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    state: text('state').notNull(),
    checkedAt: timestamptz('checked_at').notNull(),
    latencyMs: integer('latency_ms').notNull(),
    /** The normalized failure kind. NULL exactly when the state is HEALTHY or DEGRADED. */
    failure: text('failure'),
    /** The upstream HTTP status, when there was one. A number, never a body. */
    statusCode: integer('status_code'),
    providerVersion: text('provider_version'),
    /**
     * When this panel last answered successfully.
     *
     * Carried forward across failures on purpose: "unreachable, last worked
     * four minutes ago" and "unreachable, last worked in March" are the same
     * state and completely different problems.
     */
    lastHealthyAt: timestamptz('last_healthy_at'),
    /**
     * Consecutive probes that concluded an UNUSABLE state, reset to zero by any
     * probe that did not.
     *
     * Named for what it measures rather than `consecutive_failures`, and that is
     * deliberate: `panel_monitor_schedule` already has a column by that name whose
     * own docblock calls it "scheduler state, not health" and which is discarded
     * whenever the health row does not describe a failure. Two columns with one
     * name in one module, meaning different things and reset on different rules, is
     * how the wrong one comes to answer the question.
     *
     * UNUSABLE, not failing: `PANEL_UNUSABLE_HEALTH_STATES` is `UNREACHABLE` and
     * `AUTH_FAILED` only. A `DEGRADED` probe RESETS this, because that state means
     * the credentials were accepted and the panel is up — it is worrying, not
     * unusable, and a panel that is up must keep selling.
     *
     * Written by the same conditional upsert that guards `checked_at`, so a probe
     * whose answer arrives out of order cannot advance it.
     */
    unusableStreak: integer('unusable_streak').notNull().default(0),
    /**
     * The connection identity this probe ran against, or NULL for a row written
     * before the column existed.
     *
     * What `panels.status` may be enabled on the strength of. A test that
     * succeeded against one base URL, one activation and one set of credentials
     * says nothing about a different one, and an operator who fixes a password
     * after a green test must not be able to enable on the strength of the test
     * that preceded the fix.
     *
     * NOT `configurationFingerprint`, which exists for a different job — cancelling
     * an in-flight probe whose panel changed under it — and which includes `status`
     * and `updated_at`. Both of those move when a panel is enabled, so reusing it
     * here would invalidate every validation the moment it was acted on, and force
     * a fresh probe on every routine re-enable after maintenance.
     */
    validatedIdentity: text('validated_identity'),
  },
  (table) => [
    index('panel_health_tenant_idx').on(table.tenantId),
    /**
     * The pair, not the two halves.
     *
     * `panel_id` and `tenant_id` each had their own foreign key, which
     * constrained them individually and said nothing about them agreeing. A
     * row naming another tenant's panel satisfied both and violated the
     * invariant every query in the repository relies on.
     */
    foreignKey({
      columns: [table.tenantId, table.panelId],
      foreignColumns: [panels.tenantId, panels.id],
      name: 'panel_health_tenant_panel_fk',
    }),

    check('panel_health_state_check', enumCheck('state', PANEL_HEALTH_STATES)),
    check('panel_health_failure_check', nullableEnumCheck('failure', PROVIDER_FAILURE_KINDS)),
    /** A failing state names its failure; a succeeding one does not. */
    check(
      'panel_health_failure_presence_check',
      sql`(state IN ('HEALTHY', 'DEGRADED')) = (failure IS NULL)`,
    ),
  ],
);

/**
 * WP-A8: one panel's operator policy — which customer actions it offers, the extra
 * cooldowns and per-purchase caps it adds, and how its services are delivered.
 *
 * One row per panel and NO row for a panel nobody has configured, which reads as
 * `DEFAULT_PANEL_POLICY`: everything the adapter supports, no extra limit. The policy
 * is validated against `panelPolicySchema` at the application boundary, for the reason
 * `panels.activation` is — a CHECK constraint cannot hold a per-action shape — and a
 * row that does not parse is read as refusing every customer action on the panel,
 * never as allowing them.
 *
 * `revision` is what a write must name: the conditional UPDATE is `revision = expected`,
 * so two operators editing one panel's policy cannot overwrite each other unseen.
 */
export const panelPolicies = pgTable(
  'panel_policies',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    panelId: uuid('panel_id').notNull(),
    policy: jsonb('policy').notNull(),
    revision: integer('revision').notNull().default(1),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.panelId], name: 'panel_policies_pk' }),
    /** The pair, for the reason `panel_health_tenant_panel_fk` gives. */
    foreignKey({
      columns: [table.tenantId, table.panelId],
      foreignColumns: [panels.tenantId, panels.id],
      name: 'panel_policies_panel_fk',
    }),
    check('panel_policies_revision_check', sql`revision >= 1`),
    check('panel_policies_policy_check', sql`jsonb_typeof(policy) = 'object'`),
  ],
);

/**
 * A slot on a panel, held for one order while the customer decides whether to pay.
 *
 * Phase 6B. The alternative — counting services and comparing against the cap —
 * is wrong in exactly one place and it is the place that matters: between a
 * customer confirming an order and their payment settling there is no service
 * row, so two customers reaching for the last slot both count the same n-1 and
 * are both sold it. The row is what makes the last slot exclusive, and it exists
 * for precisely the window in which nothing else represents that customer's
 * claim on the panel.
 *
 * It is released the moment something else does represent it. Settlement writes
 * the service inside the same transaction that deletes this row, so the slot is
 * held continuously and counted once, never twice and never briefly by nobody.
 * Every other exit — the payment expiring, being rejected, the order cancelled —
 * deletes it and gives the slot back.
 *
 * DELETED rather than marked, and that is the design. A `RELEASED` state would
 * make the capacity query filter on it, and a query that must exclude rows is a
 * query one caller will forget to write that way; a row that is gone cannot be
 * counted by accident. What the release MEANT is in the audit trail and the
 * order's own history, which is where a reader looks for it anyway.
 */
export const panelCapacityReservations = pgTable(
  'panel_capacity_reservations',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    panelId: uuid('panel_id').notNull(),
    /**
     * The order this slot is being held for. UNIQUE, and that is the idempotency.
     *
     * A confirmation replayed by a retry, a double-tapped button or a second
     * replica collides here rather than taking a second slot from a panel that
     * may only have one left.
     */
    orderId: uuid('order_id').notNull(),
    /**
     * When this hold stops counting, whatever else has happened.
     *
     * The backstop for the release that never ran — a process killed between the
     * payment and the delete, a lane that lost its work. Without it an abandoned
     * checkout holds somebody else's slot until an operator notices, which on a
     * single-slot panel means the panel is full and nothing says why.
     *
     * The capacity query filters on this rather than a sweep deleting rows,
     * because a sweep is a process and this must be true without one running.
     */
    expiresAt: timestamptz('expires_at').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    /** A child row may not name another tenant's panel. */
    foreignKey({
      columns: [table.tenantId, table.panelId],
      foreignColumns: [panels.tenantId, panels.id],
      name: 'panel_capacity_reservations_tenant_panel_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
      name: 'panel_capacity_reservations_order_fk',
    }),
    /** One slot per order. The collision IS the replay defence. */
    uniqueIndex('panel_capacity_reservations_order_key').on(table.tenantId, table.orderId),
    /**
     * The counting scan: for ONE panel, the holds that have not expired.
     *
     * Leads with the panel because that is what capacity is asked about, and
     * carries `expires_at` so the predicate is served by the same index rather
     * than by a filter over every hold the panel has ever taken.
     */
    index('panel_capacity_reservations_panel_idx').on(
      table.tenantId,
      table.panelId,
      table.expiresAt,
    ),
  ],
);

/**
 * A service username somebody is in the middle of buying.
 *
 * The hold that stops two customers paying for one name. It exists because the
 * decision moved: a username used to be derived from the service id — minted after the
 * money, unique by construction, impossible to contend for — and a customer-chosen or
 * template-rendered name is none of those things. It is chosen BEFORE the payment, and
 * between that choice and the provider account there is a window in which the name
 * belongs to nobody unless a row says otherwise.
 *
 * ## Why this is not `panel_capacity_reservations` with a different column
 *
 * The lifecycles differ where it matters most, and `docs/phase6c-audit.md` A-6 records
 * the difference: capacity is freed by `expires_at` so an abandoned checkout cannot
 * hold a slot for ever, and **a funded username must never be freed that way**. A TTL
 * that expired a paid name would let a second customer reserve a name the first already
 * has an account for on the panel — two services, one provider account, and the usage
 * figures of both meaningless.
 *
 * So `funded_at` is the switch. While it is null the row is an abandoned checkout and
 * `expires_at` may reap it; once it is set the row is protected until the order reaches
 * a terminal outcome — FULFILLED, which consumes the name into
 * `services.provider_username`, or REFUNDED, which releases it. An `UNRECONCILED`
 * service is neither: the remote account may exist, so the name stays held.
 *
 * ## Why the key is a namespace rather than a panel
 *
 * `services_panel_provider_username_key` is per panel, and two panel rows may point at
 * the same provider host — `panels` constrains only the name, never `base_url`. Those
 * panels share one account namespace, so a per-panel hold would let two customers
 * reserve one name on one real panel. `namespace_key` is derived from the provider type
 * and the normalised host and port, so they contend as they should.
 *
 * A definitive conflict that survives both — an account an operator made by hand — is a
 * definitive non-delivery and follows the money rules. It is never adopted.
 */
/**
 * The window in which an ordinary message means "this is my username".
 *
 * Modelled on `receipt_captures` deliberately, down to the partial unique index,
 * because it answers the same dangerous question: when may a plain message the customer
 * typed be read as an answer rather than as conversation? The legacy system answered it
 * with a stateful prompt that outlived its question and overwrote a production gateway
 * setting with somebody's ordinary message (INCIDENT-FIN-001).
 *
 * Two things bound the damage, and neither is the deadline. First, the window is a ROW:
 * it is explicit, it has an owner, and a redelivered message either finds it or does
 * not. Second, and more important, the only thing an open window can DO is validate a
 * name against the one draft order it names, for the one customer it names. There is no
 * branch in which it reaches a setting, a payment or another order — so even a window
 * that outlived its question is confined to the question.
 */
export const usernameCaptures = pgTable(
  'username_captures',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** WHICH bot, for the reason `receipt_captures.bot_instance_id` states. */
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    customerId: uuid('customer_id').notNull(),
    orderId: uuid('order_id').notNull(),
    openedAt: timestamptz('opened_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at').notNull(),
    /** Null while open. The partial unique index below is keyed on exactly this. */
    closedAt: timestamptz('closed_at'),
    closeReason: text('close_reason'),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'username_captures_customer_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
      name: 'username_captures_order_fk',
    }),
    /**
     * ONE open window per customer per bot, decided by the database.
     *
     * Two taps on two different drafts arriving together both read "nothing open", and
     * the name the customer then types attaches to whichever row the planner returns
     * first — a username reserved against an order they were not looking at, on a panel
     * they were not buying from.
     */
    uniqueIndex('username_captures_open_key')
      .on(table.tenantId, table.botInstanceId, table.customerId)
      .where(sql`closed_at IS NULL`),
    /** The sweep's index: windows past their deadline that nobody has closed. */
    index('username_captures_due_idx')
      .on(table.tenantId, table.expiresAt)
      .where(sql`closed_at IS NULL`),
    check(
      'username_captures_close_reason_check',
      nullableEnumCheck('close_reason', USERNAME_CAPTURE_CLOSE_REASONS),
    ),
    /** A closed window has a reason, and an open one has neither. Both halves. */
    check('username_captures_closed_check', sql`(closed_at IS NULL) = (close_reason IS NULL)`),
    check('username_captures_expiry_check', sql`expires_at > opened_at`),
  ],
);

export const serviceUsernameReservations = pgTable(
  'service_username_reservations',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /**
     * The provider account namespace this name is held in.
     *
     * Derived, not entered: `<provider_type>:<host>[:<port>]`, lowercased. Stored rather
     * than computed at query time so the unique index below can be a plain index on a
     * column, and so a panel whose address is later edited does not silently move every
     * hold it took.
     */
    namespaceKey: text('namespace_key').notNull(),
    username: text('username').notNull(),
    panelId: uuid('panel_id').notNull(),
    orderId: uuid('order_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    /** Which mode produced it, so an audit can tell a typed name from a rendered one. */
    mode: text('mode').notNull(),
    /**
     * When the money for this name committed, or null while the checkout is unfunded.
     *
     * The single field that decides whether `expires_at` may reap this row. See the
     * table docblock: a TTL that frees a funded name is two services on one account.
     */
    fundedAt: timestamptz('funded_at'),
    /**
     * The backstop for an abandoned checkout, and ONLY for one.
     *
     * Every query that treats a row as held must also require `funded_at IS NOT NULL OR
     * expires_at > now()`. Expiry alone is not release: a funded row past its expiry is
     * still held, which is the whole difference from the capacity table.
     */
    expiresAt: timestamptz('expires_at').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.panelId],
      foreignColumns: [panels.tenantId, panels.id],
      name: 'service_username_reservations_tenant_panel_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
      name: 'service_username_reservations_order_fk',
    }),
    /**
     * One name per namespace, and the collision IS the refusal.
     *
     * Deliberately NOT scoped by tenant: two tenants pointing at one provider host
     * share its account namespace whether or not they know about each other, and a name
     * one of them created is a name the other cannot have. The row exposes nothing
     * across the boundary — a caller learns only that the name is unavailable, which is
     * the same answer the provider would eventually give.
     */
    uniqueIndex('service_username_reservations_name_key').on(table.namespaceKey, table.username),
    /** One name per order. A duplicate callback finds its own row rather than taking a second. */
    uniqueIndex('service_username_reservations_order_key').on(table.tenantId, table.orderId),
    /** The reaper's scan: unfunded holds that have run out. */
    index('service_username_reservations_expiry_idx').on(table.fundedAt, table.expiresAt),
    check('service_username_reservations_mode_check', enumCheck('mode', SERVICE_USERNAME_MODES)),
  ],
);

/**
 * One row per panel: the last time a connection test was allowed to start, and
 * what the panel looked like when it was.
 *
 * Separate from `panel_health` on purpose. Health is the RESULT of a probe and
 * a probe result is the only thing allowed to change it; a claim is the
 * permission to make one. Folding the claim into the health row would mean
 * writing to health without a probe, and would need a health row to exist
 * before a panel has ever been tested — a fabricated state, which
 * `UNCHECKED` deliberately is not.
 *
 * `configuration` is a digest of the panel's address, status and the three
 * credential-set timestamps. Never a credential and never a URL: a claim row
 * is not a place to keep a copy of the configuration, only a way to tell one
 * configuration from another.
 */
export const panelProbeClaims = pgTable(
  'panel_probe_claims',
  {
    panelId: uuid('panel_id')
      .primaryKey()
      .references(() => panels.id),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** sha256 of the configuration identity. Opaque, and comparable. */
    configuration: text('configuration').notNull(),
    /** When the probe that holds this claim STARTED, not when it finished. */
    claimedAt: timestamptz('claimed_at').notNull(),
  },
  (table) => [
    index('panel_probe_claims_tenant_idx').on(table.tenantId),
    foreignKey({
      columns: [table.tenantId, table.panelId],
      foreignColumns: [panels.tenantId, panels.id],
      name: 'panel_probe_claims_tenant_panel_fk',
    }),
  ],
);

/**
 * One row per tenant: how many real outbound provider probes it may still
 * make right now.
 *
 * A token bucket, refilled continuously: `tokens` as of `refilled_at`, and the
 * take that reads it adds what has accrued since, caps at the capacity, and
 * subtracts one — in ONE statement under the row lock, so two API processes
 * racing for the last token cannot both get it. The capacity and the refill
 * rate are configuration, not columns; the row holds only what cannot be
 * recomputed.
 *
 * Nothing about any panel is here — no address, no name, no configuration —
 * and that is the point: the per-panel cooldown is deliberately reset by a
 * configuration change, and this bound is deliberately not.
 */
export const panelProbeBudgets = pgTable(
  'panel_probe_budgets',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id),
    /** Whole and fractional tokens; fractional because refill is continuous. */
    tokens: doublePrecision('tokens').notNull(),
    /** When `tokens` was last true. Refill is computed forward from here. */
    refilledAt: timestamptz('refilled_at').notNull(),
  },
  () => [check('panel_probe_budgets_tokens_check', sql`tokens >= 0`)],
);

/**
 * When the background monitor may next consider a panel, and why not sooner.
 *
 * SCHEDULING state, deliberately separate from `panel_health`. Health is the
 * latest thing a provider actually said; this is the loop's own bookkeeping,
 * and conflating them cost us twice in the first Phase 3C design. A scheduler
 * column on the health row meant a panel with no health row had no schedule
 * either, so a panel that could never be probed — no credential, a refused
 * address — was rediscovered on every tick for ever and occupied its tenant's
 * slot while doing nothing. And it meant the only way to defer such a panel was
 * to invent a health row saying something no provider had said.
 *
 * Nothing here is a secret and nothing here is provider output. A row is three
 * timestamps, a counter and an enum naming why the loop stepped back. There is
 * no column a credential, a cookie, a CSRF token or a response body could go
 * into.
 *
 * One row per panel, created with the panel and kept in step with it by the
 * same transactions that write the panel: creating, updating, re-crediting or
 * re-enabling a panel makes it eligible at once, and disabling or archiving one
 * makes it eligible never (`'infinity'`). That is what keeps the discovery scan
 * honest — a `DISABLED` panel is not skipped by the query, it is not in the
 * range the query reads.
 */
export const panelMonitorSchedule = pgTable(
  'panel_monitor_schedule',
  {
    panelId: uuid('panel_id')
      .primaryKey()
      .references(() => panels.id),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /**
     * The earliest moment the monitor may consider this panel.
     *
     * `'infinity'` for a panel that is not ACTIVE. A finite time in the past
     * means due now. Every cadence, backoff and deferral decision lands here,
     * so the discovery query is one range scan and never a CASE over policy.
     */
    nextEligibleAt: timestamptz('next_eligible_at').notNull(),
    /**
     * Consecutive FAILED probes, for backoff. Scheduler state, not health.
     *
     * Read together with the health row and discarded when that row does not
     * describe a failure — an older release that predates this table can
     * complete a successful manual probe, write only the health row, and leave
     * this counter behind; inheriting it would back a working panel off as if
     * it had been failing all along.
     */
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    /**
     * Why the loop last stepped back, when it did so without probing.
     *
     * Operational, and an enum rather than free text: a panel with no
     * credential and a panel whose address the policy refuses are different
     * operator jobs, and neither is a statement about what the provider said.
     */
    deferredReason: text('deferred_reason'),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (table) => [
    /**
     * The discovery scan, and the reason it is bounded.
     *
     * `(tenant_id, next_eligible_at, panel_id)` is read as a range: for ONE
     * tenant, the earliest eligible panels, `LIMIT n`. The planner walks n
     * index entries and stops. The previous design ranked every due panel on
     * the installation with a window function and then took fifty of them,
     * which is work proportional to the backlog on every tick.
     *
     * `panel_id` is in the index for the tiebreaker, and it is not decoration.
     * The scan orders by `(next_eligible_at, panel_id)` so the order is total
     * and stable; without the second column the index supplies only the first
     * key and PostgreSQL must sort every row that TIES on it before it can take
     * five. Ties are not hypothetical — a migration backfill and a mass
     * re-enable both make a tenant's whole fleet eligible at the same instant —
     * and the plan regression test measured exactly that: five hundred rows
     * read to return five. With the tiebreaker in the index there is no sort at
     * all.
     */
    index('panel_monitor_schedule_due_idx').on(table.tenantId, table.nextEligibleAt, table.panelId),
    /**
     * The pair, not the two halves — the same rule `panel_health` follows. Two
     * separate foreign keys would let a row name panel A while claiming tenant
     * B, and this row decides which tenant's fairness slot a panel occupies.
     */
    foreignKey({
      columns: [table.tenantId, table.panelId],
      foreignColumns: [panels.tenantId, panels.id],
      name: 'panel_monitor_schedule_tenant_panel_fk',
    }),
    check(
      'panel_monitor_schedule_deferred_reason_check',
      nullableEnumCheck('deferred_reason', MONITOR_DEFERRAL_REASONS),
    ),
  ],
);

/**
 * One row per tenant: when this tenant last had a turn, and the earliest its
 * panels might be eligible.
 *
 * The fairness mechanism, and it is a table rather than a cursor in a process
 * because a cursor in a process is wrong the moment there are two processes —
 * and there being two, briefly, is what a rolling update is.
 *
 * A tick claims the least-recently-served due tenants with
 * `FOR UPDATE SKIP LOCKED`, so two monitor replicas take DISJOINT tenant sets
 * rather than racing over one. Every claimed tenant's `last_served_at` moves,
 * which is what bounds the wait: with `t` tenants claimed per tick and `d` due
 * tenants, no tenant waits longer than `ceil(d / t)` ticks. That bound holds
 * whatever the backlog inside any one tenant is, which is the property that a
 * global "oldest first" ordering cannot offer at all.
 *
 * `next_eligible_at` here is a LOWER BOUND on the tenant's earliest eligible
 * panel, never an exact minimum. Keeping it exact would mean recomputing a MIN
 * on every schedule write; keeping it a lower bound means one cheap
 * `LEAST(...)` on the write path, and a claim that finds nothing due repairs
 * the bound from the index it just read. Stale-low costs one wasted claim;
 * stale-high would lose a tenant, so the direction is chosen deliberately.
 */
export const panelMonitorTenants = pgTable(
  'panel_monitor_tenants',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id),
    /** A lower bound on this tenant's earliest eligible panel. Never later than the truth. */
    nextEligibleAt: timestamptz('next_eligible_at').notNull(),
    /**
     * When this tenant last had a turn. The rotation order, and the claim's
     * turn token: every claim moves it STRICTLY forward, so a turn spent under
     * a concurrent claim never compares equal to the snapshot that claim
     * ordered by (`claimTenantsQuery`).
     */
    lastServedAt: timestamptz('last_served_at').notNull(),
  },
  (table) => [
    /**
     * The claim: due tenants, least recently served first.
     *
     * One row per TENANT, so this scan is bounded by how many tenants an
     * installation has — tens, on the deployment model this repository
     * produces — and not by how many panels are due, which is the number that
     * grows.
     */
    index('panel_monitor_tenants_rotation_idx').on(table.nextEligibleAt, table.lastServedAt),
  ],
);

/**
 * One row per backup run, and the row IS the installation's backup lock.
 *
 * INSTALLATION-scoped, so there is deliberately no `tenant_id`. A dump is of
 * the whole database; giving it a tenant column would invite a per-tenant
 * backup that this pipeline does not produce and cannot restore.
 *
 * The exclusivity is `backup_runs_single_active_idx`, a partial unique index on
 * a constant over `state = 'RUNNING'`. One RUNNING row can exist in the whole
 * table, enforced by PostgreSQL rather than by any process — which is the only
 * form of "one at a time" that survives two worker replicas, which is the
 * normal case on every rolling update. An in-memory flag would have bounded
 * exactly one process, and a `pg_advisory_xact_lock` would have to be held for
 * the length of a dump inside a transaction that `idle_in_transaction_session_
 * timeout` is configured to kill.
 *
 * A lock nothing can release is a lock that outlives its owner's crash, so the
 * claim is a LEASE: `lease_owner` names the process, `lease_heartbeat_at` is
 * refreshed while it works, and a run whose heartbeat has gone stale may be
 * taken over — by transitioning it to FAILED, never by silently adopting it,
 * because its temporary files belong to a process that may still be writing.
 *
 * Nothing here holds key material. `checksum` is a digest of the plaintext
 * dump, which is not a secret and is what makes the artifact verifiable later.
 * `delivery_detail` and `failure_message` carry redacted operator-facing text;
 * the bot token they could otherwise leak lives in the URL path of the Telegram
 * call and never reaches this table.
 */
export const backupRuns = pgTable(
  'backup_runs',
  {
    /** UUIDv7. This is the backup id in the manifest and in the caption. */
    id: uuid('id').primaryKey(),
    trigger: text('trigger').notNull(),
    state: text('state').notNull(),
    /** The stage in flight, or — once terminal — the stage the run ended in. */
    stage: text('stage').notNull(),
    startedAt: timestamptz('started_at').notNull(),
    finishedAt: timestamptz('finished_at'),

    /**
     * Who holds the lease and when they last proved it.
     *
     * `lease_owner` is a process identity, not a credential: role plus PID plus
     * a random suffix, so two replicas of the same role are distinguishable.
     */
    leaseOwner: text('lease_owner').notNull(),
    leaseHeartbeatAt: timestamptz('lease_heartbeat_at').notNull(),

    /** Bytes of the plaintext dump, and of the encrypted archive. */
    dumpBytes: bigint('dump_bytes', { mode: 'bigint' }),
    archiveBytes: bigint('archive_bytes', { mode: 'bigint' }),
    /** SHA-256 of the plaintext dump, lowercase hex. Not a secret. */
    checksum: text('checksum'),
    /**
     * When a real pg_restore into a real empty scratch database succeeded.
     *
     * Null on any run that did not get that far, which is what makes
     * "verified" a fact rather than an inference from `state`.
     */
    verifiedAt: timestamptz('verified_at'),

    /**
     * What we know about the Telegram delivery. See BACKUP_DELIVERY_STATES.
     *
     * `OUTCOME_UNKNOWN` is durable and nothing resends on it automatically.
     */
    deliveryState: text('delivery_state').notNull(),
    deliveryAttemptedAt: timestamptz('delivery_attempted_at'),
    /** Redacted operator-facing detail. Never a token, never a chat payload. */
    deliveryDetail: text('delivery_detail'),

    /** Set on FAILED. The stage is in `stage`; this says what went wrong. */
    failureCode: text('failure_code'),
    failureMessage: text('failure_message'),

    /**
     * Whether cleanup completed, and what was left behind if not.
     *
     * A column rather than a log line because a cleanup failure means plaintext
     * dump bytes are still on disk, or a scratch database still exists. Both
     * are things an operator must be told about explicitly; neither is visible
     * from a run that otherwise reports success.
     */
    cleanupOk: boolean('cleanup_ok').notNull(),
    cleanupDetail: text('cleanup_detail'),
  },
  (table) => [
    check('backup_runs_trigger_check', enumCheck('trigger', BACKUP_TRIGGERS)),
    check('backup_runs_state_check', enumCheck('state', BACKUP_RUN_STATES)),
    check('backup_runs_stage_check', enumCheck('stage', BACKUP_STAGES)),
    check('backup_runs_delivery_state_check', enumCheck('delivery_state', BACKUP_DELIVERY_STATES)),
    /**
     * A terminal run has an end; a RUNNING one does not.
     *
     * Both directions, because only one of them is the interesting failure: a
     * RUNNING row with `finished_at` set is a run something forgot to close,
     * and it would hold the installation's lock until its lease expired.
     */
    check('backup_runs_finished_at_check', sql`(state = 'RUNNING') = (finished_at IS NULL)`),
    /**
     * The installation-wide backup lock, enforced by the database.
     *
     * A partial unique index over a constant: at most one row may have
     * `state = 'RUNNING'`, whatever process inserted it. A second starter's
     * INSERT raises a unique violation, which the repository turns into a
     * truthful BUSY rather than a second dump.
     */
    uniqueIndex('backup_runs_single_active_idx')
      .on(sql`(true)`)
      .where(sql`state = 'RUNNING'`),
    /** The operator's list, and the scheduler's "when did we last succeed". */
    index('backup_runs_started_at_idx').on(table.startedAt),
  ],
);

/**
 * A recovery request: one attempt to make this installation be a backup again.
 *
 * Separate from `backup_runs` on purpose, and `docs/disaster-recovery-audit.md`
 * § MISSING-2 records the reasoning: a backup run is an artifact's history and a
 * recovery request is an operation against the installation, and the backup
 * lock is a partial unique index over `state = 'RUNNING'` that a recovery row
 * would contend with for no reason.
 *
 * `tenant_id NOT NULL` even though a backup covers every tenant. A backup is a
 * dump of the whole database, so "which tenant may act on it" has one
 * defensible answer — the tenant that IS the installation — and making that a
 * column rather than a convention is what turns cross-scope isolation into a
 * row-level predicate a test can guess against.
 */
export const recoveryRequests = pgTable(
  'recovery_requests',
  {
    /** UUIDv7. Appears in a URL, a confirmation binding and a journal file. */
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    source: text('source').notNull(),
    state: text('state').notNull(),
    stage: text('stage').notNull(),
    createdAt: timestamptz('created_at').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
    finishedAt: timestamptz('finished_at'),

    /**
     * Who asked, captured as a label at the time.
     *
     * A label as well as an id, so the row still names somebody after a rename
     * or a deletion — the same rule the audit log follows, and for the same
     * reason: a recovery is read long after the fact.
     */
    requestedByAdminId: uuid('requested_by_admin_id'),
    requestedByLabel: text('requested_by_label'),
    correlationId: text('correlation_id'),

    /**
     * The lease, exactly as `backup_runs` holds one.
     *
     * A recovery outlives any request, and two executor replicas are the normal
     * case on a rolling update. A stale lease is taken over by FAILING the
     * abandoned request, never by adopting it: its candidate database and its
     * workspace belong to a process that may still be writing them.
     */
    leaseOwner: text('lease_owner'),
    leaseHeartbeatAt: timestamptz('lease_heartbeat_at'),

    /**
     * Where the uploaded bytes live while this request is alive.
     *
     * A path on the installation's own disk, under `RECOVERY_WORK_DIR`, with a
     * random directory name. Recorded so a crashed executor's debris is
     * nameable; removed on every terminal path. Not a secret, and not derived
     * from anything a caller sent.
     */
    workspacePath: text('workspace_path'),
    /** Bytes received, and the digest of the ENCRYPTED container as received. */
    uploadBytes: bigint('upload_bytes', { mode: 'bigint' }),
    uploadSha256: text('upload_sha256'),
    /**
     * What the browser called the file. Recorded, and acted on NOWHERE.
     *
     * Not the path, not the format decision, not the content type. It exists so
     * an operator can recognise which file they sent, and it is bounded and
     * sanitised before storage because it is attacker-chosen text that gets
     * rendered.
     */
    clientFilename: text('client_filename'),

    /** From the manifest, once the archive has been authenticated. */
    backupId: uuid('backup_id'),
    artifactChecksum: text('artifact_checksum'),
    archiveKeyId: text('archive_key_id'),
    verifiedAt: timestamptz('verified_at'),
    /** The verification and restore-test facts, as recorded. */
    verification: jsonb('verification'),
    restoreTest: jsonb('restore_test'),

    /**
     * The confirmation BINDING. The phrase itself is never stored.
     *
     * The phrase is a constant, so storing it would prove nothing; what has to
     * be durable is what the confirmation was for. `confirmed_checksum` is
     * re-compared against the artifact at execution time, which is what makes a
     * confirmation for backup A unable to restore backup B.
     */
    confirmedAt: timestamptz('confirmed_at'),
    confirmedByAdminId: uuid('confirmed_by_admin_id'),
    confirmedSessionId: uuid('confirmed_session_id'),
    confirmedChecksum: text('confirmed_checksum'),
    confirmationExpiresAt: timestamptz('confirmation_expires_at'),

    /** The mandatory pre-restore backup of the installation being replaced. */
    preRestoreBackupId: uuid('pre_restore_backup_id'),

    /**
     * The candidate database, and the name the outgoing one was renamed to.
     *
     * `displaced_database` is the single most important field on this row after
     * a cutover: it is how an operator knows production is the new database and
     * where the old one still is. Not a secret — it is a database name on their
     * own server — and without it a manual rollback is guesswork.
     */
    candidateDatabase: text('candidate_database'),
    displacedDatabase: text('displaced_database'),
    cutoverAt: timestamptz('cutover_at'),

    /** A value from `RECOVERY_FAILURE_CODES`. Never a message. */
    failureCode: text('failure_code'),
  },
  (table) => [
    check('recovery_requests_source_check', enumCheck('source', RECOVERY_SOURCES)),
    check('recovery_requests_state_check', enumCheck('state', RECOVERY_STATES)),
    check('recovery_requests_stage_check', enumCheck('stage', RECOVERY_STAGES)),
    check(
      'recovery_requests_failure_code_check',
      nullableEnumCheck('failure_code', RECOVERY_FAILURE_CODES),
    ),
    /**
     * A terminal request has an end; a live one does not. Both directions.
     *
     * The interesting failure is the second: a live request with `finished_at`
     * set is a request something forgot to close, and while it is in a
     * quiescing state it is holding the installation's writes shut.
     */
    check(
      'recovery_requests_finished_at_check',
      sql`(state IN ('SUCCEEDED', 'FAILED')) = (finished_at IS NOT NULL)`,
    ),
    /**
     * A cutover implies a displaced database. NOT the reverse.
     *
     * These two are how an operator learns which database is production, and the
     * dangerous direction is the one this refuses: `cutover_at` set with no
     * displaced name is a row saying production is the restored candidate and not
     * saying where the data it replaced went.
     *
     * The reverse IS representable, because it is a state the cutover genuinely
     * reaches. `ALTER DATABASE` cannot run in a transaction, so between the two
     * renames the outgoing database has MOVED and the candidate has not taken its
     * name — `CutoverError.outgoingRenamed`, journal phase `RENAMED_OUT`. A
     * recovery that ends there has a displaced database and no cutover, and both
     * reconstruction paths in `recovery-executor.ts` write exactly that row: the
     * failure path in `execute`, and `reconcileCutovers` for a journal nothing
     * recorded. The first version of this check made both of those rows
     * unrepresentable, so the reconstruction raised 23514 — which left the
     * recovery unrecorded, the journal uncleared, and every later tick throwing
     * in `reconcileCutovers` before it could claim anything at all.
     *
     * `purgeFinishedBefore` keeps a row with either field set, so the name of the
     * database holding the operator's previous data survives retention in both
     * shapes.
     */
    check(
      'recovery_requests_cutover_check',
      sql`cutover_at IS NULL OR displaced_database IS NOT NULL`,
    ),
    /**
     * A confirmation is all four fields or none of them.
     *
     * The binding is the security property, so a partial binding must not be
     * representable: a row with `confirmed_at` and no `confirmed_checksum`
     * would be a confirmation for anything.
     */
    check(
      'recovery_requests_confirmation_check',
      sql`num_nonnulls(confirmed_at, confirmed_by_admin_id, confirmed_checksum, confirmation_expires_at) IN (0, 4)`,
    ),
    /**
     * ONE destructive recovery at a time, enforced by PostgreSQL.
     *
     * A partial unique index over a constant, exactly like the backup lock. Two
     * executor replicas is the normal case on every rolling update and two
     * operators pressing at once is the normal case in an incident; neither has
     * to agree with the other about anything, because the second INSERT or
     * UPDATE raises a unique violation.
     *
     * The predicate is the DESTRUCTIVE state set, not the live one: an
     * artifact being verified or restore-tested changes nothing about the
     * installation, so several of those at once are fine and only the chain
     * past the confirmation is exclusive.
     */
    uniqueIndex('recovery_requests_single_destructive_idx')
      .on(sql`(true)`)
      .where(
        sql.raw(
          `state IN (${RECOVERY_ACTIVE_DESTRUCTIVE_STATES.map((state) => `'${state}'`).join(', ')})`,
        ),
      ),
    /**
     * The operator's list keyset: `(tenant_id, created_at, id)`, scope first.
     *
     * Declared HERE and not in `ONLINE_INDEXES`, unlike the panels and alerts
     * keysets, and the difference is the table rather than the index. Those build
     * concurrently because `botctl update` migrates while the outgoing release is
     * still serving, so an ordinary `CREATE INDEX` lands a SHARE lock on a live
     * table. This table is CREATED by the same migration: there is no live data
     * to lock and nothing else can see it yet, so the build is instant and
     * drizzle-kit's drift check can see the index — which the online ones
     * deliberately cannot.
     *
     * `id` is in the index because it is in the ORDER BY. A btree serves the
     * DESC scan of an ASC index backwards, so this one index covers both the
     * ordering and the `ROW(created_at, id) < ROW(...)` continuation.
     */
    index('recovery_requests_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
  ],
);

/**
 * Decrypt-only key-encryption keys imported from a Recovery Kit (ADR-0032).
 *
 * INSTALLATION-WIDE, and the one table here with neither `tenant_id` nor a
 * tenant-bound encryption context, for a reason that is the whole point of it:
 * it must SURVIVE a restore. A restore replaces every tenant row with the
 * backup's, so a key bound to the current primary tenant would be bound to a
 * tenant that no longer exists the moment it was needed. The recovery executor
 * carries these rows into the restored candidate before the cutover, exactly as
 * it re-asserts its own request row afterwards.
 *
 * `wrapped_material` is the key, AES-256-GCM-wrapped under a CONFIGURED key
 * (`wrapped_under_key_id`) with the key id and the wrapping id as associated
 * data. Deliberately not named `*_ciphertext`: that suffix marks a
 * `SecretCipher` column, which this is not (see `installation-keyring.ts`), and
 * `secrets status|rewrap|retire-check` walk this table by name instead.
 *
 * Nothing here can make a key ENCRYPT. Which key encrypts is
 * `SECRETS_ACTIVE_KEY_ID`, and this table has no column that could say
 * otherwise.
 */
export const installationKeys = pgTable(
  'installation_keys',
  {
    id: uuid('id').primaryKey(),
    /** The key's label, unique across the installation. Never a configured key's id. */
    keyId: text('key_id').notNull(),
    /** `kekFingerprint` of the key. Safe to show; compared on every unwrap. */
    fingerprint: text('fingerprint').notNull(),
    /**
     * The wrapped key. NULL exactly when the row is a TOMBSTONE: removal erases
     * the bytes and keeps the row, so a restore of an older backup — which still
     * holds this key — cannot quietly bring it back (the executor carries the
     * tombstone into the candidate).
     */
    wrappedMaterial: text('wrapped_material'),
    /** Which CONFIGURED key wraps it — what `secrets retire-check` counts. NULL on a tombstone. */
    wrappedUnderKeyId: text('wrapped_under_key_id'),
    source: text('source').notNull(),
    /** The kit it arrived in. An identifier, never the kit. */
    kitId: uuid('kit_id'),
    importedAt: timestamptz('imported_at').notNull(),
    /** Captured as a label too, so the row still names somebody after a restore. */
    importedByAdminId: uuid('imported_by_admin_id'),
    importedByLabel: text('imported_by_label'),
    /** Set by removal; the row is then a tombstone. Cleared only by a later import. */
    removedAt: timestamptz('removed_at'),
    removedByLabel: text('removed_by_label'),
    /**
     * Set by the recovery executor on a row the CANDIDATE held and this
     * installation did not: a key that came back inside a restored backup rather
     * than through an import here. Shown in the list, and audited at the cutover.
     */
    restoredAt: timestamptz('restored_at'),
  },
  (table) => [
    uniqueIndex('installation_keys_key_id_idx').on(table.keyId),
    check('installation_keys_source_check', enumCheck('source', INSTALLATION_KEY_SOURCES)),
    check('installation_keys_key_id_check', sql`key_id ~ '^[A-Za-z0-9._-]{1,64}$'`),
    check('installation_keys_fingerprint_check', sql`fingerprint ~ '^[0-9a-f]{32}$'`),
    check(
      'installation_keys_wrapped_under_check',
      sql`wrapped_under_key_id IS NULL OR (wrapped_under_key_id ~ '^[A-Za-z0-9._-]{1,64}$' AND wrapped_under_key_id <> key_id)`,
    ),
    /** A live row has its wrap; a tombstone has neither half of it. Both directions. */
    check(
      'installation_keys_tombstone_check',
      sql`(removed_at IS NULL) = (wrapped_material IS NOT NULL) AND (wrapped_material IS NULL) = (wrapped_under_key_id IS NULL)`,
    ),
    index('installation_keys_wrapped_under_idx').on(table.wrappedUnderKeyId),
  ],
);

export const schema = {
  tenants,
  botInstances,
  admins,
  roles,
  rolePermissions,
  adminRoles,
  adminPermissionOverrides,
  adminSessions,
  adminLoginThrottle,
  outboxMessages,
  processedMessages,
  requestIdempotency,
  auditLogs,
  operationalEvents,
  aggregateSequences,
  templateOverrides,
  templateRevisions,
  settingValues,
  featureFlagStates,
  notifications,
  notificationDeliveryAttempts,
  notificationReleasedClaims,
  panels,
  panelCredentials,
  panelHealth,
  panelProbeClaims,
  panelProbeBudgets,
  panelMonitorSchedule,
  panelMonitorTenants,
  backupRuns,
  recoveryRequests,
};

/** Tables the database itself refuses to UPDATE or DELETE. */
export const APPEND_ONLY_TABLES = [
  'audit_logs',
  'processed_messages',
  'template_revisions',
  'notification_delivery_attempts',
  // Load-bearing accounting, not just evidence: spend is `attempt_count` minus
  // these rows, so deleting one silently spends an attempt that was handed
  // back and adding one silently returns an attempt that was not.
  'notification_released_claims',
] as const;

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
     * Customer 360 (§11.4): when an operator exempted this customer from MANDATORY channel
     * membership; NULL while the gate applies to them. Read by the Telegram gate itself
     * (`BotRuntime.guardedAct`) from the row it resolves on every update — not a Web Admin
     * decoration. Set and cleared only by `CustomerControlService`, conditionally.
     */
    channelMembershipExemptAt: timestamptz('channel_membership_exempt_at'),
    /**
     * Customer 360 (§11.4): a phone number an OPERATOR verified out of band, and when. The
     * bot never asks for one. Both or neither (`customers_phone_check`), so a number is
     * never stored without the verification that justified storing it.
     */
    phoneNumber: text('phone_number'),
    phoneVerifiedAt: timestamptz('phone_verified_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
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
    check('customers_phone_check', sql`(phone_number IS NULL) = (phone_verified_at IS NULL)`),
    check(
      'customers_phone_format_check',
      sql`phone_number IS NULL OR phone_number ~ '^[+][1-9][0-9]{7,14}$'`,
    ),
    /** The target of the composite references the child tables use. */
    unique('customers_tenant_id_key').on(table.tenantId, table.id),
  ],
);

/**
 * A product — one sellable plan.
 *
 * `price_amount` and `price_currency` are NULLABLE together, and that is the
 * "do not invent a value" rule expressed in DDL: a tenant that has not priced a plan
 * has an unpriced plan, not a free one. `PRODUCT_NOT_PRICED` is the refusal, and it
 * fires at order confirmation where an operator can read it.
 *
 * `panel_id` is nullable for the same reason: a product an operator is still
 * configuring cannot be fulfilled, and the honest encoding of that is an absent
 * panel rather than a pointer to an arbitrary one.
 */
/**
 * A group a customer browses before they browse products.
 *
 * Tenant-scoped like everything a tenant owns, and it carries the same two dimensions a
 * product does — `status` and `visibility` — for the reason `catalog.ts` gives: a
 * category with its own vocabulary would be a second way to say "stop selling this",
 * and two vocabularies for one idea disagree the first time somebody edits only one.
 *
 * `emoji` is nullable and ordinary when absent. It is short text with a CHECK that
 * bounds its length and refuses control characters, and deliberately no check that it
 * IS an emoji — `isValidCategoryEmoji` says why, and the short version is that the
 * stronger check is an icon library wearing a regex.
 *
 * There is no `is_empty` column and no product counter. An empty category is one with no
 * customer-visible product in it, which is a property of the products, and a cached
 * count is a second answer to that question that goes stale the moment a product is
 * deactivated. `nexa-conventions` has the same rule about balances for the same reason.
 */
/**
 * The control characters a rendered label may not contain, as a PostgreSQL regex.
 *
 * Built from code points rather than written as a literal, because writing the class
 * inline in a template literal is how the first version of this constraint shipped
 * broken: TypeScript interpreted the `\u` escapes and `drizzle-kit` wrote the resulting
 * RAW CONTROL CHARACTERS into the migration file, producing a constraint no reviewer
 * could read and a `.sql` file carrying a literal DEL byte. Caught by reading the
 * generated SQL, which is the artifact under review.
 *
 * `U&'...'` is PostgreSQL's Unicode string literal syntax, so the escapes are resolved
 * by the SERVER from text that stays ASCII all the way through the file.
 *
 * NUL is deliberately absent: PostgreSQL `text` cannot hold one at all, so a term for it
 * would be a check against a value the type system already refuses.
 */
const CONTROL_CHARACTER_CLASS = String.raw`U&'[\0001-\001f\007f\0085\2028\2029]'`;

export const productCategories = pgTable(
  'product_categories',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    description: text('description'),
    /** Optional. Absence is ordinary, never an error. */
    emoji: text('emoji'),
    status: text('status').notNull().default('ACTIVE'),
    visibility: text('visibility').notNull().default('VISIBLE'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    /**
     * The customer's order, and it matches the ORDER BY exactly.
     *
     * `(tenant, sort_order, id)` rather than `(tenant, sort_order, created_at, id)`,
     * because the owner specified `sort_order ASC, id ASC` for the paged customer
     * surfaces and an index whose columns are a superset still leaves the planner
     * sorting on `id` within each `sort_order` group. Added by 0098 for that reason;
     * 0097 shipped the four-column shape, which was right for the ordering assumed
     * before the paging decision and wrong for the one specified after it.
     */
    index('product_categories_tenant_sort_id_idx').on(table.tenantId, table.sortOrder, table.id),
    /** The admin list's keyset, on the IMMUTABLE pair. Migration 0026's lesson. */
    index('product_categories_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
    check('product_categories_status_check', enumCheck('status', PRODUCT_CATEGORY_STATUSES)),
    check(
      'product_categories_visibility_check',
      enumCheck('visibility', PRODUCT_CATEGORY_VISIBILITIES),
    ),
    check(
      'product_categories_name_check',
      sql`length(name) > 0 AND length(name) <= ${sql.raw(String(PRODUCT_CATEGORY_NAME_MAX_LENGTH))}`,
    ),
    /*
     * The emoji's shape, at the database.
     *
     * Bounded in CHARACTERS, which is what PostgreSQL's `length()` counts for `text` —
     * code points, not UTF-16 units — so this is the same measure
     * `isValidCategoryEmoji` uses and the two cannot disagree about a family emoji.
     *
     * The control-character term is the one that matters for a surface: this value is
     * rendered into a Telegram inline-keyboard label, and a newline there is a broken
     * button. `~` with a character class is refused rather than accepted, so a row
     * carrying one cannot be written at all.
     */
    check(
      'product_categories_emoji_check',
      sql`emoji IS NULL OR (
        length(emoji) > 0
        AND length(emoji) <= ${sql.raw(String(PRODUCT_CATEGORY_EMOJI_MAX_CODE_POINTS))}
        AND btrim(emoji) <> ''
        AND emoji !~ ${sql.raw(CONTROL_CHARACTER_CLASS)}
      )`,
    ),
    check(
      'product_categories_sort_check',
      sql`sort_order >= ${sql.raw(String(PRODUCT_SORT_MIN))} AND sort_order <= ${sql.raw(String(PRODUCT_SORT_MAX))}`,
    ),
    /** What a composite foreign key from `products` needs to point at. */
    unique('product_categories_tenant_id_key').on(table.tenantId, table.id),
  ],
);

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    title: text('title').notNull(),
    description: text('description'),
    status: text('status').notNull().default('INACTIVE'),
    audience: text('audience').notNull().default('EVERYONE'),
    sortOrder: integer('sort_order').notNull().default(0),
    /**
     * Where a purchase of this plan is fulfilled. Null until configured.
     *
     * The single-column reference is KEPT alongside the composite one below, and that
     * is not an oversight. It is implied by `products_tenant_panel_fk` and therefore
     * redundant — but 0032 shipped it, and `migration-compatibility.test.ts` requires
     * every dropped constraint to be re-added by the same file: a migration that
     * removed it would take a constraint away from the release still running during a
     * rolling update. Expand only.
     */
    panelId: uuid('panel_id').references(() => panels.id),
    /**
     * The category a customer browses this product under.
     *
     * NULLABLE at the database, and that is not the same as "optional to the product".
     * Migration 0097 creates one category per tenant that has products and backfills
     * every row, so no product reaches a customer uncategorised. The column stays
     * nullable for two reasons: a NOT NULL on this table is a rewrite-and-lock during a
     * rolling update, and the release still running during that update writes products
     * without the column at all — expand only.
     *
     * The foreign key is `ON DELETE NO ACTION`, deliberately, and that is what makes
     * "a category holding products cannot be deleted" true at the DATABASE rather than
     * only in a service. `SET NULL` was considered and is worse: it would let the
     * delete succeed and silently strand every product in it uncategorised, which is
     * the shape where an operator's tidy-up empties a shop.
     *
     * The application refuses to sell a product with no category. The database's job
     * here is to stop the pointer being wrong, not to decide the sale.
     */
    categoryId: uuid('category_id'),
    /** 0 means no time limit (`UNLIMITED_DURATION_DAYS`). */
    durationDays: integer('duration_days').notNull(),
    /** 0 means no traffic limit (`UNLIMITED_TRAFFIC_BYTES`). Bytes, never gigabytes. */
    trafficBytes: bigint('traffic_bytes', { mode: 'bigint' }).notNull(),
    /** Null means "the provider's default", which is not the same as a cap of zero. */
    deviceLimit: integer('device_limit'),
    priceAmount: bigint('price_amount', { mode: 'bigint' }),
    priceCurrency: text('price_currency'),
    /**
     * Customer-facing DISPLAY data (customer UX completion §C): ordered strings the
     * pre-invoice and the cards render as written. Marketing copy, not routing — the
     * provisioner reads `panel_id` and never these. JSON arrays of strings, bounded at
     * the contract; `'[]'` is the default every existing row takes, which the screens
     * render as no section rather than an empty one.
     */
    displayLocations: jsonb('display_locations')
      .notNull()
      .default(sql`'[]'::jsonb`),
    displayFeatures: jsonb('display_features')
      .notNull()
      .default(sql`'[]'::jsonb`),
    serviceLocationLabel: text('service_location_label'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('products_tenant_status_idx').on(table.tenantId, table.status),
    /** The catalogue's order, and the list's keyset: sort, then created, then id. */
    index('products_tenant_sort_idx').on(
      table.tenantId,
      table.sortOrder,
      table.createdAt,
      table.id,
    ),
    check('products_status_check', enumCheck('status', PRODUCT_STATUSES)),
    check('products_audience_check', enumCheck('audience', PRODUCT_AUDIENCES)),
    check('products_price_currency_check', nullableEnumCheck('price_currency', CURRENCY_CODES)),
    /**
     * A price is an amount AND a currency, or it is absent.
     *
     * Half a price is the shape that makes a total meaningless, and it is exactly what
     * an interrupted edit or a partial import leaves behind.
     */
    check('products_price_pair_check', sql`(price_amount IS NULL) = (price_currency IS NULL)`),
    check('products_price_positive_check', sql`price_amount IS NULL OR price_amount > 0`),
    check('products_duration_check', sql`duration_days >= 0 AND duration_days <= 3650`),
    check('products_traffic_check', sql`traffic_bytes >= 0`),
    check('products_device_limit_check', sql`device_limit IS NULL OR device_limit > 0`),
    check(
      'products_display_lists_check',
      sql`jsonb_typeof(display_locations) = 'array' AND jsonb_typeof(display_features) = 'array'`,
    ),
    check(
      'products_service_location_label_check',
      sql`service_location_label IS NULL OR length(btrim(service_location_label)) BETWEEN 1 AND ${sql.raw(String(PRODUCT_SERVICE_LOCATION_LABEL_MAX_LENGTH))}`,
    ),
    /**
     * The pair, not the two halves. The same defect 0018 fixed for panel children.
     *
     * `panel_id` alone referenced `panels(id)`, which constrained it to SOME panel in
     * the installation and said nothing about it being THIS tenant's. A product could
     * therefore name another tenant's panel, and every downstream reader — the
     * catalogue's fulfillable predicate, the order snapshot, and eventually the
     * provisioning call that dials it — would have believed the pointer.
     *
     * MATCH SIMPLE is what makes this work with a nullable column: a composite foreign
     * key is not enforced when any of its columns is NULL, so an unconfigured product
     * (`panel_id IS NULL`) is still legal, exactly as `payments_order_fk` above.
     */
    foreignKey({
      columns: [table.tenantId, table.panelId],
      foreignColumns: [panels.tenantId, panels.id],
      name: 'products_tenant_panel_fk',
    }),
    /**
     * The pair again, for the same reason `products_tenant_panel_fk` is a pair: a
     * single-column reference would let a product name ANOTHER TENANT'S category, and
     * every reader downstream — the catalogue's grouping, the order snapshot — would
     * have believed it. MATCH SIMPLE means a NULL `category_id` is still legal.
     */
    foreignKey({
      columns: [table.tenantId, table.categoryId],
      foreignColumns: [productCategories.tenantId, productCategories.id],
      name: 'products_tenant_category_fk',
    }),
    /**
     * The customer's page within one category, matching `sort_order ASC, id ASC`.
     *
     * Every predicate the paged query applies is either in this index's leading
     * columns or cheap on the rows it returns — the point being that the LIMIT applies
     * to rows already filtered, never to rows a surface filters afterwards. §1.4 of
     * `docs/wp5-categories-audit.md` is the failure this shape exists to prevent.
     */
    index('products_tenant_category_sort_id_idx').on(
      table.tenantId,
      table.categoryId,
      table.sortOrder,
      table.id,
    ),
    unique('products_tenant_id_key').on(table.tenantId, table.id),
  ],
);

/**
 * A configured quantity a customer can buy for a service they already own.
 *
 * Not a product: a product is provisioned into a new account, and one of these is
 * applied to an account that exists. They share almost no columns for that reason —
 * there is no panel, no audience, no device limit and no description, because none of
 * them means anything about a quantity added to something already running.
 *
 * ## Why rows rather than a per-unit rate
 *
 * The legacy system prices these per unit, per panel, and takes a free-text quantity
 * (`TBR-009`, `PBR-009`). This bot has no FSM and no conversation state — the rule with
 * `INCIDENT-FIN-001` behind it, where the legacy prompt capture swallowed an ordinary
 * message and overwrote a production gateway setting — so there is nowhere for a typed
 * number to arrive, and a callback carries an intent and an identifier rather than a
 * quantity. The amounts a customer may buy therefore have to be rows they select.
 * `OQ-4F-05` records that as a deliberate divergence and what would have to exist for
 * the per-unit form to come back.
 *
 * ## The two amount columns are a union
 *
 * `kind` decides which one means anything, and `service_addons_amount_matches_kind`
 * makes the other one NULL rather than zero. Zero would be readable as
 * `UNLIMITED_TRAFFIC_BYTES`, which is what it means on a product, and an unlimited
 * amount is not a thing that can be ADDED to an allowance.
 */
export const serviceAddons = pgTable(
  'service_addons',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    status: text('status').notNull().default('INACTIVE'),
    sortOrder: integer('sort_order').notNull().default(0),
    /** Bytes added to the allowance. Set for `ADD_TRAFFIC`, NULL otherwise. */
    trafficBytes: bigint('traffic_bytes', { mode: 'bigint' }),
    /** Days added to the window. Set for `ADD_TIME`, NULL otherwise. */
    durationDays: integer('duration_days'),
    /**
     * WP-A5, `ADD_DEVICES` only: the most extra users / devices ONE service may be sold
     * through this add-on in total, counted from its live purchases at read time. For that
     * kind `price_amount` is the price of ONE, and the customer chooses how many.
     */
    maxQuantity: integer('max_quantity'),
    /**
     * WP-A5, `ADD_DEVICES` only: the panel and / or product the rate applies to. NULL is
     * "every", never "none"; the most specific ACTIVE row wins for a service. Both are
     * forbidden on the two package kinds, which apply tenant-wide.
     */
    panelId: uuid('panel_id'),
    productId: uuid('product_id'),
    /**
     * Bumped on every edit. A purchase copies the version it was priced from onto its
     * commercial action, so "which rule, as it read then" is answerable after the row
     * has been re-priced — the rule id AND version the brief requires on the snapshot.
     */
    version: integer('version').notNull().default(1),
    priceAmount: bigint('price_amount', { mode: 'bigint' }),
    priceCurrency: text('price_currency'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.panelId],
      foreignColumns: [panels.tenantId, panels.id],
      name: 'service_addons_panel_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.id],
      name: 'service_addons_product_fk',
    }),
    index('service_addons_tenant_status_idx').on(table.tenantId, table.status),
    /** The operator's list, and its keyset: kind, then sort, then created, then id. */
    index('service_addons_tenant_sort_idx').on(
      table.tenantId,
      table.kind,
      table.sortOrder,
      table.createdAt,
      table.id,
    ),
    check('service_addons_kind_check', enumCheck('kind', SERVICE_ADDON_KINDS)),
    check('service_addons_status_check', enumCheck('status', SERVICE_ADDON_STATUSES)),
    check(
      'service_addons_price_currency_check',
      nullableEnumCheck('price_currency', CURRENCY_CODES),
    ),
    /** A price is an amount AND a currency, or it is absent. The products rule. */
    check(
      'service_addons_price_pair_check',
      sql`(price_amount IS NULL) = (price_currency IS NULL)`,
    ),
    check('service_addons_price_positive_check', sql`price_amount IS NULL OR price_amount > 0`),
    /**
     * The union, as a constraint rather than as application discipline.
     *
     * An `ADD_TRAFFIC` row whose bytes sit in `duration_days` would be sold for a
     * quantity of nothing, and the surface reading it would show a plausible price
     * beside an amount it could not find. Both halves are asserted — the field the kind
     * reads is positive, and the other is NULL — so neither a swap nor a stray write can
     * produce one.
     */
    check(
      'service_addons_amount_matches_kind',
      sql`(kind = 'ADD_TRAFFIC' AND traffic_bytes IS NOT NULL AND traffic_bytes > 0 AND duration_days IS NULL AND max_quantity IS NULL)
          OR (kind = 'ADD_TIME' AND duration_days IS NOT NULL AND duration_days > 0 AND traffic_bytes IS NULL AND max_quantity IS NULL)
          OR (kind = 'ADD_DEVICES' AND max_quantity IS NOT NULL AND max_quantity >= 1 AND max_quantity <= 20 AND traffic_bytes IS NULL AND duration_days IS NULL)`,
    ),
    /** Only the per-device rate is scoped; the two packages apply tenant-wide (WP-A5). */
    check(
      'service_addons_scope_kind_check',
      sql`kind = 'ADD_DEVICES' OR (panel_id IS NULL AND product_id IS NULL)`,
    ),
    check('service_addons_version_check', sql`version >= 1`),
    check(
      'service_addons_duration_bound_check',
      sql`duration_days IS NULL OR duration_days <= 3650`,
    ),
    unique('service_addons_tenant_id_key').on(table.tenantId, table.id),
  ],
);

/**
 * An order — one commercial intent and its snapshot of what was bought.
 *
 * Every `line_*` column is a snapshot taken at confirmation. `product_id` and
 * `panel_id` are kept so an operator can navigate, and are explicitly NOT how the
 * purchase is reconstructed.
 *
 * `quote` is the full `PriceQuote` including its mandatory trace, so the order can
 * always answer "why this number" — the question the legacy system cannot answer for
 * any of its prices. It is `jsonb` because it is a document read as a whole and never
 * queried by its parts.
 */
export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    state: text('state').notNull().default('DRAFT'),
    /**
     * What this order is FOR, and the column settlement dispatches on.
     *
     * `PaymentService.confirmAndSettle` used to end in an unconditional
     * `planForSettledOrder`, so every settled order wrote a service and a `PROVISION`.
     * A renewal is a NEW order against the SAME service — `services.order_id` says so —
     * and through that path it would have settled and then created a SECOND provider
     * account. `services_tenant_order_key` does not catch it: the index is unique on
     * `(tenant_id, order_id)` and a renewal has its own order id.
     *
     * The DEFAULT is what makes this expand-only. The release running beside this one
     * during a rolling update writes orders without the column and gets `NEW_SERVICE`,
     * which is exactly the behaviour it already had —
     * `migration-compatibility.test.ts` requires that and would fail a NOT NULL with no
     * default.
     *
     * WHICH service a commercial order acts on is not here. It is on
     * `service_commercial_actions`, one row per commercial order, declared after
     * `services` so that it can carry the CUSTOMER in both of its references — an order
     * that named service A while claiming customer B is the bypass
     * `orders_tenant_id_customer_key` describes, in the direction that puts a renewal
     * somebody paid for onto another account. A column here could not express that: it
     * would have to point back at a table that already points at this one, and a
     * composite foreign key cannot be written in either direction of a cycle.
     */
    purpose: text('purpose').notNull().default('NEW_SERVICE'),
    /**
     * Where the order came from (Migration P3, `ORDER_ORIGINS`). Orthogonal to `purpose`.
     *
     * `STANDARD` by default, so every row that existed before the column, and every writer
     * that does not name it, is an ordinary order — the backfill is the default itself.
     * `LEGACY_ADOPTION` represents a provider account the legacy bot sold, adopted into
     * NEXA; `orders_legacy_adoption_shape_check` pins what such an order may be, and
     * migration 0188 makes the column immutable once written. Never a sale (see
     * `SALE_ORDER_ORIGINS`).
     */
    origin: text('origin').notNull().default('STANDARD'),

    /**
     * Navigation only. The snapshot below is the truth about this purchase.
     *
     * NULL for a `CUSTOM_SERVICE` order and only for one (Package D,
     * `orders_product_purpose_check`): a custom service is bought from a location and
     * the operator's range rules, never from a product, and naming one would be the
     * invisible product the brief forbids.
     */
    productId: uuid('product_id'),
    panelId: uuid('panel_id').notNull(),
    lineTitle: text('line_title').notNull(),
    lineDurationDays: integer('line_duration_days').notNull(),
    /**
     * R1: a trial's length in HOURS, and set on a `TRIAL` order only
     * (`orders_trial_hours_check`).
     *
     * A per-panel trial is configured in hours — 72, or 12 — and a day count cannot say
     * 12. When present it is what the provisioner computes the expiry from;
     * `line_duration_days` beside it carries the same length rounded UP to whole days,
     * so every reader that knows only days — a report, the release before this one
     * picking up a trial during a rolling update — reads a limited plan of about the
     * right size rather than a zero that means unlimited. Frozen at confirmation with
     * the rest of the line (`nexa_orders_snapshot_guard`).
     */
    lineDurationHours: integer('line_duration_hours'),
    lineTrafficBytes: bigint('line_traffic_bytes', { mode: 'bigint' }).notNull(),
    lineDeviceLimit: integer('line_device_limit'),
    lineUnitPriceAmount: bigint('line_unit_price_amount', { mode: 'bigint' }).notNull(),
    lineQuantity: integer('line_quantity').notNull().default(1),

    /*
     * The category this order was bought from, snapshotted — and NULLABLE, where every
     * other `line_*` column is NOT NULL.
     *
     * The nullability is the whole point and it is a decision, not a convenience. Orders
     * placed before categories existed have no category, and the owner's instruction is
     * that they must not be given one: a product's category TODAY is not evidence of
     * what a customer browsed months ago, so migration 0097 adds these columns and
     * backfills NOTHING. A null here means UNKNOWN, never "uncategorised".
     *
     * That is also why there is no `line_category_id` foreign key. The category may
     * since have been deleted — deletion is permitted for an EMPTY category — and a
     * reference would either block that deletion or cascade the order's history away.
     * The id is kept for navigation on the same terms as `product_id`: the name and
     * emoji beside it are the truth about the purchase.
     *
     * No CHECK ties the three together. A half-written snapshot is impossible because
     * one statement writes all three at confirmation, and a CHECK requiring
     * `(id IS NULL) = (name IS NULL)` would have to be satisfied by every pre-existing
     * row — which it is, all three being null — but would then forbid the only shape a
     * future reader might legitimately need: an id whose display text was redacted.
     */
    lineCategoryId: uuid('line_category_id'),
    /** The category's name as it read at confirmation. Null on a pre-WP5 order. */
    lineCategoryName: text('line_category_name'),
    /** Its emoji as it read at confirmation. Null when absent AND when unknown. */
    lineCategoryEmoji: text('line_category_emoji'),

    subtotalAmount: bigint('subtotal_amount', { mode: 'bigint' }).notNull(),
    discountAmount: bigint('discount_amount', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    totalAmount: bigint('total_amount', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    /** The full quote with its trace. A quote without one is refused by the contract. */
    quote: jsonb('quote').notNull(),
    /** Normalised upper case, or null. At most one per order (`MAX_DISCOUNT_CODES_PER_ORDER`). */
    discountCode: text('discount_code'),

    expiresAt: timestamptz('expires_at'),
    confirmedAt: timestamptz('confirmed_at'),
    settledAt: timestamptz('settled_at'),
    cancelledAt: timestamptz('cancelled_at'),
    refundedAt: timestamptz('refunded_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    /** A child row may not name a customer of another tenant. */
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'orders_customer_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.id],
      name: 'orders_product_fk',
    }),
    index('orders_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
    index('orders_tenant_state_idx').on(table.tenantId, table.state),
    index('orders_customer_created_idx').on(table.customerId, table.createdAt, table.id),
    /** The expiry sweeper's only path: unpaid orders, oldest deadline first. */
    index('orders_expiry_idx')
      .on(table.expiresAt)
      .where(sql`state = 'AWAITING_PAYMENT'`),
    check('orders_state_check', enumCheck('state', ORDER_STATES)),
    check('orders_currency_check', enumCheck('currency', CURRENCY_CODES)),
    check('orders_purpose_check', enumCheck('purpose', ORDER_PURPOSES)),
    check('orders_origin_check', enumCheck('origin', ORDER_ORIGINS)),
    /**
     * A legacy adoption (Migration P3) is a NEW_SERVICE that is already PAID, for nothing,
     * with no code.
     *
     * NEW_SERVICE is the registered decision (no invented purpose). PAID and only PAID:
     * the service exists already, so the order is settled at birth and can never become
     * REFUNDED — there is no money of this installation's to give back. Free: the legacy
     * bot took the money, so no amount here can surface in any total, whichever query
     * forgets the origin. No discount code: nothing was quoted. The half of the rule that
     * survives a direct write, as `orders_trial_is_free_check` is for a trial.
     */
    check(
      'orders_legacy_adoption_shape_check',
      sql`origin <> 'LEGACY_ADOPTION' OR (purpose = 'NEW_SERVICE' AND state = 'PAID'
          AND subtotal_amount = 0 AND discount_amount = 0 AND total_amount = 0
          AND discount_code IS NULL)`,
    ),
    /**
     * What the line snapshot MEANS, per purpose, as a constraint rather than a comment.
     *
     * Zero is `UNLIMITED_TRAFFIC_BYTES` and `UNLIMITED_DURATION_DAYS` on a product
     * snapshot, and on a quantity purchase the same zero has to mean "no time was
     * bought" instead. That overload is a real trap for a reader, so the shape is
     * pinned: an `ADD_TRAFFIC` order carries positive bytes and zero days, an `ADD_TIME`
     * order the reverse, and neither can be written the other way round. `NEW_SERVICE`
     * and `RENEW` are unconstrained here — both carry a product specification, where
     * zero keeps its usual meaning.
     */
    /**
     * A trial is free, in the database too.
     *
     * The order machine's `GRANT` edge admits only a zero-total `TRIAL`
     * (`orderIsFreeTrial`), and that guard lives in the application. This is the half
     * that survives a direct write: no `TRIAL` order can carry a price, so no code path
     * — present or future — can turn the free edge into a way to charge somebody.
     */
    check('orders_trial_is_free_check', sql`purpose <> 'TRIAL' OR total_amount = 0`),
    /**
     * A custom service names no product, and every other purpose names one (Package D) —
     * except a trial, which names one when the release before R1 issued it from
     * `trial.product_id` and none when it was issued from a panel's trial configuration.
     */
    check(
      'orders_product_purpose_check',
      sql`purpose = 'TRIAL' OR (product_id IS NULL) = (purpose = 'CUSTOM_SERVICE')`,
    ),
    /** R1: hours are a trial's, positive and bounded; no other purpose carries them. */
    check(
      'orders_trial_hours_check',
      sql`line_duration_hours IS NULL OR (purpose = 'TRIAL' AND line_duration_hours BETWEEN 1 AND 720)`,
    ),
    /**
     * A custom service is a positive volume for a positive number of days, bought once.
     * Zero means "unlimited" on a product snapshot; a customer cannot type an unlimited
     * custom service, so the overload is refused here rather than read.
     */
    check(
      'orders_custom_service_line_check',
      sql`purpose <> 'CUSTOM_SERVICE'
          OR (line_traffic_bytes > 0 AND line_duration_days > 0 AND line_quantity = 1)`,
    ),
    /*
     * `CHANGE_LOCATION` (WP-A6) buys neither bytes nor days nor devices — one move, at the
     * configured target's price; the zeros are "nothing of this was bought", never the
     * product snapshot's "unlimited".
     *
     * `ADD_DEVICES` (WP-A5) buys neither bytes nor days: its line is `line_quantity`
     * devices at `line_unit_price_amount` each, and `line_device_limit` is the TARGET the
     * quote promised — the limit then in force plus the quantity, so always above it.
     */
    check(
      'orders_quantity_line_check',
      sql`purpose NOT IN ('ADD_TRAFFIC', 'ADD_TIME', 'ADD_DEVICES', 'CHANGE_LOCATION')
          OR (purpose = 'ADD_TRAFFIC' AND line_traffic_bytes > 0 AND line_duration_days = 0)
          OR (purpose = 'ADD_TIME' AND line_duration_days > 0 AND line_traffic_bytes = 0)
          OR (purpose = 'ADD_DEVICES' AND line_traffic_bytes = 0 AND line_duration_days = 0
              AND line_device_limit IS NOT NULL AND line_device_limit > line_quantity)
          OR (purpose = 'CHANGE_LOCATION' AND line_traffic_bytes = 0 AND line_duration_days = 0
              AND line_device_limit IS NULL AND line_quantity = 1)`,
    ),
    /**
     * A total is never negative, and the parts agree with the whole.
     *
     * `clampDiscount` enforces the first in the application; this is the half that
     * survives a direct write and a future code path that forgets.
     */
    check(
      'orders_amounts_check',
      sql`subtotal_amount >= 0 AND discount_amount >= 0 AND total_amount >= 0`,
    ),
    check('orders_total_consistent_check', sql`total_amount = subtotal_amount - discount_amount`),
    check('orders_discount_bounded_check', sql`discount_amount <= subtotal_amount`),
    check('orders_quantity_check', sql`line_quantity >= 1`),
    /** Each lifecycle timestamp exists exactly when its state has been reached. */
    /*
     * Built from `ORDER_SETTLED_STATES`, not from a list typed out here.
     *
     * The contract's own predicate for "the money for this order arrived", so a
     * reconciliation query and this constraint cannot come to disagree about which
     * states that is — and a state added to one without the other fails the drift
     * check rather than quietly excluding revenue from a report.
     */
    check(
      'orders_settled_at_check',
      // Through `enumCheck`, which is the codebase's one `sql.raw` and the only
      // form that reaches the generated migration as LITERALS. A `sql` template
      // with parameters generates `state IN ($1, $2, $3)` into the DDL, which is
      // a constraint no database will ever evaluate the way it reads.
      sql`(${enumCheck('state', ORDER_SETTLED_STATES)}) = (settled_at IS NOT NULL)`,
    ),
    check('orders_refunded_at_check', sql`(state = 'REFUNDED') = (refunded_at IS NOT NULL)`),
    check('orders_cancelled_at_check', sql`(state = 'CANCELLED') = (cancelled_at IS NOT NULL)`),
    unique('orders_tenant_id_key').on(table.tenantId, table.id),
    /**
     * Redundant against the primary key, and the target of a CUSTOMER-bearing
     * composite reference.
     *
     * `payments`, `services` and `discount_redemptions` each carry their own
     * `customer_id` beside an `order_id`, and a two-column `(tenant_id, order_id)`
     * foreign key lets a child row name order A while claiming customer B. Every one of
     * those is a real bypass: a payment that settles another customer's order, a service
     * that appears in the wrong customer's list, and — the one that motivated this — a
     * discount redemption whose `(discount_id, customer_id)` pair is a fiction, which
     * makes a per-customer redemption limit advisory rather than enforced.
     *
     * So the children reference `(tenant_id, id, customer_id)` and the agreement becomes
     * impossible to express rather than merely unlikely. Found by the automated security
     * review of the schema commit, which is exactly the class of thing a reviewer sees
     * and an author does not: each FK looked correct on its own.
     */
    unique('orders_tenant_id_customer_key').on(table.tenantId, table.id, table.customerId),
  ],
);

/**
 * A payment — one attempt to settle money.
 *
 * `reference` is the string a customer quotes and an operator searches, unique per
 * tenant, and it is what makes a manual transfer reconcilable at all. It is generated,
 * never customer-supplied.
 *
 * `external_reference` holds a gateway's own identifier. There is no gateway adapter in
 * this release, so the column is empty — and it is here rather than added later because
 * a payment without a place to record external identity is a payment that cannot be
 * reconciled, and the first gateway would have to migrate live rows to get one.
 */
export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    /** Null for a wallet top-up, which settles no order. */
    orderId: uuid('order_id'),
    state: text('state').notNull().default('PENDING'),
    method: text('method').notNull(),
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    /** Generated, unique per tenant, quoted by the customer. Never customer-supplied. */
    reference: text('reference').notNull(),
    /** What a confirmation rests on. Null until confirmed. */
    evidenceKind: text('evidence_kind'),
    /**
     * An operator's note about the evidence, bounded.
     *
     * Never the customer's own message text and never a gateway response body: the
     * first is arbitrary third-party text and the second routinely carries a token.
     */
    evidenceNote: text('evidence_note'),
    /** The gateway's own id. Unused in this release; see the docblock. */
    externalReference: text('external_reference'),
    confirmedAt: timestamptz('confirmed_at'),
    /** Which administrator confirmed it, for an `OPERATOR_REVIEW`. */
    confirmedByAdminId: uuid('confirmed_by_admin_id').references(() => admins.id),
    /**
     * When the payment ended WITHOUT money: rejected, withdrawn or expired.
     *
     * The mirror of `confirmed_at` and deliberately a SECOND column rather than a
     * reuse of it. `payments_confirmed_check` binds `confirmed_at` to CONFIRMED, so a
     * rejection written there could not commit — and a schema that made it commit
     * would be one where a query for "when did the money arrive" answers with the
     * moment somebody decided it never would.
     */
    resolvedAt: timestamptz('resolved_at'),
    /**
     * Which administrator resolved it, when a person did.
     *
     * Null for an expiry, because nobody decided that — a deadline did — and null for
     * a customer's own withdrawal. `payments_resolution_reviewer_check` holds the
     * narrower half of that: an admin id may appear only on a FAILED payment, which is
     * the only human-made resolution this release can produce.
     */
    resolvedByAdminId: uuid('resolved_by_admin_id').references(() => admins.id),
    /**
     * Why, in the operator's own words. Same rules as `evidence_note`: never the
     * customer's own message text and never a gateway response body.
     */
    resolutionNote: text('resolution_note'),
    /**
     * When the customer said they had sent the transfer. Their CLAIM, never evidence.
     *
     * `docs/phase4h-audit.md` §4 measured the gap: the bot hands out a reference and
     * bank details and the flow is then silent in both directions, so an operator
     * learns of a transfer from their bank rather than from the product.
     *
     * A separate column rather than a state, and that is the load-bearing decision.
     * `PAYMENT_STATES` classifies what this installation KNOWS about the money, and a
     * customer saying they paid is not knowledge — `PAYMENT_EVIDENCE_KINDS` stays
     * `OPERATOR_REVIEW` and confirmation is unchanged. A `SIGNALLED` state would put a
     * customer's assertion on the same axis as a reviewed one, which is the legacy
     * receipt review's defect (`PRBR-004`) with a new name.
     *
     * Stamped ONCE. The conditional UPDATE that writes it requires it to be null, so a
     * customer tapping twice does not move the moment they first claimed to have paid.
     */
    customerSignalledAt: timestamptz('customer_signalled_at'),
    /**
     * Until when an APPROVED Telegram Stars pre-checkout holds this payment (Package A,
     * Codex review of #85). Telegram charges right after the approval, so until then the
     * payment is money in flight: every cancel, withdraw and wallet-replacement predicate
     * excludes a row whose hold has not lapsed, in the same statement that moves it — a
     * row-local predicate, so a cancellation that waited on the approval's row lock
     * re-reads it rather than acting on what it saw before.
     */
    checkoutHeldUntil: timestamptz('checkout_held_until'),
    expiresAt: timestamptz('expires_at'),
    /**
     * The route the payment was offered through, snapshotted when it was created
     * (Payment File 02 §21, `docs/payments-file02-design.md` D5 and D7).
     *
     * Nullable: a wallet settlement goes through no route, and every payment created
     * before this column existed has none recorded. Frozen after insert by
     * `nexa_payments_confirmation_guard` (0114), in every state.
     */
    gatewayProvider: text('gateway_provider'),
    /**
     * The top-up gift this payment PROMISED, snapshotted from its route's
     * `topup_cashback_percent` when it was created (D5).
     *
     * Null for an order payment — an order earns no top-up gift — and for a payment
     * created before this column existed; `0` for a top-up through a route that offered
     * none. Frozen after insert, so an operator changing the route's percentage later
     * cannot change a promise already made: Payment File 02 §17's snapshot rule.
     */
    topupCashbackPercent: integer('topup_cashback_percent'),
    /**
     * The customer's gateway fee this attempt was created with (WP18), snapshotted from
     * its route's `customer_fee_basis_points`: the rate, the fee it produced on `amount`,
     * and the payable the invoice asked for. `amount` stays the PRINCIPAL — every reader
     * of it (settlement, the top-up credit and gift, the refund ceiling, the reversals,
     * the reports) keeps its meaning, and the fee is none of those things.
     *
     * All three null, or all three set on a `GATEWAY` payment with
     * `payable = amount + fee` (`payments_customer_fee_check`). Null is every other
     * method, and a gateway attempt created before WP18, which is read as no fee. Frozen
     * after insert in every state (0124), like the route snapshot beside it.
     */
    customerFeeBasisPoints: integer('customer_fee_basis_points'),
    customerFeeAmount: bigint('customer_fee_amount', { mode: 'bigint' }),
    payableAmount: bigint('payable_amount', { mode: 'bigint' }),
    /**
     * The provider review window (`docs/tonpays-telegram-gateway-audit.md` §7.0, §9.6; the
     * owner's decision of 2026-10-01): when Nexa observed an external gateway's
     * ACKNOWLEDGEMENT of the customer's receipt, and the settlement deadline that opened —
     * 24 hours later, written in the SAME statement.
     *
     * Provider-neutral in name and meaning, and on the payment row for the reason
     * `checkout_held_until` is: the expiry sweep's exclusion must be ROW-LOCAL. A sweep
     * that waited on this row's lock re-reads this row's own columns (EvalPlanQual) and
     * nothing else, so an acknowledgement kept on another table would be invisible to a
     * sweep whose snapshot predates it, and a payment TonPays is reviewing would expire.
     *
     * `payments_provider_review_check` binds both columns to each other, to a GATEWAY
     * payment of a route whose descriptor says `providerReview`, to an acknowledgement
     * strictly before `expires_at`, and to exactly the window's length.
     * `nexa_payments_confirmation_guard` freezes them once set, and allows setting them
     * only on a PENDING payment: a repeated or later acknowledgement never moves the
     * deadline, whoever writes it.
     */
    providerReviewStartedAt: timestamptz('provider_review_started_at'),
    providerReviewUntil: timestamptz('provider_review_until'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'payments_customer_fk',
    }),
    /*
     * The customer travels WITH the order.
     *
     * `order_id` is nullable — a wallet top-up settles no order — and a MATCH SIMPLE
     * composite foreign key is not enforced when any of its columns is NULL, which is
     * exactly the behaviour wanted here: a top-up has no order to agree with, and every
     * payment that names one must name its owner too. Without the third column a wallet
     * debit could settle another customer's order.
     */
    foreignKey({
      columns: [table.tenantId, table.orderId, table.customerId],
      foreignColumns: [orders.tenantId, orders.id, orders.customerId],
      name: 'payments_order_fk',
    }),
    uniqueIndex('payments_tenant_reference_key').on(table.tenantId, table.reference),
    index('payments_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
    index('payments_tenant_state_idx').on(table.tenantId, table.state),
    index('payments_customer_created_idx').on(table.customerId, table.createdAt, table.id),
    /**
     * At most ONE confirmed payment per order.
     *
     * A partial unique index rather than an application check, because two concurrent
     * confirmations both read "no confirmed payment yet". This is the constraint that
     * makes a double charge impossible rather than unlikely.
     */
    uniqueIndex('payments_order_confirmed_key')
      .on(table.orderId)
      .where(sql`state = 'CONFIRMED' AND order_id IS NOT NULL`),
    /**
     * At most ONE open top-up per customer, and for the same reason as the index above.
     *
     * `requestWalletTopup` reads `findOpenTopup`, finds none, and inserts. Two callbacks
     * carrying DIFFERENT idempotency keys — a double tap, or two Telegram clients — both
     * read null inside their own transaction and both insert; the idempotency store has
     * nothing to replay because the keys differ. The customer then holds two live
     * references, each independently confirmable, and one bank transfer is credited
     * twice.
     *
     * The service takes a per-customer lock so the ordinary racing pair serialises and
     * neither sees an error. This is what holds when a lock is bypassed, forgotten, or
     * outlived by a new code path — and two api replicas is the normal case on every
     * rolling update, so the database is the only place both of them share.
     *
     * The predicate is `findOpenTopup`'s WHERE clause exactly. The two must stay in step.
     */
    uniqueIndex('payments_open_topup_key')
      .on(table.tenantId, table.customerId)
      .where(sql`state = 'PENDING' AND order_id IS NULL AND method = 'MANUAL_TRANSFER'`),
    /** The reconciliation queue: payments whose outcome nobody knows. */
    index('payments_unknown_idx')
      .on(table.tenantId, table.createdAt)
      .where(sql`state = 'UNKNOWN'`),
    /**
     * The expiry sweep's own index, and the counterpart of `orders_expiry_idx`.
     *
     * That one has existed since 0032 with NO reader — a partial index is a statement
     * about a query somebody meant to write, and `docs/phase4g-audit.md` records that
     * nothing was ever written against it. This one arrives WITH its reader.
     *
     * Leading with `tenant_id` where the orders index does not, because this sweep is
     * tenant-scoped like every other write path here and a scan ordered by deadline
     * across all tenants would be one tenant's backlog delaying another's.
     */
    index('payments_pending_expiry_idx')
      .on(table.tenantId, table.expiresAt)
      .where(sql`state = 'PENDING'`),
    /**
     * The review sweep's own index (§9.6.3 e), shipped WITH its reader: PENDING payments in
     * a provider review, by the moment their review ends.
     */
    index('payments_provider_review_idx')
      .on(table.tenantId, table.providerReviewUntil)
      .where(sql`state = 'PENDING' AND provider_review_until IS NOT NULL`),
    check('payments_state_check', enumCheck('state', PAYMENT_STATES)),
    check('payments_method_check', enumCheck('method', PAYMENT_METHODS)),
    check('payments_currency_check', enumCheck('currency', CURRENCY_CODES)),
    check(
      'payments_evidence_kind_check',
      nullableEnumCheck('evidence_kind', PAYMENT_EVIDENCE_KINDS),
    ),
    check('payments_amount_check', sql`amount > 0`),
    /**
     * A confirmed payment has a time AND evidence. Both, together.
     *
     * A confirmation with no recorded evidence is the legacy receipt review, which
     * records neither reviewer nor time (UNK-PR-010) — so "was this approved by a
     * human" is unanswerable there.
     */
    check(
      'payments_confirmed_check',
      sql`(state = 'CONFIRMED') = (confirmed_at IS NOT NULL AND evidence_kind IS NOT NULL)`,
    ),
    /**
     * A payment that ended without money has a time. The mirror of the check above.
     *
     * Both halves, as an equality rather than an implication, for the reason that one
     * gives: an implication lets a CONFIRMED payment also carry a resolution time, and
     * then "was this rejected" is answered by two columns that can disagree.
     *
     * The state list is `PAYMENT_RESOLVED_STATES` rendered by the same helper every
     * other status check here uses, so adding a state to the contract and forgetting
     * this constraint is a drift the generator catches rather than a silent hole.
     */
    check(
      'payments_resolved_check',
      sql`(state IN (${sql.join(
        PAYMENT_RESOLVED_STATES.map((state) => sql.raw(`'${state}'`)),
        sql`, `,
      )})) = (resolved_at IS NOT NULL)`,
    ),
    /**
     * An administrator may appear only on a rejection.
     *
     * `FAILED` is the only resolution a person makes in this release: an expiry is a
     * deadline and a cancellation is the customer's own. Writing an admin id onto
     * either would make "who decided this" answerable with somebody who did not, which
     * is the failure 0035 exists to prevent one state later.
     *
     * The release that adds a gateway keeps this constraint unchanged and relies on
     * its other half: a gateway-driven FAILED carries a null admin id, which is how the
     * two are told apart without a parallel enum.
     */
    check(
      'payments_resolution_reviewer_check',
      sql`resolved_by_admin_id IS NULL OR state = 'FAILED'`,
    ),
    /** A note about a resolution that did not happen is not evidence of anything. */
    check(
      'payments_resolution_note_check',
      sql`resolution_note IS NULL OR resolved_at IS NOT NULL`,
    ),
    /**
     * Only an out-of-band transfer can be claimed as sent.
     *
     * A wallet settlement commits its debit in the same transaction and a gateway is
     * reached over the wire; in neither case is there anything for a customer to assert
     * that this installation does not already know. The constraint says so where a
     * later surface cannot disagree with it.
     */
    check(
      'payments_customer_signal_check',
      sql`customer_signalled_at IS NULL OR method = 'MANUAL_TRANSFER'`,
    ),
    check('payments_checkout_hold_check', sql`checkout_held_until IS NULL OR method = 'GATEWAY'`),
    check(
      'payments_gateway_provider_check',
      nullableEnumCheck('gateway_provider', PAYMENT_GATEWAY_PROVIDERS),
    ),
    check(
      'payments_topup_cashback_percent_check',
      sql`topup_cashback_percent IS NULL OR topup_cashback_percent BETWEEN ${sql.raw(String(PAYMENT_GATEWAY_TOPUP_CASHBACK_PERCENT_MIN))} AND ${sql.raw(String(PAYMENT_GATEWAY_TOPUP_CASHBACK_PERCENT_MAX))}`,
    ),
    /*
     * WP18: the fee snapshot is all-or-nothing, only on a gateway payment, and its
     * arithmetic is the database's too — a payable that is not principal plus fee is a
     * figure nobody quoted.
     */
    check(
      'payments_customer_fee_check',
      sql`(customer_fee_basis_points IS NULL AND customer_fee_amount IS NULL AND payable_amount IS NULL) OR (method = 'GATEWAY' AND customer_fee_basis_points BETWEEN ${sql.raw(String(CUSTOMER_FEE_BASIS_POINTS_MIN))} AND ${sql.raw(String(CUSTOMER_FEE_BASIS_POINTS_MAX))} AND customer_fee_amount >= 0 AND payable_amount = amount + customer_fee_amount)`,
    ),
    /*
     * The provider review window (§7.0), row-local and generated from the contract: both
     * columns or neither; only on a GATEWAY payment of a route that reviews; acknowledged
     * strictly BEFORE the payment's own deadline (half-open — an acknowledgement at exactly
     * minute 70 opens nothing); and exactly the window's length.
     */
    check(
      'payments_provider_review_check',
      sql`(provider_review_started_at IS NULL) = (provider_review_until IS NULL) AND (provider_review_until IS NULL OR (method = 'GATEWAY' AND gateway_provider IN (${sql.join(
        PROVIDER_REVIEW_GATEWAY_PROVIDERS.map((provider) => sql.raw(`'${provider}'`)),
        sql`, `,
      )}) AND expires_at IS NOT NULL AND provider_review_started_at < expires_at AND provider_review_until = provider_review_started_at + interval '${sql.raw(String(TONPAYS_TELEGRAM_REVIEW_WINDOW_HOURS))} hours'))`,
    ),
    unique('payments_tenant_id_key').on(table.tenantId, table.id),
  ],
);

/**
 * The external gateway's side of ONE payment attempt (WP11A,
 * `docs/tonpays-gateway-audit.md` §5.3).
 *
 * One row per `GATEWAY` payment, keyed by the payment. Every provider concept lives
 * here and nowhere else: the provider's own order id and invoice id, the links the
 * customer pays through, what the provider's INQUIRY last said, what its webhook last
 * HINTED, and the bookkeeping that paces the questions. `orders`, `payments` and
 * `wallet_entries` carry none of it — Order is not Payment, Payment is not a wallet
 * entry, and a provider's word is not Nexa's state.
 *
 * ## Nothing here moves money
 *
 * The payment's own state is the only thing that says money arrived, and it moves only
 * through `PaymentService.confirmGatewayPayment`'s conditional UPDATE. This row records
 * the evidence behind that decision and what the provider said afterwards — including a
 * completion that arrived too late to count, which is recorded and never acted on.
 *
 * ## Provider identifiers are bound, never looked up globally
 *
 * `provider_order_id` is generated by Nexa and unique per `(tenant, provider)`; a webhook
 * is resolved by it only within the tenant its URL names. `provider_invoice_id` is unique
 * per `(tenant, provider)` once known. Neither is ever the key of a global lookup.
 *
 * The three provider amounts are the provider's own figures in `provider_unit`, stored
 * for support and diagnostics. They never decide approval and never replace the
 * payment's amount; `sent_amount` is what Nexa asked for, derived from the payment.
 */
export const gatewayInvoices = pgTable(
  'gateway_invoices',
  {
    paymentId: uuid('payment_id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    provider: text('provider').notNull(),
    /** Generated by Nexa, never customer-supplied. TonPays: 20 characters. */
    providerOrderId: text('provider_order_id').notNull(),
    /** The provider's invoice id, once a create or a verified inquiry has told us. */
    providerInvoiceId: text('provider_invoice_id'),
    /**
     * An invoice id a WEBHOOK named for an attempt whose create answer was lost. A hint:
     * it is inquired, and adopted as `provider_invoice_id` only when the inquiry returns
     * this row's own `provider_order_id`.
     */
    hintedInvoiceId: text('hinted_invoice_id'),
    creationState: text('creation_state').notNull(),
    creationAttempts: integer('creation_attempts').notNull().default(0),
    /** Stamped and COMMITTED before the create is sent. A reclaimed row with it set is UNKNOWN. */
    creationSentAt: timestamptz('creation_sent_at'),
    creationClaimedUntil: timestamptz('creation_claimed_until'),
    /** When a rate-limited create may be tried again, with the same order id. */
    creationRetryAt: timestamptz('creation_retry_at'),
    creationErrorCode: text('creation_error_code'),
    createdInvoiceAt: timestamptz('created_invoice_at'),
    /** Whether `buyer_chat_id` and `callback_url` were sent. The values are not stored. */
    buyerChatIdSent: boolean('buyer_chat_id_sent').notNull().default(false),
    callbackUrlSent: boolean('callback_url_sent').notNull().default(false),
    invoiceUrl: text('invoice_url'),
    webInvoiceUrl: text('web_invoice_url'),
    providerUnit: text('provider_unit').notNull(),
    sentAmount: bigint('sent_amount', { mode: 'bigint' }).notNull(),
    requestAmount: bigint('request_amount', { mode: 'bigint' }),
    finalAmount: bigint('final_amount', { mode: 'bigint' }),
    creditAmount: bigint('credit_amount', { mode: 'bigint' }),
    /** The last status the INQUIRY returned — the only one with any authority. */
    providerStatus: text('provider_status'),
    providerPaid: boolean('provider_paid'),
    lastInquiryAt: timestamptz('last_inquiry_at'),
    lastInquiryErrorCode: text('last_inquiry_error_code'),
    inquiryAttempts: integer('inquiry_attempts').notNull().default(0),
    /** Null means "nothing more to ask". */
    nextInquiryAt: timestamptz('next_inquiry_at'),
    inquiryClaimedUntil: timestamptz('inquiry_claimed_until'),
    /** Diagnostic inquiries after the deadline, webhook-triggered only, bounded. */
    postDeadlineInquiries: integer('post_deadline_inquiries').notNull().default(0),
    /** The last webhook — a HINT, never evidence. */
    webhookStatusHint: text('webhook_status_hint'),
    lastWebhookAt: timestamptz('last_webhook_at'),
    lastWebhookDeliveryId: text('last_webhook_delivery_id'),
    webhookCount: integer('webhook_count').notNull().default(0),
    outcome: text('outcome'),
    outcomeAt: timestamptz('outcome_at'),
    /** The first time an approval was observed that could no longer be acted on. */
    lateCompletionObservedAt: timestamptz('late_completion_observed_at'),
    /**
     * A `FIXED_RATE` route's rate, snapshotted when the attempt opened (Package A): sales-
     * currency minor units per provider unit. `sent_amount` was computed from it and
     * `nexa_gateway_invoices_snapshot_guard` freezes both. Null for a same-unit route.
     */
    conversionRateMinor: bigint('conversion_rate_minor', { mode: 'bigint' }),
    /**
     * The bot the attempt was opened through, for a route whose invoice is sent with the
     * bot's own token (Stars). Pre-checkout and the recorded payment must arrive on this
     * bot's webhook. Frozen once written.
     */
    botInstanceId: uuid('bot_instance_id').references(() => botInstances.id),
    /**
     * The provider's charge id, recorded from a payment the provider PUSHED (Stars:
     * `telegram_payment_charge_id`), before settlement. Unique per provider within the
     * tenant, and written once: one charge can settle one attempt, never two.
     */
    providerChargeId: text('provider_charge_id'),
    /**
     * How `sent_amount` was derived from the payable (package FX, `fx.ts`). The previous
     * release's rows are backfilled by migration 0150: `FIXED_RATE` where a rate is
     * snapshotted, `SAME_UNIT` otherwise. Frozen by the snapshot guard.
     */
    conversionPolicy: text('conversion_policy').notNull().default('SAME_UNIT'),
    /*
     * The central-rate snapshot of a `CENTRAL_FX` attempt: the quote as it was read
     * (mantissa / 10^scale of the sales currency's minor units per base unit), where and
     * when it came from, the state it was in, the policy version, the unit ratio the
     * route was configured with, and the exact effective figure per provider unit as a
     * reduced fraction. All null for any other policy; all set for `CENTRAL_FX`
     * (`gateway_invoices_fx_snapshot_check`), and every one of them frozen by the
     * snapshot guard: an issued invoice is never recomputed from a newer quote.
     */
    fxQuoteId: text('fx_quote_id'),
    fxSource: text('fx_source'),
    fxBaseAsset: text('fx_base_asset'),
    fxQuoteCurrency: text('fx_quote_currency'),
    fxRateMantissa: bigint('fx_rate_mantissa', { mode: 'bigint' }),
    fxRateScale: integer('fx_rate_scale'),
    fxSourceAt: timestamptz('fx_source_at'),
    fxFetchedAt: timestamptz('fx_fetched_at'),
    fxQuoteState: text('fx_quote_state'),
    fxPolicyVersion: integer('fx_policy_version'),
    fxUnitRatioMantissa: bigint('fx_unit_ratio_mantissa', { mode: 'bigint' }),
    fxUnitRatioScale: integer('fx_unit_ratio_scale'),
    fxEffectiveRateNumerator: bigint('fx_effective_rate_numerator', { mode: 'bigint' }),
    fxEffectiveRateDenominator: bigint('fx_effective_rate_denominator', { mode: 'bigint' }),
    /*
     * A card-transfer route's CURRENT payee card (`TONPAYS_TELEGRAM`, audit §7.1): the
     * latest state, the "the row holds what the customer pays through" precedent of
     * `invoice_url`. Every card ever shown is kept in `gateway_invoice_cards`; these say
     * which one is current. Never projected into a log line or an audit `after`.
     * `card_seq` is null exactly when no card is current — before the create, and after a
     * card change whose answer was lost (the provider may have retired the card).
     */
    cardNumber: text('card_number'),
    cardName: text('card_name'),
    cardSeq: integer('card_seq'),
    cardReceivedAt: timestamptz('card_received_at'),
    /** What the provider last said about changing the card. Authoritative; null = not said. */
    cardChangeShown: boolean('card_change_shown'),
    cardChangeCooldownUntil: timestamptz('card_change_cooldown_until'),
    cardChangeExhausted: boolean('card_change_exhausted'),
    /**
     * An operator asked the provider again on an UNKNOWN payment (audit §9.6.4): lets one
     * inquiry through past `POST_DEADLINE_INQUIRY_MAX`, and is cleared by the inquiry it
     * let through. A flag on the row rather than a raised constant.
     */
    reconcileInquiryRequestedAt: timestamptz('reconcile_inquiry_requested_at'),
    /**
     * The provider's own id for the payment a VERIFIED webhook last named under this
     * invoice (NOWPayments' `payment_id`, `docs/nowpayments-gateway-audit.md` §5.6): what
     * the next inquiry reads. A hint, replaced by each verified webhook whose ids match the
     * attempt, and never evidence: only that inquiry's answer decides anything.
     */
    hintedPaymentId: text('hinted_payment_id'),
    /**
     * The integer the provider knows this attempt's customer by (CentralPay's `userId`,
     * `docs/centralpay-gateway-audit.md` §3): the customer's stable random number from
     * `gateway_customer_numbers`, frozen here when the attempt opened so a verify is judged
     * against what was SENT. Write-once (`nexa_gateway_invoices_provider_user_guard`).
     */
    providerUserId: text('provider_user_id'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
      name: 'gateway_invoices_payment_fk',
    }),
    check(
      'gateway_invoices_conversion_policy_check',
      enumCheck('conversion_policy', GATEWAY_CONVERSION_POLICIES),
    ),
    check('gateway_invoices_fx_source_check', nullableEnumCheck('fx_source', FX_SOURCES)),
    check(
      'gateway_invoices_fx_base_asset_check',
      nullableEnumCheck('fx_base_asset', FX_BASE_ASSETS),
    ),
    check(
      'gateway_invoices_fx_quote_currency_check',
      nullableEnumCheck('fx_quote_currency', SALES_CURRENCY_CODES),
    ),
    check(
      'gateway_invoices_fx_quote_state_check',
      nullableEnumCheck('fx_quote_state', FX_USABLE_QUOTE_STATES),
    ),
    /** A fixed-rate attempt carries its rate and nothing of the feed; a central-rate one the whole snapshot. */
    check(
      'gateway_invoices_fx_snapshot_check',
      sql`(conversion_policy = 'FIXED_RATE') = (conversion_rate_minor IS NOT NULL)
          AND (conversion_policy = 'CENTRAL_FX') = (fx_quote_id IS NOT NULL)
          AND (fx_quote_id IS NULL) = (fx_source IS NULL)
          AND (fx_quote_id IS NULL) = (fx_base_asset IS NULL)
          AND (fx_quote_id IS NULL) = (fx_quote_currency IS NULL)
          AND (fx_quote_id IS NULL) = (fx_rate_mantissa IS NULL)
          AND (fx_quote_id IS NULL) = (fx_rate_scale IS NULL)
          AND (fx_quote_id IS NULL) = (fx_fetched_at IS NULL)
          AND (fx_quote_id IS NULL) = (fx_quote_state IS NULL)
          AND (fx_quote_id IS NULL) = (fx_policy_version IS NULL)
          AND (fx_quote_id IS NULL) = (fx_unit_ratio_mantissa IS NULL)
          AND (fx_quote_id IS NULL) = (fx_unit_ratio_scale IS NULL)
          AND (fx_quote_id IS NULL) = (fx_effective_rate_numerator IS NULL)
          AND (fx_quote_id IS NULL) = (fx_effective_rate_denominator IS NULL)
          AND (fx_rate_mantissa IS NULL OR fx_rate_mantissa > 0)
          AND (fx_rate_scale IS NULL OR fx_rate_scale BETWEEN 0 AND 8)
          AND (fx_unit_ratio_mantissa IS NULL OR fx_unit_ratio_mantissa > 0)
          AND (fx_unit_ratio_scale IS NULL OR fx_unit_ratio_scale BETWEEN 0 AND 4)
          AND (fx_effective_rate_numerator IS NULL OR fx_effective_rate_numerator > 0)
          AND (fx_effective_rate_denominator IS NULL OR fx_effective_rate_denominator > 0)
          AND (fx_quote_id IS NULL OR length(fx_quote_id) BETWEEN 1 AND 96)`,
    ),
    uniqueIndex('gateway_invoices_charge_id_key')
      .on(table.tenantId, table.provider, table.providerChargeId)
      .where(sql`provider_charge_id IS NOT NULL`),
    uniqueIndex('gateway_invoices_order_id_key').on(
      table.tenantId,
      table.provider,
      table.providerOrderId,
    ),
    uniqueIndex('gateway_invoices_invoice_id_key')
      .on(table.tenantId, table.provider, table.providerInvoiceId)
      .where(sql`provider_invoice_id IS NOT NULL`),
    /** The worker's two queues: invoices to create, and inquiries due. */
    index('gateway_invoices_creating_idx')
      .on(table.tenantId, table.createdAt)
      .where(sql`creation_state = 'CREATING'`),
    index('gateway_invoices_inquiry_due_idx')
      .on(table.tenantId, table.nextInquiryAt)
      .where(sql`next_inquiry_at IS NOT NULL`),
    check('gateway_invoices_provider_check', enumCheck('provider', PAYMENT_GATEWAY_PROVIDERS)),
    check(
      'gateway_invoices_creation_state_check',
      enumCheck('creation_state', GATEWAY_INVOICE_CREATION_STATES),
    ),
    check('gateway_invoices_outcome_check', nullableEnumCheck('outcome', GATEWAY_INVOICE_OUTCOMES)),
    check(
      'gateway_invoices_provider_unit_check',
      enumCheck('provider_unit', GATEWAY_PROVIDER_UNITS),
    ),
    check(
      'gateway_invoices_conversion_rate_check',
      sql`conversion_rate_minor IS NULL OR conversion_rate_minor > 0`,
    ),
    check(
      'gateway_invoices_charge_id_length_check',
      sql`provider_charge_id IS NULL OR length(provider_charge_id) BETWEEN 1 AND 255`,
    ),
    /**
     * A Stars attempt names its bot and is priced by a rate — the operator's fixed one or
     * the central one (package FX); the invoice cannot be sent or checked without both.
     */
    check(
      'gateway_invoices_stars_snapshot_check',
      sql`provider <> 'TELEGRAM_STARS' OR (bot_instance_id IS NOT NULL AND conversion_policy IN ('FIXED_RATE', 'CENTRAL_FX') AND provider_unit = 'XTR')`,
    ),
    check('gateway_invoices_sent_amount_check', sql`sent_amount > 0`),
    check(
      'gateway_invoices_order_id_length_check',
      sql`length(provider_order_id) BETWEEN 1 AND 64`,
    ),
    /**
     * A created invoice has an id and a time. An id may also be ADOPTED onto a
     * create whose answer was lost, once an inquiry returned this row's own order id —
     * and on nothing else: a refused or still-creating attempt has no invoice to name.
     */
    check(
      'gateway_invoices_created_check',
      sql`(creation_state <> 'CREATED' OR (provider_invoice_id IS NOT NULL AND created_invoice_at IS NOT NULL))
          AND (provider_invoice_id IS NULL OR creation_state IN ('CREATED', 'CREATE_UNKNOWN'))`,
    ),
    check('gateway_invoices_outcome_at_check', sql`(outcome IS NULL) = (outcome_at IS NULL)`),
    /**
     * A TonPays Telegram attempt names its bot and is billed in Toman with no conversion
     * (audit §7.1) — the Stars CHECK's shape. The bot is frozen by the snapshot guard.
     */
    check(
      'gateway_invoices_tonpays_telegram_check',
      sql`provider <> 'TONPAYS_TELEGRAM' OR (bot_instance_id IS NOT NULL AND provider_unit = 'IRT' AND conversion_policy = 'SAME_UNIT')`,
    ),
    check(
      'gateway_invoices_hinted_payment_id_check',
      sql`hinted_payment_id IS NULL OR hinted_payment_id ~ '^[0-9]{1,20}$'`,
    ),
    /**
     * A NOWPayments attempt is billed in US cents, priced from the central USDT quote
     * (package FX) and never by a fixed rate or in the sales currency.
     */
    check(
      'gateway_invoices_nowpayments_check',
      sql`provider <> 'NOWPAYMENTS' OR (provider_unit = 'USD' AND conversion_policy = 'CENTRAL_FX' AND bot_instance_id IS NULL)`,
    ),
    /**
     * A CentralPay attempt is billed in Toman with no conversion and no bot, and carries the
     * integers the provider was sent: a ten-digit order id and the customer's number.
     */
    check(
      'gateway_invoices_centralpay_check',
      sql`provider <> 'CENTRALPAY' OR (provider_unit = 'IRT' AND conversion_policy = 'SAME_UNIT' AND bot_instance_id IS NULL AND provider_user_id IS NOT NULL AND provider_order_id ~ '^[0-9]{10}$')`,
    ),
    check(
      'gateway_invoices_provider_user_id_check',
      sql`provider_user_id IS NULL OR (provider = 'CENTRALPAY' AND provider_user_id ~ '^[0-9]{10}$')`,
    ),
    /*
     * CentralPay's `orderId` is unique across EVERY tenant: tenants that share one merchant
     * account share its order namespace, and `verify` is asked by order id alone.
     */
    uniqueIndex('gateway_invoices_centralpay_order_id_key')
      .on(table.providerOrderId)
      .where(sql`provider = 'CENTRALPAY'`),
    /** A current card is a whole card, only on a card-transfer route, bounded by length only. */
    check(
      'gateway_invoices_card_check',
      sql`(card_seq IS NULL) = (card_number IS NULL)
          AND (card_seq IS NULL) = (card_received_at IS NULL)
          AND (card_name IS NULL OR card_number IS NOT NULL)
          AND (card_number IS NULL OR provider = 'TONPAYS_TELEGRAM')
          AND (card_seq IS NULL OR card_seq >= 1)
          AND (card_number IS NULL OR length(card_number) BETWEEN 1 AND ${sql.raw(String(GATEWAY_CARD_NUMBER_MAX_LENGTH))})
          AND (card_name IS NULL OR length(card_name) BETWEEN 1 AND ${sql.raw(String(GATEWAY_CARD_NAME_MAX_LENGTH))})`,
    ),
  ],
);

/**
 * Every payee card a card-transfer attempt was ever shown (audit §7.2). APPEND-ONLY, by
 * trigger: a dispute — "I paid the card you showed me" — is answerable only if no card a
 * customer saw can be overwritten. `gateway_invoices.card_*` says which one is current.
 */
export const gatewayInvoiceCards = pgTable(
  'gateway_invoice_cards',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    paymentId: uuid('payment_id').notNull(),
    seq: integer('seq').notNull(),
    cardNumber: text('card_number').notNull(),
    cardName: text('card_name'),
    source: text('source').notNull(),
    receivedAt: timestamptz('received_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.paymentId, table.seq] }),
    foreignKey({
      columns: [table.tenantId, table.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
      name: 'gateway_invoice_cards_payment_fk',
    }),
    check('gateway_invoice_cards_source_check', enumCheck('source', GATEWAY_CARD_SOURCES)),
    check(
      'gateway_invoice_cards_bounds_check',
      sql`seq >= 1 AND length(card_number) BETWEEN 1 AND ${sql.raw(String(GATEWAY_CARD_NUMBER_MAX_LENGTH))} AND (card_name IS NULL OR length(card_name) BETWEEN 1 AND ${sql.raw(String(GATEWAY_CARD_NAME_MAX_LENGTH))})`,
    ),
  ],
);

/**
 * A customer's request for another payee card (audit §7.3, §8.2): written by the tap, sent
 * by the gateway worker, never while Telegram waits. Every transition is a conditional
 * UPDATE naming its `from` states; `sent_at` is stamped and committed BEFORE the call, and a
 * row reclaimed with it set is UNKNOWN and never re-sent.
 */
export const gatewayCardChanges = pgTable(
  'gateway_card_changes',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    paymentId: uuid('payment_id').notNull(),
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    customerId: uuid('customer_id').notNull(),
    state: text('state').notNull(),
    requestedAt: timestamptz('requested_at').notNull(),
    claimedUntil: timestamptz('claimed_until'),
    sentAt: timestamptz('sent_at'),
    decidedAt: timestamptz('decided_at'),
    errorCode: text('error_code'),
    idempotencyKey: text('idempotency_key').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
      name: 'gateway_card_changes_payment_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'gateway_card_changes_customer_fk',
    }),
    /** At most ONE request in flight per payment, decided by the database. */
    uniqueIndex('gateway_card_changes_in_flight_key')
      .on(table.tenantId, table.paymentId)
      .where(sql`state IN ('REQUESTED', 'SENT')`),
    uniqueIndex('gateway_card_changes_idempotency_key').on(table.tenantId, table.idempotencyKey),
    index('gateway_card_changes_due_idx')
      .on(table.tenantId, table.requestedAt)
      .where(sql`state IN ('REQUESTED', 'SENT')`),
    index('gateway_card_changes_payment_idx').on(
      table.tenantId,
      table.paymentId,
      table.requestedAt,
    ),
    check('gateway_card_changes_state_check', enumCheck('state', GATEWAY_CARD_CHANGE_STATES)),
    check(
      'gateway_card_changes_decided_check',
      sql`(state IN ('REQUESTED', 'SENT')) = (decided_at IS NULL) AND (state <> 'SENT' OR sent_at IS NOT NULL) AND (state <> 'REQUESTED' OR sent_at IS NULL)`,
    ),
    check(
      'gateway_card_changes_error_code_check',
      sql`error_code IS NULL OR length(error_code) BETWEEN 1 AND 64`,
    ),
  ],
);

/**
 * The window in which ONE customer's next photo, in ONE bot, is a receipt for ONE
 * TonPays Telegram payment (audit §7.4, §8.3). Bound to exactly the six things the brief
 * names: tenant, bot, customer, payment, provider and invoice — every one from the ROW,
 * never from the update. NOT `receipt_captures`: that window files a `payment_receipts` row
 * for Nexa's manual review queue and exempts the payment from expiry, and a provider
 * receipt there would be a second approver and an unbounded deadline.
 */
export const gatewayReceiptCaptures = pgTable(
  'gateway_receipt_captures',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    customerId: uuid('customer_id').notNull(),
    paymentId: uuid('payment_id').notNull(),
    provider: text('provider').notNull(),
    providerInvoiceId: text('provider_invoice_id').notNull(),
    openedAt: timestamptz('opened_at').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    closedAt: timestamptz('closed_at'),
    closeReason: text('close_reason'),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'gateway_receipt_captures_customer_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
      name: 'gateway_receipt_captures_payment_fk',
    }),
    /** ONE open window per customer per bot — `receipt_captures_open_key`'s rule. */
    uniqueIndex('gateway_receipt_captures_open_key')
      .on(table.tenantId, table.botInstanceId, table.customerId)
      .where(sql`closed_at IS NULL`),
    index('gateway_receipt_captures_due_idx')
      .on(table.tenantId, table.expiresAt)
      .where(sql`closed_at IS NULL`),
    check('gateway_receipt_captures_provider_check', sql`provider = 'TONPAYS_TELEGRAM'`),
    check(
      'gateway_receipt_captures_close_reason_check',
      nullableEnumCheck('close_reason', GATEWAY_RECEIPT_CAPTURE_CLOSE_REASONS),
    ),
    check(
      'gateway_receipt_captures_closed_check',
      sql`(closed_at IS NULL) = (close_reason IS NULL)`,
    ),
    check('gateway_receipt_captures_expiry_check', sql`expires_at > opened_at`),
    unique('gateway_receipt_captures_tenant_id_key').on(table.tenantId, table.id),
  ],
);

/**
 * One receipt image the customer sent for the PROVIDER (audit §7.5). Never a
 * `payment_receipts` row, never in the manual review queue. No bytes, no hash and no
 * caption are stored: `byte_length` is a count. Claimed and uploaded by the gateway worker;
 * `sent_at` is stamped and committed before the upload, and a row reclaimed with it set is
 * UNKNOWN and is never re-uploaded (`OQ-TPTG-08`).
 */
export const gatewayReceiptSubmissions = pgTable(
  'gateway_receipt_submissions',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    paymentId: uuid('payment_id').notNull(),
    providerInvoiceId: text('provider_invoice_id').notNull(),
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    customerId: uuid('customer_id').notNull(),
    captureId: uuid('capture_id').notNull(),
    /** Telegram's handle for the file, scoped to the bot above. Never logged. */
    telegramFileId: text('telegram_file_id').notNull(),
    telegramFileUniqueId: text('telegram_file_unique_id').notNull(),
    declaredSize: bigint('declared_size', { mode: 'bigint' }),
    state: text('state').notNull(),
    attempts: integer('attempts').notNull().default(0),
    claimedUntil: timestamptz('claimed_until'),
    sentAt: timestamptz('sent_at'),
    retryAt: timestamptz('retry_at'),
    decidedAt: timestamptz('decided_at'),
    errorCode: text('error_code'),
    /** What the upload answer said — metadata, never approval. */
    providerStatus: text('provider_status'),
    receiptReceived: boolean('receipt_received'),
    /** True on the ONE submission whose acknowledgement opened the review window. */
    openedReview: boolean('opened_review').notNull().default(false),
    /**
     * When an inquiry answered after this submission's answer was lost: the UNKNOWN is then
     * resolved FOR DISPLAY (a later `pending` lets the customer send a different photo), and
     * never opens a review (§9.1, §9.6.3 c).
     */
    inquiryResolvedAt: timestamptz('inquiry_resolved_at'),
    byteLength: integer('byte_length'),
    createdAt: timestamptz('created_at').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
      name: 'gateway_receipt_submissions_payment_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'gateway_receipt_submissions_customer_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.captureId],
      foreignColumns: [gatewayReceiptCaptures.tenantId, gatewayReceiptCaptures.id],
      name: 'gateway_receipt_submissions_capture_fk',
    }),
    /** The same photo is one submission: never queued, so never sent, twice. */
    uniqueIndex('gateway_receipt_submissions_file_key').on(
      table.tenantId,
      table.paymentId,
      table.telegramFileUniqueId,
    ),
    /** At most ONE in flight per payment. */
    uniqueIndex('gateway_receipt_submissions_in_flight_key')
      .on(table.tenantId, table.paymentId)
      .where(sql`state IN ('QUEUED', 'SENDING')`),
    /** At most ONE unresolved UNKNOWN per payment: it blocks a new upload until answered. */
    uniqueIndex('gateway_receipt_submissions_unknown_key')
      .on(table.tenantId, table.paymentId)
      .where(sql`state = 'UNKNOWN' AND inquiry_resolved_at IS NULL`),
    /** The submission whose acknowledgement opened the review — one per payment. */
    uniqueIndex('gateway_receipt_submissions_review_key')
      .on(table.tenantId, table.paymentId)
      .where(sql`opened_review`),
    index('gateway_receipt_submissions_due_idx')
      .on(table.tenantId, table.createdAt)
      .where(sql`state IN ('QUEUED', 'SENDING')`),
    check(
      'gateway_receipt_submissions_state_check',
      enumCheck('state', GATEWAY_RECEIPT_SUBMISSION_STATES),
    ),
    check(
      'gateway_receipt_submissions_decided_check',
      sql`(state IN ('QUEUED', 'SENDING')) = (decided_at IS NULL) AND (state <> 'SENDING' OR sent_at IS NOT NULL) AND (NOT opened_review OR state = 'ACCEPTED')`,
    ),
    check(
      'gateway_receipt_submissions_bounds_check',
      sql`attempts >= 0 AND (byte_length IS NULL OR byte_length >= 0) AND (declared_size IS NULL OR declared_size > 0) AND (error_code IS NULL OR length(error_code) BETWEEN 1 AND 64) AND (provider_status IS NULL OR length(provider_status) BETWEEN 1 AND 32) AND length(telegram_file_unique_id) BETWEEN 1 AND 255 AND length(telegram_file_id) BETWEEN 1 AND 1024`,
    ),
  ],
);

/**
 * Where a manual transfer goes: the tenant's configuration, mutable at any time.
 *
 * The FIRST of two tables, and the split is the whole design. This one an operator
 * edits; `payment_destinations` is the frozen copy a customer was actually shown. Until
 * Phase 5 there was neither, and the only place a card number could live was inside an
 * overridden template body — so editing it rewrote what every already-issued instruction
 * said, and `docs/phase5-audit.md` §1 measures the rest of what that cost.
 *
 * There is no `deleted_at` and no delete path. `customers` states the rule this follows —
 * a block is not a deletion — and it holds harder here: `payment_destinations.account_id`
 * names the row a payment was issued against, and a deleted account is a payment whose
 * provenance is a dangling id. Disable and edit cover every reason an operator reaches
 * for delete.
 *
 * The card number is NOT a credential and is deliberately not stored like one. This
 * installation PUBLISHES it, to every customer who chooses to pay out of band; an
 * encrypted column would mean an operator could not read back what they had configured,
 * which is the write-only settings defect `docs/conventions.md` names.
 */
export const paymentAccounts = pgTable(
  'payment_accounts',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** Operator-facing. Never rendered to a customer; it names the account. */
    label: text('label').notNull(),
    bankName: text('bank_name').notNull(),
    holderName: text('holder_name').notNull(),
    /** Sixteen ASCII digits, normalised and Luhn-checked at the trust boundary. */
    cardNumber: text('card_number').notNull(),
    /** `IR` and twenty-four digits, or NULL. The one field a destination may lack. */
    iban: text('iban'),
    enabled: boolean('enabled').notNull().default(true),
    /**
     * Which account a new payment is issued against.
     *
     * A boolean with a PARTIAL UNIQUE INDEX rather than a `default_account_id` column on
     * the tenant, and the reason is the one the panels module learned: a pointer from
     * the parent can name a row that has since been disabled, and nothing in the schema
     * notices. Here the two rules that matter are both constraints —
     * at most one per tenant, and a default is always enabled.
     */
    isDefault: boolean('is_default').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    /** The operator's list, in the order it is rendered: sort, then created, then id. */
    index('payment_accounts_tenant_sort_idx').on(
      table.tenantId,
      table.sortOrder,
      table.createdAt,
      table.id,
    ),
    /**
     * ONE default per tenant, decided by the database.
     *
     * Two operators promoting different accounts at the same moment both read "this one
     * is not the default yet". A service-level check answers both of them yes; this
     * index answers one of them with a unique violation, which the service turns into a
     * conflict the operator can act on.
     */
    uniqueIndex('payment_accounts_tenant_default_key')
      .on(table.tenantId)
      .where(sql`is_default`),
    /**
     * One ENABLED account per card number.
     *
     * Scoped to enabled rows, because re-adding a card that was disabled last month is
     * ordinary. Two LIVE accounts for one card are not: they then differ only in a label
     * or a holder name, and nothing decides which a customer is shown.
     */
    uniqueIndex('payment_accounts_tenant_card_key')
      .on(table.tenantId, table.cardNumber)
      .where(sql`enabled`),
    /**
     * A default is enabled. The other half of "a disabled account cannot be selected".
     *
     * Without it the rule is defeated from the far end: disable the default, and the row
     * a new payment is issued against is one the operator said to stop using.
     */
    check('payment_accounts_default_enabled_check', sql`NOT is_default OR enabled`),
    /*
     * The same structural checks the contract applies, restated where a hand-written
     * UPDATE cannot skip them. Not duplication for its own sake: `paymentAccountInputSchema`
     * guards the HTTP boundary and these guard the table, and a repair script run at 3am
     * only meets the second.
     *
     * SHAPE only, and the check digits are NOT here: `nexa_luhn_ok` and `nexa_iban_ir_ok`
     * are functions, drizzle-kit models neither them nor a CHECK that calls one, so
     * `payment_accounts_card_luhn_check` and `payment_accounts_iban_mod97_check` live in
     * migration 0065 and are invisible to the drift check by construction. They exist
     * because these two were the whole of the table's defence and a sixteen-digit string
     * with a wrong Luhn digit satisfied them — the Codex review of PR #34.
     */
    check('payment_accounts_card_number_check', sql`card_number ~ '^[0-9]{16}$'`),
    check('payment_accounts_iban_check', sql`iban IS NULL OR iban ~ '^IR[0-9]{24}$'`),
    check('payment_accounts_label_check', sql`length(btrim(label)) BETWEEN 1 AND 80`),
    check('payment_accounts_bank_name_check', sql`length(btrim(bank_name)) BETWEEN 1 AND 80`),
    check('payment_accounts_holder_name_check', sql`length(btrim(holder_name)) BETWEEN 1 AND 120`),
    check('payment_accounts_sort_order_check', sql`sort_order BETWEEN 0 AND 100000`),
    unique('payment_accounts_tenant_id_key').on(table.tenantId, table.id),
  ],
);

/**
 * The payment ROUTES a tenant offers, one row per route it has configured.
 *
 * ## The key is the route, and there is no id
 *
 * `(tenant_id, provider)` IS the primary key. That is the legacy roster's own shape —
 * `WEB-BR-012` counts a fixed eleven with no Add Gateway — expressed as a constraint
 * rather than as a unique index bolted onto a surrogate key, and it buys two things a
 * uuid would not. A surface addresses a route with a value from a CLOSED enum, so a
 * crafted identifier fails at the schema instead of reaching a query that has to
 * remember its tenant filter. And the audit row's `entity_id` is the provider name, so
 * "who switched card-to-card off, and when" reads as that.
 *
 * ## What is NOT here
 *
 * No credential column, no cashback percent, no button colour, and no currency.
 * `packages/contracts/src/payment-gateways.ts` carries the reason for each; the short
 * form is that the first has no route that needs it, the next two have nothing that
 * would honour them, and the fourth would be a second denomination with no conversion
 * to reach it. A column added here later has to arrive with the thing that reads it.
 */
export const paymentGateways = pgTable(
  'payment_gateways',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** From `PAYMENT_GATEWAY_PROVIDERS`. Code, not data — the row cannot invent one. */
    provider: text('provider').notNull(),
    status: text('status').notNull(),
    /**
     * The label the route is chosen by, or NULL for the product's own name.
     *
     * Nullable so that a route can exist before an operator has typed anything — the
     * upgrade that gives a tenant its manual route writes no copy, because a Persian
     * label in a SQL file is a customer-facing string in the one place the template
     * rule cannot reach it.
     */
    displayName: text('display_name'),
    /** The route's own tutorial, stored RAW. NULL means the route adds nothing. */
    instructions: text('instructions'),
    /**
     * The bounds, in minor units, with `0` meaning unbounded on that side.
     *
     * `bigint` with `mode: 'bigint'`, never a float and never a `number`: `pg` hands
     * back `int8` as a string and the parser this codebase installs turns it into a
     * `bigint`, which is what keeps an amount above 2^53 exact.
     *
     * The companion `currency` column is `bounds_currency` below — added by 0077 after
     * the payment batch's review, and a correction to what this comment used to say.
     * The bounds were stored bare and relabelled with whatever `sales.currency` was at
     * COMPARISON time, so an operator switching the installation from IRT to IRR made
     * every route's `1000000` silently mean a tenth of what it had, with nobody editing
     * a bound. Storing the denomination the bounds were WRITTEN in is what lets the
     * comparison fail closed on a mismatch — the case `PaymentGatewayService` always
     * named and could never reach.
     */
    minAmountMinor: bigint('min_amount_minor', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    maxAmountMinor: bigint('max_amount_minor', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    /**
     * The denomination the two bounds were written in — the installation's
     * `sales.currency` at the moment an operator saved them, or at the moment the zero
     * row was provisioned. Compared against the amount's currency in `offer`, and a
     * disagreement refuses the route until an operator re-saves it under the new
     * currency, rather than reinterpreting the numbers. Backfilled by 0078 from each
     * tenant's setting.
     *
     * Nullable THIS release, on purpose: the previous release still writes this table
     * without the column, for the length of a rolling update, and `SET NOT NULL` would
     * refuse those writes — `migration-compatibility.test.ts` states the rule. A NULL
     * therefore means "written by the previous release", and the readers fall back to
     * the installation's current currency for it, which is exactly the relabelling
     * that release performed. The contract step — a second backfill and NOT NULL — is
     * the release after this one; `docs/open-questions.md` OQ-5H-05 carries it.
     */
    boundsCurrency: text('bounds_currency'),
    /**
     * The three eligibility thresholds, where `0` is the condition switched OFF.
     *
     * `WEB-BR-014` reads that semantics off the legacy form's own instruction text, so
     * it is evidenced rather than chosen — and it is why these are plain integers
     * rather than nullable ones. A nullable column would give "off" two spellings, and
     * the one a migration wrote would be the one nothing tested.
     */
    activateAfterPayments: integer('activate_after_payments').notNull().default(0),
    deactivateAfterPayments: integer('deactivate_after_payments').notNull().default(0),
    activateAfterAccountDays: integer('activate_after_account_days').notNull().default(0),
    sortOrder: integer('sort_order').notNull().default(0),
    /**
     * The top-up gift this route promises, a whole percentage of a top-up's principal
     * (Payment File 02 §17, D5). `0` is no gift and the default, so every existing route
     * keeps promising nothing until an operator says otherwise. A top-up snapshots it
     * onto `payments.topup_cashback_percent` when it is created.
     */
    topupCashbackPercent: integer('topup_cashback_percent').notNull().default(0),
    /**
     * The customer's gateway fee in basis points (WP18): `525` is 5.25 %. `0` is none and
     * the default, so every existing route charges nothing until an operator says so.
     * Only a route that settles through `GATEWAY` may carry a non-zero rate — the service
     * refuses one anywhere else. Each attempt snapshots it onto `payments`.
     */
    customerFeeBasisPoints: integer('customer_fee_basis_points').notNull().default(0),
    /**
     * Per PURPOSE (customer UX completion §D/§F): whether the route may be offered for
     * a service purchase and for a wallet top-up. Both default to true, the state every
     * row was in before the columns existed. `status` still decides whether the route is
     * offered at all.
     */
    allowServicePurchase: boolean('allow_service_purchase').notNull().default(true),
    allowWalletTopup: boolean('allow_wallet_topup').notNull().default(true),
    /**
     * A `FIXED_RATE` route's conversion (Package A): sales-currency minor units per ONE
     * provider unit — for Telegram Stars in a Toman installation, the owner's
     * `toman_per_star`. Null until an operator sets it, and a fixed-rate route cannot be
     * enabled while it is. Each attempt snapshots it onto its `gateway_invoices` row, so
     * changing it never alters an invoice already open. There is no FX feed.
     */
    providerUnitRateMinor: bigint('provider_unit_rate_minor', { mode: 'bigint' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'payment_gateways_pk',
      columns: [table.tenantId, table.provider],
    }),
    /** The operator's list and the customer's, in the order both render: sort, provider. */
    index('payment_gateways_tenant_sort_idx').on(table.tenantId, table.sortOrder, table.provider),
    check('payment_gateways_provider_check', enumCheck('provider', PAYMENT_GATEWAY_PROVIDERS)),
    check('payment_gateways_status_check', enumCheck('status', PAYMENT_GATEWAY_STATUSES)),
    check(
      'payment_gateways_bounds_currency_check',
      nullableEnumCheck('bounds_currency', CURRENCY_CODES),
    ),
    /*
     * The same structural rules the contract applies, restated where a hand-written
     * UPDATE cannot skip them — the argument `payment_accounts` states: the schema
     * guards the HTTP boundary and these guard the table, and a repair script run at
     * 3am only meets the second.
     *
     * The window check is the one worth reading twice. A maximum below the minimum
     * yields a route that is configured, switched on, and impossible to pay through,
     * and it says so nowhere an operator would look. `FBR-008` could not establish what
     * a legacy installation does when limits conflict, so this refuses the state rather
     * than resolving it.
     */
    check(
      'payment_gateways_amount_window_check',
      sql`max_amount_minor = 0 OR max_amount_minor >= min_amount_minor`,
    ),
    check('payment_gateways_min_amount_check', sql`min_amount_minor >= 0`),
    check('payment_gateways_max_amount_check', sql`max_amount_minor >= 0`),
    /*
     * And the same for the payment-count pair. Crossed bounds are a route no customer
     * is ever eligible for; `0` on either side is the condition off, which is why the
     * check is written to admit a zero rather than to compare unconditionally.
     */
    check(
      'payment_gateways_payment_window_check',
      sql`activate_after_payments = 0
          OR deactivate_after_payments = 0
          OR deactivate_after_payments > activate_after_payments`,
    ),
    check(
      'payment_gateways_thresholds_check',
      sql`activate_after_payments BETWEEN 0 AND 100000
          AND deactivate_after_payments BETWEEN 0 AND 100000
          AND activate_after_account_days BETWEEN 0 AND 100000`,
    ),
    check(
      'payment_gateways_display_name_check',
      sql`display_name IS NULL OR length(btrim(display_name)) BETWEEN 1 AND 60`,
    ),
    check(
      'payment_gateways_instructions_check',
      sql`instructions IS NULL OR length(instructions) BETWEEN 1 AND 1000`,
    ),
    check('payment_gateways_sort_order_check', sql`sort_order BETWEEN 0 AND 100000`),
    check(
      'payment_gateways_topup_cashback_percent_check',
      sql`topup_cashback_percent BETWEEN ${sql.raw(String(PAYMENT_GATEWAY_TOPUP_CASHBACK_PERCENT_MIN))} AND ${sql.raw(String(PAYMENT_GATEWAY_TOPUP_CASHBACK_PERCENT_MAX))}`,
    ),
    check(
      'payment_gateways_customer_fee_check',
      sql`customer_fee_basis_points BETWEEN ${sql.raw(String(CUSTOMER_FEE_BASIS_POINTS_MIN))} AND ${sql.raw(String(CUSTOMER_FEE_BASIS_POINTS_MAX))}`,
    ),
    check(
      'payment_gateways_provider_unit_rate_check',
      sql`provider_unit_rate_minor IS NULL OR provider_unit_rate_minor > 0`,
    ),
  ],
);

/**
 * A payment route's API key, envelope-encrypted, one row per `(tenant, provider)` that
 * needs one (WP11A).
 *
 * The panel-credential rules, for the same reasons: every column is ciphertext, the key
 * id that decrypts it, or when it was last replaced; there is no plaintext column and no
 * column that could hold one; and no projection selects the ciphertext, so no response
 * builder can acquire a value. The AEAD context is `(payment_gateway.api_key, tenant,
 * id)`, rebuilt from the caller's arguments on every read, so a ciphertext copied into
 * another tenant's row fails authentication.
 *
 * Its own surrogate `id` because the secret registry walks rows by one id — and a route's
 * natural identity is a pair. The pair is still the unique key, and a composite foreign
 * key to `payment_gateways` means a credential cannot exist for a route the tenant does
 * not have.
 *
 * No clear path: a key is only ever REPLACED. Switching the route off is its own command.
 */
export const paymentGatewayCredentials = pgTable(
  'payment_gateway_credentials',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    provider: text('provider').notNull(),
    apiKeyCiphertext: text('api_key_ciphertext').notNull(),
    apiKeyKeyId: text('api_key_key_id').notNull(),
    apiKeySetAt: timestamptz('api_key_set_at').notNull(),
    /*
     * A route whose provider SIGNS its webhooks (NOWPayments' IPN secret,
     * `docs/nowpayments-gateway-audit.md` §5.6): the second secret, its own AEAD purpose
     * (`payment_gateway.webhook_secret`) bound to this row's id. All three or none
     * (`payment_gateway_credentials_webhook_secret_check`); replaced, never cleared, and
     * never selected by a projection — only its set-at time is.
     */
    webhookSecretCiphertext: text('webhook_secret_ciphertext'),
    webhookSecretKeyId: text('webhook_secret_key_id'),
    webhookSecretSetAt: timestamptz('webhook_secret_set_at'),
    /*
     * The operator's last credential check (a read-only provider call with the stored key):
     * when, and its machine result — `ok` or the classified code. Latest state only, the
     * panel-health rule; never a body, a header or the key.
     */
    lastCheckAt: timestamptz('last_check_at'),
    lastCheckResult: text('last_check_result'),
    /*
     * A route whose provider authorises its INQUIRY with a separate key (CentralPay's verify
     * key, `docs/centralpay-gateway-audit.md` §3): its own AEAD purpose
     * (`payment_gateway.verify_key`) bound to this row's id. All three or none; replaced,
     * never cleared, and never selected by a projection — only its set-at time is.
     */
    verifyKeyCiphertext: text('verify_key_ciphertext'),
    verifyKeyKeyId: text('verify_key_key_id'),
    verifyKeySetAt: timestamptz('verify_key_set_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    check(
      'payment_gateway_credentials_webhook_secret_check',
      sql`(webhook_secret_ciphertext IS NULL) = (webhook_secret_key_id IS NULL) AND (webhook_secret_ciphertext IS NULL) = (webhook_secret_set_at IS NULL)`,
    ),
    check(
      'payment_gateway_credentials_verify_key_check',
      sql`(verify_key_ciphertext IS NULL) = (verify_key_key_id IS NULL) AND (verify_key_ciphertext IS NULL) = (verify_key_set_at IS NULL)`,
    ),
    check(
      'payment_gateway_credentials_last_check_check',
      sql`(last_check_at IS NULL) = (last_check_result IS NULL) AND (last_check_result IS NULL OR length(last_check_result) BETWEEN 1 AND 64)`,
    ),
    uniqueIndex('payment_gateway_credentials_tenant_provider_key').on(
      table.tenantId,
      table.provider,
    ),
    foreignKey({
      columns: [table.tenantId, table.provider],
      foreignColumns: [paymentGateways.tenantId, paymentGateways.provider],
      name: 'payment_gateway_credentials_gateway_fk',
    }),
    check(
      'payment_gateway_credentials_provider_check',
      enumCheck('provider', PAYMENT_GATEWAY_PROVIDERS),
    ),
  ],
);

/**
 * The integer a provider knows a customer by, for a route whose descriptor says
 * `numericIdentity` (CentralPay's `userId`, `docs/centralpay-gateway-audit.md` §3).
 *
 * Drawn at random from the contract's ten-digit range the first time the customer opens an
 * attempt through the route, and never changed (`nexa_gateway_customer_numbers_guard`):
 * the provider may tie its own records — the paying card — to it. Unique per provider across
 * EVERY tenant, because tenants sharing one merchant account share its user namespace; not
 * the Telegram id, whose width the provider's integer may not hold (`OQ-CP-02`) and which
 * would hand the provider an identity it does not need.
 */
export const gatewayCustomerNumbers = pgTable(
  'gateway_customer_numbers',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    provider: text('provider').notNull(),
    customerId: uuid('customer_id').notNull(),
    number: bigint('number', { mode: 'bigint' }).notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'gateway_customer_numbers_pk',
      columns: [table.tenantId, table.provider, table.customerId],
    }),
    uniqueIndex('gateway_customer_numbers_number_key').on(table.provider, table.number),
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'gateway_customer_numbers_customer_fk',
    }),
    check(
      'gateway_customer_numbers_provider_check',
      enumCheck('provider', PAYMENT_GATEWAY_PROVIDERS),
    ),
    check(
      'gateway_customer_numbers_number_check',
      sql`number BETWEEN ${sql.raw(CENTRALPAY_INTEGER_MIN.toString())} AND ${sql.raw(CENTRALPAY_INTEGER_MAX.toString())}`,
    ),
  ],
);

/**
 * How many calls a tenant has made to one external gateway in the current minute
 * (WP11A, `docs/tonpays-gateway-audit.md` §5.7).
 *
 * TonPays documents sixty create/inquiry requests a minute, and two worker replicas are
 * the normal case on every rolling update — so the budget is a ROW taken by a
 * conditional upsert, never a counter in a process. The rule Phase 3C states for the
 * panel probe budget: nothing about an outbound call's rate is decided in a process.
 *
 * Latest state only, one row per `(tenant, provider)`: the window start and how many
 * calls it has granted.
 */
export const paymentGatewayCallBudgets = pgTable(
  'payment_gateway_call_budgets',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    provider: text('provider').notNull(),
    windowStartedAt: timestamptz('window_started_at').notNull(),
    used: integer('used').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'payment_gateway_call_budgets_pk',
      columns: [table.tenantId, table.provider],
    }),
    check(
      'payment_gateway_call_budgets_provider_check',
      enumCheck('provider', PAYMENT_GATEWAY_PROVIDERS),
    ),
    check('payment_gateway_call_budgets_used_check', sql`used >= 0`),
  ],
);

/**
 * The central exchange rate's last-known-good quote, per tenant and pair (package FX,
 * `docs/fx-audit.md` §3).
 *
 * ## Why a row and not a Redis key
 *
 * The quote prices invoices, so it is financial state: the rule `redis.ts` states is
 * that Redis is never the source of truth for anything financial or auditable, and the
 * "platform cache pattern" this installation actually has for a durable, per-tenant,
 * replica-shared value is a Postgres row with conditional writes — the gateway call
 * budget above and the panel probe claim. So the quote lives here, the refresh claim
 * is a conditional UPDATE on this row (two worker replicas is the normal case on every
 * rolling update), and a newer quote replaces an older one and never the reverse.
 *
 * Latest state only. History is on the invoices: every attempt priced by a quote
 * snapshots it, which is the record an operator explains a figure from.
 *
 * The quote columns are null as a group before the first successful fetch; the row
 * exists from the first refresh attempt so the claim has something to lock.
 */
export const fxQuotes = pgTable(
  'fx_quotes',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    baseAsset: text('base_asset').notNull(),
    quoteCurrency: text('quote_currency').notNull(),
    /** Quote-currency minor units per ONE base unit: `mantissa / 10^scale`. */
    rateMantissa: bigint('rate_mantissa', { mode: 'bigint' }),
    rateScale: integer('rate_scale'),
    source: text('source'),
    /** The provider's own timestamp for the figure, when it supplies one. */
    sourceAt: timestamptz('source_at'),
    fetchedAt: timestamptz('fetched_at'),
    quoteId: text('quote_id'),
    policyVersion: integer('policy_version'),
    /** The refresh in flight, if any: a replica that claimed the row and the lease it holds. */
    refreshClaimedUntil: timestamptz('refresh_claimed_until'),
    /**
     * The claim's OWNERSHIP token, minted by the claimer. The store and the release are
     * conditioned on it, so a refresher that stalled past its lease cannot clear or
     * overwrite a newer replica's claim (Codex review of #122). Null when unclaimed.
     */
    refreshClaimToken: text('refresh_claim_token'),
    /** The last refresh ATTEMPT, whatever it produced, and the machine code of its failure. */
    lastAttemptAt: timestamptz('last_attempt_at'),
    lastErrorCode: text('last_error_code'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'fx_quotes_pk',
      columns: [table.tenantId, table.baseAsset, table.quoteCurrency],
    }),
    check('fx_quotes_base_asset_check', enumCheck('base_asset', FX_BASE_ASSETS)),
    check('fx_quotes_quote_currency_check', enumCheck('quote_currency', SALES_CURRENCY_CODES)),
    check('fx_quotes_source_check', nullableEnumCheck('source', FX_SOURCES)),
    /** The quote is present whole or absent whole, and a present rate is positive. */
    check(
      'fx_quotes_quote_check',
      sql`(quote_id IS NULL) = (rate_mantissa IS NULL)
          AND (quote_id IS NULL) = (rate_scale IS NULL)
          AND (quote_id IS NULL) = (source IS NULL)
          AND (quote_id IS NULL) = (fetched_at IS NULL)
          AND (quote_id IS NULL) = (policy_version IS NULL)
          AND (rate_mantissa IS NULL OR rate_mantissa > 0)
          AND (rate_scale IS NULL OR rate_scale BETWEEN 0 AND 8)
          AND (quote_id IS NULL OR length(quote_id) BETWEEN 1 AND 96)
          AND (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 64)
          AND (refresh_claim_token IS NULL OR length(refresh_claim_token) BETWEEN 1 AND 64)
          AND (refresh_claimed_until IS NULL) = (refresh_claim_token IS NULL)`,
    ),
  ],
);

/**
 * What each FX source last did for a tenant (package FX): for the operator's
 * diagnostics, and for the one decision shared across replicas — a source that
 * answered "rate limited" is not asked again before `retry_after`, whichever replica
 * asks. Latest state only; the events that describe outages are in the operational log.
 */
export const fxSourceStates = pgTable(
  'fx_source_states',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    source: text('source').notNull(),
    lastSuccessAt: timestamptz('last_success_at'),
    lastFailureAt: timestamptz('last_failure_at'),
    lastFailureCode: text('last_failure_code'),
    retryAfter: timestamptz('retry_after'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'fx_source_states_pk', columns: [table.tenantId, table.source] }),
    check('fx_source_states_source_check', enumCheck('source', FX_SOURCES)),
    check('fx_source_states_failures_check', sql`consecutive_failures >= 0`),
    check(
      'fx_source_states_failure_code_check',
      sql`last_failure_code IS NULL OR length(last_failure_code) BETWEEN 1 AND 64`,
    ),
  ],
);

/**
 * Money going back, as a row with a lifecycle.
 *
 * ## Why this is a table and not a column on `payments`
 *
 * A payment can be refunded MORE THAN ONCE — partially, by different operators, at
 * different times — so "was this refunded" is a sum rather than a flag. A boolean would
 * answer it wrongly the first time somebody refunds half.
 *
 * ## The refundable balance is derived, never stored
 *
 * There is no `refunded_amount` column on `payments`, deliberately, and it is the same
 * rule `CLAUDE.md` states about a wallet balance: the amount consumed is
 * `SUM(amount) WHERE state IN REFUND_CONSUMING_STATES`, computed inside the transaction
 * that needs it. A cached total is a second place for the truth to live, and the legacy
 * system's mutable balance column is the failure that rule exists to prevent.
 *
 * ## What the append-only guard allows and forbids
 *
 * A refund's state DOES change — that is its whole life — so this table is not
 * `payment_receipts`, which forbids UPDATE outright. `nexa_refunds_guard` freezes
 * everything that says WHAT was refunded (the payment, the customer, the amount, the
 * currency, the channel, the requester) and lets the lifecycle columns move. A refund
 * whose amount could be edited after the fact is a reviewer's evidence changing
 * underneath the decision made on it.
 */
export const refunds = pgTable(
  'refunds',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** The CONFIRMED payment this reverses. A refund with no payment has nothing to bound it. */
    paymentId: uuid('payment_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    /** Copied from the payment, so a refund report needs no join to say what was bought. */
    orderId: uuid('order_id'),
    state: text('state').notNull().default('REQUESTED'),
    /** Derived from the payment's method by `REFUND_METHOD_SUPPORT`, never operator-chosen. */
    channel: text('channel').notNull(),
    /**
     * Minor units, positive, with its currency beside it.
     *
     * The currency is STORED rather than joined from the payment, and that is the
     * money-convention rule rather than denormalisation for speed: `CLAUDE.md` says
     * never an amount without a currency, and a refund row that had to reach for one
     * could be read in isolation and misunderstood.
     */
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    /** The operator's own words. Required — a refund with no reason is unreviewable. */
    reason: text('reason').notNull(),
    /** Who decided. Null only for a refund no administrator requested, which nothing produces. */
    requestedByAdminId: uuid('requested_by_admin_id'),
    /**
     * Who recorded that the money actually left, and when.
     *
     * For the manual channel these two are the ONLY evidence the transfer happened, and
     * they are why `AWAITING_EXTERNAL` exists: this installation has no bank API, so a
     * person is the mechanism and their name and the time are the record of it.
     */
    completedByAdminId: uuid('completed_by_admin_id'),
    completedAt: timestamptz('completed_at'),
    /** The bank reference, when there is one. A cash refund across a counter has none. */
    externalReference: text('external_reference'),
    /** What the completing operator wrote, or why a refund was abandoned. */
    completionNote: text('completion_note'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    /** The payment's refund history, and the SUM the refundable balance is derived from. */
    index('refunds_tenant_payment_idx').on(table.tenantId, table.paymentId, table.createdAt),
    /** A customer's refunds, for the account view. */
    index('refunds_tenant_customer_idx').on(table.tenantId, table.customerId, table.createdAt),
    check('refunds_state_check', enumCheck('state', REFUND_STATES)),
    check('refunds_channel_check', enumCheck('channel', REFUND_CHANNELS)),
    check('refunds_currency_check', enumCheck('currency', CURRENCY_CODES)),
    /**
     * A refund is for a POSITIVE amount. Zero is not a refund and negative is a charge.
     *
     * `refundFitsWithin` refuses both at the boundary; this is the same rule where a
     * hand-written UPDATE meets it, which is the argument `payment_accounts` makes about
     * a repair script run at 3am.
     */
    check('refunds_amount_check', sql`amount > 0`),
    check('refunds_reason_check', sql`length(btrim(reason)) BETWEEN 3 AND 500`),
    check(
      'refunds_external_reference_check',
      sql`external_reference IS NULL OR length(btrim(external_reference)) BETWEEN 1 AND 140`,
    ),
    /**
     * COMPLETED means completed AT a time. Always.
     *
     * The rule `payments_confirmed_check` states for a confirmation, applied to the one
     * transition that means money is gone: a row cannot claim COMPLETED with no
     * timestamp, which is the "money marked returned because a refund was requested"
     * defect this whole lifecycle exists to prevent.
     */
    check('refunds_completed_check', sql`(state = 'COMPLETED') = (completed_at IS NOT NULL)`),
    /**
     * And BY somebody, when somebody asked for it.
     *
     * Split from the check above, because the two halves stopped being one rule.
     * A refund an OPERATOR requested is completed by an operator, and naming them is
     * the whole audit value — that half is unchanged and is enforced here.
     *
     * An AUTOMATIC refund has no operator on either side. Nobody requested it: a
     * settlement or a provisioner discovered that what a customer paid for cannot be
     * delivered, and the money went back in that transaction.
     * `requested_by_admin_id IS NULL` is what identifies one, and it cannot be an
     * operator's refund with the field forgotten — `RefundService.request` is guarded
     * by `refunds.issue`, which `SYSTEM_JOB_PERMISSIONS` does not carry, so every
     * operator refund has an administrator behind it by construction.
     *
     * Writing an admin id into an automatic refund to satisfy the old single check
     * was the alternative, and it is the one this codebase forbids outright: a
     * fabricated actor on a money record, attributing a decision to whoever happened
     * to press approve on an unrelated transfer.
     */
    check(
      'refunds_operator_completion_check',
      sql`(state = 'COMPLETED' AND requested_by_admin_id IS NOT NULL) = (completed_by_admin_id IS NOT NULL)`,
    ),
    foreignKey({
      name: 'refunds_payment_fk',
      columns: [table.tenantId, table.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
    }),
    unique('refunds_tenant_id_key').on(table.tenantId, table.id),
  ],
);

/**
 * The window in which a photo from this customer attaches to a payment.
 *
 * A ROW rather than a column on `payments`, and that is the load-bearing choice: a
 * customer may hold several pending payments, so "which payment does this image belong
 * to" has to be answerable from the CUSTOMER — which is what an inbound Telegram photo
 * identifies — rather than from a payment somebody guessed.
 *
 * ## Why this is not the prompt capture that destroyed a production setting
 *
 * `INCIDENT-FIN-001` records an ADMIN prompt that swallowed a typed navigation string
 * and overwrote a gateway's tutorial text, and earlier directives forbade conversational
 * prompt capture in its general form. They still do. Four properties make this narrower,
 * and all four are in the schema rather than in a docstring:
 *
 * 1. it names ONE payment, stored here, so there is no "current prompt" a later message
 *    can land in;
 * 2. it can attach a PHOTO or a DOCUMENT and nothing else — the routing never consults
 *    it for a text message, so `/start`, the menu labels and every other typed thing
 *    route exactly as they do today;
 * 3. it is customer-side: the only thing it can write is a `payment_receipts` row;
 * 4. it EXPIRES, and `receipt_captures_expiry_check` refuses a window that outlives its
 *    own opening.
 *
 * One open window per customer per bot is a partial unique index, not a service rule.
 * Opening a second closes the first as SUPERSEDED in the same transaction.
 */
export const receiptCaptures = pgTable(
  'receipt_captures',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /**
     * WHICH bot the customer is talking to.
     *
     * A tenant may run a public bot and a reseller bot, and a window opened in one must
     * not be filled by a photo sent to the other: the customer is a different chat there
     * and the file id belongs to a different bot.
     */
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    customerId: uuid('customer_id').notNull(),
    paymentId: uuid('payment_id').notNull(),
    openedAt: timestamptz('opened_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at').notNull(),
    /** Null while open. The partial unique index below is keyed on exactly this. */
    closedAt: timestamptz('closed_at'),
    closeReason: text('close_reason'),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'receipt_captures_customer_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
      name: 'receipt_captures_payment_fk',
    }),
    /**
     * ONE open window per customer per bot, decided by the database.
     *
     * Two taps on two different invoices arriving together both read "nothing open". A
     * service check answers both yes and the second photo attaches to whichever row the
     * planner returns first, which is a receipt filed against a payment the customer was
     * not looking at.
     */
    uniqueIndex('receipt_captures_open_key')
      .on(table.tenantId, table.botInstanceId, table.customerId)
      .where(sql`closed_at IS NULL`),
    /** The sweep's index: windows past their deadline that nobody has closed. */
    index('receipt_captures_due_idx')
      .on(table.tenantId, table.expiresAt)
      .where(sql`closed_at IS NULL`),
    check(
      'receipt_captures_close_reason_check',
      nullableEnumCheck('close_reason', RECEIPT_CAPTURE_CLOSE_REASONS),
    ),
    /** A closed window has a reason, and an open one has neither. Both halves. */
    check('receipt_captures_closed_check', sql`(closed_at IS NULL) = (close_reason IS NULL)`),
    check('receipt_captures_expiry_check', sql`expires_at > opened_at`),
    unique('receipt_captures_tenant_id_key').on(table.tenantId, table.id),
  ],
);

/**
 * The window in which ONE administrator's next plain message is read as an amount to credit
 * from ONE receipt (Payment File 02 §12, `docs/payments-file02-design.md` D3).
 *
 * `receipt_captures`, turned round to face the reviewer. `INCIDENT-FIN-001` is an ADMIN
 * prompt that swallowed a typed navigation string and overwrote a production setting, and
 * credit-to-wallet genuinely needs a typed amount, so the prompt is a ROW with the four
 * properties that one lacked, all of them here rather than in a docstring:
 *
 * 1. it names ONE administrator, ONE bot and ONE payment, so there is no "current prompt"
 *    another person's message, or a message about another payment, can land in;
 * 2. it reads ONE amount: once `amount_minor` is set it no longer reads messages, so a
 *    second number typed after the confirmation was drawn cannot change what the button
 *    confirms — to change the figure, the reviewer cancels and starts again;
 * 3. the amount moves nothing by itself: a separate confirm, carrying this row's id,
 *    calls `ReceiptDispositionService.creditToWallet` under a key derived from the id;
 * 4. it EXPIRES, and the CHECK refuses a window that outlives its own opening.
 *
 * One open capture per administrator per bot is a partial unique index. Opening another
 * closes the first as SUPERSEDED in the same transaction.
 */
export const adminAmountCaptures = pgTable(
  'admin_amount_captures',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** WHICH bot the administrator is talking to, for `receipt_captures`' reason. */
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    adminId: uuid('admin_id').notNull(),
    /**
     * WHAT the capture is about — a payment for the three receipt purposes, a customer for
     * `CUSTOMER_BLOCK_REASON` (WP10G). Exactly one is set, per purpose, and the target CHECK
     * below says which; the composite foreign keys keep both inside the tenant. `payment_id`
     * was NOT NULL until 0121, when the customers section's block joined this table rather
     * than open a sibling one: the partial unique index on (tenant, bot, admin) is what makes
     * "one open prompt per administrator per bot" a database fact, and only one table can
     * carry it.
     */
    paymentId: uuid('payment_id'),
    customerId: uuid('customer_id'),
    /**
     * WP19: the customer's service refund request an approval amount or a rejection reason
     * is for. Set for exactly the two `SERVICE_REFUND_*` purposes, and for nothing else.
     */
    serviceRefundRequestId: uuid('service_refund_request_id'),
    /**
     * The amount the administrator typed, in minor units of the PAYMENT's currency. Null
     * until they have typed one; set once. Not money on its own — nothing is credited
     * until the confirm, and the credit's own row carries its currency.
     */
    amountMinor: bigint('amount_minor', { mode: 'bigint' }),
    /**
     * WHAT the capture reads (WP10 follow-up §4): the credit's amount, Block User's mandatory
     * reason, a rejection's mandatory reason (File 01 §7), or the mandatory reason of a block
     * from the customers section (WP10G). One table for all of them, because the partial unique
     * index below is what makes "one open prompt per administrator per bot" a database fact
     * across every purpose. Defaulted, so every row written before the column existed is a
     * credit's.
     */
    purpose: text('purpose').notNull().default('RECEIPT_CREDIT_AMOUNT'),
    /**
     * The block's or the rejection's reason as the administrator typed it, trimmed. Set once,
     * like `amount_minor`; null for a credit capture. It becomes the customer's
     * `blocked_reason` or the payment's `resolution_note`, and the customer is shown it.
     */
    reason: text('reason'),
    openedAt: timestamptz('opened_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at').notNull(),
    closedAt: timestamptz('closed_at'),
    closeReason: text('close_reason'),
    /**
     * WP19: the Telegram `update_id` of the tap that opened the prompt, for the two
     * `SERVICE_REFUND_*` purposes. A prompt reads only messages NEWER than it: update ids
     * increase per bot, so a redelivered message typed before the tap — for this prompt's
     * predecessor or for any other kind of prompt — cannot become this one's reason, and a
     * rejection is decided on its reason at once (Codex review of #83, round 5). Null for
     * every other purpose, and for a prompt opened with no update behind it.
     */
    openedUpdateId: bigint('opened_update_id', { mode: 'bigint' }),
    /**
     * Spec §7: the client app whose tutorial video a `CLIENT_APP_VIDEO` prompt reads, and
     * set for that purpose only. Deleting the app deletes its open prompt with it.
     */
    clientAppId: uuid('client_app_id'),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.adminId],
      foreignColumns: [admins.tenantId, admins.id],
      name: 'admin_amount_captures_admin_fk',
    }),
    // Declared further down this file; the builder runs lazily, after it exists.
    foreignKey({
      columns: [table.tenantId, table.clientAppId],
      foreignColumns: [clientApps.tenantId, clientApps.id],
      name: 'admin_amount_captures_client_app_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.tenantId, table.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
      name: 'admin_amount_captures_payment_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'admin_amount_captures_customer_fk',
    }),
    // Declared at the end of this file; the builder runs lazily, after it exists.
    foreignKey({
      columns: [table.tenantId, table.serviceRefundRequestId],
      foreignColumns: [serviceRefundRequests.tenantId, serviceRefundRequests.id],
      name: 'admin_amount_captures_refund_request_fk',
    }),
    /**
     * Each purpose names exactly its own target: a receipt purpose a payment and never a
     * customer, the customers section's block a customer and never a payment. Every row written
     * before 0121 is a receipt purpose with a payment, so the constraint held on arrival.
     */
    check(
      'admin_amount_captures_target_check',
      sql`(purpose IN ('RECEIPT_CREDIT_AMOUNT', 'RECEIPT_BLOCK_REASON', 'RECEIPT_REJECT_REASON')
            AND payment_id IS NOT NULL AND customer_id IS NULL AND service_refund_request_id IS NULL
            AND client_app_id IS NULL)
          OR (purpose = 'CUSTOMER_BLOCK_REASON' AND customer_id IS NOT NULL AND payment_id IS NULL
            AND service_refund_request_id IS NULL AND client_app_id IS NULL)
          OR (purpose IN ('SERVICE_REFUND_AMOUNT', 'SERVICE_REFUND_REJECT_REASON')
            AND service_refund_request_id IS NOT NULL AND payment_id IS NULL AND customer_id IS NULL
            AND client_app_id IS NULL)
          OR (purpose = 'CLIENT_APP_VIDEO' AND client_app_id IS NOT NULL AND payment_id IS NULL
            AND customer_id IS NULL AND service_refund_request_id IS NULL)`,
    ),
    /** ONE open capture per administrator per bot, decided by the database. */
    uniqueIndex('admin_amount_captures_open_key')
      .on(table.tenantId, table.botInstanceId, table.adminId)
      .where(sql`closed_at IS NULL`),
    check(
      'admin_amount_captures_close_reason_check',
      nullableEnumCheck('close_reason', ADMIN_AMOUNT_CAPTURE_CLOSE_REASONS),
    ),
    check('admin_amount_captures_closed_check', sql`(closed_at IS NULL) = (close_reason IS NULL)`),
    check('admin_amount_captures_expiry_check', sql`expires_at > opened_at`),
    check('admin_amount_captures_amount_check', sql`amount_minor IS NULL OR amount_minor > 0`),
    /**
     * A confirmation confirms what the capture read: an amount for a credit, a reason for a
     * block or a rejection. There is no CONFIRMED row without it — and for those two that is
     * the database half of "the reason is mandatory".
     */
    check(
      'admin_amount_captures_confirmed_check',
      sql`close_reason IS DISTINCT FROM 'CONFIRMED'
          OR (purpose IN ('RECEIPT_CREDIT_AMOUNT', 'SERVICE_REFUND_AMOUNT') AND amount_minor IS NOT NULL)
          OR (purpose IN ('RECEIPT_BLOCK_REASON', 'RECEIPT_REJECT_REASON', 'CUSTOMER_BLOCK_REASON', 'SERVICE_REFUND_REJECT_REASON') AND reason IS NOT NULL)
          OR purpose = 'CLIENT_APP_VIDEO'`,
    ),
    check('admin_amount_captures_purpose_check', enumCheck('purpose', ADMIN_CAPTURE_PURPOSES)),
    /** Each purpose reads its own column and never the other's. */
    check(
      'admin_amount_captures_purpose_column_check',
      sql`(purpose IN ('RECEIPT_CREDIT_AMOUNT', 'SERVICE_REFUND_AMOUNT') AND reason IS NULL)
          OR (purpose IN ('RECEIPT_BLOCK_REASON', 'RECEIPT_REJECT_REASON', 'CUSTOMER_BLOCK_REASON', 'SERVICE_REFUND_REJECT_REASON') AND amount_minor IS NULL)
          OR (purpose = 'CLIENT_APP_VIDEO' AND amount_minor IS NULL AND reason IS NULL)`,
    ),
    check(
      'admin_amount_captures_reason_check',
      sql`reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND ${sql.raw(String(ADMIN_CAPTURE_REASON_MAX_LENGTH))}`,
    ),
  ],
);

/**
 * One receipt a customer sent, bound to exactly one payment.
 *
 * The BINDING lives here; the bytes live at Telegram. This installation stores the two
 * identifiers Telegram gives it — `file_id`, which `getFile` takes and which is scoped to
 * one bot, and `file_unique_id`, which is stable and is what the dedupe is keyed on — and
 * the Web Admin fetches the image through the API, which holds the bot token.
 *
 * That is a real limitation written down rather than discovered: a backup carries this
 * row and not the image, and a revoked bot token makes an old file unfetchable. The
 * alternative is a blob store this deployment does not have.
 *
 * Append-only by trigger. A receipt is evidence somebody will look at when deciding
 * whether money arrived, and evidence that can be edited afterwards is the legacy
 * `/admin/logs` with a picture attached.
 */
export const paymentReceipts = pgTable(
  'payment_receipts',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    customerId: uuid('customer_id').notNull(),
    paymentId: uuid('payment_id').notNull(),
    kind: text('kind').notNull(),
    /** What `getFile` takes. Bot-scoped, and never returned to a browser. */
    fileId: text('file_id').notNull(),
    /** Stable across re-sends of the same file, and the dedupe key. */
    fileUniqueId: text('file_unique_id').notNull(),
    mimeType: text('mime_type'),
    fileSize: bigint('file_size', { mode: 'bigint' }),
    fileName: text('file_name'),
    /** Which message carried it, so an operator can find it in the chat if they must. */
    telegramMessageId: bigint('telegram_message_id', { mode: 'bigint' }),
    /**
     * The caption the customer sent with the file, trimmed, or NULL for none (Payment
     * File 02 §10, D3). CUSTOMER text: rendered into the reviewer's Telegram caption and
     * nowhere else, never logged, and never returned to a browser.
     */
    caption: text('caption'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'payment_receipts_customer_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
      name: 'payment_receipts_payment_fk',
    }),
    /**
     * The SAME file attaches once.
     *
     * Telegram redelivers an update whose reply this installation did not acknowledge in
     * time, and a customer who taps forward twice sends the same file twice.
     * `file_unique_id` is stable across both, so this is what makes an upload
     * effectively-once without a second idempotency mechanism.
     */
    uniqueIndex('payment_receipts_file_key').on(
      table.tenantId,
      table.paymentId,
      table.fileUniqueId,
    ),
    /** The reviewer's read: everything filed against one payment, oldest first. */
    index('payment_receipts_payment_idx').on(table.tenantId, table.paymentId, table.createdAt),
    check('payment_receipts_kind_check', enumCheck('kind', PAYMENT_RECEIPT_KINDS)),
    check('payment_receipts_size_check', sql`file_size IS NULL OR file_size > 0`),
    check(
      'payment_receipts_caption_check',
      sql`caption IS NULL OR length(caption) BETWEEN 1 AND ${sql.raw(String(RECEIPT_CAPTION_MAX_LENGTH))}`,
    ),
    unique('payment_receipts_tenant_id_key').on(table.tenantId, table.id),
  ],
);

/**
 * What ONE customer was told, frozen at the moment the payment was issued.
 *
 * A separate table rather than columns on `payments`, and not by taste. A CHECK binding a
 * destination to `method = 'MANUAL_TRANSFER'` would have to be an IMPLICATION rather than
 * an equality, because every manual-transfer payment issued before this migration has no
 * destination — and an implication is exactly the "two columns that can disagree" shape
 * `payments_confirmed_check` exists to refuse. Here the absence is the absence of a row.
 *
 * Append-only by trigger, like `audit_logs` (see the migration). A destination that could
 * be edited after issuance is the defect this whole subphase removes, reintroduced one
 * layer down.
 *
 * `account_id` is provenance and nothing else. Every field a customer needs is COPIED
 * here, so the rendering never joins back to a row an operator may since have changed.
 */
export const paymentDestinations = pgTable(
  'payment_destinations',
  {
    /** One destination per payment. The payment IS the identity. */
    paymentId: uuid('payment_id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** Which account this was taken from. Never read to render; read to reconcile. */
    accountId: uuid('account_id').notNull(),
    label: text('label').notNull(),
    bankName: text('bank_name').notNull(),
    holderName: text('holder_name').notNull(),
    cardNumber: text('card_number').notNull(),
    iban: text('iban'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    /*
     * The payment travels WITH its tenant, and so does the account.
     *
     * Two composite foreign keys rather than two plain ones, for the reason
     * `payments_order_fk` gives: without the tenant column in the key, a destination row
     * could name one tenant's payment and another tenant's account, and the render would
     * print a card number belonging to somebody else's installation.
     */
    foreignKey({
      columns: [table.tenantId, table.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
      name: 'payment_destinations_payment_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.accountId],
      foreignColumns: [paymentAccounts.tenantId, paymentAccounts.id],
      name: 'payment_destinations_account_fk',
    }),
    /** The operator's question: which payments were issued against this account? */
    index('payment_destinations_account_idx').on(table.tenantId, table.accountId),
    check('payment_destinations_card_number_check', sql`card_number ~ '^[0-9]{16}$'`),
    check('payment_destinations_iban_check', sql`iban IS NULL OR iban ~ '^IR[0-9]{24}$'`),
  ],
);

/**
 * The wallet ledger — append-only, and the only authority on a balance.
 *
 * There is no balance column anywhere in this schema. A balance is
 * `SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END)` over a customer's
 * entries, and the index below is what makes that a single ranged scan. The legacy
 * system's mutable balance column with no ledger is what produces its unexplained
 * 916,550 residual.
 *
 * `amount` is always POSITIVE and `direction` carries the sign, which `ledger.ts`
 * fixes. A signed amount column would let a CREDIT of -500 express a debit, and then
 * two representations of one movement exist.
 *
 * `reference` is the idempotency identity of a MOVEMENT, unique per tenant. It is what
 * makes a double debit impossible under a retried command: the second insert violates
 * the index and the whole transaction rolls back.
 *
 * The table is append-only by trigger, like `audit_logs` — see the migration. A reversal
 * is a new entry naming the original in `reverses_entry_id`, never an edit.
 */
export const walletEntries = pgTable(
  'wallet_entries',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    direction: text('direction').notNull(),
    reason: text('reason').notNull(),
    /** Always positive. The sign lives in `direction`. */
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    /** The movement's idempotency identity, unique per tenant. */
    reference: text('reference').notNull(),
    /** Set for a `REVERSAL_REASONS` entry, naming the entry it reverses. */
    reversesEntryId: uuid('reverses_entry_id'),
    orderId: uuid('order_id'),
    paymentId: uuid('payment_id'),
    /** Who caused it, when that was an administrator rather than a flow. */
    actorAdminId: uuid('actor_admin_id').references(() => admins.id),
    /** Bounded operator note. Never customer text. */
    note: text('note'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'wallet_entries_customer_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
      name: 'wallet_entries_order_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
      name: 'wallet_entries_payment_fk',
    }),
    /** The one thing that makes a double debit impossible rather than unlikely. */
    uniqueIndex('wallet_entries_tenant_reference_key').on(table.tenantId, table.reference),
    /**
     * The balance scan, and the history page, in one index.
     *
     * `(customer_id, created_at, id)` — the sum reads the whole of a customer's slice
     * and the page reads the tail of it, so one index serves both and neither needs a
     * sort.
     */
    index('wallet_entries_customer_created_idx').on(table.customerId, table.createdAt, table.id),
    index('wallet_entries_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
    check('wallet_entries_direction_check', enumCheck('direction', LEDGER_DIRECTIONS)),
    check('wallet_entries_reason_check', enumCheck('reason', LEDGER_REASONS)),
    check('wallet_entries_currency_check', enumCheck('currency', CURRENCY_CODES)),
    /** Positive, always. This is the invariant the whole ledger rests on. */
    check('wallet_entries_amount_check', sql`amount > 0`),
    /**
     * A top-up credit names the payment that funded it.
     *
     * `TOPUP_RECEIPT` is the ledger's answer to "where did this money come from", and
     * without the payment it answers "a transfer, some time, decided by somebody". The
     * column has existed since 4C; this is what makes it required for the one reason
     * whose whole meaning is the payment.
     */
    check(
      'wallet_entries_topup_payment_check',
      sql`reason <> 'TOPUP_RECEIPT' OR payment_id IS NOT NULL`,
    ),
    /**
     * ONE top-up credit per payment, decided by the database.
     *
     * The rule 5B rests on, and it is keyed on the PAYMENT rather than on the
     * confirming command: two operators pressing approve together, a redelivered
     * request, a retry after a crash between the confirm and the append — and a future
     * gateway callback funding the same top-up — all name the same payment, so all but
     * one of them conflict here. The derived reference in `WalletTopupService` produces
     * the same guarantee from the other direction; this is the one a convenience
     * refactor cannot remove by accident.
     */
    uniqueIndex('wallet_entries_topup_payment_key')
      .on(table.tenantId, table.paymentId)
      .where(sql`reason = 'TOPUP_RECEIPT'`),
    /**
     * A receipt credit names the payment whose receipt it disposed of (Payment File 02
     * §12, D2). The top-up rule above, for the second reason whose whole meaning is a
     * payment.
     */
    check(
      'wallet_entries_receipt_credit_payment_check',
      sql`reason <> 'RECEIPT_CREDIT' OR payment_id IS NOT NULL`,
    ),
    /**
     * ONE receipt credit per payment, decided by the database — invariant 8 of Payment
     * File 02 §23, held here on its own and again by `receipt_credits`' primary key. Two
     * reviewers crediting together, a retry, and a writer that forgot the disposition row
     * all name the same payment. `<paymentId>:receipt-credit` gives the same guarantee
     * through the reference key; this is the one a change to the reference cannot remove.
     */
    uniqueIndex('wallet_entries_receipt_credit_payment_key')
      .on(table.tenantId, table.paymentId)
      .where(sql`reason = 'RECEIPT_CREDIT'`),
    /**
     * A top-up gift names the top-up that earned it (D5), and there is ONE per payment:
     * invariant 11. A replayed confirmation, a racing one and a future gateway callback
     * all name the same payment, so all but one conflict here.
     */
    check(
      'wallet_entries_topup_cashback_payment_check',
      sql`reason <> 'CASHBACK_TOPUP' OR payment_id IS NOT NULL`,
    ),
    uniqueIndex('wallet_entries_topup_cashback_payment_key')
      .on(table.tenantId, table.paymentId)
      .where(sql`reason = 'CASHBACK_TOPUP'`),
    /**
     * A GATEWAY top-up credit (WP11A) names its payment and is once per payment: the
     * `TOPUP_RECEIPT` pair, for the reason whose whole meaning is a gateway's payment. A
     * webhook, an inquiry and a racing settlement all name the same payment, so all but
     * one conflict here.
     */
    check(
      'wallet_entries_topup_gateway_payment_check',
      sql`reason <> 'TOPUP_GATEWAY' OR payment_id IS NOT NULL`,
    ),
    uniqueIndex('wallet_entries_topup_gateway_payment_key')
      .on(table.tenantId, table.paymentId)
      .where(sql`reason = 'TOPUP_GATEWAY'`),
    /**
     * Migration P2: a legacy opening balance and its reference prefix are ONE thing.
     *
     * In both directions. A `MIGRATION_OPENING_BALANCE` entry is written under
     * `legacy:opening:<telegram_user_id>` and nothing else, so its idempotency identity is
     * the legacy identity; and the prefix belongs to that reason alone, so no other writer
     * can occupy the reference a rerun of the import would conflict on and turn the
     * opening into a silent no-op. It names no order, payment, reversal or administrator:
     * it is an inherited balance, not a sale, a top-up, an undo or an operator's grant.
     * `left(...)` rather than `LIKE`, whose `_` would be a wildcard.
     */
    check(
      'wallet_entries_migration_opening_shape_check',
      sql`(reason = 'MIGRATION_OPENING_BALANCE') = (left(reference, 15) = 'legacy:opening:')
        AND (reason <> 'MIGRATION_OPENING_BALANCE' OR (order_id IS NULL AND payment_id IS NULL
          AND reverses_entry_id IS NULL AND actor_admin_id IS NULL))`,
    ),
    /**
     * ONE opening balance per customer, decided by the database. The reference key above
     * already makes one per Telegram id; this is the rule stated about the CUSTOMER, so a
     * writer that derived the reference from anything else still cannot open a wallet twice.
     */
    uniqueIndex('wallet_entries_migration_opening_customer_key')
      .on(table.tenantId, table.customerId)
      .where(sql`reason = 'MIGRATION_OPENING_BALANCE'`),
    unique('wallet_entries_tenant_id_key').on(table.tenantId, table.id),
  ],
);

/**
 * A card-to-card receipt's credit-to-wallet disposition (Payment File 02 §12,
 * `docs/payments-file02-design.md` D2).
 *
 * One of a receipt's three mutually exclusive final dispositions — approve, reject, or
 * this — and the only one that needs its own row: approve and reject are the payment's
 * own CONFIRMED and FAILED. A credit moves the payment `PENDING -> FAILED` through the
 * same conditional UPDATE a rejection uses, and this row records what that FAILED
 * meant: the reviewer judged `amount` arrived and put exactly that on the wallet under
 * `RECEIPT_CREDIT`.
 *
 * Keyed by `(tenant_id, payment_id)`: at most one per payment, which is invariant 8, and
 * held again on its own by `wallet_entries_receipt_credit_payment_key` on the money.
 *
 * Append-only (0114): no UPDATE and no DELETE. The same migration refuses a row whose
 * payment is not a FAILED manual transfer, or whose entry is not that payment's
 * `RECEIPT_CREDIT` CREDIT of the same amount and currency — facts about other tables a
 * CHECK cannot read.
 */
export const receiptCredits = pgTable(
  'receipt_credits',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    paymentId: uuid('payment_id').notNull(),
    /**
     * What was credited: the reviewer's figure, in the PAYMENT's currency. Stored rather
     * than joined, for the rule `refunds` states — never an amount without its currency,
     * readable on its own — and checked against the ledger entry by 0114.
     */
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    /** The `RECEIPT_CREDIT` ledger entry this disposition wrote. */
    walletEntryId: uuid('wallet_entry_id').notNull(),
    /** The reviewer. NOT NULL: a decision about somebody's money with nobody named is not one. */
    decidedByAdminId: uuid('decided_by_admin_id')
      .notNull()
      .references(() => admins.id),
    decidedAt: timestamptz('decided_at').notNull(),
    /** The reviewer's own words, bounded. Never customer text. */
    note: text('note'),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.paymentId],
      name: 'receipt_credits_pkey',
    }),
    foreignKey({
      columns: [table.tenantId, table.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
      name: 'receipt_credits_payment_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.walletEntryId],
      foreignColumns: [walletEntries.tenantId, walletEntries.id],
      name: 'receipt_credits_entry_fk',
    }),
    check('receipt_credits_amount_check', sql`amount > 0`),
    check('receipt_credits_currency_check', enumCheck('currency', CURRENCY_CODES)),
    check(
      'receipt_credits_note_check',
      sql`note IS NULL OR length(btrim(note)) BETWEEN 1 AND ${sql.raw(String(RECEIPT_CREDIT_NOTE_MAX_LENGTH))}`,
    ),
  ],
);

/**
 * One administrator's push of one card-to-card receipt (WP10 follow-up, ADR-0031).
 *
 * File 01 §3: a receipt is sent to the authorized administrators in Telegram, as ONE message
 * — the file, the context in its caption, the decisions as its buttons. The pull queue stays;
 * this is the push beside it, and the queue is where a lost push is recovered.
 *
 * A row per (receipt, administrator), written by the `PaymentReceiptSubmitted` consumer in the
 * relay's transaction — never in the transaction that filed the receipt, so no failure here can
 * roll a receipt back. The unique key is the idempotency of the whole lane: an outbox
 * redelivery, a replayed consumer and two worker replicas all land on the row that exists.
 *
 * Neither the customer lane nor the operator lane: `customer_notifications` is one row per
 * SUBJECT addressed to a customer, and `notifications` has no UNKNOWN outcome and re-sends a
 * timeout — a second copy of a receipt with live buttons is the spam the owner forbade. So the
 * customer lane's outcome table (ADR-0030 §2) is taken here, for an administrator.
 */
export const receiptReviewPushes = pgTable(
  'receipt_review_pushes',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    paymentId: uuid('payment_id').notNull(),
    receiptId: uuid('receipt_id').notNull(),
    adminId: uuid('admin_id').notNull(),
    /**
     * The bot that RECEIVED the receipt, copied from its row: a `file_id` belongs to that
     * bot, and the push must come from it.
     */
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    state: text('state').notNull().default('PENDING'),
    /** Definite refusals spent. A rate limit spends none. */
    attempts: integer('attempts').notNull().default(0),
    /** When the dispatcher may next try; also the claim's lease. Null means now. */
    nextAttemptAt: timestamptz('next_attempt_at'),
    /**
     * Set just before the send and cleared by every recorded outcome, so a set value is a
     * send whose process may have died after Telegram took it. The reaper turns such a row
     * UNKNOWN — never recorded as delivered, and nothing re-sends it.
     */
    sendStartedAt: timestamptz('send_started_at'),
    /** The chat actually addressed, stamped at send from the binding current THEN. */
    chatId: text('chat_id'),
    /** Why the row is not SENT, as a machine code. Never a sentence, never customer text. */
    lastErrorCode: text('last_error_code'),
    resolvedAt: timestamptz('resolved_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    /** One push per receipt per administrator, for ever. */
    unique('receipt_review_pushes_receipt_admin_key').on(
      table.tenantId,
      table.receiptId,
      table.adminId,
    ),
    foreignKey({
      columns: [table.tenantId, table.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
      name: 'receipt_review_pushes_payment_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.receiptId],
      foreignColumns: [paymentReceipts.tenantId, paymentReceipts.id],
      name: 'receipt_review_pushes_receipt_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.adminId],
      foreignColumns: [admins.tenantId, admins.id],
      name: 'receipt_review_pushes_admin_fk',
    }),
    /** The dispatcher's claim: queued rows, oldest first. */
    index('receipt_review_pushes_due_idx')
      .on(table.tenantId, table.nextAttemptAt)
      .where(sql`state = 'PENDING'`),
    check('receipt_review_pushes_state_check', enumCheck('state', RECEIPT_REVIEW_PUSH_STATES)),
    check(
      'receipt_review_pushes_resolved_check',
      sql`(state <> 'PENDING') = (resolved_at IS NOT NULL)`,
    ),
    check('receipt_review_pushes_attempts_check', sql`attempts >= 0`),
  ],
);

/**
 * A service — what the customer is entitled to, as Nexa knows it.
 *
 * Nexa is the authority on the entitlement; the provider holds external reality that
 * is RECONCILED into `traffic_used_bytes` and `usage_synced_at`. Both halves matter: a
 * provider treated as authoritative means a panel outage deletes an entitlement, and a
 * provider ignored means billing for something that does not exist.
 *
 * `provider_username` is the name the ORDER reserved — chosen or drawn under
 * `service-username.ts` and frozen before the money moved — and is unique per PANEL,
 * which is the constraint that makes adoption after an unknown outcome safe: a
 * reconcile asks the panel for the name THIS ROW carries, and the index guarantees at
 * most one service claims it. It used to be derived from the service id, which cannot
 * work once a name has to exist before the service does.
 *
 * `usage_synced_at` is nullable and is rendered to the customer beside the figure,
 * because a usage number with no "as of" is a number a customer reads as live.
 */
export const services = pgTable(
  'services',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    /** The order that created it. A renewal is a NEW order against the SAME service. */
    orderId: uuid('order_id').notNull(),
    panelId: uuid('panel_id').notNull(),
    /**
     * Navigation and reporting. The snapshot of what was bought is on the order.
     *
     * NULL exactly when the order that created the service is a `CUSTOM_SERVICE` one
     * (Package D). `nexa_service_requires_purchase_order` pins that pairing, because a
     * CHECK cannot see the order row.
     */
    productId: uuid('product_id'),
    /**
     * R1: this service is a free trial. The database's own answer, not the application's:
     * `nexa_service_requires_purchase_order` sets it on INSERT from the creating order's
     * purpose — whatever the writer passed — and `nexa_services_trial_frozen` refuses to
     * change it afterwards. The DEFAULT is the rollback window: the release before this
     * one inserts without the column, and the trigger still marks its trials.
     */
    isTrial: boolean('is_trial').notNull().default(false),
    state: text('state').notNull().default('PENDING_PROVISION'),
    /** The order's reserved name, frozen before payment. Unique per panel, for adoption. */
    providerUsername: text('provider_username').notNull(),
    /**
     * The `subId` the panel serves this customer's configuration under. A CAPABILITY.
     *
     * Random, 128 bits, chosen HERE and written in the settling transaction. The
     * username beside it is stored in the same transaction but is a different kind of
     * thing, and the distinction is the whole reason this column exists: the username
     * appears in an operator's client list and may be a name the customer picked, while
     * anybody holding this value can fetch the customer's configuration from
     * `https://<subscription domain>/sub/<this>` with no authentication at all.
     *
     * It was derived, through an unkeyed SHA-256 of the service id — and the service id
     * travels in `operational_events.context`, in `audit_logs.entity_id` and in
     * `outbox_messages.aggregate_id`, none of which are places for a credential. Worse,
     * the username was then a reversible encoding of the id rather than a hash, so
     * reading a name off a panel screen recovered the id and therefore the link. The
     * docblocks claimed the opposite in both directions.
     *
     * Stored rather than derived loses nothing: it is written BEFORE any provider call,
     * so a create whose answer was lost can still be reconciled against it — which is
     * the only property the derivation was there to provide.
     *
     * The DEFAULT is the rollback window, not a convenience. `NOT NULL` with no default
     * would narrow what the release before this one can write, which
     * `migration-compatibility.test.ts` forbids by name — so a release rolled back onto
     * this schema keeps inserting, and any row it writes gets a distinct random value
     * rather than a null or a shared sentinel. `ServiceDraft` requires both fields, so
     * nothing in THIS release ever relies on the default.
     */
    subscriptionRef: text('subscription_ref')
      .notNull()
      .default(sql`md5(gen_random_uuid()::text)`),
    /**
     * The client UUID a panel that keys clients by one assigns this service. A
     * CREDENTIAL.
     *
     * 3X-UI's VLESS client id, which the customer's configuration authenticates with.
     * Random and stored for exactly the reasons above; formatted as a v4 UUID because
     * that is what the panels validate.
     */
    providerClientId: uuid('provider_client_id')
      .notNull()
      .default(sql`gen_random_uuid()`),
    /** The provider's own identifier, once a provider has told us one. */
    providerUserId: text('provider_user_id'),
    /**
     * The subscription URL the customer receives.
     *
     * Delivered to its owner by design, so it is stored in the clear — but it is a
     * bearer capability for that one service, which is why no list endpoint returns it
     * and only the owner's own detail view does.
     */
    subscriptionUrl: text('subscription_url'),
    expiresAt: timestamptz('expires_at'),
    /** 0 means unlimited, matching the product snapshot it came from. */
    trafficLimitBytes: bigint('traffic_limit_bytes', { mode: 'bigint' }).notNull(),
    trafficUsedBytes: bigint('traffic_used_bytes', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    /**
     * The device / connection limit this service is entitled to (WP-A5), or NULL when none
     * is recorded — unlimited, or a plan that set none.
     *
     * Seeded from the order's frozen `line_device_limit` when the service is made, and
     * raised ONLY by an `ADD_DEVICES` operation the panel applied, written from the absolute
     * target that operation persisted. It is what the next extra-users purchase is computed
     * from, which is why a purchase is never offered against a NULL: there is no number to
     * add devices to.
     */
    deviceLimit: integer('device_limit'),
    /**
     * Where the service's account sits on its panel, as the panel last reported it (WP-A6),
     * or NULL for a service that has never moved — which is in its panel's INITIAL location,
     * whatever that is configured as today.
     *
     * The adapter-defined key and the customer-facing name, written TOGETHER and only by a
     * `CHANGE_LOCATION` the panel applied: the key from the operation's absolute target, the
     * name from the change request's snapshot. The name is a snapshot for the reason every
     * other one is — an operator renaming a location must not rewrite what a customer's
     * card says their service moved to.
     */
    locationKey: text('location_key'),
    locationLabel: text('location_label'),
    usageSyncedAt: timestamptz('usage_synced_at'),
    /**
     * R3 item 7: a customer's on-tap usage read is in flight, since when — or NULL.
     *
     * The reservation that serialises the refresh button: set by a conditional UPDATE
     * (not in flight, or in flight longer than the read can take; and not read within the
     * minimum interval) in the transaction that takes the panel budget, BEFORE the panel
     * is dialled, and cleared when the read ends. Two taps, or a redelivered update, find
     * one of them holding it and the other redraws the card without dialling.
     */
    usageRefreshStartedAt: timestamptz('usage_refresh_started_at'),
    /**
     * Last connection, as a provider PROVED it (customer UX completion §H). `AT` with a
     * time, or `NEVER`; NULL is "no provider has said" — which is every row today, since
     * every adapter answers UNSUPPORTED and UNSUPPORTED is never stored. The card renders
     * NULL as unavailable and never as «متصل نشده».
     */
    lastSeenAt: timestamptz('last_seen_at'),
    lastSeenState: text('last_seen_state'),
    /** The customer's own note on their service. Display only; never provider identity. */
    customerNote: text('customer_note'),
    /**
     * Whether the customer has been told. A separate axis from `state`, deliberately.
     *
     * A failed Telegram send must leave a paid-for, provider-side account `ACTIVE`;
     * anything else invites re-provisioning a service that already exists.
     */
    deliveryState: text('delivery_state').notNull().default('PENDING'),
    deliveryAttempts: integer('delivery_attempts').notNull().default(0),
    deliveredAt: timestamptz('delivered_at'),
    /** When the delivery sweep may next try. Null means it may try now. */
    deliveryNextAttemptAt: timestamptz('delivery_next_attempt_at'),
    /**
     * When a send was handed to Telegram and no outcome has been recorded yet.
     *
     * `provisioning_operations.call_started_at` for the announcement half, and it exists
     * for the same reason: it is the one fact that distinguishes "this process died
     * before sending" from "this process died after sending", and only the second must
     * never be repeated automatically.
     *
     * Without it a sweep that was killed between the send and `recordDelivery` left the
     * row `PENDING` behind nothing but a lease — so when the lease expired the automatic
     * lane announced again, which is precisely the duplicate the `UNCONFIRMED` state was
     * introduced to prevent. An ordinary container restart was enough.
     *
     * Cleared by every recorded outcome, so a set value always means an unresolved send.
     */
    deliverySendStartedAt: timestamptz('delivery_send_started_at'),
    provisionedAt: timestamptz('provisioned_at'),
    terminatedAt: timestamptz('terminated_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'services_customer_fk',
    }),
    /**
     * The order that bought the service. Two columns since Package F: a service's customer
     * is its order's at CREATION — `nexa_services_ownership_guard` refuses an insert that
     * disagrees — and afterwards changes only through a `service_ownership_transfers` row,
     * which the same trigger requires. The three-column form made the order's customer the
     * owner for ever, which is what a transfer is not (`docs/package-f-service-transfer-audit.md`).
     */
    foreignKey({
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
      name: 'services_order_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.panelId],
      foreignColumns: [panels.tenantId, panels.id],
      name: 'services_panel_fk',
    }),
    /**
     * One provider user per panel.
     *
     * Not per tenant: two tenants may legitimately use the same panel, and the name
     * they would collide on is derived from a service id, so a collision here means two
     * services claim one provider account — which is the duplicate that makes usage
     * figures meaningless.
     */
    uniqueIndex('services_panel_provider_username_key').on(table.panelId, table.providerUsername),
    /**
     * And the subscription reference, for the same reason one step further along.
     *
     * 128 random bits will not collide, and an index is what makes that a guarantee
     * rather than an expectation: two services sharing a `subId` would serve one
     * customer the other's configuration, which is the worst outcome this table has.
     */
    uniqueIndex('services_panel_subscription_ref_key').on(table.panelId, table.subscriptionRef),
    index('services_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
    index('services_tenant_state_idx').on(table.tenantId, table.state),
    index('services_customer_created_idx').on(table.customerId, table.createdAt, table.id),
    /** The expiry sweeper, and the reconciliation queue, each their own partial index. */
    index('services_expiry_idx')
      .on(table.expiresAt)
      .where(sql`state = 'ACTIVE' OR state = 'SUSPENDED'`),
    index('services_unreconciled_idx')
      .on(table.tenantId, table.createdAt)
      .where(sql`state = 'UNRECONCILED'`),
    check('services_state_check', enumCheck('state', SERVICE_STATES)),
    check('services_traffic_check', sql`traffic_limit_bytes >= 0 AND traffic_used_bytes >= 0`),
    check(
      'services_device_limit_check',
      sql`device_limit IS NULL OR (device_limit >= 1 AND device_limit <= 1000)`,
    ),
    /** WP-A6: a location is a key AND a name, or neither. */
    check('services_location_check', sql`(location_key IS NULL) = (location_label IS NULL)`),
    /** The format the panels accept, pinned so a bad generator fails at the write. */
    check('services_subscription_ref_check', sql`subscription_ref ~ '^[0-9a-f]{32}$'`),
    /**
     * A provisioned service has a time; one that never was does not — and a
     * TERMINATED one may be either.
     *
     * The equality without that third clause is a rule `SERVICE_MACHINE`
     * contradicts. The machine has `PENDING_PROVISION -> TERMINATED` and
     * `UNRECONCILED -> TERMINATED`, and `OPERATION_LEGAL_FROM.TERMINATE` names both
     * states deliberately — "a service an operator or a customer has decided to end
     * must be endable whatever went wrong on the way, including one stuck in
     * `UNRECONCILED` after a lost create". Both of those states have a null
     * `provisioned_at` by this very check, so taking either edge moved the state to
     * one side of the equality and left the timestamp on the other, and the UPDATE
     * raised.
     *
     * Nothing had taken those edges. The automatic refund is the first caller: a
     * create that definitively failed leaves a `PENDING_PROVISION` row occupying a
     * capacity slot, and terminating it is how the panel gets the slot back. The
     * suite found this on the first full run, which is the argument for running it.
     *
     * The clause is a carve-out for TERMINATED rather than a loosening of the whole
     * rule: for every state a service can be USED in, the equality still holds, and
     * `services_terminated_at_check` still forces `terminated_at`. What a terminated
     * service's null `provisioned_at` now says is true and worth saying — this one
     * never reached a panel.
     */
    check(
      'services_provisioned_at_check',
      sql`state = 'TERMINATED'
          OR (state = 'PENDING_PROVISION' OR state = 'UNRECONCILED') = (provisioned_at IS NULL)`,
    ),
    check(
      'services_terminated_at_check',
      sql`(state = 'TERMINATED') = (terminated_at IS NOT NULL)`,
    ),
    check(
      'services_last_seen_state_check',
      nullableEnumCheck('last_seen_state', SERVICE_LAST_SEEN_STATES),
    ),
    check(
      'services_last_seen_pair_check',
      sql`(last_seen_state IS NOT DISTINCT FROM 'AT') = (last_seen_at IS NOT NULL)`,
    ),
    check(
      'services_customer_note_check',
      sql`customer_note IS NULL OR length(btrim(customer_note)) BETWEEN 1 AND ${sql.raw(String(SERVICE_NOTE_MAX_LENGTH))}`,
    ),
    /** A usage figure and its "as of" travel together, or the figure is a lie. */
    check(
      'services_usage_synced_check',
      sql`traffic_used_bytes = 0 OR usage_synced_at IS NOT NULL`,
    ),
    check('services_delivery_state_check', enumCheck('delivery_state', SERVICE_DELIVERY_STATES)),
    check(
      'services_delivery_attempts_check',
      sql`delivery_attempts >= 0 AND delivery_attempts <= 100`,
    ),
    /** A delivery time and the state that claims one travel together, or neither is true. */
    check(
      'services_delivered_at_check',
      sql`(delivery_state = 'DELIVERED') = (delivered_at IS NOT NULL)`,
    ),
    /**
     * ONE service per order, as a constraint rather than as worker discipline.
     *
     * This is the exactly-once rule. The service row is written inside the SAME
     * transaction that takes `SETTLE`, so an order settles once and this index says an
     * order produces at most one service — two workers, a replayed command and a
     * double-tapped button all lose here rather than each creating a provider account
     * the customer pays for once and occupies twice.
     *
     * On `(tenant_id, order_id)` and NOT on `(tenant_id, customer_id, product_id)`,
     * because a renewal is a NEW order against the SAME service: a customer may hold
     * two services bought from one product, and must.
     */
    uniqueIndex('services_tenant_order_key').on(table.tenantId, table.orderId),
    /** The delivery sweep: undelivered services whose backoff has elapsed. */
    index('services_delivery_due_idx')
      .on(table.deliveryNextAttemptAt)
      .where(sql`delivery_state = 'PENDING'`),
    unique('services_tenant_id_key').on(table.tenantId, table.id),
    /**
     * Redundant against the primary key. It was the target of the three-column reference
     * `service_commercial_actions` held until Package F, which now references the service
     * by two columns and checks the owner with a trigger at insert.
     *
     * Kept, and not for a reference: `customer_id` being in a unique key is what makes an
     * UPDATE of it take `FOR UPDATE` rather than `FOR NO KEY UPDATE`. So a transfer's
     * reassignment waits for a foreign-key check already in flight on the row — a
     * commercial draft's — and one arriving after it waits for the transfer and then reads
     * the new owner, instead of the two interleaving.
     */
    unique('services_tenant_id_customer_key').on(table.tenantId, table.id, table.customerId),
  ],
);

/**
 * One row per (service, reminder kind, period): "we told them this, about that period".
 *
 * A FACT, not a flag, and the distinction is what makes renewal work. The row records
 * the BASIS the reminder was raised against — both the deadline and the allowance the
 * service had at that moment — and the lane skips a service whose stored basis still
 * equals its current one. A RENEW moves `expires_at`, an ADD_TRAFFIC moves
 * `traffic_limit_bytes`, either makes the bases differ, and the reminder is due again.
 * Nothing is deleted to re-arm anything, which matters: deleting rows to make a reminder
 * fire again is how an audit trail loses the record of what a customer was actually
 * told. A row is written once and never updated: an occurrence keeps the id the
 * notification named it by.
 *
 * The two columns are read by DIFFERENT kinds. An expiry reminder compares the deadline
 * alone, so buying extra traffic does not re-send "expires in three days". A usage
 * reminder compares both, because a renewal is what resets the panel's usage counter and
 * therefore starts the allowance over even when the allowance itself is unchanged.
 *
 * It is also the SUBJECT of the notification this reminder produces. Every other kind
 * in `CUSTOMER_NOTIFICATION_KINDS` names an order, a payment or a service, and
 * `customer_notifications_subject_key` then guarantees one delivery per subject for
 * ever — right for a rejection, fatal for a reminder. Naming this row instead makes
 * each occurrence its own subject and keeps the guarantee exactly where it belongs.
 */
export const serviceReminders = pgTable(
  'service_reminders',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    serviceId: uuid('service_id').notNull(),
    /** One of `SERVICE_REMINDER_KINDS`. */
    kind: text('kind').notNull(),
    /**
     * The deadline the service had when this reminder was raised. Null means unlimited
     * validity, which is a real answer and not a missing one.
     *
     * Written on EVERY row, expiry and usage alike, because it is what a RENEW moves and
     * a renewal is the event that starts a new usage period too. Kept apart from
     * `basis_traffic_limit_bytes` rather than folded into one opaque column, because the
     * two are compared against different columns of `services` and a single `basis text`
     * would be a value whose meaning depends on the row's kind — which is the shape
     * `subject_type` was refused for on `customer_notifications`.
     */
    basisExpiresAt: timestamptz('basis_expires_at'),
    /**
     * The allowance the service had when this reminder was raised. Zero is unlimited,
     * the sentinel `services.traffic_limit_bytes` already uses.
     *
     * NOT NULL, and written on every row for the same reason the column above is: an
     * ADD_TRAFFIC moves it, and a reminder raised against fifty gigabytes says nothing
     * about a service that now has eighty.
     */
    basisTrafficLimitBytes: bigint('basis_traffic_limit_bytes', { mode: 'bigint' }).notNull(),
    /*
     * WHAT THE CUSTOMER IS TOLD, frozen at the moment the reminder was raised.
     *
     * The three columns below are the only reason this table has a snapshot at all, and
     * the alternative is what makes them necessary: rendering the message from
     * `services` at SEND time. The two moments are minutes apart on a good day and a
     * queue-length apart on a bad one, and in between a renewal moves the deadline, a
     * usage sync moves the figure, and the customer reads a sentence whose numbers
     * contradict the threshold that produced it. `docs/conventions.md` already requires
     * a snapshot for anything that will appear in a historical report; a message to a
     * customer is one.
     *
     * `snapshot_used_bytes` is NOT NULL and is never a stand-in for a figure nobody has
     * read: the usage sweep refuses a service whose `usage_synced_at` is NULL, and the
     * three expiry kinds render no traffic at all. Zero here means the panel said zero.
     */
    snapshotServiceLabel: text('snapshot_service_label').notNull(),
    /** Whole days left when it was raised. NULL for the usage kinds, which render none. */
    snapshotRemainingDays: integer('snapshot_remaining_days'),
    snapshotUsedBytes: bigint('snapshot_used_bytes', { mode: 'bigint' }).notNull(),
    raisedAt: timestamptz('raised_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.serviceId],
      foreignColumns: [services.tenantId, services.id],
      name: 'service_reminders_service_fk',
    }),
    /**
     * ONE row per service per kind PER PERIOD, and the insert on it is what makes the
     * pass safe.
     *
     * Two worker replicas is the normal case on every rolling update, and both will
     * find the same due service. The conditional insert is the decision: the winner
     * writes the row and enqueues the notification in the same transaction, the loser's
     * `ON CONFLICT DO NOTHING` returns nothing and it enqueues nothing.
     *
     * The BASIS is in the key, which is what makes a row an occurrence rather than a
     * slot. An occurrence keeps its id for ever, so the `customer_notifications` row
     * that names it as its subject still resolves years later; a per-kind slot rewritten
     * on each renewal would have to change its own primary key to earn a fresh subject,
     * and every earlier notification would then point at nothing.
     *
     * NULLS NOT DISTINCT, because `basis_expires_at` is NULL for unlimited validity and
     * Postgres treats NULLs in a unique key as distinct by default — which would let
     * every pass insert another row for the same service and send the same reminder for
     * ever. It is a UNIQUE CONSTRAINT rather than a unique index only because that is
     * where drizzle exposes the option.
     *
     * Both basis columns are in the key, so an ADD_TRAFFIC re-arms the three EXPIRY
     * kinds as well as the three usage ones. That is a deliberate, stated cost: the
     * customer may be told "expires soon" once more after buying traffic. Splitting it
     * into two partial unique indexes would avoid the extra message and would make the
     * arbiter of every insert depend on which kind it carries. This lane exists to speak
     * up, and an extra true sentence is the failure to prefer over a missed one.
     */
    unique('service_reminders_period_key')
      .on(
        table.tenantId,
        table.serviceId,
        table.kind,
        table.basisExpiresAt,
        table.basisTrafficLimitBytes,
      )
      .nullsNotDistinct(),
    /** The sweep reads by tenant and orders by when it last spoke. */
    index('service_reminders_raised_idx').on(table.tenantId, table.raisedAt),
    check('service_reminders_kind_check', enumCheck('kind', SERVICE_REMINDER_KINDS)),
    /**
     * Exactly one basis, and which one is decided by the kind.
     *
     * A row with neither could never be compared against anything and would suppress
     * its reminder for ever; a row with both would be two answers to "what was this
     * about". The CHECK is the only thing standing between a future caller and either.
     */
    /**
     * An allowance is a size, and a negative one is not a size.
     *
     * This replaces an exclusive `(expires_at IS NULL) <> (limit IS NULL)` that migration
     * 0090 shipped and 0091 removes. That constraint encoded a wrong model: it made each
     * reminder carry exactly ONE basis, expiry or allowance, and a usage reminder whose
     * only basis was the allowance is a usage reminder a renewal cannot re-arm. A
     * customer who renews a fifty-gigabyte plan, has their usage reset on the panel and
     * climbs back past eighty percent would never be told again, for the life of the
     * service — which is precisely the silence this whole lane exists to break.
     */
    check('service_reminders_basis_check', sql`${table.basisTrafficLimitBytes} >= 0`),
  ],
);

// --- WP-A6: the configured locations a service may be moved to -------------------------

/**
 * One location of one panel, as an operator configured it (WP-A6).
 *
 * A row is two things at once, because they are one thing to an operator: a NAME for a
 * place the panel's own management domain can put an account (`location_key`, which only
 * the adapter interprets), and — when enabled and priced — an OFFER to move a service
 * there. No row, a disabled row or an unpriced row is unavailable; a price of zero is free
 * and is the only free. There is no target-panel column: a move keeps the account on the
 * panel it is on, so a cross-panel or cross-provider move cannot even be written.
 *
 * `initial` marks where the panel's new accounts are created. It is how a service that
 * has never moved knows its current location, and therefore how "the target is where it
 * already is" is refused; one per panel, and never product-scoped, because a panel places
 * every new account the same way.
 *
 * `product_id` scopes an offer to one product's services — the most specific row for a
 * key wins, exactly as a per-device rate's scope does. `version` is bumped by every edit,
 * and a change request snapshots the version it was quoted from.
 */
export const serviceLocations = pgTable(
  'service_locations',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    panelId: uuid('panel_id').notNull(),
    productId: uuid('product_id'),
    locationKey: text('location_key').notNull(),
    label: text('label').notNull(),
    isInitial: boolean('is_initial').notNull().default(false),
    enabled: boolean('enabled').notNull().default(false),
    /** Both halves or neither; null is "not for sale", never free. Zero is free. */
    priceAmount: bigint('price_amount', { mode: 'bigint' }),
    priceCurrency: text('price_currency'),
    cooldownHours: integer('cooldown_hours'),
    maxChanges: integer('max_changes'),
    periodDays: integer('period_days'),
    sortOrder: integer('sort_order').notNull().default(0),
    version: integer('version').notNull().default(1),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    unique('service_locations_tenant_id_key').on(table.tenantId, table.id),
    /** One row per key per scope: a panel-wide one, and at most one per product. */
    unique('service_locations_key')
      .on(table.tenantId, table.panelId, table.locationKey, table.productId)
      .nullsNotDistinct(),
    /** One initial location per panel. */
    uniqueIndex('service_locations_initial_key')
      .on(table.tenantId, table.panelId)
      .where(sql`is_initial`),
    index('service_locations_panel_idx').on(table.tenantId, table.panelId, table.sortOrder),
    foreignKey({
      columns: [table.tenantId, table.panelId],
      foreignColumns: [panels.tenantId, panels.id],
      name: 'service_locations_panel_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.id],
      name: 'service_locations_product_fk',
    }),
    check(
      'service_locations_key_check',
      sql`length(location_key) BETWEEN 1 AND ${sql.raw(String(SERVICE_LOCATION_KEY_MAX_LENGTH))}`,
    ),
    check(
      'service_locations_label_check',
      sql`length(btrim(label)) BETWEEN 1 AND ${sql.raw(String(SERVICE_LOCATION_LABEL_MAX_LENGTH))}`,
    ),
    check(
      'service_locations_price_check',
      sql`(price_amount IS NULL) = (price_currency IS NULL) AND (price_amount IS NULL OR price_amount >= 0)`,
    ),
    check('service_locations_currency_check', nullableEnumCheck('price_currency', CURRENCY_CODES)),
    /** An enabled target is a priced one: enabled and unpriced would be "free" by omission. */
    check('service_locations_enabled_priced_check', sql`NOT enabled OR price_amount IS NOT NULL`),
    check('service_locations_initial_scope_check', sql`NOT is_initial OR product_id IS NULL`),
    check(
      'service_locations_cooldown_check',
      sql`cooldown_hours IS NULL OR (cooldown_hours >= 1 AND cooldown_hours <= ${sql.raw(String(SERVICE_LOCATION_COOLDOWN_HOURS_MAX))})`,
    ),
    check(
      'service_locations_limit_check',
      sql`(max_changes IS NULL) = (period_days IS NULL)
          AND (max_changes IS NULL OR (max_changes >= 1 AND max_changes <= ${sql.raw(String(SERVICE_LOCATION_MAX_CHANGES_MAX))}))
          AND (period_days IS NULL OR (period_days >= 1 AND period_days <= ${sql.raw(String(SERVICE_LOCATION_PERIOD_DAYS_MAX))}))`,
    ),
    check('service_locations_version_check', sql`version >= 1`),
  ],
);

/**
 * WP-A9: one row per time a customer's wallet fell below the tenant's low-balance
 * threshold — "we told them their balance was low, about THIS fall".
 *
 * An OCCURRENCE, like `service_reminders`, and never a flag on the customer: there is no
 * balance column anywhere in this schema and there is none here either. Whether a wallet
 * is low, and whether it has recovered since it was last told, is derived from the ledger
 * on every pass; this row records only what was decided and against which entry.
 *
 * `crossing_entry_id` names the ledger entry that took the running balance from at or
 * above the threshold to below it. That is what makes the alert once-per-crossing:
 *
 *   - two worker replicas derive the same entry and the unique key lets one of them write;
 *   - a wallet that stays low is still the same crossing on every later pass, and the
 *     candidate query skips any wallet with an alert raised since it was last at or above
 *     the threshold — so an idle scan writes nothing;
 *   - a wallet that recovers and falls again crosses at a NEW entry, which is a new row, a
 *     new subject and a new message. Nothing is deleted or updated to re-arm it.
 *
 * It is the SUBJECT of the `WALLET_LOW_BALANCE` notification, for the reason
 * `service_reminders` is: keyed on the customer, `customer_notifications_subject_key`
 * would let a wallet be told it was low exactly once for ever.
 */
export const walletThresholdAlerts = pgTable(
  'wallet_threshold_alerts',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    /** The wallet's currency, which is the threshold's. One wallet per currency. */
    currency: text('currency').notNull(),
    /**
     * The threshold in force when the fall was recorded, in minor units of `currency`.
     *
     * Snapshotted because the send-time re-check compares against THIS figure: an
     * operator moving the threshold after the fact must not turn a true "your balance is
     * low" into a superseded one, nor a false one into a sent one.
     */
    thresholdAmount: bigint('threshold_amount', { mode: 'bigint' }).notNull(),
    /** The ledger entry that took the wallet below the threshold. */
    crossingEntryId: uuid('crossing_entry_id').notNull(),
    /** That entry's `created_at`, copied so the arm test compares two columns of one row. */
    crossedAt: timestamptz('crossed_at').notNull(),
    raisedAt: timestamptz('raised_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'wallet_threshold_alerts_customer_fk',
    }),
    /**
     * The crossing entry travels WITH its tenant: a composite key onto
     * `wallet_entries_tenant_id_key`, so an alert cannot name another tenant's ledger entry
     * (Codex review #2 of PR #100) — the shape every other reference into the ledger has.
     */
    foreignKey({
      columns: [table.tenantId, table.crossingEntryId],
      foreignColumns: [walletEntries.tenantId, walletEntries.id],
      name: 'wallet_threshold_alerts_crossing_entry_fk',
    }),
    /** Once per crossing: the arbiter of every insert, and why two replicas are safe. */
    unique('wallet_threshold_alerts_crossing_key').on(table.tenantId, table.crossingEntryId),
    /** The candidate query's "told since it was last at or above?" probe. */
    index('wallet_threshold_alerts_wallet_idx').on(
      table.tenantId,
      table.customerId,
      table.currency,
      table.crossedAt,
    ),
    check('wallet_threshold_alerts_currency_check', enumCheck('currency', CURRENCY_CODES)),
    /** A zero threshold sends nothing, so no alert can have been raised against one. */
    check('wallet_threshold_alerts_threshold_check', sql`threshold_amount > 0`),
  ],
);

/**
 * One commercial action bought against a service that already exists.
 *
 * The immutable evidence a renewal, an extra-traffic purchase or an extra-time purchase
 * leaves behind, and the answer to every question an operator or an accountant can ask
 * about one: which tenant, which customer, which service, what kind, what was paid, in
 * what currency, how much was bought, where the price came from, and which order settled
 * it. A row is written in the SAME transaction that confirms the order and is never
 * updated afterwards — `nexa_service_commercial_actions_immutable` is the guard.
 *
 * ## Why a table rather than columns on `orders`
 *
 * Two reasons, and the second is the one that decided it.
 *
 * The legacy system has the same shape: `/invoice/service` is an append-only ancillary
 * ledger with seven operation types, separate from `/invoice/`, and the log topics for
 * purchases and for renewals are disjoint — "orders exclude renewals, add-ons and tests"
 * (`LGR-REC-004`). A renewal produces a new financial record and no new service.
 *
 * And a column on `orders` could not carry the customer. Every child row that names an
 * order also names a customer, and a two-column reference lets the pair disagree —
 * which here would put a renewal one customer paid for onto another customer's account.
 * The three-column form is what makes that unrepresentable, and it needs `services` to
 * be declared already. `services` references `orders`, so a column on `orders` would be
 * the other side of a cycle and a composite key cannot be written in either direction of
 * one.
 *
 * ## What is NOT here
 *
 * The absolute target the panel is asked to make true. That is on the operation row,
 * because it is a different fact: this row says what the customer BOUGHT — thirty days,
 * fifty gigabytes — and the operation says what the account should then READ as. The
 * second is computed from the first plus the service's state at settlement, once, and
 * a replay of the operation must reproduce it exactly.
 */
export const serviceCommercialActions = pgTable(
  'service_commercial_actions',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    serviceId: uuid('service_id').notNull(),
    /** One per order, and the order is what was paid. */
    orderId: uuid('order_id').notNull(),
    /** `RENEW`, `ADD_TRAFFIC` or `ADD_TIME` — the `OrderPurpose` minus `NEW_SERVICE`. */
    kind: text('kind').notNull(),
    /**
     * Where the price came from, as a row id, so the operator can navigate.
     *
     * A renewal names the product it was quoted from; a quantity purchase names the
     * add-on. Exactly one is set, and neither is how the purchase is reconstructed — the
     * amounts below and the order's own quote are.
     */
    productId: uuid('product_id'),
    addonId: uuid('addon_id'),
    /** What was bought. Bytes for traffic, days for time; zero where nothing was. */
    purchasedTrafficBytes: bigint('purchased_traffic_bytes', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    purchasedDurationDays: integer('purchased_duration_days').notNull().default(0),
    /** WP-A5: extra users / devices bought. Positive for `ADD_DEVICES`, zero otherwise. */
    purchasedDeviceCount: integer('purchased_device_count').notNull().default(0),
    /**
     * WP-A5: the add-on VERSION the purchase was priced from, beside `addon_id`. Required
     * for `ADD_DEVICES`, whose rate is edited in place; null for every other kind.
     */
    addonVersion: integer('addon_version'),
    /**
     * WP-A6: the configured target a `CHANGE_LOCATION` was priced from, the third place a
     * price may come from. Its VERSION and the names are on the change request, which is
     * the snapshot; this is navigation, like `product_id` and `addon_id`.
     */
    locationId: uuid('location_id'),
    /** What was paid, with its currency. Never an amount without one. */
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'service_commercial_actions_customer_fk',
    }),
    /**
     * The service. Two columns since Package F: a row is append-only and outlives a
     * transfer, so it names the customer who OWNED the service when it was written, which
     * `nexa_commercial_action_owner_guard` requires at insert. The three-column form made
     * even an abandoned renewal draft pin the service to its payer for ever.
     */
    foreignKey({
      columns: [table.tenantId, table.serviceId],
      foreignColumns: [services.tenantId, services.id],
      name: 'service_commercial_actions_service_fk',
    }),
    /** And with the order, so the money and the effect cannot name two people. */
    foreignKey({
      columns: [table.tenantId, table.orderId, table.customerId],
      foreignColumns: [orders.tenantId, orders.id, orders.customerId],
      name: 'service_commercial_actions_order_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.id],
      name: 'service_commercial_actions_product_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.addonId],
      foreignColumns: [serviceAddons.tenantId, serviceAddons.id],
      name: 'service_commercial_actions_addon_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.locationId],
      foreignColumns: [serviceLocations.tenantId, serviceLocations.id],
      name: 'service_commercial_actions_location_fk',
    }),
    /**
     * ONE action per order, as a constraint rather than as worker discipline.
     *
     * The exactly-once rule, in the same shape `services_tenant_order_key` gives the
     * original purchase: the row is written inside the transaction that confirms the
     * order, so a replayed confirmation, a second replica and a double-tapped button all
     * lose here rather than each buying the customer a renewal.
     */
    uniqueIndex('service_commercial_actions_order_key').on(table.tenantId, table.orderId),
    index('service_commercial_actions_service_idx').on(table.serviceId, table.createdAt, table.id),
    index('service_commercial_actions_customer_idx').on(
      table.customerId,
      table.createdAt,
      table.id,
    ),
    check('service_commercial_actions_kind_check', enumCheck('kind', COMMERCIAL_ORDER_PURPOSES)),
    check('service_commercial_actions_currency_check', enumCheck('currency', CURRENCY_CODES)),
    check('service_commercial_actions_amount_check', sql`amount >= 0`),
    /**
     * The price came from exactly one place.
     *
     * A row naming both a product and an add-on could be read as either, and the two
     * answer "what did this cost and why" differently. A row naming neither cannot
     * answer it at all — which is the legacy defect where a deleted product collapses a
     * historical line to «محصول حذف‌شده».
     */
    /*
     * WP-A6 made it three places, and still exactly one: a location change names its
     * configured target and neither a product nor an add-on.
     */
    check(
      'service_commercial_actions_source_check',
      sql`(CASE WHEN product_id IS NULL THEN 0 ELSE 1 END
           + CASE WHEN addon_id IS NULL THEN 0 ELSE 1 END
           + CASE WHEN location_id IS NULL THEN 0 ELSE 1 END) = 1
          AND (location_id IS NULL) = (kind <> 'CHANGE_LOCATION')`,
    ),
    /**
     * What each kind may have bought, pinned so the amounts cannot be swapped.
     *
     * A renewal buys a period and an allowance together — the pinned Marzban leaves a
     * traffic-exhausted account exhausted when only time is extended, so a renewal that
     * sent one field would take the money and leave the customer cut off. A quantity
     * purchase buys exactly one of them, and the other is zero.
     */
    check(
      'service_commercial_actions_purchased_check',
      sql`(kind = 'RENEW' AND purchased_device_count = 0)
          OR (kind = 'ADD_TRAFFIC' AND purchased_traffic_bytes > 0 AND purchased_duration_days = 0 AND purchased_device_count = 0)
          OR (kind = 'ADD_TIME' AND purchased_duration_days > 0 AND purchased_traffic_bytes = 0 AND purchased_device_count = 0)
          OR (kind = 'ADD_DEVICES' AND purchased_device_count > 0 AND purchased_traffic_bytes = 0 AND purchased_duration_days = 0
              AND addon_id IS NOT NULL AND addon_version IS NOT NULL)
          OR (kind = 'CHANGE_LOCATION' AND purchased_traffic_bytes = 0 AND purchased_duration_days = 0
              AND purchased_device_count = 0)`,
    ),
    check(
      'service_commercial_actions_addon_version_check',
      sql`addon_version IS NULL OR (kind = 'ADD_DEVICES' AND addon_version >= 1)`,
    ),
    unique('service_commercial_actions_tenant_id_key').on(table.tenantId, table.id),
  ],
);

/**
 * One attempt at one external effect.
 *
 * `operation_id` is the 16-hex value DERIVED from the idempotency key under the
 * `provider` namespace, and it is unique per tenant. That is what makes the whole design
 * work: two workers retrying one command derive the same id with no lookup, so the
 * second insert loses on this index rather than starting a second provider call.
 *
 * `call_started_at` is the column that decides whether a crashed operation may be
 * released. Set immediately BEFORE the provider call and committed on its own — so if
 * the process dies during the call, the row says a call was started and the lease expiry
 * must not hand it to another worker as though nothing had happened.
 */
export const provisioningOperations = pgTable(
  'provisioning_operations',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** Derived, never generated. 16 lowercase hex characters. */
    operationId: text('operation_id').notNull(),
    serviceId: uuid('service_id').notNull(),
    /** Null for an operation not caused by an order — a reconcile, a usage sync. */
    orderId: uuid('order_id'),
    /**
     * The customer who ASKED for this, or NULL when nobody did.
     *
     * Phase 6A, and it exists because the customer notification lane needs to tell
     * "the thing you asked for happened" from "an operator changed your service".
     * Before the operator action path there was no difference to record: `SUSPEND`,
     * `RESUME` and `TERMINATE` could only be reached from the customer's own detail
     * screen, so `CUSTOMER_REQUESTABLE_OPERATIONS` could decide the announcement from
     * the TYPE alone. It cannot any more — an operator suspend is the same type —
     * and deciding from the type would tell a customer their own request succeeded
     * when they made none, or invite them to retry a terminate an operator ordered.
     *
     * NULL is the honest value for everything a person did not ask for: a reconcile,
     * a usage sync, the retry of a lost create, and every operator action. An operator
     * IS recorded — in the audit row `planRequestedOperation` writes, where the actor
     * names the person. This column answers a narrower question: is a customer owed a
     * sentence about the outcome.
     */
    requestedByCustomerId: uuid('requested_by_customer_id'),
    panelId: uuid('panel_id').notNull(),
    type: text('type').notNull(),
    state: text('state').notNull().default('PLANNED'),
    attempts: integer('attempts').notNull().default(0),
    /**
     * The earliest a claim may take this row. Null means now.
     *
     * Backoff, and the reason it is a column rather than a sleep: the retry delay has to
     * survive the process that decided it. Without this a `FAILED` attempt is re-claimed
     * on the very next tick, which is a hot loop of authentication attempts against
     * somebody else's panel — and 3X-UI blocks an IP-and-username pair after enough of
     * them, so the loop ends by locking the installation out of its own provider.
     */
    nextAttemptAt: timestamptz('next_attempt_at'),
    /** Who holds the claim, and until when. Both null when unclaimed. */
    claimedBy: text('claimed_by'),
    leaseUntil: timestamptz('lease_until'),
    /**
     * Set before the provider call and committed separately.
     *
     * The one fact that distinguishes "a worker died before calling" from "a worker died
     * during a call", and therefore the one fact that decides whether a release is safe.
     */
    callStartedAt: timestamptz('call_started_at'),
    /**
     * What this operation is trying to make TRUE on the panel.
     *
     * Absolute, and written once — in the transaction that settles the order that bought
     * it — rather than computed when the worker runs. That placement is the whole reason
     * `RENEW`, `ADD_TRAFFIC` and `ADD_TIME` may sit in `IDEMPOTENT_MUTATIONS`: a target
     * derived at execution time from whatever the panel currently holds would differ
     * between the first attempt and its replay, and the arithmetic would compound into a
     * customer receiving two renewals for one payment. A stored target replays to the
     * same two numbers for ever.
     *
     * NULL means this operation did not BUY that field, and the provider call omits the
     * key — which the pinned Marzban treats as no change rather than as a reset
     * (`scripts/marzban-allowance-check.sh`, row 3). So an `ADD_TIME` carries an expiry
     * and no limit, an `ADD_TRAFFIC` the reverse, and a `RENEW` both.
     *
     * NULL is NOT "unlimited". Unlimited traffic is zero, the same sentinel
     * `services.traffic_limit_bytes` and `products.traffic_bytes` already use.
     */
    targetExpiresAt: timestamptz('target_expires_at'),
    targetTrafficLimitBytes: bigint('target_traffic_limit_bytes', { mode: 'bigint' }),
    /**
     * WP-A5: the absolute device / connection limit an `ADD_DEVICES` should leave the
     * account at. Set for that type and only that type, and alone: an `ADD_DEVICES` carries
     * no expiry and no allowance, and nothing else carries a device limit.
     */
    targetDeviceLimit: integer('target_device_limit'),
    /**
     * WP-A6: the adapter-defined location key a `CHANGE_LOCATION` should leave the account
     * in. Set for that type and only that type, and alone — a move buys no time, no
     * allowance and no devices, and nothing else moves an account.
     */
    targetLocationKey: text('target_location_key'),
    /** The provider's own reference for the effect, when it gave one. */
    providerReference: text('provider_reference'),
    /** A kind from the EXISTING provider taxonomy. Never a new vocabulary. */
    failureKind: text('failure_kind'),
    /** Bounded, redacted diagnostic. Never a raw provider response. */
    failureMessage: text('failure_message'),
    completedAt: timestamptz('completed_at'),
    /**
     * When the customer was answered about this operation — or NULL, meaning
     * nobody has answered for it yet.
     *
     * This is the claim surface for the sweep that closes the crash window
     * `docs/phase4j-audit.md` names: the executor terminalises an operation in
     * one transaction and `OperationOutcomeAnnouncer.announce` enqueues the
     * message in the NEXT one, and a process that dies between them leaves an
     * operation that is terminal, un-announced, and that nothing will ever call
     * `announce` for again. The loop has moved on and there is exactly one call
     * site.
     *
     * NULL means UNANSWERED, never "no answer was owed". The announcer stamps
     * this even when it decides the operation says nothing — a `SYNC_USAGE`, a
     * `PROVISION` whose link goes out through `DeliveryService` — because a row
     * left NULL is a row the sweep re-reads for ever. The one exit that must NOT
     * stamp is a state that is not terminal: a `FAILED` with attempts left goes
     * back to `PLANNED`, and marking it answered before it has finished is the
     * same silence from the other direction.
     *
     * Deliberately NOT part of `provisioning_operations_completed_check`. That
     * constraint binds the terminal states to `completed_at`; binding this one
     * too would make the stamp a property of the STATE rather than of whether
     * anybody has spoken, and the whole point is that those are different facts
     * that a crash can separate.
     */
    announcedAt: timestamptz('announced_at'),
    /**
     * When the panel answered THIS PROVISION's create with a success whose follow-up
     * then failed — a read-back lost, a record with no usable link (WP15 G7).
     *
     * The one durable provenance a later RECONCILE may adopt on. A lookup that finds
     * the username proves only that the NAME exists; an account made by somebody else
     * answers it the same way. Null on every other type, and on a create that timed
     * out, 5xx'd or was refused, because none of those says the panel acted.
     */
    createAcceptedAt: timestamptz('create_accepted_at'),
    /**
     * When THIS RECONCILE first read the account as absent (WP15 G3).
     *
     * A panel that accepted a create may not show it on the next read. One absence is
     * therefore UNDECIDED, and only a second one, a backoff later, re-plans the create.
     */
    absenceObservedAt: timestamptz('absence_observed_at'),
    /**
     * How many verification READS an ambiguous commercial write has had (WP15 G2).
     *
     * Bounded, and separate from `attempts`, which counts WRITES: a RENEW whose answer
     * was lost is never sent again by this path, only looked at.
     */
    verificationAttempts: integer('verification_attempts').notNull().default(0),
    /**
     * Migration P1 (H5): this row is SCHEDULED housekeeping — a usage read nobody asked
     * for, planned by the provisioner's own sweep — and nothing else.
     *
     * The claim orders every non-background row ahead of every background one, and the
     * executor spends the tenant budget for a background row only above a floor. Both
     * read THIS column, never `type` plus `requested_by_customer_id`: an operator's sync
     * has no customer either, and inferring "background" from the absence of one demoted
     * an operator's explicit request behind a migration-sized backlog.
     *
     * FALSE by default, which is the safe direction: a writer that forgets the column
     * plans work at full priority, never paid work at housekeeping priority. And the
     * CHECK below makes "a background PROVISION" unrepresentable, so no future writer can
     * demote money-bearing work by setting it.
     */
    background: boolean('background').notNull().default(false),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.serviceId],
      foreignColumns: [services.tenantId, services.id],
      name: 'provisioning_operations_service_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
      name: 'provisioning_operations_order_fk',
    }),
    /** A child row may not name a customer of another tenant. */
    foreignKey({
      columns: [table.tenantId, table.requestedByCustomerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'provisioning_operations_requested_by_fk',
    }),
    /** The derivation's whole purpose: a retry collides here instead of calling twice. */
    uniqueIndex('provisioning_operations_tenant_operation_key').on(
      table.tenantId,
      table.operationId,
    ),
    /**
     * The worker's claim scan: due work, oldest first, nothing else read.
     *
     * Leads with `next_attempt_at` because that is what the scan filters on; a row whose
     * backoff has not elapsed is not due, and ordering by creation date alone would put
     * the oldest permanently-failing operation at the front of every tick.
     */
    /*
     * Migration P1: led by `background`, the claim's FIRST ordering key, so the scan
     * reads interactive work first and reaches the background backlog only when none is
     * due — a backlog of thousands of scheduled reads is never sorted to find one paid
     * create. `next_attempt_at` is NULLS FIRST here because the claim orders it so.
     */
    index('provisioning_operations_due_idx')
      .on(table.tenantId, table.background, table.nextAttemptAt.asc().nullsFirst(), table.createdAt)
      .where(sql`state = 'PLANNED'`),
    /**
     * Migration P1: at most ONE open scheduled usage read per service.
     *
     * The sweep already skips a service with an open read; this is the same rule for two
     * provisioner replicas planning in the same instant, where a read-then-write loses.
     * Only background rows: a customer's or an operator's own read may sit beside a
     * scheduled one, and the executor abandons the scheduled one, unspent, once the
     * figure is fresher than it.
     */
    uniqueIndex('provisioning_operations_open_background_sync_key')
      .on(table.tenantId, table.serviceId)
      .where(sql`background AND state IN ('PLANNED', 'IN_FLIGHT')`),
    /** Expired leases, for the release sweep. */
    index('provisioning_operations_lease_idx')
      .on(table.leaseUntil)
      .where(sql`state = 'IN_FLIGHT'`),
    index('provisioning_operations_service_idx').on(table.serviceId, table.createdAt, table.id),
    /**
     * ONE open PROVISION per service, enforced by the database rather than by a check.
     *
     * "One at a time is a partial unique index, not a process" — the rule CLAUDE.md
     * states about backups, applied to the operation that spends a customer's money on
     * somebody else's panel. Two open creates for one service means two provider calls;
     * the derived username makes the second collide rather than duplicate the account,
     * but a collision is a `PROVIDER_ERROR`, which classifies UNKNOWN on a mutating
     * call, which strands the service in `UNRECONCILED`. So a double-click on the
     * operator's retry button corrupted a service it was meant to rescue.
     *
     * Only the two NON-TERMINAL states, so the ordinary sequence still works: a create
     * that FAILED may be retried, and the re-plan after a provably-absent reconcile is
     * legal because the operation it follows is `UNKNOWN`. `SUCCEEDED` is excluded for
     * the same reason — a renewal is a different operation type.
     */
    uniqueIndex('provisioning_operations_open_provision_key')
      .on(table.tenantId, table.serviceId)
      .where(sql`type = 'PROVISION' AND state IN ('PLANNED', 'IN_FLIGHT')`),
    /**
     * ONE open COMMERCIAL action per service, for the reason the PROVISION index above
     * exists and a different failure than the one it prevents.
     *
     * A commercial target is ABSOLUTE and is computed once, in the transaction that
     * settles the order, from the service as it stood when the money moved. Two
     * purchases that settle before the first reaches the panel therefore read the same
     * allowance and plan the same number: two five-gigabyte packages against a
     * ten-gigabyte service each plan FIFTEEN, both are charged, and the account ends
     * where one purchase would have left it.
     *
     * `claimDue` already refuses to run two operations for one service at once, and
     * that is not this: serialising EXECUTION does not help when both rows were
     * computed from the same reading. The refusal has to be at PLAN time, which is why
     * it is an index rather than a check in a service — two API replicas settling two
     * orders in the same instant is exactly the case a read-then-write loses.
     *
     * All three types together rather than one index each: a renewal's target is
     * computed from the same two columns an add-on's is, so a renewal in flight
     * interferes with a top-up exactly as another top-up would.
     *
     * The two NON-TERMINAL states only, as above. A `FAILED` action has written nothing
     * to the service, so the next purchase reads an unchanged row and is safe.
     */
    /*
     * UNKNOWN is OPEN here (WP15 G2). A commercial write whose answer was lost is being
     * verified, and a second purchase computed from the service's un-updated allowance
     * would target the same absolute value — the customer charged twice for one extension.
     */
    uniqueIndex('provisioning_operations_open_commercial_key')
      .on(table.tenantId, table.serviceId)
      .where(
        sql`type IN ('RENEW', 'ADD_TRAFFIC', 'ADD_TIME', 'ADD_DEVICES', 'CHANGE_LOCATION') AND state IN ('PLANNED', 'IN_FLIGHT', 'UNKNOWN')`,
      ),
    index('provisioning_operations_unknown_idx')
      .on(table.tenantId, table.createdAt)
      .where(sql`state = 'UNKNOWN'`),
    check('provisioning_operations_state_check', enumCheck('state', OPERATION_STATES)),
    check('provisioning_operations_type_check', enumCheck('type', OPERATION_TYPES)),
    /*
     * Migration P1: only a scheduled usage READ can be background. Paid, commercial,
     * management and reconcile work can never be demoted by this column, and a row a
     * customer asked for can never be treated as nobody's.
     */
    check(
      'provisioning_operations_background_check',
      sql`NOT background OR (type = 'SYNC_USAGE' AND requested_by_customer_id IS NULL)`,
    ),
    check(
      'provisioning_operations_failure_kind_check',
      nullableEnumCheck('failure_kind', PROVIDER_FAILURE_KINDS),
    ),
    check('provisioning_operations_operation_id_check', sql`operation_id ~ '^[0-9a-f]{16}$'`),
    /**
     * Only a commercial operation may carry a target.
     *
     * A `SUSPEND` with a desired expiry is a row nothing reads and the next reviewer has
     * to decide the meaning of — and the reading they would reach for, that the suspend
     * should also set it, is the one that would silently widen what a management action
     * does. Refused here so it cannot be written at all.
     */
    check(
      'provisioning_operations_target_check',
      sql`type IN ('RENEW', 'ADD_TRAFFIC', 'ADD_TIME', 'ADD_DEVICES', 'CHANGE_LOCATION')
          OR (target_expires_at IS NULL AND target_traffic_limit_bytes IS NULL AND target_device_limit IS NULL
              AND target_location_key IS NULL)`,
    ),
    /**
     * WP-A5: a device limit is an `ADD_DEVICES` target and only one, and an `ADD_DEVICES`
     * carries nothing else — so a raise can never be read as a renewal, nor a renewal be
     * made to change how many devices an account allows.
     */
    check(
      'provisioning_operations_target_device_check',
      sql`(type = 'ADD_DEVICES'
           AND target_device_limit IS NOT NULL AND target_device_limit >= 1 AND target_device_limit <= 1000
           AND target_expires_at IS NULL AND target_traffic_limit_bytes IS NULL)
          OR (type <> 'ADD_DEVICES' AND target_device_limit IS NULL)`,
    ),
    /**
     * WP-A6: a location key is a `CHANGE_LOCATION` target and only one, and a
     * `CHANGE_LOCATION` carries nothing else — a move can never be read as a renewal, nor a
     * renewal made to move an account.
     */
    check(
      'provisioning_operations_target_location_check',
      sql`(type = 'CHANGE_LOCATION'
           AND target_location_key IS NOT NULL
           AND length(target_location_key) BETWEEN 1 AND ${sql.raw(String(SERVICE_LOCATION_KEY_MAX_LENGTH))}
           AND target_expires_at IS NULL AND target_traffic_limit_bytes IS NULL AND target_device_limit IS NULL)
          OR (type <> 'CHANGE_LOCATION' AND target_location_key IS NULL)`,
    ),
    /**
     * And a commercial operation must carry at least one, or it asks the panel for
     * nothing while an order records that a customer paid for something.
     */
    check(
      'provisioning_operations_target_present_check',
      sql`type NOT IN ('RENEW', 'ADD_TRAFFIC', 'ADD_TIME', 'ADD_DEVICES', 'CHANGE_LOCATION')
          OR target_expires_at IS NOT NULL
          OR target_traffic_limit_bytes IS NOT NULL
          OR target_device_limit IS NOT NULL
          OR target_location_key IS NOT NULL`,
    ),
    check(
      'provisioning_operations_target_traffic_check',
      sql`target_traffic_limit_bytes IS NULL OR target_traffic_limit_bytes >= 0`,
    ),
    check('provisioning_operations_attempts_check', sql`attempts >= 0 AND attempts <= 100`),
    check(
      'provisioning_operations_verification_attempts_check',
      sql`verification_attempts >= 0 AND verification_attempts <= 100`,
    ),
    check(
      'provisioning_operations_create_accepted_check',
      sql`create_accepted_at IS NULL OR type = 'PROVISION'`,
    ),
    check(
      'provisioning_operations_absence_observed_check',
      sql`absence_observed_at IS NULL OR type = 'RECONCILE'`,
    ),
    /** A claim is a holder AND a deadline, together or not at all. */
    check('provisioning_operations_claim_check', sql`(claimed_by IS NULL) = (lease_until IS NULL)`),
    /** Terminal states have a completion time; live ones do not. */
    check(
      'provisioning_operations_completed_check',
      sql`(state IN ('SUCCEEDED', 'FAILED', 'ABANDONED')) = (completed_at IS NOT NULL)`,
    ),
    unique('provisioning_operations_tenant_id_key').on(table.tenantId, table.id),
  ],
);

/**
 * R3 (v0.3.5 real-test fixes, item 10): the service card a customer's request was made
 * from, so the result can be shown ON that card.
 *
 * A disable or an enable is an operation the provisioner performs later, in another
 * process; the tap that asked for it is long answered by then. This row is how the
 * provisioner knows which Telegram message to edit: the chat and message the tap came
 * from, and the bot that drew it (a `message_id` is only meaningful to that bot, and a
 * reply from a different bot leaks the relationship between them — `CustomerMessage`).
 *
 * One row per operation, written in the SAME transaction that plans it — only when it
 * is newly planned, so a double tap keeps the first card — and never changed except by
 * `answered_at`. Nothing here is a secret: a chat id and a message number.
 *
 * `answered_at` is the told-once claim. Stamped by a conditional UPDATE before the edit
 * is sent, so two provisioner replicas cannot both edit (or both fall back to sending
 * the card); released only for a 429, which is Telegram declining to look at the edit.
 */
export const operationCardMessages = pgTable(
  'operation_card_messages',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** `provisioning_operations.id` — the row, not the derived `operation_id`. */
    operationId: uuid('operation_id').notNull(),
    botInstanceId: uuid('bot_instance_id').notNull(),
    chatId: text('chat_id').notNull(),
    messageId: bigint('message_id', { mode: 'number' }).notNull(),
    answeredAt: timestamptz('answered_at'),
    /**
     * The earliest the card may be claimed again, after Telegram answered 429 — its own
     * `retry_after`, bounded, or a floor when it gave none. NULL means now.
     */
    nextAttemptAt: timestamptz('next_attempt_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'operation_card_messages_pkey',
      columns: [table.tenantId, table.operationId],
    }),
    foreignKey({
      columns: [table.tenantId, table.operationId],
      foreignColumns: [provisioningOperations.tenantId, provisioningOperations.id],
      name: 'operation_card_messages_operation_fk',
    }),
    /** The sweep's claim surface: cards nobody has answered for, oldest first. */
    index('operation_card_messages_unanswered_idx')
      .on(table.tenantId, table.createdAt)
      .where(sql`answered_at IS NULL`),
    check('operation_card_messages_message_id_check', sql`message_id > 0`),
    check('operation_card_messages_chat_id_check', sql`chat_id ~ '^-?[0-9]{1,20}$'`),
  ],
);

/**
 * A discount rule (`docs/wp8-pricing-audit.md` P3).
 *
 * A `CODE` rule applies when a customer enters its code; an `AUTOMATIC` rule applies to
 * every order it is eligible for. `code` is required for the first and forbidden for the
 * second, and `discounts_code_kind_check` says so in the database as well.
 *
 * `value` is whole percent for `PERCENTAGE` and minor units for `FIXED_AMOUNT`, and
 * `currency` is required for the second and forbidden for the first — a percentage with
 * a currency is a category error that would eventually be read as an amount.
 *
 * There is no counter. The limits are decided by counting LIVE redemptions — rows whose
 * order is `AWAITING_PAYMENT` or `PAID` — under this row's lock, at confirmation (P6).
 * The `redemption_count` column this table had until WP8 claimed "the conditional UPDATE
 * that increments it" was the authority; no such UPDATE ever existed, nothing ever wrote
 * it, and a counter the limit does not read is a second answer to "how many".
 */
export const discounts = pgTable(
  'discounts',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: text('kind').notNull(),
    /** Normalised to upper case before storage, so case cannot split a rule. Null for `AUTOMATIC`. */
    code: text('code'),
    /** The operator's name for the rule, and the quote trace's `ruleLabel`. */
    label: text('label').notNull(),
    type: text('type').notNull(),
    status: text('status').notNull().default('INACTIVE'),
    /** Whole percent, or minor units. See the docblock. */
    value: bigint('value', { mode: 'bigint' }).notNull(),
    currency: text('currency'),
    /** A non-empty subset of `DISCOUNTABLE_PURPOSES`. */
    appliesTo: text('applies_to').array().notNull(),
    /** At most one of the two scopes; neither means every product and every add-on. */
    productId: uuid('product_id'),
    categoryId: uuid('category_id'),
    /** When set, only this customer is eligible — the legacy per-user discount, as a rule. */
    customerId: uuid('customer_id'),
    firstPurchaseOnly: boolean('first_purchase_only').notNull().default(false),
    startsAt: timestamptz('starts_at'),
    endsAt: timestamptz('ends_at'),
    /** Null means unlimited. Two limits, because "100 uses" and "1 each" differ. */
    totalRedemptionsLimit: integer('total_redemptions_limit'),
    perCustomerLimit: integer('per_customer_limit'),
    minimumSubtotalAmount: bigint('minimum_subtotal_amount', { mode: 'bigint' }),
    /** Higher applies first; ties go to the older rule (P4). */
    priority: integer('priority').notNull().default(0),
    stackable: boolean('stackable').notNull().default(false),
    /**
     * RETAINED FOR ONE RELEASE, and read by nothing in this one.
     *
     * The counter the limits never trusted; they count LIVE redemptions instead (P6). It
     * is not dropped here because the release before this one may still be running during
     * the rollback window, and a column dropped under it is the narrowing
     * `migration-compatibility.test.ts` refuses. The next release drops it, once nothing
     * that could be rolled back to still knows it exists.
     */
    redemptionCount: integer('redemption_count').notNull().default(0),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('discounts_tenant_code_key').on(table.tenantId, table.code),
    index('discounts_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
    /** The candidates the engine reads for every quote: live automatic rules. */
    index('discounts_tenant_live_idx').on(table.tenantId, table.kind, table.status),
    foreignKey({
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.id],
      name: 'discounts_product_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.categoryId],
      foreignColumns: [productCategories.tenantId, productCategories.id],
      name: 'discounts_category_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'discounts_customer_fk',
    }),
    check('discounts_kind_check', enumCheck('kind', DISCOUNT_KINDS)),
    check('discounts_type_check', enumCheck('type', DISCOUNT_TYPES)),
    check('discounts_status_check', enumCheck('status', DISCOUNT_STATUSES)),
    check('discounts_currency_check', nullableEnumCheck('currency', CURRENCY_CODES)),
    check('discounts_value_check', sql`value > 0`),
    check('discounts_count_check', sql`redemption_count >= 0`),
    /** A code rule carries a code and an automatic one carries none. Both halves. */
    check('discounts_code_kind_check', sql`(kind = 'CODE') = (code IS NOT NULL)`),
    /** A percentage is 1..100 and carries no currency; a fixed amount carries one. */
    check(
      'discounts_percentage_check',
      sql`type <> 'PERCENTAGE' OR (value <= 100 AND currency IS NULL)`,
    ),
    check('discounts_fixed_check', sql`type <> 'FIXED_AMOUNT' OR currency IS NOT NULL`),
    check(
      'discounts_window_check',
      sql`starts_at IS NULL OR ends_at IS NULL OR starts_at < ends_at`,
    ),
    check(
      'discounts_limits_check',
      sql`(total_redemptions_limit IS NULL OR total_redemptions_limit > 0) AND (per_customer_limit IS NULL OR per_customer_limit > 0)`,
    ),
    check(
      'discounts_minimum_check',
      sql`minimum_subtotal_amount IS NULL OR minimum_subtotal_amount >= 0`,
    ),
    /** The code is ASCII and upper case in the database, not only in the application. */
    check('discounts_code_shape_check', sql`code ~ '^[A-Z0-9_-]{3,40}$'`),
    check(
      'discounts_label_check',
      sql`char_length(label) BETWEEN 1 AND ${sql.raw(String(DISCOUNT_LABEL_MAX_LENGTH))}`,
    ),
    /**
     * A non-empty subset of the discountable purposes. `TRIAL` is never a member: a
     * discount on a free order is a discount of nothing.
     */
    check('discounts_applies_to_check', enumSubsetCheck('applies_to', DISCOUNTABLE_PURPOSES)),
    check('discounts_scope_check', sql`product_id IS NULL OR category_id IS NULL`),
    /** "First purchase" is a question about new purchases, and only about them. */
    check(
      'discounts_first_purchase_check',
      sql`NOT first_purchase_only OR applies_to = ARRAY['NEW_SERVICE']::text[]`,
    ),
    check(
      'discounts_priority_check',
      sql`priority BETWEEN ${sql.raw(String(DISCOUNT_PRIORITY_MIN))} AND ${sql.raw(String(DISCOUNT_PRIORITY_MAX))}`,
    ),
    unique('discounts_tenant_id_key').on(table.tenantId, table.id),
  ],
);

/**
 * One redemption — the fact that a rule was applied to a confirmed order.
 *
 * Written at confirmation, under the rule's row lock, with the amount the quote trace
 * took off (P6). Unique on `(tenant_id, order_id, discount_id)`: a stacked order redeems
 * more than one rule, and no order redeems the same rule twice, however often a retry
 * re-enters the step.
 *
 * A redemption is LIVE while its order is `AWAITING_PAYMENT` or `PAID`. A cancelled,
 * expired or refunded order frees its use without anything having to run, which is why
 * there is no released-at column to forget to write.
 */
export const discountRedemptions = pgTable(
  'discount_redemptions',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    discountId: uuid('discount_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    orderId: uuid('order_id').notNull(),
    /** What it actually took off, snapshotted — the rule may be re-tuned later. */
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.discountId],
      foreignColumns: [discounts.tenantId, discounts.id],
      name: 'discount_redemptions_discount_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'discount_redemptions_customer_fk',
    }),
    /**
     * The customer travels with the order.
     *
     * This is the one the review found. The per-customer redemption limit is counted over
     * `(discount_id, customer_id)`, so a row whose customer does not own its order makes
     * the limit advisory — a customer could redeem a once-per-person code repeatedly by
     * attributing each redemption elsewhere.
     */
    foreignKey({
      columns: [table.tenantId, table.orderId, table.customerId],
      foreignColumns: [orders.tenantId, orders.id, orders.customerId],
      name: 'discount_redemptions_order_fk',
    }),
    /** One redemption per rule per order, as a constraint rather than a check-then-write. */
    uniqueIndex('discount_redemptions_order_discount_key').on(
      table.tenantId,
      table.orderId,
      table.discountId,
    ),
    index('discount_redemptions_discount_customer_idx').on(table.discountId, table.customerId),
    check('discount_redemptions_currency_check', enumCheck('currency', CURRENCY_CODES)),
    check('discount_redemptions_amount_check', sql`amount > 0`),
  ],
);

/**
 * The window in which a customer's next plain message is read as a discount code (P11).
 *
 * `username_captures`, again, down to the partial unique index and for the same reason:
 * an open window is the only thing that lets an ordinary message be read as an answer,
 * so it is a ROW with an owner, a draft and a deadline. The only thing it can DO is
 * re-quote the one draft it names, for the one customer it names.
 */
export const discountCodeCaptures = pgTable(
  'discount_code_captures',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    customerId: uuid('customer_id').notNull(),
    orderId: uuid('order_id').notNull(),
    openedAt: timestamptz('opened_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at').notNull(),
    closedAt: timestamptz('closed_at'),
    closeReason: text('close_reason'),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'discount_code_captures_customer_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.orderId, table.customerId],
      foreignColumns: [orders.tenantId, orders.id, orders.customerId],
      name: 'discount_code_captures_order_fk',
    }),
    /** ONE open window per customer per bot, decided by the database. */
    uniqueIndex('discount_code_captures_open_key')
      .on(table.tenantId, table.botInstanceId, table.customerId)
      .where(sql`closed_at IS NULL`),
    check(
      'discount_code_captures_close_reason_check',
      nullableEnumCheck('close_reason', DISCOUNT_CODE_CAPTURE_CLOSE_REASONS),
    ),
    check('discount_code_captures_closed_check', sql`(closed_at IS NULL) = (close_reason IS NULL)`),
    check('discount_code_captures_expiry_check', sql`expires_at > opened_at`),
  ],
);

/**
 * A cashback rule (P8). Not a discount: it never changes what the customer pays.
 *
 * Among the eligible rules for a quote, the highest `percent` wins, then the older rule
 * (`O-6`'s fallback, "max wins"); cashback rules never stack.
 */
export const cashbackRules = pgTable(
  'cashback_rules',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    label: text('label').notNull(),
    status: text('status').notNull().default('INACTIVE'),
    percent: integer('percent').notNull(),
    appliesTo: text('applies_to').array().notNull(),
    productId: uuid('product_id'),
    categoryId: uuid('category_id'),
    startsAt: timestamptz('starts_at'),
    endsAt: timestamptz('ends_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('cashback_rules_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
    index('cashback_rules_tenant_status_idx').on(table.tenantId, table.status),
    foreignKey({
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.id],
      name: 'cashback_rules_product_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.categoryId],
      foreignColumns: [productCategories.tenantId, productCategories.id],
      name: 'cashback_rules_category_fk',
    }),
    check('cashback_rules_status_check', enumCheck('status', CASHBACK_RULE_STATUSES)),
    check(
      'cashback_rules_percent_check',
      sql`percent BETWEEN ${sql.raw(String(CASHBACK_PERCENT_MIN))} AND ${sql.raw(String(CASHBACK_PERCENT_MAX))}`,
    ),
    check(
      'cashback_rules_label_check',
      sql`char_length(label) BETWEEN 1 AND ${sql.raw(String(DISCOUNT_LABEL_MAX_LENGTH))}`,
    ),
    check('cashback_rules_applies_to_check', enumSubsetCheck('applies_to', DISCOUNTABLE_PURPOSES)),
    check('cashback_rules_scope_check', sql`product_id IS NULL OR category_id IS NULL`),
    check(
      'cashback_rules_window_check',
      sql`starts_at IS NULL OR ends_at IS NULL OR starts_at < ends_at`,
    ),
    unique('cashback_rules_tenant_id_key').on(table.tenantId, table.id),
  ],
);

/**
 * An order's cashback, from confirmation to its end (P8, P9).
 *
 * Written at confirmation from the quote's `cashback`, `PENDING`. Moves ONCE: to `EARNED`
 * when the order is delivered, with the credit it wrote, or to `VOID` when the order ends
 * without delivery. Everything the quote promised is frozen here by
 * `nexa_order_cashback_guard`, so a rule retuned after the sale cannot change a promise
 * already made.
 *
 * `earned_amount` may be less than `amount` — a refund that completed before delivery
 * reduces what is earned rather than having to be reversed — and may be ZERO when the
 * whole payment went back first. A zero earning writes no wallet entry, and the check
 * below says both halves of that.
 */
export const orderCashback = pgTable(
  'order_cashback',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    orderId: uuid('order_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    ruleId: uuid('rule_id').notNull(),
    ruleLabel: text('rule_label').notNull(),
    percent: integer('percent').notNull(),
    /** What the quote promised, on the order's final total. */
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    state: text('state').notNull().default('PENDING'),
    earnedAmount: bigint('earned_amount', { mode: 'bigint' }),
    earnedEntryId: uuid('earned_entry_id'),
    earnedAt: timestamptz('earned_at'),
    voidedAt: timestamptz('voided_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.orderId, table.customerId],
      foreignColumns: [orders.tenantId, orders.id, orders.customerId],
      name: 'order_cashback_order_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.ruleId],
      foreignColumns: [cashbackRules.tenantId, cashbackRules.id],
      name: 'order_cashback_rule_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.earnedEntryId],
      foreignColumns: [walletEntries.tenantId, walletEntries.id],
      name: 'order_cashback_earned_entry_fk',
    }),
    /** One promise per order. */
    uniqueIndex('order_cashback_tenant_order_key').on(table.tenantId, table.orderId),
    /** The earner's discovery index: promises still waiting on their order. */
    index('order_cashback_pending_idx')
      .on(table.tenantId, table.createdAt, table.id)
      .where(sql`state = 'PENDING'`),
    check('order_cashback_state_check', enumCheck('state', CASHBACK_STATES)),
    check('order_cashback_currency_check', enumCheck('currency', CURRENCY_CODES)),
    check('order_cashback_amount_check', sql`amount > 0`),
    check(
      'order_cashback_percent_check',
      sql`percent BETWEEN ${sql.raw(String(CASHBACK_PERCENT_MIN))} AND ${sql.raw(String(CASHBACK_PERCENT_MAX))}`,
    ),
    /** Earned exactly when stamped earned, with an amount never above the promise. */
    check(
      'order_cashback_earned_check',
      sql`(state = 'EARNED') = (earned_at IS NOT NULL) AND (state = 'EARNED') = (earned_amount IS NOT NULL) AND (earned_amount IS NULL OR (earned_amount >= 0 AND earned_amount <= amount))`,
    ),
    /** A credit was written exactly when something was earned. */
    check(
      'order_cashback_entry_check',
      sql`(earned_entry_id IS NOT NULL) = (earned_amount IS NOT NULL AND earned_amount > 0)`,
    ),
    check('order_cashback_void_check', sql`(state = 'VOID') = (voided_at IS NOT NULL)`),
    unique('order_cashback_tenant_id_key').on(table.tenantId, table.id),
  ],
);

/**
 * One reversal of earned cashback, caused by one completed refund (P9). Append-only.
 *
 * `due` is what the refund made owed back, from the cumulative formula; `recovered` is
 * what the wallet balance could give, as a `CASHBACK_REVERSAL` debit; `unrecovered` is
 * the rest — the explicit liability rule: the balance never goes negative and history is
 * never edited, so what cannot be taken is RECORDED here and shown to the operator.
 */
export const cashbackReversals = pgTable(
  'cashback_reversals',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    orderCashbackId: uuid('order_cashback_id').notNull(),
    orderId: uuid('order_id').notNull(),
    customerId: uuid('customer_id').notNull(),
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
      columns: [table.tenantId, table.orderCashbackId],
      foreignColumns: [orderCashback.tenantId, orderCashback.id],
      name: 'cashback_reversals_cashback_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.orderId, table.customerId],
      foreignColumns: [orders.tenantId, orders.id, orders.customerId],
      name: 'cashback_reversals_order_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.refundId],
      foreignColumns: [refunds.tenantId, refunds.id],
      name: 'cashback_reversals_refund_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.walletEntryId],
      foreignColumns: [walletEntries.tenantId, walletEntries.id],
      name: 'cashback_reversals_entry_fk',
    }),
    /** One reversal per refund: a replayed completion reverses nothing twice. */
    uniqueIndex('cashback_reversals_tenant_refund_key').on(table.tenantId, table.refundId),
    index('cashback_reversals_cashback_idx').on(table.tenantId, table.orderCashbackId),
    check('cashback_reversals_currency_check', enumCheck('currency', CURRENCY_CODES)),
    check(
      'cashback_reversals_amounts_check',
      sql`due_amount > 0 AND recovered_amount >= 0 AND unrecovered_amount >= 0 AND due_amount = recovered_amount + unrecovered_amount`,
    ),
    check(
      'cashback_reversals_entry_check',
      sql`(wallet_entry_id IS NOT NULL) = (recovered_amount > 0)`,
    ),
  ],
);

/**
 * Round N, C1 — a campaign (`docs/round-n-campaigns-audit.md`).
 *
 * A record that COMPOSES engines and owns none of their decisions: it prices nothing,
 * credits nothing, sends nothing and dials no panel. What it owns is here — a name, the
 * half-open window `[starts_at, ends_at)` resolved from the tenant's own calendar and
 * zone, the audience definition frozen when it is scheduled, and a state whose every
 * change is a conditional UPDATE naming its from-states (`CAMPAIGN_MACHINE`).
 */
export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    /** Internal only: an operator's note, never shown to a customer. */
    description: text('description').notNull().default(''),
    state: text('state').notNull().default('DRAFT'),
    startsAt: timestamptz('starts_at').notNull(),
    endsAt: timestamptz('ends_at').notNull(),
    /**
     * The shared audience definition (the Broadcast engine's own contract). Editable while
     * DRAFT; frozen by the schedule, which stamps `audience_frozen_at` and the count the
     * operator confirmed.
     */
    audience: jsonb('audience').notNull(),
    /** sha256 of the canonical definition (`freezeAudience`), what a confirmation binds to. */
    audienceHash: text('audience_hash').notNull(),
    audienceFrozenAt: timestamptz('audience_frozen_at'),
    /** The audience count the operator saw in the preview and confirmed. */
    audienceConfirmedCount: integer('audience_confirmed_count'),
    /** The md5 of the confirmed SET of customer ids, as the audience engine computes it. */
    audienceFingerprint: text('audience_fingerprint'),
    createdByAdminId: uuid('created_by_admin_id'),
    scheduledByAdminId: uuid('scheduled_by_admin_id'),
    scheduledAt: timestamptz('scheduled_at'),
    startedAt: timestamptz('started_at'),
    pausedAt: timestamptz('paused_at'),
    completedAt: timestamptz('completed_at'),
    cancelledByAdminId: uuid('cancelled_by_admin_id'),
    cancelledAt: timestamptz('cancelled_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    unique('campaigns_tenant_id_key').on(table.tenantId, table.id),
    index('campaigns_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
    /** The worker's two discovery questions: due to start, and due to complete. */
    index('campaigns_due_start_idx')
      .on(table.tenantId, table.startsAt, table.id)
      .where(sql`state = 'SCHEDULED'`),
    index('campaigns_due_end_idx')
      .on(table.tenantId, table.endsAt, table.id)
      .where(sql`state IN ('ACTIVE', 'PAUSED')`),
    foreignKey({
      columns: [table.tenantId, table.createdByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
      name: 'campaigns_created_by_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.scheduledByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
      name: 'campaigns_scheduled_by_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.cancelledByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
      name: 'campaigns_cancelled_by_fk',
    }),
    check('campaigns_state_check', enumCheck('state', CAMPAIGN_STATES)),
    check('campaigns_window_check', sql`starts_at < ends_at`),
    check(
      'campaigns_name_check',
      sql`char_length(name) BETWEEN 1 AND ${sql.raw(String(CAMPAIGN_NAME_MAX_LENGTH))}`,
    ),
    check(
      'campaigns_description_check',
      sql`char_length(description) <= ${sql.raw(String(CAMPAIGN_DESCRIPTION_MAX_LENGTH))}`,
    ),
    /** Past DRAFT the audience is frozen: every state but DRAFT and a draft's CANCEL. */
    check(
      'campaigns_frozen_check',
      sql`(audience_frozen_at IS NULL) = (scheduled_at IS NULL) AND (scheduled_at IS NULL) = (audience_confirmed_count IS NULL) AND (scheduled_at IS NULL) = (audience_fingerprint IS NULL)`,
    ),
    check(
      'campaigns_scheduled_check',
      sql`state IN ('DRAFT', 'CANCELLED') OR scheduled_at IS NOT NULL`,
    ),
    check(
      'campaigns_started_check',
      sql`state NOT IN ('ACTIVE', 'PAUSED') OR started_at IS NOT NULL`,
    ),
    check('campaigns_completed_check', sql`(state = 'COMPLETED') = (completed_at IS NOT NULL)`),
    check('campaigns_cancelled_check', sql`(state = 'CANCELLED') = (cancelled_at IS NOT NULL)`),
    check('campaigns_paused_check', sql`(state = 'PAUSED') = (paused_at IS NOT NULL)`),
    check('campaigns_audience_hash_check', sql`audience_hash ~ '^[0-9a-f]{64}$'`),
    check(
      'campaigns_audience_fingerprint_check',
      sql`audience_fingerprint IS NULL OR audience_fingerprint ~ '^[0-9a-f]{32}$'`,
    ),
    check(
      'campaigns_confirmed_count_check',
      sql`audience_confirmed_count IS NULL OR audience_confirmed_count >= 0`,
    ),
  ],
);

/**
 * One promotional action of a campaign, and the ONE row it made in another engine.
 *
 * `config` is the action's terms as the operator confirmed them, frozen with the
 * campaign. The link columns name what the engine holds: a discount rule, a cashback
 * rule, or the shared engines' bulk operation or broadcast. At most one action of each
 * kind per campaign, and each link is only on the kind it belongs to.
 */
export const campaignActions = pgTable(
  'campaign_actions',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    campaignId: uuid('campaign_id').notNull(),
    kind: text('kind').notNull(),
    state: text('state').notNull().default('PENDING'),
    config: jsonb('config').notNull(),
    discountId: uuid('discount_id'),
    cashbackRuleId: uuid('cashback_rule_id'),
    /**
     * A launched action's confirmation binding (count, set, liability, typed count), frozen by
     * the schedule, so an interrupted hand-over is retried with EXACTLY what was confirmed —
     * the engine's idempotency then replays rather than creating a second operation.
     */
    binding: jsonb('binding'),
    /** The announcement: the Broadcast lane's own record. */
    broadcastId: uuid('broadcast_id'),
    /** A wallet, traffic or time gift: the mass-action engine's own record. */
    bulkOperationId: uuid('bulk_operation_id'),
    /**
     * Round N close (§A): the FROZEN audience this action's engine record is seeded from —
     * customers for the announcement and a wallet gift, services for a traffic or time
     * gift — materialised in the confirming transaction. A hand-over retried after the live
     * audience moved copies these members, never re-selects. Null for the standing rules.
     */
    frozenAudienceId: uuid('frozen_audience_id'),
    /** Why the engine refused to take the work, as its error code. Null otherwise. */
    failureCode: text('failure_code'),
    launchedAt: timestamptz('launched_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.frozenAudienceId],
      foreignColumns: [frozenAudiences.tenantId, frozenAudiences.id],
      name: 'campaign_actions_frozen_audience_fk',
    }).onDelete('restrict'),
    check(
      'campaign_actions_frozen_kind_check',
      sql`frozen_audience_id IS NULL OR kind IN ('WALLET_GIFT', 'TRAFFIC_GIFT', 'TIME_GIFT', 'ANNOUNCEMENT')`,
    ),
    uniqueIndex('campaign_actions_campaign_kind_key').on(
      table.tenantId,
      table.campaignId,
      table.kind,
    ),
    /** A rule belongs to at most one campaign. */
    uniqueIndex('campaign_actions_discount_key')
      .on(table.tenantId, table.discountId)
      .where(sql`discount_id IS NOT NULL`),
    uniqueIndex('campaign_actions_cashback_rule_key')
      .on(table.tenantId, table.cashbackRuleId)
      .where(sql`cashback_rule_id IS NOT NULL`),
    foreignKey({
      columns: [table.tenantId, table.campaignId],
      foreignColumns: [campaigns.tenantId, campaigns.id],
      name: 'campaign_actions_campaign_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.discountId],
      foreignColumns: [discounts.tenantId, discounts.id],
      name: 'campaign_actions_discount_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.cashbackRuleId],
      foreignColumns: [cashbackRules.tenantId, cashbackRules.id],
      name: 'campaign_actions_cashback_rule_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.broadcastId],
      foreignColumns: [broadcasts.tenantId, broadcasts.id],
      name: 'campaign_actions_broadcast_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.bulkOperationId],
      foreignColumns: [bulkOperations.tenantId, bulkOperations.id],
      name: 'campaign_actions_bulk_operation_fk',
    }),
    uniqueIndex('campaign_actions_broadcast_key')
      .on(table.tenantId, table.broadcastId)
      .where(sql`broadcast_id IS NOT NULL`),
    uniqueIndex('campaign_actions_bulk_operation_key')
      .on(table.tenantId, table.bulkOperationId)
      .where(sql`bulk_operation_id IS NOT NULL`),
    check(
      'campaign_actions_broadcast_kind_check',
      sql`broadcast_id IS NULL OR kind = 'ANNOUNCEMENT'`,
    ),
    check(
      'campaign_actions_bulk_kind_check',
      sql`bulk_operation_id IS NULL OR kind IN ('WALLET_GIFT', 'TRAFFIC_GIFT', 'TIME_GIFT')`,
    ),
    check('campaign_actions_kind_check', enumCheck('kind', CAMPAIGN_ACTION_KINDS)),
    check('campaign_actions_state_check', enumCheck('state', CAMPAIGN_ACTION_STATES)),
    check('campaign_actions_discount_kind_check', sql`discount_id IS NULL OR kind = 'DISCOUNT'`),
    check(
      'campaign_actions_cashback_kind_check',
      sql`cashback_rule_id IS NULL OR kind = 'CASHBACK'`,
    ),
    check('campaign_actions_launched_check', sql`(state = 'LAUNCHED') = (launched_at IS NOT NULL)`),
    check('campaign_actions_failed_check', sql`(state = 'FAILED') = (failure_code IS NOT NULL)`),
  ],
);

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
  },
  (table) => [
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
 * A global trial reset, as it ran (ADR-0010 step 5, `docs/wp6-audit.md` B3).
 *
 * The recorded result of the one bulk operation trials have: who, why, when, and how
 * many grants and customers it covered. Every grant it stamped carries its id in
 * `trial_grants.reset_id`, so "which trials did this reset" is answered by the rows
 * themselves rather than by a timestamp comparison that a clock skew could disagree
 * with. Nothing updates or deletes a row here; a reset is history.
 */
export const trialResets = pgTable(
  'trial_resets',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    actorAdminId: uuid('actor_admin_id').notNull(),
    reason: text('reason').notNull(),
    affectedGrants: integer('affected_grants').notNull(),
    affectedCustomers: integer('affected_customers').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    /** The target of `trial_grants.reset_id`'s tenant-bearing foreign key. */
    uniqueIndex('trial_resets_tenant_id_key').on(table.tenantId, table.id),
    index('trial_resets_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
    foreignKey({
      name: 'trial_resets_actor_fk',
      columns: [table.tenantId, table.actorAdminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
    /** A reset that covered nothing is refused (`TRIAL_RESET_NOTHING`), never recorded. */
    check(
      'trial_resets_counts_check',
      sql`affected_grants > 0 AND affected_customers > 0 AND affected_customers <= affected_grants`,
    ),
    check('trial_resets_reason_check', sql`length(btrim(reason)) > 0`),
  ],
);

/**
 * A customer's persistent custom trial limit (ADR-0015, `docs/wp6-audit.md` B2).
 *
 * A row per customer, or no row. No row means the customer inherits
 * `trial.limit_per_customer`; removing an override DELETES the row rather than copying
 * the default into it, so a later change to the default applies to them again. `0` is a
 * legal limit and means no trials, never unlimited.
 */
export const trialLimitOverrides = pgTable(
  'trial_limit_overrides',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    trialLimit: integer('trial_limit').notNull(),
    setAt: timestamptz('set_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'trial_limit_overrides_pkey', columns: [table.tenantId, table.customerId] }),
    foreignKey({
      name: 'trial_limit_overrides_customer_fk',
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    index('trial_limit_overrides_tenant_set_idx').on(table.tenantId, table.setAt, table.customerId),
    check(
      'trial_limit_overrides_limit_check',
      sql`trial_limit >= ${sql.raw(String(TRIAL_LIMIT_MIN))} AND trial_limit <= ${sql.raw(String(TRIAL_LIMIT_MAX))}`,
    ),
  ],
);

/**
 * A trial grant: one row per trial ORDER, and the record that a customer used one.
 *
 * ADR-0015 makes a trial allowance a LIMIT and a USED count, stored separately. This
 * table is the used count: a customer's used is the number of their rows with
 * `released_at` NULL, and the limit is `trial.limit_per_customer`. The count is taken
 * under the customer's row lock (`TrialService.claim`), because a count is a read
 * followed by a write and two concurrent claims would otherwise both read zero.
 *
 * Until WP6-A this table was one row per customer, ever — `trial_grants_customer_key`
 * — with a docblock saying a failed provisioning must still consume the grant. Both
 * were overridden: ADR-0015 is accepted policy and allows a limit above one, and plan
 * §7.1 requires that a provider create which definitively FAILED does not consume
 * eligibility. `released_at` is that: stamped in the same transaction that gives the
 * trial order back (`UndeliverableOrderRefunder`), and never for an UNKNOWN outcome,
 * which keeps the grant — the account may exist. `docs/wp6-audit.md` A3, A4.
 *
 * Nothing wrote this table before this migration, so the NOT NULL `order_id` it adds
 * met no rows.
 */
export const trialGrants = pgTable(
  'trial_grants',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    /** The trial order. Its line is the snapshot of what the trial was. */
    orderId: uuid('order_id').notNull(),
    /**
     * The product configured as the trial when the grant was made. Navigation only, and
     * NULL for every grant since R1: a trial is issued from a panel's trial configuration,
     * and the panel is on the order.
     */
    productId: uuid('product_id'),
    /** The service the grant produced. Set in the granting transaction. */
    serviceId: uuid('service_id'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    /**
     * When the grant was given back because its service definitively could not be
     * created. NULL means it counts against the customer's limit.
     */
    releasedAt: timestamptz('released_at'),
    /**
     * When a global reset stopped this grant counting, and which one. Both or neither
     * (`trial_grants_reset_pair_check`). Independent of `released_at`: a grant carrying
     * either stamp does not count, so a reset and a release of the same grant can land
     * in either order and it counts zero times, never minus one.
     */
    resetAt: timestamptz('reset_at'),
    resetId: uuid('reset_id'),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'trial_grants_customer_fk',
    }),
    /**
     * CUSTOMER-bearing, like every other child of `orders`: a grant cannot name one
     * customer's order while counting against another customer.
     */
    foreignKey({
      columns: [table.tenantId, table.orderId, table.customerId],
      foreignColumns: [orders.tenantId, orders.id, orders.customerId],
      name: 'trial_grants_order_fk',
    }),
    /** One grant per trial order: a replayed claim cannot count twice. */
    uniqueIndex('trial_grants_order_key').on(table.tenantId, table.orderId),
    /**
     * The limit check's only query, and the reset's: grants that still count. Replaces
     * `trial_grants_customer_counting_idx`, whose predicate did not know about resets.
     */
    index('trial_grants_counting_idx')
      .on(table.tenantId, table.customerId)
      .where(sql`released_at IS NULL AND reset_at IS NULL`),
    foreignKey({
      columns: [table.tenantId, table.resetId],
      foreignColumns: [trialResets.tenantId, trialResets.id],
      name: 'trial_grants_reset_fk',
    }),
    check('trial_grants_reset_pair_check', sql`(reset_at IS NULL) = (reset_id IS NULL)`),
    index('trial_grants_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
    /**
     * Round N: "has this customer ever had a trial", whatever became of it — the audience's
     * trial criterion. `trial_grants_counting_idx` covers only the grants that still count.
     */
    index('trial_grants_customer_idx').on(table.tenantId, table.customerId),
  ],
);

/**
 * R1: one panel's free trial — whether it is offered, how much traffic and for how many
 * hours. One row per panel and NO row for a panel nobody has configured, which offers no
 * trial.
 *
 * Independent of the catalogue by design (the owner's brief): a trial names no product.
 * What a customer is actually offered is this row being enabled AND the one eligibility
 * evaluator (`decideEligibility`) letting the panel take a new account AND the panel's
 * username policy letting the installation choose the name; the claim decides all three
 * again under the customer's and the panel's locks.
 *
 * `revision` is what a write must name, as `panel_policies.revision` is: two operators
 * editing one panel's trial cannot overwrite each other unseen. Editing a row changes no
 * trial already issued — the order's line froze what was granted.
 */
export const panelTrialConfigs = pgTable(
  'panel_trial_configs',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    panelId: uuid('panel_id').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    trafficBytes: bigint('traffic_bytes', { mode: 'bigint' }).notNull(),
    durationHours: integer('duration_hours').notNull(),
    /** The customer-facing name on the choice button. NULL means the panel's own name. */
    label: text('label'),
    revision: integer('revision').notNull().default(1),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.panelId], name: 'panel_trial_configs_pk' }),
    foreignKey({
      columns: [table.tenantId, table.panelId],
      foreignColumns: [panels.tenantId, panels.id],
      name: 'panel_trial_configs_panel_fk',
    }),
    /** The customer's offer reads the enabled rows of one tenant. */
    index('panel_trial_configs_enabled_idx')
      .on(table.tenantId)
      .where(sql`enabled`),
    check(
      'panel_trial_configs_traffic_check',
      sql`traffic_bytes > 0 AND traffic_bytes <= ${sql.raw(String(PANEL_TRIAL_TRAFFIC_MAX_BYTES))}`,
    ),
    check(
      'panel_trial_configs_hours_check',
      sql`duration_hours >= ${sql.raw(String(PANEL_TRIAL_HOURS_MIN))} AND duration_hours <= ${sql.raw(String(PANEL_TRIAL_HOURS_MAX))}`,
    ),
    check(
      'panel_trial_configs_label_check',
      sql`label IS NULL OR length(btrim(label)) BETWEEN 1 AND ${sql.raw(String(PANEL_TRIAL_LABEL_MAX_LENGTH))}`,
    ),
    check('panel_trial_configs_revision_check', sql`revision >= 1`),
  ],
);

/**
 * A reseller tier: the pricing policy, the credit policy and — in `reseller_tier_grants` —
 * the entitlements every reseller on it shares (`docs/wp9-reseller-audit.md` R2, R3, R5).
 *
 * Its own table and never a customer attribute: the legacy tier was one enum read by four
 * subsystems, and that is the failure this keeps out. Edited in place, never deleted while
 * a reseller points at it (the foreign key refuses).
 */
export const resellerTiers = pgTable(
  'reseller_tiers',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    pricingMode: text('pricing_mode').notNull(),
    /** Whole percent off list. Null unless the mode is PERCENTAGE_DISCOUNT. */
    discountPercentage: integer('discount_percentage'),
    /**
     * Kept, not dropped: reseller credit was removed (owner decision, 2026-10-01). Writes can
     * store only zero; a positive value stored before the decision grants nothing.
     */
    creditLimitAmount: bigint('credit_limit_amount', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    creditLimitCurrency: text('credit_limit_currency').notNull(),
    /**
     * Round N, package D: the monthly minimum sales every reseller on this tier inherits, or
     * null — and zero — for none. Tracking only: nothing happens to a reseller below it
     * (`docs/round-n-reseller-audit.md` §3.5).
     */
    monthlyMinimumAmount: bigint('monthly_minimum_amount', { mode: 'bigint' }),
    monthlyMinimumCurrency: text('monthly_minimum_currency'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    /** The composite key the tenant-scoped foreign keys below point at. */
    uniqueIndex('reseller_tiers_tenant_id_key').on(table.tenantId, table.id),
    check(
      'reseller_tiers_minimum_pair_check',
      sql`(monthly_minimum_amount IS NULL) = (monthly_minimum_currency IS NULL)`,
    ),
    check(
      'reseller_tiers_minimum_check',
      sql`monthly_minimum_amount IS NULL OR monthly_minimum_amount >= 0`,
    ),
    check(
      'reseller_tiers_minimum_currency_check',
      sql`monthly_minimum_currency IS NULL OR ${enumCheck('monthly_minimum_currency', CURRENCY_CODES)}`,
    ),
    uniqueIndex('reseller_tiers_tenant_name_key').on(table.tenantId, sql`lower(${table.name})`),
    index('reseller_tiers_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
    check('reseller_tiers_pricing_mode_check', enumCheck('pricing_mode', RESELLER_PRICING_MODES)),
    check(
      'reseller_tiers_credit_currency_check',
      enumCheck('credit_limit_currency', CURRENCY_CODES),
    ),
    check('reseller_tiers_credit_limit_check', sql`credit_limit_amount >= 0`),
    check(
      'reseller_tiers_discount_mode_check',
      sql`(pricing_mode = 'PERCENTAGE_DISCOUNT') = (discount_percentage IS NOT NULL)`,
    ),
    check(
      'reseller_tiers_discount_range_check',
      sql`discount_percentage IS NULL OR (discount_percentage >= 1 AND discount_percentage <= 100)`,
    ),
  ],
);

/**
 * One entitlement a tier grants (R5). Deny by default, per kind: a kind with no row grants
 * nothing. `subject = '*'` grants every subject of its kind — the wire's null; an
 * `OPERATION` subject is an order purpose, every other subject an id of that kind.
 *
 * Replaced as a set, in one transaction, by the operator's grants write.
 */
export const resellerTierGrants = pgTable(
  'reseller_tier_grants',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    tierId: uuid('tier_id').notNull(),
    kind: text('kind').notNull(),
    subject: text('subject').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.tierId, table.kind, table.subject],
      name: 'reseller_tier_grants_pkey',
    }),
    foreignKey({
      columns: [table.tenantId, table.tierId],
      foreignColumns: [resellerTiers.tenantId, resellerTiers.id],
      name: 'reseller_tier_grants_tier_fk',
    }).onDelete('cascade'),
    check('reseller_tier_grants_kind_check', enumCheck('kind', RESELLER_GRANT_KINDS)),
    check(
      'reseller_tier_grants_subject_check',
      sql`subject = '*' OR (kind = 'OPERATION' AND subject IN (${sql.raw(
        RESELLER_GRANTABLE_OPERATIONS.map((o) => `'${o}'`).join(', '),
      )})) OR (kind <> 'OPERATION' AND subject ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')`,
    ),
  ],
);

/**
 * A reseller — a customer with a tier and, possibly, their own pricing override and credit
 * limit (`docs/wp9-reseller-audit.md` R1–R3, R8).
 *
 * `pricing_mode = 'TIER'` is "no override": the tier prices. A null credit limit is "the
 * tier's". The limit, wherever it comes from, is stored POSITIVE and means "the balance may
 * reach minus this", so no comparison is a double negative, and it defaults to ZERO on the
 * tier — a credit feature defaults to no credit.
 */
export const resellers = pgTable(
  'resellers',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    tierId: uuid('tier_id').notNull(),
    status: text('status').notNull().default('ACTIVE'),
    pricingMode: text('pricing_mode').notNull().default('TIER'),
    /** Whole percent off list. Null unless the mode is PERCENTAGE_DISCOUNT. */
    discountPercentage: integer('discount_percentage'),
    /**
     * The reseller's own limit, or null for the tier's. Reseller credit was removed (owner
     * decision, 2026-10-01): writes store only zero or null, and a positive value stored
     * before the decision grants nothing. Kept, not dropped.
     *
     * The `DEFAULT 0` is the column's pre-WP9-B default, KEPT: dropping it is a
     * narrowing the rollback window forbids (`migration-compatibility.test.ts`). It
     * decides nothing — every write here states the amount, and an insert that omitted
     * both columns would take 0 with a NULL currency, which the pair CHECK refuses.
     */
    creditLimitAmount: bigint('credit_limit_amount', { mode: 'bigint' }).default(sql`0`),
    creditLimitCurrency: text('credit_limit_currency'),
    /**
     * Round N, package D: the reseller's own monthly minimum. NULL inherits the tier's; ZERO
     * is an explicit "no minimum for this reseller"; positive is theirs. Tracking only.
     */
    monthlyMinimumAmount: bigint('monthly_minimum_amount', { mode: 'bigint' }),
    monthlyMinimumCurrency: text('monthly_minimum_currency'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'resellers_customer_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.tierId],
      foreignColumns: [resellerTiers.tenantId, resellerTiers.id],
      name: 'resellers_tier_fk',
    }),
    /** A customer is a reseller once, or not at all. */
    uniqueIndex('resellers_customer_key').on(table.tenantId, table.customerId),
    index('resellers_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
    index('resellers_tenant_tier_idx').on(table.tenantId, table.tierId),
    check('resellers_status_check', enumCheck('status', RESELLER_STATUSES)),
    check('resellers_pricing_mode_check', enumCheck('pricing_mode', RESELLER_OVERRIDE_MODES)),
    check(
      'resellers_credit_currency_check',
      sql`credit_limit_currency IS NULL OR ${enumCheck('credit_limit_currency', CURRENCY_CODES)}`,
    ),
    /** Both halves of the override, or neither. */
    check(
      'resellers_credit_pair_check',
      sql`(credit_limit_amount IS NULL) = (credit_limit_currency IS NULL)`,
    ),
    /** Stored positive, so every comparison against it reads forwards. */
    check(
      'resellers_credit_limit_check',
      sql`credit_limit_amount IS NULL OR credit_limit_amount >= 0`,
    ),
    check(
      'resellers_discount_mode_check',
      sql`(pricing_mode = 'PERCENTAGE_DISCOUNT') = (discount_percentage IS NOT NULL)`,
    ),
    check(
      'resellers_discount_range_check',
      sql`discount_percentage IS NULL OR (discount_percentage >= 1 AND discount_percentage <= 100)`,
    ),
    check(
      'resellers_minimum_pair_check',
      sql`(monthly_minimum_amount IS NULL) = (monthly_minimum_currency IS NULL)`,
    ),
    check(
      'resellers_minimum_check',
      sql`monthly_minimum_amount IS NULL OR monthly_minimum_amount >= 0`,
    ),
    check(
      'resellers_minimum_currency_check',
      sql`monthly_minimum_currency IS NULL OR ${enumCheck('monthly_minimum_currency', CURRENCY_CODES)}`,
    ),
  ],
);

/**
 * Round N, package D (R1): one row per entitlement DIMENSION a reseller overrides. The
 * reseller's grants of that dimension — `reseller_grant_overrides` — REPLACE the tier's
 * grants of the whole dimension; a dimension with no row here inherits the tier's. A row
 * with no grants beneath it overrides the dimension with nothing: deny by default.
 *
 * Replaced as a set, with its grants, under the reseller row's `FOR UPDATE` — the row
 * `ResellerService.standing` reads `FOR SHARE` — so a withdrawal and a sale serialise.
 */
export const resellerEntitlementOverrides = pgTable(
  'reseller_entitlement_overrides',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    dimension: text('dimension').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.customerId, table.dimension],
      name: 'reseller_entitlement_overrides_pkey',
    }),
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [resellers.tenantId, resellers.customerId],
      name: 'reseller_entitlement_overrides_reseller_fk',
    }).onDelete('cascade'),
    check(
      'reseller_entitlement_overrides_dimension_check',
      enumCheck('dimension', RESELLER_ENTITLEMENT_DIMENSIONS),
    ),
  ],
);

/**
 * One grant of a reseller's override (R1): `reseller_tier_grants`' shape and subject rule,
 * under the dimension row it belongs to. `dimension` is the kind's own
 * (`RESELLER_GRANT_DIMENSION`), pinned by a CHECK so a grant cannot sit under another
 * dimension's override and be read as part of it.
 */
export const resellerGrantOverrides = pgTable(
  'reseller_grant_overrides',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    dimension: text('dimension').notNull(),
    kind: text('kind').notNull(),
    subject: text('subject').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.customerId, table.kind, table.subject],
      name: 'reseller_grant_overrides_pkey',
    }),
    foreignKey({
      columns: [table.tenantId, table.customerId, table.dimension],
      foreignColumns: [
        resellerEntitlementOverrides.tenantId,
        resellerEntitlementOverrides.customerId,
        resellerEntitlementOverrides.dimension,
      ],
      name: 'reseller_grant_overrides_dimension_fk',
    }).onDelete('cascade'),
    check('reseller_grant_overrides_kind_check', enumCheck('kind', RESELLER_GRANT_KINDS)),
    check(
      'reseller_grant_overrides_dimension_check',
      sql`(kind = 'OPERATION' AND dimension = 'OPERATION')
          OR (kind IN ('PRODUCT', 'CATEGORY') AND dimension = 'CATALOGUE')
          OR (kind = 'PANEL' AND dimension = 'PANEL')
          OR (kind = 'BOT' AND dimension = 'BOT')`,
    ),
    check(
      'reseller_grant_overrides_subject_check',
      sql`subject = '*' OR (kind = 'OPERATION' AND subject IN (${sql.raw(
        RESELLER_GRANTABLE_OPERATIONS.map((o) => `'${o}'`).join(', '),
      )})) OR (kind <> 'OPERATION' AND subject ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')`,
    ),
  ],
);

/**
 * Round N, package D (R2): one thing the lane told — or will tell — a reseller about one
 * month's minimum. The SUBJECT of `RESELLER_MINIMUM_REMINDER` and `_ACHIEVED`, for the
 * reason `wallet_threshold_alerts` is one: keyed on the customer, the lane's own subject
 * key would let a reseller be reminded once for ever.
 *
 * Unique per (reseller, kind, month): two worker replicas, a restart and every later pass
 * of the sweep write at most one reminder and one achievement per reseller per month.
 * Nothing else is written by the sweep: this row is not a debt, a fee or a status.
 */
export const resellerMinimumNotices = pgTable(
  'reseller_minimum_notices',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    kind: text('kind').notNull(),
    /** The month, half-open `[period_start, period_end)`, in the tenant's calendar. */
    periodStart: timestamptz('period_start').notNull(),
    periodEnd: timestamptz('period_end').notNull(),
    /** The effective minimum when the notice was raised: what the send-time re-check compares. */
    minimumAmount: bigint('minimum_amount', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    /** The month's sales when the notice was raised. */
    achievedAmount: bigint('achieved_amount', { mode: 'bigint' }).notNull(),
    raisedAt: timestamptz('raised_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [resellers.tenantId, resellers.customerId],
      name: 'reseller_minimum_notices_reseller_fk',
    }),
    /** At most one of each kind per reseller per month: the arbiter of every insert. */
    unique('reseller_minimum_notices_period_key').on(
      table.tenantId,
      table.customerId,
      table.kind,
      table.periodStart,
    ),
    check('reseller_minimum_notices_kind_check', enumCheck('kind', RESELLER_MINIMUM_NOTICE_KINDS)),
    check('reseller_minimum_notices_currency_check', enumCheck('currency', CURRENCY_CODES)),
    check('reseller_minimum_notices_period_check', sql`period_end > period_start`),
    check(
      'reseller_minimum_notices_amounts_check',
      sql`minimum_amount > 0 AND achieved_amount >= 0`,
    ),
  ],
);

/**
 * What a reseller's purchase was, frozen at confirmation (R9). One row per order,
 * append-only (migration guard), written in the transaction that confirms the order.
 *
 * The margin is `list − cost` and is never a discount; the promotion discount is WP8's,
 * taken off the cost. `sale = cost − promotion` is the order's total.
 */
export const orderResellerTerms = pgTable(
  'order_reseller_terms',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    orderId: uuid('order_id').notNull(),
    resellerCustomerId: uuid('reseller_customer_id').notNull(),
    tierId: uuid('tier_id').notNull(),
    tierName: text('tier_name').notNull(),
    layer: text('layer').notNull(),
    percent: integer('percent'),
    listAmount: bigint('list_amount', { mode: 'bigint' }).notNull(),
    costAmount: bigint('cost_amount', { mode: 'bigint' }).notNull(),
    promotionAmount: bigint('promotion_amount', { mode: 'bigint' }).notNull(),
    saleAmount: bigint('sale_amount', { mode: 'bigint' }).notNull(),
    marginAmount: bigint('margin_amount', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    botInstanceId: uuid('bot_instance_id'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.orderId], name: 'order_reseller_terms_pkey' }),
    foreignKey({
      columns: [table.tenantId, table.orderId, table.resellerCustomerId],
      foreignColumns: [orders.tenantId, orders.id, orders.customerId],
      name: 'order_reseller_terms_order_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.tierId],
      foreignColumns: [resellerTiers.tenantId, resellerTiers.id],
      name: 'order_reseller_terms_tier_fk',
    }),
    index('order_reseller_terms_tenant_reseller_idx').on(
      table.tenantId,
      table.resellerCustomerId,
      table.createdAt,
    ),
    check('order_reseller_terms_layer_check', enumCheck('layer', RESELLER_PRICE_LAYERS)),
    check('order_reseller_terms_currency_check', enumCheck('currency', CURRENCY_CODES)),
    check(
      'order_reseller_terms_amounts_check',
      sql`list_amount >= 0 AND cost_amount >= 0 AND promotion_amount >= 0 AND sale_amount >= 0
          AND cost_amount <= list_amount
          AND sale_amount = cost_amount - promotion_amount
          AND margin_amount = list_amount - cost_amount`,
    ),
    check(
      'order_reseller_terms_percent_check',
      sql`(percent IS NULL OR (percent >= 1 AND percent <= 100))
          AND (layer <> 'TIER' OR percent IS NOT NULL)
          AND (layer <> 'LIST' OR (percent IS NULL AND cost_amount = list_amount))`,
    ),
  ],
);

/**
 * The queue of things to tell a customer that they did not ask for.
 *
 * `ADR 0030` decides the shape and `docs/phase4h-audit.md` §1 measures the absence it
 * fills: before Phase 4H this product could tell a customer exactly ONE such thing, the
 * subscription link, whose lane is two columns on `services` and a state table about a
 * subscription link. Phases 4D–4G created several more facts a customer needs and none
 * of them had anywhere to travel.
 *
 * Its own table rather than more columns on the subjects, because the subjects are four
 * different tables and a column pair per table is four copies of one state machine. Its
 * own table rather than `notifications`, because that one's destinations are OPERATOR
 * channels and its `DELIVERY_OUTCOMES` enum is pinned by a CHECK constraint — an
 * operator alert that arrives late is still useful and a duplicate is merely noise, and
 * for a customer neither is true. Not the outbox either: that carries domain EVENTS and
 * freezes their content, and a customer message is an EFFECT of an event.
 *
 * There is no `values` column, and its absence is a decision rather than an omission.
 * Every one of the eight kinds renders a template that declares NO placeholders, so there
 * is nothing to carry; a jsonb column with no producer is the empty table this
 * repository refuses elsewhere. The first kind that needs one adds it, in the migration
 * that needs it.
 */
export const customerNotifications = pgTable(
  'customer_notifications',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    /**
     * Which bot to send from, and never "the tenant's active bot".
     *
     * `CustomerMessenger`'s port states the rule and the reason: a customer wrote to a
     * specific bot, and a reply from a different one arrives from an account they have
     * never heard of — which, for a tenant running a public bot and a reseller bot,
     * leaks the relationship between them. So the producer resolves it at enqueue time
     * from the subject, and the dispatcher does not get to choose.
     */
    botInstanceId: uuid('bot_instance_id').notNull(),
    /** One of `CUSTOMER_NOTIFICATION_KINDS`. The kind decides the template AND the table `subject_id` names. */
    kind: text('kind').notNull(),
    /**
     * The row this notification is about, in the table its `kind` implies.
     *
     * Deliberately NOT accompanied by a `subject_type` column. The kind already
     * determines the table — `PAYMENT_REJECTED` names a payment and nothing else — and a
     * second column saying so is a second source of truth that can disagree with the
     * first. `CUSTOMER_NOTIFICATION_PRECONDITIONS` is keyed on kind for the same reason.
     *
     * No foreign key, and that is deliberate too: the four possible targets are four
     * different tables, and a column cannot reference all of them. What protects it is
     * that the producer writes this row in the SAME transaction as the fact, so a
     * subject that never existed cannot have produced one.
     */
    subjectId: uuid('subject_id').notNull(),
    state: text('state').notNull().default('PENDING'),
    /**
     * Definite refusals observed for THIS message.
     *
     * A rate limit is not one. `CUSTOMER_NOTIFICATION_MAX_ATTEMPTS` states why at
     * length: an attempt is an outcome somebody observed about this message, and
     * Telegram declining to look at it yet is not that. Spending attempts on rate limits
     * fails messages that were never rejected on their merits, in exactly the conditions
     * that produce rate limits.
     */
    attempts: integer('attempts').notNull().default(0),
    /** When the dispatcher may next try. Null means now. */
    nextAttemptAt: timestamptz('next_attempt_at'),
    /**
     * When a send was handed to Telegram with no outcome recorded yet.
     *
     * `services.delivery_send_started_at` for this lane, and it exists for the identical
     * reason: it is the one fact distinguishing "this process died BEFORE sending" from
     * "this process died AFTER sending", and only the second must never be repeated
     * automatically. Without it a dispatcher killed mid-send leaves a row `PENDING`
     * behind nothing but a lease, and the next pass tells the customer again.
     *
     * Cleared by every recorded outcome, so a set value always means an unresolved send.
     */
    sendStartedAt: timestamptz('send_started_at'),
    /**
     * When this row stopped being `PENDING`, whatever it became.
     *
     * One stamp rather than one per terminal state. `state` already says WHICH outcome,
     * and a `delivered_at` beside a `failed_at` beside a `superseded_at` is three
     * columns that can disagree with the one that decides.
     */
    resolvedAt: timestamptz('resolved_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'customer_notifications_customer_fk',
    }),
    check('customer_notifications_kind_check', enumCheck('kind', CUSTOMER_NOTIFICATION_KINDS)),
    check('customer_notifications_state_check', enumCheck('state', CUSTOMER_NOTIFICATION_STATES)),
    /**
     * A resolved row has a stamp and a `PENDING` one does not, as an equality.
     *
     * The same shape as `orders_cancelled_at_check`, which the 4G audit found had made
     * its own state unwritable — so this one is stated as an equality over the state
     * rather than a one-way implication, and 4H-2's tests write every terminal state
     * through it rather than trusting that they can.
     */
    check(
      'customer_notifications_resolved_check',
      sql`(state <> 'PENDING') = (resolved_at IS NOT NULL)`,
    ),
    /**
     * One notification of one kind per subject, for ever.
     *
     * This is the idempotency of the whole lane and it is a CONSTRAINT rather than a
     * check in a service: the producers enqueue inside the transaction that produced the
     * fact, two worker replicas are the normal case on every rolling update, and a
     * redelivered outbox message replays its effect. "Payment X was rejected" is told
     * once whichever of those happens.
     */
    unique('customer_notifications_subject_key').on(table.tenantId, table.kind, table.subjectId),
    /** The dispatcher's claim: queued rows whose backoff has elapsed, oldest first. */
    index('customer_notifications_due_idx')
      .on(table.nextAttemptAt)
      .where(sql`state = 'PENDING'`),
  ],
);

// --- Customer UX completion (docs/customer-ux-completion-audit.md) -------------

/**
 * PostgreSQL `bytea`, which drizzle's pg-core does not model. Two consumers, both below:
 * the tenant media slot and support's staged reply files (HF-A7) — one definition, never a
 * second.
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

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
     * windows (WP-A7) their category or their ticket; the other purposes name nothing.
     */
    check(
      'customer_text_captures_subject_check',
      sql`(purpose IN ('SERVICE_NOTE', 'SERVICE_REFUND_REASON', 'CUSTOM_SERVICE_VOLUME', 'CUSTOM_SERVICE_DAYS', 'SERVICE_TRANSFER_RECIPIENT', 'TICKET_NEW_MESSAGE', 'TICKET_REPLY')) = (subject_id IS NOT NULL)`,
    ),
    /** Only the days window carries a volume, and it always does (Package D). */
    check(
      'customer_text_captures_custom_volume_check',
      sql`(purpose = 'CUSTOM_SERVICE_DAYS') = (custom_volume_units IS NOT NULL)
          AND (custom_volume_units IS NULL OR custom_volume_units > 0)`,
    ),
  ],
);

/**
 * The tenant's FAQ, as the operator maintains it. The nine approved defaults are copied
 * in from the catalogue the first time a tenant's FAQ is read (see `support_faq_seeds`);
 * from then on these rows are the operator's and the catalogue is not consulted.
 */
export const supportFaqs = pgTable(
  'support_faqs',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    question: text('question').notNull(),
    answer: text('answer').notNull(),
    status: text('status').notNull().default('ACTIVE'),
    sortOrder: integer('sort_order').notNull().default(0),
    version: integer('version').notNull().default(1),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    /** The customer's screen: active rows in order. */
    index('support_faqs_tenant_sort_idx').on(
      table.tenantId,
      table.sortOrder,
      table.createdAt,
      table.id,
    ),
    unique('support_faqs_tenant_id_key').on(table.tenantId, table.id),
    check('support_faqs_status_check', enumCheck('status', SUPPORT_FAQ_STATUSES)),
    check(
      'support_faqs_question_check',
      sql`length(btrim(question)) BETWEEN 1 AND ${sql.raw(String(SUPPORT_FAQ_QUESTION_MAX_LENGTH))}`,
    ),
    check(
      'support_faqs_answer_check',
      sql`length(btrim(answer)) BETWEEN 1 AND ${sql.raw(String(SUPPORT_FAQ_ANSWER_MAX_LENGTH))}`,
    ),
    check('support_faqs_sort_order_check', sql`sort_order BETWEEN 0 AND 100000`),
    check('support_faqs_version_check', sql`version >= 1`),
  ],
);

/**
 * That a tenant's FAQ defaults were seeded, once. A tenant that then deletes or
 * deactivates every entry is NOT re-seeded — an empty FAQ is a decision the operator
 * made, and the seed is a convenience for a tenant that never had one.
 */
export const supportFaqSeeds = pgTable('support_faq_seeds', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id),
  seededAt: timestamptz('seeded_at').notNull().defaultNow(),
});

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

/**
 * The tenant's media slots: today the referral banner. The BYTES live here, bounded,
 * so nothing customer-facing ever carries a filesystem path and a bot-scoped Telegram
 * `file_id` is never the source of truth. The Web Admin reads the metadata and never
 * the bytes; the bot sends the bytes by multipart upload.
 */
export const tenantMediaAssets = pgTable(
  'tenant_media_assets',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    purpose: text('purpose').notNull(),
    mimeType: text('mime_type').notNull(),
    content: bytea('content').notNull(),
    byteLength: integer('byte_length').notNull(),
    sha256: text('sha256').notNull(),
    version: integer('version').notNull().default(1),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'tenant_media_assets_pk', columns: [table.tenantId, table.purpose] }),
    check('tenant_media_assets_purpose_check', enumCheck('purpose', TENANT_MEDIA_PURPOSES)),
    /*
     * By hand: `enumCheck` refuses a literal with a slash, and a MIME type has one. The
     * list is the contract's; the guard below is what `enumCheck` would have applied.
     */
    check(
      'tenant_media_assets_mime_check',
      sql`mime_type IN (${sql.raw(
        TENANT_MEDIA_MIME_TYPES.map((value) => {
          if (!/^[a-z]+\/[a-z0-9.+-]+$/.test(value)) {
            throw new Error(`tenant_media_assets: "${value}" is not a plain MIME literal.`);
          }
          return `'${value}'`;
        }).join(', '),
      )})`,
    ),
    check(
      'tenant_media_assets_size_check',
      sql`byte_length BETWEEN 1 AND ${sql.raw(String(TENANT_MEDIA_MAX_BYTES))} AND byte_length = octet_length(content)`,
    ),
    check('tenant_media_assets_sha256_check', sql`sha256 ~ '^[0-9a-f]{64}$'`),
    check('tenant_media_assets_version_check', sql`version >= 1`),
  ],
);

/**
 * WP19 — a customer's request to cancel a service and have money returned
 * (`docs/wp19-service-refund-request-audit.md`).
 *
 * The row IS the record, independently of any Telegram message: a review card that is
 * never delivered loses nothing, because the Web Admin reads this table. Every state change
 * is a conditional UPDATE naming its `from` (`SERVICE_REFUND_REQUEST_TRANSITIONS`).
 *
 * The money is NOT here. The approved amount is RESERVED by a `REQUESTED` refund row
 * (`refund_id`) the moment an administrator confirms, and CREDITED only when the `TERMINATE`
 * operation (`operation_id`) has definitively deleted the provider account. This row links
 * the two and carries what neither of them does: the customer's reason and the decision.
 */
export const serviceRefundRequests = pgTable(
  'service_refund_requests',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    serviceId: uuid('service_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    /** The service's own NEW_SERVICE order, and the CONFIRMED payment that paid for it. */
    orderId: uuid('order_id').notNull(),
    paymentId: uuid('payment_id').notNull(),
    /** The bot the customer filed through: the review cards and replies come from it. */
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    state: text('state').notNull().default('OPEN'),
    /** The customer's reason, trimmed, as they typed it. */
    reason: text('reason').notNull(),
    /**
     * The filing's idempotency key: the Telegram update that carried the reason. Unique for
     * ever, not just while the request is live — a redelivered update after the request was
     * rejected or failed is answered with that request, never filed a second time.
     */
    filingKey: text('filing_key').notNull(),
    /** The source payment's principal (never the gateway fee), in its currency. A snapshot. */
    principalMinor: bigint('principal_minor', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    /** Set by the approval, with the three below; null while OPEN and on a rejection. */
    approvedAmountMinor: bigint('approved_amount_minor', { mode: 'bigint' }),
    refundId: uuid('refund_id'),
    operationId: uuid('operation_id'),
    /** Who decided — an approval or a rejection — and when. */
    decidedByAdminId: uuid('decided_by_admin_id'),
    decidedAt: timestamptz('decided_at'),
    /** A rejection's mandatory reason, which the customer is told. */
    rejectionReason: text('rejection_reason'),
    /** Why the deletion failed, as the operation recorded it: a code, never provider text. */
    failureKind: text('failure_kind'),
    resolvedAt: timestamptz('resolved_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    unique('service_refund_requests_tenant_id_key').on(table.tenantId, table.id),
    /** A refund row reserves money for at most one request. */
    unique('service_refund_requests_refund_key').on(table.tenantId, table.refundId),
    /** One request per filing, whatever became of it. */
    unique('service_refund_requests_filing_key').on(table.tenantId, table.filingKey),
    /**
     * ONE open request per service, decided by the database: a double tap, a replayed
     * update and two concurrent filings all meet this index, whatever the code forgot.
     */
    uniqueIndex('service_refund_requests_active_key')
      .on(table.tenantId, table.serviceId)
      .where(sql`state IN ('OPEN', 'EXECUTING')`),
    /** The sweep's read: executing requests, oldest first. */
    index('service_refund_requests_state_idx').on(table.tenantId, table.state, table.createdAt),
    /*
     * The attention stream's read: every request still needing an administrator, newest
     * first by `(created_at, id)` across all three states (Codex review of #83, round 11).
     * The state index groups by state and has no tie-breaker, so a page there collects and
     * sorts the whole matching history first — and FAILED is terminal and only grows.
     * Ascending on purpose: scanned backwards it is `DESC NULLS FIRST`, which is what
     * `ORDER BY ... DESC` means. Drizzle's `.desc()` writes `DESC NULLS LAST`, an order the
     * query never asks for, and PostgreSQL then sorts after all.
     */
    index('service_refund_requests_attention_idx')
      .on(table.tenantId, table.createdAt, table.id)
      .where(sql`state IN ('OPEN', 'EXECUTING', 'FAILED')`),
    index('service_refund_requests_service_idx').on(
      table.tenantId,
      table.serviceId,
      table.createdAt,
    ),
    foreignKey({
      columns: [table.tenantId, table.serviceId],
      foreignColumns: [services.tenantId, services.id],
      name: 'service_refund_requests_service_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'service_refund_requests_customer_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
      name: 'service_refund_requests_order_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
      name: 'service_refund_requests_payment_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.refundId],
      foreignColumns: [refunds.tenantId, refunds.id],
      name: 'service_refund_requests_refund_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.operationId],
      foreignColumns: [provisioningOperations.tenantId, provisioningOperations.id],
      name: 'service_refund_requests_operation_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.decidedByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
      name: 'service_refund_requests_admin_fk',
    }),
    check('service_refund_requests_state_check', enumCheck('state', SERVICE_REFUND_REQUEST_STATES)),
    check('service_refund_requests_currency_check', enumCheck('currency', CURRENCY_CODES)),
    check(
      'service_refund_requests_reason_check',
      sql`reason = btrim(reason) AND char_length(reason) BETWEEN ${sql.raw(String(SERVICE_REFUND_REASON_MIN_LENGTH))} AND ${sql.raw(String(SERVICE_REFUND_REASON_MAX_LENGTH))}`,
    ),
    check('service_refund_requests_principal_check', sql`principal_minor > 0`),
    /**
     * What each state must carry. An OPEN request has decided nothing; one that was
     * approved carries the amount, the reservation, the deletion and the administrator; a
     * rejection carries its reason and its administrator. Written as the state's
     * consequences so a writer that forgets one fails here.
     */
    check(
      'service_refund_requests_open_check',
      sql`state <> 'OPEN' OR (approved_amount_minor IS NULL AND refund_id IS NULL
          AND operation_id IS NULL AND decided_by_admin_id IS NULL AND decided_at IS NULL
          AND rejection_reason IS NULL)`,
    ),
    check(
      'service_refund_requests_approved_check',
      sql`state NOT IN ('EXECUTING', 'COMPLETED', 'FAILED') OR (approved_amount_minor > 0
          AND approved_amount_minor <= principal_minor AND refund_id IS NOT NULL
          AND operation_id IS NOT NULL AND decided_by_admin_id IS NOT NULL
          AND decided_at IS NOT NULL AND rejection_reason IS NULL)`,
    ),
    check(
      'service_refund_requests_rejected_check',
      sql`state <> 'REJECTED' OR (rejection_reason IS NOT NULL
          AND length(btrim(rejection_reason)) BETWEEN 1 AND 500
          AND decided_by_admin_id IS NOT NULL AND decided_at IS NOT NULL
          AND approved_amount_minor IS NULL AND refund_id IS NULL AND operation_id IS NULL)`,
    ),
    check(
      'service_refund_requests_resolved_check',
      sql`(state IN ('COMPLETED', 'REJECTED', 'FAILED')) = (resolved_at IS NOT NULL)`,
    ),
  ],
);

/**
 * WP19 — one administrator's review card for one refund request: the receipt push's shape
 * (ADR-0031) and its outcome table, applied to a different subject. Text only — there is no
 * file to send.
 */
export const serviceRefundRequestPushes = pgTable(
  'service_refund_request_pushes',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    requestId: uuid('request_id').notNull(),
    adminId: uuid('admin_id').notNull(),
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    state: text('state').notNull().default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamptz('next_attempt_at'),
    sendStartedAt: timestamptz('send_started_at'),
    chatId: text('chat_id'),
    lastErrorCode: text('last_error_code'),
    resolvedAt: timestamptz('resolved_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    /** One card per request per administrator, for ever. */
    unique('service_refund_request_pushes_request_admin_key').on(
      table.tenantId,
      table.requestId,
      table.adminId,
    ),
    foreignKey({
      columns: [table.tenantId, table.requestId],
      foreignColumns: [serviceRefundRequests.tenantId, serviceRefundRequests.id],
      name: 'service_refund_request_pushes_request_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.adminId],
      foreignColumns: [admins.tenantId, admins.id],
      name: 'service_refund_request_pushes_admin_fk',
    }),
    index('service_refund_request_pushes_due_idx')
      .on(table.tenantId, table.nextAttemptAt)
      .where(sql`state = 'PENDING'`),
    check(
      'service_refund_request_pushes_state_check',
      enumCheck('state', RECEIPT_REVIEW_PUSH_STATES),
    ),
    check(
      'service_refund_request_pushes_resolved_check',
      sql`(state <> 'PENDING') = (resolved_at IS NOT NULL)`,
    ),
    check('service_refund_request_pushes_attempts_check', sql`attempts >= 0`),
  ],
);

// --- Package D: the custom service (docs/package-d-custom-service-audit.md) -----------

/**
 * A panel offered for custom service, and the name a customer sees it by.
 *
 * An explicit opt-in: a panel's `name` is the operator's internal label, so it is never
 * shown to a customer, and a panel with no row here is not a custom-service location.
 * Whether the panel can take a new service right now is still `PanelSalesGate`'s answer.
 */
export const customServiceLocations = pgTable(
  'custom_service_locations',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    panelId: uuid('panel_id').notNull(),
    label: text('label').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.panelId], name: 'custom_service_locations_pk' }),
    foreignKey({
      columns: [table.tenantId, table.panelId],
      foreignColumns: [panels.tenantId, panels.id],
      name: 'custom_service_locations_panel_fk',
    }),
    check(
      'custom_service_locations_label_check',
      sql`length(btrim(label)) BETWEEN 1 AND ${sql.raw(String(CUSTOM_SERVICE_LABEL_MAX_LENGTH))}`,
    ),
  ],
);

/**
 * One custom-service price rule (brief D2).
 *
 * `min_units`/`max_units` are inclusive, in the dimension's unit: hundredths of a GB for
 * VOLUME, days for TIME. The price is per GB or per day. Specificity is the triple
 * (customer, tier, panel): a customer rule names no tier; a rule with neither is the
 * ordinary customers'; a null panel is every panel.
 *
 * Overlap between enabled rules of one dimension at one specificity is refused by the
 * service under a per-tenant advisory lock, not here: an exclusion constraint would need
 * `btree_gist`, which this schema has never required.
 */
export const customServicePriceRules = pgTable(
  'custom_service_price_rules',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    dimension: text('dimension').notNull(),
    label: text('label'),
    minUnits: bigint('min_units', { mode: 'bigint' }).notNull(),
    maxUnits: bigint('max_units', { mode: 'bigint' }).notNull(),
    unitPriceAmount: bigint('unit_price_amount', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    customerId: uuid('customer_id'),
    resellerTierId: uuid('reseller_tier_id'),
    panelId: uuid('panel_id'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('custom_service_price_rules_tenant_id_key').on(table.tenantId, table.id),
    index('custom_service_price_rules_tenant_dimension_idx').on(
      table.tenantId,
      table.dimension,
      table.enabled,
    ),
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'custom_service_price_rules_customer_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.resellerTierId],
      foreignColumns: [resellerTiers.tenantId, resellerTiers.id],
      name: 'custom_service_price_rules_tier_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.panelId],
      foreignColumns: [panels.tenantId, panels.id],
      name: 'custom_service_price_rules_panel_fk',
    }),
    check(
      'custom_service_price_rules_dimension_check',
      enumCheck('dimension', CUSTOM_SERVICE_RULE_DIMENSIONS),
    ),
    check('custom_service_price_rules_currency_check', enumCheck('currency', CURRENCY_CODES)),
    check('custom_service_price_rules_range_check', sql`min_units >= 1 AND max_units >= min_units`),
    check('custom_service_price_rules_price_check', sql`unit_price_amount > 0`),
    check(
      'custom_service_price_rules_specificity_check',
      sql`customer_id IS NULL OR reseller_tier_id IS NULL`,
    ),
    check(
      'custom_service_price_rules_label_check',
      sql`label IS NULL OR length(btrim(label)) BETWEEN 1 AND ${sql.raw(String(CUSTOM_SERVICE_LABEL_MAX_LENGTH))}`,
    ),
  ],
);

/**
 * What a custom order was priced by, written ONCE in the draft's transaction (brief D6).
 *
 * Rule ids are copied, not foreign keys, and a trigger refuses UPDATE and DELETE: editing
 * or deleting a rule later rewrites nothing here. The CHECKs pin the arithmetic, so a
 * stored row cannot say one price and mean another.
 */
/**
 * Phase C3: why a new-service order landed on the panel it did.
 *
 * One row per order that automatic balancing CONSIDERED — the flag on and the product's
 * panel in a group — written in the draft's own transaction and never changed (a trigger
 * refuses UPDATE). An order with no row went to its product's own panel by the explicit
 * route. `candidates` is the ranked group as the decision saw it, figures included, so the
 * explanation is what was decided and not a re-reading of today's load.
 */
export const orderPanelPlacements = pgTable(
  'order_panel_placements',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    orderId: uuid('order_id').notNull(),
    homePanelId: uuid('home_panel_id').notNull(),
    chosenPanelId: uuid('chosen_panel_id').notNull(),
    balancingGroup: text('balancing_group').notNull(),
    strategy: text('strategy').notNull(),
    decidedBy: text('decided_by').notNull(),
    candidates: jsonb('candidates').notNull(),
    decidedAt: timestamptz('decided_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.orderId], name: 'order_panel_placements_pk' }),
    foreignKey({
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
      name: 'order_panel_placements_order_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.homePanelId],
      foreignColumns: [panels.tenantId, panels.id],
      name: 'order_panel_placements_home_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.chosenPanelId],
      foreignColumns: [panels.tenantId, panels.id],
      name: 'order_panel_placements_chosen_fk',
    }),
    check(
      'order_panel_placements_strategy_check',
      enumCheck('strategy', PANEL_BALANCING_STRATEGIES),
    ),
    check(
      'order_panel_placements_decided_by_check',
      enumCheck('decided_by', PANEL_PLACEMENT_DECIDERS),
    ),
    check(
      'order_panel_placements_candidates_check',
      sql`jsonb_typeof(${table.candidates}) = 'array'`,
    ),
  ],
);

export const orderCustomServiceTerms = pgTable(
  'order_custom_service_terms',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    orderId: uuid('order_id').notNull(),
    panelId: uuid('panel_id').notNull(),
    locationLabel: text('location_label').notNull(),
    volumeUnits: bigint('volume_units', { mode: 'bigint' }).notNull(),
    trafficBytes: bigint('traffic_bytes', { mode: 'bigint' }).notNull(),
    durationDays: integer('duration_days').notNull(),
    volumeRuleId: uuid('volume_rule_id').notNull(),
    volumeRuleLevel: text('volume_rule_level').notNull(),
    pricePerGbAmount: bigint('price_per_gb_amount', { mode: 'bigint' }).notNull(),
    volumeAmount: bigint('volume_amount', { mode: 'bigint' }).notNull(),
    timeRuleId: uuid('time_rule_id').notNull(),
    timeRuleLevel: text('time_rule_level').notNull(),
    pricePerDayAmount: bigint('price_per_day_amount', { mode: 'bigint' }).notNull(),
    timeAmount: bigint('time_amount', { mode: 'bigint' }).notNull(),
    baseAmount: bigint('base_amount', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.orderId], name: 'order_custom_service_terms_pk' }),
    foreignKey({
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
      name: 'order_custom_service_terms_order_fk',
    }),
    check('order_custom_service_terms_currency_check', enumCheck('currency', CURRENCY_CODES)),
    check(
      'order_custom_service_terms_volume_level_check',
      enumCheck('volume_rule_level', CUSTOM_SERVICE_RULE_LEVELS),
    ),
    check(
      'order_custom_service_terms_time_level_check',
      enumCheck('time_rule_level', CUSTOM_SERVICE_RULE_LEVELS),
    ),
    check(
      'order_custom_service_terms_positive_check',
      sql`volume_units > 0 AND traffic_bytes > 0 AND duration_days > 0
          AND price_per_gb_amount > 0 AND price_per_day_amount > 0`,
    ),
    /** The arithmetic, as the brief states it: half-up to the minor unit, then a sum. */
    check(
      'order_custom_service_terms_volume_amount_check',
      sql`volume_amount = (volume_units * price_per_gb_amount + 50) / 100`,
    ),
    check(
      'order_custom_service_terms_time_amount_check',
      sql`time_amount = duration_days * price_per_day_amount`,
    ),
    check(
      'order_custom_service_terms_base_amount_check',
      sql`base_amount = volume_amount + time_amount`,
    ),
  ],
);

/**
 * Package F — one row per change of a service's owner (`docs/package-f-service-transfer-audit.md`).
 *
 * Append-only: `nexa_reject_mutation` refuses an UPDATE or a DELETE, like the audit log.
 * It is the evidence `services.customer_id` moved legitimately, and more than evidence:
 * `nexa_services_ownership_guard` refuses a change of that column unless the NEWEST row
 * here for the service names exactly the old owner and the new one. So no writer — a
 * refactor, a script, an operator's SQL — can hand a service over without leaving this
 * row, in the same transaction.
 *
 * Nothing financial is here, deliberately. The order, its payment and every ledger entry
 * stay the payer's; this records only who owned the service before and after.
 */
export const serviceOwnershipTransfers = pgTable(
  'service_ownership_transfers',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /**
     * The order the rows were written in, per service. "Newest" is decided by this and not
     * by `created_at`: two transfers of one service a clock tick apart — or on two replicas
     * whose clocks disagree — must still have one newest row, and the row lock that
     * serialises them makes this sequence their commit order.
     */
    seq: bigint('seq', { mode: 'bigint' }).generatedAlwaysAsIdentity().notNull(),
    serviceId: uuid('service_id').notNull(),
    fromCustomerId: uuid('from_customer_id').notNull(),
    toCustomerId: uuid('to_customer_id').notNull(),
    /**
     * The bot the sender confirmed through. NULL only for a move no customer confirmed — a
     * Web Admin operator's account transfer (Customer 360), which happens on no bot. Every
     * other actor's transfer names one (`service_ownership_transfers_bot_check`).
     */
    botInstanceId: uuid('bot_instance_id').references(() => botInstances.id),
    /**
     * The confirmation's idempotency key — the Telegram update that carried the tap. Unique
     * for ever, so a redelivered update answers with this row and never transfers again.
     */
    idempotencyKey: text('idempotency_key').notNull(),
    /** Who asked, as the audit row records it: captured at action time. */
    actorType: text('actor_type').notNull(),
    actorLabel: text('actor_label'),
    correlationId: text('correlation_id').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('service_ownership_transfers_tenant_id_key').on(table.tenantId, table.id),
    unique('service_ownership_transfers_key').on(table.tenantId, table.idempotencyKey),
    /** The newest transfer of a service: the ownership guard's read, and the replay's. */
    index('service_ownership_transfers_service_idx').on(table.tenantId, table.serviceId, table.seq),
    foreignKey({
      columns: [table.tenantId, table.serviceId],
      foreignColumns: [services.tenantId, services.id],
      name: 'service_ownership_transfers_service_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.fromCustomerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'service_ownership_transfers_from_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.toCustomerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'service_ownership_transfers_to_fk',
    }),
    /** A service is never "transferred" to the customer who already has it. */
    check('service_ownership_transfers_parties_check', sql`from_customer_id <> to_customer_id`),
    check('service_ownership_transfers_actor_type_check', enumCheck('actor_type', ACTOR_TYPES)),
    check('service_ownership_transfers_key_check', sql`length(idempotency_key) BETWEEN 1 AND 200`),
    check(
      'service_ownership_transfers_bot_check',
      sql`bot_instance_id IS NOT NULL OR actor_type = 'WEB_ADMIN'`,
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

/**
 * One operator account transfer (Customer 360, §11.5, `docs/customer-account-transfer-audit.md`).
 *
 * Append-only (`nexa_reject_mutation`), written in the transaction that moves the services
 * and the balance. It is the record a replay answers from — `(tenant_id, idempotency_key)`
 * is unique for ever — and the evidence of what moved: the service ids, the amount, and the
 * two wallet entries. Each moved service ALSO has its own `service_ownership_transfers` row,
 * because that row is what `nexa_services_ownership_guard` admits a change of owner on.
 */
export const customerAccountTransfers = pgTable(
  'customer_account_transfers',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    fromCustomerId: uuid('from_customer_id').notNull(),
    toCustomerId: uuid('to_customer_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    /** The ids of the services that changed hands, in the order they were moved. */
    serviceIds: jsonb('service_ids').notNull(),
    walletAmount: bigint('wallet_amount', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    /** The DEBIT of the source and the CREDIT of the destination; NULL when nothing moved. */
    debitEntryId: uuid('debit_entry_id'),
    creditEntryId: uuid('credit_entry_id'),
    fingerprint: text('fingerprint').notNull(),
    reason: text('reason').notNull(),
    actorAdminId: uuid('actor_admin_id').references(() => admins.id),
    correlationId: text('correlation_id').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('customer_account_transfers_key').on(table.tenantId, table.idempotencyKey),
    index('customer_account_transfers_from_idx').on(
      table.tenantId,
      table.fromCustomerId,
      table.createdAt,
    ),
    index('customer_account_transfers_to_idx').on(
      table.tenantId,
      table.toCustomerId,
      table.createdAt,
    ),
    foreignKey({
      name: 'customer_account_transfers_from_fk',
      columns: [table.tenantId, table.fromCustomerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    foreignKey({
      name: 'customer_account_transfers_to_fk',
      columns: [table.tenantId, table.toCustomerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    foreignKey({
      name: 'customer_account_transfers_debit_fk',
      columns: [table.tenantId, table.debitEntryId],
      foreignColumns: [walletEntries.tenantId, walletEntries.id],
    }),
    foreignKey({
      name: 'customer_account_transfers_credit_fk',
      columns: [table.tenantId, table.creditEntryId],
      foreignColumns: [walletEntries.tenantId, walletEntries.id],
    }),
    check('customer_account_transfers_parties_check', sql`from_customer_id <> to_customer_id`),
    check('customer_account_transfers_currency_check', enumCheck('currency', CURRENCY_CODES)),
    check('customer_account_transfers_amount_check', sql`wallet_amount >= 0`),
    check(
      'customer_account_transfers_entries_check',
      sql`(wallet_amount = 0) = (debit_entry_id IS NULL) AND (debit_entry_id IS NULL) = (credit_entry_id IS NULL)`,
    ),
    check('customer_account_transfers_key_check', sql`length(idempotency_key) BETWEEN 1 AND 255`),
    check('customer_account_transfers_reason_check', sql`length(reason) BETWEEN 1 AND 500`),
  ],
);

// --- WP-A6: service location change ----------------------------------------------------

/**
 * One requested location change of one service (WP-A6): the snapshot of what was quoted,
 * written once and never edited.
 *
 * It is the history the brief's audit needs and the evidence every later decision reads:
 * where the service was (key and name), where it was going (key and name), which
 * configured target and VERSION priced it, the list price — zero for free — and either
 * the ORDER that paid for it or, for a free change, the OPERATION that carries it out.
 * Its outcome is not stored: it is the operation's state, and for a paid change the
 * order's, read at the time — so there is no second answer to "did it happen".
 *
 * The cooldown and the rolling limit count these rows at decision time, never a counter:
 * a row counts while its order is awaiting payment or paid, or — free — while its
 * operation has not failed.
 */
export const serviceLocationChanges = pgTable(
  'service_location_changes',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    serviceId: uuid('service_id').notNull(),
    /** The owner who asked, when they asked. */
    customerId: uuid('customer_id').notNull(),
    locationId: uuid('location_id').notNull(),
    locationVersion: integer('location_version').notNull(),
    /** Where it was: its recorded location, or its panel's initial one. Always known. */
    fromLocationKey: text('from_location_key').notNull(),
    fromLocationLabel: text('from_location_label').notNull(),
    toLocationKey: text('to_location_key').notNull(),
    toLocationLabel: text('to_location_label').notNull(),
    /** The configured list price at quote time. The CHARGED total is the order's. */
    priceAmount: bigint('price_amount', { mode: 'bigint' }).notNull(),
    priceCurrency: text('price_currency').notNull(),
    /**
     * The cooldown and rolling limit the change was quoted under, frozen with it (Codex
     * review #1 on PR #101): a paid move's confirmation decides its window against THESE,
     * never against terms an operator wrote after the customer was shown the quote.
     */
    cooldownHours: integer('cooldown_hours'),
    maxChanges: integer('max_changes'),
    periodDays: integer('period_days'),
    /** A paid change's order. Exactly one of this and `operation_id` is set. */
    orderId: uuid('order_id'),
    /** A free change's operation, planned in the same transaction as this row. */
    operationId: uuid('operation_id'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('service_location_changes_tenant_id_key').on(table.tenantId, table.id),
    uniqueIndex('service_location_changes_order_key').on(table.tenantId, table.orderId),
    uniqueIndex('service_location_changes_operation_key').on(table.tenantId, table.operationId),
    /** The cooldown and limit read: one service's changes, newest first. */
    index('service_location_changes_service_idx').on(
      table.tenantId,
      table.serviceId,
      table.createdAt,
    ),
    foreignKey({
      columns: [table.tenantId, table.serviceId],
      foreignColumns: [services.tenantId, services.id],
      name: 'service_location_changes_service_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'service_location_changes_customer_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.locationId],
      foreignColumns: [serviceLocations.tenantId, serviceLocations.id],
      name: 'service_location_changes_location_fk',
    }),
    /** With the order's customer too, so the money and the move cannot name two people. */
    foreignKey({
      columns: [table.tenantId, table.orderId, table.customerId],
      foreignColumns: [orders.tenantId, orders.id, orders.customerId],
      name: 'service_location_changes_order_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.operationId],
      foreignColumns: [provisioningOperations.tenantId, provisioningOperations.id],
      name: 'service_location_changes_operation_fk',
    }),
    check(
      'service_location_changes_source_check',
      sql`(order_id IS NULL) <> (operation_id IS NULL)`,
    ),
    /** Free is exactly "no order": a paid change has one, and nothing free is ever paid. */
    check(
      'service_location_changes_price_check',
      sql`price_amount >= 0 AND (price_amount = 0) = (order_id IS NULL)`,
    ),
    check('service_location_changes_currency_check', enumCheck('price_currency', CURRENCY_CODES)),
    check('service_location_changes_moves_check', sql`from_location_key <> to_location_key`),
    check('service_location_changes_version_check', sql`location_version >= 1`),
    check(
      'service_location_changes_limits_check',
      sql`(cooldown_hours IS NULL OR cooldown_hours >= 1)
          AND (max_changes IS NULL) = (period_days IS NULL)
          AND (max_changes IS NULL OR (max_changes >= 1 AND period_days >= 1))`,
    ),
  ],
);

// --- WP-A10: client apps and connection guides -------------------------------------------

/**
 * An array column holding a subset of an enum, EMPTY included — `enumSubsetCheck` refuses
 * empty, and here empty is the meaning "any": an app that names no provider type is offered
 * whatever panel a service is on. The same assertions and escaping as its sibling.
 */
function enumSubsetOrEmptyCheck(column: string, values: readonly string[]): SQL {
  if (!/^[a-z_][a-z0-9_]*$/.test(column)) {
    throw new Error(`enumSubsetOrEmptyCheck: "${column}" is not a plain column name.`);
  }
  const list = values
    .map((value) => {
      if (!ENUM_LITERAL.test(value)) {
        throw new Error(`enumSubsetOrEmptyCheck: "${value}" is not a plain enum literal.`);
      }
      return `'${value.replace(/'/g, "''")}'`;
    })
    .join(', ');
  return sql.raw(`${column} <@ ARRAY[${list}]::text[]`);
}

/**
 * One client app a tenant recommends, on one platform (WP-A10).
 *
 * Tenant CONTENT, like `support_faqs`: an operator writes it in the Web Admin and the bot
 * reads it on every tap, so a link or a guide changes without a deploy. No row is seeded.
 *
 * The three compatibility arrays are what context filtering reads, and empty means "any"
 * for each. Their members are pinned to the contract here; `provider_types` too, so a
 * provider type this release does not know cannot be stored against a row that a future
 * release would then read as a real restriction.
 *
 * The links are stored NORMALISED by `normalizeClientAppUrl` and the constraint repeats
 * the one property the database can check cheaply — the scheme — so a row written around
 * the service still cannot hand Telegram a `javascript:` button.
 */
export const clientApps = pgTable(
  'client_apps',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    platform: text('platform').notNull(),
    name: text('name').notNull(),
    icon: text('icon'),
    description: text('description').notNull(),
    officialUrl: text('official_url').notNull(),
    alternativeUrl: text('alternative_url'),
    helpUrl: text('help_url'),
    guide: text('guide').notNull(),
    deliveryKinds: text('delivery_kinds')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    protocols: text('protocols')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    providerTypes: text('provider_types')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: text('status').notNull().default('ENABLED'),
    sortOrder: integer('sort_order').notNull().default(0),
    version: integer('version').notNull().default(1),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    /*
     * HF-A10 — the entry's optional picture. All six set, or none (`client_apps_image_check`).
     * The bytes are selected by one repository method only, for the bot and the editor's
     * preview; every other read names the metadata columns and never `image_content`.
     */
    imageContent: bytea('image_content'),
    imageMimeType: text('image_mime_type'),
    imageByteLength: integer('image_byte_length'),
    imageWidth: integer('image_width'),
    imageHeight: integer('image_height'),
    imageSha256: text('image_sha256'),
    imageUpdatedAt: timestamptz('image_updated_at'),
  },
  (table) => [
    /** The customer's read: one platform's enabled rows, in the operator's order. */
    index('client_apps_tenant_platform_idx').on(
      table.tenantId,
      table.platform,
      table.status,
      table.sortOrder,
      table.createdAt,
      table.id,
    ),
    unique('client_apps_tenant_id_key').on(table.tenantId, table.id),
    check('client_apps_platform_check', enumCheck('platform', CLIENT_APP_PLATFORMS)),
    check('client_apps_status_check', enumCheck('status', CLIENT_APP_STATUSES)),
    check(
      'client_apps_name_check',
      sql`length(btrim(name)) BETWEEN 1 AND ${sql.raw(String(CLIENT_APP_NAME_MAX_LENGTH))}`,
    ),
    check(
      'client_apps_icon_check',
      sql`icon IS NULL OR length(btrim(icon)) BETWEEN 1 AND ${sql.raw(String(CLIENT_APP_ICON_MAX_LENGTH))}`,
    ),
    check(
      'client_apps_description_check',
      sql`length(btrim(description)) BETWEEN 1 AND ${sql.raw(String(CLIENT_APP_DESCRIPTION_MAX_LENGTH))}`,
    ),
    check(
      'client_apps_guide_check',
      sql`length(btrim(guide)) BETWEEN 1 AND ${sql.raw(String(CLIENT_APP_GUIDE_MAX_LENGTH))}`,
    ),
    check(
      'client_apps_urls_check',
      sql`official_url LIKE 'https://%' AND length(official_url) <= ${sql.raw(String(CLIENT_APP_URL_MAX_LENGTH))}
          AND (alternative_url IS NULL OR (alternative_url LIKE 'https://%' AND length(alternative_url) <= ${sql.raw(String(CLIENT_APP_URL_MAX_LENGTH))}))
          AND (help_url IS NULL OR (help_url LIKE 'https://%' AND length(help_url) <= ${sql.raw(String(CLIENT_APP_URL_MAX_LENGTH))}))`,
    ),
    check(
      'client_apps_delivery_kinds_check',
      enumSubsetOrEmptyCheck('delivery_kinds', CLIENT_APP_DELIVERY_KINDS),
    ),
    check('client_apps_protocols_check', enumSubsetOrEmptyCheck('protocols', CLIENT_APP_PROTOCOLS)),
    check(
      'client_apps_provider_types_check',
      enumSubsetOrEmptyCheck('provider_types', PROVIDER_TYPES),
    ),
    check(
      'client_apps_sort_order_check',
      sql`sort_order BETWEEN ${sql.raw(String(CLIENT_APP_SORT_MIN))} AND ${sql.raw(String(CLIENT_APP_SORT_MAX))}`,
    ),
    check('client_apps_version_check', sql`version >= 1`),
    /*
     * The image is whole or absent, bounded, of a contract type, and its stated length is
     * its real one. Every column is named `IS NOT NULL` in the second arm on purpose: a
     * CHECK passes when it evaluates to NULL, so `image_mime_type IN (…)` alone would admit
     * bytes with no type. The MIME list by hand for `tenant_media_assets_mime_check`'s reason:
     * `enumCheck` refuses a literal with a slash.
     */
    check(
      'client_apps_image_check',
      sql`(image_content IS NULL AND image_mime_type IS NULL AND image_byte_length IS NULL
            AND image_width IS NULL AND image_height IS NULL AND image_sha256 IS NULL
            AND image_updated_at IS NULL)
          OR (image_content IS NOT NULL AND image_mime_type IS NOT NULL
            AND image_byte_length IS NOT NULL AND image_width IS NOT NULL
            AND image_height IS NOT NULL AND image_sha256 IS NOT NULL
            AND image_updated_at IS NOT NULL
            AND image_mime_type IN (${sql.raw(
              CLIENT_APP_IMAGE_MIME_TYPES.map((value) => {
                if (!/^[a-z]+\/[a-z0-9.+-]+$/.test(value)) {
                  throw new Error(`client_apps: "${value}" is not a plain MIME literal.`);
                }
                return `'${value}'`;
              }).join(', '),
            )})
            AND image_byte_length BETWEEN 1 AND ${sql.raw(String(CLIENT_APP_IMAGE_MAX_BYTES))}
            AND image_byte_length = octet_length(image_content)
            AND image_width BETWEEN ${sql.raw(String(CLIENT_APP_IMAGE_MIN_SIDE))} AND ${sql.raw(String(CLIENT_APP_IMAGE_MAX_SIDE))}
            AND image_height BETWEEN ${sql.raw(String(CLIENT_APP_IMAGE_MIN_SIDE))} AND ${sql.raw(String(CLIENT_APP_IMAGE_MAX_SIDE))}
            AND image_sha256 ~ '^[0-9a-f]{64}$')`,
    ),
  ],
);

/**
 * Spec §7: a client app's tutorial VIDEO, set from Telegram by an administrator («تنظیم
 * ویدیو»), one per (app, bot).
 *
 * The media architecture decides the shape (`docs/package-h-tutorials-marketing-stars.md`): the app's
 * PICTURE is bytes in `client_apps` because it is uploaded in the Web Admin and must be
 * sent by any bot; a VIDEO arrives at Telegram from the administrator's phone, so the bytes
 * are already there and this installation keeps only Telegram's reference — `file_id`, which
 * re-sends it with nothing downloaded, and `file_unique_id`, stable across bots. A `file_id`
 * is valid only for the bot that received it, which is why the row is keyed by bot: the bot
 * an administrator sent the video to is the bot that shows it, and a tenant's other bot gets
 * its own. Known limitation, as for receipts: a backup carries this row, not the video.
 *
 * Replacing is an UPDATE that bumps `version`; deleting removes the row. Both are audited
 * (`client_app.video_set`, `client_app.video_delete`). Deleting the app deletes its videos.
 */
export const clientAppVideos = pgTable(
  'client_app_videos',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    clientAppId: uuid('client_app_id').notNull(),
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    /** What `sendVideo` takes. Bot-scoped, and never returned to a browser. */
    fileId: text('file_id').notNull(),
    fileUniqueId: text('file_unique_id').notNull(),
    mimeType: text('mime_type'),
    durationSeconds: integer('duration_seconds'),
    fileSize: bigint('file_size', { mode: 'bigint' }),
    /** The administrator whose message set it. */
    setByAdminId: uuid('set_by_admin_id').notNull(),
    version: integer('version').notNull().default(1),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('client_app_videos_app_bot_key').on(
      table.tenantId,
      table.clientAppId,
      table.botInstanceId,
    ),
    foreignKey({
      columns: [table.tenantId, table.clientAppId],
      foreignColumns: [clientApps.tenantId, clientApps.id],
      name: 'client_app_videos_app_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.tenantId, table.setByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
      name: 'client_app_videos_admin_fk',
    }),
    check(
      'client_app_videos_file_check',
      sql`length(file_id) BETWEEN 1 AND ${sql.raw(String(CLIENT_APP_VIDEO_FILE_ID_MAX_LENGTH))}
          AND length(file_unique_id) BETWEEN 1 AND ${sql.raw(String(CLIENT_APP_VIDEO_FILE_UNIQUE_ID_MAX_LENGTH))}
          AND (mime_type IS NULL OR length(mime_type) BETWEEN 1 AND 128)
          AND (duration_seconds IS NULL OR duration_seconds >= 0)
          AND (file_size IS NULL OR file_size > 0)`,
    ),
    check('client_app_videos_version_check', sql`version >= 1`),
  ],
);

// --- WP-A7: support tickets (docs/wp-a7-tickets-audit.md) --------------------------------

/**
 * The subjects a customer files a ticket under, as the tenant's operators maintain them.
 *
 * Never deleted: a category is deactivated, because tickets name it and a deleted one would
 * leave history pointing at nothing. The five defaults are copied in from the catalogue the
 * first time a tenant's categories are read (`ticket_category_seeds`), the FAQ's pattern.
 */
export const ticketCategories = pgTable(
  'ticket_categories',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    title: text('title').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    unique('ticket_categories_tenant_id_key').on(table.tenantId, table.id),
    /** Two categories with one title would be two buttons a customer cannot tell apart. */
    unique('ticket_categories_title_key').on(table.tenantId, table.title),
    index('ticket_categories_tenant_sort_idx').on(table.tenantId, table.sortOrder, table.id),
    check(
      'ticket_categories_title_check',
      sql`length(btrim(title)) BETWEEN 1 AND ${sql.raw(String(TICKET_CATEGORY_TITLE_MAX_LENGTH))}`,
    ),
    check(
      'ticket_categories_sort_order_check',
      sql`sort_order BETWEEN 0 AND ${sql.raw(String(TICKET_CATEGORY_SORT_MAX))}`,
    ),
  ],
);

/**
 * That a tenant's default categories were seeded, once. A tenant that then deactivates
 * every one is NOT re-seeded — that is a decision the operator made.
 */
export const ticketCategorySeeds = pgTable('ticket_category_seeds', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id),
  seededAt: timestamptz('seeded_at').notNull().defaultNow(),
});

/**
 * One support ticket: a customer's conversation with support about one subject.
 *
 * The status moves only by a conditional UPDATE naming the status it leaves
 * (`TICKET_MACHINE`); `closed_at` is set exactly while it is CLOSED. The category's title is
 * SNAPSHOTTED beside its id, so renaming a category does not rewrite what a customer filed
 * under. The service, order and payment are optional context an operator links; each must be
 * the ticket's customer's own, which the service checks at link time.
 */
export const tickets = pgTable(
  'tickets',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /**
     * The number a customer and an operator quote («تیکت #۱۲۳»). An identity, so it is
     * unique and increasing without a counter row to contend on.
     */
    number: bigint('number', { mode: 'bigint' }).generatedAlwaysAsIdentity().notNull(),
    customerId: uuid('customer_id').notNull(),
    /** The bot the customer opened it through. */
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    categoryId: uuid('category_id').notNull(),
    categoryTitle: text('category_title').notNull(),
    subject: text('subject'),
    status: text('status').notNull().default('OPEN'),
    priority: text('priority').notNull().default('NORMAL'),
    assignedAdminId: uuid('assigned_admin_id'),
    serviceId: uuid('service_id'),
    orderId: uuid('order_id'),
    paymentId: uuid('payment_id'),
    /**
     * The key of the update that opened it. Unique for ever, so a redelivered update
     * answers with this ticket and never opens a second.
     */
    openingKey: text('opening_key').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    lastMessageAt: timestamptz('last_message_at').notNull().defaultNow(),
    closedAt: timestamptz('closed_at'),
  },
  (table) => [
    unique('tickets_tenant_id_key').on(table.tenantId, table.id),
    unique('tickets_opening_key').on(table.tenantId, table.openingKey),
    /** The inbox: newest first, under a keyset on the immutable `(created_at, id)`. */
    index('tickets_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
    index('tickets_tenant_status_idx').on(table.tenantId, table.status, table.createdAt),
    /** A customer's own list in the bot, and the open-ticket rail. */
    index('tickets_tenant_customer_idx').on(table.tenantId, table.customerId, table.status),
    index('tickets_tenant_assignee_idx').on(table.tenantId, table.assignedAdminId),
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'tickets_customer_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.categoryId],
      foreignColumns: [ticketCategories.tenantId, ticketCategories.id],
      name: 'tickets_category_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.assignedAdminId],
      foreignColumns: [admins.tenantId, admins.id],
      name: 'tickets_assignee_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.serviceId],
      foreignColumns: [services.tenantId, services.id],
      name: 'tickets_service_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
      name: 'tickets_order_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
      name: 'tickets_payment_fk',
    }),
    check('tickets_status_check', enumCheck('status', TICKET_STATUSES)),
    check('tickets_priority_check', enumCheck('priority', TICKET_PRIORITIES)),
    /** An equality, the `customer_notifications_resolved_check` shape: closed iff stamped. */
    check('tickets_closed_check', sql`(status = 'CLOSED') = (closed_at IS NOT NULL)`),
    check(
      'tickets_subject_check',
      sql`subject IS NULL OR length(subject) BETWEEN 1 AND ${sql.raw(String(TICKET_SUBJECT_MAX_LENGTH))}`,
    ),
    check(
      'tickets_category_title_check',
      sql`length(category_title) BETWEEN 1 AND ${sql.raw(String(TICKET_CATEGORY_TITLE_MAX_LENGTH))}`,
    ),
    check('tickets_opening_key_check', sql`length(opening_key) BETWEEN 1 AND 300`),
  ],
);

/**
 * One message in a ticket — the conversation's source of truth.
 *
 * Append-only: `nexa_reject_mutation` refuses an UPDATE or a DELETE, so a message sent is a
 * message kept, whatever happened to the Telegram send that carried it. An administrator's
 * reply is pushed to the customer by a `TICKET_REPLY` row on the customer notification lane
 * whose subject is THIS row; its delivery state is read from that row, never copied here.
 *
 * An attachment is a BINDING, the receipts' pattern: which bot received it and Telegram's two
 * ids, with the declared type, name and size. The bytes stay at Telegram and are fetched
 * through the API, which holds the token.
 */
export const ticketMessages = pgTable(
  'ticket_messages',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    ticketId: uuid('ticket_id').notNull(),
    /** The conversation's order, independent of any clock. */
    seq: bigint('seq', { mode: 'bigint' }).generatedAlwaysAsIdentity().notNull(),
    senderType: text('sender_type').notNull(),
    /** Who wrote an ADMIN message; null otherwise. */
    authorAdminId: uuid('author_admin_id'),
    body: text('body'),
    systemEvent: text('system_event'),
    attachmentKind: text('attachment_kind'),
    attachmentBotInstanceId: uuid('attachment_bot_instance_id').references(() => botInstances.id),
    /** What `getFile` takes. Bot-scoped, and never returned to a browser. */
    attachmentFileId: text('attachment_file_id'),
    attachmentFileUniqueId: text('attachment_file_unique_id'),
    attachmentMimeType: text('attachment_mime_type'),
    attachmentFileName: text('attachment_file_name'),
    attachmentFileSize: bigint('attachment_file_size', { mode: 'bigint' }),
    /**
     * The command's key — the Telegram update that carried a customer's message, or a Web
     * request's key for an administrator's — so a redelivery answers with this row and
     * never writes a second. Null for a SYSTEM fact, which its status change makes once.
     */
    idempotencyKey: text('idempotency_key'),
    /** What the key was first used for, so the same key with different words is refused. */
    requestHash: text('request_hash'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('ticket_messages_tenant_id_key').on(table.tenantId, table.id),
    unique('ticket_messages_key').on(table.tenantId, table.idempotencyKey),
    index('ticket_messages_ticket_idx').on(table.tenantId, table.ticketId, table.seq),
    foreignKey({
      columns: [table.tenantId, table.ticketId],
      foreignColumns: [tickets.tenantId, tickets.id],
      name: 'ticket_messages_ticket_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.authorAdminId],
      foreignColumns: [admins.tenantId, admins.id],
      name: 'ticket_messages_author_fk',
    }),
    check('ticket_messages_sender_check', enumCheck('sender_type', TICKET_MESSAGE_SENDERS)),
    check(
      'ticket_messages_system_event_check',
      nullableEnumCheck('system_event', TICKET_SYSTEM_EVENTS),
    ),
    check(
      'ticket_messages_attachment_kind_check',
      nullableEnumCheck('attachment_kind', TICKET_ATTACHMENT_KINDS),
    ),
    check(
      'ticket_messages_body_check',
      sql`body IS NULL OR length(body) BETWEEN 1 AND ${sql.raw(String(TICKET_MESSAGE_MAX_LENGTH))}`,
    ),
    /** An attachment is all of its binding or none of it. */
    check(
      'ticket_messages_attachment_check',
      sql`(attachment_kind IS NULL) = (attachment_file_id IS NULL)
          AND (attachment_kind IS NULL) = (attachment_file_unique_id IS NULL)
          AND (attachment_kind IS NULL) = (attachment_bot_instance_id IS NULL)
          AND (attachment_kind IS NOT NULL OR (attachment_mime_type IS NULL AND attachment_file_name IS NULL AND attachment_file_size IS NULL))`,
    ),
    check(
      'ticket_messages_attachment_size_check',
      sql`attachment_file_size IS NULL OR attachment_file_size BETWEEN 1 AND ${sql.raw(String(TICKET_ATTACHMENT_MAX_BYTES))}`,
    ),
    check(
      'ticket_messages_attachment_name_check',
      sql`attachment_file_name IS NULL OR length(attachment_file_name) BETWEEN 1 AND ${sql.raw(String(TICKET_ATTACHMENT_FILE_NAME_MAX_LENGTH))}`,
    ),
    /**
     * Each sender's shape: a customer writes text or a file; an administrator writes text,
     * signed; the system records one fact from its closed set and nothing else.
     */
    check(
      'ticket_messages_shape_check',
      sql`CASE sender_type
            WHEN 'CUSTOMER' THEN author_admin_id IS NULL AND system_event IS NULL
                 AND (body IS NOT NULL OR attachment_kind IS NOT NULL) AND idempotency_key IS NOT NULL
            WHEN 'ADMIN' THEN author_admin_id IS NOT NULL AND system_event IS NULL
                 AND body IS NOT NULL AND attachment_kind IS NULL AND idempotency_key IS NOT NULL
            WHEN 'SYSTEM' THEN author_admin_id IS NULL AND system_event IS NOT NULL
                 AND body IS NULL AND attachment_kind IS NULL
            ELSE false
          END`,
    ),
    check(
      'ticket_messages_key_check',
      sql`(idempotency_key IS NULL) = (request_hash IS NULL)
          AND (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 300)`,
    ),
  ],
);

// --- HF-A7: the files support attaches to a ticket reply -------------------------------

/**
 * One file support attached to a reply from the Web Admin — its STAGING, and afterwards its
 * binding.
 *
 * The bytes are here only until Telegram has them. The reply's `ticket_messages` row is
 * written first and never changes; this row names it, holds the verified file, and is what
 * the `TICKET_REPLY_ATTACHMENT` notification reads at send time. The delivery that Telegram
 * accepts stamps Telegram's own `file_id` here and clears `content` in the same
 * transaction; from then on the Web Admin reads the file back from Telegram, the way it
 * reads a customer's. Bytes Telegram never took are cleared by the worker's retention
 * sweep after `TICKET_REPLY_FILE_RETENTION_DAYS`, and while they wait the tenant is held to
 * `TICKET_REPLY_FILE_STAGED_MAX_BYTES` of them — so this is a bounded, short-lived staging
 * area, never a blob store.
 *
 * Tenant-scoped end to end: the message, the ticket and the bot are composite foreign keys
 * on `(tenant_id, …)`, and every query carries the tenant. `bot_instance_id` is the ticket's
 * bot, whose token sends the file and whose namespace the stamped `file_id` belongs to.
 */
export const ticketReplyFiles = pgTable(
  'ticket_reply_files',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    messageId: uuid('message_id').notNull(),
    ticketId: uuid('ticket_id').notNull(),
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    kind: text('kind').notNull(),
    mimeType: text('mime_type').notNull(),
    /** The name it is sent under, already cleaned and ending in the verified type's extension. */
    fileName: text('file_name').notNull(),
    byteLength: integer('byte_length').notNull(),
    sha256: text('sha256').notNull(),
    /** The bytes, until Telegram has them or the retention clears them. */
    content: bytea('content'),
    /** When `content` was cleared, by the delivery or by the retention sweep. */
    purgedAt: timestamptz('purged_at'),
    /** Telegram's handle for the delivered file, in `bot_instance_id`'s namespace. */
    telegramFileId: text('telegram_file_id'),
    telegramFileUniqueId: text('telegram_file_unique_id'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'ticket_reply_files_pk', columns: [table.tenantId, table.messageId] }),
    foreignKey({
      columns: [table.tenantId, table.messageId],
      foreignColumns: [ticketMessages.tenantId, ticketMessages.id],
      name: 'ticket_reply_files_message_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.ticketId],
      foreignColumns: [tickets.tenantId, tickets.id],
      name: 'ticket_reply_files_ticket_fk',
    }),
    /** What the staging bound sums, and what the retention sweep walks: the held bytes. */
    index('ticket_reply_files_staged_idx')
      .on(table.tenantId, table.createdAt)
      .where(sql`content IS NOT NULL`),
    index('ticket_reply_files_retention_idx')
      .on(table.createdAt)
      .where(sql`content IS NOT NULL`),
    check('ticket_reply_files_kind_check', enumCheck('kind', TICKET_ATTACHMENT_KINDS)),
    /*
     * The allow-list, by hand for the reason `tenant_media_assets_mime_check` gives: each
     * type with the shape it is sent as and its own size bound, from the contract.
     */
    check(
      'ticket_reply_files_type_check',
      sql`CASE mime_type ${sql.raw(
        TICKET_REPLY_FILE_TYPES.map((type) => {
          if (!/^[a-z]+\/[a-z0-9.+-]+$/.test(type.mimeType) || !/^[A-Z]+$/.test(type.kind)) {
            throw new Error(`ticket_reply_files: "${type.mimeType}" is not a plain literal.`);
          }
          return `WHEN '${type.mimeType}' THEN kind = '${type.kind}' AND byte_length BETWEEN 1 AND ${String(type.maxBytes)}`;
        }).join(' '),
      )} ELSE false END`,
    ),
    check(
      'ticket_reply_files_content_check',
      sql`(content IS NULL) = (purged_at IS NOT NULL)
          AND (content IS NULL OR octet_length(content) = byte_length)`,
    ),
    check(
      'ticket_reply_files_telegram_check',
      sql`(telegram_file_id IS NULL) = (telegram_file_unique_id IS NULL)`,
    ),
    check('ticket_reply_files_sha256_check', sql`sha256 ~ '^[0-9a-f]{64}$'`),
    check(
      'ticket_reply_files_name_check',
      sql`length(file_name) BETWEEN 1 AND ${sql.raw(String(TICKET_ATTACHMENT_FILE_NAME_MAX_LENGTH))}`,
    ),
  ],
);

// --- WP-A4: the Telegram operations log group and the topics Nexa owns in it ----------

/**
 * The tenant's operations log group: ONE row per tenant, kept through a disconnect.
 *
 * The chat id is DISCOVERED, never typed: it is read from the authenticated webhook update
 * that carried a valid one-time connection code (`ops_log_connect_codes`), so nobody
 * copies a number and nobody can bind a group to another tenant. Reconnecting a different
 * group replaces the chat on this row; its topics are keyed by chat, so the new group
 * gets new topics and the old group's thread ids are never posted to again.
 *
 * `health` is what the last permission check found. It is never HEALTHY without
 * `getChat` and `getChatMember` having answered — a bound row starts UNVERIFIED and the
 * worker checks it — and `problems` says what is wrong in the Web Admin's words.
 */
export const opsLogGroups = pgTable(
  'ops_log_groups',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    /** Telegram's numeric chat id, as text (`-100…`). */
    chatId: text('chat_id').notNull(),
    /** The group's title as Telegram last reported it. Operator-chosen text. */
    title: text('title').notNull(),
    status: text('status').notNull(),
    health: text('health').notNull().default('UNVERIFIED'),
    problems: text('problems')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** The bot's own ChatMember status in the group, as last read. */
    botMemberStatus: text('bot_member_status'),
    checkedAt: timestamptz('checked_at'),
    lastDeliveredAt: timestamptz('last_delivered_at'),
    /** The administrator whose connection code bound the group. */
    connectedByAdminId: uuid('connected_by_admin_id'),
    connectedAt: timestamptz('connected_at').notNull(),
    disconnectedAt: timestamptz('disconnected_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    unique('ops_log_groups_tenant_id_key').on(table.tenantId, table.id),
    /** One binding per tenant: reconnecting another group rewrites this row. */
    uniqueIndex('ops_log_groups_tenant_key').on(table.tenantId),
    /** The worker's read: groups whose permissions need checking. */
    index('ops_log_groups_check_idx')
      .on(table.health, table.checkedAt)
      .where(sql`status = 'CONNECTED'`),
    foreignKey({
      columns: [table.tenantId, table.connectedByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
      name: 'ops_log_groups_admin_fk',
    }),
    check('ops_log_groups_status_check', enumCheck('status', OPS_LOG_GROUP_STATUSES)),
    check('ops_log_groups_health_check', enumCheck('health', OPS_LOG_GROUP_HEALTH)),
    check('ops_log_groups_problems_check', enumArrayCheck('problems', OPS_LOG_GROUP_PROBLEMS)),
    check('ops_log_groups_chat_check', sql`chat_id ~ '^-?[0-9]{1,32}$'`),
    // A disconnected row says when; a connected one has no such instant.
    check(
      'ops_log_groups_disconnected_check',
      sql`(status = 'DISCONNECTED') = (disconnected_at IS NOT NULL)`,
    ),
  ],
);

/**
 * The topic registry: one row per (group chat, category), holding the thread id Nexa
 * created and posts to.
 *
 * A CATEGORY KEY column, not one column per topic, so a third topic is a row and never a
 * migration; the CHECK pins the key's shape only. The unique key is what makes topic
 * creation idempotent under concurrency: there is exactly one row to claim, and only the
 * holder of `creation_claim_token` (a conditional UPDATE with a lease) calls
 * `createForumTopic`. A second worker, a double-click and a redelivered update all find
 * the row claimed or READY and create nothing.
 */
export const opsLogTopics = pgTable(
  'ops_log_topics',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    groupId: uuid('group_id').notNull(),
    /** The chat the thread lives in: a thread id means nothing in any other chat. */
    chatId: text('chat_id').notNull(),
    category: text('category').notNull(),
    state: text('state').notNull().default('PENDING'),
    messageThreadId: bigint('message_thread_id', { mode: 'number' }),
    /** Who is creating the topic right now, and until when that claim holds. */
    creationClaimToken: uuid('creation_claim_token'),
    creationClaimedUntil: timestamptz('creation_claimed_until'),
    recreatedCount: integer('recreated_count').notNull().default(0),
    lastDeliveredAt: timestamptz('last_delivered_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('ops_log_topics_chat_category_key').on(
      table.tenantId,
      table.chatId,
      table.category,
    ),
    foreignKey({
      columns: [table.tenantId, table.groupId],
      foreignColumns: [opsLogGroups.tenantId, opsLogGroups.id],
      name: 'ops_log_topics_group_fk',
    }),
    check('ops_log_topics_state_check', enumCheck('state', OPS_LOG_TOPIC_STATES)),
    check('ops_log_topics_category_check', sql`category ~ '^[A-Z][A-Z0-9_]{0,31}$'`),
    // READY means a thread to post to; nothing else claims one.
    check('ops_log_topics_ready_check', sql`state <> 'READY' OR message_thread_id IS NOT NULL`),
    check('ops_log_topics_recreated_check', sql`recreated_count >= 0`),
  ],
);

/**
 * One-time connection codes, stored as a SHA-256 hash only.
 *
 * Issued by the Web Admin to one administrator for one of the tenant's bots, accepted
 * once, for ten minutes, and only from an update that bot's own webhook delivered — the
 * webhook route names the bot, and the lookup is keyed by tenant AND bot, so a code for
 * one bot or tenant is simply not found through another. Consumption is a conditional
 * UPDATE (`consumed_at IS NULL AND expires_at > now`), so a replayed update and two
 * groups racing for one code consume it exactly once.
 */
export const opsLogConnectCodes = pgTable(
  'ops_log_connect_codes',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    codeHash: text('code_hash').notNull(),
    issuedByAdminId: uuid('issued_by_admin_id').notNull(),
    issuedAt: timestamptz('issued_at').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    consumedAt: timestamptz('consumed_at'),
    consumedChatId: text('consumed_chat_id'),
  },
  (table) => [
    uniqueIndex('ops_log_connect_codes_hash_key').on(table.codeHash),
    index('ops_log_connect_codes_tenant_issued_idx').on(table.tenantId, table.issuedAt),
    foreignKey({
      columns: [table.tenantId, table.issuedByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
      name: 'ops_log_connect_codes_admin_fk',
    }),
    check('ops_log_connect_codes_expiry_check', sql`expires_at > issued_at`),
    check(
      'ops_log_connect_codes_consumed_check',
      sql`(consumed_at IS NULL) = (consumed_chat_id IS NULL)`,
    ),
  ],
);

/**
 * R2 (v0.3.5 real-test item 5): one customer WIZARD message — the purchase or the wallet
 * top-up — that Telegram edits in place from step to step instead of receiving a new message
 * per step.
 *
 * Presentation state, keyed by the Telegram message itself: `(bot, chat, message)` is the
 * wizard's identity, so an older wizard message keeps its own state and an order still
 * payable from it stays payable. `step` is the screen the message SHOWS; a tapped button is
 * honoured only when the message still shows the screen the button belongs to, and every
 * transition is a conditional UPDATE on `version` taken before the work runs
 * (`busy_until` is that claim's lease), so a double tap or a keyboard Telegram had not yet
 * replaced is answered without effect — never a step backward, never a second draft,
 * payment or invoice. Nothing here decides money: the order, the payment and the capture
 * still re-decide every write under their own locks.
 *
 * `payment_id` is the attempt an `INVOICE`/`INVOICE_PENDING` message shows; the gateway
 * worker finds the message through it when the invoice it was creating is ready.
 */
export const telegramWizards = pgTable(
  'telegram_wizards',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    chatId: text('chat_id').notNull(),
    messageId: bigint('message_id', { mode: 'number' }).notNull(),
    kind: text('kind').notNull(),
    step: text('step').notNull(),
    version: integer('version').notNull().default(0),
    /** The order (ORDER) or the amount capture (TOPUP) the screen is about. */
    subjectId: uuid('subject_id'),
    paymentId: uuid('payment_id'),
    busyUntil: timestamptz('busy_until'),
    /**
     * The Telegram update whose turn put this screen on the message. A REDELIVERY of that
     * same update — Telegram did not see our 200, perhaps after the edit never went out —
     * is let through the gate again and replays to the same result (every write behind it
     * is idempotent by the update's key), so a lost edit is repaired rather than frozen.
     */
    lastUpdateKey: text('last_update_key'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('telegram_wizards_message_key').on(
      table.tenantId,
      table.botInstanceId,
      table.chatId,
      table.messageId,
    ),
    index('telegram_wizards_payment_idx')
      .on(table.tenantId, table.paymentId)
      .where(sql`payment_id IS NOT NULL`),
    index('telegram_wizards_subject_idx')
      .on(table.tenantId, table.subjectId)
      .where(sql`subject_id IS NOT NULL`),
    index('telegram_wizards_chat_idx').on(
      table.tenantId,
      table.botInstanceId,
      table.chatId,
      table.updatedAt,
    ),
    // The retention sweep's `(tenant_id, updated_at)` index is an ONLINE index
    // (`online-indexes.ts`): every customer tap writes this table.
    check('telegram_wizards_kind_check', enumCheck('kind', TELEGRAM_WIZARD_KINDS)),
    check('telegram_wizards_step_check', enumCheck('step', TELEGRAM_WIZARD_STEPS)),
    check('telegram_wizards_version_check', sql`version >= 0`),
    check('telegram_wizards_message_check', sql`message_id > 0`),
  ],
);

/**
 * R2 (v0.3.5 real-test item 3): an administrator's receipt-review message, or a prompt a
 * decision opened from it, recorded so the decision can edit it in place into its result.
 *
 * `finalised_at` is what makes a repeated tap harmless: a callback from a message already
 * finalised is answered (`answerCallbackQuery`) and nothing else — no decision is asked for
 * again, no message is sent or edited. The decisions themselves keep their own locks and
 * idempotency; this row only records which message shows the outcome.
 */
export const telegramReviewMessages = pgTable(
  'telegram_review_messages',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    chatId: text('chat_id').notNull(),
    messageId: bigint('message_id', { mode: 'number' }).notNull(),
    paymentId: uuid('payment_id').notNull(),
    role: text('role').notNull(),
    /** Whether the message carries the receipt FILE, so its caption is what is edited. */
    hasMedia: boolean('has_media').notNull(),
    finalisedAt: timestamptz('finalised_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    /**
     * The row's last write — its recording, its finalisation, or a stamp cleared because the
     * edit failed (Codex review of #131). The retention sweep ages a review row by THIS, so
     * a stamp cleared for a retry is not eligible the moment it is cleared.
     */
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('telegram_review_messages_message_key').on(
      table.tenantId,
      table.botInstanceId,
      table.chatId,
      table.messageId,
    ),
    index('telegram_review_messages_payment_idx').on(table.tenantId, table.paymentId),
    // The retention sweep's `(tenant_id, updated_at)` index is an ONLINE index
    // (`online-indexes.ts`): every receipt decision writes this table.
    foreignKey({
      columns: [table.tenantId, table.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
      name: 'telegram_review_messages_payment_fk',
    }),
    check('telegram_review_messages_role_check', enumCheck('role', TELEGRAM_REVIEW_MESSAGE_ROLES)),
    check('telegram_review_messages_message_check', sql`message_id > 0`),
  ],
);

/**
 * The retention sweep's PURGE HORIZON for one chat (`docs/telegram-retention.md`): the
 * greatest Telegram message id whose `telegram_wizards` or `telegram_review_messages` row
 * the sweep has removed in this chat.
 *
 * It is what keeps a removed row's old keyboard harmless. A tap on a message nothing tracks
 * is otherwise ADOPTED (a wizard gate) or decided afresh (a receipt review) — right for a
 * message whose row was never written, wrong for one whose row was deleted. So a tap on an
 * untracked message at or below this id is stale, answered and nothing else. Written in
 * the SAME transaction as the delete, so no reader can see the row gone and the horizon not
 * yet raised; it only ever rises (`GREATEST`), and it is never deleted: one row per chat the
 * sweep has touched, a bound the chats themselves set.
 */
export const telegramMessageHorizons = pgTable(
  'telegram_message_horizons',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    chatId: text('chat_id').notNull(),
    purgedThroughMessageId: bigint('purged_through_message_id', { mode: 'number' }).notNull(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'telegram_message_horizons_pkey',
      columns: [table.tenantId, table.botInstanceId, table.chatId],
    }),
    check('telegram_message_horizons_message_check', sql`purged_through_message_id > 0`),
  ],
);

// --- Round N close: frozen audiences (docs/round-n-close-audit.md §A) --------------------

/**
 * A frozen audience's header: what was confirmed, and never changed afterwards. The
 * definition it was selected by, that definition's hash, the instant it was evaluated at,
 * the member count and the set's fingerprint (md5 over the sorted member ids, exactly as
 * the preview computes it). The members are the table below; `released_at` says the sweep
 * has cleared them, which it does only once every campaign action, mass operation and
 * broadcast that names this row has ended (`FROZEN_AUDIENCE_RELEASE_AFTER_DAYS`). The
 * header itself is never deleted: every reference to it is `ON DELETE RESTRICT`.
 */
export const frozenAudiences = pgTable(
  'frozen_audiences',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: text('kind').notNull(),
    /** The grant a SERVICES audience was selected for (its eligibility rule); null for CUSTOMERS. */
    grantKind: text('grant_kind'),
    definition: jsonb('definition').notNull(),
    definitionHash: text('definition_hash').notNull(),
    asOf: timestamptz('as_of').notNull(),
    memberCount: integer('member_count').notNull(),
    fingerprint: text('fingerprint').notNull(),
    createdByAdminId: uuid('created_by_admin_id').references(() => admins.id),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    releasedAt: timestamptz('released_at'),
  },
  (table) => [
    unique('frozen_audiences_tenant_id_key').on(table.tenantId, table.id),
    check(
      'frozen_audiences_grant_kind_check',
      sql`grant_kind IS NULL OR ${enumCheck('grant_kind', FROZEN_AUDIENCE_GRANT_KINDS)}`,
    ),
    /** A SERVICES set names the grant whose rule selected it; a CUSTOMERS set names none. */
    check('frozen_audiences_grant_check', sql`(kind = 'SERVICES') = (grant_kind IS NOT NULL)`),
    /** The release sweep's question: which held audiences are old enough to consider. */
    index('frozen_audiences_held_idx')
      .on(table.tenantId, table.createdAt)
      .where(sql`released_at IS NULL`),
    check('frozen_audiences_kind_check', enumCheck('kind', FROZEN_AUDIENCE_KINDS)),
    check('frozen_audiences_hash_check', sql`definition_hash ~ '^[0-9a-f]{64}$'`),
    check('frozen_audiences_fingerprint_check', sql`fingerprint ~ '^[0-9a-f]{32}$'`),
    check('frozen_audiences_count_check', sql`member_count >= 0`),
  ],
);

/**
 * One member of a frozen audience: the customer and, for a SERVICES audience, the service;
 * with the bot the customer would be messaged through and the chat to reach, copied at the
 * freeze so a broadcast seeded later needs no second lookup. Ids are minted by the database
 * (`gen_random_uuid()`) for the reason `bulk_operation_items` gives: an `INSERT … SELECT`
 * over tens of thousands of rows must not ship every id through Node.
 */
export const frozenAudienceMembers = pgTable(
  'frozen_audience_members',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    frozenAudienceId: uuid('frozen_audience_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    serviceId: uuid('service_id'),
    botInstanceId: uuid('bot_instance_id').references(() => botInstances.id),
    chatId: text('chat_id').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.frozenAudienceId],
      foreignColumns: [frozenAudiences.tenantId, frozenAudiences.id],
      name: 'frozen_audience_members_audience_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'frozen_audience_members_customer_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.serviceId],
      foreignColumns: [services.tenantId, services.id],
      name: 'frozen_audience_members_service_fk',
    }),
    /** One row per customer of a CUSTOMERS audience, one per service of a SERVICES one. */
    uniqueIndex('frozen_audience_members_customer_key')
      .on(table.tenantId, table.frozenAudienceId, table.customerId)
      .where(sql`service_id IS NULL`),
    uniqueIndex('frozen_audience_members_service_key')
      .on(table.tenantId, table.frozenAudienceId, table.serviceId)
      .where(sql`service_id IS NOT NULL`),
  ],
);

// --- Round N: broadcast and safe mass actions (docs/round-n-broadcast-audit.md) ---------

/**
 * One broadcast (B1): an operator-authored message, its FROZEN audience and its lifecycle.
 *
 * `body` is stored RAW, placeholders included, and rendered per recipient at send time — the
 * repository's rule for every template body. `audience_definition` is the canonical definition
 * (`canonicalAudienceDefinition`) and `audience_hash` its sha256; at launch the recipients are
 * materialised into `broadcast_recipients` in the same transaction that stamps
 * `audience_as_of`, `recipient_count` and `audience_fingerprint`, and none of the four changes
 * again. Every state change is a conditional UPDATE naming its `from` states.
 */
export const broadcasts = pgTable(
  'broadcasts',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    title: text('title').notNull(),
    state: text('state').notNull().default('DRAFT'),
    pauseReason: text('pause_reason'),
    contentKind: text('content_kind').notNull(),
    body: text('body').notNull(),
    buttons: jsonb('buttons')
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Round N close (§D): MARKETING excludes opted-out customers; SERVICE_ANNOUNCEMENT does not. */
    purpose: text('purpose').notNull().default('MARKETING'),
    /**
     * Round N close (§C): the Telegram message a FORWARD or COPY sends, by its chat and
     * message id, and when a real preview last reached the operator from it. A launch
     * refuses a source with no verification; an edit of the source clears it.
     */
    sourceChatId: text('source_chat_id'),
    sourceMessageId: bigint('source_message_id', { mode: 'number' }),
    sourceVerifiedAt: timestamptz('source_verified_at'),
    /** Round N close (§C): pin each delivered message in the recipient's chat, once. */
    pin: boolean('pin').notNull().default(false),
    /** Round N close (§A): the frozen audience the recipients were copied from, if any. */
    frozenAudienceId: uuid('frozen_audience_id'),
    audienceDefinition: jsonb('audience_definition').notNull(),
    audienceHash: text('audience_hash').notNull(),
    audienceAsOf: timestamptz('audience_as_of'),
    recipientCount: integer('recipient_count'),
    audienceFingerprint: text('audience_fingerprint'),
    scheduledAt: timestamptz('scheduled_at'),
    version: integer('version').notNull().default(1),
    createdByAdminId: uuid('created_by_admin_id').references(() => admins.id),
    launchedByAdminId: uuid('launched_by_admin_id').references(() => admins.id),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    launchedAt: timestamptz('launched_at'),
    startedAt: timestamptz('started_at'),
    pausedAt: timestamptz('paused_at'),
    completedAt: timestamptz('completed_at'),
    cancelledAt: timestamptz('cancelled_at'),
  },
  (table) => [
    unique('broadcasts_tenant_id_key').on(table.tenantId, table.id),
    index('broadcasts_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
    /** The scheduler's question: which confirmed broadcasts are due to start. */
    index('broadcasts_scheduled_idx')
      .on(table.scheduledAt)
      .where(sql`state = 'SCHEDULED'`),
    /** The dispatcher's question: which broadcasts are sending, and the completion sweep's. */
    index('broadcasts_sending_idx')
      .on(table.tenantId)
      .where(sql`state = 'SENDING'`),
    foreignKey({
      columns: [table.tenantId, table.frozenAudienceId],
      foreignColumns: [frozenAudiences.tenantId, frozenAudiences.id],
      name: 'broadcasts_frozen_audience_fk',
    }).onDelete('restrict'),
    check('broadcasts_state_check', enumCheck('state', BROADCAST_STATES)),
    check(
      'broadcasts_pause_reason_check',
      nullableEnumCheck('pause_reason', BROADCAST_PAUSE_REASONS),
    ),
    check('broadcasts_content_kind_check', enumCheck('content_kind', BROADCAST_CONTENT_KINDS)),
    check('broadcasts_purpose_check', enumCheck('purpose', BROADCAST_PURPOSES)),
    /** A sourced kind names its message; a composed kind names none. */
    check(
      'broadcasts_source_check',
      sql`(content_kind IN ('FORWARD', 'COPY')) = (source_chat_id IS NOT NULL AND source_message_id IS NOT NULL)
          AND (source_message_id IS NULL OR source_message_id > 0)
          AND (source_verified_at IS NULL OR source_chat_id IS NOT NULL)`,
    ),
    check(
      'broadcasts_title_check',
      sql`length(title) BETWEEN 1 AND ${sql.raw(String(BROADCAST_TITLE_MAX_LENGTH))}`,
    ),
    check('broadcasts_hash_check', sql`audience_hash ~ '^[0-9a-f]{64}$'`),
    check('broadcasts_version_check', sql`version >= 1`),
    check('broadcasts_buttons_check', sql`jsonb_typeof(buttons) = 'array'`),
    /** Launched means frozen: a non-draft always names the set it was confirmed against. */
    check(
      'broadcasts_frozen_check',
      sql`(state = 'DRAFT') = (launched_at IS NULL)
          AND (state = 'DRAFT' OR (audience_as_of IS NOT NULL AND recipient_count IS NOT NULL
                                   AND audience_fingerprint IS NOT NULL))`,
    ),
    check('broadcasts_schedule_check', sql`state <> 'SCHEDULED' OR scheduled_at IS NOT NULL`),
    check('broadcasts_paused_check', sql`(state = 'PAUSED') = (pause_reason IS NOT NULL)`),
    check('broadcasts_completed_check', sql`(state = 'COMPLETED') = (completed_at IS NOT NULL)`),
    check('broadcasts_cancelled_check', sql`(state = 'CANCELLED') = (cancelled_at IS NOT NULL)`),
    check('broadcasts_recipient_count_check', sql`recipient_count IS NULL OR recipient_count >= 0`),
  ],
);

/**
 * A broadcast's media, STAGED: the verified bytes until the retention sweep clears them, one
 * row per broadcast. The HF-A7 ticket-file shape — a per-type size bound held by a CHECK, a
 * per-tenant bound on undelivered bytes checked under an advisory lock, and a lifetime.
 */
export const broadcastMedia = pgTable(
  'broadcast_media',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    broadcastId: uuid('broadcast_id').notNull(),
    kind: text('kind').notNull(),
    mimeType: text('mime_type').notNull(),
    fileName: text('file_name').notNull(),
    byteLength: integer('byte_length').notNull(),
    sha256: text('sha256').notNull(),
    content: bytea('content'),
    purgedAt: timestamptz('purged_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'broadcast_media_pk', columns: [table.tenantId, table.broadcastId] }),
    foreignKey({
      columns: [table.tenantId, table.broadcastId],
      foreignColumns: [broadcasts.tenantId, broadcasts.id],
      name: 'broadcast_media_broadcast_fk',
    }).onDelete('cascade'),
    index('broadcast_media_staged_idx')
      .on(table.tenantId, table.createdAt)
      .where(sql`content IS NOT NULL`),
    check(
      'broadcast_media_type_check',
      sql`CASE mime_type ${sql.raw(
        BROADCAST_MEDIA_TYPES.map((type) => {
          if (!/^[a-z]+\/[a-z0-9.+-]+$/.test(type.mimeType) || !/^[A-Z]+$/.test(type.kind)) {
            throw new Error(`broadcast_media: "${type.mimeType}" is not a plain literal.`);
          }
          return `WHEN '${type.mimeType}' THEN kind = '${type.kind}' AND byte_length BETWEEN 1 AND ${String(type.maxBytes)}`;
        }).join(' '),
      )} ELSE false END`,
    ),
    check(
      'broadcast_media_content_check',
      sql`(content IS NULL) = (purged_at IS NOT NULL)
          AND (content IS NULL OR octet_length(content) = byte_length)`,
    ),
    check('broadcast_media_sha256_check', sql`sha256 ~ '^[0-9a-f]{64}$'`),
    check(
      'broadcast_media_name_check',
      sql`length(file_name) BETWEEN 1 AND ${sql.raw(String(BROADCAST_MEDIA_FILE_NAME_MAX_LENGTH))}`,
    ),
  ],
);

/**
 * Telegram's handle for a broadcast's media, per BOT: a `file_id` is scoped to the bot that
 * uploaded it. The first send through a bot uploads the bytes and stamps its handle here; every
 * later send through that bot reuses it, so a broadcast to fifty thousand chats uploads its
 * video once per bot rather than fifty thousand times.
 */
export const broadcastMediaHandles = pgTable(
  'broadcast_media_handles',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    broadcastId: uuid('broadcast_id').notNull(),
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    telegramFileId: text('telegram_file_id').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'broadcast_media_handles_pk',
      columns: [table.tenantId, table.broadcastId, table.botInstanceId],
    }),
    foreignKey({
      columns: [table.tenantId, table.broadcastId],
      foreignColumns: [broadcasts.tenantId, broadcasts.id],
      name: 'broadcast_media_handles_broadcast_fk',
    }).onDelete('cascade'),
    check('broadcast_media_handles_file_check', sql`length(telegram_file_id) BETWEEN 1 AND 512`),
  ],
);

/**
 * One recipient of one broadcast: the FROZEN identity (customer, bot, chat) materialised at
 * launch, and its delivery state. At most once: `SENDING` is committed before the request, and
 * a stamped row whose outcome was never recorded becomes `UNCONFIRMED`, never `PENDING`.
 */
export const broadcastRecipients = pgTable(
  'broadcast_recipients',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    broadcastId: uuid('broadcast_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    botInstanceId: uuid('bot_instance_id').references(() => botInstances.id),
    chatId: text('chat_id').notNull(),
    state: text('state').notNull().default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamptz('next_attempt_at'),
    leaseUntil: timestamptz('lease_until'),
    sendStartedAt: timestamptz('send_started_at'),
    resolvedAt: timestamptz('resolved_at'),
    /** The transport's code, never Telegram's description (which can quote a chat id). */
    errorCode: text('error_code'),
    /**
     * Round N close (§C): the delivered message's id, kept for the pin; and the pin's own
     * outcome, recorded apart from the send. `pin_started_at` is stamped BEFORE the pin
     * request; a PENDING pin whose stamp is older than the lease is resolved UNCONFIRMED.
     */
    sentMessageId: bigint('sent_message_id', { mode: 'number' }),
    pinState: text('pin_state'),
    pinErrorCode: text('pin_error_code'),
    pinStartedAt: timestamptz('pin_started_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    /** The pin reaper: stamped pins whose answer never came. */
    index('broadcast_recipients_pin_stranded_idx')
      .on(table.pinStartedAt)
      .where(sql`pin_state = 'PENDING'`),
    check(
      'broadcast_recipients_pin_state_check',
      nullableEnumCheck('pin_state', BROADCAST_PIN_STATES),
    ),
    check(
      'broadcast_recipients_pin_check',
      sql`(pin_state IS NULL OR (state = 'SENT' AND sent_message_id IS NOT NULL AND pin_started_at IS NOT NULL))
          AND (pin_error_code IS NULL OR length(pin_error_code) BETWEEN 1 AND 100)`,
    ),
    primaryKey({
      name: 'broadcast_recipients_pk',
      columns: [table.tenantId, table.broadcastId, table.customerId],
    }),
    foreignKey({
      columns: [table.tenantId, table.broadcastId],
      foreignColumns: [broadcasts.tenantId, broadcasts.id],
      name: 'broadcast_recipients_broadcast_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'broadcast_recipients_customer_fk',
    }),
    /** The claim: a bot's waiting recipients, in a stable order. */
    index('broadcast_recipients_due_idx')
      .on(table.tenantId, table.botInstanceId, table.broadcastId, table.customerId)
      .where(sql`state = 'PENDING'`),
    /** The reaper: stamped sends whose lease ran out. */
    index('broadcast_recipients_stranded_idx')
      .on(table.leaseUntil)
      .where(sql`state = 'SENDING'`),
    /** The report: counts per state, and the recipients page. */
    index('broadcast_recipients_state_idx').on(
      table.tenantId,
      table.broadcastId,
      table.state,
      table.customerId,
    ),
    check('broadcast_recipients_state_check', enumCheck('state', BROADCAST_RECIPIENT_STATES)),
    check('broadcast_recipients_attempts_check', sql`attempts >= 0 AND attempts <= 100`),
    check(
      'broadcast_recipients_resolved_check',
      sql`(state IN ('PENDING', 'SENDING')) = (resolved_at IS NULL)`,
    ),
    check(
      'broadcast_recipients_sending_check',
      sql`state <> 'SENDING' OR (send_started_at IS NOT NULL AND lease_until IS NOT NULL)`,
    ),
    check(
      'broadcast_recipients_error_check',
      sql`error_code IS NULL OR length(error_code) BETWEEN 1 AND 100`,
    ),
  ],
);

/**
 * One bot's broadcast send budget, shared by every worker replica: `BROADCAST_SENDS_PER_SECOND`
 * per one-second window, taken under this row's lock, and `hold_until` when Telegram answered
 * 429 — every replica then waits for that bot until Telegram's own time.
 */
export const broadcastBotPacing = pgTable(
  'broadcast_bot_pacing',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    windowStartedAt: timestamptz('window_started_at').notNull(),
    sentInWindow: integer('sent_in_window').notNull().default(0),
    holdUntil: timestamptz('hold_until'),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'broadcast_bot_pacing_pk', columns: [table.tenantId, table.botInstanceId] }),
    check('broadcast_bot_pacing_sent_check', sql`sent_in_window >= 0`),
  ],
);

/**
 * One mass action (B2) — a wallet credit or a traffic/time grant — with its frozen audience,
 * what each item is given, and its lifecycle. Created already confirmed: the confirmation
 * transaction materialises the items beside it and compares them with what was previewed.
 */
export const bulkOperations = pgTable(
  'bulk_operations',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: text('kind').notNull(),
    state: text('state').notNull().default('RUNNING'),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }),
    currency: text('currency'),
    trafficBytes: bigint('traffic_bytes', { mode: 'bigint' }),
    durationDays: integer('duration_days'),
    notify: boolean('notify').notNull(),
    note: text('note').notNull(),
    audienceDefinition: jsonb('audience_definition').notNull(),
    audienceHash: text('audience_hash').notNull(),
    audienceAsOf: timestamptz('audience_as_of').notNull(),
    itemCount: integer('item_count').notNull(),
    audienceFingerprint: text('audience_fingerprint').notNull(),
    /**
     * The earliest instant an item may be processed (NULL = at once). The items are frozen
     * at creation all the same; only the processing waits, and the claim query itself
     * enforces it.
     */
    notBefore: timestamptz('not_before'),
    /** Round N close (§A): the frozen audience the items were copied from, if any. */
    frozenAudienceId: uuid('frozen_audience_id'),
    createdByAdminId: uuid('created_by_admin_id')
      .notNull()
      .references(() => admins.id),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    /** Round N close (§B): set while PAUSED, cleared by a resume. */
    pausedAt: timestamptz('paused_at'),
    completedAt: timestamptz('completed_at'),
    cancelledAt: timestamptz('cancelled_at'),
    /**
     * Program §13: the operation whose FAILED items this one retries. Its items are a copy
     * of those, so the original's history is never rewritten.
     */
    retryOfId: uuid('retry_of_id'),
  },
  (table) => [
    unique('bulk_operations_tenant_id_key').on(table.tenantId, table.id),
    foreignKey({
      columns: [table.tenantId, table.retryOfId],
      foreignColumns: [table.tenantId, table.id],
      name: 'bulk_operations_retry_of_fk',
    }),
    index('bulk_operations_retry_of_idx')
      .on(table.tenantId, table.retryOfId)
      .where(sql`retry_of_id IS NOT NULL`),
    foreignKey({
      columns: [table.tenantId, table.frozenAudienceId],
      foreignColumns: [frozenAudiences.tenantId, frozenAudiences.id],
      name: 'bulk_operations_frozen_audience_fk',
    }).onDelete('restrict'),
    check('bulk_operations_paused_check', sql`(state = 'PAUSED') = (paused_at IS NOT NULL)`),
    index('bulk_operations_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
    index('bulk_operations_running_idx')
      .on(table.tenantId)
      .where(sql`state = 'RUNNING'`),
    check('bulk_operations_kind_check', enumCheck('kind', BULK_OPERATION_KINDS)),
    check('bulk_operations_state_check', enumCheck('state', BULK_OPERATION_STATES)),
    check('bulk_operations_currency_check', nullableEnumCheck('currency', CURRENCY_CODES)),
    /** Exactly the grant its kind names, and nothing of the others. */
    check(
      'bulk_operations_grant_check',
      sql`CASE kind
            WHEN 'WALLET_CREDIT' THEN amount_minor IS NOT NULL AND amount_minor > 0
                 AND currency IS NOT NULL AND traffic_bytes IS NULL AND duration_days IS NULL
            WHEN 'SERVICE_TRAFFIC' THEN traffic_bytes IS NOT NULL AND traffic_bytes > 0
                 AND amount_minor IS NULL AND currency IS NULL AND duration_days IS NULL
            WHEN 'SERVICE_TIME' THEN duration_days IS NOT NULL AND duration_days > 0
                 AND amount_minor IS NULL AND currency IS NULL AND traffic_bytes IS NULL
            WHEN 'SERVICE_SUSPEND' THEN amount_minor IS NULL AND currency IS NULL
                 AND traffic_bytes IS NULL AND duration_days IS NULL AND NOT notify
            WHEN 'SERVICE_RESUME' THEN amount_minor IS NULL AND currency IS NULL
                 AND traffic_bytes IS NULL AND duration_days IS NULL AND NOT notify
            ELSE false
          END`,
    ),
    check(
      'bulk_operations_note_check',
      sql`length(note) BETWEEN 1 AND ${sql.raw(String(BULK_NOTE_MAX_LENGTH))}`,
    ),
    check('bulk_operations_hash_check', sql`audience_hash ~ '^[0-9a-f]{64}$'`),
    check('bulk_operations_items_check', sql`item_count >= 1`),
    check(
      'bulk_operations_completed_check',
      sql`(state = 'COMPLETED') = (completed_at IS NOT NULL)`,
    ),
    check(
      'bulk_operations_cancelled_check',
      sql`(state = 'CANCELLED') = (cancelled_at IS NOT NULL)`,
    ),
  ],
);

/**
 * One item of a mass action: a customer (wallet credit) or a service (traffic/time), frozen at
 * confirmation. Its `id` is the subject of the customer notification that announces it.
 */
export const bulkOperationItems = pgTable(
  'bulk_operation_items',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    bulkOperationId: uuid('bulk_operation_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    serviceId: uuid('service_id'),
    state: text('state').notNull().default('PENDING'),
    skipReason: text('skip_reason'),
    walletEntryId: uuid('wallet_entry_id'),
    provisioningOperationId: uuid('provisioning_operation_id'),
    /**
     * When the item's notice was ENQUEUED on the customer notification lane — never whether
     * it was delivered. What the operator reads as "notified" is the lane's own row
     * (`customer_notifications`, subject = this item), Codex R4 on PR #117.
     */
    notifiedAt: timestamptz('notified_at'),
    processedAt: timestamptz('processed_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    unique('bulk_operation_items_tenant_id_key').on(table.tenantId, table.id),
    foreignKey({
      columns: [table.tenantId, table.bulkOperationId],
      foreignColumns: [bulkOperations.tenantId, bulkOperations.id],
      name: 'bulk_operation_items_operation_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'bulk_operation_items_customer_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.serviceId],
      foreignColumns: [services.tenantId, services.id],
      name: 'bulk_operation_items_service_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.walletEntryId],
      foreignColumns: [walletEntries.tenantId, walletEntries.id],
      name: 'bulk_operation_items_wallet_entry_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.provisioningOperationId],
      foreignColumns: [provisioningOperations.tenantId, provisioningOperations.id],
      name: 'bulk_operation_items_operation_row_fk',
    }),
    /** One item per customer of a wallet credit, one per service of a grant. */
    uniqueIndex('bulk_operation_items_customer_key')
      .on(table.tenantId, table.bulkOperationId, table.customerId)
      .where(sql`service_id IS NULL`),
    uniqueIndex('bulk_operation_items_service_key')
      .on(table.tenantId, table.bulkOperationId, table.serviceId)
      .where(sql`service_id IS NOT NULL`),
    index('bulk_operation_items_pending_idx')
      .on(table.tenantId, table.bulkOperationId, table.id)
      .where(sql`state = 'PENDING'`),
    index('bulk_operation_items_planned_idx')
      .on(table.tenantId, table.bulkOperationId)
      .where(sql`state = 'PLANNED'`),
    index('bulk_operation_items_state_idx').on(
      table.tenantId,
      table.bulkOperationId,
      table.state,
      table.id,
    ),
    check('bulk_operation_items_state_check', enumCheck('state', BULK_ITEM_STATES)),
    check('bulk_operation_items_skip_check', nullableEnumCheck('skip_reason', BULK_SKIP_REASONS)),
    check(
      'bulk_operation_items_skipped_check',
      sql`(state = 'SKIPPED') = (skip_reason IS NOT NULL)`,
    ),
    check(
      'bulk_operation_items_credited_check',
      sql`(state = 'CREDITED') = (wallet_entry_id IS NOT NULL)`,
    ),
    check(
      'bulk_operation_items_planned_check',
      sql`(state IN ('PLANNED', 'SUCCEEDED', 'FAILED')) = (provisioning_operation_id IS NOT NULL)`,
    ),
    check(
      'bulk_operation_items_processed_check',
      sql`(state IN ('PENDING', 'CANCELLED')) = (processed_at IS NULL)`,
    ),
  ],
);

// --- Phase B3: the Web Admin Notification Center ----------------------------------------

/**
 * One administrator's read mark on one notification (`docs/notification-center.md`).
 *
 * The notification IS the `operational_events` row; this is only what one person has
 * seen of it. `read_through` is the event's `last_seen_at` at the moment it was read, so a
 * condition that recurs afterwards — the recorder bumps `last_seen_at` on the same row —
 * reads as unread again for this administrator and nobody else. NULL is an explicit
 * "mark unread". No row means never read.
 *
 * Nothing here touches the event: the operational log stays append-only and still has no
 * "mark as seen", and a read mark resolves nothing. Tenant-scoped end to end: the
 * administrator is a composite foreign key on `(tenant_id, admin_id)`, and every query
 * also names the event's tenant.
 */
export const adminNotificationReads = pgTable(
  'admin_notification_reads',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    adminId: uuid('admin_id').notNull(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => operationalEvents.id),
    /** The event's `last_seen_at` when this administrator read it; NULL = marked unread. */
    readThrough: timestamptz('read_through'),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'admin_notification_reads_pk',
      columns: [table.tenantId, table.adminId, table.eventId],
    }),
    foreignKey({
      columns: [table.tenantId, table.adminId],
      foreignColumns: [admins.tenantId, admins.id],
      name: 'admin_notification_reads_admin_fk',
    }),
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

// --- Phase E3: incidents and maintenance ------------------------------------------------

/**
 * An incident or maintenance window (`docs/incidents.md`): the operator's record of it,
 * its scope (`incident_targets`), the effects run on that scope through the owning
 * modules (`incident_effects`), its append-only timeline (`incident_events`) and what
 * customers were told (`incident_communications`, `incident_notices`).
 *
 * Every status change is a conditional UPDATE naming its `from` statuses and bumping
 * `version`; there is no setter. The CHECKs pin each status to the stamps it implies.
 */
export const incidents = pgTable(
  'incidents',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: text('kind').notNull(),
    severity: text('severity').notNull(),
    status: text('status').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    /** What customers read when an operator sends a notice; null means nothing to send. */
    customerMessage: text('customer_message'),
    stopSales: boolean('stop_sales').notNull().default(false),
    adminBanner: boolean('admin_banner').notNull().default(true),
    scheduledStartAt: timestamptz('scheduled_start_at'),
    scheduledEndAt: timestamptz('scheduled_end_at'),
    startedAt: timestamptz('started_at'),
    resolvedAt: timestamptz('resolved_at'),
    version: integer('version').notNull().default(1),
    createdByAdminId: uuid('created_by_admin_id'),
    createdAt: timestamptz('created_at').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (table) => [
    unique('incidents_tenant_id_key').on(table.tenantId, table.id),
    index('incidents_tenant_status_idx').on(table.tenantId, table.status, table.createdAt),
    /** The scheduler's walk: SCHEDULED windows by start, across tenants. */
    index('incidents_scheduled_idx')
      .on(table.scheduledStartAt)
      .where(sql`status = 'SCHEDULED'`),
    foreignKey({
      columns: [table.tenantId, table.createdByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
      name: 'incidents_created_by_fk',
    }),
    check('incidents_kind_check', enumCheck('kind', INCIDENT_KINDS)),
    check('incidents_severity_check', enumCheck('severity', INCIDENT_SEVERITIES)),
    check('incidents_status_check', enumCheck('status', INCIDENT_STATUSES)),
    check(
      'incidents_title_check',
      sql`length(btrim(title)) BETWEEN 1 AND ${sql.raw(String(INCIDENT_TITLE_MAX_LENGTH))}`,
    ),
    check(
      'incidents_message_check',
      sql`customer_message IS NULL OR length(customer_message) BETWEEN 1 AND ${sql.raw(String(INCIDENT_CUSTOMER_MESSAGE_MAX_LENGTH))}`,
    ),
    check('incidents_version_check', sql`version >= 1`),
    /** Each status carries exactly the stamps it implies. */
    check(
      'incidents_status_stamps_check',
      sql`CASE status
            WHEN 'SCHEDULED' THEN scheduled_start_at IS NOT NULL AND started_at IS NULL AND resolved_at IS NULL
            WHEN 'ACTIVE' THEN started_at IS NOT NULL AND resolved_at IS NULL
            WHEN 'RESOLVED' THEN started_at IS NOT NULL AND resolved_at IS NOT NULL
            WHEN 'CANCELLED' THEN started_at IS NULL AND resolved_at IS NOT NULL
          END`,
    ),
    check(
      'incidents_window_check',
      sql`scheduled_end_at IS NULL OR scheduled_start_at IS NULL OR scheduled_end_at > scheduled_start_at`,
    ),
  ],
);

/** The incident's scope: exactly the things it is about, and nothing else. */
export const incidentTargets = pgTable(
  'incident_targets',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    incidentId: uuid('incident_id').notNull(),
    kind: text('kind').notNull(),
    /** A panel, location or product id, or a gateway's provider code. */
    ref: text('ref').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'incident_targets_pk',
      columns: [table.tenantId, table.incidentId, table.kind, table.ref],
    }),
    foreignKey({
      columns: [table.tenantId, table.incidentId],
      foreignColumns: [incidents.tenantId, incidents.id],
      name: 'incident_targets_incident_fk',
    }),
    check('incident_targets_kind_check', enumCheck('kind', INCIDENT_TARGET_KINDS)),
  ],
);

/**
 * One effect, once per incident and subject: the unique key is what makes a second
 * "apply" — a double click, two operators, a retry — change nothing.
 */
export const incidentEffects = pgTable(
  'incident_effects',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    incidentId: uuid('incident_id').notNull(),
    kind: text('kind').notNull(),
    targetKind: text('target_kind').notNull(),
    targetRef: text('target_ref').notNull(),
    /** What was actually changed: the panel for a location, else the target. */
    subjectRef: text('subject_ref').notNull(),
    state: text('state').notNull(),
    errorCode: text('error_code'),
    createdAt: timestamptz('created_at').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'incident_effects_pk',
      columns: [table.tenantId, table.incidentId, table.kind, table.subjectRef],
    }),
    foreignKey({
      columns: [table.tenantId, table.incidentId],
      foreignColumns: [incidents.tenantId, incidents.id],
      name: 'incident_effects_incident_fk',
    }),
    check('incident_effects_kind_check', enumCheck('kind', INCIDENT_EFFECT_KINDS)),
    check('incident_effects_target_kind_check', enumCheck('target_kind', INCIDENT_TARGET_KINDS)),
    check('incident_effects_state_check', enumCheck('state', INCIDENT_EFFECT_STATES)),
  ],
);

/** The timeline. Append-only: a trigger refuses UPDATE and DELETE (migration tail). */
export const incidentEvents = pgTable(
  'incident_events',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    incidentId: uuid('incident_id').notNull(),
    kind: text('kind').notNull(),
    actorType: text('actor_type').notNull(),
    /** An administrator's id, or a system job's name — as `audit_logs.actor_id` holds it. */
    actorId: text('actor_id'),
    actorLabel: text('actor_label'),
    /** Structured and non-sensitive: what changed, how many were told. Never a message. */
    detail: jsonb('detail'),
    occurredAt: timestamptz('occurred_at').notNull(),
  },
  (table) => [
    index('incident_events_incident_idx').on(
      table.tenantId,
      table.incidentId,
      table.occurredAt,
      table.id,
    ),
    foreignKey({
      columns: [table.tenantId, table.incidentId],
      foreignColumns: [incidents.tenantId, incidents.id],
      name: 'incident_events_incident_fk',
    }),
    check('incident_events_kind_check', enumCheck('kind', INCIDENT_EVENT_KINDS)),
    check('incident_events_actor_type_check', enumCheck('actor_type', ACTOR_TYPES)),
  ],
);

/** One customer communication: the message as sent, frozen, and how many it reached. */
export const incidentCommunications = pgTable(
  'incident_communications',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    incidentId: uuid('incident_id').notNull(),
    message: text('message').notNull(),
    recipients: integer('recipients').notNull(),
    sentByAdminId: uuid('sent_by_admin_id'),
    createdAt: timestamptz('created_at').notNull(),
  },
  (table) => [
    unique('incident_communications_tenant_id_key').on(table.tenantId, table.id),
    foreignKey({
      columns: [table.tenantId, table.incidentId],
      foreignColumns: [incidents.tenantId, incidents.id],
      name: 'incident_communications_incident_fk',
    }),
    check('incident_communications_recipients_check', sql`recipients >= 0`),
  ],
);

/** One customer of one communication: the subject of its INCIDENT_NOTICE lane row. */
export const incidentNotices = pgTable(
  'incident_notices',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    communicationId: uuid('communication_id').notNull(),
    incidentId: uuid('incident_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    createdAt: timestamptz('created_at').notNull(),
  },
  (table) => [
    unique('incident_notices_customer_key').on(
      table.tenantId,
      table.communicationId,
      table.customerId,
    ),
    foreignKey({
      columns: [table.tenantId, table.communicationId],
      foreignColumns: [incidentCommunications.tenantId, incidentCommunications.id],
      name: 'incident_notices_communication_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'incident_notices_customer_fk',
    }),
  ],
);

/**
 * A hidden legacy product shape (program Item 14,
 * `docs/legacy-migration/hidden-legacy-products.md`).
 *
 * One row per tenant per canonical legacy tariff shape — `(code_panel, volume,
 * service_time, time_unit, is_custom)` reduced by `legacyShapeKey` — and the ONE hidden
 * product that stands for it. A legacy service whose invoice named no product will, in
 * P6, reference that product, so it renews through the ordinary renewal path and the one
 * pricing boundary. There is no second productless pricing system.
 *
 * `price_product` is deliberately absent. It is a historical purchase snapshot and the
 * owner decided renewals are at the CURRENT NEXA tariff, so two invoices of one shape at
 * two historical prices are one shape and one product, and no column here could become a
 * permanent price lock.
 *
 * The product is created INACTIVE, HIDDEN, unpriced and uncategorised. `tariff_status`
 * `UNRESOLVED` is the explicit manual-review state: nothing of this shape is adoptable
 * until a current tariff is resolved. Uncategorised is structural, not cosmetic: an
 * order for a NEW service refuses a product with no category (`NOT_CATEGORISED`), while a
 * renewal reads the service's own product, so the row renews and is never sold new — and
 * `nexa_legacy_shape_product_hidden` refuses an edit that would categorise or list it.
 */
export const legacyProductShapes = pgTable(
  'legacy_product_shapes',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** `legacyShapeKey`'s output: versioned, deterministic, price-free. */
    shapeKey: text('shape_key').notNull(),
    /** The legacy panel CODE (e.g. `bac6`), trimmed; NULL when the invoice named none. */
    legacyCodePanel: text('legacy_code_panel'),
    trafficBytes: bigint('traffic_bytes', { mode: 'bigint' }).notNull(),
    durationDays: integer('duration_days').notNull(),
    isCustom: boolean('is_custom').notNull(),
    /** The hidden product standing for this shape. One shape, one product, both ways. */
    productId: uuid('product_id').notNull(),
    tariffStatus: text('tariff_status').notNull().default('UNRESOLVED'),
    unresolvedReason: text('unresolved_reason').default('NOT_YET_RESOLVED'),
    resolution: text('resolution'),
    /** For `MATCHED_PUBLIC_PRODUCT`: the public product whose current price was taken. */
    tariffSourceProductId: uuid('tariff_source_product_id'),
    resolvedAt: timestamptz('resolved_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    /** The idempotent ensure: one shape per tenant, whatever the rerun. */
    uniqueIndex('legacy_product_shapes_tenant_key').on(table.tenantId, table.shapeKey),
    uniqueIndex('legacy_product_shapes_tenant_product_key').on(table.tenantId, table.productId),
    index('legacy_product_shapes_tenant_status_idx').on(
      table.tenantId,
      table.tariffStatus,
      table.id,
    ),
    foreignKey({
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.id],
      name: 'legacy_product_shapes_product_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.tariffSourceProductId],
      foreignColumns: [products.tenantId, products.id],
      name: 'legacy_product_shapes_source_fk',
    }),
    check(
      'legacy_product_shapes_tariff_status_check',
      enumCheck('tariff_status', LEGACY_SHAPE_TARIFF_STATUSES),
    ),
    check(
      'legacy_product_shapes_unresolved_reason_check',
      nullableEnumCheck('unresolved_reason', LEGACY_SHAPE_UNRESOLVED_REASONS),
    ),
    check(
      'legacy_product_shapes_resolution_check',
      nullableEnumCheck('resolution', LEGACY_SHAPE_RESOLUTIONS),
    ),
    /** UNRESOLVED carries a reason and nothing else; RESOLVED carries how and when. */
    check(
      'legacy_product_shapes_state_check',
      sql`(tariff_status = 'UNRESOLVED'
            AND unresolved_reason IS NOT NULL AND resolution IS NULL
            AND resolved_at IS NULL AND tariff_source_product_id IS NULL)
       OR (tariff_status = 'RESOLVED'
            AND unresolved_reason IS NULL AND resolution IS NOT NULL AND resolved_at IS NOT NULL
            AND (resolution = 'MATCHED_PUBLIC_PRODUCT') = (tariff_source_product_id IS NOT NULL))`,
    ),
    check(
      'legacy_product_shapes_amounts_check',
      sql`traffic_bytes > 0 AND duration_days > 0 AND duration_days <= 3650`,
    ),
    check(
      'legacy_product_shapes_key_check',
      sql`length(shape_key) BETWEEN 1 AND 512 AND (legacy_code_panel IS NULL OR length(btrim(legacy_code_panel)) > 0)`,
    ),
  ],
);

/**
 * What the migration decided about one legacy customer's trial entitlement (program
 * Item 15, `docs/legacy-migration/trial-eligibility.md`).
 *
 * The provenance of a `trial_limit_overrides` row the migration wrote, or of its decision
 * NOT to write one. There is no second trial subsystem: a claim still decides with
 * `trialAllowanceFor` over the override and the grants; this table explains why the
 * override is what it is, and makes the decision once.
 *
 * Written once per customer and never updated: a rerun with the same legacy facts is a
 * replay, and a rerun with different ones is reported as a conflict and changes nothing —
 * in particular an override an operator removed after the import is not re-imposed. The
 * legacy facts are stored as values (`limit_usertest`, whether a test invoice existed),
 * never the legacy row or the Telegram id.
 */
export const legacyTrialEligibility = pgTable(
  'legacy_trial_eligibility',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    /** The legacy `user.limit_usertest`, or NULL when it was not a whole number. */
    legacyLimitUsertest: integer('legacy_limit_usertest'),
    /** Whether the legacy archive held a test invoice for this user, in any status. */
    legacyHadTrial: boolean('legacy_had_trial').notNull(),
    decision: text('decision').notNull(),
    /** The customer's NEXA override before the decision, and after it. */
    overrideBefore: integer('override_before'),
    overrideAfter: integer('override_after'),
    /** SHA-256 of the normalised legacy facts: a rerun with other facts is a conflict. */
    inputHash: text('input_hash').notNull(),
    recordedAt: timestamptz('recorded_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'legacy_trial_eligibility_pkey',
      columns: [table.tenantId, table.customerId],
    }),
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'legacy_trial_eligibility_customer_fk',
    }),
    index('legacy_trial_eligibility_tenant_decision_idx').on(
      table.tenantId,
      table.decision,
      table.customerId,
    ),
    check('legacy_trial_eligibility_decision_check', enumCheck('decision', LEGACY_TRIAL_DECISIONS)),
    /** The decision and the override it left agree, so the row cannot misexplain it. */
    check(
      'legacy_trial_eligibility_effect_check',
      sql`(decision IN ('LEGACY_NO_TRIALS', 'LEGACY_TRIAL_CONSUMED', 'LEGACY_LIMIT_UNREADABLE')
            AND override_before IS NULL AND override_after = 0)
       OR (decision = 'INHERIT_NEXA_POLICY' AND override_before IS NULL AND override_after IS NULL)
       OR (decision = 'KEPT_EXISTING_OVERRIDE'
            AND override_before IS NOT NULL AND override_after = override_before)`,
    ),
    /** An unreadable limit is NULL, and every decision drawn from the limit had one. */
    check(
      'legacy_trial_eligibility_limit_check',
      sql`decision = 'KEPT_EXISTING_OVERRIDE'
       OR (decision = 'LEGACY_LIMIT_UNREADABLE') = (legacy_limit_usertest IS NULL)`,
    ),
    check('legacy_trial_eligibility_hash_check', sql`input_hash ~ '^[0-9a-f]{64}$'`),
  ],
);

// --- Migration P4: legacy import metadata ----------------------------------------------

/**
 * One legacy import run (`docs/legacy-import-metadata.md`). Metadata about the run, never a
 * copy of what it read: the source is named by a SHA-256 fingerprint, a failure by a closed
 * code, and the counters are numbers.
 *
 * Lifecycle: inserted `RUNNING`; leaves it only by a conditional UPDATE naming `RUNNING`.
 * At most one `RUNNING` run per tenant, by a partial unique index rather than by a process —
 * two importer replicas are as normal here as two monitor replicas are elsewhere.
 */
export const legacyImportRuns = pgTable(
  'legacy_import_runs',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    mode: text('mode').notNull(),
    status: text('status').notNull(),
    /** SHA-256 hex of the source snapshot's identity (dump checksum, export manifest). */
    sourceFingerprint: text('source_fingerprint').notNull(),
    /** The importer's commit or release, for provenance; never a path or a host. */
    codeVersion: text('code_version'),
    failureCode: text('failure_code'),
    /** Rows the importer has read so far; advanced monotonically by checkpoints. */
    rowsSeen: integer('rows_seen').notNull().default(0),
    /** Snapshotted at the terminal transition from the map rows this run wrote. */
    rowsImported: integer('rows_imported').notNull().default(0),
    rowsSkipped: integer('rows_skipped').notNull().default(0),
    rowsManualReview: integer('rows_manual_review').notNull().default(0),
    rowsFailed: integer('rows_failed').notNull().default(0),
    startedAt: timestamptz('started_at').notNull(),
    lastProgressAt: timestamptz('last_progress_at').notNull(),
    finishedAt: timestamptz('finished_at'),
  },
  (table) => [
    unique('legacy_import_runs_tenant_id_key').on(table.tenantId, table.id),
    index('legacy_import_runs_tenant_started_idx').on(table.tenantId, table.startedAt),
    uniqueIndex('legacy_import_runs_one_running_idx')
      .on(table.tenantId)
      .where(sql`status = 'RUNNING'`),
    check('legacy_import_runs_mode_check', enumCheck('mode', LEGACY_IMPORT_RUN_MODES)),
    check('legacy_import_runs_status_check', enumCheck('status', LEGACY_IMPORT_RUN_STATUSES)),
    check(
      'legacy_import_runs_failure_code_check',
      sql`failure_code IS NULL OR ${enumCheck('failure_code', LEGACY_IMPORT_RUN_FAILURE_CODES)}`,
    ),
    check('legacy_import_runs_fingerprint_check', sql`source_fingerprint ~ '^[0-9a-f]{64}$'`),
    check(
      'legacy_import_runs_code_version_check',
      sql`code_version IS NULL OR code_version ~ '^[A-Za-z0-9._+-]{1,64}$'`,
    ),
    check(
      'legacy_import_runs_counters_check',
      sql`rows_seen >= 0 AND rows_imported >= 0 AND rows_skipped >= 0 AND rows_manual_review >= 0 AND rows_failed >= 0`,
    ),
    /** Each status carries exactly the stamps it implies; only FAILED names a failure. */
    check(
      'legacy_import_runs_status_stamps_check',
      sql`CASE status
            WHEN 'RUNNING' THEN finished_at IS NULL AND failure_code IS NULL
            WHEN 'FAILED' THEN finished_at IS NOT NULL AND failure_code IS NOT NULL
            ELSE finished_at IS NOT NULL AND failure_code IS NULL
          END`,
    ),
    check('legacy_import_runs_window_check', sql`finished_at IS NULL OR finished_at >= started_at`),
  ],
);

/**
 * What a legacy record became. One row per `(tenant, legacy_table, legacy_id)` for ever: a
 * rerun updates the row it decided before rather than adding a second answer.
 *
 * No column can hold a source row or free text. `checksum` is the SHA-256 of the canonical
 * source row the decision was made from, so a rerun can tell "already done" from "the
 * source changed since" without keeping the row. `entity_id` has no foreign key on purpose:
 * it names one of several tables (`entity_type`), and provenance must survive a later
 * decision about that entity.
 */
export const legacyImportMap = pgTable(
  'legacy_import_map',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    legacyTable: text('legacy_table').notNull(),
    legacyId: text('legacy_id').notNull(),
    /** The run that last wrote this row. */
    runId: uuid('run_id').notNull(),
    checksum: text('checksum').notNull(),
    status: text('status').notNull(),
    reasonCode: text('reason_code'),
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),
    /** How many runs have written a decision here; 1 on the first. */
    attempts: integer('attempts').notNull().default(1),
    createdAt: timestamptz('created_at').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'legacy_import_map_pk',
      columns: [table.tenantId, table.legacyTable, table.legacyId],
    }),
    foreignKey({
      columns: [table.tenantId, table.runId],
      foreignColumns: [legacyImportRuns.tenantId, legacyImportRuns.id],
      name: 'legacy_import_map_run_fk',
    }),
    index('legacy_import_map_tenant_run_idx').on(table.tenantId, table.runId, table.status),
    /** The reconcile / manual-review walk. */
    index('legacy_import_map_tenant_status_idx').on(
      table.tenantId,
      table.status,
      table.legacyTable,
      table.legacyId,
    ),
    index('legacy_import_map_tenant_entity_idx')
      .on(table.tenantId, table.entityType, table.entityId)
      .where(sql`entity_id IS NOT NULL`),
    check('legacy_import_map_status_check', enumCheck('status', LEGACY_IMPORT_MAP_STATUSES)),
    check(
      'legacy_import_map_reason_check',
      sql`reason_code IS NULL OR ${enumCheck('reason_code', LEGACY_IMPORT_REASON_CODES)}`,
    ),
    check(
      'legacy_import_map_entity_type_check',
      sql`entity_type IS NULL OR ${enumCheck('entity_type', LEGACY_IMPORT_ENTITY_TYPES)}`,
    ),
    check('legacy_import_map_table_check', sql`legacy_table ~ '^[a-z][a-z0-9_]{0,62}$'`),
    check('legacy_import_map_id_check', sql`legacy_id ~ '^[A-Za-z0-9_.:-]{1,128}$'`),
    check('legacy_import_map_checksum_check', sql`checksum ~ '^[0-9a-f]{64}$'`),
    check('legacy_import_map_attempts_check', sql`attempts >= 1`),
    /** IMPORTED names exactly one entity; nothing else names any, and must say why. */
    check(
      'legacy_import_map_status_shape_check',
      sql`CASE status
            WHEN 'IMPORTED' THEN entity_type IS NOT NULL AND entity_id IS NOT NULL
            ELSE entity_type IS NULL AND entity_id IS NULL AND reason_code IS NOT NULL
          END`,
    ),
  ],
);
