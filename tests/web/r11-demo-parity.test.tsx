import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  TEMPLATE_KEYS,
  featureFlagSchema,
  navCountersResponseSchema,
  templateDefinition,
  templateViewSchema,
  type TemplateKey,
} from '@nexa/contracts';
import { ContentPage } from '../../apps/web/src/pages/content';
import { FeaturesPage } from '../../apps/web/src/pages/features';
import { SettingFold } from '../../apps/web/src/pages/settings';
import { ServiceLocationsPage } from '../../apps/web/src/pages/service-locations';
import { OpsLogTypeSwitches } from '../../apps/web/src/pages/ops-log-types';
import { Donut } from '../../apps/web/src/ui/kit';
import { navCountersFrom } from '../../apps/web/src/nav-counters';
import { formatDecimalText } from '../../apps/web/src/format';
import { t } from '../../apps/web/src/i18n/web.fa';
import { fixturesFor } from './shots/index.ts';
import { renderPage, setting, stubApi } from './harness';

/**
 * R11 A1 — the rules this round added to match the approved demo, each pinned once. The mutation
 * that breaks each is named in the PR; every case here fails when its rule is reverted.
 */

const css = (file: string) =>
  readFileSync(join(import.meta.dirname, `../../apps/web/src/styles/${file}`), 'utf8');

const view = (key: string) => {
  const definition = templateDefinition(key as TemplateKey);
  return templateViewSchema.parse({
    key,
    locale: 'fa',
    description: definition.description,
    format: definition.format,
    maxLength: definition.maxLength ?? 4096,
    body: 'x',
    defaultBody: 'x',
    overrideBody: null,
    source: 'DEFAULT',
    overrideSuppressed: false,
    version: null,
    revision: null,
    updatedAt: null,
    updatedByAdminId: null,
    placeholders: definition.placeholders.map((placeholder) => ({ ...placeholder })),
  });
};

const itemHidden = (key: string) =>
  (document.getElementById(`template-item-${key}`) as HTMLElement).closest('[hidden]') !== null;

describe('«متن‌ها» is paged ten at a time (S8)', () => {
  const keys = TEMPLATE_KEYS.slice(0, 23);

  it('counts over the SERVER total and turns pages, every item staying mounted', async () => {
    stubApi([{ url: '/templates', body: { templates: keys.map(view), total: 23 } }]);
    renderPage(<ContentPage mayEdit denied={false} />);
    const info = await screen.findByTestId('counted-pager-info');
    expect(info.textContent).toContain('1–10');
    expect(info.textContent).toContain('23');
    const shownOnFirst = keys.filter((key) => !itemHidden(key));
    expect(shownOnFirst).toHaveLength(10);
    fireEvent.click(screen.getByRole('button', { name: t('web.page_next_aria') }));
    expect(screen.getByTestId('counted-pager-info').textContent).toContain('11–20');
    const shownOnSecond = keys.filter((key) => !itemHidden(key));
    expect(shownOnSecond).toHaveLength(10);
    expect(shownOnSecond.some((key) => shownOnFirst.includes(key))).toBe(false);
  });

  it('prints no «of N» it was not told: an answer without a total pages without counting', async () => {
    stubApi([{ url: '/templates', body: { templates: keys.map(view) } }]);
    renderPage(<ContentPage mayEdit denied={false} />);
    await screen.findByRole('button', { name: t('web.page_next') });
    expect(screen.queryByTestId('counted-pager-info')).toBeNull();
    expect(keys.filter((key) => !itemHidden(key))).toHaveLength(10);
  });

  it('pages a filtered list under a plain page number, never over the server total', async () => {
    stubApi([{ url: '/templates', body: { templates: keys.map(view), total: 23 } }]);
    renderPage(<ContentPage mayEdit denied={false} />);
    await screen.findByTestId('counted-pager-info');
    fireEvent.click(screen.getByRole('button', { name: t('web.templates_filter_default') }));
    expect(screen.queryByTestId('counted-pager-info')).toBeNull();
  });
});

describe('«قابلیت‌ها» is paged under the numbered pager (S8)', () => {
  const flag = (index: number) =>
    featureFlagSchema.parse({
      key: `flag_${index}`,
      description: `flag ${index}`,
      enabled: index % 2 === 0,
      source: 'DEFAULT',
      blastRadius: 'LOCAL',
      version: null,
      reason: null,
      updatedAt: null,
      updatedByAdminId: null,
      configuration: [],
    });
  const flags = Array.from({ length: 12 }, (_, index) => flag(index));

  it('shows ten rows and the server total, then the rest on page two', async () => {
    stubApi([{ url: '/features', body: { flags, total: 12 } }]);
    renderPage(<FeaturesPage mayEdit denied={false} />);
    const info = await screen.findByTestId('counted-pager-info');
    expect(info.textContent).toContain('1–10');
    expect(info.textContent).toContain('12');
    expect(document.querySelectorAll('.feature-list > li').length).toBe(10);
    fireEvent.click(screen.getByRole('button', { name: t('web.page_next_aria') }));
    expect(document.querySelectorAll('.feature-list > li').length).toBe(2);
  });

  it('keeps the first ten and the «show all» button when the answer carries no total', async () => {
    stubApi([{ url: '/features', body: { flags } }]);
    renderPage(<FeaturesPage mayEdit denied={false} />);
    await screen.findByRole('button', { name: new RegExp(t('web.features_show_all'), 'u') });
    expect(screen.queryByTestId('counted-pager-info')).toBeNull();
  });
});

describe('«گروه گزارش‌ها»: the report types are accordions (item 13)', () => {
  const rows = [
    {
      url: '/settings',
      body: {
        settings: [
          setting({
            key: 'ops.log.disabled_types',
            value: ['ERROR_PROVISION'],
            version: 2,
            source: 'TENANT',
          }),
        ],
      },
    },
  ];
  it('folds each topic, closed, saying how many of its types are on', async () => {
    stubApi(rows);
    renderPage(<OpsLogTypeSwitches mayManage />);
    await screen.findByTestId('ops-log-types');
    const topics = [...document.querySelectorAll('details.ops-log-topic')];
    expect(topics.length).toBeGreaterThan(5);
    expect(topics.every((one) => !(one as HTMLDetailsElement).open)).toBe(true);
    // The topic holding the switched-off type counts one fewer than it has.
    const counts = topics.map((one) => one.querySelector('.ops-log-topic-count')?.textContent);
    expect(counts.some((text) => /(\d+) \/ (\d+)/u.test(text ?? ''))).toBe(true);
    const short = topics.filter((one) => {
      const match = /(\d+)\s*\/\s*(\d+)/u.exec(
        one.querySelector('.ops-log-topic-count')?.textContent ?? '',
      );
      return match !== null && Number(match[1]) < Number(match[2]);
    });
    expect(short).toHaveLength(1);
  });
});

describe('«تنظیمات»: each setting is an accordion (S-settings)', () => {
  const row = (key: 'ops.notifications.max_per_minute') =>
    setting({ key }) as unknown as Parameters<typeof SettingFold>[0]['setting'];

  it('starts the first one open and the others folded, every editor staying mounted', () => {
    renderPage(
      <>
        <SettingFold setting={row('ops.notifications.max_per_minute')} first unsaved={false}>
          <p data-testid="editor-a">a</p>
        </SettingFold>
        <SettingFold setting={row('ops.notifications.max_per_minute')} first={false} unsaved>
          <p data-testid="editor-b">b</p>
        </SettingFold>
      </>,
    );
    const [one, two] = [...document.querySelectorAll<HTMLDetailsElement>('details.set-fold')];
    expect(one?.open).toBe(true);
    expect(two?.open).toBe(false);
    // The folded one still holds its editor, so a half-typed value survives folding it.
    expect(screen.getByTestId('editor-b')).toBeInTheDocument();
    // Its summary says what it is and what it is now, and that it holds unsaved work.
    expect(two?.querySelector('summary')?.textContent).toContain(
      t('web.setting_ops_max_per_minute'),
    );
    expect(two?.querySelector('summary')?.textContent).toContain(t('web.ob_unsaved_row'));
    expect(one?.querySelector('summary')?.textContent).not.toContain(t('web.ob_unsaved_row'));
    fireEvent.click(two?.querySelector('summary') as HTMLElement);
  });
});

describe('a panel is its name, never its uuid (item 11)', () => {
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u;
  const routes = () =>
    fixturesFor('demo-parity')
      .filter(
        (one) =>
          one.method === 'GET' && ['/service-locations', '/panels', '/products'].includes(one.path),
      )
      .map((one) => ({ url: one.path, body: one.body }));

  it('draws the panel NAME of every location when the fleet is listed', async () => {
    stubApi(routes());
    renderPage(<ServiceLocationsPage denied={false} mayEdit mayReadPanels />);
    await screen.findByText(/فرانکفورت/u);
    const table = document.querySelector('table') as HTMLElement;
    await waitFor(() => expect(within(table).getAllByText('DE-1').length).toBeGreaterThan(0));
    expect(table.textContent).not.toMatch(UUID);
  });

  it('says a Persian word, never the uuid, when the panel cannot be named', async () => {
    stubApi(routes());
    renderPage(<ServiceLocationsPage denied={false} mayEdit mayReadPanels={false} />);
    await screen.findByText(/فرانکفورت/u);
    const table = document.querySelector('table') as HTMLElement;
    expect(table.textContent).not.toMatch(UUID);
    expect(table.textContent).toContain(t('web.panel_name_unknown'));
  });
});

describe('the small rules', () => {
  it('draws no percentage in a donut legend that asks for none (dashboard, item legend)', () => {
    const slices = [
      { key: 'a', label: 'درگاه', value: 3 },
      { key: 'b', label: 'کیف پول', value: 1 },
    ];
    const { container, rerender } = renderPage(<Donut caption="c" slices={slices} />);
    expect(container.textContent).toContain('75');
    rerender(<Donut caption="c" slices={slices} shares={false} />);
    expect(container.querySelector('.donut-legend')?.textContent).not.toContain(
      t('web.percent_sign'),
    );
  });

  it('draws a ticket waiting for support as a warn badge, not a grey one (S4)', () => {
    const counters = navCountersResponseSchema.parse({
      generatedAt: '2026-10-01T00:00:00.000Z',
      counters: {
        openConditions: null,
        ticketsAwaitingSupport: 5,
        unhealthyPanels: null,
        unreconciledServices: null,
        refundRequestsAwaiting: null,
        paymentsUnknown: null,
        businessHandoffs: null,
      },
    });
    expect(navCountersFrom(counters)['tickets']).toEqual({ count: 5, tone: 'warn' });
  });

  it('groups a decimal rate like every other figure (the FX card drew 98450 and 1640.83)', () => {
    expect(formatDecimalText('98450')).toBe('98,450');
    expect(formatDecimalText('1640.83')).toBe('1,640.83');
  });

  it('zeroes the sibling margin of the dashboard grids, so the KPI cards are level (B4)', () => {
    const base = css('base.css');
    const reset = /:where\(([^)]*)\)\s*>\s*\*\s*\{\s*margin-top:\s*0;/u.exec(base);
    expect(reset).not.toBeNull();
    for (const grid of [
      '.dash-kgrid',
      '.dash-mini',
      '.dash-ops',
      '.dash-charts',
      '.dash-row',
      '.dash-figures',
      '.bx-side-split',
    ]) {
      expect(reset?.[1]).toContain(grid);
    }
  });

  it('marks a linked identifier with a faint dashed rule, not an underline, and a name in bold (S6)', () => {
    const kit = css('kit.css');
    const rule = /\.lk,\s*\.tbl td a:not\(\.btn\),[^{]*\{([^}]*)\}/u.exec(kit);
    expect(rule?.[1]).toContain('text-decoration: none');
    expect(rule?.[1]).toContain('border-bottom: 1px dashed');
    expect(kit).toMatch(/\.tbl td a\.strong \{\s*font-weight: 700;/u);
  });

  it('gives a phone list search the full line, its buttons beneath (S10)', () => {
    const ui = css('ui.css');
    expect(ui).toMatch(/\.ca-search\.slim \.ca-search-main,[^{]*\{\s*flex: 1 1 100%;/u);
  });
});
