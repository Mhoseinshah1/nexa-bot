import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  INLINE_BUTTONS,
  SERVICE_CARD_BUTTONS,
  SERVICE_CARD_ROW_MAX,
  serviceCardLayoutSchema,
  type ServiceCardButton,
  type TemplateViewResponse,
} from '@nexa/contracts';
import { fetchSettings, saveSetting } from '../../api/client';
import { t } from '../../i18n/web.fa';
import { useSubmissionKey } from '../../submission-key';
import { Banner, Button, Card, StateSwitch, useToast, useUnsavedChanges } from '../../ui/kit';
import { TemplateCard } from '../content';
import { KeptSheet } from '../editor-layout';
import { LayoutDnd } from '../../ui/layout-dnd';
import { useReportDirty } from '../ops-b-layout';
import { ErrorReport } from '../settings';
import { INLINE_BUTTON_NAME } from './inline-buttons';
import {
  defaultServiceCardRows,
  effectiveServiceCardRows,
  fromDndLayout,
  storedServiceCardRows,
  toDndLayout,
  type ServiceCardRows,
} from './service-card-model';

export const SERVICE_CARD_LAYOUT_SETTING = 'bot.service_card_layout';

/** The templates a slot label comes from: switch-off and switch-on share one slot. */
function labelKeysOf(slot: ServiceCardButton): string[] {
  const keys = [slot, ...(slot === 'service.suspend' ? ['service.resume'] : [])];
  return keys.flatMap((key) => {
    const label = INLINE_BUTTONS.find((entry) => entry.key === key)?.label;
    return label === null || label === undefined ? [] : [label as string];
  });
}

/**
 * R8-C3: «چیدمان صفحهٔ سرویس» — the order, the rows (one to three buttons each) and the
 * show/hide switch of the buttons on a customer's service screen.
 *
 * The same two mechanisms as «دکمه‌های شیشه‌ای»: the arrangement is the
 * `bot.service_card_layout` setting (versioned, audited, `settings.edit`, saved with the
 * version this section read), and each label is the button's own template, edited with the
 * texts screen's card. The layout never makes a button appear: the bot draws only the buttons
 * the service is eligible for, then orders and hides them by this value.
 */
export function ServiceCardLayoutSection({
  mayEdit,
  denied,
  mayViewTemplates,
  mayEditTemplates,
  templates,
  onLabelChanged,
}: {
  mayEdit: boolean;
  denied: boolean;
  mayViewTemplates: boolean;
  mayEditTemplates: boolean;
  templates: readonly TemplateViewResponse[] | undefined;
  onLabelChanged: () => Promise<unknown> | void;
}) {
  const client = useQueryClient();
  const notify = useToast();
  const submission = useSubmissionKey();
  const settings = useQuery({ queryKey: ['settings'], queryFn: fetchSettings, enabled: !denied });
  const setting = settings.data?.settings.find((one) => one.key === SERVICE_CARD_LAYOUT_SETTING);
  const stored = useMemo<ServiceCardRows>(() => {
    const parsed = serviceCardLayoutSchema.safeParse(setting?.value ?? { rows: [] });
    return effectiveServiceCardRows(parsed.success ? parsed.data.rows : []);
  }, [setting?.value]);
  const invalid = setting?.storedValueInvalid === true;

  // The draft carries the version it was edited from, so a save never states a newer one.
  const [draft, setDraft] = useState<{
    readonly rows: ServiceCardRows;
    readonly basisVersion: number | null;
  } | null>(null);
  const [open, setOpen] = useState<ServiceCardButton | null>(null);
  const rows = draft?.rows ?? stored;
  const unsaved =
    draft !== null && (invalid || JSON.stringify(draft.rows) !== JSON.stringify(stored));
  useUnsavedChanges(mayEdit && unsaved);
  useReportDirty('service-card', mayEdit && unsaved);

  const edit = (next: ServiceCardRows) =>
    setDraft((before) => ({
      rows: next,
      basisVersion: before === null ? (setting?.version ?? null) : before.basisVersion,
    }));

  const save = useMutation({
    mutationFn: (command: {
      value: { rows: ServiceCardRows };
      expectedVersion: number | null;
      idempotencyKey: string;
    }) => saveSetting({ key: SERVICE_CARD_LAYOUT_SETTING, ...command }),
    onSuccess: async (result) => {
      submission.settle();
      setDraft(null);
      notify({
        tone: result.changed ? 'ok' : 'info',
        message: t(result.changed ? 'web.scl_saved' : 'web.scl_unchanged'),
      });
      await client.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (error: unknown) => {
      submission.settleOn(error);
      notify({ tone: 'danger', message: t('web.scl_failed'), error });
      void client.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  // Editing waits while a save is in flight: its success clears the draft, which would
  // otherwise discard an edit made after the snapshot.
  const locked = !mayEdit || save.isPending;
  const changedElsewhere =
    draft !== null && setting !== undefined && setting.version !== draft.basisVersion;

  const saveNow = () => {
    const command = {
      value: { rows: storedServiceCardRows(rows) },
      expectedVersion: draft === null ? (setting?.version ?? null) : draft.basisVersion,
    };
    save.mutate({ ...command, idempotencyKey: submission.current(command) });
  };

  const nameOf = (slot: ServiceCardButton) => {
    const label = INLINE_BUTTONS.find((entry) => entry.key === slot)?.label;
    const body =
      label === null || label === undefined
        ? undefined
        : templates?.find((one) => one.key === label)?.body;
    return body !== undefined && body !== '' ? body : t(INLINE_BUTTON_NAME[slot]);
  };
  const templateOf = (key: string) => templates?.find((one) => one.key === key);

  return (
    <Card title={t('web.scl_title')} hint={t('web.scl_hint')} id="service-card-layout">
      <StateSwitch query={settings} denied={denied} isEmpty={false}>
        {invalid && <Banner tone="warn">{t('web.scl_stored_invalid')}</Banner>}
        {!mayEdit && <Banner tone="info">{t('web.scl_denied_edit')}</Banner>}
        {changedElsewhere && (
          <Banner tone="warn">
            {t('web.ib_changed_elsewhere')}{' '}
            <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
              {t('web.ib_reload')}
            </Button>
          </Banner>
        )}
        <div data-testid="service-card-layout" className="scl-dnd">
          <LayoutDnd
            label={t('web.scl_title')}
            layout={toDndLayout(rows)}
            rules={{ maxPerRow: SERVICE_CARD_ROW_MAX }}
            disabled={locked}
            nameOf={(id) => nameOf(id as ServiceCardButton)}
            onChange={(next) => edit(fromDndLayout(next))}
            renderItem={(id) => {
              const button = id as ServiceCardButton;
              const name = nameOf(button);
              return (
                <span className="scl-entry" data-button={button}>
                  <span className="scl-name">{name}</span>
                  {mayViewTemplates && labelKeysOf(button).length > 0 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-haspopup="dialog"
                      aria-label={`${t('web.scl_edit_label')}: ${name}`}
                      onPointerDown={(event) => event.stopPropagation()}
                      onKeyDown={(event) => event.stopPropagation()}
                      onClick={() => setOpen(button)}
                    >
                      {t('web.scl_edit_label')}
                    </Button>
                  )}
                </span>
              );
            }}
          />
          <p className="muted small" data-testid="scl-back-fixed">
            {`${t('web.ib_button_service_back_to_list')} — ${t('web.scl_back_fixed')}`}
          </p>
        </div>
        <div className="row">
          {unsaved && <span className="muted small">{t('web.scl_unsaved')}</span>}
          <span className="spacer" />
          <Button
            variant="ghost"
            size="sm"
            disabled={locked || save.isPending}
            onClick={() => edit(defaultServiceCardRows())}
          >
            {t('web.scl_reset')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={locked || changedElsewhere || !(unsaved || invalid) || setting === undefined}
            onClick={saveNow}
          >
            {t('web.scl_save')}
          </Button>
        </div>
        {save.isError && <ErrorReport error={save.error} />}
      </StateSwitch>
      {mayViewTemplates &&
        SERVICE_CARD_BUTTONS.map((slot) => (
          <KeptSheet
            key={slot}
            open={open === slot}
            onClose={() => setOpen(null)}
            title={nameOf(slot)}
            hint={slot === 'service.suspend' ? t('web.scl_resume_note') : undefined}
            wide
          >
            {labelKeysOf(slot).map((key) => {
              const template = templateOf(key);
              return template === undefined ? null : (
                <TemplateCard
                  key={key}
                  template={template}
                  mayEdit={mayEditTemplates}
                  onChanged={onLabelChanged}
                />
              );
            })}
          </KeptSheet>
        ))}
    </Card>
  );
}
