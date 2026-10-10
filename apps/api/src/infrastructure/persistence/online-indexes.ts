import type { PoolClient } from 'pg';
import type { DatabaseHandle } from './database.js';

/**
 * Indexes built OUTSIDE the migrator, concurrently.
 *
 * Drizzle runs every pending migration inside one transaction, and
 * `CREATE INDEX CONCURRENTLY` is refused inside a transaction block. An
 * ordinary `CREATE INDEX` in a migration takes a SHARE lock on the table for
 * the whole build, which blocks every insert, update and status change on it.
 * That matters here because of WHEN migrations run: `botctl update` migrates
 * while the OUTGOING release is still serving, so the lock lands on an
 * installation that is up and taking operator writes.
 *
 * So these live here instead. They are deliberately NOT declared in
 * `schema.ts`: drizzle-kit would then generate a migration for each one and the
 * drift check would never come back clean. That is the same arrangement as the
 * hand-written guard migrations — the schema file describes what drizzle-kit
 * models, and what it does not model is described where it is applied.
 *
 * The cost of that arrangement, stated rather than glossed: `pnpm db:check`
 * cannot see these, so an index removed from this list is not a drift failure.
 * The integration suite asserts each one exists and is valid after migrating,
 * which is the check that does catch it.
 */
export interface OnlineIndex {
  /** The index name. Also the recovery key, so it never changes casually. */
  readonly name: string;
  /** Everything after `CREATE INDEX CONCURRENTLY <name>`. */
  readonly definition: string;
}

export const ONLINE_INDEXES: readonly OnlineIndex[] = [
  {
    // The panel pagination keyset: `(tenant_id, created_at, id)` filtered to
    // the live list, which is exactly what `pageKeysQuery` walks. Serves it as
    // an index-only scan with the `ROW(created_at, id) > ROW(...)`
    // continuation inside the Index Cond.
    name: 'panels_tenant_created_page_idx',
    definition:
      'ON "panels" USING btree ("tenant_id","created_at","id") WHERE status <> \'ARCHIVED\'',
  },
  {
    /*
     * The alerts pagination keyset: `(tenant_id, first_seen_at, id)`.
     *
     * The owner's decision moved that traversal off `last_seen_at`, which every
     * repeat occurrence of a deduped condition rewrites. The KEYSET moved and
     * its index did not — the only index on this table was
     * `operational_events_tenant_seen_idx` on `(tenant_id, last_seen_at)`, so
     * the new `ORDER BY first_seen_at DESC, id DESC` matched nothing and the
     * alerts page sorted the tenant's whole event history on every request.
     * That is this branch's own recurring shape: the rule applied where the
     * author was looking and absent one expression over.
     *
     * A btree serves a DESC scan of an ASC index backwards, so one index
     * covers the ordering and the `ROW(first_seen_at, id) < ROW(...)`
     * continuation. Not partial: unlike panels there is no status split here,
     * and `resolved_at` deliberately carries no index (see the schema).
     *
     * The `(tenant_id, last_seen_at)` index stays — `since`/`until` remain an
     * ACTIVITY filter on `last_seen_at` and still use it.
     */
    name: 'operational_events_tenant_first_seen_page_idx',
    definition: 'ON "operational_events" USING btree ("tenant_id","first_seen_at","id")',
  },
  {
    // The same keyset for the OTHER side of the archive. The live index above
    // is partial on `status <> 'ARCHIVED'`, so the archive browser — added so a
    // retired panel can be found and restored — matched no index at all and
    // paged by sequential scan over the whole table. Its own partial index
    // costs nothing on the live path and is small, because the archive is
    // where panels go to stop being many.
    name: 'panels_tenant_archived_page_idx',
    definition:
      'ON "panels" USING btree ("tenant_id","created_at","id") WHERE status = \'ARCHIVED\'',
  },
  {
    /*
     * The backup history keyset: `(started_at, id)`.
     *
     * `backup_runs_started_at_idx` already exists on `started_at` alone, which
     * serves the scheduler's "when did we last succeed" and served `latest(n)`
     * well enough because that query had no continuation to satisfy. The Web
     * history pages with `ROW(started_at, id) < ROW(...)` and orders by both, and
     * the single-column index cannot carry the tie-break — so without this the
     * page walk sorts the whole table on every request, which is the exact shape
     * the alerts keyset hit one release ago.
     *
     * No `tenant_id` leading column, and that is not an omission: `backup_runs`
     * has no tenant column at all, because a backup is a dump of the whole
     * database. The scope check is on the REQUEST (only the installation's
     * primary tenant may read this history), not on the row.
     *
     * CONCURRENTLY, unlike the recovery keyset declared in `schema.ts`, because
     * this table is live on every existing installation and `botctl update`
     * migrates while the outgoing release is still serving.
     */
    name: 'backup_runs_started_page_idx',
    definition: 'ON "backup_runs" USING btree ("started_at","id")',
  },
  {
    /*
     * The unanswered-operation sweep: `(tenant_id, completed_at)` filtered to
     * terminal rows nobody has spoken for.
     *
     * `dueForAnnouncement` runs on EVERY provisioner tick, and the rows it wants
     * are the rarest in the table — an operation is unanswered only between its
     * terminal transition and the announcement, which is milliseconds unless a
     * process died. Without a partial index that is a scan of every terminal
     * operation an installation has ever completed, every tick, to find none.
     *
     * PARTIAL on the two states plus `announced_at IS NULL`, so the index holds
     * only the crash cases and stays close to empty on a healthy installation:
     * a row leaves it the moment it is answered. The ordering column is
     * `completed_at` because the sweep answers the customer who has been waiting
     * longest first.
     *
     * CONCURRENTLY, for the reason this whole file exists: `botctl update`
     * migrates while the outgoing release is still serving, and an ordinary
     * `CREATE INDEX` on `provisioning_operations` would block every operation
     * transition for the length of the build.
     */
    name: 'provisioning_operations_unannounced_idx',
    /*
     * The predicate is written in POSTGRESQL's own canonical form — parenthesised
     * conjuncts and `= ANY (ARRAY[...])` rather than `IN (...)` — because
     * `online-indexes.test.ts` compares the declaration against `pg_indexes`
     * TEXTUALLY. An `IN` list is stored as `= ANY (ARRAY[...])` and the comparison
     * then fails on an index that is correct. Writing what the server stores keeps
     * that check able to catch a declaration that has actually drifted.
     */
    definition:
      'ON "provisioning_operations" USING btree ("tenant_id","completed_at") ' +
      "WHERE (announced_at IS NULL) AND (state = ANY (ARRAY['SUCCEEDED','ABANDONED']))",
  },
  {
    /*
     * The capacity count: for ONE panel, the services that occupy a slot.
     *
     * Read on every catalogue browse, every order confirmation and every panel
     * list, and the rows it wants are a small fraction of a mature
     * installation's `services` table — a tenant has a handful of panels and
     * years of terminated accounts. `services_tenant_state_idx` cannot serve it:
     * it leads with the state, so counting one panel's services means walking
     * every service of that state the tenant has and filtering by panel.
     *
     * PARTIAL on `state <> 'TERMINATED'`, which is how the contract DERIVES
     * `SERVICE_CAPACITY_STATES` — so a state added to the machine is inside this
     * index automatically, for the same reason it is inside the count.
     * Enumerating the five would put a second opinion in an index predicate,
     * where a disagreement shows up as an undercount rather than as an error.
     *
     * CONCURRENTLY, for the reason this whole file exists: `botctl update`
     * migrates while the outgoing release is still serving, and `services` is
     * the table every provisioning write touches.
     */
    name: 'services_panel_capacity_idx',
    definition:
      'ON "services" USING btree ("tenant_id","panel_id") ' + "WHERE (state <> 'TERMINATED'::text)",
  },
  {
    /*
     * The support lookup: for ONE tenant, the service holding a given provider
     * username.
     *
     * A customer writes "my account nx7f3a91... stopped working", and that
     * string is the only handle they have — they never see a service id. Until
     * this release no surface could answer it, because the only index carrying
     * `provider_username` is `services_panel_provider_username_key`, which
     * leads with `panel_id` and therefore serves "is this name taken on THIS
     * panel" and nothing else. A tenant-scoped lookup through it means one
     * probe per panel, or a sequential scan of every service the installation
     * has ever sold.
     *
     * So the leading column is `tenant_id`, which is also what makes the
     * lookup an isolation boundary rather than a filter applied afterwards.
     * Not unique, deliberately: the uniqueness that exists is per PANEL, and
     * two panels of one tenant pointing at different machines may legitimately
     * hold the same account name. A unique index here would refuse the second
     * sale with a constraint violation.
     *
     * Not partial on state either. Terminated services are exactly what a
     * support question is often about — "my account stopped working" is the
     * sentence a terminated account produces — so excluding them would make
     * the index fast at answering everything except the common case.
     *
     * CONCURRENTLY, and this is the point worth reading twice: `services` is
     * POPULATED on every installation that has sold anything, and `botctl
     * update` migrates while the outgoing release is still serving. An
     * ordinary `CREATE INDEX` in a migration would take a SHARE lock on the
     * one table every provisioning write touches, for the length of the build,
     * on a live installation. That is why this index is here and not in
     * `apps/api/drizzle/` — the same reason `0036` gives for the rule.
     */
    name: 'services_tenant_provider_username_idx',
    definition: 'ON "services" USING btree ("tenant_id","provider_username")',
  },
  {
    /*
     * One payment's wallet movements, in time order: the payment timeline's read (WP17,
     * Codex review of #81). Every other index on `wallet_entries` leads with the customer
     * or the tenant's time, so an old payment's few rows were found by walking the
     * customer's whole LATER ledger, bounded on neither side that mattered.
     *
     * Partial: most ledger entries name no payment, and they have no place here.
     * Concurrently, for the reason `services` gives above: `wallet_entries` is populated
     * on every installation that has sold anything, and a blocking build would hold every
     * wallet write behind it during `botctl update`.
     */
    name: 'wallet_entries_payment_idx',
    definition:
      'ON "wallet_entries" USING btree ("tenant_id","payment_id","created_at","id") ' +
      'WHERE (payment_id IS NOT NULL)',
  },
  {
    /*
     * The outbox messages that failed and are still being retried (WP20): what the relay
     * claim's sibling rule asks for, once per candidate, and nothing else.
     *
     * The rule — no EARLIER message of the same aggregate is still failing — could only
     * use the unique `(aggregate_type, aggregate_id, sequence)` index, so it walked every
     * earlier sequence of the aggregate, published history included, with a heap fetch
     * each. Published rows are never deleted, and `System:system` takes one sequence per
     * ping ever sent, so the claim's cost grew without bound. PARTIAL on the three
     * conditions the rule tests, so it holds only the failures in flight and stays close
     * to empty on a healthy installation.
     *
     * Concurrently, for the reason this file exists: every business transaction writes
     * `outbox_messages`, and a blocking build would hold all of them during
     * `botctl update`.
     */
    name: 'outbox_messages_live_failure_idx',
    definition:
      'ON "outbox_messages" USING btree ("aggregate_type","aggregate_id","sequence") ' +
      'WHERE (published_at IS NULL) AND (attempts > 0) AND (exhausted_at IS NULL)',
  },
  {
    /*
     * The Telegram message-state retention sweep (`docs/telegram-retention.md`): one
     * tenant's wizard rows, least recently touched first, bounded by `updated_at < cutoff`.
     * Every other index on `telegram_wizards` leads with the payment, the subject or the
     * chat, so without this the sweep read the tenant's whole table every pass.
     *
     * Concurrently: every customer tap on a wizard writes this table, and it is the table
     * that grew unbounded until this release, so a blocking build would hold every tap.
     */
    name: 'telegram_wizards_retention_idx',
    definition: 'ON "telegram_wizards" USING btree ("tenant_id","updated_at")',
  },
  {
    /*
     * The same sweep's review-message side: oldest last write first (`updated_at`, bumped by
     * recording, finalising and clearing a stamp). Concurrently, for the reason above: every
     * receipt decision writes this table. Named apart from the `created_at` shape an earlier
     * revision of this branch declared, so no database that built that one keeps it under
     * this name.
     */
    name: 'telegram_review_messages_updated_idx',
    definition: 'ON "telegram_review_messages" USING btree ("tenant_id","updated_at")',
  },

  /*
   * ---------------------------------------------------------------------------------
   * The Web Admin's one search box (spec §10, `docs/web-admin-search.md`).
   *
   * Each list's `q` is an OR of exact and prefix matches, and an OR is a BitmapOr only
   * when EVERY arm has an index; one arm without one turns the whole predicate into a
   * filter over a walk of the tenant's table. These are the arms that had none. All are
   * `tenant_id`-led, and all are built concurrently because every one of these tables is
   * populated and written on every installation that has sold anything — the reason this
   * file exists. `customers-plan.test.ts`, `orders-plan.test.ts`, `payments-plan.test.ts`
   * and `services-plan.test.ts` read the planner's answer for each, on the statements the
   * repositories actually send.
   * ---------------------------------------------------------------------------------
   */
  {
    /*
     * A customer by display name, first name then last, by PREFIX. The expression is
     * spelled as PostgreSQL stores it and exactly as `drizzle-customer.repository.ts`
     * writes it; `concat_ws` would read better and is STABLE, so it cannot be indexed.
     */
    name: 'customers_tenant_full_name_idx',
    definition:
      'ON "customers" USING btree ("tenant_id",' +
      "lower(((COALESCE(first_name, '') || ' ') || COALESCE(last_name, ''))) text_pattern_ops)",
  },
  {
    // A customer by last name alone, by prefix: "Rezaei" must find "Ali Rezaei".
    name: 'customers_tenant_last_name_idx',
    definition: 'ON "customers" USING btree ("tenant_id",lower(last_name) text_pattern_ops)',
  },
  {
    // An order by the SNAPSHOT title the customer bought, by prefix.
    name: 'orders_tenant_line_title_idx',
    definition: 'ON "orders" USING btree ("tenant_id",lower(line_title) text_pattern_ops)',
  },
  {
    /*
     * An order by its product: a uuid typed into the box, and the product-name arm, which
     * resolves the catalogue's matching ids first. `?productId=` had no index either —
     * `orders_product_fk` is a constraint, not an index — so it walked the tenant's orders.
     * Keyed like the other order keysets so a single product's page is read in order.
     */
    name: 'orders_tenant_product_created_idx',
    definition: 'ON "orders" USING btree ("tenant_id","product_id","created_at","id")',
  },
  {
    /*
     * A payment by its order. `payments_order_confirmed_key` is partial on CONFIRMED and
     * serves only the double-charge guard; `?orderId=` had nothing else.
     */
    name: 'payments_tenant_order_idx',
    definition: 'ON "payments" USING btree ("tenant_id","order_id")',
  },
  {
    // A payment by the gateway's or bank's own reference — what a customer's receipt shows.
    name: 'payments_tenant_external_reference_idx',
    definition: 'ON "payments" USING btree ("tenant_id","external_reference")',
  },
  {
    /*
     * A payment by its PUBLIC tracking code (FIX-02): the operation-id half of `reference`,
     * which is what every invoice shows and what a customer quotes to support. The expression
     * is exactly the one `referenceCondition` asks, so the planner can match it. Not unique:
     * a code is 64 bits of a hash, and the search shows every match rather than one.
     */
    name: 'payments_tenant_tracking_code_idx',
    definition: 'ON "payments" USING btree ("tenant_id", split_part("reference", \':\', 1))',
  },
  {
    /*
     * A service by its panel, every state. `services_panel_capacity_idx` is partial on
     * `state <> 'TERMINATED'` for the capacity count, so it cannot serve a uuid arm that
     * must also find terminated services — the ones a support question is often about.
     */
    name: 'services_tenant_panel_idx',
    definition: 'ON "services" USING btree ("tenant_id","panel_id")',
  },
  {
    /*
     * Phase C2: a tenant's FAILED provisioning operations in a recent window, for the
     * panel health dashboard's "failed in the last 24 hours" per panel.
     *
     * Partial on FAILED and ordered by `completed_at` (which FAILED always carries —
     * `provisioning_operations_completed_check`), so the read is bounded by the window
     * rather than by every operation the tenant has ever run. CONCURRENTLY for the
     * reason `provisioning_operations_unannounced_idx` gives: an ordinary build would
     * block every operation transition on a live installation.
     */
    name: 'provisioning_operations_failed_recent_idx',
    definition:
      'ON "provisioning_operations" USING btree ("tenant_id","completed_at") ' +
      "WHERE (state = 'FAILED'::text)",
  },
  {
    /*
     * Phase C3: a tenant's panels in one balancing group — the draft's candidate read and
     * the catalogue's reach. Partial on the group being set, so it holds only the panels
     * an operator has grouped; built online like the other panel keyset indexes.
     */
    name: 'panels_tenant_balancing_group_idx',
    definition:
      'ON "panels" USING btree ("tenant_id","balancing_group") ' +
      'WHERE (balancing_group IS NOT NULL)',
  },

  /*
   * ---------------------------------------------------------------------------------
   * The audit log browser (Phase D1, `docs/audit-log.md`).
   *
   * `audit_logs` had `(tenant_id, occurred_at)` and an `(entity_type, entity_id)` index that
   * does not lead with the tenant. The browser pages `(occurred_at, id)` DESC under a tenant,
   * optionally narrowed to one actor, one entity or one action, and each narrowing needs its
   * own tenant-led keyset or the planner walks the tenant's whole log backwards and filters.
   * Every one ends `occurred_at, id`, so a filtered page is read in order and stops at the
   * page size: the `ROW(occurred_at, id) < ROW(...)` continuation is an index condition.
   * `audit-log-plan.test.ts` reads the planner's answer on the statements the reader sends.
   *
   * Concurrently, and this table is the strongest case for it in the file: nearly every
   * business transaction writes an audit row, so a blocking build would hold all of them
   * during `botctl update`.
   * ---------------------------------------------------------------------------------
   */
  {
    // The unfiltered browser, the date range, the result and the security slices. The
    // existing `(tenant_id, occurred_at)` cannot carry the id tie-break.
    name: 'audit_logs_tenant_occurred_page_idx',
    definition: 'ON "audit_logs" USING btree ("tenant_id","occurred_at","id")',
  },
  {
    // One administrator's (or one job's) actions.
    name: 'audit_logs_tenant_actor_page_idx',
    definition: 'ON "audit_logs" USING btree ("tenant_id","actor_id","occurred_at","id")',
  },
  {
    /*
     * One entity's history, and the customer filter's four arms. Also serves the Customer 360
     * timeline and the reseller histories, which until now probed `audit_logs_entity_idx`
     * across every tenant's rows for that entity and filtered the tenant afterwards.
     */
    name: 'audit_logs_tenant_entity_page_idx',
    definition:
      'ON "audit_logs" USING btree ("tenant_id","entity_type","entity_id","occurred_at","id")',
  },
  {
    /*
     * One action, or one family by prefix. `text_pattern_ops` so a `LIKE 'payment.%'` prefix
     * is an index range whatever the database collation is; equality uses it too.
     */
    name: 'audit_logs_tenant_action_page_idx',
    definition:
      'ON "audit_logs" USING btree ("tenant_id",action text_pattern_ops,"occurred_at","id")',
  },
  {
    /*
     * The denials: the security slice an operator investigating an incident opens first, and
     * the rarest rows in the log. Without this the planner walks the time keyset backwards
     * discarding every successful row until it has a page of refusals — measured at 22 548
     * rows read for 51 on the plan fixture. PARTIAL, so it holds only the refusals.
     */
    name: 'audit_logs_tenant_denied_page_idx',
    definition:
      'ON "audit_logs" USING btree ("tenant_id","occurred_at","id") ' +
      "WHERE (result = 'DENIED'::text)",
  },
  {
    /*
     * A payment by the one provider id no unique key already serves (Payment Operations
     * Center, program §10): NOWPayments' payment id a verified webhook named, which is what an
     * operator copies out of the provider's dashboard. The order, invoice and charge ids are
     * served by the `(tenant_id, provider, …)` unique keys. Partial: most invoices carry none.
     */
    name: 'gateway_invoices_tenant_hinted_payment_idx',
    definition:
      'ON "gateway_invoices" USING btree ("tenant_id","hinted_payment_id") ' +
      'WHERE (hinted_payment_id IS NOT NULL)',
  },
  {
    /*
     * A payment by the invoice id a verified webhook named for an attempt whose create answer
     * was lost (CREATE_UNKNOWN): until an inquiry adopts it as `provider_invoice_id`, this is
     * the only place the provider's invoice id lives. Partial: most invoices carry none.
     */
    name: 'gateway_invoices_tenant_hinted_invoice_idx',
    definition:
      'ON "gateway_invoices" USING btree ("tenant_id","hinted_invoice_id") ' +
      'WHERE (hinted_invoice_id IS NOT NULL)',
  },
  {
    /*
     * FIX-11: the invoice arm of the Payment Operations Center's attention counts
     * (`paymentOpsCandidateIds`) — the invoices that put a payment in PARTIAL, LATE_COMPLETION
     * or PROVIDER_ERROR. Without it that arm read every invoice the tenant ever created
     * (a parallel sequential scan, 640 ms at 300 000 invoices); with it, 5 ms.
     *
     * PARTIAL: the predicate is the union of those three queues' invoice conditions, so the
     * index holds only the few rows that need somebody. The planner uses it only while the
     * query's condition IMPLIES this predicate; a partial status added to
     * `PARTIAL_PAYMENT_STATUSES` that is not listed here makes the arm fall back to the scan —
     * still correct, only slower — and `payment-attention-plan.test.ts` fails on it.
     */
    name: 'gateway_invoices_tenant_attention_idx',
    definition:
      'ON "gateway_invoices" USING btree ("tenant_id") ' +
      // Spelled as PostgreSQL renders it, which is what `online-indexes.test.ts` compares.
      "WHERE ((outcome = 'LATE_COMPLETION'::text) OR (late_completion_observed_at IS NOT NULL) " +
      "OR (creation_state = ANY (ARRAY['CREATE_FAILED'::text, 'CREATE_UNKNOWN'::text])) " +
      'OR (last_inquiry_error_code IS NOT NULL) ' +
      "OR (provider_status = 'partially_paid'::text))",
  },
  {
    /*
     * An order's provisioning operations (Payment Operations Center): the payment timeline
     * reads the operation that delivers what the settling order bought. Nothing served
     * `order_id` except the partial open-operation keys, so a timeline would have walked the
     * tenant's operations. Concurrently: every delivery writes this table.
     */
    name: 'provisioning_operations_tenant_order_idx',
    definition:
      'ON "provisioning_operations" USING btree ("tenant_id","order_id","created_at","id") ' +
      'WHERE (order_id IS NOT NULL)',
  },
  {
    /*
     * The sales a report counts: PAID orders by the instant they settled (Issue 16,
     * `docs/perf/web-admin-navigation.md`).
     *
     * Every windowed sales aggregate in `DrizzleReportingRepository` — `salesTotals`,
     * `trend`, `salesTrendByPurpose`, `revenueCurrencies`, `activeCustomers` — reads
     * `tenant_id = $t AND state = 'PAID' AND settled_at in [from, to)`, and the only index
     * naming `state` was `(tenant_id, state)`. So each of them, 29 statements per
     * `GET /dashboard/summary`, read the tenant's whole order history: a sequential scan
     * measured at 1.2–1.6 s per dashboard request on 320 000 orders, on every visit.
     *
     * PARTIAL on PAID, which is the one state every one of those statements names.
     * INCLUDE carries the columns they group, filter and sum — currency, purpose, origin,
     * the three amounts and the customer — so a window is an index-only range scan and
     * the heap is not touched for a visible page. Measured on that dataset: `salesTotals`
     * 435 → 97 ms over its eight calls, `trend` 257 → 33, `salesTrendByPurpose` 65 → 16.
     * Concurrently, because every settlement writes this table.
     */
    name: 'orders_tenant_paid_settled_idx',
    definition:
      'ON "orders" USING btree ("tenant_id","settled_at") ' +
      'INCLUDE ("currency","purpose","origin","total_amount","subtotal_amount",' +
      '"discount_amount","customer_id") ' +
      "WHERE (state = 'PAID'::text)",
  },
  {
    /*
     * Failed payments by the instant they were resolved: `paymentFailures`, twice per
     * `GET /dashboard/summary` and once per `GET /reports/failures` (Issue 16).
     *
     * `resolved_at` is set exactly when a payment is FAILED, CANCELLED or EXPIRED
     * (`payments_resolved_check`), so the partial predicate holds precisely the rows the
     * statement can count, and a window on it implies the predicate. INCLUDE `state`
     * because the statement counts by it. Measured on 320 000 payments: 114 ms → 7 ms over
     * the three calls, which had been a sequential scan of the tenant's payments.
     */
    name: 'payments_tenant_resolved_idx',
    definition:
      'ON "payments" USING btree ("tenant_id","resolved_at") INCLUDE ("state") ' +
      'WHERE (resolved_at IS NOT NULL)',
  },
  {
    /*
     * Roadmap B5 (review N4): one customer's business handoffs, for Customer 360's workspace.
     * The only index that named the state, `business_conversations_inbox_priority_idx`, leads
     * with the tenant, so a per-customer count walked the tenant's whole HANDOFF_REQUIRED
     * backlog and filtered the customer afterwards; `business_conversations` has no
     * customer-leading index at all. PARTIAL, so it holds only the conversations waiting for
     * a person. (Payments UNKNOWN and services UNRECONCILED needed nothing: the planner
     * serves those counts from the existing `(customer_id, created_at, id)` indexes.)
     */
    name: 'business_conversations_tenant_customer_handoff_idx',
    definition:
      'ON "business_conversations" USING btree ("tenant_id","customer_id") ' +
      "WHERE (state = 'HANDOFF_REQUIRED'::text)",
  },
];

/** Index names are code constants; this refuses one that stopped being one. */
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

type IndexState = 'MISSING' | 'VALID' | 'INVALID';

/**
 * Whether the index is there, and whether PostgreSQL trusts it.
 *
 * `indisvalid = false` is what a `CREATE INDEX CONCURRENTLY` interrupted part
 * way through leaves behind: the index exists, the planner ignores it, and
 * `CREATE INDEX CONCURRENTLY IF NOT EXISTS` sees the name and does nothing. An
 * installation whose migration was cancelled would otherwise keep the broken
 * index for ever and pay a sequential scan per page, with nothing saying so.
 */
async function indexState(client: PoolClient, name: string): Promise<IndexState> {
  const result = await client.query<{ valid: boolean }>(
    `SELECT i.indisvalid AS valid
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relname = $1 AND n.nspname = ANY (current_schemas(false))`,
    [name],
  );
  const row = result.rows[0];
  if (row === undefined) return 'MISSING';
  return row.valid ? 'VALID' : 'INVALID';
}

/**
 * Brings every online index into existence, idempotently.
 *
 * Safe to run on every migration, which is how it is run: an index that is
 * already valid costs one catalogue lookup. Safe to run after an interrupted
 * one, which is the case that needed thinking about — the leftover invalid
 * index is dropped concurrently and rebuilt rather than being left to look
 * like a healthy one.
 *
 * Returns the names it actually built, so a caller can say so.
 */
export async function ensureOnlineIndexes(handle: DatabaseHandle): Promise<string[]> {
  const built: string[] = [];
  for (const index of ONLINE_INDEXES) {
    if (!SAFE_IDENTIFIER.test(index.name)) {
      throw new Error(`${index.name} is not a plain index name.`);
    }
    // One checkout per index, with no deadline: `withClient` sets a
    // statement_timeout only when it is given one, and a concurrent build on a
    // large table legitimately outlasts any bound the application uses for its
    // own queries.
    await handle.withClient(async (client) => {
      // One builder at a time, across processes.
      //
      // Two migrators is what a `botctl update` retried before the first
      // finished looks like, and two `CREATE INDEX CONCURRENTLY` on one table
      // do not merely race: each waits for the other and PostgreSQL reports a
      // DEADLOCK, failing a migration run whose migrations had all applied.
      //
      // TRY and poll, never a blocking `pg_advisory_lock`. A blocking wait is
      // itself an open transaction, and a concurrent build waits for every
      // transaction that can see the table — so the waiter waits for the
      // builder's lock while the builder waits for the waiter's transaction,
      // which is the same deadlock by another route. It was measured, not
      // reasoned about: the blocking version deadlocked on every run of the
      // test below. Each attempt here is its own instantaneous statement.
      const lockKey = `nexa.online-index.${index.name}`;
      const held = await pollForLock(client, lockKey);
      if (!held) {
        throw new Error(
          `another migrator has been building ${index.name} for longer than ${BUILD_LOCK_WAIT_MS}ms.`,
        );
      }
      try {
        await buildIfNeeded(client, index, built);
      } finally {
        await client.query(`SELECT pg_advisory_unlock(hashtext($1)::bigint)`, [lockKey]);
      }
    });
  }
  return built;
}

/**
 * How long to wait for another migrator's build before giving up.
 *
 * Generous: what is being waited for is a concurrent index build on a table
 * that may be large, and the alternative to waiting is two builders
 * deadlocking.
 */
const BUILD_LOCK_WAIT_MS = 30 * 60 * 1000;
const BUILD_LOCK_POLL_MS = 250;

/** Takes the build lock without ever holding a transaction open to wait. */
async function pollForLock(client: PoolClient, key: string): Promise<boolean> {
  const deadline = Date.now() + BUILD_LOCK_WAIT_MS;
  for (;;) {
    const result = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS locked`,
      [key],
    );
    if (result.rows[0]?.locked === true) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, BUILD_LOCK_POLL_MS));
  }
}

/** The build itself, with the advisory lock already held. */
async function buildIfNeeded(
  client: PoolClient,
  index: OnlineIndex,
  built: string[],
): Promise<void> {
  let state = await indexState(client, index.name);
  if (state === 'INVALID') {
    await client.query(`DROP INDEX CONCURRENTLY IF EXISTS "${index.name}"`);
    state = 'MISSING';
  }
  if (state === 'VALID') return;
  try {
    await client.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${index.name}" ${index.definition}`,
    );
  } catch (error) {
    // `IF NOT EXISTS` resolves at statement start, so two builders that
    // begin before either has its catalogue entry both proceed and the
    // loser gets a duplicate name. That is somebody else building the same
    // index, not a failure — `botctl update` retries are meant to be safe,
    // and reporting it would fail a migration run whose migrations all
    // applied. The validity check below is what decides either way.
    const code = (error as { code?: string }).code;
    if (code !== '42P07' && code !== '23505') throw error;
  }
  const after = await indexState(client, index.name);
  if (after !== 'VALID') {
    // The build finished without throwing and left something the planner
    // will not use. Loud, because the alternative is an update that reports
    // success and an installation that silently scans.
    throw new Error(`${index.name} was built but is not valid; re-run the migration.`);
  }
  built.push(index.name);
}
