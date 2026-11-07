import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  API_PREFIX,
  HOSTED_ACTIVATION_ROUTES,
  HOSTING_ACTIVATION_ERROR_CODES as CODES,
  HOSTING_ROUTES,
  type HostedActivationStepView,
  type HostedActivationView,
  type HostedBotView,
} from '@nexa/contracts';
import { HostingPage } from '../../apps/web/src/pages/hosting';
import {
  HostedActivatePage,
  isActivationPath,
  readActivationToken,
} from '../../apps/web/src/pages/hosted-activate';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi, type Route } from './harness';

/**
 * The activation of a hosted bot (phase 6A PR-4): the creator panel's step statuses in Persian,
 * their re-run and the one-time link, and the hosted owner's activation page.
 *
 * Requests are read back from the stubbed `fetch`, so what is asserted is what would be sent.
 */

afterEach(() => vi.unstubAllGlobals());

const url = (path: string) => `${API_PREFIX}${path}`;
const TENANT = '01a05e35-c9ad-7e93-bef3-1ed9b55292c8';
const ROUTE_OF = (template: string) => url(template.replace(':tenantId', TENANT));
const ACT = '/hosting/bots/:tenantId/activation';

function bot(): HostedBotView {
  return {
    tenantId: TENANT,
    slug: 'acme-vpn',
    displayName: 'آکمه',
    state: 'ACTIVE',
    tenantStatus: 'ACTIVE',
    expiresAt: null,
    createdAt: '2026-10-01T08:00:00.000Z',
    stateChangedAt: '2026-10-01T08:00:00.000Z',
    deletedAt: null,
    purgedAt: null,
    customerCount: 0,
    webAdmin: { username: 'acme.owner' },
    telegramBot: null,
    lastBackupAt: null,
    resources: [],
  };
}

const STEPS = ['TOKEN', 'DOMAIN', 'SSL', 'WEBHOOK', 'LINK'] as const;

function steps(
  states: Partial<Record<(typeof STEPS)[number], 'DONE' | 'FAILED'>> = {},
  errors: Partial<Record<(typeof STEPS)[number], string>> = {},
): HostedActivationStepView[] {
  return STEPS.map((step) => {
    const state = states[step] ?? 'PENDING';
    return {
      step,
      state,
      doneAt: state === 'DONE' ? '2026-11-05T10:00:00.000Z' : null,
      errorCode: state === 'FAILED' ? (errors[step] ?? null) : null,
    };
  });
}

function activation(overrides: Partial<HostedActivationView> = {}): HostedActivationView {
  return {
    hostedTenantId: TENANT,
    domain: 'bots.acme.com',
    botUsername: 'acme_bot',
    dnsTarget: { hostname: 'admin.owner.com', addresses: ['203.0.113.10'] },
    steps: steps(),
    link: null,
    ownerActivatedAt: null,
    ...overrides,
  };
}

function panelRoutes(view: HostedActivationView): Route[] {
  return [
    {
      url: url(HOSTING_ROUTES.status),
      body: {
        factor: 'ACTIVE',
        recoveryCodesRemaining: 9,
        session: { expiresAt: '2026-11-05T20:00:00.000Z' },
        lockedUntil: null,
        create: { enabled: true, refusal: null },
      },
    },
    {
      url: url(HOSTING_ROUTES.bots),
      method: 'GET',
      body: { bots: [bot()], create: { enabled: true, refusal: null } },
    },
    {
      url: url(HOSTING_ROUTES.server),
      body: {
        measuredAt: '2026-11-05T10:00:00.000Z',
        cpu: { cores: 4, loadAverage1m: 0.8, loadPercent: 20 },
        memory: { totalBytes: 1, availableBytes: 1 },
        disks: [],
        estimate: {
          formula: 'x',
          budgetConcurrentCustomers: 75,
          ownerReserved: 25,
          liveHostedBots: 1,
          headroom: 49,
          moreSmallBots: 49,
          moreMediumBots: 16,
          moreLargeBots: 4,
          blockedBy: null,
        },
      },
    },
    { url: ROUTE_OF(ACT), method: 'GET', body: view },
  ];
}

const posts = (api: ReturnType<typeof stubApi>, suffix: string) =>
  api.calls.filter((call) => call.method === 'POST' && call.url.endsWith(suffix));

async function openActivation() {
  const card = await screen.findByRole('article', { name: 'آکمه' });
  fireEvent.click(within(card).getByText(t('web.hosting_act_title')));
  // Wait for the steps to be drawn: the panel mounts when the disclosure opens.
  return {
    card,
    list: await screen.findByRole('list', { name: t('web.hosting_act_steps_label') }),
  };
}

describe('the creator panel: activation steps', () => {
  it('draws five pending steps and the DNS instructions, before anything is entered', async () => {
    stubApi(panelRoutes(activation({ domain: null, botUsername: null })));
    renderPage(<HostingPage denied={false} />);
    const { list } = await openActivation();
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((row) => row.getAttribute('data-step'))).toEqual([...STEPS]);
    expect(rows.every((row) => row.getAttribute('data-status') === 'PENDING')).toBe(true);
    expect(screen.getByText('admin.owner.com')).toBeInTheDocument();
    expect(screen.getByText('203.0.113.10')).toBeInTheDocument();
    // Nothing can be re-run until a token and a domain are configured.
    for (const button of within(list).getAllByRole('button')) expect(button).toBeDisabled();
    expect(screen.getByRole('button', { name: t('web.hosting_act_configure') })).toBeEnabled();
  });

  it('says each finished step in its own Persian words', async () => {
    stubApi(
      panelRoutes(
        activation({
          steps: steps({
            TOKEN: 'DONE',
            DOMAIN: 'DONE',
            SSL: 'DONE',
            WEBHOOK: 'DONE',
            LINK: 'DONE',
          }),
          link: {
            state: 'ACTIVE',
            createdAt: '2026-11-05T10:00:00.000Z',
            expiresAt: '2026-11-06T10:00:00.000Z',
          },
        }),
      ),
    );
    renderPage(<HostingPage denied={false} />);
    const { list } = await openActivation();
    for (const words of [
      'توکن تأیید شد',
      'دامنه وصل شد',
      'SSL صادر شد',
      'لینک فعال‌سازی ساخته شد',
    ]) {
      expect(within(list).getByText(words)).toBeInTheDocument();
    }
    expect(
      screen.getByText(new RegExp(t('web.hosting_act_link_state_active'))),
    ).toBeInTheDocument();
  });

  it('shows a failed step’s error in Persian, from its closed code', async () => {
    stubApi(
      panelRoutes(
        activation({
          steps: steps({ TOKEN: 'DONE', DOMAIN: 'FAILED' }, { DOMAIN: CODES.DNS_NOT_POINTED }),
        }),
      ),
    );
    renderPage(<HostingPage denied={false} />);
    const { list } = await openActivation();
    const failed = within(list)
      .getAllByRole('listitem')
      .find((row) => row.getAttribute('data-step') === 'DOMAIN') as HTMLElement;
    expect(failed.getAttribute('data-status')).toBe('FAILED');
    expect(within(failed).getByRole('alert')).toHaveTextContent(
      t('web.err_hosting_act_dns_not_pointed'),
    );
  });

  it('re-runs a step without a code, under a fresh idempotency key, and redraws from the answer', async () => {
    const api = stubApi([
      ...panelRoutes(activation({ steps: steps({ TOKEN: 'DONE' }) })),
      {
        url: `${ROUTE_OF(ACT)}/steps/domain`,
        body: {
          activation: activation({ steps: steps({ TOKEN: 'DONE', DOMAIN: 'DONE' }) }),
          replayed: false,
        },
      },
    ]);
    renderPage(<HostingPage denied={false} />);
    const { list } = await openActivation();
    const domain = within(list)
      .getAllByRole('listitem')
      .find((row) => row.getAttribute('data-step') === 'DOMAIN') as HTMLElement;
    fireEvent.click(within(domain).getByRole('button', { name: t('web.hosting_act_run_first') }));
    await waitFor(() => expect(posts(api, '/activation/steps/domain')).toHaveLength(1));
    const body = posts(api, '/activation/steps/domain')[0]?.body as { idempotencyKey: string };
    expect(Object.keys(body)).toEqual(['idempotencyKey']);
    expect(body.idempotencyKey.length).toBeGreaterThanOrEqual(8);
    await waitFor(() => expect(domain.getAttribute('data-status')).toBe('DONE'));
    expect(within(domain).getByText('دامنه وصل شد')).toBeInTheDocument();
  });

  it('a refused re-run is shown in Persian', async () => {
    stubApi([
      ...panelRoutes(activation({ steps: steps({ TOKEN: 'DONE' }) })),
      {
        url: `${ROUTE_OF(ACT)}/steps/ssl`,
        status: 412,
        body: {
          error: {
            kind: 'PRECONDITION_FAILED',
            code: CODES.STEP_BLOCKED,
            message: 'x',
            correlationId: 'c',
          },
        },
      },
    ]);
    renderPage(<HostingPage denied={false} />);
    const { list } = await openActivation();
    const ssl = within(list)
      .getAllByRole('listitem')
      .find((row) => row.getAttribute('data-step') === 'SSL') as HTMLElement;
    fireEvent.click(within(ssl).getByRole('button'));
    expect(await screen.findByText(t('web.err_hosting_act_step_blocked'))).toBeInTheDocument();
  });

  it('configures with a fresh code; the token goes only in the request, is hidden, and is not kept', async () => {
    const api = stubApi([
      ...panelRoutes(activation({ domain: null, botUsername: null })),
      {
        url: `${ROUTE_OF(ACT)}/configure`,
        body: { activation: activation({ steps: steps({ TOKEN: 'DONE' }) }), replayed: false },
      },
    ]);
    renderPage(<HostingPage denied={false} />);
    await openActivation();
    fireEvent.click(screen.getByRole('button', { name: t('web.hosting_act_configure') }));
    const token = screen.getByLabelText(t('web.hosting_act_token_label')) as HTMLInputElement;
    expect(token.type).toBe('text');
    expect(token.autocomplete).toBe('off');
    fireEvent.change(token, { target: { value: '7100000001:AAH-secret-token-value-0123456789' } });
    fireEvent.change(screen.getByLabelText(t('web.hosting_act_domain_label')), {
      target: { value: ' bots.acme.com ' },
    });
    fireEvent.change(screen.getByLabelText(t('web.hosting_code_label')), {
      target: { value: '123456' },
    });
    const dialog = screen.getByRole('dialog');
    fireEvent.click(
      within(dialog).getAllByRole('button', {
        name: t('web.hosting_act_configure'),
      })[0] as HTMLElement,
    );
    await waitFor(() => expect(posts(api, '/activation/configure')).toHaveLength(1));
    expect(posts(api, '/activation/configure')[0]?.body).toMatchObject({
      botToken: '7100000001:AAH-secret-token-value-0123456789',
      domain: 'bots.acme.com',
      proof: { code: '123456' },
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.body.textContent).not.toContain('AAH-secret-token-value');
  });

  it('shows the activation link once, after a code, and never again', async () => {
    const link =
      'https://bots.acme.com/activate#token=nxact_exampleexampleexampleexampleexampleexample';
    const done = steps({ TOKEN: 'DONE', DOMAIN: 'DONE', SSL: 'DONE', WEBHOOK: 'DONE' });
    const api = stubApi([
      ...panelRoutes(activation({ steps: done })),
      {
        url: `${ROUTE_OF(ACT)}/link`,
        body: {
          activation: activation({
            steps: steps({
              TOKEN: 'DONE',
              DOMAIN: 'DONE',
              SSL: 'DONE',
              WEBHOOK: 'DONE',
              LINK: 'DONE',
            }),
            link: {
              state: 'ACTIVE',
              createdAt: '2026-11-05T10:00:00.000Z',
              expiresAt: '2026-11-06T10:00:00.000Z',
            },
          }),
          replayed: false,
          activationUrl: link,
        },
      },
    ]);
    renderPage(<HostingPage denied={false} />);
    const { list } = await openActivation();
    const row = within(list)
      .getAllByRole('listitem')
      .find((item) => item.getAttribute('data-step') === 'LINK') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: t('web.hosting_act_link_make') }));
    fireEvent.change(screen.getByLabelText(t('web.hosting_code_label')), {
      target: { value: '654321' },
    });
    const dialog = screen.getByRole('dialog');
    fireEvent.click(
      within(dialog).getAllByRole('button', {
        name: t('web.hosting_act_link_make'),
      })[0] as HTMLElement,
    );
    expect(await screen.findByText(link)).toBeInTheDocument();
    expect(screen.getByText(t('web.hosting_act_link_once_title'))).toBeInTheDocument();
    expect(posts(api, '/activation/link')[0]?.body).toMatchObject({ proof: { code: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: t('web.hosting_act_done') }));
    expect(screen.queryByText(link)).toBeNull();
    expect(document.body.textContent).not.toContain('nxact_');
  });
});

describe('the hosted owner’s activation page', () => {
  const route = url(HOSTED_ACTIVATION_ROUTES.redeem);
  const fill = (password = 'a-brand-new-long-password', again = password) => {
    fireEvent.change(screen.getByLabelText(t('web.activate_username')), {
      target: { value: 'acme.owner' },
    });
    fireEvent.change(screen.getByLabelText(t('web.activate_password')), {
      target: { value: password },
    });
    fireEvent.change(screen.getByLabelText(t('web.activate_password_confirm')), {
      target: { value: again },
    });
  };

  it('reads the token from the fragment only', () => {
    expect(isActivationPath('/activate')).toBe(true);
    expect(isActivationPath('/activate/')).toBe(true);
    expect(isActivationPath('/')).toBe(false);
    expect(isActivationPath('/activated')).toBe(false);
    expect(readActivationToken('#token=nxact_abc-_')).toBe('nxact_abc-_');
    expect(readActivationToken('#a=1&token=xyz')).toBe('xyz');
    expect(readActivationToken('')).toBeNull();
    expect(readActivationToken('#tokens=1')).toBeNull();
    expect(readActivationToken('#token=%E0%A4%A')).toBeNull();
  });

  it('without a token it says the link is incomplete and offers no form', () => {
    const api = stubApi([]);
    renderPage(<HostedActivatePage initialToken={null} onSignIn={() => undefined} />);
    expect(screen.getByText(t('web.activate_no_token'))).toBeInTheDocument();
    expect(screen.queryByLabelText(t('web.activate_password'))).toBeNull();
    expect(api.calls).toEqual([]);
  });

  it('will not send a short password or a mismatch; sends exactly the choice, then offers sign-in', async () => {
    const api = stubApi([{ url: route, body: { ok: true } }]);
    const signIn = vi.fn();
    renderPage(<HostedActivatePage initialToken="nxact_the-token" onSignIn={signIn} />);
    const submit = screen.getByRole('button', { name: t('web.activate_submit') });

    fill('short', 'short');
    fireEvent.click(submit);
    expect(await screen.findByText(t('web.activate_password_short'))).toBeInTheDocument();
    fill('a-brand-new-long-password', 'a-different-long-password');
    fireEvent.click(submit);
    expect(await screen.findByText(t('web.activate_mismatch'))).toBeInTheDocument();
    expect(api.calls).toEqual([]);

    fill();
    fireEvent.click(submit);
    await waitFor(() => expect(posts(api, HOSTED_ACTIVATION_ROUTES.redeem)).toHaveLength(1));
    expect(posts(api, HOSTED_ACTIVATION_ROUTES.redeem)[0]?.body).toEqual({
      token: 'nxact_the-token',
      username: 'acme.owner',
      password: 'a-brand-new-long-password',
    });
    expect(await screen.findByText(t('web.activate_done_title'))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: t('web.activate_go_sign_in') }));
    expect(signIn).toHaveBeenCalledTimes(1);
  });

  it.each([
    [CODES.LINK_EXPIRED, 'web.err_hosting_act_link_expired'],
    [CODES.LINK_USED, 'web.err_hosting_act_link_used'],
    [CODES.LINK_INVALID, 'web.err_hosting_act_link_invalid'],
    [CODES.USERNAME_TAKEN, 'web.err_hosting_act_username_taken'],
  ] as const)('shows %s in Persian and clears the password', async (code, key) => {
    stubApi([
      {
        url: route,
        status: 412,
        body: { error: { kind: 'PRECONDITION_FAILED', code, message: 'x', correlationId: 'c' } },
      },
    ]);
    renderPage(<HostedActivatePage initialToken="nxact_the-token" onSignIn={() => undefined} />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: t('web.activate_submit') }));
    expect(await screen.findByRole('alert')).toHaveTextContent(t(key));
    expect((screen.getByLabelText(t('web.activate_password')) as HTMLInputElement).value).toBe('');
  });
});
