import type { ShotFixture } from './fixture.ts';
import { SHELL } from './fixtures/shell.ts';
import { DASHBOARD } from './fixtures/dashboard.ts';
import { COMMERCE_A } from './fixtures/commerce-a.ts';
import { COMMERCE_B } from './fixtures/commerce-b.ts';
import { OPS_A } from './fixtures/ops-a.ts';
import { OPS_B } from './fixtures/ops-b.ts';
import { COVERAGE } from './fixtures/coverage.ts';

/** Every fixture the screenshot server answers from, one file per page family. */
export const FIXTURES: readonly ShotFixture[] = [
  ...SHELL,
  ...DASHBOARD,
  ...COMMERCE_A,
  ...COMMERCE_B,
  ...OPS_A,
  ...OPS_B,
  ...COVERAGE,
];

export { SHOT_NOW } from './fixture.ts';

/**
 * The fixture that answers a request, or undefined.
 *
 * A path pattern matches segment by segment (`:name` is one segment). Among
 * matches, the one constraining more query parameters wins, then the one with
 * more literal segments — so `/panels/new` can be given its own answer beside
 * `/panels/:id`, and `/panels?archived=only` beside `/panels`.
 */
export function findFixture(
  fixtures: readonly ShotFixture[],
  method: string,
  pathname: string,
  query: URLSearchParams,
  apiPrefix: string,
): ShotFixture | undefined {
  const candidates = fixtures.filter((candidate) => {
    if (candidate.method !== method) return false;
    const target = candidate.absolute
      ? pathname
      : pathname.startsWith(apiPrefix)
        ? pathname.slice(apiPrefix.length)
        : null;
    if (target === null) return false;
    const wanted = candidate.path.split('/').filter(Boolean);
    const actual = target.split('/').filter(Boolean);
    if (wanted.length !== actual.length) return false;
    if (!wanted.every((segment, i) => segment.startsWith(':') || segment === actual[i]))
      return false;
    return Object.entries(candidate.query).every(([key, value]) => query.get(key) === value);
  });
  const literal = (f: ShotFixture) =>
    f.path.split('/').filter((s) => s !== '' && !s.startsWith(':')).length;
  return candidates.sort(
    (a, b) => Object.keys(b.query).length - Object.keys(a.query).length || literal(b) - literal(a),
  )[0];
}
