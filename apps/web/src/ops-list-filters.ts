import { t } from './i18n/web.fa';

/**
 * Small helpers the support, infra and system lists share when they describe an active
 * filter as a chip («از تاریخ: ۲۴ مهر ۱۴۰۵»). Display only: the URL keeps exactly the value
 * the page wrote before.
 */

const DAY = new Intl.DateTimeFormat('fa-IR-u-nu-latn', { dateStyle: 'medium' });

/** A `YYYY-MM-DD` as a Jalali day; anything else is returned unchanged, never blank. */
export function dayLabel(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) return day;
  const at = new Date(`${day}T00:00:00`);
  return Number.isNaN(at.getTime()) ? day : DAY.format(at);
}

/** A from/to pair as one chip value, or `null` when neither end is set. */
export function dayRangeLabel(from: string, to: string): string | null {
  if (from === '' && to === '') return null;
  if (to === '') return `${t('web.ops_filter_from')} ${dayLabel(from)}`;
  if (from === '') return `${t('web.ops_filter_until')} ${dayLabel(to)}`;
  return `${dayLabel(from)} – ${dayLabel(to)}`;
}
