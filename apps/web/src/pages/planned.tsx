import { t, type WebKey } from '../i18n/web.fa';
import { Card, MaturityBadge, PageHead } from '../ui/kit';
import { Icon } from '../ui/icons';

/**
 * The surfaces the product will have and this release does not.
 *
 * `/users` was here and is not any more: Phase 4A built it, so it renders a real
 * list of real customers and the entry was REMOVED rather than left behind a
 * dead path. A planned page still listed for a route that now resolves
 * elsewhere is unreachable prose claiming the capability is unbuilt.
 *
 * Eight of the fifteen areas in the owner's route inventory have no backend at
 * all: there is no service, order, product, payment, wallet,
 * reseller, discount or report endpoint, and no bot-management surface. This page
 * is what those routes render.
 *
 * It draws NO control. Not a disabled button, not a greyed table with sample
 * rows, not a search box that returns nothing. A disabled control still says
 * "this exists and you lack permission", which is a different and false claim;
 * an empty table says "you have none of these", which is also false. What the
 * page says instead is what is true: the capability is not built, here is what
 * it will do, and here are the decisions already fixed for it.
 *
 * The `decisions` list is not decoration. Each entry is an owner revision that
 * this release cannot yet enforce in code, recorded where the person who builds
 * the surface will find it — because a rule with nowhere to live is a rule that
 * gets rediscovered the expensive way.
 */

export interface PlannedSurface {
  readonly key: string;
  readonly path: string;
  readonly label: WebKey;
  readonly summary: WebKey;
  /** What has to exist on the server before this route can do anything. */
  readonly missing: readonly WebKey[];
  /** Owner decisions already fixed for this surface. */
  readonly decisions: readonly WebKey[];
}

export const PLANNED_SURFACES: readonly PlannedSurface[] = [
  {
    key: 'services',
    path: '/services',
    label: 'web.nav_services',
    summary: 'web.planned_services_summary',
    missing: ['web.planned_missing_service', 'web.planned_missing_provisioning'],
    decisions: [
      'web.planned_services_no_protocol',
      'web.planned_services_ordering',
      'web.planned_services_plan_filter',
    ],
  },
  {
    key: 'payments',
    path: '/payments',
    label: 'web.nav_payments',
    summary: 'web.planned_payments_summary',
    missing: ['web.planned_missing_payment', 'web.planned_missing_gateway'],
    decisions: [
      'web.planned_payments_expiry',
      'web.planned_payments_refund',
      'web.planned_payments_no_receipts',
    ],
  },
  {
    key: 'discounts',
    path: '/discounts',
    label: 'web.nav_discounts',
    summary: 'web.planned_discounts_summary',
    missing: ['web.planned_missing_catalog', 'web.planned_missing_pricing'],
    decisions: [],
  },
  {
    key: 'resellers',
    path: '/resellers',
    label: 'web.nav_resellers',
    summary: 'web.planned_resellers_summary',
    missing: ['web.planned_missing_reseller', 'web.planned_missing_wallet'],
    decisions: [],
  },
  {
    key: 'reports',
    path: '/reports',
    label: 'web.nav_reports',
    summary: 'web.planned_reports_summary',
    missing: ['web.planned_missing_order', 'web.planned_missing_ledger'],
    decisions: ['web.planned_reports_no_logs'],
  },
  {
    key: 'bots',
    path: '/bots',
    label: 'web.nav_bots',
    summary: 'web.planned_bots_summary',
    missing: ['web.planned_missing_bot_runtime'],
    decisions: ['web.planned_bots_add_flow'],
  },
];

export type PlannedKey = (typeof PLANNED_SURFACES)[number]['key'];

export function PlannedPage({ surface }: { surface: PlannedKey }) {
  const found = PLANNED_SURFACES.find((candidate) => candidate.key === surface);
  if (found === undefined) return null;

  return (
    <div className="planned-page">
      <PageHead title={t(found.label)} subtitle={t(found.summary)} maturity="planned" />

      <Card title={t('web.planned_why_title')} hint={t('web.planned_why_hint')}>
        <div className="planned-why">
          {found.missing.map((key) => (
            <div key={key}>
              <Icon name="database" size={15} className="ico" />
              <span>{t(key)}</span>
            </div>
          ))}
        </div>
      </Card>

      {found.decisions.length > 0 && (
        <Card title={t('web.planned_decided_title')} hint={t('web.planned_decided_hint')}>
          <div className="planned-why">
            {found.decisions.map((key) => (
              <div key={key}>
                <Icon name="check" size={15} className="ico" />
                <span>{t(key)}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card title={t('web.planned_status_title')}>
        <p className="muted small">
          <MaturityBadge value="planned" /> {t('web.planned_status_body')}
        </p>
      </Card>
    </div>
  );
}
