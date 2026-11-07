import { z } from 'zod';
import { uuidV7Schema } from './ids.js';
import type { PlaceholderDefinition, TemplateDefinition } from './templates.js';

/**
 * Owner batch 1, PR-2 — «👨‍💻 درخواست نمایندگی»: a customer asks to become a reseller.
 *
 * ## What is declared here
 *
 * - the request's states and the bounds on what a customer and an operator may write;
 * - the error codes both surfaces map;
 * - the customer-text-capture purposes the Telegram flow opens (a typed answer, a typed
 *   reply, and the two things an operator types in a private chat after a tap in the group);
 * - the callback-data prefixes of the whole flow, so the keyboards and the router cannot
 *   disagree about them;
 * - every template the flow renders, and the wire schemas of the Web Admin routes.
 *
 * ## Why the conversation is not a ticket
 *
 * A ticket carries a category, a priority, an assignee, links to a service, an order and a
 * payment, an AI hold and a place in the support inbox. A reseller request is none of those,
 * and routing it through that machinery would put an application in the support queue, let
 * the support AI answer it, and let a customer's «reply» REOPEN a conversation that an
 * operator closed by deciding. So the request has its own small message table and sends
 * through the SAME delivery path a ticket reply does: a row on the customer notification
 * lane (`RESELLER_REQUEST_MESSAGE`), whose text is read back from the message row at send
 * time. The customer's file is a Telegram binding fetched through the same receipt-file
 * downloader as a ticket's.
 *
 * ## Approval
 *
 * Approving makes the customer a reseller on a tier the operator picks, through the existing
 * reseller registration (`ResellerAdminService.register`). It moves no money and grants no
 * credit.
 */

export const RESELLER_REQUEST_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export type ResellerRequestStatus = (typeof RESELLER_REQUEST_STATUSES)[number];

export const RESELLER_REQUEST_MESSAGE_SENDERS = ['CUSTOMER', 'ADMIN'] as const;
export type ResellerRequestMessageSender = (typeof RESELLER_REQUEST_MESSAGE_SENDERS)[number];

/** A customer's file in a reply. A photo is the one thing the bot accepts today. */
export const RESELLER_REQUEST_ATTACHMENT_KINDS = ['PHOTO'] as const;
export type ResellerRequestAttachmentKind = (typeof RESELLER_REQUEST_ATTACHMENT_KINDS)[number];

/**
 * The list's four chips. `CONVERSING` is a PENDING request in which an operator has written
 * at least once — the owner's «در حال گفتگو». It is derived, never stored: the status stays
 * `PENDING` while people talk.
 */
export const RESELLER_REQUEST_LIST_FILTERS = [
  'PENDING',
  'CONVERSING',
  'APPROVED',
  'REJECTED',
] as const;
export type ResellerRequestListFilter = (typeof RESELLER_REQUEST_LIST_FILTERS)[number];

export const RESELLER_REQUEST_QUESTION_TEXT_MAX = 500;
export const RESELLER_REQUEST_ANSWER_DEFAULT_MAX = 500;
export const RESELLER_REQUEST_ANSWER_CEILING = 2000;
export const RESELLER_REQUEST_QUESTIONS_MAX = 20;
export const RESELLER_REQUEST_MESSAGE_MAX = 2000;
export const RESELLER_REQUEST_REASON_MAX = 500;
export const RESELLER_REQUEST_MESSAGES_MAX = 200;
export const RESELLER_REQUEST_PAGE_DEFAULT = 30;
export const RESELLER_REQUEST_PAGE_MAX = 100;
/** How long a customer's half-written application survives untouched. */
export const RESELLER_REQUEST_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
export const RESELLER_REQUEST_COOLDOWN_SETTING_KEY = 'reseller_request.cooldown_days' as const;

export const RESELLER_REQUEST_ERROR_CODES = {
  NOT_FOUND: 'reseller_request.not_found',
  /** The feature flag is off, or the customer is blocked: nothing can be started. */
  UNAVAILABLE: 'reseller_request.unavailable',
  /** The customer already is a reseller (ACTIVE or SUSPENDED): no request is created. */
  ALREADY_RESELLER: 'reseller_request.already_reseller',
  /** The customer already has a PENDING request; the details carry its number. */
  ALREADY_OPEN: 'reseller_request.already_open',
  /** A rejection is younger than `reseller_request.cooldown_days`; the details carry the rest. */
  COOLDOWN: 'reseller_request.cooldown',
  /** The request is already decided: it takes no message, no reply and no second decision. */
  CLOSED: 'reseller_request.closed',
  MESSAGE_INVALID: 'reseller_request.message_invalid',
  MESSAGE_LIMIT: 'reseller_request.message_limit',
  QUESTIONS_INVALID: 'reseller_request.questions_invalid',
  ANSWER_INVALID: 'reseller_request.answer_invalid',
  /** The chosen tier is not an existing, active reseller tier of this tenant. */
  TIER_INVALID: 'reseller_request.tier_invalid',
  ATTACHMENT_UNAVAILABLE: 'reseller_request.attachment_unavailable',
  /** The approval transaction is the next change's: the boundary exists, the body does not. */
  APPROVE_NOT_IMPLEMENTED: 'reseller_request.approve_not_implemented',
} as const;
export type ResellerRequestErrorCode =
  (typeof RESELLER_REQUEST_ERROR_CODES)[keyof typeof RESELLER_REQUEST_ERROR_CODES];

/**
 * The callback-data prefixes of the flow. One place, so a keyboard and the router agree.
 * Telegram caps `callback_data` at 64 bytes: a UUID is 36, an id pair is 43 (base64url).
 */
export const RESELLER_REQUEST_CALLBACKS = {
  /** `rq:<action>:<draftId>` — back, skip, send, edit. */
  step: 'rq:',
  /** `rqr:<requestId>` — the customer's «پاسخ». */
  reply: 'rqr:',
  /** `rqa:<requestId>` — the group's «✅ تأیید»: the tier list, in the operator's private chat. */
  approve: 'rqa:',
  /** `rqj:<requestId>` — the group's «❌ رد». */
  reject: 'rqj:',
  /** `rqm:<requestId>` — the group's «💬 پیام به متقاضی». */
  message: 'rqm:',
  /** `rqt:<pair(requestId, tierId)>` — a tier chosen: the confirmation. */
  tier: 'rqt:',
  /** `rqc:<pair(requestId, tierId)>` — the confirmation. */
  confirm: 'rqc:',
  /** `rqx:<requestId>` — an operator's cancel of a prompt. */
  cancel: 'rqx:',
  /** `rqp:<requestId>` — «رد بدون دلیل». */
  rejectPlain: 'rqp:',
} as const;

export const RESELLER_REQUEST_STEP_ACTIONS = ['b', 's', 'x', 'e'] as const;
export type ResellerRequestStepAction = (typeof RESELLER_REQUEST_STEP_ACTIONS)[number];

// --- The wire -------------------------------------------------------------------------------

export const RESELLER_REQUEST_ROUTES = {
  list: '/reseller-requests',
  detail: (id: string) => `/reseller-requests/${encodeURIComponent(id)}`,
  message: (id: string) => `/reseller-requests/${encodeURIComponent(id)}/messages`,
  approve: (id: string) => `/reseller-requests/${encodeURIComponent(id)}/approve`,
  reject: (id: string) => `/reseller-requests/${encodeURIComponent(id)}/reject`,
  attachment: (id: string) => `/reseller-request-messages/${encodeURIComponent(id)}/attachment`,
  questions: '/reseller-request-questions',
} as const;

const iso = z.iso.datetime();
const idempotencyKey = z.string().min(8).max(255);

export const resellerRequestQuestionViewSchema = z.object({
  id: uuidV7Schema,
  position: z.number().int().nonnegative(),
  text: z.string(),
  required: z.boolean(),
  maxLength: z.number().int().positive(),
});
export type ResellerRequestQuestionView = z.infer<typeof resellerRequestQuestionViewSchema>;

export const resellerRequestQuestionsResponseSchema = z.object({
  questions: z.array(resellerRequestQuestionViewSchema),
});
export type ResellerRequestQuestionsResponse = z.infer<
  typeof resellerRequestQuestionsResponseSchema
>;

/**
 * The whole ordered list, saved at once: what the drag-and-drop editor holds. An entry with
 * an id edits that question; one without is new; a stored question the list omits is removed.
 */
export const resellerRequestQuestionsSaveRequestSchema = z.object({
  idempotencyKey,
  questions: z
    .array(
      z.object({
        id: uuidV7Schema.optional(),
        text: z.string().trim().min(1).max(RESELLER_REQUEST_QUESTION_TEXT_MAX),
        required: z.boolean(),
        maxLength: z
          .number()
          .int()
          .min(1)
          .max(RESELLER_REQUEST_ANSWER_CEILING)
          .default(RESELLER_REQUEST_ANSWER_DEFAULT_MAX),
      }),
    )
    .max(RESELLER_REQUEST_QUESTIONS_MAX),
});
export type ResellerRequestQuestionsSaveRequest = z.infer<
  typeof resellerRequestQuestionsSaveRequestSchema
>;

/** One question as it was ASKED, with the answer — the snapshot stored on the request. */
export const resellerRequestAnswerSchema = z.object({
  questionId: z.string(),
  text: z.string(),
  required: z.boolean(),
  maxLength: z.number().int().positive(),
  answer: z.string().nullable(),
});
export type ResellerRequestAnswer = z.infer<typeof resellerRequestAnswerSchema>;

export const resellerRequestMessageViewSchema = z.object({
  id: z.string(),
  senderType: z.enum(RESELLER_REQUEST_MESSAGE_SENDERS),
  authorAdminName: z.string().nullable(),
  body: z.string().nullable(),
  attachmentKind: z.enum(RESELLER_REQUEST_ATTACHMENT_KINDS).nullable(),
  createdAt: iso,
});
export type ResellerRequestMessageView = z.infer<typeof resellerRequestMessageViewSchema>;

export const resellerRequestSummarySchema = z.object({
  id: uuidV7Schema,
  number: z.number().int().positive(),
  customerId: z.string(),
  customerName: z.string().nullable(),
  customerUsername: z.string().nullable(),
  status: z.enum(RESELLER_REQUEST_STATUSES),
  conversing: z.boolean(),
  createdAt: iso,
  decidedAt: iso.nullable(),
  lastMessageAt: iso.nullable(),
});
export type ResellerRequestSummary = z.infer<typeof resellerRequestSummarySchema>;

export const resellerRequestListQuerySchema = z.object({
  filter: z.enum(RESELLER_REQUEST_LIST_FILTERS).optional(),
  limit: z.coerce.number().int().positive().max(RESELLER_REQUEST_PAGE_MAX).optional(),
  before: iso.optional(),
  beforeId: uuidV7Schema.optional(),
});

export const resellerRequestListResponseSchema = z.object({
  requests: z.array(resellerRequestSummarySchema),
  /** Server totals for the four chips. */
  counts: z.object({
    pending: z.number().int().nonnegative(),
    conversing: z.number().int().nonnegative(),
    approved: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
  }),
  nextCursor: z.object({ at: iso, id: z.string() }).nullable(),
});
export type ResellerRequestListResponse = z.infer<typeof resellerRequestListResponseSchema>;

export const resellerRequestDetailSchema = resellerRequestSummarySchema.extend({
  answers: z.array(resellerRequestAnswerSchema),
  reason: z.string().nullable(),
  decidedByName: z.string().nullable(),
  tierId: z.string().nullable(),
  tierName: z.string().nullable(),
  servicesCount: z.number().int().nonnegative(),
  messages: z.array(resellerRequestMessageViewSchema),
});
export type ResellerRequestDetail = z.infer<typeof resellerRequestDetailSchema>;
export const resellerRequestDetailResponseSchema = z.object({
  request: resellerRequestDetailSchema,
});
export type ResellerRequestDetailResponse = z.infer<typeof resellerRequestDetailResponseSchema>;

export const resellerRequestMessageRequestSchema = z.object({
  idempotencyKey,
  text: z.string().trim().min(1).max(RESELLER_REQUEST_MESSAGE_MAX),
});
export const resellerRequestApproveRequestSchema = z.object({
  idempotencyKey,
  tierId: uuidV7Schema,
});
export const resellerRequestRejectRequestSchema = z.object({
  idempotencyKey,
  reason: z.string().trim().min(1).max(RESELLER_REQUEST_REASON_MAX).optional(),
});

// --- The templates --------------------------------------------------------------------------

const ph = (
  token: string,
  type: PlaceholderDefinition['type'],
  description: string,
  extra: { readonly required?: boolean; readonly untrusted?: boolean } = {},
): PlaceholderDefinition => ({
  token,
  type,
  description,
  required: extra.required ?? true,
  repeatable: false,
  ...(extra.untrusted === true ? { untrusted: true } : {}),
});

function tpl<const K extends string>(
  key: K,
  description: string,
  placeholders: readonly PlaceholderDefinition[] = [],
): TemplateDefinition & { readonly key: K } {
  return { key, description, format: 'PLAIN_TEXT', placeholders };
}

const NUMBER_PH = ph('number', 'NUMBER', 'The request number the customer and the operator quote.');

export const RESELLER_REQUEST_TEMPLATES = [
  tpl(
    'bot.menu.reseller_request',
    'PR-2: the main-menu button that opens the reseller request. Drawn only while the reseller_requests flag is on; the default label is «👨‍💻 درخواست نمایندگی» and the default style danger.',
  ),
  tpl(
    'bot.reseller_request.intro',
    'PR-2: the first screen of a reseller request, before the owner’s questions. Edited in place into the first question by «شروع».',
  ),
  tpl(
    'bot.reseller_request.question',
    'PR-2: one of the owner’s REQUIRED questions, edited in place. current is the answer already given when the customer came back to it.',
    [
      ph('index', 'NUMBER', 'This question’s position, from one.'),
      ph('total', 'NUMBER', 'How many questions there are.'),
      ph('question', 'STRING', 'The question, exactly as the owner wrote it.'),
      ph('current', 'STRING', 'The answer given before, when the customer came back.', {
        required: false,
        untrusted: true,
      }),
    ],
  ),
  tpl(
    'bot.reseller_request.question_optional',
    'PR-2: one of the owner’s OPTIONAL questions, edited in place; the screen carries «رد کردن».',
    [
      ph('index', 'NUMBER', 'This question’s position, from one.'),
      ph('total', 'NUMBER', 'How many questions there are.'),
      ph('question', 'STRING', 'The question, exactly as the owner wrote it.'),
      ph('current', 'STRING', 'The answer given before, when the customer came back.', {
        required: false,
        untrusted: true,
      }),
    ],
  ),
  tpl(
    'bot.reseller_request.summary',
    'PR-2: every question with its answer, before sending. «ارسال» files the request; «ویرایش» goes back to the first question.',
    [ph('answers', 'STRING', 'The questions and answers, one block each.', { untrusted: true })],
  ),
  tpl('bot.reseller_request.submitted', 'PR-2: «درخواست شما ثبت شد» — the request was filed.', [
    ph('number', 'NUMBER', 'The request number.', { required: false }),
  ]),
  tpl(
    'bot.reseller_request.already_reseller',
    'PR-2: the customer already is a reseller; no request is created.',
  ),
  tpl(
    'bot.reseller_request.status_pending',
    'PR-2: the customer tapped the button again while a request waits for a decision.',
    [NUMBER_PH],
  ),
  tpl(
    'bot.reseller_request.status_conversing',
    'PR-2: as status_pending, once an operator has written to the customer («در حال گفتگو»).',
    [NUMBER_PH],
  ),
  tpl(
    'bot.reseller_request.cooldown',
    'PR-2: a request was rejected recently; a new one is allowed after the wait. reason is the operator’s, when there was one.',
    [
      ph('days', 'NUMBER', 'Whole days still to wait.'),
      ph('reason', 'STRING', 'Why the last request was rejected.', { required: false }),
    ],
  ),
  tpl(
    'bot.reseller_request.unavailable',
    'PR-2: the reseller request is not offered (flag off), or a button of an old screen was tapped.',
  ),
  tpl('bot.reseller_request.answer_invalid', 'PR-2: the typed answer is empty or too long.', [
    ph('max', 'NUMBER', 'The longest answer this question takes.'),
  ]),
  tpl(
    'bot.reseller_request.approved',
    'PR-2: the decision message on approval, with the tier name.',
    [ph('tier', 'STRING', 'The reseller tier the customer was approved on.')],
  ),
  tpl(
    'bot.reseller_request.rejected',
    'PR-2: the decision message on rejection; the reason line is dropped when none was given.',
    [ph('reason', 'STRING', 'The operator’s reason.', { required: false })],
  ),
  tpl(
    'bot.reseller_request.message_from_owner',
    'PR-2: a message the operator wrote to the applicant (RESELLER_REQUEST_MESSAGE). Read at send time from the message row; the one button is «پاسخ».',
    [NUMBER_PH, ph('text', 'STRING', 'The operator’s message, exactly as stored.')],
  ),
  tpl(
    'bot.reseller_request.reply_prompt',
    'PR-2: asks for the applicant’s reply (text or a photo).',
    [NUMBER_PH],
  ),
  tpl(
    'bot.reseller_request.reply_sent',
    'PR-2: the applicant’s reply was attached to the request.',
  ),
  tpl(
    'bot.reseller_request.thread_closed',
    'PR-2: the request was decided; the conversation takes no more replies.',
  ),
  tpl('bot.reseller_request.button_start', 'PR-2: the intro’s button that starts the questions.'),
  tpl('bot.reseller_request.button_skip', 'PR-2: skips an optional question.'),
  tpl('bot.reseller_request.button_back', 'PR-2: back to the previous question.'),
  tpl('bot.reseller_request.button_send', 'PR-2: files the request from the summary.'),
  tpl('bot.reseller_request.button_edit', 'PR-2: edits the answers from the summary.'),
  tpl(
    'bot.reseller_request.button_reply',
    'PR-2: the applicant’s «پاسخ» under an operator message.',
  ),
  tpl(
    'bot.admin.reseller_request.tiers',
    'PR-2: the operator’s private screen after «✅ تأیید» in the group — the active reseller tiers to choose from.',
    [NUMBER_PH],
  ),
  tpl(
    'bot.admin.reseller_request.confirm',
    'PR-2: the operator’s confirmation before the applicant becomes a reseller on the chosen tier.',
    [NUMBER_PH, ph('tier', 'STRING', 'The chosen tier’s name.')],
  ),
  tpl(
    'bot.admin.reseller_request.reject_prompt',
    'PR-2: asks the operator for an optional reason (a message), or «رد بدون دلیل».',
    [NUMBER_PH],
  ),
  tpl(
    'bot.admin.reseller_request.message_prompt',
    'PR-2: asks the operator for the message to the applicant.',
    [NUMBER_PH],
  ),
  tpl('bot.admin.reseller_request.done_approved', 'PR-2: the operator approved the request.', [
    NUMBER_PH,
    ph('tier', 'STRING', 'The tier.'),
  ]),
  tpl('bot.admin.reseller_request.done_rejected', 'PR-2: the operator rejected the request.', [
    NUMBER_PH,
  ]),
  tpl('bot.admin.reseller_request.done_message', 'PR-2: the operator’s message was sent.', [
    NUMBER_PH,
  ]),
  tpl(
    'bot.admin.reseller_request.closed',
    'PR-2: the request is already decided, or the tier is gone; nothing was changed.',
  ),
  tpl(
    'bot.admin.reseller_request.start_bot',
    'PR-2: a tap in the group by an administrator who has never opened the bot in a private chat, where the bot can write to them only after /start.',
  ),
  tpl('bot.admin.reseller_request.not_implemented', 'PR-2: approval is not available yet.'),
  tpl('bot.admin.reseller_request.button_confirm', 'PR-2: the operator’s «تأیید نهایی».'),
  tpl('bot.admin.reseller_request.button_cancel', 'PR-2: cancels an operator prompt.'),
  tpl('bot.admin.reseller_request.button_reject_plain', 'PR-2: rejects with no reason.'),
] as const;
