import { z } from 'zod';

/**
 * R8-C3: the arrangement of the buttons on a customer's service screen, edited on the Web
 * Admin's «دکمه‌های ربات» page and nowhere else.
 *
 * The value ORDERS and GROUPS; it never decides whether a button exists. Whether a button is
 * offered (the panel's capability, the service's state, the customer's standing) is decided
 * at render time by the same checks as before, and a button the layout names that those
 * checks refuse is simply not drawn. «بازگشت» is not a slot: it is always drawn, always last.
 *
 * A slot is the inline-button registry key of its button. «خاموش کردن» and «روشن کردن» are
 * one slot (`service.suspend`) because a service is only ever offered one of them, and so are
 * the two switches of automatic renewal (`service.auto_renew_enable`, Round 10 D1).
 */
export const SERVICE_CARD_BUTTONS = [
  'service.refresh',
  'service.files',
  'service.link',
  'service.rotate',
  'service.note',
  'service.add_traffic',
  'service.add_time',
  'service.renew',
  'service.add_devices',
  'service.change_location',
  'service.suspend',
  'service.refund_request',
  'service.transfer',
  // Round 10, D1: «تمدید خودکار», its switch on or off (one slot, named by its ON button).
  'service.auto_renew_enable',
] as const;
export type ServiceCardButton = (typeof SERVICE_CARD_BUTTONS)[number];

/** The most buttons a row may hold, and the fewest. */
export const SERVICE_CARD_ROW_MIN = 1;
export const SERVICE_CARD_ROW_MAX = 3;

export const serviceCardEntrySchema = z
  .object({
    button: z.enum(SERVICE_CARD_BUTTONS),
    /** False hides the button whatever its eligibility. True never shows an ineligible one. */
    enabled: z.boolean(),
  })
  .strict();
export type ServiceCardEntry = z.infer<typeof serviceCardEntrySchema>;

export const serviceCardLayoutSchema = z
  .object({
    /** Top to bottom; each row left to right in reading order. Empty means "as always". */
    rows: z
      .array(z.array(serviceCardEntrySchema).min(SERVICE_CARD_ROW_MIN).max(SERVICE_CARD_ROW_MAX))
      .max(SERVICE_CARD_BUTTONS.length),
  })
  .strict()
  .refine(
    (layout) => {
      const named = layout.rows.flat().map((entry) => entry.button);
      return new Set(named).size === named.length;
    },
    { message: 'Each button may appear once.' },
  );
export type ServiceCardLayout = z.infer<typeof serviceCardLayoutSchema>;

/**
 * The rows the screen has when nothing is saved, by slot: exactly the grouping and order the
 * bot draws today. A test holds this to the runtime, so a layout equal to it changes nothing.
 */
export const DEFAULT_SERVICE_CARD_ROWS: readonly (readonly ServiceCardButton[])[] = [
  ['service.refresh', 'service.files'],
  ['service.link', 'service.rotate'],
  ['service.note', 'service.add_traffic', 'service.add_time'],
  ['service.renew', 'service.suspend'],
  ['service.add_devices'],
  ['service.change_location'],
  ['service.refund_request', 'service.transfer'],
  ['service.auto_renew_enable'],
];

/** The slot a drawn button belongs to, or null for «بازگشت» and anything unlisted. */
export function serviceCardSlotOf(inlineKey: string): ServiceCardButton | null {
  const slot =
    inlineKey === 'service.resume'
      ? 'service.suspend'
      : inlineKey === 'service.auto_renew_disable'
        ? 'service.auto_renew_enable'
        : // R11 A4: «دریافت فایل‌های جدید» takes the place of «تغییر لینک» on a files-only panel.
          inlineKey === 'service.files_new'
          ? 'service.rotate'
          : inlineKey;
  return (SERVICE_CARD_BUTTONS as readonly string[]).includes(slot)
    ? (slot as ServiceCardButton)
    : null;
}
