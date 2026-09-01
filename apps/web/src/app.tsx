import { useQuery } from '@tanstack/react-query';
import { fetchInfo, fetchReadiness } from './api/client';
import { t } from './i18n/web.fa';

/**
 * The Phase 0 admin shell.
 *
 * One screen, and it does something real: it renders live readiness from the
 * API, parsed through the shared contract schemas. There is no fake login, no
 * placeholder dashboard and no navigation to pages that do not exist.
 */
export function App() {
  const readiness = useQuery({
    queryKey: ['readiness'],
    queryFn: fetchReadiness,
    refetchInterval: 5000,
  });
  const info = useQuery({ queryKey: ['info'], queryFn: fetchInfo });

  return (
    <main className="shell">
      <header>
        <h1>{t('web.title')}</h1>
        <p className="subtitle">{t('web.subtitle')}</p>
      </header>

      <p className="notice">{t('web.auth_notice')}</p>

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
    </main>
  );
}
