import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MANAGEMENT_CONDITION_CODES,
  MANAGEMENT_EVENT_CODES,
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

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

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
 *
 * This block used to assert `isManagementEventCode`, a predicate NOTHING in
 * production called: the shipped rule was the SQL in
 * `DrizzleOperationalEventReader`, and the two shared constants rather than a
 * rule. Worse, every code it asserted over was invented for the assertion —
 * `admin.roles_change`, `notification.attempts_exhausted`, `internal.unhandled`
 * — and four of them were codes no recorder anywhere ever writes. Thirty-nine
 * green assertions described a page that showed four kinds of nothing.
 *
 * So the predicate is gone, the SQL is the only rule, and what is checked here
 * is the property those assertions could not see: every declared code has a
 * production recorder, named, in a file that still contains it.
 */
const RECORDED_BY: Readonly<Record<string, { file: string; needle: string }>> = {
  'access.permission_denied': {
    file: 'apps/api/src/modules/platform/access/application/permission-guard.ts',
    needle: "code: 'access.permission_denied'",
  },
  'auth.login_locked_out': {
    file: 'apps/api/src/modules/platform/identity/application/credential-throttle.ts',
    needle: "code: 'auth.login_locked_out'",
  },
  'admin.created': {
    file: 'apps/api/src/modules/platform/identity/application/admin-management.service.ts',
    needle: "'admin.created'",
  },
  'admin.status_changed': {
    file: 'apps/api/src/modules/platform/identity/application/admin-management.service.ts',
    needle: "'admin.status_changed'",
  },
  'admin.roles_changed': {
    file: 'apps/api/src/modules/platform/identity/application/admin-management.service.ts',
    needle: "'admin.roles_changed'",
  },
  'admin.password_changed': {
    file: 'apps/api/src/modules/platform/identity/application/admin-management.service.ts',
    needle: "'admin.password_changed'",
  },
  'panel.monitor.tenant_budget_exceeded': {
    file: 'apps/api/src/modules/platform/panels/application/panel-monitor.service.ts',
    needle: "const TENANT_BUDGET_CONDITION = 'panel.monitor.tenant_budget_exceeded'",
  },
  'panel.monitor.tenant_budget_ok': {
    file: 'apps/api/src/modules/platform/panels/application/panel-monitor.service.ts',
    needle: "const TENANT_BUDGET_RESOLVED = 'panel.monitor.tenant_budget_ok'",
  },
  'settings.stored_value_invalid': {
    file: 'apps/api/src/modules/control/settings/application/settings-resolver.ts',
    needle: 'code: INVALID_STORED_SETTING_CODE',
  },
  // The recovery is written by the SERVICE, not the resolver — the resolver
  // only ever sees a value that failed. Getting this entry wrong is how the
  // check earned its keep on its first run.
  'settings.stored_value_valid': {
    file: 'apps/api/src/modules/control/settings/application/settings.service.ts',
    needle: "code: 'settings.stored_value_valid'",
  },
};

describe('the management event scope', () => {
  it('declares no code that nothing records', () => {
    for (const code of MANAGEMENT_EVENT_CODES) {
      const source = RECORDED_BY[code];
      expect(source, `${code} has no named recorder`).toBeDefined();
      const text = readFileSync(resolve(REPO_ROOT, source!.file), 'utf8');
      expect(text.includes(source!.needle), `${source!.file} no longer writes ${code}`).toBe(true);
    }
  });

  it('names a recorder for nothing it does not declare', () => {
    // The other direction, so the map cannot rot into a list of codes the
    // scope dropped.
    const declared = new Set<string>(MANAGEMENT_EVENT_CODES);
    for (const code of Object.keys(RECORDED_BY)) expect(declared.has(code), code).toBe(true);
  });

  it('keeps the routine operational stream out', () => {
    const declared = new Set<string>(MANAGEMENT_EVENT_CODES);
    for (const code of [
      'panel.health.unreachable',
      'panel.health.degraded',
      'panel.health.auth_failed',
      'panel.monitor.probe',
      'system.ping',
      'http.error',
      'request.invalid',
      'notification.sweep_withdrawn',
    ]) {
      expect(declared.has(code), code).toBe(false);
    }
  });

  /**
   * The rule that made the dashboard honest.
   *
   * A card headed "needs attention" may only carry conditions that can be
   * CLOSED. `access.permission_denied` writes a fresh row per denial with no
   * dedupe key and no recovery, and there is deliberately no "mark as seen",
   * so every misclick left a permanent, unresolvable alert — the card filled
   * with denial noise for the life of the installation. Conditions are the
   * narrower list precisely because each has a recovery.
   */
  it('admits to the conditions scope only codes something resolves', () => {
    for (const code of MANAGEMENT_CONDITION_CODES) {
      const recovery = code.endsWith('_exceeded')
        ? code.replace('_exceeded', '_ok')
        : code.endsWith('_invalid')
          ? code.replace('_invalid', '_valid')
          : null;
      if (recovery === null) continue;
      expect(
        (MANAGEMENT_CONDITION_CODES as readonly string[]).includes(recovery),
        `${code} has no recovery in the conditions scope`,
      ).toBe(true);
      // And the recovery must actually be emitted, naming the condition.
      const source = RECORDED_BY[recovery]!;
      const text = readFileSync(resolve(REPO_ROOT, source.file), 'utf8');
      expect(text.includes('recoversCode'), `${source.file} emits no recovery`).toBe(true);
    }
  });

  it('keeps the one-shot records out of the conditions scope', () => {
    const conditions = new Set<string>(MANAGEMENT_CONDITION_CODES);
    for (const code of [
      'access.permission_denied',
      'auth.login_locked_out',
      'admin.created',
      'admin.status_changed',
      'admin.roles_changed',
      'admin.password_changed',
    ]) {
      expect(conditions.has(code), code).toBe(false);
      expect((MANAGEMENT_EVENT_CODES as readonly string[]).includes(code), code).toBe(true);
    }
  });
});
