import {
  accountSecurityResponseSchema,
  adminSessionListResponseSchema,
  orderPlacementResponseSchema,
  panelHealthDashboardResponseSchema,
  securityEventListResponseSchema,
  serviceLocationTargetsResponseSchema,
  termsOverviewSchema,
} from '@nexa/contracts';
import { ago, fixture, type ShotFixture } from '../fixture.ts';
import { PANELS } from './ops-a.ts';

type Json = Record<string, unknown>;

/*
 * /panel-health: the production service returns ONE ROW PER LIVE PANEL (it pages
 * `PanelService.list`, the same page `/panels` serves), so the fleet here is the five
 * panels the `/panels` fixture shows — not an empty dashboard no operator with panels
 * would ever see. No failed or unknown provisioning in the window and no open ops-log
 * conditions; the service counts are the panel's own non-terminated services, so the
 * card agrees with the capacity the panel row reports.
 */
const HEALTH_ROWS: readonly Json[] = PANELS.map((panel) => {
  const capacity = panel['capacity'] as { services: number };
  return {
    panel,
    services: { active: capacity.services, suspended: 0, expired: 0, pending: 0, unreconciled: 0 },
    provisioning: {
      failedInWindow: 0,
      unknownOpen: 0,
      lastFailureAt: null,
      lastFailureKind: null,
    },
    conditions: [],
  };
});

/**
 * FIX-12: answers for requests `pnpm web:responsive` reported as `unfixtured` on routes
 * that are otherwise covered — so those routes are measured as the operator sees them
 * rather than as an error card. Each is the plainest TRUE state of its screen (no
 * enrolment yet, no balancing decision, no published terms), not an invented story.
 *
 * Still uncovered, stated rather than hidden: Customer 360's overview, financial summary,
 * messages, tags, notes and timeline; an incident's detail; the QR preview POST; the
 * support-AI and business-chat screens; and the legacy (Mirza) pages, which are on HOLD.
 */
export const COVERAGE: readonly ShotFixture[] = [
  // /account: an administrator with no second factor yet, and no sign-in history to show.
  fixture('/auth/security', accountSecurityResponseSchema, {
    totp: { state: 'DISABLED', activatedAt: null },
    backupCodes: { remaining: 0, generatedAt: null },
  }),
  // An authenticated caller always holds at least the session that made the request:
  // the signed-in owner of `shell.ts`, signed in at its `lastLoginAt`, expiring at its
  // `expiresAt`, and marked `current` as `listOwnSessions` marks it.
  fixture('/auth/sessions', adminSessionListResponseSchema, {
    sessions: [
      {
        id: '019260ab-cdef-7012-8345-6789abcdef31',
        issuedAt: ago(5),
        expiresAt: ago(-60 * 8),
        lastSeenAt: ago(0),
        ip: '203.0.113.24',
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
        current: true,
      },
    ],
  }),
  fixture('/auth/security/events', securityEventListResponseSchema, { events: [] }),

  // /orders/:id: an order routed explicitly, which has no balancing decision.
  fixture('/orders/:id/placement', orderPlacementResponseSchema, { placement: null }),

  // /services/:id: where the service is, and one other location of its panel.
  fixture('/services/:id/location-targets', serviceLocationTargetsResponseSchema, {
    current: { key: 'de-fra', label: 'آلمان — فرانکفورت' },
    targets: [
      {
        id: '019260ab-cdef-7012-8345-6789abcdef21',
        locationKey: 'nl-ams',
        label: 'هلند — آمستردام',
      },
    ],
  }),

  // /panel-health: the live fleet of `/panels`, one row each.
  fixture('/panel-health', panelHealthDashboardResponseSchema, {
    rows: HEALTH_ROWS,
    nextCursor: null,
    generatedAt: ago(0),
    failureWindowMs: 86_400_000,
  }),

  // /terms: no terms published yet, enforcement off.
  fixture('/terms', termsOverviewSchema, {
    enforcement: { enabled: false, version: null },
    current: null,
    draft: null,
    history: [],
    statistics: { customers: 1240, acceptedCurrent: 0, pendingCurrent: 0 },
  }),
];
