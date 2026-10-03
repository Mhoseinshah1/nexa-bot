import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { CUSTOMER_TAG_COLORS, type CustomerTagColor } from '@nexa/contracts';
import { UserDetailPage, UsersPage } from '../../apps/web/src/pages/users';
import {
  CustomerCrmSection,
  TAG_COLOR_LABELS,
  TagCatalogueModal,
} from '../../apps/web/src/pages/customer-360-crm';
import type { Tone } from '../../apps/web/src/ui/kit';
import { customer, renderPage, stubApi } from './harness';

/**
 * Customer notes and tags in the Web Admin (program §8), rendered against the shapes the
 * server returns — every fixture goes through the real API client and its contract schema.
 *
 * Asserted: the colours ARE the design system's tones; the list's tag filter is a filter by
 * id beside the status chips (not a second search); Customer 360 shows a customer's tags,
 * archived ones marked, and its notes with author and time; every control is drawn only
 * under its own permission and every write carries an idempotency key.
 */

const ID = '019210ab-cdef-7012-8345-6789abcdef01';
const VIP = '019210ab-cdef-7012-8345-00000000a001';
const OLD = '019210ab-cdef-7012-8345-00000000a002';
const RISK = '019210ab-cdef-7012-8345-00000000a003';

const tag = (id: string, label: string, extra: Record<string, unknown> = {}) => ({
  id,
  label,
  color: null,
  archivedAt: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  ...extra,
});
const assigned = (base: ReturnType<typeof tag>) => ({
  ...base,
  assignedAt: '2026-09-02T00:00:00.000Z',
});

const CATALOGUE = [
  tag(VIP, 'مشتری ویژه', { color: 'violet' }),
  tag(RISK, 'پرریسک', { color: 'danger' }),
  tag(OLD, 'قدیمی', { archivedAt: '2026-09-03T00:00:00.000Z' }),
];

const crmRoutes = (extra: readonly { url: string; body: unknown; status?: number }[] = []) => [
  { url: '/customer-tags', body: { tags: CATALOGUE } },
  {
    url: `/users/${ID}/tags`,
    body: { tags: [assigned(CATALOGUE[0] as never), assigned(CATALOGUE[2] as never)] },
  },
  {
    url: `/users/${ID}/notes`,
    body: {
      notes: [
        {
          id: '019210ab-cdef-7012-8345-00000000b001',
          body: 'تماس گرفت؛ قول تمدید داد.\nفردا پیگیری شود.',
          authorAdminId: null,
          authorLabel: 'op-maryam',
          createdAt: '2026-09-05T09:00:00.000Z',
        },
      ],
      nextCursor: null,
    },
  },
  ...extra,
];

const ALL = { mayViewNotes: true, mayWriteNotes: true, mayAssignTags: true, mayManageTags: true };
const NONE = {
  mayViewNotes: false,
  mayWriteNotes: false,
  mayAssignTags: false,
  mayManageTags: false,
};

describe('tag colours', () => {
  it('are exactly the design system tones, each with a Persian name', () => {
    // Type-level, both directions: a tone the kit gains or a colour the contract gains
    // without the other fails to compile.
    const asTones: readonly Tone[] = CUSTOMER_TAG_COLORS;
    const exhaustive: [Exclude<Tone, CustomerTagColor>] extends [never] ? true : false = true;
    expect(exhaustive).toBe(true);
    expect([...asTones].sort()).toEqual(Object.keys(TAG_COLOR_LABELS).sort());
  });
});

describe('the customer list tag filter', () => {
  it('offers the catalogue beside the status filter and writes the tag ID to the URL', async () => {
    window.history.replaceState(null, '', '/users');
    stubApi([
      { url: '/users', body: { customers: [customer()], nextCursor: null } },
      { url: '/customer-tags', body: { tags: CATALOGUE } },
    ]);
    renderPage(
      <UsersPage
        route={{ path: '/users', query: new URLSearchParams() }}
        maySearch
        denied={false}
      />,
    );
    const select = (await screen.findByLabelText('برچسب')) as HTMLSelectElement;
    const options = within(select)
      .getAllByRole('option')
      .map((option) => option.textContent);
    // Archived tags stay filterable — history keeps naming them — and say so.
    expect(options).toEqual(['همهٔ برچسب‌ها', 'مشتری ویژه', 'پرریسک', 'قدیمی (بایگانی‌شده)']);
    fireEvent.change(select, { target: { value: VIP } });
    expect(new URLSearchParams(window.location.search).get('tag')).toBe(VIP);
  });

  it('sends the applied tag with the list request, and drops a value that is not an id', async () => {
    const api = stubApi([
      { url: '/users', body: { customers: [customer()], nextCursor: null } },
      { url: '/customer-tags', body: { tags: CATALOGUE } },
    ]);
    const { unmount } = renderPage(
      <UsersPage
        route={{ path: '/users', query: new URLSearchParams({ tag: VIP, status: 'ACTIVE' }) }}
        maySearch
        denied={false}
      />,
    );
    await screen.findByText('5551234567');
    const listCall = api.calls.find((call) => call.url.includes('/users?'));
    expect(listCall?.url).toContain(`tag=${VIP}`);
    expect(listCall?.url).toContain('status=ACTIVE');
    unmount();

    const again = stubApi([
      { url: '/users', body: { customers: [customer()], nextCursor: null } },
      { url: '/customer-tags', body: { tags: CATALOGUE } },
    ]);
    renderPage(
      <UsersPage
        route={{ path: '/users', query: new URLSearchParams({ tag: 'VIP' }) }}
        maySearch
        denied={false}
      />,
    );
    await screen.findByText('5551234567');
    expect(again.calls.some((call) => call.url.includes('tag='))).toBe(false);
  });

  it('offers the catalogue editor only for users.tags.manage', async () => {
    stubApi([
      { url: '/users', body: { customers: [customer()], nextCursor: null } },
      { url: '/customer-tags', body: { tags: CATALOGUE } },
    ]);
    const { rerender } = renderPage(
      <UsersPage
        route={{ path: '/users', query: new URLSearchParams() }}
        maySearch
        denied={false}
      />,
    );
    await screen.findByText('5551234567');
    expect(screen.queryByRole('button', { name: 'مدیریت برچسب‌ها' })).toBeNull();
    rerender(
      <UsersPage
        route={{ path: '/users', query: new URLSearchParams() }}
        maySearch
        mayManageTags
        denied={false}
      />,
    );
    expect(await screen.findByRole('button', { name: 'مدیریت برچسب‌ها' })).toBeTruthy();
  });
});

describe('Customer 360 — notes and tags', () => {
  it('shows the tags, archived ones marked, and the notes with author and line breaks', async () => {
    stubApi(crmRoutes());
    const { container } = renderPage(<CustomerCrmSection customerId={ID} {...ALL} />);
    const list = await screen.findByRole('list', { name: 'برچسب‌ها' });
    expect(list.textContent).toContain('مشتری ویژه');
    expect(list.textContent).toContain('قدیمی · بایگانی‌شده');
    const body = await screen.findByText(/قول تمدید داد/);
    expect(body.textContent).toBe('تماس گرفت؛ قول تمدید داد.\nفردا پیگیری شود.');
    expect(container.textContent).toContain('op-maryam');
    // Append-only: there is nothing to edit or delete on a note.
    const notes = container.querySelector('.crm-notes') as HTMLElement;
    expect(within(notes).queryAllByRole('button')).toEqual([]);
  });

  it('draws no write and reads no note without the permissions', async () => {
    const api = stubApi(crmRoutes());
    renderPage(<CustomerCrmSection customerId={ID} {...NONE} />);
    await screen.findByRole('list', { name: 'برچسب‌ها' });
    expect(screen.getByText('خواندن یادداشت‌ها مجوز users.notes.view می‌خواهد.')).toBeTruthy();
    expect(
      screen.getByText('افزودن یا برداشتن برچسب مجوز users.tags.assign می‌خواهد.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /برداشتن برچسب/ })).toBeNull();
    expect(screen.queryByLabelText('یادداشت تازه')).toBeNull();
    expect(screen.queryByRole('button', { name: 'مدیریت برچسب‌ها' })).toBeNull();
    expect(api.calls.some((call) => call.url.includes('/notes'))).toBe(false);
    // The catalogue is read only to offer an assignment.
    expect(api.calls.some((call) => call.url.endsWith('/customer-tags'))).toBe(false);
  });

  it('offers only active, unassigned tags, and assigns by id with an idempotency key', async () => {
    const api = stubApi(
      crmRoutes([
        {
          url: `/users/${ID}/tags`,
          body: { tags: [assigned(CATALOGUE[0] as never)] },
        },
      ]),
    );
    renderPage(<CustomerCrmSection customerId={ID} {...ALL} />);
    const picker = (await screen.findByLabelText('افزودن برچسب')) as HTMLSelectElement;
    await waitFor(() =>
      expect(
        within(picker)
          .getAllByRole('option')
          .map((option) => option.textContent),
      ).toEqual(['یک برچسب انتخاب کنید', 'پرریسک']),
    );
    fireEvent.change(picker, { target: { value: RISK } });
    fireEvent.click(screen.getByRole('button', { name: 'افزودن' }));
    await waitFor(() =>
      expect(
        api.calls.some((call) => call.method === 'POST' && call.url.endsWith(`/users/${ID}/tags`)),
      ).toBe(true),
    );
    const post = api.calls.find((call) => call.method === 'POST') as {
      body: Record<string, unknown>;
    };
    expect(post.body['tagId']).toBe(RISK);
    expect(typeof post.body['idempotencyKey']).toBe('string');
    expect(Object.keys(post.body).sort()).toEqual(['idempotencyKey', 'tagId']);
  });

  it('removes a tag, archived ones included', async () => {
    const api = stubApi(
      crmRoutes([{ url: `/users/${ID}/tags/remove`, body: { tags: [], changed: true } }]),
    );
    renderPage(<CustomerCrmSection customerId={ID} {...ALL} />);
    fireEvent.click(await screen.findByRole('button', { name: 'برداشتن برچسب قدیمی' }));
    await waitFor(() =>
      expect(api.calls.some((call) => call.url.endsWith(`/users/${ID}/tags/remove`))).toBe(true),
    );
    const remove = api.calls.find((call) => call.url.endsWith('/tags/remove')) as {
      body: Record<string, unknown>;
    };
    expect(remove.body['tagId']).toBe(OLD);
  });

  it('appends a note with an idempotency key, and refuses an empty one', async () => {
    const api = stubApi(
      crmRoutes([
        {
          url: `/users/${ID}/notes`,
          body: {
            notes: [],
            nextCursor: null,
            note: {
              id: '019210ab-cdef-7012-8345-00000000b002',
              body: 'x',
              authorAdminId: null,
              authorLabel: 'me',
              createdAt: '2026-09-06T00:00:00.000Z',
            },
            created: true,
          },
        },
      ]),
    );
    renderPage(<CustomerCrmSection customerId={ID} {...ALL} />);
    const field = (await screen.findByLabelText('یادداشت تازه')) as HTMLTextAreaElement;
    const add = screen.getByRole('button', { name: 'ثبت یادداشت' });
    fireEvent.change(field, { target: { value: '   ' } });
    expect((add as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(field, { target: { value: '  پیگیری بازپرداخت  ' } });
    fireEvent.click(add);
    await waitFor(() =>
      expect(api.calls.some((call) => call.method === 'POST' && call.url.endsWith('/notes'))).toBe(
        true,
      ),
    );
    const post = api.calls.find((call) => call.method === 'POST') as {
      body: Record<string, unknown>;
    };
    expect(post.body['body']).toBe('پیگیری بازپرداخت');
    expect(typeof post.body['idempotencyKey']).toBe('string');
  });

  it('is part of the customer page, with its own entry in the section list', async () => {
    stubApi([{ url: `/users/${ID}`, body: { customer: customer() } }, ...crmRoutes()]);
    const { container } = renderPage(
      <UserDetailPage
        id={ID}
        mayBlock={false}
        mayViewWallet={false}
        mayCredit={false}
        mayDebit={false}
        mayViewOrders={false}
        mayViewServices={false}
        mayEditTrial={false}
        mayViewReferrals={false}
        mayViewReseller={false}
        mayEditReseller={false}
        mayViewNotes
        denied={false}
      />,
    );
    await screen.findByText(/قول تمدید داد/);
    expect(container.querySelector('a[href="#c360-crm"]')?.textContent).toBe(
      'یادداشت‌ها و برچسب‌ها',
    );
    expect(container.querySelector('#c360-crm')).not.toBeNull();
  });
});

describe('the tag catalogue editor', () => {
  it('creates a tag with a design tone, sending the normalised label and a key', async () => {
    const api = stubApi([{ url: '/customer-tags', body: { tags: CATALOGUE } }]);
    renderPage(<TagCatalogueModal open onClose={() => undefined} />);
    await screen.findByText('پرریسک');
    fireEvent.change(screen.getByLabelText('نام برچسب'), { target: { value: '  VIP   ویژه ' } });
    fireEvent.change(screen.getByLabelText('رنگ'), { target: { value: 'teal' } });
    fireEvent.click(screen.getByRole('button', { name: 'ساخت برچسب' }));
    await waitFor(() => expect(api.calls.some((call) => call.method === 'POST')).toBe(true));
    const post = api.calls.find((call) => call.method === 'POST') as {
      body: Record<string, unknown>;
    };
    expect(post.body['label']).toBe('VIP ویژه');
    expect(post.body['color']).toBe('teal');
    expect(typeof post.body['idempotencyKey']).toBe('string');
  });

  it('renames by id and shows the duplicate-name refusal in Persian', async () => {
    const api = stubApi([
      { url: '/customer-tags', body: { tags: CATALOGUE } },
      {
        url: `/customer-tags/${RISK}`,
        status: 409,
        body: {
          error: {
            kind: 'conflict',
            code: 'commerce.customer_tag_name_taken',
            message: 'taken',
            correlationId: 'test',
          },
        },
      },
    ]);
    renderPage(<TagCatalogueModal open onClose={() => undefined} />);
    await screen.findByText('پرریسک');
    const row = screen.getByText('پرریسک').closest('li') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'ویرایش' }));
    // The modal is a portal: look it up in the document, not the render container.
    const input = document.getElementById(`crm-edit-${RISK}`) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'مشتری ویژه' } });
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره' }));
    expect(await screen.findByText('برچسب فعال دیگری با همین نام هست.')).toBeTruthy();
    const post = api.calls.find((call) => call.method === 'POST') as {
      url: string;
      body: Record<string, unknown>;
    };
    expect(post.url).toContain(`/customer-tags/${RISK}`);
    expect(post.body).toMatchObject({ label: 'مشتری ویژه', color: 'danger' });
  });

  it('offers archive for an active tag and restore for an archived one', async () => {
    stubApi([{ url: '/customer-tags', body: { tags: CATALOGUE } }]);
    renderPage(<TagCatalogueModal open onClose={() => undefined} />);
    await screen.findByText('پرریسک');
    expect(screen.getAllByRole('button', { name: 'بایگانی' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'بازگردانی' })).toHaveLength(1);
  });
});
