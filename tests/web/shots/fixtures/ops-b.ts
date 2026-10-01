import {
  FEATURE_FLAGS,
  RECOVERY_CONFIRMATION_PHRASE,
  SETTINGS,
  TEMPLATES,
  adminListResponseSchema,
  backupHistoryResponseSchema,
  backupStatusResponseSchema,
  featureFlagListResponseSchema,
  monitorProfileResponseSchema,
  notificationDetailResponseSchema,
  notificationListResponseSchema,
  operationalEventListResponseSchema,
  opsLogGroupResponseSchema,
  recoveryCapabilitiesResponseSchema,
  recoveryListResponseSchema,
  roleListResponseSchema,
  settingListResponseSchema,
  supportFaqListSchema,
  systemDiagnosticsResponseSchema,
  templateListResponseSchema,
  ticketAssigneesResponseSchema,
  ticketCategoryListResponseSchema,
  ticketDetailResponseSchema,
  ticketListResponseSchema,
  templateDefinition,
  type TemplateKey,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import { ago, fixture, type ShotFixture } from '../fixture.ts';

/*
 * Page family OPS-B: settings, features, reminders, content, support, tickets,
 * the ops group, alerts, notifications, system, recovery.
 *
 * Built from the frozen registries where one exists (settings, flags, templates), so a
 * screenshot shows the real catalogue rather than a sample of it.
 */

type Json = Record<string, unknown>;

/** Every registered setting at its default — the real settings page, unedited. */
const SETTINGS_AT_DEFAULT = SETTINGS.map((definition) => ({
  key: definition.key,
  value: definition.defaultValue,
  source: 'DEFAULT',
  version: null,
  updatedAt: null,
  updatedByAdminId: null,
  description: definition.description,
  zeroMeaning: definition.zeroMeaning,
  mutability: definition.mutability,
  classification: definition.classification,
  configures: definition.configures,
  consumer: definition.consumer,
  storedValueInvalid: false,
}));

/** Two settings an operator has already changed, so some rows read as set here. */
const EDITED: Readonly<Record<string, unknown>> = {
  'reminders.expiry_first_days': 3,
  'sales.payment_window_minutes': 45,
};

const SETTINGS_IN_USE = SETTINGS_AT_DEFAULT.map((row) =>
  row.key in EDITED
    ? {
        ...row,
        value: EDITED[row.key],
        source: 'TENANT',
        version: 3,
        updatedAt: ago(60 * 26),
        updatedByAdminId: '01a05e35-c9ad-7e93-bef3-1ed9b55292c8',
      }
    : row,
);

/** Every registered flag, two in three on, with the settings each one governs. */
const FLAGS = FEATURE_FLAGS.map((definition, index) => {
  const enabled = index % 3 !== 2;
  return {
    key: definition.key,
    enabled,
    source: index % 2 === 0 ? 'TENANT' : 'DEFAULT',
    version: index % 2 === 0 ? 2 : null,
    updatedAt: index % 2 === 0 ? ago(60 * 24 * (index + 1)) : null,
    updatedByAdminId: null,
    reason: null,
    description: definition.description,
    blastRadius: definition.blastRadius,
    configuration: SETTINGS_IN_USE.filter((row) =>
      (definition.configuredBy as readonly string[]).includes(row.key),
    ).map((row) => ({ ...row, inert: !enabled })),
  };
});

/** Every registered template with its Persian default body; one customised. */
const CUSTOMISED: Readonly<Record<string, string>> = {
  'bot.start.welcome': 'سلام 👋\nبه فروشگاه ما خوش آمدید. برای شروع «خرید سرویس» را بزنید.',
};

const TEMPLATE_VIEWS = TEMPLATES.map((definition) => {
  const body = (CATALOGUE_FA as Readonly<Record<string, string>>)[definition.key] ?? '—';
  const override = CUSTOMISED[definition.key] ?? null;
  return {
    key: definition.key,
    locale: 'fa',
    description: definition.description,
    format: definition.format,
    placeholders: definition.placeholders.map((placeholder) => ({ ...placeholder })),
    maxLength: templateDefinition(definition.key as TemplateKey).maxLength ?? 4096,
    body: override ?? body,
    overrideBody: override,
    defaultBody: body,
    source: override === null ? 'DEFAULT' : 'TENANT',
    overrideSuppressed: false,
    version: override === null ? null : 2,
    revision: override === null ? null : 2,
    updatedAt: override === null ? null : ago(60 * 30),
    updatedByAdminId: null,
  };
});

export const EVENTS = [
  {
    id: '01a05e35-c9ad-7e93-bef3-1ed9b5529e01',
    code: 'admin.roles_changed',
    severity: 'WARN',
    message: 'Roles for administrator "sara" changed from [support] to [operator].',
    context: null,
    occurrenceCount: 1,
    firstSeenAt: ago(45),
    lastSeenAt: ago(45),
    correlationId: 'c1',
    recoversCode: null,
    resolvedAt: null,
    resolvedByEventId: null,
  },
  {
    id: '01a05e35-c9ad-7e93-bef3-1ed9b5529e02',
    code: 'panel.monitor.tenant_budget_exceeded',
    severity: 'ERROR',
    message: 'The tenant probe budget cannot keep 84 panels inside the freshness window.',
    context: null,
    occurrenceCount: 12,
    firstSeenAt: ago(600),
    lastSeenAt: ago(4),
    correlationId: 'c2',
    recoversCode: null,
    resolvedAt: null,
    resolvedByEventId: null,
  },
];

// --- Support ------------------------------------------------------------------

function faq(id: string, question: string, answer: string, sortOrder: number, over: Json = {}) {
  return {
    id,
    question,
    answer,
    status: 'ACTIVE',
    sortOrder,
    version: 2,
    createdAt: ago(60 * 24 * 40),
    updatedAt: ago(60 * 24 * (sortOrder / 10 + 2)),
    ...over,
  };
}

const FAQS = [
  faq(
    '01a05e35-c9ad-7e93-bef3-1ed9b5520f01',
    'چطور سرویسم را تمدید کنم؟',
    'از منوی «سرویس‌های من» سرویس را انتخاب و «تمدید» را بزنید.',
    10,
  ),
  faq(
    '01a05e35-c9ad-7e93-bef3-1ed9b5520f02',
    'لینک اتصال کار نمی‌کند، چه کنم؟',
    'برنامهٔ اتصال را به‌روز کنید و لینک را دوباره از ربات بگیرید.',
    20,
  ),
  faq(
    '01a05e35-c9ad-7e93-bef3-1ed9b5520f03',
    'آیا بازگشت وجه ممکن است؟',
    'تا ۲۴ ساعت پس از خرید، اگر سرویس استفاده نشده باشد.',
    30,
    { status: 'INACTIVE' },
  ),
];

// --- Tickets ------------------------------------------------------------------

const ADMIN_ID = '01a05e35-c9ad-7e93-bef3-1ed9b55292c8';
const CATEGORY_TECH = '01a05e35-c9ad-7e93-bef3-1ed9b5521c01';
const CATEGORY_BILLING = '01a05e35-c9ad-7e93-bef3-1ed9b5521c02';
export const SHOT_TICKET_ID = '01a05e35-c9ad-7e93-bef3-1ed9b5522a01';

function ticket(
  id: string,
  number: number,
  subject: string | null,
  status: string,
  priority: string,
  minutes: number,
  over: Json = {},
): Json {
  return {
    id,
    number,
    status,
    priority,
    categoryId: CATEGORY_TECH,
    categoryTitle: 'مشکل فنی و اتصال',
    subject,
    customerId: '019210ab-cdef-7012-8345-6789abcdef01',
    customerTelegramUserId: '5551234567',
    customerUsername: 'ali_tehran',
    customerDisplayName: 'علی محمدی',
    assignedAdminId: null,
    assignedAdminUsername: null,
    serviceId: null,
    orderId: null,
    paymentId: null,
    createdAt: ago(minutes + 120),
    updatedAt: ago(minutes),
    lastMessageAt: ago(minutes),
    closedAt: null,
    ...over,
  };
}

const TICKETS = [
  ticket(SHOT_TICKET_ID, 1042, 'اتصال سرویس قطع می‌شود', 'WAITING_FOR_SUPPORT', 'HIGH', 12, {
    serviceId: '01a05e35-c9ad-7e93-bef3-1ed9b5523b01',
  }),
  ticket(
    '01a05e35-c9ad-7e93-bef3-1ed9b5522a02',
    1041,
    'پرداخت انجام شد ولی سفارش ثبت نشد',
    'OPEN',
    'URGENT',
    38,
    {
      categoryId: CATEGORY_BILLING,
      categoryTitle: 'پرداخت و صورتحساب',
      customerDisplayName: 'مریم احمدی',
      customerUsername: 'maryam_a',
      customerTelegramUserId: '5559876543',
    },
  ),
  ticket(
    '01a05e35-c9ad-7e93-bef3-1ed9b5522a03',
    1039,
    'درخواست تغییر لوکیشن',
    'WAITING_FOR_CUSTOMER',
    'NORMAL',
    140,
    {
      assignedAdminId: ADMIN_ID,
      assignedAdminUsername: 'owner',
      customerDisplayName: 'حامد رضایی',
      customerUsername: null,
      customerTelegramUserId: '5554443322',
    },
  ),
  ticket('01a05e35-c9ad-7e93-bef3-1ed9b5522a04', 1033, null, 'CLOSED', 'LOW', 60 * 26, {
    closedAt: ago(60 * 25),
    customerDisplayName: 'سارا کریمی',
    customerUsername: 'sara_k',
    customerTelegramUserId: '5551112233',
    assignedAdminId: ADMIN_ID,
    assignedAdminUsername: 'owner',
  }),
];

const TICKET_CATEGORIES = [
  {
    id: CATEGORY_TECH,
    title: 'مشکل فنی و اتصال',
    sortOrder: 10,
    isActive: true,
    createdAt: ago(60 * 24 * 90),
    updatedAt: ago(60 * 24 * 90),
  },
  {
    id: CATEGORY_BILLING,
    title: 'پرداخت و صورتحساب',
    sortOrder: 20,
    isActive: true,
    createdAt: ago(60 * 24 * 90),
    updatedAt: ago(60 * 24 * 90),
  },
  {
    id: '01a05e35-c9ad-7e93-bef3-1ed9b5521c03',
    title: 'پیشنهاد',
    sortOrder: 30,
    isActive: false,
    createdAt: ago(60 * 24 * 90),
    updatedAt: ago(60 * 24 * 10),
  },
];

function message(id: string, sender: string, minutes: number, over: Json = {}): Json {
  return {
    id,
    senderType: sender,
    authorAdminId: null,
    authorAdminUsername: null,
    body: null,
    systemEvent: null,
    attachment: null,
    delivery: null,
    attachmentDelivery: null,
    createdAt: ago(minutes),
    ...over,
  };
}

const TICKET_DETAIL = {
  ticket: TICKETS[0],
  customer: {
    id: '019210ab-cdef-7012-8345-6789abcdef01',
    telegramUserId: '5551234567',
    username: 'ali_tehran',
    displayName: 'علی محمدی',
    status: 'ACTIVE',
  },
  messages: [
    message('01a05e35-c9ad-7e93-bef3-1ed9b5524d01', 'CUSTOMER', 132, {
      body: 'سلام، از دیشب اتصال هر چند دقیقه قطع می‌شود. سرویس یک‌ماهه دارم.',
    }),
    message('01a05e35-c9ad-7e93-bef3-1ed9b5524d02', 'ADMIN', 95, {
      authorAdminId: ADMIN_ID,
      authorAdminUsername: 'owner',
      body: 'سلام، لطفاً نام برنامه و نسخهٔ آن را بفرستید تا بررسی کنیم.',
      delivery: 'DELIVERED',
    }),
    message('01a05e35-c9ad-7e93-bef3-1ed9b5524d03', 'CUSTOMER', 40, {
      body: 'برنامه v2rayNG نسخهٔ ۱٫۸ است. تصویر خطا را هم فرستادم.',
      attachment: {
        kind: 'PHOTO',
        mimeType: 'image/jpeg',
        fileName: 'error.jpg',
        fileSize: 184320,
      },
    }),
    message('01a05e35-c9ad-7e93-bef3-1ed9b5524d04', 'SYSTEM', 30, {
      systemEvent: 'REOPENED_BY_SUPPORT',
    }),
    message('01a05e35-c9ad-7e93-bef3-1ed9b5524d05', 'ADMIN', 12, {
      authorAdminId: ADMIN_ID,
      authorAdminUsername: 'owner',
      body: 'لینک اشتراک شما دوباره ساخته شد. لطفاً از منوی «سرویس‌های من» لینک تازه را بگیرید.',
      delivery: 'PENDING',
    }),
  ],
};

// --- Ops group, notifications -------------------------------------------------

const OPS_BOT = { id: '01a05e35-c9ad-7e93-bef3-1ed9b5525e01', username: 'nexa_store_bot' };

const OPS_GROUP = {
  connection: 'CONNECTED',
  group: {
    title: 'گزارش‌های نکسا',
    bot: OPS_BOT,
    connectedAt: ago(60 * 24 * 12),
    disconnectedAt: null,
  },
  health: 'HEALTHY',
  problems: [],
  checkedAt: ago(9),
  lastDeliveredAt: ago(4),
  topics: [
    { category: 'SYSTEM', state: 'READY', lastDeliveredAt: ago(4), recreatedCount: 0 },
    { category: 'PAYMENTS', state: 'READY', lastDeliveredAt: ago(22), recreatedCount: 0 },
  ],
  queue: { pending: 2, preserved: 0 },
  laneEnabled: true,
  pendingCodeExpiresAt: null,
  bots: [OPS_BOT],
  manual: { configured: false, inUse: false },
};

function notification(
  id: string,
  status: string,
  templateKey: string,
  minutes: number,
  over: Json = {},
): Json {
  return {
    id,
    kind: 'OPERATIONAL_EVENT',
    status,
    templateKey,
    attemptCount: status === 'PENDING' ? 0 : 1,
    maxAttempts: 5,
    createdAt: ago(minutes),
    lastAttemptAt: status === 'PENDING' ? null : ago(minutes),
    completedAt: status === 'SENT' ? ago(minutes) : null,
    correlationId: null,
    ...over,
  };
}

const NOTIFICATIONS = [
  notification('01a05e35-c9ad-7e93-bef3-1ed9b5526f01', 'SENT', 'event.panel.unreachable', 4),
  notification(
    '01a05e35-c9ad-7e93-bef3-1ed9b5526f02',
    'SENT',
    'ops.financial.payment_confirmed',
    22,
  ),
  notification('01a05e35-c9ad-7e93-bef3-1ed9b5526f03', 'FAILED', 'event.panel.degraded', 55, {
    attemptCount: 5,
  }),
  notification('01a05e35-c9ad-7e93-bef3-1ed9b5526f04', 'SENT', 'event.admin.roles_changed', 45),
  notification('01a05e35-c9ad-7e93-bef3-1ed9b5526f05', 'SENT', 'ops.financial.refund_issued', 130),
  notification('01a05e35-c9ad-7e93-bef3-1ed9b5526f06', 'SENT', 'event.backup.succeeded', 60 * 6),
];

// --- System -------------------------------------------------------------------

const DIAGNOSTICS = {
  generatedAt: ago(0),
  outbox: {
    pending: 3,
    oldestPendingAt: ago(2),
    failing: 1,
    exhausted: 0,
    failingSample: [
      {
        id: '01a05e35-c9ad-7e93-bef3-1ed9b5527a01',
        eventType: 'order.paid',
        aggregateType: 'order',
        attempts: 3,
        occurredAt: ago(18),
        lastError: 'connect ETIMEDOUT 10.0.0.12:443',
        nextAttemptAt: ago(-4),
        exhausted: false,
      },
    ],
  },
  provisioning: {
    counts: { UNKNOWN_OUTCOME: 1, LEASE_EXPIRED: 0, RETRYING: 2, UNANNOUNCED: 0 },
    sample: [
      {
        operationId: '01a05e35-c9ad-7e93-bef3-1ed9b5527b01',
        serviceId: '01a05e35-c9ad-7e93-bef3-1ed9b5523b01',
        type: 'PROVISION',
        state: 'UNKNOWN',
        reason: 'UNKNOWN_OUTCOME',
        attempts: 1,
        nextAttemptAt: null,
        createdAt: ago(70),
        updatedAt: ago(64),
      },
      {
        operationId: '01a05e35-c9ad-7e93-bef3-1ed9b5527b02',
        serviceId: '01a05e35-c9ad-7e93-bef3-1ed9b5523b02',
        type: 'RENEW',
        state: 'PLANNED',
        reason: 'RETRYING',
        attempts: 2,
        nextAttemptAt: ago(-3),
        createdAt: ago(25),
        updatedAt: ago(6),
      },
    ],
  },
};

const MONITOR = {
  monitor: {
    enabled: true,
    tickMs: 30000,
    healthyIntervalMs: 180000,
    retryableIntervalMs: 120000,
    nonRetryableIntervalMs: 3600000,
    batchSize: 50,
    concurrency: 4,
    tenantsPerTick: 10,
    probeTenantLimit: 30,
    probeTenantWindowMs: 300000,
    probeCooldownMs: 10000,
    budgetReservePercent: 40,
    freshForMs: 900000,
    tenantFreshPanelCeiling: 60,
    installationFreshPanelCeiling: 1000,
    tenantTurnCeiling: 20,
    schedulerCapacityExceeded: false,
  },
};

function admin(id: string, username: string, displayName: string, over: Json = {}): Json {
  return {
    id,
    username,
    displayName,
    status: 'ACTIVE',
    telegramUserId: null,
    roleKeys: ['support'],
    createdAt: ago(60 * 24 * 200),
    lastLoginAt: ago(60 * 3),
    ...over,
  };
}

const ADMINS = [
  admin(ADMIN_ID, 'owner', 'مدیر اصلی', {
    roleKeys: ['owner'],
    telegramUserId: '5550001111',
    lastLoginAt: ago(5),
  }),
  admin('01a05e35-c9ad-7e93-bef3-1ed9b5528c02', 'sara', 'سارا نوری', { roleKeys: ['operator'] }),
  admin('01a05e35-c9ad-7e93-bef3-1ed9b5528c03', 'support-2', 'پشتیبان دوم', {
    status: 'DISABLED',
    lastLoginAt: ago(60 * 24 * 21),
  }),
];

const ROLES = [
  { key: 'owner', name: 'مالک', isSystem: true, permissions: [] },
  { key: 'operator', name: 'اپراتور', isSystem: true, permissions: [] },
  { key: 'support', name: 'پشتیبان', isSystem: true, permissions: [] },
];

// --- Recovery -----------------------------------------------------------------

function run(id: string, minutes: number, over: Json = {}): Json {
  return {
    id,
    trigger: 'SCHEDULED',
    state: 'SUCCEEDED',
    stage: 'CLEANUP',
    startedAt: ago(minutes),
    finishedAt: ago(minutes - 3),
    dumpBytes: '48234496',
    archiveBytes: '12582912',
    checksum: 'a3f5c9e1b7d2408f6e1c3b5a79d0e2f4c6b8a1d3e5f70912b4c6d8e0f2a4b6c8',
    verifiedAt: ago(minutes - 2),
    deliveryState: 'SUCCEEDED',
    deliveryAttemptedAt: ago(minutes - 2),
    deliveryDetailPresent: true,
    failureCode: null,
    cleanupOk: true,
    cleanupLeftovers: 0,
    archiveAvailable: true,
    ...over,
  };
}

const RUNS = [
  run('01a05e35-c9ad-7e93-bef3-1ed9b5529a01', 90),
  run('01a05e35-c9ad-7e93-bef3-1ed9b5529a02', 60 * 7, { trigger: 'MANUAL' }),
  run('01a05e35-c9ad-7e93-bef3-1ed9b5529a03', 60 * 13, { deliveryState: 'OUTCOME_UNKNOWN' }),
  run('01a05e35-c9ad-7e93-bef3-1ed9b5529a04', 60 * 19, {
    state: 'FAILED',
    stage: 'VERIFY_RESTORE',
    verifiedAt: null,
    deliveryState: 'NOT_ATTEMPTED',
    deliveryAttemptedAt: null,
    deliveryDetailPresent: false,
    failureCode: 'RESTORE_FAILED',
    archiveAvailable: false,
  }),
  run('01a05e35-c9ad-7e93-bef3-1ed9b5529a05', 60 * 25, { archiveAvailable: false }),
];

const RECOVERIES = [
  {
    id: '01a05e35-c9ad-7e93-bef3-1ed9b5529b01',
    source: 'UPLOAD',
    state: 'SUCCEEDED',
    stage: 'DONE',
    createdAt: ago(60 * 24 * 9),
    updatedAt: ago(60 * 24 * 9 - 40),
    requestedBy: 'owner',
    backupId: '01a05e35-c9ad-7e93-bef3-1ed9b5529a09',
    artifactChecksum: 'b4e6d8f0a2c4e6f8b0d2e4f6a8c0e2f4b6d8f0a2c4e6f8b0d2e4f6a8c0e2f4b6',
    failureCode: null,
    correlationId: null,
    upload: null,
    verification: null,
    restoreTest: null,
    confirmedAt: ago(60 * 24 * 9 - 10),
    confirmationExpiresAt: null,
    preRestoreBackupId: null,
    cutoverAt: ago(60 * 24 * 9 - 35),
    displacedDatabase: 'nexa_pre_restore_01a05e35',
    finishedAt: ago(60 * 24 * 9 - 40),
  },
];

export const OPS_B: readonly ShotFixture[] = [
  fixture('/settings', settingListResponseSchema, { settings: SETTINGS_IN_USE }),
  fixture('/features', featureFlagListResponseSchema, { flags: FLAGS }),
  fixture('/templates', templateListResponseSchema, { templates: TEMPLATE_VIEWS }),
  fixture('/support/faqs', supportFaqListSchema, { items: FAQS }),
  fixture('/tickets', ticketListResponseSchema, { tickets: TICKETS, nextCursor: null }),
  fixture('/tickets/assignees', ticketAssigneesResponseSchema, {
    admins: [
      { id: ADMIN_ID, username: 'owner', displayName: 'مدیر اصلی' },
      { id: '01a05e35-c9ad-7e93-bef3-1ed9b5528c02', username: 'sara', displayName: 'سارا نوری' },
    ],
  }),
  fixture('/tickets/:id', ticketDetailResponseSchema, TICKET_DETAIL),
  fixture('/ticket-categories', ticketCategoryListResponseSchema, {
    categories: TICKET_CATEGORIES,
  }),
  fixture('/ops-group', opsLogGroupResponseSchema, { opsGroup: OPS_GROUP }),
  fixture('/ops-log', operationalEventListResponseSchema, { events: EVENTS, nextCursor: null }),
  fixture('/notifications', notificationListResponseSchema, {
    notifications: NOTIFICATIONS,
    nextCursor: null,
  }),
  fixture('/notifications/:id', notificationDetailResponseSchema, {
    notification: NOTIFICATIONS[2],
    attempts: [
      {
        attemptNumber: 1,
        transport: 'TELEGRAM',
        outcome: 'FAILED_RETRYABLE',
        startedAt: ago(55),
        finishedAt: ago(55),
        errorCode: 'telegram.429',
        errorMessage: 'Too Many Requests: retry after 12',
        retryAfterMs: 12000,
      },
    ],
    releasedClaims: [],
  }),
  fixture('/system/diagnostics', systemDiagnosticsResponseSchema, DIAGNOSTICS),
  fixture('/system/monitor', monitorProfileResponseSchema, MONITOR),
  fixture('/admins', adminListResponseSchema, { admins: ADMINS }),
  fixture('/roles', roleListResponseSchema, { roles: ROLES }),
  fixture('/backups/status', backupStatusResponseSchema, {
    scheduleEnabled: true,
    intervalMs: 6 * 60 * 60 * 1000,
    lastSucceededAt: ago(87),
    running: null,
    unknownDeliveries: 1,
    quiesced: false,
  }),
  fixture('/backups', backupHistoryResponseSchema, { runs: RUNS, nextCursor: null }),
  fixture('/recoveries/capabilities', recoveryCapabilitiesResponseSchema, {
    uploadEnabled: true,
    maxUploadBytes: 2 * 1024 * 1024 * 1024,
    foreignInstallationSupported: false,
    confirmationPhrase: RECOVERY_CONFIRMATION_PHRASE,
    confirmationTtlMs: 15 * 60 * 1000,
  }),
  fixture('/recoveries', recoveryListResponseSchema, { recoveries: RECOVERIES, nextCursor: null }),
];
