import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  SUPPORT_AI_DEFAULT_CONFIG,
  SUPPORT_AI_FAILURE_CLASSES,
  SUPPORT_READINESS_DETAILS,
  SUPPORT_AI_PROVIDERS,
} from '@nexa/contracts';
import { SupportAiPage } from '../../apps/web/src/pages/support-ai';
import {
  READINESS_COMMANDS,
  READINESS_FIXES,
  READINESS_SENTENCES,
} from '../../apps/web/src/pages/support-ai-readiness';
import { SUPPORT_AI_KNOWN_MODELS } from '../../apps/web/src/pages/support-ai-models';
import { FAILURE_CLASS_ACTIONS } from '../../apps/web/src/pages/support-ai-failure';
import {
  HANDOFF_FIXES,
  SupportAnalyticsPage,
  resolutionPercent,
  tokenTotal,
} from '../../apps/web/src/pages/support-analytics';
import { BusinessChatsPage, stateLabelFor } from '../../apps/web/src/pages/business-chats';
import { SupportKnowledgePage } from '../../apps/web/src/pages/support-knowledge';
import { BUSINESS_HANDOFF_REASONS } from '@nexa/contracts';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * Phase 4 PR-5 — the Web Admin's support pages: readiness card, test console, model picker,
 * advanced settings, mode consequences, the inbox's real mode and bulk return, analytics
 * (resolution, «رفع», questions, knowledge gaps), failure advice, knowledge prefill.
 */

const configResponse = (config: Record<string, unknown> = {}) => ({
  config: {
    ...SUPPORT_AI_DEFAULT_CONFIG,
    mode: 'ASSIST_ONLY',
    primary: { provider: 'OPENAI', model: 'gpt-4o-mini' },
    autoTopics: ['APP_SETUP'],
    ...config,
  },
  version: 3,
  credentials: [],
  capabilities: {
    OPENAI: { structuredOutput: true, vision: true },
    ANTHROPIC: { structuredOutput: true, vision: true },
    ZAI: { structuredOutput: true, vision: false },
  },
  chainUnavailable: false,
});

const usage = { url: '/support-ai/usage', body: { since: '2026-10-01T00:00:00.000Z', rows: [] } };

const line = (
  check: string,
  status: 'OK' | 'WARN',
  detail: string,
  extra: { count?: number | null; handles?: string[] } = {},
) => ({ check, status, detail, count: extra.count ?? null, handles: extra.handles ?? [] });

const readiness = (lines: ReturnType<typeof line>[]) => ({ checks: lines });

describe('readiness card', () => {
  it('draws one line per check, ✅ or ⚠️, each warning with its one-line fix and server command', async () => {
    stubApi([
      { url: '/support-ai/config', method: 'GET', body: configResponse() },
      usage,
      {
        url: '/support-ai/readiness',
        body: readiness([
          line('BUSINESS_CONNECTION', 'OK', 'CONNECTED'),
          line('SUPPORT_HANDLE', 'WARN', 'HANDLE_MISMATCH', { handles: ['@other'] }),
          line('PROVIDER_KEY', 'WARN', 'NO_KEY'),
          line('STRUCTURED_OUTPUT', 'WARN', 'NOT_TESTED'),
          line('ASSISTANT_ROLE', 'WARN', 'NEVER_STARTED'),
          line('TOPICS', 'OK', 'TOPICS_SELECTED', { count: 4 }),
          line('KNOWLEDGE', 'OK', 'KNOWLEDGE_READY', { count: 12 }),
          line('VISION', 'OK', 'VISION_OFF'),
        ]),
      },
    ]);
    renderPage(<SupportAiPage denied={false} mayAutoReply={false} />);
    const card = (await screen.findByText(t('web.sair_title'))).closest('section')!;
    await within(card).findByText(t('web.sair_connected'));
    const rows = card.querySelectorAll('[data-check]');
    expect(rows).toHaveLength(8);
    expect(card.querySelectorAll('[data-status="WARN"]')).toHaveLength(4);
    // A warning says what is wrong and what to do about it.
    expect(within(card).getByText(t('web.sair_fix_no_key'))).toBeTruthy();
    expect(within(card).getByText(t('web.sair_fix_handle_mismatch'))).toBeTruthy();
    expect(card.textContent).toContain('@other');
    expect(card.textContent).toContain('sudo botctl roles enable assistant');
    // A count is quoted from the server.
    expect(card.textContent).toContain('12 مقالهٔ تأییدشده');
    expect(card.textContent).toContain('4 موضوع');
    // The untested capability line offers the test; a passing one does not.
    expect(within(card).getAllByRole('button', { name: t('web.sair_run_test') })).toHaveLength(1);
  });

  it('runs the capability test for the primary step from the card', async () => {
    const api = stubApi([
      { url: '/support-ai/config', method: 'GET', body: configResponse() },
      usage,
      {
        url: '/support-ai/readiness',
        body: readiness([line('STRUCTURED_OUTPUT', 'WARN', 'NOT_TESTED')]),
      },
      {
        url: '/support-ai/credentials/OPENAI/test',
        method: 'POST',
        body: {
          outcome: 'OK',
          code: null,
          failureClass: null,
          latencyMs: 10,
          checks: [],
        },
      },
    ]);
    renderPage(<SupportAiPage denied={false} mayAutoReply={false} />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.sair_run_test') }));
    await waitFor(() =>
      expect(api.calls.some((call) => call.url.includes('/credentials/OPENAI/test'))).toBe(true),
    );
    const post = api.calls.find((call) => call.url.includes('/credentials/OPENAI/test'))!;
    expect(post.body).toMatchObject({ model: 'gpt-4o-mini' });
    expect((post.body as { idempotencyKey: string }).idempotencyKey.length).toBeGreaterThan(7);
  });

  it('every code has a sentence, and every warning code has a fix', () => {
    for (const detail of SUPPORT_READINESS_DETAILS) {
      expect(READINESS_SENTENCES[detail], detail).toBeDefined();
      expect(t(READINESS_SENTENCES[detail]).length).toBeGreaterThan(5);
    }
    const warnings = SUPPORT_READINESS_DETAILS.filter((detail) => {
      // The codes that are the OK outcome of a check.
      return ![
        'CONNECTED',
        'HANDLE_MATCHES',
        'KEY_OK',
        'TEST_PASSED',
        'RUNNING',
        'TOPICS_SELECTED',
        'KNOWLEDGE_READY',
        'VISION_ON',
        'VISION_OFF',
      ].includes(detail);
    });
    for (const detail of warnings) expect(READINESS_FIXES[detail], detail).toBeDefined();
    expect(Object.keys(READINESS_COMMANDS).length).toBeGreaterThan(0);
  });
});

describe('test console', () => {
  const result = (over: Record<string, unknown> = {}) => ({
    verdict: 'WOULD_SEND',
    mode: 'AUTO_REPLY_SAFE',
    answer: 'برنامه را ببندید و دوباره باز کنید.',
    decision: 'REPLY',
    topic: 'CONNECTION_TROUBLESHOOTING',
    confidence: 'HIGH',
    knowledgeUsed: ['خطای اتصال'],
    factsUsed: [],
    knowledgeSent: 2,
    knowledgeAvailable: 9,
    guard: null,
    outputPolicyRefused: false,
    failureClass: null,
    provider: 'OPENAI',
    model: 'gpt-4o-mini',
    customerLinked: false,
    inputTokens: 100,
    outputTokens: 20,
    ...over,
  });

  async function ask(response: Record<string, unknown>) {
    const api = stubApi([
      { url: '/support-ai/config', method: 'GET', body: configResponse() },
      usage,
      { url: '/support-ai/readiness', body: readiness([]) },
      { url: '/support-ai/test-console', method: 'POST', body: response },
    ]);
    renderPage(<SupportAiPage denied={false} mayAutoReply={false} />);
    fireEvent.change(await screen.findByLabelText(t('web.saic_question')), {
      target: { value: 'اینترنتم وصل نمیشه' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('web.saic_run') }));
    await screen.findByText(t('web.saic_topic'));
    return api;
  }

  it('says it sends nothing, and shows the answer, topic, confidence and knowledge used', async () => {
    const api = await ask(result());
    expect(screen.getByText(t('web.saic_sends_nothing'))).toBeTruthy();
    expect(screen.getByText('برنامه را ببندید و دوباره باز کنید.')).toBeTruthy();
    expect(screen.getByText(t('web.saic_verdict_would_send'))).toBeTruthy();
    expect(screen.getByText('خطای اتصال')).toBeTruthy();
    const post = api.calls.find((call) => call.url.endsWith('/support-ai/test-console'))!;
    expect(post.body).toMatchObject({ question: 'اینترنتم وصل نمیشه', customerId: null });
  });

  it('names the guard that would block it and the Persian handoff reason, with its kind', async () => {
    await ask(
      result({
        verdict: 'WOULD_HAND_OFF',
        guard: { outcome: 'guard_topic_allowlist', reason: 'TOPIC_NOT_ALLOWED', kind: 'SOFT' },
      }),
    );
    expect(screen.getByText(t('web.saic_verdict_would_hand_off'))).toBeTruthy();
    expect(screen.getByText(t('web.sa_auto_guard_topic_allowlist'))).toBeTruthy();
    expect(document.body.textContent).toContain(t('web.bchat_handoff_topic_not_allowed'));
    expect(document.body.textContent).toContain(t('web.saic_kind_soft'));
    // The reply the model wrote is shown as held back, not as sent.
    expect(screen.getByText(t('web.saic_answer_held'))).toBeTruthy();
  });

  it('is disabled and explains why while the stored mode is OFF', async () => {
    stubApi([
      { url: '/support-ai/config', method: 'GET', body: configResponse({ mode: 'OFF' }) },
      usage,
      { url: '/support-ai/readiness', body: readiness([]) },
    ]);
    renderPage(<SupportAiPage denied={false} mayAutoReply={false} />);
    expect(await screen.findByText(t('web.saic_off'))).toBeTruthy();
    fireEvent.change(screen.getByLabelText(t('web.saic_question')), { target: { value: 'سلام' } });
    expect(
      (screen.getByRole('button', { name: t('web.saic_run') }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe('model picker, advanced settings and mode consequences', () => {
  it('offers the provider’s known models and «سایر», which reveals the free id', async () => {
    stubApi([
      { url: '/support-ai/config', method: 'GET', body: configResponse() },
      usage,
      { url: '/support-ai/readiness', body: readiness([]) },
    ]);
    renderPage(<SupportAiPage denied={false} mayAutoReply={false} />);
    const select = (await screen.findByLabelText(
      `${t('web.sai_primary')} — ${t('web.sai_model')}`,
    )) as HTMLSelectElement;
    const options = [...select.options].map((option) => option.value);
    for (const model of SUPPORT_AI_KNOWN_MODELS.OPENAI) expect(options).toContain(model);
    expect(select.value).toBe('gpt-4o-mini');
    expect(screen.queryByLabelText(t('web.sai_model_other_id'))).toBeNull();
    fireEvent.change(select, { target: { value: '__other__' } });
    const free = (await screen.findByLabelText(t('web.sai_model_other_id'))) as HTMLInputElement;
    fireEvent.change(free, { target: { value: 'my-private-model' } });
    expect(free.value).toBe('my-private-model');
  });

  it('opens a stored model that is not in the list as «سایر» with its id', async () => {
    stubApi([
      {
        url: '/support-ai/config',
        method: 'GET',
        body: configResponse({ primary: { provider: 'OPENAI', model: 'ft:custom-1' } }),
      },
      usage,
      { url: '/support-ai/readiness', body: readiness([]) },
    ]);
    renderPage(<SupportAiPage denied={false} mayAutoReply={false} />);
    const free = (await screen.findByLabelText(t('web.sai_model_other_id'))) as HTMLInputElement;
    expect(free.value).toBe('ft:custom-1');
  });

  it('has a known-model list for every provider', () => {
    for (const provider of SUPPORT_AI_PROVIDERS) {
      expect(SUPPORT_AI_KNOWN_MODELS[provider].length).toBeGreaterThan(0);
    }
  });

  it('keeps the seven numeric limits in a collapsed «تنظیمات پیشرفته», each with help', async () => {
    stubApi([
      { url: '/support-ai/config', method: 'GET', body: configResponse() },
      usage,
      { url: '/support-ai/readiness', body: readiness([]) },
    ]);
    renderPage(<SupportAiPage denied={false} mayAutoReply={false} />);
    const summary = await screen.findByText(t('web.sai_advanced'));
    const details = summary.closest('details')!;
    expect(details.open).toBe(false);
    expect(details.querySelectorAll('input[inputmode="numeric"]')).toHaveLength(7);
    for (const key of [
      'web.sai_timeout_ms_hint',
      'web.sai_max_output_chars_hint',
      'web.sai_cooldown_seconds_hint',
      'web.sai_settle_delay_seconds_hint',
    ] as const) {
      expect(details.textContent).toContain(t(key));
    }
  });

  it('explains what each mode means next to its radio', async () => {
    stubApi([
      { url: '/support-ai/config', method: 'GET', body: configResponse() },
      usage,
      { url: '/support-ai/readiness', body: readiness([]) },
    ]);
    renderPage(<SupportAiPage denied={false} mayAutoReply={false} />);
    await screen.findByText(t('web.sai_advanced'));
    for (const key of [
      'web.sai_mode_off_consequence',
      'web.sai_mode_assist_only_consequence',
      'web.sai_mode_auto_reply_safe_consequence',
    ] as const) {
      expect(document.body.textContent).toContain(t(key));
    }
    expect(t('web.sai_mode_assist_only_consequence')).toContain('پیش‌نویس');
  });
});

describe('failure advice', () => {
  it('has a Persian «what to do» line for every failure class', () => {
    for (const failureClass of SUPPORT_AI_FAILURE_CLASSES) {
      const key = FAILURE_CLASS_ACTIONS[failureClass];
      expect(key, failureClass).toBeDefined();
      expect(t(key).length).toBeGreaterThan(15);
    }
  });
});

const CHAT_ID = '019400ab-cdef-7012-8345-6789abcdef01';
const SOFT_ID = '019400ab-cdef-7012-8345-6789abcdef02';
const summary = (over: Record<string, unknown> = {}) => ({
  id: CHAT_ID,
  state: 'AI_ACTIVE',
  takeoverReason: null,
  handoffReason: null,
  handoffReasonDetail: null,
  handoffKind: null,
  peerTelegramUserId: '951001',
  customer: null,
  connectionStatus: 'ACTIVE',
  lastMessageAt: '2026-10-01T10:00:00.000Z',
  lastInboundAt: '2026-10-01T10:00:00.000Z',
  preview: 'سلام',
  unansweredSince: null,
  ticketId: null,
  ...over,
});

describe('the inbox says what the AI really does', () => {
  const route = { path: '/business-chats', query: new URLSearchParams() };
  const list = (aiMode: string, rows: unknown[]) => ({
    url: '/business-chats',
    method: 'GET',
    body: { conversations: rows, nextCursor: null, aiMode },
  });

  it('labels an AI-held chat by the stored mode', () => {
    expect(stateLabelFor('AI_ACTIVE', 'AUTO_REPLY_SAFE').label).toBe('web.bchat_state_ai_active');
    expect(stateLabelFor('AI_ACTIVE', 'ASSIST_ONLY').label).toBe('web.bchat_state_ai_assist');
    expect(stateLabelFor('AI_ACTIVE', 'OFF').label).toBe('web.bchat_state_ai_off');
    expect(stateLabelFor('AI_ACTIVE', undefined).label).toBe('web.bchat_state_ai_active');
    // A hold by a person is never relabelled by the mode.
    expect(stateLabelFor('HUMAN_ACTIVE', 'OFF').label).toBe('web.bchat_state_human_active');
    expect(t('web.bchat_state_ai_assist')).toBe('فعال — فقط پیش‌نویس');
  });

  it('shows «فعال — فقط پیش‌نویس» and the hard/soft kind of each hold', async () => {
    stubApi([
      list('ASSIST_ONLY', [
        summary(),
        summary({
          id: SOFT_ID,
          state: 'HANDOFF_REQUIRED',
          handoffReason: 'LOW_CONFIDENCE',
          handoffReasonDetail: 'LOW_CONFIDENCE',
          handoffKind: 'SOFT',
        }),
        summary({
          id: '019400ab-cdef-7012-8345-6789abcdef03',
          state: 'HUMAN_ACTIVE',
          handoffKind: null,
        }),
      ]),
      { url: '/business-connections', body: { connections: [] } },
    ]);
    renderPage(<BusinessChatsPage route={route} denied={false} mayReply />);
    await screen.findByText(t('web.bchat_state_ai_assist'));
    expect(screen.getByText(t('web.bchat_mode_assist_note'))).toBeTruthy();
    expect(screen.getByText(t('web.bchat_kind_soft'))).toBeTruthy();
    // A hold with no recorded kind is read as hard, as the server reads it.
    expect(screen.getByText(t('web.bchat_kind_hard'))).toBeTruthy();
  });

  it('says when the AI is off', async () => {
    stubApi([
      list('OFF', [summary()]),
      { url: '/business-connections', body: { connections: [] } },
    ]);
    renderPage(<BusinessChatsPage route={route} denied={false} mayReply={false} />);
    expect(await screen.findByText(t('web.bchat_state_ai_off'))).toBeTruthy();
    expect(screen.getByText(t('web.bchat_mode_off_note'))).toBeTruthy();
    // No bulk button without business_chats.reply.
    expect(screen.queryByRole('button', { name: t('web.bchat_resume_all') })).toBeNull();
  });

  it('bulk return: the dialog says hard holds are separate, and the request carries the choice', async () => {
    const api = stubApi([
      list('AUTO_REPLY_SAFE', [summary()]),
      { url: '/business-connections', body: { connections: [] } },
      {
        url: '/business-chats/resume-all',
        method: 'POST',
        body: { resumed: 2, skippedHard: 1, failed: 0, more: false },
      },
    ]);
    renderPage(<BusinessChatsPage route={route} denied={false} mayReply />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.bchat_resume_all') }));
    const dialog = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    expect(dialog.textContent).toContain(t('web.bchat_resume_all_hard'));
    expect((within(dialog).getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(
      within(dialog).getByRole('button', { name: t('web.bchat_resume_all_confirm') }),
    );
    await waitFor(() =>
      expect(api.calls.some((call) => call.url.endsWith('/business-chats/resume-all'))).toBe(true),
    );
    const first = api.calls.find((call) => call.url.endsWith('/business-chats/resume-all'))!;
    expect(first.body).toMatchObject({ includeHard: false });
    expect((first.body as { idempotencyKey: string }).idempotencyKey.length).toBeGreaterThan(7);
  });

  it('bulk return with the box ticked sends includeHard', async () => {
    const api = stubApi([
      list('AUTO_REPLY_SAFE', [summary()]),
      { url: '/business-connections', body: { connections: [] } },
      {
        url: '/business-chats/resume-all',
        method: 'POST',
        body: { resumed: 3, skippedHard: 0, failed: 0, more: false },
      },
    ]);
    renderPage(<BusinessChatsPage route={route} denied={false} mayReply />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.bchat_resume_all') }));
    const dialog = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(
      within(dialog).getByRole('button', { name: t('web.bchat_resume_all_confirm') }),
    );
    await waitFor(() =>
      expect(
        api.calls.find((call) => call.url.endsWith('/business-chats/resume-all'))?.body,
      ).toMatchObject({
        includeHard: true,
      }),
    );
  });
});

describe('analytics', () => {
  const analytics = (over: Record<string, unknown> = {}) => ({
    period: {
      range: 'LAST_7_DAYS',
      start: '2026-10-25T00:00:00.000Z',
      end: '2026-11-01T00:00:00.000Z',
    },
    conversationsNow: [],
    handoffsByReason: [{ reason: 'LOOP_GUARD', count: 1 }],
    handoffsByReasonDetail: [
      { reason: 'TOPIC_NOT_ALLOWED', count: 5 },
      { reason: 'INSUFFICIENT_GROUNDING', count: 3 },
      { reason: 'HANDOFF_TOPIC', count: 2 },
    ],
    auto: { sent: 30, handedOff: 10, dropped: 2, pending: 0, byOutcome: [] },
    assist: { requested: 0, sent: 0, discarded: 0, superseded: 0, failed: 0, open: 0 },
    providerRuns: [
      {
        provider: 'OPENAI',
        outcome: 'OK',
        runs: 3,
        p50LatencyMs: 10,
        p95LatencyMs: 20,
        inputTokens: 1000,
        outputTokens: 200,
      },
    ],
    aiFailures: [],
    learningByState: [],
    knowledgeBySource: [],
    ...over,
  });
  const route = { path: '/support-analytics', query: new URLSearchParams() };

  it('computes the answered share and the token total from the server’s figures', () => {
    expect(resolutionPercent(analytics() as never)).toBe(75);
    expect(
      resolutionPercent(
        analytics({
          auto: { sent: 0, handedOff: 0, dropped: 4, pending: 0, byOutcome: [] },
        }) as never,
      ),
    ).toBeNull();
    expect(tokenTotal(analytics() as never)).toBe(1200);
  });

  it('gives each fixable reason a «رفع» and none to the reasons that are a person’s by design', () => {
    expect(HANDOFF_FIXES.TOPIC_NOT_ALLOWED).toBeDefined();
    expect(HANDOFF_FIXES.INSUFFICIENT_GROUNDING).toBeDefined();
    expect(HANDOFF_FIXES.HANDOFF_TOPIC).toBeUndefined();
    expect(HANDOFF_FIXES.HUMAN_REQUESTED).toBeUndefined();
    for (const reason of BUSINESS_HANDOFF_REASONS) {
      const fix = HANDOFF_FIXES[reason];
      if (fix !== undefined) expect(t(fix.label).length).toBeGreaterThan(5);
    }
  });

  it('shows the resolution rate, a «رفع» per reason and the questions behind one', async () => {
    const api = stubApi([
      { url: '/support-ai/analytics', body: analytics() },
      { url: '/support-ai/knowledge-gaps', body: { gaps: [] } },
      {
        url: '/support-ai/handoff-questions',
        body: {
          reason: 'TOPIC_NOT_ALLOWED',
          items: [
            {
              conversationId: CHAT_ID,
              createdAt: '2026-10-31T10:00:00.000Z',
              topic: 'PLAN_INFO',
              kind: 'SOFT',
              question: 'قیمت سه ماهه چنده؟',
            },
          ],
        },
      },
    ]);
    renderPage(<SupportAnalyticsPage route={route} denied={false} mayReadText />);
    await screen.findByText(t('web.sa_resolution_rate'));
    expect(document.body.textContent).toContain('75');
    const reason = (await screen.findByText(t('web.bchat_handoff_topic_not_allowed'))).closest(
      'li',
    )!;
    expect(within(reason).getByText(new RegExp(t('web.sa_fix_topic')))).toBeTruthy();
    // A reason that is a person's by design offers no fix.
    const person = screen.getByText(t('web.bchat_handoff_topic')).closest('li')!;
    expect(within(person).queryByText(new RegExp(`${t('web.sa_fix')}:`))).toBeNull();
    // The questions load only when opened.
    expect(api.calls.some((call) => call.url.includes('/handoff-questions'))).toBe(false);
    fireEvent.click(within(reason).getByRole('button', { name: t('web.sa_questions_show') }));
    expect(await screen.findByText('قیمت سه ماهه چنده؟')).toBeTruthy();
    expect(api.calls.find((call) => call.url.includes('/handoff-questions'))?.url).toContain(
      'reason=TOPIC_NOT_ALLOWED',
    );
  });

  it('without business_chats.view asks for no customer text at all', async () => {
    const api = stubApi([{ url: '/support-ai/analytics', body: analytics() }]);
    renderPage(<SupportAnalyticsPage route={route} denied={false} mayReadText={false} />);
    await screen.findByText(t('web.sa_resolution_rate'));
    expect(screen.getByText(t('web.sa_gaps_denied'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('web.sa_questions_show') })).toBeNull();
    expect(
      api.calls.some(
        (call) => call.url.includes('/handoff-questions') || call.url.includes('/knowledge-gaps'),
      ),
    ).toBe(false);
  });

  it('lists the knowledge gaps and builds an article from a label, never from customer text', async () => {
    stubApi([
      { url: '/support-ai/analytics', body: analytics() },
      {
        url: '/support-ai/knowledge-gaps',
        body: {
          gaps: [
            {
              topic: 'PLAN_INFO',
              intent: 'قیمت اشتراک سه ماهه',
              count: 4,
              reasons: ['INSUFFICIENT_GROUNDING'],
              examples: ['سه ماهه چنده؟'],
            },
          ],
        },
      },
    ]);
    renderPage(<SupportAnalyticsPage route={route} denied={false} mayReadText />);
    const build = (await screen.findByText(t('web.sa_gap_build'))) as HTMLAnchorElement;
    expect(screen.getByText('قیمت اشتراک سه ماهه')).toBeTruthy();
    expect(screen.getByText('سه ماهه چنده؟')).toBeTruthy();
    const href = build.getAttribute('href')!;
    expect(href).toBe(
      `/support-knowledge?new=1&title=${encodeURIComponent('قیمت اشتراک سه ماهه')}`,
    );
    expect(decodeURIComponent(href)).not.toContain('سه ماهه چنده');
  });
});

describe('knowledge page prefill', () => {
  it('opens the create form with the title from «ساخت مقاله از این», saving nothing', async () => {
    const api = stubApi([{ url: '/support-knowledge', body: [] }]);
    renderPage(
      <SupportKnowledgePage
        denied={false}
        mayReview
        route={{
          path: '/support-knowledge',
          query: new URLSearchParams({ new: '1', title: 'قیمت اشتراک سه ماهه' }),
        }}
      />,
    );
    const title = (await screen.findByDisplayValue('قیمت اشتراک سه ماهه')) as HTMLInputElement;
    expect(title).toBeTruthy();
    expect(api.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('ignores the prefill without the review permission', async () => {
    stubApi([{ url: '/support-knowledge', body: [] }]);
    renderPage(
      <SupportKnowledgePage
        denied={false}
        mayReview={false}
        route={{ path: '/support-knowledge', query: new URLSearchParams({ new: '1', title: 'x' }) }}
      />,
    );
    await waitFor(() => expect(screen.queryByDisplayValue('x')).toBeNull());
  });
});
