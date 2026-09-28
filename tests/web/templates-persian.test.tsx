import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { templateDefinition, templateViewSchema, type TemplateKey } from '@nexa/contracts';
import { ContentPage } from '../../apps/web/src/pages/content';
import { t } from '../../apps/web/src/i18n/web.fa';
import { PLACEHOLDER_LABELS_FA, TEMPLATE_COPY_FA } from '../../apps/web/src/i18n/templates.fa';
import { renderPage, stubApi } from './harness';

/**
 * The template screen, in Persian (WP-A3).
 *
 * Fixtures are built from the REAL catalogue declaration of each key and parsed by the
 * frozen schema, so the English descriptions these cases assert are absent are the ones
 * the server really sends.
 */
const view = (key: TemplateKey, body: string, over: Record<string, unknown> = {}) => {
  const definition = templateDefinition(key);
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
    ...over,
  });
};

const BALANCE = 'bot.wallet.balance';
const CANCELLED = 'bot.order.cancelled';
const LINKED = 'bot.admin.linked';

const balance = () => view(BALANCE, 'موجودی کیف پول شما: {balance}');
const cancelled = () => view(CANCELLED, 'سفارش لغو شد.');
const linked = () => view(LINKED, 'دسترسی تلگرام برای {username} ثبت شد.');

const nameOf = (key: TemplateKey) => TEMPLATE_COPY_FA[key]?.[0] ?? '';
const descriptionOf = (key: TemplateKey) => TEMPLATE_COPY_FA[key]?.[1] ?? '';
const editor = (key: string) => document.getElementById(`body-${key}`) as HTMLTextAreaElement;
/** Whether the card holding this key's editor is hidden by the search or a filter. */
const hidden = (key: string) => editor(key).closest('[hidden]') !== null;
const search = () => document.getElementById('templates-search') as HTMLInputElement;

async function renderAll() {
  const api = stubApi([
    { url: '/templates', body: { templates: [balance(), cancelled(), linked()] } },
  ]);
  renderPage(<ContentPage mayEdit denied={false} />);
  await screen.findByRole('heading', { name: nameOf(BALANCE) });
  return api;
}

describe('a template card', () => {
  it('is titled with its Persian name, and keeps the raw key only as a detail', async () => {
    await renderAll();

    expect(screen.getByRole('heading', { name: nameOf(BALANCE) })).toBeInTheDocument();
    expect(screen.getByText(descriptionOf(BALANCE))).toBeInTheDocument();
    // The raw key is still there, as the technical detail, not the title.
    expect(screen.getByText(BALANCE).tagName).toBe('CODE');
    expect(screen.queryByRole('heading', { name: BALANCE })).toBeNull();
    // And the English catalogue description is not what the operator reads.
    expect(screen.queryByText(templateDefinition(BALANCE).description)).toBeNull();
  });

  it('explains each placeholder in Persian and leaves the token itself untouched', async () => {
    await renderAll();

    // The helper is Persian; the token is exactly the one the body must contain.
    expect(screen.getAllByText(PLACEHOLDER_LABELS_FA.balance as string).length).toBeGreaterThan(0);
    expect(screen.getAllByText('{balance}').length).toBeGreaterThan(0);
    expect(editor(BALANCE).value).toBe('موجودی کیف پول شما: {balance}');
    const english = templateDefinition(BALANCE).placeholders[0]?.description ?? '';
    expect(screen.queryByText(english)).toBeNull();
    // A token that means something narrower in this message says so.
    expect(screen.getAllByText('نام کاربری ادمین').length).toBeGreaterThan(0);
  });

  /**
   * The acceptance line of WP-A3: no random English on the normal screen. What may stay
   * Latin is the raw key, the `{tokens}` and the body — all in code, an isolate or an
   * editor — and the protocol name HTML.
   */
  it('shows no English words on the page beyond keys, tokens and bodies', async () => {
    const { container } = (() => {
      stubApi([{ url: '/templates', body: { templates: [balance(), cancelled(), linked()] } }]);
      return renderPage(<ContentPage mayEdit denied={false} />);
    })();
    await screen.findByRole('heading', { name: nameOf(BALANCE) });

    const copy = container.cloneNode(true) as HTMLElement;
    for (const technical of copy.querySelectorAll('code, .ltr, textarea, input, pre')) {
      technical.remove();
    }
    const words = (copy.textContent ?? '').match(/[A-Za-z]{2,}/g) ?? [];
    expect(words.filter((word) => word !== 'HTML')).toEqual([]);
  });

  it('falls back to the key and its catalogue description for a key with no Persian name', async () => {
    const unnamed = templateViewSchema.parse({
      ...balance(),
      key: 'bot.not_yet_named',
      description: 'A key another package added.',
    });
    stubApi([{ url: '/templates', body: { templates: [unnamed] } }]);
    renderPage(<ContentPage mayEdit denied={false} />);

    expect(await screen.findByRole('heading', { name: 'bot.not_yet_named' })).toBeInTheDocument();
    expect(screen.getByText('A key another package added.')).toBeInTheDocument();
    // The editor still works: the screen degraded, it did not break.
    expect(editor('bot.not_yet_named').value).toBe('موجودی کیف پول شما: {balance}');
  });
});

describe('searching and filtering the templates', () => {
  it('finds a template by its Persian name', async () => {
    await renderAll();

    fireEvent.change(search(), { target: { value: nameOf(CANCELLED) } });
    expect(hidden(CANCELLED)).toBe(false);
    expect(hidden(BALANCE)).toBe(true);
    expect(hidden(LINKED)).toBe(true);
  });

  it('finds a template by its raw key', async () => {
    await renderAll();

    fireEvent.change(search(), { target: { value: LINKED } });
    expect(hidden(LINKED)).toBe(false);
    expect(hidden(BALANCE)).toBe(true);
    expect(hidden(CANCELLED)).toBe(true);
  });

  it('says when nothing matches, and clears back to everything', async () => {
    await renderAll();

    fireEvent.change(search(), { target: { value: 'no-template-is-called-this' } });
    expect(screen.getByText(t('web.templates_no_match'))).toBeInTheDocument();
    expect(hidden(BALANCE)).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: t('web.templates_clear_filters') }));
    expect(search().value).toBe('');
    expect(hidden(BALANCE)).toBe(false);
    expect(hidden(CANCELLED)).toBe(false);
    expect(hidden(LINKED)).toBe(false);
  });

  it('narrows to one section', async () => {
    await renderAll();

    fireEvent.change(document.getElementById('templates-group') as HTMLSelectElement, {
      target: { value: 'wallet' },
    });
    expect(hidden(BALANCE)).toBe(false);
    expect(hidden(CANCELLED)).toBe(true);
    expect(hidden(LINKED)).toBe(true);
  });

  it('narrows to the customised templates', async () => {
    stubApi([
      {
        url: '/templates',
        body: {
          templates: [
            balance(),
            view(CANCELLED, 'سفارش لغو شد.', {
              overrideBody: 'سفارش شما لغو شد.',
              body: 'سفارش شما لغو شد.',
              source: 'TENANT',
              version: 1,
              revision: 1,
            }),
          ],
        },
      },
    ]);
    renderPage(<ContentPage mayEdit denied={false} />);
    await screen.findByRole('heading', { name: nameOf(BALANCE) });

    fireEvent.click(screen.getByRole('button', { name: t('web.templates_filter_custom') }));
    expect(hidden(CANCELLED)).toBe(false);
    expect(hidden(BALANCE)).toBe(true);
  });

  /**
   * A filter HIDES a card; it must not unmount it. The draft lives in the card's own
   * state, so unmounting it on a search would silently discard what the operator typed.
   */
  it('keeps an unsaved draft while a search hides its card', async () => {
    await renderAll();

    fireEvent.change(editor(BALANCE), { target: { value: 'متن تازه {balance}' } });
    fireEvent.change(search(), { target: { value: LINKED } });
    expect(hidden(BALANCE)).toBe(true);

    fireEvent.change(search(), { target: { value: '' } });
    expect(editor(BALANCE).value).toBe('متن تازه {balance}');
  });
});

describe('a refusal on the template screen', () => {
  it('says in Persian which placeholder a refused save broke', async () => {
    stubApi([
      { url: '/templates', body: { templates: [balance()] } },
      {
        url: `/templates/${BALANCE}`,
        status: 400,
        body: {
          error: {
            kind: 'validation',
            code: 'control.template_invalid',
            message: `This body is not valid for ${BALANCE}.`,
            details: {
              key: BALANCE,
              issues: [
                {
                  kind: 'MISSING_REQUIRED_PLACEHOLDER',
                  token: 'balance',
                  detail: `${BALANCE} requires {balance}: The derived balance.`,
                },
              ],
            },
            correlationId: 'test',
          },
        },
      },
    ]);
    renderPage(<ContentPage mayEdit denied={false} />);
    await screen.findByRole('heading', { name: nameOf(BALANCE) });

    fireEvent.change(editor(BALANCE), { target: { value: 'موجودی شما' } });
    fireEvent.click(screen.getByRole('button', { name: t('web.save') }));

    expect(await screen.findByText(t('web.template_invalid'))).toBeInTheDocument();
    const issue = screen.getByText(new RegExp(t('web.template_issue_missing')));
    expect(issue.textContent).toContain('{balance}');
    expect(issue.textContent).toContain(PLACEHOLDER_LABELS_FA.balance);
    // Neither English sentence reaches the operator.
    expect(screen.queryByText(/This body is not valid/)).toBeNull();
    expect(screen.queryByText(/requires \{balance\}/)).toBeNull();
  });

  it('says in Persian which sample value a refused preview could not use', async () => {
    stubApi([
      { url: '/templates', body: { templates: [balance()] } },
      {
        url: `/templates/${BALANCE}/preview`,
        status: 400,
        body: {
          error: {
            kind: 'validation',
            code: 'control.invalid_value',
            message: 'The sample values do not match the declared placeholder types.',
            details: {
              key: BALANCE,
              issues: [
                '{balance} is declared MONEY and needs minor units and a currency, such as 1250000 IRR; received "abc".',
              ],
            },
            correlationId: 'test',
          },
        },
      },
    ]);
    renderPage(<ContentPage mayEdit denied={false} />);
    await screen.findByRole('heading', { name: nameOf(BALANCE) });

    fireEvent.change(document.getElementById(`sample-${BALANCE}-balance`) as HTMLInputElement, {
      target: { value: 'abc' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('web.preview') }));

    expect(await screen.findByText(t('web.template_samples_invalid'))).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText(new RegExp(t('web.template_sample_invalid'))).textContent).toContain(
        t('web.sample_money'),
      );
    });
    expect(screen.queryByText(/is declared MONEY/)).toBeNull();
  });
});
