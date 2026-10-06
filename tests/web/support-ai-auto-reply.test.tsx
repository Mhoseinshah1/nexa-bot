import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { SUPPORT_AI_DEFAULT_CONFIG, SUPPORT_AI_SAFE_TOPICS } from '@nexa/contracts';
import { SAI_AUTO_TOPIC_LABELS, SupportAiPage } from '../../apps/web/src/pages/support-ai';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * Hotfix — the automatic-reply allowlist and confidence floor on /support-ai.
 *
 * The form used to omit `autoTopics` and `autoMinConfidence`, so the contract's defaults
 * (none, HIGH) were what every save sent: changing the tone silently emptied the owner's
 * allowlist and raised a MEDIUM floor back to HIGH. What this file defends: both fields are
 * drawn from the server's config, sent back unchanged by a save of anything else, sent as the
 * enum the operator chose, and a refusal for widening them is shown by name.
 */

const configResponse = (config: Record<string, unknown> = {}) => ({
  config: {
    ...SUPPORT_AI_DEFAULT_CONFIG,
    mode: 'AUTO_REPLY_SAFE',
    primary: { provider: 'OPENAI', model: 'gpt-test-1' },
    ...config,
  },
  version: 7,
  credentials: [],
  capabilities: {
    OPENAI: { structuredOutput: true, vision: true },
    ANTHROPIC: { structuredOutput: true, vision: true },
    ZAI: { structuredOutput: false, vision: false },
  },
  chainUnavailable: false,
});

function page(
  config: Record<string, unknown>,
  put: { status?: number; body: unknown } = { body: { version: 8 } },
  mayAutoReply = false,
) {
  const api = stubApi([
    { url: '/support-ai/config', method: 'GET', body: configResponse(config) },
    { url: '/support-ai/config', method: 'PUT', ...put },
    { url: '/support-ai/usage', body: { since: '2026-09-04T00:00:00.000Z', rows: [] } },
  ]);
  renderPage(<SupportAiPage denied={false} mayAutoReply={mayAutoReply} />);
  return api;
}

const topicsGroup = async () =>
  within(await screen.findByRole('group', { name: t('web.sai_auto_topics') }));
const topicBox = async (topic: (typeof SUPPORT_AI_SAFE_TOPICS)[number]) =>
  (await topicsGroup()).getByRole('checkbox', {
    name: t(SAI_AUTO_TOPIC_LABELS[topic]),
  }) as HTMLInputElement;
const confidence = async () =>
  (await screen.findByLabelText(t('web.sai_auto_min_confidence'))) as HTMLSelectElement;

const sentConfig = async (api: ReturnType<typeof stubApi>) => {
  await waitFor(() => expect(api.calls.filter((call) => call.method === 'PUT')).toHaveLength(1));
  const put = api.calls.find((call) => call.method === 'PUT')!;
  return (put.body as { config: Record<string, unknown> }).config;
};
const save = () => fireEvent.click(screen.getByRole('button', { name: t('web.sai_save') }));

describe('the automatic-reply topics and confidence on /support-ai', () => {
  it('draws one Persian checkbox per safe topic, checked exactly as the server has them', async () => {
    page({ autoTopics: ['APP_SETUP', 'GREETING'] });
    const group = await topicsGroup();
    expect(group.getAllByRole('checkbox')).toHaveLength(SUPPORT_AI_SAFE_TOPICS.length);
    for (const topic of SUPPORT_AI_SAFE_TOPICS) {
      expect((await topicBox(topic)).checked, topic).toBe(
        topic === 'APP_SETUP' || topic === 'GREETING',
      );
    }
    // The exact labels the owner asked for, and no enum anywhere on the page.
    expect(t('web.sai_auto_topic_connection_troubleshooting')).toBe('مشکل اتصال');
    expect(t('web.sai_auto_topic_app_setup')).toBe('راه‌اندازی برنامه');
    expect(t('web.sai_auto_topic_subscription_update')).toBe('بروزرسانی اشتراک');
    expect(t('web.sai_auto_topic_service_info')).toBe('اطلاعات سرویس');
    expect(t('web.sai_auto_topic_traffic_and_expiry')).toBe('حجم و تاریخ انقضا');
    expect(t('web.sai_auto_topic_plan_info')).toBe('اطلاعات پلن');
    expect(t('web.sai_auto_topic_known_error')).toBe('خطای شناخته‌شده');
    expect(t('web.sai_auto_topic_greeting')).toBe('سلام و احوالپرسی');
    for (const topic of SUPPORT_AI_SAFE_TOPICS) {
      expect(document.body.textContent).not.toContain(topic);
    }
    expect(document.body.textContent).not.toContain('MEDIUM');
  });

  it('shows HIGH as «زیاد» and MEDIUM as «متوسط», selected as the server has it', async () => {
    page({ autoMinConfidence: 'MEDIUM' });
    const select = await confidence();
    expect(select.value).toBe('MEDIUM');
    const options = within(select).getAllByRole('option') as HTMLOptionElement[];
    expect(options.map((option) => [option.value, option.textContent])).toEqual([
      ['MEDIUM', 'متوسط'],
      ['HIGH', 'زیاد'],
    ]);
    expect(options.find((option) => option.selected)?.textContent).toBe('متوسط');
  });

  it('sends both back unchanged when an unrelated field is saved', async () => {
    const api = page({ autoTopics: ['KNOWN_ERROR', 'PLAN_INFO'], autoMinConfidence: 'MEDIUM' });
    fireEvent.change(await screen.findByLabelText(t('web.sai_tone')), {
      target: { value: 'کوتاه' },
    });
    save();
    const config = await sentConfig(api);
    expect(config.toneInstructions).toBe('کوتاه');
    // The same set, in the contract's order (the server's check is set-based).
    expect(config.autoTopics).toEqual(['PLAN_INFO', 'KNOWN_ERROR']);
    expect(config.autoMinConfidence).toBe('MEDIUM');
  });

  it('sends the enum of a topic the operator ticks, and drops one they untick', async () => {
    const api = page({ autoTopics: ['GREETING'] });
    fireEvent.click(await topicBox('CONNECTION_TROUBLESHOOTING'));
    fireEvent.click(await topicBox('GREETING'));
    // Widening is charged `support_ai.auto_reply`; the page says so before the save.
    expect(screen.getByText(t('web.sai_auto_widen_needs_owner'))).toBeTruthy();
    save();
    const config = await sentConfig(api);
    expect(config.autoTopics).toEqual(['CONNECTION_TROUBLESHOOTING']);
    expect(config.autoMinConfidence).toBe('HIGH');
  });

  it('sends MEDIUM when the floor is lowered from HIGH', async () => {
    const api = page({ autoTopics: ['GREETING'], autoMinConfidence: 'HIGH' });
    fireEvent.change(await confidence(), { target: { value: 'MEDIUM' } });
    save();
    const config = await sentConfig(api);
    expect(config.autoMinConfidence).toBe('MEDIUM');
    expect(config.autoTopics).toEqual(['GREETING']);
  });

  it('shows the server’s refusal to widen automatic replies, by name', async () => {
    const api = page(
      { autoTopics: [] },
      {
        status: 403,
        body: {
          error: {
            kind: 'PERMISSION_DENIED',
            code: 'platform.permission_denied',
            message: 'Missing permission "support_ai.auto_reply".',
            details: { permission: 'support_ai.auto_reply' },
            correlationId: 'c',
          },
        },
      },
    );
    fireEvent.click(await topicBox('APP_SETUP'));
    save();
    expect((await sentConfig(api)).autoTopics).toEqual(['APP_SETUP']);
    expect(await screen.findByText(t('web.sai_fault_auto_reply'))).toBeTruthy();
  });

  it('keeps an untouched empty allowlist empty, and the HIGH default HIGH', async () => {
    const api = page({ autoTopics: [], autoMinConfidence: 'HIGH' });
    for (const topic of SUPPORT_AI_SAFE_TOPICS) {
      expect((await topicBox(topic)).checked, topic).toBe(false);
    }
    expect((await confidence()).value).toBe('HIGH');
    expect(screen.queryByText(t('web.sai_auto_widen_needs_owner'))).toBeNull();
    fireEvent.change(await screen.findByLabelText(t('web.sai_tone')), {
      target: { value: 'رسمی' },
    });
    save();
    const config = await sentConfig(api);
    expect(config.autoTopics).toEqual([]);
    expect(config.autoMinConfidence).toBe('HIGH');
  });

  it('is not dirty after a topic is ticked off and on again, whatever order the server stored', async () => {
    page({ autoTopics: ['KNOWN_ERROR', 'PLAN_INFO'] });
    const button = (await screen.findByRole('button', {
      name: t('web.sai_save'),
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    for (const topic of ['PLAN_INFO', 'KNOWN_ERROR'] as const) {
      fireEvent.click(await topicBox(topic));
      expect(button.disabled, topic).toBe(false);
      fireEvent.click(await topicBox(topic));
      expect(button.disabled, topic).toBe(true);
    }
  });

  it('warns about widening only: a new topic or a floor lowered to MEDIUM, never a narrowing', async () => {
    page({ autoTopics: ['GREETING'], autoMinConfidence: 'MEDIUM' });
    const warning = () => screen.queryByText(t('web.sai_auto_widen_needs_owner'));
    fireEvent.click(await topicBox('GREETING'));
    expect(warning()).toBeNull();
    fireEvent.change(await confidence(), { target: { value: 'HIGH' } });
    expect(warning()).toBeNull();
    fireEvent.change(await confidence(), { target: { value: 'MEDIUM' } });
    expect(warning()).toBeNull();
  });

  it('warns when the floor alone is lowered from HIGH to MEDIUM', async () => {
    page({ autoTopics: [], autoMinConfidence: 'HIGH' });
    fireEvent.change(await confidence(), { target: { value: 'MEDIUM' } });
    expect(screen.getByText(t('web.sai_auto_widen_needs_owner'))).toBeTruthy();
  });

  it('tells an actor holding the auto-reply key that the server will check it', async () => {
    page({ autoTopics: [] }, { body: { version: 8 } }, true);
    fireEvent.click(await topicBox('APP_SETUP'));
    expect(screen.getByText(t('web.sai_auto_widen_entering'))).toBeTruthy();
    expect(screen.queryByText(t('web.sai_auto_widen_needs_owner'))).toBeNull();
  });

  it('reloads both fields from a newer version, and saves against it', async () => {
    page({ autoTopics: ['GREETING'], autoMinConfidence: 'HIGH' });
    await topicsGroup();
    // Somebody else saved v8 meanwhile; this save is refused and the page reads again.
    const conflict = {
      error: {
        kind: 'CONFLICT',
        code: 'support_ai.version_conflict',
        message: 'conflict',
        details: {},
        correlationId: 'c',
      },
    };
    const newer = { ...configResponse({ autoTopics: ['APP_SETUP'], autoMinConfidence: 'MEDIUM' }) };
    stubApi([
      { url: '/support-ai/config', method: 'GET', body: { ...newer, version: 8 } },
      { url: '/support-ai/config', method: 'PUT', status: 409, body: conflict },
      { url: '/support-ai/usage', body: { since: '2026-09-04T00:00:00.000Z', rows: [] } },
    ]);
    fireEvent.change(await screen.findByLabelText(t('web.sai_tone')), {
      target: { value: 'کوتاه' },
    });
    save();
    fireEvent.click(await screen.findByRole('button', { name: t('web.sai_reload') }));
    await waitFor(async () => expect((await topicBox('APP_SETUP')).checked).toBe(true));
    expect((await topicBox('GREETING')).checked).toBe(false);
    expect((await confidence()).value).toBe('MEDIUM');
    const api = stubApi([
      { url: '/support-ai/config', method: 'GET', body: { ...newer, version: 8 } },
      { url: '/support-ai/config', method: 'PUT', body: { version: 9 } },
      { url: '/support-ai/usage', body: { since: '2026-09-04T00:00:00.000Z', rows: [] } },
    ]);
    fireEvent.change(await screen.findByLabelText(t('web.sai_tone')), {
      target: { value: 'رسمی' },
    });
    save();
    const config = await sentConfig(api);
    const put = api.calls.find((call) => call.method === 'PUT')!.body as {
      expectedVersion: number;
    };
    expect(put.expectedVersion).toBe(8);
    expect(config.autoTopics).toEqual(['APP_SETUP']);
    expect(config.autoMinConfidence).toBe('MEDIUM');
  });
});
