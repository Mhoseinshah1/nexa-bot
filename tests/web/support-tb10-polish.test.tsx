import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_RULES,
  SUPPORT_AI_DEFAULT_CONFIG,
} from '@nexa/contracts';
import {
  BusinessChatDetailPage,
  BusinessChatsPage,
  inboxRows,
  waitParts,
} from '../../apps/web/src/pages/business-chats';
import { SupportAiPage } from '../../apps/web/src/pages/support-ai';
import { CATEGORY_LABELS, pathOf, titleOf } from '../../apps/web/src/pages/notification-center';
import { t } from '../../apps/web/src/i18n/web.fa';
import { HANDOFF_LABELS } from '../../apps/web/src/pages/handoff-labels';
import { renderPage, stubApi } from './harness';

/**
 * TB10 — the polish over the support pages: the inbox's wait and ticket badge, the provider
 * health panel, the support notifications' titles and links, and the RTL / theming rules of
 * the support pages' stylesheet. Fixtures go through the real client and the contract's
 * schemas.
 */

const CHAT_ID = '019400ab-cdef-7012-8345-6789abcdef01';
const TICKET_ID = '019460ab-cdef-7012-8345-6789abcdef09';
const MINUTE = 60_000;

const summary = (overrides: Record<string, unknown> = {}) => ({
  id: CHAT_ID,
  state: 'HANDOFF_REQUIRED',
  takeoverReason: null,
  handoffReason: 'HANDOFF_TOPIC',
  peerTelegramUserId: '951001',
  customer: { id: '019410ab-cdef-7012-8345-6789abcdef01', username: 'mary', firstName: 'مریم' },
  connectionStatus: 'ACTIVE',
  lastMessageAt: '2026-10-01T10:00:00.000Z',
  lastInboundAt: '2026-10-01T10:00:00.000Z',
  preview: 'Refund please',
  unansweredSince: null,
  ticketId: null,
  ...overrides,
});

const inboxRoute = { path: '/business-chats', query: new URLSearchParams() };

describe('the inbox: the customer’s wait and the ticket', () => {
  it('names a handoff by its REAL reason, read beside the pre-A3 wire one (PR #248 follow-up)', async () => {
    stubApi([
      {
        url: '/business-chats',
        body: {
          conversations: [
            summary({ handoffReason: 'LOOP_GUARD', handoffReasonDetail: 'INBOUND_FLOOD' }),
          ],
          nextCursor: null,
        },
      },
      { url: '/business-connections', body: { connections: [] } },
    ]);
    renderPage(<BusinessChatsPage route={inboxRoute} denied={false} />);
    const table = await screen.findByRole('table', { name: t('web.bchats_title') });
    expect(within(table).getByText(t(HANDOFF_LABELS.INBOUND_FLOOD))).toBeTruthy();
    expect(within(table).queryByText(t(HANDOFF_LABELS.LOOP_GUARD))).toBeNull();
  });

  it('says how long the customer has waited, in one unit, floored', () => {
    const now = Date.parse('2026-10-05T12:00:00.000Z');
    const ago = (ms: number) => new Date(now - ms).toISOString();
    expect(waitParts(ago(30_000), now)).toBeNull();
    expect(waitParts(ago(MINUTE), now)).toEqual({ value: 1, unit: 'web.unit_minutes' });
    expect(waitParts(ago(59 * MINUTE + 59_000), now)).toEqual({
      value: 59,
      unit: 'web.unit_minutes',
    });
    expect(waitParts(ago(60 * MINUTE), now)).toEqual({ value: 1, unit: 'web.unit_hours' });
    expect(waitParts(ago(47 * 60 * MINUTE + 59 * MINUTE), now)).toEqual({
      value: 47,
      unit: 'web.unit_hours',
    });
    expect(waitParts(ago(48 * 60 * MINUTE), now)).toEqual({ value: 2, unit: 'web.unit_days' });
    expect(waitParts('not a time', now)).toBeNull();
  });

  it('draws the wait for an unanswered conversation, a dash for an answered one, and a ticket link', async () => {
    const since = new Date(Date.now() - 12 * MINUTE - 5_000).toISOString();
    stubApi([
      {
        url: '/business-chats',
        body: {
          conversations: [
            summary({ unansweredSince: since, ticketId: TICKET_ID }),
            summary({
              id: '019400ab-cdef-7012-8345-6789abcdef02',
              state: 'AI_ACTIVE',
              handoffReason: null,
              customer: null,
              peerTelegramUserId: '951002',
            }),
          ],
          nextCursor: null,
        },
      },
      { url: '/business-connections', body: { connections: [] } },
    ]);
    renderPage(<BusinessChatsPage route={inboxRoute} denied={false} />);
    const table = await screen.findByRole('table', { name: t('web.bchats_title') });
    expect(within(table).getByRole('columnheader', { name: t('web.bchat_wait') })).toBeTruthy();

    const waiting = within(table).getByRole('link', { name: 'مریم' }).closest('tr') as HTMLElement;
    expect(within(waiting).getByText(t('web.unit_minutes'), { exact: false })).toBeTruthy();
    const ticket = within(waiting).getByRole('link', { name: t('web.bchat_ticket_badge') });
    expect(ticket.getAttribute('href')).toBe(`/tickets/${TICKET_ID}`);

    const answered = within(table)
      .getByRole('link', { name: t('web.bchat_unknown_customer') })
      .closest('tr') as HTMLElement;
    expect(within(answered).queryByText(t('web.unit_minutes'), { exact: false })).toBeNull();
    expect(within(answered).queryByRole('link', { name: t('web.bchat_ticket_badge') })).toBeNull();
  });

  /*
   * PR #205 review, N2: the keyset's first key (handoffs first) is mutable, so a conversation
   * handed back to the AI between two pages is read again on the next one.
   */
  it('draws a conversation once when «load more» reads it again, with the fresher read', async () => {
    const SECOND = '019400ab-cdef-7012-8345-6789abcdef02';
    const THIRD = '019400ab-cdef-7012-8345-6789abcdef03';
    const second = { id: SECOND, peerTelegramUserId: '951002', customer: null };
    expect(
      inboxRows([
        { conversations: [summary(), summary(second)] as never },
        {
          conversations: [
            summary({ state: 'AI_ACTIVE', handoffReason: null }),
            summary({ id: THIRD }),
          ] as never,
        },
      ]).map((row) => `${row.id}/${row.state}`),
    ).toEqual([`${CHAT_ID}/AI_ACTIVE`, `${SECOND}/HANDOFF_REQUIRED`, `${THIRD}/HANDOFF_REQUIRED`]);

    stubApi([
      {
        url: '/business-chats',
        body: { conversations: [summary(), summary(second)], nextCursor: 'page-2' },
      },
      {
        url: '/business-chats?cursor=page-2',
        body: {
          conversations: [
            summary({ state: 'AI_ACTIVE', handoffReason: null }),
            summary({ id: THIRD, peerTelegramUserId: '951003', customer: null }),
          ],
          nextCursor: null,
        },
      },
      { url: '/business-connections', body: { connections: [] } },
    ]);
    renderPage(<BusinessChatsPage route={inboxRoute} denied={false} />);
    const table = await screen.findByRole('table', { name: t('web.bchats_title') });
    fireEvent.click(screen.getByRole('button', { name: t('web.bchat_load_more') }));
    await waitFor(() =>
      expect(
        within(table).getAllByRole('link', { name: t('web.bchat_unknown_customer') }),
      ).toHaveLength(2),
    );
    expect(within(table).getAllByRole('link', { name: 'مریم' })).toHaveLength(1);
  });

  it('shows the wait and the ticket on the conversation itself', async () => {
    stubApi([
      {
        url: `/business-chats/${CHAT_ID}`,
        body: {
          conversation: {
            ...summary({ ticketId: TICKET_ID, unansweredSince: new Date().toISOString() }),
            controlEpoch: 2,
            lastHumanAt: null,
          },
          escalations: [],
          messages: [],
          outbound: [],
        },
      },
    ]);
    renderPage(<BusinessChatDetailPage id={CHAT_ID} denied={false} mayReply={false} />);
    const open = await screen.findByRole('link', { name: t('web.bchat_ticket_open') });
    expect(open.getAttribute('href')).toBe(`/tickets/${TICKET_ID}`);
    expect(screen.getByText(t('web.bchat_wait_just_now'))).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------------------

const credential = (overrides: Record<string, unknown> = {}) => ({
  provider: 'OPENAI',
  configured: true,
  setAt: '2026-10-01T09:00:00.000Z',
  region: null,
  trippedUntil: null,
  lastTestOutcome: 'OK',
  lastTestFailureClass: null,
  lastTestedAt: '2026-10-01T09:05:00.000Z',
  breaker: 'CLOSED',
  consecutiveFailures: 0,
  rejectedAt: null,
  ...overrides,
});

const config = (overrides: Record<string, unknown> = {}) => ({
  config: {
    ...SUPPORT_AI_DEFAULT_CONFIG,
    mode: 'ASSIST_ONLY',
    primary: { provider: 'OPENAI', model: 'gpt-test-1' },
  },
  version: 1,
  credentials: [
    credential(),
    credential({
      provider: 'ANTHROPIC',
      breaker: 'OPEN',
      trippedUntil: '2099-01-01T00:00:00.000Z',
      consecutiveFailures: 3,
    }),
    credential({
      provider: 'ZAI',
      region: 'INTERNATIONAL',
      breaker: 'HALF_OPEN',
      trippedUntil: '2026-10-01T09:00:00.000Z',
      rejectedAt: '2026-10-02T08:00:00.000Z',
      lastTestOutcome: 'AUTH_FAILED',
    }),
  ],
  capabilities: {
    OPENAI: { structuredOutput: true, vision: true },
    ANTHROPIC: { structuredOutput: true, vision: true },
    ZAI: { structuredOutput: false, vision: false },
  },
  chainUnavailable: false,
  ...overrides,
});

const usage = { since: '2026-09-05T00:00:00.000Z', rows: [] };

describe('the provider health panel', () => {
  it('draws each provider’s breaker as the server derived it, its failures and a rejected key', async () => {
    stubApi([
      { url: '/support-ai/config', body: config() },
      { url: '/support-ai/usage', body: usage },
    ]);
    const view = renderPage(<SupportAiPage denied={false} mayAutoReply={false} />);
    await screen.findByText(t('web.sai_credentials'));
    const row = (provider: string) =>
      view.container.querySelector(`[data-provider="${provider}"]`) as HTMLElement;

    expect(within(row('OPENAI')).getByText(t('web.sai_breaker_closed'))).toBeTruthy();
    expect(within(row('OPENAI')).queryByText(t('web.sai_key_rejected'))).toBeNull();

    expect(within(row('ANTHROPIC')).getByText(t('web.sai_breaker_open'))).toBeTruthy();
    expect(within(row('ANTHROPIC')).getByText(t('web.sai_breaker_until'))).toBeTruthy();
    expect(within(row('ANTHROPIC')).getByText('3')).toBeTruthy();

    // HALF_OPEN comes from the server, even though tripped_until has passed on any clock.
    expect(within(row('ZAI')).getByText(t('web.sai_breaker_half_open'))).toBeTruthy();
    expect(within(row('ZAI')).queryByText(t('web.sai_breaker_until'))).toBeNull();
    expect(within(row('ZAI')).getAllByText(t('web.sai_key_rejected')).length).toBeGreaterThan(0);
    expect(within(row('ZAI')).getByText(t('web.sai_key_rejected_hint'))).toBeTruthy();

    expect(screen.queryByText(t('web.sai_chain_unavailable'))).toBeNull();
    // No internal enum is shown.
    for (const raw of ['CLOSED', 'OPEN', 'HALF_OPEN']) expect(screen.queryByText(raw)).toBeNull();
  });

  it('says so at the top when no provider is answering', async () => {
    stubApi([
      { url: '/support-ai/config', body: config({ chainUnavailable: true }) },
      { url: '/support-ai/usage', body: usage },
    ]);
    renderPage(<SupportAiPage denied={false} mayAutoReply={false} />);
    const banner = await screen.findByText(t('web.sai_chain_unavailable'));
    expect(banner.closest('[role="alert"]')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------

describe('the support notifications', () => {
  it('label both support categories, and title every support rule', () => {
    expect(NOTIFICATION_CATEGORIES).toContain('SUPPORT');
    expect(NOTIFICATION_CATEGORIES).toContain('SUPPORT_AI');
    expect(t(CATEGORY_LABELS.SUPPORT)).not.toBe(t(CATEGORY_LABELS.SUPPORT_AI));
    const support = NOTIFICATION_RULES.filter((rule) => rule.code?.startsWith('support.'));
    expect(support.map((rule) => rule.code).sort()).toEqual([
      'support.ai_provider.credential_rejected',
      'support.ai_provider.unavailable',
      'support.assistant.stalled',
      'support.business_connection.unusable',
      'support.handoff_required',
    ]);
    for (const rule of support) {
      expect(titleOf(rule.code!, rule.category)).not.toBe(t(CATEGORY_LABELS[rule.category]));
    }
  });

  it('link a handoff to its conversation, and the rest to the page that acts on them', () => {
    expect(pathOf({ target: 'BUSINESS_CHAT', id: CHAT_ID })).toBe(`/business-chats/${CHAT_ID}`);
    expect(pathOf({ target: 'BUSINESS_CHAT', id: null })).toBe('/business-chats');
    expect(pathOf({ target: 'BUSINESS_CHATS', id: null })).toBe('/business-chats');
    expect(pathOf({ target: 'SUPPORT_AI', id: null })).toBe('/support-ai');
  });
});

// ---------------------------------------------------------------------------------------

/** The stylesheet as the browser receives it: every `@import` expanded in place. */
const REPO_ROOT = join(import.meta.dirname, '../..');
function expandImports(path: string): string {
  const text = readFileSync(path, 'utf8');
  return text.replace(/@import\s+['"]([^'"]+)['"]\s*;/g, (_, target: string) =>
    expandImports(join(dirname(path), target)),
  );
}
const CSS = expandImports(join(REPO_ROOT, 'apps/web/src/styles.css')).replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);
function block(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(^|[},])\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(CSS);
  if (match === null) throw new Error(`No rule for ${selector} in styles.css.`);
  return match[2] ?? '';
}

describe('RTL and theming on the support pages', () => {
  it('lays out what a person wrote by its own direction, aligned to its own start', () => {
    for (const selector of ['.bchat-body', '.bchat-preview', '.support-answer']) {
      expect(block(selector), selector).toMatch(/unicode-bidi:\s*plaintext/);
      expect(block(selector), selector).toMatch(/text-align:\s*start/);
    }
  });

  it('uses only theme tokens and logical sides in the support pages’ rules', () => {
    const rules = [...CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, selector]) =>
      /\.(bchat|support)-/.test(selector ?? ''),
    );
    expect(rules.length).toBeGreaterThan(10);
    for (const [, selector, body] of rules) {
      // A colour is a token, so dark and light both hold.
      expect(body, selector).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
      // A side is logical, so the page mirrors under RTL.
      expect(body, selector).not.toMatch(
        /(^|[\s;])(margin|padding|border)-(left|right)\b|(^|[\s;])(left|right)\s*:|text-align:\s*(left|right)|float:\s*(left|right)/,
      );
    }
  });

  it('lets a text box take the direction of what is typed into it', async () => {
    stubApi([
      {
        url: `/business-chats/${CHAT_ID}`,
        body: {
          conversation: {
            ...summary({ state: 'HUMAN_ACTIVE', handoffReason: null }),
            controlEpoch: 2,
            lastHumanAt: null,
          },
          escalations: [],
          messages: [],
          outbound: [],
        },
      },
    ]);
    const view = renderPage(<BusinessChatDetailPage id={CHAT_ID} denied={false} mayReply />);
    await screen.findByText(t('web.bchat_transcript'));
    const box = view.container.querySelector('textarea');
    expect(box?.getAttribute('dir')).toBe('auto');
  });
});
