import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { SUPPORT_AI_DEFAULT_CONFIG } from '@nexa/contracts';
import { SupportAiPage } from '../../apps/web/src/pages/support-ai';
import { AUTO_OUTCOME_LABELS } from '../../apps/web/src/pages/support-analytics';
import { HANDOFF_LABELS } from '../../apps/web/src/pages/handoff-labels';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * Hotfix 2026-10-06 — «حداکثر سؤال تکمیلی پیاپی» (`maxConsecutiveClarifyingQuestions`) on
 * /support-ai: drawn from the server's config, sent back unchanged by a save of anything else,
 * validated in Persian like the other numbers, and an increase under AUTO_REPLY_SAFE warned
 * about as a widening before the server charges `support_ai.auto_reply` for it.
 */

const configResponse = (config: Record<string, unknown> = {}, version = 7) => ({
  config: {
    ...SUPPORT_AI_DEFAULT_CONFIG,
    mode: 'AUTO_REPLY_SAFE',
    primary: { provider: 'OPENAI', model: 'gpt-test-1' },
    ...config,
  },
  version,
  credentials: [],
  capabilities: {
    OPENAI: { structuredOutput: true, vision: true },
    ANTHROPIC: { structuredOutput: true, vision: true },
    ZAI: { structuredOutput: false, vision: false },
  },
  chainUnavailable: false,
});

function page(config: Record<string, unknown>, mayAutoReply = false) {
  const api = stubApi([
    { url: '/support-ai/config', method: 'GET', body: configResponse(config) },
    { url: '/support-ai/config', method: 'PUT', body: { version: 8 } },
    { url: '/support-ai/usage', body: { since: '2026-09-04T00:00:00.000Z', rows: [] } },
  ]);
  renderPage(<SupportAiPage denied={false} mayAutoReply={mayAutoReply} />);
  return api;
}

const field = async () =>
  (await screen.findByLabelText(t('web.sai_max_consecutive_clarifying'))) as HTMLInputElement;
const saveButton = () =>
  screen.getByRole('button', { name: t('web.sai_save') }) as HTMLButtonElement;
const sentConfig = async (api: ReturnType<typeof stubApi>) => {
  await waitFor(() => expect(api.calls.filter((call) => call.method === 'PUT')).toHaveLength(1));
  const put = api.calls.find((call) => call.method === 'PUT')!;
  return (put.body as { config: Record<string, unknown> }).config;
};
const widening = () => screen.queryByText(t('web.sai_auto_widen_needs_owner'));

describe('the clarifying-question limit on /support-ai', () => {
  it('draws the Persian label and help text, with the value the server has', async () => {
    page({ maxConsecutiveClarifyingQuestions: 3 });
    expect(t('web.sai_max_consecutive_clarifying')).toBe('حداکثر سؤال تکمیلی پیاپی');
    expect(t('web.sai_max_consecutive_clarifying_hint')).toBe(
      'حداکثر تعداد سؤال‌های تکمیلی متوالی که هوش مصنوعی می‌تواند در پاسخ خودکار از مشتری بپرسد. پس از رسیدن به این حد، گفتگو به پشتیبان ارجاع می‌شود.',
    );
    expect((await field()).value).toBe('3');
    expect(document.body.textContent).toContain(t('web.sai_max_consecutive_clarifying_hint'));
    expect(document.body.textContent).toContain(`${t('web.sai_range')} 1 – 10`);
  });

  it('sends the changed value, and reloads what the server then has', async () => {
    const api = page({ maxConsecutiveClarifyingQuestions: 2 });
    fireEvent.change(await field(), { target: { value: '4' } });
    fireEvent.click(saveButton());
    expect((await sentConfig(api)).maxConsecutiveClarifyingQuestions).toBe(4);
    // After the save the page reads the configuration again: the saved value is drawn.
    stubApi([
      {
        url: '/support-ai/config',
        method: 'GET',
        body: configResponse({ maxConsecutiveClarifyingQuestions: 4 }, 8),
      },
      { url: '/support-ai/usage', body: { since: '2026-09-04T00:00:00.000Z', rows: [] } },
    ]);
    await waitFor(async () => expect((await field()).value).toBe('4'));
  });

  it('sends it back unchanged when an unrelated field is saved', async () => {
    const api = page({ maxConsecutiveClarifyingQuestions: 7 });
    await field();
    fireEvent.change(await screen.findByLabelText(t('web.sai_tone')), {
      target: { value: 'کوتاه' },
    });
    fireEvent.click(saveButton());
    const config = await sentConfig(api);
    expect(config.toneInstructions).toBe('کوتاه');
    expect(config.maxConsecutiveClarifyingQuestions).toBe(7);
  });

  it('is dirty only while the value differs from the server’s', async () => {
    page({ maxConsecutiveClarifyingQuestions: 2 });
    const input = await field();
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(input, { target: { value: '3' } });
    expect(saveButton().disabled).toBe(false);
    fireEvent.change(input, { target: { value: '2' } });
    expect(saveButton().disabled).toBe(true);
  });

  it('refuses a value outside 1–10, or not a whole number, in Persian, and sends nothing', async () => {
    const api = page({ maxConsecutiveClarifyingQuestions: 2 });
    const input = await field();
    for (const value of ['0', '11', 'دو', '2.5', '']) {
      fireEvent.change(input, { target: { value } });
      expect(screen.getByText(t('web.sai_invalid_bounds')), value).toBeTruthy();
      expect(saveButton().disabled, value).toBe(true);
    }
    fireEvent.click(saveButton());
    expect(api.calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
    fireEvent.change(input, { target: { value: '10' } });
    expect(screen.queryByText(t('web.sai_invalid_bounds'))).toBeNull();
  });

  it('warns that an increase under AUTO_REPLY_SAFE is a widening; a decrease is not', async () => {
    page({ maxConsecutiveClarifyingQuestions: 2 });
    const input = await field();
    expect(widening()).toBeNull();
    fireEvent.change(input, { target: { value: '1' } });
    expect(widening()).toBeNull();
    fireEvent.change(input, { target: { value: '3' } });
    expect(widening()).toBeTruthy();
    expect(t('web.sai_auto_widen_needs_owner')).toContain('سقف سؤال تکمیلی');
  });

  it('outside AUTO_REPLY_SAFE an increase is ordinary configuration', async () => {
    page({ mode: 'ASSIST_ONLY', maxConsecutiveClarifyingQuestions: 2 });
    fireEvent.change(await field(), { target: { value: '5' } });
    expect(widening()).toBeNull();
  });

  it('names the new outcome and handoff reason in Persian for the operator', () => {
    expect(t(AUTO_OUTCOME_LABELS.sent_clarifying)).toBe('سؤال تکمیلی فرستاده شد');
    expect(t(AUTO_OUTCOME_LABELS.guard_clarifying_limit)).toBe('سقف سؤال‌های تکمیلی پیاپی');
    expect(t(HANDOFF_LABELS.CLARIFYING_LIMIT)).toBe('سؤال‌های تکمیلی پیاپی هوش مصنوعی به سقف رسید');
  });
});
