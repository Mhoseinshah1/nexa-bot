import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CONNECTION_FILE_CAPTION_MODES,
  CONNECTION_FILE_CAPTION_PLACEMENTS,
  CONNECTION_FILE_CAPTION_VARIABLES,
  CONTROL_ERROR_CODES,
  TELEGRAM_CAPTION_MAX_LENGTH,
  connectionFileCaptionTemplateIssues,
  type ConnectionFileCaptionIssue,
  type ConnectionFileCaptionMode,
  type ConnectionFileCaptionPlacement,
  type ResolvedPanelSettingResponse,
  type TemplateValues,
} from '@nexa/contracts';
import { renderConnectionFileCaption, type CaptionEntity } from '@nexa/i18n';
import { ApiError, fetchPanelSettings, savePanelSetting } from '../api/client';
import { formatNumber, formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { useSubmissionKey } from '../submission-key';
import { placeholderLabel } from '../template-copy';
import { Banner, Card, Field, Ltr, StateSwitch, useToast } from '../ui/kit';
import { useUnsavedChanges } from '../ui/unsaved';
import { messageFor } from './settings';

export const panelSettingsKey = (panelId: string) => ['panel-settings', panelId] as const;

const MODE_KEY = 'panel.connection_files.caption_mode';
const TEMPLATE_KEY = 'panel.connection_files.caption_template';
const PLACEMENT_KEY = 'panel.connection_files.caption_placement';
/** The default body's template key: the variables' labels are declared against it. */
const CAPTION_TEMPLATE_KEY = 'bot.service.connection_files_caption';

const MODE_LABELS: Readonly<Record<ConnectionFileCaptionMode, WebKey>> = {
  PANEL_DEFAULT: 'web.connection_files_mode_panel_default',
  CUSTOM: 'web.connection_files_mode_custom',
  NONE: 'web.connection_files_mode_none',
};

/**
 * Where the length warning starts: three quarters of Telegram's caption bound. The preview's
 * values are variable NAMES, shorter or longer than a real link or date, so a template near
 * the bound may render past it for a real service — and is then cut at send time.
 */
export const CAPTION_LENGTH_WARN_AT = Math.floor(TELEGRAM_CAPTION_MAX_LENGTH * 0.75);

const PLACEMENT_LABELS: Readonly<Record<ConnectionFileCaptionPlacement, WebKey>> = {
  LAST_FILE: 'web.connection_files_placement_last',
  EVERY_FILE: 'web.connection_files_placement_every',
};

interface Draft {
  readonly mode: ConnectionFileCaptionMode;
  /** True when the panel stores no template of its own (the value null). */
  readonly useDefault: boolean;
  readonly template: string;
  readonly placement: ConnectionFileCaptionPlacement;
}

function settingOf(
  settings: readonly ResolvedPanelSettingResponse[],
  key: string,
): ResolvedPanelSettingResponse | undefined {
  return settings.find((setting) => setting.key === key);
}

function draftOf(settings: readonly ResolvedPanelSettingResponse[]): Draft {
  const template = settingOf(settings, TEMPLATE_KEY)?.value;
  return {
    mode:
      (settingOf(settings, MODE_KEY)?.value as ConnectionFileCaptionMode | undefined) ?? 'CUSTOM',
    useDefault: typeof template !== 'string',
    template: typeof template === 'string' ? template : '',
    placement:
      (settingOf(settings, PLACEMENT_KEY)?.value as ConnectionFileCaptionPlacement | undefined) ??
      'LAST_FILE',
  };
}

/** The Persian sentence for one refusal of the shared validator — the server's own rules. */
export function captionIssueMessage(issue: ConnectionFileCaptionIssue): string {
  switch (issue.kind) {
    case 'EMPTY':
      return t('web.connection_files_template_empty');
    case 'TOO_LONG':
      return t('web.connection_files_template_too_long')
        .replace('{max}', formatNumber(issue.max))
        .replace('{count}', formatNumber(issue.length));
    case 'UNKNOWN_VARIABLE':
      return t('web.connection_files_unknown_variable').replace('{token}', `{${issue.token}}`);
  }
}

/**
 * The values the PREVIEW renders with: each variable's own Persian name, in guillemets —
 * never an invented username, volume or date. The preview shows where each fact lands and
 * how the formatting reads; the real values are the service's, at send time.
 */
export function previewValues(): TemplateValues {
  const values: Record<string, string> = {};
  for (const variable of CONNECTION_FILE_CAPTION_VARIABLES) {
    values[variable.token] =
      `«${placeholderLabel(CAPTION_TEMPLATE_KEY, variable.token, variable.description)}»`;
  }
  return values;
}

const ENTITY_ELEMENTS: Readonly<Record<CaptionEntity['type'], (children: ReactNode) => ReactNode>> =
  {
    bold: (children) => <strong>{children}</strong>,
    italic: (children) => <em>{children}</em>,
    underline: (children) => <u>{children}</u>,
    strikethrough: (children) => <s>{children}</s>,
    spoiler: (children) => <span>{children}</span>,
    code: (children) => <code>{children}</code>,
    pre: (children) => <pre>{children}</pre>,
    blockquote: (children) => <blockquote>{children}</blockquote>,
  };

/**
 * The rendered text with its entities drawn as elements. Telegram entities nest and never
 * overlap (the caption grammar guarantees it), so each range is the outermost entity that
 * starts there, and its inside is drawn the same way.
 */
function drawEntities(
  text: string,
  entities: readonly CaptionEntity[],
  start: number,
  end: number,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let position = start;
  const inside = entities
    .filter((entity) => entity.offset >= start && entity.offset + entity.length <= end)
    .sort((a, b) => a.offset - b.offset || b.length - a.length);
  for (let index = 0; index < inside.length; index += 1) {
    const entity = inside[index] as CaptionEntity;
    if (entity.offset < position) continue;
    if (entity.offset > position) nodes.push(text.slice(position, entity.offset));
    const stop = entity.offset + entity.length;
    const rest = inside.filter((other, at) => at !== index && other.offset >= entity.offset);
    nodes.push(
      <span key={`${String(entity.offset)}-${entity.type}`}>
        {ENTITY_ELEMENTS[entity.type](drawEntities(text, rest, entity.offset, stop))}
      </span>,
    );
    position = stop;
  }
  if (position < end) nodes.push(text.slice(position, end));
  return nodes;
}

/**
 * Track 3 §2: one panel's connection-file caption — the «فایل‌های اتصال» tab.
 *
 * Three PANEL-scoped registry keys, each written on its own with the version it was read
 * at (a colleague's change in between is refused, never merged). The template is checked
 * as it is typed by `connectionFileCaptionTemplateIssues` — the validator the server's
 * schema runs — and previewed by `renderConnectionFileCaption`, the renderer the bot sends
 * with, over each variable's NAME rather than invented values.
 */
export function PanelConnectionFilesTab({
  panelId,
  mayEdit,
}: {
  panelId: string;
  mayEdit: boolean;
}) {
  const settings = useQuery({
    queryKey: panelSettingsKey(panelId),
    queryFn: () => fetchPanelSettings(panelId),
  });
  const data = settings.data;
  const versions =
    data === undefined
      ? ''
      : [MODE_KEY, TEMPLATE_KEY, PLACEMENT_KEY]
          .map((key) => String(settingOf(data.settings, key)?.version ?? 0))
          .join(':');
  return (
    <StateSwitch query={settings}>
      {data !== undefined && (
        // Keyed by the versions, so a save or a colleague's change re-seeds the draft.
        <CaptionForm
          key={`${panelId}:${versions}`}
          panelId={panelId}
          settings={data.settings}
          mayEdit={mayEdit}
        />
      )}
    </StateSwitch>
  );
}

function CaptionForm({
  panelId,
  settings,
  mayEdit,
}: {
  panelId: string;
  settings: readonly ResolvedPanelSettingResponse[];
  mayEdit: boolean;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const modeSubmission = useSubmissionKey();
  const templateSubmission = useSubmissionKey();
  const placementSubmission = useSubmissionKey();
  const initial = draftOf(settings);
  const [draft, setDraft] = useState<Draft>(initial);
  const [showErrors, setShowErrors] = useState(false);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const templateValue = draft.useDefault ? null : draft.template;
  const initialTemplate = initial.useDefault ? null : initial.template;
  const changes = [
    draft.mode !== initial.mode
      ? { key: MODE_KEY, value: draft.mode, submission: modeSubmission }
      : null,
    templateValue !== initialTemplate
      ? { key: TEMPLATE_KEY, value: templateValue, submission: templateSubmission }
      : null,
    draft.placement !== initial.placement
      ? { key: PLACEMENT_KEY, value: draft.placement, submission: placementSubmission }
      : null,
  ].filter((change) => change !== null);
  useUnsavedChanges(mayEdit && changes.length > 0);

  const issues = draft.useDefault ? [] : connectionFileCaptionTemplateIssues(draft.template);

  const save = useMutation({
    mutationFn: async () => {
      let changed = false;
      // One key at a time, each with its own version and its own key; the first refusal
      // stops the rest, and the refetch below shows what was stored.
      for (const change of changes) {
        const expectedVersion = settingOf(settings, change.key)?.version ?? null;
        const command = { key: change.key, value: change.value, expectedVersion };
        const result = await savePanelSetting(panelId, {
          ...command,
          idempotencyKey: change.submission.current({
            command: 'panels.setting',
            id: panelId,
            ...command,
          }),
        });
        change.submission.settle();
        changed = changed || result.changed;
      }
      return changed;
    },
    onSuccess: async (changed) => {
      toast({
        tone: changed ? 'ok' : 'info',
        message: changed ? t('web.saved') : t('web.unchanged'),
      });
      await client.invalidateQueries({ queryKey: panelSettingsKey(panelId) });
    },
    onError: async (error: unknown) => {
      for (const change of changes) change.submission.settleOn(error);
      if (error instanceof ApiError && error.code === CONTROL_ERROR_CODES.VERSION_CONFLICT) {
        toast({ tone: 'warn', message: t('web.connection_files_stale') });
      } else {
        toast({ tone: 'danger', message: messageFor(error), error });
      }
      await client.invalidateQueries({ queryKey: panelSettingsKey(panelId) });
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (issues.length > 0) {
      setShowErrors(true);
      return;
    }
    setShowErrors(false);
    if (changes.length === 0) {
      toast({ tone: 'info', message: t('web.unchanged') });
      return;
    }
    save.mutate();
  };

  const editable = mayEdit && !save.isPending;
  const id = (field: string) => `connection-files-${field}`;
  const custom = draft.mode === 'CUSTOM';
  const updatedAt = settings
    .map((setting) => setting.updatedAt)
    .filter((value): value is string => value !== null)
    .sort()
    .at(-1);
  const preview =
    custom && !draft.useDefault && issues.length === 0
      ? renderConnectionFileCaption(draft.template, previewValues())
      : null;
  const templateError =
    issues.length > 0 && (showErrors || draft.template.length > 0)
      ? issues.map(captionIssueMessage).join(' ')
      : undefined;

  return (
    <Card title={t('web.connection_files_title')} hint={t('web.connection_files_hint')}>
      <form onSubmit={onSubmit} className="stack-sm" noValidate>
        <Field label={t('web.connection_files_mode')} htmlFor={id('mode')}>
          <select
            id={id('mode')}
            className="input"
            value={draft.mode}
            disabled={!editable}
            onChange={(event) => set('mode', event.target.value as ConnectionFileCaptionMode)}
          >
            {CONNECTION_FILE_CAPTION_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {t(MODE_LABELS[mode])}
              </option>
            ))}
          </select>
        </Field>
        {draft.mode === 'PANEL_DEFAULT' && (
          <p className="muted small">{t('web.connection_files_mode_panel_default_note')}</p>
        )}
        {draft.mode === 'NONE' && (
          <p className="muted small">{t('web.connection_files_mode_none_note')}</p>
        )}

        {custom && (
          <>
            <div className="field">
              <label className="row" htmlFor={id('use-default')}>
                <input
                  id={id('use-default')}
                  type="checkbox"
                  checked={draft.useDefault}
                  disabled={!editable}
                  onChange={(event) => set('useDefault', event.target.checked)}
                />
                <span>{t('web.connection_files_use_default')}</span>
              </label>
              {draft.useDefault && (
                <p className="muted small">{t('web.connection_files_use_default_note')}</p>
              )}
            </div>
            {!draft.useDefault && (
              <>
                <Field
                  label={t('web.connection_files_template')}
                  hint={t('web.connection_files_template_hint')}
                  htmlFor={id('template')}
                  {...(templateError === undefined ? {} : { error: templateError })}
                >
                  <textarea
                    id={id('template')}
                    className="input"
                    rows={6}
                    value={draft.template}
                    disabled={!editable}
                    onChange={(event) => set('template', event.target.value)}
                  />
                </Field>
                <p className="faint small" data-testid="connection-files-length">
                  {t('web.connection_files_length')
                    .replace('{count}', formatNumber(draft.template.length))
                    .replace('{max}', formatNumber(TELEGRAM_CAPTION_MAX_LENGTH))}
                </p>
                {(draft.template.length > CAPTION_LENGTH_WARN_AT ||
                  (preview !== null && preview.text.length >= TELEGRAM_CAPTION_MAX_LENGTH)) && (
                  <Banner tone="warn">{t('web.connection_files_length_warning')}</Banner>
                )}
                <div className="field">
                  <span className="small strong">{t('web.connection_files_variables')}</span>
                  <div className="btn-group">
                    {CONNECTION_FILE_CAPTION_VARIABLES.map((variable) => (
                      <button
                        key={variable.token}
                        type="button"
                        className="btn ghost sm"
                        disabled={!editable}
                        onClick={() => set('template', `${draft.template}{${variable.token}}`)}
                      >
                        {placeholderLabel(
                          CAPTION_TEMPLATE_KEY,
                          variable.token,
                          variable.description,
                        )}{' '}
                        <Ltr>{`{${variable.token}}`}</Ltr>
                      </button>
                    ))}
                  </div>
                </div>
                {preview !== null && (
                  <div className="field">
                    <span className="small strong">{t('web.connection_files_preview')}</span>
                    <p className="muted small">{t('web.connection_files_preview_hint')}</p>
                    <div className="bot-preview" dir="auto" data-testid="connection-files-preview">
                      {preview.text.length === 0
                        ? t('web.connection_files_preview_empty')
                        : drawEntities(preview.text, preview.entities, 0, preview.text.length)}
                    </div>
                  </div>
                )}
              </>
            )}
          </>
        )}

        {draft.mode !== 'NONE' && (
          <Field label={t('web.connection_files_placement')} htmlFor={id('placement')}>
            <select
              id={id('placement')}
              className="input"
              value={draft.placement}
              disabled={!editable}
              onChange={(event) =>
                set('placement', event.target.value as ConnectionFileCaptionPlacement)
              }
            >
              {CONNECTION_FILE_CAPTION_PLACEMENTS.map((placement) => (
                <option key={placement} value={placement}>
                  {t(PLACEMENT_LABELS[placement])}
                </option>
              ))}
            </select>
          </Field>
        )}

        {showErrors && issues.length > 0 && (
          <Banner tone="danger">{t('web.connection_files_invalid')}</Banner>
        )}
        {updatedAt !== undefined && (
          <p className="faint small">
            {t('web.connection_files_updated_at')}: {formatTimestamp(updatedAt)}
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
