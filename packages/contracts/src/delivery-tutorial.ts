import { z } from 'zod';
import { appearanceMarkersIn, isAppearanceSlot, APPEARANCE_SLOTS } from './appearance.js';
import { clientAppTextProblem } from './client-apps.js';

/**
 * Phase 2 item 5: the OPTIONAL tutorial a panel sends a customer automatically, once, right
 * after their service on that panel was delivered — a paid one, a trial, or both.
 *
 * It is configured per PANEL because what it says is a property of the panel's connection
 * («اتصال سرویس فقط از طریق Sing-box امکان‌پذیر است»). It lives in its own table
 * (`delivery_tutorials`), never in `panels.policy`: that schema is strict, and a rollback
 * that could not parse a policy carrying it would refuse every customer action on the panel.
 *
 * It EXTENDS the existing tutorial machinery rather than standing beside it:
 *  - the text is the client-app guide's plain-text subset, checked by the same
 *    `clientAppTextProblem` and drawn by the same `renderClientAppGuide`;
 *  - the video is an existing client app's tutorial video (`client_app_videos`), the
 *    bot-scoped `file_id` an administrator already set through the bot — so no second video
 *    capture flow exists;
 *  - video + text is A4a's whole-or-nothing caption, through the messenger's `captionWhole`.
 *
 * A premium emoji is written as the allowlisted appearance marker `{icon:slot}` and nothing
 * else; raw markup (`<tg-emoji …>`) is refused at save, like any HTML.
 */

/** What a panel sends after delivery. `DISABLED` — and no row at all — sends nothing. */
export const DELIVERY_TUTORIAL_MODES = ['DISABLED', 'TEXT', 'VIDEO', 'VIDEO_TEXT'] as const;
export type DeliveryTutorialMode = (typeof DELIVERY_TUTORIAL_MODES)[number];

/** Whether a mode sends the text, and whether it sends the video. */
export function deliveryTutorialSendsText(mode: DeliveryTutorialMode): boolean {
  return mode === 'TEXT' || mode === 'VIDEO_TEXT';
}
export function deliveryTutorialSendsVideo(mode: DeliveryTutorialMode): boolean {
  return mode === 'VIDEO' || mode === 'VIDEO_TEXT';
}

/** The guide's own ceiling: one Telegram message holds it with room for the template. */
export const DELIVERY_TUTORIAL_TEXT_MAX_LENGTH = 2500;

/** Why a tutorial text is refused, or null. One function for the form and the server. */
export type DeliveryTutorialTextProblem =
  'CONTROL' | 'MARKUP' | 'EXECUTABLE_SCHEME' | 'UNSAFE_LINK' | 'UNKNOWN_ICON' | 'TOO_LONG';

export function deliveryTutorialTextProblem(value: string): DeliveryTutorialTextProblem | null {
  if (value.length > DELIVERY_TUTORIAL_TEXT_MAX_LENGTH) return 'TOO_LONG';
  const problem = clientAppTextProblem(value);
  if (problem !== null) return problem;
  /*
   * An icon marker names a declared appearance slot or the text is refused — the rule
   * `validateTemplateBody` applies to a template body, because the renderer leaves an
   * unknown marker LITERAL and the customer would read `{icon:paymnt}`.
   */
  for (const slot of appearanceMarkersIn(value)) {
    if (!isAppearanceSlot(slot)) return 'UNKNOWN_ICON';
  }
  return null;
}

const TEXT_PROBLEM_MESSAGES: Readonly<Record<DeliveryTutorialTextProblem, string>> = {
  CONTROL: 'must not contain control characters',
  MARKUP: 'must not contain HTML; a premium emoji is written {icon:slot}',
  EXECUTABLE_SCHEME: 'must not contain javascript:, data:, vbscript: or file: links',
  UNSAFE_LINK: 'every link, bare or [label](link), must be an https:// link to a named host',
  UNKNOWN_ICON: `every {icon:…} must name one of ${APPEARANCE_SLOTS.join(', ')}`,
  TOO_LONG: `at most ${String(DELIVERY_TUTORIAL_TEXT_MAX_LENGTH)} characters`,
};

/** One panel's tutorial, as the operator reads it. */
export const deliveryTutorialSchema = z.object({
  panelId: z.string(),
  mode: z.enum(DELIVERY_TUTORIAL_MODES),
  /** Kept while the mode does not send it, so switching modes loses nothing. */
  text: z.string().nullable(),
  /** The client app whose tutorial video (on the delivering bot) is sent. */
  videoClientAppId: z.string().nullable(),
  appliesToPurchase: z.boolean(),
  appliesToTrial: z.boolean(),
  /** What a write must name. Zero when nothing is stored yet. */
  revision: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime().nullable(),
});
export type DeliveryTutorialBody = z.infer<typeof deliveryTutorialSchema>;

/**
 * A client app the video may come from: the apps with a tutorial video on at least one bot,
 * plus the one the tutorial names. `botsWithVideo` is how many of the tenant's bots hold it —
 * the video is sent only by a bot that holds it (a `file_id` is bot-scoped).
 */
export const deliveryTutorialVideoOptionSchema = z.object({
  clientAppId: z.string(),
  name: z.string(),
  platform: z.string(),
  enabled: z.boolean(),
  botsWithVideo: z.number().int().nonnegative(),
});
export type DeliveryTutorialVideoOption = z.infer<typeof deliveryTutorialVideoOptionSchema>;

export const deliveryTutorialResponseSchema = z.object({
  tutorial: deliveryTutorialSchema,
  videoOptions: z.array(deliveryTutorialVideoOptionSchema),
});
export type DeliveryTutorialResponse = z.infer<typeof deliveryTutorialResponseSchema>;

/**
 * Replacing one panel's tutorial. Whole, never a patch, carrying the revision the form was
 * drawn from — the panel trial's rule. A mode that sends text needs the text; a mode that
 * sends a video needs the app. Fields the mode does not use are KEPT as sent, so an operator
 * who switches to DISABLED for a while gets their text back.
 */
export const updateDeliveryTutorialRequestSchema = z
  .object({
    idempotencyKey: z.string().min(8).max(255),
    expectedRevision: z.number().int().nonnegative(),
    mode: z.enum(DELIVERY_TUTORIAL_MODES),
    text: z
      .string()
      .nullable()
      .transform((value) => {
        const trimmed = value?.trim() ?? '';
        return trimmed === '' ? null : trimmed;
      })
      .superRefine((value, ctx) => {
        if (value === null) return;
        const problem = deliveryTutorialTextProblem(value);
        if (problem !== null) {
          ctx.addIssue({ code: 'custom', message: TEXT_PROBLEM_MESSAGES[problem] });
        }
      }),
    videoClientAppId: z.uuid().nullable(),
    appliesToPurchase: z.boolean(),
    appliesToTrial: z.boolean(),
  })
  .superRefine((body, ctx) => {
    if (deliveryTutorialSendsText(body.mode) && body.text === null) {
      ctx.addIssue({ code: 'custom', message: 'This mode sends the text.', path: ['text'] });
    }
    if (deliveryTutorialSendsVideo(body.mode) && body.videoClientAppId === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'This mode sends a video.',
        path: ['videoClientAppId'],
      });
    }
    if (body.mode !== 'DISABLED' && !body.appliesToPurchase && !body.appliesToTrial) {
      ctx.addIssue({
        code: 'custom',
        message: 'An enabled tutorial applies to purchases, trials or both.',
        path: ['appliesToPurchase'],
      });
    }
  });
export type UpdateDeliveryTutorialRequest = z.input<typeof updateDeliveryTutorialRequestSchema>;

export const updateDeliveryTutorialResponseSchema = z.object({
  tutorial: deliveryTutorialSchema,
  videoOptions: z.array(deliveryTutorialVideoOptionSchema),
  /** False for a save that stored what was already stored, or a replay. */
  changed: z.boolean(),
});
export type UpdateDeliveryTutorialResponse = z.infer<typeof updateDeliveryTutorialResponseSchema>;

export const DELIVERY_TUTORIAL_ROUTES = {
  tutorial: (panelId: string) => `/panels/${encodeURIComponent(panelId)}/delivery-tutorial`,
} as const;
