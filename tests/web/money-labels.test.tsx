import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_NOTIFICATION_KINDS,
  GATEWAY_INVOICE_CREATION_STATES,
  GATEWAY_INVOICE_OUTCOMES,
  LEDGER_DIRECTIONS,
  PAYMENT_EVIDENCE_KINDS,
  PAYMENT_GATEWAY_PROVIDERS,
  PAYMENT_RECEIPT_KINDS,
} from '@nexa/contracts';
import { render, screen } from '@testing-library/react';
import { WEB_FA } from '../../apps/web/src/i18n/web.fa';
import {
  CUSTOMER_NOTIFICATION_KIND_NAMES,
  GATEWAY_CREATION_STATE_LABELS,
  GATEWAY_OUTCOME_LABELS,
  KNOWN_PROVIDER_STATUSES,
  LEDGER_DIRECTION_NAMES,
  PAYMENT_EVIDENCE_KIND_LABELS,
  PAYMENT_GATEWAY_LABELS,
  PAYMENT_RECEIPT_KIND_LABELS,
  PROVIDER_STATUS_LABELS,
  providerPaidKey,
} from '../../apps/web/src/payment-labels';
import { CodeName, LegacyCode } from '../../apps/web/src/pages/code-name';
import {
  LEGACY_IMPORT_MAP_STATUSES,
  LEGACY_IMPORT_RUN_STATUSES,
  LEGACY_REVIEW_STATES,
} from '@nexa/contracts';
import {
  LEGACY_IMPORT_MAP_STATUS_LABELS,
  LEGACY_IMPORT_RUN_STATUS_LABELS,
  LEGACY_REVIEW_STATE_LABELS,
} from '../../apps/web/src/pages/mirza-labels';

/**
 * W5: no machine key as primary text. Every key of each closed vocabulary the money pages
 * draw has a Persian name, and that name is a real catalogue entry (never the key itself).
 */
const named = (labels: Readonly<Record<string, string>>, keys: readonly string[]) => {
  for (const key of keys) {
    const name = labels[key];
    expect(name, key).toBeDefined();
    expect(WEB_FA, `${key} → ${String(name)}`).toHaveProperty([name as string]);
    expect(WEB_FA[name as keyof typeof WEB_FA]).not.toBe(key);
  }
};

describe('the payment vocabularies have Persian names', () => {
  it.each([
    ['evidence kinds', PAYMENT_EVIDENCE_KIND_LABELS, PAYMENT_EVIDENCE_KINDS],
    ['receipt kinds', PAYMENT_RECEIPT_KIND_LABELS, PAYMENT_RECEIPT_KINDS],
    ['ledger directions', LEDGER_DIRECTION_NAMES, LEDGER_DIRECTIONS],
    ['invoice creation states', GATEWAY_CREATION_STATE_LABELS, GATEWAY_INVOICE_CREATION_STATES],
    ['gateway outcomes', GATEWAY_OUTCOME_LABELS, GATEWAY_INVOICE_OUTCOMES],
    ['notification kinds', CUSTOMER_NOTIFICATION_KIND_NAMES, CUSTOMER_NOTIFICATION_KINDS],
    ['gateways', PAYMENT_GATEWAY_LABELS, PAYMENT_GATEWAY_PROVIDERS],
    ['provider statuses', PROVIDER_STATUS_LABELS, KNOWN_PROVIDER_STATUSES],
  ] as const)('%s', (_, labels, keys) => {
    named(labels as Readonly<Record<string, string>>, keys);
  });

  it('says whether the provider received the money in words', () => {
    expect(WEB_FA[providerPaidKey(true)]).toBe('پول رسیده');
    expect(WEB_FA[providerPaidKey(false)]).toBe('پول نرسیده');
  });

  it('draws a known key by name with the raw key in the title, and an unknown one raw', () => {
    render(
      <>
        <CodeName value="completed" labels={PROVIDER_STATUS_LABELS} />
        <CodeName value="brand_new_status" labels={PROVIDER_STATUS_LABELS} />
        <CodeName value="toString" labels={PROVIDER_STATUS_LABELS} />
      </>,
    );
    expect(screen.getByText('تکمیل‌شده')).toHaveAttribute('title', 'completed');
    expect(screen.getByText('brand_new_status')).toBeInTheDocument();
    // An inherited property is not a name.
    expect(screen.getByText('toString')).toBeInTheDocument();
  });
});

describe('the legacy review codes have Persian names (W5)', () => {
  it.each([
    ['import map statuses', LEGACY_IMPORT_MAP_STATUS_LABELS, LEGACY_IMPORT_MAP_STATUSES],
    ['review states', LEGACY_REVIEW_STATE_LABELS, LEGACY_REVIEW_STATES],
    ['apply run statuses', LEGACY_IMPORT_RUN_STATUS_LABELS, LEGACY_IMPORT_RUN_STATUSES],
  ] as const)('%s', (_, labels, keys) => {
    named(labels as Readonly<Record<string, string>>, keys);
  });

  it('draws the name with the raw code in the title and beside it, and an unknown code raw', () => {
    render(
      <>
        <LegacyCode value="MANUAL_REVIEW" labels={LEGACY_IMPORT_MAP_STATUS_LABELS} />
        <LegacyCode value="SOMETHING_NEW" labels={LEGACY_IMPORT_MAP_STATUS_LABELS} />
      </>,
    );
    const named = screen.getByTitle('MANUAL_REVIEW');
    expect(named).toHaveTextContent('نیازمند بررسی دستی');
    expect(named).toHaveTextContent('MANUAL_REVIEW');
    expect(screen.getByText('SOMETHING_NEW')).toBeInTheDocument();
  });
});
