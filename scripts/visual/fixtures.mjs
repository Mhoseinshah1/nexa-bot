const iso = (offsetMinutes = 0) =>
  new Date(Date.parse('2026-09-06T08:00:00.000Z') - offsetMinutes * 60_000).toISOString();

const health = (over = {}) => ({
  state: 'HEALTHY',
  checkedAt: iso(2),
  latencyMs: 42,
  failure: null,
  status: 200,
  providerVersion: '0.8.4',
  lastHealthyAt: iso(2),
  stale: false,
  ...over,
});

const credential = (configured, at) => ({ configured, lastReplacedAt: configured ? at : null });

const panel = (id, name, over = {}) => ({
  id,
  name,
  providerType: 'marzban',
  providerName: 'Marzban',
  baseUrl: `https://${name.toLowerCase().replace(/ /g, '-')}.example/api`,
  status: 'ACTIVE',
  capabilities: ['HEALTH_CHECK'],
  credentials: {
    username: credential(true, iso(60 * 24 * 30)),
    password: credential(true, iso(60 * 24 * 30)),
    apiToken: credential(false, null),
  },
  health: health(),
  createdAt: iso(60 * 24 * 200),
  updatedAt: iso(60 * 24 * 3),
  ...over,
});

export const PANELS = [
  panel('01a05e35-c9ad-7e93-bef3-1ed9b55292c8', 'Frankfurt A'),
  panel('01a05e35-c9ad-7e93-bef3-1ed9b55292c9', 'Frankfurt B', {
    health: health({ state: 'DEGRADED', latencyMs: 2140, failure: null }),
  }),
  panel('01a05e35-c9ad-7e93-bef3-1ed9b55292ca', 'Amsterdam', {
    providerType: 'sanaei',
    providerName: '3X-UI (MHSanaei)',
    health: health({
      state: 'UNREACHABLE',
      failure: 'TIMEOUT',
      status: null,
      latencyMs: null,
      lastHealthyAt: iso(190),
      stale: true,
    }),
    credentials: {
      username: credential(true, iso(60 * 24 * 12)),
      password: credential(false, null),
      apiToken: credential(true, iso(60 * 24 * 2)),
    },
  }),
  panel('01a05e35-c9ad-7e93-bef3-1ed9b55292cb', 'Tehran Edge', {
    status: 'DISABLED',
    health: health({
      state: 'DISABLED',
      checkedAt: null,
      latencyMs: null,
      status: null,
      providerVersion: null,
    }),
  }),
  panel('01a05e35-c9ad-7e93-bef3-1ed9b55292cc', 'Stockholm', {
    providerType: 'sanaei',
    providerName: '3X-UI (MHSanaei)',
    health: health({
      state: 'AUTH_FAILED',
      failure: 'AUTHENTICATION_REQUIRES_INTERACTION',
      status: 401,
      latencyMs: 88,
    }),
  }),
];

const setting = (key, value, over = {}) => ({
  key,
  value,
  source: 'DEFAULT',
  version: null,
  updatedAt: null,
  updatedByAdminId: null,
  description: `The ${key} setting.`,
  zeroMeaning: 'NOT_APPLICABLE',
  mutability: 'RUNTIME',
  classification: 'PUBLIC',
  configures: null,
  consumer: 'ACTIVE',
  storedValueInvalid: false,
  ...over,
});

export const SETTINGS = [
  setting('ops.notifications.telegram_chat_id', '-1001234567890', {
    zeroMeaning: 'DISABLES',
    classification: 'SENSITIVE',
    configures: 'ops_notifications',
    source: 'TENANT',
    version: 3,
    updatedAt: iso(60 * 24),
    description:
      'The Telegram chat that receives operational notifications. Empty means no destination is configured and nothing is sent.',
  }),
  setting('ops.notifications.max_attempts', 5, {
    configures: 'ops_notifications',
    description:
      'How many times one notification may be attempted before it is abandoned as failed.',
  }),
  setting('sales.currency', 'IRT', {
    consumer: 'PLANNED',
    description: 'The currency this tenant sells in.',
  }),
  setting('support.accounts', ['@NexaSupport', '@NexaSupport2'], {
    consumer: 'PLANNED',
    zeroMeaning: 'DISABLES',
    source: 'TENANT',
    version: 2,
    updatedAt: iso(120),
    description: 'The support accounts offered to customers, in the order they are offered.',
  }),
  setting(
    'telegram.channels',
    [
      { handle: '@NexaChannel', mandatory: true },
      { handle: '@NexaNews', mandatory: false },
    ],
    {
      consumer: 'PLANNED',
      zeroMeaning: 'DISABLES',
      source: 'TENANT',
      version: 1,
      updatedAt: iso(300),
      description:
        'The channels shown to customers, in order, each flagged as required membership or optional.',
    },
  ),
  setting(
    'wallet.topup.minimum',
    { amountMinor: '20000', currency: 'IRT' },
    {
      consumer: 'PLANNED',
      zeroMeaning: 'DISABLES',
      description: 'The smallest wallet top-up accepted, as an explicit amount and currency.',
    },
  ),
];

export const EVENTS = [
  {
    id: 'e1',
    code: 'admin.roles_change',
    severity: 'WARN',
    message: 'Roles for administrator "sara" changed from [support] to [operator].',
    context: null,
    occurrenceCount: 1,
    firstSeenAt: iso(45),
    lastSeenAt: iso(45),
    correlationId: 'c1',
    recoversCode: null,
    resolvedAt: null,
    resolvedByEventId: null,
  },
  {
    id: 'e2',
    code: 'panel.monitor.tenant_budget_exceeded',
    severity: 'ERROR',
    message: 'The tenant probe budget cannot keep 84 panels inside the freshness window.',
    context: null,
    occurrenceCount: 12,
    firstSeenAt: iso(600),
    lastSeenAt: iso(4),
    correlationId: 'c2',
    recoversCode: null,
    resolvedAt: null,
    resolvedByEventId: null,
  },
  {
    id: 'e3',
    code: 'auth.login_locked_out',
    severity: 'WARN',
    message: 'Sign-in locked out after repeated failures.',
    context: null,
    occurrenceCount: 3,
    firstSeenAt: iso(2000),
    lastSeenAt: iso(1400),
    correlationId: 'c3',
    recoversCode: null,
    resolvedAt: iso(1300),
    resolvedByEventId: 'e9',
  },
];

export const NOTIFICATIONS = [
  {
    id: 'n1',
    kind: 'OPERATIONAL_EVENT',
    status: 'SENT',
    templateKey: 'event.panel.unreachable',
    attemptCount: 1,
    maxAttempts: 5,
    createdAt: iso(90),
    lastAttemptAt: iso(89),
    completedAt: iso(89),
    correlationId: 'c1',
  },
  {
    id: 'n2',
    kind: 'OPERATIONAL_EVENT',
    status: 'FAILED',
    templateKey: 'event.monitor.capacity',
    attemptCount: 5,
    maxAttempts: 5,
    createdAt: iso(400),
    lastAttemptAt: iso(180),
    completedAt: iso(180),
    correlationId: 'c2',
  },
  {
    id: 'n3',
    kind: 'OPERATIONAL_EVENT',
    status: 'PENDING',
    templateKey: 'event.panel.unreachable',
    attemptCount: 0,
    maxAttempts: 5,
    createdAt: iso(3),
    lastAttemptAt: null,
    completedAt: null,
    correlationId: 'c3',
  },
];

/**
 * The archive browser's page.
 *
 * Its own rows, not the live ones with a flag: `/panels?archived=only` is a
 * different collection, and a fixture that returned the working fleet here
 * would photograph exactly the bug the archived mode was added to remove.
 */
export const ARCHIVED_PANELS_PAGE = {
  panels: [
    panel('01a05e35-c9ad-7e93-bef3-1ed9b55292f1', 'Retired — Frankfurt C', {
      status: 'ARCHIVED',
      health: health({ state: 'DISABLED', latencyMs: null, failure: null }),
    }),
    panel('01a05e35-c9ad-7e93-bef3-1ed9b55292f2', 'Retired — Helsinki A', {
      status: 'ARCHIVED',
      health: health({ state: 'DISABLED', latencyMs: null, failure: null }),
    }),
  ],
  nextCursor: null,
};

/**
 * A backup run, shaped by `backupRunSummarySchema`.
 *
 * `dumpBytes` and `archiveBytes` are STRINGS because the wire carries a `bigint`
 * as one. A fixture that sends numbers parses fine in JavaScript and would hide
 * a real client defect: the page formats them through a helper that takes the
 * string form, and a number reaching it is how `NaN` gets rendered as a size.
 */
const backupRun = (id, over = {}) => ({
  id,
  trigger: 'SCHEDULED',
  state: 'SUCCEEDED',
  stage: 'CLEANUP',
  startedAt: iso(180),
  finishedAt: iso(177),
  dumpBytes: '184320512',
  archiveBytes: '61440128',
  checksum: 'a3f1c9d2b4e5076889aabbccddeeff00112233445566778899aabbccddeeff00',
  verifiedAt: iso(178),
  deliveryState: 'SUCCEEDED',
  deliveryAttemptedAt: iso(177),
  deliveryDetailPresent: false,
  failureCode: null,
  cleanupOk: true,
  cleanupLeftovers: 0,
  archiveAvailable: true,
  ...over,
});

/** A recovery request, shaped by `recoveryRequestSummarySchema`. */
const recovery = (id, over = {}) => ({
  id,
  source: 'UPLOAD',
  state: 'UPLOADED',
  stage: 'PARSE_CONTAINER',
  createdAt: iso(20),
  updatedAt: iso(20),
  requestedBy: 'owner',
  backupId: null,
  artifactChecksum: null,
  failureCode: null,
  correlationId: '01a05e35-c9ad-7e93-bef3-1ed9b5529500',
  upload: {
    sizeBytes: 61440128,
    archiveSha256: 'b'.repeat(64),
    clientFilename: 'nexa-backup-2026-09-09.nxb',
  },
  verification: null,
  restoreTest: null,
  confirmedAt: null,
  confirmationExpiresAt: null,
  preRestoreBackupId: null,
  cutoverAt: null,
  displacedDatabase: null,
  finishedAt: null,
  ...over,
});

export const ROUTES = {
  '/auth/session': {
    admin: {
      id: '01a05e35-c9ad-7e93-bef3-1ed9b55292c8',
      username: 'owner',
      displayName: 'مدیر اصلی',
      status: 'ACTIVE',
      telegramUserId: null,
      roleKeys: ['owner'],
      createdAt: iso(60 * 24 * 400),
      lastLoginAt: iso(5),
    },
    permissions: [
      'panels.view',
      'panels.edit',
      'panels.credentials.rotate',
      'settings.view',
      'settings.edit',
      'templates.view',
      'templates.edit',
      'opslog.view',
      'admins.view',
      'users.view',
      'services.view',
      'orders.view',
      'catalog.view',
      'payments.view',
      'resellers.view',
      'reports.view',
      // The four disaster-recovery keys. Without them the recovery route
      // photographs its own refusals, which is a real screen but not the one
      // these captures exist to check.
      'backup.view',
      'backup.run',
      'backup.download',
      'recovery.restore',
    ],
    expiresAt: iso(-60 * 8),
  },
  '/system/readiness': {
    status: 'ok',
    dependencies: [
      { name: 'postgres', status: 'up', latencyMs: 3 },
      { name: 'redis', status: 'up', latencyMs: 1 },
      { name: 'migrations', status: 'up', detail: '27 applied' },
      { name: 'outbox-relay', status: 'up', latencyMs: 12 },
    ],
  },
  '/system/monitor': {
    monitor: {
      enabled: true,
      tickMs: 30000,
      healthyIntervalMs: 180000,
      retryableIntervalMs: 120000,
      nonRetryableIntervalMs: 3600000,
      batchSize: 150,
      concurrency: 4,
      tenantsPerTick: 10,
      probeTenantLimit: 100,
      probeTenantWindowMs: 300000,
      probeCooldownMs: 10000,
      budgetReservePercent: 40,
      freshForMs: 900000,
      tenantFreshPanelCeiling: 60,
      installationFreshPanelCeiling: 900,
      tenantTurnCeiling: 60,
      schedulerCapacityExceeded: false,
    },
  },
  '/panels': { panels: PANELS, nextCursor: 'cursor-page-2' },
  '/providers': {
    providers: [
      {
        key: 'marzban',
        canonicalName: 'Marzban',
        credentialShape: 'USERNAME_PASSWORD',
        capabilities: ['HEALTH_CHECK'],
        requiredActivationFields: [],
      },
      {
        key: 'sanaei',
        canonicalName: '3X-UI (MHSanaei)',
        credentialShape: 'TOKEN_OR_USERNAME_PASSWORD',
        capabilities: ['HEALTH_CHECK'],
        requiredActivationFields: ['subscriptionDomain'],
      },
    ],
  },
  '/settings': { settings: SETTINGS },
  '/features': {
    flags: [
      {
        key: 'ops_notifications',
        description: 'Project operational events to the operations destination.',
        enabled: true,
        source: 'TENANT',
        blastRadius: 'LOCAL',
        version: 2,
        reason: null,
        updatedAt: iso(60 * 24 * 5),
        updatedByAdminId: 'a1',
        // The governed settings travel WITH the flag, each marked inert when
        // the flag is off — the whole point of the shape.
        configuration: SETTINGS.filter((s) => s.configures === 'ops_notifications').map((s) => ({
          ...s,
          inert: false,
        })),
      },
      {
        key: 'template_overrides',
        description: 'Allow tenant-specific message templates to take effect.',
        enabled: false,
        source: 'DEFAULT',
        blastRadius: 'TENANT_WIDE',
        version: 1,
        reason: 'Held off until the copy review finishes.',
        updatedAt: iso(60 * 24 * 20),
        updatedByAdminId: null,
        configuration: [],
      },
    ],
  },
  '/templates': {
    templates: [
      {
        key: 'event.panel.unreachable',
        locale: 'fa',
        description: 'Sent when a panel stops answering.',
        format: 'PLAIN_TEXT',
        maxLength: 4096,
        body: 'پنل {panel_name} در دسترس نیست.',
        defaultBody: 'پنل {panel_name} در دسترس نیست.',
        overrideBody: null,
        source: 'DEFAULT',
        overrideSuppressed: false,
        version: null,
        revision: null,
        updatedAt: null,
        updatedByAdminId: null,
        placeholders: [
          {
            token: 'panel_name',
            type: 'STRING',
            description: 'The panel that stopped answering.',
            required: true,
            repeatable: false,
          },
        ],
      },
      {
        key: 'event.monitor.capacity',
        locale: 'fa',
        description: 'Sent when the installation cannot keep its fleet fresh.',
        format: 'PLAIN_TEXT',
        maxLength: 4096,
        body: 'ظرفیت پایش کافی نیست: {panel_count} پنل.',
        defaultBody: 'ظرفیت پایش برای {panel_count} پنل کافی نیست.',
        overrideBody: 'ظرفیت پایش کافی نیست: {panel_count} پنل.',
        source: 'TENANT',
        overrideSuppressed: false,
        version: 4,
        revision: 2,
        updatedAt: iso(60 * 24 * 9),
        updatedByAdminId: 'a2',
        placeholders: [
          {
            token: 'panel_count',
            type: 'NUMBER',
            description: 'How many panels are in the fleet.',
            required: true,
            repeatable: false,
          },
        ],
      },
    ],
  },
  // `nextCursor` is part of the response contract; a fixture without it fails
  // schema parsing in the real client and every capture of an ops-log surface
  // renders the query error state instead of the page.
  '/ops-log': { events: EVENTS, nextCursor: null },
  '/notifications': { notifications: NOTIFICATIONS, nextCursor: null },
  '/admins': {
    admins: [
      {
        id: 'a1',
        username: 'owner',
        displayName: 'مدیر اصلی',
        status: 'ACTIVE',
        telegramUserId: null,
        roleKeys: ['owner'],
        createdAt: iso(60 * 24 * 400),
        lastLoginAt: iso(5),
      },
      {
        id: 'a2',
        username: 'sara',
        displayName: 'سارا احمدی',
        status: 'ACTIVE',
        telegramUserId: null,
        roleKeys: ['operator'],
        createdAt: iso(60 * 24 * 120),
        lastLoginAt: iso(300),
      },
      {
        id: 'a3',
        username: 'reza',
        displayName: 'رضا کریمی',
        status: 'DISABLED',
        telegramUserId: null,
        roleKeys: ['support'],
        createdAt: iso(60 * 24 * 90),
        lastLoginAt: null,
      },
    ],
  },
  // --- Backup and disaster recovery ---------------------------------------
  //
  // Shaped by `backupStatusResponseSchema`, `backupHistoryResponseSchema`,
  // `recoveryCapabilitiesResponseSchema` and `recoveryListResponseSchema`. A
  // fixture that drifts from the frozen schema makes the client's `parse` throw
  // and the capture photographs a loading skeleton — which is the exact drift
  // the `stillLoading` measurement was added to catch.
  '/backups/status': {
    scheduleEnabled: true,
    intervalMs: 86400000,
    lastSucceededAt: iso(180),
    running: null,
    // Non-zero on purpose: the third delivery outcome is the one an operator
    // has to read a sentence about, so the banner is in the frame.
    unknownDeliveries: 1,
    quiesced: false,
  },
  '/backups': {
    runs: [
      backupRun('01a05e35-c9ad-7e93-bef3-1ed9b5529301', { startedAt: iso(180) }),
      backupRun('01a05e35-c9ad-7e93-bef3-1ed9b5529302', {
        startedAt: iso(1620),
        deliveryState: 'OUTCOME_UNKNOWN',
        deliveryDetailPresent: false,
      }),
      backupRun('01a05e35-c9ad-7e93-bef3-1ed9b5529303', {
        startedAt: iso(3060),
        trigger: 'MANUAL',
        // The archive pruned from local disk: the row an operator reads as
        // «فایل محلی دیگر موجود نیست» rather than as a broken link.
        archiveAvailable: false,
      }),
      backupRun('01a05e35-c9ad-7e93-bef3-1ed9b5529304', {
        startedAt: iso(4500),
        state: 'FAILED',
        stage: 'DELIVER',
        verifiedAt: null,
        finishedAt: iso(4498),
        deliveryState: 'FAILED_DEFINITIVE',
        failureCode: 'backup.delivery_failed',
        archiveAvailable: false,
      }),
      backupRun('01a05e35-c9ad-7e93-bef3-1ed9b5529305', {
        startedAt: iso(5900),
        trigger: 'PRE_RESTORE',
        cleanupOk: false,
        cleanupLeftovers: 1,
      }),
    ],
    nextCursor: null,
  },
  '/recoveries/capabilities': {
    uploadEnabled: true,
    maxUploadBytes: 2147483648,
    // The limitation this release HAS, reported rather than hidden.
    foreignInstallationSupported: false,
    confirmationPhrase: 'RESTORE NEXA',
    confirmationTtlMs: 600000,
  },
  /*
   * Four recovery requests, one per shape an operator has to be able to read at
   * a glance: a finished restore, a restore IN PROGRESS, a safe failure, and an
   * archive that was only ever verified.
   *
   * These are rows in the requests table rather than four separate screens,
   * because that is what the page is: the progress of a destructive operation is
   * durable state on a row, not a wizard step, which is the whole reason the
   * recovery survives a closed browser.
   */
  '/recoveries': {
    recoveries: [
      recovery('01a05e35-c9ad-7e93-bef3-1ed9b5529401', {
        state: 'RESTORING',
        stage: 'RESTORE_CANDIDATE',
        createdAt: iso(6),
        updatedAt: iso(1),
        backupId: '01a05e35-c9ad-7e93-bef3-1ed9b5529301',
        artifactChecksum: 'd'.repeat(64),
        confirmedAt: iso(5),
        confirmationExpiresAt: iso(-5),
        preRestoreBackupId: '01a05e35-c9ad-7e93-bef3-1ed9b5529305',
      }),
      recovery('01a05e35-c9ad-7e93-bef3-1ed9b5529402', {
        state: 'SUCCEEDED',
        stage: 'DONE',
        createdAt: iso(60 * 26),
        updatedAt: iso(60 * 25),
        backupId: '01a05e35-c9ad-7e93-bef3-1ed9b5529302',
        artifactChecksum: 'e'.repeat(64),
        confirmedAt: iso(60 * 26),
        preRestoreBackupId: '01a05e35-c9ad-7e93-bef3-1ed9b5529305',
        cutoverAt: iso(60 * 25),
        displacedDatabase: 'nexa_pre_restore_01a05e35c9ad7e93',
        finishedAt: iso(60 * 25),
      }),
      recovery('01a05e35-c9ad-7e93-bef3-1ed9b5529403', {
        state: 'FAILED',
        stage: 'CLEANUP',
        createdAt: iso(60 * 50),
        updatedAt: iso(60 * 50),
        // A SAFE failure: refused before anything destructive, and the code says
        // which check refused it.
        failureCode: 'recovery.migration_incompatible',
        finishedAt: iso(60 * 50),
      }),
      recovery('01a05e35-c9ad-7e93-bef3-1ed9b5529404', {
        state: 'RESTORE_TEST_PASSED',
        stage: 'AWAIT_CONFIRMATION',
        createdAt: iso(20),
        updatedAt: iso(18),
        backupId: '01a05e35-c9ad-7e93-bef3-1ed9b5529301',
        artifactChecksum: 'f'.repeat(64),
      }),
    ],
    nextCursor: null,
  },
};

/**
 * The two states the recovery flow's interactive pass drives through.
 *
 * Exported rather than inlined in the capture because they are response bodies
 * shaped by the frozen schemas, which is what this file is for — and because the
 * second one has to be the FIRST one advanced, not an independently written
 * object that could disagree with it about the request's own identity.
 */
export const RECOVERY_UPLOADED = recovery('01a05e35-c9ad-7e93-bef3-1ed9b5529601', {
  createdAt: iso(0),
  updatedAt: iso(0),
});

export const RECOVERY_TESTED = {
  ...RECOVERY_UPLOADED,
  state: 'RESTORE_TEST_PASSED',
  stage: 'AWAIT_CONFIRMATION',
  backupId: '01a05e35-c9ad-7e93-bef3-1ed9b5529301',
  artifactChecksum: 'a3f1c9d2b4e5076889aabbccddeeff00112233445566778899aabbccddeeff00',
  verification: {
    formatVersion: 1,
    backupId: '01a05e35-c9ad-7e93-bef3-1ed9b5529301',
    // Never the key ID itself: that names a KEK the operator holds, and a
    // browser is not a place where knowing it buys anything.
    keyId: 'held',
    decrypted: true,
    checksumMatches: true,
    databaseName: 'nexa',
    postgresVersion: '16.13',
    pgDumpVersion: 'pg_dump (PostgreSQL) 16.13',
    takenAt: iso(180),
    dumpBytes: 184320512,
    checksum: 'a3f1c9d2b4e5076889aabbccddeeff00112233445566778899aabbccddeeff00',
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
};

export const INFO = {
  name: 'nexa-bot',
  version: '0.4.0',
  commit: '7ba1837e6c2d4a1b9f0e3c5d7a8b9c0d1e2f3a4b',
  buildTime: iso(60 * 24 * 2),
  nodeVersion: 'v22.11.0',
  environment: 'production',
};
