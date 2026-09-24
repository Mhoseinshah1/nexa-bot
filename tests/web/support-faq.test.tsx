import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { NAV, navPermitted } from '../../apps/web/src/app';
import { SupportPage, sortOrderOf } from '../../apps/web/src/pages/support';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * The support page (customer UX completion §J): the FAQ table, the create and edit
 * forms with `expectedVersion`, the conflict notice, and the denied state — through the
 * real API client, so a fixture that drifts from `supportFaqSchema` fails here.
 */

const FAQ_ID = '019250ab-cdef-7012-8345-6789abcdef01';

function faq(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: FAQ_ID,
    question: 'آیا آی‌پی ثابت است؟',
    answer: 'بله، لوکیشن ثابت است.',
    status: 'ACTIVE',
    sortOrder: 10,
    version: 3,
    createdAt: '2026-09-01T08:00:00.000Z',
    updatedAt: '2026-09-10T12:30:00.000Z',
    ...overrides,
  };
}

/**
 * The list and a write share the URL `/support/faqs`, and `stubApi` routes by URL alone.
 * One body that parses as BOTH shapes — `items` for the list, the row's own fields for a
 * write's answer — because zod's object schemas ignore keys they do not declare.
 */
const listAndRow = (rows: Record<string, unknown>[], row: Record<string, unknown>) => ({
  url: '/support/faqs',
  body: { items: rows, ...row },
});

describe('sortOrderOf', () => {
  it('accepts a whole number in Latin, Persian or Arabic-Indic digits, with grouping', () => {
    expect(sortOrderOf('0')).toBe(0);
    expect(sortOrderOf(' 25 ')).toBe(25);
    expect(sortOrderOf('۱۵')).toBe(15);
    expect(sortOrderOf('١٢')).toBe(12);
    expect(sortOrderOf('1,000')).toBe(1000);
    expect(sortOrderOf('100000')).toBe(100000);
  });

  it.each(['', '-1', '1.5', '1e3', 'ten', '100001'])('refuses %j rather than rewriting it', (v) => {
    expect(sortOrderOf(v)).toBeNull();
  });
});

describe('the support navigation entry', () => {
  it('is shown for settings.view and hidden for settings.edit alone', () => {
    const entry = NAV.find((candidate) => candidate.id === 'support');
    if (entry === undefined) throw new Error('no nav entry support');
    expect(entry.path).toBe('/support');
    expect(navPermitted(entry, ['settings.view'])).toBe(true);
    expect(navPermitted(entry, ['settings.view', 'settings.edit'])).toBe(true);
    expect(navPermitted(entry, ['settings.edit'])).toBe(false);
    expect(navPermitted(entry, [])).toBe(false);
  });
});

describe('the support page', () => {
  it('lists the FAQ in the order the server sent it, and points at the settings page', async () => {
    stubApi([
      listAndRow(
        [faq(), faq({ id: 'second', question: 'تمدید قبل از انقضا؟', status: 'INACTIVE' })],
        faq(),
      ),
    ]);
    const { container } = renderPage(<SupportPage denied={false} mayEdit={false} />);

    expect(await screen.findByText('آیا آی‌پی ثابت است؟')).toBeInTheDocument();
    expect(screen.getByText('تمدید قبل از انقضا؟')).toBeInTheDocument();
    expect(screen.getByText(t('web.support_faq_inactive'))).toBeInTheDocument();
    expect(container.textContent).toContain(t('web.support_destination_note'));
    expect(screen.getByRole('link', { name: t('web.support_destination_link') })).toHaveAttribute(
      'href',
      '/settings',
    );
    // A view-only role gets no controls.
    expect(screen.queryByRole('button', { name: t('web.support_faq_new') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('web.support_faq_edit') })).toBeNull();
  });

  it('creates an entry, sending the typed text and the sort order as a number', async () => {
    const api = stubApi([listAndRow([faq()], faq({ id: 'created' }))]);
    renderPage(<SupportPage denied={false} mayEdit />);

    fireEvent.click(await screen.findByRole('button', { name: t('web.support_faq_new') }));
    fireEvent.change(screen.getByLabelText(t('web.support_faq_question')), {
      target: { value: 'سوال تازه' },
    });
    fireEvent.change(screen.getByLabelText(t('web.support_faq_answer')), {
      target: { value: 'پاسخ تازه' },
    });
    fireEvent.change(screen.getByLabelText(t('web.support_faq_order')), {
      target: { value: '۱۵' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('web.support_faq_save') }));

    await waitFor(() => {
      expect(api.calls.some((call) => call.method === 'POST')).toBe(true);
    });
    const posted = api.calls.find((call) => call.method === 'POST');
    expect(posted?.url.endsWith('/support/faqs')).toBe(true);
    expect(posted?.body).toEqual({
      question: 'سوال تازه',
      answer: 'پاسخ تازه',
      sortOrder: 15,
      idempotencyKey: expect.any(String) as unknown,
    });
  });

  it('will not submit an empty question or a sort order that is not a whole number', async () => {
    const api = stubApi([listAndRow([faq()], faq())]);
    renderPage(<SupportPage denied={false} mayEdit />);

    fireEvent.click(await screen.findByRole('button', { name: t('web.support_faq_new') }));
    const save = screen.getByRole('button', { name: t('web.support_faq_save') });
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText(t('web.support_faq_question')), {
      target: { value: 'س' },
    });
    fireEvent.change(screen.getByLabelText(t('web.support_faq_answer')), {
      target: { value: 'پ' },
    });
    fireEvent.change(screen.getByLabelText(t('web.support_faq_order')), {
      target: { value: '-5' },
    });
    expect(screen.getByRole('alert')).toHaveTextContent(t('web.support_faq_sort_invalid'));
    expect(save).toBeDisabled();
    expect(api.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('edits an entry against the version it read, and toggles status against it too', async () => {
    const api = stubApi([
      listAndRow([faq()], faq()),
      { url: `/support/faqs/${FAQ_ID}`, body: faq({ version: 4 }) },
      { url: `/support/faqs/${FAQ_ID}/status`, body: faq({ status: 'INACTIVE', version: 4 }) },
    ]);
    renderPage(<SupportPage denied={false} mayEdit />);

    fireEvent.click(await screen.findByRole('button', { name: t('web.support_faq_edit') }));
    const question = screen.getByLabelText(t('web.support_faq_question')) as HTMLInputElement;
    expect(question.value).toBe('آیا آی‌پی ثابت است؟');
    fireEvent.change(question, { target: { value: 'آیا آی‌پی ثابت است؟ (ویرایش)' } });
    fireEvent.click(screen.getByRole('button', { name: t('web.support_faq_save') }));

    await waitFor(() => {
      expect(api.calls.some((call) => call.url.endsWith(`/support/faqs/${FAQ_ID}`))).toBe(true);
    });
    const edited = api.calls.find((call) => call.url.endsWith(`/support/faqs/${FAQ_ID}`));
    expect(edited?.method).toBe('POST');
    expect(edited?.body).toEqual({
      question: 'آیا آی‌پی ثابت است؟ (ویرایش)',
      answer: 'بله، لوکیشن ثابت است.',
      sortOrder: 10,
      expectedVersion: 3,
      idempotencyKey: expect.any(String) as unknown,
    });

    // The form closed on success; the status button carries the row's version.
    await waitFor(() => {
      expect(screen.queryByLabelText(t('web.support_faq_question'))).toBeNull();
    });
    fireEvent.click(screen.getByRole('button', { name: t('web.support_faq_deactivate') }));
    await waitFor(() => {
      expect(api.calls.some((call) => call.url.endsWith('/status'))).toBe(true);
    });
    const toggled = api.calls.find((call) => call.url.endsWith('/status'));
    expect(toggled?.body).toEqual({
      status: 'INACTIVE',
      expectedVersion: 3,
      idempotencyKey: expect.any(String) as unknown,
    });
  });

  it('shows the changed-elsewhere notice with a reload control on a version conflict', async () => {
    stubApi([
      listAndRow([faq()], faq()),
      {
        url: `/support/faqs/${FAQ_ID}`,
        status: 409,
        body: {
          error: {
            kind: 'conflict',
            code: 'commerce.support_faq_version_conflict',
            message: 'This FAQ entry changed since it was read.',
            details: { currentVersion: 4 },
            correlationId: 'test',
          },
        },
      },
    ]);
    renderPage(<SupportPage denied={false} mayEdit />);

    fireEvent.click(await screen.findByRole('button', { name: t('web.support_faq_edit') }));
    fireEvent.change(screen.getByLabelText(t('web.support_faq_answer')), {
      target: { value: 'پاسخ دیگر' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('web.support_faq_save') }));

    expect(await screen.findByText(t('web.support_faq_conflict'))).toBeInTheDocument();
    expect(screen.getByText(t('web.changed_elsewhere'), { exact: false })).toBeInTheDocument();
    // The draft survives; only the row it is compared against is offered afresh.
    expect((screen.getByLabelText(t('web.support_faq_answer')) as HTMLTextAreaElement).value).toBe(
      'پاسخ دیگر',
    );
    fireEvent.click(screen.getByRole('button', { name: t('web.reload_value') }));
    await waitFor(() => {
      expect(screen.queryByText(t('web.changed_elsewhere'), { exact: false })).toBeNull();
    });
    expect((screen.getByLabelText(t('web.support_faq_answer')) as HTMLTextAreaElement).value).toBe(
      'بله، لوکیشن ثابت است.',
    );
  });

  it('shows the denied state to an actor without settings.view, and fetches nothing', async () => {
    const api = stubApi([listAndRow([faq()], faq())]);
    renderPage(<SupportPage denied mayEdit={false} />);
    expect(await screen.findByText(t('web.no_permission'))).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
  });
});
