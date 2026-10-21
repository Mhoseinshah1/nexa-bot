import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { PaymentDetailPage } from '../../apps/web/src/pages/payments';
import { ProductLink, RecordLink, TechnicalIds } from '../../apps/web/src/ui/record-ref';
import { renderPage, stubApi } from './harness';

/**
 * Round 5C-2 D1: the copy action beside a short code copies THAT CODE — the characters on
 * the screen — and the 36-character uuid is copied only by the explicit «کپی شناسهٔ داخلی»
 * in the technical section.
 */

const UUID = '019240ab-cdef-7012-8345-6789abcdef02';
const CUSTOMER_ID = '019210ab-cdef-7012-8345-6789abcdef02';

function clipboard(): string[] {
  const writes: string[] = [];
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: vi.fn((text: string) => {
        writes.push(text);
        return Promise.resolve();
      }),
    },
  });
  return writes;
}

describe('«کپی کد» copies the code that is shown', () => {
  it('a record link copies its 8-character code, not its uuid', async () => {
    const writes = clipboard();
    renderPage(<RecordLink href="/orders/x" id={UUID} code="K7M2P9QA" />);
    expect(screen.getByText('K7M2P9QA')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'کپی کد' }));
    await waitFor(() => expect(writes).toEqual(['K7M2P9QA']));
    expect(screen.queryByRole('button', { name: 'کپی شناسهٔ داخلی' })).toBeNull();
  });

  it('a product link copies the code it draws', async () => {
    const writes = clipboard();
    renderPage(<ProductLink id={UUID} code="P-102" title="یک ماهه" />);
    expect(screen.getByText('P-102 · یک ماهه')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'کپی کد' }));
    await waitFor(() => expect(writes).toEqual(['P-102']));
  });

  it('a row with no code to copy offers only the explicitly named internal id', async () => {
    const writes = clipboard();
    renderPage(<RecordLink href="/orders/x" id={UUID} code={null} />);
    expect(screen.queryByRole('button', { name: 'کپی کد' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'کپی شناسهٔ داخلی' }));
    await waitFor(() => expect(writes).toEqual([UUID]));
  });

  it('the uuid is copied from the technical section, and only by its explicit button', async () => {
    const writes = clipboard();
    const { container } = renderPage(<TechnicalIds id={UUID} />);
    const section = container.querySelector('details');
    expect(section).not.toBeNull();
    expect(section!.hasAttribute('open')).toBe(false);
    fireEvent.click(within(section!).getByRole('button', { name: 'کپی شناسهٔ داخلی' }));
    await waitFor(() => expect(writes).toEqual([UUID]));
  });
});

describe('a payment page', () => {
  it('copies the tracking code from the title and keeps the uuid in the technical section', async () => {
    const writes = clipboard();
    stubApi([
      {
        url: `/payments/${UUID}`,
        body: {
          payment: {
            id: UUID,
            customerId: CUSTOMER_ID,
            orderId: null,
            state: 'PENDING',
            method: 'MANUAL_TRANSFER',
            amount: '250000',
            currency: 'IRT',
            reference: '7d433a363380f69e:manual',
            evidenceKind: null,
            confirmedAt: null,
            confirmedByAdminId: null,
            resolvedAt: null,
            resolvedByAdminId: null,
            customerSignalledAt: null,
            expiresAt: null,
            createdAt: '2026-10-09T08:00:00.000Z',
            updatedAt: '2026-10-09T08:00:00.000Z',
            gatewayProvider: 'MANUAL_TRANSFER',
            evidenceNote: null,
            resolutionNote: null,
            destination: null,
          },
        },
      },
      {
        url: `/payments/${UUID}/timeline`,
        body: { paymentId: UUID, entries: [], withheld: [], truncated: false },
      },
    ]);
    const { container } = renderPage(
      <PaymentDetailPage
        id={UUID}
        mayViewReceipts={false}
        mayViewRefunds={false}
        mayIssueRefunds={false}
        denied={false}
      />,
    );
    await screen.findAllByText('7d433a363380f69e');
    // The payment's own uuid is offered inside the technical section and nowhere else; every
    // «کپی کد» copies the code on the screen.
    const technical =
      [...container.querySelectorAll('details')].find((node) =>
        node.textContent?.startsWith('بخش فنی'),
      ) ?? null;
    expect(technical).not.toBeNull();
    for (const node of container.querySelectorAll('[data-copy-value]')) {
      const value = node.getAttribute('data-copy-value');
      if (value === UUID) expect(technical!.contains(node), node.outerHTML).toBe(true);
      if (node.getAttribute('aria-label') === 'کپی کد') expect(value).toBe('7d433a363380f69e');
    }
    fireEvent.click(screen.getAllByRole('button', { name: 'کپی کد' })[0]!);
    await waitFor(() => expect(writes).toEqual(['7d433a363380f69e']));
    expect(
      within(technical as HTMLElement).getAllByRole('button', { name: 'کپی شناسهٔ داخلی' }),
    ).toHaveLength(1);
  });
});
