/**
 * The ONE audience builder (W1.6), shared by bulk operations, broadcasts and campaigns: a live
 * count card («N مشتری · M قابل دسترس در ربات · K سرویس», debounced through the existing count
 * endpoint), «شروع سریع» presets, a list of the ACTIVE conditions only (coloured group dot,
 * label, Persian value summary, «تغییر» inline editor, ×; «وضعیت حساب» fixed), and «+ افزودن
 * شرط» with a grouped menu (چه کسانی · رفتار و وضعیت · زمان · کیف پول · سرویس‌ها).
 *
 * It edits the SAME `AudienceDraft` with the same props as the form it replaces
 * (`pages/audience-builder.tsx`); `wireAudience`, `draftOf` and `describeAudience` stay where
 * they are, so the request body is byte-for-byte the same for the same audience.
 *
 * PHASE-0 INTERFACE STUB — agent A implements it; agent D switches the three pages over.
 */
export interface AudienceConditionsProps<Draft> {
  value: Draft;
  onChange: (next: Draft) => void;
  disabled?: boolean;
}
