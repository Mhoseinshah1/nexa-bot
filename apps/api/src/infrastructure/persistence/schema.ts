/**
 * The database schema, one file per module under `./schema/`. This index re-exports
 * every part, so `import { … } from '…/persistence/schema.js'` reaches every table, and
 * it is the file `drizzle.config.ts` points drizzle-kit at.
 */
export { enumCheck, enumSubsetCheck, nullableEnumCheck, enumArrayCheck } from './schema/_shared.js';
export * from './schema/tenancy.js';
export * from './schema/eventing.js';
export * from './schema/identity.js';
export * from './schema/control-plane.js';
export * from './schema/notifications.js';
export * from './schema/panels.js';
export * from './schema/backup-recovery.js';
export * from './schema/customers.js';
export * from './schema/catalogue.js';
export * from './schema/orders.js';
export * from './schema/payments.js';
export * from './schema/refunds.js';
export * from './schema/gateway-invoices.js';
export * from './schema/gateways.js';
export * from './schema/wallet.js';
export * from './schema/services.js';
export * from './schema/service-lifecycle.js';
export * from './schema/custom-services.js';
export * from './schema/provisioning.js';
export * from './schema/marketing.js';
export * from './schema/referrals.js';
export * from './schema/broadcasts.js';
export * from './schema/resellers.js';
export * from './schema/support.js';
export * from './schema/business-chats.js';
export * from './schema/support-ai.js';
export * from './schema/support-knowledge.js';
export * from './schema/ops.js';
export * from './schema/legacy-import.js';
export * from './schema/legacy-history.js';
export * from './schema/hosting.js';
export * from './schema/hosted-backups.js';
export * from './schema/reseller-bots.js';
export * from './schema/data-export.js';
export * from './schema/reseller-web.js';
export * from './schema/reseller-web-selling.js';
export * from './schema/registry.js';
