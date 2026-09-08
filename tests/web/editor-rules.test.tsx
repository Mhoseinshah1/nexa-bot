import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { resolvedSettingSchema, templateViewSchema } from '@nexa/contracts';
import { App } from '../../apps/web/src/app';
import { ContentPage } from '../../apps/web/src/pages/content';
import { SettingsPage } from '../../apps/web/src/pages/settings';
import { SystemPage } from '../../apps/web/src/pages/system';
import { resolveTheme } from '../../apps/web/src/theme';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * Sixteen production rules that reverted with the whole gate green.
 *
 * An adversarial reviewer applied one mutation at a time to `content.tsx`,
 * `settings.tsx`, `app.tsx`, `system.tsx` and `theme.ts` and ran the web suite
 * after each: 306 of 306 passing, every time. Nineteen OTHER mutations in the
 * same sweep each killed between one and eight tests, so the harness was live
 * and these rules simply had nothing pointing at them.
 *
 * Two of them are worse than untested. `docs/phase3d-falsification.md` says of
 * round 19's settling bug: "`settings.tsx` and `content.tsx` had round 19's
 * settling bug unfixed … Both now guard on their own mutations' `isPending`."
 * The mutation table under that sentence cites `panels.test.tsx` four times and
 * neither sibling — the rule fixed and covered where the author was looking,
 * and shipped uncovered in the two files the same paragraph names.
 *
 * The whole template PREVIEW feature — the button, the sample fields, the
 * staleness marker, the unresolved-placeholder list — had no case in
 * `tests/web/` at all.
 *
 * Every fixture is parsed by the frozen schema first, so a contract change
 * fails here rather than rendering something the server would never send.
 */
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

const setting = (over: Record<string, unknown> = {}) =>
  resolvedSettingSchema.parse({
    key: 'ops.notifications.max_attempts',
    value: 5,
    source: 'DEFAULT',
    version: null,
    updatedAt: null,
    updatedByAdminId: null,
    description: 'How many times one notification may be attempted.',
    zeroMeaning: 'NOT_APPLICABLE',
    mutability: 'RUNTIME',
    classification: 'PUBLIC',
    configures: 'ops_notifications',
    consumer: 'ACTIVE',
    storedValueInvalid: false,
    ...over,
  });

const SESSION = {
  admin: {
    id: '01a05e35-c9ad-7e93-bef3-1ed9b55292c8',
    username: 'owner',
    displayName: 'مدیر اصلی',
    status: 'ACTIVE',
    telegramUserId: null,
    roleKeys: ['owner'],
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: '2026-09-06T08:00:00.000Z',
  },
  permissions: ['panels.view'],
  expiresAt: '2026-09-07T08:00:00.000Z',
};

const KEY = 'event.panel.unreachable';
const editor = () => document.getElementById(`body-${KEY}`) as HTMLTextAreaElement;
const sample = () => document.getElementById(`sample-${KEY}-panel_name`) as HTMLInputElement;
const saveButton = () => screen.getByRole('button', { name: t('web.save') });
const previewButton = () => screen.getByRole('button', { name: t('web.preview') });

/** The save the card actually issued, or `undefined` if it issued none. */
const savedBody = (calls: { url: string; method: string; body: unknown }[]) =>
  calls
    .filter(
      (call) =>
        call.method === 'POST' &&
        call.url.includes(`/templates/${KEY}`) &&
        // The preview posts to `/templates/:key/preview`, which contains the
        // save's own URL. A filter that did not say so counted a preview as a
        // save and made the two Enter-key assertions below unfalsifiable.
        !call.url.endsWith('/preview'),
    )
    .at(-1);

describe('the template editor', () => {
  it('sends the version the DRAFT was based on, not the row the query now holds', async () => {
    /*
     * The optimistic-concurrency rule, and the reason it is `basis` and not
     * `template`: `POST /templates/:key` has no expected-version check beyond
     * the one this payload carries. Comparing against the freshly fetched row
     * means another administrator's save is adopted silently and overwritten —
     * the exact lost update the version exists to refuse.
     */
    /*
     * The first version of this test could not fail, and the reason is worth
     * keeping: it moved the route's body and pressed Save, but nothing
     * REFETCHED in between, so `template` was still the row `basis` was taken
     * from and both spellings sent the same number.
     *
     * The refetch has to be driven the way production drives it — a conflicting
     * save invalidates the query — and the other administrator's row has to be
     * on screen before the second save is pressed.
     */
    const route = { url: '/templates', body: { templates: [template()] } as unknown };
    const api = stubApi([
      route,
      {
        url: `/templates/${KEY}`,
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
    await screen.findAllByText(KEY);

    // The draft is based on the row with NO override: version null.
    fireEvent.change(editor(), { target: { value: 'یک متن تازه' } });

    // Another administrator's row arrives through the refetch a conflict forces.
    route.body = {
      templates: [
        template({ overrideBody: 'متن دیگری', source: 'TENANT', version: 7, revision: 3 }),
      ],
    };
    fireEvent.click(saveButton());
    // The banner is the proof the refetch landed and `template` moved to 7
    // while `basis` stayed where the operator started.
    await screen.findByText(t('web.changed_elsewhere'));

    fireEvent.click(saveButton());
    await waitFor(() => expect(api.calls.filter((call) => call.method === 'POST').length).toBe(2));
    const sent = savedBody(api.calls)?.body as {
      expectedVersion: number | null;
      expectedRevision: number | null;
    };
    expect(sent.expectedVersion, 'the basis was version null; 7 is the other administrator').toBe(
      null,
    );
    expect(sent.expectedRevision).toBe(null);
  });

  it('does not blame somebody else for the write this card just made', async () => {
    /*
     * `save` adopts the row it was handed before the awaited invalidation
     * resolves, so for the width of that round trip `basis` carries the new
     * version while the query still carries the old. Without the `isPending`
     * guard the banner claims a conflict that cannot exist, because `basis` is
     * at that moment the newest revision anywhere.
     *
     * Driven through a save that never settles, which is exactly that window
     * held open.
     */
    /*
     * The window is narrow and has to be held open deliberately.
     *
     * `onSuccess` adopts the saved row and THEN awaits the invalidation, and
     * react-query keeps the mutation pending until `onSuccess` resolves. So
     * for the width of that refetch `basis` carries version 5 while the cached
     * row is still the original — `changedElsewhereStored` is true, and only
     * the `isPending` term stops the card telling the operator that their own
     * save was somebody else's.
     *
     * An earlier version of this test held the POST pending instead, which
     * never reaches the adopt at all: `basis` and the row stayed equal and the
     * assertion held with the guard deleted.
     */
    let landed = 0;
    const listing = (over: Record<string, unknown> = {}) =>
      new Response(JSON.stringify({ templates: [template(over)] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown, init?: RequestInit) => {
        const url = String(input);
        if ((init?.method ?? 'GET') === 'POST') {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                template: template({
                  version: 5,
                  revision: 2,
                  source: 'TENANT',
                  overrideBody: 'x',
                }),
                revision: 2,
                changed: true,
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          );
        }
        if (url.includes('/templates')) {
          landed += 1;
          // The FIRST listing answers; the refetch the save awaits never does,
          // which is what holds the settling window open.
          return landed === 1 ? Promise.resolve(listing()) : new Promise<Response>(() => {});
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      }),
    );

    renderPage(<ContentPage mayEdit denied={false} />);
    await screen.findAllByText(KEY);
    fireEvent.change(editor(), { target: { value: 'یک متن تازه' } });
    fireEvent.click(saveButton());

    // The adopt has happened and the refetch is still in flight.
    await waitFor(() => expect(landed).toBeGreaterThan(1));
    expect(
      screen.queryByText(t('web.changed_elsewhere')),
      'the write it is comparing against is this card’s own, still settling',
    ).toBeNull();
  });

  it('sees a revert as a change even though it restarts the version at 1', async () => {
    /*
     * A revert restarts the version, so `basis.version !== template.version`
     * alone reports "unchanged" across a revert-then-save — the one sequence
     * that silently overwrote the other administrator. The revision is what
     * distinguishes them, and it is the second half of the `||`.
     */
    const route = {
      url: '/templates',
      body: {
        templates: [template({ version: 1, revision: 4, source: 'TENANT', overrideBody: 'x' })],
      } as unknown,
    };
    stubApi([
      route,
      {
        url: `/templates/${KEY}`,
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
    await screen.findAllByText(KEY);
    expect(screen.queryByText(t('web.changed_elsewhere'))).toBeNull();

    /*
     * Reverted and saved again elsewhere: version back to 1, revision moved on.
     * Brought in the way production brings it in — a conflicting save
     * invalidates the query, which is the only path that refetches this card.
     */
    route.body = {
      templates: [template({ version: 1, revision: 5, source: 'TENANT', overrideBody: 'y' })],
    };
    fireEvent.change(editor(), { target: { value: 'یک متن تازه' } });
    fireEvent.click(saveButton());

    expect(
      await screen.findByText(t('web.changed_elsewhere')),
      'same version, different revision — still somebody else’s write',
    ).toBeInTheDocument();
  });
});

describe('the template preview', () => {
  const withPreview = (rendered: string) =>
    stubApi([
      { url: `/templates/${KEY}/preview`, body: { rendered, unresolved: [] } },
      { url: `/templates/${KEY}`, body: { template: template(), revision: 1, changed: true } },
      { url: '/templates', body: { templates: [template()] } },
    ]);

  it('renders a preview of the body and the sample values given', async () => {
    const api = withPreview('پنل Frankfurt A در دسترس نیست.');
    renderPage(<ContentPage mayEdit denied={false} />);
    await screen.findAllByText(KEY);

    fireEvent.change(sample(), { target: { value: 'Frankfurt A' } });
    fireEvent.click(previewButton());

    expect(await screen.findByText('پنل Frankfurt A در دسترس نیست.')).toBeInTheDocument();
    const request = api.calls.find((call) => call.url.includes(`/templates/${KEY}/preview`));
    expect(request?.body).toMatchObject({ values: { panel_name: 'Frankfurt A' } });
  });

  it('calls the preview stale when the SAMPLE VALUES move, not only the body', async () => {
    /*
     * `previewInput` is the body AND the sorted sample entries. Comparing only
     * the body left a preview rendered from `occurrences: 3` on screen after
     * the operator typed 10, with nothing said — a preview that is not of the
     * thing you are looking at, which is the confusion this screen exists to
     * end.
     */
    withPreview('پنل A در دسترس نیست.');
    renderPage(<ContentPage mayEdit denied={false} />);
    await screen.findAllByText(KEY);

    fireEvent.change(sample(), { target: { value: 'A' } });
    fireEvent.click(previewButton());
    await screen.findByText('پنل A در دسترس نیست.');
    expect(screen.queryByText(t('web.preview_stale'))).toBeNull();

    // The BODY is untouched; only a sample value moves.
    fireEvent.change(sample(), { target: { value: 'B' } });
    expect(await screen.findByText(t('web.preview_stale'))).toBeInTheDocument();
  });

  it('marks a preview stale against the input the REQUEST used', async () => {
    /*
     * The marker is set from the mutation's variables. Reading the render
     * closure in `onSuccess` recorded the NEW input when the body was edited
     * while a preview was in flight, so the arriving stale preview reported
     * itself as current — this mechanism's own failure mode, in its last
     * remaining form.
     */
    let release: ((value: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    stubApi([{ url: '/templates', body: { templates: [template()] } }]);
    const realFetch = globalThis.fetch as typeof fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown, init?: RequestInit) => {
        if (String(input).includes(`/templates/${KEY}/preview`)) return pending;
        return realFetch(input as RequestInfo, init);
      }),
    );

    renderPage(<ContentPage mayEdit denied={false} />);
    await screen.findAllByText(KEY);
    fireEvent.click(previewButton());

    // Edited WHILE the request is in flight.
    fireEvent.change(editor(), { target: { value: 'یک متن تازه' } });
    release?.(
      new Response(JSON.stringify({ rendered: 'قدیمی', unresolved: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    expect(
      await screen.findByText(t('web.preview_stale')),
      'the preview describes the body from before the edit',
    ).toBeInTheDocument();
  });

  it('names the placeholders the preview left unresolved', async () => {
    stubApi([
      {
        url: `/templates/${KEY}/preview`,
        body: { rendered: 'پنل {panel_name} در دسترس نیست.', unresolved: ['panel_name'] },
      },
      { url: '/templates', body: { templates: [template()] } },
    ]);
    renderPage(<ContentPage mayEdit denied={false} />);
    await screen.findAllByText(KEY);

    fireEvent.click(previewButton());
    expect(await screen.findByText(new RegExp(t('web.preview_unresolved')))).toBeInTheDocument();
  });

  it('previews on Enter in a sample field, and does not save', async () => {
    /*
     * These fields sit inside the SAVE form. HTML implicit submission made
     * Enter here store the draft body — the one action on this card that
     * pressing again does not undo, reached from the control furthest from it
     * in intent. For a `templates.view` actor the Save button is not rendered
     * at all and `bot.ping.reply` declares exactly one placeholder, which is
     * precisely the "no submit button and one blocking field" shape the spec
     * says submits: the request then came back as a permission denial, writing
     * a DENIED audit row and an `access.permission_denied` operational event
     * for a save nobody asked for.
     */
    const api = withPreview('پنل Z در دسترس نیست.');
    renderPage(<ContentPage mayEdit denied={false} />);
    await screen.findAllByText(KEY);

    fireEvent.change(sample(), { target: { value: 'Z' } });
    fireEvent.keyDown(sample(), { key: 'Enter' });

    expect(await screen.findByText('پنل Z در دسترس نیست.')).toBeInTheDocument();
    expect(savedBody(api.calls), 'Enter in a preview field must never write').toBeUndefined();
  });

  it('ignores a submit that no submit control produced', async () => {
    /*
     * The backstop for the same defect one field later. `submitter` is null
     * for implicit submission with no default button, and that is the shape a
     * viewer's card has — so the form refuses it rather than trusting that
     * every future field will remember to swallow Enter.
     */
    const api = withPreview('x');
    renderPage(<ContentPage mayEdit denied={false} />);
    await screen.findAllByText(KEY);
    fireEvent.change(editor(), { target: { value: 'یک متن تازه' } });

    const form = editor().closest('form');
    expect(form).not.toBeNull();
    fireEvent.submit(form as HTMLFormElement);

    await waitFor(() => expect(api.calls.length).toBeGreaterThan(0));
    expect(savedBody(api.calls)).toBeUndefined();
    // And the ordinary press still saves, so the guard is not simply "never".
    fireEvent.click(saveButton());
    await waitFor(() => expect(savedBody(api.calls)).toBeDefined());
  });
});

describe('what the template card tells the operator', () => {
  it('says a save stored nothing when the server says it changed nothing', async () => {
    stubApi([
      { url: `/templates/${KEY}`, body: { template: template(), revision: 1, changed: false } },
      { url: '/templates', body: { templates: [template()] } },
    ]);
    renderPage(<ContentPage mayEdit denied={false} />);
    await screen.findAllByText(KEY);
    fireEvent.change(editor(), { target: { value: 'یک متن تازه' } });
    fireEvent.click(saveButton());

    expect(await screen.findByText(t('web.unchanged'))).toBeInTheDocument();
    expect(screen.queryByText(t('web.saved'))).toBeNull();
  });

  it('offers to discard an unsaved edit, and says there is one', async () => {
    stubApi([{ url: '/templates', body: { templates: [template()] } }]);
    renderPage(<ContentPage mayEdit denied={false} />);
    await screen.findAllByText(KEY);
    expect(screen.queryByText(t('web.unsaved_changes'))).toBeNull();

    fireEvent.change(editor(), { target: { value: 'یک متن تازه' } });
    expect(await screen.findByText(t('web.unsaved_changes'))).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: t('web.discard') }));
    await waitFor(() => expect(editor().value).toBe('پنل {panel_name} در دسترس نیست.'));
    expect(screen.queryByText(t('web.unsaved_changes'))).toBeNull();
  });

  it('warns when a stored override is being suppressed', async () => {
    stubApi([
      {
        url: '/templates',
        body: {
          templates: [
            template({
              overrideSuppressed: true,
              overrideBody: 'x',
              source: 'DEFAULT',
              version: 2,
            }),
          ],
        },
      },
    ]);
    renderPage(<ContentPage mayEdit denied={false} />);
    expect(await screen.findByText(t('web.override_suppressed'))).toBeInTheDocument();
  });
});

describe('the settings editor', () => {
  const NUMBER_KEY = 'ops.notifications.max_attempts';
  const field = () => document.getElementById(`value-${NUMBER_KEY}`) as HTMLInputElement;

  it('sends the version the DRAFT was based on', async () => {
    // Same correction as the template editor's: nothing REFETCHES between
    // moving the route body and pressing Save, so both spellings send the same
    // number unless the conflict that invalidates the query is driven first.
    const route = { url: '/settings', body: { settings: [setting()] } as unknown };
    const api = stubApi([
      route,
      {
        url: `/settings/${NUMBER_KEY}`,
        status: 409,
        body: {
          error: {
            kind: 'conflict',
            code: 'control.setting_version_conflict',
            message: 'somebody else changed it',
            correlationId: 'test',
          },
        },
      },
    ]);
    renderPage(<SettingsPage mayEdit denied={false} />);
    await screen.findAllByText(NUMBER_KEY);

    fireEvent.change(field(), { target: { value: '9' } });
    route.body = { settings: [setting({ value: 4, source: 'TENANT', version: 6 })] };
    fireEvent.click(screen.getAllByRole('button', { name: t('web.save') })[0] as HTMLElement);
    await screen.findByText(t('web.changed_elsewhere'));

    fireEvent.click(screen.getAllByRole('button', { name: t('web.save') })[0] as HTMLElement);
    await waitFor(() => expect(api.calls.filter((call) => call.method === 'POST').length).toBe(2));
    const sent = api.calls.filter((call) => call.method === 'POST').at(-1)?.body as {
      expectedVersion: number | null;
    };
    expect(sent.expectedVersion, 'the basis was version null; 6 is the other administrator').toBe(
      null,
    );
  });

  it('does not blame somebody else for the write this editor just made', async () => {
    // The settling window, held open the same way as the template card's: the
    // save succeeds and adopts version 5, and the refetch it awaits never
    // lands, so `basis` and the cached row disagree while `isPending` is true.
    let landed = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown, init?: RequestInit) => {
        const url = String(input);
        if ((init?.method ?? 'GET') === 'POST') {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                setting: setting({ value: 9, source: 'TENANT', version: 5 }),
                changed: true,
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          );
        }
        if (url.includes('/settings')) {
          landed += 1;
          return landed === 1
            ? Promise.resolve(
                new Response(JSON.stringify({ settings: [setting()] }), {
                  status: 200,
                  headers: { 'content-type': 'application/json' },
                }),
              )
            : new Promise<Response>(() => {});
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      }),
    );

    renderPage(<SettingsPage mayEdit denied={false} />);
    await screen.findAllByText(NUMBER_KEY);
    fireEvent.change(field(), { target: { value: '9' } });
    fireEvent.click(screen.getAllByRole('button', { name: t('web.save') })[0] as HTMLElement);

    await waitFor(() => expect(landed).toBeGreaterThan(1));
    expect(
      screen.queryByText(t('web.changed_elsewhere')),
      'the write it is comparing against is this editor’s own, still settling',
    ).toBeNull();
  });

  it('resets the typed value when the editor is re-based on a fresh row', async () => {
    /*
     * The field's `key` carries the basis version, so adopting a fresh row
     * REMOUNTS the input. Without that the operator presses "load the fresh
     * value", the basis moves, and the text field keeps the string they were
     * abandoning — an editor showing one value while claiming to be based on
     * another.
     */
    const route = { url: '/settings', body: { settings: [setting()] } as unknown };
    stubApi([
      route,
      {
        url: `/settings/${NUMBER_KEY}`,
        status: 409,
        body: {
          error: {
            kind: 'conflict',
            code: 'control.setting_version_conflict',
            message: 'somebody else changed it',
            correlationId: 'test',
          },
        },
      },
    ]);
    renderPage(<SettingsPage mayEdit denied={false} />);
    await screen.findAllByText(NUMBER_KEY);

    fireEvent.change(field(), { target: { value: '9' } });
    expect(field().value).toBe('9');

    // A conflicting save is what refetches, exactly as in production.
    route.body = { settings: [setting({ value: 4, source: 'TENANT', version: 6 })] };
    fireEvent.click(screen.getAllByRole('button', { name: t('web.save') })[0] as HTMLElement);

    fireEvent.click(await screen.findByRole('button', { name: t('web.reload_value') }));
    await waitFor(() => expect(field().value).toBe('4'));
  });
});

describe('the shell sidebar', () => {
  /** A `MediaQueryList` whose `change` listeners this test can actually fire. */
  const controllableMedia = () => {
    const listeners: ((event: MediaQueryListEvent) => void)[] = [];
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: (query: string) =>
        ({
          matches: /prefers-color-scheme:\s*light/.test(query),
          media: query,
          onchange: null,
          addEventListener: (_: string, fn: (event: MediaQueryListEvent) => void) => {
            if (query.includes('max-width')) listeners.push(fn);
          },
          removeEventListener: () => undefined,
          addListener: () => undefined,
          removeListener: () => undefined,
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList,
    });
    return (matches: boolean) => {
      for (const fn of [...listeners]) fn({ matches } as MediaQueryListEvent);
    };
  };

  it('follows the viewport until the operator decides, and then stops', async () => {
    /*
     * The comment above this rule used to say the state was "owned by the
     * operator" while the listener overwrote their choice on every crossing of
     * the breakpoint: expand at 900px, drag to 1000px and back, and it
     * re-collapsed. `touched` is the whole rule, and nothing pointed at it.
     */
    const cross = controllableMedia();
    stubApi([
      { url: '/auth/session', body: SESSION },
      { url: '/system/readiness', body: { readiness: { ready: true, checks: [] } } },
    ]);
    renderPage(<App />);

    const toggle = await screen.findByLabelText(t('web.toggle_sidebar'));
    // Untouched: the viewport still decides, in both directions.
    act(() => cross(true));
    await waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('false'));
    act(() => cross(false));
    await waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('true'));

    // The operator collapses it deliberately.
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('false'));

    // A widening viewport must NOT reopen it now.
    act(() => cross(false));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      toggle.getAttribute('aria-expanded'),
      'the breakpoint stopped deciding when the operator did',
    ).toBe('false');
  });
});

describe('the system page and the theme', () => {
  it('falls back to the status section for a `section` it does not know', async () => {
    stubApi([{ url: '/system/readiness', body: { readiness: { ready: true, checks: [] } } }]);
    const route = {
      path: '/system',
      query: new URLSearchParams('section=../admins'),
    } as unknown as Parameters<typeof SystemPage>[0]['route'];
    renderPage(<SystemPage route={route} permissions={[]} />);
    // The tab strip is rendered from the known sections; an unknown value must
    // land on `status` rather than selecting nothing at all.
    expect(await screen.findByText(t('web.system_title'))).toBeInTheDocument();
    expect(document.querySelector('[aria-selected="true"]')?.textContent).toBe(t('web.status'));
  });

  it('follows the operating system only while the choice is `system`', () => {
    expect(resolveTheme('system', true)).toBe('light');
    expect(resolveTheme('system', false)).toBe('dark');
    // An explicit choice ignores the OS in both directions.
    expect(resolveTheme('light', false)).toBe('light');
    expect(resolveTheme('dark', true)).toBe('dark');
  });
});
