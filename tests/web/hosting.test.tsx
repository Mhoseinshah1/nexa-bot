import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  API_PREFIX,
  HOSTING_ROUTES,
  PERMISSION_KEYS,
  type CapacityLimitView,
  type HostedBotView,
  type HostingStatusResponse,
} from '@nexa/contracts';
import { NAV, navPermitted } from '../../apps/web/src/nav';
import { HostingPage } from '../../apps/web/src/pages/hosting';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi, type Route } from './harness';

/**
 * «میزبانی‌ها» (phase 6A, D1): the gate in front of the section, the code every sensitive action
 * asks for, the create switch the server holds closed, the limits editor and who sees the link.
 *
 * Every fixture is shaped as `HostingStatusResponse`/`HostedBotView` declare them, and the
 * requests are read back from the stubbed `fetch`, so what is asserted is what would be sent.
 */

afterEach(() => vi.unstubAllGlobals());

const url = (path: string) => `${API_PREFIX}${path}`;
const TENANT = '01a05e35-c9ad-7e93-bef3-1ed9b55292c8';
const ROUTE_OF = (template: string) => url(template.replace(':tenantId', TENANT));

const OPEN = { enabled: true, refusal: null } as const;

function status(overrides: Partial<HostingStatusResponse> = {}): HostingStatusResponse {
  return {
    factor: 'ACTIVE',
    recoveryCodesRemaining: 9,
    session: { expiresAt: '2026-11-05T20:00:00.000Z' },
    lockedUntil: null,
    create: OPEN,
    ...overrides,
  };
}

function limit(overrides: Partial<CapacityLimitView> = {}): CapacityLimitView {
  return {
    resource: 'BROADCAST_PER_SECOND',
    limit: { mode: 'LIMITED', value: 5 },
    source: 'DEFAULT',
    defaultLimit: { mode: 'LIMITED', value: 5 },
    min: 1,
    max: 30,
    allowsUnlimited: true,
    consumer: 'ACTIVE',
    ...overrides,
  };
}

function bot(overrides: Partial<HostedBotView> = {}): HostedBotView {
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
    customerCount: 12,
    webAdmin: { username: 'acme.owner' },
    telegramBot: { username: 'acme_bot', status: 'ACTIVE' },
    lastBackupAt: null,
    resources: [
      { limit: limit(), pressureAlertsLast24h: 0 },
      {
        limit: limit({
          resource: 'UPDATE_CONCURRENCY',
          limit: { mode: 'LIMITED', value: 4 },
          defaultLimit: { mode: 'LIMITED', value: 4 },
          allowsUnlimited: false,
          min: 1,
          max: 16,
        }),
        pressureAlertsLast24h: 2,
      },
    ],
    ...overrides,
  };
}

const SERVER = {
  measuredAt: '2026-11-05T10:00:00.000Z',
  cpu: { cores: 4, loadAverage1m: 0.8, loadPercent: 20 },
  memory: { totalBytes: 8 * 1024 ** 3, availableBytes: 5 * 1024 ** 3 },
  disks: [
    { path: '/', totalBytes: 100 * 1024 ** 3, availableBytes: 60 * 1024 ** 3, usedPercent: 40 },
  ],
  estimate: {
    formula: 'budget = floor(75 x min(1, cores / 4))',
    budgetConcurrentCustomers: 75,
    ownerReserved: 25,
    liveHostedBots: 1,
    headroom: 49,
    moreSmallBots: 49,
    moreMediumBots: 16,
    moreLargeBots: 4,
    blockedBy: null,
  },
};

/** The routes a signed-in section needs to draw. */
function panelRoutes(
  options: { create?: HostingStatusResponse['create']; bots?: HostedBotView[] } = {},
): Route[] {
  const create = options.create ?? OPEN;
  return [
    { url: url(HOSTING_ROUTES.status), body: status({ create }) },
    {
      url: url(HOSTING_ROUTES.bots),
      method: 'GET',
      body: { bots: options.bots ?? [bot()], create },
    },
    { url: url(HOSTING_ROUTES.server), body: SERVER },
  ];
}

const posts = (api: ReturnType<typeof stubApi>, suffix: string) =>
  api.calls.filter((call) => call.method === 'POST' && call.url.endsWith(suffix));

function typeCode(value: string): void {
  fireEvent.change(screen.getByLabelText(t('web.hosting_code_label')), { target: { value } });
}

describe('the gate', () => {
  it('draws nothing and asks for nothing when the actor is not the owner', () => {
    const api = stubApi([]);
    renderPage(<HostingPage denied />);
    expect(screen.getByText(t('web.no_permission'))).toBeInTheDocument();
    expect(api.calls).toEqual([]);
  });

  it('enrols from NONE: password, then QR and secret, then the code, then the ten codes once', async () => {
    const codes = Array.from(
      { length: 10 },
      (_, index) => `code-${String(index).padStart(2, '0')}-abcd`,
    );
    const api = stubApi([
      { url: url(HOSTING_ROUTES.status), body: status({ factor: 'NONE', session: null }) },
      {
        url: url(HOSTING_ROUTES.enrol),
        body: {
          secret: 'JBSWY3DPEHPK3PXP',
          otpauthUri: 'otpauth://totp/Nexa?secret=JBSWY3DPEHPK3PXP',
          qrPngDataUrl: 'data:image/png;base64,AAAA',
          expiresAt: '2026-11-05T10:15:00.000Z',
          parameters: { algorithm: 'SHA1', digits: 6, periodSeconds: 30 },
        },
      },
      {
        url: url(HOSTING_ROUTES.activate),
        body: { recoveryCodes: codes, session: { expiresAt: '2026-11-05T22:00:00.000Z' } },
      },
    ]);
    renderPage(<HostingPage denied={false} />);

    fireEvent.change(await screen.findByLabelText(t('web.hosting_enrol_password')), {
      target: { value: 'my-account-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('web.hosting_enrol_start') }));

    expect(await screen.findByAltText(t('web.hosting_enrol_qr_alt'))).toBeInTheDocument();
    expect(screen.getByText('JBSW Y3DP EHPK 3PXP')).toBeInTheDocument();
    expect(posts(api, HOSTING_ROUTES.enrol)[0]?.body).toEqual({ password: 'my-account-password' });
    // The password field is gone and nothing keeps its value.
    expect(screen.queryByLabelText(t('web.hosting_enrol_password'))).toBeNull();

    const activate = screen.getByRole('button', { name: t('web.hosting_enrol_activate') });
    expect(activate).toBeDisabled();
    typeCode('12345');
    expect(activate).toBeDisabled();
    typeCode('123 456');
    fireEvent.click(activate);

    const list = await screen.findByRole('list', { name: t('web.hosting_recovery_list') });
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
    expect(posts(api, HOSTING_ROUTES.activate)[0]?.body).toEqual({ code: '123456' });
    // The panel is not drawn until the owner confirms the codes are saved.
    expect(screen.queryByText(t('web.hosting_bots_title'))).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('web.hosting_recovery_saved') }));
    expect(screen.queryByRole('list', { name: t('web.hosting_recovery_list') })).toBeNull();
  });

  it('lets a PENDING enrolment finish with the code, or start over', async () => {
    stubApi([
      { url: url(HOSTING_ROUTES.status), body: status({ factor: 'PENDING', session: null }) },
    ]);
    renderPage(<HostingPage denied={false} />);
    expect(await screen.findByText(t('web.hosting_pending_title'))).toBeInTheDocument();
    expect(screen.getByLabelText(t('web.hosting_code_label'))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: t('web.hosting_pending_restart') }));
    expect(screen.getByLabelText(t('web.hosting_enrol_password'))).toBeInTheDocument();
  });

  it('asks an ACTIVE factor without a session for a code, and sends exactly that proof', async () => {
    const api = stubApi([
      { url: url(HOSTING_ROUTES.status), body: status({ session: null }) },
      {
        url: url(HOSTING_ROUTES.openSession),
        body: { session: { expiresAt: '2026-11-05T22:00:00.000Z' } },
      },
    ]);
    renderPage(<HostingPage denied={false} />);
    const open = await screen.findByRole('button', { name: t('web.hosting_unlock_button') });
    expect(open).toBeDisabled();
    typeCode('654321');
    fireEvent.click(open);
    await waitFor(() => expect(posts(api, HOSTING_ROUTES.openSession)).toHaveLength(1));
    expect(posts(api, HOSTING_ROUTES.openSession)[0]?.body).toEqual({ proof: { code: '654321' } });
  });

  it('sends a recovery code as `backupCode`', async () => {
    const api = stubApi([
      { url: url(HOSTING_ROUTES.status), body: status({ session: null }) },
      {
        url: url(HOSTING_ROUTES.openSession),
        body: { session: { expiresAt: '2026-11-05T22:00:00.000Z' } },
      },
    ]);
    renderPage(<HostingPage denied={false} />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.hosting_use_backup') }));
    fireEvent.change(screen.getByLabelText(t('web.hosting_backup_label')), {
      target: { value: 'abcd-efgh-ijkl' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('web.hosting_unlock_button') }));
    await waitFor(() => expect(posts(api, HOSTING_ROUTES.openSession)).toHaveLength(1));
    expect(posts(api, HOSTING_ROUTES.openSession)[0]?.body).toEqual({
      proof: { backupCode: 'abcd-efgh-ijkl' },
    });
  });

  it('shows when the codes are locked until, and does not let the owner try', async () => {
    stubApi([
      {
        url: url(HOSTING_ROUTES.status),
        body: status({ session: null, lockedUntil: '2099-01-01T00:00:00.000Z' }),
      },
    ]);
    renderPage(<HostingPage denied={false} />);
    expect(await screen.findByText(new RegExp(t('web.hosting_locked_until')))).toBeInTheDocument();
    typeCode('654321');
    expect(screen.getByRole('button', { name: t('web.hosting_unlock_button') })).toBeDisabled();
  });
});

describe('the panel', () => {
  it('draws each bot with its state, expiry, customers, admin and Telegram bot, and the session', async () => {
    stubApi(panelRoutes());
    renderPage(<HostingPage denied={false} />);
    const card = await screen.findByRole('article', { name: 'آکمه' });
    expect(card.querySelector('.hosting-bot-head .badge')?.textContent).toBe(
      t('web.hosting_state_active'),
    );
    expect(within(card).getByText(t('web.hosting_expiry_none'))).toBeInTheDocument();
    expect(within(card).getByText('acme.owner')).toBeInTheDocument();
    expect(within(card).getByText('@acme_bot')).toBeInTheDocument();
    expect(screen.getByText(t('web.hosting_session_until'))).toBeInTheDocument();
    // The server's own estimate, not a figure of the page's.
    expect(
      await screen.findByText(new RegExp(`${t('web.hosting_server_est_prefix')}\\s+49`)),
    ).toBeInTheDocument();
  });

  it('names every state the contract has', async () => {
    stubApi(
      panelRoutes({
        bots: [
          bot({ tenantId: 'a', displayName: 'الف', state: 'SUSPENDED' }),
          bot({ tenantId: 'b', displayName: 'ب', state: 'EXPIRED' }),
          bot({ tenantId: 'c', displayName: 'ج', state: 'DELETED' }),
          bot({ tenantId: 'd', displayName: 'د', state: 'PURGED' }),
        ],
      }),
    );
    renderPage(<HostingPage denied={false} />);
    await screen.findByRole('article', { name: 'الف' });
    for (const key of [
      'web.hosting_state_suspended',
      'web.hosting_state_expired',
      'web.hosting_state_deleted',
      'web.hosting_state_purged',
    ] as const) {
      expect(screen.getAllByText(t(key)).length).toBeGreaterThan(0);
    }
    // A purged bot offers nothing to do.
    const purged = screen.getByRole('article', { name: 'د' });
    expect(within(purged).queryAllByRole('button')).toEqual([]);
  });

  it('says why creating is closed and disables the button, for each refusal', async () => {
    for (const refusal of ['PRODUCTION_NOT_RELEASED', 'FLAG_OFF'] as const) {
      stubApi(panelRoutes({ create: { enabled: false, refusal } }));
      const { unmount } = renderPage(<HostingPage denied={false} />);
      const button = await screen.findByRole('button', { name: t('web.hosting_create') });
      expect(button).toBeDisabled();
      expect(
        screen.getByText(
          refusal === 'FLAG_OFF'
            ? t('web.hosting_create_flag_off')
            : t('web.hosting_create_not_released'),
        ),
      ).toBeInTheDocument();
      expect(t('web.hosting_create_not_released')).toBe(
        'ساخت ربات میزبانی تا پایان آزمون جداسازی غیرفعال است',
      );
      unmount();
    }
  });

  it('draws the empty state, never a sample bot', async () => {
    stubApi(panelRoutes({ bots: [] }));
    renderPage(<HostingPage denied={false} />);
    expect(await screen.findByText(t('web.hosting_bots_empty_title'))).toBeInTheDocument();
  });

  it('offers «ورود به پنل» disabled with its note and never calls the server for it', async () => {
    const api = stubApi(panelRoutes());
    renderPage(<HostingPage denied={false} />);
    const card = await screen.findByRole('article', { name: 'آکمه' });
    expect(
      within(card).getByRole('button', { name: t('web.hosting_action_enter') }),
    ).toBeDisabled();
    expect(within(card).getByText(t('web.hosting_enter_later'))).toBeInTheDocument();
    expect(api.calls.some((call) => call.url.endsWith('/enter'))).toBe(false);
  });
});

describe('the code prompt on a sensitive action', () => {
  it('holds the action back until a code is typed, then sends the proof and a key, and reuses the key on retry', async () => {
    const api = stubApi([
      ...panelRoutes(),
      {
        url: ROUTE_OF(HOSTING_ROUTES.suspend),
        method: 'POST',
        status: 400,
        body: {
          error: {
            kind: 'validation',
            code: 'hosting.code_rejected',
            message: 'no',
            correlationId: 'c1',
          },
        },
      },
    ]);
    renderPage(<HostingPage denied={false} />);
    const card = await screen.findByRole('article', { name: 'آکمه' });
    fireEvent.click(within(card).getByRole('button', { name: t('web.hosting_action_suspend') }));

    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: t('web.hosting_suspend_submit') });
    expect(confirm).toBeDisabled();
    expect(posts(api, '/suspend')).toHaveLength(0);

    typeCode('111111');
    fireEvent.change(within(dialog).getByLabelText(t('web.hosting_reason')), {
      target: { value: '  پرداخت نشده  ' },
    });
    fireEvent.click(confirm);
    await waitFor(() => expect(posts(api, '/suspend')).toHaveLength(1));
    // The server's refusal reads in Persian, in the dialog, and the code field is emptied.
    expect(await within(dialog).findByText(t('web.err_hosting_code_rejected'))).toBeInTheDocument();
    expect(
      (within(dialog).getByLabelText(t('web.hosting_code_label')) as HTMLInputElement).value,
    ).toBe('');

    typeCode('222222');
    fireEvent.click(within(dialog).getByRole('button', { name: t('web.hosting_suspend_submit') }));
    await waitFor(() => expect(posts(api, '/suspend')).toHaveLength(2));

    const [first, second] = posts(api, '/suspend');
    expect(first?.body).toMatchObject({ proof: { code: '111111' }, reason: 'پرداخت نشده' });
    expect(second?.body).toMatchObject({ proof: { code: '222222' } });
    const key = (first?.body as { idempotencyKey: string }).idempotencyKey;
    expect(key.length).toBeGreaterThanOrEqual(8);
    expect((second?.body as { idempotencyKey: string }).idempotencyKey).toBe(key);
  });

  it('mints a new key each time the dialog is opened', async () => {
    const api = stubApi([
      ...panelRoutes(),
      {
        url: ROUTE_OF(HOSTING_ROUTES.suspend),
        method: 'POST',
        body: { bot: bot(), replayed: false },
      },
    ]);
    renderPage(<HostingPage denied={false} />);
    const keys: string[] = [];
    for (const code of ['111111', '222222']) {
      const card = await screen.findByRole('article', { name: 'آکمه' });
      fireEvent.click(within(card).getByRole('button', { name: t('web.hosting_action_suspend') }));
      const dialog = await screen.findByRole('dialog');
      typeCode(code);
      fireEvent.click(
        within(dialog).getByRole('button', { name: t('web.hosting_suspend_submit') }),
      );
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      keys.push((posts(api, '/suspend').at(-1)?.body as { idempotencyKey: string }).idempotencyKey);
    }
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('purges only after the preview counts are read and the slug is typed exactly', async () => {
    const api = stubApi([
      ...panelRoutes({ bots: [bot({ state: 'DELETED', tenantStatus: 'DISABLED' })] }),
      {
        url: ROUTE_OF(HOSTING_ROUTES.purgePreview),
        body: {
          tenantId: TENANT,
          confirmSlug: 'acme-vpn',
          counts: { customers: 12, orders: 30, services: 25, payments: 40, admins: 2 },
        },
      },
      {
        url: ROUTE_OF(HOSTING_ROUTES.purge),
        method: 'POST',
        body: { bot: bot({ state: 'PURGED' }), replayed: false, erasure: 'PENDING' },
      },
    ]);
    renderPage(<HostingPage denied={false} />);
    const card = await screen.findByRole('article', { name: 'آکمه' });
    fireEvent.click(within(card).getByRole('button', { name: t('web.hosting_action_purge') }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('40');

    typeCode('333333');
    const confirm = within(dialog).getByRole('button', { name: t('web.hosting_purge_submit') });
    expect(confirm).toBeDisabled();
    const slug = within(dialog).getByLabelText(t('web.hosting_purge_confirm_label'));
    fireEvent.change(slug, { target: { value: 'acme' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(slug, { target: { value: 'acme-vpn' } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(posts(api, '/purge')).toHaveLength(1));
    expect(posts(api, '/purge')[0]?.body).toMatchObject({
      proof: { code: '333333' },
      confirmSlug: 'acme-vpn',
    });
  });

  it('asks for a code before changing the expiry, and sends null for an empty date', async () => {
    const api = stubApi([
      ...panelRoutes(),
      {
        url: ROUTE_OF(HOSTING_ROUTES.expiry),
        method: 'POST',
        body: { bot: bot(), replayed: false },
      },
    ]);
    renderPage(<HostingPage denied={false} />);
    const card = await screen.findByRole('article', { name: 'آکمه' });
    fireEvent.click(within(card).getByRole('button', { name: t('web.hosting_action_expiry') }));
    const dialog = await screen.findByRole('dialog');
    typeCode('444444');
    fireEvent.click(within(dialog).getByRole('button', { name: t('web.hosting_expiry_submit') }));
    await waitFor(() => expect(posts(api, '/expiry')).toHaveLength(1));
    expect(posts(api, '/expiry')[0]?.body).toMatchObject({
      proof: { code: '444444' },
      expiresAt: null,
    });
  });
});

describe('the limits editor', () => {
  async function openLimits() {
    const card = await screen.findByRole('article', { name: 'آکمه' });
    fireEvent.click(within(card).getByText(t('web.hosting_action_limits')));
    return card;
  }

  it('sends {mode:"UNLIMITED"} when «نامحدود» is switched on, behind a code', async () => {
    const api = stubApi([
      ...panelRoutes(),
      {
        url: ROUTE_OF(HOSTING_ROUTES.setLimit),
        method: 'POST',
        body: {
          tenant: { tenantId: TENANT, displayName: 'آکمه', tier: 'HOSTED', limits: [] },
          replayed: false,
        },
      },
    ]);
    renderPage(<HostingPage denied={false} />);
    const card = await openLimits();
    const label = t('web.hosting_res_broadcast_per_second');
    const save = within(card).getByRole('button', {
      name: `${t('web.hosting_limit_save')} — ${label}`,
    });
    expect(save).toBeDisabled();
    fireEvent.click(
      within(card).getByRole('switch', { name: `${t('web.hosting_limit_unlimited')} — ${label}` }),
    );
    expect(save).toBeEnabled();
    fireEvent.click(save);

    const dialog = await screen.findByRole('dialog');
    expect(posts(api, '/limits')).toHaveLength(0);
    typeCode('555555');
    fireEvent.click(within(dialog).getByRole('button', { name: t('web.hosting_limit_save') }));
    await waitFor(() => expect(posts(api, '/limits')).toHaveLength(1));
    expect(posts(api, '/limits')[0]?.body).toMatchObject({
      proof: { code: '555555' },
      resource: 'BROADCAST_PER_SECOND',
      limit: { mode: 'UNLIMITED' },
    });
  });

  it('sends a LIMITED value, refuses one outside the allowed range, and has no switch where «نامحدود» is not allowed', async () => {
    const api = stubApi([
      ...panelRoutes(),
      {
        url: ROUTE_OF(HOSTING_ROUTES.setLimit),
        method: 'POST',
        body: {
          tenant: { tenantId: TENANT, displayName: 'آکمه', tier: 'HOSTED', limits: [] },
          replayed: false,
        },
      },
    ]);
    renderPage(<HostingPage denied={false} />);
    const card = await openLimits();
    const concurrency = t('web.hosting_res_update_concurrency');
    expect(
      within(card).queryByRole('switch', {
        name: `${t('web.hosting_limit_unlimited')} — ${concurrency}`,
      }),
    ).toBeNull();
    const row = within(card).getByText(concurrency).closest('li') as HTMLElement;
    const value = within(row).getByLabelText(t('web.hosting_limit_value'));
    const save = within(row).getByRole('button', {
      name: `${t('web.hosting_limit_save')} — ${concurrency}`,
    });
    fireEvent.change(value, { target: { value: '99' } });
    expect(save).toBeDisabled();
    fireEvent.change(value, { target: { value: '8' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    const dialog = await screen.findByRole('dialog');
    typeCode('666666');
    fireEvent.click(within(dialog).getByRole('button', { name: t('web.hosting_limit_save') }));
    await waitFor(() => expect(posts(api, '/limits')).toHaveLength(1));
    expect(posts(api, '/limits')[0]?.body).toMatchObject({
      resource: 'UPDATE_CONCURRENCY',
      limit: { mode: 'LIMITED', value: 8 },
    });
  });

  it('resets a stored limit to the default with `limit: null`, and shows the default beside it', async () => {
    const stored = bot({
      resources: [
        {
          limit: limit({ limit: { mode: 'LIMITED', value: 9 }, source: 'STORED' }),
          pressureAlertsLast24h: 0,
        },
      ],
    });
    const api = stubApi([
      ...panelRoutes({ bots: [stored] }),
      {
        url: ROUTE_OF(HOSTING_ROUTES.setLimit),
        method: 'POST',
        body: {
          tenant: { tenantId: TENANT, displayName: 'آکمه', tier: 'HOSTED', limits: [] },
          replayed: false,
        },
      },
    ]);
    renderPage(<HostingPage denied={false} />);
    const card = await openLimits();
    expect(
      within(card).getByText(new RegExp(t('web.hosting_limit_default_is'))),
    ).toBeInTheDocument();
    fireEvent.click(
      within(card).getByRole('button', {
        name: `${t('web.hosting_limit_reset')} — ${t('web.hosting_res_broadcast_per_second')}`,
      }),
    );
    const dialog = await screen.findByRole('dialog');
    typeCode('777777');
    fireEvent.click(within(dialog).getByRole('button', { name: t('web.hosting_limit_save') }));
    await waitFor(() => expect(posts(api, '/limits')).toHaveLength(1));
    expect(posts(api, '/limits')[0]?.body).toMatchObject({ limit: null });
  });
});

describe('the create dialog', () => {
  it('holds «ساخت» back until the fields are valid and a code is typed, then sends the whole request', async () => {
    const api = stubApi([
      ...panelRoutes(),
      { url: url(HOSTING_ROUTES.bots), method: 'POST', body: { bot: bot(), replayed: false } },
    ]);
    renderPage(<HostingPage denied={false} />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.hosting_create') }));
    const dialog = await screen.findByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: t('web.hosting_create_submit') });
    const set = (label: string, value: string) =>
      fireEvent.change(within(dialog).getByLabelText(label), { target: { value } });
    set(t('web.hosting_field_slug'), 'Bad Slug');
    set(t('web.hosting_field_display_name'), 'ربات تازه');
    set(t('web.hosting_field_admin_username'), 'owner.new');
    set(t('web.hosting_field_admin_display_name'), 'مدیر');
    set(t('web.hosting_field_admin_password'), 'a-long-enough-password');
    typeCode('888888');
    expect(submit).toBeDisabled();
    set(t('web.hosting_field_slug'), 'new-bot');
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => expect(posts(api, HOSTING_ROUTES.bots)).toHaveLength(1));
    expect(posts(api, HOSTING_ROUTES.bots)[0]?.body).toMatchObject({
      proof: { code: '888888' },
      slug: 'new-bot',
      displayName: 'ربات تازه',
      adminUsername: 'owner.new',
      adminDisplayName: 'مدیر',
      adminPassword: 'a-long-enough-password',
      expiresAt: null,
    });
  });
});

describe('closing the section', () => {
  it('posts the close and goes back to asking for the status', async () => {
    const api = stubApi([
      ...panelRoutes(),
      { url: url(HOSTING_ROUTES.closeSession), method: 'POST', body: { closed: 1 } },
    ]);
    renderPage(<HostingPage denied={false} />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.hosting_session_close') }));
    await waitFor(() => expect(posts(api, HOSTING_ROUTES.closeSession)).toHaveLength(1));
  });
});

describe('the link in the sidebar', () => {
  const entry = NAV.find((candidate) => candidate.id === 'hosting');

  it('is drawn only to an actor holding hosting.manage', () => {
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(entry.path).toBe('/hosting');
    expect(entry.permission).toBe('hosting.manage');
    expect(navPermitted(entry, ['hosting.manage'], ['owner'])).toBe(true);
    expect(
      navPermitted(
        entry,
        PERMISSION_KEYS.filter((key) => key !== 'hosting.manage'),
        ['owner'],
      ),
    ).toBe(false);
    expect(navPermitted(entry, [], [])).toBe(false);
  });
});
