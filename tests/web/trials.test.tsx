import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { UserDetailPage } from '../../apps/web/src/pages/users';
import { TrialsPage } from '../../apps/web/src/pages/trials';
import { customer, renderPage, stubApi } from './harness';

/**
 * WP6-B on the Web Admin: the customer's trial card and the Trials page.
 *
 * Every figure is the server's; these tests hold what the screen DOES with it — echo the
 * stored override rather than a computed one, name the permission it lacks rather than
 * hide the control, and send the count the operator TYPED as the reset's confirmation.
 */

const ROW_ID = '019210ab-cdef-7012-8345-6789abcdef01';
const OFF = {
  mayViewWallet: false,
  mayCredit: false,
  mayDebit: false,
  mayViewOrders: false,
  mayViewServices: false,
} as const;

const allowance = (overrides: Record<string, unknown> = {}) => ({
  trial: {
    customerId: ROW_ID,
    featureEnabled: true,
    globalLimit: 1,
    override: null,
    effectiveLimit: 1,
    used: 1,
    remaining: 0,
    ...overrides,
  },
});

describe("the customer's trial card", () => {
  it('echoes the stored override and sends a new one with a key', async () => {
    const api = stubApi([
      { url: `/users/${ROW_ID}`, body: { customer: customer() } },
      {
        url: `/users/${ROW_ID}/trial`,
        body: allowance({
          override: { limit: 3, setAt: '2026-09-20T10:00:00.000Z' },
          effectiveLimit: 3,
          remaining: 2,
        }),
      },
      {
        url: `/users/${ROW_ID}/trial/override`,
        body: allowance({
          override: { limit: 5, setAt: '2026-09-21T10:00:00.000Z' },
          effectiveLimit: 5,
          remaining: 4,
        }),
      },
    ]);
    renderPage(
      <UserDetailPage id={ROW_ID} mayBlock={false} mayEditTrial {...OFF} denied={false} />,
    );

    // The override as stored, beside the default it replaces.
    expect(await screen.findByText('سقف اختصاصی')).toBeInTheDocument();
    // Twice: the stored override and the effective limit it produces.
    expect(screen.getAllByText('3')).toHaveLength(2);
    expect(screen.queryByText('ندارد (از سقف پیش‌فرض پیروی می‌کند)')).toBeNull();
    expect(screen.getByRole('button', { name: 'حذف سقف اختصاصی' })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('سقف اختصاصی جدید'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'ثبت سقف اختصاصی' }));
    await waitFor(() =>
      expect(api.calls.some((call) => call.url.endsWith('/trial/override'))).toBe(true),
    );
    const sent = api.calls.find((call) => call.url.endsWith('/trial/override'));
    expect(sent?.method).toBe('POST');
    expect(sent?.body).toMatchObject({ limit: 5 });
    expect(typeof (sent?.body as { idempotencyKey?: unknown }).idempotencyKey).toBe('string');
  });

  it('says «none» when there is no override, and names the permission it lacks', async () => {
    stubApi([
      { url: `/users/${ROW_ID}`, body: { customer: customer() } },
      { url: `/users/${ROW_ID}/trial`, body: allowance({ featureEnabled: false }) },
    ]);
    renderPage(
      <UserDetailPage id={ROW_ID} mayBlock={false} mayEditTrial={false} {...OFF} denied={false} />,
    );
    expect(await screen.findByText('ندارد (از سقف پیش‌فرض پیروی می‌کند)')).toBeInTheDocument();
    expect(screen.getByText(/users\.trial\.edit/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ثبت سقف اختصاصی' })).toBeNull();
    // The flag is off, and the card says the numbers cannot be used yet.
    expect(screen.getByText(/خاموش است/)).toBeInTheDocument();
  });
});

describe('the global trial reset', () => {
  const routes = [
    { url: '/trials/overrides', body: { overrides: [], nextCursor: null } },
    {
      url: '/trials/reset/preview',
      body: {
        preview: {
          affectedGrants: 7,
          affectedCustomers: 3,
          fingerprint: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
          sample: [
            {
              customer: {
                id: ROW_ID,
                telegramUserId: '5551234567',
                username: 'ali_tehran',
                firstName: null,
                status: 'ACTIVE',
              },
              grants: 3,
            },
          ],
        },
      },
    },
    { url: '/trials/resets', body: { resets: [], nextCursor: null } },
  ];

  it('stays disabled until the previewed count is typed back with a reason, then sends it', async () => {
    const api = stubApi(routes);
    renderPage(<TrialsPage mayViewOverrides mayReset mayViewHistory />);

    fireEvent.click(await screen.findByRole('button', { name: 'پیش‌نمایش' }));
    expect(await screen.findByText('7')).toBeInTheDocument();
    const execute = screen.getByRole('button', { name: 'بازنشانی' });
    expect(execute).toBeDisabled();

    fireEvent.change(screen.getByLabelText('برای تأیید، همان عدد بالا را وارد کنید'), {
      target: { value: '6' },
    });
    fireEvent.change(screen.getByLabelText('دلیل (الزامی)'), { target: { value: 'new season' } });
    // A number other than the one previewed confirms nothing.
    expect(execute).toBeDisabled();

    fireEvent.change(screen.getByLabelText('برای تأیید، همان عدد بالا را وارد کنید'), {
      target: { value: '7' },
    });
    expect(execute).toBeEnabled();
    fireEvent.click(execute);
    await waitFor(() =>
      expect(
        api.calls.some((call) => call.method === 'POST' && call.url.endsWith('/trials/resets')),
      ).toBe(true),
    );
    const sent = api.calls.find((call) => call.method === 'POST');
    // The count the operator typed AND the set the server previewed, carried back
    // unchanged (Codex, PR #65).
    expect(sent?.body).toMatchObject({
      expectedGrants: 7,
      expectedFingerprint: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      reason: 'new season',
    });
  });

  it('names the permission rather than drawing a reset for an actor without it', async () => {
    stubApi(routes);
    renderPage(<TrialsPage mayViewOverrides mayReset={false} mayViewHistory={false} />);
    expect(await screen.findByText(/settings\.destructive/)).toBeInTheDocument();
    expect(screen.getByText(/settings\.view/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'پیش‌نمایش' })).toBeNull();
  });
});
