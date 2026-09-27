import { describe, expect, it } from 'vitest';
import {
  BYTES_PER_GB,
  MAX_TRAFFIC_BYTES,
  formatTrafficGb,
  parseTrafficGb,
  productWriteSchema,
  serviceAddonWriteSchema,
  trafficBytesAfterEdit,
} from '@nexa/contracts';

/**
 * WP21 (brief §4): a person types traffic in GB with at most two decimals; bytes are what
 * is stored. One GB is the binary gigabyte this codebase has always displayed.
 */
describe('a typed GB figure, as bytes', () => {
  it('is 1,073,741,824 bytes for 1 GB', () => {
    expect(BYTES_PER_GB).toBe(1_073_741_824n);
    expect(parseTrafficGb('1')).toBe(1_073_741_824n);
  });

  it('takes 10.25 exactly, and 1.5 and 1.50 alike', () => {
    expect(parseTrafficGb('10.25')).toBe(11_005_853_696n);
    expect(parseTrafficGb('1.5')).toBe(1_610_612_736n);
    expect(parseTrafficGb('1.50')).toBe(1_610_612_736n);
  });

  it('rounds a hundredth that is not a whole number of bytes to the nearest byte', () => {
    // 0.01 GB is 10,737,418.24 bytes: down. 0.03 GB is 32,212,254.72 bytes: up.
    expect(parseTrafficGb('0.01')).toBe(10_737_418n);
    expect(parseTrafficGb('0.03')).toBe(32_212_255n);
  });

  it('never goes through floating point', () => {
    // Every hundredth from 0.00 to 99.99 against the exact rational answer, in bigint.
    for (let hundredths = 0n; hundredths < 10_000n; hundredths += 1n) {
      const text = `${String(hundredths / 100n)}.${String(hundredths % 100n).padStart(2, '0')}`;
      const exact = hundredths * BYTES_PER_GB;
      const expected = exact / 100n + (exact % 100n >= 50n ? 1n : 0n);
      expect(parseTrafficGb(text)).toBe(expected);
    }
    // Where a double would have drifted: 0.1 + 0.2 style figures.
    expect(parseTrafficGb('0.3')).toBe((30n * BYTES_PER_GB + 50n) / 100n);
    expect(parseTrafficGb('1024000')).toBe(MAX_TRAFFIC_BYTES);
  });

  it('refuses more than two decimals, a sign, an exponent and anything ambiguous', () => {
    for (const text of [
      '1.234',
      '0.001',
      '-1',
      '+1',
      '1e3',
      '1E3',
      '.5',
      '1.',
      '1,5',
      '1,000',
      '1 000',
      '01',
      '0x10',
      '۱',
      '١.٥',
      '',
      ' ',
      'NaN',
      'Infinity',
      '53687091200 bytes',
    ]) {
      expect(parseTrafficGb(text), JSON.stringify(text)).toBeNull();
    }
  });

  it('reads zero as zero, never as unlimited', () => {
    expect(parseTrafficGb('0')).toBe(0n);
    expect(parseTrafficGb('0.00')).toBe(0n);
  });
});

describe('a stored byte count, as the figure an edit form shows', () => {
  it('reopens a saved figure as typed', () => {
    for (const text of ['1', '1.5', '10.25', '0.01', '0.03', '99.99', '1024000']) {
      const bytes = parseTrafficGb(text);
      expect(bytes).not.toBeNull();
      expect(formatTrafficGb(bytes ?? 0n)).toBe(text);
    }
    expect(formatTrafficGb(parseTrafficGb('1.50') ?? 0n)).toBe('1.5');
  });

  it('shows a historical byte count at its nearest hundredth', () => {
    expect(formatTrafficGb(53_687_091_200n)).toBe('50');
    expect(formatTrafficGb(1_000_000_000n)).toBe('0.93');
  });

  it('keeps the stored bytes when the figure it showed comes back unchanged', () => {
    const stored = 1_000_000_000n;
    const shown = parseTrafficGb(formatTrafficGb(stored)) ?? 0n;
    expect(shown).not.toBe(stored);
    expect(trafficBytesAfterEdit(stored, shown)).toBe(stored);
    // Any other figure is what the operator typed.
    const typed = parseTrafficGb('0.94') ?? 0n;
    expect(trafficBytesAfterEdit(stored, typed)).toBe(typed);
  });

  it('never keeps a figure over a change to or from zero', () => {
    // 1,000 bytes displays as `0`; an edit to unlimited must not keep it.
    expect(trafficBytesAfterEdit(1_000n, 0n)).toBe(0n);
    expect(trafficBytesAfterEdit(0n, 10_737_418n)).toBe(10_737_418n);
  });
});

describe('the write schemas', () => {
  const product = (trafficGb: string | null) => ({
    idempotencyKey: 'wp21-product-key',
    title: 'پلن',
    description: null,
    audience: 'EVERYONE',
    sortOrder: 0,
    panelId: null,
    durationDays: 30,
    trafficGb,
    deviceLimit: null,
    priceAmount: null,
    priceCurrency: null,
    categoryId: null,
  });

  it('takes GB with two decimals, and null as the explicit unlimited', () => {
    expect(productWriteSchema.safeParse(product('10.25')).success).toBe(true);
    expect(productWriteSchema.safeParse(product(null)).success).toBe(true);
  });

  it('refuses a product of zero traffic rather than reading it as unlimited', () => {
    expect(productWriteSchema.safeParse(product('0')).success).toBe(false);
    expect(productWriteSchema.safeParse(product('0.00')).success).toBe(false);
  });

  it('refuses three decimals, and a figure past the cap', () => {
    expect(productWriteSchema.safeParse(product('1.234')).success).toBe(false);
    expect(productWriteSchema.safeParse(product('1024000')).success).toBe(true);
    expect(productWriteSchema.safeParse(product('1024000.01')).success).toBe(false);
  });

  it('no longer takes a raw byte count', () => {
    const withBytes = { ...product('1'), trafficGb: undefined, trafficBytes: '53687091200' };
    expect(productWriteSchema.safeParse(withBytes).success).toBe(false);
  });

  it('holds an add-on to the same rule, and never to zero', () => {
    const addon = (trafficGb: string | null) => ({
      idempotencyKey: 'wp21-addon-key',
      kind: 'ADD_TRAFFIC',
      title: 'حجم اضافه',
      sortOrder: 0,
      trafficGb,
      durationDays: null,
      priceAmount: null,
      priceCurrency: null,
    });
    expect(serviceAddonWriteSchema.safeParse(addon('2.5')).success).toBe(true);
    expect(serviceAddonWriteSchema.safeParse(addon('0')).success).toBe(false);
    expect(serviceAddonWriteSchema.safeParse(addon('2.555')).success).toBe(false);
  });
});
