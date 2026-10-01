import { afterEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { ProductDetailPage, ProductsPage } from '../../apps/web/src/pages/products';
import { ServiceLocationsPage } from '../../apps/web/src/pages/service-locations';
import { BroadcastDetailPage } from '../../apps/web/src/pages/broadcasts';
import { CampaignNewPage } from '../../apps/web/src/pages/campaigns';
import { ReportsPage } from '../../apps/web/src/pages/business';
import { LeaveGuardHost } from '../../apps/web/src/ui/kit';
import { navigate } from '../../apps/web/src/router';
import { t } from '../../apps/web/src/i18n/web.fa';
import { categoryListing, panel, product, renderPage, stubApi, type Api } from './harness';
import { BROADCASTS, RESELLERS, SERVICE_LOCATIONS } from './shots/fixtures/commerce-b.ts';

/**
 * What the COMMERCE-B redesign added on top of the pages' existing behaviour, each
 * pinned so a later presentation change cannot drop it silently: the editors' leave
 * guard and save-bar marker, problems said at their field only once a new form is
 * touched, the new confirmation dialogs (a service location delete that asked nothing,
 * the last question before a broadcast goes out), labelled campaign inputs (D2), and the
 * resellers report's link to a route that exists (D1).
 */

const PRODUCT_ID = String(product()['id']);

/** Moves the router itself, past any guard. */
const go = (url: string) => act(() => navigate(url, { replace: true, force: true }));

const posts = (api: Api, fragment: string) =>
  api.calls.filter((call) => call.method === 'POST' && call.url.includes(fragment));

afterEach(() => {
  go('/');
});

describe('the product editor', () => {
  const routes = [
    { url: `/products/${PRODUCT_ID}`, body: { product: product() } },
    { url: '/products', body: { products: [product()], nextCursor: null } },
    { url: '/panels', body: { panels: [panel()], nextCursor: null } },
    { url: '/product-categories', body: { categories: [categoryListing()] } },
  ];

  it('marks unsaved edits and asks before an in-app navigation leaves them', async () => {
    go(`/products/${PRODUCT_ID}`);
    stubApi(routes);
    renderPage(
      <>
        <ProductDetailPage id={PRODUCT_ID} mayEdit denied={false} />
        <LeaveGuardHost />
      </>,
    );
    const title = (await screen.findByLabelText('عنوان')) as HTMLInputElement;
    expect(screen.queryByText(t('web.unsaved_changes'))).toBeNull();

    fireEvent.change(title, { target: { value: 'پلن تازه' } });
    expect(screen.getByText(t('web.unsaved_changes'))).toBeInTheDocument();

    act(() => navigate('/orders'));
    expect(window.location.pathname).toBe(`/products/${PRODUCT_ID}`);
    const dialog = screen.getByRole('alertdialog', { name: t('web.unsaved_title') });
    fireEvent.click(within(dialog).getByRole('button', { name: t('web.unsaved_stay') }));
    expect(window.location.pathname).toBe(`/products/${PRODUCT_ID}`);

    // Put back as loaded, the page is clean again and a navigation is not held.
    fireEvent.change(title, { target: { value: String(product()['title']) } });
    expect(screen.queryByText(t('web.unsaved_changes'))).toBeNull();
    act(() => navigate('/orders'));
    expect(window.location.pathname).toBe('/orders');
  });

  it('offers a section list that moves to each section', async () => {
    stubApi(routes);
    renderPage(<ProductDetailPage id={PRODUCT_ID} mayEdit denied={false} />);
    await screen.findByLabelText('عنوان');
    const nav = screen.getByRole('navigation', { name: t('web.cb_sections') });
    fireEvent.click(within(nav).getByRole('button', { name: t('web.cb_section_pricing') }));
    await waitFor(() => expect(document.activeElement?.id).toBe('product-edit-pricing'));
  });

  it('says nothing wrong on a pristine new form, then names the problem at its field', async () => {
    stubApi(routes);
    renderPage(
      <ProductsPage
        route={{ path: '/products', query: new URLSearchParams() }}
        mayEdit
        denied={false}
      />,
    );
    const title = (await screen.findByLabelText('عنوان')) as HTMLInputElement;
    // Empty is where a new product starts, not an error — but it cannot be sent either.
    expect(screen.queryByText(t('web.product_problem_title'))).toBeNull();
    expect(screen.getByRole('button', { name: t('web.product_create') })).toBeDisabled();

    fireEvent.change(title, { target: { value: '   ' } });
    const error = await screen.findByText(t('web.product_problem_title'));
    // Beside the title, not in a banner somewhere else on the card.
    expect(error.closest('.field')?.querySelector('#product-title-create')).toBe(title);
  });
});

describe('the service location delete', () => {
  const LOCATION = SERVICE_LOCATIONS[1] as Record<string, unknown>;

  it('asks first, sends nothing when declined, and deletes once confirmed', async () => {
    const api = stubApi([
      { url: '/service-locations', body: { locations: [LOCATION] } },
      { url: `/service-locations/${String(LOCATION['id'])}/delete`, body: { deleted: true } },
      { url: '/panels', body: { panels: [panel()], nextCursor: null } },
      { url: '/products', body: { products: [], nextCursor: null } },
    ]);
    renderPage(<ServiceLocationsPage denied={false} mayEdit mayReadPanels />);
    const row = (await screen.findByText(String(LOCATION['label']))).closest('tr') as HTMLElement;

    fireEvent.click(within(row).getByRole('button', { name: t('web.service_locations_delete') }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: t('web.cb_cancel') }),
    );
    expect(posts(api, '/delete')).toHaveLength(0);

    fireEvent.click(within(row).getByRole('button', { name: t('web.service_locations_delete') }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', {
        name: t('web.cb_delete_yes'),
      }),
    );
    await waitFor(() => expect(posts(api, '/delete')).toHaveLength(1));
  });
});

describe('the broadcast send', () => {
  it('sends nothing when the final question is declined', async () => {
    const draft = BROADCASTS[0] as Record<string, unknown>;
    const id = String(draft['id']);
    const api = stubApi([
      {
        url: '/audience/options',
        body: { currency: 'IRT', resellerTiers: [], products: [], panels: [] },
      },
      { url: `/broadcasts/${id}`, body: { broadcast: draft } },
      {
        url: `/broadcasts/${id}/preview`,
        body: {
          preview: {
            asOf: '2026-09-20T10:00:00.000Z',
            definition: { version: 1 },
            definitionHash: draft['audienceHash'],
            customers: 12,
            reachable: 12,
            fingerprint: 'b'.repeat(32),
            sample: [],
          },
        },
      },
    ]);
    renderPage(<BroadcastDetailPage id={id} denied={false} maySend />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.bc_count') }));
    const send = await screen.findByRole('button', { name: t('web.bc_send_now') });
    fireEvent.click(screen.getByLabelText(t('web.bc_confirm_check')));
    fireEvent.click(send);

    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('12');
    fireEvent.click(within(dialog).getByRole('button', { name: t('web.cb_cancel') }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(posts(api, '/launch')).toHaveLength(0);
  });
});

describe('the campaign form', () => {
  it('labels its inputs, so each is found by its label (D2)', async () => {
    stubApi([
      {
        url: '/audience/options',
        body: { currency: 'IRT', resellerTiers: [], products: [], panels: [] },
      },
      { url: '/products', body: { products: [], nextCursor: null } },
      { url: '/product-categories', body: { categories: [] } },
      {
        url: '/campaigns?limit=1',
        body: {
          campaigns: [],
          nextCursor: null,
          presentation: { timezone: 'Asia/Tehran', calendar: 'jalali' },
        },
      },
    ]);
    renderPage(
      <CampaignNewPage
        denied={false}
        mayManage
        may={{
          discount: true,
          cashback: true,
          walletGift: true,
          serviceGift: true,
          announcement: true,
        }}
      />,
    );
    const name = await screen.findByLabelText(t('web.campaign_name'));
    expect(name.id).toBe('campaign-name');
    expect(screen.getByLabelText(t('web.campaign_description')).tagName).toBe('TEXTAREA');
    expect(screen.getByLabelText(t('web.campaign_start')).getAttribute('placeholder')).toBe(
      '1405-07-10',
    );
    // Each action's own fields, once it is switched on.
    const discount = screen
      .getByRole('heading', { name: t('web.campaign_action_discount') })
      .closest('section') as HTMLElement;
    fireEvent.click(within(discount).getByRole('checkbox'));
    expect(screen.getByLabelText(t('web.campaign_discount_value')).id).toBe(
      'campaign-discount-value',
    );
  });
});

describe('the resellers report', () => {
  it('links each reseller to the customer page, a route that exists (D1)', async () => {
    const reseller = RESELLERS[0] as Record<string, unknown>;
    const id = String(reseller['customerId']);
    stubApi([
      {
        url: '/reports/resellers',
        body: {
          period: {
            range: 'THIS_MONTH',
            timezone: 'Asia/Tehran',
            calendar: 'jalali',
            granularity: 'DAY',
            current: {
              start: '2026-08-22T20:30:00.000Z',
              end: '2026-09-22T20:30:00.000Z',
              effectiveEnd: '2026-09-06T08:00:00.000Z',
              startLocal: '1405/06/01',
              endLocalInclusive: '1405/06/31',
            },
            previous: {
              start: '2026-07-22T20:30:00.000Z',
              end: '2026-08-22T20:30:00.000Z',
              effectiveEnd: '2026-08-06T08:00:00.000Z',
              startLocal: '1405/05/01',
              endLocalInclusive: '1405/05/31',
            },
            lengthsDiffer: false,
            generatedAt: '2026-09-06T08:00:00.000Z',
          },
          rows: [
            {
              resellerCustomerId: id,
              tierName: 'طلایی',
              status: 'ACTIVE',
              orders: 3,
              sales: [{ currency: 'IRT', amount: '450000' }],
              services: 3,
              creditLimit: null,
              creditInUse: null,
            },
          ],
          truncated: false,
        },
      },
    ]);
    renderPage(
      <ReportsPage
        route={{ path: '/reports', query: new URLSearchParams('tab=resellers') }}
        denied={false}
      />,
    );
    const link = await screen.findByRole('link', { name: id.slice(-8) });
    expect(link.getAttribute('href')).toBe(`/users/${id}`);
  });
});
