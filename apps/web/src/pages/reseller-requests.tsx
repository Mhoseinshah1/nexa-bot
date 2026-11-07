import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  RESELLER_REQUEST_ANSWER_DEFAULT_MAX,
  RESELLER_REQUEST_ANSWER_CEILING,
  RESELLER_REQUEST_MESSAGE_MAX,
  RESELLER_REQUEST_QUESTIONS_MAX,
  RESELLER_REQUEST_QUESTION_TEXT_MAX,
  RESELLER_REQUEST_REASON_MAX,
  type ResellerRequestListFilter,
  type ResellerRequestMessageView,
  type ResellerRequestQuestionView,
  type ResellerRequestSummary,
} from '@nexa/contracts';
import {
  approveResellerRequest,
  fetchResellerRequest,
  fetchResellerRequestAttachment,
  fetchResellerRequestQuestions,
  fetchResellerRequests,
  fetchResellerTiers,
  messageResellerRequest,
  rejectResellerRequest,
  saveResellerRequestQuestions,
} from '../api/client';
import { errorText } from '../error-text';
import { formatTimestamp } from '../format';
import { t } from '../i18n/web.fa';
import { setQuery, useLinkHandler, type Route } from '../router';
import { useSubmissionKey } from '../submission-key';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { keepPageWhileTurning } from '../ui/paging';
import { SortableList } from '../ui/sortable-list';
import { ErrorRef } from '../ui/technical-details';
import { useUnsavedChanges } from '../ui/unsaved';
import {
  Badge,
  Banner,
  Button,
  Card,
  CellMain,
  CursorPager,
  DataTable,
  Empty,
  Field,
  FilterChip,
  FilterChips,
  IdentityCell,
  Input,
  KV,
  LIST_PAGE_SIZE,
  Ltr,
  PageHead,
  Select,
  StateSwitch,
  Switch,
  Textarea,
  useToast,
  type Column,
} from '../ui/kit';
import { DotTabs } from './dot-tabs';

/**
 * «درخواست‌های نمایندگی» (PR-2): the list with its four chips and the «سؤال‌ها» tab, and one
 * request with its answers, its conversation and the decision.
 *
 * Permissions arrive as props. `resellers.view` lists and reads; `resellers.edit` writes the
 * questions, the messages and the decision. The server charges both again; a page that may
 * not write simply does not draw the buttons.
 */

type Tab = 'requests' | 'questions';

const FILTERS: readonly ResellerRequestListFilter[] = [
  'PENDING',
  'CONVERSING',
  'APPROVED',
  'REJECTED',
];

const FILTER_LABEL = {
  PENDING: 'web.rr_chip_pending',
  CONVERSING: 'web.rr_chip_conversing',
  APPROVED: 'web.rr_chip_approved',
  REJECTED: 'web.rr_chip_rejected',
} as const;

function statusLabel(row: { status: ResellerRequestSummary['status']; conversing: boolean }) {
  if (row.status === 'APPROVED') return t('web.rr_status_approved');
  if (row.status === 'REJECTED') return t('web.rr_status_rejected');
  return row.conversing ? t('web.rr_status_conversing') : t('web.rr_status_pending');
}

function StatusBadge({
  row,
}: {
  row: { status: ResellerRequestSummary['status']; conversing: boolean };
}) {
  const tone =
    row.status === 'APPROVED'
      ? 'ok'
      : row.status === 'REJECTED'
        ? 'danger'
        : row.conversing
          ? 'info'
          : 'warn';
  return (
    <Badge tone={tone} dot>
      {statusLabel(row)}
    </Badge>
  );
}

// -- The list -------------------------------------------------------------------------------

export function ResellerRequestsPage({
  route,
  denied,
  mayEdit,
}: {
  route: Route;
  denied: boolean;
  mayEdit: boolean;
}) {
  const tab: Tab = route.query.get('tab') === 'questions' ? 'questions' : 'requests';
  return (
    <>
      <PageHead title={t('web.rr_title')} subtitle={t('web.rr_subtitle')} />
      <DotTabs
        value={tab}
        onChange={(next) =>
          setQuery(route, 'tab', next === 'requests' ? null : next, { guard: true })
        }
        items={[
          { id: 'requests', label: t('web.rr_tab_requests') },
          { id: 'questions', label: t('web.rr_tab_questions') },
        ]}
        panelId="rr-panel"
        label={t('web.rr_tabs_label')}
      />
      <div id="rr-panel" role="tabpanel" className="rs-panel">
        {tab === 'requests' ? (
          <RequestsList route={route} denied={denied} />
        ) : (
          <QuestionsEditor denied={denied} mayEdit={mayEdit} />
        )}
      </div>
    </>
  );
}

function RequestsList({ route, denied }: { route: Route; denied: boolean }) {
  const onLink = useLinkHandler();
  const raw = route.query.get('filter');
  const filter = FILTERS.find((one) => one === raw) ?? null;
  const [trail, setTrail] = useState<{
    filter: string;
    cursors: readonly { at: string; id: string }[];
  }>({ filter: filter ?? '', cursors: [] });
  const cursors = trail.filter === (filter ?? '') ? trail.cursors : [];
  const cursor = cursors[cursors.length - 1];
  const list = useQuery(
    keepPageWhileTurning({
      queryKey: ['reseller-requests', filter, cursor ?? null],
      queryFn: () =>
        fetchResellerRequests({
          ...(filter === null ? {} : { filter }),
          limit: LIST_PAGE_SIZE,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      enabled: !denied,
    }),
  );
  const rows = list.data?.requests ?? [];
  const counts = list.data?.counts;
  const nextCursor = list.data?.nextCursor ?? null;

  const columns: readonly Column<ResellerRequestSummary>[] = [
    {
      key: 'number',
      header: t('web.rr_col_number'),
      render: (row) => (
        <a
          href={`/reseller-requests/${encodeURIComponent(row.id)}`}
          onClick={onLink}
          className="strong"
        >
          <Ltr>#{row.number}</Ltr>
        </a>
      ),
    },
    {
      key: 'customer',
      header: t('web.rr_col_customer'),
      render: (row) => (
        <IdentityCell
          name={row.customerName ?? t('web.customer_identity_unknown')}
          username={row.customerUsername}
          id={null}
          href={`/users/${encodeURIComponent(row.customerId)}`}
        />
      ),
    },
    { key: 'status', header: t('web.status'), render: (row) => <StatusBadge row={row} /> },
    {
      key: 'last',
      header: t('web.rr_col_last'),
      render: (row) => (
        <span className="nowrap muted">
          {row.lastMessageAt === null ? '—' : formatTimestamp(row.lastMessageAt)}
        </span>
      ),
    },
    {
      key: 'created',
      header: t('web.rr_col_created'),
      render: (row) => <span className="nowrap muted">{formatTimestamp(row.createdAt)}</span>,
    },
  ];

  return (
    <Card tight>
      <FilterChips label={t('web.rr_filter_label')}>
        <FilterChip pressed={filter === null} onClick={() => setQuery(route, 'filter', null)}>
          {t('web.rr_chip_all')}
        </FilterChip>
        {FILTERS.map((one) => (
          <FilterChip
            key={one}
            pressed={filter === one}
            onClick={() => setQuery(route, 'filter', one)}
            {...(counts === undefined
              ? {}
              : {
                  count:
                    counts[
                      one === 'PENDING'
                        ? 'pending'
                        : one === 'CONVERSING'
                          ? 'conversing'
                          : one === 'APPROVED'
                            ? 'approved'
                            : 'rejected'
                    ],
                })}
          >
            {t(FILTER_LABEL[one])}
          </FilterChip>
        ))}
      </FilterChips>
      <StateSwitch
        query={list}
        denied={denied}
        isEmpty={rows.length === 0 && cursors.length === 0}
        empty={<Empty title={t('web.rr_empty_title')} hint={t('web.rr_empty_hint')} />}
      >
        <DataTable
          caption={t('web.rr_title')}
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
        />
        <CursorPager
          order="newest-first"
          shown={rows.length}
          hasPrevious={cursors.length > 0}
          hasNext={nextCursor !== null}
          onPrevious={() => setTrail({ filter: filter ?? '', cursors: cursors.slice(0, -1) })}
          onNext={() =>
            nextCursor !== null &&
            setTrail({ filter: filter ?? '', cursors: [...cursors, nextCursor] })
          }
        />
      </StateSwitch>
    </Card>
  );
}

// -- The questions --------------------------------------------------------------------------

interface DraftQuestion {
  /** Stable for the editor's life: the stored id, or a client key for a new one. */
  readonly key: string;
  readonly id: string | undefined;
  readonly text: string;
  readonly required: boolean;
  readonly maxLength: string;
}

let nextClientKey = 0;
const newKey = (): string => {
  nextClientKey += 1;
  return `new-${String(nextClientKey)}`;
};

function draftOf(question: ResellerRequestQuestionView): DraftQuestion {
  return {
    key: question.id,
    id: question.id,
    text: question.text,
    required: question.required,
    maxLength: String(question.maxLength),
  };
}

function boundOf(raw: string): number | null {
  if (!/^\d{1,4}$/u.test(raw)) return null;
  const value = Number(raw);
  return value >= 1 && value <= RESELLER_REQUEST_ANSWER_CEILING ? value : null;
}

function QuestionsEditor({ denied, mayEdit }: { denied: boolean; mayEdit: boolean }) {
  const queries = useQueryClient();
  const notify = useToast();
  const submission = useSubmissionKey();
  const stored = useQuery({
    queryKey: ['reseller-request-questions'],
    queryFn: fetchResellerRequestQuestions,
    enabled: !denied,
  });
  // The draft is the operator's, seeded from the server's list; null means "untouched".
  const [edited, setEdited] = useState<readonly DraftQuestion[] | null>(null);
  const saved = (stored.data?.questions ?? []).map(draftOf);
  const draft = edited ?? saved;
  const dirty =
    edited !== null &&
    JSON.stringify(
      edited.map(({ id, text, required, maxLength }) => [id, text, required, maxLength]),
    ) !==
      JSON.stringify(
        saved.map(({ id, text, required, maxLength }) => [id, text, required, maxLength]),
      );
  useUnsavedChanges(dirty);

  const problems = draft.map((one) =>
    one.text.trim() === '' ||
    Array.from(one.text.trim()).length > RESELLER_REQUEST_QUESTION_TEXT_MAX
      ? 'text'
      : boundOf(one.maxLength) === null
        ? 'length'
        : null,
  );
  const valid =
    draft.length <= RESELLER_REQUEST_QUESTIONS_MAX && problems.every((one) => one === null);

  const save = useMutation({
    mutationFn: (value: readonly DraftQuestion[]) => {
      const questions = value.map((one) => ({
        ...(one.id === undefined ? {} : { id: one.id }),
        text: one.text.trim(),
        required: one.required,
        maxLength: boundOf(one.maxLength) ?? RESELLER_REQUEST_ANSWER_DEFAULT_MAX,
      }));
      return saveResellerRequestQuestions({
        idempotencyKey: submission.current(questions),
        questions,
      });
    },
    onSuccess: () => {
      submission.settle();
      setEdited(null);
      notify({ tone: 'ok', message: t('web.rrq_saved') });
      void queries.invalidateQueries({ queryKey: ['reseller-request-questions'] });
    },
    onError: (error) => submission.settleOn(error),
  });

  const change = (next: readonly DraftQuestion[]) => setEdited(next);
  const patch = (index: number, value: Partial<DraftQuestion>) =>
    change(draft.map((one, at) => (at === index ? { ...one, ...value } : one)));

  return (
    <Card title={t('web.rrq_title')} hint={t('web.rrq_hint')}>
      <StateSwitch query={stored} denied={denied} isEmpty={false}>
        {draft.length === 0 && <Empty variant="compact" title={t('web.rrq_empty')} />}
        <SortableList
          items={draft}
          itemKey={(one) => one.key}
          label={t('web.rrq_list_label')}
          disabled={!mayEdit || save.isPending}
          onReorder={(from, to) => {
            const next = [...draft];
            const [moved] = next.splice(from, 1);
            if (moved !== undefined) next.splice(to, 0, moved);
            change(next);
          }}
          renderItem={(one, index) => (
            <div className="stack">
              <Field
                label={t('web.rrq_text')}
                htmlFor={`rrq-text-${one.key}`}
                {...(problems[index] === 'text' ? { error: t('web.rrq_text_problem') } : {})}
              >
                <Textarea
                  id={`rrq-text-${one.key}`}
                  rows={2}
                  value={one.text}
                  maxLength={RESELLER_REQUEST_QUESTION_TEXT_MAX * 2}
                  disabled={!mayEdit || save.isPending}
                  onChange={(event) => patch(index, { text: event.target.value })}
                />
              </Field>
              <div className="form-actions">
                <Switch
                  checked={one.required}
                  label={t('web.rrq_required')}
                  disabled={!mayEdit || save.isPending}
                  onChange={(required) => patch(index, { required })}
                />
                <Field
                  label={t('web.rrq_max')}
                  htmlFor={`rrq-max-${one.key}`}
                  compact
                  {...(problems[index] === 'length' ? { error: t('web.rrq_max_problem') } : {})}
                >
                  <Input
                    id={`rrq-max-${one.key}`}
                    inputMode="numeric"
                    size="sm"
                    value={one.maxLength}
                    disabled={!mayEdit || save.isPending}
                    onChange={(event) => patch(index, { maxLength: event.target.value })}
                  />
                </Field>
                {mayEdit && (
                  <Button
                    size="sm"
                    variant="danger"
                    icon="trash"
                    disabled={save.isPending}
                    onClick={() => change(draft.filter((_, at) => at !== index))}
                  >
                    {t('web.rrq_delete')}
                  </Button>
                )}
              </div>
            </div>
          )}
        />
        {mayEdit && (
          <div className="form-actions">
            <Button
              icon="plus"
              disabled={save.isPending || draft.length >= RESELLER_REQUEST_QUESTIONS_MAX}
              onClick={() =>
                change([
                  ...draft,
                  {
                    key: newKey(),
                    id: undefined,
                    text: '',
                    required: false,
                    maxLength: String(RESELLER_REQUEST_ANSWER_DEFAULT_MAX),
                  },
                ])
              }
            >
              {t('web.rrq_add')}
            </Button>
            <Button
              variant="primary"
              disabled={!dirty || !valid || save.isPending}
              onClick={() => save.mutate(draft)}
            >
              {t('web.save')}
            </Button>
          </div>
        )}
        {!mayEdit && <Banner tone="info">{t('web.rrq_view_only')}</Banner>}
        {save.error !== null && (
          <Banner tone="danger">
            {errorText(save.error)}
            <ErrorRef error={save.error} />
          </Banner>
        )}
      </StateSwitch>
    </Card>
  );
}

// -- One request ----------------------------------------------------------------------------

export function ResellerRequestDetailPage({
  id,
  denied,
  mayEdit,
}: {
  id: string;
  denied: boolean;
  mayEdit: boolean;
}) {
  const request = useQuery({
    queryKey: ['reseller-request', id],
    queryFn: () => fetchResellerRequest(id),
    enabled: !denied,
  });
  const onLink = useLinkHandler();
  const data = request.data?.request;
  return (
    <>
      <PageHead
        title={
          data === undefined ? (
            t('web.rr_detail')
          ) : (
            <>
              {t('web.rr_detail')} <Ltr mono={false}>#{data.number}</Ltr>
            </>
          )
        }
        {...(data === undefined ? {} : { badge: <StatusBadge row={data} /> })}
      />
      <StateSwitch query={request} denied={denied}>
        {data !== undefined && (
          <div className="two-col ops-sticky-cols">
            <div className="stack">
              <Card title={t('web.rr_answers')}>
                {data.answers.length === 0 && (
                  <Empty variant="compact" title={t('web.rr_no_answers')} />
                )}
                {data.answers.map((one) => (
                  <div className="rr-answer" key={one.questionId}>
                    <span className="muted small">{one.text}</span>
                    <span className="rr-answer-text">
                      {one.answer ?? <span className="muted">{t('web.rr_answer_skipped')}</span>}
                    </span>
                  </div>
                ))}
              </Card>
              <ThreadCard messages={data.messages} />
              {data.status === 'PENDING' ? (
                mayEdit && <ComposerCard id={data.id} />
              ) : (
                <Banner tone="info">{t('web.rr_closed_banner')}</Banner>
              )}
            </div>
            <div className="stack">
              <Card title={t('web.rr_summary')}>
                <KV
                  items={[
                    [
                      t('web.rr_col_customer'),
                      <IdentityCell
                        key="customer"
                        name={data.customerName ?? t('web.customer_identity_unknown')}
                        username={data.customerUsername}
                        id={null}
                        href={`/users/${encodeURIComponent(data.customerId)}`}
                      />,
                    ],
                    [t('web.rr_services_count'), data.servicesCount],
                    [t('web.rr_col_created'), formatTimestamp(data.createdAt)],
                    ...(data.decidedAt === null
                      ? []
                      : ([[t('web.rr_decided_at'), formatTimestamp(data.decidedAt)]] as [
                          string,
                          string,
                        ][])),
                    ...(data.decidedByName === null
                      ? []
                      : ([[t('web.rr_decided_by'), data.decidedByName]] as [string, string][])),
                    ...(data.tierName === null
                      ? []
                      : ([[t('web.rr_tier'), data.tierName]] as [string, string][])),
                    ...(data.reason === null
                      ? []
                      : ([[t('web.rr_reason'), data.reason]] as [string, string][])),
                  ]}
                />
                <a href={`/users/${encodeURIComponent(data.customerId)}`} onClick={onLink}>
                  {t('web.rr_customer_link')}
                </a>
              </Card>
              {mayEdit && data.status === 'PENDING' && <DecisionCard id={data.id} />}
            </div>
          </div>
        )}
      </StateSwitch>
    </>
  );
}

function Photo({ message }: { message: ResellerRequestMessageView }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let revoked: string | null = null;
    let live = true;
    void fetchResellerRequestAttachment(message.id).then(
      (blob) => {
        if (!live) return;
        revoked = URL.createObjectURL(blob);
        setUrl(revoked);
      },
      () => setFailed(true),
    );
    return () => {
      live = false;
      if (revoked !== null) URL.revokeObjectURL(revoked);
    };
  }, [message.id]);
  if (failed) return <span className="muted">{t('web.rr_photo_unavailable')}</span>;
  if (url === null) return <span className="muted">{t('web.rr_photo')}</span>;
  return <img className="rr-photo" src={url} alt={t('web.rr_photo')} />;
}

function ThreadCard({ messages }: { messages: readonly ResellerRequestMessageView[] }) {
  return (
    <Card title={t('web.rr_thread')}>
      {messages.length === 0 && <Empty variant="compact" title={t('web.rr_thread_empty')} />}
      <div className="rr-thread">
        {messages.map((one) => (
          <div
            key={one.id}
            className={`rr-message${one.senderType === 'ADMIN' ? ' is-admin' : ''}`}
          >
            <CellMain
              primary={
                one.senderType === 'ADMIN'
                  ? (one.authorAdminName ?? t('web.rr_sender_admin'))
                  : t('web.rr_sender_customer')
              }
              secondary={<span className="muted small">{formatTimestamp(one.createdAt)}</span>}
            />
            {one.body !== null && <span className="rr-message-text">{one.body}</span>}
            {one.attachmentKind !== null && <Photo message={one} />}
          </div>
        ))}
      </div>
    </Card>
  );
}

function ComposerCard({ id }: { id: string }) {
  const queries = useQueryClient();
  const notify = useToast();
  const submission = useSubmissionKey();
  const [text, setText] = useState('');
  const body = text.trim();
  const valid = body !== '' && Array.from(body).length <= RESELLER_REQUEST_MESSAGE_MAX;
  const send = useMutation({
    mutationFn: (value: string) =>
      messageResellerRequest({
        id,
        text: value,
        idempotencyKey: submission.current({ id, value }),
      }),
    onSuccess: () => {
      submission.settle();
      setText('');
      notify({ tone: 'ok', message: t('web.rr_message_sent') });
      void queries.invalidateQueries({ queryKey: ['reseller-request', id] });
      void queries.invalidateQueries({ queryKey: ['reseller-requests'] });
    },
    onError: (error) => submission.settleOn(error),
  });
  return (
    <Card title={t('web.rr_composer')} hint={t('web.rr_composer_hint')}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) send.mutate(body);
        }}
      >
        <Field label={t('web.rr_composer_label')} htmlFor="rr-composer">
          <Textarea
            id="rr-composer"
            rows={4}
            value={text}
            maxLength={RESELLER_REQUEST_MESSAGE_MAX * 2}
            disabled={send.isPending}
            onChange={(event) => setText(event.target.value)}
          />
        </Field>
        <div className="form-actions">
          <Button type="submit" variant="primary" icon="send" disabled={!valid || send.isPending}>
            {t('web.rr_send')}
          </Button>
        </div>
      </form>
      {send.error !== null && (
        <Banner tone="danger">
          {errorText(send.error)}
          <ErrorRef error={send.error} />
        </Banner>
      )}
    </Card>
  );
}

function DecisionCard({ id }: { id: string }) {
  const queries = useQueryClient();
  const notify = useToast();
  const approveKey = useSubmissionKey();
  const rejectKey = useSubmissionKey();
  const tiers = useQuery({ queryKey: ['reseller-tiers'], queryFn: fetchResellerTiers });
  const [tierId, setTierId] = useState('');
  const [reason, setReason] = useState('');
  const [asking, setAsking] = useState<'approve' | 'reject' | null>(null);
  const trimmed = reason.trim();
  const reasonOk = Array.from(trimmed).length <= RESELLER_REQUEST_REASON_MAX;

  const done = (message: string) => {
    setAsking(null);
    notify({ tone: 'ok', message });
    void queries.invalidateQueries({ queryKey: ['reseller-request', id] });
    void queries.invalidateQueries({ queryKey: ['reseller-requests'] });
  };
  const approve = useMutation({
    mutationFn: () =>
      approveResellerRequest({ id, tierId, idempotencyKey: approveKey.current({ id, tierId }) }),
    onSuccess: () => {
      approveKey.settle();
      done(t('web.rr_approved'));
    },
    onError: (error) => {
      approveKey.settleOn(error);
      setAsking(null);
    },
  });
  const reject = useMutation({
    mutationFn: () =>
      rejectResellerRequest({
        id,
        ...(trimmed === '' ? {} : { reason: trimmed }),
        idempotencyKey: rejectKey.current({ id, reason: trimmed }),
      }),
    onSuccess: () => {
      rejectKey.settle();
      done(t('web.rr_rejected'));
    },
    onError: (error) => {
      rejectKey.settleOn(error);
      setAsking(null);
    },
  });
  const busy = approve.isPending || reject.isPending;
  const failure = approve.error ?? reject.error;
  const choices = tiers.data?.tiers ?? [];
  return (
    <Card title={t('web.rr_decision')}>
      <Field label={t('web.rr_tier')} htmlFor="rr-tier">
        <Select
          id="rr-tier"
          value={tierId}
          disabled={busy}
          onChange={(event) => setTierId(event.target.value)}
        >
          <option value="">{t('web.rr_tier_pick')}</option>
          {choices.map((tier) => (
            <option key={tier.id} value={tier.id}>
              {tier.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('web.rr_reject_reason')} htmlFor="rr-reason">
        <Textarea
          id="rr-reason"
          rows={2}
          value={reason}
          maxLength={RESELLER_REQUEST_REASON_MAX * 2}
          disabled={busy}
          onChange={(event) => setReason(event.target.value)}
        />
      </Field>
      <div className="form-actions">
        <Button
          variant="primary"
          disabled={tierId === '' || busy}
          onClick={() => setAsking('approve')}
        >
          {t('web.rr_approve')}
        </Button>
        <Button variant="danger" disabled={!reasonOk || busy} onClick={() => setAsking('reject')}>
          {t('web.rr_reject')}
        </Button>
      </div>
      {failure !== null && (
        <Banner tone="danger">
          {errorText(failure)}
          <ErrorRef error={failure} />
        </Banner>
      )}
      {asking === 'approve' && (
        <ConfirmDialog
          title={t('web.rr_approve')}
          question={t('web.rr_approve_question')}
          detail={t('web.rr_approve_detail')}
          confirmLabel={t('web.rr_approve_confirm')}
          cancelLabel={t('web.rr_cancel')}
          onConfirm={() => approve.mutate()}
          onCancel={() => setAsking(null)}
        />
      )}
      {asking === 'reject' && (
        <ConfirmDialog
          title={t('web.rr_reject')}
          question={t('web.rr_reject_question')}
          detail={trimmed === '' ? t('web.rr_reject_detail_plain') : trimmed}
          confirmLabel={t('web.rr_reject_confirm')}
          cancelLabel={t('web.rr_cancel')}
          onConfirm={() => reject.mutate()}
          onCancel={() => setAsking(null)}
        />
      )}
    </Card>
  );
}
