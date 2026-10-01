// The contracts package's own zod, the version the frozen copy below was written against.
import { z } from '../../packages/contracts/node_modules/zod';
import {
  MAIN_MENU_BUTTON_IDS,
  MAIN_MENU_TARGETS,
  MENU_APPEARANCE_SLOTS,
  mainMenuButton,
  mainMenuButtonIsGated,
  mainMenuTargetOf,
  resolveMainMenuLayout,
} from '@nexa/contracts';

/*
 * THE PREVIOUS RELEASE'S PARSER, copied verbatim from `bot-commands.ts` at `25e717a` (the
 * base of round T). It is what a binary rolled back to before round T runs over the
 * `bot.main_menu` projection a publish writes. Kept here, not imported, so that widening
 * the live schema cannot quietly widen the "old" one with it: the live schema is compared
 * with this copy below, and the projection is parsed by this copy.
 */
export const frozenEntrySchema = z
  .object({
    button: z.enum(MAIN_MENU_BUTTON_IDS),
    enabled: z.boolean(),
    target: z.enum(MAIN_MENU_TARGETS).optional(),
    appearanceSlot: z.enum(MENU_APPEARANCE_SLOTS).nullable().optional(),
  })
  .strict()
  .refine(
    (entry) => entry.target === undefined || entry.target === mainMenuTargetOf(entry.button),
    {
      message: 'A button opens the action it is declared for, and no other.',
    },
  );
export const frozenLayoutSchema = z
  .array(frozenEntrySchema)
  .max(MAIN_MENU_BUTTON_IDS.length)
  .refine((entries) => new Set(entries.map((entry) => entry.button)).size === entries.length, {
    message: 'Each button may appear once.',
  })
  .refine(
    (entries) =>
      new Set(entries.map((entry) => entry.target ?? mainMenuTargetOf(entry.button))).size ===
      entries.length,
    { message: 'Each action may have one button.' },
  )
  .refine(
    (entries) =>
      resolveMainMenuLayout(entries).some(
        (entry) => entry.enabled && !mainMenuButtonIsGated(mainMenuButton(entry.button)),
      ),
    { message: 'At least one button that nothing else can hide must stay on.' },
  );
