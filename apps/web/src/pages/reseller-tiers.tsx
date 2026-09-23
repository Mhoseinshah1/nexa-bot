import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PANEL_PAGE_MAX,
  PRODUCT_PAGE_MAX,
  RESELLER_ENTITLEMENT_DIMENSIONS,
  RESELLER_GRANTABLE_OPERATIONS,
  RESELLER_GRANT_KINDS,
  RESELLER_PRICING_MODES,
  RESELLER_TIER_GRANTS_MAX,
  RESELLER_TIER_NAME_MAX,
  SALES_CURRENCY_CODES,
  uuidV7Schema,
  type CurrencyCode,
  type ResellerEntitlementDimension,
  type ResellerGrantKind,
  type ResellerPricingMode,
  type ResellerTierGrant,
  type ResellerTierSummaryResponse,
  type ResellerTierWriteRequest,
} from '@nexa/contracts';
import {
  createResellerTier,
  fetchPanels,
  fetchProductCategories,
  fetchProducts,
  fetchResellerTiers,
  replaceResellerTierGrants,
  updateResellerTier,
} from '../api/client';
import { useSubmissionKey } from '../submission-key';
import { queryState } from '../view-state';
import { t, type WebKey } from '../i18n/web.fa';
import { useLinkHandler } from '../router';
import { messageFor } from './settings';
import { PURPOSE_LABELS } from './discounts';
import {
  PricingText,
  TIER_PRICING_LABELS,
  creditAmountOf,
  limitWire,
  percentOf,
} from './resellers';
import {
  Badge,
  Banner,
  Card,
  Copyable,
  DataTable,
  Empty,
  Field,
  Money,
  Num,
  PageHead,
  StateSwitch,
  useToast,
  type Column,
} from '../ui/kit';

/**
 * Reseller tiers and what each one grants (WP9-B, `docs/wp9-reseller-audit.md` R2, R5).
 *
 * A tier is a name, a pricing policy and a credit policy, edited in place and never
 * deleted while referenced — there is no delete here because the server has none. Its
 * GRANTS are the entitlements, and they fail CLOSED per kind: a kind with no row grants
 * nothing of that kind, so a new tier lets its resellers buy nothing until an operator
 * says what. This page draws that absence as a refusal, in red, rather than as an empty
 * cell an operator might read as "unrestricted".
 *
 * A reseller may buy only when four things hold together: the operation is granted, the
 * product or its category is, the product's panel is, and the bot the purchase arrives
 * through is. The editor says which of the four a tier still blocks.
 *
 * `resellers.view` reads; `resellers.edit` writes a tier or replaces its grants. The
 * pickers read the catalogue (`catalog.view`) and the fleet (`panels.view`) the same way
 * the discount page does — a select ONLY when the list is complete and readable, a typed
 * id otherwise. Bots have no list endpoint in the Web Admin, so a bot is always an id.
 */

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

export const GRANT_KIND_LABELS: Readonly<Record<ResellerGrantKind, WebKey>> = {
  PRODUCT: 'web.reseller_grant_kind_product',
  CATEGORY: 'web.reseller_grant_kind_category',
  PANEL: 'web.reseller_grant_kind_panel',
  BOT: 'web.reseller_grant_kind_bot',
  OPERATION: 'web.reseller_grant_kind_operation',
};

const GRANT_KIND_HINTS: Readonly<Record<ResellerGrantKind, WebKey>> = {
  PRODUCT: 'web.reseller_grant_hint_product',
  CATEGORY: 'web.reseller_grant_hint_category',
  PANEL: 'web.reseller_grant_hint_panel',
  BOT: 'web.reseller_grant_hint_bot',
  OPERATION: 'web.reseller_grant_hint_operation',
};

const DIMENSION_LABELS: Readonly<Record<ResellerEntitlementDimension, WebKey>> = {
  OPERATION: 'web.reseller_dimension_operation',
  CATALOGUE: 'web.reseller_dimension_catalogue',
  PANEL: 'web.reseller_dimension_panel',
  BOT: 'web.reseller_dimension_bot',
};

// ---------------------------------------------------------------------------
// Grants: the editor's state, the body it sends, and what it still blocks
// ---------------------------------------------------------------------------

/** Nothing of the kind, every subject of it, or the ones named. */
export type GrantMode = 'NONE' | 'ALL' | 'SOME';

export interface KindGrants {
  readonly mode: GrantMode;
  /** The chosen subjects, when they are picked from a list. */
  readonly subjects: readonly string[];
  /** The chosen subjects, when they are typed: one id per line. */
  readonly typed: string;
}

export type GrantsState = Readonly<Record<ResellerGrantKind, KindGrants>>;

/**
 * The editor's state from what the server holds.
 *
 * A null subject is "every subject of this kind", and it wins over any named one beside
 * it — the entitlement evaluator reads it that way too. No row is `NONE`, never "all".
 */
export function grantsStateOf(grants: readonly ResellerTierGrant[]): GrantsState {
  const entry = (kind: ResellerGrantKind): KindGrants => {
    const rows = grants.filter((grant) => grant.kind === kind);
    const subjects = rows.flatMap((grant) => (grant.subject === null ? [] : [grant.subject]));
    if (rows.some((grant) => grant.subject === null)) {
      return { mode: 'ALL', subjects: [], typed: '' };
    }
    if (subjects.length === 0) return { mode: 'NONE', subjects: [], typed: '' };
    return { mode: 'SOME', subjects, typed: subjects.join('\n') };
  };
  return {
    PRODUCT: entry('PRODUCT'),
    CATEGORY: entry('CATEGORY'),
    PANEL: entry('PANEL'),
    BOT: entry('BOT'),
    OPERATION: entry('OPERATION'),
  };
}

function isValidSubject(kind: ResellerGrantKind, subject: string): boolean {
  return kind === 'OPERATION'
    ? (RESELLER_GRANTABLE_OPERATIONS as readonly string[]).includes(subject)
    : uuidV7Schema.safeParse(subject).success;
}

/**
 * The grants body, or what is wrong with it.
 *
 * `typedKinds` names the kinds whose subjects were TYPED because no complete list could
 * be offered; the others were ticked. Deterministic — kinds in the contract's order,
 * subjects sorted and unique — so the same set is the same payload and therefore the
 * same idempotency fingerprint, whatever order it was ticked in.
 *
 * `NONE` sends nothing for its kind, and that is the refusal: the server reads "no row"
 * as "grants nothing". `ALL` sends one row with a null subject.
 */
export function grantsBodyFrom(
  state: GrantsState,
  typedKinds: ReadonlySet<ResellerGrantKind>,
): { grants: ResellerTierGrant[] } | { problem: WebKey } {
  const grants: ResellerTierGrant[] = [];
  for (const kind of RESELLER_GRANT_KINDS) {
    const entry = state[kind];
    if (entry.mode === 'NONE') continue;
    if (entry.mode === 'ALL') {
      grants.push({ kind, subject: null });
      continue;
    }
    const raw = typedKinds.has(kind)
      ? entry.typed.split(/[\s,]+/u).filter((part) => part !== '')
      : [...entry.subjects];
    if (raw.length === 0) return { problem: 'web.reseller_grants_problem_empty' };
    if (raw.some((subject) => !isValidSubject(kind, subject))) {
      return { problem: 'web.reseller_grants_problem_id' };
    }
    for (const subject of [...new Set(raw)].sort()) grants.push({ kind, subject });
  }
  if (grants.length > RESELLER_TIER_GRANTS_MAX) {
    return { problem: 'web.reseller_grants_problem_too_many' };
  }
  return { grants };
}

/**
 * The entitlement dimensions a set of grants still refuses outright.
 *
 * The four the server checks together (R5): the operation; the product OR its category;
 * the panel; the bot. A dimension none of whose kinds grants anything refuses every
 * purchase, so a tier with any dimension here sells nothing at all.
 */
export function blockedDimensions(
  modes: Readonly<Record<ResellerGrantKind, GrantMode>>,
): ResellerEntitlementDimension[] {
  const none = (kind: ResellerGrantKind) => modes[kind] === 'NONE';
  const blocked: Record<ResellerEntitlementDimension, boolean> = {
    OPERATION: none('OPERATION'),
    CATALOGUE: none('PRODUCT') && none('CATEGORY'),
    PANEL: none('PANEL'),
    BOT: none('BOT'),
  };
  return RESELLER_ENTITLEMENT_DIMENSIONS.filter((dimension) => blocked[dimension]);
}

function modesOf(state: GrantsState): Record<ResellerGrantKind, GrantMode> {
  return {
    PRODUCT: state.PRODUCT.mode,
    CATEGORY: state.CATEGORY.mode,
    PANEL: state.PANEL.mode,
    BOT: state.BOT.mode,
    OPERATION: state.OPERATION.mode,
  };
}

/** The badge a kind wears: red for nothing, green for everything, a count otherwise. */
function KindBadge({ entry, count }: { entry: GrantMode; count: number }) {
  if (entry === 'NONE') return <Badge tone="danger">{t('web.reseller_grant_none')}</Badge>;
  if (entry === 'ALL') return <Badge tone="ok">{t('web.reseller_grant_all')}</Badge>;
  return (
    <Badge tone="info">
      <Num value={count} /> {t('web.reseller_grant_some_unit')}
    </Badge>
  );
}

function BlockedBanner({ blocked }: { blocked: readonly ResellerEntitlementDimension[] }) {
  if (blocked.length === 0) return null;
  return (
    <Banner tone="warn" title={t('web.reseller_grants_blocked_title')}>
      {blocked.map((dimension) => t(DIMENSION_LABELS[dimension])).join(t('web.list_separator'))}
    </Banner>
  );
}

// ---------------------------------------------------------------------------
// The pickers' options
// ---------------------------------------------------------------------------

interface Option {
  readonly id: string;
  readonly label: string;
}

/** Per kind: the complete list to tick from, or null when the subjects must be typed. */
type GrantOptions = Readonly<Record<ResellerGrantKind, readonly Option[] | null>>;

/**
 * The catalogue and the fleet, read only when the editor is open and the actor may read
 * them. A select ONLY when the list is complete — a picker that silently omits the
 * hundred-and-first product is worse than a box asking for an id — so a `nextCursor`, a
 * refusal or a failure all fall back to typing, and the field says why.
 */
function useGrantOptions(enabled: { catalogue: boolean; panels: boolean }): {
  options: GrantOptions;
  names: ReadonlyMap<string, string>;
} {
  const products = useQuery({
    queryKey: ['products', 'for-pricing'],
    queryFn: () => fetchProducts({ limit: PRODUCT_PAGE_MAX }),
    enabled: enabled.catalogue,
  });
  const categories = useQuery({
    queryKey: ['product-categories'],
    queryFn: () => fetchProductCategories(),
    enabled: enabled.catalogue,
  });
  const panels = useQuery({
    queryKey: ['panels', 'for-grants'],
    queryFn: () => fetchPanels({ limit: PANEL_PAGE_MAX }),
    enabled: enabled.panels,
  });

  const productRows = products.data?.products ?? [];
  const categoryRows = categories.data?.categories ?? [];
  const panelRows = panels.data?.panels ?? [];

  const complete = (query: Parameters<typeof queryState>[0], next: string | null | undefined) =>
    queryState(query) === 'ready' && (next ?? null) === null;

  return {
    options: {
      OPERATION: RESELLER_GRANTABLE_OPERATIONS.map((purpose) => ({
        id: purpose,
        label: t(PURPOSE_LABELS[purpose]),
      })),
      PRODUCT:
        enabled.catalogue && complete(products, products.data?.nextCursor)
          ? productRows.map((row) => ({ id: row.id, label: row.title }))
          : null,
      CATEGORY:
        enabled.catalogue && queryState(categories) === 'ready'
          ? categoryRows.map((row) => ({
              id: row.id,
              label: row.emoji === null ? row.name : `${row.emoji} ${row.name}`,
            }))
          : null,
      PANEL:
        enabled.panels && complete(panels, panels.data?.nextCursor)
          ? panelRows.map((row) => ({ id: row.id, label: row.name }))
          : null,
      // No bot list exists on the Web Admin's API, so a bot is always typed.
      BOT: null,
    },
    names: new Map<string, string>([
      ...productRows.map((row): [string, string] => [row.id, row.title]),
      ...categoryRows.map((row): [string, string] => [row.id, row.name]),
      ...panelRows.map((row): [string, string] => [row.id, row.name]),
      ...RESELLER_GRANTABLE_OPERATIONS.map((purpose): [string, string] => [
        purpose,
        t(PURPOSE_LABELS[purpose]),
      ]),
    ]),
  };
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export function ResellerTiersPage({
  denied,
  mayEdit,
  mayViewCatalog,
  mayViewPanels,
}: {
  /** No `resellers.view`: no list, and no form (edit opens from a row). */
  denied: boolean;
  /** `resellers.edit`. */
  mayEdit: boolean;
  /** `catalog.view` — whether the product and category pickers may ask for their lists. */
  mayViewCatalog: boolean;
  /** `panels.view` — whether the panel picker may ask for the fleet. */
  mayViewPanels: boolean;
}) {
  const onLink = useLinkHandler();
  const tiers = useQuery({
    queryKey: ['reseller-tiers'],
    queryFn: () => fetchResellerTiers(),
    enabled: !denied,
  });
  const rows = tiers.data?.tiers ?? [];

  /** Which tier's form, and which tier's grants, are open — by id, so a refetch shows. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [grantsId, setGrantsId] = useState<string | null>(null);
  const editing = rows.find((row) => row.id === editingId);
  const granting = rows.find((row) => row.id === grantsId);

  const { options, names } = useGrantOptions({
    catalogue: granting !== undefined && mayViewCatalog,
    panels: granting !== undefined && mayViewPanels,
  });

  const columns: readonly Column<ResellerTierSummaryResponse>[] = [
    {
      key: 'name',
      header: t('web.reseller_tier_name'),
      render: (row) => <strong>{row.name}</strong>,
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
      key: 'credit',
      header: t('web.reseller_credit_limit'),
      render: (row) => <Money value={limitWire(row.creditLimit)} />,
    },
    {
      key: 'count',
      header: t('web.reseller_tier_count'),
      render: (row) => <Num value={row.resellerCount} />,
    },
    {
      key: 'grants',
      header: t('web.reseller_grants'),
      render: (row) => <GrantsSummary grants={row.grants} />,
    },
    {
      key: 'actions',
      header: t('web.rule_actions'),
      align: 'end',
      render: (row) => (
        <div className="toolbar">
          {mayEdit && (
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                setEditingId(row.id);
              }}
            >
              {t('web.rule_edit')}
            </button>
          )}
          <button type="button" className="btn sm" onClick={() => setGrantsId(row.id)}>
            {t('web.reseller_grants_open')}
          </button>
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHead
        title={t('web.reseller_tiers_title')}
        subtitle={t('web.reseller_tiers_intro')}
        maturity="now"
      />

      <Card title={t('web.reseller_tiers_list_title')} hint={t('web.reseller_tiers_list_hint')}>
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
            caption={t('web.reseller_tiers_list_title')}
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
          />
        </StateSwitch>
      </Card>

      {granting !== undefined &&
        (mayEdit ? (
          // KEYED BY THE TIER: the editor's state is initialised from the tier now open.
          <GrantsEditor
            key={granting.id}
            tier={granting}
            options={options}
            names={names}
            onClose={() => setGrantsId(null)}
          />
        ) : (
          <GrantsReadOnly tier={granting} names={names} onClose={() => setGrantsId(null)} />
        ))}

      {denied ? null : !mayEdit ? (
        <Card title={t('web.reseller_tier_new_title')}>
          <Banner tone="info">{t('web.reseller_tier_edit_denied')}</Banner>
        </Card>
      ) : editing !== undefined ? (
        <TierForm key={editing.id} tier={editing} onDone={() => setEditingId(null)} />
      ) : (
        <TierForm onDone={() => undefined} />
      )}

      <Card title={t('web.reseller_tiers_scope_title')}>
        <p className="muted">{t('web.reseller_tiers_rule_deny')}</p>
        <p className="muted">{t('web.reseller_tiers_rule_four')}</p>
        <p className="muted">{t('web.reseller_tiers_rule_no_delete')}</p>
        <p className="muted">{t('web.reseller_tiers_rule_future')}</p>
        <p>
          <a href="/resellers" onClick={onLink}>
            {t('web.reseller_tiers_resellers_link')}
          </a>
        </p>
      </Card>
    </>
  );
}

/** Every kind, in one cell: what the tier grants of it, and whether it sells at all. */
function GrantsSummary({ grants }: { grants: readonly ResellerTierGrant[] }) {
  const state = grantsStateOf(grants);
  const blocked = blockedDimensions(modesOf(state));
  return (
    <div className="small">
      {RESELLER_GRANT_KINDS.map((kind) => (
        <div key={kind} className="nowrap">
          {t(GRANT_KIND_LABELS[kind])}:{' '}
          <KindBadge entry={state[kind].mode} count={state[kind].subjects.length} />
        </div>
      ))}
      {blocked.length > 0 && <div className="danger">{t('web.reseller_grants_sells_nothing')}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Grants — read-only, for `resellers.view` alone
// ---------------------------------------------------------------------------

function SubjectName({ id, names }: { id: string; names: ReadonlyMap<string, string> }) {
  const name = names.get(id);
  return name === undefined ? <Copyable value={id} /> : <Copyable value={id} display={name} />;
}

function GrantsReadOnly({
  tier,
  names,
  onClose,
}: {
  tier: ResellerTierSummaryResponse;
  names: ReadonlyMap<string, string>;
  onClose: () => void;
}) {
  const state = grantsStateOf(tier.grants);
  return (
    <Card
      title={`${t('web.reseller_grants_title')} — ${tier.name}`}
      actions={
        <button type="button" className="btn sm" onClick={onClose}>
          {t('web.reseller_grants_close')}
        </button>
      }
    >
      <BlockedBanner blocked={blockedDimensions(modesOf(state))} />
      {RESELLER_GRANT_KINDS.map((kind) => (
        <div key={kind} className="form-section">
          <strong>{t(GRANT_KIND_LABELS[kind])}</strong>{' '}
          <KindBadge entry={state[kind].mode} count={state[kind].subjects.length} />
          {state[kind].mode === 'NONE' && (
            <p className="muted small">{t('web.reseller_grant_none_hint')}</p>
          )}
          {state[kind].mode === 'SOME' && (
            <ul>
              {state[kind].subjects.map((subject) => (
                <li key={subject}>
                  <SubjectName id={subject} names={names} />
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      <Banner tone="info">{t('web.reseller_tier_edit_denied')}</Banner>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Grants — the editor
// ---------------------------------------------------------------------------

function GrantsEditor({
  tier,
  options,
  names,
  onClose,
}: {
  tier: ResellerTierSummaryResponse;
  options: GrantOptions;
  names: ReadonlyMap<string, string>;
  onClose: () => void;
}) {
  const notify = useToast();
  const queries = useQueryClient();
  const submission = useSubmissionKey();
  const [state, setState] = useState<GrantsState>(() => grantsStateOf(tier.grants));
  const setKind = (kind: ResellerGrantKind, next: KindGrants) =>
    setState((current) => ({ ...current, [kind]: next }));

  const typedKinds = new Set(RESELLER_GRANT_KINDS.filter((kind) => options[kind] === null));
  const checked = grantsBodyFrom(state, typedKinds);
  const problem = 'problem' in checked ? checked.problem : null;
  const blocked = blockedDimensions(modesOf(state));

  const save = useMutation({
    mutationFn: () => {
      if ('problem' in checked) throw new Error('unreachable: guarded by the submit button');
      const idempotencyKey = submission.current({ id: tier.id, grants: checked.grants });
      return replaceResellerTierGrants({ id: tier.id, grants: checked.grants, idempotencyKey });
    },
    onSuccess: () => {
      submission.settle();
      notify({ tone: 'ok', message: t('web.reseller_grants_saved') });
      void queries.invalidateQueries({ queryKey: ['reseller-tiers'] });
    },
    onError: (error) => submission.settleOn(error),
  });

  return (
    <Card
      title={`${t('web.reseller_grants_title')} — ${tier.name}`}
      hint={t('web.reseller_grants_hint')}
      actions={
        <button type="button" className="btn sm" onClick={onClose}>
          {t('web.reseller_grants_close')}
        </button>
      }
    >
      <BlockedBanner blocked={blocked} />

      {RESELLER_GRANT_KINDS.map((kind) => (
        <KindEditor
          key={kind}
          kind={kind}
          entry={state[kind]}
          options={options[kind]}
          names={names}
          onChange={(next) => setKind(kind, next)}
        />
      ))}

      {problem !== null && <Banner tone="warn">{t(problem)}</Banner>}
      <div className="toolbar">
        <button
          type="button"
          className="btn primary sm"
          disabled={problem !== null || save.isPending}
          onClick={() => save.mutate()}
        >
          {t('web.reseller_grants_save')}
        </button>
      </div>
      <p className="muted small">{t('web.reseller_grants_replace_note')}</p>
      {save.error !== null && <Banner tone="danger">{messageFor(save.error)}</Banner>}
    </Card>
  );
}

function KindEditor({
  kind,
  entry,
  options,
  names,
  onChange,
}: {
  kind: ResellerGrantKind;
  entry: KindGrants;
  /** The complete list to tick from, or null when the subjects are typed. */
  options: readonly Option[] | null;
  names: ReadonlyMap<string, string>;
  onChange: (next: KindGrants) => void;
}) {
  const id = `grants-${kind.toLowerCase()}`;
  /*
   * Stored subjects the list no longer offers — an archived panel, a product on a later
   * page — stay on screen, ticked, so saving does not silently drop a grant the operator
   * never saw.
   */
  const choices: readonly Option[] =
    options === null
      ? []
      : [
          ...options,
          ...entry.subjects
            .filter((subject) => !options.some((option) => option.id === subject))
            .map((subject) => ({ id: subject, label: names.get(subject) ?? subject })),
        ];

  return (
    <fieldset className="field">
      <legend>
        {t(GRANT_KIND_LABELS[kind])}{' '}
        <KindBadge
          entry={entry.mode}
          count={
            options === null
              ? entry.typed.split(/[\s,]+/u).filter((part) => part !== '').length
              : entry.subjects.length
          }
        />
      </legend>
      <p className="muted small">{t(GRANT_KIND_HINTS[kind])}</p>

      {(['NONE', 'ALL', 'SOME'] as const).map((mode) => (
        <label key={mode} className="nowrap">
          <input
            type="radio"
            name={id}
            value={mode}
            checked={entry.mode === mode}
            onChange={() => onChange({ ...entry, mode })}
          />{' '}
          {t(
            mode === 'NONE'
              ? 'web.reseller_grant_mode_none'
              : mode === 'ALL'
                ? 'web.reseller_grant_mode_all'
                : 'web.reseller_grant_mode_some',
          )}
        </label>
      ))}

      {entry.mode === 'NONE' && <p className="danger small">{t('web.reseller_grant_none_hint')}</p>}

      {entry.mode === 'SOME' &&
        (options === null ? (
          <Field
            label={t('web.reseller_grant_typed')}
            hint={t(
              kind === 'BOT' ? 'web.reseller_grant_typed_bot' : 'web.reseller_grant_typed_hint',
            )}
            htmlFor={`${id}-typed`}
          >
            <textarea
              id={`${id}-typed`}
              dir="ltr"
              rows={3}
              value={entry.typed}
              onChange={(event) => onChange({ ...entry, typed: event.target.value })}
            />
          </Field>
        ) : (
          <div>
            {choices.map((option) => (
              <label key={option.id} className="nowrap">
                <input
                  type="checkbox"
                  checked={entry.subjects.includes(option.id)}
                  onChange={(event) =>
                    onChange({
                      ...entry,
                      subjects: event.target.checked
                        ? [...entry.subjects, option.id]
                        : entry.subjects.filter((subject) => subject !== option.id),
                    })
                  }
                />{' '}
                {option.label}
              </label>
            ))}
            {choices.length === 0 && (
              <p className="muted small">{t('web.reseller_grant_no_choices')}</p>
            )}
          </div>
        ))}
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Create and edit a tier
// ---------------------------------------------------------------------------

export interface TierFormState {
  name: string;
  pricingMode: ResellerPricingMode;
  percent: string;
  limitAmount: string;
  limitCurrency: CurrencyCode;
}

const BLANK_TIER: TierFormState = {
  name: '',
  pricingMode: 'LIST_PRICE',
  percent: '',
  limitAmount: '0',
  limitCurrency: SALES_CURRENCY_CODES[0],
};

function tierStateOf(tier: ResellerTierSummaryResponse): TierFormState {
  return {
    name: tier.name,
    pricingMode: tier.pricingMode,
    percent: tier.discountPercentage === null ? '' : String(tier.discountPercentage),
    limitAmount: tier.creditLimit.amount,
    limitCurrency: tier.creditLimit.currency,
  };
}

/** The tier write body, or the field that is wrong — the contract's own refinements. */
export function tierBodyFrom(
  state: TierFormState,
): { body: Omit<ResellerTierWriteRequest, 'idempotencyKey'> } | { problem: WebKey } {
  const name = state.name.trim();
  if (name === '' || name.length > RESELLER_TIER_NAME_MAX) {
    return { problem: 'web.reseller_tier_problem_name' };
  }
  let discountPercentage: number | null = null;
  if (state.pricingMode === 'PERCENTAGE_DISCOUNT') {
    discountPercentage = percentOf(state.percent);
    if (discountPercentage === null) return { problem: 'web.reseller_problem_percent' };
  }
  const amount = creditAmountOf(state.limitAmount);
  if (amount === null) return { problem: 'web.reseller_problem_limit' };
  return {
    body: {
      name,
      pricingMode: state.pricingMode,
      discountPercentage,
      creditLimit: { amount, currency: state.limitCurrency },
    },
  };
}

function TierForm({ tier, onDone }: { tier?: ResellerTierSummaryResponse; onDone: () => void }) {
  const mode = tier === undefined ? 'create' : 'edit';
  const prefix = `tier-${mode}`;
  const notify = useToast();
  const queries = useQueryClient();
  const submission = useSubmissionKey();
  const [state, setState] = useState<TierFormState>(
    tier === undefined ? BLANK_TIER : tierStateOf(tier),
  );
  const set = <K extends keyof TierFormState>(key: K, value: TierFormState[K]) =>
    setState((current) => ({ ...current, [key]: value }));

  const checked = tierBodyFrom(state);
  const problem = 'problem' in checked ? checked.problem : null;

  const save = useMutation({
    mutationFn: () => {
      if ('problem' in checked) throw new Error('unreachable: guarded by the submit button');
      const idempotencyKey = submission.current({ id: tier?.id ?? null, ...checked.body });
      return tier === undefined
        ? createResellerTier({ ...checked.body, idempotencyKey })
        : updateResellerTier({ ...checked.body, id: tier.id, idempotencyKey });
    },
    onSuccess: () => {
      submission.settle();
      notify({
        tone: 'ok',
        message: mode === 'create' ? t('web.reseller_tier_created') : t('web.reseller_tier_saved'),
      });
      if (mode === 'create') setState(BLANK_TIER);
      void queries.invalidateQueries({ queryKey: ['reseller-tiers'] });
      // A reseller's effective limit may follow its tier's.
      void queries.invalidateQueries({ queryKey: ['resellers'] });
      void queries.invalidateQueries({ queryKey: ['customer-reseller'] });
      onDone();
    },
    onError: (error) => submission.settleOn(error),
  });

  const currencies: readonly CurrencyCode[] = (
    SALES_CURRENCY_CODES as readonly CurrencyCode[]
  ).concat(
    (SALES_CURRENCY_CODES as readonly string[]).includes(state.limitCurrency)
      ? []
      : [state.limitCurrency],
  );

  return (
    <Card
      title={
        mode === 'create' ? t('web.reseller_tier_new_title') : t('web.reseller_tier_edit_title')
      }
      hint={mode === 'create' ? t('web.reseller_tier_new_hint') : t('web.reseller_tier_edit_hint')}
    >
      <Field label={t('web.reseller_tier_name')} htmlFor={`${prefix}-name`}>
        <input
          id={`${prefix}-name`}
          value={state.name}
          maxLength={RESELLER_TIER_NAME_MAX}
          onChange={(event) => set('name', event.target.value)}
        />
      </Field>
      <Field label={t('web.reseller_pricing')} htmlFor={`${prefix}-pricing`}>
        <select
          id={`${prefix}-pricing`}
          value={state.pricingMode}
          onChange={(event) => set('pricingMode', event.target.value as ResellerPricingMode)}
        >
          {RESELLER_PRICING_MODES.map((one) => (
            <option key={one} value={one}>
              {t(TIER_PRICING_LABELS[one])}
            </option>
          ))}
        </select>
      </Field>
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
        label={t('web.reseller_limit_amount')}
        hint={t('web.reseller_tier_limit_hint')}
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

      {problem !== null && <Banner tone="warn">{t(problem)}</Banner>}
      <div className="toolbar">
        <button
          type="button"
          className="btn primary sm"
          disabled={problem !== null || save.isPending}
          onClick={() => save.mutate()}
        >
          {mode === 'create' ? t('web.reseller_tier_create') : t('web.rule_save')}
        </button>
        {mode === 'edit' && (
          <button type="button" className="btn sm" disabled={save.isPending} onClick={onDone}>
            {t('web.rule_cancel_edit')}
          </button>
        )}
      </div>
      {mode === 'create' && <p className="muted small">{t('web.reseller_tier_created_empty')}</p>}
      {save.error !== null && <Banner tone="danger">{messageFor(save.error)}</Banner>}
    </Card>
  );
}
