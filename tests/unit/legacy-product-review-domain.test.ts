import { describe, expect, it } from 'vitest';
import {
  LEGACY_PRODUCT_REVIEW_STATES,
  legacyProductApproveNewRequestSchema,
  type LegacyProductReviewState,
} from '@nexa/contracts';
import {
  legacyProductCode,
  legacyProductFactsChecksum,
  parseLegacyProduct,
} from '../../apps/api/src/modules/commerce/legacy-product-review/domain/legacy-product-facts';
import {
  decideAbsence,
  decideIngest,
  isExportable,
  type ReviewSourceState,
} from '../../apps/api/src/modules/commerce/legacy-product-review/domain/review-transitions';
import { legacyDraftProduct } from '../../apps/api/src/modules/commerce/legacy-product-review/application/legacy-product-review.service';
import { unorderableReason } from '../../apps/api/src/modules/commerce/catalog/application/catalog-visibility';
import type { ProductRecord } from '../../apps/api/src/modules/commerce/catalog/application/ports';

/**
 * Mirza migration PR2 — the legacy product review's pure rules
 * (`docs/legacy-product-review-design.md` §4, §5, §9). SYNTHETIC values only.
 */

const F = (n: number) => n.toString(16).padStart(64, '0');

describe('the review key: the importer’s trimmed code_product', () => {
  it('trims, and refuses empty, over-long and control-character codes', () => {
    expect(legacyProductCode(' p1 ')).toEqual({ ok: true, code: 'p1' });
    expect(legacyProductCode(null)).toEqual({ ok: false, reason: 'CODE_EMPTY' });
    expect(legacyProductCode('   ')).toEqual({ ok: false, reason: 'CODE_EMPTY' });
    expect(legacyProductCode('a'.repeat(200))).toMatchObject({ ok: true });
    expect(legacyProductCode('a'.repeat(201))).toEqual({ ok: false, reason: 'CODE_INVALID' });
    expect(legacyProductCode('p\u00071')).toEqual({ ok: false, reason: 'CODE_INVALID' });
  });
});

describe('facts and their checksum', () => {
  const row = { id: '1', code_product: 'p1', name_product: 'x', price_product: '150000' };

  it('is deterministic and independent of key order, and moves with any cell', () => {
    const a = legacyProductFactsChecksum([row]);
    expect(a).toMatch(/^[0-9a-f]{64}$/u);
    expect(
      legacyProductFactsChecksum([
        { price_product: '150000', name_product: 'x', code_product: 'p1', id: '1' },
      ]),
    ).toBe(a);
    expect(legacyProductFactsChecksum([{ ...row, price_product: '150001' }])).not.toBe(a);
    // NULL and the empty string are different facts.
    expect(legacyProductFactsChecksum([{ ...row, name_product: null }])).not.toBe(
      legacyProductFactsChecksum([{ ...row, name_product: '' }]),
    );
    // A column the source gains is a changed source.
    expect(legacyProductFactsChecksum([{ ...row, note: '' }])).not.toBe(a);
  });
});

describe('parsing proposes, never guesses', () => {
  const base = {
    id: '1',
    code_product: 'p1',
    name_product: '  synthetic 30GB ',
    price_product: '150000',
    Volume_constraint: '30',
    Service_time: '30',
  };

  it('parses a regular row: GB as 1 GiB, whole days, whole Toman as IRT minor units', () => {
    expect(parseLegacyProduct([base])).toEqual({
      sourceConflict: null,
      title: 'synthetic 30GB',
      trafficBytes: 30n * 1024n ** 3n,
      durationDays: 30,
      historicalPriceRaw: '150000',
      historicalPrice: { amountMinor: 150000n, currency: 'IRT' },
      parseNotes: {},
    });
  });

  it.each([
    ['price', { price_product: '150000.5' }, 'historicalPrice', 'NOT_A_NUMBER'],
    ['price', { price_product: '150,000' }, 'historicalPrice', 'NOT_A_NUMBER'],
    ['price', { price_product: '۱۵۰۰۰۰' }, 'historicalPrice', 'NOT_A_NUMBER'],
    ['price', { price_product: '-1' }, 'historicalPrice', 'NOT_A_NUMBER'],
    ['price', { price_product: '9999999999999999999' }, 'historicalPrice', 'OUT_OF_RANGE'],
    ['price', { price_product: null }, 'historicalPrice', 'EMPTY'],
    ['volume', { Volume_constraint: '0' }, 'trafficBytes', 'ZERO_MEANING_UNKNOWN'],
    ['volume', { Volume_constraint: '10.125' }, 'trafficBytes', 'NOT_A_NUMBER'],
    ['volume', { Volume_constraint: '' }, 'trafficBytes', 'EMPTY'],
    ['days', { Service_time: '0' }, 'durationDays', 'ZERO_MEANING_UNKNOWN'],
    ['days', { Service_time: '1 month' }, 'durationDays', 'NOT_A_NUMBER'],
    ['days', { Service_time: '3651' }, 'durationDays', 'OUT_OF_RANGE'],
    ['title', { name_product: '   ' }, 'title', 'EMPTY'],
  ] as const)('%s %j → %s %s', (_label, change, field, note) => {
    const parsed = parseLegacyProduct([{ ...base, ...change }]);
    expect(parsed.parseNotes).toEqual({ [field]: note });
    const value = {
      title: parsed.title,
      trafficBytes: parsed.trafficBytes,
      durationDays: parsed.durationDays,
      historicalPrice: parsed.historicalPrice,
    }[field];
    expect(value).toBeNull();
  });

  it('keeps the raw price verbatim whatever it parses to', () => {
    expect(parseLegacyProduct([{ ...base, price_product: ' ۱۵۰۰۰۰ ' }]).historicalPriceRaw).toBe(
      ' ۱۵۰۰۰۰ ',
    );
    expect(parseLegacyProduct([{ ...base, price_product: '0' }]).historicalPrice).toEqual({
      amountMinor: 0n,
      currency: 'IRT',
    });
  });

  it('an absent column is ABSENT, not EMPTY', () => {
    const parsed = parseLegacyProduct([{ id: '1', code_product: 'p1' }]);
    expect(parsed.parseNotes).toEqual({
      title: 'ABSENT',
      trafficBytes: 'ABSENT',
      durationDays: 'ABSENT',
      historicalPrice: 'ABSENT',
    });
    expect(parsed.historicalPriceRaw).toBeNull();
  });

  it('a duplicated code parses nothing and says why', () => {
    const parsed = parseLegacyProduct([base, { ...base, id: '2' }]);
    expect(parsed.sourceConflict).toBe('CODE_DUPLICATED');
    expect(parsed.historicalPrice).toBeNull();
    expect(new Set(Object.values(parsed.parseNotes))).toEqual(new Set(['SOURCE_CONFLICT']));
  });
});

const held = (state: LegacyProductReviewState, overrides: Partial<ReviewSourceState> = {}) =>
  ({
    state,
    factsChecksum: F(1),
    readFingerprint: F(10),
    sourceFingerprint: F(20),
    liveInvoiceCount: 3,
    missingSinceReadFingerprint: null,
    ...overrides,
  }) satisfies ReviewSourceState;
const seen = {
  factsChecksum: F(1),
  readFingerprint: F(10),
  sourceFingerprint: F(20),
  liveInvoiceCount: 3,
};

describe('what a read does to a row', () => {
  it('creates an unknown code; writes nothing for the same read', () => {
    expect(decideIngest(null, seen)).toEqual({ kind: 'CREATE' });
    for (const state of LEGACY_PRODUCT_REVIEW_STATES) {
      expect(decideIngest(held(state), seen)).toEqual({ kind: 'UNCHANGED' });
    }
  });

  it('refreshes provenance, never the state, when the facts are the same', () => {
    for (const state of LEGACY_PRODUCT_REVIEW_STATES) {
      expect(decideIngest(held(state), { ...seen, readFingerprint: F(11) })).toEqual({
        kind: 'TOUCH',
        reappeared: false,
      });
      expect(decideIngest(held(state), { ...seen, liveInvoiceCount: 4 })).toEqual({
        kind: 'TOUCH',
        reappeared: false,
      });
      expect(decideIngest(held(state, { missingSinceReadFingerprint: F(12) }), seen)).toEqual({
        kind: 'TOUCH',
        reappeared: true,
      });
    }
  });

  it('changed facts on a DECIDED row are SOURCE_CHANGED — never kept approved', () => {
    const changed = { ...seen, factsChecksum: F(2) };
    for (const state of ['APPROVED_EXISTING', 'APPROVED_NEW', 'REJECTED'] as const) {
      expect(decideIngest(held(state), changed)).toEqual({ kind: 'SOURCE_CHANGED', prior: state });
    }
    expect(decideIngest(held('PENDING_REVIEW'), changed)).toEqual({ kind: 'FACTS_UPDATED' });
    expect(decideIngest(held('SOURCE_CHANGED'), changed)).toEqual({ kind: 'FACTS_UPDATED' });
  });

  it('a vanished decided code is SOURCE_CHANGED; an undecided one is marked; once only', () => {
    expect(decideAbsence(held('APPROVED_NEW'))).toEqual({
      kind: 'SOURCE_CHANGED',
      prior: 'APPROVED_NEW',
    });
    expect(decideAbsence(held('REJECTED'))).toEqual({ kind: 'SOURCE_CHANGED', prior: 'REJECTED' });
    expect(decideAbsence(held('PENDING_REVIEW'))).toEqual({ kind: 'MARK_MISSING' });
    expect(decideAbsence(held('SOURCE_CHANGED'))).toEqual({ kind: 'MARK_MISSING' });
    expect(
      decideAbsence(held('APPROVED_EXISTING', { missingSinceReadFingerprint: F(12) })),
    ).toEqual({
      kind: 'NONE',
    });
  });
});

describe('what exports', () => {
  const approved = {
    state: 'APPROVED_EXISTING' as LegacyProductReviewState,
    factsChecksum: F(1),
    approvedFactsChecksum: F(1),
    approvedProductId: 'p',
    readFingerprint: F(10),
    missingSinceReadFingerprint: null,
    sourceConflict: null,
  };

  it('only an approval bound to the current facts, seen by THIS read, present and clean', () => {
    expect(isExportable(approved, F(10))).toBe(true);
    expect(isExportable({ ...approved, state: 'APPROVED_NEW' }, F(10))).toBe(true);
    for (const state of ['PENDING_REVIEW', 'REJECTED', 'SOURCE_CHANGED'] as const) {
      expect(isExportable({ ...approved, state }, F(10)), state).toBe(false);
    }
    expect(isExportable({ ...approved, approvedFactsChecksum: F(2) }, F(10))).toBe(false);
    expect(isExportable(approved, F(11))).toBe(false);
    expect(isExportable({ ...approved, missingSinceReadFingerprint: F(10) }, F(10))).toBe(false);
    expect(isExportable({ ...approved, sourceConflict: 'CODE_DUPLICATED' }, F(10))).toBe(false);
  });
});

describe('approve-as-new: a draft nobody can buy', () => {
  it('is HIDDEN, uncategorised, panel-less and unpriced whatever is asked', () => {
    const draft = legacyDraftProduct({ title: 'x', durationDays: 30, trafficBytes: 1n });
    expect(draft).toMatchObject({
      audience: 'HIDDEN',
      categoryId: null,
      panelId: null,
      price: null,
    });
  });

  it('the request schema has no price, panel, category, audience or status to ask with', () => {
    const body = {
      idempotencyKey: 'k'.repeat(16),
      expectedFactsChecksum: F(1),
      title: 'x',
      durationDays: 30,
      trafficBytes: '1',
    };
    expect(legacyProductApproveNewRequestSchema.safeParse(body).success).toBe(true);
    for (const extra of [
      { price: { amountMinor: '1', currency: 'IRT' } },
      { panelId: '0190a000-0000-7000-8000-000000000000' },
      { categoryId: '0190a000-0000-7000-8000-000000000000' },
      { audience: 'EVERYONE' },
      { status: 'ACTIVE' },
    ]) {
      expect(legacyProductApproveNewRequestSchema.safeParse({ ...body, ...extra }).success).toBe(
        false,
      );
    }
  });

  it('is refused by the order rule four ways over, starting with NOT_PURCHASABLE', () => {
    const draft = legacyDraftProduct({ title: 'x', durationDays: 30, trafficBytes: 1n });
    const record = { ...draft, id: 'p', status: 'INACTIVE' } as unknown as ProductRecord;
    expect(unorderableReason(record, null)).toBe('NOT_PURCHASABLE');
    expect(unorderableReason(record, null, 'RESELLER')).toBe('NOT_PURCHASABLE');
    // Even an operator activating it later leaves it unpriced, panel-less and uncategorised.
    expect(unorderableReason({ ...record, status: 'ACTIVE' }, null)).toBe('NOT_PRICED');
  });
});
