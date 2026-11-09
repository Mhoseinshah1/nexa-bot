import {
  DATA_EXPORT_ERROR_CODES,
  type DataExportState,
  type DataExportView,
} from '@nexa/contracts';
import { formatTimestamp, splitBytes } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { Badge, Banner, Empty, KV, type Tone } from '../ui/kit';

/**
 * The pieces the two doors of the data export share (phase 6B PR-3): the list of exports and
 * what each state says. «خروجی داده» in the hosted bot's own Web Admin and the card inside
 * «میزبانی‌ها» draw the same list; only the way a request is made differs.
 */

const STATE: Readonly<Record<DataExportState, { label: WebKey; tone: Tone }>> = {
  REQUESTED: { label: 'web.data_export_state_requested', tone: 'info' },
  RUNNING: { label: 'web.data_export_state_running', tone: 'info' },
  READY: { label: 'web.data_export_state_ready', tone: 'ok' },
  FAILED: { label: 'web.data_export_state_failed', tone: 'danger' },
  EXPIRED: { label: 'web.data_export_state_expired', tone: 'neutral' },
};

/** Whether the list should keep polling: something is still being made. */
export function hasActiveExport(exports: readonly DataExportView[] | undefined): boolean {
  return exports?.some((row) => row.state === 'REQUESTED' || row.state === 'RUNNING') ?? false;
}

function sizeText(bytes: number): string {
  const { value, unit } = splitBytes(BigInt(Math.max(0, Math.trunc(bytes))));
  return `${value} ${t(unit)}`;
}

export function DataExportList({
  exports,
  hrefFor,
}: {
  exports: readonly DataExportView[];
  /** The same-origin download link of a ready export. */
  hrefFor: (id: string) => string;
}) {
  if (exports.length === 0) {
    return (
      <Empty
        icon="database"
        title={t('web.data_export_empty_title')}
        hint={t('web.data_export_empty_hint')}
      />
    );
  }
  return (
    <ul className="data-export-list" aria-label={t('web.data_export_list_title')}>
      {exports.map((row) => {
        const state = STATE[row.state];
        return (
          <li key={row.id} className="data-export-item card">
            <div className="data-export-head">
              <Badge tone={state.tone} dot>
                {t(state.label)}
              </Badge>
              {row.requestedByHost && (
                <Badge tone="violet" outline>
                  {t('web.data_export_by_host')}
                </Badge>
              )}
            </div>
            <KV
              items={[
                [t('web.data_export_requested_at'), formatTimestamp(row.requestedAt)],
                ...(row.expiresAt === null || row.state === 'EXPIRED'
                  ? []
                  : ([[t('web.data_export_expires_at'), formatTimestamp(row.expiresAt)]] as [
                      string,
                      string,
                    ][])),
                ...(row.bytes === null || row.state === 'EXPIRED'
                  ? []
                  : ([[t('web.data_export_size'), sizeText(row.bytes)]] as [string, string][])),
              ]}
            />
            {(row.state === 'REQUESTED' || row.state === 'RUNNING') && (
              <p className="muted small">{t('web.data_export_waiting_hint')}</p>
            )}
            {row.state === 'EXPIRED' && (
              <Banner tone="info" slim>
                {t('web.data_export_expired_hint')}
              </Banner>
            )}
            {row.state === 'FAILED' && (
              <Banner tone="danger" slim>
                {row.failureCode === DATA_EXPORT_ERROR_CODES.TOO_LARGE
                  ? t('web.data_export_failed_too_large_hint')
                  : t('web.data_export_failed_hint')}
              </Banner>
            )}
            {row.downloadable && (
              <a className="btn primary data-export-download" href={hrefFor(row.id)} download>
                {t('web.data_export_download')}
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** What the file holds and, as importantly, what it never holds. */
export function DataExportAbout() {
  return (
    <div className="stack">
      <p className="muted small">{t('web.data_export_what_hint')}</p>
      <Banner tone="info" slim>
        {t('web.data_export_never_hint')}
      </Banner>
    </div>
  );
}
