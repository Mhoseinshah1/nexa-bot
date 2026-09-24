import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  SUPPORT_FAQ_ANSWER_MAX_LENGTH,
  SUPPORT_FAQ_QUESTION_MAX_LENGTH,
  SUPPORT_FAQ_SORT_MAX,
  SUPPORT_FAQ_SORT_MIN,
  type SupportFaqResponse,
  type SupportFaqStatus,
} from '@nexa/contracts';
import {
  ApiError,
  createSupportFaq,
  fetchSupportFaqs,
  setSupportFaqStatus,
  updateSupportFaq,
} from '../api/client';
import { formatTimestamp } from '../format';
import { useLinkHandler } from '../router';
import { useSubmissionKey } from '../submission-key';
import { queryState } from '../view-state';
import { t } from '../i18n/web.fa';
import { messageFor } from './settings';
import {
  Badge,
  Banner,
  Card,
  DataTable,
  Empty,
  Field,
  PageHead,
  StateSwitch,
  useToast,
  type Column,
} from '../ui/kit';

/**
 * Support — the FAQ the bot answers with, and a pointer at where support goes.
 *
 * **The destination is not edited here.** `support.accounts` is a setting with its own
 * list editor on the settings page, and the bot's contact button opens the FIRST handle
 * in it. A second editor for the same key on this page would be two screens that can
 * disagree about one value, so this page says where the editor is and links to it.
 *
 * **Every write states the version it read.** The form is opened from a row and the row
 * it was opened from is its `basis`; the save sends `basis.version` as `expectedVersion`.
 * A colleague's edit in between comes back as `commerce.support_faq_version_conflict`,
 * and the page offers the fresh row rather than overwriting theirs — `SettingRow`'s rule,
 * applied to a table.
 *
 * **Two writes, two buttons, two audit rows.** Rewording an entry and hiding it are
 * different operator decisions; folding the status into the form would make "who hid
 * this answer, and when" answerable only by diffing two payloads.
 *
 * `mayEdit` is passed, never derived from `denied`: the page takes `settings.view` and
 * writing takes `settings.edit`, which the server charges on its own.
 */

const VERSION_CONFLICT = 'commerce.support_faq_version_conflict';
const LIMIT = 'commerce.support_faq_limit';

const EMPTY_FORM = { question: '', answer: '', sortOrder: '0' };
type FormState = typeof EMPTY_FORM;

function formOf(row: SupportFaqResponse): FormState {
  return { question: row.question, answer: row.answer, sortOrder: String(row.sortOrder) };
}

/** Closed, a new entry, or an existing entry with the row the draft is based on. */
type Editor =
  | { readonly kind: 'closed' }
  | { readonly kind: 'create' }
  | { readonly kind: 'edit'; readonly basis: SupportFaqResponse };

const GROUPING = /[\s,\u066C\u2009\u202F']/gu;

/**
 * The sort order as the whole number the operator typed, or `null` when it is not one.
 *
 * `minorOf`'s rule from the gateways page: grouping separators and Persian or
 * Arabic-Indic digits are ways of WRITING the same number and are accepted; a sign, a
 * decimal point or letters are refused rather than reinterpreted, so a stored order
 * never differs from the one on screen.
 */
export function sortOrderOf(value: string): number | null {
  const latin = value
    .trim()
    .replace(GROUPING, '')
    .replace(/[\u06F0-\u06F9]/gu, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\u0660-\u0669]/gu, (d) => String(d.charCodeAt(0) - 0x0660));
  if (!/^[0-9]{1,6}$/u.test(latin)) return null;
  const parsed = Number(latin);
  return parsed >= SUPPORT_FAQ_SORT_MIN && parsed <= SUPPORT_FAQ_SORT_MAX ? parsed : null;
}

/** The two refusals this page can name better than the server's sentence can. */
function faultOf(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === VERSION_CONFLICT) return t('web.support_faq_conflict');
    if (error.code === LIMIT) return t('web.support_faq_limit');
  }
  return messageFor(error);
}

function isVersionConflict(error: unknown): boolean {
  return error instanceof ApiError && error.code === VERSION_CONFLICT;
}

export function SupportPage({ denied, mayEdit }: { denied: boolean; mayEdit: boolean }) {
  const queries = useQueryClient();
  const notify = useToast();
  const submission = useSubmissionKey();
  const onLink = useLinkHandler();

  const faqs = useQuery({
    queryKey: ['support-faqs'],
    queryFn: () => fetchSupportFaqs(),
    enabled: !denied,
  });
  const rows = faqs.data?.items ?? [];

  const [editor, setEditor] = useState<Editor>({ kind: 'closed' });
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  const refresh = () => {
    void queries.invalidateQueries({ queryKey: ['support-faqs'] });
  };
  const close = () => {
    setEditor({ kind: 'closed' });
    setForm(EMPTY_FORM);
  };
  const openCreate = () => {
    setEditor({ kind: 'create' });
    setForm(EMPTY_FORM);
  };
  const openEdit = (row: SupportFaqResponse) => {
    setEditor({ kind: 'edit', basis: row });
    setForm(formOf(row));
  };

  /**
   * The WHOLE command is the mutation's variable — `SettingRow`'s rule. react-query
   * hands the variables back unchanged on a retry, which is the only way the key
   * protects anything; a `mutationFn` reading `form` out of the closure would retry the
   * original key with the latest typing.
   */
  const save = useMutation({
    mutationFn: (command: {
      idempotencyKey: string;
      question: string;
      answer: string;
      sortOrder: number;
      basis: SupportFaqResponse | null;
    }) =>
      command.basis === null
        ? createSupportFaq({
            idempotencyKey: command.idempotencyKey,
            question: command.question,
            answer: command.answer,
            sortOrder: command.sortOrder,
          })
        : updateSupportFaq({
            id: command.basis.id,
            idempotencyKey: command.idempotencyKey,
            question: command.question,
            answer: command.answer,
            sortOrder: command.sortOrder,
            expectedVersion: command.basis.version,
          }),
    onSuccess: () => {
      submission.settle();
      notify({ tone: 'ok', message: t('web.support_faq_saved') });
      close();
      refresh();
    },
    // A conflict means the cached row is stale, and only a success refreshed it — so
    // refetch here, or the reload button would offer the row the conflict was about.
    // A 5xx may have committed; the key survives it.
    onError: (error) => {
      submission.settleOn(error);
      refresh();
    },
  });

  const toggle = useMutation({
    mutationFn: (input: { id: string; status: SupportFaqStatus; expectedVersion: number }) =>
      setSupportFaqStatus({ ...input, idempotencyKey: submission.current({ toggle: input }) }),
    onSuccess: () => {
      submission.settle();
      notify({ tone: 'ok', message: t('web.support_faq_status_done') });
      refresh();
    },
    onError: (error) => {
      submission.settleOn(error);
      refresh();
    },
  });

  const busy = save.isPending || toggle.isPending;

  const sortOrder = sortOrderOf(form.sortOrder);
  const textMissing = form.question.trim() === '' || form.answer.trim() === '';
  const formInvalid = sortOrder === null || textMissing;

  /**
   * Not while OUR OWN write is settling, for the reason `SettingRow` gives: between
   * the success and the refetch the basis is the newest version there is. A refused
   * save with `VERSION_CONFLICT` shows the same notice, because the list may not have
   * refetched yet and the operator needs the reload control now, not after it does.
   */
  const current =
    editor.kind === 'edit' ? rows.find((row) => row.id === editor.basis.id) : undefined;
  const changedElsewhere =
    editor.kind === 'edit' &&
    !save.isPending &&
    ((current !== undefined && current.version !== editor.basis.version) ||
      isVersionConflict(save.error));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (sortOrder === null || textMissing) return;
    // Snapshotted HERE, at the click, so the retry cannot see a later edit.
    const command = {
      question: form.question.trim(),
      answer: form.answer.trim(),
      sortOrder,
      basis: editor.kind === 'edit' ? editor.basis : null,
    };
    save.mutate({ ...command, idempotencyKey: submission.current(command) });
  };

  const newButton = (
    <button type="button" className="btn primary sm" disabled={busy} onClick={openCreate}>
      {t('web.support_faq_new')}
    </button>
  );

  const columns: readonly Column<SupportFaqResponse>[] = [
    { key: 'order', header: t('web.support_faq_order'), render: (row) => String(row.sortOrder) },
    { key: 'question', header: t('web.support_faq_question'), render: (row) => row.question },
    {
      key: 'status',
      header: t('web.support_faq_status'),
      render: (row) => (
        <Badge tone={row.status === 'ACTIVE' ? 'ok' : 'neutral'}>
          {t(row.status === 'ACTIVE' ? 'web.support_faq_active' : 'web.support_faq_inactive')}
        </Badge>
      ),
    },
    {
      key: 'updated',
      header: t('web.support_faq_updated'),
      render: (row) => formatTimestamp(row.updatedAt),
    },
    {
      key: 'actions',
      header: t('web.support_faq_actions'),
      align: 'end',
      // Nothing at all for a view-only role. The column header stays, because a table
      // whose columns depend on the reader is a table two operators describe differently.
      render: (row) =>
        !mayEdit ? null : (
          <div className="toolbar">
            <button type="button" className="btn sm" disabled={busy} onClick={() => openEdit(row)}>
              {t('web.support_faq_edit')}
            </button>
            <button
              type="button"
              className="btn sm"
              disabled={busy}
              onClick={() =>
                toggle.mutate({
                  id: row.id,
                  status: row.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
                  expectedVersion: row.version,
                })
              }
            >
              {t(
                row.status === 'ACTIVE' ? 'web.support_faq_deactivate' : 'web.support_faq_activate',
              )}
            </button>
          </div>
        ),
    },
  ];

  return (
    <>
      <PageHead
        title={t('web.support_title')}
        subtitle={t('web.support_subtitle')}
        maturity="now"
      />

      <Card title={t('web.support_destination_title')}>
        <p className="muted small">{t('web.support_destination_note')}</p>
        <a className="btn sm" href="/settings" onClick={onLink}>
          {t('web.support_destination_link')}
        </a>
      </Card>

      <StateSwitch
        query={faqs}
        denied={denied}
        isEmpty={queryState(faqs) === 'ready' && rows.length === 0}
        empty={
          <Empty
            title={t('web.support_faq_empty')}
            hint={t('web.support_faq_empty_hint')}
            action={mayEdit && editor.kind === 'closed' ? newButton : undefined}
          />
        }
      >
        <Card
          title={t('web.support_title')}
          hint={t('web.support_faq_hint')}
          actions={mayEdit && editor.kind === 'closed' ? newButton : undefined}
        >
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            caption={t('web.support_title')}
          />
        </Card>
      </StateSwitch>

      {mayEdit && editor.kind !== 'closed' && (
        <Card
          title={t(
            editor.kind === 'create' ? 'web.support_faq_creating' : 'web.support_faq_editing',
          )}
          hint={t('web.support_faq_form_hint')}
        >
          <form onSubmit={submit}>
            <Field label={t('web.support_faq_question')} htmlFor="faq-question">
              <input
                id="faq-question"
                value={form.question}
                maxLength={SUPPORT_FAQ_QUESTION_MAX_LENGTH}
                onChange={(event) => setForm({ ...form, question: event.target.value })}
              />
            </Field>
            <Field label={t('web.support_faq_answer')} htmlFor="faq-answer">
              <textarea
                id="faq-answer"
                rows={4}
                value={form.answer}
                maxLength={SUPPORT_FAQ_ANSWER_MAX_LENGTH}
                onChange={(event) => setForm({ ...form, answer: event.target.value })}
              />
            </Field>
            <Field
              label={t('web.support_faq_order')}
              htmlFor="faq-sort"
              hint={t('web.support_faq_sort_hint')}
              {...(sortOrder === null ? { error: t('web.support_faq_sort_invalid') } : {})}
            >
              <input
                id="faq-sort"
                value={form.sortOrder}
                inputMode="numeric"
                onChange={(event) => setForm({ ...form, sortOrder: event.target.value })}
              />
            </Field>

            {changedElsewhere && (
              <Banner tone="warn">
                {t('web.changed_elsewhere')}{' '}
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => {
                    save.reset();
                    if (current !== undefined) openEdit(current);
                  }}
                >
                  {t('web.reload_value')}
                </button>
              </Banner>
            )}

            <div className="toolbar">
              <button
                type="submit"
                className="btn primary sm"
                disabled={busy || formInvalid}
                {...(textMissing ? { title: t('web.support_faq_text_required') } : {})}
              >
                {t('web.support_faq_save')}
              </button>
              <button type="button" className="btn sm" disabled={busy} onClick={close}>
                {t('web.support_faq_cancel')}
              </button>
            </div>

            {save.error != null && <Banner tone="danger">{faultOf(save.error)}</Banner>}
          </form>
        </Card>
      )}

      {toggle.error != null && <Banner tone="danger">{faultOf(toggle.error)}</Banner>}
    </>
  );
}
