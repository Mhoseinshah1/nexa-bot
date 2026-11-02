/**
 * @nexa/contracts — the frozen specification.
 *
 * Declarations only: types, schemas, catalogs and ports. No implementation, no
 * framework, no I/O, and no dependency on any other workspace package.
 *
 * This package is the root of the dependency graph and the thing every module
 * agrees on. Adding a state, an event, a permission, a ledger reason or a metric
 * is a CONTRACT CHANGE — reviewed on its own, never folded into a feature
 * commit. A module that defines its own copy of a concept declared here fails
 * the module-boundary lint rule.
 *
 * See docs/adr/0003-frozen-contracts.md.
 */

export * from './ids.js';
/**
 * The identity of one logical external mutation, and the shapes that carry it.
 *
 * Declared before any of them has a consumer, which is deliberate: an operation
 * id that is introduced alongside the first mutating provider call is an operation
 * id designed around that call. Phase 4 has several, and they have to agree.
 */
export * from './operation.js';
export * from './operational-subject.js';
export * from './provider-note.js';
export * from './money.js';
export * from './time.js';
export * from './actor.js';
export * from './tenant.js';
export * from './permissions.js';
export * from './identity.js';
export * from './ledger.js';
export * from './events.js';
export * from './errors.js';
export * from './metrics.js';
export * from './state-machine.js';
export * from './provider.js';
export * from './panels.js';
/** WP-A8: the capability registry, the per-panel policy and panel diagnostics. */
export * from './panel-advanced.js';
export * from './panel-qr.js';
/** R1: the per-panel trial configuration, independent of the catalogue. */
export * from './panel-trial.js';
export * from './delivery-tutorial.js';
export * from './pricing.js';
/**
 * Phase 4 vocabularies.
 *
 * Declared after `pricing.js` because several of them take a `PriceQuote`, and in the
 * order a reader meets them: who buys (`customer`), what is sold (`catalog`), the
 * commercial record (`commerce`), how it is settled (`payment`), what it becomes
 * (`provisioning`), and what changes the price (`promotions`).
 */
export * from './customer.js';
// Spec §10: the one free-text search a Web Admin list page draws.
export * from './list-search.js';
// R11 A1: the top-bar search over customers, orders and services (no new permission).
export * from './global-search.js';
export * from './catalog.js';
export * from './traffic-input.js';
export * from './commerce.js';
export * from './customer-notifications.js';
export * from './menu-appearance.js';
export * from './bot-commands.js';
export * from './bot-menu.js';
// Round T: the button builder — explicit rows, styles, icons, draft/publish/revisions.
export * from './bot-menu-builder.js';
export * from './custom-menu-buttons.js';
// Owner spec §6: the customer's inline («شیشه‌ای») buttons — keys, labels, styles.
export * from './inline-buttons.js';
export * from './service-card-layout.js';
export * from './bot-management.js';
// Premium UI: appearance slots and custom emoji.
export * from './appearance.js';
export * from './payment.js';
export * from './payment-accounts.js';
export * from './payment-gateways.js';
export * from './payment-tracking.js';
export * from './public-code.js';
export * from './gateway-invoices.js';
export * from './tonpays.js';
export * from './tonpays-telegram.js';
export * from './nowpayments.js';
export * from './centralpay.js';
export * from './tetrapay.js';
export * from './rialit.js';
export * from './custom-gateway.js';
export * from './telegram-stars.js';
export * from './fx.js';
export * from './refunds.js';
export * from './messaging-reliability.js';
export * from './channel-membership.js';
export * from './service-refund-requests.js';
export * from './service-transfer.js';
// Round 10, D1: automatic renewal (تمدید خودکار).
export * from './auto-renew.js';
// WP-A7: the support ticket system.
export * from './tickets.js';
export * from './miniapp.js';
// Round N, C1: campaigns composing the pricing rules, the audience and the mass actions.
export * from './campaigns.js';
export * from './payment-receipts.js';
export * from './provisioning.js';
export * from './service-reminders.js';
export * from './customer-reminders.js';
export * from './service-username.js';
export * from './promotions.js';
export * from './customer-ux.js';
export * from './anti-abuse.js';
export * from './delivery-qr.js';
// R2: the Telegram messages edited in place (wizards, receipt review).
export * from './telegram-wizards.js';
export * from './client-apps.js';
export * from './custom-service.js';
// WP-A6: moving an existing service between locations of its own panel.
export * from './service-location.js';
export * from './customer-360.js';
/** Phase D1: the Web Admin's audit log browser and its export. */
export * from './audit-log.js';
// Program §6: the terms / rules domain.
export * from './terms.js';
export * from './customer-crm.js';
export * from './templates.js';
// UX Batch 01, item 5: the domain each template key belongs to.
export * from './template-categories.js';
export * from './settings.js';
export * from './features.js';
export * from './notifications.js';
export * from './ops-log-group.js';
export * from './ops-log-types.js';
export * from './persian-digits.js';
export * from './backup.js';
export * from './data-retention.js';
export * from './data-compaction.js';
export * from './legacy-compaction.js';
export * from './recovery.js';
export * from './recovery-kit.js';
export * from './secrets.js';
export * from './ports.js';
export * from './http.js';
/** Phase D2: the admin's second factor, own sessions and security history. */
export * from './admin-security.js';
/** Phase D3: role management over the existing authorization model. */
export * from './rbac.js';
export * from './reporting.js';
// Program §10: the Payment Operations Center's queues and the shared attention read model.
export * from './payment-operations.js';
/** Roadmap E1: the under-review UX — one situation classifier over recorded payment facts. */
export * from './payment-situations.js';
/** Roadmap E4: one payment's money as one breakdown, computed once on the server. */
export * from './payment-amounts.js';
// Program §11: gateway health, and the typed signal the Notification Center consumes.
export * from './gateway-health.js';
/** Round W: the Web Admin dashboard and sidebar counters, over the reports above. */
export * from './dashboard.js';
/** Round N: the shared audience, broadcast, and safe mass actions. */
export * from './audience.js';
export * from './broadcasts.js';
export * from './bulk-operations.js';
export * from './notification-center.js';
export * from './direct-messages.js';
export * from './incidents.js';
/** Legacy migration prerequisites: hidden legacy product shapes, legacy trial decisions. */
export * from './legacy-migration.js';
/** Migration P4: legacy import run and map metadata (codes only, never source rows). */
export * from './legacy-import.js';
/** Mirza migration PR1: legacy table classes and read set names (codes only, never rows). */
export * from './legacy-inventory.js';
/** Mirza migration PR2: the legacy product review (states, parse notes, HTTP shapes). */
export * from './legacy-product-review.js';
/** Mirza migration PR3: the legacy invoice archive (classes, run states, HTTP shapes). */
export * from './legacy-invoice-archive.js';
/** Mirza migration PR4: legacy wallet debts (negative balances held for review), the users/wallets report section. */
export * from './legacy-wallet-debt.js';
/** Mirza migration PR5: legacy service candidates (one outcome each) and their operator review. */
export * from './legacy-service-review.js';
/** Mirza migration PR6: the cutover approval, SOURCE_SUPERSEDED, the gate steps, report v2 versions. */
export * from './legacy-cutover.js';
/** Mirza `.nxpkg` importer: import statuses, history record types, error codes. */
export * from './legacy-nxpkg.js';
/** Mirza `.nxpkg` importer: the Web Admin routes, requests and views («مهاجرت از میرزا»). */
export * from './legacy-migration-routes.js';
/** Per-name RickPanel read diagnostics: closed causes and counts, never a name. */
export * from './legacy-inventory-diagnostics.js';
/** Mirza `.nxpkg` importer: the archived history read on Customer 360. */
export * from './legacy-history.js';
/** Mirza `.nxpkg` importer: a customer's Mirza money history beside the opening figure (read only). */
export * from './legacy-money-history.js';
/** TB1: Telegram Business connections and business-message classification (ADR-0033). */
export * from './business-chats.js';
/** TB3: the support context, the allowlisted payload the support agent reads (ADR-0034 §4). */
export * from './support-context.js';
/** TB4: the support AI's provider foundation (ADR-0034). */
export * from './support-ai.js';
/** TB8: support knowledge and controlled learning (ADR-0035). */
export * from './support-knowledge.js';
/** TB10: read-only support analytics over a half-open report window. */
export * from './support-analytics.js';
/** Phase 4 PR-5: readiness card, test console (sends nothing), handoff-text reports. */
export * from './support-ai-console.js';
/** FIX-04/05: the one taxonomy of reportable operational events and their group presentation. */
export * from './ops-error-events.js';
/** The one-time Mirza import: which rows of the normal tables came from Mirza. */
export * from './record-source.js';
/** R10 D4: gift cards — wallet top-up codes minted in batches and redeemed once. */
export * from './gift-cards.js';
