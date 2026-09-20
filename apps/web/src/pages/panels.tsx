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
  type UsernamePolicyDraft,
  type UsernameStrategy,
  providerDescriptor,
  PANEL_ERROR_CODES,
  shapeAcceptsCredential,
  shapeIsSatisfiedBy,
  PROVIDER_USERNAME_MAX_LENGTH,
  PROVIDER_USERNAME_MIN_LENGTH,
  USERNAME_STRATEGIES,
  USERNAME_TEMPLATE_TOKEN_NAMES,
  previewUsername,
  validateUsernamePolicy,
} from '@nexa/contracts';
import {
  ApiError,
  createPanel,
  fetchPanel,
  fetchPanels,
  fetchProducts,
  fetchProviders,
  fetchServices,
  setPanelCredentials,
  setPanelStatus,
  testPanel,
  updatePanel,
} from '../api/client';
import { formatTimestamp, splitDuration } from '../format';
import { useSubmissionKey } from '../submission-key';
import { mayRequest, queryState, shownData } from '../view-state';
import { t, type WebKey } from '../i18n/web.fa';
import { navigate, setQuery, useLinkHandler, type Route } from '../router';
import { messageFor } from './settings';
import { HEALTH_TONES } from './dashboard';
/*
 * The product and service vocabularies, imported rather than restated.
 *
 * A second copy of either map is a place for one surface to label `EXPIRED`
 * differently from the page that owns it, which is the "two surfaces compute
 * the same concept differently" failure `docs/conventions.md` names.
 */
import {
  STATUS_LABELS as PRODUCT_STATUS_LABELS,
  STATUS_TONES as PRODUCT_STATUS_TONES,
} from './products';
import {
  STATE_LABELS as SERVICE_STATE_LABELS,
  STATE_TONES as SERVICE_STATE_TONES,
} from './services';
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
  Pills,
  Secret,
  StateSwitch,
  Tabs,
  TabPanel,
  useToast,
  type Column,
  type Tone,
} from '../ui/kit';
import { pollUnlessFinal } from '../polling';

/**
 * How often an open panel detail re-reads its own row.
 *
 * The monitor's shipped cadence is three minutes; this is half of that, so a
 * new health result is on screen within one interval of being written without
 * the page out-polling the writer.
 */
const PANEL_DETAIL_REFRESH_MS = 90_000;
/**
 * The LIST shows the same health columns as the detail — state, failure,
 * latency, check time — written by the same background monitor, and it did
 * not poll. An operator watching `/panels` for a panel to come back saw the
 * row the page was drawn with for ever, while the detail one click away
 * refreshed. One cadence for both, for the reason the dashboard gives its two
 * cards one: two cadences on one subject produce screens that disagree.
 */
const PANEL_LIST_REFRESH_MS = PANEL_DETAIL_REFRESH_MS;

/**
 * How many products and services the workload tab shows.
 *
 * A FIRST PAGE, not a page of a traversal. Ten is enough to recognise what a
 * panel carries and small enough that the tab costs one bounded query each.
 */
const WORKLOAD_PAGE = 10;

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

/**
 * Occupancy in one cell, without lying about any of the three numbers.
 *
 * `used / cap` is the headline because that is the comparison that decides
 * whether the panel sells. The reservation count is appended only when there IS
 * one, so the ordinary row stays a single fraction and the interesting row says
 * why it is bigger than the service count — an operator seeing "8 / 8" with no
 * explanation terminates a service to make room that was about to free itself.
 *
 * `∞` for no cap rather than a blank: blank reads as "not loaded", and an
 * uncapped panel is a deliberate state.
 */
function CapacityCell({ capacity }: { capacity: PanelSummaryResponse['capacity'] }) {
  return (
    <Ltr mono={false}>
      <Num value={capacity.used} />
      {' / '}
      {capacity.maxServices === null ? (
        <span title={t('web.panel_capacity_unlimited')}>∞</span>
      ) : (
        <Num value={capacity.maxServices} />
      )}
      {capacity.reservations > 0 && (
        <span className="faint" title={t('web.panel_capacity_reservations')}>
          {' ('}
          <Num value={capacity.reservations} />
          {')'}
        </span>
      )}
    </Ltr>
  );
}

export function PanelsPage({
  route,
  mayEdit,
  denied,
}: {
  route: Route;
  mayEdit: boolean;
  denied: boolean;
}) {
  const onLink = useLinkHandler();
  /**
   * The cursor stack. Keyset paging goes forward on its own and can only go
   * back to a cursor it has already held, so each page's starting cursor is
   * pushed and popped rather than recomputed.
   */
  /**
   * The cursor stack, and the mode it belongs to.
   *
   * The mode lives in the URL, so it can change WITHOUT going through the
   * toolbar: the sidebar's own «پنل‌ها» link navigates to `/panels`, which drops
   * the query while re-rendering this same component with its `trail` intact.
   * Clearing the trail only inside the filter's `onChange` covered one of the
   * two ways the mode moves, and a cursor minted by one list applied to the
   * other silently strands every row before it — the archive browser exists to
   * find a retired panel, so a page that quietly omits it is the whole defect
   * again.
   *
   * Storing the mode WITH the trail means the mismatch cannot survive a render,
   * whichever route caused it.
   */
  const [trail, setTrail] = useState<{ mode: 'live' | 'archived'; cursors: readonly string[] }>({
    mode: 'live',
    cursors: [],
  });
  /**
   * Which side of the archive this list is showing.
   *
   * Archiving used to remove a panel from the only browser the Web Admin has,
   * so the Restore control on its detail page was reachable only by an operator
   * who had kept the UUID. A lifecycle with an exit and no route back to the
   * door is a dead end; the server could always answer this and nothing asked.
   *
   * In the URL rather than in component state, for the reason `/system` puts
   * its section there: an operator hunting a retired panel wants to link to the
   * archive and reload without losing it. It is also the only way the state is
   * reachable by anything that drives this app by address, which includes the
   * visual harness.
   *
   * NOT Back, and an earlier version of this comment claimed it. `setQuery`
   * navigates with `replace: true`, so switching mode overwrites the `/panels`
   * entry instead of pushing one and Back leaves the page altogether. That is
   * the behaviour to want for a filter — a pager and two pills would otherwise
   * bury whatever the operator was on before — but the comment said the
   * opposite of what the router does, which is the kind of claim this branch
   * has been wrong about before. `/system` makes the same argument for its
   * section and correctly stops at linking and refresh.
   */
  const archived = route.query.get('archived') === 'only';
  const mode: 'live' | 'archived' = archived ? 'archived' : 'live';
  // A trail from the OTHER list is not a position in this one.
  const cursors = trail.mode === mode ? trail.cursors : [];
  const cursor = cursors.length > 0 ? cursors[cursors.length - 1] : undefined;
  const setArchived = (next: boolean) => {
    setQuery(route, 'archived', next ? 'only' : null);
  };
  const pushCursor = (next: string) => setTrail({ mode, cursors: [...cursors, next] });
  const popCursor = () => setTrail({ mode, cursors: cursors.slice(0, -1) });

  const panels = useQuery({
    // The mode is part of the key. Sharing one key across both lists would
    // serve the live page's rows under the archived heading for a frame, which
    // is the sort of thing an operator acts on before it corrects itself.
    queryKey: ['panels', archived ? 'archived' : 'live', cursor ?? null],
    queryFn: () =>
      fetchPanels({
        ...(cursor === undefined ? {} : { cursor }),
        ...(archived ? { archived: 'only' as const } : {}),
      }),
    enabled: !denied,
    refetchInterval: pollUnlessFinal(PANEL_LIST_REFRESH_MS),
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
      key: 'capacity',
      header: t('web.panel_capacity'),
      align: 'end',
      render: (row) => <CapacityCell capacity={row.capacity} />,
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
        {/*
          The live/archived pills mint a new query key — a fresh request against
          a question the card below has just said cannot be answered. Same rule
          as the alerts toolbar, the refresh button and the pager.
        */}
        <div className="toolbar" hidden={!mayRequest(panels, denied)}>
          <Pills
            value={archived ? 'archived' : 'live'}
            onChange={(next) => setArchived(next === 'archived')}
            items={[
              { id: 'live', label: t('web.panels_live') },
              { id: 'archived', label: t('web.panels_archived') },
            ]}
          />
        </div>

        <StateSwitch
          query={panels}
          denied={denied}
          isEmpty={rows.length === 0}
          empty={
            archived ? (
              <Empty title={t('web.panels_archived_empty')} icon="inbox" />
            ) : (
              <Empty
                title={t('web.panels_empty')}
                hint={t('web.panels_empty_hint')}
                icon="panels"
              />
            )
          }
        >
          <DataTable
            caption={t('web.panels_title')}
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
          />
        </StateSwitch>

        {/*
          The pager describes rows that are ON SCREEN.
          
          It is a sibling of `StateSwitch`, so the error card replaced the table
          while this went on reporting "showing N" for rows nobody could see and
          offering an enabled "older" that pushed a cursor — changing the query
          key and issuing a fresh request the server had just refused.
        */}
        {!denied && queryState(panels) === 'ready' && (
          <CursorPager
            shown={rows.length}
            hasPrevious={cursors.length > 0}
            hasNext={nextCursor !== null}
            onPrevious={popCursor}
            onNext={() => nextCursor !== null && pushCursor(nextCursor)}
            // `GET /panels` pages an ASCENDING keyset — oldest panel first,
            // `nextCursor` toward newer ones — so the next page is NEWER here.
            // The default labels are the descending lists', and read backwards
            // on this one.
            nextLabel="web.newer"
            previousLabel="web.older"
          />
        )}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

type DetailTab = 'overview' | 'workload' | 'health' | 'credentials' | 'capabilities';

/** The three credential kinds, once, so no list of them can drift from another. */
type CredentialField = 'username' | 'password' | 'apiToken';
const FIELDS: readonly CredentialField[] = ['username', 'password', 'apiToken'];

/**
 * Whether a probe of this panel could get as far as a request.
 *
 * The server's answer, asked of what the response already carries: three
 * `configured` booleans and the provider's declared shape. `shapeIsSatisfiedBy`
 * is the contract's mirror of `toProviderCredentials`, so the surface and the
 * probe core cannot disagree about it.
 *
 * An UNKNOWN provider is not probeable either: this build carries no adapter
 * for it, so `PROVIDER_TYPE_UNSUPPORTED` is the refusal rather than a missing
 * credential, and either way the button cannot work.
 */
function probeable(panel: PanelSummaryResponse): boolean {
  const shape = providerDescriptor(panel.providerType)?.credentialShape;
  return (
    shape !== undefined &&
    shapeIsSatisfiedBy(shape, {
      username: panel.credentials.username.configured,
      password: panel.credentials.password.configured,
      apiToken: panel.credentials.apiToken.configured,
    })
  );
}

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
    /**
     * Health is written by the BACKGROUND monitor, not by anything this page
     * does, so a detail left open showed one probe's result for ever: the same
     * state, failure, latency and check time, while the monitor went on probing
     * every few minutes. `refetchOnWindowFocus` is off globally, so returning
     * to the tab did not fix it either.
     *
     * Slower than the monitor's cadence on purpose. This is one operator
     * watching one panel; polling faster than the thing that writes the data
     * only adds requests that find the same row.
     */
    refetchInterval: pollUnlessFinal(PANEL_DETAIL_REFRESH_MS),
  });

  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ['panel', id] });
    await client.invalidateQueries({ queryKey: ['panels'] });
  };

  const testSubmission = useSubmissionKey();
  /**
   * Held HERE, not in `CredentialsTab`, because the tab strip unmounts that.
   *
   * `useSubmissionKey` keeps its key when nothing came back, so the operator's
   * retry after an ambiguous 5xx is recognised as the same command rather than
   * a second one. A `useRef` inside the tab lost that on the one action an
   * operator is most likely to take in exactly that situation — going to look
   * at Health to see whether the write landed — and the retry then arrived with
   * a fresh key and an identical payload, which the server cannot dedupe: a
   * second credential write and a second CRITICAL audit row for one intention.
   *
   * The typed secrets still die with the tab, which is the behaviour to want.
   * The key is not a secret.
   */
  const credentialSubmission = useSubmissionKey();
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

  /**
   * The row this page may actually SHOW, which is not the same as the row the
   * query holds.
   *
   * `PageHead` renders above `StateSwitch` and used to read `panel.data`
   * directly, so on a final refusal — a revoked `panels.view`, or a `ZodError`
   * from a tab holding a previous release — the tab strip and the form were
   * torn down while the panel's name, its provider and its **Test-connection
   * button** stayed on screen above the error card. Pressing that button
   * records an `access.permission_denied` event and a DENIED audit row, which
   * is the noise the alerts page exists to keep clear: a control that can never
   * work, drawn over a screen that has just said so.
   *
   * The state is derived from the same pure function on the same object that
   * `StateSwitch` uses, so the heading and the body cannot disagree about it.
   */
  const view = denied ? 'denied' : queryState(panel);
  const data = shownData(panel, view, panel.data?.panel);

  return (
    <>
      <PageHead
        title={data?.name ?? t('web.panel_detail')}
        {...(data === undefined ? {} : { subtitle: data.providerName })}
        maturity="now"
        actions={
          // `mayEdit`, because `testConnection` is guarded by `panels.edit` on
          // the server (`PanelService.testConnection`). Drawing it for a viewer
          // is not a cosmetic slip: pressing it records an `access.permission_denied`
          // operational event AND a `DENIED` audit row, so a control that can
          // never work would manufacture the very noise the alerts page exists
          // to keep clear. Every other write control on this surface is gated
          // the same way; this was the one that was not.
          //
          // `probeable` is the third condition, and it is the same rule for the
          // same reason. `attemptProbe` calls `toProviderCredentials`, which
          // returns null — 412 `panel.credentials_missing` — when the stored
          // credentials do not satisfy the provider's shape. An actor holding
          // `panels.edit` but not `panels.credentials.rotate` creates a panel
          // with NO credentials (that boundary is enforced now) and lands
          // straight on this page, where this button was the only thing to
          // press and could only ever fail.
          !mayEdit ||
          data === undefined ||
          data.status === 'ARCHIVED' ||
          !probeable(data) ? undefined : (
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

      <StateSwitch query={panel} denied={denied}>
        {data !== undefined && (
          <>
            <Tabs
              panelId="panel-detail-panel"
              value={tab}
              onChange={setTab}
              items={[
                { id: 'overview', label: t('web.panel_tab_overview') },
                { id: 'workload', label: t('web.panel_tab_workload') },
                { id: 'health', label: t('web.panel_tab_health') },
                { id: 'credentials', label: t('web.panel_tab_credentials') },
                { id: 'capabilities', label: t('web.panel_tab_capabilities') },
              ]}
            />

            <TabPanel id="panel-detail-panel" labelledBy={`panel-detail-panel-tab-${tab}`}>
              {/*
                HIDDEN, not unmounted — and it is the only tab treated this way.

                `OverviewTab` holds the operator's unsaved identity draft, the
                basis that draft is compared against, and the revision this
                session's own writes have stored. `{tab === 'overview' && …}`
                destroyed all three on a tab click, and re-seeded them from
                whatever row the query happened to be holding — so an operator
                who saved, glanced at Health while the confirming refetch was in
                flight, and came back found their own save apparently reverted
                and a notice blaming somebody else for the change they had just
                made themselves. The window that happens in is exactly the one
                the revision rule exists to cover, and the rule's memory was
                inside the component the click unmounted.

                The other three hold no DRAFT that must outlive the click —
                `CredentialsTab`'s three fields are typed SECRETS, and dropping
                them on the way out is the behaviour to want.

                An earlier version of this comment said they held nothing that
                must outlive it at all, and that was wrong: the credential
                rotation's idempotency KEY had to, and the tab strip destroyed
                it on precisely the action an operator takes after an ambiguous
                failure. The key is owned by `PanelDetailPage` now. The lesson
                is that "state" here is not only what the operator can see.
              */}
              <div hidden={tab !== 'overview'}>
                <OverviewTab panel={data} mayEdit={mayEdit} />
              </div>
              {tab === 'workload' && <WorkloadTab panel={data} />}
              {tab === 'health' && <HealthTab panel={data} />}
              {tab === 'credentials' && (
                <CredentialsTab
                  panel={data}
                  mayRotate={mayRotate}
                  onDone={refresh}
                  submission={credentialSubmission}
                />
              )}
              {tab === 'capabilities' && <CapabilitiesTab panel={data} />}
            </TabPanel>
          </>
        )}
      </StateSwitch>
    </>
  );
}

/**
 * A cap input box that will not be sent at all.
 *
 * Not `null`, which is a real instruction — "remove the cap" — and not a
 * number. Distinguishing the three is the whole point: guessing which one a bad
 * value meant is how a limit disappears without anybody choosing to remove it.
 */
const INVALID_CAP = Symbol('invalid cap');

/**
 * What the cap box is asking for, parsed ONCE for both readers.
 *
 * The overwrite notice and the submit handler ask the same question of the same
 * box, and a notice that parsed it differently from the request would warn
 * about a value the save does not carry — or stay silent about one it does.
 */
function capFromInput(raw: string): number | null | typeof INVALID_CAP {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isInteger(value) && value >= 1 ? value : INVALID_CAP;
}

function OverviewTab({ panel, mayEdit }: { panel: PanelSummaryResponse; mayEdit: boolean }) {
  const client = useQueryClient();
  const toast = useToast();
  /**
   * The row the draft is based on, held apart from the one the query has.
   *
   * The same rule the settings and template editors already follow, and it is
   * load-bearing HERE for a reason that only appeared once the form began
   * sending changed fields only: `name` is initialised once and the `panel`
   * prop refetches. Compare against the live prop and another administrator's
   * rename makes the operator's stale `name` "changed" — so editing only the
   * base URL silently reverts their edit, and `POST /panels/:id` has no
   * expected-version check to catch it.
   *
   * Comparing against the basis means the request carries what THIS operator
   * actually typed over, and a concurrent change is surfaced rather than
   * overwritten.
   */
  const [basis, setBasis] = useState(panel);
  const [name, setName] = useState(panel.name);
  const [baseUrl, setBaseUrl] = useState(panel.baseUrl);
  /**
   * The cap, as TEXT.
   *
   * Empty string is "no cap", which is the state the API spells `null` — and a
   * `number | null` field would have to represent the operator midway through
   * clearing it as something, which is the same three-state problem the request
   * schema solves with a tri-state. Text keeps the input honest and the
   * conversion happens once, on submit.
   */
  const [maxServices, setMaxServices] = useState(
    panel.capacity.maxServices === null ? '' : String(panel.capacity.maxServices),
  );
  /**
   * The newest revision THIS session's own writes have stored.
   *
   * Declared here with the rest of the draft state, and read by `behind` below,
   * where the rule it exists for is written out.
   */
  /*
   * The policy, as three pieces of draft state and one submitted object.
   *
   * The template is TEXT with '' standing for the legacy generator, for the same reason
   * the cap is text: a `string | null` field would have to represent the operator
   * midway through clearing it as something, and the conversion belongs on submit.
   */
  const [allowCustom, setAllowCustom] = useState(panel.usernamePolicy.allowCustom);
  const [allowAutomatic, setAllowAutomatic] = useState(panel.usernamePolicy.allowAutomatic);
  const [strategy, setStrategy] = useState<UsernameStrategy>(panel.usernamePolicy.strategy);
  const [usernamePrefix, setUsernamePrefix] = useState(panel.usernamePolicy.prefix ?? '');
  const [usernameTemplate, setUsernameTemplate] = useState(panel.usernamePolicy.template ?? '');
  const [written, setWritten] = useState<string | null>(null);
  const submission = useSubmissionKey();
  const statusSubmission = useSubmissionKey();

  /**
   * Which fields the query has that the draft was not based on, and of those,
   * which this operator is actually going to send.
   *
   * Two separate questions, and conflating them produced a notice that was
   * false in both directions. `onSubmit` sends CHANGED FIELDS ONLY, so a
   * remote rename the operator never touched is not going to be overwritten by
   * their save — telling them it would made them press "load the fresh value",
   * which resets the whole form, and lose their own unsaved base URL to avoid
   * a loss that could not happen.
   */
  const remote = {
    name: basis.name !== panel.name,
    baseUrl: basis.baseUrl !== panel.baseUrl,
    maxServices: basis.capacity.maxServices !== panel.capacity.maxServices,
    usernamePolicy:
      basis.usernamePolicy.allowCustom !== panel.usernamePolicy.allowCustom ||
      basis.usernamePolicy.allowAutomatic !== panel.usernamePolicy.allowAutomatic ||
      basis.usernamePolicy.strategy !== panel.usernamePolicy.strategy ||
      basis.usernamePolicy.prefix !== panel.usernamePolicy.prefix ||
      basis.usernamePolicy.template !== panel.usernamePolicy.template,
  };
  /*
   * Sent AND different from what is stored now.
   *
   * `!== basis` alone is "this field is in the request"; it is not "somebody
   * else's value is about to be replaced". Two administrators asked to fix the
   * same typo type the same correction, and the earlier version warned the
   * second one that they were about to overwrite the first — so they pressed
   * "load the fresh value", which resets the whole form, and lost their own
   * unsaved base URL to avoid a write that would have stored the identical
   * string.
   */
  /*
   * THREE conditions, and every one of them is load-bearing.
   *
   * `changedRemotely` — somebody else moved this field; without it an ordinary
   * edit to an untouched row reads as clobbering a colleague.
   * `draft !== base` — the operator changed it, so `onSubmit` includes it;
   * without it a save that carries only the base URL was said to overwrite a
   * rename it does not carry.
   * `draft !== stored` — including it actually replaces the other value;
   * without it two administrators making the identical correction were warned
   * about each other.
   */
  const overwrites = (
    draft: string,
    base: string,
    stored: string,
    changedRemotely: boolean,
    same: (a: string, b: string) => boolean,
  ) => changedRemotely && draft !== base && !same(draft, stored);
  /*
   * Compared the way the SERVER will compare them.
   *
   * `panelNameSchema` trims, and `validateUrl` stores `new URL(...).toString()`
   * — so raw `!==` against the stored value decides "this replaces something
   * different" on text the server would normalise to the same string. Two
   * administrators making the same base-URL correction in equivalent spellings
   * (`https://p.example:443/v2` and `https://p.example/v2`) were warned they
   * were about to overwrite each other, and the escape from that warning resets
   * the whole form.
   */
  const sameUrl = (a: string, b: string) => {
    try {
      return new URL(a).toString() === new URL(b).toString();
    } catch {
      /*
       * Not a URL yet — the operator is still typing. Compare the text.
       *
       * Only ONE of this branch's two answers is reachable against this server,
       * and the falsification record says so rather than carrying a test that
       * would pass for the wrong reason. `b` is `panel.baseUrl`, which the
       * server writes as `new URL(raw).toString()`, so it always parses; the
       * throw is always `a`, and an `a` that does not parse is never equal to a
       * `b` that does. The equality is therefore `false` in every state this
       * server can produce, and the reachable rule — a half-typed address is
       * NOT the stored value, so a warning is owed — is what the suite covers.
       *
       * It is written as a comparison rather than `false` because the contract
       * types `baseUrl` as `z.string()`, not a URL: if a row ever holds
       * something else, an operator who retypes it exactly has overwritten
       * nothing, and this answers that correctly instead of accusing them.
       */
      return a === b;
    }
  };
  /*
   * The cap, asked the same three questions as the two text fields.
   *
   * It cannot go through `overwrites`, which compares strings — but it is the
   * field where the warning matters MOST, because the value decides whether the
   * panel accepts new sales at all. Without this, an administrator who lowered
   * a cap while a colleague had the form open was told the panel was
   * "untouched" and then replaced their number.
   *
   * An INVALID box is excluded because `onSubmit` refuses to send it, and a
   * warning about a value that will never leave the browser is the false
   * positive the whole notice was rewritten to remove.
   */
  /*
   * The whole policy as the form currently holds it, and the verdict on it.
   *
   * Assembled once and read by everything below — the verdict, the preview, the
   * submit guard and the request — so the thing being judged is the thing that is
   * sent. An earlier version validated the template in one place and assembled the
   * request in another, which is how the two come to disagree.
   *
   * `validateUsernamePolicy` is the SAME function the server decides with. This is
   * still a courtesy and never the authority: the server re-runs it inside the
   * write's transaction, under the panel's lock.
   */
  const draftPolicy: UsernamePolicyDraft = {
    allowCustom,
    allowAutomatic,
    strategy,
    prefix: strategy === 'PREFIX_RANDOM' && usernamePrefix !== '' ? usernamePrefix : null,
    template: strategy === 'CUSTOM_TEMPLATE' && usernameTemplate !== '' ? usernameTemplate : null,
  };
  const policyVerdict = validateUsernamePolicy(draftPolicy);
  const templateVerdict = policyVerdict.template;
  const templateIssues = (templateVerdict?.issues ?? []).map((issue) =>
    t(`web.panel_username_issue_${issue}` as WebKey),
  );
  /*
   * One name this policy would produce, from fixed synthetic values.
   *
   * It draws no randomness and reserves nothing, so an operator may look at it as
   * often as they like. Null while the policy is not storable — a half-typed template
   * is the normal case here, not an error, and the refusal beside it already says
   * what is wrong.
   */
  const preview = previewUsername(draftPolicy);

  const draftCap = capFromInput(maxServices);
  const overwritesCap =
    remote.maxServices &&
    draftCap !== INVALID_CAP &&
    draftCap !== basis.capacity.maxServices &&
    draftCap !== panel.capacity.maxServices;
  const willOverwrite =
    overwrites(name, basis.name, panel.name, remote.name, (a, b) => a.trim() === b.trim()) ||
    overwrites(baseUrl, basis.baseUrl, panel.baseUrl, remote.baseUrl, sameUrl) ||
    overwritesCap;

  /**
   * Every identity control, not just the Save button.
   *
   * `PanelService.update` refuses an ARCHIVED panel with a 412, so hiding Save
   * alone left two enabled text fields an operator can type a new name into
   * and never submit — a control that asserts a capability the server does not
   * have, which is the one thing this admin is not allowed to do. The inputs
   * follow the same rule the button does.
   */
  const mayWrite = mayEdit && panel.status !== 'ARCHIVED';

  const adopt = (fresh: PanelSummaryResponse) => {
    setBasis(fresh);
    setName(fresh.name);
    setBaseUrl(fresh.baseUrl);
    // The cap too, or "load the fresh value" would re-sync two of the three
    // fields and leave the third holding a number the server no longer has —
    // which the next save would then write back over somebody else's change.
    setMaxServices(fresh.capacity.maxServices === null ? '' : String(fresh.capacity.maxServices));
    setAllowCustom(fresh.usernamePolicy.allowCustom);
    setAllowAutomatic(fresh.usernamePolicy.allowAutomatic);
    setStrategy(fresh.usernamePolicy.strategy);
    setUsernamePrefix(fresh.usernamePolicy.prefix ?? '');
    setUsernameTemplate(fresh.usernamePolicy.template ?? '');
  };

  const refresh = async () => {
    // Keyed by the panel's own id, which is what `PanelDetailPage` keys the
    // query on too — it receives the route parameter, and the only route that
    // reaches this page is `/panels/:id` with that id. Written as `panel.id`
    // rather than threading the parameter down so there is one source for the
    // key on this side; if the two ever stop being the same value, a refetch
    // after a write silently stops happening, which is a failure that looks
    // like a stale screen rather than an error.
    await client.invalidateQueries({ queryKey: ['panel', panel.id] });
    await client.invalidateQueries({ queryKey: ['panels'] });
  };

  const save = useMutation({
    // The whole command is the variable, so a retry carries the payload its
    // key was minted for rather than whatever the fields hold 500 ms later.
    // Both optional: an ABSENT field is one the operator did not change, and
    // the request carries only what actually differs.
    mutationFn: (command: {
      idempotencyKey: string;
      name?: string;
      baseUrl?: string;
      maxServices?: number | null;
    }) => updatePanel({ id: panel.id, ...command }),
    onSuccess: async (result) => {
      submission.settle();
      // The basis follows what was actually stored, so the next edit is
      // compared against the row this operator just wrote — and `written`
      // records WHICH revision that is, so the query being behind it is not
      // read as somebody else's change.
      adopt(result.panel);
      setWritten(result.panel.updatedAt);
      toast({ tone: 'ok', message: t('web.saved') });
      await refresh();
    },
    onError: (error: unknown) => {
      submission.settleOn(error);
      toast({ tone: 'danger', message: messageFor(error) });
    },
  });

  /**
   * The name a restore must be given because the old one was taken.
   *
   * Null until the server says so. Archiving RELEASES the panel's name — the
   * unique index is partial on `status <> 'ARCHIVED'` — so a live panel may
   * have claimed it since, and the restore then answers 409
   * `panel.name_taken`. The API accepts a replacement name on that transition;
   * without a field to type it into, the refusal told the operator to do
   * something no screen could do, and the panel stayed unrestorable.
   */
  const [renameOnRestore, setRenameOnRestore] = useState<string | null>(null);

  /**
   * Whether the operator has asked to archive and not yet confirmed.
   *
   * Local to the card and cleared by BOTH exits of the mutation, so a refusal
   * does not leave a confirmed-looking screen behind and a success does not
   * leave the block drawn over a panel that is already archived.
   */
  const [archiveAsked, setArchiveAsked] = useState(false);

  const status = useMutation({
    mutationFn: (command: { idempotencyKey: string; status: PanelStatus; name?: string }) =>
      setPanelStatus({ id: panel.id, ...command }),
    onSuccess: async (result, command) => {
      statusSubmission.settle();
      setRenameOnRestore(null);
      setArchiveAsked(false);
      /*
       * Only the NAME, and only when this command carried one.
       *
       * A restore that supplies a replacement name changes `name` on the
       * server; leaving the draft on the old value made the page tell the
       * operator that somebody ELSE had changed the row — attributing their own
       * rename to a third party, in a notice about concurrent edits, with no
       * concurrency anywhere in the flow.
       *
       * But `adopt(result.panel)` — the whole row, as `save` does — is wrong
       * here and a test caught it: a status change is not an identity save, and
       * an operator who has typed a new base URL and then presses Disable would
       * have had that draft silently replaced by the stored value. `save` may
       * adopt everything because the operator just submitted everything. This
       * folds in the one field this command is responsible for and leaves every
       * other draft exactly as it was.
       */
      if (command.name !== undefined) {
        setBasis((current) => ({ ...current, name: result.panel.name }));
        setName(result.panel.name);
        setWritten(result.panel.updatedAt);
      }
      toast({ tone: 'ok', message: t('web.saved') });
      await refresh();
    },
    onError: (error: unknown) => {
      statusSubmission.settleOn(error);
      setArchiveAsked(false);
      // The one refusal this screen can actually resolve: offer the field
      // rather than repeating advice the operator cannot act on.
      if (error instanceof ApiError && error.code === PANEL_ERROR_CODES.PANEL_NAME_TAKEN) {
        // The field is seeded with the refused name deliberately: it is the
        // string the operator is about to edit, not a suggestion.
        //
        // An earlier version also remembered every refused name and DISABLED
        // the button for it, to stop a press that could only fail. That was
        // wrong twice over. A 409 is a property of the database at an instant,
        // not of the string — the colliding panel can be renamed or archived a
        // minute later, which frees the name — so the button went dead on a
        // request that had become valid, with no message and no way back but a
        // reload. And a dead control with no explanation is the dead end this
        // whole screen exists to remove. The second refusal is answered with a
        // message that says what to do instead.
        setRenameOnRestore((current) => current ?? panel.name);
      }
      toast({ tone: 'danger', message: messageFor(error) });
    },
  });

  /**
   * Not until the query has caught up with THIS operator's own write.
   *
   * `remote` compares two values that arrive on different clocks: `basis` moves
   * the moment a write answers, `panel` only when the query refetches. Every
   * write therefore opens a window in which the operator's own new value is
   * being compared against the old one the query still holds — which reads as
   * somebody else's change, on top of their own "saved" toast.
   *
   * Six rounds tried to close that window with a mutation's `isPending` flag,
   * and every one of them was falsified in a state where the flag was the wrong
   * one or had already cleared:
   *
   * - `isFetching` is true for the 90-second poll too, so a REAL concurrent
   *   change that had been detected and drawn was un-drawn for the width of
   *   every poll, and indefinitely while one stalled.
   * - `status.isPending` suppressed the notice across a Disable, Enable or
   *   Archive round trip while the Save button — disabled by `save.isPending`
   *   and nothing else — stayed live, so a stalled status POST hid a genuine
   *   warning with no bound, and the "load the fresh value" link that is the
   *   only escape lives INSIDE the suppressed notice.
   * - `save.isPending` alone leaves the restore-with-rename path, which is the
   *   OTHER write that moves `basis`, uncovered — the operator was told a third
   *   party had made the rename they had just supplied themselves.
   * - and any of them clears while the window is still open: a poll fetch
   *   already in flight when the write commits is what `invalidateQueries`
   *   awaits rather than superseding, so `refresh()` returns having installed
   *   the row the save REPLACED, and the cache holds it until the next poll.
   *
   * The window is not "a request is in progress"; it is "the query has not
   * delivered my write yet". So ask that directly. `update` and `setStatus`
   * both stamp `updatedAt` from the Clock and return the row they wrote, so a
   * query row older than the newest one this session stored is by definition a
   * row that predates it — and nothing else can be.
   *
   * It closes on its own terms rather than a flag's: the moment the query
   * delivers a row at or after that revision the comparison is between two
   * values of the same age, and a genuine concurrent change — necessarily
   * NEWER than this operator's write — is never suppressed by it.
   */
  const behind = written !== null && Date.parse(panel.updatedAt) < Date.parse(written);
  const changedElsewhere =
    !behind && (remote.name || remote.baseUrl || remote.maxServices || remote.usernamePolicy);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    // Only what CHANGED. `PanelService.update` treats a present field as an
    // edit, so submitting an untouched form advanced `updatedAt`, made the
    // panel immediately probe-eligible and wrote a successful audit row for a
    // change nobody made — the service's empty-edit guard cannot see it,
    // because the request is not empty.
    // Against the BASIS, not the latest query result — see `basis` above.
    /*
     * The cap, converted once and only when it MOVED.
     *
     * An empty box is `null` — remove the cap — and a number is a number. A box
     * holding something that is not a positive integer is not sent at all and
     * the operator is told, rather than being silently uncapped by a typo: the
     * tri-state means "absent" and "null" are different instructions, and
     * guessing which one a bad value meant is how a limit disappears without
     * anybody choosing to remove it.
     */
    const capValue = capFromInput(maxServices);
    if (capValue === INVALID_CAP) {
      toast({ tone: 'danger', message: t('web.panel_max_services_hint') });
      return;
    }
    /*
     * The policy is sent WHOLE or not at all, and refused locally before it is sent.
     *
     * Whole, because the one rule it has is about the pair of switches and a half
     * policy could only be validated against whatever happens to be stored. Refused
     * locally as a courtesy and never as the authority: `PanelService` re-validates
     * against the panel's own provider, which is the only place that knows the real
     * ceiling. Showing every issue at once is the same rule the template validator
     * follows — an operator fixing one problem per round trip is one who gives up.
     */
    const policyChanged =
      allowCustom !== basis.usernamePolicy.allowCustom ||
      allowAutomatic !== basis.usernamePolicy.allowAutomatic ||
      strategy !== basis.usernamePolicy.strategy ||
      draftPolicy.prefix !== basis.usernamePolicy.prefix ||
      draftPolicy.template !== basis.usernamePolicy.template;
    if (policyChanged && !policyVerdict.ok) {
      /*
       * The evaluator's own words, plus the template's issue list where it has one.
       * The reason comes from the shared function rather than being composed here,
       * so this surface and the Telegram one cannot explain the same refusal
       * differently.
       */
      const detail = templateIssues.length > 0 ? ` ${templateIssues.join(' ')}` : '';
      toast({ tone: 'danger', message: `${policyVerdict.reason ?? ''}${detail}`.trim() });
      return;
    }

    const command = {
      ...(name === basis.name ? {} : { name }),
      ...(baseUrl === basis.baseUrl ? {} : { baseUrl }),
      ...(capValue === basis.capacity.maxServices ? {} : { maxServices: capValue }),
      // The whole policy, exactly as it was validated and previewed above.
      ...(policyChanged ? { usernamePolicy: draftPolicy } : {}),
    };
    if (Object.keys(command).length === 0) {
      toast({ tone: 'warn', message: t('web.no_changes') });
      return;
    }
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

      {/*
        The three numbers, kept apart.
        
        An operator looking at a full panel needs to know whether it is full of
        SERVICES, which they resolve by raising the cap or terminating something,
        or full of HOLDS, which resolve themselves when the orders behind them
        settle or lapse. One `used` figure cannot answer that, and the operator
        who cannot tell the two apart terminates a customer's service to make
        room that was about to free itself.
      */}
      <Card title={t('web.panel_capacity_title')} hint={t('web.panel_capacity_hint')}>
        <KV
          items={[
            [t('web.panel_capacity_services'), <Num key="s" value={panel.capacity.services} />],
            [
              t('web.panel_capacity_reservations'),
              <Num key="r" value={panel.capacity.reservations} />,
            ],
            [t('web.panel_capacity_used'), <Num key="u" value={panel.capacity.used} />],
            [
              t('web.panel_max_services'),
              panel.capacity.maxServices === null ? (
                <span key="m" className="faint">
                  {t('web.panel_capacity_unlimited')}
                </span>
              ) : (
                <Num key="m" value={panel.capacity.maxServices} />
              ),
            ],
            [
              t('web.panel_capacity_available'),
              panel.capacity.available === null ? (
                <span key="a" className="faint">
                  {t('web.panel_capacity_unlimited')}
                </span>
              ) : (
                <Num key="a" value={panel.capacity.available} />
              ),
            ],
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
              disabled={!mayWrite}
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
              disabled={!mayWrite}
            />
          </Field>
          <Field
            label={t('web.panel_max_services')}
            hint={t('web.panel_max_services_hint')}
            htmlFor={`cap-${panel.id}`}
          >
            <input
              id={`cap-${panel.id}`}
              className="input ltr"
              inputMode="numeric"
              value={maxServices}
              onChange={(event) => setMaxServices(event.target.value)}
              disabled={!mayWrite}
            />
          </Field>
          {/*
            The username policy: two switches and a template, read back in full.

            Returned by every panel read and rendered here, for the reason `activation`
            above is: a policy an operator can write and cannot read is the legacy
            settings screen where "the only way to read a price is to overwrite it".
            None of it is a secret — the customer is shown the rule before they type.
          */}
          <p className="field-group-head">{t('web.panel_username_policy')}</p>
          <Field
            label={t('web.panel_username_custom')}
            hint={t('web.panel_username_custom_hint')}
            htmlFor={`uc-${panel.id}`}
          >
            <input
              id={`uc-${panel.id}`}
              type="checkbox"
              checked={allowCustom}
              onChange={(event) => setAllowCustom(event.target.checked)}
              disabled={!mayWrite}
            />
          </Field>
          <Field
            label={t('web.panel_username_automatic')}
            hint={t('web.panel_username_automatic_hint')}
            htmlFor={`ur-${panel.id}`}
          >
            <input
              id={`ur-${panel.id}`}
              type="checkbox"
              checked={allowAutomatic}
              onChange={(event) => setAllowAutomatic(event.target.checked)}
              disabled={!mayWrite}
            />
          </Field>
          {/*
            The preset, shown whatever the automatic switch says.

            Deliberately, and for the reason the template field below gives: a preset
            stored beside a disabled mode goes live the moment somebody re-enables it,
            which is a one-checkbox edit nobody would think to validate. Hiding it
            would leave an operator unable to see what is about to become live.
          */}
          <Field
            label={t('web.panel_username_strategy')}
            hint={t('web.panel_username_strategy_hint')}
            htmlFor={`us-${panel.id}`}
          >
            <select
              id={`us-${panel.id}`}
              className="input"
              value={strategy}
              onChange={(event) => setStrategy(event.target.value as UsernameStrategy)}
              disabled={!mayWrite}
            >
              {USERNAME_STRATEGIES.map((option) => (
                <option key={option} value={option}>
                  {t(`web.panel_username_strategy_${option}` as WebKey)}
                </option>
              ))}
            </select>
          </Field>
          {strategy === 'PREFIX_RANDOM' && (
            <Field
              label={t('web.panel_username_prefix')}
              hint={t('web.panel_username_prefix_hint')}
              htmlFor={`up-${panel.id}`}
            >
              <input
                id={`up-${panel.id}`}
                className="input ltr mono"
                value={usernamePrefix}
                onChange={(event) => setUsernamePrefix(event.target.value)}
                disabled={!mayWrite}
              />
            </Field>
          )}
          {strategy === 'CUSTOM_TEMPLATE' && (
            <>
              <Field
                label={t('web.panel_username_template')}
                hint={t('web.panel_username_template_hint')}
                htmlFor={`ut-${panel.id}`}
              >
                <input
                  id={`ut-${panel.id}`}
                  className="input ltr mono"
                  value={usernameTemplate}
                  onChange={(event) => setUsernameTemplate(event.target.value)}
                  disabled={!mayWrite}
                />
              </Field>
              <p className="hint ltr mono">
                {t('web.panel_username_tokens')}:{' '}
                {USERNAME_TEMPLATE_TOKEN_NAMES.map((token) => `{${token}}`).join(' ')}
              </p>
              {/*
                BOTH bounds, not a sample render.

                A template measured on a typical value passes here and then produces a
                name the panel refuses for the one customer whose Telegram id is longer
                than the operator's — after their money moved. The two numbers shown are
                what `validateUsernameTemplate` actually decides on.
              */}
              {templateVerdict !== null && (
                <p className={templateVerdict.ok ? 'hint' : 'notice'}>
                  {t('web.panel_username_bounds')
                    .replace('{best}', String(templateVerdict.bestCaseLength))
                    .replace('{worst}', String(templateVerdict.worstCaseLength))
                    .replace('{min}', String(PROVIDER_USERNAME_MIN_LENGTH))
                    .replace('{max}', String(PROVIDER_USERNAME_MAX_LENGTH))}
                  {templateIssues.length > 0 && ` — ${templateIssues.join(' ')}`}
                </p>
              )}
            </>
          )}
          {/*
            The preview, from synthetic values, beside the controls that produce it.

            This is the whole answer to a write-only settings screen: an operator can
            see the shape a customer will get BEFORE saving, without reserving a name
            or consuming any randomness.
          */}
          <p className="hint">
            {t('web.panel_username_preview')}:{' '}
            <span className="ltr mono">{preview ?? '\u2014'}</span>
          </p>
          {!policyVerdict.ok && policyVerdict.refusal === 'NO_MODE' && (
            <Banner tone="danger">{t('web.panel_username_policy_empty')}</Banner>
          )}
          {!policyVerdict.ok && policyVerdict.refusal !== 'NO_MODE' && (
            <Banner tone="danger">{policyVerdict.reason ?? ''}</Banner>
          )}

          {/* The provider type is deliberately not editable. Changing it would
              reinterpret the stored credentials against a different protocol;
              the API does not accept it either. */}

          {/*
            Somebody else changed this row while the draft was open. Said
            rather than resolved: `POST /panels/:id` carries no expected
            version, so nothing on the server can refuse the overwrite, and the
            operator is the only party that can decide whose edit stands.

            Which is why this is NOT `web.changed_elsewhere`, the string the
            settings and content forms use: that one promises a conflict error,
            and those two send an `expectedVersion` that can produce one. Here
            it described a refusal the contract cannot make, so an operator who
            pressed Save expecting to be stopped silently overwrote the other
            administrator's rename instead.
          */}
          {/*
            Always rendered when the row moved; only the CLAIM depends on
            `mayWrite`.
            
            Gating the whole notice on write access was itself a defect: on an
            ARCHIVED panel the inputs are disabled but still on screen holding
            the operator's draft, the query keeps refreshing underneath, and
            removing the notice took away both the only signal that the row had
            moved and the "load the fresh value" link that re-syncs it. A viewer
            without `panels.edit` lost the same thing.
            
            What must not be said to them is anything about saving: there is no
            Save button, and `PanelService.update` refuses an archived panel
            with a 412.
          */}
          {changedElsewhere && (
            <p className="notice">
              {t(
                !mayWrite
                  ? 'web.changed_elsewhere_readonly'
                  : willOverwrite
                    ? 'web.changed_elsewhere_overwrite'
                    : 'web.changed_elsewhere_untouched',
              )}{' '}
              <button type="button" className="link" onClick={() => adopt(panel)}>
                {t('web.reload_value')}
              </button>
            </p>
          )}
          {/*
            Archiving is one press away on the card below, which lands the
            operator on exactly this form; `mayWrite` is why neither this
            button nor the two fields above survive it. Restore first — the
            lifecycle card says so.
          */}
          {mayWrite && (
            <div>
              <button type="submit" className="btn primary" disabled={save.isPending}>
                {save.isPending ? t('web.saving') : t('web.save')}
              </button>
            </div>
          )}
        </form>
      </Card>

      {/*
        Archiving and restoring are part of the lifecycle the status API
        supports, and this card used to disappear entirely for an ARCHIVED
        panel while offering only ACTIVE<->DISABLED otherwise. The Web Admin
        could therefore neither archive a finished panel — the mechanism that
        releases its name and takes it out of lists and probes — nor restore
        one archived through another client.
      */}
      {mayEdit && (
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
            {panel.status !== 'ARCHIVED' && !archiveAsked && (
              <button
                type="button"
                className="btn ghost danger"
                disabled={status.isPending}
                onClick={() => setArchiveAsked(true)}
              >
                {t('web.panel_archive')}
              </button>
            )}
            {panel.status === 'ARCHIVED' && (
              <button
                type="button"
                className="btn"
                disabled={status.isPending || renameOnRestore === ''}
                onClick={() => {
                  const command = {
                    status: 'DISABLED' as PanelStatus,
                    // Sent only once the server has said the old name is gone.
                    // A rename on every restore would be a change nobody asked
                    // for, and the API refuses one outside this transition.
                    ...(renameOnRestore === null ? {} : { name: renameOnRestore }),
                  };
                  status.mutate({
                    ...command,
                    idempotencyKey: statusSubmission.current(command),
                  });
                }}
              >
                {t('web.panel_restore')}
              </button>
            )}
          </div>

          {/*
            The second press, and what it is told before it.

            Archiving was ONE click, and it is the click that takes a panel out
            of the catalogue, out of the monitor's schedule and out of every
            list — while leaving every account already on it exactly where it
            is. The two facts an operator needs are how many services the panel
            still carries and that nothing about them changes, and they were
            nowhere on the screen.

            Deliberately NOT a typed phrase. A phrase is the weight `TERMINATE`
            carries because that one deletes somebody's account on a provider;
            archiving is reversible by the Restore button three lines up, and
            pricing the two the same would teach an operator to type past both.

            The count comes from the capacity projection the Overview card
            already renders — the same number, from the same response, so the
            two cannot disagree.
          */}
          {archiveAsked && panel.status !== 'ARCHIVED' && (
            <div className="stack">
              <Banner tone="danger" title={t('web.panel_archive_confirm_title')}>
                {t('web.panel_archive_confirm_body')}
              </Banner>
              <KV
                items={[
                  [
                    t('web.panel_capacity_services'),
                    <Num key="s" value={panel.capacity.services} />,
                  ],
                ]}
              />
              <div className="btn-group">
                <button
                  type="button"
                  className="btn danger"
                  disabled={status.isPending}
                  onClick={() => {
                    const command = { status: 'ARCHIVED' as PanelStatus };
                    status.mutate({
                      ...command,
                      idempotencyKey: statusSubmission.current(command),
                    });
                  }}
                >
                  {t('web.panel_archive_confirm')}
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  disabled={status.isPending}
                  onClick={() => setArchiveAsked(false)}
                >
                  {t('web.panel_archive_cancel')}
                </button>
              </div>
            </div>
          )}

          {/* Only after the refusal, because until then there is nothing to
              resolve and an always-present rename field would invite one. */}
          {renameOnRestore !== null && (
            <>
              <Banner tone="warn">{t('web.panel_restore_name_taken')}</Banner>
              <Field label={t('web.panel_restore_new_name')} htmlFor={`restore-name-${panel.id}`}>
                <input
                  id={`restore-name-${panel.id}`}
                  className="input"
                  value={renameOnRestore}
                  onChange={(event) => setRenameOnRestore(event.target.value)}
                />
              </Field>
            </>
          )}
          <p className="faint small">{t('web.panel_archive_hint')}</p>
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

      {/*
        Said, not merely not-offered. Removing the test button from a panel
        whose credentials cannot authenticate stops the screen making a false
        promise, but an absent control explains nothing — and the monitor is
        equally unable to probe this panel, so its health will stay UNCHECKED
        with no visible cause. This is the one screen where that has an answer.
      */}
      {!probeable(panel) && <Banner tone="warn">{t('web.panel_not_probeable')}</Banner>}

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
  submission,
}: {
  panel: PanelSummaryResponse;
  mayRotate: boolean;
  onDone: () => Promise<void>;
  /** Owned by `PanelDetailPage` — see the comment where it is created. */
  submission: ReturnType<typeof useSubmissionKey>;
}) {
  const toast = useToast();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [apiToken, setApiToken] = useState('');

  /**
   * Which credential fields this panel's provider can actually USE.
   *
   * The descriptor used to be shown and never acted on, so a Marzban panel
   * offered an API token field: the value was accepted, encrypted and stored,
   * and then ignored by every probe, which went on reporting "credentials
   * missing" about a secret the operator had just saved. The server refuses
   * it now; this stops the form asking for it.
   */
  /**
   * An ARCHIVED panel refuses every credential write with a 412, so no rotate
   * control may be drawn for one — neither the replace form nor the per-row
   * remove. The presence rows stay: reading which credentials a retired panel
   * still holds is exactly what an operator needs before restoring it.
   */
  const mayWrite = mayRotate && panel.status !== 'ARCHIVED';

  const shape = providerDescriptor(panel.providerType)?.credentialShape ?? null;
  /**
   * Whether a credential is worth SHOWING, as opposed to worth offering.
   *
   * A panel created before the shape rule existed may hold a credential its
   * provider cannot use — an API token on a Marzban panel. Hiding the presence
   * row outright made that secret undiscoverable and unremovable through the
   * Web Admin, while the response still reported it and the service still
   * accepts `null` to clear it. That is worse than the field it was hiding: a
   * stored secret nobody can see is a stored secret nobody will remove.
   *
   * So the rule splits. `shows` covers the presence row and its remove button;
   * `accepts` covers the replace INPUT, which is the thing that would produce
   * a refusal.
   */
  /** The meta line for one row: when it was replaced, and whether it is dead. */
  const metaFor = (field: CredentialField): string | undefined => {
    const parts = [
      panel.credentials[field].lastReplacedAt === null
        ? null
        : formatTimestamp(panel.credentials[field].lastReplacedAt),
      // Stored and unusable. The operator can only act on what they are told.
      panel.credentials[field].configured && !accepts(field) ? t('web.credential_unusable') : null,
    ].filter((part): part is string => part !== null);
    return parts.length === 0 ? undefined : parts.join(' · ');
  };

  const shows = (field: CredentialField): boolean =>
    accepts(field) || panel.credentials[field].configured;
  const accepts = (field: CredentialField): boolean =>
    // An unknown provider is not a licence to offer everything: a panel whose
    // adapter this build does not carry cannot have its credentials replaced
    // meaningfully either. The descriptor is the frozen catalogue, so this is
    // the same answer the server reaches.
    shape !== null && shapeAcceptsCredential(shape, field);

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
    // Guarded by `accepts` as well as by the field being hidden. UNREACHABLE
    // here, deliberately, and this comment has now been wrong twice about why.
    //
    // It first said the component is not remounted between two panel detail
    // routes. It is: `resolve` keys `PanelDetailPage` on the panel id, which is
    // what fixed the cross-panel draft write. It then said `shape` is read from
    // a query that can change under an open tab. It is not: `shape` comes from
    // `providerDescriptor`, a lookup into a frozen module-level catalogue,
    // keyed on `providerType` — which no request in the contract can change.
    //
    // So nothing can flip `accepts` under this form, and the guard is dead code
    // kept on purpose: it MIRRORS the create form's identical line, where the
    // provider picker really does change the shape with no navigation at all.
    // Two spellings of one rule invite exactly the drift where the reachable
    // copy is edited and the unreachable one is not.
    const credentials = {
      ...(username === '' || !accepts('username') ? {} : { username }),
      ...(password === '' || !accepts('password') ? {} : { password }),
      ...(apiToken === '' || !accepts('apiToken') ? {} : { apiToken }),
    };
    if (Object.keys(credentials).length === 0) {
      toast({ tone: 'warn', message: t('web.credentials_nothing_to_do') });
      return;
    }
    save.mutate({ credentials, idempotencyKey: submission.current(credentials) });
  };

  const remove = (field: CredentialField) => {
    const credentials = { [field]: null };
    save.mutate({ credentials, idempotencyKey: submission.current(credentials) });
  };

  return (
    <>
      <Banner tone="warn" title={t('web.credentials_one_way_title')}>
        {t('web.credentials_one_way_body')}
      </Banner>

      {/* Says WHY a field an operator may expect is not on the page — and only
          when one is actually missing, so it is never an unexplained aside on a
          form that shows everything. */}
      {FIELDS.some((field) => !accepts(field)) && (
        <p className="faint small">{t('web.credential_unsupported_hint')}</p>
      )}
      {/* And the other direction: a credential this panel HOLDS that its
          provider cannot use, stored before the shape rule existed. Named
          explicitly, because the row alone would read as a working credential
          and every probe will go on ignoring it. */}
      {FIELDS.some((field) => panel.credentials[field].configured && !accepts(field)) && (
        <p className="faint small">{t('web.credential_stored_unusable')}</p>
      )}

      <Card title={t('web.panel_tab_credentials')}>
        <div className="list-editor">
          {shows('username') && (
            <Secret
              label={t('web.credential_username')}
              configured={panel.credentials.username.configured}
              {...(metaFor('username') === undefined
                ? {}
                : { meta: metaFor('username') as string })}
              {...(mayWrite ? { onRemove: () => remove('username') } : {})}
            />
          )}
          {shows('password') && (
            <Secret
              label={t('web.credential_password')}
              configured={panel.credentials.password.configured}
              {...(metaFor('password') === undefined
                ? {}
                : { meta: metaFor('password') as string })}
              {...(mayWrite ? { onRemove: () => remove('password') } : {})}
            />
          )}
          {shows('apiToken') && (
            <Secret
              label={t('web.credential_api_token')}
              configured={panel.credentials.apiToken.configured}
              {...(metaFor('apiToken') === undefined
                ? {}
                : { meta: metaFor('apiToken') as string })}
              {...(mayWrite ? { onRemove: () => remove('apiToken') } : {})}
            />
          )}
        </div>
      </Card>

      {mayWrite && (
        <Card title={t('web.credentials_replace')} hint={t('web.credentials_replace_hint')}>
          <form onSubmit={onSubmit} className="form-grid">
            {accepts('username') && (
              <Field label={t('web.username')} htmlFor={`cu-${panel.id}`}>
                <input
                  id={`cu-${panel.id}`}
                  className="input ltr mono"
                  autoComplete="off"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                />
              </Field>
            )}
            {accepts('password') && (
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
            )}
            {accepts('apiToken') && (
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
            )}
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
/**
 * What this panel CARRIES — the question an operator asks before touching it.
 *
 * Two lists, both server-filtered to this panel, because the answer to "may I
 * archive this" is not a status: it is how many products stop being sellable
 * and how many accounts are already on it. The capacity card on Overview gives
 * the counts; this gives the names.
 *
 * Deliberately NOT paginated. It is a first page of each, with a link to the
 * page that does page properly, and it says so when there is more — a pager
 * here would be a second traversal of somebody else's list with its own cursor
 * to get wrong. `nextCursor` is the server's own "there is more", so the notice
 * cannot claim completeness the response did not.
 */
function WorkloadTab({ panel }: { panel: PanelSummaryResponse }) {
  const onLink = useLinkHandler();
  const products = useQuery({
    queryKey: ['panel-products', panel.id],
    queryFn: () => fetchProducts({ panelId: panel.id, limit: WORKLOAD_PAGE }),
  });
  const services = useQuery({
    queryKey: ['panel-services', panel.id],
    queryFn: () => fetchServices({ panelId: panel.id, limit: WORKLOAD_PAGE }),
  });

  return (
    <div className="stack">
      <Card title={t('web.panel_workload_products')} hint={t('web.panel_workload_products_hint')}>
        <StateSwitch query={products} denied={false}>
          {products.data !== undefined &&
            (products.data.products.length === 0 ? (
              <Empty title={t('web.panel_workload_no_products')} />
            ) : (
              <>
                <DataTable
                  caption={t('web.panel_workload_products')}
                  rows={[...products.data.products]}
                  rowKey={(row) => row.id}
                  columns={[
                    {
                      key: 'title',
                      header: t('web.product_title'),
                      render: (row) => (
                        <a href={`/products/${encodeURIComponent(row.id)}`} onClick={onLink}>
                          {row.title}
                        </a>
                      ),
                    },
                    {
                      key: 'status',
                      header: t('web.status'),
                      render: (row) => (
                        <Badge tone={PRODUCT_STATUS_TONES[row.status]}>
                          {t(PRODUCT_STATUS_LABELS[row.status])}
                        </Badge>
                      ),
                    },
                  ]}
                />
                {products.data.nextCursor !== null && (
                  <p className="faint small">{t('web.panel_workload_more')}</p>
                )}
              </>
            ))}
        </StateSwitch>
      </Card>

      <Card title={t('web.panel_workload_services')} hint={t('web.panel_workload_services_hint')}>
        <StateSwitch query={services} denied={false}>
          {services.data !== undefined &&
            (services.data.services.length === 0 ? (
              <Empty title={t('web.panel_workload_no_services')} />
            ) : (
              <>
                <DataTable
                  caption={t('web.panel_workload_services')}
                  rows={[...services.data.services]}
                  rowKey={(row) => row.id}
                  columns={[
                    {
                      key: 'username',
                      header: t('web.service_username'),
                      render: (row) => (
                        <a href={`/services/${encodeURIComponent(row.id)}`} onClick={onLink}>
                          {/* The handle an operator types into the panel, which the
                              contract is explicit is NOT a credential. No subscription
                              URL, ref or client id appears on this surface. */}
                          <Ltr>{row.providerUsername}</Ltr>
                        </a>
                      ),
                    },
                    {
                      key: 'state',
                      header: t('web.status'),
                      render: (row) => (
                        <Badge tone={SERVICE_STATE_TONES[row.state]}>
                          {t(SERVICE_STATE_LABELS[row.state])}
                        </Badge>
                      ),
                    },
                  ]}
                />
                {services.data.nextCursor !== null && (
                  <p className="faint small">{t('web.panel_workload_more')}</p>
                )}
              </>
            ))}
        </StateSwitch>
      </Card>
    </div>
  );
}

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
export function NewPanelPage({
  denied,
  mayRotate,
  mayView,
}: {
  denied: boolean;
  /**
   * Whether this actor may open a panel's detail page.
   *
   * `panels.view` and `panels.edit` are separate, and the create form is open
   * to the second alone. Navigating to the detail route on success would take
   * such an actor to a permission-denied page they cannot navigate back from.
   */
  mayView: boolean;
  /**
   * Whether this actor may write a credential at all.
   *
   * Initial credentials are guarded by `panels.credentials.rotate`, the same
   * CRITICAL permission as a rotation — so an actor with `panels.edit` alone
   * creates the panel and somebody else supplies its secrets. Offering the
   * fields anyway would draw a control whose only outcome is a denial, and a
   * denial here is not free: it writes an audit row and an unresolvable
   * operational event.
   */
  mayRotate: boolean;
}) {
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
  /** The name of a panel created by an actor who cannot open its detail page. */
  const [created, setCreated] = useState<string | null>(null);
  const submission = useSubmissionKey();

  const chosen = providers.data?.providers.find((provider) => provider.key === providerType);
  /**
   * Which credential fields the CHOSEN provider can use — the same rule the
   * detail page applies, and for the same reason: the server refuses a
   * credential outside the shape, so offering the field can only produce a
   * 400 after the operator has typed a secret into it. Nothing is offered
   * before a provider is chosen, because nothing is known yet.
   */
  const accepts = (field: 'username' | 'password' | 'apiToken'): boolean =>
    mayRotate && chosen !== undefined && shapeAcceptsCredential(chosen.credentialShape, field);

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
      /**
       * Only where the actor can actually go.
       *
       * `panels.edit` and `panels.view` are separate permissions and this form
       * is deliberately open to `panels.edit` — the server accepts the create.
       * The detail route requires `panels.view`, so an edit-only actor was
       * taken from a working form to a permission-denied page, with no
       * navigation back: the create route is not in the nav either. A usable
       * screen led to a dead end on success, which is the worst moment to
       * produce one.
       *
       * They stay here, told it worked and given the panel's name back, which
       * is the only part of the detail page they were entitled to see.
       */
      if (mayView) {
        navigate(`/panels/${encodeURIComponent(result.panel.id)}`);
        return;
      }
      setCreated(result.panel.name);
      setName('');
      setBaseUrl('');
      setUsername('');
      setPassword('');
      setApiToken('');
    },
    onError: (error: unknown) => {
      submission.settleOn(error);
      toast({ tone: 'danger', message: messageFor(error) });
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (providerType === '') return;
    // Guarded by `accepts` as well as by the field being hidden: switching the
    // provider after typing leaves the old value in state, and sending it would
    // be refused by the server with the operator's secret already on the wire.
    const credentials = {
      ...(username === '' || !accepts('username') ? {} : { username }),
      ...(password === '' || !accepts('password') ? {} : { password }),
      ...(apiToken === '' || !accepts('apiToken') ? {} : { apiToken }),
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

      {/* The success an actor who cannot open the detail page still gets to
          see. Naming the panel matters: it is the only confirmation that the
          thing they typed is the thing that now exists. */}
      {created !== null && (
        <Banner tone="ok" title={t('web.panel_created_title')}>
          {t('web.panel_created_body')} <span className="plain">{created}</span>
        </Banner>
      )}

      <Card>
        {/*
          The provider catalogue decides whether this form can do anything at
          all. Reading `providers.data` directly meant a 503 from `/providers`
          rendered a complete, enabled form with an empty picker: submitting
          returned silently because `providerType` was '', so an outage looked
          exactly like an installation with no supported providers, and offered
          no retry.
        */}
        <StateSwitch
          query={providers}
          isEmpty={(providers.data?.providers.length ?? 0) === 0}
          empty={<Empty title={t('web.providers_none')} icon="panels" />}
        >
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

            {accepts('username') && (
              <Field label={t('web.username')} htmlFor="new-username">
                <input
                  id="new-username"
                  className="input ltr mono"
                  autoComplete="off"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                />
              </Field>
            )}
            {accepts('password') && (
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
            )}
            {accepts('apiToken') && (
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
            )}

            <div>
              <button type="submit" className="btn primary" disabled={create.isPending}>
                {create.isPending ? t('web.saving') : t('web.save')}
              </button>
            </div>
          </form>
        </StateSwitch>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/**
 * No `denied` prop.
 *
 * `GET /providers` authenticates and checks no permission — it is a catalogue
 * of code, identical for every tenant. The prop existed to gate this page on
 * `panels.view`, which hid it from the `panels.edit`-only actor whose create
 * form fetches this very catalogue. Once the gate went, the prop could only
 * ever be `false`, and a parameter with one reachable value is dead weight that
 * reads like a control.
 */
export function ProvidersPage() {
  const providers = useQuery({ queryKey: ['providers'], queryFn: fetchProviders });
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
        <StateSwitch query={providers} isEmpty={rows.length === 0}>
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
