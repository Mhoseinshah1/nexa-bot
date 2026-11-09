/**
 * Database schema — hosted-bot backups (Phase 6B PR-2, ADR-0039 § 7).
 *
 * One part of `../schema.ts`, which re-exports every part; import from there. Its own file so
 * the concurrent hosting PRs of the phase do not edit one another's tables.
 */
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { HOSTED_BACKUP_KEEP_MAX, HOSTED_BACKUP_KEEP_MIN } from '@nexa/contracts';
import { timestamptz } from './_shared.js';
import { tenants } from './tenancy.js';

/**
 * One hosted bot's backup policy: the owner's schedule (on/off, a daily time in the
 * installation's zone, keep N) and the password that seals its archives.
 *
 * OWNED BY THE INSTALLATION TENANT (`tenant_id`), like the register: the owner sets every
 * hosted bot's password himself (binding decision), so it lives in his scope, where row-level
 * security keeps it from the hosted owner — never in the hosted tenant's own
 * `backup_archive_passwords`, which the hosted owner's backup page writes. The password is a
 * `hosting.archive_password` ciphertext (entity = this row's id), set together with its key id
 * and the time it was set, or all three NULL: a bot with no password takes no archive.
 *
 * No row = the defaults (on, 04:30, keep 7) and no password. `run_requested_at` is «بکاپ الان»:
 * the worker takes it through the heavy-job queue like a scheduled run, and clears it.
 */
export const hostedBotBackupPolicies = pgTable(
  'hosted_bot_backup_policies',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    hostedTenantId: uuid('hosted_tenant_id')
      .notNull()
      .references(() => tenants.id),
    enabled: boolean('enabled').notNull(),
    dailyTime: text('daily_time').notNull(),
    keep: integer('keep').notNull(),
    passwordCiphertext: text('password_ciphertext'),
    passwordKeyId: text('password_key_id'),
    passwordSetAt: timestamptz('password_set_at'),
    runRequestedAt: timestamptz('run_requested_at'),
    createdAt: timestamptz('created_at').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('hosted_bot_backup_policies_hosted_key').on(table.tenantId, table.hostedTenantId),
    index('hosted_bot_backup_policies_tenant_idx').on(table.tenantId, table.updatedAt),
    check('hosted_bot_backup_policies_not_self_check', sql`tenant_id <> hosted_tenant_id`),
    check(
      'hosted_bot_backup_policies_time_check',
      sql`daily_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`,
    ),
    check(
      'hosted_bot_backup_policies_keep_check',
      sql`keep BETWEEN ${sql.raw(String(HOSTED_BACKUP_KEEP_MIN))} AND ${sql.raw(String(HOSTED_BACKUP_KEEP_MAX))}`,
    ),
    check(
      'hosted_bot_backup_policies_password_check',
      sql`(password_ciphertext IS NULL) = (password_key_id IS NULL) AND (password_ciphertext IS NULL) = (password_set_at IS NULL)`,
    ),
  ],
);
