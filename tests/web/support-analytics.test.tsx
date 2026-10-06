import { describe, expect, it } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { SUPPORT_AI_AUTO_OUTCOMES, type PERMISSION_KEYS } from '@nexa/contracts';
import {
  AUTO_OUTCOME_LABELS,
  SUPPORT_ANALYTICS_RANGES,
  SupportAnalyticsPage,
} from '../../apps/web/src/pages/support-analytics';
import { t } from '../../apps/web/src/i18n/web.fa';
import { formatNumber } from '../../apps/web/src/format';
import { NAV, navPermitted, resolve } from '../../apps/web/src/app';
import { renderPage, stubApi } from './harness';

/**
 * TB10 — the support analytics page. Fixtures go through the real API client and are parsed
 * by the contract's schema, so a fixture that drifts from the server fails here.
 *
 * What this file defends: the page asks for the range in the address (a preset, never a
 * range it invented), draws every figure the server sends under its own label, shows NO
 * money figure and says why (OQ-TB-07), and asks nothing without `support_ai.configure`.
 */

const analytics = (overrides: Record<string, unknown> = {}) => ({
  period: {
    range: 'LAST_7_DAYS',
    start: '2026-09-28T20:30:00.000Z',
    end: '2026-10-05T20:30:00.000Z',
  },
  conversationsNow: [
    { state: 'AI_ACTIVE', count: 7 },
    { state: 'HUMAN_ACTIVE', count: 3 },
    { state: 'HANDOFF_REQUIRED', count: 2 },
    { state: 'PAUSED', count: 0 },
  ],
  handoffsByReason: [
    { reason: 'HANDOFF_TOPIC', count: 4 },
    { reason: 'LOW_CONFIDENCE', count: 1 },
  ],
  auto: {
    sent: 11,
    handedOff: 5,
    dropped: 2,
    pending: 1,
    byOutcome: [
      { outcome: 'sent', count: 11 },
      { outcome: 'guard_handoff_topic', count: 4 },
    ],
  },
  assist: { requested: 9, sent: 6, discarded: 2, failed: 1, open: 0 },
  providerRuns: [
    {
      provider: 'OPENAI',
      outcome: 'OK',
      runs: 30,
      p50LatencyMs: 1200,
      p95LatencyMs: 4100,
      inputTokens: 81234,
      outputTokens: 9123,
    },
    {
      provider: 'ANTHROPIC',
      outcome: 'TIMEOUT',
      runs: 2,
      p50LatencyMs: 20000,
      p95LatencyMs: 20000,
      inputTokens: 0,
      outputTokens: 0,
    },
  ],
  learningByState: [
    { state: 'PENDING', count: 3 },
    { state: 'APPROVED', count: 1 },
    { state: 'REJECTED', count: 0 },
  ],
  knowledgeBySource: [{ source: 'NEXA_BUILD', state: 'APPROVED', enabled: true, count: 12 }],
  aiFailures: [
    { operation: 'AUTO_DECISION', provider: 'OPENAI', failureClass: 'schema_invalid', runs: 3 },
  ],
  ...overrides,
});

const route = (query = '') => ({
  path: '/support-analytics',
  query: new URLSearchParams(query),
});

const analyticsCalls = (api: ReturnType<typeof stubApi>) =>
  api.calls.filter((call) => call.url.includes('/support-ai/analytics'));

describe('the support analytics page', () => {
  it('asks for the range in the address, and the last seven days by default', async () => {
    const api = stubApi([{ url: '/support-ai/analytics', body: analytics() }]);
    renderPage(<SupportAnalyticsPage route={route()} denied={false} />);
    await screen.findByText(t('web.sa_conversations_now'));
    const params = new URL(analyticsCalls(api)[0]!.url, 'http://x').searchParams;
    expect(params.get('range')).toBe('LAST_7_DAYS');
    expect(params.get('from')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: t('web.report_range_this_month') }));
    expect(new URLSearchParams(window.location.search).get('range')).toBe('THIS_MONTH');
  });

  it('sends a preset taken from the address as it is', async () => {
    const api = stubApi([{ url: '/support-ai/analytics', body: analytics() }]);
    renderPage(<SupportAnalyticsPage route={route('range=TODAY')} denied={false} />);
    await screen.findByText(t('web.sa_conversations_now'));
    expect(new URL(analyticsCalls(api)[0]!.url, 'http://x').searchParams.get('range')).toBe(
      'TODAY',
    );
  });

  it('draws every figure under its own label, and never an internal enum', async () => {
    stubApi([{ url: '/support-ai/analytics', body: analytics() }]);
    renderPage(<SupportAnalyticsPage route={route()} denied={false} />);
    await screen.findByText(t('web.sa_conversations_now'));
    // Conversations now, by state, in words.
    expect(screen.getAllByText(t('web.bchat_state_handoff_required')).length).toBeGreaterThan(0);
    // Handoffs by reason, in words.
    expect(screen.getByText(t('web.bchat_handoff_topic'))).toBeTruthy();
    expect(screen.getByText(t('web.bchat_handoff_low_confidence'))).toBeTruthy();
    // Automatic replies: the guard that failed, in words.
    expect(screen.getByText(t('web.sa_auto_guard_handoff_topic'))).toBeTruthy();
    // Program §12: why the AI's calls failed, by class, in words.
    const failures = screen.getByRole('table', { name: t('web.sai_ai_failures') });
    expect(within(failures).getByText(t('web.sai_failure_schema_invalid'))).toBeTruthy();
    expect(within(failures).getByText(t('web.sai_operation_auto_decision'))).toBeTruthy();
    expect(failures.textContent).not.toContain('schema_invalid');
    // Provider runs: percentiles and tokens in the row of their provider and outcome.
    const table = screen.getByRole('table', { name: t('web.sa_runs_title') });
    const rows = within(table).getAllByRole('row');
    const openai = rows.find((row) => within(row).queryByText(t('web.sai_provider_openai')))!;
    expect(within(openai).getByText(formatNumber(81234))).toBeTruthy();
    expect(within(openai).getByText(formatNumber(4100))).toBeTruthy();
    // Learning and knowledge.
    expect(screen.getByText(t('web.sk_cand_pending'))).toBeTruthy();
    expect(screen.getByText(t('web.sk_source_nexa_build'))).toBeTruthy();
    for (const raw of ['HANDOFF_REQUIRED', 'guard_handoff_topic', 'NEXA_BUILD', 'TIMEOUT']) {
      expect(screen.queryByText(raw)).toBeNull();
    }
  });

  it('shows no cost and says why: tokens, not a price nobody approved (OQ-TB-07)', async () => {
    stubApi([{ url: '/support-ai/analytics', body: analytics() }]);
    const view = renderPage(<SupportAnalyticsPage route={route()} denied={false} />);
    await screen.findByText(t('web.sa_cost_title'));
    expect(screen.getByText(t('web.sa_cost_hint'))).toBeTruthy();
    // No currency anywhere on the page.
    expect(view.container.querySelector('.money')).toBeNull();
    expect(view.container.textContent).not.toMatch(/تومان|ریال|USD|\$/u);
  });

  it('says «no permission» and asks the server nothing without the key', () => {
    const api = stubApi([]);
    renderPage(<SupportAnalyticsPage route={route()} denied />);
    expect(screen.getByText(t('web.no_permission'))).toBeTruthy();
    expect(api.calls).toHaveLength(0);
  });

  it('names every automatic outcome, and offers only presets', () => {
    for (const outcome of SUPPORT_AI_AUTO_OUTCOMES) {
      expect(t(AUTO_OUTCOME_LABELS[outcome]), outcome).not.toBe(outcome);
    }
    expect(SUPPORT_ANALYTICS_RANGES).not.toContain('CUSTOM');
  });

  it('is served at /support-analytics on support_ai.configure only', () => {
    const at = (permissions: readonly (typeof PERMISSION_KEYS)[number][]) =>
      resolve({ path: '/support-analytics', query: new URLSearchParams() }, permissions)
        .element as { props: { denied: boolean } };
    expect(at([]).props.denied).toBe(true);
    expect(at(['business_chats.view', 'support_ai.assist']).props.denied).toBe(true);
    expect(at(['support_ai.configure']).props.denied).toBe(false);
    const entry = NAV.find((item) => item.id === 'support-analytics')!;
    expect(entry.path).toBe('/support-analytics');
    expect(navPermitted(entry, ['support_ai.configure'], [])).toBe(true);
    expect(navPermitted(entry, ['business_chats.view'], [])).toBe(false);
  });
});
