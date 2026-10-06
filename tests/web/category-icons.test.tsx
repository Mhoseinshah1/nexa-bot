import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { ProductCategoriesPage } from '../../apps/web/src/pages/product-categories';
import {
  canonicalCategoryIcons,
  invalidCategoryIcons,
} from '../../apps/web/src/pages/category-icons';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, setting, stubApi } from './harness';

/**
 * Phase 2 UX wave, Item 2 on the Web Admin: «آیکون دسته‌بندی‌ها» on the categories page. Each
 * category takes an optional premium icon BEFORE (a custom emoji id) and an optional ordinary
 * emoji AFTER; each can be added, changed and removed on its own; the save waits for valid
 * input and is ONE settings write with the version read; the preview marks the premium icon
 * and never fakes it.
 */

const VPN = '0190a5d6-1c2b-7e3f-8a4b-5c6d7e8f9a01';
const GAMING = '0190a5d6-1c2b-7e3f-8a4b-5c6d7e8f9a02';
const DELETED = '0190a5d6-1c2b-7e3f-8a4b-5c6d7e8f9aff';
const ICON = '5368324170671202286';

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

function api(options: { icons?: unknown; version?: number | null; invalid?: boolean } = {}) {
  return stubApi([
    {
      url: '/settings',
      body: {
        settings: [
          setting({
            key: 'bot.category_icons',
            value: options.icons ?? {},
            version: options.version ?? null,
            configures: null,
            storedValueInvalid: options.invalid ?? false,
          }),
          setting({ key: 'bot.category_colors', value: { [GAMING]: 'success' }, configures: null }),
          setting({ key: 'bot.inline_buttons', value: {}, configures: null }),
          setting({ key: 'bot.inline_button_icons', value: {}, configures: null }),
        ],
      },
    },
    {
      url: '/product-categories',
      body: {
        categories: [
          category({ id: GAMING, name: 'Gaming', emoji: '🎮', sortOrder: 2 }),
          category({ id: VPN, name: 'VPN', sortOrder: 1 }),
        ],
      },
    },
    {
      url: '/settings/bot.category_icons',
      body: {
        setting: setting({ key: 'bot.category_icons', value: {}, version: 9, configures: null }),
        changed: true,
      },
    },
  ]);
}

const page = (settingsEdit = true, settingsView = true) => (
  <ProductCategoriesPage
    denied={false}
    mayEdit
    maySettingsView={settingsView}
    maySettingsEdit={settingsEdit}
  />
);
const row = (id: string) =>
  document.querySelector(`#category-icons [data-category="${id}"]`) as HTMLElement | null;
const inside = (id: string) => within(row(id) as HTMLElement);
const before = (id: string) =>
  inside(id).getByLabelText(/^آیکون پریمیوم قبل —/) as HTMLInputElement;
const after = (id: string) => inside(id).getByLabelText(/^ایموجی بعد —/) as HTMLInputElement;
const previewText = (id: string) => inside(id).getByTestId('ci-preview-text').textContent;
const mark = (id: string) => inside(id).queryByTestId('ci-icon-mark');
const saveButton = () => screen.getByRole('button', { name: t('web.ci_save') });
const writes = (calls: ReturnType<typeof api>) =>
  calls.calls.filter((call) => call.url.endsWith('/settings/bot.category_icons'));

describe('«آیکون دسته‌بندی‌ها»', () => {
  it('lists the real categories with both fields and Telegram’s limits; neither shows the plain label', async () => {
    api();
    renderPage(page());
    await waitFor(() => expect(row(VPN)).not.toBeNull());
    expect(screen.getByTestId('ci-limits').textContent).toBe(t('web.ci_limits'));
    expect(previewText(GAMING)).toBe('🎮 Gaming');
    expect(mark(GAMING)).toBeNull();
    expect(before(VPN).value).toBe('');
    expect(after(VPN).value).toBe('');
    // The preview keeps the category's colour.
    expect(inside(GAMING).getByTestId('ci-preview').className).toMatch(/bb-style-success/);
  });

  it('shows stored before/after: a marker (never a fake emoji) and the after emoji in the label', async () => {
    api({ icons: { [VPN]: { before: ICON }, [GAMING]: { after: '🔥' } }, version: 3 });
    renderPage(page());
    await waitFor(() => expect(row(VPN)).not.toBeNull());
    expect(before(VPN).value).toBe(ICON);
    expect(mark(VPN)?.textContent).toBe('✦');
    expect(previewText(VPN)).toBe('VPN');
    expect(previewText(GAMING)).toBe('🎮 Gaming 🔥');
    expect(mark(GAMING)).toBeNull();
  });

  it('adds both, removes one independently, and saves ONE write with the version read', async () => {
    const calls = api({
      icons: { [DELETED]: { after: '⭐' }, [GAMING]: { after: '🔥' } },
      version: 4,
    });
    renderPage(page());
    await waitFor(() => expect(row(VPN)).not.toBeNull());
    fireEvent.change(before(VPN), { target: { value: ` ${ICON} ` } });
    fireEvent.change(after(VPN), { target: { value: '🇮🇷' } });
    expect(previewText(VPN)).toBe('VPN 🇮🇷');
    expect(mark(VPN)).not.toBeNull();
    // Remove Gaming's after with its own remove button.
    fireEvent.click(inside(GAMING).getByRole('button', { name: /^حذف ایموجی بعد/ }));
    expect(previewText(GAMING)).toBe('🎮 Gaming');
    expect(screen.getByText(t('web.ci_unsaved'))).toBeInTheDocument();
    fireEvent.click(saveButton());
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]?.body).toMatchObject({
      value: { [DELETED]: { after: '⭐' }, [VPN]: { before: ICON, after: '🇮🇷' } },
      expectedVersion: 4,
    });
    expect(Object.keys((writes(calls)[0]?.body as { value: object }).value)).not.toContain(GAMING);
  });

  it('refuses an invalid id before saving, and draws no marker for it', async () => {
    const calls = api();
    renderPage(page());
    await waitFor(() => expect(row(VPN)).not.toBeNull());
    fireEvent.change(before(VPN), { target: { value: '12ab' } });
    expect(inside(VPN).getByRole('alert').textContent).toBe(t('web.ci_before_invalid'));
    expect(before(VPN)).toHaveAttribute('aria-invalid', 'true');
    expect(mark(VPN)).toBeNull();
    expect(saveButton()).toBeDisabled();
    fireEvent.click(saveButton());
    expect(writes(calls)).toHaveLength(0);
  });

  it('refuses markup, text or an over-long after emoji before saving, and never previews it', async () => {
    api();
    renderPage(page());
    await waitFor(() => expect(row(VPN)).not.toBeNull());
    for (const bad of ['<b>🔥</b>', 'hot', '🔥'.repeat(9)]) {
      fireEvent.change(after(VPN), { target: { value: bad } });
      expect(inside(VPN).getByRole('alert').textContent).toBe(t('web.ci_after_invalid'));
      expect(previewText(VPN)).toBe('VPN');
      expect(saveButton()).toBeDisabled();
    }
    fireEvent.change(after(VPN), { target: { value: '🔥' } });
    expect(inside(VPN).queryByRole('alert')).toBeNull();
    expect(saveButton()).toBeEnabled();
  });

  it('offers no change without settings.edit, and is not drawn without settings.view', async () => {
    const calls = api({ icons: { [VPN]: { before: ICON } } });
    const view = renderPage(page(false));
    await waitFor(() => expect(row(VPN)).not.toBeNull());
    expect(before(VPN)).toBeDisabled();
    expect(screen.queryByRole('button', { name: t('web.ci_save') })).toBeNull();
    expect(screen.getByText(t('web.ci_denied_edit'))).toBeInTheDocument();
    expect(calls.calls.every((call) => call.method === 'GET')).toBe(true);
    view.unmount();
    api();
    renderPage(page(false, false));
    await screen.findAllByText('VPN');
    expect(document.querySelector('#category-icons')).toBeNull();
  });

  it('repairs an unreadable stored value by saving over it', async () => {
    const calls = api({ icons: { nonsense: { before: 'x' } }, version: 2, invalid: true });
    renderPage(page());
    await screen.findByText(t('web.ci_stored_invalid'));
    fireEvent.click(saveButton());
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]?.body).toMatchObject({ value: {}, expectedVersion: 2 });
  });
});

describe('the draft helpers', () => {
  it('canonicalises: trims, drops empty fields and entries, sorts ids', () => {
    expect(
      canonicalCategoryIcons({
        [VPN]: { before: ` ${ICON}`, after: '' },
        [GAMING]: { before: '', after: '' },
      }),
    ).toEqual({ [VPN]: { before: ICON } });
  });

  it('names each invalid field', () => {
    expect(
      invalidCategoryIcons({
        [VPN]: { before: 'x', after: '🔥' },
        [GAMING]: { before: ICON, after: 'a' },
      }),
    ).toEqual([
      { id: VPN, field: 'before' },
      { id: GAMING, field: 'after' },
    ]);
  });
});
