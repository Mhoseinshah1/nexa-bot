import type {
  Money,
  ResellerRequestAnswer,
  ResellerRequestAttachmentKind,
  ResellerRequestListFilter,
  ResellerRequestMessageSender,
  ResellerRequestStatus,
  TenantContext,
} from '@nexa/contracts';

/** One of the owner's questions, as the editor and the customer flow read it. */
export interface QuestionRecord {
  readonly id: string;
  readonly position: number;
  readonly text: string;
  readonly required: boolean;
  readonly maxLength: number;
}

/** A question as it was asked: what a draft and a request freeze. */
export interface AskedQuestion {
  readonly questionId: string;
  readonly text: string;
  readonly required: boolean;
  readonly maxLength: number;
}

export interface DraftRecord {
  readonly id: string;
  readonly customerId: string;
  readonly botInstanceId: string;
  readonly questions: readonly AskedQuestion[];
  /** One per question; `null` while unanswered or skipped. */
  readonly answers: readonly (string | null)[];
  readonly position: number;
  readonly updatedAt: Date;
}

export interface RequestRecord {
  readonly id: string;
  readonly number: bigint;
  readonly customerId: string;
  readonly botInstanceId: string;
  readonly answers: readonly ResellerRequestAnswer[];
  readonly status: ResellerRequestStatus;
  readonly decidedByAdminId: string | null;
  readonly tierId: string | null;
  readonly reason: string | null;
  readonly openingKey: string;
  readonly createdAt: Date;
  readonly decidedAt: Date | null;
  readonly lastMessageAt: Date | null;
}

export interface MessageAttachment {
  readonly kind: ResellerRequestAttachmentKind;
  readonly botInstanceId: string;
  readonly fileId: string;
  readonly fileUniqueId: string;
  readonly mimeType: string | null;
  readonly fileSize: bigint | null;
}

export interface MessageRecord {
  readonly id: string;
  readonly requestId: string;
  readonly senderType: ResellerRequestMessageSender;
  readonly authorAdminId: string | null;
  readonly body: string | null;
  readonly attachment: MessageAttachment | null;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly createdAt: Date;
}

/** A request with the customer facts the list and the group message print. */
export interface RequestListItem {
  readonly request: RequestRecord;
  readonly customerName: string | null;
  readonly customerUsername: string | null;
  /** A PENDING request in which an operator has written. */
  readonly conversing: boolean;
}

export interface RequestCounts {
  readonly pending: number;
  readonly conversing: number;
  readonly approved: number;
  readonly rejected: number;
}

export interface CustomerFacts {
  readonly displayName: string | null;
  readonly username: string | null;
  readonly telegramUserId: string;
  readonly servicesCount: number;
  readonly totalPaid: Money | null;
}

export interface ResellerRequestRepository {
  // -- questions
  /** Active questions, in order. */
  listQuestions(scope: TenantContext, tx?: unknown): Promise<readonly QuestionRecord[]>;
  lockTenant(scope: TenantContext, tx: unknown): Promise<void>;
  /** Makes the active list exactly `next`: updates, inserts, deactivates the rest. */
  replaceQuestions(
    scope: TenantContext,
    next: readonly (Omit<QuestionRecord, 'position'> & { readonly isNew: boolean })[],
    now: Date,
    tx: unknown,
  ): Promise<void>;

  // -- drafts
  findDraftByCustomer(
    scope: TenantContext,
    customerId: string,
    tx?: unknown,
  ): Promise<DraftRecord | null>;
  /** Replaces the customer's draft with a fresh one. */
  putDraft(
    scope: TenantContext,
    draft: {
      readonly id: string;
      readonly customerId: string;
      readonly botInstanceId: string;
      readonly questions: readonly AskedQuestion[];
    },
    now: Date,
    tx: unknown,
  ): Promise<DraftRecord>;
  saveDraft(
    scope: TenantContext,
    id: string,
    patch: { readonly answers: readonly (string | null)[]; readonly position: number },
    now: Date,
    tx: unknown,
  ): Promise<void>;
  deleteDraft(scope: TenantContext, id: string, tx: unknown): Promise<void>;

  // -- requests
  /** Serialises one customer's submits (`pg_advisory_xact_lock`). */
  lockCustomer(scope: TenantContext, customerId: string, tx: unknown): Promise<void>;
  insertRequest(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly customerId: string;
      readonly botInstanceId: string;
      readonly answers: readonly ResellerRequestAnswer[];
      readonly openingKey: string;
    },
    now: Date,
    tx: unknown,
  ): Promise<RequestRecord>;
  findById(scope: TenantContext, id: string, tx?: unknown): Promise<RequestRecord | null>;
  findByIdForUpdate(scope: TenantContext, id: string, tx: unknown): Promise<RequestRecord | null>;
  findByOpeningKey(scope: TenantContext, key: string, tx?: unknown): Promise<RequestRecord | null>;
  findPendingByCustomer(
    scope: TenantContext,
    customerId: string,
    tx?: unknown,
  ): Promise<RequestRecord | null>;
  /** The customer's most recent REJECTED request. */
  findLastRejected(
    scope: TenantContext,
    customerId: string,
    tx?: unknown,
  ): Promise<RequestRecord | null>;
  /** A conditional UPDATE from PENDING. False means it was no longer pending. */
  decide(
    scope: TenantContext,
    id: string,
    to: {
      readonly status: 'REJECTED' | 'APPROVED';
      readonly adminId: string;
      readonly tierId: string | null;
      readonly reason: string | null;
    },
    now: Date,
    tx: unknown,
  ): Promise<boolean>;
  list(
    scope: TenantContext,
    query: {
      readonly filter: ResellerRequestListFilter | null;
      readonly limit: number;
      readonly before: { readonly at: Date; readonly id: string } | null;
    },
  ): Promise<readonly RequestListItem[]>;
  counts(scope: TenantContext): Promise<RequestCounts>;
  customerFacts(
    scope: TenantContext,
    customerId: string,
    tx?: unknown,
  ): Promise<CustomerFacts | null>;

  /** Display names of administrators, for the thread and the decision line. */
  adminNames(
    scope: TenantContext,
    ids: readonly string[],
    tx?: unknown,
  ): Promise<ReadonlyMap<string, string>>;

  /** The customer row of a Telegram account, for an administrator's own text window. */
  customerIdOfTelegramUser(
    scope: TenantContext,
    telegramUserId: string,
    tx?: unknown,
  ): Promise<string | null>;

  // -- messages
  insertMessage(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly requestId: string;
      readonly senderType: ResellerRequestMessageSender;
      readonly authorAdminId: string | null;
      readonly body: string | null;
      readonly attachment: MessageAttachment | null;
      readonly idempotencyKey: string;
      readonly requestHash: string;
    },
    now: Date,
    tx: unknown,
  ): Promise<MessageRecord>;
  findMessageByKey(scope: TenantContext, key: string, tx?: unknown): Promise<MessageRecord | null>;
  findMessageById(scope: TenantContext, id: string, tx?: unknown): Promise<MessageRecord | null>;
  listMessages(
    scope: TenantContext,
    requestId: string,
    tx?: unknown,
  ): Promise<readonly MessageRecord[]>;
  countMessages(scope: TenantContext, requestId: string, tx: unknown): Promise<number>;
  /** Stamps `last_message_at` (and `updated_at`). */
  touch(scope: TenantContext, requestId: string, now: Date, tx: unknown): Promise<void>;
}
