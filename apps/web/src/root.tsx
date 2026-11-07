import { App } from './app';
import { HostedActivatePage, isActivationPath, readActivationToken } from './pages/hosted-activate';

/**
 * What `main.tsx` mounts (phase 6A PR-4): the activation page on `/activate`, and the Web Admin
 * on every other address — `App` itself is untouched.
 *
 * The activation page has no session, so it must not be inside `App` (which asks for one first).
 * The link's token is read from the address's fragment once, then removed from the address bar.
 */
export function Root() {
  if (isActivationPath(window.location.pathname)) return <ActivationRoot />;
  return <App />;
}

function ActivationRoot() {
  // Read before the first render and erased from the address bar, in one place.
  const token = takeToken();
  return (
    <HostedActivatePage
      initialToken={token}
      onSignIn={() => {
        window.location.assign('/');
      }}
    />
  );
}

let taken: { readonly token: string | null } | null = null;

function takeToken(): string | null {
  if (taken === null) {
    taken = { token: readActivationToken(window.location.hash) };
    window.history.replaceState(null, '', window.location.pathname);
  }
  return taken.token;
}
