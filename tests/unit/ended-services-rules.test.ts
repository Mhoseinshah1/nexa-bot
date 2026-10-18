import { describe, expect, it } from 'vitest';
import {
  ENDED_SERVICE_GAP_REASONS,
  NEVER_PAID_AMOUNT_BUCKET,
  NEVER_PAID_ORDER_GAP_REASONS,
  endedServiceUsername,
  fateOfInvoice,
  invoiceSourceRef,
  neverPaidOrderState,
  neverPaidSourceRef,
  shapeKeyOfCells,
  type ArchivedInvoice,
  type InvoiceMapFact,
} from '../../apps/api/src/modules/platform/legacy-materialize/application/ended-services.rules';
import {
  lineTitleOf,
  sameAsCarried,
  sameAsCarriedNeverPaid,
} from '../../apps/api/src/modules/platform/legacy-materialize/application/terminated-services.step';
import { LEGACY_NEVER_PAID_STATUSES } from '../../apps/api/src/modules/platform/legacy-importer/application/source-port';
import type {
  CarriedInvoice,
  EndedInvoiceInsert,
  NeverPaidOrderInsert,
} from '../../apps/api/src/modules/platform/legacy-materialize/application/ended-services.ports';

/**
 * The fate of every archived Mirza invoice (owner decision 2026-10-17): adopted by the
 * importer, ended (TERMINATED), or a counted gap — and never a silent drop.
 */
const invoice = (over: Partial<ArchivedInvoice> = {}): ArchivedInvoice => ({
  invoiceKey: 'a0000001',
  keyShapeEvidenced: true,
  status: 'removebyuser',
  isTest: false,
  panelCode: 'bac6',
  ...over,
});
const map = (status: string, reasonCode: string | null, entityType: string | null = null) =>
  ({ status, reasonCode, entityType }) satisfies InvoiceMapFact;

describe('fateOfInvoice', () => {
  it('an account the panel does not hold is ENDED; a test invoice is ENDED and marked test', () => {
    expect(fateOfInvoice(invoice(), map('MANUAL_REVIEW', 'PROVIDER_MISSING'))).toEqual({
      kind: 'ENDED',
      test: false,
    });
    expect(
      fateOfInvoice(invoice({ isTest: true }), map('SKIPPED', 'HISTORY_NOT_IMPORTED')),
    ).toEqual({ kind: 'ENDED', test: true });
  });

  it('an account the importer adopted is ADOPTED whatever its invoice status says', () => {
    for (const status of ['active', 'removebyuser', 'end_of_time', 'send_on_hold']) {
      expect(fateOfInvoice(invoice({ status }), map('IMPORTED', null, 'SERVICE'))).toEqual({
        kind: 'ADOPTED',
      });
    }
  });

  it('an invoice that was never paid is NEVER_PAID (an order, never a service) before the map is asked', () => {
    const cases: [string | null, string][] = [
      ['unpaid', 'EXPIRED'],
      ['Unsuccessful', 'CANCELLED'],
      [null, 'EXPIRED'],
    ];
    for (const [status, state] of cases) {
      expect(fateOfInvoice(invoice({ status }), undefined)).toEqual({ kind: 'NEVER_PAID', state });
      // …and a PROVIDER_MISSING or an IMPORTED row cannot turn it into a service.
      expect(fateOfInvoice(invoice({ status }), map('MANUAL_REVIEW', 'PROVIDER_MISSING'))).toEqual({
        kind: 'NEVER_PAID',
        state,
      });
      expect(fateOfInvoice(invoice({ status }), map('IMPORTED', null, 'SERVICE'))).toEqual({
        kind: 'NEVER_PAID',
        state,
      });
      // …and an invalid key does not hide that it was never paid (the order step decides it).
      expect(fateOfInvoice(invoice({ status, keyShapeEvidenced: false }), undefined)).toEqual({
        kind: 'NEVER_PAID',
        state,
      });
    }
  });

  it('the never-paid state mapping is exact, total over the never-paid statuses, and nothing else', () => {
    expect(neverPaidOrderState('unpaid')).toBe('EXPIRED');
    expect(neverPaidOrderState('Unsuccessful')).toBe('CANCELLED');
    expect(neverPaidOrderState(null)).toBe('EXPIRED');
    // Every never-paid status the importer knows has a state: none falls to UNEXPLAINED.
    for (const status of LEGACY_NEVER_PAID_STATUSES) {
      expect(neverPaidOrderState(status), status).not.toBeNull();
    }
    // Compared exactly, as the importer compares them; a paid status is never mapped.
    for (const status of ['Unpaid', 'unsuccessful', 'UNPAID', ' unpaid', '', 'active', 'removed']) {
      expect(neverPaidOrderState(status), status).toBeNull();
    }
  });

  it('every map reason the importer records is a closed gap, none is an ended service', () => {
    const expected: [string, string, string][] = [
      ['MANUAL_REVIEW', 'INVENTORY_INCOMPLETE', 'INVENTORY_HELD'],
      ['MANUAL_REVIEW', 'CONFLICTING_EXISTING_ENTITY', 'AMBIGUOUS_OWNERSHIP'],
      ['MANUAL_REVIEW', 'CUSTOMER_MISSING', 'OWNER_NOT_IMPORTED'],
      ['MANUAL_REVIEW', 'AMBIGUOUS_PANEL', 'PANEL_ACCOUNT_AMBIGUOUS'],
      ['MANUAL_REVIEW', 'USERNAME_CASE_COLLISION', 'PANEL_ACCOUNT_AMBIGUOUS'],
      ['MANUAL_REVIEW', 'PRODUCT_MAPPING_UNRESOLVED', 'ON_PANEL_NOT_ADOPTABLE'],
      ['MANUAL_REVIEW', 'UNSUPPORTED_SHAPE', 'ON_PANEL_NOT_ADOPTABLE'],
      ['MANUAL_REVIEW', 'SUBSCRIPTION_REF_BLOCKED', 'ON_PANEL_NOT_ADOPTABLE'],
      ['MANUAL_REVIEW', 'INVALID_SOURCE_ROW', 'INVALID_SOURCE_ROW'],
      ['SKIPPED', 'TEST_PANEL', 'TEST_PANEL'],
      ['FAILED', 'PROVIDER_READ_FAILED', 'PROVIDER_READ_FAILED'],
    ];
    for (const [status, reason, gap] of expected) {
      expect(fateOfInvoice(invoice(), map(status, reason))).toEqual({ kind: 'GAP', reason: gap });
    }
  });

  it('an empty code_panel and an unmapped one are told apart by the archive', () => {
    expect(
      fateOfInvoice(invoice({ panelCode: null }), map('MANUAL_REVIEW', 'PANEL_UNMAPPED')),
    ).toEqual({ kind: 'GAP', reason: 'NO_PANEL' });
    expect(fateOfInvoice(invoice(), map('MANUAL_REVIEW', 'PANEL_UNMAPPED'))).toEqual({
      kind: 'GAP',
      reason: 'PANEL_NOT_MAPPED',
    });
  });

  it('a key outside the evidenced shape is a gap; no map row, or an unknown reason, is UNEXPLAINED', () => {
    expect(fateOfInvoice(invoice({ keyShapeEvidenced: false }), undefined)).toEqual({
      kind: 'GAP',
      reason: 'INVOICE_KEY_INVALID',
    });
    expect(fateOfInvoice(invoice(), undefined)).toEqual({ kind: 'UNEXPLAINED', why: 'NO_MAP_ROW' });
    expect(fateOfInvoice(invoice(), map('MANUAL_REVIEW', 'SOMETHING_NEW'))).toMatchObject({
      kind: 'UNEXPLAINED',
    });
    expect(fateOfInvoice(invoice(), map('SKIPPED', 'SOMETHING_NEW'))).toMatchObject({
      kind: 'UNEXPLAINED',
    });
    expect(fateOfInvoice(invoice(), map('IMPORTED', null, 'CUSTOMER'))).toMatchObject({
      kind: 'UNEXPLAINED',
    });
  });

  it('the gap vocabulary is closed and every fate above stays inside it', () => {
    expect(new Set(ENDED_SERVICE_GAP_REASONS).size).toBe(ENDED_SERVICE_GAP_REASONS.length);
    const all = [
      ...ENDED_SERVICE_GAP_REASONS,
      ...NEVER_PAID_ORDER_GAP_REASONS,
      NEVER_PAID_AMOUNT_BUCKET,
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  it('a never-paid ref can never be a paid invoice ref, nor match its LIKE', () => {
    expect(neverPaidSourceRef('a0000001')).toBe('invoice-never-paid:a0000001');
    expect(neverPaidSourceRef('a0000001')).not.toBe(invoiceSourceRef('a0000001'));
    expect(neverPaidSourceRef('a0000001').startsWith('invoice:')).toBe(false);
    // the longest evidenced key fits the 128-character source_ref
    expect(neverPaidSourceRef('1700000abcdef01').length).toBeLessThanOrEqual(128);
  });
});

describe('shape, name and ref', () => {
  it('the shape key is the importer’s own, and refuses what it refuses', () => {
    const ok = shapeKeyOfCells({
      codePanel: 'bac6',
      volume: '30',
      serviceTime: '30',
      timeUnit: null,
      isCustom: '0',
    });
    expect(ok).toMatchObject({ ok: true });
    for (const volume of ['0', 'abc', null]) {
      expect(
        shapeKeyOfCells({
          codePanel: 'bac6',
          volume,
          serviceTime: '30',
          timeUnit: null,
          isCustom: '0',
        }),
      ).toEqual({ ok: false });
    }
  });

  it('an ended service keeps the invoice’s name, or says there was none', () => {
    expect(endedServiceUsername('  Ali_7 ', 'k1')).toBe('Ali_7');
    expect(endedServiceUsername(null, 'k1')).toBe('mirza-k1');
    expect(endedServiceUsername('   ', 'k1')).toBe('mirza-k1');
    expect(endedServiceUsername('x'.repeat(300), 'k1')).toHaveLength(128);
    expect(invoiceSourceRef('a0000001')).toBe('invoice:a0000001');
  });

  it('the order line is titled by the Mirza product when the archive has one', () => {
    expect(lineTitleOf('پلن ۳۰ گیگ', 'سرویس قدیمی')).toBe('پلن ۳۰ گیگ');
    expect(lineTitleOf(null, 'سرویس قدیمی')).toBe('سرویس قدیمی');
    expect(lineTitleOf('  ', 'سرویس قدیمی')).toBe('سرویس قدیمی');
  });
});

describe('sameAsCarried', () => {
  const insert: EndedInvoiceInsert = {
    orderId: 'o',
    serviceId: 's',
    sourceRef: 'invoice:a0000001',
    customerId: 'c1',
    panelId: 'p1',
    product: { productId: 'pr', title: 't', durationDays: 30, trafficBytes: 1n },
    lineTitle: 't',
    providerUsername: 'ali',
    subscriptionRef: 'a'.repeat(32),
    amountMinor: 150_000n,
    currency: 'IRT',
    purchasedAt: new Date(0),
    isTest: false,
    now: new Date(1),
  };
  const same: CarriedInvoice = {
    orderId: 'o0',
    orderOrigin: 'LEGACY_HISTORY',
    orderState: 'PAID',
    orderCustomerId: 'c1',
    orderPanelId: 'p1',
    orderTotal: 150_000n,
    serviceId: 's0',
    serviceState: 'TERMINATED',
    serviceCustomerId: 'c1',
    serviceIsTest: false,
  };

  it('is a rerun only when every fact agrees', () => {
    expect(sameAsCarried(same, insert)).toBe(true);
  });

  it('is a divergence for each fact that differs — never a rewrite', () => {
    for (const change of [
      { orderOrigin: 'LEGACY_ADOPTION' },
      { orderState: 'EXPIRED' },
      { orderCustomerId: 'c2' },
      { orderPanelId: 'p2' },
      { orderTotal: 1n },
      { serviceState: 'ACTIVE' },
      { serviceCustomerId: 'c2' },
      { serviceIsTest: true },
      { orderId: null },
      { serviceId: null },
    ]) {
      expect(sameAsCarried({ ...same, ...change }, insert)).toBe(false);
    }
  });
});

describe('sameAsCarriedNeverPaid', () => {
  const insert: NeverPaidOrderInsert = {
    orderId: 'o',
    sourceRef: 'invoice-never-paid:a0000001',
    state: 'EXPIRED',
    customerId: 'c1',
    panelId: 'p1',
    product: { productId: 'pr', title: 't', durationDays: 30, trafficBytes: 1n },
    lineTitle: 't',
    amountMinor: 150_000n,
    currency: 'IRT',
    createdAt: new Date(0),
    now: new Date(1),
  };
  const same: CarriedInvoice = {
    orderId: 'o0',
    orderOrigin: 'LEGACY_HISTORY',
    orderState: 'EXPIRED',
    orderCustomerId: 'c1',
    orderPanelId: 'p1',
    orderTotal: 150_000n,
    serviceId: null,
    serviceState: null,
    serviceCustomerId: null,
    serviceIsTest: null,
  };

  it('is a rerun only when the order is exactly the one, with no service beside it', () => {
    expect(sameAsCarriedNeverPaid(same, insert)).toBe(true);
  });

  it('is a divergence for each fact that differs — a service beside it included', () => {
    for (const change of [
      { orderOrigin: 'STANDARD' },
      { orderState: 'CANCELLED' },
      { orderState: 'PAID' },
      { orderCustomerId: 'c2' },
      { orderPanelId: 'p2' },
      { orderTotal: 1n },
      { orderId: null },
      { serviceId: 's0' },
    ]) {
      expect(sameAsCarriedNeverPaid({ ...same, ...change }, insert)).toBe(false);
    }
  });
});
