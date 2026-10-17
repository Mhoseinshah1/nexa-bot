import { describe, expect, it } from 'vitest';
import { nxpkgOwnershipHold } from '../../apps/api/src/modules/platform/legacy-importer/application/nxpkg-ownership';
import {
  withOwnershipRule,
  type PlannedService,
} from '../../apps/api/src/modules/platform/legacy-importer/application/plan';
import {
  isLiveInvoiceStatus,
  readFromSession,
  serviceCandidateInvoices,
  type LegacyInvoiceRow,
} from '../../apps/api/src/modules/platform/legacy-importer/application/source-snapshot';
import { FixtureLegacySourceConnector } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/fixture-legacy-source';
import { buildSyntheticLegacyDataset } from '../fixtures/legacy/synthetic-legacy';

/**
 * Every Mirza invoice is matched against the panel (owner decision 2026-10-17), live or not.
 * Three rules make that safe, each pinned here:
 *
 * 1. the snapshot splits invoices into LIVE, OTHER and neither (never paid), live first;
 * 2. an old invoice's claim on an account never makes a live adoption ambiguous;
 * 3. an old invoice with no ownership record is not held for that absence (the converter
 *    writes records for live candidates), while a live one still is.
 */
describe('the snapshot partitions invoices by what they were', () => {
  it('live, other (removed, expired, warned) and neither (unpaid, failed, no status)', async () => {
    const dataset = buildSyntheticLegacyDataset() as unknown as {
      tables: { invoice: Record<string, string | null>[] };
    };
    const template = dataset.tables.invoice[0] as Record<string, string | null>;
    const extra = (id: string, Status: string | null) =>
      dataset.tables.invoice.push({ ...template, id_invoice: id, Status });
    extra('ee000001', 'unpaid');
    extra('ee000002', 'Unsuccessful');
    extra('ee000003', null);
    extra('ee000004', 'removebyuser');
    extra('ee000005', 'end_of_time');
    extra('ee000006', 'send_on_hold');
    const connector = new FixtureLegacySourceConnector(dataset as never);
    const snapshot = await readFromSession(connector.label, await connector.open());

    const live = snapshot.liveInvoices.map((i) => i.idInvoice);
    const other = snapshot.otherInvoices.map((i) => i.idInvoice);
    for (const id of ['ee000001', 'ee000002', 'ee000003']) {
      expect(live, id).not.toContain(id);
      expect(other, id).not.toContain(id);
    }
    expect(other).toEqual(expect.arrayContaining(['ee000004', 'ee000005', 'ee000006']));
    // The synthetic dataset's own `removed` invoices are other ones as well.
    expect(snapshot.otherInvoices.length).toBeGreaterThanOrEqual(5);
    for (const row of snapshot.liveInvoices) expect(isLiveInvoiceStatus(row.status)).toBe(true);
    for (const row of snapshot.otherInvoices) expect(isLiveInvoiceStatus(row.status)).toBe(false);

    // One list, live first: an account two invoices of one owner name goes to the live one.
    const candidates = serviceCandidateInvoices(snapshot);
    expect(candidates.length).toBe(live.length + other.length);
    expect(candidates.slice(0, live.length).map((i) => i.idInvoice)).toEqual(live);
  });
});

describe('withOwnershipRule: an old invoice never takes a live adoption away', () => {
  const invoice = (idInvoice: string, status: string): LegacyInvoiceRow =>
    ({ idInvoice, status }) as unknown as LegacyInvoiceRow;
  const eligible = (
    idInvoice: string,
    status: string,
    telegramUserId: string,
    account = 'svc',
  ): PlannedService => ({
    invoice: invoice(idInvoice, status),
    decision: {
      category: 'ADOPTION_ELIGIBLE',
      panelId: 'p1',
      providerUsername: account,
      product: { kind: 'HIDDEN_SHAPE', shapeKey: 'k', custom: false },
      telegramUserId,
    },
  });
  const categories = (services: readonly PlannedService[]) =>
    Object.fromEntries(services.map((s) => [s.invoice.idInvoice, s.decision.category]));
  const none = new Set<string>();

  it('two LIVE invoices of different owners on one account are both ambiguous (the original rule)', () => {
    expect(
      categories(
        withOwnershipRule([eligible('a', 'active', '1'), eligible('b', 'active', '2')], none),
      ),
    ).toEqual({ a: 'AMBIGUOUS_OWNERSHIP', b: 'AMBIGUOUS_OWNERSHIP' });
  });

  it('a removed invoice of ANOTHER owner is held, and the live adoption stays eligible', () => {
    expect(
      categories(
        withOwnershipRule([eligible('a', 'active', '1'), eligible('b', 'removebyuser', '2')], none),
      ),
    ).toEqual({ a: 'ADOPTION_ELIGIBLE', b: 'AMBIGUOUS_OWNERSHIP' });
  });

  it('a removed invoice of the SAME owner is left to the adoption’s own name-taken rule', () => {
    expect(
      categories(
        withOwnershipRule([eligible('a', 'active', '1'), eligible('b', 'removebyuser', '1')], none),
      ),
    ).toEqual({ a: 'ADOPTION_ELIGIBLE', b: 'ADOPTION_ELIGIBLE' });
  });

  it('two removed invoices of different owners are ambiguous; one removed invoice alone is eligible', () => {
    expect(
      categories(
        withOwnershipRule(
          [eligible('a', 'removebyuser', '1'), eligible('b', 'end_of_time', '2')],
          none,
        ),
      ),
    ).toEqual({ a: 'AMBIGUOUS_OWNERSHIP', b: 'AMBIGUOUS_OWNERSHIP' });
    expect(categories(withOwnershipRule([eligible('a', 'removebyuser', '1')], none))).toEqual({
      a: 'ADOPTION_ELIGIBLE',
    });
  });

  it('two live owners and a removed invoice of one of them: all three are ambiguous', () => {
    expect(
      categories(
        withOwnershipRule(
          [
            eligible('a', 'active', '1'),
            eligible('b', 'disabled', '2'),
            eligible('c', 'removebyuser', '1'),
          ],
          none,
        ),
      ),
    ).toEqual({ a: 'AMBIGUOUS_OWNERSHIP', b: 'AMBIGUOUS_OWNERSHIP', c: 'AMBIGUOUS_OWNERSHIP' });
  });

  it('an invoice a person kept as history is no claim; different accounts never interact', () => {
    expect(
      categories(
        withOwnershipRule(
          [eligible('a', 'active', '1'), eligible('b', 'removebyuser', '2')],
          new Set(['b']),
        ),
      ),
    ).toEqual({ a: 'ADOPTION_ELIGIBLE', b: 'ADOPTION_ELIGIBLE' });
    expect(
      categories(
        withOwnershipRule(
          [eligible('a', 'active', '1', 'one'), eligible('b', 'removebyuser', '2', 'two')],
          none,
        ),
      ),
    ).toEqual({ a: 'ADOPTION_ELIGIBLE', b: 'ADOPTION_ELIGIBLE' });
  });
});

describe('nxpkgOwnershipHold: no record is a hold for a live invoice, not for an old one', () => {
  const record = (invoiceKey: string, decision: string, finalOwner: string) => ({
    key: `legacy:service-ownership:${invoiceKey}`,
    invoiceKey,
    decision,
    finalOwner,
  });
  const live = [{ idInvoice: 'l1', idUser: '1' }];
  const other = [
    { idInvoice: 'o1', idUser: '1' },
    { idInvoice: 'o2', idUser: '1' },
  ];

  it('a live invoice without a record is held; an other one without a record is not', () => {
    const out = nxpkgOwnershipHold({
      records: [],
      decisions: null,
      liveInvoices: live,
      otherInvoices: other,
    });
    expect([...out.hold]).toEqual(['l1']);
    expect(out.reasons).toEqual({ NO_OWNERSHIP_RECORD: 1 });
  });

  it('an other invoice WITH a record is judged exactly as a live one is', () => {
    const out = nxpkgOwnershipHold({
      records: [
        record('o1', 'AMBIGUOUS_OWNER', '1'),
        record('o2', 'CONFIRMED_CURRENT_OWNER', '1'),
        record('l1', 'CONFIRMED_CURRENT_OWNER', '1'),
      ] as never,
      decisions: null,
      liveInvoices: live,
      otherInvoices: other,
    });
    expect([...out.hold].sort()).toEqual(['o1']);
    expect([...out.proven].sort()).toEqual(['l1', 'o2']);
  });
});
