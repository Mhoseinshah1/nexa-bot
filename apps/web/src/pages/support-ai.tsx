import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  SUPPORT_AI_AUTO_MIN_CONFIDENCES,
  SUPPORT_AI_LIMITS,
  SUPPORT_AI_MODES,
  SUPPORT_AI_PROVIDERS,
  SUPPORT_AI_SAFE_TOPICS,
  SUPPORT_AI_SETTLE_DELAY_MAX_SECONDS,
  SUPPORT_AI_SETTLE_DELAY_MIN_SECONDS,
  supportAiConfigInputSchema,
  type SupportAiBreakerState,
  type SupportAiConfigInput,
  type SupportAiConfigResponse,
  type SupportAiCredentialView,
  type SupportAiMode,
  type SupportAiOperation,
  type SupportAiOutcomeKind,
  type SupportAiProvider,
  type SupportAiProviderStep,
  type SupportAiSafeTopic,
  type SupportAiTestResponse,
  type SupportAiUsageResponse,
} from '@nexa/contracts';
import {
  ApiError,
  deleteSupportAiCredential,
  fetchSupportAiConfig,
  fetchSupportAiUsage,
  saveSupportAiConfig,
  setSupportAiCredential,
  testSupportAiProvider,
} from '../api/client';
import { formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { useSubmissionKey } from '../submission-key';
import { messageFor } from './settings';
import {
  Badge,
  Banner,
  Card,
  ConfirmDialog,
  DataTable,
  Empty,
  Field,
  KV,
  Ltr,
  Num,
  PageHead,
  StateSwitch,
  useToast,
  useUnsavedChanges,
  type Column,
  type Tone,
} from '../ui/kit';
import { Icon } from '../ui/icons';
import {
  FAILURE_CLASS_LABELS,
  TEST_CHECK_LABELS,
  TEST_RESULT_LABELS,
  TEST_RESULT_TONES,
  failureParticulars,
} from './support-ai-failure';

/**
 * TB4 — the support AI's settings (ADR-0034 §8): the mode, the provider chain, the bounds,
 * each provider's key and connection test, and thirty days of usage.
 *
 * Nothing here decides anything. The server charges `support_ai.configure` for every read
 * and write, and ENTERING automatic replies additionally `support_ai.auto_reply`; the
 * `mayAutoReply` prop only decides whether a hint is drawn, and the server's refusal is
 * what the operator is shown when it is missing.
 *
 * A key is SET, never read back (ADR-0023). The page holds a typed key only in a password
 * field until it is sent, clears it on success, and renders nothing about a stored key but
 * its set-at timestamp, its region and its test state. There is no masked stand-in: a
 * `********` could be resubmitted as the real key.
 */

export const SUPPORT_AI_MODE_LABELS: Readonly<Record<SupportAiMode, WebKey>> = {
  OFF: 'web.sai_mode_off',
  ASSIST_ONLY: 'web.sai_mode_assist_only',
  AUTO_REPLY_SAFE: 'web.sai_mode_auto_reply_safe',
};

const MODE_EXPLAINED: Readonly<Record<SupportAiMode, WebKey>> = {
  OFF: 'web.sai_mode_off_hint',
  ASSIST_ONLY: 'web.sai_mode_assist_only_hint',
  AUTO_REPLY_SAFE: 'web.sai_mode_auto_reply_safe_hint',
};

const MODE_TONES: Readonly<Record<SupportAiMode, Tone>> = {
  OFF: 'neutral',
  ASSIST_ONLY: 'info',
  AUTO_REPLY_SAFE: 'warn',
};

export const SUPPORT_AI_PROVIDER_LABELS: Readonly<Record<SupportAiProvider, WebKey>> = {
  OPENAI: 'web.sai_provider_openai',
  ANTHROPIC: 'web.sai_provider_anthropic',
  ZAI: 'web.sai_provider_zai',
};

export const OUTCOME_LABELS: Readonly<Record<SupportAiOutcomeKind, WebKey>> = {
  OK: 'web.sai_outcome_ok',
  RATE_LIMITED: 'web.sai_outcome_rate_limited',
  AUTH_FAILED: 'web.sai_outcome_auth_failed',
  TEMPORARY: 'web.sai_outcome_temporary',
  INVALID_OUTPUT: 'web.sai_outcome_invalid_output',
  REFUSED_BY_PROVIDER: 'web.sai_outcome_refused',
  TIMEOUT: 'web.sai_outcome_timeout',
};

export const OUTCOME_TONES: Readonly<Record<SupportAiOutcomeKind, Tone>> = {
  OK: 'ok',
  RATE_LIMITED: 'warn',
  AUTH_FAILED: 'danger',
  TEMPORARY: 'warn',
  INVALID_OUTPUT: 'danger',
  REFUSED_BY_PROVIDER: 'danger',
  TIMEOUT: 'warn',
};

export const OPERATION_LABELS: Readonly<Record<SupportAiOperation, WebKey>> = {
  CONNECTION_TEST: 'web.sai_operation_connection_test',
  ASSIST_DRAFT: 'web.sai_operation_assist_draft',
  AUTO_DECISION: 'web.sai_operation_auto_decision',
  SUMMARY: 'web.sai_operation_summary',
  LEARNING_EXTRACT: 'web.sai_operation_learning_extract',
};

type Region = 'INTERNATIONAL' | 'CHINA';
/** TB10: the breaker as the server derived it at the read; the words say what it does. */
export const BREAKER_LABELS: Readonly<Record<SupportAiBreakerState, WebKey>> = {
  CLOSED: 'web.sai_breaker_closed',
  OPEN: 'web.sai_breaker_open',
  HALF_OPEN: 'web.sai_breaker_half_open',
};

const BREAKER_TONES: Readonly<Record<SupportAiBreakerState, Tone>> = {
  CLOSED: 'ok',
  OPEN: 'warn',
  HALF_OPEN: 'info',
};

const REGIONS: readonly Region[] = ['INTERNATIONAL', 'CHINA'];
const REGION_LABELS: Readonly<Record<Region, WebKey>> = {
  INTERNATIONAL: 'web.sai_region_international',
  CHINA: 'web.sai_region_china',
};

/** The refusals this page can name better than the server's English sentence. */
const FAULTS: Readonly<Record<string, WebKey>> = {
  'support_ai.version_conflict': 'web.sai_fault_conflict',
  'support_ai.credential_missing': 'web.sai_fault_credential_missing',
  'support_ai.unknown_provider': 'web.sai_fault_unknown_provider',
  'support_ai.region_not_applicable': 'web.sai_fault_region',
  'platform.idempotency_payload_mismatch': 'web.sai_fault_retry',
  'support_ai.test_too_soon': 'web.sai_fault_test_too_soon',
};

/**
 * A refusal in Persian. The guard names the permission it lacked in `details`, so a save
 * refused for `support_ai.auto_reply` says THAT — the operator holds `configure` (or the
 * page would not have loaded) and a bare «no permission» would read as a broken page.
 */
export function supportAiFault(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403 && error.details?.['permission'] === 'support_ai.auto_reply') {
      return t('web.sai_fault_auto_reply');
    }
    const key = FAULTS[error.code];
    if (key !== undefined) return t(key);
  }
  return messageFor(error);
}

function Dash() {
  return <span className="faint">—</span>;
}

// ---------------------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------------------

export function SupportAiPage({
  denied,
  mayAutoReply,
}: {
  denied: boolean;
  mayAutoReply: boolean;
}) {
  const config = useQuery({
    queryKey: ['support-ai-config'],
    queryFn: fetchSupportAiConfig,
    enabled: !denied,
  });
  const data = denied ? undefined : config.data;
  return (
    <>
      <PageHead
        title={t('web.sai_title')}
        subtitle={t('web.sai_intro')}
        badge={
          data === undefined ? undefined : (
            <Badge tone={MODE_TONES[data.config.mode]}>
              {t(SUPPORT_AI_MODE_LABELS[data.config.mode])}
            </Badge>
          )
        }
      />
      <StateSwitch query={config} denied={denied}>
        {data !== undefined && (
          <div className="stack">
            {data.chainUnavailable && (
              <Banner tone="danger" title={t('web.sai_chain_unavailable')}>
                <p>{t('web.sai_chain_unavailable_hint')}</p>
              </Banner>
            )}
            <ConfigCard response={data} mayAutoReply={mayAutoReply} />
            <CredentialsCard response={data} />
            <UsageCard />
          </div>
        )}
      </StateSwitch>
    </>
  );
}

// ---------------------------------------------------------------------------------------
// The configuration
// ---------------------------------------------------------------------------------------

interface StepDraft {
  readonly provider: SupportAiProvider | '';
  readonly model: string;
}

/** The form's state: numbers as the operator typed them, steps possibly half-filled. */
interface ConfigDraft {
  readonly mode: SupportAiMode;
  readonly primary: StepDraft;
  readonly fallbacks: readonly StepDraft[];
  readonly visionEnabled: boolean;
  readonly timeoutMs: string;
  readonly maxOutputChars: string;
  readonly maxConsecutiveReplies: string;
  readonly cooldownSeconds: string;
  readonly settleDelaySeconds: string;
  readonly toneInstructions: string;
  /**
   * The automatic-reply allowlist and confidence floor. Carried through the draft so a save
   * of ANY other field sends them back as they were: a form that omitted them let the
   * contract's defaults (none, HIGH) silently reset what the owner had configured.
   */
  readonly autoTopics: readonly SupportAiSafeTopic[];
  readonly autoMinConfidence: SupportAiAutoMinConfidence;
}

type SupportAiAutoMinConfidence = (typeof SUPPORT_AI_AUTO_MIN_CONFIDENCES)[number];

/** One `web.sai_auto_topic_*` label per safe topic: the page never draws the enum. */
export const SAI_AUTO_TOPIC_LABELS: Readonly<Record<SupportAiSafeTopic, WebKey>> = {
  CONNECTION_TROUBLESHOOTING: 'web.sai_auto_topic_connection_troubleshooting',
  APP_SETUP: 'web.sai_auto_topic_app_setup',
  SUBSCRIPTION_UPDATE: 'web.sai_auto_topic_subscription_update',
  SERVICE_INFO: 'web.sai_auto_topic_service_info',
  TRAFFIC_AND_EXPIRY: 'web.sai_auto_topic_traffic_and_expiry',
  PLAN_INFO: 'web.sai_auto_topic_plan_info',
  KNOWN_ERROR: 'web.sai_auto_topic_known_error',
  GREETING: 'web.sai_auto_topic_greeting',
};

export const SAI_AUTO_MIN_CONFIDENCE_LABELS: Readonly<Record<SupportAiAutoMinConfidence, WebKey>> =
  {
    HIGH: 'web.assist_confidence_high',
    MEDIUM: 'web.assist_confidence_medium',
  };

type NumericField =
  | 'timeoutMs'
  | 'maxOutputChars'
  | 'maxConsecutiveReplies'
  | 'cooldownSeconds'
  | 'settleDelaySeconds';

const NUMERIC_FIELDS: readonly {
  field: NumericField;
  label: WebKey;
  min: number;
  max: number;
}[] = [
  {
    field: 'timeoutMs',
    label: 'web.sai_timeout_ms',
    min: SUPPORT_AI_LIMITS.timeoutMs.min,
    max: SUPPORT_AI_LIMITS.timeoutMs.max,
  },
  {
    field: 'maxOutputChars',
    label: 'web.sai_max_output_chars',
    min: SUPPORT_AI_LIMITS.maxOutputChars.min,
    max: SUPPORT_AI_LIMITS.maxOutputChars.max,
  },
  {
    field: 'maxConsecutiveReplies',
    label: 'web.sai_max_consecutive_replies',
    min: SUPPORT_AI_LIMITS.maxConsecutiveReplies.min,
    max: SUPPORT_AI_LIMITS.maxConsecutiveReplies.max,
  },
  {
    field: 'cooldownSeconds',
    label: 'web.sai_cooldown_seconds',
    min: SUPPORT_AI_LIMITS.cooldownSeconds.min,
    max: SUPPORT_AI_LIMITS.cooldownSeconds.max,
  },
  {
    field: 'settleDelaySeconds',
    label: 'web.sai_settle_delay_seconds',
    min: SUPPORT_AI_SETTLE_DELAY_MIN_SECONDS,
    max: SUPPORT_AI_SETTLE_DELAY_MAX_SECONDS,
  },
];

function toStepDraft(step: SupportAiProviderStep | null): StepDraft {
  return step === null ? { provider: '', model: '' } : { ...step };
}

function toDraft(config: SupportAiConfigInput): ConfigDraft {
  return {
    mode: config.mode,
    primary: toStepDraft(config.primary),
    fallbacks: config.fallbacks.map(toStepDraft),
    visionEnabled: config.visionEnabled,
    timeoutMs: String(config.timeoutMs),
    maxOutputChars: String(config.maxOutputChars),
    maxConsecutiveReplies: String(config.maxConsecutiveReplies),
    cooldownSeconds: String(config.cooldownSeconds),
    settleDelaySeconds: String(config.settleDelaySeconds),
    toneInstructions: config.toneInstructions,
    // In the contract's order, whatever order the server stored: the toggle rebuilds the list
    // in that order, and the dirty check compares arrays, so ticking a box off and on again
    // must land on exactly what was loaded.
    autoTopics: SUPPORT_AI_SAFE_TOPICS.filter((topic) => config.autoTopics.includes(topic)),
    autoMinConfidence: config.autoMinConfidence,
  };
}

function toNumber(raw: string): number {
  return /^\d+$/u.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
}

/** What the form would send. The contract's own schema judges it before anything leaves. */
function fromDraft(draft: ConfigDraft): unknown {
  const step = (value: StepDraft) =>
    value.provider === '' ? null : { provider: value.provider, model: value.model };
  return {
    mode: draft.mode,
    primary: step(draft.primary),
    fallbacks: draft.fallbacks.map(step),
    visionEnabled: draft.visionEnabled,
    timeoutMs: toNumber(draft.timeoutMs),
    maxOutputChars: toNumber(draft.maxOutputChars),
    maxConsecutiveReplies: toNumber(draft.maxConsecutiveReplies),
    cooldownSeconds: toNumber(draft.cooldownSeconds),
    settleDelaySeconds: toNumber(draft.settleDelaySeconds),
    toneInstructions: draft.toneInstructions,
    autoTopics: draft.autoTopics,
    autoMinConfidence: draft.autoMinConfidence,
  };
}

/** One Persian sentence per invalid field, in the order the form draws them. */
const ISSUE_LABELS: Readonly<Record<string, WebKey>> = {
  primary: 'web.sai_invalid_primary',
  fallbacks: 'web.sai_invalid_fallbacks',
  timeoutMs: 'web.sai_invalid_bounds',
  maxOutputChars: 'web.sai_invalid_bounds',
  maxConsecutiveReplies: 'web.sai_invalid_bounds',
  cooldownSeconds: 'web.sai_invalid_bounds',
  settleDelaySeconds: 'web.sai_invalid_bounds',
  toneInstructions: 'web.sai_invalid_tone',
  autoTopics: 'web.sai_invalid_auto_topics',
};

function ConfigCard({
  response,
  mayAutoReply,
}: {
  response: SupportAiConfigResponse;
  mayAutoReply: boolean;
}) {
  const queries = useQueryClient();
  const notify = useToast();
  const submission = useSubmissionKey();
  const [draft, setDraft] = useState<ConfigDraft>(() => toDraft(response.config));
  // The version the FORM was built from — not the latest read. A poll that brings a newer
  // version must not silently become this save's `expectedVersion`.
  const [baseVersion, setBaseVersion] = useState(response.version);
  const set = <K extends keyof ConfigDraft>(key: K, value: ConfigDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const parsed = supportAiConfigInputSchema.safeParse(fromDraft(draft));
  const dirty =
    JSON.stringify(fromDraft(draft)) !== JSON.stringify(fromDraft(toDraft(response.config)));
  useUnsavedChanges(dirty);
  const issues = parsed.success
    ? []
    : [
        ...new Set(
          parsed.error.issues.map(
            (issue) => ISSUE_LABELS[String(issue.path[0])] ?? 'web.sai_invalid_bounds',
          ),
        ),
      ];

  const save = useMutation({
    mutationFn: (config: SupportAiConfigInput) =>
      saveSupportAiConfig({
        idempotencyKey: submission.current({ version: baseVersion, config }),
        expectedVersion: baseVersion,
        config,
      }),
    onSuccess: (result) => {
      submission.settle();
      setBaseVersion(result.version);
      notify({ tone: 'ok', message: t('web.sai_saved') });
      void queries.invalidateQueries({ queryKey: ['support-ai-config'] });
    },
    onError: (error) => {
      submission.settleOn(error);
      void queries.invalidateQueries({ queryKey: ['support-ai-config'] });
    },
  });
  // The server charges `support_ai.auto_reply` for either kind of widening; say so before
  // the save rather than only after the refusal.
  const widened =
    draft.autoTopics.some((topic) => !response.config.autoTopics.includes(topic)) ||
    (draft.autoMinConfidence === 'MEDIUM' && response.config.autoMinConfidence !== 'MEDIUM');
  const stale = response.version !== baseVersion;
  const reload = () => {
    setDraft(toDraft(response.config));
    setBaseVersion(response.version);
    save.reset();
  };

  const providerOptions = (
    <>
      <option value="">{t('web.sai_provider_none')}</option>
      {SUPPORT_AI_PROVIDERS.map((provider) => (
        <option key={provider} value={provider}>
          {t(SUPPORT_AI_PROVIDER_LABELS[provider])}
        </option>
      ))}
    </>
  );

  return (
    <Card title={t('web.sai_config')} hint={t('web.sai_config_hint')}>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (parsed.success) save.mutate(parsed.data);
        }}
      >
        <fieldset className="field">
          <legend className="field-label">{t('web.sai_mode')}</legend>
          <div className="stack-sm">
            {SUPPORT_AI_MODES.map((mode) => (
              <label key={mode} className="check">
                <input
                  type="radio"
                  name="support-ai-mode"
                  value={mode}
                  checked={draft.mode === mode}
                  onChange={() => set('mode', mode)}
                />{' '}
                <strong>{t(SUPPORT_AI_MODE_LABELS[mode])}</strong>
                <span className="muted small"> — {t(MODE_EXPLAINED[mode])}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {draft.mode === 'AUTO_REPLY_SAFE' && response.config.mode !== 'AUTO_REPLY_SAFE' && (
          <Banner tone="warn" icon="lock">
            {t(mayAutoReply ? 'web.sai_mode_auto_entering' : 'web.sai_mode_auto_needs_owner')}
          </Banner>
        )}

        <fieldset className="field">
          <legend className="field-label">{t('web.sai_chain')}</legend>
          <p className="muted small">{t('web.sai_chain_hint')}</p>
          <StepFields
            id="sai-primary"
            label={t('web.sai_primary')}
            step={draft.primary}
            options={providerOptions}
            onChange={(next) => set('primary', next)}
          />
          {draft.fallbacks.map((step, index) => (
            <StepFields
              // Position IS the identity of a fallback: it is the order the chain tries.
              key={index}
              id={`sai-fallback-${index}`}
              label={`${t('web.sai_fallback')} ${index + 1}`}
              step={step}
              options={providerOptions}
              onChange={(next) =>
                set(
                  'fallbacks',
                  draft.fallbacks.map((current, at) => (at === index ? next : current)),
                )
              }
              onRemove={() =>
                set(
                  'fallbacks',
                  draft.fallbacks.filter((_, at) => at !== index),
                )
              }
            />
          ))}
          {draft.fallbacks.length < SUPPORT_AI_LIMITS.maxFallbacks && (
            <button
              type="button"
              className="btn sm"
              onClick={() => set('fallbacks', [...draft.fallbacks, { provider: '', model: '' }])}
            >
              <Icon name="plus" />
              {t('web.sai_fallback_add')}
            </button>
          )}
        </fieldset>

        <label className="check">
          <input
            type="checkbox"
            checked={draft.visionEnabled}
            onChange={(event) => set('visionEnabled', event.target.checked)}
          />{' '}
          {t('web.sai_vision')}
        </label>

        <fieldset className="field">
          <legend className="field-label">{t('web.sai_auto_topics')}</legend>
          <p className="muted small">{t('web.sai_auto_topics_hint')}</p>
          <div className="grid-2">
            {SUPPORT_AI_SAFE_TOPICS.map((topic) => (
              <label key={topic} className="check">
                <input
                  type="checkbox"
                  name="support-ai-auto-topic"
                  checked={draft.autoTopics.includes(topic)}
                  onChange={(event) =>
                    set(
                      'autoTopics',
                      event.target.checked
                        ? // Kept in the contract's order, so a toggle back and forth is not dirty.
                          SUPPORT_AI_SAFE_TOPICS.filter(
                            (each) => each === topic || draft.autoTopics.includes(each),
                          )
                        : draft.autoTopics.filter((each) => each !== topic),
                    )
                  }
                />{' '}
                {t(SAI_AUTO_TOPIC_LABELS[topic])}
              </label>
            ))}
          </div>
        </fieldset>

        <Field
          label={t('web.sai_auto_min_confidence')}
          htmlFor="sai-auto-min-confidence"
          hint={t('web.sai_auto_min_confidence_hint')}
        >
          <select
            id="sai-auto-min-confidence"
            className="input"
            value={draft.autoMinConfidence}
            onChange={(event) =>
              set('autoMinConfidence', event.target.value as SupportAiAutoMinConfidence)
            }
          >
            {SUPPORT_AI_AUTO_MIN_CONFIDENCES.map((confidence) => (
              <option key={confidence} value={confidence}>
                {t(SAI_AUTO_MIN_CONFIDENCE_LABELS[confidence])}
              </option>
            ))}
          </select>
        </Field>
        {widened && (
          <Banner tone="warn" icon="lock">
            {t(mayAutoReply ? 'web.sai_auto_widen_entering' : 'web.sai_auto_widen_needs_owner')}
          </Banner>
        )}

        <div className="grid-2">
          {NUMERIC_FIELDS.map(({ field, label, min, max }) => (
            <Field
              key={field}
              label={t(label)}
              htmlFor={`sai-${field}`}
              hint={`${t('web.sai_range')} ${min} – ${max}`}
            >
              <input
                id={`sai-${field}`}
                className="input"
                dir="ltr"
                inputMode="numeric"
                value={draft[field]}
                onChange={(event) => set(field, event.target.value)}
              />
            </Field>
          ))}
        </div>

        <Field label={t('web.sai_tone')} htmlFor="sai-tone" hint={t('web.sai_tone_hint')}>
          <textarea
            id="sai-tone"
            className="input"
            rows={4}
            maxLength={SUPPORT_AI_LIMITS.toneInstructionsChars}
            value={draft.toneInstructions}
            onChange={(event) => set('toneInstructions', event.target.value)}
          />
        </Field>

        {issues.length > 0 && (
          <Banner tone="warn">
            <ul className="plain">
              {issues.map((key) => (
                <li key={key}>{t(key)}</li>
              ))}
            </ul>
          </Banner>
        )}
        {stale && (
          <Banner
            tone="warn"
            action={
              <button type="button" className="btn sm" onClick={reload}>
                {t('web.sai_reload')}
              </button>
            }
          >
            {t('web.sai_stale')}
          </Banner>
        )}
        {save.error !== null && (
          <Banner tone="danger" role="alert">
            {supportAiFault(save.error)}
          </Banner>
        )}
        <div className="form-actions">
          <button
            type="submit"
            className="btn primary"
            disabled={!parsed.success || !dirty || save.isPending}
          >
            <Icon name="check" />
            {t('web.sai_save')}
          </button>
        </div>
      </form>
    </Card>
  );
}

function StepFields({
  id,
  label,
  step,
  options,
  onChange,
  onRemove,
}: {
  id: string;
  label: string;
  step: StepDraft;
  options: ReactNode;
  onChange: (next: StepDraft) => void;
  onRemove?: () => void;
}) {
  return (
    <div className="grid-2">
      <Field label={label} htmlFor={`${id}-provider`}>
        <select
          id={`${id}-provider`}
          className="input"
          value={step.provider}
          onChange={(event) =>
            onChange({ ...step, provider: event.target.value as SupportAiProvider | '' })
          }
        >
          {options}
        </select>
      </Field>
      <Field label={`${label} — ${t('web.sai_model')}`} htmlFor={`${id}-model`}>
        <div className="row">
          <input
            id={`${id}-model`}
            className="input"
            dir="ltr"
            autoComplete="off"
            maxLength={SUPPORT_AI_LIMITS.modelIdChars}
            disabled={step.provider === ''}
            value={step.model}
            onChange={(event) => onChange({ ...step, model: event.target.value })}
          />
          {onRemove !== undefined && (
            <button
              type="button"
              className="btn sm ghost"
              aria-label={`${t('web.sai_fallback_remove')} — ${label}`}
              onClick={onRemove}
            >
              <Icon name="trash" />
            </button>
          )}
        </div>
      </Field>
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Keys and connection tests
// ---------------------------------------------------------------------------------------

/** The model a test should use by default: the one the chain names for this provider. */
function chainModelFor(config: SupportAiConfigInput, provider: SupportAiProvider): string {
  const steps = [config.primary, ...config.fallbacks];
  return steps.find((step) => step?.provider === provider)?.model ?? '';
}

function CredentialsCard({ response }: { response: SupportAiConfigResponse }) {
  return (
    <Card title={t('web.sai_credentials')} hint={t('web.sai_credentials_hint')}>
      <ul className="plain stack" aria-label={t('web.sai_credentials')}>
        {response.credentials.map((credential) => (
          <li key={credential.provider} data-provider={credential.provider}>
            <CredentialRow
              credential={credential}
              defaultModel={chainModelFor(response.config, credential.provider)}
            />
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * The capability test's answer, check by check (program §11). The headline is `OK` only when
 * every check that ran passed; a listed-but-unusable model reads as the check that failed.
 */
function TestResult({ result }: { result: SupportAiTestResponse }) {
  return (
    <Banner tone={OUTCOME_TONES[result.outcome]} role="status">
      <p>
        {t('web.sai_test_result')} {t(OUTCOME_LABELS[result.outcome])}
        {result.failureClass !== null && (
          <> — {t(FAILURE_CLASS_LABELS[result.failureClass])}</>
        )} — <Num value={result.latencyMs} /> {t('web.sai_ms')}
      </p>
      <ul className="stack-sm" aria-label={t('web.sai_test_check')}>
        {result.checks.map((check) => (
          <li key={check.check} data-check={check.check} data-result={check.result}>
            <strong>{t(TEST_CHECK_LABELS[check.check])}:</strong>{' '}
            <Badge tone={TEST_RESULT_TONES[check.result]}>
              {t(TEST_RESULT_LABELS[check.result])}
            </Badge>
            {check.failureClass !== null && check.result === 'FAIL' && (
              <> {t(FAILURE_CLASS_LABELS[check.failureClass])}</>
            )}
            {check.result === 'FAIL' && failureParticulars(check).length > 0 && (
              <KV inline items={failureParticulars(check)} />
            )}
          </li>
        ))}
      </ul>
    </Banner>
  );
}

function CredentialRow({
  credential,
  defaultModel,
}: {
  credential: SupportAiCredentialView;
  defaultModel: string;
}) {
  const { provider } = credential;
  const queries = useQueryClient();
  const notify = useToast();
  const setKey = useSubmissionKey();
  const deleteKey = useSubmissionKey();
  const testKey = useSubmissionKey();
  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [region, setRegion] = useState<Region>(credential.region ?? 'INTERNATIONAL');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [model, setModel] = useState(defaultModel);
  const [lastTest, setLastTest] = useState<SupportAiTestResponse | null>(null);
  // A settled test's next press is a NEW test (the fingerprint changes with the round).
  const [testRound, setTestRound] = useState(0);
  useUnsavedChanges(apiKey !== '');
  const refresh = () => void queries.invalidateQueries({ queryKey: ['support-ai-config'] });
  const keyValid = apiKey.trim().length >= 8 && apiKey.trim().length <= 512;

  const save = useMutation({
    // The key travels as the VARIABLE, so a retry sends what the idempotency key was minted
    // for. The fingerprint lives only in this component's memory, beside the field that
    // already holds the same value; it is never rendered and never stored.
    mutationFn: (value: { apiKey: string; region: Region | undefined }) =>
      setSupportAiCredential({
        provider,
        idempotencyKey: setKey.current({
          provider,
          region: value.region ?? null,
          apiKey: value.apiKey,
        }),
        apiKey: value.apiKey,
        ...(value.region === undefined ? {} : { region: value.region }),
      }),
    onSuccess: (result) => {
      setKey.settle();
      setApiKey('');
      setEditing(false);
      notify({
        tone: 'ok',
        message: t(result.replaced ? 'web.sai_key_replaced' : 'web.sai_key_set'),
      });
      refresh();
    },
    onError: (error) => {
      setKey.settleOn(error);
    },
  });
  const remove = useMutation({
    mutationFn: () =>
      deleteSupportAiCredential({
        provider,
        idempotencyKey: deleteKey.current({ provider, action: 'delete' }),
      }),
    onSuccess: () => {
      deleteKey.settle();
      notify({ tone: 'ok', message: t('web.sai_key_removed') });
      refresh();
    },
    onError: (error) => {
      deleteKey.settleOn(error);
      notify({ tone: 'danger', message: supportAiFault(error) });
      refresh();
    },
  });
  const test = useMutation({
    // One key per submission: a lost answer re-asked is a replay, never a second paid test.
    mutationFn: (value: string) =>
      testSupportAiProvider({
        provider,
        model: value,
        idempotencyKey: testKey.current({ provider, model: value, at: testRound }),
      }),
    onSuccess: (result) => {
      testKey.settle();
      setTestRound((round) => round + 1);
      setLastTest(result);
      refresh();
    },
    onError: (error) => {
      testKey.settleOn(error);
    },
  });

  // TB10: the server's breaker, as of its read — never re-derived from the client's clock.
  const tripped = credential.breaker === 'OPEN';
  const name = t(SUPPORT_AI_PROVIDER_LABELS[provider]);

  return (
    <div className="stack-sm">
      <div className="row">
        <strong>
          <Ltr mono={false}>{name}</Ltr>
        </strong>
        <Badge tone={credential.configured ? 'ok' : 'neutral'}>
          {t(credential.configured ? 'web.sai_key_configured' : 'web.sai_key_missing')}
        </Badge>
        {credential.configured && (
          <Badge tone={BREAKER_TONES[credential.breaker]}>
            {t(BREAKER_LABELS[credential.breaker])}
          </Badge>
        )}
        {credential.rejectedAt !== null && <Badge tone="danger">{t('web.sai_key_rejected')}</Badge>}
      </div>
      {credential.rejectedAt !== null && (
        <Banner tone="danger" title={t('web.sai_key_rejected')}>
          <p>{t('web.sai_key_rejected_hint')}</p>
        </Banner>
      )}
      <KV
        inline
        items={[
          [
            t('web.sai_key_set_at'),
            credential.setAt === null ? <Dash key="s" /> : formatTimestamp(credential.setAt),
          ],
          ...(provider === 'ZAI'
            ? ([
                [
                  t('web.sai_region'),
                  credential.region === null ? (
                    <Dash key="r" />
                  ) : (
                    t(REGION_LABELS[credential.region])
                  ),
                ],
              ] as [ReactNode, ReactNode][])
            : []),
          [
            t('web.sai_last_test'),
            credential.lastTestOutcome === null ? (
              <Dash key="o" />
            ) : (
              <span key="o">
                <Badge tone={OUTCOME_TONES[credential.lastTestOutcome]}>
                  {t(OUTCOME_LABELS[credential.lastTestOutcome])}
                </Badge>{' '}
                {credential.lastTestFailureClass !== null && (
                  <span className="small">
                    {t(FAILURE_CLASS_LABELS[credential.lastTestFailureClass])}{' '}
                  </span>
                )}
                {credential.lastTestedAt === null ? null : (
                  <span className="muted small">{formatTimestamp(credential.lastTestedAt)}</span>
                )}
              </span>
            ),
          ],
          ...(tripped && credential.trippedUntil !== null
            ? ([[t('web.sai_breaker_until'), formatTimestamp(credential.trippedUntil)]] as [
                ReactNode,
                ReactNode,
              ][])
            : []),
          ...(credential.configured
            ? ([
                [
                  t('web.sai_failures_in_row'),
                  <Num key="f" value={credential.consecutiveFailures} />,
                ],
                [
                  t('web.sai_rejected_at'),
                  credential.rejectedAt === null ? (
                    <Dash key="j" />
                  ) : (
                    formatTimestamp(credential.rejectedAt)
                  ),
                ],
              ] as [ReactNode, ReactNode][])
            : []),
        ]}
      />

      <div className="btn-group">
        <button type="button" className="btn sm" onClick={() => setEditing((open) => !open)}>
          <Icon name="key" />
          {t(credential.configured ? 'web.sai_key_replace' : 'web.sai_key_add')}
        </button>
        {credential.configured && (
          <button
            type="button"
            className="btn sm danger"
            disabled={remove.isPending}
            onClick={() => setConfirmingDelete(true)}
          >
            <Icon name="trash" />
            {t('web.sai_key_delete')}
          </button>
        )}
      </div>

      {editing && (
        <form
          className="stack-sm"
          onSubmit={(event) => {
            event.preventDefault();
            if (keyValid) {
              save.mutate({
                apiKey: apiKey.trim(),
                region: provider === 'ZAI' ? region : undefined,
              });
            }
          }}
        >
          <Field
            label={`${t('web.sai_key_input')} — ${name}`}
            htmlFor={`sai-key-${provider}`}
            hint={t('web.sai_key_input_hint')}
          >
            <input
              id={`sai-key-${provider}`}
              className="input"
              type="password"
              dir="ltr"
              autoComplete="new-password"
              spellCheck={false}
              maxLength={512}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </Field>
          {provider === 'ZAI' && (
            <Field label={t('web.sai_region')} htmlFor="sai-key-region">
              <select
                id="sai-key-region"
                className="input"
                value={region}
                onChange={(event) => setRegion(event.target.value as Region)}
              >
                {REGIONS.map((value) => (
                  <option key={value} value={value}>
                    {t(REGION_LABELS[value])}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {save.error !== null && <Banner tone="danger">{supportAiFault(save.error)}</Banner>}
          <div className="btn-group">
            <button type="submit" className="btn primary sm" disabled={!keyValid || save.isPending}>
              {t('web.sai_key_save')}
            </button>
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                setApiKey('');
                setEditing(false);
                save.reset();
              }}
            >
              {t('web.sai_cancel')}
            </button>
          </div>
        </form>
      )}

      {credential.configured && (
        <form
          className="row"
          onSubmit={(event) => {
            event.preventDefault();
            if (model.trim() !== '') test.mutate(model.trim());
          }}
        >
          <Field
            label={`${t('web.sai_test_model')} — ${name}`}
            htmlFor={`sai-test-${provider}`}
            compact
          >
            <input
              id={`sai-test-${provider}`}
              className="input sm"
              dir="ltr"
              autoComplete="off"
              maxLength={SUPPORT_AI_LIMITS.modelIdChars}
              value={model}
              onChange={(event) => setModel(event.target.value)}
            />
          </Field>
          <button type="submit" className="btn sm" disabled={model.trim() === '' || test.isPending}>
            <Icon name="plug" />
            {t('web.sai_test')}
          </button>
        </form>
      )}
      {credential.configured && <p className="muted small">{t('web.sai_test_hint')}</p>}
      {lastTest !== null && <TestResult result={lastTest} />}
      {test.error !== null && <Banner tone="danger">{supportAiFault(test.error)}</Banner>}

      {confirmingDelete && (
        <ConfirmDialog
          title={t('web.sai_key_delete_title')}
          question={t('web.sai_key_delete_body')}
          confirmLabel={t('web.sai_key_delete')}
          cancelLabel={t('web.sai_cancel')}
          onConfirm={() => {
            setConfirmingDelete(false);
            remove.mutate();
          }}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------------------

function UsageCard() {
  const usage = useQuery({ queryKey: ['support-ai-usage'], queryFn: fetchSupportAiUsage });
  type Row = SupportAiUsageResponse['rows'][number];
  const rows = usage.data?.rows ?? [];
  const columns: readonly Column<Row>[] = [
    {
      key: 'provider',
      header: t('web.sai_provider'),
      render: (row) => t(SUPPORT_AI_PROVIDER_LABELS[row.provider]),
    },
    { key: 'model', header: t('web.sai_model'), render: (row) => <Ltr>{row.model}</Ltr> },
    {
      key: 'operation',
      header: t('web.sai_operation'),
      render: (row) => t(OPERATION_LABELS[row.operation]),
    },
    { key: 'calls', header: t('web.sai_calls'), render: (row) => <Num value={row.calls} /> },
    {
      key: 'failures',
      header: t('web.sai_failures'),
      render: (row) => <Num value={row.failures} />,
    },
    {
      key: 'input',
      header: t('web.sai_input_tokens'),
      render: (row) => <Num value={row.inputTokens} />,
    },
    {
      key: 'output',
      header: t('web.sai_output_tokens'),
      render: (row) => <Num value={row.outputTokens} />,
    },
    {
      key: 'latency',
      header: t('web.sai_avg_latency'),
      render: (row) => <Num value={row.avgLatencyMs} />,
    },
  ];
  return (
    <Card
      title={t('web.sai_usage')}
      hint={
        usage.data === undefined
          ? t('web.sai_usage_hint')
          : `${t('web.sai_usage_hint')} ${t('web.sai_usage_since')} ${formatTimestamp(usage.data.since)}`
      }
    >
      <StateSwitch
        query={usage}
        isEmpty={rows.length === 0}
        empty={<Empty title={t('web.sai_usage_empty')} icon="activity" />}
      >
        <DataTable
          caption={t('web.sai_usage')}
          columns={columns}
          rows={rows}
          rowKey={(row) => `${row.provider}:${row.model}:${row.operation}`}
          dense
        />
      </StateSwitch>
    </Card>
  );
}
