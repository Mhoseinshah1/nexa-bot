import { afterEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { CategoryColorsSection } from '../../apps/web/src/pages/category-colors';
import { t } from '../../apps/web/src/i18n/web.fa';
import { LeaveGuardHost } from '../../apps/web/src/ui/kit';
import { navigate } from '../../apps/web/src/router';
import { renderPage, setting, stubApi } from './harness';

/**
 * UX Batch 01, item 2 on the Web Admin: «رنگ دسته‌بندی‌ها». The list is the real catalogue,
 * so a category nobody wrote into the code appears; each takes its own colour from the closed
 * palette, or the fallback; the save is ONE settings write with the version read.
 */

const VPN = '0190a5d6-1c2b-7e3f-8a4b-5c6d7e8f9a01';
const GAMING = '0190a5d6-1c2b-7e3f-8a4b-5c6d7e8f9a02';
const OLD = '0190a5d6-1c2b-7e3f-8a4b-5c6d7e8f9a03';
const DELETED = '0190a5d6-1c2b-7e3f-8a4b-5c6d7e8f9aff';

const category = (overrides: Record<string, unknown>) => ({
  id: VPN,
  name: 'VPN',
  description: null,
  emoji: null,
  status: 'ACTIVE',
  visibility: 'VISIBLE',
  sortOrder: 0,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  productCount: 1,
  ...overrides,
});

function api(options: {
  colors?: unknown;
  version?: number | null;
  styles?: unknown;
  categories?: readonly Record<string, unknown>[];
  invalid?: boolean;
}) {
  return stubApi([
    {
      url: '/settings',
      body: {
        settings: [
          setting({
            key: 'bot.category_colors',
            value: options.colors ?? {},
            version: options.version ?? null,
            configures: null,
            storedValueInvalid: options.invalid ?? false,
          }),
          setting({ key: 'bot.inline_buttons', value: options.styles ?? {}, configures: null }),
        ],
      },
    },
    {
      url: '/product-categories',
      body: {
        categories: options.categories ?? [
          // Listed out of order: the screen shows the catalogue's own order.
          category({ id: GAMING, name: 'Gaming', emoji: '🎮', sortOrder: 2 }),
          category({ id: VPN, name: 'VPN', sortOrder: 1 }),
          category({ id: OLD, name: 'Old', sortOrder: 3, status: 'INACTIVE' }),
        ],
      },
    },
    {
      url: '/settings/bot.category_colors',
      body: {
        setting: setting({ key: 'bot.category_colors', value: {}, version: 9, configures: null }),
        changed: true,
      },
    },
  ]);
}

const section = (props: { mayEdit?: boolean; mayViewCategories?: boolean } = {}) => (
  <CategoryColorsSection
    denied={false}
    mayEdit={props.mayEdit ?? true}
    mayViewCategories={props.mayViewCategories ?? true}
  />
);

const row = (id: string) => document.querySelector(`[data-category="${id}"]`) as HTMLElement | null;
const preview = (id: string) => within(row(id) as HTMLElement).getByTestId('cc-preview');
const select = (id: string) =>
  within(row(id) as HTMLElement).getByRole('combobox') as HTMLSelectElement;

afterEach(() => {
  // The leave-guard case moves the router; put it back past any guard.
  act(() => navigate('/', { replace: true, force: true }));
});

describe('«رنگ دسته‌بندی‌ها»', () => {
  it('lists the real categories in catalogue order, a new one included, with five choices', async () => {
    api({});
    renderPage(section());
    await waitFor(() => expect(row(VPN)).not.toBeNull());
    const ids = [...document.querySelectorAll('[data-category]')].map((li) =>
      li.getAttribute('data-category'),
    );
    expect(ids).toEqual([VPN, GAMING, OLD]);
    expect(preview(GAMING).textContent).toBe('🎮 Gaming');
    expect([...select(VPN).options].map((option) => option.value)).toEqual([
      '',
      'default',
      'primary',
      'success',
      'danger',
    ]);
  });

  it("draws a category with no colour in the generic category button's style", async () => {
    api({ colors: { [VPN]: 'success' }, styles: { 'catalog.category': 'primary' } });
    renderPage(section());
    await waitFor(() => expect(row(VPN)).not.toBeNull());
    expect(preview(VPN).getAttribute('data-style')).toBe('success');
    expect(select(VPN).value).toBe('success');
    expect(preview(GAMING).getAttribute('data-style')).toBe('primary');
    expect(select(GAMING).value).toBe('');
    // The fallback option names what it falls back to.
    expect(select(GAMING).options[0]?.textContent).toContain(t('web.bb_style_primary'));
  });

  it('marks an inactive category and keeps its colour', async () => {
    api({ colors: { [OLD]: 'danger' } });
    renderPage(section());
    await waitFor(() => expect(row(OLD)).not.toBeNull());
    expect(within(row(OLD) as HTMLElement).getByText(t('web.cc_inactive'))).toBeInTheDocument();
    expect(within(row(OLD) as HTMLElement).getByText(t('web.cc_kept_note'))).toBeInTheDocument();
    expect(select(OLD).value).toBe('danger');
    expect(within(row(VPN) as HTMLElement).queryByText(t('web.cc_inactive'))).toBeNull();
  });

  it('saves ONE settings write with the version read, keeping a deleted category harmlessly', async () => {
    const calls = api({ colors: { [DELETED]: 'primary', [VPN]: 'danger' }, version: 4 });
    renderPage(section());
    await waitFor(() => expect(row(VPN)).not.toBeNull());
    // The deleted category is not shown.
    expect(row(DELETED)).toBeNull();
    fireEvent.change(select(GAMING), { target: { value: 'success' } });
    fireEvent.change(select(VPN), { target: { value: '' } });
    expect(preview(GAMING).className).toMatch(/bb-style-success/);
    expect(screen.getByText(t('web.cc_unsaved'))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: t('web.cc_save') }));
    await waitFor(() =>
      expect(calls.calls.some((call) => call.url.endsWith('/settings/bot.category_colors'))).toBe(
        true,
      ),
    );
    const write = calls.calls.find((call) => call.url.endsWith('/settings/bot.category_colors'));
    expect(write?.body).toMatchObject({
      value: { [DELETED]: 'primary', [GAMING]: 'success' },
      expectedVersion: 4,
    });
    expect(Object.keys((write?.body as { value: object }).value)).not.toContain(VPN);
    expect((write?.body as { idempotencyKey: string }).idempotencyKey.length).toBeGreaterThan(7);
  });

  it('shows the saved colour after a refresh', async () => {
    api({ colors: { [GAMING]: 'success' }, version: 9 });
    renderPage(section());
    await waitFor(() => expect(row(GAMING)).not.toBeNull());
    expect(select(GAMING).value).toBe('success');
    expect(preview(GAMING).className).toMatch(/bb-style-success/);
  });

  it('offers no change without settings.edit', async () => {
    const calls = api({});
    renderPage(section({ mayEdit: false }));
    await waitFor(() => expect(row(VPN)).not.toBeNull());
    expect(select(VPN)).toBeDisabled();
    expect(screen.queryByRole('button', { name: t('web.cc_save') })).toBeNull();
    expect(screen.getByText(t('web.cc_denied_edit'))).toBeInTheDocument();
    expect(calls.calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('says so, and asks nothing of the catalogue, without catalog.view', async () => {
    const calls = api({});
    renderPage(section({ mayViewCategories: false }));
    await screen.findByText(t('web.cc_categories_denied'));
    expect(calls.calls.some((call) => call.url.includes('/product-categories'))).toBe(false);
  });

  it('says when there are no categories yet', async () => {
    api({ categories: [] });
    renderPage(section());
    await screen.findByText(t('web.cc_empty'));
  });

  it('repairs an unreadable stored value by saving over it', async () => {
    const calls = api({ colors: { nonsense: 'magenta' }, version: 2, invalid: true });
    renderPage(section());
    await screen.findByText(t('web.cc_stored_invalid'));
    const save = screen.getByRole('button', { name: t('web.cc_save') });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() =>
      expect(calls.calls.some((call) => call.url.endsWith('/settings/bot.category_colors'))).toBe(
        true,
      ),
    );
    const write = calls.calls.find((call) => call.url.endsWith('/settings/bot.category_colors'));
    expect(write?.body).toMatchObject({ value: {}, expectedVersion: 2 });
  });

  it('asks before leaving with an unsaved colour', async () => {
    api({});
    renderPage(
      <>
        <LeaveGuardHost />
        {section()}
      </>,
    );
    await waitFor(() => expect(row(VPN)).not.toBeNull());
    fireEvent.change(select(VPN), { target: { value: 'danger' } });
    act(() => navigate('/elsewhere'));
    expect(await screen.findByText(t('web.unsaved_question'))).toBeInTheDocument();
  });
});
