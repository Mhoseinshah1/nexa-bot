import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { FEATURE_FLAGS, featureFlagSchema } from '@nexa/contracts';
import { secretKindLabelFa, secretReentryPlaceFa } from '@nexa/i18n';
import { ResellersPage } from '../../apps/web/src/pages/resellers';
import { ResellerTiersPage } from '../../apps/web/src/pages/reseller-tiers';
import { SettingsPage } from '../../apps/web/src/pages/settings';
import { FeaturesPage } from '../../apps/web/src/pages/features';
import {
  SETTING_GROUP_TITLES,
  SETTING_PRESENTATION,
} from '../../apps/web/src/settings-presentation';
import { formatNumber } from '../../apps/web/src/format';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, setting, stubApi } from './harness';
import { openFilterPanel } from './ui-helpers';

/**
 * Demo parity, PR-4 (resellers, bot, system pages), the shared cases: every element the owner's
 * diff report listed as «only in the demo» is asserted here and every «only in the app» one is
 * asserted absent. Removing a restored element — the settings category tabs, the one-category-
 * at-a-time rule, the features «نمایش بقیهٔ قابلیت‌ها», a rules block heading, a list heading,
 * the «بیشتر» menu — fails a case below. The smaller restorations (bots, bot buttons, panels,
 * plans, content, audit) sit in those pages' own suites under the same «demo parity» name.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// /settings: category tabs with counts, ONE category at a time
// ---------------------------------------------------------------------------

describe('/settings category tabs', () => {
  const rows = [
    setting({ key: 'sales.payment_window_minutes', value: 60, version: 2, configures: null }),
    setting({ key: 'sales.currency', value: 'IRT', version: 1, configures: null }),
    setting({ key: 'ops.notifications.max_per_minute', value: 5, version: 4, configures: null }),
  ];
  const groupOf = (key: Parameters<typeof settingGroupTitle>[0]) => settingGroupTitle(key);
  function settingGroupTitle(key: keyof typeof SETTING_PRESENTATION) {
    return t(SETTING_GROUP_TITLES[SETTING_PRESENTATION[key].group]);
  }

  it('draws one tab per category with its setting count, the first one selected', async () => {
    stubApi([{ url: '/settings', body: { settings: rows } }]);
    renderPage(<SettingsPage mayEdit denied={false} />);
    await screen.findByLabelText(t('web.setting_payment_window_minutes'));
    const tabs = screen.getAllByRole('tab');
    const sales = tabs.find((tab) =>
      (tab.textContent ?? '').startsWith(groupOf('sales.payment_window_minutes')),
    )!;
    const ops = tabs.find((tab) =>
      (tab.textContent ?? '').startsWith(groupOf('ops.notifications.max_per_minute')),
    )!;
    expect(sales).toHaveAttribute('aria-selected', 'true');
    expect(sales.textContent).toContain(formatNumber(2));
    expect(ops.textContent).toContain(formatNumber(1));
    // The strip is named, and the old stack of every section's own heading is not drawn.
    expect(screen.getByRole('tablist', { name: t('web.settings_categories_label') })).toBeTruthy();
  });

  it('shows ONE category at a time and keeps a draft typed in another', async () => {
    stubApi([{ url: '/settings', body: { settings: rows } }]);
    renderPage(<SettingsPage mayEdit denied={false} />);
    const field = await screen.findByLabelText(t('web.setting_payment_window_minutes'));
    fireEvent.change(field, { target: { value: '45' } });
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(1);
    expect(field.closest('.settings-group')).not.toHaveAttribute('hidden');

    const ops = screen
      .getAllByRole('tab')
      .find((tab) =>
        (tab.textContent ?? '').startsWith(groupOf('ops.notifications.max_per_minute')),
      )!;
    fireEvent.click(ops);
    expect(ops).toHaveAttribute('aria-selected', 'true');
    // Only the chosen category is reachable; the first one is hidden but still mounted.
    expect(field.closest('.settings-group')).toHaveAttribute('hidden');
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(1);
    expect(
      screen.getByText(t('web.kit_settings_unsaved').replace('{n}', formatNumber(1))),
    ).toBeInTheDocument();

    // Back: the unsaved edit is exactly as typed, and the sticky save bar never went away.
    fireEvent.click(screen.getAllByRole('tab')[0]!);
    expect(
      (screen.getByLabelText(t('web.setting_payment_window_minutes')) as HTMLInputElement).value,
    ).toBe('45');
    expect(screen.getByRole('button', { name: t('web.save') })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// /features: one list, «نمایش بقیهٔ قابلیت‌ها (N)»
// ---------------------------------------------------------------------------

const flag = (key: string, enabled = false) =>
  featureFlagSchema.parse({
    key,
    description: `English description of ${key}`,
    enabled,
    source: 'TENANT',
    blastRadius: 'LOCAL',
    version: 1,
    reason: null,
    updatedAt: '2026-09-01T00:00:00.000Z',
    updatedByAdminId: 'a1',
    configuration: [],
  });

describe('/features one list', () => {
  it('draws no category tabs, no on/off chips and no search; «همهٔ قابلیت‌ها» heads one list', async () => {
    stubApi([{ url: '/features', body: { flags: FEATURE_FLAGS.map((f) => flag(f.key)) } }]);
    renderPage(<FeaturesPage mayEdit denied={false} />);
    await screen.findByRole('heading', { name: t('web.features_list_title') });
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByRole('group', { name: /وضعیت/u })).toBeNull();
    expect(document.querySelectorAll('ul.feature-list')).toHaveLength(1);
  });

  it('opens with ten rows and «نمایش بقیهٔ قابلیت‌ها (N)» reveals the rest, bottom-menu flag included', async () => {
    stubApi([{ url: '/features', body: { flags: FEATURE_FLAGS.map((f) => flag(f.key)) } }]);
    renderPage(<FeaturesPage mayEdit denied={false} />);
    const more = await screen.findByRole('button', { name: /نمایش بقیهٔ قابلیت‌ها/u });
    const rest = FEATURE_FLAGS.length - 10;
    expect(more.textContent).toContain(`(${formatNumber(rest)})`);
    expect(document.querySelectorAll('.feature-row')).toHaveLength(10);
    fireEvent.click(more);
    expect(document.querySelectorAll('.feature-row')).toHaveLength(FEATURE_FLAGS.length);
    expect(
      screen.getByRole('switch', { name: t('web.feature_persistent_bottom_menu_title') }),
    ).toBeInTheDocument();
  });

  it('lists «شخصی‌سازی متن‌های ربات» as a flag of the list', async () => {
    stubApi([{ url: '/features', body: { flags: [flag('template_overrides', true)] } }]);
    renderPage(<FeaturesPage mayEdit denied={false} />);
    expect(
      await screen.findByRole('heading', { name: t('web.feature_template_overrides_title') }),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// /resellers and /reseller-tiers
// ---------------------------------------------------------------------------

const TIER_ID = '019290ab-cdef-7012-8345-6789abcdef01';
const tier = () => ({
  id: TIER_ID,
  name: 'Gold',
  pricingMode: 'PERCENTAGE_DISCOUNT',
  discountPercentage: 10,
  creditLimit: { amount: '500000', currency: 'IRT' },
  grants: [],
  resellerCount: 2,
  monthlyMinimum: null,
  createdAt: '2026-09-01T08:00:00.000Z',
  updatedAt: '2026-09-01T08:00:00.000Z',
});
const reseller = () => ({
  customerId: '019210ab-cdef-7012-8345-6789abcdef01',
  telegramUserId: '5551234567',
  displayName: 'Reza Reseller',
  tier: { id: TIER_ID, name: 'Gold' },
  status: 'ACTIVE',
  pricingMode: 'TIER',
  discountPercentage: null,
  creditLimit: null,
  effectiveCreditLimit: { amount: '500000', currency: 'IRT' },
  source: 'NEXA',
  createdAt: '2026-09-02T08:00:00.000Z',
  updatedAt: '2026-09-02T08:00:00.000Z',
});
const resellerRoutes = [
  { url: '/resellers', body: { resellers: [reseller()], nextCursor: null } },
  { url: '/reseller-tiers', body: { tiers: [tier()] } },
];
const renderResellers = () =>
  renderPage(
    <ResellersPage
      route={{ path: '/resellers', query: new URLSearchParams('') }}
      denied={false}
      mayEdit
      maySearchCustomers
      mayViewWallet
      mayViewOrders
      mayViewAudit
      mayViewCatalog
      mayViewPanels
    />,
  );

describe('/resellers', () => {
  it('has the rules block as a heading with its rules, and «فهرست نمایندگان» as the list heading', async () => {
    stubApi(resellerRoutes);
    renderResellers();
    await screen.findByText('Reza Reseller');
    const rules = screen.getByRole('heading', { name: t('web.resellers_scope_title') });
    const card = rules.closest('section') as HTMLElement;
    // Not folded: the rules are on the page.
    expect(card.querySelector('details')).toBeNull();
    expect(within(card).getByText(t('web.resellers_rule_credit'))).toBeVisible();
    expect(screen.getByRole('heading', { name: t('web.resellers_list_title') })).toBeTruthy();
  });

  it('has the page-head «بیشتر» menu, and the status filter inside «فیلترها» instead of a chip row', async () => {
    stubApi(resellerRoutes);
    renderResellers();
    await screen.findByText('Reza Reseller');
    expect(screen.getAllByRole('button', { name: t('web.page_more_menu') }).length).toBeGreaterThan(
      0,
    );
    // The page head's menu is the first one; the rows carry their own below it.
    expect(
      screen.getAllByRole('button', { name: t('web.page_more_menu') })[0]?.closest('tr'),
    ).toBeNull();
    // No always-visible status chip outside the filters panel.
    expect(screen.queryByRole('button', { name: 'معلق' })).toBeNull();
    const panel = openFilterPanel();
    expect(within(panel).getByRole('button', { name: 'معلق' })).toBeInTheDocument();
  });
});

describe('/reseller-tiers', () => {
  it('has the rules block as a heading and «سطوح» as the list heading', async () => {
    stubApi([{ url: '/reseller-tiers', body: { tiers: [tier()] } }]);
    renderPage(
      <ResellerTiersPage
        denied={false}
        mayEdit
        mayViewCatalog={false}
        mayViewPanels={false}
        mayViewAudit={false}
      />,
    );
    await screen.findByText('Gold');
    const rules = screen.getByRole('heading', { name: t('web.reseller_tiers_scope_title') });
    expect(rules.closest('section')!.querySelector('details')).toBeNull();
    expect(screen.getByRole('heading', { name: t('web.reseller_tiers_list_title') })).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Text rule: no user-facing «میرزا» in the shared operational-event messages
// ---------------------------------------------------------------------------

describe('text rule', () => {
  it('names the previous bot, never Mirza, where a lost package key is re-entered (the /system and /ops-group alerts)', () => {
    expect(secretReentryPlaceFa('legacy_migration.package_key')).not.toContain('میرزا');
    expect(secretKindLabelFa('legacy_migration.package_key')).not.toContain('میرزا');
    expect(secretKindLabelFa('legacy_migration.package_key')).toContain('ربات قبلی');
  });
});
