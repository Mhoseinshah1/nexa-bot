import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MINIAPP_ROUTES, miniAppMeResponseSchema } from '@nexa/contracts';
import { ApiError, MiniAppApi, botIdFromLocation } from '../../apps/miniapp/src/api';
import { errorText } from '../../apps/miniapp/src/ui';
import { MINIAPP_FA } from '../../apps/miniapp/src/i18n/miniapp.fa';
import { ServiceCard } from '../../apps/miniapp/src/screens/service-card';

/**
 * Round 9, C5: the customer mini app (`apps/miniapp`), rendered and read.
 *
 * The API client is the one place a session token, an idempotency key and a contract
 * schema meet the network, so it is exercised against a stubbed `fetch`; the source is
 * scanned for the three things its CSP and its rules forbid (an inline style, an injected
 * HTML string, a third-party font) and for design placeholders shipped as copy.
 */

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '../..');
const BOT = '01900000-0000-7000-8000-00000000a001';

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(tsx?|css|html)$/u.test(path)) out.push(path);
  }
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('the mini app source', () => {
  const files = [
    ...sources(join(REPO_ROOT, 'apps/miniapp/src')),
    join(REPO_ROOT, 'apps/miniapp/index.html'),
  ];

  it('has no inline style, no injected HTML and no third-party font (its CSP allows none)', () => {
    const offenders = files.filter((file) => {
      const text = readFileSync(file, 'utf8');
      return /\bstyle=\{|style="|dangerouslySetInnerHTML|fonts\.googleapis/u.test(text);
    });
    expect(offenders).toEqual([]);
  });

  it('ships no bracketed design placeholder as copy', () => {
    const catalogue = Object.values(MINIAPP_FA).join('\n');
    expect(catalogue).not.toMatch(/\[[^\]]*\]/u);
  });
});

describe('the mini app API client', () => {
  it('reads the bot from the document path, and nothing else', () => {
    expect(botIdFromLocation(`/miniapp/${BOT}/`)).toBe(BOT);
    expect(botIdFromLocation(`/miniapp/${BOT}`)).toBe(BOT);
    expect(botIdFromLocation('/miniapp/not-a-bot/')).toBeNull();
    expect(botIdFromLocation(`/other/${BOT}/`)).toBeNull();
  });

  it('exchanges the launch once, then sends the bearer and a fresh key on every write', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const me = {
      customer: { firstName: 'سارا', username: null },
      botLink: null,
      gate: null,
      wallet: { balance: { amountMinor: '0', currency: 'IRT' } },
      reseller: null,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        calls.push({ url, init });
        const body = url.endsWith('/session')
          ? { token: `${BOT}.secret`, expiresAt: '2026-10-25T13:00:00.000Z' }
          : me;
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    const api = new MiniAppApi(BOT);
    await api.signIn('query_id=x&hash=y');
    expect(calls[0]?.url).toBe(`/miniapp/api/v1/bots/${BOT}/session`);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ initData: 'query_id=x&hash=y' });

    await api.get(MINIAPP_ROUTES.me, {}, miniAppMeResponseSchema);
    const read = calls[1]?.init.headers as Record<string, string>;
    expect(read['authorization']).toBe(`Bearer ${BOT}.secret`);
    expect(read['idempotency-key'], 'a read carries no key').toBeUndefined();

    await api.post(MINIAPP_ROUTES.gateCheck, {}, miniAppMeResponseSchema);
    await api.post(MINIAPP_ROUTES.gateCheck, {}, miniAppMeResponseSchema);
    const first = (calls[2]?.init.headers as Record<string, string>)['idempotency-key'];
    const second = (calls[3]?.init.headers as Record<string, string>)['idempotency-key'];
    expect(first).toMatch(/^[0-9a-f-]{36}$/u);
    expect(second, 'each write is its own key').not.toBe(first);
  });

  it('forgets a session the server says is invalid, and surfaces the code', async () => {
    sessionStorage.setItem(`nexa.miniapp.session.${BOT}`, `${BOT}.old`);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { kind: 'UNAUTHENTICATED', code: 'miniapp.session_invalid' } }),
            { status: 401 },
          ),
      ),
    );
    const api = new MiniAppApi(BOT);
    expect(api.hasSession()).toBe(true);
    await expect(api.get(MINIAPP_ROUTES.me, {}, miniAppMeResponseSchema)).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(api.hasSession()).toBe(false);
    expect(sessionStorage.getItem(`nexa.miniapp.session.${BOT}`)).toBeNull();
  });

  it("says the receipt refusal's reason in the customer's words", () => {
    expect(errorText(new ApiError(400, 'miniapp.receipt_refused', { reason: 'TOO_LARGE' }))).toBe(
      MINIAPP_FA['miniapp.card_receipt_refused_TOO_LARGE'],
    );
    expect(errorText(new ApiError(500, 'internal.unhandled', {}))).toBe(
      MINIAPP_FA['miniapp.error'],
    );
  });
});

describe('the service card', () => {
  const service = {
    id: '01900000-0000-7000-8000-000000000001',
    code: 'S1',
    title: 'پلن پایه',
    state: 'ACTIVE' as const,
    username: 'nx1',
    trafficUsedBytes: String(48n * 1024n ** 3n),
    trafficLimitBytes: String(50n * 1024n ** 3n),
    expiresAt: '2026-11-20T00:00:00.000Z',
    usageSyncedAt: null,
    deviceLimit: 3,
    locationLabel: 'آلمان',
    isTrial: false,
  };

  it('draws the stored figures, «رو به پایان» from them, and the device LIMIT only', () => {
    render(<ServiceCard service={service} now={new Date('2026-10-25T00:00:00Z')} />);
    expect(screen.getByText('پلن پایه')).toBeTruthy();
    expect(screen.getByText(MINIAPP_FA['miniapp.service_ending'])).toBeTruthy();
    expect(screen.getByText(/حداکثر 3 دستگاه/u)).toBeTruthy();
    // The usage bar is an SVG attribute, never an inline style.
    const fill = document.querySelector('rect.usage-fill');
    expect(fill?.getAttribute('width')).toBe('96');
    expect(document.querySelector('[style]')).toBeNull();
  });
});
