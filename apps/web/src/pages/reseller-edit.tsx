import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  RESELLER_OVERRIDE_MODES,
  RESELLER_STATUSES,
  type ResellerOverrideMode,
  type ResellerStatus,
  type ResellerSummaryResponse,
  type ResellerTierSummaryResponse,
  type ResellerUpdateRequest,
} from '@nexa/contracts';
import { fetchResellerPolicy, updateReseller } from '../api/client';
import { formatDate, formatNumber, formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { useLinkHandler } from '../router';
import { useSubmissionKey, type SubmissionKey } from '../submission-key';
import { CopyIdButton } from '../ui/record-ref';
import {
  Badge,
  Banner,
  Button,
  Card,
  DetailHead,
  Disclosure,
  Field,
  KV,
  Ltr,
  Money,
  StateSwitch,
  TabPanel,
  Tabs,
  useToast,
  useUnsavedChanges,
} from '../ui/kit';
import { useReportDirty } from '../ui/unsaved';
import { ErrorRef } from '../ui/technical-details';
import { messageFor } from './settings';
import { SaveBar } from './editor-layout';
import { ResellerExpiryCard } from './reseller-expiry';
import {
  OverrideGrantsEditor,
  OverrideMinimumEditor,
  PolicyEntitlements,
  PolicyMinimum,
  PolicyPricing,
  PolicyProductVerdicts,
  type PolicyKeys,
} from './reseller-plans';
import {
  ProductsTab,
  useAllProducts,
  useCategories,
  useProductDraft,
  type ProductDraft,
} from './reseller-products';
import { useGrantOptions } from './reseller-tiers';
import {
  ResellerBalanceCard,
  ResellerHistoryCard,
  ResellerPurchasesCard,
  useResellerCredit,
} from './reseller-standing';
import {
  OVERRIDE_LABELS,
  PricingText,
  RESELLER_STATUS_LABELS,
  ResellerCell,
  ResellerStatusBadge,
  TIER_PRICING_LABELS,
  initialOf,
  limitWire,
  resellerBodyFrom,
  stateOf,
  type ResellerFormState,
} from './resellers';

/**
 * One reseller's standing and edit form, reorganised into tabs (v0.9.5, PR-6).
 *
 * Nothing here is a new capability: every card and field was already on the page, in one
 * long column. The summary on top reads only what the API sends; each tab holds the former
 * sections that belong together; the form fields (tier, status, pricing, percent) keep their
 * single `PUT`, saved by ONE sticky Save/Cancel bar while the form is open for editing.
 *
 * The allowed-products tab saves through the override editor's own grant API, and says so
 * with its own bar: it is a different command with a different permission surface.
 */

type TabId = 'profile' | 'pricing' | 'credit' | 'expiry' | 'products' | 'danger';

const TAB_IDS: readonly TabId[] = [
  'profile',
  'pricing',
  'credit',
  'expiry',
  'products',
  'danger',
] as const;

const TAB_LABELS: Readonly<Record<TabId, WebKey>> = {
  profile: 'web.rs_tab_profile',
  pricing: 'web.rs_tab_pricing',
  credit: 'web.rs_tab_credit',
  expiry: 'web.rs_tab_expiry',
  products: 'web.rs_tab_products',
  danger: 'web.rs_tab_danger',
};

// ---------------------------------------------------------------------------
// The form: tier, status and pricing, one command
// ---------------------------------------------------------------------------

interface EditForm {
  readonly state: ResellerFormState;
  readonly set: <K extends keyof ResellerFormState>(key: K, value: ResellerFormState[K]) => void;
  readonly dirty: boolean;
  readonly problem: WebKey | null;
  readonly save: ReturnType<typeof useMutation<unknown, unknown, void>>;
}

function useResellerEditForm({
  row,
  editing,
  held,
  onDone,
}: {
  row: ResellerSummaryResponse | undefined;
  editing: boolean;
  held: SubmissionKey | undefined;
  onDone: () => void;
}): EditForm {
  const notify = useToast();
  const queries = useQueryClient();
  const own = useSubmissionKey();
  const submission = held ?? own;
  const base = row === undefined ? null : stateOf(row);
  /*
   * The draft is keyed: while the form is closed it follows the stored row, and opening it
   * starts from the row as it is then — so a second edit never begins from the first one's
   * abandoned draft, and a refetch after a save is not "unsaved".
   */
  const key = editing ? 'edit' : JSON.stringify(base);
  const [bag, setBag] = useState<{ key: string; state: ResellerFormState | null }>({
    key,
    state: base,
  });
  if (bag.key !== key) setBag({ key, state: base });
  const state: ResellerFormState = bag.state ?? {
    customerId: '',
    tierId: '',
    status: 'ACTIVE',
    pricingMode: 'TIER',
    percent: '',
  };
  const set = <K extends keyof ResellerFormState>(field: K, value: ResellerFormState[K]) => {
    setBag((current) => ({
      key: current.key,
      state: { ...state, [field]: value },
    }));
  };
  const dirty = editing && base !== null && JSON.stringify(state) !== JSON.stringify(base);
  const checked = resellerBodyFrom(state, 'update');
  const problem = 'problem' in checked ? checked.problem : null;

  const save = useMutation({
    mutationFn: () => {
      if ('problem' in checked || row === undefined) {
        throw new Error('unreachable: guarded by the submit button');
      }
      // Bound to the payload AND the customer, so a corrected field is a NEW command.
      const idempotencyKey = submission.current({ customerId: state.customerId, ...checked.body });
      return updateReseller({
        ...(checked.body as Omit<ResellerUpdateRequest, 'idempotencyKey'>),
        customerId: row.customerId,
        idempotencyKey,
      });
    },
    onSuccess: (response) => {
      submission.settle();
      notify({ tone: 'ok', message: t('web.reseller_saved') });
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
      void queries.invalidateQueries({
        queryKey: ['reseller-policy', response.reseller.customerId],
      });
      onDone();
    },
    // A 5xx may have committed. A fresh key on the next press would be a second command.
    onError: (error) => submission.settleOn(error),
  });

  return { state, set, dirty, problem, save: save as EditForm['save'] };
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export function ResellerStandingView({
  customerId,
  row,
  editing,
  tiers,
  mayEdit,
  mayViewWallet,
  mayViewOrders,
  mayViewAudit,
  mayViewCatalog,
  mayViewPanels,
  editKey,
  policyKeys,
  onStartEdit,
  onDone,
  onClose,
  onDirtyChange,
}: {
  customerId: string;
  /** The list row already held; absent once it has paged away. */
  row: ResellerSummaryResponse | undefined;
  /** The tier/status/pricing form is open. */
  editing: boolean;
  tiers: readonly ResellerTierSummaryResponse[] | null;
  mayEdit: boolean;
  mayViewWallet: boolean;
  mayViewOrders: boolean;
  mayViewAudit: boolean;
  mayViewCatalog: boolean;
  mayViewPanels: boolean;
  editKey: SubmissionKey;
  policyKeys: PolicyKeys;
  onStartEdit: () => void;
  /** Ends the edit (saved or cancelled). */
  onDone: () => void;
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [tab, setTab] = useState<TabId>('profile');
  const panelId = `reseller-tabs-${customerId}`;

  const policy = useQuery({
    queryKey: ['reseller-policy', customerId],
    queryFn: () => fetchResellerPolicy(customerId),
  });
  const policyData = policy.data?.policy;
  const products = useAllProducts(mayViewCatalog);
  const categories = useCategories(mayViewCatalog);
  const draft = useProductDraft(policyData, products.data);
  const form = useResellerEditForm({ row, editing, held: editKey, onDone });

  const unsaved = form.dirty || draft.dirty;
  useUnsavedChanges(unsaved);
  useReportDirty(unsaved, onDirtyChange);

  return (
    <>
      <Summary
        customerId={customerId}
        row={row}
        mayViewWallet={mayViewWallet}
        allowed={
          policyData === undefined || products.data === undefined || !products.data.complete
            ? null
            : {
                count: products.data.rows.filter((p) => draft.allowed.has(p.id)).length,
                total: products.data.rows.length,
              }
        }
        onClose={onClose}
      />

      <Tabs
        value={tab}
        onChange={setTab}
        panelId={panelId}
        items={TAB_IDS.map((id) => ({ id, label: t(TAB_LABELS[id]) }))}
      />
      <TabPanel id={panelId} labelledBy={`${panelId}-tab-${tab}`}>
        <div className="stack rs-panel">
          {tab === 'profile' && (
            <ProfileTab row={row} customerId={customerId} tiers={tiers} mayEdit={mayEdit} />
          )}
          {tab === 'pricing' && (
            <PricingTab
              form={form}
              editing={editing}
              row={row}
              tiers={tiers}
              policy={policyData}
              policyQuery={policy}
            />
          )}
          {tab === 'credit' && (
            <>
              <ResellerBalanceCard customerId={customerId} mayViewWallet={mayViewWallet} />
              <Card title={t('web.reseller_minimum')}>
                <StateSwitch query={policy}>
                  {policyData !== undefined && (
                    <>
                      <PolicyMinimum data={policyData} heading={false} />
                      {mayEdit ? (
                        <OverrideMinimumEditor held={policyKeys} policy={policyData} />
                      ) : (
                        <Banner tone="info">{t('web.reseller_edit_denied')}</Banner>
                      )}
                    </>
                  )}
                </StateSwitch>
              </Card>
              <ResellerPurchasesCard customerId={customerId} mayViewOrders={mayViewOrders} />
            </>
          )}
          {tab === 'expiry' && (
            <>
              <ResellerExpiryCard customerId={customerId} mayEdit={mayEdit} />
              <Card title={t('web.rs_status_title')}>
                <StateSwitch query={policy}>
                  {policyData !== undefined && (
                    <>
                      <KV
                        items={[
                          [t('web.reseller_tier'), policyData.tier.name],
                          [
                            t('web.status'),
                            <ResellerStatusBadge key="s" value={policyData.status} />,
                          ],
                        ]}
                      />
                      {policyData.status !== 'ACTIVE' && (
                        <Banner tone="warn">{t('web.reseller_policy_suspended')}</Banner>
                      )}
                    </>
                  )}
                </StateSwitch>
              </Card>
              <ResellerHistoryCard customerId={customerId} mayViewAudit={mayViewAudit} />
            </>
          )}
          {tab === 'products' && (
            <ProductsPanel
              customerId={customerId}
              policyQuery={policy}
              policyData={policyData}
              products={products}
              categories={categories.data?.categories ?? []}
              draft={draft}
              mayEdit={mayEdit}
              mayViewCatalog={mayViewCatalog}
              mayViewPanels={mayViewPanels}
              policyKeys={policyKeys}
            />
          )}
          {tab === 'danger' && (
            <DangerTab
              form={form}
              editing={editing}
              row={row}
              tiers={tiers}
              mayEdit={mayEdit}
              onStartEdit={onStartEdit}
            />
          )}
        </div>
      </TabPanel>

      {editing && (
        <div className="rs-foot">
          <SaveBar dirty={form.dirty}>
            <Button size="sm" disabled={form.save.isPending} onClick={onDone}>
              {t('web.rule_cancel_edit')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon="check"
              disabled={form.problem !== null || form.save.isPending}
              onClick={() => form.save.mutate()}
            >
              {t('web.rule_save')}
            </Button>
          </SaveBar>
          {form.problem !== null && <Banner tone="warn">{t(form.problem)}</Banner>}
          {form.save.error !== null && (
            <Banner tone="danger">
              {messageFor(form.save.error)}
              <ErrorRef error={form.save.error} />
            </Banner>
          )}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// The summary
// ---------------------------------------------------------------------------

/** Who, status, tier, balance, expiry and the allowed-products count — only what the API sends. */
function Summary({
  customerId,
  row,
  mayViewWallet,
  allowed,
  onClose,
}: {
  customerId: string;
  row: ResellerSummaryResponse | undefined;
  mayViewWallet: boolean;
  allowed: { count: number; total: number } | null;
  onClose: () => void;
}) {
  const credit = useResellerCredit(customerId, mayViewWallet);
  const standing = credit.data?.credit;
  const stats: { label: ReactNode; value: ReactNode }[] = [];
  if (row !== undefined) {
    stats.push(
      { label: t('web.reseller_pricing'), value: pricingOf(row) },
      {
        label: t('web.rs_summary_expiry'),
        value:
          row.expiresAt === null ? t('web.reseller_expiry_none') : formatTimestamp(row.expiresAt),
      },
    );
  }
  if (standing !== undefined) {
    stats.push({
      label: t('web.reseller_credit_balance'),
      value: (
        <Money
          value={limitWire({
            amount: standing.balance.amount,
            currency: standing.balance.currency,
          })}
        />
      ),
    });
    if (BigInt(standing.creditInUse.amount) > 0n) {
      stats.push({
        label: t('web.rs_summary_debt'),
        value: (
          <Money
            value={limitWire({
              amount: standing.creditInUse.amount,
              currency: standing.balance.currency,
            })}
          />
        ),
      });
    }
  }
  if (allowed !== null) {
    stats.push({
      label: t('web.rs_summary_products'),
      value: `${formatNumber(allowed.count)} ${t('web.progress_of')} ${formatNumber(allowed.total)}`,
    });
  }
  return (
    <DetailHead
      title={
        row === undefined ? (
          <CopyIdButton id={customerId} />
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
          })}
      stats={stats}
      actions={
        <Button size="sm" variant="ghost" icon="x" onClick={onClose}>
          {t('web.close')}
        </Button>
      }
    />
  );
}

function pricingOf(row: ResellerSummaryResponse): ReactNode {
  return <PricingText label={OVERRIDE_LABELS[row.pricingMode]} percent={row.discountPercentage} />;
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function ProfileTab({
  row,
  customerId,
  tiers,
  mayEdit,
}: {
  row: ResellerSummaryResponse | undefined;
  customerId: string;
  tiers: readonly ResellerTierSummaryResponse[] | null;
  mayEdit: boolean;
}) {
  const onLink = useLinkHandler();
  return (
    <Card title={t('web.rs_profile_title')}>
      {tiers !== null && tiers.length === 0 && (
        <Banner tone="warn">
          {t('web.reseller_no_tiers')}{' '}
          <a href="/reseller-tiers" onClick={onLink}>
            {t('web.resellers_tiers_link')}
          </a>
        </Banner>
      )}
      {row === undefined ? (
        <KV items={[[t('web.reseller_customer'), <CopyIdButton key="c" id={customerId} />]]} />
      ) : (
        <KV
          items={[
            [t('web.reseller_customer'), <ResellerCell key="c" reseller={row} />],
            [t('web.rs_profile_tier'), <Badge key="t">{row.tier.name}</Badge>],
            [t('web.status'), <ResellerStatusBadge key="s" value={row.status} />],
            // The day alone: the time of day a row was written is not a fact an operator uses.
            [t('web.rs_profile_registered'), formatDate(row.createdAt)],
          ]}
        />
      )}
      {!mayEdit && <Banner tone="info">{t('web.reseller_edit_denied')}</Banner>}
    </Card>
  );
}

function PricingTab({
  form,
  editing,
  row,
  tiers,
  policy,
  policyQuery,
}: {
  form: EditForm;
  editing: boolean;
  row: ResellerSummaryResponse | undefined;
  tiers: readonly ResellerTierSummaryResponse[] | null;
  policy: Parameters<typeof PolicyPricing>[0]['data'] | undefined;
  policyQuery: Parameters<typeof StateSwitch>[0]['query'];
}) {
  const tier = tiers?.find((candidate) => candidate.id === form.state.tierId);
  return (
    <>
      <Card title={t('web.rs_pricing_title')}>
        {editing ? (
          <>
            <Field
              label={t('web.reseller_pricing')}
              hint={t('web.reseller_pricing_hint')}
              htmlFor="reseller-update-pricing"
            >
              <select
                id="reseller-update-pricing"
                value={form.state.pricingMode}
                onChange={(event) =>
                  form.set('pricingMode', event.target.value as ResellerOverrideMode)
                }
              >
                {RESELLER_OVERRIDE_MODES.map((one) => (
                  <option key={one} value={one}>
                    {t(OVERRIDE_LABELS[one])}
                  </option>
                ))}
              </select>
            </Field>
            {form.state.pricingMode === 'TIER' && tier !== undefined && (
              <p className="muted small">
                {t('web.reseller_tier_pricing_now')}{' '}
                <PricingText
                  label={TIER_PRICING_LABELS[tier.pricingMode]}
                  percent={tier.discountPercentage}
                />
              </p>
            )}
            {form.state.pricingMode === 'PERCENTAGE_DISCOUNT' && (
              <Field
                label={t('web.reseller_percent')}
                hint={t('web.reseller_percent_hint')}
                htmlFor="reseller-update-percent"
              >
                <input
                  id="reseller-update-percent"
                  dir="ltr"
                  inputMode="numeric"
                  value={form.state.percent}
                  onChange={(event) => form.set('percent', event.target.value.trim())}
                />
              </Field>
            )}
          </>
        ) : (
          row !== undefined && <KV items={[[t('web.reseller_pricing'), pricingOf(row)]]} />
        )}
        <StateSwitch query={policyQuery}>
          {policy !== undefined && <PolicyPricing data={policy} heading={false} />}
        </StateSwitch>
      </Card>
    </>
  );
}

function ProductsPanel({
  customerId,
  policyQuery,
  policyData,
  products,
  categories,
  draft,
  mayEdit,
  mayViewCatalog,
  mayViewPanels,
  policyKeys,
}: {
  customerId: string;
  policyQuery: Parameters<typeof StateSwitch>[0]['query'];
  policyData: Parameters<typeof PolicyPricing>[0]['data'] | undefined;
  products: ReturnType<typeof useAllProducts>;
  categories: Parameters<typeof ProductsTab>[0]['categories'];
  draft: ProductDraft;
  mayEdit: boolean;
  mayViewCatalog: boolean;
  mayViewPanels: boolean;
  policyKeys: PolicyKeys;
}) {
  const { options, names } = useGrantOptions({ catalogue: mayViewCatalog, panels: mayViewPanels });
  return (
    <>
      <Card title={t('web.rs_products_title')}>
        {!mayViewCatalog ? (
          // Said as a missing permission, never drawn as "no products".
          <Banner tone="info">{t('web.reseller_policy_products_denied')}</Banner>
        ) : (
          <StateSwitch query={products}>
            {products.data !== undefined && policyData !== undefined && (
              <ProductsTab
                customerId={customerId}
                policy={policyData}
                products={products.data}
                categories={categories}
                draft={draft}
                mayEdit={mayEdit}
                held={policyKeys.grants}
              />
            )}
          </StateSwitch>
        )}
      </Card>
      <Card title={t('web.rs_access_title')} hint={t('web.rs_access_hint')}>
        <StateSwitch query={policyQuery}>
          {policyData !== undefined && (
            <>
              <PolicyEntitlements data={policyData} names={names} />
              {mayEdit ? (
                <OverrideGrantsEditor
                  held={policyKeys}
                  policy={policyData}
                  options={options}
                  names={names}
                  dimensions={['OPERATION', 'PANEL', 'BOT']}
                />
              ) : (
                <Banner tone="info">{t('web.reseller_edit_denied')}</Banner>
              )}
              {policyData.products !== null && (
                <Disclosure summary={t('web.rs_verdicts_summary')} size="sm">
                  <PolicyProductVerdicts data={policyData} />
                </Disclosure>
              )}
            </>
          )}
        </StateSwitch>
      </Card>
    </>
  );
}

function DangerTab({
  form,
  editing,
  row,
  tiers,
  mayEdit,
  onStartEdit,
}: {
  form: EditForm;
  editing: boolean;
  row: ResellerSummaryResponse | undefined;
  tiers: readonly ResellerTierSummaryResponse[] | null;
  mayEdit: boolean;
  onStartEdit: () => void;
}) {
  return (
    <Card tone="danger" title={t('web.rs_danger_title')} hint={t('web.rs_danger_hint')}>
      {editing ? (
        <>
          <Field
            label={t('web.status')}
            hint={t('web.reseller_status_hint')}
            htmlFor="reseller-update-status"
          >
            <select
              id="reseller-update-status"
              value={form.state.status}
              onChange={(event) => form.set('status', event.target.value as ResellerStatus)}
            >
              {RESELLER_STATUSES.map((one) => (
                <option key={one} value={one}>
                  {t(RESELLER_STATUS_LABELS[one])}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('web.reseller_tier')} htmlFor="reseller-update-tier">
            <select
              id="reseller-update-tier"
              value={form.state.tierId}
              onChange={(event) => form.set('tierId', event.target.value)}
            >
              <option value="" />
              {(tiers ?? []).map((one) => (
                <option key={one.id} value={one.id}>
                  {one.name}
                </option>
              ))}
            </select>
          </Field>
        </>
      ) : (
        <>
          {row !== undefined && (
            <KV
              items={[
                [t('web.status'), <ResellerStatusBadge key="s" value={row.status} />],
                [t('web.reseller_tier'), row.tier.name],
              ]}
            />
          )}
          {mayEdit ? (
            <>
              <p className="muted small">{t('web.rs_danger_readonly')}</p>
              <div className="form-actions">
                <Button size="sm" icon="edit" disabled={row === undefined} onClick={onStartEdit}>
                  {t('web.rs_danger_edit')}
                </Button>
              </div>
            </>
          ) : (
            <Banner tone="info">{t('web.reseller_edit_denied')}</Banner>
          )}
        </>
      )}
    </Card>
  );
}
