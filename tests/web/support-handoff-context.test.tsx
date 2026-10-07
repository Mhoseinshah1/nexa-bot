import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { BUSINESS_HANDOFF_REASONS, SUPPORT_AI_AUTO_OUTCOMES } from '@nexa/contracts';
import { BusinessChatDetailPage } from '../../apps/web/src/pages/business-chats';
import { AUTO_OUTCOME_LABELS } from '../../apps/web/src/pages/support-analytics';
import { HANDOFF_LABELS } from '../../apps/web/src/pages/handoff-labels';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * Roadmap A3–A6 on the Web Admin: the three new handoff reasons and outcomes are named in
 * Persian, the handoff notice is a lane row of its own origin, and a handoff's operator context
 * (topic, intent, steps tried) is drawn beside the AI's note — and not drawn when the server
 * sends it as null.
 */

const CHAT_ID = '01900000-0000-7000-8000-00000000c0de';

const detail = (escalation: Record<string, unknown>) => ({
  conversation: {
    id: CHAT_ID,
    state: 'HANDOFF_REQUIRED',
    takeoverReason: null,
    handoffReason: 'NO_PROGRESS',
    peerTelegramUserId: '951001',
    customer: null,
    connectionStatus: 'ACTIVE',
    lastMessageAt: null,
    lastInboundAt: null,
    preview: null,
    unansweredSince: null,
    controlEpoch: 4,
    lastHumanAt: null,
    ticketId: null,
  },
  messages: [],
  outbound: [
    {
      id: 'o1',
      origin: 'HANDOFF_NOTICE',
      state: 'DELIVERED',
      text: null,
      createdAt: '2026-10-07T10:00:00.000Z',
      resolvedAt: '2026-10-07T10:00:01.000Z',
      failureCode: null,
    },
  ],
  escalations: [
    {
      id: 'e1',
      reason: 'NO_PROGRESS',
      summary: 'مشتری با Sing-box وصل نمی‌شود.',
      topic: 'CONNECTION_TROUBLESHOOTING',
      intent: 'رفع مشکل اتصال',
      stepsTried: 3,
      ticketId: null,
      ticketOutcome: 'NO_CUSTOMER',
      createdAt: '2026-10-07T10:00:00.000Z',
      aiFailure: null,
      ...escalation,
    },
  ],
});

function page(escalation: Record<string, unknown> = {}) {
  stubApi([{ url: `/business-chats/${CHAT_ID}`, body: detail(escalation) }]);
  renderPage(<BusinessChatDetailPage id={CHAT_ID} denied={false} mayReply mayAssist={false} />);
}

describe('roadmap A3–A6 on the Web Admin', () => {
  it('names the new handoff reasons and outcomes in Persian', () => {
    expect(t(HANDOFF_LABELS.NO_PROGRESS)).toBe('مشتری چند بار گفت راهنمایی هوش مصنوعی جواب نداد');
    expect(t(HANDOFF_LABELS.REPEATED_ADVICE)).toBe('هوش مصنوعی همان راهنمایی قبلی را تکرار می‌کرد');
    expect(t(HANDOFF_LABELS.INBOUND_FLOOD)).toBe(
      'مشتری پیام تکراری یا پیام‌های پشت‌سرهم زیادی فرستاد',
    );
    expect(t(AUTO_OUTCOME_LABELS.no_action)).toBe('بی‌پاسخ بسته شد (تشکر یا حل شد)');
    // Every reason and outcome the contract has is labelled.
    for (const reason of BUSINESS_HANDOFF_REASONS) expect(t(HANDOFF_LABELS[reason])).not.toBe('');
    for (const outcome of SUPPORT_AI_AUTO_OUTCOMES) {
      expect(t(AUTO_OUTCOME_LABELS[outcome])).not.toBe('');
    }
  });

  it('draws the handoff context beside the AI note, and the notice as its own origin', async () => {
    page();
    expect((await screen.findAllByText(t(HANDOFF_LABELS.NO_PROGRESS))).length).toBeGreaterThan(0);
    expect(screen.getByText('مشتری با Sing-box وصل نمی‌شود.')).toBeTruthy();
    const body = document.body.textContent ?? '';
    expect(body).toContain(`${t('web.bchat_handoff_context_topic')} مشکل اتصال`);
    expect(body).toContain(`${t('web.bchat_handoff_context_intent')} رفع مشکل اتصال`);
    expect(body).toContain(`${t('web.bchat_handoff_context_steps')} ۳`);
    expect(body).toContain(t('web.bchat_outbound_origin_handoff_notice'));
  });

  it('draws nothing of the context when the server withholds it', async () => {
    page({ summary: null, topic: null, intent: null, stepsTried: null });
    expect((await screen.findAllByText(t(HANDOFF_LABELS.NO_PROGRESS))).length).toBeGreaterThan(0);
    const body = document.body.textContent ?? '';
    expect(body).not.toContain(t('web.bchat_handoff_context_topic'));
    expect(body).not.toContain(t('web.bchat_handoff_context_intent'));
    expect(body).not.toContain(t('web.bchat_handoff_context_steps'));
  });
});
