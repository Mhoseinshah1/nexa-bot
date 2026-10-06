import type { ReactNode } from 'react';
import type {
  SupportAiFailureClass,
  SupportAiFailureDiagnostic,
  SupportAiProvider,
  SupportAiTestCheck,
  SupportAiTestCheckResult,
} from '@nexa/contracts';
import { formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { KV, Ltr, Num, Quantity, type Tone } from '../ui/kit';

/**
 * Why the support AI did not answer, as an operator reads it (program §12): a Persian label per
 * failure class, and the deciding call's safe particulars — provider, model, HTTP status, the
 * provider's own error identifiers, the decision field that failed. Never a prompt, a reply or
 * the provider's message: the server holds none of them.
 */

export const FAILURE_CLASS_LABELS: Readonly<Record<SupportAiFailureClass, WebKey>> = {
  request_rejected: 'web.sai_failure_request_rejected',
  unsupported_capability: 'web.sai_failure_unsupported_capability',
  auth: 'web.sai_failure_auth',
  quota: 'web.sai_failure_quota',
  rate_limited: 'web.sai_failure_rate_limited',
  timeout: 'web.sai_failure_timeout',
  network: 'web.sai_failure_network',
  provider_error: 'web.sai_failure_provider_error',
  refused: 'web.sai_failure_refused',
  no_content: 'web.sai_failure_no_content',
  truncated: 'web.sai_failure_truncated',
  not_json: 'web.sai_failure_not_json',
  schema_invalid: 'web.sai_failure_schema_invalid',
  reply_too_long: 'web.sai_failure_reply_too_long',
  no_provider: 'web.sai_failure_no_provider',
};

export const TEST_CHECK_LABELS: Readonly<Record<SupportAiTestCheck, WebKey>> = {
  MODEL_ACCESS: 'web.sai_test_check_model_access',
  STRUCTURED_GENERATION: 'web.sai_test_check_structured_generation',
  DECISION_SCHEMA: 'web.sai_test_check_decision_schema',
  VISION: 'web.sai_test_check_vision',
};

export const TEST_RESULT_LABELS: Readonly<Record<SupportAiTestCheckResult, WebKey>> = {
  PASS: 'web.sai_test_result_pass',
  FAIL: 'web.sai_test_result_fail',
  NOT_TESTED: 'web.sai_test_result_not_tested',
  UNSUPPORTED: 'web.sai_test_result_unsupported',
};

export const TEST_RESULT_TONES: Readonly<Record<SupportAiTestCheckResult, Tone>> = {
  PASS: 'ok',
  FAIL: 'danger',
  NOT_TESTED: 'neutral',
  UNSUPPORTED: 'warn',
};

const PROVIDER_NAMES: Readonly<Record<SupportAiProvider, WebKey>> = {
  OPENAI: 'web.sai_provider_openai',
  ANTHROPIC: 'web.sai_provider_anthropic',
  ZAI: 'web.sai_provider_zai',
};

/** The provider-side particulars every failure view shares; absent fields are not drawn. */
export function failureParticulars(detail: {
  readonly httpStatus: number | null;
  readonly providerErrorCode: string | null;
  readonly providerErrorType: string | null;
  readonly providerErrorParam: string | null;
  readonly issuePath: string | null;
  readonly issueCode: string | null;
}): [ReactNode, ReactNode][] {
  const items: [ReactNode, ReactNode][] = [];
  if (detail.httpStatus !== null)
    items.push([t('web.sai_diag_http_status'), <Ltr key="h">{String(detail.httpStatus)}</Ltr>]);
  if (detail.providerErrorCode !== null)
    items.push([t('web.sai_diag_provider_code'), <Ltr key="c">{detail.providerErrorCode}</Ltr>]);
  if (detail.providerErrorType !== null)
    items.push([t('web.sai_diag_provider_type'), <Ltr key="y">{detail.providerErrorType}</Ltr>]);
  if (detail.providerErrorParam !== null)
    items.push([t('web.sai_diag_provider_param'), <Ltr key="p">{detail.providerErrorParam}</Ltr>]);
  if (detail.issuePath !== null)
    items.push([
      t('web.sai_diag_issue'),
      <Ltr key="i">{`${detail.issuePath}${detail.issueCode === null ? '' : ` (${detail.issueCode})`}`}</Ltr>,
    ]);
  return items;
}

/** One failed job's diagnosis: the class as a sentence, then what is known about the call. */
export function FailureDiagnosticView({ failure }: { failure: SupportAiFailureDiagnostic }) {
  const items: [ReactNode, ReactNode][] = [];
  if (failure.provider !== null)
    items.push([t('web.sai_diag_provider'), t(PROVIDER_NAMES[failure.provider])]);
  if (failure.model !== null)
    items.push([t('web.sai_diag_model'), <Ltr key="m">{failure.model}</Ltr>]);
  if (failure.attemptIndex !== null)
    items.push([t('web.sai_diag_attempt'), <Num key="a" value={failure.attemptIndex + 1} />]);
  items.push(...failureParticulars(failure));
  if (failure.latencyMs !== null)
    items.push([t('web.sai_diag_latency'), <Num key="l" value={failure.latencyMs} />]);
  if (failure.inputTokens !== null || failure.outputTokens !== null)
    items.push([
      t('web.sai_diag_tokens'),
      <Quantity key="t">
        <Num value={failure.inputTokens ?? '—'} /> / <Num value={failure.outputTokens ?? '—'} />
      </Quantity>,
    ]);
  if (failure.at !== null) items.push([t('web.sai_diag_at'), formatTimestamp(failure.at)]);
  return (
    <div className="stack-sm" data-failure-class={failure.failureClass}>
      <p className="small">
        <strong>{t('web.sai_failure_reason')}:</strong>{' '}
        {t(FAILURE_CLASS_LABELS[failure.failureClass])}
      </p>
      {items.length > 0 && <KV inline items={items} />}
    </div>
  );
}
