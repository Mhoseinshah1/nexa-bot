import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  APPEARANCE_MARKER_EXPRESSION_SOURCE,
  APPEARANCE_SLOT_FALLBACKS,
  TERMS_BODY_MAX_LENGTH,
  TERMS_TITLE_MAX_LENGTH,
  isAppearanceSlot,
  type TermsVersionResponse,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import {
  ApiError,
  createTermsDraft,
  fetchTerms,
  publishTermsDraft,
  saveFeatureFlag,
  updateTermsDraft,
} from '../api/client';
import { formatTimestamp } from '../format';
import { useSubmissionKey } from '../submission-key';
import { queryState } from '../view-state';
import { t, type WebKey } from '../i18n/web.fa';
import { messageFor } from './settings';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { Drawer, Modal } from '../ui/overlays';
import {
  Badge,
  Banner,
  Card,
  CellMain,
  DataTable,
  Empty,
  Field,
  Num,
  PageHead,
  RowActions,
  Stat,
  StateSwitch,
  ToggleRow,
  useConfirmedClose,
  useToast,
  useUnsavedChanges,
  type Column,
} from '../ui/kit';
import { Icon } from '../ui/icons';

/**
 * The terms and rules (program §6).
 *
 * **One draft, many published versions.** The draft is the only thing edited; every edit
 * states the revision it was opened from, and PUBLISH sends the revision the operator
 * PREVIEWED, so an edit a colleague saved in between is refused rather than published
 * unseen. A published version is read-only here and immutable in the database.
 *
 * **Publishing marks nobody.** The confirmation says so: while enforcement is on, every
 * customer is asked to accept the new version, including those who accepted the old one.
 *
 * **Enforcement is the `terms_enforcement` feature flag**, toggled here through the same
 * `/features` write the features page uses (`features.edit`), and only drawn for an actor
 * who holds it. Turning it ON asks first, because it stops every customer who has not
 * accepted at once.
 *
 * Permissions are passed, never derived: the page reads under `terms.view`; the draft is
 * `terms.edit` and publication `terms.publish`, each charged by the server on its own.
 */

const ERRORS: Readonly<Record<string, WebKey>> = {
  'terms.draft_conflict': 'web.terms_error_conflict',
  'terms.draft_exists': 'web.terms_error_draft_exists',
  'terms.version_published': 'web.terms_error_published',
  'terms.version_not_found': 'web.terms_error_not_found',
};

function faultOf(error: unknown): string {
  if (error instanceof ApiError) {
    const known = ERRORS[error.code];
    if (known !== undefined) return t(known);
  }
  return messageFor(error);
}

const MARKER = new RegExp(APPEARANCE_MARKER_EXPRESSION_SOURCE, 'g');

/**
 * The message a customer is shown, in the default wording with every icon marker as its
 * fallback emoji — what `bot.terms.required` renders with nothing overridden. A tenant
 * that rewords the template sees its own wording in the bot; the page says so.
 */
export function termsPreviewText(title: string, body: string): string {
  return CATALOGUE_FA['bot.terms.required']
    .replace(MARKER, (match, slot: string) =>
      isAppearanceSlot(slot) ? APPEARANCE_SLOT_FALLBACKS[slot] : match,
    )
    .replace('{title}', title)
    .replace('{body}', body);
}

interface FormState {
  readonly title: string;
  readonly body: string;
}
const EMPTY: FormState = { title: '', body: '' };

/** Closed, a new draft (seeded from the current version), or the draft at a revision. */
type Editor =
  | { readonly kind: 'closed' }
  | { readonly kind: 'create' }
  | { readonly kind: 'edit'; readonly basis: TermsVersionResponse };

export function TermsPage({
  denied,
  mayEdit,
  mayPublish,
  mayToggle,
}: {
  denied: boolean;
  mayEdit: boolean;
  mayPublish: boolean;
  /** `features.edit`: the enforcement switch. */
  mayToggle: boolean;
}) {
  const queries = useQueryClient();
  const notify = useToast();
  const saving = useSubmissionKey();
  const publishing = useSubmissionKey();
  const toggling = useSubmissionKey();

  const terms = useQuery({ queryKey: ['terms'], queryFn: () => fetchTerms(), enabled: !denied });
  const data = terms.data;

  const [editor, setEditor] = useState<Editor>({ kind: 'closed' });
  const [form, setForm] = useState<FormState>(EMPTY);
  /** The draft revision the operator is looking at in the preview, and may publish. */
  const [preview, setPreview] = useState<TermsVersionResponse | null>(null);
  const [confirmPublish, setConfirmPublish] = useState<TermsVersionResponse | null>(null);
  const [confirmEnforce, setConfirmEnforce] = useState(false);
  const [viewing, setViewing] = useState<TermsVersionResponse | null>(null);

  const refresh = () => {
    void queries.invalidateQueries({ queryKey: ['terms'] });
  };
  const close = () => {
    setEditor({ kind: 'closed' });
    setForm(EMPTY);
  };

  const save = useMutation({
    mutationFn: (command: {
      idempotencyKey: string;
      title: string;
      body: string;
      basis: TermsVersionResponse | null;
    }) =>
      command.basis === null
        ? createTermsDraft({
            idempotencyKey: command.idempotencyKey,
            title: command.title,
            body: command.body,
          })
        : updateTermsDraft({
            id: command.basis.id,
            idempotencyKey: command.idempotencyKey,
            title: command.title,
            body: command.body,
            expectedRevision: command.basis.revision,
          }),
    onSuccess: () => {
      saving.settle();
      notify({ tone: 'ok', message: t('web.terms_saved') });
      close();
      refresh();
    },
    onError: (error) => {
      saving.settleOn(error);
      refresh();
    },
  });

  const publish = useMutation({
    mutationFn: (command: { idempotencyKey: string; id: string; expectedRevision: number }) =>
      publishTermsDraft(command),
    onSuccess: () => {
      publishing.settle();
      notify({ tone: 'ok', message: t('web.terms_published') });
      setPreview(null);
      refresh();
    },
    onError: (error) => {
      publishing.settleOn(error);
      refresh();
    },
  });

  const toggle = useMutation({
    mutationFn: (command: {
      idempotencyKey: string;
      enabled: boolean;
      expectedVersion: number | null;
    }) => saveFeatureFlag({ key: 'terms_enforcement', ...command }),
    onSuccess: () => {
      toggling.settle();
      notify({ tone: 'ok', message: t('web.terms_enforcement_saved') });
      refresh();
    },
    onError: (error) => {
      toggling.settleOn(error);
      refresh();
    },
  });

  const busy = save.isPending || publish.isPending || toggle.isPending;

  const setEnforcement = (enabled: boolean) => {
    if (data === undefined) return;
    const command = { enabled, expectedVersion: data.enforcement.version };
    toggle.mutate({ ...command, idempotencyKey: toggling.current(command) });
  };

  const openCreate = () => {
    setEditor({ kind: 'create' });
    // A new draft starts from the current text: most revisions change a clause, not all.
    setForm(
      data?.current === null || data?.current === undefined
        ? EMPTY
        : { title: data.current.title, body: data.current.body },
    );
  };
  const openEdit = (row: TermsVersionResponse) => {
    setEditor({ kind: 'edit', basis: row });
    setForm({ title: row.title, body: row.body });
  };

  const textMissing = form.title.trim() === '' || form.body.trim() === '';
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (textMissing) return;
    const command = {
      title: form.title.trim(),
      body: form.body.trim(),
      basis: editor.kind === 'edit' ? editor.basis : null,
    };
    save.mutate({ ...command, idempotencyKey: saving.current(command) });
  };

  const opened =
    editor.kind === 'edit'
      ? { title: editor.basis.title, body: editor.basis.body }
      : editor.kind === 'create'
        ? (data?.current ?? EMPTY)
        : EMPTY;
  const formDirty =
    editor.kind !== 'closed' && (form.title !== opened.title || form.body !== opened.body);
  useUnsavedChanges(mayEdit && formDirty);
  const { requestClose, dialog: discardQuestion } = useConfirmedClose(mayEdit && formDirty, close);

  const draft = data?.draft ?? null;
  const current = data?.current ?? null;
  // The draft moved under an open editor: a colleague saved, or it was published.
  const changedElsewhere =
    editor.kind === 'edit' &&
    !save.isPending &&
    (draft?.id !== editor.basis.id || draft.revision !== editor.basis.revision);

  const historyColumns: readonly Column<TermsVersionResponse>[] = [
    {
      key: 'number',
      header: t('web.terms_version'),
      align: 'end',
      render: (row) => <Num value={row.versionNumber ?? 0} />,
    },
    {
      key: 'title',
      header: t('web.terms_title_field'),
      wrap: true,
      render: (row) => (
        <CellMain
          primary={<span className="strong">{row.title}</span>}
          secondary={
            row.current ? (
              <Badge tone="ok" dot>
                {t('web.terms_current_badge')}
              </Badge>
            ) : undefined
          }
        />
      ),
    },
    {
      key: 'published',
      header: t('web.terms_published_at'),
      render: (row) => (
        <CellMain
          primary={
            <span className="nowrap">
              {row.publishedAt === null ? '—' : formatTimestamp(row.publishedAt)}
            </span>
          }
          secondary={<span className="muted">{row.publishedBy ?? '—'}</span>}
        />
      ),
    },
    {
      key: 'accepted',
      header: t('web.terms_acceptances'),
      align: 'end',
      render: (row) => <Num value={row.acceptanceCount} />,
    },
    {
      key: 'actions',
      header: t('web.terms_actions'),
      align: 'end',
      render: (row) => (
        <RowActions>
          <button type="button" className="btn ghost sm" onClick={() => setViewing(row)}>
            {t('web.terms_view')}
          </button>
        </RowActions>
      ),
    },
  ];

  return (
    <>
      <PageHead title={t('web.terms_page_title')} subtitle={t('web.terms_page_subtitle')} />

      <StateSwitch query={terms} denied={denied} isEmpty={false} empty={null}>
        {data !== undefined && (
          <div className="stack">
            <Card title={t('web.terms_enforcement_title')}>
              <ToggleRow
                title={t('web.terms_enforcement_label')}
                description={t('web.terms_enforcement_hint')}
                checked={data.enforcement.enabled}
                disabled={!mayToggle || busy}
                onChange={(next) => (next ? setConfirmEnforce(true) : setEnforcement(false))}
              />
              {!mayToggle && (
                <p className="muted small">{t('web.terms_enforcement_no_permission')}</p>
              )}
              {data.enforcement.enabled && current === null && (
                <Banner tone="warn">{t('web.terms_enforcement_nothing_published')}</Banner>
              )}
              {toggle.error != null && <Banner tone="danger">{faultOf(toggle.error)}</Banner>}
            </Card>

            <div className="stat-grid">
              <Stat
                label={t('web.terms_stat_current')}
                value={current === null ? '—' : <Num value={current.versionNumber ?? 0} />}
              />
              <Stat
                label={t('web.terms_stat_customers')}
                value={<Num value={data.statistics.customers} />}
              />
              <Stat
                label={t('web.terms_stat_accepted')}
                value={<Num value={data.statistics.acceptedCurrent} />}
                tone="ok"
              />
              <Stat
                label={t('web.terms_stat_pending')}
                value={<Num value={data.statistics.pendingCurrent} />}
                {...(data.enforcement.enabled && data.statistics.pendingCurrent > 0
                  ? { tone: 'warn' as const }
                  : {})}
              />
            </div>

            <Card
              title={t('web.terms_current_title')}
              {...(current === null ? {} : { hint: t('web.terms_current_hint') })}
            >
              {current === null ? (
                <Empty
                  title={t('web.terms_none_published')}
                  hint={t('web.terms_none_published_hint')}
                />
              ) : (
                <article className="terms-version">
                  <p className="muted small">
                    {t('web.terms_version')} <Num value={current.versionNumber ?? 0} /> ·{' '}
                    {current.publishedAt === null ? '' : formatTimestamp(current.publishedAt)} ·{' '}
                    {current.publishedBy ?? '—'}
                  </p>
                  <h3>{current.title}</h3>
                  <p className="terms-body">{current.body}</p>
                </article>
              )}
            </Card>

            <Card
              title={t('web.terms_draft_title')}
              hint={t('web.terms_draft_hint')}
              actions={
                mayEdit && draft === null ? (
                  <button
                    type="button"
                    className="btn primary sm"
                    disabled={busy}
                    onClick={openCreate}
                  >
                    <Icon name="plus" />
                    {t('web.terms_new_draft')}
                  </button>
                ) : undefined
              }
            >
              {draft === null ? (
                <p className="muted">{t('web.terms_no_draft')}</p>
              ) : (
                <div className="stack">
                  <p className="muted small">
                    {t('web.terms_revision')} <Num value={draft.revision} /> ·{' '}
                    {formatTimestamp(draft.updatedAt)} · {draft.createdBy ?? '—'}
                  </p>
                  <h3>{draft.title}</h3>
                  <p className="terms-body">{draft.body}</p>
                  <div className="form-actions">
                    {mayEdit && (
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={() => openEdit(draft)}
                      >
                        <Icon name="edit" />
                        {t('web.terms_edit_draft')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() => setPreview(draft)}
                    >
                      <Icon name="eye" />
                      {t('web.terms_preview')}
                    </button>
                  </div>
                </div>
              )}
              {publish.error != null && <Banner tone="danger">{faultOf(publish.error)}</Banner>}
            </Card>

            <Card title={t('web.terms_history_title')} hint={t('web.terms_history_hint')}>
              {queryState(terms) === 'ready' && data.history.length === 0 ? (
                <p className="muted">{t('web.terms_history_empty')}</p>
              ) : (
                <DataTable
                  columns={historyColumns}
                  rows={data.history}
                  rowKey={(row) => row.id}
                  caption={t('web.terms_history_title')}
                  dense
                />
              )}
            </Card>
          </div>
        )}
      </StateSwitch>

      <Drawer
        open={mayEdit && editor.kind !== 'closed'}
        onClose={requestClose}
        title={t(editor.kind === 'create' ? 'web.terms_creating' : 'web.terms_editing')}
      >
        <p className="muted small">{t('web.terms_form_hint')}</p>
        <form onSubmit={submit} className="stack">
          <Field label={t('web.terms_title_field')} htmlFor="terms-title">
            <input
              id="terms-title"
              className="input"
              value={form.title}
              maxLength={TERMS_TITLE_MAX_LENGTH}
              onChange={(event) => setForm({ ...form, title: event.target.value })}
            />
          </Field>
          <Field
            label={t('web.terms_body_field')}
            htmlFor="terms-body"
            hint={`${String(form.body.length)} / ${String(TERMS_BODY_MAX_LENGTH)}`}
          >
            <textarea
              id="terms-body"
              className="input"
              rows={12}
              value={form.body}
              maxLength={TERMS_BODY_MAX_LENGTH}
              onChange={(event) => setForm({ ...form, body: event.target.value })}
            />
          </Field>
          {changedElsewhere && (
            <Banner tone="warn">
              {t('web.changed_elsewhere')}{' '}
              {draft !== null && (
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => {
                    save.reset();
                    openEdit(draft);
                  }}
                >
                  {t('web.reload_value')}
                </button>
              )}
            </Banner>
          )}
          {save.error != null && <Banner tone="danger">{faultOf(save.error)}</Banner>}
          <div className="form-actions">
            <button type="submit" className="btn primary" disabled={busy || textMissing}>
              {t('web.terms_save')}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={requestClose}>
              {t('web.terms_cancel')}
            </button>
          </div>
        </form>
      </Drawer>
      {discardQuestion}

      <Modal
        open={preview !== null}
        onClose={() => setPreview(null)}
        title={t('web.terms_preview_title')}
        size="lg"
        foot={
          <div className="form-actions">
            {mayPublish && preview !== null && (
              <button
                type="button"
                className="btn danger"
                disabled={busy}
                onClick={() => setConfirmPublish(preview)}
              >
                {t('web.terms_publish')}
              </button>
            )}
            <button type="button" className="btn" onClick={() => setPreview(null)}>
              {t('web.terms_close')}
            </button>
          </div>
        }
      >
        {preview !== null && (
          <div className="stack">
            <p className="muted small">{t('web.terms_preview_hint')}</p>
            <div className="tg-preview" dir="rtl">
              <p className="terms-body">{termsPreviewText(preview.title, preview.body)}</p>
              <span className="tg-preview-button">{CATALOGUE_FA['bot.terms.accept_button']}</span>
            </div>
            {!mayPublish && <p className="muted small">{t('web.terms_publish_no_permission')}</p>}
          </div>
        )}
      </Modal>

      <Modal
        open={viewing !== null}
        onClose={() => setViewing(null)}
        title={viewing === null ? '' : viewing.title}
        size="lg"
      >
        {viewing !== null && (
          <article className="terms-version">
            <p className="muted small">
              {t('web.terms_version')} <Num value={viewing.versionNumber ?? 0} /> ·{' '}
              {viewing.publishedAt === null ? '' : formatTimestamp(viewing.publishedAt)} ·{' '}
              {viewing.publishedBy ?? '—'} · {t('web.terms_acceptances')}{' '}
              <Num value={viewing.acceptanceCount} />
            </p>
            <p className="terms-body">{viewing.body}</p>
            <p className="muted small">{t('web.terms_read_only')}</p>
          </article>
        )}
      </Modal>

      {confirmPublish !== null && (
        <ConfirmDialog
          title={t('web.terms_publish_confirm_title')}
          question={t('web.terms_publish_confirm_question')}
          detail={t('web.terms_publish_confirm_detail')}
          confirmLabel={t('web.terms_publish')}
          cancelLabel={t('web.terms_cancel')}
          onCancel={() => setConfirmPublish(null)}
          onConfirm={() => {
            const command = { id: confirmPublish.id, expectedRevision: confirmPublish.revision };
            setConfirmPublish(null);
            publish.mutate({ ...command, idempotencyKey: publishing.current(command) });
          }}
        />
      )}
      {confirmEnforce && (
        <ConfirmDialog
          title={t('web.terms_enforcement_label')}
          question={t('web.terms_enforce_confirm_question')}
          detail={t('web.terms_enforce_confirm_detail')}
          confirmLabel={t('web.terms_enforce_confirm')}
          cancelLabel={t('web.terms_cancel')}
          onCancel={() => setConfirmEnforce(false)}
          onConfirm={() => {
            setConfirmEnforce(false);
            setEnforcement(true);
          }}
        />
      )}
    </>
  );
}
