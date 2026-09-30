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
  type ResellerCreditStanding,
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
  fetchResellerCredit,
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
  StateSwitch,
  Button,
  DetailHead,
  FilterChip,
  FilterChips,
  RowActions,
  TwoColumn,
  useUnsavedChanges,
  useToast,
  type Column,
  type Tone,
  Num,
} from '../ui/kit';
import { Icon } from '../ui/icons';
import { CheckField, SaveBar, revealField } from './editor-layout';
import {
  ResellerCreditCard,
  ResellerHistoryCard,
  ResellerPurchasesCard,
} from './reseller-standing';
import { ResellerPolicyCard } from './reseller-plans';

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
 *   reseller writes no ledger entry. How much of the line is in use is the SERVER's
 *   derivation from the ledger (WP14 D1), drawn by `ResellerCreditCard`; a debt is a
 *   negative balance and nothing here settles or collects it (`OQ-WP9-04`).
 * - **Lowering a limit below the debt, or suspending a reseller who owes, asks for an
 *   acknowledgement first** (WP14 D4). The server accepts both, as it always has.
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
  return (
    <Badge tone={RESELLER_STATUS_TONES[value]} dot>
      {t(RESELLER_STATUS_LABELS[value])}
    </Badge>
  );
}

/** One or two letters for a reseller's avatar tile: the name's, else the Telegram id's. */
function initialOf(reseller: ResellerSummaryResponse): string {
  const name = reseller.displayName?.trim() ?? '';
  return name === '' ? reseller.telegramUserId.slice(-2) : name.slice(0, 1);
}

/** A pricing mode and, when it carries one, its percentage. */
export function PricingText({ label, percent }: { label: WebKey; percent: number | null }) {
  return (
    <span className="nowrap">
      {t(label)}
      {percent !== null && (
        <>
          {' '}
          <Num value={String(percent)} /> {t('web.discount_percent_unit')}
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
    <div className="resellers-who">
      <span className="avatar" aria-hidden="true">
        {initialOf(reseller)}
      </span>
      <div>
        <a
          href={`/users/${encodeURIComponent(reseller.customerId)}`}
          onClick={onLink}
          className="strong"
        >
          {reseller.displayName ?? <Ltr>{reseller.telegramUserId}</Ltr>}
        </a>
        {reseller.displayName !== null && (
          <div className="muted small">
            <Ltr>{reseller.telegramUserId}</Ltr>
          </div>
        )}
      </div>
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

/** A whole percentage in `[1, 99]`, the range the contract's `percentSchema` allows. */
export function percentOf(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d{1,3}$/u.test(text)) return null;
  const value = Number(text);
  return value >= 1 && value <= 99 ? value : null;
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

type StatusFilter = 'ALL' | ResellerStatus;

export function ResellersPage({
  route,
  denied,
  mayEdit,
  mayViewWallet,
  mayViewOrders,
  mayViewAudit,
  mayViewCatalog = false,
  mayViewPanels = false,
}: {
  route: Route;
  /** No `resellers.view`: no list, no tiers, and no edit (it opens from a row). */
  denied: boolean;
  /** `resellers.edit` — its own server permission, never derived from `denied`. */
  mayEdit: boolean;
  /** WP14: `users.view` for the credit card, which reads the customer's wallet. */
  mayViewWallet: boolean;
  /** WP14: `orders.view` for the purchase history, whose every row names an order. */
  mayViewOrders: boolean;
  /** WP14: `audit.view` for the change history. */
  mayViewAudit: boolean;
  /** Round N: `catalog.view` and `panels.view`, for names in the effective-policy card. */
  mayViewCatalog?: boolean;
  mayViewPanels?: boolean;
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
  /** The reseller whose standing (credit, purchases, history) is open — a READ. */
  const [viewing, setViewing] = useState<string | null>(null);

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
    {
      key: 'tier',
      header: t('web.reseller_tier'),
      render: (row) => (
        <Badge tone="violet" outline>
          {row.tier.name}
        </Badge>
      ),
    },
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
      render: (row) => (
        <RowActions>
          <Button
            size="sm"
            variant="ghost"
            icon="eye"
            onClick={() => {
              setViewing(row.customerId);
              revealField('reseller-standing');
            }}
          >
            {t('web.reseller_standing_open')}
          </Button>
          {mayEdit && (
            <Button
              size="sm"
              variant="ghost"
              icon="edit"
              onClick={() => {
                setEditing(row);
                setViewing(row.customerId);
                revealField('reseller-standing');
              }}
            >
              {t('web.rule_edit')}
            </Button>
          )}
        </RowActions>
      ),
    },
  ];

  return (
    <>
      <PageHead
        title={t('web.resellers_title')}
        subtitle={t('web.resellers_intro')}
        actions={
          <>
            <a className="btn" href="/reseller-tiers" onClick={onLink}>
              <Icon name="layers" />
              {t('web.nav_reseller_tiers')}
            </a>
            <a className="btn" href="/reseller-plans" onClick={onLink}>
              <Icon name="target" />
              {t('web.nav_reseller_plans')}
            </a>
            {mayEdit && !denied && (
              <Button
                variant="primary"
                icon="userPlus"
                onClick={() => {
                  setEditing(null);
                  revealField('reseller-register-customer');
                }}
              >
                {t('web.cb_reseller_new')}
              </Button>
            )}
          </>
        }
      />

      <Card title={t('web.resellers_list_title')} hint={t('web.resellers_list_hint')}>
        {/* Hidden while the list cannot answer: a filter mints a request the server has
            just refused. */}
        <div className="cb-filters" hidden={!mayRequest(resellers, denied)}>
          <form className="toolbar" onSubmit={apply}>
            <div className="search cb-search">
              <label className="visually-hidden" htmlFor="resellers-search">
                {t('web.resellers_search')}
              </label>
              <Icon name="search" size={14} />
              <input
                id="resellers-search"
                className="input"
                type="search"
                value={draft.value}
                maxLength={64}
                placeholder={t('web.resellers_search_hint')}
                onChange={(event) => setDraft({ applied, value: event.target.value })}
              />
            </div>
            <Button type="submit" size="sm" variant="primary">
              {t('web.referrals_filter_apply')}
            </Button>
            {applied !== '' && (
              <a className="btn sm ghost" href="/resellers" onClick={onLink}>
                {t('web.referrals_filter_clear')}
              </a>
            )}
            <span className="spacer" />
            <Field label={t('web.reseller_tier')} htmlFor="resellers-tier" compact>
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
          </form>
          <FilterChips>
            {(
              [
                { id: 'ALL', label: t('web.reseller_status_all') },
                ...RESELLER_STATUSES.map((one) => ({
                  id: one,
                  label: t(RESELLER_STATUS_LABELS[one]),
                })),
              ] as { id: StatusFilter; label: string }[]
            ).map((item) => (
              <FilterChip
                key={item.id}
                pressed={status === item.id}
                onClick={() => setStatus(item.id)}
              >
                {item.label}
              </FilterChip>
            ))}
          </FilterChips>
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
            rowClassName={(row) => (row.customerId === viewing ? 'selected' : undefined)}
            dense
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

      {denied || viewing === null ? null : (
        // Keyed by the customer, so a second reseller's cards never show the first's pages.
        <div
          key={`standing-${viewing}`}
          id="reseller-standing"
          className="stack resellers-standing"
          tabIndex={-1}
        >
          <StandingHead
            customerId={viewing}
            row={rows.find((row) => row.customerId === viewing)}
            onClose={() => {
              setViewing(null);
              setEditing(null);
            }}
          />
          <TwoColumn
            main={
              <>
                {mayEdit && editing !== null && editing.customerId === viewing && (
                  // KEYED BY THE CUSTOMER: every `useState` initialiser must read the
                  // reseller now open, not the one open before it.
                  <ResellerForm
                    key={`edit-${editing.customerId}`}
                    reseller={editing}
                    tiers={tierRows}
                    mayViewWallet={mayViewWallet}
                    onDone={() => setEditing(null)}
                  />
                )}
                {/* Round N: what this reseller may sell, inherited or their own, and the minimum. */}
                <ResellerPolicyCard
                  customerId={viewing}
                  mayEdit={mayEdit}
                  mayViewCatalog={mayViewCatalog}
                  mayViewPanels={mayViewPanels}
                />
                <ResellerPurchasesCard customerId={viewing} mayViewOrders={mayViewOrders} />
                <ResellerHistoryCard customerId={viewing} mayViewAudit={mayViewAudit} />
              </>
            }
            side={<ResellerCreditCard customerId={viewing} mayViewWallet={mayViewWallet} />}
          />
        </div>
      )}

      <div className="grid-2 resellers-foot">
        {denied ? null : !mayEdit ? (
          <Card title={t('web.reseller_register_title')}>
            <Banner tone="info">{t('web.reseller_edit_denied')}</Banner>
          </Card>
        ) : editing !== null && editing.customerId !== viewing ? (
          // An edit opened for a reseller whose standing is not shown (never, today):
          // still the form, rather than nothing.
          <ResellerForm
            key={`edit-${editing.customerId}`}
            reseller={editing}
            tiers={tierRows}
            mayViewWallet={mayViewWallet}
            onDone={() => setEditing(null)}
          />
        ) : editing === null ? (
          // Keyed by the handed-over customer, so following a second "register" link
          // re-reads it rather than keeping the first one's draft.
          <ResellerForm
            key={`register-${registering}`}
            initialCustomerId={registering}
            tiers={tierRows}
            onDone={() => undefined}
          />
        ) : null}

        <Card title={t('web.resellers_scope_title')} tone="muted">
          <ul className="cb-notes">
            <li>{t('web.resellers_rule_identity')}</li>
            <li>{t('web.resellers_rule_credit')}</li>
            <li>{t('web.resellers_rule_suspend')}</li>
          </ul>
          <p>
            <a href="/reseller-tiers" onClick={onLink}>
              {t('web.resellers_tiers_link')}
            </a>
            {t('web.list_separator')}
            <a href="/reseller-plans" onClick={onLink}>
              {t('web.reseller_plans_title')}
            </a>
          </p>
        </Card>
      </div>
    </>
  );
}

/**
 * The head of an opened reseller's standing: who, their tier and status, their terms as
 * a strip of figures, and the way back to the list. Read from the list row already held
 * — no request of its own; when the row has paged away, the customer id stands in.
 */
function StandingHead({
  customerId,
  row,
  onClose,
}: {
  customerId: string;
  row: ResellerSummaryResponse | undefined;
  onClose: () => void;
}) {
  return (
    <DetailHead
      title={
        row === undefined ? (
          <Ltr>{customerId}</Ltr>
        ) : (
          (row.displayName ?? <Ltr>{row.telegramUserId}</Ltr>)
        )
      }
      {...(row === undefined
        ? {}
        : {
            initial: initialOf(row),
            badge: (
              <span className="resellers-badges">
                <Badge tone="violet">{row.tier.name}</Badge>
                <ResellerStatusBadge value={row.status} />
              </span>
            ),
            meta: (
              <>
                <Ltr>{row.telegramUserId}</Ltr>
                <span>{t('web.cb_reseller_standing')}</span>
              </>
            ),
            stats: [
              {
                label: t('web.reseller_pricing'),
                value: (
                  <PricingText
                    label={OVERRIDE_LABELS[row.pricingMode]}
                    percent={row.discountPercentage}
                  />
                ),
              },
              {
                label: t('web.reseller_credit_limit_effective'),
                value: <Money value={limitWire(row.effectiveCreditLimit)} />,
              },
              {
                label: t('web.reseller_credit_limit'),
                value: t(
                  row.creditLimit === null
                    ? 'web.reseller_credit_from_tier'
                    : 'web.reseller_credit_own',
                ),
              },
            ],
          })}
      actions={
        <Button size="sm" variant="ghost" icon="x" onClick={onClose}>
          {t('web.close')}
        </Button>
      }
    />
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

/**
 * Whether saving these terms needs the operator to acknowledge what happens to a debt
 * (WP14 D4), and which sentence says so. Null when nothing is owed, when the credit in use
 * is unknown (no `users.view`), or when the change does not reduce the credit line.
 *
 * It decides no money and gates nothing on the server, which accepts both changes as it
 * always has (R8, `OQ-WP9-04`): the debt stays where it is and further credit stops. The
 * one comparison it makes is the allowance settlement would apply — the new effective
 * limit in the selling currency, else zero — against the server's own credit in use.
 */
export function debtWarningOf(
  before: ResellerSummaryResponse,
  state: ResellerFormState,
  tiers: readonly ResellerTierSummaryResponse[] | null,
  credit: ResellerCreditStanding | undefined,
): WebKey | null {
  if (credit === undefined) return null;
  const inUse = BigInt(credit.creditInUse.amount);
  if (inUse <= 0n) return null;
  if (state.status !== 'ACTIVE') {
    return before.status === 'ACTIVE' ? 'web.reseller_confirm_suspend_debt' : null;
  }
  let limit: { amount: string; currency: CurrencyCode } | null;
  if (state.ownLimit) {
    const amount = creditAmountOf(state.limitAmount);
    limit = amount === null ? null : { amount, currency: state.limitCurrency };
  } else {
    limit = tiers?.find((candidate) => candidate.id === state.tierId)?.creditLimit ?? null;
  }
  if (limit === null) return null;
  const amount = BigInt(limit.amount);
  const allowance = limit.currency === credit.sellingCurrency && amount > 0n ? amount : 0n;
  return allowance < inUse && allowance < BigInt(credit.allowance.amount)
    ? 'web.reseller_confirm_limit_below_debt'
    : null;
}

function ResellerForm({
  reseller,
  initialCustomerId = '',
  tiers,
  mayViewWallet = false,
  onDone,
}: {
  /** Absent for a registration; the stored reseller for an edit. */
  reseller?: ResellerSummaryResponse;
  initialCustomerId?: string;
  /** Every tier, or null while the list has not answered. */
  tiers: readonly ResellerTierSummaryResponse[] | null;
  /** `users.view`: without it the credit in use is unknown here, and nothing is warned. */
  mayViewWallet?: boolean;
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
  /** The operator has read the debt warning for the terms as they are NOW. */
  const [acknowledged, setAcknowledged] = useState(false);
  const dirty =
    JSON.stringify(state) !==
    JSON.stringify(reseller === undefined ? blankState(initialCustomerId) : stateOf(reseller));
  useUnsavedChanges(dirty);
  const set = <K extends keyof ResellerFormState>(key: K, value: ResellerFormState[K]) => {
    setAcknowledged(false);
    setState((current) => ({ ...current, [key]: value }));
  };
  const credit = useQuery({
    queryKey: ['reseller-credit', reseller?.customerId ?? ''],
    queryFn: () => fetchResellerCredit(reseller?.customerId ?? ''),
    enabled: reseller !== undefined && mayViewWallet,
  });

  const checked =
    mode === 'register' ? resellerBodyFrom(state, 'register') : resellerBodyFrom(state, 'update');
  const problem = 'problem' in checked ? checked.problem : null;
  const tier = tiers?.find((candidate) => candidate.id === state.tierId);
  const warning =
    reseller === undefined ? null : debtWarningOf(reseller, state, tiers, credit.data?.credit);

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
      void queries.invalidateQueries({
        queryKey: ['reseller-credit', response.reseller.customerId],
      });
      void queries.invalidateQueries({
        queryKey: ['reseller-history', response.reseller.customerId],
      });
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

      <CheckField
        id={`${prefix}-own-limit`}
        label={t('web.reseller_own_limit')}
        hint={t('web.reseller_own_limit_hint')}
        checked={state.ownLimit}
        onChange={(next) => set('ownLimit', next)}
      />

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

      {problem === null && warning !== null && (
        <Banner tone="warn">
          <p>{t(warning)}</p>
          <label htmlFor={`${prefix}-acknowledge`}>
            <input
              id={`${prefix}-acknowledge`}
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />{' '}
            {t('web.reseller_confirm_acknowledge')}
          </label>
        </Banner>
      )}

      <SaveBar dirty={dirty}>
        {mode === 'update' && (
          <Button size="sm" disabled={save.isPending} onClick={onDone}>
            {t('web.rule_cancel_edit')}
          </Button>
        )}
        <Button
          variant="primary"
          size="sm"
          icon="check"
          disabled={problem !== null || (warning !== null && !acknowledged) || save.isPending}
          onClick={() => save.mutate()}
        >
          {mode === 'register' ? t('web.reseller_register') : t('web.rule_save')}
        </Button>
      </SaveBar>
      {save.error !== null && <Banner tone="danger">{messageFor(save.error)}</Banner>}
    </Card>
  );
}
