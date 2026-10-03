import { z } from 'zod';
import { uuidV7Schema } from './ids.js';

/**
 * Customer CRM metadata (program §8, Phase A3): the tenant's own TAGS and the operators'
 * internal NOTES on one customer. `docs/customer-notes-tags.md` is the design record.
 *
 * Both are OPERATOR-ONLY. Nothing here is a customer attribute Telegram knows about, and no
 * customer surface reads either: a note is what one operator tells the next about a customer,
 * and a customer who could read it would be reading what was written about them. The rule is
 * held by a test over the source tree (`tests/unit/customer-crm-privacy.test.ts`), not by a
 * comment.
 *
 * Kept OUT of `customerSummarySchema` for the same reason Customer 360's controls are: that
 * shape is the row every customer LIST returns.
 */

// --- Tags -------------------------------------------------------------------------------

/**
 * The colours a tag may carry: EXACTLY the Web Admin design system's semantic tones
 * (`apps/web/src/ui/kit.tsx`, `Tone`), and nothing else. A free hex colour would be a
 * per-tag visual convention the design system does not have, unreadable in one of the two
 * themes. `tests/web/customer-crm.test.tsx` pins the two lists to each other.
 *
 * Null on a tag means the neutral tone.
 */
export const CUSTOMER_TAG_COLORS = [
  'neutral',
  'info',
  'ok',
  'warn',
  'danger',
  'violet',
  'teal',
] as const;
export type CustomerTagColor = (typeof CUSTOMER_TAG_COLORS)[number];

/** A label's bound, in code points (Persian text counts as it reads). */
export const CUSTOMER_TAG_LABEL_MAX_LENGTH = 40;
/**
 * The most tags a tenant may DEFINE, archived ones included. The catalogue is listed whole
 * (the filter select and the assignment picker need all of it), so it is bounded here rather
 * than paged; archiving does not free a slot, because an archived tag is still listed.
 */
export const CUSTOMER_TAGS_PER_TENANT_MAX = 200;

/**
 * The one spelling of a tag label: Unicode NFC, surrounding space dropped and every run of
 * whitespace (including the zero-width non-joiner's neighbours a Persian keyboard leaves)
 * collapsed to one space.
 *
 * Uniqueness is decided by the DATABASE over `lower(label)` among a tenant's ACTIVE tags,
 * on the stored (already normalised) label — so «VIP», « vip » and «Vip» are one name, and
 * the case folding is PostgreSQL's alone rather than a JavaScript copy of it that could
 * disagree on some alphabet. The schema's CHECK refuses a label that is not in this form.
 */
export function normaliseCustomerTagLabel(raw: string): string {
  return raw.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

export const customerTagLabelSchema = z
  .string()
  .max(CUSTOMER_TAG_LABEL_MAX_LENGTH * 4)
  .transform(normaliseCustomerTagLabel)
  .refine((label) => label.length > 0, { message: 'A tag needs a name.' })
  .refine((label) => Array.from(label).length <= CUSTOMER_TAG_LABEL_MAX_LENGTH, {
    message: `A tag name is at most ${String(CUSTOMER_TAG_LABEL_MAX_LENGTH)} characters.`,
  });

const idempotencyKeySchema = z.string().min(8).max(255);

/** One tag of the tenant's catalogue. `id` is the identity; the label is editable text. */
export const customerTagSchema = z.object({
  id: uuidV7Schema,
  label: z.string(),
  color: z.enum(CUSTOMER_TAG_COLORS).nullable(),
  /** Non-null: archived. Still shown where it is assigned; never newly assignable. */
  archivedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type CustomerTagResponse = z.infer<typeof customerTagSchema>;

export const customerTagListResponseSchema = z.object({ tags: z.array(customerTagSchema) });
export type CustomerTagListResponse = z.infer<typeof customerTagListResponseSchema>;

export const customerTagCreateRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  label: customerTagLabelSchema,
  color: z.enum(CUSTOMER_TAG_COLORS).nullable().default(null),
});
export type CustomerTagCreateRequest = z.input<typeof customerTagCreateRequestSchema>;

/** Rename and/or recolour. Both are sent: the form holds the whole tag. */
export const customerTagUpdateRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  label: customerTagLabelSchema,
  color: z.enum(CUSTOMER_TAG_COLORS).nullable(),
});
export type CustomerTagUpdateRequest = z.input<typeof customerTagUpdateRequestSchema>;

/** Archive (`true`) or restore (`false`). Nothing deletes a tag: history keeps naming it. */
export const customerTagArchiveRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  archived: z.boolean(),
});
export type CustomerTagArchiveRequest = z.infer<typeof customerTagArchiveRequestSchema>;

export const customerTagWriteResponseSchema = z.object({
  tag: customerTagSchema,
  changed: z.boolean(),
});
export type CustomerTagWriteResponse = z.infer<typeof customerTagWriteResponseSchema>;

/** A tag on one customer: the catalogue entry and when it was put there. */
export const customerAssignedTagSchema = customerTagSchema.extend({
  assignedAt: z.iso.datetime(),
});
export type CustomerAssignedTagResponse = z.infer<typeof customerAssignedTagSchema>;

export const customerTagsResponseSchema = z.object({ tags: z.array(customerAssignedTagSchema) });
export type CustomerTagsResponse = z.infer<typeof customerTagsResponseSchema>;

/** Assign or remove: the same body, two routes. */
export const customerTagAssignmentRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  tagId: uuidV7Schema,
});
export type CustomerTagAssignmentRequest = z.infer<typeof customerTagAssignmentRequestSchema>;

export const customerTagAssignmentResponseSchema = z.object({
  tags: z.array(customerAssignedTagSchema),
  changed: z.boolean(),
});
export type CustomerTagAssignmentResponse = z.infer<typeof customerTagAssignmentResponseSchema>;

// --- Notes ------------------------------------------------------------------------------

/** A note's bound, in code points. */
export const CUSTOMER_NOTE_MAX_LENGTH = 2000;
export const CUSTOMER_NOTE_PAGE_DEFAULT = 20;
export const CUSTOMER_NOTE_PAGE_MAX = 100;

/**
 * A note body: surrounding space dropped, never empty, bounded in code points. Line breaks
 * inside are kept — a note is prose.
 */
export const customerNoteBodySchema = z
  .string()
  .max(CUSTOMER_NOTE_MAX_LENGTH * 4)
  .transform((body) => body.normalize('NFC').trim())
  .refine((body) => body.length > 0, { message: 'A note cannot be empty.' })
  .refine((body) => Array.from(body).length <= CUSTOMER_NOTE_MAX_LENGTH, {
    message: `A note is at most ${String(CUSTOMER_NOTE_MAX_LENGTH)} characters.`,
  });

/**
 * One note. APPEND-ONLY: there is no edit and no delete, so there is no "edited" state to
 * show — a correction is a second note, and both stay. `authorLabel` is the operator's name
 * as it was when they wrote it.
 */
export const customerNoteSchema = z.object({
  id: uuidV7Schema,
  body: z.string(),
  authorAdminId: z.string().nullable(),
  authorLabel: z.string(),
  createdAt: z.iso.datetime(),
});
export type CustomerNoteResponse = z.infer<typeof customerNoteSchema>;

export const customerNoteListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(CUSTOMER_NOTE_PAGE_MAX).optional(),
  cursor: z.string().max(512).optional(),
});

/** Newest first. `nextCursor` reaches OLDER notes. */
export const customerNoteListResponseSchema = z.object({
  notes: z.array(customerNoteSchema),
  nextCursor: z.string().nullable(),
});
export type CustomerNoteListResponse = z.infer<typeof customerNoteListResponseSchema>;

export const customerNoteCreateRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  body: customerNoteBodySchema,
});
export type CustomerNoteCreateRequest = z.input<typeof customerNoteCreateRequestSchema>;

export const customerNoteCreateResponseSchema = z.object({
  note: customerNoteSchema,
  created: z.boolean(),
});
export type CustomerNoteCreateResponse = z.infer<typeof customerNoteCreateResponseSchema>;

// --- Routes -----------------------------------------------------------------------------

export const CUSTOMER_CRM_ROUTES = {
  tags: '/customer-tags',
  tag: (id: string) => `/customer-tags/${encodeURIComponent(id)}`,
  tagArchive: (id: string) => `/customer-tags/${encodeURIComponent(id)}/archive`,
  customerTags: (customerId: string) => `/users/${encodeURIComponent(customerId)}/tags`,
  customerTagRemove: (customerId: string) => `/users/${encodeURIComponent(customerId)}/tags/remove`,
  customerNotes: (customerId: string) => `/users/${encodeURIComponent(customerId)}/notes`,
} as const;
