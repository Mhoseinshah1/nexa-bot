import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { START_CAPTCHA_KINDS } from '@nexa/contracts';
import { MINIAPP_FA } from '../../apps/miniapp/src/i18n/miniapp.fa';
import { MiniAppApi } from '../../apps/miniapp/src/api';
import { Gate } from '../../apps/miniapp/src/screens/gate';
import {
  CAPTCHA_PREVIEW_IMAGE_PATH,
  CaptchaKindPreview,
} from '../../apps/web/src/pages/captcha-kind-preview';
import { SETTING_PRESENTATION } from '../../apps/web/src/settings-presentation';
import { WEB_FA, t } from '../../apps/web/src/i18n/web.fa';

/**
 * `captcha.kind` in the two UIs: the Web Admin's select and preview of each kind, and the mini
 * app's gate with the picture, the digit input and «🔄 تصویر جدید».
 */

const state = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock('../../apps/miniapp/src/app', () => ({ useApp: () => state.ctx }));

const BOT = '01900000-0000-7000-8000-00000000a001';
const fa = (key: keyof typeof MINIAPP_FA) => MINIAPP_FA[key];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('the Web Admin card', () => {
  it('is a select with the five Persian labels, in the registry order', () => {
    const control = SETTING_PRESENTATION['captcha.kind'].control;
    expect(control.kind).toBe('select');
    if (control.kind !== 'select') return;
    expect(control.options.map((option) => option.value)).toEqual([...START_CAPTCHA_KINDS]);
    expect(control.options.map((option) => t(option.label))).toEqual([
      'ریاضی',
      'عدد در تصویر',
      'ایموجی',
      'عدد حروفی',
      'تصادفی',
    ]);
  });

  it('previews each kind, marks the chosen one, and draws a fresh sample picture on request', () => {
    render(<CaptchaKindPreview selected="EMOJI" />);
    for (const label of ['ریاضی', 'عدد در تصویر', 'ایموجی', 'عدد حروفی', 'تصادفی']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    const cards = [...document.querySelectorAll('.captcha-preview-card')];
    expect(cards).toHaveLength(5);
    expect(cards.map((card) => card.getAttribute('data-selected'))).toEqual([
      'false',
      'false',
      'true',
      'false',
      'false',
    ]);

    // The picture comes from the admin endpoint, never from data in the page.
    const image = screen.getByAltText(WEB_FA['web.captcha_preview_image_alt']) as HTMLImageElement;
    const first = image.getAttribute('src');
    expect(first).toContain(CAPTCHA_PREVIEW_IMAGE_PATH);
    fireEvent.click(screen.getByRole('button', { name: WEB_FA['web.captcha_preview_new_sample'] }));
    const next = (
      screen.getByAltText(WEB_FA['web.captcha_preview_image_alt']) as HTMLImageElement
    ).getAttribute('src');
    expect(next).toContain(CAPTCHA_PREVIEW_IMAGE_PATH);
    expect(next).not.toBe(first);
  });
});

function mount(
  question: {
    kind: 'IMAGE_NUMBER';
    state: 'CURRENT' | 'EXPIRED' | 'LOCKED';
    refreshesLeft: number;
  },
  answer: 'PASSED' | 'WRONG' = 'PASSED',
) {
  const calls: { path: string; method: string; body: string | null }[] = [];
  const created = vi.fn(() => 'blob:picture');
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = created;
  (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.replace('/miniapp/api/v1', '').split('?')[0] ?? '';
      calls.push({
        path,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : null,
      });
      if (path === '/captcha/image') {
        return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      }
      const me = {
        customer: { firstName: 'زهرا', username: null },
        botLink: 'https://t.me/nexa_bot',
        gate: answer === 'PASSED' ? null : { kind: 'CAPTCHA', question },
        wallet: null,
        reseller: null,
        notifications: null,
      };
      return new Response(
        JSON.stringify({
          result: path === '/captcha/refresh' ? 'REFRESHED' : answer,
          remaining: answer === 'WRONG' ? 2 : null,
          minutes: null,
          me,
        }),
        { status: 200 },
      );
    }),
  );
  const refreshMe = vi.fn(async () => undefined);
  state.ctx = {
    api: new MiniAppApi(BOT),
    me: { botLink: 'https://t.me/nexa_bot' },
    refreshMe,
    navigate: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
  };
  return { calls, refreshMe };
}

describe('the mini app gate', () => {
  it('fetches the picture with the session, takes the digits and lets the server decide', async () => {
    const stub = mount({ kind: 'IMAGE_NUMBER', state: 'CURRENT', refreshesLeft: 3 });
    render(
      <Gate
        gate={{
          kind: 'CAPTCHA',
          question: { kind: 'IMAGE_NUMBER', state: 'CURRENT', refreshesLeft: 3 },
        }}
      />,
    );
    await waitFor(() => expect(screen.getByAltText(fa('miniapp.gate_captcha_alt'))).toBeTruthy());
    expect(stub.calls[0]).toMatchObject({ path: '/captcha/image', method: 'GET' });

    fireEvent.change(screen.getByLabelText(fa('miniapp.gate_captcha_input')), {
      target: { value: '۱۲۳۴' },
    });
    fireEvent.click(screen.getByRole('button', { name: fa('miniapp.gate_captcha_submit') }));
    await waitFor(() => expect(stub.refreshMe).toHaveBeenCalled());
    const posted = stub.calls.find((call) => call.path === '/captcha/answer');
    expect(posted).toMatchObject({ method: 'POST' });
    // The digits go as typed: normalising and judging are the server's.
    expect(JSON.parse(posted?.body ?? '{}')).toEqual({ text: '۱۲۳۴' });
  });

  it('shows the remaining attempts after a wrong answer', async () => {
    mount({ kind: 'IMAGE_NUMBER', state: 'CURRENT', refreshesLeft: 3 }, 'WRONG');
    render(
      <Gate
        gate={{
          kind: 'CAPTCHA',
          question: { kind: 'IMAGE_NUMBER', state: 'CURRENT', refreshesLeft: 3 },
        }}
      />,
    );
    fireEvent.change(screen.getByLabelText(fa('miniapp.gate_captcha_input')), {
      target: { value: '1111' },
    });
    fireEvent.click(screen.getByRole('button', { name: fa('miniapp.gate_captcha_submit') }));
    await waitFor(() =>
      expect(
        screen.getByText(fa('miniapp.gate_captcha_wrong').replace('{remaining}', '2')),
      ).toBeTruthy(),
    );
  });

  it('asks for a new picture with the refresh button, which goes when no swap is left', async () => {
    const stub = mount({ kind: 'IMAGE_NUMBER', state: 'CURRENT', refreshesLeft: 1 });
    const { rerender } = render(
      <Gate
        gate={{
          kind: 'CAPTCHA',
          question: { kind: 'IMAGE_NUMBER', state: 'CURRENT', refreshesLeft: 1 },
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: fa('miniapp.gate_captcha_refresh') }));
    await waitFor(() =>
      expect(stub.calls.some((call) => call.path === '/captcha/refresh')).toBe(true),
    );
    rerender(
      <Gate
        gate={{
          kind: 'CAPTCHA',
          question: { kind: 'IMAGE_NUMBER', state: 'CURRENT', refreshesLeft: 0 },
        }}
      />,
    );
    expect(screen.queryByRole('button', { name: fa('miniapp.gate_captcha_refresh') })).toBeNull();
  });

  it('renews an expired question itself, and only reports a cooldown', async () => {
    const stub = mount({ kind: 'IMAGE_NUMBER', state: 'EXPIRED', refreshesLeft: 3 });
    render(
      <Gate
        gate={{
          kind: 'CAPTCHA',
          question: { kind: 'IMAGE_NUMBER', state: 'EXPIRED', refreshesLeft: 3 },
        }}
      />,
    );
    await waitFor(() =>
      expect(stub.calls.some((call) => call.path === '/captcha/refresh')).toBe(true),
    );
    cleanup();

    mount({ kind: 'IMAGE_NUMBER', state: 'LOCKED', refreshesLeft: 0 });
    render(
      <Gate
        gate={{
          kind: 'CAPTCHA',
          question: { kind: 'IMAGE_NUMBER', state: 'LOCKED', refreshesLeft: 0 },
        }}
      />,
    );
    expect(screen.getByText(fa('miniapp.gate_captcha_locked'))).toBeTruthy();
  });

  it('lets the person resume after a cooldown, by asking the server again', async () => {
    const stub = mount({ kind: 'IMAGE_NUMBER', state: 'LOCKED', refreshesLeft: 0 });
    render(
      <Gate
        gate={{
          kind: 'CAPTCHA',
          question: { kind: 'IMAGE_NUMBER', state: 'LOCKED', refreshesLeft: 0 },
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: fa('miniapp.retry') }));
    await waitFor(() => expect(stub.refreshMe).toHaveBeenCalled());
    expect(stub.calls.some((call) => call.path === '/captcha/refresh')).toBe(true);
  });

  it('leaves every other kind to the chat, as before', () => {
    mount({ kind: 'IMAGE_NUMBER', state: 'CURRENT', refreshesLeft: 3 });
    render(<Gate gate={{ kind: 'CAPTCHA' }} />);
    expect(screen.getByText(fa('miniapp.gate_captcha'))).toBeTruthy();
    expect(screen.queryByLabelText(fa('miniapp.gate_captcha_input'))).toBeNull();
  });
});
