import type { LegacyServiceOutcome } from '@nexa/contracts';
import { t, type WebKey } from '../i18n/web.fa';

/*
 * The importer's service-outcome words (one per invoice the import classified). The
 * «سرویس‌های ربات قدیمی» review page is retired (Round 4 B4); the import report on the one-click
 * page still names each outcome in Persian, so the labels live here.
 */

export const LEGACY_SERVICE_OUTCOME_LABELS: Readonly<Record<LegacyServiceOutcome, WebKey>> = {
  ADOPTED: 'web.lsr_outcome_adopted',
  ALREADY_ADOPTED: 'web.lsr_outcome_already_adopted',
  ADOPTION_ELIGIBLE: 'web.lsr_outcome_eligible',
  INVOICE_KEY_INVALID: 'web.lsr_outcome_key_invalid',
  TEST_INVOICE_SKIPPED: 'web.lsr_outcome_test_invoice',
  TEST_PANEL_SKIPPED: 'web.lsr_outcome_test_panel',
  INVALID_SOURCE_ROW: 'web.lsr_outcome_invalid_row',
  ORPHAN: 'web.lsr_outcome_orphan',
  CUSTOMER_NOT_IMPORTED: 'web.lsr_outcome_customer_not_imported',
  INVALID_USERNAME: 'web.lsr_outcome_invalid_username',
  INVENTORY_INCOMPLETE: 'web.lsr_outcome_inventory_incomplete',
  NO_PANEL: 'web.lsr_outcome_no_panel',
  PANEL_UNMAPPED: 'web.lsr_outcome_panel_unmapped',
  PROVIDER_MISSING: 'web.lsr_outcome_provider_missing',
  AMBIGUOUS_PANEL: 'web.lsr_outcome_ambiguous_panel',
  USERNAME_CASE_COLLISION: 'web.lsr_outcome_case_collision',
  AMBIGUOUS_OWNERSHIP: 'web.lsr_outcome_ambiguous_ownership',
  UNSUPPORTED_SHAPE: 'web.lsr_outcome_unsupported_shape',
  PRODUCT_UNRESOLVED: 'web.lsr_outcome_product_unresolved',
  SUBSCRIPTION_REF_BLOCKED: 'web.lsr_outcome_subscription_blocked',
  PROVIDER_READ_FAILED: 'web.lsr_outcome_read_failed',
  REVIEW_CLOSED: 'web.lsr_outcome_review_closed',
};

/** A refusal code is an outcome or one of the approval's own four; labelled either way. */
export function legacyServiceRefusalLabel(code: string): string {
  const outcome = LEGACY_SERVICE_OUTCOME_LABELS[code as LegacyServiceOutcome];
  if (outcome !== undefined) return t(outcome);
  const own: Readonly<Record<string, WebKey>> = {
    NOT_LIVE: 'web.lsr_refusal_not_live',
    SOURCE_CHANGED: 'web.lsr_refusal_source_changed',
    PANEL_NOT_MAPPED: 'web.lsr_refusal_panel_not_mapped',
    PANEL_CONFLICTS_WITH_MAP: 'web.lsr_refusal_panel_conflicts',
  };
  const key = own[code];
  return key === undefined ? code : t(key);
}
