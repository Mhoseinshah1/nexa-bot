import {
  CAPABILITY_REGISTRY_ROWS,
  adminListResponseSchema,
  PERMISSIONS,
  roleViewListResponseSchema,
  adminSessionListResponseSchema,
  auditLogListResponseSchema,
  incidentListResponseSchema,
  operationalEventListResponseSchema,
  opsLogGroupResponseSchema,
  panelHealthDashboardResponseSchema,
  panelListResponseSchema,
  panelResponseSchema,
  providerListResponseSchema,
  securityEventListResponseSchema,
} from '@nexa/contracts';
import { ago, fixture, type ShotFixture } from '../../fixture.ts';

/*
 * DEMO PARITY — the infrastructure and system family (`/panels`, `/panels/:id`,
 * `/panel-health`, `/providers`, `/ops-group`, `/alerts`, `/audit-log`, `/incidents`,
 * `/account`) fed the approved demo's own sample rows (`approved-demo.html`, `seedInf`,
 * `sys_ops`, `sys_audit`, `sys_incidents`, `sys_opsgroup`), so a side-by-side compares like
 * with like: seven panels — one unreachable, one drained, one stale and slow, one full, one
 * disabled, one never checked — the three adapters with their real capability registries,
 * a group whose bot cannot manage topics and whose backups topic was deleted.
 *
 * Only what the API has a field for, in the shapes its schemas take. Messages of the
 * operations log stay the English log lines the server writes; the alerts page keeps them
 * behind «جزئیات فنی».
 */

type Json = Record<string, unknown>;

function health(over: Json = {}): Json {
  return {
    state: 'HEALTHY',
    checkedAt: ago(2),
    latencyMs: 42,
    failure: null,
    status: 200,
    providerVersion: '0.8.4',
    lastHealthyAt: ago(2),
    unusableStreak: 0,
    stale: false,
    ...over,
  };
}

const SELLABLE: Json = {
  sellable: true,
  reason: null,
  activationComplete: true,
  missingActivationFields: [],
  connectionValidated: true,
};

function unsellable(reason: string, over: Json = {}): Json {
  return { ...SELLABLE, sellable: false, reason, ...over };
}

function capacity(maxServices: number | null, services: number, reservations: number): Json {
  const used = services + reservations;
  return {
    maxServices,
    services,
    reservations,
    used,
    available: maxServices === null ? null : Math.max(0, maxServices - used),
  };
}

function credential(set: boolean, minutes = 60 * 24 * 30): Json {
  return { configured: set, lastReplacedAt: set ? ago(minutes) : null };
}

const MARZBAN_CAPS = [
  'CREATE_USER',
  'RENEW_USER',
  'DELETE_USER',
  'DISABLE_USER',
  'ENABLE_USER',
  'READ_USAGE',
  'ADD_VOLUME',
  'ADD_TIME',
  'DELIVER_SUBSCRIPTION_LINK',
];

function panel(id: string, name: string, host: string, over: Json = {}): Json {
  return {
    id,
    name,
    providerType: 'marzban',
    providerName: 'Marzban',
    baseUrl: `https://${host}/`,
    status: 'ACTIVE',
    capabilities: MARZBAN_CAPS,
    credentials: {
      username: credential(true),
      password: credential(true, 60 * 24 * 9),
      apiToken: credential(false),
    },
    activation: {
      proxyProtocols: ['vless', 'vmess'],
      inboundTags: { vless: ['VLESS_TCP_REALITY'] },
    },
    health: health(),
    capacity: capacity(1500, 0, 0),
    sellability: SELLABLE,
    usernamePolicy: {
      allowCustom: true,
      allowAutomatic: true,
      strategy: 'PREFIX_RANDOM',
      prefix: 'nx',
      template: null,
    },
    drain: { draining: false, since: null, reason: null },
    balancingGroup: null,
    filesOnlyDelivery: false,
    qrKind: 'SUB_LINK',
    singboxIntervalMinutes: 360,
    createdAt: ago(60 * 24 * 160),
    updatedAt: ago(60 * 24 * 3),
    ...over,
  };
}

export const DEMO_PANEL_IDS = {
  de1: '01a05e35-c9ad-7e93-bef3-1ed9b55d0a01',
  de2: '01a05e35-c9ad-7e93-bef3-1ed9b55d0a02',
  nl1: '01a05e35-c9ad-7e93-bef3-1ed9b55d0a03',
  tr1: '01a05e35-c9ad-7e93-bef3-1ed9b55d0a04',
  fi1: '01a05e35-c9ad-7e93-bef3-1ed9b55d0a05',
  us1: '01a05e35-c9ad-7e93-bef3-1ed9b55d0a06',
  am1: '01a05e35-c9ad-7e93-bef3-1ed9b55d0a07',
} as const;

const DE1 = panel(DEMO_PANEL_IDS.de1, 'DE-1', 'de1.zedproxy.net:8443', {
  capacity: capacity(2000, 1418, 2),
  balancingGroup: 'de-pool',
  health: health({ checkedAt: ago(1), latencyMs: 42 }),
});
const DE2 = panel(DEMO_PANEL_IDS.de2, 'DE-2', 'de2.zedproxy.net:8443', {
  capacity: capacity(1500, 611, 0),
  balancingGroup: 'de-pool',
  activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS_TCP_REALITY'] } },
  credentials: {
    username: credential(true, 60 * 24 * 18),
    password: credential(true, 60 * 24 * 18),
    apiToken: credential(true, 60 * 24 * 18),
  },
  health: health({
    state: 'UNREACHABLE',
    failure: 'TIMEOUT',
    checkedAt: ago(3),
    latencyMs: null,
    status: null,
    lastHealthyAt: ago(280),
    unusableStreak: 14,
  }),
  sellability: unsellable('UNHEALTHY'),
});
const NL1 = panel(DEMO_PANEL_IDS.nl1, 'NL-1', 'nl1.zedproxy.net:2096', {
  capacity: capacity(1500, 980, 0),
  activation: { proxyProtocols: ['vless', 'trojan'], inboundTags: { vless: ['VLESS_GRPC'] } },
  health: health({ checkedAt: ago(0), latencyMs: 58 }),
  drain: {
    draining: true,
    since: ago(60 * 19),
    reason: 'انتقال به سرور جدید هتزنر — فروش تازه تا پایان هفته بسته است.',
  },
  sellability: unsellable('DRAINING'),
});
const TR1 = panel(DEMO_PANEL_IDS.tr1, 'TR-1', 'tr1.zedproxy.net:54321', {
  providerType: 'sanaei',
  providerName: 'Sanaei (3X-UI)',
  baseUrl: 'https://tr1.zedproxy.net:54321/panel/',
  capabilities: ['CREATE_USER', 'READ_USAGE', 'DELIVER_SUBSCRIPTION_LINK'],
  credentials: {
    username: credential(false),
    password: credential(false),
    apiToken: credential(true, 60 * 24 * 21),
  },
  activation: { subscriptionDomain: 'sub.tr1.zedproxy.net', inboundId: 3 },
  capacity: capacity(800, 402, 1),
  health: health({
    state: 'DEGRADED',
    stale: true,
    checkedAt: ago(32),
    latencyMs: 890,
    providerVersion: '3.7.0',
    lastHealthyAt: ago(32),
  }),
  sellability: unsellable('UNHEALTHY'),
});
const FI1 = panel(DEMO_PANEL_IDS.fi1, 'FI-1', 'fi1.zedproxy.net:8443', {
  capacity: capacity(1000, 998, 2),
  health: health({ checkedAt: ago(4), latencyMs: 61 }),
  usernamePolicy: {
    allowCustom: false,
    allowAutomatic: true,
    strategy: 'CUSTOM_TEMPLATE',
    prefix: null,
    template: 'fi{tg4}{random4}',
  },
  sellability: unsellable('AT_CAPACITY'),
});
const US1 = panel(DEMO_PANEL_IDS.us1, 'US-1', 'us1.zedproxy.net', {
  providerType: 'rickpanel',
  providerName: 'RickPanel',
  status: 'DISABLED',
  activation: null,
  capacity: capacity(600, 144, 0),
  health: health({
    checkedAt: ago(60 * 24 * 8),
    latencyMs: 133,
    providerVersion: '1.4.2',
    lastHealthyAt: ago(60 * 24 * 8),
  }),
  sellability: unsellable('DISABLED'),
});
const AM1 = panel(DEMO_PANEL_IDS.am1, 'AM-1', 'am1.zedproxy.net:2053', {
  providerType: 'sanaei',
  providerName: 'Sanaei (3X-UI)',
  capabilities: ['CREATE_USER', 'READ_USAGE', 'DELIVER_SUBSCRIPTION_LINK'],
  activation: null,
  credentials: {
    username: credential(true, 200),
    password: credential(false),
    apiToken: credential(false),
  },
  capacity: capacity(null, 0, 0),
  health: health({
    state: 'UNCHECKED',
    checkedAt: null,
    latencyMs: null,
    status: null,
    providerVersion: null,
    lastHealthyAt: null,
    unusableStreak: null,
  }),
  sellability: unsellable('CREDENTIALS_MISSING', {
    activationComplete: false,
    missingActivationFields: ['subscriptionDomain', 'inboundId'],
    connectionValidated: false,
  }),
  createdAt: ago(200),
  updatedAt: ago(200),
});

const DEMO_PANELS: readonly Json[] = [DE1, DE2, NL1, TR1, FI1, US1, AM1];

function services(active: number, suspended: number, expired: number, over: Json = {}): Json {
  return { active, suspended, expired, pending: 0, unreconciled: 0, ...over };
}

function condition(
  code: string,
  severity: string,
  minutes: number,
  occurrences: number,
  current: boolean,
): Json {
  return {
    code,
    severity,
    firstSeenAt: ago(minutes),
    lastSeenAt: ago(Math.max(0, minutes - 30)),
    occurrences,
    current,
  };
}

const NO_FAILURES: Json = {
  failedInWindow: 0,
  unknownOpen: 0,
  lastFailureAt: null,
  lastFailureKind: null,
};

/** The live fleet (`/panel-health` serves every non-archived panel), as the demo's cards. */
const HEALTH_ROWS: readonly Json[] = [
  {
    panel: DE1,
    services: services(1302, 21, 95),
    provisioning: {
      failedInWindow: 1,
      unknownOpen: 0,
      lastFailureAt: ago(60 * 10),
      lastFailureKind: 'TIMEOUT',
    },
    conditions: [condition('panel.health.unreachable', 'ERROR', 60 * 16, 3, false)],
  },
  {
    panel: DE2,
    services: services(540, 12, 59, { pending: 3, unreconciled: 2 }),
    provisioning: {
      failedInWindow: 6,
      unknownOpen: 2,
      lastFailureAt: ago(35),
      lastFailureKind: 'TIMEOUT',
    },
    conditions: [
      condition('panel.health.unreachable', 'ERROR', 280, 14, true),
      condition('provisioning.stalled', 'WARN', 35, 2, true),
    ],
  },
  { panel: NL1, services: services(902, 8, 70), provisioning: NO_FAILURES, conditions: [] },
  {
    panel: TR1,
    services: services(371, 4, 27),
    provisioning: {
      failedInWindow: 2,
      unknownOpen: 0,
      lastFailureAt: ago(170),
      lastFailureKind: 'MALFORMED_RESPONSE',
    },
    conditions: [condition('panel.health.degraded', 'WARN', 110, 4, true)],
  },
  { panel: FI1, services: services(930, 15, 53), provisioning: NO_FAILURES, conditions: [] },
  { panel: US1, services: services(120, 2, 22), provisioning: NO_FAILURES, conditions: [] },
  { panel: AM1, services: services(0, 0, 0), provisioning: NO_FAILURES, conditions: [] },
];

/** A provider's capability registry: supported rows null-gapped, the rest with their reason. */
function registry(gaps: Readonly<Record<string, string | null>>): Json[] {
  return CAPABILITY_REGISTRY_ROWS.map((row) => {
    const gap = gaps[row] ?? null;
    return { row, supported: gap === null, gap };
  });
}

const PROVIDERS = [
  {
    key: 'marzban',
    canonicalName: 'Marzban',
    credentialShape: 'USERNAME_PASSWORD',
    capabilities: MARZBAN_CAPS,
    requiredActivationFields: ['proxyProtocols', 'inboundTags'],
    capabilityRegistry: registry({
      RESET_TRAFFIC: 'NOT_IMPLEMENTED',
      ROTATE_SUBSCRIPTION: 'NOT_DECLARED',
      SUBSCRIPTION_FILES: 'NOT_SUPPORTED',
      EXTRA_DEVICES: 'NOT_SUPPORTED',
      LOCATION_CHANGE: 'NOT_IN_RELEASE',
    }),
  },
  {
    key: 'rickpanel',
    canonicalName: 'RickPanel',
    credentialShape: 'USERNAME_PASSWORD',
    capabilities: [...MARZBAN_CAPS, 'ROTATE_SUBSCRIPTION_LINK'],
    requiredActivationFields: [],
    capabilityRegistry: registry({
      RESET_TRAFFIC: 'NOT_SUPPORTED',
      EXTRA_DEVICES: 'NOT_SUPPORTED',
      LOCATION_CHANGE: 'NOT_IN_RELEASE',
    }),
  },
  {
    key: 'sanaei',
    canonicalName: 'Sanaei (3X-UI)',
    credentialShape: 'TOKEN_OR_USERNAME_PASSWORD',
    capabilities: ['CREATE_USER', 'READ_USAGE', 'DELIVER_SUBSCRIPTION_LINK'],
    requiredActivationFields: ['subscriptionDomain', 'inboundId'],
    capabilityRegistry: registry({
      RENEW: 'NOT_SUPPORTED',
      ADD_TRAFFIC: 'NOT_SUPPORTED',
      ADD_TIME: 'NOT_SUPPORTED',
      RESET_TRAFFIC: 'NOT_SUPPORTED',
      DISABLE_ENABLE: 'NOT_DECLARED',
      ROTATE_SUBSCRIPTION: 'NOT_SUPPORTED',
      SUBSCRIPTION_FILES: 'NOT_SUPPORTED',
      EXTRA_DEVICES: 'NOT_DECLARED',
      LOCATION_CHANGE: 'NOT_IN_RELEASE',
      TERMINATE: 'NOT_DECLARED',
    }),
  },
];

const OPS_BOT = { id: '01a05e35-c9ad-7e93-bef3-1ed9b55d0b01', username: 'NexaVpnBot' };
const OPS_BOT_2 = { id: '01a05e35-c9ad-7e93-bef3-1ed9b55d0b02', username: 'NexaSupportBot' };

/** The demo's group: connected, but the bot lost «مدیریت تاپیک‌ها» and the backups topic. */
const OPS_GROUP = {
  connection: 'CONNECTED',
  group: {
    title: 'NEXA — گزارش‌های مدیریتی',
    bot: OPS_BOT,
    connectedAt: ago(60 * 24 * 12),
    disconnectedAt: null,
  },
  health: 'PROBLEM',
  problems: ['CANNOT_MANAGE_TOPICS'],
  checkedAt: ago(17),
  lastDeliveredAt: ago(0),
  topics: [
    ['SYSTEM', 'READY', 0],
    ['ERRORS', 'READY', 12],
    ['PAYMENTS', 'READY', 1],
    ['SERVICES', 'READY', 8],
    ['PANELS', 'READY', 0],
    ['BOT', 'READY', 50],
    ['SECURITY', 'READY', 283],
    ['BACKUPS', 'MISSING', null],
  ].map(([category, state, minutes]) => ({
    category,
    state,
    lastDeliveredAt: minutes === null ? null : ago(minutes as number),
    recreatedCount: state === 'MISSING' ? 1 : 0,
  })),
  queue: { pending: 2, preserved: 4 },
  laneEnabled: true,
  pendingCodeExpiresAt: null,
  bots: [OPS_BOT, OPS_BOT_2],
  manual: { configured: false, inUse: false },
};

/** The management scope of the operations log, newest first — the demo's ten rows. */
const MANAGEMENT_EVENTS = (
  [
    [
      'backup.interval_exceeded',
      'WARN',
      'Last verified backup is 26h old; the interval is 24h.',
      4,
      110,
      20,
      false,
    ],
    [
      'settings.stored_value_invalid',
      'WARN',
      'Stored value of ops.notifications.payments_topic_id is unreadable; the default is used.',
      1,
      150,
      150,
      false,
    ],
    [
      'access.permission_denied',
      'WARN',
      'Administrator "reza.fin" was denied admins.view.',
      2,
      32,
      31,
      false,
    ],
    [
      'auth.login_locked_out',
      'WARN',
      'Sign-in for "nima.sup" locked after 5 failed attempts from 5.160.12.44.',
      1,
      283,
      283,
      false,
    ],
    [
      'panel.monitor.tenant_budget_ok',
      'INFO',
      'The tenant probe budget is back inside its window.',
      1,
      698,
      698,
      false,
    ],
    [
      'panel.monitor.tenant_budget_exceeded',
      'ERROR',
      'The tenant probe budget ran out in the 60s window; 3 panels waited.',
      9,
      920,
      710,
      true,
    ],
    [
      'admin.roles_changed',
      'WARN',
      'Roles for administrator "elham.fin" changed from [support] to [finance, support].',
      1,
      950,
      950,
      false,
    ],
    [
      'admin.created',
      'INFO',
      'Administrator "nima.sup" created with role support.',
      1,
      1200,
      1200,
      false,
    ],
    ['backup.delivery_ok', 'INFO', 'The backup archive reached Telegram.', 1, 1648, 1648, false],
    [
      'backup.delivery_failed',
      'ERROR',
      'Telegram answered 413 to the backup upload.',
      2,
      3090,
      3089,
      true,
    ],
  ] as const
).map(([code, severity, message, count, first, last, resolved], index) => ({
  id: `01a05e35-c9ad-7e93-bef3-1ed9b55d0c${String(index).padStart(2, '0')}`,
  code,
  severity,
  message,
  context: null,
  occurrenceCount: count,
  firstSeenAt: ago(first),
  lastSeenAt: ago(last),
  correlationId: `demo-ops-${index}`,
  recoversCode: null,
  resolvedAt: resolved ? ago(last - 12) : null,
  resolvedByEventId: null,
}));

const ADMIN_OWNER = '01a05e35-c9ad-7e93-bef3-1ed9b5528c01';
const ADMIN_SARA = '01a05e35-c9ad-7e93-bef3-1ed9b5528c02';
const ADMIN_REZA = '01a05e35-c9ad-7e93-bef3-1ed9b5528c04';
const CUSTOMER_A = '01a05e35-c9ad-7e93-bef3-1ed9b55d0d01';
const CUSTOMER_B = '01a05e35-c9ad-7e93-bef3-1ed9b55d0d02';
const PAYMENT_A = '01a05e35-c9ad-7e93-bef3-1ed9b55d0e01';
const ORDER_A = '01a05e35-c9ad-7e93-bef3-1ed9b55d0f01';
const SERVICE_A = '01a05e35-c9ad-7e93-bef3-1ed9b55d1001';

const NO_LINKS = { customerId: null, orderId: null, paymentId: null, serviceId: null };

function entry(
  index: number,
  minutes: number,
  actorType: string,
  actorId: string | null,
  actorLabel: string | null,
  action: string,
  entityType: string,
  entityId: string | null,
  over: Json = {},
): Json {
  return {
    id: `01a05e35-c9ad-7e93-bef3-1ed9b55d11${String(index).padStart(2, '0')}`,
    occurredAt: ago(minutes),
    actorType,
    actorId,
    actorLabel,
    surface: actorType === 'TELEGRAM_ADMIN' || actorType === 'CUSTOMER' ? 'TELEGRAM' : 'WEB',
    action,
    entityType,
    entityId,
    result: 'SUCCESS',
    reason: null,
    correlationId: `req-demo-${String(index)}`,
    before: null,
    after: null,
    security: [],
    links: NO_LINKS,
    ...over,
  };
}

/** The demo's newest audit rows: approvals, a system job, a refused read, failures. */
const AUDIT_ROWS: readonly Json[] = [
  entry(0, 0, 'WEB_ADMIN', ADMIN_REZA, 'reza.fin', 'payment.approve', 'Payment', PAYMENT_A, {
    reason: 'رسید PAY-8841 بررسی شد',
  }),
  entry(1, 0, 'WEB_ADMIN', ADMIN_OWNER, 'm.hosein', 'payment.approve', 'Payment', PAYMENT_A, {
    before: { status: 'PENDING_REVIEW' },
    after: { status: 'CONFIRMED' },
    links: { ...NO_LINKS, paymentId: PAYMENT_A, orderId: ORDER_A, customerId: CUSTOMER_A },
  }),
  entry(
    2,
    8,
    'SYSTEM_JOB',
    'job:telegram-update:4f1c2a90-77de-4e51-9a0b-3c5d7e9f1a2b',
    'job:telegram-update:4f1c2a90-77de-4e51-9a0b-3c5d7e9f1a2b',
    'order.confirm',
    'Order',
    ORDER_A,
    {
      surface: 'WORKER',
      after: { status: 'AWAITING_PAYMENT', amountMinor: '780000', currency: 'IRT' },
      links: { ...NO_LINKS, orderId: ORDER_A, customerId: CUSTOMER_A },
    },
  ),
  entry(
    3,
    12,
    'PROVIDER_SYNC',
    'tonpays',
    'tonpays',
    'payment_gateway.check_credential',
    'PaymentGateway',
    null,
    {
      surface: 'WORKER',
      result: 'FAILED',
      reason: 'کلید API نامعتبر است (۴۰۱)',
    },
  ),
  entry(4, 13, 'WEB_ADMIN', ADMIN_SARA, 'sara.sup', 'ticket.assign', 'Ticket', null, {
    reason: 'گفتگوی CH-705',
  }),
  entry(5, 25, 'WEB_ADMIN', ADMIN_SARA, 'سارا محمدی', 'service.set_status', 'Service', SERVICE_A, {
    reason: 'اشتراک‌گذاری بیش از حد مجاز',
    before: { status: 'ACTIVE' },
    after: { status: 'SUSPENDED' },
    links: { ...NO_LINKS, serviceId: SERVICE_A, customerId: CUSTOMER_B },
  }),
  entry(6, 26, 'WEB_ADMIN', ADMIN_OWNER, 'm.hosein', 'product.update', 'Product', null, {
    reason: 'یک‌ماهه ۵۰ گیگ — آلمان',
  }),
  entry(7, 32, 'WEB_ADMIN', ADMIN_REZA, 'reza.fin', 'audit.export', 'AuditLog', null, {
    result: 'DENIED',
    security: ['DENIED'],
    reason: 'دسترسی «مشاهدهٔ مدیران» را ندارد',
  }),
  entry(
    8,
    39,
    'SYSTEM_JOB',
    'job:panel-monitor',
    'job:panel-monitor',
    'panel.probe',
    'Panel',
    DEMO_PANEL_IDS.de2,
    {
      surface: 'WORKER',
      result: 'FAILED',
      reason: 'پنل DE-2 پاسخ نداد',
    },
  ),
  entry(9, 49, 'WEB_ADMIN', ADMIN_OWNER, 'm.hosein', 'auth.login', 'Admin', ADMIN_OWNER, {
    security: ['AUTH'],
  }),
];

const ALL_PERMISSIONS = PERMISSIONS.map((definition) => definition.key as string);
const permissionsWhere = (test: (key: string) => boolean) => ALL_PERMISSIONS.filter(test);
const assignee = (id: string, username: string, displayName: string, active = true) => ({
  id,
  username,
  displayName,
  status: active ? 'ACTIVE' : 'DISABLED',
});

/** The demo's roles: the four system roles and two the owner made. */
const ROLES = [
  {
    key: 'owner',
    name: 'مالک',
    isSystem: true,
    immutable: true,
    version: 1,
    permissions: ALL_PERMISSIONS,
    assignedAdmins: [assignee(ADMIN_OWNER, 'm.hosein', 'محمدحسین')],
  },
  {
    key: 'operator',
    name: 'اپراتور',
    isSystem: true,
    immutable: false,
    version: 4,
    permissions: permissionsWhere((key) =>
      /^(panels|services|catalog|incidents|backup)\./u.test(key),
    ),
    assignedAdmins: [],
  },
  {
    key: 'support',
    name: 'پشتیبان',
    isSystem: true,
    immutable: false,
    version: 6,
    permissions: permissionsWhere((key) =>
      /^(tickets|business_chats|support_knowledge)\./u.test(key),
    ),
    assignedAdmins: [assignee(ADMIN_SARA, 'sara.sup', 'سارا محمدی')],
  },
  {
    key: 'finance',
    name: 'مالی',
    isSystem: true,
    immutable: false,
    version: 3,
    permissions: permissionsWhere((key) => /^(payments|receipts|refunds|reports)\./u.test(key)),
    assignedAdmins: [assignee(ADMIN_REZA, 'reza.fin', 'رضا نوری')],
  },
  {
    key: 'night_support',
    name: 'پشتیبان شیفت شب',
    isSystem: false,
    immutable: false,
    version: 2,
    permissions: permissionsWhere((key) => ['tickets.view', 'tickets.reply'].includes(key)),
    assignedAdmins: [],
  },
  {
    key: 'auditor',
    name: 'ممیز',
    isSystem: false,
    immutable: false,
    version: 1,
    permissions: permissionsWhere((key) =>
      ['audit.view', 'audit.export', 'opslog.view'].includes(key),
    ),
    assignedAdmins: [],
  },
];

function admin(
  id: string,
  username: string,
  displayName: string,
  roleKeys: readonly string[],
  over: Json = {},
): Json {
  return {
    id,
    username,
    displayName,
    status: 'ACTIVE',
    telegramUserId: null,
    roleKeys,
    createdAt: ago(60 * 24 * 200),
    lastLoginAt: ago(60 * 6),
    ...over,
  };
}

/** The demo's five administrators: one disabled, two without Telegram. */
const ADMINS = [
  admin(ADMIN_OWNER, 'm.hosein', 'محمدحسین شاه‌پوری', ['owner'], {
    telegramUserId: '112233445',
    lastLoginAt: ago(330),
  }),
  admin(ADMIN_SARA, 'sara.sup', 'سارا محمدی', ['support'], {
    telegramUserId: '559812004',
    lastLoginAt: ago(255),
  }),
  admin(ADMIN_REZA, 'reza.fin', 'رضا نوری', ['finance'], { lastLoginAt: ago(170) }),
  admin(
    '01a05e35-c9ad-7e93-bef3-1ed9b5528c05',
    'elham.fin',
    'الهام قاسمی',
    ['finance', 'support'],
    {
      telegramUserId: '887120931',
      lastLoginAt: ago(60 * 9 + 20),
    },
  ),
  admin('01a05e35-c9ad-7e93-bef3-1ed9b5528c06', 'nima.sup', 'نیما کریمی', ['night_support'], {
    status: 'DISABLED',
    lastLoginAt: null,
  }),
];

const INCIDENTS: readonly Json[] = [
  {
    id: '01a05e35-c9ad-7e93-bef3-1ed9b55d1201',
    kind: 'INCIDENT',
    severity: 'MAJOR',
    status: 'ACTIVE',
    title: 'قطعی پنل DE-2',
    description: 'پنل DE-2 به بررسی سلامت پاسخ نمی‌دهد. دیتاسنتر در حال بررسی مشکل شبکه است.',
    customerMessage: 'سرورهای آلمان ۲ موقتاً در دسترس نیستند؛ سرویس فعلی شما محفوظ است.',
    targets: [{ kind: 'PANEL', ref: DEMO_PANEL_IDS.de2 }],
    stopSales: true,
    adminBanner: false,
    scheduledStartAt: null,
    scheduledEndAt: ago(-210),
    startedAt: ago(29),
    resolvedAt: null,
    version: 3,
    createdAt: ago(29),
    effects: [
      {
        kind: 'PANEL_DRAIN',
        targetKind: 'PANEL',
        targetRef: DEMO_PANEL_IDS.de2,
        subjectRef: DEMO_PANEL_IDS.de2,
        state: 'APPLIED',
        errorCode: null,
        updatedAt: ago(29),
      },
    ],
  },
  {
    id: '01a05e35-c9ad-7e93-bef3-1ed9b55d1202',
    kind: 'MAINTENANCE',
    severity: 'MINOR',
    status: 'SCHEDULED',
    title: 'به‌روزرسانی نسخهٔ پنل TR-1',
    description: 'ارتقای 3x-ui به نسخهٔ جدید؛ حدود ۲۰ دقیقه قطعی.',
    customerMessage: null,
    targets: [
      { kind: 'PANEL', ref: DEMO_PANEL_IDS.tr1 },
      { kind: 'PANEL', ref: DEMO_PANEL_IDS.fi1 },
    ],
    stopSales: true,
    adminBanner: false,
    scheduledStartAt: ago(-60 * 37),
    scheduledEndAt: ago(-60 * 37 - 30),
    startedAt: null,
    resolvedAt: null,
    version: 2,
    createdAt: ago(60 * 19),
    effects: [],
  },
  {
    id: '01a05e35-c9ad-7e93-bef3-1ed9b55d1203',
    kind: 'INCIDENT',
    severity: 'CRITICAL',
    status: 'RESOLVED',
    title: 'خطای درگاه تون‌پیز',
    description: 'کلید API درگاه منقضی شده بود.',
    customerMessage: null,
    targets: [{ kind: 'GATEWAY', ref: 'TONPAYS' }],
    stopSales: true,
    adminBanner: false,
    scheduledStartAt: null,
    scheduledEndAt: null,
    startedAt: ago(60 * 24 * 3 + 220),
    resolvedAt: ago(60 * 24 * 3 + 125),
    version: 5,
    createdAt: ago(60 * 24 * 3 + 220),
    effects: [
      {
        kind: 'GATEWAY_DISABLE',
        targetKind: 'GATEWAY',
        targetRef: 'TONPAYS',
        subjectRef: 'TONPAYS',
        state: 'REVERTED',
        errorCode: null,
        updatedAt: ago(60 * 24 * 3 + 125),
      },
    ],
  },
  {
    id: '01a05e35-c9ad-7e93-bef3-1ed9b55d1204',
    kind: 'MAINTENANCE',
    severity: 'MINOR',
    status: 'CANCELLED',
    title: 'جابه‌جایی سرور NL-1',
    description: '',
    customerMessage: null,
    targets: [],
    stopSales: false,
    adminBanner: false,
    scheduledStartAt: ago(60 * 24 * 5 + 360),
    scheduledEndAt: ago(60 * 24 * 5 + 300),
    startedAt: null,
    resolvedAt: null,
    version: 2,
    createdAt: ago(60 * 24 * 7),
    effects: [],
  },
];

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0) Safari/604.1';

export const DEMO_INFRA: readonly ShotFixture[] = [
  fixture('/panels', panelListResponseSchema, { panels: DEMO_PANELS, nextCursor: null }),
  fixture('/panels/:id', panelResponseSchema, { panel: DE1 }),
  fixture('/panel-health', panelHealthDashboardResponseSchema, {
    rows: HEALTH_ROWS,
    nextCursor: null,
    generatedAt: ago(0),
    failureWindowMs: 86_400_000,
  }),
  fixture('/providers', providerListResponseSchema, { providers: PROVIDERS }),
  fixture('/ops-group', opsLogGroupResponseSchema, { opsGroup: OPS_GROUP }),
  fixture(
    '/ops-log',
    operationalEventListResponseSchema,
    {
      events: MANAGEMENT_EVENTS,
      nextCursor: { at: ago(3090), id: '01a05e35-c9ad-7e93-bef3-1ed9b55d0c09' },
    },
    { query: { scope: 'MANAGEMENT' } },
  ),
  fixture('/audit-log', auditLogListResponseSchema, { entries: AUDIT_ROWS, nextCursor: 'older' }),
  fixture('/admins', adminListResponseSchema, { admins: ADMINS }),
  fixture('/rbac/roles', roleViewListResponseSchema, { roles: ROLES }),
  fixture('/incidents', incidentListResponseSchema, { incidents: INCIDENTS, nextCursor: null }),
  fixture('/auth/sessions', adminSessionListResponseSchema, {
    sessions: [
      {
        id: '01a05e35-c9ad-7e93-bef3-1ed9b55d1301',
        issuedAt: ago(330),
        expiresAt: ago(-60 * 18),
        lastSeenAt: ago(0),
        ip: '5.120.44.18',
        userAgent: CHROME,
        current: true,
      },
      {
        id: '01a05e35-c9ad-7e93-bef3-1ed9b55d1302',
        issuedAt: ago(60 * 30),
        expiresAt: ago(-60 * 6),
        lastSeenAt: ago(60 * 15),
        ip: '89.165.3.201',
        userAgent: IPHONE,
        current: false,
      },
    ],
  }),
  fixture('/auth/security/events', securityEventListResponseSchema, {
    events: [
      ['auth.login', 'SUCCESS', 330, CHROME, '5.120.44.18', null],
      ['auth.login', 'FAILED', 60 * 15 + 30, 'curl/8.4', '185.23.9.77', 'BAD_PASSWORD'],
      ['auth.login', 'SUCCESS', 60 * 24, IPHONE, '89.165.3.201', null],
      ['admin.password_reset', 'SUCCESS', 60 * 24 * 15, null, null, null],
    ].map(([action, result, minutes, userAgent, ip, reason], index) => ({
      id: `01a05e35-c9ad-7e93-bef3-1ed9b55d140${String(index)}`,
      action,
      result,
      occurredAt: ago(minutes as number),
      actorLabel: action === 'admin.password_reset' ? 'owner' : null,
      ip,
      userAgent,
      reason,
      method: null,
    })),
  }),
];
