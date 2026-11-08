/**
 * Database schema — tenancy: the tenant, its bots and their media.
 *
 * One part of `../schema.ts`, which re-exports every part; import from there.
 */
import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  BOT_INSTANCE_STATUSES,
  CALENDARS,
  CURRENCY_CODES,
  TENANT_KINDS,
  TENANT_STATUSES,
  TENANT_MEDIA_PURPOSES,
  TENANT_MEDIA_MIME_TYPES,
  TENANT_MEDIA_MAX_BYTES,
  APPEARANCE_TEST_ERROR_CODES,
  APPEARANCE_TEST_OUTCOMES,
} from '@nexa/contracts';
import { bytea, enumCheck, timestamptz } from './_shared.js';

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
    /**
     * When the terms and rules first became ENFORCED here (the `terms_enforcement` flag on
     * AND a published version), or NULL while they never have. Written once, by whichever
     * write made that true first, in that write's transaction, and never moved: a customer
     * created before it, or imported, is treated as having accepted (R5C-1 item 1).
     */
    rulesFirstEnforcedAt: timestamptz('rules_first_enforced_at'),
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
