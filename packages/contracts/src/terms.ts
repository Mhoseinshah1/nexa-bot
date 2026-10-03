import { z } from 'zod';

/**
 * Terms and rules (program §6, `docs/terms-audit.md`).
 *
 * A tenant's rules are a sequence of VERSIONS. At most one is a DRAFT, the one an operator
 * edits; publishing it gives it the next version number and makes it the CURRENT version,
 * the one a customer is asked to accept while enforcement is on. A published version is
 * immutable — the database refuses an UPDATE or DELETE of one — so "what did this customer
 * accept" is answered by the row they accepted, never by today's text.
 *
 * There is no ARCHIVED state. A superseded version is simply not the newest published one:
 * the history is every published version, newest first, and "current" is derived, never
 * stored, so there is no second fact that could disagree with the version numbers.
 *
 * The title and body are stored RAW, like a template body, and rendered only when a
 * customer is shown them (`bot.terms.required`). Nothing here persists a rendered string.
 *
 * Enforcement is a feature flag (`terms_enforcement`): a boolean on/off is a flag, and a
 * flag's parameters are settings — there are none. Publishing never marks anybody as
 * having accepted; an acceptance is only ever written by the customer's own tap on the
 * button that names the version they were shown.
 */

export const TERMS_VERSION_STATUSES = ['DRAFT', 'PUBLISHED'] as const;
export type TermsVersionStatus = (typeof TERMS_VERSION_STATUSES)[number];

/**
 * Where an acceptance came from. Only the customer's own Telegram tap writes one; an
 * operator cannot accept on a customer's behalf, so there is no WEB member.
 */
export const TERMS_ACCEPTANCE_SOURCES = ['TELEGRAM'] as const;
export type TermsAcceptanceSource = (typeof TERMS_ACCEPTANCE_SOURCES)[number];

/** The feature flag that turns the Telegram gate on. Declared in `features.ts`. */
export const TERMS_ENFORCEMENT_FLAG = 'terms_enforcement' as const;

export const TERMS_TITLE_MAX_LENGTH = 120;
/**
 * Below Telegram's 4,096 so the title, the frame of `bot.terms.required` and the body fit
 * one message together; the accept button rides on that message.
 */
export const TERMS_BODY_MAX_LENGTH = 3500;

export const termsDraftInputSchema = z.object({
  title: z.string().trim().min(1).max(TERMS_TITLE_MAX_LENGTH),
  body: z.string().trim().min(1).max(TERMS_BODY_MAX_LENGTH),
});
export type TermsDraftInput = z.infer<typeof termsDraftInputSchema>;

const idempotencyKeySchema = z.string().min(8).max(255);

export const createTermsDraftRequestSchema = termsDraftInputSchema.extend({
  idempotencyKey: idempotencyKeySchema,
});
export type CreateTermsDraftRequest = z.infer<typeof createTermsDraftRequestSchema>;

/** Every edit states the revision it was made from; a moved draft is refused, never overwritten. */
export const updateTermsDraftRequestSchema = termsDraftInputSchema.extend({
  idempotencyKey: idempotencyKeySchema,
  expectedRevision: z.number().int().min(1),
});
export type UpdateTermsDraftRequest = z.infer<typeof updateTermsDraftRequestSchema>;

/** Publishes exactly the revision the operator previewed. */
export const publishTermsDraftRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  expectedRevision: z.number().int().min(1),
});
export type PublishTermsDraftRequest = z.infer<typeof publishTermsDraftRequestSchema>;

export const termsVersionSchema = z.object({
  id: z.string(),
  status: z.enum(TERMS_VERSION_STATUSES),
  /** Null for the draft: a number is given at publication, never before. */
  versionNumber: z.number().int().nullable(),
  title: z.string(),
  body: z.string(),
  /** The draft's edit counter. A published version keeps the revision it was published at. */
  revision: z.number().int(),
  createdAt: z.iso.datetime(),
  createdBy: z.string().nullable(),
  updatedAt: z.iso.datetime(),
  publishedAt: z.iso.datetime().nullable(),
  publishedBy: z.string().nullable(),
  /** True for the newest published version, which is the one customers are asked to accept. */
  current: z.boolean(),
  /** How many customers accepted THIS version. Zero for the draft. */
  acceptanceCount: z.number().int(),
});
export type TermsVersionResponse = z.infer<typeof termsVersionSchema>;

export const termsOverviewSchema = z.object({
  enforcement: z.object({
    enabled: z.boolean(),
    /** The flag's version, for the feature toggle's `expectedVersion`. Null: never stored. */
    version: z.number().int().nullable(),
  }),
  current: termsVersionSchema.nullable(),
  draft: termsVersionSchema.nullable(),
  /** Every published version, newest first. Read-only. */
  history: z.array(termsVersionSchema),
  statistics: z.object({
    /** Customers of this tenant, whatever their status. */
    customers: z.number().int(),
    /** Customers who accepted the current version. Zero when there is none. */
    acceptedCurrent: z.number().int(),
    /** Customers who have not: the ones the gate stops while enforcement is on. */
    pendingCurrent: z.number().int(),
  }),
});
export type TermsOverviewResponse = z.infer<typeof termsOverviewSchema>;

export const termsVersionWriteResponseSchema = z.object({ version: termsVersionSchema });
export type TermsVersionWriteResponse = z.infer<typeof termsVersionWriteResponseSchema>;

/**
 * One customer's standing, for Customer 360. `reacceptanceRequired` is exactly what the
 * Telegram gate decides: enforcement on, a current version, and no acceptance of it.
 */
export const customerTermsStandingSchema = z.object({
  available: z.literal(true),
  enforced: z.boolean(),
  current: z
    .object({
      versionId: z.string(),
      versionNumber: z.number().int(),
      title: z.string(),
      publishedAt: z.iso.datetime(),
    })
    .nullable(),
  lastAccepted: z
    .object({
      versionId: z.string(),
      versionNumber: z.number().int(),
      acceptedAt: z.iso.datetime(),
    })
    .nullable(),
  acceptedCurrent: z.boolean(),
  reacceptanceRequired: z.boolean(),
});
export type CustomerTermsStandingResponse = z.infer<typeof customerTermsStandingSchema>;

export const TERMS_ROUTES = {
  overview: '/terms',
  createDraft: '/terms/draft',
  updateDraft: (id: string) => `/terms/versions/${encodeURIComponent(id)}`,
  publish: (id: string) => `/terms/versions/${encodeURIComponent(id)}/publish`,
} as const;
