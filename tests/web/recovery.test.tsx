import type { ReactElement } from 'react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  API_PREFIX,
  BACKUP_ROUTES,
  RECOVERY_CONFIRMATION_PHRASE,
  RECOVERY_ROUTES,
} from '@nexa/contracts';
import { RecoveryPage } from '../../apps/web/src/pages/recovery';
import { NAV, navPermitted, resolve } from '../../apps/web/src/app';
import { renderPage, stubApi } from './harness';

/**
 * The backup and recovery page.
 *
 * What this file covers that the integration suite cannot: what an operator is
 * SHOWN. Three properties in particular, each of which has a named failure in
 * this project's history — a control that exists for a capability the actor does
 * not have, a capability the server offers that the page hides, and a raw
 * exception rendered where a message belongs.
 *
 * Interaction is `fireEvent`, not `@testing-library/user-event`: that package is
 * not a dependency of this workspace, and the rest of this suite drives forms
 * the same way. A file-input change carries `files` because
 * `@testing-library/dom` installs that property specially — an ordinary
 * assignment to `HTMLInputElement.files` would not take.
 */

const route = { path: '/recovery', query: new URLSearchParams() };

const ALL = ['backup.view', 'backup.run', 'backup.download', 'recovery.restore'];

/** The one recovery request every fixture below is a state of. */
const RECOVERY_ID = '01a05e35-c9ad-7e93-bef3-1ed9b55292d9';
const BACKUP_ID = '01a05e35-c9ad-7e93-bef3-1ed9b55292c8';

function run(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: BACKUP_ID,
    trigger: 'SCHEDULED',
    state: 'SUCCEEDED',
    stage: 'CLEANUP',
    startedAt: '2026-09-09T02:00:00.000Z',
    finishedAt: '2026-09-09T02:03:00.000Z',
    dumpBytes: '106875',
    archiveBytes: '107647',
    checksum: 'a'.repeat(64),
    verifiedAt: '2026-09-09T02:02:00.000Z',
    deliveryState: 'SUCCEEDED',
    deliveryAttemptedAt: '2026-09-09T02:03:00.000Z',
    deliveryDetailPresent: false,
    failureCode: null,
    cleanupOk: true,
    cleanupLeftovers: 0,
    archiveAvailable: true,
    ...overrides,
  };
}

function recovery(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RECOVERY_ID,
    source: 'UPLOAD',
    state: 'UPLOADED',
    stage: 'PARSE_CONTAINER',
    createdAt: '2026-09-09T03:00:00.000Z',
    updatedAt: '2026-09-09T03:00:00.000Z',
    requestedBy: 'owner',
    backupId: null,
    artifactChecksum: null,
    failureCode: null,
    correlationId: 'c1',
    upload: { sizeBytes: 107647, archiveSha256: 'b'.repeat(64), clientFilename: 'mine.nxb' },
    verification: null,
    restoreTest: null,
    confirmedAt: null,
    settledAt: null,
    confirmationExpiresAt: null,
    preRestoreBackupId: null,
    cutoverAt: null,
    displacedDatabase: null,
    finishedAt: null,
    ...overrides,
  };
}

const status = (overrides: Record<string, unknown> = {}) => ({
  scheduleEnabled: true,
  intervalMs: 86_400_000,
  lastSucceededAt: '2026-09-09T02:00:00.000Z',
  running: null,
  unknownDeliveries: 0,
  quiesced: false,
  ...overrides,
});

const capabilities = (overrides: Record<string, unknown> = {}) => ({
  uploadEnabled: true,
  maxUploadBytes: 1_048_576,
  foreignInstallationSupported: false,
  confirmationPhrase: RECOVERY_CONFIRMATION_PHRASE,
  confirmationTtlMs: 600_000,
  ...overrides,
});

/**
 * The four reads the page issues on mount.
 *
 * Every URL is absolute and complete, because the harness resolves by LONGEST
 * substring match: registering `/verify` alone would lose to
 * `/api/admin/v1/recoveries`, which is a substring of the verify URL and longer
 * than `/verify`, so the verify POST would be answered with a recovery LIST.
 */
function routes(
  over: {
    status?: Record<string, unknown>;
    runs?: Record<string, unknown>[];
    caps?: Record<string, unknown>;
    recoveries?: Record<string, unknown>[];
  } = {},
) {
  return [
    { url: `${API_PREFIX}${BACKUP_ROUTES.status}`, body: over.status ?? status() },
    {
      url: `${API_PREFIX}${RECOVERY_ROUTES.capabilities}`,
      body: over.caps ?? capabilities(),
    },
    {
      url: `${API_PREFIX}${RECOVERY_ROUTES.list}`,
      body: { recoveries: over.recoveries ?? [], nextCursor: null },
    },
    {
      url: `${API_PREFIX}${BACKUP_ROUTES.history}`,
      body: { runs: over.runs ?? [run()], nextCursor: null },
    },
  ];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the recovery page', () => {
  it('appears in the navigation under سامانه و عملیات', () => {
    const entry = NAV.find((candidate) => candidate.id === 'recovery');
    expect(entry).toBeDefined();
    expect(entry?.path).toBe('/recovery');
    expect(entry?.group).toBe('web.navgroup_system');
    // The label the owner specified, asserted literally so a rename is a
    // deliberate act rather than a silent one.
    expect(entry?.label).toBe('web.nav_recovery');
  });

  it('is hidden from an actor without backup.view and shown to one with it', () => {
    const entry = NAV.find((candidate) => candidate.id === 'recovery');
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(navPermitted(entry, [])).toBe(false);
    expect(navPermitted(entry, ['backup.view'])).toBe(true);
  });

  it('routes /recovery to the page rather than to NotFound', () => {
    const resolved = resolve(route, ALL);
    expect(resolved.title).toBe('بکاپ و بازیابی');
  });

  it('does not activate any Phase 4 placeholder', () => {
    // The remaining planned surfaces stay planned. Asserted here because this
    // branch touched `NAV` and `resolve`, which is exactly where an accidental
    // activation would land — and asserted by RENDERING each path, because a
    // claim about `resolve`'s return value that never mounts it cannot tell a
    // planned page from a live one.
    //
    // `/users` left this list when Phase 4A built it, and `/orders` and `/products`
    // left when Phase 4B did. Each was removed from the LIST rather than from the rule:
    // `planned-and-absent.test.tsx` pins exactly which keys `PLANNED_SURFACES` still
    // holds, so dropping a path here cannot silently deactivate the check for a surface
    // that is still planned.
    stubApi([]);
    for (const path of [
      // `/payments` left this list in 4C and `/services` left it in 4H, the way
      // `/products` and `/orders` left it in 4B: the surface is real. Removed from the
      // LIST rather than from the rule — `planned-and-absent.test.tsx` pins exactly
      // which keys `PLANNED_SURFACES` still holds, so this cannot silently stop
      // checking a surface that is still planned. `/discounts` left in WP8 on the same
      // terms, and `discounts.test.tsx` asserts the live page at that path. `/resellers`
      // left in WP9-B, and `resellers.test.tsx` asserts the live page there. `/reports`
      // left in WP12 and `/bots` in WP13; `reports.test.tsx` and `bots.test.tsx` assert
      // the live pages there. The list is empty until a surface is planned again.
    ]) {
      const resolved = resolve({ path, query: new URLSearchParams() }, ALL);
      const view = renderPage(resolved.element as ReactElement);
      // The planned page's own copy, and nothing an operator could press.
      expect(within(view.container).getByText('چرا هنوز فعال نیست'), path).toBeInTheDocument();
      expect(view.container.querySelectorAll('button, input, select, table, a'), path).toHaveLength(
        0,
      );
      view.unmount();
    }
  });

  it('renders the four sections and the real history', async () => {
    stubApi(routes());
    renderPage(<RecoveryPage route={route} permissions={ALL} />);

    expect(await screen.findByText('وضعیت بکاپ')).toBeInTheDocument();
    // Twice: the card's heading and the table's caption, which is the
    // accessible name screen readers announce for the grid itself.
    expect(screen.getAllByText('تاریخچه بکاپ‌ها')).not.toHaveLength(0);
    expect(screen.getByText('آخرین بکاپ موفق')).toBeInTheDocument();
    expect(screen.getByText('عملیات بازیابی')).toBeInTheDocument();
    // The row came from the stubbed server through the real zod schema.
    expect(await screen.findByText('SUCCEEDED')).toBeInTheDocument();
  });

  it('offers no run button to an actor without backup.run', async () => {
    stubApi(routes());
    renderPage(<RecoveryPage route={route} permissions={['backup.view']} />);
    // Waited for a value the STATUS RESPONSE produced, not for the card heading:
    // the heading is outside the query's state switch and renders before the
    // fetch resolves, so asserting on an empty section proved nothing. Ungating
    // the button survived this test until the wait moved here.
    await screen.findByText('روشن');
    // Not "disabled": absent. A control the server would refuse is a fake
    // control, which is the defect this page's docblock names.
    expect(screen.queryByRole('button', { name: 'تهیه بکاپ جدید' })).toBeNull();
  });

  it('offers the run button to an actor with backup.run, and calls the real endpoint', async () => {
    const api = stubApi([
      ...routes(),
      {
        url: `${API_PREFIX}${BACKUP_ROUTES.run}`,
        body: { outcome: 'COMPLETED', run: run() },
      },
    ]);
    renderPage(<RecoveryPage route={route} permissions={['backup.view', 'backup.run']} />);
    fireEvent.click(await screen.findByRole('button', { name: 'تهیه بکاپ جدید' }));

    await waitFor(() => {
      expect(api.calls.some((call) => call.url.includes(BACKUP_ROUTES.run))).toBe(true);
    });
    const call = api.calls.find((c) => c.url.includes(BACKUP_ROUTES.run));
    expect(call?.method).toBe('POST');
    // The command carries an idempotency key, like every state-changing command.
    expect((call?.body as { idempotencyKey?: string })?.idempotencyKey).toEqual(expect.any(String));
  });

  it('reports BUSY as the invariant working, not as a failure', async () => {
    stubApi([
      ...routes(),
      {
        url: `${API_PREFIX}${BACKUP_ROUTES.run}`,
        body: { outcome: 'BUSY', run: run({ state: 'RUNNING', verifiedAt: null }) },
      },
    ]);
    renderPage(<RecoveryPage route={route} permissions={['backup.view', 'backup.run']} />);
    fireEvent.click(await screen.findByRole('button', { name: 'تهیه بکاپ جدید' }));
    expect(await screen.findByText('یک بکاپ همین حالا در حال اجراست.')).toBeInTheDocument();
  });

  it('offers no download link to an actor without backup.download', async () => {
    stubApi(routes());
    renderPage(<RecoveryPage route={route} permissions={['backup.view']} />);
    // Again a value from the HISTORY response, so the section under test has
    // actually rendered its newest verified run before the absence is asserted.
    // Two matches — the history row's column and the newest-success panel — so
    // `findAll`; the point of the wait is that the data arrived at all.
    await screen.findAllByText('بازگردانی واقعی انجام شد');
    expect(screen.queryByText('دریافت آرشیو رمزشده')).toBeNull();
  });

  it('says the local archive is gone rather than offering a link that fails', async () => {
    stubApi(routes({ runs: [run({ archiveAvailable: false })] }));
    renderPage(<RecoveryPage route={route} permissions={ALL} />);
    // The exact sentence the owner specified — in the history row and again
    // beside the newest verified backup, which is where an operator looks.
    expect(await screen.findAllByText('فایل محلی دیگر موجود نیست')).toHaveLength(2);
    expect(screen.queryByRole('link', { name: 'دریافت آرشیو رمزشده' })).toBeNull();
  });

  it('warns when the schedule is off, because a green history then means nothing', async () => {
    stubApi(routes({ status: status({ scheduleEnabled: false }) }));
    renderPage(<RecoveryPage route={route} permissions={ALL} />);
    expect(
      await screen.findByText(
        'بکاپ خودکار خاموش است. تاریخچه‌ی سالم به‌تنهایی معنایش این نیست که بکاپی گرفته می‌شود.',
      ),
    ).toBeInTheDocument();
  });

  it('renders OUTCOME_UNKNOWN as its own state, never folded into a failure', async () => {
    stubApi(
      routes({
        status: status({ unknownDeliveries: 2 }),
        runs: [run({ deliveryState: 'OUTCOME_UNKNOWN' })],
      }),
    );
    renderPage(<RecoveryPage route={route} permissions={ALL} />);
    expect(await screen.findAllByText('نامعلوم')).not.toHaveLength(0);
    expect(screen.queryByText('ناموفق')).toBeNull();
    expect(
      screen.getByText(
        'تلگرام ممکن است این فایل‌ها را گرفته باشد یا نگرفته باشد. هیچ‌چیز به‌طور خودکار دوباره ارسال نمی‌شود.',
      ),
    ).toBeInTheDocument();
  });

  it('says a cleanup did not complete, because plaintext may still be on disk', async () => {
    stubApi(routes({ runs: [run({ cleanupOk: false, cleanupLeftovers: 2 })] }));
    renderPage(<RecoveryPage route={route} permissions={ALL} />);
    expect(await screen.findByText('پاک‌سازی ناقص')).toBeInTheDocument();
  });

  it('reports the foreign-installation limitation rather than hiding it', async () => {
    stubApi(routes());
    renderPage(<RecoveryPage route={route} permissions={ALL} />);
    expect(await screen.findAllByText('پشتیبانی نمی‌شود')).not.toHaveLength(0);
  });

  it('says upload is disabled when the server says so', async () => {
    stubApi(routes({ caps: capabilities({ uploadEnabled: false }) }));
    renderPage(<RecoveryPage route={route} permissions={ALL} />);
    expect(await screen.findByText('بارگذاری روی این نصب غیرفعال است.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'بارگذاری' })).toBeNull();
  });

  it('shows the quiesce banner and disables the run button while a recovery holds the installation', async () => {
    stubApi(routes({ status: status({ quiesced: true }) }));
    renderPage(<RecoveryPage route={route} permissions={ALL} />);
    expect(
      await screen.findByText('نصب در حال بازیابی است و تغییرات را نمی‌پذیرد.'),
    ).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'تهیه بکاپ جدید' })).toBeDisabled();
  });

  it('renders a server refusal as its message, never as a raw exception', async () => {
    stubApi([
      ...routes(),
      {
        url: `${API_PREFIX}${BACKUP_ROUTES.run}`,
        status: 409,
        body: {
          error: {
            kind: 'conflict',
            code: 'recovery.quiesced',
            message: 'این نصب در حال بازیابی است.',
            correlationId: 'c9',
          },
        },
      },
    ]);
    renderPage(<RecoveryPage route={route} permissions={ALL} />);
    fireEvent.click(await screen.findByRole('button', { name: 'تهیه بکاپ جدید' }));
    expect(await screen.findByText('این نصب در حال بازیابی است.')).toBeInTheDocument();
    // No stack, no code, no `[object Object]`.
    expect(document.body.textContent).not.toContain('TypeError');
    expect(document.body.textContent).not.toContain('at Object');
    expect(document.body.textContent).not.toContain('[object Object]');
  });

  describe('the restore confirmation', () => {
    const tested = recovery({
      state: 'RESTORE_TEST_PASSED',
      stage: 'AWAIT_CONFIRMATION',
      backupId: BACKUP_ID,
      artifactChecksum: 'c'.repeat(64),
      verification: {
        formatVersion: 1,
        backupId: BACKUP_ID,
        keyId: 'held',
        decrypted: true,
        checksumMatches: true,
        databaseName: 'nexa',
        postgresVersion: '16.13',
        pgDumpVersion: 'pg_dump (PostgreSQL) 16.13',
        takenAt: '2026-09-09T02:00:00.000Z',
        dumpBytes: 106875,
        checksum: 'c'.repeat(64),
        exclusions: [],
      },
      restoreTest: {
        restored: true,
        tableCount: 31,
        migrationVerdict: 'CURRENT',
        appliedMigrations: 30,
        expectedMigrations: 30,
        cutoverPermitted: true,
      },
    });

    /** Uploads a file and verifies it, leaving the page at RESTORE_TEST_PASSED. */
    async function reachConfirmation(permissions: readonly string[]) {
      const api = stubApi([
        ...routes(),
        { url: `${API_PREFIX}${RECOVERY_ROUTES.upload}`, body: { recovery: recovery() } },
        {
          url: `${API_PREFIX}${RECOVERY_ROUTES.detail(RECOVERY_ID)}/verify`,
          body: { recovery: tested },
        },
        {
          url: `${API_PREFIX}${RECOVERY_ROUTES.confirm(RECOVERY_ID)}`,
          body: { recovery: { ...tested, state: 'RESTORE_REQUESTED' } },
        },
      ]);
      renderPage(<RecoveryPage route={route} permissions={permissions} />);

      const input = await screen.findByLabelText('انتخاب فایل');
      fireEvent.change(input, {
        target: {
          files: [
            new File([new Uint8Array([1, 2, 3])], 'mine.nxb', {
              type: 'application/octet-stream',
            }),
          ],
        },
      });
      fireEvent.click(screen.getByRole('button', { name: 'بارگذاری' }));
      fireEvent.click(
        await screen.findByRole('button', { name: 'راستی‌آزمایی و آزمون بازگردانی' }),
      );
      await screen.findByText('RESTORE_TEST_PASSED');
      return api;
    }

    /** The phrase field, whose label also carries the phrase itself in an LTR run. */
    const phraseField = () => screen.getByLabelText(/برای تأیید، عبارت زیر را دقیقاً تایپ کنید/);

    it('refuses the restore section to an actor without recovery.restore', async () => {
      await reachConfirmation(['backup.view']);
      expect(
        await screen.findByText(
          'شما اجازه‌ی بازگرداندن این نصب را ندارید. راستی‌آزمایی آرشیو همچنان ممکن است.',
        ),
      ).toBeInTheDocument();
      // The section is PRESENT and refusing, not absent: an operator who can
      // verify but not restore needs to know that is the arrangement.
      expect(screen.queryByRole('button', { name: 'تأیید و شروع بازیابی' })).toBeNull();
    });

    it('keeps the confirm button disabled until the exact phrase is typed', async () => {
      await reachConfirmation(ALL);
      const button = await screen.findByRole('button', { name: 'تأیید و شروع بازیابی' });
      expect(button).toBeDisabled();

      // Lower case is not the phrase. The comparison is the contract's, so this
      // is the same answer the server gives.
      fireEvent.change(phraseField(), { target: { value: 'restore nexa' } });
      expect(button).toBeDisabled();
      expect(screen.getByText('عبارت تأیید مطابقت ندارد.')).toBeInTheDocument();

      fireEvent.change(phraseField(), { target: { value: RECOVERY_CONFIRMATION_PHRASE } });
      expect(button).toBeEnabled();
      expect(screen.queryByText('عبارت تأیید مطابقت ندارد.')).toBeNull();
    });

    it('sends the artifact checksum with the confirmation, so it is bound', async () => {
      const api = await reachConfirmation(ALL);
      fireEvent.change(phraseField(), { target: { value: RECOVERY_CONFIRMATION_PHRASE } });
      fireEvent.click(screen.getByRole('button', { name: 'تأیید و شروع بازیابی' }));

      await waitFor(() => {
        expect(api.calls.some((call) => call.url.includes('/confirm'))).toBe(true);
      });
      const call = api.calls.find((c) => c.url.includes('/confirm'));
      const body = call?.body as { phrase?: string; artifactChecksum?: string };
      expect(body.phrase).toBe(RECOVERY_CONFIRMATION_PHRASE);
      // THE BINDING. Without this the confirmation says "restore something".
      expect(body.artifactChecksum).toBe('c'.repeat(64));
    });

    it('shows the restore-test evidence an operator has to read before confirming', async () => {
      await reachConfirmation(ALL);
      // The migration verdict and the source database. Not "it worked".
      expect(await screen.findByText('CURRENT')).toBeInTheDocument();
      expect(screen.getByText('nexa')).toBeInTheDocument();
    });
  });

  it('renders no secret anywhere on the page', async () => {
    stubApi(
      routes({
        recoveries: [
          recovery({
            state: 'SUCCEEDED',
            cutoverAt: '2026-09-09T04:00:00.000Z',
            displacedDatabase: 'nexa_pre_restore_01a05e35c9ad',
            finishedAt: '2026-09-09T04:00:00.000Z',
          }),
        ],
      }),
    );
    const { container } = renderPage(<RecoveryPage route={route} permissions={ALL} />);
    await screen.findByText('وضعیت بکاپ');
    await screen.findByText('nexa_pre_restore_01a05e35c9ad');
    const text = container.textContent ?? '';
    // Nothing that looks like key material, a connection string or a token.
    for (const needle of ['SECRETS_KEK', 'postgres://', 'PGPASSWORD', 'BEGIN ', ':nexa@']) {
      expect(text, needle).not.toContain(needle);
    }
    // The displaced database name IS shown: it is not a secret, and it is the
    // one fact an operator needs after a cutover — the outgoing database is
    // kept, and nothing drops it.
    expect(text).toContain('nexa_pre_restore_01a05e35c9ad');
  });
});
