import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  OPS_LOG_TOPIC_CATEGORIES,
  OPS_LOG_TYPES,
  OPS_LOG_TYPE_IDS,
  type OpsLogTopicCategory,
  type OpsLogTypeId,
} from '@nexa/contracts';
import { fetchSettings, saveSetting } from '../api/client';
import { useSubmissionKey } from '../submission-key';
import { t, type WebKey } from '../i18n/web.fa';
import { messageFor } from './settings';
import { Banner, Card, Disclosure, Field, Num, StateSwitch, ToggleRow, useToast } from '../ui/kit';
import { ErrorRef } from '../ui/technical-details';

/**
 * The per-type switches of «گروه گزارش‌های مدیریتی» (Round 4 PR-D).
 *
 * Every log type the owner reviewed (Appendix L) has its own switch under its topic, and the
 * optional storm roll-up, the nightly report time and the Web Admin address the inline
 * buttons open sit beneath them. One stored list — `ops.log.disabled_types` — holds what is
 * switched OFF; a type this release does not list is untouched, and a type added by a later
 * release is on until somebody turns it off.
 *
 * **Buttons are drawn from permissions, and that is a courtesy.** The server charges
 * `settings.edit` for every write.
 */

const TOPIC_NAME: Readonly<Record<OpsLogTopicCategory, WebKey>> = {
  SYSTEM: 'web.opsgroup_topic_system',
  ERRORS: 'web.opsgroup_topic_errors',
  PAYMENTS: 'web.opsgroup_topic_payments',
  SERVICES: 'web.opsgroup_topic_services',
  PANELS: 'web.opsgroup_topic_panels',
  BOT: 'web.opsgroup_topic_bot',
  SECURITY: 'web.opsgroup_topic_security',
  BACKUPS: 'web.opsgroup_topic_backups',
  USERS: 'web.opsgroup_topic_users',
  REPORTS: 'web.opsgroup_topic_reports',
};

/** The Persian name of each log type, as the owner reviewed it. */
export const OPS_LOG_TYPE_LABEL: Readonly<Record<OpsLogTypeId, WebKey>> = {
  PAYMENT_TOPUP: 'web.opslog_type_payment_topup',
  PAYMENT_ORDER: 'web.opslog_type_payment_order',
  PAYMENT_CRYPTO: 'web.opslog_type_payment_crypto',
  PAYMENT_FAILED: 'web.opslog_type_payment_failed',
  PAYMENT_LATE: 'web.opslog_type_payment_late',
  REFUND: 'web.opslog_type_refund',
  ADMIN_WALLET: 'web.opslog_type_admin_wallet',
  REFERRAL_COMMISSION: 'web.opslog_type_referral_commission',
  SIGNUP_GIFT: 'web.opslog_type_signup_gift',
  GIFT_CARD: 'web.opslog_type_gift_card',
  SERVICE_CREATED: 'web.opslog_type_service_created',
  SERVICE_CREATED_WALLET: 'web.opslog_type_service_created_wallet',
  SERVICE_RENEWED: 'web.opslog_type_service_renewed',
  TRAFFIC_ADDED: 'web.opslog_type_traffic_added',
  TIME_ADDED: 'web.opslog_type_time_added',
  LINK_CHANGED: 'web.opslog_type_link_changed',
  TRIAL_CREATED: 'web.opslog_type_trial_created',
  USER_NEW: 'web.opslog_type_user_new',
  USER_BLOCK: 'web.opslog_type_user_block',
  ADMIN_CHANGED: 'web.opslog_type_admin_changed',
  RESELLER_CHANGED: 'web.opslog_type_reseller_changed',
  SERVICE_ALERT: 'web.opslog_type_service_alert',
  ERROR_PAYMENT_LINK: 'web.opslog_type_error_payment_link',
  ERROR_PROVISION: 'web.opslog_type_error_provision',
  ERROR_OPERATION: 'web.opslog_type_error_operation',
  PANEL_STATE: 'web.opslog_type_panel_state',
  TICKET_NEW: 'web.opslog_type_ticket_new',
  REPORT_SUMMARY: 'web.opslog_type_report_summary',
  REPORT_FINANCIAL: 'web.opslog_type_report_financial',
  REPORT_PANELS: 'web.opslog_type_report_panels',
  BACKUP_FILE: 'web.opslog_type_backup_file',
};

const DISABLED_KEY = 'ops.log.disabled_types';

/** The types grouped by topic, in the order the topics are listed. */
export function opsLogTypesByTopic(): readonly {
  readonly topic: OpsLogTopicCategory;
  readonly types: readonly OpsLogTypeId[];
}[] {
  return OPS_LOG_TOPIC_CATEGORIES.map((topic) => ({
    topic,
    types: OPS_LOG_TYPE_IDS.filter((id) => OPS_LOG_TYPES[id].topic === topic),
  })).filter((group) => group.types.length > 0);
}

export function OpsLogTypeSwitches({ mayManage }: { mayManage: boolean }) {
  const settings = useQuery({ queryKey: ['settings'], queryFn: fetchSettings });
  return (
    <Card title={t('web.opslog_types_title')} hint={t('web.opslog_types_hint')}>
      <StateSwitch query={settings} denied={false} isEmpty={false}>
        <Switches rows={settings.data?.settings ?? []} mayManage={mayManage} />
      </StateSwitch>
    </Card>
  );
}

type SettingRow = {
  readonly key: string;
  readonly value: unknown;
  readonly version: number | null;
};

function Switches({ rows, mayManage }: { rows: readonly SettingRow[]; mayManage: boolean }) {
  const queries = useQueryClient();
  const notify = useToast();
  const submission = useSubmissionKey();
  const row = rows.find((candidate) => candidate.key === DISABLED_KEY);
  const disabled: readonly string[] = Array.isArray(row?.value)
    ? (row?.value as unknown[]).filter((entry): entry is string => typeof entry === 'string')
    : [];

  const save = useMutation({
    mutationFn: (next: readonly string[]) =>
      saveSetting({
        key: DISABLED_KEY,
        value: next,
        expectedVersion: row?.version ?? null,
        idempotencyKey: submission.current({ key: DISABLED_KEY, value: next }),
      }),
    onSuccess: async () => {
      submission.settle();
      notify({ tone: 'ok', message: t('web.opslog_types_saved') });
      await queries.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: async (error) => {
      submission.settleOn(error);
      // A stale version (another administrator switched something) is read again, not retried.
      await queries.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const toggle = (id: OpsLogTypeId, on: boolean) => {
    const rest = disabled.filter((entry) => entry !== id);
    save.mutate(on ? rest : [...rest, id]);
  };

  return (
    <div className="ops-log-types" data-testid="ops-log-types">
      {/*
        Demo parity (R11): about forty switches are no longer an open wall. Each topic is an
        accordion, closed, whose summary says how many of its report types are on; the switches
        are the same rows with the same saving.
      */}
      {opsLogTypesByTopic().map((group) => {
        const on = group.types.filter((id) => !disabled.includes(id)).length;
        return (
          <Disclosure
            key={group.topic}
            className="ops-log-topic"
            size="sm"
            variant="boxed"
            summary={
              <>
                <span className="ops-log-topic-name">{t(TOPIC_NAME[group.topic])}</span>
                <span className="ops-log-topic-count muted small">
                  <Num value={on} /> / <Num value={group.types.length} />
                </span>
              </>
            }
          >
            <section aria-label={t(TOPIC_NAME[group.topic])}>
              {group.types.map((id) => (
                <ToggleRow
                  key={id}
                  title={t(OPS_LOG_TYPE_LABEL[id])}
                  checked={!disabled.includes(id)}
                  onChange={(next) => toggle(id, next)}
                  disabled={!mayManage || save.isPending}
                />
              ))}
            </section>
          </Disclosure>
        );
      })}
      {save.error != null && (
        <Banner tone="danger">
          {messageFor(save.error)}
          <ErrorRef error={save.error} />
        </Banner>
      )}
      <Disclosure
        className="ops-log-topic"
        size="sm"
        variant="boxed"
        summary={<span className="ops-log-topic-name">{t('web.opslog_options_title')}</span>}
      >
        <LogOptions rows={rows} mayManage={mayManage} />
      </Disclosure>
    </div>
  );
}

/** The keys under the switches, each a single value. */
const OPTIONS: readonly {
  readonly key: string;
  readonly label: WebKey;
  readonly hint: WebKey;
  readonly kind: 'boolean' | 'number' | 'text';
}[] = [
  {
    key: 'ops.log.storm_rollup_enabled',
    label: 'web.opslog_storm_enabled',
    hint: 'web.opslog_storm_enabled_hint',
    kind: 'boolean',
  },
  {
    key: 'ops.log.storm_threshold',
    label: 'web.opslog_storm_threshold',
    hint: 'web.opslog_storm_threshold_hint',
    kind: 'number',
  },
  {
    key: 'ops.log.storm_window_minutes',
    label: 'web.opslog_storm_window',
    hint: 'web.opslog_storm_window_hint',
    kind: 'number',
  },
  {
    key: 'ops.log.nightly_report_time',
    label: 'web.opslog_report_time',
    hint: 'web.opslog_report_time_hint',
    kind: 'text',
  },
  {
    key: 'ops.log.admin_base_url',
    label: 'web.opslog_admin_url',
    hint: 'web.opslog_admin_url_hint',
    kind: 'text',
  },
];

function LogOptions({ rows, mayManage }: { rows: readonly SettingRow[]; mayManage: boolean }) {
  return (
    <div className="ops-log-options">
      {OPTIONS.map((option) => {
        const row = rows.find((candidate) => candidate.key === option.key);
        return row === undefined ? null : (
          <OptionRow
            key={`${option.key}:${String(row.version)}`}
            option={option}
            value={row.value}
            version={row.version}
            mayManage={mayManage}
          />
        );
      })}
    </div>
  );
}

function OptionRow({
  option,
  value,
  version,
  mayManage,
}: {
  option: (typeof OPTIONS)[number];
  value: unknown;
  version: number | null;
  mayManage: boolean;
}) {
  const queries = useQueryClient();
  const notify = useToast();
  const submission = useSubmissionKey();
  const [draft, setDraft] = useState(value === null || value === undefined ? '' : String(value));
  const save = useMutation({
    mutationFn: (next: unknown) =>
      saveSetting({
        key: option.key,
        value: next,
        expectedVersion: version,
        idempotencyKey: submission.current({ key: option.key, value: next }),
      }),
    onSuccess: async () => {
      submission.settle();
      notify({ tone: 'ok', message: t('web.opslog_types_saved') });
      await queries.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: async (error) => {
      submission.settleOn(error);
      /*
       * A stale version (another administrator saved this option) is read again, never
       * retried with the version this row was drawn with — which would fail the same way for
       * ever (Codex review of #301). The re-read remounts the row under its new version, so
       * the reason is said as a toast, which outlives the row.
       */
      notify({ tone: 'danger', message: messageFor(error), error });
      await queries.invalidateQueries({ queryKey: ['settings'] });
    },
  });
  const id = `ops-log-option-${option.key}`;
  if (option.kind === 'boolean') {
    return (
      <>
        <ToggleRow
          title={t(option.label)}
          description={t(option.hint)}
          checked={value === true}
          onChange={(on) => save.mutate(on)}
          disabled={!mayManage || save.isPending}
        />
        {save.error != null && (
          <Banner tone="danger">
            {messageFor(save.error)}
            <ErrorRef error={save.error} />
          </Banner>
        )}
      </>
    );
  }
  return (
    <div className="field-row">
      <Field label={t(option.label)} hint={t(option.hint)} htmlFor={id} compact>
        <input
          id={id}
          className="input sm"
          dir="ltr"
          inputMode={option.kind === 'number' ? 'numeric' : 'text'}
          value={draft}
          disabled={!mayManage}
          onChange={(event) => setDraft(event.target.value)}
        />
      </Field>
      {mayManage && (
        <button
          type="button"
          className="btn sm"
          disabled={save.isPending}
          onClick={() => save.mutate(option.kind === 'number' ? Number(draft) : draft.trim())}
        >
          {t('web.save')}
        </button>
      )}
      {save.error != null && (
        <Banner tone="danger">
          {messageFor(save.error)}
          <ErrorRef error={save.error} />
        </Banner>
      )}
    </div>
  );
}
