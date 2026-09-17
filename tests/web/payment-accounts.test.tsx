import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { cleanup, screen } from '@testing-library/react';
import { PaymentAccountsPage } from '../../apps/web/src/pages/payment-accounts';
import { resolve } from '../../apps/web/src/app';
import { renderPage, stubApi } from './harness';

/**
 * The Payment Accounts screen, and the ONE thing its shape has to get right.
 *
 * `payments.accounts.view` and `payments.accounts.edit` are two permissions, the nav
 * admits a role holding EITHER, and every write is authorized with `edit` alone. The
 * page derived all of it from `view`, so it was wrong in both directions at once — and
 * the Codex review of PR #34 named both. The cases here are the two directions.
 *
 * `UNK-ADM-001` is the legacy version of this: nobody could establish whether admin
 * roles were enforced at all, or whether hiding a menu entry WAS the enforcement. Here
 * the server enforces and the page must agree with it; a drawn control nobody may press
 * is the same lie told the other way round.
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
  sortOrder: 0,
  createdAt: '2026-09-10T12:30:00.000Z',
  updatedAt: '2026-09-10T12:30:00.000Z',
};

const accounts = (rows: unknown[] = [ACCOUNT]) => [
  { url: '/payment-accounts', body: { accounts: rows } },
];

/** Every write control the page can draw, by its Persian label. */
const WRITE_CONTROLS = ['حساب جدید', 'ویرایش', 'پیش‌فرض کردن', 'غیرفعال کردن'];

describe('the payment accounts screen and its two permissions', () => {
  it('draws no write control for a role that may only view', async () => {
    stubApi(accounts());
    const { container } = renderPage(<PaymentAccountsPage denied={false} mayEdit={false} />);
    await screen.findByText('Bank Melli');

    // The rows ARE rendered — this is a view-only role, not a denial.
    expect(container.textContent).toContain('Acme Store');
    for (const label of WRITE_CONTROLS) {
      expect(container.textContent, label).not.toContain(label);
    }
  });

  it('draws the form and the row controls for a role that may edit', async () => {
    stubApi(accounts());
    const { container } = renderPage(<PaymentAccountsPage denied={false} mayEdit />);
    await screen.findByText('Bank Melli');

    for (const label of WRITE_CONTROLS) {
      expect(container.textContent, label).toContain(label);
    }
  });

  /*
   * The edit-only role, which is the direction that LOST something.
   *
   * `denied` is derived from `view`, so this role arrives with `denied=true`. The form
   * must still be there: it is the only role allowed to use it, and before the fix the
   * page hid it from exactly that role.
   */
  it('keeps the form for an edit-only role, whose list read is denied', async () => {
    stubApi(accounts());
    const { container } = renderPage(<PaymentAccountsPage denied mayEdit />);
    await screen.findByText('حساب جدید');
    expect(container.textContent).toContain('حساب جدید');
  });

  it('shows neither list nor form when a role holds neither permission', async () => {
    stubApi(accounts());
    const { container } = renderPage(<PaymentAccountsPage denied mayEdit={false} />);
    // Nothing is awaited: the query is disabled and the form is not drawn, so the only
    // stable assertion is the absence of both.
    expect(container.textContent).not.toContain('Bank Melli');
    for (const label of WRITE_CONTROLS) {
      expect(container.textContent, label).not.toContain(label);
    }
  });

  /*
   * The ROUTE, not the page.
   *
   * `resolve` is what passes the two props, and a page gated correctly behind a route
   * that passes `mayEdit` from the wrong key would still be wrong. This asserts the
   * wiring by resolving the route twice with different permission sets and rendering
   * what comes back.
   */
  it('passes edit separately from view, from the route', async () => {
    const route = { path: '/payment-accounts', query: new URLSearchParams() };
    stubApi(accounts());
    const viewOnly = resolve(route, ['payments.accounts.view']);
    renderPage(viewOnly.element as ReactElement);
    await screen.findByText('Bank Melli');
    expect(document.body.textContent).not.toContain('حساب جدید');
    cleanup();

    stubApi(accounts());
    const editor = resolve(route, ['payments.accounts.edit']);
    renderPage(editor.element as ReactElement);
    await screen.findByText('حساب جدید');
    expect(document.body.textContent).toContain('حساب جدید');
  });
});
