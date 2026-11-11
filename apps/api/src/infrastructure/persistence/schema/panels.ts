/**
 * Database schema — panels: panel connections, health, capacity, probes, the monitor and per-panel settings.
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
  doublePrecision,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  PANEL_HEALTH_STATES,
  MONITOR_DEFERRAL_REASONS,
  PANEL_STATUSES,
  PROVIDER_ANNOUNCEABLE_CAPABILITIES,
  PROVIDER_FAILURE_KINDS,
  PROVIDER_TYPES,
  DEFAULT_USERNAME_PREFIX,
  DEFAULT_USERNAME_STRATEGY,
  USERNAME_STRATEGIES,
  PANEL_TRIAL_HOURS_MAX,
  PANEL_TRIAL_HOURS_MIN,
  PANEL_TRIAL_LABEL_MAX_LENGTH,
  PANEL_TRIAL_TRAFFIC_MAX_BYTES,
  PANEL_SETTING_KEYS,
  PANEL_QR_KINDS,
  SINGBOX_NAME_MODES,
} from '@nexa/contracts';
import { enumArrayCheck, enumCheck, nullableEnumCheck, timestamptz } from './_shared.js';
import { tenants } from './tenancy.js';
import { admins } from './identity.js';

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
    /**
     * R11 A4: «فقط فایل، بدون لینک ساب» — the subscription link of a service on this panel
     * is never shown to its customer (bot card, «سرویس‌های من», mini app); they get the
     * connection files only, and «تغییر لینک» becomes «دریافت فایل‌های جدید».
     *
     * NOT NULL with default false, so every panel that exists when the migration runs keeps
     * showing its link and nothing changes underneath an operator. Possible only on a panel
     * whose provider hands over connection files; `PanelService.update` refuses it on any
     * other (a CHECK cannot know which provider can). Nothing is sent to a customer when it
     * is switched, and no service row is touched.
     */
    filesOnlyDelivery: boolean('files_only_delivery').notNull().default(false),
    /**
     * R11 A4: «نوع بارکد» — which QR a customer of this panel is shown. RickPanel panels only
     * (`PanelService.update` refuses another provider; a CHECK cannot know which provider a
     * row is). `SUB_LINK` is the default and exactly what every panel drew before.
     */
    qrKind: text('qr_kind').notNull().default('SUB_LINK'),
    /** The refresh interval written into a sing-box import QR, in minutes. */
    singboxIntervalMinutes: integer('singbox_interval_minutes').notNull().default(360),
    /**
     * «نام پروفایل در sing-box»: DEFAULT draws no fragment (today's behaviour for every
     * existing panel), USERNAME the service's account name, CUSTOM the owner's own text in
     * `singbox_name_custom` (trimmed, at most 64 characters, `{username}` substituted).
     */
    singboxNameMode: text('singbox_name_mode').notNull().default('DEFAULT'),
    singboxNameCustom: text('singbox_name_custom'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('panels_tenant_status_idx').on(table.tenantId, table.status),
    /** A drain and its reason, or neither — the same biconditional shape as the username policy. */
    check('panels_qr_kind_check', enumCheck('qr_kind', PANEL_QR_KINDS)),
    check('panels_singbox_name_mode_check', enumCheck('singbox_name_mode', SINGBOX_NAME_MODES)),
    check(
      'panels_singbox_name_custom_check',
      sql`${table.singboxNameCustom} IS NULL OR (char_length(${table.singboxNameCustom}) BETWEEN 1 AND 64 AND ${table.singboxNameCustom} !~ '[[:cntrl:]]')`,
    ),
    check(
      'panels_singbox_interval_check',
      sql`${table.singboxIntervalMinutes} BETWEEN 1 AND 10080`,
    ),
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
     * v0.9.5 PR-3: the optional capabilities the probe this row records ANNOUNCED — a
     * custom bridge's `capabilities: ["files"]` (`PROVIDER_ANNOUNCEABLE_CAPABILITIES`).
     * Empty for a failed probe and for every provider whose capabilities are static.
     * Replaced by every probe that is written, so it never outlives the answer naming it.
     */
    announcedCapabilities: text('announced_capabilities')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
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
    check(
      'panel_health_announced_capabilities_check',
      enumArrayCheck('announced_capabilities', PROVIDER_ANNOUNCEABLE_CAPABILITIES),
    ),
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
 * Track 3 §2: one panel's value for one PANEL-scoped registry key
 * (`settingScope(key) === 'PANEL'`). `setting_values` is the tenant scope; this is the
 * panel scope, and neither can hold the other's keys — the CHECK below names the panel
 * keys, and the tenant surface refuses them.
 *
 * Absence means the registry default applies, exactly as for a tenant setting, and for
 * the same reason: a flag beside a value can disagree with it, absence cannot. The value
 * is parsed by the key's declared schema on the way in and on the way out.
 */
export const panelSettingValues = pgTable(
  'panel_setting_values',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    panelId: uuid('panel_id').notNull(),
    settingKey: text('setting_key').notNull(),
    value: jsonb('value').notNull(),
    version: integer('version').notNull().default(1),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    updatedByAdminId: uuid('updated_by_admin_id'),
  },
  (table) => [
    uniqueIndex('panel_setting_values_key').on(table.tenantId, table.panelId, table.settingKey),
    check('panel_setting_values_version_check', sql`version >= 1`),
    check('panel_setting_values_key_check', enumCheck('setting_key', PANEL_SETTING_KEYS)),
    foreignKey({
      name: 'panel_setting_values_panel_fk',
      columns: [table.tenantId, table.panelId],
      foreignColumns: [panels.tenantId, panels.id],
    }),
    foreignKey({
      name: 'panel_setting_values_tenant_admin_fk',
      columns: [table.tenantId, table.updatedByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
  ],
);
