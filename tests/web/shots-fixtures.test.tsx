import { describe, expect, it } from 'vitest';
import { API_PREFIX } from '@nexa/contracts';
import { FIXTURES, findFixture } from './shots/index.ts';

/**
 * The screenshot fixtures (`pnpm web:shots`) against the frozen contract.
 *
 * A fixture that drifts from its response schema does not fail the harness:
 * the real client refuses to parse it and the page draws its error card, which
 * then gets photographed and — three times in this project's history — reported
 * as a verified screen. So every body is parsed here, with the schema its
 * fixture names, on every web run.
 */
describe('the screenshot fixtures', () => {
  it.each(FIXTURES.map((fixture) => [`${fixture.method} ${fixture.path}`, fixture] as const))(
    '%s satisfies its response schema',
    (_, fixture) => {
      expect(fixture.schema, 'a 2xx fixture names its schema').not.toBeNull();
      expect(() => fixture.schema?.parse(fixture.body)).not.toThrow();
    },
  );

  it('answers the requests the shell makes on every screen', () => {
    const answer = (path: string, absolute = false) =>
      findFixture(
        FIXTURES,
        'GET',
        absolute ? path : `${API_PREFIX}${path}`,
        new URLSearchParams(),
        API_PREFIX,
      );
    expect(answer('/auth/session')?.path).toBe('/auth/session');
    expect(answer('/health/info', true)?.path).toBe('/health/info');
  });

  it('prefers the more specific fixture', () => {
    const extra = [
      ...FIXTURES,
      { ...FIXTURES.find((f) => f.path === '/panels')!, query: { archived: 'only' } },
    ];
    const at = (path: string, query = '') =>
      findFixture(extra, 'GET', `${API_PREFIX}${path}`, new URLSearchParams(query), API_PREFIX);
    // A parameterised detail beside its list, and a query-constrained answer beside the plain one.
    expect(at('/panels/abc')?.path).toBe('/panels/:id');
    expect(at('/panels')?.query).toEqual({});
    expect(at('/panels', 'archived=only')?.query).toEqual({ archived: 'only' });
    // Nothing answers a path no fixture names — the harness reports it by name.
    expect(at('/definitely-not-fixtured')).toBeUndefined();
  });

  /*
   * A fixture can satisfy its schema and still be a state the server never produces —
   * and then the responsive run measures an empty state instead of the screen.
   */
  const body = (path: string) => FIXTURES.find((f) => f.method === 'GET' && f.path === path)?.body;

  it('lists the signed-in session among the account’s sessions, marked current', () => {
    const { sessions } = body('/auth/sessions') as { sessions: { current: boolean }[] };
    expect(sessions.filter((session) => session.current)).toHaveLength(1);
  });

  it('gives the panel-health dashboard one row per panel the panel list shows', () => {
    const { panels } = body('/panels') as { panels: { id: string }[] };
    const { rows } = body('/panel-health') as { rows: { panel: { id: string } }[] };
    expect(panels.length).toBeGreaterThan(0);
    expect(rows.map((row) => row.panel.id)).toEqual(panels.map((panel) => panel.id));
  });
});
