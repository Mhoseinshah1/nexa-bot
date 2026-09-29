import { z } from 'zod';
import type { StateMachineDefinition } from './state-machine.js';

/**
 * Round N, C1 — Campaigns (`docs/round-n-campaigns-audit.md`).
 *
 * A campaign is a record that COMPOSES engines that already exist — the discount and
 * cashback rules of the single pricing boundary, the shared audience, Broadcast and the
 * safe mass actions — and owns none of their decisions. What it owns is declared here:
 * its states, the kinds of action it can compose, and its bounds.
 *
 * NOT Mirza parity: the research has no campaign entity at all (NOT_EXPOSED, zero corpus
 * hits). Everything in this file is a Nexa decision.
 */

export const CAMPAIGN_STATES = [
  'DRAFT',
  'SCHEDULED',
  'ACTIVE',
  'PAUSED',
  'COMPLETED',
  'CANCELLED',
] as const;
export type CampaignState = (typeof CAMPAIGN_STATES)[number];
export const campaignStateSchema = z.enum(CAMPAIGN_STATES);

export const CAMPAIGN_TERMINAL_STATES = ['COMPLETED', 'CANCELLED'] as const;

/** The states a campaign may be cancelled from: every state that is not terminal. */
export const CAMPAIGN_CANCELLABLE_STATES = ['DRAFT', 'SCHEDULED', 'ACTIVE', 'PAUSED'] as const;

/** The states in which the campaign's window is still running, for completion. */
export const CAMPAIGN_RUNNING_STATES = ['ACTIVE', 'PAUSED'] as const;

/**
 * - `SCHEDULE` — the operator confirms a draft after its preview.
 * - `START` — the worker, once `starts_at` has passed.
 * - `PAUSE` / `RESUME` — the operator.
 * - `COMPLETE` — the worker, once `ends_at` has passed.
 * - `CANCEL` — the operator, from any state that is not terminal.
 */
export type CampaignEvent = 'SCHEDULE' | 'START' | 'PAUSE' | 'RESUME' | 'COMPLETE' | 'CANCEL';

/**
 * Every edge, and nothing else. Every state write is a conditional UPDATE naming the
 * states it moves FROM — there is no `setState` — so a replay, a double click and two
 * worker replicas each either win their edge or are told the campaign moved.
 */
export const CAMPAIGN_MACHINE: StateMachineDefinition<CampaignState, CampaignEvent> = {
  name: 'Campaign',
  initial: 'DRAFT',
  states: CAMPAIGN_STATES,
  terminal: CAMPAIGN_TERMINAL_STATES,
  transitions: [
    { from: 'DRAFT', to: 'SCHEDULED', on: 'SCHEDULE', guard: 'previewedWindowNotOver' },
    { from: 'SCHEDULED', to: 'ACTIVE', on: 'START', guard: 'startsAtPassed' },
    { from: 'ACTIVE', to: 'PAUSED', on: 'PAUSE' },
    { from: 'PAUSED', to: 'ACTIVE', on: 'RESUME', guard: 'endsAtNotPassed' },
    { from: 'ACTIVE', to: 'COMPLETED', on: 'COMPLETE', guard: 'endsAtPassed' },
    { from: 'PAUSED', to: 'COMPLETED', on: 'COMPLETE', guard: 'endsAtPassed' },
    { from: 'DRAFT', to: 'CANCELLED', on: 'CANCEL' },
    { from: 'SCHEDULED', to: 'CANCELLED', on: 'CANCEL' },
    { from: 'ACTIVE', to: 'CANCELLED', on: 'CANCEL' },
    { from: 'PAUSED', to: 'CANCELLED', on: 'CANCEL' },
  ],
};

/**
 * What a campaign can do, each through the engine that already does it:
 *
 * - `DISCOUNT` — one rule in `discounts` (the pricing engine applies it);
 * - `CASHBACK` — one rule in `cashback_rules` (the cashback earner pays it);
 * - `WALLET_GIFT` — one bulk wallet credit (the shared mass-credit engine);
 * - `TRAFFIC_GIFT` / `TIME_GIFT` — one bulk service operation (the shared bulk engine);
 * - `ANNOUNCEMENT` — one broadcast (Broadcast's durable delivery lane).
 *
 * A referral incentive is deliberately absent: the audit's D8 records why it cannot be
 * expressed through the existing referral terms without a tenant-wide, lost-update write.
 */
export const CAMPAIGN_ACTION_KINDS = [
  'DISCOUNT',
  'CASHBACK',
  'WALLET_GIFT',
  'TRAFFIC_GIFT',
  'TIME_GIFT',
  'ANNOUNCEMENT',
] as const;
export type CampaignActionKind = (typeof CAMPAIGN_ACTION_KINDS)[number];
export const campaignActionKindSchema = z.enum(CAMPAIGN_ACTION_KINDS);

/**
 * The actions the campaign PERFORMS once, at start, against the frozen audience. The
 * other two (`DISCOUNT`, `CASHBACK`) are standing rules whose own window the pricing
 * engine enforces, so starting the campaign writes nothing for them.
 */
export const CAMPAIGN_LAUNCHED_ACTION_KINDS = [
  'WALLET_GIFT',
  'TRAFFIC_GIFT',
  'TIME_GIFT',
  'ANNOUNCEMENT',
] as const satisfies readonly CampaignActionKind[];

/**
 * Where a launched action stands, from the campaign's side only.
 *
 * `PENDING` until the campaign starts; `LAUNCHED` once the engine it composes holds the
 * work (its own row then says how far it got); `CANCELLED` when the campaign was cancelled
 * before it launched; `FAILED` when the engine refused to take it, with the reason code.
 * A standing rule's action is `LAUNCHED` from the moment its rule exists.
 */
export const CAMPAIGN_ACTION_STATES = ['PENDING', 'LAUNCHED', 'CANCELLED', 'FAILED'] as const;
export type CampaignActionState = (typeof CAMPAIGN_ACTION_STATES)[number];

/**
 * The campaign's name is also the label of the discount and cashback rules it creates, so
 * it is bounded by `DISCOUNT_LABEL_MAX_LENGTH`: one name, whole, wherever it is read.
 */
export const CAMPAIGN_NAME_MAX_LENGTH = 80;
export const CAMPAIGN_DESCRIPTION_MAX_LENGTH = 2000;
export const CAMPAIGN_PAGE_DEFAULT = 25;
export const CAMPAIGN_PAGE_MAX = 100;

/**
 * How many due campaigns one worker tick moves. Bounded so one tick is one short
 * transaction per campaign; the next tick takes the rest.
 */
export const CAMPAIGN_SCHEDULE_BATCH = 50;

/** How often the campaign lane wakes: a minute, the resolution the operator schedules in. */
export const CAMPAIGN_SCHEDULE_INTERVAL_MS = 60_000;

/**
 * Campaign error codes. One remedy each; a campaign of another tenant and one that does
 * not exist are both `CAMPAIGN_NOT_FOUND`.
 */
export const CAMPAIGN_ERROR_CODES = {
  CAMPAIGN_NOT_FOUND: 'campaign.not_found',
  /** The body does not match its contract, or a field is out of bounds. */
  CAMPAIGN_REQUEST_INVALID: 'campaign.request_invalid',
  /** The requested change has no edge from where the campaign stands (`CAMPAIGN_MACHINE`). */
  CAMPAIGN_TRANSITION_INVALID: 'campaign.transition_invalid',
  /** Only a DRAFT is edited; a scheduled campaign is cancelled and made again. */
  CAMPAIGN_NOT_EDITABLE: 'campaign.not_editable',
  /** The window is unreadable, ends before it starts, or is already over. */
  CAMPAIGN_WINDOW_INVALID: 'campaign.window_invalid',
  /** A campaign with no action does nothing; one is required before it is scheduled. */
  CAMPAIGN_NO_ACTION: 'campaign.no_action',
  /**
   * The confirmation does not match what the preview showed — the audience count or the
   * total liability moved between the preview and the confirmation. Preview again.
   */
  CAMPAIGN_PREVIEW_STALE: 'campaign.preview_stale',
} as const;
export type CampaignErrorCode = (typeof CAMPAIGN_ERROR_CODES)[keyof typeof CAMPAIGN_ERROR_CODES];
