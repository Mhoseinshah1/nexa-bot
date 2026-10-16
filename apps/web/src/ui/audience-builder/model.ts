import { useQuery } from '@tanstack/react-query';
import {
  type AudienceActiveServiceFilter,
  type AudienceCustomerStatus,
  type AudiencePurchaseFilter,
  type AudienceReferralFilter,
  type AudienceTrialFilter,
  type ServiceState,
} from '@nexa/contracts';
import { ApiError, fetchAudienceOptions } from '../../api/client';
import { formatNumber } from '../../format';
import { t, type WebKey } from '../../i18n/web.fa';

/**
 * The SHARED audience builder (round N): the one editor of an audience definition, used by
 * «ارسال همگانی», «عملیات گروهی» and the campaigns built on them — one segmentation UI over
 * one segmentation engine. It edits the definition as the contract's input shape and never
 * decides membership: the count it shows is the server's (`POST /audience/preview`).
 *
 * Mirza's VERIFIED dimensions come first — who (ordinary customers / each reseller tier) and
 * purchase history — and the richer Nexa filters follow.
 */

/** The definition as the builder edits it: the contract's input shape. */
export interface AudienceDraft {
  version: 1;
  /** Hand-picked customers (Mirza's per-user send); null means no restriction. */
  customerIds: string[] | null;
  customerStatus: AudienceCustomerStatus;
  segment: { ordinary: boolean; resellerTierIds: string[] } | null;
  purchase: AudiencePurchaseFilter;
  registeredFrom: string | null;
  registeredBefore: string | null;
  accountAgeMinDays: number | null;
  accountAgeMaxDays: number | null;
  lastPurchaseFrom: string | null;
  lastPurchaseBefore: string | null;
  noPurchaseForDays: number | null;
  walletBalance: { currency: string; minMinor: string | null; maxMinor: string | null } | null;
  trial: AudienceTrialFilter;
  referral: AudienceReferralFilter;
  service: {
    productIds: string[];
    panelIds: string[];
    states: ServiceState[];
    expiringWithinHours: number | null;
    expired: boolean;
  } | null;
  /** Broadcast V2 (program §19): the customer's tags, by id (program §8). */
  tags: { anyOf: string[]; noneOf: string[] } | null;
  /** Broadcast V2: has / has no service active now. */
  activeService: AudienceActiveServiceFilter;
  /** Roadmap C3: the bots the customer is reached through; null means every bot. */
  botInstanceIds: string[] | null;
}

export const EMPTY_AUDIENCE: AudienceDraft = {
  version: 1,
  customerIds: null,
  customerStatus: 'ACTIVE',
  segment: null,
  purchase: 'ANY',
  registeredFrom: null,
  registeredBefore: null,
  accountAgeMinDays: null,
  accountAgeMaxDays: null,
  lastPurchaseFrom: null,
  lastPurchaseBefore: null,
  noPurchaseForDays: null,
  walletBalance: null,
  trial: 'ANY',
  referral: 'ANY',
  service: null,
  tags: null,
  activeService: 'ANY',
  botInstanceIds: null,
};

/**
 * The definition as it goes on the wire (PR #245 review m3): the keys added after the first
 * release — tags, active service, bots — are dropped while they hold their default. They mean
 * nothing then, and a release that predates one refuses it by its strict schema, so a tab on
 * this bundle talking to an older server (a rollback, a rolling update) would otherwise fail
 * every preview and save with no bot ticked. The canonical form omits them the same way, so
 * the hash is the one the server computes either way.
 */
export function wireAudience(draft: AudienceDraft): Record<string, unknown> {
  const { tags, activeService, botInstanceIds, ...rest } = draft;
  return {
    ...rest,
    ...(tags === null ? {} : { tags }),
    ...(activeService === 'ANY' ? {} : { activeService }),
    ...(botInstanceIds === null ? {} : { botInstanceIds }),
  };
}

/**
 * Review n2: the bots' names from the builder's options, if this page has already read them —
 * never a request of its own (a reader of a report may not hold the options' key).
 */
export function useCachedBotNames(): ReadonlyMap<string, string> | undefined {
  const options = useQuery({
    queryKey: ['audience-options'],
    queryFn: fetchAudienceOptions,
    enabled: false,
  });
  const bots = options.data?.bots;
  return bots === undefined ? undefined : new Map(bots.map((bot) => [bot.id, bot.username]));
}

/** A stored canonical definition, back into the builder's shape (every key is present). */
export function draftOf(definition: unknown): AudienceDraft {
  return { ...EMPTY_AUDIENCE, ...(definition as Partial<AudienceDraft>) };
}

export const STATUS_LABELS: Readonly<Record<AudienceCustomerStatus, WebKey>> = {
  ACTIVE: 'web.aud_status_active',
  BLOCKED: 'web.aud_status_blocked',
  ANY: 'web.aud_status_any',
};
export const PURCHASE_LABELS: Readonly<Record<AudiencePurchaseFilter, WebKey>> = {
  ANY: 'web.aud_purchase_any',
  PURCHASED: 'web.aud_purchase_yes',
  NEVER_PURCHASED: 'web.aud_purchase_no',
};
export const TRIAL_LABELS: Readonly<Record<AudienceTrialFilter, WebKey>> = {
  ANY: 'web.aud_any',
  USED: 'web.aud_trial_used',
  NOT_USED: 'web.aud_trial_unused',
};
export const REFERRAL_LABELS: Readonly<Record<AudienceReferralFilter, WebKey>> = {
  ANY: 'web.aud_any',
  PARTICIPANT: 'web.aud_referral_participant',
  NON_PARTICIPANT: 'web.aud_referral_none',
  REFERRER: 'web.aud_referral_referrer',
  REFERRED: 'web.aud_referral_referred',
};
export const ACTIVE_SERVICE_LABELS: Readonly<Record<AudienceActiveServiceFilter, WebKey>> = {
  ANY: 'web.aud_any',
  HAS: 'web.aud_active_service_has',
  NONE: 'web.aud_active_service_none',
};

/** One tag's part in the audience: not used, required (any of) or excluded (none of). */
export type TagRole = 'IGNORE' | 'ANY_OF' | 'NONE_OF';
export const TAG_ROLE_LABELS: Readonly<Record<TagRole, WebKey>> = {
  IGNORE: 'web.aud_tag_ignore',
  ANY_OF: 'web.aud_tag_any_of',
  NONE_OF: 'web.aud_tag_none_of',
};
export const TAG_ROLES: readonly TagRole[] = ['IGNORE', 'ANY_OF', 'NONE_OF'];

/**
 * The draft's tags with one tag moved to `role`. A tag sits in at most one list — the
 * contract refuses a tag both required and excluded — and an empty criterion is `null`.
 */
export function withTagRole(
  tags: AudienceDraft['tags'],
  id: string,
  role: TagRole,
): AudienceDraft['tags'] {
  const anyOf = (tags?.anyOf ?? []).filter((one) => one !== id);
  const noneOf = (tags?.noneOf ?? []).filter((one) => one !== id);
  if (role === 'ANY_OF') anyOf.push(id);
  if (role === 'NONE_OF') noneOf.push(id);
  return anyOf.length === 0 && noneOf.length === 0 ? null : { anyOf, noneOf };
}

export function tagRoleOf(tags: AudienceDraft['tags'], id: string): TagRole {
  if (tags?.anyOf.includes(id) === true) return 'ANY_OF';
  if (tags?.noneOf.includes(id) === true) return 'NONE_OF';
  return 'IGNORE';
}

export const SERVICE_STATE_LABELS: Readonly<Record<ServiceState, WebKey>> = {
  PENDING_PROVISION: 'web.aud_service_pending',
  ACTIVE: 'web.aud_service_active',
  SUSPENDED: 'web.aud_service_suspended',
  EXPIRED: 'web.aud_service_expired',
  TERMINATED: 'web.aud_service_terminated',
  UNRECONCILED: 'web.aud_service_unreconciled',
};

/** A date input's day, as the half-open instant the contract stores (UTC midnight). */
export function dayToInstant(value: string): string | null {
  return value === '' ? null : `${value}T00:00:00.000Z`;
}
export function instantToDay(value: string | null): string {
  return value === null ? '' : value.slice(0, 10);
}
export function whole(value: string): number | null {
  if (value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function toggle<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

/** The audience's error sentences, for the codes the server answers a definition with. */
export function audienceMessage(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  if (error.code === 'audience.definition_invalid') return t('web.aud_error_invalid');
  if (error.code === 'audience.changed') return t('web.aud_error_changed');
  if (error.code === 'audience.empty') return t('web.aud_error_empty');
  if (error.status === 403) return t('web.no_permission');
  return null;
}

/**
 * The filters of a frozen definition, as sentences an operator reads on a report — the
 * brief's "filters" on a broadcast and a mass operation.
 */
export function describeAudience(
  definition: unknown,
  /** Review n2: the bots' names when the builder's options are at hand; a count otherwise. */
  botNames?: ReadonlyMap<string, string>,
): string[] {
  const d = draftOf(definition);
  const lines: string[] = [];
  lines.push(`${t('web.aud_status')}: ${t(STATUS_LABELS[d.customerStatus])}`);
  if (d.customerIds !== null) {
    lines.push(`${t('web.aud_customer_ids')}: ${formatNumber(d.customerIds.length)}`);
  }
  if (d.segment !== null) {
    const parts = [
      ...(d.segment.ordinary ? [t('web.aud_ordinary')] : []),
      ...(d.segment.resellerTierIds.length > 0
        ? [`${t('web.aud_tier')} (${formatNumber(d.segment.resellerTierIds.length)})`]
        : []),
    ];
    lines.push(`${t('web.aud_who')}: ${parts.join(' · ')}`);
  } else {
    lines.push(`${t('web.aud_who')}: ${t('web.aud_everyone')}`);
  }
  if (d.purchase !== 'ANY')
    lines.push(`${t('web.aud_purchase')}: ${t(PURCHASE_LABELS[d.purchase])}`);
  if (d.trial !== 'ANY') lines.push(`${t('web.aud_trial')}: ${t(TRIAL_LABELS[d.trial])}`);
  if (d.referral !== 'ANY')
    lines.push(`${t('web.aud_referral')}: ${t(REFERRAL_LABELS[d.referral])}`);
  if (d.activeService !== 'ANY') {
    lines.push(`${t('web.aud_active_service')}: ${t(ACTIVE_SERVICE_LABELS[d.activeService])}`);
  }
  if (d.botInstanceIds !== null) {
    const named = d.botInstanceIds.map((id) => botNames?.get(id));
    lines.push(
      named.every((name) => name !== undefined)
        ? `${t('web.aud_bots')}: ${named.map((name) => `@${String(name)}`).join(' · ')}`
        : `${t('web.aud_bots')}: ${formatNumber(d.botInstanceIds.length)}`,
    );
  }
  if (d.tags !== null) {
    const bits = [
      ...(d.tags.anyOf.length > 0
        ? [`${t('web.aud_tag_any_of')} (${formatNumber(d.tags.anyOf.length)})`]
        : []),
      ...(d.tags.noneOf.length > 0
        ? [`${t('web.aud_tag_none_of')} (${formatNumber(d.tags.noneOf.length)})`]
        : []),
    ];
    lines.push(`${t('web.aud_tags')}: ${bits.join(' · ')}`);
  }
  if (d.registeredFrom !== null)
    lines.push(`${t('web.aud_registered_from')}: ${instantToDay(d.registeredFrom)}`);
  if (d.registeredBefore !== null) {
    lines.push(`${t('web.aud_registered_before')}: ${instantToDay(d.registeredBefore)}`);
  }
  if (d.accountAgeMinDays !== null)
    lines.push(`${t('web.aud_age_min')}: ${formatNumber(d.accountAgeMinDays)}`);
  if (d.accountAgeMaxDays !== null)
    lines.push(`${t('web.aud_age_max')}: ${formatNumber(d.accountAgeMaxDays)}`);
  if (d.lastPurchaseFrom !== null) {
    lines.push(`${t('web.aud_last_purchase_from')}: ${instantToDay(d.lastPurchaseFrom)}`);
  }
  if (d.lastPurchaseBefore !== null) {
    lines.push(`${t('web.aud_last_purchase_before')}: ${instantToDay(d.lastPurchaseBefore)}`);
  }
  if (d.noPurchaseForDays !== null) {
    lines.push(`${t('web.aud_no_purchase_days')}: ${formatNumber(d.noPurchaseForDays)}`);
  }
  if (d.walletBalance !== null) {
    lines.push(
      `${t('web.aud_balance_min')}: ${d.walletBalance.minMinor ?? '—'} · ${t('web.aud_balance_max')}: ${
        d.walletBalance.maxMinor ?? '—'
      }`,
    );
  }
  if (d.service !== null) {
    const s = d.service;
    const bits = [
      ...(s.productIds.length > 0
        ? [`${t('web.aud_products')} (${formatNumber(s.productIds.length)})`]
        : []),
      ...(s.panelIds.length > 0
        ? [`${t('web.aud_panels')} (${formatNumber(s.panelIds.length)})`]
        : []),
      ...s.states.map((state) => t(SERVICE_STATE_LABELS[state])),
      ...(s.expiringWithinHours !== null
        ? [`${t('web.aud_expiring_hours')}: ${formatNumber(s.expiringWithinHours)}`]
        : []),
      ...(s.expired ? [t('web.aud_expired')] : []),
    ];
    lines.push(
      `${t('web.aud_service_toggle')}: ${bits.length === 0 ? t('web.aud_any') : bits.join(' · ')}`,
    );
  }
  return lines;
}
