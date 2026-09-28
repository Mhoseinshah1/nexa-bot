import { z } from 'zod';
import { MAX_TRAFFIC_BYTES } from './catalog.js';
import { BYTES_PER_GB, TRAFFIC_GB_PATTERN } from './traffic-input.js';

/**
 * Package D — the custom service (`docs/package-d-custom-service-audit.md`).
 *
 * A customer types a volume in GB and a number of days, and the price comes from the
 * operator's range rules. This file is the vocabulary those rules and that input are
 * pinned by; the selection and the arithmetic live in the API's domain layer.
 */

// --- Rules ------------------------------------------------------------------------

/**
 * What a rule prices. A VOLUME rule is a price per GB over a range of GB; a TIME rule is
 * a price per day over a range of days. A custom service needs one of each.
 */
export const CUSTOM_SERVICE_RULE_DIMENSIONS = ['VOLUME', 'TIME'] as const;
export type CustomServiceRuleDimension = (typeof CUSTOM_SERVICE_RULE_DIMENSIONS)[number];
export const customServiceRuleDimensionSchema = z.enum(CUSTOM_SERVICE_RULE_DIMENSIONS);

/**
 * How specific the rule that priced a dimension was, most specific first (brief D3).
 *
 * The order IS the precedence: selection walks it and takes the first level that has a
 * rule whose range contains the request. Snapshotted with the order, so an operator can
 * read which kind of rule priced a purchase long after the rule is gone.
 */
export const CUSTOM_SERVICE_RULE_LEVELS = [
  'CUSTOMER_PANEL',
  'CUSTOMER_ALL_PANELS',
  'TIER_PANEL',
  'TIER_ALL_PANELS',
] as const;
export type CustomServiceRuleLevel = (typeof CUSTOM_SERVICE_RULE_LEVELS)[number];
export const customServiceRuleLevelSchema = z.enum(CUSTOM_SERVICE_RULE_LEVELS);

/**
 * A VOLUME rule's bounds and a request's volume are integers in HUNDREDTHS of a GB, so
 * `10.25` GB is `1025`: two decimals is the input rule (Package C), and an integer unit
 * keeps the range comparison and the price exact. A TIME rule's unit is one day.
 */
export const CUSTOM_SERVICE_VOLUME_UNITS_PER_GB = 100n;

/** The longest custom service: ten years. A bound against a typo, not a product rule. */
export const CUSTOM_SERVICE_MAX_DAYS = 3650;

/** The largest volume, in hundredths of a GB: the product ceiling, `MAX_TRAFFIC_BYTES`. */
export const CUSTOM_SERVICE_MAX_VOLUME_UNITS =
  (MAX_TRAFFIC_BYTES * CUSTOM_SERVICE_VOLUME_UNITS_PER_GB) / BYTES_PER_GB;

/** The operator's name for a rule or a location, shown in the Web Admin. */
export const CUSTOM_SERVICE_LABEL_MAX_LENGTH = 64;

// --- Parsing and formatting ----------------------------------------------------------

/**
 * Persian `۰-۹` and Arabic-Indic `٠-٩` digits as ASCII, and the Persian decimal
 * separator `٫` as a point. A customer types on a Persian keyboard; the operator's Web
 * form (Package C) stays ASCII-only, and so does everything after this normalisation.
 */
function asciiDigits(text: string): string {
  return text
    .replace(/[۰-۹]/gu, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/gu, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/٫/gu, '.');
}

/**
 * A typed volume as hundredths of a GB, or null when it is not a figure
 * `TRAFFIC_GB_PATTERN` admits. Zero parses to zero; the caller refuses it.
 */
export function parseCustomServiceVolume(text: string): bigint | null {
  const match = TRAFFIC_GB_PATTERN.exec(asciiDigits(text.trim()));
  if (match === null) return null;
  const whole = BigInt(match[1] ?? '0');
  const decimals = (match[2] ?? '.').slice(1).padEnd(2, '0');
  return whole * CUSTOM_SERVICE_VOLUME_UNITS_PER_GB + BigInt(decimals);
}

/** A typed day count, or null. Whole, positive, at most `CUSTOM_SERVICE_MAX_DAYS`. */
export function parseCustomServiceDays(text: string): number | null {
  const normalised = asciiDigits(text.trim());
  if (!/^[1-9][0-9]{0,3}$/u.test(normalised)) return null;
  const days = Number(normalised);
  return days <= CUSTOM_SERVICE_MAX_DAYS ? days : null;
}

/**
 * Hundredths of a GB as bytes, rounded to the nearest byte, half up — exactly what
 * `parseTrafficGb` produces for the same typed figure, so a custom service's allowance is
 * the allowance an operator typing the same number into a product would get.
 */
export function customServiceVolumeBytes(units: bigint): bigint {
  return (
    (units * BYTES_PER_GB + CUSTOM_SERVICE_VOLUME_UNITS_PER_GB / 2n) /
    CUSTOM_SERVICE_VOLUME_UNITS_PER_GB
  );
}

/** Hundredths of a GB as the figure typed: `1025` is `10.25`, `1050` is `10.5`, `1000` is `10`. */
export function formatCustomServiceVolume(units: bigint): string {
  const whole = units / CUSTOM_SERVICE_VOLUME_UNITS_PER_GB;
  const fraction = units % CUSTOM_SERVICE_VOLUME_UNITS_PER_GB;
  if (fraction === 0n) return whole.toString();
  return `${whole.toString()}.${fraction.toString().padStart(2, '0').replace(/0$/u, '')}`;
}
