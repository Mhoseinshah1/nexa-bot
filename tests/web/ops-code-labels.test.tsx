import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import * as contracts from '@nexa/contracts';
import {
  DELIVERY_OUTCOMES,
  GATEWAY_INVOICE_CREATION_STATES,
  LEGACY_IMPORT_REASON_CODES,
  LEGACY_REVIEW_REASON_CODES,
  OPERATION_STATES,
  PROVIDER_FAILURE_KINDS,
} from '@nexa/contracts';
import { refundFailureLabel } from '../../apps/web/src/pages/service-refund-requests';
import { WEB_FA, t } from '../../apps/web/src/i18n/web.fa';
import {
  DELIVERY_CODE_LABELS,
  DELIVERY_OUTCOME_LABELS,
  OPS_CODE_LABELS,
  errorCodeLabel,
  opsCodeLabel,
} from '../../apps/web/src/ops-code-labels';
import { CodeLabel, ProviderText } from '../../apps/web/src/ui/technical-details';

const PERSIAN = /[؀-ۿ]/u;

/**
 * The operational-event codes the contracts declare: every `*_CODE` string constant with a
 * dot, and the `MANAGEMENT_*_CODES` / `GATEWAY_HEALTH_OPERATIONAL_CODES` lists.
 */
function declaredOpsCodes(): string[] {
  const codes = new Set<string>();
  for (const [name, value] of Object.entries(contracts)) {
    if (name.endsWith('_CODE') && typeof value === 'string' && value.includes('.')) {
      codes.add(value);
    }
    if (
      (name.startsWith('MANAGEMENT_') && name.endsWith('_CODES')) ||
      name === 'GATEWAY_HEALTH_OPERATIONAL_CODES'
    ) {
      for (const code of value as readonly string[]) codes.add(code);
    }
  }
  return [...codes].sort();
}

describe('operational-event code names', () => {
  it('names every operational-event code the contracts declare', () => {
    const codes = declaredOpsCodes();
    expect(codes.length).toBeGreaterThan(40);
    expect(codes.filter((code) => OPS_CODE_LABELS[code] === undefined)).toEqual([]);
  });

  it('every name is a Persian catalogue entry', () => {
    const catalogue = WEB_FA as Readonly<Record<string, string>>;
    for (const map of [OPS_CODE_LABELS, DELIVERY_CODE_LABELS, DELIVERY_OUTCOME_LABELS]) {
      for (const key of Object.values(map)) expect(catalogue[key]).toMatch(PERSIAN);
    }
    for (const outcome of DELIVERY_OUTCOMES) {
      expect(DELIVERY_OUTCOME_LABELS[outcome]).toBeDefined();
    }
  });

  it('names every legacy reason, invoice creation state, failure kind and operation state', () => {
    for (const code of [
      ...LEGACY_IMPORT_REASON_CODES,
      ...LEGACY_REVIEW_REASON_CODES,
      ...GATEWAY_INVOICE_CREATION_STATES,
    ]) {
      expect(errorCodeLabel(code)).toMatch(PERSIAN);
    }
    for (const token of [...PROVIDER_FAILURE_KINDS, ...OPERATION_STATES, 'RESERVATION_RELEASED']) {
      expect(refundFailureLabel(token)).toMatch(PERSIAN);
    }
  });

  it('falls back to the raw code, never a blank', () => {
    expect(opsCodeLabel('brand.new_code')).toBe('brand.new_code');
    expect(errorCodeLabel('brand.new_code')).toBe('brand.new_code');
  });

  it('names contract, delivery and Telegram rejection codes', () => {
    expect(errorCodeLabel('commerce.order_not_found')).toBe(t('web.err_commerce_order_not_found'));
    expect(errorCodeLabel('INVALID_API_KEY')).toBe(t('web.err_tonpays_invalid_api_key'));
    expect(errorCodeLabel('telegram.unreachable')).toBe(t('web.dlvcode_telegram_unreachable'));
    expect(errorCodeLabel('telegram.rejected.403')).toBe(t('web.dlvcode_telegram_rejected'));
  });
});

describe('CodeLabel and ProviderText', () => {
  it('draws the Persian name with the code small and left-to-right', () => {
    render(<CodeLabel label={opsCodeLabel('backup.run_failed')} code="backup.run_failed" />);
    expect(screen.getByText(t('web.opscode_backup_run_failed'))).toBeInTheDocument();
    expect(screen.getByText('backup.run_failed')).toHaveAttribute('dir', 'ltr');
  });

  it('keeps a provider sentence inside «جزئیات فنی» only', () => {
    const { container } = render(
      <ProviderText summary="web.err_provider_operation" text="duplicate username on panel" />,
    );
    expect(screen.getByText(t('web.err_provider_operation'))).toBeInTheDocument();
    const raw = screen.getByText('duplicate username on panel');
    expect(raw.closest('details')).not.toBeNull();
    expect(screen.getByText(t('web.err_technical'))).toBeInTheDocument();
    for (const element of container.querySelectorAll('.ltr, .mono, [dir="ltr"]')) {
      expect(element.textContent ?? '').not.toMatch(PERSIAN);
    }
  });
});
