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
