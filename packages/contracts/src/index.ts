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
export * from './pricing.js';
export * from './templates.js';
export * from './settings.js';
export * from './features.js';
export * from './notifications.js';
export * from './ports.js';
export * from './http.js';
