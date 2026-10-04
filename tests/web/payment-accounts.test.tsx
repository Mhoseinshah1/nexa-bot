import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { CardAccountsSection } from '../../apps/web/src/pages/payment-accounts';
import { resolve } from '../../apps/web/src/app';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * The card-to-card CARDS — once the «حساب‌های دریافت» screen, now a section of the
 * card-to-card payment method's own view (UX Batch 01, item 7).
 *
 * Two things are defended here. First, the ONE thing the screen's shape always had to get
 * right: `payments.accounts.view` and `payments.accounts.edit` are two permissions, every
 * write is authorized with `edit` alone, and a page derived from `view` was wrong in both
 * directions at once (Codex review of PR #34). `UNK-ADM-001` is the legacy version: a drawn
 * control nobody may press is the same lie told the other way round.
 *
 * Second, that the move lost nothing: list, add, edit, enable/disable, make-default and the
 * display order all work in the new place, through the SAME API calls with the same bodies.
 */

const ACCOUNT = {
  id: '019250ab-cdef-7012-8345-6789abcdef01',
  label: 'main',
  bankName: 'Bank Melli',
  holderName: 'Acme Store',
  cardNumber: '6037991234567893',
  iban: 'IR429600000001003242000012',
  enabled: true,
  isDefault: false,
  sortOrder: 2,
  createdAt: '2026-09-10T12:30:00.000Z',
  updatedAt: '2026-09-10T12:30:00.000Z',
};

const accounts = (rows: unknown[] = [ACCOUNT]) => [
  { url: '/payment-accounts', body: { accounts: rows } },
  { url: `/payment-accounts/${ACCOUNT.id}`, body: { account: ACCOUNT } },
];

/** Every write control the section can draw, by its Persian label. */
const WRITE_CONTROLS = ['افزودن کارت', 'ویرایش', 'پیش‌فرض کردن', 'غیرفعال کردن'];

/** The section on its own, as the card-to-card view draws it. */
function Section({ denied, mayEdit }: { denied: boolean; mayEdit: boolean }) {
  return <CardAccountsSection denied={denied} mayEdit={mayEdit} />;
}

const posts = (api: ReturnType<typeof stubApi>) =>
  api.calls.filter((call) => call.method === 'POST');

describe('the card-to-card cards and their two permissions', () => {
  it('draws no write control for a role that may only view', async () => {
    stubApi(accounts());
    const { container } = renderPage(<Section denied={false} mayEdit={false} />);
    await screen.findByText('Bank Melli');

    // The rows ARE rendered — this is a view-only role, not a denial.
    expect(container.textContent).toContain('Acme Store');
    for (const label of WRITE_CONTROLS) {
      expect(container.textContent, label).not.toContain(label);
    }
  });

  it('draws «افزودن کارت» and the row controls for a role that may edit', async () => {
    stubApi(accounts());
    const { container } = renderPage(<Section denied={false} mayEdit />);
    await screen.findByText('Bank Melli');

    for (const label of WRITE_CONTROLS) {
      expect(container.textContent, label).toContain(label);
    }
    // The form is drawn only once it is asked for: no half-page of empty fields.
    expect(screen.queryByLabelText(t('web.payment_account_card'))).toBeNull();
  });

  /*
   * The edit-only role, which is the direction that LOST something once. Its list read is
   * denied, and «افزودن کارت» and the form must still be there: it is the only role allowed
   * to use them.
   */
  it('keeps «افزودن کارت» and the form for an edit-only role, whose list read is denied', async () => {
    stubApi(accounts());
    renderPage(<Section denied mayEdit />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.payment_account_add') }));
    expect(await screen.findByText(t('web.payment_account_new'))).toBeInTheDocument();
    expect(screen.getByLabelText(t('web.payment_account_card'))).toBeInTheDocument();
  });

  it('shows neither list nor form when a role holds neither permission', () => {
    stubApi(accounts());
    const { container } = renderPage(<Section denied mayEdit={false} />);
    // Nothing is awaited: the query is disabled and no control is drawn, so the only
    // stable assertion is the absence of both.
    expect(container.textContent).not.toContain('Bank Melli');
    for (const label of WRITE_CONTROLS) {
      expect(container.textContent, label).not.toContain(label);
    }
  });
});

describe('managing cards in their new place', () => {
  it('lists each card masked, with its bank, holder, state and display order', async () => {
    stubApi(accounts([ACCOUNT, { ...ACCOUNT, id: 'b', label: 'spare', enabled: false }]));
    const { container } = renderPage(<Section denied={false} mayEdit={false} />);
    await screen.findByText('spare');
    expect(container.textContent).toContain('•••• •••• •••• 7893');
    // The full number is not in the table: it is shown in the form, where it is checked.
    expect(container.textContent).not.toContain(ACCOUNT.cardNumber);
    expect(container.textContent).toContain(t('web.payment_account_disabled'));
    expect(screen.getAllByText(t('web.payment_account_sort')).length).toBeGreaterThan(0);
  });

  it('adds a card through the same create call, with an idempotency key, and closes the form', async () => {
    // The list and the create share one path, so one body answers both: the list reads
    // `accounts`, the create's response reads `account` (each schema ignores the other).
    const api = stubApi([{ url: '/payment-accounts', body: { accounts: [], account: ACCOUNT } }]);
    renderPage(<Section denied={false} mayEdit />);
    // An installation with no card still has the button — it is the one that needs it.
    await screen.findByText(t('web.payment_accounts_empty'));
    fireEvent.click(screen.getByRole('button', { name: t('web.payment_account_add') }));
    const name = await screen.findByLabelText(t('web.payment_account_label'));
    // Focus lands in the form that was asked for.
    expect(document.activeElement).toBe(name);

    fireEvent.change(name, { target: { value: 'main' } });
    fireEvent.change(screen.getByLabelText(t('web.payment_account_bank')), {
      target: { value: 'Bank Melli' },
    });
    fireEvent.change(screen.getByLabelText(t('web.payment_account_holder')), {
      target: { value: 'Acme Store' },
    });
    fireEvent.change(screen.getByLabelText(t('web.payment_account_card')), {
      target: { value: '6037-9912-3456-7893' },
    });
    fireEvent.change(screen.getByLabelText(t('web.payment_account_sort')), {
      target: { value: '4' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('web.payment_account_save') }));

    await waitFor(() => expect(posts(api)).toHaveLength(1));
    const [created] = posts(api);
    expect(created!.url).toMatch(/\/payment-accounts$/u);
    const body = created!.body as Record<string, unknown>;
    expect(body).toMatchObject({
      label: 'main',
      bankName: 'Bank Melli',
      holderName: 'Acme Store',
      // Sent exactly as typed: the server normalises it, in one place.
      cardNumber: '6037-9912-3456-7893',
      iban: null,
      sortOrder: 4,
      enabled: true,
      makeDefault: false,
    });
    expect(typeof body['idempotencyKey']).toBe('string');
    await waitFor(() => expect(screen.queryByLabelText(t('web.payment_account_card'))).toBeNull());
  });

  it('edits a card from its full number, through the same update call', async () => {
    const api = stubApi(accounts());
    renderPage(<Section denied={false} mayEdit />);
    await screen.findByText('Bank Melli');
    fireEvent.click(screen.getByRole('button', { name: t('web.payment_account_edit') }));
    expect(await screen.findByText(t('web.payment_account_editing'))).toBeInTheDocument();
    const card = screen.getByLabelText(t('web.payment_account_card')) as HTMLInputElement;
    expect(card.value).toBe(ACCOUNT.cardNumber);

    fireEvent.change(screen.getByLabelText(t('web.payment_account_holder')), {
      target: { value: 'Acme Ltd' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('web.payment_account_save') }));
    await waitFor(() => expect(posts(api)).toHaveLength(1));
    const [updated] = posts(api);
    expect(updated!.url).toContain(`/payment-accounts/${ACCOUNT.id}`);
    expect(updated!.url).not.toContain('/enabled');
    expect(updated!.body as Record<string, unknown>).toMatchObject({
      holderName: 'Acme Ltd',
      cardNumber: ACCOUNT.cardNumber,
      sortOrder: ACCOUNT.sortOrder,
    });
  });

  it('cancels an edit without writing anything', async () => {
    const api = stubApi(accounts());
    renderPage(<Section denied={false} mayEdit />);
    await screen.findByText('Bank Melli');
    fireEvent.click(screen.getByRole('button', { name: t('web.payment_account_edit') }));
    fireEvent.click(
      await screen.findByRole('button', { name: t('web.payment_account_cancel_edit') }),
    );
    expect(screen.queryByLabelText(t('web.payment_account_card'))).toBeNull();
    expect(posts(api)).toHaveLength(0);
  });

  it('archives a card by disabling it — there is no delete — and can enable it again', async () => {
    const api = stubApi([
      ...accounts([ACCOUNT, { ...ACCOUNT, id: 'off', label: 'old', enabled: false }]),
      { url: `/payment-accounts/${ACCOUNT.id}/enabled`, body: { account: ACCOUNT } },
      { url: '/payment-accounts/off/enabled', body: { account: ACCOUNT } },
    ]);
    const { container } = renderPage(<Section denied={false} mayEdit />);
    await screen.findByText('old');
    expect(container.textContent).not.toMatch(/حذف/u);

    const rows = screen.getAllByRole('row');
    const live = rows.find((row) => within(row).queryByText('main')) as HTMLElement;
    fireEvent.click(within(live).getByRole('button', { name: t('web.payment_account_disable') }));
    await waitFor(() => expect(posts(api)).toHaveLength(1));
    expect(posts(api)[0]!.url).toContain(`/payment-accounts/${ACCOUNT.id}/enabled`);
    expect((posts(api)[0]!.body as Record<string, unknown>)['enabled']).toBe(false);

    const archived = rows.find((row) => within(row).queryByText('old')) as HTMLElement;
    await waitFor(() =>
      expect(
        within(archived).getByRole('button', { name: t('web.payment_account_enable') }),
      ).not.toBeDisabled(),
    );
    fireEvent.click(
      within(archived).getByRole('button', { name: t('web.payment_account_enable') }),
    );
    await waitFor(() => expect(posts(api)).toHaveLength(2));
    expect(posts(api)[1]!.url).toContain('/payment-accounts/off/enabled');
    expect((posts(api)[1]!.body as Record<string, unknown>)['enabled']).toBe(true);
  });

  /*
   * Review of #186: the row actions' failures used to be drawn only inside the form, which
   * is closed by default now — so a refused enable said nothing and read as done.
   */
  it('reports a refused enable on the cards’ card, with the form closed', async () => {
    const off = { ...ACCOUNT, enabled: false };
    stubApi([
      ...accounts([off]),
      {
        url: `/payment-accounts/${ACCOUNT.id}/enabled`,
        status: 409,
        body: {
          error: {
            kind: 'conflict',
            code: 'payment_account.limit',
            message: 'too many enabled accounts',
            correlationId: 'test',
          },
        },
      },
    ]);
    renderPage(<Section denied={false} mayEdit />);
    await screen.findByText('Bank Melli');
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('web.payment_account_enable') }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toBe('');
    // Not inside a form: there is none open.
    expect(screen.queryByLabelText(t('web.payment_account_card'))).toBeNull();
    expect(alert.closest('section')?.textContent).toContain('Bank Melli');
  });

  it('makes a card the default through the same call, and never offers to disable the default', async () => {
    const api = stubApi([
      ...accounts([ACCOUNT, { ...ACCOUNT, id: 'def', label: 'primary', isDefault: true }]),
      { url: `/payment-accounts/${ACCOUNT.id}/default`, body: { account: ACCOUNT } },
    ]);
    renderPage(<Section denied={false} mayEdit />);
    await screen.findByText('primary');
    const rows = screen.getAllByRole('row');
    const primary = rows.find((row) => within(row).queryByText('primary')) as HTMLElement;
    expect(
      within(primary).queryByRole('button', { name: t('web.payment_account_disable') }),
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: t('web.payment_account_make_default') }));
    await waitFor(() => expect(posts(api)).toHaveLength(1));
    expect(posts(api)[0]!.url).toContain(`/payment-accounts/${ACCOUNT.id}/default`);
  });
});

/*
 * The ROUTE, not the section. `resolve` is what passes the props, and a section gated
 * correctly behind a route that passes them from the wrong key would still be wrong.
 */
describe('the card-to-card view, from the route', () => {
  const route = { path: '/payment-gateways/card-to-card', query: new URLSearchParams() };

  it('passes the cards’ edit key separately from their view key', async () => {
    stubApi(accounts());
    const viewOnly = resolve(route, ['payments.accounts.view']);
    renderPage(viewOnly.element as ReactElement);
    await screen.findByText('Bank Melli');
    expect(document.body.textContent).not.toContain(t('web.payment_account_add'));
    cleanup();

    stubApi(accounts());
    const editor = resolve(route, ['payments.accounts.edit']);
    renderPage(editor.element as ReactElement);
    expect(
      await screen.findByRole('button', { name: t('web.payment_account_add') }),
    ).toBeInTheDocument();
  });

  it('shows a cards-only role the cards, and no refusal for the route it may not read', async () => {
    const api = stubApi(accounts());
    renderPage(resolve(route, ['payments.accounts.view']).element as ReactElement);
    await screen.findByText('Bank Melli');
    expect(screen.queryByText(t('web.payment_method_settings'))).toBeNull();
    // Neither the routes nor their health were asked for: those are not this role's.
    expect(api.calls.some((call) => call.url.includes('/payment-gateways'))).toBe(false);
  });

  it('draws no cards for a role that may read the route but not the cards', async () => {
    const api = stubApi([
      ...accounts(),
      { url: '/payment-gateways', body: { gateways: [] } },
      {
        url: '/payment-gateways-health',
        body: { window: null, gateways: [], withheld: [], generatedAt: ACCOUNT.updatedAt },
      },
    ]);
    renderPage(resolve(route, ['payments.gateways.view']).element as ReactElement);
    await screen.findByText(t('web.payment_method_missing'));
    expect(screen.queryByText(t('web.payment_accounts_title'))).toBeNull();
    expect(api.calls.some((call) => call.url.includes('/payment-accounts'))).toBe(false);
  });
});
