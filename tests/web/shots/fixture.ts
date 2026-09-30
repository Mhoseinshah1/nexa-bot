/**
 * The fixture registry for `pnpm web:shots` — controlled API answers for
 * screenshots of the real production build.
 *
 * Every fixture names the RESPONSE SCHEMA its body must satisfy, and
 * `tests/web/shots-fixtures.test.tsx` parses every body with it, so a fixture
 * that drifts from the frozen contract fails the web suite instead of
 * photographing an error state. (The stale-fixture failure mode is recorded in
 * `scripts/visual/README.md`: three times a drifted fixture produced a
 * screenshot of a skeleton that was reported as a verified page.)
 *
 * Loaded two ways: by vitest (the validation test) and by Node itself (the
 * harness, through Node's built-in TypeScript type stripping). So these files
 * use only erasable TypeScript — types, `satisfies`, `as` — and import each
 * other with explicit `.ts` extensions.
 */

/** The wall clock every screenshot is taken at. The harness freezes `Date` here. */
export const SHOT_NOW = '2026-09-06T08:00:00.000Z';

/** An ISO timestamp `minutesAgo` before `SHOT_NOW` (negative is in the future). */
export function ago(minutesAgo: number): string {
  return new Date(Date.parse(SHOT_NOW) - minutesAgo * 60_000).toISOString();
}

/** Anything with the `parse` a zod schema has. */
export interface Parser {
  parse: (value: unknown) => unknown;
}

export interface ShotFixture {
  /** GET by default. */
  readonly method: string;
  /**
   * The path AFTER `/api/admin/v1`, e.g. `/panels` or `/panels/:id`
   * (`:name` matches one segment). With `absolute`, the whole path, e.g.
   * `/health/info`.
   */
  readonly path: string;
  readonly absolute: boolean;
  /** Query parameters that must ALL be present with these values. More wins. */
  readonly query: Readonly<Record<string, string>>;
  readonly status: number;
  /** The schema the body is validated against; null only for a non-2xx body. */
  readonly schema: Parser | null;
  readonly body: unknown;
}

export function fixture(
  path: string,
  schema: Parser,
  body: unknown,
  options: {
    method?: string;
    absolute?: boolean;
    query?: Readonly<Record<string, string>>;
    status?: number;
  } = {},
): ShotFixture {
  return {
    method: options.method ?? 'GET',
    path,
    absolute: options.absolute ?? false,
    query: options.query ?? {},
    status: options.status ?? 200,
    schema,
    body,
  };
}
