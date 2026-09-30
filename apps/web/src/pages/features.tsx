import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { OPS_GROUP_MANAGED_SETTING_KEYS, type FeatureFlagResponse } from '@nexa/contracts';
import { fetchFeatureFlags, saveFeatureFlag } from '../api/client';
import { formatNumber, formatTimestamp } from '../format';
import { useSubmissionKey } from '../submission-key';
import { t } from '../i18n/web.fa';
import { ConfirmDialog, confirmDialogOpen } from '../ui/confirm-dialog';
import { Badge, Card, Ltr, PageHead, StateSwitch, Switch } from '../ui/kit';
import { featurePresentation } from './features-catalogue';
import { ErrorReport, registryLabel } from './settings';

/**
 * The feature screen: a Persian control panel of on/off switches (WP-A2).
 *
 * Each feature shows its Persian name, one practical sentence, its state and a switch.
 * Turning a feature on is one click. Turning one off is one click too, except for the
 * few whose switch-off silently stops something people rely on, and any flag this
 * build does not know. Those ask a plain yes/cancel question first
 * (`FEATURE_PRESENTATION[key].disableEffect`). Nothing is
 * typed: no internal key, no phrase, no reason. The audit row records who, when and
 * what on its own.
 *
 * Each feature is still drawn with the settings it governs, and those settings are
 * labelled inert while it is off. In the legacy system the balance-warning flag and its
 * threshold sit on different screens, the flag is off, and nothing on either screen says
 * that the value therefore does nothing (CBR-007, GSR-008).
 */
export function FeaturesPage({ mayEdit, denied }: { mayEdit: boolean; denied: boolean }) {
  const flags = useQuery({ queryKey: ['features'], queryFn: fetchFeatureFlags, enabled: !denied });
  const rows = flags.data?.flags ?? [];

  const enabledCount = rows.filter((flag) => flag.enabled).length;

  return (
    <>
      <PageHead title={t('web.features_title')} subtitle={t('web.features_intro')} />
      <StateSwitch query={flags} denied={denied} isEmpty={rows.length === 0}>
        <Card
          title={t('web.features_list_title')}
          hint={t('web.features_list_hint')}
          actions={
            <span className="muted small">
              {`${t('web.features_on_count')}: ${formatNumber(enabledCount)} ${t('web.templates_count_of')} ${formatNumber(rows.length)}`}
            </span>
          }
          tight
        >
          <ul className="feature-list">
            {rows.map((flag) => (
              <FlagCard key={flag.key} flag={flag} mayEdit={mayEdit} />
            ))}
          </ul>
        </Card>
      </StateSwitch>
    </>
  );
}

function FlagCard({ flag, mayEdit }: { flag: FeatureFlagResponse; mayEdit: boolean }) {
  const client = useQueryClient();
  const presentation = featurePresentation(flag.key);
  // A flag this build has no Persian entry for can only come from a newer server; its
  // own description is then the best there is, and the key is its only name.
  const title = presentation === undefined ? flag.key : t(presentation.title);
  const summary = presentation === undefined ? flag.description : t(presentation.summary);
  // A flag this build does not know takes the CONSERVATIVE path: nothing here can say its
  // switch-off is harmless, and the server no longer asks for any confirmation, so the
  // page asks, with a generic sentence, rather than switching it off on one click.
  const disableEffect =
    presentation === undefined ? 'web.feature_unknown_off_effect' : presentation.disableEffect;
  const [asking, setAsking] = useState(false);
  const switchSlot = useRef<HTMLSpanElement>(null);

  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ['features'] });
    await client.invalidateQueries({ queryKey: ['settings'] });
  };

  const submission = useSubmissionKey();

  const toggle = useMutation({
    // The WHOLE command travels as the variable, with the key minted for it, so a retry
    // carries the key and the command its first attempt used; see `settings.tsx`.
    mutationFn: (command: {
      idempotencyKey: string;
      enabled: boolean;
      expectedVersion: number | null;
    }) => saveFeatureFlag({ key: flag.key, ...command }),
    onSuccess: async () => {
      submission.settle();
      await refresh();
    },
    // A conflict means the cached row is stale; refreshing is what makes a
    // second attempt able to succeed.
    onError: (error: unknown) => {
      submission.settleOn(error);
      void refresh();
    },
  });

  const send = (enabled: boolean) => {
    // Snapshotted at the click, against the version this card was drawn from.
    const command = { enabled, expectedVersion: flag.version };
    toggle.mutate({ ...command, idempotencyKey: submission.current(command) });
  };

  const onSwitch = (next: boolean) => {
    // One question at a time, and nothing is sent behind an open one.
    if (confirmDialogOpen()) return;
    if (!next && disableEffect !== null) {
      setAsking(true);
      return;
    }
    send(next);
  };

  const cancel = useCallback(() => setAsking(false), []);
  const returnFocus = useCallback(
    () => switchSlot.current?.querySelector<HTMLElement>('[role="switch"]') ?? null,
    [],
  );

  /*
   * Focus after a CONFIRMED switch-off.
   *
   * «بله، خاموش شود» closes the dialog and starts the write, and the switch is disabled
   * while the write is pending. The dialog hands focus back to a switch that is disabled,
   * or is about to be, and focus falls to the page body. So confirming arms this. The
   * restore waits until the write has started ('armed' to 'pending') and then settled
   * ('pending' to idle, on success or error), by which point the switch is enabled
   * again.
   *
   * Focus is restored only when it is nowhere useful. An operator who has since moved
   * to another control keeps it. Cancel never arms this, because nothing is pending and
   * the dialog's own hand-back already works.
   */
  const restoreAfterWrite = useRef<'idle' | 'armed' | 'pending'>('idle');
  useEffect(() => {
    if (restoreAfterWrite.current === 'armed' && toggle.isPending) {
      restoreAfterWrite.current = 'pending';
    } else if (restoreAfterWrite.current === 'pending' && !toggle.isPending) {
      restoreAfterWrite.current = 'idle';
      const active = document.activeElement;
      if (active === null || active === document.body) returnFocus()?.focus();
    }
  }, [toggle.isPending, returnFocus]);

  return (
    <li className="feature-row">
      <div className="feature-row-main">
        <div className="feature-row-text">
          <h3>{title}</h3>
          <p className="muted small">{summary}</p>
          {flag.updatedAt !== null && (
            <p className="faint small">
              {t('web.feature_last_changed')}: {formatTimestamp(flag.updatedAt)}
            </p>
          )}
        </div>
        <div className="feature-row-state">
          <Badge tone={flag.enabled ? 'ok' : 'neutral'} dot>
            {flag.enabled ? t('web.enabled') : t('web.disabled')}
          </Badge>
          {mayEdit && (
            // The slot exists so the dialog can hand focus back to this switch on close;
            // the kit's Switch takes no ref.
            <span ref={switchSlot} className="switch-slot">
              <Switch
                checked={flag.enabled}
                onChange={onSwitch}
                label={title}
                disabled={toggle.isPending || asking}
              />
            </span>
          )}
        </div>
      </div>

      {flag.configuration.length > 0 && <RelatedSettings flag={flag} />}

      {toggle.isError && <ErrorReport error={toggle.error} />}

      {asking && disableEffect !== null && (
        <ConfirmDialog
          title={title}
          question={t('web.feature_confirm_disable')}
          detail={t(disableEffect)}
          confirmLabel={t('web.feature_confirm_disable_yes')}
          cancelLabel={t('web.feature_confirm_cancel')}
          onConfirm={() => {
            restoreAfterWrite.current = 'armed';
            setAsking(false);
            send(false);
          }}
          onCancel={cancel}
          returnFocusTo={returnFocus}
        />
      )}
    </li>
  );
}

/**
 * The settings a feature governs: their Persian names and current values.
 *
 * Read-only here, and edited on the settings screen. The names come from the settings
 * screen's own `registryLabel`, so one setting cannot be named one way here and another
 * way there. That is the one place this page meets the settings presentation. A setting
 * that has no Persian name yet shows its key, isolated as left-to-right text, until it
 * is given one.
 */
function RelatedSettings({ flag }: { flag: FeatureFlagResponse }) {
  const inert = !flag.enabled;
  // WP-A4: the ops group panel owns these; they are not shown on the normal pages.
  const shown = flag.configuration.filter(
    (setting) => !(OPS_GROUP_MANAGED_SETTING_KEYS as readonly string[]).includes(setting.key),
  );
  if (shown.length === 0) return null;
  return (
    <section className="inset feature-settings" aria-label={t('web.feature_related_settings')}>
      <h4 className="small">{t('web.feature_related_settings')}</h4>
      {inert && <p className="muted small">{t('web.inert')}</p>}
      <dl className={inert ? 'inert' : undefined}>
        {shown.map((setting) => {
          const label = registryLabel(setting.key);
          return (
            <div key={setting.key}>
              <dt>{label ?? <Ltr>{setting.key}</Ltr>}</dt>
              <dd>
                <SettingValue value={setting.value} />
                {setting.storedValueInvalid && (
                  <span className="danger small"> {t('web.stored_value_invalid')}</span>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

/**
 * A setting's current value, as an operator reads it.
 *
 * `String(null)` is the four characters "null", which reads as a stored value rather
 * than an absent one, so an absent value says so in words. A boolean reads as on/off.
 * Anything else is data, and is shown as left-to-right text.
 */
function SettingValue({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === '') {
    return <span className="muted">{t('web.feature_setting_unset')}</span>;
  }
  if (typeof value === 'boolean') return <>{value ? t('web.enabled') : t('web.disabled')}</>;
  return <Ltr>{typeof value === 'string' ? value : JSON.stringify(value)}</Ltr>;
}
