import { describe, expect, it } from 'vitest';
import {
  MANAGEMENT_EVENT_CODES,
  isManagementEventCode,
  SETTINGS,
  settingDefinition,
  parseSettingValue,
} from '@nexa/contracts';
import {
  CURRENCY_LABEL_FOR_TEST,
  formatMoney,
  formatMoneyText,
  formatNumber,
  splitDuration,
} from '../../apps/web/src/format';

/**
 * Owner revision 1 — money is rendered in full, and takes its unit from the
 * value.
 *
 * The defect these replace is in the preview: `tomanShort()` rendered
 * `۱۳ میلیون تومان` on every dashboard KPI, and `toman()` appended a hardcoded
 * Toman to whatever it was given.
 */
describe('money', () => {
  it('never abbreviates, whatever the magnitude', () => {
    expect(formatMoney({ amountMinor: '13125012', currency: 'IRT' }).amount).toBe('13,125,012');
    expect(formatMoney({ amountMinor: '13000000000', currency: 'IRT' }).amount).toBe(
      '13,000,000,000',
    );
    // The words the preview used. None of them may appear.
    const rendered = formatMoneyText({ amountMinor: '13000000', currency: 'IRT' });
    for (const abbreviation of ['میلیون', 'میلیارد', 'هزار', 'M', 'k']) {
      expect(rendered).not.toContain(abbreviation);
    }
  });

  it('takes the unit from the value rather than from the caller', () => {
    expect(formatMoney({ amountMinor: '20000', currency: 'IRT' }).unit).toBe('تومان');
    expect(formatMoney({ amountMinor: '20000', currency: 'IRR' }).unit).toBe('ریال');
    // A Rial installation must never be shown a Toman label. Same digits, and
    // the units differ — which is the entire point of carrying the currency.
    const toman = formatMoney({ amountMinor: '20000', currency: 'IRT' });
    const rial = formatMoney({ amountMinor: '20000', currency: 'IRR' });
    expect(toman.amount).toBe(rial.amount);
    expect(toman.unit).not.toBe(rial.unit);
  });

  it('groups thousands', () => {
    expect(formatMoney({ amountMinor: '1', currency: 'IRT' }).amount).toBe('1');
    expect(formatMoney({ amountMinor: '999', currency: 'IRT' }).amount).toBe('999');
    expect(formatMoney({ amountMinor: '1000', currency: 'IRT' }).amount).toBe('1,000');
    expect(formatNumber(1234567)).toBe('1,234,567');
  });

  /**
   * The reason `amountMinor` is a decimal STRING on the wire. Parsing it into a
   * `number` here would undo, at the last step, the precision the whole money
   * type exists to keep.
   */
  it('renders an amount that does not fit in a double, exactly', () => {
    const huge = '9007199254740993';
    expect(Number(huge).toString()).not.toBe(huge); // the hazard is real
    expect(formatMoney({ amountMinor: huge, currency: 'IRT' }).amount).toBe(
      '9,007,199,254,740,993',
    );
  });

  it('scales by the currency exponent rather than assuming whole units', () => {
    // IRT and IRR are exponent 0; USD is 2. A formatter that assumed one would
    // render $12.34 as twelve hundred and thirty-four dollars.
    expect(formatMoney({ amountMinor: '1234', currency: 'USD' }).amount).toBe('12.34');
    expect(formatMoney({ amountMinor: '1234', currency: 'IRT' }).amount).toBe('1,234');
  });

  it('renders a negative amount with a real minus sign', () => {
    expect(formatMoney({ amountMinor: '-5000', currency: 'IRT' }).amount).toBe('−5,000');
  });

  it('has a label for every currency the contract declares', () => {
    // A `Record<CurrencyCode, ...>` makes this a compile error too; the test is
    // here because a blank unit on a money figure is not a failure anybody
    // notices from a type alone.
    for (const [code, label] of Object.entries(CURRENCY_LABEL_FOR_TEST)) {
      expect(label, code).not.toBe('');
    }
  });
});

describe('durations', () => {
  it('splits into the coarsest exact unit', () => {
    expect(splitDuration(180_000)).toEqual({ value: 3, unit: 'minute' });
    expect(splitDuration(3_600_000)).toEqual({ value: 1, unit: 'hour' });
    expect(splitDuration(10_000)).toEqual({ value: 10, unit: 'second' });
  });
});

/**
 * Owner revision 21 — the Web Admin's alerts page is management-facing, and the
 * routine operational stream belongs to the Telegram report group.
 */
describe('the management event scope', () => {
  it('includes administrator changes by prefix, so a new one cannot fall out', () => {
    for (const code of [
      'admin.create',
      'admin.roles_change',
      'admin.status_change',
      'admin.password_change',
      // The one nobody has written yet. A prefix is what makes this pass.
      'admin.some_future_change',
    ]) {
      expect(isManagementEventCode(code), code).toBe(true);
    }
  });

  it('excludes the routine operational stream', () => {
    for (const code of [
      'panel.health.unreachable',
      'panel.health.degraded',
      'panel.health.auth_failed',
      'panel.monitor.probe',
      'system.ping',
      'http.error',
      'request.invalid',
      'notification.render_failed',
      'notification.transport_threw',
      'notification.sweep_withdrawn',
    ]) {
      expect(isManagementEventCode(code), code).toBe(false);
    }
  });

  it('includes the capacity and channel-failure conditions an operator must act on', () => {
    for (const code of [
      'panel.monitor.scheduler_capacity_exceeded',
      'panel.monitor.tenant_budget_exceeded',
      'notification.attempts_exhausted',
      'internal.unhandled',
      'access.permission_denied',
      'auth.login_locked_out',
      'settings.stored_value_invalid',
    ]) {
      expect(isManagementEventCode(code), code).toBe(true);
    }
  });

  it('pairs every failure condition with its recovery', () => {
    // A scope that shows a failure and hides the news that it is over reads as
    // permanently broken.
    for (const code of MANAGEMENT_EVENT_CODES) {
      if (code.endsWith('_exceeded')) {
        expect(isManagementEventCode(code.replace('_exceeded', '_ok'))).toBe(true);
      }
      if (code.endsWith('stored_value_invalid')) {
        expect(isManagementEventCode('settings.stored_value_valid')).toBe(true);
      }
    }
  });
});

/**
 * Owner revisions 1, 22, 23 and 24 — the four settings they need, as the
 * registry actually declares them.
 */
describe('the settings the owner revisions add', () => {
  it('declares a store currency, so no amount has to assume Toman', () => {
    const definition = settingDefinition('sales.currency');
    expect(definition.schema.safeParse('IRT').success).toBe(true);
    expect(definition.schema.safeParse('IRR').success).toBe(true);
    expect(definition.schema.safeParse('USD').success).toBe(false);
  });

  it('accepts several support accounts, in order, and rejects a repeat', () => {
    expect(parseSettingValue('support.accounts', ['@Support1', '@Support2', '@Support3']).ok).toBe(
      true,
    );
    // Order is DATA, not decoration: two different orders are two different
    // values, so reordering is a real edit the server records.
    const first = parseSettingValue('support.accounts', ['@Support1', '@Support2']);
    const second = parseSettingValue('support.accounts', ['@Support2', '@Support1']);
    expect(first.ok && second.ok).toBe(true);
    expect(first.ok && second.ok && JSON.stringify(first.value)).not.toBe(
      second.ok ? JSON.stringify(second.value) : '',
    );

    expect(parseSettingValue('support.accounts', ['@Support1', '@support1']).ok).toBe(false);
    expect(parseSettingValue('support.accounts', ['no-at-sign']).ok).toBe(false);
    expect(parseSettingValue('support.accounts', ['@ab']).ok).toBe(false);
  });

  it('makes a channel carry a required-membership answer it cannot omit', () => {
    expect(
      parseSettingValue('telegram.channels', [
        { handle: '@Channel1', mandatory: true },
        { handle: '@NewsChannel', mandatory: false },
      ]).ok,
    ).toBe(true);
    // No default. A missing flag would have to be read as one of the two, and
    // both readings are wrong.
    expect(parseSettingValue('telegram.channels', [{ handle: '@Channel1' }]).ok).toBe(false);
    expect(
      parseSettingValue('telegram.channels', [
        { handle: '@Channel1', mandatory: true },
        { handle: '@channel1', mandatory: false },
      ]).ok,
    ).toBe(false);
  });

  it('stores the top-up minimum as an amount AND a currency', () => {
    expect(
      parseSettingValue('wallet.topup.minimum', { amountMinor: '20000', currency: 'IRT' }).ok,
    ).toBe(true);
    // A bare number is not money. This is the legacy financial surface's whole
    // defect: Toman implicit everywhere, no rate on any of seven gateways.
    expect(parseSettingValue('wallet.topup.minimum', 20000).ok).toBe(false);
    expect(parseSettingValue('wallet.topup.minimum', { amountMinor: '20000' }).ok).toBe(false);
    expect(
      parseSettingValue('wallet.topup.minimum', { amountMinor: 20000, currency: 'IRT' }).ok,
    ).toBe(false);
  });

  it('marks the four as having no consumer, and everything older as having one', () => {
    const planned = SETTINGS.filter((s) => s.consumer === 'PLANNED').map((s) => s.key);
    expect(planned.sort()).toEqual(
      ['sales.currency', 'support.accounts', 'telegram.channels', 'wallet.topup.minimum'].sort(),
    );
    for (const s of SETTINGS.filter((s) => s.key.startsWith('ops.notifications.'))) {
      expect(s.consumer, s.key).toBe('ACTIVE');
    }
  });
});
