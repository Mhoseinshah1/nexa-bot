import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { FEATURE_FLAGS, featureFlagSchema } from '@nexa/contracts';
import { FeaturesPage } from '../../apps/web/src/pages/features';
import {
  FEATURE_CATEGORIES,
  FEATURE_CATEGORY_TITLE,
  FEATURE_PRESENTATION,
  FEATURE_WHERE_LABEL,
} from '../../apps/web/src/pages/features-catalogue';
import { NAV } from '../../apps/web/src/nav';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * v0.9.5: the Features page is one page of categories (a side list) with the chosen
 * category's flags in the main pane. These pin the registry coverage, search and filter, and
 * that a category's «on/total» follows a toggle.
 */

const flag = (key: string, enabled = false, version = 1) =>
  featureFlagSchema.parse({
    key,
    description: `English description of ${key}`,
    enabled,
    source: 'TENANT',
    blastRadius: 'LOCAL',
    version,
    reason: null,
    updatedAt: '2026-09-01T00:00:00.000Z',
    updatedByAdminId: 'a1',
    configuration: [],
  });

const all = (enabled: (key: string) => boolean = () => false) =>
  FEATURE_FLAGS.map((definition) => flag(definition.key, enabled(definition.key)));

const tabFor = (category: (typeof FEATURE_CATEGORIES)[number]) =>
  screen.getByRole('tab', { name: new RegExp(t(FEATURE_CATEGORY_TITLE[category])) });

describe('the feature registry on the Features page', () => {
  it('puts every flag in exactly one known category and gives it all its texts', () => {
    expect(Object.keys(FEATURE_PRESENTATION).sort()).toEqual(
      FEATURE_FLAGS.map((f) => f.key as string).sort(),
    );
    for (const { key } of FEATURE_FLAGS) {
      const p = FEATURE_PRESENTATION[key];
      expect(FEATURE_CATEGORIES, key).toContain(p.category);
      expect(t(p.summary).length, key).toBeGreaterThan(10);
      expect(p.where.length, key).toBeGreaterThan(0);
      for (const place of p.where) expect(t(FEATURE_WHERE_LABEL[place]), key).toMatch(/[؀-ۿ]/);
      expect(t(p.offEffect).length, key).toBeGreaterThan(10);
      // A flag that asks before switching off says the same thing in the row.
      if (p.disableEffect !== null) expect(p.offEffect, key).toBe(p.disableEffect);
    }
  });

  it('links only to screens that exist in the navigation', () => {
    const paths = new Set(NAV.map((entry) => entry.path));
    for (const { key } of FEATURE_FLAGS) {
      const related = FEATURE_PRESENTATION[key].related;
      if (related !== null) expect(paths.has(related.path), key).toBe(true);
    }
  });

  it('leaves no category empty', () => {
    for (const category of FEATURE_CATEGORIES) {
      expect(
        FEATURE_FLAGS.some((f) => FEATURE_PRESENTATION[f.key].category === category),
        category,
      ).toBe(true);
    }
  });
});

describe('the Features page', () => {
  it('lists the categories with on/total counts from the complete list, on one page', async () => {
    const on = new Set(['ops_notifications', 'service_expiry_reminders']);
    stubApi([{ url: '/features', body: { flags: all((key) => on.has(key)), total: 42 } }]);
    renderPage(<FeaturesPage mayEdit denied={false} />);
    await screen.findByRole('tablist');
    const reminders = FEATURE_FLAGS.filter(
      (f) => FEATURE_PRESENTATION[f.key].category === 'reminders',
    ).length;
    expect(tabFor('reminders').textContent).toContain(`2/${reminders}`);
    expect(tabFor('panel').textContent).toContain(
      `0/${FEATURE_FLAGS.filter((f) => FEATURE_PRESENTATION[f.key].category === 'panel').length}`,
    );
    // The first category is selected and shows every flag it has.
    expect(tabFor('reminders')).toHaveAttribute('aria-selected', 'true');
    expect(document.querySelectorAll('.feature-row')).toHaveLength(reminders);
    expect(screen.getByRole('tabpanel')).toBeInTheDocument();
  });

  it('selects a category with a click and moves between them with the arrow keys', async () => {
    stubApi([{ url: '/features', body: { flags: all() } }]);
    renderPage(<FeaturesPage mayEdit denied={false} />);
    await screen.findByRole('tablist');
    fireEvent.click(tabFor('miniapp'));
    expect(tabFor('miniapp')).toHaveAttribute('aria-selected', 'true');
    expect(
      screen.getByRole('switch', { name: t('web.feature_mini_app_title') }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('switch', { name: t('web.feature_ops_notifications_title') }),
    ).toBeNull();
    fireEvent.keyDown(tabFor('miniapp'), { key: 'ArrowRight' });
    await waitFor(() => expect(tabFor('referral')).toHaveAttribute('aria-selected', 'true'));
  });

  it('shows where, what switching off does and a real link on a row', async () => {
    stubApi([{ url: '/features', body: { flags: [flag('ops_notifications', true)] } }]);
    renderPage(<FeaturesPage mayEdit denied={false} />);
    const row = (await screen.findByRole('switch')).closest('.feature-row') as HTMLElement;
    const p = FEATURE_PRESENTATION.ops_notifications;
    expect(within(row).getByText(t(p.offEffect))).toBeInTheDocument();
    expect(row.textContent).toContain(t('web.feature_where_ops_group'));
    expect(within(row).getByRole('link', { name: t('web.nav_ops_group') })).toHaveAttribute(
      'href',
      '/ops-group',
    );
  });

  it('describes the two services-search switches in full, each off by default, in the customer category', async () => {
    for (const key of ['services_search_label_button', 'services_search_button'] as const) {
      const p = FEATURE_PRESENTATION[key];
      expect(p.category, key).toBe('customer');
      expect(p.where, key).toEqual(['bot']);
      // What it does, where it is seen, and the effect when off: three full sentences, not stubs.
      expect(t(p.summary).length, key).toBeGreaterThan(120);
      expect(t(p.summary), key).toContain('سرویس‌های من');
      expect(t(p.offEffect).length, key).toBeGreaterThan(60);
    }
    stubApi([
      {
        url: '/features',
        body: {
          flags: [
            flag('services_search_label_button', false),
            flag('services_search_button', false),
          ],
        },
      },
    ]);
    renderPage(<FeaturesPage mayEdit denied={false} />);
    fireEvent.click(
      await screen.findByRole('tab', { name: new RegExp(t(FEATURE_CATEGORY_TITLE.customer)) }),
    );
    const labelRow = (
      await screen.findByText(t(FEATURE_PRESENTATION.services_search_label_button.title))
    ).closest('.feature-row') as HTMLElement;
    expect(within(labelRow).getByRole('switch')).not.toBeChecked();
    expect(
      within(labelRow).getByText(t(FEATURE_PRESENTATION.services_search_label_button.offEffect)),
    ).toBeInTheDocument();
    const searchRow = screen
      .getByText(t(FEATURE_PRESENTATION.services_search_button.title))
      .closest('.feature-row') as HTMLElement;
    expect(within(searchRow).getByRole('switch')).not.toBeChecked();
  });

  it('searches names and descriptions across all categories, grouped by category', async () => {
    stubApi([{ url: '/features', body: { flags: all() } }]);
    renderPage(<FeaturesPage mayEdit denied={false} />);
    const box = await screen.findByRole('searchbox', { name: t('web.features_search_label') });
    // «یادآوری» appears in the reminders category and elsewhere (e.g. the quiet-hours / reseller ones).
    fireEvent.change(box, { target: { value: 'مینی‌اپ' } });
    const region = screen.getByRole('region', { name: t('web.features_results_label') });
    const headings = within(region)
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent);
    expect(headings.length).toBeGreaterThan(1);
    expect(new Set(headings).size).toBe(headings.length);
    expect(headings).toContain(t('web.feature_cat_miniapp'));
    expect(
      within(region).getByRole('switch', { name: t('web.feature_mini_app_title') }),
    ).toBeInTheDocument();
    fireEvent.change(box, { target: { value: 'zzzz-nothing' } });
    expect(screen.getByText(t('web.features_no_match'))).toBeInTheDocument();
  });

  it('filters on and off, and the filter works together with search', async () => {
    const on = new Set(['mini_app', 'gift_cards']);
    stubApi([{ url: '/features', body: { flags: all((key) => on.has(key)) } }]);
    renderPage(<FeaturesPage mayEdit denied={false} />);
    await screen.findByRole('tablist');
    fireEvent.click(
      screen.getByRole('button', { name: new RegExp(`^${t('web.features_filter_on')}`) }),
    );
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
    // The reminders category has no flag on, so the pane says so.
    expect(screen.getByText(t('web.features_cat_empty'))).toBeInTheDocument();
    fireEvent.click(tabFor('miniapp'));
    expect(screen.getAllByRole('switch')).toHaveLength(1);
    fireEvent.click(
      screen.getByRole('button', { name: new RegExp(`^${t('web.features_filter_off')}`) }),
    );
    expect(screen.queryByRole('switch', { name: t('web.feature_mini_app_title') })).toBeNull();
    expect(screen.getAllByRole('switch').length).toBeGreaterThan(1);
  });

  it('updates a category count after a toggle', async () => {
    let enabled = false;
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown, init?: RequestInit) => {
        if (init?.method === 'POST') {
          enabled = true;
          return Promise.resolve(
            json({ flag: flag('wallet_low_balance_reminders', true, 2), changed: true }, 201),
          );
        }
        expect(String(input)).toContain('/features');
        return Promise.resolve(
          json({
            flags: FEATURE_FLAGS.map((d) =>
              flag(d.key, d.key === 'wallet_low_balance_reminders' && enabled, enabled ? 2 : 1),
            ),
          }),
        );
      }),
    );
    renderPage(<FeaturesPage mayEdit denied={false} />);
    await screen.findByRole('tablist');
    const total = FEATURE_FLAGS.filter(
      (f) => FEATURE_PRESENTATION[f.key].category === 'reminders',
    ).length;
    expect(tabFor('reminders').textContent).toContain(`0/${total}`);
    fireEvent.click(
      screen.getByRole('switch', { name: t('web.feature_wallet_low_balance_reminders_title') }),
    );
    await waitFor(() => expect(tabFor('reminders').textContent).toContain(`1/${total}`));
  });

  it('puts a flag this build does not know under «other», with the server text kept for support', async () => {
    stubApi([{ url: '/features', body: { flags: [flag('brand_new_flag', true)] } }]);
    renderPage(<FeaturesPage mayEdit denied={false} />);
    expect(
      await screen.findByRole('tab', { name: new RegExp(t('web.feature_cat_other')) }),
    ).toBeInTheDocument();
    expect(screen.getByText(t('web.feature_unknown_summary'))).toBeInTheDocument();
  });
});

describe('a feature’s related settings read as words, never as JSON', () => {
  it('shows the referral gift total as money, a percent with its unit, and absent as «تعیین نشده»', async () => {
    const configured = (key: string, value: unknown) => ({
      key,
      value,
      source: 'TENANT',
      version: 1,
      updatedAt: '2026-09-01T00:00:00.000Z',
      updatedByAdminId: 'a1',
      description: key,
      zeroMeaning: 'DISABLES',
      mutability: 'RUNTIME',
      classification: 'PUBLIC',
      configures: null,
      consumer: 'ACTIVE',
      inert: false,
      storedValueInvalid: false,
    });
    stubApi([
      {
        url: '/features',
        body: {
          flags: FEATURE_FLAGS.map((d) =>
            d.key === 'referral_signup_gift'
              ? featureFlagSchema.parse({
                  ...flag(d.key, true),
                  configuration: [
                    configured('referral.signup_gift.total', {
                      amountMinor: '20000',
                      currency: 'IRT',
                    }),
                    configured('referral.signup_gift.referrer_percent', 60),
                    configured('referral.signup_gift.referred_percent', null),
                  ],
                })
              : flag(d.key),
          ),
        },
      },
    ]);
    const view = renderPage(<FeaturesPage mayEdit denied={false} />);
    await screen.findByRole('tablist');
    fireEvent.click(tabFor('referral'));
    await waitFor(() => expect(view.container.textContent).toContain('20,000'));
    const text = view.container.textContent ?? '';
    expect(text).toContain('20,000 تومان');
    expect(text).toContain(`60 ${t('web.unit_percent')}`);
    expect(text).toContain(t('web.feature_setting_unset'));
    expect(text).not.toContain('amountMinor');
    expect(text).not.toContain('{"');
  });
});
