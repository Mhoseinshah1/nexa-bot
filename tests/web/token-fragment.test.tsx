import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { t } from '../../apps/web/src/i18n/web.fa';

/**
 * A one-time link's `#token=…` must survive module load. The router stamps the history entry when
 * it is imported, and an earlier version did so without the fragment, so every link read as
 * «ناقص». Each test loads the modules fresh, on an address with a fragment, as a browser does.
 */
const TOKEN = 'nxact_early-capture-token';

function visit(path: string, state: unknown = null) {
  window.history.replaceState(state, '', path);
}

describe('the address fragment at module load', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    visit('/');
  });

  it('is still on the address after the router has been imported', async () => {
    visit(`/activate#token=${TOKEN}`);
    await import('../../apps/web/src/router');
    expect(window.location.hash).toBe(`#token=${TOKEN}`);
    expect(window.location.pathname).toBe('/activate');
  });

  it('is read from the early capture even if the hash is cleared afterwards', async () => {
    visit(`/activate#token=${TOKEN}`);
    await import('../../apps/web/src/initial-fragment');
    await import('../../apps/web/src/router');
    window.history.replaceState(null, '', '/activate');
    const { takeToken } = await import('../../apps/web/src/root');
    expect(takeToken()).toEqual({ token: TOKEN, alreadyOpened: false });
  });

  it('removes the fragment, keeps nexaIndex and leaves a non-secret marker', async () => {
    visit(`/activate?x=1#token=${TOKEN}`);
    await import('../../apps/web/src/initial-fragment');
    await import('../../apps/web/src/router');
    const { takeToken } = await import('../../apps/web/src/root');
    takeToken();
    expect(window.location.hash).toBe('');
    expect(window.location.pathname + window.location.search).toBe('/activate?x=1');
    const state = window.history.state as Record<string, unknown>;
    expect(state.nexaIndex).toBe(0);
    expect(state.nexaFragmentTaken).toBe(true);
    expect(JSON.stringify(state)).not.toContain(TOKEN);
    expect(JSON.stringify(window.sessionStorage)).not.toContain(TOKEN);
    expect(JSON.stringify(window.localStorage)).not.toContain(TOKEN);
  });

  it('tells a refresh of an opened link from a broken one', async () => {
    visit('/activate', { nexaIndex: 0, nexaFragmentTaken: true });
    await import('../../apps/web/src/initial-fragment');
    const { takeToken } = await import('../../apps/web/src/root');
    expect(takeToken()).toEqual({ token: null, alreadyOpened: true });

    vi.resetModules();
    visit('/activate', { nexaIndex: 0 });
    await import('../../apps/web/src/initial-fragment');
    const fresh = await import('../../apps/web/src/root');
    expect(fresh.takeToken()).toEqual({ token: null, alreadyOpened: false });
    // A link that never carried a token leaves no marker, so its refresh still reads «ناقص».
    expect((window.history.state as Record<string, unknown>).nexaFragmentTaken).toBeUndefined();
  });
});

describe('the pages for an opened link', () => {
  function wrap(node: React.ReactNode) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  }

  it('/activate says the link was opened, not that it is incomplete', async () => {
    const { HostedActivatePage } = await import('../../apps/web/src/pages/hosted-activate');
    wrap(<HostedActivatePage initialToken={null} linkAlreadyOpened onSignIn={() => undefined} />);
    expect(screen.getByText(t('web.activate_link_used'))).toBeInTheDocument();
    expect(screen.queryByText(t('web.activate_no_token'))).toBeNull();
  });

  it('/enter says the link was opened, not that it is incomplete', async () => {
    const { HostedEnterPage } = await import('../../apps/web/src/pages/hosted-enter');
    wrap(<HostedEnterPage initialToken={null} linkAlreadyOpened onEntered={() => undefined} />);
    expect(screen.getByText(t('web.activate_link_used'))).toBeInTheDocument();
    expect(screen.queryByText(t('web.enter_no_token'))).toBeNull();
  });
});
