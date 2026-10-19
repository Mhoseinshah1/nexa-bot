import type { ShotFixture } from './fixture.ts';
import { SHELL } from './fixtures/shell.ts';
import { DASHBOARD } from './fixtures/dashboard.ts';
import { COMMERCE_A } from './fixtures/commerce-a.ts';
import { COMMERCE_B } from './fixtures/commerce-b.ts';
import { OPS_A } from './fixtures/ops-a.ts';
import { OPS_B } from './fixtures/ops-b.ts';
import { COVERAGE } from './fixtures/coverage.ts';
import { COVERAGE_B } from './fixtures/coverage-b.ts';
import { DEMO_PARITY, DEMO_PARITY_EMPTY } from './fixtures/demo-parity/index.ts';

/** Every fixture the screenshot server answers from, one file per page family. */
export const FIXTURES: readonly ShotFixture[] = [
  ...SHELL,
  ...DASHBOARD,
  ...COMMERCE_A,
  ...COMMERCE_B,
  ...OPS_A,
  ...OPS_B,
  ...COVERAGE,
  ...COVERAGE_B,
];

export { SHOT_NOW } from './fixture.ts';

/**
 * Named fixture sets: OVERRIDES layered over `FIXTURES` (`fixturesFor`). `demo-parity` feeds
 * the app the approved demo's sample numbers; `demo-parity-empty` is its empty dashboard.
 */
export const FIXTURE_SETS: Readonly<Record<string, readonly ShotFixture[]>> = {
  'demo-parity': DEMO_PARITY,
  'demo-parity-empty': DEMO_PARITY_EMPTY,
};

const sameAnswer = (a: ShotFixture, b: ShotFixture) =>
  a.method === b.method &&
  a.path === b.path &&
  a.absolute === b.absolute &&
  JSON.stringify(Object.entries(a.query).sort()) === JSON.stringify(Object.entries(b.query).sort());

/**
 * The registry a screenshot run answers from: the named set's overrides first, then every
 * default fixture the set does not replace. No set (or an empty name) is `FIXTURES` itself;
 * an unknown name throws, so a typo never silently photographs the default data.
 */
export function fixturesFor(set: string | undefined): readonly ShotFixture[] {
  if (set === undefined || set === '') return FIXTURES;
  const overrides = FIXTURE_SETS[set];
  if (overrides === undefined) {
    throw new Error(
      `Unknown fixture set "${set}" (known: ${Object.keys(FIXTURE_SETS).join(', ')})`,
    );
  }
  return [
    ...overrides,
    ...FIXTURES.filter((base) => !overrides.some((override) => sameAnswer(override, base))),
  ];
}

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
