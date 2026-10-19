import {
  PERMISSION_KEYS,
  auditLogListResponseSchema,
  paymentAttentionResponseSchema,
  PAYMENT_OPS_QUEUES,
  customerTagListResponseSchema,
  inboxListResponseSchema,
  installationKeysResponseSchema,
  healthInfoResponseSchema,
  inboxSummaryResponseSchema,
  incidentBannerResponseSchema,
  sessionResponseSchema,
  systemReadinessResponseSchema,
} from '@nexa/contracts';
import { ago, fixture, type ShotFixture } from '../fixture.ts';

/** The shell's attention state for a screenshot run (see the bell and banner fixtures). */
const SHELL_ATTENTION = process.env['NEXA_SHOTS_SHELL'] === 'attention';

/**
 * What every screen needs: a signed-in owner holding every permission (so the
 * whole navigation is drawn), and the build the sidebar names.
 */
export const SHELL: readonly ShotFixture[] = [
  fixture('/auth/session', sessionResponseSchema, {
    admin: {
      id: '01a05e35-c9ad-7e93-bef3-1ed9b55292c8',
      username: 'owner',
      displayName: 'مدیر اصلی',
      status: 'ACTIVE',
      telegramUserId: null,
      roleKeys: ['owner'],
      createdAt: ago(60 * 24 * 400),
      lastLoginAt: ago(5),
    },
    permissions: [...PERMISSION_KEYS],
    expiresAt: ago(-60 * 8),
  }),
  fixture(
    '/health/info',
    healthInfoResponseSchema,
    {
      name: 'nexa-bot',
      version: '0.4.0',
      commit: '7ba1837e6c2d4a1b9f0e3c5d7a8b9c0d1e2f3a4b',
      buildTime: ago(60 * 24 * 2),
      nodeVersion: 'v22.11.0',
      environment: 'production',
    },
    { absolute: true },
  ),
  fixture('/system/readiness', systemReadinessResponseSchema, {
    status: 'ok',
    dependencies: [
      { name: 'postgres', status: 'up', latencyMs: 3 },
      { name: 'redis', status: 'up', latencyMs: 1 },
      { name: 'migrations', status: 'up', detail: '27 applied' },
      { name: 'outbox-relay', status: 'up', latencyMs: 12 },
    ],
  }),
  /*
   * The topbar's bell and the incident banner, on every screen: nothing unread, no incident —
   * so every family's screens are photographed as they were. `NEXA_SHOTS_SHELL=attention`
   * (demo parity A1/A4) photographs the shell's other state instead: an unread count on the
   * bell and one ACTIVE incident on the banner, as the approved demo draws them.
   */
  fixture(
    '/notification-center/summary',
    inboxSummaryResponseSchema,
    SHELL_ATTENTION
      ? { unread: 6, atLeast: false, highestUnread: 'ERROR' }
      : { unread: 0, atLeast: false, highestUnread: null },
  ),
  fixture('/incidents/banner', incidentBannerResponseSchema, {
    incidents: SHELL_ATTENTION
      ? [
          {
            id: '01a05e35-c9ad-7e93-bef3-1ed9b55292f7',
            kind: 'INCIDENT',
            severity: 'CRITICAL',
            title: 'قطعی پنل DE-2',
            startedAt: ago(40),
            scheduledEndAt: ago(-200),
          },
        ]
      : [],
  }),
  /*
   * Roadmap B2: the reads a few routes make that no family fixtured yet, so
   * `pnpm web:responsive` measures their page rather than an error card. Empty
   * where an empty answer is a real state (and draws the empty state), one row
   * where the page's controls only exist with one.
   */
  fixture('/customer-tags', customerTagListResponseSchema, {
    tags: [
      {
        id: '01a05e35-c9ad-7e93-bef3-1ed9b55292e1',
        label: 'وفادار',
        color: 'ok',
        archivedAt: null,
        createdAt: ago(60 * 24 * 30),
        updatedAt: ago(60 * 24 * 30),
      },
    ],
  }),
  fixture('/recovery-kit/keys', installationKeysResponseSchema, { keys: [] }),
  fixture('/audit-log', auditLogListResponseSchema, { entries: [], nextCursor: null }),
  // `/incidents` (the list) is in `coverage-b.ts`, beside the incident its detail shows.
  fixture('/notification-center', inboxListResponseSchema, {
    notifications: [],
    nextCursor: null,
  }),
  // The payments page's attention counts (review of #242, N8): every queue empty.
  fixture('/payment-operations/attention', paymentAttentionResponseSchema, {
    window: null,
    byGateway: [],
    totals: Object.fromEntries(PAYMENT_OPS_QUEUES.map((queue) => [queue, 0])),
    generatedAt: ago(1),
  }),
];
