import type { MiniAppServiceSummary } from '@nexa/contracts';
import { t } from '../i18n/t.js';
import { daysUntil, dateTime, traffic, trafficLimit, usedShare } from '../format.js';
import { UsageBar } from '../ui.js';

/**
 * One service as a card: name, status, the usage bar and figures, the days left. Every
 * figure is the service's stored one; «رو به پایان» is derived from the same numbers
 * (90% used or three days left), as the map allows. The CONNECTED-device count and the
 * seven-day usage chart are not drawn: no such data exists, only the device LIMIT.
 */
export function ServiceCard({
  service,
  onOpen,
  now,
}: {
  service: MiniAppServiceSummary;
  onOpen?: () => void;
  now: Date;
}) {
  const share = usedShare(service.trafficUsedBytes, service.trafficLimitBytes);
  const days = service.expiresAt === null ? null : daysUntil(service.expiresAt, now);
  const ending =
    service.state === 'ACTIVE' &&
    ((share !== null && share >= 0.9) || (days !== null && days <= 3));
  const inactive = service.state === 'EXPIRED' || service.state === 'TERMINATED';
  const tone =
    service.state === 'PENDING_PROVISION'
      ? 'building'
      : service.state === 'ACTIVE'
        ? ending
          ? 'warn'
          : 'ok'
        : service.state === 'SUSPENDED'
          ? 'off'
          : 'muted';
  const body = (
    <>
      <div className="card-head">
        <strong className="service-title">
          {service.title}
          {service.isTrial && <span className="badge">{t('miniapp.service_trial')}</span>}
        </strong>
        <span className={`status-chip status-chip-${tone}`}>
          {ending ? t('miniapp.service_ending') : t(`miniapp.service_state_${service.state}`)}
        </span>
      </div>
      <UsageBar share={share} />
      <div className="service-figures">
        <span>
          {t('miniapp.service_used_of', {
            used: traffic(service.trafficUsedBytes),
            limit: trafficLimit(service.trafficLimitBytes),
          })}
        </span>
        <span>
          {service.expiresAt === null
            ? t('miniapp.service_no_expiry')
            : days !== null && days > 0
              ? t('miniapp.service_days_left', { days })
              : t('miniapp.service_expired_at', { at: dateTime(service.expiresAt) })}
        </span>
      </div>
      {(service.locationLabel !== null || service.deviceLimit !== null) && (
        <div className="card-meta">
          {service.locationLabel !== null && (
            <span>{t('miniapp.service_location', { location: service.locationLabel })}</span>
          )}
          {service.deviceLimit !== null && (
            <span>{t('miniapp.service_devices', { count: service.deviceLimit })}</span>
          )}
        </div>
      )}
    </>
  );
  const klass = inactive ? 'glass service service-muted' : 'glass service';
  return onOpen === undefined ? (
    <section className={klass}>{body}</section>
  ) : (
    <button type="button" className={`${klass} service-button`} onClick={onOpen}>
      {body}
    </button>
  );
}
