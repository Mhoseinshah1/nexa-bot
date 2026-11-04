import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import {
  API_PREFIX,
  BACKUP_ROUTES,
  LEGACY_MIGRATION_APPROVAL_PHRASE,
  LEGACY_MIGRATION_PROVIDER_INVENTORY_CHURN,
  LEGACY_MIGRATION_PROVIDER_INVENTORY_UNRESOLVED,
  RECOVERY_CONFIRMATION_PHRASE,
  RECOVERY_KIT_ROUTES,
  RECOVERY_ROUTES,
  type PermissionKey,
} from '@nexa/contracts';
import { RecoveryPage } from '../../apps/web/src/pages/recovery';
import {
  RESTART_AFTER_IMPORT_COMMAND,
  mirzaStepMarks,
  runStage,
} from '../../apps/web/src/pages/recovery-mirza';
import { t } from '../../apps/web/src/i18n/web.fa';
import { formatNumber } from '../../apps/web/src/format';
import { NAV, ROUTE_PATTERNS, resolve } from '../../apps/web/src/app';
import { MIRZA_PACKAGE_BYTES, NEXA_ARCHIVE_BYTES, panel, renderPage, stubApi } from './harness';

/**
 * Restore from Mirza — the second source of «بکاپ و بازیابی ← عملیات بازیابی» (Phase 7).
 * Fixtures go through the real API client and the contract's schemas; every value is
 * synthetic.
 *
 * What this file defends: the file's FIRST BYTES pick the path — a NEXA archive takes the
 * existing restore unchanged, a converter package takes the Mirza flow, anything else is
 * refused before a byte is uploaded; the key is write-only; exactly one ACTIVE RickPanel is
 * preselected and saving the bindings requests the dry run by itself; the dry-run report shows
 * every section (`table:` and `history:` included), the money and the ownership; the
 * confirmation stays disabled until the exact phrase and sends the digest, the phrase and the
 * installation's target acknowledgement — and nothing else; the run shows the protective
 * backup first and the result names it; a failure says why in words; the old page's route
 * redirects here and its nav entry is gone.
 */

const H = (c: string) => c.repeat(64);
const ID = '019600ab-cdef-7012-8345-6789abcd0301';
const OLD_ID = '019600ab-cdef-7012-8345-6789abcd0300';
const RICK = '019600ab-cdef-7012-8345-6789abcd0401';
const RICK_2 = '019600ab-cdef-7012-8345-6789abcd0404';
const PROTECTIVE = '019600ab-cdef-7012-8345-6789abcd0501';
const AFTER_BACKUP = '019600ab-cdef-7012-8345-6789abcd0502';
const RECOVERY_ID = '01a05e35-c9ad-7e93-bef3-1ed9b55292d9';
const PASSPHRASE = 'the passphrase typed once';
const ACK = '0123456789abcdef';

const MIRZA_ALL: PermissionKey[] = [
  'backup.view',
  'recovery.restore',
  'legacy.migration.view',
  'legacy.migration.manage',
  'legacy.migration.apply',
  'panels.view',
];

const route = { path: '/recovery', query: new URLSearchParams() };

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
  adoptAttempts: 0,
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
  synthetic: true,
  panelTargets: [{ codePanel: 'P1', providerType: 'rickpanel', services: 3 }],
  recordCounts: [{ code: 'user', count: 10 }],
  decisions: null,
};

const dryRunReport = {
  importerVerdict: 'READY',
  sections: [
    { section: 'customers', source: 10, imported: 9, archived: 0, skipped: 1, quarantined: 0 },
    { section: 'table:user', source: 10, imported: 9, archived: 0, skipped: 1, quarantined: 0 },
    { section: 'history:payment', source: 4, imported: 0, archived: 4, skipped: 0, quarantined: 0 },
  ],
  warnings: [{ code: 'TRIAL_CONSUMED', count: 2 }],
  quarantine: [{ code: 'SERVICE_OWNER_UNPROVEN', count: 1 }],
  wallets: { currency: 'IRT', customers: 9, beforeTotalMinor: '0', afterTotalMinor: '1200' },
  debts: { currency: 'IRT', count: 1, totalMinor: '-300' },
  ownership: {
    decisionsProvided: false,
    proven: 3,
    adminApprovedUnverified: 0,
    quarantined: 1,
    rejected: 0,
    pending: 0,
    stale: 0,
  },
  cutover: {
    sourceFingerprint: H('a'),
    panelMapFingerprint: H('b'),
    inventoryFingerprint: H('c'),
    productsFingerprint: H('d'),
    invoiceArchiveFingerprint: H('e'),
    freezeProofSha256: H('f'),
    finalDumpSha256: H('1'),
  },
  planTalliesDigest: H('2'),
};

const applyReport = {
  importerVerdict: 'APPLIED',
  reconcileVerdict: 'RECONCILED',
  reportHolds: true,
  failedInvariants: [],
  failedSections: [],
  sections: dryRunReport.sections,
  history: [{ code: 'payment', count: 4 }],
};

const view = (overrides: Record<string, unknown> = {}) => ({
  id: ID,
  status: 'UPLOADED',
  errorCode: null,
  fileName: 'nexa-restore-mirza-2026-10-11.nxpkg',
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
  adoptReport: null,
  dryRunLegacyRunId: null,
  applyLegacyRunId: null,
  adoptLegacyRunId: null,
  backupRunId: null,
  preImportBackupRunId: null,
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

const reviewed = (overrides: Record<string, unknown> = {}) =>
  view({
    status: 'DRY_RUN_DONE',
    keyPresent: true,
    keyKind: 'PASSPHRASE',
    verifyReport,
    dryRunReport,
    dryRunSha256: H('d'),
    panelBindings: [{ codePanel: 'P1', panelId: RICK }],
    ...overrides,
  });

const approved = (overrides: Record<string, unknown> = {}) =>
  reviewed({
    approvedDryRunSha256: H('d'),
    approvedAt: '2026-10-10T09:10:00.000Z',
    approvedByAdminId: '019600ab-cdef-7012-8345-6789abcd0201',
    ...overrides,
  });

const ACTIVE_RICK = panel({
  id: RICK,
  name: 'Rick Tehran',
  providerType: 'rickpanel',
  providerName: 'RickPanel',
});
const OTHER_PANELS = [
  panel({
    id: '019600ab-cdef-7012-8345-6789abcd0402',
    name: 'Rick Disabled',
    providerType: 'rickpanel',
    status: 'DISABLED',
  }),
  panel({ id: '019600ab-cdef-7012-8345-6789abcd0403', name: 'Marzban Frankfurt' }),
];

type Extra = { url: string; method?: string; status?: number; body: unknown };

/** The recovery page's own reads, the Mirza reads, and whatever a test adds. */
function page(
  rows: readonly Record<string, unknown>[],
  options: {
    permissions?: readonly PermissionKey[];
    capabilities?: Record<string, unknown>;
    panels?: readonly Record<string, unknown>[];
    extra?: readonly Extra[];
  } = {},
) {
  const api = stubApi([
    { url: `${API_PREFIX}${RECOVERY_KIT_ROUTES.keys}`, body: { keys: [] } },
    {
      url: `${API_PREFIX}${BACKUP_ROUTES.status}`,
      body: {
        scheduleEnabled: true,
        intervalMs: 86_400_000,
        dailyTime: null,
        scheduleSource: { enabled: 'SETTING', interval: 'SETTING', dailyTime: 'ENVIRONMENT' },
        deliveryDestination: 'OPS_GROUP_TOPIC',
        lastSucceededAt: null,
        running: null,
        unknownDeliveries: 0,
        quiesced: false,
        archivePassword: { configured: false, setAt: null },
      },
    },
    {
      url: `${API_PREFIX}${RECOVERY_ROUTES.capabilities}`,
      body: {
        uploadEnabled: true,
        maxUploadBytes: 1_048_576,
        foreignInstallationSupported: true,
        confirmationPhrase: RECOVERY_CONFIRMATION_PHRASE,
        confirmationTtlMs: 600_000,
      },
    },
    {
      url: `${API_PREFIX}${RECOVERY_ROUTES.list}`,
      method: 'GET',
      body: { recoveries: [], nextCursor: null },
    },
    { url: `${API_PREFIX}${BACKUP_ROUTES.history}`, body: { runs: [], nextCursor: null } },
    { url: '/legacy-migration/capabilities', body: capabilities(options.capabilities) },
    {
      url: '/legacy-migration/imports',
      method: 'GET',
      body: { imports: rows, nextCursor: null },
    },
    {
      url: '/panels',
      method: 'GET',
      body: { panels: options.panels ?? [ACTIVE_RICK, ...OTHER_PANELS], nextCursor: null },
    },
    {
      url: '/legacy-migration/imports/upload',
      method: 'POST',
      body: { import: view() },
    },
    ...(options.extra ?? []),
  ]);
  renderPage(<RecoveryPage route={route} permissions={options.permissions ?? MIRZA_ALL} />);
  return api;
}

const posts = (api: { calls: { url: string; method: string; body: unknown }[] }) =>
  api.calls.filter((call) => call.method !== 'GET');

async function choose(bytes: Uint8Array, name: string): Promise<void> {
  fireEvent.change(await screen.findByLabelText(t('web.recovery_upload_choose')), {
    target: {
      files: [new File([bytes as unknown as BlobPart], name, { type: 'application/octet-stream' })],
    },
  });
}

/** The upload is offered once the file's first bytes have been read. */
async function send(): Promise<void> {
  const button = screen.getByRole('button', { name: t('web.recovery_upload_send') });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('choosing a file on the restore card', () => {
  it('takes a NEXA archive down the existing restore, unchanged', async () => {
    const api = page([], {
      extra: [
        {
          url: `${API_PREFIX}${RECOVERY_ROUTES.upload}`,
          method: 'POST',
          body: {
            recovery: {
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
              upload: { sizeBytes: 11, archiveSha256: H('b'), clientFilename: 'mine.nxb' },
              verification: null,
              restoreTest: null,
              confirmedAt: null,
              settledAt: null,
              confirmationExpiresAt: null,
              preRestoreBackupId: null,
              cutoverAt: null,
              displacedDatabase: null,
              finishedAt: null,
            },
          },
        },
      ],
    });
    await choose(NEXA_ARCHIVE_BYTES, 'mine.nxb');
    expect(await screen.findByText(t('web.recovery_file_nexa'))).toBeInTheDocument();
    await send();
    expect(
      await screen.findByRole('button', { name: t('web.recovery_verify') }),
    ).toBeInTheDocument();
    expect(posts(api).map((call) => call.url)).toEqual([`${API_PREFIX}${RECOVERY_ROUTES.upload}`]);
    expect(screen.queryByText(t('web.lmg_banner'))).toBeNull();
  });

  it('takes a converter package down the Mirza flow, by its bytes and not its name', async () => {
    const api = page([]);
    // Named .nxb on purpose: the magic decides, never the extension.
    await choose(MIRZA_PACKAGE_BYTES, 'renamed.nxb');
    expect(await screen.findByText(t('web.recovery_file_mirza'))).toBeInTheDocument();
    expect(screen.getByText(t('web.lmg_banner'))).toBeInTheDocument();
    await send();
    expect(await screen.findByRole('button', { name: t('web.lmg_key_save') })).toBeInTheDocument();
    expect(posts(api).map((call) => call.url)).toEqual([
      `${API_PREFIX}/legacy-migration/imports/upload`,
    ]);
    expect(screen.getByRole('list', { name: t('web.mrz_steps_label') })).toBeInTheDocument();
  });

  it('refuses a file that is neither, before anything is uploaded', async () => {
    const api = page([]);
    await choose(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]), 'backup.zip');
    expect(await screen.findByText(t('web.recovery_file_unknown'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('web.recovery_upload_send') })).toBeDisabled();
    expect(posts(api)).toEqual([]);
  });

  it('refuses a converter package to an actor without legacy.migration.manage', async () => {
    const api = page([], { permissions: ['backup.view', 'legacy.migration.view'] });
    await choose(MIRZA_PACKAGE_BYTES, 'restore.nxpkg');
    expect(await screen.findByText(t('web.mrz_no_permission'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('web.recovery_upload_send') })).toBeDisabled();
    expect(posts(api)).toEqual([]);
  });
});

describe('the Mirza review', () => {
  it('sends the passphrase once and never shows it back', async () => {
    const api = page([view()], {
      extra: [
        {
          url: `/legacy-migration/imports/${ID}/key`,
          method: 'POST',
          body: { import: view({ keyPresent: true, keyKind: 'PASSPHRASE' }) },
        },
      ],
    });
    fireEvent.change(await screen.findByLabelText(t('web.lmg_key_kind')), {
      target: { value: 'PASSPHRASE' },
    });
    fireEvent.change(screen.getByLabelText(t('web.lmg_passphrase')), {
      target: { value: PASSPHRASE },
    });
    fireEvent.click(screen.getByRole('button', { name: t('web.lmg_key_save') }));
    await waitFor(() => expect(posts(api)).toHaveLength(1));
    const sent = posts(api)[0]?.body as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(['idempotencyKey', 'passphrase']);
    expect(sent['passphrase']).toBe(PASSPHRASE);
    expect(String(sent['idempotencyKey'])).not.toContain(PASSPHRASE);
    await waitFor(() => expect(document.body.textContent ?? '').not.toContain(PASSPHRASE));
  });

  it('asks for the key again after the server erased an idle one', async () => {
    const api = page([reviewed({ keyPresent: false, keyKind: 'KEY_FILE' })]);
    expect(await screen.findByText(t('web.lmg_key_expired'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('web.lmg_key_save') })).toBeInTheDocument();
    expect(posts(api)).toEqual([]);
  });

  it('preselects the one ACTIVE RickPanel, and saving the bindings requests the dry run', async () => {
    const verified = view({
      status: 'VERIFIED',
      keyPresent: true,
      keyKind: 'KEY_FILE',
      verifyReport,
    });
    const api = page([verified], {
      extra: [
        {
          url: `/legacy-migration/imports/${ID}/panel-bindings`,
          method: 'POST',
          body: { import: { ...verified, panelBindings: [{ codePanel: 'P1', panelId: RICK }] } },
        },
        {
          url: `/legacy-migration/imports/${ID}/dry-run`,
          method: 'POST',
          body: { import: { ...verified, status: 'DRY_RUN_REQUESTED' } },
        },
      ],
    });
    const select = await screen.findByLabelText(`${t('web.lmg_col_nexa_panel')} P1`);
    await waitFor(() => expect(select).toHaveValue(RICK));
    expect(screen.getByText(t('web.mrz_panels_preselected'))).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Rick Disabled' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Marzban Frankfurt' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('web.mrz_panels_save') }));
    await waitFor(() => expect(posts(api)).toHaveLength(2));
    const [bindings, dryRun] = posts(api);
    expect(bindings?.url).toContain('/panel-bindings');
    expect(bindings?.body).toMatchObject({ bindings: [{ codePanel: 'P1', panelId: RICK }] });
    expect(dryRun?.url).toContain('/dry-run');
    expect(dryRun?.body).toEqual({ idempotencyKey: expect.any(String) });
  });

  it('offers the optional decisions file before the panels whose saving starts the dry run', async () => {
    // Codex review on #278: with panels first, the page's own order started a dry run that a
    // decisions file then had to wait out and repeat.
    page([view({ status: 'VERIFIED', keyPresent: true, keyKind: 'KEY_FILE', verifyReport })]);
    // The step titles (the panels title is also a mark in the step list above them).
    const decisions = (await screen.findAllByText(t('web.mrz_decisions_title'))).at(-1)!;
    const panels = (await screen.findAllByText(t('web.mrz_panels_title'))).at(-1)!;
    expect(
      decisions.compareDocumentPosition(panels) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('gives an actor with the Mirza permissions alone (no backup.view) the Mirza restore', async () => {
    // Codex review on #278: the card was gated on backup.view only, so the server authorised
    // controls this actor could never reach.
    const api = page([], {
      permissions: ['legacy.migration.view', 'legacy.migration.manage', 'legacy.migration.apply'],
    });
    const input = await screen.findByLabelText(t('web.recovery_upload_choose'));
    expect(input).toHaveAttribute('accept', '.nxpkg');
    expect(screen.queryByText(t('web.recovery_upload_disabled'))).toBeNull();
    await choose(MIRZA_PACKAGE_BYTES, 'restore.nxpkg');
    expect(await screen.findByText(t('web.recovery_file_mirza'))).toBeInTheDocument();
    await send();
    await waitFor(() =>
      expect(posts(api).map((call) => call.url)).toEqual([
        `${API_PREFIX}/legacy-migration/imports/upload`,
      ]),
    );
    // The NEXA capabilities it may not read are never asked for.
    expect(api.calls.some((call) => call.url.includes(RECOVERY_ROUTES.capabilities))).toBe(false);
  });

  it('refuses a NEXA archive to that actor, before anything is uploaded', async () => {
    const api = page([], { permissions: ['legacy.migration.view', 'legacy.migration.manage'] });
    await choose(NEXA_ARCHIVE_BYTES, 'mine.nxb');
    expect(await screen.findByText(t('web.recovery_no_permission_nexa'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('web.recovery_upload_send') })).toBeDisabled();
    expect(posts(api)).toEqual([]);
  });

  it('guesses nothing when two ACTIVE RickPanels exist', async () => {
    const api = page(
      [view({ status: 'VERIFIED', keyPresent: true, keyKind: 'KEY_FILE', verifyReport })],
      {
        panels: [
          ACTIVE_RICK,
          panel({ id: RICK_2, name: 'Rick Mashhad', providerType: 'rickpanel' }),
          ...OTHER_PANELS,
        ],
      },
    );
    const select = await screen.findByLabelText(`${t('web.lmg_col_nexa_panel')} P1`);
    await screen.findByRole('option', { name: 'Rick Mashhad' });
    expect(select).toHaveValue('');
    expect(screen.queryByText(t('web.mrz_panels_preselected'))).toBeNull();
    expect(screen.getByRole('button', { name: t('web.mrz_panels_save') })).toBeDisabled();
    expect(posts(api)).toEqual([]);
  });

  it('shows the dry-run report: every section, the money, ownership and quarantine', async () => {
    page([reviewed()]);
    expect(await screen.findByText('table:user')).toBeInTheDocument();
    expect(screen.getByText('history:payment')).toBeInTheDocument();
    expect(screen.getByText('customers')).toBeInTheDocument();
    expect(screen.getByText(t('web.lmg_wallet_after'))).toBeInTheDocument();
    expect(screen.getByText(t('web.lmg_debts_total'))).toBeInTheDocument();
    expect(screen.getByText(t('web.lmg_ownership_title'))).toBeInTheDocument();
    expect(screen.getByText('SERVICE_OWNER_UNPROVEN')).toBeInTheDocument();
    expect(screen.getByText('TRIAL_CONSUMED')).toBeInTheDocument();
    expect(screen.getByText(t('web.lmg_synthetic'))).toBeInTheDocument();
  });

  it('stops at a failed dry run with the reason in words', async () => {
    page([
      view({
        status: 'DRY_RUN_FAILED',
        keyPresent: true,
        verifyReport,
        errorCode: 'FRESH_TARGET_NOT_EMPTY',
        progress: { ...progress, refusalCounts: [{ code: 'orders', count: 4 }] },
      }),
    ]);
    // Terminal, so it is followed from the upload that produced it.
    await choose(MIRZA_PACKAGE_BYTES, 'restore.nxpkg');
    await send();
    expect(await screen.findByText('orders')).toBeInTheDocument();
    expect(
      screen.getAllByText(t('web.lmg_error_not_fresh'), { exact: false }).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: t('web.mrz_confirm_button') })).toBeNull();
    const steps = Array.from(document.querySelectorAll('.lmg-steps li'));
    expect(steps.map((li) => li.className)).toEqual(['done', 'failed', 'todo', 'todo']);
  });
});

describe('the confirmation', () => {
  const approve = (body: unknown, status = 200): Extra => ({
    url: `/legacy-migration/imports/${ID}/approve`,
    method: 'POST',
    status,
    body,
  });

  it('stays disabled until the exact phrase, then sends the digest, the phrase and the target ack', async () => {
    const api = page([reviewed()], {
      capabilities: { productionLikeTarget: true, targetAcknowledgement: ACK },
      extra: [approve({ import: approved({ status: 'APPROVED' }) })],
    });
    const button = await screen.findByRole('button', { name: t('web.mrz_confirm_button') });
    expect(button).toBeDisabled();
    // The target, the protective backup and the way back are said before the phrase.
    expect(screen.getByText(t('web.mrz_target_production_like'))).toBeInTheDocument();
    expect(screen.getAllByText(ACK).length).toBeGreaterThan(0);
    expect(screen.getByText(t('web.mrz_protective_body'))).toBeInTheDocument();
    const field = screen.getByLabelText(
      t('web.lmg_approval_phrase').replace('{phrase}', LEGACY_MIGRATION_APPROVAL_PHRASE),
    );
    fireEvent.change(field, { target: { value: LEGACY_MIGRATION_APPROVAL_PHRASE.toLowerCase() } });
    expect(button).toBeDisabled();
    fireEvent.change(field, { target: { value: LEGACY_MIGRATION_APPROVAL_PHRASE } });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(posts(api)).toHaveLength(1));
    expect(posts(api)[0]?.body).toEqual({
      idempotencyKey: expect.any(String),
      dryRunSha256: H('d'),
      confirmation: LEGACY_MIGRATION_APPROVAL_PHRASE,
      targetAcknowledgement: ACK,
    });
  });

  it('sends a null target ack where the target is not production-like', async () => {
    const api = page([reviewed()], {
      extra: [approve({ import: approved({ status: 'APPROVED' }) })],
    });
    const field = await screen.findByLabelText(
      t('web.lmg_approval_phrase').replace('{phrase}', LEGACY_MIGRATION_APPROVAL_PHRASE),
    );
    fireEvent.change(field, { target: { value: LEGACY_MIGRATION_APPROVAL_PHRASE } });
    fireEvent.click(screen.getByRole('button', { name: t('web.mrz_confirm_button') }));
    await waitFor(() => expect(posts(api)).toHaveLength(1));
    expect(posts(api)[0]?.body).toMatchObject({ targetAcknowledgement: null });
  });

  it('says in words when the server refuses the target ack', async () => {
    page([reviewed()], {
      capabilities: { productionLikeTarget: true, targetAcknowledgement: ACK },
      extra: [
        approve(
          {
            error: {
              kind: 'conflict',
              code: 'legacy_migration.target_ack_mismatch',
              message: 'target acknowledgement mismatch',
              correlationId: 'c1',
            },
          },
          409,
        ),
      ],
    });
    const field = await screen.findByLabelText(
      t('web.lmg_approval_phrase').replace('{phrase}', LEGACY_MIGRATION_APPROVAL_PHRASE),
    );
    fireEvent.change(field, { target: { value: LEGACY_MIGRATION_APPROVAL_PHRASE } });
    fireEvent.click(screen.getByRole('button', { name: t('web.mrz_confirm_button') }));
    expect(await screen.findByText(t('web.mrz_fault_target_ack'))).toBeInTheDocument();
  });

  const incompleteReport = {
    ...dryRunReport,
    warnings: [
      ...dryRunReport.warnings,
      { code: 'INVENTORY_INCOMPLETE', count: 1_234 },
      { code: 'PROVIDER_INVENTORY_INCOMPLETE', count: 1 },
      { code: 'PROVIDER_INVENTORY_INCOMPLETE:WALKS_DIFFER', count: 1 },
    ],
  };

  it('production-like: withholds the confirmation of a dry run planned on an incomplete RickPanel read, and says why', async () => {
    const api = page([reviewed({ dryRunReport: incompleteReport })], {
      capabilities: { productionLikeTarget: true, targetAcknowledgement: ACK },
    });
    expect(await screen.findByText(t('web.mrz_inventory_incomplete_title'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('web.mrz_confirm_button') })).toBeNull();
    expect(posts(api)).toEqual([]);
  });

  it('off a production-like target, the same dry run is the owner’s to confirm', async () => {
    page([reviewed({ dryRunReport: incompleteReport })]);
    expect(
      await screen.findByRole('button', { name: t('web.mrz_confirm_button') }),
    ).toBeInTheDocument();
    expect(screen.queryByText(t('web.mrz_inventory_incomplete_title'))).toBeNull();
  });

  it('production-like: withholds the confirmation of a dry run that reported no plan digest, and says to run it again', async () => {
    // `null` is what the page can receive: the client parses the view with the contract schema,
    // where the key is required, so a report with NO key never reaches this step (the server
    // refuses that one on its own — tests/unit/legacy-migration.test.ts).
    const api = page([reviewed({ dryRunReport: { ...dryRunReport, planTalliesDigest: null } })], {
      capabilities: { productionLikeTarget: true, targetAcknowledgement: ACK },
    });
    expect(await screen.findByText(t('web.mrz_digest_missing_title'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('web.mrz_confirm_button') })).toBeNull();
    expect(posts(api)).toEqual([]);
  });

  it('off a production-like target, a dry run with no plan digest is not withheld here', async () => {
    page([reviewed({ dryRunReport: { ...dryRunReport, planTalliesDigest: null } })]);
    expect(
      await screen.findByRole('button', { name: t('web.mrz_confirm_button') }),
    ).toBeInTheDocument();
    expect(screen.queryByText(t('web.mrz_digest_missing_title'))).toBeNull();
  });

  it('says in words when the server refuses a dry run that reported no plan digest', async () => {
    page([reviewed()], {
      capabilities: { productionLikeTarget: true, targetAcknowledgement: ACK },
      extra: [
        approve(
          {
            error: {
              kind: 'conflict',
              code: 'legacy_migration.invalid_state',
              message: 'no plan digest',
              correlationId: 'c1',
              details: { status: 'DRY_RUN_DONE', reason: 'PLAN_DIGEST_MISSING' },
            },
          },
          409,
        ),
      ],
    });
    const field = await screen.findByLabelText(
      t('web.lmg_approval_phrase').replace('{phrase}', LEGACY_MIGRATION_APPROVAL_PHRASE),
    );
    fireEvent.change(field, { target: { value: LEGACY_MIGRATION_APPROVAL_PHRASE } });
    fireEvent.click(screen.getByRole('button', { name: t('web.mrz_confirm_button') }));
    expect(await screen.findByText(t('web.mrz_digest_missing_body'))).toBeInTheDocument();
  });

  it('says in words when the server refuses a dry run planned on an incomplete RickPanel read', async () => {
    page([reviewed()], {
      capabilities: { productionLikeTarget: true, targetAcknowledgement: ACK },
      extra: [
        approve(
          {
            error: {
              kind: 'conflict',
              code: 'legacy_migration.invalid_state',
              message: 'incomplete inventory',
              correlationId: 'c1',
              details: { status: 'DRY_RUN_DONE', reason: 'PROVIDER_INVENTORY_INCOMPLETE' },
            },
          },
          409,
        ),
      ],
    });
    const field = await screen.findByLabelText(
      t('web.lmg_approval_phrase').replace('{phrase}', LEGACY_MIGRATION_APPROVAL_PHRASE),
    );
    fireEvent.change(field, { target: { value: LEGACY_MIGRATION_APPROVAL_PHRASE } });
    fireEvent.click(screen.getByRole('button', { name: t('web.mrz_confirm_button') }));
    expect(await screen.findByText(t('web.mrz_inventory_incomplete_body'))).toBeInTheDocument();
  });

  // A production panel that kept selling while it was read, every needed name decided one by
  // one (`complete: true` with a resolution): churn, never PROVIDER_INVENTORY_INCOMPLETE.
  const churnReport = (extra: { code: string; count: number }[] = []) => ({
    ...dryRunReport,
    warnings: [
      ...dryRunReport.warnings,
      { code: LEGACY_MIGRATION_PROVIDER_INVENTORY_CHURN, count: 1 },
      { code: 'PROVIDER_INVENTORY_CHURN:TOTAL_CHANGED', count: 1 },
      ...extra,
    ],
  });

  it('production-like: a panel that changed while read is said, not blocking, on the review and the confirmation', async () => {
    page([reviewed({ dryRunReport: churnReport() })], {
      capabilities: { productionLikeTarget: true, targetAcknowledgement: ACK },
    });
    expect(
      await screen.findByRole('button', { name: t('web.mrz_confirm_button') }),
    ).toBeInTheDocument();
    // Once in the dry-run review and once beside the confirmation.
    expect(screen.getAllByText(t('web.mrz_inventory_churn_title'))).toHaveLength(2);
    expect(screen.getAllByText(t('web.mrz_inventory_churn_body'))).toHaveLength(2);
    expect(screen.queryByText(t('web.mrz_inventory_incomplete_title'))).toBeNull();
    expect(
      screen.queryByText(t('web.mrz_inventory_churn_unresolved'), { exact: false }),
    ).toBeNull();
  });

  it('production-like: a churned panel with unresolved services still withholds the confirmation', async () => {
    const api = page(
      [
        reviewed({
          dryRunReport: churnReport([
            { code: LEGACY_MIGRATION_PROVIDER_INVENTORY_UNRESOLVED, count: 3 },
            { code: 'INVENTORY_INCOMPLETE', count: 3 },
          ]),
        }),
      ],
      { capabilities: { productionLikeTarget: true, targetAcknowledgement: ACK } },
    );
    expect(await screen.findByText(t('web.mrz_inventory_incomplete_title'))).toBeInTheDocument();
    expect(
      screen.getAllByText(
        t('web.mrz_inventory_churn_unresolved').replace('{count}', formatNumber(3)),
      ).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: t('web.mrz_confirm_button') })).toBeNull();
    expect(posts(api)).toEqual([]);
  });

  it('a report with per-panel diagnostics explains them on the review, through the contract schema', async () => {
    page([
      reviewed({
        dryRunReport: {
          ...churnReport([{ code: LEGACY_MIGRATION_PROVIDER_INVENTORY_UNRESOLVED, count: 4 }]),
          providerDiagnostics: [
            {
              panelId: RICK,
              reason: 'TOTAL_CHANGED',
              needed: 4,
              unresolved: 4,
              decisionWalk: null,
              unresolvedByCause: [{ code: 'NO_DECISION_WALK', count: 4 }],
              walks: [],
            },
          ],
        },
      }),
    ]);
    expect(await screen.findByText(t('web.mrz_diag_title'))).toBeInTheDocument();
    expect(
      screen.getByText(
        t('web.mrz_diag_panel_summary')
          .replace('{unresolved}', formatNumber(4))
          .replace('{needed}', formatNumber(4)),
        { exact: false },
      ),
    ).toBeInTheDocument();
  });

  // The inventory hold: the services a per-name read that HELD left undecided are recorded as
  // quarantined (history and an open review candidate), not a blocker.
  const heldReport = (extra: { code: string; count: number }[] = []) => ({
    ...churnReport([
      { code: LEGACY_MIGRATION_PROVIDER_INVENTORY_UNRESOLVED, count: 3 },
      { code: 'INVENTORY_INCOMPLETE', count: 3 },
      { code: 'PROVIDER_INVENTORY_QUARANTINED', count: 3 },
      ...extra,
    ]),
    inventoryHold: { version: 1, invoices: 3, digest: 'f'.repeat(64) },
  });
  const quarantineBody = () =>
    t('web.mrz_inventory_quarantine_body').replace('{count}', formatNumber(3));

  it('production-like: services quarantined by the inventory hold are said in words, and the confirmation is offered', async () => {
    page([reviewed({ dryRunReport: heldReport() })], {
      capabilities: { productionLikeTarget: true, targetAcknowledgement: ACK },
    });
    expect(
      await screen.findByRole('button', { name: t('web.mrz_confirm_button') }),
    ).toBeInTheDocument();
    // Once in the dry-run review and once beside the confirmation.
    expect(screen.getAllByText(t('web.mrz_inventory_quarantine_title'))).toHaveLength(2);
    expect(screen.getAllByText(quarantineBody())).toHaveLength(2);
    // Not the "not approvable" banner: a held-only report is approvable.
    expect(screen.queryByText(t('web.mrz_inventory_incomplete_title'))).toBeNull();
  });

  it('production-like: a real read failure beside the hold keeps the banner and withholds the confirmation', async () => {
    const api = page(
      [
        reviewed({
          dryRunReport: heldReport([
            { code: 'PROVIDER_INVENTORY_INCOMPLETE', count: 1 },
            { code: 'PROVIDER_INVENTORY_INCOMPLETE:TIMEOUT', count: 1 },
          ]),
        }),
      ],
      { capabilities: { productionLikeTarget: true, targetAcknowledgement: ACK } },
    );
    expect(await screen.findByText(t('web.mrz_inventory_incomplete_title'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('web.mrz_confirm_button') })).toBeNull();
    expect(posts(api)).toEqual([]);
  });

  it('the quarantine text says history and review, never that the service is adopted or lost', () => {
    const body = t('web.mrz_inventory_quarantine_body');
    expect(body).toContain('{count}');
    expect(body).toContain('سابقه');
    expect(body).toContain('بازبینی');
    expect(body).toContain('مانع تأیید نیست');
    expect(body).not.toMatch(/متوقف کنید/u);
  });

  it('never tells the operator to stop selling or stop creating accounts on the panel', () => {
    for (const key of [
      'web.mrz_inventory_incomplete_body',
      'web.mrz_inventory_churn_body',
      'web.mrz_inventory_churn_unresolved',
    ] as const) {
      expect(t(key)).not.toMatch(/متوقف کنید/u);
      expect(t(key)).not.toContain('ساخت و حذف حساب');
    }
    expect(t('web.mrz_inventory_incomplete_body')).toContain(
      LEGACY_MIGRATION_PROVIDER_INVENTORY_UNRESOLVED,
    );
  });

  it('offers no confirmation without legacy.migration.apply', async () => {
    const api = page([reviewed()], {
      permissions: MIRZA_ALL.filter((key) => key !== 'legacy.migration.apply'),
    });
    expect(await screen.findByText(t('web.lmg_approval_owner_only'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('web.mrz_confirm_button') })).toBeNull();
    expect(posts(api)).toEqual([]);
  });
});

describe('the run and its result', () => {
  it('shows the protective backup as the first stage, before anything is imported', async () => {
    page([approved({ status: 'APPROVED' })]);
    expect(await screen.findByText(t('web.mrz_run_frozen'))).toBeInTheDocument();
    const stages = Array.from(document.querySelectorAll('.mrz-progress li'));
    expect(stages.map((li) => li.className)).toEqual(['current', 'todo', 'todo', 'todo', 'todo']);
  });

  it('follows the import once the protective backup is taken, naming it', async () => {
    page([
      approved({
        status: 'APPLYING',
        working: true,
        preImportBackupRunId: PROTECTIVE,
        progress: { ...progress, phase: 'RECONCILE', applyAttempts: 1 },
      }),
    ]);
    expect(await screen.findByText(PROTECTIVE)).toBeInTheDocument();
    const stages = Array.from(document.querySelectorAll('.mrz-progress li'));
    expect(stages.map((li) => li.className)).toEqual(['done', 'done', 'current', 'todo', 'todo']);
    // The stage strip and the phase line both say it.
    expect(screen.getAllByText(t('web.lmg_phase_reconcile'))).toHaveLength(2);
    // Running: neither the confirmation nor a cancel is offered.
    expect(screen.queryByRole('button', { name: t('web.mrz_confirm_button') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('web.mrz_cancel') })).toBeNull();
  });

  it('renders the COMPLETED result with the protective backup id and the way back', async () => {
    page([
      approved({
        status: 'COMPLETED',
        preImportBackupRunId: PROTECTIVE,
        backupRunId: AFTER_BACKUP,
        applyReport,
        progress: { ...progress, phase: 'BACKUP', backup: 'TAKEN', reconcileVerdict: 'RECONCILED' },
        finishedAt: '2026-10-10T09:30:00.000Z',
      }),
    ]);
    // A finished import from an earlier visit is history; this one is followed after upload.
    await choose(MIRZA_PACKAGE_BYTES, 'restore.nxpkg');
    await send();
    expect(await screen.findByText(t('web.mrz_result_ok'))).toBeInTheDocument();
    expect(screen.getByText(PROTECTIVE)).toBeInTheDocument();
    expect(screen.getByText(t('web.mrz_undo_hint'))).toBeInTheDocument();
    expect(screen.getByText(t('web.lmg_reconciled'))).toBeInTheDocument();
    expect(screen.getByText(AFTER_BACKUP)).toBeInTheDocument();
    expect(screen.getAllByText('history:payment').length).toBeGreaterThan(0);
    const steps = Array.from(document.querySelectorAll('.lmg-steps li'));
    expect(steps.map((li) => li.className)).toEqual(['done', 'done', 'done', 'done']);
    // Round 4 PR-H: the one server step after an import, shown to copy.
    expect(screen.getByText(t('web.mrz_restart_after_import_title'))).toBeInTheDocument();
    expect(screen.getByText(t('web.mrz_restart_after_import_body'))).toBeInTheDocument();
    expect(screen.getByText(RESTART_AFTER_IMPORT_COMMAND)).toBeInTheDocument();
  });

  it('says why a run failed: the protective backup was not taken, nothing imported', async () => {
    page([
      approved({
        status: 'FAILED',
        errorCode: 'PRE_IMPORT_BACKUP_FAILED',
        finishedAt: '2026-10-10T09:12:00.000Z',
      }),
    ]);
    await choose(MIRZA_PACKAGE_BYTES, 'restore.nxpkg');
    await send();
    expect(await screen.findByText(t('web.mrz_result_failed'))).toBeInTheDocument();
    // Nothing was imported, so there is nothing to restart for.
    expect(screen.queryByText(t('web.mrz_restart_after_import_title'))).toBeNull();
    expect(
      screen.getAllByText(t('web.mrz_error_pre_import_backup'), { exact: false }).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText('PRE_IMPORT_BACKUP_FAILED')).toBeInTheDocument();
    const steps = Array.from(document.querySelectorAll('.lmg-steps li'));
    expect(steps.map((li) => li.className)).toEqual(['done', 'done', 'done', 'failed']);
  });

  it('lists a finished import from an earlier visit as history, with its protective backup', async () => {
    page([
      approved({
        id: OLD_ID,
        status: 'COMPLETED',
        preImportBackupRunId: PROTECTIVE,
        applyReport,
        finishedAt: '2026-10-09T09:30:00.000Z',
      }),
    ]);
    // The demo's short id in the cell; the whole id is its tooltip (X7).
    expect(await screen.findByTitle(PROTECTIVE)).toHaveTextContent(PROTECTIVE.slice(0, 8));
    expect(screen.getAllByText(t('web.lmg_history_title')).length).toBeGreaterThan(0);
    // The restore card still offers the NEXA strip: nothing Mirza is in progress.
    expect(screen.queryByRole('list', { name: t('web.mrz_steps_label') })).toBeNull();
  });

  it('marks the four steps and the five run stages from the row alone', () => {
    const marks = (overrides: Record<string, unknown>) => mirzaStepMarks(view(overrides) as never);
    expect(marks({ status: 'VERIFYING' })).toEqual(['done', 'current', 'todo', 'todo']);
    expect(marks({ status: 'VERIFY_FAILED' })).toEqual(['done', 'failed', 'todo', 'todo']);
    expect(marks({ status: 'DRY_RUN_DONE' })).toEqual(['done', 'done', 'current', 'todo']);
    expect(marks({ status: 'APPLYING' })).toEqual(['done', 'done', 'done', 'current']);
    expect(marks({ status: 'CANCELLED' })).toEqual(['done', 'todo', 'todo', 'todo']);
    const stage = (overrides: Record<string, unknown>) => runStage(view(overrides) as never);
    expect(stage({ status: 'APPLYING' })).toBe(0);
    expect(
      stage({
        status: 'APPLYING',
        preImportBackupRunId: PROTECTIVE,
        progress: { ...progress, phase: 'APPLY_PRECHECK' },
      }),
    ).toBe(1);
    expect(
      stage({
        status: 'APPLYING',
        preImportBackupRunId: PROTECTIVE,
        progress: { ...progress, phase: 'BACKUP' },
      }),
    ).toBe(4);
  });
});

describe('the report in Persian', () => {
  it('names sections and codes in Persian, keeps the code beside them, and links to the filtered lists', async () => {
    page([
      reviewed({
        dryRunReport: {
          ...dryRunReport,
          sections: [
            ...dryRunReport.sections,
            {
              section: 'services',
              source: 5,
              imported: 3,
              archived: 1,
              skipped: 0,
              quarantined: 1,
            },
            {
              section: 'invoice_archive',
              source: 9,
              imported: 0,
              archived: 9,
              skipped: 0,
              quarantined: 0,
            },
            {
              section: 'legacy_debts',
              source: 1,
              imported: 1,
              archived: 0,
              skipped: 0,
              quarantined: 0,
            },
          ],
          warnings: [
            { code: 'NO_PANEL', count: 2 },
            { code: 'PROVIDER_INVENTORY_CHURN:TOTAL_CHANGED', count: 1 },
            { code: 'SOMETHING_NEW', count: 1 },
          ],
          quarantine: [{ code: 'DECISION_QUARANTINED', count: 1 }],
        },
      }),
    ]);
    expect(await screen.findByText(t('web.mrz_section_customers'))).toBeInTheDocument();
    expect(screen.getByText('customers')).toBeInTheDocument();
    expect(
      screen.getByText(`${t('web.mrz_section_history_of')} ${t('web.c360_legacy_type_payment')}`),
    ).toBeInTheDocument();
    // The review pages are retired (Round 4 B4): the section is named, and links nowhere.
    expect(screen.getAllByText(t('web.mrz_section_services')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: t('web.mrz_section_services') })).toBeNull();
    // The archive-only pages are gone: those sections are named, and link nowhere.
    expect(screen.queryByRole('link', { name: t('web.mrz_section_invoice_archive') })).toBeNull();
    expect(screen.queryByRole('link', { name: t('web.mrz_section_legacy_debts') })).toBeNull();
    // A service outcome is named, and links nowhere: its review page is retired.
    expect(screen.getByText(t('web.lsr_outcome_no_panel'))).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: t('web.lsr_outcome_no_panel') })).toBeNull();
    expect(screen.getByText(t('web.mrz_code_provider_inventory_churn'))).toBeInTheDocument();
    expect(screen.getByText('PROVIDER_INVENTORY_CHURN:TOTAL_CHANGED')).toBeInTheDocument();
    expect(screen.getByText(t('web.mrz_code_decision_quarantined'))).toBeInTheDocument();
    // A code nobody named is shown raw, never guessed.
    expect(screen.getByText('SOMETHING_NEW')).toBeInTheDocument();
  });
});

describe('the old page', () => {
  it('is gone from the navigation, and its route redirects to the recovery page', () => {
    expect(NAV.some((entry) => entry.path === '/legacy-migration')).toBe(false);
    expect(ROUTE_PATTERNS).toContain('/legacy-migration');
    const resolved = resolve({ path: '/legacy-migration', query: new URLSearchParams() }, [
      'legacy.migration.view',
    ]);
    const element = resolved.element as ReactElement<{ to: string }>;
    expect((element.type as { name?: string }).name).toBe('RedirectPage');
    expect(element.props.to).toBe('/recovery');
  });
});

describe('the "adopt approved" lane (service-review.md §4b)', () => {
  /** The finished restore of source H('a'), from an earlier visit. */
  const finished = approved({
    id: OLD_ID,
    status: 'COMPLETED',
    packageSourceFingerprint: H('a'),
    preImportBackupRunId: PROTECTIVE,
    applyReport,
    applyLegacyRunId: '019600ab-cdef-7012-8345-6789abcd0601',
    finishedAt: '2026-10-09T09:30:00.000Z',
    createdAt: '2026-10-09T09:00:00.000Z',
  });
  /** The same package uploaded again and verified: a re-upload. */
  const reupload = (overrides: Record<string, unknown> = {}) =>
    view({
      status: 'VERIFIED',
      keyPresent: true,
      keyKind: 'KEY_FILE',
      verifyReport,
      packageSourceFingerprint: H('a'),
      ...overrides,
    });
  const adoptReport = {
    verdict: 'COMPLETED',
    legacyRunId: '019600ab-cdef-7012-8345-6789abcd0602',
    importLegacyRunId: '019600ab-cdef-7012-8345-6789abcd0601',
    approvals: 3,
    adopted: 1,
    stillUnresolved: 1,
    refused: [
      { code: 'AMBIGUOUS_OWNERSHIP', count: 1 },
      { code: 'INVENTORY_INCOMPLETE', count: 1 },
    ],
    left: [],
    claimLost: 0,
    withdrawnDuringRun: 0,
    unconfirmed: 0,
    released: 0,
    panelsRead: 1,
    providerReads: 4,
    providerWrites: 0,
  };

  it('never requests a dry run for a re-upload of a finished restore: saving the panels offers the lane instead, which sends the key alone', async () => {
    const bound = reupload({ panelBindings: [{ codePanel: 'P1', panelId: RICK }] });
    const api = page([finished, reupload()], {
      extra: [
        {
          url: `/legacy-migration/imports/${ID}/panel-bindings`,
          method: 'POST',
          body: { import: bound },
        },
        {
          url: `/legacy-migration/imports/${ID}/adopt`,
          method: 'POST',
          body: { import: { ...bound, status: 'ADOPT_REQUESTED' } },
        },
      ],
    });
    expect(await screen.findByText(t('web.mrz_reupload_banner'))).toBeInTheDocument();
    expect(screen.getByText(t('web.mrz_adopt_explained'))).toBeInTheDocument();
    // Nothing to send before the panels are bound.
    expect(screen.getByText(t('web.mrz_adopt_after_inputs'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('web.mrz_adopt_request') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('web.lmg_dry_run_request') })).toBeNull();
    const select = await screen.findByLabelText(`${t('web.lmg_col_nexa_panel')} P1`);
    await waitFor(() => expect(select).toHaveValue(RICK));
    fireEvent.click(screen.getByRole('button', { name: t('web.mrz_panels_save') }));
    await waitFor(() => expect(posts(api)).toHaveLength(1));
    // The bindings alone: no automatic dry run (the tenant is not fresh).
    expect(posts(api)[0]?.url).toContain('/panel-bindings');
  });

  it('offers the lane once the key and the panels are given, and sends only an idempotency key', async () => {
    const bound = reupload({ panelBindings: [{ codePanel: 'P1', panelId: RICK }] });
    const api = page([finished, bound], {
      extra: [
        {
          url: `/legacy-migration/imports/${ID}/adopt`,
          method: 'POST',
          body: { import: { ...bound, status: 'ADOPT_REQUESTED' } },
        },
      ],
    });
    fireEvent.click(await screen.findByRole('button', { name: t('web.mrz_adopt_request') }));
    await waitFor(() => expect(posts(api)).toHaveLength(1));
    expect(posts(api)[0]?.url).toContain(`/legacy-migration/imports/${ID}/adopt`);
    expect(posts(api)[0]?.body).toEqual({ idempotencyKey: expect.any(String) });
  });

  it('offers no lane without legacy.migration.apply, and says why', async () => {
    page([finished, reupload({ panelBindings: [{ codePanel: 'P1', panelId: RICK }] })], {
      permissions: MIRZA_ALL.filter((p) => p !== 'legacy.migration.apply'),
    });
    expect(await screen.findByText(t('web.mrz_adopt_no_permission'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('web.mrz_adopt_request') })).toBeNull();
  });

  it('says in words when the server finds no finished restore of that source', async () => {
    const bound = reupload({ panelBindings: [{ codePanel: 'P1', panelId: RICK }] });
    page([finished, bound], {
      extra: [
        {
          url: `/legacy-migration/imports/${ID}/adopt`,
          method: 'POST',
          status: 409,
          body: {
            error: {
              kind: 'conflict',
              code: 'legacy_migration.no_completed_import',
              message: 'no completed import',
              correlationId: 'c1',
            },
          },
        },
      ],
    });
    fireEvent.click(await screen.findByRole('button', { name: t('web.mrz_adopt_request') }));
    expect(await screen.findByText(t('web.mrz_fault_no_completed_import'))).toBeInTheDocument();
  });

  it('shows what the lane did: adopted, still unresolved, refused by reason in words, no panel write — and the way to the candidates', async () => {
    page([
      finished,
      reupload({
        status: 'ADOPT_DONE',
        panelBindings: [{ codePanel: 'P1', panelId: RICK }],
        adoptReport,
        adoptLegacyRunId: adoptReport.legacyRunId,
        keyPresent: false,
        progress: { ...progress, phase: 'ADOPT', adoptAttempts: 1 },
        finishedAt: '2026-10-10T09:40:00.000Z',
      }),
    ]);
    await choose(MIRZA_PACKAGE_BYTES, 'restore.nxpkg');
    await send();
    expect(await screen.findByText(t('web.mrz_adopt_result_title'))).toBeInTheDocument();
    expect(screen.getByText(t('web.mrz_adopt_partial'))).toBeInTheDocument();
    // Round 4 PR-H: the lane created services, so the restart step is shown here too.
    expect(screen.getByText(RESTART_AFTER_IMPORT_COMMAND)).toBeInTheDocument();
    const value = (label: string) =>
      screen.getByText(label).closest('div, li, tr, dl')?.textContent ?? '';
    expect(value(t('web.mrz_adopt_adopted'))).toContain(formatNumber(1));
    expect(value(t('web.mrz_adopt_unresolved'))).toContain(formatNumber(1));
    expect(value(t('web.mrz_adopt_provider_writes'))).toContain(formatNumber(0));
    // Each refusal in Persian, its code kept beside it.
    expect(screen.getByText('AMBIGUOUS_OWNERSHIP')).toBeInTheDocument();
    expect(screen.getByText('INVENTORY_INCOMPLETE')).toBeInTheDocument();
    expect(screen.getAllByText(t('web.lsr_outcome_ambiguous_ownership')).length).toBeGreaterThan(0);
    // The retired review pages are not linked (Round 4 B4).
    expect(screen.queryByRole('link', { name: /legacy|قدیمی/ })).toBeNull();
    // No confirmation, no import run stages: a lane is never an import.
    expect(screen.queryByRole('button', { name: t('web.mrz_confirm_button') })).toBeNull();
    expect(screen.queryByText(t('web.mrz_run_frozen'))).toBeNull();
    const steps = Array.from(document.querySelectorAll('.lmg-steps li'));
    expect(steps.map((li) => li.className)).toEqual(['done', 'done', 'done', 'done']);
  });

  it('marks a lane under way as the run step, and a finished one done', () => {
    const marks = (overrides: Record<string, unknown>) => mirzaStepMarks(view(overrides) as never);
    expect(marks({ status: 'ADOPT_REQUESTED' })).toEqual(['done', 'done', 'done', 'current']);
    expect(marks({ status: 'ADOPT_RUNNING' })).toEqual(['done', 'done', 'done', 'current']);
    expect(marks({ status: 'ADOPT_DONE' })).toEqual(['done', 'done', 'done', 'done']);
  });
});
