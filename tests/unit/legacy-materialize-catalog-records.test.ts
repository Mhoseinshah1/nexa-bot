import { describe, expect, it } from 'vitest';
import {
  CODE_PATTERN,
  allocateCode,
  derivedCode,
  discountSourceRef,
  normaliseCode,
  planDiscount,
  planProduct,
  resellerFacts,
  resellerSourceDetail,
  tomanMinor,
  type HistoryRow,
} from '../../apps/api/src/modules/platform/legacy-materialize/application/catalog-records';

/**
 * The pure rules of the catalogue import: how a Mirza code becomes a NEXA code, which reseller
 * price is applied, and why a product is or is not on sale. No database.
 */

describe('normaliseCode', () => {
  it.each([
    ['Offer1', 'OFFER1'],
    ['  spring_sale-24  ', 'SPRING_SALE-24'],
    ['سلام ✓ welcome-2026!', 'WELCOME-2026'],
    ['A'.repeat(60), 'A'.repeat(40)],
  ])('%s -> %s', (raw, expected) => {
    const code = normaliseCode(raw);
    expect(code).toBe(expected);
    expect(CODE_PATTERN.test(code as string)).toBe(true);
  });

  it.each(['', 'ab', '!!!', 'سلام', '✓✓✓'])('%j leaves nothing usable', (raw) => {
    expect(normaliseCode(raw)).toBeNull();
  });
});

describe('allocateCode', () => {
  it('keeps the base when it is free', () => {
    expect(allocateCode('OFFER1', 'discount:a', () => false)).toBe('OFFER1');
  });

  it('suffixes a collision from the record reference alone, the same way every time', () => {
    const taken = new Set(['OFFER1']);
    const one = allocateCode('OFFER1', 'discount:a', (c) => taken.has(c));
    const again = allocateCode('OFFER1', 'discount:a', (c) => taken.has(c));
    const other = allocateCode('OFFER1', 'discount:b', (c) => taken.has(c));
    expect(one).toBe(again);
    expect(one).not.toBe(other);
    expect(one).toMatch(/^OFFER1-[0-9A-F]{8}$/);
    expect(CODE_PATTERN.test(one)).toBe(true);
  });

  it('stays inside 40 characters when the base is already long', () => {
    const base = 'B'.repeat(40);
    const code = allocateCode(base, 'discount:a', (c) => c === base);
    expect(code).toHaveLength(40);
    expect(CODE_PATTERN.test(code)).toBe(true);
  });

  it('walks past a taken suffix', () => {
    const first = allocateCode('X-X', 'discount:a', (c) => c === 'X-X');
    const second = allocateCode('X-X', 'discount:a', (c) => c === 'X-X' || c === first);
    expect(second).not.toBe(first);
    expect(CODE_PATTERN.test(second)).toBe(true);
  });
});

describe('derived codes and refs', () => {
  it('derives a valid, stable code from the reference when Mirza gave no text', () => {
    const code = derivedCode('discount:engagement:discount:6');
    expect(code).toBe(derivedCode('discount:engagement:discount:6'));
    expect(CODE_PATTERN.test(code)).toBe(true);
  });

  it('a source_ref fits the 128 character check, however long the package key', () => {
    expect(discountSourceRef('legacy:engagement:discount:1')).toBe(
      'discount:engagement:discount:1',
    );
    const long = discountSourceRef(`legacy:${'k'.repeat(400)}`);
    expect(long.length).toBeLessThanOrEqual(128);
    expect(long).toBe(discountSourceRef(`legacy:${'k'.repeat(400)}`));
  });
});

describe('tomanMinor', () => {
  it('reads whole ASCII digits only', () => {
    expect(tomanMinor('150000')).toBe(150_000n);
    expect(tomanMinor(' 7 ')).toBe(7n);
    for (const bad of ['1.5', '-1', '1e5', '۱۲۳', '', null, undefined, {}]) {
      expect(tomanMinor(bad)).toBeNull();
    }
  });
});

const agent = (over: Record<string, unknown> = {}): HistoryRow => ({
  idempotencyKey: 'legacy:agents:profile:7100000001',
  legacyUserId: '7100000001',
  customerId: null,
  payload: { tier: 'n', customer: { telegram_user_id: '7100000001', valid: true }, ...over },
});
const stateRow = (
  pricing: Record<string, unknown>,
  credit: Record<string, unknown> = {},
): HistoryRow => ({
  idempotencyKey: 'legacy:agents:state:7100000001',
  legacyUserId: '7100000001',
  customerId: null,
  payload: { pricing, credit_debt: credit },
});

describe('resellerFacts', () => {
  it('applies a per-user percent only when it is staged and a whole 1..99', () => {
    const percent = (raw: string | null, staged = true) =>
      resellerFacts(
        agent(),
        stateRow({ percent_discount_raw: raw, percent_discount_staged: staged }),
        [],
      )?.appliedPercent;
    expect(percent('20')).toBe(20);
    expect(percent('99')).toBe(99);
    expect(percent('100')).toBeNull(); // free: not proven
    expect(percent('0')).toBeNull();
    expect(percent('12.5')).toBeNull();
    expect(percent('20', false)).toBeNull(); // the column was never read
    expect(percent(null)).toBeNull();
  });

  it('keeps maxbuyagent raw, as history only, and never parses it into an amount', () => {
    const facts = (raw: string | null) =>
      resellerFacts(agent(), stateRow({}, { overdraft_limit_raw: raw }), []);
    for (const raw of ['5000000', '5,000', null]) {
      const f = facts(raw);
      expect(f?.capRaw).toBe(raw);
      // No bigint anywhere in the facts: nothing downstream can mistake the cap for money.
      expect(Object.values(f ?? {}).some((v) => typeof v === 'bigint')).toBe(false);
      expect(resellerSourceDetail(f!)['purchaseCap']).toEqual({
        raw,
        applied: false,
        reason: 'RESELLER_CREDIT_REMOVED',
      });
    }
  });

  it('gives an owner-less profile no facts, and an unknown tier no reseller tier', () => {
    expect(
      resellerFacts({ ...agent(), idempotencyKey: 'legacy:agents:profile:unowned:x' }, null, []),
    ).toBeNull();
    expect(resellerFacts(agent({ tier: 'NOT_AGENT_IN_USER_TABLE' }), null, [])?.tier).toBeNull();
  });
});

const conv = (over: Record<string, unknown> = {}) => ({
  legacy_product_id: '9',
  code_product: 'p9',
  title_proposal: 'Plan 9',
  conversions: {
    traffic: { proposed_traffic_bytes: '10737418240' },
    duration: { proposed_duration_days: 30 },
    price: { parse_note: 'OK', amount_minor: '1000', currency: 'IRT' },
    agent_tier: { proposed_audience: 'EVERYONE' },
    panel_scope: { kind: 'PANEL_NAME', resolved_code_panels: ['c1'], state: 'RESOLVED' },
    category: { raw: 'Gold' },
    sale_status: { raw: 'active', read: true },
    ...over,
  },
});
const bindings = new Map([['c1', 'panel-1']]);
const panels = new Set(['panel-1']);
const planned = (over: Record<string, unknown> = {}) => {
  const p = planProduct(conv(over), bindings, panels);
  if (p.kind !== 'create') throw new Error('expected a product');
  return p;
};

describe('planProduct', () => {
  it('is ACTIVE with a bound panel, a price, a category and a bounded allowance', () => {
    expect(planned()).toMatchObject({ status: 'ACTIVE', inactiveReason: null, panelId: 'panel-1' });
  });

  it('is INACTIVE, with its reason, whenever one of those is missing', () => {
    const reason = (over: Record<string, unknown>) => planned(over).inactiveReason;
    expect(
      reason({
        panel_scope: { kind: 'PANEL_NAME', resolved_code_panels: ['zz'], state: 'RESOLVED' },
      }),
    ).toBe('PANEL_NOT_MAPPED');
    expect(
      reason({
        panel_scope: { kind: 'PANEL_NAME', resolved_code_panels: ['c1', 'c2'], state: 'AMBIGUOUS' },
      }),
    ).toBe('PANEL_NOT_MAPPED');
    expect(
      reason({
        panel_scope: { kind: 'ALL_PANELS', resolved_code_panels: ['c1'], state: 'RESOLVED' },
      }),
    ).toBe('PANEL_SCOPE_ALL_PANELS');
    expect(reason({ price: { parse_note: 'OK', amount_minor: '0', currency: 'IRT' } })).toBe(
      'NO_PRICE',
    );
    expect(reason({ category: { raw: null } })).toBe('NO_CATEGORY');
    expect(reason({ traffic: { proposed_traffic_bytes: '0' } })).toBe('UNLIMITED_NEEDS_REVIEW');
    expect(reason({ sale_status: { raw: 'disable', read: true } })).toBe('SOLD_OUT_IN_MIRZA');
    expect(reason({ agent_tier: { proposed_audience: null } })).toBe('AUDIENCE_UNKNOWN');
  });

  it("a panel bound to something that is not this tenant's panel is not mapped", () => {
    const p = planProduct(conv(), bindings, new Set());
    expect(p).toMatchObject({ kind: 'create', status: 'INACTIVE', panelId: null });
  });

  it('hides a product whose agent tier could not be read', () => {
    expect(planned({ agent_tier: { proposed_audience: null } }).audience).toBe('HIDDEN');
  });

  it('is a counted gap, not a guess, when volume or duration is unreadable', () => {
    expect(
      planProduct(conv({ traffic: { proposed_traffic_bytes: null } }), bindings, panels),
    ).toMatchObject({
      kind: 'gap',
      reason: 'VOLUME_UNREADABLE',
    });
    expect(
      planProduct(conv({ duration: { proposed_duration_days: null } }), bindings, panels),
    ).toMatchObject({
      kind: 'gap',
      reason: 'DURATION_UNREADABLE',
    });
  });
});

describe('planDiscount', () => {
  const row = (payload: Record<string, unknown>): HistoryRow => ({
    idempotencyKey: 'legacy:engagement:discount:1',
    legacyUserId: null,
    customerId: null,
    payload,
  });

  it('plans a percent code, and refuses a percent it cannot read', () => {
    expect(
      planDiscount(row({ kind: 'PURCHASE_PERCENT_CODE', percent: 25, code_text: 'x1y' })),
    ).toMatchObject({
      kind: 'create',
      type: 'PERCENTAGE',
      value: 25n,
      baseCode: 'X1Y',
    });
    for (const percent of [0, 101, null, 2.5]) {
      expect(planDiscount(row({ kind: 'PURCHASE_PERCENT_CODE', percent }))).toEqual({
        kind: 'gap',
        reason: 'PERCENT_UNREADABLE',
      });
    }
  });

  it('plans a wallet gift code as an amount shell that keeps its kind', () => {
    const planned = planDiscount(
      row({ kind: 'GIFT_BALANCE_CODE', credit_amount: { amount_minor: '50000', currency: 'IRT' } }),
    );
    expect(planned).toMatchObject({
      kind: 'create',
      type: 'FIXED_AMOUNT',
      value: 50_000n,
      mirzaKind: 'GIFT_BALANCE_CODE',
    });
    expect(planDiscount(row({ kind: 'GIFT_BALANCE_CODE' }))).toEqual({
      kind: 'gap',
      reason: 'GIFT_AMOUNT_UNREADABLE',
    });
  });

  it('never invents a kind', () => {
    expect(planDiscount(row({ kind: 'UNKNOWN' }))).toEqual({ kind: 'gap', reason: 'KIND_UNKNOWN' });
  });

  describe("the deployed fork's discount_sell, whose code text converter 0.8 exports", () => {
    const fork = (fields: Record<string, unknown>, code: string | null = 'Spring-25') =>
      planDiscount(
        row({
          kind: 'UNKNOWN',
          code_plaintext_exported: code !== null,
          ...(code === null ? {} : { code_text: code }),
          fields_raw: fields,
        }),
      );

    it('is recreated under its REAL code, not a derived MZ- one', () => {
      const planned = fork({ percent: '25' });
      expect(planned).toMatchObject({
        kind: 'create',
        type: 'PERCENTAGE',
        value: 25n,
        currency: null,
        codeText: 'Spring-25',
        baseCode: 'SPRING-25',
      });
      if (planned.kind !== 'create') throw new Error('planned');
      expect(planned.baseCode.startsWith('MZ-')).toBe(false);
      expect(planned.detail).toMatchObject({
        codeOriginal: 'Spring-25',
        codeDerived: false,
        valueBasis: 'FORK_COLUMN_PERCENT_UNPROVEN',
        fieldsRaw: { percent: '25' },
      });
    });

    it('reads the percent from `percent`, else from `price`, as a whole 1..100 only', () => {
      expect(fork({ percent: 10 })).toMatchObject({ value: 10n });
      expect(fork({ price: '40' })).toMatchObject({
        value: 40n,
        detail: { valueBasis: 'FORK_COLUMN_PRICE_UNPROVEN' },
      });
      // an unreadable `percent` does not stop a readable `price`
      expect(fork({ percent: 'abc', price: '15' })).toMatchObject({ value: 15n });
      for (const bad of [
        {},
        { percent: '0' },
        { percent: '101' },
        { price: '2.5' },
        { price: 9000 },
      ]) {
        expect(fork(bad), JSON.stringify(bad)).toEqual({
          kind: 'gap',
          reason: 'FORK_PERCENT_UNREADABLE',
        });
      }
    });

    it('falls back to the derived MZ- code only when the text is absent', () => {
      // No text: the converter could not carry one, so the record is not the fork's code list.
      expect(fork({ percent: '25' }, null)).toEqual({ kind: 'gap', reason: 'KIND_UNKNOWN' });
      // A public code (never exported as text) still gets the derived code.
      const publicCode = planDiscount(row({ kind: 'PURCHASE_PERCENT_CODE', percent: 25 }));
      expect(publicCode).toMatchObject({ kind: 'create' });
      if (publicCode.kind !== 'create') throw new Error('planned');
      expect(publicCode.baseCode).toMatch(/^MZ-[0-9A-F]{12}$/u);
      expect(publicCode.detail['codeDerived']).toBe(true);
      expect(publicCode.detail).not.toHaveProperty('valueBasis');
    });
  });

  it('first-purchase codes apply to a new service only', () => {
    expect(
      planDiscount(
        row({
          kind: 'PURCHASE_PERCENT_CODE',
          percent: 10,
          scope: { first_purchase_only_raw: '1', type: 'extend' },
        }),
      ),
    ).toMatchObject({ firstPurchaseOnly: true, appliesTo: ['NEW_SERVICE'] });
  });
});
