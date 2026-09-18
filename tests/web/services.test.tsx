import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  SERVICE_OPERATOR_ACTIONS,
  type ServiceActionBlocker,
  type ServiceOperatorAction,
} from '@nexa/contracts';
import type { ReactElement } from 'react';
import { ServiceDetailPage, ServicesPage } from '../../apps/web/src/pages/services';
import { resolve } from '../../apps/web/src/app';
import { PLANNED_SURFACES } from '../../apps/web/src/pages/planned';
import { renderPage, stubApi } from './harness';

/**
 * Services, rendered against the shapes the server actually returns.
 *
 * Every fixture goes through the real API client and is parsed by
 * `serviceSummarySchema` / `serviceDetailSchema` / `serviceOperationSchema` — the same
 * schemas the server validates against — so a fixture that drifted from the contract
 * fails here rather than in production.
 *
 * Three things this file defends beyond rendering:
 *
 *   - the page hands over NO capability. A case below asserts that a subscription URL,
 *     a subscription ref and a provider client id appear nowhere in the markup even
 *     when a hostile server volunteers all three — the contract omits them, and this
 *     proves the page does not reintroduce them from a response it was not promised.
 *   - `state` and `deliveryState` never collapse. A provisioned service whose message
 *     bounced must not read as unprovisioned; the remedy an operator would reach for is
 *     to provision it again, on somebody's panel, a second time.
 *   - owner revisions 12, 13 and 14 moved HERE from the placeholder this route
 *     replaced, and are asserted on the live page rather than on a screen nobody can
 *     open. `planned-and-absent.test.tsx` used to carry them.
 */

const LIST_ROUTE = { path: '/services', query: new URLSearchParams() };
const SERVICE_ID = '019250ab-cdef-7012-8345-6789abcdef01';
const CUSTOMER_ID = '019210ab-cdef-7012-8345-6789abcdef01';
const ORDER_ID = '019230ab-cdef-7012-8345-6789abcdef01';
const PANEL_ID = '019220ab-cdef-7012-8345-6789abcdef01';
const PRODUCT_ID = '019215ab-cdef-7012-8345-6789abcdef01';

function service(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SERVICE_ID,
    customerId: CUSTOMER_ID,
    orderId: ORDER_ID,
    panelId: PANEL_ID,
    productId: PRODUCT_ID,
    state: 'ACTIVE',
    providerUsername: 'nx-7f3a91',
    providerUserId: '4821',
    hasSubscription: true,
    expiresAt: '2026-12-01T00:00:00.000Z',
    trafficLimitBytes: '53687091200',
    trafficUsedBytes: '1073741824',
    usageSyncedAt: '2026-09-15T08:00:00.000Z',
    deliveryState: 'DELIVERED',
    deliveredAt: '2026-09-10T12:35:00.000Z',
    provisionedAt: '2026-09-10T12:34:00.000Z',
    terminatedAt: null,
    createdAt: '2026-09-10T12:30:00.000Z',
    updatedAt: '2026-09-10T12:35:00.000Z',
    ...overrides,
  };
}

function operation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '019250cd-cdef-7012-8345-6789abcdef01',
    type: 'PROVISION',
    state: 'SUCCEEDED',
    attempts: 1,
    failureMessage: null,
    scheduledAt: null,
    startedAt: '2026-09-10T12:33:00.000Z',
    completedAt: '2026-09-10T12:34:00.000Z',
    createdAt: '2026-09-10T12:30:00.000Z',
    ...overrides,
  };
}

const list = (services: unknown[], nextCursor: string | null = null) => [
  { url: '/services', body: { services, nextCursor } },
];

/**
 * Every action refused, which is the shape this release's detail page renders.
 *
 * `actions` is declared by `serviceDetailSchema` as of Phase 6A, so a fixture without
 * it fails the client's own parse — which is the seam working. The page does not draw
 * buttons yet; the cases that do belong with the screen that has them.
 */
const NO_ACTIONS = SERVICE_OPERATOR_ACTIONS.map((action) => ({
  action,
  available: false,
  blocker: 'STATE' as const,
}));

/**
 * An action matrix with named exceptions, as the server would send it.
 *
 * Everything refused for `STATE` unless a case says otherwise, so each case turns on
 * exactly the verdict it is about. `available: true` carries `blocker: null`, which the
 * contract requires — a fixture that got that wrong would not parse.
 */
const actionsWith = (
  over: Partial<Record<ServiceOperatorAction, ServiceActionBlocker | 'AVAILABLE'>>,
): unknown[] =>
  SERVICE_OPERATOR_ACTIONS.map((action) => {
    const verdict = over[action];
    if (verdict === undefined) return { action, available: false, blocker: 'STATE' };
    if (verdict === 'AVAILABLE') return { action, available: true, blocker: null };
    return { action, available: false, blocker: verdict };
  });

/** The POST route for one action, answering with the service and the operation. */
const actionRoute = (path: string, over: Record<string, unknown> = {}, planned = true) => ({
  url: `/services/${SERVICE_ID}/${path}`,
  body: {
    service: {
      deliveryAttempts: 1,
      deliveryNextAttemptAt: null,
      actions: NO_ACTIONS,
      ...service(over),
    },
    operation: planned ? operation({ type: 'SUSPEND', state: 'PLANNED' }) : null,
  },
});

const detail = (overrides: Record<string, unknown> = {}, operations: unknown[] = [operation()]) => [
  { url: `/services/${SERVICE_ID}/operations`, body: { operations } },
  {
    url: `/services/${SERVICE_ID}`,
    body: {
      service: {
        deliveryAttempts: 1,
        deliveryNextAttemptAt: null,
        actions: NO_ACTIONS,
        /* Last, so a case may override any of the three above by passing it. */
        ...service(overrides),
      },
    },
  },
];

describe('the service list', () => {
  it('renders a service with its username, state and delivery state', async () => {
    stubApi(list([service()]));
    renderPage(<ServicesPage route={LIST_ROUTE} denied={false} />);

    expect(await screen.findByText('nx-7f3a91')).toBeInTheDocument();
    // Inside the TABLE, not the filter pills above it — both carry these labels, and a
    // bare `getByText` would pass on the pill while the column rendered nothing.
    const table = screen.getByRole('table');
    expect(within(table).getByText('فعال')).toBeInTheDocument();
    expect(within(table).getByText('به مشتری رسید')).toBeInTheDocument();
  });

  /**
   * The rule the whole surface exists under, asserted against a HOSTILE response.
   *
   * The fixture volunteers all three bearer values. `serviceSummarySchema` does not
   * declare them, so a page that rendered one would have had to reach past the parsed
   * object — and that is precisely the refactor this case is here to fail.
   */
  it('renders no subscription url, no subscription ref and no provider client id', async () => {
    stubApi(
      list([
        service({
          subscriptionUrl: 'https://panel.example/sub/DEADBEEFDEADBEEF',
          subscriptionRef: 'DEADBEEFDEADBEEF',
          providerClientId: '11112222-3333-4444-5555-666677778888',
        }),
      ]),
    );
    const { container } = renderPage(<ServicesPage route={LIST_ROUTE} denied={false} />);
    await screen.findByText('nx-7f3a91');

    const markup = container.innerHTML;
    expect(markup).not.toContain('DEADBEEFDEADBEEF');
    expect(markup).not.toContain('panel.example');
    expect(markup).not.toContain('11112222-3333-4444-5555-666677778888');
    // And no masked stand-in either: `********` is a value somebody can try to resubmit,
    // which is the reason ADR-0023 gives about panel passwords.
    expect(markup).not.toContain('********');
  });

  /**
   * Two axes, not one.
   *
   * An `ACTIVE` service whose announcement was refused must read as active AND
   * undelivered. A page that collapsed them would show it as failed, and the remedy an
   * operator reaches for then is a second provider account for somebody who has one.
   */
  it('shows an active service whose delivery failed as active, and separately as failed', async () => {
    stubApi(list([service({ state: 'ACTIVE', deliveryState: 'FAILED' })]));
    renderPage(<ServicesPage route={LIST_ROUTE} denied={false} />);
    await screen.findByText('nx-7f3a91');

    const table = screen.getByRole('table');
    expect(within(table).getByText('فعال')).toBeInTheDocument();
    expect(within(table).getByText('رد شد')).toBeInTheDocument();
  });

  it('says the list is empty rather than drawing an empty table', async () => {
    stubApi(list([]));
    renderPage(<ServicesPage route={LIST_ROUTE} denied={false} />);

    expect(await screen.findByText('هنوز سرویسی ساخته نشده است.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  /**
   * The LIST is still a read, and this asserts the absence of every write on it.
   *
   * Phase 6A put the seven actions on the DETAIL, not here: a column of buttons over a
   * page of services is how a mis-click terminates the wrong customer's account. So the
   * list issues no write, and that is asserted by the METHODS rather than by button
   * labels — the first version of this case checked that no button said "terminate" and
   * was worthless, because `پایان‌یافته` is a state FILTER, so it failed on a pill while
   * a real terminate button named anything else would have passed.
   */
  it('offers no write from the list: every request it makes is a GET', async () => {
    const api = stubApi(list([service()]));
    const { container } = renderPage(<ServicesPage route={LIST_ROUTE} denied={false} />);
    await screen.findByText('nx-7f3a91');

    expect(api.calls.map((call) => call.method)).toEqual(['GET']);
    // One form, and it is the filter: no create, no edit, no decision anywhere.
    expect(container.querySelectorAll('form')).toHaveLength(1);
    expect(container.querySelectorAll('form button[type="submit"]')).toHaveLength(1);
  });
});

describe('the service detail', () => {
  it('renders the identity, the traffic and the delivery of one service', async () => {
    stubApi(detail());
    renderPage(<ServiceDetailPage id={SERVICE_ID} denied={false} mayEdit mayTerminate />);

    expect(await screen.findByText('nx-7f3a91')).toBeInTheDocument();
    expect(screen.getByText('4821')).toBeInTheDocument();
    // 50 GiB, formatted from the string the contract carries because a byte count
    // passes 2^53 and JSON has one number type.
    expect(screen.getByText(/50/)).toBeInTheDocument();
  });

  /** The same prohibition as on the list, on the screen that shows one service. */
  it('renders no subscription url on the detail either', async () => {
    stubApi(detail({ subscriptionUrl: 'https://panel.example/sub/DEADBEEFDEADBEEF' }));
    const { container } = renderPage(
      <ServiceDetailPage id={SERVICE_ID} denied={false} mayEdit mayTerminate />,
    );
    await screen.findByText('nx-7f3a91');

    expect(container.innerHTML).not.toContain('DEADBEEFDEADBEEF');
    // And it says the link is WITHHELD rather than leaving an operator to conclude the
    // service has none.
    expect(screen.getByText(/لینک اشتراک در این صفحه نشان داده نمی‌شود/)).toBeInTheDocument();
  });

  /**
   * `UNRECONCILED` is an absence of knowledge, and the banner must not invite a rebuild.
   *
   * The state exists to prevent a duplicate provider account. Copy that suggested
   * trying again would undo the only thing it is for.
   */
  it('warns on UNRECONCILED without suggesting the service be created again', async () => {
    stubApi(detail({ state: 'UNRECONCILED', providerUserId: null, provisionedAt: null }));
    renderPage(<ServiceDetailPage id={SERVICE_ID} denied={false} mayEdit mayTerminate />);

    expect(await screen.findByText(/معلوم نیست روی پنل کاربری/)).toBeInTheDocument();
    expect(screen.getByText(/کاربر تکراری روی پنل/)).toBeInTheDocument();
  });

  it('warns that an UNCONFIRMED delivery is not retried automatically', async () => {
    stubApi(detail({ deliveryState: 'UNCONFIRMED', deliveredAt: null }));
    renderPage(<ServiceDetailPage id={SERVICE_ID} denied={false} mayEdit mayTerminate />);

    expect(await screen.findByText(/نتیجهٔ اعلام به مشتری نامشخص است/)).toBeInTheDocument();
  });

  /**
   * "Never read from the panel" is an ANSWER, not a missing value.
   *
   * A dash beside a used-traffic figure reads as "nothing to report", which would let a
   * counter written at provisioning time pass for a live reading — the legacy
   * statistics screen's defect exactly.
   */
  it('says usage has never been read rather than showing a dash', async () => {
    stubApi(detail({ usageSyncedAt: null }));
    renderPage(<ServiceDetailPage id={SERVICE_ID} denied={false} mayEdit mayTerminate />);

    expect(await screen.findByText('هرگز از پنل خوانده نشده است.')).toBeInTheDocument();
  });

  it('renders the operation history with the adapter failure message', async () => {
    stubApi(
      detail({}, [
        operation({
          type: 'SYNC_USAGE',
          state: 'FAILED',
          attempts: 2,
          failureMessage: 'panel refused: duplicate user',
          completedAt: null,
          scheduledAt: '2026-09-16T10:00:00.000Z',
        }),
      ]),
    );
    renderPage(<ServiceDetailPage id={SERVICE_ID} denied={false} mayEdit mayTerminate />);

    expect(await screen.findByText('panel refused: duplicate user')).toBeInTheDocument();
    expect(screen.getByText('خواندن مصرف')).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // The seven actions
  // -------------------------------------------------------------------------

  it('draws a button for every action the server declares, and no others', async () => {
    /*
     * The list comes from the RESPONSE. A page that invented an eighth control, or
     * dropped one this release has, is the defect the server-side evaluator exists to
     * make impossible — and this is the assertion that keeps the page honest about it.
     */
    stubApi(detail({ actions: actionsWith({}) }));
    renderPage(<ServiceDetailPage id={SERVICE_ID} denied={false} mayEdit mayTerminate />);
    await screen.findByText('nx-7f3a91');

    for (const label of [
      'به‌روزرسانی مصرف از پنل',
      'ارسال مجدد لینک به مشتری',
      'تلاش مجدد برای ساخت روی پنل',
      'تطبیق با پنل',
      'موقتاً غیرفعال کن',
      'دوباره فعال کن',
    ]) {
      expect(screen.getByRole('button', { name: label }), label).toBeInTheDocument();
    }
  });

  it('disables a refused action and says WHY, rather than leaving it greyed out', async () => {
    /*
     * The blocker code becomes a sentence naming the screen or the wait that resolves
     * it. A greyed-out control with no reason is the legacy panel's entire style of
     * refusal, and each of these three sends an operator somewhere different.
     */
    stubApi(
      detail({
        actions: actionsWith({
          SUSPEND: 'CAPABILITY',
          SYNC_USAGE: 'PANEL_NOT_OPERABLE',
          RECONCILE: 'IN_PROGRESS',
        }),
      }),
    );
    renderPage(<ServiceDetailPage id={SERVICE_ID} denied={false} mayEdit mayTerminate />);
    await screen.findByText('nx-7f3a91');

    expect(screen.getByRole('button', { name: 'موقتاً غیرفعال کن' })).toBeDisabled();
    expect(screen.getByText(/نوع پنل این سرویس چنین کاری را پشتیبانی نمی‌کند/)).toBeInTheDocument();
    expect(screen.getByText(/پنل این سرویس در حال حاضر قابل استفاده نیست/)).toBeInTheDocument();
    expect(screen.getByText(/یک عملیات از همین نوع در جریان است/)).toBeInTheDocument();
  });

  it('posts the action the button names, with an idempotency key', async () => {
    const api = stubApi([
      ...detail({ state: 'ACTIVE', actions: actionsWith({ SUSPEND: 'AVAILABLE' }) }),
      actionRoute('suspend', { state: 'ACTIVE' }),
    ]);
    renderPage(<ServiceDetailPage id={SERVICE_ID} denied={false} mayEdit mayTerminate />);
    const button = await screen.findByRole('button', { name: 'موقتاً غیرفعال کن' });

    fireEvent.click(button);

    await waitFor(() => {
      expect(api.calls.some((call) => call.method === 'POST')).toBe(true);
    });
    const post = api.calls.find((call) => call.method === 'POST');
    expect(post?.url).toContain(`/services/${SERVICE_ID}/suspend`);
    expect((post?.body as { idempotencyKey?: string }).idempotencyKey).toMatch(/.{8,}/);
  });

  it('reports a planned operation as recorded, never as done', async () => {
    /*
     * The operation comes back `PLANNED`: no provider has been called. "Done" here
     * would be the legacy "✅ updated" for a write whose effect has not happened, and
     * for the action that deletes an account that difference is the whole point.
     */
    stubApi([
      ...detail({ state: 'ACTIVE', actions: actionsWith({ SUSPEND: 'AVAILABLE' }) }),
      actionRoute('suspend', { state: 'ACTIVE' }),
    ]);
    renderPage(<ServiceDetailPage id={SERVICE_ID} denied={false} mayEdit mayTerminate />);

    fireEvent.click(await screen.findByRole('button', { name: 'موقتاً غیرفعال کن' }));

    expect(await screen.findByText(/درخواست ثبت شد/)).toBeInTheDocument();
  });

  it('says a resend was sent, because it plans no operation at all', async () => {
    /* `operation: null` is the honest answer for a resend, and the copy follows it. */
    stubApi([
      ...detail({ state: 'ACTIVE', actions: actionsWith({ RESEND_CONFIG: 'AVAILABLE' }) }),
      actionRoute('resend', { state: 'ACTIVE' }, false),
    ]);
    renderPage(<ServiceDetailPage id={SERVICE_ID} denied={false} mayEdit mayTerminate />);

    fireEvent.click(await screen.findByRole('button', { name: 'ارسال مجدد لینک به مشتری' }));

    expect(await screen.findByText(/لینک برای مشتری فرستاده شد/)).toBeInTheDocument();
  });

  it('refuses every action to a session without services.edit, in a sentence', async () => {
    /*
     * Told, not hidden. A control that can never work records an
     * `access.permission_denied` event and a DENIED audit row when pressed, which is
     * the noise the alerts page exists to keep clear — and an absent control says
     * nothing about why it is absent.
     *
     * The matrix still says AVAILABLE, because the matrix is about the SERVICE. The
     * permission is the session's, and the two are deliberately separate.
     */
    const api = stubApi(
      detail({ state: 'ACTIVE', actions: actionsWith({ SUSPEND: 'AVAILABLE' }) }),
    );
    renderPage(
      <ServiceDetailPage id={SERVICE_ID} denied={false} mayEdit={false} mayTerminate={false} />,
    );
    await screen.findByText('nx-7f3a91');

    expect(screen.getByText(/به دسترسی «ویرایش سرویس» نیاز دارید/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'موقتاً غیرفعال کن' })).toBeDisabled();
    expect(api.calls.map((call) => call.method)).toEqual(['GET', 'GET']);
  });

  it('separates the terminate permission from the other six', async () => {
    /*
     * `services.terminate` is its own HIGH-risk key held by `owner` alone in the frozen
     * catalogue. A session with `services.edit` gets the six and is told, in a
     * sentence, why it does not get the seventh.
     */
    stubApi(
      detail({
        state: 'ACTIVE',
        actions: actionsWith({ SUSPEND: 'AVAILABLE', TERMINATE: 'AVAILABLE' }),
      }),
    );
    renderPage(<ServiceDetailPage id={SERVICE_ID} denied={false} mayEdit mayTerminate={false} />);
    await screen.findByText('nx-7f3a91');

    expect(screen.getByRole('button', { name: 'موقتاً غیرفعال کن' })).toBeEnabled();
    expect(screen.getByText(/پایان دادن به سرویس دسترسی جداگانه‌ای دارد/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'پایان بده' })).toBeNull();
  });

  it('keeps the terminate button unpressable until the phrase matches exactly', async () => {
    /*
     * The typed phrase, for the reason `RECOVERY_CONFIRMATION_PHRASE` gives: terminate
     * deletes the account on somebody's panel and the customer keeps the order they
     * paid for, so the confirmation has to cost more than a mis-click. A near-miss is
     * not a confirmation, and the server compares it again in full.
     */
    stubApi([
      ...detail({ state: 'ACTIVE', actions: actionsWith({ TERMINATE: 'AVAILABLE' }) }),
      actionRoute('terminate', { state: 'ACTIVE' }),
    ]);
    const { container } = renderPage(
      <ServiceDetailPage id={SERVICE_ID} denied={false} mayEdit mayTerminate />,
    );
    await screen.findByText('nx-7f3a91');

    const button = screen.getByRole('button', { name: 'پایان بده' });
    expect(button).toBeDisabled();

    const input = container.querySelector('input[dir="ltr"]');
    if (input === null) throw new Error('no confirmation input');

    fireEvent.change(input, { target: { value: 'terminate' } });
    expect(screen.getByText('عبارت تأیید مطابقت ندارد.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'پایان بده' })).toBeDisabled();

    fireEvent.change(input, { target: { value: 'TERMINATE' } });
    expect(screen.getByRole('button', { name: 'پایان بده' })).toBeEnabled();
  });

  it('sends the phrase with the terminate, so the server can check it again', async () => {
    const api = stubApi([
      ...detail({ state: 'ACTIVE', actions: actionsWith({ TERMINATE: 'AVAILABLE' }) }),
      actionRoute('terminate', { state: 'TERMINATED' }),
    ]);
    const { container } = renderPage(
      <ServiceDetailPage id={SERVICE_ID} denied={false} mayEdit mayTerminate />,
    );
    await screen.findByText('nx-7f3a91');

    const input = container.querySelector('input[dir="ltr"]');
    if (input === null) throw new Error('no confirmation input');
    fireEvent.change(input, { target: { value: 'TERMINATE' } });
    fireEvent.click(screen.getByRole('button', { name: 'پایان بده' }));

    await waitFor(() => {
      expect(api.calls.some((call) => call.method === 'POST')).toBe(true);
    });
    const post = api.calls.find((call) => call.method === 'POST');
    expect(post?.url).toContain('/terminate');
    expect((post?.body as { confirm?: string }).confirm).toBe('TERMINATE');
  });

  it('re-reads the service and its history after an action', async () => {
    /*
     * Both queries, not just the row. The action planned an operation, so the history
     * on the same screen changed too — and a screen that refreshed only the row would
     * leave the operator's own press absent from the one list that says whether it did
     * anything.
     */
    const api = stubApi([
      ...detail({ state: 'ACTIVE', actions: actionsWith({ SUSPEND: 'AVAILABLE' }) }),
      actionRoute('suspend', { state: 'ACTIVE' }),
    ]);
    renderPage(<ServiceDetailPage id={SERVICE_ID} denied={false} mayEdit mayTerminate />);
    fireEvent.click(await screen.findByRole('button', { name: 'موقتاً غیرفعال کن' }));
    await screen.findByText(/درخواست ثبت شد/);

    await waitFor(() => {
      const reads = api.calls.filter((call) => call.method === 'GET');
      expect(reads.filter((call) => call.url.includes('/operations')).length).toBeGreaterThan(1);
      expect(reads.filter((call) => !call.url.includes('/operations')).length).toBeGreaterThan(1);
    });
  });

  it('still says a transfer is not built, rather than drawing a disabled button', async () => {
    stubApi(detail());
    renderPage(<ServiceDetailPage id={SERVICE_ID} denied={false} mayEdit mayTerminate />);
    await screen.findByText('nx-7f3a91');

    expect(
      screen.getByText(/انتقال سرویس به مشتری دیگر در این نسخه ساخته نشده است/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /انتقال/ })).toBeNull();
  });

  it('says a service has no operations rather than drawing an empty history', async () => {
    stubApi(detail({}, []));
    renderPage(<ServiceDetailPage id={SERVICE_ID} denied={false} mayEdit mayTerminate />);

    expect(await screen.findByText('هیچ عملیاتی روی این سرویس ثبت نشده است.')).toBeInTheDocument();
  });
});

/**
 * The promotion itself.
 *
 * `/services` was a planned placeholder until 4H. These three cases are the ones that
 * lived in `planned-and-absent.test.tsx` and moved WITH the copy: owner revisions 12,
 * 13 and 14 are recorded on the live page now, and a page that dropped one would pass
 * every rendering case above.
 */
describe('the promotion of /services', () => {
  const renderList = () => {
    stubApi(list([]));
    const resolved = resolve({ path: '/services', query: new URLSearchParams() }, [
      'services.view',
    ]);
    return renderPage(resolved.element as ReactElement);
  };

  it('resolves the real page, not the planned placeholder', () => {
    const { container } = renderList();
    expect(screen.queryByText('چرا هنوز فعال نیست')).toBeNull();
    // The placeholder draws nothing pressable; the real page draws its filter form.
    expect(container.querySelectorAll('button').length).toBeGreaterThan(0);
  });

  it('is gone from PLANNED_SURFACES, so the placeholder cannot shadow it', () => {
    expect(PLANNED_SURFACES.map((surface) => surface.key)).not.toContain('services');
  });

  /** Owner revision 12 — protocol is not a normal service field. */
  it('records that protocol stays out of the normal services UI', () => {
    const { container } = renderList();
    const text = container.textContent ?? '';
    const sentence = text.split('.').find((part) => part.includes('پروتکل'));
    expect(sentence).toBeDefined();
    expect(sentence).toContain('نمایش داده نمی‌شود');
    expect(sentence).toContain('لینک اشتراک');
    // And nothing on the page is a protocol FIELD: no label, no column, no control.
    expect(screen.queryByLabelText(/پروتکل/)).toBeNull();
  });

  /** Owner revisions 13 and 14 — server ordering, and a plan filter that replaces location. */
  it('records the ordering rule and the plan filter, and no location filter', () => {
    const { container } = renderList();
    const text = container.textContent ?? '';
    expect(text).toContain('created_at');
    expect(text).toContain('id');
    expect(text).toContain('پلن');
    expect(text).toContain('لوکیشن'); // only as the thing being removed
    expect(text).toContain('وجود نخواهد داشت');
    // The filter it says does not exist, does not exist.
    expect(screen.queryByLabelText(/لوکیشن/)).toBeNull();
  });

  /**
   * Revision 13 is not only copy any more.
   *
   * The repository pages `(created_at, id)` DESCENDING because of it, so the pager's
   * "next" really is the OLDER page — which is `CursorPager`'s default orientation.
   * `/users`, `/orders` and `/products` page ascending and pass the opposite labels
   * explicitly; a services page that copied their `nextLabel="web.newer"` would tell
   * an operator that paging forward went forward in time while it went back.
   *
   * Asserted on the BUTTON ORDER rather than on presence, because both words appear on
   * the pager either way — which is exactly why the mistake is invisible by eye.
   */
  it('labels the next page older, the way a descending list must', async () => {
    stubApi(list([service()], 'cursor-2'));
    const { container } = renderPage(<ServicesPage route={LIST_ROUTE} denied={false} />);
    await screen.findByText('nx-7f3a91');

    const pager = container.querySelector('.pager');
    expect(pager).not.toBeNull();
    const labels = [...pager!.querySelectorAll('button')].map((b) => b.textContent ?? '');
    expect(labels).toEqual(['تازه‌تر', 'قدیمی‌تر']);
  });

  it('refuses to render the list at all without services.view', () => {
    stubApi(list([service()]));
    renderPage(<ServicesPage route={LIST_ROUTE} denied={true} />);
    expect(screen.getByText('شما به این بخش دسترسی ندارید.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });
});
