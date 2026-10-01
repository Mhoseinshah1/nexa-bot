import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PANEL_CUSTOMER_ACTIONS,
  PANEL_DELIVERY_MODES,
  panelPolicySchema,
  type CapabilityGap,
  type CapabilityRegistryRow,
  type CredentialShape,
  type CustomerAvailabilityBlocker,
  type DiagnosticVerdict,
  type PanelAdvancedResponse,
  type PanelCustomerAction,
  type PanelDeliveryMode,
  type PanelDiagnosticCheck,
  type PanelDiagnosticOverall,
  type PanelPolicy,
  type PanelSummaryResponse,
  type ProviderFailureKind,
  type ProviderRules,
} from '@nexa/contracts';
import {
  ApiError,
  fetchPanelAdvanced,
  fetchPanelTechnical,
  updatePanelPolicy,
} from '../api/client';
import { formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { useSubmissionKey } from '../submission-key';
import {
  Badge,
  Banner,
  Card,
  DataTable,
  Field,
  KV,
  Ltr,
  StateSwitch,
  useToast,
  type Tone,
} from '../ui/kit';
import { messageFor } from './settings';
import { pollUnlessFinal } from '../polling';

/**
 * Advanced provider settings (WP-A8), as an operator reads them.
 *
 * Every verdict on this screen is the SERVER's: the registry is derived from the
 * adapter, the customer availability from the registry and the policy, the diagnostics
 * from the stored health. This file maps each to Persian and decides nothing — a
 * second opinion here would be a screen that says "supported" about something the
 * server refuses, which is the defect the registry exists to end.
 */

/** The panel read's own cache prefix, so a connection test refreshes this too. */
export const advancedKey = (panelId: string) => ['panel', panelId, 'advanced'] as const;
/** The technical view's cache, under the same prefix. */
export const technicalKey = (panelId: string) => ['panel', panelId, 'technical'] as const;

// --- labels -------------------------------------------------------------------

export const REGISTRY_ROW_LABELS: Readonly<Record<CapabilityRegistryRow, WebKey>> = {
  CREATE_SERVICE: 'web.cap_row_create_service',
  RENEW: 'web.cap_row_renew',
  ADD_TRAFFIC: 'web.cap_row_add_traffic',
  ADD_TIME: 'web.cap_row_add_time',
  RESET_TRAFFIC: 'web.cap_row_reset_traffic',
  DISABLE_ENABLE: 'web.cap_row_disable_enable',
  ROTATE_SUBSCRIPTION: 'web.cap_row_rotate_subscription',
  SUBSCRIPTION_FILES: 'web.cap_row_subscription_files',
  EXTRA_DEVICES: 'web.cap_row_extra_devices',
  LOCATION_CHANGE: 'web.cap_row_location_change',
  USAGE_READ: 'web.cap_row_usage_read',
  TERMINATE: 'web.cap_row_terminate',
};

const REGISTRY_ROW_HINTS: Readonly<Record<CapabilityRegistryRow, WebKey>> = {
  CREATE_SERVICE: 'web.cap_row_create_service_hint',
  RENEW: 'web.cap_row_renew_hint',
  ADD_TRAFFIC: 'web.cap_row_add_traffic_hint',
  ADD_TIME: 'web.cap_row_add_time_hint',
  RESET_TRAFFIC: 'web.cap_row_reset_traffic_hint',
  DISABLE_ENABLE: 'web.cap_row_disable_enable_hint',
  ROTATE_SUBSCRIPTION: 'web.cap_row_rotate_subscription_hint',
  SUBSCRIPTION_FILES: 'web.cap_row_subscription_files_hint',
  EXTRA_DEVICES: 'web.cap_row_extra_devices_hint',
  LOCATION_CHANGE: 'web.cap_row_location_change_hint',
  USAGE_READ: 'web.cap_row_usage_read_hint',
  TERMINATE: 'web.cap_row_terminate_hint',
};

const GAP_LABELS: Readonly<Record<CapabilityGap, WebKey>> = {
  NOT_DECLARED: 'web.cap_gap_not_declared',
  NOT_IMPLEMENTED: 'web.cap_gap_not_implemented',
  NOT_SUPPORTED: 'web.cap_gap_not_supported',
  NOT_IN_RELEASE: 'web.cap_gap_not_in_release',
};

const BLOCKER_LABELS: Readonly<Record<CustomerAvailabilityBlocker, WebKey>> = {
  UNSUPPORTED: 'web.cap_blocker_unsupported',
  POLICY_DISABLED: 'web.cap_blocker_policy_disabled',
  POLICY_UNREADABLE: 'web.cap_blocker_policy_unreadable',
  TENANT_FEATURE_OFF: 'web.cap_blocker_tenant_feature_off',
};

const DELIVERY_LABELS: Readonly<Record<PanelDeliveryMode, WebKey>> = {
  CARD_WITH_QR: 'web.policy_delivery_card_with_qr',
  CARD_TEXT: 'web.policy_delivery_card_text',
};

export const CREDENTIAL_SHAPE_LABELS: Readonly<Record<CredentialShape, WebKey>> = {
  USERNAME_PASSWORD: 'web.credential_shape_username_password',
  OPAQUE_TOKEN: 'web.credential_shape_opaque_token',
  TOKEN_OR_USERNAME_PASSWORD: 'web.credential_shape_token_or_username_password',
  NONE: 'web.credential_shape_none',
};

/** Activation field names, as a person reads them. Unknown names fall back to LTR. */
export const ACTIVATION_FIELD_LABELS: Readonly<Record<string, WebKey>> = {
  proxyProtocols: 'web.panel_proxy_protocols',
  inboundTags: 'web.panel_inbound_tags',
  subscriptionDomain: 'web.panel_subscription_domain',
  inboundId: 'web.panel_inbound_id',
};

const CHECK_LABELS: Readonly<Record<PanelDiagnosticCheck, WebKey>> = {
  CONNECTIVITY: 'web.diag_check_connectivity',
  CREDENTIALS: 'web.diag_check_credentials',
  AUTHENTICATION: 'web.diag_check_authentication',
  PROVIDER_STATUS: 'web.diag_check_provider_status',
  CONFIGURATION: 'web.diag_check_configuration',
  CONNECTION_TEST: 'web.diag_check_connection_test',
  FRESHNESS: 'web.diag_check_freshness',
  REQUIRED_CAPABILITIES: 'web.diag_check_required_capabilities',
};

const VERDICT_LABELS: Readonly<Record<DiagnosticVerdict, WebKey>> = {
  PASS: 'web.diag_verdict_pass',
  WARN: 'web.diag_verdict_warn',
  FAIL: 'web.diag_verdict_fail',
  UNKNOWN: 'web.diag_verdict_unknown',
};

const VERDICT_TONES: Readonly<Record<DiagnosticVerdict, Tone>> = {
  PASS: 'ok',
  WARN: 'warn',
  FAIL: 'danger',
  UNKNOWN: 'neutral',
};

const OVERALL_LABELS: Readonly<Record<PanelDiagnosticOverall, WebKey>> = {
  OK: 'web.diag_overall_ok',
  DEGRADED: 'web.diag_overall_degraded',
  ERROR: 'web.diag_overall_error',
  NOT_CHECKED: 'web.diag_overall_not_checked',
  DISABLED: 'web.diag_overall_disabled',
};

const OVERALL_TONES: Readonly<Record<PanelDiagnosticOverall, Tone>> = {
  OK: 'ok',
  DEGRADED: 'warn',
  ERROR: 'danger',
  NOT_CHECKED: 'info',
  DISABLED: 'neutral',
};

/** Every failure kind, with the one remedy it maps to (`provider.ts`). */
export const FAILURE_LABELS: Readonly<Record<ProviderFailureKind, WebKey>> = {
  AUTHENTICATION_FAILED: 'web.diag_failure_authentication_failed',
  AUTHENTICATION_REQUIRES_INTERACTION: 'web.diag_failure_authentication_requires_interaction',
  UNREACHABLE: 'web.diag_failure_unreachable',
  TIMEOUT: 'web.diag_failure_timeout',
  TLS_FAILED: 'web.diag_failure_tls_failed',
  BLOCKED_TARGET: 'web.diag_failure_blocked_target',
  RATE_LIMITED: 'web.diag_failure_rate_limited',
  MALFORMED_RESPONSE: 'web.diag_failure_malformed_response',
  PROVIDER_ERROR: 'web.diag_failure_provider_error',
  PROVIDER_REFUSED: 'web.diag_failure_provider_refused',
  UNSUPPORTED_CAPABILITY: 'web.diag_failure_unsupported_capability',
};

const REQUIRED_CAPABILITY_LABELS: Readonly<Record<string, WebKey>> = {
  HEALTH_CHECK: 'web.diag_capability_health_check',
  CREATE_USER: 'web.diag_capability_create_user',
  DELIVER_SUBSCRIPTION_LINK: 'web.diag_capability_deliver_subscription_link',
  READ_USAGE: 'web.diag_capability_read_usage',
};

const RULE_VALUE_LABELS: {
  readonly [K in keyof ProviderRules]: Readonly<Record<ProviderRules[K], WebKey>>;
} = {
  trafficReset: { NEVER: 'web.prule_traffic_reset_never' },
  protocols: {
    OPERATOR_CHOSEN: 'web.prule_protocols_operator_chosen',
    PANEL_ASSIGNED: 'web.prule_protocols_panel_assigned',
    INBOUND_DEFINED: 'web.prule_protocols_inbound_defined',
  },
  inbounds: {
    OPERATOR_TAGS: 'web.prule_inbounds_operator_tags',
    OPERATOR_INBOUND_ID: 'web.prule_inbounds_operator_inbound_id',
    PANEL_ASSIGNED: 'web.prule_inbounds_panel_assigned',
  },
  subscriptionLink: {
    PANEL_ISSUED: 'web.prule_subscription_link_panel_issued',
    SUBSCRIPTION_DOMAIN: 'web.prule_subscription_link_subscription_domain',
  },
  deviceLimitOnCreate: {
    FROM_PRODUCT: 'web.prule_device_limit_from_product',
    NOT_SENT: 'web.prule_device_limit_not_sent',
  },
};

const RULE_LABELS: Readonly<Record<keyof ProviderRules, WebKey>> = {
  trafficReset: 'web.prule_traffic_reset',
  protocols: 'web.prule_protocols',
  inbounds: 'web.prule_inbounds',
  subscriptionLink: 'web.prule_subscription_link',
  deviceLimitOnCreate: 'web.prule_device_limit',
};

// --- the knobs ----------------------------------------------------------------

/**
 * The one extra field each customer action has, if any, and its label.
 *
 * The same set `panelPolicySchema` accepts per action, restated here only to draw the
 * input — the schema below is what decides whether the value is sent.
 */
type Knob = 'cooldownMinutes' | 'maxTrafficGb' | 'maxDays' | 'maxDeviceLimit';

const KNOBS: Readonly<
  Partial<Record<PanelCustomerAction, { field: Knob; label: WebKey; hint: WebKey }>>
> = {
  ADD_TRAFFIC: {
    field: 'maxTrafficGb',
    label: 'web.policy_max_traffic_gb',
    hint: 'web.policy_limit_hint',
  },
  ADD_TIME: { field: 'maxDays', label: 'web.policy_max_days', hint: 'web.policy_limit_hint' },
  EXTRA_DEVICES: {
    field: 'maxDeviceLimit',
    label: 'web.policy_max_device_limit',
    hint: 'web.policy_limit_hint',
  },
  ROTATE_SUBSCRIPTION: {
    field: 'cooldownMinutes',
    label: 'web.policy_cooldown_minutes',
    hint: 'web.policy_cooldown_hint',
  },
  USAGE_READ: {
    field: 'cooldownMinutes',
    label: 'web.policy_cooldown_minutes',
    hint: 'web.policy_cooldown_hint',
  },
};

/**
 * Customer actions whose switch is DRAWN even on a panel that cannot perform them —
 * disabled, with the server's reason beside it — rather than left out (HF-A6A8).
 *
 * «تغییر لوکیشن سرویس» is the one the owner asked to see on every panel: no provider
 * declares `LOCATION_CHANGE` in this release, and an operator looking for the switch
 * should learn that the panel cannot move an account rather than wonder where it went.
 * A disabled control is never a promise: it sends nothing (`policyFrom` sends a stored
 * entry back unchanged, which is all the server accepts for an unsupported action).
 */
const SHOWN_WHEN_UNSUPPORTED: readonly PanelCustomerAction[] = ['LOCATION_CHANGE'];

interface ActionDraft {
  readonly customerEnabled: boolean;
  /** The knob, as TEXT: '' is "no extra limit", which the API spells null. */
  readonly knob: string;
}

function draftFrom(policy: PanelPolicy, actions: readonly PanelCustomerAction[]) {
  const draft: Partial<Record<PanelCustomerAction, ActionDraft>> = {};
  for (const action of actions) {
    const stored = policy.actions[action] as
      ({ customerEnabled: boolean } & Partial<Record<Knob, number | null>>) | undefined;
    const knob = KNOBS[action];
    const value = knob === undefined ? null : (stored?.[knob.field] ?? null);
    draft[action] = {
      customerEnabled: stored?.customerEnabled ?? true,
      knob: value === null ? '' : String(value),
    };
  }
  return draft;
}

/**
 * The draft as the policy the API stores, naming ONLY supported actions and only those
 * an operator moved off the default — so an untouched form is the default policy and
 * its save is the server's no-op.
 */
function policyFrom(
  mode: PanelDeliveryMode,
  draft: Partial<Record<PanelCustomerAction, ActionDraft>>,
  kept: PanelPolicy['actions'],
): Record<string, unknown> {
  const actions: Record<string, unknown> = {};
  for (const action of PANEL_CUSTOMER_ACTIONS) {
    const entry = draft[action];
    if (entry === undefined) {
      /*
       * An action the adapter cannot perform NOW has no control, and its stored entry is
       * sent back exactly as stored — so a restriction an operator set survives a
       * capability that disappeared, and saving an unrelated field does not drop it. The
       * server accepts such an entry only when it is unchanged.
       */
      if (kept[action] !== undefined) actions[action] = kept[action];
      continue;
    }
    const knob = KNOBS[action];
    const raw = entry.knob.trim();
    if (entry.customerEnabled && (knob === undefined || raw === '')) continue;
    actions[action] = {
      customerEnabled: entry.customerEnabled,
      // `Number.NaN` for anything that is not digits, so the schema refuses it by path
      // rather than this file guessing what was meant.
      ...(knob === undefined
        ? {}
        : { [knob.field]: raw === '' ? null : /^\d+$/.test(raw) ? Number(raw) : Number.NaN }),
    };
  }
  return { delivery: { mode }, actions };
}

// --- the tab ------------------------------------------------------------------

export function CapabilitiesTab({
  panel,
  mayEdit,
  mayViewTechnical,
}: {
  panel: PanelSummaryResponse;
  mayEdit: boolean;
  mayViewTechnical: boolean;
}) {
  const advanced = useQuery({
    queryKey: advancedKey(panel.id),
    queryFn: () => fetchPanelAdvanced(panel.id),
  });
  const data = advanced.data;
  return (
    <StateSwitch query={advanced}>
      {data !== undefined && (
        <>
          <RegistryCard advanced={data} />
          <PolicyCard
            // Re-seeded from the server whenever a save (anyone's) moves the revision.
            key={`${String(data.policy.revision)}:${String(data.policy.readable)}`}
            advanced={data}
            mayEdit={mayEdit && panel.status !== 'ARCHIVED'}
          />
          <ProviderRulesCard advanced={data} panel={panel} />
          {mayViewTechnical && <TechnicalCard panelId={panel.id} />}
        </>
      )}
    </StateSwitch>
  );
}

function RegistryCard({ advanced }: { advanced: PanelAdvancedResponse }) {
  return (
    <Card title={t('web.cap_registry_title')} hint={t('web.capabilities_hint')}>
      <DataTable
        caption={t('web.cap_registry_title')}
        rows={advanced.registry}
        rowKey={(row) => row.row}
        columns={[
          {
            key: 'name',
            header: t('web.capability'),
            render: (row) => (
              <span title={t(REGISTRY_ROW_HINTS[row.row])}>{t(REGISTRY_ROW_LABELS[row.row])}</span>
            ),
          },
          {
            key: 'support',
            header: t('web.cap_support'),
            render: (row) =>
              row.supported ? (
                <Badge tone="ok">{t('web.cap_supported')}</Badge>
              ) : (
                <Badge
                  tone="neutral"
                  {...(row.gap === null ? {} : { title: t(GAP_LABELS[row.gap]) })}
                >
                  {t('web.cap_unsupported')}
                </Badge>
              ),
          },
          {
            key: 'why',
            header: t('web.detail'),
            render: (row) =>
              row.gap === null ? (
                <span className="faint">—</span>
              ) : (
                <span className="small">{t(GAP_LABELS[row.gap])}</span>
              ),
          },
          {
            key: 'customer',
            header: t('web.cap_customer'),
            render: (row) =>
              row.customer === null ? (
                <span className="faint small">{t('web.cap_customer_operator_only')}</span>
              ) : row.customer.available ? (
                <Badge tone="ok">{t('web.cap_customer_available')}</Badge>
              ) : (
                <Badge tone="warn">
                  {t(BLOCKER_LABELS[row.customer.blocker ?? 'UNSUPPORTED'])}
                </Badge>
              ),
          },
        ]}
      />
      <p className="faint small">{t('web.cap_customer_hint')}</p>
    </Card>
  );
}

function PolicyCard({ advanced, mayEdit }: { advanced: PanelAdvancedResponse; mayEdit: boolean }) {
  const client = useQueryClient();
  const toast = useToast();
  const submission = useSubmissionKey();
  // Only what the adapter supports is offered a control at all.
  const actions = PANEL_CUSTOMER_ACTIONS.filter((action) =>
    advanced.registry.some((entry) => entry.row === action && entry.supported),
  );
  // Shown, disabled, with the registry's own reason (the gap), never enabled here.
  const unsupportedShown = SHOWN_WHEN_UNSUPPORTED.flatMap((action) => {
    const entry = advanced.registry.find((candidate) => candidate.row === action);
    return entry === undefined || entry.supported ? [] : [{ action, gap: entry.gap }];
  });
  const [mode, setMode] = useState<PanelDeliveryMode>(advanced.policy.policy.delivery.mode);
  const [draft, setDraft] = useState(() => draftFrom(advanced.policy.policy, actions));
  const [invalid, setInvalid] = useState<readonly string[]>([]);

  const save = useMutation({
    mutationFn: (policy: PanelPolicy) =>
      updatePanelPolicy({
        id: advanced.panelId,
        policy,
        expectedRevision: advanced.policy.revision,
        idempotencyKey: submission.current({
          command: 'panels.policy',
          id: advanced.panelId,
          expectedRevision: advanced.policy.revision,
          policy,
        }),
      }),
    onSuccess: (result) => {
      submission.settle();
      toast({
        tone: result.changed ? 'ok' : 'info',
        message: result.changed ? t('web.saved') : t('web.unchanged'),
      });
      client.setQueryData(advancedKey(advanced.panelId), result.advanced);
      // The technical view shows the stored policy too; an open one must not go on
      // showing the policy this save replaced.
      void client.invalidateQueries({ queryKey: technicalKey(advanced.panelId) });
    },
    onError: async (error: unknown) => {
      submission.settleOn(error);
      if (error instanceof ApiError && error.code === 'panel.policy_stale') {
        toast({ tone: 'warn', message: t('web.policy_stale') });
        await client.invalidateQueries({ queryKey: advancedKey(advanced.panelId) });
        return;
      }
      toast({ tone: 'danger', message: messageFor(error) });
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    // An unreadable stored policy has nothing to keep: the form shows the default.
    const kept = advanced.policy.readable ? advanced.policy.policy.actions : {};
    const parsed = panelPolicySchema.safeParse(policyFrom(mode, draft, kept));
    if (!parsed.success) {
      setInvalid([...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))]);
      return;
    }
    setInvalid([]);
    save.mutate(parsed.data);
  };

  const editable = mayEdit && !save.isPending;
  return (
    <Card title={t('web.policy_title')} hint={t('web.policy_hint')}>
      {!advanced.policy.readable && (
        <Banner tone="danger" title={t('web.policy_unreadable')}>
          {t('web.policy_unreadable_body')}
        </Banner>
      )}
      {!mayEdit && <p className="faint small">{t('web.policy_read_only')}</p>}
      <form onSubmit={onSubmit} className="stack-sm">
        {actions.length === 0 && <p className="faint small">{t('web.policy_no_actions')}</p>}
        {actions.map((action) => {
          const entry = draft[action] ?? { customerEnabled: true, knob: '' };
          const knob = KNOBS[action];
          const inputId = `policy-${action}`;
          return (
            <div key={action}>
              <p className="field-group-head">{t(REGISTRY_ROW_LABELS[action])}</p>
              <label className="check">
                <input
                  type="checkbox"
                  disabled={!editable}
                  checked={entry.customerEnabled}
                  aria-label={`${t('web.policy_customer_enabled')} — ${t(REGISTRY_ROW_LABELS[action])}`}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      [action]: { ...entry, customerEnabled: event.target.checked },
                    })
                  }
                />
                {t('web.policy_customer_enabled')}
              </label>
              {knob !== undefined && (
                <Field label={t(knob.label)} hint={t(knob.hint)} htmlFor={inputId}>
                  <input
                    id={inputId}
                    className="input"
                    dir="ltr"
                    inputMode="numeric"
                    disabled={!editable}
                    value={entry.knob}
                    onChange={(event) =>
                      setDraft({ ...draft, [action]: { ...entry, knob: event.target.value } })
                    }
                  />
                </Field>
              )}
            </div>
          );
        })}
        {unsupportedShown.map(({ action, gap }) => (
          <div key={action}>
            <p className="field-group-head">{t(REGISTRY_ROW_LABELS[action])}</p>
            <label className="check">
              <input
                type="checkbox"
                disabled
                checked={false}
                readOnly
                aria-label={`${t('web.policy_customer_enabled')} — ${t(REGISTRY_ROW_LABELS[action])}`}
              />
              {t('web.policy_customer_enabled')}
            </label>
            <p className="faint small">
              {t('web.policy_action_unsupported')} {t(GAP_LABELS[gap ?? 'NOT_SUPPORTED'])}
            </p>
          </div>
        ))}
        <Field label={t('web.policy_delivery')} hint={t('web.policy_delivery_hint')}>
          <div className="stack-sm">
            {PANEL_DELIVERY_MODES.map((candidate) => (
              <label key={candidate} className="check">
                <input
                  type="radio"
                  name={`delivery-${advanced.panelId}`}
                  disabled={!editable}
                  checked={mode === candidate}
                  onChange={() => setMode(candidate)}
                />
                {t(DELIVERY_LABELS[candidate])}
              </label>
            ))}
          </div>
        </Field>
        {invalid.length > 0 && (
          <Banner tone="danger" title={t('web.policy_invalid')}>
            <Ltr>{invalid.join(', ')}</Ltr>
          </Banner>
        )}
        <KV
          items={[
            [t('web.policy_revision'), <Ltr key="r">{String(advanced.policy.revision)}</Ltr>],
            [
              t('web.updated_at'),
              advanced.policy.updatedAt === null ? '—' : formatTimestamp(advanced.policy.updatedAt),
            ],
          ]}
        />
        {mayEdit && (
          <div className="btn-group">
            <button type="submit" className="btn primary" disabled={save.isPending}>
              {save.isPending ? t('web.saving') : t('web.save')}
            </button>
          </div>
        )}
      </form>
    </Card>
  );
}

function ProviderRulesCard({
  advanced,
  panel,
}: {
  advanced: PanelAdvancedResponse;
  panel: PanelSummaryResponse;
}) {
  const rules = advanced.providerRules;
  const ruleRow = <K extends keyof ProviderRules>(key: K): [string, string] => [
    t(RULE_LABELS[key]),
    t((RULE_VALUE_LABELS[key] as Readonly<Record<string, WebKey>>)[rules[key]] as WebKey),
  ];
  const activation = panel.activation;
  const configured =
    activation === null
      ? []
      : Object.entries(activation).map(([field, value]): [ReactNode, ReactNode] => [
          ACTIVATION_FIELD_LABELS[field] === undefined ? (
            <Ltr key={field}>{field}</Ltr>
          ) : (
            t(ACTIVATION_FIELD_LABELS[field] as WebKey)
          ),
          <Ltr key={`${field}-value`}>{summarise(value)}</Ltr>,
        ]);
  return (
    <Card title={`${t('web.prule_title')} — ${advanced.providerName}`} hint={t('web.prule_hint')}>
      <KV
        items={[
          ruleRow('trafficReset'),
          ruleRow('protocols'),
          ruleRow('inbounds'),
          ruleRow('subscriptionLink'),
          ruleRow('deviceLimitOnCreate'),
        ]}
      />
      <p className="field-group-head">{t('web.prule_current')}</p>
      {rules.inbounds === 'PANEL_ASSIGNED' ? (
        <p className="faint small">{t('web.prule_nothing_to_configure')}</p>
      ) : configured.length === 0 ? (
        <p className="faint small">{t('web.prule_not_configured')}</p>
      ) : (
        <KV items={configured} />
      )}
      <p className="faint small">{t('web.prule_location_note')}</p>
    </Card>
  );
}

/** A stored activation value, flattened for reading. Never a credential: it has none. */
function summarise(value: unknown): string {
  if (Array.isArray(value)) return value.map(summarise).join(', ');
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, inner]) => `${key}: ${summarise(inner)}`)
      .join(' · ');
  }
  return String(value);
}

function TechnicalCard({ panelId }: { panelId: string }) {
  const [open, setOpen] = useState(false);
  const technical = useQuery({
    queryKey: technicalKey(panelId),
    queryFn: () => fetchPanelTechnical(panelId),
    enabled: open,
  });
  return (
    <Card
      title={t('web.tech_title')}
      hint={t('web.tech_hint')}
      actions={
        <button type="button" className="btn sm" onClick={() => setOpen(!open)}>
          {open ? t('web.tech_hide') : t('web.tech_show')}
        </button>
      }
    >
      {open && (
        <StateSwitch query={technical}>
          {technical.data !== undefined && (
            <pre className="ltr mono small" dir="ltr">
              {JSON.stringify(technical.data, null, 2)}
            </pre>
          )}
        </StateSwitch>
      )}
    </Card>
  );
}

// --- diagnostics ----------------------------------------------------------------

export function DiagnosticsCard({ panelId, refreshMs }: { panelId: string; refreshMs: number }) {
  const advanced = useQuery({
    queryKey: advancedKey(panelId),
    queryFn: () => fetchPanelAdvanced(panelId),
    /*
     * The diagnostics are a projection of the health the background monitor writes, so
     * they poll on the SAME cadence as the panel read beside them — otherwise the card
     * went on showing one probe's verdict while the health row below it moved on.
     */
    refetchInterval: pollUnlessFinal(refreshMs),
  });
  const diagnostics = advanced.data?.diagnostics;
  return (
    <Card title={t('web.diag_title')} hint={t('web.diag_hint')}>
      <StateSwitch query={advanced}>
        {diagnostics !== undefined && (
          <>
            <p>
              <Badge tone={OVERALL_TONES[diagnostics.overall]}>
                {t(OVERALL_LABELS[diagnostics.overall])}
              </Badge>
            </p>
            <DataTable
              caption={t('web.diag_title')}
              rows={diagnostics.checks}
              rowKey={(row) => row.check}
              columns={[
                {
                  key: 'check',
                  header: t('web.diag_check'),
                  render: (row) => t(CHECK_LABELS[row.check]),
                },
                {
                  key: 'verdict',
                  header: t('web.status'),
                  render: (row) => (
                    <Badge tone={VERDICT_TONES[row.verdict]}>
                      {t(VERDICT_LABELS[row.verdict])}
                    </Badge>
                  ),
                },
              ]}
            />
            <KV
              items={[
                [
                  t('web.diag_failure'),
                  diagnostics.failure === null ? '—' : t(FAILURE_LABELS[diagnostics.failure]),
                ],
                [
                  t('web.panel_last_check'),
                  diagnostics.lastCheckedAt === null
                    ? '—'
                    : formatTimestamp(diagnostics.lastCheckedAt),
                ],
                [
                  t('web.diag_last_success'),
                  diagnostics.lastSuccessfulCheckAt === null
                    ? '—'
                    : formatTimestamp(diagnostics.lastSuccessfulCheckAt),
                ],
                [
                  t('web.diag_missing_fields'),
                  diagnostics.missingActivationFields.length === 0
                    ? '—'
                    : diagnostics.missingActivationFields
                        .map((field) => {
                          const label = ACTIVATION_FIELD_LABELS[field.split('.')[0] ?? field];
                          return label === undefined ? field : t(label);
                        })
                        .join(t('web.list_separator')),
                ],
              ]}
            />
            <p className="field-group-head">{t('web.diag_required_title')}</p>
            <KV
              items={diagnostics.requiredCapabilities.map((entry): [string, ReactNode] => [
                REQUIRED_CAPABILITY_LABELS[entry.capability] === undefined
                  ? entry.capability
                  : t(REQUIRED_CAPABILITY_LABELS[entry.capability] as WebKey),
                entry.available ? (
                  <Badge key={entry.capability} tone="ok">
                    {t('web.diag_available')}
                  </Badge>
                ) : (
                  <Badge key={entry.capability} tone="danger">
                    {t('web.diag_missing')}
                  </Badge>
                ),
              ])}
            />
          </>
        )}
      </StateSwitch>
    </Card>
  );
}
