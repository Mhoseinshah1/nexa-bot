import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { FEATURE_FLAGS, featureFlagSchema } from '@nexa/contracts';
import { FEATURES_FIRST_SHOWN, FeaturesPage } from '../../apps/web/src/pages/features';
import {
  FEATURE_CATEGORIES,
  FEATURE_PRESENTATION,
  FEATURE_WHERE_LABEL,
} from '../../apps/web/src/pages/features-catalogue';
import { NAV } from '../../apps/web/src/nav';
import { formatNumber } from '../../apps/web/src/format';
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
  it('is ONE list under «همهٔ قابلیت‌ها»: ten whole rows, the rest behind «نمایش بقیهٔ قابلیت‌ها (N)»', async () => {
    stubApi([{ url: '/features', body: { flags: all(), total: 42 } }]);
    renderPage(<FeaturesPage mayEdit denied={false} />);
    await screen.findByRole('heading', { name: t('web.features_list_title') });
    // Demo parity: no category tabs, no on/off chips, no search.
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /^(همه|روشن|خاموش)/u })).toBeNull();
    expect(document.querySelectorAll('.feature-row')).toHaveLength(FEATURES_FIRST_SHOWN);
    const rest = FEATURE_FLAGS.length - FEATURES_FIRST_SHOWN;
    const more = screen.getByRole('button', {
      name: t('web.features_show_rest').replace('{n}', formatNumber(rest)),
    });
    fireEvent.click(more);
    expect(document.querySelectorAll('.feature-row')).toHaveLength(FEATURE_FLAGS.length);
    expect(screen.queryByRole('button', { name: /نمایش بقیهٔ قابلیت‌ها/u })).toBeNull();
    // The bottom-menu flag (the last round's) is still listed, with its switch.
    expect(
      screen.getByRole('switch', { name: t('web.feature_persistent_bottom_menu_title') }),
    ).toBeInTheDocument();
  });

  it('draws no «show the rest» button when ten or fewer flags exist', async () => {
    stubApi([{ url: '/features', body: { flags: [flag('ops_notifications', true)] } }]);
    renderPage(<FeaturesPage mayEdit denied={false} />);
    await screen.findByRole('switch');
    expect(screen.queryByRole('button', { name: /نمایش بقیهٔ قابلیت‌ها/u })).toBeNull();
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

  it('puts a flag this build does not know in the list, with the server text kept for support', async () => {
    stubApi([{ url: '/features', body: { flags: [flag('brand_new_flag', true)] } }]);
    renderPage(<FeaturesPage mayEdit denied={false} />);
    expect(await screen.findByText(t('web.feature_unknown_summary'))).toBeInTheDocument();
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
    fireEvent.click(await screen.findByRole('button', { name: /نمایش بقیهٔ قابلیت‌ها/u }));
    await waitFor(() => expect(view.container.textContent).toContain('20,000'));
    const text = view.container.textContent ?? '';
    expect(text).toContain('20,000 تومان');
    expect(text).toContain(`60 ${t('web.unit_percent')}`);
    expect(text).toContain(t('web.feature_setting_unset'));
    expect(text).not.toContain('amountMinor');
    expect(text).not.toContain('{"');
  });

  it('asks before switching the automatic deletion on, repeating how many the next day deletes (PR-3)', async () => {
    const api = stubApi([
      { url: '/features', body: { flags: all() } },
      {
        url: '/services/auto-delete/preview',
        body: { windowHours: 24, traffic: 3, time: 2, suspended: 1, total: 6, enabled: false },
      },
    ]);
    renderPage(<FeaturesPage mayEdit denied={false} />);
    fireEvent.click(await screen.findByRole('button', { name: /نمایش بقیهٔ قابلیت‌ها/u }));
    fireEvent.click(
      await screen.findByRole('switch', { name: t('web.feature_service_auto_delete_title') }),
    );
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(t('web.feature_service_auto_delete_on_question'))).toBeTruthy();
    await waitFor(() => expect(dialog.textContent).toContain(t('web.auto_delete_preview_tail')));
    // N is the server's count (the total in bold), and each cause's.
    expect(within(dialog).getByText('6').tagName).toBe('STRONG');
    expect(dialog.textContent).toContain(`${t('web.auto_delete_preview_traffic')} 3`);
    expect(dialog.textContent).toContain(`${t('web.auto_delete_preview_suspended')} 1`);
    // Nothing is switched on behind the open question.
    expect(api.calls.some((call) => call.method === 'POST')).toBe(false);
  });
});
