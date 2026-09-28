import { useCallback, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FeatureFlagResponse } from '@nexa/contracts';
import { fetchFeatureFlags, saveFeatureFlag } from '../api/client';
import { formatTimestamp } from '../format';
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

  return (
    <>
      <PageHead title={t('web.features_title')} subtitle={t('web.features_intro')} maturity="now" />
      <StateSwitch query={flags} denied={denied} isEmpty={rows.length === 0}>
        {rows.map((flag) => (
          <FlagCard key={flag.key} flag={flag} mayEdit={mayEdit} />
        ))}
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

  return (
    <Card
      title={title}
      actions={
        <>
          <Badge tone={flag.enabled ? 'ok' : 'neutral'}>
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
        </>
      }
    >
      <p className="muted small">{summary}</p>

      {flag.updatedAt !== null && (
        <p className="faint small">
          {t('web.feature_last_changed')}: {formatTimestamp(flag.updatedAt)}
        </p>
      )}

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
            setAsking(false);
            send(false);
          }}
          onCancel={cancel}
          returnFocusTo={returnFocus}
        />
      )}
    </Card>
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
  return (
    <section className="feature-settings" aria-label={t('web.feature_related_settings')}>
      <h3 className="small">{t('web.feature_related_settings')}</h3>
      {inert && <p className="muted small">{t('web.inert')}</p>}
      <dl className={inert ? 'inert' : undefined}>
        {flag.configuration.map((setting) => {
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
