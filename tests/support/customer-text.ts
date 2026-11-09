import { applyRtlMarks } from '@nexa/i18n';
import { appearanceFallbackText } from '../../apps/api/src/modules/commerce/messaging/application/appearance-render';

/**
 * The text a customer's client receives for a catalogue body that has no variables: its icon
 * markers drawn as their fallback emoji, and — B2 — the RIGHT-TO-LEFT MARK in front of every
 * Persian line that would otherwise start left-aligned. For tests that compare a sent message
 * with a catalogue sentence.
 */
export const customerText = (body: string): string => applyRtlMarks(appearanceFallbackText(body));
