import { useEffect, useState, type FormEvent, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SessionResponse } from '@nexa/contracts';
import { retryWhileFailing } from './polling';
import { ApiError, fetchSession, signIn, signOut } from './api/client';
import { t, type WebKey } from './i18n/web.fa';
import { match, navigate, useDocumentTitle, useLinkHandler, useRoute, type Route } from './router';
import { useTheme, type ThemeChoice } from './theme';
import { Icon, type IconName } from './ui/icons';
import { ToastProvider } from './ui/kit';
import { DashboardPage } from './pages/dashboard';
import { PanelsPage, PanelDetailPage, NewPanelPage, ProvidersPage } from './pages/panels';
import { SettingsPage } from './pages/settings';
import { FeaturesPage } from './pages/features';
import { ContentPage } from './pages/content';
import { AlertsPage, NotificationsPage } from './pages/alerts';
import { SystemPage } from './pages/system';
import { PlannedPage, PLANNED_SURFACES, type PlannedKey } from './pages/planned';

/**
 * The Web Admin shell.
 *
 * Nothing here is fake. Every screen behind it either calls a real endpoint or
 * says, in the same vocabulary everywhere, that the capability does not exist
 * yet. `permission` decides what is DRAWN and never what is allowed: the server
 * re-checks every call, and this component would be exactly as safe if it drew
 * all of it. In the legacy system "enforcement" may well have meant nothing
 * more than menu hiding (UNK-ADM-001).
 */

/**
 * Which of four states the session query is in.
 *
 * A pure function, and separate from the component, because the distinction it
 * makes is a rule rather than a rendering detail: `fetchSession` resolves to
 * `null` ONLY for a 401 — the server saying there is no session — and rejects
 * for everything else. Collapsing those two into "show the sign-in form" told
 * an administrator holding a good cookie that they were signed out, and invited
 * them to open a second session to fix a problem that was never theirs.
 */
export function sessionView(query: {
  isPending: boolean;
  isError: boolean;
  data?: SessionResponse | null | undefined;
}): 'loading' | 'unavailable' | 'signed-in' | 'signed-out' {
  if (query.isPending) return 'loading';
  if (query.isError) return 'unavailable';
  return query.data ? 'signed-in' : 'signed-out';
}

// ---------------------------------------------------------------------------
// The route table
// ---------------------------------------------------------------------------

interface NavEntry {
  readonly id: string;
  /** The nav destination. Detail routes are matched separately. */
  readonly path: string;
  readonly label: WebKey;
  readonly icon: IconName;
  /**
   * What the entry needs to be worth showing. Null means everyone with a
   * session; an ARRAY means ANY of them, because a page can serve more than one
   * capability and gating it on the first one hides the others.
   *
   * `/notifications` is why this is not a single string. It carries two
   * separate server capabilities — the delivery history (`opslog.view`) and the
   * test send (`settings.edit`, which `POST /notifications/test` authorizes on
   * its own and which the page already gates separately). Requiring only
   * `opslog.view` meant an actor holding `settings.edit` alone had no link to a
   * page that would have served them correctly: the UI hid an action the server
   * permits, which is the same defect as offering one it refuses, in the
   * direction nobody looks.
   */
  readonly permission: string | readonly string[] | null;
  readonly group: WebKey;
}

/**
 * Whether an actor may see a navigation entry.
 *
 * Exported because the rule is worth asserting directly: an entry listing
 * several permissions is satisfied by ANY of them, and the failure it exists to
 * prevent — a page with two capabilities hidden from an actor who holds one —
 * is invisible from the outside.
 */
export function navPermitted(entry: NavEntry, permissions: readonly string[]): boolean {
  if (entry.permission === null) return true;
  const needed = typeof entry.permission === 'string' ? [entry.permission] : entry.permission;
  return needed.some((permission) => permissions.includes(permission));
}

/**
 * The navigation, in the order it is drawn.
 *
 * The surfaces come from the owner's route inventory; what each one may DO
 * comes from `docs/phase3d-coverage-ledger.md`. Nine of them have no backend at
 * all in this release and are marked `planned` at the page rather than hidden —
 * hiding them would leave an operator wondering whether the product has them,
 * which is the question the maturity vocabulary exists to answer.
 */
/**
 * Exported so a test can drive the paths an operator actually CLICKS.
 *
 * These are hardcoded here and looked up from `PLANNED_SURFACES` in `resolve`,
 * which makes the two independent: a typo in one sends a working navigation
 * link to `NotFound`. A test that reads its path from the same table it
 * checks cannot see that, and the first version of the route test did exactly
 * that — the mutation moved its input and the route table together and
 * survived.
 */
export const NAV: readonly NavEntry[] = [
  {
    id: 'dashboard',
    path: '/',
    label: 'web.nav_overview',
    icon: 'dashboard',
    permission: null,
    group: 'web.navgroup_main',
  },
  {
    id: 'users',
    path: '/users',
    label: 'web.nav_users',
    icon: 'users',
    permission: 'users.view',
    group: 'web.navgroup_sales',
  },
  {
    id: 'services',
    path: '/services',
    label: 'web.nav_services',
    icon: 'services',
    permission: 'services.view',
    group: 'web.navgroup_sales',
  },
  {
    id: 'orders',
    path: '/orders',
    label: 'web.nav_orders',
    icon: 'orders',
    permission: 'orders.view',
    group: 'web.navgroup_sales',
  },
  {
    id: 'products',
    path: '/products',
    label: 'web.nav_products',
    icon: 'products',
    permission: 'catalog.view',
    group: 'web.navgroup_sales',
  },
  {
    id: 'payments',
    path: '/payments',
    label: 'web.nav_payments',
    icon: 'payments',
    permission: 'payments.view',
    group: 'web.navgroup_sales',
  },
  {
    id: 'discounts',
    path: '/discounts',
    label: 'web.nav_discounts',
    icon: 'discounts',
    permission: 'catalog.view',
    group: 'web.navgroup_sales',
  },
  {
    id: 'resellers',
    path: '/resellers',
    label: 'web.nav_resellers',
    icon: 'resellers',
    permission: 'resellers.view',
    group: 'web.navgroup_sales',
  },
  {
    id: 'reports',
    path: '/reports',
    label: 'web.nav_reports',
    icon: 'reports',
    permission: 'reports.view',
    group: 'web.navgroup_sales',
  },
  {
    id: 'panels',
    path: '/panels',
    label: 'web.nav_panels',
    icon: 'panels',
    // EITHER, for the reason `/notifications` carries a list: this page serves
    // the fleet list (`panels.view`) AND the route to the create form
    // (`panels.edit`), and the server authorizes them separately. Gating the
    // entry on the first hid the second — an actor permitted to create a panel
    // had no link to the page the form lives behind, which is the same defect
    // this branch fixed one entry away.
    permission: ['panels.view', 'panels.edit'],
    group: 'web.navgroup_infra',
  },
  {
    id: 'providers',
    path: '/providers',
    label: 'web.nav_providers',
    icon: 'layers',
    // `GET /providers` needs a session and nothing more — it is a catalogue of
    // code, identical for every tenant. Gating it on `panels.view` hid it from
    // an actor holding `panels.edit` alone, who is the actor this release
    // built the create form for, and whose create form fetches this very
    // catalogue and renders it in its picker. Hiding what the server serves is
    // the same defect as offering what it refuses, seen from the other side.
    permission: null,
    group: 'web.navgroup_infra',
  },
  {
    id: 'bots',
    path: '/bots',
    label: 'web.nav_bots',
    icon: 'bots',
    permission: 'settings.view',
    group: 'web.navgroup_infra',
  },
  {
    id: 'content',
    path: '/content',
    label: 'web.nav_templates',
    icon: 'content',
    permission: 'templates.view',
    group: 'web.navgroup_config',
  },
  {
    id: 'settings',
    path: '/settings',
    label: 'web.nav_settings',
    icon: 'settings',
    permission: 'settings.view',
    group: 'web.navgroup_config',
  },
  {
    id: 'features',
    path: '/features',
    label: 'web.nav_features',
    icon: 'zap',
    permission: 'settings.view',
    group: 'web.navgroup_config',
  },
  {
    id: 'alerts',
    path: '/alerts',
    label: 'web.nav_alerts',
    icon: 'bell',
    permission: 'opslog.view',
    group: 'web.navgroup_system',
  },
  {
    id: 'notifications',
    path: '/notifications',
    label: 'web.nav_notifications',
    icon: 'send',
    // EITHER capability. See `NavEntry.permission`.
    permission: ['opslog.view', 'settings.edit'],
    group: 'web.navgroup_system',
  },
  {
    id: 'system',
    path: '/system',
    label: 'web.nav_system',
    icon: 'system',
    permission: null,
    group: 'web.navgroup_system',
  },
];

const GROUP_ORDER: readonly WebKey[] = [
  'web.navgroup_main',
  'web.navgroup_sales',
  'web.navgroup_infra',
  'web.navgroup_config',
  'web.navgroup_system',
];

/**
 * The page for a path, plus the crumb trail that leads to it.
 *
 * One function so the two cannot disagree. A breadcrumb computed separately
 * from the render is a breadcrumb that eventually names a page you are not on.
 */
interface Resolved {
  readonly element: React.ReactNode;
  readonly crumbs: readonly { label: string; href?: string }[];
  readonly title: string;
}

/**
 * The route table, exported so a test can walk it.
 *
 * The planned-surface suite asserted nine component KEYS, never nine PATHS —
 * so a typo in `PLANNED_SURFACES[].path` would have left every one of its
 * eighteen assertions green while the navigation link fell through to
 * `NotFound`. Nothing exercised this function at all.
 */
export function resolve(route: Route, permissions: readonly string[]): Resolved {
  const may = (permission: string | null): boolean =>
    permission === null || permissions.includes(permission);

  const nav = (id: string): { label: string; href: string } => {
    const entry = NAV.find((candidate) => candidate.id === id);
    return { label: entry ? t(entry.label) : id, href: entry ? entry.path : '/' };
  };

  if (route.path === '/') {
    return {
      element: <DashboardPage permissions={permissions} />,
      crumbs: [{ label: t('web.nav_overview') }],
      title: t('web.nav_overview'),
    };
  }

  if (route.path === '/panels') {
    return {
      element: (
        <PanelsPage route={route} mayEdit={may('panels.edit')} denied={!may('panels.view')} />
      ),
      crumbs: [{ label: t('web.nav_panels') }],
      title: t('web.nav_panels'),
    };
  }

  if (route.path === '/panels/new') {
    return {
      element: (
        <NewPanelPage
          denied={!may('panels.edit')}
          // Where they may go afterwards, which is not the same permission as
          // the one that let them fill the form in.
          mayView={may('panels.view')}
          // Initial credentials are a credential write, guarded by the same
          // CRITICAL permission as a rotation. Without this the create form
          // was the way round the boundary the detail page enforces.
          mayRotate={may('panels.credentials.rotate')}
        />
      ),
      crumbs: [nav('panels'), { label: t('web.panel_new') }],
      title: t('web.panel_new'),
    };
  }

  const panel = match('/panels/:id', route.path);
  if (panel !== null) {
    return {
      element: (
        // KEYED BY THE PANEL ID, and that is load-bearing rather than tidy.
        //
        // React reconciles by position and type, so navigating between two
        // panel-detail URLs kept ONE `PanelDetailPage` instance mounted. The
        // query key changes and the heading follows the new panel, but every
        // `useState` initialiser in the subtree ran once, against the old one:
        // `OverviewTab`'s `name`, `baseUrl` and `basis`, the credential draft
        // fields, and the selected tab. Pressing Save then wrote panel B's name
        // onto panel A — a cross-entity write, from a screen that looked
        // entirely normal.
        //
        // It needed both panels cached to be reachable: a pending query renders
        // a skeleton, which unmounts the subtree and hides it. Browser history
        // between two visited panels is exactly that state.
        //
        // The key is the structural fix. Resetting the two fields by hand would
        // leave the credential drafts and the tab, and would have to be
        // remembered by every future piece of per-panel state.
        <PanelDetailPage
          key={panel['id'] ?? ''}
          id={panel['id'] ?? ''}
          mayEdit={may('panels.edit')}
          mayRotate={may('panels.credentials.rotate')}
          denied={!may('panels.view')}
        />
      ),
      crumbs: [nav('panels'), { label: t('web.panel_detail') }],
      title: t('web.panel_detail'),
    };
  }

  if (route.path === '/providers') {
    return {
      element: <ProvidersPage />,
      crumbs: [{ label: t('web.nav_providers') }],
      title: t('web.nav_providers'),
    };
  }

  if (route.path === '/settings') {
    return {
      element: <SettingsPage mayEdit={may('settings.edit')} denied={!may('settings.view')} />,
      crumbs: [{ label: t('web.nav_settings') }],
      title: t('web.nav_settings'),
    };
  }

  if (route.path === '/features') {
    return {
      element: <FeaturesPage mayEdit={may('settings.edit')} denied={!may('settings.view')} />,
      crumbs: [{ label: t('web.nav_features') }],
      title: t('web.nav_features'),
    };
  }

  if (route.path === '/content') {
    return {
      element: <ContentPage mayEdit={may('templates.edit')} denied={!may('templates.view')} />,
      crumbs: [{ label: t('web.nav_templates') }],
      title: t('web.nav_templates'),
    };
  }

  if (route.path === '/alerts') {
    return {
      element: <AlertsPage denied={!may('opslog.view')} />,
      crumbs: [{ label: t('web.nav_alerts') }],
      title: t('web.nav_alerts'),
    };
  }

  if (route.path === '/notifications') {
    return {
      element: <NotificationsPage mayTest={may('settings.edit')} denied={!may('opslog.view')} />,
      crumbs: [{ label: t('web.nav_notifications') }],
      title: t('web.nav_notifications'),
    };
  }

  if (route.path === '/system') {
    return {
      element: <SystemPage route={route} permissions={permissions} />,
      crumbs: [{ label: t('web.nav_system') }],
      title: t('web.nav_system'),
    };
  }

  const planned = PLANNED_SURFACES.find((surface) => surface.path === route.path);
  if (planned !== undefined) {
    return {
      element: <PlannedPage surface={planned.key as PlannedKey} />,
      crumbs: [{ label: t(planned.label) }],
      title: t(planned.label),
    };
  }

  return {
    element: <NotFound />,
    crumbs: [{ label: t('web.not_found_title') }],
    title: t('web.not_found_title'),
  };
}

function NotFound() {
  const onLink = useLinkHandler();
  return (
    <div className="empty">
      <Icon name="alert" size={28} />
      <strong>{t('web.not_found_title')}</strong>
      <p className="muted small">{t('web.not_found_hint')}</p>
      <a className="btn" href="/" onClick={onLink}>
        {t('web.nav_overview')}
      </a>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

/**
 * How often a shell that could not resolve its session tries again.
 *
 * The same lane a failing page poll drops into. A paused installation is the
 * case that matters, and `botctl start` is not an operation anybody expects a
 * screen to notice instantly.
 */
const SESSION_RETRY_MS = 30_000;

export function App() {
  const session = useQuery({
    queryKey: ['session'],
    queryFn: fetchSession,
    retry: false,
    // The shell recovers on its own. See `retryWhileFailing`: without this the
    // "session unavailable" screen below was terminal for an unattended tab,
    // and its Retry button is the very rationalisation this branch established
    // is false wherever nobody is present to press it.
    refetchInterval: retryWhileFailing(SESSION_RETRY_MS),
  });
  const view = sessionView(session);

  if (view === 'loading') return <main className="shell">{t('web.loading')}</main>;

  // A failed LOOKUP is not a signed-out state. `fetchSession` returns null only
  // for a 401, which is the server saying "no session"; anything else — a
  // database outage, a proxy 503, a dropped connection — rejects. Rendering the
  // sign-in form for those told an administrator holding a perfectly good
  // cookie that they were logged out, and invited them to open a second
  // session to fix a problem that was never theirs.
  if (view === 'unavailable') {
    return (
      <main className="shell">
        <p>{t('web.session_unavailable')}</p>
        <button type="button" className="btn" onClick={() => void session.refetch()}>
          {t('web.retry')}
        </button>
      </main>
    );
  }

  return (
    <ToastProvider>
      {session.data ? (
        <SignedIn permissions={session.data.permissions} admin={session.data.admin} />
      ) : (
        <SignIn />
      )}
    </ToastProvider>
  );
}

function SignIn() {
  const client = useQueryClient();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const attempt = useMutation({
    // NEVER retried, whatever the global default is. Sign-in carries no
    // idempotency key and creates a session on every success, so an automatic
    // second attempt spends two of the throttle's allowance for one rejected
    // password, and a success whose response was lost leaves a live session
    // whose token the browser never received.
    retry: false,
    mutationFn: () => signIn(username, password),
    onSuccess: async () => {
      setPassword('');
      await client.invalidateQueries({ queryKey: ['session'] });
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    attempt.mutate();
  };

  return (
    <main className="shell signin">
      <header>
        <h1>{t('web.title')}</h1>
        <p className="subtitle">{t('web.subtitle')}</p>
      </header>

      <form onSubmit={onSubmit}>
        <label htmlFor="username">{t('web.username')}</label>
        <input
          id="username"
          name="username"
          className="input"
          autoComplete="username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          required
        />

        <label htmlFor="password">{t('web.password')}</label>
        <input
          id="password"
          name="password"
          type="password"
          className="input"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />

        <button type="submit" className="btn primary" disabled={attempt.isPending}>
          {attempt.isPending ? t('web.signing_in') : t('web.sign_in')}
        </button>

        {attempt.isError && <p className="error">{messageFor(attempt.error)}</p>}
      </form>
    </main>
  );
}

/**
 * One message for every credential failure.
 *
 * The server already refuses to distinguish an unknown username from a wrong
 * password; rendering the server's own text per case would be a way to undo
 * that here. Only rate limiting reads differently, because telling somebody to
 * come back later is not information about an account.
 */
function messageFor(error: unknown): string {
  if (error instanceof ApiError && error.code === 'auth.rate_limited') return t('web.rate_limited');
  return t('web.sign_in_failed');
}

function SignedIn({
  admin,
  permissions,
}: {
  admin: { username: string; displayName: string; roleKeys: string[] };
  permissions: string[];
}) {
  const route = useRoute();
  const onLink = useLinkHandler();
  const client = useQueryClient();
  const { choice, setChoice } = useTheme();

  // Collapsed below 980px, where a 248px sidebar is a third of the viewport.
  /**
   * The width decides, until the operator does — and then the operator does.
   *
   * The comment here used to say the state was "owned by the operator", while
   * the listener below overwrote their choice on every crossing of the
   * breakpoint: expand the sidebar at 900px, drag the window to 1000px and
   * back, and it re-collapsed. The comment was true only of resizes that never
   * crossed 980px, which is the least interesting case.
   *
   * `touched` is what makes it true. Before the operator has expressed a
   * preference the viewport is the best guess available; afterwards it is not
   * a guess any more, and nothing overrides it for the life of the session.
   */
  const [collapsed, setCollapsed] = useState(() => window.innerWidth < 980);
  const touched = useRef(false);
  const choose = (next: boolean) => {
    touched.current = true;
    setCollapsed(next);
  };
  useEffect(() => {
    const query = window.matchMedia('(max-width: 980px)');
    const onChange = (event: MediaQueryListEvent) => {
      if (!touched.current) setCollapsed(event.matches);
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const resolved = resolve(route, permissions);
  useDocumentTitle(`${resolved.title} — ${t('web.title')}`);

  const leave = useMutation({
    // Same reasoning as sign-in: no idempotency key, and a session action.
    retry: false,
    mutationFn: signOut,
    onSuccess: async () => {
      navigate('/');
      await client.invalidateQueries({ queryKey: ['session'] });
    },
  });

  const visible = NAV.filter((entry) => navPermitted(entry, permissions));

  return (
    <div className={`app ${collapsed ? 'collapsed' : ''}`}>
      <a className="skip" href="#main">
        {t('web.skip_to_content')}
      </a>

      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            N
          </span>
          <span className="brand-text">
            <strong>{t('web.title')}</strong>
            <span>{t('web.subtitle')}</span>
          </span>
        </div>

        <nav className="nav" aria-label={t('web.nav_label')}>
          {GROUP_ORDER.map((group) => {
            const entries = visible.filter((entry) => entry.group === group);
            if (entries.length === 0) return null;
            return (
              <div className="nav-group" key={group}>
                <div className="nav-group-label">{t(group)}</div>
                {entries.map((entry) => (
                  <a
                    key={entry.id}
                    href={entry.path}
                    onClick={onLink}
                    aria-current={isCurrent(entry.path, route.path) ? 'page' : undefined}
                    title={collapsed ? t(entry.label) : undefined}
                  >
                    <Icon name={entry.icon} size={17} className="ico" />
                    <span className="lbl">{t(entry.label)}</span>
                  </a>
                ))}
              </div>
            );
          })}
        </nav>

        <div className="sidebar-foot">
          <button
            type="button"
            className="btn ghost icon sm"
            aria-label={t('web.toggle_sidebar')}
            aria-expanded={!collapsed}
            onClick={() => choose(!collapsed)}
          >
            <Icon name="sidebar" size={15} />
          </button>
          <button
            type="button"
            className="btn ghost icon sm"
            aria-label={t('web.sign_out')}
            onClick={() => leave.mutate()}
          >
            <Icon name="logout" size={15} />
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <nav className="crumbs" aria-label={t('web.breadcrumbs')}>
            {resolved.crumbs.map((crumb, index) => (
              <span key={`${crumb.label}-${index}`}>
                {index > 0 && (
                  <span className="sep" aria-hidden="true">
                    /
                  </span>
                )}
                {crumb.href === undefined ? (
                  <span className="cur" aria-current="page">
                    {crumb.label}
                  </span>
                ) : (
                  <a href={crumb.href} onClick={onLink}>
                    {crumb.label}
                  </a>
                )}
              </span>
            ))}
          </nav>

          <span className="spacer" />

          <label className="visually-hidden" htmlFor="theme-choice">
            {t('web.theme')}
          </label>
          <select
            id="theme-choice"
            className="input sm"
            value={choice}
            onChange={(event) => setChoice(event.target.value as ThemeChoice)}
          >
            <option value="system">{t('web.theme_system')}</option>
            <option value="dark">{t('web.theme_dark')}</option>
            <option value="light">{t('web.theme_light')}</option>
          </select>

          <span className="muted small nowrap">
            {admin.displayName}
            <span className="faint"> · {admin.roleKeys.join(t('web.list_separator')) || '—'}</span>
          </span>
        </header>

        <main className="content" id="main">
          <div className="content-inner">{resolved.element}</div>
        </main>
      </div>
    </div>
  );
}

/**
 * Whether a nav entry owns the current path.
 *
 * `/panels` must light up on `/panels/abc` but `/` must not light up on
 * everything — which is what a bare `startsWith` does, and why the root is a
 * separate case rather than a shorter prefix.
 */
export function isCurrent(entryPath: string, currentPath: string): boolean {
  if (entryPath === '/') return currentPath === '/';
  return currentPath === entryPath || currentPath.startsWith(`${entryPath}/`);
}
