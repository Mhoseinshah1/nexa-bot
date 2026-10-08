import type { SupportAiTopic } from '@nexa/contracts';
import { t } from '../i18n/web.fa';
import { ASSIST_TOPIC_LABELS } from './support-assist';

/**
 * Roadmap A5 — a handoff's safe operator context, beside the AI's note: the topic and intent of
 * the AI's latest decision in the conversation, and how many automatic replies the customer had
 * this session (the steps tried). Each line is drawn only when there is something to say; the
 * server sends all three as null to an actor who may not see the conversation.
 */
export function HandoffContextView({
  topic,
  intent,
  stepsTried,
}: {
  readonly topic?: string | null | undefined;
  readonly intent?: string | null | undefined;
  readonly stepsTried?: number | null | undefined;
}) {
  const topicLabel =
    topic != null && topic in ASSIST_TOPIC_LABELS
      ? t(ASSIST_TOPIC_LABELS[topic as SupportAiTopic])
      : null;
  if (topicLabel === null && intent == null && stepsTried == null) return null;
  return (
    <ul className="muted small">
      {topicLabel !== null && (
        <li>
          {t('web.bchat_handoff_context_topic')} {topicLabel}
        </li>
      )}
      {intent != null && (
        <li>
          {t('web.bchat_handoff_context_intent')} {intent}
        </li>
      )}
      {stepsTried != null && (
        <li>
          {t('web.bchat_handoff_context_steps')} {stepsTried.toLocaleString('fa-IR')}
        </li>
      )}
    </ul>
  );
}
