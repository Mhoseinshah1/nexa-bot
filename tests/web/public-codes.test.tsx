import { describe, expect, it } from 'vitest';
import { codeSearchEntries } from '../../apps/web/src/shell';
import { panelUsernameAbsence } from '../../apps/web/src/pages/services';
import type { NavEntry } from '../../apps/web/src/nav';

/** Round 4, PR-C: the command search takes a short code; the panel username says why it is empty. */
const entry = (path: string): NavEntry =>
  ({ id: path, path, label: 'web.search_none', group: 'web.search_none', icon: 'search' }) as never;

describe('the command search and short codes', () => {
  const all = ['/orders', '/payments', '/services', '/tickets', '/products'].map(entry);

  it('offers an 8-character code to every list it can name, typed in any case', () => {
    expect(codeSearchEntries(' k7m2p9qa ', all).map((one) => one.path)).toEqual([
      '/orders?q=K7M2P9QA',
      '/payments?q=K7M2P9QA',
      '/services?q=K7M2P9QA',
      '/tickets?customer=K7M2P9QA',
    ]);
  });

  it('offers only the lists this operator can open', () => {
    expect(codeSearchEntries('K7M2P9QA', [entry('/payments')]).map((one) => one.path)).toEqual([
      '/payments?q=K7M2P9QA',
    ]);
  });

  it('sends a product code to the products, and anything else nowhere', () => {
    expect(codeSearchEntries('p102', all).map((one) => one.path)).toEqual([
      '/products?title=P-102',
    ]);
    expect(codeSearchEntries('orders', all)).toEqual([]);
    expect(codeSearchEntries('K7M2P9Q0', all)).toEqual([]);
  });
});

describe('«شناسهٔ کاربری در پنل» when it is empty', () => {
  const at = '2026-10-01T00:00:00.000Z';
  it('is the username once the panel holds the account', () => {
    expect(
      panelUsernameAbsence({ providerUserId: '4821', provisionedAt: at, state: 'ACTIVE' }),
    ).toBeNull();
    // Adopted from the previous bot: provisioned, no panel id recorded.
    expect(
      panelUsernameAbsence({ providerUserId: null, provisionedAt: at, state: 'ACTIVE' }),
    ).toBeNull();
  });

  it('says why: not created yet, an unknown outcome, or never created', () => {
    expect(
      panelUsernameAbsence({
        providerUserId: null,
        provisionedAt: null,
        state: 'PENDING_PROVISION',
      }),
    ).toBe('web.service_panel_username_pending');
    expect(
      panelUsernameAbsence({ providerUserId: null, provisionedAt: null, state: 'UNRECONCILED' }),
    ).toBe('web.service_panel_username_unknown');
    expect(
      panelUsernameAbsence({ providerUserId: null, provisionedAt: null, state: 'TERMINATED' }),
    ).toBe('web.service_panel_username_never');
  });
});
