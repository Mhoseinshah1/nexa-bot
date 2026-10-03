import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../../apps/web/src/app';
import { AccountPage } from '../../apps/web/src/pages/account';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * Phase D2 in the Web Admin: the two-step sign-in screen, and the security section of
 * the administrator's own account page. Driven through the real client and schemas
 * against a stubbed `fetch`.
 */

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const CODES = Array.from(
  { length: 10 },
  (_, index) => `ABCD-EFGH-JKMN-PQ${String(index).padStart(2, '0')}`,
);
const CURRENT = '019a0000-0000-7000-8000-0000000000a1';
const OTHER = '019a0000-0000-7000-8000-0000000000a2';

const session = (id: string, current: boolean) => ({
  id,
  issuedAt: '2026-10-01T08:00:00.000Z',
  expiresAt: '2026-10-08T08:00:00.000Z',
  lastSeenAt: '2026-10-03T08:00:00.000Z',
  ip: current ? '203.0.113.7' : '198.51.100.9',
  userAgent: 'Mozilla/5.0',
  current,
});

const overview = (state: 'DISABLED' | 'PENDING' | 'ACTIVE', remaining = 0) => ({
  totp: { state, activatedAt: state === 'ACTIVE' ? '2026-10-02T08:00:00.000Z' : null },
  backupCodes: { remaining, generatedAt: remaining > 0 ? '2026-10-02T08:00:00.000Z' : null },
});

const baseRoutes = (state: 'DISABLED' | 'ACTIVE', remaining = 0) => [
  { url: '/auth/security/events', body: { events: [] } },
  { url: '/auth/security', body: overview(state, remaining) },
  { url: '/auth/sessions', body: { sessions: [session(CURRENT, true), session(OTHER, false)] } },
];

describe('the account security section', () => {
  it('enrols: the password first, then the secret once, then backup codes once', async () => {
    const api = stubApi([
      ...baseRoutes('DISABLED'),
      {
        url: '/auth/security/totp/enrol',
        body: {
          secret: SECRET,
          otpauthUri: `otpauth://totp/Nexa:owner?secret=${SECRET}`,
          qrPngDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
          expiresAt: '2026-10-03T08:15:00.000Z',
          parameters: { algorithm: 'SHA1', digits: 6, periodSeconds: 30 },
        },
      },
      { url: '/auth/security/totp/activate', body: { backupCodes: CODES } },
    ]);
    renderPage(<AccountPage />);

    const start = await screen.findByRole('button', {
      name: new RegExp(t('web.totp_enrol_start')),
    });
    expect(start).toBeDisabled();
    fireEvent.change(screen.getByLabelText(t('web.security_password_confirm')), {
      target: { value: 'the-owners-password' },
    });
    fireEvent.click(start);

    expect(await screen.findByAltText(t('web.totp_qr_alt'))).toBeInTheDocument();
    expect(screen.getByText('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP')).toBeInTheDocument();
    const enrolCall = api.calls.find((call) => call.url.includes('/totp/enrol'));
    expect(enrolCall?.body).toEqual({ password: 'the-owners-password' });

    fireEvent.change(screen.getByLabelText(t('web.second_factor_code_label')), {
      target: { value: '123 456' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('web.totp_activate') }));

    expect(await screen.findByText(CODES[0]!)).toBeInTheDocument();
    expect(screen.getByText(t('web.backup_codes_once_title'))).toBeInTheDocument();
    const activateCall = api.calls.find((call) => call.url.includes('/totp/activate'));
    expect(activateCall?.body).toEqual({ code: '123456' });
    // The secret is gone from the page once the codes are shown.
    expect(screen.queryByText('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: new RegExp(t('web.backup_codes_saved')) }));
    await waitFor(() => expect(screen.queryByText(CODES[0]!)).toBeNull());
  });

  it('will not disable without the password AND a code, and asks first', async () => {
    const api = stubApi([
      ...baseRoutes('ACTIVE', 7),
      { url: '/auth/security/totp/disable', body: { ok: true } },
    ]);
    renderPage(<AccountPage />);

    const disable = await screen.findByRole('button', { name: t('web.totp_disable') });
    expect(disable).toBeDisabled();
    const passwords = screen.getAllByLabelText(t('web.security_password_confirm'));
    fireEvent.change(passwords[1]!, { target: { value: 'the-owners-password' } });
    expect(disable).toBeDisabled();

    // Switch to a backup code in place of the device.
    const toggles = screen.getAllByRole('button', { name: t('web.second_factor_use_backup') });
    fireEvent.click(toggles[1]!);
    fireEvent.change(screen.getAllByLabelText(t('web.second_factor_backup_label'))[0]!, {
      target: { value: 'ABCD-EFGH-JKMN-PQ00' },
    });
    expect(disable).not.toBeDisabled();
    fireEvent.click(disable);

    // A confirmation, and nothing sent until it is answered.
    expect(await screen.findByText(t('web.totp_disable_question'))).toBeInTheDocument();
    expect(api.calls.some((call) => call.url.includes('/totp/disable'))).toBe(false);
    const confirmButtons = screen.getAllByRole('button', { name: t('web.totp_disable') });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]!);

    await waitFor(() => {
      const call = api.calls.find((one) => one.url.includes('/totp/disable'));
      expect(call?.body).toEqual({
        password: 'the-owners-password',
        backupCode: 'ABCD-EFGH-JKMN-PQ00',
      });
    });
  });

  it('marks the current session, offers to end only the others, and sends no id but theirs', async () => {
    const api = stubApi([
      ...baseRoutes('DISABLED'),
      { url: `/auth/sessions/${OTHER}/revoke`, body: { revoked: true, current: false } },
    ]);
    renderPage(<AccountPage />);

    expect(await screen.findByText(t('web.admin_sessions_current'))).toBeInTheDocument();
    const revokeButtons = screen.getAllByRole('button', { name: t('web.sessions_revoke') });
    // One button: the current session is ended by signing out, not from this list.
    expect(revokeButtons).toHaveLength(1);
    fireEvent.click(revokeButtons[0]!);
    await waitFor(() =>
      expect(api.calls.some((call) => call.url.includes(`/auth/sessions/${OTHER}/revoke`))).toBe(
        true,
      ),
    );
    expect(api.calls.some((call) => call.url.includes(`/auth/sessions/${CURRENT}/revoke`))).toBe(
      false,
    );
  });

  it('warns when backup codes run low', async () => {
    stubApi(baseRoutes('ACTIVE', 2));
    renderPage(<AccountPage />);
    expect(await screen.findByText(t('web.backup_codes_low'))).toBeInTheDocument();
  });

  it('renders the history with the account holder their own sign-ins and refusals', async () => {
    stubApi([
      {
        url: '/auth/security/events',
        body: {
          events: [
            {
              id: 'e1',
              action: 'auth.login',
              result: 'SUCCESS',
              occurredAt: '2026-10-03T08:00:00.000Z',
              actorLabel: null,
              ip: '203.0.113.7',
              userAgent: 'Mozilla/5.0',
              reason: null,
              method: 'TOTP',
            },
            {
              id: 'e2',
              action: 'auth.second_factor',
              result: 'DENIED',
              occurredAt: '2026-10-03T07:59:00.000Z',
              actorLabel: null,
              ip: '192.0.2.44',
              userAgent: null,
              reason: 'BAD_SECOND_FACTOR',
              method: 'TOTP',
            },
          ],
        },
      },
      ...baseRoutes('ACTIVE', 9).slice(1),
    ]);
    renderPage(<AccountPage />);
    expect(await screen.findByText(t('web.security_event_second_factor'))).toBeInTheDocument();
    expect(screen.getByText('192.0.2.44')).toBeInTheDocument();
    expect(screen.getAllByText(t('web.security_event_denied')).length).toBeGreaterThan(0);
  });
});

describe('two-step sign-in', () => {
  const renderShell = () =>
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <App />
      </QueryClientProvider>,
    );

  it('asks for a code after a right password, and sends it to the second step', async () => {
    const api = stubApi([
      {
        url: '/auth/session',
        status: 401,
        body: {
          error: {
            kind: 'UNAUTHENTICATED',
            code: 'auth.required',
            message: 'x',
            correlationId: 'c',
          },
        },
      },
      {
        url: '/auth/login',
        status: 201,
        body: { secondFactorRequired: true, expiresAt: '2026-10-03T08:05:00.000Z' },
      },
      {
        url: '/auth/login/second-factor',
        status: 401,
        body: {
          error: {
            kind: 'UNAUTHENTICATED',
            code: 'auth.second_factor_invalid',
            message: 'x',
            correlationId: 'c',
          },
        },
      },
    ]);
    renderShell();

    fireEvent.change(await screen.findByLabelText(t('web.username')), {
      target: { value: 'owner' },
    });
    fireEvent.change(screen.getByLabelText(t('web.password')), {
      target: { value: 'the-owners-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('web.sign_in') }));

    const codeInput = await screen.findByLabelText(t('web.second_factor_code_label'));
    expect(screen.getByText(t('web.second_factor_title'))).toBeInTheDocument();
    fireEvent.change(codeInput, { target: { value: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: t('web.second_factor_submit') }));

    await waitFor(() => {
      const call = api.calls.find((one) => one.url.includes('/auth/login/second-factor'));
      expect(call?.body).toEqual({ code: '654321' });
    });
    // One generic message: wrong, replayed and used codes read the same.
    expect(await screen.findByRole('alert')).toHaveTextContent(t('web.second_factor_invalid'));
    // And the password was not kept anywhere the page can reach.
    expect(document.body.innerHTML).not.toContain('the-owners-password');
  });
});
