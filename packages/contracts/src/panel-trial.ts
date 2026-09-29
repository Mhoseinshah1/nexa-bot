import { z } from 'zod';
import {
  BYTES_PER_GB,
  TRAFFIC_GB_PATTERN,
  TRAFFIC_INPUT_UNITS,
  parseTrafficInput,
} from './traffic-input.js';

/**
 * R1: a trial is configured PER PANEL, and is independent of the catalogue.
 *
 * Until R1 a trial was "the product `trial.product_id` names", so an operator who wanted a
 * trial had to create a product, keep it out of the catalogue by leaving it unpriced, and
 * point a setting at it — and a trial order carried that product as though it had been
 * bought. The owner's brief replaces it: each panel says whether it offers a trial, how
 * much traffic and for how many hours. A trial ORDER still exists — purpose `TRIAL`, total
 * zero, the order machine's `GRANT` edge — because that is what the ordinary provisioning
 * path, its capacity slot, its username lane and its delivery act on; but it names no
 * product, and the service it produces is marked `is_trial` in the database.
 *
 * Which panels a customer is offered is decided by the ONE eligibility evaluator
 * (`decideEligibility`, through `PanelSalesGate`) plus this configuration being enabled —
 * never by a second predicate.
 */

/** The shortest and longest trial, in hours: one hour, and thirty days. */
export const PANEL_TRIAL_HOURS_MIN = 1;
export const PANEL_TRIAL_HOURS_MAX = 720;

/**
 * The largest trial allowance: 100 GB. A sanity ceiling, not a product number — a free
 * service larger than that is a plan, and plans are products.
 */
export const PANEL_TRIAL_TRAFFIC_MAX_BYTES = 100n * BYTES_PER_GB;

/** The customer-facing name of a panel's trial, on the choice button: optional, short. */
export const PANEL_TRIAL_LABEL_MAX_LENGTH = 64;

/** One panel's trial configuration, as the operator reads it. */
export const panelTrialSchema = z.object({
  panelId: z.string(),
  /** Offered to customers — while the `trials` flag is on and the panel may take new accounts. */
  enabled: z.boolean(),
  /** Bytes, as a decimal string; null when this panel has never been configured. */
  trafficBytes: z
    .string()
    .regex(/^[0-9]+$/u)
    .nullable(),
  durationHours: z.number().int().nullable(),
  /** The name a customer chooses it by; null means the panel's own name. */
  label: z.string().nullable(),
  /** What a write must name. Zero when nothing is stored yet. */
  revision: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime().nullable(),
});
export type PanelTrialResponseBody = z.infer<typeof panelTrialSchema>;

export const panelTrialResponseSchema = z.object({ trial: panelTrialSchema });
export type PanelTrialResponse = z.infer<typeof panelTrialResponseSchema>;

/**
 * Replacing one panel's trial configuration. Whole, never a patch, and carrying the
 * revision the form was drawn from, so two operators editing one panel cannot silently
 * overwrite each other — the panel policy's rule (WP-A8).
 *
 * The traffic is typed as a figure and a unit, GB or MB, and converted by the ONE parser
 * (`parseTrafficInput`) — the form and the server cannot convert it two ways.
 */
export const updatePanelTrialRequestSchema = z
  .object({
    idempotencyKey: z.string().min(8).max(255),
    expectedRevision: z.number().int().nonnegative(),
    enabled: z.boolean(),
    trafficAmount: z.string().trim().regex(TRAFFIC_GB_PATTERN),
    trafficUnit: z.enum(TRAFFIC_INPUT_UNITS),
    durationHours: z.number().int().min(PANEL_TRIAL_HOURS_MIN).max(PANEL_TRIAL_HOURS_MAX),
    label: z.string().trim().max(PANEL_TRIAL_LABEL_MAX_LENGTH).nullable(),
  })
  .refine(
    (body) => {
      const bytes = parseTrafficInput(body.trafficAmount, body.trafficUnit);
      return bytes !== null && bytes > 0n && bytes <= PANEL_TRIAL_TRAFFIC_MAX_BYTES;
    },
    { message: 'A trial allowance is more than zero and at most 100 GB.', path: ['trafficAmount'] },
  );
export type UpdatePanelTrialRequest = z.infer<typeof updatePanelTrialRequestSchema>;

export const updatePanelTrialResponseSchema = z.object({
  trial: panelTrialSchema,
  /** False for a save that stored what was already stored, or a replay. */
  changed: z.boolean(),
});
export type UpdatePanelTrialResponse = z.infer<typeof updatePanelTrialResponseSchema>;

/**
 * Every panel's trial, for the Trials page's overview: what is configured, and whether a
 * customer would be offered it NOW — the same evaluator the bot asks, read-only.
 */
export const panelTrialOverviewRowSchema = z.object({
  panelId: z.string(),
  panelName: z.string(),
  trial: panelTrialSchema,
  /** Enabled, configured, and the panel may take a new account on its own username policy. */
  offeredNow: z.boolean(),
});
export type PanelTrialOverviewRow = z.infer<typeof panelTrialOverviewRowSchema>;

export const panelTrialOverviewResponseSchema = z.object({
  panels: z.array(panelTrialOverviewRowSchema),
});
export type PanelTrialOverviewResponse = z.infer<typeof panelTrialOverviewResponseSchema>;

export const PANEL_TRIAL_ROUTES = {
  trial: (id: string) => `/panels/${encodeURIComponent(id)}/trial`,
  overview: '/trials/panels',
} as const;
