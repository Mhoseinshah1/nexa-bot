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
 * Two of the fifteen areas in the owner's route inventory still have no backend
 * at all: there is no report endpoint, and no bot-management surface. This page
 * is what those two routes render. The count is written out rather than derived
 * because it is a CLAIM — users in 4A, products and orders in 4B, payments in
 * 4C, services in 4H, discounts in WP8 and resellers in WP9-B each had to change
 * this sentence as well as the list below it.
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
  /*
   * `services` is no longer here. Phase 4H builds the surface — a real list of real
   * provisioned services with their operation history — so the placeholder had to go
   * in the same commit: `planned-and-absent.test.tsx` asserts this list agrees with
   * what is routed, and a promoted page left here renders its placeholder instead of
   * itself.
   *
   * Owner revisions 12, 13 and 14 were recorded on it, and none was dropped. They are
   * on the live page's rules card now, where whoever changes the ordering or adds a
   * filter will read them, and `services.test.tsx` asserts them there. Revision 13 is
   * no longer only a record: the repository pages `(created_at, id)` DESCENDING
   * because of it, against the ascending convention every other list here follows.
   */
  /*
   * `payments` is no longer here. Phase 4C builds the surface, so a placeholder
   * claiming it is planned would be the opposite untruth from the one this file
   * exists to prevent: `planned-and-absent.test.tsx` asserts the two lists agree
   * with what is routed, and a promoted page left in this list renders its
   * placeholder instead of itself.
   *
   * This is the same promotion `products` and `orders` had in 4B.
   */
  /*
   * `discounts` is no longer here. WP8 builds the surface — discount rules, cashback
   * rules and the price preview, each on the permission the server charges — so the
   * placeholder went in the same commit, for the reason `payments` gives above. No owner
   * decision was recorded on it, so none had to move. Its two "missing" sentences said
   * the catalogue did not exist and that pricing rules were declared but not enforced;
   * both were false by then and went with it rather than being left in the catalogue.
   */
  /*
   * `resellers` is no longer here. WP9-B builds the surface — the reseller list and
   * editor on `/resellers`, the tiers and their grants on `/reseller-tiers` — so the
   * placeholder went in the same commit, for the reason `payments` gives above. No owner
   * decision was recorded on it. Its two "missing" sentences — no reseller entity, and a
   * wallet ledger with no HTTP consumer — were both false by then and went with it.
   */
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
