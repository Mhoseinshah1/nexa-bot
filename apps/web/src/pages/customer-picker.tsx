import { useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CustomerSummaryResponse } from '@nexa/contracts';
import { fetchCustomers } from '../api/client';
import { t } from '../i18n/web.fa';
import { Banner, Button, Field, Ltr } from '../ui/kit';
import { messageFor } from './settings';
import { displayName, StatusBadge } from './customer-parts';

/**
 * Picking ONE customer by what an operator actually has (UX batch 01, item 9).
 *
 * The reseller form asked for the customer's internal uuid, which nobody has: an operator
 * typing the Telegram id they were given was told the id was "not complete and valid".
 * This is the search they can use instead — and it is NOT a new search. It is
 * `GET /users?q=`, the customer list's one search box, so what it matches and what it
 * charges are the list's (`docs/web-admin-search.md`): a Telegram id EXACTLY, a username
 * with or without `@` from its start, case-insensitively, or the start of a display name
 * or last name; scoped to the actor's tenant and charged `users.view` and `users.search`.
 *
 * Two rules this component exists to keep:
 *
 * - **Nothing is ever chosen for the operator.** Not when one row matches, and certainly
 *   not when several do: a username prefix can match `ali` and `alireza`, and choosing
 *   either silently would make the wrong customer a reseller. Every result is a button,
 *   and the selection is the press.
 * - **Only identifying fields are drawn**: name, `@username`, Telegram id and status. The
 *   summary carries more (an operator's block note among it) and none of it belongs here.
 *
 * The caller stores the chosen customer's id; the operator never sees or copies it.
 */
export const CUSTOMER_PICKER_LIMIT = 10;

export function CustomerPicker({
  inputId,
  maySearch,
  onPick,
}: {
  /** The search box's id, so a page can scroll to and focus it. */
  inputId: string;
  /**
   * `users.view` AND `users.search`: `CustomerService.list` charges both for a `q`, and a
   * GRANT override can give search without view. Without both none is sent.
   */
  maySearch: boolean;
  onPick: (customer: CustomerSummaryResponse) => void;
}) {
  const [draft, setDraft] = useState('');
  const [applied, setApplied] = useState('');
  const results = useQuery({
    queryKey: ['customer-picker', applied],
    queryFn: () => fetchCustomers({ q: applied, limit: CUSTOMER_PICKER_LIMIT }),
    enabled: maySearch && applied !== '',
  });

  if (!maySearch) {
    return (
      <Field label={t('web.reseller_customer_id')} htmlFor={inputId}>
        <Banner tone="info">{t('web.customer_picker_denied')}</Banner>
      </Field>
    );
  }

  const search = () => setApplied(draft.trim());
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Enter searches; it must not submit an enclosing form with no customer chosen.
    if (event.key !== 'Enter') return;
    event.preventDefault();
    search();
  };
  const rows = results.data?.customers ?? [];

  return (
    <Field
      label={t('web.reseller_customer_id')}
      hint={t('web.customer_picker_hint')}
      htmlFor={inputId}
    >
      <div className="customer-picker-bar">
        <input
          id={inputId}
          type="search"
          dir="auto"
          maxLength={64}
          autoComplete="off"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <Button size="sm" icon="search" disabled={draft.trim() === ''} onClick={search}>
          {t('web.customer_picker_search')}
        </Button>
      </div>
      {applied === '' ? null : results.isPending ? (
        <p className="muted small">{t('web.loading')}</p>
      ) : results.isError ? (
        <Banner tone="danger">{messageFor(results.error)}</Banner>
      ) : rows.length === 0 ? (
        <Banner tone="warn">{t('web.customer_picker_none')}</Banner>
      ) : (
        <>
          <p className="muted small" role="status">
            {rows.length === 1 ? t('web.customer_picker_one') : t('web.customer_picker_many')}
          </p>
          <ul className="customer-picker-results" aria-label={t('web.customer_picker_results')}>
            {rows.map((row) => (
              <li key={row.id}>
                <CustomerIdentity customer={row} />
                <Button size="sm" variant="primary" onClick={() => onPick(row)}>
                  {t('web.customer_picker_choose')}
                </Button>
              </li>
            ))}
          </ul>
          {results.data?.nextCursor !== null && (
            <p className="muted small">{t('web.customer_picker_more')}</p>
          )}
        </>
      )}
    </Field>
  );
}

/** Who a customer is, in the fields an operator recognises them by — and no others. */
export function CustomerIdentity({ customer }: { customer: CustomerSummaryResponse }) {
  const name = displayName(customer);
  return (
    <span className="customer-picker-who">
      <span className="strong">{name ?? t('web.customer_picker_unnamed')}</span>
      {customer.username !== null && (
        <span className="muted">
          <Ltr>@{customer.username}</Ltr>
        </span>
      )}
      <span className="muted small">
        {t('web.user_telegram_id')} <Ltr>{customer.telegramUserId}</Ltr>
      </span>
      {customer.status !== 'ACTIVE' && <StatusBadge status={customer.status} />}
    </span>
  );
}
