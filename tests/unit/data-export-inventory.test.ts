import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from '../../apps/api/src/infrastructure/persistence/schema';
import {
  DATA_EXPORT_DATASETS,
  DATA_EXPORT_FILES,
  SECRET_LOOKING,
  SECRET_LOOKING_ALLOWED,
  WALLET_BALANCES_DATASET,
  type ExportDataset,
} from '../../apps/api/src/modules/platform/data-export/application/data-export-inventory';
import { tenantArchiveClassOf } from '../../apps/api/src/modules/platform/backup/application/tenant-archive-inventory';

/**
 * Phase 6B PR-3 (ADR-0039, the open data export): the export's column inventory, held to the
 * schema.
 *
 * The export is an allow-list: it selects only the columns this inventory exports. These
 * tests make the inventory complete and safe BEFORE a file exists: every column of every
 * exported table is decided (exported or excluded with a reason), and an exported column
 * whose name reads as a secret — a hash, a token, a key, a credential, a bearer link — fails
 * the build unless it is allowed by name with a reason. Each rule has its falsification
 * beside it: the same check run on a schema with one more column must fail.
 */

function schemaColumns(table: string): string[] {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable) && getTableConfig(value).name === table) {
      return getTableConfig(value).columns.map((column) => column.name);
    }
  }
  throw new Error(`no such table: ${table}`);
}

/** The problems of `datasets` against `columnsOf` — empty when the inventory is sound. */
function problems(
  datasets: readonly ExportDataset[],
  columnsOf: (table: string) => readonly string[],
): string[] {
  const out: string[] = [];
  for (const dataset of datasets) {
    const live = columnsOf(dataset.table);
    const exported = dataset.columns.map((column) => column.name);
    const excluded = Object.keys(dataset.excluded);
    for (const name of live) {
      const inExported = exported.includes(name);
      const inExcluded = excluded.includes(name);
      if (!inExported && !inExcluded) {
        out.push(`${dataset.table}.${name} is neither exported nor excluded`);
      }
      if (inExported && inExcluded) out.push(`${dataset.table}.${name} is both`);
    }
    for (const name of [...exported, ...excluded]) {
      if (!live.includes(name)) out.push(`${dataset.table}.${name} is not a column of the table`);
    }
    for (const name of exported) {
      if (
        SECRET_LOOKING.test(name) &&
        SECRET_LOOKING_ALLOWED[`${dataset.table}.${name}`] === undefined
      ) {
        out.push(`${dataset.table}.${name} is exported and looks like a secret`);
      }
    }
    if (new Set(exported).size !== exported.length) out.push(`${dataset.table} repeats a column`);
    for (const [name, reason] of Object.entries(dataset.excluded)) {
      if (reason.trim().length < 10) out.push(`${dataset.table}.${name} has no reason`);
    }
    if (dataset.columns.some((column) => column.description.trim() === '')) {
      out.push(`${dataset.table} has an undescribed column`);
    }
  }
  return out;
}

describe('the data export inventory', () => {
  it('decides every column of every exported table, and exports no secret-looking one', () => {
    expect(problems(DATA_EXPORT_DATASETS, schemaColumns)).toEqual([]);
  });

  it('reads only TENANT tables of the tenant archive, each once, with a file each', () => {
    const tables = DATA_EXPORT_DATASETS.map((dataset) => dataset.table);
    expect(new Set(tables).size).toBe(tables.length);
    for (const table of tables) expect(tenantArchiveClassOf(table), table).toBe('TENANT');
    expect(new Set(DATA_EXPORT_FILES).size).toBe(DATA_EXPORT_FILES.length);
    expect(DATA_EXPORT_FILES).toContain(WALLET_BALANCES_DATASET.file);
  });

  it('covers what the owner asked for: customers, wallets and ledger, orders, services, payments, products, resellers, tickets, messages', () => {
    for (const file of [
      'customers.csv',
      'wallet_ledger.csv',
      'wallet_balances.csv',
      'orders.csv',
      'services.csv',
      'payments.csv',
      'products.csv',
      'resellers.csv',
      'tickets.csv',
      'ticket_messages.csv',
    ]) {
      expect(DATA_EXPORT_FILES).toContain(file);
    }
  });

  it('never exports the credentials the owner named: bearer links, panel client ids, file handles, keys', () => {
    const exported = new Set(
      DATA_EXPORT_DATASETS.flatMap((dataset) =>
        dataset.columns.map((column) => `${dataset.table}.${column.name}`),
      ),
    );
    for (const name of [
      'services.subscription_url',
      'services.subscription_ref',
      'services.provider_client_id',
      'ticket_messages.attachment_file_id',
      'ticket_messages.idempotency_key',
      'ticket_messages.request_hash',
      'customers.phone_resume',
    ]) {
      expect(exported.has(name), name).toBe(false);
    }
  });

  it('prints money as exact minor units beside a currency column', () => {
    for (const dataset of DATA_EXPORT_DATASETS) {
      const money = dataset.columns.filter((column) => column.kind === 'money_minor');
      if (money.length === 0) continue;
      expect(
        dataset.columns.some((column) => /currency$/.test(column.name)),
        `${dataset.table} has money but no currency column`,
      ).toBe(true);
    }
  });

  // ---- falsification: the same check on a schema with one more column --------------------

  it('FAILS when a new column appears in an exported table and is not decided', () => {
    const found = problems(DATA_EXPORT_DATASETS, (table) =>
      table === 'customers' ? [...schemaColumns(table), 'loyalty_points'] : schemaColumns(table),
    );
    expect(found).toEqual(['customers.loyalty_points is neither exported nor excluded']);
  });

  it('FAILS when a new secret-looking column is exported instead of excluded', () => {
    for (const name of [
      'api_token',
      'login_password_hash',
      'webhook_secret',
      'recovery_codes',
      'card_cipher',
    ]) {
      const mutated = DATA_EXPORT_DATASETS.map((dataset) =>
        dataset.table === 'customers'
          ? {
              ...dataset,
              columns: [...dataset.columns, { name, kind: 'text' as const, description: 'x' }],
            }
          : dataset,
      );
      const found = problems(mutated, (table) =>
        table === 'customers' ? [...schemaColumns(table), name] : schemaColumns(table),
      );
      expect(found, name).toEqual([`customers.${name} is exported and looks like a secret`]);
    }
  });

  it('PASSES a new secret-looking column once it is excluded with a reason', () => {
    const mutated = DATA_EXPORT_DATASETS.map((dataset) =>
      dataset.table === 'customers'
        ? { ...dataset, excluded: { ...dataset.excluded, api_token: 'a bearer token of the API' } }
        : dataset,
    );
    expect(
      problems(mutated, (table) =>
        table === 'customers' ? [...schemaColumns(table), 'api_token'] : schemaColumns(table),
      ),
    ).toEqual([]);
  });

  it('FAILS when the secret test is weakened (the pattern matches nothing)', () => {
    // The pattern itself is under test: every secret-looking name below must match it.
    for (const name of [
      'password_hash',
      'secret_ciphertext',
      'api_key',
      'totp_secret',
      'subscription_url',
      'bot_token',
      'provider_client_id',
    ]) {
      expect(SECRET_LOOKING.test(name), name).toBe(true);
    }
    for (const name of ['first_name', 'amount', 'currency', 'telegram_user_id', 'source_ref']) {
      expect(SECRET_LOOKING.test(name), name).toBe(false);
    }
  });
});
