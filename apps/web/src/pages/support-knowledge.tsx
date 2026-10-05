import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  SUPPORT_KNOWLEDGE_ARTICLE_STATES,
  SUPPORT_KNOWLEDGE_CATEGORIES,
  SUPPORT_KNOWLEDGE_LIMITS,
  SUPPORT_KNOWLEDGE_SOURCES,
  SUPPORT_LEARNING_CANDIDATE_STATES,
  type SupportKnowledgeArticleState,
  type SupportKnowledgeArticleView,
  type SupportKnowledgeCategory,
  type SupportKnowledgeContent,
  type SupportKnowledgeSource,
  type SupportLearningCandidateState,
  type SupportLearningCandidateView,
  type SupportLearningSensitiveKind,
} from '@nexa/contracts';
import {
  ApiError,
  approveLearningCandidate,
  controlSupportKnowledge,
  createSupportKnowledge,
  fetchLearningCandidates,
  fetchSupportKnowledge,
  fetchSupportKnowledgeRevisions,
  newIdempotencyKey,
  proposeAsKnowledge,
  rejectLearningCandidate,
  setSupportKnowledgeEnabled,
  updateSupportKnowledge,
} from '../api/client';
import { formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { useSubmissionKey } from '../submission-key';
import { queryState } from '../view-state';
import { messageFor } from './settings';
import {
  Badge,
  Banner,
  Card,
  CellMain,
  DataTable,
  Drawer,
  Empty,
  Field,
  FilterBar,
  PageHead,
  Pills,
  RowActions,
  Select,
  StateSwitch,
  useToast,
  type Column,
  type Tone,
} from '../ui/kit';
import { Icon } from '../ui/icons';

/**
 * TB8 — support knowledge (ADR-0035): the one home of what the support agent may answer from,
 * and the queue of lessons it proposed from human replies.
 *
 * Nothing on these pages is knowledge until a reviewer says so. A candidate is shown as a
 * PROPOSAL; «تأیید» and «ویرایش و تأیید» publish an article, «رد» never does. An approved
 * article's edit is a new revision, and the page says which revision is live. Every write names
 * the version it was opened from and carries a submission-scoped key. Buttons are a courtesy:
 * the server charges `support_knowledge.review` for every write.
 */

export const KNOWLEDGE_SOURCE_LABELS: Readonly<Record<SupportKnowledgeSource, WebKey>> = {
  MANUAL: 'web.sk_source_manual',
  LEARNED: 'web.sk_source_learned',
  NEXA_BUILD: 'web.sk_source_nexa_build',
};

export const KNOWLEDGE_STATE_LABELS: Readonly<Record<SupportKnowledgeArticleState, WebKey>> = {
  DRAFT: 'web.sk_state_draft',
  APPROVED: 'web.sk_state_approved',
  RETIRED: 'web.sk_state_retired',
};

const STATE_TONES: Readonly<Record<SupportKnowledgeArticleState, Tone>> = {
  DRAFT: 'warn',
  APPROVED: 'ok',
  RETIRED: 'neutral',
};

export const KNOWLEDGE_CATEGORY_LABELS: Readonly<Record<SupportKnowledgeCategory, WebKey>> = {
  CONNECTION: 'web.sk_cat_connection',
  APPS: 'web.sk_cat_apps',
  PLANS: 'web.sk_cat_plans',
  PAYMENTS: 'web.sk_cat_payments',
  ACCOUNT: 'web.sk_cat_account',
  POLICY: 'web.sk_cat_policy',
  GENERAL: 'web.sk_cat_general',
};

export const CANDIDATE_STATE_LABELS: Readonly<Record<SupportLearningCandidateState, WebKey>> = {
  PENDING: 'web.sk_cand_pending',
  APPROVED: 'web.sk_cand_approved',
  REJECTED: 'web.sk_cand_rejected',
};

const CANDIDATE_TONES: Readonly<Record<SupportLearningCandidateState, Tone>> = {
  PENDING: 'warn',
  APPROVED: 'ok',
  REJECTED: 'neutral',
};

const SENSITIVE_LABELS: Readonly<Record<SupportLearningSensitiveKind, WebKey>> = {
  EMAIL: 'web.sk_kind_email',
  PHONE: 'web.sk_kind_phone',
  CARD: 'web.sk_kind_card',
  IBAN: 'web.sk_kind_iban',
  SUBSCRIPTION_LINK: 'web.sk_kind_subscription_link',
  URL_TOKEN: 'web.sk_kind_url_token',
  IP_ADDRESS: 'web.sk_kind_ip',
  HOST: 'web.sk_kind_host',
  UUID: 'web.sk_kind_uuid',
  SECRET: 'web.sk_kind_secret',
  USERNAME: 'web.sk_kind_username',
  AMOUNT: 'web.sk_kind_amount',
  LONG_NUMBER: 'web.sk_kind_long_number',
  REDACTION_MARK: 'web.sk_kind_redaction',
};

const FAULTS: Readonly<Record<string, WebKey>> = {
  'support_knowledge.version_conflict': 'web.sk_fault_conflict',
  'support_knowledge.not_in_state': 'web.sk_fault_state',
  'support_knowledge.sensitive_content': 'web.sk_fault_sensitive',
  'support_knowledge.limit': 'web.sk_fault_limit',
  'support_knowledge.not_found': 'web.sk_fault_not_found',
  'support_knowledge.candidate_not_found': 'web.sk_fault_not_found',
  'support_knowledge.scope_stopped': 'web.sk_fault_stopped',
};

export function knowledgeFault(error: unknown): string {
  if (error instanceof ApiError) {
    const key = FAULTS[error.code];
    if (key !== undefined) return t(key);
  }
  return messageFor(error);
}

interface ContentForm {
  title: string;
  body: string;
  category: SupportKnowledgeCategory;
  tags: string;
}

const EMPTY_CONTENT: ContentForm = { title: '', body: '', category: 'GENERAL', tags: '' };

function formOf(content: {
  title: string | null;
  body: string | null;
  category: SupportKnowledgeCategory;
  tags: readonly string[];
}): ContentForm {
  return {
    title: content.title ?? '',
    body: content.body ?? '',
    category: content.category,
    tags: content.tags.join(PERSIAN_COMMA_SPACE),
  };
}

/** The form as the content the server takes, or null while it is not one. */
export function contentOf(form: ContentForm): SupportKnowledgeContent | null {
  const title = form.title.trim();
  const body = form.body.trim();
  const tags = form.tags
    .split(/[,\u060C]/u)
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
  if (title === '' || body === '') return null;
  if (title.length > SUPPORT_KNOWLEDGE_LIMITS.titleChars) return null;
  if (body.length > SUPPORT_KNOWLEDGE_LIMITS.bodyChars) return null;
  if (tags.length > SUPPORT_KNOWLEDGE_LIMITS.tags) return null;
  if (tags.some((tag) => tag.length > SUPPORT_KNOWLEDGE_LIMITS.tagChars)) return null;
  return { title, body, category: form.category, tags };
}

function ContentFields({
  idPrefix,
  form,
  onChange,
}: {
  idPrefix: string;
  form: ContentForm;
  onChange: (next: ContentForm) => void;
}) {
  return (
    <>
      <Field label={t('web.sk_field_title')} htmlFor={`${idPrefix}-title`}>
        <input
          id={`${idPrefix}-title`}
          className="input"
          value={form.title}
          maxLength={SUPPORT_KNOWLEDGE_LIMITS.titleChars}
          onChange={(event) => onChange({ ...form, title: event.target.value })}
        />
      </Field>
      <Field label={t('web.sk_field_body')} htmlFor={`${idPrefix}-body`}>
        <textarea
          dir="auto"
          id={`${idPrefix}-body`}
          className="input"
          rows={7}
          value={form.body}
          maxLength={SUPPORT_KNOWLEDGE_LIMITS.bodyChars}
          onChange={(event) => onChange({ ...form, body: event.target.value })}
        />
      </Field>
      <Field label={t('web.sk_field_category')} htmlFor={`${idPrefix}-category`}>
        <Select
          id={`${idPrefix}-category`}
          value={form.category}
          onChange={(event) =>
            onChange({ ...form, category: event.target.value as SupportKnowledgeCategory })
          }
        >
          {SUPPORT_KNOWLEDGE_CATEGORIES.map((category) => (
            <option key={category} value={category}>
              {t(KNOWLEDGE_CATEGORY_LABELS[category])}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label={t('web.sk_field_tags')}
        htmlFor={`${idPrefix}-tags`}
        hint={t('web.sk_field_tags_hint')}
      >
        <input
          id={`${idPrefix}-tags`}
          className="input"
          value={form.tags}
          onChange={(event) => onChange({ ...form, tags: event.target.value })}
        />
      </Field>
    </>
  );
}

type Editor =
  | { readonly kind: 'closed' }
  | { readonly kind: 'create' }
  | { readonly kind: 'edit'; readonly basis: SupportKnowledgeArticleView };

type AnyFilter<T extends string> = T | 'ALL';

/** The Arabic comma and a space: how a Persian list is joined. Escaped, not typed. */
const PERSIAN_COMMA_SPACE = '\u060C ';

// ---------------------------------------------------------------------------
// The knowledge page
// ---------------------------------------------------------------------------

export function SupportKnowledgePage({
  denied,
  mayReview,
}: {
  denied: boolean;
  mayReview: boolean;
}) {
  const queries = useQueryClient();
  const notify = useToast();
  const submission = useSubmissionKey();
  const [source, setSource] = useState<AnyFilter<SupportKnowledgeSource>>('ALL');
  const [state, setState] = useState<AnyFilter<SupportKnowledgeArticleState>>('ALL');
  const filter = {
    ...(source === 'ALL' ? {} : { source }),
    ...(state === 'ALL' ? {} : { state }),
  };
  const articles = useQuery({
    queryKey: ['support-knowledge', filter],
    queryFn: () => fetchSupportKnowledge(filter),
    enabled: !denied,
  });
  const rows = articles.data ?? [];
  const [editor, setEditor] = useState<Editor>({ kind: 'closed' });
  const [form, setForm] = useState<ContentForm>(EMPTY_CONTENT);
  const [publishNow, setPublishNow] = useState(true);
  const [history, setHistory] = useState<SupportKnowledgeArticleView | null>(null);

  const refresh = () => void queries.invalidateQueries({ queryKey: ['support-knowledge'] });
  const close = () => {
    setEditor({ kind: 'closed' });
    setForm(EMPTY_CONTENT);
  };

  const save = useMutation({
    mutationFn: (command: {
      idempotencyKey: string;
      content: SupportKnowledgeContent;
      basis: SupportKnowledgeArticleView | null;
      publish: boolean;
    }) =>
      command.basis === null
        ? createSupportKnowledge({
            idempotencyKey: command.idempotencyKey,
            content: command.content,
            publish: command.publish,
          })
        : updateSupportKnowledge({
            id: command.basis.id,
            idempotencyKey: command.idempotencyKey,
            expectedVersion: command.basis.version,
            content: command.content,
          }),
    onSuccess: () => {
      submission.settle();
      notify({ tone: 'ok', message: t('web.sk_saved') });
      close();
      refresh();
    },
    onError: (error) => {
      submission.settleOn(error);
      refresh();
    },
  });

  const control = useMutation({
    mutationFn: (input: {
      id: string;
      action: 'publish' | 'retire' | 'enable' | 'disable';
      expectedVersion: number;
    }) => {
      const idempotencyKey = submission.current({ control: input });
      return input.action === 'enable' || input.action === 'disable'
        ? setSupportKnowledgeEnabled({
            id: input.id,
            idempotencyKey,
            expectedVersion: input.expectedVersion,
            enabled: input.action === 'enable',
          })
        : controlSupportKnowledge({
            id: input.id,
            action: input.action,
            idempotencyKey,
            expectedVersion: input.expectedVersion,
          });
    },
    onSuccess: () => {
      submission.settle();
      notify({ tone: 'ok', message: t('web.sk_saved') });
      refresh();
    },
    onError: (error) => {
      submission.settleOn(error);
      refresh();
    },
  });

  const busy = save.isPending || control.isPending;
  const content = contentOf(form);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (content === null) return;
    const command = {
      content,
      basis: editor.kind === 'edit' ? editor.basis : null,
      publish: publishNow,
    };
    save.mutate({ ...command, idempotencyKey: submission.current(command) });
  };

  const columns: readonly Column<SupportKnowledgeArticleView>[] = [
    {
      key: 'title',
      header: t('web.sk_field_title'),
      wrap: true,
      render: (row) => (
        <CellMain
          primary={<span className="strong">{row.title}</span>}
          secondary={<span className="support-answer">{row.body}</span>}
        />
      ),
    },
    {
      key: 'source',
      header: t('web.sk_col_source'),
      render: (row) => <Badge tone="info">{t(KNOWLEDGE_SOURCE_LABELS[row.source])}</Badge>,
    },
    {
      key: 'state',
      header: t('web.sk_col_state'),
      render: (row) => (
        <span data-lifecycle={row.state}>
          <Badge tone={STATE_TONES[row.state]} dot>
            {t(KNOWLEDGE_STATE_LABELS[row.state])}
          </Badge>{' '}
          {!row.enabled && <Badge tone="neutral">{t('web.sk_disabled')}</Badge>}
        </span>
      ),
    },
    {
      key: 'category',
      header: t('web.sk_field_category'),
      render: (row) => t(KNOWLEDGE_CATEGORY_LABELS[row.category]),
    },
    {
      key: 'revision',
      header: t('web.sk_col_revision'),
      align: 'end',
      render: (row) => (row.revision === 0 ? '—' : String(row.revision)),
    },
    {
      key: 'updated',
      header: t('web.sk_col_updated'),
      render: (row) => <span className="nowrap muted">{formatTimestamp(row.updatedAt)}</span>,
    },
    {
      key: 'actions',
      header: t('web.sk_col_actions'),
      align: 'end',
      render: (row) => (
        <RowActions>
          <button type="button" className="btn ghost sm" onClick={() => setHistory(row)}>
            {t('web.sk_revisions')}
          </button>
          {mayReview && row.state !== 'RETIRED' && (
            <button
              type="button"
              className="btn ghost sm"
              disabled={busy}
              onClick={() => {
                setEditor({ kind: 'edit', basis: row });
                setForm(formOf(row));
              }}
            >
              {t('web.sk_edit')}
            </button>
          )}
          {mayReview && row.state === 'DRAFT' && (
            <button
              type="button"
              className="btn ghost sm"
              disabled={busy}
              onClick={() =>
                control.mutate({ id: row.id, action: 'publish', expectedVersion: row.version })
              }
            >
              {t('web.sk_publish')}
            </button>
          )}
          {mayReview && row.state === 'APPROVED' && (
            <button
              type="button"
              className="btn ghost sm"
              disabled={busy}
              onClick={() =>
                control.mutate({
                  id: row.id,
                  action: row.enabled ? 'disable' : 'enable',
                  expectedVersion: row.version,
                })
              }
            >
              {t(row.enabled ? 'web.sk_disable' : 'web.sk_enable')}
            </button>
          )}
          {mayReview && row.state !== 'RETIRED' && (
            <button
              type="button"
              className="btn ghost sm"
              disabled={busy}
              onClick={() =>
                control.mutate({ id: row.id, action: 'retire', expectedVersion: row.version })
              }
            >
              {t('web.sk_retire')}
            </button>
          )}
        </RowActions>
      ),
    },
  ];

  const newButton = (
    <button
      type="button"
      className="btn primary sm"
      disabled={busy}
      onClick={() => {
        setEditor({ kind: 'create' });
        setForm(EMPTY_CONTENT);
        setPublishNow(true);
      }}
    >
      <Icon name="plus" />
      {t('web.sk_new')}
    </button>
  );

  return (
    <>
      <PageHead
        title={t('web.sk_title')}
        subtitle={t('web.sk_subtitle')}
        actions={mayReview ? newButton : undefined}
      />
      <Banner tone="info" icon="info">
        {t('web.sk_only_approved')}
      </Banner>
      <FilterBar>
        <Field label={t('web.sk_col_source')} htmlFor="sk-source" compact>
          <Select
            id="sk-source"
            size="sm"
            value={source}
            onChange={(event) => setSource(event.target.value as AnyFilter<SupportKnowledgeSource>)}
          >
            <option value="ALL">{t('web.sk_all')}</option>
            {SUPPORT_KNOWLEDGE_SOURCES.map((value) => (
              <option key={value} value={value}>
                {t(KNOWLEDGE_SOURCE_LABELS[value])}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('web.sk_col_state')} htmlFor="sk-state" compact>
          <Select
            id="sk-state"
            size="sm"
            value={state}
            onChange={(event) =>
              setState(event.target.value as AnyFilter<SupportKnowledgeArticleState>)
            }
          >
            <option value="ALL">{t('web.sk_all')}</option>
            {SUPPORT_KNOWLEDGE_ARTICLE_STATES.map((value) => (
              <option key={value} value={value}>
                {t(KNOWLEDGE_STATE_LABELS[value])}
              </option>
            ))}
          </Select>
        </Field>
      </FilterBar>
      {control.error != null && (
        <Banner tone="danger" role="alert">
          {knowledgeFault(control.error)}
        </Banner>
      )}
      <StateSwitch
        query={articles}
        denied={denied}
        isEmpty={queryState(articles) === 'ready' && rows.length === 0}
        empty={<Empty title={t('web.sk_empty')} hint={t('web.sk_empty_hint')} />}
      >
        <Card title={t('web.sk_title')}>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            caption={t('web.sk_title')}
            dense
          />
        </Card>
      </StateSwitch>

      <Drawer
        open={mayReview && editor.kind !== 'closed'}
        onClose={close}
        title={t(editor.kind === 'create' ? 'web.sk_creating' : 'web.sk_editing')}
      >
        {editor.kind === 'edit' && editor.basis.state === 'APPROVED' && (
          <Banner tone="warn">{t('web.sk_edit_new_revision')}</Banner>
        )}
        <form onSubmit={submit} className="stack">
          <ContentFields idPrefix="sk" form={form} onChange={setForm} />
          {editor.kind === 'create' && (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={publishNow}
                onChange={(event) => setPublishNow(event.target.checked)}
              />
              {t('web.sk_publish_now')}
            </label>
          )}
          {save.error != null && (
            <Banner tone="danger" role="alert">
              {knowledgeFault(save.error)}
            </Banner>
          )}
          <div className="form-actions">
            <button type="submit" className="btn primary" disabled={busy || content === null}>
              {t('web.sk_save')}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={close}>
              {t('web.sk_cancel')}
            </button>
          </div>
        </form>
      </Drawer>

      <Drawer
        open={history !== null}
        onClose={() => setHistory(null)}
        title={t('web.sk_revisions')}
      >
        {history !== null && <RevisionList article={history} />}
      </Drawer>
    </>
  );
}

function RevisionList({ article }: { article: SupportKnowledgeArticleView }) {
  const revisions = useQuery({
    queryKey: ['support-knowledge-revisions', article.id, article.version],
    queryFn: () => fetchSupportKnowledgeRevisions(article.id),
  });
  const rows = revisions.data ?? [];
  return (
    <StateSwitch
      query={revisions}
      isEmpty={queryState(revisions) === 'ready' && rows.length === 0}
      empty={<p className="muted small">{t('web.sk_no_revisions')}</p>}
    >
      <ol className="plain stack" aria-label={t('web.sk_revisions')}>
        {rows.map((row) => (
          <li key={row.revision} data-revision={row.revision}>
            <div className="row gap">
              <Badge tone={row.revision === article.revision ? 'ok' : 'neutral'}>
                {`${t('web.sk_col_revision')} ${String(row.revision)}`}
              </Badge>
              {row.revision === article.revision && (
                <span className="muted small">{t('web.sk_live_revision')}</span>
              )}
              <span className="muted small">{formatTimestamp(row.createdAt)}</span>
            </div>
            <p className="strong">{row.title}</p>
            <p className="support-answer">{row.body}</p>
          </li>
        ))}
      </ol>
    </StateSwitch>
  );
}

// ---------------------------------------------------------------------------
// The learning-candidate queue
// ---------------------------------------------------------------------------

export function LearningCandidatesPage({
  denied,
  mayReview,
}: {
  denied: boolean;
  mayReview: boolean;
}) {
  const queries = useQueryClient();
  const notify = useToast();
  const submission = useSubmissionKey();
  const [state, setState] = useState<SupportLearningCandidateState>('PENDING');
  const candidates = useQuery({
    queryKey: ['learning-candidates', state],
    queryFn: () => fetchLearningCandidates({ state }),
    enabled: !denied,
  });
  const rows = candidates.data ?? [];
  const [editing, setEditing] = useState<SupportLearningCandidateView | null>(null);
  const [form, setForm] = useState<ContentForm>(EMPTY_CONTENT);

  const refresh = () => {
    void queries.invalidateQueries({ queryKey: ['learning-candidates'] });
    void queries.invalidateQueries({ queryKey: ['support-knowledge'] });
  };

  const decide = useMutation({
    mutationFn: (command: {
      idempotencyKey: string;
      candidate: SupportLearningCandidateView;
      decision: 'approve' | 'reject';
      edit: SupportKnowledgeContent | null;
    }) =>
      command.decision === 'approve'
        ? approveLearningCandidate({
            id: command.candidate.id,
            idempotencyKey: command.idempotencyKey,
            expectedVersion: command.candidate.version,
            edit: command.edit,
          })
        : rejectLearningCandidate({
            id: command.candidate.id,
            idempotencyKey: command.idempotencyKey,
            expectedVersion: command.candidate.version,
          }),
    onSuccess: (_result, command) => {
      submission.settle();
      notify({
        tone: 'ok',
        message: t(command.decision === 'approve' ? 'web.sk_approved' : 'web.sk_rejected'),
      });
      setEditing(null);
      refresh();
    },
    onError: (error) => {
      submission.settleOn(error);
      refresh();
    },
  });

  const run = (
    candidate: SupportLearningCandidateView,
    decision: 'approve' | 'reject',
    edit: SupportKnowledgeContent | null,
  ) => {
    const command = { candidate, decision, edit };
    decide.mutate({
      ...command,
      idempotencyKey: submission.current({ id: candidate.id, decision, edit }),
    });
  };

  const editContent = contentOf(form);

  const columns: readonly Column<SupportLearningCandidateView>[] = [
    {
      key: 'proposal',
      header: t('web.sk_cand_proposal'),
      wrap: true,
      render: (row) => (
        <CellMain
          primary={<span className="strong">{row.title ?? t('web.sk_cand_title_purged')}</span>}
          secondary={<span className="support-answer">{row.body ?? t('web.sk_cand_purged')}</span>}
        />
      ),
    },
    {
      key: 'why',
      header: t('web.sk_cand_rationale'),
      wrap: true,
      render: (row) => (
        <span className="small">
          {row.rationale ?? '—'}
          {row.sensitiveKinds.length > 0 && (
            <span className="stack">
              <Badge tone="danger">{t('web.sk_cand_auto_rejected')}</Badge>
              <span className="muted">
                {row.sensitiveKinds
                  .map((kind) => t(SENSITIVE_LABELS[kind]))
                  .join(PERSIAN_COMMA_SPACE)}
              </span>
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'meta',
      header: t('web.sk_field_category'),
      render: (row) => (
        <span className="small">
          {t(KNOWLEDGE_CATEGORY_LABELS[row.category])}
          <br />
          <span className="muted">
            {`${t('web.sk_cand_confidence')}: ${t(CONFIDENCE_LABELS[row.confidence])} · ${t('web.sk_cand_sources')}: ${String(row.sourceCount)}`}
          </span>
        </span>
      ),
    },
    {
      key: 'state',
      header: t('web.sk_col_state'),
      render: (row) => (
        <Badge tone={CANDIDATE_TONES[row.state]} dot>
          {t(CANDIDATE_STATE_LABELS[row.state])}
        </Badge>
      ),
    },
    {
      key: 'actions',
      header: t('web.sk_col_actions'),
      align: 'end',
      render: (row) =>
        !mayReview || row.state !== 'PENDING' ? null : (
          <RowActions>
            <button
              type="button"
              className="btn primary sm"
              disabled={decide.isPending || row.body === null}
              onClick={() => run(row, 'approve', null)}
            >
              {t('web.sk_approve')}
            </button>
            <button
              type="button"
              className="btn ghost sm"
              disabled={decide.isPending}
              onClick={() => {
                setEditing(row);
                setForm(formOf(row));
              }}
            >
              {t('web.sk_edit_approve')}
            </button>
            <button
              type="button"
              className="btn ghost sm danger"
              disabled={decide.isPending}
              onClick={() => run(row, 'reject', null)}
            >
              {t('web.sk_reject')}
            </button>
          </RowActions>
        ),
    },
  ];

  return (
    <>
      <PageHead title={t('web.sk_cand_title')} subtitle={t('web.sk_cand_subtitle')} />
      <Banner tone="info" icon="info">
        {t('web.sk_cand_nothing_active')}
      </Banner>
      <Pills
        value={state}
        onChange={setState}
        items={SUPPORT_LEARNING_CANDIDATE_STATES.map((value) => ({
          id: value,
          label: t(CANDIDATE_STATE_LABELS[value]),
        }))}
      />
      {decide.error != null && editing === null && (
        <Banner tone="danger" role="alert">
          {knowledgeFault(decide.error)}
        </Banner>
      )}
      <StateSwitch
        query={candidates}
        denied={denied}
        isEmpty={queryState(candidates) === 'ready' && rows.length === 0}
        empty={<Empty title={t('web.sk_cand_empty')} hint={t('web.sk_cand_empty_hint')} />}
      >
        <Card title={t('web.sk_cand_title')}>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            caption={t('web.sk_cand_title')}
            dense
          />
        </Card>
      </StateSwitch>

      <Drawer
        open={mayReview && editing !== null}
        onClose={() => setEditing(null)}
        title={t('web.sk_edit_approve')}
      >
        <p className="muted small">{t('web.sk_edit_approve_hint')}</p>
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (editing !== null && editContent !== null) run(editing, 'approve', editContent);
          }}
        >
          <ContentFields idPrefix="cand" form={form} onChange={setForm} />
          {decide.error != null && (
            <Banner tone="danger" role="alert">
              {knowledgeFault(decide.error)}
            </Banner>
          )}
          <div className="form-actions">
            <button
              type="submit"
              className="btn primary"
              disabled={decide.isPending || editContent === null}
            >
              {t('web.sk_approve_edited')}
            </button>
            <button type="button" className="btn" onClick={() => setEditing(null)}>
              {t('web.sk_cancel')}
            </button>
          </div>
        </form>
      </Drawer>
    </>
  );
}

const CONFIDENCE_LABELS: Readonly<Record<'LOW' | 'MEDIUM' | 'HIGH', WebKey>> = {
  LOW: 'web.assist_confidence_low',
  MEDIUM: 'web.assist_confidence_medium',
  HIGH: 'web.assist_confidence_high',
};

const PROPOSE_FAULTS: Readonly<Record<string, WebKey>> = {
  'support_knowledge.ai_off': 'web.sk_propose_fault_off',
  'support_knowledge.learning_rate_limited': 'web.sk_propose_fault_rate',
  'support_knowledge.source_not_eligible': 'web.sk_propose_fault_source',
};

/**
 * TB8 — «پیشنهاد به‌عنوان دانش» on one delivered reply. It asks the support AI to PROPOSE a
 * lesson; nothing becomes knowledge until a reviewer approves it on the candidates page.
 */
export function ProposeKnowledgeButton({
  conversationId,
  outboundId,
}: {
  conversationId: string;
  outboundId: string;
}) {
  const notify = useToast();
  const propose = useMutation({
    // One key per CLICK, passed as the variable, so a retry reuses it.
    mutationFn: (idempotencyKey: string) =>
      proposeAsKnowledge({ conversationId, outboundId, idempotencyKey }),
    onSuccess: () => notify({ tone: 'ok', message: t('web.sk_proposed') }),
  });
  const fault = propose.error instanceof ApiError ? PROPOSE_FAULTS[propose.error.code] : undefined;
  return (
    <span className="stack">
      <button
        type="button"
        className="btn ghost sm"
        disabled={propose.isPending || propose.isSuccess}
        onClick={() => propose.mutate(newIdempotencyKey())}
      >
        {t('web.sk_propose')}
      </button>
      {propose.error != null && (
        <span className="small danger" role="alert">
          {fault === undefined ? messageFor(propose.error) : t(fault)}
        </span>
      )}
    </span>
  );
}
