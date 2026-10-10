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
  fixture('/auth/sessions', adminSessionListResponseSchema, { sessions: [] }),
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

  // /panel-health: a fleet with nothing to report.
  fixture('/panel-health', panelHealthDashboardResponseSchema, {
    rows: [],
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
