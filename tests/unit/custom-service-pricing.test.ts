import { describe, expect, it } from 'vitest';
import {
  CUSTOM_SERVICE_MAX_DAYS,
  MAX_MONEY_AMOUNT_MINOR,
  customServiceVolumeBytes,
  formatCustomServiceVolume,
  money,
  parseCustomServiceDays,
  parseCustomServiceVolume,
  parseTrafficGb,
} from '@nexa/contracts';
import {
  CUSTOM_SERVICE_RULE_AMOUNT_CEILING,
  CUSTOM_SERVICE_TIME_STEP_LABEL,
  CUSTOM_SERVICE_VOLUME_STEP_LABEL,
  customServiceBaseQuote,
  customServiceTimePrice,
  customServiceVolumePrice,
  priceCustomService,
  ruleAmountFits,
  rulesOverlap,
  selectCustomServiceRule,
  type CustomServiceRule,
  type CustomServiceSubject,
} from '../../apps/api/src/modules/commerce/custom-service/domain/custom-service-pricing.js';

/**
 * Package D — the custom service's pricing, pure (`docs/package-d-custom-service-audit.md`
 * §4, §5): the specificity order, the inclusive ranges, the refusal of two matches, the
 * exact arithmetic, the quote trace and the overlap rule.
 */

const CUSTOMER = '01900000-0000-7000-8000-00000000c001';
const OTHER_CUSTOMER = '01900000-0000-7000-8000-00000000c002';
const TIER = '01900000-0000-7000-8000-00000000d001';
const PANEL = '01900000-0000-7000-8000-00000000e001';
const OTHER_PANEL = '01900000-0000-7000-8000-00000000e002';

let seq = 0;
function rule(overrides: Partial<CustomServiceRule>): CustomServiceRule {
  seq += 1;
  return {
    id: `01900000-0000-7000-8000-${String(seq).padStart(12, '0')}`,
    dimension: 'VOLUME',
    minUnits: 100n, // 1 GB
    maxUnits: 10_000n, // 100 GB
    unitPrice: money(1_000n, 'IRT'),
    customerId: null,
    resellerTierId: null,
    panelId: null,
    enabled: true,
    ...overrides,
  };
}

const ordinary: CustomServiceSubject = { customerId: CUSTOMER, tierId: null, panelId: PANEL };
const reseller: CustomServiceSubject = { customerId: CUSTOMER, tierId: TIER, panelId: PANEL };

describe('the rule that prices a dimension (brief D3)', () => {
  const customerPanel = rule({ customerId: CUSTOMER, panelId: PANEL, unitPrice: money(1n, 'IRT') });
  const customerAll = rule({ customerId: CUSTOMER, unitPrice: money(2n, 'IRT') });
  const tierPanel = rule({ resellerTierId: TIER, panelId: PANEL, unitPrice: money(3n, 'IRT') });
  const tierAll = rule({ resellerTierId: TIER, unitPrice: money(4n, 'IRT') });
  const ordinaryPanel = rule({ panelId: PANEL, unitPrice: money(5n, 'IRT') });
  const ordinaryAll = rule({ unitPrice: money(6n, 'IRT') });

  it.each([
    [
      'customer + this panel',
      [customerPanel, customerAll, tierPanel, tierAll],
      customerPanel,
      'CUSTOMER_PANEL',
    ],
    [
      'customer + all panels',
      [customerAll, tierPanel, tierAll],
      customerAll,
      'CUSTOMER_ALL_PANELS',
    ],
    ['tier + this panel', [tierPanel, tierAll], tierPanel, 'TIER_PANEL'],
    ['tier + all panels', [tierAll], tierAll, 'TIER_ALL_PANELS'],
  ] as const)(
    'a reseller is priced by the most specific level: %s',
    (_, rules, expected, level) => {
      const selected = selectCustomServiceRule(rules, 'VOLUME', 500n, reseller);
      expect(selected).toEqual({ kind: 'SELECTED', rule: expected, level });
    },
  );

  it('prices an ordinary customer by the rules with neither a customer nor a tier', () => {
    expect(selectCustomServiceRule([ordinaryPanel, ordinaryAll], 'VOLUME', 500n, ordinary)).toEqual(
      { kind: 'SELECTED', rule: ordinaryPanel, level: 'TIER_PANEL' },
    );
    expect(selectCustomServiceRule([ordinaryAll], 'VOLUME', 500n, ordinary)).toEqual({
      kind: 'SELECTED',
      rule: ordinaryAll,
      level: 'TIER_ALL_PANELS',
    });
  });

  it('never prices a reseller by the ordinary customers’ rules, nor an ordinary customer by a tier’s', () => {
    expect(selectCustomServiceRule([ordinaryAll], 'VOLUME', 500n, reseller)).toEqual({
      kind: 'NO_RULE',
    });
    expect(selectCustomServiceRule([tierAll], 'VOLUME', 500n, ordinary)).toEqual({
      kind: 'NO_RULE',
    });
  });

  it('never prices one customer by another customer’s rule, nor one panel by another’s', () => {
    const theirs = rule({ customerId: OTHER_CUSTOMER });
    const elsewhere = rule({ panelId: OTHER_PANEL });
    expect(selectCustomServiceRule([theirs, elsewhere], 'VOLUME', 500n, ordinary)).toEqual({
      kind: 'NO_RULE',
    });
  });

  it('falls through a more specific level whose ranges do not contain the figure', () => {
    // The customer's own rule covers 1–10 GB; a 20 GB request is priced by the tier's.
    const narrow = rule({ customerId: CUSTOMER, minUnits: 100n, maxUnits: 1_000n });
    const wide = rule({ resellerTierId: TIER });
    expect(selectCustomServiceRule([narrow, wide], 'VOLUME', 2_000n, reseller)).toEqual({
      kind: 'SELECTED',
      rule: wide,
      level: 'TIER_ALL_PANELS',
    });
  });

  it('refuses two matching rules at one level rather than summing or choosing one', () => {
    const a = rule({ minUnits: 100n, maxUnits: 1_000n });
    const b = rule({ minUnits: 500n, maxUnits: 2_000n });
    const selected = selectCustomServiceRule([a, b], 'VOLUME', 700n, ordinary);
    expect(selected.kind).toBe('AMBIGUOUS');
  });

  it('ignores a disabled rule and a rule of the other dimension', () => {
    const off = rule({ enabled: false });
    const time = rule({ dimension: 'TIME', minUnits: 1n, maxUnits: 365n });
    expect(selectCustomServiceRule([off, time], 'VOLUME', 500n, ordinary)).toEqual({
      kind: 'NO_RULE',
    });
  });

  it('treats both bounds as inclusive, and nothing outside them', () => {
    const r = rule({ minUnits: 1_000n, maxUnits: 2_025n });
    for (const units of [1_000n, 2_025n]) {
      expect(selectCustomServiceRule([r], 'VOLUME', units, ordinary).kind).toBe('SELECTED');
    }
    for (const units of [999n, 2_026n]) {
      expect(selectCustomServiceRule([r], 'VOLUME', units, ordinary).kind).toBe('NO_RULE');
    }
  });
});

describe('the price (brief D4)', () => {
  const volume = rule({ unitPrice: money(20_000n, 'IRT') }); // 20,000 per GB
  const time = rule({
    dimension: 'TIME',
    minUnits: 1n,
    maxUnits: 365n,
    unitPrice: money(1_500n, 'IRT'),
  });

  it('is volume × price per GB plus days × price per day, exactly', () => {
    const priced = priceCustomService([volume, time], ordinary, 1_025n, 30, 'IRT');
    expect(priced.kind).toBe('PRICED');
    if (priced.kind !== 'PRICED') return;
    expect(priced.price.volumePrice).toEqual(money(205_000n, 'IRT')); // 10.25 × 20,000
    expect(priced.price.timePrice).toEqual(money(45_000n, 'IRT')); // 30 × 1,500
    expect(priced.price.basePrice).toEqual(money(250_000n, 'IRT'));
    expect(priced.price.volumeRule).toBe(volume);
    expect(priced.price.timeRule).toBe(time);
  });

  it('rounds the volume price to the minor unit, half up, and only there', () => {
    expect(customServiceVolumePrice(1n, 150n)).toBe(2n); // 1.5 → 2
    expect(customServiceVolumePrice(1n, 149n)).toBe(1n); // 1.49 → 1
    expect(customServiceVolumePrice(1n, 50n)).toBe(1n); // 0.5 → 1
    expect(customServiceVolumePrice(3n, 33n)).toBe(1n); // 0.99 → 1
    expect(customServiceTimePrice(3650, 999_999n)).toBe(3_649_996_350n);
  });

  it('stays exact past 2^53', () => {
    const units = 102_400_000n; // 1,024,000 GB
    const perGb = 9_007_199_254_740_993n;
    expect(customServiceVolumePrice(units, perGb)).toBe((units * perGb + 50n) / 100n);
    expect(customServiceVolumePrice(units, perGb) % 1n).toBe(0n);
  });

  it.each([
    ['no VOLUME rule', [time], 'NO_VOLUME_RULE'],
    ['no TIME rule', [volume], 'NO_TIME_RULE'],
    ['nothing at all', [], 'NO_VOLUME_RULE'],
  ] as const)('is unavailable with %s', (_, rules, reason) => {
    expect(priceCustomService(rules, ordinary, 1_000n, 30, 'IRT')).toEqual({
      kind: 'UNAVAILABLE',
      reason,
    });
  });

  it('is unavailable when a rule is in another currency than the sales currency', () => {
    expect(priceCustomService([volume, time], ordinary, 1_000n, 30, 'IRR')).toEqual({
      kind: 'UNAVAILABLE',
      reason: 'CURRENCY_MISMATCH',
    });
  });

  it('prices each dimension at its own level', () => {
    const mine = rule({ customerId: CUSTOMER, unitPrice: money(10n, 'IRT') });
    const priced = priceCustomService([mine, time], ordinary, 100n, 1, 'IRT');
    expect(priced.kind === 'PRICED' && priced.price.volumeLevel).toBe('CUSTOMER_ALL_PANELS');
    expect(priced.kind === 'PRICED' && priced.price.timeLevel).toBe('TIER_ALL_PANELS');
  });
});

describe('the quote a custom draft carries', () => {
  it('names both rules in two CUSTOM_SERVICE_FORMULA steps and no product', () => {
    const quoted = customServiceBaseQuote({
      volumeRuleId: 'vol-rule',
      volumePrice: money(205_000n, 'IRT'),
      timeRuleId: 'time-rule',
      timePrice: money(45_000n, 'IRT'),
      quotedAt: new Date('2026-09-28T00:00:00Z'),
    });
    expect(quoted.subtotal).toEqual(money(250_000n, 'IRT'));
    expect(quoted.total).toEqual(money(250_000n, 'IRT'));
    expect(quoted.discount).toEqual(money(0n, 'IRT'));
    expect(quoted.quote.productId).toBeNull();
    expect(quoted.quote.finalAmount).toEqual(money(250_000n, 'IRT'));
    expect(quoted.quote.trace).toEqual([
      {
        step: 'CUSTOM_SERVICE_FORMULA',
        effect: 'REPLACES',
        ruleId: 'vol-rule',
        ruleLabel: CUSTOM_SERVICE_VOLUME_STEP_LABEL,
        amountBefore: money(0n, 'IRT'),
        amountAfter: money(205_000n, 'IRT'),
      },
      {
        step: 'CUSTOM_SERVICE_FORMULA',
        effect: 'REPLACES',
        ruleId: 'time-rule',
        ruleLabel: CUSTOM_SERVICE_TIME_STEP_LABEL,
        amountBefore: money(205_000n, 'IRT'),
        amountAfter: money(250_000n, 'IRT'),
      },
    ]);
  });
});

describe('the overlap rule (brief D2)', () => {
  const base = rule({ minUnits: 100n, maxUnits: 1_000n });

  it('refuses an intersecting enabled range of the same dimension at the same specificity', () => {
    expect(rulesOverlap(rule({ minUnits: 1_000n, maxUnits: 2_000n }), base)).toBe(true);
    expect(rulesOverlap(rule({ minUnits: 50n, maxUnits: 100n }), base)).toBe(true);
    expect(rulesOverlap(rule({ minUnits: 200n, maxUnits: 300n }), base)).toBe(true);
  });

  it('admits an adjacent range, another level, another panel, another dimension and a disabled rule', () => {
    expect(rulesOverlap(rule({ minUnits: 1_001n, maxUnits: 2_000n }), base)).toBe(false);
    expect(rulesOverlap(rule({ customerId: CUSTOMER }), base)).toBe(false);
    expect(rulesOverlap(rule({ resellerTierId: TIER }), base)).toBe(false);
    expect(rulesOverlap(rule({ panelId: PANEL }), base)).toBe(false);
    expect(rulesOverlap(rule({ dimension: 'TIME' }), base)).toBe(false);
    expect(rulesOverlap(rule({ enabled: false }), base)).toBe(false);
  });

  it('never calls a rule its own overlap, so an edit may keep its range', () => {
    expect(rulesOverlap({ ...base }, base)).toBe(false);
  });
});

describe('the figures a customer types (brief D5, Package C)', () => {
  it.each([
    ['10', 1_000n],
    ['10.5', 1_050n],
    ['10.25', 1_025n],
    ['0.01', 1n],
    ['۱۰٫۵', 1_050n],
    ['١٠', 1_000n],
    [' 7 ', 700n],
  ] as const)('reads %s GB as %s hundredths', (text, units) => {
    expect(parseCustomServiceVolume(text)).toBe(units);
  });

  it.each(['10.255', '-1', '1e3', '1,5', '010', '', 'ده', '10.'])(
    'refuses %j as a volume',
    (text) => {
      expect(parseCustomServiceVolume(text)).toBeNull();
    },
  );

  it('turns hundredths into the same bytes an operator typing the figure would store', () => {
    for (const text of ['10', '10.25', '0.01', '1024']) {
      expect(customServiceVolumeBytes(parseCustomServiceVolume(text)!)).toBe(parseTrafficGb(text));
    }
  });

  it('formats hundredths back as they were typed', () => {
    expect(formatCustomServiceVolume(1_025n)).toBe('10.25');
    expect(formatCustomServiceVolume(1_050n)).toBe('10.5');
    expect(formatCustomServiceVolume(1_000n)).toBe('10');
    expect(formatCustomServiceVolume(1n)).toBe('0.01');
  });

  it.each([
    ['30', 30],
    ['1', 1],
    ['۳۰', 30],
    [String(CUSTOM_SERVICE_MAX_DAYS), CUSTOM_SERVICE_MAX_DAYS],
  ] as const)('reads %s days', (text, days) => {
    expect(parseCustomServiceDays(text)).toBe(days);
  });

  it.each(['0', '1.5', '-3', String(CUSTOM_SERVICE_MAX_DAYS + 1), '030', 'سی', ''])(
    'refuses %j as a number of days',
    (text) => {
      expect(parseCustomServiceDays(text)).toBeNull();
    },
  );
});

describe('the most a rule may charge across its range (Codex, PR #88)', () => {
  it('admits exactly the ceiling and refuses one minor unit past it', () => {
    expect(ruleAmountFits(1n, CUSTOM_SERVICE_RULE_AMOUNT_CEILING)).toBe(true);
    expect(ruleAmountFits(1n, CUSTOM_SERVICE_RULE_AMOUNT_CEILING + 1n)).toBe(false);
    expect(ruleAmountFits(4n, CUSTOM_SERVICE_RULE_AMOUNT_CEILING / 4n)).toBe(true);
    expect(ruleAmountFits(4n, CUSTOM_SERVICE_RULE_AMOUNT_CEILING / 4n + 1n)).toBe(false);
  });

  it('keeps the worst admitted order, both components at their ceiling, inside a bigint', () => {
    // The SQL CHECK computes volume_hundredths * price_per_gb + 50 in bigint; the base is
    // the volume component plus the time component.
    const volumeProduct = CUSTOM_SERVICE_RULE_AMOUNT_CEILING;
    const volumePrice = (volumeProduct + 50n) / 100n;
    const timePrice = CUSTOM_SERVICE_RULE_AMOUNT_CEILING;
    expect(volumeProduct + 50n).toBeLessThanOrEqual(MAX_MONEY_AMOUNT_MINOR);
    expect(volumePrice + timePrice).toBeLessThanOrEqual(MAX_MONEY_AMOUNT_MINOR / 2n);
  });
});
