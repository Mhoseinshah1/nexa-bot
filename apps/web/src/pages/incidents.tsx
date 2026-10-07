import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  INCIDENT_CUSTOMER_MESSAGE_MAX_LENGTH,
  INCIDENT_DESCRIPTION_MAX_LENGTH,
  INCIDENT_ERROR_CODES,
  INCIDENT_KINDS,
  INCIDENT_SEVERITIES,
  INCIDENT_TARGET_KINDS,
  INCIDENT_TARGETS_MAX,
  INCIDENT_TITLE_MAX_LENGTH,
  isValidIncidentTarget,
  type IncidentEffectItem,
  type IncidentEffectKind,
  type IncidentEffectState,
  type IncidentEventItem,
  type IncidentEventKind,
  type IncidentItem,
  type IncidentKind,
  type IncidentSeverity,
  type IncidentStatus,
  type IncidentTarget,
  type IncidentTargetKind,
} from '@nexa/contracts';
import {
  ApiError,
  actOnIncident,
  applyIncidentEffects,
  createIncident,
  fetchIncident,
  fetchIncidentBanner,
  fetchIncidentNoticePreview,
  fetchIncidents,
  fetchPanels,
  fetchPaymentGateways,
  fetchProducts,
  fetchServiceLocations,
  sendIncidentNotice,
  updateIncident,
  type IncidentAction,
} from '../api/client';
import { formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { navigate, useLinkHandler } from '../router';
import { useSubmissionKey } from '../submission-key';
import { messageFor } from './settings';
import {
  Badge,
  Banner,
  Button,
  Card,
  Checkbox,
  CursorPager,
  DataTable,
  Empty,
  Field,
  Input,
  KV,
  Ltr,
  Num,
  PageHead,
  Select,
  StateSwitch,
  Textarea,
  Timeline,
  useToast,
  type Tone,
} from '../ui/kit';
import { Modal } from '../ui/overlays';

/**
 * Phase E3: incidents and maintenance windows (`docs/incidents.md`).
 *
 * The page is a client of `/incidents` and nothing else decides here. What an incident
 * DOES — stopping new sales on exactly its targets — happens on the server, through each
 * target's own module and that module's own permission; an effect the operator could not
 * apply comes back FAILED with its code and is shown as such, never hidden. Nothing here
 * pauses delivery of what customers already paid for: the money rules are untouched.
 */

/** How often the admin banner asks; an incident is not a stock ticker. */
export const INCIDENT_BANNER_REFRESH_MS = 60_000;

export const INCIDENT_KIND_LABELS: Readonly<Record<IncidentKind, WebKey>> = {
  INCIDENT: 'web.inc_kind_incident',
  MAINTENANCE: 'web.inc_kind_maintenance',
};

export const INCIDENT_SEVERITY_LABELS: Readonly<Record<IncidentSeverity, WebKey>> = {
  MINOR: 'web.inc_severity_minor',
  MAJOR: 'web.inc_severity_major',
  CRITICAL: 'web.inc_severity_critical',
};

const SEVERITY_TONES: Readonly<Record<IncidentSeverity, Tone>> = {
  MINOR: 'warn',
  MAJOR: 'danger',
  CRITICAL: 'danger',
};

export const INCIDENT_STATUS_LABELS: Readonly<Record<IncidentStatus, WebKey>> = {
  SCHEDULED: 'web.inc_status_scheduled',
  ACTIVE: 'web.inc_status_active',
  RESOLVED: 'web.inc_status_resolved',
  CANCELLED: 'web.inc_status_cancelled',
};

const STATUS_TONES: Readonly<Record<IncidentStatus, Tone>> = {
  SCHEDULED: 'info',
  ACTIVE: 'danger',
  RESOLVED: 'ok',
  CANCELLED: 'neutral',
};

export const INCIDENT_TARGET_LABELS: Readonly<Record<IncidentTargetKind, WebKey>> = {
  PANEL: 'web.inc_target_panel',
  LOCATION: 'web.inc_target_location',
  PRODUCT: 'web.inc_target_product',
  GATEWAY: 'web.inc_target_gateway',
};

export const INCIDENT_EFFECT_LABELS: Readonly<Record<IncidentEffectKind, WebKey>> = {
  PANEL_DRAIN: 'web.inc_effect_panel_drain',
  LOCATION_DISABLE: 'web.inc_effect_location_disable',
  PRODUCT_DEACTIVATE: 'web.inc_effect_product_deactivate',
  GATEWAY_DISABLE: 'web.inc_effect_gateway_disable',
};

export const INCIDENT_EFFECT_STATE_LABELS: Readonly<Record<IncidentEffectState, WebKey>> = {
  PENDING: 'web.inc_effect_state_pending',
  APPLIED: 'web.inc_effect_state_applied',
  ALREADY: 'web.inc_effect_state_already',
  FAILED: 'web.inc_effect_state_failed',
  REVERTING: 'web.inc_effect_state_reverting',
  REVERTED: 'web.inc_effect_state_reverted',
  KEPT: 'web.inc_effect_state_kept',
  HANDED_OVER: 'web.inc_effect_state_handed_over',
};

const EFFECT_STATE_TONES: Readonly<Record<IncidentEffectState, Tone>> = {
  PENDING: 'info',
  APPLIED: 'warn',
  ALREADY: 'neutral',
  FAILED: 'danger',
  REVERTING: 'info',
  REVERTED: 'ok',
  KEPT: 'neutral',
  HANDED_OVER: 'neutral',
};

export const INCIDENT_EVENT_LABELS: Readonly<Record<IncidentEventKind, WebKey>> = {
  CREATED: 'web.inc_event_created',
  SCHEDULED: 'web.inc_event_scheduled',
  STARTED: 'web.inc_event_started',
  UPDATED: 'web.inc_event_updated',
  SCOPE_CHANGED: 'web.inc_event_scope_changed',
  EFFECT: 'web.inc_event_effect',
  EFFECTS_PENDING: 'web.inc_event_effects_pending',
  COMMUNICATED: 'web.inc_event_communicated',
  RESOLVED: 'web.inc_event_resolved',
  CANCELLED: 'web.inc_event_cancelled',
};

/** The incident codes an operator acts on, in their words; anything else, the server's. */
export function incidentMessageFor(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case INCIDENT_ERROR_CODES.VERSION_CONFLICT:
        return t('web.inc_error_version');
      case INCIDENT_ERROR_CODES.STATE_CONFLICT:
        return t('web.inc_error_state');
      case INCIDENT_ERROR_CODES.TARGET_INVALID:
        return t('web.inc_error_target');
      case INCIDENT_ERROR_CODES.SCHEDULE_INVALID:
        return t('web.inc_error_schedule');
      case INCIDENT_ERROR_CODES.NOTICE_REFUSED:
        return t('web.inc_error_notice');
      case INCIDENT_ERROR_CODES.NOT_FOUND:
        return t('web.inc_error_not_found');
    }
  }
  return messageFor(error);
}

/** `datetime-local` speaks the browser's local wall clock; the wire speaks UTC instants. */
export function toLocalInput(iso: string | null): string {
  if (iso === null) return '';
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

export function fromLocalInput(value: string): string | null {
  if (value.trim() === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// ---------------------------------------------------------------------------------------
// The admin banner
// ---------------------------------------------------------------------------------------

/**
 * Drawn above every page while an ACTIVE incident asked for one. Any administrator may
 * read it; a failure to ask draws nothing, because a missing banner is not an incident.
 */
export function IncidentBanner({ mayView }: { mayView: boolean }) {
  const onLink = useLinkHandler();
  const banner = useQuery({
    queryKey: ['incident-banner'],
    queryFn: fetchIncidentBanner,
    refetchInterval: INCIDENT_BANNER_REFRESH_MS,
  });
  const rows = banner.data?.incidents ?? [];
  if (rows.length === 0) return null;
  return (
    <div className="incident-banners" aria-label={t('web.inc_banner_label')}>
      {rows.map((row) => (
        <Banner
          key={row.id}
          tone={row.severity === 'MINOR' ? 'warn' : 'danger'}
          role="status"
          title={t(INCIDENT_KIND_LABELS[row.kind])}
          // The detail page charges `incidents.view`: without it there is nothing to open,
          // so no link is drawn — the banner itself is every administrator's (Codex, #162).
          {...(mayView
            ? {
                action: (
                  <a
                    className="btn sm"
                    href={`/incidents/${encodeURIComponent(row.id)}`}
                    onClick={onLink}
                  >
                    {t('web.inc_banner_open')}
                  </a>
                ),
              }
            : {})}
        >
          {' '}
          {row.title}
          {row.scheduledEndAt !== null && (
            <span className="faint small">
              {' · '}
              {t('web.inc_banner_until')} {formatTimestamp(row.scheduledEndAt)}
            </span>
          )}
        </Banner>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------------------

export function IncidentsPage({ denied, mayManage }: { denied: boolean; mayManage: boolean }) {
  const onLink = useLinkHandler();
  // A stack of cursors: the last is the page shown, popping it goes back one.
  const [cursors, setCursors] = useState<readonly string[]>([]);
  const cursor = cursors.length > 0 ? cursors[cursors.length - 1] : undefined;
  const list = useQuery({
    queryKey: ['incidents', cursor ?? null],
    queryFn: () => fetchIncidents(cursor === undefined ? {} : { cursor }),
    enabled: !denied,
  });
  const [creating, setCreating] = useState(false);
  const rows = list.data?.incidents ?? [];
  const nextCursor = list.data?.nextCursor ?? null;
  return (
    <>
      <PageHead
        title={t('web.nav_incidents')}
        subtitle={t('web.inc_subtitle')}
        {...(mayManage && !denied
          ? {
              actions: (
                <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
                  {t('web.inc_new')}
                </Button>
              ),
            }
          : {})}
      />
      <StateSwitch
        query={list}
        denied={denied}
        isEmpty={rows.length === 0 && cursors.length === 0}
        empty={<Empty title={t('web.inc_empty')} />}
      >
        <Card>
          <DataTable
            caption={t('web.nav_incidents')}
            rows={rows}
            rowKey={(row) => row.id}
            columns={[
              {
                key: 'title',
                header: t('web.inc_col_title'),
                wrap: true,
                render: (row) => (
                  <a href={`/incidents/${encodeURIComponent(row.id)}`} onClick={onLink}>
                    {row.title}
                  </a>
                ),
              },
              {
                key: 'kind',
                header: t('web.inc_col_kind'),
                render: (row) => t(INCIDENT_KIND_LABELS[row.kind]),
              },
              {
                key: 'severity',
                header: t('web.inc_col_severity'),
                render: (row) => (
                  <Badge tone={SEVERITY_TONES[row.severity]}>
                    {t(INCIDENT_SEVERITY_LABELS[row.severity])}
                  </Badge>
                ),
              },
              {
                key: 'status',
                header: t('web.inc_col_status'),
                render: (row) => <StatusBadge status={row.status} />,
              },
              {
                key: 'when',
                header: t('web.inc_col_when'),
                render: (row) => formatTimestamp(whenOf(row)),
              },
              {
                key: 'scope',
                header: t('web.inc_col_scope'),
                align: 'end',
                render: (row) => (
                  <>
                    <Num value={row.targets.length} />
                    {row.stopSales && (
                      <>
                        {' '}
                        <Badge tone="warn">{t('web.inc_stop_sales_short')}</Badge>
                      </>
                    )}
                  </>
                ),
              },
            ]}
          />
          <CursorPager
            hasPrevious={cursors.length > 0}
            hasNext={nextCursor !== null}
            onPrevious={() => setCursors((stack) => stack.slice(0, -1))}
            onNext={() => {
              if (nextCursor !== null) setCursors((stack) => [...stack, nextCursor]);
            }}
          />
        </Card>
      </StateSwitch>
      {creating && (
        <IncidentFormModal
          incident={null}
          onClose={() => setCreating(false)}
          onSaved={(saved) => navigate(`/incidents/${encodeURIComponent(saved.id)}`)}
        />
      )}
    </>
  );
}

function whenOf(row: IncidentItem): string {
  return row.resolvedAt ?? row.startedAt ?? row.scheduledStartAt ?? row.createdAt;
}

function StatusBadge({ status }: { status: IncidentStatus }) {
  return <Badge tone={STATUS_TONES[status]}>{t(INCIDENT_STATUS_LABELS[status])}</Badge>;
}

// ---------------------------------------------------------------------------------------
// The detail
// ---------------------------------------------------------------------------------------

export function IncidentDetailPage({
  id,
  denied,
  mayManage,
  mayNotify,
}: {
  id: string;
  denied: boolean;
  /** `incidents.manage`: edit, start, resolve, cancel, apply effects. */
  mayManage: boolean;
  /** `incidents.notify`: the customer notice. */
  mayNotify: boolean;
}) {
  const detail = useQuery({
    queryKey: ['incident', id],
    queryFn: () => fetchIncident(id),
    enabled: !denied,
  });
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState<IncidentAction | null>(null);
  const [noticing, setNoticing] = useState(false);
  const queries = useQueryClient();
  const toast = useToast();
  const apply = useMutation({
    mutationFn: () => applyIncidentEffects(id),
    onSuccess: async () => {
      toast({ tone: 'ok', message: t('web.inc_effects_applied') });
      await refresh(queries, id);
    },
  });

  const incident = detail.data?.incident;
  const live = incident !== undefined && ['SCHEDULED', 'ACTIVE'].includes(incident.status);
  return (
    <StateSwitch query={detail} denied={denied}>
      {incident !== undefined && (
        <>
          <PageHead
            title={incident.title}
            subtitle={`${t(INCIDENT_KIND_LABELS[incident.kind])} · ${t(
              INCIDENT_SEVERITY_LABELS[incident.severity],
            )}`}
          />
          {incident.status === 'ACTIVE' && incident.stopSales && (
            <Banner tone="info">{t('web.inc_money_note')}</Banner>
          )}
          {apply.isError && (
            <Banner tone="danger" role="alert">
              {incidentMessageFor(apply.error)}
            </Banner>
          )}
          {live && (mayManage || mayNotify) && (
            <div className="incident-actions">
              {mayManage && (
                <Button size="sm" onClick={() => setEditing(true)}>
                  {t('web.inc_edit')}
                </Button>
              )}
              {mayManage && incident.status === 'SCHEDULED' && (
                <Button size="sm" variant="primary" onClick={() => setConfirming('start')}>
                  {t('web.inc_start')}
                </Button>
              )}
              {mayManage && incident.status === 'ACTIVE' && incident.stopSales && (
                <Button size="sm" disabled={apply.isPending} onClick={() => apply.mutate()}>
                  {apply.isPending ? t('web.working') : t('web.inc_apply_effects')}
                </Button>
              )}
              {mayManage && incident.status === 'ACTIVE' && (
                <Button size="sm" variant="primary" onClick={() => setConfirming('resolve')}>
                  {t('web.inc_resolve')}
                </Button>
              )}
              {mayManage && incident.status === 'SCHEDULED' && (
                <Button size="sm" variant="danger" onClick={() => setConfirming('cancel')}>
                  {t('web.inc_cancel')}
                </Button>
              )}
              {mayNotify && incident.customerMessage !== null && (
                <Button size="sm" onClick={() => setNoticing(true)}>
                  {t('web.inc_notice')}
                </Button>
              )}
            </div>
          )}
          <div className="incident-detail">
            <Card title={t('web.inc_summary')}>
              <KV
                items={[
                  [t('web.inc_col_status'), <StatusBadge key="s" status={incident.status} />],
                  [
                    t('web.inc_scheduled_start'),
                    incident.scheduledStartAt === null
                      ? '—'
                      : formatTimestamp(incident.scheduledStartAt),
                  ],
                  [
                    t('web.inc_scheduled_end'),
                    incident.scheduledEndAt === null
                      ? '—'
                      : formatTimestamp(incident.scheduledEndAt),
                  ],
                  [
                    t('web.inc_started_at'),
                    incident.startedAt === null ? '—' : formatTimestamp(incident.startedAt),
                  ],
                  [
                    t('web.inc_resolved_at'),
                    incident.resolvedAt === null ? '—' : formatTimestamp(incident.resolvedAt),
                  ],
                  [
                    t('web.inc_stop_sales'),
                    incident.stopSales ? t('web.inc_yes') : t('web.inc_no'),
                  ],
                  [
                    t('web.inc_admin_banner'),
                    incident.adminBanner ? t('web.inc_yes') : t('web.inc_no'),
                  ],
                ]}
              />
              {incident.description !== '' && (
                <p className="incident-text">{incident.description}</p>
              )}
              <h3 className="small">{t('web.inc_customer_message')}</h3>
              {incident.customerMessage === null ? (
                <p className="faint small">{t('web.inc_no_customer_message')}</p>
              ) : (
                <p className="incident-text">{incident.customerMessage}</p>
              )}
            </Card>
            <Card title={t('web.inc_scope')}>
              {incident.targets.length === 0 ? (
                <p className="faint small">{t('web.inc_no_targets')}</p>
              ) : (
                <ul className="incident-targets">
                  {incident.targets.map((target) => (
                    <li key={`${target.kind}:${target.ref}`}>
                      <Badge tone="neutral">{t(INCIDENT_TARGET_LABELS[target.kind])}</Badge>{' '}
                      <Ltr>{target.ref}</Ltr>
                    </li>
                  ))}
                </ul>
              )}
              <EffectsTable effects={incident.effects} />
            </Card>
            <Card title={t('web.inc_timeline')}>
              <Timeline
                items={(detail.data?.timeline ?? []).map((event) => ({
                  key: event.id,
                  at: formatTimestamp(event.occurredAt),
                  title: t(INCIDENT_EVENT_LABELS[event.kind]),
                  detail: eventDetail(event),
                  ...(event.kind === 'EFFECTS_PENDING' ? { tone: 'warn' as const } : {}),
                }))}
              />
            </Card>
          </div>
          {editing && (
            <IncidentFormModal
              incident={incident}
              onClose={() => setEditing(false)}
              onSaved={() => setEditing(false)}
            />
          )}
          {confirming !== null && (
            <ActionModal
              incident={incident}
              action={confirming}
              onClose={() => setConfirming(null)}
            />
          )}
          {noticing && <NoticeModal incident={incident} onClose={() => setNoticing(false)} />}
        </>
      )}
    </StateSwitch>
  );
}

async function refresh(queries: ReturnType<typeof useQueryClient>, id: string): Promise<void> {
  await queries.invalidateQueries({ queryKey: ['incident', id] });
  await queries.invalidateQueries({ queryKey: ['incidents'] });
  await queries.invalidateQueries({ queryKey: ['incident-banner'] });
}

/** A timeline detail: who, and the few structured facts the server chose to keep. */
function eventDetail(event: IncidentEventItem): string | undefined {
  const parts: string[] = [];
  if (event.actorLabel !== null) parts.push(event.actorLabel);
  const detail = event.detail ?? {};
  for (const key of ['effect', 'subject', 'state', 'recipients', 'from', 'to'] as const) {
    const value = detail[key];
    if (typeof value === 'string' || typeof value === 'number') parts.push(`${key}: ${value}`);
  }
  return parts.length === 0 ? undefined : parts.join(' · ');
}

function EffectsTable({ effects }: { effects: readonly IncidentEffectItem[] }) {
  if (effects.length === 0) return <p className="faint small">{t('web.inc_no_effects')}</p>;
  return (
    <DataTable
      caption={t('web.inc_effects')}
      dense
      rows={effects}
      rowKey={(row) => `${row.kind}:${row.subjectRef}`}
      columns={[
        {
          key: 'kind',
          header: t('web.inc_effect_col'),
          render: (row) => t(INCIDENT_EFFECT_LABELS[row.kind]),
        },
        {
          key: 'subject',
          header: t('web.inc_subject_col'),
          render: (row) => <Ltr>{row.subjectRef}</Ltr>,
        },
        {
          key: 'state',
          header: t('web.inc_col_status'),
          render: (row) => (
            <>
              <Badge tone={EFFECT_STATE_TONES[row.state]}>
                {t(INCIDENT_EFFECT_STATE_LABELS[row.state])}
              </Badge>
              {row.errorCode !== null && (
                <>
                  {' '}
                  <Ltr>{row.errorCode}</Ltr>
                </>
              )}
            </>
          ),
        },
      ]}
    />
  );
}

// ---------------------------------------------------------------------------------------
// Start, resolve, cancel
// ---------------------------------------------------------------------------------------

const ACTION_COPY: Readonly<
  Record<IncidentAction, { title: WebKey; explain: WebKey; confirm: WebKey; done: WebKey }>
> = {
  start: {
    title: 'web.inc_start_title',
    explain: 'web.inc_start_explain',
    confirm: 'web.inc_start',
    done: 'web.inc_started',
  },
  resolve: {
    title: 'web.inc_resolve_title',
    explain: 'web.inc_resolve_explain',
    confirm: 'web.inc_resolve',
    done: 'web.inc_resolved',
  },
  cancel: {
    title: 'web.inc_cancel_title',
    explain: 'web.inc_cancel_explain',
    confirm: 'web.inc_cancel',
    done: 'web.inc_cancelled',
  },
};

function ActionModal({
  incident,
  action,
  onClose,
}: {
  incident: IncidentItem;
  action: IncidentAction;
  onClose: () => void;
}) {
  const copy = ACTION_COPY[action];
  const queries = useQueryClient();
  const toast = useToast();
  const submission = useSubmissionKey();
  const run = useMutation({
    mutationFn: () => {
      const body = { id: incident.id, action, expectedVersion: incident.version };
      return actOnIncident({ ...body, idempotencyKey: submission.current(body) });
    },
    onSuccess: async () => {
      submission.settle();
      toast({ tone: 'ok', message: t(copy.done) });
      await refresh(queries, incident.id);
      onClose();
    },
    // A 409 means the incident moved on: re-read it, so the next press acts on what is there now.
    onError: (error: unknown) =>
      submission.settleOn(error, { onConflict: () => void refresh(queries, incident.id) }),
  });
  const close = () => {
    if (!run.isPending) onClose();
  };
  return (
    <Modal
      open
      onClose={close}
      danger={action === 'cancel'}
      title={t(copy.title)}
      foot={
        <>
          <Button
            variant={action === 'cancel' ? 'danger' : 'primary'}
            size="sm"
            disabled={run.isPending}
            onClick={() => run.mutate()}
          >
            {run.isPending ? t('web.working') : t(copy.confirm)}
          </Button>
          <Button size="sm" disabled={run.isPending} onClick={close}>
            {t('web.user_action_cancel')}
          </Button>
        </>
      }
    >
      <p>
        <strong>{incident.title}</strong>
      </p>
      <Banner tone="info">{t(copy.explain)}</Banner>
      {run.isError && (
        <Banner tone="danger" role="alert">
          {incidentMessageFor(run.error)}
        </Banner>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------
// The customer notice
// ---------------------------------------------------------------------------------------

/**
 * Counted, then confirmed with the count: the server refuses a send whose audience has
 * changed since the preview, so the number an operator agreed to is the number told.
 */
function NoticeModal({ incident, onClose }: { incident: IncidentItem; onClose: () => void }) {
  const preview = useQuery({
    queryKey: ['incident-notice-preview', incident.id, incident.version],
    queryFn: () => fetchIncidentNoticePreview(incident.id),
  });
  const queries = useQueryClient();
  const toast = useToast();
  const submission = useSubmissionKey();
  const recipients = preview.data?.recipients;
  const run = useMutation({
    mutationFn: () => {
      const body = {
        id: incident.id,
        expectedVersion: preview.data?.version ?? incident.version,
        expectedRecipients: recipients ?? 0,
      };
      return sendIncidentNotice({ ...body, idempotencyKey: submission.current(body) });
    },
    onSuccess: async (result) => {
      submission.settle();
      toast({
        tone: 'ok',
        message: t('web.inc_notice_queued').replace('{count}', String(result.queued)),
      });
      await refresh(queries, incident.id);
      onClose();
    },
    onError: async (error: unknown) => {
      submission.settleOn(error);
      await preview.refetch();
    },
  });
  const close = () => {
    if (!run.isPending) onClose();
  };
  return (
    <Modal
      open
      onClose={close}
      title={t('web.inc_notice_title')}
      foot={
        <>
          <Button
            variant="primary"
            size="sm"
            disabled={recipients === undefined || recipients === 0 || run.isPending}
            onClick={() => run.mutate()}
          >
            {run.isPending ? t('web.working') : t('web.inc_notice_confirm')}
          </Button>
          <Button size="sm" disabled={run.isPending} onClick={close}>
            {t('web.user_action_cancel')}
          </Button>
        </>
      }
    >
      <Banner tone="info">{t('web.inc_notice_explain')}</Banner>
      <p className="incident-text">{incident.customerMessage}</p>
      {/* The count's own loading, error and stale states are the kit's one rule. */}
      <StateSwitch query={preview}>
        <p>
          {t('web.inc_notice_recipients')} <Num value={recipients ?? 0} />
        </p>
      </StateSwitch>
      {run.isError && (
        <Banner tone="danger" role="alert">
          {incidentMessageFor(run.error)}
        </Banner>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------
// Create and edit
// ---------------------------------------------------------------------------------------

interface FormState {
  kind: IncidentKind;
  severity: IncidentSeverity;
  title: string;
  description: string;
  customerMessage: string;
  targets: IncidentTarget[];
  stopSales: boolean;
  adminBanner: boolean;
  scheduledStartAt: string;
  scheduledEndAt: string;
}

function initialForm(incident: IncidentItem | null): FormState {
  if (incident === null) {
    return {
      kind: 'INCIDENT',
      severity: 'MAJOR',
      title: '',
      description: '',
      customerMessage: '',
      targets: [],
      stopSales: false,
      adminBanner: true,
      scheduledStartAt: '',
      scheduledEndAt: '',
    };
  }
  return {
    kind: incident.kind,
    severity: incident.severity,
    title: incident.title,
    description: incident.description,
    customerMessage: incident.customerMessage ?? '',
    targets: [...incident.targets],
    stopSales: incident.stopSales,
    adminBanner: incident.adminBanner,
    scheduledStartAt: toLocalInput(incident.scheduledStartAt),
    scheduledEndAt: toLocalInput(incident.scheduledEndAt),
  };
}

/** The request body a form state stands for: one function, so create and edit agree. */
export function formBody(form: FormState, startEditable: boolean) {
  const message = form.customerMessage.trim();
  return {
    kind: form.kind,
    severity: form.severity,
    title: form.title.trim(),
    description: form.description.trim(),
    customerMessage: message === '' ? null : message,
    targets: form.targets,
    stopSales: form.stopSales,
    adminBanner: form.adminBanner,
    scheduledStartAt: startEditable ? fromLocalInput(form.scheduledStartAt) : null,
    scheduledEndAt: fromLocalInput(form.scheduledEndAt),
  };
}

function IncidentFormModal({
  incident,
  onClose,
  onSaved,
}: {
  incident: IncidentItem | null;
  onClose: () => void;
  onSaved: (saved: IncidentItem) => void;
}) {
  const [form, setForm] = useState<FormState>(() => initialForm(incident));
  const queries = useQueryClient();
  const toast = useToast();
  const submission = useSubmissionKey();
  // An ACTIVE incident has started; its start is history, not a field.
  const startEditable = incident === null || incident.status === 'SCHEDULED';
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((previous) => ({ ...previous, [key]: value }));
  const save = useMutation({
    mutationFn: () => {
      const body = formBody(form, startEditable);
      if (incident === null) {
        return createIncident({ ...body, idempotencyKey: submission.current(body) });
      }
      const edit = { ...body, id: incident.id, expectedVersion: incident.version };
      return updateIncident({ ...edit, idempotencyKey: submission.current(edit) });
    },
    onSuccess: async (result) => {
      submission.settle();
      toast({ tone: 'ok', message: t(incident === null ? 'web.inc_created' : 'web.inc_saved') });
      await refresh(queries, result.incident.id);
      onSaved(result.incident);
      onClose();
    },
    // A 409 means the incident changed since it was read: re-read it and keep the typing, so
    // the next save carries the fresh version instead of being refused the same way again.
    onError: (error: unknown) =>
      submission.settleOn(error, {
        onConflict: () => {
          if (incident !== null) void refresh(queries, incident.id);
        },
      }),
  });
  const close = () => {
    if (!save.isPending) onClose();
  };
  const valid = form.title.trim().length > 0;
  return (
    <Modal
      open
      onClose={close}
      title={incident === null ? t('web.inc_new') : t('web.inc_edit')}
      foot={
        <>
          <Button
            variant="primary"
            size="sm"
            disabled={!valid || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? t('web.working') : t('web.inc_save')}
          </Button>
          <Button size="sm" disabled={save.isPending} onClick={close}>
            {t('web.user_action_cancel')}
          </Button>
        </>
      }
    >
      {save.isError && (
        <Banner tone="danger" role="alert">
          {incidentMessageFor(save.error)}
        </Banner>
      )}
      <div className="incident-form">
        <Field label={t('web.inc_col_kind')} htmlFor="inc-kind">
          <Select
            id="inc-kind"
            value={form.kind}
            onChange={(event) => set('kind', event.target.value as IncidentKind)}
          >
            {INCIDENT_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(INCIDENT_KIND_LABELS[kind])}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('web.inc_col_severity')} htmlFor="inc-severity">
          <Select
            id="inc-severity"
            value={form.severity}
            onChange={(event) => set('severity', event.target.value as IncidentSeverity)}
          >
            {INCIDENT_SEVERITIES.map((severity) => (
              <option key={severity} value={severity}>
                {t(INCIDENT_SEVERITY_LABELS[severity])}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label={t('web.inc_col_title')} htmlFor="inc-title" required>
        <Input
          id="inc-title"
          value={form.title}
          maxLength={INCIDENT_TITLE_MAX_LENGTH}
          onChange={(event) => set('title', event.target.value)}
        />
      </Field>
      <Field
        label={t('web.inc_description')}
        hint={t('web.inc_description_hint')}
        htmlFor="inc-desc"
      >
        <Textarea
          id="inc-desc"
          value={form.description}
          maxLength={INCIDENT_DESCRIPTION_MAX_LENGTH}
          onChange={(event) => set('description', event.target.value)}
        />
      </Field>
      <Field
        label={t('web.inc_customer_message')}
        hint={t('web.inc_customer_message_hint')}
        htmlFor="inc-message"
      >
        <Textarea
          id="inc-message"
          value={form.customerMessage}
          maxLength={INCIDENT_CUSTOMER_MESSAGE_MAX_LENGTH}
          onChange={(event) => set('customerMessage', event.target.value)}
        />
      </Field>
      <div className="incident-form">
        {startEditable && (
          <Field
            label={t('web.inc_scheduled_start')}
            hint={t('web.inc_scheduled_start_hint')}
            htmlFor="inc-start"
          >
            <Input
              id="inc-start"
              type="datetime-local"
              value={form.scheduledStartAt}
              onChange={(event) => set('scheduledStartAt', event.target.value)}
            />
          </Field>
        )}
        <Field label={t('web.inc_scheduled_end')} htmlFor="inc-end">
          <Input
            id="inc-end"
            type="datetime-local"
            value={form.scheduledEndAt}
            onChange={(event) => set('scheduledEndAt', event.target.value)}
          />
        </Field>
      </div>
      <TargetsEditor targets={form.targets} onChange={(next) => set('targets', next)} />
      <Checkbox
        label={t('web.inc_stop_sales')}
        checked={form.stopSales}
        onChange={(next) => set('stopSales', next)}
      />
      {form.stopSales && <p className="faint small">{t('web.inc_stop_sales_hint')}</p>}
      <Checkbox
        label={t('web.inc_admin_banner')}
        checked={form.adminBanner}
        onChange={(next) => set('adminBanner', next)}
      />
    </Modal>
  );
}

interface TargetOption {
  readonly ref: string;
  readonly label: string;
}

/** A picker's whole list, by the server's keyset: bounded, so a loop can never run away. */
export const TARGET_PICKER_MAX_PAGES = 50;

export async function walkPages(
  fetchPage: (
    cursor: string | null,
  ) => Promise<{ readonly items: readonly TargetOption[]; readonly nextCursor: string | null }>,
): Promise<readonly TargetOption[]> {
  const all: TargetOption[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < TARGET_PICKER_MAX_PAGES; page += 1) {
    const next = await fetchPage(cursor);
    all.push(...next.items);
    if (next.nextCursor === null) break;
    cursor = next.nextCursor;
  }
  return all;
}

/**
 * The options for one target kind, from the module that owns them. When the operator may
 * not list that module, the picker falls back to a typed reference, which the server
 * checks exactly as it checks a picked one.
 */
function useTargetOptions(kind: IncidentTargetKind) {
  return useQuery({
    queryKey: ['incident-target-options', kind],
    queryFn: async (): Promise<readonly TargetOption[]> => {
      switch (kind) {
        case 'PANEL':
          return walkPages(async (cursor) => {
            const page = await fetchPanels({ limit: 100, ...(cursor === null ? {} : { cursor }) });
            return {
              items: page.panels.map((panel) => ({ ref: panel.id, label: panel.name })),
              nextCursor: page.nextCursor,
            };
          });
        case 'LOCATION':
          return (await fetchServiceLocations()).locations.map((location) => ({
            ref: location.id,
            label: `${location.label} (${location.locationKey})`,
          }));
        case 'PRODUCT':
          // Every page, not the first (Codex, #162): a product past the hundredth was not
          // offered, and could only be typed by its id.
          return walkPages(async (cursor) => {
            const page = await fetchProducts({
              limit: 100,
              ...(cursor === null ? {} : { cursor }),
            });
            return {
              items: page.products.map((product) => ({ ref: product.id, label: product.title })),
              nextCursor: page.nextCursor,
            };
          });
        case 'GATEWAY':
          return (await fetchPaymentGateways()).gateways.map((gateway) => ({
            ref: gateway.provider,
            label: gateway.displayName ?? gateway.provider,
          }));
      }
    },
    retry: false,
  });
}

function TargetsEditor({
  targets,
  onChange,
}: {
  targets: readonly IncidentTarget[];
  onChange: (next: IncidentTarget[]) => void;
}) {
  const [kind, setKind] = useState<IncidentTargetKind>('PANEL');
  const [ref, setRef] = useState('');
  const options = useTargetOptions(kind);
  const candidate: IncidentTarget = { kind, ref: ref.trim() };
  const duplicate = targets.some((target) => target.kind === kind && target.ref === candidate.ref);
  const addable =
    candidate.ref !== '' &&
    isValidIncidentTarget(candidate) &&
    !duplicate &&
    targets.length < INCIDENT_TARGETS_MAX;
  const labelOf = (target: IncidentTarget) =>
    target.kind === kind
      ? (options.data?.find((option) => option.ref === target.ref)?.label ?? target.ref)
      : target.ref;
  return (
    <fieldset className="incident-targets-editor">
      <legend>{t('web.inc_scope')}</legend>
      <p className="faint small">{t('web.inc_scope_hint')}</p>
      {targets.length > 0 && (
        <ul className="incident-targets">
          {targets.map((target) => (
            <li key={`${target.kind}:${target.ref}`}>
              <Badge tone="neutral">{t(INCIDENT_TARGET_LABELS[target.kind])}</Badge>{' '}
              <Ltr>{labelOf(target)}</Ltr>{' '}
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  onChange(
                    targets.filter(
                      (other) => !(other.kind === target.kind && other.ref === target.ref),
                    ),
                  )
                }
              >
                {t('web.inc_target_remove')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="incident-form">
        <Field label={t('web.inc_target_kind')} htmlFor="inc-target-kind">
          <Select
            id="inc-target-kind"
            value={kind}
            onChange={(event) => {
              setKind(event.target.value as IncidentTargetKind);
              setRef('');
            }}
          >
            {INCIDENT_TARGET_KINDS.map((option) => (
              <option key={option} value={option}>
                {t(INCIDENT_TARGET_LABELS[option])}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('web.inc_target_ref')} htmlFor="inc-target-ref">
          {options.data !== undefined && options.data.length > 0 ? (
            <Select
              id="inc-target-ref"
              value={ref}
              onChange={(event) => setRef(event.target.value)}
            >
              <option value="">{t('web.inc_target_choose')}</option>
              {options.data.map((option) => (
                <option key={option.ref} value={option.ref}>
                  {option.label}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              id="inc-target-ref"
              dir="ltr"
              value={ref}
              onChange={(event) => setRef(event.target.value)}
            />
          )}
        </Field>
      </div>
      <Button
        size="sm"
        disabled={!addable}
        onClick={() => {
          onChange([...targets, candidate]);
          setRef('');
        }}
      >
        {t('web.inc_target_add')}
      </Button>
    </fieldset>
  );
}
