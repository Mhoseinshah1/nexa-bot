import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { SUPPORT_AI_DEFAULT_CONFIG } from '@nexa/contracts';
import { SupportAiPage } from '../../apps/web/src/pages/support-ai';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * PR-10 — the configuration is the kit settings pattern: per-field dirty state, ONE sticky bar
 * «N تغییر ذخیره‌نشده — ذخیره / لغو». The save is the existing whole-document PUT (the
 * contract requires every field): the loaded values with the changed fields applied over them.
 */

const LOADED = {
  ...SUPPORT_AI_DEFAULT_CONFIG,
  mode: 'ASSIST_ONLY',
  primary: { provider: 'OPENAI', model: 'gpt-test-1' },
  autoTopics: ['APP_SETUP'],
  toneInstructions: 'رسمی',
};

function page() {
  const api = stubApi([
    {
      url: '/support-ai/config',
      method: 'GET',
      body: {
        config: LOADED,
        version: 4,
        credentials: [],
        capabilities: {
          OPENAI: { structuredOutput: true, vision: true },
          ANTHROPIC: { structuredOutput: true, vision: true },
          ZAI: { structuredOutput: false, vision: false },
        },
        chainUnavailable: false,
      },
    },
    { url: '/support-ai/config', method: 'PUT', body: { version: 5 } },
    { url: '/support-ai/usage', body: { since: '2026-09-04T00:00:00.000Z', rows: [] } },
  ]);
  renderPage(<SupportAiPage denied={false} mayAutoReply={false} />);
  return api;
}

const tone = async () => (await screen.findByLabelText(t('web.sai_tone'))) as HTMLTextAreaElement;
const settle = async () =>
  (await screen.findByLabelText(t('web.sai_settle_delay_seconds'))) as HTMLInputElement;
const bar = () => screen.queryByRole('region', { name: t('web.kit_settings_save') });
const unsaved = (n: number) => t('web.kit_settings_unsaved').replace('{n}', String(n));

describe('the support AI settings bar', () => {
  it('counts one change per field that differs, and drops it when the value returns', async () => {
    page();
    fireEvent.change(await tone(), { target: { value: 'مؤدب' } });
    expect(bar()!.textContent).toContain(unsaved(1));
    fireEvent.change(await settle(), { target: { value: '7' } });
    expect(bar()!.textContent).toContain(unsaved(2));
    fireEvent.change(await settle(), {
      target: { value: String(LOADED.settleDelaySeconds) },
    });
    expect(bar()!.textContent).toContain(unsaved(1));
    fireEvent.change(await tone(), { target: { value: 'رسمی' } });
    expect(bar()).toBeNull();
  });

  it('saves the changed field over the loaded values, in one PUT with version and key', async () => {
    const api = page();
    fireEvent.change(await tone(), { target: { value: 'مؤدب' } });
    fireEvent.click(screen.getByRole('button', { name: t('web.kit_settings_save') }));
    await waitFor(() => expect(api.calls.filter((c) => c.method === 'PUT')).toHaveLength(1));
    const body = api.calls.find((c) => c.method === 'PUT')!.body as {
      expectedVersion: number;
      idempotencyKey: string;
      config: Record<string, unknown>;
    };
    expect(body.expectedVersion).toBe(4);
    expect(body.idempotencyKey.length).toBeGreaterThanOrEqual(8);
    expect(body.config.toneInstructions).toBe('مؤدب');
    // Everything not edited is exactly what was loaded.
    expect(body.config).toMatchObject({ ...LOADED, toneInstructions: 'مؤدب' });
  });

  it('cancel restores the loaded values and sends nothing', async () => {
    const api = page();
    fireEvent.change(await tone(), { target: { value: 'مؤدب' } });
    fireEvent.change(await settle(), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: t('web.kit_settings_cancel') }));
    expect((await tone()).value).toBe('رسمی');
    expect((await settle()).value).toBe(String(LOADED.settleDelaySeconds));
    expect(bar()).toBeNull();
    expect(api.calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
  });

  it('a validation error keeps the edits, shows the error and sends nothing', async () => {
    const api = page();
    fireEvent.change(await tone(), { target: { value: 'مؤدب' } });
    fireEvent.change(await settle(), { target: { value: '2' } });
    expect(screen.getAllByText(t('web.sai_invalid_bounds')).length).toBeGreaterThan(0);
    const save = screen.getByRole('button', { name: t('web.kit_settings_save') });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(save);
    expect(api.calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
    expect((await tone()).value).toBe('مؤدب');
    expect((await settle()).value).toBe('2');
    expect(bar()!.textContent).toContain(unsaved(2));
  });
});
