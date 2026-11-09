import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  API_PREFIX,
  HOSTED_BACKUP_ROUTES,
  type HostedBackupResponse,
  type HostedBotView,
  type PermissionKey,
} from '@nexa/contracts';
import { BackupRoutePage } from '../../apps/web/src/pages/hosted-own-backup';
import { HostedBackupSection } from '../../apps/web/src/pages/hosting-backup';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * Phase 6B PR-2 (ADR-0039 § 7): the bot card's backups in «میزبانی‌ها» — the password and «بکاپ
 * الان» behind a code, the archives listed — and the hosted bot's own page, which says the host
 * manages backups and never asks for the installation's.
 */

afterEach(() => vi.unstubAllGlobals());

const url = (path: string) => `${API_PREFIX}${path}`;
const TENANT = '01a05e35-c9ad-7e93-bef3-1ed9b55292c8';
const RUN = '01a05e35-c9ad-7e93-bef3-1ed9b55292d1';
const ROUTE = (template: string) => url(template.replace(':tenantId', TENANT));

function response(overrides: Partial<HostedBackupResponse['policy']> = {}): HostedBackupResponse {
  return {
    tenantId: TENANT,
    policy: {
      enabled: true,
      dailyTime: '04:30',
      keep: 7,
      passwordSetAt: null,
      runRequestedAt: null,
      ...overrides,
    },
    archives: [
      {
        id: RUN,
        state: 'SUCCEEDED',
        trigger: 'SCHEDULED',
        startedAt: '2026-11-08T01:00:00.000Z',
        finishedAt: '2026-11-08T01:02:00.000Z',
        verifiedAt: '2026-11-08T01:02:00.000Z',
        archiveBytes: '1048576',
        deliveryState: 'NOT_ATTEMPTED',
        failureCode: null,
        available: true,
      },
    ],
  };
}

const bot = { tenantId: TENANT, displayName: 'آکمه', state: 'ACTIVE' } as HostedBotView;

describe('a hosted bot’s backups in «میزبانی‌ها»', () => {
  it('with no password: says so, keeps «بکاپ الان» off, and sets one behind a code', async () => {
    const api = stubApi([
      { url: ROUTE(HOSTED_BACKUP_ROUTES.bot), method: 'GET', body: response() },
      {
        url: ROUTE(HOSTED_BACKUP_ROUTES.password),
        method: 'POST',
        body: response({ passwordSetAt: '2026-11-09T00:00:00.000Z' }),
      },
    ]);
    renderPage(<HostedBackupSection bot={bot} />);
    expect(await screen.findByText(t('web.hosted_backup_password_none'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('web.hosted_backup_run_now') })).toBeDisabled();
    expect(screen.getByText(t('web.hosted_backup_status_ok'))).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: t('web.hosted_backup_password_set') }));
    fireEvent.change(screen.getByLabelText(t('web.hosted_backup_password_field')), {
      target: { value: 'a long hosted password' },
    });
    fireEvent.change(screen.getByLabelText(t('web.hosted_backup_password_repeat')), {
      target: { value: 'a long hosted password' },
    });
    fireEvent.change(screen.getByLabelText(t('web.hosting_code_label')), {
      target: { value: '123456' },
    });
    const dialogButtons = screen.getAllByRole('button', {
      name: t('web.hosted_backup_password_set'),
    });
    fireEvent.click(dialogButtons[dialogButtons.length - 1]!);
    await waitFor(() =>
      expect(
        api.calls.filter((call) => call.method === 'POST' && call.url.endsWith('/backup/password')),
      ).toHaveLength(1),
    );
    const sent = api.calls.find((call) => call.url.endsWith('/backup/password'))?.body as {
      password: string;
      proof: { code: string };
      idempotencyKey: string;
    };
    expect(sent.password).toBe('a long hosted password');
    expect(sent.proof).toEqual({ code: '123456' });
    expect(sent.idempotencyKey.length).toBeGreaterThanOrEqual(8);
  });

  it('«بازیابی روی همین سرور»: an archive row dry-runs a replace of the same bot behind a code', async () => {
    const restoreHere = url(
      HOSTED_BACKUP_ROUTES.restoreHere.replace(':tenantId', TENANT).replace(':runId', RUN),
    );
    const api = stubApi([
      { url: ROUTE(HOSTED_BACKUP_ROUTES.bot), method: 'GET', body: response() },
      {
        url: restoreHere,
        method: 'POST',
        body: {
          id: RUN,
          state: 'VERIFIED',
          stage: 'PREFLIGHT',
          hostedTenantId: TENANT,
          mode: 'REPLACE',
          preReplaceRunId: null,
          slug: 'acme',
          head: 'EQUAL',
          counts: {},
          failureCode: null,
          createdAt: '2026-11-09T00:00:00.000Z',
          confirmRequestedAt: null,
          finishedAt: null,
        },
      },
    ]);
    renderPage(<HostedBackupSection bot={bot} />);
    fireEvent.click(
      await screen.findByRole('button', { name: t('web.hosted_backup_restore_here') }),
    );
    expect(screen.getByText(t('web.hosted_backup_restore_here_hint'))).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(t('web.hosted_backup_restore_here_password')), {
      target: { value: 'the archive password' },
    });
    fireEvent.change(screen.getByLabelText(t('web.hosting_code_label')), {
      target: { value: '654321' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('web.hosted_restore_dry_run') }));
    await waitFor(() =>
      expect(api.calls.filter((call) => call.url === restoreHere)).toHaveLength(1),
    );
    expect(api.calls.find((call) => call.url === restoreHere)?.body).toEqual({
      proof: { code: '654321' },
      password: 'the archive password',
    });
  });

  it('a purged bot offers no «بازیابی روی همین سرور»', async () => {
    stubApi([{ url: ROUTE(HOSTED_BACKUP_ROUTES.bot), method: 'GET', body: response() }]);
    renderPage(<HostedBackupSection bot={{ ...bot, state: 'PURGED' } as HostedBotView} />);
    expect(await screen.findByText(t('web.hosted_backup_status_ok'))).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: t('web.hosted_backup_restore_here') }),
    ).not.toBeInTheDocument();
  });
});

describe('the backup page of a hosted bot’s own Web Admin', () => {
  it('says the host manages backups, with the last backup’s time, and asks for nothing else', async () => {
    const api = stubApi([
      {
        url: url(HOSTED_BACKUP_ROUTES.own),
        body: { managedByHost: true, enabled: true, lastBackupAt: '2026-11-08T01:02:00.000Z' },
      },
    ]);
    const permissions: PermissionKey[] = ['backup.view'];
    renderPage(
      <BackupRoutePage route={{ path: '/recovery' } as never} permissions={permissions} />,
    );
    expect(await screen.findByText(t('web.hosted_own_backup_body'))).toBeInTheDocument();
    expect(screen.getByText(t('web.hosted_own_backup_last'))).toBeInTheDocument();
    expect(api.calls.map((call) => call.url)).toEqual([url(HOSTED_BACKUP_ROUTES.own)]);
  });

  it('an installation session never asks for the hosted view', () => {
    const api = stubApi([]);
    const permissions: PermissionKey[] = ['backup.view', 'backup.download'];
    renderPage(
      <BackupRoutePage
        route={{ path: '/recovery', query: new URLSearchParams() } as never}
        permissions={permissions}
      />,
    );
    expect(api.calls.map((call) => call.url)).not.toContain(url(HOSTED_BACKUP_ROUTES.own));
  });
});
