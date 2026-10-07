import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  LEGACY_WALLET_DEBT_STATES,
  type LegacyWalletDebtDecision,
  type LegacyWalletDebtState,
  type LegacyWalletDebtView,
} from '@nexa/contracts';
import {
  ApiError,
  decideLegacyDebt,
  fetchLegacyDebtSummary,
  fetchLegacyDebts,
  reopenLegacyDebt,
} from '../api/client';
import { formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { useLinkHandler } from '../router';
import { useSubmissionKey } from '../submission-key';
import { queryState } from '../view-state';
import { messageFor } from './settings';
import {
  Badge,
  Banner,
  Card,
  CellMain,
  CursorPager,
  DataTable,
  Empty,
  Field,
  FilterBar,
  Input,
  Ltr,
  Money,
  Num,
  PageHead,
  RowActions,
  Select,
  StateSwitch,
  useToast,
  type Column,
  type Tone,
} from '../ui/kit';
import { Drawer } from '../ui/overlays';

/**
 * Mirza migration PR4 — legacy wallet debts (owner decision 6, 2026-10-07).
 *
 * Each row is a NEGATIVE legacy (Mirza) balance the importer held for review instead of
 * writing it to the ledger: the customer's NEXA balance started at 0, and the amount the
 * legacy bot said they owed is recorded here with the snapshot it came from. The debt is
 * NEVER collected — no top-up, purchase or refund reads it. The owner records one decision
 * per customer (acknowledged, waived, or back to review), and the page says plainly that no
 * decision moves money: there is no amount field and no button that charges anyone.
 */

export const LEGACY_DEBT_STATE_LABELS: Readonly<Record<LegacyWalletDebtState, WebKey>> = {
  PENDING_REVIEW: 'web.lwd_state_pending',
  ACKNOWLEDGED: 'web.lwd_state_acknowledged',
  WAIVED: 'web.lwd_state_waived',
};

const STATE_TONES: Readonly<Record<LegacyWalletDebtState, Tone>> = {
  PENDING_REVIEW: 'warn',
  ACKNOWLEDGED: 'info',
  WAIVED: 'neutral',
};

const FAULTS: Readonly<Record<string, WebKey>> = {
  'legacy_wallet_debt.not_found': 'web.lwd_fault_not_found',
  'legacy_wallet_debt.not_in_state': 'web.lwd_fault_not_in_state',
  'legacy_wallet_debt.version_conflict': 'web.lwd_fault_version',
  'legacy_wallet_debt.scope_stopped': 'web.lwd_fault_stopped',
};

export function legacyDebtFault(error: unknown): string {
  if (error instanceof ApiError) {
    const key = FAULTS[error.code];
    if (key !== undefined) return t(key);
  }
  return messageFor(error);
}

type StateFilter = LegacyWalletDebtState | 'ALL';

function Owed({ row }: { row: Pick<LegacyWalletDebtView, 'amountMinor' | 'currency'> }) {
  return <Money value={{ amountMinor: row.amountMinor, currency: row.currency }} />;
}

export function LegacyDebtsPage({
  denied,
  mayDecide,
}: {
  /** `legacy.debts.view` is not held. */
  denied: boolean;
  /** `legacy.debts.decide`. */
  mayDecide: boolean;
}) {
  const [stateFilter, setStateFilter] = useState<StateFilter>('PENDING_REVIEW');
  const [legacyUserId, setLegacyUserId] = useState('');
  const [trail, setTrail] = useState<readonly string[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const after = trail[trail.length - 1];
  const searchId = /^[1-9][0-9]{0,19}$/u.test(legacyUserId.trim()) ? legacyUserId.trim() : '';
  const query = {
    ...(stateFilter === 'ALL' ? {} : { state: stateFilter }),
    ...(searchId === '' ? {} : { legacyUserId: searchId }),
    ...(after === undefined ? {} : { after }),
  };
  const debts = useQuery({
    queryKey: ['legacy-debts', query],
    queryFn: () => fetchLegacyDebts(query),
    enabled: !denied,
  });
  const summary = useQuery({
    queryKey: ['legacy-debts', 'summary'],
    queryFn: fetchLegacyDebtSummary,
    enabled: !denied,
  });
  const rows = debts.data?.debts ?? [];
  const nextCursor = debts.data?.nextCursor ?? null;
  const open = rows.find((row) => row.id === openId) ?? null;
  const resetPaging = () => setTrail([]);

  const columns: readonly Column<LegacyWalletDebtView>[] = [
    {
      key: 'legacyUser',
      header: t('web.lwd_col_legacy_user'),
      render: (row) => (
        <CellMain
          primary={<Ltr>{row.legacyUserId}</Ltr>}
          secondary={<span className="muted small">{formatTimestamp(row.recordedAt)}</span>}
        />
      ),
    },
    {
      key: 'amount',
      header: t('web.lwd_col_amount'),
      align: 'end',
      render: (row) => <Owed row={row} />,
    },
    {
      key: 'state',
      header: t('web.lwd_col_state'),
      render: (row) => (
        <Badge tone={STATE_TONES[row.state]}>{t(LEGACY_DEBT_STATE_LABELS[row.state])}</Badge>
      ),
    },
    {
      key: 'actions',
      header: t('web.lwd_col_actions'),
      align: 'end',
      render: (row) => (
        <RowActions>
          <button type="button" className="btn ghost sm" onClick={() => setOpenId(row.id)}>
            {t('web.lwd_open')}
          </button>
        </RowActions>
      ),
    },
  ];

  return (
    <>
      <PageHead title={t('web.lwd_title')} subtitle={t('web.lwd_subtitle')} />
      <Banner tone="info" icon="info">
        {t('web.lwd_banner')}
      </Banner>
      {summary.data !== undefined && (
        <Card title={t('web.lwd_summary_title')}>
          <dl className="kv">
            <dt>{t('web.lwd_summary_total')}</dt>
            <dd>
              <Num value={summary.data.total.count} /> ·{' '}
              <Money
                value={{
                  amountMinor: summary.data.total.sumMinor,
                  currency: summary.data.currency,
                }}
              />
            </dd>
            {LEGACY_WALLET_DEBT_STATES.map((state) => (
              <span key={state} style={{ display: 'contents' }}>
                <dt>{t(LEGACY_DEBT_STATE_LABELS[state])}</dt>
                <dd>
                  <Num value={summary.data.byState[state].count} /> ·{' '}
                  <Money
                    value={{
                      amountMinor: summary.data.byState[state].sumMinor,
                      currency: summary.data.currency,
                    }}
                  />
                </dd>
              </span>
            ))}
          </dl>
        </Card>
      )}
      <FilterBar>
        <Field label={t('web.lwd_col_state')} htmlFor="lwd-state" compact>
          <Select
            id="lwd-state"
            size="sm"
            value={stateFilter}
            onChange={(event) => {
              setStateFilter(event.target.value as StateFilter);
              resetPaging();
            }}
          >
            {LEGACY_WALLET_DEBT_STATES.map((state) => (
              <option key={state} value={state}>
                {t(LEGACY_DEBT_STATE_LABELS[state])}
              </option>
            ))}
            <option value="ALL">{t('web.lwd_filter_all')}</option>
          </Select>
        </Field>
        <Field label={t('web.lwd_search_legacy_user')} htmlFor="lwd-user" compact>
          <Input
            id="lwd-user"
            size="sm"
            inputMode="numeric"
            dir="ltr"
            value={legacyUserId}
            maxLength={20}
            onChange={(event) => {
              setLegacyUserId(event.target.value);
              resetPaging();
            }}
          />
        </Field>
      </FilterBar>
      <StateSwitch
        query={debts}
        denied={denied}
        isEmpty={queryState(debts) === 'ready' && rows.length === 0 && trail.length === 0}
        empty={<Empty title={t('web.lwd_empty')} hint={t('web.lwd_empty_hint')} />}
      >
        <Card title={t('web.lwd_title')}>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            caption={t('web.lwd_title')}
            dense
          />
          <CursorPager
            shown={rows.length}
            hasPrevious={trail.length > 0}
            hasNext={nextCursor !== null}
            onPrevious={() => setTrail(trail.slice(0, -1))}
            onNext={() => nextCursor !== null && setTrail([...trail, nextCursor])}
          />
        </Card>
      </StateSwitch>
      <Drawer
        open={open !== null}
        onClose={() => setOpenId(null)}
        title={open === null ? '' : <Ltr>{open.legacyUserId}</Ltr>}
        wide
      >
        {open !== null && (
          <DebtDetail key={`${open.id}:${String(open.version)}`} row={open} mayDecide={mayDecide} />
        )}
      </Drawer>
    </>
  );
}

/** The debt as recorded, its provenance, and the owner's decision. */
export function DebtDetail({ row, mayDecide }: { row: LegacyWalletDebtView; mayDecide: boolean }) {
  const onLink = useLinkHandler();
  return (
    <div className="stack">
      <Badge tone={STATE_TONES[row.state]}>{t(LEGACY_DEBT_STATE_LABELS[row.state])}</Badge>
      <Banner tone="info">{t('web.lwd_never_collected')}</Banner>
      <Card title={t('web.lwd_recorded_title')}>
        <dl className="kv">
          <dt>{t('web.lwd_col_legacy_user')}</dt>
          <dd>
            <Ltr>{row.legacyUserId}</Ltr>
          </dd>
          <dt>{t('web.lwd_customer')}</dt>
          <dd>
            <a href={`/users/${encodeURIComponent(row.customerId)}`} onClick={onLink}>
              {t('web.lwd_open_customer')}
            </a>
          </dd>
          <dt>{t('web.lwd_col_amount')}</dt>
          <dd>
            <Owed row={row} />
          </dd>
          <dt>{t('web.lwd_recorded_at')}</dt>
          <dd>{formatTimestamp(row.recordedAt)}</dd>
          <dt>{t('web.lwd_source_fingerprint')}</dt>
          <dd>
            <Ltr>{row.sourceFingerprint}</Ltr>
          </dd>
          <dt>{t('web.lwd_row_checksum')}</dt>
          <dd>
            <Ltr>{row.rowChecksum}</Ltr>
          </dd>
          <dt>{t('web.lwd_run')}</dt>
          <dd>
            <Ltr>{row.runId}</Ltr>
          </dd>
          {row.decidedAt !== null && (
            <>
              <dt>{t('web.lwd_decided_at')}</dt>
              <dd>{formatTimestamp(row.decidedAt)}</dd>
            </>
          )}
          {row.decisionReason !== null && (
            <>
              <dt>{t('web.lwd_reason')}</dt>
              <dd>
                <bdi>{row.decisionReason}</bdi>
              </dd>
            </>
          )}
        </dl>
      </Card>
      {mayDecide ? <Decisions row={row} /> : <Banner tone="info">{t('web.lwd_view_only')}</Banner>}
    </div>
  );
}

function Decisions({ row }: { row: LegacyWalletDebtView }) {
  const queries = useQueryClient();
  const notify = useToast();
  const submission = useSubmissionKey();
  const [reason, setReason] = useState('');

  const decide = useMutation({
    mutationFn: (
      command: { kind: 'decide'; decision: LegacyWalletDebtDecision } | { kind: 'reopen' },
    ) => {
      const idempotencyKey = submission.current({
        id: row.id,
        version: row.version,
        command,
        reason: reason.trim(),
      });
      if (command.kind === 'decide') {
        return decideLegacyDebt({
          id: row.id,
          idempotencyKey,
          expectedVersion: row.version,
          decision: command.decision,
          reason: reason.trim(),
        });
      }
      return reopenLegacyDebt({
        id: row.id,
        idempotencyKey,
        expectedVersion: row.version,
        reason: reason.trim(),
      });
    },
    onSuccess: () => {
      submission.settle();
      notify({ tone: 'ok', message: t('web.lwd_saved') });
      void queries.invalidateQueries({ queryKey: ['legacy-debts'] });
    },
    onError: (error: unknown) => {
      submission.settleOn(error);
      void queries.invalidateQueries({ queryKey: ['legacy-debts'] });
    },
  });
  const busy = decide.isPending;
  const noReason = reason.trim() === '';

  return (
    <Card title={t('web.lwd_decide_title')}>
      <div className="stack">
        <Banner tone="warn">{t('web.lwd_decision_moves_no_money')}</Banner>
        <Field label={t('web.lwd_reason')} htmlFor="lwd-reason" hint={t('web.lwd_reason_hint')}>
          <Input
            id="lwd-reason"
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
        <div className="form-actions">
          {row.state === 'PENDING_REVIEW' ? (
            <>
              <button
                type="button"
                className="btn primary sm"
                disabled={busy || noReason}
                onClick={() => decide.mutate({ kind: 'decide', decision: 'ACKNOWLEDGED' })}
              >
                {t('web.lwd_acknowledge')}
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={busy || noReason}
                onClick={() => decide.mutate({ kind: 'decide', decision: 'WAIVED' })}
              >
                {t('web.lwd_waive')}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn sm"
              disabled={busy || noReason}
              onClick={() => decide.mutate({ kind: 'reopen' })}
            >
              {t('web.lwd_reopen')}
            </button>
          )}
        </div>
        {decide.error !== null && (
          <Banner tone="danger" role="alert">
            {legacyDebtFault(decide.error)}
          </Banner>
        )}
      </div>
    </Card>
  );
}
