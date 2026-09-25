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
export * from './catalog.js';
export * from './commerce.js';
export * from './customer-notifications.js';
export * from './bot-commands.js';
export * from './payment.js';
export * from './payment-accounts.js';
export * from './payment-gateways.js';
export * from './gateway-invoices.js';
export * from './tonpays.js';
export * from './refunds.js';
export * from './payment-receipts.js';
export * from './provisioning.js';
export * from './service-reminders.js';
export * from './service-username.js';
export * from './promotions.js';
export * from './customer-ux.js';
export * from './templates.js';
export * from './settings.js';
export * from './features.js';
export * from './notifications.js';
export * from './backup.js';
export * from './recovery.js';
export * from './secrets.js';
export * from './ports.js';
export * from './http.js';
