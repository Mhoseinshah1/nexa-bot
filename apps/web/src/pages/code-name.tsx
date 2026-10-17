import { t, type WebKey } from '../i18n/web.fa';
import { codeNameKey } from '../payment-labels';
import { Ltr } from '../ui/kit';

/**
 * A machine key drawn by its Persian name (W5), with the raw key in the `title` for whoever
 * needs to find it in a log. A key the map does not know is drawn as itself, left-to-right —
 * never blank — and a missing value is a dash.
 */
export function CodeName({
  value,
  labels,
}: {
  value: string | null;
  labels: Readonly<Record<string, WebKey>>;
}) {
  if (value === null) return <Ltr>—</Ltr>;
  const key = codeNameKey(labels, value);
  return key === null ? <Ltr>{value}</Ltr> : <span title={value}>{t(key)}</span>;
}

/**
 * A legacy review code (W5): its Persian name, with the raw code in the `title` and again in
 * small muted left-to-right text beside it, for whoever matches it against the importer's
 * report. No name → the raw code alone, never blank.
 */
export function NamedCode({ name, raw }: { name: string | null; raw: string }) {
  if (name === null) return <Ltr>{raw}</Ltr>;
  return (
    <span title={raw}>
      {name}{' '}
      <span className="muted small" dir="ltr">
        {raw}
      </span>
    </span>
  );
}

/** `NamedCode` over a lookup map. */
export function LegacyCode({
  value,
  labels,
}: {
  value: string;
  labels: Readonly<Record<string, WebKey>>;
}) {
  const key = codeNameKey(labels, value);
  return <NamedCode name={key === null ? null : t(key)} raw={value} />;
}
