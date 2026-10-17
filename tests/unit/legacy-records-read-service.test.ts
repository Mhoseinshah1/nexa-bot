import { describe, expect, it } from 'vitest';
import { errors, LEGACY_SERVICE_RECORDS_MAX } from '@nexa/contracts';
import { LegacyRecordsReadService } from '../../apps/api/src/modules/platform/legacy-history/application/legacy-records-read.service';
import type {
  LegacyHistoryRecordRow,
  LegacyRecordsRepository,
} from '../../apps/api/src/modules/platform/legacy-history/application/ports';

/**
 * The tenant-wide Mirza records service: permission denied path, id-keyset pagination, the
 * type / linked filters, the service section's invoice lookup, and the redaction + audit of a
 * PII reader. The repository and guard are in-memory; SQL is covered by the integrator's
 * integration run.
 */

const scope = { tenantId: 't1', botInstanceId: null } as never;
const actor = { type: 'ADMIN' } as never;

const row = (n: number, over: Partial<LegacyHistoryRecordRow> = {}): LegacyHistoryRecordRow => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  nxpkgImportId: 'imp',
  packageImportId: 'pkg',
  recordType: 'configuration_row',
  idempotencyKey: `legacy:${n}`,
  legacyUserId: '555',
  customerId: null,
  occurredAt: null,
  payload: { class: 'SETTING', secret_text: 'free text' },
  createdAt: new Date(0),
  ...over,
});

function setup(held: readonly string[], rows: readonly LegacyHistoryRecordRow[] = []) {
  const seen: { filter?: unknown; limit?: number; keys?: readonly string[] } = {};
  const audits: unknown[] = [];
  const repository: LegacyRecordsRepository = {
    countsByType: async () => [
      { type: 'configuration_row', records: 141, unlinked: 141 },
      { type: 'service_operation', records: 10, unlinked: 2 },
      { type: 'not_a_known_type', records: 99, unlinked: 99 },
    ],
    inactivePanels: async () => [
      { code: 'p999', name: 'x', panelType: 'MARZBAN', status: 'DISABLED' },
    ],
    listRecords: async (_s, filter, limit) => {
      seen.filter = filter;
      seen.limit = limit;
      return rows.slice(0, limit);
    },
    invoiceKeysOfService: async (_s, id) => (id === 'adopted' ? ['k1'] : []),
    recordsOfInvoices: async (_s, keys, limit) => {
      seen.keys = keys;
      seen.limit = limit;
      return rows.slice(0, limit);
    },
  };
  const guard = {
    check: async (_s: unknown, _a: unknown, permission: string) => {
      if (!held.includes(permission)) {
        throw errors.permissionDenied('platform.permission_denied', 'no', { permission });
      }
    },
    permissionsOf: async () => new Set(held),
  };
  const audit = {
    record: async (_s: unknown, _a: unknown, entry: unknown) => void audits.push(entry),
  };
  const service = new LegacyRecordsReadService({
    repository,
    guard: guard as never,
    audit: audit as never,
  });
  return { service, seen, audits };
}

describe('LegacyRecordsReadService', () => {
  it('refuses every read without legacy.history.view', async () => {
    const { service } = setup(['services.view']);
    await expect(service.summary(scope, actor)).rejects.toMatchObject({
      kind: 'PERMISSION_DENIED',
    });
    await expect(service.list(scope, actor, {})).rejects.toMatchObject({
      kind: 'PERMISSION_DENIED',
    });
    await expect(service.forService(scope, actor, 'adopted')).rejects.toMatchObject({
      kind: 'PERMISSION_DENIED',
    });
  });

  it('the service section also needs services.view', async () => {
    const { service } = setup(['legacy.history.view']);
    await expect(service.forService(scope, actor, 'adopted')).rejects.toMatchObject({
      kind: 'PERMISSION_DENIED',
    });
  });

  it('summarises known types only, with totals and unlinked counts', async () => {
    const { service } = setup(['legacy.history.view']);
    const summary = await service.summary(scope, actor);
    expect(summary.byType.map((r) => r.recordType)).toEqual([
      'service_operation',
      'configuration_row',
    ]);
    expect(summary.records).toBe(151);
    expect(summary.unlinked).toBe(143);
    expect(summary.inactivePanels).toHaveLength(1);
    // Free text: withheld without legacy.invoices.pii.view, shown with it.
    expect(summary.inactivePanels[0]?.name).toBeNull();
    expect(summary.inactivePanels[0]?.code).toBe('p999');
    const withPii = await setup([
      'legacy.history.view',
      'legacy.invoices.pii.view',
    ]).service.summary(scope, actor);
    expect(withPii.inactivePanels[0]?.name).toBe('x');
  });

  it('pages by id: asks for one more row and returns the last shown id as the cursor', async () => {
    const rows = [row(1), row(2), row(3)];
    const { service, seen } = setup(['legacy.history.view'], rows);
    const page = await service.list(scope, actor, {
      limit: 2,
      type: 'configuration_row',
      linked: 'no',
    });
    expect(seen.limit).toBe(3);
    expect(seen.filter).toEqual({ type: 'configuration_row', linked: false, after: null });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBe(rows[1]!.id);
    const last = await service.list(scope, actor, { limit: 3, after: rows[1]!.id });
    expect(last.nextCursor).toBeNull();
    expect(seen.filter).toEqual({ type: null, linked: null, after: rows[1]!.id });
  });

  it('without the PII key reduces payloads and does not audit; with it audits ids only', async () => {
    const rows = [row(1)];
    const plain = setup(['legacy.history.view'], rows);
    const redacted = await plain.service.list(scope, actor, {});
    expect(redacted.piiRedacted).toBe(true);
    expect(redacted.items[0]!.legacyUserId).toBeNull();
    expect(JSON.stringify(redacted.items[0]!.payload)).not.toContain('free text');
    expect(plain.audits).toEqual([]);

    const pii = setup(['legacy.history.view', 'legacy.invoices.pii.view'], rows);
    const full = await pii.service.list(scope, actor, {});
    expect(full.piiRedacted).toBe(false);
    expect(full.items[0]!.legacyUserId).toBe('555');
    expect(pii.audits).toHaveLength(1);
    expect(JSON.stringify(pii.audits)).not.toContain('555');
  });

  it('a service adopted from Mirza reads its invoice key; one that was not has nothing', async () => {
    const rows = [row(1, { recordType: 'service_operation', customerId: 'c1' })];
    const { service, seen } = setup(['legacy.history.view', 'services.view'], rows);
    const adopted = await service.forService(scope, actor, 'adopted');
    expect(adopted.invoiceKeys).toEqual(['k1']);
    expect(seen.keys).toEqual(['k1']);
    expect(seen.limit).toBe(LEGACY_SERVICE_RECORDS_MAX + 1);
    expect(adopted.items[0]!.customerLinked).toBe(true);
    expect(adopted.truncated).toBe(false);
    const none = await service.forService(scope, actor, 'other');
    expect(none.invoiceKeys).toEqual([]);
  });

  it('flags truncation when more than the maximum exist', async () => {
    const rows = Array.from({ length: LEGACY_SERVICE_RECORDS_MAX + 1 }, (_, i) =>
      row(i + 1, { recordType: 'service_operation' }),
    );
    const { service } = setup(['legacy.history.view', 'services.view'], rows);
    const history = await service.forService(scope, actor, 'adopted');
    expect(history.items).toHaveLength(LEGACY_SERVICE_RECORDS_MAX);
    expect(history.truncated).toBe(true);
  });
});
