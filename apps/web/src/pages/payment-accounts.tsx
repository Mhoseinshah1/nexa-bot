import { useEffect, useRef, useState } from 'react';
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
  Disclosure,
  Badge,
  Banner,
  Card,
  Copyable,
  DataTable,
  Empty,
  Field,
  Ltr,
  Checkbox,
  Num,
  RowActions,
  StateSwitch,
  useToast,
  useUnsavedChanges,
  type Column,
} from '../ui/kit';
import { Icon } from '../ui/icons';

/**
 * Payment accounts — where an out-of-band transfer is told to go.
 *
 * UX Batch 01, item 7: these are the CARDS of the card-to-card payment method, and they
 * are managed on that method's own view (`/payment-gateways/card-to-card`), beside the
 * route's switch and settings, instead of on a separate «حساب‌های دریافت» screen. Only
 * the screen moved: the API, the two permissions and every write below are the ones the
 * standalone page used, and `/payment-accounts` redirects here.
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
 * **No delete.** An account is disabled — that IS its archive, and the form hint says so.
 * `payment_destinations` names the row each payment was issued against, and a deleted
 * account is a payment whose provenance is a dangling id.
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
export function CardAccountsSection({
  denied,
  mayEdit,
  adding,
  onAddingChange,
}: {
  denied: boolean;
  mayEdit: boolean;
  /**
   * Whether the new-card form is open. Held by the page, because «افزودن کارت» is drawn
   * twice — on this card and beside the card-to-card route's own actions — and both open
   * the one form.
   */
  adding: boolean;
  onAddingChange: (next: boolean) => void;
}) {
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
    onAddingChange(false);
  };

  /** The form is drawn only while it is being used: adding a card, or correcting one. */
  const formOpen = mayEdit && (adding || editing !== null);
  /*
   * Opening the form moves focus into it, so the operator lands on the first field of the
   * form they asked for — the keyboard and screen-reader half of "no scroll-jump".
   */
  const firstField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (formOpen) firstField.current?.focus();
  }, [formOpen, editing]);

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

  /*
   * Dirty-state protection: the form differs from what it was opened with — the
   * empty form for a new account, the stored row for a correction. Leaving the
   * page asks first.
   */
  const editedRow = editing === null ? undefined : rows.find((row) => row.id === editing);
  const basisForm = editedRow === undefined ? EMPTY_FORM : formOf(editedRow);
  const formDirty = JSON.stringify(form) !== JSON.stringify(basisForm) || makeDefault;
  useUnsavedChanges(formOpen && formDirty);

  const columns: readonly Column<PaymentAccountView>[] = [
    {
      key: 'label',
      header: t('web.payment_account_label'),
      render: (row) => (
        <span className="accounts-label">
          <span className="strong">{row.label}</span>
          {row.isDefault && (
            <Badge tone="ok" outline>
              {t('web.payment_account_default')}
            </Badge>
          )}
        </span>
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
        <Badge tone={row.enabled ? 'ok' : 'neutral'} dot>
          {t(row.enabled ? 'web.payment_account_enabled' : 'web.payment_account_disabled')}
        </Badge>
      ),
    },
    {
      // The order the bot offers the cards in (`sortOrder`, ascending); set in the form.
      key: 'sort',
      header: t('web.payment_account_sort'),
      render: (row) => <Num value={row.sortOrder} />,
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
          <RowActions>
            <button
              type="button"
              className="btn sm"
              disabled={busy}
              onClick={() => {
                onAddingChange(false);
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
          </RowActions>
        ),
    },
  ];

  const addButton = (
    <button
      type="button"
      className="btn sm primary"
      disabled={busy}
      onClick={() => {
        setEditing(null);
        setForm(EMPTY_FORM);
        setMakeDefault(false);
        onAddingChange(true);
      }}
    >
      <Icon name="plus" />
      {t('web.payment_account_add')}
    </button>
  );

  return (
    <>
      <Card
        title={t('web.payment_accounts_title')}
        hint={t('web.payment_accounts_subtitle')}
        {...(mayEdit ? { actions: addButton } : {})}
      >
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
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            caption={t('web.payment_accounts_title')}
            dense
          />
        </StateSwitch>
      </Card>
      {/*
        Directly beneath the cards it changes, and only while it is in use. Outside the
        list's StateSwitch on purpose: a tenant with NO card still needs the form, and that
        is exactly the installation whose card-to-card button is not drawn to customers —
        and an edit-only role, whose list read is refused, can still add one.
      */}
      {formOpen && (
        <Card
          title={t(editing === null ? 'web.payment_account_new' : 'web.payment_account_editing')}
          hint={t('web.payment_account_form_hint')}
          className="accounts-form"
        >
          <div className="form-grid">
            <Field label={t('web.payment_account_label')} htmlFor="pa-label">
              <input
                ref={firstField}
                id="pa-label"
                className="input"
                value={form.label}
                maxLength={80}
                onChange={(event) => setForm({ ...form, label: event.target.value })}
              />
            </Field>
            <Field label={t('web.payment_account_bank')} htmlFor="pa-bank">
              <input
                id="pa-bank"
                className="input"
                value={form.bankName}
                maxLength={80}
                onChange={(event) => setForm({ ...form, bankName: event.target.value })}
              />
            </Field>
            <Field label={t('web.payment_account_holder')} htmlFor="pa-holder">
              <input
                id="pa-holder"
                className="input"
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
                className="input ltr mono"
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
                className="input ltr mono"
                value={form.iban}
                maxLength={40}
                onChange={(event) => setForm({ ...form, iban: event.target.value })}
              />
            </Field>
          </div>
          <Disclosure summary={t('web.payment_gateway_section_advanced')}>
            <Field label={t('web.payment_account_sort')} htmlFor="pa-sort">
              <input
                id="pa-sort"
                className="input"
                dir="ltr"
                value={form.sortOrder}
                inputMode="numeric"
                onChange={(event) => setForm({ ...form, sortOrder: event.target.value })}
              />
            </Field>
          </Disclosure>

          {editing === null && (
            <Checkbox
              label={t('web.payment_account_make_default')}
              checked={makeDefault}
              onChange={setMakeDefault}
            />
          )}

          {editing === null && atLimit && (
            <Banner tone="warn">{t('web.payment_account_limit')}</Banner>
          )}

          <div className="form-actions">
            <button
              type="button"
              className="btn primary"
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
            <button type="button" className="btn" disabled={busy} onClick={reset}>
              {t('web.payment_account_cancel_edit')}
            </button>
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
