import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  SUPPORT_TEST_QUESTION_MAX,
  type CustomerSummaryResponse,
  type SupportAiMode,
  type SupportTestConsoleResponse,
} from '@nexa/contracts';
import { newIdempotencyKey, runSupportTestConsole } from '../api/client';
import { t, type WebKey } from '../i18n/web.fa';
import { Badge, Banner, Button, Card, Field, KV, Num, type Tone } from '../ui/kit';
import { CustomerIdentity, CustomerPicker } from './customer-picker';
import { HANDOFF_LABELS } from './handoff-labels';
import { SAI_AUTO_TOPIC_LABELS, supportAiFault } from './support-ai';

/**
 * Phase 4 PR-5 — «امتحان یک سؤال». The owner types a question as a customer would, optionally
 * picks a real customer (whose facts the answer may use), and sees what the REAL stored
 * configuration would do: the answer, topic, confidence, the knowledge used, and — if a guard
 * would stop it — which one, in Persian. NOTHING is sent to anyone; the page says so.
 */

const VERDICT_LABELS: Readonly<Record<SupportTestConsoleResponse['verdict'], WebKey>> = {
  WOULD_SEND: 'web.saic_verdict_would_send',
  WOULD_SEND_LINK: 'web.saic_verdict_would_send_link',
  WOULD_CLOSE_SILENTLY: 'web.saic_verdict_would_close',
  WOULD_HAND_OFF: 'web.saic_verdict_would_hand_off',
  NOT_ASKED: 'web.saic_verdict_not_asked',
  NO_ANSWER: 'web.saic_verdict_no_answer',
};

const VERDICT_TONES: Readonly<Record<SupportTestConsoleResponse['verdict'], Tone>> = {
  WOULD_SEND: 'ok',
  WOULD_SEND_LINK: 'info',
  WOULD_CLOSE_SILENTLY: 'neutral',
  WOULD_HAND_OFF: 'warn',
  NOT_ASKED: 'warn',
  NO_ANSWER: 'danger',
};

/** The guard's own name, as a sentence about what it checks. */
const GUARD_LABELS: Readonly<Record<string, WebKey>> = {
  guard_customer_blocked: 'web.sa_auto_guard_customer_blocked',
  guard_handoff_topic: 'web.sa_auto_guard_handoff_topic',
  guard_human_requested: 'web.sa_auto_guard_human_requested',
  guard_topic_allowlist: 'web.sa_auto_guard_topic_allowlist',
  guard_account_review: 'web.sa_auto_guard_account_review',
  guard_confidence: 'web.sa_auto_guard_confidence',
  guard_reply_bounds: 'web.sa_auto_guard_reply_bounds',
  guard_grounding: 'web.sa_auto_guard_grounding',
  guard_decision: 'web.sa_auto_guard_decision',
  guard_output_policy: 'web.sa_auto_guard_output_policy',
  guard_content: 'web.sa_auto_guard_content',
  guard_clarifying_limit: 'web.sa_auto_guard_clarifying_limit',
  handoff_ai_requested: 'web.sa_auto_handoff_ai_requested',
};

export function guardSentence(outcome: string): string {
  const key = GUARD_LABELS[outcome];
  return key === undefined ? outcome : t(key);
}

export function TestConsoleCard({
  mode,
  maySearchCustomers,
}: {
  /** The STORED mode: the console tests what is saved, not what the form below holds. */
  mode: SupportAiMode;
  maySearchCustomers: boolean;
}) {
  const [question, setQuestion] = useState('');
  const [customer, setCustomer] = useState<CustomerSummaryResponse | null>(null);
  const run = useMutation({
    // A new key for every press: a run is a paid, answer-less command, not a retry of one.
    mutationFn: () =>
      runSupportTestConsole({
        idempotencyKey: newIdempotencyKey(),
        question: question.trim(),
        customerId: customer?.id ?? null,
      }),
  });
  const result = run.data;
  return (
    <Card title={t('web.saic_title')} hint={t('web.saic_hint')}>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (question.trim() !== '') run.mutate();
        }}
      >
        <Banner tone="info" slim>
          {t('web.saic_sends_nothing')}
        </Banner>
        {mode === 'OFF' && <Banner tone="warn">{t('web.saic_off')}</Banner>}
        <Field label={t('web.saic_question')} htmlFor="sai-console-question">
          <textarea
            id="sai-console-question"
            className="input"
            rows={3}
            maxLength={SUPPORT_TEST_QUESTION_MAX}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
          />
        </Field>
        {customer === null ? (
          <CustomerPicker
            inputId="sai-console-customer"
            maySearch={maySearchCustomers}
            onPick={setCustomer}
          />
        ) : (
          <Field label={t('web.saic_customer')}>
            <div className="customer-picker-chosen" role="group">
              <CustomerIdentity customer={customer} />
              <Button size="sm" variant="ghost" onClick={() => setCustomer(null)}>
                {t('web.customer_picker_change')}
              </Button>
            </div>
            <p className="muted small">{t('web.saic_customer_hint')}</p>
          </Field>
        )}
        {customer === null && <p className="muted small">{t('web.saic_unlinked_hint')}</p>}
        <div className="form-actions">
          <button
            type="submit"
            className="btn primary"
            disabled={mode === 'OFF' || question.trim() === '' || run.isPending}
          >
            {t(run.isPending ? 'web.saic_running' : 'web.saic_run')}
          </button>
        </div>
      </form>
      {run.error !== null && (
        <Banner tone="danger" role="alert">
          {supportAiFault(run.error)}
        </Banner>
      )}
      {result !== undefined && <ConsoleResult result={result} />}
    </Card>
  );
}

export function ConsoleResult({ result }: { result: SupportTestConsoleResponse }) {
  const items: [string, React.ReactNode][] = [];
  if (result.topic !== null) {
    items.push([
      t('web.saic_topic'),
      (SAI_AUTO_TOPIC_LABELS as Record<string, WebKey>)[result.topic] === undefined
        ? result.topic
        : t((SAI_AUTO_TOPIC_LABELS as Record<string, WebKey>)[result.topic]!),
    ]);
  }
  if (result.confidence !== null) {
    items.push([
      t('web.saic_confidence'),
      t(
        result.confidence === 'HIGH'
          ? 'web.assist_confidence_high'
          : result.confidence === 'MEDIUM'
            ? 'web.assist_confidence_medium'
            : 'web.assist_confidence_low',
      ),
    ]);
  }
  if (result.knowledgeSent !== null && result.knowledgeAvailable !== null) {
    items.push([
      t('web.saic_knowledge_sent'),
      <span key="k">
        <Num value={result.knowledgeSent} /> / <Num value={result.knowledgeAvailable} />
      </span>,
    ]);
  }
  items.push([
    t('web.saic_knowledge_used'),
    result.knowledgeUsed.length === 0
      ? t('web.saic_none')
      : result.knowledgeUsed.join(t('web.list_separator')),
  ]);
  if (result.factsUsed.length > 0) {
    items.push([t('web.saic_facts_used'), result.factsUsed.join(t('web.list_separator'))]);
  }
  return (
    <div className="stack sai-console-result" data-verdict={result.verdict}>
      <div className="row">
        <Badge tone={VERDICT_TONES[result.verdict]}>{t(VERDICT_LABELS[result.verdict])}</Badge>
        {result.mode === 'ASSIST_ONLY' && (
          <span className="muted small">{t('web.saic_assist_note')}</span>
        )}
      </div>
      {result.guard !== null && (
        <Banner tone="warn" title={t('web.saic_blocked_by')}>
          <p>{guardSentence(result.guard.outcome)}</p>
          <p className="small">
            {t('web.saic_handoff_reason')}: {t(HANDOFF_LABELS[result.guard.reason])}{' '}
            <Badge tone={result.guard.kind === 'HARD' ? 'danger' : 'info'}>
              {t(result.guard.kind === 'HARD' ? 'web.saic_kind_hard' : 'web.saic_kind_soft')}
            </Badge>
          </p>
        </Banner>
      )}
      {result.verdict === 'WOULD_SEND_LINK' && (
        <Banner tone="info">{t('web.saic_link_note')}</Banner>
      )}
      {result.verdict === 'NO_ANSWER' && <Banner tone="danger">{t('web.saic_no_answer')}</Banner>}
      {result.answer !== null && (
        <div className="field">
          <span className="field-label">
            {t(result.guard === null ? 'web.saic_answer' : 'web.saic_answer_held')}
          </span>
          <blockquote className="sai-console-answer">{result.answer}</blockquote>
        </div>
      )}
      {items.length > 0 && <KV items={items} />}
      {result.inputTokens !== null && (
        <p className="muted small">
          {t('web.saic_tokens')}: <Num value={result.inputTokens} /> /{' '}
          <Num value={result.outputTokens ?? 0} />
        </p>
      )}
    </div>
  );
}
