import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FxRefreshResponse, FxSource, FxStatusResponse } from '@nexa/contracts';
import { fetchFxStatus, refreshFx } from '../api/client';
import { currencyLabel, formatNumber, formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { messageFor } from './settings';
import {
  Disclosure,
  Badge,
  Banner,
  Card,
  DataTable,
  KV,
  Ltr,
  Stat,
  StateSwitch,
  useToast,
  type Column,
  Num,
} from '../ui/kit';
import { Icon } from '../ui/icons';

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
                <Icon name="refresh" />
                {t('web.fx_refresh')}
              </button>
            ) : undefined
          }
        >
          {refresh.error != null && <Banner tone="danger">{messageFor(refresh.error)}</Banner>}

          {/* The four facts an operator looks for first — every one a field of the answer. */}
          <div className="fx-strip" data-testid="fx-strip">
            <Stat
              label={t('web.fx_state')}
              value={
                <Badge tone={stateTone(status.data.state)} dot>
                  {t(STATE_LABELS[status.data.state])}
                </Badge>
              }
            />
            <Stat
              label={t('web.fx_current_rate')}
              value={
                status.data.quote === null ? (
                  <span className="muted small">{t('web.fx_no_quote')}</span>
                ) : (
                  <Num value={status.data.quote.rate} />
                )
              }
              {...(status.data.quote === null
                ? {}
                : { unit: currencyLabel(status.data.quoteCurrency) })}
            />
            <Stat
              label={t('web.fx_age')}
              value={status.data.quote === null ? '—' : formatNumber(status.data.quote.ageSeconds)}
              {...(status.data.quote === null ? {} : { unit: t('web.unit_seconds') })}
            />
            <Stat
              label={t('web.fx_last_refresh')}
              value={
                <span className="small">
                  {status.data.quote === null ? '—' : formatTimestamp(status.data.quote.fetchedAt)}
                </span>
              }
            />
          </div>

          <div className="grid-2">
            <div>
              <h3 className="fx-subhead">{t('web.fx_sources_policy_title')}</h3>
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
                    t('web.fx_current_source'),
                    status.data.quote === null ? '—' : sourceLabel(status.data.quote.source),
                  ],
                  [
                    t('web.fx_source_time'),
                    status.data.quote?.sourceAt === null || status.data.quote === null
                      ? '—'
                      : formatTimestamp(status.data.quote.sourceAt),
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
                ]}
              />
            </div>
            <div>
              <h3 className="fx-subhead">{t('web.fx_stars_title')}</h3>
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
                      <Num key="ra" value={status.data.stars.starsPerUsdt} />
                    ),
                  ],
                  [
                    t('web.fx_stars_fixed_rate'),
                    status.data.stars.fixedRateMinor === null ? (
                      '—'
                    ) : (
                      <span key="fr">
                        <Num value={status.data.stars.fixedRateMinor} />{' '}
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
                        <Num value={status.data.stars.centralRatePerStar} />{' '}
                        {currencyLabel(status.data.quoteCurrency)}
                      </span>
                    ),
                  ],
                ]}
              />
            </div>
          </div>

          <h3 className="fx-subhead">{t('web.fx_sources_title')}</h3>
          {status.data.sources.length === 0 ? (
            <p className="muted small">{t('web.fx_sources_none')}</p>
          ) : (
            <DataTable
              columns={sourceColumns}
              rows={status.data.sources}
              rowKey={(row) => row.source}
              caption={t('web.fx_sources_title')}
              dense
            />
          )}

          {/*
            The identifiers somebody debugging a price needs, and nobody else: behind a
            disclosure so the normal view carries no raw key.
          */}
          <Disclosure size="sm" className="fx-technical" summary={t('web.fx_technical')}>
            <KV
              items={[
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
                  status.data.quote === null ? (
                    '—'
                  ) : (
                    <Ltr key="qi">{status.data.quote.quoteId}</Ltr>
                  ),
                ],
                [
                  t('web.fx_policy_version'),
                  <Ltr key="pv">{String(status.data.policyVersion)}</Ltr>,
                ],
              ]}
            />
          </Disclosure>

          <p className="muted small">{t('web.fx_settings_link')}</p>
        </Card>
      )}
    </StateSwitch>
  );
}
