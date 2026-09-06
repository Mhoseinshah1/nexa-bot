import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MANAGEMENT_ADMIN_EVENT_CODES,
  MANAGEMENT_CONDITION_CODES,
  MANAGEMENT_CONDITION_FAILURE_CODES,
  MANAGEMENT_CONDITION_RECOVERY_CODES,
  MANAGEMENT_EVENT_CODES,
  MANAGEMENT_ONE_SHOT_CODES,
  SETTINGS,
  isOneShotManagementCode,
  parseSettingValue,
  settingDefinition,
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

  /**
   * The condition lifecycle, asserted as the two lists rather than the union.
   *
   * `ports.ts` claimed this test held these properties before this test
   * existed: its condition assertions looped over `MANAGEMENT_CONDITION_CODES`
   * and never imported either half, so re-adding a recovery code to the
   * failure list — the exact regression that made the dashboard's
   * needs-attention card fill with the rows saying attention was over — left
   * the file entirely green. The claim came first; this is the claim made
   * true.
   */
  describe('the condition lifecycle', () => {
    it('keeps failures and recoveries disjoint', () => {
      for (const code of MANAGEMENT_CONDITION_FAILURE_CODES) {
        expect(
          (MANAGEMENT_CONDITION_RECOVERY_CODES as readonly string[]).includes(code),
          `${code} is in BOTH lists`,
        ).toBe(false);
      }
      // And the union is exactly the two, with nothing invented in between.
      expect([...MANAGEMENT_CONDITION_CODES].sort()).toEqual(
        [...MANAGEMENT_CONDITION_FAILURE_CODES, ...MANAGEMENT_CONDITION_RECOVERY_CODES].sort(),
      );
    });

    it('pairs every failure with a recovery, and every recovery with a failure', () => {
      // The naming convention IS the pairing, and both directions are walked so
      // neither a failure without a recovery nor an orphan recovery can be
      // added. `_exceeded` -> `_ok`, `_invalid` -> `_valid`.
      const recoveryFor = (code: string): string | null =>
        code.endsWith('_exceeded')
          ? code.replace('_exceeded', '_ok')
          : code.endsWith('_invalid')
            ? code.replace('_invalid', '_valid')
            : null;

      const recoveries = new Set<string>(MANAGEMENT_CONDITION_RECOVERY_CODES);
      for (const failure of MANAGEMENT_CONDITION_FAILURE_CODES) {
        const recovery = recoveryFor(failure);
        expect(recovery, `${failure} follows no recognised failure-code shape`).not.toBeNull();
        expect(recoveries.has(recovery as string), `${failure} has no recovery`).toBe(true);
      }
      // The other direction: nothing in the recovery list is a failure shape,
      // and every recovery is reachable from some failure.
      const reachable = new Set(
        MANAGEMENT_CONDITION_FAILURE_CODES.map((code) => recoveryFor(code)).filter(
          (code): code is string => code !== null,
        ),
      );
      for (const recovery of MANAGEMENT_CONDITION_RECOVERY_CODES) {
        expect(reachable.has(recovery), `${recovery} closes no declared failure`).toBe(true);
        expect(recoveryFor(recovery), `${recovery} is shaped like a failure`).toBeNull();
      }
    });

    it('admits only failures to the conditions scope', () => {
      // What the reader filters on. A recovery here is the defect.
      for (const recovery of MANAGEMENT_CONDITION_RECOVERY_CODES) {
        expect(
          (MANAGEMENT_CONDITION_FAILURE_CODES as readonly string[]).includes(recovery),
          `${recovery} would be returned as an open condition`,
        ).toBe(false);
      }
    });

    it('carries every administrator code the recorder can write', () => {
      // `MANAGEMENT_ONE_SHOT_CODES` spreads `MANAGEMENT_ADMIN_EVENT_CODES`, and
      // this is the assertion that keeps that a guarantee rather than a
      // coincidence: the admin list types `recordAdminChange`, so a code it can
      // record and this scope does not carry is a code the alerts page silently
      // never shows.
      for (const code of MANAGEMENT_ADMIN_EVENT_CODES) {
        expect(
          (MANAGEMENT_ONE_SHOT_CODES as readonly string[]).includes(code),
          `${code} is recordable and not in the management scope`,
        ).toBe(true);
        expect((MANAGEMENT_EVENT_CODES as readonly string[]).includes(code), code).toBe(true);
      }
    });

    it('classifies every management code as exactly one of one-shot or condition', () => {
      const oneShot = new Set<string>(MANAGEMENT_ONE_SHOT_CODES);
      const conditions = new Set<string>(MANAGEMENT_CONDITION_CODES);
      for (const code of MANAGEMENT_EVENT_CODES) {
        const kinds = [oneShot.has(code), conditions.has(code)].filter(Boolean).length;
        expect(kinds, `${code} is in ${kinds} of the two kinds`).toBe(1);
        // And the predicate the surface uses agrees with the lists.
        expect(isOneShotManagementCode(code), code).toBe(oneShot.has(code));
      }
    });
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

  /**
   * T08 — the SMALLEST accepted top-up cannot be negative.
   *
   * The key reused the generic `moneySchema`, whose signed pattern is right for
   * a balance and a debit and wrong here: `-1` validated, stored, and was
   * reported back as a legitimate minimum. Zero is the documented sentinel for
   * "no minimum", so the floor is zero and the refinement lives on THIS key
   * rather than on the shared money type.
   */
  it('refuses a negative top-up minimum, and keeps zero as the no-minimum sentinel', () => {
    for (const amountMinor of ['-1', '-20000', '-9007199254740993']) {
      const parsed = parseSettingValue('wallet.topup.minimum', { amountMinor, currency: 'IRT' });
      expect(parsed.ok, amountMinor).toBe(false);
    }
    // Zero is not a refusal — it is the documented way to say there is no
    // minimum, and refusing it would be a different bug.
    expect(
      parseSettingValue('wallet.topup.minimum', { amountMinor: '0', currency: 'IRT' }).ok,
    ).toBe(true);
    // And an amount past 2^53, which is the reason this is a string.
    expect(
      parseSettingValue('wallet.topup.minimum', {
        amountMinor: '9007199254740993',
        currency: 'IRT',
      }).ok,
    ).toBe(true);
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
