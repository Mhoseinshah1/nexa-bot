import {
  COMMERCE_ERROR_CODES,
  PLATFORM_ERROR_CODES,
  RESELLER_REQUEST_COOLDOWN_SETTING_KEY,
  RESELLER_REQUEST_ERROR_CODES,
  RESELLER_REQUEST_MESSAGES_MAX,
  RESELLER_REQUEST_MESSAGE_MAX,
  RESELLER_REQUEST_QUESTIONS_MAX,
  RESELLER_REQUEST_REASON_MAX,
  RESELLER_REQUEST_PAGE_DEFAULT,
  RESELLER_REQUEST_PAGE_MAX,
  errors,
  uuidV7Schema,
  type ActorContext,
  type AuditWriter,
  type BotInstanceId,
  type Clock,
  type CustomerNotificationKind,
  type FeatureFlagKey,
  type IdGenerator,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type PermissionKey,
  type ResellerRequestAnswer,
  type ResellerRequestListFilter,
  type SettingKey,
  type TemplateKey,
  type TemplateValues,
  type TenantContext,
  type UnitOfWork,
  type UserId,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
} from '../../../platform/access/application/authorized-mutation.js';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { CustomerNotifier } from '../../messaging/application/customer-notifier.js';
import type { CustomerRepository } from '../../customers/application/ports.js';
import type { ResellerRepository } from '../../resellers/application/ports.js';
import type { ResellerAdminService } from '../../resellers/application/reseller-admin.service.js';
import type {
  AskedQuestion,
  CustomerFacts,
  DraftRecord,
  MessageAttachment,
  MessageRecord,
  QuestionRecord,
  RequestCounts,
  RequestRecord,
  ResellerRequestRepository,
} from './ports.js';

/** Reading and acting on requests is reseller management (`resellers.view` / `resellers.edit`). */
export const RESELLER_REQUEST_VIEW_PERMISSION: PermissionKey = 'resellers.view';
export const RESELLER_REQUEST_EDIT_PERMISSION: PermissionKey = 'resellers.edit';
/** What the bot's own customer-side writes run under (`SYSTEM_JOB` holds it), as tickets do. */
const CUSTOMER_PERMISSION: PermissionKey = 'maintenance.run';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ResellerRequestServiceDeps {
  readonly requests: ResellerRequestRepository;
  readonly resellers: Pick<ResellerRepository, 'findByCustomer' | 'findTier' | 'listTiers'>;
  /**
   * The ONE way a customer becomes a reseller — the Web Admin's «ثبت نماینده»
   * (`ResellerAdminService.register`), joined to the approval's transaction.
   */
  readonly registrar: Pick<ResellerAdminService, 'registerWithin'>;
  readonly customers: Pick<CustomerRepository, 'findById'>;
  readonly features: {
    isEnabled(scope: TenantContext, key: FeatureFlagKey, tx?: unknown): Promise<boolean>;
  };
  readonly settings: {
    valueOf<T>(scope: TenantContext, key: SettingKey, tx?: unknown): Promise<T>;
  };
  readonly notifier: Pick<CustomerNotifier, 'notifyThrough'>;
  readonly outbox: OutboxWriter;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

// -- What the bot is told -------------------------------------------------------------------

/** A screen of the customer's application, edit-in-place. */
export type DraftView =
  | { readonly screen: 'INTRO'; readonly draftId: string }
  | {
      readonly screen: 'QUESTION';
      readonly draftId: string;
      readonly index: number;
      readonly count: number;
      readonly question: AskedQuestion;
      readonly current: string | null;
    }
  | {
      readonly screen: 'SUMMARY';
      readonly draftId: string;
      readonly answers: readonly { readonly text: string; readonly answer: string | null }[];
    };

export type EntryOutcome =
  | { readonly kind: 'UNAVAILABLE' }
  | { readonly kind: 'ALREADY_RESELLER' }
  | { readonly kind: 'OPEN'; readonly request: RequestRecord; readonly conversing: boolean }
  | { readonly kind: 'COOLDOWN'; readonly daysLeft: number; readonly reason: string | null }
  | { readonly kind: 'START'; readonly view: DraftView };

export type DraftAction = 'START' | 'ANSWER' | 'SKIP' | 'BACK' | 'EDIT';

export type DraftOutcome =
  | { readonly kind: 'VIEW'; readonly view: DraftView }
  /** The typed answer is empty or longer than the question's bound; the screen is unchanged. */
  | { readonly kind: 'INVALID'; readonly maxLength: number }
  /** The draft is gone (replaced, submitted or never existed): the tap is stale. */
  | { readonly kind: 'GONE' };

export type SubmitOutcome =
  | { readonly kind: 'FILED'; readonly request: RequestRecord; readonly replayed: boolean }
  | { readonly kind: 'REFUSED'; readonly entry: EntryOutcome }
  | { readonly kind: 'GONE' };

export interface RequestDecisionResult {
  readonly request: RequestRecord;
  /** False when the request was already in the state asked for. */
  readonly changed: boolean;
}

export interface RequestDetail {
  readonly request: RequestRecord;
  readonly conversing: boolean;
  readonly customer: CustomerFacts | null;
  readonly decidedByName: string | null;
  readonly tierName: string | null;
  readonly messages: readonly (MessageRecord & { readonly authorAdminName: string | null })[];
}

export interface NotificationFacts {
  readonly values: TemplateValues;
  readonly templateKey?: TemplateKey;
  /** The request the «پاسخ» button names, only while it is still PENDING. */
  readonly replyRequestId: string | null;
}

// -- The service ----------------------------------------------------------------------------

/**
 * «درخواست نمایندگی» (owner batch 1, PR-2): a customer's request to become a reseller, the
 * owner's questions, the conversation before the decision, and the decision.
 *
 * Every write takes a scope and an actor, reads scope activity INSIDE its transaction,
 * carries an idempotency key, writes its outbox event in that transaction and is audited.
 * Acting needs `resellers.edit`; the customer-side writes run as the bot's system actor.
 * Nothing here touches a wallet or a credit.
 */
export class ResellerRequestService {
  constructor(private readonly deps: ResellerRequestServiceDeps) {}

  // =========================================================================================
  // The owner's questions
  // =========================================================================================

  async listQuestions(
    scope: TenantContext,
    actor: ActorContext,
  ): Promise<readonly QuestionRecord[]> {
    await this.deps.guard.check(scope, actor, RESELLER_REQUEST_VIEW_PERMISSION);
    return this.deps.requests.listQuestions(scope);
  }

  /**
   * Saves the whole ordered list. An entry with an id edits that question, one without is
   * new, a stored question the list leaves out is removed (made inactive). Requests already
   * filed are not touched: they stored the questions as they were asked.
   */
  async saveQuestions(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly questions: readonly {
        readonly id?: string | undefined;
        readonly text: string;
        readonly required: boolean;
        readonly maxLength: number;
      }[];
    },
  ): Promise<{ readonly questions: readonly QuestionRecord[]; readonly changed: boolean }> {
    if (input.questions.length > RESELLER_REQUEST_QUESTIONS_MAX) throw this.questionsInvalid();
    const requestHash = hashRequest({ op: 'save-questions', questions: input.questions });
    const denial = {
      action: 'reseller_request.questions.save',
      entityType: 'ResellerRequestQuestions',
      entityId: null,
    };
    await this.authorize(scope, actor, denial);
    const replayed = await this.deps.idempotency.find<{ ok: true }>(
      scope,
      actor.surface,
      input.idempotencyKey,
      requestHash,
    );
    if (replayed !== null) {
      return { questions: await this.deps.requests.listQuestions(scope), changed: false };
    }
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      RESELLER_REQUEST_EDIT_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        await this.deps.requests.lockTenant(scope, tx);
        const before = await this.deps.requests.listQuestions(scope, tx);
        const byId = new Map(before.map((one) => [one.id, one]));
        const seen = new Set<string>();
        const next = input.questions.map((one) => {
          const id = one.id;
          if (id === undefined) {
            return { id: this.deps.ids.uuid(), isNew: true, ...fields(one) };
          }
          if (!byId.has(id) || seen.has(id)) throw this.questionsInvalid();
          seen.add(id);
          return { id, isNew: false, ...fields(one) };
        });
        const unchanged =
          before.length === next.length &&
          next.every((one, index) => {
            const old = before[index];
            return (
              old !== undefined &&
              !one.isNew &&
              old.id === one.id &&
              old.text === one.text &&
              old.required === one.required &&
              old.maxLength === one.maxLength
            );
          });
        if (!unchanged) {
          await this.deps.requests.replaceQuestions(scope, next, this.deps.clock.now(), tx);
          await this.deps.audit.record(
            scope,
            actor,
            {
              action: 'reseller_request.questions.save',
              entityType: 'ResellerRequestQuestions',
              entityId: null,
              before: {
                questions: before.map(({ id, text, required, maxLength }) => ({
                  id,
                  text,
                  required,
                  maxLength,
                })),
              },
              after: {
                questions: next.map(({ id, text, required, maxLength }) => ({
                  id,
                  text,
                  required,
                  maxLength,
                })),
              },
              result: 'SUCCESS',
            },
            tx,
          );
        }
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          input.idempotencyKey,
          requestHash,
          { ok: true },
          tx,
        );
        return {
          questions: await this.deps.requests.listQuestions(scope, tx),
          changed: !unchanged,
        };
      },
    );
  }

  // =========================================================================================
  // The customer's application
  // =========================================================================================

  /**
   * What the customer meets when they tap the button. Either the reason they cannot start
   * (not offered, already a reseller, a request is open, the wait after a rejection), or a
   * fresh application at its intro. Starting replaces any half-written draft.
   */
  async enter(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly customerId: UserId;
      readonly botInstanceId: BotInstanceId;
      readonly idempotencyKey: string;
    },
  ): Promise<EntryOutcome> {
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      CUSTOMER_PERMISSION,
      { action: 'reseller_request.enter', entityType: 'Customer', entityId: input.customerId },
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        await this.deps.requests.lockCustomer(scope, input.customerId, tx);
        const blocked = await this.entryBlock(scope, input.customerId, tx);
        if (blocked !== null) return blocked;
        const questions = await this.deps.requests.listQuestions(scope, tx);
        const draft = await this.deps.requests.putDraft(
          scope,
          {
            id: this.deps.ids.uuid(),
            customerId: input.customerId,
            botInstanceId: input.botInstanceId,
            questions: questions.map(asked),
          },
          this.deps.clock.now(),
          tx,
        );
        return { kind: 'START', view: draftView(draft, 'INTRO') };
      },
    );
  }

  /** One step of the application: the answer, a skip, a step back, the edit or the start. */
  async step(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly customerId: UserId;
      readonly draftId: string;
      readonly action: DraftAction;
      readonly text?: string;
    },
  ): Promise<DraftOutcome> {
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      CUSTOMER_PERMISSION,
      { action: 'reseller_request.step', entityType: 'Customer', entityId: input.customerId },
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        await this.deps.requests.lockCustomer(scope, input.customerId, tx);
        const draft = await this.deps.requests.findDraftByCustomer(scope, input.customerId, tx);
        if (draft === null || draft.id !== input.draftId) return { kind: 'GONE' };
        const total = draft.questions.length;
        const answers = [...draft.answers];
        let position = draft.position;
        const now = this.deps.clock.now();
        switch (input.action) {
          case 'START':
            return {
              kind: 'VIEW',
              view: draftView(draft, position >= total ? 'SUMMARY' : 'QUESTION'),
            };
          case 'ANSWER': {
            const question = draft.questions[position];
            if (question === undefined) return { kind: 'GONE' };
            const text = (input.text ?? '').trim();
            if (text === '' || Array.from(text).length > question.maxLength) {
              return { kind: 'INVALID', maxLength: question.maxLength };
            }
            answers[position] = text;
            position += 1;
            break;
          }
          case 'SKIP': {
            const question = draft.questions[position];
            // A required question cannot be skipped; the tap is stale (the button is not drawn).
            if (question === undefined || question.required) return { kind: 'GONE' };
            answers[position] = null;
            position += 1;
            break;
          }
          case 'BACK': {
            if (position === 0) {
              return { kind: 'VIEW', view: { screen: 'INTRO', draftId: draft.id } };
            }
            position -= 1;
            break;
          }
          case 'EDIT':
            position = 0;
            break;
        }
        await this.deps.requests.saveDraft(scope, draft.id, { answers, position }, now, tx);
        return {
          kind: 'VIEW',
          view: draftView(
            { ...draft, answers, position },
            position >= total ? 'SUMMARY' : 'QUESTION',
          ),
        };
      },
    );
  }

  /**
   * Files the request from the summary. The rules are checked again here, in the filing
   * transaction: a customer who became a reseller, or filed through another bot, between the
   * intro and «ارسال» gets the refusal and no second request.
   */
  async submit(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly customerId: UserId;
      readonly draftId: string;
      readonly idempotencyKey: string;
    },
  ): Promise<SubmitOutcome> {
    const openingKey = `submit:${input.idempotencyKey}`;
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      CUSTOMER_PERMISSION,
      { action: 'reseller_request.submit', entityType: 'Customer', entityId: input.customerId },
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        await this.deps.requests.lockCustomer(scope, input.customerId, tx);
        const replay = await this.deps.requests.findByOpeningKey(scope, openingKey, tx);
        if (replay !== null) {
          if (replay.customerId !== input.customerId) return { kind: 'GONE' };
          return { kind: 'FILED', request: replay, replayed: true };
        }
        const draft = await this.deps.requests.findDraftByCustomer(scope, input.customerId, tx);
        if (draft === null || draft.id !== input.draftId) return { kind: 'GONE' };
        const blocked = await this.entryBlock(scope, input.customerId, tx);
        if (blocked !== null) return { kind: 'REFUSED', entry: blocked };
        const snapshot: ResellerRequestAnswer[] = draft.questions.map((question, index) => ({
          questionId: question.questionId,
          text: question.text,
          required: question.required,
          maxLength: question.maxLength,
          answer: draft.answers[index] ?? null,
        }));
        if (snapshot.some((one) => one.required && one.answer === null)) {
          throw errors.validation(
            RESELLER_REQUEST_ERROR_CODES.ANSWER_INVALID,
            'A required question has no answer.',
          );
        }
        const request = await this.deps.requests.insertRequest(
          scope,
          {
            id: this.deps.ids.uuid(),
            customerId: input.customerId,
            botInstanceId: draft.botInstanceId,
            answers: snapshot,
            openingKey,
          },
          this.deps.clock.now(),
          tx,
        );
        await this.deps.requests.deleteDraft(scope, draft.id, tx);
        await this.deps.outbox.write(tx, actor, {
          eventType: 'ResellerRequestSubmitted',
          aggregateType: 'ResellerRequest',
          aggregateId: request.id,
          payload: { requestId: request.id, customerId: request.customerId },
        });
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'reseller_request.submit',
            entityType: 'ResellerRequest',
            entityId: request.id,
            before: null,
            after: { number: request.number.toString(), questions: snapshot.length },
            result: 'SUCCESS',
          },
          tx,
        );
        return { kind: 'FILED', request, replayed: false };
      },
    );
  }

  /** The customer's own pending request, for the status line and the reply button. */
  async openRequestOf(
    scope: TenantContext,
    customerId: UserId,
  ): Promise<{ readonly request: RequestRecord; readonly conversing: boolean } | null> {
    const request = await this.deps.requests.findPendingByCustomer(scope, customerId);
    if (request === null) return null;
    return { request, conversing: await this.hasAdminMessage(scope, request.id) };
  }

  /**
   * The applicant's reply, text or a photo, attached to the request. Refused with CLOSED
   * once the request is decided: the thread takes no more replies.
   */
  async customerReply(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly customerId: UserId;
      readonly requestId: string;
      readonly text: string | null;
      readonly attachment: MessageAttachment | null;
      readonly idempotencyKey: string;
    },
  ): Promise<{ readonly message: MessageRecord; readonly replayed: boolean }> {
    const body = normalizeMessage(input.text);
    if ((input.text !== null && body === null) || (body === null && input.attachment === null)) {
      throw this.messageInvalid();
    }
    const requestHash = hashRequest({
      op: 'customer-reply',
      requestId: input.requestId,
      body,
      file: input.attachment?.fileUniqueId ?? null,
    });
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      CUSTOMER_PERMISSION,
      {
        action: 'reseller_request.reply',
        entityType: 'ResellerRequest',
        entityId: input.requestId,
      },
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const request = await this.lockedRequestOf(scope, input.requestId, tx);
        if (request === null || request.customerId !== input.customerId) throw this.notFound();
        const key = `customer:${input.idempotencyKey}`;
        const written = await this.deps.requests.findMessageByKey(scope, key, tx);
        if (written !== null) {
          this.assertSameRequest(written, requestHash);
          return { message: written, replayed: true };
        }
        if (request.status !== 'PENDING') throw this.closed();
        await this.assertRoom(scope, request.id, tx);
        const now = this.deps.clock.now();
        const message = await this.deps.requests.insertMessage(
          scope,
          {
            id: this.deps.ids.uuid(),
            requestId: request.id,
            senderType: 'CUSTOMER',
            authorAdminId: null,
            body,
            attachment: input.attachment,
            idempotencyKey: key,
            requestHash,
          },
          now,
          tx,
        );
        await this.deps.requests.touch(scope, request.id, now, tx);
        await this.deps.outbox.write(tx, actor, {
          eventType: 'ResellerRequestMessagePosted',
          aggregateType: 'ResellerRequest',
          aggregateId: request.id,
          payload: { requestId: request.id, messageId: message.id, senderType: 'CUSTOMER' },
        });
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'reseller_request.customer_reply',
            entityType: 'ResellerRequest',
            entityId: request.id,
            before: null,
            after: { messageId: message.id, hasFile: input.attachment !== null },
            result: 'SUCCESS',
          },
          tx,
        );
        return { message, replayed: false };
      },
    );
  }

  // =========================================================================================
  // The operator
  // =========================================================================================

  async list(
    scope: TenantContext,
    actor: ActorContext,
    query: {
      readonly filter?: ResellerRequestListFilter | undefined;
      readonly limit?: number | undefined;
      readonly before?: { readonly at: Date; readonly id: string } | undefined;
    },
  ) {
    await this.deps.guard.check(scope, actor, RESELLER_REQUEST_VIEW_PERMISSION);
    const limit = Math.min(
      Math.max(1, Math.trunc(query.limit ?? RESELLER_REQUEST_PAGE_DEFAULT)),
      RESELLER_REQUEST_PAGE_MAX,
    );
    const items = await this.deps.requests.list(scope, {
      filter: query.filter ?? null,
      limit: limit + 1,
      before: query.before ?? null,
    });
    const page = items.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page,
      counts: await this.deps.requests.counts(scope),
      next:
        items.length > limit && last !== undefined
          ? { at: last.request.createdAt, id: last.request.id }
          : null,
    };
  }

  async counts(scope: TenantContext, actor: ActorContext): Promise<RequestCounts> {
    await this.deps.guard.check(scope, actor, RESELLER_REQUEST_VIEW_PERMISSION);
    return this.deps.requests.counts(scope);
  }

  async get(scope: TenantContext, actor: ActorContext, rawId: string): Promise<RequestDetail> {
    await this.deps.guard.check(scope, actor, RESELLER_REQUEST_VIEW_PERMISSION);
    const id = uuidV7Schema.safeParse(rawId);
    const request = id.success ? await this.deps.requests.findById(scope, id.data) : null;
    if (request === null) throw this.notFound();
    return this.detailOf(scope, request);
  }

  /** The detail of a request the caller has already found (the group card's buttons). */
  async detailOf(scope: TenantContext, request: RequestRecord): Promise<RequestDetail> {
    const messages = await this.deps.requests.listMessages(scope, request.id);
    const adminIds = [
      ...new Set(
        [request.decidedByAdminId, ...messages.map((one) => one.authorAdminId)].filter(
          (one): one is string => one !== null,
        ),
      ),
    ];
    const names = await this.deps.requests.adminNames(scope, adminIds);
    const tier =
      request.tierId === null ? null : await this.deps.resellers.findTier(scope, request.tierId);
    return {
      request,
      conversing: messages.some((one) => one.senderType === 'ADMIN'),
      customer: await this.deps.requests.customerFacts(scope, request.customerId),
      decidedByName:
        request.decidedByAdminId === null ? null : (names.get(request.decidedByAdminId) ?? null),
      tierName: tier?.name ?? null,
      messages: messages.map((one) => ({
        ...one,
        authorAdminName: one.authorAdminId === null ? null : (names.get(one.authorAdminId) ?? null),
      })),
    };
  }

  /** The customer row of a Telegram account (an administrator's own text window), or null. */
  customerIdOfTelegramUser(scope: TenantContext, telegramUserId: string): Promise<string | null> {
    return this.deps.requests.customerIdOfTelegramUser(scope, telegramUserId);
  }

  /** The active reseller tiers an operator may approve onto. */
  async tiersFor(scope: TenantContext, actor: ActorContext) {
    await this.deps.guard.check(scope, actor, RESELLER_REQUEST_EDIT_PERMISSION);
    return (await this.deps.resellers.listTiers(scope)).map((tier) => ({
      id: tier.id,
      name: tier.name,
    }));
  }

  /** The Telegram file behind an applicant's photo, for the Web Admin to fetch with the bot. */
  async attachmentOf(scope: TenantContext, actor: ActorContext, rawId: string) {
    await this.deps.guard.check(scope, actor, RESELLER_REQUEST_VIEW_PERMISSION);
    const id = uuidV7Schema.safeParse(rawId);
    const message = id.success ? await this.deps.requests.findMessageById(scope, id.data) : null;
    if (message === null || message.attachment === null) {
      throw errors.notFound(
        RESELLER_REQUEST_ERROR_CODES.ATTACHMENT_UNAVAILABLE,
        'This message has no attachment.',
      );
    }
    return { message, attachment: message.attachment };
  }

  /**
   * An operator's message to the applicant. The request stays PENDING and now reads
   * «در حال گفتگو». The customer is told through the notification lane in this transaction.
   */
  async postMessage(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly requestId: string; readonly text: string; readonly idempotencyKey: string },
  ): Promise<{ readonly message: MessageRecord; readonly replayed: boolean }> {
    const body = normalizeMessage(input.text);
    if (body === null) throw this.messageInvalid();
    const requestId = this.idOf(input.requestId);
    const denial = {
      action: 'reseller_request.message',
      entityType: 'ResellerRequest',
      entityId: requestId,
    };
    await this.authorize(scope, actor, denial);
    const adminId = this.adminIdOf(actor);
    const key = `${actor.surface}:${adminId}:${input.idempotencyKey}`;
    const requestHash = hashRequest({ op: 'admin-message', requestId, body });
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      RESELLER_REQUEST_EDIT_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const request = await this.lockedRequestOf(scope, requestId, tx);
        if (request === null) throw this.notFound();
        const written = await this.deps.requests.findMessageByKey(scope, key, tx);
        if (written !== null) {
          this.assertSameRequest(written, requestHash);
          return { message: written, replayed: true };
        }
        if (request.status !== 'PENDING') throw this.closed();
        await this.assertRoom(scope, request.id, tx);
        const now = this.deps.clock.now();
        const message = await this.deps.requests.insertMessage(
          scope,
          {
            id: this.deps.ids.uuid(),
            requestId: request.id,
            senderType: 'ADMIN',
            authorAdminId: adminId,
            body,
            attachment: null,
            idempotencyKey: key,
            requestHash,
          },
          now,
          tx,
        );
        await this.deps.requests.touch(scope, request.id, now, tx);
        // Through the bot the request was filed on: the conversation is held in ONE chat.
        await this.deps.notifier.notifyThrough(
          scope,
          request.customerId as UserId,
          request.botInstanceId as BotInstanceId,
          'RESELLER_REQUEST_MESSAGE',
          message.id,
          now,
          tx,
        );
        await this.deps.outbox.write(tx, actor, {
          eventType: 'ResellerRequestMessagePosted',
          aggregateType: 'ResellerRequest',
          aggregateId: request.id,
          payload: { requestId: request.id, messageId: message.id, senderType: 'ADMIN' },
        });
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'reseller_request.message',
            entityType: 'ResellerRequest',
            entityId: request.id,
            before: null,
            after: { messageId: message.id },
            result: 'SUCCESS',
          },
          tx,
        );
        return { message, replayed: false };
      },
    );
  }

  /**
   * Rejects the request, with an optional reason. Idempotent: the same key replays, and a
   * request already rejected stays as it is (`changed: false`, no second message to the
   * customer). A request already APPROVED is CLOSED. The decision closes the thread.
   */
  async reject(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly requestId: string;
      readonly reason?: string | undefined;
      readonly idempotencyKey: string;
    },
  ): Promise<RequestDecisionResult> {
    const requestId = this.idOf(input.requestId);
    const reason = normalizeReason(input.reason);
    if (input.reason !== undefined && reason === null && input.reason.trim() !== '') {
      throw errors.validation(
        RESELLER_REQUEST_ERROR_CODES.MESSAGE_INVALID,
        `A reason is at most ${String(RESELLER_REQUEST_REASON_MAX)} characters.`,
      );
    }
    const denial = {
      action: 'reseller_request.reject',
      entityType: 'ResellerRequest',
      entityId: requestId,
    };
    await this.authorize(scope, actor, denial);
    const adminId = this.adminIdOf(actor);
    const requestHash = hashRequest({ op: 'reject', requestId, reason });
    const replayed = await this.deps.idempotency.find<{ requestId: string }>(
      scope,
      actor.surface,
      input.idempotencyKey,
      requestHash,
    );
    if (replayed !== null) {
      const found = await this.deps.requests.findById(scope, replayed.result.requestId);
      if (found !== null) return { request: found, changed: false };
    }
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      RESELLER_REQUEST_EDIT_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const request = await this.lockedRequestOf(scope, requestId, tx);
        if (request === null) throw this.notFound();
        let changed = false;
        let current = request;
        if (request.status === 'APPROVED') throw this.closed();
        if (request.status === 'PENDING') {
          const now = this.deps.clock.now();
          const moved = await this.deps.requests.decide(
            scope,
            request.id,
            { status: 'REJECTED', adminId, tierId: null, reason },
            now,
            tx,
          );
          /* istanbul ignore next -- the row lock is held and PENDING was just read. */
          if (!moved) throw this.closed();
          changed = true;
          current = (await this.deps.requests.findById(scope, request.id, tx)) ?? request;
          await this.deps.notifier.notifyThrough(
            scope,
            request.customerId as UserId,
            request.botInstanceId as BotInstanceId,
            'RESELLER_REQUEST_DECISION',
            request.id,
            now,
            tx,
          );
          await this.deps.outbox.write(tx, actor, {
            eventType: 'ResellerRequestDecided',
            aggregateType: 'ResellerRequest',
            aggregateId: request.id,
            payload: {
              requestId: request.id,
              customerId: request.customerId,
              status: 'REJECTED',
              tierId: null,
            },
          });
          await this.deps.audit.record(
            scope,
            actor,
            {
              action: 'reseller_request.reject',
              entityType: 'ResellerRequest',
              entityId: request.id,
              before: { status: 'PENDING' },
              after: { status: 'REJECTED', reason },
              result: 'SUCCESS',
            },
            tx,
          );
        }
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          input.idempotencyKey,
          requestHash,
          { requestId: request.id },
          tx,
        );
        return { request: current, changed };
      },
    );
  }

  /**
   * Approves the request: the customer becomes a reseller on the chosen tier.
   *
   * ONE transaction holds all of it: the scope's activity, the request locked `FOR UPDATE`
   * and still PENDING, the tier (this tenant's), the registration — the SAME one the Web
   * Admin's «ثبت نماینده» runs (`ResellerAdminService.registerWithin`: `resellers.edit`, the
   * `reseller.register` audit row, the `ResellerStandingChanged` event the operations log
   * reports) — the decision, its `ResellerRequestDecided` event, the customer's decision
   * message (the lane reads the tier's name from the row) and the idempotency record. A
   * failure anywhere leaves the request PENDING and the customer as they were.
   *
   * NO wallet entry and NO credit: the registration is on the tier's terms (`TIER` pricing,
   * no discount, no credit limit of its own), exactly what the register form submits by
   * default; `registerWithin` refuses any non-zero limit as `register` does.
   *
   * Idempotent and race-safe. The same key replays. A second approve with another key (a
   * second tap, the group and the Web Admin at once) waits on the row lock, finds the
   * request APPROVED and returns it unchanged (`changed: false`): no second registration,
   * audit row or message. A request already REJECTED is CLOSED. A customer who became a
   * reseller some other way while the request was open is refused (`ALREADY_RESELLER`) and
   * the request stays PENDING for the operator to reject: approving would claim a tier the
   * customer is not on, and a standing change is `ResellerAdminService.update`'s, with its
   * written reason.
   */
  async approve(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly requestId: string;
      readonly tierId: string;
      readonly idempotencyKey: string;
    },
  ): Promise<RequestDecisionResult> {
    const requestId = this.idOf(input.requestId);
    const denial = {
      action: 'reseller_request.approve',
      entityType: 'ResellerRequest',
      entityId: requestId,
    };
    // Deny by default: a non-permitted actor is refused (and audited) before anything else.
    await this.authorize(scope, actor, denial);
    const adminId = this.adminIdOf(actor);
    const tier = uuidV7Schema.safeParse(input.tierId);
    if (!tier.success) throw this.tierInvalid();
    const tierId = tier.data;
    const requestHash = hashRequest({ op: 'approve', requestId, tierId });
    const replayed = await this.deps.idempotency.find<{ requestId: string }>(
      scope,
      actor.surface,
      input.idempotencyKey,
      requestHash,
    );
    if (replayed !== null) {
      const found = await this.deps.requests.findById(scope, replayed.result.requestId);
      if (found !== null) return { request: found, changed: false };
    }
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      RESELLER_REQUEST_EDIT_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        // The lock is what makes a concurrent pair approve once: the second waits here for
        // the first to commit, then reads APPROVED below.
        const request = await this.lockedRequestOf(scope, requestId, tx);
        if (request === null) throw this.notFound();
        if (request.status === 'REJECTED') throw this.closed();
        let changed = false;
        let current = request;
        if (request.status === 'PENDING') {
          if ((await this.deps.resellers.findTier(scope, tierId, tx)) === null) {
            throw this.tierInvalid();
          }
          if ((await this.deps.resellers.findByCustomer(scope, request.customerId, tx)) !== null) {
            throw errors.conflict(
              RESELLER_REQUEST_ERROR_CODES.ALREADY_RESELLER,
              'This customer already is a reseller; the request stays open.',
            );
          }
          await this.deps.registrar.registerWithin(
            scope,
            actor,
            {
              customerId: request.customerId,
              write: {
                tierId,
                pricingMode: 'TIER',
                discountPercentage: null,
                creditLimit: null,
              },
            },
            tx,
          );
          const now = this.deps.clock.now();
          const moved = await this.deps.requests.decide(
            scope,
            request.id,
            { status: 'APPROVED', adminId, tierId, reason: null },
            now,
            tx,
          );
          /* istanbul ignore next -- the row lock is held and PENDING was just read. */
          if (!moved) throw this.closed();
          changed = true;
          current = (await this.deps.requests.findById(scope, request.id, tx)) ?? request;
          await this.deps.notifier.notifyThrough(
            scope,
            request.customerId as UserId,
            request.botInstanceId as BotInstanceId,
            'RESELLER_REQUEST_DECISION',
            request.id,
            now,
            tx,
          );
          await this.deps.outbox.write(tx, actor, {
            eventType: 'ResellerRequestDecided',
            aggregateType: 'ResellerRequest',
            aggregateId: request.id,
            payload: {
              requestId: request.id,
              customerId: request.customerId,
              status: 'APPROVED',
              tierId,
            },
          });
          await this.deps.audit.record(
            scope,
            actor,
            {
              action: 'reseller_request.approve',
              entityType: 'ResellerRequest',
              entityId: request.id,
              before: { status: 'PENDING' },
              after: { status: 'APPROVED', tierId },
              result: 'SUCCESS',
            },
            tx,
          );
        }
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          input.idempotencyKey,
          requestHash,
          { requestId: request.id },
          tx,
        );
        return { request: current, changed };
      },
    );
  }

  // =========================================================================================
  // The notification lane's reader
  // =========================================================================================

  /**
   * What `RESELLER_REQUEST_MESSAGE` and `RESELLER_REQUEST_DECISION` render, read at send time
   * from the row the notification names (a reader, not a payload: ADR 0030 §1).
   */
  async notificationFacts(
    scope: TenantContext,
    kind: Extract<
      CustomerNotificationKind,
      'RESELLER_REQUEST_MESSAGE' | 'RESELLER_REQUEST_DECISION'
    >,
    subjectId: string,
  ): Promise<NotificationFacts | null> {
    if (kind === 'RESELLER_REQUEST_MESSAGE') {
      const message = await this.deps.requests.findMessageById(scope, subjectId);
      if (message === null || message.body === null || message.senderType !== 'ADMIN') return null;
      const request = await this.deps.requests.findById(scope, message.requestId);
      if (request === null) return null;
      return {
        values: { number: Number(request.number), text: message.body },
        replyRequestId: request.status === 'PENDING' ? request.id : null,
      };
    }
    const request = await this.deps.requests.findById(scope, subjectId);
    if (request === null || request.status === 'PENDING') return null;
    if (request.status === 'APPROVED') {
      const tier =
        request.tierId === null ? null : await this.deps.resellers.findTier(scope, request.tierId);
      if (tier === null) return null;
      return {
        values: { tier: tier.name },
        templateKey: 'bot.reseller_request.approved',
        replyRequestId: null,
      };
    }
    return {
      values: request.reason === null ? {} : { reason: request.reason },
      templateKey: 'bot.reseller_request.rejected',
      replyRequestId: null,
    };
  }

  // =========================================================================================
  // Internals
  // =========================================================================================

  /**
   * Why this customer cannot start (or file) a request now, or null when they can. Read in
   * the caller's transaction, under the customer's lock.
   */
  private async entryBlock(
    scope: TenantContext,
    customerId: string,
    tx: TransactionScope,
  ): Promise<EntryOutcome | null> {
    if (!(await this.deps.features.isEnabled(scope, 'reseller_requests', tx))) {
      return { kind: 'UNAVAILABLE' };
    }
    const customer = await this.deps.customers.findById(scope, customerId as UserId, tx);
    if (customer === null || customer.status === 'BLOCKED') return { kind: 'UNAVAILABLE' };
    // An ACTIVE or a SUSPENDED reseller is a reseller: the standing is theirs to have back.
    if ((await this.deps.resellers.findByCustomer(scope, customerId, tx)) !== null) {
      return { kind: 'ALREADY_RESELLER' };
    }
    const open = await this.deps.requests.findPendingByCustomer(scope, customerId, tx);
    if (open !== null) {
      const messages = await this.deps.requests.listMessages(scope, open.id, tx);
      return {
        kind: 'OPEN',
        request: open,
        conversing: messages.some((one) => one.senderType === 'ADMIN'),
      };
    }
    const days = await this.deps.settings.valueOf<number>(
      scope,
      RESELLER_REQUEST_COOLDOWN_SETTING_KEY as SettingKey,
      tx,
    );
    if (days > 0) {
      const last = await this.deps.requests.findLastRejected(scope, customerId, tx);
      if (last?.decidedAt != null) {
        const until = last.decidedAt.getTime() + days * DAY_MS;
        const now = this.deps.clock.now().getTime();
        if (now < until) {
          return {
            kind: 'COOLDOWN',
            daysLeft: Math.max(1, Math.ceil((until - now) / DAY_MS)),
            reason: last.reason,
          };
        }
      }
    }
    return null;
  }

  private async hasAdminMessage(scope: TenantContext, requestId: string): Promise<boolean> {
    return (await this.deps.requests.listMessages(scope, requestId)).some(
      (one) => one.senderType === 'ADMIN',
    );
  }

  private lockedRequestOf(
    scope: TenantContext,
    rawId: string,
    tx: TransactionScope,
  ): Promise<RequestRecord | null> {
    const id = uuidV7Schema.safeParse(rawId);
    return id.success
      ? this.deps.requests.findByIdForUpdate(scope, id.data, tx)
      : Promise.resolve(null);
  }

  private async assertRoom(
    scope: TenantContext,
    requestId: string,
    tx: TransactionScope,
  ): Promise<void> {
    if (
      (await this.deps.requests.countMessages(scope, requestId, tx)) >=
      RESELLER_REQUEST_MESSAGES_MAX
    ) {
      throw errors.conflict(
        RESELLER_REQUEST_ERROR_CODES.MESSAGE_LIMIT,
        'This conversation already holds as many messages as it may.',
      );
    }
  }

  private assertSameRequest(written: MessageRecord, requestHash: string): void {
    if (written.requestHash !== requestHash) {
      throw errors.conflict(
        RESELLER_REQUEST_ERROR_CODES.MESSAGE_INVALID,
        'This idempotency key was used for a different message.',
      );
    }
  }

  private adminIdOf(actor: ActorContext): string {
    if (actor.id === null) {
      throw errors.permissionDenied(
        PLATFORM_ERROR_CODES.PERMISSION_DENIED,
        'Only an administrator acts on a reseller request.',
      );
    }
    return actor.id;
  }

  private idOf(raw: string): string {
    const id = uuidV7Schema.safeParse(raw);
    if (!id.success) throw this.notFound();
    return id.data;
  }

  private notFound() {
    return errors.notFound(RESELLER_REQUEST_ERROR_CODES.NOT_FOUND, 'Unknown reseller request.');
  }

  private closed() {
    return errors.conflict(
      RESELLER_REQUEST_ERROR_CODES.CLOSED,
      'This request has been decided; its conversation is closed.',
    );
  }

  private tierInvalid() {
    return errors.validation(
      RESELLER_REQUEST_ERROR_CODES.TIER_INVALID,
      'The chosen tier is not a reseller tier of this installation.',
    );
  }

  private messageInvalid() {
    return errors.validation(
      RESELLER_REQUEST_ERROR_CODES.MESSAGE_INVALID,
      `A message is 1 to ${String(RESELLER_REQUEST_MESSAGE_MAX)} characters.`,
    );
  }

  private questionsInvalid() {
    return errors.validation(
      RESELLER_REQUEST_ERROR_CODES.QUESTIONS_INVALID,
      'The question list is not valid.',
    );
  }

  /** An early check that leaves the same audit trace as one inside the transaction. */
  private async authorize(
    scope: TenantContext,
    actor: ActorContext,
    denial: { action: string; entityType: string; entityId: string | null },
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, RESELLER_REQUEST_EDIT_PERMISSION);
    } catch (error) {
      await recordMutationDenial(
        this.mutationDeps(),
        scope,
        actor,
        RESELLER_REQUEST_EDIT_PERMISSION,
        denial,
        error,
      );
      throw error;
    }
  }

  private async assertScopeActive(scope: TenantContext, tx: TransactionScope): Promise<void> {
    if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'This installation has stopped accepting work.',
      );
    }
  }

  private mutationDeps() {
    return {
      uow: this.deps.uow,
      guard: this.deps.guard,
      audit: this.deps.audit,
      opsLog: this.deps.opsLog,
      sessions: this.deps.sessions,
      clock: this.deps.clock,
    };
  }
}

// -- Pure helpers ---------------------------------------------------------------------------

function fields(one: { text: string; required: boolean; maxLength: number }) {
  return { text: one.text.trim(), required: one.required, maxLength: one.maxLength };
}

function asked(one: QuestionRecord): AskedQuestion {
  return { questionId: one.id, text: one.text, required: one.required, maxLength: one.maxLength };
}

/** A message's text: trimmed, 1 to the bound; null when it is not one. */
export function normalizeMessage(raw: string | null): string | null {
  if (raw === null) return null;
  const text = raw.trim();
  if (text === '' || Array.from(text).length > RESELLER_REQUEST_MESSAGE_MAX) return null;
  return text;
}

function normalizeReason(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const text = raw.trim();
  if (text === '' || Array.from(text).length > RESELLER_REQUEST_REASON_MAX) return null;
  return text;
}

function draftView(draft: DraftRecord, screen: 'INTRO' | 'QUESTION' | 'SUMMARY'): DraftView {
  if (screen === 'INTRO') return { screen: 'INTRO', draftId: draft.id };
  const total = draft.questions.length;
  const question = draft.questions[draft.position];
  if (screen === 'QUESTION' && question !== undefined) {
    return {
      screen: 'QUESTION',
      draftId: draft.id,
      index: draft.position,
      count: total,
      question,
      current: draft.answers[draft.position] ?? null,
    };
  }
  return {
    screen: 'SUMMARY',
    draftId: draft.id,
    answers: draft.questions.map((one, index) => ({
      text: one.text,
      answer: draft.answers[index] ?? null,
    })),
  };
}
