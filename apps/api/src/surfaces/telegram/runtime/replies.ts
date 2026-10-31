// The reply shapes a turn produces and the generic reply builders.
// Moved verbatim out of bot-runtime.ts, which still re-exports every name it exported.
import {
  ANTI_SPAM_BLOCK_REASON,
  type BotInstanceId,
  type CustomerArrival,
  type CustomerNotificationKind,
  type TemplateKey,
  type TemplateValues,
  type TenantContext,
} from '@nexa/contracts';
import type {
  CustomerButton,
  CustomerEditMessage,
  CustomerMessenger,
  CustomerSendOutcome,
  CustomerSendResult,
  MainMenuVariant,
} from '../../../modules/commerce/messaging/application/ports.js';
import type { CustomerRecord } from '../../../modules/commerce/customers/application/ports.js';
import { inlineLabel } from '../../../modules/commerce/messaging/application/inline-buttons.js';
import type { ReviewDirective, WizardDirective } from '../wizard-state.js';
import type { BotIntent } from './intents.js';
import { mainMenuButton } from './keyboards.js';

/**
 * What a handled update produced.
 *
 * Returned rather than logged, so the webhook controller decides what to do with it and
 * the tests can assert it. `sent` is deliberately not a boolean: a reply that may or may
 * not have arrived is a third thing, and the messenger already distinguishes it.
 */
export interface BotTurnResult {
  readonly intent: BotIntent;
  readonly arrival: CustomerArrival | null;
  readonly customerId: string | null;
  readonly replyKey: TemplateKey | null;
  /** The order this turn created or confirmed, when it was one of those. */
  readonly orderId: string | null;
  readonly sent: CustomerSendOutcome | 'NOT_ATTEMPTED';
}

/**
 * A reply that has been decided and not yet sent.
 *
 * Assembled BEFORE any network call, so the whole turn is: commit, decide, send. A
 * branch that sent from inside its own decision would be a second send path, and the
 * `resolve -> commit -> reply` order is the one rule this surface exists to keep.
 */
export interface PendingReply {
  readonly key: TemplateKey | null;
  readonly values: TemplateValues;
  readonly buttons: readonly CustomerButton[];
  readonly orderId: string | null;
  /**
   * R2 (item 5): the wizard screen this reply shows. A reply answering a wizard tap is
   * EDITED into the tapped message; one answering a typed step is edited into the wizard
   * message that asked for it; one sent as a new message becomes that message's wizard.
   */
  readonly wizard?: WizardDirective;
  /** R2 (item 3): what this reply does to the receipt-review messages of one payment. */
  readonly review?: ReviewDirective;
  /**
   * A SECOND message, sent after the first, about a different fact.
   *
   * One handler, two sentences, because they are two facts and merging them would make
   * one of them false. Settlement is the case it exists for: `bot.order.settled` says
   * the money arrived and is complete on its own, and `bot.service.provisioning` says
   * something is now being made — which is not true of a renewal, so it cannot simply
   * be appended to the settled copy.
   *
   * Sent only if the FIRST one was, and its outcome is not the turn's. A follow-up that
   * failed leaves the customer with the message that mattered; a follow-up that arrived
   * without its subject would be a sentence about nothing.
   *
   * It carries no values and no buttons on purpose. A second message that needed either
   * would be a second reply, and this is deliberately not a general mechanism — the
   * turn still has ONE answer, with a note after it.
   */
  readonly followUpKey?: TemplateKey;
  /**
   * The lane kind this reply falls back to when Telegram rate-limits it.
   *
   * `OQ-4H-01`: the durable write commits, the synchronous reply gets a 429, and
   * the customer sees nothing — so they send the transfer twice, or conclude the
   * cancellation did not happen. The background lanes already handle a 429 by
   * requeueing at Telegram's own `retryAfterMs` with no attempt spent; the
   * interactive path had nowhere to put it.
   *
   * Set on exactly the replies that are a FACT about an entity the customer just
   * changed — a recorded transfer, a cancelled order. Those carry `values: {}`
   * and `buttons: []`, which is what makes them expressible as a lane kind at
   * all.
   *
   * DELIBERATELY absent on every reply that RENDERS state. A menu, a catalogue
   * and a service list have no subject and no fact; queueing one would deliver a
   * stale screen minutes later against state that has moved, and would need the
   * parameterised payload `ADR 0030` §1 refuses. The customer's next tap
   * reproduces those, which is why they need no fallback.
   */
  readonly fallback?: {
    readonly kind: CustomerNotificationKind;
    readonly subjectId: string;
  };
  /**
   * Attach the persistent main-menu keyboard to this reply.
   *
   * ONE reply sets it — the answer to `/start` — because Telegram keeps a
   * `ReplyKeyboardMarkup` shown until something replaces or removes it, and nothing in
   * this product removes it. Re-sending it on every reply would be a second copy of a
   * keyboard the customer already has, and would fight with the inline keyboards the
   * contextual flows attach.
   */
  readonly keyboard?: MainMenuVariant;
  /**
   * Send this reply AS a file, with `key`/`values` as its caption and `buttons` on it.
   *
   * Payment File 02 §10: a reviewer's receipt item is ONE message — the image, the
   * context and the decisions together. The file is re-sent by `file_id` from the bot that
   * RECEIVED it (a `file_id` is scoped to that bot), so this carries its own bot instance.
   *
   * When Telegram REFUSES the file — a file gone from Telegram, or a reviewer who never
   * opened that bot — the same key, values and buttons go out as an ordinary text
   * message from the bot the reviewer is talking to, so the facts and the decisions still
   * arrive. Not on UNKNOWN or RATE_LIMITED: the file may have arrived, or the text would be
   * refused the same way.
   */
  readonly media?: ReplyMedia;
  /**
   * R10 D2: send this reply AS a file the installation holds as BYTES — an owner-defined
   * main-menu button's photo or document — uploaded as multipart (a Telegram `file_id` belongs
   * to one bot, and the bytes are the source of truth). `key`/`values` are its caption when
   * `captioned`, else the text it falls back to. When Telegram REFUSES the upload the same
   * `key`/`values` go out as text, so the customer is never left unanswered.
   */
  readonly mediaBytes?: ReplyMediaBytes;
  /**
   * Further files, sent bare after the reply: a payment's second and later receipts. Best
   * effort and not the turn's outcome, like `followUpKey`.
   */
  readonly attachments?: readonly ReplyMedia[];
  /**
   * Messages sent BEFORE the reply, in order, each without buttons: the referral
   * banner ahead of its text, the earlier pages of a long FAQ ahead of the last one
   * that carries the keyboard. A TEXT lead that does not deliver stops the turn there,
   * so the customer never sees a keyboard without the text it belongs to; a PHOTO lead
   * is decorative and its failure costs the customer nothing but the picture.
   */
  readonly lead?: readonly LeadMessage[];
  /**
   * R3: EDIT the message the tapped button is on into this reply, rather than sending a
   * new one — the service card redrawn after a refresh, the link-change question put in
   * the card's place and the card put back after it.
   *
   * Only a callback carries a message to edit; any other turn sends as usual. When
   * Telegram cannot edit it (deleted, too old, a photo with no text) the SAME reply is
   * sent once as a new message — the smallest fallback, and the only one.
   */
  readonly edit?: boolean;
  /**
   * R3: a short notice on the tapped button (`answerCallbackQuery` text), from a template.
   * Used with `key: null` where the answer must leave the card exactly as it is — a
   * refresh that could not read the panel, a switch that is not available.
   */
  readonly toast?: { readonly key: TemplateKey; readonly values: TemplateValues };
}

export type LeadMessage =
  | { readonly kind: 'TEXT'; readonly key: TemplateKey; readonly values: TemplateValues }
  | {
      readonly kind: 'PHOTO_BYTES';
      readonly bytes: Uint8Array;
      readonly mimeType: 'image/png' | 'image/jpeg';
      readonly fileName: string;
      /**
       * R1: the picture's CAPTION, when the photo is a message in its own right — the
       * referral invite, whose banner, introduction and link must be ONE message so that
       * forwarding it forwards all three. A captioned photo is not decorative: when
       * Telegram refuses it the caption goes out as text instead, and when that fails the
       * turn stops there, as a text lead's does.
       */
      readonly caption?: { readonly key: TemplateKey; readonly values: TemplateValues };
    };

/** A file this installation holds as bytes (R10 D2). */
export interface ReplyMediaBytes {
  readonly kind: 'PHOTO' | 'DOCUMENT';
  readonly bytes: Uint8Array;
  readonly mimeType: 'image/png' | 'image/jpeg' | 'application/pdf' | 'text/plain';
  readonly fileName: string;
  /** Whether `key`/`values` are the file's caption (true), or only the refusal's text fallback. */
  readonly captioned: boolean;
}

/** One file this installation already holds, and the bot that holds it. */
export interface ReplyMedia {
  readonly botInstanceId: BotInstanceId;
  /** `VIDEO`: a client app's tutorial (spec §7), by the `file_id` THIS bot received. */
  readonly kind: 'PHOTO' | 'DOCUMENT' | 'VIDEO';
  readonly fileId: string;
  /**
   * A4 (delta a): the caption goes WHOLE or not at all — the messenger's `captionWhole`, the
   * same measurement the referral invite's photo lead uses. Over Telegram's bound the file
   * goes out bare and the reply follows as its own text, so a tutorial guide is never cut:
   * two messages rather than one cut one. Absent keeps the cut a receipt's caption is sized
   * around.
   */
  readonly captionWhole?: true;
}

/**
 * What a blocked customer is told (File 01 §9, the owner's correction to WP10): the account is
 * blocked, WHY — the reason stored on THIS customer's own row, and nothing else of the block's
 * record — and to contact support. A block with no reason keeps `bot.blocked`, a whole sentence
 * with no empty "reason" line in it.
 *
 * Only a reason written to be shown is shown (pre-release hardening V2): until WP10's follow-up
 * the Web Admin told the operator this note "is never shown to the customer", and a block
 * written then keeps `blockedReasonShown` FALSE and is answered with `bot.blocked`. The
 * customers section's old fixed English note ("Blocked from the Telegram management panel.")
 * is the same case: migration 0121 marks those rows not shown, so the flag alone decides and
 * no typed reason is reserved (Codex review of PR #74).
 */
export function blockedReply(
  customer: Pick<CustomerRecord, 'blockedReason' | 'blockedReasonShown'>,
): PendingReply {
  const reason = customer.blockedReason?.trim() ?? '';
  // Anti-spam's own block is answered in the owner's own sentence (WP20, brief §3.5).
  if (reason === ANTI_SPAM_BLOCK_REASON) {
    return { key: 'bot.blocked_spam', values: {}, buttons: [], orderId: null };
  }
  if (!customer.blockedReasonShown || reason === '') {
    return { key: 'bot.blocked', values: {}, buttons: [], orderId: null };
  }
  return { key: 'bot.blocked_with_reason', values: { reason }, buttons: [], orderId: null };
}

/**
 * R4 A5: «📞 ارتباط با پشتیبانی» under the blocked reply — a URL button to the support account
 * or link from the support settings, never a callback: a blocked customer's taps are refused,
 * and a link still opens. Not drawn when no support link is configured.
 */
export function withBlockedSupportButton(
  reply: PendingReply,
  supportUrl: string | null,
): PendingReply {
  if (supportUrl === null) return reply;
  return { ...reply, buttons: [{ ...inlineLabel('blocked.support'), url: supportUrl }] };
}

/**
 * R2: one message this bot sent, edited in place through R3's `edit` port — its text — or,
 * for a file whose caption carries the text (a reviewer's receipt), `editCaption`. A
 * messenger without the method answers REFUSED `NOT_EDITABLE`, which every caller already
 * treats as "send it instead" (R3's one fallback).
 */
export async function editSent(
  messenger: CustomerMessenger,
  scope: TenantContext,
  message: CustomerEditMessage,
  caption: boolean,
): Promise<CustomerSendResult> {
  if (caption) {
    return messenger.editCaption === undefined
      ? { outcome: 'REFUSED', reason: 'NOT_EDITABLE' }
      : messenger.editCaption(scope, message);
  }
  return messenger.edit === undefined
    ? { outcome: 'REFUSED', reason: 'NOT_EDITABLE' }
    : messenger.edit(scope, message);
}

/**
 * Which template answers this turn.
 *
 * A pure function of the intent and the arrival, so the decision is testable without a
 * database or a Telegram server — and so the blocked case cannot be forgotten by one
 * branch. BLOCKED wins over everything: a blocked customer gets the block message
 * whatever they asked for, because every other answer is a service they are not
 * entitled to.
 *
 * `UNSUPPORTED` for an ACTIVE customer gets the existing `bot.unknown_command`, which
 * Phase 1 already declared — a new key for the same sentence would be a second string to
 * keep in step.
 */
export function replyFor(intent: BotIntent, arrival: CustomerArrival): TemplateKey | null {
  if (arrival === 'BLOCKED') return 'bot.blocked';
  if (intent === 'START') {
    return arrival === 'FIRST_SEEN' ? 'bot.start.welcome' : 'bot.start.welcome_back';
  }
  if (intent === 'HELP') return 'bot.help';
  return 'bot.unknown_command';
}

/**
 * Item 12 (C4): the answer to a button whose data this installation does not recognise —
 * one sentence and the main menu. Nothing from the data reaches it: no placeholder, no
 * echo, so an old MirzaBot payload or a crafted one cannot shape the reply.
 */
export function staleCallbackReply(): PendingReply {
  return { key: 'bot.callback.stale', values: {}, buttons: [mainMenuButton()], orderId: null };
}

/** R3: an answer that is only a notice on the tapped button; nothing is sent or edited. */
export function toastReply(key: TemplateKey): PendingReply {
  return { key: null, values: {}, buttons: [], orderId: null, toast: { key, values: {} } };
}

/**
 * R12 F3 item 4 (the owner's edit-in-place rule): a screen a tapped button opened replaces the
 * message it was tapped on, instead of adding another beneath it. Only a callback carries a
 * message to edit — `edit` is ignored for a typed turn — and a reply that sends something
 * besides its own text (a lead message, a file, a reply keyboard, a tracked wizard step) is
 * left exactly as it was: those have their own placement.
 */
export function inPlace(reply: PendingReply): PendingReply {
  if (
    reply.key === null ||
    reply.edit === true ||
    reply.lead !== undefined ||
    reply.media !== undefined ||
    reply.mediaBytes !== undefined ||
    reply.attachments !== undefined ||
    reply.keyboard !== undefined ||
    reply.wizard !== undefined
  ) {
    return reply;
  }
  return { ...reply, edit: true };
}

/** An ordinary one-line reply with no buttons. */
export function plainReply(key: TemplateKey): PendingReply {
  return { key, values: {}, buttons: [], orderId: null };
}
