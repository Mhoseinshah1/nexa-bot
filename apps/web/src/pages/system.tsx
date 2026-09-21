import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import {
  IDENTITY_ERROR_CODES,
  type AdminSessionSummary,
  type AdminSummary,
  type MonitorProfile,
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
  Duration,
  Field,
  Ident,
  KV,
  Ltr,
  MaturityBadge,
  Num,
  PageHead,
  StateSwitch,
  Tabs,
  TabPanel,
  useToast,
} from '../ui/kit';
import { pollUnlessFinal } from '../polling';
import { useSubmissionKey } from '../submission-key';

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
        {section === 'admins' && (
          <AdminsSection
            denied={!permissions.includes('admins.view')}
            mayEdit={permissions.includes('admins.edit')}
          />
        )}
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
        <StateSwitch query={readiness}>
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
  const profile = monitor.data?.monitor;

  return (
    <>
      <Card title={t('web.monitor_cadence')} hint={t('web.monitor_cadence_hint')}>
        <StateSwitch query={monitor} denied={denied}>
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
        <StateSwitch query={monitor} denied={denied}>
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
    <Card title={t('web.administrators')} hint={t('web.administrators_hint')}>
      {mayEdit && <CreateAdmin />}
      <StateSwitch query={admins} denied={denied} isEmpty={rows.length === 0}>
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
            {
              key: 'telegram',
              header: t('web.admin_telegram'),
              render: (row) => <TelegramBinding row={row} mayEdit={mayEdit} />,
            },
            {
              key: 'manage',
              header: t('web.admin_manage'),
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
    }) => {
      submission.current(input);
      return createAdmin(input);
    },
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

  if (!open) {
    return (
      <div className="toolbar">
        <button type="button" className="btn sm" onClick={() => setOpen(true)}>
          {t('web.admin_add')}
        </button>
      </div>
    );
  }

  const ready =
    username.trim() !== '' &&
    displayName.trim() !== '' &&
    password.length >= 12 &&
    roleKeys.length > 0;

  return (
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
      <Banner tone="info" title={t('web.admin_add_title')}>
        {t('web.admin_add_hint')}
      </Banner>
      <Field
        label={t('web.admin_username_label')}
        hint={t('web.admin_username_hint')}
        htmlFor="admin-new-username"
        {...(problem === null ? {} : { error: problem })}
      >
        <input
          id="admin-new-username"
          dir="ltr"
          autoComplete="off"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
      </Field>
      <Field label={t('web.admin_display_name_label')} htmlFor="admin-new-display">
        <input
          id="admin-new-display"
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
      <div className="toolbar">
        <button type="submit" className="btn primary sm" disabled={mutate.isPending || !ready}>
          {t('web.admin_add')}
        </button>
        <button
          type="button"
          className="btn sm"
          disabled={mutate.isPending}
          onClick={() => {
            setOpen(false);
            setPassword('');
            setProblem(null);
          }}
        >
          {t('web.admin_telegram_cancel')}
        </button>
      </div>
    </form>
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
function AdminControls({ row, mayEdit }: { row: AdminSummary; mayEdit: boolean }) {
  const notify = useToast();
  const queries = useQueryClient();
  const statusKey = useSubmissionKey();
  const rolesKey = useSubmissionKey();
  const passwordKey = useSubmissionKey();
  const revokeKey = useSubmissionKey();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [roleKeys, setRoleKeys] = useState<readonly string[]>(row.roleKeys);
  const [newPassword, setNewPassword] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const roles = useQuery({ queryKey: ['roles'], queryFn: fetchRoles, enabled: open && mayEdit });
  const sessions = useQuery({
    queryKey: ['admin-sessions', row.id],
    queryFn: () => fetchAdminSessions(row.id),
    enabled: open,
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
    mutationFn: () => {
      passwordKey.current({ id: row.id, reason: reason.trim() });
      return resetAdminPassword({ id: row.id, newPassword, reason: reason.trim() });
    },
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

  if (!open) {
    return (
      <div className="toolbar">
        <button type="button" className="btn sm" onClick={() => setOpen(true)}>
          {t('web.admin_manage')}
        </button>
      </div>
    );
  }

  const live = sessions.data?.sessions ?? [];
  const busy =
    status.isPending || rolesMutation.isPending || password.isPending || revoke.isPending;

  return (
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
            <div key={session.id} className="stack">
              {session.current && <Badge tone="ok">{t('web.admin_sessions_current')}</Badge>}
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
              // Disabled only when we KNOW there is nothing to revoke. If the
              // listing failed we do not know, and revoking blind is safe.
              disabled={busy || !reasonGiven || (sessions.isSuccess && live.length === 0)}
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
              onChange={setRoleKeys}
            />
          </Field>
          <div className="toolbar">
            <button
              type="button"
              className="btn sm"
              disabled={busy || !reasonGiven || roleKeys.length === 0}
              onClick={() => rolesMutation.mutate()}
            >
              {t('web.admin_roles_save')}
            </button>
          </div>

          <Banner tone="warn" title={t('web.admin_password_reset_title')}>
            {t('web.admin_password_reset_hint')}
          </Banner>
          <Field label={t('web.admin_new_password_label')} htmlFor={`admin-password-${row.id}`}>
            <input
              id={`admin-password-${row.id}`}
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
              disabled={busy || !reasonGiven || newPassword.length < 12}
              onClick={() => password.mutate()}
            >
              {t('web.admin_password_reset')}
            </button>
          </div>
        </>
      )}

      <div className="toolbar">
        <button
          type="button"
          className="btn sm"
          disabled={busy}
          onClick={() => {
            setOpen(false);
            setNewPassword('');
            setProblem(null);
          }}
        >
          {t('web.admin_manage_close')}
        </button>
      </div>
    </div>
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
    <div className="stack">
      {bound ? (
        <Ltr>
          <code>{row.telegramUserId}</code>
        </Ltr>
      ) : (
        <span className="faint">{t('web.admin_telegram_not_connected')}</span>
      )}
      {mayEdit && !editing && (
        <div className="toolbar">
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              setProblem(null);
              setEditing(true);
            }}
          >
            {bound ? t('web.admin_telegram_edit') : t('web.admin_telegram_connect')}
          </button>
        </div>
      )}
      {mayEdit && editing && (
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
      )}
    </div>
  );
}
