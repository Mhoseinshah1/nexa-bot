/**
 * Web Admin catalogue — the redesign kit (page head extras, selection bar, quick-action bar,
 * attention strip, KPI row, settings rows, save bar, the 24-hour time picker, layout drag and drop).
 *
 * One slice of `WEB_FA`; `../web.fa.ts` merges every slice and is what pages import.
 */
export const WEB_FA_REDESIGN_KIT = {
  'web.kit_refresh': 'به‌روزرسانی',
  // The count chip when the server sent the planner's estimate, not a count (PR-10).
  'web.kit_count_estimated': 'حدود {n}',
  'web.kit_selected_count': '{n} مورد انتخاب شده',
  'web.kit_selection_clear': 'لغو انتخاب',
  'web.kit_selection_bar': 'عملیات روی موارد انتخاب‌شده',
  'web.kit_quick_actions': 'عملیات سریع',
  'web.kit_attention_title': 'نیازمند رسیدگی',
  'web.kit_settings_unsaved': '{n} تغییر ذخیره‌نشده',
  'web.kit_settings_save': 'ذخیره',
  'web.kit_settings_cancel': 'لغو',
  'web.kit_settings_saving': 'در حال ذخیره…',
  'web.kit_time_hour': 'ساعت',
  'web.kit_time_minute': 'دقیقه',
  'web.kit_daypart_dawn': 'بامداد',
  'web.kit_daypart_morning': 'صبح',
  'web.kit_daypart_afternoon': 'بعدازظهر',
  'web.kit_daypart_evening': 'عصر',
  'web.kit_daypart_night': 'شب',
  'web.kit_dnd_item_hint':
    'برای جابه‌جایی: Enter یا فاصله را بزنید، سپس با کلیدهای جهت‌دار حرکت دهید و با Enter رها کنید.',
  'web.kit_dnd_new_row': 'ردیف تازه',
  'web.kit_dnd_free': 'دکمه‌های آزاد',
  'web.kit_dnd_grabbed': '{name} برداشته شد. موقعیت {row}، {col}.',
  'web.kit_dnd_moved': '{name} به ردیف {row}، جایگاه {col} رفت.',
  'web.kit_dnd_freed': '{name} از چیدمان خارج شد.',
  'web.kit_dnd_cancelled': 'جابه‌جایی لغو شد.',
  'web.kit_dnd_row_label': 'ردیف {n}',
} as const;
