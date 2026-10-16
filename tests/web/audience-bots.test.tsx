import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  AudienceBuilder,
  EMPTY_AUDIENCE,
  describeAudience,
  type AudienceDraft,
} from '../../apps/web/src/pages/audience-builder';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';
import { addAudienceCondition } from './ui-helpers';

/**
 * Roadmap C3 — the audience by bot, in the ONE builder Broadcast, campaigns and mass actions
 * share. Offered only where there is a choice; none chosen means every bot.
 */

const BOT_1 = '01900000-0000-7000-8000-00000000a001';
const BOT_2 = '01900000-0000-7000-8000-00000000a002';
const TIER = { id: '01900000-0000-7000-8000-0000000000d1', name: 'نقره‌ای' };

const options = (bots: { id: string; username: string; status: string }[] | undefined) => ({
  url: '/audience/options',
  body: {
    currency: 'IRT',
    resellerTiers: [TIER],
    products: [],
    panels: [],
    tags: [],
    ...(bots === undefined ? {} : { bots }),
  },
});

function Harness({ onDraft }: { onDraft: (draft: AudienceDraft) => void }) {
  const [draft, setDraft] = useState<AudienceDraft>(EMPTY_AUDIENCE);
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

/** The bots condition's editor, once the options have answered. */
async function botsEditor(): Promise<HTMLElement> {
  await screen.findByText(t('web.aud_status'));
  return waitFor(() => addAudienceCondition(t('web.aud_bots')));
}

/** Waits until the options have answered (the tier they carry is offered). */
async function optionsLoaded(): Promise<void> {
  await screen.findByText(t('web.aud_status'));
  const segment = addAudienceCondition(t('web.aq_segment'));
  await within(segment).findByRole('button', { name: new RegExp(TIER.name) });
}

describe('the audience builder by bot', () => {
  it('picks bots by id; none picked is every bot (null), never an empty list', async () => {
    stubApi([
      options([
        { id: BOT_1, username: 'shop_bot', status: 'ACTIVE' },
        { id: BOT_2, username: 'support_bot', status: 'ACTIVE' },
      ]),
    ]);
    let last: AudienceDraft = EMPTY_AUDIENCE;
    renderPage(<Harness onDraft={(draft) => (last = draft)} />);
    const editor = await botsEditor();
    const pill = (name: string) =>
      within(editor).getByRole('button', { name: new RegExp(`@${name}`) });
    fireEvent.click(pill('support_bot'));
    expect(last.botInstanceIds).toEqual([BOT_2]);
    fireEvent.click(pill('shop_bot'));
    expect(last.botInstanceIds).toEqual([BOT_2, BOT_1]);
    fireEvent.click(pill('shop_bot'));
    fireEvent.click(pill('support_bot'));
    expect(last.botInstanceIds).toBeNull();
  });

  it('offers no bot condition for a tenant with one bot, or an older server that lists none', async () => {
    stubApi([options([{ id: BOT_1, username: 'shop_bot', status: 'ACTIVE' }])]);
    const { unmount } = renderPage(<Harness onDraft={() => undefined} />);
    await optionsLoaded();
    fireEvent.click(screen.getByRole('button', { name: t('web.aq_add') }));
    expect(
      within(screen.getByRole('group', { name: t('web.aq_add') })).queryByRole('button', {
        name: t('web.aud_bots'),
      }),
    ).toBeNull();
    unmount();
    stubApi([options(undefined)]);
    renderPage(<Harness onDraft={() => undefined} />);
    await optionsLoaded();
    fireEvent.click(screen.getByRole('button', { name: t('web.aq_add') }));
    expect(
      within(screen.getByRole('group', { name: t('web.aq_add') })).queryByRole('button', {
        name: t('web.aud_bots'),
      }),
    ).toBeNull();
  });

  it('marks a bot that is not active, and describes a criterion by the bots’ names when known (n1, n2)', async () => {
    stubApi([
      options([
        { id: BOT_1, username: 'shop_bot', status: 'ACTIVE' },
        { id: BOT_2, username: 'old_bot', status: 'DISABLED' },
      ]),
    ]);
    renderPage(<Harness onDraft={() => undefined} />);
    const editor = await botsEditor();
    expect(within(editor).getByRole('button', { name: /@old_bot/ })).toHaveTextContent(
      t('web.aud_bot_not_active'),
    );
    expect(
      describeAudience({ version: 1, botInstanceIds: [BOT_2] }, new Map([[BOT_2, 'old_bot']])),
    ).toContain(`${t('web.aud_bots')}: @old_bot`);
  });

  it('describes a stored bot criterion in the report’s sentences', () => {
    expect(describeAudience({ version: 1, botInstanceIds: [BOT_1, BOT_2] })).toContain(
      `${t('web.aud_bots')}: 2`,
    );
    expect(
      describeAudience({ version: 1 }).some((line) => line.startsWith(t('web.aud_bots'))),
    ).toBe(false);
  });
});
