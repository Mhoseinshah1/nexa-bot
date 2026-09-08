import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { featureFlagSchema, notificationSchema, templateViewSchema } from '@nexa/contracts';
import { FeaturesPage } from '../../apps/web/src/pages/features';
import { ContentPage } from '../../apps/web/src/pages/content';
import { NotificationsPage } from '../../apps/web/src/pages/alerts';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

const NO_PERMISSION = t('web.no_permission');

/**
 * The four control-plane routes the coverage ledger claimed were covered.
 *
 * They were not. The ledger cited "existing control-plane suites" for
 * `/features`, `/content` and `/notifications` — those are API-level
 * integration tests, and no case in `tests/web/` rendered any of these three
 * components at all. That is precisely the gap this suite's own rationale
 * names: the risk it exists to cover is production WIRING, and an API test
 * cannot see a page that never calls the endpoint, reads the wrong field, or
 * throws on a shape the schema permits.
 *
 * Every fixture below is PARSED by the frozen schema first, so a contract
 * change fails here rather than rendering something the server would never
 * send.
 */
const flag = (over: Record<string, unknown> = {}) =>
  featureFlagSchema.parse({
    key: 'ops_notifications',
    description: 'Project operational events to the operations destination.',
    enabled: true,
    source: 'TENANT',
    blastRadius: 'LOCAL',
    version: 2,
    reason: null,
    updatedAt: '2026-09-01T00:00:00.000Z',
    updatedByAdminId: 'a1',
    configuration: [],
    ...over,
  });

const template = (over: Record<string, unknown> = {}) =>
  templateViewSchema.parse({
    key: 'event.panel.unreachable',
    locale: 'fa',
    description: 'Sent when a panel stops answering.',
    format: 'PLAIN_TEXT',
    maxLength: 4096,
    body: 'پنل {panel_name} در دسترس نیست.',
    defaultBody: 'پنل {panel_name} در دسترس نیست.',
    overrideBody: null,
    source: 'DEFAULT',
    overrideSuppressed: false,
    version: null,
    revision: null,
    updatedAt: null,
    updatedByAdminId: null,
    placeholders: [
      {
        token: 'panel_name',
        type: 'STRING',
        description: 'The panel that stopped answering.',
        required: true,
        repeatable: false,
      },
    ],
    ...over,
  });

const notification = (over: Record<string, unknown> = {}) =>
  notificationSchema.parse({
    id: 'n1',
    kind: 'OPERATIONAL_EVENT',
    status: 'SENT',
    templateKey: 'event.panel.unreachable',
    attemptCount: 1,
    maxAttempts: 5,
    createdAt: '2026-09-06T08:00:00.000Z',
    lastAttemptAt: '2026-09-06T08:00:01.000Z',
    completedAt: '2026-09-06T08:00:01.000Z',
    correlationId: 'c1',
    ...over,
  });

describe('the feature flags page', () => {
  it('renders a flag and the settings it governs', async () => {
    stubApi([{ url: '/features', body: { flags: [flag()] } }]);
    renderPage(<FeaturesPage mayEdit denied={false} />);

    expect(await screen.findByText('ops_notifications')).toBeInTheDocument();
  });

  /**
   * A flag is a BOOLEAN and its parameters are settings — the Phase 2 rule
   * that neither registry may grow a field belonging to the other. The only
   * action a flag row offers is enable/disable; a value input beside it would
   * be the first step back.
   */
  it('offers only enable and disable, never a value to type', async () => {
    stubApi([{ url: '/features', body: { flags: [flag({ enabled: true })] } }]);
    const { container } = renderPage(<FeaturesPage mayEdit denied={false} />);
    await screen.findByText('ops_notifications');

    expect(screen.getByRole('button', { name: t('web.disable') })).toBeEnabled();
    // T32 — NO input at all, not "no input carrying one of two type values".
    // A plain `<input>` with no `type` attribute is a text field, so the
    // selector-based version left the flag/setting conflation it names free to
    // come back the most ordinary way there is. A flag is a boolean; its
    // parameters are settings, and they live on the settings screen.
    expect(container.querySelectorAll('input, textarea, select')).toHaveLength(0);
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    expect(screen.queryAllByRole('spinbutton')).toHaveLength(0);
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
  });

  it('draws no toggle at all for an actor who may only view', async () => {
    stubApi([{ url: '/features', body: { flags: [flag({ enabled: true })] } }]);
    renderPage(<FeaturesPage mayEdit={false} denied={false} />);
    await screen.findByText('ops_notifications');

    // Absent, not disabled. The earlier version of this case looped over
    // elements that do not exist without `mayEdit`, so it passed vacuously
    // and would have passed just as happily with the control drawn.
    expect(screen.queryByRole('button', { name: t('web.disable') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('web.enable') })).toBeNull();
  });
});

describe('the content page', () => {
  /**
   * A template body is stored RAW and rendered nowhere near where it is
   * edited. The editor must therefore show the placeholder token itself, not
   * a substituted value — the legacy defect that baked an admin's own name
   * into `{first_name}` for thirteen thousand customers.
   */
  it('shows the raw body with its placeholder token intact', async () => {
    stubApi([{ url: '/templates', body: { templates: [template()] } }]);
    renderPage(<ContentPage mayEdit denied={false} />);

    expect((await screen.findAllByText('event.panel.unreachable')).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/\{panel_name\}/).length).toBeGreaterThan(0);
  });

  it('reports a permission refusal rather than an empty catalogue', async () => {
    stubApi([]);
    renderPage(<ContentPage mayEdit={false} denied />);
    expect(await screen.findByText(NO_PERMISSION)).toBeInTheDocument();
  });

  /**
   * T30 — the editor's ACTUAL value, not a token found somewhere on the card.
   *
   * The placeholder token also appears in the placeholder table beside the
   * editor, so `getAllByText(/{panel_name}/)` was satisfied by the
   * documentation while the textarea rendered anything at all. Read off the
   * control the operator types into.
   */
  it('puts the raw stored body in the editor itself', async () => {
    stubApi([{ url: '/templates', body: { templates: [template()] } }]);
    renderPage(<ContentPage mayEdit denied={false} />);
    await screen.findAllByText('event.panel.unreachable');

    const editor = document.getElementById('body-event.panel.unreachable');
    expect(editor).toBeInstanceOf(HTMLTextAreaElement);
    // The RAW body, character for character — never a rendered one.
    expect((editor as HTMLTextAreaElement).value).toBe('پنل {panel_name} در دسترس نیست.');
  });

  /**
   * T05 — the revert button's guard and its payload name the same row.
   *
   * The guard tested the freshly fetched `template` while the request carried
   * the draft `basis`. So: open the card on a key with no override, let another
   * administrator create one, and the refetch drew a revert button whose
   * payload was a null version — refused as a 400 validation error rather than
   * shown as the conflict it is, and to the operator simply a button that did
   * nothing.
   *
   * Driven through the real production sequence: a save that conflicts
   * invalidates the query, and the refetch is what brings the other
   * administrator's row in.
   */
  it('offers no revert while the draft is based on no override', async () => {
    const route = {
      url: '/templates',
      body: { templates: [template()] } as unknown,
    };
    stubApi([
      route,
      {
        url: '/templates/event.panel.unreachable',
        status: 409,
        body: {
          error: {
            kind: 'conflict',
            code: 'control.template_version_conflict',
            message: 'somebody else changed it',
            correlationId: 'test',
          },
        },
      },
    ]);
    renderPage(<ContentPage mayEdit denied={false} />);
    await screen.findAllByText('event.panel.unreachable');

    // No override yet, so nothing to revert.
    expect(screen.queryByRole('button', { name: 'بازگرداندن به پیش‌فرض' })).toBeNull();

    // Another administrator creates one while this card is open.
    route.body = {
      templates: [
        template({
          overrideBody: 'یک متن اختصاصی',
          source: 'TENANT',
          version: 3,
          revision: 1,
          updatedAt: '2026-09-06T09:00:00.000Z',
          updatedByAdminId: 'a2',
        }),
      ],
    };

    // The production path that refetches: a conflicting save.
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره' }));

    // The refetch landed — the card says the row changed underneath.
    expect(await screen.findByText(/گرفتن مقدار تازه/)).toBeInTheDocument();

    // And STILL no revert button, because the draft is based on no override.
    // The old guard read the refetched row and drew one whose payload was null.
    expect(screen.queryByRole('button', { name: 'بازگرداندن به پیش‌فرض' })).toBeNull();

    // Adopting the other administrator's row is what makes a revert meaningful,
    // and only then is the button there.
    fireEvent.click(screen.getByRole('button', { name: 'گرفتن مقدار تازه' }));
    expect(
      await screen.findByRole('button', { name: 'بازگرداندن به پیش‌فرض' }),
    ).toBeInTheDocument();
  });
});

describe('the template revisions pane', () => {
  /**
   * A refused revision history is not an empty one.
   *
   * The pane rendered `{revisions.data && …}` and nothing else — no loading
   * state, no error state, no retry — so a refused or failing
   * `GET /templates/:key/revisions` drew an EMPTY pane. An operator reads that
   * as "this template has no revision history", which is a false statement
   * about the record, from the module whose own comment says silence is the one
   * outcome this subsystem may not produce.
   *
   * It never mentioned `isError`, so the scan aimed at hand-rolled error
   * ladders could not see it: the defect was the ABSENCE of that spelling.
   */
  it('says the history could not be read, rather than showing none', async () => {
    stubApi([
      { url: '/templates', body: { templates: [template()] } },
      {
        /*
         * `unreachable/revisions`, not `/revisions`.
         *
         * Longest match wins and the sort is stable, so `/revisions` and
         * `/templates` — both ten characters, both substrings of the revisions
         * URL — tie, and the FIRST registered wins. The earlier version of this
         * test therefore answered the revisions request with the template list,
         * and its error card came from a `ZodError`, not the 503 it names.
         */
        url: 'unreachable/revisions',
        body: {
          error: {
            kind: 'internal',
            code: 'test.down',
            message: 'down',
            correlationId: 'test',
          },
        },
        status: 503,
      },
    ]);
    renderPage(<ContentPage mayEdit denied={false} />);
    await screen.findAllByText('event.panel.unreachable');

    // Opening the <details> is what enables the query.
    const pane = screen.getAllByText('تاریخچه')[0] as HTMLElement;
    fireEvent.click(pane);
    const details = pane.closest('details');
    if (details !== null) {
      details.open = true;
      fireEvent(details, new Event('toggle'));
    }

    // Not silence, and not a claim that there are none.
    expect(await screen.findByText('خطا در ارتباط با سرور')).toBeInTheDocument();
    expect(screen.queryByText('موردی برای نمایش نیست.')).toBeNull();
  });

  /**
   * Reopening the pane is not a retry the rule does not know about.
   *
   * `enabled: showHistory` flipped false→true on every close-and-reopen, which
   * re-triggers an errored query — so the `<summary>` element was an unbounded
   * retry button. Measured before the fix at one request per reopen.
   *
   * A 503 rather than the 403 this test was first written with, and the reason
   * is the whole point of writing it down. The fix below it — `enabled` going
   * false on a FINAL answer — independently stops a refused query refetching,
   * so against a 403 this test passed with the sticky rule reverted: it had
   * quietly stopped testing anything, killed by a fix in the same round. A
   * retryable failure is the case where sticky is the only thing holding the
   * line, because there `enabled` stays true and the false→true edge is the
   * entire mechanism.
   */
  it('does not refetch a failing history each time the pane is reopened', async () => {
    const api = stubApi([
      { url: '/templates', body: { templates: [template()] } },
      {
        url: 'unreachable/revisions',
        body: {
          error: {
            kind: 'internal',
            code: 'test.down',
            message: 'down',
            correlationId: 'test',
          },
        },
        status: 503,
      },
    ]);
    renderPage(<ContentPage mayEdit denied={false} />);
    await screen.findAllByText('event.panel.unreachable');

    const open = () => {
      const pane = screen.getAllByText('تاریخچه')[0] as HTMLElement;
      const details = pane.closest('details');
      if (details === null) return;
      details.open = !details.open;
      fireEvent(details, new Event('toggle'));
    };
    open();
    await waitFor(() => {
      expect(api.calls.filter((call) => call.url.includes('/revisions'))).toHaveLength(1);
    });

    open();
    open();
    open();
    open();
    // Still one. The pane's first open enables the query; closing it does not
    // disable it, so reopening cannot re-trigger anything.
    expect(api.calls.filter((call) => call.url.includes('/revisions'))).toHaveLength(1);
  });

  /**
   * 1a — the pane is not fetched until it is OPENED, which nothing tested.
   *
   * `enabled` has three terms and two of them had tests. Dropping
   * `showHistory` entirely left all 290 green: the two existing tests both
   * open the pane, and the sticky test cannot see it either because an
   * always-enabled cached query still shows one call. What it costs is one
   * `GET /templates/:key/revisions` per template card on page load, panes
   * shut — an N-fold amplification against the endpoint the test below is
   * about not touching from a closed pane.
   */
  it('asks for no revision history until a pane is opened', async () => {
    const api = stubApi([
      { url: '/templates', body: { templates: [template()] } },
      { url: 'templates/event.panel.unreachable/revisions', body: { revisions: [] } },
    ]);
    renderPage(<ContentPage mayEdit denied={false} />);
    await screen.findAllByText('event.panel.unreachable');

    // Give any mount-time fetch a turn to land before asserting its absence.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api.calls.filter((call) => call.url.includes('/revisions'))).toHaveLength(0);
  });

  /**
   * A RETRYABLE failure must not disable the pane — the other half of the rule.
   *
   * The `enabled` callback reads `finalAnswer`, and only the disable-on-final
   * half was tested. Replacing it with the cruder `query.state.status !==
   * 'error'` passed lint, prettier, tsc and all 286 tests — and it turns one
   * transient 5xx into a revisions pane that is dead for the life of the card:
   * the query is disabled the moment it errors, so no invalidation and no
   * reopen can ever bring it back. That is the frozen-screen defect this branch
   * spent four rounds removing, reintroduced by a "simplification" no test
   * could see.
   *
   * Worse, with that mutation in place the sticky-pane test above stops
   * discriminating too, because a disabled query cannot be re-triggered by
   * anything. One untested half quietly disarmed the test beside it.
   *
   * So: fail retryably, let the server recover, save — and the pane must ask
   * again.
   */
  it('asks again after a retryable failure once something invalidates it', async () => {
    const revisions = {
      url: 'templates/event.panel.unreachable/revisions',
      body: {
        error: { kind: 'internal', code: 'test.down', message: 'down', correlationId: 'test' },
      } as unknown,
      status: 503,
    };
    const api = stubApi([
      { url: '/templates', body: { templates: [template()] } },
      revisions,
      {
        url: '/templates/event.panel.unreachable',
        body: { template: template({ overrideBody: 'تازه', source: 'TENANT', version: 2 }) },
      },
    ]);
    renderPage(<ContentPage mayEdit denied={false} />);
    await screen.findAllByText('event.panel.unreachable');

    const revisionCalls = () => api.calls.filter((call) => call.url.includes('/revisions')).length;

    const pane = screen.getAllByText('تاریخچه')[0] as HTMLElement;
    const details = pane.closest('details');
    if (details !== null) {
      details.open = true;
      fireEvent(details, new Event('toggle'));
    }
    await waitFor(() => {
      expect(revisionCalls()).toBe(1);
    });

    // The outage ends.
    revisions.status = 200;
    revisions.body = { revisions: [] };

    // An ordinary save invalidates the key. A retryable failure is worth
    // waiting through, so the pane must take the chance.
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره' }));
    await waitFor(() => {
      expect(revisionCalls()).toBe(2);
    });
  });

  /**
   * F5 — sticky-enabled is not "costs nothing"; `invalidate()` is the cost.
   *
   * The fix above made `showHistory` sticky so a reopen could not re-trigger
   * an errored query. Its comment then claimed staying enabled "costs
   * nothing: this query has no interval". The cost was never an interval. It
   * is `invalidate()`, which the save mutation runs on success AND on error
   * and which invalidates this exact key — so a query that used to be
   * `enabled: false` behind a closed pane became one that refetches on the
   * operator's PRIMARY action, in the same final 403 for which `retryOf`
   * withholds the Retry button. Measured before the fix: three saves took the
   * revisions request count from 1 to 4, pane shut, unbounded.
   *
   * One channel closed and a worse one opened is not a fix, so the rule
   * `retryOf` states is stated on the query too: after a final answer there is
   * nothing to fetch.
   */
  it('does not refetch a refused history when an unrelated save invalidates it', async () => {
    const api = stubApi([
      { url: '/templates', body: { templates: [template()] } },
      // Longer than the save route below, so the revisions request is not
      // swallowed by it — `includes` matching means the shorter save URL is a
      // substring of this one, and longest match wins.
      {
        url: 'templates/event.panel.unreachable/revisions',
        body: {
          error: {
            kind: 'forbidden',
            code: 'access.permission_denied',
            message: 'no',
            correlationId: 'test',
          },
        },
        status: 403,
      },
      {
        url: '/templates/event.panel.unreachable',
        body: { template: template({ overrideBody: 'تازه', source: 'TENANT', version: 2 }) },
      },
    ]);
    renderPage(<ContentPage mayEdit denied={false} />);
    await screen.findAllByText('event.panel.unreachable');

    const revisionCalls = () => api.calls.filter((call) => call.url.includes('/revisions')).length;

    // Open the pane once so the query runs and takes its final refusal…
    const pane = screen.getAllByText('تاریخچه')[0] as HTMLElement;
    const details = pane.closest('details');
    if (details !== null) {
      details.open = true;
      fireEvent(details, new Event('toggle'));
    }
    await waitFor(() => {
      expect(revisionCalls()).toBe(1);
    });

    // …then SHUT it. Nothing about the pane is on screen from here on.
    if (details !== null) {
      details.open = false;
      fireEvent(details, new Event('toggle'));
    }

    // Three ordinary saves. Each one calls invalidate().
    for (let attempt = 0; attempt < 3; attempt += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'ذخیره' }));
      await waitFor(() => {
        expect(api.calls.filter((call) => call.method === 'POST').length).toBe(attempt + 1);
      });
    }

    // Still one. Before the fix this was four.
    expect(revisionCalls()).toBe(1);
  });
});

describe('the notifications page', () => {
  it('renders an intent and its delivery state', async () => {
    stubApi([
      { url: '/notifications', body: { notifications: [notification()], nextCursor: null } },
    ]);
    renderPage(<NotificationsPage mayTest denied={false} />);

    expect(await screen.findByText('event.panel.unreachable')).toBeInTheDocument();
  });

  /**
   * Selecting a notification does something visible immediately.
   *
   * The detail rendered three blocks keyed on staleness, the error state and
   * the data — jointly incomplete, because `isPending` matched none of them.
   * So the first load of a newly selected notification left the DOM
   * byte-identical until the request answered: a click that appears to do
   * nothing. Every `StateSwitch` view on the branch draws a skeleton here, and
   * the comment claiming this site follows "the SAME rule as every other query
   * view" was two thirds true.
   */
  it('shows the detail is loading rather than nothing at all', async () => {
    // The same shape the other held-request tests use: TypeScript cannot see
    // the assignment inside a Promise executor and narrows the binding to null.
    const gate: { release: () => void } = { release: () => undefined };
    const held = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    const body = (value: unknown) =>
      new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes('/notifications/')) {
          await held;
          return body({
            notification: notification({ id: 'n1' }),
            attempts: [],
            releasedClaims: [],
          });
        }
        return body({ notifications: [notification({ id: 'n1' })], nextCursor: null });
      }),
    );
    renderPage(<NotificationsPage mayTest denied={false} />);
    await screen.findByText('event.panel.unreachable');
    const before = document.body.innerHTML;

    fireEvent.click(screen.getByRole('button', { name: 'event.panel.unreachable' }));

    await waitFor(() => {
      expect(document.body.innerHTML).not.toBe(before);
    });
    gate.release();
  });

  /**
   * The pager describes rows that are on screen, and stops when they are not.
   *
   * `CursorPager` is a SIBLING of `StateSwitch`, fed from `query.data`, so the
   * error card replaced the table while the pager below went on reporting
   * "showing N" for rows nobody could see — and offered an enabled "older" that
   * pushed a cursor, changing the query key and issuing a fresh request the
   * server had just refused.
   */
  it('takes the pager down with the rows it was describing', async () => {
    const route = {
      url: '/notifications',
      body: {
        notifications: [notification({ id: 'n1', status: 'PENDING' })],
        nextCursor: { at: '2026-09-06T07:00:00.000Z', id: 'n0' },
      } as unknown,
      status: 200,
    };
    stubApi([route]);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPage(<NotificationsPage mayTest denied={false} />);
    await screen.findByText('event.panel.unreachable');
    expect(screen.getByRole('button', { name: 'قدیمی‌تر' })).toBeEnabled();

    route.status = 403;
    route.body = {
      error: {
        kind: 'forbidden',
        code: 'access.permission_denied',
        message: 'no',
        correlationId: 'test',
      },
    };
    await vi.advanceTimersByTimeAsync(95_000);

    await waitFor(() => {
      expect(screen.queryByRole('table')).toBeNull();
    });
    expect(screen.queryByRole('button', { name: 'قدیمی‌تر' })).toBeNull();
    vi.useRealTimers();
  });

  /**
   * The notification detail obeys the SAME rule as every other query view.
   *
   * It was the one view on the branch that computed its own states — a
   * hand-rolled `{detail.isError && <Banner/>}` beside `{detail.data && <Card/>}`
   * — and `isError` does not distinguish a blip from an answer. So on a FINAL
   * refusal it kept the pre-failure attempts list on screen as though it were
   * current, and offered a Retry that could only be refused again, writing
   * another `access.permission_denied` event per press. Both halves are the
   * defect the rest of the branch spent five rounds removing.
   */
  /**
   * F4/M10 — the notifications pager: same rule, same silence.
   *
   * Reverting this gate too left all 277 tests passing. The alerts pager one
   * screen over had a test; this one did not, and the round's prose claimed
   * all three pagers were fixed while its mutation table named neither. That
   * is the branch's defining shape — the rule holds where the author was
   * looking — reproduced by the commit written to remove it.
   *
   * DENIED, not a 403 response, and the first version of this test got that
   * wrong. Against a 403 `queryState` is `'error'`, so the reverted gate
   * (`queryState !== 'error'`) hides the pager too and the test passes either
   * way — it was written to catch M10 and could not. A denied query is
   * `enabled: false`, so it is `isPending` FOR EVER and never `isError`: the
   * old gate reads `'loading' !== 'error'` and draws the pager above the "you
   * do not have access" card. That is the state the rule exists for.
   */
  /**
   * F2 — the THIRD pager gate, named in round 31's own commit message and
   * tested at two of the three sites it named.
   *
   * The only test touching this gate supplies `denied` from the first render,
   * which is exactly the shape that commit message rejects: the query is
   * `enabled: false`, therefore `'loading'`, so the gate closes for the wrong
   * reason and `denied ? 'denied' :` can be deleted with the entire gate green
   * — 299 web, 727 unit, lint, format, typecheck, boundaries, i18n, citations.
   * A rule fixed at two of three sites is the branch's defect class with a
   * smaller denominator.
   */
  it('withdraws the notification pager when the permission is lost over rows', async () => {
    stubApi([
      {
        url: '/notifications',
        body: { notifications: [notification({ id: 'n1' })], nextCursor: null },
      },
    ]);
    const { rerender } = renderPage(<NotificationsPage mayTest denied={false} />);
    await screen.findByText('event.panel.unreachable');
    expect(screen.getByText('نمایش')).toBeInTheDocument();

    rerender(<NotificationsPage mayTest denied />);

    expect(screen.queryByText('نمایش')).toBeNull();
    expect(screen.queryByRole('button', { name: 'قدیمی‌تر' })).toBeNull();
  });

  it('draws no notification pager before the first page has arrived', () => {
    stubApi([
      {
        url: '/notifications',
        body: { notifications: [notification({ id: 'n1' })], nextCursor: null },
      },
    ]);
    renderPage(<NotificationsPage mayTest denied={false} />);
    expect(screen.queryByText('نمایش')).toBeNull();
  });

  /**
   * F3 — the `'empty'` arm, untested at all three gates, and its harm is the
   * design claim's OTHER direction: no screen hides an action the server
   * permits.
   *
   * Narrowing `['ready', 'empty']` to `['ready']` at all three sites left 299
   * green. Page forward on a server-supplied cursor onto a page whose rows
   * have since been resolved, and the state is `'empty'` — so the pager
   * vanishes and takes the "تازه‌تر" button with it, which is the only way
   * back. The operator is stranded on an empty page and must reload.
   */
  it('keeps the way back when a page turns out to be empty', async () => {
    stubApi([{ url: '/notifications', body: { notifications: [], nextCursor: null } }]);
    renderPage(<NotificationsPage mayTest denied={false} />);
    await screen.findByText('موردی برای نمایش نیست.');

    // Nothing to show, but the pager is how you get off this page.
    expect(screen.getByText('نمایش')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'تازه‌تر' })).toBeInTheDocument();
  });

  it('takes the notification pager down with the rows it was describing', async () => {
    stubApi([{ url: '/notifications', body: { notifications: [], nextCursor: null } }]);
    renderPage(<NotificationsPage mayTest denied />);
    await screen.findByText(t('web.no_permission'));

    // Denied: there are no rows, so there is nothing to page through.
    expect(screen.queryByRole('button', { name: 'قدیمی‌تر' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'تازه‌تر' })).toBeNull();
    expect(screen.queryByText('نمایش')).toBeNull();
  });

  it('drops a stale attempts list on a final refusal, and offers no retry', async () => {
    const detail = {
      url: '/notifications/n1',
      body: {
        notification: notification({ id: 'n1', status: 'PENDING' }),
        attempts: [],
        releasedClaims: [],
      } as unknown,
      status: 200,
    };
    stubApi([
      {
        url: '/notifications',
        body: {
          notifications: [notification({ id: 'n1', status: 'PENDING' })],
          nextCursor: null,
        },
      },
      detail,
    ]);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPage(<NotificationsPage mayTest denied={false} />);
    await screen.findByText('event.panel.unreachable');

    // Open the detail so there is something to go stale. The row's template
    // key IS the button that selects it.
    fireEvent.click(screen.getByRole('button', { name: 'event.panel.unreachable' }));
    // The CARD heading, not the table column of the same name.
    await screen.findByRole('heading', { name: 'تلاش‌ها' });

    // The permission is revoked. This is an ANSWER, not a blip.
    detail.status = 403;
    detail.body = {
      error: {
        kind: 'forbidden',
        code: 'access.permission_denied',
        message: 'no',
        correlationId: 'test',
      },
    };
    // The detail polls every 3s while the intent is PENDING, which is how the
    // refusal reaches an already-open panel with no operator action.
    await vi.advanceTimersByTimeAsync(5_000);

    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'تلاش‌ها' })).toBeNull();
    });
    expect(screen.queryByRole('button', { name: 'تلاش دوباره' })).toBeNull();
    /*
     * And it names the refusal, not a connection failure.
     *
     * This card hard-coded the connection copy while the list card ABOVE IT ON
     * THE SAME SCREEN said "no permission" for the same 403 — two contradictory
     * diagnoses of one refusal, the wrong one sitting beside a retry that had
     * deliberately been removed.
     */
    expect(screen.getByText('شما به این بخش دسترسی ندارید.')).toBeInTheDocument();
    expect(screen.queryByText('خطا در ارتباط با سرور')).toBeNull();
    vi.useRealTimers();
  });

  /**
   * `attempts_exhausted` is a state a person has to notice. A failed intent
   * that renders identically to a sent one is the legacy "✅ updated" for a
   * write that did nothing.
   */
  /**
   * T29 — the STATUS, asserted directly.
   *
   * The two fixtures used to differ in template key, attempt count, completion
   * timestamp and id as well as status, so "the rows do not read the same" was
   * true however the status column behaved: delete it, or render every failed
   * intent as sent, and the inequality held. Everything but the status is
   * identical below, and the states are read out of the cells.
   */
  /**
   * F8, at the OTHER site — the one a whole-project mutation showed untested.
   *
   * `errorCopy` was introduced so this card and `StateSwitch` cannot give one
   * screen two diagnoses of one failure. Reverting THIS site alone to the
   * 403-only ternaries left all 281 tests green, which is the same shape as
   * every finding on this branch: the rule held where the author was looking
   * and nothing watched the other site. A structural fix that only one of its
   * two call sites tests is one edit away from being a local fix again.
   *
   * A 200 the schema rejects, as in the list-card test: contract skew is the
   * final answer an operator actually meets.
   */
  it('does not call a rejected detail a connection failure either', async () => {
    const detail = {
      url: '/notifications/n1',
      body: {
        notification: notification({ id: 'n1', status: 'PENDING' }),
        attempts: [],
        releasedClaims: [],
      } as unknown,
      status: 200,
    };
    stubApi([
      {
        url: '/notifications',
        body: {
          notifications: [notification({ id: 'n1', status: 'PENDING' })],
          nextCursor: null,
        },
      },
      detail,
    ]);
    renderPage(<NotificationsPage mayTest denied={false} />);
    await screen.findByText('event.panel.unreachable');

    // A deploy lands between the list and the detail: still 200, unreadable.
    detail.body = { notification: { id: 'n1' } };
    fireEvent.click(screen.getByRole('button', { name: 'event.panel.unreachable' }));

    expect(await screen.findByText(t('web.rejected'))).toBeInTheDocument();
    expect(screen.getByText(t('web.rejected_hint'))).toBeInTheDocument();
    expect(screen.queryByText(t('web.error'))).toBeNull();
    expect(screen.queryByText(t('web.error_hint'))).toBeNull();
    // Not a refusal: the server never said no.
    expect(screen.queryByText(t('web.no_permission'))).toBeNull();
  });

  it('distinguishes an abandoned intent from a delivered one', async () => {
    stubApi([
      {
        url: '/notifications',
        body: {
          nextCursor: null,
          notifications: [
            notification({ id: 'n1', status: 'SENT' }),
            // Identical in EVERY other respect, including the attempt count and
            // the completion timestamp, so the status is the only thing that
            // can make the two rows differ.
            notification({ id: 'n2', status: 'FAILED' }),
          ],
        },
      },
    ]);
    const { container } = renderPage(<NotificationsPage mayTest denied={false} />);
    await screen.findAllByText('event.panel.unreachable');

    const rows = Array.from(container.querySelectorAll('tbody tr'));
    expect(rows).toHaveLength(2);
    const texts = rows.map((row) => row.textContent ?? '');

    // Each state named, in the row that has it.
    expect(texts[0]).toContain(t('web.status_sent'));
    expect(texts[0]).not.toContain(t('web.status_failed'));
    expect(texts[1]).toContain(t('web.status_failed'));
    expect(texts[1]).not.toContain(t('web.status_sent'));
  });

  it('offers no test send to an actor without settings.edit', async () => {
    stubApi([{ url: '/notifications', body: { notifications: [], nextCursor: null } }]);
    const { container } = renderPage(<NotificationsPage mayTest={false} denied={false} />);
    await screen.findAllByText('اعلان‌ها');

    expect(screen.queryByRole('button', { name: /آزمایشی/ })).toBeNull();
    expect(container.textContent).toBeTruthy();
  });
});

describe('the notification pager', () => {
  /**
   * `GET /notifications` accepted a `before` in the repository all along, and
   * the controller never parsed it — so the newest page was the only page and
   * an intent past the fiftieth was unreachable from the Web Admin unless its
   * UUID was already known.
   */
  it('offers no older page when the server says there is none', async () => {
    stubApi([
      { url: '/notifications', body: { notifications: [notification()], nextCursor: null } },
    ]);
    renderPage(<NotificationsPage mayTest denied={false} />);
    await screen.findByText('event.panel.unreachable');

    expect(screen.getByRole('button', { name: 'قدیمی‌تر' })).toBeDisabled();
  });

  it('pages with the cursor the server returned, not one it guessed', async () => {
    const api = stubApi([
      {
        url: '/notifications',
        body: {
          notifications: [notification()],
          nextCursor: { at: '2026-09-06T08:00:00.000Z', id: 'n1' },
        },
      },
    ]);
    renderPage(<NotificationsPage mayTest denied={false} />);
    await screen.findByText('event.panel.unreachable');

    fireEvent.click(screen.getByRole('button', { name: 'قدیمی‌تر' }));
    await waitFor(() => {
      const paged = api.calls.find((call) => call.url.includes('beforeId'));
      expect(paged?.url).toContain('beforeId=n1');
      // Both halves: `createdAt` is not unique, and a strict comparison on it
      // alone drops the tail of a group that straddles a page boundary.
      expect(paged?.url).toContain('before=2026-09-06T08%3A00%3A00.000Z');
    });
  });
});
