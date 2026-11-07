import { useQuery } from '@tanstack/react-query';
import { fetchAutoDeletePreview } from '../api/client';
import { formatNumber } from '../format';
import { t } from '../i18n/web.fa';

/** Under `['settings']`, so every saved setting (and the flag's toggle) refreshes it. */
export const AUTO_DELETE_PREVIEW_QUERY_KEY = ['settings', 'auto-delete-preview'] as const;

export function useAutoDeletePreview(enabled: boolean) {
  return useQuery({
    queryKey: AUTO_DELETE_PREVIEW_QUERY_KEY,
    queryFn: fetchAutoDeletePreview,
    enabled,
  });
}

/**
 * NEXA-OWNER-BATCH-1 PR-3: «با این تنظیمات، N سرویس در ۲۴ ساعت آینده حذف می‌شود», per cause.
 * Every figure is the server's count; while it is loading or could not be read the page says
 * so and shows no number (never a fabricated zero).
 */
export function AutoDeletePreview({ enabled }: { enabled: boolean }) {
  const preview = useAutoDeletePreview(enabled);
  if (!enabled) return null;
  if (preview.isPending) {
    return <p className="muted small">{t('web.auto_delete_preview_loading')}</p>;
  }
  if (preview.isError || preview.data === undefined) {
    return <p className="muted small">{t('web.auto_delete_preview_unavailable')}</p>;
  }
  const data = preview.data;
  return (
    <div className="auto-delete-preview" role="status">
      <p>
        {t('web.auto_delete_preview_lead')} <strong>{formatNumber(data.total)}</strong>{' '}
        {t('web.auto_delete_preview_tail')}
      </p>
      <ul className="muted small">
        <li>
          {t('web.auto_delete_preview_traffic')} {formatNumber(data.traffic)}
        </li>
        <li>
          {t('web.auto_delete_preview_time')} {formatNumber(data.time)}
        </li>
        <li>
          {t('web.auto_delete_preview_suspended')} {formatNumber(data.suspended)}
        </li>
      </ul>
      <p className="muted small">{t('web.auto_delete_preview_note')}</p>
    </div>
  );
}

/**
 * The same count as one sentence, for the switch-on confirmation (which draws its detail in a
 * paragraph): the question repeats N, per cause.
 */
export function AutoDeletePreviewSentence() {
  const preview = useAutoDeletePreview(true);
  if (preview.isPending) return <span>{t('web.auto_delete_preview_loading')}</span>;
  if (preview.isError || preview.data === undefined) {
    return <span>{t('web.auto_delete_preview_unavailable')}</span>;
  }
  const data = preview.data;
  return (
    <span>
      {t('web.auto_delete_preview_lead')} <strong>{formatNumber(data.total)}</strong>{' '}
      {t('web.auto_delete_preview_tail')} ({t('web.auto_delete_preview_traffic')}{' '}
      {formatNumber(data.traffic)} {t('web.auto_delete_preview_separator')}{' '}
      {t('web.auto_delete_preview_time')} {formatNumber(data.time)}{' '}
      {t('web.auto_delete_preview_separator')} {t('web.auto_delete_preview_suspended')}{' '}
      {formatNumber(data.suspended)})
    </span>
  );
}
