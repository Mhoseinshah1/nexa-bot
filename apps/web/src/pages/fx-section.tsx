import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FxRefreshResponse, FxSource, FxStatusResponse } from '@nexa/contracts';
import { fetchFxStatus, refreshFx } from '../api/client';
import { currencyLabel, formatNumber, formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { messageFor } from './settings';
import {
  Badge,
  Banner,
  Card,
  DataTable,
  KV,
  Ltr,
  StateSwitch,
  useToast,
  type Column,
} from '../ui/kit';

/**
 * The FX section of the payment routes page (package FX, brief "Web Admin").
 *
 * Read-only facts and one button. What an operator SETS — the sources, the two windows,
 * the Stars mode and ratio — lives on the settings page under «نرخ ارز», and the feature
 * switch on the features page; this card says where. Every figure arrives as a decimal
 * string and is shown as one: nothing here computes a rate.
 *
 * The refresh button is the operator's test of the sources: it dials the primary and then
 * the fallback now, and the toast says which answered. It never changes a setting.
 */

const SOURCE_LABELS: Readonly<Record<FxSource, WebKey>> = {
  NOBITEX: 'web.fx_source_nobitex',
  WALLEX: 'web.fx_source_wallex',
};

function sourceLabel(source: FxSource | 'NONE'): string {
  return t(source === 'NONE' ? 'web.fx_source_none' : SOURCE_LABELS[source]);
}

const STATE_LABELS: Readonly<Record<FxStatusResponse['state'], WebKey>> = {
  FRESH: 'web.fx_state_fresh',
  STALE_ALLOWED: 'web.fx_state_stale',
  UNAVAILABLE: 'web.fx_state_unavailable',
};

const REFRESH_MESSAGES: Readonly<Record<FxRefreshResponse['outcome'], WebKey>> = {
  REFRESHED: 'web.fx_refresh_done',
  REFRESHED_BY_FALLBACK: 'web.fx_refresh_fallback',
  FAILED: 'web.fx_refresh_failed',
  DISABLED: 'web.fx_refresh_disabled',
  BUSY: 'web.fx_refresh_busy',
};

export function stateTone(state: FxStatusResponse['state']): 'ok' | 'warn' | 'danger' {
  if (state === 'FRESH') return 'ok';
  if (state === 'STALE_ALLOWED') return 'warn';
  return 'danger';
}

export function FxSection({ denied, mayEdit }: { denied: boolean; mayEdit: boolean }) {
  const queries = useQueryClient();
  const notify = useToast();
  const status = useQuery({
    queryKey: ['fx-status'],
    queryFn: () => fetchFxStatus(),
    enabled: !denied,
  });
  const refresh = useMutation({
    mutationFn: () => refreshFx(),
    onSuccess: (result) => {
      queries.setQueryData(['fx-status'], result.status);
      notify({
        tone:
          result.outcome === 'FAILED' ? 'danger' : result.outcome === 'REFRESHED' ? 'ok' : 'warn',
        message: t(REFRESH_MESSAGES[result.outcome]),
      });
    },
  });

  const sourceColumns: readonly Column<FxStatusResponse['sources'][number]>[] = [
    { key: 'source', header: t('web.fx_source_column'), render: (row) => sourceLabel(row.source) },
    {
      key: 'success',
      header: t('web.fx_source_last_success'),
      render: (row) => (row.lastSuccessAt === null ? '—' : formatTimestamp(row.lastSuccessAt)),
    },
    {
      key: 'failure',
      header: t('web.fx_source_last_failure'),
      render: (row) =>
        row.lastFailureAt === null ? (
          '—'
        ) : (
          <>
            {formatTimestamp(row.lastFailureAt)}
            {row.lastFailureCode === null ? null : (
              <>
                {' '}
                <Ltr>{row.lastFailureCode}</Ltr>
              </>
            )}
          </>
        ),
    },
    {
      key: 'retry',
      header: t('web.fx_source_retry_after'),
      render: (row) => (row.retryAfter === null ? '—' : formatTimestamp(row.retryAfter)),
    },
    {
      key: 'failures',
      header: t('web.fx_source_failures'),
      render: (row) => formatNumber(row.consecutiveFailures),
    },
  ];

  return (
    <StateSwitch query={status} denied={denied}>
      {status.data !== undefined && (
        <Card
          title={t('web.fx_section_title')}
          hint={t('web.fx_section_hint')}
          actions={
            mayEdit ? (
              <button
                type="button"
                className="btn sm"
                disabled={refresh.isPending}
                onClick={() => refresh.mutate()}
              >
                {t('web.fx_refresh')}
              </button>
            ) : undefined
          }
        >
          <KV
            items={[
              [
                t('web.fx_enabled'),
                <Badge key="en" tone={status.data.enabled ? 'ok' : 'neutral'}>
                  {t(status.data.enabled ? 'web.fx_enabled_on' : 'web.fx_enabled_off')}
                </Badge>,
              ],
              [t('web.fx_primary_source'), sourceLabel(status.data.primarySource)],
              [t('web.fx_fallback_source'), sourceLabel(status.data.fallbackSource)],
              [
                t('web.fx_state'),
                <Badge key="st" tone={stateTone(status.data.state)}>
                  {t(STATE_LABELS[status.data.state])}
                </Badge>,
              ],
              [
                t('web.fx_current_rate'),
                status.data.quote === null ? (
                  <span key="rt" className="muted">
                    {t('web.fx_no_quote')}
                  </span>
                ) : (
                  <span key="rt">
                    <Ltr>{status.data.quote.rate}</Ltr> {currencyLabel(status.data.quoteCurrency)}
                  </span>
                ),
              ],
              [
                t('web.fx_current_source'),
                status.data.quote === null ? '—' : sourceLabel(status.data.quote.source),
              ],
              [
                t('web.fx_last_refresh'),
                status.data.quote === null ? '—' : formatTimestamp(status.data.quote.fetchedAt),
              ],
              [
                t('web.fx_source_time'),
                status.data.quote?.sourceAt === null || status.data.quote === null
                  ? '—'
                  : formatTimestamp(status.data.quote.sourceAt),
              ],
              [
                t('web.fx_age'),
                status.data.quote === null
                  ? '—'
                  : `${formatNumber(status.data.quote.ageSeconds)} ${t('web.unit_seconds')}`,
              ],
              [
                t('web.fx_ttl'),
                `${formatNumber(status.data.freshTtlSeconds)} ${t('web.unit_seconds')}`,
              ],
              [
                t('web.fx_max_stale'),
                `${formatNumber(status.data.maxStaleSeconds)} ${t('web.unit_seconds')}`,
              ],
              [
                t('web.fx_last_attempt'),
                status.data.lastAttemptAt === null
                  ? '—'
                  : formatTimestamp(status.data.lastAttemptAt),
              ],
              [
                t('web.fx_last_error'),
                status.data.lastErrorCode === null ? (
                  '—'
                ) : (
                  <Ltr key="le">{status.data.lastErrorCode}</Ltr>
                ),
              ],
              [
                t('web.fx_quote_id'),
                status.data.quote === null ? '—' : <Ltr key="qi">{status.data.quote.quoteId}</Ltr>,
              ],
              [t('web.fx_policy_version'), <Ltr key="pv">{String(status.data.policyVersion)}</Ltr>],
            ]}
          />

          <h3>{t('web.fx_stars_title')}</h3>
          <KV
            items={[
              [
                t('web.fx_stars_mode'),
                t(
                  status.data.stars.pricingMode === 'CENTRAL_FX_RATIO'
                    ? 'web.fx_stars_mode_central'
                    : 'web.fx_stars_mode_fixed',
                ),
              ],
              [
                t('web.fx_stars_ratio'),
                status.data.stars.starsPerUsdt === '' ? (
                  <span key="ra" className="muted">
                    {t('web.fx_stars_ratio_unset')}
                  </span>
                ) : (
                  <Ltr key="ra">{status.data.stars.starsPerUsdt}</Ltr>
                ),
              ],
              [
                t('web.fx_stars_fixed_rate'),
                status.data.stars.fixedRateMinor === null ? (
                  '—'
                ) : (
                  <span key="fr">
                    <Ltr>{status.data.stars.fixedRateMinor}</Ltr>{' '}
                    {currencyLabel(status.data.quoteCurrency)}
                  </span>
                ),
              ],
              [
                t('web.fx_stars_central_rate'),
                status.data.stars.centralRatePerStar === null ? (
                  <span key="cr" className="muted">
                    {t('web.fx_stars_central_rate_none')}
                  </span>
                ) : (
                  <span key="cr">
                    <Ltr>{status.data.stars.centralRatePerStar}</Ltr>{' '}
                    {currencyLabel(status.data.quoteCurrency)}
                  </span>
                ),
              ],
            ]}
          />

          <h3>{t('web.fx_sources_title')}</h3>
          {status.data.sources.length === 0 ? (
            <p className="muted small">{t('web.fx_sources_none')}</p>
          ) : (
            <DataTable
              columns={sourceColumns}
              rows={status.data.sources}
              rowKey={(row) => row.source}
              caption={t('web.fx_sources_title')}
            />
          )}

          <p className="muted small">{t('web.fx_settings_link')}</p>
          {refresh.error != null && <Banner tone="danger">{messageFor(refresh.error)}</Banner>}
        </Card>
      )}
    </StateSwitch>
  );
}
