import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  AudienceBuilder,
  EMPTY_AUDIENCE,
  draftOf,
  wireAudience,
  type AudienceDraft,
} from '../../apps/web/src/pages/audience-builder';
import { AUDIENCE_COUNT_DEBOUNCE_MS } from '../../apps/web/src/ui/audience-builder';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi, type Route } from './harness';
import { addAudienceCondition, audienceConditionEditor, setDateField } from './ui-helpers';

/**
 * W1.6 — the condition-list audience builder edits the SAME definition as the form it
 * replaced: for the same audience the request body is byte-for-byte the same.
 */

const TIER = '01900000-0000-7000-8000-0000000000d1';
const PRODUCT = '01900000-0000-7000-8000-0000000000e1';
const PANEL = '01900000-0000-7000-8000-0000000000f1';

const OPTIONS: Route = {
  url: '/audience/options',
  body: {
    currency: 'IRT',
    resellerTiers: [{ id: TIER, name: 'طلایی' }],
    products: [{ id: PRODUCT, title: 'یک‌ماهه' }],
    panels: [{ id: PANEL, name: 'DE-1' }],
    tags: [],
  },
};

const preview = (customers: number, reachable: number) => ({
  url: '/audience/preview',
  method: 'POST',
  body: {
    preview: {
      asOf: '2026-10-16T10:00:00.000Z',
      definition: { version: 1 },
      definitionHash: 'a'.repeat(64),
      customers,
      reachable,
      fingerprint: 'b'.repeat(32),
      sample: [],
    },
  },
});

function Harness({
  initial = EMPTY_AUDIENCE,
  onDraft = () => undefined,
}: {
  initial?: AudienceDraft;
  onDraft?: (draft: AudienceDraft) => void;
}) {
  const [draft, setDraft] = useState<AudienceDraft>(initial);
  return (
    <AudienceBuilder
      value={draft}
      onChange={(next) => {
        setDraft(next);
        onDraft(next);
      }}
    />
  );
}

async function loaded(): Promise<void> {
  await screen.findByText(t('web.aud_status'));
  const segment = addAudienceCondition(t('web.aq_segment'));
  await within(segment).findByRole('button', { name: /طلایی/u });
}

describe('the same definition, byte for byte', () => {
  it('builds through conditions the body the old form sent for the same audience', async () => {
    const api = stubApi([OPTIONS, preview(10, 8)]);
    let last: AudienceDraft = EMPTY_AUDIENCE;
    renderPage(<Harness onDraft={(draft) => (last = draft)} />);
    await loaded();

    const segment = audienceConditionEditor(t('web.aq_segment'));
    fireEvent.click(within(segment).getByRole('button', { name: t('web.aud_ordinary') }));
    fireEvent.click(within(segment).getByRole('button', { name: /طلایی/u }));

    fireEvent.click(
      within(addAudienceCondition(t('web.aud_purchase'))).getByRole('button', {
        name: t('web.aud_purchase_no'),
      }),
    );
    setDateField(
      within(addAudienceCondition(t('web.aq_registered'))).getByLabelText(
        t('web.aud_registered_from'),
      ),
      '2026-10-01',
    );
    fireEvent.change(
      within(addAudienceCondition(t('web.aq_age'))).getByLabelText(t('web.aud_age_min')),
      { target: { value: '7' } },
    );
    fireEvent.change(
      within(addAudienceCondition(t('web.aq_wallet'))).getByLabelText(
        new RegExp(t('web.aud_balance_min')),
      ),
      { target: { value: '1000' } },
    );
    fireEvent.click(
      within(addAudienceCondition(t('web.aud_products'))).getByRole('button', {
        name: 'یک‌ماهه',
      }),
    );
    fireEvent.click(
      within(addAudienceCondition(t('web.aud_service_states'))).getByRole('button', {
        name: t('web.aud_service_active'),
      }),
    );
    fireEvent.click(
      within(addAudienceCondition(t('web.aq_expiry'))).getByRole('button', {
        name: t('web.aq_expiry_72'),
      }),
    );

    // What the old form produced for this audience: the same fields, in the same order.
    const old: AudienceDraft = {
      ...EMPTY_AUDIENCE,
      segment: { ordinary: true, resellerTierIds: [TIER] },
      purchase: 'NEVER_PURCHASED',
      registeredFrom: '2026-10-01T00:00:00.000Z',
      accountAgeMinDays: 7,
      walletBalance: { currency: 'IRT', minMinor: '1000', maxMinor: null },
      service: {
        productIds: [PRODUCT],
        panelIds: [],
        states: ['ACTIVE'],
        expiringWithinHours: 72,
        expired: false,
      },
    };
    expect(JSON.stringify(wireAudience(last))).toBe(JSON.stringify(wireAudience(old)));

    // And the count asks the server with exactly that body.
    await waitFor(
      () => {
        const sent = api.calls.filter((call) => call.url.includes('/audience/preview')).at(-1);
        expect(JSON.stringify(sent?.body)).toBe(JSON.stringify({ definition: wireAudience(old) }));
      },
      { timeout: AUDIENCE_COUNT_DEBOUNCE_MS * 4 },
    );
  });

  it('removes a condition back to its default, and keeps «وضعیت حساب» fixed', async () => {
    stubApi([OPTIONS, preview(1, 1)]);
    let last: AudienceDraft = EMPTY_AUDIENCE;
    renderPage(<Harness onDraft={(draft) => (last = draft)} />);
    await loaded();
    fireEvent.click(
      within(addAudienceCondition(t('web.aud_trial'))).getByRole('button', {
        name: t('web.aud_trial_used'),
      }),
    );
    expect(last.trial).toBe('USED');
    fireEvent.click(
      screen.getByRole('button', {
        name: t('web.aq_remove').replace('{label}', t('web.aud_trial')),
      }),
    );
    expect(last.trial).toBe('ANY');
    expect(
      screen.queryByRole('button', {
        name: t('web.aq_remove').replace('{label}', t('web.aud_status')),
      }),
    ).toBeNull();
    // The fixed row still edits its value.
    fireEvent.click(
      within(audienceConditionEditor(t('web.aud_status'))).getByRole('button', {
        name: t('web.aud_status_any'),
      }),
    );
    expect(last.customerStatus).toBe('ANY');
  });

  it('keeps expiring-within and expired apart, as the contract does', async () => {
    stubApi([OPTIONS, preview(1, 1)]);
    let last: AudienceDraft = EMPTY_AUDIENCE;
    renderPage(<Harness onDraft={(draft) => (last = draft)} />);
    await loaded();
    const editor = addAudienceCondition(t('web.aq_expiry'));
    fireEvent.click(within(editor).getByRole('button', { name: t('web.aq_expiry_24') }));
    expect(last.service).toMatchObject({ expiringWithinHours: 24, expired: false });
    fireEvent.click(within(editor).getByRole('button', { name: t('web.aud_expired') }));
    expect(last.service).toMatchObject({ expiringWithinHours: null, expired: true });
    fireEvent.click(within(editor).getByRole('button', { name: t('web.aq_expiry_168') }));
    expect(last.service).toMatchObject({ expiringWithinHours: 168, expired: false });
    // Removing the last service condition removes the service criterion entirely.
    fireEvent.click(
      screen.getByRole('button', {
        name: t('web.aq_remove').replace('{label}', t('web.aq_expiry')),
      }),
    );
    expect(last.service).toBeNull();
  });

  it('reopens a stored «any service» criterion as a pending row that × removes', async () => {
    stubApi([OPTIONS, preview(1, 1)]);
    let last: AudienceDraft | null = null;
    const stored = draftOf({
      version: 1,
      service: {
        productIds: [],
        panelIds: [],
        states: [],
        expiringWithinHours: null,
        expired: false,
      },
    });
    renderPage(<Harness initial={stored} onDraft={(draft) => (last = draft)} />);
    await screen.findByText(t('web.aud_status'));
    const remove = screen.getByRole('button', {
      name: t('web.aq_remove').replace('{label}', t('web.aud_products')),
    });
    expect(remove.closest('.aq-row')).toHaveClass('pending');
    fireEvent.click(remove);
    expect((last as AudienceDraft | null)?.service).toBeNull();
  });
});

describe('the count and the quick start', () => {
  it('counts once the draft is still, and shows the server’s figures', async () => {
    const api = stubApi([OPTIONS, preview(1234, 1200)]);
    renderPage(<Harness />);
    await waitFor(
      () => expect(screen.getByTestId('audience-customers')).toHaveTextContent('1,234'),
      {
        timeout: 3000,
      },
    );
    expect(screen.getByTestId('audience-reachable')).toHaveTextContent(
      t('web.aq_reachable').replace('{n}', '1,200'),
    );
    // Three quick changes are one request, after the wait.
    const before = api.calls.filter((call) => call.url.includes('/audience/preview')).length;
    await loaded();
    const segment = audienceConditionEditor(t('web.aq_segment'));
    fireEvent.click(within(segment).getByRole('button', { name: t('web.aud_ordinary') }));
    fireEvent.click(within(segment).getByRole('button', { name: /طلایی/u }));
    fireEvent.click(within(segment).getByRole('button', { name: t('web.aud_ordinary') }));
    await waitFor(
      () =>
        expect(api.calls.filter((call) => call.url.includes('/audience/preview')).length).toBe(
          before + 1,
        ),
      { timeout: AUDIENCE_COUNT_DEBOUNCE_MS * 4 },
    );
  });

  it('says why the server refused a definition', async () => {
    stubApi([
      OPTIONS,
      {
        url: '/audience/preview',
        method: 'POST',
        status: 422,
        body: {
          error: {
            kind: 'VALIDATION',
            code: 'audience.definition_invalid',
            message: 'bad',
            correlationId: 'test',
          },
        },
      },
    ]);
    renderPage(<Harness />);
    expect(
      await screen.findByText(t('web.aud_error_invalid'), {}, { timeout: 3000 }),
    ).toBeInTheDocument();
  });

  it('applies a quick start as a whole definition and marks it', async () => {
    stubApi([OPTIONS, preview(1, 1)]);
    let last: AudienceDraft = EMPTY_AUDIENCE;
    renderPage(<Harness onDraft={(draft) => (last = draft)} />);
    await screen.findByText(t('web.aud_status'));
    const quick = screen.getByRole('group', { name: t('web.aq_quick') });
    fireEvent.click(within(quick).getByRole('button', { name: t('web.aq_preset_lapsed') }));
    expect(last).toEqual({ ...EMPTY_AUDIENCE, purchase: 'PURCHASED', noPurchaseForDays: 60 });
    expect(within(quick).getByRole('button', { name: t('web.aq_preset_lapsed') })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByText(t('web.aq_lapse_summary').replace('{n}', '60'))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: t('web.aq_clear_all') }));
    expect(last).toEqual(EMPTY_AUDIENCE);
  });

  it('groups the conditions it can add', async () => {
    stubApi([OPTIONS, preview(1, 1)]);
    renderPage(<Harness />);
    await screen.findByText(t('web.aud_status'));
    fireEvent.click(screen.getByRole('button', { name: t('web.aq_add') }));
    const menu = screen.getByRole('group', { name: t('web.aq_add') });
    for (const key of [
      'web.aq_group_who',
      'web.aq_group_act',
      'web.aq_group_time',
      'web.aq_group_money',
      'web.aq_group_svc',
    ] as const) {
      expect(within(menu).getByRole('group', { name: t(key) })).toBeInTheDocument();
    }
  });
});
