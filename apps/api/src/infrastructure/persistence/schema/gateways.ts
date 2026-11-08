/**
 * Database schema — gateways: payment accounts, gateways, credentials, call budgets, FX.
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
  FX_BASE_ASSETS,
  FX_SOURCES,
  SALES_CURRENCY_CODES,
  PAYMENT_GATEWAY_PROVIDERS,
  CENTRALPAY_INTEGER_MAX,
  CUSTOM_GATEWAY_BASE_URL_MAX_LENGTH,
  CUSTOM_GATEWAY_IP_ALLOWLIST_MAX,
  CENTRALPAY_INTEGER_MIN,
  PAYMENT_GATEWAY_STATUSES,
  TONPAYS_PAYMENT_LINKS,
  PAYMENT_GATEWAY_TOPUP_CASHBACK_PERCENT_MAX,
  CUSTOMER_FEE_BASIS_POINTS_MAX,
  CUSTOMER_FEE_BASIS_POINTS_MIN,
  PAYMENT_GATEWAY_TOPUP_CASHBACK_PERCENT_MIN,
} from '@nexa/contracts';
import { enumCheck, nullableEnumCheck, timestamptz } from './_shared.js';
import { tenants } from './tenancy.js';
import { customers } from './customers.js';

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
     * R11 B7: offer the route only to a customer whose phone number is verified
     * (`customers.phone_verified_at`). Default false, the state every row was in before the
     * column existed. Read ONLY while the `phone_verification` flag is on: off, the rule is
     * treated as not configured (`evaluateGatewayEligibility`).
     */
    requiresVerifiedPhone: boolean('requires_verified_phone').notNull().default(false),
    /**
     * The TONPAYS (website) route's «لینک پرداخت»: which of the provider's two links the
     * customer is sent to, `TELEGRAM_BOT` (`invoice_url`) or `WEB` (`web_invoice_url`). Default
     * `TELEGRAM_BOT`. Meaningful for TONPAYS only and ignored on every other route; each
     * attempt snapshots it onto its `gateway_invoices` row, so changing it redirects only new
     * attempts.
     */
    tonpaysPaymentLink: text('tonpays_payment_link').notNull().default('TELEGRAM_BOT'),
    /**
     * A `FIXED_RATE` route's conversion (Package A): sales-currency minor units per ONE
     * provider unit — for Telegram Stars in a Toman installation, the owner's
     * `toman_per_star`. Null until an operator sets it, and a fixed-rate route cannot be
     * enabled while it is. Each attempt snapshots it onto its `gateway_invoices` row, so
     * changing it never alters an invoice already open. There is no FX feed.
     */
    providerUnitRateMinor: bigint('provider_unit_rate_minor', { mode: 'bigint' }),
    /**
     * Round 6 item 6: the instant until which the provider's own daily limit hides this route
     * (TetraPay's `DAILY_LIMIT_REACHED`; the next 00:00 Tehran). NULL: not hidden. The route is
     * not offered while `hidden_until > now`, and returns by itself — nothing clears it. It is
     * NOT `status`: DISABLED is the operator's word, this is the provider's, and the operator's
     * switch is untouched by it.
     */
    hiddenUntil: timestamptz('hidden_until'),
    /**
     * Round 10 C1: an `operatorEndpoint` route's bridge (the custom gateway,
     * `docs/protocols/custom-gateway.md` §1): the `https://` base URL the operator configured,
     * and the CIDRs its callbacks may come from (empty: no address check). Not secrets. NULL on
     * every other route (CHECK). Changed only while the route is DISABLED, every change
     * audited; each attempt FREEZES the URL on its own invoice row
     * (`gateway_invoices.endpoint_base_url`), so changing it redirects only new attempts.
     */
    endpointBaseUrl: text('endpoint_base_url'),
    webhookIpAllowlist: text('webhook_ip_allowlist').array(),
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
      'payment_gateways_tonpays_payment_link_check',
      enumCheck('tonpays_payment_link', TONPAYS_PAYMENT_LINKS),
    ),
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
    /*
     * Round 10 C1: only the custom route has a bridge, its URL is https and bounded, and its
     * allow-list is bounded. The full shape rule (no userinfo, query or fragment) is the
     * contract's `normaliseCustomGatewayBaseUrl`, which every write runs; this is the floor a
     * hand-written UPDATE cannot go below.
     */
    check(
      'payment_gateways_endpoint_check',
      sql`(provider = 'CUSTOM' OR (endpoint_base_url IS NULL AND webhook_ip_allowlist IS NULL))
          AND (endpoint_base_url IS NULL OR (endpoint_base_url ~ '^https://[^/?#@[:space:]]+' AND length(endpoint_base_url) <= ${sql.raw(String(CUSTOM_GATEWAY_BASE_URL_MAX_LENGTH))}))
          AND (webhook_ip_allowlist IS NULL OR cardinality(webhook_ip_allowlist) <= ${sql.raw(String(CUSTOM_GATEWAY_IP_ALLOWLIST_MAX))})`,
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
