import type { ReactNode } from 'react';
import {
  errorIssues,
  errorReference,
  errorText,
  type ErrorOverrides,
  type ErrorIssue,
} from '../error-text';
import { t, type WebKey } from '../i18n/web.fa';
import { errorCodeLabel } from '../ops-code-labels';
import { Banner, Disclosure } from './kit';

/**
 * «جزئیات فنی»: what a provider, a log or a validator actually wrote.
 *
 * Raw provider text (`lastErrorMessage`, a Telegram description, Zod's English) is never the
 * sentence an operator reads; it is kept here, closed by default, left-to-right and
 * monospace, for whoever has to debug it. Renders nothing when there is nothing to show.
 */
export function TechnicalDetails({
  lines,
  children,
}: {
  lines?: readonly (string | null | undefined)[];
  children?: ReactNode;
}) {
  const shown = (lines ?? []).filter(
    (line): line is string => typeof line === 'string' && line.trim() !== '',
  );
  if (shown.length === 0 && (children === undefined || children === null)) return null;
  return (
    <Disclosure size="sm" summary={t('web.err_technical')} className="err-technical">
      {shown.length > 0 && (
        <ul className="err-technical-lines">
          {shown.map((line, index) => (
            <li key={`${index}:${line}`} dir="ltr" className="ltr mono">
              {line}
            </li>
          ))}
        </ul>
      )}
      {children}
    </Disclosure>
  );
}

/**
 * The error's code and correlation id: small, muted, left-to-right, UNDER the Persian
 * sentence — never instead of it. Support finds the log entry by the correlation id.
 */
export function ErrorRef({ error }: { error: unknown }) {
  const reference = errorReference(error);
  if (reference === null) return null;
  return (
    <p className="err-ref muted small">
      <span>{t('web.err_ref_code')}</span>{' '}
      <bdi dir="ltr" className="ltr mono">
        {reference.code}
      </bdi>
      {reference.correlationId !== null && (
        <>
          {' · '}
          <span>{t('web.err_ref_correlation')}</span>{' '}
          <bdi dir="ltr" className="ltr mono">
            {reference.correlationId}
          </bdi>
        </>
      )}
    </p>
  );
}

function IssueLine({ issue }: { issue: ErrorIssue }) {
  return (
    <>
      {issue.text}
      {issue.token !== undefined && (
        <>
          {': '}
          <bdi dir="ltr" className="ltr mono">{`{${issue.token}}`}</bdi>
        </>
      )}
    </>
  );
}

/**
 * A refusal, in Persian: the sentence, one Persian line per refused field, the code and
 * correlation id, and the server's own words behind «جزئیات فنی».
 */
export function ApiErrorReport({
  error,
  overrides,
  fieldLabels,
}: {
  error: unknown;
  overrides?: ErrorOverrides;
  fieldLabels?: Readonly<Record<string, WebKey>>;
}) {
  const issues = errorIssues(error, fieldLabels);
  return (
    <>
      <Banner tone="danger">
        {errorText(error, overrides === undefined ? {} : { overrides })}
        <ErrorRef error={error} />
      </Banner>
      {issues.length > 0 && (
        <ul className="danger">
          {issues.map((issue, index) => (
            // The index is part of the key: two issues can carry the same sentence.
            <li key={`${index}:${issue.text}:${issue.token ?? ''}`}>
              <IssueLine issue={issue} />
            </li>
          ))}
        </ul>
      )}
      <TechnicalDetails lines={issues.map((issue) => issue.raw)} />
    </>
  );
}

/**
 * A machine code under its Persian name (W5): the name is the text, the code follows small,
 * muted and left-to-right, and is the `title` too. An unknown code (no name) is shown as the
 * code itself — never a blank.
 */
export function CodeLabel({ label, code }: { label: string | null; code: string }) {
  if (label === null || label === code) {
    return (
      <bdi dir="ltr" className="ltr mono">
        {code}
      </bdi>
    );
  }
  return (
    <span className="code-label" title={code}>
      <span>{label}</span>{' '}
      <bdi dir="ltr" className="ltr mono muted small">
        {code}
      </bdi>
    </span>
  );
}

/**
 * A provider's or log's own words (`failureMessage`, `lastError`, `lastErrorMessage`, an
 * operational event's message): a Persian summary, and the raw text only under «جزئیات فنی».
 */
export function ProviderText({ summary, text }: { summary: WebKey; text: string }) {
  return (
    <span className="provider-text">
      <span>{t(summary)}</span>
      <TechnicalDetails lines={[text]} />
    </span>
  );
}

/** An error, provider or ops code by its Persian name, the code beside it (`CodeLabel`). */
export function ErrorCodeLabel({ code }: { code: string }) {
  return <CodeLabel label={errorCodeLabel(code)} code={code} />;
}
