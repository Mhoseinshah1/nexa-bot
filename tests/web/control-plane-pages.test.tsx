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
        url: '/revisions',
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
