import { t } from './i18n/web.fa';
import { NAV, NAV_STANDALONE_GROUP, isCurrent, type NavEntry } from './nav';
import { rememberedHref } from './router';
import type { Crumb } from './ui/kit';

/**
 * The page header's breadcrumb (demo parity X1), derived from the navigation and never
 * written per page: «گروه منو / صفحه» for a page the sidebar links to, and
 * «گروه منو / فهرست / جزئیات …» for a page under one (a detail, a «new» form, a method's own
 * view). The group and the list come from `nav.ts`; the last crumb is the route's own name
 * from `resolve()`, which already names every page it serves.
 *
 * A trail of one is not drawn: the dashboard (the standalone group) and a page no entry owns
 * (`/account`, not-found) have nowhere above them to go back to.
 */
export function pageTrail(
  path: string,
  routeCrumbs: readonly Crumb[],
  entries: readonly NavEntry[] = NAV,
): readonly Crumb[] {
  const current = routeCrumbs[routeCrumbs.length - 1];
  if (current === undefined) return [];
  // The longest entry that owns the path: `/reseller-tiers` is its own entry, not `/resellers`'.
  const owner = entries
    .filter((entry) => isCurrent(entry.path, path))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (owner === undefined || owner.group === NAV_STANDALONE_GROUP) {
    return routeCrumbs.length > 1 ? routeCrumbs : [];
  }
  const trail: Crumb[] = [{ label: t(owner.group) }];
  if (owner.path !== path) {
    // Back to the list as it was left: its filters and search (`rememberedHref`).
    trail.push({ label: t(owner.label), href: rememberedHref(owner.path) });
  }
  trail.push({ label: current.label });
  return trail;
}
