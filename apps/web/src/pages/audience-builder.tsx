import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  AUDIENCE_ACTIVE_SERVICE_FILTERS,
  AUDIENCE_CUSTOMER_STATUSES,
  AUDIENCE_PURCHASE_FILTERS,
  AUDIENCE_REFERRAL_FILTERS,
  AUDIENCE_TRIAL_FILTERS,
  SERVICE_STATES,
  type AudienceActiveServiceFilter,
  type AudienceCustomerStatus,
  type AudienceOptionsResponse,
  type AudiencePurchaseFilter,
  type AudienceReferralFilter,
  type AudienceTrialFilter,
  type ServiceState,
} from '@nexa/contracts';
import { ApiError, fetchAudienceOptions, previewAudience } from '../api/client';
import { currencyLabel, formatNumber } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { Banner, Field, Metric } from '../ui/kit';
import { Icon } from '../ui/icons';

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
};

/** A stored canonical definition, back into the builder's shape (every key is present). */
export function draftOf(definition: unknown): AudienceDraft {
  return { ...EMPTY_AUDIENCE, ...(definition as Partial<AudienceDraft>) };
}

const STATUS_LABELS: Readonly<Record<AudienceCustomerStatus, WebKey>> = {
  ACTIVE: 'web.aud_status_active',
  BLOCKED: 'web.aud_status_blocked',
  ANY: 'web.aud_status_any',
};
const PURCHASE_LABELS: Readonly<Record<AudiencePurchaseFilter, WebKey>> = {
  ANY: 'web.aud_purchase_any',
  PURCHASED: 'web.aud_purchase_yes',
  NEVER_PURCHASED: 'web.aud_purchase_no',
};
const TRIAL_LABELS: Readonly<Record<AudienceTrialFilter, WebKey>> = {
  ANY: 'web.aud_any',
  USED: 'web.aud_trial_used',
  NOT_USED: 'web.aud_trial_unused',
};
const REFERRAL_LABELS: Readonly<Record<AudienceReferralFilter, WebKey>> = {
  ANY: 'web.aud_any',
  PARTICIPANT: 'web.aud_referral_participant',
  NON_PARTICIPANT: 'web.aud_referral_none',
  REFERRER: 'web.aud_referral_referrer',
  REFERRED: 'web.aud_referral_referred',
};
const ACTIVE_SERVICE_LABELS: Readonly<Record<AudienceActiveServiceFilter, WebKey>> = {
  ANY: 'web.aud_any',
  HAS: 'web.aud_active_service_has',
  NONE: 'web.aud_active_service_none',
};

/** One tag's part in the audience: not used, required (any of) or excluded (none of). */
type TagRole = 'IGNORE' | 'ANY_OF' | 'NONE_OF';
const TAG_ROLE_LABELS: Readonly<Record<TagRole, WebKey>> = {
  IGNORE: 'web.aud_tag_ignore',
  ANY_OF: 'web.aud_tag_any_of',
  NONE_OF: 'web.aud_tag_none_of',
};
const TAG_ROLES: readonly TagRole[] = ['IGNORE', 'ANY_OF', 'NONE_OF'];

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

function tagRoleOf(tags: AudienceDraft['tags'], id: string): TagRole {
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
function dayToInstant(value: string): string | null {
  return value === '' ? null : `${value}T00:00:00.000Z`;
}
function instantToDay(value: string | null): string {
  return value === null ? '' : value.slice(0, 10);
}
function whole(value: string): number | null {
  if (value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function toggle<T>(list: readonly T[], value: T): T[] {
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

export function AudienceBuilder({
  value,
  onChange,
  disabled = false,
}: {
  value: AudienceDraft;
  onChange: (next: AudienceDraft) => void;
  disabled?: boolean;
}) {
  const options = useQuery({ queryKey: ['audience-options'], queryFn: fetchAudienceOptions });
  const count = useMutation({ mutationFn: () => previewAudience(value) });
  const [serviceOpen, setServiceOpen] = useState(value.service !== null);
  const set = (patch: Partial<AudienceDraft>) => onChange({ ...value, ...patch });
  const opts: AudienceOptionsResponse | undefined = options.data;
  const segment = value.segment ?? { ordinary: false, resellerTierIds: [] };
  const setSegment = (next: { ordinary: boolean; resellerTierIds: string[] }) =>
    set({ segment: next.ordinary || next.resellerTierIds.length > 0 ? next : null });
  const service = value.service ?? {
    productIds: [],
    panelIds: [],
    states: [],
    expiringWithinHours: null,
    expired: false,
  };
  const currency = opts?.currency ?? 'IRT';

  return (
    <div className="audience-builder">
      <div className="aud-section">
        <h3>{t('web.aud_who')}</h3>
        <p className="muted small">{t('web.aud_who_hint')}</p>
        <div className="checks aud-segments">
          <label className="aud-segment">
            <input
              type="checkbox"
              disabled={disabled}
              checked={segment.ordinary}
              onChange={() => setSegment({ ...segment, ordinary: !segment.ordinary })}
            />{' '}
            {t('web.aud_ordinary')}
          </label>
          {(opts?.resellerTiers ?? []).map((tier) => (
            <label key={tier.id} className="aud-segment">
              <input
                type="checkbox"
                disabled={disabled}
                checked={segment.resellerTierIds.includes(tier.id)}
                onChange={() =>
                  setSegment({
                    ...segment,
                    resellerTierIds: toggle(segment.resellerTierIds, tier.id),
                  })
                }
              />{' '}
              {t('web.aud_tier')} {tier.name}
            </label>
          ))}
        </div>

        <Field
          label={t('web.aud_customer_ids')}
          htmlFor="aud-ids"
          hint={t('web.aud_customer_ids_hint')}
        >
          <textarea
            id="aud-ids"
            dir="ltr"
            rows={2}
            disabled={disabled}
            value={(value.customerIds ?? []).join('\n')}
            onChange={(event) => {
              const ids = event.target.value
                .split(/[\s,]+/u)
                .map((id) => id.trim())
                .filter((id) => id !== '');
              set({ customerIds: ids.length === 0 ? null : ids });
            }}
          />
        </Field>
      </div>

      {(opts?.tags.length ?? 0) > 0 && (
        <div className="aud-section">
          <h4 className="field-group-head">{t('web.aud_tags')}</h4>
          <p className="muted small">{t('web.aud_tags_hint')}</p>
          <div className="form-grid c3 aud-grid">
            {(opts?.tags ?? []).map((tag) => (
              <Field
                key={tag.id}
                label={tag.archived ? `${tag.label} (${t('web.aud_tag_archived')})` : tag.label}
                htmlFor={`aud-tag-${tag.id}`}
              >
                <select
                  id={`aud-tag-${tag.id}`}
                  disabled={disabled}
                  value={tagRoleOf(value.tags, tag.id)}
                  onChange={(event) =>
                    set({ tags: withTagRole(value.tags, tag.id, event.target.value as TagRole) })
                  }
                >
                  {TAG_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {t(TAG_ROLE_LABELS[role])}
                    </option>
                  ))}
                </select>
              </Field>
            ))}
          </div>
        </div>
      )}

      <div className="aud-section">
        <h4 className="field-group-head">{t('web.cb_aud_profile')}</h4>
        <div className="form-grid c3 aud-grid">
          <Field label={t('web.aud_purchase')} htmlFor="aud-purchase">
            <select
              id="aud-purchase"
              disabled={disabled}
              value={value.purchase}
              onChange={(event) => set({ purchase: event.target.value as AudiencePurchaseFilter })}
            >
              {AUDIENCE_PURCHASE_FILTERS.map((option) => (
                <option key={option} value={option}>
                  {t(PURCHASE_LABELS[option])}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('web.aud_status')} htmlFor="aud-status">
            <select
              id="aud-status"
              disabled={disabled}
              value={value.customerStatus}
              onChange={(event) =>
                set({ customerStatus: event.target.value as AudienceCustomerStatus })
              }
            >
              {AUDIENCE_CUSTOMER_STATUSES.map((option) => (
                <option key={option} value={option}>
                  {t(STATUS_LABELS[option])}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('web.aud_trial')} htmlFor="aud-trial">
            <select
              id="aud-trial"
              disabled={disabled}
              value={value.trial}
              onChange={(event) => set({ trial: event.target.value as AudienceTrialFilter })}
            >
              {AUDIENCE_TRIAL_FILTERS.map((option) => (
                <option key={option} value={option}>
                  {t(TRIAL_LABELS[option])}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('web.aud_referral')} htmlFor="aud-referral">
            <select
              id="aud-referral"
              disabled={disabled}
              value={value.referral}
              onChange={(event) => set({ referral: event.target.value as AudienceReferralFilter })}
            >
              {AUDIENCE_REFERRAL_FILTERS.map((option) => (
                <option key={option} value={option}>
                  {t(REFERRAL_LABELS[option])}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('web.aud_active_service')} htmlFor="aud-active-service">
            <select
              id="aud-active-service"
              disabled={disabled}
              value={value.activeService}
              onChange={(event) =>
                set({ activeService: event.target.value as AudienceActiveServiceFilter })
              }
            >
              {AUDIENCE_ACTIVE_SERVICE_FILTERS.map((option) => (
                <option key={option} value={option}>
                  {t(ACTIVE_SERVICE_LABELS[option])}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <h4 className="field-group-head">{t('web.cb_aud_dates')}</h4>
        <div className="form-grid c3 aud-grid">
          <Field label={t('web.aud_registered_from')} htmlFor="aud-reg-from">
            <input
              id="aud-reg-from"
              type="date"
              disabled={disabled}
              value={instantToDay(value.registeredFrom)}
              onChange={(event) => set({ registeredFrom: dayToInstant(event.target.value) })}
            />
          </Field>
          <Field label={t('web.aud_registered_before')} htmlFor="aud-reg-before">
            <input
              id="aud-reg-before"
              type="date"
              disabled={disabled}
              value={instantToDay(value.registeredBefore)}
              onChange={(event) => set({ registeredBefore: dayToInstant(event.target.value) })}
            />
          </Field>
          <Field label={t('web.aud_age_min')} htmlFor="aud-age-min">
            <input
              id="aud-age-min"
              inputMode="numeric"
              disabled={disabled}
              value={value.accountAgeMinDays ?? ''}
              onChange={(event) => set({ accountAgeMinDays: whole(event.target.value) })}
            />
          </Field>
          <Field label={t('web.aud_age_max')} htmlFor="aud-age-max">
            <input
              id="aud-age-max"
              inputMode="numeric"
              disabled={disabled}
              value={value.accountAgeMaxDays ?? ''}
              onChange={(event) => set({ accountAgeMaxDays: whole(event.target.value) })}
            />
          </Field>
          <Field label={t('web.aud_last_purchase_from')} htmlFor="aud-lp-from">
            <input
              id="aud-lp-from"
              type="date"
              disabled={disabled}
              value={instantToDay(value.lastPurchaseFrom)}
              onChange={(event) => set({ lastPurchaseFrom: dayToInstant(event.target.value) })}
            />
          </Field>
          <Field label={t('web.aud_last_purchase_before')} htmlFor="aud-lp-before">
            <input
              id="aud-lp-before"
              type="date"
              disabled={disabled}
              value={instantToDay(value.lastPurchaseBefore)}
              onChange={(event) => set({ lastPurchaseBefore: dayToInstant(event.target.value) })}
            />
          </Field>
          <Field label={t('web.aud_no_purchase_days')} htmlFor="aud-lapse">
            <input
              id="aud-lapse"
              inputMode="numeric"
              disabled={disabled}
              value={value.noPurchaseForDays ?? ''}
              onChange={(event) => {
                const days = whole(event.target.value);
                set({ noPurchaseForDays: days === 0 ? null : days });
              }}
            />
          </Field>
        </div>
        <h4 className="field-group-head">{t('web.cb_aud_wallet')}</h4>
        <div className="form-grid c3 aud-grid">
          <Field
            label={`${t('web.aud_balance_min')} (${currencyLabel(currency as never)})`}
            htmlFor="aud-bal-min"
          >
            <input
              id="aud-bal-min"
              inputMode="numeric"
              disabled={disabled}
              value={value.walletBalance?.minMinor ?? ''}
              onChange={(event) => {
                const min = /^-?\d+$/u.test(event.target.value) ? event.target.value : null;
                const max = value.walletBalance?.maxMinor ?? null;
                set({
                  walletBalance:
                    min === null && max === null
                      ? null
                      : { currency, minMinor: min, maxMinor: max },
                });
              }}
            />
          </Field>
          <Field
            label={`${t('web.aud_balance_max')} (${currencyLabel(currency as never)})`}
            htmlFor="aud-bal-max"
          >
            <input
              id="aud-bal-max"
              inputMode="numeric"
              disabled={disabled}
              value={value.walletBalance?.maxMinor ?? ''}
              onChange={(event) => {
                const max = /^-?\d+$/u.test(event.target.value) ? event.target.value : null;
                const min = value.walletBalance?.minMinor ?? null;
                set({
                  walletBalance:
                    min === null && max === null
                      ? null
                      : { currency, minMinor: min, maxMinor: max },
                });
              }}
            />
          </Field>
        </div>
      </div>

      <label className="check aud-service-toggle">
        <input
          type="checkbox"
          disabled={disabled}
          checked={serviceOpen}
          onChange={() => {
            const next = !serviceOpen;
            setServiceOpen(next);
            set({ service: next ? service : null });
          }}
        />{' '}
        {t('web.aud_service_toggle')}
      </label>
      {serviceOpen && (
        <div className="inset audience-service">
          <p className="muted small">{t('web.aud_service_hint')}</p>
          <h4>{t('web.aud_products')}</h4>
          <div className="checks">
            {(opts?.products ?? []).map((product) => (
              <label key={product.id}>
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={service.productIds.includes(product.id)}
                  onChange={() =>
                    set({
                      service: { ...service, productIds: toggle(service.productIds, product.id) },
                    })
                  }
                />{' '}
                {product.title}
              </label>
            ))}
          </div>
          <h4>{t('web.aud_panels')}</h4>
          <div className="checks">
            {(opts?.panels ?? []).map((panel) => (
              <label key={panel.id}>
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={service.panelIds.includes(panel.id)}
                  onChange={() =>
                    set({ service: { ...service, panelIds: toggle(service.panelIds, panel.id) } })
                  }
                />{' '}
                {panel.name}
              </label>
            ))}
          </div>
          <h4>{t('web.aud_service_states')}</h4>
          <div className="checks">
            {SERVICE_STATES.map((state) => (
              <label key={state}>
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={service.states.includes(state)}
                  onChange={() =>
                    set({ service: { ...service, states: toggle(service.states, state) } })
                  }
                />{' '}
                {t(SERVICE_STATE_LABELS[state])}
              </label>
            ))}
          </div>
          <div className="grid-2">
            <Field label={t('web.aud_expiring_hours')} htmlFor="aud-expiring">
              <input
                id="aud-expiring"
                inputMode="numeric"
                disabled={disabled || service.expired}
                value={service.expiringWithinHours ?? ''}
                onChange={(event) => {
                  const hours = whole(event.target.value);
                  set({ service: { ...service, expiringWithinHours: hours === 0 ? null : hours } });
                }}
              />
            </Field>
            <label className="checks">
              <input
                type="checkbox"
                disabled={disabled || service.expiringWithinHours !== null}
                checked={service.expired}
                onChange={() => set({ service: { ...service, expired: !service.expired } })}
              />{' '}
              {t('web.aud_expired')}
            </label>
          </div>
        </div>
      )}

      <div className="aud-count">
        <button
          type="button"
          className="btn sm"
          disabled={count.isPending}
          onClick={() => count.mutate()}
        >
          <Icon name="users" />
          {t('web.aud_count')}
        </button>
        {count.data !== undefined && (
          <>
            <Metric
              label={t('web.aud_count_customers')}
              value={formatNumber(count.data.preview.customers)}
            />
            <Metric
              label={t('web.aud_count_reachable')}
              value={formatNumber(count.data.preview.reachable)}
            />
          </>
        )}
      </div>
      {count.error !== null && (
        <Banner tone="danger">{audienceMessage(count.error) ?? t('web.error')}</Banner>
      )}
    </div>
  );
}

/**
 * The filters of a frozen definition, as sentences an operator reads on a report — the
 * brief's "filters" on a broadcast and a mass operation.
 */
export function describeAudience(definition: unknown): string[] {
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
