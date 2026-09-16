import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
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

const detail = (overrides: Record<string, unknown> = {}, operations: unknown[] = [operation()]) => [
  { url: `/services/${SERVICE_ID}/operations`, body: { operations } },
  {
    url: `/services/${SERVICE_ID}`,
    body: {
      service: { ...service(overrides), deliveryAttempts: 1, deliveryNextAttemptAt: null },
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
   * The list is a read, and this asserts the ABSENCE of every write.
   *
   * `services.terminate` and `services.transfer` are declared permissions with no
   * endpoint, and the page draws no control for either — not even a disabled one, which
   * would claim "this exists and you lack permission". The only button is the search
   * submit, and the only inputs are its two filters.
   */
  it('offers no write: every request the page makes is a GET', async () => {
    const api = stubApi(list([service()]));
    const { container } = renderPage(<ServicesPage route={LIST_ROUTE} denied={false} />);
    await screen.findByText('nx-7f3a91');

    /*
     * The METHODS, not the button labels.
     *
     * Asserting that no button says "terminate" was the first version and it was
     * worthless: `پایان‌یافته` is a state FILTER, so the assertion failed on a pill
     * while a real terminate button would have been named something else and passed.
     * What makes this surface read-only is that it issues no write, and that is what
     * is asserted — a `POST /services/:id/terminate` added later fails here whatever
     * its button says.
     */
    expect(api.calls.map((call) => call.method)).toEqual(['GET']);
    // One form, and it is the filter: no create, no edit, no decision anywhere.
    expect(container.querySelectorAll('form')).toHaveLength(1);
    expect(container.querySelectorAll('form button[type="submit"]')).toHaveLength(1);
  });
});

describe('the service detail', () => {
  it('renders the identity, the traffic and the delivery of one service', async () => {
    stubApi(detail());
    renderPage(<ServiceDetailPage id={SERVICE_ID} denied={false} />);

    expect(await screen.findByText('nx-7f3a91')).toBeInTheDocument();
    expect(screen.getByText('4821')).toBeInTheDocument();
    // 50 GiB, formatted from the string the contract carries because a byte count
    // passes 2^53 and JSON has one number type.
    expect(screen.getByText(/50/)).toBeInTheDocument();
  });

  /** The same prohibition as on the list, on the screen that shows one service. */
  it('renders no subscription url on the detail either', async () => {
    stubApi(detail({ subscriptionUrl: 'https://panel.example/sub/DEADBEEFDEADBEEF' }));
    const { container } = renderPage(<ServiceDetailPage id={SERVICE_ID} denied={false} />);
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
    renderPage(<ServiceDetailPage id={SERVICE_ID} denied={false} />);

    expect(await screen.findByText(/معلوم نیست روی پنل کاربری/)).toBeInTheDocument();
    expect(screen.getByText(/کاربر تکراری روی پنل/)).toBeInTheDocument();
  });

  it('warns that an UNCONFIRMED delivery is not retried automatically', async () => {
    stubApi(detail({ deliveryState: 'UNCONFIRMED', deliveredAt: null }));
    renderPage(<ServiceDetailPage id={SERVICE_ID} denied={false} />);

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
    renderPage(<ServiceDetailPage id={SERVICE_ID} denied={false} />);

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
    renderPage(<ServiceDetailPage id={SERVICE_ID} denied={false} />);

    expect(await screen.findByText('panel refused: duplicate user')).toBeInTheDocument();
    expect(screen.getByText('خواندن مصرف')).toBeInTheDocument();
  });

  it('says a service has no operations rather than drawing an empty history', async () => {
    stubApi(detail({}, []));
    renderPage(<ServiceDetailPage id={SERVICE_ID} denied={false} />);

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
