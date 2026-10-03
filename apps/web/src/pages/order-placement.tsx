import { useQuery } from '@tanstack/react-query';
import type {
  OrderPlacementCandidate,
  PanelBalancingStrategy,
  PanelPlacementDecider,
  PanelPlacementExclusion,
} from '@nexa/contracts';
import { fetchOrderPlacement } from '../api/client';
import { formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { useLinkHandler } from '../router';
import { Badge, Card, DataTable, KV, Ltr, Num, StateSwitch, type Column } from '../ui/kit';
import { SELLABILITY_REASON_LABELS } from './panels';

/**
 * Phase C3: why this order landed on its panel — the operator-visible explanation.
 *
 * Read from the row the draft wrote, never recomputed: the figures are the ones the
 * decision used. An order with no row went to its product's own panel by the explicit
 * route, and the card says exactly that.
 */

export const STRATEGY_LABELS: Readonly<Record<PanelBalancingStrategy, WebKey>> = {
  LEAST_USED: 'web.balancing_strategy_least_used',
  LOWEST_UTILISATION: 'web.balancing_strategy_lowest_utilisation',
};

const DECIDER_LABELS: Readonly<Record<PanelPlacementDecider, WebKey>> = {
  SOLE_CANDIDATE: 'web.bal_decided_sole_candidate',
  HEALTH: 'web.bal_decided_health',
  LOAD: 'web.bal_decided_load',
  HOME_PREFERENCE: 'web.bal_decided_home_preference',
  PANEL_ID: 'web.bal_decided_panel_id',
  NO_ELIGIBLE_CANDIDATE: 'web.bal_decided_no_eligible_candidate',
};

const EXCLUSION_LABELS: Readonly<Record<PanelPlacementExclusion, WebKey>> = {
  INELIGIBLE: 'web.bal_excluded_ineligible',
  PROVIDER_MISMATCH: 'web.bal_excluded_provider_mismatch',
  NOT_ENTITLED: 'web.bal_excluded_not_entitled',
};

export function OrderPlacement({ orderId }: { orderId: string }) {
  const onLink = useLinkHandler();
  const placement = useQuery({
    queryKey: ['order-placement', orderId],
    queryFn: () => fetchOrderPlacement(orderId),
  });
  const decided = placement.data?.placement;

  const panelLink = (row: OrderPlacementCandidate) => (
    <a href={`/panels/${encodeURIComponent(row.panelId)}`} onClick={onLink}>
      {row.panelName}
    </a>
  );
  const columns: readonly Column<OrderPlacementCandidate>[] = [
    {
      key: 'rank',
      header: t('web.bal_placement_rank'),
      render: (row) =>
        row.rank === null ? <span className="faint">—</span> : <Num value={row.rank} />,
    },
    {
      key: 'panel',
      header: t('web.bal_placement_chosen'),
      render: (row) => (
        <>
          {panelLink(row)}
          {row.home && (
            <>
              {' '}
              <Badge tone="info" outline>
                {t('web.bal_placement_home')}
              </Badge>
            </>
          )}
        </>
      ),
    },
    {
      key: 'status',
      header: t('web.bal_placement_status'),
      render: (row) =>
        row.excluded === null ? (
          <Badge tone="ok">{t('web.ph_sellable_yes')}</Badge>
        ) : (
          <Badge tone="neutral">
            {t(EXCLUSION_LABELS[row.excluded])}
            {row.ineligibleReason !== null && (
              <> — {t(SELLABILITY_REASON_LABELS[row.ineligibleReason])}</>
            )}
          </Badge>
        ),
    },
    {
      key: 'healthy',
      header: t('web.bal_placement_healthy'),
      render: (row) =>
        row.healthy ? <Badge tone="ok">✓</Badge> : <span className="faint">—</span>,
    },
    {
      key: 'used',
      header: t('web.bal_placement_used'),
      align: 'end',
      render: (row) => (
        <>
          <Num value={row.used} />
          {' / '}
          {row.maxServices === null ? '∞' : <Num value={row.maxServices} />}
        </>
      ),
    },
  ];

  return (
    <Card title={t('web.bal_placement_title')}>
      <StateSwitch query={placement}>
        {decided === undefined ? null : decided === null ? (
          <p className="muted">{t('web.bal_placement_none')}</p>
        ) : (
          <>
            <KV
              items={[
                [t('web.bal_placement_decided_by'), t(DECIDER_LABELS[decided.decidedBy])],
                [t('web.bal_placement_group'), <Ltr key="g">{decided.group}</Ltr>],
                [t('web.bal_placement_strategy'), t(STRATEGY_LABELS[decided.strategy])],
                [t('web.bal_placement_decided_at'), formatTimestamp(decided.decidedAt)],
              ]}
            />
            <DataTable
              caption={t('web.bal_placement_title')}
              columns={columns}
              rows={decided.candidates}
              rowKey={(row) => row.panelId}
            />
          </>
        )}
      </StateSwitch>
    </Card>
  );
}
