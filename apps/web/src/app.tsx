import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  fetchAdmins,
  fetchInfo,
  fetchReadiness,
  fetchSession,
  signIn,
  signOut,
} from './api/client';
import type { SessionResponse } from '@nexa/contracts';
import { t, type WebKey } from './i18n/web.fa';
import { SettingsPage } from './pages/settings';
import { FeaturesPage } from './pages/features';
import { TemplatesPage } from './pages/templates';
import { NotificationsPage, OperationsPage } from './pages/operations';

/**
 * The Phase 1 admin shell.
 *
 * Still one screen, and still nothing fake: it signs in against the real
 * endpoint, renders who is signed in, and shows the administrator list when the
 * session actually carries `admins.view`.
 *
 * The permission list is used to decide what to DRAW. It is never used to
 * decide what is allowed — the server re-checks every call, and this component
 * would be just as safe if it drew everything.
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

export function App() {
  const session = useQuery({ queryKey: ['session'], queryFn: fetchSession, retry: false });

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
        <button type="button" onClick={() => void session.refetch()}>
          {t('web.retry')}
        </button>
      </main>
    );
  }

  return session.data ? (
    <SignedIn permissions={session.data.permissions} admin={session.data.admin} />
  ) : (
    <SignIn />
  );
}

function SignIn() {
  const client = useQueryClient();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const attempt = useMutation({
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
    <main className="shell">
      <header>
        <h1>{t('web.title')}</h1>
        <p className="subtitle">{t('web.subtitle')}</p>
      </header>

      <form onSubmit={onSubmit}>
        <label htmlFor="username">{t('web.username')}</label>
        <input
          id="username"
          name="username"
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
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />

        <button type="submit" disabled={attempt.isPending}>
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

/**
 * The sections of the admin.
 *
 * `permission` decides what is DRAWN. It never decides what is allowed: every
 * endpoint behind these screens re-checks on the server, and this component
 * would be exactly as safe if it drew all of them. In the legacy system
 * "enforcement" may well have meant nothing more than menu hiding
 * (`UNK-ADM-001`).
 */
const SECTIONS = [
  { id: 'overview', label: 'web.nav_overview', permission: null },
  { id: 'settings', label: 'web.nav_settings', permission: 'settings.view' },
  { id: 'features', label: 'web.nav_features', permission: 'settings.view' },
  { id: 'templates', label: 'web.nav_templates', permission: 'templates.view' },
  { id: 'operations', label: 'web.nav_operations', permission: 'opslog.view' },
  { id: 'notifications', label: 'web.nav_notifications', permission: 'opslog.view' },
] as const satisfies readonly {
  id: string;
  label: WebKey;
  permission: string | null;
}[];

type SectionId = (typeof SECTIONS)[number]['id'];

function SignedIn({
  admin,
  permissions,
}: {
  admin: { username: string; displayName: string; roleKeys: string[] };
  permissions: string[];
}) {
  const [section, setSection] = useState<SectionId>('overview');
  const visible = SECTIONS.filter(
    (entry) => entry.permission === null || permissions.includes(entry.permission),
  );
  const client = useQueryClient();
  const readiness = useQuery({
    queryKey: ['readiness'],
    queryFn: fetchReadiness,
    refetchInterval: 5000,
  });
  const info = useQuery({ queryKey: ['info'], queryFn: fetchInfo });

  // Drawn only when the session carries the permission. The endpoint checks it
  // again regardless: hiding a table is not authorization.
  const mayListAdmins = permissions.includes('admins.view');
  const admins = useQuery({
    queryKey: ['admins'],
    queryFn: fetchAdmins,
    enabled: mayListAdmins,
  });

  const leave = useMutation({
    mutationFn: signOut,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['session'] });
    },
  });

  return (
    <main className="shell">
      <header>
        <h1>{t('web.title')}</h1>
        <p className="subtitle">
          {t('web.signed_in_as')} {admin.displayName} ({admin.username}) — {t('web.roles')}:{' '}
          {admin.roleKeys.join(t('web.list_separator')) || '—'}
        </p>
        <button type="button" onClick={() => leave.mutate()}>
          {t('web.sign_out')}
        </button>
      </header>

      <nav className="tabs">
        {visible.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={entry.id === section ? 'active' : undefined}
            // Which tab is current, for a screen reader. The `active` class
            // says it visually and says nothing at all to anybody using one.
            aria-current={entry.id === section ? 'page' : undefined}
            onClick={() => setSection(entry.id)}
          >
            {t(entry.label)}
          </button>
        ))}
      </nav>

      {section === 'settings' && <SettingsPage mayEdit={permissions.includes('settings.edit')} />}
      {section === 'features' && <FeaturesPage mayEdit={permissions.includes('settings.edit')} />}
      {section === 'templates' && (
        <TemplatesPage mayEdit={permissions.includes('templates.edit')} />
      )}
      {section === 'operations' && <OperationsPage />}
      {section === 'notifications' && (
        <NotificationsPage mayTest={permissions.includes('settings.edit')} />
      )}

      {section === 'overview' && (
        <>
          <section>
            <h2>{t('web.administrators')}</h2>
            {!mayListAdmins && <p className="notice">{t('web.no_permission')}</p>}
            {mayListAdmins && admins.data && (
              <table>
                <thead>
                  <tr>
                    <th>{t('web.username')}</th>
                    <th>{t('web.status')}</th>
                    <th>{t('web.roles')}</th>
                  </tr>
                </thead>
                <tbody>
                  {admins.data.admins.map((row) => (
                    <tr key={row.id}>
                      <td>{row.username}</td>
                      <td className={row.status === 'ACTIVE' ? 'up' : 'down'}>
                        {row.status === 'ACTIVE' ? t('web.up') : t('web.down')}
                      </td>
                      <td>{row.roleKeys.join(t('web.list_separator')) || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section>
            <h2>{t('web.system_status')}</h2>
            {readiness.isPending && <p>{t('web.loading')}</p>}
            {readiness.isError && <p className="error">{t('web.error')}</p>}
            {readiness.data && (
              <table>
                <thead>
                  <tr>
                    <th>{t('web.dependency')}</th>
                    <th>{t('web.status')}</th>
                    <th>{t('web.latency')}</th>
                    <th>{t('web.detail')}</th>
                  </tr>
                </thead>
                <tbody>
                  {readiness.data.dependencies.map((dependency) => (
                    <tr key={dependency.name}>
                      <td>{dependency.name}</td>
                      <td className={dependency.status === 'up' ? 'up' : 'down'}>
                        {dependency.status === 'up' ? t('web.up') : t('web.down')}
                      </td>
                      <td>{dependency.latencyMs ?? '—'}</td>
                      <td>{dependency.detail ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section>
            <h2>{t('web.build_info')}</h2>
            {info.data && (
              <dl>
                <dt>{t('web.version')}</dt>
                <dd>{info.data.version}</dd>
                <dt>{t('web.commit')}</dt>
                <dd>{info.data.commit}</dd>
                <dt>{t('web.environment')}</dt>
                <dd>{info.data.environment}</dd>
              </dl>
            )}
          </section>
        </>
      )}
    </main>
  );
}
