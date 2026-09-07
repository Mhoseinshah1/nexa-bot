import { useQuery } from '@tanstack/react-query';
import type { MonitorProfile } from '@nexa/contracts';
import { fetchAdmins, fetchInfo, fetchMonitorProfile, fetchReadiness } from '../api/client';
import { formatTimestamp, splitDuration } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { setQuery, type Route } from '../router';
import { queryState, staleAfterError } from './dashboard';
import {
  Badge,
  Banner,
  Card,
  Copyable,
  DataTable,
  Ident,
  KV,
  Ltr,
  MaturityBadge,
  Num,
  PageHead,
  StateSwitch,
  Tabs,
  TabPanel,
} from '../ui/kit';
import { pollUnlessFinal } from '../polling';

/**
 * System and operations.
 *
 * Owner revision 25 removes the general logs surface from the Web Admin
 * outright: no log page, no operator log browser, no one-hour retention
 * console, no archive. It is not hidden behind a permission and it is not a
 * disabled tab — it does not exist, and the last card on this page says where
 * the operational stream goes instead, so its absence reads as a decision
 * rather than an oversight.
 *
 * What remains is what an operator genuinely needs from a system page: whether
 * the process can serve traffic, what build is running, who can administer it,
 * and what the background monitor is configured to do.
 */

const SECTIONS = ['status', 'monitor', 'admins'] as const;
type Section = (typeof SECTIONS)[number];

function isSection(value: string | null): value is Section {
  return value !== null && (SECTIONS as readonly string[]).includes(value);
}

export function SystemPage({
  route,
  permissions,
}: {
  route: Route;
  permissions: readonly string[];
}) {
  const requested = route.query.get('section');
  // The section is in the URL so a screen can be linked to and survives a
  // refresh — the same reason the routes themselves are paths rather than
  // component state.
  const section: Section = isSection(requested) ? requested : 'status';

  return (
    <>
      <PageHead title={t('web.system_title')} subtitle={t('web.system_intro')} maturity="now" />

      <Tabs
        panelId="system-panel"
        value={section}
        onChange={(next) => {
          setQuery(route, 'section', next === 'status' ? null : next);
        }}
        items={[
          { id: 'status', label: t('web.system_tab_status') },
          { id: 'monitor', label: t('web.system_tab_monitor') },
          { id: 'admins', label: t('web.system_tab_admins') },
        ]}
      />

      <TabPanel id="system-panel" labelledBy={`system-panel-tab-${section}`}>
        {section === 'status' && <StatusSection />}
        {section === 'monitor' && <MonitorSection denied={!permissions.includes('panels.view')} />}
        {section === 'admins' && <AdminsSection denied={!permissions.includes('admins.view')} />}
      </TabPanel>

      <Card title={t('web.system_logs_title')}>
        <Banner tone="info" title={t('web.system_logs_absent')}>
          {t('web.system_logs_body')}
        </Banner>
        <p className="muted small">
          <MaturityBadge value="planned" /> {t('web.system_logs_destination')}
        </p>
      </Card>
    </>
  );
}

function StatusSection() {
  const readiness = useQuery({
    queryKey: ['readiness'],
    queryFn: fetchReadiness,
    refetchInterval: pollUnlessFinal(15_000),
  });
  const info = useQuery({ queryKey: ['info'], queryFn: fetchInfo });

  return (
    <>
      <Card title={t('web.system_status')} hint={t('web.system_status_hint')}>
        <StateSwitch
          state={queryState(readiness)}
          stale={staleAfterError(readiness)}
          onRetry={() => void readiness.refetch()}
        >
          <DataTable
            caption={t('web.system_status')}
            rows={readiness.data?.dependencies ?? []}
            rowKey={(row) => row.name}
            columns={[
              { key: 'name', header: t('web.dependency'), render: (row) => <Ltr>{row.name}</Ltr> },
              {
                key: 'status',
                header: t('web.status'),
                render: (row) => (
                  <Badge tone={row.status === 'up' ? 'ok' : 'danger'}>
                    {row.status === 'up' ? t('web.up') : t('web.down')}
                  </Badge>
                ),
              },
              {
                key: 'latency',
                header: t('web.latency'),
                align: 'end',
                render: (row) =>
                  row.latencyMs === undefined ? (
                    <span className="faint">—</span>
                  ) : (
                    <Ltr mono={false}>
                      <Num value={row.latencyMs} /> ms
                    </Ltr>
                  ),
              },
              {
                key: 'detail',
                header: t('web.detail'),
                render: (row) => <span className="plain">{row.detail ?? '—'}</span>,
              },
            ]}
          />
        </StateSwitch>
      </Card>

      <Card title={t('web.build_info')}>
        <StateSwitch
          state={queryState(info)}
          stale={staleAfterError(info)}
          onRetry={() => void info.refetch()}
        >
          {info.data !== undefined && (
            <KV
              items={[
                [t('web.version'), <Ltr key="v">{info.data.version}</Ltr>],
                [t('web.commit'), <Copyable key="c" value={info.data.commit} />],
                [t('web.environment'), <Ltr key="e">{info.data.environment}</Ltr>],
                [t('web.build_time'), formatTimestamp(info.data.buildTime)],
                [t('web.node_version'), <Ltr key="n">{info.data.nodeVersion}</Ltr>],
              ]}
            />
          )}
        </StateSwitch>
      </Card>
    </>
  );
}

/**
 * The background monitor, as configured.
 *
 * Owner revision 18 asks for lightweight health checks about every three
 * minutes, heavy statistics about hourly, and bulk rather than per-user
 * synchronisation. Only the first of those is a thing this release does, and
 * this section says so in the same breath as showing the cadence:
 *
 *   - **Health** is real and its interval is the SERVER's, fetched rather than
 *     printed from a constant, because a deployment can configure it.
 *   - **Heavy statistics** do not exist. There is exactly one probe
 *     implementation, it performs one `HEALTH_CHECK` and nothing else, and
 *     nothing else in this system calls a provider on a timer. The separation
 *     the revision asks for therefore holds by construction rather than by
 *     scheduling — there is nothing heavy to separate yet.
 *   - **User synchronisation** does not exist either. The design rule is
 *     recorded so that whoever builds it does not rediscover it.
 */
function MonitorSection({ denied }: { denied: boolean }) {
  const monitor = useQuery({
    queryKey: ['monitor-profile'],
    queryFn: fetchMonitorProfile,
    enabled: !denied,
  });
  const profile = monitor.data?.monitor;

  return (
    <>
      <Card title={t('web.monitor_cadence')} hint={t('web.monitor_cadence_hint')}>
        <StateSwitch
          state={denied ? 'denied' : queryState(monitor)}
          onRetry={() => void monitor.refetch()}
        >
          {profile !== undefined && (
            <KV
              items={[
                [
                  t('web.monitor_enabled'),
                  <Badge key="e" tone={profile.enabled ? 'ok' : 'neutral'}>
                    {profile.enabled ? t('web.enabled') : t('web.disabled')}
                  </Badge>,
                ],
                [
                  t('web.monitor_healthy_interval'),
                  <Duration key="h" ms={profile.healthyIntervalMs} />,
                ],
                [
                  t('web.monitor_retryable_interval'),
                  <Duration key="r" ms={profile.retryableIntervalMs} />,
                ],
                [
                  t('web.monitor_nonretryable_interval'),
                  <Duration key="n" ms={profile.nonRetryableIntervalMs} />,
                ],
                [t('web.monitor_tick'), <Duration key="t" ms={profile.tickMs} />],
                [t('web.monitor_freshness'), <Duration key="f" ms={profile.freshForMs} />],
              ]}
            />
          )}
        </StateSwitch>
      </Card>

      <Card title={t('web.monitor_capacity')} hint={t('web.monitor_capacity_hint')}>
        <StateSwitch
          state={denied ? 'denied' : queryState(monitor)}
          onRetry={() => void monitor.refetch()}
        >
          {profile !== undefined && <CapacityView profile={profile} />}
        </StateSwitch>
      </Card>

      <Card title={t('web.monitor_separation')} hint={t('web.monitor_separation_hint')}>
        <KV
          items={[
            [
              <span key="l">
                {t('web.monitor_lightweight')} <MaturityBadge value="now" />
              </span>,
              t('web.monitor_lightweight_body'),
            ],
            [
              <span key="s">
                {t('web.monitor_heavy')} <MaturityBadge value="planned" />
              </span>,
              t('web.monitor_heavy_body'),
            ],
            [
              <span key="u">
                {t('web.monitor_user_sync')} <MaturityBadge value="planned" />
              </span>,
              t('web.monitor_user_sync_body'),
            ],
          ]}
        />
      </Card>
    </>
  );
}

function CapacityView({ profile }: { profile: MonitorProfile }) {
  return (
    <>
      <Banner tone="info">{t('web.monitor_capacity_ceiling_note')}</Banner>
      <KV
        items={[
          [
            t('web.monitor_tenant_ceiling'),
            <Num key="t" value={profile.tenantFreshPanelCeiling} />,
          ],
          [
            t('web.monitor_installation_ceiling'),
            <span key="i">
              <Num value={profile.installationFreshPanelCeiling} />{' '}
              {/*
                The installation's capacity condition, which reaches an
                operator NOWHERE else. The monitor opens
                `panel.monitor.scheduler_capacity_exceeded` under `SYSTEM_SCOPE`
                with a null tenant, and the ops-log reader is tenant-scoped, so
                no `GET /ops-log` query can return it. This response is
                installation-scoped already, so it is the surface that can say.
              */}
              {profile.schedulerCapacityExceeded ? (
                <Badge tone="danger">{t('web.monitor_over_capacity')}</Badge>
              ) : (
                <Badge tone="ok">{t('web.monitor_within_capacity')}</Badge>
              )}
            </span>,
          ],
          [
            t('web.monitor_tenant_turn_ceiling'),
            <Num key="tt" value={profile.tenantTurnCeiling} />,
          ],
          [
            t('web.monitor_probe_budget'),
            <span key="b">
              <Num value={profile.probeTenantLimit} />
              {' / '}
              <Duration ms={profile.probeTenantWindowMs} />
            </span>,
          ],
          [
            t('web.monitor_reserve'),
            <Ltr key="r" mono={false}>
              <Num value={profile.budgetReservePercent} />%
            </Ltr>,
          ],
          [t('web.monitor_batch'), <Num key="ba" value={profile.batchSize} />],
          [t('web.monitor_concurrency'), <Num key="c" value={profile.concurrency} />],
        ]}
      />
    </>
  );
}

const UNIT_KEYS: Readonly<Record<'second' | 'minute' | 'hour', WebKey>> = {
  second: 'web.unit_seconds',
  minute: 'web.unit_minutes',
  hour: 'web.unit_hours',
};

function Duration({ ms }: { ms: number }) {
  const { value, unit } = splitDuration(ms);
  return (
    <span className="nowrap">
      <Num value={value} /> {t(UNIT_KEYS[unit])}
    </span>
  );
}

function AdminsSection({ denied }: { denied: boolean }) {
  const admins = useQuery({ queryKey: ['admins'], queryFn: fetchAdmins, enabled: !denied });
  const rows = admins.data?.admins ?? [];

  return (
    <Card title={t('web.administrators')} hint={t('web.administrators_hint')}>
      <StateSwitch
        state={denied ? 'denied' : queryState(admins, rows.length === 0)}
        stale={staleAfterError(admins)}
        onRetry={() => void admins.refetch()}
      >
        <DataTable
          caption={t('web.administrators')}
          rows={rows}
          rowKey={(row) => row.id}
          columns={[
            {
              key: 'who',
              header: t('web.username'),
              // Revision 8: a display name and an identifier are two values and
              // are rendered as two, with a real separator between them. The
              // legacy screen printed `کیان شریفی776737141`.
              render: (row) => <Ident name={row.displayName} id={row.username} />,
            },
            {
              key: 'status',
              header: t('web.status'),
              render: (row) => (
                <Badge tone={row.status === 'ACTIVE' ? 'ok' : 'neutral'}>
                  {/*
                    An administrator is enabled or disabled, not "up" or "out
                    of service". `web.down` is the dependency vocabulary this
                    same page uses for a downed Postgres a few rows above, and
                    reusing it here described a suspended person as an outage.
                  */}
                  {row.status === 'ACTIVE' ? t('web.admin_active') : t('web.admin_suspended')}
                </Badge>
              ),
            },
            {
              key: 'roles',
              header: t('web.roles'),
              render: (row) => row.roleKeys.join(t('web.list_separator')) || '—',
            },
            {
              key: 'last',
              header: t('web.last_login'),
              render: (row) =>
                row.lastLoginAt === null ? (
                  <span className="faint">—</span>
                ) : (
                  <span className="nowrap">{formatTimestamp(row.lastLoginAt)}</span>
                ),
            },
          ]}
        />
      </StateSwitch>
    </Card>
  );
}
