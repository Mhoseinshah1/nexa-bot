import { describe, expect, it } from 'vitest';
import {
  UNLIMITED_TRAFFIC_BYTES,
  formatTrafficGb,
  money,
  parseTrafficGb,
  templateDefinition,
  type TemplateKey,
  type TemplateValues,
} from '@nexa/contracts';
import { CATALOGUE_FA, formatBytes, formatTrafficLimit, renderTemplateBody } from '@nexa/i18n';
import { formatTrafficGbText, splitBytes } from '../../apps/web/src/format';

/**
 * Traffic is shown in a unit, never as the stored byte integer (pre-release hardening §3),
 * and since Package C that unit is always GB, with at most two decimals.
 *
 * Presentation only: the stored bytes, the pricing and the provider semantics are untouched.
 * One rule — `formatTrafficGb`, grouped — is used by the bot's renderer and the Web Admin
 * alike. An ALLOWANCE (`TRAFFIC_LIMIT`) of zero is "unlimited"; a
 * QUANTITY (`BYTES`) of zero is zero; an unknown figure is never passed and stays a dash.
 */

const GIB = 1_073_741_824n;

function render(key: TemplateKey, values: TemplateValues): string {
  return renderTemplateBody(templateDefinition(key), CATALOGUE_FA[key], values);
}

describe('the shared traffic rule: GB, at most two decimals (Package C)', () => {
  it('shows every allowance in GB, with no noisy .00', () => {
    expect(formatBytes(10n * GIB)).toBe('10 گیگابایت');
    expect(formatBytes(53_687_091_200n)).toBe('50 گیگابایت');
    expect(formatBytes(GIB)).toBe('1 گیگابایت');
    expect(formatBytes(GIB + GIB / 2n)).toBe('1.5 گیگابایت');
    // What an operator typed as 10.25 is shown as 10.25, and 10.5 as 10.5 — never 10.50.
    expect(formatBytes(parseTrafficGb('10.25') as bigint)).toBe('10.25 گیگابایت');
    expect(formatBytes(parseTrafficGb('10.50') as bigint)).toBe('10.5 گیگابایت');
  });

  it('keeps a large allowance in GB, grouped, instead of switching unit', () => {
    expect(formatBytes(2n * 1_099_511_627_776n)).toBe('2,048 گیگابایت');
    expect(formatBytes(1_099_511_627_776n + GIB / 4n)).toBe('1,024.25 گیگابایت');
  });

  it('rounds to the nearest hundredth, never truncating to a figure that is not the nearest', () => {
    // 500 MiB is 0.48828… GB: 0.49.
    expect(formatBytes(500n * 1_048_576n)).toBe('0.49 گیگابایت');
    // One byte short of 2 GiB is 2 at two decimals.
    expect(formatBytes(2n * GIB - 1n)).toBe('2 گیگابایت');
  });

  it('shows zero, and a figure under half a hundredth, as 0 GB — never in bytes', () => {
    expect(formatBytes(0n)).toBe('0 گیگابایت');
    expect(formatBytes(5n)).toBe('0 گیگابایت');
    expect(formatBytes(5n)).not.toContain('بایت 5');
  });

  it('stays exact past 2^53, where Number would round', () => {
    const eightPib = 8n * 1_125_899_906_842_624n;
    expect(formatBytes(eightPib + 1n)).toBe('8,388,608 گیگابایت');
  });

  it('round-trips every figure an operator can type, at the boundaries', () => {
    for (const typed of [
      '0.01',
      '0.1',
      '0.99',
      '1',
      '9.99',
      '10',
      '10.5',
      '10.25',
      '999999999.99',
    ]) {
      const bytes = parseTrafficGb(typed) as bigint;
      const shown = formatTrafficGb(bytes);
      expect(shown).toBe(typed.replace(/(\.\d)0$/u, '$1'));
      expect(parseTrafficGb(shown)).toBe(bytes);
    }
  });

  it('shows an unlimited allowance as the word for unlimited, never as 0', () => {
    expect(formatTrafficLimit(UNLIMITED_TRAFFIC_BYTES)).toBe('نامحدود');
    expect(formatTrafficLimit(53_687_091_200n)).toBe('50 گیگابایت');
  });

  it('is the Web Admin’s rule too, so one figure reads the same on both surfaces', () => {
    for (const bytes of [
      0n,
      5n,
      GIB,
      11_005_853_696n,
      2n * 1_099_511_627_776n,
      500n * 1_048_576n,
    ]) {
      expect(`${formatTrafficGbText(bytes)} گیگابایت`).toBe(formatBytes(bytes));
    }
    // `splitBytes` is left to file sizes, which keep their unit.
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
    expect(text).toContain('مصرف: 0 گیگابایت از نامحدود');

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
    expect(time).toContain('حجم افزوده: 0 گیگابایت');
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
      remainingPercent: 20,
      usedTraffic: 40n * GIB,
      totalTraffic: 53_687_091_200n,
    });
    // WP-A9: the sentence speaks in traffic remaining, with the used figure in units beside it.
    expect(reminder).toContain('(40 گیگابایت از 50 گیگابایت مصرف شده)');
    expect(reminder).toContain('20 درصد');
  });

  it('leaves a value that is not a whole number exactly as given rather than guessing', () => {
    expect(render('bot.admin.receipt_traffic', { trafficBytes: '—' })).toBe('—');
  });
});
