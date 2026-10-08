import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { SUPPORT_AI_DEFAULT_CONFIG } from '@nexa/contracts';
import { SupportAiPage } from '../../apps/web/src/pages/support-ai';
import { AUTO_OUTCOME_LABELS } from '../../apps/web/src/pages/support-analytics';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * Roadmap A1 (2026-10-07) — «سقف پاسخ خودکار در هر جلسه» (`sessionReplyBudget`, 5–40) and
 * «سقف پاسخ خودکار در هر ساعت» (`maxAutoRepliesPerHour`, 10–60) on /support-ai: drawn from the
 * server's config with their help text, sent back unchanged by a save of anything else,
 * validated in Persian like the other numbers, and an increase under AUTO_REPLY_SAFE warned
 * about as a widening. The retired per-epoch field is no longer drawn or sent.
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

function page(config: Record<string, unknown>) {
  const api = stubApi([
    { url: '/support-ai/config', method: 'GET', body: configResponse(config) },
    { url: '/support-ai/config', method: 'PUT', body: { version: 8 } },
    { url: '/support-ai/usage', body: { since: '2026-09-04T00:00:00.000Z', rows: [] } },
  ]);
  renderPage(<SupportAiPage denied={false} mayAutoReply={false} />);
  return api;
}

const FIELDS = [
  {
    name: 'sessionReplyBudget',
    label: 'web.sai_session_reply_budget',
    hint: 'web.sai_session_reply_budget_hint',
    persian: 'سقف پاسخ خودکار در هر جلسه',
    min: 5,
    max: 40,
    stored: 20,
    bad: ['4', '41', 'بیست', '20.5', ''],
  },
  {
    name: 'maxAutoRepliesPerHour',
    label: 'web.sai_max_auto_replies_per_hour',
    hint: 'web.sai_max_auto_replies_per_hour_hint',
    persian: 'سقف پاسخ خودکار در هر ساعت',
    min: 10,
    max: 60,
    stored: 30,
    bad: ['9', '61', 'سی', '30.5', ''],
  },
] as const;

const input = async (label: (typeof FIELDS)[number]['label']) =>
  (await screen.findByLabelText(t(label))) as HTMLInputElement;
const saveButton = () =>
  screen.getByRole('button', { name: t('web.sai_save') }) as HTMLButtonElement;
const sentConfig = async (api: ReturnType<typeof stubApi>) => {
  await waitFor(() => expect(api.calls.filter((call) => call.method === 'PUT')).toHaveLength(1));
  const put = api.calls.find((call) => call.method === 'PUT')!;
  return (put.body as { config: Record<string, unknown> }).config;
};
const widening = () => screen.queryByText(t('web.sai_auto_widen_needs_owner'));

describe('the session reply budget and the hourly limit on /support-ai', () => {
  for (const f of FIELDS) {
    it(`${f.name}: draws the Persian label, help and range with the server's value`, async () => {
      page({ [f.name]: f.stored });
      expect(t(f.label)).toBe(f.persian);
      expect((await input(f.label)).value).toBe(String(f.stored));
      expect(document.body.textContent).toContain(t(f.hint));
      expect(document.body.textContent).toContain(`${t('web.sai_range')} ${f.min} – ${f.max}`);
    });

    it(`${f.name}: sends the changed value`, async () => {
      const api = page({ [f.name]: f.stored });
      fireEvent.change(await input(f.label), { target: { value: String(f.min) } });
      fireEvent.click(saveButton());
      expect((await sentConfig(api))[f.name]).toBe(f.min);
    });

    it(`${f.name}: refuses a value outside ${f.min}–${f.max} in Persian and sends nothing`, async () => {
      const api = page({ [f.name]: f.stored });
      const field = await input(f.label);
      for (const value of f.bad) {
        fireEvent.change(field, { target: { value } });
        expect(screen.getByText(t('web.sai_invalid_bounds')), value).toBeTruthy();
        expect(saveButton().disabled, value).toBe(true);
      }
      fireEvent.click(saveButton());
      expect(api.calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
      fireEvent.change(field, { target: { value: String(f.max) } });
      expect(screen.queryByText(t('web.sai_invalid_bounds'))).toBeNull();
    });

    it(`${f.name}: an increase under AUTO_REPLY_SAFE warns of a widening; a decrease does not`, async () => {
      page({ [f.name]: f.stored });
      const field = await input(f.label);
      expect(widening()).toBeNull();
      fireEvent.change(field, { target: { value: String(f.stored - 1) } });
      expect(widening()).toBeNull();
      fireEvent.change(field, { target: { value: String(f.stored + 1) } });
      expect(widening()).toBeTruthy();
    });

    it(`${f.name}: outside AUTO_REPLY_SAFE an increase is ordinary configuration`, async () => {
      page({ mode: 'ASSIST_ONLY', [f.name]: f.stored });
      fireEvent.change(await input(f.label), { target: { value: String(f.stored + 1) } });
      expect(widening()).toBeNull();
    });
  }

  it('sends both back unchanged when an unrelated field is saved, and never the retired one', async () => {
    const api = page({ sessionReplyBudget: 12, maxAutoRepliesPerHour: 44 });
    await input('web.sai_session_reply_budget');
    fireEvent.change(await screen.findByLabelText(t('web.sai_tone')), {
      target: { value: 'کوتاه' },
    });
    fireEvent.click(saveButton());
    const config = await sentConfig(api);
    expect(config).toMatchObject({ sessionReplyBudget: 12, maxAutoRepliesPerHour: 44 });
    expect('maxConsecutiveReplies' in config).toBe(false);
  });

  it('the widening warning names both limits; the loop outcomes read as session and hour', () => {
    expect(t('web.sai_auto_widen_needs_owner')).toContain('سقف پاسخ در هر جلسه');
    expect(t('web.sai_auto_widen_needs_owner')).toContain('سقف پاسخ در هر ساعت');
    expect(t(AUTO_OUTCOME_LABELS.guard_consecutive)).toBe('سقف پاسخ در جلسه');
    expect(t(AUTO_OUTCOME_LABELS.guard_window)).toBe('سقف پاسخ در یک ساعت');
  });

  it('rolling deploy: against an older replica the absent limits are empty, never "undefined", and not sent', async () => {
    const { sessionReplyBudget: _s, maxAutoRepliesPerHour: _h, ...older } = configResponse().config;
    const api = stubApi([
      {
        url: '/support-ai/config',
        method: 'GET',
        body: { ...configResponse(), config: { ...older, maxConsecutiveReplies: 4 } },
      },
      { url: '/support-ai/config', method: 'PUT', body: { version: 8 } },
      { url: '/support-ai/usage', body: { since: '2026-09-04T00:00:00.000Z', rows: [] } },
    ]);
    renderPage(<SupportAiPage denied={false} mayAutoReply={false} />);
    expect((await input('web.sai_session_reply_budget')).value).toBe('');
    expect((await input('web.sai_max_auto_replies_per_hour')).value).toBe('');
    expect(document.body.textContent).not.toContain('undefined');
    fireEvent.change(await screen.findByLabelText(t('web.sai_tone')), {
      target: { value: 'کوتاه' },
    });
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    const config = await sentConfig(api);
    expect('sessionReplyBudget' in config).toBe(false);
    expect('maxAutoRepliesPerHour' in config).toBe(false);
    // The older replica requires the retired limit: echoed back as it sent it.
    expect(config.maxConsecutiveReplies).toBe(4);
    expect(config.toneInstructions).toBe('کوتاه');
  });
});
