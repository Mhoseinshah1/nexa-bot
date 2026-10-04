import { describe, expect, it } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import {
  TEMPLATE_CATEGORIES,
  TEMPLATE_KEYS,
  templateCategoryOf,
  templateDefinition,
  templateViewSchema,
  type TemplateKey,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import {
  ContentPage,
  TEMPLATE_CATEGORY_LABEL,
  templateCategoryFilterOf,
} from '../../apps/web/src/pages/content';
import { t } from '../../apps/web/src/i18n/web.fa';
import { TEMPLATE_COPY_FA } from '../../apps/web/src/i18n/templates.fa';
import { renderPage, stubApi } from './harness';

/**
 * UX Batch 01, item 5: «متن‌ها» by domain. The categories are the contract's; choosing one
 * shows only its texts; the search works inside a category and across all of them.
 */
const view = (key: string, body: string) => {
  const definition = templateDefinition(key as TemplateKey);
  return templateViewSchema.parse({
    key,
    locale: 'fa',
    description: definition.description,
    format: definition.format,
    maxLength: definition.maxLength ?? 4096,
    body,
    defaultBody: body,
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

const BALANCE = 'bot.wallet.balance';
const RECEIPT = 'bot.payment.receipt_prompt';
const RENEW = 'bot.service.renew_button';
const CARD = 'bot.service.card';
const TERMS = 'bot.terms.accept_button';

const nameOf = (key: TemplateKey) => TEMPLATE_COPY_FA[key]?.[0] ?? key;
const hidden = (key: string) =>
  (document.getElementById(`template-item-${key}`) as HTMLElement).closest('[hidden]') !== null;
const search = () => document.getElementById('templates-search') as HTMLInputElement;
const chip = (id: string) =>
  document.querySelector(`.tcat-chip[data-category="${id}"]`) as HTMLButtonElement;
const countOf = (id: string) => chip(id).querySelector('.tcat-count')?.textContent ?? '';

async function render(keys: readonly string[] = [BALANCE, RECEIPT, RENEW, CARD, TERMS]) {
  stubApi([
    {
      url: '/templates',
      body: { templates: keys.map((key) => view(key, CATALOGUE_FA[key as TemplateKey])) },
    },
  ]);
  renderPage(<ContentPage mayEdit denied={false} />);
  await screen.findByRole('button', { name: new RegExp(nameOf(BALANCE)) });
}

describe('the category of every text', () => {
  it('is the contract category for every catalogue key, so nothing lands in «سایر»', () => {
    const other = TEMPLATE_KEYS.filter((key) => templateCategoryFilterOf(key) === 'other');
    expect(other).toEqual([]);
    for (const key of TEMPLATE_KEYS) {
      expect(templateCategoryFilterOf(key)).toBe(templateCategoryOf(key));
    }
  });

  it('has a Persian name for every category, all different', () => {
    const labels = TEMPLATE_CATEGORIES.map((id) => t(TEMPLATE_CATEGORY_LABEL[id]));
    expect(labels.every((label) => label.length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('«متن‌ها» by category', () => {
  it('offers every category, counted, with «همه» first and chosen', async () => {
    await render();
    const chips = [...document.querySelectorAll('.tcat-chip')].map((one) =>
      one.getAttribute('data-category'),
    );
    expect(chips).toEqual(['all', ...TEMPLATE_CATEGORIES]);
    expect(chip('all').getAttribute('aria-pressed')).toBe('true');
    expect(countOf('all')).toBe('5');
    expect(countOf('services')).toBe('1');
    expect(countOf('service_changes')).toBe('1');
    expect(countOf('referral')).toBe('0');
    // A key no category claims is not in this catalogue, so «سایر» is not offered.
    expect(chip('other')).toBeNull();
  });

  it('shows only the chosen category', async () => {
    await render();
    fireEvent.click(chip('service_changes'));
    expect(chip('service_changes').getAttribute('aria-pressed')).toBe('true');
    expect(hidden(RENEW)).toBe(false);
    expect(hidden(CARD)).toBe(true);
    expect(hidden(BALANCE)).toBe(true);
    expect(hidden(RECEIPT)).toBe(true);
    // The editor follows: it shows a text of the chosen category.
    expect(screen.getByRole('heading', { name: nameOf(RENEW) })).toBeInTheDocument();

    fireEvent.click(chip('wallet'));
    expect(hidden(BALANCE)).toBe(false);
    expect(hidden(RENEW)).toBe(true);

    fireEvent.click(chip('all'));
    for (const key of [BALANCE, RECEIPT, RENEW, CARD, TERMS]) expect(hidden(key)).toBe(false);
  });

  it('searches inside the chosen category, and says where else the words are', async () => {
    await render();
    fireEvent.click(chip('wallet'));
    fireEvent.change(search(), { target: { value: RECEIPT } });
    // Not in this category: nothing listed, and the way to widen the search is offered.
    expect(hidden(BALANCE)).toBe(true);
    expect(hidden(RECEIPT)).toBe(true);
    expect(countOf('payment')).toBe('1');
    expect(countOf('wallet')).toBe('0');
    const hint = screen.getByTestId('templates-elsewhere');
    fireEvent.click(within(hint).getByRole('button', { name: t('web.templates_search_all') }));
    expect(chip('all').getAttribute('aria-pressed')).toBe('true');
    expect(hidden(RECEIPT)).toBe(false);
    expect(hidden(BALANCE)).toBe(true);
    expect(screen.queryByTestId('templates-elsewhere')).toBeNull();
  });

  it('searches across every category from «همه»', async () => {
    await render();
    fireEvent.change(search(), { target: { value: 'bot.service.' } });
    expect(hidden(RENEW)).toBe(false);
    expect(hidden(CARD)).toBe(false);
    expect(hidden(BALANCE)).toBe(true);
    expect(countOf('all')).toBe('2');
  });

  it('offers only the sections of the chosen category, and clearing resets the category', async () => {
    await render();
    fireEvent.click(chip('wallet'));
    const sections = [
      ...(document.getElementById('templates-group') as HTMLSelectElement).options,
    ].map((option) => option.value);
    expect(sections).toEqual(['', 'wallet']);

    fireEvent.change(search(), { target: { value: 'no-template-is-called-this' } });
    fireEvent.click(screen.getByRole('button', { name: t('web.templates_clear_filters') }));
    expect(chip('all').getAttribute('aria-pressed')).toBe('true');
    expect(search().value).toBe('');
    expect(hidden(RENEW)).toBe(false);
  });

  it('files a key a newer server sends under «سایر» rather than losing it', async () => {
    stubApi([
      {
        url: '/templates',
        body: {
          templates: [
            view(BALANCE, CATALOGUE_FA[BALANCE]),
            { ...view(BALANCE, 'x'), key: 'brand.new_key' },
          ],
        },
      },
    ]);
    renderPage(<ContentPage mayEdit denied={false} />);
    await screen.findByRole('button', { name: new RegExp(nameOf(BALANCE)) });
    expect(chip('other')).not.toBeNull();
    fireEvent.click(chip('other'));
    expect(hidden('brand.new_key')).toBe(false);
    expect(hidden(BALANCE)).toBe(true);
  });
});
