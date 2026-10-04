import { describe, expect, it } from 'vitest';
import type { PermissionKey } from '@nexa/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { NAV, navPermitted, resolve } from '../../apps/web/src/app';
import { TermsPage, termsPreviewText } from '../../apps/web/src/pages/terms';
import { GeneralInfoCard } from '../../apps/web/src/pages/customer-360-sections';
import { t } from '../../apps/web/src/i18n/web.fa';
import { customer, renderPage, stubApi } from './harness';

/**
 * Program §6 — the terms page and Customer 360's terms line, through the real API client,
 * so a fixture that drifts from `termsOverviewSchema` fails here.
 */

const CURRENT = '019250ab-cdef-7012-8345-6789abcdef01';
const OLD = '019250ab-cdef-7012-8345-6789abcdef02';
const DRAFT = '019250ab-cdef-7012-8345-6789abcdef03';

function version(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CURRENT,
    status: 'PUBLISHED',
    versionNumber: 2,
    title: 'قوانین ربات',
    body: 'بند یک.\nبند دو.',
    revision: 1,
    createdAt: '2026-09-01T08:00:00.000Z',
    createdBy: 'operator',
    updatedAt: '2026-09-01T08:00:00.000Z',
    publishedAt: '2026-09-02T08:00:00.000Z',
    publishedBy: 'owner',
    current: true,
    acceptanceCount: 7,
    ...overrides,
  };
}

function overview(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enforcement: { enabled: true, version: 3 },
    current: version(),
    draft: version({
      id: DRAFT,
      status: 'DRAFT',
      versionNumber: null,
      title: 'پیش‌نویس سوم',
      body: 'متن تازه',
      revision: 4,
      publishedAt: null,
      publishedBy: null,
      current: false,
      acceptanceCount: 0,
    }),
    history: [
      version(),
      version({
        id: OLD,
        versionNumber: 1,
        title: 'قوانین قدیمی',
        current: false,
        acceptanceCount: 3,
      }),
    ],
    statistics: { customers: 10, acceptedCurrent: 7, pendingCurrent: 3 },
    ...overrides,
  };
}

const ALL = { denied: false, mayEdit: true, mayPublish: true, mayToggle: true } as const;

describe('the terms navigation entry', () => {
  it('is shown for terms.view and for nothing else', () => {
    const entry = NAV.find((candidate) => candidate.id === 'terms');
    if (entry === undefined) throw new Error('no nav entry terms');
    expect(entry.path).toBe('/terms');
    expect(navPermitted(entry, ['terms.view'])).toBe(true);
    expect(navPermitted(entry, ['terms.edit', 'terms.publish'])).toBe(false);
  });

  it('draws the enforcement switch on settings.edit, the permission the flag write is charged', () => {
    // There is no `features.edit` key: `FeatureFlagsService` authorises every flag write
    // with `settings.edit`, so gating on anything else hides the switch from the very
    // role that may use it (or offers it to one the server refuses).
    const route = { path: '/terms', query: new URLSearchParams() };
    const props = (permissions: PermissionKey[]) =>
      (resolve(route, permissions).element as ReactElement<{ mayToggle: boolean }>).props;
    expect(props(['terms.view', 'settings.edit']).mayToggle).toBe(true);
    // Since `PermissionKey` became the catalogue's literal union, `may('features.edit')` in
    // the route table is a compile error; this cast is the one place it is still spelt, to
    // keep the runtime half of the rule (a session string nobody catalogued grants nothing).
    expect(props(['terms.view', 'features.edit' as PermissionKey]).mayToggle).toBe(false);
    expect(props(['terms.view']).mayToggle).toBe(false);
  });
});

describe('the terms page', () => {
  it('shows the current version, the statistics, the draft and the read-only history', async () => {
    stubApi([{ url: '/terms', body: overview() }]);
    renderPage(<TermsPage {...ALL} />);
    expect(await screen.findByText('پیش‌نویس سوم')).toBeInTheDocument();
    expect(screen.getAllByText('قوانین ربات').length).toBeGreaterThan(0);
    expect(screen.getByText('قوانین قدیمی')).toBeInTheDocument();

    // A published version opens read-only: no edit control inside it.
    fireEvent.click(screen.getAllByRole('button', { name: t('web.terms_view') })[1] as HTMLElement);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(t('web.terms_read_only'))).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: t('web.terms_edit_draft') })).toBeNull();
  });

  it('draws no write for a view-only role', async () => {
    stubApi([{ url: '/terms', body: overview() }]);
    renderPage(<TermsPage denied={false} mayEdit={false} mayPublish={false} mayToggle={false} />);
    await screen.findByText('پیش‌نویس سوم');
    expect(screen.queryByRole('button', { name: t('web.terms_edit_draft') })).toBeNull();
    expect(screen.getByRole('switch')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: t('web.terms_preview') }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('button', { name: t('web.terms_publish') })).toBeNull();
  });

  it('edits the draft from the revision it was opened at', async () => {
    const api = stubApi([
      { url: '/terms', body: overview() },
      { url: `/terms/versions/${DRAFT}`, body: { version: version({ id: DRAFT }) } },
    ]);
    renderPage(<TermsPage {...ALL} />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.terms_edit_draft') }));
    fireEvent.change(screen.getByLabelText(t('web.terms_body_field')), {
      target: { value: 'متن ویرایش‌شده' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('web.terms_save') }));
    await waitFor(() => {
      expect(api.calls.some((call) => call.method === 'POST')).toBe(true);
    });
    const posted = api.calls.find((call) => call.method === 'POST');
    expect(posted?.url.endsWith(`/terms/versions/${DRAFT}`)).toBe(true);
    expect(posted?.body).toEqual({
      title: 'پیش‌نویس سوم',
      body: 'متن ویرایش‌شده',
      expectedRevision: 4,
      idempotencyKey: expect.any(String) as unknown,
    });
  });

  it('publishes the previewed revision only after the confirmation, which says nobody is marked accepted', async () => {
    const api = stubApi([
      { url: '/terms', body: overview() },
      { url: `/terms/versions/${DRAFT}/publish`, body: { version: version({ id: DRAFT }) } },
    ]);
    renderPage(<TermsPage {...ALL} />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.terms_preview') }));
    const preview = await screen.findByRole('dialog');
    // The customer's message: the frame of the template, the draft's own text, the button.
    expect(preview.textContent).toContain('متن تازه');
    fireEvent.click(within(preview).getByRole('button', { name: t('web.terms_publish') }));

    const confirm = await screen.findByRole('alertdialog');
    expect(confirm.textContent).toContain(t('web.terms_publish_confirm_detail'));
    expect(api.calls.some((call) => call.method === 'POST')).toBe(false);
    fireEvent.click(within(confirm).getByRole('button', { name: t('web.terms_publish') }));
    await waitFor(() => {
      expect(api.calls.some((call) => call.method === 'POST')).toBe(true);
    });
    const posted = api.calls.find((call) => call.method === 'POST');
    expect(posted?.url.endsWith(`/terms/versions/${DRAFT}/publish`)).toBe(true);
    expect(posted?.body).toEqual({
      expectedRevision: 4,
      idempotencyKey: expect.any(String) as unknown,
    });
  });

  it('asks before turning enforcement on, and toggles it through the feature flag', async () => {
    const api = stubApi([
      { url: '/terms', body: overview({ enforcement: { enabled: false, version: 3 } }) },
      {
        url: '/features/terms_enforcement',
        body: {
          flag: {
            key: 'terms_enforcement',
            enabled: true,
            source: 'STORED',
            version: 4,
            updatedAt: '2026-09-03T08:00:00.000Z',
            updatedByAdminId: null,
            reason: null,
            description: 'x',
            blastRadius: 'TENANT_WIDE',
            configuration: [],
          },
          changed: true,
          replayed: false,
        },
      },
    ]);
    renderPage(<TermsPage {...ALL} />);
    await screen.findByText('پیش‌نویس سوم');
    fireEvent.click(screen.getByRole('switch'));
    const confirm = await screen.findByRole('alertdialog');
    expect(api.calls.some((call) => call.method === 'POST')).toBe(false);
    fireEvent.click(within(confirm).getByRole('button', { name: t('web.terms_enforce_confirm') }));
    await waitFor(() => {
      expect(api.calls.some((call) => call.method === 'POST')).toBe(true);
    });
    const posted = api.calls.find((call) => call.method === 'POST');
    expect(posted?.url.endsWith('/features/terms_enforcement')).toBe(true);
    expect(posted?.body).toMatchObject({ enabled: true, expectedVersion: 3 });
  });

  it('warns that enforcement stops nobody while nothing is published', async () => {
    stubApi([
      {
        url: '/terms',
        body: overview({
          current: null,
          history: [],
          draft: null,
          statistics: { customers: 4, acceptedCurrent: 0, pendingCurrent: 0 },
        }),
      },
    ]);
    renderPage(<TermsPage {...ALL} />);
    expect(
      await screen.findByText(t('web.terms_enforcement_nothing_published')),
    ).toBeInTheDocument();
    expect(screen.getByText(t('web.terms_none_published'))).toBeInTheDocument();
  });

  it('previews the customer message with the fallback icons and the operator’s raw text', () => {
    const text = termsPreviewText('عنوان', 'بند {یک}');
    expect(text.startsWith('ℹ️')).toBe(true);
    expect(text).toContain('عنوان');
    expect(text).toContain('بند {یک}');
    expect(text).not.toContain('{icon:');
  });
});

describe('Customer 360’s terms line', () => {
  const row = customer() as never;
  const base = {
    customerId: 'c',
    channelMembershipExemptAt: null,
    phone: null,
    locationOverride: null,
    marketingOptOutAt: null,
  };

  it('says a customer must accept the current version, and when they last accepted one', () => {
    renderPage(
      <GeneralInfoCard
        row={row}
        resellerLabel={undefined}
        overview={{
          ...base,
          terms: {
            available: true,
            enforced: true,
            current: {
              versionId: CURRENT,
              versionNumber: 2,
              title: 'قوانین',
              publishedAt: '2026-09-02T08:00:00.000Z',
            },
            lastAccepted: {
              versionId: OLD,
              versionNumber: 1,
              acceptedAt: '2026-09-01T09:00:00.000Z',
            },
            acceptedCurrent: false,
            reacceptanceRequired: true,
          },
        }}
      />,
    );
    expect(screen.getByText(t('web.c360_terms_required'))).toBeInTheDocument();
    expect(document.body.textContent).toContain(t('web.c360_terms_last'));
  });

  it('says accepted, and keeps "unavailable" for a server without the domain', () => {
    const { unmount } = renderPage(
      <GeneralInfoCard
        row={row}
        resellerLabel={undefined}
        overview={{
          ...base,
          terms: {
            available: true,
            enforced: false,
            current: {
              versionId: CURRENT,
              versionNumber: 2,
              title: 'قوانین',
              publishedAt: '2026-09-02T08:00:00.000Z',
            },
            lastAccepted: {
              versionId: CURRENT,
              versionNumber: 2,
              acceptedAt: '2026-09-03T09:00:00.000Z',
            },
            acceptedCurrent: true,
            reacceptanceRequired: false,
          },
        }}
      />,
    );
    expect(screen.getByText(t('web.c360_terms_accepted_current'))).toBeInTheDocument();
    unmount();
    renderPage(
      <GeneralInfoCard
        row={row}
        resellerLabel={undefined}
        overview={{ ...base, terms: { available: false } }}
      />,
    );
    expect(screen.getByText(t('web.c360_terms_unavailable'))).toBeInTheDocument();
  });
});
