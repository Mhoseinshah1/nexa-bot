import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from '../../apps/api/src/infrastructure/persistence/schema';
import {
  GLOBAL_UNIQUE_KEYS,
  INSTALLATION_TABLES,
  NEVER_TABLES,
  TENANT_KEYED_OTHERWISE,
  TENANT_TABLES,
  tenantArchiveClassOf,
} from '../../apps/api/src/modules/platform/backup/application/tenant-archive-inventory';

/**
 * Phase 6B (ADR-0039 § 1): every table is classified for the tenant archive, from the schema.
 *
 * Read from the Drizzle tables themselves (`getTableConfig`, the library's public reader),
 * so a `pgTable` added anywhere under `schema/` is seen without anyone listing it. Each rule
 * has its falsification beside it: the same check run on a schema with one more table, column
 * or key must fail.
 */

interface TableFacts {
  readonly name: string;
  readonly columns: readonly string[];
  readonly foreignKeys: readonly string[];
  readonly uniqueKeys: readonly { readonly name: string; readonly columns: readonly string[] }[];
}

function schemaTables(): TableFacts[] {
  const out: TableFacts[] = [];
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const config = getTableConfig(value);
    out.push({
      name: config.name,
      columns: config.columns.map((column) => column.name),
      foreignKeys: config.foreignKeys.map((fk) => getTableConfig(fk.reference().foreignTable).name),
      uniqueKeys: config.indexes
        .filter((index) => index.config.unique)
        .map((index) => ({
          name: index.config.name ?? '',
          columns: index.config.columns.map((column) =>
            'name' in column && typeof column.name === 'string' ? column.name : '<expression>',
          ),
        })),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const tables = schemaTables();

function unclassified(names: readonly string[]): string[] {
  return names.filter((name) => tenantArchiveClassOf(name) === null);
}

describe('the tenant archive inventory', () => {
  it('reads a real schema', () => {
    expect(tables.length).toBeGreaterThan(220);
    expect(tables.some((table) => table.name === 'wallet_entries')).toBe(true);
  });

  it('classifies every table in the schema', () => {
    expect(unclassified(tables.map((table) => table.name))).toEqual([]);
  });

  it('fails when a table is added without a class', () => {
    expect(unclassified([...tables.map((table) => table.name), 'hosted_bot_new_thing'])).toEqual([
      'hosted_bot_new_thing',
    ]);
  });

  it('names no table the schema does not have, and none twice', () => {
    const real = new Set(tables.map((table) => table.name));
    const named = [
      ...TENANT_TABLES,
      ...Object.keys(TENANT_KEYED_OTHERWISE),
      ...Object.keys(INSTALLATION_TABLES),
      ...Object.keys(NEVER_TABLES),
    ];
    expect(named.filter((name) => !real.has(name))).toEqual([]);
    expect(named.length).toBe(new Set(named).size);
    expect(named.length).toBe(real.size);
  });

  it('selects by tenant_id exactly the TENANT tables that have one', () => {
    const byTenantId = new Set(TENANT_TABLES);
    const wrong = tables
      .filter((table) => tenantArchiveClassOf(table.name) === 'TENANT')
      .filter((table) => table.columns.includes('tenant_id') !== byTenantId.has(table.name))
      .map((table) => table.name);
    expect(wrong).toEqual([]);
    // The tenant-keyed count: every table carrying tenant_id, plus `tenants` itself.
    const withTenantId = tables.filter((table) => table.columns.includes('tenant_id')).length;
    const keyed = tables.filter(
      (table) => table.columns.includes('tenant_id') || table.name === 'tenants',
    ).length;
    expect(keyed).toBe(withTenantId + 1);
    // The tables with no tenant at all are exactly the five installation ones and the two
    // the archive selects by a join.
    expect(
      tables
        .filter((table) => !table.columns.includes('tenant_id') && table.name !== 'tenants')
        .map((table) => table.name),
    ).toEqual([
      'aggregate_sequences',
      'backup_run_parts',
      'backup_runs',
      'installation_keys',
      'process_runs',
      'processed_messages',
    ]);
  });

  it('keeps the foreign-key graph among TENANT tables acyclic apart from self-references', () => {
    const tenant = tables.filter((table) => tenantArchiveClassOf(table.name) === 'TENANT');
    const edges = new Map<string, string[]>();
    for (const table of tenant) {
      edges.set(
        table.name,
        table.foreignKeys.filter(
          (target) => target !== table.name && tenantArchiveClassOf(target) === 'TENANT',
        ),
      );
    }
    expect(findCycle(edges)).toBeNull();
    // Falsified: one back edge makes a cycle.
    const withCycle = new Map(edges);
    withCycle.set('tenants', [...(edges.get('tenants') ?? []), 'customers']);
    expect(findCycle(withCycle)).not.toBeNull();
  });

  it('no TENANT table references an INSTALLATION or NEVER table', () => {
    const crossing = tables
      .filter((table) => tenantArchiveClassOf(table.name) === 'TENANT')
      .flatMap((table) =>
        table.foreignKeys
          .filter((target) => tenantArchiveClassOf(target) !== 'TENANT')
          .map((target) => `${table.name} -> ${target}`),
      );
    expect(crossing).toEqual([]);
  });

  it('lists every unique key of a TENANT table that does not include tenant_id', () => {
    const listed = new Set(GLOBAL_UNIQUE_KEYS.map((key) => key.index));
    const found = globalKeys(tables);
    expect(found.filter((key) => !listed.has(key)).sort()).toEqual([]);
    expect([...listed].filter((key) => !found.includes(key)).sort()).toEqual([]);
    // Falsified: a new global key on a TENANT table is not on the list.
    const withAnother = tables.map((table) =>
      table.name === 'customers'
        ? {
            ...table,
            uniqueKeys: [...table.uniqueKeys, { name: 'customers_phone_key', columns: ['phone'] }],
          }
        : table,
    );
    expect(globalKeys(withAnother).filter((key) => !listed.has(key))).toEqual([
      'customers_phone_key',
    ]);
  });
});

function globalKeys(of: readonly TableFacts[]): string[] {
  return of
    .filter((table) => tenantArchiveClassOf(table.name) === 'TENANT')
    .flatMap((table) =>
      table.uniqueKeys.filter((key) => !key.columns.includes('tenant_id')).map((key) => key.name),
    );
}

function findCycle(edges: ReadonlyMap<string, readonly string[]>): string[] | null {
  const state = new Map<string, 'OPEN' | 'DONE'>();
  const path: string[] = [];
  const visit = (node: string): string[] | null => {
    if (state.get(node) === 'DONE') return null;
    if (state.get(node) === 'OPEN') return [...path.slice(path.indexOf(node)), node];
    state.set(node, 'OPEN');
    path.push(node);
    for (const next of edges.get(node) ?? []) {
      const cycle = visit(next);
      if (cycle !== null) return cycle;
    }
    path.pop();
    state.set(node, 'DONE');
    return null;
  };
  for (const node of edges.keys()) {
    const cycle = visit(node);
    if (cycle !== null) return cycle;
  }
  return null;
}
