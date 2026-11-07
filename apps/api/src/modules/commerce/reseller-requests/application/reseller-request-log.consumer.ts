import {
  EVENT_PAYLOAD_SCHEMAS,
  toPersianDigits,
  type CorrelationId,
  type DomainEvent,
  type EventType,
  type NotificationDestination,
  type NotificationKind,
  type OpsLogButton,
  type OpsLogTypeId,
  type TemplateKey,
  type TemplateValue,
  type TemplateValues,
  type TenantContext,
} from '@nexa/contracts';
import type { EventConsumer } from '../../../platform/eventing/application/event-consumer.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import { firstTwoLines, identityOf, oneLine } from '../../ops-log/application/presenters.js';
import type { OpsLogFacts, OpsLogWords } from '../../ops-log/application/ports.js';
import type { ResellerRequestRepository } from './ports.js';

/** The operator notification lane, as this consumer needs it. `NotificationService` is it. */
export interface ResellerRequestNotificationLane {
  queue(
    scope: TenantContext,
    input: {
      readonly kind: NotificationKind;
      readonly dedupeKey: string;
      readonly templateKey: TemplateKey;
      readonly values: TemplateValues;
      readonly correlationId?: string;
      readonly destination?: NotificationDestination;
      readonly logType?: OpsLogTypeId;
      readonly buttons?: readonly OpsLogButton[];
    },
    tx?: unknown,
  ): Promise<unknown>;
}

/** One answer is cut here, and the whole block at `QA_MAX`, so the message stays under Telegram's bound. */
const ANSWER_MAX = 300;
const QA_MAX = 2800;

/**
 * A reseller request filed, an applicant's reply, and the decision → the operations log group
 * (log type «درخواست نمایندگی»).
 *
 * A CONSUMER of the three events, so it runs in the relay's transaction after the fact
 * committed and never inside it. Database work only: it writes an intent into the existing
 * operator notification lane, whose dispatcher sends it. The new request and every reply carry
 * the three action buttons (approve, reject, message the applicant) and the page link; the
 * decision carries the links only — nothing is left to act on.
 *
 * An operator's OWN message is not logged: the group does not need to be told what one of its
 * members just wrote, and the thread in the Web Admin is the record.
 */
export class ResellerRequestLogConsumer implements EventConsumer {
  /** Stable: it is the key in `processed_messages`. */
  readonly name = 'reseller-requests.ops-log';
  readonly subscribesTo: readonly EventType[] = [
    'ResellerRequestSubmitted',
    'ResellerRequestMessagePosted',
    'ResellerRequestDecided',
  ];

  constructor(
    private readonly deps: {
      readonly lane: ResellerRequestNotificationLane;
      readonly requests: ResellerRequestRepository;
      readonly tierName: (
        scope: TenantContext,
        tierId: string,
        tx: TransactionScope,
      ) => Promise<string | null>;
      readonly facts: OpsLogFacts;
      readonly words: OpsLogWords;
    },
  ) {}

  async handle(event: DomainEvent, tx: TransactionScope): Promise<void> {
    if (event.tenantId === null) return;
    const scope: TenantContext = { tenantId: event.tenantId as never, botInstanceId: null };
    const { words } = this.deps;

    let requestId: string;
    let kind: 'NEW' | 'REPLY' | 'DECIDED';
    let messageId: string | null = null;
    if (event.eventType === 'ResellerRequestSubmitted') {
      requestId = EVENT_PAYLOAD_SCHEMAS.ResellerRequestSubmitted.parse(event.payload).requestId;
      kind = 'NEW';
    } else if (event.eventType === 'ResellerRequestMessagePosted') {
      const payload = EVENT_PAYLOAD_SCHEMAS.ResellerRequestMessagePosted.parse(event.payload);
      if (payload.senderType !== 'CUSTOMER') return;
      requestId = payload.requestId;
      messageId = payload.messageId;
      kind = 'REPLY';
    } else {
      requestId = EVENT_PAYLOAD_SCHEMAS.ResellerRequestDecided.parse(event.payload).requestId;
      kind = 'DECIDED';
    }

    const request = await this.deps.requests.findById(scope, requestId, tx);
    if (request === null) return;
    const customer = await this.deps.facts.customer(scope, request.customerId, tx);
    if (customer === null) return;
    const who = identityOf(customer, words);
    const number = toPersianDigits(request.number.toString());
    const values: Record<string, TemplateValue> = {
      requestNumber: number,
      ...who,
    };
    const actions: readonly OpsLogButton[] = [
      { kind: 'RESELLER_REQUEST_APPROVE', ref: request.id },
      { kind: 'RESELLER_REQUEST_REJECT', ref: request.id },
      { kind: 'RESELLER_REQUEST_MESSAGE', ref: request.id },
    ];
    const links: readonly OpsLogButton[] = [
      { kind: 'RESELLER_REQUEST', ref: request.id },
      { kind: 'USER', ref: request.customerId },
    ];
    let templateKey: TemplateKey;
    let buttons: readonly OpsLogButton[];

    if (kind === 'NEW') {
      templateKey = 'ops.reseller_request.new' as TemplateKey;
      values['at'] = request.createdAt;
      const facts = await this.deps.requests.customerFacts(scope, request.customerId, tx);
      if (facts !== null) {
        values['servicesCount'] = facts.servicesCount;
        if (facts.totalPaid !== null) values['totalPaid'] = facts.totalPaid;
      }
      const lines: string[] = [];
      for (const [index, one] of request.answers.entries()) {
        const answer = oneLine(one.answer, ANSWER_MAX) ?? words.none;
        lines.push(
          `${toPersianDigits(String(index + 1))}. ${oneLine(one.text, ANSWER_MAX) ?? ''}\n↪️ ${answer}`,
        );
      }
      const qa = lines.join('\n\n');
      if (qa !== '') values['qa'] = qa.length > QA_MAX ? `${qa.slice(0, QA_MAX - 1)}…` : qa;
      buttons = [...actions, ...links];
    } else if (kind === 'REPLY') {
      templateKey = 'ops.reseller_request.reply' as TemplateKey;
      const message =
        messageId === null ? null : await this.deps.requests.findMessageById(scope, messageId, tx);
      values['at'] = message?.createdAt ?? new Date(event.occurredAt);
      // A photo has no words: the line is dropped rather than printed empty.
      const snippet = firstTwoLines(message?.body ?? null);
      if (snippet !== null) values['snippet'] = snippet;
      buttons = [...actions, ...links];
    } else {
      templateKey = 'ops.reseller_request.decided' as TemplateKey;
      if (request.status === 'PENDING') return;
      values['outcome'] = words.resellerRequestOutcome(request.status);
      values['at'] = request.decidedAt ?? new Date(event.occurredAt);
      if (request.tierId !== null) {
        const name = await this.deps.tierName(scope, request.tierId, tx);
        if (name !== null) values['tierName'] = name;
      }
      if (request.decidedByAdminId !== null) {
        const names = await this.deps.requests.adminNames(scope, [request.decidedByAdminId], tx);
        const name = names.get(request.decidedByAdminId);
        if (name !== undefined) values['adminName'] = name;
      }
      if (request.reason !== null) values['reason'] = request.reason;
      buttons = links;
    }

    await this.deps.lane.queue(
      scope,
      {
        kind: 'OPERATIONAL_EVENT',
        dedupeKey: `reseller-request:${event.eventId}`,
        templateKey,
        values,
        correlationId: event.correlationId as CorrelationId,
        logType: 'RESELLER_REQUEST',
        buttons,
      },
      tx,
    );
  }
}
