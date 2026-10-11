import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { LEGACY_MIGRATION_APPROVAL_PHRASE } from '@nexa/contracts';
import { LegacyMigrationPage, stepMarks } from '../../apps/web/src/pages/legacy-migration';
import { t } from '../../apps/web/src/i18n/web.fa';
import { NAV, navPermitted, resolve } from '../../apps/web/src/app';
import { panel, renderPage, stubApi } from './harness';

/**
 * Mirza `.nxpkg` importer — «مهاجرت از میرزا». Fixtures go through the real API client and
 * the contract's schemas.
 *
 * What this file defends: the page says nothing is deleted or provisioned; with the flag off
 * it offers nothing; the key is write-only (the body carries it once, the page never shows
 * it back); only ACTIVE RickPanels are offered as panel targets, by name; the approval stays
 * disabled until the exact phrase is typed and sends the digest the page SHOWED; without
 * `legacy.migration.apply` nothing approves; a production-like target links the cutover
 * approval; the stepper marks a failed step; the route and nav entry are gated on
 * `legacy.migration.view`.
 */

const H = (c: string) => c.repeat(64);
const ID = '019600ab-cdef-7012-8345-6789abcd0301';
const RICK = '019600ab-cdef-7012-8345-6789abcd0401';
const PASSPHRASE = 'the passphrase typed once';

const capabilities = (overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  maxUploadBytes: 1024 * 1024,
  maxDecisionsBytes: 1024,
  approvalPhrase: LEGACY_MIGRATION_APPROVAL_PHRASE,
  productionLikeTarget: false,
  targetAcknowledgement: null,
  ...overrides,
});

const progress = {
  phase: null,
  applyAttempts: 0,
  verifyAttempts: 0,
  dryRunAttempts: 0,
  importerVerdict: null,
  reconcileVerdict: null,
  history: [],
  refusalCounts: [],
  backup: null,
  blocker: null,
};

const verifyReport = {
  packageImportId: 'pkg-1',
  sourceFingerprint: H('a'),
  packageSchemaVersion: '1.4.0',
  converterVersion: '0.5.0',
  synthetic: false,
  panelTargets: [{ codePanel: 'P1', providerType: 'rickpanel', services: 3 }],
  recordCounts: [{ code: 'user', count: 10 }],
  decisions: null,
};

const dryRunReport = {
  importerVerdict: 'READY',
  sections: [
    { section: 'customers', source: 10, imported: 9, archived: 0, skipped: 1, quarantined: 0 },
  ],
  warnings: [{ code: 'TRIAL_CONSUMED', count: 2 }],
  quarantine: [],
  wallets: { currency: 'IRT', customers: 9, beforeTotalMinor: '0', afterTotalMinor: '1200' },
  debts: { currency: 'IRT', count: 1, totalMinor: '-300' },
  ownership: {
    decisionsProvided: false,
    proven: 3,
    adminApprovedUnverified: 0,
    quarantined: 0,
    rejected: 0,
    pending: 0,
    stale: 0,
  },
  cutover: {
    sourceFingerprint: 'a'.repeat(64),
    panelMapFingerprint: 'b'.repeat(64),
    inventoryFingerprint: 'c'.repeat(64),
    productsFingerprint: 'd'.repeat(64),
    invoiceArchiveFingerprint: 'e'.repeat(64),
    freezeProofSha256: 'f'.repeat(64),
    finalDumpSha256: '1'.repeat(64),
  },
  planTalliesDigest: '2'.repeat(64),
};

const view = (overrides: Record<string, unknown> = {}) => ({
  id: ID,
  status: 'UPLOADED',
  errorCode: null,
  fileName: 'mirza.nxpkg',
  fileSha256: H('f'),
  fileBytes: '1500',
  packageImportId: null,
  packageSourceFingerprint: null,
  packageSchemaVersion: null,
  converterVersion: null,
  keyPresent: false,
  keyKind: null,
  decisionsPresent: false,
  panelBindings: null,
  verifyReport: null,
  dryRunReport: null,
  dryRunSha256: null,
  approvedDryRunSha256: null,
  applyReport: null,
  dryRunLegacyRunId: null,
  applyLegacyRunId: null,
  backupRunId: null,
  progress,
  working: false,
  requestedByAdminId: '019600ab-cdef-7012-8345-6789abcd0201',
  approvedByAdminId: null,
  approvedAt: null,
  createdAt: '2026-10-10T09:00:00.000Z',
  updatedAt: '2026-10-10T09:00:00.000Z',
  finishedAt: null,
  ...overrides,
});

function page(
  row: Record<string, unknown> | null,
  options: {
    mayManage?: boolean;
    mayApply?: boolean;
    capabilities?: Record<string, unknown>;
  } = {},
) {
  const api = stubApi([
    { url: '/legacy-migration/capabilities', body: capabilities(options.capabilities) },
    {
      url: '/legacy-migration/imports',
      method: 'GET',
      body: { imports: row === null ? [] : [row], nextCursor: null },
    },
    {
      url: '/panels',
      method: 'GET',
      body: {
        panels: [
          panel({
            id: RICK,
            name: 'Rick Tehran',
            providerType: 'rickpanel',
            providerName: 'RickPanel',
          }),
          panel({
            id: '019600ab-cdef-7012-8345-6789abcd0402',
            name: 'Rick Disabled',
            providerType: 'rickpanel',
            status: 'DISABLED',
          }),
          panel({ id: '019600ab-cdef-7012-8345-6789abcd0403', name: 'Marzban Frankfurt' }),
        ],
        nextCursor: null,
      },
    },
    {
      url: `/legacy-migration/imports/${ID}/key`,
      method: 'POST',
      body: { import: view({ keyPresent: true }) },
    },
    {
      url: `/legacy-migration/imports/${ID}/panel-bindings`,
      method: 'POST',
      body: { import: view() },
    },
    {
      url: `/legacy-migration/imports/${ID}/approve`,
      method: 'POST',
      body: { import: view({ status: 'APPROVED' }) },
    },
  ]);
  renderPage(
    <LegacyMigrationPage
      denied={false}
      mayManage={options.mayManage ?? true}
      mayApply={options.mayApply ?? true}
      mayViewPanels
    />,
  );
  return api;
}

describe('the legacy migration page', () => {
  it('says the migration is fresh-only and offers the upload when nothing is in progress', async () => {
    const api = page(null);
    expect(await screen.findByText(t('web.lmg_banner'))).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: t('web.lmg_upload_send') })).toBeDisabled();
    expect(api.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('offers nothing while the server has the feature off', async () => {
    const api = page(null, { capabilities: { enabled: false } });
    expect(await screen.findByText(t('web.lmg_disabled'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('web.lmg_upload_send') })).toBeNull();
    expect(api.calls.some((c) => c.url.includes('/legacy-migration/imports'))).toBe(false);
  });

  it('sends the passphrase once and never shows it back', async () => {
    const api = page(view());
    const input = await screen.findByLabelText(t('web.lmg_key_kind'));
    fireEvent.change(input, { target: { value: 'PASSPHRASE' } });
    fireEvent.change(screen.getByLabelText(t('web.lmg_passphrase')), {
      target: { value: PASSPHRASE },
    });
    fireEvent.click(screen.getByRole('button', { name: t('web.lmg_key_save') }));
    await waitFor(() =>
      expect(api.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/key'))).toHaveLength(
        1,
      ),
    );
    const sent = api.calls.find((c) => c.url.endsWith('/key'))?.body as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(['idempotencyKey', 'passphrase']);
    expect(sent['passphrase']).toBe(PASSPHRASE);
    // The idempotency key is not derived from the secret.
    expect(String(sent['idempotencyKey'])).not.toContain(PASSPHRASE);
    await waitFor(() => expect(document.body.textContent ?? '').not.toContain(PASSPHRASE));
  });

  it('asks for the key again after the server erased an idle one', async () => {
    const api = page(
      view({
        status: 'DRY_RUN_DONE',
        keyPresent: false,
        keyKind: 'KEY_FILE',
        verifyReport,
        dryRunReport,
        dryRunSha256: H('d'),
      }),
    );
    expect(await screen.findByText(t('web.lmg_key_expired'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('web.lmg_key_save') })).toBeInTheDocument();
    // No dry run is offered without the key.
    expect(screen.queryByRole('button', { name: t('web.lmg_dry_run_again') })).toBeNull();
    expect(api.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('offers only ACTIVE RickPanels, by name, for each package panel', async () => {
    const api = page(
      view({ status: 'VERIFIED', keyPresent: true, keyKind: 'KEY_FILE', verifyReport }),
    );
    const select = await screen.findByLabelText(`${t('web.lmg_col_nexa_panel')} P1`);
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Rick Tehran' })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('option', { name: 'Rick Disabled' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Marzban Frankfurt' })).toBeNull();
    // The dry run waits for the bindings.
    expect(screen.getByRole('button', { name: t('web.lmg_dry_run_request') })).toBeDisabled();
    fireEvent.change(select, { target: { value: RICK } });
    fireEvent.click(screen.getByRole('button', { name: t('web.lmg_panels_save') }));
    await waitFor(() =>
      expect(api.calls.filter((c) => c.url.endsWith('/panel-bindings'))).toHaveLength(1),
    );
    expect(api.calls.find((c) => c.url.endsWith('/panel-bindings'))?.body).toMatchObject({
      bindings: [{ codePanel: 'P1', panelId: RICK }],
    });
  });

  it('approves only with the exact phrase, binding the digest the page showed', async () => {
    const digest = H('d');
    const api = page(
      view({
        status: 'DRY_RUN_DONE',
        keyPresent: true,
        verifyReport,
        dryRunReport,
        dryRunSha256: digest,
        panelBindings: [{ codePanel: 'P1', panelId: RICK }],
      }),
    );
    const button = await screen.findByRole('button', { name: t('web.lmg_approve') });
    expect(screen.getByText(t('web.lmg_wallet_after'))).toBeInTheDocument();
    const field = screen.getByLabelText(
      t('web.lmg_approval_phrase').replace('{phrase}', LEGACY_MIGRATION_APPROVAL_PHRASE),
    );
    fireEvent.change(field, { target: { value: LEGACY_MIGRATION_APPROVAL_PHRASE.toLowerCase() } });
    expect(button).toBeDisabled();
    fireEvent.change(field, { target: { value: LEGACY_MIGRATION_APPROVAL_PHRASE } });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() =>
      expect(api.calls.filter((c) => c.url.endsWith('/approve'))).toHaveLength(1),
    );
    expect(api.calls.find((c) => c.url.endsWith('/approve'))?.body).toMatchObject({
      dryRunSha256: digest,
      confirmation: LEGACY_MIGRATION_APPROVAL_PHRASE,
    });
  });

  it('without legacy.migration.apply nothing approves; a production-like target links the cutover approval', async () => {
    const api = page(
      view({
        status: 'DRY_RUN_DONE',
        keyPresent: true,
        verifyReport,
        dryRunReport,
        dryRunSha256: H('d'),
      }),
      { mayApply: false, capabilities: { productionLikeTarget: true } },
    );
    expect(await screen.findByText(t('web.lmg_approval_owner_only'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('web.lmg_approve') })).toBeNull();
    expect(screen.getByRole('link', { name: t('web.lmg_cutover_link') })).toHaveAttribute(
      'href',
      '/legacy-cutover',
    );
    expect(api.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('names what a production-like import waits for: the ack env line and the seven values to approve', async () => {
    page(
      view({
        status: 'APPROVED',
        keyPresent: true,
        verifyReport,
        dryRunReport,
        dryRunSha256: H('d'),
        approvedDryRunSha256: H('d'),
        approvedAt: '2026-10-10T09:10:00.000Z',
        approvedByAdminId: '019600ab-cdef-7012-8345-6789abcd0201',
        progress: { ...progress, blocker: 'CUTOVER_APPROVAL_MISSING' },
      }),
      { capabilities: { productionLikeTarget: true, targetAcknowledgement: '0123456789abcdef' } },
    );
    expect((await screen.findAllByText(t('web.lmg_blocker_approval'))).length).toBeGreaterThan(0);
    expect(
      screen.getAllByText('NEXA_LEGACY_IMPORT_TARGET_ACK=0123456789abcdef').length,
    ).toBeGreaterThan(0);
    // The seven values, exactly as the dry run recorded them, to copy into /legacy-cutover.
    for (const value of Object.values(dryRunReport.cutover)) {
      expect(screen.getAllByText(value).length).toBeGreaterThan(0);
    }
  });

  it('marks the failed step and names the reason', async () => {
    page(
      view({
        status: 'VERIFY_FAILED',
        errorCode: 'NXPKG_WRONG_KEY',
        finishedAt: '2026-10-10T09:05:00.000Z',
      }),
    );
    expect(await screen.findByText(t('web.lmg_error_wrong_key'))).toBeInTheDocument();
    expect(stepMarks(view({ status: 'VERIFY_FAILED' }) as never)).toEqual([
      'done',
      'failed',
      'todo',
      'todo',
      'todo',
      'todo',
      'todo',
      'todo',
    ]);
    expect(stepMarks(view({ status: 'APPLYING' }) as never)[6]).toBe('current');
    expect(stepMarks(view({ status: 'COMPLETED' }) as never).every((m) => m === 'done')).toBe(true);
  });
});

describe('the route and the nav entry', () => {
  it('is gated on legacy.migration.view, which an observer (LOW keys) does not hold', () => {
    const entry = NAV.find((candidate) => candidate.path === '/legacy-migration');
    expect(entry).toMatchObject({ permission: 'legacy.migration.view' });
    expect(navPermitted(entry!, ['legacy.migration.view'])).toBe(true);
    expect(navPermitted(entry!, ['legacy.cutover.view', 'orders.view'])).toBe(false);
    const route = { path: '/legacy-migration', query: new URLSearchParams() };
    expect(resolve(route, ['legacy.migration.view']).title).toBe(t('web.lmg_title'));
  });
});
