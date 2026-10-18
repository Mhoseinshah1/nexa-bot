import { RECORD_SOURCES, type RecordSource } from '@nexa/contracts';
import { t } from '../i18n/web.fa';
import type { Route } from '../router';
import type { ListFilter } from '../ui/filter-bar';
import { chipFilter, queryChipFilter } from './money-filters';

/**
 * The source filter every imported-row list shares (owner decision 2026-10-17): all / NEXA /
 * Mirza. One definition, so the eight lists cannot word or order it differently.
 */
const items = (): readonly { id: RecordSource; label: string }[] => [
  { id: 'NEXA', label: t('web.source_nexa') },
  { id: 'MIRZA', label: t('web.source_mirza') },
];

/** The `source` URL parameter, or null for anything that is not a source (a stale link). */
export function sourceFromQuery(raw: string | null): RecordSource | null {
  return RECORD_SOURCES.find((one) => one === raw) ?? null;
}

/** For a list that keeps its filters in the URL; a change also clears the cursor. */
export function sourceRouteFilter(route: Route, value: RecordSource | null): ListFilter {
  return queryChipFilter({
    route,
    param: 'source',
    label: t('web.source_filter'),
    value,
    allLabel: t('web.source_filter_all'),
    items: items(),
  });
}

/** For a list that keeps its filters in component state. */
export function sourceStateFilter(
  value: RecordSource | null,
  onChange: (next: RecordSource | null) => void,
): ListFilter {
  return chipFilter({
    key: 'source',
    label: t('web.source_filter'),
    value,
    allLabel: t('web.source_filter_all'),
    onChange,
    items: items(),
  });
}
