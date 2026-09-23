import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  RESELLER_MAX_CREDIT_LIMIT_MINOR,
  RESELLER_OVERRIDE_MODES,
  RESELLER_STATUSES,
  SALES_CURRENCY_CODES,
  uuidV7Schema,
  type CurrencyCode,
  type MoneyWire,
  type PricingStep,
  type ResellerOverrideMode,
  type ResellerPriceLayer,
  type ResellerPricingMode,
  type ResellerRegisterRequest,
  type ResellerStatus,
  type ResellerSummaryResponse,
  type ResellerTierSummaryResponse,
  type ResellerUpdateRequest,
} from '@nexa/contracts';
import {
  fetchResellerTiers,
  fetchResellers,
  registerReseller,
  updateReseller,
} from '../api/client';
import { useSubmissionKey } from '../submission-key';
import { mayRequest } from '../view-state';
import { t, type WebKey } from '../i18n/web.fa';
import { setQueries, useLinkHandler, type Route } from '../router';
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
  PageHead,
  Pills,
  StateSwitch,
  useToast,
  type Column,
  type Tone,
} from '../ui/kit';

/**
 * Resellers — who buys at a reseller's price, on which tier, and on how much credit
 * (WP9-B, `docs/wp9-reseller-audit.md` R1, R2, R3, R8, R11, R12).
 *
 * A reseller is a CUSTOMER with a reseller row, addressed by the customer's id; there is
 * one row per customer and no self-service application, so registering one is an
 * operator's command here. The page draws on the permissions the server charges:
 * `resellers.view` for the list (and the tiers the filter and the form offer),
 * `resellers.edit` for registering and editing. A form the actor may not submit is
 * replaced by a sentence naming the key, the rule `products.tsx` states.
 *
 * What the page says because the server does it:
 *
 * - **The effective credit limit is the server's**: the reseller's own, or the tier's
 *   when the reseller has none. The list shows which of the two applies.
 * - **Credit is an allowance below zero for purchases only** (R8). Registering a
 *   reseller writes no ledger entry, and the balance stays the one derived on the
 *   customer's page, which is where each row links.
 * - **Suspension withdraws the privileges and nothing else** (R1). Blocking the customer
 *   is the separate, existing lever on the customer's page.
 *
 * The browser computes no price. What a reseller paid is the order's own snapshot, on the
 * order's pricing card.
 */

// ---------------------------------------------------------------------------
// Vocabularies — each a `Record` over the frozen enum, so a value added to the
// contract without a label is a compile error rather than a blank cell.
// ---------------------------------------------------------------------------

export const RESELLER_STATUS_LABELS: Readonly<Record<ResellerStatus, WebKey>> = {
  ACTIVE: 'web.reseller_status_active',
  SUSPENDED: 'web.reseller_status_suspended',
};

const RESELLER_STATUS_TONES: Readonly<Record<ResellerStatus, Tone>> = {
  ACTIVE: 'ok',
  SUSPENDED: 'warn',
};

/** A TIER's pricing: the list price, or a percentage off it. A tier has nothing above it. */
export const TIER_PRICING_LABELS: Readonly<Record<ResellerPricingMode, WebKey>> = {
  LIST_PRICE: 'web.reseller_pricing_list',
  PERCENTAGE_DISCOUNT: 'web.reseller_pricing_percentage',
};

/** A RESELLER's own pricing over its tier: `TIER` is "no override". */
export const OVERRIDE_LABELS: Readonly<Record<ResellerOverrideMode, WebKey>> = {
  TIER: 'web.reseller_override_tier',
  LIST_PRICE: 'web.reseller_override_list',
  PERCENTAGE_DISCOUNT: 'web.reseller_override_percentage',
};

/**
 * Which layer set a reseller's price, as the order's snapshot recorded it (R3, R9).
 *
 * Only one of `TIER_PRICE` and `USER_OVERRIDE` ever fires, because the override REPLACES
 * the tier; `LIST` is the case where neither changed anything and no step was added.
 */
export const PRICE_LAYER_LABELS: Readonly<Record<ResellerPriceLayer, WebKey>> = {
  LIST: 'web.reseller_layer_list',
  TIER: 'web.reseller_layer_tier',
  OVERRIDE: 'web.reseller_layer_override',
};

/**
 * The quote-trace step each layer is written as, so an operator reading a quote's trace
 * and this card is reading one vocabulary. `LIST` adds no step: a layer that changes
 * nothing is not recorded, for WP8's reason.
 */
export const PRICE_LAYER_STEPS: Readonly<Record<ResellerPriceLayer, PricingStep | null>> = {
  LIST: null,
  TIER: 'TIER_PRICE',
  OVERRIDE: 'USER_OVERRIDE',
};

export function ResellerStatusBadge({ value }: { value: ResellerStatus }) {
  return <Badge tone={RESELLER_STATUS_TONES[value]}>{t(RESELLER_STATUS_LABELS[value])}</Badge>;
}

/** A pricing mode and, when it carries one, its percentage. */
export function PricingText({ label, percent }: { label: WebKey; percent: number | null }) {
  return (
    <span className="nowrap">
      {t(label)}
      {percent !== null && (
        <>
          {' '}
          <Ltr>{String(percent)}</Ltr> {t('web.discount_percent_unit')}
        </>
      )}
    </span>
  );
}

/**
 * A credit limit as `Money` draws it. The reseller contract spells the pair
 * `{ amount, currency }`; the renderer takes `{ amountMinor, currency }`. Same digits,
 * same currency, renamed once here rather than at every call site.
 */
export function limitWire(limit: { amount: string; currency: CurrencyCode }): MoneyWire {
  return { amountMinor: limit.amount, currency: limit.currency };
}

/** The limit that applies, and whether it is the reseller's own or the tier's. */
export function CreditLimitCell({ reseller }: { reseller: ResellerSummaryResponse }) {
  return (
    <div>
      <Money value={limitWire(reseller.effectiveCreditLimit)} />
      <div className="muted small">
        {t(
          reseller.creditLimit === null
            ? 'web.reseller_credit_from_tier'
            : 'web.reseller_credit_own',
        )}
      </div>
    </div>
  );
}

function Dash() {
  return <span className="faint">—</span>;
}

/** The name an operator recognises, falling back to the Telegram id that always exists. */
function ResellerCell({ reseller }: { reseller: ResellerSummaryResponse }) {
  const onLink = useLinkHandler();
  return (
    <div>
      <a href={`/users/${encodeURIComponent(reseller.customerId)}`} onClick={onLink}>
        {reseller.displayName ?? <Ltr>{reseller.telegramUserId}</Ltr>}
      </a>
      {reseller.displayName !== null && (
        <div className="muted small">
          <Ltr>{reseller.telegramUserId}</Ltr>
        </div>
      )}
    </div>
  );
}

/**
 * The cursor trail, reset when the filter changes — the shape `referrals.tsx` and
 * `discounts.tsx` use, for their reason: a cursor minted under one filter strands every
 * row before it under another.
 */
function useTrail(signature: string) {
  const [trail, setTrail] = useState<{ signature: string; cursors: readonly string[] }>({
    signature,
    cursors: [],
  });
  const cursors = trail.signature === signature ? trail.cursors : [];
  return {
    cursor: cursors.length > 0 ? cursors[cursors.length - 1] : undefined,
    depth: cursors.length,
    push: (next: string) => setTrail({ signature, cursors: [...cursors, next] }),
    pop: () => setTrail({ signature, cursors: cursors.slice(0, -1) }),
  };
}

/**
 * A credit limit typed in minor units, or null when it is not one.
 *
 * Digits only, and never parsed to a `number`: the contract carries money as a decimal
 * string so a value above 2^53 survives. Bounded by the contract's own maximum, so the
 * operator is told here rather than by a 400.
 */
export function creditAmountOf(raw: string): string | null {
  const text = raw.trim();
  if (!/^\d{1,19}$/u.test(text)) return null;
  if (BigInt(text) > RESELLER_MAX_CREDIT_LIMIT_MINOR) return null;
  // Stripped of leading zeros so `010` and `10` are one payload and one fingerprint.
  return text.replace(/^0+(?=\d)/u, '');
}

/** A whole percentage in `[1, 100]`, the range the contract's `percentSchema` allows. */
export function percentOf(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d{1,3}$/u.test(text)) return null;
  const value = Number(text);
  return value >= 1 && value <= 100 ? value : null;
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

type StatusFilter = 'ALL' | ResellerStatus;

export function ResellersPage({
  route,
  denied,
  mayEdit,
}: {
  route: Route;
  /** No `resellers.view`: no list, no tiers, and no edit (it opens from a row). */
  denied: boolean;
  /** `resellers.edit` — its own server permission, never derived from `denied`. */
  mayEdit: boolean;
}) {
  const onLink = useLinkHandler();
  const applied = route.query.get('search') ?? '';
  /** A customer id handed over by the customer page's "register" link. */
  const registering = route.query.get('register') ?? '';

  /*
   * The draft is keyed to the APPLIED value, so navigation that drops the query clears
   * the box — the defect `users.tsx` and `referrals.tsx` record.
   */
  const [draft, setDraft] = useState({ applied, value: applied });
  if (draft.applied !== applied) setDraft({ applied, value: applied });

  const [status, setStatus] = useState<StatusFilter>('ALL');
  const [tierId, setTierId] = useState('');
  const signature = `${applied}|${status}|${tierId}`;
  const trail = useTrail(signature);

  const tiers = useQuery({
    queryKey: ['reseller-tiers'],
    queryFn: () => fetchResellerTiers(),
    enabled: !denied,
  });
  const tierRows = tiers.data?.tiers ?? null;

  const resellers = useQuery({
    queryKey: ['resellers', signature, trail.cursor ?? null],
    queryFn: () =>
      fetchResellers({
        ...(trail.cursor === undefined ? {} : { cursor: trail.cursor }),
        ...(status === 'ALL' ? {} : { status }),
        ...(tierId === '' ? {} : { tierId }),
        ...(applied === '' ? {} : { search: applied }),
      }),
    enabled: !denied,
  });
  const rows = resellers.data?.resellers ?? [];
  const nextCursor = resellers.data?.nextCursor ?? null;
  const filtered = applied !== '' || status !== 'ALL' || tierId !== '';

  /** The reseller whose edit form is open, as the server last described it. */
  const [editing, setEditing] = useState<ResellerSummaryResponse | null>(null);

  const apply = (event: FormEvent) => {
    event.preventDefault();
    setQueries(route, [['search', draft.value.trim() === '' ? null : draft.value.trim()]]);
  };

  const columns: readonly Column<ResellerSummaryResponse>[] = [
    {
      key: 'reseller',
      header: t('web.reseller_customer'),
      render: (row) => <ResellerCell reseller={row} />,
    },
    { key: 'tier', header: t('web.reseller_tier'), render: (row) => row.tier.name },
    {
      key: 'status',
      header: t('web.status'),
      render: (row) => <ResellerStatusBadge value={row.status} />,
    },
    {
      key: 'pricing',
      header: t('web.reseller_pricing'),
      render: (row) => (
        <PricingText label={OVERRIDE_LABELS[row.pricingMode]} percent={row.discountPercentage} />
      ),
    },
    {
      key: 'credit',
      header: t('web.reseller_credit_limit'),
      render: (row) => <CreditLimitCell reseller={row} />,
    },
    {
      key: 'actions',
      header: t('web.rule_actions'),
      align: 'end',
      // Nothing for a reader. The header stays, so two operators describe one table.
      render: (row) =>
        !mayEdit ? null : (
          <button type="button" className="btn sm" onClick={() => setEditing(row)}>
            {t('web.rule_edit')}
          </button>
        ),
    },
  ];

  return (
    <>
      <PageHead
        title={t('web.resellers_title')}
        subtitle={t('web.resellers_intro')}
        maturity="now"
      />

      <Card title={t('web.resellers_list_title')} hint={t('web.resellers_list_hint')}>
        {/* Hidden while the list cannot answer: a filter mints a request the server has
            just refused. */}
        <div hidden={!mayRequest(resellers, denied)}>
          <form className="toolbar" onSubmit={apply}>
            <Field
              label={t('web.resellers_search')}
              hint={t('web.resellers_search_hint')}
              htmlFor="resellers-search"
            >
              <input
                id="resellers-search"
                value={draft.value}
                maxLength={64}
                onChange={(event) => setDraft({ applied, value: event.target.value })}
              />
            </Field>
            <button type="submit" className="btn sm">
              {t('web.referrals_filter_apply')}
            </button>
            {applied !== '' && (
              <a href="/resellers" onClick={onLink}>
                {t('web.referrals_filter_clear')}
              </a>
            )}
          </form>
          <div className="toolbar">
            <Pills
              value={status}
              onChange={setStatus}
              items={[
                { id: 'ALL' as const, label: t('web.reseller_status_all') },
                ...RESELLER_STATUSES.map((one) => ({
                  id: one,
                  label: t(RESELLER_STATUS_LABELS[one]),
                })),
              ]}
            />
            <Field label={t('web.reseller_tier')} htmlFor="resellers-tier">
              <select
                id="resellers-tier"
                value={tierId}
                onChange={(event) => setTierId(event.target.value)}
              >
                <option value="">{t('web.reseller_tier_all')}</option>
                {(tierRows ?? []).map((tier) => (
                  <option key={tier.id} value={tier.id}>
                    {tier.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </div>

        <StateSwitch
          query={resellers}
          denied={denied}
          isEmpty={rows.length === 0 && trail.depth === 0}
          empty={
            filtered ? (
              <Empty title={t('web.referrals_filter_empty')} icon="inbox" />
            ) : (
              <Empty
                title={t('web.resellers_empty')}
                hint={t('web.resellers_empty_hint')}
                icon="resellers"
              />
            )
          }
        >
          <DataTable
            caption={t('web.resellers_list_title')}
            columns={columns}
            rows={rows}
            rowKey={(row) => row.customerId}
          />
          {/* Default labels: `GET /resellers` pages newest to oldest. */}
          <CursorPager
            shown={rows.length}
            hasPrevious={trail.depth > 0}
            hasNext={nextCursor !== null}
            onPrevious={trail.pop}
            onNext={() => nextCursor !== null && trail.push(nextCursor)}
          />
        </StateSwitch>
      </Card>

      {denied ? null : !mayEdit ? (
        <Card title={t('web.reseller_register_title')}>
          <Banner tone="info">{t('web.reseller_edit_denied')}</Banner>
        </Card>
      ) : editing !== null ? (
        // KEYED BY THE CUSTOMER: every `useState` initialiser must read the reseller now
        // open, not the one open before it.
        <ResellerForm
          key={`edit-${editing.customerId}`}
          reseller={editing}
          tiers={tierRows}
          onDone={() => setEditing(null)}
        />
      ) : (
        // Keyed by the handed-over customer, so following a second "register" link
        // re-reads it rather than keeping the first one's draft.
        <ResellerForm
          key={`register-${registering}`}
          initialCustomerId={registering}
          tiers={tierRows}
          onDone={() => undefined}
        />
      )}

      <Card title={t('web.resellers_scope_title')}>
        <p className="muted">{t('web.resellers_rule_identity')}</p>
        <p className="muted">{t('web.resellers_rule_credit')}</p>
        <p className="muted">{t('web.resellers_rule_suspend')}</p>
        <p>
          <a href="/reseller-tiers" onClick={onLink}>
            {t('web.resellers_tiers_link')}
          </a>
        </p>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Register and edit
// ---------------------------------------------------------------------------

export interface ResellerFormState {
  customerId: string;
  tierId: string;
  status: ResellerStatus;
  pricingMode: ResellerOverrideMode;
  percent: string;
  /** False is "use the tier's limit", which is a null on the wire. */
  ownLimit: boolean;
  limitAmount: string;
  limitCurrency: CurrencyCode;
}

function blankState(customerId: string): ResellerFormState {
  return {
    customerId,
    tierId: '',
    status: 'ACTIVE',
    pricingMode: 'TIER',
    percent: '',
    ownLimit: false,
    limitAmount: '',
    limitCurrency: SALES_CURRENCY_CODES[0],
  };
}

function stateOf(reseller: ResellerSummaryResponse): ResellerFormState {
  return {
    customerId: reseller.customerId,
    tierId: reseller.tier.id,
    status: reseller.status,
    pricingMode: reseller.pricingMode,
    percent: reseller.discountPercentage === null ? '' : String(reseller.discountPercentage),
    ownLimit: reseller.creditLimit !== null,
    limitAmount: reseller.creditLimit?.amount ?? '',
    limitCurrency: reseller.creditLimit?.currency ?? reseller.effectiveCreditLimit.currency,
  };
}

type TermsBody = Pick<
  ResellerRegisterRequest,
  'tierId' | 'pricingMode' | 'discountPercentage' | 'creditLimit'
>;

/**
 * The write body, or the field that is wrong.
 *
 * Checked with the same rules the contract refines — a percentage exactly when the mode
 * is a percentage, a limit that is a whole number of minor units — so the operator is
 * told which field to fix rather than receiving a 400. The server decides again.
 */
export function resellerBodyFrom(
  state: ResellerFormState,
  mode: 'register',
): { body: Omit<ResellerRegisterRequest, 'idempotencyKey'> } | { problem: WebKey };
export function resellerBodyFrom(
  state: ResellerFormState,
  mode: 'update',
): { body: Omit<ResellerUpdateRequest, 'idempotencyKey'> } | { problem: WebKey };
export function resellerBodyFrom(
  state: ResellerFormState,
  mode: 'register' | 'update',
):
  | { body: Omit<ResellerRegisterRequest, 'idempotencyKey'> }
  | { body: Omit<ResellerUpdateRequest, 'idempotencyKey'> }
  | { problem: WebKey } {
  const customerId = state.customerId.trim();
  if (mode === 'register' && !uuidV7Schema.safeParse(customerId).success) {
    return { problem: 'web.reseller_problem_customer' };
  }
  if (!uuidV7Schema.safeParse(state.tierId).success) {
    return { problem: 'web.reseller_problem_tier' };
  }
  let discountPercentage: number | null = null;
  if (state.pricingMode === 'PERCENTAGE_DISCOUNT') {
    discountPercentage = percentOf(state.percent);
    if (discountPercentage === null) return { problem: 'web.reseller_problem_percent' };
  }
  let creditLimit: TermsBody['creditLimit'] = null;
  if (state.ownLimit) {
    const amount = creditAmountOf(state.limitAmount);
    if (amount === null) return { problem: 'web.reseller_problem_limit' };
    creditLimit = { amount, currency: state.limitCurrency };
  }
  const terms: TermsBody = {
    tierId: state.tierId,
    pricingMode: state.pricingMode,
    discountPercentage,
    creditLimit,
  };
  return mode === 'register'
    ? { body: { customerId, ...terms } }
    : { body: { status: state.status, ...terms } };
}

function ResellerForm({
  reseller,
  initialCustomerId = '',
  tiers,
  onDone,
}: {
  /** Absent for a registration; the stored reseller for an edit. */
  reseller?: ResellerSummaryResponse;
  initialCustomerId?: string;
  /** Every tier, or null while the list has not answered. */
  tiers: readonly ResellerTierSummaryResponse[] | null;
  onDone: () => void;
}) {
  const mode = reseller === undefined ? 'register' : 'update';
  const prefix = `reseller-${mode}`;
  const onLink = useLinkHandler();
  const notify = useToast();
  const queries = useQueryClient();
  const submission = useSubmissionKey();
  const [state, setState] = useState<ResellerFormState>(
    reseller === undefined ? blankState(initialCustomerId) : stateOf(reseller),
  );
  const set = <K extends keyof ResellerFormState>(key: K, value: ResellerFormState[K]) =>
    setState((current) => ({ ...current, [key]: value }));

  const checked =
    mode === 'register' ? resellerBodyFrom(state, 'register') : resellerBodyFrom(state, 'update');
  const problem = 'problem' in checked ? checked.problem : null;
  const tier = tiers?.find((candidate) => candidate.id === state.tierId);

  const save = useMutation({
    mutationFn: () => {
      if ('problem' in checked) throw new Error('unreachable: guarded by the submit button');
      // Bound to the payload AND the customer, so a corrected field is a NEW command.
      const idempotencyKey = submission.current({ customerId: state.customerId, ...checked.body });
      if (reseller === undefined) {
        return registerReseller({
          ...(checked.body as Omit<ResellerRegisterRequest, 'idempotencyKey'>),
          idempotencyKey,
        });
      }
      return updateReseller({
        ...(checked.body as Omit<ResellerUpdateRequest, 'idempotencyKey'>),
        customerId: reseller.customerId,
        idempotencyKey,
      });
    },
    onSuccess: (response) => {
      submission.settle();
      notify({
        tone: 'ok',
        message: mode === 'register' ? t('web.reseller_registered') : t('web.reseller_saved'),
      });
      if (mode === 'register') setState(blankState(''));
      // The customer's card reads the same row, and a tier's count moves with it.
      queries.setQueryData(['customer-reseller', response.reseller.customerId], response);
      void queries.invalidateQueries({ queryKey: ['resellers'] });
      void queries.invalidateQueries({ queryKey: ['reseller-tiers'] });
      onDone();
    },
    // A 5xx may have committed. A fresh key on the next press would be a second command.
    onError: (error) => submission.settleOn(error),
  });

  /** A stored currency outside the sales list stays selectable, so an edit keeps it. */
  const currencies: readonly CurrencyCode[] = (
    SALES_CURRENCY_CODES as readonly CurrencyCode[]
  ).concat(
    (SALES_CURRENCY_CODES as readonly string[]).includes(state.limitCurrency)
      ? []
      : [state.limitCurrency],
  );

  return (
    <Card
      title={mode === 'register' ? t('web.reseller_register_title') : t('web.reseller_edit_title')}
      {...(mode === 'register' ? { hint: t('web.reseller_register_hint') } : {})}
    >
      {tiers !== null && tiers.length === 0 && (
        <Banner tone="warn">
          {t('web.reseller_no_tiers')}{' '}
          <a href="/reseller-tiers" onClick={onLink}>
            {t('web.resellers_tiers_link')}
          </a>
        </Banner>
      )}

      {reseller === undefined ? (
        <Field
          label={t('web.reseller_customer_id')}
          hint={t('web.reseller_customer_id_hint')}
          htmlFor={`${prefix}-customer`}
        >
          <input
            id={`${prefix}-customer`}
            dir="ltr"
            value={state.customerId}
            onChange={(event) => set('customerId', event.target.value.trim())}
          />
        </Field>
      ) : (
        /* TEXT, not a disabled input: a reseller row never moves to another customer. */
        <KV
          items={[
            [t('web.reseller_customer'), <ResellerCell key="c" reseller={reseller} />],
            [
              t('web.reseller_credit_limit_effective'),
              <CreditLimitCell key="l" reseller={reseller} />,
            ],
          ]}
        />
      )}

      <Field label={t('web.reseller_tier')} htmlFor={`${prefix}-tier`}>
        <select
          id={`${prefix}-tier`}
          value={state.tierId}
          onChange={(event) => set('tierId', event.target.value)}
        >
          <option value="" />
          {(tiers ?? []).map((one) => (
            <option key={one.id} value={one.id}>
              {one.name}
            </option>
          ))}
        </select>
      </Field>

      {mode === 'update' && (
        <Field
          label={t('web.status')}
          hint={t('web.reseller_status_hint')}
          htmlFor={`${prefix}-status`}
        >
          <select
            id={`${prefix}-status`}
            value={state.status}
            onChange={(event) => set('status', event.target.value as ResellerStatus)}
          >
            {RESELLER_STATUSES.map((one) => (
              <option key={one} value={one}>
                {t(RESELLER_STATUS_LABELS[one])}
              </option>
            ))}
          </select>
        </Field>
      )}

      <Field
        label={t('web.reseller_pricing')}
        hint={t('web.reseller_pricing_hint')}
        htmlFor={`${prefix}-pricing`}
      >
        <select
          id={`${prefix}-pricing`}
          value={state.pricingMode}
          onChange={(event) => set('pricingMode', event.target.value as ResellerOverrideMode)}
        >
          {RESELLER_OVERRIDE_MODES.map((one) => (
            <option key={one} value={one}>
              {t(OVERRIDE_LABELS[one])}
            </option>
          ))}
        </select>
      </Field>

      {state.pricingMode === 'TIER' && tier !== undefined && (
        <p className="muted small">
          {t('web.reseller_tier_pricing_now')}{' '}
          <PricingText
            label={TIER_PRICING_LABELS[tier.pricingMode]}
            percent={tier.discountPercentage}
          />
        </p>
      )}

      {state.pricingMode === 'PERCENTAGE_DISCOUNT' && (
        <Field
          label={t('web.reseller_percent')}
          hint={t('web.reseller_percent_hint')}
          htmlFor={`${prefix}-percent`}
        >
          <input
            id={`${prefix}-percent`}
            dir="ltr"
            inputMode="numeric"
            value={state.percent}
            onChange={(event) => set('percent', event.target.value.trim())}
          />
        </Field>
      )}

      <Field
        label={t('web.reseller_own_limit')}
        hint={t('web.reseller_own_limit_hint')}
        htmlFor={`${prefix}-own-limit`}
      >
        <input
          id={`${prefix}-own-limit`}
          type="checkbox"
          checked={state.ownLimit}
          onChange={(event) => set('ownLimit', event.target.checked)}
        />
      </Field>

      {!state.ownLimit ? (
        <p className="muted small">
          {t('web.reseller_uses_tier_limit')}{' '}
          {tier === undefined ? <Dash /> : <Money value={limitWire(tier.creditLimit)} />}
        </p>
      ) : (
        <>
          <Field
            label={t('web.reseller_limit_amount')}
            hint={t('web.reseller_limit_amount_hint')}
            htmlFor={`${prefix}-limit`}
          >
            <input
              id={`${prefix}-limit`}
              dir="ltr"
              inputMode="numeric"
              value={state.limitAmount}
              onChange={(event) => set('limitAmount', event.target.value.trim())}
            />
          </Field>
          <Field label={t('web.discount_currency')} htmlFor={`${prefix}-currency`}>
            <select
              id={`${prefix}-currency`}
              value={state.limitCurrency}
              onChange={(event) => set('limitCurrency', event.target.value as CurrencyCode)}
            >
              {currencies.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </Field>
        </>
      )}

      {problem !== null && <Banner tone="warn">{t(problem)}</Banner>}

      <div className="toolbar">
        <button
          type="button"
          className="btn primary sm"
          disabled={problem !== null || save.isPending}
          onClick={() => save.mutate()}
        >
          {mode === 'register' ? t('web.reseller_register') : t('web.rule_save')}
        </button>
        {mode === 'update' && (
          <button type="button" className="btn sm" disabled={save.isPending} onClick={onDone}>
            {t('web.rule_cancel_edit')}
          </button>
        )}
      </div>
      {save.error !== null && <Banner tone="danger">{messageFor(save.error)}</Banner>}
    </Card>
  );
}
