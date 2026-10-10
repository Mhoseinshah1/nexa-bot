import { describe, expect, it } from 'vitest';
import {
  errors,
  LEGACY_MIGRATION_APPROVAL_PHRASE,
  LEGACY_MIGRATION_HTTP_ERROR_CODES,
  LEGACY_NXPKG_IMPORT_STATUSES,
  LEGACY_NXPKG_TERMINAL_STATUSES,
  isNexaError,
  type ActorContext,
  type CorrelationId,
  type LegacyMigrationDryRunReport,
  type LegacyMigrationVerifyReport,
  type PermissionKey,
  type TenantContext,
} from '@nexa/contracts';
import {
  canonicalJson,
  canTransition,
  digestsEqual,
  LEGACY_MIGRATION_COMMAND_FROM,
  LEGACY_MIGRATION_MAX_APPLY_ATTEMPTS,
  LEGACY_MIGRATION_TRANSITIONS,
  reportDigest,
} from '../../apps/api/src/modules/platform/legacy-migration/domain/import-lifecycle';
import {
  LegacyMigrationService,
  legacyMigrationView,
} from '../../apps/api/src/modules/platform/legacy-migration/application/legacy-migration.service';
import { LegacyMigrationExecutor } from '../../apps/api/src/modules/platform/legacy-migration/application/legacy-migration-executor';
import {
  LegacyMigrationBlocked,
  LegacyMigrationNotWired,
  LegacyMigrationStepFailure,
  type MigrationRunner,
  type MigrationStepContext,
} from '../../apps/api/src/modules/platform/legacy-migration/application/ports';
import {
  InMemoryLegacyNxpkgImports,
  InMemoryMigrationWorkspaces,
} from '../support/legacy-migration-fakes';

/**
 * Mirza `.nxpkg` importer — the `legacy-migration` module's rules, without a database
 * (the integration suite runs the same paths against PostgreSQL and HTTP).
 *
 * What this file defends: the lifecycle table (APPLYING is never cancellable, a terminal state
 * has no way out); the dry-run digest is order-independent and an approval binds exactly it;
 * the flag off refuses every operator method; the package key appears in no view, no audit
 * row, no log line and no idempotency hash; and the executor drives an import through every
 * state, RESUMES an interrupted apply instead of failing it, erases the key on every terminal
 * state, leaves an import where it is when a port is not wired, and stops writing when its
 * lease is lost.
 */

const TENANT = '019600ab-cdef-7012-8345-6789abcd0001';
const ADMIN = '019600ab-cdef-7012-8345-6789abcd0002';
const SECRET = 'correct horse battery staple — the package passphrase';
const H = (c: string) => c.repeat(64);
const scope = { tenantId: TENANT, botInstanceId: null } as unknown as TenantContext;
const actor: ActorContext = {
  type: 'WEB_ADMIN',
  id: ADMIN,
  label: 'owner',
  surface: 'WEB',
  correlationId: 'c-1' as CorrelationId,
  sessionId: 'session-1',
} as ActorContext;

let sequence = 0;
function nextId(): string {
  sequence += 1;
  return `019600ab-cdef-7012-8345-${sequence.toString(16).padStart(12, '0')}`;
}

const verifyReport: LegacyMigrationVerifyReport = {
  packageImportId: 'pkg-1',
  sourceFingerprint: H('a'),
  packageSchemaVersion: '1.4.0',
  converterVersion: '0.5.0',
  synthetic: true,
  panelTargets: [{ codePanel: 'P1', providerType: 'rickpanel', services: 3 }],
  recordCounts: [{ code: 'user', count: 10 }],
  decisions: null,
};

const dryRunReport: LegacyMigrationDryRunReport = {
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
};

// --- the lifecycle ------------------------------------------------------------------------

describe('the import lifecycle', () => {
  it('lets nothing out of a terminal state', () => {
    for (const status of LEGACY_NXPKG_TERMINAL_STATUSES) {
      expect(LEGACY_MIGRATION_TRANSITIONS[status], status).toEqual([]);
    }
  });

  it('never cancels an APPLYING import, and cancels every other non-terminal one', () => {
    expect(canTransition('APPLYING', 'CANCELLED')).toBe(false);
    expect(LEGACY_MIGRATION_COMMAND_FROM.cancel).not.toContain('APPLYING');
    const terminal: readonly string[] = LEGACY_NXPKG_TERMINAL_STATUSES;
    for (const status of LEGACY_NXPKG_IMPORT_STATUSES) {
      if (terminal.includes(status) || status === 'APPLYING') continue;
      expect(canTransition(status, 'CANCELLED'), status).toBe(true);
    }
  });

  it('approves only a DRY_RUN_DONE import, and only into APPROVED', () => {
    expect(LEGACY_MIGRATION_COMMAND_FROM.approve).toEqual(['DRY_RUN_DONE']);
    const into = LEGACY_NXPKG_IMPORT_STATUSES.filter((s) => canTransition(s, 'APPROVED'));
    expect(into).toEqual(['DRY_RUN_DONE']);
    // And APPLYING is reachable from APPROVED alone.
    expect(LEGACY_NXPKG_IMPORT_STATUSES.filter((s) => canTransition(s, 'APPLYING'))).toEqual([
      'APPROVED',
    ]);
  });

  it('hashes a report independently of key order, and differently for a different value', () => {
    const a = { b: 1, a: [{ y: 'x', x: true }], c: null };
    const b = { c: null, a: [{ x: true, y: 'x' }], b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(reportDigest(a)).toBe(reportDigest(b));
    expect(reportDigest(a)).not.toBe(reportDigest({ ...a, b: 2 }));
    expect(() => canonicalJson({ n: Number.NaN })).toThrow();
    expect(digestsEqual(H('a'), H('a'))).toBe(true);
    expect(digestsEqual(H('a'), H('b'))).toBe(false);
  });
});

// --- the service ------------------------------------------------------------------------------

interface Harness {
  readonly service: LegacyMigrationService;
  readonly repository: InMemoryLegacyNxpkgImports;
  readonly audits: unknown[];
  readonly logs: unknown[];
  readonly hashes: string[];
}

function harness(options: { enabled?: boolean; granted?: readonly PermissionKey[] } = {}): Harness {
  const repository = new InMemoryLegacyNxpkgImports();
  const audits: unknown[] = [];
  const logs: unknown[] = [];
  const hashes: string[] = [];
  const granted = new Set<PermissionKey>(
    options.granted ?? [
      'legacy.migration.view',
      'legacy.migration.manage',
      'legacy.migration.apply',
    ],
  );
  const stored = new Map<string, unknown>();
  const log = (context: unknown, message: string) => logs.push({ context, message });
  const service = new LegacyMigrationService({
    repository,
    workspaces: new InMemoryMigrationWorkspaces(),
    cipher: {
      encrypt: () => ({ keyId: 'key-1', ciphertext: `sealed-${String(sequence)}` }),
      decrypt: () => SECRET,
      mask: () => '••',
    },
    guard: {
      check: async (_scope: unknown, _actor: unknown, permission: PermissionKey) => {
        if (!granted.has(permission)) {
          throw errors.permissionDenied('platform.permission_denied', 'denied', { permission });
        }
      },
      denialEvent: () => ({}),
    } as never,
    uow: {
      run: (s: unknown, fn: (tx: unknown) => Promise<unknown>) => fn({ tx: null, scope: s }),
    } as never,
    audit: {
      record: async (_s: unknown, _a: unknown, entry: unknown) => {
        audits.push(entry);
      },
    } as never,
    opsLog: { record: async () => undefined } as never,
    sessions: { isLive: async () => true } as never,
    idempotency: {
      find: async (_s: unknown, _n: unknown, key: string, hash: string) => {
        hashes.push(hash);
        const result = stored.get(`${key}|${hash}`);
        return result === undefined ? null : { result };
      },
      remember: async (_s: unknown, _n: unknown, key: string, hash: string, result: unknown) => {
        hashes.push(hash);
        stored.set(`${key}|${hash}`, result);
        return true;
      },
    } as never,
    scopeActivity: { scopeIsActive: async () => true },
    clock: { now: () => new Date('2026-10-10T10:00:00.000Z') },
    ids: { uuid: nextId, callbackRef: () => 'r' },
    enabled: options.enabled ?? true,
    maxUploadBytes: 1024 * 1024,
    productionLikeTarget: false,
    targetAcknowledgement: () => null,
    logger: { info: log, warn: log, error: log },
  });
  return { service, repository, audits, logs, hashes };
}

async function uploaded(h: Harness): Promise<string> {
  const pending = await h.service.beginUpload(scope, actor, { fileName: 'mirza.nxpkg' });
  const view = await h.service.completeUpload(scope, actor, pending, { bytes: 10, sha256: H('f') });
  return view.id;
}

const key = () => `key-${String((sequence += 1))}-padding`;

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (isNexaError(error)) return error.code;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('LegacyMigrationService', () => {
  it('refuses every operator method while LEGACY_MIGRATION_ENABLED is off', async () => {
    const h = harness({ enabled: false });
    const id = nextId();
    const disabled = LEGACY_MIGRATION_HTTP_ERROR_CODES.DISABLED;
    expect(await codeOf(h.service.list(scope, actor, {}))).toBe(disabled);
    expect(await codeOf(h.service.detail(scope, actor, id))).toBe(disabled);
    expect(await codeOf(h.service.beginUpload(scope, actor, { fileName: 'x' }))).toBe(disabled);
    expect(await codeOf(h.service.setKey(scope, actor, id, {}))).toBe(disabled);
    expect(await codeOf(h.service.setPanelBindings(scope, actor, id, {}))).toBe(disabled);
    expect(await codeOf(h.service.beginDecisionsUpload(scope, actor, id))).toBe(disabled);
    expect(await codeOf(h.service.requestDryRun(scope, actor, id, {}))).toBe(disabled);
    expect(await codeOf(h.service.approve(scope, actor, id, {}))).toBe(disabled);
    expect(await codeOf(h.service.cancel(scope, actor, id, {}))).toBe(disabled);
    // The capabilities document still answers: it is what SAYS the feature is off.
    expect((await h.service.capabilities(scope, actor)).enabled).toBe(false);
    expect(h.repository.rows.size).toBe(0);
  });

  it('seals the key and never shows it in a view, an audit row, a log line or an idempotency hash', async () => {
    const h = harness();
    const id = await uploaded(h);
    const view = await h.service.setKey(scope, actor, id, {
      idempotencyKey: key(),
      passphrase: SECRET,
    });
    expect(view.keyPresent).toBe(true);
    expect(view.keyKind).toBe('PASSPHRASE');
    const row = h.repository.rows.get(id);
    expect(row?.keyCiphertext).toMatch(/^sealed-/u);
    const everything = JSON.stringify({ view, audits: h.audits, logs: h.logs, hashes: h.hashes });
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain(row?.keyCiphertext ?? 'x');
    expect(everything).not.toContain('key-1');
    // The view carries no path either.
    expect(JSON.stringify(view)).not.toContain('/fake/');
  });

  it('refuses a malformed key body without echoing it', async () => {
    const h = harness();
    const id = await uploaded(h);
    try {
      await h.service.setKey(scope, actor, id, {
        idempotencyKey: key(),
        passphrase: SECRET,
        keyFileText: SECRET,
      });
      expect.unreachable();
    } catch (error) {
      expect(isNexaError(error) && error.code).toBe(
        LEGACY_MIGRATION_HTTP_ERROR_CODES.REQUEST_INVALID,
      );
      expect(JSON.stringify(error) + String(error)).not.toContain(SECRET);
    }
  });

  it('binds the approval to the current dry run digest and the typed phrase', async () => {
    const h = harness();
    const id = await uploaded(h);
    const row = h.repository.rows.get(id);
    if (row === undefined) throw new Error('no row');
    h.repository.put({
      ...row,
      status: 'DRY_RUN_DONE',
      keyCiphertext: 'sealed',
      keyKeyId: 'key-1',
      keyKind: 'PASSPHRASE',
      dryRunReport,
      dryRunSha256: reportDigest(dryRunReport),
    });
    const approve = (dryRunSha256: string, confirmation = LEGACY_MIGRATION_APPROVAL_PHRASE) =>
      h.service.approve(scope, actor, id, { idempotencyKey: key(), dryRunSha256, confirmation });

    expect(await codeOf(approve(H('0')))).toBe(LEGACY_MIGRATION_HTTP_ERROR_CODES.DIGEST_MISMATCH);
    expect(await codeOf(approve(reportDigest(dryRunReport), 'import mirza'))).toBe(
      LEGACY_MIGRATION_HTTP_ERROR_CODES.CONFIRMATION_INVALID,
    );
    expect(h.repository.rows.get(id)?.status).toBe('DRY_RUN_DONE');

    const approved = await approve(reportDigest(dryRunReport));
    expect(approved.status).toBe('APPROVED');
    expect(approved.approvedDryRunSha256).toBe(reportDigest(dryRunReport));
    expect(approved.approvedByAdminId).toBe(ADMIN);
    // A second approval of the same digest is a state refusal, never a second import.
    expect(await codeOf(approve(reportDigest(dryRunReport)))).toBe(
      LEGACY_MIGRATION_HTTP_ERROR_CODES.INVALID_STATE,
    );
  });

  it('charges the approval on the CRITICAL apply permission, and records the denial', async () => {
    const h = harness({ granted: ['legacy.migration.view', 'legacy.migration.manage'] });
    const id = nextId();
    await expect(
      h.service.approve(scope, actor, id, {
        idempotencyKey: key(),
        dryRunSha256: H('a'),
        confirmation: LEGACY_MIGRATION_APPROVAL_PHRASE,
      }),
    ).rejects.toMatchObject({ kind: 'PERMISSION_DENIED' });
    expect(h.audits).toContainEqual(
      expect.objectContaining({ action: 'legacy.migration.approve', result: 'DENIED' }),
    );
  });

  it('returns a dry-run-done import to VERIFIED when its panel bindings change', async () => {
    const h = harness();
    const id = await uploaded(h);
    const row = h.repository.rows.get(id);
    if (row === undefined) throw new Error('no row');
    h.repository.put({ ...row, status: 'DRY_RUN_DONE', dryRunReport, dryRunSha256: H('d') });
    const view = await h.service.setPanelBindings(scope, actor, id, {
      idempotencyKey: key(),
      bindings: [{ codePanel: 'P1', panelId: '019600ab-cdef-7012-8345-6789abcd0fff' }],
    });
    expect(view.status).toBe('VERIFIED');
    expect(view.dryRunSha256).toBeNull();
    expect(view.dryRunReport).toBeNull();
  });

  it('refuses a cancel of an APPLYING import', async () => {
    const h = harness();
    const id = await uploaded(h);
    const row = h.repository.rows.get(id);
    if (row === undefined) throw new Error('no row');
    h.repository.put({ ...row, status: 'APPLYING' });
    expect(await codeOf(h.service.cancel(scope, actor, id, { idempotencyKey: key() }))).toBe(
      LEGACY_MIGRATION_HTTP_ERROR_CODES.INVALID_STATE,
    );
  });

  it('builds a view with no key, no path and no unvalidated report', () => {
    const view = legacyMigrationView(
      {
        ...emptyRow(),
        keyCiphertext: 'CIPHERTEXT-VALUE',
        keyKeyId: 'KEYRING-ID',
        filePath: '/var/lib/nexa/legacy-migration/x/package.nxpkg',
        decisionsFilePath: '/var/lib/nexa/legacy-migration/x/ownership-decisions.json',
        dryRunReport: { not: 'a report' } as never,
      },
      new Date(),
    );
    const json = JSON.stringify(view);
    for (const leaked of ['CIPHERTEXT-VALUE', 'KEYRING-ID', '/var/lib/nexa']) {
      expect(json).not.toContain(leaked);
    }
    expect(view.keyPresent).toBe(true);
    expect(view.decisionsPresent).toBe(true);
    expect(view.dryRunReport).toBeNull();
  });
});

function emptyRow() {
  return {
    id: nextId(),
    tenantId: TENANT,
    status: 'UPLOADED' as const,
    errorCode: null,
    fileName: 'mirza.nxpkg',
    filePath: '/fake/package.nxpkg',
    fileSha256: H('f'),
    fileBytes: 10n,
    packageImportId: null,
    packageSourceFingerprint: null,
    packageSchemaVersion: null,
    converterVersion: null,
    manifestSummary: null,
    keyCiphertext: null,
    keyKeyId: null,
    keyKind: null,
    decisionsFilePath: null,
    decisionsSummary: null,
    panelBindings: null,
    verifyReport: null,
    dryRunReport: null,
    dryRunSha256: null,
    approvedDryRunSha256: null,
    applyReport: null,
    dryRunLegacyRunId: null,
    applyLegacyRunId: null,
    backupRunId: null,
    progress: {
      phase: null,
      applyAttempts: 0,
      importerVerdict: null,
      reconcileVerdict: null,
      history: [],
      refusalCounts: [],
      backup: null,
      blocker: null,
    },
    requestedByAdminId: ADMIN,
    approvedByAdminId: null,
    approvedAt: null,
    claimedBy: null,
    leaseUntil: null,
    createdAt: new Date('2026-10-10T09:00:00.000Z'),
    updatedAt: new Date('2026-10-10T09:00:00.000Z'),
    finishedAt: null,
  };
}

// --- the executor -----------------------------------------------------------------------------

interface ExecutorHarness {
  readonly executor: LegacyMigrationExecutor;
  readonly repository: InMemoryLegacyNxpkgImports;
  readonly workspaces: InMemoryMigrationWorkspaces;
  readonly calls: string[];
  readonly logs: unknown[];
  runner: MigrationRunner;
  fresh: boolean;
  now: Date;
}

function executorHarness(options: { leaseOwner?: string } = {}): ExecutorHarness {
  const repository = new InMemoryLegacyNxpkgImports();
  const workspaces = new InMemoryMigrationWorkspaces();
  const calls: string[] = [];
  const logs: unknown[] = [];
  const log = (context: unknown, message: string) => logs.push({ context, message });
  const state = {
    fresh: true,
    now: new Date('2026-10-10T10:00:00.000Z'),
    runner: {
      precheck: async () => undefined,
      dryRun: async (context: MigrationStepContext) => {
        calls.push(`dryRun:${secretKind(context)}`);
        return { report: dryRunReport, legacyRunId: null };
      },
      apply: async (_context: MigrationStepContext, input: { mode: string }) => {
        calls.push(`apply:${input.mode}`);
        return { legacyRunId: null as unknown as string, importerVerdict: 'COMPLETED' };
      },
      reconcile: async () => {
        calls.push('reconcile');
        return { verdict: 'RECONCILED' as const };
      },
      finalReport: async () => {
        calls.push('report');
        return {
          importerVerdict: 'COMPLETED',
          reconcileVerdict: 'RECONCILED' as const,
          reportHolds: true,
          failedInvariants: [],
          sections: [],
          history: [],
        };
      },
    } as MigrationRunner,
  };
  const h: ExecutorHarness = {
    executor: undefined as never,
    repository,
    workspaces,
    calls,
    logs,
    get runner() {
      return state.runner;
    },
    set runner(value) {
      state.runner = value;
    },
    get fresh() {
      return state.fresh;
    },
    set fresh(value) {
      state.fresh = value;
    },
    get now() {
      return state.now;
    },
    set now(value) {
      state.now = value;
    },
  };
  const executor = new LegacyMigrationExecutor({
    repository,
    workspaces,
    cipher: {
      encrypt: () => ({ keyId: 'k', ciphertext: 'c' }),
      decrypt: () => SECRET,
      mask: () => '',
    },
    verifier: {
      verify: async (context) => {
        calls.push(`verify:${secretKind(context)}`);
        return verifyReport;
      },
    },
    runner: {
      precheck: (c, step) => state.runner.precheck(c, step),
      dryRun: (c) => state.runner.dryRun(c),
      apply: (c, i) => state.runner.apply(c, i),
      reconcile: (c) => state.runner.reconcile(c),
      finalReport: (c, i) => state.runner.finalReport(c, i),
    },
    freshTarget: {
      check: async () =>
        state.fresh ? { fresh: true } : { fresh: false, counts: { customers: 4 } },
    },
    history: {
      ingest: async () => {
        calls.push('history');
        return { counts: [{ code: 'payment', count: 7 }] };
      },
    },
    backup: {
      runAfterImport: async () => {
        calls.push('backup');
        return { outcome: 'TAKEN' as const, runId: '019600ab-cdef-7012-8345-6789abcdbbbb' };
      },
    },
    clock: { now: () => state.now },
    correlation: () => 'corr' as CorrelationId,
    leaseOwner: options.leaseOwner ?? 'migration:test',
    tickIntervalMs: 1000,
    enabled: true,
    logger: { info: log, warn: log, error: log },
  });
  (h as { executor: LegacyMigrationExecutor }).executor = executor;
  return h;
}

function secretKind(context: Pick<MigrationStepContext, 'secret'>): string {
  return 'passphrase' in context.secret && context.secret.passphrase === SECRET ? 'ok' : 'bad';
}

function seed(h: ExecutorHarness, overrides: Record<string, unknown> = {}): string {
  const row = {
    ...emptyRow(),
    keyCiphertext: 'sealed',
    keyKeyId: 'key-1',
    keyKind: 'PASSPHRASE' as const,
    panelBindings: [{ codePanel: 'P1', panelId: '019600ab-cdef-7012-8345-6789abcd0fff' }],
    ...overrides,
  };
  h.repository.put(row as never);
  return row.id;
}

const status = (h: ExecutorHarness, id: string) => h.repository.rows.get(id)?.status;

describe('LegacyMigrationExecutor', () => {
  it('drives an import through every state to COMPLETED, erasing the key at the end', async () => {
    const h = executorHarness();
    const id = seed(h);

    await h.executor.tick();
    expect(status(h, id)).toBe('VERIFIED');
    expect(h.repository.rows.get(id)?.packageImportId).toBe('pkg-1');
    expect(h.repository.rows.get(id)?.claimedBy).toBeNull();

    h.repository.put({ ...h.repository.rows.get(id)!, status: 'DRY_RUN_REQUESTED' });
    await h.executor.tick();
    const done = h.repository.rows.get(id)!;
    expect(done.status).toBe('DRY_RUN_DONE');
    expect(done.dryRunSha256).toBe(reportDigest(dryRunReport));

    h.repository.put({
      ...done,
      status: 'APPROVED',
      approvedDryRunSha256: done.dryRunSha256,
      approvedByAdminId: ADMIN,
      approvedAt: h.now,
    });
    await h.executor.tick();
    const finished = h.repository.rows.get(id)!;
    expect(finished.status).toBe('COMPLETED');
    expect(finished.keyCiphertext).toBeNull();
    expect(finished.keyKeyId).toBeNull();
    expect(finished.claimedBy).toBeNull();
    expect(finished.backupRunId).toBe('019600ab-cdef-7012-8345-6789abcdbbbb');
    expect(finished.progress).toMatchObject({ backup: 'TAKEN', applyAttempts: 1 });
    expect(finished.progress.history).toEqual([{ code: 'payment', count: 7 }]);
    expect(h.calls).toEqual([
      'verify:ok',
      'dryRun:ok',
      'apply:IMPORT',
      'history',
      'reconcile',
      'report',
      'backup',
    ]);
    // Every decrypted step directory was removed.
    expect(h.workspaces.steps.size).toBe(0);
    // And the key appears in no log line.
    expect(JSON.stringify(h.logs)).not.toContain(SECRET);
  });

  it('RESUMES an interrupted apply instead of failing it, from the phase it reached', async () => {
    const h = executorHarness();
    const digest = reportDigest(dryRunReport);
    const id = seed(h, {
      status: 'APPROVED',
      dryRunReport,
      dryRunSha256: digest,
      approvedDryRunSha256: digest,
      approvedByAdminId: ADMIN,
      approvedAt: h.now,
    });
    // The first attempt dies inside the importer (a crash, from the executor's point of view).
    const healthy = h.runner;
    h.runner = {
      ...healthy,
      apply: async (_c, input) => {
        h.calls.push(`apply:${input.mode}`);
        throw new Error('the process lost its database connection');
      },
    };
    await h.executor.tick();
    expect(status(h, id)).toBe('APPLYING');
    expect(h.repository.rows.get(id)?.claimedBy).toBeNull();
    expect(h.repository.rows.get(id)?.keyCiphertext).not.toBeNull();

    h.runner = healthy;
    await h.executor.tick();
    expect(status(h, id)).toBe('COMPLETED');
    expect(h.calls.filter((call) => call.startsWith('apply:'))).toEqual([
      'apply:IMPORT',
      'apply:RESUME',
    ]);
    expect(h.repository.rows.get(id)?.progress.applyAttempts).toBe(2);
  });

  it('takes over an APPLYING import whose process died, after its lease expires, and resumes it', async () => {
    const h = executorHarness();
    const digest = reportDigest(dryRunReport);
    const id = seed(h, {
      status: 'APPLYING',
      dryRunReport,
      dryRunSha256: digest,
      approvedDryRunSha256: digest,
      approvedByAdminId: ADMIN,
      approvedAt: h.now,
      claimedBy: 'migration:dead-host',
      leaseUntil: new Date(h.now.getTime() + 60_000),
      progress: {
        ...emptyRow().progress,
        phase: 'RECONCILE',
        applyAttempts: 1,
        importerVerdict: 'COMPLETED',
      },
    });
    // The lease is live: nobody else may touch it.
    await h.executor.tick();
    expect(h.calls).toEqual([]);
    // It expires: released, claimed, resumed from RECONCILE — the import is NOT re-run.
    h.now = new Date(h.now.getTime() + 120_000);
    await h.executor.tick();
    expect(status(h, id)).toBe('COMPLETED');
    expect(h.calls).toEqual(['reconcile', 'report', 'backup']);
  });

  it('fails a crash loop after the attempt bound, and erases the key', async () => {
    const h = executorHarness();
    const digest = reportDigest(dryRunReport);
    const id = seed(h, {
      status: 'APPLYING',
      dryRunSha256: digest,
      approvedDryRunSha256: digest,
      approvedByAdminId: ADMIN,
      approvedAt: h.now,
      progress: {
        ...emptyRow().progress,
        phase: 'APPLY_IMPORT',
        applyAttempts: LEGACY_MIGRATION_MAX_APPLY_ATTEMPTS,
      },
    });
    await h.executor.tick();
    const row = h.repository.rows.get(id)!;
    expect(row.status).toBe('FAILED');
    expect(row.errorCode).toBe('IMPORT_FAILED');
    expect(row.keyCiphertext).toBeNull();
  });

  it('fails the apply, and erases the key, on a refusal; on a changed package or digest before any write', async () => {
    const cases: [string, (h: ExecutorHarness, id: string) => void, string][] = [
      [
        'package changed',
        (h, id) => h.workspaces.digests.set(h.repository.rows.get(id)!.filePath, H('0')),
        'PACKAGE_CHANGED',
      ],
      ['target not fresh', (h) => (h.fresh = false), 'FRESH_TARGET_NOT_EMPTY'],
      [
        'importer refusal',
        (h) =>
          (h.runner = {
            ...h.runner,
            apply: async () => {
              throw new LegacyMigrationStepFailure('PANEL_TARGET_MISMATCH', 'no');
            },
          }),
        'PANEL_TARGET_MISMATCH',
      ],
    ];
    for (const [name, arrange, code] of cases) {
      const h = executorHarness();
      const digest = reportDigest(dryRunReport);
      const id = seed(h, {
        status: 'APPROVED',
        dryRunSha256: digest,
        approvedDryRunSha256: digest,
        approvedByAdminId: ADMIN,
        approvedAt: h.now,
      });
      arrange(h, id);
      await h.executor.tick();
      const row = h.repository.rows.get(id)!;
      expect(row.status, name).toBe('FAILED');
      expect(row.errorCode, name).toBe(code);
      expect(row.keyCiphertext, name).toBeNull();
      if (code !== 'PANEL_TARGET_MISMATCH') {
        expect(
          h.calls.filter((call) => call.startsWith('apply:')),
          name,
        ).toEqual([]);
      }
    }
  });

  it('refuses an apply whose approval names another dry run', async () => {
    const h = executorHarness();
    const id = seed(h, {
      status: 'APPROVED',
      dryRunSha256: H('1'),
      approvedDryRunSha256: H('2'),
      approvedByAdminId: ADMIN,
      approvedAt: h.now,
    });
    await h.executor.tick();
    expect(h.repository.rows.get(id)).toMatchObject({
      status: 'FAILED',
      errorCode: 'DRY_RUN_MISMATCH',
    });
    expect(h.calls).toEqual([]);
  });

  it('records why a dry run found the target not fresh, and fails it', async () => {
    const h = executorHarness();
    h.fresh = false;
    const id = seed(h, { status: 'DRY_RUN_REQUESTED' });
    await h.executor.tick();
    const row = h.repository.rows.get(id)!;
    expect(row).toMatchObject({ status: 'DRY_RUN_FAILED', errorCode: 'FRESH_TARGET_NOT_EMPTY' });
    expect(row.progress.refusalCounts).toEqual([{ code: 'customers', count: 4 }]);
    expect(row.keyCiphertext).toBeNull();
  });

  it('WAITS on a production-like gate: the blocker is recorded, the import stays cancellable, nothing runs', async () => {
    const h = executorHarness();
    const digest = reportDigest(dryRunReport);
    const id = seed(h, {
      status: 'APPROVED',
      dryRunReport,
      dryRunSha256: digest,
      approvedDryRunSha256: digest,
      approvedByAdminId: ADMIN,
      approvedAt: h.now,
    });
    let blocker: 'CUTOVER_APPROVAL_MISSING' | 'STOP_SALES_NOT_ACTIVE' | null =
      'CUTOVER_APPROVAL_MISSING';
    const steps: string[] = [];
    h.runner = {
      ...h.runner,
      precheck: async (_c, step) => {
        steps.push(step);
        if (blocker !== null) throw new LegacyMigrationBlocked(blocker);
      },
    };
    await h.executor.tick();
    let row = h.repository.rows.get(id)!;
    expect(row).toMatchObject({ status: 'APPROVED', claimedBy: null, errorCode: null });
    expect(row.progress.blocker).toBe('CUTOVER_APPROVAL_MISSING');
    expect(row.keyCiphertext).not.toBeNull();
    expect(h.calls).toEqual([]);

    blocker = 'STOP_SALES_NOT_ACTIVE';
    await h.executor.tick();
    expect(h.repository.rows.get(id)?.progress.blocker).toBe('STOP_SALES_NOT_ACTIVE');

    blocker = null;
    await h.executor.tick();
    row = h.repository.rows.get(id)!;
    expect(row.status).toBe('COMPLETED');
    expect(row.progress.blocker).toBeNull();
    expect(steps.every((step) => step === 'APPLY')).toBe(true);
  });

  it('a dry run waits in DRY_RUN_REQUESTED on a missing acknowledgement; a never-allowed package fails it', async () => {
    const h = executorHarness();
    const id = seed(h, { status: 'DRY_RUN_REQUESTED' });
    h.runner = {
      ...h.runner,
      precheck: async () => {
        throw new LegacyMigrationBlocked('TARGET_ACK_MISSING');
      },
    };
    await h.executor.tick();
    expect(h.repository.rows.get(id)).toMatchObject({ status: 'DRY_RUN_REQUESTED' });
    expect(h.repository.rows.get(id)?.progress.blocker).toBe('TARGET_ACK_MISSING');
    h.runner = {
      ...h.runner,
      precheck: async () => {
        throw new LegacyMigrationStepFailure('IMPORT_FAILED', 'synthetic on production');
      },
    };
    await h.executor.tick();
    const row = h.repository.rows.get(id)!;
    expect(row).toMatchObject({ status: 'DRY_RUN_FAILED', errorCode: 'IMPORT_FAILED' });
    expect(row.keyCiphertext).toBeNull();
    expect(h.calls).toEqual([]);
  });

  it('leaves an import where it is while a port is not wired', async () => {
    const h = executorHarness();
    const id = seed(h, { status: 'DRY_RUN_REQUESTED' });
    h.runner = {
      ...h.runner,
      dryRun: async () => {
        throw new LegacyMigrationNotWired('MigrationRunner');
      },
    };
    await h.executor.tick();
    const row = h.repository.rows.get(id)!;
    expect(row.status).toBe('DRY_RUN_RUNNING');
    expect(row.errorCode).toBeNull();
    expect(row.claimedBy).toBeNull();
    expect(row.keyCiphertext).not.toBeNull();
    expect(h.workspaces.steps.size).toBe(0);
  });

  it('stops writing when the import is cancelled under it', async () => {
    const h = executorHarness();
    const id = seed(h, { status: 'DRY_RUN_REQUESTED' });
    h.runner = {
      ...h.runner,
      dryRun: async () => {
        // The operator cancels while the dry run runs.
        const row = h.repository.rows.get(id)!;
        await h.repository.transition({
          id,
          from: [row.status],
          to: 'CANCELLED',
          now: h.now,
          patch: { errorCode: 'CANCELLED' },
        });
        return { report: dryRunReport, legacyRunId: null };
      },
    };
    await h.executor.tick();
    const row = h.repository.rows.get(id)!;
    expect(row.status).toBe('CANCELLED');
    expect(row.dryRunSha256).toBeNull();
    expect(row.keyCiphertext).toBeNull();
  });

  it('claims nothing while LEGACY_MIGRATION_ENABLED is off, and still reports a live loop', async () => {
    const repository = new InMemoryLegacyNxpkgImports();
    const executor = new LegacyMigrationExecutor({
      repository,
      workspaces: new InMemoryMigrationWorkspaces(),
      clock: { now: () => new Date('2026-10-10T10:00:00.000Z') },
      tickIntervalMs: 1000,
      enabled: false,
      leaseOwner: 'migration:off',
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    } as never);
    repository.put({
      ...emptyRow(),
      keyCiphertext: 's',
      keyKeyId: 'k',
      keyKind: 'KEY_FILE',
    } as never);
    await executor.tick();
    expect([...repository.rows.values()][0]?.claimedBy).toBeNull();
    expect(executor.isFresh(new Date('2026-10-10T10:00:01.000Z').getTime())).toBe(true);
  });
});
