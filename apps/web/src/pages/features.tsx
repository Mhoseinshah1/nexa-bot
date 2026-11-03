import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { OPS_GROUP_MANAGED_SETTING_KEYS, type FeatureFlagResponse } from '@nexa/contracts';
import { fetchFeatureFlags, saveFeatureFlag } from '../api/client';
import { formatNumber, formatTimestamp } from '../format';
import { useSubmissionKey } from '../submission-key';
import { t } from '../i18n/web.fa';
import { ConfirmDialog, confirmDialogOpen } from '../ui/confirm-dialog';
import {
  Badge,
  Card,
  FilterBar,
  FilterChip,
  FilterChips,
  Ltr,
  PageHead,
  SearchInput,
  StateSwitch,
  Switch,
  Tabs,
} from '../ui/kit';
import { useLinkHandler } from '../router';
import {
  FEATURE_CATEGORIES,
  FEATURE_CATEGORY_TITLE,
  FEATURE_WHERE_LABEL,
  featurePresentation,
  type FeatureCategory,
} from './features-catalogue';
import { ErrorReport, registryLabel } from './settings';
import { TechnicalDetails } from '../ui/technical-details';

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
type CategoryId = FeatureCategory | 'other';
type StatusFilter = 'all' | 'on' | 'off';

/** The category a flag is drawn under; a flag this build does not know goes to the «other» category. */
function categoryOf(key: string): CategoryId {
  return featurePresentation(key)?.category ?? 'other';
}

/** The words a search looks through: the Persian name and sentence (the server's text for an unknown flag). */
function searchText(flag: FeatureFlagResponse): string {
  const presentation = featurePresentation(flag.key);
  if (presentation === undefined) return `${flag.key} ${flag.description}`.toLowerCase();
  return `${t(presentation.title)} ${t(presentation.summary)}`.toLowerCase();
}

/**
 * One page, no paging. The API answers with every flag (the earlier ten-at-a-time paging was
 * done here, in the browser), so the category counts come from the complete list.
 */
export function FeaturesPage({ mayEdit, denied }: { mayEdit: boolean; denied: boolean }) {
  const flags = useQuery({ queryKey: ['features'], queryFn: fetchFeatureFlags, enabled: !denied });
  const rows = flags.data?.flags ?? [];

  const [picked, setPicked] = useState<CategoryId | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');

  const byCategory = new Map<CategoryId, FeatureFlagResponse[]>();
  for (const flag of rows) {
    const id = categoryOf(flag.key);
    byCategory.set(id, [...(byCategory.get(id) ?? []), flag]);
  }
  const categories = [...FEATURE_CATEGORIES, 'other' as const].filter((id) => byCategory.has(id));
  const selected: CategoryId | undefined =
    picked !== null && byCategory.has(picked) ? picked : categories[0];

  const needle = query.trim().toLowerCase();
  const searching = needle !== '';
  const passes = (flag: FeatureFlagResponse) =>
    (status === 'all' || (status === 'on') === flag.enabled) &&
    (!searching || searchText(flag).includes(needle));

  const onCount = rows.filter((flag) => flag.enabled).length;
  const panelId = 'feature-pane';
  const groups = searching
    ? categories
        .map((id) => ({ id, flags: (byCategory.get(id) ?? []).filter(passes) }))
        .filter((group) => group.flags.length > 0)
    : selected === undefined
      ? []
      : [{ id: selected, flags: (byCategory.get(selected) ?? []).filter(passes) }];

  return (
    <>
      <PageHead title={t('web.features_title')} subtitle={t('web.features_intro')} />
      <StateSwitch query={flags} denied={denied} isEmpty={rows.length === 0}>
        <FilterBar>
          <SearchInput
            value={query}
            onChange={setQuery}
            label={t('web.features_search_label')}
            placeholder={t('web.features_search_placeholder')}
          />
          <FilterChips label={t('web.features_filter_label')}>
            <FilterChip
              pressed={status === 'all'}
              onClick={() => setStatus('all')}
              count={rows.length}
            >
              {t('web.features_filter_all')}
            </FilterChip>
            <FilterChip pressed={status === 'on'} onClick={() => setStatus('on')} count={onCount}>
              {t('web.features_filter_on')}
            </FilterChip>
            <FilterChip
              pressed={status === 'off'}
              onClick={() => setStatus('off')}
              count={rows.length - onCount}
            >
              {t('web.features_filter_off')}
            </FilterChip>
          </FilterChips>
        </FilterBar>
        <div className="feature-split">
          {selected !== undefined && (
            <Tabs
              boxed
              vertical
              panelId={panelId}
              label={t('web.features_categories_label')}
              value={selected}
              onChange={(next) => {
                // Choosing a category ends a search: the pane then shows that category.
                setQuery('');
                setPicked(next);
              }}
              items={categories.map((id) => {
                const inCategory = byCategory.get(id) ?? [];
                const on = inCategory.filter((flag) => flag.enabled).length;
                return {
                  id,
                  label: t(FEATURE_CATEGORY_TITLE[id]),
                  countText: `${formatNumber(on)}/${formatNumber(inCategory.length)}`,
                };
              })}
            />
          )}
          <div
            id={panelId}
            className="feature-pane-body"
            {...(searching || selected === undefined
              ? { role: 'region', 'aria-label': t('web.features_results_label') }
              : { role: 'tabpanel', 'aria-labelledby': `${panelId}-tab-${selected}` })}
          >
            {groups.length === 0 || groups.every((group) => group.flags.length === 0) ? (
              <Card title={t('web.features_list_title')} tight>
                <p className="muted feature-empty">
                  {searching ? t('web.features_no_match') : t('web.features_cat_empty')}
                </p>
              </Card>
            ) : (
              groups.map((group) => (
                <Card
                  key={group.id}
                  title={t(FEATURE_CATEGORY_TITLE[group.id])}
                  hint={searching ? undefined : t('web.features_list_hint')}
                  tight
                >
                  <ul className="feature-list">
                    {group.flags.map((flag) => (
                      <FlagCard key={flag.key} flag={flag} mayEdit={mayEdit} />
                    ))}
                  </ul>
                </Card>
              ))
            )}
          </div>
        </div>
      </StateSwitch>
    </>
  );
}

function FlagCard({ flag, mayEdit }: { flag: FeatureFlagResponse; mayEdit: boolean }) {
  const client = useQueryClient();
  const onLink = useLinkHandler();
  const presentation = featurePresentation(flag.key);
  // A flag this build has no Persian entry for can only come from a newer server; its
  // own description is then the best there is, and the key is its only name.
  const title = presentation === undefined ? flag.key : t(presentation.title);
  // C1: an unknown flag's English description is never the summary; it is kept, for
  // support, under «جزئیات فنی».
  const summary =
    presentation === undefined ? t('web.feature_unknown_summary') : t(presentation.summary);
  // A flag this build does not know takes the CONSERVATIVE path: nothing here can say its
  // switch-off is harmless, and the server no longer asks for any confirmation, so the
  // page asks, with a generic sentence, rather than switching it off on one click.
  const disableEffect =
    presentation === undefined ? 'web.feature_unknown_off_effect' : presentation.disableEffect;
  // A switch-ON that stops customers at once asks too (`terms_enforcement`). An unknown
  // flag's switch-on is not asked about: its default and its page are the newer server's.
  const confirmEnable = presentation?.confirmEnable ?? null;
  const [asking, setAsking] = useState<'off' | 'on' | null>(null);
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
      setAsking('off');
      return;
    }
    if (next && confirmEnable !== null) {
      setAsking('on');
      return;
    }
    send(next);
  };

  const cancel = useCallback(() => setAsking(null), []);
  const returnFocus = useCallback(
    () => switchSlot.current?.querySelector<HTMLElement>('[role="switch"]') ?? null,
    [],
  );

  /*
   * Focus after a CONFIRMED switch-off (or a confirmed switch-on).
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
          {presentation !== undefined && (
            <dl className="feature-meta small">
              <div>
                <dt>{t('web.feature_where_label')}</dt>
                <dd>
                  {presentation.where
                    .map((place) => t(FEATURE_WHERE_LABEL[place]))
                    .join(t('web.list_separator'))}
                </dd>
              </div>
              <div>
                <dt>{t('web.feature_off_label')}</dt>
                <dd>{t(presentation.offEffect)}</dd>
              </div>
              {presentation.related !== null && (
                <div>
                  <dt>{t('web.feature_open_settings')}</dt>
                  <dd>
                    <a href={presentation.related.path} onClick={onLink}>
                      {t(presentation.related.label)}
                    </a>
                  </dd>
                </div>
              )}
            </dl>
          )}
          {presentation === undefined && <TechnicalDetails lines={[flag.description]} />}
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
                disabled={toggle.isPending || asking !== null}
              />
            </span>
          )}
        </div>
      </div>

      {flag.configuration.length > 0 && <RelatedSettings flag={flag} />}

      {toggle.isError && <ErrorReport error={toggle.error} />}

      {asking === 'off' && disableEffect !== null && (
        <ConfirmDialog
          title={title}
          question={t('web.feature_confirm_disable')}
          detail={t(disableEffect)}
          confirmLabel={t('web.feature_confirm_disable_yes')}
          cancelLabel={t('web.feature_confirm_cancel')}
          onConfirm={() => {
            restoreAfterWrite.current = 'armed';
            setAsking(null);
            send(false);
          }}
          onCancel={cancel}
          returnFocusTo={returnFocus}
        />
      )}

      {asking === 'on' && confirmEnable !== null && (
        <ConfirmDialog
          title={title}
          question={t(confirmEnable.question)}
          detail={t(confirmEnable.detail)}
          confirmLabel={t(confirmEnable.confirmLabel)}
          cancelLabel={t('web.feature_confirm_cancel')}
          onConfirm={() => {
            restoreAfterWrite.current = 'armed';
            setAsking(null);
            send(true);
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
