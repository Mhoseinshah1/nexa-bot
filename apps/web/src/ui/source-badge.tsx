import type { RecordSource } from '@nexa/contracts';
import { t } from '../i18n/web.fa';
import { Badge } from './kit';

/**
 * The «imported from Mirza» mark on a row the one-time Mirza import wrote (owner decision 2026-10-17).
 *
 * ONE component for all eight lists, drawn beside the row's main cell. A native row draws
 * nothing — the badge marks the exception, so a list of mostly native rows is not noise.
 * Provenance only: it changes no behaviour, and the import's own reference is never shown.
 */
export function SourceBadge({ source }: { source: RecordSource }) {
  if (source !== 'MIRZA') return null;
  return (
    <>
      {' '}
      <Badge tone="info" outline>
        {t('web.source_badge_mirza')}
      </Badge>
    </>
  );
}
