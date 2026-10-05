import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { KnowledgeBuildPage } from '../../apps/web/src/pages/knowledge-build';
import { t } from '../../apps/web/src/i18n/web.fa';
import { NAV, resolve } from '../../apps/web/src/app';
import { renderPage, stubApi } from './harness';

/**
 * TB9 — the Build-from-NEXA page. Fixtures go through the real API client and the contract.
 *
 * What this file defends: running posts a fresh key and nothing else; the diff shows the current
 * text beside the proposed one; «apply all» names no proposal (the server takes every
 * non-conflicting one) and is not offered for a conflict alone; a conflict offers only the two
 * explicit choices, each posted with its own key; a superseded build offers no action; review
 * controls are drawn only with the review permission; UNCHANGED items are summarised, not listed.
 */

const BUILD_ID = '019600ab-cdef-7012-8345-6789abcdef01';
const P_ADD = '019610ab-cdef-7012-8345-6789abcdef01';
const P_CONFLICT = '019620ab-cdef-7012-8345-6789abcdef01';
const P_SAME = '019630ab-cdef-7012-8345-6789abcdef01';
const ARTICLE = '019500ab-cdef-7012-8345-6789abcdef01';
const P_RETIRE = '019640ab-cdef-7012-8345-6789abcdef01';

const proposal = (overrides: Record<string, unknown> = {}) => ({
  id: P_ADD,
  sourceType: 'PRODUCT',
  kind: 'ADD',
  state: 'PENDING',
  title: 'پلن عمومی',
  body: 'مدت: ۳۰ روز',
  category: 'PLANS',
  baseTitle: null,
  baseBody: null,
  baseRevision: null,
  articleId: null,
  resolution: null,
  ...overrides,
});

const conflict = proposal({
  id: P_CONFLICT,
  sourceType: 'FAQ',
  kind: 'CONFLICT',
  title: 'چطور وصل شوم؟',
  body: 'متن تازهٔ منبع',
  category: 'GENERAL',
  baseTitle: 'چطور وصل شوم؟',
  baseBody: 'متن دستی اپراتور',
  baseRevision: 2,
  articleId: ARTICLE,
});

const unchanged = proposal({
  id: P_SAME,
  sourceType: 'TERMS',
  kind: 'UNCHANGED',
  state: 'SKIPPED',
  title: 'قوانین ثابت',
  body: 'b',
  category: 'POLICY',
  baseTitle: 'قوانین ثابت',
  baseBody: 'b',
  baseRevision: 1,
  articleId: ARTICLE,
});

const buildOf = (
  overrides: Record<string, unknown> = {},
  proposals = [proposal(), conflict, unchanged],
) => ({
  id: BUILD_ID,
  state: 'OPEN',
  createdAt: '2026-10-05T09:00:00.000Z',
  counts: { add: 1, update: 0, unchanged: 1, conflict: 1, retire: 0 },
  truncated: 0,
  capped: 0,
  proposals,
  ...overrides,
});

const calls = (api: ReturnType<typeof stubApi>, method: string, fragment: string) =>
  api.calls.filter((call) => call.method === method && call.url.includes(fragment));

function page(build: unknown = buildOf(), mayReview = true) {
  const api = stubApi([
    { url: '/support-knowledge/builds/latest', method: 'GET', body: { build } },
    { url: '/support-knowledge/builds', method: 'POST', body: { build: buildOf() } },
    { url: '/apply', method: 'POST', body: { applied: 1, conflicted: 0, skipped: 0 } },
    {
      url: '/resolve',
      method: 'POST',
      body: { ...conflict, state: 'APPLIED', resolution: 'TAKE_BUILD' },
    },
  ]);
  renderPage(<KnowledgeBuildPage denied={false} mayReview={mayReview} />);
  return api;
}

const retire = proposal({
  id: P_RETIRE,
  sourceType: 'PRODUCT',
  kind: 'RETIRE',
  title: 'پلن قدیمی',
  body: 'متن مطلب منتشرشده',
  baseTitle: 'پلن قدیمی',
  baseBody: 'متن مطلب منتشرشده',
  baseRevision: 1,
  articleId: ARTICLE,
});

describe('the Build-from-NEXA page', () => {
  it('says nothing changes until applied, and offers a run when there is no build', async () => {
    const api = page(null);
    expect(await screen.findByText(t('web.kb_empty'))).toBeInTheDocument();
    expect(screen.getByText(t('web.kb_nothing_until_apply'))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: t('web.kb_run') }));
    await waitFor(() => expect(calls(api, 'POST', '/support-knowledge/builds')).toHaveLength(1));
    const body = calls(api, 'POST', '/support-knowledge/builds')[0]!.body as Record<string, string>;
    expect(Object.keys(body)).toEqual(['idempotencyKey']);
    expect(body['idempotencyKey']!.length).toBeGreaterThanOrEqual(8);
  });

  it('shows the current text beside the proposed one; UNCHANGED is counted, not listed', async () => {
    page();
    const list = await screen.findByRole('list', { name: t('web.kb_proposals') });
    const item = list.querySelector(`[data-kind="CONFLICT"]`) as HTMLElement;
    expect(within(item).getByText('متن دستی اپراتور')).toBeInTheDocument();
    expect(within(item).getByText('متن تازهٔ منبع')).toBeInTheDocument();
    expect(list.querySelector('[data-kind="UNCHANGED"]')).toBeNull();
    expect(screen.queryByText('قوانین ثابت')).toBeNull();
  });

  it('apply all names no proposal; a single apply names exactly one', async () => {
    const api = page();
    await screen.findByRole('list', { name: t('web.kb_proposals') });
    fireEvent.click(screen.getByRole('button', { name: t('web.kb_apply_all') }));
    await waitFor(() => expect(calls(api, 'POST', '/apply')).toHaveLength(1));
    expect(calls(api, 'POST', '/apply')[0]!.body).toMatchObject({ proposalIds: null });
    expect(calls(api, 'POST', '/apply')[0]!.url).toContain(BUILD_ID);
    fireEvent.click(screen.getByRole('button', { name: t('web.kb_apply_one') }));
    await waitFor(() => expect(calls(api, 'POST', '/apply')).toHaveLength(2));
    expect(calls(api, 'POST', '/apply')[1]!.body).toMatchObject({ proposalIds: [P_ADD] });
  });

  it('a conflict offers only the two explicit choices, never an apply', async () => {
    const api = page();
    const list = await screen.findByRole('list', { name: t('web.kb_proposals') });
    const item = list.querySelector('[data-kind="CONFLICT"]') as HTMLElement;
    expect(within(item).queryByRole('button', { name: t('web.kb_apply_one') })).toBeNull();
    fireEvent.click(within(item).getByRole('button', { name: t('web.kb_keep_current') }));
    await waitFor(() => expect(calls(api, 'POST', '/resolve')).toHaveLength(1));
    expect(calls(api, 'POST', '/resolve')[0]!.body).toMatchObject({ choice: 'KEEP_CURRENT' });
    expect(calls(api, 'POST', '/resolve')[0]!.url).toContain(P_CONFLICT);
    fireEvent.click(within(item).getByRole('button', { name: t('web.kb_take_build') }));
    await waitFor(() => expect(calls(api, 'POST', '/resolve')).toHaveLength(2));
    const [first, second] = calls(api, 'POST', '/resolve');
    expect(second!.body).toMatchObject({ choice: 'TAKE_BUILD' });
    expect((first!.body as { idempotencyKey: string }).idempotencyKey).not.toBe(
      (second!.body as { idempotencyKey: string }).idempotencyKey,
    );
  });

  it('apply all is disabled when only a conflict is pending', async () => {
    page(buildOf({}, [conflict, unchanged]));
    await screen.findByRole('list', { name: t('web.kb_proposals') });
    expect(screen.getByRole('button', { name: t('web.kb_apply_all') })).toBeDisabled();
  });

  it('a superseded build offers no action', async () => {
    page(buildOf({ state: 'SUPERSEDED' }));
    expect(await screen.findByText(t('web.kb_superseded'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('web.kb_apply_all') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('web.kb_take_build') })).toBeNull();
  });

  it('a build with no changes says so', async () => {
    page(
      buildOf({ counts: { add: 0, update: 0, unchanged: 1, conflict: 0, retire: 0 } }, [unchanged]),
    );
    expect(await screen.findByText(t('web.kb_no_changes'))).toBeInTheDocument();
  });

  it('draws no review control without the review permission', async () => {
    page(buildOf(), false);
    await screen.findByRole('list', { name: t('web.kb_proposals') });
    for (const key of [
      'web.kb_run',
      'web.kb_apply_all',
      'web.kb_apply_one',
      'web.kb_take_build',
      'web.kb_keep_current',
    ] as const) {
      expect(screen.queryByRole('button', { name: t(key) })).toBeNull();
    }
  });

  it('the server’s superseded refusal is shown as that', async () => {
    stubApi([
      { url: '/support-knowledge/builds/latest', method: 'GET', body: { build: buildOf() } },
      {
        url: '/apply',
        method: 'POST',
        status: 409,
        body: {
          error: {
            kind: 'CONFLICT',
            code: 'support_knowledge.build_superseded',
            message: 'x',
            details: {},
            correlationId: 'c',
          },
        },
      },
    ]);
    renderPage(<KnowledgeBuildPage denied={false} mayReview />);
    await screen.findByRole('list', { name: t('web.kb_proposals') });
    fireEvent.click(screen.getByRole('button', { name: t('web.kb_apply_all') }));
    expect(await screen.findByText(t('web.kb_fault_superseded'))).toBeInTheDocument();
  });

  it('is in the nav under support_knowledge.view and resolves', () => {
    expect(NAV.find((entry) => entry.id === 'knowledge-build')?.permission).toBe(
      'support_knowledge.view',
    );
    const element = resolve({ path: '/knowledge-build', query: new URLSearchParams() }, [
      'support_knowledge.view',
      'support_knowledge.review',
    ]).element as { props: { denied: boolean; mayReview: boolean } };
    expect(element.props).toMatchObject({ denied: false, mayReview: true });
  });

  // --- Substitute review of PR #204 ------------------------------------------------------

  it('S2: a RETIRE has its own label and its own button naming exactly it; apply all skips it', async () => {
    const api = page(
      buildOf({ counts: { add: 0, update: 0, unchanged: 1, conflict: 0, retire: 1 } }, [
        retire,
        unchanged,
      ]),
    );
    const list = await screen.findByRole('list', { name: t('web.kb_proposals') });
    const item = list.querySelector('[data-kind="RETIRE"]') as HTMLElement;
    expect(within(item).getByText(t('web.kb_kind_retire'))).toBeInTheDocument();
    expect(within(item).getByText(t('web.kb_retire_explained'))).toBeInTheDocument();
    expect(within(item).queryByRole('button', { name: t('web.kb_apply_one') })).toBeNull();
    // «Apply all» never retires: with only a RETIRE pending it is not offered.
    expect(screen.getByRole('button', { name: t('web.kb_apply_all') })).toBeDisabled();
    fireEvent.click(within(item).getByRole('button', { name: t('web.kb_retire_one') }));
    await waitFor(() => expect(calls(api, 'POST', '/apply')).toHaveLength(1));
    expect(calls(api, 'POST', '/apply')[0]!.body).toMatchObject({ proposalIds: [P_RETIRE] });
  });

  it('N2: the build shows how many items were clipped and how many a bound dropped', async () => {
    page(buildOf({ truncated: 2, capped: 3 }));
    const bounds = await screen.findByLabelText(t('web.kb_bounds'));
    expect(bounds.textContent).toBe(`${t('web.kb_truncated')}: 2 · ${t('web.kb_capped')}: 3`);
  });

  it('N1: a concurrent run is shown as that', async () => {
    stubApi([
      { url: '/support-knowledge/builds/latest', method: 'GET', body: { build: null } },
      {
        url: '/support-knowledge/builds',
        method: 'POST',
        status: 409,
        body: {
          error: {
            kind: 'CONFLICT',
            code: 'support_knowledge.build_running',
            message: 'x',
            details: {},
            correlationId: 'c',
          },
        },
      },
    ]);
    renderPage(<KnowledgeBuildPage denied={false} mayReview />);
    await screen.findByText(t('web.kb_empty'));
    fireEvent.click(screen.getByRole('button', { name: t('web.kb_run') }));
    expect(await screen.findByText(t('web.kb_fault_running'))).toBeInTheDocument();
  });
});
