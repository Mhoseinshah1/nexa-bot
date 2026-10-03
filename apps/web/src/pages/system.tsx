import { RolesSection } from './roles';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import {
  IDENTITY_ERROR_CODES,
  type AdminSessionSummary,
  type AdminSummary,
  type MonitorProfile,
  type PermissionKey,
} from '@nexa/contracts';
import {
  ApiError,
  createAdmin,
  fetchAdminSessions,
  fetchAdmins,
  fetchInfo,
  fetchMonitorProfile,
  fetchReadiness,
  fetchRoles,
  resetAdminPassword,
  resetAdminSecondFactor,
  revokeAdminSessions,
  setAdminRoles,
  setAdminStatus,
  setAdminTelegramBinding,
} from '../api/client';
import { formatTimestamp } from '../format';
import { t } from '../i18n/web.fa';
import { setQuery, type Route } from '../router';
import {
  Badge,
  Banner,
  Card,
  Copyable,
  DataTable,
  Drawer,
  Duration,
  Field,
  Ident,
  KV,
  Ltr,
  MaturityBadge,
  Modal,
  Num,
  PageHead,
  StatCard,
  StateSwitch,
  StatusDot,
  Tabs,
  TabPanel,
  useConfirmedClose,
  useToast,
  Quantity,
} from '../ui/kit';
import { Icon } from '../ui/icons';
import { formatNumber } from '../format';
import { pollUnlessFinal } from '../polling';
import { queryState } from '../view-state';
import { useSubmissionKey } from '../submission-key';
import { DiagnosticsSection } from './system-diagnostics';

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

const SECTIONS = ['status', 'diagnostics', 'monitor', 'admins', 'roles'] as const;
type Section = (typeof SECTIONS)[number];

function isSection(value: string | null): value is Section {
  return value !== null && (SECTIONS as readonly string[]).includes(value);
}

export function SystemPage({
  route,
  permissions,
}: {
  route: Route;
  permissions: readonly PermissionKey[];
}) {
  const requested = route.query.get('section');
  // The section is in the URL so a screen can be linked to and survives a
  // refresh — the same reason the routes themselves are paths rather than
  // component state.
  const section: Section = isSection(requested) ? requested : 'status';

  // The shell reads the same `['info']` once per session; this costs no request.
  const info = useQuery({ queryKey: ['info'], queryFn: fetchInfo });

  return (
    <>
      <PageHead
        title={t('web.system_title')}
        subtitle={
          <>
            {t('web.system_intro')}
            {info.data !== undefined && (
              <span className="system-build">
                <span>
                  {t('web.version')} <Ltr>{info.data.version}</Ltr>
                </span>
                <span>
                  {t('web.commit')} <Ltr>{info.data.commit.slice(0, 7)}</Ltr>
                </span>
                <span>
                  {t('web.environment')} <Ltr>{info.data.environment}</Ltr>
                </span>
              </span>
            )}
          </>
        }
      />

      <Tabs
        panelId="system-panel"
        value={section}
        onChange={(next) => {
          setQuery(route, 'section', next === 'status' ? null : next);
        }}
        items={[
          { id: 'status', label: t('web.system_tab_status') },
          { id: 'diagnostics', label: t('web.system_tab_diagnostics') },
          { id: 'monitor', label: t('web.system_tab_monitor') },
          { id: 'admins', label: t('web.system_tab_admins') },
          // Phase D3: roles, the permission matrix and the effective-permission preview.
          { id: 'roles', label: t('web.system_tab_roles') },
        ]}
      />

      <TabPanel id="system-panel" labelledBy={`system-panel-tab-${section}`}>
        {section === 'status' && <StatusSection />}
        {section === 'diagnostics' && (
          <DiagnosticsSection denied={!permissions.includes('opslog.view')} />
        )}
        {section === 'monitor' && <MonitorSection denied={!permissions.includes('panels.view')} />}
        {section === 'admins' && (
          <AdminsSection
            denied={!permissions.includes('admins.view')}
            mayEdit={permissions.includes('admins.edit')}
          />
        )}
        {section === 'roles' && (
          <RolesSection
            denied={!permissions.includes('admins.view')}
            mayEdit={permissions.includes('admins.permissions.edit')}
          />
        )}
      </TabPanel>

      <Card title={t('web.system_logs_title')} tone="muted">
        <Banner tone="info" title={t('web.system_logs_absent')}>
          {t('web.system_logs_body')}
        </Banner>
        <p className="muted small">
          <MaturityBadge value="now" /> {t('web.system_logs_destination')}
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
  const dependencies = readiness.data?.dependencies ?? [];
  const down = dependencies.filter((row) => row.status !== 'up').length;
  // The overall verdict is the SERVER's, not a count of red rows. A dependency the
  // service reports as `required: false` (Redis, today) can be down while the process
  // stays ready; only a down dependency that blocks readiness makes the answer
  // `degraded`, and a badge derived from the rows would call the system down while its
  // own readiness probe keeps serving traffic. An optional dependency down is said as a
  // warning on the same card, never as the verdict.
  const ready = readiness.data?.status === 'ok';
  const latencies = dependencies.flatMap((row) =>
    row.latencyMs === undefined ? [] : [row.latencyMs],
  );

  return (
    <>
      {readiness.data !== undefined && (
        <div className="stat-grid system-stats">
          <StatCard
            label={t('web.system_overall')}
            icon="activity"
            value={
              <StatusDot tone={!ready ? 'danger' : down === 0 ? 'ok' : 'warn'}>
                {ready ? t('web.system_overall_ok') : t('web.system_overall_down')}
              </StatusDot>
            }
            hint={`${formatNumber(dependencies.length - down)} ${t('web.templates_count_of')} ${formatNumber(dependencies.length)} ${t('web.system_dependencies_up')}`}
            {...(!ready ? { tone: 'alert' as const } : down > 0 ? { tone: 'warn' as const } : {})}
          />
          <StatCard
            label={t('web.system_slowest')}
            icon="clock"
            value={
              latencies.length === 0 ? (
                <span className="faint">—</span>
              ) : (
                <Num value={Math.max(...latencies)} />
              )
            }
            {...(latencies.length === 0 ? {} : { unit: 'ms' })}
          />
          <StatCard
            label={t('web.system_dependency_count')}
            icon="layers"
            value={<Num value={dependencies.length} />}
          />
        </div>
      )}

      <div className="two-col">
        <Card title={t('web.system_status')} hint={t('web.system_status_hint')}>
          <StateSwitch query={readiness}>
            <DataTable
              caption={t('web.system_status')}
              rows={dependencies}
              rowKey={(row) => row.name}
              dense
              columns={[
                {
                  key: 'name',
                  header: t('web.dependency'),
                  render: (row) => <Ltr>{row.name}</Ltr>,
                },
                {
                  key: 'status',
                  header: t('web.status'),
                  render: (row) => (
                    <Badge tone={row.status === 'up' ? 'ok' : 'danger'} dot>
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
                      <Quantity>
                        <Num value={row.latencyMs} /> ms
                      </Quantity>
                    ),
                },
                {
                  key: 'detail',
                  header: t('web.detail'),
                  wrap: true,
                  render: (row) => <span className="plain muted">{row.detail ?? '—'}</span>,
                },
              ]}
            />
          </StateSwitch>
        </Card>

        <Card title={t('web.build_info')}>
          <StateSwitch query={info}>
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
      </div>
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
/**
 * The installation capacity condition is written by the MONITOR on its own
 * cycle, and this response is the only Web Admin surface that can show it.
 * Without an interval the tab reported "within capacity" through an overload,
 * or a resolved alarm until navigation — `refetchOnWindowFocus` is off
 * globally, so returning to the tab did not help. Once a minute: slower than
 * the readiness card because the condition changes on the monitor's cadence,
 * not on every probe.
 */
const MONITOR_PROFILE_REFRESH_MS = 60_000;

function MonitorSection({ denied }: { denied: boolean }) {
  const monitor = useQuery({
    queryKey: ['monitor-profile'],
    queryFn: fetchMonitorProfile,
    enabled: !denied,
    refetchInterval: pollUnlessFinal(MONITOR_PROFILE_REFRESH_MS),
  });
  // The banner and the figure cards sit OUTSIDE the `StateSwitch`es below, so they are
  // held to the same answer those cards give: nothing when the actor may not see the
  // monitor (a revoked `panels.view` disables the query but keeps its cached profile),
  // and nothing when the query is in the state that draws an error instead of data.
  const profile = !denied && queryState(monitor) === 'ready' ? monitor.data?.monitor : undefined;

  return (
    <>
      {/*
        The installation's capacity condition reaches an operator nowhere else (see
        `CapacityView`), so when it is open it is said at the top of the tab as well as
        on its own row.
      */}
      {profile?.schedulerCapacityExceeded === true && (
        <Banner tone="danger" title={t('web.monitor_over_capacity_title')}>
          {t('web.monitor_over_capacity_body')}
        </Banner>
      )}

      {profile !== undefined && (
        <div className="stat-grid system-stats">
          <StatCard
            label={t('web.monitor_enabled')}
            icon="activity"
            value={
              <StatusDot tone={profile.enabled ? 'ok' : 'neutral'}>
                {profile.enabled ? t('web.enabled') : t('web.disabled')}
              </StatusDot>
            }
          />
          <StatCard
            label={t('web.monitor_tick')}
            icon="clock"
            value={<Duration ms={profile.tickMs} />}
          />
          <StatCard
            label={t('web.monitor_healthy_interval')}
            icon="refresh"
            value={<Duration ms={profile.healthyIntervalMs} />}
          />
          <StatCard
            label={t('web.monitor_freshness')}
            icon="shield"
            value={<Duration ms={profile.freshForMs} />}
          />
        </div>
      )}

      <div className="grid c2 system-monitor">
        <Card title={t('web.monitor_cadence')} hint={t('web.monitor_cadence_hint')}>
          <StateSwitch query={monitor} denied={denied}>
            {profile !== undefined && (
              <KV
                items={[
                  [
                    t('web.monitor_retryable_interval'),
                    <Duration key="r" ms={profile.retryableIntervalMs} />,
                  ],
                  [
                    t('web.monitor_nonretryable_interval'),
                    <Duration key="n" ms={profile.nonRetryableIntervalMs} />,
                  ],
                ]}
              />
            )}
          </StateSwitch>
        </Card>

        <Card title={t('web.monitor_capacity')} hint={t('web.monitor_capacity_hint')}>
          <StateSwitch query={monitor} denied={denied}>
            {profile !== undefined && <CapacityView profile={profile} />}
          </StateSwitch>
        </Card>
      </div>

      <Card title={t('web.monitor_separation')} hint={t('web.monitor_separation_hint')}>
        <ul className="system-separation">
          <li>
            <div className="system-separation-head">
              <span className="strong">{t('web.monitor_lightweight')}</span>
              <MaturityBadge value="now" />
            </div>
            <p className="muted small">{t('web.monitor_lightweight_body')}</p>
          </li>
          <li>
            <div className="system-separation-head">
              <span className="strong">{t('web.monitor_heavy')}</span>
              <MaturityBadge value="planned" />
            </div>
            <p className="muted small">{t('web.monitor_heavy_body')}</p>
          </li>
          <li>
            <div className="system-separation-head">
              <span className="strong">{t('web.monitor_user_sync')}</span>
              <MaturityBadge value="planned" />
            </div>
            <p className="muted small">{t('web.monitor_user_sync_body')}</p>
          </li>
        </ul>
      </Card>
    </>
  );
}

function CapacityView({ profile }: { profile: MonitorProfile }) {
  return (
    <div className="stack">
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
            <Quantity key="r">
              <Num value={profile.budgetReservePercent} />%
            </Quantity>,
          ],
          [t('web.monitor_batch'), <Num key="ba" value={profile.batchSize} />],
          [t('web.monitor_concurrency'), <Num key="c" value={profile.concurrency} />],
        ]}
      />
    </div>
  );
}

/**
 * The roster is written by OTHER surfaces — an owner suspending or re-enabling
 * an administrator, changing roles, creating one — and this tab showed the
 * roster it was drawn with until navigation: a suspended administrator kept
 * reading as active. Once a minute, the monitor profile's cadence.
 */
const ADMINS_REFRESH_MS = 60_000;

function AdminsSection({ denied, mayEdit }: { denied: boolean; mayEdit: boolean }) {
  const admins = useQuery({
    queryKey: ['admins'],
    queryFn: fetchAdmins,
    enabled: !denied,
    refetchInterval: pollUnlessFinal(ADMINS_REFRESH_MS),
  });
  const rows = admins.data?.admins ?? [];

  return (
    <Card
      title={t('web.administrators')}
      hint={t('web.administrators_hint')}
      {...(mayEdit ? { actions: <CreateAdmin /> } : {})}
    >
      <StateSwitch query={admins} denied={denied} isEmpty={rows.length === 0}>
        <DataTable
          caption={t('web.administrators')}
          rows={rows}
          rowKey={(row) => row.id}
          dense
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
                <Badge tone={row.status === 'ACTIVE' ? 'ok' : 'neutral'} dot>
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
              render: (row) =>
                row.roleKeys.length === 0 ? (
                  <span className="faint">—</span>
                ) : (
                  <span className="system-roles">
                    {row.roleKeys.map((key) => (
                      <Badge key={key} outline>
                        {key}
                      </Badge>
                    ))}
                  </span>
                ),
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
            {
              key: 'telegram',
              header: t('web.admin_telegram'),
              render: (row) => <TelegramBinding row={row} mayEdit={mayEdit} />,
            },
            {
              key: 'manage',
              header: t('web.admin_manage'),
              align: 'end',
              render: (row) => <AdminControls row={row} mayEdit={mayEdit} />,
            },
          ]}
        />
      </StateSwitch>
    </Card>
  );
}

/**
 * Creating an administrator, from the screen that lists them.
 *
 * The password leaves the browser once. Nothing reads it back — not this form
 * after submitting, not the roster, not the response — because there is nowhere
 * it could come back FROM: the server stores a hash and the projection carries
 * no credential field at all. The hint says so, so an operator knows to deliver
 * it out of band rather than looking for it here later.
 *
 * The role checkboxes come from `/roles`, which is the same catalogue the server
 * resolves against. Offering a hard-coded list would let this screen promise a
 * role an installation does not have.
 */
function CreateAdmin() {
  const notify = useToast();
  const queries = useQueryClient();
  const submission = useSubmissionKey();
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [roleKeys, setRoleKeys] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);

  const roles = useQuery({ queryKey: ['roles'], queryFn: fetchRoles, enabled: open });

  const mutate = useMutation({
    mutationFn: (input: {
      username: string;
      displayName: string;
      password: string;
      roleKeys: string[];
    }) =>
      /*
       * The key is SENT, not merely minted.
       *
       * It was computed here and thrown away, which made the submission-key
       * mechanism present in appearance only: `mutations.retry` re-sends a
       * write the server did not answer, and a create that committed then
       * came back as "that username is taken" — the operator told their new
       * administrator failed, for an account that exists holding the password
       * they just typed.
       *
       * The fingerprint deliberately excludes the password, matching what the
       * server hashes the key against: changing the credential on a held key
       * is the same command, and a different username is a new one.
       */
      createAdmin({
        ...input,
        idempotencyKey: submission.current({
          username: input.username,
          displayName: input.displayName,
          roleKeys: input.roleKeys,
        }),
      }),
    onSuccess: () => {
      submission.settle();
      setProblem(null);
      setOpen(false);
      setUsername('');
      setDisplayName('');
      // Cleared on success as well as on close: a password left in a detached
      // input is a password in the page for as long as the tab is open.
      setPassword('');
      setRoleKeys([]);
      notify({ tone: 'ok', message: t('web.admin_created_done') });
      void queries.invalidateQueries({ queryKey: ['admins'] });
    },
    onError: (error: unknown) => {
      submission.settleOn(error);
      setProblem(refusalText(error, t('web.admin_username_taken')));
    },
  });

  const ready =
    username.trim() !== '' &&
    displayName.trim() !== '' &&
    password.length >= 12 &&
    roleKeys.length > 0;

  const cancel = () => {
    setOpen(false);
    setPassword('');
    setProblem(null);
  };
  // Closing keeps the name, the display name and the roles, and clears the password — on
  // purpose, see `onSuccess`. So a close with a password typed loses it, and asks first.
  const { requestClose, dialog: discardQuestion } = useConfirmedClose(password !== '', cancel);

  return (
    <>
      <button type="button" className="btn primary sm" onClick={() => setOpen(true)}>
        <Icon name="userPlus" />
        {t('web.admin_add')}
      </button>
      <Drawer open={open} onClose={requestClose} title={t('web.admin_add_title')}>
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            mutate.mutate({
              username: username.trim(),
              displayName: displayName.trim(),
              password,
              roleKeys,
            });
          }}
        >
          <Banner tone="info">{t('web.admin_add_hint')}</Banner>
          <Field
            label={t('web.admin_username_label')}
            hint={t('web.admin_username_hint')}
            htmlFor="admin-new-username"
            {...(problem === null ? {} : { error: problem })}
          >
            <input
              id="admin-new-username"
              className="input"
              dir="ltr"
              autoComplete="off"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </Field>
          <Field label={t('web.admin_display_name_label')} htmlFor="admin-new-display">
            <input
              id="admin-new-display"
              className="input"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </Field>
          <Field
            label={t('web.admin_password_label')}
            hint={t('web.admin_password_hint')}
            htmlFor="admin-new-password"
          >
            <input
              id="admin-new-password"
              className="input"
              type="password"
              dir="ltr"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <Field label={t('web.admin_roles_label')} hint={t('web.admin_roles_hint')}>
            <RolePicker
              idPrefix="admin-new"
              available={roles.data?.roles ?? []}
              selected={roleKeys}
              onChange={setRoleKeys}
            />
          </Field>
          <div className="form-actions">
            <button type="submit" className="btn primary" disabled={mutate.isPending || !ready}>
              {t('web.admin_add')}
            </button>
            <button
              type="button"
              className="btn"
              disabled={mutate.isPending}
              onClick={requestClose}
            >
              {t('web.admin_telegram_cancel')}
            </button>
          </div>
        </form>
      </Drawer>
      {discardQuestion}
    </>
  );
}

/** The role catalogue as checkboxes. Shared by creation and by role editing. */
function RolePicker({
  idPrefix,
  available,
  selected,
  onChange,
}: {
  idPrefix: string;
  available: readonly { key: string; name: string }[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="stack">
      {available.map((role) => (
        <label key={role.key} htmlFor={`${idPrefix}-role-${role.key}`} className="checkbox">
          <input
            id={`${idPrefix}-role-${role.key}`}
            type="checkbox"
            checked={selected.includes(role.key)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...selected, role.key]
                  : selected.filter((key) => key !== role.key),
              )
            }
          />
          <span>{role.name}</span>
        </label>
      ))}
    </div>
  );
}

/**
 * Status, roles, live sessions and credential reset for ONE administrator.
 *
 * Behind a disclosure rather than four columns, because a roster is read far
 * more often than it is edited and four sets of controls per row turn a list
 * into a form. Every one of these already existed on the server and could not
 * be reached from here — which is the finding the audit for this package
 * records.
 *
 * A reason is required by the server on all three writes, so the field is one
 * field shared by them rather than three that disagree. The buttons are drawn
 * only for an actor who may edit; the guard still runs on the request, so this
 * stops promising what the server would refuse rather than deciding anything.
 */
/**
 * How often the open sessions panel re-reads.
 *
 * Faster than the roster's own poll because the question is sharper: an
 * operator watching this list is deciding whether somebody is still signed in,
 * and the answer changes on a sign-in rather than on an administrative edit.
 */
const SESSIONS_REFRESH_MS = 15_000;

function AdminControls({ row, mayEdit }: { row: AdminSummary; mayEdit: boolean }) {
  const notify = useToast();
  const queries = useQueryClient();
  const statusKey = useSubmissionKey();
  const rolesKey = useSubmissionKey();
  const passwordKey = useSubmissionKey();
  const revokeKey = useSubmissionKey();
  const secondFactorKey = useSubmissionKey();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  /*
   * DERIVED from the row until the operator touches it, not initialised from it.
   *
   * The roster polls, so `row.roleKeys` changes underneath a mounted panel when
   * another operator or the Telegram surface edits the same administrator. A
   * `useState` initialiser runs once, so the picker went on showing the roles as
   * they were when the panel opened — and `setRoles` sends the FULL set, so
   * saving from that stale picker silently reverted the other change.
   *
   * `edited` is what distinguishes "I have not touched this" from "I deliberately
   * unchecked everything", which the empty set above makes a real state.
   */
  const [edited, setEdited] = useState<readonly string[] | null>(null);
  const roleKeys = edited ?? row.roleKeys;
  const [newPassword, setNewPassword] = useState('');
  /*
   * The ACTING operator's own step-up (D2 review): a password reset or a 2FA removal is
   * half a takeover, so the server asks who is at the keyboard. Cleared on every settle,
   * success or failure, like the new password.
   */
  const [myPassword, setMyPassword] = useState('');
  const [myCode, setMyCode] = useState('');
  const stepUp = () => ({
    password: myPassword,
    ...(myCode.trim() === '' ? {} : { code: myCode.replace(/\s+/g, '') }),
  });
  const clearStepUp = () => {
    setMyPassword('');
    setMyCode('');
  };
  const [problem, setProblem] = useState<string | null>(null);

  const roles = useQuery({ queryKey: ['roles'], queryFn: fetchRoles, enabled: open && mayEdit });
  /*
   * Polled while the panel is open, and the reason is the panel's own claim.
   *
   * `refetchOnWindowFocus` is off globally, so without an interval this list is
   * whatever it was when the panel opened: a target who signs in afterwards
   * never appears, and one whose session expires never leaves. A screen whose
   * whole job is "who is signed in right now" cannot be a snapshot from minutes
   * ago.
   */
  const sessions = useQuery({
    queryKey: ['admin-sessions', row.id],
    queryFn: () => fetchAdminSessions(row.id),
    enabled: open,
    refetchInterval: open ? SESSIONS_REFRESH_MS : false,
  });

  const reasonGiven = reason.trim().length > 0;
  const fail = (error: unknown) => setProblem(refusalText(error, null));
  const replaceRow = (updated: AdminSummary) => {
    setProblem(null);
    queries.setQueryData(['admins'], (current: { admins: AdminSummary[] } | undefined) =>
      current === undefined
        ? current
        : { admins: current.admins.map((one) => (one.id === updated.id ? updated : one)) },
    );
  };

  const status = useMutation({
    mutationFn: (next: 'ACTIVE' | 'DISABLED') => {
      statusKey.current({ id: row.id, next, reason: reason.trim() });
      return setAdminStatus({ id: row.id, status: next, reason: reason.trim() });
    },
    onSuccess: (updated) => {
      statusKey.settle();
      replaceRow(updated);
      notify({ tone: 'ok', message: t('web.admin_status_done') });
    },
    onError: (error: unknown) => {
      statusKey.settleOn(error);
      fail(error);
    },
  });

  const rolesMutation = useMutation({
    mutationFn: () => {
      const next = [...roleKeys];
      rolesKey.current({ id: row.id, next, reason: reason.trim() });
      return setAdminRoles({ id: row.id, roleKeys: next, reason: reason.trim() });
    },
    onSuccess: (updated) => {
      rolesKey.settle();
      replaceRow(updated);
      notify({ tone: 'ok', message: t('web.admin_roles_done') });
    },
    onError: (error: unknown) => {
      rolesKey.settleOn(error);
      fail(error);
    },
  });

  const password = useMutation({
    // Never retried: the step-up spends a one-time code.
    retry: false,
    mutationFn: () => {
      passwordKey.current({ id: row.id, reason: reason.trim() });
      return resetAdminPassword({
        id: row.id,
        newPassword,
        reason: reason.trim(),
        stepUp: stepUp(),
      });
    },
    onSettled: clearStepUp,
    onSuccess: (result) => {
      passwordKey.settle();
      replaceRow(result.admin);
      // Cleared before the toast, so the value is out of state whatever the
      // operator does next.
      setNewPassword('');
      notify({
        tone: 'ok',
        message: t('web.admin_password_reset_done').replace(
          '{count}',
          String(result.sessionsRevoked),
        ),
      });
      void queries.invalidateQueries({ queryKey: ['admin-sessions', row.id] });
    },
    onError: (error: unknown) => {
      passwordKey.settleOn(error);
      fail(error);
    },
  });

  const revoke = useMutation({
    mutationFn: () => {
      revokeKey.current({ id: row.id, reason: reason.trim() });
      return revokeAdminSessions({ id: row.id, reason: reason.trim() });
    },
    onSuccess: (result) => {
      revokeKey.settle();
      setProblem(null);
      notify({
        tone: 'ok',
        message: t('web.admin_sessions_revoked_done').replace('{count}', String(result.revoked)),
      });
      void queries.invalidateQueries({ queryKey: ['admin-sessions', row.id] });
    },
    onError: (error: unknown) => {
      revokeKey.settleOn(error);
      fail(error);
    },
  });

  /*
   * Phase D2: removing ANOTHER administrator's two-step sign-in — their lost phone. The
   * server applies the password reset's bounds (not oneself, no more privilege than you
   * hold, an owner needs more) and ends every session the target holds.
   */
  const secondFactor = useMutation({
    // Not auto-retried, AND keyed (Codex review): a retry of a reset whose answer was
    // lost replays the first result instead of resetting again — which would report
    // "had no factor" and could remove one the target has since re-enrolled.
    retry: false,
    mutationFn: () =>
      resetAdminSecondFactor({
        id: row.id,
        reason: reason.trim(),
        stepUp: stepUp(),
        idempotencyKey: secondFactorKey.current({ id: row.id, reason: reason.trim() }),
      }),
    onSettled: clearStepUp,
    onSuccess: (result) => {
      secondFactorKey.settle();
      replaceRow(result.admin);
      notify({
        tone: 'ok',
        message: (result.hadSecondFactor
          ? t('web.admin_second_factor_reset_done')
          : t('web.admin_second_factor_reset_none')
        ).replace('{count}', String(result.sessionsRevoked)),
      });
      void queries.invalidateQueries({ queryKey: ['admin-sessions', row.id] });
    },
    onError: (error: unknown) => {
      secondFactorKey.settleOn(error);
      fail(error);
    },
  });

  const live = sessions.data?.sessions ?? [];
  const busy =
    status.isPending ||
    rolesMutation.isPending ||
    password.isPending ||
    revoke.isPending ||
    secondFactor.isPending;
  const close = () => {
    setOpen(false);
    setNewPassword('');
    clearStepUp();
    setProblem(null);
  };
  // The reason and the roles survive a close; the new password is cleared by it, so a
  // close with one typed asks first.
  const { requestClose, dialog: discardQuestion } = useConfirmedClose(
    newPassword !== '' || myPassword !== '',
    close,
  );

  return (
    <>
      <button type="button" className="btn ghost sm" onClick={() => setOpen(true)}>
        {t('web.admin_manage')}
      </button>
      <Drawer
        open={open}
        onClose={requestClose}
        wide
        title={<Ident name={row.displayName} id={row.username} />}
      >
        <div className="stack">
          {problem !== null && (
            <Banner tone="danger" title={t('web.admin_manage')}>
              {problem}
            </Banner>
          )}

          {/* The sessions panel is a READ and is shown to anybody who may see this
          screen at all — `admins.view` is what the route charges. */}
          <div className="stack">
            <strong>{t('web.admin_sessions')}</strong>
            {/* Through `StateSwitch` rather than a bare `length === 0`, so a read
            that was REFUSED or failed renders as what it was. Printing "no
            live sessions" for an answer we never got is the kind of quiet
            untruth an operator would act on. */}
            <StateSwitch
              query={sessions}
              isEmpty={live.length === 0}
              empty={<span className="faint">{t('web.admin_sessions_empty')}</span>}
            >
              {live.map((session) => (
                <div key={session.id} className="system-session">
                  {session.current && (
                    <Badge tone="ok" dot>
                      {t('web.admin_sessions_current')}
                    </Badge>
                  )}
                  <KV items={sessionRows(session)} />
                </div>
              ))}
            </StateSwitch>
          </div>

          {mayEdit && (
            <>
              <Field
                label={t('web.admin_reason_label')}
                hint={t('web.admin_reason_hint')}
                htmlFor={`admin-reason-${row.id}`}
              >
                <input
                  id={`admin-reason-${row.id}`}
                  className="input"
                  value={reason}
                  maxLength={500}
                  onChange={(event) => setReason(event.target.value)}
                />
              </Field>

              <div className="toolbar">
                <button
                  type="button"
                  className={row.status === 'ACTIVE' ? 'btn danger sm' : 'btn primary sm'}
                  disabled={busy || !reasonGiven}
                  onClick={() => status.mutate(row.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE')}
                >
                  {row.status === 'ACTIVE' ? t('web.admin_disable') : t('web.admin_enable')}
                </button>
                <button
                  type="button"
                  className="btn danger sm"
                  /*
                   * NOT gated on the listing at all any more.
                   *
                   * Gating on "we know there is nothing to revoke" sounds careful
                   * and is a trap: a cached empty result keeps the button disabled
                   * after the target signs in, and the operator is locked out of
                   * the action by a fact that stopped being true. Revoking when
                   * there is nothing to revoke is safe and answers zero, so the
                   * server is the right place to find that out.
                   */
                  disabled={busy || !reasonGiven}
                  onClick={() => revoke.mutate()}
                >
                  {t('web.admin_sessions_revoke')}
                </button>
              </div>

              <Field label={t('web.admin_roles_label')} hint={t('web.admin_roles_hint')}>
                <RolePicker
                  idPrefix={`admin-${row.id}`}
                  available={roles.data?.roles ?? []}
                  selected={roleKeys}
                  onChange={setEdited}
                />
              </Field>
              <div className="toolbar">
                <button
                  type="button"
                  className="btn sm"
                  /*
                   * NOT gated on a non-empty set. `setAdminRolesRequestSchema`
                   * accepts an empty array and the domain supports an
                   * administrator with none — parking an account without
                   * disabling it. Requiring one here made the last role
                   * unremovable, which is the advertised operation refused by the
                   * button rather than by the server. Creation is the arm that
                   * genuinely needs a role, and it keeps the requirement.
                   */
                  disabled={busy || !reasonGiven}
                  onClick={() => rolesMutation.mutate()}
                >
                  {t('web.admin_roles_save')}
                </button>
              </div>

              <Banner tone="info" title={t('web.admin_step_up_title')}>
                {t('web.admin_step_up_hint')}
              </Banner>
              <Field label={t('web.admin_step_up_password')} htmlFor={`admin-stepup-${row.id}`}>
                <input
                  id={`admin-stepup-${row.id}`}
                  className="input"
                  type="password"
                  dir="ltr"
                  autoComplete="current-password"
                  value={myPassword}
                  onChange={(event) => setMyPassword(event.target.value)}
                />
              </Field>
              <Field
                label={t('web.admin_step_up_code')}
                hint={t('web.admin_step_up_code_hint')}
                htmlFor={`admin-stepup-code-${row.id}`}
              >
                <input
                  id={`admin-stepup-code-${row.id}`}
                  className="input"
                  dir="ltr"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={8}
                  value={myCode}
                  onChange={(event) => setMyCode(event.target.value)}
                />
              </Field>

              <Banner tone="warn" title={t('web.admin_password_reset_title')}>
                {t('web.admin_password_reset_hint')}
              </Banner>
              <Field label={t('web.admin_new_password_label')} htmlFor={`admin-password-${row.id}`}>
                <input
                  id={`admin-password-${row.id}`}
                  className="input"
                  type="password"
                  dir="ltr"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                />
              </Field>
              <div className="toolbar">
                <button
                  type="button"
                  className="btn danger sm"
                  disabled={busy || !reasonGiven || newPassword.length < 12 || myPassword === ''}
                  onClick={() => password.mutate()}
                >
                  {t('web.admin_password_reset')}
                </button>
              </div>

              <Banner tone="warn" title={t('web.admin_second_factor_reset_title')}>
                {t('web.admin_second_factor_reset_hint')}
              </Banner>
              <div className="toolbar">
                <button
                  type="button"
                  className="btn danger sm"
                  disabled={busy || !reasonGiven || myPassword === ''}
                  onClick={() => secondFactor.mutate()}
                >
                  {t('web.admin_second_factor_reset')}
                </button>
              </div>
            </>
          )}

          <div className="toolbar">
            <button type="button" className="btn sm" disabled={busy} onClick={requestClose}>
              {t('web.admin_manage_close')}
            </button>
          </div>
        </div>
      </Drawer>
      {discardQuestion}
    </>
  );
}

/**
 * One live session, as rows.
 *
 * Every value here is a column the session ROW actually holds. No device name,
 * no browser name, no location: deriving any of those from a `User-Agent` or an
 * IP would be a guess presented to an operator as a fact, and an operator
 * deciding whether a session is theirs is exactly who must not be guessed at.
 * The user agent is shown verbatim for the same reason — it is what was sent.
 * The session TOKEN never reaches this surface; the projection behind it does
 * not select `token_hash` at all.
 */
function sessionRows(session: AdminSessionSummary): [ReactNode, ReactNode][] {
  const rows: [ReactNode, ReactNode][] = [
    [t('web.admin_session_last_seen'), formatTimestamp(session.lastSeenAt)],
    [t('web.admin_session_issued'), formatTimestamp(session.issuedAt)],
    [t('web.admin_session_expires'), formatTimestamp(session.expiresAt)],
  ];
  if (session.ip !== null) {
    rows.push([t('web.admin_session_ip'), <Ltr key="ip">{session.ip}</Ltr>]);
  }
  if (session.userAgent !== null) {
    rows.push([
      t('web.admin_session_agent'),
      <Ltr key="ua">
        <span className="plain">{session.userAgent}</span>
      </Ltr>,
    ]);
  }
  return rows;
}

/**
 * The server's refusal, in this product's words where it has any.
 *
 * Three identity refusals have a sentence an operator can act on; everything
 * else falls back to the server's own message rather than a guess. `fallback`
 * covers the one code whose meaning depends on which form raised it.
 */
function refusalText(error: unknown, fallback: string | null): string {
  if (error instanceof ApiError) {
    if (error.code === IDENTITY_ERROR_CODES.ADMIN_SELF_MODIFICATION) {
      return t('web.admin_self_modification');
    }
    if (error.code === IDENTITY_ERROR_CODES.ADMIN_PRIVILEGE_ESCALATION) {
      return t('web.admin_privilege_escalation');
    }
    if (error.code === IDENTITY_ERROR_CODES.ADMIN_LAST_OWNER) {
      return t('web.admin_last_owner');
    }
    if (error.code === IDENTITY_ERROR_CODES.AUTH_STEP_UP_FAILED) return t('web.step_up_failed');
    if (error.code === IDENTITY_ERROR_CODES.AUTH_STEP_UP_FACTOR_REQUIRED) {
      return t('web.step_up_factor_required');
    }
    if (fallback !== null && error.code === IDENTITY_ERROR_CODES.ADMIN_USERNAME_TAKEN) {
      return fallback;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * One administrator's Telegram binding: the numeric id or "not connected", and
 * — for an actor holding `admins.edit` — connect, replace and remove.
 *
 * This exists because an installation can already hold an owner with no
 * binding (v0.2.5 created them that way), and the only other way to bind an
 * administrator, the bot's `/link`, has to be sent by an administrator who is
 * already bound. Without this cell such an installation's first Telegram
 * administrator could only be made by editing the database.
 *
 * The buttons are drawn only for an actor who may edit, and the guard still
 * runs on the request: the surface stops promising what the server would
 * refuse, it does not decide. Binding the OWNER additionally takes
 * `admins.permissions.edit` server-side, and that refusal is rendered as the
 * server's own message rather than predicted here.
 */
function TelegramBinding({ row, mayEdit }: { row: AdminSummary; mayEdit: boolean }) {
  const notify = useToast();
  const queries = useQueryClient();
  const submission = useSubmissionKey();
  const [editing, setEditing] = useState(false);
  const [telegramUserId, setTelegramUserId] = useState('');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const mutate = useMutation({
    mutationFn: (input: { telegramUserId: string | null; reason: string }) => {
      // The payload fingerprints the held key, so editing the id and pressing
      // again is a NEW command rather than a replay — see `useSubmissionKey`.
      submission.current({ id: row.id, ...input });
      return setAdminTelegramBinding({ id: row.id, ...input });
    },
    onSuccess: (updated, variables) => {
      submission.settle();
      setProblem(null);
      setEditing(false);
      setTelegramUserId('');
      setReason('');
      notify({
        tone: 'ok',
        message:
          variables.telegramUserId === null
            ? t('web.admin_telegram_removed_done')
            : t('web.admin_telegram_connected_done'),
      });
      // The server's own row, written into the roster it came from: the next
      // resolver turn already sees it, and so does this table.
      queries.setQueryData(['admins'], (current: { admins: AdminSummary[] } | undefined) =>
        current === undefined
          ? current
          : { admins: current.admins.map((one) => (one.id === updated.id ? updated : one)) },
      );
    },
    onError: (error: unknown) => {
      submission.settleOn(error);
      if (
        error instanceof ApiError &&
        error.code === IDENTITY_ERROR_CODES.ADMIN_TELEGRAM_ID_TAKEN
      ) {
        setProblem(t('web.admin_telegram_id_taken'));
      } else {
        setProblem(error instanceof Error ? error.message : String(error));
      }
    },
  });

  const bound = row.telegramUserId !== null;
  // The same shape the contract's `telegramUserIdSchema` refuses server-side,
  // checked here so the operator is told before a round trip — never instead
  // of the server's own check.
  const idLooksValid = /^[1-9][0-9]{0,18}$/.test(telegramUserId.trim());
  const reasonGiven = reason.trim().length > 0;

  return (
    <div className="system-telegram">
      {bound ? (
        <Ltr>
          <code>{row.telegramUserId}</code>
        </Ltr>
      ) : (
        <span className="faint">{t('web.admin_telegram_not_connected')}</span>
      )}
      {mayEdit && !editing && (
        <button
          type="button"
          className="link small"
          onClick={() => {
            setProblem(null);
            setEditing(true);
          }}
        >
          {bound ? t('web.admin_telegram_edit') : t('web.admin_telegram_connect')}
        </button>
      )}
      <Modal
        open={mayEdit && editing}
        onClose={() => {
          setEditing(false);
          setProblem(null);
        }}
        title={
          <>
            {t('web.admin_telegram')} — {row.displayName}
          </>
        }
      >
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (!idLooksValid) {
              setProblem(t('web.admin_telegram_id_invalid'));
              return;
            }
            mutate.mutate({ telegramUserId: telegramUserId.trim(), reason: reason.trim() });
          }}
        >
          <Field
            label={t('web.admin_telegram_id_label')}
            hint={t('web.admin_telegram_id_hint')}
            htmlFor={`admin-telegram-id-${row.id}`}
            {...(problem === null ? {} : { error: problem })}
          >
            <input
              id={`admin-telegram-id-${row.id}`}
              className="input"
              dir="ltr"
              inputMode="numeric"
              autoComplete="off"
              value={telegramUserId}
              onChange={(event) => setTelegramUserId(event.target.value)}
            />
          </Field>
          <Field
            label={t('web.admin_telegram_reason_label')}
            hint={t('web.admin_telegram_reason_hint')}
            htmlFor={`admin-telegram-reason-${row.id}`}
          >
            <input
              id={`admin-telegram-reason-${row.id}`}
              className="input"
              value={reason}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
          <div className="toolbar">
            <button
              type="submit"
              className="btn primary sm"
              disabled={mutate.isPending || !reasonGiven || telegramUserId.trim() === ''}
            >
              {bound ? t('web.admin_telegram_replace') : t('web.admin_telegram_connect')}
            </button>
            {bound && (
              <button
                type="button"
                className="btn danger sm"
                disabled={mutate.isPending || !reasonGiven}
                onClick={() => mutate.mutate({ telegramUserId: null, reason: reason.trim() })}
              >
                {t('web.admin_telegram_remove')}
              </button>
            )}
            <button
              type="button"
              className="btn sm"
              disabled={mutate.isPending}
              onClick={() => {
                setEditing(false);
                setProblem(null);
              }}
            >
              {t('web.admin_telegram_cancel')}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
