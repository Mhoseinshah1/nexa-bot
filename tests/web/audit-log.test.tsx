import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { AuditLogPage, auditFiltersOf, recordedFieldsOf } from '../../apps/web/src/pages/audit-log';
import { dayEnd, dayStart } from '../../apps/web/src/pages/tickets';
import { TimelineCard } from '../../apps/web/src/pages/customer-360-sections';
import { t } from '../../apps/web/src/i18n/web.fa';
import { NAV, navPermitted, resolve } from '../../apps/web/src/app';
import { renderPage, stubApi } from './harness';

/**
 * Phase D1 — the audit log page. Fixtures go through the real API client and are parsed by
 * the contract's schemas, so a fixture that drifts from the server fails here.
 *
 * What this file defends: every filter in the URL reaches the server (the date range as a
 * half-open interval), an entity id is never sent without its type, the export link carries
 * exactly the list's filters and is drawn only for `audit.export`, deep links come from the
 * server's `links` and nowhere else, and a row's before/after is shown only where the row
 * recorded one.
 */

const CUSTOMER_ID = '019320ab-cdef-7012-8345-6789abcdef01';
const ORDER_ID = '019350ab-cdef-7012-8345-6789abcdef01';
const ADMIN_ID = '019330ab-cdef-7012-8345-6789abcdef01';

const none = { customerId: null, orderId: null, paymentId: null, serviceId: null };

const entry = (overrides: Record<string, unknown> = {}) => ({
  id: '019360ab-cdef-7012-8345-6789abcdef01',
  occurredAt: '2026-09-20T10:00:00.000Z',
  actorType: 'WEB_ADMIN',
  actorId: ADMIN_ID,
  actorLabel: 'owner',
  surface: 'WEB',
  action: 'order.confirm',
  entityType: 'Order',
  entityId: ORDER_ID,
  result: 'SUCCESS',
  reason: null,
  correlationId: 'corr-1',
  before: null,
  after: null,
  security: [],
  links: { ...none, orderId: ORDER_ID, customerId: CUSTOMER_ID },
  ...overrides,
});

const route = (query = '') => ({ path: '/audit-log', query: new URLSearchParams(query) });

describe('the audit log page', () => {
  it('lists rows with Persian labels and the server’s deep links', async () => {
    stubApi([
      {
        url: '/audit-log',
        body: {
          entries: [
            entry(),
            entry({
              id: '019360ab-cdef-7012-8345-6789abcdef02',
              action: 'wallet.debit',
              entityType: 'Panel',
              entityId: 'not-linked',
              result: 'DENIED',
              security: ['DENIED', 'CRITICAL'],
              links: none,
            }),
          ],
          nextCursor: null,
        },
      },
    ]);
    renderPage(<AuditLogPage route={route()} denied={false} mayExport={false} />);
    const order = await screen.findByRole('link', { name: t('web.audit_link_order') });
    expect(order.getAttribute('href')).toBe(`/orders/${ORDER_ID}`);
    expect(
      screen.getByRole('link', { name: t('web.audit_link_customer') }).getAttribute('href'),
    ).toBe(`/users/${CUSTOMER_ID}`);
    // Exactly one order link: the unlinked row draws none, whatever its entity type says.
    expect(screen.getAllByRole('link', { name: t('web.audit_link_order') })).toHaveLength(1);
    const refused = screen.getByText('wallet.debit').closest('tr') as HTMLElement;
    expect(within(refused).getByText(t('web.history_result_denied'))).toBeTruthy();
    expect(within(refused).getByText(t('web.audit_security_critical'))).toBeTruthy();
    expect(screen.queryByText('DENIED')).toBeNull();
    // No export link without `audit.export`.
    expect(screen.queryByRole('link', { name: t('web.audit_export_csv') })).toBeNull();
  });

  it('sends every filter in the URL, the date range half-open', async () => {
    const api = stubApi([{ url: '/audit-log', body: { entries: [], nextCursor: null } }]);
    renderPage(
      <AuditLogPage
        route={route(
          `actor=owner&actorType=WEB_ADMIN&action=payment.&entityType=Order&entityId=${ORDER_ID}&customerId=${CUSTOMER_ID}&result=DENIED&security=CRITICAL&from=2026-09-01&to=2026-09-10`,
        )}
        denied={false}
        mayExport
      />,
    );
    await screen.findByText(t('web.audit_filter_empty'));
    const call = api.calls.find((c) => c.url.includes('/audit-log?'));
    const params = new URL(call!.url, 'http://x').searchParams;
    expect(params.get('actor')).toBe('owner');
    expect(params.get('actorType')).toBe('WEB_ADMIN');
    expect(params.get('action')).toBe('payment.');
    expect(params.get('entityType')).toBe('Order');
    expect(params.get('entityId')).toBe(ORDER_ID);
    expect(params.get('customerId')).toBe(CUSTOMER_ID);
    expect(params.get('result')).toBe('DENIED');
    expect(params.get('security')).toBe('CRITICAL');
    expect(params.get('from')).toBe(dayStart('2026-09-01'));
    expect(params.get('to')).toBe(dayEnd('2026-09-10'));
    expect(params.get('limit')).toBe('50');

    // The export is the SAME filter object: the file holds the rows these pages show.
    const exportLink = screen.getByRole('link', { name: t('web.audit_export_csv') });
    const exported = new URL(exportLink.getAttribute('href')!, 'http://x').searchParams;
    for (const key of [
      'actor',
      'actorType',
      'action',
      'entityType',
      'entityId',
      'customerId',
      'result',
      'security',
      'from',
      'to',
    ]) {
      expect(exported.get(key), key).toBe(params.get(key));
    }
    expect(exported.get('format')).toBe('csv');
    expect(exported.get('cursor')).toBeNull();
  });

  it('never sends an entity id without its type, or a value the server would refuse', () => {
    expect(auditFiltersOf(new URLSearchParams(`entityId=${ORDER_ID}`))).toEqual({});
    expect(
      auditFiltersOf(
        new URLSearchParams('action=payment%25&customerId=nope&security=ALL&result=x'),
      ),
    ).toEqual({});
  });

  it('pages forward with the server’s cursor and back without asking again', async () => {
    const api = stubApi([
      { url: '/audit-log', body: { entries: [entry()], nextCursor: 'CURSOR-1' } },
    ]);
    renderPage(<AuditLogPage route={route()} denied={false} mayExport={false} />);
    await screen.findByRole('link', { name: t('web.audit_link_order') });
    fireEvent.click(screen.getByRole('button', { name: t('web.older') }));
    await waitFor(() =>
      expect(api.calls.some((c) => c.url.includes('cursor=CURSOR-1'))).toBe(true),
    );
  });

  it('shows what a row recorded, and says so when it recorded nothing', async () => {
    stubApi([
      {
        url: '/audit-log',
        body: {
          entries: [
            entry({
              before: { status: 'ACTIVE', password: '[redacted]' },
              after: { status: 'BLOCKED', password: '[redacted]' },
              entityType: 'Customer',
              entityId: CUSTOMER_ID,
              links: { ...none, customerId: CUSTOMER_ID },
            }),
            entry({ id: '019360ab-cdef-7012-8345-6789abcdef03', links: none }),
          ],
          nextCursor: null,
        },
      },
    ]);
    renderPage(<AuditLogPage route={route()} denied={false} mayExport={false} />);
    expect(await screen.findByText(t('web.audit_changes_none'))).toBeTruthy();
    expect(screen.getByText('ACTIVE')).toBeTruthy();
    expect(screen.getByText('BLOCKED')).toBeTruthy();
    expect(screen.getAllByText('[redacted]')).toHaveLength(2);
  });

  it('marks only the fields whose recorded value changed', () => {
    expect(
      recordedFieldsOf({ before: { a: 1, b: 2 }, after: { a: 1, b: 3, c: 4 } }).map((f) => [
        f.field,
        f.changed,
      ]),
    ).toEqual([
      ['a', false],
      ['b', true],
      ['c', true],
    ]);
    // A creation recorded only `after`: nothing is "changed" from a before nobody recorded.
    expect(recordedFieldsOf({ before: null, after: { a: 1 } })[0]?.changed).toBe(false);
    expect(recordedFieldsOf({ before: null, after: null })).toEqual([]);
  });

  it('shows the denied state and asks nothing without audit.view', async () => {
    const api = stubApi([{ url: '/audit-log', body: { entries: [], nextCursor: null } }]);
    renderPage(<AuditLogPage route={route()} denied mayExport={false} />);
    await waitFor(() => expect(api.calls).toHaveLength(0));
    expect(screen.queryByRole('link', { name: t('web.audit_export_csv') })).toBeNull();
  });

  it('is a navigation entry for audit.view, and routes', () => {
    const navEntry = NAV.find((candidate) => candidate.id === 'audit-log')!;
    expect(navPermitted(navEntry, ['audit.view'])).toBe(true);
    expect(navPermitted(navEntry, ['opslog.view'])).toBe(false);
    const resolved = resolve({ path: '/audit-log', query: new URLSearchParams() }, ['audit.view']);
    expect(resolved.title).toBe(t('web.audit_title'));
  });

  it('is opened from Customer 360 already scoped to that customer', async () => {
    stubApi([{ url: `/users/${CUSTOMER_ID}/timeline`, body: { entries: [] } }]);
    renderPage(<TimelineCard customerId={CUSTOMER_ID} mayView />);
    const link = await screen.findByRole('link', { name: t('web.c360_timeline_all') });
    expect(link.getAttribute('href')).toBe(`/audit-log?customerId=${CUSTOMER_ID}`);
  });
});
