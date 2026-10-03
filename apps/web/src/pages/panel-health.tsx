import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PANEL_DRAIN_REASON_MAX_LENGTH,
  PANEL_DRAIN_REASON_MIN_LENGTH,
  type PanelHealthRow,
  type PanelSummaryResponse,
} from '@nexa/contracts';
import { fetchPanelHealth, setPanelDrain, testPanel } from '../api/client';
import { formatTimestamp } from '../format';
import { useSubmissionKey } from '../submission-key';
import { t } from '../i18n/web.fa';
import { useLinkHandler } from '../router';
import { pollUnlessFinal } from '../polling';
import { messageFor } from './settings';
import { SEVERITY_LABELS } from './alerts';
import { FAILURE_LABELS } from './panel-advanced';
import {
  CapacityCell,
  FailureBadge,
  HealthBadge,
  SELLABILITY_REASON_LABELS,
  hostOf,
} from './panels';
import {
  Badge,
  Banner,
  Button,
  Card,
  CursorPager,
  Empty,
  Field,
  KV,
  Ltr,
  Num,
  PageHead,
  Quantity,
  StatCard,
  StateSwitch,
  Textarea,
  useToast,
  type Tone,
} from '../ui/kit';
import { Modal } from '../ui/overlays';

/**
 * Phase C2: the panel health dashboard.
 *
 * One card per live panel, every figure the server's: the latest probe (state,
 * latency, when, when it last answered, the stored unusable streak), services by
 * state, capacity, whether a new sale would go through and why not, provisioning
 * failures in the stated window, operations waiting on a read, and the panel's
 * open conditions from the operations log. Nothing is a trend: `panel_health`
 * keeps the latest state only, and a chart drawn from one point would be invented.
 *
 * Three actions, and the one that changes who can buy is set apart:
 *   - test connection — the existing operator probe (`probe-core`), `panels.edit`;
 *   - the panel's services — the services list searched by panel id;
 *   - drain / undrain — `panels.drain`, with a required reason, in its own
 *     danger-toned strip so it is never the button a thumb lands on by accident.
 */

/** The same cadence as the panel list: one writer, one refresh rate. */
const PANEL_HEALTH_REFRESH_MS = 90_000;

const HEALTH_GROUPS: readonly {
  key: string;
  label: Parameters<typeof t>[0];
  tone?: 'alert' | 'warn';
  states: readonly string[];
}[] = [
  { key: 'online', label: 'web.ph_sum_online', states: ['HEALTHY'] },
  { key: 'degraded', label: 'web.ph_sum_degraded', tone: 'warn', states: ['DEGRADED'] },
  {
    key: 'offline',
    label: 'web.ph_sum_offline',
    tone: 'alert',
    states: ['UNREACHABLE', 'AUTH_FAILED'],
  },
  { key: 'unchecked', label: 'web.ph_sum_unchecked', states: ['UNCHECKED', 'DISABLED'] },
];

const SEVERITY_TONES: Readonly<Record<string, Tone>> = {
  DEBUG: 'neutral',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'danger',
  CRITICAL: 'danger',
};

export function PanelHealthPage({
  denied,
  mayProbe,
  mayDrain,
  mayViewServices,
}: {
  denied: boolean;
  /** `panels.edit`: the operator connection test. */
  mayProbe: boolean;
  /** `panels.drain`. */
  mayDrain: boolean;
  /** `services.view`: whether the services link leads anywhere. */
  mayViewServices: boolean;
}) {
  const [cursors, setCursors] = useState<readonly string[]>([]);
  const cursor = cursors.length > 0 ? cursors[cursors.length - 1] : undefined;
  const health = useQuery({
    queryKey: ['panel-health', cursor ?? null],
    queryFn: () => fetchPanelHealth(cursor === undefined ? {} : { cursor }),
    enabled: !denied,
    refetchInterval: pollUnlessFinal(PANEL_HEALTH_REFRESH_MS),
  });
  const [draining, setDraining] = useState<PanelSummaryResponse | null>(null);

  const rows = health.data?.rows ?? [];
  const nextCursor = health.data?.nextCursor ?? null;
  const windowHours =
    health.data === undefined ? null : Math.round(health.data.failureWindowMs / 3_600_000);

  return (
    <>
      <PageHead title={t('web.nav_panel_health')} subtitle={t('web.ph_subtitle')} />
      <StateSwitch
        query={health}
        denied={denied}
        isEmpty={rows.length === 0 && cursors.length === 0}
        empty={<Empty title={t('web.ph_empty')} />}
      >
        <div className="ph-summary" aria-label={t('web.ph_summary_label')}>
          {HEALTH_GROUPS.map((group) => {
            const count = rows.filter((row) =>
              group.states.includes(row.panel.health.state),
            ).length;
            return (
              <StatCard
                key={group.key}
                label={t(group.label)}
                value={<Num value={count} />}
                {...(count > 0 && group.tone !== undefined ? { tone: group.tone } : {})}
              />
            );
          })}
          <StatCard
            label={t('web.ph_sum_draining')}
            value={<Num value={rows.filter((row) => row.panel.drain.draining).length} />}
          />
        </div>
        <p className="muted small">{t('web.ph_page_note')}</p>
        <div className="ph-cards">
          {rows.map((row) => (
            <PanelHealthCard
              key={row.panel.id}
              row={row}
              windowHours={windowHours}
              mayProbe={mayProbe}
              mayDrain={mayDrain}
              mayViewServices={mayViewServices}
              onDrain={() => setDraining(row.panel)}
            />
          ))}
        </div>
        <CursorPager
          shown={rows.length}
          hasPrevious={cursors.length > 0}
          hasNext={nextCursor !== null}
          onPrevious={() => setCursors(cursors.slice(0, -1))}
          onNext={() => {
            if (nextCursor !== null) setCursors([...cursors, nextCursor]);
          }}
        />
      </StateSwitch>
      {draining !== null && <DrainModal panel={draining} onClose={() => setDraining(null)} />}
    </>
  );
}

function PanelHealthCard({
  row,
  windowHours,
  mayProbe,
  mayDrain,
  mayViewServices,
  onDrain,
}: {
  row: PanelHealthRow;
  windowHours: number | null;
  mayProbe: boolean;
  mayDrain: boolean;
  mayViewServices: boolean;
  onDrain: () => void;
}) {
  const onLink = useLinkHandler();
  const panel = row.panel;
  const queries = useQueryClient();
  const toast = useToast();
  const probeSubmission = useSubmissionKey();
  const probe = useMutation({
    mutationFn: () =>
      testPanel({ id: panel.id, idempotencyKey: probeSubmission.current(panel.id) }),
    onSuccess: async (result) => {
      probeSubmission.settle();
      toast({
        tone: result.probed ? 'ok' : 'info',
        message: result.probed ? t('web.panel_tested') : t('web.panel_test_replayed'),
      });
      await queries.invalidateQueries({ queryKey: ['panel-health'] });
      await queries.invalidateQueries({ queryKey: ['panels'] });
    },
    onError: (error: unknown) => {
      probeSubmission.settleOn(error);
      toast({ tone: 'danger', message: messageFor(error) });
    },
  });

  const reason = panel.sellability.reason;
  const failureKind = row.provisioning.lastFailureKind;
  return (
    <Card
      className="ph-card"
      title={
        <>
          <a href={`/panels/${encodeURIComponent(panel.id)}`} onClick={onLink}>
            {panel.name}
          </a>{' '}
          <span className="faint small">
            <Ltr>{hostOf(panel.baseUrl)}</Ltr>
          </span>
        </>
      }
      actions={
        <span className="ph-badges">
          <HealthBadge panel={panel} />
          {panel.drain.draining && (
            <Badge tone="warn" outline>
              {t('web.ph_drain_badge')}
            </Badge>
          )}
        </span>
      }
      foot={
        <div className="ph-actions">
          <div className="ph-actions-safe">
            {mayProbe && panel.status !== 'ARCHIVED' && (
              <Button size="sm" disabled={probe.isPending} onClick={() => probe.mutate()}>
                {probe.isPending ? t('web.working') : t('web.panel_test')}
              </Button>
            )}
            {mayViewServices && (
              <a
                className="btn sm"
                href={`/services?q=${encodeURIComponent(panel.id)}`}
                onClick={onLink}
              >
                {t('web.ph_action_services')}
              </a>
            )}
          </div>
          {mayDrain && (
            <div className="ph-actions-danger">
              <Button
                size="sm"
                variant={panel.drain.draining ? 'default' : 'danger'}
                onClick={onDrain}
              >
                {panel.drain.draining ? t('web.ph_action_undrain') : t('web.ph_action_drain')}
              </Button>
            </div>
          )}
        </div>
      }
    >
      {panel.drain.draining && (
        <Banner tone="warn" title={t('web.ph_drain_badge')} role="status">
          {panel.drain.reason}
          {panel.drain.since !== null && (
            <span className="faint small">
              {' — '}
              {t('web.ph_drained_since')} {formatTimestamp(panel.drain.since)}
            </span>
          )}
        </Banner>
      )}
      <KV
        items={[
          [
            t('web.panel_latency'),
            panel.health.latencyMs === null ? (
              <span className="faint">—</span>
            ) : (
              <Quantity>
                <Num value={panel.health.latencyMs} /> ms
              </Quantity>
            ),
          ],
          [
            t('web.panel_last_check'),
            panel.health.checkedAt === null ? (
              <span className="faint">—</span>
            ) : (
              formatTimestamp(panel.health.checkedAt)
            ),
          ],
          [
            t('web.ph_last_healthy'),
            panel.health.lastHealthyAt === null ? (
              <span className="faint">{t('web.ph_never')}</span>
            ) : (
              formatTimestamp(panel.health.lastHealthyAt)
            ),
          ],
          [
            t('web.ph_streak'),
            panel.health.unusableStreak === null ? (
              <span className="faint">—</span>
            ) : (
              <Num value={panel.health.unusableStreak} />
            ),
          ],
          [t('web.panel_failure'), <FailureBadge key="f" failure={panel.health.failure} />],
          [t('web.panel_capacity'), <CapacityCell key="c" capacity={panel.capacity} />],
          [
            t('web.ph_services'),
            <span key="s" className="ph-services">
              {t('web.ph_services_active')} <Num value={row.services.active} />
              {' · '}
              {t('web.ph_services_suspended')} <Num value={row.services.suspended} />
              {' · '}
              {t('web.ph_services_expired')} <Num value={row.services.expired} />
              {row.services.pending > 0 && (
                <>
                  {' · '}
                  {t('web.ph_services_pending')} <Num value={row.services.pending} />
                </>
              )}
              {row.services.unreconciled > 0 && (
                <>
                  {' · '}
                  <Badge tone="warn">
                    {t('web.ph_services_unreconciled')} <Num value={row.services.unreconciled} />
                  </Badge>
                </>
              )}
            </span>,
          ],
          [
            t('web.ph_sellable'),
            reason === null ? (
              <Badge tone="ok">{t('web.ph_sellable_yes')}</Badge>
            ) : (
              <Badge tone={reason === 'DRAINING' ? 'warn' : 'danger'}>
                {t(SELLABILITY_REASON_LABELS[reason])}
              </Badge>
            ),
          ],
          [
            windowHours === null
              ? t('web.ph_failed_ops')
              : `${t('web.ph_failed_ops')} (${windowHours} ${t('web.ph_hours')})`,
            <span key="p">
              <Num value={row.provisioning.failedInWindow} />
              {row.provisioning.lastFailureAt !== null && (
                <span className="faint small">
                  {' — '}
                  {t('web.ph_last_failure')} {formatTimestamp(row.provisioning.lastFailureAt)}
                  {failureKind !== null && (
                    <>
                      {' '}
                      {FAILURE_LABELS[failureKind] === undefined
                        ? null
                        : t(FAILURE_LABELS[failureKind])}{' '}
                      <Ltr>{failureKind}</Ltr>
                    </>
                  )}
                </span>
              )}
            </span>,
          ],
          [
            t('web.ph_unknown_ops'),
            row.provisioning.unknownOpen > 0 ? (
              <Badge tone="warn">
                <Num value={row.provisioning.unknownOpen} />
              </Badge>
            ) : (
              <Num value={0} />
            ),
          ],
        ]}
      />
      <div className="ph-conditions">
        <h3 className="small">{t('web.ph_conditions')}</h3>
        {row.conditions.length === 0 ? (
          <p className="faint small">{t('web.ph_no_conditions')}</p>
        ) : (
          <ul>
            {row.conditions.map((condition) => (
              <li key={condition.code}>
                <Badge tone={SEVERITY_TONES[condition.severity] ?? 'neutral'}>
                  {t(SEVERITY_LABELS[condition.severity])}
                </Badge>{' '}
                <Ltr>{condition.code}</Ltr>{' '}
                <span className="faint small">
                  {t('web.ph_since')} {formatTimestamp(condition.firstSeenAt)}
                  {condition.occurrences > 1 && (
                    <>
                      {' · '}
                      <Num value={condition.occurrences} /> {t('web.ph_times')}
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

/**
 * Drain or undrain, with the reason the server requires.
 *
 * A modal with a form rather than `ConfirmDialog`, because the reason is typed;
 * the explanation says in plain words what drain does and — as importantly —
 * what it does NOT do, so nobody drains a panel expecting its customers to move.
 */
function DrainModal({ panel, onClose }: { panel: PanelSummaryResponse; onClose: () => void }) {
  const entering = !panel.drain.draining;
  const [reason, setReason] = useState('');
  const queries = useQueryClient();
  const toast = useToast();
  const submission = useSubmissionKey();
  const trimmed = reason.trim();
  const valid =
    trimmed.length >= PANEL_DRAIN_REASON_MIN_LENGTH &&
    trimmed.length <= PANEL_DRAIN_REASON_MAX_LENGTH;
  const run = useMutation({
    mutationFn: () => {
      const body = { id: panel.id, draining: entering, reason: trimmed };
      return setPanelDrain({ ...body, idempotencyKey: submission.current(body) });
    },
    onSuccess: async () => {
      submission.settle();
      toast({ tone: 'ok', message: entering ? t('web.ph_drain_done') : t('web.ph_undrain_done') });
      await queries.invalidateQueries({ queryKey: ['panel-health'] });
      await queries.invalidateQueries({ queryKey: ['panels'] });
      await queries.invalidateQueries({ queryKey: ['panel', panel.id] });
      onClose();
    },
    onError: (error: unknown) => submission.settleOn(error),
  });
  const close = () => {
    if (!run.isPending) onClose();
  };
  return (
    <Modal
      open
      onClose={close}
      danger={entering}
      title={entering ? t('web.ph_drain_title') : t('web.ph_undrain_title')}
      foot={
        <>
          <Button
            variant={entering ? 'danger' : 'primary'}
            size="sm"
            disabled={!valid || run.isPending}
            onClick={() => run.mutate()}
          >
            {run.isPending
              ? t('web.working')
              : entering
                ? t('web.ph_drain_confirm')
                : t('web.ph_undrain_confirm')}
          </Button>
          <Button size="sm" disabled={run.isPending} onClick={close}>
            {t('web.user_action_cancel')}
          </Button>
        </>
      }
    >
      <p>
        <strong>{panel.name}</strong>
      </p>
      <Banner tone={entering ? 'warn' : 'info'}>
        {entering ? t('web.ph_drain_explain') : t('web.ph_undrain_explain')}
      </Banner>
      {run.isError && (
        <Banner tone="danger" role="alert">
          {messageFor(run.error)}
        </Banner>
      )}
      <Field label={t('web.ph_reason_label')} hint={t('web.ph_reason_hint')} htmlFor="ph-reason">
        <Textarea
          id="ph-reason"
          value={reason}
          maxLength={PANEL_DRAIN_REASON_MAX_LENGTH}
          onChange={(event) => setReason(event.target.value)}
        />
      </Field>
    </Modal>
  );
}
