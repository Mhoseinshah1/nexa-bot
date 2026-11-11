import { getInitialFragment } from './initial-fragment';
import { App } from './app';
import { HostedActivatePage, isActivationPath, readActivationToken } from './pages/hosted-activate';
import { HostedEnterPage, isEnterPath } from './pages/hosted-enter';

/**
 * What `main.tsx` mounts (phase 6A PR-4): the activation page on `/activate`, and the Web Admin
 * on every other address — `App` itself is untouched.
 *
 * The activation page has no session, so it must not be inside `App` (which asks for one first).
 * The link's token is read from the address's fragment once, then removed from the address bar.
 */
export function Root() {
  if (isActivationPath(window.location.pathname)) return <ActivationRoot />;
  // Phase 6B «ورود به پنل»: the owner's one-time entry, `/enter#token=…`, same fragment rule.
  if (isEnterPath(window.location.pathname)) return <EnterRoot />;
  return <App />;
}

function ActivationRoot() {
  // Read before the first render and erased from the address bar, in one place.
  const { token, alreadyOpened } = takeToken();
  return (
    <HostedActivatePage
      initialToken={token}
      linkAlreadyOpened={alreadyOpened}
      onSignIn={() => {
        window.location.assign('/');
      }}
    />
  );
}

function EnterRoot() {
  const { token, alreadyOpened } = takeToken();
  return (
    <HostedEnterPage
      initialToken={token}
      linkAlreadyOpened={alreadyOpened}
      onEntered={() => {
        window.location.assign('/');
      }}
    />
  );
}

interface TakenToken {
  readonly token: string | null;
  /** No fragment now, but this entry's fragment was already read: a refresh of an opened link. */
  readonly alreadyOpened: boolean;
}

let taken: TakenToken | null = null;

const FRAGMENT_TAKEN = 'nexaFragmentTaken';

function hasTakenMarker(state: unknown): boolean {
  return (
    typeof state === 'object' &&
    state !== null &&
    (state as Record<string, unknown>)[FRAGMENT_TAKEN] === true
  );
}

/**
 * Reads the link's token from the fragment captured at start-up, then removes the fragment from the
 * address bar. The token lives in memory for the page's life only; history.state gets a non-secret
 * marker (merged, so the router's `nexaIndex` survives) so a refresh can tell "opened" from "broken".
 */
export function takeToken(): TakenToken {
  if (taken === null) {
    const token = readActivationToken(getInitialFragment());
    const state: unknown = window.history.state;
    taken = { token, alreadyOpened: token === null && hasTakenMarker(state) };
    const base = typeof state === 'object' && state !== null ? state : {};
    window.history.replaceState(
      { ...base, ...(token === null ? {} : { [FRAGMENT_TAKEN]: true }) },
      '',
      `${window.location.pathname}${window.location.search}`,
    );
  }
  return taken;
}
