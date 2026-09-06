import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PANEL_HEALTH_FRESH_FOR_MS,
  PROVIDER_CAPABILITIES,
  PROVIDER_FAILURE_RETRYABLE,
  type PanelStatus,
  type PanelSummaryResponse,
  type ProviderCapability,
  type ProviderType,
} from '@nexa/contracts';
import {
  createPanel,
  fetchPanel,
  fetchPanels,
  fetchProviders,
  setPanelCredentials,
  setPanelStatus,
  testPanel,
  updatePanel,
} from '../api/client';
import { formatTimestamp, splitDuration } from '../format';
import { useSubmissionKey } from '../submission-key';
import { t, type WebKey } from '../i18n/web.fa';
import { navigate, useLinkHandler } from '../router';
import { messageFor } from './settings';
import { HEALTH_TONES, queryState } from './dashboard';
import {
  Badge,
  Banner,
  Card,
  Copyable,
  CursorPager,
  DataTable,
  Empty,
  Field,
  KV,
  Ltr,
  MaturityBadge,
  Num,
  PageHead,
  Secret,
  StateSwitch,
  Tabs,
  useToast,
  type Column,
  type Tone,
} from '../ui/kit';

/**
 * Panels — the one product surface this release genuinely operates.
 *
 * Owner revision 19 removes the Location column, and it is removed by
 * construction rather than by deletion: `panelSummarySchema` has no location
 * field, no user count, no load figure and no sales figure. Every column below
 * renders something the server actually sent. The preview's panel list carried
 * "بار / کاربران" and "فروش" columns marked Phase 4, which is one label away
 * from being read as real telemetry.
 */

const HEALTH_LABELS: Readonly<Record<string, WebKey>> = {
  HEALTHY: 'web.health_healthy',
  DEGRADED: 'web.health_degraded',
  UNREACHABLE: 'web.health_unreachable',
  AUTH_FAILED: 'web.health_auth_failed',
  DISABLED: 'web.health_disabled',
  UNCHECKED: 'web.health_unchecked',
};

const STATUS_LABELS: Readonly<Record<PanelStatus, WebKey>> = {
  ACTIVE: 'web.panel_status_active',
  DISABLED: 'web.panel_status_disabled',
  ARCHIVED: 'web.panel_status_archived',
};

const STATUS_TONES: Readonly<Record<PanelStatus, Tone>> = {
  ACTIVE: 'ok',
  DISABLED: 'neutral',
  ARCHIVED: 'neutral',
};

function HealthBadge({ panel }: { panel: PanelSummaryResponse }) {
  const state = panel.health.state;
  return (
    <span className="nowrap">
      <Badge tone={HEALTH_TONES[state] ?? 'neutral'}>
        {t(HEALTH_LABELS[state] ?? 'web.health_unchecked')}
      </Badge>
      {/* Staleness is computed by the SERVER against one constant, and shown
          as its own fact rather than folded into the state. A stale HEALTHY is
          not the same claim as a fresh one, and the legacy statistics screen
          counting CONFIGURED panels as "connected" is the same mistake. */}
      {panel.health.stale && (
        <>
          {' '}
          <Badge tone="warn" title={t('web.health_stale_hint')}>
            {t('web.health_stale')}
          </Badge>
        </>
      )}
    </span>
  );
}

function FailureBadge({ failure }: { failure: string | null }) {
  if (failure === null) return <span className="faint">—</span>;
  const retryable = PROVIDER_FAILURE_RETRYABLE[failure as keyof typeof PROVIDER_FAILURE_RETRYABLE];
  return (
    <Badge
      tone={retryable === true ? 'warn' : 'danger'}
      title={retryable === true ? t('web.failure_retryable') : t('web.failure_permanent')}
    >
      <Ltr>{failure}</Ltr>
    </Badge>
  );
}

export function PanelsPage({ mayEdit, denied }: { mayEdit: boolean; denied: boolean }) {
  const onLink = useLinkHandler();
  /**
   * The cursor stack. Keyset paging goes forward on its own and can only go
   * back to a cursor it has already held, so each page's starting cursor is
   * pushed and popped rather than recomputed.
   */
  const [trail, setTrail] = useState<readonly string[]>([]);
  const cursor = trail.length > 0 ? trail[trail.length - 1] : undefined;

  const panels = useQuery({
    queryKey: ['panels', cursor ?? null],
    queryFn: () => fetchPanels(cursor === undefined ? {} : { cursor }),
    enabled: !denied,
  });

  const rows = panels.data?.panels ?? [];
  const nextCursor = panels.data?.nextCursor ?? null;

  const columns: readonly Column<PanelSummaryResponse>[] = [
    {
      key: 'name',
      header: t('web.panel_name'),
      render: (row) => (
        <a href={`/panels/${encodeURIComponent(row.id)}`} onClick={onLink} className="strong">
          {row.name}
        </a>
      ),
    },
    {
      key: 'provider',
      header: t('web.panel_provider'),
      render: (row) => <span className="nowrap">{row.providerName}</span>,
    },
    {
      key: 'health',
      header: t('web.panel_health'),
      render: (row) => <HealthBadge panel={row} />,
    },
    {
      key: 'failure',
      header: t('web.panel_failure'),
      render: (row) => <FailureBadge failure={row.health.failure} />,
    },
    {
      key: 'checked',
      header: t('web.panel_last_check'),
      render: (row) =>
        row.health.checkedAt === null ? (
          <span className="faint">—</span>
        ) : (
          <span className="nowrap">{formatTimestamp(row.health.checkedAt)}</span>
        ),
    },
    {
      key: 'latency',
      header: t('web.panel_latency'),
      align: 'end',
      render: (row) =>
        row.health.latencyMs === null ? (
          <span className="faint">—</span>
        ) : (
          <Ltr mono={false}>
            <Num value={row.health.latencyMs} /> ms
          </Ltr>
        ),
    },
    {
      key: 'status',
      header: t('web.status'),
      render: (row) => (
        <Badge tone={STATUS_TONES[row.status]}>{t(STATUS_LABELS[row.status])}</Badge>
      ),
    },
  ];

  return (
    <>
      <PageHead
        title={t('web.panels_title')}
        subtitle={t('web.panels_intro')}
        maturity="now"
        actions={
          mayEdit ? (
            <a className="btn primary sm" href="/panels/new" onClick={onLink}>
              {t('web.panel_new')}
            </a>
          ) : undefined
        }
      />

      <Card>
        <StateSwitch
          state={denied ? 'denied' : queryState(panels, rows.length === 0)}
          onRetry={() => void panels.refetch()}
          empty={
            <Empty title={t('web.panels_empty')} hint={t('web.panels_empty_hint')} icon="panels" />
          }
        >
          <DataTable
            caption={t('web.panels_title')}
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
          />
        </StateSwitch>

        <CursorPager
          shown={rows.length}
          hasPrevious={trail.length > 0}
          hasNext={nextCursor !== null}
          onPrevious={() => setTrail((current) => current.slice(0, -1))}
          onNext={() => nextCursor !== null && setTrail((current) => [...current, nextCursor])}
        />
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

type DetailTab = 'overview' | 'health' | 'credentials' | 'capabilities';

export function PanelDetailPage({
  id,
  mayEdit,
  mayRotate,
  denied,
}: {
  id: string;
  mayEdit: boolean;
  mayRotate: boolean;
  denied: boolean;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState<DetailTab>('overview');

  const panel = useQuery({
    queryKey: ['panel', id],
    queryFn: () => fetchPanel(id),
    enabled: !denied,
  });

  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ['panel', id] });
    await client.invalidateQueries({ queryKey: ['panels'] });
  };

  const testSubmission = useSubmissionKey();
  const test = useMutation({
    mutationFn: (idempotencyKey: string) => testPanel({ id, idempotencyKey }),
    onSuccess: async (result) => {
      testSubmission.settle();
      // `probed: false` means the stored health came back WITHOUT a new probe —
      // a replay under the same key, or a probe of this configuration recently
      // enough that repeating it would be a way to hammer the provider. Saying
      // "tested" for that is the legacy "✅ updated" for a write that did
      // nothing.
      toast({
        tone: result.probed ? 'ok' : 'info',
        message: result.probed ? t('web.panel_tested') : t('web.panel_test_replayed'),
      });
      await refresh();
    },
    onError: (error: unknown) => {
      testSubmission.settleOn(error);
      toast({ tone: 'danger', message: messageFor(error) });
    },
  });

  const data = panel.data?.panel;

  return (
    <>
      <PageHead
        title={data?.name ?? t('web.panel_detail')}
        {...(data === undefined ? {} : { subtitle: data.providerName })}
        maturity="now"
        actions={
          data === undefined || data.status === 'ARCHIVED' ? undefined : (
            <button
              type="button"
              className="btn sm"
              disabled={test.isPending}
              onClick={() => test.mutate(testSubmission.current({ command: 'panels.test', id }))}
            >
              {test.isPending ? t('web.working') : t('web.panel_test')}
            </button>
          )
        }
      />

      <StateSwitch
        state={denied ? 'denied' : queryState(panel)}
        onRetry={() => void panel.refetch()}
      >
        {data !== undefined && (
          <>
            <Tabs
              value={tab}
              onChange={setTab}
              items={[
                { id: 'overview', label: t('web.panel_tab_overview') },
                { id: 'health', label: t('web.panel_tab_health') },
                { id: 'credentials', label: t('web.panel_tab_credentials') },
                { id: 'capabilities', label: t('web.panel_tab_capabilities') },
              ]}
            />

            {tab === 'overview' && <OverviewTab panel={data} mayEdit={mayEdit} />}
            {tab === 'health' && <HealthTab panel={data} />}
            {tab === 'credentials' && (
              <CredentialsTab panel={data} mayRotate={mayRotate} onDone={refresh} />
            )}
            {tab === 'capabilities' && <CapabilitiesTab panel={data} />}
          </>
        )}
      </StateSwitch>
    </>
  );
}

function OverviewTab({ panel, mayEdit }: { panel: PanelSummaryResponse; mayEdit: boolean }) {
  const client = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(panel.name);
  const [baseUrl, setBaseUrl] = useState(panel.baseUrl);
  const submission = useSubmissionKey();
  const statusSubmission = useSubmissionKey();

  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ['panel', panel.id] });
    await client.invalidateQueries({ queryKey: ['panels'] });
  };

  const save = useMutation({
    // The whole command is the variable, so a retry carries the payload its
    // key was minted for rather than whatever the fields hold 500 ms later.
    mutationFn: (command: { idempotencyKey: string; name: string; baseUrl: string }) =>
      updatePanel({ id: panel.id, ...command }),
    onSuccess: async () => {
      submission.settle();
      toast({ tone: 'ok', message: t('web.saved') });
      await refresh();
    },
    onError: (error: unknown) => {
      submission.settleOn(error);
      toast({ tone: 'danger', message: messageFor(error) });
    },
  });

  const status = useMutation({
    mutationFn: (command: { idempotencyKey: string; status: PanelStatus }) =>
      setPanelStatus({ id: panel.id, ...command }),
    onSuccess: async () => {
      statusSubmission.settle();
      toast({ tone: 'ok', message: t('web.saved') });
      await refresh();
    },
    onError: (error: unknown) => {
      statusSubmission.settleOn(error);
      toast({ tone: 'danger', message: messageFor(error) });
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const command = { name, baseUrl };
    save.mutate({ ...command, idempotencyKey: submission.current(command) });
  };

  return (
    <>
      <Card title={t('web.panel_identity')}>
        <KV
          items={[
            [t('web.panel_id'), <Copyable key="id" value={panel.id} />],
            [
              t('web.panel_provider'),
              <span key="p" className="nowrap">
                {panel.providerName} <Ltr>({panel.providerType})</Ltr>
              </span>,
            ],
            [
              t('web.status'),
              <Badge key="s" tone={STATUS_TONES[panel.status]}>
                {t(STATUS_LABELS[panel.status])}
              </Badge>,
            ],
            [t('web.panel_created'), formatTimestamp(panel.createdAt)],
            [t('web.updated_at'), formatTimestamp(panel.updatedAt)],
          ]}
        />
      </Card>

      <Card title={t('web.panel_configuration')} hint={t('web.panel_configuration_hint')}>
        <form onSubmit={onSubmit} className="form-grid">
          <Field label={t('web.panel_name')} htmlFor={`name-${panel.id}`}>
            <input
              id={`name-${panel.id}`}
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={!mayEdit}
            />
          </Field>
          <Field
            label={t('web.panel_base_url')}
            hint={t('web.panel_base_url_hint')}
            htmlFor={`url-${panel.id}`}
          >
            <input
              id={`url-${panel.id}`}
              className="input ltr mono"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              disabled={!mayEdit}
            />
          </Field>
          {/* The provider type is deliberately not editable. Changing it would
              reinterpret the stored credentials against a different protocol;
              the API does not accept it either. */}
          {mayEdit && (
            <div>
              <button type="submit" className="btn primary" disabled={save.isPending}>
                {save.isPending ? t('web.saving') : t('web.save')}
              </button>
            </div>
          )}
        </form>
      </Card>

      {mayEdit && panel.status !== 'ARCHIVED' && (
        <Card title={t('web.panel_lifecycle')} hint={t('web.panel_lifecycle_hint')}>
          <div className="btn-group">
            {panel.status === 'ACTIVE' && (
              <button
                type="button"
                className="btn"
                disabled={status.isPending}
                onClick={() => {
                  const command = { status: 'DISABLED' as PanelStatus };
                  status.mutate({
                    ...command,
                    idempotencyKey: statusSubmission.current(command),
                  });
                }}
              >
                {t('web.panel_disable')}
              </button>
            )}
            {panel.status === 'DISABLED' && (
              <button
                type="button"
                className="btn"
                disabled={status.isPending}
                onClick={() => {
                  const command = { status: 'ACTIVE' as PanelStatus };
                  status.mutate({
                    ...command,
                    idempotencyKey: statusSubmission.current(command),
                  });
                }}
              >
                {t('web.panel_enable')}
              </button>
            )}
          </div>
        </Card>
      )}
    </>
  );
}

function HealthTab({ panel }: { panel: PanelSummaryResponse }) {
  const fresh = splitDuration(PANEL_HEALTH_FRESH_FOR_MS);
  return (
    <>
      <Banner tone="info" title={t('web.panel_health_latest_title')}>
        {t('web.panel_health_latest_body')}
      </Banner>

      <Card title={t('web.panel_tab_health')}>
        <KV
          items={[
            [t('web.panel_health'), <HealthBadge key="h" panel={panel} />],
            [t('web.panel_failure'), <FailureBadge key="f" failure={panel.health.failure} />],
            [
              t('web.panel_last_check'),
              panel.health.checkedAt === null ? '—' : formatTimestamp(panel.health.checkedAt),
            ],
            [
              t('web.panel_latency'),
              panel.health.latencyMs === null ? (
                '—'
              ) : (
                <Ltr key="l" mono={false}>
                  <Num value={panel.health.latencyMs} /> ms
                </Ltr>
              ),
            ],
            [
              t('web.panel_upstream_status'),
              panel.health.status === null ? '—' : <Ltr key="u">{String(panel.health.status)}</Ltr>,
            ],
            [
              t('web.panel_provider_version'),
              panel.health.providerVersion === null ? (
                '—'
              ) : (
                <Ltr key="v">{panel.health.providerVersion}</Ltr>
              ),
            ],
            [
              t('web.panel_last_healthy'),
              panel.health.lastHealthyAt === null
                ? '—'
                : formatTimestamp(panel.health.lastHealthyAt),
            ],
            [
              t('web.panel_freshness'),
              <span key="fr">
                <Num value={fresh.value} /> {t(unitKey(fresh.unit))}
              </span>,
            ],
          ]}
        />
      </Card>
    </>
  );
}

function unitKey(unit: 'second' | 'minute' | 'hour'): WebKey {
  if (unit === 'hour') return 'web.unit_hours';
  if (unit === 'minute') return 'web.unit_minutes';
  return 'web.unit_seconds';
}

/**
 * Credentials, as PRESENCE.
 *
 * No value, no masked value, no ciphertext, no key id — the response schema
 * carries none of them, and that is the point rather than an omission. The
 * legacy web admin rendered a panel's stored password as readable text on its
 * detail page (WEB-BR-007). A masked placeholder would be worse than the
 * omission it pretends to be: `********` in a populated edit field submits
 * `********` back, and the panel password becomes eight asterisks.
 *
 * So every replace field starts EMPTY, and an empty field means "leave what is
 * stored" rather than "clear it". Clearing is a separate, deliberate act.
 */
function CredentialsTab({
  panel,
  mayRotate,
  onDone,
}: {
  panel: PanelSummaryResponse;
  mayRotate: boolean;
  onDone: () => Promise<void>;
}) {
  const toast = useToast();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [apiToken, setApiToken] = useState('');
  const submission = useSubmissionKey();

  const save = useMutation({
    mutationFn: (command: {
      idempotencyKey: string;
      credentials: { username?: string | null; password?: string | null; apiToken?: string | null };
    }) => setPanelCredentials({ id: panel.id, ...command }),
    onSuccess: async () => {
      submission.settle();
      setUsername('');
      setPassword('');
      setApiToken('');
      toast({ tone: 'ok', message: t('web.saved') });
      await onDone();
    },
    onError: (error: unknown) => {
      submission.settleOn(error);
      toast({ tone: 'danger', message: messageFor(error) });
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    // ABSENT and NULL mean different things, and only non-empty fields are
    // sent. Sending `''` for a field the operator did not touch would be a
    // request to store an empty credential.
    const credentials = {
      ...(username === '' ? {} : { username }),
      ...(password === '' ? {} : { password }),
      ...(apiToken === '' ? {} : { apiToken }),
    };
    if (Object.keys(credentials).length === 0) {
      toast({ tone: 'warn', message: t('web.credentials_nothing_to_do') });
      return;
    }
    save.mutate({ credentials, idempotencyKey: submission.current(credentials) });
  };

  const remove = (field: 'username' | 'password' | 'apiToken') => {
    const credentials = { [field]: null };
    save.mutate({ credentials, idempotencyKey: submission.current(credentials) });
  };

  return (
    <>
      <Banner tone="warn" title={t('web.credentials_one_way_title')}>
        {t('web.credentials_one_way_body')}
      </Banner>

      <Card title={t('web.panel_tab_credentials')}>
        <div className="list-editor">
          <Secret
            configured={panel.credentials.username.configured}
            {...(panel.credentials.username.lastReplacedAt === null
              ? {}
              : { meta: formatTimestamp(panel.credentials.username.lastReplacedAt) })}
            {...(mayRotate ? { onRemove: () => remove('username') } : {})}
          />
          <Secret
            configured={panel.credentials.password.configured}
            {...(panel.credentials.password.lastReplacedAt === null
              ? {}
              : { meta: formatTimestamp(panel.credentials.password.lastReplacedAt) })}
            {...(mayRotate ? { onRemove: () => remove('password') } : {})}
          />
          <Secret
            configured={panel.credentials.apiToken.configured}
            {...(panel.credentials.apiToken.lastReplacedAt === null
              ? {}
              : { meta: formatTimestamp(panel.credentials.apiToken.lastReplacedAt) })}
            {...(mayRotate ? { onRemove: () => remove('apiToken') } : {})}
          />
        </div>
      </Card>

      {mayRotate && (
        <Card title={t('web.credentials_replace')} hint={t('web.credentials_replace_hint')}>
          <form onSubmit={onSubmit} className="form-grid">
            <Field label={t('web.username')} htmlFor={`cu-${panel.id}`}>
              <input
                id={`cu-${panel.id}`}
                className="input ltr mono"
                autoComplete="off"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </Field>
            <Field label={t('web.password')} htmlFor={`cp-${panel.id}`}>
              <input
                id={`cp-${panel.id}`}
                className="input ltr mono"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
            <Field
              label={t('web.api_token')}
              hint={t('web.api_token_hint')}
              htmlFor={`ct-${panel.id}`}
            >
              <input
                id={`ct-${panel.id}`}
                className="input ltr mono"
                type="password"
                autoComplete="off"
                value={apiToken}
                onChange={(event) => setApiToken(event.target.value)}
              />
            </Field>
            <div>
              <button type="submit" className="btn primary" disabled={save.isPending}>
                {save.isPending ? t('web.saving') : t('web.save')}
              </button>
            </div>
          </form>
        </Card>
      )}
    </>
  );
}

/**
 * What the adapter says this panel can do.
 *
 * From the descriptor the server sent, never from a stored row: a capability
 * read from a row is a capability that can be stale, and a stale one is how an
 * installation tries an operation the panel cannot do — or refuses one it can.
 *
 * Everything except `HEALTH_CHECK` is `planned` in this release: no
 * provisioning operation is implemented anywhere. Showing the full matrix with
 * that said plainly is more useful than showing one row, because it answers
 * "will this panel be able to…" as well as "can it now".
 */
function CapabilitiesTab({ panel }: { panel: PanelSummaryResponse }) {
  const held = new Set<string>(panel.capabilities);
  return (
    <Card title={t('web.panel_tab_capabilities')} hint={t('web.capabilities_hint')}>
      <DataTable
        caption={t('web.panel_tab_capabilities')}
        rows={[...PROVIDER_CAPABILITIES]}
        rowKey={(row) => row}
        columns={[
          {
            key: 'name',
            header: t('web.capability'),
            render: (row) => <Ltr>{row}</Ltr>,
          },
          {
            key: 'state',
            header: t('web.status'),
            render: (row: ProviderCapability) =>
              held.has(row) ? <MaturityBadge value="now" /> : <MaturityBadge value="planned" />,
          },
        ]}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Adding a panel.
 *
 * The provider list comes from the server's catalogue, so the picker cannot
 * offer a provider the installation has no adapter for — "a panel that cannot
 * be operated must not become a row" is enforced server-side, and this makes
 * the surface agree rather than duplicate the rule.
 */
export function NewPanelPage({ denied }: { denied: boolean }) {
  const toast = useToast();
  const client = useQueryClient();
  const providers = useQuery({
    queryKey: ['providers'],
    queryFn: fetchProviders,
    enabled: !denied,
  });

  const [name, setName] = useState('');
  const [providerType, setProviderType] = useState<ProviderType | ''>('');
  const [baseUrl, setBaseUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [apiToken, setApiToken] = useState('');
  const submission = useSubmissionKey();

  const chosen = providers.data?.providers.find((provider) => provider.key === providerType);

  const create = useMutation({
    mutationFn: (command: {
      idempotencyKey: string;
      name: string;
      providerType: ProviderType;
      baseUrl: string;
      credentials?: { username?: string; password?: string; apiToken?: string };
    }) => createPanel(command),
    onSuccess: async (result) => {
      submission.settle();
      toast({ tone: 'ok', message: t('web.saved') });
      await client.invalidateQueries({ queryKey: ['panels'] });
      navigate(`/panels/${encodeURIComponent(result.panel.id)}`);
    },
    onError: (error: unknown) => {
      submission.settleOn(error);
      toast({ tone: 'danger', message: messageFor(error) });
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (providerType === '') return;
    const credentials = {
      ...(username === '' ? {} : { username }),
      ...(password === '' ? {} : { password }),
      ...(apiToken === '' ? {} : { apiToken }),
    };
    const command = {
      name,
      providerType,
      baseUrl,
      ...(Object.keys(credentials).length === 0 ? {} : { credentials }),
    };
    create.mutate({ ...command, idempotencyKey: submission.current(command) });
  };

  if (denied) return <Empty title={t('web.no_permission')} icon="lock" />;

  return (
    <>
      <PageHead title={t('web.panel_new')} subtitle={t('web.panel_new_intro')} maturity="now" />

      <Card>
        <form onSubmit={onSubmit} className="form-grid">
          <Field label={t('web.panel_name')} htmlFor="new-name">
            <input
              id="new-name"
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </Field>

          <Field label={t('web.panel_provider')} htmlFor="new-provider">
            <select
              id="new-provider"
              className="input"
              value={providerType}
              onChange={(event) => setProviderType(event.target.value as ProviderType | '')}
              required
            >
              <option value="">—</option>
              {(providers.data?.providers ?? []).map((provider) => (
                <option key={provider.key} value={provider.key}>
                  {provider.canonicalName}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label={t('web.panel_base_url')}
            hint={t('web.panel_base_url_hint')}
            htmlFor="new-url"
          >
            <input
              id="new-url"
              className="input ltr mono"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              required
            />
          </Field>

          {chosen !== undefined && (
            <>
              <Banner tone="info" title={t('web.panel_credential_shape')}>
                <Ltr>{chosen.credentialShape}</Ltr>
              </Banner>
              {chosen.requiredActivationFields.length > 0 && (
                <Banner tone="warn" title={t('web.panel_activation_fields')}>
                  <Ltr>{chosen.requiredActivationFields.join(', ')}</Ltr>
                </Banner>
              )}
            </>
          )}

          <Field label={t('web.username')} htmlFor="new-username">
            <input
              id="new-username"
              className="input ltr mono"
              autoComplete="off"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </Field>
          <Field label={t('web.password')} htmlFor="new-password">
            <input
              id="new-password"
              className="input ltr mono"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <Field label={t('web.api_token')} hint={t('web.api_token_hint')} htmlFor="new-token">
            <input
              id="new-token"
              className="input ltr mono"
              type="password"
              autoComplete="off"
              value={apiToken}
              onChange={(event) => setApiToken(event.target.value)}
            />
          </Field>

          <div>
            <button type="submit" className="btn primary" disabled={create.isPending}>
              {create.isPending ? t('web.saving') : t('web.save')}
            </button>
          </div>
        </form>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export function ProvidersPage({ denied }: { denied: boolean }) {
  const providers = useQuery({
    queryKey: ['providers'],
    queryFn: fetchProviders,
    enabled: !denied,
  });
  const rows = providers.data?.providers ?? [];

  return (
    <>
      <PageHead
        title={t('web.providers_title')}
        subtitle={t('web.providers_intro')}
        maturity="now"
      />

      <Banner tone="info" title={t('web.providers_code_title')}>
        {t('web.providers_code_body')}
      </Banner>

      <Card>
        <StateSwitch
          state={denied ? 'denied' : queryState(providers, rows.length === 0)}
          onRetry={() => void providers.refetch()}
        >
          <DataTable
            caption={t('web.providers_title')}
            rows={rows}
            rowKey={(row) => row.key}
            columns={[
              { key: 'name', header: t('web.panel_provider'), render: (row) => row.canonicalName },
              { key: 'key', header: t('web.key'), render: (row) => <Ltr>{row.key}</Ltr> },
              {
                key: 'shape',
                header: t('web.panel_credential_shape'),
                render: (row) => <Ltr>{row.credentialShape}</Ltr>,
              },
              {
                key: 'caps',
                header: t('web.capability'),
                render: (row) => (
                  <span className="nowrap">
                    {row.capabilities.map((capability) => (
                      <Badge key={capability} tone="ok">
                        <Ltr>{capability}</Ltr>
                      </Badge>
                    ))}
                  </span>
                ),
              },
              {
                key: 'activation',
                header: t('web.panel_activation_fields'),
                render: (row) =>
                  row.requiredActivationFields.length === 0 ? (
                    <span className="faint">—</span>
                  ) : (
                    <Ltr>{row.requiredActivationFields.join(', ')}</Ltr>
                  ),
              },
            ]}
          />
        </StateSwitch>
      </Card>
    </>
  );
}
