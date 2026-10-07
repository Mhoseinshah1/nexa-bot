import { describe, expect, it } from 'vitest';
import {
  LEGACY_INVOICE_ARCHIVE_CLASSES,
  LEGACY_INVOICE_PII_COLUMNS,
  type LegacyInvoiceArchiveClass,
} from '@nexa/contracts';
import {
  INVOICE_ARCHIVE_CLASS_IMPORTER_CATEGORY,
  classifyLegacyInvoice,
  decideRevision,
  invoiceArchiveChecksum,
  invoiceRowChecksum,
  legacyTestFlag,
  normaliseLegacyInvoice,
  parseLegacyInvoicePrice,
  parseLegacyTimeSell,
  redactInvoiceRow,
  unrepresentableColumn,
} from '../../apps/api/src/modules/platform/legacy-invoice-archive/domain/invoice-archive-row';
import { decideServiceCandidate } from '../../apps/api/src/modules/platform/legacy-importer/application/decisions';
import { LEGACY_LIVE_STATUSES } from '../../apps/api/src/modules/platform/legacy-importer/application/source-port';
import { buildSyntheticLegacyDataset } from '../fixtures/legacy/synthetic-legacy';

/**
 * Mirza migration PR3 — the archive's pure rules: classification, normalisation, checksums,
 * the revision decision and redaction. SYNTHETIC inputs only; no count here is a real-data
 * expectation.
 */

const ctx = (ownerPresent = true, productInTable = false) => ({ ownerPresent, productInTable });
const row = (fields: Record<string, string | null> = {}) => ({
  id_invoice: 'a1b2c3d4',
  id_user: '100000001',
  username: 'svc_a1',
  Status: 'active',
  is_test: '0',
  code_panel: 'rp1',
  code_product: null,
  Volume: '30',
  Service_time: '30',
  time_unit: '',
  is_custom: '0',
  price_product: '150000',
  time_sell: '1700000000',
  ...fields,
});

describe('the source-derived class', () => {
  it('decides in a fixed order, first match wins', () => {
    const base = {
      keyShapeEvidenced: true,
      isTest: false as boolean | null,
      ownerPresent: true,
      live: true,
      panelCode: 'rp1' as string | null,
    };
    expect(classifyLegacyInvoice(base)).toBe('LIVE_CANDIDATE');
    expect(classifyLegacyInvoice({ ...base, panelCode: null })).toBe('NO_PANEL');
    expect(classifyLegacyInvoice({ ...base, live: false, panelCode: null })).toBe('NOT_LIVE');
    expect(classifyLegacyInvoice({ ...base, ownerPresent: false, live: false })).toBe(
      'ORPHAN_OWNER',
    );
    expect(classifyLegacyInvoice({ ...base, isTest: null, ownerPresent: false })).toBe(
      'TEST_FLAG_INVALID',
    );
    expect(classifyLegacyInvoice({ ...base, isTest: true, ownerPresent: false })).toBe('TEST');
    expect(classifyLegacyInvoice({ ...base, keyShapeEvidenced: false, isTest: true })).toBe(
      'KEY_SHAPE_UNRECOGNISED',
    );
  });

  it("agrees with the importer's own source-only steps for every live synthetic invoice", () => {
    // Every live invoice of both datasets: the four classes the importer decides from the
    // source alone must be EXACTLY its categories, in its order — and no other class may be.
    for (const dataset of [
      buildSyntheticLegacyDataset(),
      buildSyntheticLegacyDataset({ invoiceArchive: 'A' }),
    ]) {
      const userIds = new Set(dataset.tables.user.map((u) => u['id'] as string));
      const live: ReadonlySet<string> = new Set(LEGACY_LIVE_STATUSES);
      const prefix = new Set(
        Object.values(INVOICE_ARCHIVE_CLASS_IMPORTER_CATEGORY).filter((v) => v !== null),
      );
      let checked = 0;
      for (const invoice of dataset.tables.invoice) {
        if (!live.has(invoice['Status'] ?? '')) continue;
        checked += 1;
        const ours = normaliseLegacyInvoice(invoice, {
          ownerPresent: invoice['id_user'] != null && userIds.has(invoice['id_user']),
          productInTable: false,
        }).classification;
        const theirs = decideServiceCandidate(
          {
            idInvoice: invoice['id_invoice'] as string,
            idUser: invoice['id_user'] ?? null,
            username: invoice['username'] ?? null,
            isTest: invoice['is_test'] ?? null,
            codePanel: invoice['code_panel'] ?? null,
            codeProduct: invoice['code_product'] ?? null,
            volume: invoice['Volume'] ?? null,
            serviceTime: invoice['Service_time'] ?? null,
            timeUnit: invoice['time_unit'] ?? null,
            isCustom: invoice['is_custom'] ?? null,
          },
          {
            userIds,
            importedUsers: new Map([...userIds].map((id) => [id, id])),
            policy: {
              knownPanels: new Map(),
              testPanels: new Set(),
              missingPanels: new Set(),
              productionPanelIds: [],
            },
            inventories: new Map(),
            productCodes: new Set(),
            productMap: new Map(),
            tariffOf: () => 'UNRESOLVED',
          },
        ).category;
        const mapped = INVOICE_ARCHIVE_CLASS_IMPORTER_CATEGORY[ours];
        if (mapped !== null) expect(theirs, invoice['id_invoice'] ?? '').toBe(mapped);
        else expect(prefix.has(theirs), `${invoice['id_invoice'] ?? ''}: ${theirs}`).toBe(false);
      }
      expect(checked).toBeGreaterThan(10);
    }
  });

  it('archives every class the synthetic archive variant is built to reach', () => {
    const dataset = buildSyntheticLegacyDataset({ invoiceArchive: 'A' });
    const userIds = new Set(dataset.tables.user.map((u) => u['id'] as string));
    const seen = new Set<LegacyInvoiceArchiveClass>();
    for (const invoice of dataset.tables.invoice) {
      seen.add(
        normaliseLegacyInvoice(invoice, {
          ownerPresent: invoice['id_user'] != null && userIds.has(invoice['id_user']),
          productInTable: false,
        }).classification,
      );
    }
    expect([...seen].sort()).toEqual([...LEGACY_INVOICE_ARCHIVE_CLASSES].sort());
  });
});

describe('normalisation', () => {
  it('keeps the raw cells and reads each field by one rule', () => {
    const n = normaliseLegacyInvoice(
      row({ code_panel: '  rp1 ', code_product: ' p1 ', is_test: ' 0 ' }),
      ctx(true, true),
    );
    expect(n).toMatchObject({
      invoiceKey: 'a1b2c3d4',
      keyShapeEvidenced: true,
      live: true,
      status: 'active',
      isTest: false,
      legacyUserId: '100000001',
      username: 'svc_a1',
      panelCode: 'rp1',
      productCode: 'p1',
      productRef: 'NAMED',
      priceRaw: '150000',
      priceMinor: 150000n,
      priceCurrency: 'IRT',
      priceNote: null,
      soldAtRaw: '1700000000',
      soldAtEpochSeconds: 1_700_000_000,
      soldAtNote: null,
      classification: 'LIVE_CANDIDATE',
    });
    expect(normaliseLegacyInvoice(row({ code_product: 'p404' }), ctx()).productRef).toBe(
      'NOT_IN_PRODUCT_TABLE',
    );
    expect(normaliseLegacyInvoice(row({ code_product: '  ' }), ctx(true, true)).productRef).toBe(
      'NONE',
    );
  });

  it('compares statuses exactly, as the importer does', () => {
    for (const status of LEGACY_LIVE_STATUSES) {
      expect(normaliseLegacyInvoice(row({ Status: status }), ctx()).live).toBe(true);
    }
    for (const status of ['Active', ' active', 'end_of_time', 'removed', '', null]) {
      expect(normaliseLegacyInvoice(row({ Status: status }), ctx()).live, String(status)).toBe(
        false,
      );
    }
  });

  it('reads is_test as 1 / 0 only', () => {
    expect(legacyTestFlag('1')).toBe(true);
    expect(legacyTestFlag(' 0')).toBe(false);
    for (const value of ['x', '', '2', 'true', null, undefined]) {
      expect(legacyTestFlag(value), String(value)).toBeNull();
    }
  });

  it('reads a price as whole Toman only, and never guesses', () => {
    expect(parseLegacyInvoicePrice('0')).toEqual({ value: 0n, note: null });
    expect(parseLegacyInvoicePrice(' 150000 ')).toEqual({ value: 150000n, note: null });
    expect(parseLegacyInvoicePrice(undefined)).toEqual({ value: null, note: 'ABSENT' });
    for (const empty of [null, '', '  ']) {
      expect(parseLegacyInvoicePrice(empty)).toEqual({ value: null, note: 'EMPTY' });
    }
    for (const odd of ['150,000', '۱۵۰۰۰۰', '-5', '1e5', '10.5', 'free']) {
      expect(parseLegacyInvoicePrice(odd), odd).toEqual({ value: null, note: 'NOT_A_NUMBER' });
    }
    expect(parseLegacyInvoicePrice('9999999999999999999')).toEqual({
      value: null,
      note: 'OUT_OF_RANGE',
    });
  });

  it('reads time_sell as unix seconds only; any other format stays raw', () => {
    expect(parseLegacyTimeSell('1700000000')).toEqual({ value: 1_700_000_000, note: null });
    expect(parseLegacyTimeSell(undefined)).toEqual({ value: null, note: 'ABSENT' });
    expect(parseLegacyTimeSell('')).toEqual({ value: null, note: 'EMPTY' });
    for (const odd of ['2024-01-02 03:04:05', '2024-01-02T03:04:05Z', '1403/01/01', '17e8']) {
      expect(parseLegacyTimeSell(odd), odd).toEqual({ value: null, note: 'FORMAT_UNKNOWN' });
    }
    // A Jalali date as digits, milliseconds, before 2015, and 2100 itself are never instants.
    for (const odd of ['14030101', '1700000000000', '1400000000', '4102444800']) {
      expect(parseLegacyTimeSell(odd), odd).toEqual({ value: null, note: 'OUT_OF_RANGE' });
    }
    expect(parseLegacyTimeSell('4102444799')).toEqual({ value: 4_102_444_799, note: null });
  });

  it('keeps an id outside the evidenced shape, flagged', () => {
    for (const id of ['INV/2024/001', 'ABCD', 'فاکتور-۱', ' padded ', '', 'LEGACY-X1']) {
      const n = normaliseLegacyInvoice(row({ id_invoice: id }), ctx());
      expect(n.invoiceKey).toBe(id);
      expect(n.keyShapeEvidenced, id).toBe(false);
      expect(n.classification).toBe('KEY_SHAPE_UNRECOGNISED');
    }
    for (const id of ['0000', '7c1f', 'a0000001', '1700001b2c3d4e5']) {
      expect(normaliseLegacyInvoice(row({ id_invoice: id }), ctx()).keyShapeEvidenced, id).toBe(
        true,
      );
    }
  });

  it('refuses what PostgreSQL cannot hold verbatim, by column name', () => {
    expect(unrepresentableColumn(row())).toBeNull();
    expect(unrepresentableColumn(row({ note: 'a\u0000b' }))).toBe('note');
    expect(unrepresentableColumn(row({ username: 'x'.repeat(1001) }))).toBe('username');
    expect(unrepresentableColumn(row({ username: 'x'.repeat(1000) }))).toBeNull();
    // An unindexed cell may be long: it lives only in the raw row.
    expect(unrepresentableColumn(row({ note: 'x'.repeat(5000) }))).toBeNull();
  });
});

describe('checksums and revisions', () => {
  it('a row checksum is over the cells, whatever their order, and changes with any cell', () => {
    const a = row();
    const reordered = Object.fromEntries(Object.entries(a).reverse());
    expect(invoiceRowChecksum(reordered)).toBe(invoiceRowChecksum(a));
    for (const key of Object.keys(a)) {
      expect(invoiceRowChecksum({ ...a, [key]: 'changed' }), key).not.toBe(invoiceRowChecksum(a));
    }
    // NULL and '' are different facts.
    expect(invoiceRowChecksum({ ...a, code_product: '' })).not.toBe(invoiceRowChecksum(a));
  });

  it('the archive checksum also carries the source-derived context', () => {
    const sum = invoiceRowChecksum(row());
    expect(invoiceArchiveChecksum(sum, ctx(true), 'NONE')).not.toBe(
      invoiceArchiveChecksum(sum, ctx(false), 'NONE'),
    );
    expect(invoiceArchiveChecksum(sum, ctx(true), 'NAMED')).not.toBe(
      invoiceArchiveChecksum(sum, ctx(true), 'NOT_IN_PRODUCT_TABLE'),
    );
  });

  it('appends a revision only when something changed, never rewrites one', () => {
    const first = normaliseLegacyInvoice(row(), ctx());
    expect(decideRevision(null, first)).toEqual({
      kind: 'APPEND',
      revision: 1,
      reason: 'FIRST_SEEN',
    });
    const latest = {
      revision: 3,
      rowChecksum: first.rowChecksum,
      archiveChecksum: first.archiveChecksum,
    };
    expect(decideRevision(latest, first)).toEqual({ kind: 'UNCHANGED' });
    const changed = normaliseLegacyInvoice(row({ Status: 'disabled' }), ctx());
    expect(decideRevision(latest, changed)).toEqual({
      kind: 'APPEND',
      revision: 4,
      reason: 'ROW_CHANGED',
    });
    const owned = normaliseLegacyInvoice(row(), ctx(false));
    expect(decideRevision(latest, owned)).toEqual({
      kind: 'APPEND',
      revision: 4,
      reason: 'CONTEXT_CHANGED',
    });
  });
});

describe('redaction', () => {
  it('nulls exactly the personal cells and names them', () => {
    const { raw, redacted } = redactInvoiceRow(
      { ...row(), note: 'my config', refral: '100000002' },
      LEGACY_INVOICE_PII_COLUMNS,
    );
    expect(redacted).toEqual(['id_user', 'note', 'refral', 'username']);
    expect(raw).toMatchObject({ id_user: null, username: null, note: null, refral: null });
    expect(raw['id_invoice']).toBe('a1b2c3d4');
    expect(raw['price_product']).toBe('150000');
  });
});
