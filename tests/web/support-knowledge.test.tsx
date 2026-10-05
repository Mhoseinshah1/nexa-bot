import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  LearningCandidatesPage,
  ProposeKnowledgeButton,
  SupportKnowledgePage,
  contentOf,
} from '../../apps/web/src/pages/support-knowledge';
import { t } from '../../apps/web/src/i18n/web.fa';
import { NAV, resolve } from '../../apps/web/src/app';
import { renderPage, stubApi } from './harness';

/**
 * TB8 — the knowledge page, the learning-candidate queue and «پیشنهاد به‌عنوان دانش». Fixtures go
 * through the real API client and the contract's schemas.
 *
 * What this file defends: approve sends `edit: null` and the version read; «ویرایش و تأیید»
 * sends the EDITED text, not the proposal; reject sends no edit; a purged candidate cannot be
 * approved as is; an auto-rejected candidate names only the kinds found; review buttons are
 * not drawn without `support_knowledge.review`; an edit names the version it was opened from;
 * a create can be a draft; the filters reach the server; the propose button posts the reply.
 */

const ARTICLE_ID = '019500ab-cdef-7012-8345-6789abcdef01';
const CANDIDATE_ID = '019510ab-cdef-7012-8345-6789abcdef01';
const CHAT_ID = '019400ab-cdef-7012-8345-6789abcdef01';
const OUTBOUND_ID = '019410ab-cdef-7012-8345-6789abcdef01';

const article = (overrides: Record<string, unknown> = {}) => ({
  id: ARTICLE_ID,
  source: 'LEARNED',
  state: 'APPROVED',
  enabled: true,
  title: 'چطور لینک را وارد کنم؟',
  body: 'از «سرویس‌های من» کپی کنید.',
  category: 'APPS',
  tags: ['v2rayNG'],
  revision: 2,
  version: 4,
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-02T09:00:00.000Z',
  ...overrides,
});

const candidate = (overrides: Record<string, unknown> = {}) => ({
  id: CANDIDATE_ID,
  state: 'PENDING',
  title: 'پیشنهاد: اتصال در اندروید',
  body: 'برنامه را ببندید و باز کنید.',
  category: 'CONNECTION',
  tags: ['اندروید'],
  rationale: 'برای همه یکسان است.',
  confidence: 'HIGH',
  rejectReason: null,
  sensitiveKinds: [],
  conversationId: CHAT_ID,
  sourceCount: 2,
  provider: 'OPENAI',
  model: 'gpt-test',
  articleId: null,
  version: 3,
  createdAt: '2026-10-03T09:00:00.000Z',
  reviewedAt: null,
  ...overrides,
});

const calls = (api: ReturnType<typeof stubApi>, method: string, fragment: string) =>
  api.calls.filter((call) => call.method === method && call.url.includes(fragment));

describe('the knowledge page', () => {
  function page(
    mayReview = true,
    rows = [
      article(),
      article({
        id: `${ARTICLE_ID.slice(0, -2)}02`,
        state: 'DRAFT',
        revision: 0,
        version: 1,
        source: 'MANUAL',
        title: 'پیش‌نویس',
      }),
    ],
  ) {
    const api = stubApi([
      { url: '/support-knowledge/articles', method: 'GET', body: { articles: rows } },
      { url: '/support-knowledge/articles', method: 'POST', body: article({ source: 'MANUAL' }) },
      {
        url: `/support-knowledge/articles/${ARTICLE_ID}`,
        method: 'PUT',
        body: article({ revision: 3, version: 5 }),
      },
      { url: '/publish', method: 'POST', body: article() },
      { url: '/retire', method: 'POST', body: article({ state: 'RETIRED' }) },
      { url: '/enabled', method: 'POST', body: article({ enabled: false }) },
      {
        url: `/support-knowledge/articles/${ARTICLE_ID}/revisions`,
        body: {
          revisions: [
            {
              revision: 2,
              origin: 'MANUAL',
              title: 'دوم',
              body: 'b2',
              category: 'APPS',
              tags: [],
              reviewerAdminId: null,
              createdAt: '2026-10-02T09:00:00.000Z',
            },
            {
              revision: 1,
              origin: 'CANDIDATE',
              title: 'اول',
              body: 'b1',
              category: 'APPS',
              tags: [],
              reviewerAdminId: null,
              createdAt: '2026-10-01T09:00:00.000Z',
            },
          ],
        },
      },
    ]);
    renderPage(<SupportKnowledgePage denied={false} mayReview={mayReview} />);
    return api;
  }

  it('lists articles with source, state and the live revision, and says only approved reaches customers', async () => {
    page();
    expect(await screen.findByText('چطور لینک را وارد کنم؟')).toBeInTheDocument();
    expect(screen.getByText(t('web.sk_only_approved'))).toBeInTheDocument();
    expect(screen.getAllByText(t('web.sk_source_learned')).length).toBeGreaterThan(0);
    expect(screen.getAllByText(t('web.sk_state_draft')).length).toBeGreaterThan(0);
  });

  it('the filters reach the server', async () => {
    const api = page();
    await screen.findByText('چطور لینک را وارد کنم؟');
    fireEvent.change(screen.getByLabelText(t('web.sk_col_source')), {
      target: { value: 'NEXA_BUILD' },
    });
    fireEvent.change(screen.getByLabelText(t('web.sk_col_state')), {
      target: { value: 'RETIRED' },
    });
    await waitFor(() =>
      expect(calls(api, 'GET', 'source=NEXA_BUILD&state=RETIRED')).toHaveLength(1),
    );
  });

  it('an edit names the version it was opened from, and warns it is a new revision', async () => {
    const api = page();
    await screen.findByText('چطور لینک را وارد کنم؟');
    fireEvent.click(screen.getAllByRole('button', { name: t('web.sk_edit') })[0]!);
    expect(await screen.findByText(t('web.sk_edit_new_revision'))).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(t('web.sk_field_body')), {
      target: { value: 'متن تازه' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('web.sk_save') }));
    await waitFor(() => expect(calls(api, 'PUT', ARTICLE_ID)).toHaveLength(1));
    expect(calls(api, 'PUT', ARTICLE_ID)[0]!.body).toMatchObject({
      expectedVersion: 4,
      content: {
        title: 'چطور لینک را وارد کنم؟',
        body: 'متن تازه',
        category: 'APPS',
        tags: ['v2rayNG'],
      },
    });
  });

  it('a new article can be saved as a draft', async () => {
    const api = page();
    await screen.findByText('چطور لینک را وارد کنم؟');
    fireEvent.click(screen.getByRole('button', { name: t('web.sk_new') }));
    fireEvent.change(screen.getByLabelText(t('web.sk_field_title')), {
      target: { value: 'عنوان' },
    });
    fireEvent.change(screen.getByLabelText(t('web.sk_field_body')), { target: { value: 'متن' } });
    fireEvent.change(screen.getByLabelText(t('web.sk_field_tags')), {
      target: { value: 'یک، two' },
    });
    fireEvent.click(screen.getByLabelText(t('web.sk_publish_now')));
    fireEvent.click(screen.getByRole('button', { name: t('web.sk_save') }));
    await waitFor(() => expect(calls(api, 'POST', '/support-knowledge/articles')).toHaveLength(1));
    expect(calls(api, 'POST', '/support-knowledge/articles')[0]!.body).toMatchObject({
      publish: false,
      content: { title: 'عنوان', body: 'متن', category: 'GENERAL', tags: ['یک', 'two'] },
    });
  });

  it('publish, disable and retire name the version; revisions are listed', async () => {
    const api = page();
    await screen.findByText('چطور لینک را وارد کنم؟');
    fireEvent.click(screen.getByRole('button', { name: t('web.sk_publish') }));
    await waitFor(() => expect(calls(api, 'POST', '/publish')).toHaveLength(1));
    expect(calls(api, 'POST', '/publish')[0]!.body).toMatchObject({ expectedVersion: 1 });
    fireEvent.click(screen.getByRole('button', { name: t('web.sk_disable') }));
    await waitFor(() => expect(calls(api, 'POST', '/enabled')).toHaveLength(1));
    expect(calls(api, 'POST', '/enabled')[0]!.body).toMatchObject({
      enabled: false,
      expectedVersion: 4,
    });
    fireEvent.click(screen.getAllByRole('button', { name: t('web.sk_revisions') })[0]!);
    const list = await screen.findByRole('list', { name: t('web.sk_revisions') });
    expect(within(list).getByText('دوم')).toBeInTheDocument();
    expect(within(list).getByText(t('web.sk_live_revision'))).toBeInTheDocument();
  });

  it('draws no write control without the review permission', async () => {
    page(false);
    await screen.findByText('چطور لینک را وارد کنم؟');
    for (const key of [
      'web.sk_new',
      'web.sk_edit',
      'web.sk_publish',
      'web.sk_retire',
      'web.sk_disable',
    ] as const) {
      expect(screen.queryByRole('button', { name: t(key) })).toBeNull();
    }
  });

  it('contentOf refuses an empty or over-long form and splits Persian commas', () => {
    expect(contentOf({ title: ' ', body: 'b', category: 'GENERAL', tags: '' })).toBeNull();
    expect(
      contentOf({ title: 'x'.repeat(201), body: 'b', category: 'GENERAL', tags: '' }),
    ).toBeNull();
    expect(contentOf({ title: 't', body: 'b', category: 'APPS', tags: 'a، b, c' })).toEqual({
      title: 't',
      body: 'b',
      category: 'APPS',
      tags: ['a', 'b', 'c'],
    });
  });
});

describe('the learning-candidate queue', () => {
  function queue(mayReview = true, rows: unknown[] = [candidate()]) {
    const api = stubApi([
      { url: '/support-knowledge/candidates', method: 'GET', body: { candidates: rows } },
      {
        url: '/approve',
        method: 'POST',
        body: candidate({
          state: 'APPROVED',
          articleId: ARTICLE_ID,
          reviewedAt: '2026-10-04T09:00:00.000Z',
        }),
      },
      {
        url: '/reject',
        method: 'POST',
        body: candidate({
          state: 'REJECTED',
          rejectReason: 'REVIEWER',
          reviewedAt: '2026-10-04T09:00:00.000Z',
        }),
      },
      { url: '/support-knowledge/articles', method: 'GET', body: { articles: [] } },
    ]);
    renderPage(<LearningCandidatesPage denied={false} mayReview={mayReview} />);
    return api;
  }

  it('asks for PENDING by default and says nothing is active without approval', async () => {
    const api = queue();
    expect(await screen.findByText('پیشنهاد: اتصال در اندروید')).toBeInTheDocument();
    expect(screen.getByText(t('web.sk_cand_nothing_active'))).toBeInTheDocument();
    expect(calls(api, 'GET', 'state=PENDING')).toHaveLength(1);
  });

  it('approve sends edit null and the version the reviewer read', async () => {
    const api = queue();
    await screen.findByText('پیشنهاد: اتصال در اندروید');
    fireEvent.click(screen.getByRole('button', { name: t('web.sk_approve') }));
    await waitFor(() => expect(calls(api, 'POST', '/approve')).toHaveLength(1));
    expect(calls(api, 'POST', '/approve')[0]!.body).toMatchObject({
      expectedVersion: 3,
      edit: null,
    });
    expect(calls(api, 'POST', '/approve')[0]!.url).toContain(CANDIDATE_ID);
  });

  it('edit then approve sends the EDITED text, not the proposal', async () => {
    const api = queue();
    await screen.findByText('پیشنهاد: اتصال در اندروید');
    fireEvent.click(screen.getByRole('button', { name: t('web.sk_edit_approve') }));
    fireEvent.change(await screen.findByLabelText(t('web.sk_field_body')), {
      target: { value: 'متن بازبینی‌شده' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('web.sk_approve_edited') }));
    await waitFor(() => expect(calls(api, 'POST', '/approve')).toHaveLength(1));
    expect(calls(api, 'POST', '/approve')[0]!.body).toMatchObject({
      expectedVersion: 3,
      edit: {
        title: 'پیشنهاد: اتصال در اندروید',
        body: 'متن بازبینی‌شده',
        category: 'CONNECTION',
        tags: ['اندروید'],
      },
    });
  });

  it('reject sends no edit, and never the approve route', async () => {
    const api = queue();
    await screen.findByText('پیشنهاد: اتصال در اندروید');
    fireEvent.click(screen.getByRole('button', { name: t('web.sk_reject') }));
    await waitFor(() => expect(calls(api, 'POST', '/reject')).toHaveLength(1));
    expect(calls(api, 'POST', '/reject')[0]!.body).toMatchObject({ expectedVersion: 3 });
    expect(calls(api, 'POST', '/approve')).toHaveLength(0);
  });

  it('a purged candidate cannot be approved as is; an auto-rejected one names only kinds', async () => {
    queue(true, [
      candidate({ body: null, rationale: null }),
      candidate({
        id: `${CANDIDATE_ID.slice(0, -2)}02`,
        state: 'REJECTED',
        rejectReason: 'SENSITIVE_CONTENT',
        sensitiveKinds: ['PHONE', 'CARD'],
        title: 'دیگری',
        reviewedAt: '2026-10-03T10:00:00.000Z',
      }),
    ]);
    await screen.findByText(t('web.sk_cand_purged'));
    expect(screen.getByRole('button', { name: t('web.sk_approve') })).toBeDisabled();
    expect(screen.getByText(t('web.sk_cand_auto_rejected'))).toBeInTheDocument();
    expect(
      screen.getByText(`${t('web.sk_kind_phone')}، ${t('web.sk_kind_card')}`),
    ).toBeInTheDocument();
  });

  it('the server’s sensitive-content refusal is shown as that', async () => {
    stubApi([
      { url: '/support-knowledge/candidates', method: 'GET', body: { candidates: [candidate()] } },
      {
        url: '/approve',
        method: 'POST',
        status: 409,
        body: {
          error: {
            kind: 'CONFLICT',
            code: 'support_knowledge.sensitive_content',
            message: 'x',
            details: {},
            correlationId: 'c',
          },
        },
      },
    ]);
    renderPage(<LearningCandidatesPage denied={false} mayReview />);
    await screen.findByText('پیشنهاد: اتصال در اندروید');
    fireEvent.click(screen.getByRole('button', { name: t('web.sk_approve') }));
    expect(await screen.findByText(t('web.sk_fault_sensitive'))).toBeInTheDocument();
  });

  it('draws no review control without the review permission', async () => {
    queue(false);
    await screen.findByText('پیشنهاد: اتصال در اندروید');
    expect(screen.queryByRole('button', { name: t('web.sk_approve') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('web.sk_reject') })).toBeNull();
  });
});

describe('«پیشنهاد به‌عنوان دانش»', () => {
  it('posts the reply with a fresh key, and names the rate-limit refusal', async () => {
    const api = stubApi([
      { url: '/knowledge-proposals', method: 'POST', body: { jobId: 'j1', state: 'QUEUED' } },
    ]);
    renderPage(<ProposeKnowledgeButton conversationId={CHAT_ID} outboundId={OUTBOUND_ID} />);
    fireEvent.click(screen.getByRole('button', { name: t('web.sk_propose') }));
    await waitFor(() => expect(calls(api, 'POST', '/knowledge-proposals')).toHaveLength(1));
    const body = calls(api, 'POST', '/knowledge-proposals')[0]!.body as Record<string, string>;
    expect(body['outboundId']).toBe(OUTBOUND_ID);
    expect(body['idempotencyKey']?.length).toBeGreaterThanOrEqual(8);
    expect(calls(api, 'POST', CHAT_ID)).toHaveLength(1);
  });

  it('shows the window refusal in Persian', async () => {
    stubApi([
      {
        url: '/knowledge-proposals',
        method: 'POST',
        status: 409,
        body: {
          error: {
            kind: 'CONFLICT',
            code: 'support_knowledge.learning_rate_limited',
            message: 'x',
            details: {},
            correlationId: 'c',
          },
        },
      },
    ]);
    renderPage(<ProposeKnowledgeButton conversationId={CHAT_ID} outboundId={OUTBOUND_ID} />);
    fireEvent.click(screen.getByRole('button', { name: t('web.sk_propose') }));
    expect(await screen.findByText(t('web.sk_propose_fault_rate'))).toBeInTheDocument();
  });
});

describe('navigation', () => {
  it('both pages are in the nav under support_knowledge.view and resolve', () => {
    const ids = NAV.filter((entry) => entry.permission === 'support_knowledge.view').map(
      (e) => e.id,
    );
    expect(ids).toEqual(['support-knowledge', 'learning-candidates']);
    const view = ['support_knowledge.view'] as const;
    expect(resolve({ path: '/support-knowledge', query: new URLSearchParams() }, view).title).toBe(
      t('web.sk_title'),
    );
    const element = resolve({ path: '/support-learning', query: new URLSearchParams() }, view)
      .element as { props: { denied: boolean; mayReview: boolean } };
    expect(element.props).toMatchObject({ denied: false, mayReview: false });
  });
});
