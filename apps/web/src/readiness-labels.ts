import { formatNumber } from './format';
import { t, type WebKey } from './i18n/web.fa';

/**
 * The readiness probe, in Persian (C1): the dashboard's system card and the system page.
 *
 * The API names each dependency with a fixed word (`ReadinessService`: `postgres`, `redis`,
 * `migrations`, `outbox`) and describes a result with a closed vocabulary of English words
 * and a handful of numeric shapes. Both are mapped here; a name or a detail this build does
 * not know falls back to the raw text, never a blank, and the raw text is always kept for
 * support (`title`, or «جزئیات فنی»). `tests/web/raw-key-labels.test.tsx` reads the API's
 * readiness service and checks every name and detail it can write is said here.
 */
export const DEPENDENCY_LABELS: Readonly<Record<string, WebKey>> = {
  postgres: 'web.readiness_dep_postgres',
  redis: 'web.readiness_dep_redis',
  migrations: 'web.readiness_dep_migrations',
  outbox: 'web.readiness_dep_outbox',
};

/** The Persian name of a dependency, or its raw name when this build has none. */
export function dependencyLabel(name: string): string {
  const key = Object.prototype.hasOwnProperty.call(DEPENDENCY_LABELS, name)
    ? DEPENDENCY_LABELS[name]
    : undefined;
  return key === undefined ? name : t(key);
}

const FIXED_DETAILS: Readonly<Record<string, WebKey>> = {
  timeout: 'web.readiness_detail_timeout',
  unreachable: 'web.readiness_detail_unreachable',
  'auth failed': 'web.readiness_detail_auth_failed',
  missing: 'web.readiness_detail_missing',
  unavailable: 'web.readiness_detail_unavailable',
  'no migrations applied': 'web.readiness_detail_no_migrations',
};

const fill = (key: WebKey, values: Readonly<Record<string, string>>): string =>
  Object.entries(values).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, formatNumber(Number(value))),
    t(key),
  );

/**
 * A readiness detail in Persian, or `null` when its shape is not one the API writes today —
 * the caller then shows a generic Persian line and keeps the raw detail in «جزئیات فنی».
 */
export function readinessDetailText(detail: string): string | null {
  const fixed = Object.prototype.hasOwnProperty.call(FIXED_DETAILS, detail)
    ? FIXED_DETAILS[detail]
    : undefined;
  if (fixed !== undefined) return t(fixed);
  let match = /^(\d+) applied$/u.exec(detail);
  if (match !== null) return fill('web.readiness_detail_applied', { applied: match[1] ?? '' });
  match = /^(\d+) applied, (\d+) newer than this release$/u.exec(detail);
  if (match !== null) {
    return fill('web.readiness_detail_ahead', { expected: match[1] ?? '', extra: match[2] ?? '' });
  }
  match = /^behind: (\d+) of (\d+) applied, next .+$/u.exec(detail);
  if (match !== null) {
    return fill('web.readiness_detail_behind', {
      applied: match[1] ?? '',
      expected: match[2] ?? '',
    });
  }
  if (detail.startsWith('diverged: ')) return t('web.readiness_detail_diverged');
  match = /^oldest unpublished (\d+)ms$/u.exec(detail);
  if (match !== null) return fill('web.readiness_detail_outbox_lag', { lag: match[1] ?? '' });
  return null;
}
