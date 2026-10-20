import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  OPS_LOG_BUTTON_KINDS,
  OPS_LOG_TOPIC_CATEGORIES,
  OPS_LOG_TYPES,
  OPS_LOG_TYPE_IDS,
  SETTINGS,
  TEMPLATE_KEYS,
  TEMPLATES,
  formatPersianChange,
  formatPersianInteger,
  formatPersianPercent,
  opsLogButtonPath,
  opsLogTypeEnabled,
  opsLogTypeOfTemplate,
  opsLogTypeTopic,
  settingDefinition,
  toPersianDigits,
  type SettingKey,
} from '@nexa/contracts';
import {
  CATALOGUE_FA,
  DEFAULT_TEMPLATE_PRESENTATION,
  OPS_LOG_BODIES_FA,
  OPS_LOG_BUTTON_LABELS_FA,
  formatBytesForLog,
  renderTemplateBody,
} from '@nexa/i18n';
import { templateDefinition } from '@nexa/contracts';
import {
  publicHttpsOrigin,
  WebAdminButtonResolver,
} from '../../apps/api/src/modules/control/notifications/application/ops-button-resolver';

/**
 * Round 4 PR-D — the log types are a registry, and a registry is only worth having if a type
 * cannot exist without its message, its topic and its switch. Synthetic data only.
 */

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe('the log types registry', () => {
  it('implements every Appendix L item exactly once: L1-L31, with L30 folded into the report', () => {
    const items = OPS_LOG_TYPE_IDS.map((id) => OPS_LOG_TYPES[id].l);
    expect(new Set(items).size).toBe(items.length);
    const wanted = Array.from({ length: 31 }, (_, index) => `L${String(index + 1)}`).filter(
      (item) => item !== 'L30',
    );
    expect([...items].sort()).toEqual(wanted.sort());
  });

  it('gives every type a real topic and only real, distinct template keys', () => {
    const keys = new Set<string>(TEMPLATE_KEYS);
    const seen = new Map<string, string>();
    for (const id of OPS_LOG_TYPE_IDS) {
      expect(OPS_LOG_TOPIC_CATEGORIES, id).toContain(opsLogTypeTopic(id));
      expect(OPS_LOG_TYPES[id].templates.length, id).toBeGreaterThan(0);
      for (const key of OPS_LOG_TYPES[id].templates) {
        expect(keys.has(key), `${id}: ${key} is not a template`).toBe(true);
        expect(seen.get(key), `${key} belongs to two types`).toBeUndefined();
        seen.set(key, id);
        expect(opsLogTypeOfTemplate(key)).toBe(id);
      }
    }
  });

  it('gives every ops.log.* template, and every financial and support one, a type', () => {
    const orphans = TEMPLATE_KEYS.filter(
      (key) =>
        /^ops\.(log|financial|support)\./.test(key) &&
        // The storm roll-up is the error types' merged form, not a type of its own.
        key !== 'ops.log.storm_rollup' &&
        opsLogTypeOfTemplate(key) === null,
    );
    expect(orphans).toEqual([]);
  });

  it('puts the two new topics to use: customers in USERS, the nightly reports in REPORTS', () => {
    expect(OPS_LOG_TOPIC_CATEGORIES).toContain('USERS');
    expect(OPS_LOG_TOPIC_CATEGORIES).toContain('REPORTS');
    expect(opsLogTypeTopic('USER_NEW')).toBe('USERS');
    expect(opsLogTypeTopic('USER_BLOCK')).toBe('USERS');
    expect(opsLogTypeTopic('RESELLER_CHANGED')).toBe('USERS');
    for (const id of ['REPORT_SUMMARY', 'REPORT_FINANCIAL', 'REPORT_PANELS'] as const) {
      expect(opsLogTypeTopic(id)).toBe('REPORTS');
    }
  });

  it('switches a type off by listing it, and ignores a name it does not know', () => {
    expect(opsLogTypeEnabled([], 'USER_NEW')).toBe(true);
    expect(opsLogTypeEnabled(['USER_NEW'], 'USER_NEW')).toBe(false);
    expect(opsLogTypeEnabled(['SOMETHING_A_LATER_RELEASE_ADDED'], 'USER_NEW')).toBe(true);
  });

  it('declares the settings with the owner’s defaults: nothing off, no roll-up, 20 in 5 minutes, 23:59', () => {
    const value = (key: string) => settingDefinition(key as SettingKey).defaultValue;
    expect(value('ops.log.disabled_types')).toEqual([]);
    expect(value('ops.log.storm_rollup_enabled')).toBe(false);
    expect(value('ops.log.storm_threshold')).toBe(20);
    expect(value('ops.log.storm_window_minutes')).toBe(5);
    expect(value('ops.log.nightly_report_time')).toBe('23:59');
    const schema = settingDefinition('ops.log.nightly_report_time' as SettingKey).schema;
    expect(schema.safeParse('23:59').success).toBe(true);
    expect(schema.safeParse('24:00').success).toBe(false);
    expect(schema.safeParse('9:5').success).toBe(false);
    expect(SETTINGS.filter((setting) => setting.key.startsWith('ops.log.'))).toHaveLength(6);
  });
});

describe('the templates carry no id line and no English enum (global rules 1 and 2)', () => {
  const FAMILIES = /^ops\.(log|financial|support|notification)\./;
  const ID_TOKENS =
    /^(paymentId|orderId|serviceId|customerId|refundId|requestId|eventId|correlationId|tenantId|botInstanceId|providerOrderId)$/;
  const logKeys = TEMPLATE_KEYS.filter(
    (key) => FAMILIES.test(key) && key !== 'ops.notification.test',
  );

  it('declares no id token in any log template', () => {
    for (const key of logKeys) {
      const tokens = templateDefinition(key).placeholders.map((placeholder) => placeholder.token);
      expect(
        tokens.filter((token) => ID_TOKENS.test(token)),
        key,
      ).toEqual([]);
    }
  });

  it('has no id, tenant, bot or correlation line in any default body, and no English method enum', () => {
    for (const key of logKeys) {
      const body = CATALOGUE_FA[key];
      expect(body, key).not.toMatch(/شناسه (پرداخت|رخداد|همبستگی|بازگشت وجه): /u);
      expect(body, key).not.toMatch(/مستأجر|🏢|🤖 ربات:|🔗 شناسه پیگیری/u);
      expect(body, key).not.toMatch(/MANUAL_TRANSFER|TELEGRAM_STARS|\(GATEWAY\)|NOWPAYMENTS/);
      expect(body, key).not.toMatch(/میرزا|mirza/iu);
      expect(UUID.test(body), key).toBe(false);
    }
  });

  it('is a source scan over the value builders too: no template value is an id', () => {
    const root = join(__dirname, '../../apps/api/src/modules/commerce/ops-log/application');
    for (const file of ['presenters.ts', 'nightly-report.ts', 'event-presenter.ts']) {
      const source = readFileSync(join(root, file), 'utf8');
      // A value named for an id would put one in the stored payload.
      expect(source, file).not.toMatch(
        /(values\[['"]|\n\s+)(paymentId|orderId|serviceId|customerId|eventId|correlationId|tenantId)['"\]]?(:| =)/,
      );
    }
  });

  it('renders every default body with its own declaration: no token is left unresolved or undeclared', () => {
    for (const key of Object.keys(OPS_LOG_BODIES_FA)) {
      const definition = templateDefinition(key as never);
      const declared = new Set(definition.placeholders.map((placeholder) => placeholder.token));
      for (const token of CATALOGUE_FA[key as never].matchAll(/\{([A-Za-z_]+)\}/g)) {
        expect(declared.has(token[1] as string), `${key} uses {${String(token[1])}}`).toBe(true);
      }
    }
  });

  it('writes in Persian digits only where the template declares it', () => {
    for (const key of logKeys) {
      expect(templateDefinition(key).digits, key).toBe('PERSIAN');
    }
    const customerFacing = TEMPLATES.filter((template) => template.key.startsWith('bot.'));
    expect(customerFacing.some((template) => 'digits' in template)).toBe(false);
  });
});

describe('Persian digits', () => {
  it('converts digits and both separators, and nothing else', () => {
    expect(toPersianDigits('1,234.5 تومان 14:05 ab-12')).toBe('۱٬۲۳۴٫۵ تومان ۱۴:۰۵ ab-۱۲');
    expect(formatPersianInteger(12_420)).toBe('۱۲٬۴۲۰');
    expect(formatPersianInteger(-5n)).toBe('-۵');
    expect(formatPersianInteger(0)).toBe('۰');
  });

  it('computes a percentage by integer arithmetic and never prints NaN for an empty base', () => {
    expect(formatPersianPercent(98n, 1000n)).toBe('۹٫۸٪');
    expect(formatPersianPercent(1n, 2n)).toBe('۵۰٪');
    expect(formatPersianPercent(0n, 0n)).toBeNull();
    expect(formatPersianChange(1098n, 1000n)).toBe('▲ ۹٫۸٪');
    expect(formatPersianChange(900n, 1000n)).toBe('▼ ۱۰٪');
    expect(formatPersianChange(5n, 0n)).toBeNull();
  });

  it('renders money, instants, quantities and counts in Persian digits and leaves a STRING alone', () => {
    const text = renderTemplateBody(
      templateDefinition('ops.log.wallet_adjusted'),
      '{amount} | {balanceBefore} | {at} | {reason} | {telegramId}',
      {
        heading: 'h',
        amount: { amountMinor: 1_000n, currency: 'IRT' },
        balanceBefore: { amountMinor: 2_659_767n, currency: 'IRT' },
        balanceAfter: { amountMinor: 2_660_767n, currency: 'IRT' },
        reason: 'ref 12345',
        telegramId: '100200300',
        at: new Date('2026-10-19T08:30:00Z'),
      },
      'fa',
      DEFAULT_TEMPLATE_PRESENTATION,
    );
    expect(text).toBe('۱٬۰۰۰ تومان | ۲٬۶۵۹٬۷۶۷ تومان | ۱۴۰۵/۰۷/۲۷ ۱۲:۰۰ | ref 12345 | 100200300');
  });

  it('shows empty traffic as «۰ بایت», steps the unit down, and never prints NaN', () => {
    expect(formatBytesForLog(0n)).toBe('0 بایت');
    expect(formatBytesForLog(-5n)).toBe('0 بایت');
    expect(formatBytesForLog(200n * 1024n * 1024n)).toBe('200 مگابایت');
    expect(formatBytesForLog(30n * 1024n ** 3n)).toBe('30 گیگابایت');
    const text = renderTemplateBody(
      templateDefinition('ops.log.service_alert'),
      '{remainingBytes}',
      { remainingBytes: 0n },
      'fa',
      DEFAULT_TEMPLATE_PRESENTATION,
    );
    expect(text).toBe('۰ بایت');
  });
});

describe('the inline URL buttons', () => {
  it('addresses each button to its Web Admin page, and refuses an unsafe record id', () => {
    expect(opsLogButtonPath({ kind: 'USER', ref: 'abc-123' })).toBe('/users/abc-123');
    expect(opsLogButtonPath({ kind: 'PAYMENT', ref: 'abc-123' })).toBe('/payments/abc-123');
    expect(opsLogButtonPath({ kind: 'SERVICE', ref: 'abc-123' })).toBe('/services/abc-123');
    expect(opsLogButtonPath({ kind: 'PANEL', ref: 'abc-123' })).toBe('/panels/abc-123');
    expect(opsLogButtonPath({ kind: 'GATEWAY', ref: 'TONPAYS' })).toBe('/payment-gateways/TONPAYS');
    expect(opsLogButtonPath({ kind: 'MANUAL_CREDIT', ref: 'abc-123' })).toBe('/users/abc-123');
    expect(opsLogButtonPath({ kind: 'DASHBOARD' })).toBe('/');
    expect(opsLogButtonPath({ kind: 'USER', ref: '../admin' })).toBeNull();
    expect(opsLogButtonPath({ kind: 'USER' })).toBeNull();
  });

  it('has a Persian label for every kind', () => {
    for (const kind of OPS_LOG_BUTTON_KINDS) {
      expect(OPS_LOG_BUTTON_LABELS_FA[kind], kind).toMatch(/[؀-ۿ]/u);
    }
  });

  it('accepts only a public https origin, so Telegram never refuses a message for its button', () => {
    expect(publicHttpsOrigin('https://admin.example.com/anything')).toBe(
      'https://admin.example.com',
    );
    expect(publicHttpsOrigin('http://admin.example.com')).toBeNull();
    expect(publicHttpsOrigin('https://localhost:5173')).toBeNull();
    expect(publicHttpsOrigin('https://192.168.1.4')).toBeNull();
    expect(publicHttpsOrigin('https://intranet')).toBeNull();
    expect(publicHttpsOrigin('')).toBeNull();
    expect(publicHttpsOrigin(null)).toBeNull();
  });

  it('lays the buttons out two to a row, and sends none without an https address', async () => {
    const scope = { tenantId: 't' as never, botInstanceId: null };
    const make = (configured: string, fallback: string | null) =>
      new WebAdminButtonResolver({
        settings: { valueOf: async () => configured } as never,
        defaultOrigin: fallback,
        labelOf: (kind) => kind,
      });
    const buttons = [
      { kind: 'USER' as const, ref: 'u1' },
      { kind: 'PAYMENT' as const, ref: 'p1' },
      { kind: 'ORDER' as const, ref: 'o1' },
    ];
    expect(await make('', 'https://a.example.com').resolve(scope, buttons)).toEqual([
      { text: 'USER', url: 'https://a.example.com/users/u1', row: 0 },
      { text: 'PAYMENT', url: 'https://a.example.com/payments/p1', row: 0 },
      { text: 'ORDER', url: 'https://a.example.com/orders/o1', row: 1 },
    ]);
    // A configured address wins over the environment's.
    expect(
      (await make('https://b.example.com', 'https://a.example.com').resolve(scope, buttons))[0]
        ?.url,
    ).toBe('https://b.example.com/users/u1');
    expect(await make('', 'http://a.example.com').resolve(scope, buttons)).toEqual([]);
    expect(await make('', null).resolve(scope, buttons)).toEqual([]);
  });
});
