import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMMERCE_ERROR_CODES } from '@nexa/contracts';
import { MINIAPP_FA } from '../../apps/miniapp/src/i18n/miniapp.fa';
import { ApiError, MiniAppApi } from '../../apps/miniapp/src/api';
import { withPhoneVerification, type PhoneGateDeps } from '../../apps/miniapp/src/phone';
import { Gate } from '../../apps/miniapp/src/screens/gate';

/**
 * NEXA v095 PR-4 A/C — the mini app's phone step, with a stubbed `Telegram.WebApp.requestContact`.
 *
 * `requestContact`'s `shared` is the CLIENT's word: the contact goes to the bot's chat and the
 * SERVER decides. So the gate re-reads `/me` until it lifts, and a payment a route's rule
 * refused is requested again only once `/me.phoneVerified` says so — never on the dialog's
 * answer alone. A client without the method is sent to the bot's own contact prompt.
 */

const state = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock('../../apps/miniapp/src/app', () => ({ useApp: () => state.ctx }));

const BOT = '01900000-0000-7000-8000-00000000a001';
const fa = (key: keyof typeof MINIAPP_FA) => MINIAPP_FA[key];

const meBody = (gate: { kind: 'PHONE' } | null) => ({
  customer: { firstName: 'زهرا', username: null },
  botLink: 'https://t.me/nexa_bot',
  gate,
  phoneVerified: gate === null,
  wallet: null,
  reseller: null,
  notifications: null,
});

function mount(options: { readonly requestContact: boolean; readonly gateLiftsAfter: number }) {
  let meCalls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = url.replace('/miniapp/api/v1', '').split('?')[0] ?? '';
      if (path === '/me') {
        meCalls += 1;
        return new Response(
          JSON.stringify(meBody(meCalls >= options.gateLiftsAfter ? null : { kind: 'PHONE' })),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 404 });
    }),
  );
  const requestContact = vi.fn((callback?: (shared: boolean) => void) => callback?.(true));
  const openTelegramLink = vi.fn();
  (window as unknown as { Telegram: unknown }).Telegram = {
    WebApp: {
      initData: 'query_id=x&hash=y',
      colorScheme: 'dark',
      openLink: vi.fn(),
      openTelegramLink,
      ...(options.requestContact ? { requestContact } : {}),
    },
  };
  const refreshMe = vi.fn(async () => undefined);
  state.ctx = {
    api: new MiniAppApi(BOT),
    me: meBody({ kind: 'PHONE' }),
    refreshMe,
    navigate: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
  };
  return { requestContact, openTelegramLink, refreshMe, meCalls: () => meCalls };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  delete (window as unknown as { Telegram?: unknown }).Telegram;
});

describe('A — the PHONE gate', () => {
  it('asks with requestContact() where the client has it, and waits for the SERVER to lift the gate', async () => {
    const stub = mount({ requestContact: true, gateLiftsAfter: 1 });
    render(<Gate gate={{ kind: 'PHONE' }} />);
    expect(screen.getByText(fa('miniapp.gate_phone'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: fa('miniapp.gate_phone_share') }));
    await waitFor(() => expect(stub.refreshMe).toHaveBeenCalled());
    expect(stub.requestContact).toHaveBeenCalledTimes(1);
    // The server was asked; the dialog's own answer decided nothing.
    expect(stub.meCalls()).toBeGreaterThanOrEqual(1);
    expect(stub.openTelegramLink).not.toHaveBeenCalled();
  });

  it('without requestContact(), opens the bot on its contact prompt instead', () => {
    const stub = mount({ requestContact: false, gateLiftsAfter: 1 });
    render(<Gate gate={{ kind: 'PHONE' }} />);
    expect(screen.queryByRole('button', { name: fa('miniapp.gate_phone_share') })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: fa('miniapp.gate_phone_open_bot') }));
    expect(stub.openTelegramLink).toHaveBeenCalledWith('https://t.me/nexa_bot?start=verify_phone');
  });
});

describe('C — a payment a route’s verified-phone rule refused', () => {
  const refusal = () => new ApiError(409, COMMERCE_ERROR_CODES.PHONE_VERIFICATION_REQUIRED, {});

  function deps(answers: {
    readonly asked: 'shared' | 'cancelled' | 'unsupported';
    readonly verifiedAfter: number;
  }): PhoneGateDeps & { readonly polls: () => number } {
    let polls = 0;
    return {
      requestContact: vi.fn(async () => answers.asked),
      phoneVerified: async () => {
        polls += 1;
        return polls >= answers.verifiedAfter;
      },
      wait: async () => undefined,
      polls: () => polls,
    };
  }

  it('asks for the contact, waits for the server, and requests the SAME payment again', async () => {
    let calls = 0;
    const work = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw refusal();
      return 'attempt-1';
    });
    const gate = deps({ asked: 'shared', verifiedAfter: 3 });
    const outcome = await withPhoneVerification(work, gate);
    expect(outcome).toEqual({ kind: 'DONE', value: 'attempt-1' });
    expect(work).toHaveBeenCalledTimes(2);
    // Not on the dialog's word: only once the server said the number is verified.
    expect(gate.polls()).toBe(3);
  });

  it('requests nothing again when the customer closes the dialog, or the server never verifies', async () => {
    const cancelled = vi.fn(async () => {
      throw refusal();
    });
    expect(
      (await withPhoneVerification(cancelled, deps({ asked: 'cancelled', verifiedAfter: 1 }))).kind,
    ).toBe('CANCELLED');
    expect(cancelled).toHaveBeenCalledTimes(1);

    const pending = vi.fn(async () => {
      throw refusal();
    });
    expect(
      (await withPhoneVerification(pending, deps({ asked: 'shared', verifiedAfter: 99 }))).kind,
    ).toBe('PENDING');
    expect(pending).toHaveBeenCalledTimes(1);

    const old = vi.fn(async () => {
      throw refusal();
    });
    expect(
      (await withPhoneVerification(old, deps({ asked: 'unsupported', verifiedAfter: 1 }))).kind,
    ).toBe('UNSUPPORTED');
  });

  it('passes every other refusal through untouched, and asks for nothing', async () => {
    const gate = deps({ asked: 'shared', verifiedAfter: 1 });
    await expect(
      withPhoneVerification(async () => {
        throw new ApiError(409, COMMERCE_ERROR_CODES.TOPUP_NOT_OFFERED, {});
      }, gate),
    ).rejects.toMatchObject({ code: COMMERCE_ERROR_CODES.TOPUP_NOT_OFFERED });
    expect(gate.requestContact).not.toHaveBeenCalled();
  });
});
