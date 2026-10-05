import type { BusinessHandoffReason } from '@nexa/contracts';
import type { WebKey } from '../i18n/web.fa';

/** Why a Telegram Business conversation was handed to a person (TB2, TB7). */
export const HANDOFF_LABELS: Readonly<Record<BusinessHandoffReason, WebKey>> = {
  SEND_OUTCOME_UNKNOWN: 'web.bchat_handoff_send_unknown',
  TRANSPORT_REFUSED: 'web.bchat_handoff_transport_refused',
  AI_REQUESTED: 'web.bchat_handoff_ai_requested',
  HANDOFF_TOPIC: 'web.bchat_handoff_topic',
  HUMAN_REQUESTED: 'web.bchat_handoff_human_requested',
  TOPIC_NOT_ALLOWED: 'web.bchat_handoff_topic_not_allowed',
  LOW_CONFIDENCE: 'web.bchat_handoff_low_confidence',
  REPLY_OUT_OF_BOUNDS: 'web.bchat_handoff_reply_bounds',
  DECISION_NOT_REPLY: 'web.bchat_handoff_not_reply',
  AI_OUTPUT_INVALID: 'web.bchat_handoff_output_invalid',
  AI_UNAVAILABLE: 'web.bchat_handoff_ai_unavailable',
  ACCOUNT_UNDER_REVIEW: 'web.bchat_handoff_account_review',
  IDENTITY_UNVERIFIED: 'web.bchat_handoff_identity',
  CUSTOMER_BLOCKED: 'web.bchat_handoff_customer_blocked',
  INSUFFICIENT_GROUNDING: 'web.bchat_handoff_grounding',
  LOOP_GUARD: 'web.bchat_handoff_loop_guard',
  UNSUPPORTED_CONTENT: 'web.bchat_handoff_unsupported',
};
