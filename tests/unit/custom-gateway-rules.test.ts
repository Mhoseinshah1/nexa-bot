import { describe, expect, it } from 'vitest';
import {
  CUSTOM_ORDER_ID_PATTERN,
  money,
  normaliseAllowlistEntry,
  normaliseCustomGatewayBaseUrl,
  setPaymentGatewayEndpointRequestSchema,
} from '@nexa/contracts';
import {
  CUSTOM_ORDER_ID_RANDOM_BYTES,
  customAmountOf,
  customBridgeSignedPrefix,
  customJudgement,
  customMoneyWire,
  customOrderId,
  customRequestStringToSign,
  isSafeReference,
  parseCustomMoney,
} from '../../apps/api/src/modules/commerce/payments/domain/custom-gateway';

/**
 * The custom gateway's pure rules (`docs/protocols/custom-gateway.md`). The verdict is the one
 * thing that can move money, so each status and each mismatch is pinned and mutation-checked
 * (`docs/custom-gateway-falsification.md`).
 */

const ORDER = 'cg_7Q2M8K4ZJ1W3X9R5T0V6B2N8CD';
const REF = 'brg-20261026-000417';
const SENT = 1_250_000n;
const irr = (value: bigint | string) => ({
  value: typeof value === 'string' ? value : value.toString(),
  currency: 'IRR',
});
const observed = (overrides: Record<string, unknown> = {}) => ({
  invoiceId: ORDER,
  reference: REF,
  status: 'PAID',
  amount: irr(SENT),
  amountPaid: irr(SENT),
  ...overrides,
});
const expected = { orderId: ORDER, reference: REF, sentAmount: SENT };

describe('the wire unit is the rial (protocol §2.2)', () => {
  it('sends 125,000 Toman as "1250000" rial, by the one x10 helper', () => {
    expect(customAmountOf(money(125_000n, 'IRT'))).toBe(1_250_000n);
    expect(customMoneyWire(1_250_000n)).toEqual({ value: '1250000', currency: 'IRR' });
  });

  it('sends a rial sale as it is — divisibility is the bridge’s to refuse, never rounded here', () => {
    expect(customAmountOf(money(1_250_005n, 'IRR'))).toBe(1_250_005n);
  });

  it('refuses a non-positive figure and any other currency', () => {
    expect(customAmountOf(money(0n, 'IRT'))).toBeNull();
    expect(customAmountOf(money(0n, 'IRR'))).toBeNull();
    expect(customAmountOf(money(100n, 'USD' as never))).toBeNull();
  });
});

describe('a protocol Money is read exactly', () => {
  it('reads a decimal string of IRR', () => {
    expect(parseCustomMoney(irr('0'))).toBe(0n);
    expect(parseCustomMoney(irr('1250000'))).toBe(1_250_000n);
  });

  it('refuses a JSON number, a sign, a decimal point, an exponent, separators, another currency', () => {
    for (const bad of [
      { value: 1250000, currency: 'IRR' },
      irr('-1'),
      irr('1250000.0'),
      irr('1e6'),
      irr('1,250,000'),
      irr('01'),
      irr('۱۲۵'),
      { value: '1250000', currency: 'IRT' },
      { value: '1250000' },
      '1250000',
      null,
      irr('99999999999999999999'),
    ]) {
      expect(parseCustomMoney(bad)).toBeNull();
    }
  });
});

describe('the verdict — only a signed inquiry decides (protocol §6)', () => {
  it('PAID for this invoice id, this reference and exactly the amount asked AND paid is the one approval', () => {
    expect(customJudgement(observed(), expected)).toEqual({
      verdict: 'APPROVED',
      mismatchReason: null,
    });
  });

  it('PENDING and an unknown status are still open: the deadline decides', () => {
    for (const status of ['PENDING', 'paid', 'SETTLED', '', null, 7]) {
      expect(customJudgement(observed({ status }), expected).verdict).toBe('OPEN');
    }
  });

  it('FAILED and EXPIRED fail the attempt', () => {
    for (const status of ['FAILED', 'EXPIRED']) {
      expect(customJudgement(observed({ status, amountPaid: null }), expected)).toEqual({
        verdict: 'UNSUCCESSFUL',
        mismatchReason: null,
      });
      expect(customJudgement(observed({ status, amountPaid: irr(0n) }), expected).verdict).toBe(
        'UNSUCCESSFUL',
      );
    }
  });

  it('FAILED or EXPIRED that says money WAS captured is held, never failed', () => {
    expect(customJudgement(observed({ status: 'FAILED' }), expected)).toEqual({
      verdict: 'MISMATCH',
      mismatchReason: 'PROVIDER_STATUS_CONTRADICTS_AMOUNT_PAID',
    });
  });

  it('UNDERPAID and OVERPAID are held for an operator, never approved', () => {
    expect(
      customJudgement(observed({ status: 'UNDERPAID', amountPaid: irr(1_000_000n) }), expected),
    ).toEqual({ verdict: 'MISMATCH', mismatchReason: 'PROVIDER_UNDERPAID' });
    expect(
      customJudgement(observed({ status: 'OVERPAID', amountPaid: irr(1_500_000n) }), expected),
    ).toEqual({ verdict: 'MISMATCH', mismatchReason: 'PROVIDER_OVERPAID' });
    // Even when the figures happen to be equal: the bridge's own word is "not what was asked".
    expect(customJudgement(observed({ status: 'OVERPAID' }), expected).verdict).toBe('MISMATCH');
  });

  it('a PAID for another invoice id, another reference, no reference, or other figures is a MISMATCH', () => {
    const reasons = [
      [observed({ invoiceId: 'cg_OTHER' }), 'PROVIDER_ORDER_ID_MISMATCH'],
      [observed({ reference: 'brg-other' }), 'PROVIDER_REFERENCE_MISMATCH'],
      [observed({ reference: null }), 'PROVIDER_REFERENCE_MISSING'],
      [observed({ reference: 'bad ref with spaces' }), 'PROVIDER_REFERENCE_MISSING'],
      [observed({ amount: irr(SENT - 10n) }), 'PROVIDER_AMOUNT_MISMATCH'],
      [observed({ amount: irr(SENT + 10n) }), 'PROVIDER_AMOUNT_MISMATCH'],
      [observed({ amount: { value: Number(SENT), currency: 'IRR' } }), 'PROVIDER_AMOUNT_MISMATCH'],
      [observed({ amountPaid: irr(SENT - 1n) }), 'PROVIDER_AMOUNT_PAID_MISMATCH'],
      [observed({ amountPaid: irr(SENT + 1n) }), 'PROVIDER_AMOUNT_PAID_MISMATCH'],
      [observed({ amountPaid: null }), 'PROVIDER_AMOUNT_PAID_MISMATCH'],
    ] as const;
    for (const [observation, reason] of reasons) {
      expect(customJudgement(observation, expected)).toEqual({
        verdict: 'MISMATCH',
        mismatchReason: reason,
      });
    }
  });

  it('asked by order id after a lost create, any well-formed reference is this payment’s', () => {
    expect(
      customJudgement(observed({ reference: 'brg-x' }), { ...expected, reference: null }).verdict,
    ).toBe('APPROVED');
  });
});

describe('identifiers', () => {
  it('an invoice id is cg_ + 26 Crockford base32 from 17 random bytes', () => {
    const id = customOrderId(new Uint8Array(CUSTOM_ORDER_ID_RANDOM_BYTES).fill(255));
    expect(id).toMatch(CUSTOM_ORDER_ID_PATTERN);
    expect(customOrderId(new Uint8Array(17))).toBe(`cg_${'0'.repeat(26)}`);
    expect(() => customOrderId(new Uint8Array(16))).toThrow();
  });

  it('a reference is the protocol’s shape or nothing', () => {
    expect(isSafeReference(REF)).toBe(true);
    for (const bad of ['', 'a b', 'x'.repeat(65), 'a/b', 12, null]) {
      expect(isSafeReference(bad)).toBe(false);
    }
  });
});

describe('the signed strings — one secret, three prefixes (§4, §5)', () => {
  it('a request signs six lines: prefix, method, protocol path, timestamp, nonce, body hash', () => {
    expect(
      customRequestStringToSign({
        method: 'POST',
        path: '/v1/payments',
        timestamp: '1793007660',
        nonce: 'ab',
        bodySha256: 'cd',
      }),
    ).toBe('NEXA-CGW-V1-REQUEST\nPOST\n/v1/payments\n1793007660\nab\ncd');
  });

  it('a response binds the request’s nonce; a callback has its own prefix', () => {
    expect(customBridgeSignedPrefix('response', '17', 'nn')).toBe('NEXA-CGW-V1-RESPONSE\n17\nnn\n');
    expect(customBridgeSignedPrefix('callback', '17', null)).toBe('NEXA-CGW-V1-CALLBACK\n17\n');
  });
});

describe('the bridge address and the allow-list (§1, §9)', () => {
  it('takes an https URL with an optional port and path prefix, normalised', () => {
    expect(normaliseCustomGatewayBaseUrl(' https://Pay.Example.com/nexa/ ')).toBe(
      'https://pay.example.com/nexa',
    );
    expect(normaliseCustomGatewayBaseUrl('https://pay.example.com:8443')).toBe(
      'https://pay.example.com:8443',
    );
    expect(normaliseCustomGatewayBaseUrl('https://[2001:db8::1]/b')).toBe(
      'https://[2001:db8::1]/b',
    );
  });

  it('refuses http, userinfo, a query, a fragment, a dot segment, spaces and other schemes', () => {
    for (const bad of [
      'http://pay.example.com',
      'https://user:pass@pay.example.com',
      'https://user@pay.example.com',
      'https://pay.example.com/?a=1',
      'https://pay.example.com/#x',
      'https://pay.example.com/a/../b',
      'https://pay.example.com/a b',
      'https://pay.example.com\\evil',
      'ftp://pay.example.com',
      'https://',
      'https://pay.example.com:99999',
      `https://pay.example.com/${'a'.repeat(520)}`,
      'javascript:alert(1)',
    ]) {
      expect(normaliseCustomGatewayBaseUrl(bad), bad).toBeNull();
    }
  });

  it('an allow-list entry is an address or a CIDR with a prefix of at least one', () => {
    expect(normaliseAllowlistEntry('203.0.113.7')).toBe('203.0.113.7');
    expect(normaliseAllowlistEntry('203.0.113.0/24')).toBe('203.0.113.0/24');
    expect(normaliseAllowlistEntry('2001:DB8::/32')).toBe('2001:db8::/32');
    for (const bad of [
      '0.0.0.0/0',
      '::/0',
      '10.0.0.0/33',
      '300.1.1.1',
      '10.0.0',
      'x',
      '::ffff:1.2.3.4',
      '',
    ]) {
      expect(normaliseAllowlistEntry(bad), bad).toBeNull();
    }
  });

  it('the wire schema refuses an http URL and a bad CIDR, and dedupes the list', () => {
    expect(
      setPaymentGatewayEndpointRequestSchema.safeParse({
        idempotencyKey: 'k'.repeat(8),
        baseUrl: 'http://pay.example.com',
        ipAllowlist: [],
      }).success,
    ).toBe(false);
    expect(
      setPaymentGatewayEndpointRequestSchema.safeParse({
        idempotencyKey: 'k'.repeat(8),
        baseUrl: 'https://pay.example.com',
        ipAllowlist: ['nope'],
      }).success,
    ).toBe(false);
    const parsed = setPaymentGatewayEndpointRequestSchema.parse({
      idempotencyKey: 'k'.repeat(8),
      baseUrl: 'https://pay.example.com/',
      ipAllowlist: ['10.0.0.1', '10.0.0.1'],
    });
    expect(parsed).toMatchObject({ baseUrl: 'https://pay.example.com', ipAllowlist: ['10.0.0.1'] });
  });
});
