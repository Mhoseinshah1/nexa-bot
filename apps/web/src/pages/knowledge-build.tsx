import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type SupportKnowledgeBuildSourceType,
  type SupportKnowledgeBuildView,
  type SupportKnowledgeConflictChoice,
  type SupportKnowledgeProposalKind,
  type SupportKnowledgeProposalView,
} from '@nexa/contracts';
import {
  ApiError,
  applyKnowledgeBuild,
  fetchKnowledgeBuild,
  resolveKnowledgeProposal,
  runKnowledgeBuild,
} from '../api/client';
import { formatTimestamp } from '../format';
import { useSubmissionKey } from '../submission-key';
import { t, type WebKey } from '../i18n/web.fa';
import { queryState } from '../view-state';
import { messageFor } from './settings';
import { knowledgeFault } from './support-knowledge';
import { Badge, Banner, Card, Empty, PageHead, StateSwitch, useToast, type Tone } from '../ui/kit';
import { Icon } from '../ui/icons';

/**
 * TB9 — the one-click knowledge build from NEXA (ADR-0035 §5).
 *
 * The build PROPOSES. Running it changes no article; every proposal shows what it would do
 * beside what the article says now. Apply takes the non-conflicting ones (or one at a time);
 * a CONFLICT — an article a reviewer edited since the last build — is never applied without an
 * explicit choice: take the build's text (a new revision) or keep the edit. A RETIRE — a built
 * article whose source left the allowlist — has its own label and its own button, and is never
 * part of «apply all». A newer run supersedes this one. Every write carries a fresh key per click; the server charges
 * `support_knowledge.review`.
 */

export const BUILD_SOURCE_LABELS: Readonly<Record<SupportKnowledgeBuildSourceType, WebKey>> = {
  PRODUCT: 'web.kb_source_product',
  LOCATIONS: 'web.kb_source_locations',
  CLIENT_APP: 'web.kb_source_client_app',
  TUTORIAL: 'web.kb_source_tutorial',
  FAQ: 'web.kb_source_faq',
  TERMS: 'web.kb_source_terms',
  SUPPORT_ACCOUNTS: 'web.kb_source_support_accounts',
  PAYMENT_METHOD: 'web.kb_source_payment_method',
};

const KIND_LABELS: Readonly<Record<SupportKnowledgeProposalKind, WebKey>> = {
  ADD: 'web.kb_kind_add',
  UPDATE: 'web.kb_kind_update',
  UNCHANGED: 'web.kb_kind_unchanged',
  CONFLICT: 'web.kb_kind_conflict',
  RETIRE: 'web.kb_kind_retire',
};

const KIND_TONES: Readonly<Record<SupportKnowledgeProposalKind, Tone>> = {
  ADD: 'ok',
  UPDATE: 'info',
  UNCHANGED: 'neutral',
  CONFLICT: 'danger',
  RETIRE: 'warn',
};

const FAULTS: Readonly<Record<string, WebKey>> = {
  'support_knowledge.build_superseded': 'web.kb_fault_superseded',
  'support_knowledge.base_moved': 'web.kb_fault_base_moved',
  'support_knowledge.not_a_conflict': 'web.kb_fault_not_conflict',
  'support_knowledge.build_not_found': 'web.kb_fault_not_found',
  'support_knowledge.build_running': 'web.kb_fault_running',
};

function buildFault(error: unknown): string {
  if (error instanceof ApiError) {
    const key = FAULTS[error.code];
    if (key !== undefined) return t(key);
    return knowledgeFault(error);
  }
  return messageFor(error);
}

const QUERY_KEY = ['knowledge-build'] as const;

export function KnowledgeBuildPage({ denied, mayReview }: { denied: boolean; mayReview: boolean }) {
  const queries = useQueryClient();
  const notify = useToast();
  const latest = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => fetchKnowledgeBuild(),
    enabled: !denied,
  });
  const build = latest.data?.build ?? null;
  const refresh = () => {
    void queries.invalidateQueries({ queryKey: QUERY_KEY });
    void queries.invalidateQueries({ queryKey: ['support-knowledge'] });
  };

  /*
   * One key per logical attempt, passed as the variable so the automatic retry reuses it,
   * and held by `useSubmissionKey` so a re-press after a lost answer reuses it too.
   */
  const runKey = useSubmissionKey();
  const applyKey = useSubmissionKey();
  const resolveKey = useSubmissionKey();
  const run = useMutation({
    mutationFn: (idempotencyKey: string) => runKnowledgeBuild(idempotencyKey),
    onError: (error) => runKey.settleOn(error),
    onSuccess: () => {
      runKey.settle();
      notify({ tone: 'ok', message: t('web.kb_ran') });
      refresh();
    },
  });
  const apply = useMutation({
    mutationFn: (input: {
      idempotencyKey: string;
      buildId: string;
      proposalIds: string[] | null;
    }) => applyKnowledgeBuild(input),
    onSuccess: (result) => {
      applyKey.settle();
      notify({
        tone: result.conflicted > 0 || result.skipped > 0 ? 'warn' : 'ok',
        message:
          result.conflicted > 0
            ? t('web.kb_applied_with_conflicts')
            : result.skipped > 0
              ? t('web.kb_applied_with_skipped')
              : t('web.kb_applied'),
      });
      refresh();
    },
    onError: (error) => {
      applyKey.settleOn(error);
      refresh();
    },
  });
  const resolve = useMutation({
    mutationFn: (input: {
      idempotencyKey: string;
      proposalId: string;
      choice: SupportKnowledgeConflictChoice;
    }) => resolveKnowledgeProposal(input),
    onSuccess: () => {
      resolveKey.settle();
      notify({ tone: 'ok', message: t('web.kb_resolved') });
      refresh();
    },
    onError: (error) => {
      resolveKey.settleOn(error);
      refresh();
    },
  });
  const busy = run.isPending || apply.isPending || resolve.isPending;
  const error = run.error ?? apply.error ?? resolve.error;

  const pendingApplicable =
    build?.proposals.filter(
      (p) => p.state === 'PENDING' && (p.kind === 'ADD' || p.kind === 'UPDATE'),
    ).length ?? 0;

  return (
    <>
      <PageHead
        title={t('web.kb_title')}
        subtitle={t('web.kb_subtitle')}
        actions={
          mayReview ? (
            <button
              type="button"
              className="btn primary sm"
              disabled={busy}
              onClick={() => run.mutate(runKey.current('run'))}
            >
              <Icon name="refresh" />
              {t('web.kb_run')}
            </button>
          ) : undefined
        }
      />
      <Banner tone="info" icon="info">
        {t('web.kb_nothing_until_apply')}
      </Banner>
      {error != null && (
        <Banner tone="danger" role="alert">
          {buildFault(error)}
        </Banner>
      )}
      <StateSwitch
        query={latest}
        denied={denied}
        isEmpty={queryState(latest) === 'ready' && build === null}
        empty={<Empty title={t('web.kb_empty')} hint={t('web.kb_empty_hint')} />}
      >
        {build !== null && (
          <BuildCard
            build={build}
            mayReview={mayReview}
            busy={busy}
            pendingApplicable={pendingApplicable}
            onApplyAll={() =>
              apply.mutate({
                idempotencyKey: applyKey.current({ buildId: build.id, proposalIds: null }),
                buildId: build.id,
                proposalIds: null,
              })
            }
            onApplyOne={(proposal) =>
              apply.mutate({
                idempotencyKey: applyKey.current({ buildId: build.id, proposalIds: [proposal.id] }),
                buildId: build.id,
                proposalIds: [proposal.id],
              })
            }
            onResolve={(proposal, choice) =>
              resolve.mutate({
                idempotencyKey: resolveKey.current({ proposalId: proposal.id, choice }),
                proposalId: proposal.id,
                choice,
              })
            }
          />
        )}
      </StateSwitch>
    </>
  );
}

function BuildCard({
  build,
  mayReview,
  busy,
  pendingApplicable,
  onApplyAll,
  onApplyOne,
  onResolve,
}: {
  build: SupportKnowledgeBuildView;
  mayReview: boolean;
  busy: boolean;
  pendingApplicable: number;
  onApplyAll: () => void;
  onApplyOne: (proposal: SupportKnowledgeProposalView) => void;
  onResolve: (
    proposal: SupportKnowledgeProposalView,
    choice: SupportKnowledgeConflictChoice,
  ) => void;
}) {
  const open = build.state === 'OPEN';
  const changes = build.proposals.filter((p) => p.kind !== 'UNCHANGED');
  return (
    <Card
      title={`${t('web.kb_build_of')} ${formatTimestamp(build.createdAt)}`}
      hint={t('web.kb_build_hint')}
      actions={
        mayReview && open ? (
          <button
            type="button"
            className="btn primary sm"
            disabled={busy || pendingApplicable === 0}
            onClick={onApplyAll}
          >
            {t('web.kb_apply_all')}
          </button>
        ) : undefined
      }
    >
      {!open && <Banner tone="warn">{t('web.kb_superseded')}</Banner>}
      <p className="small" aria-label={t('web.kb_counts')}>
        {`${t('web.kb_kind_add')}: ${String(build.counts.add)} · ${t('web.kb_kind_update')}: ${String(build.counts.update)} · ${t('web.kb_kind_conflict')}: ${String(build.counts.conflict)} · ${t('web.kb_kind_retire')}: ${String(build.counts.retire)} · ${t('web.kb_kind_unchanged')}: ${String(build.counts.unchanged)}`}
      </p>
      {(build.truncated > 0 || build.capped > 0) && (
        <p className="small muted" aria-label={t('web.kb_bounds')}>
          {`${t('web.kb_truncated')}: ${String(build.truncated)} · ${t('web.kb_capped')}: ${String(build.capped)}`}
        </p>
      )}
      {changes.length === 0 ? (
        <p className="muted small">{t('web.kb_no_changes')}</p>
      ) : (
        <ol className="plain stack" aria-label={t('web.kb_proposals')}>
          {changes.map((proposal) => (
            <li key={proposal.id} data-kind={proposal.kind} data-decision={proposal.state}>
              <div className="row gap">
                <Badge tone={KIND_TONES[proposal.kind]} dot>
                  {t(KIND_LABELS[proposal.kind])}
                </Badge>
                <span className="small muted">{t(BUILD_SOURCE_LABELS[proposal.sourceType])}</span>
                {proposal.state !== 'PENDING' && (
                  <Badge tone="neutral">
                    {t(
                      proposal.state === 'APPLIED'
                        ? 'web.kb_state_applied'
                        : 'web.kb_state_skipped',
                    )}
                  </Badge>
                )}
              </div>
              <div className="two-col">
                {proposal.baseBody !== null && (
                  <div>
                    <p className="small muted">{t('web.kb_current')}</p>
                    <p className="strong">{proposal.baseTitle}</p>
                    <p className="support-answer">{proposal.baseBody}</p>
                  </div>
                )}
                {proposal.kind === 'RETIRE' ? (
                  <p className="small">{t('web.kb_retire_explained')}</p>
                ) : (
                  <div>
                    <p className="small muted">{t('web.kb_proposed')}</p>
                    <p className="strong">{proposal.title}</p>
                    <p className="support-answer">{proposal.body}</p>
                  </div>
                )}
              </div>
              {mayReview && open && proposal.state === 'PENDING' && (
                <div className="form-actions">
                  {proposal.kind === 'CONFLICT' ? (
                    <>
                      <span className="small">{t('web.kb_conflict_explained')}</span>
                      <button
                        type="button"
                        className="btn sm"
                        disabled={busy}
                        onClick={() => onResolve(proposal, 'TAKE_BUILD')}
                      >
                        {t('web.kb_take_build')}
                      </button>
                      <button
                        type="button"
                        className="btn ghost sm"
                        disabled={busy}
                        onClick={() => onResolve(proposal, 'KEEP_CURRENT')}
                      >
                        {t('web.kb_keep_current')}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn ghost sm"
                      disabled={busy}
                      onClick={() => onApplyOne(proposal)}
                    >
                      {t(proposal.kind === 'RETIRE' ? 'web.kb_retire_one' : 'web.kb_apply_one')}
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
