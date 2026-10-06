import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  SUPPORT_AI_DEFAULT_CONFIG,
  SUPPORT_AI_DRAFT_UNCLAIMED_SECONDS,
  type PERMISSION_KEYS,
} from '@nexa/contracts';
import { SupportAiPage, supportAiFault } from '../../apps/web/src/pages/support-ai';
import {
  ASSIST_POLL_MS,
  ASSIST_WAIT_MS,
  AssistCard,
  awaitingDraft,
} from '../../apps/web/src/pages/support-assist';
import { BusinessChatDetailPage } from '../../apps/web/src/pages/business-chats';
import { ApiError } from '../../apps/web/src/api/client';
import { t } from '../../apps/web/src/i18n/web.fa';
import { NAV, navPermitted, resolve } from '../../apps/web/src/app';
import { renderPage, stubApi } from './harness';

/**
 * TB4/TB5 — the support AI's settings page and the Assist panel. Fixtures go through the
 * real API client and are parsed by the contract's schemas, so a fixture that drifts from
 * the server fails here.
 *
 * What this file defends: a save names the version it was built from; the server's refusal
 * to ENTER automatic replies is shown as that, not as a generic error; a key goes up once
 * and is never drawn — no value, no masked stand-in — and the region picker exists only for
 * Z.AI; a draft request carries a fresh key per click; what is sent is the operator's
 * EDITED text; discard sends nothing; and a failed draft says so neutrally.
 */

const CHAT_ID = '019400ab-cdef-7012-8345-6789abcdef01';
const DRAFT_ID = '019460ab-cdef-7012-8345-6789abcdef01';
const SECRET = 'sk-test-THIS-MUST-NEVER-RENDER-1234567890';

/** A capability test whose model can be listed but rejects strict structured output. */
const TEST_ANSWER = {
  outcome: 'INVALID_OUTPUT',
  code: 'openai.http_400',
  failureClass: 'unsupported_capability',
  latencyMs: 420,
  checks: [
    {
      check: 'MODEL_ACCESS',
      result: 'PASS',
      outcome: 'OK',
      failureClass: null,
      code: null,
      httpStatus: null,
      providerErrorCode: null,
      providerErrorType: null,
      providerErrorParam: null,
      issuePath: null,
      issueCode: null,
      latencyMs: 120,
    },
    {
      check: 'STRUCTURED_GENERATION',
      result: 'FAIL',
      outcome: 'INVALID_OUTPUT',
      failureClass: 'unsupported_capability',
      code: 'openai.http_400',
      httpStatus: 400,
      providerErrorCode: null,
      providerErrorType: 'invalid_request_error',
      providerErrorParam: 'response_format',
      issuePath: null,
      issueCode: null,
      latencyMs: 300,
    },
    ...(['DECISION_SCHEMA', 'VISION'] as const).map((check) => ({
      check,
      result: 'NOT_TESTED',
      outcome: null,
      failureClass: null,
      code: null,
      httpStatus: null,
      providerErrorCode: null,
      providerErrorType: null,
      providerErrorParam: null,
      issuePath: null,
      issueCode: null,
      latencyMs: null,
    })),
  ],
};

const diagnostic = (overrides: Record<string, unknown> = {}) => ({
  failureClass: 'schema_invalid',
  operation: null,
  provider: null,
  model: null,
  attemptIndex: null,
  outcome: null,
  httpStatus: null,
  providerErrorCode: null,
  providerErrorType: null,
  providerErrorParam: null,
  issuePath: null,
  issueCode: null,
  latencyMs: null,
  inputTokens: null,
  outputTokens: null,
  at: null,
  ...overrides,
});

const credential = (overrides: Record<string, unknown> = {}) => ({
  provider: 'OPENAI',
  configured: true,
  setAt: '2026-10-01T09:00:00.000Z',
  region: null,
  trippedUntil: null,
  lastTestOutcome: 'OK',
  lastTestFailureClass: null,
  lastTestedAt: '2026-10-01T09:05:00.000Z',
  // TB10: the provider's health, as the server derived it.
  breaker: 'CLOSED',
  consecutiveFailures: 0,
  rejectedAt: null,
  ...overrides,
});

const configResponse = (config: Record<string, unknown> = {}) => ({
  config: {
    ...SUPPORT_AI_DEFAULT_CONFIG,
    mode: 'ASSIST_ONLY',
    primary: { provider: 'OPENAI', model: 'gpt-test-1' },
    ...config,
  },
  version: 3,
  credentials: [
    credential(),
    credential({
      provider: 'ANTHROPIC',
      configured: false,
      setAt: null,
      lastTestOutcome: null,
      lastTestedAt: null,
    }),
    credential({ provider: 'ZAI', region: 'CHINA', lastTestOutcome: 'AUTH_FAILED' }),
  ],
  capabilities: {
    OPENAI: { structuredOutput: true, vision: true },
    ANTHROPIC: { structuredOutput: true, vision: true },
    ZAI: { structuredOutput: false, vision: false },
  },
  chainUnavailable: false,
});

const usage = {
  since: '2026-09-04T00:00:00.000Z',
  rows: [
    {
      provider: 'OPENAI',
      model: 'gpt-test-1',
      operation: 'ASSIST_DRAFT',
      calls: 12,
      failures: 1,
      inputTokens: 3400,
      outputTokens: 900,
      avgLatencyMs: 1800,
    },
  ],
};

const denial = (permission: string) => ({
  error: {
    kind: 'PERMISSION_DENIED',
    code: 'platform.permission_denied',
    message: `Missing permission "${permission}".`,
    details: { permission },
    correlationId: 'c',
  },
});

type Routes = Parameters<typeof stubApi>[0];

function settings(extra: Routes = [], mayAutoReply = false) {
  // Extras first: among equally long matches the harness answers with the first.
  const api = stubApi([
    ...extra,
    { url: '/support-ai/config', method: 'GET', body: configResponse() },
    { url: '/support-ai/config', method: 'PUT', body: { version: 4 } },
    { url: '/support-ai/usage', body: usage },
    { url: '/support-ai/credentials/', method: 'PUT', body: { replaced: false } },
    { url: '/support-ai/credentials/', method: 'DELETE', body: { removed: true } },
    {
      url: '/test',
      method: 'POST',
      body: TEST_ANSWER,
    },
  ]);
  const view = renderPage(<SupportAiPage denied={false} mayAutoReply={mayAutoReply} />);
  return { api, view };
}

const calls = (api: ReturnType<typeof stubApi>, method: string, fragment: string) =>
  api.calls.filter((call) => call.method === method && call.url.includes(fragment));

const providerBlock = async (provider: string) => {
  const list = await screen.findByRole('list', { name: t('web.sai_credentials') });
  const item = list.querySelector(`[data-provider="${provider}"]`);
  if (item === null) throw new Error(`no block for ${provider}`);
  return within(item as HTMLElement);
};

describe('the support AI settings page', () => {
  it('saves the configuration against the version it was built from, with a key', async () => {
    const { api } = settings();
    const tone = await screen.findByLabelText(t('web.sai_tone'));
    fireEvent.change(tone, { target: { value: 'مؤدب و کوتاه' } });
    fireEvent.click(screen.getByRole('button', { name: t('web.sai_save') }));
    await waitFor(() => expect(calls(api, 'PUT', '/support-ai/config')).toHaveLength(1));
    const body = calls(api, 'PUT', '/support-ai/config')[0]!.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['config', 'expectedVersion', 'idempotencyKey']);
    expect(body.expectedVersion).toBe(3);
    expect((body.idempotencyKey as string).length).toBeGreaterThanOrEqual(8);
    expect(body.config).toMatchObject({
      mode: 'ASSIST_ONLY',
      primary: { provider: 'OPENAI', model: 'gpt-test-1' },
      toneInstructions: 'مؤدب و کوتاه',
      settleDelaySeconds: 6,
    });
  });

  it('refuses to send an invalid configuration and says why', async () => {
    const { api } = settings();
    const settle = await screen.findByLabelText(t('web.sai_settle_delay_seconds'));
    fireEvent.change(settle, { target: { value: '2' } });
    expect(screen.getByText(t('web.sai_invalid_bounds'))).toBeTruthy();
    const save = screen.getByRole('button', { name: t('web.sai_save') }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(calls(api, 'PUT', '/support-ai/config')).toHaveLength(0);
  });

  it('shows the server’s refusal to enter automatic replies, by name', async () => {
    const { api } = settings([
      {
        url: '/support-ai/config',
        method: 'PUT',
        status: 403,
        body: denial('support_ai.auto_reply'),
      },
    ]);
    const auto = await screen.findByRole('radio', {
      name: new RegExp(t('web.sai_mode_auto_reply_safe')),
    });
    fireEvent.click(auto);
    // The UI does not hide the option: the server decides, and the page warns first.
    expect(screen.getByText(t('web.sai_mode_auto_needs_owner'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('web.sai_save') }));
    await waitFor(() => expect(calls(api, 'PUT', '/support-ai/config')).toHaveLength(1));
    const body = calls(api, 'PUT', '/support-ai/config')[0]!.body as {
      config: { mode: string };
    };
    expect(body.config.mode).toBe('AUTO_REPLY_SAFE');
    const alert = await screen.findByText(t('web.sai_fault_auto_reply'));
    expect(alert).toBeTruthy();
    // Not the generic sentence: the operator holds `configure`, the page loaded.
    expect(screen.queryByText(t('web.no_permission'))).toBeNull();
  });

  it('maps the auto-reply denial, and only that denial, to its own sentence', () => {
    const refusal = (permission: string) =>
      new ApiError(403, 'platform.permission_denied', 'x', { permission });
    expect(supportAiFault(refusal('support_ai.auto_reply'))).toBe(t('web.sai_fault_auto_reply'));
    expect(supportAiFault(refusal('support_ai.configure'))).toBe(t('web.no_permission'));
    expect(supportAiFault(new ApiError(409, 'support_ai.version_conflict', 'x'))).toBe(
      t('web.sai_fault_conflict'),
    );
  });

  it('shows each key only as a state and a set-at time — never a value, never a mask', async () => {
    const { view } = settings();
    const openai = await providerBlock('OPENAI');
    expect(openai.getByText(t('web.sai_key_configured'))).toBeTruthy();
    expect(openai.getByText(t('web.sai_key_set_at'))).toBeTruthy();
    const anthropic = await providerBlock('ANTHROPIC');
    expect(anthropic.getByText(t('web.sai_key_missing'))).toBeTruthy();
    // No masked stand-in anywhere on the page, and no value-bearing input until asked.
    expect(view.container.textContent).not.toMatch(/\*{3,}|•{3,}/u);
    expect(view.container.querySelectorAll('input[type="password"]')).toHaveLength(0);
  });

  it('sets a key through a password field, clears it, and never renders it', async () => {
    const { api, view } = settings();
    const openai = await providerBlock('OPENAI');
    fireEvent.click(openai.getByRole('button', { name: t('web.sai_key_replace') }));
    const field = openai.getByLabelText(new RegExp(t('web.sai_key_input'))) as HTMLInputElement;
    expect(field.type).toBe('password');
    expect(field.autocomplete).toBe('new-password');
    // Only Z.AI has a region.
    expect(openai.queryByLabelText(t('web.sai_region'))).toBeNull();
    fireEvent.change(field, { target: { value: `  ${SECRET} ` } });
    fireEvent.click(openai.getByRole('button', { name: t('web.sai_key_save') }));
    await waitFor(() => expect(calls(api, 'PUT', '/credentials/OPENAI')).toHaveLength(1));
    const body = calls(api, 'PUT', '/credentials/OPENAI')[0]!.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['apiKey', 'idempotencyKey']);
    expect(body.apiKey).toBe(SECRET);
    // Gone from the form, and nowhere in the document — text or attribute.
    await waitFor(() => expect(view.container.querySelector('input[type="password"]')).toBeNull());
    expect(view.container.innerHTML).not.toContain(SECRET);
    expect(view.container.innerHTML).not.toContain(SECRET.slice(-6));
  });

  it('offers a region only for Z.AI, and sends the one chosen', async () => {
    const { api } = settings();
    const zai = await providerBlock('ZAI');
    expect(zai.getByText(t('web.sai_region_china'))).toBeTruthy();
    fireEvent.click(zai.getByRole('button', { name: t('web.sai_key_replace') }));
    const region = zai.getByLabelText(t('web.sai_region')) as HTMLSelectElement;
    fireEvent.change(region, { target: { value: 'INTERNATIONAL' } });
    fireEvent.change(zai.getByLabelText(new RegExp(t('web.sai_key_input'))), {
      target: { value: SECRET },
    });
    fireEvent.click(zai.getByRole('button', { name: t('web.sai_key_save') }));
    await waitFor(() => expect(calls(api, 'PUT', '/credentials/ZAI')).toHaveLength(1));
    expect(calls(api, 'PUT', '/credentials/ZAI')[0]!.body).toMatchObject({
      region: 'INTERNATIONAL',
    });
    const anthropic = await providerBlock('ANTHROPIC');
    fireEvent.click(anthropic.getByRole('button', { name: t('web.sai_key_add') }));
    expect(anthropic.queryByLabelText(t('web.sai_region'))).toBeNull();
  });

  it('deletes a key only after confirmation, with its idempotency key in the query', async () => {
    const { api } = settings();
    const openai = await providerBlock('OPENAI');
    fireEvent.click(openai.getByRole('button', { name: t('web.sai_key_delete') }));
    const dialog = await screen.findByRole('alertdialog');
    expect(calls(api, 'DELETE', '/credentials/')).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: t('web.sai_key_delete') }));
    await waitFor(() => expect(calls(api, 'DELETE', '/credentials/OPENAI')).toHaveLength(1));
    const url = new URL(calls(api, 'DELETE', '/credentials/OPENAI')[0]!.url, 'http://x');
    expect((url.searchParams.get('idempotencyKey') ?? '').length).toBeGreaterThanOrEqual(8);
  });

  it('tests a connection against the chain’s model and shows the outcome', async () => {
    const { api } = settings();
    const openai = await providerBlock('OPENAI');
    const model = openai.getByLabelText(new RegExp(t('web.sai_test_model'))) as HTMLInputElement;
    expect(model.value).toBe('gpt-test-1');
    fireEvent.click(openai.getByRole('button', { name: t('web.sai_test') }));
    await waitFor(() => expect(calls(api, 'POST', '/credentials/OPENAI/test')).toHaveLength(1));
    expect(calls(api, 'POST', '/credentials/OPENAI/test')[0]!.body).toEqual({
      model: 'gpt-test-1',
      idempotencyKey: expect.stringMatching(/^.{8,}$/u),
    });
    expect(await openai.findByText(new RegExp(t('web.sai_test_result')))).toBeTruthy();
    // Program §11: every check, by name, with its own result — never one generic «OK».
    const checks = openai.getByRole('list', { name: t('web.sai_test_check') });
    expect(within(checks).getByText(new RegExp(t('web.sai_test_check_model_access')))).toBeTruthy();
    const generation = checks.querySelector('[data-check="STRUCTURED_GENERATION"]')!;
    expect(generation.getAttribute('data-result')).toBe('FAIL');
    expect(generation.textContent).toContain(t('web.sai_failure_unsupported_capability'));
    expect(generation.textContent).toContain('response_format');
    expect(generation.textContent).toContain('400');
    expect(checks.querySelector('[data-check="MODEL_ACCESS"]')!.textContent).toContain(
      t('web.sai_test_result_pass'),
    );
    expect(checks.querySelector('[data-check="DECISION_SCHEMA"]')!.textContent).toContain(
      t('web.sai_test_result_not_tested'),
    );
    // No test for a provider with no key.
    const anthropic = await providerBlock('ANTHROPIC');
    expect(anthropic.queryByRole('button', { name: t('web.sai_test') })).toBeNull();
  });

  it('summarises usage', async () => {
    settings();
    const table = await screen.findByRole('table', { name: t('web.sai_usage') });
    expect(within(table).getByText(t('web.sai_operation_assist_draft'))).toBeTruthy();
    expect(within(table).getByText('gpt-test-1')).toBeTruthy();
  });

  it('says «no permission» and asks nothing without the configure key', () => {
    const api = stubApi([]);
    renderPage(<SupportAiPage denied mayAutoReply={false} />);
    expect(screen.getByText(t('web.no_permission'))).toBeTruthy();
    expect(api.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------

const draft = (overrides: Record<string, unknown> = {}) => ({
  id: DRAFT_ID,
  state: 'READY',
  createdAt: '2026-10-01T10:10:00.000Z',
  readyAt: '2026-10-01T10:10:05.000Z',
  failureCode: null,
  decision: 'REPLY',
  topic: 'CONNECTION_TROUBLESHOOTING',
  confidence: 'HIGH',
  summary: 'مشتری نمی‌تواند وصل شود.',
  intent: 'رفع مشکل اتصال',
  suggestedReply: 'لطفاً برنامه را به‌روزرسانی کنید.',
  ticketAction: 'NONE',
  factLabels: ['سرویس فعال', 'حجم باقی‌مانده'],
  provider: 'OPENAI',
  model: 'gpt-test-1',
  imagesSeen: 0,
  imagesUnseen: 0,
  unseenImageHandoff: null,
  failure: null,
  replyOverLimit: false,
  ...overrides,
});

function assist(drafts: unknown[], mayReply = true, extra: Routes = []) {
  const api = stubApi([
    ...extra,
    { url: `/business-chats/${CHAT_ID}/drafts`, method: 'GET', body: { drafts } },
    {
      url: `/business-chats/${CHAT_ID}/drafts`,
      method: 'POST',
      body: draft({ id: '019460ab-cdef-7012-8345-6789abcdef09', state: 'QUEUED' }),
    },
    { url: '/send', method: 'POST', body: { outboundId: '019430ab-cdef-7012-8345-6789abcdef09' } },
    { url: '/discard', method: 'POST', body: { discarded: true } },
  ]);
  renderPage(<AssistCard conversationId={CHAT_ID} mayReply={mayReply} connected />);
  return api;
}

describe('the Assist panel', () => {
  it('says nothing is sent until the operator presses send', async () => {
    assist([draft()]);
    expect(await screen.findByText(t('web.assist_nothing_sent'))).toBeTruthy();
  });

  it('requests a draft with a fresh idempotency key per click', async () => {
    const api = assist([draft()]);
    const button = await screen.findByRole('button', { name: t('web.assist_request') });
    fireEvent.click(button);
    await waitFor(() => expect(calls(api, 'POST', '/drafts')).toHaveLength(1));
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(calls(api, 'POST', '/drafts')).toHaveLength(2));
    const keys = calls(api, 'POST', '/drafts').map(
      (call) => (call.body as { idempotencyKey: string }).idempotencyKey,
    );
    expect(Object.keys(calls(api, 'POST', '/drafts')[0]!.body as object)).toEqual([
      'idempotencyKey',
    ]);
    expect(keys[0]!.length).toBeGreaterThanOrEqual(8);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('shows the draft’s topic, confidence, summary, intent and what it was based on', async () => {
    assist([draft()]);
    const list = await screen.findByRole('list', { name: t('web.assist_drafts') });
    expect(within(list).getByText(t('web.assist_state_ready'))).toBeTruthy();
    expect(within(list).getByText(t('web.assist_topic_connection_troubleshooting'))).toBeTruthy();
    expect(within(list).getByText(t('web.assist_confidence_high'))).toBeTruthy();
    expect(within(list).getByText('مشتری نمی‌تواند وصل شود.')).toBeTruthy();
    expect(within(list).getByText('رفع مشکل اتصال')).toBeTruthy();
    const basedOn = within(list).getByRole('list', { name: t('web.assist_based_on') });
    expect(within(basedOn).getByText('سرویس فعال')).toBeTruthy();
    expect(within(basedOn).getByText('حجم باقی‌مانده')).toBeTruthy();
  });

  it('sends the operator’s EDITED text, not the suggestion', async () => {
    const api = assist([draft()]);
    const box = (await screen.findByLabelText(t('web.assist_reply_label'))) as HTMLTextAreaElement;
    expect(box.value).toBe('لطفاً برنامه را به‌روزرسانی کنید.');
    expect(calls(api, 'POST', '/send')).toHaveLength(0);
    fireEvent.change(box, { target: { value: '  سلام، لطفاً برنامه را دوباره نصب کنید. ' } });
    fireEvent.click(screen.getByRole('button', { name: t('web.assist_send') }));
    await waitFor(() =>
      expect(calls(api, 'POST', `/support-ai/drafts/${DRAFT_ID}/send`)).toHaveLength(1),
    );
    const body = calls(api, 'POST', '/send')[0]!.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['idempotencyKey', 'text']);
    expect(body.text).toBe('سلام، لطفاً برنامه را دوباره نصب کنید.');
    expect((body.idempotencyKey as string).length).toBeGreaterThanOrEqual(8);
    expect(calls(api, 'POST', '/discard')).toHaveLength(0);
  });

  it('discards through its own route and sends nothing', async () => {
    const api = assist([draft()]);
    fireEvent.click(await screen.findByRole('button', { name: t('web.assist_discard') }));
    await waitFor(() =>
      expect(calls(api, 'POST', `/support-ai/drafts/${DRAFT_ID}/discard`)).toHaveLength(1),
    );
    expect(calls(api, 'POST', '/send')).toHaveLength(0);
  });

  it('draws no send button without the reply key, and says why', async () => {
    assist([draft()], false);
    await screen.findByLabelText(t('web.assist_reply_label'));
    expect(screen.queryByRole('button', { name: t('web.assist_send') })).toBeNull();
    expect(screen.getByText(t('web.assist_send_needs_reply'))).toBeTruthy();
  });

  it('shows a failed draft neutrally, and sent and discarded drafts read-only', async () => {
    assist([
      draft({
        id: '019460ab-cdef-7012-8345-6789abcdef02',
        state: 'FAILED',
        failureCode: 'support_ai.no_usable_provider',
        failure: diagnostic({ failureClass: 'no_provider' }),
        decision: null,
        topic: null,
        confidence: null,
        summary: null,
        intent: null,
        suggestedReply: null,
        factLabels: [],
      }),
      draft({ id: '019460ab-cdef-7012-8345-6789abcdef03', state: 'SENT' }),
      draft({ id: '019460ab-cdef-7012-8345-6789abcdef04', state: 'DISCARDED' }),
    ]);
    const list = await screen.findByRole('list', { name: t('web.assist_drafts') });
    expect(within(list).getByText(t('web.assist_failed'))).toBeTruthy();
    // The internal code is not shown; the reason is, in words (program §12).
    expect(list.textContent).not.toContain('support_ai.no_usable_provider');
    expect(list.textContent).toContain(t('web.sai_failure_no_provider'));
    expect(within(list).getByText(t('web.assist_state_sent'))).toBeTruthy();
    expect(within(list).getByText(t('web.assist_state_discarded'))).toBeTruthy();
    // Nothing editable and nothing to send for a draft that is not READY.
    expect(screen.queryByLabelText(t('web.assist_reply_label'))).toBeNull();
    expect(screen.queryByRole('button', { name: t('web.assist_send') })).toBeNull();
  });

  it('says the AI is off when the server refuses a request for that reason', async () => {
    assist([], true, [
      {
        url: `/business-chats/${CHAT_ID}/drafts`,
        method: 'POST',
        status: 409,
        body: {
          error: { kind: 'CONFLICT', code: 'support_ai.off', message: 'x', correlationId: 'c' },
        },
      },
    ]);
    fireEvent.click(await screen.findByRole('button', { name: t('web.assist_request') }));
    expect(await screen.findByText(t('web.assist_fault_off'))).toBeTruthy();
  });

  it('reads the drafts again while one is still being written', async () => {
    const api = assist([
      draft({ state: 'QUEUED', suggestedReply: null, createdAt: new Date().toISOString() }),
    ]);
    expect(await screen.findByText(t('web.assist_queued'))).toBeTruthy();
    // The request button waits for the queued draft.
    expect(
      (screen.getByRole('button', { name: t('web.assist_request') }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await waitFor(() => expect(calls(api, 'GET', '/drafts').length).toBeGreaterThan(1), {
      timeout: ASSIST_POLL_MS * 2,
    });
  });
});

describe('the Assist panel says why the AI produced no draft (program §12)', () => {
  it('shows the class and the deciding call’s safe particulars, never a prompt or reply', async () => {
    assist([
      draft({
        state: 'FAILED',
        failureCode: 'chain.openai.http_400',
        failure: diagnostic({
          failureClass: 'unsupported_capability',
          operation: 'ASSIST_DRAFT',
          provider: 'OPENAI',
          model: 'gpt-test-1',
          attemptIndex: 0,
          outcome: 'INVALID_OUTPUT',
          httpStatus: 400,
          providerErrorType: 'invalid_request_error',
          providerErrorParam: 'response_format',
          latencyMs: 812,
          at: '2026-10-01T10:10:05.000Z',
        }),
        decision: null,
        topic: null,
        confidence: null,
        summary: null,
        intent: null,
        suggestedReply: null,
        factLabels: [],
      }),
    ]);
    const list = await screen.findByRole('list', { name: t('web.assist_drafts') });
    const failure = list.querySelector('[data-failure-class]')!;
    expect(failure.getAttribute('data-failure-class')).toBe('unsupported_capability');
    expect(failure.textContent).toContain(t('web.sai_failure_unsupported_capability'));
    expect(failure.textContent).toContain('response_format');
    expect(failure.textContent).toContain('invalid_request_error');
    expect(list.textContent).not.toContain('chain.openai.http_400');
  });

  it('names the decision field that failed NEXA’s schema', async () => {
    assist([
      draft({
        state: 'FAILED',
        failureCode: 'decision.invalid',
        failure: diagnostic({
          failureClass: 'schema_invalid',
          issuePath: 'factRefs.0',
          issueCode: 'invalid_format',
        }),
        suggestedReply: null,
      }),
    ]);
    const list = await screen.findByRole('list', { name: t('web.assist_drafts') });
    expect(list.textContent).toContain(t('web.sai_failure_schema_invalid'));
    expect(list.textContent).toContain('factRefs.0 (invalid_format)');
  });

  // Agent audit D10: an over-long Assist draft is shown, with a warning, not thrown away.
  it('shows an over-long draft with a warning, still editable', async () => {
    assist([draft({ replyOverLimit: true })]);
    expect(await screen.findByText(t('web.assist_reply_over_limit'))).toBeTruthy();
    expect(screen.getByLabelText(t('web.assist_reply_label'))).toBeTruthy();
  });

  it('shows what images the model saw, and the fail-closed image handoff', async () => {
    assist([
      draft({
        imagesSeen: 1,
        imagesUnseen: 2,
        decision: 'HANDOFF',
        unseenImageHandoff: 'TOO_LARGE',
      }),
    ]);
    expect(await screen.findByText(t('web.assist_unseen_image_handoff'))).toBeTruthy();
    expect(screen.getByText(t('web.assist_images'))).toBeTruthy();
  });
});

// PR #200 review, finding 6: the server fails a draft nothing claimed; the screen's wait is
// bounded by the same number, so it neither polls for ever nor keeps re-request disabled.
describe('the Assist panel and a draft nothing claims', () => {
  it('waits on a QUEUED draft only for the server’s bound plus two polls', () => {
    const createdAt = '2026-10-05T00:00:00.000Z';
    const queuedAt = Date.parse(createdAt);
    const queued = draft({ state: 'QUEUED', createdAt }) as never;
    expect(ASSIST_WAIT_MS).toBe(SUPPORT_AI_DRAFT_UNCLAIMED_SECONDS * 1_000 + 2 * ASSIST_POLL_MS);
    expect(awaitingDraft(queued, queuedAt + ASSIST_WAIT_MS - 1)).toBe(true);
    expect(awaitingDraft(queued, queuedAt + ASSIST_WAIT_MS)).toBe(false);
    expect(awaitingDraft(draft({ createdAt }) as never, queuedAt)).toBe(false);
  });

  it('stops polling an overdue QUEUED draft and offers a new request', async () => {
    const overdue = new Date(Date.now() - ASSIST_WAIT_MS - 1_000).toISOString();
    const api = assist([draft({ state: 'QUEUED', suggestedReply: null, createdAt: overdue })]);
    expect(await screen.findByText(t('web.assist_queued_overdue'))).toBeTruthy();
    const button = screen.getByRole('button', { name: t('web.assist_request') });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, ASSIST_POLL_MS * 2));
    expect(calls(api, 'GET', '/drafts')).toHaveLength(1);
  });

  it('shows the server’s unclaimed verdict as an ordinary failed draft', async () => {
    assist([draft({ state: 'FAILED', failureCode: 'job.unclaimed', suggestedReply: null })]);
    expect(await screen.findByText(t('web.assist_failed'))).toBeTruthy();
    expect(screen.queryByText('job.unclaimed')).toBeNull();
    // Agent audit D4: «the assistant is not running» is told apart from a provider failure.
    expect(screen.getByText(t('web.assist_failed_unclaimed'))).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: t('web.assist_request') }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------

describe('Assist on the conversation page, the route and the navigation', () => {
  const detail = {
    conversation: {
      id: CHAT_ID,
      state: 'HUMAN_ACTIVE',
      takeoverReason: 'OPERATOR_TAKEOVER',
      handoffReason: null,
      peerTelegramUserId: '951001',
      customer: null,
      connectionStatus: 'ACTIVE',
      lastMessageAt: null,
      lastInboundAt: null,
      preview: null,
      unansweredSince: null,
      controlEpoch: 1,
      lastHumanAt: null,
      ticketId: null,
    },
    messages: [],
    outbound: [],
    escalations: [],
  };

  it('draws the Assist panel only with the assist key', async () => {
    const api = stubApi([
      { url: `/business-chats/${CHAT_ID}`, body: detail },
      { url: `/business-chats/${CHAT_ID}/drafts`, body: { drafts: [] } },
    ]);
    const view = renderPage(
      <BusinessChatDetailPage id={CHAT_ID} denied={false} mayReply mayAssist={false} />,
    );
    await screen.findByText(t('web.bchat_transcript'));
    expect(screen.queryByText(t('web.assist_title'))).toBeNull();
    expect(calls(api, 'GET', '/drafts')).toHaveLength(0);
    view.rerender(<BusinessChatDetailPage id={CHAT_ID} denied={false} mayReply mayAssist />);
    expect(await screen.findByText(t('web.assist_title'))).toBeTruthy();
  });

  it('serves /support-ai on support_ai.configure and passes the auto-reply key through', () => {
    const at = (permissions: readonly (typeof PERMISSION_KEYS)[number][]) =>
      resolve({ path: '/support-ai', query: new URLSearchParams() }, permissions).element as {
        props: { denied: boolean; mayAutoReply: boolean };
      };
    expect(at([]).props).toMatchObject({ denied: true, mayAutoReply: false });
    expect(at(['support_ai.configure']).props).toMatchObject({
      denied: false,
      mayAutoReply: false,
    });
    expect(at(['support_ai.configure', 'support_ai.auto_reply']).props).toMatchObject({
      denied: false,
      mayAutoReply: true,
    });
    const entry = NAV.find((item) => item.id === 'support-ai')!;
    expect(entry.path).toBe('/support-ai');
    expect(navPermitted(entry, ['support_ai.configure'], [])).toBe(true);
    expect(navPermitted(entry, ['support_ai.assist'], [])).toBe(false);
  });

  it('passes the assist key through to the conversation page', () => {
    const at = (permissions: readonly (typeof PERMISSION_KEYS)[number][]) =>
      resolve({ path: `/business-chats/${CHAT_ID}`, query: new URLSearchParams() }, permissions)
        .element as { props: { mayAssist: boolean } };
    expect(at(['business_chats.view']).props.mayAssist).toBe(false);
    expect(at(['business_chats.view', 'support_ai.assist']).props.mayAssist).toBe(true);
  });
});
