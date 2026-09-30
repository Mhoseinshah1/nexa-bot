import { z } from 'zod';
import { MAIN_MENU_BUTTON_IDS, MAIN_MENU_TARGETS } from './bot-commands.js';
import { MENU_APPEARANCE_SLOTS } from './menu-appearance.js';
import { BOT_INSTANCE_STATUSES } from './tenant.js';

/**
 * Round P (COMMAND-MENU) — the one authoritative menu configuration, read whole, and the
 * per-bot slash-command sync it drives (`docs/command-menu-audit.md`).
 *
 * The keyboard's arrangement stays the registry setting `bot.main_menu` and the labels stay
 * the `bot.menu.*` texts, both written through the endpoints that already exist; this file
 * adds the READ that puts the two beside what actually decides a button (its feature, a
 * panel's trial offer) and the sync state of every bot, and the two operator actions on
 * that state. It adds no second write path for the arrangement.
 */

/**
 * Where one bot's registered command menu stands against the menu this tenant wants.
 *
 *  - `CURRENT` — Telegram was last given exactly the desired list, and nothing is queued;
 *  - `PENDING` — a sync is queued and has not failed yet (a change was just made);
 *  - `FAILING` — the queued sync has failed at least once and is being retried with
 *    back-off; `lastErrorCode` says why;
 *  - `STALE` — the desired list differs from what was last given and no sync is queued
 *    yet: the lane's reconcile sweep queues one, or «همگام‌سازی دوباره» does now;
 *  - `UNKNOWN` — nothing records what Telegram was ever given (a row from before the
 *    column existed); one sync makes it knowable;
 *  - `STOPPED` — the bot is not ACTIVE, and a stopped bot's credential is not used
 *    (`OQ-5R-02`); it is synced when it is started.
 */
export const BOT_COMMAND_SYNC_STATES = [
  'CURRENT',
  'PENDING',
  'FAILING',
  'STALE',
  'UNKNOWN',
  'STOPPED',
] as const;
export type BotCommandSyncState = (typeof BOT_COMMAND_SYNC_STATES)[number];

/** What one sync attempt, run on request, answered. */
export const BOT_COMMAND_SYNC_OUTCOMES = ['SYNCED', 'FAILED', 'SKIPPED'] as const;
export type BotCommandSyncOutcome = (typeof BOT_COMMAND_SYNC_OUTCOMES)[number];

/**
 * What a live read of the registered menu (`getMyCommands`) answered. `SKIPPED` is a bot
 * that is not ACTIVE, whose credential is not used for reads either.
 */
export const BOT_COMMAND_CHECK_OUTCOMES = ['READ', 'REJECTED', 'UNREACHABLE', 'SKIPPED'] as const;
export type BotCommandCheckOutcome = (typeof BOT_COMMAND_CHECK_OUTCOMES)[number];

/** Why a button may be hidden by something other than the operator's own switch. */
export const MAIN_MENU_GATES = ['FEATURE', 'TRIAL_OFFER'] as const;
export type MainMenuGate = (typeof MAIN_MENU_GATES)[number];

/** The largest error code the sync row keeps. A code, never a message or a payload. */
export const BOT_COMMAND_SYNC_ERROR_CODE_MAX = 128;

const isoInstant = z.string();

/** One command as it is sent to `setMyCommands`: the rendered description, no key. */
export const botCommandEntrySchema = z.object({
  command: z.string().min(1).max(32),
  description: z.string().min(1).max(256),
});
export type BotCommandEntry = z.infer<typeof botCommandEntrySchema>;

/**
 * One item of the main menu as the Web Admin manages it: the resolved entry, its label as
 * the tenant renders it now beside the shared default, and what decides whether it is
 * drawn. `shownNow` is the keyboard's own answer for this tenant; `gateOpen` is null when
 * the read could not tell (a trial offer the reader may not evaluate).
 */
export const mainMenuItemViewSchema = z.object({
  id: z.enum(MAIN_MENU_BUTTON_IDS),
  order: z.number().int().nonnegative(),
  enabled: z.boolean(),
  target: z.enum(MAIN_MENU_TARGETS),
  label: z.string(),
  defaultLabel: z.string(),
  labelOverridden: z.boolean(),
  appearanceSlot: z.enum(MENU_APPEARANCE_SLOTS),
  defaultAppearanceSlot: z.enum(MENU_APPEARANCE_SLOTS),
  /** Drawn on a row of its own. */
  wide: z.boolean(),
  gate: z.enum(MAIN_MENU_GATES).nullable(),
  gateOpen: z.boolean().nullable(),
  shownNow: z.boolean(),
});
export type MainMenuItemView = z.infer<typeof mainMenuItemViewSchema>;

/** The sync state of one bot instance. Carries no credential and no provider payload. */
export const botCommandSyncViewSchema = z.object({
  botInstanceId: z.string(),
  username: z.string(),
  botStatus: z.enum(BOT_INSTANCE_STATUSES),
  state: z.enum(BOT_COMMAND_SYNC_STATES),
  /** The menu this tenant wants, as a digest, and how many times it has changed. */
  desiredHash: z.string(),
  desiredVersion: z.number().int().nonnegative(),
  /** What Telegram was last given, as a digest; null is unknown, never "matches". */
  syncedHash: z.string().nullable(),
  lastSyncedAt: isoInstant.nullable(),
  lastAttemptedAt: isoInstant.nullable(),
  lastErrorCode: z.string().max(BOT_COMMAND_SYNC_ERROR_CODE_MAX).nullable(),
  /** Consecutive failed attempts since the last success or reset. */
  attempts: z.number().int().nonnegative(),
  nextAttemptAt: isoInstant.nullable(),
});
export type BotCommandSyncView = z.infer<typeof botCommandSyncViewSchema>;

export const botMenuConfigResponseSchema = z.object({
  layout: z.object({
    /** The `bot.main_menu` setting's version, sent back with a save. Null when unset. */
    version: z.number().int().nullable(),
    storedValueInvalid: z.boolean(),
    items: z.array(mainMenuItemViewSchema),
  }),
  /** The keyboard as it would be drawn now, rows of labels. */
  keyboard: z.array(z.array(z.string())),
  commands: z.object({
    hash: z.string(),
    entries: z.array(botCommandEntrySchema),
  }),
  bots: z.array(botCommandSyncViewSchema),
});
export type BotMenuConfigResponse = z.infer<typeof botMenuConfigResponseSchema>;

/** «همگام‌سازی دوباره»: one bot, or every ACTIVE bot of the tenant when null. */
export const syncBotMenuRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(255),
  botInstanceId: z.string().nullable(),
});
export type SyncBotMenuRequest = z.infer<typeof syncBotMenuRequestSchema>;

export const botCommandSyncResultSchema = z.object({
  botInstanceId: z.string(),
  outcome: z.enum(BOT_COMMAND_SYNC_OUTCOMES),
  errorCode: z.string().max(BOT_COMMAND_SYNC_ERROR_CODE_MAX).nullable(),
});
export type BotCommandSyncResult = z.infer<typeof botCommandSyncResultSchema>;

export const syncBotMenuResponseSchema = z.object({
  results: z.array(botCommandSyncResultSchema),
  bots: z.array(botCommandSyncViewSchema),
});
export type SyncBotMenuResponse = z.infer<typeof syncBotMenuResponseSchema>;

/** «بررسی وضعیت»: a read of what Telegram holds. Nothing is stored. */
export const checkBotMenuRequestSchema = z.object({
  botInstanceId: z.string().nullable(),
});
export type CheckBotMenuRequest = z.infer<typeof checkBotMenuRequestSchema>;

export const botCommandCheckSchema = z.object({
  botInstanceId: z.string(),
  outcome: z.enum(BOT_COMMAND_CHECK_OUTCOMES),
  /** Whether Telegram's list equals the desired one exactly; null unless READ. */
  matches: z.boolean().nullable(),
  registered: z.array(botCommandEntrySchema).nullable(),
});
export type BotCommandCheck = z.infer<typeof botCommandCheckSchema>;

export const checkBotMenuResponseSchema = z.object({
  checkedAt: isoInstant,
  checks: z.array(botCommandCheckSchema),
  desired: z.array(botCommandEntrySchema),
});
export type CheckBotMenuResponse = z.infer<typeof checkBotMenuResponseSchema>;

export const BOT_MENU_ROUTES = {
  config: '/bot-menu',
  sync: '/bot-menu/sync',
  check: '/bot-menu/check',
} as const;
