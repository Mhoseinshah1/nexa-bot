import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FX_SOURCE_ENABLED_SETTINGS,
  type FxRefreshResponse,
  type FxSource,
  type FxStatusResponse,
} from '@nexa/contracts';
import { fetchFxStatus, fetchSettings, refreshFx, saveSetting } from '../api/client';
import { errorCodeLabel } from '../ops-code-labels';
import { errorText } from '../error-text';
import { useSubmissionKey } from '../submission-key';
import { currencyLabel, formatDecimalText, formatNumber, formatTimestamp } from '../format';
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
  Switch,
  useToast,
  type Column,
  Num,
} from '../ui/kit';
import { Icon } from '../ui/icons';
import { ErrorCodeLabel, ErrorRef } from '../ui/technical-details';

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
  TABDEAL: 'web.fx_source_tabdeal',
  BITPIN: 'web.fx_source_bitpin',
  RAMZINEX: 'web.fx_source_ramzinex',
};

/** A span of seconds as the coarsest whole unit that holds it: seconds, minutes or hours. */
export function formatAge(seconds: number): string {
  if (seconds >= 3_600)
    return `${formatNumber(Math.round(seconds / 3_600))} ${t('web.unit_hours')}`;
  if (seconds >= 120) return `${formatNumber(Math.round(seconds / 60))} ${t('web.unit_minutes')}`;
  return `${formatNumber(seconds)} ${t('web.unit_seconds')}`;
}

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

/**
 * A source's last error, in Persian. The service records `<source>.<kind>` for a transport
 * or parse failure (`nobitex.http_403`, `wallex.timeout`) and a bare verdict for a figure
 * it refused (`outlier`, `disagrees`); both are named here, and anything else falls back to
 * the shared code labels, then to the raw code. Never a body, never a URL.
 */
const SOURCE_ERROR_LABELS: Readonly<Record<string, WebKey>> = {
  timeout: 'web.fx_err_timeout',
  unreachable: 'web.fx_err_unreachable',
  tls_failed: 'web.fx_err_tls_failed',
  blocked_target: 'web.fx_err_blocked_target',
  malformed_response: 'web.fx_err_malformed_response',
  rate_limited: 'web.fx_err_rate_limited',
  not_positive: 'web.fx_err_not_positive',
  out_of_rails: 'web.fx_err_out_of_rails',
  outlier: 'web.fx_err_outlier',
  disagrees: 'web.fx_err_disagrees',
  outside_band: 'web.fx_err_outside_band',
  no_market: 'web.fx_err_no_market',
  bad_price: 'web.fx_err_bad_price',
  not_json: 'web.fx_err_not_json',
};

export function fxSourceErrorLabel(code: string): string {
  const kind = code.slice(code.lastIndexOf('.') + 1);
  const http = /^http_([0-9]{3})$/u.exec(kind);
  if (http !== null) {
    return http[1] === '403'
      ? t('web.fx_err_http_403')
      : t('web.fx_err_http').replace('{status}', http[1] ?? '');
  }
  const known = SOURCE_ERROR_LABELS[kind];
  return known === undefined ? errorCodeLabel(code) : t(known);
}

/**
 * One source's on/off switch: the registry setting `fx.source_<name>_enabled`, written
 * through the ordinary settings write (version, idempotency key, audit) — so this adds no
 * write path of its own. A disabled source is never called by the service.
 */
function SourceSwitch({ source, mayEdit }: { source: FxSource; mayEdit: boolean }) {
  const queries = useQueryClient();
  const submission = useSubmissionKey();
  const settingKey = FX_SOURCE_ENABLED_SETTINGS[source];
  const settings = useQuery({ queryKey: ['settings'], queryFn: fetchSettings, enabled: mayEdit });
  const row = settings.data?.settings.find((entry) => entry.key === settingKey);
  const save = useMutation({
    mutationFn: (command: {
      key: string;
      value: boolean;
      expectedVersion: number | null;
      idempotencyKey: string;
    }) => saveSetting(command),
    onSuccess: () => submission.settle(),
    onError: (error) => submission.settleOn(error),
    onSettled: () =>
      Promise.all([
        queries.invalidateQueries({ queryKey: ['settings'] }),
        queries.invalidateQueries({ queryKey: ['fx-status'] }),
      ]),
  });
  const checked = row?.value === true;
  return (
    <>
      <Switch
        checked={checked}
        label={`${t('web.fx_source_switch')} ${t(SOURCE_LABELS[source])}`}
        disabled={!mayEdit || row === undefined || save.isPending}
        onChange={(next) => {
          if (row === undefined) return;
          const command = { key: row.key, value: next, expectedVersion: row.version };
          save.mutate({ ...command, idempotencyKey: submission.current(command) });
        }}
      />
      {save.error !== null && (
        <Banner tone="danger">
          {errorText(save.error)}
          <ErrorRef error={save.error} />
        </Banner>
      )}
    </>
  );
}

export function FxSection({
  denied,
  mayEdit,
  maySettingsEdit = false,
}: {
  denied: boolean;
  mayEdit: boolean;
  /** `settings.view` and `settings.edit`: the per-source switches are registry settings. */
  maySettingsEdit?: boolean;
}) {
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
      key: 'enabled',
      header: t('web.fx_source_switch'),
      render: (row) =>
        maySettingsEdit ? (
          <SourceSwitch source={row.source} mayEdit />
        ) : (
          <Badge tone={row.enabled ? 'ok' : 'neutral'}>
            {t(row.enabled ? 'web.fx_enabled_on' : 'web.fx_enabled_off')}
          </Badge>
        ),
    },
    {
      key: 'success',
      header: t('web.fx_source_last_success'),
      render: (row) => (row.lastSuccessAt === null ? '—' : formatTimestamp(row.lastSuccessAt)),
    },
    {
      key: 'failures',
      header: t('web.fx_source_failures'),
      render: (row) => formatNumber(row.consecutiveFailures),
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
                <span data-testid={`fx-error-${row.source}`}>
                  {fxSourceErrorLabel(row.lastFailureCode)}
                </span>{' '}
                <ErrorCodeLabel code={row.lastFailureCode} />
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
          {refresh.error != null && (
            <Banner tone="danger">
              {messageFor(refresh.error)}
              <ErrorRef error={refresh.error} />
            </Banner>
          )}

          {/* The four facts an operator looks for first — every one a field of the answer. */}
          <div className="stat-grid fx-strip" data-testid="fx-strip">
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
                  <Num value={formatDecimalText(status.data.quote.rate)} />
                )
              }
              {...(status.data.quote === null
                ? {}
                : { unit: currencyLabel(status.data.quoteCurrency) })}
            />
            <Stat
              label={t('web.fx_age')}
              value={status.data.quote === null ? '—' : formatAge(status.data.quote.ageSeconds)}
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

          {status.data.enabled &&
            status.data.state === 'STALE_ALLOWED' &&
            status.data.quote !== null && (
              <Banner tone="warn">
                {t('web.fx_stale_banner')
                  .replace('{age}', formatAge(status.data.quote.ageSeconds))
                  .replace('{limit}', formatAge(status.data.maxStaleSeconds))}
              </Banner>
            )}
          {status.data.enabled && status.data.state === 'UNAVAILABLE' && (
            <Banner tone="danger">{t('web.fx_unavailable_banner')}</Banner>
          )}

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
                  [t('web.fx_min_agreeing'), formatNumber(status.data.minAgreeingSources)],
                  [
                    t('web.fx_accept_single'),
                    <Badge key="as" tone={status.data.acceptSingleSource ? 'warn' : 'neutral'}>
                      {t(
                        status.data.acceptSingleSource ? 'web.fx_enabled_on' : 'web.fx_enabled_off',
                      )}
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
                  [t('web.fx_max_stale'), formatAge(status.data.maxStaleSeconds)],
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
                  // Spec §8: Stars are always priced by the central rate; there is no mode.
                  [t('web.fx_stars_mode'), t('web.fx_stars_mode_central')],
                  [
                    t('web.fx_stars_ratio'),
                    status.data.stars.starsPerUsdt === '' ? (
                      <span key="ra" className="muted">
                        {t('web.fx_stars_ratio_unset')}
                      </span>
                    ) : (
                      <Num key="ra" value={formatDecimalText(status.data.stars.starsPerUsdt)} />
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
                        <Num value={formatDecimalText(status.data.stars.centralRatePerStar)} />{' '}
                        {currencyLabel(status.data.quoteCurrency)}
                      </span>
                    ),
                  ],
                ]}
              />
            </div>
          </div>

          <h3 className="fx-subhead">{t('web.fx_sources_title')}</h3>
          <DataTable
            stack
            columns={sourceColumns}
            rows={status.data.sources}
            rowKey={(row) => row.source}
            caption={t('web.fx_sources_title')}
            dense
          />

          {/*
            The identifiers somebody debugging a price needs, and nobody else: behind a
            disclosure so the normal view carries no raw key.
          */}
          <Disclosure
            size="sm"
            variant="boxed"
            className="fx-technical"
            summary={t('web.fx_technical')}
          >
            <KV
              items={[
                [
                  t('web.fx_last_error'),
                  status.data.lastErrorCode === null ? (
                    '—'
                  ) : (
                    <ErrorCodeLabel key="le" code={status.data.lastErrorCode} />
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
