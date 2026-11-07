import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../../apps/web/src/app';
import { t } from '../../apps/web/src/i18n/web.fa';
import { stubApi } from './harness';

/**
 * A restored database left every role holding a tenant id that no longer existed, the login
 * throttle insert failed, the API answered 500 — and the form said "wrong password". An
 * internal failure must read as one; a credential failure must still read as one.
 */
const signedOut = {
  url: '/auth/session',
  status: 401,
  body: {
    error: { kind: 'UNAUTHENTICATED', code: 'auth.required', message: 'no', correlationId: 'c' },
  },
} as const;

async function submit(loginAnswer: { status: number; body: unknown }): Promise<void> {
  stubApi([
    signedOut,
    { url: '/system/readiness', body: { status: 'ok', dependencies: [] } },
    { url: '/health/info', body: { version: '1', commit: 'abc', builtAt: null } },
    { url: '/auth/login', ...loginAnswer },
  ]);
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <App />
    </QueryClientProvider>,
  );
  const username = await screen.findByLabelText('نام کاربری');
  fireEvent.change(username, { target: { value: 'owner' } });
  fireEvent.change(screen.getByLabelText('گذرواژه'), { target: { value: 'long-enough-pw' } });
  fireEvent.submit(username.closest('form') as HTMLFormElement);
}

describe('the sign-in error line', () => {
  it('says "server error, check the logs" for an internal failure, not "wrong password"', async () => {
    await submit({
      status: 500,
      body: {
        error: {
          kind: 'INTERNAL',
          code: 'internal.unhandled',
          message: 'An internal error occurred.',
          correlationId: 'c1',
        },
      },
    });
    expect(await screen.findByText(t('web.sign_in_server_error'))).toBeInTheDocument();
    expect(screen.queryByText(t('web.sign_in_failed'))).toBeNull();
  });

  it('still says "wrong username or password" for a credential failure', async () => {
    await submit({
      status: 401,
      body: {
        error: {
          kind: 'UNAUTHENTICATED',
          code: 'auth.invalid_credentials',
          message: 'no',
          correlationId: 'c2',
        },
      },
    });
    expect(await screen.findByText(t('web.sign_in_failed'))).toBeInTheDocument();
    expect(screen.queryByText(t('web.sign_in_server_error'))).toBeNull();
  });
});
