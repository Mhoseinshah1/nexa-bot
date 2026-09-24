import { describe, expect, it } from 'vitest';
import {
  UNLIMITED_TRAFFIC_BYTES,
  money,
  splitByteCount,
  templateDefinition,
  type TemplateKey,
  type TemplateValues,
} from '@nexa/contracts';
import { CATALOGUE_FA, formatBytes, formatTrafficLimit, renderTemplateBody } from '@nexa/i18n';
import { splitBytes } from '../../apps/web/src/format';

/**
 * Traffic is shown in a unit, never as the stored byte integer (pre-release hardening §3).
 *
 * Presentation only: the stored bytes, the pricing and the provider semantics are untouched.
 * One rule — binary units, the largest reached, one truncated decimal — is used by the bot's
 * renderer and the Web Admin alike. An ALLOWANCE (`TRAFFIC_LIMIT`) of zero is "unlimited"; a
 * QUANTITY (`BYTES`) of zero is zero; an unknown figure is never passed and stays a dash.
 */

const GIB = 1_073_741_824n;

function render(key: TemplateKey, values: TemplateValues): string {
  return renderTemplateBody(templateDefinition(key), CATALOGUE_FA[key], values);
}

describe('the shared byte rule', () => {
  it('shows a known allowance in its largest binary unit', () => {
    expect(formatBytes(53_687_091_200n)).toBe('50 گیگابایت');
    expect(formatBytes(GIB)).toBe('1 گیگابایت');
    expect(formatBytes(2n * 1_099_511_627_776n)).toBe('2 ترابایت');
    expect(formatBytes(500n * 1_048_576n)).toBe('500 مگابایت');
  });

  it('keeps one decimal, truncated, never rounded up past what is there', () => {
    expect(formatBytes(GIB + GIB / 2n)).toBe('1.5 گیگابایت');
    // 1.99… GiB is 1.9, not 2: a figure is never shown as more than it is.
    expect(formatBytes(2n * GIB - 1n)).toBe('1.9 گیگابایت');
  });

  it('shows a small figure in bytes, and zero as zero bytes', () => {
    expect(formatBytes(5n)).toBe('5 بایت');
    expect(formatBytes(0n)).toBe('0 بایت');
  });

  it('stays exact past 2^53, where Number would round', () => {
    const eightPib = 8n * 1_125_899_906_842_624n;
    expect(splitByteCount(eightPib + 1n)).toEqual({ whole: 8n, tenths: 0n, unit: 'PIB' });
    expect(formatBytes(eightPib + 1n)).toBe('8 پتابایت');
  });

  it('shows an unlimited allowance as the word for unlimited, never as 0', () => {
    expect(formatTrafficLimit(UNLIMITED_TRAFFIC_BYTES)).toBe('نامحدود');
    expect(formatTrafficLimit(53_687_091_200n)).toBe('50 گیگابایت');
  });

  it('is the Web Admin’s rule too, so one figure reads the same on both surfaces', () => {
    expect(splitBytes(53_687_091_200n)).toEqual({ value: '50', unit: 'web.unit_gib' });
    expect(splitBytes(GIB + GIB / 2n)).toEqual({ value: '1.5', unit: 'web.unit_gib' });
    expect(splitBytes(5n)).toEqual({ value: '5', unit: 'web.unit_bytes' });
  });
});

describe('the renderer owns the unit', () => {
  const order = {
    productTitle: 'پلن ویژه',
    durationDays: 30,
    username: 'zahra01',
    total: money(250_000n, 'IRT'),
  };

  it('renders a new-service order summary’s traffic in a unit, not the stored integer', () => {
    const text = render('bot.order.summary', { ...order, trafficBytes: 53_687_091_200n });
    expect(text).toContain('حجم: 50 گیگابایت');
    expect(text).not.toContain('53687091200');
  });

  it('renders an unlimited plan in a summary as unlimited, never as 0', () => {
    const text = render('bot.order.summary', { ...order, trafficBytes: UNLIMITED_TRAFFIC_BYTES });
    expect(text).toContain('حجم: نامحدود');
    for (const key of [
      'bot.order.summary_discounted',
      'bot.order.summary_cashback',
      'bot.order.summary_discounted_cashback',
    ] as const) {
      expect(
        templateDefinition(key).placeholders.find((p) => p.token === 'trafficBytes')?.type,
      ).toBe('TRAFFIC_LIMIT');
    }
  });

  it('renders the service detail: zero USED is zero, zero ALLOWANCE is unlimited', () => {
    const text = render('bot.service.detail', {
      productTitle: 'پلن ویژه',
      state: 'ACTIVE',
      usedTrafficBytes: 0n,
      totalTrafficBytes: UNLIMITED_TRAFFIC_BYTES,
    });
    expect(text).toContain('مصرف: 0 بایت از نامحدود');

    const limited = render('bot.service.detail', {
      productTitle: 'پلن ویژه',
      state: 'ACTIVE',
      usedTrafficBytes: 10n * GIB,
      totalTrafficBytes: 53_687_091_200n,
    });
    expect(limited).toContain('مصرف: 10 گیگابایت از 50 گیگابایت');
  });

  it('renders an add-traffic package’s added volume in a unit, and a package that adds none as zero', () => {
    const quote = render('bot.service.action_quote', {
      productTitle: 'حجم اضافه',
      trafficBytes: 10n * GIB,
      durationDays: 0,
      total: money(50_000n, 'IRT'),
    });
    expect(quote).toContain('حجم افزوده: 10 گیگابایت');
    // An add-time package adds no traffic: zero is zero here, not "unlimited".
    const time = render('bot.service.action_quote', {
      productTitle: 'زمان اضافه',
      trafficBytes: 0n,
      durationDays: 30,
      total: money(50_000n, 'IRT'),
    });
    expect(time).toContain('حجم افزوده: 0 بایت');
    expect(time).not.toContain('نامحدود');
  });

  it('renders the receipt caption’s volume label, an unlimited plan included', () => {
    expect(render('bot.admin.receipt_traffic', { trafficBytes: 53_687_091_200n })).toBe(
      '50 گیگابایت',
    );
    expect(render('bot.admin.receipt_traffic', { trafficBytes: UNLIMITED_TRAFFIC_BYTES })).toBe(
      'نامحدود',
    );
  });

  it('renders the administrator’s service view and the usage reminders in units', () => {
    const admin = render('bot.admin.service', {
      usedTrafficBytes: GIB,
      totalTrafficBytes: 53_687_091_200n,
    });
    expect(admin).toContain('مصرف: 1 گیگابایت از 50 گیگابایت');
    const reminder = render('bot.service.usage_first', {
      service: 'zahra01',
      usagePercent: 80,
      usedTraffic: 40n * GIB,
      totalTraffic: 53_687_091_200n,
    });
    expect(reminder).toContain('(40 گیگابایت از 50 گیگابایت)');
  });

  it('leaves a value that is not a whole number exactly as given rather than guessing', () => {
    expect(render('bot.admin.receipt_traffic', { trafficBytes: '—' })).toBe('—');
  });
});
