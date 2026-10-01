import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  RESELLER_ENTITLEMENT_DIMENSIONS,
  RESELLER_GRANT_DIMENSION,
  RESELLER_GRANT_KINDS,
  RESELLER_MONTHLY_MINIMUM_MAX_MINOR,
  SALES_CURRENCY_CODES,
  type CurrencyCode,
  type ResellerEntitlementDimension,
  type ResellerGrantKind,
  type ResellerGrantOverride,
  type ResellerMinimumFilter,
  type ResellerMinimumPeriod,
  type ResellerMinimumRow,
  type ResellerMinimumSource,
  type ResellerMinimumState,
  type ResellerPolicy,
  type ResellerPriceLayer,
  type ResellerTierGrant,
  type ResellerTierSummaryResponse,
} from '@nexa/contracts';
import {
  fetchResellerMinimums,
  fetchResellerPolicy,
  fetchResellerTiers,
  replaceResellerOverrides,
  setResellerMinimum,
  setResellerTierMinimum,
} from '../api/client';
import { useSubmissionKey } from '../submission-key';
import { t, type WebKey } from '../i18n/web.fa';
import { useLinkHandler } from '../router';
import { messageFor } from './settings';
import {
  DIMENSION_LABELS,
  GRANT_KIND_LABELS,
  GrantsEditor,
  KindEditor,
  grantsBodyFrom,
  grantsStateOf,
  useGrantOptions,
  type GrantsState,
} from './reseller-tiers';
import {
  OVERRIDE_LABELS,
  PricingText,
  ResellerStatusBadge,
  TIER_PRICING_LABELS,
  limitWire,
} from './resellers';
import {
  Badge,
  Banner,
  Card,
  DataTable,
  Empty,
  Field,
  KV,
  Ltr,
  Money,
  Num,
  PageHead,
  StateSwitch,
  Button,
  ChipDivider,
  FilterChip,
  Progress,
  RowActions,
  StatCard,
  useToast,
  type Column,
  type Tone,
} from '../ui/kit';
import { Icon } from '../ui/icons';
import { ChipGroup, revealField } from './editor-layout';

/**
 * «تنظیمات نمایندگان / پلن‌ها و حداقل فروش» — round N, package D
 * (`docs/round-n-reseller-audit.md`).
 *
 * One place for what a reseller may sell and how much they are expected to sell:
 *
 * - **Plans per tier.** Which EXISTING Products, categories and panels each tier allows —
 *   the tier's own grants, edited in the same grants editor `/reseller-tiers` uses — beside
 *   the tier's pricing and its monthly minimum. There is no second catalogue and no second
 *   price list: a reseller's price is the tier's (or their own) rate on the Product's list
 *   price, applied by the one pricing boundary at checkout.
 * - **Monthly progress.** Every reseller's sales this month (or last month) against their
 *   minimum, in the tenant's calendar. The figure is the resellers report's own; the
 *   server decides every number and this page only draws them.
 * - **Effective policy.** For one reseller: what the tier grants, what the reseller's own
 *   override replaces, and what applies — with the evaluator's answer for each Product —
 *   and the override editor.
 *
 * Nothing on this page has a consequence for a reseller below their minimum. It says so,
 * because an operator who does not see it stated will reasonably assume the opposite.
 */

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

export const MINIMUM_STATE_LABELS: Readonly<Record<ResellerMinimumState, WebKey>> = {
  ACHIEVED: 'web.reseller_minimum_state_achieved',
  BELOW: 'web.reseller_minimum_state_below',
  NO_MINIMUM: 'web.reseller_minimum_state_none',
  NOT_ACTIVE: 'web.reseller_minimum_state_not_active',
};

const MINIMUM_STATE_TONES: Readonly<Record<ResellerMinimumState, Tone>> = {
  ACHIEVED: 'ok',
  BELOW: 'warn',
  NO_MINIMUM: 'neutral',
  NOT_ACTIVE: 'neutral',
};

export const MINIMUM_SOURCE_LABELS: Readonly<Record<ResellerMinimumSource, WebKey>> = {
  TIER: 'web.reseller_minimum_source_tier',
  RESELLER: 'web.reseller_minimum_source_own',
  NONE: 'web.reseller_minimum_source_none',
};

const PERIOD_LABELS: Readonly<Record<ResellerMinimumPeriod, WebKey>> = {
  THIS_MONTH: 'web.reseller_minimum_period_this',
  PREVIOUS_MONTH: 'web.reseller_minimum_period_previous',
};

const FILTER_LABELS: Readonly<Record<ResellerMinimumFilter, WebKey>> = {
  ALL: 'web.reseller_minimum_filter_all',
  ACHIEVED: 'web.reseller_minimum_filter_achieved',
  BELOW: 'web.reseller_minimum_filter_below',
};

const LAYER_LABELS: Readonly<Record<ResellerPriceLayer, WebKey>> = {
  LIST: 'web.reseller_layer_list',
  TIER: 'web.reseller_layer_tier',
  OVERRIDE: 'web.reseller_layer_override',
};

const BOT_BASIS_LABELS: Readonly<Record<ResellerPolicy['botBasis'], WebKey>> = {
  ANY_BOT: 'web.reseller_policy_bot_any',
  GRANTED_BOT: 'web.reseller_policy_bot_granted',
  NO_BOT: 'web.reseller_policy_bot_none',
};

// ---------------------------------------------------------------------------
// Pure helpers (tested)
// ---------------------------------------------------------------------------

/**
 * A minimum typed in minor units, or null when it is not one: digits only, never parsed to
 * a `number`, bounded by the contract's ceiling, leading zeros stripped so `010` and `10`
 * are one payload.
 */
export function minimumAmountOf(raw: string): string | null {
  const text = raw.trim();
  if (!/^\d{1,19}$/u.test(text)) return null;
  if (BigInt(text) > RESELLER_MONTHLY_MINIMUM_MAX_MINOR) return null;
  return text.replace(/^0+(?=\d)/u, '');
}

/** Whole percent, floored — the server's basis points never round up to "done". */
export function progressPercentOf(basisPoints: number): number {
  return Math.floor(basisPoints / 100);
}

/**
 * A grant list in words: «همه», «هیچ», or the names (an id when no name is known). The
 * same reading the evaluator applies: a null subject is every subject of its kind.
 */
export function grantsInWords(
  grants: readonly ResellerTierGrant[],
  kinds: readonly ResellerGrantKind[],
  names: ReadonlyMap<string, string>,
): string {
  const parts: string[] = [];
  for (const kind of kinds) {
    const ofKind = grants.filter((grant) => grant.kind === kind);
    if (ofKind.length === 0) continue;
    const label = t(GRANT_KIND_LABELS[kind]);
    if (ofKind.some((grant) => grant.subject === null)) {
      parts.push(`${label}: ${t('web.reseller_grant_all')}`);
      continue;
    }
    parts.push(
      `${label}: ${ofKind
        .map((grant) => names.get(grant.subject ?? '') ?? grant.subject ?? '')
        .join(t('web.list_separator'))}`,
    );
  }
  return parts.length === 0 ? t('web.reseller_grant_none') : parts.join(' — ');
}

/** The kinds of one dimension, in the contract's order. */
export function kindsOf(dimension: ResellerEntitlementDimension): readonly ResellerGrantKind[] {
  return RESELLER_GRANT_KINDS.filter((kind) => RESELLER_GRANT_DIMENSION[kind] === dimension);
}

/**
 * The override write body from the editor's state, or what is wrong with it.
 *
 * Only the dimensions marked "own" are sent; every other dimension inherits the tier's, and
 * its kinds are treated as NONE here so an unfinished edit in an inherited dimension can
 * never block — or leak into — the body. An own dimension with nothing chosen is sent with
 * no grant, which the server reads as "nothing of this dimension": deny by default.
 */
export function overridesBodyFrom(
  state: GrantsState,
  own: ReadonlySet<ResellerEntitlementDimension>,
  typedKinds: ReadonlySet<ResellerGrantKind>,
): { overrides: ResellerGrantOverride[] } | { problem: WebKey } {
  const masked = { ...state } as Record<ResellerGrantKind, GrantsState[ResellerGrantKind]>;
  for (const kind of RESELLER_GRANT_KINDS) {
    if (!own.has(RESELLER_GRANT_DIMENSION[kind])) {
      masked[kind] = { mode: 'NONE', subjects: [], typed: '' };
    }
  }
  const checked = grantsBodyFrom(masked, typedKinds);
  if ('problem' in checked) return checked;
  return {
    overrides: RESELLER_ENTITLEMENT_DIMENSIONS.filter((dimension) => own.has(dimension)).map(
      (dimension) => ({
        dimension,
        grants: checked.grants.filter(
          (grant) => RESELLER_GRANT_DIMENSION[grant.kind] === dimension,
        ),
      }),
    ),
  };
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export function ResellerPlansPage({
  denied,
  mayEdit,
  mayViewOrders,
  mayViewCatalog,
  mayViewPanels,
}: {
  /** No `resellers.view`. */
  denied: boolean;
  /** `resellers.edit`. */
  mayEdit: boolean;
  /** `orders.view` — the progress read sums order amounts, and the server charges it. */
  mayViewOrders: boolean;
  /** `catalog.view` — names and pickers for Products and categories. */
  mayViewCatalog: boolean;
  /** `panels.view` — names and the picker for panels. */
  mayViewPanels: boolean;
}) {
  const onLink = useLinkHandler();
  const tiers = useQuery({
    queryKey: ['reseller-tiers'],
    queryFn: () => fetchResellerTiers(),
    enabled: !denied,
  });
  const rows = tiers.data?.tiers ?? [];
  const [grantsId, setGrantsId] = useState<string | null>(null);
  const [minimumId, setMinimumId] = useState<string | null>(null);
  const [policyId, setPolicyId] = useState<string | null>(null);
  const granting = rows.find((row) => row.id === grantsId);
  const minimumTier = rows.find((row) => row.id === minimumId);

  const { options, names } = useGrantOptions({
    catalogue: !denied && mayViewCatalog,
    panels: !denied && mayViewPanels,
  });

  const columns: readonly Column<ResellerTierSummaryResponse>[] = [
    {
      key: 'name',
      header: t('web.reseller_tier_name'),
      render: (row) => <strong>{row.name}</strong>,
    },
    {
      key: 'products',
      header: t('web.reseller_plans_products'),
      render: (row) => (
        <span className="small">{grantsInWords(row.grants, kindsOf('CATALOGUE'), names)}</span>
      ),
    },
    {
      key: 'panels',
      header: t('web.reseller_grant_kind_panel'),
      render: (row) => <span className="small">{grantsInWords(row.grants, ['PANEL'], names)}</span>,
    },
    {
      key: 'pricing',
      header: t('web.reseller_pricing'),
      render: (row) => (
        <PricingText
          label={TIER_PRICING_LABELS[row.pricingMode]}
          percent={row.discountPercentage}
        />
      ),
    },
    {
      key: 'minimum',
      header: t('web.reseller_minimum'),
      render: (row) =>
        row.monthlyMinimum === null || row.monthlyMinimum.amount === '0' ? (
          <span className="muted">{t('web.reseller_minimum_none')}</span>
        ) : (
          <Money value={limitWire(row.monthlyMinimum)} />
        ),
    },
    {
      key: 'actions',
      header: t('web.rule_actions'),
      align: 'end',
      render: (row) => (
        <RowActions>
          <Button
            size="sm"
            variant="ghost"
            icon="products"
            onClick={() => {
              setGrantsId(row.id);
              revealField('plans-panels');
            }}
          >
            {t('web.reseller_plans_edit_products')}
          </Button>
          {mayEdit && (
            <Button
              size="sm"
              variant="ghost"
              icon="target"
              onClick={() => {
                setMinimumId(row.id);
                revealField('plans-panels');
              }}
            >
              {t('web.reseller_minimum_edit')}
            </Button>
          )}
        </RowActions>
      ),
    },
  ];

  return (
    <>
      <PageHead
        title={t('web.reseller_plans_title')}
        subtitle={t('web.reseller_plans_intro')}
        maturity="now"
        actions={
          <>
            <a className="btn" href="/resellers" onClick={onLink}>
              <Icon name="resellers" />
              {t('web.nav_resellers')}
            </a>
            <a className="btn" href="/reseller-tiers" onClick={onLink}>
              <Icon name="layers" />
              {t('web.nav_reseller_tiers')}
            </a>
          </>
        }
      />

      <Card title={t('web.reseller_plans_tiers_title')} hint={t('web.reseller_plans_tiers_hint')}>
        <StateSwitch
          query={tiers}
          denied={denied}
          isEmpty={rows.length === 0}
          empty={
            <Empty
              title={t('web.reseller_tiers_empty')}
              hint={t('web.reseller_tiers_empty_hint')}
              icon="layers"
            />
          }
        >
          <DataTable
            caption={t('web.reseller_plans_tiers_title')}
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            rowClassName={(row) =>
              row.id === grantsId || row.id === minimumId ? 'selected' : undefined
            }
          />
        </StateSwitch>
        <p className="muted small">{t('web.reseller_plans_pricing_rule')}</p>
      </Card>

      <div id="plans-panels" className="tiers-anchor" tabIndex={-1} />

      {granting !== undefined &&
        (mayEdit ? (
          <GrantsEditor
            key={granting.id}
            tier={granting}
            options={options}
            names={names}
            onClose={() => setGrantsId(null)}
          />
        ) : (
          <Card title={`${t('web.reseller_grants_title')} — ${granting.name}`}>
            <p>{grantsInWords(granting.grants, RESELLER_GRANT_KINDS, names)}</p>
            <Banner tone="info">{t('web.reseller_tier_edit_denied')}</Banner>
            <Button size="sm" onClick={() => setGrantsId(null)}>
              {t('web.reseller_grants_close')}
            </Button>
          </Card>
        ))}

      {minimumTier !== undefined && mayEdit && (
        <TierMinimumForm
          key={minimumTier.id}
          tier={minimumTier}
          onDone={() => setMinimumId(null)}
        />
      )}

      {!denied && <MinimumProgressCard mayViewOrders={mayViewOrders} onOpenPolicy={setPolicyId} />}

      <div id="plans-policy" className="tiers-anchor" tabIndex={-1} />
      {!denied && policyId !== null && (
        <ResellerPolicyCard
          key={policyId}
          customerId={policyId}
          mayEdit={mayEdit}
          mayViewCatalog={mayViewCatalog}
          mayViewPanels={mayViewPanels}
          onClose={() => setPolicyId(null)}
        />
      )}

      <Card title={t('web.reseller_minimum_rules_title')} tone="muted">
        <ul className="cb-notes">
          <li>{t('web.reseller_minimum_rule_counts')}</li>
          <li>{t('web.reseller_minimum_rule_period')}</li>
          <li>{t('web.reseller_minimum_rule_no_consequence')}</li>
          <li>{t('web.reseller_minimum_rule_notices')}</li>
          <li>{t('web.reseller_minimum_rule_mirza')}</li>
        </ul>
        <p>
          <a href="/features" onClick={onLink}>
            {t('web.reseller_minimum_features_link')}
          </a>
          {t('web.list_separator')}
          <a href="/settings" onClick={onLink}>
            {t('web.reseller_minimum_settings_link')}
          </a>
          {t('web.list_separator')}
          <a href="/resellers" onClick={onLink}>
            {t('web.reseller_tiers_resellers_link')}
          </a>
        </p>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// A tier's minimum
// ---------------------------------------------------------------------------

function MinimumMoneyFields({
  prefix,
  amount,
  currency,
  onAmount,
  onCurrency,
}: {
  prefix: string;
  amount: string;
  currency: CurrencyCode;
  onAmount: (value: string) => void;
  onCurrency: (value: CurrencyCode) => void;
}) {
  const currencies: readonly CurrencyCode[] = (
    SALES_CURRENCY_CODES as readonly CurrencyCode[]
  ).concat((SALES_CURRENCY_CODES as readonly string[]).includes(currency) ? [] : [currency]);
  return (
    <>
      <Field
        label={t('web.reseller_minimum_amount')}
        hint={t('web.reseller_minimum_amount_hint')}
        htmlFor={`${prefix}-amount`}
      >
        <input
          id={`${prefix}-amount`}
          dir="ltr"
          inputMode="numeric"
          value={amount}
          onChange={(event) => onAmount(event.target.value.trim())}
        />
      </Field>
      <Field label={t('web.discount_currency')} htmlFor={`${prefix}-currency`}>
        <select
          id={`${prefix}-currency`}
          value={currency}
          onChange={(event) => onCurrency(event.target.value as CurrencyCode)}
        >
          {currencies.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
      </Field>
    </>
  );
}

function TierMinimumForm({
  tier,
  onDone,
}: {
  tier: ResellerTierSummaryResponse;
  onDone: () => void;
}) {
  const notify = useToast();
  const queries = useQueryClient();
  const submission = useSubmissionKey();
  const [amount, setAmount] = useState(tier.monthlyMinimum?.amount ?? '0');
  const [currency, setCurrency] = useState<CurrencyCode>(
    tier.monthlyMinimum?.currency ?? SALES_CURRENCY_CODES[0],
  );
  const parsed = minimumAmountOf(amount);

  const save = useMutation({
    mutationFn: () => {
      if (parsed === null) throw new Error('unreachable: guarded by the submit button');
      const minimum = parsed === '0' ? null : { amount: parsed, currency };
      const idempotencyKey = submission.current({ id: tier.id, minimum });
      return setResellerTierMinimum({ id: tier.id, idempotencyKey, minimum });
    },
    onSuccess: () => {
      submission.settle();
      notify({ tone: 'ok', message: t('web.reseller_minimum_saved') });
      void queries.invalidateQueries({ queryKey: ['reseller-tiers'] });
      void queries.invalidateQueries({ queryKey: ['reseller-minimums'] });
      void queries.invalidateQueries({ queryKey: ['reseller-policy'] });
      void queries.invalidateQueries({ queryKey: ['reseller-tier-history'] });
      onDone();
    },
    onError: (error) => submission.settleOn(error),
  });

  return (
    <Card
      title={`${t('web.reseller_minimum_tier_title')} — ${tier.name}`}
      hint={t('web.reseller_minimum_tier_hint')}
    >
      <MinimumMoneyFields
        prefix={`tier-minimum-${tier.id}`}
        amount={amount}
        currency={currency}
        onAmount={setAmount}
        onCurrency={setCurrency}
      />
      {parsed === null && <Banner tone="warn">{t('web.reseller_minimum_problem')}</Banner>}
      <div className="form-actions">
        <Button size="sm" disabled={save.isPending} onClick={onDone}>
          {t('web.rule_cancel_edit')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          icon="check"
          disabled={parsed === null || save.isPending}
          onClick={() => save.mutate()}
        >
          {t('web.rule_save')}
        </Button>
      </div>
      {save.error !== null && <Banner tone="danger">{messageFor(save.error)}</Banner>}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Monthly progress
// ---------------------------------------------------------------------------

function ProgressBar({ basisPoints, reached }: { basisPoints: number; reached: boolean }) {
  const percent = progressPercentOf(basisPoints);
  return (
    <span className="cb-progress-cell">
      {/* The kit's SVG bar — geometry, not a style, for the CSP — floored like the figure. */}
      <Progress
        value={Math.min(100, percent)}
        max={100}
        label={t('web.reseller_minimum_progress')}
        tone={reached ? 'ok' : 'warn'}
      />
      <span className="num small">
        <Num value={percent} /> {t('web.unit_percent')}
      </span>
    </span>
  );
}

function ResellerName({ row }: { row: ResellerMinimumRow }) {
  const onLink = useLinkHandler();
  return (
    <a href={`/users/${encodeURIComponent(row.customerId)}`} onClick={onLink}>
      {row.displayName ?? <Ltr>{row.telegramUserId}</Ltr>}
    </a>
  );
}

function MinimumProgressCard({
  mayViewOrders,
  onOpenPolicy,
}: {
  mayViewOrders: boolean;
  onOpenPolicy: (customerId: string) => void;
}) {
  const [period, setPeriod] = useState<ResellerMinimumPeriod>('THIS_MONTH');
  const [filter, setFilter] = useState<ResellerMinimumFilter>('ALL');
  const report = useQuery({
    queryKey: ['reseller-minimums', period, filter],
    queryFn: () => fetchResellerMinimums({ period, filter }),
    enabled: mayViewOrders,
  });
  const data = report.data;
  const rows = data?.rows ?? [];

  const columns: readonly Column<ResellerMinimumRow>[] = [
    {
      key: 'reseller',
      header: t('web.reseller_customer'),
      render: (row) => <ResellerName row={row} />,
    },
    {
      key: 'tier',
      header: t('web.reseller_tier'),
      render: (row) => (
        <span>
          {row.tier.name}
          {row.status !== 'ACTIVE' && (
            <>
              {' '}
              <ResellerStatusBadge value={row.status} />
            </>
          )}
        </span>
      ),
    },
    {
      key: 'minimum',
      header: t('web.reseller_minimum'),
      render: (row) =>
        row.minimum === null ? (
          <span className="muted">{t('web.reseller_minimum_none')}</span>
        ) : (
          <div>
            <Money value={limitWire(row.minimum)} />
            <div className="muted small">{t(MINIMUM_SOURCE_LABELS[row.source])}</div>
          </div>
        ),
    },
    {
      key: 'achieved',
      header: t('web.reseller_minimum_achieved'),
      align: 'end',
      render: (row) => <Money value={limitWire(row.achieved)} />,
    },
    {
      key: 'remaining',
      header: t('web.reseller_minimum_remaining'),
      align: 'end',
      render: (row) =>
        row.remaining === null ? (
          <span className="faint">—</span>
        ) : (
          <Money value={limitWire(row.remaining)} />
        ),
    },
    {
      key: 'progress',
      header: t('web.reseller_minimum_progress'),
      render: (row) =>
        row.progressBasisPoints === null ? (
          <span className="faint">—</span>
        ) : (
          <ProgressBar basisPoints={row.progressBasisPoints} reached={row.state === 'ACHIEVED'} />
        ),
    },
    {
      key: 'state',
      header: t('web.status'),
      render: (row) => (
        <Badge tone={MINIMUM_STATE_TONES[row.state]} dot>
          {t(MINIMUM_STATE_LABELS[row.state])}
        </Badge>
      ),
    },
    {
      key: 'actions',
      header: t('web.rule_actions'),
      align: 'end',
      render: (row) => (
        <Button
          size="sm"
          variant="ghost"
          icon="shield"
          onClick={() => {
            onOpenPolicy(row.customerId);
            revealField('plans-policy');
          }}
        >
          {t('web.reseller_policy_open')}
        </Button>
      ),
    },
  ];

  return (
    <Card
      title={t('web.reseller_minimum_progress_title')}
      hint={t('web.reseller_minimum_progress_hint')}
    >
      {!mayViewOrders ? (
        <Banner tone="info">{t('web.reseller_minimum_progress_denied')}</Banner>
      ) : (
        <>
          <div className="filter-row">
            <ChipGroup label={t('web.reseller_minimum_period')}>
              {(['THIS_MONTH', 'PREVIOUS_MONTH'] as const).map((id) => (
                <FilterChip key={id} pressed={period === id} onClick={() => setPeriod(id)}>
                  {t(PERIOD_LABELS[id])}
                </FilterChip>
              ))}
            </ChipGroup>
            <ChipDivider />
            <ChipGroup label={t('web.status')}>
              {(['ALL', 'ACHIEVED', 'BELOW'] as const).map((id) => (
                <FilterChip key={id} pressed={filter === id} onClick={() => setFilter(id)}>
                  {t(FILTER_LABELS[id])}
                </FilterChip>
              ))}
            </ChipGroup>
          </div>
          {data !== undefined && (
            <>
              <KV
                items={[
                  [
                    t('web.reseller_minimum_period'),
                    <span key="p">
                      <Ltr>{data.period.startLocal}</Ltr> {t('web.reseller_minimum_period_to')}{' '}
                      <Ltr>{data.period.endLocalInclusive}</Ltr>
                    </span>,
                  ],
                  [t('web.reseller_minimum_timezone'), <Ltr key="z">{data.period.timezone}</Ltr>],
                ]}
              />
              {data.period.running && (
                <p className="muted small">{t('web.reseller_minimum_running')}</p>
              )}
              <div className="stat-grid cb-stat-row">
                <StatCard
                  label={t('web.reseller_minimum_state_achieved')}
                  value={<Num value={data.counts.achieved} />}
                />
                <StatCard
                  label={t('web.reseller_minimum_state_below')}
                  value={<Num value={data.counts.below} />}
                  {...(data.counts.below > 0 ? { tone: 'warn' as const } : {})}
                />
                <StatCard
                  label={t('web.reseller_minimum_state_none')}
                  value={<Num value={data.counts.noMinimum} />}
                />
                <StatCard
                  label={t('web.reseller_minimum_state_not_active')}
                  value={<Num value={data.counts.notActive} />}
                />
              </div>
              {data.truncated && <Banner tone="warn">{t('web.reseller_minimum_truncated')}</Banner>}
            </>
          )}
          <StateSwitch
            query={report}
            isEmpty={rows.length === 0}
            empty={<Empty title={t('web.reseller_minimum_empty')} icon="inbox" />}
          >
            <DataTable
              caption={t('web.reseller_minimum_progress_title')}
              columns={columns}
              rows={rows}
              rowKey={(row) => row.customerId}
              dense
            />
          </StateSwitch>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// One reseller's effective policy, and the override editor
// ---------------------------------------------------------------------------

type MinimumChoice = 'INHERIT' | 'NONE' | 'OWN';

export function ResellerPolicyCard({
  customerId,
  mayEdit,
  mayViewCatalog,
  mayViewPanels,
  onClose,
}: {
  customerId: string;
  mayEdit: boolean;
  mayViewCatalog: boolean;
  mayViewPanels: boolean;
  onClose?: () => void;
}) {
  const policy = useQuery({
    queryKey: ['reseller-policy', customerId],
    queryFn: () => fetchResellerPolicy(customerId),
  });
  const { options, names } = useGrantOptions({ catalogue: mayViewCatalog, panels: mayViewPanels });
  const data = policy.data?.policy;
  const [editing, setEditing] = useState(false);

  return (
    <Card
      title={t('web.reseller_policy_title')}
      hint={t('web.reseller_policy_hint')}
      {...(onClose === undefined
        ? {}
        : {
            actions: (
              <button type="button" className="btn sm" onClick={onClose}>
                {t('web.reseller_grants_close')}
              </button>
            ),
          })}
    >
      <StateSwitch query={policy}>
        {data !== undefined && (
          <>
            <KV
              items={[
                [t('web.reseller_tier'), data.tier.name],
                [t('web.status'), <ResellerStatusBadge key="s" value={data.status} />],
              ]}
            />
            {data.status !== 'ACTIVE' && (
              <Banner tone="warn">{t('web.reseller_policy_suspended')}</Banner>
            )}

            <h4>{t('web.reseller_policy_entitlements')}</h4>
            <DataTable
              caption={t('web.reseller_policy_entitlements')}
              rowKey={(row) => row.dimension}
              rows={data.dimensions}
              columns={[
                {
                  key: 'dimension',
                  header: t('web.reseller_policy_dimension'),
                  render: (row) => t(DIMENSION_LABELS[row.dimension]),
                },
                {
                  key: 'tier',
                  header: t('web.reseller_policy_tier_value'),
                  render: (row) => (
                    <span className="small">
                      {grantsInWords(row.tierGrants, kindsOf(row.dimension), names)}
                    </span>
                  ),
                },
                {
                  key: 'override',
                  header: t('web.reseller_policy_override_value'),
                  render: (row) =>
                    row.overrideGrants === null ? (
                      <span className="muted">{t('web.reseller_policy_inherited')}</span>
                    ) : (
                      <span className="small">
                        {grantsInWords(row.overrideGrants, kindsOf(row.dimension), names)}
                      </span>
                    ),
                },
                {
                  key: 'effective',
                  header: t('web.reseller_policy_effective_value'),
                  render: (row) => (
                    <span className="small">
                      <strong>
                        {grantsInWords(row.effectiveGrants, kindsOf(row.dimension), names)}
                      </strong>{' '}
                      <Badge tone={row.source === 'RESELLER' ? 'violet' : 'neutral'}>
                        {t(
                          row.source === 'RESELLER'
                            ? 'web.reseller_policy_source_own'
                            : 'web.reseller_policy_source_tier',
                        )}
                      </Badge>
                    </span>
                  ),
                },
              ]}
            />

            <h4>{t('web.reseller_pricing')}</h4>
            <KV
              items={[
                [
                  t('web.reseller_policy_tier_value'),
                  <PricingText
                    key="t"
                    label={TIER_PRICING_LABELS[data.pricing.tierMode]}
                    percent={data.pricing.tierPercent}
                  />,
                ],
                [
                  t('web.reseller_policy_override_value'),
                  <PricingText
                    key="o"
                    label={OVERRIDE_LABELS[data.pricing.overrideMode]}
                    percent={data.pricing.overridePercent}
                  />,
                ],
                [
                  t('web.reseller_policy_effective_value'),
                  <span key="e">
                    {t(LAYER_LABELS[data.pricing.layer])}
                    {data.pricing.percent !== null && (
                      <>
                        {' '}
                        <Ltr>{String(data.pricing.percent)}</Ltr> {t('web.discount_percent_unit')}
                      </>
                    )}
                  </span>,
                ],
              ]}
            />
            <p className="muted small">{t('web.reseller_policy_pricing_note')}</p>

            <h4>{t('web.reseller_minimum')}</h4>
            <KV
              items={[
                [
                  t('web.reseller_policy_tier_value'),
                  data.monthlyMinimum.tier === null || data.monthlyMinimum.tier.amount === '0' ? (
                    t('web.reseller_minimum_none')
                  ) : (
                    <Money key="t" value={limitWire(data.monthlyMinimum.tier)} />
                  ),
                ],
                [
                  t('web.reseller_policy_override_value'),
                  data.monthlyMinimum.own === null ? (
                    t('web.reseller_policy_inherited')
                  ) : data.monthlyMinimum.own.amount === '0' ? (
                    t('web.reseller_minimum_own_none')
                  ) : (
                    <Money key="o" value={limitWire(data.monthlyMinimum.own)} />
                  ),
                ],
                [
                  t('web.reseller_policy_effective_value'),
                  data.monthlyMinimum.effective === null ? (
                    t('web.reseller_minimum_none')
                  ) : (
                    <span key="e">
                      <Money value={limitWire(data.monthlyMinimum.effective)} />{' '}
                      <span className="muted small">
                        {t(MINIMUM_SOURCE_LABELS[data.monthlyMinimum.source])}
                      </span>
                    </span>
                  ),
                ],
              ]}
            />

            <h4>{t('web.reseller_policy_products')}</h4>
            {/*
              Null: the server omitted the section because this operator does not hold
              `catalog.view`. Said as a missing permission, never drawn as "no products".
            */}
            {data.products === null ? (
              <Banner tone="info">{t('web.reseller_policy_products_denied')}</Banner>
            ) : (
              <p className="muted small">{t(BOT_BASIS_LABELS[data.botBasis])}</p>
            )}
            {data.products !== null && !data.productsComplete && (
              <Banner tone="info">{t('web.reseller_policy_products_partial')}</Banner>
            )}
            {data.products === null ? null : data.products.length === 0 ? (
              <Empty title={t('web.reseller_policy_products_empty')} icon="inbox" />
            ) : (
              <DataTable
                caption={t('web.reseller_policy_products')}
                rowKey={(row) => row.productId}
                rows={data.products}
                columns={[
                  {
                    key: 'title',
                    header: t('web.reseller_grant_kind_product'),
                    render: (row) => row.title,
                  },
                  {
                    key: 'allowed',
                    header: t('web.reseller_policy_can_sell'),
                    render: (row) =>
                      row.allowed ? (
                        <Badge tone="ok">{t('web.reseller_policy_allowed')}</Badge>
                      ) : (
                        <span>
                          <Badge tone="danger">{t('web.reseller_policy_refused')}</Badge>{' '}
                          <span className="muted small">
                            {row.refusedDimension === null
                              ? null
                              : t(DIMENSION_LABELS[row.refusedDimension])}
                          </span>
                        </span>
                      ),
                  },
                ]}
              />
            )}

            {mayEdit ? (
              editing ? (
                <OverrideEditor
                  policy={data}
                  options={options}
                  names={names}
                  onDone={() => setEditing(false)}
                />
              ) : (
                <div className="form-actions">
                  <button type="button" className="btn sm" onClick={() => setEditing(true)}>
                    {t('web.reseller_policy_edit')}
                  </button>
                </div>
              )
            ) : (
              <Banner tone="info">{t('web.reseller_edit_denied')}</Banner>
            )}
          </>
        )}
      </StateSwitch>
    </Card>
  );
}

function OverrideEditor({
  policy,
  options,
  names,
  onDone,
}: {
  policy: ResellerPolicy;
  options: ReturnType<typeof useGrantOptions>['options'];
  names: ReadonlyMap<string, string>;
  onDone: () => void;
}) {
  const notify = useToast();
  const queries = useQueryClient();
  const grantsSubmission = useSubmissionKey();
  const minimumSubmission = useSubmissionKey();

  // Each dimension starts from what applies now: the override when there is one, else the
  // tier's grants, so choosing "own" begins from the inherited value rather than from nothing.
  const [state, setState] = useState<GrantsState>(() =>
    grantsStateOf(policy.dimensions.flatMap((d) => d.overrideGrants ?? d.tierGrants)),
  );
  const [own, setOwn] = useState<ReadonlySet<ResellerEntitlementDimension>>(
    () => new Set(policy.dimensions.filter((d) => d.source === 'RESELLER').map((d) => d.dimension)),
  );
  const typedKinds = new Set(RESELLER_GRANT_KINDS.filter((kind) => options[kind] === null));
  const checked = overridesBodyFrom(state, own, typedKinds);
  const problem = 'problem' in checked ? checked.problem : null;

  const initialMinimum: MinimumChoice =
    policy.monthlyMinimum.own === null
      ? 'INHERIT'
      : policy.monthlyMinimum.own.amount === '0'
        ? 'NONE'
        : 'OWN';
  const [minimumChoice, setMinimumChoice] = useState<MinimumChoice>(initialMinimum);
  const [amount, setAmount] = useState(
    policy.monthlyMinimum.own !== null && policy.monthlyMinimum.own.amount !== '0'
      ? policy.monthlyMinimum.own.amount
      : '',
  );
  const [currency, setCurrency] = useState<CurrencyCode>(
    policy.monthlyMinimum.own?.currency ??
      policy.monthlyMinimum.tier?.currency ??
      SALES_CURRENCY_CODES[0],
  );
  const parsedAmount = minimumAmountOf(amount);
  const minimumProblem = minimumChoice === 'OWN' && (parsedAmount === null || parsedAmount === '0');

  const invalidate = () => {
    void queries.invalidateQueries({ queryKey: ['reseller-policy', policy.customerId] });
    void queries.invalidateQueries({ queryKey: ['reseller-minimums'] });
    void queries.invalidateQueries({ queryKey: ['reseller-history', policy.customerId] });
  };

  const saveGrants = useMutation({
    mutationFn: () => {
      if ('problem' in checked) throw new Error('unreachable: guarded by the submit button');
      const idempotencyKey = grantsSubmission.current({
        customerId: policy.customerId,
        overrides: checked.overrides,
      });
      return replaceResellerOverrides({
        customerId: policy.customerId,
        idempotencyKey,
        overrides: checked.overrides,
      });
    },
    onSuccess: (response) => {
      grantsSubmission.settle();
      queries.setQueryData(['reseller-policy', policy.customerId], response);
      notify({ tone: 'ok', message: t('web.reseller_policy_saved') });
      invalidate();
    },
    onError: (error) => grantsSubmission.settleOn(error),
  });

  const saveMinimum = useMutation({
    mutationFn: () => {
      const minimum =
        minimumChoice === 'INHERIT'
          ? null
          : minimumChoice === 'NONE'
            ? { amount: '0', currency }
            : { amount: parsedAmount ?? '0', currency };
      const idempotencyKey = minimumSubmission.current({ customerId: policy.customerId, minimum });
      return setResellerMinimum({ customerId: policy.customerId, idempotencyKey, minimum });
    },
    onSuccess: () => {
      minimumSubmission.settle();
      notify({ tone: 'ok', message: t('web.reseller_minimum_saved') });
      invalidate();
    },
    onError: (error) => minimumSubmission.settleOn(error),
  });

  return (
    <div className="form-section">
      <h4>{t('web.reseller_policy_edit_title')}</h4>
      <p className="muted small">{t('web.reseller_policy_edit_hint')}</p>
      {RESELLER_ENTITLEMENT_DIMENSIONS.map((dimension) => (
        <fieldset key={dimension} className="field">
          <legend>{t(DIMENSION_LABELS[dimension])}</legend>
          {(['INHERIT', 'OWN'] as const).map((choice) => (
            <label key={choice} className="nowrap">
              <input
                type="radio"
                name={`override-${dimension}`}
                checked={(choice === 'OWN') === own.has(dimension)}
                onChange={() =>
                  setOwn((current) => {
                    const next = new Set(current);
                    if (choice === 'OWN') next.add(dimension);
                    else next.delete(dimension);
                    return next;
                  })
                }
              />{' '}
              {t(
                choice === 'OWN'
                  ? 'web.reseller_policy_choice_own'
                  : 'web.reseller_policy_choice_inherit',
              )}
            </label>
          ))}
          {own.has(dimension) &&
            kindsOf(dimension).map((kind) => (
              <KindEditor
                key={kind}
                kind={kind}
                entry={state[kind]}
                options={options[kind]}
                names={names}
                onChange={(next) => setState((current) => ({ ...current, [kind]: next }))}
              />
            ))}
        </fieldset>
      ))}
      {problem !== null && <Banner tone="warn">{t(problem)}</Banner>}
      <div className="form-actions">
        <button
          type="button"
          className="btn primary sm"
          disabled={problem !== null || saveGrants.isPending}
          onClick={() => saveGrants.mutate()}
        >
          {t('web.reseller_policy_save')}
        </button>
      </div>
      {saveGrants.error !== null && <Banner tone="danger">{messageFor(saveGrants.error)}</Banner>}

      <fieldset className="field">
        <legend>{t('web.reseller_minimum')}</legend>
        {(['INHERIT', 'NONE', 'OWN'] as const).map((choice) => (
          <label key={choice} className="nowrap">
            <input
              type="radio"
              name="override-minimum"
              checked={minimumChoice === choice}
              onChange={() => setMinimumChoice(choice)}
            />{' '}
            {t(
              choice === 'INHERIT'
                ? 'web.reseller_minimum_choice_inherit'
                : choice === 'NONE'
                  ? 'web.reseller_minimum_choice_none'
                  : 'web.reseller_minimum_choice_own',
            )}
          </label>
        ))}
        {minimumChoice === 'OWN' && (
          <MinimumMoneyFields
            prefix={`reseller-minimum-${policy.customerId}`}
            amount={amount}
            currency={currency}
            onAmount={setAmount}
            onCurrency={setCurrency}
          />
        )}
      </fieldset>
      {minimumProblem && <Banner tone="warn">{t('web.reseller_minimum_problem_own')}</Banner>}
      <div className="form-actions">
        <button
          type="button"
          className="btn primary sm"
          disabled={minimumProblem || saveMinimum.isPending}
          onClick={() => saveMinimum.mutate()}
        >
          {t('web.reseller_minimum_save')}
        </button>
        <button type="button" className="btn sm" onClick={onDone}>
          {t('web.rule_cancel_edit')}
        </button>
      </div>
      {saveMinimum.error !== null && <Banner tone="danger">{messageFor(saveMinimum.error)}</Banner>}
    </div>
  );
}
