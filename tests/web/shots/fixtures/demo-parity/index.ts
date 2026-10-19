import type { ShotFixture } from '../../fixture.ts';
import { DEMO_DASHBOARD, DEMO_DASHBOARD_EMPTY } from './dashboard.ts';
import { DEMO_RECOVERY } from './recovery.ts';
import { DEMO_SERVICES_FAMILY } from './services.ts';

/*
 * The DEMO-PARITY fixture sets (PROMPT.md §D-3): the app fed the approved demo's own
 * sample numbers, so a side-by-side against `approved-demo.html` compares like with like.
 *
 * A set is a list of OVERRIDES over the default registry (`../../index.ts`): an override
 * replaces the default fixture with the same method, path and query, and answers first.
 * Every route not overridden keeps its default answer. Page agents add their page's
 * overrides here — one file per page family, spread into `DEMO_PARITY` below.
 *
 * Selected with `pnpm web:shots … --fixtures demo-parity` (or `NEXA_SHOT_FIXTURES`).
 */
export const DEMO_PARITY: readonly ShotFixture[] = [
  ...DEMO_DASHBOARD,
  ...DEMO_RECOVERY,
  ...DEMO_SERVICES_FAMILY,
];

/** The demo's EMPTY dashboard: nothing in the period, nothing waiting. */
export const DEMO_PARITY_EMPTY: readonly ShotFixture[] = [
  ...DEMO_DASHBOARD_EMPTY,
  ...DEMO_PARITY.filter(
    (base) =>
      !DEMO_DASHBOARD_EMPTY.some(
        (empty) => empty.method === base.method && empty.path === base.path,
      ),
  ),
];
