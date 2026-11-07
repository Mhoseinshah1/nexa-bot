import {
  RESELLER_REQUEST_CALLBACKS,
  RESELLER_REQUEST_ERROR_CODES,
  RESELLER_REQUEST_MESSAGE_MAX,
  isNexaError,
  type ActorContext,
  type BotInstanceId,
  type ResellerRequestStepAction,
  type TenantContext,
} from '@nexa/contracts';
import type { CustomerRecord } from '../../../modules/commerce/customers/application/ports.js';
import type { CustomerCaptureRecord } from '../../../modules/commerce/customers/application/customer-capture-ports.js';
import type { InboundReceiptFile } from '../../../modules/commerce/payments/application/receipt-ports.js';
import type {
  DraftOutcome,
  DraftView,
  EntryOutcome,
} from '../../../modules/commerce/reseller-requests/application/reseller-request.service.js';
import { inlineLabel } from '../../../modules/commerce/messaging/application/inline-buttons.js';
import type { CustomerButton } from '../../../modules/commerce/messaging/application/ports.js';
import type { BotRuntime } from '../bot-runtime.js';
import { updateIdOf } from './intent-of.js';
import type { BotCommand } from './intents.js';
import type { PendingReply } from './replies.js';
import { refusal } from './refusals.js';

/**
 * «👨‍💻 درخواست نمایندگی», the customer's side (PR-2): the intro, the owner's questions one
 * at a time, the summary, and the conversation after it. Every screen is the SAME message,
 * edited in place (the `RESELLER_REQUEST` wizard); a typed answer is read by the customer's
 * text window and edits the question that asked for it.
 *
 * The rules live in `ResellerRequestService`; this file draws screens and maps its outcomes.
 */

type Input = {
  readonly idempotencyKey: string;
  readonly botInstanceId: BotInstanceId;
  readonly update?: unknown;
};

const unavailable = (): PendingReply => ({
  key: 'bot.reseller_request.unavailable',
  values: {},
  buttons: [],
  orderId: null,
});

/** A refusal sentence that must not replace the screen the customer can still act on. */
const asNewMessage = (reply: PendingReply): PendingReply => ({
  ...reply,
  wizard: { kind: 'RESELLER_REQUEST', step: 'NOTICE', placement: 'NEW' },
});

const stepData = (action: ResellerRequestStepAction, draftId: string): string =>
  `${RESELLER_REQUEST_CALLBACKS.step}${action}:${draftId}`;

/** The main-menu button: what the customer meets, or a fresh application at its intro. */
export async function menuEntry(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  input: Input,
): Promise<PendingReply> {
  const service = rt.deps.resellerRequests;
  if (service === undefined) return unavailable();
  try {
    const outcome = await service.enter(scope, actor, {
      customerId: customer.id,
      botInstanceId: input.botInstanceId,
      idempotencyKey: input.idempotencyKey,
    });
    return entryReply(outcome);
  } catch (error) {
    return refusal(error);
  }
}

function entryReply(outcome: EntryOutcome): PendingReply {
  switch (outcome.kind) {
    case 'UNAVAILABLE':
      return unavailable();
    case 'ALREADY_RESELLER':
      return {
        key: 'bot.reseller_request.already_reseller',
        values: {},
        buttons: [],
        orderId: null,
      };
    case 'OPEN':
      return {
        key: outcome.conversing
          ? 'bot.reseller_request.status_conversing'
          : 'bot.reseller_request.status_pending',
        values: { number: Number(outcome.request.number) },
        buttons: [
          {
            ...inlineLabel('reseller_request.reply'),
            data: `${RESELLER_REQUEST_CALLBACKS.reply}${outcome.request.id}`,
          },
        ],
        orderId: null,
      };
    case 'COOLDOWN':
      return {
        key: 'bot.reseller_request.cooldown',
        values: {
          days: outcome.daysLeft,
          ...(outcome.reason === null ? {} : { reason: outcome.reason }),
        },
        buttons: [],
        orderId: null,
      };
    case 'START':
      return viewReply(outcome.view);
  }
}

/** One screen of the application, as the wizard message shows it. */
export function viewReply(view: DraftView): PendingReply {
  switch (view.screen) {
    case 'INTRO':
      return {
        key: 'bot.reseller_request.intro',
        values: {},
        buttons: [{ ...inlineLabel('reseller_request.start'), data: stepData('g', view.draftId) }],
        orderId: null,
        wizard: { kind: 'RESELLER_REQUEST', step: 'RR_INTRO', subjectId: view.draftId },
      };
    case 'QUESTION': {
      const buttons: CustomerButton[] = [];
      if (!view.question.required) {
        buttons.push({
          ...inlineLabel('reseller_request.skip'),
          data: stepData('s', view.draftId),
          row: 0,
        });
      }
      buttons.push({
        ...inlineLabel('reseller_request.back'),
        data: stepData('b', view.draftId),
        row: buttons.length === 0 ? 0 : 1,
      });
      return {
        key: view.question.required
          ? 'bot.reseller_request.question'
          : 'bot.reseller_request.question_optional',
        values: {
          index: view.index + 1,
          total: view.count,
          question: view.question.text,
          ...(view.current === null ? {} : { current: view.current }),
        },
        buttons,
        orderId: null,
        wizard: {
          kind: 'RESELLER_REQUEST',
          step: 'RR_QUESTION',
          subjectId: view.draftId,
          // A typed answer edits THIS message, whichever question it shows.
          anchor: { steps: ['RR_QUESTION'], subjectId: view.draftId },
        },
      };
    }
    case 'SUMMARY':
      return {
        key: 'bot.reseller_request.summary',
        values: {
          answers: view.answers
            .map((one, index) => `${String(index + 1)}. ${one.text}\n↪️ ${one.answer ?? '—'}`)
            .join('\n\n'),
        },
        buttons: [
          { ...inlineLabel('reseller_request.send'), data: stepData('x', view.draftId), row: 0 },
          { ...inlineLabel('reseller_request.edit'), data: stepData('e', view.draftId), row: 0 },
          { ...inlineLabel('reseller_request.back'), data: stepData('b', view.draftId), row: 1 },
        ],
        orderId: null,
        wizard: { kind: 'RESELLER_REQUEST', step: 'RR_SUMMARY', subjectId: view.draftId },
      };
  }
}

/** Opens the text window that reads the answer to the question now on screen. */
async function openAnswerWindow(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  draftId: string,
  input: Input,
  suffix: string,
): Promise<void> {
  const updateId = updateIdOf(input.update);
  await rt.deps.captures.open(scope, actor, {
    idempotencyKey: `${input.idempotencyKey}:rr-window:${suffix}`,
    botInstanceId: input.botInstanceId,
    customerId: customer.id,
    purpose: 'RESELLER_REQUEST_ANSWER',
    subjectId: draftId,
    ...(updateId === undefined ? {} : { openedUpdateId: updateId }),
  });
}

/** A tap on the application's buttons: start, skip, back, send or edit. */
export async function stepTurn(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  command: BotCommand,
  customer: CustomerRecord,
  input: Input,
): Promise<PendingReply> {
  const service = rt.deps.resellerRequests;
  const draftId = command.targetId;
  const action = command.secondaryId as ResellerRequestStepAction | null | undefined;
  if (service === undefined || draftId === null || action === null || action === undefined) {
    return unavailable();
  }
  try {
    if (action === 'x') {
      const result = await service.submit(scope, actor, {
        customerId: customer.id,
        draftId,
        idempotencyKey: input.idempotencyKey,
      });
      if (result.kind === 'GONE') return unavailable();
      if (result.kind === 'REFUSED') {
        return {
          ...entryReply(result.entry),
          wizard: { kind: 'RESELLER_REQUEST', step: 'CLOSED' },
        };
      }
      return {
        key: 'bot.reseller_request.submitted',
        values: { number: Number(result.request.number) },
        buttons: [],
        orderId: null,
        wizard: { kind: 'RESELLER_REQUEST', step: 'CLOSED' },
      };
    }
    const outcome = await service.step(scope, actor, {
      customerId: customer.id,
      draftId,
      action: { g: 'START', s: 'SKIP', b: 'BACK', e: 'EDIT' }[action] as
        'START' | 'SKIP' | 'BACK' | 'EDIT',
    });
    return viewOf(rt, scope, actor, customer, draftId, outcome, input, 'tap');
  } catch (error) {
    return refusal(error);
  }
}

async function viewOf(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  draftId: string,
  outcome: DraftOutcome,
  input: Input,
  suffix: string,
): Promise<PendingReply> {
  if (outcome.kind === 'GONE') return asNewMessage(unavailable());
  if (outcome.kind === 'INVALID') {
    // Same question, same window: the answer must be sent again.
    await openAnswerWindow(rt, scope, actor, customer, draftId, input, `${suffix}:again`);
    return asNewMessage({
      key: 'bot.reseller_request.answer_invalid',
      values: { max: outcome.maxLength },
      buttons: [],
      orderId: null,
    });
  }
  if (outcome.view.screen === 'QUESTION') {
    await openAnswerWindow(rt, scope, actor, customer, draftId, input, suffix);
  }
  return viewReply(outcome.view);
}

/** The text window of a question read an answer. */
export async function answerText(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  capture: CustomerCaptureRecord,
  text: string,
  input: Input,
): Promise<PendingReply | null> {
  const service = rt.deps.resellerRequests;
  if (service === undefined || capture.subjectId === null) return null;
  try {
    const outcome = await service.step(scope, actor, {
      customerId: customer.id,
      draftId: capture.subjectId,
      action: 'ANSWER',
      text,
    });
    return viewOf(rt, scope, actor, customer, capture.subjectId, outcome, input, 'typed');
  } catch (error) {
    return refusal(error);
  }
}

// -- The conversation -----------------------------------------------------------------------

/** The reply button under an operator's message: opens the window that reads the reply. */
export async function replyOpen(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  requestId: string,
  input: Input,
): Promise<PendingReply> {
  const service = rt.deps.resellerRequests;
  if (service === undefined) return unavailable();
  try {
    const open = await service.openRequestOf(scope, customer.id);
    if (open === null || open.request.id !== requestId) {
      return { key: 'bot.reseller_request.thread_closed', values: {}, buttons: [], orderId: null };
    }
    const updateId = updateIdOf(input.update);
    await rt.deps.captures.open(scope, actor, {
      idempotencyKey: `${input.idempotencyKey}:rr-reply-window`,
      botInstanceId: input.botInstanceId,
      customerId: customer.id,
      purpose: 'RESELLER_REQUEST_REPLY',
      subjectId: requestId,
      ...(updateId === undefined ? {} : { openedUpdateId: updateId }),
    });
    return {
      key: 'bot.reseller_request.reply_prompt',
      values: { number: Number(open.request.number) },
      buttons: [],
      orderId: null,
    };
  } catch (error) {
    return refusal(error);
  }
}

/** The reply window read a message, or a photo with its caption. */
export async function replySubmit(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  capture: CustomerCaptureRecord,
  text: string | null,
  file: InboundReceiptFile | null,
  input: Input,
): Promise<PendingReply | null> {
  const service = rt.deps.resellerRequests;
  if (service === undefined || capture.subjectId === null) return null;
  const requestId = capture.subjectId;
  const again = async (): Promise<PendingReply> => {
    const updateId = updateIdOf(input.update);
    await rt.deps.captures.open(scope, actor, {
      idempotencyKey: `${input.idempotencyKey}:rr-reply-again`,
      botInstanceId: input.botInstanceId,
      customerId: customer.id,
      purpose: 'RESELLER_REQUEST_REPLY',
      subjectId: requestId,
      ...(updateId === undefined ? {} : { openedUpdateId: updateId }),
    });
    return {
      key: 'bot.reseller_request.answer_invalid',
      values: { max: RESELLER_REQUEST_MESSAGE_MAX },
      buttons: [],
      orderId: null,
    };
  };
  if (file !== null && file.kind !== 'PHOTO') return again();
  try {
    await service.customerReply(scope, actor, {
      customerId: customer.id,
      requestId,
      text: text !== null && text.trim() !== '' ? text : null,
      attachment:
        file === null
          ? null
          : {
              kind: 'PHOTO',
              botInstanceId: input.botInstanceId,
              fileId: file.fileId,
              fileUniqueId: file.fileUniqueId,
              mimeType: file.mimeType,
              fileSize: file.fileSize,
            },
      idempotencyKey: input.idempotencyKey,
    });
    return { key: 'bot.reseller_request.reply_sent', values: {}, buttons: [], orderId: null };
  } catch (error) {
    if (isNexaError(error)) {
      if (error.code === RESELLER_REQUEST_ERROR_CODES.CLOSED) {
        return {
          key: 'bot.reseller_request.thread_closed',
          values: {},
          buttons: [],
          orderId: null,
        };
      }
      if (error.code === RESELLER_REQUEST_ERROR_CODES.MESSAGE_INVALID) return again();
      if (error.code === RESELLER_REQUEST_ERROR_CODES.NOT_FOUND) return unavailable();
    }
    return refusal(error);
  }
}

/** A photo answers the reply window when that is the prompt the customer saw last. */
export async function replyFile(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  file: InboundReceiptFile,
  input: Input,
): Promise<PendingReply | null> {
  if (rt.deps.resellerRequests === undefined) return null;
  const updateId = updateIdOf(input.update);
  const desk = rt.deps.tickets;
  const read = await rt.deps.captures.readText(scope, actor, {
    idempotencyKey: `${input.idempotencyKey}:rr-capture-file`,
    botInstanceId: input.botInstanceId,
    customerId: customer.id,
    text: file.caption ?? '',
    onlyPurposes: ['RESELLER_REQUEST_REPLY'],
    // A receipt window opened after the reply window is the newer prompt: it keeps the file.
    ...(desk === undefined
      ? {}
      : {
          yieldTo: (tx) => desk.receiptWindowOpenedAt(scope, input.botInstanceId, customer.id, tx),
        }),
    ...(updateId === undefined ? {} : { updateId }),
  });
  if (read.outcome !== 'READ') return null;
  return replySubmit(rt, scope, actor, customer, read.capture, file.caption, file, input);
}
