import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  APPEARANCE_SLOTS,
  DELIVERY_TUTORIAL_MODES,
  DELIVERY_TUTORIAL_TEXT_MAX_LENGTH,
  PANEL_ERROR_CODES,
  TELEGRAM_CAPTION_MAX_LENGTH,
  appearanceMarker,
  deliveryTutorialSendsText,
  deliveryTutorialSendsVideo,
  deliveryTutorialTextProblem,
  renderClientAppGuide,
  type DeliveryTutorialBody,
  type DeliveryTutorialMode,
  type DeliveryTutorialTextProblem,
  type DeliveryTutorialVideoOption,
} from '@nexa/contracts';
import { ApiError, fetchDeliveryTutorial, saveDeliveryTutorial } from '../api/client';
import { APPEARANCE_SLOT_LABEL, withMarkersAsFallback } from '../appearance-labels';
import { formatNumber, formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { useSubmissionKey } from '../submission-key';
import { Banner, Card, Disclosure, Field, Ltr, StateSwitch, Switch, useToast } from '../ui/kit';
import { messageFor } from './settings';

export const deliveryTutorialKey = (panelId: string) => ['delivery-tutorial', panelId] as const;

const MODE_LABELS: Readonly<Record<DeliveryTutorialMode, WebKey>> = {
  DISABLED: 'web.delivery_tutorial_mode_disabled',
  TEXT: 'web.delivery_tutorial_mode_text',
  VIDEO: 'web.delivery_tutorial_mode_video',
  VIDEO_TEXT: 'web.delivery_tutorial_mode_video_text',
};

const TEXT_PROBLEMS: Readonly<Record<DeliveryTutorialTextProblem, WebKey>> = {
  CONTROL: 'web.delivery_tutorial_text_control',
  MARKUP: 'web.delivery_tutorial_text_markup',
  EXECUTABLE_SCHEME: 'web.delivery_tutorial_text_unsafe_link',
  UNSAFE_LINK: 'web.delivery_tutorial_text_unsafe_link',
  UNKNOWN_ICON: 'web.delivery_tutorial_text_unknown_icon',
  TOO_LONG: 'web.delivery_tutorial_text_too_long',
};

interface Draft {
  readonly mode: DeliveryTutorialMode;
  readonly text: string;
  readonly videoClientAppId: string;
  readonly appliesToPurchase: boolean;
  readonly appliesToTrial: boolean;
}

function draftOf(tutorial: DeliveryTutorialBody): Draft {
  return {
    mode: tutorial.mode,
    text: tutorial.text ?? '',
    videoClientAppId: tutorial.videoClientAppId ?? '',
    appliesToPurchase: tutorial.appliesToPurchase,
    appliesToTrial: tutorial.appliesToTrial,
  };
}

/** What is wrong with a draft, field by field — the same rules the server's schema holds. */
export function draftErrors(draft: Draft): Partial<Record<'text' | 'video' | 'applies', WebKey>> {
  const text = draft.text.trim();
  const errors: Partial<Record<'text' | 'video' | 'applies', WebKey>> = {};
  if (text !== '') {
    const problem = deliveryTutorialTextProblem(text);
    if (problem !== null) errors.text = TEXT_PROBLEMS[problem];
  } else if (deliveryTutorialSendsText(draft.mode)) {
    errors.text = 'web.delivery_tutorial_text_required';
  }
  if (deliveryTutorialSendsVideo(draft.mode) && draft.videoClientAppId === '') {
    errors.video = 'web.delivery_tutorial_video_required';
  }
  if (draft.mode !== 'DISABLED' && !draft.appliesToPurchase && !draft.appliesToTrial) {
    errors.applies = 'web.delivery_tutorial_applies_required';
  }
  return errors;
}

/**
 * Phase 2 item 5: one panel's post-delivery tutorial — the «آموزش پس از تحویل» tab.
 *
 * Whole, never a patch, with the revision the form was drawn from (the trial tab's rule).
 * Fields the chosen mode does not use are still sent as they stand, so switching to
 * «غیرفعال» and back loses nothing. The video is a client app's tutorial video, set through
 * the bot as it always was; this screen only chooses which app's.
 */
export function DeliveryTutorialTab({ panelId, mayEdit }: { panelId: string; mayEdit: boolean }) {
  const tutorial = useQuery({
    queryKey: deliveryTutorialKey(panelId),
    queryFn: () => fetchDeliveryTutorial(panelId),
  });
  return (
    <StateSwitch query={tutorial}>
      {tutorial.data !== undefined && (
        <TutorialForm
          key={`${panelId}:${String(tutorial.data.tutorial.revision)}`}
          tutorial={tutorial.data.tutorial}
          videoOptions={tutorial.data.videoOptions}
          mayEdit={mayEdit}
        />
      )}
    </StateSwitch>
  );
}

function optionLabel(option: DeliveryTutorialVideoOption): string {
  const bots = t('web.delivery_tutorial_video_bots').replace(
    '{count}',
    formatNumber(option.botsWithVideo),
  );
  const disabled = option.enabled ? '' : ` — ${t('web.delivery_tutorial_video_app_disabled')}`;
  return `${option.name} (${option.platform}) — ${bots}${disabled}`;
}

function TutorialForm({
  tutorial,
  videoOptions,
  mayEdit,
}: {
  tutorial: DeliveryTutorialBody;
  videoOptions: readonly DeliveryTutorialVideoOption[];
  mayEdit: boolean;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const submission = useSubmissionKey();
  const [draft, setDraft] = useState<Draft>(() => draftOf(tutorial));
  const [showErrors, setShowErrors] = useState(false);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const save = useMutation({
    mutationFn: (body: Parameters<typeof saveDeliveryTutorial>[1]) =>
      saveDeliveryTutorial(tutorial.panelId, body),
    onSuccess: (result) => {
      submission.settle();
      toast({
        tone: result.changed ? 'ok' : 'info',
        message: result.changed ? t('web.saved') : t('web.unchanged'),
      });
      client.setQueryData(deliveryTutorialKey(tutorial.panelId), {
        tutorial: result.tutorial,
        videoOptions: result.videoOptions,
      });
    },
    onError: async (error: unknown) => {
      submission.settleOn(error);
      if (error instanceof ApiError && error.code === PANEL_ERROR_CODES.DELIVERY_TUTORIAL_STALE) {
        toast({ tone: 'warn', message: t('web.delivery_tutorial_stale') });
        await client.invalidateQueries({ queryKey: deliveryTutorialKey(tutorial.panelId) });
        return;
      }
      toast({ tone: 'danger', message: messageFor(error) });
    },
  });

  const errors = draftErrors(draft);
  const valid = Object.keys(errors).length === 0;
  const shown = (field: keyof typeof errors) =>
    showErrors && errors[field] !== undefined ? t(errors[field]) : undefined;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) {
      setShowErrors(true);
      return;
    }
    setShowErrors(false);
    const text = draft.text.trim();
    const command = {
      expectedRevision: tutorial.revision,
      mode: draft.mode,
      text: text === '' ? null : text,
      videoClientAppId: draft.videoClientAppId === '' ? null : draft.videoClientAppId,
      appliesToPurchase: draft.appliesToPurchase,
      appliesToTrial: draft.appliesToTrial,
    };
    save.mutate({
      ...command,
      idempotencyKey: submission.current({
        command: 'panels.delivery_tutorial',
        id: tutorial.panelId,
        ...command,
      }),
    });
  };

  const editable = mayEdit && !save.isPending;
  const sendsText = deliveryTutorialSendsText(draft.mode);
  const sendsVideo = deliveryTutorialSendsVideo(draft.mode);
  const rendered = draft.text.trim() === '' ? '' : renderClientAppGuide(draft.text);
  /*
   * Measured as the server measures the caption: rendered, with each {icon:…} marker drawn as
   * its one emoji (a custom emoji entity covers that same emoji, so the length is the same).
   */
  const captionLength = withMarkersAsFallback(rendered).length;
  const named = videoOptions.find((option) => option.clientAppId === draft.videoClientAppId);
  const id = (field: string) => `delivery-tutorial-${field}`;
  const textError = shown('text');
  const videoError = shown('video');
  const appliesError = shown('applies');

  return (
    <Card title={t('web.delivery_tutorial_title')} hint={t('web.delivery_tutorial_hint')}>
      {tutorial.revision === 0 && (
        <Banner tone="info">{t('web.delivery_tutorial_unconfigured')}</Banner>
      )}
      <form onSubmit={onSubmit} className="stack-sm" noValidate>
        <Field label={t('web.delivery_tutorial_mode')} htmlFor={id('mode')}>
          <select
            id={id('mode')}
            className="input"
            value={draft.mode}
            disabled={!editable}
            onChange={(event) => set('mode', event.target.value as DeliveryTutorialMode)}
          >
            {DELIVERY_TUTORIAL_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {t(MODE_LABELS[mode])}
              </option>
            ))}
          </select>
        </Field>
        {draft.mode === 'DISABLED' && (
          <p className="muted small">{t('web.delivery_tutorial_disabled_note')}</p>
        )}

        <fieldset className="field" disabled={!editable}>
          <legend>{t('web.delivery_tutorial_applies')}</legend>
          <div className="row">
            <Switch
              checked={draft.appliesToPurchase}
              label={t('web.delivery_tutorial_applies_purchase')}
              disabled={!editable}
              onChange={(next) => set('appliesToPurchase', next)}
            />
            <span>{t('web.delivery_tutorial_applies_purchase')}</span>
          </div>
          <div className="row">
            <Switch
              checked={draft.appliesToTrial}
              label={t('web.delivery_tutorial_applies_trial')}
              disabled={!editable}
              onChange={(next) => set('appliesToTrial', next)}
            />
            <span>{t('web.delivery_tutorial_applies_trial')}</span>
          </div>
          {appliesError !== undefined && <Banner tone="danger">{appliesError}</Banner>}
        </fieldset>

        <Field
          label={
            sendsText ? t('web.delivery_tutorial_text') : t('web.delivery_tutorial_text_optional')
          }
          hint={t('web.delivery_tutorial_text_hint')}
          htmlFor={id('text')}
          required={sendsText}
          {...(textError === undefined ? {} : { error: textError })}
        >
          <textarea
            id={id('text')}
            className="input"
            rows={6}
            value={draft.text}
            maxLength={DELIVERY_TUTORIAL_TEXT_MAX_LENGTH}
            disabled={!editable}
            onChange={(event) => set('text', event.target.value)}
          />
        </Field>
        <Disclosure size="sm" summary={t('web.delivery_tutorial_icons')}>
          <p className="muted small">{t('web.delivery_tutorial_icons_hint')}</p>
          <div className="btn-group">
            {APPEARANCE_SLOTS.map((slot) => (
              <button
                key={slot}
                type="button"
                className="btn ghost sm"
                disabled={!editable}
                title={appearanceMarker(slot)}
                onClick={() => set('text', `${draft.text}${appearanceMarker(slot)}`)}
              >
                {t(APPEARANCE_SLOT_LABEL[slot])} <Ltr>{appearanceMarker(slot)}</Ltr>
              </button>
            ))}
          </div>
        </Disclosure>
        <p className="faint small">
          {t('web.delivery_tutorial_length')
            .replace('{count}', formatNumber(draft.text.trim().length))
            .replace('{max}', formatNumber(DELIVERY_TUTORIAL_TEXT_MAX_LENGTH))}
        </p>
        {draft.mode === 'VIDEO_TEXT' && captionLength > TELEGRAM_CAPTION_MAX_LENGTH && (
          <Banner tone="info">{t('web.delivery_tutorial_caption_fallback')}</Banner>
        )}

        <Field
          label={
            sendsVideo
              ? t('web.delivery_tutorial_video')
              : t('web.delivery_tutorial_video_optional')
          }
          hint={t('web.delivery_tutorial_video_hint')}
          htmlFor={id('video')}
          required={sendsVideo}
          {...(videoError === undefined ? {} : { error: videoError })}
        >
          <select
            id={id('video')}
            className="input"
            value={draft.videoClientAppId}
            disabled={!editable}
            onChange={(event) => set('videoClientAppId', event.target.value)}
          >
            <option value="">{t('web.delivery_tutorial_video_none')}</option>
            {draft.videoClientAppId !== '' && named === undefined && (
              <option value={draft.videoClientAppId}>
                {t('web.delivery_tutorial_video_missing')}
              </option>
            )}
            {videoOptions.map((option) => (
              <option key={option.clientAppId} value={option.clientAppId}>
                {optionLabel(option)}
              </option>
            ))}
          </select>
        </Field>
        {videoOptions.length === 0 && (
          <p className="muted small">{t('web.delivery_tutorial_video_empty')}</p>
        )}

        {rendered !== '' && (
          <div className="field">
            <span className="small strong">{t('web.delivery_tutorial_preview')}</span>
            <p className="muted small">{t('web.delivery_tutorial_preview_hint')}</p>
            <div className="bot-preview" dir="auto" data-testid="delivery-tutorial-preview">
              {rendered}
            </div>
          </div>
        )}

        {tutorial.updatedAt !== null && (
          <p className="faint small">
            {t('web.delivery_tutorial_updated_at')}: {formatTimestamp(tutorial.updatedAt)}
          </p>
        )}
        {mayEdit && (
          <div className="btn-group">
            <button type="submit" className="btn primary sm" disabled={!editable}>
              {save.isPending ? t('web.saving') : t('web.save')}
            </button>
          </div>
        )}
      </form>
    </Card>
  );
}
