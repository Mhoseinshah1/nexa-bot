import {
  legacyCompactionStatusResponseSchema,
  resellerRequestDetailResponseSchema,
  resellerRequestListResponseSchema,
  serviceAutoDeletePreviewResponseSchema,
} from '@nexa/contracts';
import { ago, fixture, type ShotFixture } from '../fixture.ts';
import { CUSTOMERS } from './commerce-a.ts';

type Json = Record<string, unknown>;

/*
 * PR-9 sweep B: answers for the GETs the sweep still reported as unfixtured, so these routes
 * are photographed with their content and not as an error card. Each is an ordinary state:
 * a fresh install with no import to compact, a tenant that has not enabled auto-delete, one
 * pending reseller request, and a hosting section whose second factor is enrolled.
 */
const SWEEP_ID = '01a05e35-c9ad-7e93-bef3-1ed9b55292c8';
const CUSTOMER = CUSTOMERS[0] as Json;

const REQUEST_SUMMARY = {
  id: SWEEP_ID,
  number: 12,
  customerId: CUSTOMER['id'] as string,
  customerName: 'علی رضایی',
  customerUsername: 'ali_rezaei',
  status: 'PENDING',
  conversing: false,
  createdAt: ago(180),
  decidedAt: null,
  lastMessageAt: null,
};

/** The hosting status is parsed by a shape-only parser in the client; no zod schema exists. */
const passThrough = { parse: (value: unknown) => value };

export const COVERAGE_C: readonly ShotFixture[] = [
  fixture('/legacy-compaction', legacyCompactionStatusResponseSchema, {
    available: false,
    run: null,
  }),
  fixture('/services/auto-delete/preview', serviceAutoDeletePreviewResponseSchema, {
    windowHours: 24,
    traffic: 3,
    time: 5,
    suspended: 2,
    total: 10,
    enabled: false,
  }),
  fixture('/reseller-requests', resellerRequestListResponseSchema, {
    requests: [REQUEST_SUMMARY],
    counts: { pending: 1, conversing: 0, approved: 4, rejected: 1 },
    nextCursor: null,
  }),
  fixture('/reseller-requests/:id', resellerRequestDetailResponseSchema, {
    request: {
      ...REQUEST_SUMMARY,
      answers: [
        {
          questionId: 'q1',
          text: 'چه حجمی در ماه می‌فروشید؟',
          required: true,
          maxLength: 200,
          answer: 'حدود ۵۰ سرویس در ماه',
        },
      ],
      reason: null,
      decidedByName: null,
      tierId: null,
      tierName: null,
      servicesCount: 0,
      messages: [],
    },
  }),
  fixture('/hosting/status', passThrough, {
    factor: 'ACTIVE',
    recoveryCodesRemaining: 8,
    session: null,
    lockedUntil: null,
    create: { enabled: true, refusal: null },
  }),
];
