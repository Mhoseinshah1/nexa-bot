import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BROADCAST_BUTTONS_MAX,
  CAMPAIGN_DESCRIPTION_MAX_LENGTH,
  CAMPAIGN_NAME_MAX_LENGTH,
  CAMPAIGN_STATES,
  CASHBACK_PERCENT_MAX,
  CASHBACK_PERCENT_MIN,
  DISCOUNTABLE_PURPOSES,
  PRODUCT_PAGE_MAX,
  uuidV7Schema,
  type BroadcastCounts,
  type BulkCounts,
  type CampaignActionKind,
  type CampaignActionState,
  type CampaignActionsInput,
  type CampaignCreateRequest,
  type CampaignDetail,
  type CampaignPreviewResponse,
  type CampaignResultsResponse,
  type CampaignState,
  type CampaignSummary,
  type CampaignTally,
  type CurrencyCode,
  type DiscountablePurpose,
} from '@nexa/contracts';
import {
  ApiError,
  commandCampaign,
  createCampaign,
  fetchAudienceOptions,
  fetchCampaign,
  fetchCampaignPreview,
  fetchCampaignResults,
  fetchCampaigns,
  fetchProductCategories,
  fetchProducts,
  scheduleCampaign,
  updateCampaign,
} from '../api/client';
import { useSubmissionKey } from '../submission-key';
import { t, type WebKey } from '../i18n/web.fa';
import { navigate, useLinkHandler, type Route } from '../router';
import { PURPOSE_LABELS } from './discounts';
import {
  AudienceBuilder,
  EMPTY_AUDIENCE,
  describeAudience,
  draftOf,
  type AudienceDraft,
} from './audience-builder';
import { messageFor } from './settings';
import {
  Badge,
  Banner,
  Card,
  CursorPager,
  DataTable,
  Empty,
  Field,
  KV,
  Ltr,
  Money,
  Num,
  PageHead,
  Pills,
  StateSwitch,
  useToast,
  type Column,
  type Tone,
} from '../ui/kit';

/**
 * Campaigns — «کمپین‌ها» (round N, C1; `docs/round-n-campaigns-audit.md`).
 *
 * A campaign COMPOSES what already exists and decides none of it: its discount and cashback
 * are rules of the one pricing engine (they also appear on the discounts page), its gifts are
 * mass operations of the shared engine, and its announcement is a broadcast. This page says
 * so in words, because the thing easiest to get wrong about a campaign is what it promises:
 *
 * - **The audience decides who is TOLD and who is GIFTED; it does not decide who may use the
 *   discount.** The pricing engine has no audience dimension, so a campaign's discount and
 *   cashback reach whoever their own scope reaches (audit D4).
 * - **Nothing is priced, sent or credited until the operator confirms the preview**, and the
 *   confirmation binds to what the preview showed: the audience's set and each gift's count
 *   and total liability.
 * - **Cancelling stops future work and undoes nothing**: a redemption, a promised or earned
 *   cashback, a credit, a grant or a delivered message stays as it is.
 * - **Results are persisted facts only**: redemptions of the campaign's own rule, promises
 *   of its own cashback rule, and the engines' own counts. There is no "revenue caused".
 *
 * Every date is the TENANT's calendar and zone, which the server resolves and returns; the
 * browser never converts one.
 */

const CAMPAIGNS_KEY = 'campaigns';

export const CAMPAIGN_STATE_LABELS: Readonly<Record<CampaignState, WebKey>> = {
  DRAFT: 'web.campaign_state_draft',
  SCHEDULED: 'web.campaign_state_scheduled',
  ACTIVE: 'web.campaign_state_active',
  PAUSED: 'web.campaign_state_paused',
  COMPLETED: 'web.campaign_state_completed',
  CANCELLED: 'web.campaign_state_cancelled',
};

const STATE_TONES: Readonly<Record<CampaignState, Tone>> = {
  DRAFT: 'neutral',
  SCHEDULED: 'info',
  ACTIVE: 'ok',
  PAUSED: 'warn',
  COMPLETED: 'neutral',
  CANCELLED: 'danger',
};

export const CAMPAIGN_ACTION_LABELS: Readonly<Record<CampaignActionKind, WebKey>> = {
  DISCOUNT: 'web.campaign_action_discount',
  CASHBACK: 'web.campaign_action_cashback',
  WALLET_GIFT: 'web.campaign_action_wallet_gift',
  TRAFFIC_GIFT: 'web.campaign_action_traffic_gift',
  TIME_GIFT: 'web.campaign_action_time_gift',
  ANNOUNCEMENT: 'web.campaign_action_announcement',
};

const ACTION_STATE_LABELS: Readonly<Record<CampaignActionState, WebKey>> = {
  PENDING: 'web.campaign_action_state_pending',
  LAUNCHED: 'web.campaign_action_state_launched',
  CANCELLED: 'web.campaign_action_state_cancelled',
  FAILED: 'web.campaign_action_state_failed',
};

/** The persisted states the results group by, in words. Unknown ones show as they are. */
const TALLY_STATE_LABELS: Readonly<Record<string, WebKey>> = {
  AWAITING_PAYMENT: 'web.campaign_order_awaiting_payment',
  PAID: 'web.campaign_order_paid',
  REFUNDED: 'web.campaign_order_refunded',
  CANCELLED: 'web.campaign_order_cancelled',
  EXPIRED: 'web.campaign_order_expired',
  PENDING: 'web.campaign_cashback_pending',
  EARNED: 'web.campaign_cashback_earned',
  VOID: 'web.campaign_cashback_void',
};

function StateBadge({ value }: { value: CampaignState }) {
  return <Badge tone={STATE_TONES[value]}>{t(CAMPAIGN_STATE_LABELS[value])}</Badge>;
}

function Moment({ value }: { value: { date: string; time: string } }) {
  return (
    <Ltr>
      {value.date.replaceAll('-', '/')} {value.time}
    </Ltr>
  );
}

function kindsText(kinds: readonly CampaignActionKind[]): string {
  return kinds.length === 0
    ? t('web.campaign_no_actions')
    : kinds.map((kind) => t(CAMPAIGN_ACTION_LABELS[kind])).join(t('web.list_separator'));
}

function campaignErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const key = CAMPAIGN_ERROR_MESSAGES[error.code];
    if (key !== undefined) return t(key);
  }
  return messageFor(error);
}

const CAMPAIGN_ERROR_MESSAGES: Readonly<Record<string, WebKey>> = {
  'campaign.not_editable': 'web.campaign_error_not_editable',
  'campaign.transition_invalid': 'web.campaign_error_transition',
  'campaign.window_invalid': 'web.campaign_error_window',
  'campaign.no_action': 'web.campaign_error_no_action',
  'campaign.confirmation_required': 'web.campaign_error_typed_count',
  'campaign.binding_invalid': 'web.campaign_error_changed',
  'audience.changed': 'web.campaign_error_changed',
  'audience.empty': 'web.campaign_error_empty',
  'audience.definition_invalid': 'web.campaign_error_audience',
  'commerce.discount_code_taken': 'web.campaign_error_code_taken',
  'broadcast.body_invalid': 'web.campaign_error_body',
};

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

type StateFilter = CampaignState | 'ALL';

export function CampaignsPage({
  route,
  denied,
  mayManage,
}: {
  route: Route;
  /** No `campaigns.view`. */
  denied: boolean;
  /** `campaigns.manage` — its own server permission, never derived from `denied`. */
  mayManage: boolean;
}) {
  const onLink = useLinkHandler();
  const filter = (route.query.get('state') ?? 'ALL') as StateFilter;
  const [cursors, setCursors] = useState<{ filter: StateFilter; trail: readonly string[] }>({
    filter,
    trail: [],
  });
  const trail = cursors.filter === filter ? cursors.trail : [];
  const cursor = trail.length > 0 ? trail[trail.length - 1] : undefined;
  const list = useQuery({
    queryKey: [CAMPAIGNS_KEY, 'list', filter, cursor ?? ''],
    queryFn: () =>
      fetchCampaigns({
        ...(filter === 'ALL' ? {} : { state: filter }),
        ...(cursor === undefined ? {} : { cursor }),
      }),
    enabled: !denied,
  });
  const rows = list.data?.campaigns ?? [];

  const columns: Column<CampaignSummary>[] = [
    {
      key: 'name',
      header: t('web.campaign_name'),
      render: (row) => (
        <a href={`/campaigns/${row.id}`} onClick={onLink}>
          {row.name}
        </a>
      ),
    },
    { key: 'state', header: t('web.status'), render: (row) => <StateBadge value={row.state} /> },
    {
      key: 'window',
      header: t('web.campaign_window'),
      render: (row) => (
        <span className="small">
          <Moment value={row.startLocal} /> ← <Moment value={row.endLocal} />
        </span>
      ),
    },
    {
      key: 'actions',
      header: t('web.campaign_actions'),
      render: (row) => kindsText(row.actionKinds),
    },
    {
      key: 'audience',
      header: t('web.campaign_audience_confirmed'),
      align: 'end',
      render: (row) =>
        row.audienceConfirmedCount === null ? (
          <span className="muted">{t('web.campaign_not_confirmed')}</span>
        ) : (
          <Num value={row.audienceConfirmedCount} />
        ),
    },
  ];

  return (
    <>
      <PageHead
        title={t('web.campaigns_title')}
        subtitle={t('web.campaigns_intro')}
        maturity="now"
        actions={
          mayManage && !denied ? (
            <a className="btn primary" href="/campaigns/new" onClick={onLink}>
              {t('web.campaign_new')}
            </a>
          ) : undefined
        }
      />
      <Banner tone="info" title={t('web.campaign_semantics_title')}>
        <p>{t('web.campaign_semantics_audience')}</p>
        <p>{t('web.campaign_semantics_cancel')}</p>
        <p>{t('web.campaign_semantics_results')}</p>
      </Banner>
      <Card>
        <Pills<StateFilter>
          value={filter}
          onChange={(next) => {
            const suffix = next === 'ALL' ? '' : `?state=${next}`;
            navigate(`/campaigns${suffix}`, { replace: true });
          }}
          items={[
            { id: 'ALL', label: t('web.campaign_filter_all') },
            ...CAMPAIGN_STATES.map((state) => ({
              id: state,
              label: t(CAMPAIGN_STATE_LABELS[state]),
            })),
          ]}
        />
        <StateSwitch
          query={list}
          denied={denied}
          isEmpty={rows.length === 0}
          empty={<Empty title={t('web.campaign_empty')} hint={t('web.campaign_empty_hint')} />}
        >
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            caption={t('web.campaigns_title')}
          />
          <CursorPager
            onPrevious={() => setCursors({ filter, trail: trail.slice(0, -1) })}
            onNext={() => {
              const next = list.data?.nextCursor;
              if (next !== null && next !== undefined) {
                setCursors({ filter, trail: [...trail, next] });
              }
            }}
            hasPrevious={trail.length > 0}
            hasNext={(list.data?.nextCursor ?? null) !== null}
            shown={rows.length}
          />
        </StateSwitch>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

type ScopeKind = 'ALL' | 'PRODUCT' | 'CATEGORY';

interface FormState {
  name: string;
  description: string;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  audience: AudienceDraft;
  discountOn: boolean;
  discountKind: 'AUTOMATIC' | 'CODE';
  discountCode: string;
  discountType: 'PERCENTAGE' | 'FIXED_AMOUNT';
  discountValue: string;
  discountPurposes: readonly DiscountablePurpose[];
  discountScope: ScopeKind;
  discountProductId: string;
  discountCategoryId: string;
  discountFirstPurchase: boolean;
  discountMinimum: string;
  discountTotalLimit: string;
  discountPerCustomer: string;
  discountStackable: boolean;
  cashbackOn: boolean;
  cashbackPercent: string;
  cashbackPurposes: readonly DiscountablePurpose[];
  cashbackScope: ScopeKind;
  cashbackProductId: string;
  cashbackCategoryId: string;
  walletOn: boolean;
  walletAmount: string;
  walletNotify: boolean;
  trafficOn: boolean;
  trafficGb: string;
  trafficNotify: boolean;
  timeOn: boolean;
  timeDays: string;
  timeNotify: boolean;
  announcementOn: boolean;
  announcementBody: string;
  buttons: readonly { label: string; url: string }[];
}

const EMPTY_FORM: FormState = {
  name: '',
  description: '',
  startDate: '',
  startTime: '10:00',
  endDate: '',
  endTime: '10:00',
  audience: EMPTY_AUDIENCE,
  discountOn: false,
  discountKind: 'AUTOMATIC',
  discountCode: '',
  discountType: 'PERCENTAGE',
  discountValue: '',
  discountPurposes: ['NEW_SERVICE'],
  discountScope: 'ALL',
  discountProductId: '',
  discountCategoryId: '',
  discountFirstPurchase: false,
  discountMinimum: '',
  discountTotalLimit: '',
  discountPerCustomer: '',
  discountStackable: false,
  cashbackOn: false,
  cashbackPercent: '',
  cashbackPurposes: ['NEW_SERVICE'],
  cashbackScope: 'ALL',
  cashbackProductId: '',
  cashbackCategoryId: '',
  walletOn: false,
  walletAmount: '',
  walletNotify: true,
  trafficOn: false,
  trafficGb: '',
  trafficNotify: true,
  timeOn: false,
  timeDays: '',
  timeNotify: true,
  announcementOn: false,
  announcementBody: '',
  buttons: [],
};

/** A whole number in `[min, max]`, or null. Digits only. */
function wholeIn(raw: string, min: number, max: number): number | null {
  const text = raw.trim();
  if (!/^\d{1,10}$/u.test(text)) return null;
  const value = Number(text);
  return value >= min && value <= max ? value : null;
}

function optionalWhole(raw: string, min: number, max: number): number | null | undefined {
  if (raw.trim() === '') return null;
  const value = wholeIn(raw, min, max);
  return value === null ? undefined : value;
}

/** The whole form as the create/update body, or the field that is wrong. */
export function campaignBodyOf(
  state: FormState,
  currency: CurrencyCode,
): Omit<CampaignCreateRequest, 'idempotencyKey'> | { problem: WebKey } {
  if (state.name.trim() === '') return { problem: 'web.campaign_problem_name' };
  const moment = /^\d{4}-\d{2}-\d{2}$/u;
  if (!moment.test(state.startDate) || !moment.test(state.endDate)) {
    return { problem: 'web.campaign_problem_date' };
  }
  // The shared builder's own draft: the contract's input shape, sent as it is.
  const audience = state.audience;

  const scopeOf = (kind: ScopeKind, productId: string, categoryId: string) => ({
    productId: kind === 'PRODUCT' ? productId : null,
    categoryId: kind === 'CATEGORY' ? categoryId : null,
  });
  const isUuid = (value: string) => uuidV7Schema.safeParse(value).success;

  const actions: CampaignActionsInput = {};
  if (state.discountOn) {
    const value = state.discountValue.trim();
    if (!/^\d{1,18}$/u.test(value) || value === '0')
      return { problem: 'web.campaign_problem_value' };
    if (state.discountType === 'PERCENTAGE' && Number(value) > 100) {
      return { problem: 'web.campaign_problem_value' };
    }
    if (state.discountPurposes.length === 0) return { problem: 'web.campaign_problem_purposes' };
    if (state.discountScope === 'PRODUCT' && !isUuid(state.discountProductId)) {
      return { problem: 'web.campaign_problem_product' };
    }
    if (state.discountScope === 'CATEGORY' && !isUuid(state.discountCategoryId)) {
      return { problem: 'web.campaign_problem_category' };
    }
    const total = optionalWhole(state.discountTotalLimit, 1, 1_000_000_000);
    const per = optionalWhole(state.discountPerCustomer, 1, 1_000_000_000);
    if (total === undefined || per === undefined) return { problem: 'web.campaign_problem_limit' };
    const minimum = state.discountMinimum.trim();
    if (minimum !== '' && !/^\d{1,18}$/u.test(minimum))
      return { problem: 'web.campaign_problem_value' };
    if (
      state.discountKind === 'CODE' &&
      !/^[A-Za-z0-9_-]{3,40}$/u.test(state.discountCode.trim())
    ) {
      return { problem: 'web.campaign_problem_code' };
    }
    actions.discount = {
      kind: state.discountKind,
      code: state.discountKind === 'CODE' ? state.discountCode.trim() : null,
      type: state.discountType,
      value,
      currency: state.discountType === 'FIXED_AMOUNT' ? currency : null,
      appliesTo: DISCOUNTABLE_PURPOSES.filter((p) => state.discountPurposes.includes(p)),
      ...scopeOf(state.discountScope, state.discountProductId, state.discountCategoryId),
      firstPurchaseOnly: state.discountFirstPurchase,
      minimumSubtotalAmount: minimum === '' ? null : minimum,
      totalRedemptionsLimit: total,
      perCustomerLimit: per,
      priority: 0,
      stackable: state.discountStackable,
    };
  }
  if (state.cashbackOn) {
    const percent = wholeIn(state.cashbackPercent, CASHBACK_PERCENT_MIN, CASHBACK_PERCENT_MAX);
    if (percent === null) return { problem: 'web.campaign_problem_percent' };
    if (state.cashbackPurposes.length === 0) return { problem: 'web.campaign_problem_purposes' };
    if (state.cashbackScope === 'PRODUCT' && !isUuid(state.cashbackProductId)) {
      return { problem: 'web.campaign_problem_product' };
    }
    if (state.cashbackScope === 'CATEGORY' && !isUuid(state.cashbackCategoryId)) {
      return { problem: 'web.campaign_problem_category' };
    }
    actions.cashback = {
      percent,
      appliesTo: DISCOUNTABLE_PURPOSES.filter((p) => state.cashbackPurposes.includes(p)),
      ...scopeOf(state.cashbackScope, state.cashbackProductId, state.cashbackCategoryId),
    };
  }
  if (state.walletOn) {
    if (!/^[1-9][0-9]{0,17}$/u.test(state.walletAmount.trim())) {
      return { problem: 'web.campaign_problem_value' };
    }
    actions.walletGift = {
      amountMinor: state.walletAmount.trim(),
      currency,
      notify: state.walletNotify,
    };
  }
  if (state.trafficOn) {
    if (!/^(0|[1-9][0-9]{0,8})(\.[0-9]{1,2})?$/u.test(state.trafficGb.trim())) {
      return { problem: 'web.campaign_problem_traffic' };
    }
    actions.trafficGift = { trafficGb: state.trafficGb.trim(), notify: state.trafficNotify };
  }
  if (state.timeOn) {
    const days = wholeIn(state.timeDays, 1, 365);
    if (days === null) return { problem: 'web.campaign_problem_days' };
    actions.timeGift = { durationDays: days, notify: state.timeNotify };
  }
  if (state.announcementOn) {
    if (state.announcementBody.trim() === '') return { problem: 'web.campaign_problem_body' };
    actions.announcement = {
      body: state.announcementBody,
      buttons: state.buttons
        .filter((b) => b.label.trim() !== '' || b.url.trim() !== '')
        .map((b) => ({ label: b.label.trim(), url: b.url.trim() })),
    };
  }
  return {
    name: state.name.trim(),
    description: state.description.trim(),
    start: { date: state.startDate, time: state.startTime },
    end: { date: state.endDate, time: state.endTime },
    audience,
    actions,
  };
}

/** A stored campaign back into the form, for editing a draft. */
function formStateOf(campaign: CampaignDetail): FormState {
  const state: FormState = {
    ...EMPTY_FORM,
    name: campaign.name,
    description: campaign.description,
    startDate: campaign.startLocal.date,
    startTime: campaign.startLocal.time,
    endDate: campaign.endLocal.date,
    endTime: campaign.endLocal.time,
    audience: draftOf(campaign.audience),
  };
  for (const action of campaign.actions) {
    const terms = (action.terms ?? {}) as Record<string, unknown>;
    const scope = (): ScopeKind =>
      terms['productId'] !== null && terms['productId'] !== undefined
        ? 'PRODUCT'
        : terms['categoryId'] !== null && terms['categoryId'] !== undefined
          ? 'CATEGORY'
          : 'ALL';
    switch (action.kind) {
      case 'DISCOUNT':
        Object.assign(state, {
          discountOn: true,
          discountKind: terms['kind'],
          discountCode: (terms['code'] as string | null) ?? '',
          discountType: terms['type'],
          discountValue: String(terms['value'] ?? ''),
          discountPurposes: terms['appliesTo'] ?? [],
          discountScope: scope(),
          discountProductId: (terms['productId'] as string | null) ?? '',
          discountCategoryId: (terms['categoryId'] as string | null) ?? '',
          discountFirstPurchase: terms['firstPurchaseOnly'] === true,
          discountMinimum: (terms['minimumSubtotalAmount'] as string | null) ?? '',
          discountTotalLimit: String(terms['totalRedemptionsLimit'] ?? ''),
          discountPerCustomer: String(terms['perCustomerLimit'] ?? ''),
          discountStackable: terms['stackable'] === true,
        });
        break;
      case 'CASHBACK':
        Object.assign(state, {
          cashbackOn: true,
          cashbackPercent: String(terms['percent'] ?? ''),
          cashbackPurposes: terms['appliesTo'] ?? [],
          cashbackScope: scope(),
          cashbackProductId: (terms['productId'] as string | null) ?? '',
          cashbackCategoryId: (terms['categoryId'] as string | null) ?? '',
        });
        break;
      case 'WALLET_GIFT':
        Object.assign(state, {
          walletOn: true,
          walletAmount: String(terms['amountMinor'] ?? ''),
          walletNotify: terms['notify'] === true,
        });
        break;
      case 'TRAFFIC_GIFT':
        Object.assign(state, {
          trafficOn: true,
          trafficGb: String(terms['trafficGb'] ?? ''),
          trafficNotify: terms['notify'] === true,
        });
        break;
      case 'TIME_GIFT':
        Object.assign(state, {
          timeOn: true,
          timeDays: String(terms['durationDays'] ?? ''),
          timeNotify: terms['notify'] === true,
        });
        break;
      case 'ANNOUNCEMENT':
        Object.assign(state, {
          announcementOn: true,
          announcementBody: String(terms['body'] ?? ''),
          buttons: (terms['buttons'] as { label: string; url: string }[] | undefined) ?? [],
        });
        break;
    }
  }
  return state;
}

function Toggle({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <label>
      <input type="checkbox" checked={on} onChange={(event) => onChange(event.target.checked)} />{' '}
      {label}
    </label>
  );
}

function PurposeChecks({
  value,
  onChange,
}: {
  value: readonly DiscountablePurpose[];
  onChange: (next: readonly DiscountablePurpose[]) => void;
}) {
  return (
    <div className="checks">
      {DISCOUNTABLE_PURPOSES.map((purpose) => (
        <Toggle
          key={purpose}
          on={value.includes(purpose)}
          label={t(PURPOSE_LABELS[purpose])}
          onChange={(on) =>
            onChange(on ? [...value, purpose] : value.filter((item) => item !== purpose))
          }
        />
      ))}
    </div>
  );
}

function ScopePicker({
  kind,
  productId,
  categoryId,
  onChange,
  products,
  categories,
}: {
  kind: ScopeKind;
  productId: string;
  categoryId: string;
  onChange: (next: { kind: ScopeKind; productId: string; categoryId: string }) => void;
  products: readonly { id: string; title: string }[];
  categories: readonly { id: string; name: string }[];
}) {
  return (
    <div className="grid-2">
      <Field label={t('web.campaign_scope')}>
        <select
          value={kind}
          onChange={(event) =>
            onChange({ kind: event.target.value as ScopeKind, productId, categoryId })
          }
        >
          <option value="ALL">{t('web.campaign_scope_all')}</option>
          <option value="PRODUCT">{t('web.campaign_scope_product')}</option>
          <option value="CATEGORY">{t('web.campaign_scope_category')}</option>
        </select>
      </Field>
      {kind === 'PRODUCT' && (
        <Field label={t('web.campaign_scope_product')}>
          <select
            value={productId}
            onChange={(event) => onChange({ kind, productId: event.target.value, categoryId })}
          >
            <option value="">{t('web.campaign_choose')}</option>
            {products.map((row) => (
              <option key={row.id} value={row.id}>
                {row.title}
              </option>
            ))}
          </select>
        </Field>
      )}
      {kind === 'CATEGORY' && (
        <Field label={t('web.campaign_scope_category')}>
          <select
            value={categoryId}
            onChange={(event) => onChange({ kind, productId, categoryId: event.target.value })}
          >
            <option value="">{t('web.campaign_choose')}</option>
            {categories.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </select>
        </Field>
      )}
    </div>
  );
}

function CampaignForm({
  initial,
  campaignId,
  presentation,
  may,
}: {
  initial: FormState;
  campaignId: string | null;
  presentation: { timezone: string; calendar: 'jalali' | 'gregorian' };
  /** Each action's own server permission; an editor the actor may not use is not drawn. */
  may: CampaignActionPermissions;
}) {
  const client = useQueryClient();
  const notify = useToast();
  const submission = useSubmissionKey();
  const [state, setState] = useState<FormState>(initial);
  const [problem, setProblem] = useState<WebKey | null>(null);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setState((current) => ({ ...current, [key]: value }));

  const options = useQuery({ queryKey: ['audience-options'], queryFn: fetchAudienceOptions });
  const products = useQuery({
    queryKey: ['products', 'for-campaigns'],
    queryFn: () => fetchProducts({ limit: PRODUCT_PAGE_MAX }),
  });
  const categories = useQuery({
    queryKey: ['product-categories'],
    queryFn: () => fetchProductCategories(),
  });
  const currency: CurrencyCode = options.data?.currency ?? 'IRT';
  const productRows = (products.data?.products ?? []).map((p) => ({ id: p.id, title: p.title }));
  const categoryRows = (categories.data?.categories ?? []).map((c) => ({ id: c.id, name: c.name }));

  const save = useMutation({
    mutationFn: async () => {
      const body = campaignBodyOf(state, currency);
      if ('problem' in body) throw new ProblemError(body.problem);
      const idempotencyKey = submission.current(body);
      return campaignId === null
        ? createCampaign({ ...body, idempotencyKey })
        : updateCampaign(campaignId, { ...body, idempotencyKey });
    },
    onSuccess: (response) => {
      submission.settle();
      setProblem(null);
      void client.invalidateQueries({ queryKey: [CAMPAIGNS_KEY] });
      notify({ tone: 'ok', message: t('web.campaign_saved') });
      navigate(`/campaigns/${response.campaign.id}`);
    },
    onError: (error) => {
      if (error instanceof ProblemError) {
        setProblem(error.key);
        return;
      }
      submission.settleOn(error);
      notify({ tone: 'danger', message: campaignErrorMessage(error) });
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };

  const calendarHint = `${t('web.campaign_window_hint')} ${t(
    presentation.calendar === 'jalali'
      ? 'web.campaign_calendar_jalali'
      : 'web.campaign_calendar_gregorian',
  )} · ${presentation.timezone}`;

  return (
    <form onSubmit={onSubmit}>
      <Card title={t('web.campaign_section_identity')}>
        <div className="grid-2">
          <Field label={t('web.campaign_name')}>
            <input
              value={state.name}
              maxLength={CAMPAIGN_NAME_MAX_LENGTH}
              onChange={(event) => set('name', event.target.value)}
            />
          </Field>
          <Field label={t('web.campaign_description')} hint={t('web.campaign_description_hint')}>
            <textarea
              value={state.description}
              maxLength={CAMPAIGN_DESCRIPTION_MAX_LENGTH}
              onChange={(event) => set('description', event.target.value)}
            />
          </Field>
        </div>
      </Card>

      <Card title={t('web.campaign_window')} hint={calendarHint}>
        <div className="grid-2">
          <Field label={t('web.campaign_start')} hint={t('web.campaign_date_format')}>
            <div className="toolbar">
              <input
                dir="ltr"
                placeholder="1405-07-10"
                value={state.startDate}
                onChange={(event) => set('startDate', event.target.value.trim())}
              />
              <input
                dir="ltr"
                type="time"
                value={state.startTime}
                onChange={(event) => set('startTime', event.target.value)}
              />
            </div>
          </Field>
          <Field label={t('web.campaign_end')} hint={t('web.campaign_date_format')}>
            <div className="toolbar">
              <input
                dir="ltr"
                placeholder="1405-07-20"
                value={state.endDate}
                onChange={(event) => set('endDate', event.target.value.trim())}
              />
              <input
                dir="ltr"
                type="time"
                value={state.endTime}
                onChange={(event) => set('endTime', event.target.value)}
              />
            </div>
          </Field>
        </div>
      </Card>

      <Card title={t('web.campaign_section_audience')} hint={t('web.campaign_audience_hint')}>
        <AudienceBuilder value={state.audience} onChange={(next) => set('audience', next)} />
      </Card>

      <Card title={t('web.campaign_action_discount')} hint={t('web.campaign_discount_hint')}>
        {may.discount ? (
          <Toggle
            on={state.discountOn}
            onChange={(on) => set('discountOn', on)}
            label={t('web.campaign_action_on')}
          />
        ) : (
          <NotPermitted label={t('web.campaign_action_on')} />
        )}
        {may.discount && state.discountOn && (
          <>
            <div className="grid-2">
              <Field label={t('web.campaign_discount_kind')}>
                <select
                  value={state.discountKind}
                  onChange={(event) =>
                    set('discountKind', event.target.value as FormState['discountKind'])
                  }
                >
                  <option value="AUTOMATIC">{t('web.campaign_discount_automatic')}</option>
                  <option value="CODE">{t('web.campaign_discount_code')}</option>
                </select>
              </Field>
              {state.discountKind === 'CODE' && (
                <Field label={t('web.campaign_discount_code')} hint={t('web.campaign_code_hint')}>
                  <input
                    dir="ltr"
                    value={state.discountCode}
                    onChange={(event) => set('discountCode', event.target.value)}
                  />
                </Field>
              )}
              <Field label={t('web.campaign_discount_type')}>
                <select
                  value={state.discountType}
                  onChange={(event) =>
                    set('discountType', event.target.value as FormState['discountType'])
                  }
                >
                  <option value="PERCENTAGE">{t('web.campaign_discount_percentage')}</option>
                  <option value="FIXED_AMOUNT">{t('web.campaign_discount_fixed')}</option>
                </select>
              </Field>
              <Field
                label={t('web.campaign_discount_value')}
                hint={
                  state.discountType === 'PERCENTAGE'
                    ? t('web.campaign_percent_hint')
                    : `${t('web.campaign_amount_hint')} ${currency}`
                }
              >
                <input
                  dir="ltr"
                  inputMode="numeric"
                  value={state.discountValue}
                  onChange={(event) => set('discountValue', event.target.value.trim())}
                />
              </Field>
            </div>
            <Field label={t('web.campaign_purposes')}>
              <PurposeChecks
                value={state.discountPurposes}
                onChange={(next) => set('discountPurposes', next)}
              />
            </Field>
            <ScopePicker
              kind={state.discountScope}
              productId={state.discountProductId}
              categoryId={state.discountCategoryId}
              products={productRows}
              categories={categoryRows}
              onChange={(next) =>
                setState((current) => ({
                  ...current,
                  discountScope: next.kind,
                  discountProductId: next.productId,
                  discountCategoryId: next.categoryId,
                }))
              }
            />
            <div className="grid-2">
              <Field
                label={t('web.campaign_discount_minimum')}
                hint={`${t('web.campaign_amount_hint')} ${currency}`}
              >
                <input
                  dir="ltr"
                  inputMode="numeric"
                  value={state.discountMinimum}
                  onChange={(event) => set('discountMinimum', event.target.value.trim())}
                />
              </Field>
              <Field
                label={t('web.campaign_discount_total_limit')}
                hint={t('web.campaign_limit_hint')}
              >
                <input
                  dir="ltr"
                  inputMode="numeric"
                  value={state.discountTotalLimit}
                  onChange={(event) => set('discountTotalLimit', event.target.value.trim())}
                />
              </Field>
              <Field
                label={t('web.campaign_discount_per_customer')}
                hint={t('web.campaign_limit_hint')}
              >
                <input
                  dir="ltr"
                  inputMode="numeric"
                  value={state.discountPerCustomer}
                  onChange={(event) => set('discountPerCustomer', event.target.value.trim())}
                />
              </Field>
            </div>
            <Toggle
              on={state.discountFirstPurchase}
              onChange={(on) => set('discountFirstPurchase', on)}
              label={t('web.campaign_discount_first_purchase')}
            />
            <Toggle
              on={state.discountStackable}
              onChange={(on) => set('discountStackable', on)}
              label={t('web.campaign_discount_stackable')}
            />
          </>
        )}
      </Card>

      <Card title={t('web.campaign_action_cashback')} hint={t('web.campaign_cashback_hint')}>
        {may.cashback ? (
          <Toggle
            on={state.cashbackOn}
            onChange={(on) => set('cashbackOn', on)}
            label={t('web.campaign_action_on')}
          />
        ) : (
          <NotPermitted label={t('web.campaign_action_on')} />
        )}
        {may.cashback && state.cashbackOn && (
          <>
            <Field label={t('web.campaign_cashback_percent')} hint={t('web.campaign_percent_hint')}>
              <input
                dir="ltr"
                inputMode="numeric"
                value={state.cashbackPercent}
                onChange={(event) => set('cashbackPercent', event.target.value.trim())}
              />
            </Field>
            <Field label={t('web.campaign_purposes')}>
              <PurposeChecks
                value={state.cashbackPurposes}
                onChange={(next) => set('cashbackPurposes', next)}
              />
            </Field>
            <ScopePicker
              kind={state.cashbackScope}
              productId={state.cashbackProductId}
              categoryId={state.cashbackCategoryId}
              products={productRows}
              categories={categoryRows}
              onChange={(next) =>
                setState((current) => ({
                  ...current,
                  cashbackScope: next.kind,
                  cashbackProductId: next.productId,
                  cashbackCategoryId: next.categoryId,
                }))
              }
            />
          </>
        )}
      </Card>

      <Card title={t('web.campaign_section_gifts')} hint={t('web.campaign_gifts_hint')}>
        {may.walletGift ? (
          <Toggle
            on={state.walletOn}
            onChange={(on) => set('walletOn', on)}
            label={t('web.campaign_action_wallet_gift')}
          />
        ) : (
          <NotPermitted label={t('web.campaign_action_wallet_gift')} />
        )}
        {may.walletGift && state.walletOn && (
          <div className="grid-2">
            <Field
              label={t('web.campaign_wallet_amount')}
              hint={`${t('web.campaign_amount_hint')} ${currency}`}
            >
              <input
                dir="ltr"
                inputMode="numeric"
                value={state.walletAmount}
                onChange={(event) => set('walletAmount', event.target.value.trim())}
              />
            </Field>
            <Toggle
              on={state.walletNotify}
              onChange={(on) => set('walletNotify', on)}
              label={t('web.campaign_notify')}
            />
          </div>
        )}
        {may.serviceGift ? (
          <Toggle
            on={state.trafficOn}
            onChange={(on) => set('trafficOn', on)}
            label={t('web.campaign_action_traffic_gift')}
          />
        ) : (
          <NotPermitted label={t('web.campaign_action_traffic_gift')} />
        )}
        {may.serviceGift && state.trafficOn && (
          <div className="grid-2">
            <Field label={t('web.campaign_traffic_gb')} hint={t('web.campaign_traffic_hint')}>
              <input
                dir="ltr"
                inputMode="decimal"
                value={state.trafficGb}
                onChange={(event) => set('trafficGb', event.target.value.trim())}
              />
            </Field>
            <Toggle
              on={state.trafficNotify}
              onChange={(on) => set('trafficNotify', on)}
              label={t('web.campaign_notify')}
            />
          </div>
        )}
        {may.serviceGift ? (
          <Toggle
            on={state.timeOn}
            onChange={(on) => set('timeOn', on)}
            label={t('web.campaign_action_time_gift')}
          />
        ) : (
          <NotPermitted label={t('web.campaign_action_time_gift')} />
        )}
        {may.serviceGift && state.timeOn && (
          <div className="grid-2">
            <Field label={t('web.campaign_time_days')}>
              <input
                dir="ltr"
                inputMode="numeric"
                value={state.timeDays}
                onChange={(event) => set('timeDays', event.target.value.trim())}
              />
            </Field>
            <Toggle
              on={state.timeNotify}
              onChange={(on) => set('timeNotify', on)}
              label={t('web.campaign_notify')}
            />
          </div>
        )}
        {(state.trafficOn || state.timeOn) && (
          <p className="muted small">{t('web.campaign_service_gift_hint')}</p>
        )}
      </Card>

      <Card
        title={t('web.campaign_action_announcement')}
        hint={t('web.campaign_announcement_hint')}
      >
        {may.announcement ? (
          <Toggle
            on={state.announcementOn}
            onChange={(on) => set('announcementOn', on)}
            label={t('web.campaign_action_on')}
          />
        ) : (
          <NotPermitted label={t('web.campaign_action_on')} />
        )}
        {may.announcement && state.announcementOn && (
          <>
            <Field
              label={t('web.campaign_announcement_body')}
              hint={t('web.campaign_placeholders')}
            >
              <textarea
                rows={6}
                value={state.announcementBody}
                onChange={(event) => set('announcementBody', event.target.value)}
              />
            </Field>
            {state.buttons.map((button, index) => (
              <div className="grid-2" key={index}>
                <Field label={t('web.campaign_button_label')}>
                  <input
                    value={button.label}
                    onChange={(event) =>
                      set(
                        'buttons',
                        state.buttons.map((b, i) =>
                          i === index ? { ...b, label: event.target.value } : b,
                        ),
                      )
                    }
                  />
                </Field>
                <Field label={t('web.campaign_button_url')}>
                  <input
                    dir="ltr"
                    value={button.url}
                    onChange={(event) =>
                      set(
                        'buttons',
                        state.buttons.map((b, i) =>
                          i === index ? { ...b, url: event.target.value } : b,
                        ),
                      )
                    }
                  />
                </Field>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() =>
                    set(
                      'buttons',
                      state.buttons.filter((_, i) => i !== index),
                    )
                  }
                >
                  {t('web.campaign_button_remove')}
                </button>
              </div>
            ))}
            {state.buttons.length < BROADCAST_BUTTONS_MAX && (
              <button
                type="button"
                className="btn sm"
                onClick={() => set('buttons', [...state.buttons, { label: '', url: 'https://' }])}
              >
                {t('web.campaign_button_add')}
              </button>
            )}
          </>
        )}
      </Card>

      <Card>
        <Banner tone="info">{t('web.campaign_referral_note')}</Banner>
        {problem !== null && <Banner tone="danger">{t(problem)}</Banner>}
        <div className="btn-group">
          <button type="submit" className="btn primary" disabled={save.isPending}>
            {t('web.campaign_save_draft')}
          </button>
          <span className="muted small">{t('web.campaign_save_hint')}</span>
        </div>
      </Card>
    </form>
  );
}

/**
 * The permission each action's editor needs — the same key the server charges when a draft
 * holding that action is saved or confirmed (`CAMPAIGN_ACTION_PERMISSIONS`). Passed from the
 * route, never derived, as the discounts page does for its two editors.
 */
export interface CampaignActionPermissions {
  /** `catalog.discounts.edit` */
  readonly discount: boolean;
  /** `catalog.pricing.edit` */
  readonly cashback: boolean;
  /** `users.wallet.mass` */
  readonly walletGift: boolean;
  /** `services.mass.grant` */
  readonly serviceGift: boolean;
  /** `broadcasts.send` */
  readonly announcement: boolean;
}

/** Instead of an editor the actor may not use: says so, and draws nothing to press. */
function NotPermitted({ label }: { label: string }) {
  return (
    <p className="muted small">
      {label}: {t('web.campaign_action_not_permitted')}
    </p>
  );
}

class ProblemError extends Error {
  constructor(readonly key: WebKey) {
    super(key);
  }
}

export function CampaignNewPage({
  denied,
  mayManage,
  may,
}: {
  denied: boolean;
  mayManage: boolean;
  may: CampaignActionPermissions;
}) {
  // The tenant's calendar and zone come with the list; the window is not drawn without them.
  const presentation = useQuery({
    queryKey: [CAMPAIGNS_KEY, 'presentation'],
    queryFn: async () => (await fetchCampaigns({ limit: 1 })).presentation,
    enabled: !denied && mayManage,
  });
  if (denied || !mayManage) {
    return <Empty title={t('web.no_permission')} hint={t('web.no_permission_hint')} icon="lock" />;
  }
  return (
    <>
      <PageHead title={t('web.campaign_new')} subtitle={t('web.campaigns_intro')} />
      <StateSwitch query={presentation}>
        {presentation.data !== undefined && (
          <CampaignForm
            initial={EMPTY_FORM}
            campaignId={null}
            presentation={presentation.data}
            may={may}
          />
        )}
      </StateSwitch>
    </>
  );
}

// ---------------------------------------------------------------------------
// One campaign
// ---------------------------------------------------------------------------

export function CampaignDetailPage({
  id,
  denied,
  mayManage,
  may,
}: {
  id: string;
  denied: boolean;
  mayManage: boolean;
  may: CampaignActionPermissions;
}) {
  const detail = useQuery({
    queryKey: [CAMPAIGNS_KEY, 'one', id],
    queryFn: () => fetchCampaign(id),
    enabled: !denied,
  });
  const [editing, setEditing] = useState(false);
  const campaign = detail.data?.campaign;

  return (
    <StateSwitch query={detail} denied={denied}>
      {campaign !== undefined && (
        <>
          <PageHead
            title={campaign.name}
            {...(campaign.description === '' ? {} : { subtitle: campaign.description })}
            actions={
              mayManage && campaign.state === 'DRAFT' && !editing ? (
                <button type="button" className="btn" onClick={() => setEditing(true)}>
                  {t('web.campaign_edit')}
                </button>
              ) : undefined
            }
          />
          {editing && detail.data !== undefined ? (
            <CampaignForm
              initial={formStateOf(campaign)}
              campaignId={campaign.id}
              presentation={detail.data.presentation}
              may={may}
            />
          ) : (
            <>
              <SummaryCard campaign={campaign} />
              <ActionsCard campaign={campaign} />
              {campaign.state === 'DRAFT' && mayManage && <ConfirmCard campaign={campaign} />}
              {mayManage && <CommandsCard campaign={campaign} />}
              {campaign.state !== 'DRAFT' && <ResultsCard id={campaign.id} />}
            </>
          )}
        </>
      )}
    </StateSwitch>
  );
}

function SummaryCard({ campaign }: { campaign: CampaignDetail }) {
  const at = (iso: string | null) => (iso === null ? '—' : <Ltr>{iso.slice(0, 16)}</Ltr>);
  return (
    <Card title={t('web.campaign_section_summary')}>
      <KV
        items={[
          [t('web.status'), <StateBadge key="s" value={campaign.state} />],
          [
            t('web.campaign_window'),
            <span key="w">
              <Moment value={campaign.startLocal} /> ← <Moment value={campaign.endLocal} />
            </span>,
          ],
          [t('web.campaign_actions'), kindsText(campaign.actionKinds)],
          [
            t('web.campaign_audience'),
            <ul key="aud" className="plain">
              {describeAudience(campaign.audience).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>,
          ],
          [
            t('web.campaign_audience_confirmed'),
            campaign.audienceConfirmedCount === null ? (
              t('web.campaign_not_confirmed')
            ) : (
              <Num key="c" value={campaign.audienceConfirmedCount} />
            ),
          ],
          [t('web.campaign_scheduled_at'), at(campaign.scheduledAt)],
          [t('web.campaign_cancelled_at'), at(campaign.cancelledAt)],
        ]}
      />
    </Card>
  );
}

function ActionsCard({ campaign }: { campaign: CampaignDetail }) {
  const onLink = useLinkHandler();
  if (campaign.actions.length === 0) {
    return (
      <Card title={t('web.campaign_actions')}>
        <Empty title={t('web.campaign_no_actions')} />
      </Card>
    );
  }
  return (
    <Card title={t('web.campaign_actions')} hint={t('web.campaign_actions_hint')}>
      <DataTable
        caption={t('web.campaign_actions')}
        rows={campaign.actions}
        rowKey={(row) => row.kind}
        columns={[
          {
            key: 'kind',
            header: t('web.campaign_action'),
            render: (row) => t(CAMPAIGN_ACTION_LABELS[row.kind]),
          },
          {
            key: 'state',
            header: t('web.status'),
            render: (row) => (
              <Badge
                tone={
                  row.state === 'FAILED' ? 'danger' : row.state === 'LAUNCHED' ? 'ok' : 'neutral'
                }
              >
                {t(ACTION_STATE_LABELS[row.state])}
              </Badge>
            ),
          },
          {
            key: 'rule',
            header: t('web.campaign_rule_status'),
            // The linked rule as it is NOW; it may have been withdrawn on the discounts page.
            render: (row) =>
              row.ruleStatus === null ? (
                '—'
              ) : (
                <Badge tone={row.ruleStatus === 'ACTIVE' ? 'ok' : 'neutral'}>
                  {t(
                    row.ruleStatus === 'ACTIVE'
                      ? 'web.campaign_rule_active'
                      : 'web.campaign_rule_inactive',
                  )}
                </Badge>
              ),
          },
          {
            key: 'terms',
            header: t('web.campaign_terms'),
            render: (row) => <TermsText kind={row.kind} terms={row.terms} />,
          },
          {
            key: 'link',
            header: t('web.campaign_engine_record'),
            render: (row) =>
              row.discountId !== null || row.cashbackRuleId !== null ? (
                <a href="/discounts" onClick={onLink}>
                  {t('web.campaign_open_rules')}
                </a>
              ) : row.broadcastId !== null ? (
                <span className="small">{t('web.campaign_engine_broadcast')}</span>
              ) : row.bulkOperationId !== null ? (
                <span className="small">{t('web.campaign_engine_bulk')}</span>
              ) : row.failureCode === 'audience.changed' ? (
                // The confirmed set moved before the hand-over: nothing was given to it.
                <span className="small">{t('web.campaign_failure_audience_changed')}</span>
              ) : row.failureCode !== null ? (
                <Ltr>{row.failureCode}</Ltr>
              ) : (
                '—'
              ),
          },
        ]}
      />
    </Card>
  );
}

/** An action's terms in words. Money in the currency the terms carry; never a bare number. */
function TermsText({ kind, terms }: { kind: CampaignActionKind; terms: unknown }) {
  const d = (terms ?? {}) as Record<string, unknown>;
  const purposes = (d['appliesTo'] as DiscountablePurpose[] | undefined) ?? [];
  const purposeText = [
    purposes.map((p) => t(PURPOSE_LABELS[p])).join(t('web.list_separator')),
    t(
      d['productId'] !== null && d['productId'] !== undefined
        ? 'web.campaign_scope_product'
        : d['categoryId'] !== null && d['categoryId'] !== undefined
          ? 'web.campaign_scope_category'
          : 'web.campaign_scope_all',
    ),
  ].join(' · ');
  switch (kind) {
    case 'DISCOUNT':
      return (
        <span className="small">
          {d['type'] === 'PERCENTAGE' ? (
            <>
              <Ltr>{String(d['value'])}%</Ltr>
            </>
          ) : (
            <Money
              value={{ amountMinor: String(d['value']), currency: d['currency'] as CurrencyCode }}
            />
          )}{' '}
          ·{' '}
          {d['kind'] === 'CODE' ? (
            <Ltr>{String(d['code'])}</Ltr>
          ) : (
            t('web.campaign_discount_automatic')
          )}{' '}
          · {purposeText}
        </span>
      );
    case 'CASHBACK':
      return (
        <span className="small">
          <Ltr>{String(d['percent'])}%</Ltr> · {purposeText}
        </span>
      );
    case 'WALLET_GIFT':
      return (
        <Money
          value={{ amountMinor: String(d['amountMinor']), currency: d['currency'] as CurrencyCode }}
        />
      );
    case 'TRAFFIC_GIFT':
      return (
        <span className="small">
          <Ltr>{String(d['trafficGb'])}</Ltr> {t('web.unit_gib')}
        </span>
      );
    case 'TIME_GIFT':
      return (
        <span className="small">
          <Num value={Number(d['durationDays'])} /> {t('web.campaign_days')}
        </span>
      );
    case 'ANNOUNCEMENT':
      return <span className="small">{String(d['body']).slice(0, 80)}</span>;
  }
}

/**
 * The preview and the confirmation. Nothing is priced, sent or credited before this, and the
 * confirmation carries back exactly the figures shown: the audience's set, each gift's count
 * and set, and the wallet gift's total. Where an engine asks for the count typed back, it is
 * typed here, once per engine.
 */
function ConfirmCard({ campaign }: { campaign: CampaignDetail }) {
  const client = useQueryClient();
  const notify = useToast();
  const submission = useSubmissionKey();
  const preview = useQuery({
    queryKey: [CAMPAIGNS_KEY, 'preview', campaign.id, campaign.updatedAt],
    queryFn: () => fetchCampaignPreview(campaign.id),
  });
  /*
   * The operator's "I reviewed this" and the counts they typed are about ONE preview. They
   * are keyed to its binding — the definition hash and every set's fingerprint and count —
   * and start over whenever a refetched preview differs, so a tick given to yesterday's
   * figures can never confirm today's. Derived rather than reset in an effect, so there is
   * no render in which the old tick meets the new figures.
   */
  const binding = bindingKeyOf(preview.data);
  const EMPTY_TYPED = { audience: '', walletGift: '', trafficGift: '', timeGift: '' };
  const [answers, setAnswers] = useState({ binding, reviewed: false, typed: EMPTY_TYPED });
  const current =
    answers.binding === binding ? answers : { binding, reviewed: false, typed: EMPTY_TYPED };
  const reviewed = current.reviewed;
  const typed = current.typed;
  const setReviewed = (next: boolean) => setAnswers({ ...current, reviewed: next });
  const setTyped = (next: typeof EMPTY_TYPED) => setAnswers({ ...current, typed: next });

  const confirm = useMutation({
    mutationFn: (p: CampaignPreviewResponse) => {
      const typedOf = (raw: string) => (raw.trim() === '' ? null : Number(raw.trim()));
      const binding = (gift: CampaignPreviewResponse['walletGift'], typedRaw: string) =>
        gift === null
          ? null
          : { count: gift.count, fingerprint: gift.fingerprint, typedCount: typedOf(typedRaw) };
      const body = {
        expectedDefinitionHash: p.audience.definitionHash,
        expectedRecipients: p.audience.customers,
        expectedFingerprint: p.audience.fingerprint,
        walletGift:
          p.walletGift === null
            ? null
            : {
                count: p.walletGift.count,
                fingerprint: p.walletGift.fingerprint,
                typedCount: typedOf(typed.walletGift),
                totalMinor: p.walletGift.totalLiability?.amountMinor ?? '0',
              },
        trafficGift: binding(p.trafficGift, typed.trafficGift),
        timeGift: binding(p.timeGift, typed.timeGift),
        typedCount: typedOf(typed.audience),
        confirmed: true as const,
      };
      return scheduleCampaign(campaign.id, { ...body, idempotencyKey: submission.current(body) });
    },
    onSuccess: () => {
      submission.settle();
      void client.invalidateQueries({ queryKey: [CAMPAIGNS_KEY] });
      notify({ tone: 'ok', message: t('web.campaign_scheduled') });
    },
    onError: (error) => {
      submission.settleOn(error);
      void preview.refetch();
      notify({ tone: 'danger', message: campaignErrorMessage(error) });
    },
  });

  const p = preview.data;
  // The message exactly as stored; Broadcast renders its placeholders per recipient.
  const announcementTerms = campaign.actions.find((a) => a.kind === 'ANNOUNCEMENT')?.terms as
    { body?: string } | undefined;
  const announcement = announcementTerms?.body;
  const typedInput = (key: keyof typeof typed, count: number) => (
    <Field
      htmlFor={`campaign-typed-${key}`}
      label={t('web.campaign_type_count')}
      hint={`${t('web.campaign_type_count_hint')} ${String(count)}`}
    >
      <input
        id={`campaign-typed-${key}`}
        dir="ltr"
        inputMode="numeric"
        value={typed[key]}
        onChange={(event) => setTyped({ ...typed, [key]: event.target.value.trim() })}
      />
    </Field>
  );

  return (
    <Card title={t('web.campaign_section_preview')} hint={t('web.campaign_preview_hint')}>
      <StateSwitch query={preview}>
        {p !== undefined && (
          <>
            <KV
              items={[
                [t('web.campaign_preview_audience'), <Num key="a" value={p.audience.customers} />],
                [t('web.campaign_preview_reachable'), <Num key="r" value={p.audience.reachable} />],
                [
                  t('web.campaign_preview_discount_max'),
                  p.discountMaxLiability === null ? (
                    t('web.campaign_not_determinable')
                  ) : (
                    <Money key="d" value={p.discountMaxLiability} />
                  ),
                ],
                ...(p.walletGift === null
                  ? []
                  : ([
                      [
                        t('web.campaign_preview_wallet_count'),
                        <Num key="wc" value={p.walletGift.count} />,
                      ],
                      [
                        t('web.campaign_preview_wallet_total'),
                        p.walletGift.totalLiability === null ? (
                          '—'
                        ) : (
                          <Money key="wt" value={p.walletGift.totalLiability} />
                        ),
                      ],
                    ] as [ReactNode, ReactNode][])),
                ...(p.trafficGift === null
                  ? []
                  : ([
                      [
                        t('web.campaign_preview_traffic_count'),
                        <Num key="tc" value={p.trafficGift.count} />,
                      ],
                    ] as [ReactNode, ReactNode][])),
                ...(p.timeGift === null
                  ? []
                  : ([
                      [
                        t('web.campaign_preview_time_count'),
                        <Num key="dc" value={p.timeGift.count} />,
                      ],
                    ] as [ReactNode, ReactNode][])),
              ]}
            />
            {announcement !== undefined && (
              <Field label={t('web.campaign_announcement_body')}>
                <p className="bot-preview">{announcement}</p>
              </Field>
            )}
            {p.audience.sample.length > 0 && (
              <p className="muted small">
                {t('web.campaign_preview_sample')}{' '}
                {p.audience.sample
                  .map((c) => c.firstName ?? c.username ?? c.telegramUserId)
                  .join(t('web.list_separator'))}
              </p>
            )}
            {p.typedCountRequired.audience && typedInput('audience', p.audience.customers)}
            {p.typedCountRequired.walletGift &&
              p.walletGift !== null &&
              typedInput('walletGift', p.walletGift.count)}
            {p.typedCountRequired.trafficGift &&
              p.trafficGift !== null &&
              typedInput('trafficGift', p.trafficGift.count)}
            {p.typedCountRequired.timeGift &&
              p.timeGift !== null &&
              typedInput('timeGift', p.timeGift.count)}
            <Toggle on={reviewed} onChange={setReviewed} label={t('web.campaign_reviewed')} />
            <div className="btn-group">
              <button
                type="button"
                className="btn primary"
                disabled={!reviewed || confirm.isPending}
                onClick={() => confirm.mutate(p)}
              >
                {t('web.campaign_confirm')}
              </button>
            </div>
          </>
        )}
      </StateSwitch>
    </Card>
  );
}

/** Everything a confirmation binds to, as one string: a change in any of it is a new preview. */
function bindingKeyOf(preview: CampaignPreviewResponse | undefined): string {
  if (preview === undefined) return '';
  const gift = (g: CampaignPreviewResponse['walletGift']) =>
    g === null ? '-' : `${String(g.count)}/${g.fingerprint}/${g.totalLiability?.amountMinor ?? ''}`;
  return [
    preview.audience.definitionHash,
    preview.audience.fingerprint,
    String(preview.audience.customers),
    gift(preview.walletGift),
    gift(preview.trafficGift),
    gift(preview.timeGift),
  ].join('|');
}

function CommandsCard({ campaign }: { campaign: CampaignDetail }) {
  const client = useQueryClient();
  const notify = useToast();
  const submission = useSubmissionKey();
  const [confirming, setConfirming] = useState(false);
  const run = useMutation({
    mutationFn: (which: 'pause' | 'resume' | 'cancel' | 'launch') =>
      commandCampaign({
        id: campaign.id,
        which,
        idempotencyKey: submission.current({ id: campaign.id, which }),
      }),
    onSuccess: () => {
      submission.settle();
      setConfirming(false);
      void client.invalidateQueries({ queryKey: [CAMPAIGNS_KEY] });
      notify({ tone: 'ok', message: t('web.campaign_command_done') });
    },
    onError: (error) => {
      submission.settleOn(error);
      notify({ tone: 'danger', message: campaignErrorMessage(error) });
    },
  });
  const pendingLaunch = campaign.actions.some((a) => a.state === 'PENDING' || a.state === 'FAILED');
  const live = ['SCHEDULED', 'ACTIVE', 'PAUSED'].includes(campaign.state);
  const cancellable = campaign.state !== 'COMPLETED' && campaign.state !== 'CANCELLED';
  return (
    <Card title={t('web.campaign_section_commands')} hint={t('web.campaign_cancel_hint')}>
      <div className="btn-group">
        {campaign.state === 'ACTIVE' && (
          <button type="button" className="btn" onClick={() => run.mutate('pause')}>
            {t('web.campaign_pause')}
          </button>
        )}
        {campaign.state === 'PAUSED' && (
          <button type="button" className="btn" onClick={() => run.mutate('resume')}>
            {t('web.campaign_resume')}
          </button>
        )}
        {live && pendingLaunch && (
          <button type="button" className="btn" onClick={() => run.mutate('launch')}>
            {t('web.campaign_launch_pending')}
          </button>
        )}
        {cancellable && !confirming && (
          <button type="button" className="btn danger" onClick={() => setConfirming(true)}>
            {t('web.campaign_cancel')}
          </button>
        )}
      </div>
      {confirming && (
        <Banner tone="warn" title={t('web.campaign_cancel_confirm_title')}>
          <p>{t('web.campaign_cancel_confirm_body')}</p>
          <div className="btn-group">
            <button type="button" className="btn danger" onClick={() => run.mutate('cancel')}>
              {t('web.campaign_cancel_confirm')}
            </button>
            <button type="button" className="btn" onClick={() => setConfirming(false)}>
              {t('web.campaign_cancel_keep')}
            </button>
          </div>
        </Banner>
      )}
    </Card>
  );
}

function TallyList({ rows }: { rows: readonly CampaignTally[] }) {
  if (rows.length === 0) return <span className="muted">{t('web.campaign_none_yet')}</span>;
  return (
    <ul className="plain">
      {rows.map((row) => {
        const label = TALLY_STATE_LABELS[row.state];
        return (
          <li key={`${row.state}:${row.amount?.currency ?? ''}`}>
            {label === undefined ? <Ltr>{row.state}</Ltr> : t(label)}: <Num value={row.count} />
            {row.amount !== null && (
              <>
                {' '}
                · <Money value={row.amount} />
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function BroadcastTally({ counts }: { counts: BroadcastCounts }) {
  return (
    <span className="small">
      {t('web.campaign_sent')} <Num value={counts.sent} /> · {t('web.campaign_failed')}{' '}
      <Num value={counts.failed + counts.unreachable} /> · {t('web.campaign_unconfirmed')}{' '}
      <Num value={counts.unconfirmed} /> · {t('web.campaign_pending')}{' '}
      <Num value={counts.pending + counts.sending} /> · {t('web.campaign_cancelled_count')}{' '}
      <Num value={counts.cancelled} />
    </span>
  );
}

function BulkTally({ counts }: { counts: BulkCounts }) {
  return (
    <span className="small">
      {t('web.campaign_done')} <Num value={counts.credited + counts.succeeded} /> ·{' '}
      {t('web.campaign_failed')} <Num value={counts.failed} /> · {t('web.campaign_skipped')}{' '}
      <Num value={counts.skipped} /> · {t('web.campaign_unconfirmed')}{' '}
      <Num value={counts.awaitingReconciliation} /> · {t('web.campaign_pending')}{' '}
      <Num value={counts.pending + counts.planned - counts.awaitingReconciliation} /> ·{' '}
      {t('web.campaign_cancelled_count')} <Num value={counts.cancelled} /> ·{' '}
      {/* Told means DELIVERED by the lane; an enqueued notice is only queued (E's #117 R4). */}
      {t('web.bulk_notified')} <Num value={counts.notified} /> · {t('web.bulk_notice_queued')}{' '}
      <Num value={counts.notificationQueued} />
    </span>
  );
}

/**
 * The results: persisted facts only, each labelled as exactly what it is. The page never
 * sums them into a "revenue from this campaign".
 */
function ResultsCard({ id }: { id: string }) {
  const results = useQuery({
    queryKey: [CAMPAIGNS_KEY, 'results', id],
    queryFn: () => fetchCampaignResults(id),
  });
  const r: CampaignResultsResponse | undefined = results.data;
  return (
    <Card title={t('web.campaign_section_results')} hint={t('web.campaign_results_hint')}>
      <StateSwitch query={results}>
        {r !== undefined && (
          <KV
            items={[
              [
                t('web.campaign_results_targeted'),
                r.targeted === null ? '—' : <Num key="t" value={r.targeted} />,
              ],
              ...(r.discountRedemptions === null
                ? []
                : ([
                    [
                      t('web.campaign_results_redemptions'),
                      <TallyList key="d" rows={r.discountRedemptions} />,
                    ],
                  ] as [ReactNode, ReactNode][])),
              ...(r.cashback === null
                ? []
                : ([
                    [
                      t('web.campaign_results_cashback'),
                      <TallyList key="c" rows={r.cashback.byState} />,
                    ],
                    [
                      t('web.campaign_results_cashback_totals'),
                      r.cashback.totals.length === 0 ? (
                        t('web.campaign_none_yet')
                      ) : (
                        // One line per currency: amounts in two currencies are never added.
                        <ul key="ct" className="plain">
                          {r.cashback.totals.map((total) => (
                            <li key={total.currency}>
                              {t('web.campaign_cashback_earned')}: <Money value={total.earned} /> ·{' '}
                              {t('web.campaign_results_cashback_reversed')}:{' '}
                              <Money value={total.reversedRecovered} /> ·{' '}
                              {t('web.campaign_results_cashback_unrecovered')}:{' '}
                              <Money value={total.reversedUnrecovered} />
                            </li>
                          ))}
                        </ul>
                      ),
                    ],
                  ] as [ReactNode, ReactNode][])),
              ...(r.announcement === null
                ? []
                : ([
                    [
                      t('web.campaign_action_announcement'),
                      <BroadcastTally key="a" counts={r.announcement} />,
                    ],
                  ] as [ReactNode, ReactNode][])),
              ...(r.walletGift === null
                ? []
                : ([
                    [
                      t('web.campaign_action_wallet_gift'),
                      <BulkTally key="w" counts={r.walletGift.counts} />,
                    ],
                    [
                      t('web.campaign_results_credited'),
                      r.walletGift.creditedTotal === null ? (
                        '—'
                      ) : (
                        <Money key="wt" value={r.walletGift.creditedTotal} />
                      ),
                    ],
                  ] as [ReactNode, ReactNode][])),
              ...(r.trafficGift === null
                ? []
                : ([
                    [
                      t('web.campaign_action_traffic_gift'),
                      <BulkTally key="tr" counts={r.trafficGift.counts} />,
                    ],
                  ] as [ReactNode, ReactNode][])),
              ...(r.timeGift === null
                ? []
                : ([
                    [
                      t('web.campaign_action_time_gift'),
                      <BulkTally key="ti" counts={r.timeGift.counts} />,
                    ],
                  ] as [ReactNode, ReactNode][])),
            ]}
          />
        )}
      </StateSwitch>
    </Card>
  );
}

/** Re-exported for the tests. */
export { EMPTY_FORM as EMPTY_CAMPAIGN_FORM };
