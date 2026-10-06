import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { type PERMISSION_KEYS } from '@nexa/contracts';
import {
  BUSINESS_CHAT_REFRESH_MS,
  BusinessChatDetailPage,
  BusinessChatsPage,
  businessChatFault,
} from '../../apps/web/src/pages/business-chats';
import { ApiError } from '../../apps/web/src/api/client';
import { t } from '../../apps/web/src/i18n/web.fa';
import { NAV, navPermitted, resolve } from '../../apps/web/src/app';
import { renderPage, stubApi } from './harness';

/**
 * TB2 — the Web Admin's Telegram Business inbox and one conversation. Fixtures go through
 * the real API client and are parsed by the contract's schemas, so a fixture that drifts
 * from the server fails here.
 *
 * What this file defends: the inbox sends the state the operator chose and pages by the
 * server's cursor; every origin in the transcript is named in words; take over, hand back
 * and reply call their own routes, each with an idempotency key; the controls are drawn
 * only for `business_chats.reply`; and the page says «no permission» rather than asking
 * the server without `business_chats.view`.
 */

const CHAT_ID = '019400ab-cdef-7012-8345-6789abcdef01';
const OTHER_CHAT_ID = '019400ab-cdef-7012-8345-6789abcdef02';
const CUSTOMER_ID = '019410ab-cdef-7012-8345-6789abcdef01';

const summary = (overrides: Record<string, unknown> = {}) => ({
  id: CHAT_ID,
  state: 'HANDOFF_REQUIRED',
  takeoverReason: null,
  handoffReason: 'SEND_OUTCOME_UNKNOWN',
  peerTelegramUserId: '951001',
  customer: { id: CUSTOMER_ID, username: 'mary', firstName: 'مریم' },
  connectionStatus: 'ACTIVE',
  lastMessageAt: '2026-10-01T10:00:00.000Z',
  lastInboundAt: '2026-10-01T10:00:00.000Z',
  preview: 'سرویس وصل نمی‌شود',
  unansweredSince: null,
  ticketId: null,
  ...overrides,
});

const message = (overrides: Record<string, unknown> = {}) => ({
  id: '019420ab-cdef-7012-8345-6789abcdef01',
  origin: 'INBOUND',
  kind: 'TEXT',
  text: 'سلام، سرویس وصل نمی‌شود.',
  sentAt: '2026-10-01T10:00:00.000Z',
  edited: false,
  deleted: false,
  ...overrides,
});

const detail = (conversation: Record<string, unknown> = {}) => ({
  conversation: { ...summary(conversation), controlEpoch: 3, lastHumanAt: null },
  escalations: [],
  messages: [
    // Deliberately out of order: the transcript reads oldest first whatever arrives.
    message({
      id: '019420ab-cdef-7012-8345-6789abcdef05',
      origin: 'OFFLINE',
      text: 'در ساعت کاری پاسخ می‌دهیم.',
      sentAt: '2026-10-01T10:05:00.000Z',
    }),
    message(),
    message({
      id: '019420ab-cdef-7012-8345-6789abcdef02',
      origin: 'HUMAN',
      text: 'بررسی می‌کنم.',
      sentAt: '2026-10-01T10:01:00.000Z',
      edited: true,
    }),
    message({
      id: '019420ab-cdef-7012-8345-6789abcdef03',
      origin: 'OWN_ECHO',
      text: 'لطفاً برنامه را به‌روزرسانی کنید.',
      sentAt: '2026-10-01T10:02:00.000Z',
    }),
    message({
      id: '019420ab-cdef-7012-8345-6789abcdef04',
      origin: 'OTHER_BOT',
      text: null,
      sentAt: '2026-10-01T10:03:00.000Z',
      deleted: true,
    }),
  ],
  outbound: [
    {
      id: '019430ab-cdef-7012-8345-6789abcdef01',
      origin: 'OPERATOR',
      state: 'UNCONFIRMED',
      text: 'لطفاً برنامه را به‌روزرسانی کنید.',
      createdAt: '2026-10-01T10:02:00.000Z',
      resolvedAt: null,
      failureCode: null,
    },
    {
      id: '019430ab-cdef-7012-8345-6789abcdef02',
      origin: 'OPERATOR',
      state: 'PENDING',
      text: 'پیام دوم اپراتور',
      createdAt: '2026-10-01T10:04:00.000Z',
      resolvedAt: null,
      failureCode: null,
    },
  ],
});

const connections = {
  connections: [
    {
      id: '019440ab-cdef-7012-8345-6789abcdef01',
      botInstanceId: '019450ab-cdef-7012-8345-6789abcdef01',
      ownerTelegramUserId: '777001',
      status: 'RIGHTS_INSUFFICIENT',
      rights: ['can_read_messages'],
      connectedAt: '2026-09-01T00:00:00.000Z',
      lastConfirmedAt: '2026-10-01T00:00:00.000Z',
    },
  ],
};

const route = (query = '') => ({ path: '/business-chats', query: new URLSearchParams(query) });

const listCall = (api: ReturnType<typeof stubApi>) =>
  api.calls.filter((call) => call.method === 'GET' && /\/business-chats(\?|$)/u.test(call.url));

describe('the business inbox', () => {
  it('lists conversations with Persian labels, linking each to its conversation', async () => {
    stubApi([
      {
        url: '/business-chats',
        body: {
          conversations: [
            summary(),
            summary({
              id: OTHER_CHAT_ID,
              state: 'AI_ACTIVE',
              handoffReason: null,
              customer: null,
              peerTelegramUserId: '951002',
              connectionStatus: 'DISABLED',
              preview: null,
            }),
          ],
          nextCursor: null,
        },
      },
      { url: '/business-connections', body: connections },
    ]);
    renderPage(<BusinessChatsPage route={route()} denied={false} />);
    const table = await screen.findByRole('table', { name: t('web.bchats_title') });
    const link = within(table).getByRole('link', { name: 'مریم' });
    expect(link.getAttribute('href')).toBe(`/business-chats/${CHAT_ID}`);
    const row = link.closest('tr') as HTMLElement;
    expect(within(row).getByText(t('web.bchat_state_handoff_required'))).toBeTruthy();
    expect(within(row).getByText(t('web.bchat_handoff_send_unknown'))).toBeTruthy();
    expect(within(row).getByText('سرویس وصل نمی‌شود')).toBeTruthy();
    expect(within(row).getByText('951001')).toBeTruthy();
    // An ACTIVE connection draws no badge; a disabled one does.
    expect(within(row).queryByText(t('web.bchat_connection_active'))).toBeNull();

    const unknown = within(table).getByRole('link', { name: t('web.bchat_unknown_customer') });
    const other = unknown.closest('tr') as HTMLElement;
    expect(within(other).getByText(t('web.bchat_state_ai_active'))).toBeTruthy();
    expect(within(other).getByText(t('web.bchat_connection_disabled'))).toBeTruthy();
    expect(within(other).getByText(t('web.bchat_text_gone'))).toBeTruthy();

    // The connections card names each status in Persian.
    const card = await screen.findByRole('table', { name: t('web.bchat_connections_title') });
    expect(within(card).getByText(t('web.bchat_connection_rights_insufficient'))).toBeTruthy();
    expect(within(card).getByText('777001')).toBeTruthy();
    // No internal enum is shown to the operator.
    expect(screen.queryByText('HANDOFF_REQUIRED')).toBeNull();
    expect(screen.queryByText('RIGHTS_INSUFFICIENT')).toBeNull();
  });

  it('sends the chosen state, and a chip changes the filter in the address', async () => {
    const api = stubApi([
      { url: '/business-chats', body: { conversations: [], nextCursor: null } },
      { url: '/business-connections', body: { connections: [] } },
    ]);
    renderPage(<BusinessChatsPage route={route('state=HUMAN_ACTIVE')} denied={false} />);
    expect(await screen.findByText(t('web.bchats_filter_empty'))).toBeTruthy();
    const params = new URL(listCall(api)[0]!.url, 'http://x').searchParams;
    expect(params.get('state')).toBe('HUMAN_ACTIVE');
    expect(params.get('cursor')).toBeNull();
    expect(await screen.findByText(t('web.bchat_connections_empty'))).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: t('web.bchat_state_paused') }));
    expect(new URLSearchParams(window.location.search).get('state')).toBe('PAUSED');
    fireEvent.click(screen.getByRole('button', { name: t('web.bchat_filter_all') }));
    expect(new URLSearchParams(window.location.search).get('state')).toBeNull();
  });

  it('loads the next page with the server’s cursor and keeps the rows already shown', async () => {
    const api = stubApi([
      {
        url: '/business-chats?cursor=',
        body: {
          conversations: [summary({ id: OTHER_CHAT_ID, preview: 'دومی' })],
          nextCursor: null,
        },
      },
      {
        url: '/business-chats',
        body: { conversations: [summary()], nextCursor: '2026-10-01T10:00:00.000Z|abc' },
      },
      { url: '/business-connections', body: { connections: [] } },
    ]);
    renderPage(<BusinessChatsPage route={route()} denied={false} />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.bchat_load_more') }));
    expect(await screen.findByText('دومی')).toBeTruthy();
    expect(screen.getByText('سرویس وصل نمی‌شود')).toBeTruthy();
    const second = listCall(api)[1]!;
    expect(new URL(second.url, 'http://x').searchParams.get('cursor')).toBe(
      '2026-10-01T10:00:00.000Z|abc',
    );
    // The last page draws no further control.
    expect(screen.queryByRole('button', { name: t('web.bchat_load_more') })).toBeNull();
  });

  it('says «no permission» and asks the server nothing without the view key', () => {
    const api = stubApi([]);
    renderPage(<BusinessChatsPage route={route()} denied />);
    expect(screen.getByText(t('web.no_permission'))).toBeTruthy();
    expect(api.calls).toHaveLength(0);
  });

  it('shows a server failure as an error, not as an empty inbox', async () => {
    stubApi([
      {
        url: '/business-chats',
        status: 500,
        body: { error: { kind: 'internal', code: 'x', message: 'x', correlationId: 'c' } },
      },
      { url: '/business-connections', body: { connections: [] } },
    ]);
    renderPage(<BusinessChatsPage route={route()} denied={false} />);
    await screen.findByRole('button', { name: t('web.retry') });
    expect(screen.queryByText(t('web.bchats_empty'))).toBeNull();
  });
});

describe('the route and the navigation', () => {
  it('serves both routes on business_chats.view and draws the link only for it', () => {
    const list = resolve(route(), ['business_chats.view']);
    expect(list.title).toBe(t('web.bchats_title'));
    const one = resolve({ path: `/business-chats/${CHAT_ID}`, query: new URLSearchParams() }, [
      'business_chats.view',
    ]);
    expect(one.title).toBe(t('web.bchat_detail'));
    const entry = NAV.find((item) => item.id === 'business-chats')!;
    expect(entry.path).toBe('/business-chats');
    // Hotfix: under «هوش مصنوعی پشتیبانی» now, beside the other support-AI pages.
    expect(entry.group).toBe('web.navgroup_support_ai');
    expect(navPermitted(entry, ['business_chats.view'], [])).toBe(true);
    expect(navPermitted(entry, ['tickets.view'], [])).toBe(false);
  });

  it('passes denied and the reply key through from the permissions held', () => {
    const at = (permissions: readonly (typeof PERMISSION_KEYS)[number][]) =>
      resolve({ path: `/business-chats/${CHAT_ID}`, query: new URLSearchParams() }, permissions)
        .element as { props: { denied: boolean; mayReply: boolean } };
    expect(at([]).props).toMatchObject({ denied: true, mayReply: false });
    expect(at(['business_chats.view']).props).toMatchObject({ denied: false, mayReply: false });
    expect(at(['business_chats.view', 'business_chats.reply']).props).toMatchObject({
      denied: false,
      mayReply: true,
    });
  });
});

describe('one business conversation', () => {
  const page = (conversation: Record<string, unknown> = {}, mayReply = true) => {
    const api = stubApi([
      { url: `/business-chats/${CHAT_ID}`, body: detail(conversation) },
      {
        url: `/business-chats/${CHAT_ID}/takeover`,
        body: { state: 'HUMAN_ACTIVE', controlEpoch: 4 },
      },
      { url: `/business-chats/${CHAT_ID}/resume`, body: { state: 'AI_ACTIVE', controlEpoch: 4 } },
      {
        url: `/business-chats/${CHAT_ID}/messages`,
        body: { outboundId: '019430ab-cdef-7012-8345-6789abcdef09', state: 'PENDING' },
      },
    ]);
    renderPage(<BusinessChatDetailPage id={CHAT_ID} denied={false} mayReply={mayReply} />);
    return api;
  };
  const posted = (api: ReturnType<typeof stubApi>, suffix: string) =>
    api.calls.filter((call) => call.method === 'POST' && call.url.endsWith(suffix));

  it('shows each handoff: its reason in words, the ticket, and the AI note for the operator', async () => {
    stubApi([
      {
        url: `/business-chats/${CHAT_ID}`,
        body: {
          ...detail({ handoffReason: 'HANDOFF_TOPIC' }),
          escalations: [
            {
              id: '019450ab-cdef-7012-8345-6789abcdef01',
              reason: 'HANDOFF_TOPIC',
              summary: 'مشتری بازپرداخت می‌خواهد.',
              ticketId: '019460ab-cdef-7012-8345-6789abcdef01',
              ticketOutcome: 'CREATED',
              createdAt: '2026-10-01T10:06:00.000Z',
              aiFailure: null,
            },
            {
              id: '019450ab-cdef-7012-8345-6789abcdef02',
              reason: 'IDENTITY_UNVERIFIED',
              summary: null,
              ticketId: null,
              ticketOutcome: 'NO_CUSTOMER',
              createdAt: '2026-10-01T09:06:00.000Z',
              aiFailure: null,
            },
            {
              id: '019450ab-cdef-7012-8345-6789abcdef03',
              reason: 'AI_OUTPUT_INVALID',
              summary: null,
              ticketId: null,
              ticketOutcome: 'NO_CUSTOMER',
              createdAt: '2026-10-01T08:06:00.000Z',
              // Program §12: WHY the AI's output was invalid, beside the coarse reason.
              aiFailure: {
                failureClass: 'schema_invalid',
                operation: 'AUTO_DECISION',
                provider: 'OPENAI',
                model: 'gpt-test-1',
                attemptIndex: 0,
                outcome: 'INVALID_OUTPUT',
                httpStatus: null,
                providerErrorCode: null,
                providerErrorType: null,
                providerErrorParam: null,
                issuePath: 'intent',
                issueCode: 'too_big',
                latencyMs: 900,
                inputTokens: 2100,
                outputTokens: 180,
                at: '2026-10-01T08:06:00.000Z',
              },
            },
          ],
        },
      },
    ]);
    renderPage(<BusinessChatDetailPage id={CHAT_ID} denied={false} mayReply={false} />);
    expect(await screen.findByText(t('web.bchat_escalations'))).toBeTruthy();
    expect(screen.getByText('مشتری بازپرداخت می‌خواهد.')).toBeTruthy();
    const link = screen.getByRole('link', { name: t('web.bchat_escalation_ticket_created') });
    expect(link.getAttribute('href')).toBe('/tickets/019460ab-cdef-7012-8345-6789abcdef01');
    expect(screen.getAllByText(t('web.bchat_escalation_no_customer')).length).toBeGreaterThan(0);
    const failure = document.querySelector('[data-failure-class="schema_invalid"]')!;
    expect(failure.textContent).toContain(t('web.sai_failure_schema_invalid'));
    expect(failure.textContent).toContain('intent (too_big)');
    expect(screen.getAllByText(t('web.bchat_handoff_topic')).length).toBeGreaterThan(0);
    expect(screen.getByText(t('web.bchat_handoff_identity'))).toBeTruthy();
  });

  it('D8: proposes a reply the owner typed on the phone, never a customer message', async () => {
    const api = stubApi([
      { url: `/business-chats/${CHAT_ID}`, body: detail() },
      { url: '/knowledge-proposals', method: 'POST', body: { jobId: 'j1', state: 'QUEUED' } },
    ]);
    renderPage(<BusinessChatDetailPage id={CHAT_ID} denied={false} mayReply={false} mayPropose />);
    const thread = await screen.findByRole('list', { name: t('web.bchat_transcript') });
    const items = within(thread).getAllByRole('listitem');
    const byOrigin = (origin: string) =>
      items.find((item) => item.getAttribute('data-origin') === origin)!;
    // Only the owner's own typed reply carries the button.
    expect(
      within(byOrigin('INBOUND')).queryByRole('button', { name: t('web.sk_propose') }),
    ).toBeNull();
    expect(
      within(byOrigin('OWN_ECHO')).queryByRole('button', { name: t('web.sk_propose') }),
    ).toBeNull();
    expect(
      within(byOrigin('OFFLINE')).queryByRole('button', { name: t('web.sk_propose') }),
    ).toBeNull();
    fireEvent.click(within(byOrigin('HUMAN')).getByRole('button', { name: t('web.sk_propose') }));
    await waitFor(() =>
      expect(api.calls.filter((c) => c.url.endsWith('/knowledge-proposals'))).toHaveLength(1),
    );
    const body = api.calls.find((c) => c.url.endsWith('/knowledge-proposals'))!.body as Record<
      string,
      string
    >;
    expect(body['messageId']).toBe('019420ab-cdef-7012-8345-6789abcdef02');
    expect(body['outboundId']).toBeUndefined();
  });

  it('D8: draws no propose button on the transcript without the permission', async () => {
    stubApi([{ url: `/business-chats/${CHAT_ID}`, body: detail() }]);
    renderPage(<BusinessChatDetailPage id={CHAT_ID} denied={false} mayReply={false} />);
    const thread = await screen.findByRole('list', { name: t('web.bchat_transcript') });
    expect(within(thread).queryByRole('button', { name: t('web.sk_propose') })).toBeNull();
  });

  it('names every origin in words, oldest first, with edited, deleted and purged markers', async () => {
    page({}, false);
    const thread = await screen.findByRole('list', { name: t('web.bchat_transcript') });
    const items = within(thread).getAllByRole('listitem');
    expect(items.map((item) => item.getAttribute('data-origin'))).toEqual([
      'INBOUND',
      'HUMAN',
      'OWN_ECHO',
      'OTHER_BOT',
      'OFFLINE',
    ]);
    expect(within(items[0]!).getByText(t('web.bchat_origin_inbound'))).toBeTruthy();
    expect(within(items[1]!).getByText(t('web.bchat_origin_human'))).toBeTruthy();
    expect(within(items[1]!).getByText(t('web.bchat_edited'))).toBeTruthy();
    expect(within(items[2]!).getByText(t('web.bchat_origin_own_echo'))).toBeTruthy();
    expect(within(items[3]!).getByText(t('web.bchat_origin_other_bot'))).toBeTruthy();
    expect(within(items[3]!).getByText(t('web.bchat_deleted'))).toBeTruthy();
    expect(within(items[3]!).getByText(t('web.bchat_text_gone'))).toBeTruthy();
    expect(within(items[4]!).getByText(t('web.bchat_origin_offline'))).toBeTruthy();
    // The state, explained in one sentence, under the title.
    expect(screen.getAllByText(t('web.bchat_explain_handoff_required')).length).toBeGreaterThan(0);
    // The outbound lane, with an unknown outcome said to be never resent.
    const lane = screen.getByRole('list', { name: t('web.bchat_outbound') });
    expect(within(lane).getByText(t('web.bchat_outbound_unconfirmed'))).toBeTruthy();
    expect(within(lane).getByText(t('web.bchat_outbound_pending'))).toBeTruthy();
    // Without the reply key: no controls and no composer.
    expect(screen.queryByRole('button', { name: t('web.bchat_takeover') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('web.bchat_resume') })).toBeNull();
    expect(screen.queryByLabelText(t('web.bchat_reply_text'))).toBeNull();
  });

  it('takes the conversation over through its own route, with an idempotency key', async () => {
    const api = page();
    fireEvent.click(await screen.findByRole('button', { name: t('web.bchat_takeover') }));
    await waitFor(() => expect(posted(api, '/takeover')).toHaveLength(1));
    const body = posted(api, '/takeover')[0]!.body as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['idempotencyKey']);
    expect(typeof body.idempotencyKey).toBe('string');
    expect((body.idempotencyKey as string).length).toBeGreaterThanOrEqual(8);
    // The conversation is read again after the write.
    await waitFor(() =>
      expect(
        api.calls.filter(
          (call) => call.method === 'GET' && call.url.endsWith(`/business-chats/${CHAT_ID}`),
        ).length,
      ).toBeGreaterThan(1),
    );
  });

  it('hands back to the AI only after the confirmation, through the resume route', async () => {
    const api = page();
    fireEvent.click(await screen.findByRole('button', { name: t('web.bchat_resume') }));
    const dialog = await screen.findByRole('alertdialog');
    expect(posted(api, '/resume')).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: t('web.bchat_resume_confirm') }));
    await waitFor(() => expect(posted(api, '/resume')).toHaveLength(1));
    const body = posted(api, '/resume')[0]!.body as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['idempotencyKey']);
    expect(posted(api, '/takeover')).toHaveLength(0);
  });

  it('cancelling the confirmation sends nothing', async () => {
    const api = page();
    fireEvent.click(await screen.findByRole('button', { name: t('web.bchat_resume') }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: t('web.bchat_cancel') }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(posted(api, '/resume')).toHaveLength(0);
  });

  it('draws take over only when a human does not hold it, and resume only when the AI does not', async () => {
    page({ state: 'HUMAN_ACTIVE', handoffReason: null, takeoverReason: 'OPERATOR_TAKEOVER' });
    await screen.findByRole('button', { name: t('web.bchat_resume') });
    expect(screen.queryByRole('button', { name: t('web.bchat_takeover') })).toBeNull();
    expect(screen.getByText(t('web.bchat_takeover_operator'))).toBeTruthy();
  });

  it('draws no resume while the AI holds the conversation', async () => {
    page({ state: 'AI_ACTIVE', handoffReason: null });
    await screen.findByRole('button', { name: t('web.bchat_takeover') });
    expect(screen.queryByRole('button', { name: t('web.bchat_resume') })).toBeNull();
  });

  it('sends a reply with its key, says it takes over, and counts against 4096', async () => {
    const api = page();
    expect(await screen.findByText(t('web.bchat_reply_takes_over'))).toBeTruthy();
    const box = await screen.findByLabelText(t('web.bchat_reply_text'));
    expect(box.getAttribute('maxLength')).toBe('4096');
    const send = screen.getByRole('button', { name: t('web.bchat_send') });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box, { target: { value: '  درست شد؟ ' } });
    expect((send as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(posted(api, '/messages')).toHaveLength(1));
    const body = posted(api, '/messages')[0]!.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['idempotencyKey', 'text']);
    expect(body.text).toBe('درست شد؟');
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(''));
  });

  it('refuses to send through a connection that cannot send, and says why', async () => {
    const api = page({ connectionStatus: 'RIGHTS_INSUFFICIENT' });
    const box = await screen.findByLabelText(t('web.bchat_reply_text'));
    fireEvent.change(box, { target: { value: 'سلام' } });
    expect(screen.getByText(t('web.bchat_reply_connection_unusable'))).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: t('web.bchat_send') }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(posted(api, '/messages')).toHaveLength(0);
  });

  it('says «no permission» and asks the server nothing without the view key', () => {
    const api = stubApi([]);
    renderPage(<BusinessChatDetailPage id={CHAT_ID} denied mayReply />);
    expect(screen.getByText(t('web.no_permission'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('web.bchat_takeover') })).toBeNull();
    expect(api.calls).toHaveLength(0);
  });

  it('polls an open conversation on a short interval', () => {
    expect(BUSINESS_CHAT_REFRESH_MS).toBeLessThanOrEqual(15_000);
    expect(BUSINESS_CHAT_REFRESH_MS).toBeGreaterThanOrEqual(5_000);
  });

  it('names the server’s refusals in Persian', () => {
    const refusal = (code: string) => new ApiError(409, code, 'x');
    expect(businessChatFault(refusal('business_chats.connection_unusable'))).toBe(
      t('web.bchat_fault_connection'),
    );
    expect(businessChatFault(refusal('business_chats.not_in_state'))).toBe(
      t('web.bchat_fault_not_in_state'),
    );
  });
});
