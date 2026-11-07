import type {
  CapacityLimit,
  CapacityResource,
  HostedActivationLinkState,
  HostedActivationStep,
  HostedBotState,
  HostingCreateRefusal,
} from '@nexa/contracts';
import type { WebKey } from './i18n/web.fa';
import { formatNumber } from './format';
import { t } from './i18n/web.fa';
import type { Tone } from './ui/kit';

/**
 * The words of «میزبانی‌ها»: a hosted bot's state, each capacity resource, the reason creating is
 * closed. Records over the contract's own unions, so a state or resource added to the
 * contract fails the typecheck here until it has a Persian word.
 */

export const HOSTED_STATE_LABEL: Readonly<
  Record<HostedBotState, { readonly label: WebKey; readonly tone: Tone }>
> = {
  ACTIVE: { label: 'web.hosting_state_active', tone: 'ok' },
  SUSPENDED: { label: 'web.hosting_state_suspended', tone: 'warn' },
  EXPIRED: { label: 'web.hosting_state_expired', tone: 'warn' },
  DELETED: { label: 'web.hosting_state_deleted', tone: 'danger' },
  PURGED: { label: 'web.hosting_state_purged', tone: 'neutral' },
};

export const HOSTING_RESOURCE_LABEL: Readonly<Record<CapacityResource, WebKey>> = {
  UPDATE_CONCURRENCY: 'web.hosting_res_update_concurrency',
  DB_CONNECTIONS: 'web.hosting_res_db_connections',
  JOB_TURN_WEIGHT: 'web.hosting_res_job_turn_weight',
  BROADCAST_PER_SECOND: 'web.hosting_res_broadcast_per_second',
  HEAVY_JOB_PRIORITY: 'web.hosting_res_heavy_job_priority',
  NEW_CUSTOMERS_PER_MINUTE: 'web.hosting_res_new_customers_per_minute',
  SUPPORT_AI_MONTHLY_REQUESTS: 'web.hosting_res_support_ai_monthly_requests',
  STORAGE_MB: 'web.hosting_res_storage_mb',
  INSTALLATION_HEAVY_JOB_CONCURRENCY: 'web.hosting_res_installation_heavy_job_concurrency',
  INSTALLATION_HEAVY_JOB_MIN_FREE_MEMORY_MB:
    'web.hosting_res_installation_heavy_job_min_free_memory_mb',
  INSTALLATION_ALERT_MIN_FREE_MEMORY_MB: 'web.hosting_res_installation_alert_min_free_memory_mb',
  INSTALLATION_ALERT_WORKER_LAG_SECONDS: 'web.hosting_res_installation_alert_worker_lag_seconds',
};

export const HOSTING_CREATE_REFUSAL_LABEL: Readonly<Record<HostingCreateRefusal, WebKey>> = {
  FLAG_OFF: 'web.hosting_create_flag_off',
  PRODUCTION_NOT_RELEASED: 'web.hosting_create_not_released',
};

/** A limit as a person reads it: the word for unlimited, or the number. Never a sentinel. */
export function limitText(limit: CapacityLimit): string {
  return limit.mode === 'UNLIMITED' ? t('web.hosting_limit_unlimited') : formatNumber(limit.value);
}

/**
 * The activation steps' words (phase 6A PR-4): what each step says once it holds («توکن تأیید شد»…)
 * and what it is called until then. Records over the contract's own union.
 */
export const ACTIVATION_STEP_LABEL: Readonly<
  Record<HostedActivationStep, { readonly done: WebKey; readonly todo: WebKey }>
> = {
  TOKEN: { done: 'web.hosting_act_step_token_done', todo: 'web.hosting_act_step_token_todo' },
  DOMAIN: { done: 'web.hosting_act_step_domain_done', todo: 'web.hosting_act_step_domain_todo' },
  SSL: { done: 'web.hosting_act_step_ssl_done', todo: 'web.hosting_act_step_ssl_todo' },
  WEBHOOK: {
    done: 'web.hosting_act_step_webhook_done',
    todo: 'web.hosting_act_step_webhook_todo',
  },
  LINK: { done: 'web.hosting_act_step_link_done', todo: 'web.hosting_act_step_link_todo' },
};

export const ACTIVATION_LINK_STATE_LABEL: Readonly<Record<HostedActivationLinkState, WebKey>> = {
  ACTIVE: 'web.hosting_act_link_state_active',
  USED: 'web.hosting_act_link_state_used',
  EXPIRED: 'web.hosting_act_link_state_expired',
};
