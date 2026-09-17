import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PAYMENT_ACCOUNT_MAX_PER_TENANT, type PaymentAccountView } from '@nexa/contracts';
import {
  createPaymentAccount,
  fetchPaymentAccounts,
  setDefaultPaymentAccount,
  setPaymentAccountEnabled,
  updatePaymentAccount,
} from '../api/client';
import { formatTimestamp } from '../format';
import { useSubmissionKey } from '../submission-key';
import { queryState } from '../view-state';
import { t } from '../i18n/web.fa';
import { messageFor } from './settings';
import {
  Badge,
  Banner,
  Card,
  Copyable,
  DataTable,
  Empty,
  Field,
  Ltr,
  PageHead,
  StateSwitch,
  useToast,
  type Column,
} from '../ui/kit';

/**
 * Payment accounts — where an out-of-band transfer is told to go.
 *
 * The screen that replaces editing a message template to change a card number.
 * `docs/phase5-audit.md` §1 measures what that cost: one template body is one
 * destination, editing it rewrote what every already-issued instruction said, and
 * nothing validated a transposed digit.
 *
 * **Four writes, four buttons, four audit rows.** Add, correct, stop/resume, promote.
 * They are separate because they are separate operator decisions: correcting a holder
 * name is not moving where money arrives, and a single form that did both would make
 * "who moved the destination" answerable only by diffing two payloads.
 *
 * **No delete.** An account is disabled. `payment_destinations` names the row each
 * payment was issued against, and a deleted account is a payment whose provenance is a
 * dangling id.
 *
 * **The list is complete, not paged.** Every other list in this admin is a keyset page;
 * this one cannot be, because a configuration screen that silently omits the row an
 * operator is looking for is worse than one that refuses the fifty-first account.
 *
 * **The card number is masked in the table and shown in full in the form.** It is not a
 * secret — the bot publishes it to every customer who pays out of band — so the masking
 * is about a screen in a shared office, not about the response body. The form shows the
 * whole number because that is where an operator checks it against their bank.
 */

const EMPTY_FORM = {
  label: '',
  bankName: '',
  holderName: '',
  cardNumber: '',
  iban: '',
  sortOrder: '0',
};

type FormState = typeof EMPTY_FORM;

function formOf(account: PaymentAccountView): FormState {
  return {
    label: account.label,
    bankName: account.bankName,
    holderName: account.holderName,
    cardNumber: account.cardNumber,
    iban: account.iban ?? '',
    sortOrder: String(account.sortOrder),
  };
}

/**
 * The last four digits, and dots for the rest.
 *
 * Presentation only, and it must never be what a form submits: an operator who edited a
 * masked value would be sending dots to the server. The edit form is populated from the
 * unmasked response.
 */
function mask(cardNumber: string): string {
  return `•••• •••• •••• ${cardNumber.slice(-4)}`;
}

/**
 * `mayEdit` is passed, never derived from `denied`.
 *
 * The nav admits either `payments.accounts.view` or `payments.accounts.edit`, and the
 * service authorizes every write with `edit` alone — so deriving the whole page from
 * `view` was wrong in both directions at once: an edit-only role arrived with
 * `denied=true` and lost the form it is the only role allowed to use, while the seeded
 * view-only roles (operator, observer) were handed every create, edit, promote and
 * disable control and learnt about the refusal by pressing one. Drawing a control
 * nobody may use is the legacy defect `UNK-ADM-001` names from the other end — there
 * the menu was the only enforcement; here the menu disagreed with it. Found by the
 * Codex review of PR #34.
 */
export function PaymentAccountsPage({ denied, mayEdit }: { denied: boolean; mayEdit: boolean }) {
  const queries = useQueryClient();
  const notify = useToast();
  const submission = useSubmissionKey();

  const accounts = useQuery({
    queryKey: ['payment-accounts'],
    queryFn: () => fetchPaymentAccounts(),
    enabled: !denied,
  });

  /** Null while adding; an account id while correcting one. ONE form, two intents. */
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [makeDefault, setMakeDefault] = useState(false);

  const rows = accounts.data?.accounts ?? [];
  const atLimit = rows.length >= PAYMENT_ACCOUNT_MAX_PER_TENANT;

  const reset = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setMakeDefault(false);
  };

  const refresh = () => {
    void queries.invalidateQueries({ queryKey: ['payment-accounts'] });
  };

  const payload = () => ({
    label: form.label.trim(),
    bankName: form.bankName.trim(),
    holderName: form.holderName.trim(),
    cardNumber: form.cardNumber.trim(),
    iban: form.iban.trim() === '' ? null : form.iban.trim(),
    sortOrder: Number(form.sortOrder) || 0,
  });

  const save = useMutation({
    mutationFn: () => {
      const fields = payload();
      /*
       * The key is bound to the whole payload AND to which account is being written,
       * so correcting a typo and pressing save again is a NEW command rather than a
       * replay the store refuses as a payload mismatch.
       */
      const idempotencyKey = submission.current({ editing, ...fields, makeDefault });
      return editing === null
        ? createPaymentAccount({ ...fields, idempotencyKey, enabled: true, makeDefault })
        : updatePaymentAccount({ ...fields, idempotencyKey, id: editing });
    },
    onSuccess: () => {
      submission.settle();
      notify({ tone: 'ok', message: t('web.payment_account_saved') });
      reset();
      refresh();
    },
    // A 5xx may have committed. A fresh key on the retry would be a second account.
    onError: (error) => submission.settleOn(error),
  });

  const toggle = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) =>
      setPaymentAccountEnabled({
        ...input,
        idempotencyKey: submission.current({ toggle: input.id, enabled: input.enabled }),
      }),
    onSuccess: () => {
      submission.settle();
      notify({ tone: 'ok', message: t('web.payment_account_saved') });
      refresh();
    },
    onError: (error) => submission.settleOn(error),
  });

  const promote = useMutation({
    mutationFn: (id: string) =>
      setDefaultPaymentAccount({ id, idempotencyKey: submission.current({ promote: id }) }),
    onSuccess: () => {
      submission.settle();
      notify({ tone: 'ok', message: t('web.payment_account_default_done') });
      refresh();
    },
    onError: (error) => submission.settleOn(error),
  });

  const busy = save.isPending || toggle.isPending || promote.isPending;
  const failure = save.error ?? toggle.error ?? promote.error;

  const columns: readonly Column<PaymentAccountView>[] = [
    {
      key: 'label',
      header: t('web.payment_account_label'),
      render: (row) => (
        <>
          {row.label}
          {row.isDefault && (
            <>
              {' '}
              <Badge tone="ok">{t('web.payment_account_default')}</Badge>
            </>
          )}
        </>
      ),
    },
    { key: 'bank', header: t('web.payment_account_bank'), render: (row) => row.bankName },
    { key: 'holder', header: t('web.payment_account_holder'), render: (row) => row.holderName },
    {
      key: 'card',
      header: t('web.payment_account_card'),
      render: (row) => <Ltr>{mask(row.cardNumber)}</Ltr>,
    },
    {
      key: 'state',
      header: t('web.payment_account_state'),
      render: (row) => (
        <Badge tone={row.enabled ? 'ok' : 'neutral'}>
          {t(row.enabled ? 'web.payment_account_enabled' : 'web.payment_account_disabled')}
        </Badge>
      ),
    },
    {
      key: 'updated',
      header: t('web.payment_account_updated'),
      render: (row) => formatTimestamp(row.updatedAt),
    },
    {
      key: 'actions',
      header: t('web.payment_account_actions'),
      align: 'end',
      // Nothing at all for a view-only role. The column header stays, because a table
      // whose columns depend on the reader is a table two operators describe differently.
      render: (row) =>
        !mayEdit ? null : (
          <div className="toolbar">
            <button
              type="button"
              className="btn sm"
              disabled={busy}
              onClick={() => {
                setEditing(row.id);
                setForm(formOf(row));
                setMakeDefault(false);
              }}
            >
              {t('web.payment_account_edit')}
            </button>
            {!row.isDefault && row.enabled && (
              <button
                type="button"
                className="btn sm"
                disabled={busy}
                onClick={() => promote.mutate(row.id)}
              >
                {t('web.payment_account_make_default')}
              </button>
            )}
            {/*
            The default cannot be disabled here, and the server refuses it too. Which
            account money arrives in next is a decision with a person behind it; a
            system that promoted one automatically would have made a financial choice
            nobody recorded.
          */}
            {!row.isDefault && (
              <button
                type="button"
                className="btn sm"
                disabled={busy}
                onClick={() => toggle.mutate({ id: row.id, enabled: !row.enabled })}
              >
                {t(row.enabled ? 'web.payment_account_disable' : 'web.payment_account_enable')}
              </button>
            )}
          </div>
        ),
    },
  ];

  return (
    <>
      <PageHead
        title={t('web.payment_accounts_title')}
        subtitle={t('web.payment_accounts_subtitle')}
        maturity="now"
      />

      <StateSwitch
        query={accounts}
        denied={denied}
        isEmpty={queryState(accounts) === 'ready' && rows.length === 0}
        empty={
          <Empty
            title={t('web.payment_accounts_empty')}
            hint={t('web.payment_accounts_empty_hint')}
          />
        }
      >
        <Card title={t('web.payment_accounts_title')}>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            caption={t('web.payment_accounts_title')}
          />
        </Card>
      </StateSwitch>

      {/*
        Outside the StateSwitch on purpose: a tenant with NO account still needs the
        form, and that is exactly the installation whose manual-transfer button is not
        being drawn to customers.
      */}
      {mayEdit && (
        <Card
          title={t(editing === null ? 'web.payment_account_new' : 'web.payment_account_editing')}
          hint={t('web.payment_account_form_hint')}
        >
          <Field label={t('web.payment_account_label')} htmlFor="pa-label">
            <input
              id="pa-label"
              value={form.label}
              maxLength={80}
              onChange={(event) => setForm({ ...form, label: event.target.value })}
            />
          </Field>
          <Field label={t('web.payment_account_bank')} htmlFor="pa-bank">
            <input
              id="pa-bank"
              value={form.bankName}
              maxLength={80}
              onChange={(event) => setForm({ ...form, bankName: event.target.value })}
            />
          </Field>
          <Field label={t('web.payment_account_holder')} htmlFor="pa-holder">
            <input
              id="pa-holder"
              value={form.holderName}
              maxLength={120}
              onChange={(event) => setForm({ ...form, holderName: event.target.value })}
            />
          </Field>
          {/*
            Sent exactly as typed. Persian digits, spaces and dashes are normalised on
            the SERVER, inside `paymentAccountInputSchema`, so that what is stored and
            what is frozen onto a payment are one representation decided in one place.
          */}
          <Field
            label={t('web.payment_account_card')}
            htmlFor="pa-card"
            hint={t('web.payment_account_card_hint')}
          >
            <input
              id="pa-card"
              value={form.cardNumber}
              maxLength={40}
              inputMode="numeric"
              onChange={(event) => setForm({ ...form, cardNumber: event.target.value })}
            />
          </Field>
          <Field
            label={t('web.payment_account_iban')}
            htmlFor="pa-iban"
            hint={t('web.payment_account_iban_hint')}
          >
            <input
              id="pa-iban"
              value={form.iban}
              maxLength={40}
              onChange={(event) => setForm({ ...form, iban: event.target.value })}
            />
          </Field>
          <Field label={t('web.payment_account_sort')} htmlFor="pa-sort">
            <input
              id="pa-sort"
              value={form.sortOrder}
              inputMode="numeric"
              onChange={(event) => setForm({ ...form, sortOrder: event.target.value })}
            />
          </Field>

          {editing === null && (
            <Field label={t('web.payment_account_make_default')} htmlFor="pa-default">
              <input
                id="pa-default"
                type="checkbox"
                checked={makeDefault}
                onChange={(event) => setMakeDefault(event.target.checked)}
              />
            </Field>
          )}

          {editing === null && atLimit && (
            <Banner tone="warn">{t('web.payment_account_limit')}</Banner>
          )}

          <div className="toolbar">
            <button
              type="button"
              className="btn primary sm"
              disabled={
                busy ||
                (editing === null && atLimit) ||
                form.label.trim() === '' ||
                form.bankName.trim() === '' ||
                form.holderName.trim() === '' ||
                form.cardNumber.trim() === ''
              }
              onClick={() => save.mutate()}
            >
              {t('web.payment_account_save')}
            </button>
            {editing !== null && (
              <button type="button" className="btn sm" disabled={busy} onClick={reset}>
                {t('web.payment_account_cancel_edit')}
              </button>
            )}
          </div>

          {editing !== null && (
            <p className="muted small">
              <Copyable value={editing} />
            </p>
          )}
          {failure != null && <Banner tone="danger">{messageFor(failure)}</Banner>}
        </Card>
      )}
    </>
  );
}
