import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { COMMERCE_ERROR_CODES, customEmojiMarker } from '@nexa/contracts';
import { ProductDetailPage } from '../../apps/web/src/pages/products';
import { t } from '../../apps/web/src/i18n/web.fa';
import { categoryListing, panel, product, renderPage, stubApi } from './harness';

/**
 * «ارسال توضیح از تلگرام» on the product page: the button opens a capture request, the page
 * says what to do and where, fills the description when it arrives, shows a premium emoji as a
 * readable token (never its id), and saves nothing until the ordinary Save is pressed.
 */
const ID = '019220ab-cdef-7012-8345-6789abcdef01';
const CAPTURE = '019220ab-cdef-7012-8345-6789abcdef77';
const ID_1 = '5368324170671202286';
const ID_2 = '5307996024738395492';

const capture = (state: string, description: string | null = null) => ({
  captureId: CAPTURE,
  state,
  expiresAt: '2026-11-11T10:10:00.000Z',
  bots: [{ username: 'acme_store_bot', chatUrl: 'https://t.me/acme_store_bot' }],
  description,
});
const fixtures = (overrides: Record<string, unknown> = {}) => [
  { url: `/products/019220ab`, method: 'GET', body: { product: product(overrides) } },
  { url: `/products/019220ab`, method: 'POST', body: { product: product(overrides) } },
  { url: '/panels', body: { panels: [panel()], nextCursor: null } },
  { url: '/products', body: { products: [product(overrides)], nextCursor: null } },
  { url: '/product-categories', body: { categories: [categoryListing()] } },
];
const field = async () =>
  (await screen.findByLabelText(t('web.product_description'))) as HTMLTextAreaElement;
const writes = (api: ReturnType<typeof stubApi>) =>
  api.calls.filter((call) => call.method === 'POST' && !call.url.includes('description-captures'));

describe('«ارسال توضیح از تلگرام» on the product page', () => {
  it('shows a stored premium emoji as a readable token, and typing around it keeps the ids', async () => {
    const stored = `سلام ${customEmojiMarker(ID_1, '😀')} خوش آمدید ${customEmojiMarker(ID_2, '🔥')}`;
    const api = stubApi(fixtures({ description: stored }));
    renderPage(<ProductDetailPage id={ID} mayEdit denied={false} />);
    const box = await field();
    expect(box.value).toBe('سلام ⟦😀 #1⟧ خوش آمدید ⟦🔥 #2⟧');
    expect(box.value).not.toContain(ID_1);

    fireEvent.change(box, { target: { value: 'درود ⟦😀 #1⟧ خوش آمدید به شما ⟦🔥 #2⟧' } });
    fireEvent.click(screen.getByText('ذخیرهٔ تغییرات'));
    await waitFor(() => expect(writes(api)).toHaveLength(1));
    expect((writes(api)[0]?.body as { description: string }).description).toBe(
      `درود ${customEmojiMarker(ID_1, '😀')} خوش آمدید به شما ${customEmojiMarker(ID_2, '🔥')}`,
    );
  });

  it('opens a request, says what to do and where, and shows the bot link', async () => {
    const api = stubApi([
      ...fixtures(),
      { url: '/description-captures', method: 'POST', body: capture('OPEN') },
      { url: `/description-captures/${CAPTURE}`, method: 'GET', body: capture('OPEN') },
    ]);
    renderPage(<ProductDetailPage id={ID} mayEdit denied={false} />);
    await field();
    fireEvent.click(screen.getByRole('button', { name: t('web.product_capture_button') }));
    expect(await screen.findByText(t('web.product_capture_instruction'))).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '@acme_store_bot' })).toHaveAttribute(
      'href',
      'https://t.me/acme_store_bot',
    );
    const open = api.calls.find((call) => call.url.endsWith('/description-captures'));
    expect(open?.body).toMatchObject({ idempotencyKey: expect.any(String) });
    // The button is not offered again while the request is open.
    expect(screen.getByRole('button', { name: t('web.product_capture_button') })).toBeDisabled();
  });

  it('fills the field when the description arrives, saves nothing, and Save sends the stored form', async () => {
    const stored = `متن ${customEmojiMarker(ID_1, '😀')} تازه`;
    const api = stubApi([
      ...fixtures({ description: 'قدیمی' }),
      { url: '/description-captures', method: 'POST', body: capture('OPEN') },
      { url: `/description-captures/${CAPTURE}`, method: 'GET', body: capture('CAPTURED', stored) },
    ]);
    renderPage(<ProductDetailPage id={ID} mayEdit denied={false} />);
    expect((await field()).value).toBe('قدیمی');
    fireEvent.click(screen.getByRole('button', { name: t('web.product_capture_button') }));
    await waitFor(async () => expect((await field()).value).toBe('متن ⟦😀 #1⟧ تازه'));
    expect(await screen.findByText(t('web.product_capture_done'))).toBeInTheDocument();
    // No silent save: no product write happened by itself.
    expect(writes(api)).toHaveLength(0);

    fireEvent.click(screen.getByText('ذخیرهٔ تغییرات'));
    await waitFor(() => expect(writes(api)).toHaveLength(1));
    expect((writes(api)[0]?.body as { description: string }).description).toBe(stored);
  });

  it('says so when the request has expired, and when the account is not linked', async () => {
    stubApi([
      ...fixtures(),
      { url: '/description-captures', method: 'POST', body: capture('EXPIRED') },
      { url: `/description-captures/${CAPTURE}`, method: 'GET', body: capture('EXPIRED') },
    ]);
    renderPage(<ProductDetailPage id={ID} mayEdit denied={false} />);
    await field();
    fireEvent.click(screen.getByRole('button', { name: t('web.product_capture_button') }));
    expect(await screen.findByText(t('web.product_capture_expired'))).toBeInTheDocument();
  });

  it('shows the server’s refusal in Persian', async () => {
    const refusal = {
      error: {
        kind: 'conflict',
        code: COMMERCE_ERROR_CODES.PRODUCT_DESCRIPTION_CAPTURE_TELEGRAM_UNLINKED,
        message: 'x',
        correlationId: 'c',
      },
    };
    stubApi([
      ...fixtures(),
      { url: '/description-captures', method: 'POST', status: 409, body: refusal },
    ]);
    renderPage(<ProductDetailPage id={ID} mayEdit denied={false} />);
    await field();
    fireEvent.click(screen.getByRole('button', { name: t('web.product_capture_button') }));
    expect(
      await screen.findByText(t('web.err_product_description_capture_telegram_unlinked')),
    ).toBeInTheDocument();
  });

  it('keeps the open request when another tab is shown, and fills the field even if it arrives while away', async () => {
    const reply: Record<string, unknown> = { ...capture('OPEN') };
    stubApi([
      ...fixtures({ description: 'قدیمی' }),
      { url: '/description-captures', method: 'POST', body: capture('OPEN') },
      { url: `/description-captures/${CAPTURE}`, method: 'GET', body: reply },
    ]);
    renderPage(<ProductDetailPage id={ID} mayEdit denied={false} />);
    await field();
    fireEvent.click(screen.getByRole('button', { name: t('web.product_capture_button') }));
    expect(await screen.findByText(t('web.product_capture_instruction'))).toBeInTheDocument();

    // Leave the basic tab (the capture component unmounts) and let the message arrive there.
    fireEvent.click(screen.getByRole('tab', { name: new RegExp(t('web.cb_section_pricing')) }));
    expect(screen.queryByLabelText(t('web.product_description'))).toBeNull();
    Object.assign(reply, capture('CAPTURED', 'متن تازه'));

    // Polling continued while away: coming back shows the filled description and the outcome.
    await waitFor(
      async () => {
        fireEvent.click(screen.getByRole('tab', { name: new RegExp(t('web.cb_section_basic')) }));
        expect((await field()).value).toBe('متن تازه');
      },
      { timeout: 8000 },
    );
    expect(await screen.findByText(t('web.product_capture_done'))).toBeInTheDocument();
  }, 15000);
});
