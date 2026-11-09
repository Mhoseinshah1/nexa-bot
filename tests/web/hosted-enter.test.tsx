import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { App } from '../../apps/web/src/app';
import { HostedEnterPage, isEnterPath } from '../../apps/web/src/pages/hosted-enter';
import { navigate } from '../../apps/web/src/router';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * Phase 6B «ورود به پنل» in the hosted bot's own Web Admin: the `/enter` page spends the token
 * once, and an entered session carries the banner «در حال مشاهده به‌عنوان میزبان» and «خروج»
 * on every page — and an ordinary session never shows it.
 */

const session = (impersonation: { ownerUsername: string } | null) => ({
  url: '/auth/session',
  body: {
    admin: {
      id: '01a05e35-c9ad-7e93-bef3-1ed9b55292c8',
      username: 'host.abcdef123456',
      displayName: 'host',
      status: 'ACTIVE',
      kind: 'HOST',
      telegramUserId: null,
      roleKeys: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      lastLoginAt: null,
    },
    permissions: ['users.view'],
    expiresAt: '2026-11-09T20:00:00.000Z',
    impersonation,
  },
});

beforeEach(() => {
  act(() => navigate('/', { replace: true, force: true }));
});
afterEach(() => vi.unstubAllGlobals());

describe('the entered session’s banner', () => {
  it('says «در حال مشاهده به‌عنوان میزبان», names the owner, and «خروج» signs this session out', async () => {
    const api = stubApi([
      session({ ownerUsername: 'the-owner' }),
      { url: '/auth/logout', method: 'POST', body: { ok: true } },
    ]);
    renderPage(<App />);
    expect(await screen.findByText(t('web.impersonation_banner'))).toBeInTheDocument();
    expect(screen.getByText('the-owner')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: t('web.impersonation_exit') }));
    await waitFor(() =>
      expect(api.calls.some((call) => call.url.endsWith('/auth/logout'))).toBe(true),
    );
  });

  it('is never drawn for an ordinary session', async () => {
    stubApi([session(null)]);
    renderPage(<App />);
    await screen.findByRole('navigation', { name: t('web.nav_label') });
    expect(screen.queryByText(t('web.impersonation_banner'))).toBeNull();
  });
});

describe('the /enter page', () => {
  it('matches only its own path', () => {
    expect(isEnterPath('/enter')).toBe(true);
    expect(isEnterPath('/enter/')).toBe(true);
    expect(isEnterPath('/activate')).toBe(false);
  });

  it('posts the token exactly once, then hands over to the Web Admin', async () => {
    const api = stubApi([
      { url: '/auth/enter', method: 'POST', body: { expiresAt: '2026-11-09T20:00:00.000Z' } },
    ]);
    const entered = vi.fn();
    renderPage(<HostedEnterPage initialToken="tok_abc" onEntered={entered} />);
    await waitFor(() => expect(entered).toHaveBeenCalledTimes(1));
    const posts = api.calls.filter((call) => call.url.endsWith('/auth/enter'));
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({ token: 'tok_abc' });
  });

  it('shows the one Persian refusal and posts nothing without a token', async () => {
    const api = stubApi([
      {
        url: '/auth/enter',
        method: 'POST',
        status: 401,
        body: {
          error: {
            kind: 'unauthenticated',
            code: 'hosting.enter_token_invalid',
            message: 'no',
            correlationId: 'c1',
          },
        },
      },
    ]);
    const { unmount } = renderPage(<HostedEnterPage initialToken="used" onEntered={() => {}} />);
    expect(await screen.findByText(t('web.err_hosting_enter_token_invalid'))).toBeInTheDocument();
    unmount();
    renderPage(<HostedEnterPage initialToken={null} onEntered={() => {}} />);
    expect(screen.getByText(t('web.enter_no_token'))).toBeInTheDocument();
    expect(api.calls.filter((call) => call.url.endsWith('/auth/enter'))).toHaveLength(1);
  });
});
