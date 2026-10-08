import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { resolve } from '../../apps/web/src/app';
import {
  COUNTER_CAP,
  customerWorkspaceSchema,
  ticketListResponseSchema,
  type CustomerWorkspaceResponse,
} from '@nexa/contracts';
import { UserDetailPage } from '../../apps/web/src/pages/users';
import { customerAttentionItems, workspaceWithheld } from '../../apps/web/src/attention-view';
import { customerShortcuts } from '../../apps/web/src/pages/customer-360-workspace';
import { customer, renderPage, stubApi } from './harness';

/**
 * Roadmap B5 — Customer 360 as an operator's workspace: what waits for a person, the newest
 * orders and payments, the support tickets and the shortcuts. Every fixture goes through the
 * real API client and is parsed by the contract's schema; every deep link is asserted by its
 * exact href, because a link to the wrong filter is a link to the wrong work.
 */

const ID = '019210ab-cdef-7012-8345-6789abcdef01';
const OFF = {
  mayBlock: false,
  mayViewWallet: false,
  mayCredit: false,
  mayDebit: false,
  mayViewOrders: false,
  mayViewServices: false,
  mayEditTrial: false,
  mayViewReferrals: false,
  mayViewReseller: false,
  mayEditReseller: false,
} as const;

const ORDER_ID = '019210ab-cdef-7012-8345-6789abcd0001';
const PAYMENT_ID = '019210ab-cdef-7012-8345-6789abcd0002';
const TICKET_ID = '019210ab-cdef-7012-8345-6789abcd0003';
const CONVERSATION_ID = '019210ab-cdef-7012-8345-6789abcd0005';

const workspace = (
  overrides: Partial<CustomerWorkspaceResponse> = {},
): { workspace: CustomerWorkspaceResponse } => ({
  workspace: customerWorkspaceSchema.parse({
    generatedAt: '2026-10-07T10:00:00.000Z',
    tickets: { awaitingSupport: 2, open: 3 },
    businessHandoffs: 1,
    businessHandoffConversationId: CONVERSATION_ID,
    payments: {
      unknown: 1,
      latest: [
        {
          id: PAYMENT_ID,
          reference: 'NX-PAY-77',
          method: 'MANUAL_TRANSFER',
          state: 'UNKNOWN',
          amount: '250000',
          currency: 'IRT',
          createdAt: '2026-10-06T09:00:00.000Z',
        },
      ],
    },
    services: { unreconciled: 1 },
    orders: {
      latest: [
        {
          id: ORDER_ID,
          lineTitle: 'پلن طلایی',
          purpose: 'NEW_SERVICE',
          state: 'PAID',
          totalAmount: '250000',
          currency: 'IRT',
          createdAt: '2026-10-06T08:00:00.000Z',
        },
      ],
    },
    ...overrides,
  }),
});

const tickets = ticketListResponseSchema.parse({
  tickets: [
    {
      id: TICKET_ID,
      number: 42,
      status: 'WAITING_FOR_SUPPORT',
      priority: 'NORMAL',
      categoryId: '019210ab-cdef-7012-8345-6789abcd0004',
      categoryTitle: 'عمومی',
      subject: 'اتصال قطع است',
      customerId: ID,
      customerTelegramUserId: '5551234567',
      customerUsername: null,
      customerDisplayName: 'علی',
      assignedAdminId: null,
      assignedAdminUsername: null,
      serviceId: null,
      orderId: null,
      paymentId: null,
      createdAt: '2026-10-05T08:00:00.000Z',
      updatedAt: '2026-10-06T08:00:00.000Z',
      lastMessageAt: '2026-10-06T08:00:00.000Z',
      closedAt: null,
    },
  ],
  nextCursor: null,
});

const routes = (body = workspace(), extra: readonly { url: string; body: unknown }[] = []) => [
  { url: `/users/${ID}`, body: { customer: customer() } },
  { url: `/users/${ID}/workspace`, body },
  ...extra,
];

const hrefOf = (element: HTMLElement): string | null =>
  element.closest('a')?.getAttribute('href') ?? null;

describe('Customer 360 workspace — what waits for a person', () => {
  it('draws each server count as a link to the page that handles it, filtered to the customer', async () => {
    stubApi(routes());
    renderPage(<UserDetailPage id={ID} {...OFF} denied={false} />);
    const list = await screen.findByRole('list', { name: 'نیازمند رسیدگی' });
    const rows = within(list).getAllByRole('link');
    expect(rows.map((row) => row.getAttribute('href'))).toEqual([
      `/services?q=${ID}&state=UNRECONCILED`,
      `/payments?q=${ID}&queue=UNKNOWN`,
      // Review N2: one handoff opens the conversation itself.
      `/business-chats/${CONVERSATION_ID}`,
      // Review N1: the list filtered by the predicate the count uses.
      `/tickets?customer=${ID}&awaiting=support`,
    ]);
    expect(within(list).getByText('تیکت در انتظار پاسخ پشتیبانی')).toBeTruthy();
    // Every section was held: no "withheld" note.
    expect(screen.queryByText(/مجوز صفحهٔ آن‌ها را ندارید/u)).toBeNull();
  });

  it('opens the inbox filtered to handoffs when the customer has more than one', () => {
    const items = customerAttentionItems(ID, workspace({ businessHandoffs: 3 }).workspace);
    expect(items.find((item) => item.key === 'businessHandoffs')?.href).toBe(
      '/business-chats?state=HANDOFF_REQUIRED',
    );
  });

  it('draws no row for a zero or a withheld count, and says when sections were withheld', async () => {
    stubApi(
      routes(
        workspace({
          tickets: null,
          businessHandoffs: 0,
          services: { unreconciled: 0 },
        }),
      ),
    );
    renderPage(<UserDetailPage id={ID} {...OFF} denied={false} />);
    const list = await screen.findByRole('list', { name: 'نیازمند رسیدگی' });
    expect(
      within(list)
        .getAllByRole('link')
        .map((row) => row.getAttribute('href')),
    ).toEqual([`/payments?q=${ID}&queue=UNKNOWN`]);
    expect(screen.getByText(/مجوز صفحهٔ آن‌ها را ندارید/u)).toBeTruthy();
  });

  /*
   * Review N3. "Nothing waits" over a section that was not counted is a claim about rows
   * nobody read. With a counting section withheld and every counted one at zero, only the
   * withheld note is drawn — and with all four withheld, the same.
   */
  it('never says nothing waits while a counting section was withheld', async () => {
    stubApi(
      routes(
        workspace({
          tickets: null,
          businessHandoffs: 0,
          services: { unreconciled: 0 },
          payments: { unknown: 0, latest: [] },
        }),
      ),
    );
    renderPage(<UserDetailPage id={ID} {...OFF} denied={false} />);
    await screen.findByText(/مجوز صفحهٔ آن‌ها را ندارید/u);
    expect(screen.queryByText('برای این مشتری چیزی در انتظار رسیدگی نیست.')).toBeNull();
  });

  it('draws only the withheld note when no counting section was counted', async () => {
    stubApi(
      routes(workspace({ tickets: null, businessHandoffs: null, services: null, payments: null })),
    );
    renderPage(<UserDetailPage id={ID} {...OFF} denied={false} />);
    await screen.findByText(/مجوز صفحهٔ آن‌ها را ندارید/u);
    expect(screen.queryByText('برای این مشتری چیزی در انتظار رسیدگی نیست.')).toBeNull();
    expect(screen.queryByRole('list', { name: 'نیازمند رسیدگی' })).toBeNull();
  });

  it('does not report the latest orders, which add no row, as a withheld count', async () => {
    stubApi(
      routes(
        workspace({
          orders: null,
          tickets: { awaitingSupport: 0, open: 0 },
          businessHandoffs: 0,
          services: { unreconciled: 0 },
          payments: { unknown: 0, latest: [] },
        }),
      ),
    );
    renderPage(<UserDetailPage id={ID} {...OFF} denied={false} />);
    await screen.findByText('برای این مشتری چیزی در انتظار رسیدگی نیست.');
    expect(screen.queryByText(/مجوز صفحهٔ آن‌ها را ندارید/u)).toBeNull();
  });

  it('says nothing waits only when nothing does', async () => {
    stubApi(
      routes(
        workspace({
          tickets: { awaitingSupport: 0, open: 0 },
          businessHandoffs: 0,
          services: { unreconciled: 0 },
          payments: { unknown: 0, latest: [] },
        }),
      ),
    );
    renderPage(<UserDetailPage id={ID} {...OFF} denied={false} />);
    await screen.findByText('برای این مشتری چیزی در انتظار رسیدگی نیست.');
    expect(screen.queryByRole('list', { name: 'نیازمند رسیدگی' })).toBeNull();
  });

  it('marks a count at the cap as a floor', () => {
    const items = customerAttentionItems(
      ID,
      workspace({ payments: { unknown: COUNTER_CAP, latest: [] } }).workspace,
    );
    expect(items.find((item) => item.key === 'paymentsUnknown')?.atLeast).toBe(true);
    expect(items.find((item) => item.key === 'ticketsAwaitingSupport')?.atLeast).toBe(false);
  });

  it('knows a withheld section from a zero', () => {
    expect(workspaceWithheld(workspace().workspace)).toBe(false);
    // `orders` counts nothing for this card; only the four counting sections are reported.
    expect(workspaceWithheld(workspace({ orders: null }).workspace)).toBe(false);
    expect(workspaceWithheld(workspace({ services: null }).workspace)).toBe(true);
    expect(
      workspaceWithheld(workspace({ tickets: { awaitingSupport: 0, open: 0 } }).workspace),
    ).toBe(false);
  });
});

describe('Customer 360 workspace — the newest orders and payments', () => {
  it('links each newest row to its own page and each half to the full list', async () => {
    stubApi(routes());
    renderPage(<UserDetailPage id={ID} {...OFF} denied={false} />);
    const card = (await screen.findByText('آخرین سفارش‌ها و پرداخت‌ها')).closest('section');
    if (card === null) throw new Error('no card');
    const scoped = within(card as HTMLElement);
    await scoped.findByText('پلن طلایی');
    expect(hrefOf(scoped.getByText('پلن طلایی'))).toBe(`/orders/${ORDER_ID}`);
    expect(hrefOf(scoped.getByText('NX-PAY-77'))).toBe(`/payments/${PAYMENT_ID}`);
    expect(hrefOf(scoped.getByText('همهٔ سفارش‌های این مشتری'))).toBe(`/orders?q=${ID}`);
    expect(hrefOf(scoped.getByText('همهٔ پرداخت‌های این مشتری'))).toBe(`/payments?q=${ID}`);
  });

  it('names the permission a withheld half needs, and links to no list it cannot open', async () => {
    stubApi(routes(workspace({ orders: null, payments: null })));
    renderPage(<UserDetailPage id={ID} {...OFF} denied={false} />);
    await screen.findByText('برای دیدن سفارش‌ها مجوز orders.view لازم است.');
    expect(screen.getByText('برای دیدن پرداخت‌ها مجوز payments.view لازم است.')).toBeTruthy();
    expect(screen.queryByText('همهٔ پرداخت‌های این مشتری')).toBeNull();
  });
});

describe('Customer 360 workspace — support', () => {
  it('asks the inbox for this customer’s newest tickets and links each one', async () => {
    const api = stubApi(routes(workspace(), [{ url: '/tickets', body: tickets }]));
    renderPage(<UserDetailPage id={ID} {...OFF} mayViewTickets denied={false} />);
    const subject = await screen.findByText('اتصال قطع است');
    const card = subject.closest('section') as HTMLElement;
    expect(hrefOf(within(card).getByText('#42'))).toBe(`/tickets/${TICKET_ID}`);
    expect(hrefOf(within(card).getByText('همهٔ تیکت‌های این مشتری'))).toBe(
      `/tickets?customer=${ID}`,
    );
    // The open count is the server's, from the workspace.
    expect(within(card).getByText('تیکت باز', { exact: false })).toBeTruthy();
    const ask = api.calls.find((call) => call.url.includes('/tickets?'));
    expect(ask?.url).toContain(`customer=${ID}`);
    expect(ask?.url).toContain('limit=5');
  });

  it('names tickets.view and asks for nothing without it', async () => {
    const api = stubApi(routes(workspace(), [{ url: '/tickets', body: tickets }]));
    renderPage(<UserDetailPage id={ID} {...OFF} denied={false} />);
    await screen.findByText('برای دیدن تیکت‌های این مشتری دسترسی tickets.view لازم است.');
    await waitFor(() =>
      expect(api.calls.some((call) => call.url.includes('/workspace'))).toBe(true),
    );
    expect(api.calls.some((call) => call.url.includes('/tickets'))).toBe(false);
  });
});

describe('Customer 360 workspace — operator shortcuts', () => {
  it('draws only the shortcuts the viewer may open, each filtered to the customer', async () => {
    stubApi(routes());
    renderPage(
      <UserDetailPage
        id={ID}
        {...OFF}
        mayViewOrders
        mayViewPayments
        mayViewTickets
        denied={false}
      />,
    );
    const card = (await screen.findByText('میان‌برهای اپراتور')).closest('section') as HTMLElement;
    const links = within(card)
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'));
    expect(links).toEqual([`/orders?q=${ID}`, `/payments?q=${ID}`, `/tickets?customer=${ID}`]);
  });

  it('says so when no shortcut is open to the viewer', async () => {
    stubApi(routes());
    renderPage(<UserDetailPage id={ID} {...OFF} denied={false} />);
    await screen.findByText('با دسترسی‌های شما میان‌بری برای این مشتری وجود ندارد.');
  });

  it('maps every permission to its own shortcut and no other', () => {
    const none = {
      orders: false,
      services: false,
      payments: false,
      tickets: false,
      wallet: false,
      businessChats: false,
    };
    for (const key of Object.keys(none) as (keyof typeof none)[]) {
      const one = customerShortcuts(ID, { ...none, [key]: true });
      expect(one, key).toHaveLength(1);
    }
    expect(customerShortcuts(ID, none)).toEqual([]);
    expect(customerShortcuts(ID, { ...none, wallet: true })[0]?.href).toBe('#c360-wallet');
    expect(customerShortcuts(ID, { ...none, services: true })[0]?.href).toBe(`/services?q=${ID}`);
    expect(customerShortcuts(ID, { ...none, businessChats: true })[0]?.href).toBe(
      '/business-chats?state=HANDOFF_REQUIRED',
    );
  });
});

/*
 * The ROUTE deriving each new section from its OWN permission. The cases above pass the
 * props directly, which proves the page honours a prop and nothing about `app.tsx`
 * computing it: `mayViewTickets={may('users.view')}` would leave them all green. An actor
 * holding the key, and one holding only `users.view`, tell the two apart.
 */
describe('Customer 360 workspace — the route', () => {
  const at = (permissions: string[]) =>
    resolve({ path: `/users/${ID}`, query: new URLSearchParams() }, permissions as never)
      .element as ReactElement;

  it('asks for tickets and offers the payment and handoff shortcuts from their own keys', async () => {
    const api = stubApi(routes(workspace(), [{ url: '/tickets', body: tickets }]));
    renderPage(at(['users.view', 'tickets.view', 'payments.view', 'business_chats.view']));
    await screen.findByText('اتصال قطع است');
    expect(api.calls.some((call) => call.url.includes('/tickets?'))).toBe(true);
    const card = (await screen.findByText('میان‌برهای اپراتور')).closest('section') as HTMLElement;
    expect(
      within(card)
        .getAllByRole('link')
        .map((link) => link.getAttribute('href')),
    ).toEqual([
      `/payments?q=${ID}`,
      `/tickets?customer=${ID}`,
      '#c360-wallet',
      '/business-chats?state=HANDOFF_REQUIRED',
    ]);
  });

  it('withholds them all from an actor holding only users.view', async () => {
    const api = stubApi(routes(workspace(), [{ url: '/tickets', body: tickets }]));
    renderPage(at(['users.view']));
    await screen.findByText('برای دیدن تیکت‌های این مشتری دسترسی tickets.view لازم است.');
    const card = (await screen.findByText('میان‌برهای اپراتور')).closest('section') as HTMLElement;
    // `users.view` reads the wallet, and that is the only shortcut it opens.
    expect(
      within(card)
        .getAllByRole('link')
        .map((link) => link.getAttribute('href')),
    ).toEqual(['#c360-wallet']);
    expect(api.calls.some((call) => call.url.includes('/tickets'))).toBe(false);
  });
});
