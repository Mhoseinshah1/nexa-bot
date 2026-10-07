import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import {
  AudienceBuilder,
  EMPTY_AUDIENCE,
  describeAudience,
  type AudienceDraft,
} from '../../apps/web/src/pages/audience-builder';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * Roadmap C3 — the audience by bot, in the ONE builder Broadcast, campaigns and mass actions
 * share. Drawn only where there is a choice; none ticked means every bot.
 */

const BOT_1 = '01900000-0000-7000-8000-00000000a001';
const BOT_2 = '01900000-0000-7000-8000-00000000a002';

const options = (bots: { id: string; username: string; status: string }[]) => ({
  url: '/audience/options',
  body: { currency: 'IRT', resellerTiers: [], products: [], panels: [], tags: [], bots },
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

describe('the audience builder by bot', () => {
  it('ticks bots by id; none ticked is every bot (null), never an empty list', async () => {
    stubApi([
      options([
        { id: BOT_1, username: 'shop_bot', status: 'ACTIVE' },
        { id: BOT_2, username: 'support_bot', status: 'ACTIVE' },
      ]),
    ]);
    let last: AudienceDraft = EMPTY_AUDIENCE;
    renderPage(<Harness onDraft={(draft) => (last = draft)} />);
    const two = await screen.findByLabelText('@support_bot');
    fireEvent.click(two);
    await waitFor(() => expect(last.botInstanceIds).toEqual([BOT_2]));
    fireEvent.click(screen.getByLabelText('@shop_bot'));
    await waitFor(() => expect(last.botInstanceIds).toEqual([BOT_2, BOT_1]));
    fireEvent.click(screen.getByLabelText('@shop_bot'));
    fireEvent.click(screen.getByLabelText('@support_bot'));
    await waitFor(() => expect(last.botInstanceIds).toBeNull());
  });

  it('draws no bot section for a tenant with one bot, or an older server that lists none', async () => {
    stubApi([options([{ id: BOT_1, username: 'shop_bot', status: 'ACTIVE' }])]);
    const { unmount } = renderPage(<Harness onDraft={() => undefined} />);
    await screen.findByText(t('web.aud_who'));
    expect(screen.queryByText(t('web.aud_bots_hint'))).toBeNull();
    unmount();
    stubApi([
      {
        url: '/audience/options',
        body: { currency: 'IRT', resellerTiers: [], products: [], panels: [], tags: [] },
      },
    ]);
    renderPage(<Harness onDraft={() => undefined} />);
    await screen.findByText(t('web.aud_who'));
    expect(screen.queryByText(t('web.aud_bots_hint'))).toBeNull();
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
