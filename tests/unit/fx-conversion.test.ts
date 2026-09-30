import { describe, expect, it } from 'vitest';
import {
  FX_OUTLIER_MAX_DEVIATION_BPS,
  FX_POLICY_VERSION,
  PAYMENT_GATEWAY_DESCRIPTORS,
  conversionPolicyFor,
  convertQuoteCurrency,
  effectiveMinorPerUnit,
  fractionToDecimalText,
  fxQuoteId,
  fxQuoteStateFor,
  gatewayInvoiceViewSchema,
  normaliseRate,
  parseDecimalRate,
  parseUnitRatio,
  providerUnitsByCentralFx,
  rateDeviationBps,
  rateToDecimalText,
  rateWithinRails,
  takesFixedRate,
  telegramStarsFor,
  starsPerUsdtSchema,
} from '@nexa/contracts';
import {
  chooseQuote,
  judgeCandidate,
  toCandidate,
  type FxCandidate,
} from '../../apps/api/src/modules/commerce/fx/domain/fx-quote';

/**
 * Package FX — the pure rules (`docs/fx-audit.md` §3, §5). Every figure here is a
 * `bigint`; a float anywhere in these paths would be the defect the package refuses.
 */

describe('the rate as text', () => {
  it('parses a provider decimal into a mantissa and scale, dropping trailing zeros', () => {
    expect(parseDecimalRate('1035500')).toEqual({ mantissa: 1_035_500n, scale: 0 });
    expect(parseDecimalRate('1035500.50')).toEqual({ mantissa: 10_355_005n, scale: 1 });
    expect(parseDecimalRate('0.25')).toEqual({ mantissa: 25n, scale: 2 });
    expect(parseDecimalRate('277990')).toEqual({ mantissa: 277_990n, scale: 0 });
  });

  it('truncates past the cap rather than rounding up, and refuses anything that is not a plain decimal', () => {
    expect(parseDecimalRate('1.123456789')).toEqual({ mantissa: 112_345_678n, scale: 8 });
    for (const bad of ['-1', '+1', '1e6', '1,000', ' 1', '1.', '.5', 'abc', '', '01']) {
      expect(parseDecimalRate(bad), bad).toBeNull();
    }
  });

  it('round-trips through its decimal text', () => {
    for (const text of ['1035500', '1035500.5', '0.25', '7', '77.5']) {
      const rate = parseDecimalRate(text);
      expect(rate).not.toBeNull();
      expect(rateToDecimalText(rate!)).toBe(text);
    }
    expect(normaliseRate({ mantissa: 1_000n, scale: 3 })).toEqual({ mantissa: 1n, scale: 0 });
  });

  it('converts Rial and Toman exactly: one Toman is ten Rial, never a division that rounds', () => {
    // Nobitex quotes Rial; a 1,035,505 Rial figure is 103,550.5 Toman, kept exact.
    expect(convertQuoteCurrency({ mantissa: 1_035_505n, scale: 0 }, 'IRR', 'IRT')).toEqual({
      mantissa: 1_035_505n,
      scale: 1,
    });
    expect(convertQuoteCurrency({ mantissa: 1_035_500n, scale: 0 }, 'IRR', 'IRT')).toEqual({
      mantissa: 103_550n,
      scale: 0,
    });
    // Wallex quotes Toman; a Rial installation reads it ten times larger.
    expect(convertQuoteCurrency({ mantissa: 103_550n, scale: 0 }, 'IRT', 'IRR')).toEqual({
      mantissa: 1_035_500n,
      scale: 0,
    });
    expect(convertQuoteCurrency({ mantissa: 5n, scale: 0 }, 'IRT', 'IRT')).toEqual({
      mantissa: 5n,
      scale: 0,
    });
  });

  it('measures deviation in basis points on bigint across scales', () => {
    expect(rateDeviationBps({ mantissa: 110n, scale: 0 }, { mantissa: 100n, scale: 0 })).toBe(
      1_000n,
    );
    expect(rateDeviationBps({ mantissa: 90n, scale: 0 }, { mantissa: 100n, scale: 0 })).toBe(
      1_000n,
    );
    expect(rateDeviationBps({ mantissa: 1_005n, scale: 1 }, { mantissa: 100n, scale: 0 })).toBe(
      50n,
    );
    expect(rateDeviationBps({ mantissa: 100n, scale: 0 }, { mantissa: 0n, scale: 0 })).toBeNull();
  });

  it('refuses a rate outside the pair rails or not positive', () => {
    expect(rateWithinRails({ mantissa: 103_550n, scale: 0 }, 'USDT', 'IRT')).toBe(true);
    expect(rateWithinRails({ mantissa: 1_035_500n, scale: 0 }, 'USDT', 'IRR')).toBe(true);
    expect(rateWithinRails({ mantissa: 0n, scale: 0 }, 'USDT', 'IRT')).toBe(false);
    expect(rateWithinRails({ mantissa: 999n, scale: 0 }, 'USDT', 'IRT')).toBe(false);
    expect(rateWithinRails({ mantissa: 1_000_000_001n, scale: 0 }, 'USDT', 'IRT')).toBe(false);
    // The rails scale with the mantissa's scale: 1,000.00 Toman is inside.
    expect(rateWithinRails({ mantissa: 100_000n, scale: 2 }, 'USDT', 'IRT')).toBe(true);
  });
});

describe('the central conversion (FX-STARS)', () => {
  it('is ceil(payable × ratio / rate) in bigint: exact integer rounding', () => {
    // 105,000 Toman payable, 103,550 Toman per USDT, 100 Stars per USDT:
    // fiat per Star = 1,035.5; 105,000 / 1,035.5 = 101.40… → 102 Stars.
    const rate = { mantissa: 103_550n, scale: 0 };
    const ratio = parseUnitRatio('100')!;
    expect(providerUnitsByCentralFx(105_000n, rate, ratio)).toBe(102n);
    // Exactly divisible: 103,550 / 1,035.5 = 100, no extra Star.
    expect(providerUnitsByCentralFx(103_550n, rate, ratio)).toBe(100n);
    // One Toman over is one Star more.
    expect(providerUnitsByCentralFx(103_551n, rate, ratio)).toBe(101n);
    // A fractional ratio and a fractional rate, still exact: 77.5 Stars per USDT at
    // 103,550.5 Toman gives 1,336.135… Toman per Star; 105,000 / that = 78.58… → 79.
    expect(
      providerUnitsByCentralFx(
        105_000n,
        { mantissa: 1_035_505n, scale: 1 },
        parseUnitRatio('77.5')!,
      ),
    ).toBe(79n);
    // A positive payable is at least one Star.
    expect(providerUnitsByCentralFx(1n, rate, ratio)).toBe(1n);
    // Far past 2^53, where a float would round.
    expect(
      providerUnitsByCentralFx(
        9_007_199_254_740_993n,
        { mantissa: 1n, scale: 0 },
        parseUnitRatio('1')!,
      ),
    ).toBe(9_007_199_254_740_993n);
  });

  it('agrees with the fixed-rate rule when the effective figure is a whole number', () => {
    // 103,550 / 100 = 1,035.5 is not whole; 130,000 / 100 = 1,300 is, and matches Package A.
    const rate = { mantissa: 130_000n, scale: 0 };
    const ratio = parseUnitRatio('100')!;
    for (const payable of [105_000n, 260_000n, 260_001n, 1n]) {
      expect(providerUnitsByCentralFx(payable, rate, ratio)).toBe(
        telegramStarsFor(payable, 1_300n),
      );
    }
  });

  it('has no amount for a non-positive payable, rate or ratio', () => {
    const rate = { mantissa: 103_550n, scale: 0 };
    const ratio = parseUnitRatio('100')!;
    expect(providerUnitsByCentralFx(0n, rate, ratio)).toBeNull();
    expect(providerUnitsByCentralFx(-1n, rate, ratio)).toBeNull();
    expect(providerUnitsByCentralFx(10n, { mantissa: 0n, scale: 0 }, ratio)).toBeNull();
    expect(providerUnitsByCentralFx(10n, rate, { mantissa: 0n, scale: 0 })).toBeNull();
  });

  it('snapshots the effective figure per unit as an exact reduced fraction', () => {
    const effective = effectiveMinorPerUnit(
      { mantissa: 103_550n, scale: 0 },
      parseUnitRatio('100')!,
    );
    // 103,550 / 100 = 2,071 / 2 = 1,035.5 Toman per Star.
    expect(effective).toEqual({ numerator: 2_071n, denominator: 2n });
    expect(fractionToDecimalText(2_071n, 2n)).toBe('1035.5');
    expect(fractionToDecimalText(1n, 3n)).toBe('0.3333');
    expect(fractionToDecimalText(130_000n, 100n)).toBe('1300');
  });

  it('parses the ratio setting: positive decimals with at most four fractional digits, empty is unset', () => {
    expect(parseUnitRatio('100')).toEqual({ mantissa: 100n, scale: 0 });
    expect(parseUnitRatio('77.5')).toEqual({ mantissa: 775n, scale: 1 });
    expect(parseUnitRatio('0')).toBeNull();
    expect(parseUnitRatio('')).toBeNull();
    expect(parseUnitRatio('1.12345')).toBeNull();
    expect(parseUnitRatio('-3')).toBeNull();
    expect(starsPerUsdtSchema.safeParse('').success).toBe(true);
    expect(starsPerUsdtSchema.safeParse('1000000').success).toBe(false);
    expect(starsPerUsdtSchema.safeParse('۱۰۰').success).toBe(false);
  });
});

describe('the conversion policy', () => {
  it('resolves a single-policy route without a mode, and the Stars route by its mode', () => {
    expect(conversionPolicyFor(PAYMENT_GATEWAY_DESCRIPTORS.TONPAYS.conversion, undefined)).toBe(
      'SAME_UNIT',
    );
    expect(
      conversionPolicyFor(
        PAYMENT_GATEWAY_DESCRIPTORS.MANUAL_TRANSFER.conversion,
        'CENTRAL_FX_RATIO',
      ),
    ).toBe('SAME_UNIT');
    const stars = PAYMENT_GATEWAY_DESCRIPTORS.TELEGRAM_STARS.conversion;
    expect(conversionPolicyFor(stars, 'FIXED_RATE')).toBe('FIXED_RATE');
    expect(conversionPolicyFor(stars, 'CENTRAL_FX_RATIO')).toBe('CENTRAL_FX');
    // Backward compatibility: no value, or a value that is not the central mode, is the fixed rate.
    expect(conversionPolicyFor(stars, undefined)).toBe('FIXED_RATE');
    expect(conversionPolicyFor(stars, null)).toBe('FIXED_RATE');
    expect(conversionPolicyFor(stars, 'garbage')).toBe('FIXED_RATE');
  });

  it("reads the previous release's invoice view, a rate and no policy, as FIXED_RATE (Codex #122)", () => {
    const legacy = {
      provider: 'TELEGRAM_STARS',
      providerOrderId: 'order-1',
      providerInvoiceId: null,
      creationState: 'CREATED',
      creationErrorCode: null,
      providerStatus: null,
      providerPaid: null,
      lastInquiryAt: null,
      lastInquiryErrorCode: null,
      webhookStatusHint: null,
      lastWebhookAt: null,
      webhookCount: 0,
      providerUnit: 'XTR',
      sentAmount: '81',
      conversionRateMinor: '1300',
      providerChargeId: null,
      requestAmount: null,
      finalAmount: null,
      creditAmount: null,
      outcome: null,
      lateCompletionObservedAt: null,
      createdAt: '2026-09-30T10:00:00.000Z',
    };
    expect(gatewayInvoiceViewSchema.parse(legacy)).toMatchObject({
      conversionPolicy: 'FIXED_RATE',
      fx: null,
    });
    // No rate: the route bills in the sales currency.
    expect(
      gatewayInvoiceViewSchema.parse({ ...legacy, provider: 'TONPAYS', conversionRateMinor: null })
        .conversionPolicy,
    ).toBe('SAME_UNIT');
    // A policy this release sent is read as sent, whatever the rate beside it.
    expect(
      gatewayInvoiceViewSchema.parse({
        ...legacy,
        conversionPolicy: 'CENTRAL_FX',
        conversionRateMinor: null,
      }).conversionPolicy,
    ).toBe('CENTRAL_FX');
  });

  it('says which routes take an operator rate', () => {
    expect(takesFixedRate(PAYMENT_GATEWAY_DESCRIPTORS.TELEGRAM_STARS.conversion)).toBe(true);
    expect(takesFixedRate(PAYMENT_GATEWAY_DESCRIPTORS.TONPAYS.conversion)).toBe(false);
    expect(takesFixedRate(PAYMENT_GATEWAY_DESCRIPTORS.MANUAL_TRANSFER.conversion)).toBe(false);
  });
});

describe('freshness', () => {
  it('is FRESH inside the TTL, STALE_ALLOWED inside the stale limit, UNAVAILABLE past it', () => {
    expect(fxQuoteStateFor(0, 45, 900)).toBe('FRESH');
    expect(fxQuoteStateFor(45, 45, 900)).toBe('FRESH');
    expect(fxQuoteStateFor(46, 45, 900)).toBe('STALE_ALLOWED');
    expect(fxQuoteStateFor(900, 45, 900)).toBe('STALE_ALLOWED');
    expect(fxQuoteStateFor(901, 45, 900)).toBe('UNAVAILABLE');
  });

  it('floors the stale limit at the TTL, so a misordered pair cannot refuse a fresh quote', () => {
    expect(fxQuoteStateFor(100, 300, 60)).toBe('FRESH');
    expect(fxQuoteStateFor(301, 300, 60)).toBe('UNAVAILABLE');
  });

  it('builds a deterministic quote id from what was read and when', () => {
    const input = {
      source: 'NOBITEX' as const,
      baseAsset: 'USDT' as const,
      quoteCurrency: 'IRT' as const,
      rate: { mantissa: 1_035_500n, scale: 1 },
      sourceAt: new Date(1_700_000_000_000),
      fetchedAt: new Date(1_700_000_001_000),
      policyVersion: FX_POLICY_VERSION,
    };
    expect(fxQuoteId(input)).toBe('v1:NOBITEX:USDT-IRT:103550e-0:1700000000000:1700000001000');
    expect(fxQuoteId(input)).toBe(fxQuoteId({ ...input, rate: { mantissa: 103_550n, scale: 0 } }));
    expect(fxQuoteId({ ...input, sourceAt: null })).toBe(
      'v1:NOBITEX:USDT-IRT:103550e-0:-:1700000001000',
    );
  });
});

describe('judging a candidate against the last-known-good', () => {
  const candidate = (mantissa: bigint, source: 'NOBITEX' | 'WALLEX' = 'NOBITEX'): FxCandidate => ({
    source,
    rate: { mantissa, scale: 0 },
    sourceAt: null,
  });
  const lkg = { rate: { mantissa: 100_000n, scale: 0 }, trusted: true };

  it('accepts inside the outlier bound, refuses beyond it, and ignores an untrusted last-known-good', () => {
    expect(judgeCandidate(candidate(114_000n), 'USDT', 'IRT', lkg)).toEqual({ kind: 'ACCEPT' });
    expect(judgeCandidate(candidate(115_000n), 'USDT', 'IRT', lkg)).toEqual({ kind: 'ACCEPT' });
    expect(judgeCandidate(candidate(116_000n), 'USDT', 'IRT', lkg)).toEqual({
      kind: 'OUTLIER',
      deviationBps: 1_600n,
    });
    expect(FX_OUTLIER_MAX_DEVIATION_BPS).toBe(1_500n);
    // A ten-fold unit mistake is the case the bound exists for.
    expect(judgeCandidate(candidate(1_000_000n), 'USDT', 'IRT', lkg).kind).toBe('OUTLIER');
    // Past the stale limit the last-known-good is no fact about the market: the same figure is accepted.
    expect(
      judgeCandidate(candidate(1_000_000n), 'USDT', 'IRT', { ...lkg, trusted: false }),
    ).toEqual({
      kind: 'ACCEPT',
    });
    expect(judgeCandidate(candidate(1_000_000n), 'USDT', 'IRT', null)).toEqual({ kind: 'ACCEPT' });
  });

  it('refuses the absurd before any comparison', () => {
    expect(judgeCandidate(candidate(0n), 'USDT', 'IRT', null)).toEqual({ kind: 'NOT_POSITIVE' });
    expect(judgeCandidate(candidate(10n), 'USDT', 'IRT', null)).toEqual({ kind: 'OUT_OF_RAILS' });
  });

  it('brings a source reading into the sales currency before judging it', () => {
    expect(
      toCandidate(
        {
          source: 'NOBITEX',
          rate: { mantissa: 1_035_505n, scale: 0 },
          currency: 'IRR',
          sourceAt: null,
        },
        'IRT',
      ).rate,
    ).toEqual({ mantissa: 1_035_505n, scale: 1 });
  });

  it('chooses the first accepted candidate, or two agreeing outliers, and otherwise nothing', () => {
    const accept = { kind: 'ACCEPT' as const };
    const outlier = (bps: bigint) => ({ kind: 'OUTLIER' as const, deviationBps: bps });
    expect(chooseQuote([{ candidate: candidate(101_000n), verdict: accept }])?.rate.mantissa).toBe(
      101_000n,
    );
    // The primary is preferred whenever it is accepted, whatever the fallback says.
    expect(
      chooseQuote([
        { candidate: candidate(101_000n, 'NOBITEX'), verdict: accept },
        { candidate: candidate(100_500n, 'WALLEX'), verdict: accept },
      ])?.source,
    ).toBe('NOBITEX');
    // The market moved: both sources say 130,000 ± 3 %, the last-known-good is what is stale.
    expect(
      chooseQuote([
        { candidate: candidate(130_000n, 'NOBITEX'), verdict: outlier(3_000n) },
        { candidate: candidate(131_000n, 'WALLEX'), verdict: outlier(3_100n) },
      ])?.source,
    ).toBe('NOBITEX');
    // Two outliers that disagree with each other: nobody is trusted.
    expect(
      chooseQuote([
        { candidate: candidate(130_000n, 'NOBITEX'), verdict: outlier(3_000n) },
        { candidate: candidate(150_000n, 'WALLEX'), verdict: outlier(5_000n) },
      ]),
    ).toBeNull();
    // One outlier alone, or a refused figure, prices nothing.
    expect(chooseQuote([{ candidate: candidate(130_000n), verdict: outlier(3_000n) }])).toBeNull();
    expect(
      chooseQuote([{ candidate: candidate(10n), verdict: { kind: 'OUT_OF_RAILS' } }]),
    ).toBeNull();
    expect(chooseQuote([])).toBeNull();
  });
});
