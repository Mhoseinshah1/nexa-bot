import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { SUPPORT_AI_DEFAULT_CONFIG } from '@nexa/contracts';
import { SupportAiPage } from '../../apps/web/src/pages/support-ai';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * Phase 4 PR-4 — the switch «پاسخ هوش مصنوعی در تیکت‌های ربات» on /support-ai. It is the ordinary
 * setting (`support.ai.tickets_enabled`), OFF until the owner turns it on, saved with the version
 * the card read, and it says plainly when the support AI is not in the automatic mode.
 */

const configResponse = (mode: string) => ({
  config: {
    ...SUPPORT_AI_DEFAULT_CONFIG,
    mode,
    primary: { provider: 'OPENAI', model: 'gpt-test-1' },
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

const setting = (value: boolean, version: number | null) => ({
  key: 'support.ai.tickets_enabled',
  value,
  source: version === null ? 'DEFAULT' : 'TENANT',
  version,
  updatedAt: null,
  updatedByAdminId: null,
  description: 'x',
  zeroMeaning: 'NOT_APPLICABLE',
  mutability: 'RUNTIME',
  classification: 'PUBLIC',
  configures: null,
  consumer: 'ACTIVE',
  storedValueInvalid: false,
});

function page(mode: string, current = setting(false, null), mayAutoReply = true) {
  const api = stubApi([
    { url: '/support-ai/config', method: 'GET', body: configResponse(mode) },
    { url: '/support-ai/usage', body: { since: '2026-09-04T00:00:00.000Z', rows: [] } },
    { url: '/settings', method: 'GET', body: { settings: [current] } },
    {
      url: '/settings/support.ai.tickets_enabled',
      method: 'POST',
      body: { setting: setting(true, 1), changed: true },
    },
  ]);
  renderPage(<SupportAiPage denied={false} mayAutoReply={mayAutoReply} />);
  return api;
}

const box = async () =>
  (await screen.findByRole('checkbox', { name: t('web.sai_tickets_label') })) as HTMLInputElement;

describe('the ticket AI switch on /support-ai', () => {
  it('is OFF by default, titled in Persian', async () => {
    page('AUTO_REPLY_SAFE');
    expect(await screen.findByText(t('web.sai_tickets_title'))).toBeTruthy();
    await waitFor(async () => expect((await box()).disabled).toBe(false));
    expect((await box()).checked).toBe(false);
    expect(screen.getAllByText(t('web.sai_tickets_off')).length).toBeGreaterThan(0);
  });

  it('turning it on saves the setting with the version the card read, and nothing else', async () => {
    const api = page('AUTO_REPLY_SAFE');
    await waitFor(async () => expect((await box()).disabled).toBe(false));
    fireEvent.click(await box());
    await waitFor(() => expect(api.calls.filter((call) => call.method === 'POST')).toHaveLength(1));
    const post = api.calls.find((call) => call.method === 'POST')!;
    expect(post.url).toContain('/settings/support.ai.tickets_enabled');
    expect(post.body).toMatchObject({ value: true, expectedVersion: null });
    expect(
      api.calls.some((call) => call.url.includes('/support-ai/config') && call.method === 'PUT'),
    ).toBe(false);
  });

  it('reads an ON setting as on and turning it off sends false with its version', async () => {
    const api = page('AUTO_REPLY_SAFE', setting(true, 3));
    await waitFor(async () => expect((await box()).checked).toBe(true));
    fireEvent.click(await box());
    await waitFor(() => expect(api.calls.filter((call) => call.method === 'POST')).toHaveLength(1));
    expect(api.calls.find((call) => call.method === 'POST')!.body).toMatchObject({
      value: false,
      expectedVersion: 3,
    });
  });

  it('warns when it is on but the support AI is not automatic', async () => {
    page('ASSIST_ONLY', setting(true, 2));
    expect(await screen.findByText(t('web.sai_tickets_needs_auto'))).toBeTruthy();
  });

  it('says nothing is wrong when it is automatic', async () => {
    page('AUTO_REPLY_SAFE', setting(true, 2));
    await waitFor(async () => expect((await box()).checked).toBe(true));
    expect(screen.queryByText(t('web.sai_tickets_needs_auto'))).toBeNull();
  });

  it('without the permission the box is disabled and says why', async () => {
    page('AUTO_REPLY_SAFE', setting(false, null), false);
    expect(await screen.findByText(t('web.sai_tickets_no_permission'))).toBeTruthy();
    expect((await box()).disabled).toBe(true);
  });
});
