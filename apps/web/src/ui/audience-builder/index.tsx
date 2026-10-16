import { useEffect, useId, useState, type ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  AUDIENCE_ACTIVE_SERVICE_FILTERS,
  AUDIENCE_CUSTOMER_STATUSES,
  AUDIENCE_PURCHASE_FILTERS,
  AUDIENCE_REFERRAL_FILTERS,
  AUDIENCE_TRIAL_FILTERS,
  SERVICE_STATES,
  type AudienceOptionsResponse,
} from '@nexa/contracts';
import { ApiError, fetchAudienceOptions, previewAudience } from '../../api/client';
import { currencyLabel, formatNumber } from '../../format';
import { t, type WebKey } from '../../i18n/web.fa';
import { Banner, Field, Ltr } from '../kit';
import { Icon } from '../icons';
import { DateField, formatDateFieldValue } from '../date-field';
import {
  ACTIVE_SERVICE_LABELS,
  EMPTY_AUDIENCE,
  PURCHASE_LABELS,
  REFERRAL_LABELS,
  SERVICE_STATE_LABELS,
  STATUS_LABELS,
  TAG_ROLES,
  TAG_ROLE_LABELS,
  TRIAL_LABELS,
  audienceMessage,
  dayToInstant,
  instantToDay,
  tagRoleOf,
  toggle,
  whole,
  wireAudience,
  withTagRole,
  type AudienceDraft,
} from './model';

/**
 * The ONE audience builder (W1.6), shared by bulk operations, broadcasts and campaigns: a live
 * count card («N مشتری · M قابل دسترس در ربات», debounced through the existing count
 * endpoint — `POST /audience/preview`, which writes nothing), «شروع سریع» presets, a list of
 * the ACTIVE conditions only (coloured group dot, label, Persian value summary, «تغییر» inline
 * editor, ×; «وضعیت حساب» fixed), and «+ افزودن شرط» with a grouped menu (چه کسانی · رفتار و
 * وضعیت · زمان · کیف پول · سرویس‌ها).
 *
 * It edits the SAME `AudienceDraft` with the same transformations as the form it replaced
 * (`model.ts`), so the request body is byte-for-byte the same for the same audience. It never
 * decides membership: every figure it shows is the server's.
 *
 * The count card shows customers and reachable customers only: the preview has no service
 * total, and no figure is drawn that the server did not send.
 */
export interface AudienceConditionsProps<Draft> {
  value: Draft;
  onChange: (next: Draft) => void;
  disabled?: boolean;
}

/** How long the draft must be still before it is counted. */
export const AUDIENCE_COUNT_DEBOUNCE_MS = 600;

type Group = 'who' | 'act' | 'time' | 'money' | 'svc';
const GROUPS: readonly { key: Group; label: WebKey }[] = [
  { key: 'who', label: 'web.aq_group_who' },
  { key: 'act', label: 'web.aq_group_act' },
  { key: 'time', label: 'web.aq_group_time' },
  { key: 'money', label: 'web.aq_group_money' },
  { key: 'svc', label: 'web.aq_group_svc' },
];

type Service = NonNullable<AudienceDraft['service']>;
const NO_SERVICE: Service = {
  productIds: [],
  panelIds: [],
  states: [],
  expiringWithinHours: null,
  expired: false,
};
function serviceIsEmpty(service: Service): boolean {
  return (
    service.productIds.length === 0 &&
    service.panelIds.length === 0 &&
    service.states.length === 0 &&
    service.expiringWithinHours === null &&
    !service.expired
  );
}

interface Preset {
  readonly key: string;
  readonly label: WebKey;
  readonly patch: Partial<AudienceDraft>;
}
export const AUDIENCE_PRESETS: readonly Preset[] = [
  { key: 'all', label: 'web.aq_preset_all', patch: {} },
  { key: 'never', label: 'web.aq_preset_never', patch: { purchase: 'NEVER_PURCHASED' } },
  {
    key: 'lapsed',
    label: 'web.aq_preset_lapsed',
    patch: { purchase: 'PURCHASED', noPurchaseForDays: 60 },
  },
  { key: 'no-service', label: 'web.aq_preset_no_service', patch: { activeService: 'NONE' } },
  {
    key: 'expiring',
    label: 'web.aq_preset_expiring',
    patch: { service: { ...NO_SERVICE, states: ['ACTIVE'], expiringWithinHours: 72 } },
  },
];

function joinShort(items: readonly string[], keep = 2): string {
  const separator = t('web.list_separator');
  if (items.length <= keep) return items.join(separator);
  return t('web.aq_more')
    .replace('{list}', items.slice(0, keep).join(separator))
    .replace('{n}', formatNumber(items.length - keep));
}
function range(from: string | null, to: string | null): string {
  if (from !== null && to !== null)
    return t('web.aq_range_from_to').replace('{a}', from).replace('{b}', to);
  if (from !== null) return t('web.aq_range_from').replace('{a}', from);
  if (to !== null) return t('web.aq_range_to').replace('{b}', to);
  return '';
}
/** The from / before pair of a half-open date range, as one phrase. */
function dateRange(from: string | null, before: string | null): string {
  return [
    ...(from === null ? [] : [t('web.aq_from').replace('{a}', jalaliDay(from) ?? '')]),
    ...(before === null ? [] : [t('web.aq_before').replace('{d}', jalaliDay(before) ?? '')]),
  ].join(' — ');
}
function jalaliDay(instant: string | null): string | null {
  if (instant === null) return null;
  const day = instantToDay(instant);
  return formatDateFieldValue('date', day) ?? day;
}

interface Condition {
  readonly id: string;
  readonly group: Group;
  readonly label: string;
  readonly fixed?: boolean;
  readonly on: boolean;
  readonly summary: () => string;
  /** The draft with this condition gone. */
  readonly reset: () => AudienceDraft;
  readonly editor: () => ReactNode;
}

/** A pressed / not-pressed pill. */
function Pill({
  pressed,
  onClick,
  disabled,
  tone,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  disabled: boolean;
  tone?: 'warn';
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`aq-pill${tone === 'warn' ? ' warn' : ''}`}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Segmented<T extends string>({
  label,
  options,
  value,
  labels,
  onChange,
  disabled,
}: {
  label: string;
  options: readonly T[];
  value: T;
  labels: Readonly<Record<T, WebKey>>;
  onChange: (next: T) => void;
  disabled: boolean;
}) {
  return (
    <div className="aq-seg" role="group" aria-label={label}>
      {options.map((option) => (
        <Pill
          key={option}
          pressed={value === option}
          disabled={disabled}
          onClick={() => onChange(option)}
        >
          {t(labels[option])}
        </Pill>
      ))}
    </div>
  );
}

export function AudienceConditions({
  value,
  onChange,
  disabled = false,
}: AudienceConditionsProps<AudienceDraft>) {
  const options = useQuery({ queryKey: ['audience-options'], queryFn: fetchAudienceOptions });
  const opts: AudienceOptionsResponse | undefined = options.data;
  const [added, setAdded] = useState<readonly string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const menuId = useId();

  const set = (patch: Partial<AudienceDraft>) => onChange({ ...value, ...patch });
  const segment = value.segment ?? { ordinary: false, resellerTierIds: [] };
  const setSegment = (next: { ordinary: boolean; resellerTierIds: string[] }) =>
    set({ segment: next.ordinary || next.resellerTierIds.length > 0 ? next : null });
  const service = value.service ?? NO_SERVICE;
  /** An emptied service criterion stays "any service" while its row is drawn; × removes it. */
  const setService = (next: Service) => set({ service: next });
  const currency = opts?.currency ?? 'IRT';
  const wallet = (min: string | null, max: string | null) =>
    set({
      walletBalance:
        min === null && max === null ? null : { currency, minMinor: min, maxMinor: max },
    });

  const tierName = (id: string) => opts?.resellerTiers.find((tier) => tier.id === id)?.name ?? id;
  const botName = (id: string) => opts?.bots.find((bot) => bot.id === id)?.username ?? id;
  const tagName = (id: string) => opts?.tags.find((tag) => tag.id === id)?.label ?? id;
  const productName = (id: string) =>
    opts?.products.find((product) => product.id === id)?.title ?? id;
  const panelName = (id: string) => opts?.panels.find((panel) => panel.id === id)?.name ?? id;

  const numberInput = (
    id: string,
    label: string,
    current: number | string | null | undefined,
    onText: (text: string) => void,
  ) => (
    <Field label={label} htmlFor={id}>
      <input
        id={id}
        className="input aq-num"
        inputMode="numeric"
        dir="ltr"
        disabled={disabled}
        value={current ?? ''}
        onChange={(event) => onText(event.target.value)}
      />
    </Field>
  );
  const dateInput = (
    id: string,
    label: string,
    key: 'registeredFrom' | 'registeredBefore' | 'lastPurchaseFrom' | 'lastPurchaseBefore',
  ) => (
    <Field label={label} htmlFor={id}>
      <DateField
        id={id}
        value={instantToDay(value[key])}
        disabled={disabled}
        onChange={(day) => set({ [key]: dayToInstant(day) })}
      />
    </Field>
  );

  const conditions: Condition[] = [
    {
      id: 'status',
      group: 'who',
      label: t('web.aud_status'),
      fixed: true,
      on: true,
      summary: () => t(STATUS_LABELS[value.customerStatus]),
      reset: () => value,
      editor: () => (
        <Segmented
          label={t('web.aud_status')}
          options={AUDIENCE_CUSTOMER_STATUSES}
          value={value.customerStatus}
          labels={STATUS_LABELS}
          disabled={disabled}
          onChange={(customerStatus) => set({ customerStatus })}
        />
      ),
    },
    {
      id: 'segment',
      group: 'who',
      label: t('web.aq_segment'),
      on: value.segment !== null,
      summary: () =>
        joinShort([
          ...(segment.ordinary ? [t('web.aud_ordinary')] : []),
          ...segment.resellerTierIds.map((id) => `${t('web.aud_tier')} ${tierName(id)}`),
        ]),
      reset: () => ({ ...value, segment: null }),
      editor: () => (
        <>
          <p className="aq-hint">{t('web.aud_who_hint')}</p>
          <div className="aq-pills" role="group" aria-label={t('web.aq_segment')}>
            <Pill
              pressed={segment.ordinary}
              disabled={disabled}
              onClick={() => setSegment({ ...segment, ordinary: !segment.ordinary })}
            >
              {t('web.aud_ordinary')}
            </Pill>
            {(opts?.resellerTiers ?? []).map((tier) => (
              <Pill
                key={tier.id}
                pressed={segment.resellerTierIds.includes(tier.id)}
                disabled={disabled}
                onClick={() =>
                  setSegment({
                    ...segment,
                    resellerTierIds: toggle(segment.resellerTierIds, tier.id),
                  })
                }
              >
                {t('web.aud_tier')} {tier.name}
              </Pill>
            ))}
          </div>
        </>
      ),
    },
    {
      id: 'ids',
      group: 'who',
      label: t('web.aud_customer_ids'),
      on: value.customerIds !== null,
      summary: () =>
        t('web.aq_people').replace('{n}', formatNumber(value.customerIds?.length ?? 0)),
      reset: () => ({ ...value, customerIds: null }),
      editor: () => (
        <Field
          label={t('web.aud_customer_ids')}
          htmlFor="aud-ids"
          hint={t('web.aud_customer_ids_hint')}
        >
          <textarea
            id="aud-ids"
            className="input"
            dir="ltr"
            rows={3}
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
      ),
    },
    ...((opts?.bots.length ?? 0) > 1
      ? [
          {
            id: 'bots',
            group: 'who' as const,
            label: t('web.aud_bots'),
            on: value.botInstanceIds !== null,
            summary: () => joinShort((value.botInstanceIds ?? []).map((id) => `@${botName(id)}`)),
            reset: () => ({ ...value, botInstanceIds: null }),
            editor: () => (
              <>
                <p className="aq-hint">{t('web.aud_bots_hint')}</p>
                <div className="aq-pills" role="group" aria-label={t('web.aud_bots')}>
                  {(opts?.bots ?? []).map((bot) => (
                    <Pill
                      key={bot.id}
                      pressed={(value.botInstanceIds ?? []).includes(bot.id)}
                      disabled={disabled}
                      onClick={() => {
                        const next = toggle(value.botInstanceIds ?? [], bot.id);
                        set({ botInstanceIds: next.length === 0 ? null : next });
                      }}
                    >
                      <Ltr mono={false}>@{bot.username}</Ltr>
                      {/* Review n1: a bot that cannot send pauses the broadcast for everyone. */}
                      {bot.status !== 'ACTIVE' && <small> — {t('web.aud_bot_not_active')}</small>}
                    </Pill>
                  ))}
                </div>
              </>
            ),
          },
        ]
      : []),
    ...((opts?.tags.length ?? 0) > 0
      ? [
          {
            id: 'tags',
            group: 'who' as const,
            label: t('web.aud_tags'),
            on: value.tags !== null,
            summary: () =>
              [
                ...((value.tags?.anyOf.length ?? 0) > 0
                  ? [
                      t('web.aq_tag_has').replace(
                        '{list}',
                        joinShort((value.tags?.anyOf ?? []).map(tagName)),
                      ),
                    ]
                  : []),
                ...((value.tags?.noneOf.length ?? 0) > 0
                  ? [
                      t('web.aq_tag_hasnt').replace(
                        '{list}',
                        joinShort((value.tags?.noneOf ?? []).map(tagName)),
                      ),
                    ]
                  : []),
              ].join(' · '),
            reset: () => ({ ...value, tags: null }),
            editor: () => (
              <>
                <p className="aq-hint">{t('web.aud_tags_hint')}</p>
                <div className="aq-tagrows">
                  {(opts?.tags ?? []).map((tag) => {
                    const name = tag.archived
                      ? `${tag.label} (${t('web.aud_tag_archived')})`
                      : tag.label;
                    return (
                      <div key={tag.id} className="aq-tagrow">
                        <span>{name}</span>
                        <Segmented
                          label={name}
                          options={TAG_ROLES}
                          value={tagRoleOf(value.tags, tag.id)}
                          labels={TAG_ROLE_LABELS}
                          disabled={disabled}
                          onChange={(role) => set({ tags: withTagRole(value.tags, tag.id, role) })}
                        />
                      </div>
                    );
                  })}
                </div>
              </>
            ),
          },
        ]
      : []),
    {
      id: 'purchase',
      group: 'act',
      label: t('web.aud_purchase'),
      on: value.purchase !== 'ANY',
      summary: () => t(PURCHASE_LABELS[value.purchase]),
      reset: () => ({ ...value, purchase: 'ANY' }),
      editor: () => (
        <Segmented
          label={t('web.aud_purchase')}
          options={AUDIENCE_PURCHASE_FILTERS.filter((one) => one !== 'ANY')}
          value={value.purchase}
          labels={PURCHASE_LABELS}
          disabled={disabled}
          onChange={(purchase) => set({ purchase })}
        />
      ),
    },
    {
      id: 'activeService',
      group: 'act',
      label: t('web.aud_active_service'),
      on: value.activeService !== 'ANY',
      summary: () => t(ACTIVE_SERVICE_LABELS[value.activeService]),
      reset: () => ({ ...value, activeService: 'ANY' }),
      editor: () => (
        <Segmented
          label={t('web.aud_active_service')}
          options={AUDIENCE_ACTIVE_SERVICE_FILTERS.filter((one) => one !== 'ANY')}
          value={value.activeService}
          labels={ACTIVE_SERVICE_LABELS}
          disabled={disabled}
          onChange={(activeService) => set({ activeService })}
        />
      ),
    },
    {
      id: 'trial',
      group: 'act',
      label: t('web.aud_trial'),
      on: value.trial !== 'ANY',
      summary: () => t(TRIAL_LABELS[value.trial]),
      reset: () => ({ ...value, trial: 'ANY' }),
      editor: () => (
        <Segmented
          label={t('web.aud_trial')}
          options={AUDIENCE_TRIAL_FILTERS.filter((one) => one !== 'ANY')}
          value={value.trial}
          labels={TRIAL_LABELS}
          disabled={disabled}
          onChange={(trial) => set({ trial })}
        />
      ),
    },
    {
      id: 'referral',
      group: 'act',
      label: t('web.aud_referral'),
      on: value.referral !== 'ANY',
      summary: () => t(REFERRAL_LABELS[value.referral]),
      reset: () => ({ ...value, referral: 'ANY' }),
      editor: () => (
        <Segmented
          label={t('web.aud_referral')}
          options={AUDIENCE_REFERRAL_FILTERS.filter((one) => one !== 'ANY')}
          value={value.referral}
          labels={REFERRAL_LABELS}
          disabled={disabled}
          onChange={(referral) => set({ referral })}
        />
      ),
    },
    {
      id: 'registered',
      group: 'time',
      label: t('web.aq_registered'),
      on: value.registeredFrom !== null || value.registeredBefore !== null,
      summary: () => dateRange(value.registeredFrom, value.registeredBefore),
      reset: () => ({ ...value, registeredFrom: null, registeredBefore: null }),
      editor: () => (
        <div className="aq-two">
          {dateInput('aud-reg-from', t('web.aud_registered_from'), 'registeredFrom')}
          {dateInput('aud-reg-before', t('web.aud_registered_before'), 'registeredBefore')}
        </div>
      ),
    },
    {
      id: 'age',
      group: 'time',
      label: t('web.aq_age'),
      on: value.accountAgeMinDays !== null || value.accountAgeMaxDays !== null,
      summary: () =>
        `${range(
          value.accountAgeMinDays === null ? null : formatNumber(value.accountAgeMinDays),
          value.accountAgeMaxDays === null ? null : formatNumber(value.accountAgeMaxDays),
        )} ${t('web.aq_day_unit')}`,
      reset: () => ({ ...value, accountAgeMinDays: null, accountAgeMaxDays: null }),
      editor: () => (
        <div className="aq-two">
          {numberInput('aud-age-min', t('web.aud_age_min'), value.accountAgeMinDays, (text) =>
            set({ accountAgeMinDays: whole(text) }),
          )}
          {numberInput('aud-age-max', t('web.aud_age_max'), value.accountAgeMaxDays, (text) =>
            set({ accountAgeMaxDays: whole(text) }),
          )}
        </div>
      ),
    },
    {
      id: 'lastPurchase',
      group: 'time',
      label: t('web.aq_last_purchase'),
      on: value.lastPurchaseFrom !== null || value.lastPurchaseBefore !== null,
      summary: () => dateRange(value.lastPurchaseFrom, value.lastPurchaseBefore),
      reset: () => ({ ...value, lastPurchaseFrom: null, lastPurchaseBefore: null }),
      editor: () => (
        <div className="aq-two">
          {dateInput('aud-lp-from', t('web.aud_last_purchase_from'), 'lastPurchaseFrom')}
          {dateInput('aud-lp-before', t('web.aud_last_purchase_before'), 'lastPurchaseBefore')}
        </div>
      ),
    },
    {
      id: 'lapse',
      group: 'time',
      label: t('web.aq_lapse'),
      on: value.noPurchaseForDays !== null,
      summary: () =>
        t('web.aq_lapse_summary').replace('{n}', formatNumber(value.noPurchaseForDays ?? 0)),
      reset: () => ({ ...value, noPurchaseForDays: null }),
      editor: () => (
        <div className="aq-pills">
          {[30, 60, 90].map((days) => (
            <Pill
              key={days}
              pressed={value.noPurchaseForDays === days}
              disabled={disabled}
              onClick={() => set({ noPurchaseForDays: days })}
            >
              {t('web.aq_days').replace('{n}', formatNumber(days))}
            </Pill>
          ))}
          <span className="aq-or">{t('web.aq_or')}</span>
          {numberInput(
            'aud-lapse',
            t('web.aud_no_purchase_days'),
            value.noPurchaseForDays,
            (text) => {
              const days = whole(text);
              set({ noPurchaseForDays: days === 0 ? null : days });
            },
          )}
        </div>
      ),
    },
    {
      id: 'wallet',
      group: 'money',
      label: t('web.aq_wallet'),
      on: value.walletBalance !== null,
      summary: () =>
        `${range(
          value.walletBalance?.minMinor ?? null,
          value.walletBalance?.maxMinor ?? null,
        )} ${currencyLabel(currency as never)}`,
      reset: () => ({ ...value, walletBalance: null }),
      editor: () => (
        <div className="aq-two">
          {numberInput(
            'aud-bal-min',
            `${t('web.aud_balance_min')} (${currencyLabel(currency as never)})`,
            value.walletBalance?.minMinor,
            (text) =>
              wallet(/^-?\d+$/u.test(text) ? text : null, value.walletBalance?.maxMinor ?? null),
          )}
          {numberInput(
            'aud-bal-max',
            `${t('web.aud_balance_max')} (${currencyLabel(currency as never)})`,
            value.walletBalance?.maxMinor,
            (text) =>
              wallet(value.walletBalance?.minMinor ?? null, /^-?\d+$/u.test(text) ? text : null),
          )}
        </div>
      ),
    },
    {
      id: 'svcProducts',
      group: 'svc',
      label: t('web.aud_products'),
      on: service.productIds.length > 0,
      summary: () => joinShort(service.productIds.map(productName)),
      reset: () => serviceWithout({ productIds: [] }),
      editor: () => (
        <>
          <p className="aq-hint">{t('web.aud_service_hint')}</p>
          <div className="aq-pills" role="group" aria-label={t('web.aud_products')}>
            {(opts?.products ?? []).map((product) => (
              <Pill
                key={product.id}
                pressed={service.productIds.includes(product.id)}
                disabled={disabled}
                onClick={() =>
                  setService({ ...service, productIds: toggle(service.productIds, product.id) })
                }
              >
                {product.title}
              </Pill>
            ))}
          </div>
        </>
      ),
    },
    {
      id: 'svcPanels',
      group: 'svc',
      label: t('web.aud_panels'),
      on: service.panelIds.length > 0,
      summary: () => joinShort(service.panelIds.map(panelName), 4),
      reset: () => serviceWithout({ panelIds: [] }),
      editor: () => (
        <>
          <p className="aq-hint">{t('web.aud_service_hint')}</p>
          <div className="aq-pills" role="group" aria-label={t('web.aud_panels')}>
            {(opts?.panels ?? []).map((panel) => (
              <Pill
                key={panel.id}
                pressed={service.panelIds.includes(panel.id)}
                disabled={disabled}
                onClick={() =>
                  setService({ ...service, panelIds: toggle(service.panelIds, panel.id) })
                }
              >
                <Ltr mono={false}>{panel.name}</Ltr>
              </Pill>
            ))}
          </div>
        </>
      ),
    },
    {
      id: 'svcStates',
      group: 'svc',
      label: t('web.aud_service_states'),
      on: service.states.length > 0,
      summary: () =>
        joinShort(
          service.states.map((state) => t(SERVICE_STATE_LABELS[state])),
          3,
        ),
      reset: () => serviceWithout({ states: [] }),
      editor: () => (
        <>
          <p className="aq-hint">{t('web.aud_service_hint')}</p>
          <div className="aq-pills" role="group" aria-label={t('web.aud_service_states')}>
            {SERVICE_STATES.map((state) => (
              <Pill
                key={state}
                pressed={service.states.includes(state)}
                disabled={disabled}
                onClick={() => setService({ ...service, states: toggle(service.states, state) })}
              >
                {t(SERVICE_STATE_LABELS[state])}
              </Pill>
            ))}
          </div>
        </>
      ),
    },
    {
      id: 'svcExpiry',
      group: 'svc',
      label: t('web.aq_expiry'),
      on: service.expiringWithinHours !== null || service.expired,
      summary: () => {
        if (service.expired) return t('web.aud_expired');
        const hours = service.expiringWithinHours ?? 0;
        return hours % 24 === 0
          ? t('web.aq_expiring_days').replace('{n}', formatNumber(hours / 24))
          : t('web.aq_expiring_hours').replace('{n}', formatNumber(hours));
      },
      reset: () => serviceWithout({ expiringWithinHours: null, expired: false }),
      editor: () => (
        <div className="aq-pills">
          {(
            [
              [24, 'web.aq_expiry_24'],
              [72, 'web.aq_expiry_72'],
              [168, 'web.aq_expiry_168'],
            ] as const
          ).map(([hours, key]) => (
            <Pill
              key={hours}
              pressed={!service.expired && service.expiringWithinHours === hours}
              disabled={disabled}
              onClick={() => setService({ ...service, expired: false, expiringWithinHours: hours })}
            >
              {t(key)}
            </Pill>
          ))}
          <span className="aq-or">{t('web.aq_or')}</span>
          {numberInput(
            'aud-expiring',
            t('web.aud_expiring_hours'),
            service.expired ? '' : service.expiringWithinHours,
            (text) => {
              const hours = whole(text);
              setService({
                ...service,
                expired: false,
                expiringWithinHours: hours === 0 ? null : hours,
              });
            },
          )}
          <span className="aq-or">{t('web.aq_or')}</span>
          <Pill
            pressed={service.expired}
            disabled={disabled}
            tone="warn"
            onClick={() =>
              setService({ ...service, expired: !service.expired, expiringWithinHours: null })
            }
          >
            {t('web.aud_expired')}
          </Pill>
        </div>
      ),
    },
  ];

  function serviceWithout(patch: Partial<Service>): AudienceDraft {
    return value.service === null ? value : { ...value, service: { ...value.service, ...patch } };
  }

  /*
   * A stored definition whose service criterion is empty ("any service") reopens as a pending
   * products row, so it is visible and removable rather than an invisible filter.
   */
  const pendingService =
    value.service !== null &&
    serviceIsEmpty(value.service) &&
    !added.some((id) => id.startsWith('svc'));
  const shown = conditions.filter(
    (one) =>
      one.fixed === true ||
      one.on ||
      added.includes(one.id) ||
      (pendingService && one.id === 'svcProducts'),
  );
  const available = conditions.filter((one) => !shown.includes(one));

  const add = (id: string) => {
    setMenu(false);
    setAdded((current) => (current.includes(id) ? current : [...current, id]));
    setEditing(id);
    if (id.startsWith('svc') && value.service === null) set({ service: { ...NO_SERVICE } });
  };
  const remove = (condition: Condition) => {
    setAdded((current) => current.filter((id) => id !== condition.id));
    if (editing === condition.id) setEditing(null);
    const next = condition.reset();
    // Removing the last service row removes "any service" too.
    const otherService = shown.some(
      (one) => one.group === 'svc' && one.id !== condition.id && (one.on || added.includes(one.id)),
    );
    if (
      condition.group === 'svc' &&
      next.service !== null &&
      serviceIsEmpty(next.service) &&
      !otherService
    ) {
      onChange({ ...next, service: null });
      return;
    }
    onChange(next);
  };
  const applyPreset = (preset: Preset) => {
    setAdded([]);
    setEditing(null);
    setMenu(false);
    onChange({ ...EMPTY_AUDIENCE, ...preset.patch });
  };
  const presetActive = (preset: Preset) =>
    JSON.stringify(wireAudience({ ...EMPTY_AUDIENCE, ...preset.patch })) ===
    JSON.stringify(wireAudience(value));

  return (
    <div className="aq audience-builder">
      <div className="aq-top">
        <AudienceCount value={value} />
        <div className="aq-presets" role="group" aria-label={t('web.aq_quick')}>
          <span className="muted small">{t('web.aq_quick')}</span>
          {AUDIENCE_PRESETS.map((preset) => (
            <Pill
              key={preset.key}
              pressed={presetActive(preset)}
              disabled={disabled}
              onClick={() => applyPreset(preset)}
            >
              {t(preset.label)}
            </Pill>
          ))}
        </div>
      </div>

      <ul className="aq-list">
        {shown.map((condition) => {
          const open = editing === condition.id;
          const summary = condition.on ? condition.summary() : '';
          const group = GROUPS.find((one) => one.key === condition.group);
          const editorId = `${menuId}-${condition.id}`;
          return (
            <li
              key={condition.id}
              className={`aq-row${open ? ' open' : ''}${summary === '' ? ' pending' : ''}`}
              data-condition={condition.id}
            >
              <div className="aq-rh">
                <span
                  className={`aq-g aq-g-${condition.group}`}
                  title={group === undefined ? undefined : t(group.label)}
                  aria-hidden="true"
                />
                <span className="aq-lbl">{condition.label}</span>
                <span className="aq-val">
                  {summary === '' ? <span className="muted">{t('web.aq_pending')}</span> : summary}
                </span>
                <span className="aq-rb">
                  <button
                    type="button"
                    className="btn sm ghost"
                    aria-expanded={open}
                    aria-controls={open ? editorId : undefined}
                    aria-label={`${open ? t('web.aq_close') : t('web.aq_change')} ${condition.label}`}
                    onClick={() => setEditing(open ? null : condition.id)}
                  >
                    {open ? t('web.aq_close') : t('web.aq_change')}
                  </button>
                  {condition.fixed !== true && (
                    <button
                      type="button"
                      className="btn sm ghost icon aq-x"
                      disabled={disabled}
                      aria-label={t('web.aq_remove').replace('{label}', condition.label)}
                      title={t('web.aq_remove').replace('{label}', condition.label)}
                      onClick={() => remove(condition)}
                    >
                      <Icon name="x" size={13} />
                    </button>
                  )}
                </span>
              </div>
              {open && (
                <div className="aq-ed" id={editorId}>
                  {condition.editor()}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <div className="aq-addw">
        {available.length > 0 && (
          <button
            type="button"
            className="btn sm aq-add"
            aria-expanded={menu}
            aria-controls={menu ? `${menuId}-menu` : undefined}
            disabled={disabled}
            onClick={() => setMenu(!menu)}
          >
            <Icon name="plus" size={14} />
            {t('web.aq_add')}
          </button>
        )}
        {shown.length > 1 && (
          <button
            type="button"
            className="btn sm ghost"
            disabled={disabled}
            onClick={() => applyPreset(AUDIENCE_PRESETS[0] as Preset)}
          >
            {t('web.aq_clear_all')}
          </button>
        )}
        <span className="muted small aq-note">
          {shown.length > 1 ? t('web.aq_note_all') : t('web.aq_note_none')}
          {value.service !== null && ` ${t('web.aq_note_service')}`}
        </span>
      </div>

      {menu && (
        <div
          className="aq-menu"
          id={`${menuId}-menu`}
          role="group"
          aria-label={t('web.aq_add')}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setMenu(false);
            }
          }}
        >
          {GROUPS.map((group) => {
            const items = available.filter((one) => one.group === group.key);
            if (items.length === 0) return null;
            return (
              <div key={group.key} className="aq-mg" role="group" aria-label={t(group.label)}>
                <b>
                  <span className={`aq-g aq-g-${group.key}`} aria-hidden="true" />
                  {t(group.label)}
                </b>
                {items.map((one) => (
                  <button key={one.id} type="button" className="aq-mi" onClick={() => add(one.id)}>
                    {one.label}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * The live count: the server's answer for the draft once it has been still for
 * `AUDIENCE_COUNT_DEBOUNCE_MS`. A definition already counted is answered from the cache.
 */
function AudienceCount({ value }: { value: AudienceDraft }) {
  const wire = JSON.stringify(wireAudience(value));
  const [settled, setSettled] = useState(wire);
  useEffect(() => {
    if (settled === wire) return undefined;
    const timer = window.setTimeout(() => setSettled(wire), AUDIENCE_COUNT_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [wire, settled]);
  /*
   * The count is automatic now, so a refusal must not be asked again on every change: once
   * the server says this administrator may not count (403), the card shows that and issues
   * no further request — a denied capability issues no request.
   */
  const [refused, setRefused] = useState(false);
  const count = useQuery({
    queryKey: ['audience-preview', settled],
    queryFn: () => previewAudience(JSON.parse(settled) as unknown),
    enabled: !refused,
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 30_000,
  });
  const forbidden = count.error instanceof ApiError && count.error.status === 403;
  useEffect(() => {
    if (forbidden) setRefused(true);
  }, [forbidden]);
  const preview = count.data?.preview;
  const pending = !refused && (settled !== wire || count.isFetching);
  return (
    <div className="aq-count" aria-live="polite" aria-busy={pending}>
      <span className="muted small aq-count-title">{t('web.aq_count_title')}</span>
      {refused ? (
        <Banner tone="info">{t('web.no_permission')}</Banner>
      ) : count.error !== null && !count.isFetching ? (
        <Banner tone="danger">{audienceMessage(count.error) ?? t('web.error')}</Banner>
      ) : (
        <>
          <b className="num" data-testid="audience-customers">
            {preview === undefined ? '—' : formatNumber(preview.customers)}
          </b>
          <span>{t('web.aq_customers')}</span>
          <span className="aq-sub" data-testid="audience-reachable">
            {preview === undefined
              ? t('web.aq_counting')
              : t('web.aq_reachable').replace('{n}', formatNumber(preview.reachable))}
          </span>
        </>
      )}
    </div>
  );
}
